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

import type { EntityWakeContext, EntityWakeResult, Correlation } from './durableEntities.js';
import type { RelationshipState } from '@agentis/core';
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
  runAgent(args: SubjectActionArgs & { instruction: string }): Promise<{ outcome: 'performed' | 'held' | 'blocked' } | void> | void;
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

    const base = { entityId: ctx.entity.id, workspaceId: ctx.entity.workspaceId, appId: ctx.entity.appId };

    for (let step = 0; step < MAX_STEPS_PER_WAKE; step++) {
      const stage = state.script.stages[stageName];
      if (!stage) return { state: { ...state, stage: stageName, facts }, consumeInboxIds, done: true };

      if (stage.action === 'done') {
        return { state: { ...state, stage: stageName, facts }, consumeInboxIds, done: true };
      }
      if (stage.action === 'send') {
        await this.actions.send({ ...base, facts, stage: stageName, text: interpolate(stage.text, facts) });
        stageName = stage.next;
        continue;
      }
      if (stage.action === 'agent') {
        await this.actions.runAgent({ ...base, facts, instruction: interpolate(stage.instruction, facts) });
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
      .map((fact) => fact.expiresAt && !fact.archivedAt && Date.parse(fact.expiresAt) <= Date.parse(now)
        ? { ...fact, archivedAt: now }
        : fact)
      .filter((fact) => !fact.archivedAt || Date.parse(fact.archivedAt) > archiveCutoff)
      .slice(-100);
    const inbound = ctx.inbox.filter((event) => event.eventType === 'channel.inbound' || event.eventType === 'reply');
    if (inbound.length > 0) {
      state.lastInboundAt = inbound[inbound.length - 1]!.receivedAt;
      // A person replied before a scheduled nudge: that nudge has served its
      // purpose and must not fire later as an embarrassing duplicate.
      if (state.nextAction?.kind === 'follow_up' && ['planned', 'ready'].includes(state.nextAction.status)) {
        state.nextAction = { ...state.nextAction, status: 'cancelled' };
      }
    }
    const next = state.nextAction;
    const due = next && ['planned', 'ready'].includes(next.status)
      && (!next.dueAt || Date.parse(next.dueAt) <= Date.parse(now));
    if (due && next) {
      const handle = state.identity.handles[0];
      const result = await this.actions.runAgent({
        entityId: ctx.entity.id,
        workspaceId: ctx.entity.workspaceId,
        appId: ctx.entity.appId,
        facts: {
          relationship: state,
          ...(handle ? { connectionId: handle.connectionId, to: handle.handle, channelKind: handle.channelKind } : {}),
        },
        instruction: [
          'Advance the durable relationship next action below. Check its preconditions and stop conditions first.',
          'Use the known channel destination only if a useful action is still warranted. Never send a generic nudge.',
          JSON.stringify(next),
          `Relationship state: ${JSON.stringify(state)}`,
        ].join('\n'),
      });
      const outcome = result?.outcome ?? 'performed';
      state.nextAction = {
        ...next,
        status: outcome === 'blocked' ? 'blocked' : 'done',
        attempts: (next.attempts ?? 0) + 1,
        lastAttemptAt: now,
      };
      if (outcome === 'performed') state.lastOutboundAt = now;
    }
    state.updatedAt = now;
    const wake = state.nextAction && ['planned', 'ready'].includes(state.nextAction.status)
      ? state.nextAction.dueAt ?? null
      : null;
    return {
      state: state as unknown as Record<string, unknown>,
      consumeInboxIds: ctx.inbox.map((event) => event.id),
      nextWakeAt: wake,
      awaitingCorrelation: null,
    };
  }
}

/** The correlation token a subject on a channel awaits — matched by the inbound router. */
export function channelCorrelationId(connectionId: string, address: string): string {
  return `channel:${connectionId}:${address}`;
}

/** Derive the channel correlation from a subject's facts (connectionId + to/chatId). */
function deriveChannelCorrelation(facts: Record<string, unknown>): Correlation | undefined {
  const connectionId = typeof facts.connectionId === 'string' ? facts.connectionId : null;
  const address = typeof facts.to === 'string' ? facts.to : (typeof facts.chatId === 'string' ? facts.chatId : null);
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
