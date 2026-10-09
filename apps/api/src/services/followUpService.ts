/**
 * FollowUpService — the verb an agent was missing: "come back to this later".
 *
 * The durable machinery for a delayed action already existed (a relationship
 * Subject on the Durable Entity spine carries a `nextAction` whose `dueAt` arms a
 * restart-durable wake, and `SubjectRuntime` runs an agent step when it falls
 * due). What did not exist was a way for the agent to SAY so. The only route was
 * `agentis.subject.update_relationship`, which demands the whole compact state —
 * facts, engagements, commitments — be resent to change one field. So a turn that
 * ended with "I'll check back tomorrow" ended, full stop: the intention had
 * nowhere to live and the conversation died there.
 *
 * This service is that missing verb, and nothing more. It does not schedule, wake,
 * or send anything itself — it writes one `nextAction` and hands the wake clock to
 * the spine, which already paces, leases, and survives restarts. Arming a cohort
 * of fifty is fifty independent wakes, not one turn that must carry fifty leads
 * through a single model context.
 */

import { and, eq } from 'drizzle-orm';
import { AgentisError, type RelationshipNextAction, type RelationshipState } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { DurableEntityService, EntityRow } from './durableEntities.js';
import { normalizeRelationshipState } from './relationshipStateService.js';
import { staggeredStarts, resolveStartAt } from './workflow/deferredStart.js';

/** Ways a caller can name the person a follow-up is about. */
export interface SubjectSelector {
  subjectId?: string | null;
  subjectKey?: string | null;
  /** `peer:<id>` from agentis.channel.inbox — the reference an agent actually holds mid-conversation. */
  recipientRef?: string | null;
  conversationId?: string | null;
}

export interface ScheduleFollowUpInput extends SubjectSelector {
  workspaceId: string;
  /** What the agent should accomplish when it wakes. Written to `nextAction.goal`. */
  goal: string;
  kind?: RelationshipNextAction['kind'];
  /** Absolute instant, additive with `delayMs`. */
  dueAt?: string | null;
  delayMs?: number | null;
  jitterMs?: number | null;
  preconditions?: string[];
  stopConditions?: string[];
  maxAttempts?: number | null;
  cadenceMs?: number | null;
  cancelOnReply?: boolean;
  sourceRef?: string | null;
  /**
   * Overwrite an action that is already planned. Default false: a cohort sweep
   * re-running must not stomp a commitment the agent made inside a live
   * conversation, which is both more specific and more recent than any sweep.
   */
  replace?: boolean;
}

export interface ScheduledFollowUp {
  subjectId: string;
  subjectKey: string;
  displayName: string | null;
  dueAt: string;
  armed: boolean;
  /** Why an arm was declined, when `armed` is false. */
  reason?: 'already_planned' | 'max_attempts_reached';
  nextAction: RelationshipNextAction;
}

const DEFAULT_DELAY_MS = 24 * 60 * 60_000;
const MAX_COHORT = 500;

export class FollowUpService {
  constructor(private readonly deps: { db: AgentisSqliteDb; entities: DurableEntityService }) {}

  /** Arm one subject's next action and hand its wake clock to the spine. */
  schedule(input: ScheduleFollowUpInput, now: Date = new Date()): ScheduledFollowUp {
    const goal = input.goal?.trim();
    if (!goal) throw new AgentisError('VALIDATION_FAILED', 'a follow-up needs a goal — what should the agent accomplish when it wakes?');
    const entity = this.resolveSubject(input.workspaceId, input);
    const state = normalizeRelationshipState(entity.key, entity.stateJson);
    const dueAt = resolveStartAt(
      {
        startAt: input.dueAt ?? null,
        // An unqualified "follow up" means tomorrow, not this instant. Arming
        // with no delay would fire on the very next sweep, seconds after the
        // reply the agent just sent.
        delayMs: input.dueAt || input.delayMs != null ? input.delayMs ?? null : DEFAULT_DELAY_MS,
        jitterMs: input.jitterMs ?? null,
      },
      now,
    ) ?? now.toISOString();

    const existing = state.nextAction;
    if (!input.replace && existing && ['planned', 'ready'].includes(existing.status)) {
      return present(entity, state, existing, existing.dueAt ?? dueAt, false, 'already_planned');
    }

    const nowIso = now.toISOString();
    const nextAction: RelationshipNextAction = {
      kind: input.kind ?? 'follow_up',
      goal,
      dueAt,
      status: 'planned',
      attempts: 0,
      lastAttemptAt: null,
      maxAttempts: clampAttempts(input.maxAttempts),
      cadenceMs: input.cadenceMs != null && input.cadenceMs > 0 ? Math.floor(input.cadenceMs) : null,
      // A nudge that lands after the person already wrote back is the single most
      // recognisable "this is a bot" failure. Opt out explicitly, never by default.
      cancelOnReply: input.cancelOnReply ?? true,
      armedAt: nowIso,
      sourceRef: input.sourceRef ?? null,
      ...(input.preconditions?.length ? { preconditions: input.preconditions.slice(0, 10) } : {}),
      ...(input.stopConditions?.length ? { stopConditions: input.stopConditions.slice(0, 10) } : {}),
    };

    this.#write(entity, { ...state, nextAction, updatedAt: nowIso }, dueAt);
    return present(entity, state, nextAction, dueAt, true);
  }

  /**
   * Arm a cohort, spread over time. Pacing is the point: fifty follow-ups landing
   * in the same second is a provider ban and an obvious blast, so the batch is
   * staggered by `everyMs` and jittered off the exact grid — the same spacing
   * contract conversation enrolment already uses.
   */
  scheduleMany(
    input: Omit<ScheduleFollowUpInput, keyof SubjectSelector> & {
      subjects: SubjectSelector[];
      everyMs?: number | null;
      startAt?: string | null;
    },
    now: Date = new Date(),
  ): { armed: number; skipped: number; failed: number; followUps: Array<ScheduledFollowUp & { error?: string }> } {
    const subjects = input.subjects.slice(0, MAX_COHORT);
    const starts = staggeredStarts(
      subjects.length,
      {
        startAt: input.startAt ?? input.dueAt ?? null,
        delayMs: input.delayMs ?? null,
        everyMs: input.everyMs ?? null,
        jitterMs: input.jitterMs ?? null,
      },
      now,
    );
    const followUps: Array<ScheduledFollowUp & { error?: string }> = [];
    for (const [index, selector] of subjects.entries()) {
      try {
        followUps.push(this.schedule(
          { ...input, ...selector, dueAt: starts[index] ?? null, delayMs: null, jitterMs: null },
          now,
        ));
      } catch (error) {
        // One unresolvable subject must not abandon the rest of the cohort.
        followUps.push({
          subjectId: '', subjectKey: selectorLabel(selector), displayName: null,
          dueAt: '', armed: false, nextAction: { kind: 'follow_up', goal: input.goal, status: 'cancelled' },
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      armed: followUps.filter((item) => item.armed).length,
      skipped: followUps.filter((item) => !item.armed && !item.error).length,
      failed: followUps.filter((item) => item.error).length,
      followUps,
    };
  }

  /** Withdraw a planned action. Idempotent — a subject with nothing armed is not an error. */
  cancel(workspaceId: string, selector: SubjectSelector, reason?: string): { subjectId: string; cancelled: boolean } {
    const entity = this.resolveSubject(workspaceId, selector);
    const state = normalizeRelationshipState(entity.key, entity.stateJson);
    const action = state.nextAction;
    if (!action || !['planned', 'ready'].includes(action.status)) return { subjectId: entity.id, cancelled: false };
    const now = new Date().toISOString();
    this.#write(
      entity,
      {
        ...state,
        nextAction: { ...action, status: 'cancelled', lastAttemptAt: now, ...(reason ? { goal: `${action.goal} (cancelled: ${reason})` } : {}) },
        updatedAt: now,
      },
      // Clearing the timer is what actually stops the wake; leaving it armed
      // would wake the entity to discover a cancelled action every sweep.
      null,
    );
    return { subjectId: entity.id, cancelled: true };
  }

  /** Resolve any of the four ways a caller can name a person to their relationship Subject. */
  resolveSubject(workspaceId: string, selector: SubjectSelector): EntityRow {
    const entity = this.#lookup(workspaceId, selector);
    if (!entity) throw new AgentisError('RESOURCE_NOT_FOUND', `no relationship subject for ${selectorLabel(selector)}`);
    if (entity.workspaceId !== workspaceId || entity.kind !== 'subject') {
      throw new AgentisError('RESOURCE_NOT_FOUND', `no relationship subject for ${selectorLabel(selector)}`);
    }
    return entity;
  }

  #lookup(workspaceId: string, selector: SubjectSelector): EntityRow | null {
    if (selector.subjectId) return this.deps.entities.get(selector.subjectId);
    if (selector.subjectKey) return this.deps.entities.getByKey(workspaceId, 'subject', selector.subjectKey);
    if (selector.recipientRef) {
      const peerId = /^peer:([0-9a-z-]+)$/i.exec(selector.recipientRef.trim())?.[1];
      if (!peerId) throw new AgentisError('VALIDATION_FAILED', `recipientRef must look like "peer:<id>" (got ${selector.recipientRef})`);
      const identity = this.deps.db.select({ grounding: schema.channelPeerIdentities.groundingEntityId })
        .from(schema.channelPeerIdentities)
        .where(and(eq(schema.channelPeerIdentities.workspaceId, workspaceId), eq(schema.channelPeerIdentities.id, peerId)))
        .get();
      return identity?.grounding ? this.deps.entities.get(identity.grounding) : null;
    }
    if (selector.conversationId) {
      const conversation = this.deps.db.select({ peerId: schema.conversations.channelPeerIdentityId })
        .from(schema.conversations)
        .where(and(eq(schema.conversations.workspaceId, workspaceId), eq(schema.conversations.id, selector.conversationId)))
        .get();
      if (!conversation?.peerId) return null;
      return this.#lookup(workspaceId, { recipientRef: `peer:${conversation.peerId}` });
    }
    throw new AgentisError('VALIDATION_FAILED', 'name the person: subjectId, subjectKey, recipientRef, or conversationId');
  }

  #write(entity: EntityRow, state: RelationshipState, nextWakeAt: string | null): void {
    this.deps.entities.upsert({
      workspaceId: entity.workspaceId,
      kind: 'subject',
      key: entity.key,
      state: state as unknown as Record<string, unknown>,
      nextWakeAt,
    });
  }
}

function present(
  entity: EntityRow,
  state: RelationshipState,
  nextAction: RelationshipNextAction,
  dueAt: string,
  armed: boolean,
  reason?: ScheduledFollowUp['reason'],
): ScheduledFollowUp {
  return {
    subjectId: entity.id,
    subjectKey: entity.key,
    displayName: state.identity?.displayName ?? null,
    dueAt,
    armed,
    ...(reason ? { reason } : {}),
    nextAction,
  };
}

function clampAttempts(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(10, Math.floor(value)));
}

function selectorLabel(selector: SubjectSelector): string {
  return selector.subjectId ?? selector.subjectKey ?? selector.recipientRef ?? selector.conversationId ?? 'unnamed subject';
}
