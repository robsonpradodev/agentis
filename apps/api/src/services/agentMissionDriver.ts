import { and, eq, inArray } from 'drizzle-orm';
import { AppDefinitionStore } from '@agentis/app';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AgentMission, WorkflowGraph, WorkflowRunState } from '@agentis/core';
import { finalOutput } from '../engine/runPublishedWorkflow.js';
import { validateJsonSchema } from '../engine/handlers/utilityHandlers.js';
import type { Logger } from '../logger.js';
import type { AgentMissionService } from './agentMissions.js';
import type {
  DurableEntityService,
  EntityWakeContext,
  EntityWakeResult,
} from './durableEntities.js';

export const MISSION_ENTITY_KIND = 'mission';

/** Executes Agent Missions on the existing durable entity dispatcher. */
export class AgentMissionDriver {
  constructor(
    private readonly entities: DurableEntityService,
    private readonly deps: {
      db: AgentisSqliteDb;
      missions: AgentMissionService;
      logger: Logger;
      wakeAgent: (args: {
        workspaceId: string;
        agentId: string;
        missionId: string;
        message: string;
      }) => Promise<{ reply: string }>;
      notifySettlement?: (mission: AgentMission) => Promise<void>;
    },
  ) {}

  reconcile(): void {
    const active = this.deps.db
      .select()
      .from(schema.agentMissions)
      .where(inArray(schema.agentMissions.status, ['queued', 'running', 'waiting', 'replanning']))
      .all();
    for (const mission of active) {
      const nextWakeAt = mission.nextWakeAt ?? new Date().toISOString();
      const entity = this.entities.getByKey(mission.workspaceId, MISSION_ENTITY_KIND, mission.id);
      if (!entity) {
        this.entities.upsert({
          workspaceId: mission.workspaceId,
          kind: MISSION_ENTITY_KIND,
          key: mission.id,
          appId: mission.appId,
          state: { ownerAgentId: mission.ownerAgentId },
          nextWakeAt,
        });
      } else if (entity.status !== 'active') {
        this.entities.setActive(entity.id, nextWakeAt);
      } else if (entity.nextWakeAt !== nextWakeAt) {
        this.entities.upsert({
          workspaceId: mission.workspaceId,
          kind: MISSION_ENTITY_KIND,
          key: mission.id,
          nextWakeAt,
        });
      }
    }
  }

  handler = async (ctx: EntityWakeContext): Promise<EntityWakeResult> => {
    const missionExists = this.deps.db.select({ id: schema.agentMissions.id })
      .from(schema.agentMissions)
      .where(and(
        eq(schema.agentMissions.workspaceId, ctx.entity.workspaceId),
        eq(schema.agentMissions.id, ctx.entity.key),
      ))
      .get();
    if (!missionExists) {
      this.deps.logger.warn('mission.entity_orphaned', {
        entityId: ctx.entity.id,
        missionId: ctx.entity.key,
      });
      return { done: true, consumeInboxIds: ctx.inbox.map((item) => item.id) };
    }
    const mission = this.deps.missions.inspect(ctx.entity.workspaceId, ctx.entity.key);
    if (isTerminal(mission)) {
      await this.#notifySettlement(mission);
      return { done: true };
    }

    // A provider/approval event may have completed the effect while this entity
    // slept. Reconcile the ledger before spending another model token.
    const reconciled = this.deps.missions.settleIfSatisfied(mission.workspaceId, mission.id);
    if (isTerminal(reconciled)) {
      await this.#notifySettlement(reconciled);
      return { done: true };
    }

    // A workflow is already an execution plan. Its Mission observes that run and
    // its native node receipts; it must never start a second freeform agent turn.
    if (reconciled.sourceKind === 'workflow' && reconciled.sourceRef) {
      const run = this.deps.db
        .select({
          status: schema.workflowRuns.status,
          runState: schema.workflowRuns.runState,
          workflowId: schema.workflowRuns.workflowId,
        })
        .from(schema.workflowRuns)
        .where(
          and(
            eq(schema.workflowRuns.workspaceId, reconciled.workspaceId),
            eq(schema.workflowRuns.id, reconciled.sourceRef),
          ),
        )
        .get();
      if (!run) {
        const failed = this.deps.missions.fail(
          reconciled.workspaceId,
          reconciled.id,
          'WORKFLOW_RUN_MISSING',
          `Linked workflow run ${reconciled.sourceRef} was not found.`,
        );
        await this.#notifySettlement(failed);
        return { done: true };
      }
      if (
        [
          'FAILED',
          'CANCELLED',
          'COMPLETED_WITH_ERRORS',
          'COMPLETED_WITH_CONTRACT_VIOLATION',
        ].includes(run.status)
      ) {
        this.deps.db
          .update(schema.effectPlans)
          .set({
            status: 'failed',
            lastError: `Workflow run settled as ${run.status}`,
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(
              eq(schema.effectPlans.workspaceId, reconciled.workspaceId),
              eq(schema.effectPlans.missionId, reconciled.id),
            ),
          )
          .run();
        const failed = this.deps.missions.fail(
          reconciled.workspaceId,
          reconciled.id,
          'WORKFLOW_NOT_ACCOMPLISHED',
          `Workflow run settled as ${run.status}.`,
        );
        await this.#notifySettlement(failed);
        return { done: true };
      }
      if (run.status === 'COMPLETED') {
        const now = new Date().toISOString();
        const workflow = run.workflowId
          ? this.deps.db
              .select({ graph: schema.workflows.graph })
              .from(schema.workflows)
              .where(
                and(
                  eq(schema.workflows.workspaceId, reconciled.workspaceId),
                  eq(schema.workflows.id, run.workflowId),
                ),
              )
              .get()
          : null;
        const output = workflow
          ? finalOutput(workflow.graph as WorkflowGraph, run.runState as WorkflowRunState)
          : null;
        if (reconciled.appId && reconciled.operationId) {
          const operation = new AppDefinitionStore(this.deps.db)
            .get(reconciled.workspaceId, reconciled.appId)
            ?.contract?.operations.find((item) => item.id === reconciled.operationId);
          const violations = operation ? validateJsonSchema(output, operation.outputSchema) : [];
          if (violations.length) {
            const detail = `Workflow output violates operation contract: ${violations
              .map((item) => `${item.path}: ${item.message}`)
              .join('; ')}`;
            this.deps.db
              .update(schema.effectPlans)
              .set({ status: 'failed', lastError: detail, updatedAt: now })
              .where(
                and(
                  eq(schema.effectPlans.workspaceId, reconciled.workspaceId),
                  eq(schema.effectPlans.missionId, reconciled.id),
                ),
              )
              .run();
            const failed = this.deps.missions.fail(
              reconciled.workspaceId,
              reconciled.id,
              'WORKFLOW_OUTPUT_CONTRACT_VIOLATION',
              detail,
            );
            await this.#notifySettlement(failed);
            return { done: true };
          }
        }
        this.deps.db
          .update(schema.effectPlans)
          .set({
            status: 'completed',
            resultJson: {
              execution: { runId: reconciled.sourceRef, output },
              reconciliation: { runId: reconciled.sourceRef, status: run.status },
            },
            executedAt: now,
            reconciledAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.effectPlans.workspaceId, reconciled.workspaceId),
              eq(schema.effectPlans.missionId, reconciled.id),
            ),
          )
          .run();
        this.deps.missions.attachArtifact(reconciled.workspaceId, reconciled.id, {
          id: `workflow-output:${reconciled.sourceRef}`,
          name: 'Workflow output',
          kind: 'workflow_result',
          mimeType: 'application/json',
          uri: `/v1/runs/${reconciled.sourceRef}`,
          securityLabels: ['internal'],
          createdAt: now,
        });
        if (reconciled.outcomeContract.requiredEffects.length === 0) {
          const completed = this.deps.missions.complete(
            reconciled.workspaceId,
            reconciled.id,
            'Workflow completed successfully',
          );
          await this.#notifySettlement(completed);
          return { done: true };
        }
        const blocked = this.deps.missions.block(reconciled.workspaceId, reconciled.id, {
          code: 'WORKFLOW_RECEIPTS_MISSING',
          detail:
            'The workflow stopped without all receipts required by the mission outcome contract.',
          recoverable: true,
        });
        await this.#notifySettlement(blocked);
        return { done: true };
      }
      const nextWakeAt = new Date(Date.now() + 5_000).toISOString();
      this.deps.missions.progress(
        reconciled.workspaceId,
        reconciled.id,
        'Workflow execution is in progress; waiting for native effect receipts.',
        { nextWakeAt },
      );
      return { nextWakeAt, consumeInboxIds: ctx.inbox.map((item) => item.id) };
    }

    const pending = this.#pendingEffects(reconciled);
    const awaitingApproval = pending.find((effect) => effect.status === 'awaiting_approval');
    if (awaitingApproval) {
      const blocked = this.deps.missions.block(reconciled.workspaceId, reconciled.id, {
        code: 'APPROVAL_REQUIRED',
        detail: `Approval ${awaitingApproval.approvalId ?? 'pending'} is required for the external effect.`,
        recoverable: true,
      });
      await this.#notifySettlement(blocked);
      return { done: true, consumeInboxIds: ctx.inbox.map((item) => item.id) };
    }
    const missingRecipient = pending.find(
      (effect) => effect.status === 'planned' && !effect.peerIdentityId,
    );
    if (missingRecipient) {
      const blocked = this.deps.missions.block(reconciled.workspaceId, reconciled.id, {
        code: 'RECIPIENT_REQUIRED',
        detail: `The recipient is unresolved for action ${missingRecipient.id}.`,
        recoverable: true,
      });
      await this.#notifySettlement(blocked);
      return { done: true, consumeInboxIds: ctx.inbox.map((item) => item.id) };
    }
    const providerWait = pending.find(
      (effect) => effect.status === 'planned' && effect.attempts > 0,
    );
    if (providerWait) {
      const nextWakeAt = providerWait.scheduledFor ?? new Date(Date.now() + 30_000).toISOString();
      this.deps.missions.wait(
        reconciled.workspaceId,
        reconciled.id,
        {
          code: 'PROVIDER_ACK_PENDING',
          detail:
            'Waiting for provider acknowledgement; the existing idempotent effect will be reconciled.',
          recoverable: true,
        },
        nextWakeAt,
      );
      return { nextWakeAt, consumeInboxIds: ctx.inbox.map((item) => item.id) };
    }

    if (reconciled.attemptCount >= reconciled.maxAttempts) {
      const missing = pendingRequirementIds(reconciled);
      const blocked = this.deps.missions.block(reconciled.workspaceId, reconciled.id, {
        code: 'EXECUTION_BUDGET_EXHAUSTED',
        detail: `The configured mission model-turn budget (${reconciled.maxAttempts}) was exhausted. Still missing verified commitments: ${missing.join(', ') || 'unknown'}.`,
        recoverable: true,
      });
      await this.#notifySettlement(blocked);
      return { done: true, consumeInboxIds: ctx.inbox.map((item) => item.id) };
    }

    const running = this.deps.missions.start(reconciled.workspaceId, reconciled.id);
    const prompt = missionPrompt(
      running,
      pending,
      ctx.inbox.map((item) => ({ type: item.eventType, payload: item.payloadJson })),
    );
    let reply = '';
    try {
      ({ reply } = await this.deps.wakeAgent({
        workspaceId: running.workspaceId,
        agentId: running.ownerAgentId,
        missionId: running.id,
        message: prompt,
      }));
    } catch (error) {
      reply = error instanceof Error ? error.message : String(error);
      this.deps.logger.warn('mission.runtime_turn_failed', { missionId: running.id, error: reply });
    }

    const after = this.deps.missions.settleIfSatisfied(running.workspaceId, running.id);
    if (isTerminal(after)) {
      await this.#notifySettlement(after);
      return { done: true, consumeInboxIds: ctx.inbox.map((item) => item.id) };
    }

    if (after.attemptCount < after.maxAttempts) {
      const nextWakeAt = new Date(Date.now() + 1_000).toISOString();
      this.deps.missions.replan(
        after.workspaceId,
        after.id,
        `The runtime turn ended without the required receipts. Its nonterminal output was: ${clip(reply)}`,
      );
      this.deps.missions.progress(
        after.workspaceId,
        after.id,
        'The previous runtime turn left commitments open; continuing from the next pending step with its concrete observations.',
        { nextWakeAt },
      );
      return { nextWakeAt, consumeInboxIds: ctx.inbox.map((item) => item.id) };
    }

    const missing = pendingRequirementIds(after);
    const blocked = this.deps.missions.block(after.workspaceId, after.id, {
      code: 'EXECUTION_BUDGET_EXHAUSTED',
      detail: `The configured mission model-turn budget (${after.maxAttempts}) ended with pending commitments: ${missing.join(', ') || 'unknown'}. Last runtime output: ${clip(reply)}`,
      recoverable: true,
    });
    await this.#notifySettlement(blocked);
    return { done: true, consumeInboxIds: ctx.inbox.map((item) => item.id) };
  };

  async #notifySettlement(mission: AgentMission): Promise<void> {
    if (!this.deps.notifySettlement || !isTerminal(mission)) return;
    try {
      await this.deps.notifySettlement(mission);
    } catch (error) {
      this.deps.logger.warn('mission.settlement_notification_failed', {
        missionId: mission.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #pendingEffects(mission: AgentMission) {
    return this.deps.db
      .select()
      .from(schema.channelActionIntents)
      .where(
        and(
          eq(schema.channelActionIntents.workspaceId, mission.workspaceId),
          eq(schema.channelActionIntents.missionId, mission.id),
        ),
      )
      .all()
      .filter((effect) => !['delivered', 'cancelled', 'superseded'].includes(effect.status));
  }
}

function missionPrompt(
  mission: AgentMission,
  pending: Array<{ id: string; status: string; lastError: string | null }>,
  events: unknown[],
): string {
  return [
    '[DURABLE AGENT MISSION]',
    `Mission id: ${mission.id}`,
    `Objective: ${mission.objective}`,
    `Required verified effects: ${mission.outcomeContract.requiredEffects.map((item) => `${item.kind} x${item.minimum ?? 1}`).join(', ') || 'none declared'}`,
    `Model-turn budget used: ${mission.attemptCount}/${mission.maxAttempts}`,
    pending.length
      ? `Existing effects to inspect/reconcile before retrying: ${JSON.stringify(pending)}`
      : '',
    events.length ? `Wake events: ${JSON.stringify(events)}` : '',
    'Continue acting now through native Agentis tools. Do not inspect source files, environment variables, or host secrets.',
    'Connection-owning agents can use their own configured connection. A verified owner command carries action-scoped authority.',
    'For a send-and-update outcome, call the durable channel action once with postAckMutations so the exact record moves only after provider acknowledgement.',
    'Progress prose (for example “I will check” or “message ready”) is nonterminal. Do not ask how to proceed while Agentis can inspect, execute, reconcile, or wait.',
    'The mission settles from receipts, not from your final prose.',
  ]
    .filter(Boolean)
    .join('\n');
}
function isTerminal(mission: AgentMission): boolean {
  return ['accomplished', 'blocked', 'failed', 'cancelled', 'rejected'].includes(mission.status);
}
function clip(value: string): string {
  const clean = value.trim() || '(empty output)';
  return clean.length > 600 ? `${clean.slice(0, 600)}…` : clean;
}

export function missionSettlementMessage(mission: AgentMission): string {
  const portuguese =
    /\b(envie|enviar|mensagem|contato|n[uú]mero|mova|atualize|diga|tente|novamente)\b/iu.test(
      mission.objective,
    );
  const receipt = (mission.receipts ?? []).find(
    (item) => item.kind === 'channel_delivery' && item.acknowledged,
  );
  const provider = receipt?.providerMessageId
    ? ` ${portuguese ? 'Confirmação do provedor' : 'Provider receipt'}: ${receipt.providerMessageId}.`
    : '';
  if (mission.status === 'accomplished') {
    return portuguese
      ? `Concluído e verificado: ${mission.objective}${provider}`
      : `Completed and verified: ${mission.objective}${provider}`;
  }
  if (mission.status === 'blocked') {
    const detail = friendlyBlocker(mission, portuguese);
    return portuguese
      ? `Não consegui concluir a ação: ${detail} A tarefa continua salva; diga “continuar” para eu tentar novamente do mesmo ponto.`
      : `I could not complete the action: ${detail} The task is still saved; say “continue” and I will retry from the same point.`;
  }
  if (mission.status === 'failed') {
    const detail =
      mission.blocker?.detail ?? (portuguese ? 'falha de execução' : 'execution failure');
    return portuguese
      ? `A missão falhou sem produzir o resultado solicitado: ${detail}`
      : `The mission failed without producing the requested outcome: ${detail}`;
  }
  return portuguese
    ? `A missão foi cancelada: ${mission.objective}`
    : `Mission cancelled: ${mission.objective}`;
}

function friendlyBlocker(mission: AgentMission, portuguese: boolean): string {
  switch (mission.blocker?.code) {
    case 'NO_VERIFIED_EFFECT_PATH':
      return portuguese
        ? 'as tentativas automáticas terminaram sem nenhuma confirmação verificável de envio ou alteração'
        : 'the automatic attempts ended without a verified send or mutation';
    case 'MODEL_DID_NOT_EXECUTE_PLAN':
    case 'MODEL_EXECUTION_STALLED':
      return portuguese
        ? 'o runtime repetiu respostas sem executar a próxima ferramenta disponível; os efeitos já confirmados foram preservados'
        : 'the runtime repeatedly stopped without executing the next available tool; already verified effects were preserved';
    case 'EXECUTION_BUDGET_EXHAUSTED':
      return portuguese
        ? `o orçamento de execução configurado terminou e ainda faltam confirmações verificáveis (${mission.blocker?.detail ?? 'detalhes indisponíveis'})`
        : `the configured execution budget ended while verified commitments were still missing (${mission.blocker?.detail ?? 'details unavailable'})`;
    case 'RECIPIENT_REQUIRED':
      return portuguese
        ? 'ainda falta identificar com segurança o destinatário'
        : 'the recipient still needs to be resolved safely';
    case 'APPROVAL_REQUIRED':
      return portuguese
        ? 'há uma aprovação visível pendente no Agentis'
        : 'a visible approval is pending in Agentis';
    case 'PROVIDER_ACK_PENDING':
      return portuguese
        ? 'o provedor ainda não confirmou o envio'
        : 'the provider has not acknowledged delivery yet';
    case 'WORKFLOW_RECEIPTS_MISSING':
      return portuguese
        ? 'o fluxo terminou sem comprovar os efeitos solicitados'
        : 'the workflow ended without proving the requested effects';
    default:
      return (
        mission.blocker?.detail ??
        (portuguese
          ? 'existe uma dependência externa não resolvida'
          : 'an external dependency is unresolved')
      );
  }
}

function pendingRequirementIds(mission: AgentMission): string[] {
  const receipts = mission.receipts ?? [];
  return mission.outcomeContract.requiredEffects
    .filter((requirement) => {
      const count = receipts.filter(
        (receipt) =>
          receipt.kind === requirement.kind &&
          (!receipt.requirementId || receipt.requirementId === requirement.id) &&
          (requirement.kind !== 'channel_delivery' || receipt.acknowledged),
      ).length;
      return count < (requirement.minimum ?? 1);
    })
    .map((requirement) => requirement.id ?? requirement.kind);
}
