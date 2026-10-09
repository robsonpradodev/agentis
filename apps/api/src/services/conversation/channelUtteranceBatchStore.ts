import { randomUUID } from 'node:crypto';
import { and, asc, eq, lt, or } from 'drizzle-orm';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { ChannelTurnInput } from './channelTurnDispatcher.js';

export interface DurableUtteranceBatch {
  id: string;
  input: ChannelTurnInput;
  messageIds: string[];
  attachmentIds: string[];
  softDeadlineAt: string;
  hardDeadlineAt: string;
}

/** Durable semantic-turn assembler; timers are only latency hints, the DB is the source of truth. */
export class ChannelUtteranceBatchStore {
  constructor(private readonly db: AgentisSqliteDb) {}

  append(input: ChannelTurnInput, quietMs: number, hardMs = 8_000): DurableUtteranceBatch {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const existing = this.db.select().from(schema.channelUtteranceBatches).where(and(
      eq(schema.channelUtteranceBatches.workspaceId, input.workspaceId),
      eq(schema.channelUtteranceBatches.connectionId, input.connectionId),
      eq(schema.channelUtteranceBatches.chatId, input.chatId),
      eq(schema.channelUtteranceBatches.status, 'collecting'),
    )).orderBy(asc(schema.channelUtteranceBatches.createdAt)).get();
    if (existing) {
      const prior = existing.payloadJson as unknown as ChannelTurnInput;
      const hardAt = Date.parse(existing.hardDeadlineAt);
      const softAt = Math.min(nowMs + quietMs, hardAt);
      const messageIds = unique([...(asStrings(existing.messageIdsJson)), ...(input.inboundMessageId ? [input.inboundMessageId] : [])]);
      const attachmentIds = unique([...(asStrings(existing.attachmentIdsJson)), ...(input.attachmentIds ?? [])]);
      const combined: ChannelTurnInput = {
        ...prior,
        ...input,
        text: [prior.text, input.text].filter(Boolean).join('\n'),
        excludeMessageIds: messageIds,
        ...(attachmentIds.length ? { attachmentIds } : {}),
      };
      this.db.update(schema.channelUtteranceBatches).set({
        payloadJson: combined as unknown as Record<string, unknown>, messageIdsJson: messageIds,
        attachmentIdsJson: attachmentIds, softDeadlineAt: new Date(softAt).toISOString(), updatedAt: now,
      }).where(eq(schema.channelUtteranceBatches.id, existing.id)).run();
      return { id: existing.id, input: combined, messageIds, attachmentIds, softDeadlineAt: new Date(softAt).toISOString(), hardDeadlineAt: existing.hardDeadlineAt };
    }
    const id = randomUUID();
    const messageIds = input.inboundMessageId ? [input.inboundMessageId] : [];
    const attachmentIds = input.attachmentIds ?? [];
    const softDeadlineAt = new Date(nowMs + quietMs).toISOString();
    const hardDeadlineAt = new Date(nowMs + hardMs).toISOString();
    this.db.insert(schema.channelUtteranceBatches).values({
      id, workspaceId: input.workspaceId, conversationId: input.conversationId,
      connectionId: input.connectionId, chatId: input.chatId, status: 'collecting',
      payloadJson: input as unknown as Record<string, unknown>, messageIdsJson: messageIds,
      attachmentIdsJson: attachmentIds, softDeadlineAt, hardDeadlineAt, createdAt: now, updatedAt: now,
    }).run();
    return { id, input, messageIds, attachmentIds, softDeadlineAt, hardDeadlineAt };
  }

  claim(id: string): DurableUtteranceBatch | null {
    const row = this.db.select().from(schema.channelUtteranceBatches).where(eq(schema.channelUtteranceBatches.id, id)).get();
    if (!row || !['collecting', 'recovering'].includes(row.status)) return null;
    const changed = this.db.update(schema.channelUtteranceBatches).set({ status: 'processing', updatedAt: new Date().toISOString() })
      .where(and(eq(schema.channelUtteranceBatches.id, id), eq(schema.channelUtteranceBatches.status, row.status))).run();
    return changed.changes ? present(row) : null;
  }

  claimDue(now = new Date().toISOString(), limit = 50): DurableUtteranceBatch[] {
    const stale = new Date(Date.parse(now) - 5 * 60_000).toISOString();
    const rows = this.db.select().from(schema.channelUtteranceBatches).where(or(
      and(or(eq(schema.channelUtteranceBatches.status, 'collecting'), eq(schema.channelUtteranceBatches.status, 'recovering')), lt(schema.channelUtteranceBatches.softDeadlineAt, now)),
      and(eq(schema.channelUtteranceBatches.status, 'processing'), lt(schema.channelUtteranceBatches.updatedAt, stale)),
    )).orderBy(asc(schema.channelUtteranceBatches.softDeadlineAt)).limit(limit).all();
    const claimed: DurableUtteranceBatch[] = [];
    for (const row of rows) {
      if (row.status === 'processing') {
        this.db.update(schema.channelUtteranceBatches).set({ status: 'collecting' }).where(eq(schema.channelUtteranceBatches.id, row.id)).run();
      }
      const hit = this.claim(row.id);
      if (hit) claimed.push(hit);
    }
    return claimed;
  }

  finish(id: string, result: { replied: boolean; reason?: string }): void {
    if (result.reason === 'delivery_failed') {
      this.db.update(schema.channelUtteranceBatches).set({status: 'failed', updatedAt: new Date().toISOString()})
        .where(eq(schema.channelUtteranceBatches.id, id)).run();
    } else if (result.reason === 'delivery_pending' || result.reason === 'delivery_retry') {
      this.retry(id, result.reason === 'delivery_pending' ? 60_000 : 5_000);
      this.db.update(schema.channelUtteranceBatches).set({status: 'recovering'})
        .where(eq(schema.channelUtteranceBatches.id, id)).run();
    } else this.complete(id);
  }

  complete(id: string): void {
    const now = new Date().toISOString();
    this.db.update(schema.channelUtteranceBatches).set({ status: 'settled', settledAt: now, updatedAt: now })
      .where(eq(schema.channelUtteranceBatches.id, id)).run();
  }

  retry(id: string, delayMs = 5_000): void {
    const now = new Date();
    this.db.update(schema.channelUtteranceBatches).set({ status: 'collecting', softDeadlineAt: new Date(now.getTime() + delayMs).toISOString(), updatedAt: now.toISOString() })
      .where(eq(schema.channelUtteranceBatches.id, id)).run();
  }
}

function present(row: typeof schema.channelUtteranceBatches.$inferSelect): DurableUtteranceBatch {
  return {
    id: row.id,
    input: row.payloadJson as unknown as ChannelTurnInput,
    messageIds: asStrings(row.messageIdsJson),
    attachmentIds: asStrings(row.attachmentIdsJson),
    softDeadlineAt: row.softDeadlineAt,
    hardDeadlineAt: row.hardDeadlineAt,
  };
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
function unique(values: string[]): string[] { return [...new Set(values)]; }
