/**
 * ChannelBridge — Batch 4 / V1-SPEC §0.3 #24, §11.
 *
 * One service per workspace process; owns the registry of `ChannelAdapter`
 * implementations keyed by `ChannelKind`. Responsibilities:
 *
 *   1. CRUD over `channel_connections` rows (via routes).
 *   2. Inbound: verify webhook signature → parse → idempotency check
 *      against `channel_deliveries.external_id` → ConversationStore.appendMirrored.
 *   3. Outbound channel replies are delivered explicitly by
 *      ChannelTurnDispatcher via `deliverToConnection`.
 *
 * Token storage: `tokenEncrypted` is AES-256-GCM ciphertext via
 * CredentialVault. Plaintext NEVER leaves the bridge — neither REST routes
 * nor bus envelopes ever expose it.
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS, artifactTypeFromMime } from '@agentis/core';
import type { CredentialVault } from '../credentialVault.js';
import type { ConversationStore } from './conversationStore.js';
import type { EventBus } from '../../event-bus.js';
import type { Logger } from '../../logger.js';
import {
  ChannelDeliveryRejectedError,
  type ChannelAdapter,
  type ChannelDeliveryReceipt,
  type ChannelHealth,
  type ChannelHealthCheck,
  type ChannelHealthCheckName,
  type ChannelKind,
  type ChannelStatus,
  type OutboundAttachment,
  type OutboundAttachmentRef,
  type OutboundMediaKind,
  type OutboundNativeContent,
  type ParsedInboundMessage,
} from '../../adapters/channels/types.js';
import type { ChannelTurnDispatcher } from './channelTurnDispatcher.js';
import type { ArtifactService } from '../artifactService.js';
import { normalizeHandle, type ChannelAccess, type ChannelRecipient } from './channelAccess.js';
import { normalizePersona, resolveHumanize, type ChannelPersona, type HumanizeConfig } from './humanize.js';
import { ChannelSendGuard } from './channelGuards.js';
import { channelCapabilities, type ChannelCapabilities } from '../../adapters/channels/channelCapabilities.js';
import type { ConversationHandoffService } from './conversationHandoffService.js';
import { isVerifiedChannelOwner } from './channelIdentityService.js';
import type { ChannelIdentityService } from './channelIdentityService.js';

export interface ChannelBridgeDeps {
  db: AgentisSqliteDb;
  vault: CredentialVault;
  conversations: ConversationStore;
  bus: EventBus;
  logger: Logger;
  /** Optional override (tests). Default: TelegramChannelAdapter + DiscordChannelAdapter. */
  adapters?: Partial<Record<ChannelKind, ChannelAdapter>>;
  /** Optional runtime probe for the configured agent. */
  runtimeHealth?: (args: { workspaceId: string; agentId: string }) => Promise<ChannelHealthCheck> | ChannelHealthCheck;
  /** Resolves outbound attachment references (artifact ids, data/http URLs) into bytes. */
  artifacts?: ArtifactService;
  /** Voice model — turns an attachment's `text` into a spoken Opus voice note. */
  speech?: { synthesize(input: { text: string; voice?: string }): Promise<{ bytes: Buffer; mimeType: string } | null> };
  handoffs?: ConversationHandoffService;
  identity?: ChannelIdentityService;
}

export interface CreateConnectionInput {
  workspaceId: string;
  ambientId: string | null;
  userId: string;
  /** Owning agent, or null/undefined for a workspace-owned (global) connection. */
  agentId?: string | null;
  kind: ChannelKind;
  name: string;
  /** Plaintext bot token. Encrypted on the way in. Omitted for QR-auth kinds (WhatsApp). */
  token?: string;
  /** Optional outbound chat id default (e.g. Telegram numeric id). */
  defaultChatId?: string;
  /** Explicit owner/operator chat. This never grants identity or tool authority. */
  ownerChatId?: string;
  /** Optional human name for the configured owner/operator chat. */
  ownerName?: string;
  /** WhatsApp Cloud uses the same address as defaultChatId but labels it for setup. */
  defaultRecipient?: string;
  /** Persistent transport: Telegram 'polling' or Discord 'gateway' (no public webhook). */
  transport?: 'polling' | 'webhook' | 'gateway';
  /** WhatsApp mode: QR/Baileys local session or official Cloud API. */
  mode?: 'qr_local' | 'cloud';
  /** Slack Events API signing secret. Encrypted in settings. */
  signingSecret?: string;
  /** WhatsApp Cloud phone number id. */
  phoneNumberId?: string;
  /** WhatsApp Cloud app secret. Encrypted in settings. */
  appSecret?: string;
  /** WhatsApp Cloud webhook verify token. Encrypted in settings. */
  verifyToken?: string;
  /** Lightweight destination aliases, e.g. { me: "+12345678901", work: "C123" }. */
  targetAliases?: Record<string, string>;
}

export interface UpdateConnectionTargetsInput {
  defaultChatId?: string | null;
  /** Explicit owner/operator chat used only for WhatsApp handoff behavior. */
  ownerChatId?: string | null;
  ownerName?: string | null;
  targetAliases?: Record<string, string | null>;
  /** Who the agent replies to, and the per-recipient/anyone rules (CHANNEL-ACCESS-10x). */
  access?: ChannelAccess | null;
}

export interface ChannelInboundMediaResolvers {
  transcribeAudio?: (bytes: Buffer, mimeType: string, workspaceId: string) => Promise<string | null>;
  describeImage?: (bytes: Buffer, mimeType: string, workspaceId: string, caption?: string) => Promise<string | null>;
  extractDocument?: (bytes: Buffer, mimeType: string, workspaceId: string, fileName?: string) => Promise<string | null>;
}

/** The only external execution signal WhatsApp may expose. Never raw reasoning. */
export type OwnerReasoningVisibility = 'off' | 'indicator';

/**
 * Stable WhatsApp behavior contract. It is persisted in `settings` so existing
 * connections migrate lazily on read/write instead of requiring a database
 * migration. Socket/browser knobs intentionally do not belong here.
 */
export interface WhatsAppConnectionProfile {
  version: 4;
  reliability: {
    sessionRecovery: true;
    classifiedReconnect: true;
    cachedProtocolVersion: true;
    durableDeliveryReconciliation: true;
    reachoutCircuitBreaker: true;
  };
  conversation: {
    typingPresence: true;
    boundedNaturalPacing: true;
    responseChunking: true;
    cancelStalePacing: true;
    mediaHandling: true;
  };
  observability: {
    structuredDiagnostics: true;
    chatSocketLogs: false;
  };
  ownerReasoningVisibility: OwnerReasoningVisibility;
  /** Applies to ordinary conversations. */
  manualOutboundTakeover: 'until_handback' | 'off';
  /** @deprecated Owner/operator conversations are always automated in v4. */
  ownerManualOutboundTakeover: 'off';
  historyReconciliation: 'recent' | 'off';
}

export const DEFAULT_WHATSAPP_CONNECTION_PROFILE: WhatsAppConnectionProfile = {
  version: 4,
  reliability: {
    sessionRecovery: true,
    classifiedReconnect: true,
    cachedProtocolVersion: true,
    durableDeliveryReconciliation: true,
    reachoutCircuitBreaker: true,
  },
  conversation: {
    typingPresence: true,
    boundedNaturalPacing: true,
    responseChunking: true,
    cancelStalePacing: true,
    mediaHandling: true,
  },
  observability: { structuredDiagnostics: true, chatSocketLogs: false },
  ownerReasoningVisibility: 'off',
  manualOutboundTakeover: 'until_handback',
  // Invariant: the configured, authenticated owner/operator conversation can
  // never be parked by last-human-responder handoff. Customer chats still can.
  ownerManualOutboundTakeover: 'off',
  historyReconciliation: 'recent',
};

/** Backward-compatible, allow-listed profile resolver for JSON connection settings. */
export function resolveWhatsAppConnectionProfile(value: unknown): WhatsAppConnectionProfile {
  const candidate = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<WhatsAppConnectionProfile>
    : null;
  return {
    ...DEFAULT_WHATSAPP_CONNECTION_PROFILE,
    ownerReasoningVisibility: candidate?.ownerReasoningVisibility === 'indicator' ? 'indicator' : 'off',
    manualOutboundTakeover: candidate?.manualOutboundTakeover === 'off' ? 'off' : 'until_handback',
    ownerManualOutboundTakeover: 'off',
    historyReconciliation: candidate?.historyReconciliation === 'off' ? 'off' : 'recent',
  };
}

/** True only for the explicit owner/operator peer — never the routing default. */
export function isConfiguredChannelOwnerChat(settings: unknown, chatId: string): boolean {
  const value = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? settings as { ownerChatId?: unknown }
    : {};
  return typeof value.ownerChatId === 'string'
    && Boolean(normalizeHandle(value.ownerChatId))
    && normalizeHandle(value.ownerChatId) === normalizeHandle(chatId);
}

/** Back-compatible export for existing WhatsApp callers. */
export const isConfiguredWhatsAppOwnerChat = isConfiguredChannelOwnerChat;

/**
 * One policy used by observed phone sends and operator-console sends. The
 * owner/operator exception is explicit; a routing default can never disable
 * handoff protection for an arbitrary customer conversation.
 */
export function shouldClaimWhatsAppManualOutbound(settings: unknown, chatId: string, verifiedOwner = false): boolean {
  const value = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? settings as { whatsappProfile?: unknown }
    : {};
  const profile = resolveWhatsAppConnectionProfile(value.whatsappProfile);
  if (profile.manualOutboundTakeover === 'off') return false;
  if (verifiedOwner) return false;
  return !isConfiguredChannelOwnerChat(settings, chatId);
}

export interface PublicConnection {
  id: string;
  workspaceId: string;
  ambientId: string | null;
  /** Owning agent, or null for a workspace-owned (global/agentless) connection. */
  agentId: string | null;
  /** App whose conversation context receives inbound turns, or null when unbound. */
  appId: string | null;
  kind: ChannelKind;
  name: string;
  status: string;
  defaultChatId: string | null;
  /** Explicit owner/operator chat for WhatsApp handoff behavior; never auto-derived. */
  ownerChatId: string | null;
  /** Optional display name supplied by the operator for model conversation context. */
  ownerName: string | null;
  targetAliases: Record<string, string>;
  access: ChannelAccess | null;
  transport: string | null;
  mode: string | null;
  transportStatus: string | null;
  /** Workspace default for this kind — deterministic sends resolve to it. */
  isDefault: boolean;
  /** Human-like pacing persona (§6). */
  persona: ChannelPersona;
  /** Anti-ban caps (§7), or null when unlimited. */
  rateLimit: { perMinute?: number; perDay?: number } | null;
  /** Require a prior inbound before cold-messaging a new contact. */
  requireOptIn: boolean;
  /** Warmup window start (ISO), or null. */
  warmupStartedAt: string | null;
  /** Versioned, allow-listed WhatsApp behavior. Null for other channels. */
  whatsappProfile: WhatsAppConnectionProfile | null;
  /** What this channel can send — media kinds, reactions, presence, etc. */
  capabilities: ChannelCapabilities;
  health: ChannelHealth;
  lastEventAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A persistent, stateful channel transport (WhatsApp socket, Telegram long-poll)
 * owned by the ChannelConnectionSupervisor. Unlike the webhook `ChannelAdapter`,
 * sends route through a live connection keyed by connectionId, not a token.
 */
export interface PersistentChannelRef {
  id: string;
  kind: string;
  workspaceId?: string;
  settings?: unknown;
}

export interface PersistentChannelTransport {
  /** True when outbound for this connection routes through a live session. */
  handles(conn: PersistentChannelRef): boolean;
  /** True when creating this kind needs no token (QR auth, e.g. WhatsApp). */
  requiresNoToken(kind: string, settings?: unknown): boolean;
  /** Post-create hook — start polling sessions (no-op for QR-login kinds). */
  onCreated?(conn: PersistentChannelRef): void;
  /** Current live-session state, if this transport owns the connection. */
  status?(connectionId: string): { status: string; qr?: string; selfId?: string } | null;
  send(connectionId: string, chatId: string, body: string, attachments?: OutboundAttachment[], humanize?: HumanizeConfig, native?: OutboundNativeContent, authority?: { actor: 'automation' | 'human'; conversationId?: string; expectedEpoch?: number }): Promise<ChannelDeliveryReceipt>;
  /** Provider account/quota diagnostics; read-only and never sends a message. */
  outboundHealth?(connectionId: string): Promise<ChannelHealthCheck | null>;
  /** Show/clear the typing indicator (best-effort). */
  setTyping?(connectionId: string, chatId: string, on: boolean): Promise<void>;
  /** Add/clear a reaction on a prior message (best-effort). */
  react?(connectionId: string, chatId: string, targetMessageId: string, emoji: string): Promise<void>;
  /** Tear down the live session when a connection is deleted. */
  stop?(connectionId: string): Promise<void>;
}

type ChannelConnectionRow = typeof schema.channelConnections.$inferSelect;
type ChannelSettings = {
  defaultChatId?: string;
  /** Explicit owner/operator chat for WhatsApp handoff behavior only. */
  ownerChatId?: string;
  ownerName?: string;
  targetAliases?: Record<string, string>;
  access?: ChannelAccess;
  transport?: 'polling' | 'webhook' | 'gateway';
  mode?: 'qr_local' | 'cloud';
  phoneNumberId?: string;
  signingSecretEncrypted?: string;
  appSecretEncrypted?: string;
  verifyTokenEncrypted?: string;
  transportStatus?: string;
  selfId?: string;
  health?: ChannelHealth;
  /** Workspace default for this KIND — the one deterministic sends (the `channel`
   *  workflow node / agentis.channel.send by kind) use when several exist. At most
   *  one connection per (workspace, kind) carries this. */
  isDefault?: boolean;
  /** Human-like outbound pacing persona (§6). Defaults to `instant`. */
  persona?: ChannelPersona;
  /** Anti-ban rails (§7). Absent = unlimited (behaviour unchanged). */
  rateLimit?: { perMinute?: number; perDay?: number };
  /** New-connection warmup ramp start (ISO); volume scales up over the window. */
  warmupStartedAt?: string;
  /** Require a prior inbound before cold-messaging a new contact. */
  requireOptIn?: boolean;
  /** Versioned WhatsApp-only behavior contract. */
  whatsappProfile?: WhatsAppConnectionProfile;
};

const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION ?? 'v20.0';
const TELEGRAM_API = 'https://api.telegram.org';

/**
 * Infer a delivery kind from a resolved MIME type when the caller didn't pin one.
 * `voice` and `sticker` are never inferred (they need an explicit caller hint —
 * a generic audio/webp file is not implicitly a voice note or sticker).
 */
function inferOutboundMediaKind(mimeType: string): OutboundMediaKind {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

/** Map an Agentis media kind to a WhatsApp Cloud API media message type. */
function whatsappCloudMediaType(kind: OutboundMediaKind): 'image' | 'video' | 'audio' | 'sticker' | 'document' {
  switch (kind) {
    case 'image': return 'image';
    case 'video': return 'video';
    case 'audio':
    case 'voice': return 'audio';
    case 'sticker': return 'sticker';
    case 'file':
    default: return 'document';
  }
}
const DEFAULT_HEALTH_CHECK_NAMES: ChannelHealthCheckName[] = ['credential', 'transport', 'outbound', 'inbound', 'runtime'];
const ME_ALIASES = new Set(['me', 'default']);

export class ChannelBridge {
  readonly #adapters: Map<ChannelKind, ChannelAdapter>;
  #turnDispatcher: ChannelTurnDispatcher | null = null;
  #persistent: PersistentChannelTransport | null = null;
  #inboundMediaResolvers: ChannelInboundMediaResolvers = {};
  /** Anti-ban rails (§7). Opt-in via connection settings; default allows all. */
  readonly #guard = new ChannelSendGuard();

  constructor(private readonly deps: ChannelBridgeDeps) {
    this.#adapters = new Map();
    if (deps.adapters?.telegram) this.#adapters.set('telegram', deps.adapters.telegram);
    if (deps.adapters?.discord) this.#adapters.set('discord', deps.adapters.discord);
    if (deps.adapters?.slack) this.#adapters.set('slack', deps.adapters.slack);
    if (deps.adapters?.voice) this.#adapters.set('voice', deps.adapters.voice);
  }

  registerAdapter(adapter: ChannelAdapter) {
    this.#adapters.set(adapter.kind, adapter);
  }

  /**
   * Wire the orchestrator turn dispatcher. Injected after the chat executor is
   * configured (bootstrap), so inbound channel messages run a real turn instead
   * of being mirrored inertly.
   */
  setTurnDispatcher(dispatcher: ChannelTurnDispatcher) {
    this.#turnDispatcher = dispatcher;
  }

  /** Wire the persistent-transport supervisor (WhatsApp etc.). */
  setPersistentTransport(transport: PersistentChannelTransport) {
    this.#persistent = transport;
  }

  /** Late-bind the voice model (constructed after the model router). */
  setSpeech(speech: ChannelBridgeDeps['speech']) {
    this.deps.speech = speech;
  }

  /** Late-bind webhook media understanding after workspace model routing exists. */
  setInboundMediaResolvers(resolvers: ChannelInboundMediaResolvers) {
    this.#inboundMediaResolvers = resolvers;
  }

  /**
   * Show/clear the typing indicator for a connection's chat. Best-effort — only
   * persistent transports with a live session support it; webhook channels no-op.
   */
  async setTyping(connectionId: string, chatId: string, on: boolean): Promise<void> {
    if (!this.#persistent?.setTyping) return;
    const row = this.deps.db
      .select({ id: schema.channelConnections.id, kind: schema.channelConnections.kind, settings: schema.channelConnections.settings })
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connectionId))
      .get();
    if (!row || !this.#persistent.handles({ id: row.id, kind: row.kind, settings: row.settings })) return;
    try {
      await this.#persistent.setTyping(connectionId, chatId, on);
    } catch {
      /* best-effort */
    }
  }

  /**
   * Add/clear a reaction (emoji, or '' to clear) on a prior message in a chat.
   * Only persistent transports with a live session support it; others no-op.
   */
  async reactToMessage(connectionId: string, chatId: string, targetMessageId: string, emoji: string): Promise<void> {
    if (!this.#persistent?.react) return;
    const row = this.deps.db
      .select({ id: schema.channelConnections.id, kind: schema.channelConnections.kind, settings: schema.channelConnections.settings })
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connectionId))
      .get();
    if (!row || !this.#persistent.handles({ id: row.id, kind: row.kind, settings: row.settings })) return;
    try {
      await this.#persistent.react(connectionId, chatId, targetMessageId, emoji);
    } catch {
      /* best-effort */
    }
  }

  /** The capability descriptor for a connection (media kinds, reactions, presence…). */
  capabilitiesFor(connectionId: string): ChannelCapabilities | null {
    const row = this.deps.db
      .select({ kind: schema.channelConnections.kind, settings: schema.channelConnections.settings })
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connectionId))
      .get();
    if (!row) return null;
    const settings = this.#settings(row);
    return channelCapabilities(row.kind as ChannelKind, settings.mode ? { whatsappMode: settings.mode } : undefined);
  }

  /**
   * Deliver an outbound message to a single connection's channel. Used by the
   * turn dispatcher to send the orchestrator's reply back to the origin chat.
   * Persistent kinds (WhatsApp) route through the live socket; webhook kinds
   * (Telegram/Discord/Slack) send via the stateless adapter + decrypted token.
   */
  async deliverToConnection(args: { connectionId: string; chatId: string; body: string; attachments?: OutboundAttachmentRef[]; native?: OutboundNativeContent; idempotencyKey?: string; bypassGuards?: boolean; pacing?: 'immediate'; actor?: 'automation' | 'human'; conversationId?: string; expectedAutomationEpoch?: number; persistOutboundContext?: boolean }): Promise<ChannelDeliveryReceipt> {
    const row = this.deps.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, args.connectionId))
      .get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `channel connection ${args.connectionId} not found`);
    const explicitConversation = args.conversationId
      ? this.deps.db.select().from(schema.conversations).where(and(
          eq(schema.conversations.workspaceId, row.workspaceId),
          eq(schema.conversations.id, args.conversationId),
        )).get()
      : null;
    if (args.conversationId && !explicitConversation) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `conversation ${args.conversationId} not found`);
    }
    if (explicitConversation?.channelConnectionId !== undefined
      && explicitConversation.channelConnectionId !== row.id) {
      throw new AgentisError('VALIDATION_FAILED', 'channel delivery conversation belongs to a different connection');
    }
    if (explicitConversation?.channelPeerIdentityId && this.deps.identity) {
      const addressedPeer = this.deps.identity.resolve(row.workspaceId, row.kind, args.chatId, row.id);
      if (!addressedPeer || addressedPeer.id !== explicitConversation.channelPeerIdentityId) {
        throw new AgentisError('VALIDATION_FAILED', 'channel delivery recipient does not match the canonical conversation peer');
      }
    }
    const targetConversation = explicitConversation
      ? { id: explicitConversation.id }
      : this.#conversationForDelivery(
          row,
          args.chatId,
          args.actor === 'human' || args.persistOutboundContext === true,
        );
    if (args.actor === 'human') {
      const verifiedOwner = isVerifiedChannelOwner(this.deps.db, {
        workspaceId: row.workspaceId,
        connectionId: row.id,
        channelKind: row.kind,
        handle: args.chatId,
      });
      const shouldClaimHuman = row.kind !== 'whatsapp'
        || shouldClaimWhatsAppManualOutbound(row.settings, args.chatId, verifiedOwner);
      if (targetConversation && shouldClaimHuman) this.deps.handoffs?.claimHuman({
        workspaceId: row.workspaceId,
        conversationId: targetConversation.id,
        source: 'explicit',
      });
    } else {
      if (args.conversationId) {
        this.deps.handoffs?.assertAutomationAllowed({
          workspaceId: row.workspaceId,
          conversationId: args.conversationId,
          ...(args.expectedAutomationEpoch !== undefined ? { expectedEpoch: args.expectedAutomationEpoch } : {}),
        });
      }
      this.deps.handoffs?.assertAutomationAllowedByChannel({
        workspaceId: row.workspaceId,
        connectionId: row.id,
        chatId: args.chatId,
        ...(!args.conversationId && args.expectedAutomationEpoch !== undefined ? { expectedEpoch: args.expectedAutomationEpoch } : {}),
      });
    }
    // §7 anti-ban rails — opt-in (default) so behaviour is unchanged until an
    // operator configures caps/opt-in. An operator cockpit send may bypass.
    if (!args.bypassGuards) {
      const guardSettings = this.#settings(row);
      const decision = this.#guard.evaluate(row.id, guardSettings, {
        isNewContact: guardSettings.requireOptIn ? !this.#hasPriorContact(row.id, args.chatId) : false,
      });
      if (!decision.ok) {
        throw new AgentisError(decision.code ?? 'CHANNEL_SEND_BLOCKED', `${decision.reason ?? 'send blocked'}${decision.remediation ? ` ${decision.remediation}` : ''}`);
      }
    }
    if (args.native && args.attachments?.length) {
      throw new AgentisError('VALIDATION_FAILED', 'send native content and file attachments as separate burst messages');
    }
    const attachments = await this.#resolveAttachments(row.workspaceId, args.attachments);
    const idempotencyKey = args.idempotencyKey?.trim() || null;
    const bodyHash = createHash('sha256')
      .update(args.chatId)
      .update('\0')
      .update(args.body)
      .update('\0')
      .update(JSON.stringify(attachments.map((attachment) => ({
        kind: attachment.kind,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        digest: createHash('sha256').update(attachment.data).digest('hex'),
      }))))
      .update('\0')
      .update(JSON.stringify(args.native ?? null))
      .digest('hex');
    const journalId = randomUUID();
    if (idempotencyKey) {
      const existing = this.deps.db
        .select()
        .from(schema.channelOutboundDeliveries)
        .where(and(
          eq(schema.channelOutboundDeliveries.workspaceId, row.workspaceId),
          eq(schema.channelOutboundDeliveries.idempotencyKey, idempotencyKey),
        ))
        .get();
      if (existing) {
        if (existing.connectionId !== row.id || existing.chatId !== args.chatId || existing.bodyHash !== bodyHash) {
          throw new AgentisError('VALIDATION_FAILED', 'channel idempotency key was reused with a different connection, recipient, or message');
        }
        const stored = existing.receipt as ChannelDeliveryReceipt | null;
        if (['accepted', 'delivered', 'read'].includes(existing.status) && stored?.providerMessageId && stored.providerAcknowledged !== false) {
          if (args.persistOutboundContext && targetConversation) {
            this.#persistProgrammaticOutboundContext({
              row,
              conversationId: targetConversation.id,
              chatId: args.chatId,
              sessionMessageId: existing.idempotencyKey,
              body: args.body,
              attachments: args.attachments,
              native: args.native,
              receipt: stored,
            });
          }
          return { ...stored, deduplicated: true, idempotencyKey };
        }
        throw new AgentisError(
          'CHANNEL_SEND_FAILED',
          `channel delivery ${idempotencyKey} already has status ${existing.status}; Agentis will not resend an uncertain/failed attempt automatically`,
        );
      }
    }
    // Journal every provider-bound attempt, not only workflow-idempotent ones.
    // Direct agent/tool sends also need a durable correlation row so an async
    // WhatsApp acknowledgement can promote queued -> accepted/delivered/read.
    const journalKey = idempotencyKey ?? `attempt:${journalId}`;
    this.deps.db.insert(schema.channelOutboundDeliveries).values({
      id: journalId,
      workspaceId: row.workspaceId,
      connectionId: row.id,
      idempotencyKey: journalKey,
      chatId: args.chatId,
      bodyHash,
      status: 'sending',
    }).run();
    const outboundContext = args.persistOutboundContext && targetConversation
      ? this.#persistProgrammaticOutboundContext({
          row,
          conversationId: targetConversation.id,
          chatId: args.chatId,
          sessionMessageId: journalKey,
          body: args.body,
          attachments: args.attachments,
          native: args.native,
          deliveryStatus: 'sending',
        })
      : null;
    try {
      if (args.actor !== 'human') {
        if (args.conversationId) this.deps.handoffs?.assertAutomationAllowed({
          workspaceId: row.workspaceId,
          conversationId: args.conversationId,
          ...(args.expectedAutomationEpoch !== undefined ? { expectedEpoch: args.expectedAutomationEpoch } : {}),
        });
        this.deps.handoffs?.assertAutomationAllowedByChannel({
          workspaceId: row.workspaceId,
          connectionId: row.id,
          chatId: args.chatId,
        });
      }
      const receipt = await this.#sendRow(row, args.chatId, args.body, attachments, args.pacing, args.native, {
        actor: args.actor === 'human' ? 'human' : 'automation',
        ...(args.conversationId ? { conversationId: args.conversationId } : {}),
        ...(args.expectedAutomationEpoch !== undefined ? { expectedEpoch: args.expectedAutomationEpoch } : {}),
      });
      if (!receipt.providerMessageId?.trim()) {
        throw new AgentisError('CHANNEL_SEND_FAILED', `${row.kind} returned no provider message id; delivery is unverified`);
      }
      this.#markActive(row.id);
      this.#guard.record(row.id);
      const durableReceipt = idempotencyKey ? { ...receipt, idempotencyKey } : receipt;
      this.deps.db.update(schema.channelOutboundDeliveries).set({
        status: receipt.status,
        providerMessageId: receipt.providerMessageId,
        receipt: durableReceipt,
        error: null,
        updatedAt: new Date().toISOString(),
      }).where(eq(schema.channelOutboundDeliveries.id, journalId)).run();
      if (outboundContext) {
        this.deps.conversations.updateDeliveryStatus({
          workspaceId: row.workspaceId,
          conversationId: targetConversation!.id,
          messageId: outboundContext.id,
          deliveryStatus: receipt.status === 'delivered' || receipt.status === 'read' ? 'delivered' : 'sent',
          metadata: { channelDeliveryReceipt: durableReceipt, providerMessageId: receipt.providerMessageId },
        });
      }
      const eventPayload = {
        connectionId: row.id,
        kind: row.kind,
        agentId: row.agentId,
        providerMessageId: receipt.providerMessageId,
        status: receipt.status,
        providerAcknowledged: receipt.providerAcknowledged !== false,
        requestedRecipient: receipt.requestedRecipient ?? args.chatId,
        resolvedRecipient: receipt.resolvedRecipient ?? receipt.recipient ?? args.chatId,
      };
      this.deps.bus.publish(
        REALTIME_ROOMS.workspace(row.workspaceId),
        REALTIME_EVENTS.CHANNEL_MESSAGE_STATUS,
        eventPayload,
      );
      if (receipt.status !== 'queued' && receipt.providerAcknowledged !== false) {
        this.deps.bus.publish(
          REALTIME_ROOMS.workspace(row.workspaceId),
          REALTIME_EVENTS.CHANNEL_MESSAGE_SENT,
          eventPayload,
        );
      }
      return durableReceipt;
    } catch (err) {
      const msg = (err as Error).message ?? 'send failed';
      const ownershipCancelled = err instanceof AgentisError
        && (err.code === 'CHANNEL_HUMAN_TAKEOVER_ACTIVE' || err.code === 'TURN_CANCELLED');
      const providerRejected = err instanceof ChannelDeliveryRejectedError;
      // A provider rejection is certain and retryable only after remediation.
      // A transport exception remains uncertain because the message may have
      // crossed the provider boundary before the failure became visible.
      this.deps.db.update(schema.channelOutboundDeliveries).set({
        status: providerRejected || ownershipCancelled ? 'failed' : 'uncertain',
        ...(providerRejected ? { providerMessageId: err.providerMessageId } : {}),
        error: msg,
        updatedAt: new Date().toISOString(),
      }).where(eq(schema.channelOutboundDeliveries.id, journalId)).run();
      if (outboundContext) {
        this.deps.conversations.updateDeliveryStatus({
          workspaceId: row.workspaceId,
          conversationId: targetConversation!.id,
          messageId: outboundContext.id,
          deliveryStatus: 'failed',
          metadata: { channelDeliveryError: msg },
        });
      }
      if (ownershipCancelled) {
        // The provider boundary was never crossed. This is expected arbitration,
        // not a transport failure and must not poison connection health.
      } else if (providerRejected) {
        // A recipient/account policy rejection does not mean the live socket is
        // broken. Keep established conversations usable and expose the failure
        // through outbound health instead of flipping transport status to error.
        this.deps.db.update(schema.channelConnections).set({
          lastError: msg,
          updatedAt: new Date().toISOString(),
        }).where(eq(schema.channelConnections.id, row.id)).run();
      } else {
        this.#markError(row.id, msg);
      }
      throw err;
    }
  }

  hasAdapter(kind: ChannelKind): boolean {
    return this.#adapters.has(kind);
  }

  /**
   * Constant-time check of a presented voice secret against a voice connection's
   * shared secret (G6). Used by the voice reply-retrieval route so a provider can
   * authenticate when fetching the buffered reply. Returns false for a missing
   * connection or a non-voice kind.
   */
  verifyVoiceSecret(connectionId: string, presented: string): boolean {
    const row = this.deps.db
      .select({ kind: schema.channelConnections.kind, webhookSecret: schema.channelConnections.webhookSecret })
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connectionId))
      .get();
    if (!row || row.kind !== 'voice' || !row.webhookSecret) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(row.webhookSecret);
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  shutdown() {}

  // ── CRUD ────────────────────────────────────────────────

  list(workspaceId: string): PublicConnection[] {
    const rows = this.deps.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.workspaceId, workspaceId))
      .orderBy(desc(schema.channelConnections.createdAt))
      .all();
    return rows.map((r) => this.#toPublic(r));
  }

  get(workspaceId: string, id: string): PublicConnection {
    const row = this.deps.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, id))
      .get();
    if (!row || row.workspaceId !== workspaceId) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `channel connection ${id} not found`);
    }
    return this.#toPublic(row);
  }

  /**
   * Bind a channel to an App's conversation context, or clear the binding.
   * Both resources are workspace-scoped. Existing channel conversations are
   * reconciled immediately so the next turn cannot retain stale App context.
   */
  bindApp(workspaceId: string, id: string, appId: string | null): PublicConnection {
    const row = this.#row(workspaceId, id);
    if (appId) {
      const app = this.deps.db
        .select({ id: schema.apps.id })
        .from(schema.apps)
        .where(and(eq(schema.apps.id, appId), eq(schema.apps.workspaceId, workspaceId)))
        .get();
      if (!app) throw new AgentisError('RESOURCE_NOT_FOUND', `app ${appId} not found`);
    }
    const now = new Date().toISOString();
    this.deps.db.update(schema.channelConnections)
      .set({ appId, updatedAt: now })
      .where(eq(schema.channelConnections.id, row.id))
      .run();
    this.deps.db.update(schema.conversations)
      .set({ appId, updatedAt: now })
      .where(and(
        eq(schema.conversations.workspaceId, workspaceId),
        eq(schema.conversations.channelConnectionId, row.id),
      ))
      .run();
    return this.get(workspaceId, id);
  }

  create(input: CreateConnectionInput): { connection: PublicConnection; webhookSecret: string } {
    const id = randomUUID();
    const settings: ChannelSettings = {};
    const defaultTarget = input.defaultChatId ?? input.defaultRecipient;
    if (defaultTarget) settings.defaultChatId = this.#normalizeTargetForKind(input.kind, defaultTarget);
    if (input.ownerChatId) settings.ownerChatId = this.#normalizeTargetForKind(input.kind, input.ownerChatId);
    if (input.ownerName?.trim()) settings.ownerName = input.ownerName.trim().slice(0, 120);
    if (input.transport) settings.transport = input.transport;
    if (input.kind === 'telegram' && !settings.transport && !this.#publicWebhookUrl(id)) settings.transport = 'polling';
    if (input.kind === 'whatsapp') {
      settings.mode = input.mode ?? 'qr_local';
      settings.whatsappProfile = DEFAULT_WHATSAPP_CONNECTION_PROFILE;
    }
    if (input.targetAliases) settings.targetAliases = this.#normalizeAliases(input.kind, input.targetAliases);
    if (input.signingSecret) settings.signingSecretEncrypted = this.deps.vault.encrypt(input.signingSecret);
    if (input.phoneNumberId) settings.phoneNumberId = input.phoneNumberId;
    if (input.appSecret) settings.appSecretEncrypted = this.deps.vault.encrypt(input.appSecret);
    if (input.verifyToken) settings.verifyTokenEncrypted = this.deps.vault.encrypt(input.verifyToken);
    settings.health = this.#initialHealth(input.kind, settings);
    const ref = { id, kind: input.kind, workspaceId: input.workspaceId, settings };
    // Voice (G6) authenticates inbound webhooks with its auto-generated per-
    // connection webhookSecret — there is no external bot token to require.
    const noToken = input.kind === 'voice' || (this.#persistent?.requiresNoToken(input.kind, settings) ?? false);
    const persistent = this.#persistent?.handles(ref) ?? false;
    // A connection must be deliverable: either via a live persistent session, a
    // registered webhook adapter, or QR auth (which needs no token at all).
    if (!noToken && !persistent && !this.#adapters.has(input.kind) && !this.#isWhatsAppCloud(input.kind, settings)) {
      throw new AgentisError(
        'CHANNEL_KIND_UNAVAILABLE',
        `channel adapter for kind '${input.kind}' is not registered`,
      );
    }
    // QR-auth kinds (WhatsApp) link via QR, not a bot token; everything else
    // (including Telegram polling, which uses the bot token) requires one.
    if (!noToken && !input.token) {
      throw new AgentisError('VALIDATION_FAILED', `channel kind '${input.kind}' requires a token`);
    }
    if (this.#isWhatsAppCloud(input.kind, settings)) {
      if (!input.token || !settings.phoneNumberId || !settings.appSecretEncrypted || !settings.verifyTokenEncrypted) {
        throw new AgentisError(
          'VALIDATION_FAILED',
          'WhatsApp Cloud requires access token, phone number ID, app secret, and verify token',
        );
      }
    }
    // A specific owning agent must belong to the workspace; null = workspace-owned.
    const ownerAgentId = input.agentId ?? null;
    if (ownerAgentId) {
      const agent = this.deps.db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.id, ownerAgentId))
        .get();
      if (!agent || agent.workspaceId !== input.workspaceId) {
        throw new AgentisError('RESOURCE_NOT_FOUND', `agent ${ownerAgentId} not found`);
      }
    }
    const webhookSecret = randomBytes(24).toString('hex');
    // tokenEncrypted is NOT NULL; QR-auth kinds store an encrypted marker.
    const tokenPlain = input.token ?? `persistent:${input.kind}:${id}`;
    const initialStatus: ChannelStatus = input.kind === 'whatsapp' && settings.mode !== 'cloud'
      ? 'needs_action'
      : 'verifying';
    this.deps.db
      .insert(schema.channelConnections)
      .values({
        id,
        workspaceId: input.workspaceId,
        ambientId: input.ambientId,
        userId: input.userId,
        agentId: ownerAgentId,
        kind: input.kind,
        name: input.name,
        tokenEncrypted: this.deps.vault.encrypt(tokenPlain),
        webhookSecret,
        settings,
        status: initialStatus,
        lastEventAt: null,
        lastError: null,
      })
      .run();
    this.deps.identity?.syncConfiguredOwner({
      workspaceId: input.workspaceId,
      connectionId: id,
      channelKind: input.kind,
      handle: settings.ownerChatId ?? null,
      userId: input.userId,
      displayName: settings.ownerName ?? null,
    });
    // Start polling sessions immediately (WhatsApp links via explicit QR login).
    this.#persistent?.onCreated?.(ref);
    const connection = this.get(input.workspaceId, id);
    return { connection, webhookSecret };
  }

  /**
   * Designate (or clear) the workspace DEFAULT connection for its kind — the one
   * deterministic sends resolve to when several connections of that kind exist.
   * Setting a default clears the flag on every sibling of the same kind, so the
   * (workspace, kind) → default invariant holds. Passing `isDefault:false` clears
   * it, leaving no default for that kind.
   */
  setDefault(workspaceId: string, id: string, isDefault: boolean): PublicConnection {
    const row = this.#row(workspaceId, id); // 404s if missing / wrong workspace
    const now = new Date().toISOString();
    if (isDefault) {
      // Clear the flag on all other connections of the same kind first.
      const siblings = this.deps.db
        .select()
        .from(schema.channelConnections)
        .where(and(eq(schema.channelConnections.workspaceId, workspaceId), eq(schema.channelConnections.kind, row.kind)))
        .all();
      for (const s of siblings) {
        if (s.id === id) continue;
        const ss = this.#settings(s);
        if (ss.isDefault) {
          this.deps.db.update(schema.channelConnections)
            .set({ settings: { ...ss, isDefault: false }, updatedAt: now })
            .where(eq(schema.channelConnections.id, s.id)).run();
        }
      }
    }
    this.deps.db.update(schema.channelConnections)
      .set({ settings: { ...this.#settings(row), isDefault }, updatedAt: now })
      .where(eq(schema.channelConnections.id, id)).run();
    return this.get(workspaceId, id);
  }

  /** The default connection id for a kind: the explicitly-flagged one (honored
   *  regardless of live status — a down default still fails loudly at delivery,
   *  not as "ambiguous"), else the sole ACTIVE one so a single-connection
   *  workspace needs no explicit default, else null (ambiguous). */
  defaultConnectionFor(workspaceId: string, kind: string): string | null {
    const ofKind = this.list(workspaceId).filter((c) => c.kind === kind);
    const flagged = ofKind.find((c) => c.isDefault);
    if (flagged) return flagged.id;
    const active = ofKind.filter((c) => c.status === 'active');
    return active.length === 1 ? active[0]!.id : null;
  }

  updateTargets(workspaceId: string, id: string, input: UpdateConnectionTargetsInput): PublicConnection {
    const row = this.#row(workspaceId, id);
    const settings = { ...this.#settings(row) };
    // Any behavior save upgrades legacy WhatsApp rows to the explicit v3 profile.
    if (row.kind === 'whatsapp') settings.whatsappProfile = resolveWhatsAppConnectionProfile(settings.whatsappProfile);
    if ('defaultChatId' in input) {
      const target = input.defaultChatId?.trim();
      if (target) settings.defaultChatId = this.#normalizeTargetForKind(row.kind as ChannelKind, target);
      else delete settings.defaultChatId;
    }
    if ('ownerChatId' in input) {
      const ownerTarget = input.ownerChatId?.trim();
      if (ownerTarget) settings.ownerChatId = this.#normalizeTargetForKind(row.kind as ChannelKind, ownerTarget);
      else delete settings.ownerChatId;
    }
    if ('ownerName' in input) {
      const ownerName = input.ownerName?.trim();
      if (ownerName) settings.ownerName = ownerName.slice(0, 120);
      else delete settings.ownerName;
    }
    if (input.targetAliases) {
      const targetAliases = { ...(settings.targetAliases ?? {}) };
      for (const [rawAlias, rawTarget] of Object.entries(input.targetAliases)) {
        const alias = this.#normalizeAlias(rawAlias);
        if (!alias) continue;
        const target = rawTarget?.trim();
        if (target) targetAliases[alias] = this.#normalizeTargetForKind(row.kind as ChannelKind, target);
        else delete targetAliases[alias];
      }
      settings.targetAliases = targetAliases;
    }
    if ('access' in input) {
      if (!input.access) {
        delete settings.access;
      } else {
        const recipients = (input.access.recipients ?? [])
          .map((r): ChannelRecipient => ({
            handle: (r.handle ?? '').trim(),
            ...(r.name?.trim() ? { name: r.name.trim() } : {}),
            ...(r.rules?.trim() ? { rules: r.rules.trim() } : {}),
          }))
          .filter((r) => r.handle.length > 0);
        settings.access = {
          recipients,
          answerAnyone: Boolean(input.access.answerAnyone),
          ...(input.access.anyoneRules?.trim() ? { anyoneRules: input.access.anyoneRules.trim() } : {}),
          ...(input.access.unknownReply ? { unknownReply: input.access.unknownReply } : {}),
        };
      }
    }
    this.deps.db
      .update(schema.channelConnections)
      .set({ settings, updatedAt: new Date().toISOString() })
      .where(eq(schema.channelConnections.id, row.id))
      .run();
    this.deps.identity?.syncConfiguredOwner({
      workspaceId,
      connectionId: row.id,
      channelKind: row.kind,
      handle: settings.ownerChatId ?? null,
      userId: row.userId,
      displayName: settings.ownerName ?? null,
    });
    return this.get(workspaceId, id);
  }

  /**
   * Update the human-like persona (§6) and anti-ban rails (§7) for a connection.
   * All fields are optional; only the provided ones are merged. `rateLimit:null`
   * clears the caps; `startWarmup` stamps/clears the warmup window.
   */
  updateBehavior(workspaceId: string, id: string, input: {
    persona?: ChannelPersona;
    rateLimit?: { perMinute?: number | null; perDay?: number | null } | null;
    requireOptIn?: boolean;
    startWarmup?: boolean;
    ownerReasoningVisibility?: OwnerReasoningVisibility;
    manualOutboundTakeover?: 'until_handback' | 'off';
    ownerManualOutboundTakeover?: 'until_handback' | 'off';
    historyReconciliation?: 'recent' | 'off';
  }): PublicConnection {
    const row = this.#row(workspaceId, id);
    const settings = { ...this.#settings(row) };
    if (input.persona) settings.persona = normalizePersona(input.persona);
    if (input.rateLimit === null) {
      delete settings.rateLimit;
    } else if (input.rateLimit) {
      const rl: { perMinute?: number; perDay?: number } = {};
      if (typeof input.rateLimit.perMinute === 'number' && input.rateLimit.perMinute > 0) rl.perMinute = Math.floor(input.rateLimit.perMinute);
      if (typeof input.rateLimit.perDay === 'number' && input.rateLimit.perDay > 0) rl.perDay = Math.floor(input.rateLimit.perDay);
      if (Object.keys(rl).length > 0) settings.rateLimit = rl; else delete settings.rateLimit;
    }
    if (typeof input.requireOptIn === 'boolean') settings.requireOptIn = input.requireOptIn;
    if (input.startWarmup === true) settings.warmupStartedAt = new Date().toISOString();
    else if (input.startWarmup === false) delete settings.warmupStartedAt;
    if (input.ownerReasoningVisibility !== undefined || input.manualOutboundTakeover !== undefined || input.ownerManualOutboundTakeover !== undefined || input.historyReconciliation !== undefined) {
      if (row.kind !== 'whatsapp') {
        throw new AgentisError('VALIDATION_FAILED', 'WhatsApp profile behavior is available only for WhatsApp');
      }
      settings.whatsappProfile = {
        ...resolveWhatsAppConnectionProfile(settings.whatsappProfile),
        ...(input.ownerReasoningVisibility !== undefined ? { ownerReasoningVisibility: input.ownerReasoningVisibility } : {}),
        ...(input.manualOutboundTakeover !== undefined ? { manualOutboundTakeover: input.manualOutboundTakeover } : {}),
        // Kept in the input for wire compatibility with v3 clients. In v4 an
        // explicitly configured operator conversation can never be parked.
        ownerManualOutboundTakeover: 'off',
        ...(input.historyReconciliation !== undefined ? { historyReconciliation: input.historyReconciliation } : {}),
      };
    }
    this.deps.db
      .update(schema.channelConnections)
      .set({ settings, updatedAt: new Date().toISOString() })
      .where(eq(schema.channelConnections.id, row.id))
      .run();
    return this.get(workspaceId, id);
  }

  delete(workspaceId: string, id: string): void {
    const existing = this.get(workspaceId, id); // 404s if not found
    const row = this.deps.db
      .select({ settings: schema.channelConnections.settings })
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, existing.id))
      .get();
    if (this.#persistent?.handles({ id: existing.id, kind: existing.kind, settings: row?.settings })) {
      void this.#persistent.stop?.(existing.id);
    }
    this.deps.db
      .delete(schema.channelConnections)
      .where(eq(schema.channelConnections.id, existing.id))
      .run();
  }

  /**
   * Run read-only provider checks and persist structured health. A health test
   * never sends a message: external delivery belongs to the explicit send path
   * and must produce its own provider acknowledgement evidence.
   */
  async test(args: { workspaceId: string; id: string; chatId?: string; body?: string }): Promise<ChannelHealth> {
    const row = this.#row(args.workspaceId, args.id);
    const checks = await this.#runHealthChecks(row, {
      chatId: args.chatId,
    });
    return this.#saveHealth(row, checks);
  }

  health(workspaceId: string, id: string): ChannelHealth {
    const row = this.#row(workspaceId, id);
    return this.#healthFromRow(row);
  }

  resolveDestination(args: { connectionId: string; to?: string | null }): { chatId: string | null; source: 'default' | 'alias' | 'explicit' | 'missing' } {
    const row = this.deps.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, args.connectionId))
      .get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `channel connection ${args.connectionId} not found`);
    const settings = this.#settings(row);
    const requested = args.to?.trim() ?? '';
    if (!requested || ME_ALIASES.has(requested.toLowerCase())) {
      return settings.defaultChatId
        ? { chatId: settings.defaultChatId, source: 'default' }
        : { chatId: null, source: 'missing' };
    }
    const alias = this.#normalizeAlias(requested);
    const aliased = alias ? settings.targetAliases?.[alias] : undefined;
    if (aliased) return { chatId: aliased, source: 'alias' };
    return { chatId: this.#normalizeTargetForKind(row.kind as ChannelKind, requested), source: 'explicit' };
  }

  handleWebhookVerification(args: {
    connectionId: string;
    query: Record<string, string | undefined>;
  }): { ok: true; body: string; contentType?: string } {
    const row = this.deps.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, args.connectionId))
      .get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `channel connection ${args.connectionId} not found`);
    const settings = this.#settings(row);
    if (this.#isWhatsAppCloud(row.kind as ChannelKind, settings)) {
      const expected = settings.verifyTokenEncrypted ? this.deps.vault.decrypt(settings.verifyTokenEncrypted) : '';
      const mode = args.query['hub.mode'];
      const token = args.query['hub.verify_token'];
      const challenge = args.query['hub.challenge'];
      if (mode === 'subscribe' && token && token === expected && challenge) {
        return { ok: true, body: challenge, contentType: 'text/plain; charset=utf-8' };
      }
      throw new AgentisError('CHANNEL_SIGNATURE_INVALID', 'WhatsApp webhook verify token did not match');
    }
    throw new AgentisError('VALIDATION_FAILED', `${row.kind} does not use GET webhook verification`);
  }

  // ── Inbound webhook ────────────────────────────────────

  /**
   * Handle a webhook delivery for a connection. Returns `{ accepted, idempotent }`.
   * Throws AgentisError(`UNAUTHENTICATED`) on signature failure.
   */
  async handleInbound(args: {
    connectionId: string;
    headers: Record<string, string | undefined>;
    rawBody: string;
  }): Promise<{ accepted: boolean; idempotent: boolean; messageId?: string; responseBody?: unknown; statusCode?: number }> {
    const row = this.deps.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, args.connectionId))
      .get();
    if (!row) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `channel connection ${args.connectionId} not found`);
    }
    if (row.status === 'paused') {
      throw new AgentisError('CHANNEL_CONNECTION_INACTIVE', `connection ${row.id} is not active`);
    }
    const adapter = this.#isWhatsAppCloud(row.kind as ChannelKind, this.#settings(row)) ? null : this.#requireAdapter(row.kind as ChannelKind);
    const secret = this.#webhookVerificationSecret(row);
    const ok = this.#verifyInbound(row, args.headers, args.rawBody, secret);
    if (!ok) {
      this.#markError(row.id, 'webhook signature verification failed');
      throw new AgentisError('CHANNEL_SIGNATURE_INVALID', 'channel webhook signature verification failed');
    }

    const challenge = this.#maybeProviderChallenge(row, args.rawBody);
    if (challenge) {
      this.#markActive(row.id);
      return { accepted: true, idempotent: false, responseBody: challenge, statusCode: 200 };
    }

    const parsed = adapter
      ? adapter.parseInbound({ rawBody: args.rawBody, headers: args.headers })
      : this.#parseWhatsAppCloudInbound(args.rawBody);
    if (!parsed) {
      this.#markActive(row.id);
      return { accepted: false, idempotent: false };
    }

    // Idempotency: same externalId already processed → return last result.
    const dup = this.deps.db
      .select()
      .from(schema.channelDeliveries)
      .where(and(
        eq(schema.channelDeliveries.connectionId, row.id),
        eq(schema.channelDeliveries.externalId, parsed.externalId),
      ))
      .get();
    if (dup) {
      const result: { accepted: boolean; idempotent: boolean; messageId?: string } = {
        accepted: true,
        idempotent: true,
      };
      if (dup.conversationMessageId) result.messageId = dup.conversationMessageId;
      return result;
    }

    if (parsed.media) {
      parsed.body = await this.#enrichWebhookMedia(row, parsed).catch((err) => {
        this.deps.logger.warn('channel.webhook_media_enrichment_failed', {
          connectionId: row.id,
          kind: row.kind,
          err: (err as Error).message,
        });
        return parsed.body;
      });
    }

    this.#rememberDefaultChat(row, parsed.chatId);

    // A workspace-owned (null-agent) connection routes inbound to the orchestrator
    // — the workspace's front door — which then handles or delegates.
    const inboundAgentId = row.agentId ?? this.#resolveInboundAgentId(row.workspaceId);
    if (!inboundAgentId) {
      this.#markActive(row.id);
      return { accepted: false, idempotent: false };
    }
    const peer = this.deps.identity?.observeAliases({
      workspaceId: row.workspaceId,
      connectionId: row.id,
      channelKind: row.kind,
      primaryHandle: parsed.chatId,
      ...(parsed.from ? { displayName: parsed.from } : {}),
      source: 'webhook_inbound',
      countMessage: false,
    });
    const conversation = this.deps.conversations.getOrCreateByChannel({
      workspaceId: row.workspaceId,
      ambientId: row.ambientId,
      userId: row.userId,
      agentId: inboundAgentId,
      channelConnectionId: row.id,
      channelChatId: parsed.chatId,
      channelPeerIdentityId: peer?.id ?? null,
      appId: row.appId ?? null,
    });
    const fromTag = parsed.from ? `[${parsed.from}] ` : '';
    const message = this.deps.conversations.appendMirrored({
      workspaceId: row.workspaceId,
      conversationId: conversation.id,
      sessionMessageId: parsed.externalId,
      authorType: 'system',
      participantSide: 'customer',
      body: `${fromTag}${parsed.body}`,
      metadata: {
        channel: row.kind,
        channelConnectionId: row.id,
        channelInbound: true,
        ...(parsed.threadId ? { threadId: parsed.threadId } : {}),
        ...(parsed.from ? { from: parsed.from } : {}),
      },
    });
    this.deps.db
      .insert(schema.channelDeliveries)
      .values({
        id: randomUUID(),
        connectionId: row.id,
        workspaceId: row.workspaceId,
        externalId: parsed.externalId,
        conversationMessageId: message.id,
      })
      .run();
    this.#markActive(row.id);
    this.deps.bus.publish(REALTIME_ROOMS.workspace(row.workspaceId), REALTIME_EVENTS.CHANNEL_MESSAGE_RECEIVED, {
      connectionId: row.id,
      kind: row.kind,
      agentId: row.agentId,
      chatId: parsed.chatId,
      messageId: message.id,
    });

    // Run a real orchestrator turn for this message and deliver the reply back
    // to the channel. Fire-and-forget so the webhook gets its fast ack while the
    // (potentially slow) turn runs in the background.
    if (this.#turnDispatcher) {
      void this.#turnDispatcher.dispatch({
        workspaceId: row.workspaceId,
        ambientId: row.ambientId,
        userId: row.userId,
        agentId: inboundAgentId,
        appId: row.appId ?? null,
        conversationId: conversation.id,
        connectionId: row.id,
        kind: row.kind,
        chatId: parsed.chatId,
        text: parsed.body,
        ...(parsed.threadId ? { threadId: parsed.threadId } : {}),
        ...(parsed.from ? { from: parsed.from } : {}),
        inboundMessageId: message.id,
      });
    }

    return { accepted: true, idempotent: false, messageId: message.id };
  }

  // ── Outbound forwarding ─────────────────────────────────

  // ── helpers ─────────────────────────────────────────────

  async #runHealthChecks(row: ChannelConnectionRow, opts: { chatId?: string }): Promise<ChannelHealthCheck[]> {
    const settings = this.#settings(row);
    const checks: ChannelHealthCheck[] = [];
    checks.push(await this.#credentialCheck(row, settings));
    checks.push(await this.#transportCheck(row, settings));
    checks.push(await this.#outboundCheck(row, settings, opts));
    checks.push(this.#inboundCheck(row, settings));
    checks.push(await this.#runtimeCheck(row));
    return this.#dedupeChecks(checks);
  }

  async #credentialCheck(row: ChannelConnectionRow, settings: ChannelSettings): Promise<ChannelHealthCheck> {
    if (row.kind === 'whatsapp' && settings.mode !== 'cloud') {
      return this.#check('credential', true, 'whatsapp_qr_auth_local', 'WhatsApp QR auth is stored in the local live session.');
    }
    if (this.#isWhatsAppCloud(row.kind as ChannelKind, settings)) {
      if (!settings.phoneNumberId) {
        return this.#check('credential', false, 'missing_phone_number_id', 'WhatsApp Cloud phone number ID is missing.', 'Add the phone number ID from Meta Business Manager.');
      }
      return this.#check('credential', true, 'whatsapp_cloud_fields_present', 'WhatsApp Cloud credentials are present.');
    }
    const token = this.deps.vault.decrypt(row.tokenEncrypted);
    const adapter = this.#requireAdapter(row.kind as ChannelKind);
    if (!adapter.probeCredential) {
      return this.#check('credential', true, `${row.kind}_credential_probe_unavailable`, `${row.kind} credentials are present.`);
    }
    try {
      return await adapter.probeCredential({ token, settings: settings as Record<string, unknown> });
    } catch (err) {
      return this.#check(
        'credential',
        false,
        `${row.kind}_credential_probe_error`,
        (err as Error).message || `${row.kind} credential probe failed.`,
        'Check the saved token and retry.',
      );
    }
  }

  async #transportCheck(row: ChannelConnectionRow, settings: ChannelSettings): Promise<ChannelHealthCheck> {
    if (this.#persistent?.handles({ id: row.id, kind: row.kind, settings })) {
      // Never trust a persisted pre-restart status as live socket evidence.
      const state = this.#persistent.status?.(row.id) ?? { status: 'idle' };
      if (state.status === 'open') {
        return this.#check('transport', true, 'persistent_transport_open', `${row.kind} live transport is open.`);
      }
      const remediation = row.kind === 'whatsapp'
        ? 'Open WhatsApp Linked Devices, scan a fresh QR, and keep the local Agentis process running.'
        : row.kind === 'discord'
          ? 'Confirm the bot token, gateway intents, and restart the connection.'
          : 'Retry the connection and make sure polling can start.';
      return this.#check(
        'transport',
        false,
        'persistent_transport_not_open',
        `${row.kind} live transport is ${state.status}.`,
        remediation,
      );
    }

    if (this.#isWhatsAppCloud(row.kind as ChannelKind, settings)) {
      return this.#check('transport', true, 'whatsapp_cloud_api_ready', 'WhatsApp Cloud API transport is configured for outbound REST sends.');
    }

    if (row.kind === 'discord' && settings.transport !== 'gateway') {
      return this.#check('transport', true, 'discord_rest_ready', 'Discord REST transport is configured for outbound messages.');
    }

    const publicUrl = this.#publicWebhookUrl(row.id);
    if (!publicUrl) {
      return this.#check(
        'transport',
        false,
        'missing_public_url',
        `${row.kind} webhook transport needs AGENTIS_PUBLIC_URL.`,
        row.kind === 'telegram' ? 'Set AGENTIS_PUBLIC_URL or switch Telegram to long polling.' : 'Set AGENTIS_PUBLIC_URL and configure the provider webhook to the displayed URL.',
      );
    }
    const adapter = this.#requireAdapter(row.kind as ChannelKind);
    if (!adapter.configureTransport) {
      return this.#check('transport', true, `${row.kind}_webhook_url_available`, `${row.kind} webhook URL is available.`);
    }
    try {
      const token = this.deps.vault.decrypt(row.tokenEncrypted);
      return await adapter.configureTransport({
        token,
        webhookUrl: publicUrl,
        secret: row.webhookSecret,
        transport: settings.transport ?? 'webhook',
      });
    } catch (err) {
      return this.#check(
        'transport',
        false,
        `${row.kind}_transport_probe_error`,
        (err as Error).message || `${row.kind} transport probe failed.`,
        'Check provider webhook configuration and retry.',
      );
    }
  }

  async #outboundCheck(
    row: ChannelConnectionRow,
    settings: ChannelSettings,
    opts: { chatId?: string },
  ): Promise<ChannelHealthCheck> {
    let persistentProviderHealth: ChannelHealthCheck | null = null;
    if (row.kind === 'whatsapp'
      && this.#persistent?.handles({ id: row.id, kind: row.kind, settings })
      && this.#persistent.outboundHealth) {
      persistentProviderHealth = await this.#persistent.outboundHealth(row.id);
      if (!persistentProviderHealth) {
        return this.#check(
          'outbound',
          false,
          'outbound_transport_not_live',
          'The persistent WhatsApp session is not live yet, so outbound capability cannot be verified.',
          'Wait for the linked session to open or relink it, then run the read-only Channel Test again.',
        );
      }
      if (persistentProviderHealth && (!persistentProviderHealth.ok || (!opts.chatId && !settings.defaultChatId))) return persistentProviderHealth;
    }
    const chatId = opts.chatId ?? settings.defaultChatId;
    if (!chatId) {
      if (row.kind === 'whatsapp' && settings.mode !== 'cloud') {
        const state = this.#persistent?.status?.(row.id) ?? { status: 'idle' };
        if (state.status === 'open') {
          return this.#check(
            'outbound',
            true,
            'outbound_ready_for_explicit_recipient',
            'WhatsApp QR can send to explicit phone numbers or JIDs. No default recipient is saved yet.',
            'Save a default recipient only if you want requests like "send this to default target" to work without a number.',
          );
        }
      }
      const remediation = row.kind === 'telegram'
        ? 'Send /start to the bot, then save the numeric chat ID or wait for Agentis to record the first inbound chat.'
        : row.kind === 'whatsapp'
          ? 'Save a default recipient number/JID or send the agent a message so Agentis can record it.'
          : row.kind === 'slack'
            ? 'Save a default Slack channel ID, then invite the bot to that channel.'
            : 'Save a default Discord channel ID the bot can send to.';
      return this.#check('outbound', false, 'missing_default_target', 'No default destination is configured for outbound tests.', remediation);
    }
    try {
      const normalized = this.#normalizeTargetForKind(row.kind as ChannelKind, chatId);
      const selfCheck = await this.#telegramSelfTargetCheck(row, normalized);
      if (selfCheck) return selfCheck;
      const route = this.#check(
        'outbound',
        true,
        'outbound_route_ready',
        `Outbound routing is configured for ${normalized}. No message was sent by this health check.`,
      );
      return persistentProviderHealth
        ? {
            ...route,
            code: persistentProviderHealth.code,
            message: `${persistentProviderHealth.message} Outbound routing is configured for ${normalized}; no message was sent.`,
            ...(persistentProviderHealth.remediation ? { remediation: persistentProviderHealth.remediation } : {}),
            ...(persistentProviderHealth.evidence ? { evidence: persistentProviderHealth.evidence } : {}),
          }
        : route;
    } catch (err) {
      return this.#check(
        'outbound',
        false,
        'outbound_route_invalid',
        (err as Error).message || 'Outbound route validation failed.',
        'Fix the destination or provider configuration, then run the read-only health check again.',
      );
    }
  }

  #inboundCheck(row: ChannelConnectionRow, settings: ChannelSettings): ChannelHealthCheck {
    if (row.kind === 'discord' && settings.transport !== 'gateway') {
      return this.#check('inbound', true, 'discord_outbound_only', 'Discord is configured for outbound-only REST mode.');
    }
    if (this.#persistent?.handles({ id: row.id, kind: row.kind, settings })) {
      const state = this.#persistent.status?.(row.id) ?? { status: 'idle' };
      if (state.status !== 'open') {
        return this.#check('inbound', false, 'inbound_transport_not_open', `${row.kind} cannot receive messages until the live transport is open.`, 'Relink or restart the live connection.');
      }
      if (!settings.defaultChatId) {
        return row.kind === 'whatsapp'
          ? this.#check('inbound', true, 'inbound_live_ready_no_default', 'WhatsApp live inbound is ready. No default recipient is saved yet.')
          : this.#check('inbound', false, 'needs_first_inbound', `${row.kind} can receive messages, but no default reply target is known yet.`, 'Send a message to this agent from the channel so Agentis can record the first chat as the default target.');
      }
      return this.#check('inbound', true, 'inbound_live_ready', `${row.kind} live inbound is ready.`);
    }
    if (this.#isWhatsAppCloud(row.kind as ChannelKind, settings)) {
      if (!this.#publicWebhookUrl(row.id)) {
        return this.#check('inbound', false, 'missing_public_url', 'WhatsApp Cloud webhooks need a public Agentis URL.', 'Set AGENTIS_PUBLIC_URL and configure the Meta webhook callback URL.');
      }
      if (!settings.appSecretEncrypted || !settings.verifyTokenEncrypted) {
        return this.#check('inbound', false, 'missing_cloud_webhook_secret', 'WhatsApp Cloud webhook secrets are missing.', 'Save the app secret and verify token.');
      }
      return this.#check('inbound', true, 'whatsapp_cloud_webhook_ready', 'WhatsApp Cloud webhook verification is configured.');
    }
    if (row.kind === 'slack' && !settings.signingSecretEncrypted) {
      return this.#check('inbound', false, 'missing_signing_secret', 'Slack Events API signing secret is missing.', 'Save the Slack signing secret so Agentis can verify URL verification and event callbacks.');
    }
    if (!this.#publicWebhookUrl(row.id)) {
      return this.#check('inbound', false, 'missing_public_url', `${row.kind} inbound webhooks need a public Agentis URL.`, 'Set AGENTIS_PUBLIC_URL and configure the provider webhook callback URL.');
    }
    return this.#check('inbound', true, 'webhook_inbound_ready', `${row.kind} inbound webhook endpoint is ready.`);
  }

  async #runtimeCheck(row: ChannelConnectionRow): Promise<ChannelHealthCheck> {
    // Workspace-owned (agentless) connection: no specific agent runtime to probe —
    // inbound routes to the orchestrator, deterministic sends need no runtime.
    if (!row.agentId) {
      return this.#check('runtime', true, 'workspace_connection', 'Workspace-owned connection — inbound routes to the orchestrator; no dedicated agent runtime.');
    }
    const ownerAgentId = row.agentId;
    if (this.deps.runtimeHealth) {
      try {
        return await this.deps.runtimeHealth({ workspaceId: row.workspaceId, agentId: ownerAgentId });
      } catch (err) {
        return this.#check(
          'runtime',
          false,
          'runtime_probe_failed',
          (err as Error).message || 'Agent runtime probe failed.',
          'Fix the agent runtime, then test the channel again.',
        );
      }
    }
    const agent = this.deps.db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.id, ownerAgentId)).get();
    return agent
      ? this.#check('runtime', true, 'agent_runtime_target_exists', 'Channel is attached to an existing agent runtime target.')
      : this.#check('runtime', false, 'agent_missing', 'The connected agent no longer exists.', 'Reconnect the channel to an existing agent.');
  }

  async #sendRow(row: ChannelConnectionRow, chatId: string, body: string, attachments: OutboundAttachment[] = [], pacing?: 'immediate', native?: OutboundNativeContent, authority?: { actor: 'automation' | 'human'; conversationId?: string; expectedEpoch?: number }): Promise<ChannelDeliveryReceipt> {
    const settings = this.#settings(row);
    const normalizedChatId = this.#normalizeTargetForKind(row.kind as ChannelKind, chatId);
    const selfCheck = await this.#telegramSelfTargetCheck(row, normalizedChatId);
    if (selfCheck) {
      throw new AgentisError('CHANNEL_SEND_FAILED', `${selfCheck.message} ${selfCheck.remediation ?? ''}`.trim());
    }
    if (this.#persistent?.handles({ id: row.id, kind: row.kind, settings })) {
      return this.#persistent.send(
        row.id,
        normalizedChatId,
        body,
        attachments.length ? attachments : undefined,
        pacing === 'immediate' ? undefined : resolveHumanize(settings.persona),
        native,
        authority,
      );
    }
    if (this.#isWhatsAppCloud(row.kind as ChannelKind, settings)) {
      if (native) return this.#sendWhatsAppCloudNative(row, settings, normalizedChatId, native, body);
      return this.#sendWhatsAppCloud(row, settings, normalizedChatId, body, attachments);
    }
    const adapter = this.#requireAdapter(row.kind as ChannelKind);
    const token = this.deps.vault.decrypt(row.tokenEncrypted);
    return adapter.send({
      token,
      chatId: normalizedChatId,
      body,
      settings: settings as Record<string, unknown>,
      ...(attachments.length ? { attachments } : {}),
      ...(native ? { native } : {}),
    });
  }

  /**
   * True when this channel chat has an existing conversation — i.e. the contact
   * has interacted before, so an outbound is a reply, not cold outreach. Powers
   * the opt-in gate (§7). A missing conversation means a brand-new contact.
   */
  #hasPriorContact(connectionId: string, chatId: string): boolean {
    const row = this.deps.db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(and(
        eq(schema.conversations.channelConnectionId, connectionId),
        eq(schema.conversations.channelChatId, chatId),
      ))
      .get();
    return Boolean(row);
  }

  /** Resolve loose attachment references into uploadable bytes (artifact ids, data/http URLs). */
  async #resolveAttachments(workspaceId: string, refs: OutboundAttachmentRef[] | undefined): Promise<OutboundAttachment[]> {
    if (!refs || refs.length === 0) return [];
    const out: OutboundAttachment[] = [];
    for (const ref of refs) {
      const source = ref.artifactId ?? ref.url;
      // Text → spoken voice note via the speech (voice) model. The model emits
      // Opus directly, so it sends as a native voice note with no transcoding.
      if ((!source || !source.trim()) && ref.text && ref.text.trim()) {
        if (!this.deps.speech) {
          throw new AgentisError('VALIDATION_FAILED', 'voice synthesis needs a speech model — set the "speech" role in Settings → Runtimes, or send text instead');
        }
        const spoken = await this.deps.speech.synthesize({ text: ref.text });
        if (!spoken) {
          throw new AgentisError('CHANNEL_SEND_FAILED', 'the speech model returned no audio; configure a speech/voice model or send text instead');
        }
        out.push({ kind: 'voice', filename: ref.filename ?? 'voice.ogg', mimeType: spoken.mimeType, data: spoken.bytes, ...(ref.seconds ? { seconds: ref.seconds } : {}) });
        continue;
      }
      if (!source || !source.trim()) {
        throw new AgentisError('VALIDATION_FAILED', 'each attachment needs an artifactId, url, or text (for a voice note)');
      }
      if (!this.deps.artifacts) {
        throw new AgentisError('VALIDATION_FAILED', 'channel attachments require the artifact service (not wired)');
      }
      const hint: { filename?: string; mimeType?: string } = {};
      if (ref.filename) hint.filename = ref.filename;
      if (ref.mimeType) hint.mimeType = ref.mimeType;
      const resolved = await this.deps.artifacts.resolveBytes(workspaceId, source, hint);
      const kind = ref.kind ?? inferOutboundMediaKind(resolved.mimeType);
      out.push({
        kind,
        filename: resolved.filename,
        mimeType: resolved.mimeType,
        data: resolved.buffer,
        ...(ref.caption ? { caption: ref.caption } : {}),
        ...(ref.seconds ? { seconds: ref.seconds } : {}),
        ...(ref.gifPlayback ? { gifPlayback: ref.gifPlayback } : {}),
        ...(ref.viewOnce ? { viewOnce: ref.viewOnce } : {}),
      });
    }
    return out;
  }

  async #sendWhatsAppCloud(row: ChannelConnectionRow, settings: ChannelSettings, chatId: string, body: string, attachments: OutboundAttachment[] = []): Promise<ChannelDeliveryReceipt> {
    const phoneNumberId = settings.phoneNumberId;
    if (!phoneNumberId) {
      throw new AgentisError('VALIDATION_FAILED', 'WhatsApp Cloud phone number ID is missing');
    }
    const token = this.deps.vault.decrypt(row.tokenEncrypted);
    if (attachments.length > 0) {
      // First attachment carries the body as its caption; the rest go captionless.
      const receipts: ChannelDeliveryReceipt[] = [];
      for (let i = 0; i < attachments.length; i += 1) {
        receipts.push(await this.#sendWhatsAppCloudMedia(token, phoneNumberId, chatId, attachments[i]!, i === 0 ? body : ''));
      }
      const first = receipts[0]!;
      return { ...first, providerMessageIds: receipts.map((receipt) => receipt.providerMessageId) };
    }
    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: chatId,
        type: 'text',
        text: { preview_url: false, body },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AgentisError(
        'CHANNEL_SEND_FAILED',
        `whatsapp cloud send failed (${res.status}): ${text.slice(0, 240) || res.statusText}`,
      );
    }
    const json = await res.json().catch(() => ({})) as { messages?: Array<{ id?: string }> };
    const providerMessageId = json.messages?.[0]?.id?.trim() ?? '';
    if (!providerMessageId) {
      throw new AgentisError('CHANNEL_SEND_FAILED', 'whatsapp cloud accepted no provider message id; delivery is unverified');
    }
    return { provider: 'whatsapp', providerMessageId, status: 'accepted', acceptedAt: new Date().toISOString(), recipient: chatId };
  }

  #conversationForDelivery(row: ChannelConnectionRow, chatId: string, create: boolean): { id: string } | null {
    const existing = this.deps.handoffs?.findByChannel(row.workspaceId, row.id, chatId);
    if (existing) return { id: existing.conversationId };
    if (!create || !this.deps.handoffs) return null;
    const agentId = row.agentId ?? this.#resolveInboundAgentId(row.workspaceId);
    if (!agentId) throw new AgentisError('RESOURCE_NOT_FOUND', 'No agent is available to own this channel conversation');
    const peer = this.deps.identity?.observeAliases({
      workspaceId: row.workspaceId,
      connectionId: row.id,
      channelKind: row.kind,
      primaryHandle: chatId,
      source: 'programmatic_outbound',
      countMessage: false,
    });
    return this.deps.conversations.getOrCreateByChannel({
      workspaceId: row.workspaceId,
      ambientId: row.ambientId,
      userId: row.userId,
      agentId,
      channelConnectionId: row.id,
      channelChatId: chatId,
      channelPeerIdentityId: peer?.id ?? null,
      appId: row.appId,
    });
  }

  /**
   * Programmatic sends (for example a deterministic workflow's first contact)
   * must be visible to the next channel turn just like an operator or agent
   * reply. This is deliberately at the bridge boundary, independent of any
   * particular App/workflow, and idempotent on the durable delivery key.
   */
  #persistProgrammaticOutboundContext(input: {
    row: ChannelConnectionRow;
    conversationId: string;
    chatId: string;
    sessionMessageId: string;
    body: string;
    attachments?: OutboundAttachmentRef[];
    native?: OutboundNativeContent;
    receipt?: ChannelDeliveryReceipt;
    deliveryStatus?: 'sending' | 'sent' | 'delivered';
  }) {
    const hasMedia = Boolean(input.attachments?.length || input.native);
    if (!input.body.trim() && !hasMedia) return;
    return this.deps.conversations.appendMirrored({
      workspaceId: input.row.workspaceId,
      conversationId: input.conversationId,
      sessionMessageId: input.sessionMessageId,
      authorType: 'agent',
      participantSide: 'business',
      body: input.body.trim() || '[Media sent]',
      deliveryStatus: input.deliveryStatus
        ?? (input.receipt?.status === 'delivered' || input.receipt?.status === 'read' ? 'delivered' : 'sent'),
      metadata: {
        channel: input.row.kind,
        channelConnectionId: input.row.id,
        channelChatId: input.chatId,
        channelProgrammaticOutbound: true,
        channelDeliveryClass: 'programmatic',
        ...(input.receipt?.providerMessageId ? { providerMessageId: input.receipt.providerMessageId } : {}),
        ...(input.receipt ? { channelDeliveryReceipt: input.receipt } : {}),
      },
    });
  }

  async #sendWhatsAppCloudNative(
    row: ChannelConnectionRow,
    settings: ChannelSettings,
    chatId: string,
    native: OutboundNativeContent,
    body: string,
  ): Promise<ChannelDeliveryReceipt> {
    if (native.kind === 'poll') {
      throw new AgentisError('VALIDATION_FAILED', 'WhatsApp Cloud does not support outbound polls through this adapter; use a linked-device WhatsApp connection');
    }
    const phoneNumberId = settings.phoneNumberId;
    if (!phoneNumberId) throw new AgentisError('VALIDATION_FAILED', 'WhatsApp Cloud phone number ID is missing');
    const token = this.deps.vault.decrypt(row.tokenEncrypted);
    const type = native.kind === 'location' ? 'location' : 'contacts';
    const payload = native.kind === 'location'
      ? {
          longitude: native.longitude,
          latitude: native.latitude,
          ...(native.name ? { name: native.name } : {}),
          ...(native.address ? { address: native.address } : {}),
        }
      : [{
          name: { formatted_name: native.displayName, first_name: native.displayName.split(/\s+/, 1)[0] || native.displayName },
          phones: [{ phone: native.phone, type: 'CELL' }],
        }];
    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: chatId, type, [type]: payload }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AgentisError('CHANNEL_SEND_FAILED', `whatsapp cloud ${type} send failed (${res.status}): ${text.slice(0, 240) || res.statusText}`);
    }
    const json = await res.json().catch(() => ({})) as { messages?: Array<{ id?: string }> };
    const providerMessageId = json.messages?.[0]?.id?.trim() ?? '';
    if (!providerMessageId) throw new AgentisError('CHANNEL_SEND_FAILED', `whatsapp cloud accepted no provider message id for ${type}`);
    const nativeReceipt: ChannelDeliveryReceipt = {
      provider: 'whatsapp', providerMessageId, status: 'accepted', acceptedAt: new Date().toISOString(), recipient: chatId,
    };
    if (!body.trim()) return nativeReceipt;
    const textReceipt = await this.#sendWhatsAppCloud(row, settings, chatId, body.trim());
    return { ...nativeReceipt, providerMessageIds: [nativeReceipt.providerMessageId, textReceipt.providerMessageId] };
  }

  /** Upload media to the WhatsApp Cloud media endpoint, then send a message referencing it. */
  async #sendWhatsAppCloudMedia(token: string, phoneNumberId: string, chatId: string, attachment: OutboundAttachment, caption: string): Promise<ChannelDeliveryReceipt> {
    const base = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(phoneNumberId)}`;
    const uploadForm = new FormData();
    uploadForm.set('messaging_product', 'whatsapp');
    uploadForm.set('file', new Blob([new Uint8Array(attachment.data)], { type: attachment.mimeType }), attachment.filename);
    uploadForm.set('type', attachment.mimeType);
    const uploadRes = await fetch(`${base}/media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: uploadForm,
    });
    const uploadJson = await uploadRes.json().catch(() => ({})) as { id?: string; error?: { message?: string } };
    if (!uploadRes.ok || !uploadJson.id) {
      throw new AgentisError('CHANNEL_SEND_FAILED', `whatsapp cloud media upload failed (${uploadRes.status}): ${uploadJson.error?.message ?? uploadRes.statusText}`);
    }
    // WhatsApp Cloud media types: image | video | audio | sticker | document.
    // A voice note is an audio message (Opus renders as a voice note); captions
    // are supported on image/video/document only; filename only on document.
    const mediaType = whatsappCloudMediaType(attachment.kind);
    const captioned = mediaType === 'image' || mediaType === 'video' || mediaType === 'document';
    const media: Record<string, unknown> = { id: uploadJson.id };
    if (caption && captioned) media.caption = caption;
    if (mediaType === 'document') media.filename = attachment.filename;
    const res = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: chatId, type: mediaType, [mediaType]: media }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AgentisError('CHANNEL_SEND_FAILED', `whatsapp cloud media send failed (${res.status}): ${text.slice(0, 240) || res.statusText}`);
    }
    const json = await res.json().catch(() => ({})) as { messages?: Array<{ id?: string }> };
    const providerMessageId = json.messages?.[0]?.id?.trim() ?? '';
    if (!providerMessageId) {
      throw new AgentisError('CHANNEL_SEND_FAILED', 'whatsapp cloud accepted no provider message id for media; delivery is unverified');
    }
    return { provider: 'whatsapp', providerMessageId, status: 'accepted', acceptedAt: new Date().toISOString(), recipient: chatId };
  }

  #saveHealth(row: ChannelConnectionRow, checks: ChannelHealthCheck[]): ChannelHealth {
    const now = new Date().toISOString();
    const health: ChannelHealth = {
      status: this.#statusFromChecks(checks),
      checks,
      lastTestAt: now,
    };
    const settings = { ...this.#settings(row), health };
    this.deps.db
      .update(schema.channelConnections)
      .set({
        settings,
        status: health.status,
        lastError: checks.find((check) => !check.ok)?.message?.slice(0, 500) ?? null,
        updatedAt: now,
        ...(health.status === 'active' ? { lastEventAt: now } : {}),
      })
      .where(eq(schema.channelConnections.id, row.id))
      .run();
    this.deps.bus.publish(
      REALTIME_ROOMS.workspace(row.workspaceId),
      REALTIME_EVENTS.CHANNEL_CONNECTION_STATUS,
      { connectionId: row.id, kind: row.kind, status: health.status, health },
    );
    return health;
  }

  #healthFromRow(row: ChannelConnectionRow): ChannelHealth {
    const settings = this.#settings(row);
    if (settings.health && Array.isArray(settings.health.checks)) {
      // The row is the authoritative lifecycle state. A historical Test snapshot
      // must never report `active` after the supervisor has persisted an error (or
      // vice versa). Checks remain useful evidence; only their aggregate status is
      // reconciled until the next explicit provider test refreshes them.
      return settings.health.status === row.status
        ? settings.health
        : { ...settings.health, status: row.status as ChannelStatus };
    }
    return this.#initialHealth(row.kind as ChannelKind, settings, row.status as ChannelStatus);
  }

  #initialHealth(kind: ChannelKind, settings: ChannelSettings, status?: ChannelStatus): ChannelHealth {
    const now = new Date().toISOString();
    const initialStatus = status ?? (kind === 'whatsapp' && settings.mode !== 'cloud' ? 'needs_action' : 'verifying');
    return {
      status: initialStatus,
      checks: DEFAULT_HEALTH_CHECK_NAMES.map((name) => ({
        name,
        ok: false,
        code: 'not_checked',
        message: `${name} has not been checked yet.`,
        remediation: name === 'outbound' ? 'Save the channel and run Test.' : undefined,
        checkedAt: now,
      })),
    };
  }

  #statusFromChecks(checks: ChannelHealthCheck[]): ChannelStatus {
    if (checks.length === 0) return 'verifying';
    // `not_checked` is absence of evidence, not a failed capability. A live
    // persistent socket must not become degraded merely because an operator has
    // not run the optional, read-only full diagnostic yet.
    const failed = checks.filter((check) => !check.ok && check.code !== 'not_checked');
    if (failed.length === 0) {
      return checks.some((check) => check.ok) ? 'active' : 'verifying';
    }
    if (failed.some((check) => check.code.includes('missing') || check.code.includes('needs') || check.code.includes('not_open'))) {
      return 'needs_action';
    }
    if (failed.some((check) => check.name === 'credential' || check.name === 'transport')) {
      return 'error';
    }
    // A direction/capability failure does not mean the connection itself is
    // dead. Preserve healthy inbound/socket use and let consumers gate on the
    // specific failed capability.
    if (failed.some((check) => check.name === 'outbound')) return 'degraded';
    return 'degraded';
  }

  #dedupeChecks(checks: ChannelHealthCheck[]): ChannelHealthCheck[] {
    const byName = new Map<ChannelHealthCheckName, ChannelHealthCheck>();
    for (const check of checks) byName.set(check.name, check);
    return DEFAULT_HEALTH_CHECK_NAMES.map((name) => byName.get(name) ?? this.#check(name, false, 'not_checked', `${name} has not been checked yet.`));
  }

  #check(
    name: ChannelHealthCheckName,
    ok: boolean,
    code: string,
    message: string,
    remediation?: string,
  ): ChannelHealthCheck {
    return {
      name,
      ok,
      code,
      message,
      ...(remediation ? { remediation } : {}),
      checkedAt: new Date().toISOString(),
    };
  }

  #settings(row: Pick<ChannelConnectionRow, 'settings'>): ChannelSettings {
    const value = row.settings;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as ChannelSettings
      : {};
  }

  #normalizeAliases(kind: ChannelKind, aliases: Record<string, string | null | undefined>): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [rawAlias, rawTarget] of Object.entries(aliases)) {
      const alias = this.#normalizeAlias(rawAlias);
      const target = rawTarget?.trim();
      if (alias && target) normalized[alias] = this.#normalizeTargetForKind(kind, target);
    }
    return normalized;
  }

  #normalizeAlias(value: string): string | null {
    const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!normalized || normalized.length > 80) return null;
    return normalized;
  }

  #normalizeTargetForKind(kind: ChannelKind, target: string): string {
    const trimmed = target.trim();
    if (!trimmed) throw new AgentisError('VALIDATION_FAILED', 'channel destination is required');
    if (kind === 'telegram') return this.#normalizeTelegramTarget(trimmed);
    if (kind !== 'whatsapp') return trimmed;
    if (/@(s\.whatsapp\.net|g\.us|newsletter)$/i.test(trimmed)) return trimmed;
    const digits = trimmed.replace(/[^\d]/g, '');
    if (digits.length < 8 || digits.length > 20) {
      throw new AgentisError(
        'VALIDATION_FAILED',
        'WhatsApp destination must be a phone number with country code, a user JID, a group JID, or a newsletter JID',
      );
    }
    return `${digits}@s.whatsapp.net`;
  }

  /**
   * Telegram targets are numeric chat IDs (negative for groups/supergroups) or a
   * public @username. Operators routinely paste the labelled value the Telegram
   * UI shows (e.g. "ID: 7905735992") — strip the surrounding label so we store
   * the bare ID, otherwise sendMessage fails with "chat not found". Only a label
   * that wraps a single id is stripped, so @usernames and other forms pass through
   * untouched.
   */
  #normalizeTelegramTarget(value: string): string {
    if (value.startsWith('@')) return value;
    const match = value.match(/^[^\d-]*(-?\d+)$/);
    return match ? match[1]! : value;
  }

  async #telegramSelfTargetCheck(row: ChannelConnectionRow, chatId: string): Promise<ChannelHealthCheck | null> {
    if (row.kind !== 'telegram') return null;
    if (!this.#adapters.get('telegram')?.probeCredential) return null;
    try {
      const token = this.deps.vault.decrypt(row.tokenEncrypted);
      const res = await fetch(`${TELEGRAM_API}/bot${encodeURIComponent(token)}/getMe`, { method: 'GET' });
      if (!res.ok) return null;
      const json = await res.json().catch(() => ({})) as { ok?: boolean; result?: { id?: number; username?: string } };
      if (json.ok === false) return null;
      const botId = json.result?.id ? String(json.result.id) : '';
      const username = json.result?.username?.replace(/^@/, '').toLowerCase() ?? '';
      const target = chatId.trim().replace(/^@/, '').toLowerCase();
      if (target && (target === botId || (username && target === username))) {
        return this.#check(
          'outbound',
          false,
          'telegram_target_is_bot',
          "Telegram target points to the bot itself. Bots can't send messages to themselves.",
          'Open the bot from your personal Telegram account, send /start, then save that human chat ID as the target.',
        );
      }
    } catch {
      return null;
    }
    return null;
  }

  #isWhatsAppCloud(kind: ChannelKind, settings: ChannelSettings): boolean {
    return kind === 'whatsapp' && settings.mode === 'cloud';
  }

  #publicWebhookUrl(connectionId: string): string | null {
    const base = process.env.AGENTIS_PUBLIC_URL?.replace(/\/+$/, '');
    return base ? `${base}/v1/webhooks/channel/${connectionId}` : null;
  }

  #webhookVerificationSecret(row: ChannelConnectionRow): string | null {
    const settings = this.#settings(row);
    if (row.kind === 'slack') {
      return settings.signingSecretEncrypted ? this.deps.vault.decrypt(settings.signingSecretEncrypted) : null;
    }
    if (this.#isWhatsAppCloud(row.kind as ChannelKind, settings)) {
      return settings.appSecretEncrypted ? this.deps.vault.decrypt(settings.appSecretEncrypted) : null;
    }
    return row.webhookSecret;
  }

  #verifyInbound(row: ChannelConnectionRow, headers: Record<string, string | undefined>, rawBody: string, secret: string | null): boolean {
    const settings = this.#settings(row);
    if (this.#isWhatsAppCloud(row.kind as ChannelKind, settings)) {
      return this.#verifyWhatsAppCloudSignature(headers, rawBody, secret);
    }
    return this.#requireAdapter(row.kind as ChannelKind).verify({ headers, rawBody, secret });
  }

  #verifyWhatsAppCloudSignature(headers: Record<string, string | undefined>, rawBody: string, secret: string | null): boolean {
    if (!secret) return false;
    const presented = headers['x-hub-signature-256'] ?? '';
    if (!presented.startsWith('sha256=')) return false;
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    if (expected.length !== presented.length) return false;
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(presented));
    } catch {
      return false;
    }
  }

  #maybeProviderChallenge(row: ChannelConnectionRow, rawBody: string): unknown | null {
    if (row.kind !== 'slack') return null;
    try {
      const payload = JSON.parse(rawBody) as { type?: string; challenge?: string };
      if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
        return { challenge: payload.challenge };
      }
    } catch {
      /* normal parser will report invalid JSON */
    }
    return null;
  }

  #parseWhatsAppCloudInbound(rawBody: string): ParsedInboundMessage | null {
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new AgentisError('VALIDATION_FAILED', 'whatsapp cloud webhook body is not JSON');
    }
    const entries = (payload as { entry?: Array<{ changes?: Array<{ value?: { messages?: unknown[] } }> }> }).entry ?? [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const messages = change.value?.messages ?? [];
        for (const item of messages) {
          const msg = item as {
            id?: string;
            from?: string;
            type?: string;
            text?: { body?: string };
            button?: { text?: string };
            interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
            image?: { id?: string; mime_type?: string; caption?: string };
            audio?: { id?: string; mime_type?: string };
            video?: { id?: string; mime_type?: string; caption?: string };
            document?: { id?: string; mime_type?: string; filename?: string; caption?: string };
            sticker?: { id?: string; mime_type?: string };
            location?: { latitude?: number; longitude?: number; name?: string; address?: string };
            contacts?: Array<{ name?: { formatted_name?: string }; phones?: Array<{ phone?: string; wa_id?: string }> }>;
            reaction?: { message_id?: string; emoji?: string };
          };
          let body = msg.type === 'text'
            ? msg.text?.body
            : msg.button?.text ?? msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title;
          let media: ParsedInboundMessage['media'] | undefined;
          const mediaValue = msg.image ?? msg.audio ?? msg.video ?? msg.document ?? msg.sticker;
          if (mediaValue?.id && msg.type && ['image', 'audio', 'video', 'document', 'sticker'].includes(msg.type)) {
            const kind: OutboundMediaKind = msg.type === 'document' ? 'file' : msg.type as OutboundMediaKind;
            const mediaCaption = msg.image?.caption ?? msg.video?.caption ?? msg.document?.caption;
            media = {
              providerFileId: mediaValue.id,
              kind,
              mimeType: mediaValue.mime_type,
              filename: msg.document?.filename ?? `whatsapp-${msg.type}`,
              ...(mediaCaption ? { caption: mediaCaption } : {}),
            };
            body = [
              `[${msg.type === 'audio' ? 'Audio' : msg.type === 'document' ? 'Document' : msg.type} received]`,
              ...(mediaCaption ? [`Caption: ${mediaCaption}`] : []),
            ].join('\n');
          } else if (msg.location && Number.isFinite(msg.location.latitude) && Number.isFinite(msg.location.longitude)) {
            body = [
              '[Location received]',
              ...(msg.location.name ? [`Name: ${msg.location.name}`] : []),
              ...(msg.location.address ? [`Address: ${msg.location.address}`] : []),
              `Coordinates: ${msg.location.latitude}, ${msg.location.longitude}`,
              `Map: https://maps.google.com/?q=${msg.location.latitude},${msg.location.longitude}`,
            ].join('\n');
          } else if (msg.contacts?.length) {
            body = ['[Contact card received]', ...msg.contacts.flatMap((contact) => [
              ...(contact.name?.formatted_name ? [`Name: ${contact.name.formatted_name}`] : []),
              ...((contact.phones ?? []).map((phone) => `Phone: ${phone.phone ?? phone.wa_id ?? ''}`)),
            ])].join('\n');
          } else if (msg.reaction?.emoji) {
            body = `[Reaction received: ${msg.reaction.emoji}${msg.reaction.message_id ? ` to message ${msg.reaction.message_id}` : ''}]`;
          }
          if (!msg.id || !msg.from || !body) continue;
          const parsed: ParsedInboundMessage = {
            externalId: `whatsapp:${msg.id}`,
            chatId: msg.from,
            body,
            from: msg.from,
          };
          if (media) parsed.media = media;
          return parsed;
        }
      }
    }
    return null;
  }

  async #enrichWebhookMedia(row: ChannelConnectionRow, parsed: ParsedInboundMessage): Promise<string> {
    const media = parsed.media;
    if (!media) return parsed.body;
    const downloaded = await this.#downloadWebhookMedia(row, media.providerFileId, media.mimeType, media.filename);
    const mimeType = downloaded.mimeType || media.mimeType || 'application/octet-stream';
    const filename = downloaded.filename || media.filename || `channel-${media.kind}`;
    const details: string[] = [parsed.body];
    if (this.deps.artifacts) {
      const artifact = this.deps.artifacts.persist({
        workspaceId: row.workspaceId,
        agentId: row.agentId ?? this.#resolveInboundAgentId(row.workspaceId),
        origin: 'channel',
        type: artifactTypeFromMime(mimeType, filename),
        title: `Inbound ${media.kind}: ${filename}`,
        name: filename,
        content: `data:${mimeType.split(';', 1)[0]};base64,${downloaded.bytes.toString('base64')}`,
        savedBy: 'channel.webhook',
        metadataExtra: { mime: mimeType, size: downloaded.bytes.byteLength, channelConnectionId: row.id, channelMediaKind: media.kind },
      });
      details.push(`Attachment: ${artifact.ref}`);
    }
    if ((media.kind === 'voice' || media.kind === 'audio') && this.#inboundMediaResolvers.transcribeAudio) {
      const transcript = await this.#inboundMediaResolvers.transcribeAudio(downloaded.bytes, mimeType, row.workspaceId);
      details.push(transcript?.trim() ? `Transcript:\n${transcript.trim()}` : 'Transcription is unavailable.');
    } else if ((media.kind === 'image' || (media.kind === 'sticker' && mimeType.startsWith('image/'))) && this.#inboundMediaResolvers.describeImage) {
      const description = await this.#inboundMediaResolvers.describeImage(downloaded.bytes, mimeType, row.workspaceId, media.caption);
      details.push(description?.trim() ? `Visual analysis: ${description.trim()}` : 'Visual analysis is unavailable.');
    } else if (media.kind === 'file' && this.#inboundMediaResolvers.extractDocument) {
      const extracted = await this.#inboundMediaResolvers.extractDocument(downloaded.bytes, mimeType, row.workspaceId, filename);
      details.push(extracted?.trim() || 'Text extraction is unavailable. Do not claim to have read the document.');
    }
    return details.join('\n');
  }

  async #downloadWebhookMedia(
    row: ChannelConnectionRow,
    providerFileId: string,
    mimeHint?: string,
    filenameHint?: string,
  ): Promise<{ bytes: Buffer; mimeType: string; filename: string }> {
    const token = this.deps.vault.decrypt(row.tokenEncrypted);
    let url: string;
    let mimeType = mimeHint ?? 'application/octet-stream';
    let filename = filenameHint ?? 'channel-media.bin';
    const headers: Record<string, string> = {};
    if (row.kind === 'telegram') {
      const meta = await fetch(`${TELEGRAM_API}/bot${encodeURIComponent(token)}/getFile?file_id=${encodeURIComponent(providerFileId)}`);
      const json = await meta.json().catch(() => ({})) as { ok?: boolean; result?: { file_path?: string } };
      if (!meta.ok || !json.result?.file_path) throw new Error(`telegram getFile failed (${meta.status})`);
      url = `${TELEGRAM_API}/file/bot${token}/${json.result.file_path}`;
      if (!filenameHint) filename = json.result.file_path.split('/').at(-1) ?? filename;
    } else if (row.kind === 'whatsapp') {
      headers.authorization = `Bearer ${token}`;
      const meta = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(providerFileId)}`, { headers });
      const json = await meta.json().catch(() => ({})) as { url?: string; mime_type?: string };
      if (!meta.ok || !json.url) throw new Error(`whatsapp cloud media lookup failed (${meta.status})`);
      url = json.url;
      mimeType = json.mime_type ?? mimeType;
    } else {
      throw new Error(`${row.kind} webhook media download is not implemented`);
    }
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`${row.kind} media download failed (${response.status})`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > 20 * 1024 * 1024) throw new Error('inbound media exceeds the 20 MB safety limit');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('inbound media exceeds the 20 MB safety limit');
    return { bytes, mimeType: response.headers.get('content-type') ?? mimeType, filename };
  }

  #rememberDefaultChat(row: ChannelConnectionRow, chatId: string): void {
    const settings = this.#settings(row);
    if (settings.defaultChatId) return;
    const now = new Date().toISOString();
    this.deps.db
      .update(schema.channelConnections)
      .set({
        settings: { ...settings, defaultChatId: chatId },
        updatedAt: now,
      })
      .where(eq(schema.channelConnections.id, row.id))
      .run();
  }

  #row(workspaceId: string, id: string) {
    const row = this.deps.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, id))
      .get();
    if (!row || row.workspaceId !== workspaceId) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `channel connection ${id} not found`);
    }
    return row;
  }

  #requireAdapter(kind: ChannelKind): ChannelAdapter {
    const adapter = this.#adapters.get(kind);
    if (!adapter) {
      throw new AgentisError(
        'CHANNEL_KIND_UNAVAILABLE',
        `channel adapter for kind '${kind}' is not registered`,
      );
    }
    return adapter;
  }

  #markActive(id: string) {
    const now = new Date().toISOString();
    this.deps.db
      .update(schema.channelConnections)
      .set({ status: 'active', lastEventAt: now, lastError: null, updatedAt: now })
      .where(eq(schema.channelConnections.id, id))
      .run();
  }

  #markError(id: string, message: string) {
    const now = new Date().toISOString();
    const row = this.deps.db
      .select({ workspaceId: schema.channelConnections.workspaceId })
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, id))
      .get();
    this.deps.db
      .update(schema.channelConnections)
      .set({ status: 'error', lastError: message.slice(0, 500), updatedAt: now })
      .where(eq(schema.channelConnections.id, id))
      .run();
    if (row) {
      this.deps.bus.publish(
        REALTIME_ROOMS.workspace(row.workspaceId),
        REALTIME_EVENTS.CHANNEL_CONNECTION_STATUS,
        { connectionId: id, status: 'error', error: message },
      );
    }
  }

  /** The agent a workspace-owned connection's inbound routes to: the orchestrator
   *  (the workspace front door), else the first agent, else null (no agents). */
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

  #toPublic(row: typeof schema.channelConnections.$inferSelect): PublicConnection {
    row = this.#reconcileLiveTransport(row);
    const settings = this.#settings(row);
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      ambientId: row.ambientId,
      agentId: row.agentId,
      appId: row.appId ?? null,
      kind: row.kind as ChannelKind,
      name: row.name,
      status: row.status,
      defaultChatId: settings.defaultChatId ?? null,
      ownerChatId: settings.ownerChatId ?? null,
      ownerName: settings.ownerName ?? null,
      targetAliases: settings.targetAliases ?? {},
      access: settings.access ?? null,
      transport: settings.transport ?? null,
      mode: settings.mode ?? null,
      transportStatus: settings.transportStatus ?? null,
      isDefault: settings.isDefault === true,
      persona: normalizePersona(settings.persona),
      rateLimit: settings.rateLimit ?? null,
      requireOptIn: settings.requireOptIn === true,
      warmupStartedAt: settings.warmupStartedAt ?? null,
      whatsappProfile: row.kind === 'whatsapp' ? resolveWhatsAppConnectionProfile(settings.whatsappProfile) : null,
      capabilities: channelCapabilities(row.kind as ChannelKind, settings.mode ? { whatsappMode: settings.mode } : undefined),
      health: this.#healthFromRow(row),
      lastEventAt: row.lastEventAt,
      lastError: row.lastError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Repair lifecycle drift on ordinary reads. An open persistent socket is
   * stronger evidence than a stale persisted error; terminal authentication
   * states are likewise stronger than an old successful Test snapshot.
   */
  #reconcileLiveTransport(
    row: typeof schema.channelConnections.$inferSelect,
  ): typeof schema.channelConnections.$inferSelect {
    if (row.status === 'paused') return row;
    const settings = this.#settings(row);
    if (!this.#persistent?.handles({ id: row.id, kind: row.kind, settings })) return row;
    const state = this.#persistent.status?.(row.id);
    if (!state) return row;
    const authoritativeStatus: ChannelStatus | null = state.status === 'open'
      ? 'active'
      : state.status === 'logged_out' || state.status === 'error'
        ? 'error'
        : null;
    const transportDrift = settings.transportStatus !== state.status;
    const statusDrift = authoritativeStatus !== null && row.status !== authoritativeStatus;
    if (!transportDrift && !statusDrift) return row;

    const now = new Date().toISOString();
    const status = authoritativeStatus ?? row.status as ChannelStatus;
    const nextSettings: ChannelSettings = {
      ...settings,
      transportStatus: state.status,
      ...(settings.health ? { health: { ...settings.health, status } } : {}),
    };
    this.deps.db.update(schema.channelConnections).set({
      settings: nextSettings,
      status,
      updatedAt: now,
      ...(state.status === 'open' ? { lastError: null, lastEventAt: now } : {}),
    }).where(eq(schema.channelConnections.id, row.id)).run();
    return {
      ...row,
      settings: nextSettings,
      status,
      updatedAt: now,
      ...(state.status === 'open' ? { lastError: null, lastEventAt: now } : {}),
    };
  }
}
