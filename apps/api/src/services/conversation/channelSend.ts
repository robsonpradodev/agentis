import type { ChannelQuote } from '../../adapters/channels/types.js';
/**
 * channelSend — the single resolve-authorize-deliver flow for sending a message
 * on a native channel connection.
 *
 * Extracted so BOTH the `agentis.channel.send` agent tool AND the deterministic
 * `channel` workflow node share one implementation: resolve the connection (by
 * explicit id, or by kind when there's exactly one active authorized one),
 * enforce per-agent §3.3 authority, resolve the destination chat, deliver, and
 * return a structured receipt. A workflow node was previously impossible — the
 * only send path was the agent tool — so "deterministic first contact" workflows
 * could compute a message but never actually send it.
 */
import type { ChannelBridge } from './channelBridge.js';
import type { ConnectionGrantService } from '../connectionGrants.js';
import { ChannelDeliveryRejectedError, ChannelDeliveryUncertainError, isAcknowledgedChannelDelivery, type ChannelDeliveryReceipt, type ChannelKind, type OutboundAttachmentRef, type OutboundNativeContent } from '../../adapters/channels/types.js';

const CHANNEL_KINDS = new Set<ChannelKind>(['telegram', 'discord', 'slack', 'whatsapp', 'voice']);

/** One message in a burst — its own body and/or attachments. */
export interface ChannelSendMessage {
  id?: string;
  requirementId?: string;
  body?: string;
  attachments?: OutboundAttachmentRef[];
  native?: OutboundNativeContent;
  quotedMessage?: ChannelQuote;
}

export interface ChannelSendItemReceipt {
  itemId: string;
  requirementId: string | null;
  idempotencyKey: string;
  providerMessageId: string;
  providerStatus: string;
  acknowledged: boolean;
  observedAt: string;
  receipt: ChannelDeliveryReceipt;
}

/** One audited owner-directed effect may cross an existing human handoff. */
export interface ChannelHandoffOverride {
  basis: 'verified_owner_command';
  effectIntentId: string;
}

export interface ChannelSendArgs {
  workspaceId: string;
  body: string;
  /** Resolve by kind (e.g. "whatsapp") when connectionId is omitted. */
  kind?: string | null;
  /** Pin an exact connection. */
  connectionId?: string | null;
  /** Destination ("default"/"me" → the saved default target; else a phone/JID/alias). */
  to?: string | null;
  /** Calling agent — gates §3.3 authority. Null/undefined is a workspace caller. */
  agentId?: string | null;
  /** Lifecycle semantics for conversational callers; transport behavior is unchanged. */
  deliveryRole?: 'progress' | 'final';
  attachments?: OutboundAttachmentRef[];
  /** A provider-native location, contact card, or poll. */
  native?: OutboundNativeContent;
  quotedMessage?: ChannelQuote;
  /**
   * Send a natural BURST of messages in order to the same destination (§3). When
   * present, `body`/`attachments` are ignored. Each message is delivered as its
   * own provider message with a derived idempotency sub-key.
   */
  messages?: ChannelSendMessage[];
  /** Stable run+node key for durable at-most-once workflow delivery. */
  idempotencyKey?: string;
  /** Bypass §7 anti-ban rails (rate/warmup/opt-in). Operator-initiated sends only. */
  bypassGuards?: boolean;
  actor?: 'automation' | 'human';
  conversationId?: string;
  expectedAutomationEpoch?: number;
  /** Does not release handoff or authorize any later autonomous delivery. */
  handoffOverride?: ChannelHandoffOverride;
  /**
   * Persist this programmatic delivery as business-side transcript context.
   * Used by deterministic workflows so a later inbound reply continues the
   * same conversation instead of looking like a brand-new chat.
   */
  persistOutboundContext?: boolean;
}

export type ChannelSendResult =
  | { sent: true; verified: true; connectionId: string; kind: string; to: string; targetSource: string; status: string; attachments: number; messages: number; providerMessageId: string; providerMessageIds?: string[]; itemReceipts: ChannelSendItemReceipt[]; deliveryStatus: ChannelDeliveryReceipt['status']; acceptedAt: string; receipt: ChannelDeliveryReceipt; deliveryRole: 'progress' | 'final' | 'unspecified' }
  | { sent: false; verified?: false; errorCode: string; error: string; deliveryOutcome?: 'pending' | 'failed'; idempotencyKey?: string; remediation?: string; candidates?: unknown[]; connection?: unknown; receipt?: ChannelDeliveryReceipt; itemReceipts?: ChannelSendItemReceipt[] };

/** Flatten the request into an ordered list of messages to deliver. */
function normalizeDeliveries(args: ChannelSendArgs): Array<{ id: string; requirementId: string | null; body: string; attachments: OutboundAttachmentRef[]; native?: OutboundNativeContent; quotedMessage?: ChannelQuote }> {
  if (Array.isArray(args.messages) && args.messages.length > 0) {
    return args.messages
      .map((m, index) => ({
        id: m.id?.trim() || `message-${index + 1}`,
        requirementId: m.requirementId?.trim() || null,
        body: typeof m.body === 'string' ? m.body.trim() : '',
        attachments: Array.isArray(m.attachments) ? m.attachments : [],
        ...(m.quotedMessage ? { quotedMessage: m.quotedMessage } : {}),
        ...(m.native ? { native: m.native } : {}),
      }))
      .filter((d) => d.body || d.attachments.length > 0 || d.native);
  }
  const body = typeof args.body === 'string' ? args.body.trim() : '';
  const attachments = args.attachments ?? [];
  return body || attachments.length > 0 || args.native
    ? [{ id: 'message-1', requirementId: null, body, attachments, ...(args.quotedMessage ? {quotedMessage: args.quotedMessage} : {}), ...(args.native ? { native: args.native } : {}) }]
    : [];
}

/** What the flow needs from the bridge — structural so tests can fake it. */
export interface ChannelSendDeps {
  channels: Pick<ChannelBridge, 'list' | 'resolveDestination' | 'deliverToConnection' | 'defaultConnectionFor'>;
  connectionGrants?: Pick<ConnectionGrantService, 'authorize'>;
}

function isMe(value: string): boolean {
  return /^(me|default)$/i.test(value.trim());
}

function resolveCandidate(
  connections: ReturnType<ChannelBridge['list']>,
  kind: ChannelKind | null,
  to: string,
) {
  const active = connections.filter((c) => c.status === 'active' && (!kind || c.kind === kind));
  if (to && !isMe(to)) return active.length === 1 ? active[0] : null;
  const withDefault = active.filter((c) => Boolean(c.defaultChatId));
  return withDefault.length === 1 ? withDefault[0] : null;
}

/** Resolve → authorize → deliver. Never throws for an expected failure — returns
 *  a `{ sent:false, errorCode }` the caller (tool or node) can surface. */
export async function resolveAndSend(deps: ChannelSendDeps, args: ChannelSendArgs): Promise<ChannelSendResult> {
  const deliveries = normalizeDeliveries(args);
  if (deliveries.length === 0) {
    return { sent: false, errorCode: 'VALIDATION_FAILED', error: 'provide a body, attachment, native payload, or a non-empty messages[] burst' };
  }
  const kind = typeof args.kind === 'string' && CHANNEL_KINDS.has(args.kind as ChannelKind) ? (args.kind as ChannelKind) : null;
  const connectionId = typeof args.connectionId === 'string' && args.connectionId.trim() ? args.connectionId.trim() : null;
  const requestedTo = typeof args.to === 'string' ? args.to.trim() : '';

  const connections = deps.channels.list(args.workspaceId);
  const isAuthorized = (connection: (typeof connections)[number]): boolean => {
    // A workspace caller has no agent authority to borrow an agent-owned
    // transport. This closes the legacy deterministic-workflow fallback that
    // could select another agent's default number when a workflow had no owner.
    if (!args.agentId) return connection.agentId == null;
    if (deps.connectionGrants) {
      return deps.connectionGrants.authorize({
        workspaceId: args.workspaceId,
        connectionId: connection.id,
        agentId: args.agentId,
        ownerAgentId: connection.agentId ?? null,
        required: 'send',
      }).ok;
    }
    // A caller without an authority service still cannot silently select a
    // connection belonging to a different agent. Workspace connections remain
    // available for compatibility; cross-agent use requires an explicit grant
    // once the authority service is wired.
    return connection.agentId == null || connection.agentId === args.agentId;
  };
  const eligibleConnections = connections.filter(isAuthorized);
  // Resolution order: explicit connectionId → the workspace DEFAULT connection of
  // the kind (or the sole active one) → for a kindless call, the single active
  // one. This is what makes a deterministic send unambiguous when several
  // connections of a kind exist (e.g. two WhatsApp numbers) — the operator
  // designates one default and automation uses it.
  let candidate: (typeof connections)[number] | undefined;
  if (connectionId) {
    candidate = connections.find((c) => c.id === connectionId);
  } else if (kind) {
    const defaultId = deps.channels.defaultConnectionFor(args.workspaceId, kind);
    const defaultCandidate = defaultId ? connections.find((c) => c.id === defaultId) : undefined;
    if (defaultCandidate && isAuthorized(defaultCandidate)) {
      candidate = defaultCandidate;
    } else {
      const activeEligible = eligibleConnections.filter((c) => c.status === 'active' && c.kind === kind);
      candidate = activeEligible.length === 1
        ? activeEligible[0]
        : activeEligible.find((c) => c.isDefault) ?? defaultCandidate;
    }
  } else {
    candidate = resolveCandidate(eligibleConnections, null, requestedTo) ?? undefined;
  }
  if (!candidate) {
    const ofKind = connections.filter((c) => !kind || c.kind === kind);
    const candidates = ofKind.map((c) => ({ id: c.id, kind: c.kind, name: c.name, status: c.status, defaultChatId: c.defaultChatId, targetAliases: c.targetAliases, isDefault: c.isDefault, healthStatus: c.health.status }));
    const activeOfKind = ofKind.filter((c) => c.status === 'active');
    return {
      sent: false,
      errorCode: 'CHANNEL_TARGET_AMBIGUOUS_OR_MISSING',
      error: !kind
        ? 'No single active channel matched. Provide connectionId or kind, and a destination.'
        : activeOfKind.length === 0
          ? `No active ${kind} connection. Connect one in Settings → Channels.`
          : `${activeOfKind.length} active ${kind} connections and no default is set — pass an explicit connectionId, or mark one as the default for ${kind} (Settings → Channels) so deterministic sends resolve.`,
      candidates,
    };
  }

  // §3.3 — an AGENT may only send on a connection it OWNS or was granted.
  // Deterministic/system callers (no agentId) always pass. A workspace-owned
  // connection (candidate.agentId null) has no owner, but ConnectionGrantService
  // already treats "no governing grants" as open — so consulting it here is safe
  // for BOTH owned and workspace connections, and lets an operator restrict a
  // shared/global connection to specific agents by issuing grants on it.
  if (!args.agentId && candidate.agentId) {
    return {
      sent: false,
      errorCode: 'CONNECTION_SCOPE_MISSING',
      error: `workspace caller cannot send on agent-owned connection '${candidate.name}'`,
      remediation: `Assign this workflow to the owning agent, bind it to an App with that owner, or use a workspace-owned connection.`,
      connection: { id: candidate.id, kind: candidate.kind, name: candidate.name },
    };
  }
  if (args.agentId && !deps.connectionGrants && candidate.agentId && candidate.agentId !== args.agentId) {
    return {
      sent: false,
      errorCode: 'CONNECTION_SCOPE_MISSING',
      error: `agent ${args.agentId} lacks authority on connection '${candidate.name}'`,
      remediation: `Use the agent's own connection or configure an explicit connection grant for '${candidate.name}'.`,
      connection: { id: candidate.id, kind: candidate.kind, name: candidate.name },
    };
  }
  if (args.agentId && deps.connectionGrants) {
    const decision = deps.connectionGrants.authorize({
      workspaceId: args.workspaceId,
      connectionId: candidate.id,
      agentId: args.agentId,
      ownerAgentId: candidate.agentId ?? null,
      required: 'send',
    });
    if (!decision.ok) {
      return {
        sent: false,
        errorCode: 'CONNECTION_SCOPE_MISSING',
        error: decision.reason ?? `not authorized to send on '${candidate.name}'`,
        remediation: `Not authorized to send on '${candidate.name}'. Request it with agentis.connection.request { connectionId: "${candidate.id}", scope: "send" } — an operator approves it.`,
        connection: { id: candidate.id, kind: candidate.kind, name: candidate.name },
      };
    }
  }

  const resolved = deps.channels.resolveDestination({ connectionId: candidate.id, to: requestedTo || null });
  const chatId = resolved.chatId;
  if (!chatId) {
    return {
      sent: false,
      errorCode: 'CHANNEL_DEFAULT_TARGET_MISSING',
      error: `${candidate.kind} connection '${candidate.name}' has no destination — pass a recipient in "to" or save a default target.`,
      connection: { id: candidate.id, kind: candidate.kind, status: candidate.status },
    };
  }

  const receipts: ChannelDeliveryReceipt[] = [];
  const itemReceipts: ChannelSendItemReceipt[] = [];
  let totalAttachments = 0;
  for (let i = 0; i < deliveries.length; i += 1) {
    const d = deliveries[i]!;
    totalAttachments += d.attachments.length;
    // A burst derives a per-message idempotency sub-key so a retry re-sends only
    // the message that failed, never the ones already accepted.
    const idempotencyKey = args.idempotencyKey
      ? (deliveries.length > 1 ? `${args.idempotencyKey}#${encodeURIComponent(d.id)}` : args.idempotencyKey)
      : undefined;
    let receipt: ChannelDeliveryReceipt;
    try {
      receipt = await deps.channels.deliverToConnection({
        connectionId: candidate.id,
        chatId,
        body: d.body,
        ...(d.attachments.length ? { attachments: d.attachments } : {}),
        ...(d.quotedMessage ? { quotedMessage: d.quotedMessage } : {}),
        ...(d.native ? { native: d.native } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(args.bypassGuards ? { bypassGuards: true } : {}),
        ...(args.actor ? { actor: args.actor } : {}),
        ...(args.conversationId ? { conversationId: args.conversationId } : {}),
        ...(args.expectedAutomationEpoch !== undefined ? { expectedAutomationEpoch: args.expectedAutomationEpoch } : {}),
        ...(args.handoffOverride ? { handoffOverride: args.handoffOverride } : {}),
        ...(args.persistOutboundContext ? { persistOutboundContext: true } : {}),
      });
    } catch (err) {
      if (err instanceof ChannelDeliveryRejectedError) {
        return {
          sent: false,
          verified: false,
          errorCode: 'CHANNEL_PROVIDER_REJECTED',
          error: err.message,
          deliveryOutcome: 'failed',
          ...(err.remediation ? { remediation: err.remediation } : {}),
          connection: {
            id: candidate.id,
            kind: candidate.kind,
            name: candidate.name,
            providerMessageId: err.providerMessageId,
            providerErrorCode: err.providerErrorCode,
          },
          itemReceipts,
        };
      }
      const error = err instanceof Error ? err.message : String(err);
      const errorCode = err instanceof ChannelDeliveryUncertainError
        ? err.code
        : typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
        ? err.code
        : 'CHANNEL_SEND_FAILED';
      return {
        sent: false,
        verified: false,
        errorCode,
        error,
        ...(err instanceof ChannelDeliveryUncertainError ? {
          deliveryOutcome: 'pending' as const,
          ...(err.idempotencyKey ? { idempotencyKey: err.idempotencyKey } : {}),
        } : {}),
        itemReceipts,
        connection: { id: candidate.id, kind: candidate.kind, name: candidate.name },
      };
    }
    const providerMessageId = receipt?.providerMessageId?.trim() ?? '';
    if (!providerMessageId) {
      return {
        sent: false,
        verified: false,
        errorCode: 'CHANNEL_DELIVERY_UNVERIFIED',
        error: `${candidate.kind} transport returned without provider-issued message proof. The delivery outcome is unknown and must not advance downstream state.`,
        remediation: 'Inspect the channel/provider before retrying; an unverified attempt may still have reached the recipient.',
        connection: { id: candidate.id, kind: candidate.kind, name: candidate.name },
        ...(receipt ? { receipt } : {}),
        itemReceipts,
      };
    }
    if (!isAcknowledgedChannelDelivery(receipt)) {
      return {
        sent: false,
        verified: false,
        errorCode: 'CHANNEL_DELIVERY_PENDING',
        error: `${candidate.kind} accepted the local submission but has not provided server acknowledgement. Downstream state was not advanced.`,
        remediation: 'Wait for a provider acknowledgement and inspect the durable delivery receipt before retrying. Do not resend blindly: the original attempt may still be accepted later.',
        connection: { id: candidate.id, kind: candidate.kind, name: candidate.name },
        receipt,
        itemReceipts,
      };
    }
    receipts.push(receipt);
    itemReceipts.push({
      itemId: d.id,
      requirementId: d.requirementId,
      idempotencyKey: idempotencyKey ?? `unkeyed:${d.id}:${receipt.providerMessageId}`,
      providerMessageId,
      providerStatus: receipt.status,
      acknowledged: true,
      observedAt: new Date().toISOString(),
      receipt,
    });
  }

  const primary = receipts[0]!;
  const providerMessageIds = receipts.flatMap((r) => r.providerMessageIds ?? [r.providerMessageId]);
  return {
    sent: true,
    verified: true,
    connectionId: candidate.id,
    kind: candidate.kind,
    to: primary.recipient ?? chatId,
    targetSource: resolved.source,
    status: candidate.status,
    attachments: totalAttachments,
    messages: receipts.length,
    providerMessageId: primary.providerMessageId,
    ...(providerMessageIds.length > 1 ? { providerMessageIds } : {}),
    deliveryStatus: primary.status,
    acceptedAt: primary.acceptedAt,
    receipt: primary,
    itemReceipts,
    deliveryRole: args.deliveryRole ?? 'unspecified',
  };
}

/** The port the workflow engine consumes for the `channel` node. */
export interface ChannelSendPort {
  send(args: ChannelSendArgs): Promise<ChannelSendResult>;
}

export function createChannelSendPort(deps: ChannelSendDeps): ChannelSendPort {
  return { send: (args) => resolveAndSend(deps, args) };
}
