import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm';
import { AgentisError, type ChannelActionAuthorizationBasis, type ChannelActionIntentRecord, type ChannelActionStatus } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../../logger.js';
import type { ApprovalInboxService } from '../approvalInbox.js';
import type { ConnectionGrantService } from '../connectionGrants.js';
import type { OutboundPolicyService } from '../outboundPolicy.js';
import { isAcknowledgedChannelDelivery } from '../../adapters/channels/types.js';
import { resolveAndSend, type ChannelSendMessage, type ChannelSendResult } from './channelSend.js';
import type { ChannelBridge } from './channelBridge.js';
import type { ChannelInboxService } from './channelInboxService.js';

export interface CreateChannelActionInput {
  workspaceId: string;
  appId?: string | null;
  agentId: string;
  requesterIdentityId?: string | null;
  connectionId: string;
  recipientRef: string;
  conversationId?: string | null;
  subjectId?: string | null;
  goalRef?: string | null;
  goal: string;
  body?: string;
  messages?: ChannelSendMessage[];
  authorizationBasis: ChannelActionAuthorizationBasis;
  riskCategory?: string;
  scheduledFor?: string | null;
  requireApproval?: boolean;
  idempotencyKey?: string;
  userId?: string;
}

export class ChannelActionIntentService {
  constructor(private readonly deps: {
    db: AgentisSqliteDb;
    logger: Logger;
    channels: ChannelBridge;
    inbox: ChannelInboxService;
    grants: ConnectionGrantService;
    policy: OutboundPolicyService;
    approvals: ApprovalInboxService;
  }) {}

  async create(input: CreateChannelActionInput): Promise<ChannelActionIntentRecord> {
    const resolved = this.deps.inbox.resolve({ workspaceId: input.workspaceId, connectionId: input.connectionId, recipientRef: input.recipientRef });
    if (!resolved.resolved) throw new AgentisError('CHANNEL_TARGET_AMBIGUOUS_OR_MISSING', 'The channel recipient could not be resolved.', { details: { candidates: resolved.candidates } });
    const connection = this.deps.channels.get(input.workspaceId, input.connectionId);
    const authority = this.deps.grants.authorize({
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      agentId: input.agentId,
      ownerAgentId: connection.agentId,
      required: 'send',
    });
    if (!authority.ok) throw new AgentisError('CONNECTION_SCOPE_MISSING', authority.reason ?? 'The agent cannot send on this connection.');
    if (!input.goal.trim()) throw new AgentisError('VALIDATION_FAILED', 'A channel action requires a concrete goal.');
    if (!input.body?.trim() && !(input.messages?.length)) throw new AgentisError('VALIDATION_FAILED', 'A channel action requires a message body or message burst.');
    if (input.authorizationBasis !== 'verified_owner_command' && !input.goalRef && !input.subjectId) {
      throw new AgentisError('VALIDATION_FAILED', 'Autonomous outreach must reference a durable goal, relationship, or standing plan.');
    }

    const now = new Date().toISOString();
    const scheduledForLater = Boolean(input.scheduledFor && input.scheduledFor > now);
    let requireApproval = input.requireApproval === true;
    if (input.appId) {
      if (input.authorizationBasis !== 'verified_owner_command') {
        const autonomy = this.deps.policy.evaluateAutonomy(input.appId, 'proactive_followup', input.subjectId);
        if (autonomy.decision === 'deny') throw new AgentisError('AUTH_FORBIDDEN', autonomy.reason);
        if (autonomy.decision === 'require_approval') requireApproval = true;
      }
      const messageText = [input.body ?? '', ...(input.messages ?? []).map((message) => message.body ?? '')].join('\n');
      const contentPolicy = this.deps.policy.evaluate(input.appId, { body: messageText, source: 'agent' });
      if (!contentPolicy.allow && contentPolicy.needsApproval) requireApproval = true;
      if (!contentPolicy.allow && !contentPolicy.needsApproval && contentPolicy.reason?.startsWith('blocked claim')) {
        throw new AgentisError('AUTH_FORBIDDEN', contentPolicy.reason);
      }
      // Quiet hours and rate limits govern unsupervised outreach. A verified
      // owner saying “send now” is supervised and remains immediate.
      if (!contentPolicy.allow && !contentPolicy.needsApproval && input.authorizationBasis !== 'verified_owner_command' && !scheduledForLater) {
        throw new AgentisError('RESOURCE_CONFLICT', contentPolicy.reason ?? 'outbound policy blocked this action');
      }
    }

    const id = randomUUID();
    const status: ChannelActionStatus = requireApproval
      ? 'awaiting_approval'
      : input.scheduledFor && input.scheduledFor > now ? 'planned' : 'authorized';
    const row = {
      id,
      workspaceId: input.workspaceId,
      appId: input.appId ?? null,
      agentId: input.agentId,
      requesterIdentityId: input.requesterIdentityId ?? null,
      connectionId: input.connectionId,
      peerIdentityId: resolved.peer.peerIdentityId,
      conversationId: input.conversationId ?? resolved.peer.conversationId,
      subjectId: input.subjectId ?? resolved.peer.subjectId,
      goalRef: input.goalRef ?? null,
      goal: input.goal.trim(),
      body: input.body?.trim() ?? '',
      messagesJson: input.messages ?? [],
      authorizationBasis: input.authorizationBasis,
      riskCategory: input.riskCategory ?? 'ordinary',
      status,
      approvalId: null,
      idempotencyKey: input.idempotencyKey ?? `channel-action:${id}`,
      attempts: 0,
      scheduledFor: input.scheduledFor ?? null,
      providerReceiptJson: null,
      lastError: null,
      authorizedAt: status === 'authorized' ? now : null,
      executedAt: null,
      deliveredAt: null,
      cancelledAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.db.insert(schema.channelActionIntents).values(row).run();
    if (status === 'awaiting_approval') {
      const approval = await this.deps.approvals.create({
        workspaceId: input.workspaceId,
        ambientId: null,
        userId: input.userId ?? 'system',
        runId: null,
        taskId: null,
        gatewayId: null,
        source: 'outbound',
        title: `Approve message to ${resolved.peer.displayName ?? 'channel contact'}`,
        summary: `Goal: ${row.goal}. Message: "${row.body.slice(0, 280)}"`,
        confidence: null,
        payload: { workspaceId: input.workspaceId, channelActionIntentId: id },
      });
      this.deps.db.update(schema.channelActionIntents).set({ approvalId: approval.id, updatedAt: new Date().toISOString() })
        .where(eq(schema.channelActionIntents.id, id)).run();
    }
    return this.get(input.workspaceId, id)!;
  }

  async createAndExecute(input: CreateChannelActionInput): Promise<{ action: ChannelActionIntentRecord; result?: ChannelSendResult }> {
    const action = await this.create(input);
    if (action.status !== 'authorized') return { action };
    const result = await this.execute(input.workspaceId, action.id);
    return { action: this.get(input.workspaceId, action.id)!, result };
  }

  get(workspaceId: string, id: string): ChannelActionIntentRecord | null {
    const row = this.deps.db.select().from(schema.channelActionIntents).where(and(
      eq(schema.channelActionIntents.workspaceId, workspaceId), eq(schema.channelActionIntents.id, id),
    )).get();
    return row ? present(row) : null;
  }

  list(workspaceId: string, filters: { connectionId?: string; status?: ChannelActionStatus; limit?: number } = {}): ChannelActionIntentRecord[] {
    return this.deps.db.select().from(schema.channelActionIntents).where(and(
      eq(schema.channelActionIntents.workspaceId, workspaceId),
      ...(filters.connectionId ? [eq(schema.channelActionIntents.connectionId, filters.connectionId)] : []),
      ...(filters.status ? [eq(schema.channelActionIntents.status, filters.status)] : []),
    )).orderBy(desc(schema.channelActionIntents.createdAt)).limit(Math.max(1, Math.min(100, filters.limit ?? 30))).all().map(present);
  }

  async execute(workspaceId: string, id: string): Promise<ChannelSendResult> {
    const action = this.get(workspaceId, id);
    if (!action) throw new AgentisError('RESOURCE_NOT_FOUND', 'channel action not found');
    if (action.status === 'delivered' && action.providerReceipt) return resultFromReceipt(action);
    if (!['authorized', 'failed'].includes(action.status)) throw new AgentisError('RESOURCE_CONFLICT', `channel action is ${action.status}, not executable`);
    const connection = this.deps.channels.get(workspaceId, action.connectionId);
    const authority = action.agentId ? this.deps.grants.authorize({
      workspaceId, connectionId: action.connectionId, agentId: action.agentId, ownerAgentId: connection.agentId, required: 'send',
    }) : { ok: false, reason: 'channel action has no operating agent' };
    if (!authority.ok) throw new AgentisError('CONNECTION_SCOPE_MISSING', authority.reason ?? 'channel authority was revoked');
    if (action.appId && action.authorizationBasis !== 'verified_owner_command') {
      const messageText = [action.body, ...action.messages.map((message) => message.body ?? '')].join('\n');
      const policy = this.deps.policy.evaluate(action.appId, { body: messageText, source: 'agent' });
      if (!policy.allow) {
        // An explicit approval satisfies an approval-only content gate, but it
        // never overrides a hard blocked claim. Quiet hours and rate limits are
        // re-evaluated at delivery time and remain durable work, not lost work.
        const approvalSatisfied = policy.needsApproval && action.authorizationBasis === 'operator_approval';
        if (!approvalSatisfied) {
          const now = new Date().toISOString();
          if (policy.reason?.startsWith('quiet hours') || policy.reason?.startsWith('rate limit')) {
            const retryAt = new Date(Date.now() + 15 * 60_000).toISOString();
            this.deps.db.update(schema.channelActionIntents).set({
              status: 'planned', scheduledFor: retryAt, lastError: policy.reason, updatedAt: now,
            }).where(eq(schema.channelActionIntents.id, id)).run();
            throw new AgentisError('RESOURCE_CONFLICT', `${policy.reason}; action retained and will retry after ${retryAt}`);
          }
          this.deps.db.update(schema.channelActionIntents).set({
            status: 'failed', lastError: policy.reason ?? 'outbound policy denied delivery', updatedAt: now,
          }).where(eq(schema.channelActionIntents.id, id)).run();
          throw new AgentisError('AUTH_FORBIDDEN', policy.reason ?? 'outbound policy denied delivery');
        }
      }
    }
    const peer = this.deps.inbox.get(workspaceId, `peer:${action.peerIdentityId}`);
    if (!peer) throw new AgentisError('RESOURCE_NOT_FOUND', 'channel action recipient no longer exists');
    if (peer.handoffState === 'human' && action.authorizationBasis !== 'verified_owner_command') {
      throw new AgentisError('RESOURCE_CONFLICT', 'A human currently controls this customer conversation.');
    }
    const now = new Date().toISOString();
    const claim = this.deps.db.update(schema.channelActionIntents).set({
      status: 'executing', attempts: action.attempts + 1, executedAt: now, updatedAt: now, lastError: null,
    }).where(and(
      eq(schema.channelActionIntents.workspaceId, workspaceId),
      eq(schema.channelActionIntents.id, id),
      inArray(schema.channelActionIntents.status, ['authorized', 'failed']),
    )).run();
    if (claim.changes !== 1) {
      const current = this.get(workspaceId, id);
      if (current?.status === 'delivered' && current.providerReceipt) return resultFromReceipt(current);
      throw new AgentisError('RESOURCE_CONFLICT', `channel action is already ${current?.status ?? 'being executed'}`);
    }
    const to = this.deps.inbox.preferredAddress(action.peerIdentityId);
    let result: ChannelSendResult;
    try {
      result = await resolveAndSend({ channels: this.deps.channels, connectionGrants: this.deps.grants }, {
        workspaceId,
        connectionId: action.connectionId,
        agentId: action.agentId,
        to,
        body: action.body,
        messages: action.messages,
        idempotencyKey: action.idempotencyKey,
        conversationId: action.conversationId ?? undefined,
        persistOutboundContext: true,
        actor: 'automation',
      });
    } catch (error) {
      const failedAt = new Date().toISOString();
      this.deps.db.update(schema.channelActionIntents).set({
        status: 'failed', lastError: error instanceof Error ? error.message : String(error), updatedAt: failedAt,
      }).where(eq(schema.channelActionIntents.id, id)).run();
      throw error;
    }
    const finishedAt = new Date().toISOString();
    if (result.sent && isAcknowledgedChannelDelivery(result.receipt)) {
      this.deps.db.update(schema.channelActionIntents).set({
        status: 'delivered', providerReceiptJson: result.receipt, deliveredAt: finishedAt, updatedAt: finishedAt,
      }).where(eq(schema.channelActionIntents.id, id)).run();
      if (action.appId) this.deps.policy.record(action.appId, 'agent');
    } else {
      this.deps.db.update(schema.channelActionIntents).set({
        status: 'failed',
        providerReceiptJson: 'receipt' in result ? result.receipt ?? null : null,
        lastError: result.sent ? 'provider acknowledgement is pending' : result.error,
        updatedAt: finishedAt,
      }).where(eq(schema.channelActionIntents.id, id)).run();
    }
    return result;
  }

  async resolveApproval(approvalId: string, decision: 'approve' | 'reject', payload: Record<string, unknown>): Promise<boolean> {
    const id = typeof payload.channelActionIntentId === 'string' ? payload.channelActionIntentId : null;
    const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId : null;
    if (!id || !workspaceId) return false;
    const action = this.get(workspaceId, id);
    if (!action || action.approvalId !== approvalId || action.status !== 'awaiting_approval') return true;
    const now = new Date().toISOString();
    if (decision === 'reject') {
      this.deps.db.update(schema.channelActionIntents).set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
        .where(eq(schema.channelActionIntents.id, id)).run();
      return true;
    }
    this.deps.db.update(schema.channelActionIntents).set({
      status: 'authorized', authorizationBasis: 'operator_approval', authorizedAt: now, updatedAt: now,
    }).where(eq(schema.channelActionIntents.id, id)).run();
    await this.execute(workspaceId, id);
    return true;
  }

  /** Resolve the one newest approval-held action for this verified requester. */
  async confirmLatestForRequester(workspaceId: string, requesterIdentityId: string, decision: 'approve' | 'reject', userId: string): Promise<ChannelActionIntentRecord | null> {
    const row = this.deps.db.select().from(schema.channelActionIntents).where(and(
      eq(schema.channelActionIntents.workspaceId, workspaceId),
      eq(schema.channelActionIntents.requesterIdentityId, requesterIdentityId),
      eq(schema.channelActionIntents.status, 'awaiting_approval'),
    )).orderBy(desc(schema.channelActionIntents.createdAt)).get();
    if (!row?.approvalId) return null;
    await this.deps.approvals.resolve({
      workspaceId,
      approvalId: row.approvalId,
      decision,
      resolvedByUserId: userId,
      reason: 'Confirmed from the verified owner channel conversation.',
    });
    return this.get(workspaceId, row.id);
  }

  cancel(workspaceId: string, id: string, reason = 'cancelled'): ChannelActionIntentRecord {
    const action = this.get(workspaceId, id);
    if (!action) throw new AgentisError('RESOURCE_NOT_FOUND', 'channel action not found');
    if (['delivered', 'cancelled', 'superseded'].includes(action.status)) return action;
    const now = new Date().toISOString();
    this.deps.db.update(schema.channelActionIntents).set({ status: 'cancelled', cancelledAt: now, lastError: reason, updatedAt: now })
      .where(eq(schema.channelActionIntents.id, id)).run();
    return this.get(workspaceId, id)!;
  }

  cancelForPeer(workspaceId: string, peerIdentityId: string, reason: string): number {
    const active = this.deps.db.select({ id: schema.channelActionIntents.id }).from(schema.channelActionIntents).where(and(
      eq(schema.channelActionIntents.workspaceId, workspaceId),
      eq(schema.channelActionIntents.peerIdentityId, peerIdentityId),
      inArray(schema.channelActionIntents.status, ['planned', 'awaiting_approval', 'authorized', 'failed']),
    )).all();
    for (const row of active) this.cancel(workspaceId, row.id, reason);
    return active.length;
  }

  async sweep(now = new Date().toISOString(), limit = 25): Promise<number> {
    const due = this.deps.db.select().from(schema.channelActionIntents).where(and(
      eq(schema.channelActionIntents.status, 'planned'), lte(schema.channelActionIntents.scheduledFor, now),
    )).orderBy(asc(schema.channelActionIntents.scheduledFor)).limit(limit).all();
    let executed = 0;
    for (const row of due) {
      this.deps.db.update(schema.channelActionIntents).set({ status: 'authorized', authorizedAt: now, updatedAt: now })
        .where(eq(schema.channelActionIntents.id, row.id)).run();
      try { await this.execute(row.workspaceId, row.id); executed += 1; }
      catch (err) { this.deps.logger.warn('channel.action.sweep_failed', { actionId: row.id, err: (err as Error).message }); }
    }
    return executed;
  }
}

function present(row: typeof schema.channelActionIntents.$inferSelect): ChannelActionIntentRecord {
  const { messagesJson, providerReceiptJson, ...record } = row;
  return {
    ...record,
    messages: Array.isArray(messagesJson) ? messagesJson as Array<{ body?: string }> : [],
    providerReceipt: providerReceiptJson,
    authorizationBasis: row.authorizationBasis as ChannelActionAuthorizationBasis,
    status: row.status as ChannelActionStatus,
  };
}

function resultFromReceipt(action: ChannelActionIntentRecord): ChannelSendResult {
  const receipt = action.providerReceipt as { provider?: string; providerMessageId?: string; status?: string; acceptedAt?: string; recipient?: string };
  return {
    sent: true,
    verified: true,
    connectionId: action.connectionId,
    kind: receipt.provider ?? 'channel',
    to: receipt.recipient ?? '',
    targetSource: 'channel_action_intent',
    status: 'delivered',
    attachments: 0,
    messages: Math.max(1, action.messages.length),
    providerMessageId: receipt.providerMessageId ?? action.idempotencyKey,
    deliveryStatus: receipt.status === 'delivered' || receipt.status === 'read'
      ? receipt.status
      : 'accepted',
    acceptedAt: receipt.acceptedAt ?? action.deliveredAt ?? action.updatedAt,
    receipt: receipt as never,
    deliveryRole: 'unspecified',
  };
}
