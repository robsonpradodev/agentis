/**
 * ChannelAskSuspensionPresenter — "I'll check with the team and get back to you."
 *
 * Before this, the only way an agent could pause for outside input was
 * `human_response`, which lands in the Agentis operator inbox — a surface the
 * customer-facing team on WhatsApp never opens. An agent that genuinely needed a
 * colleague's answer had no route to ask for it, so it either guessed or dropped
 * the promise and went silent. This presenter is the second `agentis.suspend`
 * condition: it delivers the question through a real channel thread (the same
 * one anyone already uses to talk to the team), and any reply in that thread —
 * from a person who did nothing but answer a WhatsApp message — resolves the
 * wait and resumes the original conversation exactly where it paused.
 *
 * The correlation is the same one Subjects already use for out-of-order,
 * multi-day channel replies (`channelCorrelationId`): no new routing concept,
 * just a second consumer of it. `DurableSuspensionService` stays condition-
 * agnostic; this class is the only place that knows what "channel" means.
 */

import type { DurableSuspension } from '@agentis/core';
import type { ChannelActionIntentService } from '../conversation/channelActionIntentService.js';
import type { ChannelInboxService } from '../conversation/channelInboxService.js';
import type { Logger } from '../../logger.js';
import type { DurableSuspensionService, SuspensionPresenter } from './durableSuspensionService.js';
import { channelCorrelationId } from '../subjectRuntime.js';

export interface ChannelAskPresenterDeps {
  channelActions: ChannelActionIntentService;
  inbox: ChannelInboxService;
  suspensions: DurableSuspensionService;
  logger: Logger;
}

export class ChannelAskSuspensionPresenter implements SuspensionPresenter {
  constructor(private readonly deps: ChannelAskPresenterDeps) {}

  async present(suspension: DurableSuspension): Promise<{ ref: string }> {
    assertSupportedAudience(suspension);
    if (!suspension.ownerAgentId) {
      throw new Error('channel_ask requires an operating agent to send as (ownerAgentId)');
    }
    const payload = suspension.condition.payload;
    const recipientRef = stringValue(payload.recipientRef);
    if (!recipientRef) {
      throw new Error('channel_ask requires condition.payload.recipientRef — resolve the destination with agentis.channel.inbox first');
    }
    const peer = this.deps.inbox.get(suspension.workspaceId, recipientRef);
    if (!peer) throw new Error(`channel_ask recipientRef not found: ${recipientRef}`);
    const connectionId = stringValue(payload.connectionId) || peer.connectionId;
    const prompt = stringValue(payload.prompt) || suspension.reason;
    const title = stringValue(payload.title);
    const body = title ? `${title}\n\n${prompt}` : prompt;
    const address = this.deps.inbox.preferredAddress(peer.peerIdentityId);

    await this.deps.channelActions.createAndExecute({
      workspaceId: suspension.workspaceId,
      agentId: suspension.ownerAgentId,
      connectionId,
      recipientRef,
      goal: `Asking for input needed to continue: ${suspension.reason}`.slice(0, 500),
      body,
      // The agent is reaching out on its own initiative, not answering the person
      // it is asking — the same basis a proactive follow-up uses.
      authorizationBasis: 'standing_goal',
      idempotencyKey: `suspension_ask:${suspension.id}`,
      ...(suspension.requesterUserId ? { userId: suspension.requesterUserId } : {}),
    });

    // The correlation this suspension now awaits — identical shape to a Subject's
    // channel correlation, so the same inbound reply matches either mechanism.
    return { ref: channelCorrelationId(connectionId, address) };
  }

  async cancel(): Promise<void> {
    // The question was already delivered as a real message; there is nothing to
    // withdraw from the channel. Cancellation just stops it from being resolved.
  }

  /**
   * Match one inbound channel message against any suspension awaiting it. Called
   * from the same inbound hook Subjects use, so a reply resolves whichever of the
   * two (at most one) is actually waiting on that thread. Best-effort: a match
   * failure must never break the inbound turn it rides along with.
   */
  async resolveInbound(args: { workspaceId: string; connectionId: string; chatId: string; text?: string; from?: string }): Promise<boolean> {
    if (!args.text?.trim()) return false;
    try {
      const correlation = channelCorrelationId(args.connectionId, args.chatId);
      const waiting = this.deps.suspensions
        .list(args.workspaceId, ['presenting', 'waiting'])
        .find((row) => row.condition.type === 'channel_ask' && row.presentationRef === correlation);
      if (!waiting) return false;
      await this.deps.suspensions.resolve({
        workspaceId: args.workspaceId,
        suspensionId: waiting.id,
        resolution: { kind: 'channel_reply', data: { text: args.text, from: args.from ?? null } },
      });
      return true;
    } catch (err) {
      this.deps.logger.warn('suspension.channel_ask.resolve_failed', { connectionId: args.connectionId, chatId: args.chatId, err: (err as Error).message });
      return false;
    }
  }
}

function assertSupportedAudience(suspension: DurableSuspension): void {
  if (suspension.audience.type !== 'channel_thread') {
    throw new Error(`channel_ask cannot be presented to audience '${suspension.audience.type}' — use {"type":"channel_thread"}`);
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
