/**
 * ProactiveFollowupService — the App reaches out first (LIVING-APPS-10X Phase 3 / §4.5).
 *
 * ⚠️ LEGACY NAME / PARALLEL PATH (Agent-Native Platform Plan §3.2). Sweeps due
 * `app_contacts` and reaches out — a contact-flavored precursor to the general Subject
 * lifecycle on the Durable Entity spine (a Subject's `wait`/timer + the dispatcher).
 * New proactive/lifecycle behavior belongs on the spine (`SubjectRuntime`), not here.
 * Retiring this sweep is gated on the `app_contacts`→Subject fold (post-soak migration).
 *
 * A resident agent must initiate, not only react. Each contact carries a
 * `nextTouchAt` clock; when it falls due this sweep dispatches a turn into the
 * contact's conversation with a follow-up goal, the agent composes a message,
 * and the dispatcher delivers it to the channel — then the clock is cleared.
 *
 * Reuses the existing inbound `ChannelTurnDispatcher` (the follow-up prompt is
 * fed as the turn's text), so there is no second turn engine. Best-effort and
 * non-throwing: a contact with no resolvable conversation just has its clock
 * cleared so it never blocks the sweep.
 */

import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { AppContactService } from './app/appContacts.js';
import type { ChannelTurnDispatcher } from './conversation/channelTurnDispatcher.js';
import type { OutboundPolicyService } from './outboundPolicy.js';

/**
 * Surfaces a held outbound follow-up to the operator for in-thread approval
 * (G7 / Phase 2). Returns true when an approval was created (the follow-up is
 * NOT dispatched). Best-effort — a missing hook means the follow-up is simply
 * skipped, never sent unapproved.
 */
export interface OutboundApprovalRequester {
  (args: {
    workspaceId: string;
    appId: string;
    conversationId: string;
    contactName: string;
    reason: string;
  }): Promise<boolean> | boolean;
}

export interface ProactiveFollowupDeps {
  db: AgentisSqliteDb;
  contacts: AppContactService;
  dispatcher: Pick<ChannelTurnDispatcher, 'dispatch'>;
  logger: Logger;
  /** Outbound safety envelope (G7). When wired, a not-allowed follow-up is blocked/held. */
  policy?: OutboundPolicyService;
  /** Surface a held follow-up to the operator for approval (G7 in-thread approval). */
  requestApproval?: OutboundApprovalRequester;
}

export class ProactiveFollowupService {
  constructor(private readonly deps: ProactiveFollowupDeps) {}

  /** Fire all due follow-ups. Returns how many turns were dispatched. */
  async sweep(now: string = new Date().toISOString()): Promise<{ fired: number; cleared: number }> {
    const due = this.deps.contacts.dueForFollowUp(now);
    let fired = 0;
    let cleared = 0;
    for (const contact of due) {
      try {
        const outcome = await this.#followUp(contact);
        if (outcome === 'fired') fired += 1;
        if (outcome === 'fired' || outcome === 'held') {
          this.deps.contacts.clearNextTouch(contact.id);
          cleared += 1;
        } else {
          const delayMs = outcome === 'blocked' ? 60 * 60_000 : 15 * 60_000;
          this.deps.contacts.deferNextTouch(contact.id, new Date(Date.parse(now) + delayMs).toISOString());
        }
      } catch (err) {
        this.deps.logger.warn('proactive.followup.failed', { contactId: contact.id, err: (err as Error).message });
      }
    }
    return { fired, cleared };
  }

  async #followUp(contact: {
    id: string; workspaceId: string; appId: string | null; channelKind: string | null; handle: string | null; displayName: string | null; goal: string | null;
    stage?: string | null; dataJson?: unknown; subjectId?: string | null;
  }): Promise<'fired' | 'held' | 'blocked' | 'unresolved'> {
    if (!contact.appId || !contact.channelKind || !contact.handle) return 'unresolved';
    // Resolve the live thread for this contact (DM channels: handle == chat id).
    const conv = this.deps.db
      .select({ id: schema.conversations.id, agentId: schema.conversations.agentId, userId: schema.conversations.userId, connectionId: schema.conversations.channelConnectionId, handoffState: schema.conversations.handoffState })
      .from(schema.conversations)
      .where(and(
        eq(schema.conversations.appId, contact.appId),
        eq(schema.conversations.channelChatId, contact.handle),
      ))
      .get();
    if (!conv || !conv.connectionId) return 'unresolved';
    // A human in the thread? Don't barge in.
    if (conv.handoffState === 'human') return 'blocked';

    const who = contact.displayName ?? 'this contact';
    const goal = contact.goal ?? 'continue the relationship and move it forward';
    // §3.1/§3.2 — the follow-up is a judgment call, not a canned nudge. Feed the
    // agent everything the subject's durable state knows (pipeline stage + learned
    // facts), so the message it composes is informed rather than generic.
    const stage = contact.stage && contact.stage !== 'new' ? contact.stage : null;
    const facts = renderFacts(contact.dataJson);
    const context = [
      stage ? `Current stage: ${stage}.` : '',
      facts ? `What you know about them: ${facts}.` : '',
    ].filter(Boolean).join(' ');

    // Outbound safety envelope (G7): gate the agent-initiated follow-up. The goal
    // text is the proxy for what the agent will say (claim/approval guard); rate
    // limit + quiet hours apply because the App is reaching out unsupervised.
    if (this.deps.policy) {
      const autonomy = this.deps.policy.evaluateAutonomy(contact.appId, 'proactive_followup', contact.id);
      if (autonomy.decision !== 'allow') {
        if (autonomy.decision === 'require_approval' && this.deps.requestApproval) {
          const created = await this.deps.requestApproval({ workspaceId: contact.workspaceId, appId: contact.appId, conversationId: conv.id, contactName: who, reason: autonomy.reason });
          return created ? 'held' : 'blocked';
        }
        return 'blocked';
      }
      const decision = this.deps.policy.evaluate(contact.appId, { body: goal, source: 'agent' });
      if (!decision.allow) {
        if (decision.needsApproval && this.deps.requestApproval) {
          const created = await this.deps.requestApproval({
            workspaceId: contact.workspaceId,
            appId: contact.appId,
            conversationId: conv.id,
            contactName: who,
            reason: decision.reason ?? 'requires approval',
          });
          this.deps.logger.info('proactive.followup.held_for_approval', { contactId: contact.id, created, reason: decision.reason });
        } else {
          this.deps.logger.info('proactive.followup.blocked', { contactId: contact.id, reason: decision.reason });
        }
        return decision.needsApproval ? 'held' : 'blocked';
      }
    }

    await this.deps.dispatcher.dispatch({
      workspaceId: contact.workspaceId,
      ambientId: null,
      userId: conv.userId,
      agentId: conv.agentId,
      appId: contact.appId,
      conversationId: conv.id,
      connectionId: conv.connectionId,
      kind: contact.channelKind,
      chatId: contact.handle,
      initiatedBy: 'proactive',
      ...(contact.subjectId ? { subjectId: contact.subjectId } : {}),
      text: `[Scheduled follow-up — you are reaching out first, this is not a reply to a new message] Follow up with ${who} as promised. Goal: ${goal}.${context ? ` ${context}` : ''} Send a brief, warm, on-topic message grounded in what you know about them; if there is nothing useful to say, stay quiet.`,
    });
    // Count this agent-initiated outbound against the App's rolling rate window (G7).
    this.deps.policy?.record(contact.appId, 'agent');
    return 'fired';
  }
}

/** Compact, bounded rendering of a subject's learned facts for the follow-up prompt. */
function renderFacts(dataJson: unknown): string {
  if (!dataJson || typeof dataJson !== 'object' || Array.isArray(dataJson)) return '';
  const entries = Object.entries(dataJson as Record<string, unknown>)
    .filter(([, v]) => v != null && (typeof v !== 'object'))
    .slice(0, 6)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`);
  return entries.join('; ');
}
