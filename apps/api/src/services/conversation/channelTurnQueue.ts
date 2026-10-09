/**
 * ChannelTurnQueue — durable, restart-safe inbound channel turns (Living Apps
 * Phase 5 / G2).
 *
 * Before this, `ChannelBridge.handleInbound` fired the dispatcher
 * fire-and-forget (`void this.#turnDispatcher.dispatch(...)`): one process, no
 * backpressure, no resumption. A 24/7 desk with many concurrent threads dropped
 * every in-flight turn on a restart. This worker makes a channel turn a durable,
 * at-least-once job backed by the `channel_turn_queue` table:
 *
 *   - `enqueue()` inserts a `pending` row (idempotent on the inbound message id)
 *     and returns immediately — the webhook still gets its fast ack.
 *   - A background poller claims `pending` rows whose backoff has elapsed, marks
 *     them `processing` (CAS claim), and runs the turn through the dispatcher's
 *     existing path.
 *   - Per-conversation concurrency = 1 (turns for one thread run serially, in
 *     order) and a per-App in-flight cap so one busy App can't starve others.
 *   - A crash mid-flight leaves a `processing` row; its lease expires and the
 *     poller re-picks it (resume on restart) — bounded by an attempt cap, with
 *     backoff between retries, then parked `failed`.
 *   - A completed turn is marked `done` and never re-run.
 *
 * Pattern mirrors `CognitivePromotionQueueWorker` (the established durable-queue
 * pattern in this repo) rather than inventing a new one — claim-with-CAS, lease
 * reclaim, attempt cap + backoff, per-bucket concurrency. The dispatcher's
 * external contract (`dispatch`) is unchanged; this is additive and only active
 * when wired + enabled.
 */

import { randomUUID } from 'node:crypto';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../../logger.js';
import type { ChannelTurnInput } from './channelTurnDispatcher.js';

/** The dispatcher seam the worker drives. `runQueued` runs ONE turn to completion. */
export interface ChannelTurnRunner {
  runQueued(input: ChannelTurnInput): Promise<{ replied: boolean; reason?: string }>;
}

export interface ChannelTurnQueueDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  /** The dispatcher (or a stub). Set after construction to break the wiring cycle. */
  runner?: ChannelTurnRunner;
  /** Poll cadence in ms (default 1000 — channels want low latency). */
  pollIntervalMs?: number;
  /** Lease duration before a `processing` row is reclaimed as crashed (default 5 min). */
  leaseMs?: number;
  /** Max attempts before a turn is parked `failed` (default 4). */
  maxAttempts?: number;
  /** Max turns processed concurrently for one App (default 4). NULL App = the bare-agent bucket. */
  maxConcurrentPerApp?: number;
  /** Rows claimed per poll tick (default 25). */
  claimBatch?: number;
}

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_MAX_PER_APP = 4;
const DEFAULT_CLAIM_BATCH = 25;
const BARE_AGENT_BUCKET = '__bare__';

export class ChannelTurnQueue {
  #timer: ReturnType<typeof setInterval> | undefined;
  #polling = false;
  /** In-flight count per App bucket (per-App concurrency cap). */
  readonly #activeByApp = new Map<string, number>();
  /** Conversations with a turn in flight — at most one runs at a time (ordering). */
  readonly #activeConversations = new Set<string>();
  #runner: ChannelTurnRunner | undefined;
  readonly #pollIntervalMs: number;
  readonly #leaseMs: number;
  readonly #maxAttempts: number;
  readonly #maxPerApp: number;
  readonly #claimBatch: number;

  constructor(private readonly deps: ChannelTurnQueueDeps) {
    this.#runner = deps.runner;
    this.#pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.#leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
    this.#maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#maxPerApp = deps.maxConcurrentPerApp ?? DEFAULT_MAX_PER_APP;
    this.#claimBatch = deps.claimBatch ?? DEFAULT_CLAIM_BATCH;
  }

  /** Wire the dispatcher after construction (breaks the queue↔dispatcher cycle). */
  setRunner(runner: ChannelTurnRunner): void {
    this.#runner = runner;
  }

  /**
   * Enqueue an inbound turn. Idempotent on `dedupKey` (the inbound message id):
   * a redelivered webhook never doubles a turn. Returns the queue row id, or the
   * existing row id if this message was already enqueued. Never throws — a queue
   * failure must not lose the turn silently, so it logs and returns null (the
   * caller falls back to running inline).
   */
  enqueue(input: ChannelTurnInput): string | null {
    const dedupKey = input.inboundMessageId ?? null;
    try {
      // Idempotency: if this inbound message already has a queue row, reuse it.
      if (dedupKey) {
        const existing = this.deps.db
          .select({ id: schema.channelTurnQueue.id })
          .from(schema.channelTurnQueue)
          .where(eq(schema.channelTurnQueue.dedupKey, dedupKey))
          .get();
        if (existing) return existing.id;
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      this.deps.db
        .insert(schema.channelTurnQueue)
        .values({
          id,
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          appId: input.appId ?? null,
          dedupKey,
          payload: input as unknown as Record<string, unknown>,
          status: 'pending',
          attempts: 0,
          scheduledFor: now,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      // Nudge the poller so latency stays low without waiting for the interval.
      if (this.#timer) void this.poll().catch(() => {});
      return id;
    } catch (err) {
      // A UNIQUE collision (concurrent enqueue of the same message) is benign —
      // the turn is already queued. Any other failure logs but never throws.
      const message = (err as Error).message ?? '';
      if (/unique/i.test(message) && dedupKey) {
        const existing = this.deps.db
          .select({ id: schema.channelTurnQueue.id })
          .from(schema.channelTurnQueue)
          .where(eq(schema.channelTurnQueue.dedupKey, dedupKey))
          .get();
        if (existing) return existing.id;
      }
      this.deps.logger.error('channel_turn_queue.enqueue_failed', {
        conversationId: input.conversationId,
        err: message,
      });
      return null;
    }
  }

  /** Permanently cancel every not-yet-finished turn for a human-owned conversation. */
  cancelConversation(workspaceId: string, conversationId: string): number {
    const now = new Date().toISOString();
    const result = this.deps.db
      .update(schema.channelTurnQueue)
      .set({ status: 'cancelled', leasedAt: null, failReason: 'human_takeover', updatedAt: now })
      .where(and(
        eq(schema.channelTurnQueue.workspaceId, workspaceId),
        eq(schema.channelTurnQueue.conversationId, conversationId),
        sql`${schema.channelTurnQueue.status} in ('pending', 'processing')`,
      ))
      .run();
    return result.changes;
  }

  /** Begin polling. Idempotent. Reclaims crashed leases first (resume on startup). */
  start(): void {
    if (this.#timer) return;
    this.#reclaimExpiredLeases();
    this.#timer = setInterval(() => {
      void this.poll().catch((err) => {
        this.deps.logger.error('channel_turn_queue.poll.unhandled', { err: (err as Error).message });
      });
    }, this.#pollIntervalMs);
    this.#timer.unref?.();
    this.deps.logger.info('channel_turn_queue.started', { intervalMs: this.#pollIntervalMs });
    // Kick an immediate drain so already-pending rows don't wait a full tick.
    void this.poll().catch(() => {});
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Poll once — claim due rows and run them. Exposed for tests and graceful
   * drain. Respects per-conversation serialization and the per-App concurrency
   * cap. Reclaims expired leases each tick so a crashed turn resumes.
   */
  async poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      this.#reclaimExpiredLeases();
      const now = new Date().toISOString();
      const rows = this.deps.db
        .select()
        .from(schema.channelTurnQueue)
        .where(and(eq(schema.channelTurnQueue.status, 'pending'), lte(schema.channelTurnQueue.scheduledFor, now)))
        .orderBy(asc(schema.channelTurnQueue.scheduledFor), asc(schema.channelTurnQueue.createdAt))
        .limit(this.#claimBatch)
        .all();

      const tasks: Promise<void>[] = [];
      for (const row of rows) {
        // Per-conversation ordering: at most one turn per thread in flight.
        if (this.#activeConversations.has(row.conversationId)) continue;
        const bucket = row.appId ?? BARE_AGENT_BUCKET;
        const active = this.#activeByApp.get(bucket) ?? 0;
        if (active >= this.#maxPerApp) continue;

        // CAS claim: only transition pending → processing. A second poll tick
        // (or process) that already grabbed the row loses here.
        const claimedAt = new Date().toISOString();
        const claimed = this.deps.db
          .update(schema.channelTurnQueue)
          .set({
            status: 'processing',
            attempts: sql`${schema.channelTurnQueue.attempts} + 1`,
            leasedAt: claimedAt,
            lastAttemptAt: claimedAt,
            updatedAt: claimedAt,
          })
          .where(and(eq(schema.channelTurnQueue.id, row.id), eq(schema.channelTurnQueue.status, 'pending')))
          .run();
        if (claimed.changes === 0) continue;

        this.#activeConversations.add(row.conversationId);
        this.#activeByApp.set(bucket, active + 1);
        tasks.push(
          this.#process({ ...row, attempts: row.attempts + 1 }).finally(() => {
            this.#activeConversations.delete(row.conversationId);
            const count = this.#activeByApp.get(bucket) ?? 1;
            const next = Math.max(0, count - 1);
            if (next === 0) this.#activeByApp.delete(bucket);
            else this.#activeByApp.set(bucket, next);
          }),
        );
      }
      await Promise.allSettled(tasks);
    } catch (err) {
      this.deps.logger.warn('channel_turn_queue.poll_failed', { err: (err as Error).message });
    } finally {
      this.#polling = false;
    }
  }

  // ────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────

  async #process(row: typeof schema.channelTurnQueue.$inferSelect): Promise<void> {
    const now = new Date().toISOString();
    if (!this.#runner) {
      // No runner wired — release the claim so a later tick (with a runner) retries.
      this.deps.db
        .update(schema.channelTurnQueue)
        .set({ status: 'pending', leasedAt: null, updatedAt: now })
        .where(eq(schema.channelTurnQueue.id, row.id))
        .run();
      this.deps.logger.warn('channel_turn_queue.no_runner', { id: row.id });
      return;
    }
    try {
      const input = row.payload as unknown as ChannelTurnInput;
      const result = await this.#runner.runQueued(input);
      // Policy silence and supersession are terminal by design. An empty model
      // result or unavailable adapter is not: marking either "done" loses the
      // customer's message with no visible outcome.
      if (!result.replied && (['empty_reply', 'no_chat_adapter', 'delivery_retry', 'delivery_pending', 'delivery_failed'].includes(result.reason ?? ''))) {
        throw new Error(`retryable channel turn outcome: ${result.reason}`);
      }
      // Success — the turn (incl. its own error→user-notify path) ran exactly once.
      this.deps.db
        .update(schema.channelTurnQueue)
        .set({ status: 'done', leasedAt: null, updatedAt: new Date().toISOString() })
        .where(and(eq(schema.channelTurnQueue.id, row.id), eq(schema.channelTurnQueue.status, 'processing')))
        .run();
    } catch (err) {
      const failedAt = new Date().toISOString();
      const terminal = row.attempts >= this.#maxAttempts;
      // Exponential backoff: 2s, 8s, 18s ... (attempts² × 2s).
      const backoffMs = row.attempts * row.attempts * 2_000;
      this.deps.db
        .update(schema.channelTurnQueue)
        .set({
          status: terminal ? 'failed' : 'pending',
          leasedAt: null,
          failReason: (err as Error).message?.slice(0, 500) ?? 'unknown',
          scheduledFor: terminal ? row.scheduledFor : new Date(Date.now() + backoffMs).toISOString(),
          updatedAt: failedAt,
        })
        .where(and(eq(schema.channelTurnQueue.id, row.id), eq(schema.channelTurnQueue.status, 'processing')))
        .run();
      this.deps.logger[terminal ? 'error' : 'warn']('channel_turn_queue.turn_failed', {
        id: row.id,
        conversationId: row.conversationId,
        attempts: row.attempts,
        terminal,
        err: (err as Error).message,
      });
    }
  }

  /**
   * Reset `processing` rows whose lease expired (a crash mid-turn). They return
   * to `pending` and are re-picked — at-least-once resumption. A turn that has
   * exhausted its attempts is parked `failed` instead of looping forever.
   */
  #reclaimExpiredLeases(): void {
    const cutoff = new Date(Date.now() - this.#leaseMs).toISOString();
    const expired = this.deps.db
      .select()
      .from(schema.channelTurnQueue)
      .where(eq(schema.channelTurnQueue.status, 'processing'))
      .all()
      // A row with no lease, or one whose lease is older than the cutoff, is a
      // crashed turn (`= NULL` never matches in SQL, so filter in JS).
      .filter((row) => !row.leasedAt || row.leasedAt <= cutoff);
    for (const row of expired) {
      // Don't double-reclaim a row this process is actively running.
      if (this.#activeConversations.has(row.conversationId)) continue;
      const terminal = row.attempts >= this.#maxAttempts;
      const now = new Date().toISOString();
      this.deps.db
        .update(schema.channelTurnQueue)
        .set({
          status: terminal ? 'failed' : 'pending',
          leasedAt: null,
          failReason: terminal ? (row.failReason ?? 'lease expired after max attempts') : row.failReason,
          updatedAt: now,
        })
        .where(and(eq(schema.channelTurnQueue.id, row.id), eq(schema.channelTurnQueue.status, 'processing')))
        .run();
      this.deps.logger.warn('channel_turn_queue.expired_lease_reclaimed', {
        id: row.id,
        conversationId: row.conversationId,
        attempts: row.attempts,
        terminal,
      });
    }
  }

  /** Inspect a queued turn's state (tests / operator inspection). */
  getStatus(id: string): { status: string; attempts: number; failReason: string | null } | null {
    const row = this.deps.db
      .select()
      .from(schema.channelTurnQueue)
      .where(eq(schema.channelTurnQueue.id, id))
      .get();
    return row ? { status: row.status, attempts: row.attempts, failReason: row.failReason } : null;
  }
}
