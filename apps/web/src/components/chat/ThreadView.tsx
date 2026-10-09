import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Clock3, Copy, FileText, Loader2, Pencil, Plug, Redo2, Send, ShieldCheck, Undo2, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { initialTurnActivityLabel, normalizeAgentPlanText, normalizeToolInvocation, parseChatPermissionDirective, REALTIME_EVENTS, type ChatCommentary, type ChatContextManifest, type ChatDelta, type ChatExecutionEnvelope, type ChatPermissionMode, type ChatPlan, type ChatSwarm, type ChatTurnTrace, type TurnChangeActionResult, type TurnChangeConflict, type TurnChangeSummary, type ViewportContext } from '@agentis/core';
import { PermissionModePicker } from './PermissionModePicker';
import { api, apiErrorMessage, streamSse, type ApiError } from '../../lib/api';
import { useViewportAwareness } from '../../lib/viewportContext';
import { listInteractions, type InteractionEvent } from '../../lib/connections';
import { useToast } from '../shared/Toast';
import { Skeleton } from '../shared/Skeleton';
import { rtSubscribe, useRealtime } from '../../lib/realtime';
import { Composer, type SendAttachment } from './Composer';
import type { ToolCallData as ToolCallPillData } from './toolCalls';
import type { ProactiveCardData } from './ProactiveCard';
import { ChatMarkdown } from './ChatMarkdown';
import { useChatPanelStore } from './ChatPanelStore';
import { AgentTurnTrace } from './AgentTurnTrace';
import { ChatSwarmTrace } from './ChatSwarmTrace';
import { dedupeMessages, mergeMessage, prependUnique, sortMessages, upsertMessage } from './messageModel';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import { ChatArtifactAttachments, collectArtifactIds } from './ArtifactAttachments';
import type { DurableConversationTurn, DurableConversationTurnHistory } from './durableTurn';

interface ThreadViewProps {
  kind: 'room' | 'agent';
  id: string;
  name: string;
  initialDraft?: string;
  initialViewportOverride?: ViewportContext | null;
  autoSendInitialDraft?: boolean;
  conversationId?: string | null;
  archivedAt?: string | null;
  composerPlaceholder?: string;
  emptyBody?: string;
  onInitialDraftUsed?: () => void;
  onConversationReset?: (conversationId: string) => void;
  immersive?: boolean;
}

type AgentMsg = {
  id: string;
  role?: string;
  authorType?: string;
  authorId?: string | null;
  body: string;
  createdAt: string;
  metadata?: MessageMeta;
  deliveryStatus?: 'sending' | 'sent' | 'delivered' | 'failed' | 'mirrored';
};

/** A message sent while a turn was already streaming — durably queued
 * server-side and auto-dispatched, oldest first, once the turn ends. */
type QueuedItem = {
  id: string;
  conversationId?: string;
  text: string;
  attachments?: string[] | null;
  createdAt: string;
  position: number;
};

type AgentConversation = {
  id: string;
  executionMode?: 'chat' | 'plan';
};

type ChatActivity = Extract<ChatDelta, { type: 'activity' }>;

type RoomMsg = {
  id: string;
  authorType: string;
  authorId?: string | null;
  contentType?: string;
  content: Record<string, unknown>;
  createdAt: string;
};

interface MessageMeta {
  source?: 'openclaw_exec' | 'openclaw_session' | 'workflow' | 'manual' | 'proactive' | 'chat_loop' | 'chat_confirmation' | 'tool_call';
  clientTurnId?: string;
  card?: ProactiveCardData;
  activity?: Array<Extract<ChatDelta, { type: 'activity' }>>;
  commentary?: ChatCommentary[];
  turn?: ChatTurnTrace;
  toolCalls?: ToolCallPillData[];
  confirmation?: ConfirmationCardData;
  runId?: string;
  workflowId?: string | null;
  runStatus?: string;
  runTitle?: string | null;
  isEphemeral?: boolean;
  /** Composer file/photo uploads carried with this message — artifact ids. */
  artifactIds?: string[];
  plan?: ChatPlan;
  executionEnvelope?: ChatExecutionEnvelope;
  contextManifest?: ChatContextManifest;
  swarms?: ChatSwarm[];
  durableTurnId?: string;
  /** Server-confirmed ordering for a turn that has not begun provider work. */
  queued?: boolean;
  queuePosition?: number;
  queueCancelled?: boolean;
  /** Concrete runtime failure preserved even when partial work already exists. */
  failureMessage?: string;
  /** Durable, redacted Undo/Redo state owned by this assistant turn. */
  changeSet?: TurnChangeSummary | null;
}

interface TurnChangePrompt {
  turnId: string;
  direction: 'undo' | 'redo';
  kind: 'confirm' | 'conflict';
  summary: TurnChangeSummary;
  conflicts?: TurnChangeConflict[];
}

type ConfirmationStatus = 'pending' | 'approving' | 'approved' | 'cancelled' | 'failed';

interface ConfirmationCardData {
  turnId: string;
  toolCall: {
    id: string;
    name: string;
    args: unknown;
  };
  title: string;
  body: string;
  impact?: {
    summary: string;
    details?: string[];
    riskLevel?: 'low' | 'medium' | 'high' | 'danger';
    reversible?: boolean;
    externalSideEffects?: boolean;
  };
  confirmLabel: string;
  cancelLabel: string;
  expiresAt: string;
  status: ConfirmationStatus;
}

interface AppThreadHandoff {
  handoff: 'app_thread.open';
  slug: string;
  targetUrl?: string;
  carriedMessage?: string | null;
  reason?: string | null;
}

interface ChatMessage {
  id: string;
  authorId: string;
  authorName?: string;
  authorKind: 'operator' | 'agent' | 'system';
  text: string;
  artifactIds?: string[];
  createdAt: string;
  source?: string;
  metadata?: MessageMeta;
  deliveryStatus?: 'sending' | 'sent' | 'delivered' | 'failed' | 'mirrored';
}

interface AgentRuntimeInfo {
  adapterType?: string | null;
  runtimeModel?: string | null;
  adapterCapabilities?: {
    interactiveChat: boolean;
    toolCalling: boolean;
    toolForwarding?: string;
    limitations?: string[];
  } | null;
}

const PAGE_SIZE = 50;

function streamErrorMessage(data: unknown): string {
  if (data && typeof data === 'object') {
    const message = (data as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return explainChatFailure(message.trim());
  }
  if (typeof data === 'string' && data.trim()) return explainChatFailure(data.trim());
  return 'The agent runtime reported an error. Check the runtime settings and try again.';
}

function explainChatFailure(message: string): string {
  if (/\b402\b|requires more credits|add more credits|insufficient(?:[_\s]+\w+)?[_\s]+credits?|out of credits?|no credits?|insufficient[_\s]?(?:quota|funds|balance)|quota exceeded|exceeded your current quota|billing|payment required/i.test(message)) {
    return `${message} The selected model provider is out of credits or quota. Add credits or choose another model, then retry.`;
  }
  return message;
}

function withChatFailure(message: ChatMessage, failureMessage: string): ChatMessage {
  return {
    ...message,
    deliveryStatus: 'failed',
    metadata: { ...(message.metadata ?? {}), failureMessage },
  };
}

function taskLabel(message: string): string {
  const firstLine = message.trim().split('\n')[0] ?? '';
  const clean = firstLine.replace(/\s+/g, ' ').trim();
  if (!clean) return 'Working…';
  return clean.length > 48 ? `${clean.slice(0, 47)}…` : clean;
}

function immediateTurnActivity(clientTurnId: string, agentId: string, message: string, startedAt: string): Extract<ChatDelta, { type: 'activity' }>[] {
  const label = initialTurnActivityLabel(message);
  if (label === 'Request received') return [];
  return [{
    type: 'activity',
    id: `activity-${clientTurnId}-received`,
    phase: 'received',
    status: 'running',
    label,
    clientTurnId,
    agentId,
    startedAt,
  }];
}

/** Fallback body text when a message carries attachments but no caption — the backend requires a non-empty body. */
function defaultAttachmentCaption(attachments: SendAttachment[]): string {
  const names = attachments.map((a) => a.name).join(', ');
  return attachments.length === 1 ? `📎 ${names}` : `📎 Sent ${attachments.length} files: ${names}`;
}

function createClientTurnId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `turn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Normalize an @handle the same way the backend broadcast dispatcher does. */
function normalizeAgentHandle(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Resolve @handles in `text` to known agent ids (mirrors the server's matcher). */
function resolveMentionedAgentIds(text: string, agentMap: Record<string, { name: string }>): string[] {
  const handles = new Set<string>();
  for (const match of text.matchAll(/@([a-z0-9._-]{2,40})/gi)) {
    const handle = normalizeAgentHandle(match[1] ?? '');
    if (handle) handles.add(handle);
  }
  if (handles.size === 0) return [];
  const ids: string[] = [];
  for (const [id, agent] of Object.entries(agentMap)) {
    if (handles.has(normalizeAgentHandle(agent.name))) ids.push(id);
  }
  return ids;
}

function normalizeAgentMessage(message: AgentMsg): ChatMessage {
  return {
    id: message.id,
    authorId: message.authorId ?? '',
    authorKind: (message.role ?? message.authorType ?? 'agent') as ChatMessage['authorKind'],
    text: message.body,
    artifactIds: message.metadata?.artifactIds,
    createdAt: message.createdAt,
    source: message.metadata?.source,
    metadata: message.metadata,
    deliveryStatus: message.deliveryStatus,
  };
}

function normalizeRoomMessage(message: RoomMsg): ChatMessage {
  const content = message.content ?? {};
  return {
    id: message.id,
    authorId: message.authorId ?? '',
    authorKind: message.authorType as ChatMessage['authorKind'],
    text:
      typeof content.text === 'string'
        ? content.text
        : typeof content.caption === 'string'
          ? content.caption
          : '',
    artifactIds: extractArtifactIdsFromRoomContent(message.contentType, content),
    createdAt: message.createdAt,
  };
}

function extractArtifactIdsFromRoomContent(contentType: string | undefined, content: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  collectArtifactIds(content, ids);
  if ((contentType === 'image' || contentType === 'document' || contentType === 'artifact_card') && typeof content.artifactId === 'string') {
    ids.add(content.artifactId);
  }
  return [...ids];
}

function removeKeys<T>(record: Record<string, T>, keys: Iterable<string>): Record<string, T> {
  const remove = new Set(keys);
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!remove.has(key)) next[key] = value;
  }
  return next;
}

function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function roomRealtimeActivity(event: string, payload: Record<string, unknown>): ChatActivity | null {
  const agentId = firstString(payload, ['agentId']);
  if (!agentId) return null;
  const at = firstString(payload, ['at', 'timestamp']) ?? new Date().toISOString();
  if (event === REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL) {
    const rawTool = firstString(payload, ['tool', 'toolName', 'name', 'command']) ?? 'tool';
    const tool = normalizeToolInvocation(rawTool, payload.args ?? payload.input).tool;
    return {
      type: 'activity',
      id: `room-tool-${agentId}-${tool}-${at}`,
      phase: 'tool',
      status: 'running',
      label: `Using ${tool}`,
      startedAt: at,
      agentId,
    };
  }
  if (event === REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE) {
    return {
      type: 'activity',
      id: `room-message-${agentId}-${at}`,
      phase: 'runtime',
      status: 'running',
      label: 'Agent is working',
      startedAt: at,
      agentId,
    };
  }
  if (event === REALTIME_EVENTS.AGENT_WORK_STEP) {
    const phase = firstString(payload, ['phase', 'status']);
    const failed = phase === 'fail' || phase === 'failed' || phase === 'error';
    const complete = phase === 'complete' || phase === 'completed' || phase === 'success';
    return {
      type: 'activity',
      id: `room-work-${agentId}-${firstString(payload, ['phase', 'status']) ?? 'step'}-${at}`,
      phase: failed ? 'error' : complete ? 'complete' : 'runtime',
      status: failed ? 'error' : complete ? 'success' : 'running',
      label: failed ? 'Agent step failed' : complete ? 'Agent step completed' : 'Agent is working',
      startedAt: at,
      agentId,
    };
  }
  return null;
}

function normalizeInteractionMessage(event: InteractionEvent): ChatMessage {
  let text = event.summary;

  // Transform A2A messages into conversational slack-like text
  if (event.kind === 'message') {
    // "Actor → Target: Message" or similar
    // We just want it to look like it naturally flows.
    // If it has an arrow indicating a target, let's try to extract it.
    const parts = text.split('→');
    if (parts.length > 1) {
      const rightSide = parts[1]!.trim();
      const colonIdx = rightSide.indexOf(':');
      if (colonIdx > 0) {
        const target = rightSide.substring(0, colonIdx).trim();
        const content = rightSide.substring(colonIdx + 1).trim();
        // Remove quotes if present
        const unquoted = content.replace(/^"|"$/g, '');
        text = `**@${target}** ${unquoted}`;
      }
    }
  } else if (event.kind === 'consultation' && event.consultation) {
    const dialogue = event.consultation.messages
      .filter((message) => message.kind === 'question' || message.kind === 'answer')
      .map((message) => {
        const speaker = message.authorAgentId === event.consultation!.caller.id
          ? event.consultation!.caller.name
          : event.consultation!.target.name;
        return `**${speaker}:** ${message.body}`;
      })
      .join('\n\n');
    const fallback = event.consultation.substituted
      ? '\n\n_The requested agent was unavailable; a compatible specialist was substituted._'
      : '';
    text = `**${event.summary}**${fallback}${dialogue ? `\n\n${dialogue}` : ''}`;
  }

  return {
    id: `interaction-${event.id}`,
    authorId: event.actor.id ?? 'system',
    authorName: event.consultation?.caller.name ?? event.actor.id ?? 'System',
    authorKind: event.actor.type === 'agent' ? 'agent' : 'system',
    text,
    createdAt: event.at,
  };
}

export function blockedTurnNotice(error?: string | null): { title: string; body: string; action: string } | null {
  const message = error?.trim() ?? '';
  if (/acceptance verification|completion.*verification|blocked by verification/i.test(message)) {
    // Verification is execution metadata, not a user action. The result and its
    // evidence remain inspectable in the turn timeline; never nag the person
    // with an internal bookkeeping card after the agent has answered.
    return null;
  }
  if (/capacity|overloaded|rate.?limit|quota|credits?|billing|payment required|temporarily unavailable|no healthy runtime/i.test(message)) {
    return {
      title: 'Runtime unavailable',
      body: message || 'The selected model is temporarily unavailable. Retry this turn or choose another model.',
      action: 'Retry',
    };
  }
  return {
    title: 'Work paused',
    body: message || 'The turn stopped at a concrete blocker. Resume when you want the agent to continue from that point.',
    action: 'Resume',
  };
}

function runtimeCapabilityWarning(runtime: AgentRuntimeInfo | null): { title: string; body: string } | null {
  const capabilities = runtime?.adapterCapabilities;
  if (!capabilities) return null;
  const limitation = capabilities.limitations?.find((item) => item.trim())?.trim();
  if (!capabilities.interactiveChat) {
    return {
      title: 'Runtime is task-only',
      body: limitation ?? 'This agent can run workflow tasks, but it is not wired into the live chat loop yet.',
    };
  }
  if (!capabilities.toolCalling) {
    return {
      title: 'Chat tools unavailable',
      body: limitation ?? 'This runtime can chat, but it cannot execute Agentis tools from chat yet. Build and run requests may stay advisory.',
    };
  }
  return null;
}

function defaultRuntimeModel(adapterType?: string | null): string | null {
  if (adapterType === 'codex') return 'gpt-5.5';
  if (adapterType === 'claude_code') return 'claude-sonnet-5';
  if (adapterType === 'cursor') return 'auto';
  if (adapterType === 'hermes_agent') return 'hermes-auto';
  if (adapterType === 'openclaw') return 'gateway-default';
  if (adapterType === 'http') return 'provider-default';
  return null;
}

/** Read a persisted permission mode from localStorage, validating the value. */
function readStoredPermissionMode(key: string): ChatPermissionMode | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === 'ask' || raw === 'plan' || raw === 'auto' ? raw : null;
  } catch {
    return null;
  }
}

export function ThreadView({
  kind,
  id,
  name,
  initialDraft,
  initialViewportOverride,
  autoSendInitialDraft,
  conversationId,
  archivedAt,
  composerPlaceholder,
  emptyBody,
  onInitialDraftUsed,
  onConversationReset,
  immersive = false,
}: ThreadViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Queue-then-auto-continue composer: messages sent while a turn was already
  // streaming. Persisted server-side (survives a reload) and rendered as
  // dimmed "queued" bubbles until they're auto-dispatched into a real turn.
  const [pendingQueue, setPendingQueue] = useState<QueuedItem[]>([]);
  const dispatchedQueueIdsRef = useRef<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [turnChangeBusyId, setTurnChangeBusyId] = useState<string | null>(null);
  const [turnChangePrompt, setTurnChangePrompt] = useState<TurnChangePrompt | null>(null);
  const [agentMap, setAgentMap] = useState<Record<string, { name: string; role?: string | null; colorHex?: string | null }>>({});

  useEffect(() => {
    api<{ agents: Array<{ id: string; name: string; role?: string | null; colorHex?: string | null }> }>('/v1/agents')
      .then((res) => {
        const map: Record<string, { name: string; role?: string | null; colorHex?: string | null }> = {};
        for (const a of res.agents) map[a.id] = { name: a.name, role: a.role, colorHex: a.colorHex };
        setAgentMap(map);
      })
      .catch(() => {});
  }, []);
  const [agentNoAdapter, setAgentNoAdapter] = useState(false);
  const [agentRuntime, setAgentRuntime] = useState<AgentRuntimeInfo | null>(null);
  const [loadedConversationId, setLoadedConversationId] = useState<string | null>(conversationId ?? null);
  const [agentTyping, setAgentTyping] = useState(false);
  // Room loading state: which @mentioned agents we're still waiting on for
  // reply (posted after the mention) shows up. A safety timer caps the wait.
  const [pendingResponders, setPendingResponders] = useState<string[]>([]);
  const [roomResponderActivities, setRoomResponderActivities] = useState<Record<string, ChatActivity[]>>({});
  const broadcastPostAtRef = useRef<string | null>(null);
  const broadcastPendingTimerRef = useRef<number | null>(null);
  const [composerInitialText, setComposerInitialText] = useState(initialDraft ?? '');
  // Per-conversation permission mode (ask | plan | auto). Sticky locally so the
  // server-side so channels and the next turn agree (default ask).
  const permissionModeKey = `agentis:permission-mode:${id}:${conversationId ?? 'active'}`;
  const [permissionMode, setPermissionModeState] = useState<ChatPermissionMode>('ask');
  const [activeDurableTurn, setActiveDurableTurn] = useState<DurableConversationTurn | null>(null);
  const activeDurableTurnIdRef = useRef<string | null>(null);
  const activeClientTurnIdRef = useRef<string | null>(null);
  const stopRequestedClientTurnsRef = useRef(new Set<string>());
  const resumedTurnIdsRef = useRef(new Set<string>());
  const queuedDurableTurnIdsRef = useRef(new Set<string>());
  const queuedTurnWatchersRef = useRef(new Map<string, number>());
  useEffect(() => {
    if (kind !== 'agent') return;
    const stored = readStoredPermissionMode(permissionModeKey);
    setPermissionModeState(stored ?? 'ask');
  }, [permissionModeKey, kind]);
  async function setPermissionMode(mode: ChatPermissionMode) {
    setPermissionModeState(mode);
    try { window.localStorage.setItem(permissionModeKey, mode); } catch { /* ignore */ }
    if (conversationId) {
      try {
        await api(`/v1/conversations/session/${conversationId}/mode`, {
          method: 'POST',
          body: JSON.stringify({ mode }),
        });
      } catch (error) {
        toast.error('Could not change mode', apiErrorMessage(error));
      }
    }
  }
  const typingTimer = useRef<number | null>(null);
  const activeChatAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    for (const timer of queuedTurnWatchersRef.current.values()) window.clearTimeout(timer);
    queuedTurnWatchersRef.current.clear();
  }, []);
  const autoSentDraftKeyRef = useRef<string | null>(null);
  const consumedLaunchKeyRef = useRef<string | null>(null);
  const pendingViewportOverrideRef = useRef<ViewportContext | null>(initialViewportOverride ?? null);
  // The real workspace room id behind the virtual `__broadcast__` view, so live
  // room events (which carry the real id) can be scoped to Global Chat.
  const broadcastRoomIdRef = useRef<string | null>(null);
  const setActiveTask = useChatPanelStore((store) => store.setActiveTask);
  const updateActiveTask = useChatPanelStore((store) => store.updateActiveTask);
  const toast = useToast();
  const awareness = useViewportAwareness();
  const navigate = useNavigate();
  const {
    scrollRef,
    isAtBottom,
    scrollToBottom,
    suppressNextScroll,
  } = useAutoScroll(messages.length, agentTyping || pendingResponders.length > 0);

  const querySuffix = conversationId ? `?conversationId=${conversationId}` : '';
  const endpoint = kind === 'agent' ? `/v1/conversations/${id}` : `/v1/rooms/${id}/messages`;
  const sendEndpoint = kind === 'agent' ? `/v1/conversations/${id}/send${querySuffix}` : `/v1/rooms/${id}/messages`;
  const turnsEndpoint = kind === 'agent' ? `/v1/conversations/${id}/turns${querySuffix}` : null;
  const confirmEndpoint = kind === 'agent' ? `/v1/conversations/${id}/confirm${querySuffix}` : null;
  const stopEndpoint = kind === 'agent' ? `/v1/conversations/${id}/stop${querySuffix}` : null;
  const readOnly = kind === 'agent' && Boolean(archivedAt);

  function updateTurnChangeSummary(turnId: string, changeSet: TurnChangeSummary | null | undefined) {
    setMessages((current) => current.map((message) => message.metadata?.durableTurnId === turnId
      ? { ...message, metadata: { ...(message.metadata ?? {}), changeSet: changeSet ?? null } }
      : message));
  }

  async function handleTurnChange(
    message: ChatMessage,
    options: { confirmed?: boolean; direction?: 'undo' | 'redo' } = {},
  ) {
    const changeSet = message.metadata?.changeSet;
    const turnId = message.metadata?.durableTurnId;
    if (!changeSet || !turnId || changeSet.reversibleCount <= 0 || kind !== 'agent') return;
    const direction = options.direction ?? (changeSet.state === 'undone' ? 'redo' : 'undo');
    if (!options.confirmed && (changeSet.sensitiveCount > 0 || changeSet.externalEffectCount > 0)) {
      setTurnChangePrompt({ turnId, direction, kind: 'confirm', summary: changeSet });
      return;
    }
    setTurnChangeBusyId(turnId);
    try {
      const result = await api<TurnChangeActionResult>(`/v1/conversations/${id}/turns/${turnId}/${direction}`, {
        method: 'POST',
        body: JSON.stringify({
          expectedVersion: changeSet.version,
          confirmSensitive: Boolean(options.confirmed),
        }),
      });
      updateTurnChangeSummary(turnId, result.changeSet);
      setTurnChangePrompt(null);
      toast.success(direction === 'undo' ? 'Changes undone' : 'Changes redone',
        result.externalEffectsRetained ? 'External actions were left untouched.' : undefined);
    } catch (error) {
      const shaped = error as ApiError;
      const details = shaped?.details as TurnChangeActionResult | undefined;
      if (shaped?.code === 'TURN_CHANGE_CONFIRMATION_REQUIRED' && details?.changeSet) {
        updateTurnChangeSummary(turnId, details.changeSet);
        setTurnChangePrompt({ turnId, direction, kind: 'confirm', summary: details.changeSet });
      } else if (shaped?.code === 'TURN_CHANGE_CONFLICT' && details?.changeSet) {
        updateTurnChangeSummary(turnId, details.changeSet);
        setTurnChangePrompt({
          turnId,
          direction,
          kind: 'conflict',
          summary: details.changeSet,
          conflicts: details.conflicts ?? [],
        });
      } else {
        toast.error(`Could not ${direction} changes`, apiErrorMessage(error));
      }
    } finally {
      setTurnChangeBusyId((current) => current === turnId ? null : current);
    }
  }

  useEffect(() => {
    if (kind !== 'agent') return;
    function onModelUpdated(event: Event) {
      const detail = (event as CustomEvent<{ agentId?: string; model?: string | null }>).detail;
      if (detail?.agentId !== id) return;
        setAgentRuntime((current) => ({
          adapterType: current?.adapterType ?? null,
          runtimeModel: detail.model ?? defaultRuntimeModel(current?.adapterType),
          adapterCapabilities: current?.adapterCapabilities ?? null,
        }));
    }
    window.addEventListener('agentis:agent-model-updated', onModelUpdated);
    return () => window.removeEventListener('agentis:agent-model-updated', onModelUpdated);
  }, [id, kind]);

  async function loadPage(before?: ChatMessage): Promise<ChatMessage[]> {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (kind === 'agent' && conversationId) query.set('conversationId', conversationId);
    if (before) {
      query.set('before', before.createdAt);
      query.set('beforeId', before.id);
    }
    const path = `${endpoint}?${query.toString()}`;
    if (kind === 'agent') {
      const [threadData, agentData] = await Promise.all([
        api<{ messages: AgentMsg[]; conversation?: AgentConversation }>(path),
        api<{ agent: { adapterType?: string | null; runtimeModel?: string | null; adapterCapabilities?: AgentRuntimeInfo['adapterCapabilities']; config?: Record<string, unknown> | null } }>(`/v1/agents/${id}`)
          .catch(() => ({ agent: { adapterType: null, runtimeModel: null, adapterCapabilities: null, config: null } })),
      ]);
      if (!before) {
        setLoadedConversationId(threadData.conversation?.id ?? conversationId ?? null);
        setAgentNoAdapter(!agentData.agent?.adapterType);
        const selectedModel = typeof agentData.agent?.config?.model === 'string'
          ? agentData.agent.config.model
          : agentData.agent?.runtimeModel ?? defaultRuntimeModel(agentData.agent?.adapterType);
        setAgentRuntime({
          adapterType: agentData.agent?.adapterType ?? null,
          runtimeModel: selectedModel ?? null,
          adapterCapabilities: agentData.agent?.adapterCapabilities ?? null,
        });
      }
      return (threadData.messages ?? []).map(normalizeAgentMessage);
    }
    if (id === '__broadcast__') {
      const [data, interactions] = await Promise.all([
        api<{ messages: RoomMsg[] }>(path).catch(() => ({ messages: [] as RoomMsg[] })),
        listInteractions({ limit: PAGE_SIZE, before: before?.createdAt }).catch(() => ({ events: [] }))
      ]);
      const roomMessages = (data.messages ?? []).map(normalizeRoomMessage);
      // The interaction feed re-reports agent-authored room messages (same id) as
      // `kind:'message'` events. Drop those so a reply already shown as a room
      // message isn't rendered a SECOND time; keep interactions from other rooms.
      const roomMsgIds = new Set((data.messages ?? []).map((m) => m.id));
      const interactionMessages = (interactions.events ?? [])
        .filter((e) => e.kind === 'consultation' || (e.kind === 'message' && !roomMsgIds.has(e.id)))
        .map(normalizeInteractionMessage);
      return sortMessages([...roomMessages, ...interactionMessages]);
    }
    const data = await api<{ messages: RoomMsg[] }>(path);
    return (data.messages ?? []).map(normalizeRoomMessage);
  }

  async function loadInitial() {
    setLoading(true);
    try {
      const page = await loadPage();
      setMessages(dedupeMessages(page));
      setHasMore(page.length === PAGE_SIZE);
    } catch {
      setMessages([]);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const targetConversationId = loadedConversationId ?? conversationId;
    setActiveDurableTurn(null);
    activeDurableTurnIdRef.current = null;
    activeClientTurnIdRef.current = null;
    if (kind !== 'agent' || readOnly || !targetConversationId) return;
    let cancelled = false;
    void api<{ turns: DurableConversationTurn[] }>(`/v1/conversations/${id}/turns/active?conversationId=${encodeURIComponent(targetConversationId)}`)
      .then(({ turns }) => {
        if (cancelled || turns.length === 0) return;
        const active = turns.find((turn) => turn.status === 'running')
          ?? turns.find((turn) => turn.status === 'awaiting_approval' || turn.status === 'blocked' || turn.status === 'paused')
          ?? turns[0]!;
        setActiveDurableTurn(active);
        subscribeRecoveredTurn(active);
        // There may be more than one persisted follow-up behind the active
        // turn. Watch all of them so each promotes itself after reconnect.
        turns.filter((turn) => turn.status === 'queued' && turn.id !== active.id)
          .forEach((turn) => subscribeRecoveredTurn(turn));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [conversationId, id, kind, loadedConversationId, readOnly]);

  useEffect(() => {
    const targetConversationId = loadedConversationId ?? conversationId;
    if (kind !== 'agent' || !targetConversationId) return;
    let cancelled = false;
    void api<{ history: DurableConversationTurnHistory[] }>(
      `/v1/conversations/${id}/turns?conversationId=${encodeURIComponent(targetConversationId)}&limit=${PAGE_SIZE}`,
    ).then(({ history }) => {
      if (cancelled) return;
      setMessages((current) => hydrateDurableTurnHistory(current, history ?? []));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [conversationId, id, kind, loadedConversationId]);

  async function loadOlder() {
    if (loadingOlder || !hasMore || messages.length === 0) return;
    suppressNextScroll();
    setLoadingOlder(true);
    try {
      const page = await loadPage(messages[0]!);
      setMessages((prev) => prependUnique(prev, page));
      setHasMore(page.length === PAGE_SIZE);
    } catch (error) {
      toast.error('Failed to load older messages', String(error));
    } finally {
      setLoadingOlder(false);
    }
  }

  async function handleConfirmationAction(messageId: string, confirmation: ConfirmationCardData, confirmed: boolean) {
    if (!confirmEndpoint) return;
    const toolStartedAt = new Map<string, number>();
    let streamedBody = '';
    const clientTurnId = createClientTurnId();
    activeClientTurnIdRef.current = clientTurnId;
    const createdAt = new Date().toISOString();
    const streamId = `stream-${clientTurnId}`;

    // Set the original confirmation card status to 'approving'
    setMessages((current) => current.map((message) => (
      message.id === messageId
        ? {
            ...message,
            metadata: {
              ...(message.metadata ?? {}),
              confirmation: { ...confirmation, status: 'approving' },
            },
          }
        : message
    )));

    // Create and append the new decoupled streaming bubble
    const streamingMessage: ChatMessage = {
      id: streamId,
      authorId: id,
      authorKind: 'agent',
      text: '',
      createdAt,
      deliveryStatus: 'sending',
      metadata: {
        source: 'chat_loop',
        clientTurnId,
        turn: {
          clientTurnId,
          startedAt: createdAt,
          status: 'running',
        },
        activity: [{
          type: 'activity',
          id: `activity-${clientTurnId}-confirmation`,
          phase: 'tool',
          status: 'running',
          label: confirmed ? confirmation.confirmLabel : confirmation.cancelLabel,
          clientTurnId,
          agentId: id,
          startedAt: createdAt,
        }],
      },
    };
    setMessages((current) => dedupeMessages([...current, streamingMessage]));
    setAgentTyping(true);

    try {
      await streamSse(confirmEndpoint, {
        method: 'POST',
        body: JSON.stringify({ turnId: confirmation.turnId, confirmed, clientTurnId }),
      }, {
        onEvent(event, data) {
          if (event === 'delta') {
            const delta = data as ChatDelta;
            if (delta.type === 'text') {
              streamedBody += delta.delta;
              setMessages((current) => current.map((message) => (
                message.id === streamId
                  ? {
                      ...message,
                      text: streamedBody,
                      deliveryStatus: 'sending',
                    }
                  : message
              )));
            } else if (delta.type === 'activity' || delta.type === 'commentary' || delta.type === 'swarm') {
              setMessages((current) => current.map((message) => (
                message.id === streamId ? withTurnProgress(message, delta) : message
              )));
            } else if (delta.type === 'tool_call') {
              toolStartedAt.set(delta.id, performance.now());
              applyToolCallDelta(streamId, delta);
            } else if (delta.type === 'tool_result') {
              applyToolResultDelta(streamId, delta, toolStartedAt);
            } else if (delta.type === 'confirmation_required') {
              applyConfirmationDelta(streamId, delta);
            } else if (delta.type === 'plan') {
              setMessages((current) => current.map((message) => message.id === streamId
                ? { ...message, metadata: { ...(message.metadata ?? {}), plan: delta.plan } }
                : message));
            } else if (delta.type === 'done') {
              setAgentTyping(false);
              setMessages((current) => current.map((message) => {
                if (message.id === messageId) {
                  return {
                    ...message,
                    metadata: {
                      ...(message.metadata ?? {}),
                      confirmation: message.metadata?.confirmation
                        ? {
                            ...message.metadata.confirmation,
                            status: delta.finishReason === 'error'
                              ? 'failed'
                              : confirmed
                                ? 'approved'
                                : 'cancelled',
                          }
                        : undefined,
                    },
                  };
                }
                if (message.id === streamId) {
                  return {
                    ...message,
                    deliveryStatus: delta.finishReason === 'error' ? 'failed' : 'delivered',
                  };
                }
                return message;
              }));
            }
          } else if (event === 'message') {
            const persisted = normalizeAgentMessage(data as AgentMsg);
            setMessages((current) => {
              const streamMessage = current.find((message) => message.id === streamId);
              return mergeMessage(current, {
                ...persisted,
                metadata: {
                  ...persisted.metadata,
                  clientTurnId: persisted.metadata?.clientTurnId ?? clientTurnId,
                  toolCalls: streamMessage?.metadata?.toolCalls ?? persisted.metadata?.toolCalls,
                  activity: persisted.metadata?.activity ?? streamMessage?.metadata?.activity,
                  commentary: persisted.metadata?.commentary ?? streamMessage?.metadata?.commentary,
                  turn: persisted.metadata?.turn ?? streamMessage?.metadata?.turn,
                },
              });
            });
          } else if (event === 'error') {
            const message = streamErrorMessage(data);
            setAgentTyping(false);
            setMessages((current) => current.map((msg) => {
              if (msg.id === messageId) {
                return {
                  ...msg,
                  metadata: {
                    ...(msg.metadata ?? {}),
                    confirmation: msg.metadata?.confirmation
                      ? { ...msg.metadata.confirmation, status: 'failed' }
                      : undefined,
                  },
                };
              }
              if (msg.id === streamId) {
                return {
                  ...msg,
                  deliveryStatus: 'failed',
                };
              }
              return msg;
            }));
            toast.error('Agent could not complete the action', message);
          }
        },
      });
    } catch (error) {
      setAgentTyping(false);
      setMessages((current) => current.map((msg) => {
        if (msg.id === messageId) {
          return {
            ...msg,
            metadata: {
              ...(msg.metadata ?? {}),
              confirmation: msg.metadata?.confirmation
                ? { ...msg.metadata.confirmation, status: 'failed' }
                : undefined,
            },
          };
        }
        if (msg.id === streamId) {
          return {
            ...msg,
            deliveryStatus: 'failed',
          };
        }
        return msg;
      }));
      toast.error('Failed to confirm action', apiErrorMessage(error));
    }
  }

  useEffect(() => {
    void loadInitial();
  }, [kind, id, conversationId]);

  /** Refetch the still-pending queued messages for this conversation. */
  async function loadQueue() {
    if (kind !== 'agent') { setPendingQueue([]); return; }
    try {
      const res = await api<{ items: QueuedItem[] }>(`/v1/conversations/${id}/queue${querySuffix}`);
      setPendingQueue(res.items ?? []);
    } catch {
      setPendingQueue([]);
    }
  }

  /** Remove a queued item locally + start the real turn for it exactly once
   * (guards against the direct /queue/resume response and the realtime echo
   * of the same dispatch both trying to fire it). */
  function handleQueueDispatch(item: QueuedItem) {
    if (dispatchedQueueIdsRef.current.has(item.id)) return;
    dispatchedQueueIdsRef.current.add(item.id);
    setPendingQueue((prev) => prev.filter((q) => q.id !== item.id));
    const attachments = item.attachments?.length ? item.attachments.map((id) => ({ id, name: id })) : undefined;
    void handleSend(item.text, { attachments });
  }

  useEffect(() => {
    if (kind !== 'agent') { setPendingQueue([]); return; }
    let cancelled = false;
    void loadQueue();
    // Reload recovery: if the tab (re)loaded mid-queue with no turn actively
    // streaming, atomically claim the oldest still-pending message so it
    // keeps going as a fresh turn — a reload must never silently strand a
    // queued send. The backend only hands it back if no turn is in flight.
    (async () => {
      try {
        const res = await api<{ item: QueuedItem | null }>(`/v1/conversations/${id}/queue/resume${querySuffix}`, { method: 'POST' });
        if (!cancelled && res.item) handleQueueDispatch(res.item);
      } catch {  }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, id, conversationId]);

  // Resolve the backing room id for Global Chat so live agent replies (posted
  // under the real id) can be matched to this workspace-wide view.
  useEffect(() => {
    broadcastRoomIdRef.current = null;
    if (kind !== 'room' || id !== '__broadcast__') return;
    let cancelled = false;
    api<{ room: { id: string } }>('/v1/rooms/__broadcast__')
      .then((res) => { if (!cancelled) broadcastRoomIdRef.current = res.room.id; })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [kind, id]);

  useEffect(() => {
    setLoadedConversationId(conversationId ?? null);
  }, [kind, id, conversationId]);

  // Reset the room "responding…" indicator when switching threads, and
  // clear its safety timer on unmount.
  useEffect(() => {
    setPendingResponders([]);
    setRoomResponderActivities({});
    broadcastPostAtRef.current = null;
    if (broadcastPendingTimerRef.current) {
      window.clearTimeout(broadcastPendingTimerRef.current);
      broadcastPendingTimerRef.current = null;
    }
  }, [kind, id]);
  useEffect(() => () => {
    if (broadcastPendingTimerRef.current) window.clearTimeout(broadcastPendingTimerRef.current);
  }, []);

  // Drop any "agent working" progress card we own when leaving this thread
  // (switching agents or unmounting). The
  // server turn keeps running and its result still arrives via realtime, but
  // the card must never remain as an undismissable stuck state.
  useEffect(() => () => {
    const store = useChatPanelStore.getState();
    if (store.activeTask?.agentId === id) store.setActiveTask(null);
  }, [id]);

  useEffect(() => {
    setComposerInitialText('');
    consumedLaunchKeyRef.current = null;
    pendingViewportOverrideRef.current = initialViewportOverride ?? null;
  }, [kind, id, conversationId]);

  useEffect(() => {
    if (initialDraft === undefined && !initialViewportOverride) return;
    const key = `${kind}:${id}:${initialDraft ?? ''}:${initialViewportOverride ? JSON.stringify(initialViewportOverride) : ''}:${autoSendInitialDraft ? 'auto' : 'manual'}`;
    if (consumedLaunchKeyRef.current === key) return;
    consumedLaunchKeyRef.current = key;
    if (initialDraft !== undefined) setComposerInitialText(initialDraft);
    pendingViewportOverrideRef.current = initialViewportOverride ?? null;
    if (!autoSendInitialDraft) queueMicrotask(() => onInitialDraftUsed?.());
  }, [autoSendInitialDraft, id, initialDraft, initialViewportOverride, kind, onInitialDraftUsed]);

  useEffect(() => {
    return kind === 'room'
      ? rtSubscribe('room', { roomId: id })
      : rtSubscribe('conversation', { agentId: id });
  }, [kind, id]);

  useRealtime([
    REALTIME_EVENTS.CONVERSATION_MESSAGE_RECEIVED,
    REALTIME_EVENTS.CONVERSATION_MESSAGE_SENT,
    REALTIME_EVENTS.CONVERSATION_MESSAGE_UPDATED,
    REALTIME_EVENTS.CONVERSATION_MESSAGE_DELETED,
    REALTIME_EVENTS.ROOM_MESSAGE_RECEIVED,
    REALTIME_EVENTS.ROOM_MESSAGE_SENT,
    REALTIME_EVENTS.ROOM_MESSAGE_UPDATED,
    REALTIME_EVENTS.ROOM_MESSAGE_DELETED,
  ], (env) => {
    if (readOnly) return;
    const payload = env.payload as {
      id?: string;
      roomId?: string;
      agentId?: string;
      message?: AgentMsg | RoomMsg;
      conversationId?: string | null;
    };
    if (kind === 'agent') {
      if (payload.agentId !== id) return;
      const expectedConversationId = loadedConversationId ?? conversationId ?? null;
      if (!payload.conversationId || !expectedConversationId || payload.conversationId !== expectedConversationId) return;
      if (env.event === REALTIME_EVENTS.CONVERSATION_MESSAGE_DELETED) {
        setMessages((prev) => prev.filter((message) => message.id !== payload.id));
        return;
      }
      if (payload.message) {
        setMessages((prev) => mergeMessage(prev, normalizeAgentMessage(payload.message as AgentMsg)));
      }
      return;
    }
    // Global Chat is a virtual view over a real backing room; match live events
    // (incl. the agent replies the broadcast dispatcher posts) to that room id.
    const targetRoomId = id === '__broadcast__' ? broadcastRoomIdRef.current : id;
    if (!targetRoomId || payload.roomId !== targetRoomId) return;
    if (env.event === REALTIME_EVENTS.ROOM_MESSAGE_DELETED) {
      setMessages((prev) => prev.filter((message) => message.id !== payload.id));
      return;
    }
    if (payload.message) {
      const roomMessage = payload.message as RoomMsg;
      setMessages((prev) => upsertMessage(prev, normalizeRoomMessage(roomMessage)));
      const postAt = broadcastPostAtRef.current;
      if (postAt && roomMessage.authorType === 'agent' && roomMessage.authorId && roomMessage.createdAt >= postAt) {
        setPendingResponders((prev) => prev.filter((agentId) => agentId !== roomMessage.authorId));
        setRoomResponderActivities((prev) => removeKeys(prev, [roomMessage.authorId!]));
      }
    }
  });

  useRealtime([REALTIME_EVENTS.CONVERSATION_TURN_CHANGES_UPDATED], (env) => {
    if (kind !== 'agent') return;
    const payload = env.payload as { turnId?: string; changeSet?: TurnChangeSummary };
    if (!payload.turnId || !payload.changeSet) return;
    updateTurnChangeSummary(payload.turnId, payload.changeSet);
  });

  // Queue-then-auto-continue composer: a message was queued/discarded while a
  // turn streamed, or the oldest queued message was just popped and needs to
  // become a real turn now that the prior one ended.
  useRealtime([REALTIME_EVENTS.CONVERSATION_QUEUE_UPDATED], (env) => {
    if (kind !== 'agent' || readOnly) return;
    const payload = env.payload as {
      agentId?: string;
      conversationId?: string | null;
      item?: QueuedItem;
      action?: 'added' | 'updated' | 'promoted' | 'dispatched' | 'discarded';
    };
    if (payload.agentId !== id || !payload.item) return;
    const expectedConversationId = loadedConversationId ?? conversationId ?? null;
    if (!payload.conversationId || !expectedConversationId || payload.conversationId !== expectedConversationId) return;
    if (payload.action === 'added') {
      setPendingQueue((prev) => (prev.some((q) => q.id === payload.item!.id) ? prev : [...prev, payload.item!]));
    } else if (payload.action === 'updated') {
      setPendingQueue((prev) => prev.map((q) => q.id === payload.item!.id ? payload.item! : q));
    } else if (payload.action === 'promoted') {
      setPendingQueue((prev) => [payload.item!, ...prev.filter((q) => q.id !== payload.item!.id)]);
    } else if (payload.action === 'discarded') {
      setPendingQueue((prev) => prev.filter((q) => q.id !== payload.item!.id));
    } else if (payload.action === 'dispatched') {
      handleQueueDispatch(payload.item);
    }
  });

  // Durable turns own their queue on the server. The browser listens for the
  // exact queued -> running transition so a second composer submission never
  // steals the first turn's stream or pretends to be executing early.
  useRealtime([REALTIME_EVENTS.CONVERSATION_TURN_EVENT], (env) => {
    if (kind !== 'agent' || readOnly) return;
    const payload = (env.payload && typeof env.payload === 'object' ? env.payload : {}) as {
      turnId?: string;
      agentId?: string;
      conversationId?: string;
      data?: { type?: string; status?: string };
    };
    const expectedConversationId = loadedConversationId ?? conversationId ?? null;
    if (!payload.turnId || payload.agentId !== id || !expectedConversationId || payload.conversationId !== expectedConversationId) return;
    if (payload.data?.type !== 'turn_status') return;
    if (payload.data.status === 'running' && queuedDurableTurnIdsRef.current.has(payload.turnId)) {
      void beginQueuedTurn(payload.turnId);
    }
    if (['completed', 'failed', 'cancelled'].includes(payload.data.status ?? '') && queuedDurableTurnIdsRef.current.has(payload.turnId)) {
      clearQueuedTurnWatch(payload.turnId);
      queuedDurableTurnIdsRef.current.delete(payload.turnId);
    }
  });

  // Global Chat (__broadcast__) is a virtual view over a real backing room, so a
  // posted agent reply only renders through the primary room-message handler if
  // the backing room id has resolved AND matches — a fragile, race-prone path that
  // left agent @mention replies invisible. These same room.message.* events DO
  // reach this workspace-scoped handler reliably, so here we authoritatively
  // REFETCH the room's own messages (the agent replies the broadcast dispatcher
  // posts) plus the latest interaction events, and merge. This guarantees a reply
  // appears without depending on live event-payload matching.
  useRealtime(['activity.created', 'agent.consultation.updated', REALTIME_EVENTS.ROOM_MESSAGE_SENT, REALTIME_EVENTS.ROOM_MESSAGE_RECEIVED], () => {
    if (id !== '__broadcast__') return;
    void Promise.all([
      api<{ messages: RoomMsg[] }>(`/v1/rooms/__broadcast__/messages?limit=${PAGE_SIZE}`)
        .then((res) => res.messages ?? [])
        .catch(() => [] as RoomMsg[]),
      listInteractions({ limit: 10 }).then((res) => res.events ?? []).catch(() => []),
    ]).then(([roomMessages, events]) => {
      const roomMsgIds = new Set(roomMessages.map((m) => m.id));
      // Clear the "responding…" indicator for any mentioned agent whose reply has
      const postAt = broadcastPostAtRef.current;
      if (postAt) {
        const replied = new Set(
          roomMessages
            .filter((m) => m.authorType === 'agent' && m.authorId && m.createdAt >= postAt)
            .map((m) => m.authorId as string),
        );
        if (replied.size > 0) setPendingResponders((prev) => prev.filter((agentId) => !replied.has(agentId)));
        if (replied.size > 0) setRoomResponderActivities((prev) => removeKeys(prev, replied));
      }
      setMessages((current) => {
        let updated = [...current];
        for (const message of roomMessages) {
          updated = upsertMessage(updated, normalizeRoomMessage(message));
        }
        for (const event of events) {
          // Skip interaction 'message' events that ARE these room messages (same
          // id) — they'd render a duplicate bubble. Keep agent chatter elsewhere.
          if (event.kind === 'consultation' || (event.kind === 'message' && !roomMsgIds.has(event.id))) {
            updated = mergeMessage(updated, normalizeInteractionMessage(event));
          }
        }
        return sortMessages(updated);
      });
    }).catch(() => {});
  });

  useRealtime([REALTIME_EVENTS.CONVERSATION_AGENT_TYPING], (env) => {
    if (kind !== 'agent') return;
    const payload = env.payload as { agentId?: string };
    if (payload.agentId !== id) return;
    setAgentTyping(true);
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => setAgentTyping(false), 4000);
  });

  useRealtime([
    REALTIME_EVENTS.AGENT_WORK_STEP,
    REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL,
    REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE,
  ], (env) => {
    if (kind !== 'room') return;
    const payload = (env.payload && typeof env.payload === 'object' ? env.payload : {}) as Record<string, unknown>;
    const activity = roomRealtimeActivity(env.event, payload);
    if (!activity?.agentId || !pendingResponders.includes(activity.agentId)) return;
    setRoomResponderActivities((prev) => {
      const current = prev[activity.agentId!] ?? [];
      const deduped = current.filter((entry) => entry.id !== activity.id);
      return { ...prev, [activity.agentId!]: [...deduped, activity].slice(-40) };
    });
  });

  useEffect(() => () => {
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
  }, []);

  function navigateToHandoff(result: unknown) {
    const handoff = asAppThreadHandoff(result);
    if (!handoff) return;
    const base = handoff.targetUrl ?? `/apps/${handoff.slug}`;
    const query = new URLSearchParams();
    if (handoff.carriedMessage) query.set('message', handoff.carriedMessage);
    if (handoff.reason) query.set('handoffReason', handoff.reason);
    const suffix = query.toString();
    navigate(suffix ? `${base}${base.includes('?') ? '&' : '?'}${suffix}` : base);
  }

  function applyToolCallDelta(streamId: string, delta: Extract<ChatDelta, { type: 'tool_call' }>) {
    const pill: ToolCallPillData = {
      id: delta.id,
      name: delta.name,
      status: 'running',
      args: delta.args,
    };
    setMessages((current) => current.map((message) => {
      if (message.id !== streamId) return message;
      const existing = message.metadata?.toolCalls ?? [];
      return {
        ...message,
        metadata: {
          ...(message.metadata ?? {}),
          source: message.metadata?.source ?? 'chat_loop',
          toolCalls: [...existing.filter((entry) => entry.id !== pill.id), pill],
        },
      };
    }));
  }

  function applyToolResultDelta(
    streamId: string,
    delta: Extract<ChatDelta, { type: 'tool_result' }>,
    toolStartedAt: Map<string, number>,
  ) {
    const startedAt = toolStartedAt.get(delta.id);
    const durationMs = startedAt !== undefined ? Math.max(0, performance.now() - startedAt) : null;
    setMessages((current) => current.map((message) => {
      if (message.id !== streamId) return message;
      const existing = message.metadata?.toolCalls ?? [];
      const previous = existing.find((entry) => entry.id === delta.id);
      const nextPill: ToolCallPillData = {
        id: delta.id,
        name: delta.name,
        status: delta.error ? 'error' : 'success',
        args: previous?.args,
        result: delta.result,
        error: delta.error,
        durationMs,
      };
      return {
        ...message,
        metadata: {
          ...(message.metadata ?? {}),
          source: message.metadata?.source ?? 'chat_loop',
          toolCalls: [...existing.filter((entry) => entry.id !== delta.id), nextPill],
        },
      };
    }));
    if (!delta.error) navigateToHandoff(delta.result);
  }

  function applyConfirmationDelta(streamId: string, delta: Extract<ChatDelta, { type: 'confirmation_required' }>) {
    const confirmationCard: ConfirmationCardData = {
      turnId: delta.turnId,
      toolCall: delta.toolCall,
      title: delta.title,
      body: delta.body,
      impact: delta.impact,
      confirmLabel: delta.confirmLabel,
      cancelLabel: delta.cancelLabel,
      expiresAt: delta.expiresAt,
      status: 'pending',
    };
    setMessages((current) => current.map((message) => {
      if (message.id !== streamId) return message;
      const existing = message.metadata?.toolCalls ?? [];
      const updatedToolCalls = existing.map((tc) => {
        if (tc.id === delta.toolCall.id) {
          return { ...tc, status: 'paused' as any };
        }
        return tc;
      });
      return {
        ...message,
        metadata: {
          ...(message.metadata ?? {}),
          source: message.metadata?.source ?? 'chat_loop',
          confirmation: confirmationCard,
          toolCalls: updatedToolCalls,
        },
      };
    }));
  }

  /** Durably queue a message sent while this conversation's turn is already
   * streaming (§ChatComposerQueue). The backend re-checks the in-flight-turn
   * guard itself, so this is correct even if `streamingAgentActive` is a beat
   * stale. */
  async function enqueueMessage(text: string, attachments?: SendAttachment[]) {
    try {
      const res = await api<{ queued: boolean; item?: QueuedItem }>(sendEndpoint, {
        method: 'POST',
        body: JSON.stringify({
          body: text,
          clientTurnId: createClientTurnId(),
          useViewportContext: true,
          permissionMode,
          attachments: attachments?.length ? attachments.map((a) => a.id) : undefined,
        }),
      });
      if (res.queued && res.item) {
        const item = res.item;
        setPendingQueue((prev) => (prev.some((q) => q.id === item.id) ? prev : [...prev, item]));
      }
    } catch (error) {
      toast.error('Failed to queue message', apiErrorMessage(error));
      throw error;
    }
  }

  /** Cancel a still-pending queued message before it dispatches. */
  async function cancelQueuedMessage(itemId: string) {
    setPendingQueue((prev) => prev.filter((q) => q.id !== itemId));
    try {
      await api(`/v1/conversations/${id}/queue/${itemId}${querySuffix}`, { method: 'DELETE' });
    } catch (error) {
      toast.error('Failed to remove queued message', apiErrorMessage(error));
      void loadQueue();
    }
  }

  async function editQueuedMessage(itemId: string, text: string) {
    try {
      const res = await api<{ item?: QueuedItem }>(`/v1/conversations/${id}/queue/${itemId}${querySuffix}`, {
        method: 'PATCH',
        body: JSON.stringify({ text }),
      });
      if (res.item) setPendingQueue((prev) => prev.map((item) => item.id === itemId ? res.item! : item));
    } catch (error) {
      toast.error('Failed to edit queued message', apiErrorMessage(error));
      void loadQueue();
      throw error;
    }
  }

  async function sendQueuedMessageNow(itemId: string) {
    try {
      const res = await api<{ item?: QueuedItem }>(`/v1/conversations/${id}/queue/${itemId}/promote${querySuffix}`, { method: 'POST' });
      if (res.item) setPendingQueue((prev) => [res.item!, ...prev.filter((item) => item.id !== itemId)]);
    } catch (error) {
      toast.error('Failed to prioritize queued message', apiErrorMessage(error));
      void loadQueue();
      throw error;
    }
  }

  async function editQueuedTurn(message: ChatMessage, text: string) {
    const turnId = message.metadata?.durableTurnId;
    if (!turnId) return;
    try {
      await api(`/v1/conversations/${id}/turns/${turnId}${querySuffix}`, {
        method: 'PATCH',
        body: JSON.stringify({ text }),
      });
      setEditingId(null);
      setMessages((prev) => prev.map((item) => item.metadata?.durableTurnId === turnId
        ? { ...item, text }
        : item));
    } catch (error) {
      toast.error('Failed to edit queued message', apiErrorMessage(error));
      throw error;
    }
  }

  async function cancelQueuedTurn(message: ChatMessage) {
    const turnId = message.metadata?.durableTurnId;
    if (!turnId) return;
    try {
      await api(`/v1/conversations/${id}/turns/${turnId}/cancel${querySuffix}`, { method: 'POST' });
      clearQueuedTurnWatch(turnId);
      queuedDurableTurnIdsRef.current.delete(turnId);
      setEditingId((current) => current === message.id ? null : current);
      setMessages((prev) => prev.map((item) => item.metadata?.durableTurnId === turnId
        ? { ...item, metadata: { ...(item.metadata ?? {}), queued: false, queuePosition: undefined, queueCancelled: true } }
        : item));
    } catch (error) {
      toast.error('Failed to cancel queued message', apiErrorMessage(error));
      throw error;
    }
  }

  async function sendQueuedTurnNow(message: ChatMessage) {
    const turnId = message.metadata?.durableTurnId;
    if (!turnId) return;
    try {
      const res = await api<{ turn: DurableConversationTurn }>(`/v1/conversations/${id}/turns/${turnId}/send-now${querySuffix}`, { method: 'POST' });
      if (res.turn.status === 'running') {
        clearQueuedTurnWatch(turnId);
        queuedDurableTurnIdsRef.current.delete(turnId);
        subscribeRecoveredTurn(res.turn);
      }
    } catch (error) {
      toast.error('Failed to send queued message now', apiErrorMessage(error));
      throw error;
    }
  }

  function clearQueuedTurnWatch(turnId: string) {
    const timer = queuedTurnWatchersRef.current.get(turnId);
    if (timer) window.clearTimeout(timer);
    queuedTurnWatchersRef.current.delete(turnId);
  }

  /** WebSocket events normally promote a queued turn immediately. This small
   * recovery poll only protects an interrupted browser subscription; it never
   * fabricates progress or starts work locally. */
  function watchQueuedTurn(turn: DurableConversationTurn) {
    queuedDurableTurnIdsRef.current.add(turn.id);
    clearQueuedTurnWatch(turn.id);
    const check = () => {
      void api<{ turn: DurableConversationTurn }>(`/v1/conversations/${id}/turns/${turn.id}`)
        .then(({ turn: latest }) => {
          if (!queuedDurableTurnIdsRef.current.has(latest.id)) return;
          if (latest.status === 'running') {
            void beginQueuedTurn(latest.id, latest);
            return;
          }
          if (['completed', 'failed', 'cancelled'].includes(latest.status)) {
            queuedDurableTurnIdsRef.current.delete(latest.id);
            clearQueuedTurnWatch(latest.id);
            return;
          }
          queuedTurnWatchersRef.current.set(latest.id, window.setTimeout(check, 1_500));
        })
        .catch(() => {
          if (queuedDurableTurnIdsRef.current.has(turn.id)) {
            queuedTurnWatchersRef.current.set(turn.id, window.setTimeout(check, 1_500));
          }
        });
    };
    queuedTurnWatchersRef.current.set(turn.id, window.setTimeout(check, 1_500));
  }

  async function beginQueuedTurn(turnId: string, existing?: DurableConversationTurn) {
    if (!queuedDurableTurnIdsRef.current.has(turnId)) return;
    try {
      const turn = existing ?? (await api<{ turn: DurableConversationTurn }>(`/v1/conversations/${id}/turns/${turnId}`)).turn;
      if (turn.status !== 'running') return;
      clearQueuedTurnWatch(turn.id);
      queuedDurableTurnIdsRef.current.delete(turn.id);
      subscribeRecoveredTurn(turn);
    } catch {
      // The watcher retries; keeping the compact Queued state is more honest
      // than replacing it with a speculative agent trace.
    }
  }

  async function handleSend(text: string, options?: { useViewportContext?: boolean; attachments?: SendAttachment[] }) {
    if (readOnly) {
      toast.warn('Past conversation', 'Use the + button in the header to start a fresh conversation.');
      return;
    }
    const value = text.trim();
    const attachments = options?.attachments ?? [];
    if (!value && attachments.length === 0) return;
    // Attachment(s) with no caption still need a non-empty body — the backend
    // requires one and the chat bubble needs something to show alongside the
    // rendered attachment card.
    const bodyText = value || defaultAttachmentCaption(attachments);
    const modeDirective = parseChatPermissionDirective(bodyText);
    const turnPermissionMode = modeDirective?.mode ?? permissionMode;
    if (modeDirective) {
      // Update the selector immediately. The turn request below is still the
      // authoritative persistence path, so this does not wait on a second API
      // round trip before Plan protections take effect.
      setPermissionModeState(turnPermissionMode);
      try { window.localStorage.setItem(permissionModeKey, turnPermissionMode); } catch { /* ignore */ }
    }
    const artifactIds = attachments.map((a) => a.id);
    // Chat V2 persists every operator turn immediately. If another turn is
    // active, the durable worker queues this one by conversation order; the
    // browser never owns that queue or the lifetime of either mission.
    if (kind === 'room') {
      try {
        const responders = resolveMentionedAgentIds(value, agentMap);
        const res = await api<{ message?: RoomMsg }>(sendEndpoint, {
          method: 'POST',
          body: JSON.stringify({
            contentType: 'text',
            content: { text: bodyText, ...(artifactIds.length ? { artifactIds } : {}) },
            mentions: responders,
          }),
        });
        const message = res.message;
        if (message) setMessages((prev) => upsertMessage(prev, normalizeRoomMessage(message)));
        // Rooms: show a "responding…" indicator for each @mentioned agent until
        // its reply lands (the dispatch is async and can take a while).
        if (responders.length > 0) {
          const postAt = new Date().toISOString();
          broadcastPostAtRef.current = postAt;
          setPendingResponders(responders);
          setRoomResponderActivities(Object.fromEntries(
            responders.map((agentId) => [
              agentId,
              [],
            ]),
          ));
          if (broadcastPendingTimerRef.current) window.clearTimeout(broadcastPendingTimerRef.current);
          broadcastPendingTimerRef.current = window.setTimeout(() => {
            setPendingResponders([]);
            setRoomResponderActivities({});
          }, 180_000);
        }
      } catch (error) {
        toast.error('Failed to send', apiErrorMessage(error));
      }
      return;
    }

    const clientTurnId = createClientTurnId();
    const createdAt = new Date().toISOString();
    const operatorMessage: ChatMessage = {
      id: `tmp-${clientTurnId}`,
      authorId: 'operator',
      authorKind: 'operator',
      text: bodyText,
      artifactIds: artifactIds.length ? artifactIds : undefined,
      createdAt,
      deliveryStatus: 'sending',
      metadata: artifactIds.length ? { clientTurnId, artifactIds } : { clientTurnId },
    };
    const streamId = `stream-${clientTurnId}`;
    // Do not create an agent trace before the server has accepted and ordered
    // the turn. A queued follow-up is a sent operator message, not work in
    // progress, and must never interrupt the preceding SSE stream.
    setMessages((current) => dedupeMessages([...current, operatorMessage]));

    const toolStartedAt = new Map<string, number>();
    let toolTotal = 0;
    let toolDone = 0;
    let streamedBody = '';

    try {
      const viewportOverride = pendingViewportOverrideRef.current;
      if (!turnsEndpoint) throw new Error('Durable turn endpoint is unavailable.');
      const created = await api<{ turn: DurableConversationTurn; conversationId: string; message?: AgentMsg; queued?: boolean; queuePosition?: number }>(turnsEndpoint, {
        method: 'POST',
        body: JSON.stringify({
          body: bodyText,
          clientTurnId,
          useViewportContext: options?.useViewportContext !== false,
          attachments: artifactIds.length ? artifactIds : undefined,
          viewportOverride,
          permissionMode: turnPermissionMode,
          executionMode: 'auto',
        }),
      });
      setLoadedConversationId(created.conversationId);
      const queued = created.queued || (created.queuePosition ?? 0) > 0;
      if (queued) {
        setMessages((current) => current.map((message) => (message.id === operatorMessage.id || (message.authorKind === 'operator' && message.metadata?.clientTurnId === clientTurnId))
          ? {
              ...message,
              deliveryStatus: 'delivered' as const,
              metadata: {
                ...(message.metadata ?? {}),
                durableTurnId: created.turn.id,
                queued: true,
                queuePosition: created.queuePosition ?? 1,
              },
            }
          : message));
        pendingViewportOverrideRef.current = null;
        watchQueuedTurn(created.turn);
        return;
      }

      const streamingMessage: ChatMessage = {
        id: streamId,
        authorId: id,
        authorKind: 'agent',
        text: '',
        createdAt,
        deliveryStatus: 'sending',
        metadata: {
          source: 'chat_loop',
          clientTurnId,
          durableTurnId: created.turn.id,
          turn: { clientTurnId, startedAt: createdAt, status: 'running' },
          activity: immediateTurnActivity(clientTurnId, id, bodyText, createdAt),
        },
      };
      setMessages((current) => dedupeMessages(current.map((message) => (message.id === operatorMessage.id || (message.authorKind === 'operator' && message.metadata?.clientTurnId === clientTurnId))
        ? { ...message, deliveryStatus: 'delivered' as const }
        : message).concat(streamingMessage)));
      setAgentTyping(true);
      setActiveTask({ agentId: id, agentName: name, label: taskLabel(bodyText), done: 0, total: 0, startedAt: Date.now() });
      activeDurableTurnIdRef.current = created.turn.id;
      activeClientTurnIdRef.current = clientTurnId;
      resumedTurnIdsRef.current.add(created.turn.id);
      setActiveDurableTurn(created.turn);
      if (created.message) {
        setMessages((current) => mergeMessage(current, normalizeAgentMessage(created.message!)));
      }
      // If Stop was clicked while POST /turns was in flight, this is the first
      // moment an id exists. Cancel server work before opening the event stream.
      if (stopRequestedClientTurnsRef.current.has(clientTurnId)) {
        await api(`/v1/conversations/${id}/turns/${created.turn.id}/cancel`, { method: 'POST' });
        throw new DOMException('operator_stop', 'AbortError');
      }
      const controller = new AbortController();
      activeChatAbortRef.current = controller;
      await streamSse(`/v1/conversations/${id}/turns/${created.turn.id}/events?after=0`, {
        method: 'GET',
        signal: controller.signal,
      }, {
        onEvent(event, data) {
          if (event === 'delta') {
            const delta = data as ChatDelta;
            if (delta.type === 'text') {
              streamedBody += delta.delta;
              setMessages((current) => current.map((message) => (
                message.id === streamId
                  ? { ...message, text: streamedBody, deliveryStatus: 'sending' }
                  : message
              )));
            } else if (delta.type === 'activity' || delta.type === 'commentary' || delta.type === 'swarm') {
              if (delta.type === 'activity') updateActiveTask({ label: delta.label });
              setMessages((current) => current.map((message) => (
                message.id === streamId ? withTurnProgress(message, delta) : message
              )));
            } else if (delta.type === 'tool_call') {
              toolStartedAt.set(delta.id, performance.now());
              toolTotal += 1;
              updateActiveTask({ total: toolTotal });
              applyToolCallDelta(streamId, delta);
            } else if (delta.type === 'tool_result') {
              toolDone += 1;
              updateActiveTask({ done: toolDone });
              applyToolResultDelta(streamId, delta, toolStartedAt);
            } else if (delta.type === 'confirmation_required') {
              applyConfirmationDelta(streamId, delta);
            } else if (delta.type === 'plan') {
              setMessages((current) => current.map((message) => message.id === streamId
                ? { ...message, metadata: { ...(message.metadata ?? {}), plan: delta.plan } }
                : message));
            } else if (delta.type === 'execution') {
              setActiveDurableTurn((current) => current ? {
                ...current,
                executionEnvelope: delta.envelope,
                contextManifest: delta.context,
                effectiveMode: delta.envelope.effectiveMode,
              } : current);
              setMessages((current) => current.map((message) => message.id === streamId
                ? { ...message, metadata: { ...(message.metadata ?? {}), durableTurnId: created.turn.id, executionEnvelope: delta.envelope, contextManifest: delta.context } }
                : message));
            } else if (delta.type === 'done') {
              setAgentTyping(false);
              setActiveTask(null);
              void api<{ turn: DurableConversationTurn }>(`/v1/conversations/${id}/turns/${created.turn.id}`)
                .then(({ turn }) => {
                  updateTurnChangeSummary(turn.id, turn.changeSet);
                  setActiveDurableTurn(turn.status === 'completed' || turn.status === 'failed' || turn.status === 'cancelled' ? null : turn);
                })
                .catch(() => setActiveDurableTurn(null));
              setMessages((current) => current.map((message) => (
                message.id === streamId
                  ? { ...message, deliveryStatus: delta.finishReason === 'error' ? 'failed' : 'delivered' }
                  : message
              )));
            }
          } else if (event === 'message') {
            const persisted = normalizeAgentMessage(data as AgentMsg);
            setMessages((current) => {
              const streamMessage = current.find((message) => message.id === streamId);
              const incoming: ChatMessage = {
                ...persisted,
                metadata: {
                  ...persisted.metadata,
                  clientTurnId: persisted.metadata?.clientTurnId ?? clientTurnId,
                  durableTurnId: persisted.metadata?.durableTurnId ?? created.turn.id,
                  changeSet: persisted.metadata?.changeSet ?? streamMessage?.metadata?.changeSet ?? null,
                  toolCalls: streamMessage?.metadata?.toolCalls ?? persisted.metadata?.toolCalls,
                  activity: persisted.metadata?.activity ?? streamMessage?.metadata?.activity,
                  commentary: persisted.metadata?.commentary ?? streamMessage?.metadata?.commentary,
                  turn: persisted.metadata?.turn ?? streamMessage?.metadata?.turn,
                },
              };
              const delivered = current.map((message): ChatMessage => {
                if (message.id === operatorMessage.id || (message.authorKind === 'operator' && message.metadata?.clientTurnId === clientTurnId)) return { ...message, deliveryStatus: 'delivered' as const };
                return message;
              });
              return mergeMessage(delivered, incoming);
            });
          } else if (event === 'error') {
            const failureMessage = streamErrorMessage(data);
            setAgentTyping(false);
            setActiveTask(null);
            setMessages((current) => current.map((item) => (
              item.id === streamId
                ? withChatFailure({ ...item, text: item.text || failureMessage }, failureMessage)
                : item.id === operatorMessage.id
                  ? { ...item, deliveryStatus: 'delivered' }
                  : item
            )));
            toast.error('Agent could not reply', failureMessage);
          }
        },
      });
      pendingViewportOverrideRef.current = null;
    } catch (error) {
      setAgentTyping(false);
      setActiveTask(null);
      const stopped = error instanceof DOMException && error.name === 'AbortError';
      const shouldKeepStoppedBubble = streamedBody.trim().length > 0 || toolTotal > 0;
      const completedAt = new Date().toISOString();
      setMessages((current) => current.flatMap((message) => {
        if (message.id === streamId) {
          if (stopped && !shouldKeepStoppedBubble) return [];
          return [{
            ...message,
            deliveryStatus: stopped ? 'delivered' as const : 'failed' as const,
            metadata: {
              ...(message.metadata ?? {}),
              toolCalls: (message.metadata?.toolCalls ?? []).map((tool) => (
                tool.status === 'running' || tool.status === 'paused'
                  ? { ...tool, status: stopped ? 'stopped' as const : 'error' as const }
                  : tool
              )),
              turn: {
                ...(message.metadata?.turn ?? { clientTurnId, startedAt: message.createdAt }),
                completedAt,
                status: stopped ? 'stopped' : 'failed',
              },
            },
          }];
        }
        if (message.id === operatorMessage.id || (message.authorKind === 'operator' && message.metadata?.clientTurnId === clientTurnId)) {
          return [{ ...message, deliveryStatus: stopped ? 'delivered' as const : 'failed' as const }];
        }
        return [message];
      }));
      if (!stopped) toast.error('Failed to send', apiErrorMessage(error));
    } finally {
      if (activeClientTurnIdRef.current === clientTurnId) {
        activeChatAbortRef.current = null;
        activeDurableTurnIdRef.current = null;
        activeClientTurnIdRef.current = null;
        stopRequestedClientTurnsRef.current.delete(clientTurnId);
      }
    }
  }

  function stopActiveTurn() {
    const clientTurnId = activeClientTurnIdRef.current;
    if (clientTurnId) stopRequestedClientTurnsRef.current.add(clientTurnId);
    activeChatAbortRef.current?.abort();
    const durableTurnId = activeDurableTurnIdRef.current ?? activeDurableTurn?.id;
    setAgentTyping(false);
    setActiveTask(null);
    if (durableTurnId && kind === 'agent') {
      // Composer Stop means stop this chat, not merely close the currently
      // visible turn. The conversation endpoint cancels the active durable
      // turn *and* every queued follow-up before releasing its lease.
      for (const queuedTurnId of queuedDurableTurnIdsRef.current) clearQueuedTurnWatch(queuedTurnId);
      queuedDurableTurnIdsRef.current.clear();
      setMessages((current) => current.map((message) => message.metadata?.queued
        ? { ...message, metadata: { ...(message.metadata ?? {}), queued: false, queuePosition: undefined } }
        : message));
      void api<{ ok: boolean; failedRunIds?: string[] }>(stopEndpoint!, { method: 'POST' })
        .then(() => {
          setActiveDurableTurn(null);
          setAgentTyping(false);
          setActiveTask(null);
        })
        .catch((error) => toast.error('Could not stop chat work', apiErrorMessage(error)));
      return;
    }
    if (clientTurnId && kind === 'agent') {
      // A null response simply means POST /turns has not committed yet; the
      // post-create guard above repeats cancellation as soon as it has.
      void api(`/v1/conversations/${id}/turns/by-client/${clientTurnId}/cancel`, { method: 'POST' })
        .catch((error) => toast.error('Could not stop mission', apiErrorMessage(error)));
      return;
    }
    if (!stopEndpoint) return;
    // The browser abort only closes this SSE request. The server endpoint is the
    // durable stop: it aborts the model loop, clears queued follow-ups, and
    // cancels workflow runs created by this conversation.
    setPendingQueue([]);
    void api<{ ok: boolean; failedRunIds?: string[] }>(stopEndpoint, { method: 'POST' })
      .then((result) => {
        if (result.failedRunIds?.length) {
          toast.error('Some workflow runs could not be stopped', `${result.failedRunIds.length} run(s) need operator attention.`);
        }
      })
      .catch((error) => toast.error('Could not stop all work', apiErrorMessage(error)));
  }

  async function resumeBlockedTurn() {
    if (kind !== 'agent' || !activeDurableTurn || !['blocked', 'paused', 'interrupted'].includes(activeDurableTurn.status)) return;
    try {
      const { turn } = await api<{ turn: DurableConversationTurn }>(
        `/v1/conversations/${id}/turns/${activeDurableTurn.id}/resume`,
        { method: 'POST' },
      );
      resumedTurnIdsRef.current.delete(turn.id);
      setActiveDurableTurn(turn);
      subscribeRecoveredTurn(turn);
    } catch (error) {
      toast.error('Could not resume mission', apiErrorMessage(error));
    }
  }

  /** Reattach to a server-owned turn after reload, fullscreen/dock remount, or resume. */
  function subscribeRecoveredTurn(turn: DurableConversationTurn) {
    if (turn.status === 'queued') {
      setMessages((current) => current.map((message) => message.metadata?.clientTurnId === turn.clientTurnId && message.authorKind === 'operator'
        ? {
            ...message,
            deliveryStatus: 'delivered' as const,
            metadata: { ...(message.metadata ?? {}), durableTurnId: turn.id, queued: true, queuePosition: message.metadata?.queuePosition ?? 1 },
          }
        : message));
      watchQueuedTurn(turn);
      return;
    }
    if (resumedTurnIdsRef.current.has(turn.id)) return;
    resumedTurnIdsRef.current.add(turn.id);
    const streamId = `stream-${turn.clientTurnId}`;
    const createdAt = turn.startedAt ?? turn.createdAt;
    setMessages((current) => {
      const promoted = current.map((message) => message.metadata?.clientTurnId === turn.clientTurnId && message.authorKind === 'operator'
        ? {
            ...message,
            deliveryStatus: 'delivered' as const,
            metadata: { ...(message.metadata ?? {}), durableTurnId: turn.id, queued: false, queuePosition: undefined },
          }
        : message);
      if (promoted.some((message) => message.metadata?.clientTurnId === turn.clientTurnId && message.authorKind === 'agent')) return promoted;
      return dedupeMessages([...promoted, {
        id: streamId,
        authorId: id,
        authorKind: 'agent',
        text: '',
        createdAt,
        deliveryStatus: 'sending',
        metadata: {
          source: 'chat_loop',
          clientTurnId: turn.clientTurnId,
          durableTurnId: turn.id,
          executionEnvelope: turn.executionEnvelope ?? undefined,
          contextManifest: turn.contextManifest ?? undefined,
          turn: { clientTurnId: turn.clientTurnId, startedAt: createdAt, status: 'running' },
          // Keep the initial trace deliberately empty. The first visible item
          // must be a genuine model commentary or a live tool transition,
          // never generic reattachment filler.
          activity: [],
        },
      }]);
    });
    setActiveDurableTurn(turn);
    activeDurableTurnIdRef.current = turn.id;
    activeClientTurnIdRef.current = turn.clientTurnId;
    setAgentTyping(turn.status === 'running');
    const controller = new AbortController();
    // A queue promotion happens only after the previous durable turn has
    // released the conversation lease. Do not abort another reader here: that
    // was the UI bug that made queued work appear to start immediately.
    activeChatAbortRef.current = controller;
    const toolStartedAt = new Map<string, number>();
    let streamedBody = '';
    void streamSse(`/v1/conversations/${id}/turns/${turn.id}/events?after=0`, { method: 'GET', signal: controller.signal }, {
      onEvent(event, data) {
        if (event === 'delta') {
          const delta = data as ChatDelta;
          if (delta.type === 'text') {
            streamedBody += delta.delta;
            setMessages((current) => current.map((message) => message.id === streamId ? { ...message, text: streamedBody } : message));
          } else if (delta.type === 'activity' || delta.type === 'commentary' || delta.type === 'swarm') {
            if (delta.type === 'activity') updateActiveTask({ label: delta.label });
            setMessages((current) => current.map((message) => (
              message.id === streamId ? withTurnProgress(message, delta) : message
            )));
          } else if (delta.type === 'tool_call') {
            toolStartedAt.set(delta.id, performance.now());
            applyToolCallDelta(streamId, delta);
          } else if (delta.type === 'tool_result') {
            applyToolResultDelta(streamId, delta, toolStartedAt);
          } else if (delta.type === 'confirmation_required') {
            applyConfirmationDelta(streamId, delta);
          } else if (delta.type === 'plan') {
            setMessages((current) => current.map((message) => message.id === streamId
              ? { ...message, metadata: { ...(message.metadata ?? {}), plan: delta.plan } }
              : message));
          } else if (delta.type === 'execution') {
            setActiveDurableTurn((current) => current ? { ...current, executionEnvelope: delta.envelope, contextManifest: delta.context, effectiveMode: delta.envelope.effectiveMode } : current);
          } else if (delta.type === 'done') {
            setAgentTyping(false);
            setMessages((current) => current.map((message) => message.id === streamId
              ? { ...message, deliveryStatus: delta.finishReason === 'error' ? 'failed' : 'delivered' }
              : message));
          }
        } else if (event === 'message') {
          const persisted = normalizeAgentMessage(data as AgentMsg);
          setMessages((current) => mergeMessage(current, persisted));
        } else if (event === 'error') {
          setAgentTyping(false);
          const message = streamErrorMessage(data);
          setMessages((current) => current.map((item) => item.id === streamId
            ? withChatFailure({ ...item, text: item.text || message }, message)
            : item));
        }
      },
    }).then(() => api<{ turn: DurableConversationTurn }>(`/v1/conversations/${id}/turns/${turn.id}`))
      .then(({ turn: latest }) => {
        updateTurnChangeSummary(latest.id, latest.changeSet);
        const terminal = latest.status === 'completed' || latest.status === 'failed' || latest.status === 'cancelled';
        setActiveDurableTurn(terminal ? null : latest);
        if (terminal) {
          activeDurableTurnIdRef.current = null;
          if (activeClientTurnIdRef.current === turn.clientTurnId) activeClientTurnIdRef.current = null;
        }
      })
      .catch((error) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) toast.error('Could not reconnect to mission', apiErrorMessage(error));
      });
  }

  async function startNewConversation() {
    if (kind !== 'agent') return;
    try {
      const result = await api<{ conversationId: string }>(`/v1/conversations/${id}/new`, { method: 'POST' });
      setMessages([]);
      setHasMore(false);
      setLoading(false);
      setAgentTyping(false);
      onConversationReset?.(result.conversationId);
      window.dispatchEvent(new CustomEvent('agentis:chat-history-changed'));
      toast.success('New conversation ready');
    } catch (error) {
      toast.error('Could not start a new conversation', apiErrorMessage(error));
    }
  }

  useEffect(() => {
    function onNewConversation(event: Event) {
      const detail = (event as CustomEvent<{ kind?: string; id?: string }>).detail;
      if (detail?.kind !== kind || detail?.id !== id) return;
      void startNewConversation();
    }
    window.addEventListener('agentis:chat-new-conversation', onNewConversation);
    return () => window.removeEventListener('agentis:chat-new-conversation', onNewConversation);
  });

  useEffect(() => {
    const nextKey = autoSendInitialDraft && initialDraft?.trim()
      ? `${kind}:${id}:${initialDraft}`
      : null;
    if (!nextKey || autoSentDraftKeyRef.current === nextKey) return;
    autoSentDraftKeyRef.current = nextKey;
    setComposerInitialText('');
    void handleSend(initialDraft!);
    onInitialDraftUsed?.();
  }, [autoSendInitialDraft, handleSend, id, initialDraft, kind, onInitialDraftUsed]);

  async function handleCopy(message: ChatMessage) {
    try {
      await navigator.clipboard.writeText(message.text);
      toast.success('Copied to clipboard');
    } catch {
      // no-op
    }
  }

  async function rerunFromEditedMessage(message: ChatMessage, value: string) {
    const clientTurnId = createClientTurnId();
    const streamId = `stream-${clientTurnId}`;
    // Preserve the operator bubble's historical position, but never inherit
    // the superseded run's elapsed clock or execution identity.
    const createdAt = new Date().toISOString();
    const editedMessage: ChatMessage = {
      ...message,
      text: value,
      deliveryStatus: 'delivered',
      metadata: {
        ...(message.metadata ?? {}),
        clientTurnId,
      },
    };
    const streamingMessage: ChatMessage = {
      id: streamId,
      authorId: id,
      authorKind: 'agent',
      text: '',
      createdAt,
      deliveryStatus: 'sending',
      metadata: {
        source: 'chat_loop',
        clientTurnId,
        turn: { clientTurnId, startedAt: createdAt, status: 'running' },
        activity: immediateTurnActivity(clientTurnId, id, value, createdAt),
      },
    };

    setEditingId(null);
    setActiveDurableTurn(null);
    activeDurableTurnIdRef.current = null;
    activeClientTurnIdRef.current = null;
    setMessages((current) => {
      const ordered = sortMessages(current);
      const anchorIndex = ordered.findIndex((item) => item.id === message.id);
      const kept = anchorIndex >= 0 ? ordered.slice(0, anchorIndex) : ordered.filter((item) => item.createdAt < message.createdAt);
      return dedupeMessages([...kept, editedMessage, streamingMessage]);
    });
    setAgentTyping(true);
    setActiveTask({ agentId: id, agentName: name, label: taskLabel(value), done: 0, total: 0, startedAt: Date.now() });

    const toolStartedAt = new Map<string, number>();
    let toolTotal = 0;
    let toolDone = 0;
    let streamedBody = '';

    try {
      const controller = new AbortController();
      activeChatAbortRef.current?.abort();
      activeChatAbortRef.current = controller;
      const viewportOverride = pendingViewportOverrideRef.current;
      await streamSse(`${endpoint}/${message.id}/rewrite${querySuffix}`, {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          text: value,
          clientTurnId,
          useViewportContext: true,
          viewportOverride,
        }),
      }, {
        onEvent(event, data) {
          if (event === 'delta') {
            const delta = data as ChatDelta;
            if (delta.type === 'text') {
              streamedBody += delta.delta;
              setMessages((current) => current.map((item) => (
                item.id === streamId
                  ? { ...item, text: streamedBody, deliveryStatus: 'sending' }
                  : item
              )));
            } else if (delta.type === 'activity' || delta.type === 'commentary' || delta.type === 'swarm') {
              if (delta.type === 'activity') updateActiveTask({ label: delta.label });
              setMessages((current) => current.map((item) => (
                item.id === streamId ? withTurnProgress(item, delta) : item
              )));
            } else if (delta.type === 'tool_call') {
              toolStartedAt.set(delta.id, performance.now());
              toolTotal += 1;
              updateActiveTask({ total: toolTotal });
              applyToolCallDelta(streamId, delta);
            } else if (delta.type === 'tool_result') {
              toolDone += 1;
              updateActiveTask({ done: toolDone });
              applyToolResultDelta(streamId, delta, toolStartedAt);
            } else if (delta.type === 'confirmation_required') {
              applyConfirmationDelta(streamId, delta);
            } else if (delta.type === 'plan') {
              setMessages((current) => current.map((message) => message.id === streamId
                ? { ...message, metadata: { ...(message.metadata ?? {}), plan: delta.plan } }
                : message));
            } else if (delta.type === 'done') {
              setAgentTyping(false);
              setActiveTask(null);
              setMessages((current) => current.map((item) => (
                item.id === streamId
                  ? { ...item, deliveryStatus: delta.finishReason === 'error' ? 'failed' : 'delivered' }
                  : item
              )));
            }
          } else if (event === 'message') {
            const persisted = normalizeAgentMessage(data as AgentMsg);
            setMessages((current) => {
              const streamMessage = current.find((item) => item.id === streamId);
              return mergeMessage(current, {
                ...persisted,
                metadata: {
                  ...persisted.metadata,
                  clientTurnId: persisted.metadata?.clientTurnId ?? clientTurnId,
                  toolCalls: streamMessage?.metadata?.toolCalls ?? persisted.metadata?.toolCalls,
                  activity: persisted.metadata?.activity ?? streamMessage?.metadata?.activity,
                  commentary: persisted.metadata?.commentary ?? streamMessage?.metadata?.commentary,
                  turn: persisted.metadata?.turn ?? streamMessage?.metadata?.turn,
                },
              });
            });
          } else if (event === 'error') {
            const errorMessage = streamErrorMessage(data);
            setAgentTyping(false);
            setActiveTask(null);
            setMessages((current) => current.map((item) => (
              item.id === streamId
                ? withChatFailure({ ...item, text: item.text || errorMessage }, errorMessage)
                : item
            )));
            toast.error('Agent could not reply', errorMessage);
          }
        },
      });
      pendingViewportOverrideRef.current = null;
    } catch (error) {
      setAgentTyping(false);
      setActiveTask(null);
      const stopped = error instanceof DOMException && error.name === 'AbortError';
      const shouldKeepStoppedBubble = streamedBody.trim().length > 0 || toolTotal > 0;
      const completedAt = new Date().toISOString();
      setMessages((current) => current.flatMap((item) => {
        if (item.id !== streamId) return [item];
        if (stopped && !shouldKeepStoppedBubble) return [];
        return [{
          ...item,
          deliveryStatus: stopped ? 'delivered' as const : 'failed' as const,
          metadata: {
            ...(item.metadata ?? {}),
            toolCalls: (item.metadata?.toolCalls ?? []).map((tool) => (
              tool.status === 'running' || tool.status === 'paused'
                ? { ...tool, status: stopped ? 'stopped' as const : 'error' as const }
                : tool
            )),
            turn: {
              ...(item.metadata?.turn ?? { clientTurnId, startedAt: item.createdAt }),
              completedAt,
              status: stopped ? 'stopped' : 'failed',
            },
          },
        }];
      }));
      if (!stopped) toast.error('Failed to rerun from edited message', apiErrorMessage(error));
    } finally {
      activeChatAbortRef.current = null;
    }
  }

  async function handleEditSave(message: ChatMessage, text: string) {
    const value = text.trim();
    if (!value) return;
    if (kind === 'agent' && message.authorKind === 'operator') {
      if (message.metadata?.queued && message.metadata.durableTurnId) {
        await editQueuedTurn(message, value);
        return;
      }
      await rerunFromEditedMessage(message, value);
      return;
    }
    try {
      const res = await api<{ message?: AgentMsg | RoomMsg }>(`${endpoint}/${message.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ text: value }),
      });
      setEditingId(null);
      if (res.message) {
        setMessages((prev) => upsertMessage(
          prev,
          kind === 'agent'
            ? normalizeAgentMessage(res.message as AgentMsg)
            : normalizeRoomMessage(res.message as RoomMsg),
        ));
      } else {
        setMessages((prev) => prev.map((item) => (item.id === message.id ? { ...item, text: value } : item)));
      }
    } catch (error) {
      toast.error('Failed to edit message', String(error));
    }
  }

  const awarenessActive = kind === 'agent'
    && awareness.context.surface !== 'chat'
    && awareness.context.surface !== 'unknown';
  const runtimeWarning = kind === 'agent' && !agentNoAdapter
    ? runtimeCapabilityWarning(agentRuntime)
    : null;
  const blockedNotice = activeDurableTurn?.status === 'blocked'
    ? blockedTurnNotice(activeDurableTurn.error)
    : null;
  // When an assistant bubble is mid-stream it shows its own in-bubble typing
  // indicator, so the standalone "is thinking…" footer would be a duplicate.
  const streamingAgentActive = messages.some(
    (message) => message.authorKind === 'agent' && message.deliveryStatus === 'sending',
  );

  return (
    <div className={clsx('flex h-full min-w-0 flex-col overflow-hidden', immersive && 'agentis-chat-immersive')}>
      <div ref={scrollRef} className={clsx('min-w-0 flex-1 overflow-x-hidden overflow-y-auto', immersive ? 'px-5 py-6 md:px-10' : 'px-3 py-3')}>
        {id === '__broadcast__' && (
          <div className="mb-4 mt-2 flex items-center justify-center text-center">
            <span className="rounded-full bg-surface-2 px-3 py-1 text-[11px] text-text-muted border border-line shadow-sm">
              Observe agent-to-agent conversations, or use <strong className="text-text-secondary font-semibold">@</strong> to join in.
            </span>
          </div>
        )}
        {loading ? (
          <div className="space-y-2">
            <Skeleton height={36} />
            <Skeleton height={48} width="80%" />
            <Skeleton height={36} />
          </div>
        ) : messages.length === 0 && pendingQueue.length === 0 ? (
          immersive && kind === 'agent'
            ? <ImmersiveEmptyState name={name} body={emptyBody} />
            : <div className="px-2 py-8 text-center text-[13px] text-text-muted">{emptyBody ?? `Send a message to start a conversation with ${name}.`}</div>
        ) : (
          <ul className={clsx('mx-auto flex min-w-0 flex-col gap-2.5', immersive && 'max-w-[860px] gap-5')}>
            {hasMore && (
              <li className="flex justify-center">
                <button
                  type="button"
                  onClick={() => void loadOlder()}
                  disabled={loadingOlder}
                  className="rounded-btn border border-line bg-surface-2 px-2.5 py-1 text-[11px] text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary disabled:opacity-60"
                >
                  {loadingOlder ? 'Loading...' : 'Load earlier'}
                </button>
              </li>
            )}
            {messages.filter((message) => message.metadata?.source !== 'proactive' && message.metadata?.source !== 'workflow' && !(message.metadata?.card && !message.text.trim())).map((message) => (
              <MessageBubble
                key={message.id}
                msg={message}
                agentData={agentMap[message.authorId]}
                showAuthor={kind === 'room'}
                onCopy={() => void handleCopy(message)}
                isEditing={editingId === message.id}
                readOnly={readOnly}
                onStartEdit={() => setEditingId(message.id)}
                onSaveEdit={(text) => void handleEditSave(message, text)}
                onCancelEdit={() => setEditingId(null)}
                onConfirmAction={(confirmation, approved) => void handleConfirmationAction(message.id, confirmation, approved)}
                onTurnChange={() => void handleTurnChange(message)}
                onConfirmTurnChange={(direction) => void handleTurnChange(message, { confirmed: true, direction })}
                onDismissTurnChange={() => setTurnChangePrompt(null)}
                turnChangeBusy={turnChangeBusyId === message.metadata?.durableTurnId}
                turnChangePrompt={turnChangePrompt?.turnId === message.metadata?.durableTurnId ? turnChangePrompt : null}
                chatAgentId={kind === 'agent' ? id : undefined}
                onCancelQueued={readOnly || !message.metadata?.queued ? undefined : () => void cancelQueuedTurn(message)}
                onSendQueuedNow={readOnly || !message.metadata?.queued ? undefined : () => void sendQueuedTurnNow(message)}
              />
            ))}
            {kind === 'agent' && pendingQueue.map((item) => (
              <QueuedMessageBubble
                key={item.id}
                item={item}
                onCancel={readOnly ? undefined : () => void cancelQueuedMessage(item.id)}
                onEdit={readOnly ? undefined : (text) => editQueuedMessage(item.id, text)}
                onSendNow={readOnly ? undefined : () => sendQueuedMessageNow(item.id)}
              />
            ))}
          </ul>
        )}
        {agentTyping && kind === 'agent' && !streamingAgentActive && (
          <div className="mt-2 flex items-center gap-2 px-1 text-[11px] italic text-text-muted">
            <TypingDots />
            <span>{name} is thinking…</span>
          </div>
        )}
        {kind === 'room' && pendingResponders.length > 0 && (
          <div className="mt-2 space-y-2 px-1">
            {pendingResponders.map((agentId) => {
              const responderName = agentMap[agentId]?.name ?? 'Agent';
              const activities = roomResponderActivities[agentId] ?? [];
              return (
                <div key={agentId} className="rounded-lg border border-line/55 bg-surface-2/45 px-2.5 py-2">
                  <div className="mb-1.5 flex items-center gap-2 text-[11px] italic text-text-muted">
                    <TypingDots />
                    <span>{responderName} is responding…</span>
                  </div>
                  <AgentTurnTrace activities={activities} streaming />
                </div>
              );
            })}
          </div>
        )}
        {!isAtBottom && (
          <button
            type="button"
            onClick={() => scrollToBottom('smooth')}
            className="sticky bottom-2 mx-auto mt-2 block rounded-full border border-line bg-surface px-3 py-1 text-[11px] text-text-secondary shadow-card hover:text-text-primary"
          >
            Jump to latest
          </button>
        )}
      </div>

      {agentNoAdapter && kind === 'agent' && (
        <div className="border-t border-warn/30 bg-warn-soft px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Plug size={14} className="text-warn" />
            <span className="flex-1 text-[12px] text-text-primary">
              {name} has no configured runtime yet. Configure one to start chatting.
            </span>
          </div>
        </div>
      )}

      {runtimeWarning && (
        <div className="border-t border-warn/20 bg-[linear-gradient(135deg,rgba(245,158,11,0.10),rgba(20,184,166,0.06))] px-3 py-2.5">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-text-primary">{runtimeWarning.title}</div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-text-muted">{runtimeWarning.body}</div>
            </div>
          </div>
        </div>
      )}

      {blockedNotice && (
        <div className="border-t border-line/55 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <AlertTriangle size={13} className="shrink-0 text-text-muted" />
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium text-text-primary">{blockedNotice.title}</div>
              <div className="mt-0.5 text-[11px] text-text-muted">
                {blockedNotice.body}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void resumeBlockedTurn()}
              className="h-8 rounded-md border border-line bg-surface-2 px-3 text-[11px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
            >
              {blockedNotice.action}
            </button>
          </div>
        </div>
      )}

      {readOnly ? (
        <div className="border-t border-line bg-surface-2 px-3 py-2 text-[12px] text-text-muted">
          This is a saved conversation. Use the + button in the header to start a fresh chat with {name}.
        </div>
      ) : (
        <Composer
          key={`${kind}:${id}:${conversationId ?? 'active'}:${composerInitialText}`}
          onSend={handleSend}
          onPermissionModeChange={setPermissionMode}
          awareness={{ label: awareness.label, active: awarenessActive }}
          initialText={composerInitialText}
          placeholder={composerPlaceholder}
          draftKey={`${kind}:${id}:${conversationId ?? 'active'}`}
          agentId={kind === 'agent' ? id : undefined}
          isRunning={streamingAgentActive}
          onStop={stopActiveTurn}
          footer={kind === 'agent' ? <PermissionModePicker value={permissionMode} onChange={(mode) => void setPermissionMode(mode)} /> : undefined}
        />
      )}
    </div>
  );
}

function upsertStable<T extends { id: string }>(items: T[], next: T, limit = 80): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) return [...items, next].slice(-limit);
  const copy = [...items];
  copy[index] = next;
  return copy.slice(-limit);
}

function withTurnProgress(message: ChatMessage, delta: Extract<ChatDelta, { type: 'activity' | 'commentary' | 'swarm' }>): ChatMessage {
  const metadata = { ...(message.metadata ?? {}), source: message.metadata?.source ?? 'chat_loop' as const };
  if (delta.type === 'swarm') {
    metadata.swarms = upsertStable(message.metadata?.swarms ?? [], delta.swarm, 12);
  } else if (delta.type === 'commentary') {
    metadata.commentary = delta.text.trim()
      ? upsertStable(message.metadata?.commentary ?? [], delta)
      : (message.metadata?.commentary ?? []).filter((entry) => entry.id !== delta.id);
  } else {
    metadata.activity = upsertStable(message.metadata?.activity ?? [], delta);
  }
  return { ...message, metadata };
}

function hydrateDurableTurnHistory(
  messages: ChatMessage[],
  history: DurableConversationTurnHistory[],
): ChatMessage[] {
  if (history.length === 0) return messages;
  const byClientTurn = new Map(history.map((entry) => [entry.turn.clientTurnId, entry]));
  return messages.map((message) => {
    const clientTurnId = message.metadata?.clientTurnId ?? message.metadata?.turn?.clientTurnId;
    if (!clientTurnId) return message;
    const entry = byClientTurn.get(clientTurnId);
    if (!entry) return message;
    if (message.authorKind === 'operator') {
      return {
        ...message,
        metadata: {
          ...(message.metadata ?? {}),
          durableTurnId: entry.turn.id,
          queued: entry.turn.status === 'queued',
        },
      };
    }
    if (message.authorKind !== 'agent') return message;
    let hydrated: ChatMessage = {
      ...message,
      metadata: {
        ...(message.metadata ?? {}),
        durableTurnId: entry.turn.id,
        changeSet: entry.turn.changeSet ?? null,
        turn: {
          clientTurnId,
          startedAt: entry.turn.startedAt ?? entry.turn.createdAt,
          completedAt: entry.turn.completedAt ?? undefined,
          status: durableTraceStatus(entry.turn.status),
        },
      },
    };
    for (const event of entry.events) {
      if (event.visibility === 'technical') continue;
      const delta = event.data as Partial<ChatDelta> | null;
      if (delta?.type === 'commentary' || delta?.type === 'activity' || delta?.type === 'swarm') {
        hydrated = withTurnProgress(hydrated, delta as Extract<ChatDelta, { type: 'activity' | 'commentary' | 'swarm' }>);
      }
    }
    return hydrated;
  });
}

function durableTraceStatus(status: DurableConversationTurn['status']): ChatTurnTrace['status'] {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  if (status === 'interrupted' || status === 'paused') return 'interrupted';
  if (status === 'awaiting_approval' || status === 'blocked') return 'blocked';
  return 'running';
}

function ImmersiveEmptyState({ name, body }: { name: string; body?: string }) {
  return (
    <div className="mx-auto flex min-h-[52vh] max-w-[680px] flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-3 text-[15px] font-medium text-text-primary">{name}</div>
      <p className="max-w-[520px] text-[13px] leading-6 text-text-muted">
        {body ?? 'Ask a question, share a file, or describe the work you want completed.'}
      </p>
    </div>
  );
}

/** A queued follow-up stays in the conversation flow and exposes the actions
 * needed to change its delivery without returning to the composer. */
function QueuedMessageBubble({
  item,
  onCancel,
  onEdit,
  onSendNow,
}: {
  item: QueuedItem;
  onCancel?: () => Promise<void> | void;
  onEdit?: (text: string) => Promise<void> | void;
  onSendNow?: () => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void> | void) {
    setBusy(true);
    try {
      await action();
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="group flex min-w-0 max-w-full flex-col items-end gap-0.5">
      <div className="min-w-0 max-w-[85%] overflow-hidden rounded-[18px] border border-line/45 bg-surface-3/50 px-3.5 py-2.5 text-[13px] leading-relaxed text-text-primary">
        {editing ? (
          <textarea
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setEditing(false);
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (draft.trim() && onEdit) void run(() => onEdit(draft.trim()));
              }
            }}
            rows={3}
            className="min-h-[60px] w-full resize-y rounded-lg border border-line bg-surface px-2.5 py-2 text-[13px] text-text-primary outline-none focus:border-accent"
          />
        ) : (
          <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{item.text}</div>
        )}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-line/45 pt-2 text-[10px] text-text-muted">
          <div className="flex items-center gap-1">
            <Clock3 size={10} />
            <span>Queued{item.position > 0 ? ` · ${item.position} ahead` : ''}</span>
          </div>
          {!busy && (onEdit || onSendNow || onCancel) && (
            <div className="flex items-center gap-1">
              {editing ? (
                <>
                  <button
                    type="button"
                    onClick={() => { if (draft.trim() && onEdit) void run(() => onEdit(draft.trim())); }}
                    disabled={!draft.trim() || !onEdit}
                    className="rounded px-1.5 py-1 font-medium text-accent hover:bg-accent/10 disabled:opacity-40"
                  >
                    Save
                  </button>
                  <button type="button" onClick={() => setEditing(false)} className="rounded px-1.5 py-1 hover:bg-surface-2">Close</button>
                </>
              ) : (
                <>
                  {onEdit && (
                    <button
                      type="button"
                      onClick={() => { setDraft(item.text); setEditing(true); }}
                      className="inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-surface-2 hover:text-text-primary"
                    >
                      <Pencil size={10} /> Edit
                    </button>
                  )}
                  {onSendNow && (
                    <button
                      type="button"
                      onClick={() => void run(onSendNow)}
                      className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-accent hover:bg-accent/10"
                    >
                      <Send size={10} /> Send now
                    </button>
                  )}
                  {onCancel && (
                    <button
                      type="button"
                      onClick={() => void run(onCancel)}
                      className="inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-danger/10 hover:text-danger"
                    >
                      <X size={10} /> Cancel
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          {busy && <Loader2 size={11} className="animate-spin text-accent" />}
        </div>
      </div>
    </li>
  );
}

function MessageBubble({
  msg,
  agentData,
  onCopy,
  isEditing,
  readOnly,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onConfirmAction,
  onTurnChange,
  onConfirmTurnChange,
  onDismissTurnChange,
  turnChangeBusy,
  turnChangePrompt,
  showAuthor,
  chatAgentId,
  onCancelQueued,
  onSendQueuedNow,
}: {
  msg: ChatMessage;
  onCopy: () => void;
  isEditing: boolean;
  readOnly: boolean;
  onStartEdit: () => void;
  onSaveEdit: (text: string) => void;
  onCancelEdit: () => void;
  onConfirmAction: (confirmation: ConfirmationCardData, approved: boolean) => void;
  onTurnChange: () => void;
  onConfirmTurnChange: (direction: 'undo' | 'redo') => void;
  onDismissTurnChange: () => void;
  turnChangeBusy: boolean;
  turnChangePrompt: TurnChangePrompt | null;
  showAuthor?: boolean;
  agentData?: { name: string; role?: string | null; colorHex?: string | null };
  chatAgentId?: string;
  onCancelQueued?: () => Promise<void> | void;
  onSendQueuedNow?: () => Promise<void> | void;
}) {
  const isOperator = msg.authorKind === 'operator';
  const [editDraft, setEditDraft] = useState(msg.text);
  const streaming = msg.deliveryStatus === 'sending';
  // Render old/cached Plan-mode protocol as ordinary Markdown even while the
  // message is streaming. Architecture JSON is internal data, never chat copy.
  const body = isOperator ? msg.text : normalizeAgentPlanText(msg.text);
  const toolCalls = msg.metadata?.toolCalls ?? [];
  const activities = msg.metadata?.activity ?? [];
  const swarms = msg.metadata?.swarms ?? [];
  const artifactIds = useMemo(() => {
    const ids = new Set(msg.artifactIds ?? []);
    toolCalls.forEach((call) => collectArtifactIds(call.result, ids));
    return [...ids];
  }, [msg.artifactIds, toolCalls]);

  useEffect(() => {
    if (isEditing) setEditDraft(msg.text);
  }, [isEditing, msg.text]);

  return (
    <li className={clsx('group flex min-w-0 max-w-full flex-col gap-0.5', isOperator ? 'items-end' : 'items-start')}>
      {!isOperator && showAuthor && msg.authorKind !== 'system' && (
        <span
          className="px-1 text-[11px] font-medium"
          style={{ color: agentData?.colorHex || 'var(--text-muted)' }}
        >
          {agentData?.name || msg.authorName || msg.authorId}
          {agentData?.role ? ` - ${agentData.role}` : ''}
        </span>
      )}
      <div className={clsx('flex min-w-0 max-w-full items-start gap-1.5', !isOperator && 'w-full')}>
        {isOperator && !readOnly && !msg.metadata?.queued && (
          <MessageActions onCopy={onCopy} onEdit={onStartEdit} />
        )}
        <div
          className={clsx(
            'chat-message-surface min-w-0 text-[13px] leading-relaxed',
                  isOperator
                    ? 'max-w-[85%] overflow-hidden rounded-[18px] px-3.5 py-2.5'
                    : 'w-full max-w-full overflow-visible px-0 py-0',
            isOperator
              ? 'border border-line/55 bg-surface-3/75 text-text-primary shadow-sm'
              : msg.authorKind === 'system'
                ? 'rounded-lg border border-dashed border-line bg-surface-2 px-3 py-2 text-text-muted'
                : 'bg-transparent text-text-primary',
          )}
        >
          {!isOperator && (streaming || activities.length > 0 || (msg.metadata?.commentary?.length ?? 0) > 0 || toolCalls.length > 0) && (
            <AgentTurnTrace
              activities={activities}
              commentary={msg.metadata?.commentary}
              toolCalls={toolCalls}
              turn={msg.metadata?.turn}
              envelope={msg.metadata?.executionEnvelope}
              context={msg.metadata?.contextManifest}
              streaming={streaming}
              failed={msg.deliveryStatus === 'failed'}
            />
          )}
          <ChatArtifactAttachments artifactIds={artifactIds} />
          {!isOperator && msg.metadata?.failureMessage && (
            <div role="alert" className="mb-3 flex max-w-[760px] items-start gap-2 rounded-lg border border-danger/35 bg-danger/8 px-3 py-2 text-[12px] leading-5 text-danger">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{msg.metadata.failureMessage}</span>
            </div>
          )}
          {!isOperator && swarms.map((swarm) => <ChatSwarmTrace key={swarm.id} swarm={swarm} agentId={chatAgentId} />)}
          {!isEditing && body && (
            isOperator ? (
              <div className="mb-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{body}</div>
            ) : (
              <div className="mb-2 break-words [overflow-wrap:anywhere]">
                <ChatMarkdown text={body} />
                {streaming ? <StreamingCursor /> : null}
              </div>
            )
          )}
          {isOperator && !isEditing && (msg.metadata?.queued || msg.metadata?.queueCancelled || streaming) && (
            <div className={clsx('mt-1 flex flex-wrap items-center justify-end gap-2 text-[10px]', msg.metadata?.queueCancelled ? 'text-danger/80' : 'text-text-muted')}>
              {msg.metadata?.queueCancelled ? <X size={10} /> : msg.metadata?.queued ? <Clock3 size={10} /> : <Loader2 size={10} className="animate-spin" />}
              <span>
                {msg.metadata?.queueCancelled
                  ? 'Cancelled'
                  : msg.metadata?.queued
                  ? `Queued${(msg.metadata.queuePosition ?? 0) > 0 ? ` · ${msg.metadata.queuePosition} ahead` : ''}`
                  : 'Sending…'}
              </span>
            </div>
          )}
          {isOperator && !isEditing && msg.metadata?.queued && !readOnly && (
            <div className="mt-2 flex items-center justify-end gap-1 border-t border-line/45 pt-2 text-[10px]">
              <button
                type="button"
                onClick={onStartEdit}
                className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
              >
                <Pencil size={10} /> Edit
              </button>
              <button
                type="button"
                onClick={() => { if (onSendQueuedNow) void onSendQueuedNow(); }}
                className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-accent hover:bg-accent/10"
              >
                <Send size={10} /> Send now
              </button>
              <button
                type="button"
                onClick={() => { if (onCancelQueued) void onCancelQueued(); }}
                className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-text-muted hover:bg-danger/10 hover:text-danger"
              >
                <X size={10} /> Cancel
              </button>
            </div>
          )}
          {msg.metadata?.confirmation && (
            <ConfirmationCard
              data={msg.metadata.confirmation}
              onApprove={() => onConfirmAction(msg.metadata!.confirmation!, true)}
              onCancel={() => onConfirmAction(msg.metadata!.confirmation!, false)}
            />
          )}
          {isEditing ? (
            <div className="flex flex-col gap-1.5">
              <textarea
                value={editDraft}
                onChange={(event) => setEditDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    onSaveEdit(editDraft);
                  }
                  if (event.key === 'Escape') onCancelEdit();
                }}
                autoFocus
                rows={2}
                className="min-h-[40px] w-full resize-none rounded border border-line bg-surface px-2 py-1 text-[13px] text-text-primary focus:border-accent focus:outline-none"
                style={{ maxHeight: 120 }}
              />
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => onSaveEdit(editDraft)}
                  disabled={!editDraft.trim()}
                  className="inline-flex h-6 items-center rounded-btn bg-accent px-2 text-[11px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={onCancelEdit}
                  className="inline-flex h-6 items-center rounded-btn border border-line px-2 text-[11px] text-text-secondary hover:bg-surface-2"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (msg.metadata?.confirmation || toolCalls.length > 0 || activities.length > 0 || (msg.metadata?.commentary?.length ?? 0) > 0 || body || artifactIds.length > 0) ? null : streaming && !isOperator ? (
            <TypingDots />
          ) : !isOperator ? null : (
            <div className="text-[12px] italic text-text-muted">No text content</div>
          )}
        </div>
        {!isOperator && (
          <MessageActions
            onCopy={onCopy}
            changeSet={msg.metadata?.changeSet}
            changeBusy={turnChangeBusy}
            changePrompt={turnChangePrompt}
            onTurnChange={onTurnChange}
            onConfirmTurnChange={onConfirmTurnChange}
            onDismissTurnChange={onDismissTurnChange}
          />
        )}
      </div>
    </li>
  );
}



function ConfirmationCard({
  data,
  onApprove,
  onCancel,
}: {
  data: ConfirmationCardData;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [detailsOpen, setDetailsOpen] = useState(false);
  const expiresAtMs = Date.parse(data.expiresAt);
  const hasExpiry = Number.isFinite(expiresAtMs);
  const expired = data.status === 'pending' && hasExpiry && expiresAtMs <= now;
  const disabled = data.status !== 'pending' || expired;
  const impact = data.impact ?? inferConfirmationImpact(data);
  const riskLevel = impact.riskLevel ?? 'medium';
  const risk = confirmationRiskStyle(riskLevel);
  const details = impact.details?.filter(Boolean) ?? [];
  const auditPreview = formatConfirmationJson(data.toolCall.args);

  useEffect(() => {
    if (data.status !== 'pending' || !hasExpiry) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [data.status, hasExpiry]);

  return (
    <div className={clsx(
      'mb-2 overflow-hidden rounded-2xl border bg-canvas/80 text-[12px] text-text-primary shadow-[0_24px_55px_-42px_rgba(0,0,0,0.85)]',
      risk.container,
    )} data-testid="chat-confirmation-card">
      <div className="relative p-3">
        <div className={clsx('pointer-events-none absolute inset-x-0 top-0 h-1', risk.bar)} />
        <div className="flex items-start gap-2.5">
          <div className={clsx('mt-0.5 rounded-xl border p-2', risk.icon)}>
            {riskLevel === 'danger' || riskLevel === 'high'
              ? <AlertTriangle size={15} />
              : <ShieldCheck size={15} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <div className="font-semibold">{data.title}</div>
              <span className={clsx('rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]', risk.badge)}>
                {riskLevel} risk
              </span>
            </div>
            <div className="mt-1 text-[12px] leading-relaxed text-text-secondary">{impact.summary}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-text-muted">
              <span className="font-mono">{data.toolCall.name}</span>
              <span className="inline-flex items-center gap-1">
                <Clock3 size={11} />
                {expired ? 'Expired' : hasExpiry ? `${formatRemainingTime(expiresAtMs - now)} left` : data.status}
              </span>
              {impact.reversible !== undefined && (
                <span>{impact.reversible ? 'Reversible' : 'Not automatically reversible'}</span>
              )}
              {impact.externalSideEffects && <span>May trigger external side effects</span>}
            </div>
          </div>
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-text-muted">
            {expired ? 'expired' : data.status}
          </span>
        </div>

        {details.length > 0 && (
          <ul className="mt-2.5 space-y-1.5 rounded-lg border border-line/40 bg-surface/30 px-3 py-2 text-[11px] text-text-secondary">
            {details.slice(0, 4).map((detail) => (
              <li key={detail} className="flex items-start gap-1.5 leading-normal">
                <span className={clsx('mt-1.5 h-1 w-1 shrink-0 rounded-full', risk.dot)} />
                <span className="break-all font-sans">{detail}</span>
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          onClick={() => setDetailsOpen((value) => !value)}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-line/60 bg-surface/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted transition hover:bg-surface-2 hover:text-text-primary"
          aria-expanded={detailsOpen}
        >
          <FileText size={11} />
          {detailsOpen ? 'Hide audit payload' : 'Show audit payload'}
        </button>
        {detailsOpen && (
          <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line/70 bg-canvas/80 p-2 font-mono text-[10px] leading-relaxed text-text-secondary">
            {auditPreview}
          </pre>
        )}

        <div className="mt-3 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={onApprove}
          disabled={disabled}
          className="inline-flex h-8 items-center gap-1.5 rounded-btn bg-accent px-3 text-[11px] font-semibold text-canvas transition hover:bg-accent-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {data.status === 'approving' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {data.confirmLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={disabled}
          className="inline-flex h-8 items-center gap-1.5 rounded-btn border border-line bg-surface px-3 text-[11px] font-semibold text-text-secondary transition hover:bg-surface-2 hover:text-text-primary active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <X size={12} />
          {data.cancelLabel}
        </button>
        {disabled && expired && (
          <span className="inline-flex h-8 items-center text-[11px] text-text-muted">Send the request again to refresh approval.</span>
        )}
        </div>
      </div>
    </div>
  );
}

function inferConfirmationImpact(data: ConfirmationCardData): NonNullable<ConfirmationCardData['impact']> {
  return {
    summary: data.body.split('\n').find((line) => line.trim()) ?? 'This action changes platform state.',
    details: [],
    riskLevel: 'medium',
    reversible: false,
    externalSideEffects: false,
  };
}

function confirmationRiskStyle(level: NonNullable<NonNullable<ConfirmationCardData['impact']>['riskLevel']>) {
  const styles = {
    low: {
      container: 'border-accent/25',
      bar: 'bg-accent/70',
      badge: 'bg-accent/10 text-accent',
      icon: 'border-accent/25 bg-accent/10 text-accent',
      dot: 'bg-accent',
    },
    medium: {
      container: 'border-warn/35',
      bar: 'bg-warn/80',
      badge: 'bg-warn-soft text-warn',
      icon: 'border-warn/35 bg-warn-soft text-warn',
      dot: 'bg-warn',
    },
    high: {
      container: 'border-warn/50',
      bar: 'bg-warn',
      badge: 'bg-warn-soft text-warn',
      icon: 'border-warn/50 bg-warn-soft text-warn',
      dot: 'bg-warn',
    },
    danger: {
      container: 'border-danger/45',
      bar: 'bg-danger',
      badge: 'bg-danger/10 text-danger',
      icon: 'border-danger/40 bg-danger/10 text-danger',
      dot: 'bg-danger',
    },
  };
  return styles[level];
}

function formatRemainingTime(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes <= 0) return `${rest}s`;
  return `${minutes}m ${rest.toString().padStart(2, '0')}s`;
}

function formatConfirmationJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function asAppThreadHandoff(value: unknown): AppThreadHandoff | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.handoff !== 'app_thread.open' || typeof record.slug !== 'string') return null;
  return {
    handoff: 'app_thread.open',
    slug: record.slug,
    targetUrl: typeof record.targetUrl === 'string' ? record.targetUrl : undefined,
    carriedMessage: typeof record.carriedMessage === 'string' ? record.carriedMessage : null,
    reason: typeof record.reason === 'string' ? record.reason : null,
  };
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1" role="status" aria-label="Assistant is responding">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted/80 [animation-delay:-0.3s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted/80 [animation-delay:-0.15s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted/80" />
    </span>
  );
}

function StreamingCursor() {
  return (
    <span
      className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-[2px] animate-pulse rounded-sm bg-accent align-middle"
      aria-hidden
    />
  );
}

export function MessageActions({
  onCopy,
  onEdit,
  changeSet,
  changeBusy = false,
  changePrompt,
  onTurnChange,
  onConfirmTurnChange,
  onDismissTurnChange,
}: {
  onCopy: () => void;
  onEdit?: () => void;
  changeSet?: TurnChangeSummary | null;
  changeBusy?: boolean;
  changePrompt?: TurnChangePrompt | null;
  onTurnChange?: () => void;
  onConfirmTurnChange?: (direction: 'undo' | 'redo') => void;
  onDismissTurnChange?: () => void;
}) {
  const direction = changeSet?.state === 'undone' ? 'redo' : 'undo';
  const canChange = Boolean(
    changeSet
    && changeSet.reversibleCount > 0
    && (changeSet.state === 'undoable' || changeSet.state === 'undone')
    && onTurnChange,
  );
  const actionLabel = changeSet
    ? `${direction === 'undo' ? 'Undo' : 'Redo'} ${changeSet.reversibleCount} ${changeSet.reversibleCount === 1 ? 'change' : 'changes'}`
    : '';
  return (
    <div className="relative flex shrink-0 flex-col gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label="Edit"
          className="grid h-6 w-6 place-items-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
        >
          <Pencil size={11} />
        </button>
      )}
      {canChange && (
        <button
          type="button"
          onClick={onTurnChange}
          disabled={changeBusy}
          aria-label={actionLabel}
          title={actionLabel}
          className="grid h-6 w-6 place-items-center rounded-md text-text-muted transition hover:bg-surface-2 hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 disabled:cursor-wait disabled:opacity-70"
        >
          {changeBusy
            ? <Loader2 size={12} className="animate-spin" />
            : direction === 'undo'
              ? <Undo2 size={12} />
              : <Redo2 size={12} />}
        </button>
      )}
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copy"
        title="Copy"
        className="grid h-6 w-6 place-items-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
      >
        <Copy size={11} />
      </button>

      {changePrompt && (
        <div
          role={changePrompt.kind === 'conflict' ? 'alert' : 'dialog'}
          aria-label={changePrompt.kind === 'conflict' ? 'Undo conflict' : 'Confirm restoration'}
          className="absolute right-full top-0 z-40 mr-2 w-[280px] overflow-hidden rounded-xl border border-line/80 bg-canvas/98 p-3 text-left opacity-100 shadow-[0_18px_55px_-22px_rgba(0,0,0,0.9)] backdrop-blur"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-text-primary">
                {changePrompt.kind === 'conflict'
                  ? `Can’t ${changePrompt.direction} safely`
                  : `${changePrompt.direction === 'undo' ? 'Undo' : 'Redo'} these changes?`}
              </div>
              <div className="mt-1 text-[11px] leading-4 text-text-muted">
                {changePrompt.kind === 'conflict'
                  ? 'Later work overlaps this response. Nothing was changed.'
                  : `${changePrompt.summary.reversibleCount} local ${changePrompt.summary.reversibleCount === 1 ? 'change' : 'changes'} will be ${changePrompt.direction === 'undo' ? 'restored' : 'reapplied'}.`}
              </div>
            </div>
            <button
              type="button"
              onClick={onDismissTurnChange}
              aria-label="Close"
              className="grid h-5 w-5 shrink-0 place-items-center rounded text-text-muted hover:bg-surface-2 hover:text-text-primary"
            >
              <X size={12} />
            </button>
          </div>

          {changePrompt.kind === 'confirm' ? (
            <div className="mt-2 space-y-1 rounded-lg border border-line/55 bg-surface-2/55 px-2.5 py-2 text-[10px] leading-4 text-text-secondary">
              {changePrompt.summary.sensitiveCount > 0 && (
                <div className="flex items-start gap-1.5">
                  <ShieldCheck size={11} className="mt-0.5 shrink-0 text-warn" />
                  <span>Includes security-sensitive local configuration.</span>
                </div>
              )}
              {changePrompt.summary.externalEffectCount > 0 && (
                <div className="flex items-start gap-1.5">
                  <AlertTriangle size={11} className="mt-0.5 shrink-0 text-warn" />
                  <span>External messages and provider actions will remain untouched.</span>
                </div>
              )}
            </div>
          ) : (
            <div className="mt-2 max-h-36 space-y-1 overflow-y-auto rounded-lg border border-danger/20 bg-danger/5 px-2.5 py-2">
              {(changePrompt.conflicts ?? []).slice(0, 6).map((item, index) => (
                <div key={`${item.resourceKind}:${item.resourceId}:${index}`} className="text-[10px] leading-4 text-text-secondary">
                  <span className="font-medium text-text-primary">{item.label}</span>
                  {item.fields.length > 0 ? ` · ${item.fields.join(', ')}` : ''}
                </div>
              ))}
            </div>
          )}

          <div className="mt-2.5 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={onDismissTurnChange}
              className="h-7 rounded-md px-2.5 text-[11px] font-medium text-text-muted hover:bg-surface-2 hover:text-text-primary"
            >
              {changePrompt.kind === 'conflict' ? 'Close' : 'Cancel'}
            </button>
            {changePrompt.kind === 'confirm' && (
              <button
                type="button"
                onClick={() => onConfirmTurnChange?.(changePrompt.direction)}
                disabled={changeBusy}
                className="inline-flex h-7 items-center gap-1.5 rounded-md bg-text-primary px-2.5 text-[11px] font-semibold text-canvas transition hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
              >
                {changeBusy ? <Loader2 size={11} className="animate-spin" /> : changePrompt.direction === 'undo' ? <Undo2 size={11} /> : <Redo2 size={11} />}
                {changePrompt.direction === 'undo' ? 'Undo' : 'Redo'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}



