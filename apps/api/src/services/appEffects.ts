import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  AgentisError,
  authorityContextSchema,
  effectLevelSchema,
  type AuthorityContext,
  type EffectAuthorizationGrant,
  type EffectLevel,
  type EffectPlan,
} from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AgentMissionService } from './agentMissions.js';

export interface PrepareEffectInput {
  workspaceId: string;
  missionId?: string | null;
  appId?: string | null;
  operationId: string;
  input: unknown;
  targets?: EffectPlan['targets'];
  consequences?: string[];
  reversibility: EffectPlan['reversibility'];
  compensationOperationId?: string | null;
  estimatedCostCents?: { min: number; max: number } | null;
  estimatedLatencyMs?: number | null;
  idempotencyKey: string;
  authorityContext: AuthorityContext;
  approval: 'never' | 'policy' | 'always';
  expiresAt?: string | null;
}

/** Durable prepare → authorize → execute → reconcile → compensate control plane. */
export class AppEffectService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly missions?: AgentMissionService,
  ) {}

  prepare(input: PrepareEffectInput): EffectPlan {
    const authority = authorityContextSchema.parse(input.authorityContext);
    if (authority.workspaceId !== input.workspaceId)
      throw new AgentisError('CROSS_WORKSPACE_ACCESS', 'Authority belongs to another workspace.');
    this.#assertAuthority(authority, input.reversibility, input.estimatedCostCents?.max ?? 0);
    const existing = this.db
      .select()
      .from(schema.effectPlans)
      .where(
        and(
          eq(schema.effectPlans.workspaceId, input.workspaceId),
          eq(schema.effectPlans.operationId, input.operationId),
          eq(schema.effectPlans.idempotencyKey, input.idempotencyKey),
        ),
      )
      .get();
    if (existing) return presentPlan(existing);

    if (input.missionId) this.missions?.inspect(input.workspaceId, input.missionId);
    const id = randomUUID();
    const now = new Date().toISOString();
    const canonical = {
      workspaceId: input.workspaceId,
      missionId: input.missionId ?? null,
      appId: input.appId ?? null,
      operationId: input.operationId,
      input: input.input ?? null,
      targets: input.targets ?? [],
      consequences: input.consequences ?? [],
      reversibility: input.reversibility,
      compensationOperationId: input.compensationOperationId ?? null,
      estimatedCostCents: input.estimatedCostCents ?? null,
      estimatedLatencyMs: input.estimatedLatencyMs ?? null,
      idempotencyKey: input.idempotencyKey,
      authorityContext: authority,
      expiresAt: input.expiresAt ?? null,
    };
    const planHash = sha256(stableJson(canonical));
    const requiresAuthorization =
      input.approval === 'always' ||
      (input.approval === 'policy' &&
        ['compensatable', 'irreversible'].includes(input.reversibility));
    this.db
      .insert(schema.effectPlans)
      .values({
        id,
        workspaceId: input.workspaceId,
        missionId: input.missionId ?? null,
        appId: input.appId ?? null,
        operationId: input.operationId,
        planHash,
        status: requiresAuthorization ? 'awaiting_authorization' : 'authorized',
        inputJson: input.input ?? {},
        targetsJson: input.targets ?? [],
        consequencesJson: input.consequences ?? [],
        reversibility: input.reversibility,
        compensationOperationId: input.compensationOperationId ?? null,
        estimatedCostMinCents: input.estimatedCostCents?.min ?? null,
        estimatedCostMaxCents: input.estimatedCostCents?.max ?? null,
        estimatedLatencyMs: input.estimatedLatencyMs ?? null,
        idempotencyKey: input.idempotencyKey,
        authorityContextJson: authority,
        authorizationGrantId: null,
        resultJson: null,
        lastError: null,
        expiresAt: input.expiresAt ?? null,
        authorizedAt: requiresAuthorization ? null : now,
        executedAt: null,
        reconciledAt: null,
        compensatedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    if (requiresAuthorization && input.missionId) {
      this.missions?.requestApproval(input.workspaceId, input.missionId, {
        id: `effect:${id}`,
        title: `Authorize ${input.operationId}`,
        detail: (input.consequences ?? []).join('\n') || `${input.reversibility} effect`,
        effectPlanId: id,
      });
    }
    return this.get(input.workspaceId, id);
  }

  get(workspaceId: string, id: string): EffectPlan {
    const row = this.db
      .select()
      .from(schema.effectPlans)
      .where(and(eq(schema.effectPlans.workspaceId, workspaceId), eq(schema.effectPlans.id, id)))
      .get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `effect plan ${id} not found`);
    return presentPlan(row);
  }

  list(
    workspaceId: string,
    filters: { missionId?: string; appId?: string; limit?: number } = {},
  ): EffectPlan[] {
    return this.db
      .select()
      .from(schema.effectPlans)
      .where(
        and(
          eq(schema.effectPlans.workspaceId, workspaceId),
          ...(filters.missionId ? [eq(schema.effectPlans.missionId, filters.missionId)] : []),
          ...(filters.appId ? [eq(schema.effectPlans.appId, filters.appId)] : []),
        ),
      )
      .orderBy(desc(schema.effectPlans.createdAt))
      .limit(Math.max(1, Math.min(200, filters.limit ?? 50)))
      .all()
      .map(presentPlan);
  }

  authorize(
    workspaceId: string,
    id: string,
    input: {
      approvedBy: string;
      authorityContext: AuthorityContext;
      scopes?: string[];
      maxEffectLevel?: EffectLevel;
      maxSpendCents?: number | null;
      expiresAt?: string | null;
    },
  ): { plan: EffectPlan; grant: EffectAuthorizationGrant } {
    const plan = this.get(workspaceId, id);
    const authority = authorityContextSchema.parse(input.authorityContext);
    const level = effectLevelSchema.parse(input.maxEffectLevel ?? authority.maxEffectLevel);
    this.#assertAuthority(authority, plan.reversibility, plan.estimatedCostCents?.max ?? 0);
    if (authority.workspaceId !== workspaceId)
      throw new AgentisError('CROSS_WORKSPACE_ACCESS', 'Authority belongs to another workspace.');
    if (plan.expiresAt && plan.expiresAt <= new Date().toISOString())
      throw new AgentisError('RESOURCE_CONFLICT', 'Effect plan has expired.');
    // Authorization is itself idempotent. A client can lose the HTTP response
    // after execution has already started; retrying must never mint another
    // grant or move the effect back to `authorized`.
    if (plan.authorizationGrantId) {
      if (!['authorized', 'executing', 'reconciling', 'completed'].includes(plan.status)) {
        throw new AgentisError(
          'RESOURCE_CONFLICT',
          `An effect in ${plan.status} state cannot be re-authorized.`,
        );
      }
      return {
        plan,
        grant: this.#grant(workspaceId, plan.authorizationGrantId),
      };
    }
    if (plan.status !== 'awaiting_authorization') {
      throw new AgentisError(
        'RESOURCE_CONFLICT',
        `An effect in ${plan.status} state cannot be authorized.`,
      );
    }
    const grantId = randomUUID();
    const now = new Date().toISOString();
    this.db
      .insert(schema.effectAuthorizationGrants)
      .values({
        id: grantId,
        workspaceId,
        effectPlanId: id,
        planHash: plan.planHash,
        authorityContextJson: authority,
        scopesJson: input.scopes ?? authority.scopes,
        maxEffectLevel: level,
        maxSpendCents: input.maxSpendCents ?? authority.maxSpendCents ?? null,
        approvedBy: input.approvedBy,
        expiresAt: input.expiresAt ?? authority.expiresAt ?? null,
        revokedAt: null,
        createdAt: now,
      })
      .run();
    this.db
      .update(schema.effectPlans)
      .set({
        status: 'authorized',
        authorizationGrantId: grantId,
        authorizedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.effectPlans.id, id))
      .run();
    if (plan.missionId) {
      const mission = this.missions?.inspect(workspaceId, plan.missionId);
      const request = mission?.approvalRequests.find(
        (item) => item.effectPlanId === id && item.status === 'pending',
      );
      if (request)
        this.missions?.resolveApproval(
          workspaceId,
          plan.missionId,
          request.id,
          'approved',
          input.approvedBy,
        );
    }
    return { plan: this.get(workspaceId, id), grant: this.#grant(workspaceId, grantId) };
  }

  beginExecution(workspaceId: string, id: string): EffectPlan {
    const plan = this.get(workspaceId, id);
    if (plan.status !== 'authorized')
      throw new AgentisError('AUTH_FORBIDDEN', 'Effect plan is not authorized.');
    this.#assertLiveGrant(plan);
    return this.#update(workspaceId, id, { status: 'executing', lastError: null });
  }

  executed(workspaceId: string, id: string, result: unknown): EffectPlan {
    const plan = this.get(workspaceId, id);
    if (plan.status !== 'executing')
      throw new AgentisError('RESOURCE_CONFLICT', 'Effect is not executing.');
    return this.#update(workspaceId, id, {
      status: 'reconciling',
      resultJson: result ?? {},
      executedAt: new Date().toISOString(),
    });
  }

  reconcile(workspaceId: string, id: string, evidence: unknown): EffectPlan {
    const plan = this.get(workspaceId, id);
    if (!['executing', 'reconciling'].includes(plan.status))
      throw new AgentisError('RESOURCE_CONFLICT', 'Effect is not ready for reconciliation.');
    return this.#update(workspaceId, id, {
      status: 'completed',
      resultJson: { execution: plan.result, reconciliation: evidence },
      reconciledAt: new Date().toISOString(),
    });
  }

  fail(workspaceId: string, id: string, error: unknown): EffectPlan {
    return this.#update(workspaceId, id, {
      status: 'failed',
      lastError: error instanceof Error ? error.message : String(error),
    });
  }

  compensate(workspaceId: string, id: string, result: unknown): EffectPlan {
    const plan = this.get(workspaceId, id);
    if (plan.reversibility !== 'compensatable' || !plan.compensationOperationId) {
      throw new AgentisError(
        'VALIDATION_FAILED',
        'Effect does not declare a compensation operation.',
      );
    }
    if (!['completed', 'failed'].includes(plan.status))
      throw new AgentisError('RESOURCE_CONFLICT', 'Only a settled effect can be compensated.');
    return this.#update(workspaceId, id, {
      status: 'compensated',
      resultJson: { original: plan.result, compensation: result },
      compensatedAt: new Date().toISOString(),
    });
  }

  #assertLiveGrant(plan: EffectPlan): void {
    if (!plan.authorizationGrantId) return;
    const grant = this.#grant(plan.workspaceId, plan.authorizationGrantId);
    if (grant.planHash !== plan.planHash || grant.effectPlanId !== plan.id)
      throw new AgentisError('AUTH_FORBIDDEN', 'Authorization is not bound to this effect plan.');
    if (grant.revokedAt)
      throw new AgentisError('AUTH_FORBIDDEN', 'Authorization has been revoked.');
    if (grant.expiresAt && grant.expiresAt <= new Date().toISOString())
      throw new AgentisError('AUTH_FORBIDDEN', 'Authorization has expired.');
    this.#assertAuthority(
      grant.authorityContext,
      plan.reversibility,
      plan.estimatedCostCents?.max ?? 0,
    );
  }

  #assertAuthority(
    authority: AuthorityContext,
    level: EffectPlan['reversibility'],
    costCents: number,
  ): void {
    const rank: EffectLevel[] = ['read', 'reversible', 'compensatable', 'irreversible'];
    if (rank.indexOf(authority.maxEffectLevel) < rank.indexOf(level))
      throw new AgentisError('AUTH_FORBIDDEN', `Authority does not allow ${level} effects.`);
    if (authority.expiresAt && authority.expiresAt <= new Date().toISOString())
      throw new AgentisError('AUTH_FORBIDDEN', 'Authority has expired.');
    if (authority.maxSpendCents != null && costCents > authority.maxSpendCents)
      throw new AgentisError('AUTH_FORBIDDEN', 'Effect exceeds the delegated spend ceiling.');
  }

  #grant(workspaceId: string, id: string): EffectAuthorizationGrant {
    const row = this.db
      .select()
      .from(schema.effectAuthorizationGrants)
      .where(
        and(
          eq(schema.effectAuthorizationGrants.workspaceId, workspaceId),
          eq(schema.effectAuthorizationGrants.id, id),
        ),
      )
      .get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `authorization grant ${id} not found`);
    const { authorityContextJson, scopesJson, ...grant } = row;
    return {
      ...grant,
      authorityContext: authorityContextSchema.parse(authorityContextJson),
      scopes: scopesJson as string[],
      maxEffectLevel: effectLevelSchema.parse(row.maxEffectLevel),
    };
  }

  #update(
    workspaceId: string,
    id: string,
    patch: Partial<typeof schema.effectPlans.$inferInsert>,
  ): EffectPlan {
    const result = this.db
      .update(schema.effectPlans)
      .set({ ...patch, updatedAt: new Date().toISOString() })
      .where(and(eq(schema.effectPlans.workspaceId, workspaceId), eq(schema.effectPlans.id, id)))
      .run();
    if (result.changes !== 1)
      throw new AgentisError('RESOURCE_NOT_FOUND', `effect plan ${id} not found`);
    return this.get(workspaceId, id);
  }
}

function presentPlan(row: typeof schema.effectPlans.$inferSelect): EffectPlan {
  const { inputJson, targetsJson, consequencesJson, authorityContextJson, resultJson, ...plan } =
    row;
  return {
    ...plan,
    status: row.status as EffectPlan['status'],
    input: inputJson,
    targets: targetsJson as EffectPlan['targets'],
    consequences: consequencesJson as string[],
    reversibility: row.reversibility as EffectPlan['reversibility'],
    estimatedCostCents:
      row.estimatedCostMinCents == null || row.estimatedCostMaxCents == null
        ? null
        : { min: row.estimatedCostMinCents, max: row.estimatedCostMaxCents },
    authorityContext: authorityContextSchema.parse(authorityContextJson),
    result: resultJson,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
