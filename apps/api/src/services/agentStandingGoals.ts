import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { AgentisError, type AgentStandingGoal, type AgentStandingGoalPolicy } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';

const DEFAULT_EVENTS = ['lead.created', 'channel.inbound', 'approval.resolved', 'channel.action.settled', 'workflow.failed', 'subject.action.due'];

export class AgentStandingGoalService {
  constructor(private readonly db: AgentisSqliteDb) {}

  list(workspaceId: string, agentId: string): AgentStandingGoal[] {
    return this.db.select().from(schema.agentStandingGoals).where(and(
      eq(schema.agentStandingGoals.workspaceId, workspaceId), eq(schema.agentStandingGoals.agentId, agentId),
    )).orderBy(desc(schema.agentStandingGoals.updatedAt)).all().map(present);
  }

  inspect(workspaceId: string, agentId: string, goalId: string): AgentStandingGoal {
    return this.#get(workspaceId, agentId, goalId);
  }

  /** Review exactly what compilation added before activation. Ordinary wakes
   * consume the compiled objective/policy and never reinterpret source prose. */
  reviewDiff(workspaceId: string, agentId: string, goalId: string) {
    const goal = this.#get(workspaceId, agentId, goalId);
    return {
      goalId: goal.id,
      version: goal.version,
      source: { instructions: goal.sourceInstructions },
      compiled: { objective: goal.objective, policy: goal.policy },
      changes: [
        { field: 'objective', before: goal.sourceInstructions, after: goal.objective, changed: goal.sourceInstructions !== goal.objective },
        ...Object.entries(goal.policy).map(([field, after]) => ({ field: `policy.${field}`, before: null, after, changed: true })),
      ],
    };
  }

  compile(input: { workspaceId: string; agentId: string; instructions: string; title?: string; policy?: Partial<AgentStandingGoalPolicy> }): AgentStandingGoal {
    const source = input.instructions.trim();
    if (!source) throw new AgentisError('VALIDATION_FAILED', 'Standing goal instructions are required.');
    const agent = this.db.select({ id: schema.agents.id }).from(schema.agents).where(and(
      eq(schema.agents.workspaceId, input.workspaceId), eq(schema.agents.id, input.agentId),
    )).get();
    if (!agent) throw new AgentisError('RESOURCE_NOT_FOUND', `agent ${input.agentId} not found`);
    const now = new Date().toISOString();
    const firstLine = source.split(/\r?\n/)[0]!.slice(0, 100);
    const policy = compilePolicy(input.policy);
    const row = {
      id: randomUUID(), workspaceId: input.workspaceId, agentId: input.agentId,
      title: input.title?.trim() || firstLine || 'Standing goal', objective: source,
      sourceInstructions: source, status: 'draft', version: 1, policyJson: policy,
      activatedAt: null, pausedAt: null, createdAt: now, updatedAt: now,
    };
    this.db.insert(schema.agentStandingGoals).values(row).run();
    return present(row);
  }

  revise(input: {
    workspaceId: string;
    agentId: string;
    goalId: string;
    instructions?: string;
    title?: string;
    policy?: Partial<AgentStandingGoalPolicy>;
  }): AgentStandingGoal {
    const goal = this.#get(input.workspaceId, input.agentId, input.goalId);
    if (goal.status === 'active') {
      throw new AgentisError('RESOURCE_CONFLICT', 'Pause this standing goal before editing it. Active policy cannot change silently.');
    }
    const source = input.instructions === undefined ? goal.sourceInstructions : input.instructions.trim();
    if (!source) throw new AgentisError('VALIDATION_FAILED', 'Standing goal instructions are required.');
    const title = input.title === undefined ? goal.title : input.title.trim();
    if (!title) throw new AgentisError('VALIDATION_FAILED', 'Standing goal title is required.');
    const now = new Date().toISOString();
    const policy = compilePolicy(input.policy, goal.policy);
    this.db.update(schema.agentStandingGoals).set({
      title,
      objective: source,
      sourceInstructions: source,
      policyJson: policy,
      status: 'draft',
      version: goal.version + 1,
      activatedAt: null,
      pausedAt: null,
      updatedAt: now,
    }).where(and(
      eq(schema.agentStandingGoals.workspaceId, input.workspaceId),
      eq(schema.agentStandingGoals.agentId, input.agentId),
      eq(schema.agentStandingGoals.id, input.goalId),
    )).run();
    return this.#get(input.workspaceId, input.agentId, input.goalId);
  }

  activate(workspaceId: string, agentId: string, goalId: string): AgentStandingGoal {
    const goal = this.#get(workspaceId, agentId, goalId);
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.update(schema.agentStandingGoals).set({ status: 'active', activatedAt: now, pausedAt: null, updatedAt: now })
        .where(eq(schema.agentStandingGoals.id, goalId)).run();
      const agent = this.db.select({ config: schema.agents.config }).from(schema.agents).where(eq(schema.agents.id, agentId)).get()!;
      const config = record(agent.config);
      const residency = record(config.residency);
      const activeGoalIds = [...new Set([...(stringArray(residency.activeGoalIds)), goalId])];
      this.db.update(schema.agents).set({ config: { ...config, residency: {
        ...residency, enabled: true, activeGoalIds,
        intervalMinutes: Math.min(numberOr(residency.intervalMinutes, goal.policy.reconciliationIntervalMinutes), goal.policy.reconciliationIntervalMinutes),
      } }, updatedAt: now }).where(eq(schema.agents.id, agentId)).run();
    });
    return this.#get(workspaceId, agentId, goalId);
  }

  pause(workspaceId: string, agentId: string, goalId: string): AgentStandingGoal {
    this.#get(workspaceId, agentId, goalId);
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.update(schema.agentStandingGoals).set({ status: 'paused', pausedAt: now, updatedAt: now })
        .where(eq(schema.agentStandingGoals.id, goalId)).run();
      const agent = this.db.select({ config: schema.agents.config }).from(schema.agents).where(eq(schema.agents.id, agentId)).get()!;
      const config = record(agent.config); const residency = record(config.residency);
      const activeGoalIds = stringArray(residency.activeGoalIds).filter((id) => id !== goalId);
      this.db.update(schema.agents).set({ config: { ...config, residency: { ...residency, enabled: activeGoalIds.length > 0, activeGoalIds } }, updatedAt: now })
        .where(eq(schema.agents.id, agentId)).run();
    });
    return this.#get(workspaceId, agentId, goalId);
  }

  #get(workspaceId: string, agentId: string, goalId: string): AgentStandingGoal {
    const row = this.db.select().from(schema.agentStandingGoals).where(and(
      eq(schema.agentStandingGoals.workspaceId, workspaceId), eq(schema.agentStandingGoals.agentId, agentId), eq(schema.agentStandingGoals.id, goalId),
    )).get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `standing goal ${goalId} not found`);
    return present(row);
  }
}

function present(row: typeof schema.agentStandingGoals.$inferSelect): AgentStandingGoal {
  return { ...row, status: row.status as AgentStandingGoal['status'], policy: row.policyJson as AgentStandingGoalPolicy };
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []; }
function numberOr(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
function clampInterval(value: unknown): number { return Math.max(1, Math.min(1440, numberOr(value, 15))); }
function compilePolicy(input?: Partial<AgentStandingGoalPolicy>, base?: AgentStandingGoalPolicy): AgentStandingGoalPolicy {
  return {
    appIds: input?.appIds ?? base?.appIds ?? [],
    connectionIds: input?.connectionIds ?? base?.connectionIds ?? [],
    capabilities: input?.capabilities ?? base?.capabilities ?? [],
    actionCategories: input?.actionCategories ?? base?.actionCategories ?? ['external_read', 'external_mutation', 'proactive_followup'],
    eventWakes: input?.eventWakes ?? base?.eventWakes ?? DEFAULT_EVENTS,
    reconciliationIntervalMinutes: clampInterval(input?.reconciliationIntervalMinutes ?? base?.reconciliationIntervalMinutes),
    quietHours: input?.quietHours === undefined ? base?.quietHours ?? null : input.quietHours,
    maxActionsPerHour: input?.maxActionsPerHour === undefined ? base?.maxActionsPerHour ?? null : input.maxActionsPerHour,
    suppressionEnabled: input?.suppressionEnabled ?? base?.suppressionEnabled ?? true,
    respectHumanHandoff: input?.respectHumanHandoff ?? base?.respectHumanHandoff ?? true,
    ownerNotifications: input?.ownerNotifications ?? base?.ownerNotifications ?? 'material_and_blockers',
  };
}
