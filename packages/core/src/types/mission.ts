export type AgentMissionStatus =
  | 'queued'
  | 'running'
  | 'input_required'
  | 'approval_required'
  | 'waiting'
  | 'replanning'
  | 'accomplished'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'rejected';

export type EffectKind = 'channel_delivery' | 'data_mutation' | 'schedule' | 'subject_update' | (string & {});

import type { AppArtifactRef, AuthorityContext, TaskApprovalRequest, TaskInputRequest } from './agenticApp.js';

export type AgentDecisionKind = 'reply' | 'clarify' | 'act' | 'wait' | 'complete';
export type AgentExecutionPlanStepStatus =
  | 'pending'
  | 'ready'
  | 'executing'
  | 'waiting'
  | 'verified'
  | 'failed'
  | 'cancelled';

export interface AgentDecision {
  decision: AgentDecisionKind;
  objective?: string;
  reply?: string;
  resumeMissionId?: string | null;
  executionPlan?: ExecutionPlan | null;
  outcomeContract?: MissionOutcomeContract | null;
}

export interface AgentExecutionResult {
  decision: AgentDecisionKind;
  missionId: string | null;
  status: AgentMissionStatus | 'answered' | 'clarification_required';
  reply?: string | null;
  pendingRequirementIds?: string[];
  receipts?: EffectReceipt[];
}

export interface MissionEffectRequirement {
  /** Stable identity for this exact commitment (not merely its broad kind). */
  id?: string;
  kind: EffectKind;
  /** Optional stable target (connection, collection, Subject, etc.). */
  targetRef?: string | null;
  planStepId?: string | null;
  dependsOn?: string[];
  /** Evidence policy used to verify this exact commitment. */
  evidence?: 'provider_acknowledgement' | 'mutation_receipt' | 'schedule_receipt' | 'receipt';
  minimum?: number;
}

export interface MissionOutcomeContract {
  requiredEffects: MissionEffectRequirement[];
  /** Assertions that must remain true while effects are committed. */
  invariants?: string[];
  successPolicy?: 'all_required_effects';
}

export interface ExecutionPlanPort {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'unknown';
  required?: boolean;
}

export interface ExecutionPlanStep {
  id: string;
  kind: 'observe' | 'decide' | 'effect' | 'verify' | 'wait';
  title: string;
  status?: AgentExecutionPlanStepStatus;
  dependsOn?: string[];
  toolName?: string | null;
  targetRef?: string | null;
  effectRequirementIds?: string[];
  lastError?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  inputPorts?: ExecutionPlanPort[];
  outputPorts?: ExecutionPlanPort[];
  /** @deprecated Use effectRequirementIds. */
  requiredEffects?: EffectKind[];
}

export interface ExecutionPlan {
  version: number;
  steps: ExecutionPlanStep[];
}

export interface EffectReceipt {
  id: string;
  workspaceId: string;
  missionId: string;
  effectIntentId: string | null;
  requirementId: string | null;
  planStepId: string | null;
  kind: EffectKind;
  actionId: string | null;
  toolCallId: string | null;
  providerMessageId: string | null;
  providerStatus: string | null;
  acknowledged: boolean;
  resourceType: string | null;
  resourceId: string | null;
  resourceVersion: number | null;
  idempotencyKey: string | null;
  evidence: unknown;
  observedAt: string;
  createdAt: string;
}

export interface AgentMission {
  id: string;
  workspaceId: string;
  ownerAgentId: string;
  appId: string | null;
  subjectId: string | null;
  standingGoalId: string | null;
  sourceKind: 'conversation' | 'channel' | 'workflow' | 'standing_goal' | 'followup' | 'api';
  sourceRef: string | null;
  correlationKey: string;
  objective: string;
  operationId: string | null;
  rootMissionId: string;
  parentMissionId: string | null;
  delegationId: string | null;
  authorityContext: AuthorityContext | null;
  status: AgentMissionStatus;
  outcomeContract: MissionOutcomeContract;
  executionPlan: ExecutionPlan | null;
  planVersion: number;
  currentStepId: string | null;
  blocker: { code: string; detail: string; recoverable: boolean } | null;
  nextWakeAt: string | null;
  attemptCount: number;
  maxAttempts: number;
  tokenBudget: number | null;
  tokensUsed: number;
  costBudgetCents: number | null;
  costUsedCents: number;
  latencyBudgetMs: number | null;
  deadlineAt: string | null;
  inputRequests: TaskInputRequest[];
  approvalRequests: TaskApprovalRequest[];
  artifacts: AppArtifactRef[];
  childMissionIds?: string[];
  timeline?: MissionEvent[];
  lastProgress: string | null;
  startedAt: string | null;
  settledAt: string | null;
  createdAt: string;
  updatedAt: string;
  receipts?: EffectReceipt[];
}

export interface MissionEvent {
  id: string;
  workspaceId: string;
  missionId: string;
  eventType: string;
  actorPrincipalId: string | null;
  payload: unknown;
  createdAt: string;
}

export interface AuthorityDecision {
  ok: boolean;
  basis?: 'connection_owner' | 'verified_owner_command' | 'standing_goal' | 'persistent_grant' | 'workspace_shared';
  reason?: string;
  approvalRequired?: boolean;
}
