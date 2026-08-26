/**
 * ChannelTurnDispatcher — the bridge between an inbound channel message and a
 * real orchestrator turn (OMNICHANNEL-ORCHESTRATOR-10X §3.3).
 *
 * Before this service existed, a Telegram/Slack/Discord message landed in a
 * conversation thread as an inert mirrored line and nothing else happened — the
 * orchestrator never saw it. The dispatcher closes that loop:
 *
 *   inbound message  (ChannelBridge.handleInbound)
 *     → dispatch()
 *        → resolve the connection's bound agent → an adapter that can chat
 *          (its own runtime, or the configured orchestrator runtime)
 *        → ChatSessionExecutor.turn(...)            // the orchestrator THINKS
 *        → persist the reply as an 'agent' message
 *        → deliver the reply back to the origin channel
 *
 * The webhook handler fires this fire-and-forget so the channel gets its fast
 * 200 ack while the (potentially slow) turn runs in the background.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { AgentisError, normalizeAgentPlanText, type AgentAdapter, type ApprovalSensitivity, type ChannelToolOrigin, type ChatDelta, type ChatMessage, type ChatPermissionMode, type ChatTurnContext, type RuntimeInputAttachment } from '@agentis/core';
import type { AdapterManager } from '../../adapters/AdapterManager.js';
import type { ConversationStore } from './conversationStore.js';
import { ChatSessionExecutor } from '../chat/chatSessionExecutor.js';
import { parseModeCommand, MODE_SWITCH_ACK, defaultTaskForMode, PLAN_MODE_SYSTEM_ADDENDUM } from '../chat/chatPermissionMode.js';
import { resolveChannelAccess, buildAccessAddendum, normalizeHandle, UNKNOWN_SENDER_DECLINE, type AccessDecision, type ChannelAccess } from './channelAccess.js';
import type { ChannelIdentityService } from './channelIdentityService.js';
import type { AppContactService } from '../app/appContacts.js';
import type { ConversationSummaryService } from './conversationSummaryService.js';
import { AdapterStructuredCompleter } from '../structuredCompleter.js';
import type { ConversationParticipantService } from './conversationParticipants.js';
import type { OutboundPolicyService } from '../outboundPolicy.js';
import type { ConversationService } from './conversationService.js';
import type { ChatMemoryCaptureService } from '../chat/chatMemoryCapture.js';
import type { Logger } from '../../logger.js';
import type { EventBus } from '../../event-bus.js';
import { publishAgentWorkStep, publishChatDeltaProgress, publishAppAgentActivity } from '../agent/agentWorkProgress.js';
import { isAcknowledgedChannelDelivery, type ChannelDeliveryReceipt, type OutboundAttachmentRef } from '../../adapters/channels/types.js';
import { resolveWhatsAppConnectionProfile } from './channelBridge.js';
import { channelModelRole } from './channelConversationRole.js';
import type { ConversationHandoffService, ConversationHandoffSnapshot } from './conversationHandoffService.js';
import type { RelationshipStateService } from '../relationshipStateService.js';
import type { ChannelUtteranceBatchStore } from './channelUtteranceBatchStore.js';
import type { ChannelInboxService } from './channelInboxService.js';
import type { ChannelActionIntentService } from './channelActionIntentService.js';

/** Channel activity is never a chat message unless it is this verified-owner indicator. */
export type ChannelDeliveryClass = 'internal' | 'owner_reasoning_indicator' | 'reply';

export interface ChannelTurnDeliver {
  (args: { connectionId: string; chatId: string; body: string; attachments?: OutboundAttachmentRef[]; idempotencyKey?: string; pacing?: 'immediate'; conversationId?: string; expectedAutomationEpoch?: number }): Promise<ChannelDeliveryReceipt | undefined>;
}

export interface ChannelTurnDispatcherDeps {
  db: AgentisSqliteDb;
  adapters: AdapterManager;
  conversations: ConversationStore;
  logger: Logger;
  /** Workspace realtime feed for channel turns. */
  bus?: EventBus;
  /** Send the orchestrator's reply back to the origin channel. */
  deliver: ChannelTurnDeliver;
  /**
   * §3.2 — route an inbound message to a Subject on the Durable Entity spine that
   * awaits this channel correlation (a reply that may be days late / out of order).
   * Additive + best-effort: a no-op when no subject awaits, and never blocks the turn.
   */
  onInbound?: (args: { workspaceId: string; connectionId: string; chatId: string; from?: string; text?: string }) => void;
  /** Optional: show/clear the typing indicator while the turn runs. */
  setTyping?: (connectionId: string, chatId: string, on: boolean) => Promise<void>;
  /** Override the turn runner (tests). Defaults to ChatSessionExecutor.turn. */
  runTurn?: typeof ChatSessionExecutor.turn;
  /** Separate runtime lane for messages received while a task remains active. */
  runConcurrentTurn?: typeof ChatSessionExecutor.turn;
  /** Override the confirm runner (tests). Defaults to ChatSessionExecutor.confirm. */
  runConfirm?: typeof ChatSessionExecutor.confirm;
  /** Override the orchestrator-runtime fallback (tests). */
  fallbackAdapter?: () => AgentAdapter | undefined;
  /** Cross-surface peer identity — records senders and recalls them (§5.2). */
  identity?: ChannelIdentityService;
  /** Canonical, read-only inbox view for owner control turns. */
  inbox?: ChannelInboxService;
  /** Durable goal-scoped outbound actions. */
  channelActions?: ChannelActionIntentService;
  /** App relationship entity — upserts/touches a contact for App-bound turns (Phase 3). */
  contacts?: AppContactService;
  /** Canonical per-principal Subject state; contacts remain a UI/query projection. */
  relationships?: RelationshipStateService;
  /** Restart-durable provider-bubble assembler. */
  utterances?: ChannelUtteranceBatchStore;
  /**
   * Long-horizon per-conversation memory (G4). When wired, the dispatcher folds
   * turns that scroll out of the live window into a rolling "state of this
   * relationship" summary and injects it into each turn. Absent → today's
   * window-only context (no summary), byte-identical.
   */
  summaries?: ConversationSummaryService;
  /** Durable ownership fence shared by ingress, tools, routes and provider delivery. */
  handoffs?: ConversationHandoffService;
  /** Multi-party threads (G1) — resolve the active responder (specialist warm handoff) + seed the primary. */
  participants?: ConversationParticipantService;
  /**
   * BRAIN-BLUEPRINT-10X — channel turns form durable memory like web chat does
   * (operator statements + the agent's own learnings, same formation pipeline).
   * Absent → no capture (byte-identical to the old behavior).
   */
  memoryCapture?: ChatMemoryCaptureService;
  /**
   * Outbound safety envelope (G7). When wired and the turn is App-bound, the
   * agent's final reply is checked against the App's outbound policy: a blocked
   * claim is withheld (a safe notice replaces it) and a require-approval match is
   * held for the operator (`requestOutboundApproval`) instead of delivered.
   */
  outboundPolicy?: OutboundPolicyService;
  /**
   * Surface a held App reply to the operator for in-thread approval (G7). Called
   * with the full message + context; returns true when an approval was created.
   * Absent → a needs-approval reply is withheld (never sent unapproved).
   */
  requestOutboundApproval?: (args: {
    workspaceId: string;
    appId: string;
    conversationId: string;
    connectionId: string;
    chatId: string;
    threadId?: string | null;
    body: string;
    reason: string;
  }) => Promise<boolean> | boolean;
  /**
   * Conversation State Machine (GAP B1/B3). When wired and the turn is App-bound,
   * an inbound message is offered to the App's conversation script FIRST: if a
   * script owns this contact, it advances the stage (deterministic where scripted,
   * ZERO tokens) and the dispatcher does NOT run a general agent turn. Absent (or no
   * script) → today's behavior, byte-identical.
   */
  conversation?: ConversationService;
  /**
   * Durable turn queue (Living Apps Phase 5 / G2). When wired, an inbound turn
   * is ENQUEUED (durable, at-least-once, resumable) instead of run in-process;
   * the queue's worker calls back into `runQueued`. Absent → today's
   * fire-and-forget in-process path, byte-identical. Set after construction
   * (the queue and dispatcher reference each other).
   */
  queue?: ChannelTurnEnqueuer;
  /**
   * Batch rapid-fire inbound messages within this window (ms) into a single
   * turn (OMNICHANNEL §3.3). 0 (default) runs each message immediately.
   */
  debounceMs?: number;
  /** Test seam; production keeps the owner indicator deliberately unhurried. */
  ownerReasoningIndicatorDelayMs?: number;
  /**
   * Compile durable inbound channel artifacts into model-ready multimodal context.
   * This is deliberately shared with platform chat so channels do not degrade a
   * real attachment into a provider-specific placeholder string.
   */
  compileAttachments?: (args: {
    workspaceId: string;
    body: string;
    attachmentIds: string[];
  }) => Promise<{ prompt: string; runtimeInputAttachments?: RuntimeInputAttachment[] }>;
}

/** The durable-queue sink. `enqueue` returns the queue id, or null on failure. */
export interface ChannelTurnEnqueuer {
  enqueue(input: ChannelTurnInput): string | null;
  cancelConversation?(workspaceId: string, conversationId: string): number;
}

interface PendingChannelConfirmation {
  turnId: string;
  conversationId: string;
  expiresAt: number;
}

interface PendingBatch {
  latest: ChannelTurnInput;
  texts: string[];
  ids: Set<string>;
  attachmentIds: Set<string>;
  timer: ReturnType<typeof setTimeout>;
  firstReceivedAt: number;
  durableBatchId?: string;
}

interface ActiveChannelTurn {
  conversationId: string;
  automationEpoch?: number;
  generation: number;
  controller: AbortController;
  clientTurnId: string;
  objective: string;
  startedAt: number;
  phase: 'thinking' | 'working' | 'waiting';
  completedSteps: number;
  mailbox: Array<{ input: ChannelTurnInput; queueId: string }>;
  /** Companion replies are serialized so one runtime session is never driven concurrently. */
  companionTail: Promise<void>;
  turnLease?: string;
}

const CONFIRM_TTL_MS = 5 * 60 * 1000;
const OWNER_REASONING_INDICATOR_DELAY_MS = 7_000;

/**
 * A resident worker answers its own relationship; it does not become a second
 * workspace control plane merely because an operator is speaking to it. The
 * registry enforces this allow-list as well as hiding the other tools from the
 * model, so progressive-disclosure gateways cannot bypass the boundary.
 */
const BOUNDED_CHANNEL_AGENT_TOOLS = [
  'agentis.brain.search',
  'agentis.skill.load',
  'agentis.skills.list',
  'agentis.knowledge.search',
  'agentis.channel.send',
  'agentis.channel.inbox',
  'agentis.channel.action.create',
  'agentis.channel.action.list',
  'agentis.channel.action.cancel',
  'agentis.channel.capabilities',
  'agentis.channel.react',
  'agentis.channel.typing',
  'agentis.media.capabilities',
  'agentis.media.generate',
  'agentis.subject.get',
  'agentis.subject.post',
  'agentis.subject.update_relationship',
  'agentis.conversation.flag_needs_attention',
] as const;

const APP_RELATIONSHIP_TOOLS = [
  'agentis.data.query',
  'agentis.data.insert',
  'agentis.data.upsert',
  'agentis.data.update',
  'agentis.data.batch',
  'agentis.data.promote_memory',
] as const;

interface OwnerReasoningIndicatorState {
  cancelled: boolean;
  sent: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export interface ChannelTurnInput {
  workspaceId: string;
  ambientId: string | null;
  userId: string;
  agentId: string;
  /** When the channel belongs to an Agentic App, the turn runs in its context (Living Apps Phase 0). */
  appId?: string | null;
  conversationId: string;
  connectionId: string;
  kind: string;
  /** Channel-side reply address (e.g. Telegram chat id, Slack channel:thread). */
  chatId: string;
  /** Subject boundary — when set, turn history is scoped to this thread. */
  threadId?: string;
  /** The human's message text, already stripped of any `[from]` prefix. */
  text: string;
  /** Durable inbound artifacts (images, audio, documents, video, etc.). */
  attachmentIds?: string[];
  /** Internal compiled form used when media arrives while another task is active. */
  attachmentContextText?: string;
  /** Materialized inputs forwarded natively to capable agent runtimes. */
  runtimeInputAttachments?: RuntimeInputAttachment[];
  from?: string;
  /** Conversation message id of the inbound mirror, excluded from history. */
  inboundMessageId?: string;
  /**
   * All inbound mirror ids this turn answers, excluded from history. Set when a
   * debounce batch coalesced several messages — carried on the durable queue
   * payload so the worker rebuilds the same exclusion set after a crash. When
   * absent, falls back to `inboundMessageId`.
   */
  excludeMessageIds?: string[];
  /** Monotonic per-chat input version. Messages received before execution are ordered by generation. */
  turnGeneration?: number;
  /** Ownership version captured before this automated turn began. */
  automationEpoch?: number;
  /** Distinguishes a human inbound from a Subject wake reaching out first. */
  initiatedBy?: 'inbound' | 'proactive';
  /** Canonical relationship Subject for proactive wakes and continuity. */
  subjectId?: string;
}

const HISTORY_LIMIT = 20;
const HISTORY_CHAR_LIMIT = 12_000;
/** How many turn-windows of history the summary maintainer reads (G4). */
const SUMMARY_LOOKBACK_WINDOWS = 8;
const NOT_CONNECTED =
  'This agent is not connected to an interactive runtime yet, so it cannot reply over this channel. ' +
  'Connect a chat-capable harness (or configure the orchestrator runtime) and try again.';

export class ChannelTurnDispatcher {
  // Pending confirmations keyed by `${connectionId}:${chatId}` — a channel has
  // no buttons, so a tool that needs confirmation becomes a "reply yes/no" prompt
  // that the next inbound message resolves (OMNICHANNEL §3.5/§5).
  readonly #pending = new Map<string, PendingChannelConfirmation>();
  // Per-(connection,chat) batches of rapid-fire messages awaiting a debounce flush.
  readonly #batches = new Map<string, PendingBatch>();
  /** Latest generation accepted while no task is active. */
  readonly #turnGenerations = new Map<string, number>();
  /** One durable work lane per chat; later inbound joins its mailbox instead of cancelling it. */
  readonly #activeTurns = new Map<string, ActiveChannelTurn>();

  #queue: ChannelTurnEnqueuer | undefined;

  constructor(private readonly deps: ChannelTurnDispatcherDeps) {
    this.#queue = deps.queue;
  }

  /**
   * Wire the durable turn queue after construction (G2). The queue and the
   * dispatcher reference each other — the queue's worker calls `runQueued`, and
   * `dispatch` enqueues onto the queue. Wired in bootstrap when the durable path
   * is enabled; absent → today's in-process path.
   */
  setQueue(queue: ChannelTurnEnqueuer): void {
    this.#queue = queue;
  }

  /** Immediately silence every automated lane when durable ownership moves to a human. */
  handleHandoffChanged(snapshot: ConversationHandoffSnapshot): void {
    if (snapshot.state !== 'human') return;
    for (const [key, batch] of this.#batches) {
      if (batch.latest.conversationId !== snapshot.conversationId) continue;
      clearTimeout(batch.timer);
      this.#batches.delete(key);
    }
    for (const [key, pending] of this.#pending) {
      if (pending.conversationId === snapshot.conversationId) this.#pending.delete(key);
    }
    for (const [key, active] of this.#activeTurns) {
      if (active.conversationId !== snapshot.conversationId) continue;
      for (const queued of active.mailbox) {
        try {
          this.deps.conversations.discardQueuedMessage({
            workspaceId: snapshot.workspaceId,
            conversationId: snapshot.conversationId,
            queueId: queued.queueId,
          });
        } catch { /* already consumed/discarded */ }
      }
      active.mailbox.length = 0;
      active.controller.abort(new AgentisError('TURN_CANCELLED', 'A human operator took over this conversation.'));
      this.#turnGenerations.set(key, active.generation + 1);
      this.#activeTurns.delete(key);
      void this.deps.setTyping?.(snapshot.connectionId ?? key.split(':', 1)[0]!, snapshot.chatId ?? key.slice(key.indexOf(':') + 1), false).catch(() => {});
    }
    ChatSessionExecutor.revokeTurnLeases(snapshot.workspaceId, snapshot.conversationId);
    this.#queue?.cancelConversation?.(snapshot.workspaceId, snapshot.conversationId);
  }

  /**
   * Handle an inbound channel message. With `debounceMs > 0`, rapid-fire
   * messages from the same chat are coalesced into one turn; otherwise the turn
   * runs immediately. When a durable queue is wired the coalesced turn is
   * ENQUEUED (durable, resumable) rather than run in-process; otherwise it runs
   * fire-and-forget exactly as before. Fire-and-forget safe — never throws.
   */
  async dispatch(input: ChannelTurnInput): Promise<{ replied: boolean; reason?: string }> {
    const proactive = input.initiatedBy === 'proactive';
    // Operator block gate: a blocked sender is fully silent — no subject routing,
    // no agent turn, no reply. Cheap single-row lookup on the same handle the
    // identity table shows. (Same handle rule as #recordIdentity below.)
    if (!proactive && this.deps.identity && !this.#isOwnerControlPeer(input)) {
      const handle = (input.kind === 'slack' || input.kind === 'discord') ? (input.from ?? input.chatId) : input.chatId;
      if (this.deps.identity.isBlocked(input.workspaceId, input.kind, handle, input.connectionId)) {
        return { replied: false, reason: 'blocked' };
      }
    }
    // §3.2 — hand the inbound to any Subject awaiting this channel correlation (best-effort).
    try {
      if (!proactive) this.deps.onInbound?.({ workspaceId: input.workspaceId, connectionId: input.connectionId, chatId: input.chatId, ...(input.from ? { from: input.from } : {}), ...(input.text ? { text: input.text } : {}) });
    } catch { /* never let subject routing break a channel turn */ }
    this.#publishWorkStep(input, null, {
      phase: 'received',
      step: 'channel_message',
      description: `${channelLabel(input.kind)} message received`,
      detail: input.from ? `From ${input.from}` : `Chat ${input.chatId}`,
    });
    const active = this.#activeTurns.get(this.#turnKey(input));
    if (active) {
      input = await this.#prepareAttachmentContext(input, input.text);
      const queued = this.deps.conversations.enqueueMessage({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        text: input.text,
        ...(input.attachmentIds?.length ? { attachments: input.attachmentIds } : {}),
      });
      active.mailbox.push({ input, queueId: queued.id });
      // Ordinary bubbles are continuation fragments for the active cognition
      // lane. Only an unmistakable status request opens a companion response;
      // this prevents one bot-like answer per provider bubble.
      if (isExplicitActiveStatusRequest(input.text)) {
        return this.#replyAlongsideActiveTurn(input, active, queued.id);
      }
      return { replied: false, reason: 'joined_active_turn' };
    }
    input = this.#acceptInbound(input);
    const windowMs = proactive ? 0 : (this.deps.debounceMs ?? 0);
    if (windowMs <= 0) {
      return this.#commitTurn(input, input.inboundMessageId ? [input.inboundMessageId] : []);
    }
    const key = `${input.connectionId}:${input.chatId}`;
    if (this.deps.utterances) {
      const priorCount = this.#batches.get(key)?.texts.length ?? 0;
      const quietMs = priorCount > 0 && windowMs >= 1_000 ? Math.max(windowMs, 1_800) : windowMs;
      const durable = this.deps.utterances.append(input, quietMs);
      const existingTimer = this.#batches.get(key);
      if (existingTimer) clearTimeout(existingTimer.timer);
      const delay = Math.max(0, Date.parse(durable.softDeadlineAt) - Date.now());
      this.#batches.set(key, {
        latest: durable.input,
        texts: durable.input.text.split('\n'),
        ids: new Set(durable.messageIds),
        attachmentIds: new Set(durable.attachmentIds),
        timer: setTimeout(() => { void this.#flushBatch(key); }, delay),
        firstReceivedAt: Date.parse(durable.hardDeadlineAt) - 8_000,
        durableBatchId: durable.id,
      });
      return { replied: false, reason: 'batched' };
    }
    const existing = this.#batches.get(key);
    if (existing) {
      existing.texts.push(input.text);
      if (input.inboundMessageId) existing.ids.add(input.inboundMessageId);
      for (const artifactId of input.attachmentIds ?? []) existing.attachmentIds.add(artifactId);
      existing.latest = input;
      clearTimeout(existing.timer);
      const hardRemaining = Math.max(0, 8_000 - (Date.now() - existing.firstReceivedAt));
      const quietWindow = Math.min(existing.texts.length > 1 && windowMs >= 1_000 ? Math.max(windowMs, 1_800) : windowMs, hardRemaining);
      existing.timer = setTimeout(() => this.#flushBatch(key), quietWindow);
      return { replied: false, reason: 'batched' };
    }
    const ids = new Set<string>();
    if (input.inboundMessageId) ids.add(input.inboundMessageId);
    this.#batches.set(key, {
      latest: input,
      texts: [input.text],
      ids,
      attachmentIds: new Set(input.attachmentIds ?? []),
      timer: setTimeout(() => this.#flushBatch(key), windowMs),
      firstReceivedAt: Date.now(),
    });
    return { replied: false, reason: 'batched' };
  }

  async #flushBatch(key: string): Promise<void> {
    const batch = this.#batches.get(key);
    if (!batch) return;
    this.#batches.delete(key);
    if (batch.durableBatchId && this.deps.utterances) {
      const claimed = this.deps.utterances.claim(batch.durableBatchId);
      if (!claimed) return;
      try {
        await this.#commitTurn(claimed.input, claimed.messageIds);
        this.deps.utterances.complete(claimed.id);
      } catch (err) {
        this.deps.utterances.retry(claimed.id);
        this.deps.logger.warn('channel.turn.durable_utterance_failed', { batchId: claimed.id, err: (err as Error).message });
      }
      return;
    }
    const combined: ChannelTurnInput = {
      ...batch.latest,
      text: batch.texts.join('\n'),
      ...(
        batch.attachmentIds.size
          ? { attachmentIds: [...batch.attachmentIds], attachmentContextText: undefined, runtimeInputAttachments: undefined }
          : {}
      ),
    };
    void Promise.resolve(this.#commitTurn(combined, [...batch.ids])).catch((err) => {
      this.deps.logger.error('channel.turn.batch_failed', { key, err: (err as Error).message });
    });
  }

  /**
   * The terminal sink for a (possibly coalesced) inbound turn. When a durable
   * queue is wired, enqueue it (durable + at-least-once + resumable) and return
   * immediately; the worker runs it via `runQueued`. Otherwise run it in-process
   * (today's behavior). On an enqueue failure the turn is NOT lost — it falls
   * back to the in-process path so a message is never dropped silently.
   */
  async #commitTurn(input: ChannelTurnInput, excludeMessageIds: string[]): Promise<{ replied: boolean; reason?: string }> {
    if (this.#queue) {
      const queued: ChannelTurnInput = excludeMessageIds.length > 1
        ? { ...input, excludeMessageIds }
        : input;
      const id = this.#queue.enqueue(queued);
      if (id) return { replied: false, reason: 'queued' };
      // Enqueue failed — never drop the turn; run it inline as the fallback.
      this.deps.logger.warn('channel.turn.enqueue_fallback_inline', { conversationId: input.conversationId });
    }
    return this.#executeTurn(input, excludeMessageIds);
  }

  /**
   * Run one queued turn to completion (durable-queue worker entry point, G2).
   * Rebuilds the exclusion set from the durable payload so a turn resumed after
   * a crash drops the same inbound mirrors from history. Re-throws so the queue
   * can record the failure and retry — `#executeTurn` already converts a turn
   * failure into a user-facing reply, so a thrown error here is an
   * infrastructure fault (the rare case the queue should retry).
   */
  async runQueued(input: ChannelTurnInput): Promise<{ replied: boolean; reason?: string }> {
    const excludeMessageIds = input.excludeMessageIds
      ?? (input.inboundMessageId ? [input.inboundMessageId] : []);
    return this.#executeTurn(input, excludeMessageIds);
  }

  /**
   * Resolve who this inbound sender is and how the agent should treat them, from
   * the connection's `settings.access` (default recipient = owner candidate).
   * Explicit peer linking is checked separately before owner authority is
   * granted. No access configured → open. The single inbound choke point governs
   * resident chat AND workflow-triggered channels alike.
   */
  #resolveAccess(input: ChannelTurnInput): AccessDecision {
    const row = this.deps.db
      .select({ settings: schema.channelConnections.settings })
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, input.connectionId))
      .get();
    const settings = row?.settings && typeof row.settings === 'object' && !Array.isArray(row.settings)
      ? (row.settings as { access?: ChannelAccess; defaultChatId?: string })
      : {};
    return resolveChannelAccess({
      access: settings.access ?? null,
      defaultChatId: settings.defaultChatId ?? null,
      senderHandle: input.chatId,
      senderName: input.from ?? null,
    });
  }

  /**
   * Run one orchestrator turn and deliver the reply. If a confirmation from a
   * prior turn is pending for this chat and the message is a yes/no, resolve
   * that instead of starting a fresh turn. Never throws.
   */
  async #executeTurn(input: ChannelTurnInput, excludeMessageIds: string[]): Promise<{ replied: boolean; reason?: string }> {
    let ownership = this.deps.handoffs?.current(input.workspaceId, input.conversationId);
    // The configured operator channel is a permanent live control conversation.
    // Any old/manual handoff is stale here, regardless of where it originated.
    if (ownership?.state === 'human' && this.#isOwnerControlPeer(input)) {
      ownership = this.deps.handoffs?.releaseToAgent(input.workspaceId, input.conversationId);
    }
    if (ownership?.state === 'human') return { replied: false, reason: 'human_handling' };
    if (ownership) input = { ...input, automationEpoch: ownership.automationEpoch };
    const clientTurnId = `channel-${randomUUID()}`;
    const active = this.#beginTurn(input, clientTurnId);
    if (!active) return { replied: false, reason: 'superseded' };
    let turnLease: string | undefined;
    try {
      // Record identity before any authority or relationship decision. This is
      // connection-scoped, so an address on another account cannot inherit trust.
      const proactive = input.initiatedBy === 'proactive';
      const senderSummary = proactive ? null : this.#recordIdentity(input);
      // Operator takeover (Living Apps Phase 2): a human is driving this thread, so
      // the resident agent stays quiet. The inbound message is already mirrored for
      // the operator to answer; do not auto-reply.
      if (this.#isHumanDriving(input.conversationId)) {
        this.#publishWorkStep(input, clientTurnId, {
          phase: 'received',
          step: 'handoff',
          description: 'Operator is handling this conversation',
          ...(input.from ? { detail: `From ${input.from}` } : {}),
        });
        return { replied: false, reason: 'human_handling' };
      }
      // Channel access (CHANNEL-ACCESS-10x): the default and listed recipients are
      // answered — unless "answer anyone" is on. A blocked
      // sender is silently ignored by default, or gets a one-line decline if the
      // operator opted into that; an allowed non-owner carries the operator's
      // free-text rules into the turn as guidance (below).
      const configuredOperator = this.#configuredOwnerOperator(input);
      const verifiedAuthority = proactive ? null : this.#verifiedAuthority(input);
      const resolvedAccess: AccessDecision = proactive
        ? { allow: true, isOwner: false, who: input.from?.trim() ?? input.chatId }
        : verifiedAuthority
          ? { allow: true, isOwner: verifiedAuthority === 'owner', who: input.from?.trim() ?? input.chatId }
        : configuredOperator
        ? { allow: true, isOwner: false, who: configuredOperator.name ?? input.from?.trim() ?? input.chatId }
        : this.#resolveAccess(input);
      const ownerVerified = !proactive && this.#isVerifiedConnectionOwner(input);
      // A saved default recipient is a routing convenience, never identity
      // evidence. Until the exact peer is explicitly linked to the owner, it
      // receives external-sender authority even if access rules call it owner.
      const access: AccessDecision = ownerVerified
        ? { ...resolvedAccess, isOwner: true, who: input.from?.trim() || 'the owner' }
        : resolvedAccess.isOwner
          ? { ...resolvedAccess, isOwner: false, who: input.from?.trim() || input.chatId }
          : resolvedAccess;
      if (!access.allow) {
        this.#publishWorkStep(input, clientTurnId, {
          phase: 'received',
          step: 'access',
          description: 'Sender is not authorized for this channel',
          ...(input.from ? { detail: `From ${input.from}` } : {}),
        });
        if (access.deny === 'decline') await this.#persistAndDeliver(input, UNKNOWN_SENDER_DECLINE);
        return { replied: access.deny === 'decline', reason: 'not_authorized' };
      }
      // Owners/delegates control the agent; external principals become durable
      // relationship Subjects and (for Apps) contact projections.
      const contactId = proactive ? this.#contactIdForSubject(input.subjectId) : ownerVerified ? null : this.#touchContact(input);
      const relationship = proactive ? null : this.#touchRelationship(input, contactId);
      const subjectId = input.subjectId ?? relationship?.subject.id ?? null;
      // Conversation State Machine (GAP B1/B3): if the App has a script that owns
      // this contact, it advances the stage (deterministic where scripted — ZERO
      // tokens) and we do NOT run a general agent turn. This is the primitive for
      // "send → await their reply → branch → run a workflow → stop".
      if (!proactive && this.deps.conversation && input.appId) {
        const advanced = await this.deps.conversation.handleInbound({
          workspaceId: input.workspaceId,
          appId: input.appId,
          userId: input.userId,
          ambientId: input.ambientId,
          address: input.chatId,
          text: input.text,
        });
        if (advanced.handled) {
          this.#publishWorkStep(input, clientTurnId, {
            phase: 'received',
            step: 'script',
            description: `Conversation script advanced → ${advanced.stage ?? '—'}`,
            ...(advanced.action ? { detail: advanced.action } : {}),
          });
          return { replied: advanced.sent === true, reason: 'conversation_script' };
        }
      }
      // Multi-party threads (G1): the inbound turn is answered by the active
      // responder — an active 'specialist' agent (warm handoff target) if present,
      // else the primary agent participant, else conversations.agentId (back-compat).
      // The primary is seeded idempotently from conversations.agentId on the way in.
      const responderAgentId = this.#resolveResponder(input);
      const responderRole = this.#agentRole(input.workspaceId, responderAgentId);
      const allowedToolIds = this.#channelToolScope({
        role: responderRole,
        ownerVerified,
        appBound: Boolean(input.appId),
      });
      const immediateCorrectionId = ownerVerified
        ? this.deps.memoryCapture?.captureImmediateCorrection({
            workspaceId: input.workspaceId,
            conversationId: input.conversationId,
            userId: input.userId,
            agentId: responderAgentId,
            userDisplayName: input.from ?? null,
            userMessage: input.text,
            senderTrust: 'owner',
          }) ?? null
        : null;
      const adapter = this.#resolveAdapter(responderAgentId, input.workspaceId);
      if (!adapter) {
        this.#publishWorkStep(input, clientTurnId, {
          phase: 'fail',
          step: 'runtime',
          description: 'Channel reply failed',
          detail: NOT_CONNECTED,
        });
        await this.#persistAndDeliver(input, NOT_CONNECTED, { failureNotice: true });
        return { replied: false, reason: 'no_chat_adapter' };
      }

      // Channels have no composer toggle, so the permission mode is switched by a
      // leading slash command (/ask /plan /auto). A bare command persists the mode
      // and acknowledges; a command with a task ("/plan build X") switches AND runs.
      const modeCommand = parseModeCommand(input.text);
      if (modeCommand) {
        this.#persistPermissionMode(input.conversationId, modeCommand.mode);
        if (!modeCommand.rest) {
          await this.#persistAndDeliver(input, MODE_SWITCH_ACK[modeCommand.mode]);
          return { replied: true };
        }
      }
      const permissionMode = modeCommand?.mode ?? this.#permissionMode(input.conversationId);
      const approvalSensitivity = this.#approvalSensitivity(input.conversationId);
      const rawRuntimeText = modeCommand ? (modeCommand.rest || defaultTaskForMode(permissionMode)) : input.text;
      const preparedInput = await this.#prepareAttachmentContext(input, rawRuntimeText);
      const runtimeText = preparedInput.attachmentContextText ?? rawRuntimeText;

      if (!this.#isActive(input, active)) return { replied: false, reason: 'superseded' };

      // Show "typing…" while the (possibly slow) turn runs; cleared in finally.
      void this.deps.setTyping?.(input.connectionId, input.chatId, true).catch(() => {});

      const pendingKey = `${input.connectionId}:${input.chatId}`;
      const pending = this.#takeFreshPending(pendingKey);
      // A mode command is never a yes/no answer to a pending confirmation.
      const decision = pending && !modeCommand ? interpretConfirmation(input.text) : null;
      const durableDecision = !pending && !modeCommand && ownerVerified ? interpretConfirmation(input.text) : null;
      if (durableDecision !== null && this.deps.channelActions && this.deps.identity) {
        const principal = this.deps.identity.principal({
          workspaceId: input.workspaceId,
          connectionId: input.connectionId,
          channelKind: input.kind,
          handle: input.chatId,
        });
        if (principal.identityId) {
          const action = await this.deps.channelActions.confirmLatestForRequester(
            input.workspaceId,
            principal.identityId,
            durableDecision ? 'approve' : 'reject',
            input.userId,
          );
          if (action) {
            const acknowledgement = action.status === 'delivered'
              ? `Sent to the requested contact.`
              : action.status === 'cancelled'
                ? `Cancelled the pending message.`
                : `The message action is now ${action.status}${action.lastError ? `: ${action.lastError}` : '.'}`;
            await this.#persistAndDeliver(input, acknowledgement);
            return { replied: true, reason: 'durable_action_confirmation' };
          }
        }
      }

      const channelOrigin: ChannelToolOrigin = {
        kind: input.kind,
        connectionId: input.connectionId,
        chatId: input.chatId,
        conversationId: input.conversationId,
        ...(input.automationEpoch !== undefined ? { automationEpoch: input.automationEpoch } : {}),
        ownerVerified,
        ...(() => {
          const explicitRecipients = extractExplicitChannelRecipients(input.kind, runtimeText);
          return explicitRecipients.length ? { explicitRecipients } : {};
        })(),
      };
      turnLease = ChatSessionExecutor.issueTurnLease(input.workspaceId, input.conversationId, { channelOrigin, ...(allowedToolIds ? { allowedToolIds } : {}) });
      active.turnLease = turnLease;

      let stream: AsyncIterable<import('@agentis/core').ChatDelta>;
      let ownerReasoning: OwnerReasoningIndicatorState | undefined;
      if (pending && decision !== null) {
        const runConfirm = this.deps.runConfirm ?? ChatSessionExecutor.confirm.bind(ChatSessionExecutor);
        stream = runConfirm(adapter, pending.turnId, decision, {
          workspaceId: input.workspaceId,
          userId: input.userId,
          conversationId: input.conversationId,
          ...(turnLease ? { turnLease } : {}),
          channelOrigin,
        });
      } else {
        const runTurn = this.deps.runTurn ?? ChatSessionExecutor.turn.bind(ChatSessionExecutor);
        // §G11 — scope this turn's brain recall to the App + this contact + the
        // operating agent (the union), so the agent recalls THIS customer's history
        // and the App's relationships, not the workspace at large. Falls back to the
        // agent's own scope for a non-App turn.
        const recallScopeIds = input.appId
          ? [...new Set([input.appId, ...(contactId ? [contactId] : []), responderAgentId])]
          : undefined;
        const ctx: ChatTurnContext = {
          workspaceId: input.workspaceId,
          ambientId: input.ambientId,
          agentId: responderAgentId,
          userId: input.userId,
          conversationId: input.conversationId,
          durableTurnId: `channel:${input.inboundMessageId ?? `${input.conversationId}:${input.turnGeneration ?? 0}`}`,
          channelContinuation: { ...input, runtimeInputAttachments: undefined },
          ...(input.appId ? { appId: input.appId } : {}),
          ...(recallScopeIds ? { recallScopeIds } : {}),
          clientTurnId,
          executionMode: permissionMode === 'plan' ? 'plan' : 'chat',
          permissionMode,
          approvalSensitivity,
          ...(allowedToolIds ? { allowedToolIds } : {}),
          ...(turnLease ? { turnLease } : {}),
          channelOrigin,
          // Messaging is an interactive surface: the person is already staring
          // at "typing…". Route adapters through their low-latency policy and
          // avoid deep/background transport probes before every reply.
          qualityMode: 'quick',
          maxTurns: 8,
          viewport: null,
          signal: active.controller.signal,
          // A screenshot/media requested inside a channel must survive long
          // enough to be uploaded to that channel after the tool returns.
          artifactPolicy: { mode: 'intentional', saveScreenshots: true, saveGeneratedAssets: true },
        };
        // §G4 — long-horizon memory: fold turns that scrolled out of the live
        // window into a rolling per-conversation summary, then inject it. Bounded,
        // throttled, and non-throwing — never breaks the turn.
        const conversationSummary = await this.#updateAndRenderSummary(input, adapter);
        // App-scoped addendum: tell the resident agent which App it operates and to
        // persist what it learns where the App's surfaces read it (Living Apps §4.2).
        const appAddendum = input.appId ? this.#appOperatingAddendum(input.appId) : null;
        // Non-owner senders carry the operator's per-recipient (or answer-anyone) rules.
        const accessAddendum = buildAccessAddendum(access);
        const audienceAddendum = this.#channelAudienceAddendum(input, ownerVerified);
        const channelMediaAddendum = input.kind === 'whatsapp' || input.kind === 'telegram'
          ? [
              `${input.kind.toUpperCase()} MEDIA DELIVERY`,
              'This conversation can receive native images, videos, audio, voice notes, stickers, and files.',
              `When the person explicitly asks you to create or send visual/media content, use the available Agentis media/artifact tool and then agentis.channel.send with connectionId "${input.connectionId}" and destination "${input.chatId}".`,
              'A media item is sent only after agentis.channel.send returns sent:true. Never claim that you sent or attached media based only on generating, viewing, or saving it.',
              `Do not say that ${input.kind} cannot send an image unless the required tool is genuinely unavailable or its call failed; if it fails, explain the concrete limitation plainly.`,
            ].join('\n')
          : null;
        const relationshipAddendum = subjectId ? this.deps.relationships?.contextBlock(subjectId) ?? null : null;
        const brainAddendum = ownerVerified
          ? [
              'DURABLE BRAIN AVAILABILITY',
              'The Agentis Brain and durable relationship state are available to this turn. Use agentis.brain.search when recall is needed.',
              ...(immediateCorrectionId ? ['Agentis already stored the explicit owner correction in this turn durably; acknowledge it as durable, not session-only.'] : []),
              `When this verified owner asks you to remember a durable correction or fact about your own behavior, use agentis.memory.write with agentId "${responderAgentId}". Never claim that platform memory is unavailable unless an offered Brain tool actually returned an error. Never describe a durable correction as session-only memory.`,
            ].join('\n')
          : null;
        const channelWorldAddendum = ownerVerified ? this.deps.inbox?.compactWorld(input.workspaceId, input.connectionId) ?? null : null;
        const systemAddendum = [permissionMode === 'plan' ? PLAN_MODE_SYSTEM_ADDENDUM : null, audienceAddendum, accessAddendum, brainAddendum, channelWorldAddendum, relationshipAddendum, conversationSummary, appAddendum, channelMediaAddendum]
          .filter((s): s is string => Boolean(s))
          .join('\n\n');
        if (!this.#isActive(input, active)) return { replied: false, reason: 'superseded' };
        stream = runTurn(adapter, this.#buildHistory(input, excludeMessageIds), runtimeText, ctx, {
          channelContext: { kind: input.kind, from: input.from ?? null, chatId: input.chatId, threadId: input.threadId ?? null, senderSummary },
          ...(subjectId ? { sessionKey: `relationship:${subjectId}:${input.appId ?? 'workspace'}` } : {}),
          ...(systemAddendum ? { systemAddendum } : {}),
          ...(preparedInput.runtimeInputAttachments?.length
            ? { inputAttachments: preparedInput.runtimeInputAttachments }
            : {}),
          // One tool owner across every runtime. The selected model emits calls;
          // Agentis executes the bounded catalog and can recover transports
          // without losing channel/inbox capabilities.
          toolMode: 'caller_loop',
          transportRecovery: 'capability_preserving',
          skipRuntimePreflight: true,
          liveInput: () => this.#drainActiveMailbox(active),
        });
      }

      // This is intentionally scheduled independently of activity labels: owner
      // observability is a single generic status, not a relay of runtime/tool data.
      ownerReasoning = this.#scheduleOwnerReasoningIndicator(input);

      let finalText = '';
      let finishReason = 'stop';
      let runtimeError: string | null = null;
      let deliveredByChannelTool = false;
      const generatedAttachments: OutboundAttachmentRef[] = [];
      let confirmation: Extract<import('@agentis/core').ChatDelta, { type: 'confirmation_required' }> | null = null;
      try {
        for await (const delta of stream) {
          this.#recordActiveProgress(active, delta);
          this.#publishDelta(input, clientTurnId, delta);
          if (delta.type === 'text') finalText += delta.delta;
          else if (delta.type === 'confirmation_required') confirmation = delta;
          else if (delta.type === 'tool_result') {
            if (delta.error) runtimeError = delta.error;
            if (delta.name === 'agentis.channel.send' && isCurrentPeerChannelToolDelivery(delta.result, input)) {
              deliveredByChannelTool = true;
            }
            generatedAttachments.push(...toolResultAttachments(delta.name, delta.result));
          }
          else if (delta.type === 'done') finishReason = delta.finishReason;
        }
      } finally {
        this.#cancelOwnerReasoningIndicator(ownerReasoning);
      }

      // MCP-native harnesses execute tools inside the adapter and may not emit a
      // tool_result delta. The turn lease is the cross-adapter evidence ledger;
      // consult it before deciding whether another channel reply is necessary.
      if (turnLease) {
        const experience = ChatSessionExecutor.turnExperience(input.workspaceId, input.conversationId, turnLease);
        const currentPeerDeliveries = experience?.observations.filter((observation) =>
          observation.name === 'agentis.channel.send'
          && observation.ok
          && isCurrentPeerChannelToolDelivery(observation.result, input)) ?? [];
        if (currentPeerDeliveries.length > 0) {
          deliveredByChannelTool = true;
          for (const observation of currentPeerDeliveries) {
            this.#reconcileCurrentPeerToolDelivery(input, observation.args, observation.result);
          }
        }
      }

      if (!this.#isActive(input, active)) return { replied: false, reason: 'superseded' };

      // Strip legacy plan protocol before confirmations, persistence, policy
      // checks, and delivery to any external channel.
      finalText = normalizeAgentPlanText(finalText);

      // A tool needs confirmation: register it and ask the channel to reply yes/no.
      if (confirmation) {
        this.#pending.set(pendingKey, {
          turnId: confirmation.turnId,
          conversationId: input.conversationId,
          expiresAt: Date.now() + CONFIRM_TTL_MS,
        });
        const promptParts = [confirmation.title, finalText.trim(), confirmation.body?.trim(), 'Reply "yes" to confirm or "no" to cancel.'];
        const prompt = promptParts.filter((p): p is string => Boolean(p && p.length)).join('\n\n');
        await this.#persistAndDeliver(input, prompt);
        return { replied: true };
      }

      const body = finalText.trim();
      if (!body) {
        if (finishReason === 'error') {
          const failure = channelTurnFailureMessage(runtimeError);
          this.#publishWorkStep(input, clientTurnId, {
            phase: 'fail',
            step: 'runtime',
            description: 'Channel reply failed',
            detail: failure,
          });
          await this.#persistAndDeliver(input, failure, { failureNotice: true });
          return { replied: true, reason: 'runtime_error' };
        }
        if (generatedAttachments.length > 0 && !deliveredByChannelTool) {
          const attachments = dedupeAttachmentRefs(generatedAttachments);
          const gate = this.#gateAppReply(input, '[Media response]', subjectId);
          if (gate.action !== 'send') return gate.result;
          await this.#persistAndDeliver(input, '', { attachments });
          if (input.appId) this.deps.outboundPolicy?.record(input.appId, 'agent');
          return { replied: true, reason: 'media_only_reply' };
        }
        this.deps.logger.info('channel.turn.empty_reply', {
          connectionId: input.connectionId,
          conversationId: input.conversationId,
          finishReason,
        });
        return { replied: false, reason: 'empty_reply' };
      }

      // Outbound safety envelope (G7): an App-bound reply that crosses a claim or
      // approval line is withheld/held rather than delivered. Rate + quiet limits
      // do NOT gate a direct reply to a human's message (that would silence the
      // desk mid-conversation); they govern the *unsupervised* proactive path. The
      // claim/approval guard applies to every outbound, including replies.
      const gate = this.#gateAppReply(input, body, subjectId);
      if (gate.action !== 'send') {
        return gate.result;
      }

      if (!deliveredByChannelTool) {
        await this.#persistAndDeliver(input, body, {
          ...(generatedAttachments.length ? { attachments: dedupeAttachmentRefs(generatedAttachments) } : {}),
        });
      }
      // Record the agent-initiated outbound against the App's rolling window (G7).
      if (input.appId) this.deps.outboundPolicy?.record(input.appId, 'agent');
      // BRAIN-BLUEPRINT-10X — channel turns form memory exactly like web chat:
      // operator statements + the agent's own learnings flow through the same
      // formation pipeline. Fire-and-forget; capture must never delay a reply.
      if (this.deps.memoryCapture && !proactive) {
        void this.deps.memoryCapture.captureTurn({
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          userId: input.userId,
          agentId: responderAgentId,
          userMessage: runtimeText,
          assistantMessage: body,
          finishReason,
          // §B6.1 — `input.userId` is the CONNECTION OWNER's account id (channel
          // ingress passes `userId: row.userId`), NOT the person who sent this
          // message. Without the two fields below, a stranger's words were
          // captured as if the operator had typed them: labelled `operator_chat`,
          // written to the workspace scope, and — when the text happened to match
          // the correction regex — committed as a `governing` constitutional rule
          // injected into every agent forever. `access` already knew the answer
          // here; it just wasn't being handed over.
          senderTrust: access.isOwner ? 'owner' : 'external',
          ...(access.isOwner ? {} : { senderPeerId: this.#senderPeerScope(input) }),
        }).catch((err: unknown) => {
          this.deps.logger.warn('channel.turn.memory_capture_failed', {
            conversationId: input.conversationId,
            message: (err as Error).message,
          });
        });
      }
      this.deps.logger.info('channel.turn.replied', {
        connectionId: input.connectionId,
        conversationId: input.conversationId,
        chars: body.length,
        finishReason,
      });
      return { replied: true };
    } catch (err) {
      if (err instanceof AgentisError && (err.code === 'CHANNEL_HUMAN_TAKEOVER_ACTIVE' || err.code === 'TURN_CANCELLED')) {
        return { replied: false, reason: 'human_handling' };
      }
      if (this.deps.handoffs?.current(input.workspaceId, input.conversationId).state === 'human') {
        return { replied: false, reason: 'human_handling' };
      }
      if (!this.#isActive(input, active)) {
        this.deps.logger.info('channel.turn.superseded', {
          connectionId: input.connectionId,
          conversationId: input.conversationId,
          durableTurnId: `channel:${input.inboundMessageId ?? `${input.conversationId}:${input.turnGeneration ?? 0}`}`,
          channelContinuation: { ...input, runtimeInputAttachments: undefined },
        });
        return { replied: false, reason: 'superseded' };
      }
      this.deps.logger.error('channel.turn.failed', {
        connectionId: input.connectionId,
        conversationId: input.conversationId,
        err: (err as Error).message,
      });
      const failure = channelTurnFailureMessage(err);
      this.#publishWorkStep(input, clientTurnId, {
        phase: 'fail',
        step: 'runtime',
        description: 'Channel reply failed',
        detail: failure,
      });
      await this.#persistAndDeliver(input, failure, { failureNotice: true });
      return { replied: true, reason: 'error_notified' };
    } finally {
      if (turnLease) ChatSessionExecutor.completeTurnLease(input.workspaceId, input.conversationId, turnLease);
      if (this.#finishTurn(input, active)) {
        void this.deps.setTyping?.(input.connectionId, input.chatId, false).catch(() => {});
      }
      // Clear the App console's live "agent is thinking/typing…" indicator (G9).
      this.#publishAppActivity(input, 'idle');
    }
  }

  /**
   * The resident-agent operating addendum for an App-bound channel turn. Names the
   * App and instructs the agent to treat this as a living relationship — persist
   * what it learns to the App's datastore so its surfaces stay current (§4.2/§4.4).
   * Returns null if the App can't be resolved (degrade to a normal channel turn).
   */
  #appOperatingAddendum(appId: string): string | null {
    try {
      const app = this.deps.db
        .select({ name: schema.apps.name })
        .from(schema.apps)
        .where(eq(schema.apps.id, appId))
        .get();
      if (!app) return null;
      return [
        `You are the resident agent of the Agentic App "${app.name}". This conversation is a living relationship that belongs to the App, not a one-off chat.`,
        `Persist what you learn about this contact (facts, stage, next steps, outcomes) to the App's datastore with data_insert / data_upsert — its surfaces read those collections, so unsaved knowledge never reaches the operator's console. Keep exact records in the datastore; promote only durable lessons to the App's brain.`,
      ].join('\n\n');
    } catch (err) {
      this.deps.logger.warn('channel.turn.app_addendum_failed', { appId, err: (err as Error).message });
      return null;
    }
  }

  /**
   * Gate an App-bound reply through the outbound safety envelope (G7). Only the
   * claim/approval guards apply to a direct reply (a blocked claim is withheld and
   * replaced with a safe notice; a require-approval match is held for the operator
   * via `requestOutboundApproval`). Rate/quiet limits are intentionally NOT applied
   * to a live reply. Non-App turns and an absent policy always 'send'. Non-throwing
   * — any failure degrades to 'send' so the desk is never silently muted.
   */
  #gateAppReply(
    input: ChannelTurnInput,
    body: string,
    subjectId?: string | null,
  ): { action: 'send' } | { action: 'withheld' | 'held'; result: { replied: boolean; reason?: string } } {
    if (!input.appId || !this.deps.outboundPolicy) return { action: 'send' };
    let decision: { allow: boolean; needsApproval: boolean; reason?: string };
    try {
      const autonomy = this.deps.outboundPolicy.evaluateAutonomy(
        input.appId,
        input.initiatedBy === 'proactive' ? 'proactive_followup' : 'inbound_reply',
        subjectId,
      );
      if (autonomy.decision === 'deny') {
        return { action: 'withheld', result: { replied: false, reason: 'autonomy_denied' } };
      }
      if (autonomy.decision === 'require_approval') {
        decision = { allow: false, needsApproval: true, reason: autonomy.reason };
      } else {
      decision = this.deps.outboundPolicy.evaluate(input.appId, { body, source: 'agent' });
      }
    } catch (err) {
      this.deps.logger.warn('channel.turn.outbound_gate_failed', { appId: input.appId, err: (err as Error).message });
      return { action: 'send' };
    }
    // A live reply is governed only by the claim/approval guards. A rate/quiet
    // denial (no approval needed) is a proactive-path concern — let the reply through.
    if (decision.allow || (!decision.needsApproval && !this.#isClaimDenial(decision.reason))) {
      return { action: 'send' };
    }
    if (decision.needsApproval) {
      // Hold the reply for operator approval (in-thread approval, Phase 2 / G7).
      void Promise.resolve(
        this.deps.requestOutboundApproval?.({
          workspaceId: input.workspaceId,
          appId: input.appId,
          conversationId: input.conversationId,
          connectionId: input.connectionId,
          chatId: input.chatId,
          threadId: input.threadId ?? null,
          body,
          reason: decision.reason ?? 'requires approval',
        }),
      ).catch((err) => this.deps.logger.warn('channel.turn.outbound_approval_failed', { appId: input.appId, err: (err as Error).message }));
      this.deps.logger.info('channel.turn.reply_held_for_approval', {
        conversationId: input.conversationId,
        reason: decision.reason,
      });
      return { action: 'held', result: { replied: false, reason: 'held_for_approval' } };
    }
    // A blocked claim — withhold the reply and tell the operator (not the customer).
    this.deps.logger.info('channel.turn.reply_withheld', {
      conversationId: input.conversationId,
      reason: decision.reason,
    });
    return { action: 'withheld', result: { replied: false, reason: 'blocked_claim' } };
  }

  /** A claim-denial reason comes from the blockedClaims guard (vs rate/quiet). */
  #isClaimDenial(reason: string | undefined): boolean {
    return typeof reason === 'string' && reason.startsWith('blocked claim');
  }

  /**
   * Upsert/touch the App contact for an App-bound inbound turn (Phase 3). Returns
   * the contact id (for contact-scoped recall, G11) or null. Never throws.
   */
  #touchContact(input: ChannelTurnInput): string | null {
    if (!input.appId || !this.deps.contacts) return null;
    try {
      // The most stable per-channel handle: sender id for Slack/Discord, chat address for DMs.
      const handle = (input.kind === 'slack' || input.kind === 'discord') ? (input.from ?? input.chatId) : input.chatId;
      return this.deps.contacts.touch({
        workspaceId: input.workspaceId,
        appId: input.appId,
        channelKind: input.kind,
        handle,
        ...(input.from ? { displayName: input.from } : {}),
      });
    } catch (err) {
      this.deps.logger.warn('channel.turn.contact_touch_failed', { appId: input.appId, err: (err as Error).message });
      return null;
    }
  }

  /**
   * Resolve the agent that should answer this inbound turn (G1 multi-party).
   * Seeds the primary participant from conversations.agentId, then picks the active
   * specialist (warm handoff) over the primary; falls back to input.agentId when no
   * participants layer exists. Non-throwing — degrades to input.agentId on error.
   */
  #resolveResponder(input: ChannelTurnInput): string {
    if (!this.deps.participants) return input.agentId;
    try {
      this.deps.participants.ensurePrimary(input.conversationId, input.agentId);
      return this.deps.participants.activeResponderAgent(input.conversationId, input.agentId);
    } catch (err) {
      this.deps.logger.warn('channel.turn.responder_failed', {
        conversationId: input.conversationId,
        err: (err as Error).message,
      });
      return input.agentId;
    }
  }

  /** True when an operator has taken over this thread — the resident agent stays quiet (Phase 2). */
  #isHumanDriving(conversationId: string): boolean {
    const row = this.deps.db
      .select({ handoffState: schema.conversations.handoffState })
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conversationId))
      .get();
    return row?.handoffState === 'human';
  }

  /** Read the conversation's sticky permission mode (default ask). */
  #permissionMode(conversationId: string): ChatPermissionMode {
    const row = this.deps.db
      .select({ permissionMode: schema.conversations.permissionMode })
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conversationId))
      .get();
    return (row?.permissionMode as ChatPermissionMode | undefined) ?? 'ask';
  }

  /** Persist a new sticky permission mode (and the matching executionMode block). */
  #persistPermissionMode(conversationId: string, mode: ChatPermissionMode): void {
    this.deps.db
      .update(schema.conversations)
      .set({
        permissionMode: mode,
        executionMode: mode === 'plan' ? 'plan' : 'chat',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.conversations.id, conversationId))
      .run();
  }

  #scheduleOwnerReasoningIndicator(input: ChannelTurnInput): OwnerReasoningIndicatorState | undefined {
    if (!this.#canShowOwnerReasoningIndicator(input)) return undefined;
    const state: OwnerReasoningIndicatorState = { cancelled: false, sent: false };
    const delay = this.deps.ownerReasoningIndicatorDelayMs ?? OWNER_REASONING_INDICATOR_DELAY_MS;
    state.timer = setTimeout(() => {
      if (state.cancelled || state.sent) return;
      state.sent = true;
      void this.#persistAndDeliver(input, 'Hermes is reasoning', { deliveryClass: 'owner_reasoning_indicator' })
        .catch((err) => this.deps.logger.warn('channel.owner_reasoning_indicator_failed', {
          connectionId: input.connectionId,
          conversationId: input.conversationId,
          err: err instanceof Error ? err.message : String(err),
        }));
    }, Math.max(0, delay));
    state.timer.unref?.();
    return state;
  }

  /** Read the Ask-mode escalation threshold (default balanced). */
  #approvalSensitivity(conversationId: string): ApprovalSensitivity {
    const row = this.deps.db
      .select({ approvalSensitivity: schema.conversations.approvalSensitivity })
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conversationId))
      .get();
    return (row?.approvalSensitivity as ApprovalSensitivity | undefined) ?? 'balanced';
  }

  #cancelOwnerReasoningIndicator(state: OwnerReasoningIndicatorState | undefined): void {
    if (!state) return;
    state.cancelled = true;
    if (state.timer) clearTimeout(state.timer);
  }

  /**
   * Resolve owner authority from an explicit peer link. Neither defaultChatId nor
   * the connection's account userId alone says who authored this inbound message.
   */
  #isVerifiedConnectionOwner(input: ChannelTurnInput): boolean {
    const connection = this.deps.db
      .select({ userId: schema.channelConnections.userId })
      .from(schema.channelConnections)
      .where(and(
        eq(schema.channelConnections.id, input.connectionId),
        eq(schema.channelConnections.workspaceId, input.workspaceId),
      ))
      .get();
    if (!connection?.userId) return false;
    const workspace = this.deps.db
      .select({ userId: schema.workspaces.userId })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, input.workspaceId))
      .get();
    if (!workspace?.userId || workspace.userId !== connection.userId) return false;
    if (!this.deps.identity) return false;
    const handle = (input.kind === 'slack' || input.kind === 'discord') ? (input.from ?? input.chatId) : input.chatId;
    let principal = this.deps.identity.principal({
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      channelKind: input.kind,
      handle,
    });
    // Backfill old connections once: ownerChatId was saved by an authenticated
    // workspace owner, so turn it into the same explicit durable binding used by
    // new configuration. defaultChatId is intentionally never consulted.
    if (principal.role === 'external' && this.#configuredOwnerOperator(input)) {
      this.deps.identity.grantAuthority({
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        channelKind: input.kind,
        handle,
        role: 'owner',
        userId: connection.userId,
        method: 'legacy_authenticated_owner_configuration',
      });
      principal = this.deps.identity.principal({ workspaceId: input.workspaceId, connectionId: input.connectionId, channelKind: input.kind, handle });
    }
    return principal.role === 'owner' && principal.verified && principal.peerKey === `user:${connection.userId}`;
  }

  #agentRole(workspaceId: string, agentId: string): string | null {
    return this.deps.db.select({ role: schema.agents.role }).from(schema.agents).where(and(
      eq(schema.agents.workspaceId, workspaceId),
      eq(schema.agents.id, agentId),
    )).get()?.role ?? null;
  }

  #channelToolScope(args: { role: string | null; ownerVerified: boolean; appBound: boolean }): string[] | undefined {
    // Orchestrators and managers are explicit control-plane roles. Every other
    // role is a bounded resident/specialist, including custom worker role names.
    if (args.role === 'orchestrator' || args.role === 'manager') return undefined;
    return [
      ...BOUNDED_CHANNEL_AGENT_TOOLS,
      ...(args.ownerVerified ? ['agentis.memory.write'] : []),
      ...(args.appBound ? APP_RELATIONSHIP_TOOLS : []),
    ];
  }

  #verifiedAuthority(input: ChannelTurnInput): 'owner' | 'delegate' | null {
    if (!this.deps.identity) return null;
    // Run owner backfill first so legacy ownerChatId configuration joins the
    // canonical principal model before resolving its role.
    if (this.#configuredOwnerOperator(input)) void this.#isVerifiedConnectionOwner(input);
    const handle = (input.kind === 'slack' || input.kind === 'discord') ? (input.from ?? input.chatId) : input.chatId;
    const principal = this.deps.identity.principal({ workspaceId: input.workspaceId, connectionId: input.connectionId, channelKind: input.kind, handle });
    return principal.verified && principal.role !== 'external' ? principal.role : null;
  }

  #contactIdForSubject(subjectId: string | undefined): string | null {
    if (!subjectId) return null;
    return this.deps.db.select({ id: schema.appContacts.id }).from(schema.appContacts)
      .where(eq(schema.appContacts.subjectId, subjectId)).get()?.id ?? null;
  }

  /** Scheduler recovery path for batches that survived a process restart. */
  async flushDurableUtterances(now = new Date().toISOString()): Promise<number> {
    if (!this.deps.utterances) return 0;
    const due = this.deps.utterances.claimDue(now);
    let completed = 0;
    for (const batch of due) {
      try {
        await this.#commitTurn(batch.input, batch.messageIds);
        this.deps.utterances.complete(batch.id);
        completed += 1;
      } catch (err) {
        this.deps.utterances.retry(batch.id);
        this.deps.logger.warn('channel.turn.durable_utterance_failed', { batchId: batch.id, err: (err as Error).message });
      }
    }
    return completed;
  }

  /** Stable channel doctrine shared by every agent identity and App prompt. */
  #channelAudienceAddendum(input: ChannelTurnInput, ownerVerified: boolean): string {
    const configuredOperator = this.#configuredOwnerOperator(input);
    const configuredIdentity = configuredOperator
      ? `, configured as the channel owner/operator${configuredOperator.name ? ` (${configuredOperator.name})` : ''}`
      : '';
    return [
      'CHANNEL AUDIENCE BOUNDARY',
      `You are speaking directly to the person in this ${input.kind} conversation${ownerVerified ? ', whose channel identity is verified as the workspace owner' : configuredIdentity}. Address that person, never an imagined operator watching elsewhere.`,
      ...(configuredOperator && !ownerVerified
        ? ['This chat is configured by the workspace as the owner/operator conversation for natural interaction. That configuration is conversation context only; protected owner-only capabilities remain gated by Agentis identity verification.']
        : []),
      'A normal assistant answer is automatically delivered to this conversation. Do not call agentis.channel.send for a plain text reply to the current person; use it only for native media/bursts, an optional progress message, or an explicitly named different recipient.',
      'If you use agentis.channel.send for this same conversation, set deliveryRole:"progress" for a non-terminal update or deliveryRole:"final" for the answer. Never send a separate tool/delivery confirmation afterward.',
      'Keep runtime state, strategy identifiers, memory counts, tool names, prompts, connection settings, recipient IDs/JIDs, provider receipts, routing diagnostics, and error internals inside Agentis. Give the person only the natural answer or a concise actionable limitation.',
      'When asked to contact someone else, preserve the explicit recipient exactly and verify the tool result. Never replace an explicit recipient with the saved default or with this current conversation.',
    ].join('\n');
  }

  /**
   * Operator configuration helps the model understand the relationship without
   * becoming an authorization shortcut. Privileged behavior still flows only
   * through #isVerifiedConnectionOwner.
   */
  #configuredOwnerOperator(input: ChannelTurnInput): { name: string | null } | null {
    const connection = this.deps.db
      .select({ settings: schema.channelConnections.settings })
      .from(schema.channelConnections)
      .where(and(
        eq(schema.channelConnections.id, input.connectionId),
        eq(schema.channelConnections.workspaceId, input.workspaceId),
      ))
      .get();
    const settings = connection?.settings && typeof connection.settings === 'object' && !Array.isArray(connection.settings)
      ? connection.settings as { ownerChatId?: unknown; ownerName?: unknown }
      : {};
    if (typeof settings.ownerChatId !== 'string' || normalizeHandle(settings.ownerChatId) !== normalizeHandle(input.chatId)) return null;
    return { name: typeof settings.ownerName === 'string' && settings.ownerName.trim() ? settings.ownerName.trim() : null };
  }

  /** Owner/operator control chats never park their own agent. Configuration is
   * the natural-conversation declaration; verified connection-scoped Owner
   * authority is the canonical fallback used by Channel Identities. Delegates
   * intentionally do not qualify. */
  #isOwnerControlPeer(input: ChannelTurnInput): boolean {
    return Boolean(this.#configuredOwnerOperator(input) || this.#isVerifiedConnectionOwner(input));
  }

  /**
   * Mirror an already provider-verified current-peer tool send into conversation
   * history without crossing the transport boundary a second time.
   */
  #reconcileCurrentPeerToolDelivery(input: ChannelTurnInput, rawArgs: unknown, rawResult: unknown): void {
    if (!rawArgs || typeof rawArgs !== 'object' || !rawResult || typeof rawResult !== 'object') return;
    const args = rawArgs as {
      body?: unknown;
      messages?: Array<{ body?: unknown; attachments?: unknown[]; native?: unknown }>;
      attachments?: unknown[];
      native?: unknown;
    };
    const result = rawResult as {
      providerMessageId?: unknown;
      providerMessageIds?: unknown[];
      deliveryStatus?: unknown;
      receipt?: unknown;
    };
    const deliveries = Array.isArray(args.messages) && args.messages.length > 0
      ? args.messages.map((message) => ({
          body: typeof message.body === 'string' ? message.body.trim() : '',
          hasMedia: Boolean(message.attachments?.length || message.native),
        }))
      : [{
          body: typeof args.body === 'string' ? args.body.trim() : '',
          hasMedia: Boolean(args.attachments?.length || args.native),
        }];
    const providerIds = Array.isArray(result.providerMessageIds)
      ? result.providerMessageIds.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
      : typeof result.providerMessageId === 'string' && result.providerMessageId.trim()
        ? [result.providerMessageId.trim()]
        : [];

    deliveries.forEach((delivery, index) => {
      if (!delivery.body && !delivery.hasMedia) return;
      const providerId = providerIds[index] ?? (providerIds.length === 1 ? providerIds[0] : undefined);
      const sessionMessageId = providerId ? `channel_tool_${providerId}` : `channel_tool_${randomUUID()}`;
      if (providerId) {
        const exists = this.deps.db.select({ id: schema.conversationMessages.id })
          .from(schema.conversationMessages)
          .where(and(
            eq(schema.conversationMessages.workspaceId, input.workspaceId),
            eq(schema.conversationMessages.conversationId, input.conversationId),
            eq(schema.conversationMessages.sessionMessageId, sessionMessageId),
          )).get();
        if (exists) return;
      }
      this.deps.conversations.appendMirrored({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        sessionMessageId,
        authorType: 'agent',
        participantSide: 'business',
        body: delivery.body || '[Media sent]',
        deliveryStatus: result.deliveryStatus === 'delivered' || result.deliveryStatus === 'read' ? 'delivered' : 'sent',
        metadata: {
          channel: input.kind,
          channelConnectionId: input.connectionId,
          channelChatId: input.chatId,
          channelReply: true,
          channelToolDelivery: true,
          channelDeliveryClass: 'reply',
          ...(providerId ? { providerMessageId: providerId } : {}),
          ...(result.receipt ? { channelDeliveryReceipt: result.receipt } : {}),
        },
      });
    });
  }

  /**
   * Runtime gate for the sole external diagnostic. A default recipient is not
   * proof of identity: the WhatsApp handle must already be explicitly linked
   * to the connection's owner and to the workspace owner.
   */
  #canShowOwnerReasoningIndicator(input: ChannelTurnInput): boolean {
    if (input.kind !== 'whatsapp') return false;
    const connection = this.deps.db
      .select({ userId: schema.channelConnections.userId, settings: schema.channelConnections.settings })
      .from(schema.channelConnections)
      .where(and(
        eq(schema.channelConnections.id, input.connectionId),
        eq(schema.channelConnections.workspaceId, input.workspaceId),
      ))
      .get();
    if (!connection?.userId) return false;
    const profile = resolveWhatsAppConnectionProfile(
      connection.settings && typeof connection.settings === 'object' && !Array.isArray(connection.settings)
        ? (connection.settings as { whatsappProfile?: unknown }).whatsappProfile
        : undefined,
    );
    if (profile.ownerReasoningVisibility !== 'indicator') return false;
    return this.#isVerifiedConnectionOwner(input);
  }

  /** Persist an externally visible reply with an explicit delivery class. */
  async #persistAndDeliver(
    input: ChannelTurnInput,
    body: string,
    options: {
      failureNotice?: boolean;
      deliveryClass?: Exclude<ChannelDeliveryClass, 'internal'>;
      attachments?: OutboundAttachmentRef[];
    } = {},
  ): Promise<void> {
    this.deps.handoffs?.assertAutomationAllowed({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      ...(input.automationEpoch !== undefined ? { expectedEpoch: input.automationEpoch } : {}),
    });
    const sessionMessageId = `channel_reply_${randomUUID()}`;
    const message = this.deps.conversations.appendMirrored({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      sessionMessageId,
      authorType: 'agent',
      participantSide: 'business',
      body: body || '[Media sent]',
      deliveryStatus: 'sending',
      metadata: {
        channel: input.kind,
        channelConnectionId: input.connectionId,
        channelReply: true,
        channelChatId: input.chatId,
        channelDeliveryClass: options.deliveryClass ?? 'reply',
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(options.failureNotice ? { channelFailureNotice: true } : {}),
        ...('attachments' in options && options.attachments ? { channelAttachments: options.attachments } : {}),
      },
    });
    let receipt: ChannelDeliveryReceipt | null;
    try {
      receipt = await this.#safeDeliver(
        input,
        body,
        sessionMessageId,
        'attachments' in options ? options.attachments : undefined,
      );
    } catch (err) {
      if (err instanceof AgentisError && (err.code === 'CHANNEL_HUMAN_TAKEOVER_ACTIVE' || err.code === 'TURN_CANCELLED')) {
        this.deps.conversations.updateDeliveryStatus({
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          messageId: message.id,
          deliveryStatus: 'failed',
          metadata: { channelAutomationCancelled: true, cancellationReason: err.code },
        });
      }
      throw err;
    }
    const deliveryStatus = !receipt
      ? 'failed'
      : isAcknowledgedChannelDelivery(receipt)
        ? receipt.status === 'delivered' || receipt.status === 'read' ? 'delivered' : 'sent'
        : 'sending';
    this.deps.conversations.updateDeliveryStatus({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      messageId: message.id,
      deliveryStatus,
      ...(receipt ? { metadata: { channelDeliveryReceipt: receipt } } : {}),
    });
  }

  /**
   * Surface the resident agent's live activity in the App console (G9 co-presence):
   * thinking deltas → "agent is thinking…", text deltas → "agent is typing…". Only
   * fires for App-bound turns; ephemeral and best-effort.
   */
  #publishAppActivity(input: ChannelTurnInput, state: 'thinking' | 'typing' | 'idle', label?: string): void {
    if (!this.deps.bus || !input.appId) return;
    publishAppAgentActivity(this.deps.bus, {
      workspaceId: input.workspaceId,
      appId: input.appId,
      conversationId: input.conversationId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      state,
      ...(label ? { label } : {}),
    });
  }

  #publishDelta(input: ChannelTurnInput, clientTurnId: string, delta: ChatDelta): void {
    if (!this.deps.bus) return;
    if (delta.type === 'thinking') {
      this.#publishAppActivity(input, 'thinking', delta.delta);
      publishAgentWorkStep(this.deps.bus, {
        workspaceId: input.workspaceId,
        ambientId: input.ambientId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        clientTurnId,
        phase: 'thinking',
        step: 'thinking',
        description: delta.delta,
      });
      return;
    }
    if (delta.type === 'text') this.#publishAppActivity(input, 'typing');
    publishChatDeltaProgress(this.deps.bus, {
      workspaceId: input.workspaceId,
      ambientId: input.ambientId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      clientTurnId,
    }, delta);
  }

  #publishWorkStep(
    input: ChannelTurnInput,
    clientTurnId: string | null,
    args: { phase: string; step: string; description: string; detail?: string },
  ): void {
    if (!this.deps.bus) return;
    publishAgentWorkStep(this.deps.bus, {
      workspaceId: input.workspaceId,
      ambientId: input.ambientId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      ...(clientTurnId ? { clientTurnId } : {}),
      phase: args.phase,
      step: args.step,
      description: args.description,
      ...(args.detail ? { detail: args.detail } : {}),
    });
  }

  #takeFreshPending(key: string): PendingChannelConfirmation | undefined {
    const pending = this.#pending.get(key);
    if (!pending) return undefined;
    this.#pending.delete(key);
    if (pending.expiresAt <= Date.now()) return undefined;
    return pending;
  }

  /**
   * Record the sender against its cross-channel identity and return a one-line
   * recall summary for the channel context. Uses the most stable per-channel
   * handle: the sender id for Slack/Discord, the chat address for DM channels.
   */
  /**
   * §B6.1 — a stable per-counterparty scope key for memory formed from an
   * EXTERNAL sender, so their knowledge lands in its own bucket instead of the
   * workspace mind. Uses the same handle derivation as `#recordIdentity` so the
   * scope lines up with the cross-channel identity row.
   *
   * Prefixed rather than raw so a channel handle can never collide with an
   * agent/app/workflow id in the shared `scopeId` column.
   */
  #senderPeerScope(input: ChannelTurnInput): string {
    const handle = (input.kind === 'slack' || input.kind === 'discord')
      ? (input.from ?? input.chatId)
      : input.chatId;
    return `contact:${input.kind}:${handle}`;
  }

  #recordIdentity(input: ChannelTurnInput): string | null {
    if (!this.deps.identity) return null;
    try {
      const handle = (input.kind === 'slack' || input.kind === 'discord')
        ? (input.from ?? input.chatId)
        : input.chatId;
      const { summary } = this.deps.identity.recordAndSummarize({
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        channelKind: input.kind,
        handle,
        ...(input.from ? { displayName: input.from } : {}),
      });
      const identity = this.deps.identity.resolve(input.workspaceId, input.kind, handle, input.connectionId);
      if (identity && identity.authorityRole === 'external') {
        this.deps.channelActions?.cancelForPeer(input.workspaceId, identity.id, 'contact replied after this action was planned');
      }
      return summary;
    } catch (err) {
      this.deps.logger.warn('channel.identity.failed', { connectionId: input.connectionId, err: (err as Error).message });
      return null;
    }
  }

  #touchRelationship(input: ChannelTurnInput, contactId: string | null) {
    if (!this.deps.relationships) return null;
    try {
      const handle = (input.kind === 'slack' || input.kind === 'discord') ? (input.from ?? input.chatId) : input.chatId;
      return this.deps.relationships.touch({
        workspaceId: input.workspaceId,
        appId: input.appId ?? null,
        connectionId: input.connectionId,
        channelKind: input.kind,
        handle,
        displayName: input.from ?? null,
        conversationId: input.conversationId,
        contactId,
        inboundText: input.text,
      });
    } catch (err) {
      this.deps.logger.warn('channel.turn.relationship_touch_failed', { conversationId: input.conversationId, err: (err as Error).message });
      return null;
    }
  }

  #resolveAdapter(agentId: string, workspaceId?: string): AgentAdapter | undefined {
    const own = this.deps.adapters.get(agentId)?.adapter;
    if (own?.chat && own.capabilities?.().interactiveChat !== false) return own;
    const fallback = this.deps.fallbackAdapter ?? (() => ChatSessionExecutor.orchestratorAdapter(workspaceId));
    const runtime = fallback();
    if (runtime?.chat) return runtime;
    return undefined;
  }

  #buildHistory(input: ChannelTurnInput, excludeMessageIds: string[] = []): ChatMessage[] {
    const excluded = new Set(excludeMessageIds);
    const rows = this.deps.conversations.messages(input.conversationId, HISTORY_LIMIT);
    const relevant = rows
      .filter((row) => !excluded.has(row.id))
      .filter((row) => !((row.metadata as { channelAutomationCancelled?: boolean } | null)?.channelAutomationCancelled))
      .filter((row) => {
        const meta = (row.metadata ?? {}) as { channelInbound?: boolean; threadId?: string };
        // Keep operator/agent turns and channel-inbound human turns; drop bare
        // platform system notices so they don't pollute the model's context.
        if (row.authorType === 'system' && channelModelRole(row, true) === 'system') return false;
        // Subject isolation: when this turn is in a thread, only include messages
        // from the same thread (untagged agent/operator turns are always kept).
        if (input.threadId && meta.threadId && meta.threadId !== input.threadId) return false;
        return true;
      })
      .map((row) => ({
        role: channelModelRole(row, true) === 'user' ? 'user' as const : 'assistant' as const,
        content: row.body,
      }));
    const bounded: ChatMessage[] = [];
    let chars = 0;
    for (let index = relevant.length - 1; index >= 0; index -= 1) {
      const message = relevant[index]!;
      const cost = message.content.length + 16;
      if (bounded.length > 0 && chars + cost > HISTORY_CHAR_LIMIT) break;
      if (bounded.length === 0 && cost > HISTORY_CHAR_LIMIT) {
        bounded.push({ ...message, content: `${message.content.slice(0, HISTORY_CHAR_LIMIT - 32)}\n[message truncated]` });
        break;
      }
      bounded.push(message);
      chars += cost;
    }
    return bounded.reverse();
  }

  /**
   * Long-horizon per-conversation memory (G4). Folds turns that have scrolled out
   * of the live window into a rolling "state of this relationship" summary and
   * returns the injectable block. Reads a wider slice than the turn window so the
   * summarizer can see what scrolled out; bounded + throttled inside the service.
   * Non-throwing — degrades to no summary, never breaks the turn.
   */
  async #updateAndRenderSummary(input: ChannelTurnInput, adapter: AgentAdapter): Promise<string | null> {
    const summaries = this.deps.summaries;
    if (!summaries) return null;
    try {
      // Read several windows of history so the service can fold everything older
      // than the live window into the summary (bounded — top-K by recency).
      const rows = this.deps.conversations.messages(input.conversationId, HISTORY_LIMIT * SUMMARY_LOOKBACK_WINDOWS);
      const messages = rows
        .filter((row) => {
          // Drop bare platform system notices from the model's conversation context.
          return !(row.authorType === 'system' && channelModelRole(row, true) === 'system');
        })
        .map((row) => ({
          role: channelModelRole(row, true) === 'user' ? 'user' as const : 'assistant' as const,
          content: row.body,
          id: row.id,
          createdAt: row.createdAt,
        }));
      // A chat-capable adapter drives a model-agnostic summary; absent → deterministic.
      const completer = adapter.chat ? new AdapterStructuredCompleter(adapter, 'conversation summary') : null;
      // Compaction is deliberately off the response critical path. The current
      // turn uses the already durable summary + bounded recent transcript; this
      // refresh becomes available to the next turn.
      void summaries.maybeUpdate({
        conversationId: input.conversationId,
        workspaceId: input.workspaceId,
        appId: input.appId ?? null,
        messages,
        windowSize: HISTORY_LIMIT,
        completer,
      }).catch((err) => this.deps.logger.warn('channel.turn.summary_background_failed', {
        conversationId: input.conversationId,
        err: (err as Error).message,
      }));
      return summaries.injectionBlock(input.conversationId);
    } catch (err) {
      this.deps.logger.warn('channel.turn.summary_failed', {
        conversationId: input.conversationId,
        err: (err as Error).message,
      });
      return null;
    }
  }

  async #safeDeliver(
    input: ChannelTurnInput,
    body: string,
    idempotencyKey: string,
    attachments?: OutboundAttachmentRef[],
  ): Promise<ChannelDeliveryReceipt | null> {
    try {
      this.deps.handoffs?.assertAutomationAllowed({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        ...(input.automationEpoch !== undefined ? { expectedEpoch: input.automationEpoch } : {}),
      });
      // Typing is already live while the model is working. Do not add a second,
      // simulated typing delay after the answer is ready.
      return await this.deps.deliver({
        connectionId: input.connectionId,
        chatId: input.chatId,
        body,
        ...(attachments?.length ? { attachments } : {}),
        idempotencyKey,
        pacing: 'immediate',
        conversationId: input.conversationId,
        ...(input.automationEpoch !== undefined ? { expectedAutomationEpoch: input.automationEpoch } : {}),
      }) ?? null;
    } catch (err) {
      if (err instanceof AgentisError && (err.code === 'CHANNEL_HUMAN_TAKEOVER_ACTIVE' || err.code === 'TURN_CANCELLED')) throw err;
      this.deps.logger.warn('channel.turn.deliver_failed', {
        connectionId: input.connectionId,
        err: (err as Error).message,
      });
      return null;
    }
  }

  /**
   * Answer a message in a separate conversational lane while the work lane keeps
   * running. The model receives structured task state, not an intent regex or a
   * canned status prompt, so it can naturally understand a status question,
   * clarification, or changed requirement. The same inbound also remains in the
   * work lane mailbox and joins its next tool/model boundary.
   */
  async #replyAlongsideActiveTurn(
    input: ChannelTurnInput,
    active: ActiveChannelTurn,
    queueId: string,
  ): Promise<{ replied: boolean; reason?: string }> {
    let settle!: (result: { replied: boolean; reason?: string }) => void;
    const result = new Promise<{ replied: boolean; reason?: string }>((resolve) => { settle = resolve; });
    active.companionTail = active.companionTail
      .then(async () => { settle(await this.#runCompanionTurn(input, active, queueId)); })
      .catch((err) => {
        this.deps.logger.warn('channel.turn.companion_queue_failed', {
          connectionId: input.connectionId,
          conversationId: input.conversationId,
          err: (err as Error).message,
        });
        settle({ replied: false, reason: 'joined_active_turn' });
      });
    return result;
  }

  async #runCompanionTurn(
    input: ChannelTurnInput,
    active: ActiveChannelTurn,
    queueId: string,
  ): Promise<{ replied: boolean; reason?: string }> {
    if (active.automationEpoch !== undefined) input = { ...input, automationEpoch: active.automationEpoch };
    if (active.controller.signal.aborted) return { replied: false, reason: 'human_handling' };
    const access = this.#resolveAccess(input);
    if (!access.allow) return { replied: false, reason: 'not_authorized' };
    const responderAgentId = this.#resolveResponder(input);
    const adapter = this.#resolveAdapter(responderAgentId, input.workspaceId);
    const runner = this.deps.runConcurrentTurn
      ?? (this.deps.runTurn ? undefined : ChatSessionExecutor.turn.bind(ChatSessionExecutor));
    if (!adapter || !runner) return { replied: false, reason: 'joined_active_turn' };

    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - active.startedAt) / 1_000));
    const taskSnapshot = {
      taskId: active.clientTurnId,
      status: 'running',
      phase: active.phase,
      elapsedSeconds,
      completedSteps: active.completedSteps,
      objective: active.objective,
    };
    const ctx: ChatTurnContext = {
      workspaceId: input.workspaceId,
      ambientId: input.ambientId,
      agentId: responderAgentId,
      userId: input.userId,
      conversationId: input.conversationId,
      ...(input.appId ? { appId: input.appId } : {}),
      clientTurnId: `channel-companion-${randomUUID()}`,
      executionMode: 'chat',
      permissionMode: 'ask',
      maxTurns: 2,
      viewport: null,
      signal: active.controller.signal,
      artifactPolicy: { mode: 'intentional', saveScreenshots: true, saveGeneratedAssets: true },
    };
    let finalText = '';
    try {
      const preparedInput = await this.#prepareAttachmentContext(input, input.text);
      const stream = runner(
        adapter,
        this.#buildHistory(input, input.inboundMessageId ? [input.inboundMessageId] : []),
        preparedInput.attachmentContextText ?? input.text,
        ctx,
        {
          tools: [],
          qualityMode: 'quick',
          sessionKey: `${input.conversationId}:companion`,
          ...(preparedInput.runtimeInputAttachments?.length
            ? { inputAttachments: preparedInput.runtimeInputAttachments }
            : {}),
          channelContext: { kind: input.kind, from: input.from ?? null, chatId: input.chatId, threadId: input.threadId ?? null },
          systemAddendum: `ACTIVE_TASK_STATE ${JSON.stringify(taskSnapshot)}`,
        },
      );
      for await (const delta of stream) {
        this.#publishDelta(input, ctx.clientTurnId!, delta);
        if (delta.type === 'text') finalText += delta.delta;
      }
      const body = finalText.trim();
      if (body) await this.#persistAndDeliver(input, body);
      this.deps.conversations.consumeQueuedMessage({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        queueId,
      });
      return { replied: Boolean(body), reason: 'active_turn_companion' };
    } catch (err) {
      this.deps.logger.warn('channel.turn.companion_failed', {
        connectionId: input.connectionId,
        conversationId: input.conversationId,
        err: (err as Error).message,
      });
      return { replied: false, reason: 'joined_active_turn' };
    }
  }

  #drainActiveMailbox(active: ActiveChannelTurn): ChatMessage[] {
    const joined = active.mailbox.splice(0);
    for (const item of joined) {
      try {
        this.deps.conversations.consumeQueuedMessage({
          workspaceId: item.input.workspaceId,
          conversationId: item.input.conversationId,
          queueId: item.queueId,
        });
      } catch (err) {
        this.deps.logger.warn('channel.turn.mailbox_consume_failed', { queueId: item.queueId, err: (err as Error).message });
      }
    }
    return joined.map((item) => ({
      role: 'user' as const,
      content: item.input.attachmentContextText ?? item.input.text,
    }));
  }

  async #prepareAttachmentContext(input: ChannelTurnInput, body: string): Promise<ChannelTurnInput> {
    if (!input.attachmentIds?.length || !this.deps.compileAttachments) return input;
    if (body === input.text && input.attachmentContextText) return input;
    // Persistent sessions may have already enriched the binary while downloading
    // it. Keep the durable ids, but do not pay for the same vision/STT/document
    // call twice. The shared compiler is the retry/fallback path.
    if (hasUsableInlineMediaContext(body)) return { ...input, attachmentContextText: body };
    try {
      const compiled = await this.deps.compileAttachments({
        workspaceId: input.workspaceId,
        body,
        attachmentIds: input.attachmentIds,
      });
      return {
        ...input,
        attachmentContextText: compiled.prompt,
        ...(compiled.runtimeInputAttachments?.length
          ? { runtimeInputAttachments: compiled.runtimeInputAttachments }
          : {}),
      };
    } catch (err) {
      this.deps.logger.warn('channel.turn.attachment_context_failed', {
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        attachmentIds: input.attachmentIds,
        err: (err as Error).message,
      });
      return input;
    }
  }

  #recordActiveProgress(active: ActiveChannelTurn, delta: ChatDelta): void {
    if (delta.type === 'thinking') active.phase = 'thinking';
    if (delta.type === 'activity') {
      active.phase = delta.phase === 'waiting' ? 'waiting' : delta.phase === 'runtime' ? 'thinking' : 'working';
      if (delta.status === 'success') active.completedSteps += 1;
    }
    if (delta.type === 'tool_call') active.phase = 'working';
    if (delta.type === 'tool_result' && !delta.error) active.completedSteps += 1;
  }

  #turnKey(input: Pick<ChannelTurnInput, 'connectionId' | 'chatId'>): string {
    return `${input.connectionId}:${input.chatId}`;
  }

  /** Stamp a new work lane when this chat has no active task. */
  #acceptInbound(input: ChannelTurnInput): ChannelTurnInput {
    const key = this.#turnKey(input);
    const generation = (this.#turnGenerations.get(key) ?? 0) + 1;
    this.#turnGenerations.set(key, generation);
    return { ...input, turnGeneration: generation };
  }

  /** Begin only if this still represents the latest message from the chat. */
  #beginTurn(input: ChannelTurnInput, clientTurnId: string): ActiveChannelTurn | null {
    const key = this.#turnKey(input);
    const generation = input.turnGeneration ?? this.#turnGenerations.get(key) ?? 1;
    if ((this.#turnGenerations.get(key) ?? generation) !== generation) return null;
    const active: ActiveChannelTurn = {
      conversationId: input.conversationId,
      ...(input.automationEpoch !== undefined ? { automationEpoch: input.automationEpoch } : {}),
      generation,
      controller: new AbortController(),
      clientTurnId,
      objective: input.text,
      startedAt: Date.now(),
      phase: 'thinking',
      completedSteps: 0,
      mailbox: [],
      companionTail: Promise.resolve(),
    };
    this.#activeTurns.set(key, active);
    return active;
  }

  #isActive(input: ChannelTurnInput, active: ActiveChannelTurn): boolean {
    const key = this.#turnKey(input);
    return this.#activeTurns.get(key) === active
      && this.#turnGenerations.get(key) === active.generation
      && !active.controller.signal.aborted;
  }

  /** Returns true only for the owner of the live typing presence. */
  #finishTurn(input: ChannelTurnInput, active: ActiveChannelTurn): boolean {
    const key = this.#turnKey(input);
    if (this.#activeTurns.get(key) !== active) return false;
    this.#activeTurns.delete(key);
    return true;
  }
}

function hasUsableInlineMediaContext(body: string): boolean {
  const value = body.toLowerCase();
  if (value.includes('[voice note transcript]')) return true;
  if (value.includes('\ntranscript:\n') && !value.includes('transcription is unavailable')) return true;
  if (value.includes('visual analysis:') && !value.includes('visual analysis is unavailable')) return true;
  if (value.includes('preview-frame analysis:')) return true;
  if (value.includes('[document received') && !value.includes('text extraction is unavailable')) return true;
  return false;
}

/**
 * Interpret a channel reply as a yes/no decision, or null when it's neither (so
 * the message is treated as a fresh request instead). Supports English +
 * Portuguese affirmatives/negatives and the common thumbs emoji.
 */
export function interpretConfirmation(text: string): boolean | null {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, '');
  if (/^(y|yes|yeah|yep|yup|ok|okay|sure|confirm|confirmed|approve|approved|do it|go ahead|go|👍|✅|sim|pode|aprovar|confirmar)$/.test(t)) {
    return true;
  }
  if (/^(n|no|nope|nah|cancel|stop|reject|rejected|don'?t|do not|abort|não|nao|cancelar|rejeitar|👎|❌)$/.test(t)) {
    return false;
  }
  return null;
}

/** Deliberately narrow: ordinary short follow-up bubbles belong to the active turn. */
export function isExplicitActiveStatusRequest(text: string): boolean {
  const value = text.trim().toLowerCase();
  if (!value || value.length > 140) return false;
  return /^(status|progress|update|how('?s| is) it going|are you (still )?(working|there)|what are you doing|andamento|status|progresso|como (está|esta) indo|ainda (está|esta) (trabalhando|aí|ai))\s*[?!.]*$/iu.test(value);
}

function channelTurnFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const detail = raw.trim();
  if (isCreditOrQuotaError(detail)) {
    return 'I could not answer because the connected model runtime is out of credits, quota, or billing access. Add credits or switch the Conversation runtime in Agentis settings, then send the message again.';
  }
  if (/cancell?ed|aborted/i.test(detail)) {
    return 'The channel turn was cancelled before the agent could finish. Send the message again when the runtime is available.';
  }
  if (/timeout|timed out|deadline/i.test(detail)) {
    return 'The agent runtime timed out before it could answer this channel message. The turn is visible in Agentis, and you can retry after the runtime is responsive.';
  }
  // Raw provider/database/runtime errors belong in the operator log and activity
  // feed, never in a customer conversation. In particular this prevents SQL
  // constraint names, filesystem paths, credentials, and provider payloads from
  // being echoed verbatim over WhatsApp.
  return 'I’m having trouble answering right now. Please try again in a moment.';
}

function isCreditOrQuotaError(message: string): boolean {
  return /insufficient[_\s]?quota/i.test(message)
    || /insufficient[_\s]?(funds|credit|credits|balance)/i.test(message)
    || /out of credits?/i.test(message)
    || /billing|payment required|quota exceeded|exceeded your current quota/i.test(message)
    || /\bno credits?\b/i.test(message);
}

function isCurrentPeerChannelToolDelivery(result: unknown, input: ChannelTurnInput): boolean {
  if (!result || typeof result !== 'object') return false;
  const value = result as {
    sent?: unknown;
    verified?: unknown;
    connectionId?: unknown;
    to?: unknown;
    deliveryRole?: unknown;
    receipt?: { recipient?: unknown; providerRecipient?: unknown };
  };
  if (value.sent !== true || value.verified !== true || value.connectionId !== input.connectionId) return false;
  if (value.deliveryRole === 'progress') return false;
  const recipient = typeof value.to === 'string'
    ? value.to
    : typeof value.receipt?.providerRecipient === 'string'
      ? value.receipt.providerRecipient
      : typeof value.receipt?.recipient === 'string' ? value.receipt.recipient : '';
  if (!recipient) return false;
  if (input.kind !== 'whatsapp' && input.kind !== 'telegram') {
    return recipient.trim().toLowerCase() === input.chatId.trim().toLowerCase();
  }
  const actual = normalizeHandle(recipient);
  const current = normalizeHandle(input.chatId);
  return Boolean(actual && current && actual === current);
}

/** Extract explicit WhatsApp recipients conservatively; ordinary numbers/dates do not qualify. */
export function extractExplicitChannelRecipients(kind: string, text: string): string[] {
  if (kind !== 'whatsapp') return [];
  const matches = text.match(/(?:\+\d[\d\s().-]{6,}\d|\d{8,20}@s\.whatsapp\.net)/giu) ?? [];
  return [...new Set(matches.flatMap((match) => {
    const digits = match.replace(/@s\.whatsapp\.net$/iu, '').replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 20 ? [`${digits}@s.whatsapp.net`] : [];
  }))];
}

/** Turn saved screenshot/media tool outputs into deterministic channel attachments. */
function toolResultAttachments(name: string, result: unknown): OutboundAttachmentRef[] {
  if (name !== 'agentis.browser.screenshot' && name !== 'agentis.media.generate') return [];
  if (!result || typeof result !== 'object') return [];
  const value = result as {
    saved?: unknown;
    ref?: unknown;
    mimeType?: unknown;
    modality?: unknown;
    assets?: Array<{ ref?: unknown; mimeType?: unknown; name?: unknown }>;
  };
  const entries = Array.isArray(value.assets) && value.assets.length > 0
    ? value.assets
    : [{ ref: value.ref, mimeType: value.mimeType }];
  return entries.flatMap((entry, index) => {
    if (typeof entry.ref !== 'string' || !entry.ref.trim()) return [];
    const mimeType = typeof entry.mimeType === 'string' ? entry.mimeType : undefined;
    const modality = typeof value.modality === 'string' ? value.modality : undefined;
    const kind: OutboundAttachmentRef['kind'] = modality === 'speech'
      ? 'voice'
      : modality === 'audio'
        ? 'audio'
      : modality === 'video' ? 'video'
        : mimeType?.startsWith('audio/') ? 'audio'
          : mimeType?.startsWith('video/') ? 'video'
            : mimeType?.startsWith('image/') ? 'image'
              : 'file';
    const filename = typeof entry.name === 'string' && entry.name.trim()
      ? entry.name.trim()
      : name === 'agentis.browser.screenshot' ? 'screenshot.png' : `generated-${index + 1}`;
    return [{ url: entry.ref.trim(), kind, filename, ...(mimeType ? { mimeType } : {}) }];
  });
}

function dedupeAttachmentRefs(attachments: OutboundAttachmentRef[]): OutboundAttachmentRef[] {
  const seen = new Set<string>();
  return attachments.filter((attachment) => {
    const key = `${attachment.url ?? attachment.artifactId ?? ''}:${attachment.kind ?? ''}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Strip internal/planning leakage from a channel-bound agent reply. */
function sanitizeChannelReply(text: string): string {
  if (!text) return text;

  const raw = text.trim();
  if (!raw) return raw;

  const internalPatterns: RegExp[] = [
    /^(robson|paty|alexandre|cliente|lead)\s+pediu\s+para/i,
    /^(robson|paty|alexandre|cliente|lead)\s+perguntou/i,
    /^(robson|paty|alexandre|cliente|lead)\s+disse/i,
    /^vou\s+primeiro/i,
    /^primeiro\s+eu\s+vou/i,
    /^agora\s+eu\s+preciso/i,
    /^o\s+que\s+está\s+faltando/i,
    /^agora\s+eu\s+vou/i,
    /^vou\s+revisar/i,
    /workspace\s+atual/i,
    /app\s+talki/i,
    /token\s+de\s+acesso/i,
    /portal\s+expir/i,
    /autenticação\s+da\s+plataforma/i,
    /workflows?\s+respons/i,
    /agente\s+atendente\s+\(chamado/i,
    /fluxo\s+de\s+atendimento\s+inbound/i,
    /configurado\s+e\s+conectado/i,
    /talki\s+já\s+está\s+configurad/i,
    /esta[mp]\s+parado/i,
    /esta[mp]\s+parada/i,
  ];

  // Sentence-level filter: keep only segments that do not look like internal
  // reasoning / platform status / planning narration.
  const segments = raw
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => {
      if (!s) return false;
      const lower = s.toLowerCase();
      if (internalPatterns.some((rx) => rx.test(lower))) return false;
      return true;
    });

  const cleaned = segments.join(' ').trim();
  return cleaned || '';
}

function channelLabel(kind: string): string {
  if (!kind) return 'Channel';
  return `${kind.slice(0, 1).toUpperCase()}${kind.slice(1)}`;
}
