import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lte } from 'drizzle-orm';
import {
  AgentisError,
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  type AgentMission,
  type AgentMissionStatus,
  type AppArtifactRef,
  authorityContextSchema,
  type EffectKind,
  type EffectReceipt,
  type ExecutionPlan,
  type MissionEffectRequirement,
  type MissionOutcomeContract,
  type AuthorityContext,
  type MissionEvent,
  type TaskApprovalRequest,
  type TaskInputRequest,
} from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';

const TERMINAL = ['accomplished', 'blocked', 'failed', 'cancelled', 'rejected'] as const;

export interface CreateMissionInput {
  workspaceId: string;
  ownerAgentId: string;
  appId?: string | null;
  subjectId?: string | null;
  standingGoalId?: string | null;
  sourceKind: AgentMission['sourceKind'];
  sourceRef?: string | null;
  correlationKey?: string;
  objective: string;
  operationId?: string | null;
  parentMissionId?: string | null;
  delegationId?: string | null;
  authorityContext?: AuthorityContext | null;
  outcomeContract?: MissionOutcomeContract;
  executionPlan?: ExecutionPlan | null;
  maxAttempts?: number;
  tokenBudget?: number | null;
  costBudgetCents?: number | null;
  latencyBudgetMs?: number | null;
  deadlineAt?: string | null;
  nextWakeAt?: string | null;
}

export interface RecordEffectReceiptInput {
  workspaceId: string;
  missionId: string;
  kind: EffectKind;
  effectIntentId?: string | null;
  requirementId?: string | null;
  planStepId?: string | null;
  actionId?: string | null;
  toolCallId?: string | null;
  providerMessageId?: string | null;
  providerStatus?: string | null;
  acknowledged?: boolean;
  resourceType?: string | null;
  resourceId?: string | null;
  resourceVersion?: number | null;
  idempotencyKey: string;
  evidence?: unknown;
  observedAt?: string;
}

/**
 * Authoritative durable owner for requested outcomes.
 *
 * Runtime/model turns may stop, but a mission does not settle until this
 * service can prove every required effect from the normalized receipt ledger.
 */
export class AgentMissionService {
  constructor(private readonly db: AgentisSqliteDb, private readonly bus?: EventBus) {}

  create(input: CreateMissionInput): AgentMission {
    const objective = input.objective.trim();
    if (!objective) throw new AgentisError('VALIDATION_FAILED', 'A mission objective is required.');
    const agent = this.db.select({ id: schema.agents.id }).from(schema.agents).where(and(
      eq(schema.agents.workspaceId, input.workspaceId), eq(schema.agents.id, input.ownerAgentId),
    )).get();
    if (!agent) throw new AgentisError('RESOURCE_NOT_FOUND', `agent ${input.ownerAgentId} not found`);

    const correlationKey = input.correlationKey?.trim() || `mission:${randomUUID()}`;
    const existing = this.db.select().from(schema.agentMissions).where(and(
      eq(schema.agentMissions.workspaceId, input.workspaceId), eq(schema.agentMissions.correlationKey, correlationKey),
    )).get();
    if (existing) return this.inspect(input.workspaceId, existing.id);

    const now = new Date().toISOString();
    const id = randomUUID();
    const parent = input.parentMissionId ? this.inspect(input.workspaceId, input.parentMissionId) : null;
    if (parent && parent.appId && input.appId && parent.appId !== input.appId) {
      throw new AgentisError('VALIDATION_FAILED', 'A child mission must belong to the parent App.');
    }
    const authority = input.authorityContext
      ? authorityContextSchema.parse({ ...input.authorityContext, taskId: id, appId: input.appId ?? input.authorityContext.appId })
      : null;
    // Requests without an explicit legacy contract are compiled by the
    // model-driven AgentExecutionController on first execution. Mission storage
    // never guesses commitments from words in the objective.
    const contract = normalizeContract(input.outcomeContract ?? { requiredEffects: [] });
    const executionPlan = input.executionPlan ? normalizeExecutionPlan(input.executionPlan, contract) : null;
    const row = {
      id, workspaceId: input.workspaceId, ownerAgentId: input.ownerAgentId,
      appId: input.appId ?? null, subjectId: input.subjectId ?? null, standingGoalId: input.standingGoalId ?? null,
      sourceKind: input.sourceKind, sourceRef: input.sourceRef ?? null, correlationKey, objective,
      operationId: input.operationId ?? null, rootMissionId: parent?.rootMissionId ?? id,
      parentMissionId: parent?.id ?? null, delegationId: input.delegationId ?? null,
      authorityContextJson: authority, inputRequestsJson: [], approvalRequestsJson: [], artifactsJson: [],
      status: 'queued', outcomeContractJson: contract, executionPlanJson: executionPlan,
      planVersion: executionPlan?.version ?? 1, currentStepId: executionPlan ? nextExecutableStep(executionPlan)?.id ?? null : null,
      blockerJson: null, nextWakeAt: input.nextWakeAt ?? now, attemptCount: 0,
      // This is a defensive execution budget, not the intelligence loop. Model
      // turns stop on verified completion, a real dependency, or no-progress;
      // routine schema repair/provider reconciliation does not consume it.
      maxAttempts: Math.max(1, Math.min(100, input.maxAttempts ?? 12)), tokenBudget: input.tokenBudget ?? null,
      tokensUsed: 0, costBudgetCents: input.costBudgetCents ?? null, costUsedCents: 0,
      latencyBudgetMs: input.latencyBudgetMs ?? null, deadlineAt: input.deadlineAt ?? null,
      lastProgress: 'Mission queued', startedAt: null, settledAt: null,
      createdAt: now, updatedAt: now,
    };
    this.db.insert(schema.agentMissions).values(row).run();
    this.#event(input.workspaceId, id, 'task.created', authority?.actorPrincipalId ?? null, {
      objective, operationId: input.operationId ?? null, parentMissionId: parent?.id ?? null,
    });
    const mission = this.inspect(input.workspaceId, row.id);
    this.#publish(mission, REALTIME_EVENTS.MISSION_CREATED);
    return mission;
  }

  inspect(workspaceId: string, id: string): AgentMission {
    const row = this.db.select().from(schema.agentMissions).where(and(
      eq(schema.agentMissions.workspaceId, workspaceId), eq(schema.agentMissions.id, id),
    )).get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `mission ${id} not found`);
    const receipts = this.db.select().from(schema.effectReceipts).where(and(
      eq(schema.effectReceipts.workspaceId, workspaceId), eq(schema.effectReceipts.missionId, id),
    )).orderBy(desc(schema.effectReceipts.observedAt)).all().map(presentReceipt);
    const children = this.db.select({ id: schema.agentMissions.id }).from(schema.agentMissions).where(and(
      eq(schema.agentMissions.workspaceId, workspaceId), eq(schema.agentMissions.parentMissionId, id),
    )).orderBy(desc(schema.agentMissions.createdAt)).all().map((child) => child.id);
    const timeline = this.db.select().from(schema.missionEvents).where(and(
      eq(schema.missionEvents.workspaceId, workspaceId), eq(schema.missionEvents.missionId, id),
    )).orderBy(schema.missionEvents.createdAt).all().map(presentMissionEvent);
    return { ...presentMission(row), receipts, childMissionIds: children, timeline };
  }

  list(workspaceId: string, filters: {
    ownerAgentId?: string; appId?: string; subjectId?: string; sourceRef?: string;
    status?: AgentMissionStatus | AgentMissionStatus[]; dueBefore?: string; limit?: number;
  } = {}): AgentMission[] {
    const statuses = Array.isArray(filters.status) ? filters.status : filters.status ? [filters.status] : [];
    return this.db.select().from(schema.agentMissions).where(and(
      eq(schema.agentMissions.workspaceId, workspaceId),
      ...(filters.ownerAgentId ? [eq(schema.agentMissions.ownerAgentId, filters.ownerAgentId)] : []),
      ...(filters.appId ? [eq(schema.agentMissions.appId, filters.appId)] : []),
      ...(filters.subjectId ? [eq(schema.agentMissions.subjectId, filters.subjectId)] : []),
      ...(filters.sourceRef ? [eq(schema.agentMissions.sourceRef, filters.sourceRef)] : []),
      ...(statuses.length ? [inArray(schema.agentMissions.status, statuses)] : []),
      ...(filters.dueBefore ? [lte(schema.agentMissions.nextWakeAt, filters.dueBefore)] : []),
    )).orderBy(desc(schema.agentMissions.updatedAt)).limit(Math.max(1, Math.min(200, filters.limit ?? 50)))
      .all().map(presentMission);
  }

  start(workspaceId: string, id: string, stepId?: string | null): AgentMission {
    const mission = this.inspect(workspaceId, id);
    if (TERMINAL.includes(mission.status as (typeof TERMINAL)[number])) return mission;
    return this.#update(workspaceId, id, {
      status: 'running', currentStepId: stepId ?? mission.currentStepId, blockerJson: null,
      startedAt: mission.startedAt ?? new Date().toISOString(), nextWakeAt: null,
      attemptCount: mission.attemptCount + 1,
    });
  }

  progress(workspaceId: string, id: string, message: string, options: {
    stepId?: string | null; nextWakeAt?: string | null; tokensUsed?: number; costCents?: number;
  } = {}): AgentMission {
    const mission = this.inspect(workspaceId, id);
    if (TERMINAL.includes(mission.status as (typeof TERMINAL)[number])) return mission;
    const nextStatus = options.nextWakeAt ? 'waiting' : mission.status === 'queued' ? 'running' : mission.status;
    const updated = this.#update(workspaceId, id, {
      status: nextStatus, lastProgress: message.trim().slice(0, 2_000),
      currentStepId: options.stepId === undefined ? mission.currentStepId : options.stepId,
      nextWakeAt: options.nextWakeAt === undefined ? mission.nextWakeAt : options.nextWakeAt,
      tokensUsed: mission.tokensUsed + Math.max(0, options.tokensUsed ?? 0),
      costUsedCents: mission.costUsedCents + Math.max(0, options.costCents ?? 0),
    });
    this.#publish(updated, REALTIME_EVENTS.MISSION_PROGRESS, { message: updated.lastProgress, stepId: updated.currentStepId });
    return updated;
  }

  replan(workspaceId: string, id: string, detail: string, executionPlan?: ExecutionPlan): AgentMission {
    const mission = this.inspect(workspaceId, id);
    if (TERMINAL.includes(mission.status as (typeof TERMINAL)[number])) return mission;
    return this.#update(workspaceId, id, {
      status: 'replanning', blockerJson: { code: 'REPLANNING', detail, recoverable: true },
      executionPlanJson: executionPlan ?? mission.executionPlan, planVersion: mission.planVersion + 1,
      currentStepId: executionPlan?.steps[0]?.id ?? mission.currentStepId, nextWakeAt: new Date().toISOString(),
    });
  }

  /** Persist a model-authored plan and its exact effect commitments. */
  setExecutionPlan(
    workspaceId: string,
    id: string,
    outcomeContract: MissionOutcomeContract,
    executionPlan: ExecutionPlan,
  ): AgentMission {
    const mission = this.inspect(workspaceId, id);
    if (TERMINAL.includes(mission.status as (typeof TERMINAL)[number])) return mission;
    const contract = normalizeContract(outcomeContract);
    const plan = normalizeExecutionPlan(executionPlan, contract);
    return this.#update(workspaceId, id, {
      outcomeContractJson: contract,
      executionPlanJson: plan,
      planVersion: Math.max(mission.planVersion + 1, plan.version),
      currentStepId: nextExecutableStep(plan)?.id ?? null,
      status: 'queued',
      blockerJson: null,
      nextWakeAt: new Date().toISOString(),
    });
  }

  wait(workspaceId: string, id: string, blocker: { code: string; detail: string; recoverable: true }, nextWakeAt: string): AgentMission {
    return this.#update(workspaceId, id, { status: 'waiting', blockerJson: blocker, nextWakeAt });
  }

  requestInput(workspaceId: string, id: string, request: Omit<TaskInputRequest, 'createdAt' | 'status'> & { createdAt?: string }): AgentMission {
    const mission = this.inspect(workspaceId, id);
    if (TERMINAL.includes(mission.status as (typeof TERMINAL)[number])) return mission;
    const item: TaskInputRequest = { ...request, status: 'pending', createdAt: request.createdAt ?? new Date().toISOString() };
    if (mission.inputRequests.some((existing) => existing.id === item.id)) return mission;
    this.#event(workspaceId, id, 'task.input_required', mission.authorityContext?.actorPrincipalId ?? null, { request: item });
    return this.#update(workspaceId, id, {
      status: 'input_required', inputRequestsJson: [...mission.inputRequests, item], nextWakeAt: null,
      lastProgress: item.title,
    });
  }

  submitInput(workspaceId: string, id: string, requestId: string, response: unknown, actorPrincipalId: string): AgentMission {
    const mission = this.inspect(workspaceId, id);
    let found = false;
    const resolvedAt = new Date().toISOString();
    const requests = mission.inputRequests.map((request) => {
      if (request.id !== requestId || request.status !== 'pending') return request;
      found = true;
      return { ...request, status: 'fulfilled' as const, response, resolvedAt };
    });
    if (!found) throw new AgentisError('RESOURCE_NOT_FOUND', `pending input request ${requestId} not found`);
    const pending = requests.some((request) => request.status === 'pending');
    this.#event(workspaceId, id, 'task.input_submitted', actorPrincipalId, { requestId });
    return this.#update(workspaceId, id, {
      inputRequestsJson: requests, status: pending ? 'input_required' : 'queued',
      nextWakeAt: pending ? null : resolvedAt, blockerJson: null, lastProgress: `Input received: ${requestId}`,
    });
  }

  requestApproval(workspaceId: string, id: string, request: Omit<TaskApprovalRequest, 'requestedAt' | 'status'> & { requestedAt?: string }): AgentMission {
    const mission = this.inspect(workspaceId, id);
    if (TERMINAL.includes(mission.status as (typeof TERMINAL)[number])) return mission;
    const item: TaskApprovalRequest = { ...request, status: 'pending', requestedAt: request.requestedAt ?? new Date().toISOString() };
    if (mission.approvalRequests.some((existing) => existing.id === item.id)) return mission;
    this.#event(workspaceId, id, 'task.approval_required', mission.authorityContext?.actorPrincipalId ?? null, { request: item });
    return this.#update(workspaceId, id, {
      status: 'approval_required', approvalRequestsJson: [...mission.approvalRequests, item], nextWakeAt: null,
      lastProgress: item.title,
    });
  }

  resolveApproval(workspaceId: string, id: string, requestId: string, decision: 'approved' | 'rejected', actorPrincipalId: string): AgentMission {
    const mission = this.inspect(workspaceId, id);
    const target = mission.approvalRequests.find((request) => request.id === requestId && request.status === 'pending');
    if (!target) throw new AgentisError('RESOURCE_NOT_FOUND', `pending approval request ${requestId} not found`);
    if (decision === 'approved' && target.effectPlanId) {
      const effect = this.db.select({ status: schema.effectPlans.status }).from(schema.effectPlans).where(and(
        eq(schema.effectPlans.workspaceId, workspaceId), eq(schema.effectPlans.id, target.effectPlanId),
      )).get();
      if (!effect || effect.status !== 'authorized') {
        throw new AgentisError('AUTH_FORBIDDEN', `Authorize effect plan ${target.effectPlanId} through the effect authorization endpoint before approving this task request.`);
      }
    }
    let found = false;
    const decidedAt = new Date().toISOString();
    const requests = mission.approvalRequests.map((request) => {
      if (request.id !== requestId || request.status !== 'pending') return request;
      found = true;
      return { ...request, status: decision, decidedAt, decidedBy: actorPrincipalId };
    });
    if (!found) throw new AgentisError('RESOURCE_NOT_FOUND', `pending approval request ${requestId} not found`);
    this.#event(workspaceId, id, `task.approval_${decision}`, actorPrincipalId, { requestId });
    if (decision === 'rejected') {
      if (target.effectPlanId) this.db.update(schema.effectPlans).set({
        status: 'cancelled', lastError: `Authorization rejected by ${actorPrincipalId}`, updatedAt: decidedAt,
      }).where(and(eq(schema.effectPlans.workspaceId, workspaceId), eq(schema.effectPlans.id, target.effectPlanId))).run();
      return this.#settle(workspaceId, id, 'rejected', { code: 'APPROVAL_REJECTED', detail: `Approval ${requestId} was rejected`, recoverable: false }, requests);
    }
    const pending = requests.some((request) => request.status === 'pending');
    return this.#update(workspaceId, id, {
      approvalRequestsJson: requests, status: pending ? 'approval_required' : 'queued',
      nextWakeAt: pending ? null : decidedAt, blockerJson: null, lastProgress: `Approval granted: ${requestId}`,
    });
  }

  attachArtifact(workspaceId: string, id: string, artifact: AppArtifactRef, actorPrincipalId?: string): AgentMission {
    const mission = this.inspect(workspaceId, id);
    if (mission.artifacts.some((existing) => existing.id === artifact.id)) return mission;
    this.#event(workspaceId, id, 'task.artifact_attached', actorPrincipalId ?? null, { artifact });
    return this.#update(workspaceId, id, { artifactsJson: [...mission.artifacts, artifact] });
  }

  block(workspaceId: string, id: string, blocker: { code: string; detail: string; recoverable: boolean }): AgentMission {
    return this.#settle(workspaceId, id, 'blocked', blocker);
  }

  fail(workspaceId: string, id: string, code: string, detail: string): AgentMission {
    return this.#settle(workspaceId, id, 'failed', { code, detail, recoverable: false });
  }

  complete(workspaceId: string, id: string, progress = 'Task completed'): AgentMission {
    const mission = this.inspect(workspaceId, id);
    if (mission.outcomeContract.requiredEffects.length > 0
      && !requirementsSatisfied(mission.outcomeContract.requiredEffects, mission.receipts ?? [])) {
      throw new AgentisError('RESOURCE_CONFLICT', 'Task cannot complete before all required effects are verified.');
    }
    const completed = this.#settle(workspaceId, id, 'accomplished', null);
    return progress === 'Task completed' ? completed : this.#update(workspaceId, id, { lastProgress: progress });
  }

  cancel(workspaceId: string, id: string, reason = 'Cancelled by operator'): AgentMission {
    const mission = this.inspect(workspaceId, id);
    const children = this.db.select({ id: schema.agentMissions.id }).from(schema.agentMissions).where(and(
      eq(schema.agentMissions.workspaceId, workspaceId), eq(schema.agentMissions.parentMissionId, id),
    )).all();
    for (const child of children) {
      const childMission = this.inspect(workspaceId, child.id);
      if (!['accomplished', 'failed', 'cancelled', 'rejected'].includes(childMission.status)) {
        this.cancel(workspaceId, child.id, `Parent task ${id} was cancelled: ${reason}`);
      }
    }
    return ['accomplished', 'failed', 'cancelled', 'rejected'].includes(mission.status)
      ? this.inspect(workspaceId, id)
      : this.#settle(workspaceId, id, 'cancelled', { code: 'CANCELLED', detail: reason, recoverable: false });
  }

  resume(workspaceId: string, id: string, reason = 'Mission resumed'): AgentMission {
    const mission = this.inspect(workspaceId, id);
    if (mission.status === 'accomplished' || mission.status === 'cancelled') return mission;
    return this.#update(workspaceId, id, {
      status: 'queued', blockerJson: null, nextWakeAt: new Date().toISOString(), settledAt: null,
      // An explicit operator resume starts a fresh configured execution budget.
      // Keeping an exhausted counter made "try again" immediately re-block
      // without allowing the Agent to execute a new tool-bearing strategy.
      attemptCount: 0, planVersion: mission.planVersion + 1, lastProgress: reason,
    });
  }

  linkWorkflowRun(workspaceId: string, missionId: string, runId: string): AgentMission {
    const mission = this.inspect(workspaceId, missionId);
    const updated = this.db.update(schema.workflowRuns).set({ missionId, updatedAt: new Date().toISOString() }).where(and(
      eq(schema.workflowRuns.workspaceId, workspaceId), eq(schema.workflowRuns.id, runId),
    )).run();
    if (updated.changes !== 1) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow run ${runId} not found`);
    return this.#update(workspaceId, missionId, { sourceKind: 'workflow', sourceRef: runId, nextWakeAt: new Date().toISOString() });
  }

  recordReceipt(input: RecordEffectReceiptInput): EffectReceipt {
    const mission = this.inspect(input.workspaceId, input.missionId);
    if (mission.status === 'cancelled') throw new AgentisError('RESOURCE_CONFLICT', 'Cannot add an effect to a cancelled mission.');
    const existing = this.db.select().from(schema.effectReceipts).where(and(
      eq(schema.effectReceipts.workspaceId, input.workspaceId),
      eq(schema.effectReceipts.missionId, input.missionId),
      eq(schema.effectReceipts.kind, input.kind),
      eq(schema.effectReceipts.idempotencyKey, input.idempotencyKey),
    )).get();
    if (existing) {
      this.settleIfSatisfied(input.workspaceId, input.missionId);
      return presentReceipt(existing);
    }
    const now = input.observedAt ?? new Date().toISOString();
    const requirement = input.requirementId
      ? mission.outcomeContract.requiredEffects.find((item) => item.id === input.requirementId)
      : nextUnverifiedRequirement(mission, input.kind);
    const requirementId = input.requirementId ?? requirement?.id ?? null;
    const planStepId = input.planStepId ?? requirement?.planStepId ?? null;
    const row = {
      id: randomUUID(), workspaceId: input.workspaceId, missionId: input.missionId,
      effectIntentId: input.effectIntentId ?? null, requirementId, planStepId,
      kind: input.kind, actionId: input.actionId ?? null,
      toolCallId: input.toolCallId ?? null, providerMessageId: input.providerMessageId ?? null,
      providerStatus: input.providerStatus ?? null, acknowledged: input.acknowledged ?? false,
      resourceType: input.resourceType ?? null, resourceId: input.resourceId ?? null,
      resourceVersion: input.resourceVersion ?? null, idempotencyKey: input.idempotencyKey,
      evidenceJson: input.evidence ?? {}, observedAt: now, createdAt: now,
    };
    this.db.insert(schema.effectReceipts).values(row).run();
    this.settleIfSatisfied(input.workspaceId, input.missionId);
    return presentReceipt(row);
  }

  /** Attach the originating model/tool invocation to receipts created inside a
   * durable effect service. The channel saga persists provider proof before it
   * returns to chat, so this post-return link keeps one receipt (not a duplicate)
   * while preserving exact plan → tool → provider lineage. */
  linkToolCall(workspaceId: string, missionId: string, toolCallId: string, actionId: string): AgentMission {
    this.inspect(workspaceId, missionId);
    this.db.update(schema.effectReceipts).set({ toolCallId }).where(and(
      eq(schema.effectReceipts.workspaceId, workspaceId),
      eq(schema.effectReceipts.missionId, missionId),
      eq(schema.effectReceipts.actionId, actionId),
      isNull(schema.effectReceipts.toolCallId),
    )).run();
    return this.inspect(workspaceId, missionId);
  }

  settleIfSatisfied(workspaceId: string, id: string): AgentMission {
    let mission = this.inspect(workspaceId, id);
    if (mission.status === 'cancelled' || mission.status === 'failed') return mission;
    const receipts = mission.receipts ?? [];
    const satisfied = requirementsSatisfied(mission.outcomeContract.requiredEffects, receipts);
    if (mission.executionPlan) {
      const reconciled = reconcileExecutionPlan(mission.executionPlan, mission.outcomeContract, receipts);
      const executionPlan = satisfied && mission.outcomeContract.requiredEffects.length > 0
        ? { ...reconciled, steps: reconciled.steps.map((step) => ({
            ...step,
            status: step.status === 'cancelled' ? 'cancelled' as const : 'verified' as const,
            finishedAt: step.status === 'cancelled' ? step.finishedAt : step.finishedAt ?? new Date().toISOString(),
          })) }
        : reconciled;
      const currentStepId = satisfied ? null : nextExecutableStep(executionPlan)?.id ?? null;
      if (JSON.stringify(executionPlan) !== JSON.stringify(mission.executionPlan) || currentStepId !== mission.currentStepId) {
        mission = this.#update(workspaceId, id, { executionPlanJson: executionPlan, currentStepId });
      }
    }
    if (!satisfied || mission.outcomeContract.requiredEffects.length === 0) return mission;
    return this.#settle(workspaceId, id, 'accomplished', null);
  }

  #settle(workspaceId: string, id: string, status: Extract<AgentMissionStatus, 'accomplished' | 'blocked' | 'failed' | 'cancelled' | 'rejected'>,
    blocker: AgentMission['blocker'], approvalRequests?: TaskApprovalRequest[]): AgentMission {
    const mission = this.inspect(workspaceId, id);
    if (mission.status === 'accomplished' || mission.status === 'failed' || mission.status === 'cancelled' || mission.status === 'rejected') return mission;
    const updated = this.#update(workspaceId, id, {
      status, blockerJson: blocker, nextWakeAt: null, settledAt: new Date().toISOString(),
      ...(approvalRequests ? { approvalRequestsJson: approvalRequests } : {}),
      lastProgress: status === 'accomplished' ? 'All required effects verified' : blocker?.detail ?? status,
    });
    this.#publish(updated, REALTIME_EVENTS.MISSION_SETTLED);
    this.#event(workspaceId, id, `task.${status}`, updated.authorityContext?.actorPrincipalId ?? null, { blocker });
    return updated;
  }

  #update(workspaceId: string, id: string, patch: Partial<typeof schema.agentMissions.$inferInsert>): AgentMission {
    const result = this.db.update(schema.agentMissions).set({ ...patch, updatedAt: new Date().toISOString() }).where(and(
      eq(schema.agentMissions.workspaceId, workspaceId), eq(schema.agentMissions.id, id),
    )).run();
    if (result.changes !== 1) throw new AgentisError('RESOURCE_NOT_FOUND', `mission ${id} not found`);
    const mission = this.inspect(workspaceId, id);
    this.#publish(mission, REALTIME_EVENTS.MISSION_UPDATED);
    return mission;
  }

  #publish(mission: AgentMission, event: typeof REALTIME_EVENTS.MISSION_CREATED | typeof REALTIME_EVENTS.MISSION_UPDATED
    | typeof REALTIME_EVENTS.MISSION_PROGRESS | typeof REALTIME_EVENTS.MISSION_SETTLED, extra?: Record<string, unknown>): void {
    const payload = { mission, ...extra };
    this.bus?.publish(REALTIME_ROOMS.mission(mission.id), event, payload, mission.id);
    this.bus?.publish(REALTIME_ROOMS.workspace(mission.workspaceId), event, payload, mission.id);
    this.bus?.publish(REALTIME_ROOMS.agent(mission.ownerAgentId), event, payload, mission.id);
  }

  #event(workspaceId: string, missionId: string, eventType: string, actorPrincipalId: string | null, payload: unknown): void {
    this.db.insert(schema.missionEvents).values({
      id: randomUUID(), workspaceId, missionId, eventType, actorPrincipalId,
      payloadJson: payload ?? {}, createdAt: new Date().toISOString(),
    }).run();
  }
}

function normalizeContract(contract: MissionOutcomeContract): MissionOutcomeContract {
  const normalized: MissionOutcomeContract['requiredEffects'] = [];
  const seen = new Set<string>();
  for (const [index, requirement] of (contract.requiredEffects ?? []).entries()) {
    if (!requirement.kind?.trim()) continue;
    let id = requirement.id?.trim() || `legacy:${requirement.kind}:${index + 1}`;
    while (seen.has(id)) id = `${id}:${index + 1}`;
    seen.add(id);
    normalized.push({
      id,
      kind: requirement.kind,
      targetRef: requirement.targetRef ?? null,
      planStepId: requirement.planStepId ?? null,
      dependsOn: [...new Set(requirement.dependsOn ?? [])],
      evidence: requirement.evidence ?? defaultEvidence(requirement.kind),
      minimum: Math.max(1, requirement.minimum ?? 1),
    });
  }
  return { requiredEffects: normalized, invariants: contract.invariants ?? [], successPolicy: 'all_required_effects' };
}

function presentMission(row: typeof schema.agentMissions.$inferSelect): AgentMission {
  const { outcomeContractJson, executionPlanJson, blockerJson, authorityContextJson,
    inputRequestsJson, approvalRequestsJson, artifactsJson, ...mission } = row;
  return {
    ...mission, sourceKind: row.sourceKind as AgentMission['sourceKind'], status: row.status as AgentMissionStatus,
    rootMissionId: row.rootMissionId ?? row.id,
    authorityContext: authorityContextJson ? authorityContextSchema.parse(authorityContextJson) : null,
    inputRequests: inputRequestsJson as TaskInputRequest[],
    approvalRequests: approvalRequestsJson as TaskApprovalRequest[],
    artifacts: artifactsJson as AppArtifactRef[],
    outcomeContract: normalizeContract(outcomeContractJson as MissionOutcomeContract),
    executionPlan: executionPlanJson as ExecutionPlan | null,
    blocker: blockerJson as AgentMission['blocker'],
  };
}

function presentMissionEvent(row: typeof schema.missionEvents.$inferSelect): MissionEvent {
  const { payloadJson, ...event } = row;
  return { ...event, payload: payloadJson };
}

function presentReceipt(row: typeof schema.effectReceipts.$inferSelect): EffectReceipt {
  const { evidenceJson, ...receipt } = row;
  return { ...receipt, kind: row.kind as EffectKind, evidence: evidenceJson };
}

function defaultEvidence(kind: EffectKind): NonNullable<MissionEffectRequirement['evidence']> {
  if (kind === 'channel_delivery') return 'provider_acknowledgement';
  if (kind === 'schedule') return 'schedule_receipt';
  if (kind === 'data_mutation' || kind === 'subject_update') return 'mutation_receipt';
  return 'receipt';
}

function validReceipt(requirement: MissionEffectRequirement, receipt: EffectReceipt): boolean {
  if (receipt.kind !== requirement.kind) return false;
  if (requirement.targetRef && receipt.resourceId && receipt.resourceId !== requirement.targetRef) return false;
  return requirement.kind !== 'channel_delivery' || receipt.acknowledged;
}

function requirementsSatisfied(requirements: MissionEffectRequirement[], receipts: EffectReceipt[]): boolean {
  const used = new Set<string>();
  for (const requirement of requirements) {
    const candidates = receipts.filter((receipt) => !used.has(receipt.id)
      && validReceipt(requirement, receipt)
      && (!receipt.requirementId || receipt.requirementId === requirement.id));
    const needed = requirement.minimum ?? 1;
    if (candidates.length < needed) return false;
    for (const receipt of candidates.slice(0, needed)) used.add(receipt.id);
  }
  return true;
}

function nextUnverifiedRequirement(mission: AgentMission, kind: EffectKind): MissionEffectRequirement | null {
  const receipts = mission.receipts ?? [];
  return mission.outcomeContract.requiredEffects.find((requirement) => {
    if (requirement.kind !== kind) return false;
    const count = receipts.filter((receipt) => validReceipt(requirement, receipt)
      && receipt.requirementId === requirement.id).length;
    return count < (requirement.minimum ?? 1);
  }) ?? null;
}

function normalizeExecutionPlan(plan: ExecutionPlan, contract: MissionOutcomeContract): ExecutionPlan {
  const knownRequirements = new Set(contract.requiredEffects.map((requirement) => requirement.id).filter(Boolean));
  const knownSteps = new Set(plan.steps.map((step) => step.id));
  return {
    version: Math.max(1, plan.version),
    steps: plan.steps.map((step, index) => ({
      ...step,
      id: step.id.trim() || `step-${index + 1}`,
      status: step.status ?? (index === 0 ? 'ready' : 'pending'),
      dependsOn: (step.dependsOn ?? []).filter((id) => knownSteps.has(id)),
      effectRequirementIds: (step.effectRequirementIds ?? []).filter((id) => knownRequirements.has(id)),
    })),
  };
}

function reconcileExecutionPlan(
  plan: ExecutionPlan,
  contract: MissionOutcomeContract,
  receipts: EffectReceipt[],
): ExecutionPlan {
  const verifiedRequirements = new Set(contract.requiredEffects
    .filter((requirement) => requirementsSatisfied([requirement], receipts))
    .map((requirement) => requirement.id));
  const verifiedSteps = new Set(plan.steps.filter((step) => step.status === 'verified').map((step) => step.id));
  for (const step of plan.steps) {
    const requirements = step.effectRequirementIds ?? contract.requiredEffects
      .filter((requirement) => requirement.planStepId === step.id).map((requirement) => requirement.id!);
    if (requirements.length > 0 && requirements.every((id) => verifiedRequirements.has(id))) verifiedSteps.add(step.id);
  }
  // If a downstream effect is already proven, its observational/decision
  // prerequisites cannot remain the current executable step. Mark those
  // ancestors complete so recovery advances to the first genuinely missing
  // commitment instead of re-reading the inbox on every wake.
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const step of plan.steps) {
      if (!verifiedSteps.has(step.id)) continue;
      for (const dependency of step.dependsOn ?? []) {
        const dependencyStep = plan.steps.find((candidate) => candidate.id === dependency);
        // A proven effect implies its observation/decision prerequisites already
        // happened, but never proves another ordered effect. Otherwise a PDF
        // receipt could incorrectly mark the preceding sticker as delivered.
        if (dependencyStep?.kind === 'effect') continue;
        if (!verifiedSteps.has(dependency)) { verifiedSteps.add(dependency); expanded = true; }
      }
    }
  }
  const steps = plan.steps.map((step) => {
    const requirements = step.effectRequirementIds ?? contract.requiredEffects
      .filter((requirement) => requirement.planStepId === step.id).map((requirement) => requirement.id!);
    const effectsVerified = requirements.length > 0 && requirements.every((id) => verifiedRequirements.has(id));
    if (effectsVerified || verifiedSteps.has(step.id)) {
      return { ...step, status: 'verified' as const, finishedAt: step.finishedAt ?? new Date().toISOString() };
    }
    const dependenciesReady = (step.dependsOn ?? []).every((id) => verifiedSteps.has(id));
    return {
      ...step,
      status: dependenciesReady && (step.status === 'pending' || step.status == null)
        ? 'ready' as const
        : step.status ?? 'pending' as const,
    };
  });
  return { ...plan, steps };
}

function nextExecutableStep(plan: ExecutionPlan): ExecutionPlan['steps'][number] | null {
  return plan.steps.find((step) => step.status === 'executing' || step.status === 'ready')
    ?? plan.steps.find((step) => step.status === 'waiting')
    ?? null;
}
