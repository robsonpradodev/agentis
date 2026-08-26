import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { ConnectionGrantService } from '../../src/services/connectionGrants.js';
import { OutboundPolicyService } from '../../src/services/outboundPolicy.js';
import { ChannelActionIntentService } from '../../src/services/conversation/channelActionIntentService.js';
import { ChannelBridge, type PersistentChannelTransport } from '../../src/services/conversation/channelBridge.js';
import { ChannelIdentityService } from '../../src/services/conversation/channelIdentityService.js';
import { ChannelInboxService } from '../../src/services/conversation/channelInboxService.js';
import { ConversationStore } from '../../src/services/conversation/conversationStore.js';

describe('channel autonomy end to end', () => {
  let ctx: TestContext;
  let identities: ChannelIdentityService;
  let inbox: ChannelInboxService;
  let actions: ChannelActionIntentService;
  let bridge: ChannelBridge;
  let conversations: ConversationStore;
  let approvals: ApprovalInboxService;
  let agentId: string;
  const sent: Array<{ connectionId: string; chatId: string; body: string }> = [];

  beforeEach(async () => {
    ctx = await createTestContext();
    sent.length = 0;
    agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Bia',
      adapterType: 'http',
    }).run();
    identities = new ChannelIdentityService({ db: ctx.db, logger: ctx.logger });
    conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    bridge = new ChannelBridge({
      db: ctx.db,
      vault: ctx.vault,
      conversations,
      bus: ctx.bus,
      logger: ctx.logger,
      identity: identities,
    });
    const transport: PersistentChannelTransport = {
      handles: (connection) => connection.kind === 'whatsapp',
      requiresNoToken: (kind) => kind === 'whatsapp',
      status: () => ({ status: 'open' }),
      send: async (connectionId, chatId, body) => {
        sent.push({ connectionId, chatId, body });
        return {
          provider: 'whatsapp',
          providerMessageId: `wa-${sent.length}`,
          status: 'accepted',
          acceptedAt: new Date().toISOString(),
          recipient: chatId,
          providerAcknowledged: true,
        } as const;
      },
    };
    bridge.setPersistentTransport(transport);
    inbox = new ChannelInboxService({ db: ctx.db, identities });
    approvals = new ApprovalInboxService(ctx.db, ctx.bus);
    actions = new ChannelActionIntentService({
      db: ctx.db,
      logger: ctx.logger,
      channels: bridge,
      inbox,
      grants: new ConnectionGrantService(ctx.db),
      policy: new OutboundPolicyService({ db: ctx.db, logger: ctx.logger }),
      approvals,
    });
    approvals.bindOutboundHandler(async ({ approvalId, decision, payload }) => {
      await actions.resolveApproval(approvalId, decision, payload);
    });
  });

  afterEach(() => ctx.close());

  it('resolves “last inbound”, preserves PN/LID identity, and delivers exactly once without a raw address', async () => {
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'whatsapp',
      name: 'Bia WhatsApp',
      ownerChatId: '+55 31 7144-3148',
      ownerName: 'Robson',
    });
    const contact = identities.observeAliases({
      workspaceId: ctx.workspace.id,
      connectionId: connection.id,
      channelKind: 'whatsapp',
      primaryHandle: '553199887766@s.whatsapp.net',
      aliases: ['88331122@lid', '+55 31 99887-766'],
      displayName: 'atacadaosertaneja',
      source: 'provider',
      verified: true,
      countMessage: true,
    });
    const conversation = conversations.getOrCreateByChannel({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      channelConnectionId: connection.id,
      channelChatId: '88331122@lid',
      channelPeerIdentityId: contact.id,
    });
    conversations.appendReconciledChannelMessage({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      sessionMessageId: 'customer-last-inbound',
      body: 'Boa tarde',
      participantSide: 'customer',
      occurredAt: new Date().toISOString(),
    });

    const resolved = inbox.resolve({
      workspaceId: ctx.workspace.id,
      connectionId: connection.id,
      selector: 'last_inbound',
    });
    expect(resolved.resolved).toBe(true);
    if (!resolved.resolved) throw new Error('fixture did not resolve');
    expect(resolved.peer).toMatchObject({
      displayName: 'atacadaosertaneja',
      conversationId: conversation.id,
      peerIdentityId: contact.id,
    });
    expect(resolved.peer.aliases).toHaveLength(3);

    const outcome = await actions.createAndExecute({
      workspaceId: ctx.workspace.id,
      agentId,
      requesterIdentityId: identities.resolve(ctx.workspace.id, 'whatsapp', '+55 31 7144-3148', connection.id)?.id,
      connectionId: connection.id,
      recipientRef: resolved.peer.recipientRef,
      conversationId: resolved.peer.conversationId,
      goal: 'Explain how Talki AI can help the contact grow its business.',
      body: 'Nossa IA pode automatizar atendimento, qualificação e follow-up sem perder o contexto do seu negócio.',
      authorizationBasis: 'verified_owner_command',
      userId: ctx.user.id,
    });

    expect(outcome.action.status).toBe('delivered');
    expect(sent).toEqual([{
      connectionId: connection.id,
      chatId: '553199887766@s.whatsapp.net',
      body: 'Nossa IA pode automatizar atendimento, qualificação e follow-up sem perder o contexto do seu negócio.',
    }]);
    await actions.execute(ctx.workspace.id, outcome.action.id);
    expect(sent).toHaveLength(1);
    expect(inbox.history(ctx.workspace.id, resolved.peer.recipientRef).map((message) => message.body))
      .toEqual(expect.arrayContaining(['Boa tarde', 'Nossa IA pode automatizar atendimento, qualificação e follow-up sem perder o contexto do seu negócio.']));
  });

  it('persists approval-held work and executes the exact action after operator approval', async () => {
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'whatsapp',
      name: 'Bia WhatsApp',
    });
    const contact = identities.observeAliases({
      workspaceId: ctx.workspace.id,
      connectionId: connection.id,
      channelKind: 'whatsapp',
      primaryHandle: '553188887777@s.whatsapp.net',
      displayName: 'Lead',
      source: 'provider',
      countMessage: false,
    });
    const created = await actions.createAndExecute({
      workspaceId: ctx.workspace.id,
      agentId,
      connectionId: connection.id,
      recipientRef: `peer:${contact.id}`,
      goalRef: 'campaign:qualified-leads',
      goal: 'Continue the qualified lead conversation.',
      body: 'Posso te mostrar um exemplo aplicado ao seu atendimento?',
      authorizationBasis: 'standing_goal',
      requireApproval: true,
      userId: ctx.user.id,
    });
    expect(created.action).toMatchObject({ status: 'awaiting_approval', attempts: 0 });
    expect(sent).toHaveLength(0);
    const approval = approvals.list(ctx.workspace.id).find((item) => item.id === created.action.approvalId)!;

    await approvals.resolve({
      workspaceId: ctx.workspace.id,
      approvalId: approval.id,
      decision: 'approve',
      resolvedByUserId: ctx.user.id,
    });

    expect(actions.get(ctx.workspace.id, created.action.id)).toMatchObject({
      status: 'delivered', authorizationBasis: 'operator_approval', attempts: 1,
    });
    expect(sent).toHaveLength(1);
  });

  it('claims an authorized action atomically so concurrent workers cannot duplicate delivery', async () => {
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'whatsapp',
      name: 'Bia WhatsApp',
    });
    const contact = identities.observeAliases({
      workspaceId: ctx.workspace.id,
      connectionId: connection.id,
      channelKind: 'whatsapp',
      primaryHandle: '553177776666@s.whatsapp.net',
      displayName: 'Atomic lead',
      source: 'provider',
      countMessage: false,
    });
    const action = await actions.create({
      workspaceId: ctx.workspace.id,
      agentId,
      connectionId: connection.id,
      recipientRef: `peer:${contact.id}`,
      goal: 'Send one owner-requested update.',
      body: 'Uma única mensagem.',
      authorizationBasis: 'verified_owner_command',
      userId: ctx.user.id,
    });

    const attempts = await Promise.allSettled([
      actions.execute(ctx.workspace.id, action.id),
      actions.execute(ctx.workspace.id, action.id),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(actions.get(ctx.workspace.id, action.id)?.status).toBe('delivered');
  });
});
