/**
 * TelegramChannelAdapter — Batch 4.
 *
 * Inbound: Telegram Bot API webhooks. Authentication uses Telegram's
 * `secret_token` mechanism — the bot owner registers a per-webhook shared
 * secret, Telegram echoes it back as the `X-Telegram-Bot-Api-Secret-Token`
 * header on every delivery. We constant-time compare to the value stored on
 * the channel connection.
 *
 * Outbound: HTTPS POST to api.telegram.org/bot<token>/sendMessage.
 *
 * SSRF safety: the destination host is fixed (`api.telegram.org`); we never
 * accept a user-supplied URL.
 */

import { timingSafeEqual } from 'node:crypto';
import { AgentisError } from '@agentis/core';
import type { ChannelAdapter, ChannelDeliveryReceipt, ChannelHealthCheck, OutboundAttachment, OutboundMediaKind, OutboundNativeContent, ParsedInboundMessage } from './types.js';

const TELEGRAM_API = 'https://api.telegram.org';

/** Map a media kind to its Telegram Bot API method + multipart field. */
function telegramMediaEndpoint(kind: OutboundMediaKind): { method: string; field: string; captioned: boolean } {
  switch (kind) {
    case 'image': return { method: 'sendPhoto', field: 'photo', captioned: true };
    case 'video': return { method: 'sendVideo', field: 'video', captioned: true };
    case 'audio': return { method: 'sendAudio', field: 'audio', captioned: true };
    case 'voice': return { method: 'sendVoice', field: 'voice', captioned: true };
    case 'sticker': return { method: 'sendSticker', field: 'sticker', captioned: false };
    case 'file':
    default: return { method: 'sendDocument', field: 'document', captioned: true };
  }
}

/**
 * Effective Telegram inbound transport for a connection.
 *
 * Long polling needs no public URL, so a self-hosted / local install (no
 * AGENTIS_PUBLIC_URL) defaults to polling and "just works" with zero extra
 * config; a deployment that has a public URL defaults to the webhook. An
 * explicit operator choice ('polling' | 'webhook') always wins. This is the
 * single source of truth shared by the ChannelConnectionSupervisor (which boots
 * the live poll loop) and the ChannelBridge diagnostics, so they never disagree
 * about which transport a Telegram connection uses.
 */
export function resolveTelegramTransport(opts: { explicit?: string | null; hasPublicUrl: boolean }): 'polling' | 'webhook' {
  if (opts.explicit === 'polling' || opts.explicit === 'webhook') return opts.explicit;
  return opts.hasPublicUrl ? 'webhook' : 'polling';
}

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly kind = 'telegram' as const;

  // Override for tests to capture outgoing requests.
  fetchImpl: typeof fetch = (...args) => fetch(...args);

  async probeCredential(args: { token: string }): Promise<ChannelHealthCheck> {
    const checkedAt = new Date().toISOString();
    const res = await this.fetchImpl(`${TELEGRAM_API}/bot${encodeURIComponent(args.token)}/getMe`, {
      method: 'GET',
    });
    if (res.ok) {
      const json = await res.json().catch(() => ({})) as { ok?: boolean; result?: { username?: string }; description?: string };
      if (json.ok !== false) {
        return {
          name: 'credential',
          ok: true,
          code: 'telegram_get_me_ok',
          message: json.result?.username ? `Telegram bot token is valid (@${json.result.username}).` : 'Telegram bot token is valid.',
          checkedAt,
        };
      }
      return {
        name: 'credential',
        ok: false,
        code: 'telegram_get_me_failed',
        message: json.description ?? 'Telegram rejected the bot token.',
        remediation: 'Paste the full bot token from @BotFather and save again.',
        checkedAt,
      };
    }
    const text = await res.text().catch(() => '');
    return {
      name: 'credential',
      ok: false,
      code: 'telegram_get_me_failed',
      message: `Telegram getMe failed (${res.status}): ${text.slice(0, 180) || res.statusText}`,
      remediation: 'Check that the bot token is complete and has not been revoked in @BotFather.',
      checkedAt,
    };
  }

  async configureTransport(args: {
    token: string;
    webhookUrl?: string;
    secret?: string | null;
    transport?: string;
  }): Promise<ChannelHealthCheck> {
    const checkedAt = new Date().toISOString();
    if (args.transport === 'polling') {
      const res = await this.fetchImpl(`${TELEGRAM_API}/bot${encodeURIComponent(args.token)}/deleteWebhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ drop_pending_updates: false }),
      });
      if (res.ok) {
        return {
          name: 'transport',
          ok: true,
          code: 'telegram_polling_ready',
          message: 'Telegram webhook is cleared, so long polling can receive updates.',
          checkedAt,
        };
      }
      const text = await res.text().catch(() => '');
      return {
        name: 'transport',
        ok: false,
        code: 'telegram_polling_webhook_clear_failed',
        message: `Telegram deleteWebhook failed (${res.status}): ${text.slice(0, 180) || res.statusText}`,
        remediation: 'Retry the test, or clear the webhook from Telegram before using polling.',
        checkedAt,
      };
    }

    if (!args.webhookUrl) {
      return {
        name: 'transport',
        ok: false,
        code: 'missing_public_url',
        message: 'Telegram webhook mode needs a public Agentis URL.',
        remediation: 'Set AGENTIS_PUBLIC_URL or switch Telegram to long polling.',
        checkedAt,
      };
    }

    const res = await this.fetchImpl(`${TELEGRAM_API}/bot${encodeURIComponent(args.token)}/setWebhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: args.webhookUrl,
        ...(args.secret ? { secret_token: args.secret } : {}),
      }),
    });
    const json = await res.json().catch(() => ({})) as { ok?: boolean; description?: string };
    if (res.ok && json.ok !== false) {
      return {
        name: 'transport',
        ok: true,
        code: 'telegram_webhook_ready',
        message: 'Telegram webhook is configured.',
        checkedAt,
      };
    }
    return {
      name: 'transport',
      ok: false,
      code: 'telegram_set_webhook_failed',
      message: json.description ?? `Telegram setWebhook failed (${res.status}).`,
      remediation: 'Check that AGENTIS_PUBLIC_URL is reachable by Telegram and retry the test.',
      checkedAt,
    };
  }

  async send(args: { token: string; chatId: string; body: string; attachments?: OutboundAttachment[]; native?: OutboundNativeContent }): Promise<ChannelDeliveryReceipt> {
    if (args.native) return this.#sendNative(args.token, args.chatId, args.native, args.body);
    const attachments = args.attachments ?? [];
    if (attachments.length === 0) {
      return this.#sendMessage(args.token, args.chatId, args.body);
    }
    // First attachment carries the body as its caption; the rest go captionless.
    const receipts: ChannelDeliveryReceipt[] = [];
    for (let i = 0; i < attachments.length; i += 1) {
      const caption = i === 0 ? args.body : '';
      receipts.push(await this.#sendMedia(args.token, args.chatId, attachments[i]!, caption));
    }
    const first = receipts[0]!;
    return { ...first, providerMessageIds: receipts.map((receipt) => receipt.providerMessageId) };
  }

  async #sendNative(token: string, chatId: string, native: OutboundNativeContent, body: string): Promise<ChannelDeliveryReceipt> {
    if (native.kind !== 'location' && native.kind !== 'contact' && native.kind !== 'poll') throw new Error('This transport does not support Cloud interactive content or templates');
    const method = native.kind === 'location' ? 'sendLocation' : native.kind === 'contact' ? 'sendContact' : 'sendPoll';
    const nativePayload = native.kind === 'location'
      ? { latitude: native.latitude, longitude: native.longitude }
      : native.kind === 'contact'
        ? {
            phone_number: native.phone,
            first_name: native.displayName.split(/\s+/, 1)[0] || native.displayName,
            ...(native.displayName.includes(' ') ? { last_name: native.displayName.split(/\s+/).slice(1).join(' ') } : {}),
            ...(native.vcard ? { vcard: native.vcard } : {}),
          }
        : {
            question: native.question,
            options: native.options,
            allows_multiple_answers: (native.selectableCount ?? 1) > 1,
          };
    const res = await this.fetchImpl(`${TELEGRAM_API}/bot${encodeURIComponent(token)}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, ...nativePayload }),
    });
    if (!res.ok) await this.#throwSendError(res, chatId, method);
    const receipt = await this.#receipt(res, chatId, method);
    if (!body.trim()) return receipt;
    const textReceipt = await this.#sendMessage(token, chatId, body.trim());
    return { ...receipt, providerMessageIds: [receipt.providerMessageId, textReceipt.providerMessageId] };
  }

  async #sendMessage(token: string, chatId: string, body: string): Promise<ChannelDeliveryReceipt> {
    const url = `${TELEGRAM_API}/bot${encodeURIComponent(token)}/sendMessage`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: body }),
    });
    if (!res.ok) await this.#throwSendError(res, chatId, 'sendMessage');
    return this.#receipt(res, chatId, 'sendMessage');
  }

  async #sendMedia(token: string, chatId: string, attachment: OutboundAttachment, caption: string): Promise<ChannelDeliveryReceipt> {
    // Map each media kind to its dedicated Bot API method + form field so
    // Telegram renders it natively. Stickers carry no caption.
    const { method, field, captioned } = telegramMediaEndpoint(attachment.kind);
    const form = new FormData();
    form.set('chat_id', chatId);
    if (captioned && caption) form.set('caption', caption.slice(0, 1024));
    form.set(field, new Blob([new Uint8Array(attachment.data)], { type: attachment.mimeType }), attachment.filename);
    const url = `${TELEGRAM_API}/bot${encodeURIComponent(token)}/${method}`;
    const res = await this.fetchImpl(url, { method: 'POST', body: form });
    if (!res.ok) await this.#throwSendError(res, chatId, method);
    return this.#receipt(res, chatId, method);
  }

  async #receipt(res: Response, chatId: string, method: string): Promise<ChannelDeliveryReceipt> {
    const json = await res.json().catch(() => ({})) as { ok?: boolean; result?: { message_id?: number | string } };
    const providerMessageId = json.result?.message_id == null ? '' : String(json.result.message_id);
    if (json.ok === false || !providerMessageId) {
      throw new AgentisError('CHANNEL_SEND_FAILED', `telegram ${method} returned no provider message id; delivery is unverified`);
    }
    return { provider: 'telegram', providerMessageId, status: 'accepted', acceptedAt: new Date().toISOString(), recipient: chatId };
  }

  async #throwSendError(res: Response, chatId: string, method: string): Promise<never> {
    const text = await res.text().catch(() => '');
    let description = text.slice(0, 200);
    try {
      const json = JSON.parse(text) as { description?: string };
      if (json.description) description = json.description;
    } catch {
      /* non-JSON body — keep the raw text */
    }
    // "chat not found" is Telegram's response when the bot has never had a
    // conversation with this chat. Bots cannot initiate chats: the user must
    // message the bot first (or the chat must be a group the bot has joined),
    // and the chat ID must be that conversation's numeric ID. Surface that
    // instead of the opaque API string.
    const hint = /chat not found/i.test(description)
      ? `: the bot can't message chat "${chatId}" until that chat messages the bot first (open the bot in Telegram and press Start), and the chat ID must be the numeric ID of that conversation`
      : '';
    throw new AgentisError(
      'CHANNEL_SEND_FAILED',
      `telegram ${method} failed (${res.status}): ${description}${hint}`,
    );
  }

  verify(args: {
    headers: Record<string, string | undefined>;
    rawBody: string;
    secret: string | null;
  }): boolean {
    // Fail closed: with no configured secret_token an inbound webhook cannot be
    // authenticated, so a POST from anywhere on the internet would otherwise
    // dispatch an orchestrator turn. Reject until the operator sets a secret
    // (Telegram echoes it in x-telegram-bot-api-secret-token on every update).
    if (!args.secret) return false;
    const presented = args.headers['x-telegram-bot-api-secret-token'] ?? '';
    const a = Buffer.from(presented);
    const b = Buffer.from(args.secret);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  parseInbound(args: { rawBody: string }): ParsedInboundMessage | null {
    let payload: unknown;
    try {
      payload = JSON.parse(args.rawBody);
    } catch {
      throw new AgentisError('VALIDATION_FAILED', 'telegram webhook body is not JSON');
    }
    const update = payload as TelegramUpdate;
    const updateId = update?.update_id;
    const msg = update?.message ?? update?.edited_message ?? null;
    if (!msg) return null;
    if (typeof updateId !== 'number' || !msg.chat?.id) {
      throw new AgentisError('VALIDATION_FAILED', 'telegram webhook missing update_id or chat.id');
    }
    const fromName = msg.from
      ? [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') ||
        msg.from.username ||
        String(msg.from.id)
      : undefined;
    const media = telegramWebhookMedia(msg);
    const body = telegramWebhookBody(msg, media);
    if (!body) return null;
    const result: ParsedInboundMessage = {
      externalId: `telegram:${updateId}`,
      chatId: String(msg.chat.id),
      body,
    };
    if (fromName) result.from = fromName;
    if (media) result.media = media;
    return result;
  }
}

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}
interface TelegramMessage {
  text?: string;
  caption?: string;
  chat?: { id?: number | string };
  from?: { id: number; username?: string; first_name?: string; last_name?: string };
  photo?: Array<{ file_id?: string }>;
  voice?: { file_id?: string; mime_type?: string };
  audio?: { file_id?: string; mime_type?: string; file_name?: string };
  video?: { file_id?: string; mime_type?: string; file_name?: string };
  animation?: { file_id?: string; mime_type?: string; file_name?: string };
  video_note?: { file_id?: string; mime_type?: string; file_name?: string };
  sticker?: { file_id?: string; is_animated?: boolean; is_video?: boolean };
  document?: { file_id?: string; mime_type?: string; file_name?: string };
  location?: { latitude?: number; longitude?: number };
  venue?: { title?: string; address?: string; location?: { latitude?: number; longitude?: number } };
  contact?: { first_name?: string; last_name?: string; phone_number?: string; vcard?: string };
  poll?: { question?: string; options?: Array<{ text?: string }> };
}

function telegramWebhookMedia(msg: TelegramMessage): ParsedInboundMessage['media'] | null {
  const photo = msg.photo?.at(-1);
  if (photo?.file_id) return { providerFileId: photo.file_id, kind: 'image', mimeType: 'image/jpeg', filename: 'photo.jpg', ...(msg.caption ? { caption: msg.caption } : {}) };
  if (msg.voice?.file_id) return { providerFileId: msg.voice.file_id, kind: 'voice', mimeType: msg.voice.mime_type ?? 'audio/ogg', filename: 'voice-note.ogg' };
  if (msg.audio?.file_id) return { providerFileId: msg.audio.file_id, kind: 'audio', mimeType: msg.audio.mime_type ?? 'audio/mpeg', filename: msg.audio.file_name ?? 'audio.mp3' };
  const video = msg.animation ?? msg.video ?? msg.video_note;
  if (video?.file_id) return {
    providerFileId: video.file_id, kind: 'video', mimeType: video.mime_type ?? 'video/mp4',
    filename: video.file_name ?? (msg.animation ? 'animation.mp4' : 'video.mp4'),
    ...(msg.caption ? { caption: msg.caption } : {}),
  };
  if (msg.sticker?.file_id) return {
    providerFileId: msg.sticker.file_id, kind: 'sticker',
    mimeType: msg.sticker.is_animated ? 'application/x-tgsticker' : msg.sticker.is_video ? 'video/webm' : 'image/webp',
    filename: msg.sticker.is_animated ? 'sticker.tgs' : msg.sticker.is_video ? 'sticker.webm' : 'sticker.webp',
  };
  if (msg.document?.file_id) {
    const mimeType = msg.document.mime_type ?? 'application/octet-stream';
    return {
      providerFileId: msg.document.file_id,
      kind: mimeType.startsWith('image/') ? 'image' : 'file',
      mimeType,
      filename: msg.document.file_name ?? 'document.bin',
      ...(msg.caption ? { caption: msg.caption } : {}),
    };
  }
  return null;
}

function telegramWebhookBody(msg: TelegramMessage, media: ParsedInboundMessage['media'] | null): string | null {
  if (typeof msg.text === 'string' && msg.text.trim()) return msg.text.trim();
  const location = msg.location ?? msg.venue?.location;
  if (location && Number.isFinite(location.latitude) && Number.isFinite(location.longitude)) {
    return [
      msg.venue ? '[Venue received]' : '[Location received]',
      ...(msg.venue?.title ? [`Name: ${msg.venue.title}`] : []),
      ...(msg.venue?.address ? [`Address: ${msg.venue.address}`] : []),
      `Coordinates: ${location.latitude}, ${location.longitude}`,
      `Map: https://maps.google.com/?q=${location.latitude},${location.longitude}`,
    ].join('\n');
  }
  if (msg.contact) return [
    '[Contact card received]',
    `Name: ${[msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(' ')}`,
    `Phone: ${msg.contact.phone_number ?? ''}`,
    ...(msg.contact.vcard ? [`vCard:\n${msg.contact.vcard}`] : []),
  ].join('\n');
  if (msg.poll) return [
    '[Poll received]',
    `Question: ${msg.poll.question ?? ''}`,
    ...(msg.poll.options ?? []).map((option, index) => `${index + 1}. ${option.text ?? ''}`),
  ].join('\n');
  if (media) return [
    `[${media.kind === 'voice' ? 'Voice note' : media.kind === 'file' ? 'Document' : media.kind} received]`,
    ...(media.caption ? [`Caption: ${media.caption}`] : []),
  ].join('\n');
  return typeof msg.caption === 'string' && msg.caption.trim() ? msg.caption.trim() : null;
}
