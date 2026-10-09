import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import { AgentisError } from '@agentis/core';
import { isAcknowledgedChannelDelivery, type ChannelDeliveryReceipt, type OutboundAttachmentRef } from '../../adapters/channels/types.js';
import type { ConversationStore } from './conversationStore.js';
import type { ChannelTurnInput, ChannelTurnDeliver } from './channelTurnDispatcher.js';

type Message = Pick<typeof schema.conversationMessages.$inferSelect, 'id' | 'sessionMessageId' | 'metadata' | 'body'>;
export class ChannelReplyPending extends Error {
  constructor(readonly outcome: 'delivery_retry' | 'delivery_pending' | 'delivery_failed', detail: string) {
    super(detail); this.name = 'ChannelReplyPending';
  }
}
export function channelReplyTurnKey(input: ChannelTurnInput): string {
  return input.inboundMessageId ?? input.deliveryTurnId ?? `${input.conversationId}:${input.turnGeneration ?? 0}`;
}
/** Recovery uses the persisted answer and receipt journal, never the model or its tools. */
export class ChannelReplyRecovery {
  constructor(private readonly db: AgentisSqliteDb, private readonly conversations: ConversationStore) {}
  find(input: ChannelTurnInput): Message | undefined {
    return this.db.select().from(schema.conversationMessages).where(and(
      eq(schema.conversationMessages.workspaceId, input.workspaceId),
      eq(schema.conversationMessages.conversationId, input.conversationId),
      sql`json_extract(${schema.conversationMessages.metadata}, '$.channelTurnKey') = ${channelReplyTurnKey(input)}`,
      sql`json_extract(${schema.conversationMessages.metadata}, '$.channelDeliveryClass') = 'reply'`,
    )).get() as Message | undefined;
  }
  async deliver(input: ChannelTurnInput, message: Message, send: ChannelTurnDeliver): Promise<ChannelDeliveryReceipt> {
    const meta = message.metadata as Record<string, unknown>;
    const key = message.sessionMessageId!;
    const journal = this.db.select().from(schema.channelOutboundDeliveries).where(and(
      eq(schema.channelOutboundDeliveries.workspaceId, input.workspaceId),
      eq(schema.channelOutboundDeliveries.connectionId, input.connectionId),
      eq(schema.channelOutboundDeliveries.idempotencyKey, key),
    )).get();
    const receipt = (journal?.receipt ?? meta.channelDeliveryReceipt) as ChannelDeliveryReceipt | undefined;
    if (journal?.status !== 'rejected' && isAcknowledgedChannelDelivery(receipt)) {
      this.update(input, message, receipt!); return receipt!;
    }
    const attempts = Number(meta.deliveryAttempts ?? 0);
    // Once the provider boundary was crossed, only a receipt may resolve it.
    if (journal && !['prepared', 'failed_pre_submit'].includes(journal.status)) {
      const reason = journal.status === 'rejected' ? 'delivery_failed' : 'delivery_pending';
      this.attention(input, journal.error ?? 'Awaiting provider acknowledgement; do not resend.', key);
      throw new ChannelReplyPending(reason, journal.error ?? 'Provider submission is awaiting reconciliation');
    }
    if (attempts >= 3) {
      this.attention(input, String(meta.deliveryError ?? 'Delivery retries exhausted'), key);
      throw new ChannelReplyPending('delivery_failed', 'Delivery retries exhausted; saved answer requires intervention');
    }
    this.conversations.updateDeliveryStatus({workspaceId: input.workspaceId, conversationId: input.conversationId,
      messageId: message.id, deliveryStatus: 'sending', metadata: {deliveryAttempts: attempts + 1}});
    try {
      const sent = await send({ connectionId: input.connectionId, chatId: input.chatId,
        body: typeof meta.preparedBody === 'string' ? meta.preparedBody : message.body,
        attachments: meta.channelAttachments as OutboundAttachmentRef[] | undefined,
        idempotencyKey: key, conversationId: input.conversationId, pacing: 'immediate',
        ...(input.automationEpoch !== undefined ? {expectedAutomationEpoch: input.automationEpoch} : {}),
      });
      if (!isAcknowledgedChannelDelivery(sent)) {
        this.conversations.updateDeliveryStatus({workspaceId: input.workspaceId, conversationId: input.conversationId,
          messageId: message.id, deliveryStatus: 'sending', metadata: {channelDeliveryReceipt: sent ?? null,
            deliveryError: 'Provider has not acknowledged this submission', deliveryUncertain: true}});
        this.attention(input, 'Provider has not acknowledged this submission; reconcile before resending.', key);
        throw new ChannelReplyPending('delivery_pending', 'Provider has not acknowledged this submission');
      }
      this.update(input, message, sent!); return sent!;
    } catch (error) {
      if (error instanceof ChannelReplyPending) throw error;
      const cancelled = error instanceof AgentisError && ['CHANNEL_HUMAN_TAKEOVER_ACTIVE', 'TURN_CANCELLED'].includes(error.code);
      const latest = this.db.select().from(schema.channelOutboundDeliveries).where(and(
        eq(schema.channelOutboundDeliveries.workspaceId, input.workspaceId),
        eq(schema.channelOutboundDeliveries.idempotencyKey, key),
      )).get();
      const uncertain = !!latest && ['provider_submitted', 'uncertain'].includes(latest.status);
      const detail = error instanceof Error ? error.message : String(error);
      const attachments = Array.isArray(meta.channelAttachments) ? meta.channelAttachments as OutboundAttachmentRef[] : [];
      const confirmedFailure = !uncertain && (!latest || ['rejected', 'failed_pre_submit'].includes(latest.status));
      if (confirmedFailure && attachments.length > 0) {
        return this.deliverTextFallback(input, message, detail, send, attachments);
      }
      this.conversations.updateDeliveryStatus({workspaceId: input.workspaceId, conversationId: input.conversationId,
        messageId: message.id, deliveryStatus: uncertain ? 'sending' : 'failed',
        metadata: {deliveryError: detail, deliveryUncertain: uncertain, channelAutomationCancelled: cancelled}});
      if (cancelled) throw error;
      this.attention(input, detail, key);
      throw new ChannelReplyPending(uncertain ? 'delivery_pending' : latest?.status === 'rejected' || attempts >= 2 ? 'delivery_failed' : 'delivery_retry', detail);
    }
  }
  private async deliverTextFallback(
    input: ChannelTurnInput,
    original: Message,
    detail: string,
    send: ChannelTurnDeliver,
    attachments: OutboundAttachmentRef[],
  ): Promise<ChannelDeliveryReceipt> {
    const metadata = original.metadata as Record<string, unknown>;
    const turnKey = typeof metadata.channelTurnKey === 'string' ? metadata.channelTurnKey : channelReplyTurnKey(input);
    const body = typeof metadata.preparedBody === 'string' ? metadata.preparedBody.trim() : '';
    const audio = attachments.some((attachment) => attachment.kind === 'voice' || attachment.kind === 'audio' || Boolean(attachment.text));
    const spokenText = attachments.find((attachment) => typeof attachment.text === 'string' && attachment.text.trim())?.text?.trim();
    const fallbackBody = audio
      ? `Não consegui enviar a resposta em áudio. Deixo em texto: ${spokenText || body || 'Posso tentar novamente se você preferir.'}`
      : 'Não consegui enviar o arquivo agora. Posso tentar novamente ou ajudar com uma alternativa.';
    this.conversations.updateDeliveryStatus({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      messageId: original.id,
      deliveryStatus: 'failed',
      metadata: {channelDeliveryClass: 'media_failed', deliveryError: detail, channelMediaFallback: true},
    });
    const fallbackKey = `channel_reply_fallback_${createHash('sha256').update(original.sessionMessageId ?? turnKey).digest('hex').slice(0, 40)}`;
    const fallback = this.conversations.appendMirrored({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      sessionMessageId: fallbackKey,
      authorType: 'agent',
      participantSide: 'business',
      body: fallbackBody,
      deliveryStatus: 'sending',
      metadata: {
        channel: input.kind,
        channelConnectionId: input.connectionId,
        channelReply: true,
        channelChatId: input.chatId,
        channelTurnKey: turnKey,
        preparedBody: fallbackBody,
        channelDeliveryClass: 'reply',
        channelDeliveryFallbackOf: original.sessionMessageId ?? null,
      },
    });
    return this.deliver(input, fallback as Message, send);
  }
  private update(input: ChannelTurnInput, message: Message, receipt: ChannelDeliveryReceipt): void {
    this.conversations.updateDeliveryStatus({workspaceId: input.workspaceId, conversationId: input.conversationId,
      messageId: message.id, deliveryStatus: ['read', 'delivered'].includes(receipt.status) ? 'delivered' : 'sent',
      metadata: {channelDeliveryReceipt: receipt, deliveryError: null, deliveryUncertain: false}});
    // Clear only the flag owned by this delivery; preserve unrelated operator attention.
    const current = this.db.select({needsAttentionReason: schema.conversations.needsAttentionReason})
      .from(schema.conversations).where(eq(schema.conversations.id, input.conversationId)).get();
    if (current?.needsAttentionReason?.startsWith(channelDeliveryAttentionPrefix(message.sessionMessageId!))) {
      this.db.update(schema.conversations).set({needsAttention: 0, needsAttentionReason: null})
        .where(eq(schema.conversations.id, input.conversationId)).run();
    }
  }
  private attention(input: ChannelTurnInput, detail: string, deliveryKey: string): void {
    this.db.update(schema.conversations).set({needsAttention: 1, needsAttentionReason: `${channelDeliveryAttentionPrefix(deliveryKey)} ${detail}`.slice(0, 500)})
      .where(and(eq(schema.conversations.id, input.conversationId), eq(schema.conversations.workspaceId, input.workspaceId))).run();
  }
}

export function channelDeliveryAttentionPrefix(deliveryKey: string): string {
  return `Channel delivery [${deliveryKey}]:`;
}
