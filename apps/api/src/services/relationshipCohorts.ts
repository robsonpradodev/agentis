/**
 * RelationshipCohortService — "which of these are actually stalled?"
 *
 * An agent told to re-engage leads that went quiet had no way to answer that
 * question. `agentis.subject.list` returns every Subject with no clocks and no
 * message counts; `agentis.channel.inbox` has the right timestamps but caps at 50
 * rows and offers no predicates. So the only reachable behaviour was to list
 * whatever came back and message all of it — which is how an address-book entry
 * that never held a conversation gets a "seguindo nossa conversa" nudge.
 *
 * The distinction this service exists to make is between four things that look
 * identical without the message ledger:
 *   - a contact who never had a conversation at all (an address book row),
 *   - a conversation the agent is mid-way through answering right now,
 *   - a conversation a human took over,
 *   - a lead who read the last thing the agent sent and went silent.
 * Only the last one is a follow-up candidate, and the ledger is the only place
 * that separates them: identity rows and relationship state both lie by omission.
 *
 * Read-only. It selects a cohort; arming one is FollowUpService's job.
 */

import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { RelationshipNextAction, RelationshipState } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import { normalizeRelationshipState } from './relationshipStateService.js';

export interface RelationshipCohortQuery {
  workspaceId: string;
  /** Silent at least this long: now − lastInboundAt ≥ hours. The core stall predicate. */
  silentForHours?: number | null;
  /** Who spoke last. `agent` is the honest reading of "they stopped answering". */
  lastMessageFrom?: 'agent' | 'contact' | 'any' | null;
  /**
   * Minimum inbound messages ever received. Defaults to 1, and this default is
   * load-bearing: at 0 the cohort silently widens to every address-book row the
   * provider ever surfaced, none of which ever spoke to the agent.
   */
  minInboundMessages?: number | null;
  /** Do not re-approach anyone contacted more recently than this. */
  quietSinceOutboundHours?: number | null;
  /** Pipeline stages to include / exclude (engagement stage on the relationship). */
  stages?: string[] | null;
  excludeStages?: string[] | null;
  /** Engagement statuses to include. Defaults to `active` — a won/lost case is not a lead. */
  engagementStatus?: string[] | null;
  /** Include people who already have an action planned. Default false. */
  includePlanned?: boolean | null;
  /** Skip anyone already nudged this many times or more. */
  maxFollowUpAttempts?: number | null;
  /** Include threads a human took over. Default false — barging in undoes the handoff. */
  includeHumanHandoff?: boolean | null;
  /** Include the operator's own control chats. Default false. */
  includeOwner?: boolean | null;
  connectionId?: string | null;
  channelKind?: string | null;
  appId?: string | null;
  limit?: number | null;
}

export interface RelationshipCohortMember {
  subjectId: string | null;
  subjectKey: string | null;
  recipientRef: string;
  displayName: string | null;
  connectionId: string | null;
  channelKind: string;
  conversationId: string | null;
  appId: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  hoursSinceInbound: number | null;
  hoursSinceOutbound: number | null;
  inboundCount: number;
  outboundCount: number;
  lastMessageDirection: 'inbound' | 'outbound' | null;
  lastMessagePreview: string | null;
  stage: string | null;
  goal: string | null;
  engagementStatus: string | null;
  nextAction: RelationshipNextAction | null;
  handoffState: string | null;
}

export interface RelationshipCohortResult {
  members: RelationshipCohortMember[];
  /** How many rows each stage of the funnel dropped — so an empty cohort is diagnosable, not mysterious. */
  considered: number;
  excluded: Record<string, number>;
  truncated: boolean;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const HOUR_MS = 3_600_000;

export class RelationshipCohortService {
  constructor(private readonly deps: { db: AgentisSqliteDb }) {}

  query(input: RelationshipCohortQuery, now: Date = new Date()): RelationshipCohortResult {
    const limit = Math.max(1, Math.min(MAX_LIMIT, input.limit ?? DEFAULT_LIMIT));
    const minInbound = Math.max(0, Math.floor(input.minInboundMessages ?? 1));
    const excluded: Record<string, number> = {};
    const drop = (reason: string) => { excluded[reason] = (excluded[reason] ?? 0) + 1; };

    // One aggregation over the message ledger. Counting inbound and outbound
    // separately here is the whole point: `messageCount` on the identity row does
    // not distinguish direction, so it cannot tell a silent lead from a contact
    // the agent has been acmeng at.
    const ledger = this.deps.db
      .select({
        peerIdentityId: schema.conversations.channelPeerIdentityId,
        inboundCount: sql<number>`sum(case when ${schema.conversationMessages.participantSide} = 'customer' then 1 else 0 end)`,
        outboundCount: sql<number>`sum(case when ${schema.conversationMessages.participantSide} = 'business' then 1 else 0 end)`,
        lastInboundAt: sql<string | null>`max(case when ${schema.conversationMessages.participantSide} = 'customer' then ${schema.conversationMessages.createdAt} end)`,
        lastOutboundAt: sql<string | null>`max(case when ${schema.conversationMessages.participantSide} = 'business' then ${schema.conversationMessages.createdAt} end)`,
      })
      .from(schema.conversationMessages)
      .innerJoin(schema.conversations, eq(schema.conversations.id, schema.conversationMessages.conversationId))
      .where(and(
        eq(schema.conversationMessages.workspaceId, input.workspaceId),
        isNotNull(schema.conversations.channelPeerIdentityId),
        ...(input.connectionId ? [eq(schema.conversations.channelConnectionId, input.connectionId)] : []),
        ...(input.appId ? [eq(schema.conversations.appId, input.appId)] : []),
      ))
      .groupBy(schema.conversations.channelPeerIdentityId)
      .having(sql`sum(case when ${schema.conversationMessages.participantSide} = 'customer' then 1 else 0 end) >= ${minInbound}`)
      .all();

    const considered = ledger.length;
    if (considered === 0) return { members: [], considered, excluded, truncated: false };

    const peerIds = ledger.map((row) => row.peerIdentityId!).filter(Boolean);
    const identities = new Map(
      chunked(peerIds).flatMap((ids) => this.deps.db.select().from(schema.channelPeerIdentities)
        .where(and(eq(schema.channelPeerIdentities.workspaceId, input.workspaceId), inArray(schema.channelPeerIdentities.id, ids)))
        .all()).map((row) => [row.id, row]),
    );
    // Newest conversation per peer, for handoff state and the reply address.
    const conversations = new Map<string, typeof schema.conversations.$inferSelect>();
    for (const ids of chunked(peerIds)) {
      for (const row of this.deps.db.select().from(schema.conversations)
        .where(and(eq(schema.conversations.workspaceId, input.workspaceId), inArray(schema.conversations.channelPeerIdentityId, ids)))
        .orderBy(desc(schema.conversations.lastMessageAt), desc(schema.conversations.createdAt))
        .all()) {
        if (!conversations.has(row.channelPeerIdentityId!)) conversations.set(row.channelPeerIdentityId!, row);
      }
    }
    const subjectIds = [...identities.values()].map((row) => row.groundingEntityId).filter((id): id is string => Boolean(id));
    const subjects = new Map(
      chunked(subjectIds).flatMap((ids) => this.deps.db.select().from(schema.durableEntities)
        .where(inArray(schema.durableEntities.id, ids)).all()).map((row) => [row.id, row]),
    );

    const nowMs = now.getTime();
    const candidates: RelationshipCohortMember[] = [];
    for (const row of ledger) {
      const identity = identities.get(row.peerIdentityId!);
      if (!identity) { drop('identity_missing'); continue; }
      if (identity.blocked) { drop('blocked'); continue; }
      if (!input.includeOwner && identity.authorityRole !== 'external') { drop('owner_or_delegate'); continue; }
      if (input.channelKind && identity.channelKind !== input.channelKind) { drop('channel_kind'); continue; }
      if (!isDirectPeer(identity.handle)) { drop('not_a_direct_peer'); continue; }

      const conversation = conversations.get(identity.id) ?? null;
      if (!input.includeHumanHandoff && conversation?.handoffState === 'human') { drop('human_handoff'); continue; }

      const hoursSinceInbound = hoursSince(row.lastInboundAt, nowMs);
      // No inbound ever ⇒ infinitely silent, not "not silent" — it only reaches
      // here at all when the caller explicitly widened minInboundMessages to 0.
      if (input.silentForHours != null && hoursSinceInbound != null && hoursSinceInbound < input.silentForHours) {
        drop('still_recent'); continue;
      }
      const hoursSinceOutbound = hoursSince(row.lastOutboundAt, nowMs);
      if (input.quietSinceOutboundHours != null && hoursSinceOutbound != null && hoursSinceOutbound < input.quietSinceOutboundHours) {
        drop('contacted_too_recently'); continue;
      }

      const direction = lastDirection(row.lastInboundAt, row.lastOutboundAt);
      const wanted = input.lastMessageFrom ?? 'any';
      if (wanted === 'agent' && direction !== 'outbound') { drop('they_spoke_last'); continue; }
      if (wanted === 'contact' && direction !== 'inbound') { drop('agent_spoke_last'); continue; }

      const entity = identity.groundingEntityId ? subjects.get(identity.groundingEntityId) ?? null : null;
      const state: RelationshipState | null = entity ? normalizeRelationshipState(entity.key, entity.stateJson) : null;
      const engagement = state?.engagements.find((item) => item.status === 'active') ?? state?.engagements[0] ?? null;

      const statuses = input.engagementStatus ?? ['active'];
      if (engagement && statuses.length > 0 && !statuses.includes(engagement.status)) { drop('engagement_status'); continue; }
      if (input.stages?.length && !(engagement && input.stages.includes(engagement.stage))) { drop('stage_not_included'); continue; }
      if (input.excludeStages?.length && engagement && input.excludeStages.includes(engagement.stage)) { drop('stage_excluded'); continue; }

      const nextAction = state?.nextAction ?? null;
      if (!input.includePlanned && nextAction && ['planned', 'ready'].includes(nextAction.status)) { drop('already_planned'); continue; }
      if (input.maxFollowUpAttempts != null && (nextAction?.attempts ?? 0) >= input.maxFollowUpAttempts) { drop('attempts_exhausted'); continue; }

      candidates.push({
        subjectId: entity?.id ?? null,
        subjectKey: entity?.key ?? null,
        recipientRef: `peer:${identity.id}`,
        displayName: identity.displayName ?? state?.identity?.displayName ?? null,
        connectionId: identity.connectionId ?? conversation?.channelConnectionId ?? null,
        channelKind: identity.channelKind,
        conversationId: conversation?.id ?? null,
        appId: conversation?.appId ?? null,
        lastInboundAt: row.lastInboundAt,
        lastOutboundAt: row.lastOutboundAt,
        hoursSinceInbound,
        hoursSinceOutbound,
        inboundCount: Number(row.inboundCount ?? 0),
        outboundCount: Number(row.outboundCount ?? 0),
        lastMessageDirection: direction,
        lastMessagePreview: null,
        stage: engagement?.stage ?? null,
        goal: engagement?.goal ?? null,
        engagementStatus: engagement?.status ?? null,
        nextAction,
        handoffState: conversation?.handoffState ?? null,
      });
    }

    // Longest-silent first: if the cohort has to be truncated, the people most at
    // risk of being lost outright are the ones that survive the cut. No inbound
    // ever sorts as most-silent, consistent with the silentForHours predicate above.
    candidates.sort((a, b) => (b.hoursSinceInbound ?? Infinity) - (a.hoursSinceInbound ?? Infinity));
    const members = candidates.slice(0, limit);
    this.#attachPreviews(input.workspaceId, members);
    return { members, considered, excluded, truncated: candidates.length > members.length };
  }

  /** Last message body for the returned page only — never for the whole scan. */
  #attachPreviews(workspaceId: string, members: RelationshipCohortMember[]): void {
    const conversationIds = members.map((member) => member.conversationId).filter((id): id is string => Boolean(id));
    if (conversationIds.length === 0) return;
    const latest = new Map<string, string>();
    for (const ids of chunked(conversationIds)) {
      for (const row of this.deps.db
        .select({ conversationId: schema.conversationMessages.conversationId, body: schema.conversationMessages.body })
        .from(schema.conversationMessages)
        .where(and(eq(schema.conversationMessages.workspaceId, workspaceId), inArray(schema.conversationMessages.conversationId, ids)))
        .orderBy(desc(schema.conversationMessages.createdAt))
        .all()) {
        if (!latest.has(row.conversationId)) latest.set(row.conversationId, row.body);
      }
    }
    for (const member of members) {
      const body = member.conversationId ? latest.get(member.conversationId) : undefined;
      if (body) member.lastMessagePreview = body.slice(0, 240);
    }
  }
}

function hoursSince(at: string | null, nowMs: number): number | null {
  if (!at) return null;
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round(((nowMs - parsed) / HOUR_MS) * 10) / 10);
}

function lastDirection(lastInboundAt: string | null, lastOutboundAt: string | null): 'inbound' | 'outbound' | null {
  if (!lastInboundAt && !lastOutboundAt) return null;
  if (!lastOutboundAt) return 'inbound';
  if (!lastInboundAt) return 'outbound';
  return Date.parse(lastOutboundAt) >= Date.parse(lastInboundAt) ? 'outbound' : 'inbound';
}

/** Groups, broadcasts and newsletters are not people to follow up with. */
function isDirectPeer(handle: string): boolean {
  const normalized = handle.trim().toLowerCase();
  return normalized !== 'status@broadcast'
    && !normalized.endsWith('@g.us')
    && !normalized.endsWith('@broadcast')
    && !normalized.endsWith('@newsletter');
}

/** SQLite caps bound parameters per statement; page the IN lists rather than trusting the cohort to be small. */
function chunked<T>(values: T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}
