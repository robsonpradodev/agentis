/**
 * ChannelIdentityService — cross-surface peer identity (OMNICHANNEL §5.2).
 *
 * Every inbound channel message is recorded against a (workspace, channelKind,
 * handle) identity. The operator can opt-in link a handle to a workspace user,
 * which assigns a stable `peerKey` (`user:<id>`) — so the same human is
 * recognized across WhatsApp, Telegram, and Slack. The orchestrator surfaces a
 * short "who is this" summary into the channel context on each turn.
 *
 * `handle` is the most stable per-channel sender address available to the
 * dispatcher: for 1:1 DMs (WhatsApp/Telegram) that is the chat address; for
 * Slack it is the thread address (the channel-side conversation key). Linking is
 * what makes the cross-channel unification precise.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, ne, or } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../../logger.js';
import type { ChannelAuthorityRole, PrincipalContext } from '@agentis/core';
import { normalizeHandle } from './channelAccess.js';

export interface PeerIdentity {
  id: string;
  workspaceId: string;
  channelKind: string;
  connectionId: string | null;
  handle: string;
  displayName: string | null;
  userId: string | null;
  peerKey: string | null;
  groundingEntityId: string | null;
  authorityRole: ChannelAuthorityRole;
  authorityMethod: string | null;
  verifiedAt: string | null;
  grantExpiresAt: string | null;
  /** Operator-blocked: inbound turns from this handle are silently ignored. */
  blocked: boolean;
  messageCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ObservedPeerAliases {
  workspaceId: string;
  connectionId: string;
  channelKind: string;
  primaryHandle: string;
  aliases?: string[];
  displayName?: string;
  source?: string;
  verified?: boolean;
  countMessage?: boolean;
}

export class ChannelIdentityService {
  constructor(private readonly deps: { db: AgentisSqliteDb; logger?: Logger }) {}

  /** Record an inbound message against its peer identity (upsert). */
  record(args: { workspaceId: string; connectionId?: string | null; channelKind: string; handle: string; displayName?: string }): PeerIdentity {
    const now = new Date().toISOString();
    const existing = this.#find(args.workspaceId, args.channelKind, args.handle, args.connectionId ?? null);
    if (existing) {
      const claimedConnectionId = args.connectionId && existing.connectionId === null ? args.connectionId : existing.connectionId;
      this.deps.db
        .update(schema.channelPeerIdentities)
        .set({
          ...(claimedConnectionId !== existing.connectionId ? { connectionId: claimedConnectionId } : {}),
          messageCount: existing.messageCount + 1,
          lastSeenAt: now,
          ...(args.displayName ? { displayName: args.displayName } : {}),
        })
        .where(eq(schema.channelPeerIdentities.id, existing.id))
        .run();
      const updated = { ...existing, connectionId: claimedConnectionId, messageCount: existing.messageCount + 1, lastSeenAt: now, displayName: args.displayName ?? existing.displayName };
      if (updated.connectionId) this.#upsertAlias(updated, args.handle, 'primary', 'record', Boolean(updated.verifiedAt), args.displayName);
      return updated;
    }
    const row = {
      id: randomUUID(),
      workspaceId: args.workspaceId,
      channelKind: args.channelKind,
      connectionId: args.connectionId ?? null,
      handle: args.handle,
      displayName: args.displayName ?? null,
      userId: null,
      peerKey: null,
      groundingEntityId: null,
      authorityRole: 'external' as const,
      authorityMethod: null,
      verifiedAt: null,
      grantExpiresAt: null,
      blocked: false,
      messageCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    };
    // History reconciliation and a live event can observe the same new peer at
    // once. The unique key arbitrates; re-read instead of surfacing SQLite's
    // constraint error to the customer conversation.
    this.deps.db.insert(schema.channelPeerIdentities).values(row).onConflictDoNothing().run();
    const created = this.#find(args.workspaceId, args.channelKind, args.handle, args.connectionId ?? null) ?? row;
    if (created.connectionId) this.#upsertAlias(created, args.handle, 'primary', 'record', Boolean(created.verifiedAt), args.displayName);
    return created;
  }

  resolve(workspaceId: string, channelKind: string, handle: string, connectionId?: string | null): PeerIdentity | null {
    return this.#find(workspaceId, channelKind, handle, connectionId ?? null);
  }

  /** Fold every provider address known for one person into one canonical peer. */
  observeAliases(args: ObservedPeerAliases): PeerIdentity {
    const handles = [...new Set([args.primaryHandle, ...(args.aliases ?? [])].map((value) => value.trim()).filter(Boolean))];
    const matches = handles
      .map((handle) => this.#find(args.workspaceId, args.channelKind, handle, args.connectionId))
      .filter((value): value is PeerIdentity => Boolean(value));
    const canonical = this.#chooseCanonical(matches) ?? this.record({
      workspaceId: args.workspaceId,
      connectionId: args.connectionId,
      channelKind: args.channelKind,
      handle: args.primaryHandle,
      ...(args.displayName ? { displayName: args.displayName } : {}),
    });
    for (const match of matches) if (match.id !== canonical.id) this.#mergePeer(canonical, match);

    const now = new Date().toISOString();
    const current = this.deps.db.select().from(schema.channelPeerIdentities)
      .where(eq(schema.channelPeerIdentities.id, canonical.id)).get() as PeerIdentity;
    this.deps.db.update(schema.channelPeerIdentities).set({
      ...(args.displayName ? { displayName: args.displayName } : {}),
      lastSeenAt: now,
      ...(args.countMessage === false ? {} : { messageCount: current.messageCount + 1 }),
    }).where(eq(schema.channelPeerIdentities.id, canonical.id)).run();
    for (const handle of handles) {
      this.#upsertAlias(canonical, handle, aliasKind(handle, args.primaryHandle), args.source ?? 'provider_observed', Boolean(args.verified), args.displayName);
    }
    return {
      ...current,
      displayName: args.displayName ?? current.displayName,
      lastSeenAt: now,
      messageCount: args.countMessage === false ? current.messageCount : current.messageCount + 1,
    };
  }

  aliases(identityId: string): Array<{ value: string; kind: string; verified: boolean }> {
    return this.deps.db.select().from(schema.channelPeerAliases)
      .where(eq(schema.channelPeerAliases.peerIdentityId, identityId))
      .orderBy(desc(schema.channelPeerAliases.verified), desc(schema.channelPeerAliases.lastSeenAt))
      .all()
      .map((row) => ({ value: row.alias, kind: row.aliasKind, verified: row.verified }));
  }

  list(workspaceId: string): PeerIdentity[] {
    return this.deps.db
      .select()
      .from(schema.channelPeerIdentities)
      .where(eq(schema.channelPeerIdentities.workspaceId, workspaceId))
      .all() as PeerIdentity[];
  }

  /** Block/unblock a sender: a blocked handle's inbound turns are silently
   *  ignored by the dispatcher (never reaches an agent). Creates the identity row
   *  if the handle hasn't been seen yet, so an operator can pre-block. */
  setBlocked(args: { workspaceId: string; connectionId?: string | null; channelKind: string; handle: string; blocked: boolean }): PeerIdentity {
    const existing = this.#find(args.workspaceId, args.channelKind, args.handle, args.connectionId ?? null);
    if (existing) {
      this.deps.db
        .update(schema.channelPeerIdentities)
        .set({ blocked: args.blocked })
        .where(eq(schema.channelPeerIdentities.id, existing.id))
        .run();
      return { ...existing, blocked: args.blocked };
    }
    const now = new Date().toISOString();
    const row: PeerIdentity = {
      id: randomUUID(), workspaceId: args.workspaceId, channelKind: args.channelKind, connectionId: args.connectionId ?? null, handle: args.handle,
      displayName: null, userId: null, peerKey: null, groundingEntityId: null,
      authorityRole: 'external', authorityMethod: null, verifiedAt: null, grantExpiresAt: null,
      blocked: args.blocked, messageCount: 0, firstSeenAt: now, lastSeenAt: now,
    };
    this.deps.db.insert(schema.channelPeerIdentities).values(row).run();
    return row;
  }

  /** True if this sender is blocked (dispatcher gate). Cheap single-row read. */
  isBlocked(workspaceId: string, channelKind: string, handle: string, connectionId?: string | null): boolean {
    return Boolean(this.#find(workspaceId, channelKind, handle, connectionId ?? null)?.blocked);
  }

  /** Opt-in: link a handle to a workspace user, unifying it across channels. */
  link(args: { workspaceId: string; connectionId?: string | null; channelKind: string; handle: string; userId: string | null }): PeerIdentity | null {
    const existing = this.#find(args.workspaceId, args.channelKind, args.handle, args.connectionId ?? null);
    if (!existing) return null;
    const peerKey = args.userId ? `user:${args.userId}` : null;
    this.deps.db
      .update(schema.channelPeerIdentities)
      .set({ userId: args.userId, peerKey })
      .where(eq(schema.channelPeerIdentities.id, existing.id))
      .run();
    if (peerKey) this.#unifyGrounding(args.workspaceId, peerKey);
    return this.#find(args.workspaceId, args.channelKind, args.handle, args.connectionId ?? null);
  }

  /** Bind authority explicitly. Owner is singular per workspace; delegates may be scoped and expire. */
  grantAuthority(args: {
    workspaceId: string;
    connectionId: string;
    channelKind: string;
    handle: string;
    role: Exclude<ChannelAuthorityRole, 'external'>;
    userId?: string | null;
    method: string;
    expiresAt?: string | null;
  }): PeerIdentity {
    const identity = this.record(args);
    const now = new Date().toISOString();
    if (args.role === 'owner') {
      this.deps.db.update(schema.channelPeerIdentities).set({
        authorityRole: 'external', authorityMethod: null, verifiedAt: null, grantExpiresAt: null,
      }).where(and(
        eq(schema.channelPeerIdentities.workspaceId, args.workspaceId),
        eq(schema.channelPeerIdentities.connectionId, args.connectionId),
        eq(schema.channelPeerIdentities.authorityRole, 'owner'),
        args.userId
          ? or(isNull(schema.channelPeerIdentities.userId), ne(schema.channelPeerIdentities.userId, args.userId))!
          : undefined,
      )).run();
    }
    const peerKey = args.userId ? `user:${args.userId}` : identity.peerKey;
    this.deps.db.update(schema.channelPeerIdentities).set({
      authorityRole: args.role,
      authorityMethod: args.method,
      verifiedAt: now,
      grantExpiresAt: args.expiresAt ?? null,
      ...(args.userId !== undefined ? { userId: args.userId, peerKey } : {}),
    }).where(eq(schema.channelPeerIdentities.id, identity.id)).run();
    const granted = this.#find(args.workspaceId, args.channelKind, args.handle, args.connectionId)!;
    this.#upsertAlias(granted, args.handle, 'primary', args.method, true, granted.displayName ?? undefined);
    return granted;
  }

  /** Transaction-friendly owner configuration hook used at the connection write boundary. */
  syncConfiguredOwner(args: { workspaceId: string; connectionId: string; channelKind: string; handle: string | null; userId: string; displayName?: string | null }): PeerIdentity | null {
    const now = new Date().toISOString();
    const owners = this.deps.db.select().from(schema.channelPeerIdentities).where(and(
      eq(schema.channelPeerIdentities.workspaceId, args.workspaceId),
      eq(schema.channelPeerIdentities.connectionId, args.connectionId),
      eq(schema.channelPeerIdentities.channelKind, args.channelKind),
      eq(schema.channelPeerIdentities.authorityRole, 'owner'),
    )).all();
    for (const owner of owners) {
      if (args.handle && this.#find(args.workspaceId, args.channelKind, args.handle, args.connectionId)?.id === owner.id) continue;
      this.deps.db.update(schema.channelPeerIdentities).set({ authorityRole: 'external', authorityMethod: null, verifiedAt: null, grantExpiresAt: null })
        .where(eq(schema.channelPeerIdentities.id, owner.id)).run();
    }
    if (!args.handle) return null;
    let identity = this.#find(args.workspaceId, args.channelKind, args.handle, args.connectionId);
    if (!identity) {
      const row: PeerIdentity = {
        id: randomUUID(), workspaceId: args.workspaceId, channelKind: args.channelKind, connectionId: args.connectionId,
        handle: args.handle, displayName: args.displayName ?? null, userId: args.userId, peerKey: `user:${args.userId}`,
        groundingEntityId: null, authorityRole: 'owner', authorityMethod: 'authenticated_channel_configuration',
        verifiedAt: now, grantExpiresAt: null, blocked: false, messageCount: 0, firstSeenAt: now, lastSeenAt: now,
      };
      this.deps.db.insert(schema.channelPeerIdentities).values(row).onConflictDoNothing().run();
      identity = this.#find(args.workspaceId, args.channelKind, args.handle, args.connectionId) ?? row;
    }
    this.deps.db.update(schema.channelPeerIdentities).set({
      authorityRole: 'owner', authorityMethod: 'authenticated_channel_configuration', verifiedAt: now,
      grantExpiresAt: null, userId: args.userId, peerKey: `user:${args.userId}`,
      ...(args.displayName ? { displayName: args.displayName } : {}),
    }).where(eq(schema.channelPeerIdentities.id, identity.id)).run();
    const synced = { ...identity, authorityRole: 'owner' as const, authorityMethod: 'authenticated_channel_configuration', verifiedAt: now, userId: args.userId, peerKey: `user:${args.userId}`, displayName: args.displayName ?? identity.displayName };
    this.#upsertAlias(synced, args.handle, 'primary', 'authenticated_channel_configuration', true, args.displayName ?? undefined);
    return synced;
  }

  revokeAuthority(args: { workspaceId: string; identityId: string }): PeerIdentity | null {
    const existing = this.deps.db.select().from(schema.channelPeerIdentities).where(and(
      eq(schema.channelPeerIdentities.workspaceId, args.workspaceId),
      eq(schema.channelPeerIdentities.id, args.identityId),
    )).get();
    if (!existing) return null;
    this.deps.db.update(schema.channelPeerIdentities).set({
      authorityRole: 'external', authorityMethod: null, verifiedAt: null, grantExpiresAt: null,
    }).where(eq(schema.channelPeerIdentities.id, existing.id)).run();
    return { ...existing, authorityRole: 'external', authorityMethod: null, verifiedAt: null, grantExpiresAt: null } as PeerIdentity;
  }

  setGroundingEntity(identityId: string, groundingEntityId: string): void {
    this.deps.db.update(schema.channelPeerIdentities).set({ groundingEntityId })
      .where(eq(schema.channelPeerIdentities.id, identityId)).run();
  }

  principal(args: { workspaceId: string; connectionId: string; channelKind: string; handle: string }): PrincipalContext {
    const identity = this.#find(args.workspaceId, args.channelKind, args.handle, args.connectionId);
    const expired = Boolean(identity?.grantExpiresAt && Date.parse(identity.grantExpiresAt) <= Date.now());
    const role: ChannelAuthorityRole = expired ? 'external' : (identity?.authorityRole ?? 'external');
    return {
      identityId: identity?.id ?? null,
      connectionId: args.connectionId,
      channelKind: args.channelKind,
      handle: args.handle,
      peerKey: identity?.peerKey ?? `channel:${args.connectionId}:${args.handle}`,
      groundingEntityId: identity?.groundingEntityId ?? null,
      role,
      verified: role !== 'external' && Boolean(identity?.verifiedAt),
      authorityMethod: expired ? null : (identity?.authorityMethod ?? null),
      grantExpiresAt: identity?.grantExpiresAt ?? null,
      displayName: identity?.displayName ?? null,
    };
  }

  /** Connection-scoped Owner check for handoff policy. This is deliberately
   * separate from delegate authority: only the primary owner keeps automation
   * active after a manual outbound message. */
  isVerifiedOwner(args: { workspaceId: string; connectionId: string; channelKind: string; handle: string }): boolean {
    return isVerifiedChannelOwner(this.deps.db, args);
  }

  /** Other channel identities sharing this peer's key (cross-surface presence). */
  peerChannels(workspaceId: string, peerKey: string): PeerIdentity[] {
    return this.deps.db
      .select()
      .from(schema.channelPeerIdentities)
      .where(and(eq(schema.channelPeerIdentities.workspaceId, workspaceId), eq(schema.channelPeerIdentities.peerKey, peerKey)))
      .all() as PeerIdentity[];
  }

  /**
   * Record the inbound and return a one-line "who is this" summary for the
   * channel context, or null on a brand-new first contact.
   */
  recordAndSummarize(args: { workspaceId: string; connectionId?: string | null; channelKind: string; handle: string; displayName?: string }): {
    identity: PeerIdentity;
    summary: string | null;
  } {
    const identity = this.record(args);
    return { identity, summary: this.summarize(identity) };
  }

  summarize(identity: PeerIdentity): string | null {
    // First-ever message: nothing to recall yet.
    if (identity.messageCount <= 1 && !identity.userId) return null;
    const parts: string[] = [];
    const who = identity.displayName ?? identity.handle;
    parts.push(`Known sender: ${who} (${identity.messageCount} prior message${identity.messageCount === 1 ? '' : 's'} on ${identity.channelKind}).`);
    if (identity.peerKey) {
      const others = this.peerChannels(identity.workspaceId, identity.peerKey)
        .filter((p) => p.id !== identity.id)
        .map((p) => p.channelKind);
      const uniqueOthers = [...new Set(others)];
      if (uniqueOthers.length > 0) {
        parts.push(`Same person also reaches you on: ${uniqueOthers.join(', ')}.`);
      }
      parts.push('This handle is linked to a workspace user.');
    }
    if (identity.authorityRole !== 'external' && (!identity.grantExpiresAt || Date.parse(identity.grantExpiresAt) > Date.now())) {
      parts.push(`Verified authority: ${identity.authorityRole}.`);
    }
    return parts.join(' ');
  }

  #find(workspaceId: string, channelKind: string, handle: string, connectionId: string | null): PeerIdentity | null {
    if (connectionId) {
      const aliases = this.deps.db.select().from(schema.channelPeerAliases).where(and(
        eq(schema.channelPeerAliases.workspaceId, workspaceId),
        eq(schema.channelPeerAliases.connectionId, connectionId),
        eq(schema.channelPeerAliases.channelKind, channelKind),
      )).all();
      const alias = aliases.find((row) => row.alias === handle)
        ?? aliases.find((row) => normalizeHandle(row.alias) === normalizeHandle(handle));
      if (alias) {
        const peer = this.deps.db.select().from(schema.channelPeerIdentities)
          .where(eq(schema.channelPeerIdentities.id, alias.peerIdentityId)).get();
        if (peer) return peer as PeerIdentity;
      }
    }
    const selectScoped = (rows: PeerIdentity[]) => connectionId
      ? rows.find((row) => row.connectionId === connectionId) ?? rows.find((row) => row.connectionId === null) ?? null
      : rows.find((row) => row.connectionId === null) ?? null;
    const exactRows = this.deps.db.select().from(schema.channelPeerIdentities).where(and(
      eq(schema.channelPeerIdentities.workspaceId, workspaceId),
      eq(schema.channelPeerIdentities.channelKind, channelKind),
      eq(schema.channelPeerIdentities.handle, handle),
    )).all() as PeerIdentity[];
    const exact = selectScoped(exactRows);
    if (exact) return exact;
    // Providers may alternate between formatted numbers, device-qualified JIDs,
    // and PN aliases. Prefer the indexed exact lookup, then compare the stable
    // handle key so one peer does not lose its authority under another spelling.
    const normalizedRows = this.deps.db.select().from(schema.channelPeerIdentities).where(and(
      eq(schema.channelPeerIdentities.workspaceId, workspaceId),
      eq(schema.channelPeerIdentities.channelKind, channelKind),
    )).all().filter((row) => normalizeHandle(row.handle) === normalizeHandle(handle)) as PeerIdentity[];
    return selectScoped(normalizedRows);
  }

  #upsertAlias(identity: PeerIdentity, alias: string, kind: string, source: string, verified: boolean, displayName?: string): void {
    if (!identity.connectionId || !alias.trim()) return;
    const now = new Date().toISOString();
    const existing = this.deps.db.select().from(schema.channelPeerAliases).where(and(
      eq(schema.channelPeerAliases.workspaceId, identity.workspaceId),
      eq(schema.channelPeerAliases.connectionId, identity.connectionId),
      eq(schema.channelPeerAliases.channelKind, identity.channelKind),
      eq(schema.channelPeerAliases.alias, alias),
    )).get();
    if (existing) {
      this.deps.db.update(schema.channelPeerAliases).set({
        peerIdentityId: identity.id,
        aliasKind: kind,
        source,
        verified: existing.verified || verified,
        ...(displayName ? { displayName } : {}),
        lastSeenAt: now,
        updatedAt: now,
      }).where(eq(schema.channelPeerAliases.id, existing.id)).run();
      return;
    }
    this.deps.db.insert(schema.channelPeerAliases).values({
      id: randomUUID(), workspaceId: identity.workspaceId, connectionId: identity.connectionId,
      channelKind: identity.channelKind, peerIdentityId: identity.id, alias, aliasKind: kind,
      source, verified, displayName: displayName ?? null, lastSeenAt: now, createdAt: now, updatedAt: now,
    }).onConflictDoNothing().run();
  }

  #chooseCanonical(peers: PeerIdentity[]): PeerIdentity | null {
    return [...new Map(peers.map((peer) => [peer.id, peer])).values()].sort((a, b) => {
      const score = (peer: PeerIdentity) => (peer.authorityRole === 'owner' && peer.verifiedAt ? 8 : 0)
        + (peer.groundingEntityId ? 4 : 0) + (peer.peerKey ? 2 : 0) + (peer.displayName ? 1 : 0);
      return score(b) - score(a) || a.firstSeenAt.localeCompare(b.firstSeenAt);
    })[0] ?? null;
  }

  #mergePeer(target: PeerIdentity, source: PeerIdentity): void {
    if (target.id === source.id) return;
    const now = new Date().toISOString();
    this.deps.db.update(schema.channelPeerAliases).set({ peerIdentityId: target.id, updatedAt: now })
      .where(eq(schema.channelPeerAliases.peerIdentityId, source.id)).run();
    this.deps.db.update(schema.conversations).set({ channelPeerIdentityId: target.id, updatedAt: now })
      .where(eq(schema.conversations.channelPeerIdentityId, source.id)).run();
    this.deps.db.update(schema.channelActionIntents).set({ peerIdentityId: target.id, updatedAt: now })
      .where(eq(schema.channelActionIntents.peerIdentityId, source.id)).run();
    const merged = {
      displayName: target.displayName ?? source.displayName,
      userId: target.userId ?? source.userId,
      peerKey: target.peerKey ?? source.peerKey,
      groundingEntityId: target.groundingEntityId ?? source.groundingEntityId,
      messageCount: target.messageCount + source.messageCount,
      firstSeenAt: target.firstSeenAt < source.firstSeenAt ? target.firstSeenAt : source.firstSeenAt,
      lastSeenAt: target.lastSeenAt > source.lastSeenAt ? target.lastSeenAt : source.lastSeenAt,
    };
    this.deps.db.update(schema.channelPeerIdentities).set(merged)
      .where(eq(schema.channelPeerIdentities.id, target.id)).run();
    // The alias rows are the provider-address index; retaining the absorbed
    // identity would make inbox/list projections show the same person twice.
    this.deps.db.delete(schema.channelPeerIdentities)
      .where(eq(schema.channelPeerIdentities.id, source.id)).run();
    Object.assign(target, merged);
    if (merged.peerKey) this.#unifyGrounding(target.workspaceId, merged.peerKey);
  }

  /** Merge already-grounded channel handles when an operator links them to one person. */
  #unifyGrounding(workspaceId: string, peerKey: string): void {
    const peers = this.peerChannels(workspaceId, peerKey);
    const grounded = peers.filter((peer) => peer.groundingEntityId);
    const targetId = grounded[0]?.groundingEntityId;
    if (!targetId) return;
    const target = this.deps.db.select().from(schema.durableEntities).where(eq(schema.durableEntities.id, targetId)).get();
    if (!target) return;
    let targetState = asObject(target.stateJson);
    for (const peer of peers) {
      const sourceId = peer.groundingEntityId;
      if (!sourceId || sourceId === targetId) continue;
      const source = this.deps.db.select().from(schema.durableEntities).where(eq(schema.durableEntities.id, sourceId)).get();
      if (source) {
        targetState = mergeRelationshipState(targetState, asObject(source.stateJson));
        this.deps.db.update(schema.durableEntities).set({ status: 'done', nextWakeAt: null, updatedAt: new Date().toISOString() })
          .where(eq(schema.durableEntities.id, sourceId)).run();
      }
    }
    this.deps.db.update(schema.durableEntities).set({ stateJson: targetState, updatedAt: new Date().toISOString() })
      .where(eq(schema.durableEntities.id, targetId)).run();
    this.deps.db.update(schema.channelPeerIdentities).set({ groundingEntityId: targetId })
      .where(and(eq(schema.channelPeerIdentities.workspaceId, workspaceId), eq(schema.channelPeerIdentities.peerKey, peerKey))).run();
  }
}

function aliasKind(handle: string, primary: string): string {
  if (handle === primary) return 'primary';
  if (/@lid$/i.test(handle)) return 'lid';
  if (/@s\.whatsapp\.net$/i.test(handle)) return 'pn';
  if (/^\+?[\d\s().-]+$/.test(handle)) return 'phone';
  if (handle.startsWith('@')) return 'username';
  return 'provider';
}

/** Pure DB-level owner predicate used at provider boundaries that do not own a
 * ChannelIdentityService instance. Authority is connection-scoped, verified,
 * unexpired, and handle-normalized. */
export function isVerifiedChannelOwner(
  db: AgentisSqliteDb,
  args: { workspaceId: string; connectionId: string; channelKind: string; handle: string },
): boolean {
  const target = normalizeHandle(args.handle);
  if (!target) return false;
  const now = Date.now();
  const owners = db.select().from(schema.channelPeerIdentities).where(and(
    eq(schema.channelPeerIdentities.workspaceId, args.workspaceId),
    eq(schema.channelPeerIdentities.connectionId, args.connectionId),
    eq(schema.channelPeerIdentities.channelKind, args.channelKind),
    eq(schema.channelPeerIdentities.authorityRole, 'owner'),
  )).all().filter((identity) => Boolean(identity.verifiedAt)
    && (!identity.grantExpiresAt || Date.parse(identity.grantExpiresAt) > now));
  if (owners.some((identity) => normalizeHandle(identity.handle) === target)) return true;
  const ownerIds = new Set(owners.map((identity) => identity.id));
  return db.select().from(schema.channelPeerAliases).where(and(
    eq(schema.channelPeerAliases.workspaceId, args.workspaceId),
    eq(schema.channelPeerAliases.connectionId, args.connectionId),
    eq(schema.channelPeerAliases.channelKind, args.channelKind),
  )).all().some((alias) => ownerIds.has(alias.peerIdentityId) && normalizeHandle(alias.alias) === target);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mergeRelationshipState(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const mergeBy = (left: unknown, right: unknown, key: string) => {
    const values = [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])] as Array<Record<string, unknown>>;
    const seen = new Map<string, Record<string, unknown>>();
    for (const value of values) seen.set(String(value?.[key] ?? JSON.stringify(value)), value);
    return [...seen.values()];
  };
  const targetIdentity = asObject(target.identity);
  const sourceIdentity = asObject(source.identity);
  return {
    ...source,
    ...target,
    identity: { ...sourceIdentity, ...targetIdentity, handles: mergeBy(targetIdentity.handles, sourceIdentity.handles, 'handle') },
    facts: mergeBy(target.facts, source.facts, 'key'),
    engagements: mergeBy(target.engagements, source.engagements, 'id'),
    commitments: mergeBy(target.commitments, source.commitments, 'id'),
    openQuestions: [...new Set([...(Array.isArray(target.openQuestions) ? target.openQuestions : []), ...(Array.isArray(source.openQuestions) ? source.openQuestions : [])])],
    blockers: [...new Set([...(Array.isArray(target.blockers) ? target.blockers : []), ...(Array.isArray(source.blockers) ? source.blockers : [])])],
    memoryRefs: [...new Set([...(Array.isArray(target.memoryRefs) ? target.memoryRefs : []), ...(Array.isArray(source.memoryRefs) ? source.memoryRefs : [])])],
    updatedAt: new Date().toISOString(),
  };
}
