import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  AgentisError,
  authorityContextSchema,
  type AppOperation,
  type AuthorityContext,
  type ContentEnvelope,
  type EffectLevel,
  type WorkflowGraph,
} from '@agentis/core';
import { AppDefinitionStore } from '@agentis/app';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import { runPublishedWorkflow, startPublishedWorkflow } from '../engine/runPublishedWorkflow.js';
import { validateJsonSchema } from '../engine/handlers/utilityHandlers.js';
import type { AgentMissionService } from './agentMissions.js';
import { AppEffectService } from './appEffects.js';
import type { ExtensionRuntime } from './extensionRuntime.js';

export interface InvokeAppOperationInput {
  workspaceId: string;
  ambientId: string | null;
  userId: string;
  appId: string;
  operationId: string;
  input: Record<string, unknown>;
  authorityContext?: AuthorityContext;
  idempotencyKey?: string;
}

/** The one invocation path used by REST today and projected to MCP/A2A. */
export class AppOperationRuntime {
  private readonly definitions: AppDefinitionStore;
  private readonly effects: AppEffectService;

  constructor(
    private readonly deps: {
      db: AgentisSqliteDb;
      engine: WorkflowEngine;
      missions: AgentMissionService;
      extensions?: ExtensionRuntime;
    },
  ) {
    this.definitions = new AppDefinitionStore(deps.db);
    this.effects = new AppEffectService(deps.db, deps.missions);
  }

  list(workspaceId: string, appId: string): AppOperation[] {
    return this.definitions.get(workspaceId, appId)?.contract?.operations ?? [];
  }

  get(workspaceId: string, appId: string, operationId: string): AppOperation {
    const operation = this.list(workspaceId, appId).find(
      (candidate) => candidate.id === operationId,
    );
    if (!operation)
      throw new AgentisError(
        'RESOURCE_NOT_FOUND',
        `operation '${operationId}' is not declared by this App`,
      );
    return operation;
  }

  async invoke(args: InvokeAppOperationInput): Promise<unknown> {
    const operation = this.get(args.workspaceId, args.appId, args.operationId);
    const violations = validateJsonSchema(args.input, operation.inputSchema);
    if (violations.length)
      throw new AgentisError(
        'VALIDATION_FAILED',
        violations.map((item) => `${item.path}: ${item.message}`).join('; '),
      );
    const app = this.#app(args.workspaceId, args.appId);
    const definition = this.definitions.require(args.workspaceId, args.appId);
    const authority = authorityContextSchema.parse(
      args.authorityContext ?? {
        workspaceId: args.workspaceId,
        ownerPrincipalId: args.userId,
        initiatorPrincipalId: args.userId,
        actorPrincipalId: args.userId,
        delegationChain: [],
        scopes: operation.scopes,
        appId: args.appId,
        maxEffectLevel: definition.permissionsV3?.maxEffectLevel ?? 'read',
        maxSpendCents: definition.permissionsV3?.maxSpendCentsPerTask ?? null,
      },
    );
    this.#assertScopes(operation, authority);
    const maxExternalEffects = definition.quality?.budgets.maxExternalEffects;
    if (
      maxExternalEffects != null &&
      operation.effects.filter((item) => item.level !== 'read').length > maxExternalEffects
    ) {
      throw new AgentisError(
        'AUTH_FORBIDDEN',
        `Operation declares more external effects than the App budget allows (${maxExternalEffects}).`,
      );
    }
    const policyContext = { operation, input: args.input, authority };
    const approvalFromGuardrail = enforceGuardrails(
      definition.permissionsV3?.guardrails ?? [],
      'prepare',
      policyContext,
    );
    const idempotencyKey =
      args.idempotencyKey?.trim() || `operation:${args.appId}:${operation.id}:${randomUUID()}`;
    const effectDeclarations = operation.effects.filter((effect) => effect.level !== 'read');
    const ownerAgentId = this.#resolveOwnerAgent(
      args.workspaceId,
      args.appId,
      operation,
      app.ownerAgentId,
    );
    const needsTask =
      operation.mode === 'task' ||
      effectDeclarations.length > 0 ||
      operation.handler.kind === 'mission';
    const mission = needsTask
      ? this.deps.missions.create({
          workspaceId: args.workspaceId,
          ownerAgentId,
          appId: args.appId,
          operationId: operation.id,
          sourceKind: 'api',
          correlationKey: idempotencyKey,
          objective:
            operation.handler.kind === 'mission'
              ? renderTemplate(operation.handler.objectiveTemplate, args.input)
              : operation.title,
          authorityContext: authority,
          costBudgetCents:
            definition.quality?.budgets.maxCostCents ??
            definition.permissionsV3?.maxSpendCentsPerTask ??
            null,
          latencyBudgetMs:
            definition.quality?.budgets.maxDurationMs ?? operation.economics?.maxLatencyMs ?? null,
        })
      : null;

    if (operation.handler.kind === 'mission') return { kind: 'task', task: mission };
    const effect = effectDeclarations.length
      ? this.effects.prepare({
          workspaceId: args.workspaceId,
          missionId: mission?.id ?? null,
          appId: args.appId,
          operationId: operation.id,
          input: args.input,
          targets: effectDeclarations.map((declaration) => ({
            resourceType: declaration.targetResourceType ?? declaration.kind,
          })),
          consequences: effectDeclarations.map(
            (declaration) => `${declaration.kind} (${declaration.level})`,
          ),
          reversibility: maxEffectLevel(effectDeclarations.map((item) => item.level)),
          compensationOperationId:
            effectDeclarations.find((item) => item.compensationOperationId)
              ?.compensationOperationId ?? null,
          estimatedCostCents: operation.economics?.estimatedCostCents ?? null,
          estimatedLatencyMs: operation.economics?.targetLatencyMs ?? null,
          idempotencyKey,
          authorityContext: authority,
          approval:
            approvalFromGuardrail || effectDeclarations.some((item) => item.approval === 'always')
              ? 'always'
              : effectDeclarations.some((item) => item.approval === 'policy')
                ? 'policy'
                : 'never',
        })
      : null;

    if (effect?.status === 'awaiting_authorization')
      return {
        kind: 'task',
        task: this.deps.missions.inspect(args.workspaceId, mission!.id),
        effectPlan: effect,
      };
    if (effect?.status === 'authorized' && effect.authorizationGrantId) {
      enforceGuardrails(
        definition.permissionsV3?.guardrails ?? [],
        'authorize',
        { ...policyContext, effect },
        true,
      );
    }
    if (effect?.status === 'completed') {
      return {
        kind: 'result',
        data: effect.result,
        content: contentEnvelope(effect.result, 'agentis'),
        receipt: {
          appId: args.appId,
          operationId: operation.id,
          runId: null,
          taskId: mission?.id ?? effect.missionId,
          effectPlanId: effect.id,
          effectStatus: effect.status,
          completedAt: effect.reconciledAt ?? effect.updatedAt,
          replayed: true,
        },
      };
    }
    if (effect && ['executing', 'reconciling'].includes(effect.status)) {
      return {
        kind: 'task',
        task: mission ? this.deps.missions.inspect(args.workspaceId, mission.id) : null,
        effectPlan: effect,
      };
    }
    if (effect && ['failed', 'compensated'].includes(effect.status)) {
      throw new AgentisError(
        'RESOURCE_CONFLICT',
        `Effect plan is already ${effect.status}; use a new idempotency key to retry.`,
      );
    }
    enforceGuardrails(
      definition.permissionsV3?.guardrails ?? [],
      'execute',
      { ...policyContext, effect },
      true,
    );
    if (effect) this.effects.beginExecution(args.workspaceId, effect.id);

    if (operation.handler.kind === 'component') {
      try {
        if (!this.deps.extensions)
          throw new AgentisError(
            'EXTENSION_RUNTIME_UNAVAILABLE',
            'The App component runtime is unavailable.',
          );
        const handler = operation.handler;
        const component = definition.components?.components.find(
          (candidate) => candidate.id === handler.component,
        );
        if (!component)
          throw new AgentisError(
            'VALIDATION_FAILED',
            `Component '${operation.handler.component}' is not declared by this App.`,
          );
        if (!component.exports.includes(handler.export)) {
          throw new AgentisError(
            'VALIDATION_FAILED',
            `Component '${component.id}' does not export '${handler.export}'.`,
          );
        }
        const outcome = await this.deps.extensions.execute({
          workspaceId: args.workspaceId,
          extensionSlug: component.entry,
          operationName: handler.export,
          runId: mission?.id,
          taskId: mission?.id,
          input: args.input,
          scratchpadSnapshot: {},
        });
        if (!outcome.ok)
          throw new AgentisError('EXTENSION_INTERNAL', `${outcome.errorCode}: ${outcome.message}`);
        const outputViolations = validateJsonSchema(outcome.output, operation.outputSchema);
        if (outputViolations.length) {
          throw new AgentisError(
            'VALIDATION_FAILED',
            `Component output violates the operation contract: ${outputViolations.map((item) => `${item.path}: ${item.message}`).join('; ')}`,
          );
        }
        let completedEffect = effect;
        if (effect) {
          this.effects.executed(args.workspaceId, effect.id, {
            component: component.id,
            output: outcome.output,
          });
          enforceGuardrails(
            definition.permissionsV3?.guardrails ?? [],
            'reconcile',
            { ...policyContext, effect, output: outcome.output },
            true,
          );
          completedEffect = this.effects.reconcile(args.workspaceId, effect.id, {
            durationMs: outcome.durationMs,
          });
        }
        if (mission) {
          this.deps.missions.attachArtifact(args.workspaceId, mission.id, {
            id: `component-output:${mission.id}`,
            name: `${operation.id} output`,
            kind: 'operation_result',
            mimeType: 'application/json',
            uri: completedEffect ? `effect://${completedEffect.id}/result` : null,
            securityLabels: [],
            createdAt: new Date().toISOString(),
          });
          this.deps.missions.complete(
            args.workspaceId,
            mission.id,
            'Component operation completed and reconciled',
          );
        }
        const receipt = {
          appId: args.appId,
          operationId: operation.id,
          componentId: component.id,
          taskId: mission?.id ?? null,
          effectPlanId: completedEffect?.id ?? null,
          effectStatus: completedEffect?.status ?? null,
          durationMs: outcome.durationMs,
          completedAt: new Date().toISOString(),
        };
        return operation.mode === 'task'
          ? {
              kind: 'task',
              task: this.deps.missions.inspect(args.workspaceId, mission!.id),
              data: outcome.output,
              content: contentEnvelope(outcome.output, 'generated'),
              receipt,
            }
          : {
              kind: 'result',
              data: outcome.output,
              content: contentEnvelope(outcome.output, 'generated'),
              receipt,
            };
      } catch (error) {
        if (
          effect &&
          !['failed', 'completed'].includes(this.effects.get(args.workspaceId, effect.id).status)
        )
          this.effects.fail(args.workspaceId, effect.id, error);
        if (mission)
          this.deps.missions.fail(
            args.workspaceId,
            mission.id,
            'COMPONENT_EXECUTION_FAILED',
            error instanceof Error ? error.message : String(error),
          );
        throw error;
      }
    }

    const workflow = this.#workflow(args.workspaceId, args.appId, operation.handler.workflow);
    if (operation.mode === 'task') {
      try {
        const started = await startPublishedWorkflow({
          db: this.deps.db,
          engine: this.deps.engine,
          workspaceId: args.workspaceId,
          ambientId: args.ambientId,
          userId: args.userId,
          workflowId: workflow.id,
          graph: workflow.graph as WorkflowGraph,
          inputs: args.input,
          missionId: mission!.id,
        });
        this.deps.missions.linkWorkflowRun(args.workspaceId, mission!.id, started.runId);
        this.deps.missions.progress(args.workspaceId, mission!.id, 'Workflow execution started', {
          nextWakeAt: new Date(Date.now() + 1_000).toISOString(),
        });
        return {
          kind: 'task',
          task: this.deps.missions.inspect(args.workspaceId, mission!.id),
          effectPlan: effect,
          runId: started.runId,
        };
      } catch (error) {
        if (effect) this.effects.fail(args.workspaceId, effect.id, error);
        this.deps.missions.fail(
          args.workspaceId,
          mission!.id,
          'WORKFLOW_START_FAILED',
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    }

    try {
      const result = await runPublishedWorkflow({
        db: this.deps.db,
        engine: this.deps.engine,
        workspaceId: args.workspaceId,
        ambientId: args.ambientId,
        userId: args.userId,
        workflowId: workflow.id,
        graph: workflow.graph as WorkflowGraph,
        inputs: args.input,
        missionId: mission?.id ?? null,
        // Synchronous App operations return their result/error to the invoking
        // surface, which owns the user-facing feedback. Workspace run toasts
        // would duplicate that feedback (and polling queries would create a
        // permanent notification storm). Task-mode operations remain visible.
        quietWorkspaceEvents: true,
      });
      if (!result.terminal || result.executionStatus !== 'completed') {
        if (effect)
          this.effects.fail(args.workspaceId, effect.id, `Workflow settled as ${result.status}`);
        if (mission)
          this.deps.missions.fail(
            args.workspaceId,
            mission.id,
            'WORKFLOW_NOT_ACCOMPLISHED',
            `Workflow settled as ${result.status}`,
          );
        throw new AgentisError('INTERNAL_ERROR', `Operation workflow settled as ${result.status}`);
      }
      const outputViolations = validateJsonSchema(result.output, operation.outputSchema);
      if (outputViolations.length) {
        throw new AgentisError(
          'VALIDATION_FAILED',
          `Workflow output violates the operation contract: ${outputViolations.map((item) => `${item.path}: ${item.message}`).join('; ')}`,
        );
      }
      let completedEffect = effect;
      if (effect) {
        this.effects.executed(args.workspaceId, effect.id, {
          runId: result.runId,
          output: result.output,
        });
        enforceGuardrails(
          definition.permissionsV3?.guardrails ?? [],
          'reconcile',
          { ...policyContext, effect, output: result.output },
          true,
        );
        completedEffect = this.effects.reconcile(args.workspaceId, effect.id, {
          runId: result.runId,
          status: result.status,
        });
      }
      if (mission)
        this.deps.missions.complete(
          args.workspaceId,
          mission.id,
          'Operation completed and reconciled',
        );
      return {
        kind: 'result',
        data: result.output,
        content: contentEnvelope(result.output, 'agentis'),
        receipt: {
          appId: args.appId,
          operationId: operation.id,
          runId: result.runId,
          taskId: mission?.id ?? null,
          effectPlanId: completedEffect?.id ?? null,
          effectStatus: completedEffect?.status ?? null,
          completedAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      if (
        effect &&
        !['failed', 'completed'].includes(this.effects.get(args.workspaceId, effect.id).status)
      )
        this.effects.fail(args.workspaceId, effect.id, error);
      if (mission) {
        const current = this.deps.missions.inspect(args.workspaceId, mission.id);
        if (!['accomplished', 'failed', 'cancelled', 'rejected'].includes(current.status)) {
          this.deps.missions.fail(
            args.workspaceId,
            mission.id,
            'WORKFLOW_EXECUTION_FAILED',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      throw error;
    }
  }

  #app(workspaceId: string, appId: string) {
    const app = this.deps.db
      .select()
      .from(schema.apps)
      .where(and(eq(schema.apps.workspaceId, workspaceId), eq(schema.apps.id, appId)))
      .get();
    if (!app) throw new AgentisError('RESOURCE_NOT_FOUND', `app ${appId} not found`);
    return app;
  }

  #workflow(workspaceId: string, appId: string, ref: string) {
    const rows = this.deps.db
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.appId, appId)))
      .all();
    const workflow = rows.find(
      (row) => row.id === ref || row.title === ref || readSlug(row.settings) === ref,
    );
    if (!workflow)
      throw new AgentisError('RESOURCE_NOT_FOUND', `workflow '${ref}' is not part of this App`);
    return workflow;
  }

  #resolveOwnerAgent(
    workspaceId: string,
    appId: string,
    operation: AppOperation,
    fallback: string | null,
  ): string {
    if (operation.handler.kind === 'mission') {
      const ownerRef = operation.handler.ownerAgent;
      const rows = this.deps.db
        .select({ id: schema.agents.id, name: schema.agents.name })
        .from(schema.agents)
        .innerJoin(schema.appMembers, eq(schema.appMembers.agentId, schema.agents.id))
        .where(eq(schema.appMembers.appId, appId))
        .all();
      const agent = rows.find(
        (candidate) => candidate.id === ownerRef || candidate.name === ownerRef,
      );
      if (agent) return agent.id;
    }
    if (fallback) return fallback;
    const member = this.deps.db
      .select({ agentId: schema.appMembers.agentId })
      .from(schema.appMembers)
      .where(eq(schema.appMembers.appId, appId))
      .get();
    if (!member)
      throw new AgentisError(
        'VALIDATION_FAILED',
        'Durable App operations require an owner or member agent.',
      );
    const exists = this.deps.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.id, member.agentId)))
      .get();
    if (!exists) throw new AgentisError('RESOURCE_NOT_FOUND', 'App owner agent not found.');
    return member.agentId;
  }

  #assertScopes(operation: AppOperation, authority: AuthorityContext): void {
    const available = new Set(authority.scopes);
    const missing = operation.scopes.filter((scope) => !available.has(scope));
    if (missing.length)
      throw new AgentisError('AUTH_FORBIDDEN', `Missing operation scopes: ${missing.join(', ')}`);
  }
}

function maxEffectLevel(levels: EffectLevel[]): 'reversible' | 'compensatable' | 'irreversible' {
  const rank: EffectLevel[] = ['read', 'reversible', 'compensatable', 'irreversible'];
  const level = levels.reduce(
    (max, current) => (rank.indexOf(current) > rank.indexOf(max) ? current : max),
    'reversible' as EffectLevel,
  );
  return level === 'read' ? 'reversible' : level;
}

function renderTemplate(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_whole, path: string) => {
    const value = path
      .split('.')
      .reduce<unknown>(
        (current, key) =>
          current && typeof current === 'object'
            ? (current as Record<string, unknown>)[key]
            : undefined,
        input,
      );
    return value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  });
}

function readSlug(settings: unknown): string | null {
  if (!settings || typeof settings !== 'object') return null;
  const mcp = (settings as Record<string, unknown>).mcp;
  return mcp && typeof mcp === 'object' && typeof (mcp as Record<string, unknown>).slug === 'string'
    ? ((mcp as Record<string, unknown>).slug as string)
    : null;
}

function contentEnvelope(value: unknown, origin: 'agentis' | 'generated'): ContentEnvelope {
  return {
    data: value,
    provenance: {
      origin,
      observedAt: new Date().toISOString(),
    },
    trust: origin === 'generated' ? 'unknown' : 'trusted',
    instructionAuthority: 'none',
    securityLabels: [],
  };
}

type Guardrail = {
  id: string;
  phase: 'prepare' | 'authorize' | 'execute' | 'reconcile';
  expression: string;
  onViolation: 'deny' | 'approval' | 'escalate' | 'throttle';
};

/**
 * Evaluate the deliberately small, deterministic guardrail language. An
 * expression is an assertion (`input.amount <= 1000`, `operation.id !=
 * "dangerous"`). No JavaScript is evaluated and unknown paths fail closed.
 * Returns true when a prepare-phase rule requires human approval.
 */
function enforceGuardrails(
  guardrails: Guardrail[],
  phase: Guardrail['phase'],
  context: Record<string, unknown>,
  approvalAlreadyGranted = false,
): boolean {
  let approvalRequired = false;
  for (const guardrail of guardrails.filter((candidate) => candidate.phase === phase)) {
    if (evaluateAssertion(guardrail.expression, context)) continue;
    if (guardrail.onViolation === 'approval' && (phase === 'prepare' || approvalAlreadyGranted)) {
      approvalRequired = phase === 'prepare';
      continue;
    }
    const message = `Guardrail '${guardrail.id}' blocked ${phase}: ${guardrail.expression}`;
    if (guardrail.onViolation === 'throttle') throw new AgentisError('RESOURCE_CONFLICT', message);
    throw new AgentisError('AUTH_FORBIDDEN', message);
  }
  return approvalRequired;
}

function evaluateAssertion(expression: string, context: Record<string, unknown>): boolean {
  const source = expression.trim();
  if (source === 'true') return true;
  if (source === 'false') return false;
  const match = /^([a-zA-Z][\w.]*)\s*(==|!=|<=|>=|<|>)\s*(.+)$/.exec(source);
  if (!match)
    throw new AgentisError(
      'VALIDATION_FAILED',
      `Unsupported guardrail expression '${expression}'. Use: path == value, !=, <, <=, >, or >=.`,
    );
  const left = readPath(context, match[1]!);
  if (left === undefined) return false;
  const right = parsePolicyLiteral(match[3]!);
  const [a, b] = comparable(left, right);
  switch (match[2]) {
    case '==':
      return a === b;
    case '!=':
      return a !== b;
    case '<':
      return a !== null && b !== null && a < b;
    case '<=':
      return a !== null && b !== null && a <= b;
    case '>':
      return a !== null && b !== null && a > b;
    case '>=':
      return a !== null && b !== null && a >= b;
    default:
      return false;
  }
}

function readPath(root: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (value, key) =>
        value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined,
      root,
    );
}

function parsePolicyLiteral(value: string): unknown {
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function comparable(
  left: unknown,
  right: unknown,
): [string | number | boolean | null, string | number | boolean | null] {
  const ranks: Record<string, number> = {
    read: 0,
    reversible: 1,
    compensatable: 2,
    irreversible: 3,
  };
  if (typeof left === 'string' && typeof right === 'string' && left in ranks && right in ranks)
    return [ranks[left]!, ranks[right]!];
  const scalar = (value: unknown): string | number | boolean | null =>
    value == null || ['string', 'number', 'boolean'].includes(typeof value)
      ? (value as string | number | boolean | null)
      : JSON.stringify(value);
  return [scalar(left), scalar(right)];
}
