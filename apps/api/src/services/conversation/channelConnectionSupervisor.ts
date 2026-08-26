/**
 * ChannelConnectionSupervisor — owns the live, persistent channel connections
 * (WhatsApp sockets; Telegram long-poll) that don't fit the stateless webhook
 * `ChannelAdapter.send(token,...)` contract.
 *
 * Responsibilities (OMNICHANNEL-ORCHESTRATOR-10X §3.4):
 *   - Boot a live session per active persistent connection at startup, and on
 *     create (Telegram polling) / login (WhatsApp QR).
 *   - WhatsApp auth persists on disk under `${dataDir}/channels/whatsapp/<id>/`
 *     (baileys multi-file auth); Telegram polling uses the stored bot token.
 *   - Route inbound session messages through the same `ChannelTurnDispatcher`
 *     the webhook path uses — one orchestrator-turn code path for every channel.
 *   - Provide `send(connectionId, chatId, body)` so `ChannelBridge.deliverToConnection`
 *     can deliver the orchestrator's reply over the live session.
 *   - Surface login QR + status for the connect UI, mirror status into the row.
 *
 * Persistent vs webhook is decided per connection: WhatsApp is always persistent;
 * Telegram is persistent when it resolves to long polling — explicitly, or by
 * default when no public URL is configured (see `resolveTelegramTransport`); the
 * webhook adapter handles Telegram only when a public URL makes a webhook viable.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { REALTIME_EVENTS, REALTIME_ROOMS, artifactTypeFromMime } from '@agentis/core';
import type { EventBus } from '../../event-bus.js';
import type { Logger } from '../../logger.js';
import type { CredentialVault } from '../credentialVault.js';
import type { ArtifactService } from '../artifactService.js';
import type { ConversationStore } from './conversationStore.js';
import type { ChannelTurnDispatcher } from './channelTurnDispatcher.js';
import { WhatsAppSession, type InboundChannelMedia, type WhatsAppHistoryEntry, type WhatsAppObservedOutbound, type WhatsAppRecoveryState } from '../../adapters/channels/whatsappSession.js';
import { TelegramSession } from '../../adapters/channels/telegramSession.js';
import { resolveTelegramTransport } from '../../adapters/channels/telegram.js';
import { DiscordSession } from '../../adapters/channels/discordSession.js';
import { useVaultAuthState, clearVaultAuthState } from '../../adapters/channels/whatsappVaultAuthState.js';
import type { ChannelDeliveryReceipt, ChannelHealth, ChannelHealthCheck, ChannelStatus, OutboundAttachment, OutboundNativeContent } from '../../adapters/channels/types.js';
import { chunkText, sleep, typingDelayMs, type HumanizeConfig } from './humanize.js';
import type { ConversationHandoffService } from './conversationHandoffService.js';
import type { ConversationSummaryService } from './conversationSummaryService.js';
import { resolveWhatsAppConnectionProfile, shouldClaimWhatsAppManualOutbound } from './channelBridge.js';
import { isVerifiedChannelOwner } from './channelIdentityService.js';
import type { ChannelIdentityService } from './channelIdentityService.js';

type LiveSession = WhatsAppSession | TelegramSession | DiscordSession;

/** A newer inbound superseded a delayed, humanized outbound response. */
export class ChannelPacingCancelledError extends Error {
  constructor(connectionId: string, chatId: string) {
    super(`channel pacing cancelled for ${connectionId}:${chatId}`);
    this.name = 'ChannelPacingCancelledError';
  }
}

/** Collapse a burst of per-message receipts into one, preserving every provider id. */
function aggregateReceipts(receipts: ChannelDeliveryReceipt[]): ChannelDeliveryReceipt {
  const first = receipts[0]!;
  return receipts.length > 1
    ? { ...first, providerMessageIds: receipts.map((r) => r.providerMessageId) }
    : first;
}

interface PersistentRef {
  id: string;
  kind: string;
  workspaceId?: string;
  settings?: unknown;
}

export interface ChannelConnectionSupervisorDeps {
  db: AgentisSqliteDb;
  bus: EventBus;
  logger: Logger;
  vault: CredentialVault;
  conversations: ConversationStore;
  /** Root data dir; WhatsApp auth state is stored beneath it. */
  dataDir: string;
  /** Is a public webhook URL configured? Telegram defaults to long polling when not. */
  hasPublicWebhookUrl?: () => boolean;
  dispatcher?: ChannelTurnDispatcher;
  /** Durable storage for original inbound media, shared by every channel. */
  artifacts?: Pick<ArtifactService, 'persist'>;
  /** Optional voice-note transcription for inbound audio (WhatsApp). */
  transcribeAudio?: (bytes: Buffer, mimeType: string, workspaceId: string) => Promise<string | null>;
  /** Prepare the default STT runtime only when persistent media channels exist. */
  prepareInboundAudio?: (workspaceId?: string) => Promise<unknown>;
  /** Optional image understanding for inbound images (WhatsApp). */
  describeImage?: (bytes: Buffer, mimeType: string, workspaceId: string, caption?: string) => Promise<string | null>;
  /** Optional document text extraction for inbound documents (WhatsApp). */
  extractDocument?: (bytes: Buffer, mimeType: string, workspaceId: string, fileName?: string) => Promise<string | null>;
  handoffs?: ConversationHandoffService;
  summaries?: ConversationSummaryService;
  /** Canonical provider-peer directory (PN/LID/name folding). */
  identity?: ChannelIdentityService;
}

export interface LoginState {
  status: string;
  qr?: string;
  qrDataUrl?: string;
  selfId?: string;
  /** Safe, provider-agnostic reconnect progress for the QR pairing UI. */
  recovery?: WhatsAppRecoveryState;
}

function discordIsGateway(settings: unknown): boolean {
  return Boolean(settings && typeof settings === 'object' && (settings as { transport?: string }).transport === 'gateway');
}

function whatsappIsQrLocal(settings: unknown): boolean {
  return !settings || typeof settings !== 'object' || (settings as { mode?: string }).mode !== 'cloud';
}

export class ChannelConnectionSupervisor {
  readonly #sessions = new Map<string, LiveSession>();
  /** Incremented by a newer inbound so delayed humanized sends never go stale. */
  readonly #pacingEpoch = new Map<string, number>();
  #dispatcher: ChannelTurnDispatcher | undefined;

  constructor(private readonly deps: ChannelConnectionSupervisorDeps) {
    this.#dispatcher = deps.dispatcher;
  }

  setDispatcher(dispatcher: ChannelTurnDispatcher) {
    this.#dispatcher = dispatcher;
  }

  /** Is a public webhook URL configured? Drives the Telegram polling default. */
  /** Agent a workspace-owned connection's inbound routes to: orchestrator, else
   *  the first agent, else null. Mirrors ChannelBridge.#resolveInboundAgentId. */
  #resolveInboundAgentId(workspaceId: string): string | null {
    const orchestrator = this.deps.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.role, 'orchestrator')))
      .get();
    if (orchestrator) return orchestrator.id;
    const any = this.deps.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, workspaceId))
      .get();
    return any?.id ?? null;
  }

  #hasPublicWebhookUrl(): boolean {
    return this.deps.hasPublicWebhookUrl ? this.deps.hasPublicWebhookUrl() : Boolean(process.env.AGENTIS_PUBLIC_URL);
  }

  /** Telegram runs here (long polling) when it resolves to polling — explicitly, or
   *  by default on a local install with no public URL. */
  #telegramIsPolling(settings: unknown): boolean {
    const explicit = settings && typeof settings === 'object' ? (settings as { transport?: string }).transport : undefined;
    return resolveTelegramTransport({ explicit, hasPublicUrl: this.#hasPublicWebhookUrl() }) === 'polling';
  }

  /** Does outbound for this connection route through a live session? */
  handles(conn: PersistentRef): boolean {
    if (conn.kind === 'whatsapp') return whatsappIsQrLocal(conn.settings);
    if (conn.kind === 'telegram') return this.#telegramIsPolling(conn.settings);
    if (conn.kind === 'discord') return discordIsGateway(conn.settings);
    return false;
  }

  /** Kinds that authenticate without a token (QR). */
  requiresNoToken(kind: string, settings?: unknown): boolean {
    return kind === 'whatsapp' && whatsappIsQrLocal(settings);
  }

  /** Post-create hook: start polling sessions immediately (no-op for QR kinds). */
  onCreated(conn: PersistentRef): void {
    if (conn.kind === 'whatsapp' || conn.kind === 'telegram') this.#prepareInboundAudio(conn.workspaceId);
    // Token-authenticated live sessions (Telegram polling, Discord gateway) can
    // start immediately. WhatsApp starts via explicit QR login (startLogin).
    const startsOnCreate = (conn.kind === 'telegram' && this.#telegramIsPolling(conn.settings))
      || (conn.kind === 'discord' && discordIsGateway(conn.settings));
    if (startsOnCreate) {
      void this.ensureSession(conn.id).start().catch((err) => {
        this.deps.logger.warn('channel.supervisor.create_start_failed', { connectionId: conn.id, err: (err as Error).message });
      });
    }
  }

  /**
   * Boot every already-active persistent connection on startup so a restart
   * restores live sessions without operator action.
   */
  async startAll(): Promise<void> {
    const rows = this.deps.db.select().from(schema.channelConnections).all();
    const mediaWorkspaces = new Set(rows
      .filter((row) => row.status !== 'paused' && (row.kind === 'whatsapp' || row.kind === 'telegram'))
      .map((row) => row.workspaceId));
    for (const workspaceId of mediaWorkspaces) this.#prepareInboundAudio(workspaceId);
    for (const row of rows) {
      if (row.status === 'paused') continue;
      if (!this.handles({ id: row.id, kind: row.kind, settings: row.settings })) continue;
      try {
        await this.ensureSession(row.id).start();
      } catch (err) {
        this.deps.logger.warn('channel.supervisor.boot_failed', { connectionId: row.id, err: (err as Error).message });
      }
    }
  }

  /** Start (or reuse) a WhatsApp login and return the current QR/status. */
  async startLogin(connectionId: string): Promise<LoginState> {
    const connection = this.deps.db
      .select({ workspaceId: schema.channelConnections.workspaceId })
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connectionId))
      .get();
    this.#prepareInboundAudio(connection?.workspaceId);
    const session = this.ensureSession(connectionId);
    // A definitive logged_out/error means the previously registered creds are
    // dead (device unlinked phone-side, or the session errored out). Reusing
    // them makes baileys silently retry the dead session instead of emitting a
    // fresh QR — "Relink QR" would spin forever. Clear them first so the next
    // connect attempt pairs from scratch and actually issues a new QR.
    if (session instanceof WhatsAppSession && (session.status === 'logged_out' || session.status === 'error')) {
      clearVaultAuthState({ db: this.deps.db, connectionId });
    }
    // QR provisioning includes a lazy Baileys load and a WhatsApp Web version
    // lookup. Do not hold the HTTP request open for that network work: the
    // caller receives `connecting` immediately and polls for the QR.
    void session.start();
    return this.loginState(connectionId);
  }

  loginState(connectionId: string): LoginState {
    const session = this.#sessions.get(connectionId);
    if (!session) return { status: 'idle' };
    if (session instanceof WhatsAppSession) {
      return {
        status: session.status,
        ...(session.qr ? { qr: session.qr } : {}),
        ...(session.qrDataUrl ? { qrDataUrl: session.qrDataUrl } : {}),
        ...(session.selfId ? { selfId: session.selfId } : {}),
        ...(session.recovery ? { recovery: session.recovery } : {}),
      };
    }
    return { status: session.status };
  }

  status(connectionId: string): LoginState | null {
    const session = this.#sessions.get(connectionId);
    if (!session) return null;
    return this.loginState(connectionId);
  }

  /**
   * Deliver an outbound message over the live session. When attachments are
   * present, each is sent as its own native media message (the first carries the
   * body as its caption), mirroring the WhatsApp Cloud + Telegram webhook paths.
   * A session that cannot carry media still delivers the text so nothing is lost.
   *
   * When a human-like `humanize` config is supplied, long text is split into a
   * natural burst and each message is preceded by a jittered "typing…" indicator
   * (§6). Presence is best-effort — a session without `setTyping` still delivers.
   */
  async send(
    connectionId: string,
    chatId: string,
    body: string,
    attachments?: OutboundAttachment[],
    humanize?: HumanizeConfig,
    native?: OutboundNativeContent,
    authority?: { actor: 'automation' | 'human'; conversationId?: string; expectedEpoch?: number },
  ): Promise<ChannelDeliveryReceipt> {
    const session = this.#sessions.get(connectionId);
    if (!session) throw new Error(`no live session for connection ${connectionId}`);
    const connection = this.deps.db.select({ workspaceId: schema.channelConnections.workspaceId })
      .from(schema.channelConnections).where(eq(schema.channelConnections.id, connectionId)).get();
    if (!connection) throw new Error(`channel connection ${connectionId} not found`);
    const media = attachments ?? [];
    const cfg = humanize?.enabled ? humanize : undefined;
    const typer = session as { setTyping?: (chatId: string, on: boolean) => Promise<void> };
    const canType = Boolean(cfg && typeof typer.setTyping === 'function');
    const pacingKey = `${connectionId}:${chatId}`;
    const pacingEpoch = this.#pacingEpoch.get(pacingKey) ?? 0;
    const isStale = () => (this.#pacingEpoch.get(pacingKey) ?? 0) !== pacingEpoch;
    const assertFresh = () => {
      if (isStale()) throw new ChannelPacingCancelledError(connectionId, chatId);
      if (authority?.actor === 'human') return;
      if (authority?.conversationId) this.deps.handoffs?.assertAutomationAllowed({
        workspaceId: connection.workspaceId,
        conversationId: authority.conversationId,
        ...(authority.expectedEpoch !== undefined ? { expectedEpoch: authority.expectedEpoch } : {}),
      });
      else this.deps.handoffs?.assertAutomationAllowedByChannel({
        workspaceId: connection.workspaceId,
        connectionId,
        chatId,
        ...(authority?.expectedEpoch !== undefined ? { expectedEpoch: authority.expectedEpoch } : {}),
      });
    };

    if (native) {
      const nativeSession = session as { sendNative?: (chatId: string, content: OutboundNativeContent) => Promise<ChannelDeliveryReceipt> };
      if (typeof nativeSession.sendNative !== 'function') {
        throw new Error(`${session.constructor.name} does not support native ${native.kind} messages`);
      }
      assertFresh();
      const receipts = [await nativeSession.sendNative(chatId, native)];
      if (body.trim()) {
        assertFresh();
        receipts.push(await session.sendText(chatId, body.trim()));
      }
      return aggregateReceipts(receipts);
    }

    // Text-only: optionally chunk into a burst, typing before each piece.
    if (media.length === 0) {
      if (!cfg) {
        assertFresh();
        return session.sendText(chatId, body);
      }
      const chunks = chunkText(body, cfg);
      if (chunks.length <= 1) {
        await this.#typingPause(typer, chatId, body.length, cfg, canType, isStale);
        assertFresh();
        return session.sendText(chatId, chunks[0] ?? body);
      }
      const receipts: ChannelDeliveryReceipt[] = [];
      for (let i = 0; i < chunks.length; i += 1) {
        await this.#typingPause(typer, chatId, chunks[i]!.length, cfg, canType, isStale);
        assertFresh();
        receipts.push(await session.sendText(chatId, chunks[i]!));
        if (i < chunks.length - 1) await this.#waitForPacing(cfg.interMessageMs, isStale);
      }
      return aggregateReceipts(receipts);
    }

    const mediaSession = session as { sendMedia?: (chatId: string, attachment: OutboundAttachment, caption?: string) => Promise<ChannelDeliveryReceipt> };
    if (typeof mediaSession.sendMedia !== 'function') {
      // Session type has no media transport yet (e.g. Discord gateway). Deliver
      // the text rather than silently dropping the whole message.
      this.deps.logger.warn('channel.session_media_unsupported', { connectionId, kind: session.constructor.name, attachments: media.length });
      assertFresh();
      return session.sendText(chatId, body);
    }

    const receipts: ChannelDeliveryReceipt[] = [];
    for (let i = 0; i < media.length; i += 1) {
      const caption = i === 0 && body.trim() ? body : undefined;
      if (cfg) await this.#typingPause(typer, chatId, (caption ?? '').length + 120, cfg, canType, isStale);
      assertFresh();
      receipts.push(await mediaSession.sendMedia(chatId, media[i]!, caption));
      if (cfg && i < media.length - 1) await this.#waitForPacing(cfg.interMessageMs, isStale);
    }
    return aggregateReceipts(receipts);
  }

  /**
   * Show a "typing…" indicator for a jittered, length-scaled duration before a
   * message. Re-emits every ~8s because WhatsApp auto-clears composing at ~10s,
   * so a long compose stays visibly "typing" the whole time.
   */
  async #typingPause(
    typer: { setTyping?: (chatId: string, on: boolean) => Promise<void> },
    chatId: string,
    textLen: number,
    cfg: HumanizeConfig,
    canType: boolean,
    isStale: () => boolean,
  ): Promise<void> {
    const delay = typingDelayMs(textLen, cfg);
    if (delay <= 0) return;
    if (!canType || !typer.setTyping) {
      await this.#waitForPacing(delay, isStale);
      return;
    }
    const REEMIT_MS = 8_000;
    let waited = 0;
    while (waited < delay) {
      if (isStale()) throw new ChannelPacingCancelledError('', chatId);
      try { await typer.setTyping(chatId, true); } catch { /* presence is best-effort */ }
      const step = Math.min(REEMIT_MS, delay - waited);
      await this.#waitForPacing(step, isStale);
      waited += step;
    }
  }

  #prepareInboundAudio(workspaceId?: string): void {
    if (!this.deps.prepareInboundAudio) return;
    void this.deps.prepareInboundAudio(workspaceId).catch((error) => {
      this.deps.logger.warn('channel.transcription_prepare_failed', {
        ...(workspaceId ? { workspaceId } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async #waitForPacing(delayMs: number, isStale: () => boolean): Promise<void> {
    let waited = 0;
    while (waited < delayMs) {
      if (isStale()) throw new ChannelPacingCancelledError('', '');
      const step = Math.min(250, delayMs - waited);
      await sleep(step);
      waited += step;
    }
    if (isStale()) throw new ChannelPacingCancelledError('', '');
  }

  async outboundHealth(connectionId: string): Promise<ChannelHealthCheck | null> {
    const session = this.#sessions.get(connectionId);
    return session instanceof WhatsAppSession ? session.outboundHealthCheck() : null;
  }

  /** Add/clear a reaction on a prior message over the live session (best-effort). */
  async react(connectionId: string, chatId: string, targetMessageId: string, emoji: string): Promise<void> {
    const session = this.#sessions.get(connectionId);
    const reactor = session as { sendReaction?: (chatId: string, targetMessageId: string, emoji: string) => Promise<void> };
    if (typeof reactor.sendReaction === 'function') {
      await reactor.sendReaction(chatId, targetMessageId, emoji);
    }
  }

  async stop(connectionId: string): Promise<void> {
    const session = this.#sessions.get(connectionId);
    if (session) {
      await session.stop();
      this.#sessions.delete(connectionId);
    }
  }

  /** Show/clear the typing indicator on a live session (best-effort, no-op otherwise). */
  async setTyping(connectionId: string, chatId: string, on: boolean): Promise<void> {
    const session = this.#sessions.get(connectionId);
    if (!session) return;
    try {
      await session.setTyping(chatId, on);
    } catch {
      /* best-effort */
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((s) => s.stop().catch(() => {})));
    this.#sessions.clear();
  }


  ensureSession(connectionId: string): LiveSession {
    const existing = this.#sessions.get(connectionId);
    if (existing) return existing;
    const row = this.deps.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connectionId))
      .get();
    if (!row) throw new Error(`channel connection ${connectionId} not found`);

    let session: LiveSession;
    if (row.kind === 'telegram') {
      const token = this.deps.vault.decrypt(row.tokenEncrypted);
      session = new TelegramSession({
        connectionId,
        token,
        logger: this.deps.logger,
        onInbound: (msg) => this.#onInbound(connectionId, msg),
        onStateChange: (state) => this.#onStateChange(connectionId, state),
        ...(this.deps.transcribeAudio ? {
          transcribeAudio: (bytes: Buffer, mimeType: string) => this.deps.transcribeAudio!(bytes, mimeType, row.workspaceId),
        } : {}),
        ...(this.deps.describeImage ? {
          describeImage: (bytes: Buffer, mimeType: string, caption?: string) => this.deps.describeImage!(bytes, mimeType, row.workspaceId, caption),
        } : {}),
        ...(this.deps.extractDocument ? {
          extractDocument: (bytes: Buffer, mimeType: string, fileName?: string) => this.deps.extractDocument!(bytes, mimeType, row.workspaceId, fileName),
        } : {}),
        ...(this.deps.artifacts ? {
          persistMedia: (media: InboundChannelMedia) => this.#persistInboundMedia(row, media),
        } : {}),
      });
    } else if (row.kind === 'discord') {
      const token = this.deps.vault.decrypt(row.tokenEncrypted);
      session = new DiscordSession({
        connectionId,
        token,
        logger: this.deps.logger,
        onInbound: (msg) => this.#onInbound(connectionId, msg),
        onStateChange: (state) => this.#onStateChange(connectionId, state),
      });
    } else {
      const authDir = path.join(this.deps.dataDir, 'channels', 'whatsapp', connectionId);
      const profile = resolveWhatsAppConnectionProfile(
        row.settings && typeof row.settings === 'object' && !Array.isArray(row.settings)
          ? (row.settings as { whatsappProfile?: unknown }).whatsappProfile
          : undefined,
      );
      session = new WhatsAppSession({
        connectionId,
        authDir,
        logger: this.deps.logger,
        onInbound: (msg) => this.#onInbound(connectionId, msg),
        onOutboundObserved: (msg) => this.observeOutbound(connectionId, msg),
        onPeerObserved: (peer) => {
          this.deps.identity?.observeAliases({
            workspaceId: row.workspaceId,
            connectionId: row.id,
            channelKind: row.kind,
            primaryHandle: peer.primaryChatId,
            aliases: peer.aliases,
            ...(peer.displayName ? { displayName: peer.displayName } : {}),
            source: peer.source,
            verified: peer.verified,
            countMessage: false,
          });
        },
        ...(profile.historyReconciliation === 'recent'
          ? { onHistoryReconciled: (messages: WhatsAppHistoryEntry[]) => this.#reconcileWhatsAppHistory(connectionId, messages) }
          : {}),
        onStateChange: (state) => this.#onStateChange(connectionId, state),
        onDeliveryUpdate: (update) => this.#onDeliveryUpdate(connectionId, update),
        // Persist creds/keys vault-encrypted in the DB, not plaintext on disk.
        loadAuthState: () => useVaultAuthState({ db: this.deps.db, vault: this.deps.vault, connectionId }),
        ...(this.deps.transcribeAudio ? {
          transcribeAudio: (bytes: Buffer, mimeType: string) => this.deps.transcribeAudio!(bytes, mimeType, row.workspaceId),
        } : {}),
        ...(this.deps.describeImage ? {
          describeImage: (bytes: Buffer, mimeType: string, caption?: string) => this.deps.describeImage!(bytes, mimeType, row.workspaceId, caption),
        } : {}),
        ...(this.deps.extractDocument ? {
          extractDocument: (bytes: Buffer, mimeType: string, fileName?: string) => this.deps.extractDocument!(bytes, mimeType, row.workspaceId, fileName),
        } : {}),
        ...(this.deps.artifacts ? {
          persistMedia: (media: InboundChannelMedia) => this.#persistInboundMedia(row, media),
        } : {}),
      });
    }
    this.#sessions.set(connectionId, session);
    return session;
  }

  async #persistInboundMedia(
    row: { id: string; workspaceId: string },
    media: InboundChannelMedia,
  ): Promise<string | null> {
    if (!this.deps.artifacts) return null;
    const artifact = this.deps.artifacts.persist({
      workspaceId: row.workspaceId,
      agentId: this.#resolveInboundAgentId(row.workspaceId),
      origin: 'channel',
      type: artifactTypeFromMime(media.mimeType, media.filename),
      title: `Inbound ${media.kind}: ${media.filename}`,
      name: media.filename,
      content: `data:${media.mimeType};base64,${media.bytes.toString('base64')}`,
      savedBy: 'channel',
      metadataExtra: {
        mime: media.mimeType,
        size: media.bytes.byteLength,
        channelConnectionId: row.id,
        channelMediaKind: media.kind,
        ...(media.caption ? { caption: media.caption } : {}),
        ...(media.gifPlayback ? { gifPlayback: true } : {}),
      },
    });
    return artifact.ref;
  }

  #onInbound(connectionId: string, msg: {
    externalId: string;
    chatId: string;
    body: string;
    from?: string;
    alternateChatIds?: string[];
    threadId?: string;
    attachmentIds?: string[];
  }): void {
    const pacingKey = `${connectionId}:${msg.chatId}`;
    this.#pacingEpoch.set(pacingKey, (this.#pacingEpoch.get(pacingKey) ?? 0) + 1);
    const row = this.deps.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connectionId))
      .get();
    if (!row) return;

    // Idempotency against re-delivered messages.
    const dup = this.deps.db
      .select({ id: schema.channelDeliveries.id })
      .from(schema.channelDeliveries)
      .where(eq(schema.channelDeliveries.externalId, msg.externalId))
      .get();
    if (dup) return;

    const currentSettings = row.settings && typeof row.settings === 'object' && !Array.isArray(row.settings)
      ? row.settings as Record<string, unknown>
      : {};
    if (!currentSettings.defaultChatId) {
      this.deps.db
        .update(schema.channelConnections)
        .set({
          settings: { ...currentSettings, defaultChatId: msg.chatId },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.channelConnections.id, connectionId))
        .run();
    }

    // Workspace-owned (null-agent) connection routes inbound to the orchestrator.
    const inboundAgentId = row.agentId ?? this.#resolveInboundAgentId(row.workspaceId);
    if (!inboundAgentId) return;
    const peer = this.deps.identity?.observeAliases({
      workspaceId: row.workspaceId,
      connectionId: row.id,
      channelKind: row.kind,
      primaryHandle: msg.chatId,
      aliases: msg.alternateChatIds,
      ...(msg.from ? { displayName: msg.from } : {}),
      source: 'inbound_message',
      countMessage: false,
    });
    const conversation = this.deps.conversations.getOrCreateByChannel({
      workspaceId: row.workspaceId,
      ambientId: row.ambientId,
      userId: row.userId,
      agentId: inboundAgentId,
      channelConnectionId: row.id,
      channelChatId: msg.chatId,
      channelPeerIdentityId: peer?.id ?? null,
      appId: row.appId ?? null,
    });
    const fromTag = msg.from ? `[${msg.from}] ` : '';
    const message = this.deps.conversations.appendMirrored({
      workspaceId: row.workspaceId,
      conversationId: conversation.id,
      sessionMessageId: msg.externalId,
      authorType: 'system',
      participantSide: 'customer',
      body: `${fromTag}${msg.body}`,
      metadata: {
        channel: row.kind,
        channelConnectionId: row.id,
        channelInbound: true,
        ...(msg.attachmentIds?.length ? { artifactIds: msg.attachmentIds } : {}),
        ...(msg.threadId ? { threadId: msg.threadId } : {}),
        ...(msg.from ? { from: msg.from } : {}),
      },
    });
    this.deps.db
      .insert(schema.channelDeliveries)
      .values({
        id: randomUUID(),
        connectionId: row.id,
        workspaceId: row.workspaceId,
        externalId: msg.externalId,
        conversationMessageId: message.id,
      })
      .run();

    this.deps.bus.publish(REALTIME_ROOMS.workspace(row.workspaceId), REALTIME_EVENTS.CHANNEL_MESSAGE_RECEIVED, {
      connectionId: row.id,
      kind: row.kind,
      agentId: row.agentId,
      chatId: msg.chatId,
      messageId: message.id,
    });

    void this.#dispatcher?.dispatch({
      workspaceId: row.workspaceId,
      ambientId: row.ambientId,
      userId: row.userId,
      agentId: inboundAgentId,
      appId: row.appId ?? null,
      conversationId: conversation.id,
      connectionId: row.id,
      kind: row.kind,
      chatId: msg.chatId,
      text: msg.body,
      ...(msg.attachmentIds?.length ? { attachmentIds: msg.attachmentIds } : {}),
      ...(msg.threadId ? { threadId: msg.threadId } : {}),
      ...(msg.from ? { from: msg.from } : {}),
      inboundMessageId: message.id,
    });
  }

  /** Persist an operator send observed from the primary phone or another companion. */
  observeOutbound(connectionId: string, msg: WhatsAppObservedOutbound): void {
    const pacingKey = `${connectionId}:${msg.chatId}`;
    this.#pacingEpoch.set(pacingKey, (this.#pacingEpoch.get(pacingKey) ?? 0) + 1);
    const row = this.deps.db.select().from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connectionId)).get();
    if (!row) return;
    const duplicate = this.deps.db.select({ id: schema.channelDeliveries.id })
      .from(schema.channelDeliveries)
      .where(eq(schema.channelDeliveries.externalId, msg.externalId)).get();
    if (duplicate) return;
    const agentisSubmission = this.deps.db.select({ id: schema.channelOutboundDeliveries.id })
      .from(schema.channelOutboundDeliveries)
      .where(and(
        eq(schema.channelOutboundDeliveries.connectionId, connectionId),
        eq(schema.channelOutboundDeliveries.providerMessageId, msg.externalId),
      )).get();
    if (agentisSubmission) return;

    const agentId = row.agentId ?? this.#resolveInboundAgentId(row.workspaceId);
    if (!agentId) return;
    const peer = this.deps.identity?.observeAliases({
      workspaceId: row.workspaceId,
      connectionId: row.id,
      channelKind: row.kind,
      primaryHandle: msg.chatId,
      aliases: msg.alternateChatIds,
      source: 'observed_outbound',
      countMessage: false,
    });
    const conversation = this.deps.conversations.getOrCreateByChannel({
      workspaceId: row.workspaceId,
      ambientId: row.ambientId,
      userId: row.userId,
      agentId,
      channelConnectionId: row.id,
      channelChatId: msg.chatId,
      channelPeerIdentityId: peer?.id ?? null,
      appId: row.appId ?? null,
    });
    const settings = row.settings && typeof row.settings === 'object' && !Array.isArray(row.settings)
      ? row.settings as { whatsappProfile?: unknown; ownerChatId?: unknown }
      : {};
    const observedHandles = [...new Set([msg.chatId, ...(msg.alternateChatIds ?? [])].filter(Boolean))];
    const shouldClaimHuman = observedHandles.every((handle) =>
      shouldClaimWhatsAppManualOutbound(settings, handle, isVerifiedChannelOwner(this.deps.db, {
        workspaceId: row.workspaceId,
        connectionId: row.id,
        channelKind: row.kind,
        handle,
      })),
    );
    if (shouldClaimHuman) {
      this.deps.handoffs?.claimHuman({
        workspaceId: row.workspaceId,
        conversationId: conversation.id,
        source: 'provider_observed',
      });
    }
    const message = this.deps.conversations.appendOutbound({
      workspaceId: row.workspaceId,
      conversationId: conversation.id,
      operatorId: row.userId,
      participantSide: 'business',
      sessionMessageId: msg.externalId,
      body: msg.body,
      deliveryStatus: 'sent',
      metadata: {
        channel: row.kind,
        channelConnectionId: row.id,
        channelOutboundObserved: true,
        source: 'external_whatsapp_client',
        providerMessageId: msg.externalId,
        ...(msg.attachmentIds?.length ? { artifactIds: msg.attachmentIds } : {}),
      },
    });
    this.deps.db.insert(schema.channelDeliveries).values({
      id: randomUUID(),
      connectionId: row.id,
      workspaceId: row.workspaceId,
      externalId: msg.externalId,
      conversationMessageId: message.id,
    }).run();
    this.deps.bus.publish(REALTIME_ROOMS.workspace(row.workspaceId), REALTIME_EVENTS.CHANNEL_MESSAGE_SENT, {
      connectionId: row.id,
      kind: row.kind,
      agentId,
      chatId: msg.chatId,
      messageId: message.id,
      providerMessageId: msg.externalId,
      providerAcknowledged: true,
      observed: true,
      source: 'external_whatsapp_client',
    });
  }

  async #reconcileWhatsAppHistory(connectionId: string, entries: WhatsAppHistoryEntry[]): Promise<void> {
    const row = this.deps.db.select().from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connectionId)).get();
    if (!row || row.kind !== 'whatsapp') return;
    const profile = resolveWhatsAppConnectionProfile(
      row.settings && typeof row.settings === 'object' && !Array.isArray(row.settings)
        ? (row.settings as { whatsappProfile?: unknown }).whatsappProfile
        : undefined,
    );
    if (profile.historyReconciliation !== 'recent') return;
    const agentId = row.agentId ?? this.#resolveInboundAgentId(row.workspaceId);
    if (!agentId) return;
    const touched = new Set<string>();
    for (const entry of [...entries].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) {
      const peer = this.deps.identity?.observeAliases({
        workspaceId: row.workspaceId,
        connectionId: row.id,
        channelKind: row.kind,
        primaryHandle: entry.chatId,
        source: 'history_reconciliation',
        countMessage: false,
      });
      const conversation = this.deps.conversations.getOrCreateByChannel({
        workspaceId: row.workspaceId,
        ambientId: row.ambientId,
        userId: row.userId,
        agentId,
        channelConnectionId: row.id,
        channelChatId: entry.chatId,
        channelPeerIdentityId: peer?.id ?? null,
        appId: row.appId ?? null,
      });
      this.deps.conversations.appendReconciledChannelMessage({
        workspaceId: row.workspaceId,
        conversationId: conversation.id,
        sessionMessageId: entry.externalId,
        body: entry.body,
        participantSide: entry.participantSide,
        occurredAt: entry.occurredAt,
        metadata: {
          channel: 'whatsapp',
          channelConnectionId: row.id,
          channelChatId: entry.chatId,
          providerMessageId: entry.externalId,
          ...(entry.participantSide === 'customer' ? { channelInbound: true } : { channelOutboundObserved: true }),
          ...(entry.attachmentIds?.length ? { artifactIds: entry.attachmentIds } : {}),
        },
      });
      touched.add(conversation.id);
    }
    for (const conversationId of touched) this.deps.summaries?.invalidate(conversationId);
    this.deps.logger.info('whatsapp.history_reconciled', {
      connectionId,
      conversations: touched.size,
      messages: entries.length,
    });
  }

  #onDeliveryUpdate(
    connectionId: string,
    update: { providerMessageId: string; status: ChannelDeliveryReceipt['status']; providerStatus: number; recipient?: string },
  ): void {
    const connection = this.deps.db
      .select({
        workspaceId: schema.channelConnections.workspaceId,
        kind: schema.channelConnections.kind,
        agentId: schema.channelConnections.agentId,
      })
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connectionId))
      .get();
    if (!connection) return;
    const deliveries = this.deps.db
      .select()
      .from(schema.channelOutboundDeliveries)
      .where(and(
        eq(schema.channelOutboundDeliveries.connectionId, connectionId),
        eq(schema.channelOutboundDeliveries.providerMessageId, update.providerMessageId),
      ))
      .all();
    const rank: Record<string, number> = { sending: 0, queued: 1, accepted: 2, delivered: 3, read: 4 };
    for (const delivery of deliveries) {
      if ((rank[update.status] ?? 0) <= (rank[delivery.status] ?? 0)) continue;
      const previousReceipt = delivery.receipt && typeof delivery.receipt === 'object'
        ? delivery.receipt as ChannelDeliveryReceipt
        : null;
      const receipt: ChannelDeliveryReceipt = {
        ...(previousReceipt ?? {
          provider: 'whatsapp',
          providerMessageId: update.providerMessageId,
          acceptedAt: new Date().toISOString(),
        }),
        status: update.status,
        providerAcknowledged: true,
        providerStatus: update.providerStatus,
        ...(update.recipient ? { recipient: update.recipient, providerRecipient: update.recipient } : {}),
      };
      this.deps.db.update(schema.channelOutboundDeliveries).set({
        status: update.status,
        receipt,
        error: null,
        updatedAt: new Date().toISOString(),
      }).where(eq(schema.channelOutboundDeliveries.id, delivery.id)).run();
      const conversationMessage = this.deps.db.select().from(schema.conversationMessages)
        .where(and(
          eq(schema.conversationMessages.workspaceId, connection.workspaceId),
          eq(schema.conversationMessages.sessionMessageId, delivery.idempotencyKey),
        )).get();
      if (conversationMessage) {
        const conversation = this.deps.db.select({ agentId: schema.conversations.agentId })
          .from(schema.conversations).where(eq(schema.conversations.id, conversationMessage.conversationId)).get();
        const metadata = {
          ...(conversationMessage.metadata && typeof conversationMessage.metadata === 'object'
            ? conversationMessage.metadata as Record<string, unknown>
            : {}),
          channelDeliveryReceipt: receipt,
        };
        const deliveryStatus = update.status === 'delivered' || update.status === 'read' ? 'delivered' : 'sent';
        this.deps.db.update(schema.conversationMessages).set({ deliveryStatus, metadata })
          .where(eq(schema.conversationMessages.id, conversationMessage.id)).run();
        if (conversation) {
          this.deps.bus.publish(
            REALTIME_ROOMS.conversation(conversation.agentId),
            REALTIME_EVENTS.CONVERSATION_MESSAGE_UPDATED,
            {
              message: { ...conversationMessage, deliveryStatus, metadata },
              conversationId: conversationMessage.conversationId,
              agentId: conversation.agentId,
            },
          );
        }
      }
      const eventPayload = {
        connectionId,
        kind: connection.kind,
        agentId: connection.agentId,
        providerMessageId: update.providerMessageId,
        status: update.status,
        providerAcknowledged: true,
        ...(update.recipient ? { resolvedRecipient: update.recipient } : {}),
      };
      this.deps.bus.publish(
        REALTIME_ROOMS.workspace(connection.workspaceId),
        REALTIME_EVENTS.CHANNEL_MESSAGE_STATUS,
        eventPayload,
      );
      if ((rank[delivery.status] ?? 0) < 2) {
        this.deps.bus.publish(
          REALTIME_ROOMS.workspace(connection.workspaceId),
          REALTIME_EVENTS.CHANNEL_MESSAGE_SENT,
          eventPayload,
        );
      }
    }
  }

  #onStateChange(connectionId: string, state: { status: string; qr?: string; selfId?: string; recovery?: WhatsAppRecoveryState }): void {
    const now = new Date().toISOString();
    const row = this.deps.db
      .select({ workspaceId: schema.channelConnections.workspaceId, kind: schema.channelConnections.kind, settings: schema.channelConnections.settings, lastError: schema.channelConnections.lastError })
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connectionId))
      .get();
    if (!row) return;
    const dbStatus: ChannelStatus = state.status === 'open' ? 'active'
      : state.status === 'logged_out' || state.status === 'error' ? 'error'
      : row.kind === 'whatsapp' ? 'needs_action' : 'verifying';
    const currentSettings = (row.settings ?? {}) as Record<string, unknown>;
    const currentHealth = isChannelHealth(currentSettings.health) ? currentSettings.health : null;
    const reconciledHealth = currentHealth ? reconcileTransportHealth(currentHealth, dbStatus, state.status, now) : null;
    const persistedStatus = reconciledHealth?.status ?? dbStatus;
    const settings: Record<string, unknown> = {
      ...currentSettings,
      transportStatus: state.status,
      ...(state.selfId ? { selfId: state.selfId } : {}),
      ...(state.recovery ? { whatsappRecovery: state.recovery } : {}),
      ...(reconciledHealth ? { health: reconciledHealth } : {}),
    };
    if (state.status === 'open') delete settings.whatsappRecovery;
    this.deps.db
      .update(schema.channelConnections)
      .set({ status: persistedStatus, settings, updatedAt: now, ...(state.status === 'open' ? { lastEventAt: now, lastError: persistedStatus === 'active' ? null : row.lastError } : {}) })
      .where(eq(schema.channelConnections.id, connectionId))
      .run();
    this.deps.bus.publish(
      REALTIME_ROOMS.workspace(row.workspaceId),
      REALTIME_EVENTS.CHANNEL_CONNECTION_STATUS,
      { connectionId, kind: row.kind, status: persistedStatus, transportStatus: state.status, ...(state.qr ? { hasQr: true } : {}) },
    );
  }
}

function isChannelHealth(value: unknown): value is ChannelHealth {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as ChannelHealth).checks));
}

export function reconcileTransportHealth(
  health: ChannelHealth,
  status: ChannelStatus,
  transportStatus: string,
  checkedAt: string,
): ChannelHealth {
  const transport: ChannelHealthCheck = transportStatus === 'open'
    ? {
        name: 'transport', ok: true, code: 'persistent_transport_open',
        message: 'Persistent channel transport is open.', checkedAt,
      }
    : {
        name: 'transport', ok: false, code: 'persistent_transport_not_open',
        message: `Persistent channel transport is ${transportStatus}.`,
        remediation: 'Relink or restart the live connection.', checkedAt,
      };
  const checks = health.checks.some((check) => check.name === 'transport')
    ? health.checks.map((check) => check.name === 'transport' ? transport : check)
    : [...health.checks, transport];
  const failed = checks.filter((check) => !check.ok && check.code !== 'not_checked');
  const effectiveStatus: ChannelStatus = status !== 'active'
    ? status
    : failed.some((check) => check.name === 'credential' || check.name === 'transport')
      ? 'error'
      : failed.length > 0
        ? 'degraded'
        : 'active';
  return { ...health, status: effectiveStatus, checks };
}
