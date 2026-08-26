import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { REALTIME_EVENTS } from '@agentis/core';
import { ChannelConnectionSupervisor, reconcileTransportHealth } from '../../src/services/conversation/channelConnectionSupervisor.js';
import { ConversationStore } from '../../src/services/conversation/conversationStore.js';
import { ConversationHandoffService } from '../../src/services/conversation/conversationHandoffService.js';
import { ChannelIdentityService } from '../../src/services/conversation/channelIdentityService.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function fixture() {
  const agentId = randomUUID();
  const connectionId = randomUUID();
  ctx.db.insert(schema.agents).values({
    id: agentId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    name: 'Orchestrator',
    role: 'orchestrator',
    adapterType: 'http',
  }).run();
  ctx.db.insert(schema.channelConnections).values({
    id: connectionId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    agentId,
    kind: 'whatsapp',
    name: 'Observed WhatsApp',
    tokenEncrypted: ctx.vault.encrypt('persistent:whatsapp'),
    status: 'active',
    settings: { mode: 'qr_local' },
  }).run();
  const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
  const handoffs = new ConversationHandoffService({ db: ctx.db, bus: ctx.bus });
  const supervisor = new ChannelConnectionSupervisor({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    vault: ctx.vault,
    conversations,
    dataDir: '.',
    handoffs,
  });
  return { agentId, connectionId, supervisor, handoffs };
}

describe('ChannelConnectionSupervisor observed outbound synchronization', () => {
  it('keeps an open persistent channel healthy while optional diagnostics are still unverified', () => {
    const health = reconcileTransportHealth({
      status: 'needs_action',
      checks: ['credential', 'transport', 'outbound', 'inbound', 'runtime'].map((name) => ({
        name: name as 'credential' | 'transport' | 'outbound' | 'inbound' | 'runtime',
        ok: false,
        code: 'not_checked',
        message: `${name} has not been checked yet.`,
        checkedAt: new Date().toISOString(),
      })),
    }, 'active', 'open', new Date().toISOString());

    expect(health.status).toBe('active');
    expect(health.checks.find((check) => check.name === 'transport')).toMatchObject({
      ok: true, code: 'persistent_transport_open',
    });
    expect(health.checks.filter((check) => check.code === 'not_checked')).toHaveLength(4);
  });

  it('prepares optional STT when a media channel is configured, not at global API bootstrap', async () => {
    const prepareInboundAudio = vi.fn(async () => {});
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const supervisor = new ChannelConnectionSupervisor({
      db: ctx.db,
      bus: ctx.bus,
      logger: ctx.logger,
      vault: ctx.vault,
      conversations,
      dataDir: '.',
      prepareInboundAudio,
    });

    supervisor.onCreated({ id: 'wa-new', kind: 'whatsapp', settings: { mode: 'qr_local' } });
    await vi.waitFor(() => expect(prepareInboundAudio).toHaveBeenCalledOnce());
  });

  it('mirrors a primary-phone send once and publishes provider-backed outbound evidence', () => {
    const { connectionId, supervisor, handoffs } = fixture();
    const capture = ctx.captureBus();

    supervisor.observeOutbound(connectionId, {
      externalId: 'PHONE-MESSAGE-1',
      chatId: '5521970398568@s.whatsapp.net',
      body: 'Oi, boa tarde',
    });
    supervisor.observeOutbound(connectionId, {
      externalId: 'PHONE-MESSAGE-1',
      chatId: '5521970398568@s.whatsapp.net',
      body: 'Oi, boa tarde',
    });

    const messages = ctx.db.select().from(schema.conversationMessages).all();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      authorType: 'operator',
      sessionMessageId: 'PHONE-MESSAGE-1',
      body: 'Oi, boa tarde',
      deliveryStatus: 'sent',
      metadata: expect.objectContaining({
        channelOutboundObserved: true,
        source: 'external_whatsapp_client',
      }),
    });
    const conversationId = messages[0]!.conversationId;
    expect(handoffs.current(ctx.workspace.id, conversationId)).toMatchObject({
      state: 'human', source: 'provider_observed', automationEpoch: 1,
    });
    expect(capture.events.some((event) => event.envelope.event === REALTIME_EVENTS.CHANNEL_MESSAGE_SENT
      && (event.envelope.payload as { observed?: boolean }).observed === true)).toBe(true);
    capture.stop();
  });

  it('does not mirror an echo whose provider id belongs to an Agentis send', () => {
    const { connectionId, supervisor } = fixture();
    ctx.db.insert(schema.channelOutboundDeliveries).values({
      id: randomUUID(),
      workspaceId: ctx.workspace.id,
      connectionId,
      idempotencyKey: 'workflow:run:node',
      chatId: '5521970398568@s.whatsapp.net',
      bodyHash: 'hash',
      status: 'accepted',
      providerMessageId: 'AGENTIS-MESSAGE-1',
    }).run();

    supervisor.observeOutbound(connectionId, {
      externalId: 'AGENTIS-MESSAGE-1',
      chatId: '5521970398568@s.whatsapp.net',
      body: 'Agentis echo',
    });

    expect(ctx.db.select().from(schema.conversationMessages).all()).toHaveLength(0);
    expect(ctx.db.select().from(schema.channelDeliveries)
      .where(eq(schema.channelDeliveries.externalId, 'AGENTIS-MESSAGE-1')).all()).toHaveLength(0);
  });

  it('keeps automation available for the explicitly configured owner/operator chat by default', () => {
    const { connectionId, supervisor, handoffs } = fixture();
    ctx.db.update(schema.channelConnections).set({
      settings: { mode: 'qr_local', ownerChatId: '5521970398568@s.whatsapp.net' },
    }).where(eq(schema.channelConnections.id, connectionId)).run();

    supervisor.observeOutbound(connectionId, {
      externalId: 'OWNER-MESSAGE-1', chatId: '5521970398568@s.whatsapp.net', body: 'Testing my assistant',
    });

    const message = ctx.db.select().from(schema.conversationMessages).get()!;
    expect(message.authorType).toBe('operator');
    expect(handoffs.current(ctx.workspace.id, message.conversationId)).toMatchObject({
      state: 'agent', automationEpoch: 0, claimedAt: null,
    });
  });

  it('keeps automation available for a verified connection-scoped Owner even without ownerChatId', () => {
    const { connectionId, supervisor, handoffs } = fixture();
    const identity = new ChannelIdentityService({ db: ctx.db, logger: ctx.logger });
    identity.grantAuthority({
      workspaceId: ctx.workspace.id,
      connectionId,
      channelKind: 'whatsapp',
      handle: '+55 21 97039-8568',
      role: 'owner',
      userId: ctx.user.id,
      method: 'test_owner_setting',
    });

    supervisor.observeOutbound(connectionId, {
      externalId: 'VERIFIED-OWNER-MESSAGE-1',
      chatId: '5521970398568:12@s.whatsapp.net',
      body: 'Testing my assistant from another device',
    });

    const message = ctx.db.select().from(schema.conversationMessages).get()!;
    expect(handoffs.current(ctx.workspace.id, message.conversationId)).toMatchObject({
      state: 'agent', automationEpoch: 0, claimedAt: null,
    });
  });

  it('uses the alternate PN identity when WhatsApp observes the owner chat under a LID', () => {
    const { connectionId, supervisor, handoffs } = fixture();
    ctx.db.update(schema.channelConnections).set({
      settings: { mode: 'qr_local', ownerChatId: '5521970398568@s.whatsapp.net' },
    }).where(eq(schema.channelConnections.id, connectionId)).run();

    supervisor.observeOutbound(connectionId, {
      externalId: 'OWNER-LID-MESSAGE-1',
      chatId: '187654321098765@lid',
      alternateChatIds: ['5521970398568@s.whatsapp.net'],
      body: 'Self-chat through the LID alias',
    });

    const message = ctx.db.select().from(schema.conversationMessages).get()!;
    expect(handoffs.current(ctx.workspace.id, message.conversationId)).toMatchObject({
      state: 'agent', automationEpoch: 0, claimedAt: null,
    });
  });

  it('ignores the removed v3 owner takeover flag and keeps the operator chat active', () => {
    const { connectionId, supervisor, handoffs } = fixture();
    ctx.db.update(schema.channelConnections).set({
      settings: {
        mode: 'qr_local',
        ownerChatId: '5521970398568@s.whatsapp.net',
        whatsappProfile: { ownerManualOutboundTakeover: 'until_handback' },
      },
    }).where(eq(schema.channelConnections.id, connectionId)).run();

    supervisor.observeOutbound(connectionId, {
      externalId: 'OWNER-MESSAGE-2', chatId: '5521970398568@s.whatsapp.net', body: 'Take over this one',
    });

    const message = ctx.db.select().from(schema.conversationMessages).get()!;
    expect(handoffs.current(ctx.workspace.id, message.conversationId)).toMatchObject({ state: 'agent', automationEpoch: 0 });
  });

  it('does not treat an auto/default routing target as an owner exception', () => {
    const { connectionId, supervisor, handoffs } = fixture();
    ctx.db.update(schema.channelConnections).set({
      settings: { mode: 'qr_local', defaultChatId: '5521970398568@s.whatsapp.net' },
    }).where(eq(schema.channelConnections.id, connectionId)).run();

    supervisor.observeOutbound(connectionId, {
      externalId: 'DEFAULT-MESSAGE-1', chatId: '5521970398568@s.whatsapp.net', body: 'Still take over',
    });

    const message = ctx.db.select().from(schema.conversationMessages).get()!;
    expect(handoffs.current(ctx.workspace.id, message.conversationId)).toMatchObject({ state: 'human' });
  });

  it('can disable manual WhatsApp takeover for every conversation', () => {
    const { connectionId, supervisor, handoffs } = fixture();
    ctx.db.update(schema.channelConnections).set({
      settings: { mode: 'qr_local', whatsappProfile: { manualOutboundTakeover: 'off' } },
    }).where(eq(schema.channelConnections.id, connectionId)).run();

    supervisor.observeOutbound(connectionId, {
      externalId: 'NO-TAKEOVER-1', chatId: '5521970398568@s.whatsapp.net', body: 'Do not claim',
    });

    const message = ctx.db.select().from(schema.conversationMessages).get()!;
    expect(handoffs.current(ctx.workspace.id, message.conversationId)).toMatchObject({
      state: 'agent', automationEpoch: 0, claimedAt: null,
    });
  });
});
