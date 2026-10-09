import type {
  AgentAdapter,
  AgentDecision,
  AgentMission,
  ChatTurnContext,
  EffectKind,
  ExecutionPlan,
  MissionEffectRequirement,
  MissionOutcomeContract,
  ToolDefinition,
} from '@agentis/core';
import type { Logger } from '../logger.js';
import { AdapterStructuredCompleter } from './structuredCompleter.js';
import type { AgentMissionService } from './agentMissions.js';

interface ModelDecision extends Record<string, unknown> {
  decision?: unknown;
  objective?: unknown;
  reply?: unknown;
  resumeMissionId?: unknown;
  steps?: unknown;
}

interface ModelPlanStep {
  id?: unknown;
  kind?: unknown;
  title?: unknown;
  dependsOn?: unknown;
  toolName?: unknown;
  targetRef?: unknown;
  effectKind?: unknown;
  evidence?: unknown;
}

export interface PreparedAgentExecution {
  decision: AgentDecision;
  mission: AgentMission | null;
  runtimeDirective: string | null;
}

/**
 * Model-driven control plane for substantive Agent requests.
 *
 * The model owns language understanding and decomposition. This service only
 * validates that declared effects map to real offered tools, gives every
 * commitment a durable identity, and binds the plan to a Mission. It contains
 * no command/phrase detection.
 */
export class AgentExecutionController {
  constructor(private readonly deps: { missions: AgentMissionService; logger?: Logger }) {}

  async prepare(args: {
    adapter: AgentAdapter;
    request: string;
    context: ChatTurnContext;
    tools: ToolDefinition[];
    existingMissionId?: string | null;
    signal?: AbortSignal;
  }): Promise<PreparedAgentExecution | null> {
    const forcedMission = args.existingMissionId
      ? this.deps.missions.inspect(args.context.workspaceId, args.existingMissionId)
      : null;
    if (forcedMission && forcedMission.outcomeContract.requiredEffects.length > 0) {
      const mission = forcedMission;
      return {
        decision: { decision: 'act', objective: mission.objective, resumeMissionId: mission.id,
          executionPlan: mission.executionPlan, outcomeContract: mission.outcomeContract },
        mission,
        runtimeDirective: this.runtimeDirective(mission),
      };
    }
    if (!args.adapter.chat || args.tools.length === 0) return null;

    const related = this.deps.missions.list(args.context.workspaceId, {
      ownerAgentId: args.context.agentId,
      sourceRef: args.context.conversationId,
      status: ['queued', 'running', 'waiting', 'replanning', 'blocked', 'failed'],
      limit: 6,
    });
    const incomplete = forcedMission
      ? [forcedMission, ...related.filter((mission) => mission.id !== forcedMission.id)]
      : related;
    const completer = new AdapterStructuredCompleter(args.adapter, 'agent execution planner');
    const toolManifest = args.tools.map((tool) => ({ name: tool.name, description: tool.description }));
    const planned = await completer.completeStructured<ModelDecision>({
      system: executionPlannerSystemPrompt(),
      user: JSON.stringify({
        request: args.request,
        availableTools: toolManifest,
        incompleteExecutions: incomplete.map((mission) => ({
          id: mission.id,
          objective: mission.objective,
          status: mission.status,
          blocker: mission.blocker,
          pendingRequirements: pendingRequirements(mission).map((requirement) => ({
            id: requirement.id, kind: requirement.kind, targetRef: requirement.targetRef,
          })),
        })),
      }),
      maxAttempts: 2,
      maxTokens: 1_600,
      timeoutMs: 60_000,
      signal: args.signal,
    });
    if (!planned) {
      this.deps.logger?.warn('agent.execution.plan_failed', {
        workspaceId: args.context.workspaceId,
        agentId: args.context.agentId,
        error: completer.lastError,
      });
      return null;
    }

    const decision = normalizeDecision(planned, args.tools, incomplete);
    if (!decision) {
      this.deps.logger?.warn('agent.execution.plan_invalid', {
        workspaceId: args.context.workspaceId,
        agentId: args.context.agentId,
      });
      return null;
    }
    if (decision.decision !== 'act') {
      const correlated = decision.resumeMissionId
        ? incomplete.find((mission) => mission.id === decision.resumeMissionId) ?? null
        : null;
      if (decision.decision === 'complete') {
        if (!correlated || pendingRequirements(correlated).length > 0) return null;
        const mission = this.deps.missions.settleIfSatisfied(args.context.workspaceId, correlated.id);
        return { decision, mission, runtimeDirective: null };
      }
      if (decision.decision === 'wait' && correlated) {
        const mission = this.deps.missions.wait(args.context.workspaceId, correlated.id, {
          code: 'EXTERNAL_RESULT_PENDING',
          detail: decision.reply ?? 'An external result is pending.',
          recoverable: true,
        }, correlated.nextWakeAt ?? new Date(Date.now() + 30_000).toISOString());
        return { decision, mission, runtimeDirective: null };
      }
      return { decision, mission: null, runtimeDirective: null };
    }

    const resumed = forcedMission ?? (decision.resumeMissionId
      ? incomplete.find((mission) => mission.id === decision.resumeMissionId)
      : null);
    const mission = resumed
      ? this.deps.missions.resume(args.context.workspaceId, resumed.id, 'The model semantically correlated the new instruction to this incomplete execution.')
      : this.deps.missions.create({
          workspaceId: args.context.workspaceId,
          ownerAgentId: args.context.agentId,
          appId: args.context.appId ?? null,
          sourceKind: args.context.channelOrigin ? 'channel' : 'conversation',
          sourceRef: args.context.conversationId,
          correlationKey: `agent-execution:${args.context.durableTurnId ?? args.context.clientTurnId ?? cryptoRandomKey()}`,
          objective: decision.objective ?? args.request,
          outcomeContract: decision.outcomeContract ?? { requiredEffects: [] },
          executionPlan: decision.executionPlan ?? null,
          maxAttempts: 12,
          nextWakeAt: new Date().toISOString(),
        });
    const plannedMission = decision.executionPlan && decision.outcomeContract
      ? this.deps.missions.setExecutionPlan(args.context.workspaceId, mission.id, decision.outcomeContract, decision.executionPlan)
      : mission;
    return { decision, mission: plannedMission, runtimeDirective: this.runtimeDirective(plannedMission) };
  }

  runtimeDirective(mission: AgentMission): string {
    const pending = pendingRequirements(mission);
    const steps = mission.executionPlan?.steps ?? [];
    return [
      'AGENT EXECUTION CONTROLLER',
      `Mission: ${mission.id}`,
      `Objective: ${mission.objective}`,
      `Current executable step: ${mission.currentStepId ?? 'choose the next ready step'}`,
      `Pending commitments: ${pending.map((requirement) => `${requirement.id} (${requirement.kind}${requirement.targetRef ? ` → ${requirement.targetRef}` : ''})`).join(', ') || 'none'}`,
      steps.length ? `Plan: ${steps.map((step) => `${step.id}[${step.status ?? 'pending'}]: ${step.title}`).join(' -> ')}` : '',
      'Continue immediately with the offered native tools. A natural acknowledgement is progress, never completion.',
      'For an ordered channel burst, put each item in messages[] in the requested order and copy its matching requirementId into that item.',
      'Do not repeat an acknowledged item. Inspect/reconcile an existing effect before retrying it.',
      'Only give the final conversational reply after every pending commitment has a verified receipt.',
    ].filter(Boolean).join('\n');
  }

  continuationFor(mission: AgentMission, lastOutput: string): string {
    return [
      this.runtimeDirective(mission),
      lastOutput.trim() ? `Your last text was shown only as progress: ${JSON.stringify(lastOutput.trim().slice(0, 600))}` : '',
      'That text did not satisfy the outstanding commitments. Execute the next ready tool step now.',
    ].filter(Boolean).join('\n');
  }
}

function executionPlannerSystemPrompt(): string {
  return [
    'You are the planning stage of an autonomous Agent execution controller.',
    'Understand the request semantically in any language. Do not use keyword matching.',
    'Return exactly one JSON object with decision: reply | clarify | act | wait | complete.',
    'For reply, clarify, wait, or complete, include the concise natural-language message to the person in reply.',
    'Use reply only for answer-only conversation. Use clarify only when required information cannot be discovered with an offered tool.',
    'Use act whenever fulfilling the request requires one or more tools or external effects.',
    'Choose the tool whose abstraction matches the requested outcome: substantial visual redesigns and custom product interfaces require the managed React frontend tool when offered; declarative UI tools are only for explicitly low-code/schema-native edits.',
    'For a managed React create/redesign, first inspect the source and operation contract, then declare a fresh designIntent. The neutral starter is not a house style. Do not reuse another App’s palette, typography, sidebar/dashboard composition, decorative grammar, or fake controls. Implement the promised interaction states and bind declared backend operations through the runtime SDK.',
    'For act, include objective and steps. Each step has: id, kind (observe|effect|verify|wait), title, dependsOn, toolName, targetRef, effectKind, evidence.',
    'toolName must exactly match an available tool. Observe/verify steps may omit effectKind. Effect steps require effectKind: channel_delivery | data_mutation | schedule | subject_update.',
    'Create one effect step for every separately verifiable outcome. “Send a sticker, then a PDF” is two ordered channel_delivery effect steps, not one generic send.',
    'Independent effects may omit dependencies; ordered effects must depend on the prior step.',
    'If the new request semantically continues exactly one incomplete execution, set resumeMissionId to that id. Do not infer continuation from phrases alone.',
    'Do not invent completed effects. complete is valid only when the supplied incomplete execution already has no pending requirements.',
  ].join('\n');
}

function normalizeDecision(
  raw: ModelDecision,
  tools: ToolDefinition[],
  incomplete: AgentMission[],
): AgentDecision | null {
  const decision = string(raw.decision);
  if (!decision || !['reply', 'clarify', 'act', 'wait', 'complete'].includes(decision)) return null;
  const reply = string(raw.reply);
  const requestedResume = string(raw.resumeMissionId);
  if (decision !== 'act') {
    const resumeMissionId = requestedResume && incomplete.some((mission) => mission.id === requestedResume)
      ? requestedResume
      : null;
    if (decision === 'complete' && (!resumeMissionId
      || pendingRequirements(incomplete.find((mission) => mission.id === resumeMissionId)!).length > 0)) return null;
    return {
      decision: decision as AgentDecision['decision'],
      ...(reply ? { reply } : {}),
      ...(resumeMissionId ? { resumeMissionId } : {}),
    };
  }

  const toolNames = new Set(tools.map((tool) => tool.name));
  const sourceSteps = Array.isArray(raw.steps) ? raw.steps as ModelPlanStep[] : [];
  const ids = new Set<string>();
  const requirements: MissionEffectRequirement[] = [];
  const steps: ExecutionPlan['steps'] = [];
  for (const [index, source] of sourceSteps.entries()) {
    const kind = string(source.kind);
    const title = string(source.title);
    const toolName = string(source.toolName);
    if (!kind || !['observe', 'decide', 'effect', 'verify', 'wait'].includes(kind) || !title) return null;
    if (toolName && !toolNames.has(toolName)) return null;
    let id = string(source.id) || `step-${index + 1}`;
    while (ids.has(id)) id = `${id}-${index + 1}`;
    ids.add(id);
    const effectKind = kind === 'effect' ? normalizeEffectKind(source.effectKind) ?? effectKindForTool(toolName) : null;
    if (kind === 'effect' && (!toolName || !effectKind)) return null;
    const requirementId = effectKind ? `requirement:${id}` : null;
    if (effectKind && requirementId) {
      requirements.push({
        id: requirementId,
        kind: effectKind,
        planStepId: id,
        targetRef: string(source.targetRef) ?? null,
        dependsOn: arrayOfStrings(source.dependsOn),
        evidence: normalizeEvidence(source.evidence, effectKind),
        minimum: 1,
      });
    }
    steps.push({
      id,
      kind: kind as ExecutionPlan['steps'][number]['kind'],
      title,
      status: index === 0 ? 'ready' : 'pending',
      dependsOn: arrayOfStrings(source.dependsOn),
      toolName: toolName ?? null,
      targetRef: string(source.targetRef) ?? null,
      effectRequirementIds: requirementId ? [requirementId] : [],
    });
  }
  if (steps.length === 0 || requirements.length === 0) return null;
  const resumeMissionId = requestedResume && incomplete.some((mission) => mission.id === requestedResume)
    ? requestedResume
    : null;
  const objective = string(raw.objective) ?? incomplete.find((mission) => mission.id === resumeMissionId)?.objective;
  return {
    decision: 'act',
    objective,
    resumeMissionId,
    executionPlan: { version: 1, steps },
    outcomeContract: { requiredEffects: requirements, successPolicy: 'all_required_effects' },
  };
}

function pendingRequirements(mission: AgentMission): MissionEffectRequirement[] {
  const receipts = mission.receipts ?? [];
  const used = new Set<string>();
  const pending: MissionEffectRequirement[] = [];
  for (const requirement of mission.outcomeContract.requiredEffects) {
    const matching = receipts.filter((receipt) => !used.has(receipt.id)
      && receipt.kind === requirement.kind
      && (!receipt.requirementId || receipt.requirementId === requirement.id)
      && (requirement.kind !== 'channel_delivery' || receipt.acknowledged));
    const needed = requirement.minimum ?? 1;
    if (matching.length < needed) pending.push(requirement);
    for (const receipt of matching.slice(0, needed)) used.add(receipt.id);
  }
  return pending;
}

function effectKindForTool(toolName: string | null): EffectKind | null {
  if (!toolName) return null;
  if (toolName === 'agentis.channel.reply' || toolName === 'agentis.channel.send') return 'channel_delivery';
  if (toolName.includes('subject.') || toolName.includes('relationship')) return 'subject_update';
  if (toolName.includes('schedule') || toolName.includes('next_action')) return 'schedule';
  if (/\.(?:create|update|upsert|insert|delete|write|activate|pause|run)$/u.test(toolName)) return 'data_mutation';
  return null;
}

function normalizeEffectKind(value: unknown): EffectKind | null {
  return value === 'channel_delivery' || value === 'data_mutation' || value === 'schedule' || value === 'subject_update'
    ? value : null;
}

function normalizeEvidence(value: unknown, kind: EffectKind): MissionEffectRequirement['evidence'] {
  if (value === 'provider_acknowledgement' || value === 'mutation_receipt' || value === 'schedule_receipt' || value === 'receipt') return value;
  if (kind === 'channel_delivery') return 'provider_acknowledgement';
  if (kind === 'schedule') return 'schedule_receipt';
  return kind === 'data_mutation' || kind === 'subject_update' ? 'mutation_receipt' : 'receipt';
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : [];
}
function cryptoRandomKey(): string {
  return `${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}
