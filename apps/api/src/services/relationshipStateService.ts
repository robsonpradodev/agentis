import { and, eq } from 'drizzle-orm';
import type { AgentContinuityContext, PrincipalContext, RelationshipState } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { DurableEntityService, EntityRow } from './durableEntities.js';
import type { ChannelIdentityService } from './conversation/channelIdentityService.js';

export interface RelationshipTouchInput {
  workspaceId: string;
  appId?: string | null;
  connectionId: string;
  channelKind: string;
  handle: string;
  displayName?: string | null;
  conversationId?: string | null;
  contactId?: string | null;
  inboundText?: string | null;
}

/** Owns the canonical per-counterparty Subject. Contacts and conversations are projections of it. */
export class RelationshipStateService {
  constructor(private readonly deps: {
    db: AgentisSqliteDb;
    entities: DurableEntityService;
    identities: ChannelIdentityService;
  }) {}

  touch(input: RelationshipTouchInput): { subject: EntityRow; principal: PrincipalContext; state: RelationshipState } {
    let identity = this.deps.identities.resolve(input.workspaceId, input.channelKind, input.handle, input.connectionId)
      ?? this.deps.identities.record({
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      channelKind: input.channelKind,
      handle: input.handle,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      });
    const principal = this.deps.identities.principal(input);
    const now = new Date().toISOString();
    const projection = input.contactId
      ? this.deps.db.select().from(schema.appContacts).where(eq(schema.appContacts.id, input.contactId)).get()
      : null;
    const key = `person:${principal.peerKey}`;
    let current = this.deps.entities.getByKey(input.workspaceId, 'subject', key);
    if (!current && identity.groundingEntityId) {
      const grounded = this.deps.entities.get(identity.groundingEntityId);
      if (grounded?.kind === 'subject' && grounded.workspaceId === input.workspaceId) {
        // Linking channels may replace a provisional channel key with a stable
        // person key. Preserve the actor and its history; only rename its key.
        this.deps.db.update(schema.durableEntities).set({ key, updatedAt: now })
          .where(eq(schema.durableEntities.id, grounded.id)).run();
        current = { ...grounded, key, updatedAt: now };
      }
    }
    const existing = current?.stateJson as Partial<RelationshipState> | undefined;
    const handles = [...(existing?.identity?.handles ?? [])];
    if (!handles.some((h) => h.connectionId === input.connectionId && h.handle === input.handle)) {
      handles.push({ connectionId: input.connectionId, channelKind: input.channelKind, handle: input.handle });
    }
    const engagements = [...(existing?.engagements ?? [])];
    if (input.appId && !engagements.some((e) => e.id === `app:${input.appId}`)) {
      engagements.push({
        id: `app:${input.appId}`, kind: 'app', goal: projection?.goal ?? 'advance this relationship usefully',
        stage: projection?.stage ?? 'new', status: 'active', openedAt: now, updatedAt: now,
      });
    }
    const state: RelationshipState = {
      version: 2,
      subjectKey: key,
      identity: {
        displayName: input.displayName ?? existing?.identity?.displayName ?? identity.displayName,
        peerKey: principal.peerKey,
        handles,
      },
      facts: existing?.facts ?? projectionFacts(projection?.dataJson, now),
      engagements,
      commitments: existing?.commitments ?? [],
      openQuestions: existing?.openQuestions ?? [],
      blockers: existing?.blockers ?? [],
      nextAction: existing?.nextAction ?? null,
      memoryRefs: existing?.memoryRefs ?? [],
      lastInboundAt: input.inboundText != null ? now : (existing?.lastInboundAt ?? null),
      lastOutboundAt: existing?.lastOutboundAt ?? null,
      updatedAt: now,
    };
    const subject = this.deps.entities.upsert({
      workspaceId: input.workspaceId,
      kind: 'subject',
      key,
      appId: input.appId ?? current?.appId ?? null,
      state: state as unknown as Record<string, unknown>,
    });
    if (identity.groundingEntityId !== subject.id) {
      this.deps.identities.setGroundingEntity(identity.id, subject.id);
      identity = { ...identity, groundingEntityId: subject.id };
    }
    if (input.contactId) {
      this.deps.db.update(schema.appContacts).set({ subjectId: subject.id, updatedAt: now })
        .where(and(eq(schema.appContacts.workspaceId, input.workspaceId), eq(schema.appContacts.id, input.contactId))).run();
    }
    if (input.inboundText != null) {
      this.deps.entities.post(subject.id, 'channel.inbound', {
        conversationId: input.conversationId ?? null,
        connectionId: input.connectionId,
        channelKind: input.channelKind,
        handle: input.handle,
        text: input.inboundText,
        receivedAt: now,
      });
    }
    return { subject, principal: { ...principal, groundingEntityId: subject.id }, state };
  }

  get(subjectId: string): RelationshipState | null {
    const entity = this.deps.entities.get(subjectId);
    if (!entity || entity.kind !== 'subject') return null;
    return normalizeRelationshipState(entity.key, entity.stateJson);
  }

  continuity(subjectId: string): AgentContinuityContext | null {
    const state = this.get(subjectId);
    if (!state) return null;
    const engagement = state.engagements.find((item) => item.status === 'active') ?? null;
    return {
      subjectId,
      subjectKey: state.subjectKey,
      engagementId: engagement?.id ?? null,
      goal: engagement?.goal ?? null,
      stage: engagement?.stage ?? null,
      nextAction: state.nextAction,
      commitments: state.commitments.filter((item) => item.status === 'open'),
      openQuestions: state.openQuestions,
      blockers: state.blockers,
      contextVersion: state.version,
      contextWatermark: state.updatedAt,
    };
  }

  contextBlock(subjectId: string): string | null {
    const continuity = this.continuity(subjectId);
    if (!continuity) return null;
    return [
      'DURABLE RELATIONSHIP STATE',
      JSON.stringify(continuity),
      'Treat this person/case as a continuing goal-directed relationship. Update commitments and next action through the Subject tools when material facts change. Do not invent facts; preserve provenance and close or cancel obsolete actions.',
    ].join('\n');
  }
}

function projectionFacts(value: unknown, now: string): RelationshipState['facts'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, fact]) => ({
    key, value: fact, confidence: 0.8, source: 'import' as const, observedAt: now, lastConfirmedAt: now,
  }));
}

export function normalizeRelationshipState(subjectKey: string, raw: unknown): RelationshipState {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Partial<RelationshipState> : {};
  const now = new Date().toISOString();
  return {
    version: 2,
    subjectKey: value.subjectKey ?? subjectKey,
    identity: value.identity ?? { handles: [] },
    facts: Array.isArray(value.facts) ? value.facts : [],
    engagements: Array.isArray(value.engagements) ? value.engagements : [],
    commitments: Array.isArray(value.commitments) ? value.commitments : [],
    openQuestions: Array.isArray(value.openQuestions) ? value.openQuestions : [],
    blockers: Array.isArray(value.blockers) ? value.blockers : [],
    nextAction: value.nextAction ?? null,
    memoryRefs: Array.isArray(value.memoryRefs) ? value.memoryRefs : [],
    lastInboundAt: value.lastInboundAt ?? null,
    lastOutboundAt: value.lastOutboundAt ?? null,
    updatedAt: value.updatedAt ?? now,
  };
}
