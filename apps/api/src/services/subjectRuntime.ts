/**
 * SubjectRuntime — the Subject primitive, running on the Durable Entity spine (§3.2).
 *
 * This is the GENERAL version of what `ConversationContactState`/`ConversationRuntime`
 * do narrowly: a per-subject actor with a declarative lifecycle that rests between
 * events and resumes when its subject acts — a reply that may arrive days later and
 * out of order, correlated back to the right subject by token, never by arrival order.
 * A subject is a `durable_entities` row of kind `subject`; this is the handler the
 * dispatcher runs for that kind. Side effects (a deterministic send, an agent turn)
 * are injected `SubjectActions`, so the runtime is the pure lifecycle driver and the
 * wiring decides how a send/agent-step actually happens.
 *
 * Stages (minimal, general — extend as real scripts demand):
 *   send  — deterministic, token-free message (the "no tokens" first touch) → next
 *   agent — hand off to a model to compose/decide (the personalized pitch, a classify) → next
 *   wait  — park until an inbound event arrives (the reply); store it in facts → next
 *   done  — terminal; the subject stops being woken
 */

import { randomUUID } from 'node:crypto';
import type { EntityWakeContext, EntityWakeResult, Correlation } from './durableEntities.js';
import type { RelationshipDecision, RelationshipState } from '@agentis/core';
import { normalizeRelationshipState } from './relationshipStateService.js';

export type SubjectStage =
  | { action: 'send'; text: string; next: string }
  | { action: 'agent'; instruction: string; next: string }
  | { action: 'wait'; correlation?: Correlation; next: string }
  | { action: 'done' };

export interface SubjectScript {
  start: string;
  stages: Record<string, SubjectStage>;
}

export interface SubjectState {
  script?: SubjectScript;
  stage?: string;
  facts?: Record<string, unknown>;
}

export interface SubjectActionArgs {
  entityId: string;
  workspaceId: string;
  appId: string | null;
  facts: Record<string, unknown>;
}

export interface SubjectActions {
  /** Deterministic, token-free send. Resolves the destination from the subject's facts. */
  send(args: SubjectActionArgs & { stage: string; text: string }): Promise<void> | void;
  /** Hand the step to a model (compose a message, classify a reply, trigger a build). */
  runAgent(args: SubjectActionArgs & { instruction: string }):
    | Promise<{
        outcome: 'performed' | 'held' | 'blocked';
        reason?: string;
        receiptId?: string;
      } | void>
    | {
        outcome: 'performed' | 'held' | 'blocked';
        reason?: string;
        receiptId?: string;
      }
    | void;
}

const MAX_STEPS_PER_WAKE = 50;

export class SubjectRuntime {
  constructor(private readonly actions: SubjectActions) {}

  /** The dispatcher handler for kind `subject`. Advances until it parks (wait) or terminates (done). */
  async handle(ctx: EntityWakeContext): Promise<EntityWakeResult> {
    const state = ctx.entity.stateJson as SubjectState;
    if (!state?.script?.stages) {
      if ((state as { version?: unknown })?.version === 2) return this.#handleRelationship(ctx);
      return { done: true }; // malformed legacy subject → stop cleanly
    }
    const facts = { ...(state.facts ?? {}) };
    const consumeInboxIds = ctx.inbox.map((e) => e.id);
    let stageName = state.stage || state.script.start;
    let unread = [...ctx.inbox];

    const base = {
      entityId: ctx.entity.id,
      workspaceId: ctx.entity.workspaceId,
      appId: ctx.entity.appId,
    };

    for (let step = 0; step < MAX_STEPS_PER_WAKE; step++) {
      const stage = state.script.stages[stageName];
      if (!stage)
        return { state: { ...state, stage: stageName, facts }, consumeInboxIds, done: true };

      if (stage.action === 'done') {
        return { state: { ...state, stage: stageName, facts }, consumeInboxIds, done: true };
      }
      if (stage.action === 'send') {
        await this.actions.send({
          ...base,
          facts,
          stage: stageName,
          text: interpolate(stage.text, facts),
        });
        stageName = stage.next;
        continue;
      }
      if (stage.action === 'agent') {
        await this.actions.runAgent({
          ...base,
          facts,
          instruction: interpolate(stage.instruction, facts),
        });
        stageName = stage.next;
        continue;
      }
      // wait
      if (unread.length > 0) {
        const last = unread[unread.length - 1]!;
        facts.lastReply = last.payloadJson ?? null;
        facts[`reply_at_${stageName}`] = last.payloadJson ?? null;
        unread = [];
        stageName = stage.next;
        continue;
      }
      // Park until an inbound event arrives — no timer wake; woken by inbox/correlation.
      // Derive a channel correlation from the subject's facts when the stage didn't
      // specify one, so an inbound reply on the subject's channel routes here for free.
      const correlation = stage.correlation ?? deriveChannelCorrelation(facts);
      return {
        state: { ...state, stage: stageName, facts },
        consumeInboxIds,
        nextWakeAt: null,
        ...(correlation ? { awaitingCorrelation: correlation } : {}),
      };
    }
    // guard tripped (script likely loops) — persist and stop being woken.
    return { state: { ...state, stage: stageName, facts }, consumeInboxIds, done: true };
  }

  /** Goal-directed Subject without a fixed script: update its compact state and wake its planned action. */
  async #handleRelationship(ctx: EntityWakeContext): Promise<EntityWakeResult> {
    const now = new Date().toISOString();
    const state = normalizeRelationshipState(ctx.entity.key, ctx.entity.stateJson);
    // Managed relationship facts follow the same principle as the Brain:
    // expire low-value working knowledge, keep an archive window, and never
    // turn the compact state into an immortal transcript.
    const archiveCutoff = Date.parse(now) - 365 * 24 * 60 * 60_000;
    state.facts = state.facts
      .map((fact) =>
        fact.expiresAt && !fact.archivedAt && Date.parse(fact.expiresAt) <= Date.parse(now)
          ? { ...fact, archivedAt: now }
          : fact,
      )
      .filter((fact) => !fact.archivedAt || Date.parse(fact.archivedAt) > archiveCutoff)
      .slice(-100);
    const inbound = ctx.inbox.filter(
      (event) => event.eventType === 'channel.inbound' || event.eventType === 'reply',
    );
    let inboundActionCancelled = false;
    if (inbound.length > 0) {
      state.lastInboundAt = inbound[inbound.length - 1]!.receivedAt;
      // A person replied before a scheduled nudge: that nudge has served its
      // purpose and must not fire later as an embarrassing duplicate. An action
      // armed with `cancelOnReply: false` survives — some follow-ups (a promised
      // quote, an answer the agent went to fetch) are owed regardless of whether
      // the person wrote again in the meantime.
      if (
        state.nextAction?.kind === 'follow_up' &&
        state.nextAction.cancelOnReply !== false &&
        ['planned', 'ready'].includes(state.nextAction.status)
      ) {
        state.nextAction = { ...state.nextAction, status: 'cancelled' };
        inboundActionCancelled = true;
        appendDecision(state, {
          id: randomUUID(),
          evaluatedAt: now,
          trigger: 'inbound',
          outcome: 'cancelled',
          actionId: state.nextAction.sourceRef ?? null,
          relatedEventIds: inbound.map((event) => event.id).slice(-20),
          reason: 'A nova mensagem da pessoa tornou desnecessário o follow-up planejado.',
        });
      }
    }
    const next = state.nextAction;
    const due =
      next &&
      ['planned', 'ready'].includes(next.status) &&
      (!next.dueAt || Date.parse(next.dueAt) <= Date.parse(now));
    if (due && next) {
      const handle = state.identity.handles[0];
      let result: Awaited<ReturnType<SubjectActions['runAgent']>>;
      try {
        result = await this.actions.runAgent({
          entityId: ctx.entity.id,
          workspaceId: ctx.entity.workspaceId,
          appId: ctx.entity.appId,
          facts: {
            relationship: state,
            ...(handle
              ? {
                  connectionId: handle.connectionId,
                  to: handle.handle,
                  channelKind: handle.channelKind,
                }
              : {}),
          },
          instruction: [
            'Reevaluate the durable relationship before taking any action. Check every precondition, stop condition, open commitment, new inbound event, and current source first.',
            'Do not send a generic nudge. If no useful action is justified, return held with a concise reason. Return performed only after the required action has a verified provider or system receipt.',
            JSON.stringify(next),
            `Relationship state: ${JSON.stringify(state)}`,
          ].join('\n'),
        });
      } catch {
        // A thrown runtime may have failed before or after an external effect.
        // Do not blindly replay a side effect whose provider result is unknown.
        result = {
          outcome: 'held',
          reason:
            'A execução terminou sem confirmação segura; revisão necessária antes de repetir.',
        };
      }
      const outcome = result?.outcome ?? 'held';
      const attempts = (next.attempts ?? 0) + 1;
      // A cadence keeps the action alive for another round; the attempt ceiling
      // is what stops it. Without the ceiling an agent with a 3-day cadence nudges
      // the same silent lead every three days forever — the exact behaviour that
      // makes an outreach account get reported and banned.
      const retry =
        outcome === 'performed' &&
        next.cadenceMs != null &&
        next.cadenceMs > 0 &&
        attempts < (next.maxAttempts ?? 1);
      const reason =
        result?.reason?.trim().slice(0, 300) ??
        (outcome === 'performed'
          ? 'A ação terminou com confirmação do runtime.'
          : outcome === 'blocked'
            ? 'As condições atuais impediram a ação.'
            : 'O runtime não confirmou que a ação foi realizada.');
      state.nextAction = {
        ...next,
        status: outcome === 'performed' ? (retry ? 'planned' : 'done') : 'blocked',
        attempts,
        lastAttemptAt: now,
        ...(retry ? { dueAt: new Date(Date.parse(now) + next.cadenceMs!).toISOString() } : {}),
      };
      if (outcome === 'performed') state.lastOutboundAt = now;
      if (outcome !== 'performed') {
        state.blockers = [...new Set([...state.blockers, reason])].slice(-20);
      }
      appendDecision(state, {
        id: randomUUID(),
        evaluatedAt: now,
        trigger: 'scheduled_action',
        outcome,
        actionId: next.sourceRef ?? null,
        relatedEventIds: ctx.inbox.map((event) => event.id).slice(-20),
        receiptId: result?.receiptId ?? null,
        reason,
      });
    } else if (inbound.length > 0 && !inboundActionCancelled) {
      appendDecision(state, {
        id: randomUUID(),
        evaluatedAt: now,
        trigger: 'inbound',
        outcome: 'no_action',
        relatedEventIds: inbound.map((event) => event.id).slice(-20),
        reason:
          'A nova mensagem foi incorporada; não havia follow-up vencido que justificasse contato proativo.',
      });
    }
    state.updatedAt = now;
    const wake =
      state.nextAction && ['planned', 'ready'].includes(state.nextAction.status)
        ? (state.nextAction.dueAt ?? null)
        : null;
    return {
      state: state as unknown as Record<string, unknown>,
      consumeInboxIds: ctx.inbox.map((event) => event.id),
      nextWakeAt: wake,
      awaitingCorrelation: null,
    };
  }
}

function appendDecision(state: RelationshipState, decision: RelationshipDecision): void {
  state.decisionHistory = [...(state.decisionHistory ?? []), decision].slice(-100);
}

/** The correlation token a subject on a channel awaits — matched by the inbound router. */
export function channelCorrelationId(connectionId: string, address: string): string {
  return `channel:${connectionId}:${address}`;
}

/** Derive the channel correlation from a subject's facts (connectionId + to/chatId). */
function deriveChannelCorrelation(facts: Record<string, unknown>): Correlation | undefined {
  const connectionId = typeof facts.connectionId === 'string' ? facts.connectionId : null;
  const address =
    typeof facts.to === 'string'
      ? facts.to
      : typeof facts.chatId === 'string'
        ? facts.chatId
        : null;
  if (!connectionId || !address) return undefined;
  return { kind: 'channel', id: channelCorrelationId(connectionId, address) };
}

/** Replace {{key}} tokens with the subject's facts (shallow, string coercion). */
function interpolate(text: string, facts: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const v = facts[key];
    return v == null ? '' : String(v);
  });
}
