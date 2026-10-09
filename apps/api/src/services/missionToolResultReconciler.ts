import type {
  AgentMission,
  EffectKind,
  MissionEffectRequirement,
} from '@agentis/core';
import type { AgentMissionService } from './agentMissions.js';
import type { AgentisToolRegistry } from './agentisToolRegistry.js';
import { resultProvidesCompletionEvidence } from './chat/completionEvidence.js';

export interface ReconcileMissionToolResultInput {
  workspaceId: string;
  missionId: string;
  toolId: string;
  toolCallId: string;
  toolInput: Record<string, unknown>;
  output: unknown;
}

/**
 * Convert a successful tool result into the durable evidence required by the
 * mission that planned it. This is deliberately transport-neutral: chat-native,
 * MCP-native, workflow, and future tool transports must all use the same
 * reconciliation contract rather than manufacturing receipts independently.
 */
export function reconcileMissionToolResult(
  missions: AgentMissionService,
  registry: AgentisToolRegistry | undefined,
  input: ReconcileMissionToolResultInput,
): AgentMission {
  let mission = missions.inspect(input.workspaceId, input.missionId);
  if (!resultProvidesCompletionEvidence(input.output)) return mission;

  const toolId = canonicalAgentisToolName(input.toolId);
  const output = object(input.output);
  const actionId = string(object(output.action).id);
  if (actionId) {
    mission = missions.linkToolCall(input.workspaceId, input.missionId, input.toolCallId, actionId);
  }

  const invokedToolIds = [toolId, ...successfulNestedToolIds(output)]
    .filter((value, index, all) => all.indexOf(value) === index);
  const requirements = new Map<string, { requirement: MissionEffectRequirement; toolId: string }>();
  for (const invokedToolId of invokedToolIds) {
    for (const requirement of plannedToolRequirements(mission, invokedToolId, registry?.get(invokedToolId))) {
      const key = requirement.id ?? `${requirement.kind}:${requirement.planStepId ?? requirement.targetRef ?? invokedToolId}`;
      if (!requirements.has(key)) requirements.set(key, { requirement, toolId: invokedToolId });
    }
  }
  for (const { requirement, toolId: evidenceToolId } of requirements.values()) {
    // Provider-backed deliveries persist their acknowledgement in the provider
    // saga. A successful local submission must never be upgraded to delivery.
    if (requirement.kind === 'channel_delivery') continue;
    const nested = object(output.record);
    missions.recordReceipt({
      workspaceId: input.workspaceId,
      missionId: input.missionId,
      kind: requirement.kind,
      requirementId: requirement.id ?? null,
      planStepId: requirement.planStepId ?? null,
      toolCallId: input.toolCallId,
      acknowledged: true,
      resourceType: effectResourceType(requirement.kind, evidenceToolId),
      resourceId: string(output.id) ?? string(output.agentId) ?? string(nested.id)
        ?? string(input.toolInput.id) ?? string(input.toolInput.subjectId) ?? requirement.targetRef ?? null,
      resourceVersion: number(output.version) ?? number(nested.version),
      idempotencyKey: `tool:${input.missionId}:${requirement.id ?? `${toolId}:${input.toolCallId}`}`,
      evidence: input.output,
    });
  }
  return missions.settleIfSatisfied(input.workspaceId, input.missionId);
}

function successfulNestedToolIds(output: Record<string, unknown>): string[] {
  if (!Array.isArray(output.calls)) return [];
  return output.calls.flatMap((entry) => {
    const call = object(entry);
    const tool = string(call.tool);
    return tool && call.ok !== false ? [canonicalAgentisToolName(tool)] : [];
  });
}

/** Canonicalize provider-native aliases before matching an execution-plan step. */
export function canonicalAgentisToolName(name: string): string {
  return ({
    'image.generate': 'agentis.media.generate',
    'media.generate': 'agentis.media.generate',
    'assets.list': 'agentis.assets.list',
    'assets.search': 'agentis.assets.search',
    'assets.read': 'agentis.assets.read',
    'channel.send': 'agentis.channel.send',
  } as Record<string, string>)[name] ?? name;
}

function legacyToolEffectKind(toolId: string): 'data_mutation' | 'subject_update' | 'schedule' | null {
  if (['agentis.data.insert', 'agentis.data.update', 'agentis.data.upsert', 'agentis.data.batch'].includes(toolId)) return 'data_mutation';
  if (['agentis.subject.update_relationship', 'agentis.subject.enroll'].includes(toolId)) return 'subject_update';
  if (toolId.includes('schedule') || toolId.includes('next_action')) return 'schedule';
  return null;
}

function plannedToolRequirements(
  mission: AgentMission,
  toolId: string,
  definition?: ReturnType<AgentisToolRegistry['get']>,
): MissionEffectRequirement[] {
  const completed = new Set((mission.receipts ?? []).map((receipt) => receipt.requirementId).filter(Boolean));
  const requirementsById = new Map(mission.outcomeContract.requiredEffects
    .filter((requirement) => requirement.id)
    .map((requirement) => [requirement.id!, requirement]));
  const candidates = (mission.executionPlan?.steps ?? []).filter((step) => step.kind === 'effect'
    && canonicalAgentisToolName(step.toolName ?? '') === toolId
    && step.status !== 'verified'
    && step.status !== 'cancelled');
  const step = candidates.find((item) => item.id === mission.currentStepId)
    ?? candidates.find((item) => item.status === 'executing' || item.status === 'ready')
    ?? candidates[0];
  const exact = (step?.effectRequirementIds ?? [])
    .map((id) => requirementsById.get(id))
    .filter((requirement): requirement is MissionEffectRequirement => Boolean(requirement))
    .filter((requirement) => !requirement.id || !completed.has(requirement.id));
  if (exact.length > 0) return exact;

  // Compatibility for missions created before the execution controller: only
  // reconcile an unambiguous non-provider mutation.
  if (!definition?.mutating) return [];
  const pending = mission.outcomeContract.requiredEffects.filter((requirement) =>
    requirement.kind !== 'channel_delivery' && (!requirement.id || !completed.has(requirement.id)));
  const legacyKind = legacyToolEffectKind(toolId);
  const matching = legacyKind ? pending.filter((requirement) => requirement.kind === legacyKind) : pending;
  return matching.length === 1 ? matching : [];
}

function effectResourceType(kind: EffectKind, toolId: string): string {
  if (kind === 'subject_update') return 'subject';
  if (kind === 'schedule') return 'next_action';
  if (toolId.startsWith('agentis.agent.brain.')) return 'agent_brain';
  return 'agentis_resource';
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function string(value: unknown): string | null { return typeof value === 'string' && value ? value : null; }
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
