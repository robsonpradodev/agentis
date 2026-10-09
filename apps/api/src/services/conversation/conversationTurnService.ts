import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type {
  ChatExecutionEnvelope,
  ChatContextManifest,
  ChatPermissionMode,
  ConversationExecutionMode,
  ConversationTurnStatus,
  EffectiveConversationExecutionMode,
  ViewportContext,
  TurnEventV2,
} from '@agentis/core';
import { AgentisError } from '@agentis/core';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core/events';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../../logger.js';
import type { EventBus } from '../../event-bus.js';

export type ConversationTurnRow = typeof schema.conversationTurns.$inferSelect;
export type ConversationTurnEventRow = typeof schema.conversationTurnEvents.$inferSelect;

export interface DurableTurnInput {
  workspaceId: string;
  conversationId: string;
  agentId: string;
  userId: string;
  messageId: string;
  clientTurnId: string;
  prompt: string;
  requestedMode: ConversationExecutionMode;
  effectiveMode: EffectiveConversationExecutionMode;
  permissionMode: ChatPermissionMode;
  attachmentIds: string[];
  viewport?: ViewportContext | null;
  contextManifest: ChatContextManifest;
  executionEnvelope: ChatExecutionEnvelope;
  planId?: string | null;
}

export interface DurableTurnExecutionResult {
  status: Extract<ConversationTurnStatus, 'completed' | 'failed' | 'blocked' | 'awaiting_approval' | 'interrupted'>;
  error?: string | null;
}

interface ConversationTurnServiceDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  bus?: EventBus;
  execute: (turn: ConversationTurnRow, sink: DurableTurnEventSink, signal: AbortSignal) => Promise<DurableTurnExecutionResult>;
  onCancel?: (turn: ConversationTurnRow) => Promise<void> | void;
  onSettled?: (turn: ConversationTurnRow) => Promise<void> | void;
}

export interface DurableTurnEventSink {
  writeSSE(args: { event?: string; data: string }): Promise<void>;
}

const TERMINAL_STATUSES: ConversationTurnStatus[] = ['completed', 'failed', 'cancelled'];
const CLAIMABLE_STATUSES: ConversationTurnStatus[] = ['queued', 'interrupted'];
const LEASE_MS = 30_000;

export class ConversationTurnService {
  readonly #running = new Map<string, AbortController>();
  readonly #workerId = `chat-worker:${process.pid}:${randomUUID()}`;

  constructor(private readonly deps: ConversationTurnServiceDeps) {}

  enqueue(input: DurableTurnInput): ConversationTurnRow {
    const existing = this.deps.db.select().from(schema.conversationTurns).where(and(
      eq(schema.conversationTurns.workspaceId, input.workspaceId),
      eq(schema.conversationTurns.conversationId, input.conversationId),
      eq(schema.conversationTurns.clientTurnId, input.clientTurnId),
    )).get();
    if (existing) return existing;
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      agentId: input.agentId,
      userId: input.userId,
      messageId: input.messageId,
      planId: input.planId ?? null,
      clientTurnId: input.clientTurnId,
      prompt: input.prompt,
      requestedMode: input.requestedMode,
      effectiveMode: input.effectiveMode,
      permissionMode: input.permissionMode,
      status: 'queued',
      attachments: input.attachmentIds,
      viewport: input.viewport ?? null,
      executionEnvelope: input.executionEnvelope,
      contextManifest: input.contextManifest,
      lastEventSeq: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.db.insert(schema.conversationTurns).values(row).run();
    // Queue state is part of the durable transcript, not a browser-side guess.
    // A reconnecting client can therefore distinguish "accepted" from
    // "actually executing" without inventing a second live turn.
    this.appendEvent(row.id, row.workspaceId, 'turn', { type: 'turn_status', status: 'queued' });
    this.appendEvent(row.id, row.workspaceId, 'delta', {
      type: 'execution',
      envelope: input.executionEnvelope,
      context: input.contextManifest,
    });
    queueMicrotask(() => void this.start(row.id));
    return row;
  }

  /** Zero-based position among work that can still execute in this chat. */
  queuePosition(workspaceId: string, turnId: string): number {
    const turn = this.require(workspaceId, turnId);
    const turns = this.deps.db.select({ id: schema.conversationTurns.id })
      .from(schema.conversationTurns)
      .where(and(
        eq(schema.conversationTurns.workspaceId, workspaceId),
        eq(schema.conversationTurns.conversationId, turn.conversationId),
        inArray(schema.conversationTurns.status, ['queued', 'running']),
      ))
      // createdAt is normally enough, but SQLite rowid makes same-millisecond
      // submissions deterministic as well.
      .orderBy(asc(schema.conversationTurns.createdAt), sql`rowid`)
      .all();
    return Math.max(0, turns.findIndex((candidate) => candidate.id === turnId));
  }

  recover(): void {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const rows = this.deps.db.select().from(schema.conversationTurns).where(inArray(
      schema.conversationTurns.status,
      [...CLAIMABLE_STATUSES, 'running'],
    )).orderBy(asc(schema.conversationTurns.createdAt)).all();
    for (const row of rows) {
      if (row.status === 'running') {
        const leaseExpiresAt = row.leaseExpiresAt ? Date.parse(row.leaseExpiresAt) : 0;
        if (leaseExpiresAt > nowMs) {
          const retry = setTimeout(() => this.recover(), Math.max(50, leaseExpiresAt - nowMs + 25));
          retry.unref?.();
          continue;
        }
        this.deps.db.update(schema.conversationTurns).set({
          status: 'queued',
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        }).where(eq(schema.conversationTurns.id, row.id)).run();
        this.appendEvent(row.id, row.workspaceId, 'delta', {
          type: 'activity',
          id: `activity-${row.clientTurnId}-recovered`,
          phase: 'waiting',
          status: 'running',
          label: 'Recovered after restart',
          detail: 'Agentis restored this durable turn and is continuing from persisted state.',
          clientTurnId: row.clientTurnId,
          agentId: row.agentId,
          startedAt: now,
        });
      }
      queueMicrotask(() => void this.start(row.id));
    }
  }

  resumeAfterApproval(turnId: string): void {
    const turn = this.getById(turnId);
    if (!turn || turn.status !== 'awaiting_approval') return;
    this.deps.db.update(schema.conversationTurns).set({
      status: 'queued',
      leaseOwner: null,
      leaseExpiresAt: null,
      error: null,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.conversationTurns.id, turnId)).run();
    queueMicrotask(() => void this.start(turnId));
  }

  async start(turnId: string): Promise<void> {
    if (this.#running.has(turnId)) return;
    const turn = this.getById(turnId);
    if (!turn || !CLAIMABLE_STATUSES.includes(turn.status as ConversationTurnStatus)) return;
    const otherRunning = this.deps.db.select({ id: schema.conversationTurns.id }).from(schema.conversationTurns).where(and(
      eq(schema.conversationTurns.workspaceId, turn.workspaceId),
      eq(schema.conversationTurns.conversationId, turn.conversationId),
      eq(schema.conversationTurns.status, 'running'),
      sql`${schema.conversationTurns.id} <> ${turnId}`,
    )).get();
    if (otherRunning) return;
    const now = new Date();
    const claimed = this.deps.db.update(schema.conversationTurns).set({
      status: 'running',
      leaseOwner: this.#workerId,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS).toISOString(),
      startedAt: turn.startedAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
    }).where(and(
      eq(schema.conversationTurns.id, turnId),
      inArray(schema.conversationTurns.status, CLAIMABLE_STATUSES),
    )).run();
    if (claimed.changes === 0) return;

    // This is the hand-off that wakes a queued browser turn. It deliberately
    // precedes provider work so the UI can render an honest starting state.
    this.appendEvent(turnId, turn.workspaceId, 'turn', { type: 'turn_status', status: 'running' });

    const controller = new AbortController();
    this.#running.set(turnId, controller);
    const heartbeat = setInterval(() => {
      const stamp = new Date();
      this.deps.db.update(schema.conversationTurns).set({
        leaseExpiresAt: new Date(stamp.getTime() + LEASE_MS).toISOString(),
        updatedAt: stamp.toISOString(),
      }).where(and(
        eq(schema.conversationTurns.id, turnId),
        eq(schema.conversationTurns.leaseOwner, this.#workerId),
        eq(schema.conversationTurns.status, 'running'),
      )).run();
    }, 10_000);
    heartbeat.unref?.();
    const sink: DurableTurnEventSink = {
      writeSSE: async ({ event = 'message', data }) => {
        let parsed: unknown = data;
        try { parsed = JSON.parse(data); } catch { /* retain transport text */ }
        this.appendEvent(turnId, turn.workspaceId, event, parsed);
      },
    };

    try {
      const current = this.getById(turnId)!;
      const result = await this.deps.execute(current, sink, controller.signal);
      const latest = this.getById(turnId);
      if (!latest || latest.status === 'paused' || latest.status === 'cancelled') return;
      this.finish(turnId, result.status, result.error ?? null);
    } catch (error) {
      const latest = this.getById(turnId);
      if (latest?.status === 'paused' || latest?.status === 'cancelled') return;
      const message = (error as Error).message || 'Durable conversation turn failed.';
      this.appendEvent(turnId, turn.workspaceId, 'error', { code: 'DURABLE_TURN_FAILED', message });
      this.finish(turnId, controller.signal.aborted
        ? 'interrupted'
        : isRecoverableRuntimeBlock(message) ? 'blocked' : 'failed', message);
      this.deps.logger.error('chat.turn_worker_failed', { turnId, conversationId: turn.conversationId, error: message });
    } finally {
      clearInterval(heartbeat);
      this.#running.delete(turnId);
    }
  }

  pause(workspaceId: string, turnId: string): ConversationTurnRow {
    const turn = this.require(workspaceId, turnId);
    if (TERMINAL_STATUSES.includes(turn.status as ConversationTurnStatus)) return turn;
    this.deps.db.update(schema.conversationTurns).set({
      status: 'paused',
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.conversationTurns.id, turnId)).run();
    this.#running.get(turnId)?.abort(new Error('operator_pause'));
    this.appendEvent(turnId, workspaceId, 'turn', { type: 'turn_status', status: 'paused' });
    return this.require(workspaceId, turnId);
  }

  resume(workspaceId: string, turnId: string): ConversationTurnRow {
    const turn = this.require(workspaceId, turnId);
    if (turn.status !== 'paused' && turn.status !== 'interrupted' && turn.status !== 'blocked') return turn;
    this.deps.db.update(schema.conversationTurns).set({
      status: 'queued',
      error: null,
      completedAt: null,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.conversationTurns.id, turnId)).run();
    this.appendEvent(turnId, workspaceId, 'turn', { type: 'turn_status', status: 'queued' });
    queueMicrotask(() => void this.start(turnId));
    return this.require(workspaceId, turnId);
  }

  /** Replace the runtime prompt for a turn that has not started yet. */
  updateQueuedPrompt(workspaceId: string, turnId: string, prompt: string): ConversationTurnRow {
    const turn = this.require(workspaceId, turnId);
    if (turn.status !== 'queued') {
      throw new AgentisError('VALIDATION_FAILED', 'Only queued turns can be edited.');
    }
    this.deps.db.update(schema.conversationTurns).set({
      prompt,
      updatedAt: new Date().toISOString(),
    }).where(and(
      eq(schema.conversationTurns.id, turnId),
      eq(schema.conversationTurns.status, 'queued'),
    )).run();
    return this.require(workspaceId, turnId);
  }

  async cancel(workspaceId: string, turnId: string): Promise<ConversationTurnRow> {
    const turn = this.require(workspaceId, turnId);
    if (TERMINAL_STATUSES.includes(turn.status as ConversationTurnStatus)) return turn;
    this.deps.db.update(schema.conversationTurns).set({
      status: 'cancelled',
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.conversationTurns.id, turnId)).run();
    this.#running.get(turnId)?.abort(new Error('operator_cancel'));
    await this.deps.onCancel?.(turn);
    this.appendEvent(turnId, workspaceId, 'done', { finishReason: 'interrupted', status: 'cancelled' });
    const cancelled = this.require(workspaceId, turnId);
    await this.deps.onSettled?.(cancelled);
    return cancelled;
  }

  resolveAwaiting(
    workspaceId: string,
    conversationId: string,
    outcome: 'completed' | 'failed' | 'cancelled',
    error: string | null = null,
  ): ConversationTurnRow | null {
    const turn = this.deps.db.select().from(schema.conversationTurns).where(and(
      eq(schema.conversationTurns.workspaceId, workspaceId),
      eq(schema.conversationTurns.conversationId, conversationId),
      eq(schema.conversationTurns.status, 'awaiting_approval'),
    )).orderBy(asc(schema.conversationTurns.createdAt)).get();
    if (!turn) return null;
    const now = new Date().toISOString();
    this.deps.db.update(schema.conversationTurns).set({
      status: outcome,
      error,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: now,
      updatedAt: now,
    }).where(eq(schema.conversationTurns.id, turn.id)).run();
    this.appendEvent(turn.id, workspaceId, 'turn', { type: 'turn_status', status: outcome, error });
    const next = this.deps.db.select({ id: schema.conversationTurns.id }).from(schema.conversationTurns).where(and(
      eq(schema.conversationTurns.workspaceId, workspaceId),
      eq(schema.conversationTurns.conversationId, conversationId),
      eq(schema.conversationTurns.status, 'queued'),
    )).orderBy(asc(schema.conversationTurns.createdAt)).get();
    if (next) queueMicrotask(() => void this.start(next.id));
    return this.require(workspaceId, turn.id);
  }

  listActive(workspaceId: string, conversationId: string): ConversationTurnRow[] {
    return this.deps.db.select().from(schema.conversationTurns).where(and(
      eq(schema.conversationTurns.workspaceId, workspaceId),
      eq(schema.conversationTurns.conversationId, conversationId),
      inArray(schema.conversationTurns.status, ['queued', 'running', 'awaiting_approval', 'blocked', 'paused', 'interrupted']),
    )).orderBy(asc(schema.conversationTurns.createdAt)).all();
  }

  /**
   * Resolve a just-created durable turn even when the browser has not yet
   * received its server id. This makes Stop reliable during the create/stream
   * handoff, where cancelling only the SSE reader would otherwise orphan work.
   */
  findByClientTurnId(workspaceId: string, agentId: string, clientTurnId: string): ConversationTurnRow | null {
    return this.deps.db.select().from(schema.conversationTurns).where(and(
      eq(schema.conversationTurns.workspaceId, workspaceId),
      eq(schema.conversationTurns.agentId, agentId),
      eq(schema.conversationTurns.clientTurnId, clientTurnId),
    )).get() ?? null;
  }

  listRecent(workspaceId: string, conversationId: string, limit = 50): ConversationTurnRow[] {
    return this.deps.db.select().from(schema.conversationTurns).where(and(
      eq(schema.conversationTurns.workspaceId, workspaceId),
      eq(schema.conversationTurns.conversationId, conversationId),
    )).orderBy(desc(schema.conversationTurns.createdAt)).limit(Math.min(Math.max(limit, 1), 100)).all().reverse();
  }

  history(workspaceId: string, conversationId: string, limit = 50): Array<{
    turn: ConversationTurnRow;
    events: TurnEventV2[];
  }> {
    return this.listRecent(workspaceId, conversationId, limit).map((turn) => ({
      turn,
      events: this.events(workspaceId, turn.id, 0, 1_000).map((event) => projectTurnEvent(turn, event)),
    }));
  }

  events(workspaceId: string, turnId: string, after = 0, limit = 500): ConversationTurnEventRow[] {
    this.require(workspaceId, turnId);
    return this.deps.db.select().from(schema.conversationTurnEvents).where(and(
      eq(schema.conversationTurnEvents.workspaceId, workspaceId),
      eq(schema.conversationTurnEvents.turnId, turnId),
      gt(schema.conversationTurnEvents.seq, Math.max(0, after)),
    )).orderBy(asc(schema.conversationTurnEvents.seq)).limit(Math.min(Math.max(limit, 1), 1_000)).all();
  }

  require(workspaceId: string, turnId: string): ConversationTurnRow {
    const row = this.getById(turnId);
    if (!row || row.workspaceId !== workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'conversation turn not found');
    return row;
  }

  private getById(turnId: string): ConversationTurnRow | undefined {
    return this.deps.db.select().from(schema.conversationTurns).where(eq(schema.conversationTurns.id, turnId)).get();
  }

  private appendEvent(turnId: string, workspaceId: string, event: string, data: unknown): void {
    const eventId = randomUUID();
    const createdAt = new Date().toISOString();
    let insertedSeq: number | null = null;
    this.deps.db.transaction((tx) => {
      const turn = tx.select({ lastEventSeq: schema.conversationTurns.lastEventSeq }).from(schema.conversationTurns)
        .where(eq(schema.conversationTurns.id, turnId)).get();
      if (!turn) return;
      const seq = turn.lastEventSeq + 1;
      tx.insert(schema.conversationTurnEvents).values({ id: eventId, workspaceId, turnId, seq, event, data, createdAt }).run();
      tx.update(schema.conversationTurns).set({ lastEventSeq: seq, updatedAt: createdAt })
        .where(eq(schema.conversationTurns.id, turnId)).run();
      insertedSeq = seq;
    });
    if (insertedSeq == null || !this.deps.bus) return;
    const turn = this.getById(turnId);
    if (!turn) return;
    const projected = projectTurnEvent(turn, {
      id: eventId,
      workspaceId,
      turnId,
      seq: insertedSeq,
      event,
      data,
      createdAt,
    });
    this.deps.bus.publish(
      REALTIME_ROOMS.workspace(workspaceId),
      REALTIME_EVENTS.CONVERSATION_TURN_EVENT,
      projected,
      turn.clientTurnId,
    );
  }

  private finish(turnId: string, status: DurableTurnExecutionResult['status'], error: string | null): void {
    const current = this.getById(turnId);
    const now = new Date().toISOString();
    this.deps.db.update(schema.conversationTurns).set({
      status,
      error,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: status === 'awaiting_approval' || status === 'blocked' ? null : now,
      updatedAt: now,
    }).where(eq(schema.conversationTurns.id, turnId)).run();
    if (current) this.appendEvent(turnId, current.workspaceId, 'turn', { type: 'turn_status', status, error });
    if (current && (status === 'completed' || status === 'failed')) {
      void this.deps.onSettled?.(this.require(current.workspaceId, turnId));
    }
    if (current && status !== 'awaiting_approval') {
      const next = this.deps.db.select({ id: schema.conversationTurns.id }).from(schema.conversationTurns).where(and(
        eq(schema.conversationTurns.workspaceId, current.workspaceId),
        eq(schema.conversationTurns.conversationId, current.conversationId),
        eq(schema.conversationTurns.status, 'queued'),
      )).orderBy(asc(schema.conversationTurns.createdAt)).get();
      if (next) queueMicrotask(() => void this.start(next.id));
    }
  }
}

function isRecoverableRuntimeBlock(message: string): boolean {
  // Keep only concrete transient conditions recoverable. Generic wording such
  // as “try again” also appears in permanent configuration errors (for
  // example, a missing interactive chat harness) and would leave the turn
  // active indefinitely for the UI to resume.
  return /\b(?:capacity|overloaded|rate.?limit|quota|credits?|billing|payment required|temporarily unavailable|no healthy runtime)\b/i.test(message);
}

export function projectTurnEvent(turn: ConversationTurnRow, event: ConversationTurnEventRow): TurnEventV2 {
  const value = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
  const type = typeof value.type === 'string' ? value.type : event.event;
  const runId = typeof value.runId === 'string' ? value.runId : undefined;
  const category: TurnEventV2['category'] = type === 'commentary'
    ? 'narration'
    : type === 'activity' || type === 'agent_consultation' || type === 'suspension' || type === 'tool_call' || type === 'tool_result'
      ? 'operation'
      : type === 'plan'
        ? 'verification'
        : 'status';
  const visibility: TurnEventV2['visibility'] = type === 'execution' || type === 'tool_call' || type === 'tool_result'
    ? 'technical'
    : 'both';
  const summary = safeEventSummary(type, value, event.event);
  return {
    version: 2,
    id: event.id,
    workspaceId: turn.workspaceId,
    conversationId: turn.conversationId,
    turnId: turn.id,
    agentId: turn.agentId,
    ...(runId ? { runId } : {}),
    seq: event.seq,
    transportEvent: event.event,
    category,
    visibility,
    summary,
    data: safeReplayData(type, value),
    createdAt: event.createdAt,
  };
}

function safeEventSummary(type: string, value: Record<string, unknown>, fallback: string): string {
  if (type === 'commentary' && typeof value.text === 'string') return sanitizeSafeText(value.text);
  if (type === 'activity' && typeof value.label === 'string') {
    const detail = typeof value.detail === 'string' && value.detail.trim() ? ` — ${value.detail.trim()}` : '';
    return sanitizeSafeText(`${value.label}${detail}`);
  }
  if (type === 'agent_consultation') return sanitizeSafeText(String(value.summary ?? 'Agent consultation updated'));
  if (type === 'suspension') return sanitizeSafeText(String(value.summary ?? 'Durable suspension updated'));
  if (type === 'tool_call') return `Started ${typeof value.name === 'string' ? value.name : 'an operation'}`;
  if (type === 'tool_result') return `${value.error ? 'Failed' : 'Completed'} ${typeof value.name === 'string' ? value.name : 'an operation'}`;
  if (type === 'turn_status' && typeof value.status === 'string') return `Turn ${value.status}`;
  if (typeof value.message === 'string') return sanitizeSafeText(value.message);
  return fallback;
}

function safeReplayData(type: string, value: Record<string, unknown>): unknown {
  if (type === 'thinking') return { type: 'status', hidden: true };
  if (type === 'tool_call') return { type, id: value.id, name: value.name };
  if (type === 'tool_result') return { type, id: value.id, name: value.name, error: typeof value.error === 'string' ? sanitizeSafeText(value.error) : value.error };
  if (type === 'commentary') return { type, id: value.id, text: sanitizeSafeText(String(value.text ?? '')), source: value.source, createdAt: value.createdAt };
  if (type === 'activity') return {
    type,
    id: value.id,
    phase: value.phase,
    status: value.status,
    label: typeof value.label === 'string' ? sanitizeSafeText(value.label) : value.label,
    detail: typeof value.detail === 'string' ? sanitizeSafeText(value.detail) : value.detail,
    workflowId: value.workflowId,
    runId: value.runId,
    nodeId: value.nodeId,
    clientTurnId: value.clientTurnId,
    agentId: value.agentId,
    startedAt: value.startedAt,
  };
  if (type === 'agent_consultation') return {
    type,
    consultationId: value.consultationId,
    phase: value.phase,
    callerAgentId: value.callerAgentId,
    targetAgentId: value.targetAgentId,
    callerName: typeof value.callerName === 'string' ? sanitizeSafeText(value.callerName) : value.callerName,
    targetName: typeof value.targetName === 'string' ? sanitizeSafeText(value.targetName) : value.targetName,
    round: value.round,
    maxRounds: value.maxRounds,
    summary: typeof value.summary === 'string' ? sanitizeSafeText(value.summary) : value.summary,
    status: value.status,
    createdAt: value.createdAt,
  };
  if (type === 'suspension') return {
    type,
    suspensionId: value.suspensionId,
    phase: value.phase,
    conditionType: value.conditionType,
    audienceType: value.audienceType,
    summary: typeof value.summary === 'string' ? sanitizeSafeText(value.summary) : value.summary,
    status: value.status,
    createdAt: value.createdAt,
  };
  if (type === 'error') return { type, code: value.code, message: typeof value.message === 'string' ? sanitizeSafeText(value.message) : undefined };
  return value;
}

function sanitizeSafeText(input: string): string {
  return input
    .replace(/\b(?:bearer\s+)?(?:sk|pk|rk|api)[-_][a-z0-9_-]{12,}\b/gi, '[redacted]')
    .replace(/\b(password|passwd|secret|api[_ -]?key|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 1_200);
}

export function classifyConversationExecutionMode(
  requested: ConversationExecutionMode,
  input: {
    body: string;
    attachmentCount: number;
    permissionMode: ChatPermissionMode;
    previousMode?: EffectiveConversationExecutionMode | null;
    hasActiveBuildSession?: boolean;
  },
): { mode: EffectiveConversationExecutionMode; reason: string } {
  // Plan is a permission posture, not merely prompt guidance. It must never be
  // promoted into a durable Mission (and therefore Mission acceptance) even if
  // the request contains strong build language or a stale client sends an
  // explicit execution mode.
  if (input.permissionMode === 'plan') {
    return {
      mode: requested === 'quick' ? 'quick' : 'deep',
      reason: 'Plan mode requires deliberate, read-only execution without Mission acceptance.',
    };
  }
  if (requested !== 'auto') return { mode: requested, reason: 'Selected explicitly by the operator.' };
  const text = input.body.trim();
  const lower = text.toLowerCase();
  const continuation = /^(?:please\s+)?(?:proceed|continue|resume|keep going|go ahead|do it|fix it|try again|finish it)(?:\s+now)?[.!\s]*$/i.test(text);
  if (continuation && input.hasActiveBuildSession) {
    return { mode: 'mission', reason: 'This continues an unfinished App build session and inherits durable mission execution.' };
  }
  if (continuation && input.previousMode === 'mission') {
    return { mode: 'mission', reason: 'This is a continuation of the previous mission turn.' };
  }
  if (continuation && input.previousMode === 'deep') {
    return { mode: 'deep', reason: 'This is a continuation of the previous deep turn.' };
  }
  const missionSignals = [
    /\b(?:build|implement|create|migrate|redesign|refactor|ship|deliver|deploy|audit and fix)\b/,
    /\b(?:from start to finish|end[- ]to[- ]end|production[- ]ready|do not stop|until (?:it|this) (?:is|works)|acceptance criteria)\b/,
    /\b(?:multi[- ]agent|delegate|specialist|parallel|entire|whole|complete)\b/,
  ];
  const deepSignals = [
    /\b(?:analy[sz]e|investigate|debug|review|compare|research|plan|explain)\b/,
    /\b(?:repository|codebase|architecture|database|api|workflow|document|spreadsheet|pdf)\b/,
  ];
  if (missionSignals.filter((signal) => signal.test(lower)).length >= 2 || text.length >= 4_000) {
    return { mode: 'mission', reason: 'The request contains multiple build/delivery signals or a substantial specification.' };
  }
  if (input.permissionMode === 'auto' && missionSignals.some((signal) => signal.test(lower))) {
    return { mode: 'mission', reason: 'A mutating build request in Auto mode requires durable mission execution.' };
  }
  if (input.attachmentCount > 0 || text.length >= 700 || deepSignals.some((signal) => signal.test(lower))) {
    return { mode: 'deep', reason: input.attachmentCount > 0 ? 'Attachments require deliberate ingestion and analysis.' : 'The request requires deliberate analysis or tools.' };
  }
  return { mode: 'quick', reason: 'A short conversational request can use the low-latency path.' };
}
