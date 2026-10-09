import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import type { EventBus } from '../../event-bus.js';
import { normalizeHandle } from './channelAccess.js';

export type ConversationHandoffSource = 'explicit' | 'provider_observed' | 'runtime_failure';

export interface ConversationHandoffSnapshot {
  conversationId: string;
  workspaceId: string;
  agentId: string;
  state: 'human' | 'agent';
  source: ConversationHandoffSource | null;
  claimedAt: string | null;
  automationEpoch: number;
  connectionId: string | null;
  chatId: string | null;
}

type HandoffListener = (snapshot: ConversationHandoffSnapshot) => void;

/** Durable source of truth for per-conversation human/agent ownership. */
export class ConversationHandoffService {
  readonly #listeners = new Set<HandoffListener>();

  constructor(private readonly deps: { db: AgentisSqliteDb; bus?: EventBus }) {}

  subscribe(listener: HandoffListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  current(workspaceId: string, conversationId: string): ConversationHandoffSnapshot {
    return this.#snapshot(this.#row(workspaceId, conversationId));
  }

  findByChannel(workspaceId: string, connectionId: string, chatId: string): ConversationHandoffSnapshot | null {
    const exact = this.deps.db.select().from(schema.conversations).where(and(
      eq(schema.conversations.workspaceId, workspaceId),
      eq(schema.conversations.channelConnectionId, connectionId),
      eq(schema.conversations.channelChatId, chatId),
    )).get();
    if (exact) return this.#snapshot(exact);
    const target = normalizeHandle(chatId);
    if (!target) return null;
    const rows = this.deps.db.select().from(schema.conversations).where(and(
      eq(schema.conversations.workspaceId, workspaceId),
      eq(schema.conversations.channelConnectionId, connectionId),
    )).all();
    const matched = rows.find((row) => normalizeHandle(row.channelChatId ?? '') === target);
    return matched ? this.#snapshot(matched) : null;
  }

  claimHuman(args: {
    workspaceId: string;
    conversationId: string;
    source: ConversationHandoffSource;
  }): ConversationHandoffSnapshot {
    const row = this.#row(args.workspaceId, args.conversationId);
    const now = new Date().toISOString();
    const transitioning = row.handoffState !== 'human';
    this.deps.db.update(schema.conversations).set({
      handoffState: 'human',
      handoffSource: args.source,
      handoffClaimedAt: now,
      ...(transitioning ? { automationEpoch: sql`${schema.conversations.automationEpoch} + 1` } : {}),
      updatedAt: now,
    }).where(eq(schema.conversations.id, row.id)).run();
    const snapshot = this.current(args.workspaceId, args.conversationId);
    this.#publish(snapshot);
    return snapshot;
  }

  releaseToAgent(workspaceId: string, conversationId: string): ConversationHandoffSnapshot {
    const row = this.#row(workspaceId, conversationId);
    if (row.handoffState !== 'human') return this.#snapshot(row);
    const now = new Date().toISOString();
    this.deps.db.update(schema.conversations).set({
      handoffState: null,
      handoffSource: null,
      handoffClaimedAt: null,
      automationEpoch: sql`${schema.conversations.automationEpoch} + 1`,
      updatedAt: now,
    }).where(eq(schema.conversations.id, row.id)).run();
    const snapshot = this.current(workspaceId, conversationId);
    this.#publish(snapshot);
    return snapshot;
  }

  assertAutomationAllowed(args: {
    workspaceId: string;
    conversationId: string;
    expectedEpoch?: number;
  }): ConversationHandoffSnapshot {
    const snapshot = this.current(args.workspaceId, args.conversationId);
    if (snapshot.state === 'human') {
      throw new AgentisError(
        'CHANNEL_HUMAN_TAKEOVER_ACTIVE',
        'A human operator currently owns this conversation. Automated delivery was cancelled.',
        { remediation: 'Use Hand back before asking an agent or workflow to send into this conversation.' },
      );
    }
    if (args.expectedEpoch !== undefined && snapshot.automationEpoch !== args.expectedEpoch) {
      throw new AgentisError('TURN_CANCELLED', 'Conversation ownership changed while this turn was running. The stale delivery was cancelled.');
    }
    return snapshot;
  }

  assertAutomationAllowedByChannel(args: {
    workspaceId: string;
    connectionId: string;
    chatId: string;
    expectedEpoch?: number;
  }): ConversationHandoffSnapshot | null {
    const snapshot = this.findByChannel(args.workspaceId, args.connectionId, args.chatId);
    if (!snapshot) return null;
    return this.assertAutomationAllowed({
      workspaceId: args.workspaceId,
      conversationId: snapshot.conversationId,
      ...(args.expectedEpoch !== undefined ? { expectedEpoch: args.expectedEpoch } : {}),
    });
  }

  #row(workspaceId: string, conversationId: string) {
    const row = this.deps.db.select().from(schema.conversations).where(and(
      eq(schema.conversations.id, conversationId),
      eq(schema.conversations.workspaceId, workspaceId),
    )).get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `conversation ${conversationId} not found`);
    return row;
  }

  #snapshot(row: typeof schema.conversations.$inferSelect): ConversationHandoffSnapshot {
    return {
      conversationId: row.id,
      workspaceId: row.workspaceId,
      agentId: row.agentId,
      state: row.handoffState === 'human' ? 'human' : 'agent',
      source: row.handoffSource === 'explicit' || row.handoffSource === 'provider_observed' || row.handoffSource === 'runtime_failure'
        ? row.handoffSource
        : null,
      claimedAt: row.handoffClaimedAt ?? null,
      automationEpoch: row.automationEpoch ?? 0,
      connectionId: row.channelConnectionId ?? null,
      chatId: row.channelChatId ?? null,
    };
  }

  #publish(snapshot: ConversationHandoffSnapshot): void {
    for (const listener of this.#listeners) listener(snapshot);
    if (!this.deps.bus) return;
    this.deps.bus.publish(REALTIME_ROOMS.workspace(snapshot.workspaceId), REALTIME_EVENTS.CONVERSATION_HANDOFF_CHANGED, snapshot);
    this.deps.bus.publish(REALTIME_ROOMS.conversation(snapshot.agentId), REALTIME_EVENTS.CONVERSATION_HANDOFF_CHANGED, snapshot);
  }
}
