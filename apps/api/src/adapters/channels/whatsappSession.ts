import type { ResolvedChannelQuote } from './types.js';
﻿/**
 * WhatsAppSession — one live baileys WhatsApp Web connection.
 *
 * This is a focused port of OpenClaw's WhatsApp socket handling
 * (`openclaw/extensions/whatsapp/src/session.ts` + `reconnect.ts`), reduced to
 * what Agentis needs for Phase 1 text conversations and kept dependency-light:
 *
 *   - `useMultiFileAuthState(authDir)` persists creds/keys on disk (per
 *     connection), so a restart re-links without a new QR.
 *   - `makeWASocket(...)` with `markOnlineOnConnect:false`, `syncFullHistory:false`.
 *   - QR is surfaced (raw + PNG data URL) for the linked-devices scan.
 *   - `connection.close` triggers backoff reconnect unless we were logged out.
 *   - inbound `messages.upsert` text → `onInbound` (→ ChannelTurnDispatcher).
 *   - `sendText(jid, text)` → `sock.sendMessage`.
 *
 * baileys is loaded lazily so an install without it (or on an unsupported
 * platform) still boots the rest of Agentis — the connection just reports
 * `error` instead of crashing the process. Same pattern as OpenClawAdapter's
 * `ws` loader.
 */

import type { Logger } from '../../logger.js';
import { ChannelDeliveryRejectedError, type ChannelDeliveryReceipt, type ChannelHealthCheck, type OutboundAttachment, type OutboundNativeContent } from './types.js';
import { loadBaileys, silentBaileysLogger, type BaileysModule } from './whatsappBaileysRuntime.js';
import {
  artifactIdFromRef,
  observedWhatsAppChatJid,
  observedWhatsAppChatJids,
  extractWhatsAppQuotedContext,
  resolveWhatsAppInboundBody,
  whatsappMediaContent,
  whatsappNativeContent,
  type InboundChannelMedia,
  type WhatsAppMediaContext,
} from './whatsappMessageCodec.js';
import {
  classifyWhatsAppReconnect,
  messageTimestampMs,
  normalizeWhatsAppJid,
  readDisconnectStatus,
  shouldProcessWhatsAppUpsert,
  whatsappDeliverySignal,
  whatsappDeliveryStatus,
  whatsappProviderRejectionMessage,
  whatsappReachoutRestrictionScope,
  type WhatsAppDeliverySignal,
  type WhatsAppMessageUpdate,
  type WhatsAppReconnectClass,
} from './whatsappProtocol.js';

export {
  extractWhatsAppText,
  resolveWhatsAppInboundBody,
  extractWhatsAppQuotedContext,
  resolveWhatsAppNativeBody,
  unwrapAudioMessage,
  unwrapDocumentMessage,
  unwrapImageMessage,
  whatsappMediaContent,
  whatsappNativeContent,
} from './whatsappMessageCodec.js';
export type { InboundChannelMedia, WhatsAppMediaContext } from './whatsappMessageCodec.js';
export {
  classifyWhatsAppReconnect,
  shouldProcessWhatsAppUpsert,
  whatsappDeliverySignal,
  whatsappDeliveryStatus,
  whatsappReachoutRestrictionScope,
} from './whatsappProtocol.js';
export type { WhatsAppReachoutRestrictionScope, WhatsAppReconnectClass } from './whatsappProtocol.js';

export type WhatsAppSessionStatus =
  | 'idle'
  | 'connecting'
  | 'qr'
  | 'open'
  | 'closed'
  | 'logged_out'
  | 'error';

export interface WhatsAppInbound {
  externalId: string;
  chatId: string; // the JID to reply to (key.remoteJid)
  body: string;
  from?: string;
  /** Provider aliases for the same peer (for example PN + LID). */
  alternateChatIds?: string[];
  /** Durable artifacts created from provider media. Kept typed through the turn. */
  attachmentIds?: string[];
  mediaContext?: WhatsAppMediaContext;
  quotedContext?: {providerMessageId: string; body: string};
}

export interface WhatsAppPeerObservation {
  primaryChatId: string;
  aliases: string[];
  displayName?: string;
  source: 'message' | 'contact' | 'lid_mapping';
  verified: boolean;
}

export interface WhatsAppObservedOutbound {
  externalId: string;
  chatId: string;
  /** Provider aliases for the same peer (for example PN + LID). */
  alternateChatIds?: string[];
  body: string;
  attachmentIds?: string[];
}

export interface WhatsAppHistoryEntry {
  externalId: string;
  chatId: string;
  body: string;
  participantSide: 'customer' | 'business';
  occurredAt: string;
  attachmentIds?: string[];
}

export interface WhatsAppRecoveryState {
  reason: WhatsAppReconnectClass;
  attempt: number;
  nextRetryAt?: string;
}

export interface WhatsAppSessionOptions {
  autoReadInbound?: boolean;
  connectionId: string;
  authDir: string;
  logger: Logger;
  onInbound: (msg: WhatsAppInbound) => void;
  /** Mirror messages sent from the primary phone or another companion. */
  onOutboundObserved?: (msg: WhatsAppObservedOutbound) => void;
  /** Provider directory updates used to canonicalize PN/LID/contact identities. */
  onPeerObserved?: (peer: WhatsAppPeerObservation) => void;
  /** Silent, bounded bootstrap history. It never enters the live inbound callback. */
  onHistoryReconciled?: (messages: WhatsAppHistoryEntry[]) => void | Promise<void>;
  /** Notified whenever status/QR changes (for the login UI + DB status). */
  onStateChange?: (state: { status: WhatsAppSessionStatus; qr?: string; selfId?: string; recovery?: WhatsAppRecoveryState }) => void;
  /**
   * Provider acknowledgement received after (or during) sendText. This is
   * intentionally separate from the socket write: Baileys' returned key id is
   * a client correlation id until WhatsApp emits a server acknowledgement.
   */
  onDeliveryUpdate?: (update: {
    providerMessageId: string;
    status: ChannelDeliveryReceipt['status'];
    providerStatus: number;
    recipient?: string;
  }) => void;
  /** Optional speech-to-text for voice notes. Returns null to skip. */
  transcribeAudio?: (bytes: Buffer, mimeType: string) => Promise<string | null>;
  /** Optional image understanding. Returns a text description, or null to skip. */
  describeImage?: (bytes: Buffer, mimeType: string, caption?: string) => Promise<string | null>;
  /** Optional document text extraction (PDF / text). Returns text, or null to skip. */
  extractDocument?: (bytes: Buffer, mimeType: string, fileName?: string) => Promise<string | null>;
  /** Persist the original inbound binary so it remains inspectable and reusable. */
  persistMedia?: (media: InboundChannelMedia) => Promise<string | null>;
  /**
   * Optional auth-state loader. When set (vault-backed), creds/keys persist
   * encrypted in the DB instead of plaintext files under `authDir`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loadAuthState?: () => Promise<{ state: any; saveCreds: () => Promise<void> }>;
  /** Test seam; production always lazy-loads the OSS Baileys dependency. */
  baileysModule?: unknown;
}

const RECONNECT_INITIAL_MS = 5_000;  // gentler first backoff — don't hammer the companion
const RECONNECT_MAX_MS = 60_000;
const RECONNECT_FACTOR = 1.8;
const RECONNECT_MAX_ATTEMPTS = 8;
/** A reconnect only resets the backoff after the connection STAYS open this long. */
const STABLE_OPEN_MS = 60_000;
/** Never pause reconnection longer than this while waiting out a reach-out timelock. */
const REACHOUT_PAUSE_CAP_MS = 6 * 60 * 60 * 1000;
/** When WhatsApp reports a 463 lock but no end time, pause this long, then re-check (and re-pause if still locked). */
const REACHOUT_UNKNOWN_PAUSE_MS = 30 * 60 * 1000;

// Cache the WhatsApp Web version so a reconnect burst doesn't re-fetch it on every
// attempt (a network call per connect). Refreshed at most once per TTL.
let cachedWaVersion: { version: [number, number, number]; fetchedAt: number } | undefined;
const WA_VERSION_TTL_MS = 6 * 60 * 60 * 1000;
const DELIVERY_ACK_TIMEOUT_MS = Math.max(1_000, Number(process.env.AGENTIS_WHATSAPP_ACK_TIMEOUT_MS) || 8_000);
const HISTORY_PER_CHAT_LIMIT = 160;
const HISTORY_SESSION_LIMIT = 2_000;
const HISTORY_MEDIA_LIMIT = 20;
const HISTORY_INACTIVITY_FLUSH_MS = 1_500;
const LOCAL_SUBMISSION_CORRELATION_TIMEOUT_MS = 30_000;
/** WhatsApp expires a composing presence after roughly ten seconds. */
const TYPING_PRESENCE_REFRESH_MS = 7_000;

export class WhatsAppSession {
  #status: WhatsAppSessionStatus = 'idle';
  #qr: string | undefined;
  #qrDataUrl: string | undefined;
  #selfId: string | undefined;
  /** Every provider address known to belong to the linked account (PN + LID). */
  readonly #selfJids = new Set<string>();
  #sock: Awaited<ReturnType<BaileysModule['makeWASocket']>> | undefined;
  #closed = false;
  #reconnectAttempts = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /** Epoch ms until which reconnection is paused because WhatsApp reported a reach-out timelock (463). */
  #reachoutBlockedUntil: number | undefined;
  /** Fires after a SUSTAINED open; only then is the backoff reset (so a flap can't reset it every time). */
  #stableOpenTimer: ReturnType<typeof setTimeout> | undefined;
  #recovery: WhatsAppRecoveryState | undefined;
  #startPromise: Promise<void> | undefined;
  // Set during connect — downloads media for the current socket/baileys module.
  #downloadMedia: ((msg: unknown) => Promise<Buffer>) | undefined;
  /** Latest provider acknowledgement per outbound client message id. */
  readonly #deliverySignals = new Map<string, WhatsAppDeliverySignal>();
  readonly #deliveryWaiters = new Map<string, Set<(signal: WhatsAppDeliverySignal) => void>>();
  readonly #deliveryRecipients = new Map<string, string>();
  readonly #locallySubmittedMessageIds = new Set<string>();
  readonly #localSubmissionsByChat = new Map<string, number>();
  readonly #localSubmissionWaiters = new Map<string, Set<(settled: boolean) => void>>();
  readonly #history = new Map<string, Map<string, { message: unknown; occurredAt: number }>>();
  readonly #historyMediaPersistedByChat = new Map<string, number>();
  #historyFlushTimer: ReturnType<typeof setTimeout> | undefined;
  #historyFlushPromise: Promise<void> | undefined;
  /** Keep long-running turns visibly composing until the dispatcher clears them. */
  readonly #typingRefreshTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(private readonly opts: WhatsAppSessionOptions) {}

  get status(): WhatsAppSessionStatus { return this.#status; }
  get qr(): string | undefined { return this.#qr; }
  get qrDataUrl(): string | undefined { return this.#qrDataUrl; }
  get selfId(): string | undefined { return this.#selfId; }
  get recovery(): WhatsAppRecoveryState | undefined { return this.#recovery; }

  /**
   * Boot the socket. Idempotent while a start is in flight or the session is
   * live (connecting/qr/open). From a terminal state (error/closed/logged_out)
   * it relaunches with a fresh QR, so "generate a new QR" actually works without
   * a server restart.
   */
  async start(): Promise<void> {
    const live = this.#status === 'connecting' || this.#status === 'qr' || this.#status === 'open';
    if (this.#startPromise && live) return this.#startPromise;
    this.#closed = false;
    this.#reconnectAttempts = 0;
    this.#recovery = undefined;
    // An explicit (re)start is the operator choosing to try now — clear any pause.
    this.#reachoutBlockedUntil = undefined;
    this.#clearStableOpenTimer();
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    // Expose progress before loading Baileys or fetching its current Web version.
    // Those operations can take several seconds on a cold install/network, but the
    // UI can safely begin polling while the socket setup continues in the background.
    this.#setStatus('connecting');
    this.#startPromise = this.#connect().catch((err) => {
      this.opts.logger.warn('whatsapp.start_failed', { connectionId: this.opts.connectionId, err: (err as Error).message });
      this.#setStatus('error');
    });
    return this.#startPromise;
  }

  async stop(): Promise<void> {
    for (const timer of this.#typingRefreshTimers.values()) clearInterval(timer);
    this.#typingRefreshTimers.clear();
    this.#closed = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#clearStableOpenTimer();
    try { this.#sock?.end?.(undefined); } catch { /* best-effort */ }
    this.#sock = undefined;
    this.#startPromise = undefined;
    this.#deliverySignals.clear();
    this.#deliveryWaiters.clear();
    this.#history.clear();
    this.#historyMediaPersistedByChat.clear();
    if (this.#historyFlushTimer) clearTimeout(this.#historyFlushTimer);
    this.#historyFlushTimer = undefined;
    this.#localSubmissionsByChat.clear();
    for (const waiters of this.#localSubmissionWaiters.values()) {
      for (const settle of waiters) settle(false);
    }
    this.#localSubmissionWaiters.clear();
    this.#deliveryRecipients.clear();
    this.#locallySubmittedMessageIds.clear();
    this.#selfJids.clear();
    this.#recovery = undefined;
    this.#setStatus('closed');
  }

  /** Send a text message to a JID. Throws if the socket isn't open. */
  async sendText(jid: string, text: string): Promise<ChannelDeliveryReceipt> {
    return this.#submit(jid, { text });
  }

  /**
   * Send a single media attachment (image/video/audio/voice/sticker/document) to
   * a JID, with an optional caption. Shares the same recipient-resolution and
   * provider-acknowledgement path as `sendText` so delivery is equally verified.
   */
  async sendMedia(jid: string, attachment: OutboundAttachment, caption?: string): Promise<ChannelDeliveryReceipt> {
    return this.#submit(jid, whatsappMediaContent(attachment, caption));
  }

  /** Send location/contact/poll using WhatsApp's provider-native message shape. */
  async sendNative(jid: string, native: OutboundNativeContent): Promise<ChannelDeliveryReceipt> {
    return this.#submit(jid, whatsappNativeContent(native));
  }

  setAutoReadInbound(enabled: boolean): void { this.opts.autoReadInbound = enabled; }

  async markRead(jid: string, messageId: string): Promise<void> {
    if (!this.#sock || this.#status !== 'open') throw new Error('WhatsApp session is not open');
    await this.#sock.readMessages([{remoteJid: jid, id: messageId, fromMe: false}]);
  }

  async sendQuoted(jid: string, body: string, quote: ResolvedChannelQuote, attachment?: OutboundAttachment, native?: OutboundNativeContent): Promise<ChannelDeliveryReceipt> {
    const content = attachment ? whatsappMediaContent(attachment, body) : native ? whatsappNativeContent(native) : {text: body};
    return this.#submit(jid, content, quote);
  }

  /** Add/clear a reaction on a prior message (best-effort; requires the message key). */
  async sendReaction(jid: string, targetMessageId: string, emoji: string): Promise<void> {
    if (!this.#sock || this.#status !== 'open') return;
    try {
      await this.#sock.sendMessage(jid, { react: { text: emoji, key: { remoteJid: jid, id: targetMessageId, fromMe: false } } });
    } catch { /* reactions are best-effort */ }
  }

  /**
   * Resolve the recipient, submit a baileys message content object, and verify
   * provider acknowledgement. This is the single write path for every outbound
   * shape (text and media), so delivery proof, rejection handling, and the
   * recipient-mismatch guard are identical regardless of content.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async #submit(jid: string, content: any, quote?: ResolvedChannelQuote): Promise<ChannelDeliveryReceipt> {
    if (!this.#sock || this.#status !== 'open') {
      throw new Error(`whatsapp session ${this.opts.connectionId} is not open (status=${this.#status})`);
    }
    // Reply to the exact JID the message came from (baileys threads it back to the
    // same chat — including `@lid` chats). Do NOT remap LID→PN: that resolves to a
    // different identity and lands the reply in a phantom chat.
    // Resolve explicit phone-number JIDs first. A socket write can otherwise
    // resolve for an invalid/unregistered address while no real chat exists.
    // Provider-native LIDs/groups are intentionally left untouched.
    let recipient = jid;
    if (jid.endsWith('@s.whatsapp.net') && typeof this.#sock.onWhatsApp === 'function') {
      const matches = await this.#sock.onWhatsApp(jid);
      const match = Array.isArray(matches)
        ? matches.find((entry: { exists?: boolean }) => entry?.exists === true)
        : undefined;
      if (!match) throw new Error(`whatsapp recipient ${jid} is not registered or could not be resolved`);
      if (typeof match.jid === 'string' && match.jid) recipient = match.jid;
    }
    if (this.#isSelfJid(recipient)) {
      throw new Error('whatsapp refused to send to the linked account itself because self-targeted messages can be re-ingested as new inbound turns');
    }
    const localKey = normalizeWhatsAppJid(recipient);
    this.#localSubmissionsByChat.set(localKey, (this.#localSubmissionsByChat.get(localKey) ?? 0) + 1);
    let sent;
    try {
      sent = await this.#sock.sendMessage(recipient, content, quote ? {quoted: {key: {remoteJid: recipient, id: quote.providerMessageId, fromMe: quote.fromMe}, message: {conversation: quote.body}}} : undefined);
      const submittedId = typeof sent?.key?.id === 'string' ? sent.key.id.trim() : '';
      if (submittedId) this.#rememberLocalSubmission(submittedId);
    } finally {
      const remaining = Math.max(0, (this.#localSubmissionsByChat.get(localKey) ?? 1) - 1);
      if (remaining === 0) {
        this.#localSubmissionsByChat.delete(localKey);
        const waiters = this.#localSubmissionWaiters.get(localKey);
        this.#localSubmissionWaiters.delete(localKey);
        for (const settle of waiters ?? []) settle(true);
      } else this.#localSubmissionsByChat.set(localKey, remaining);
    }
    const providerMessageId = typeof sent?.key?.id === 'string' ? sent.key.id.trim() : '';
    if (!providerMessageId) {
      throw new Error('whatsapp provider accepted no message id; outbound delivery is unverified');
    }
    this.#rememberLocalSubmission(providerMessageId);
    const providerRecipient = typeof sent?.key?.remoteJid === 'string' && sent.key.remoteJid
      ? sent.key.remoteJid
      : recipient;
    if (normalizeWhatsAppJid(providerRecipient) !== normalizeWhatsAppJid(recipient)) {
      throw new Error(`whatsapp provider recipient mismatch: resolved ${recipient}, submitted ${providerRecipient}`);
    }
    this.#deliveryRecipients.set(providerMessageId, providerRecipient);
    const immediateStatus = typeof sent?.status === 'number' ? sent.status : 0;
    const signal = immediateStatus >= 2
      ? { status: immediateStatus }
      : await this.#waitForDeliveryAck(providerMessageId, DELIVERY_ACK_TIMEOUT_MS);
    if (signal.errorCode) {
      let rejectionMessage = signal.error ?? whatsappProviderRejectionMessage(signal.errorCode);
      let remediation = signal.errorCode === '463'
        ? 'Inspect the linked-device reach-out restriction and do not retry the same companion transport until its enforcement window ends.'
        : 'Relink the WhatsApp connection or refresh the recipient identity before one controlled retry.';
      if (signal.errorCode === '463' && typeof this.#sock.fetchAccountReachoutTimelock === 'function') {
        try {
          const timelock = await this.#sock.fetchAccountReachoutTimelock();
          const scope = whatsappReachoutRestrictionScope(timelock?.enforcementType);
          const ends = timelock?.timeEnforcementEnds instanceof Date
            ? timelock.timeEnforcementEnds.toISOString()
            : undefined;
          // Pause reconnection until the lock lifts so a WhatsApp-initiated close
          // during enforcement doesn't trigger a reconnect storm on the companion.
          this.#reachoutBlockedUntil = timelock?.timeEnforcementEnds instanceof Date
            ? timelock.timeEnforcementEnds.getTime()
            : Date.now() + REACHOUT_UNKNOWN_PAUSE_MS;
          if (scope === 'companion') {
            rejectionMessage = `WhatsApp rejected the Agentis linked-device send because companion outbound is restricted${timelock?.enforcementType ? ` (${timelock.enforcementType})` : ''}${ends ? ` until ${ends}` : ''}. The primary phone app may still send normally.`;
            remediation = 'Pause outbound sends from this linked Agentis session until the companion restriction expires. A successful phone-app send does not prove the linked companion is unblocked.';
          }
        } catch {
          // Preserve the provider rejection even when the diagnostic query is unavailable.
        }
      }
      throw new ChannelDeliveryRejectedError(
        'whatsapp',
        providerMessageId,
        signal.errorCode,
        rejectionMessage,
        remediation,
      );
    }
    const providerStatus = signal.status;
    const status = whatsappDeliveryStatus(providerStatus);
    return {
      provider: 'whatsapp',
      providerMessageId,
      status,
      acceptedAt: new Date().toISOString(),
      recipient: providerRecipient,
      requestedRecipient: jid,
      resolvedRecipient: recipient,
      providerRecipient,
      providerAcknowledged: status !== 'queued',
      providerStatus,
    };
  }

  async #waitForDeliveryAck(messageId: string, timeoutMs: number): Promise<WhatsAppDeliverySignal> {
    const known = this.#deliverySignals.get(messageId);
    if (known && (known.status >= 2 || known.errorCode)) return known;
    return await new Promise<WhatsAppDeliverySignal>((resolve) => {
      let settled = false;
      const finish = (signal: WhatsAppDeliverySignal) => {
        if (settled || (signal.status < 2 && !signal.errorCode)) return;
        settled = true;
        clearTimeout(timer);
        const waiters = this.#deliveryWaiters.get(messageId);
        waiters?.delete(finish);
        if (waiters?.size === 0) this.#deliveryWaiters.delete(messageId);
        resolve(signal);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.#deliveryWaiters.get(messageId)?.delete(finish);
        if (this.#deliveryWaiters.get(messageId)?.size === 0) this.#deliveryWaiters.delete(messageId);
        resolve(this.#deliverySignals.get(messageId) ?? { status: 0 });
      }, timeoutMs);
      timer.unref?.();
      const waiters = this.#deliveryWaiters.get(messageId) ?? new Set<(signal: WhatsAppDeliverySignal) => void>();
      waiters.add(finish);
      this.#deliveryWaiters.set(messageId, waiters);
      const raced = this.#deliverySignals.get(messageId);
      if (raced && (raced.status >= 2 || raced.errorCode)) finish(raced);
    });
  }

  #recordDeliveryAck(messageId: string, status: number): void {
    if (!messageId || !Number.isFinite(status)) return;
    const previous = this.#deliverySignals.get(messageId);
    if (previous?.errorCode || status <= (previous?.status ?? 0)) return;
    const signal = { status };
    this.#deliverySignals.set(messageId, signal);
    for (const resolve of this.#deliveryWaiters.get(messageId) ?? []) resolve(signal);
    if (status >= 2) {
      try {
        this.opts.onDeliveryUpdate?.({
          providerMessageId: messageId,
          status: whatsappDeliveryStatus(status),
          providerStatus: status,
          ...(this.#deliveryRecipients.get(messageId) ? { recipient: this.#deliveryRecipients.get(messageId) } : {}),
        });
      } catch (err) {
        this.opts.logger.warn('whatsapp.delivery_update_handler_failed', {
          connectionId: this.opts.connectionId,
          providerMessageId: messageId,
          err: (err as Error).message,
        });
      }
    }
    // Bound cache growth for long-lived sessions.
    if (this.#deliverySignals.size > 2_000) {
      const oldest = this.#deliverySignals.keys().next().value as string | undefined;
      if (oldest) {
        this.#deliverySignals.delete(oldest);
        this.#deliveryRecipients.delete(oldest);
      }
    }
  }

  #recordDeliveryRejection(messageId: string, signal: WhatsAppDeliverySignal): void {
    if (!messageId || !signal.errorCode) return;
    this.#deliverySignals.set(messageId, signal);
    for (const resolve of this.#deliveryWaiters.get(messageId) ?? []) resolve(signal);
    this.opts.logger.warn('whatsapp.delivery_rejected', {
      connectionId: this.opts.connectionId,
      providerMessageId: messageId,
      providerErrorCode: signal.errorCode,
    });
  }

  /** Read-only provider account checks. This never sends a user-visible message. */
  async outboundHealthCheck(): Promise<ChannelHealthCheck> {
    const checkedAt = new Date().toISOString();
    if (!this.#sock || this.#status !== 'open') {
      return {
        name: 'outbound', ok: false, code: 'whatsapp_transport_not_open',
        message: `WhatsApp transport is ${this.#status}.`,
        remediation: 'Relink or restart the WhatsApp connection.', checkedAt,
      };
    }
    try {
      const [timelockResult, capResult] = await Promise.allSettled([
        this.#sock.fetchAccountReachoutTimelock?.(),
        this.#sock.fetchNewChatMessageCap?.(),
      ]);
      const timelock = timelockResult.status === 'fulfilled' ? timelockResult.value : undefined;
      const cap = capResult.status === 'fulfilled' ? capResult.value : undefined;
      if (timelock?.isActive) {
        const enforcementType = typeof timelock.enforcementType === 'string' ? timelock.enforcementType : undefined;
        const scope = whatsappReachoutRestrictionScope(enforcementType);
        const ends = timelock.timeEnforcementEnds instanceof Date
          ? timelock.timeEnforcementEnds.toISOString()
          : undefined;
        const companion = scope === 'companion';
        return {
          name: 'outbound', ok: false,
          code: companion ? 'whatsapp_companion_outbound_timelocked' : 'whatsapp_reachout_timelocked',
          message: companion
            ? `WhatsApp has restricted outbound sends from linked companion devices${enforcementType ? ` (${enforcementType})` : ''}${ends ? ` until ${ends}` : ''}. The primary phone app can remain usable and may show no warning.`
            : `WhatsApp reports an active reach-out restriction${enforcementType ? ` (${enforcementType})` : ''}${ends ? ` until ${ends}` : ''}.`,
          remediation: companion
            ? 'Pause Agentis QR-session outbound until the companion restriction expires. Do not use successful primary-phone sends as evidence that this linked transport is ready.'
            : 'Pause affected outbound automation until WhatsApp lifts the restriction; do not repeatedly retry rejected recipients.',
          evidence: {
            providerErrorCode: '463',
            enforcementType: enforcementType ?? null,
            restrictionScope: scope,
            appliesToTransport: 'whatsapp_linked_companion',
            primaryPhoneMayRemainUsable: companion,
            enforcementEndsAt: ends ?? null,
            newChatCap: cap ?? null,
          },
          checkedAt,
        };
      }
      const total = typeof cap?.total_quota === 'number' ? cap.total_quota : undefined;
      const used = typeof cap?.used_quota === 'number' ? cap.used_quota : undefined;
      if (cap?.capping_status === 'CAPPED' || (total !== undefined && used !== undefined && total > 0 && used >= total)) {
        return {
          name: 'outbound', ok: false, code: 'whatsapp_new_chat_cap_reached',
          message: `WhatsApp's new-chat limit is exhausted${total !== undefined && used !== undefined ? ` (${used}/${total})` : ''}. Existing chats may still work.`,
          remediation: 'Wait for the provider quota cycle to reset or use an approved WhatsApp Business API transport.', checkedAt,
        };
      }
      const quota = total !== undefined && used !== undefined ? ` New-chat usage: ${used}/${total}.` : '';
      return {
        name: 'outbound', ok: true,
        code: cap?.capping_status && cap.capping_status !== 'NONE'
          ? 'whatsapp_new_chat_limit_warning'
          : 'whatsapp_outbound_account_ready',
        message: `WhatsApp reports no active reach-out timelock.${quota}`,
        checkedAt,
      };
    } catch (err) {
      return {
        name: 'outbound', ok: false, code: 'whatsapp_account_probe_failed',
        message: `Could not inspect WhatsApp outbound account state: ${(err as Error).message}`,
        remediation: 'Confirm the linked session is healthy, then run Channel Test again.', checkedAt,
      };
    }
  }

  /** Show/clear the "typing…" presence in a chat (best-effort). */
  async setTyping(jid: string, on: boolean): Promise<void> {
    if (!this.#sock || this.#status !== 'open') return;
    const key = normalizeWhatsAppJid(jid);
    const existing = this.#typingRefreshTimers.get(key);
    if (existing) {
      clearInterval(existing);
      this.#typingRefreshTimers.delete(key);
    }
    try {
      await this.#sock.sendPresenceUpdate(on ? 'composing' : 'paused', jid);
      if (on) {
        const timer = setInterval(() => {
          if (!this.#sock || this.#status !== 'open') return;
          void this.#sock.sendPresenceUpdate('composing', jid).catch(() => {});
        }, TYPING_PRESENCE_REFRESH_MS);
        timer.unref?.();
        this.#typingRefreshTimers.set(key, timer);
      }
    } catch {
      /* presence is best-effort */
    }
  }


  async #connect(): Promise<void> {
    const loaded = this.opts.baileysModule
      ? { ok: true as const, mod: this.opts.baileysModule as BaileysModule }
      : await loadBaileys();
    if (!loaded.ok) {
      this.opts.logger.warn('whatsapp.baileys_unavailable', { reason: loaded.reason });
      this.#setStatus('error');
      return;
    }
    const baileys = loaded.mod;
    const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, DisconnectReason, Browsers, downloadMediaMessage } = baileys;
    const browser: [string, string, string] =
      typeof Browsers?.appropriate === 'function' ? Browsers.appropriate('Agentis') : ['Agentis', 'Chrome', '1.0.0'];

    // Tear down any prior socket before opening a new one — never leave two
    // companion connections briefly alive on the same creds (WhatsApp reads a
    // duplicate companion as a conflict). `#connect` is the single reconnect path.
    try { this.#sock?.end?.(undefined); } catch { /* best-effort */ }

    this.#setStatus('connecting');
    // Vault-backed auth state when provided; otherwise baileys' on-disk files.
    const { state, saveCreds } = this.opts.loadAuthState
      ? await this.opts.loadAuthState()
      : await useMultiFileAuthState(this.opts.authDir);
    const logger = silentBaileysLogger();
    // Reuse a cached WA Web version so a reconnect burst doesn't re-fetch it every attempt.
    let version: [number, number, number] | undefined =
      cachedWaVersion && Date.now() - cachedWaVersion.fetchedAt < WA_VERSION_TTL_MS ? cachedWaVersion.version : undefined;
    if (!version) {
      try {
        ({ version } = await fetchLatestBaileysVersion());
        if (version) cachedWaVersion = { version, fetchedAt: Date.now() };
      } catch {
        // fall back to a previously cached version, else baileys' bundled version
        version = cachedWaVersion?.version;
      }
    }

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        keys: makeCacheableSignalKeyStore(state.keys, logger as any),
      },
      ...(version ? { version } : {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: logger as any,
      browser,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    this.#sock = sock;
    const silentLog = logger;
    this.#downloadMedia = (msg: unknown) =>
      downloadMediaMessage(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        msg as any,
        'buffer',
        {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { logger: silentLog as any, reuploadRequest: sock.updateMediaMessage },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) as Promise<Buffer>;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        void this.#onQr(qr);
      }
      if (connection === 'open') {
        this.#qr = undefined;
        this.#qrDataUrl = undefined;
        this.#selfId = sock.user?.id;
        this.#selfJids.clear();
        for (const jid of [sock.user?.id, sock.user?.lid, sock.user?.phoneNumber]) {
          if (typeof jid === 'string' && jid.trim()) this.#selfJids.add(normalizeWhatsAppJid(jid));
        }
        this.#reachoutBlockedUntil = undefined; // a real open clears any reach-out pause
        this.#recovery = undefined;
        this.#setStatus('open');
        // Only reset the backoff after the connection STAYS open — a flap
        // (open→close during enforcement) must grow the backoff, not zero it each time.
        this.#armStableOpenReset();
      } else if (connection === 'close') {
        this.#clearStableOpenTimer();
        const statusCode = readDisconnectStatus(lastDisconnect?.error);
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        if (loggedOut) {
          this.opts.logger.warn('whatsapp.logged_out', { connectionId: this.opts.connectionId });
          this.#setStatus('logged_out');
          return;
        }
        this.#setStatus('closed');
        this.#scheduleReconnect(classifyWhatsAppReconnect(statusCode));
      }
    });

    sock.ev.on('messages.upsert', (event) => {
      for (const msg of event.messages) {
        const occurredAt = messageTimestampMs(msg);
        const processLive = shouldProcessWhatsAppUpsert(
          event.type,
          msg?.key?.fromMe === true,
          occurredAt,
        );
        if (!processLive) {
          this.#stageHistory(msg);
          continue;
        }
        void this.#handleMessage(msg).catch((err) => {
          this.opts.logger.warn('whatsapp.inbound_handler_threw', { err: (err as Error).message });
        });
      }
    });

    const historyEvents = sock.ev as unknown as { on(name: string, listener: (event: any) => void): void };
    historyEvents.on('messaging-history.set', (event) => {
      for (const message of Array.isArray(event?.messages) ? event.messages : []) this.#stageHistory(message);
      if (event?.isLatest === true) void this.#flushHistory();
    });
    historyEvents.on('messaging-history.status', (event) => {
      const status = String(event?.status ?? event ?? '').toLowerCase();
      if (status.includes('complete') || status.includes('pause')) void this.#flushHistory();
    });
    historyEvents.on('contacts.upsert', (contacts) => {
      for (const contact of Array.isArray(contacts) ? contacts : []) this.#observeContact(contact);
    });
    historyEvents.on('contacts.update', (contacts) => {
      for (const contact of Array.isArray(contacts) ? contacts : []) this.#observeContact(contact);
    });
    historyEvents.on('lid-mapping.update', (mapping) => {
      const rows = Array.isArray(mapping) ? mapping : [mapping];
      for (const row of rows) {
        const lid = firstProviderId(row, ['lid', 'lidJid', 'id']);
        const pn = firstProviderId(row, ['pn', 'pnJid', 'phoneNumber']);
        if (!lid || !pn) continue;
        const aliases = observedWhatsAppChatJids({ remoteJid: lid, remoteJidAlt: pn });
        if (aliases.length < 2) continue;
        this.opts.onPeerObserved?.({ primaryChatId: aliases[0]!, aliases, source: 'lid_mapping', verified: true });
      }
    });

    // `sendMessage()` returning an id proves only local submission. These
    // provider events are the actual server/delivery/read acknowledgement.
    sock.ev.on('messages.update', (updates) => {
      for (const item of updates) {
        const id = typeof item.key?.id === 'string' ? item.key.id : '';
        const signal = whatsappDeliverySignal(item.update as WhatsAppMessageUpdate);
        if (!id || !signal) continue;
        if (signal.errorCode) this.#recordDeliveryRejection(id, signal);
        else if (signal.status > 0) this.#recordDeliveryAck(id, signal.status);
      }
    });
    sock.ev.on('message-receipt.update', (updates) => {
      for (const item of updates) {
        const id = typeof item.key?.id === 'string' ? item.key.id : '';
        const receipt = item.receipt as { receiptTimestamp?: unknown; readTimestamp?: unknown; playedTimestamp?: unknown };
        const status = receipt.playedTimestamp || receipt.readTimestamp ? 4 : receipt.receiptTimestamp ? 3 : 0;
        if (id && status > 0) this.#recordDeliveryAck(id, status);
      }
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #stageHistory(msg: any): void {
    if (!this.opts.onHistoryReconciled) return;
    const key = msg?.key;
    const chatId = observedWhatsAppChatJid(key) ?? key?.remoteJid;
    if (!chatId || chatId === 'status@broadcast') return;
    const externalId = typeof key?.id === 'string' ? key.id.trim() : '';
    if (!externalId) return;
    const occurredAt = messageTimestampMs(msg);
    const chat = this.#history.get(chatId) ?? new Map<string, { message: unknown; occurredAt: number }>();
    chat.set(externalId, { message: msg, occurredAt });
    if (chat.size > HISTORY_PER_CHAT_LIMIT) {
      const oldest = [...chat.entries()].sort((a, b) => a[1].occurredAt - b[1].occurredAt)[0];
      if (oldest) chat.delete(oldest[0]);
    }
    this.#history.set(chatId, chat);
    while ([...this.#history.values()].reduce((sum, entries) => sum + entries.size, 0) > HISTORY_SESSION_LIMIT) {
      let oldest: { chatId: string; id: string; occurredAt: number } | undefined;
      for (const [candidateChatId, entries] of this.#history) {
        for (const [id, entry] of entries) {
          if (!oldest || entry.occurredAt < oldest.occurredAt) oldest = { chatId: candidateChatId, id, occurredAt: entry.occurredAt };
        }
      }
      if (!oldest) break;
      this.#history.get(oldest.chatId)?.delete(oldest.id);
    }
    if (this.#historyFlushTimer) clearTimeout(this.#historyFlushTimer);
    this.#historyFlushTimer = setTimeout(() => { void this.#flushHistory(); }, HISTORY_INACTIVITY_FLUSH_MS);
    this.#historyFlushTimer.unref?.();
  }

  async #flushHistory(): Promise<void> {
    if (this.#historyFlushPromise) return this.#historyFlushPromise;
    if (!this.opts.onHistoryReconciled || this.#history.size === 0) return;
    if (this.#historyFlushTimer) clearTimeout(this.#historyFlushTimer);
    this.#historyFlushTimer = undefined;
    const staged: Array<[string, Array<[string, { message: unknown; occurredAt: number }]>]> =
      [...this.#history.entries()].map(([chatId, entries]) => [chatId, [...entries.entries()]]);
    this.#history.clear();
    this.#historyFlushPromise = (async () => {
      const reconciled: WhatsAppHistoryEntry[] = [];
      for (const [chatId, entries] of staged) {
        const orderedEntries = [...entries].sort((a, b) => a[1].occurredAt - b[1].occurredAt);
        const richFrom = Math.max(0, orderedEntries.length - HISTORY_MEDIA_LIMIT);
        for (let index = 0; index < orderedEntries.length; index += 1) {
          const [externalId, entry] = orderedEntries[index]!;
          const attachmentIds: string[] = [];
          const persistedMedia = this.#historyMediaPersistedByChat.get(chatId) ?? 0;
          const rich = index >= richFrom && persistedMedia < HISTORY_MEDIA_LIMIT;
          const body = await resolveWhatsAppInboundBody(entry.message, rich ? {
            downloadMedia: this.#downloadMedia,
            persistMedia: this.opts.persistMedia
              ? async (media) => {
                  const ref = await this.opts.persistMedia!(media);
                  const artifactId = artifactIdFromRef(ref);
                  if (artifactId) attachmentIds.push(artifactId);
                  return ref;
                }
              : undefined,
            onFailure: (kind, err) => this.opts.logger.warn(`whatsapp.history_${kind}_failed`, { err: err.message }),
          } : {});
          const fromMe = Boolean((entry.message as { key?: { fromMe?: boolean } })?.key?.fromMe);
          reconciled.push({
            externalId,
            chatId,
            body: body ?? (fromMe ? '[Outbound WhatsApp message]' : '[WhatsApp message]'),
            participantSide: fromMe ? 'business' : 'customer',
            occurredAt: new Date(entry.occurredAt).toISOString(),
            ...(attachmentIds.length ? { attachmentIds: [...new Set(attachmentIds)] } : {}),
          });
          if (attachmentIds.length) this.#historyMediaPersistedByChat.set(chatId, persistedMedia + 1);
        }
      }
      reconciled.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
      if (reconciled.length) {
        try {
          await this.opts.onHistoryReconciled!(reconciled);
        } catch (err) {
          this.opts.logger.warn('whatsapp.history_reconciliation_failed', { err: (err as Error).message });
        }
      }
    })().finally(() => {
      this.#historyFlushPromise = undefined;
      if (this.#history.size > 0 && !this.#historyFlushTimer) {
        this.#historyFlushTimer = setTimeout(() => { void this.#flushHistory(); }, HISTORY_INACTIVITY_FLUSH_MS);
        this.#historyFlushTimer.unref?.();
      }
    });
    return this.#historyFlushPromise;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async #handleMessage(msg: any): Promise<void> {
    const key = msg?.key;
    if (!key) return;
    const observedChatIds = observedWhatsAppChatJids(key);
    if (observedChatIds.some((jid) => this.#isSelfJid(jid))) {
      this.opts.logger.warn('whatsapp.self_message_ignored', {
        connectionId: this.opts.connectionId,
        externalId: typeof key.id === 'string' ? key.id : undefined,
        fromMe: key.fromMe === true,
      });
      return;
    }
    if (key.fromMe) {
      const externalId = typeof key.id === 'string' ? key.id.trim() : '';
      if (!externalId || this.#locallySubmittedMessageIds.has(externalId)) return;
      const chatId = observedWhatsAppChatJid(key);
      if (!chatId || chatId === 'status@broadcast') return;
      const attachmentIds: string[] = [];
      const body = await resolveWhatsAppInboundBody(msg, {
        downloadMedia: this.#downloadMedia,
        persistMedia: this.opts.persistMedia
          ? async (media) => {
              const ref = await this.opts.persistMedia!(media);
              const artifactId = artifactIdFromRef(ref);
              if (artifactId) attachmentIds.push(artifactId);
              return ref;
            }
          : undefined,
        onFailure: (kind, err) => this.opts.logger.warn(`whatsapp.outbound_${kind}_failed`, { err: err.message }),
      }) ?? '[Outbound WhatsApp message]';
      const localKey = normalizeWhatsAppJid(chatId);
      if ((this.#localSubmissionsByChat.get(localKey) ?? 0) > 0) {
        const settled = await this.#waitForLocalSubmission(localKey);
        if (!settled) {
          this.opts.logger.warn('whatsapp.outbound_origin_ambiguous', { connectionId: this.opts.connectionId, chatId, externalId });
          return;
        }
      }
      if (!this.#locallySubmittedMessageIds.has(externalId)) {
        const alternateChatIds = observedWhatsAppChatJids(key).filter((candidate) => candidate !== chatId);
        this.opts.onPeerObserved?.({ primaryChatId: chatId, aliases: [chatId, ...alternateChatIds], source: 'message', verified: alternateChatIds.length > 0 });
        this.opts.onOutboundObserved?.({
          externalId,
          chatId,
          ...(alternateChatIds.length ? { alternateChatIds } : {}),
          body,
          ...(attachmentIds.length ? { attachmentIds: [...new Set(attachmentIds)] } : {}),
        });
      }
      return;
    }
    await this.#handleInbound(msg);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async #handleInbound(msg: any): Promise<void> {
    const key = msg?.key;
    if (!key || key.fromMe) return;
    const remoteJid: string | undefined = key.remoteJid;
    if (!remoteJid || remoteJid === 'status@broadcast') return;
    // baileys 7.x addresses many 1:1 chats by a hidden LID (`<id>@lid`). The same
    // message carries the sender's real phone-number JID in `remoteJidAlt` (from
    // the stanza's sender_pn). Key the chat off the PN so the conversation uses a
    // real number and replies thread back to the user's normal WhatsApp chat —
    // replying to the raw @lid lands in a phantom chat. Non-LID chats are
    // unchanged, and we fall back to the LID if no PN alt is present.
    const chatJid = observedWhatsAppChatJid(key) ?? remoteJid;

    // A live inbound has reached the resident agent, so acknowledge it before
    // potentially expensive transcription/vision/model work. This produces the
    // normal blue read receipt when the linked account and peer permit receipts.
    // Use the provider key unchanged: replacing a LID with its PN alias can make
    // Baileys acknowledge a different chat.
    try {
      if (this.opts.autoReadInbound !== false && typeof this.#sock?.readMessages === 'function' && typeof key.id === 'string' && key.id) {
        await this.#sock.readMessages([key]);
      }
    } catch (err) {
      this.opts.logger.warn('whatsapp.read_receipt_failed', {
        connectionId: this.opts.connectionId,
        externalId: typeof key.id === 'string' ? key.id : undefined,
        err: (err as Error).message,
      });
    }
    if (chatJid !== remoteJid) {
      this.opts.logger.info('whatsapp.lid_mapped_to_pn', { connectionId: this.opts.connectionId, lid: remoteJid, repliesTo: chatJid });
    } else if (remoteJid.endsWith('@lid')) {
      // LID chat with no phone-number alt in the stanza — we can only reply to the
      // LID, which may not thread. Surface it so the cause is visible if it recurs.
      this.opts.logger.warn('whatsapp.lid_no_pn_alt', { connectionId: this.opts.connectionId, lid: remoteJid });
    }
    const externalId = String(key.id ?? `${chatJid}:${msg.messageTimestamp ?? Date.now()}`);
    const from = msg.pushName ? String(msg.pushName) : undefined;
    const aliases = observedWhatsAppChatJids(key);
    this.opts.onPeerObserved?.({
      primaryChatId: chatJid,
      aliases,
      ...(from ? { displayName: from } : {}),
      source: 'message',
      verified: aliases.length > 1,
    });

    const attachmentIds: string[] = [];
    let mediaContext: WhatsAppMediaContext | undefined;
    const body = await resolveWhatsAppInboundBody(msg, {
      onMediaContext: (context) => { mediaContext = context; },
      downloadMedia: this.#downloadMedia,
      transcribeAudio: this.opts.transcribeAudio,
      describeImage: this.opts.describeImage,
      extractDocument: this.opts.extractDocument,
      persistMedia: this.opts.persistMedia
        ? async (media) => {
            const ref = await this.opts.persistMedia!(media);
            const artifactId = artifactIdFromRef(ref);
            if (artifactId) attachmentIds.push(artifactId);
            return ref;
          }
        : undefined,
      onFailure: (kind, err) => this.opts.logger.warn(`whatsapp.${kind}_failed`, { err: err.message }),
    });

    if (!body) return; // nothing usable (non-text, no transcription/description/extraction)
    this.opts.onInbound({
      externalId,
      chatId: chatJid,
      body,
      ...(from ? { from } : {}),
      ...(aliases.length > 1 ? { alternateChatIds: aliases.filter((value) => value !== chatJid) } : {}),
      ...(attachmentIds.length ? { attachmentIds: [...new Set(attachmentIds)] } : {}),
      ...(mediaContext ? { mediaContext } : {}),
      ...(extractWhatsAppQuotedContext(msg) ? { quotedContext: extractWhatsAppQuotedContext(msg) } : {}),
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #observeContact(contact: any): void {
    const id = typeof contact?.id === 'string' ? contact.id : '';
    if (!id || id === 'status@broadcast') return;
    const pn = firstProviderId(contact, ['phoneNumber', 'pnJid', 'pn']);
    const aliases = observedWhatsAppChatJids({ remoteJid: id, remoteJidAlt: pn });
    if (aliases.length === 0) return;
    const displayName = [contact?.verifiedName, contact?.name, contact?.notify]
      .find((value) => typeof value === 'string' && value.trim());
    this.opts.onPeerObserved?.({
      primaryChatId: aliases[0]!,
      aliases,
      ...(displayName ? { displayName: String(displayName).trim() } : {}),
      source: 'contact',
      verified: Boolean(contact?.verifiedName || aliases.length > 1),
    });
  }

  #isSelfJid(jid: string): boolean {
    return this.#selfJids.has(normalizeWhatsAppJid(jid));
  }

  #rememberLocalSubmission(providerMessageId: string): void {
    this.#locallySubmittedMessageIds.add(providerMessageId);
    if (this.#locallySubmittedMessageIds.size <= 2_000) return;
    const oldest = this.#locallySubmittedMessageIds.values().next().value as string | undefined;
    if (oldest) this.#locallySubmittedMessageIds.delete(oldest);
  }

  #waitForLocalSubmission(chatKey: string): Promise<boolean> {
    if ((this.#localSubmissionsByChat.get(chatKey) ?? 0) === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let finished = false;
      const settle = (settled: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(settled);
      };
      const waiters = this.#localSubmissionWaiters.get(chatKey) ?? new Set<(settled: boolean) => void>();
      waiters.add(settle);
      this.#localSubmissionWaiters.set(chatKey, waiters);
      const timer = setTimeout(() => {
        waiters.delete(settle);
        if (waiters.size === 0) this.#localSubmissionWaiters.delete(chatKey);
        settle(false);
      }, LOCAL_SUBMISSION_CORRELATION_TIMEOUT_MS);
      timer.unref?.();
    });
  }

  async #onQr(qr: string): Promise<void> {
    this.#qr = qr;
    this.#setStatus('qr');
    try {
      const qrcode = (await import('qrcode' as string)) as typeof import('qrcode');
      this.#qrDataUrl = await qrcode.toDataURL(qr);
      this.#emitState();
    } catch (err) {
      this.opts.logger.debug?.('whatsapp.qr_render_failed', { err: (err as Error).message });
    }
  }

  /** Reset the backoff only once the connection has stayed open a while. */
  #armStableOpenReset(): void {
    this.#clearStableOpenTimer();
    this.#stableOpenTimer = setTimeout(() => {
      this.#stableOpenTimer = undefined;
      this.#reconnectAttempts = 0;
    }, STABLE_OPEN_MS);
    this.#stableOpenTimer.unref?.();
  }

  #clearStableOpenTimer(): void {
    if (this.#stableOpenTimer) {
      clearTimeout(this.#stableOpenTimer);
      this.#stableOpenTimer = undefined;
    }
  }

  #doReconnect(): void {
    this.#startPromise = this.#connect().catch((err) => {
      this.opts.logger.warn('whatsapp.reconnect_failed', { connectionId: this.opts.connectionId, err: (err as Error).message });
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect(reason: WhatsAppReconnectClass = 'connection_closed'): void {
    if (this.#closed || this.#reconnectTimer) return;
    const now = Date.now();
    // Respect an active reach-out timelock — do NOT hammer the companion while
    // WhatsApp is enforcing a 463 lock. Wait out the window (best-effort), then
    // try once. An operator relink (start) clears the pause immediately.
    if (this.#reachoutBlockedUntil && this.#reachoutBlockedUntil > now) {
      const wait = Math.min(this.#reachoutBlockedUntil - now + 5_000, REACHOUT_PAUSE_CAP_MS);
      this.#recovery = { reason: 'reachout_paused', attempt: this.#reconnectAttempts, nextRetryAt: new Date(now + wait).toISOString() };
      this.#emitState();
      this.opts.logger.warn('whatsapp.reconnect_paused_reachout', { connectionId: this.opts.connectionId, resumeInMs: wait });
      this.#reconnectTimer = setTimeout(() => {
        this.#reconnectTimer = undefined;
        this.#reachoutBlockedUntil = undefined;
        this.#reconnectAttempts = 0;
        this.#doReconnect();
      }, wait);
      this.#reconnectTimer.unref?.();
      return;
    }
    if (this.#reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.opts.logger.warn('whatsapp.reconnect_exhausted', { connectionId: this.opts.connectionId });
      this.#recovery = { reason: 'exhausted', attempt: this.#reconnectAttempts };
      this.#setStatus('error');
      return;
    }
    const delay = Math.min(
      RECONNECT_MAX_MS,
      Math.round(RECONNECT_INITIAL_MS * RECONNECT_FACTOR ** this.#reconnectAttempts * (0.85 + Math.random() * 0.3)),
    );
    this.#reconnectAttempts += 1;
    this.#recovery = { reason, attempt: this.#reconnectAttempts, nextRetryAt: new Date(now + delay).toISOString() };
    this.#emitState();
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#doReconnect();
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  #setStatus(status: WhatsAppSessionStatus): void {
    if (this.#status === status && status !== 'qr') return;
    this.#status = status;
    this.#emitState();
  }

  #emitState(): void {
    this.opts.onStateChange?.({
      status: this.#status,
      ...(this.#qr ? { qr: this.#qr } : {}),
      ...(this.#selfId ? { selfId: this.#selfId } : {}),
      ...(this.#recovery ? { recovery: this.#recovery } : {}),
    });
  }
}

function firstProviderId(value: unknown, keys: string[]): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const clean = candidate.trim().replace(/:\d+@/u, '@');
    if (clean.includes('@')) return clean;
    const digits = clean.replace(/\D/g, '');
    if (digits) return `${digits}@s.whatsapp.net`;
  }
  return '';
}
