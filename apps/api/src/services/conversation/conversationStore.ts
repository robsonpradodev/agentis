/**
 * ConversationStore — V1-SPEC §0.3 item 23, §11 (conversation surface).
 *
 * Operator-agent threads, with optional mirroring of OpenClaw Gateway
 * sessions. Inbound mirror writes (from the SessionMirror) flow through
 * `appendMirrored()`; operator outbound messages flow through `sendOutbound()`.
 * The store is the single source of truth for the dashboard's
 * /v1/conversations endpoints.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS, type RealtimeEventName } from '@agentis/core';
import type { EventBus } from '../../event-bus.js';

export interface ConversationStoreDeps {
  db: AgentisSqliteDb;
  bus: EventBus;
}

export class ConversationStore {
  constructor(private readonly deps: ConversationStoreDeps) {}

  list(workspaceId: string, options: { includeArchived?: boolean } = {}) {
    return this.deps.db
      .select()
      .from(schema.conversations)
      .where(options.includeArchived
        ? eq(schema.conversations.workspaceId, workspaceId)
        : and(eq(schema.conversations.workspaceId, workspaceId), isNull(schema.conversations.archivedAt)))
      .orderBy(desc(schema.conversations.lastMessageAt), desc(schema.conversations.createdAt))
      .all();
  }

  getOrCreateByAgent(args: {
    workspaceId: string;
    ambientId: string | null;
    userId: string;
    agentId: string;
    mirroredSessionId?: string | null;
  }) {
    const existing = this.deps.db
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.workspaceId, args.workspaceId),
          eq(schema.conversations.agentId, args.agentId),
          isNull(schema.conversations.channelConnectionId),
          isNull(schema.conversations.channelChatId),
          isNull(schema.conversations.archivedAt),
        ),
      )
      // rowid tiebreak: createdAt has millisecond precision, so a thread reset
      // in the same instant as the previous send would otherwise resolve to
      // the OLD thread (its lastMessageAt beats the fresh thread's NULL).
      .orderBy(desc(schema.conversations.createdAt), desc(sql`rowid`))
      .get();
    if (existing) {
      if (args.mirroredSessionId && !existing.mirroredSessionId) {
        this.deps.db
          .update(schema.conversations)
          .set({ mirroredSessionId: args.mirroredSessionId })
          .where(eq(schema.conversations.id, existing.id))
          .run();
        existing.mirroredSessionId = args.mirroredSessionId;
      }
      return existing;
    }
    const row = {
      id: randomUUID(),
      workspaceId: args.workspaceId,
      ambientId: args.ambientId,
      userId: args.userId,
      agentId: args.agentId,
      mirroredSessionId: args.mirroredSessionId ?? null,
      channelConnectionId: null,
      channelChatId: null,
      title: null,
      archivedAt: null,
      unreadCount: 0,
      lastMessageAt: null,
    };
    this.deps.db.insert(schema.conversations).values(row).run();
    return this.deps.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, row.id))
      .get()!;
  }

  getOrCreateByChannel(args: {
    workspaceId: string;
    ambientId: string | null;
    userId: string;
    agentId: string;
    channelConnectionId: string;
    channelChatId: string;
    /** Canonical peer identity; provider aliases resolve to the same live thread. */
    channelPeerIdentityId?: string | null;
    /** When the channel belongs to an Agentic App, the thread is owned by it (Living Apps Phase 0). */
    appId?: string | null;
  }) {
    // A provider conversation is identified by the connection + provider chat,
    // not by whichever agent currently owns the connection. Rebinding a channel
    // must preserve the relationship instead of creating an empty parallel chat.
    // Archived channel threads are reactivated on new provider activity: archive
    // is an inbox presentation state, not permission to forget the transcript.
    const existing = this.deps.db
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.workspaceId, args.workspaceId),
          eq(schema.conversations.channelConnectionId, args.channelConnectionId),
          args.channelPeerIdentityId
            ? or(
                eq(schema.conversations.channelPeerIdentityId, args.channelPeerIdentityId),
                eq(schema.conversations.channelChatId, args.channelChatId),
              )!
            : eq(schema.conversations.channelChatId, args.channelChatId),
        ),
      )
      .orderBy(
        desc(sql`${schema.conversations.archivedAt} is null`),
        desc(schema.conversations.lastMessageAt),
        desc(schema.conversations.createdAt),
        desc(sql`rowid`),
      )
      .get();
    if (existing) {
      const nextAppId = args.appId ?? existing.appId ?? null;
      const changed = existing.agentId !== args.agentId
        || existing.appId !== nextAppId
        || existing.archivedAt !== null
        || existing.ambientId !== args.ambientId
        || (args.channelPeerIdentityId && existing.channelPeerIdentityId !== args.channelPeerIdentityId);
      if (changed) {
        const now = new Date().toISOString();
        this.deps.db
          .update(schema.conversations)
          .set({
            agentId: args.agentId,
            appId: nextAppId,
            ambientId: args.ambientId,
            ...(args.channelPeerIdentityId ? { channelPeerIdentityId: args.channelPeerIdentityId } : {}),
            archivedAt: null,
            updatedAt: now,
          })
          .where(eq(schema.conversations.id, existing.id))
          .run();
        return {
          ...existing,
          agentId: args.agentId,
          appId: nextAppId,
          ambientId: args.ambientId,
          channelPeerIdentityId: args.channelPeerIdentityId ?? existing.channelPeerIdentityId ?? null,
          archivedAt: null,
          updatedAt: now,
        };
      }
      return existing;
    }

    const row = {
      id: randomUUID(),
      workspaceId: args.workspaceId,
      ambientId: args.ambientId,
      userId: args.userId,
      agentId: args.agentId,
      mirroredSessionId: null,
      channelConnectionId: args.channelConnectionId,
      channelChatId: args.channelChatId,
      channelPeerIdentityId: args.channelPeerIdentityId ?? null,
      appId: args.appId ?? null,
      title: null,
      archivedAt: null,
      unreadCount: 0,
      lastMessageAt: null,
    };
    this.deps.db.insert(schema.conversations).values(row).run();
    return this.deps.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, row.id))
      .get()!;
  }

  messages(conversationId: string, limit = 50, before?: string | null, beforeId?: string | null) {
    const beforeRowId = beforeId
      ? this.deps.db
          .select({ rowid: sql<number>`rowid` })
          .from(schema.conversationMessages)
          .where(and(
            eq(schema.conversationMessages.conversationId, conversationId),
            eq(schema.conversationMessages.id, beforeId),
          ))
          .get()?.rowid
      : undefined;
    return this.deps.db
      .select()
      .from(schema.conversationMessages)
      .where(and(
        eq(schema.conversationMessages.conversationId, conversationId),
        ...(before
          ? [
              beforeRowId != null
                ? or(
                    lt(schema.conversationMessages.createdAt, before),
                    and(
                      eq(schema.conversationMessages.createdAt, before),
                      sql`rowid < ${beforeRowId}`,
                    ),
                  )!
                : lt(schema.conversationMessages.createdAt, before),
            ]
          : []),
      ))
      // UUIDs are random and cannot represent chronology when two writes share
      // the same millisecond. SQLite rowid preserves their insertion order and
      // gives cursor pagination the same deterministic ordering.
      .orderBy(desc(schema.conversationMessages.createdAt), desc(sql<number>`rowid`))
      .limit(limit)
      .all()
      .reverse();
  }

  updateMessage(args: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    body: string;
  }) {
    if (!args.body || args.body.length === 0) {
      throw new AgentisError('VALIDATION_FAILED', 'Conversation message body required');
    }
    const conversation = this.#loadConversation(args.workspaceId, args.conversationId);
    const existing = this.deps.db
      .select()
      .from(schema.conversationMessages)
      .where(and(
        eq(schema.conversationMessages.workspaceId, args.workspaceId),
        eq(schema.conversationMessages.conversationId, args.conversationId),
        eq(schema.conversationMessages.id, args.messageId),
      ))
      .get();
    if (!existing) throw new AgentisError('RESOURCE_NOT_FOUND', `message ${args.messageId} not found`);
    this.deps.db
      .update(schema.conversationMessages)
      .set({ body: args.body })
      .where(eq(schema.conversationMessages.id, args.messageId))
      .run();
    const message = { ...existing, body: args.body };
    this.deps.bus.publish(
      REALTIME_ROOMS.conversation(conversation.agentId),
      REALTIME_EVENTS.CONVERSATION_MESSAGE_UPDATED,
      { message, conversationId: args.conversationId, agentId: conversation.agentId },
    );
    return message;
  }

  rewriteFromMessage(args: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    body: string;
    metadata?: Record<string, unknown>;
  }) {
    if (!args.body || args.body.length === 0) {
      throw new AgentisError('VALIDATION_FAILED', 'Conversation message body required');
    }
    const conversation = this.#loadConversation(args.workspaceId, args.conversationId);
    const existing = this.deps.db
      .select()
      .from(schema.conversationMessages)
      .where(and(
        eq(schema.conversationMessages.workspaceId, args.workspaceId),
        eq(schema.conversationMessages.conversationId, args.conversationId),
        eq(schema.conversationMessages.id, args.messageId),
      ))
      .get();
    if (!existing) throw new AgentisError('RESOURCE_NOT_FOUND', `message ${args.messageId} not found`);
    if (existing.authorType !== 'operator') {
      throw new AgentisError('VALIDATION_FAILED', 'Only operator messages can be rewritten');
    }
    const existingOrder = this.deps.db
      .select({ rowid: sql<number>`rowid` })
      .from(schema.conversationMessages)
      .where(eq(schema.conversationMessages.id, existing.id))
      .get();

    const descendants = this.deps.db
      .select()
      .from(schema.conversationMessages)
      .where(and(
        eq(schema.conversationMessages.workspaceId, args.workspaceId),
        eq(schema.conversationMessages.conversationId, args.conversationId),
        or(
          gt(schema.conversationMessages.createdAt, existing.createdAt),
          and(
            eq(schema.conversationMessages.createdAt, existing.createdAt),
            sql`rowid > ${existingOrder?.rowid ?? 0}`,
          ),
        )!,
      ))
      .orderBy(schema.conversationMessages.createdAt, sql`rowid`)
      .all();

    const metadata = {
      ...(existing.metadata && typeof existing.metadata === 'object' ? existing.metadata as Record<string, unknown> : {}),
      ...(args.metadata ?? {}),
    };
    this.deps.db
      .update(schema.conversationMessages)
      .set({ body: args.body, metadata, deliveryStatus: 'sent' })
      .where(eq(schema.conversationMessages.id, args.messageId))
      .run();

    for (const descendant of descendants) {
      this.deps.db
        .delete(schema.conversationMessages)
        .where(eq(schema.conversationMessages.id, descendant.id))
        .run();
    }

    const latest = this.deps.db
      .select()
      .from(schema.conversationMessages)
      .where(and(
        eq(schema.conversationMessages.workspaceId, args.workspaceId),
        eq(schema.conversationMessages.conversationId, args.conversationId),
      ))
      .orderBy(desc(schema.conversationMessages.createdAt), desc(sql<number>`rowid`))
      .limit(1)
      .get();
    this.deps.db
      .update(schema.conversations)
      .set({ lastMessageAt: latest?.createdAt ?? null, updatedAt: new Date().toISOString() })
      .where(eq(schema.conversations.id, args.conversationId))
      .run();

    const message = { ...existing, body: args.body, metadata, deliveryStatus: 'sent' as const };
    this.deps.bus.publish(
      REALTIME_ROOMS.conversation(conversation.agentId),
      REALTIME_EVENTS.CONVERSATION_MESSAGE_UPDATED,
      { message, conversationId: args.conversationId, agentId: conversation.agentId },
    );
    for (const descendant of descendants) {
      this.deps.bus.publish(
        REALTIME_ROOMS.conversation(conversation.agentId),
        REALTIME_EVENTS.CONVERSATION_MESSAGE_DELETED,
        { id: descendant.id, conversationId: args.conversationId, agentId: conversation.agentId },
      );
    }
    return { message, deletedIds: descendants.map((row) => row.id) };
  }

  deleteMessage(args: { workspaceId: string; conversationId: string; messageId: string }) {
    const conversation = this.#loadConversation(args.workspaceId, args.conversationId);
    const existing = this.deps.db
      .select()
      .from(schema.conversationMessages)
      .where(and(
        eq(schema.conversationMessages.workspaceId, args.workspaceId),
        eq(schema.conversationMessages.conversationId, args.conversationId),
        eq(schema.conversationMessages.id, args.messageId),
      ))
      .get();
    if (!existing) throw new AgentisError('RESOURCE_NOT_FOUND', `message ${args.messageId} not found`);
    this.deps.db.delete(schema.conversationMessages).where(eq(schema.conversationMessages.id, args.messageId)).run();
    this.deps.bus.publish(
      REALTIME_ROOMS.conversation(conversation.agentId),
      REALTIME_EVENTS.CONVERSATION_MESSAGE_DELETED,
      { id: args.messageId, conversationId: args.conversationId, agentId: conversation.agentId },
    );
    return existing;
  }

  /** Append an outbound operator message and emit the realtime event. */
  appendOutbound(args: {
    workspaceId: string;
    conversationId: string;
    operatorId: string;
    sessionMessageId?: string | null;
    body: string;
    metadata?: Record<string, unknown>;
    deliveryStatus?: 'sending' | 'sent' | 'delivered' | 'failed';
    participantSide?: 'customer' | 'business' | null;
  }) {
    return this.#append({
      conversationId: args.conversationId,
      workspaceId: args.workspaceId,
      authorType: 'operator',
      authorId: args.operatorId,
      participantSide: args.participantSide ?? null,
      sessionMessageId: args.sessionMessageId ?? null,
      body: args.body,
      metadata: args.metadata,
      deliveryStatus: args.deliveryStatus ?? 'sent',
      eventName: REALTIME_EVENTS.CONVERSATION_MESSAGE_SENT,
    });
  }

  /** Append a mirrored gateway message (inbound). */
  appendMirrored(args: {
    workspaceId: string;
    conversationId: string;
    sessionMessageId: string;
    body: string;
    authorType: 'agent' | 'system';
    metadata?: Record<string, unknown>;
    deliveryStatus?: 'sending' | 'sent' | 'delivered' | 'failed' | 'mirrored';
    participantSide?: 'customer' | 'business' | null;
  }) {
    return this.#append({
      conversationId: args.conversationId,
      workspaceId: args.workspaceId,
      authorType: args.authorType,
      authorId: null,
      participantSide: args.participantSide ?? null,
      sessionMessageId: args.sessionMessageId,
      body: args.body,
      metadata: args.metadata,
      deliveryStatus: args.deliveryStatus ?? 'mirrored',
      eventName: REALTIME_EVENTS.CONVERSATION_MESSAGE_RECEIVED,
    });
  }

  /**
   * Persist provider history as inert transcript. It is chronological and
   * idempotent, but never increments unread state or wakes any realtime agent.
   */
  appendReconciledChannelMessage(args: {
    workspaceId: string;
    conversationId: string;
    sessionMessageId: string;
    body: string;
    participantSide: 'customer' | 'business';
    occurredAt: string;
    metadata?: Record<string, unknown>;
  }) {
    return this.#append({
      conversationId: args.conversationId,
      workspaceId: args.workspaceId,
      authorType: args.participantSide === 'business' ? 'operator' : 'system',
      authorId: null,
      participantSide: args.participantSide,
      sessionMessageId: args.sessionMessageId,
      body: args.body,
      metadata: { ...(args.metadata ?? {}), channelHistoryReconciled: true },
      deliveryStatus: args.participantSide === 'business' ? 'sent' : 'mirrored',
      eventName: REALTIME_EVENTS.CONVERSATION_MESSAGE_RECEIVED,
      occurredAt: args.occurredAt,
      incrementUnread: false,
      publishRealtime: false,
    });
  }

  updateDeliveryStatus(args: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    deliveryStatus: 'sending' | 'sent' | 'delivered' | 'failed';
    metadata?: Record<string, unknown>;
  }) {
    const conversation = this.#loadConversation(args.workspaceId, args.conversationId);
    const existing = this.deps.db.select().from(schema.conversationMessages)
      .where(and(
        eq(schema.conversationMessages.workspaceId, args.workspaceId),
        eq(schema.conversationMessages.conversationId, args.conversationId),
        eq(schema.conversationMessages.id, args.messageId),
      )).get();
    if (!existing) throw new AgentisError('RESOURCE_NOT_FOUND', `message ${args.messageId} not found`);
    const metadata = {
      ...(existing.metadata && typeof existing.metadata === 'object' ? existing.metadata as Record<string, unknown> : {}),
      ...(args.metadata ?? {}),
    };
    this.deps.db.update(schema.conversationMessages).set({ deliveryStatus: args.deliveryStatus, metadata })
      .where(eq(schema.conversationMessages.id, args.messageId)).run();
    const message = { ...existing, deliveryStatus: args.deliveryStatus, metadata };
    this.deps.bus.publish(
      REALTIME_ROOMS.conversation(conversation.agentId),
      REALTIME_EVENTS.CONVERSATION_MESSAGE_UPDATED,
      { message, conversationId: args.conversationId, agentId: conversation.agentId },
    );
    return message;
  }

  /** Append a platform-authored system message to an existing thread. */
  appendSystem(args: {
    workspaceId: string;
    conversationId: string;
    body: string;
    metadata?: Record<string, unknown>;
    sessionMessageId?: string | null;
    deliveryStatus?: 'delivered' | 'mirrored';
  }) {
    return this.#append({
      conversationId: args.conversationId,
      workspaceId: args.workspaceId,
      authorType: 'system',
      authorId: null,
      sessionMessageId: args.sessionMessageId ?? null,
      body: args.body,
      metadata: args.metadata,
      deliveryStatus: args.deliveryStatus ?? 'delivered',
      eventName: REALTIME_EVENTS.CONVERSATION_MESSAGE_RECEIVED,
    });
  }

  markRead(workspaceId: string, conversationId: string) {
    this.deps.db
      .update(schema.conversations)
      .set({ unreadCount: 0 })
      .where(
        and(
          eq(schema.conversations.workspaceId, workspaceId),
          eq(schema.conversations.id, conversationId),
        ),
      )
      .run();
  }

  getById(workspaceId: string, conversationId: string) {
    return this.#loadConversation(workspaceId, conversationId);
  }

  startNewConversation(args: {
    workspaceId: string;
    ambientId: string | null;
    userId: string;
    agentId: string;
  }) {
    const current = this.getOrCreateByAgent(args);
    const latestMessages = this.messages(current.id, 2);
    if (latestMessages.length === 0) return current;

    const now = new Date().toISOString();
    const firstOperator = this.deps.db
      .select()
      .from(schema.conversationMessages)
      .where(and(
        eq(schema.conversationMessages.workspaceId, args.workspaceId),
        eq(schema.conversationMessages.conversationId, current.id),
        eq(schema.conversationMessages.authorType, 'operator'),
      ))
      .orderBy(schema.conversationMessages.createdAt, sql<number>`rowid`)
      .limit(1)
      .get();
    this.deps.db
      .update(schema.conversations)
      .set({
        title: conversationTitle(firstOperator?.body ?? latestMessages[0]?.body ?? null),
        unreadCount: 0,
        updatedAt: now,
      })
      .where(eq(schema.conversations.id, current.id))
      .run();

    const row = {
      id: randomUUID(),
      workspaceId: args.workspaceId,
      ambientId: args.ambientId,
      userId: args.userId,
      agentId: args.agentId,
      mirroredSessionId: null,
      channelConnectionId: null,
      channelChatId: null,
      title: null,
      archivedAt: null,
      unreadCount: 0,
      lastMessageAt: null,
    };
    this.deps.db.insert(schema.conversations).values(row).run();
    return this.#loadConversation(args.workspaceId, row.id);
  }

  #append(args: {
    conversationId: string;
    workspaceId: string;
    authorType: 'operator' | 'agent' | 'system';
    authorId: string | null;
    participantSide?: 'customer' | 'business' | null;
    sessionMessageId: string | null;
    body: string;
    metadata?: Record<string, unknown>;
    deliveryStatus: 'sending' | 'sent' | 'delivered' | 'failed' | 'mirrored';
    eventName: RealtimeEventName;
    occurredAt?: string;
    incrementUnread?: boolean;
    publishRealtime?: boolean;
  }) {
    if (!args.body || args.body.length === 0) {
      throw new AgentisError('VALIDATION_FAILED', 'Conversation message body required');
    }
    const conversation = this.deps.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, args.conversationId))
      .get();
    if (!conversation || conversation.workspaceId !== args.workspaceId) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `conversation ${args.conversationId} not found`);
    }
    // Idempotency: if a mirrored message with the same sessionMessageId
    // already exists, return it instead of inserting a duplicate.
    if (args.sessionMessageId) {
      const existing = this.deps.db
        .select()
        .from(schema.conversationMessages)
        .where(
          and(
            eq(schema.conversationMessages.conversationId, args.conversationId),
            eq(schema.conversationMessages.sessionMessageId, args.sessionMessageId),
          ),
        )
        .get();
      if (existing) return existing;
    }
    const now = new Date().toISOString();
    const occurredAt = args.occurredAt && !Number.isNaN(Date.parse(args.occurredAt))
      ? new Date(args.occurredAt).toISOString()
      : now;
    const row = {
      id: randomUUID(),
      conversationId: args.conversationId,
      workspaceId: args.workspaceId,
      authorType: args.authorType,
      authorId: args.authorId,
      participantSide: args.participantSide ?? null,
      sessionMessageId: args.sessionMessageId,
      body: args.body,
      metadata: args.metadata ?? {},
      deliveryStatus: args.deliveryStatus,
      createdAt: occurredAt,
    };
    this.deps.db.insert(schema.conversationMessages).values(row).run();
    this.deps.db
      .update(schema.conversations)
      .set({
        lastMessageAt: !conversation.lastMessageAt || occurredAt > conversation.lastMessageAt ? occurredAt : conversation.lastMessageAt,
        unreadCount: args.incrementUnread === false
          ? conversation.unreadCount
          : args.authorType === 'operator' ? conversation.unreadCount : conversation.unreadCount + 1,
        updatedAt: now,
      })
      .where(eq(schema.conversations.id, args.conversationId))
      .run();
    if (args.publishRealtime !== false) {
      this.deps.bus.publish(
        REALTIME_ROOMS.conversation(conversation.agentId),
        args.eventName,
        { message: row, conversationId: args.conversationId, agentId: conversation.agentId },
      );
    }
    return row;
  }

  updateSession(workspaceId: string, conversationId: string, fields: { title?: string | null; archived?: boolean }) {
    const conversation = this.#loadConversation(workspaceId, conversationId);
    const now = new Date().toISOString();
    const updateData: Record<string, any> = { updatedAt: now };

    if (fields.title !== undefined) {
      updateData.title = fields.title;
    }
    if (fields.archived !== undefined) {
      updateData.archivedAt = fields.archived ? now : null;
    }

    this.deps.db
      .update(schema.conversations)
      .set(updateData)
      .where(eq(schema.conversations.id, conversationId))
      .run();

    return { ...conversation, ...updateData };
  }

  deleteConversation(workspaceId: string, conversationId: string) {
    const conversation = this.#loadConversation(workspaceId, conversationId);

    this.deps.db
      .delete(schema.conversations)
      .where(and(
        eq(schema.conversations.workspaceId, workspaceId),
        eq(schema.conversations.id, conversationId)
      ))
      .run();
  }

  /**
   * Queue-then-auto-continue composer (§ChatComposerQueue). List the still-
   * pending messages queued while a turn was streaming, oldest first —
   * surfaced on load so a page reload never silently drops them.
   */
  listQueue(workspaceId: string, conversationId: string) {
    return this.deps.db
      .select()
      .from(schema.conversationMessageQueue)
      .where(and(
        eq(schema.conversationMessageQueue.workspaceId, workspaceId),
        eq(schema.conversationMessageQueue.conversationId, conversationId),
        eq(schema.conversationMessageQueue.status, 'pending'),
      ))
      .orderBy(schema.conversationMessageQueue.position, schema.conversationMessageQueue.createdAt)
      .all();
  }

  /** Durably queue a message sent while the conversation's turn is still streaming. */
  enqueueMessage(args: {
    workspaceId: string;
    conversationId: string;
    text: string;
    attachments?: unknown;
  }) {
    const conversation = this.#loadConversation(args.workspaceId, args.conversationId);
    const last = this.deps.db
      .select()
      .from(schema.conversationMessageQueue)
      .where(eq(schema.conversationMessageQueue.conversationId, args.conversationId))
      .orderBy(desc(schema.conversationMessageQueue.position))
      .limit(1)
      .get();
    const row = {
      id: randomUUID(),
      conversationId: args.conversationId,
      workspaceId: args.workspaceId,
      text: args.text,
      attachments: args.attachments ?? null,
      createdAt: new Date().toISOString(),
      position: (last?.position ?? -1) + 1,
      status: 'pending' as const,
    };
    this.deps.db.insert(schema.conversationMessageQueue).values(row).run();
    this.deps.bus.publish(
      REALTIME_ROOMS.conversation(conversation.agentId),
      REALTIME_EVENTS.CONVERSATION_QUEUE_UPDATED,
      { conversationId: args.conversationId, agentId: conversation.agentId, item: row, action: 'added' },
    );
    return row;
  }

  /** Cancel a still-pending queued message before it dispatches. */
  discardQueuedMessage(args: { workspaceId: string; conversationId: string; queueId: string }) {
    const conversation = this.#loadConversation(args.workspaceId, args.conversationId);
    const existing = this.deps.db
      .select()
      .from(schema.conversationMessageQueue)
      .where(and(
        eq(schema.conversationMessageQueue.id, args.queueId),
        eq(schema.conversationMessageQueue.conversationId, args.conversationId),
        eq(schema.conversationMessageQueue.workspaceId, args.workspaceId),
      ))
      .get();
    if (!existing) throw new AgentisError('RESOURCE_NOT_FOUND', `queued message ${args.queueId} not found`);
    if (existing.status !== 'pending') return existing;
    this.deps.db
      .update(schema.conversationMessageQueue)
      .set({ status: 'discarded' })
      .where(eq(schema.conversationMessageQueue.id, args.queueId))
      .run();
    const row = { ...existing, status: 'discarded' as const };
    this.deps.bus.publish(
      REALTIME_ROOMS.conversation(conversation.agentId),
      REALTIME_EVENTS.CONVERSATION_QUEUE_UPDATED,
      { conversationId: args.conversationId, agentId: conversation.agentId, item: row, action: 'discarded' },
    );
    return row;
  }

  /** Mark a queued message as consumed by a live task/companion lane. Idempotent. */
  consumeQueuedMessage(args: { workspaceId: string; conversationId: string; queueId: string }) {
    const conversation = this.#loadConversation(args.workspaceId, args.conversationId);
    const existing = this.deps.db
      .select()
      .from(schema.conversationMessageQueue)
      .where(and(
        eq(schema.conversationMessageQueue.id, args.queueId),
        eq(schema.conversationMessageQueue.conversationId, args.conversationId),
        eq(schema.conversationMessageQueue.workspaceId, args.workspaceId),
      ))
      .get();
    if (!existing) throw new AgentisError('RESOURCE_NOT_FOUND', `queued message ${args.queueId} not found`);
    if (existing.status !== 'pending') return existing;
    this.deps.db.update(schema.conversationMessageQueue)
      .set({ status: 'sent' })
      .where(eq(schema.conversationMessageQueue.id, args.queueId))
      .run();
    const row = { ...existing, status: 'sent' as const };
    this.deps.bus.publish(
      REALTIME_ROOMS.conversation(conversation.agentId),
      REALTIME_EVENTS.CONVERSATION_QUEUE_UPDATED,
      { conversationId: args.conversationId, agentId: conversation.agentId, item: row, action: 'dispatched' },
    );
    return row;
  }

  /** Discard every pending composer message when the operator stops all work. */
  discardPendingQueue(args: { workspaceId: string; conversationId: string }) {
    const conversation = this.#loadConversation(args.workspaceId, args.conversationId);
    const pending = this.listQueue(args.workspaceId, args.conversationId);
    if (pending.length === 0) return [];
    this.deps.db
      .update(schema.conversationMessageQueue)
      .set({ status: 'discarded' })
      .where(and(
        eq(schema.conversationMessageQueue.workspaceId, args.workspaceId),
        eq(schema.conversationMessageQueue.conversationId, args.conversationId),
        eq(schema.conversationMessageQueue.status, 'pending'),
      ))
      .run();
    const rows = pending.map((item) => ({ ...item, status: 'discarded' as const }));
    for (const row of rows) {
      this.deps.bus.publish(
        REALTIME_ROOMS.conversation(conversation.agentId),
        REALTIME_EVENTS.CONVERSATION_QUEUE_UPDATED,
        { conversationId: args.conversationId, agentId: conversation.agentId, item: row, action: 'discarded' },
      );
    }
    return rows;
  }

  /**
   * Pop the oldest pending queued message (marking it `sent`) and announce it
   * on the realtime bus so the client auto-continues with a fresh turn. Called
   * once a turn's SSE stream ends. Returns null when the queue is empty.
   */
  dispatchNextQueued(args: { workspaceId: string; conversationId: string }) {
    const conversation = this.#loadConversation(args.workspaceId, args.conversationId);
    const next = this.deps.db
      .select()
      .from(schema.conversationMessageQueue)
      .where(and(
        eq(schema.conversationMessageQueue.workspaceId, args.workspaceId),
        eq(schema.conversationMessageQueue.conversationId, args.conversationId),
        eq(schema.conversationMessageQueue.status, 'pending'),
      ))
      .orderBy(schema.conversationMessageQueue.position, schema.conversationMessageQueue.createdAt)
      .limit(1)
      .get();
    if (!next) return null;
    this.deps.db
      .update(schema.conversationMessageQueue)
      .set({ status: 'sent' })
      .where(eq(schema.conversationMessageQueue.id, next.id))
      .run();
    const row = { ...next, status: 'sent' as const };
    this.deps.bus.publish(
      REALTIME_ROOMS.conversation(conversation.agentId),
      REALTIME_EVENTS.CONVERSATION_QUEUE_UPDATED,
      { conversationId: args.conversationId, agentId: conversation.agentId, item: row, action: 'dispatched' },
    );
    return row;
  }

  #loadConversation(workspaceId: string, conversationId: string) {
    const conversation = this.deps.db
      .select()
      .from(schema.conversations)
      .where(and(
        eq(schema.conversations.workspaceId, workspaceId),
        eq(schema.conversations.id, conversationId),
      ))
      .get();
    if (!conversation) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `conversation ${conversationId} not found`);
    }
    return conversation;
  }
}

function conversationTitle(body: string | null): string {
  const text = (body ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return 'Previous conversation';
  return text.length > 64 ? `${text.slice(0, 61).trim()}...` : text;
}
