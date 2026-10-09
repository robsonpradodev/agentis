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
  constructor(
    private readonly deps: {
      db: AgentisSqliteDb;
      entities: DurableEntityService;
      identities: ChannelIdentityService;
    },
  ) {}

  touch(input: RelationshipTouchInput): {
    subject: EntityRow;
    principal: PrincipalContext;
    state: RelationshipState;
  } {
    let identity =
      this.deps.identities.resolve(
        input.workspaceId,
        input.channelKind,
        input.handle,
        input.connectionId,
      ) ??
      this.deps.identities.record({
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        channelKind: input.channelKind,
        handle: input.handle,
        ...(input.displayName ? { displayName: input.displayName } : {}),
      });
    const principal = this.deps.identities.principal(input);
    const now = new Date().toISOString();
    const projection = input.contactId
      ? this.deps.db
          .select()
          .from(schema.appContacts)
          .where(eq(schema.appContacts.id, input.contactId))
          .get()
      : null;
    const key = `person:${principal.peerKey}`;
    let current = this.deps.entities.getByKey(input.workspaceId, 'subject', key);
    if (!current && identity.groundingEntityId) {
      const grounded = this.deps.entities.get(identity.groundingEntityId);
      if (grounded?.kind === 'subject' && grounded.workspaceId === input.workspaceId) {
        // Linking channels may replace a provisional channel key with a stable
        // person key. Preserve the actor and its history; only rename its key.
        this.deps.db
          .update(schema.durableEntities)
          .set({ key, updatedAt: now })
          .where(eq(schema.durableEntities.id, grounded.id))
          .run();
        current = { ...grounded, key, updatedAt: now };
      }
    }
    const existing = current?.stateJson as Partial<RelationshipState> | undefined;
    const handles = [...(existing?.identity?.handles ?? [])];
    if (!handles.some((h) => h.connectionId === input.connectionId && h.handle === input.handle)) {
      handles.push({
        connectionId: input.connectionId,
        channelKind: input.channelKind,
        handle: input.handle,
      });
    }
    const engagements = [...(existing?.engagements ?? [])];
    if (input.appId && !engagements.some((e) => e.id === `app:${input.appId}`)) {
      engagements.push({
        id: `app:${input.appId}`,
        kind: 'app',
        goal: projection?.goal ?? 'advance this relationship usefully',
        stage: projection?.stage ?? 'new',
        status: 'active',
        openedAt: now,
        updatedAt: now,
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
      decisionHistory: existing?.decisionHistory ?? [],
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
      this.deps.db
        .update(schema.appContacts)
        .set({ subjectId: subject.id, updatedAt: now })
        .where(
          and(
            eq(schema.appContacts.workspaceId, input.workspaceId),
            eq(schema.appContacts.id, input.contactId),
          ),
        )
        .run();
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

  /**
   * Stamp the outbound clock on the relationship this reply belongs to.
   *
   * Without this, `lastOutboundAt` was written ONLY by SubjectRuntime when it
   * performed a due proactive action, so an ordinary agent reply left the
   * relationship looking untouched. Every "who went silent" question is a
   * comparison of these two clocks, so a missing outbound stamp made the whole
   * cohort undecidable: a lead the agent answered ten minutes ago and a lead
   * nobody ever wrote to were indistinguishable.
   *
   * Resolves an EXISTING identity only — delivering a message must never mint a
   * relationship that the inbound path did not already establish. Best-effort by
   * contract: never throws, never touches the wake clock.
   */
  recordOutbound(input: {
    workspaceId: string;
    connectionId: string;
    channelKind: string;
    handle: string;
    at?: string;
  }): void {
    const identity = this.deps.identities.resolve(
      input.workspaceId,
      input.channelKind,
      input.handle,
      input.connectionId,
    );
    if (!identity?.groundingEntityId) return;
    const entity = this.deps.entities.get(identity.groundingEntityId);
    if (!entity || entity.kind !== 'subject' || entity.workspaceId !== input.workspaceId) return;
    const now = input.at ?? new Date().toISOString();
    // Shallow state merge only: the wake clock and awaited correlation belong to
    // whatever the SubjectRuntime last decided, and a reply must not disturb them.
    this.deps.entities.upsert({
      workspaceId: entity.workspaceId,
      kind: 'subject',
      key: entity.key,
      state: { lastOutboundAt: now, updatedAt: now },
    });
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
    const state = this.get(subjectId);
    if (!state) return null;
    const now = Date.now();
    const facts = state.facts
      .filter((fact) => !fact.archivedAt && (!fact.expiresAt || Date.parse(fact.expiresAt) > now))
      .slice(-12)
      .map(
        (fact) =>
          `- ${fact.key}: ${briefValue(fact.value)} (origem ${fact.source}; observado ${fact.observedAt}; confiança ${fact.confidence.toFixed(2)}${fact.expiresAt ? `; válido até ${fact.expiresAt}` : ''})`,
      );
    const commitments = state.commitments
      .filter((item) => item.status === 'open')
      .slice(-12)
      .map(
        (item) =>
          `- ${item.owner} deve: ${item.text}${item.dueAt ? ` (prazo ${item.dueAt})` : ''} [id ${item.id}]`,
      );
    const decisions = (state.decisionHistory ?? [])
      .slice(-5)
      .map(
        (item) =>
          `- ${item.evaluatedAt}: ${item.outcome} — ${item.reason}${item.relatedEventIds?.length ? ` [eventos ${item.relatedEventIds.join(', ')}]` : ''}`,
      );
    return [
      'DURABLE RELATIONSHIP STATE',
      `Subject ${state.subjectKey}; atualizado em ${state.updatedAt}; contato ${state.identity.displayName ?? 'sem nome confirmado'}.`,
      `Objetivo ativo: ${continuity.goal ?? 'nenhum'}; etapa: ${continuity.stage ?? 'não definida'}.`,
      `Fatos confirmados recentes (fonte, horário e validade fazem parte do fato):\n${facts.length ? facts.join('\n') : '- Nenhum fato ativo confirmado.'}`,
      `Compromissos abertos:\n${commitments.length ? commitments.join('\n') : '- Nenhum compromisso aberto.'}`,
      `Próxima ação: ${continuity.nextAction ? JSON.stringify(continuity.nextAction) : 'nenhuma'}. Bloqueios atuais: ${state.blockers.length ? state.blockers.join('; ') : 'nenhum'}.`,
      `Decisões recentes e motivo:\n${decisions.length ? decisions.join('\n') : '- Ainda não há decisões registradas.'}`,
      `Perguntas em aberto: ${state.openQuestions.length ? state.openQuestions.join('; ') : 'nenhuma'}. Referências de memória relacionadas: ${state.memoryRefs.length ? state.memoryRefs.slice(-10).join(', ') : 'nenhuma'}.`,
      'Use apenas fatos ativos. A síntese é uma projeção explicável, não uma fonte nova; confira a origem antes de fazer afirmações externas. Atualize compromissos e próxima ação pelas ferramentas de Subject quando fatos mudarem; feche ou cancele ações obsoletas.',
      // Stating the obligation is what turns the capability into behaviour. The
      // spine could always carry a delayed action; without this line the model
      // ended every turn as if it were the last one it would ever take.
      'This turn does not have to be your last act here. If you commit to anything you cannot finish now — sending something later, checking back if they go quiet, confirming with someone else — arm it with agentis.followup.schedule before you finish, and describe the goal well enough that you could act on it without re-reading this conversation. If a pending action above is no longer warranted, cancel it with agentis.followup.cancel. Never end a turn leaving a promise with nothing scheduled behind it.',
    ].join('\n');
  }
}

function projectionFacts(value: unknown, now: string): RelationshipState['facts'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .slice(0, 100)
    .map(([key, fact]) => ({
      key,
      value: fact,
      confidence: 0.8,
      source: 'import' as const,
      observedAt: now,
      lastConfirmedAt: now,
    }));
}

export function normalizeRelationshipState(subjectKey: string, raw: unknown): RelationshipState {
  const value =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Partial<RelationshipState>)
      : {};
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
    decisionHistory: Array.isArray(value.decisionHistory) ? value.decisionHistory.slice(-100) : [],
    lastInboundAt: value.lastInboundAt ?? null,
    lastOutboundAt: value.lastOutboundAt ?? null,
    updatedAt: value.updatedAt ?? now,
  };
}

function briefValue(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = '[valor indisponível]';
  }
  return (text || 'null').replaceAll('\n', ' ').slice(0, 180);
}
