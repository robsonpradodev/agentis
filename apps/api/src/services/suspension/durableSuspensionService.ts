import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import type {
  DurableSuspension,
  SuspensionAudience,
  SuspensionCondition,
  SuspensionOrigin,
  SuspensionResolution,
  SuspensionToolResult,
} from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../../logger.js';

type SuspensionRow = typeof schema.durableSuspensions.$inferSelect;

export interface SuspensionPresentation {
  ref?: string | null;
}

/** One adapter per condition type. It may route by audience internally. */
export interface SuspensionPresenter {
  present(suspension: DurableSuspension): Promise<SuspensionPresentation>;
  cancel?(suspension: DurableSuspension, reason: string): Promise<void>;
}

/** One adapter per continuation origin type. */
export interface SuspensionResumer {
  resume(suspension: DurableSuspension, continuation: Record<string, unknown> | null): Promise<void>;
}

export interface CreateSuspensionArgs {
  workspaceId: string;
  ownerAgentId?: string | null;
  requesterUserId?: string | null;
  origin: SuspensionOrigin;
  condition: SuspensionCondition;
  audience: SuspensionAudience;
  reason: string;
  publicReceipt?: string | null;
  correlationKey?: string;
  continuation?: Record<string, unknown> | null;
  expiresAt?: string | null;
}

export interface ResolveSuspensionArgs {
  workspaceId: string;
  suspensionId: string;
  resolution: Omit<SuspensionResolution, 'resolvedAt'> & { resolvedAt?: string };
}

/**
 * Generic persistence and dispatch kernel for "stop now, continue when X".
 *
 * This class knows nothing about operators, approvals, chat, channels, or
 * workflows. Condition presenters and origin resumers are registered at the
 * composition root. That makes human input, an event, a timer, a webhook, a
 * resource transition, or a plugin-defined signal the same durable lifecycle.
 */
export class DurableSuspensionService {
  readonly #presenters = new Map<string, SuspensionPresenter>();
  readonly #resumers = new Map<string, SuspensionResumer>();

  constructor(private readonly deps: { db: AgentisSqliteDb; logger: Logger }) {}

  registerPresenter(conditionType: string, presenter: SuspensionPresenter): void {
    const type = required(conditionType, 'condition type');
    if (this.#presenters.has(type)) throw new Error(`suspension presenter already registered for ${type}`);
    this.#presenters.set(type, presenter);
  }

  registerResumer(originType: string, resumer: SuspensionResumer): void {
    const type = required(originType, 'origin type');
    if (this.#resumers.has(type)) throw new Error(`suspension resumer already registered for ${type}`);
    this.#resumers.set(type, resumer);
  }

  canResumeOrigin(originType: string): boolean {
    return this.#resumers.has(originType.trim());
  }

  capabilities(): { conditionTypes: string[]; resumableOriginTypes: string[] } {
    return {
      conditionTypes: [...this.#presenters.keys()].sort(),
      resumableOriginTypes: [...this.#resumers.keys()].sort(),
    };
  }

  /**
   * Replay-safe suspend operation. A restarted origin first consumes its oldest
   * ready resolution; a repeated pre-resolution call returns the existing wait.
   */
  async suspend(args: CreateSuspensionArgs): Promise<SuspensionToolResult> {
    const origin = normalizeOrigin(args.origin);
    const ready = this.#oldest(args.workspaceId, origin, args.ownerAgentId ?? null, ['ready']);
    if (ready) return this.#consume(ready);

    const correlationKey = clean(args.correlationKey, 240)
      || `${args.condition.type}:${stableKey(args.condition.payload)}`;
    const existing = this.deps.db.select().from(schema.durableSuspensions).where(and(
      eq(schema.durableSuspensions.workspaceId, args.workspaceId),
      eq(schema.durableSuspensions.originType, origin.type),
      eq(schema.durableSuspensions.originId, origin.id),
      eq(schema.durableSuspensions.correlationKey, correlationKey),
    )).get();
    if (existing) return this.#result(existing);

    const condition = normalizeCondition(args.condition);
    const audience = normalizeAudience(args.audience);
    const presenter = this.#presenters.get(condition.type);
    if (!presenter) throw new Error(`no suspension presenter is registered for condition '${condition.type}'`);

    const now = new Date().toISOString();
    const id = randomUUID();
    this.deps.db.insert(schema.durableSuspensions).values({
      id,
      workspaceId: args.workspaceId,
      ownerAgentId: args.ownerAgentId ?? null,
      requesterUserId: args.requesterUserId ?? null,
      originType: origin.type,
      originId: origin.id,
      originMetadataJson: origin.metadata ?? {},
      conditionType: condition.type,
      conditionJson: condition.payload,
      audienceType: audience.type,
      audienceTarget: audience.target ?? null,
      audienceMetadataJson: audience.metadata ?? {},
      state: 'presenting',
      reason: required(args.reason, 'suspension reason').slice(0, 8_000),
      publicReceipt: clean(args.publicReceipt, 2_000) || null,
      correlationKey,
      continuationJson: args.continuation ?? null,
      expiresAt: normalizeFutureDate(args.expiresAt),
      createdAt: now,
      updatedAt: now,
    }).run();

    let presentation: SuspensionPresentation;
    try {
      presentation = await presenter.present(this.get(args.workspaceId, id)!);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.db.update(schema.durableSuspensions).set({ state: 'failed', error: message, updatedAt: new Date().toISOString() })
        .where(eq(schema.durableSuspensions.id, id)).run();
      throw error;
    }
    this.deps.db.update(schema.durableSuspensions).set({
      state: 'waiting',
      presentationRef: presentation.ref ?? null,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.durableSuspensions.id, id)).run();
    return this.#result(this.#row(args.workspaceId, id)!);
  }

  async resolve(args: ResolveSuspensionArgs): Promise<DurableSuspension> {
    const row = this.#row(args.workspaceId, args.suspensionId);
    if (!row) throw new Error('suspension not found');
    if (row.state === 'ready' || row.state === 'resumed') return toPublic(row);
    if (row.state !== 'waiting') throw new Error(`suspension is ${row.state}, not waiting`);
    const resolvedAt = normalizeDate(args.resolution.resolvedAt) ?? new Date().toISOString();
    const resolution: SuspensionResolution = {
      kind: required(args.resolution.kind, 'resolution kind'),
      data: args.resolution.data,
      ...(args.resolution.principal ? { principal: args.resolution.principal } : {}),
      resolvedAt,
    };
    this.deps.db.update(schema.durableSuspensions).set({
      state: 'ready', resolutionJson: resolution, resolvedAt, updatedAt: resolvedAt, error: null,
    }).where(eq(schema.durableSuspensions.id, row.id)).run();
    const ready = this.#row(args.workspaceId, row.id)!;
    await this.#presenters.get(row.conditionType)?.cancel?.(toPublic(ready), 'condition resolved').catch((error) => {
      this.deps.logger.warn('suspension.presentation_settle_failed', { suspensionId: row.id, error: (error as Error).message });
    });
    await this.#wake(ready);
    return toPublic(ready);
  }

  async cancel(workspaceId: string, suspensionId: string, reason = 'cancelled'): Promise<DurableSuspension> {
    const row = this.#row(workspaceId, suspensionId);
    if (!row) throw new Error('suspension not found');
    if (!['presenting', 'waiting', 'ready'].includes(row.state)) return toPublic(row);
    const now = new Date().toISOString();
    this.deps.db.update(schema.durableSuspensions).set({ state: 'cancelled', error: clean(reason, 2_000), updatedAt: now })
      .where(eq(schema.durableSuspensions.id, row.id)).run();
    const cancelled = this.#row(workspaceId, row.id)!;
    await this.#presenters.get(row.conditionType)?.cancel?.(toPublic(cancelled), reason).catch((error) => {
      this.deps.logger.warn('suspension.presentation_cancel_failed', { suspensionId, error: (error as Error).message });
    });
    return toPublic(cancelled);
  }

  async cancelOrigin(workspaceId: string, origin: SuspensionOrigin, reason = 'origin cancelled'): Promise<number> {
    const normalized = normalizeOrigin(origin);
    const rows = this.deps.db.select().from(schema.durableSuspensions).where(and(
      eq(schema.durableSuspensions.workspaceId, workspaceId),
      eq(schema.durableSuspensions.originType, normalized.type),
      eq(schema.durableSuspensions.originId, normalized.id),
      inArray(schema.durableSuspensions.state, ['presenting', 'waiting', 'ready']),
    )).all();
    for (const row of rows) await this.cancel(workspaceId, row.id, reason);
    return rows.length;
  }

  /** Expire due waits and re-dispatch ready continuations after a process restart. */
  async recover(): Promise<{ expired: number; resumed: number }> {
    const now = new Date().toISOString();
    const expired = this.deps.db.select().from(schema.durableSuspensions).where(and(
      eq(schema.durableSuspensions.state, 'waiting'),
      lte(schema.durableSuspensions.expiresAt, now),
    )).all().filter((row) => Boolean(row.expiresAt));
    for (const row of expired) {
      this.deps.db.update(schema.durableSuspensions).set({ state: 'expired', updatedAt: now, error: 'suspension expired' })
        .where(eq(schema.durableSuspensions.id, row.id)).run();
      const current = this.#row(row.workspaceId, row.id)!;
      await this.#presenters.get(row.conditionType)?.cancel?.(toPublic(current), 'suspension expired').catch((error) => {
        this.deps.logger.warn('suspension.presentation_expire_failed', { suspensionId: row.id, error: (error as Error).message });
      });
    }
    const ready = this.deps.db.select().from(schema.durableSuspensions).where(eq(schema.durableSuspensions.state, 'ready')).all();
    for (const row of ready) await this.#wake(row);
    return { expired: expired.length, resumed: ready.length };
  }

  get(workspaceId: string, suspensionId: string): DurableSuspension | null {
    const row = this.#row(workspaceId, suspensionId);
    return row ? toPublic(row) : null;
  }

  waitingForOrigin(workspaceId: string, origin: SuspensionOrigin): DurableSuspension | null {
    const normalized = normalizeOrigin(origin);
    const row = this.deps.db.select().from(schema.durableSuspensions).where(and(
      eq(schema.durableSuspensions.workspaceId, workspaceId),
      eq(schema.durableSuspensions.originType, normalized.type),
      eq(schema.durableSuspensions.originId, normalized.id),
      inArray(schema.durableSuspensions.state, ['presenting', 'waiting']),
    )).orderBy(asc(schema.durableSuspensions.createdAt)).get();
    return row ? toPublic(row) : null;
  }

  list(workspaceId: string, states?: string[]): DurableSuspension[] {
    const rows = states?.length
      ? this.deps.db.select().from(schema.durableSuspensions).where(and(
          eq(schema.durableSuspensions.workspaceId, workspaceId),
          inArray(schema.durableSuspensions.state, states),
        )).orderBy(asc(schema.durableSuspensions.createdAt)).all()
      : this.deps.db.select().from(schema.durableSuspensions)
          .where(eq(schema.durableSuspensions.workspaceId, workspaceId))
          .orderBy(asc(schema.durableSuspensions.createdAt)).all();
    return rows.map(toPublic);
  }

  #consume(row: SuspensionRow): SuspensionToolResult {
    const now = new Date().toISOString();
    this.deps.db.update(schema.durableSuspensions).set({ state: 'resumed', resumedAt: now, updatedAt: now })
      .where(eq(schema.durableSuspensions.id, row.id)).run();
    return this.#result({ ...row, state: 'resumed', resumedAt: now, updatedAt: now });
  }

  #result(row: SuspensionRow): SuspensionToolResult {
    const resolution = asResolution(row.resolutionJson);
    const state = row.state === 'ready' || row.state === 'resumed'
      ? 'resolved'
      : row.state === 'cancelled' ? 'cancelled'
        : row.state === 'expired' ? 'expired'
          : row.state === 'failed' ? 'failed'
            : 'waiting';
    return {
      suspension: true,
      suspensionId: row.id,
      state,
      ...(row.publicReceipt ? { publicReceipt: row.publicReceipt } : {}),
      ...(resolution ? { resolution } : {}),
    };
  }

  async #wake(row: SuspensionRow): Promise<void> {
    const resumer = this.#resumers.get(row.originType);
    if (!resumer) return;
    try {
      await resumer.resume(toPublic(row), asRecord(row.continuationJson));
    } catch (error) {
      this.deps.logger.warn('suspension.resume_dispatch_failed', {
        suspensionId: row.id,
        originType: row.originType,
        originId: row.originId,
        error: (error as Error).message,
      });
    }
  }

  #oldest(workspaceId: string, origin: SuspensionOrigin, ownerAgentId: string | null, states: string[]): SuspensionRow | null {
    const rows = this.deps.db.select().from(schema.durableSuspensions).where(and(
      eq(schema.durableSuspensions.workspaceId, workspaceId),
      eq(schema.durableSuspensions.originType, origin.type),
      eq(schema.durableSuspensions.originId, origin.id),
      inArray(schema.durableSuspensions.state, states),
    )).orderBy(asc(schema.durableSuspensions.createdAt)).all();
    return rows.find((row) => !ownerAgentId || row.ownerAgentId === ownerAgentId) ?? null;
  }

  #row(workspaceId: string, id: string): SuspensionRow | null {
    return this.deps.db.select().from(schema.durableSuspensions).where(and(
      eq(schema.durableSuspensions.workspaceId, workspaceId),
      eq(schema.durableSuspensions.id, id),
    )).get() ?? null;
  }
}

function toPublic(row: SuspensionRow): DurableSuspension {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ownerAgentId: row.ownerAgentId,
    requesterUserId: row.requesterUserId,
    origin: { type: row.originType, id: row.originId, metadata: asRecord(row.originMetadataJson) ?? {} },
    condition: { type: row.conditionType, payload: asRecord(row.conditionJson) ?? {} },
    audience: {
      type: row.audienceType,
      target: row.audienceTarget,
      metadata: asRecord(row.audienceMetadataJson) ?? {},
    },
    state: row.state as DurableSuspension['state'],
    reason: row.reason,
    publicReceipt: row.publicReceipt,
    correlationKey: row.correlationKey,
    presentationRef: row.presentationRef,
    resolution: asResolution(row.resolutionJson),
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolvedAt: row.resolvedAt,
    resumedAt: row.resumedAt,
  };
}

function normalizeOrigin(value: SuspensionOrigin): SuspensionOrigin {
  return { type: required(value.type, 'origin type'), id: required(value.id, 'origin id'), metadata: value.metadata ?? {} };
}

function normalizeCondition(value: SuspensionCondition): SuspensionCondition {
  return { type: required(value.type, 'condition type'), payload: asRecord(value.payload) ?? {} };
}

function normalizeAudience(value: SuspensionAudience): SuspensionAudience {
  return { type: required(value.type, 'audience type'), target: clean(value.target, 500) || null, metadata: value.metadata ?? {} };
}

function normalizeFutureDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = normalizeDate(value);
  if (!parsed) throw new Error('expiresAt must be an ISO date');
  if (Date.parse(parsed) <= Date.now()) throw new Error('expiresAt must be in the future');
  return parsed;
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function asResolution(value: unknown): SuspensionResolution | null {
  const row = asRecord(value);
  if (!row || typeof row.kind !== 'string' || typeof row.resolvedAt !== 'string') return null;
  return {
    kind: row.kind,
    data: row.data,
    ...(asRecord(row.principal) ? { principal: row.principal as SuspensionResolution['principal'] } : {}),
    resolvedAt: row.resolvedAt,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function required(value: unknown, label: string): string {
  const normalized = clean(value, 500);
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max) : '';
}

function stableKey(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const row = asRecord(value);
  if (!row) return value;
  return Object.fromEntries(Object.keys(row).sort().map((key) => [key, canonical(row[key])]));
}
