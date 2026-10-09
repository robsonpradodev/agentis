import { and, desc, eq, inArray } from 'drizzle-orm';
import { AgentisError, type ChannelInboxPeer, type ChannelRecipientRef } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { ChannelIdentityService, PeerIdentity } from './channelIdentityService.js';
import { normalizeHandle } from './channelAccess.js';

export interface InboxPage {
  peers: ChannelInboxPeer[];
  nextCursor: string | null;
}

export type RecipientResolution =
  | { resolved: true; peer: ChannelInboxPeer; to: string }
  | { resolved: false; reason: 'not_found' | 'ambiguous'; candidates: ChannelInboxPeer[] };

/** Read-only, canonical view over every conversation carried by a connection. */
export class ChannelInboxService {
  constructor(private readonly deps: { db: AgentisSqliteDb; identities: ChannelIdentityService }) {}

  list(args: {
    workspaceId: string;
    connectionId?: string | null;
    query?: string | null;
    excludeOwner?: boolean;
    limit?: number;
    cursor?: string | null;
  }): InboxPage {
    const limit = Math.max(1, Math.min(50, args.limit ?? 20));
    const identities = this.deps.identities.list(args.workspaceId)
      .filter((identity) => !args.connectionId || identity.connectionId === args.connectionId)
      .filter((identity) => !identity.blocked)
      .filter((identity) => !args.excludeOwner || identity.authorityRole !== 'owner')
      .filter((identity) => isDirectPeer(identity.handle))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      // Provider accounts can accumulate a very large address book. Project a
      // recent working set before loading messages/relationship state; cursors
      // still paginate the ordered result while keeping owner commands fast.
      .slice(0, Math.max(50, Math.min(150, limit * 4)));
    const rows = identities.map((identity) => this.#project(identity));
    const query = args.query?.trim().toLowerCase();
    const searched = query
      ? rows.filter((row) => this.#searchText(row).includes(query) || normalizeHandle(this.#searchText(row)).includes(normalizeHandle(query)))
      : rows;
    searched.sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '') || a.peerIdentityId.localeCompare(b.peerIdentityId));
    const cursor = decodeCursor(args.cursor);
    const after = cursor
      ? searched.filter((row) => (row.lastMessageAt ?? '') < cursor.at || ((row.lastMessageAt ?? '') === cursor.at && row.peerIdentityId > cursor.id))
      : searched;
    const page = after.slice(0, limit);
    const tail = page.at(-1);
    return {
      peers: page,
      nextCursor: after.length > page.length && tail ? encodeCursor(tail.lastMessageAt ?? '', tail.peerIdentityId) : null,
    };
  }

  get(workspaceId: string, recipientRef: string): ChannelInboxPeer | null {
    const id = parseRecipientRef(recipientRef);
    if (!id) return null;
    const identity = this.deps.db.select().from(schema.channelPeerIdentities).where(and(
      eq(schema.channelPeerIdentities.workspaceId, workspaceId),
      eq(schema.channelPeerIdentities.id, id),
    )).get();
    return identity ? this.#project(identity as PeerIdentity) : null;
  }

  history(workspaceId: string, recipientRef: string, limit = 30) {
    const peer = this.get(workspaceId, recipientRef);
    if (!peer) throw new AgentisError('RESOURCE_NOT_FOUND', 'channel recipient not found');
    const conversations = this.deps.db.select({ id: schema.conversations.id }).from(schema.conversations).where(and(
      eq(schema.conversations.workspaceId, workspaceId),
      eq(schema.conversations.channelPeerIdentityId, peer.peerIdentityId),
    )).all();
    if (conversations.length === 0) return [];
    return this.deps.db.select({
      id: schema.conversationMessages.id,
      conversationId: schema.conversationMessages.conversationId,
      body: schema.conversationMessages.body,
      participantSide: schema.conversationMessages.participantSide,
      authorType: schema.conversationMessages.authorType,
      createdAt: schema.conversationMessages.createdAt,
      deliveryStatus: schema.conversationMessages.deliveryStatus,
    }).from(schema.conversationMessages).where(and(
      eq(schema.conversationMessages.workspaceId, workspaceId),
      inArray(schema.conversationMessages.conversationId, conversations.map((row) => row.id)),
    )).orderBy(desc(schema.conversationMessages.createdAt)).limit(Math.max(1, Math.min(100, limit))).all().reverse();
  }

  resolve(args: {
    workspaceId: string;
    connectionId?: string | null;
    recipientRef?: string | null;
    conversationId?: string | null;
    query?: string | null;
    selector?: 'last_inbound' | 'last_contact';
  }): RecipientResolution {
    if (args.recipientRef) {
      const peer = this.get(args.workspaceId, args.recipientRef);
      return peer && (!args.connectionId || peer.connectionId === args.connectionId)
        ? { resolved: true, peer, to: this.preferredAddress(peer.peerIdentityId) }
        : { resolved: false, reason: 'not_found', candidates: [] };
    }
    if (args.conversationId) {
      const conversation = this.deps.db.select().from(schema.conversations).where(and(
        eq(schema.conversations.workspaceId, args.workspaceId),
        eq(schema.conversations.id, args.conversationId),
      )).get();
      if (conversation?.channelPeerIdentityId) {
        const peer = this.get(args.workspaceId, `peer:${conversation.channelPeerIdentityId}`);
        if (peer) return { resolved: true, peer, to: this.preferredAddress(peer.peerIdentityId) };
      }
    }
    const page = this.list({
      workspaceId: args.workspaceId,
      connectionId: args.connectionId,
      query: args.query,
      excludeOwner: true,
      limit: 50,
    }).peers;
    if (args.selector === 'last_inbound' || args.selector === 'last_contact') {
      const latest = args.selector === 'last_contact'
        ? page[0]
        : [...page].filter((peer) => peer.lastInboundAt).sort((a, b) => (b.lastInboundAt ?? '').localeCompare(a.lastInboundAt ?? ''))[0];
      return latest
        ? { resolved: true, peer: latest, to: this.preferredAddress(latest.peerIdentityId) }
        : { resolved: false, reason: 'not_found', candidates: [] };
    }
    if (page.length === 1) return { resolved: true, peer: page[0]!, to: this.preferredAddress(page[0]!.peerIdentityId) };
    return { resolved: false, reason: page.length > 1 ? 'ambiguous' : 'not_found', candidates: page.slice(0, 8) };
  }

  preferredAddress(peerIdentityId: string): string {
    const aliases = this.deps.identities.aliases(peerIdentityId);
    const rank = (kind: string) => ({ pn: 0, phone: 1, primary: 2, username: 3, provider: 4, lid: 8 }[kind] ?? 6);
    const preferred = [...aliases].sort((a, b) => Number(b.verified) - Number(a.verified) || rank(a.kind) - rank(b.kind))[0]?.value;
    if (preferred) return preferred;
    const identity = this.deps.db.select({ handle: schema.channelPeerIdentities.handle }).from(schema.channelPeerIdentities)
      .where(eq(schema.channelPeerIdentities.id, peerIdentityId)).get();
    if (!identity) throw new AgentisError('RESOURCE_NOT_FOUND', 'channel recipient address not found');
    return identity.handle;
  }

  /** Resolve an observed address into the canonical inbox, creating only the identity record (never sending). */
  ensurePeer(args: { workspaceId: string; connectionId: string; channelKind: string; address: string; displayName?: string | null }): ChannelInboxPeer {
    const identity = this.deps.identities.observeAliases({
      workspaceId: args.workspaceId, connectionId: args.connectionId, channelKind: args.channelKind,
      primaryHandle: args.address, aliases: [args.address], displayName: args.displayName ?? undefined,
      source: 'verified_owner', verified: true, countMessage: false,
    });
    return this.#project(identity);
  }

  compactWorld(workspaceId: string, connectionId: string, limit = 6): string | null {
    const peers = this.list({ workspaceId, connectionId, excludeOwner: true, limit }).peers;
    if (peers.length === 0) return null;
    return [
      'CHANNEL WORLD — recent contacts on this connection (canonical, newest first)',
      ...peers.map((peer, index) => `${index + 1}. ${peer.displayName ?? 'Unknown contact'} [${peer.recipientRef}] — last inbound ${peer.lastInboundAt ?? 'none'}; last outbound ${peer.lastOutboundAt ?? 'none'}; latest: ${JSON.stringify(peer.lastMessagePreview ?? '')}`),
      'Resolve names or “last contact” with agentis.channel.inbox. Send using recipientRef; never ask for a phone/JID when a recipientRef resolves.',
    ].join('\n');
  }

  #project(identity: PeerIdentity): ChannelInboxPeer {
    const conversations = this.deps.db.select().from(schema.conversations).where(and(
      eq(schema.conversations.workspaceId, identity.workspaceId),
      eq(schema.conversations.channelPeerIdentityId, identity.id),
    )).orderBy(desc(schema.conversations.lastMessageAt), desc(schema.conversations.createdAt)).all();
    // Migration/runtime compatibility for an identity not linked onto its legacy conversation yet.
    if (conversations.length === 0 && identity.connectionId) {
      const legacy = this.deps.db.select().from(schema.conversations).where(and(
        eq(schema.conversations.workspaceId, identity.workspaceId),
        eq(schema.conversations.channelConnectionId, identity.connectionId),
        eq(schema.conversations.channelChatId, identity.handle),
      )).orderBy(desc(schema.conversations.lastMessageAt)).all();
      for (const row of legacy) {
        this.deps.db.update(schema.conversations).set({ channelPeerIdentityId: identity.id, updatedAt: new Date().toISOString() })
          .where(eq(schema.conversations.id, row.id)).run();
        conversations.push({ ...row, channelPeerIdentityId: identity.id });
      }
    }
    const ids = conversations.map((row) => row.id);
    const messages = ids.length ? this.deps.db.select().from(schema.conversationMessages).where(and(
      eq(schema.conversationMessages.workspaceId, identity.workspaceId),
      inArray(schema.conversationMessages.conversationId, ids),
    )).orderBy(desc(schema.conversationMessages.createdAt)).limit(120).all() : [];
    const inbound = messages.find((message) => message.participantSide === 'customer');
    const outbound = messages.find((message) => message.participantSide === 'business');
    const latest = messages[0];
    const subject = identity.groundingEntityId
      ? this.deps.db.select().from(schema.durableEntities).where(eq(schema.durableEntities.id, identity.groundingEntityId)).get()
      : null;
    const state = subject?.stateJson && typeof subject.stateJson === 'object' && !Array.isArray(subject.stateJson)
      ? subject.stateJson as Record<string, unknown> : {};
    const engagements = Array.isArray(state.engagements) ? state.engagements as Array<Record<string, unknown>> : [];
    const active = engagements.find((item) => item.status === 'active') ?? engagements[0];
    const aliases = this.deps.identities.aliases(identity.id);
    return {
      recipientRef: `peer:${identity.id}` as ChannelRecipientRef,
      peerIdentityId: identity.id,
      connectionId: identity.connectionId ?? conversations[0]?.channelConnectionId ?? '',
      channelKind: identity.channelKind,
      displayName: identity.displayName ?? null,
      conversationId: conversations[0]?.id ?? null,
      lastInboundAt: inbound?.createdAt ?? null,
      lastOutboundAt: outbound?.createdAt ?? null,
      lastMessageAt: latest?.createdAt ?? conversations[0]?.lastMessageAt ?? identity.lastSeenAt,
      lastMessagePreview: latest?.body ? latest.body.slice(0, 240) : null,
      lastMessageDirection: latest ? latest.participantSide === 'customer' ? 'inbound' : 'outbound' : null,
      handoffState: conversations[0]?.handoffState ?? null,
      subjectId: identity.groundingEntityId,
      stage: typeof active?.stage === 'string' ? active.stage : null,
      goal: typeof active?.goal === 'string' ? active.goal : null,
      aliases,
      authorityRole: identity.authorityRole,
    };
  }

  /**
   * The workspace's verified staff on this connection (or every connection when
   * omitted) — the owner plus any granted delegates, expired grants excluded.
   * This is the "who is my team" primitive: it gives an agent a stable
   * recipientRef for escalating or reporting, instead of only recognizing staff
   * reactively when they happen to message in.
   */
  team(workspaceId: string, connectionId?: string | null): ChannelInboxPeer[] {
    const now = Date.now();
    return this.deps.identities.list(workspaceId)
      .filter((identity) => identity.authorityRole !== 'external')
      .filter((identity) => !identity.grantExpiresAt || Date.parse(identity.grantExpiresAt) > now)
      .filter((identity) => !connectionId || identity.connectionId === connectionId)
      .map((identity) => this.#project(identity))
      .sort((a, b) => (a.authorityRole === b.authorityRole ? 0 : a.authorityRole === 'owner' ? -1 : 1));
  }

  #searchText(peer: ChannelInboxPeer): string {
    return [peer.displayName, peer.recipientRef, ...peer.aliases.map((alias) => alias.value)].filter(Boolean).join(' ').toLowerCase();
  }
}

export function parseRecipientRef(value: string | null | undefined): string | null {
  const match = /^peer:([0-9a-z-]+)$/i.exec(value?.trim() ?? '');
  return match?.[1] ?? null;
}

function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify({ at, id }), 'utf8').toString('base64url');
}

function decodeCursor(value: string | null | undefined): { at: string; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { at?: unknown; id?: unknown };
    return typeof parsed.at === 'string' && typeof parsed.id === 'string' ? { at: parsed.at, id: parsed.id } : null;
  } catch {
    return null;
  }
}

function isDirectPeer(handle: string): boolean {
  const normalized = handle.trim().toLowerCase();
  return normalized !== 'status@broadcast'
    && !normalized.endsWith('@g.us')
    && !normalized.endsWith('@broadcast')
    && !normalized.endsWith('@newsletter');
}
