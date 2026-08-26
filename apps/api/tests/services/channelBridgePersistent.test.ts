/**
 * ChannelBridge persistent-transport routing (WhatsApp).
 *
 * WhatsApp is QR-authenticated (no token) and sends over a live socket owned by
 * the supervisor, not the stateless webhook adapter. These tests use a fake
 * PersistentChannelTransport so no baileys socket is needed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { ChannelBridge, DEFAULT_WHATSAPP_CONNECTION_PROFILE, type PersistentChannelTransport } from '../../src/services/conversation/channelBridge.js';
import { ConversationStore } from '../../src/services/conversation/conversationStore.js';
import { SlackChannelAdapter } from '../../src/adapters/channels/slack.js';
import { ConversationHandoffService } from '../../src/services/conversation/conversationHandoffService.js';
import { ChannelIdentityService } from '../../src/services/conversation/channelIdentityService.js';

function seedAgent(ctx: TestContext) {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    name: 'Orchestrator', adapterType: 'http',
  }).run();
  return id;
}

function fakeTransport(initialStatus = 'idle') {
  const sent: Array<{ connectionId: string; chatId: string; body: string }> = [];
  const stopped: string[] = [];
  const created: string[] = [];
  const typing: Array<{ connectionId: string; chatId: string; on: boolean }> = [];
  let liveStatus = initialStatus;
  const transport: PersistentChannelTransport = {
    handles: (conn) => conn.kind === 'whatsapp'
      || (conn.kind === 'telegram' && (conn.settings as { transport?: string } | undefined)?.transport === 'polling')
      || (conn.kind === 'discord' && (conn.settings as { transport?: string } | undefined)?.transport === 'gateway'),
    requiresNoToken: (kind) => kind === 'whatsapp',
    onCreated: (conn) => { created.push(conn.id); },
    status: () => ({ status: liveStatus }),
    send: async (connectionId, chatId, body) => {
      sent.push({ connectionId, chatId, body });
      const kind = chatId.includes('@s.whatsapp.net') ? 'whatsapp' : chatId === '987' ? 'telegram' : 'discord';
      return { provider: kind, providerMessageId: `provider-${sent.length}`, status: 'accepted', acceptedAt: '2026-07-14T00:00:00.000Z', recipient: chatId } as const;
    },
    setTyping: async (connectionId, chatId, on) => { typing.push({ connectionId, chatId, on }); },
    stop: async (connectionId) => { stopped.push(connectionId); },
  };
  return { transport, sent, stopped, created, typing, setStatus: (status: string) => { liveStatus = status; } };
}

function buildBridge(ctx: TestContext) {
  const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
  const handoffs = new ConversationHandoffService({ db: ctx.db, bus: ctx.bus });
  const bridge = new ChannelBridge({
    db: ctx.db, vault: ctx.vault, conversations, bus: ctx.bus, logger: ctx.logger,
    adapters: { slack: new SlackChannelAdapter() },
    handoffs,
  });
  return { bridge, conversations, handoffs };
}

describe('ChannelBridge persistent transport (WhatsApp)', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => ctx.close());

  it('creates a WhatsApp connection without a token, needing QR action', () => {
    const { bridge } = buildBridge(ctx);
    const { transport } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);

    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'WA personal',
    });
    expect(connection.kind).toBe('whatsapp');
    expect(connection.status).toBe('needs_action');
    expect(connection.health.status).toBe('needs_action');

    // tokenEncrypted is still populated (NOT NULL) with an encrypted marker.
    const row = ctx.db.select().from(schema.channelConnections).where(eq(schema.channelConnections.id, connection.id)).get()!;
    expect(row.tokenEncrypted).toBeTruthy();
    expect(ctx.vault.decrypt(row.tokenEncrypted)).toContain('persistent:whatsapp');
    expect(connection.whatsappProfile).toEqual(DEFAULT_WHATSAPP_CONNECTION_PROFILE);
  });

  it('migrates legacy WhatsApp settings lazily and persists the owner indicator choice', () => {
    const { bridge } = buildBridge(ctx);
    const { transport } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'WA',
    });
    // Simulate a connection saved before the versioned profile existed.
    ctx.db.update(schema.channelConnections).set({ settings: { mode: 'qr_local' } })
      .where(eq(schema.channelConnections.id, connection.id)).run();
    expect(bridge.get(ctx.workspace.id, connection.id).whatsappProfile?.ownerReasoningVisibility).toBe('off');

    const updated = bridge.updateBehavior(ctx.workspace.id, connection.id, { ownerReasoningVisibility: 'indicator' });
    expect(updated.whatsappProfile).toMatchObject({
      version: 4,
      ownerReasoningVisibility: 'indicator',
      manualOutboundTakeover: 'until_handback',
      ownerManualOutboundTakeover: 'off',
      historyReconciliation: 'recent',
    });
    const row = ctx.db.select().from(schema.channelConnections).where(eq(schema.channelConnections.id, connection.id)).get()!;
    expect((row.settings as { whatsappProfile?: { version?: number; ownerReasoningVisibility?: string } }).whatsappProfile)
      .toMatchObject({ version: 4, ownerReasoningVisibility: 'indicator' });
  });

  it('persists an explicit owner/operator chat separately from the routing default', () => {
    const { bridge } = buildBridge(ctx);
    const { transport } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'WA', defaultChatId: '+55 31 7000-0000',
    });

    expect(bridge.get(ctx.workspace.id, connection.id).ownerChatId).toBeNull();
    const updated = bridge.updateTargets(ctx.workspace.id, connection.id, {
      ownerChatId: '+55 31 7000-0000',
      ownerName: 'Robson',
    });
    expect(updated.ownerChatId).toBe('553170000000@s.whatsapp.net');
    expect(updated.ownerName).toBe('Robson');
    expect(updated.defaultChatId).toBe('553170000000@s.whatsapp.net');
  });

  it('rejects a non-persistent kind without a token', () => {
    const { bridge } = buildBridge(ctx);
    const { transport } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);
    expect(() =>
      bridge.create({ workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id, agentId, kind: 'slack', name: 'x' }),
    ).toThrow(/token/);
  });

  it('deliverToConnection routes WhatsApp sends to the live transport', async () => {
    const { bridge } = buildBridge(ctx);
    const { transport, sent } = fakeTransport();
    bridge.setPersistentTransport(transport);

    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'WA',
    });

    const receipt = await bridge.deliverToConnection({ connectionId: connection.id, chatId: '1234567@s.whatsapp.net', body: 'pong' });
    expect(sent).toEqual([{ connectionId: connection.id, chatId: '1234567@s.whatsapp.net', body: 'pong' }]);
    expect(receipt.providerMessageId).toBe('provider-1');

    const row = ctx.db.select().from(schema.channelConnections).where(eq(schema.channelConnections.id, connection.id)).get()!;
    expect(row.status).toBe('active'); // markActive after a successful send
    const journal = ctx.db.select().from(schema.channelOutboundDeliveries).all();
    expect(journal).toHaveLength(1);
    expect(journal[0]?.status).toBe('accepted');
  });

  it('persists a programmatic delivery as business context for the recipient conversation', async () => {
    const { bridge } = buildBridge(ctx);
    const { transport } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'WA workflow',
    });
    const chatId = '5511999999999@s.whatsapp.net';

    await bridge.deliverToConnection({
      connectionId: connection.id,
      chatId,
      body: 'Olá, aqui é a Bia da Talki.',
      idempotencyKey: 'run-1:first-contact',
      persistOutboundContext: true,
    });

    const conversation = ctx.db.select().from(schema.conversations)
      .where(eq(schema.conversations.channelConnectionId, connection.id)).get()!;
    expect(conversation).toMatchObject({ agentId, channelChatId: chatId });
    const messages = ctx.db.select().from(schema.conversationMessages)
      .where(eq(schema.conversationMessages.conversationId, conversation.id)).all();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      body: 'Olá, aqui é a Bia da Talki.',
      authorType: 'agent',
      participantSide: 'business',
      sessionMessageId: 'run-1:first-contact',
      deliveryStatus: 'sent',
    });
  });

  it('claims before a human send and rejects every later automated delivery until handback', async () => {
    const { bridge, handoffs } = buildBridge(ctx);
    const { transport, sent } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'WA takeover',
    });
    const target = '5511999999999@s.whatsapp.net';
    await bridge.deliverToConnection({ connectionId: connection.id, chatId: target, body: 'human reply', actor: 'human' });
    const snapshot = handoffs.findByChannel(ctx.workspace.id, connection.id, target)!;
    expect(snapshot).toMatchObject({ state: 'human', source: 'explicit', automationEpoch: 1 });
    await expect(bridge.deliverToConnection({
      connectionId: connection.id, chatId: target, body: 'stale automation', conversationId: snapshot.conversationId,
    })).rejects.toMatchObject({ code: 'CHANNEL_HUMAN_TAKEOVER_ACTIVE' });
    expect(sent.map((item) => item.body)).toEqual(['human reply']);
    const handedBack = handoffs.releaseToAgent(ctx.workspace.id, snapshot.conversationId);
    expect(handedBack.automationEpoch).toBe(2);
    await expect(bridge.deliverToConnection({
      connectionId: connection.id,
      chatId: target,
      body: 'reply from stale turn',
      conversationId: snapshot.conversationId,
      expectedAutomationEpoch: snapshot.automationEpoch,
    })).rejects.toMatchObject({ code: 'TURN_CANCELLED' });
    await bridge.deliverToConnection({ connectionId: connection.id, chatId: target, body: 'agent is back' });
    expect(sent.map((item) => item.body)).toEqual(['human reply', 'agent is back']);
  });

  it('does not claim the explicit owner/operator chat when an operator sends through Agentis', async () => {
    const { bridge, handoffs } = buildBridge(ctx);
    const { transport, sent } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);
    const target = '5511999999999@s.whatsapp.net';
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'WA owner', ownerChatId: target,
    });

    await bridge.deliverToConnection({ connectionId: connection.id, chatId: target, body: 'operator note', actor: 'human' });
    const snapshot = handoffs.findByChannel(ctx.workspace.id, connection.id, target)!;
    expect(snapshot).toMatchObject({ state: 'agent', automationEpoch: 0 });
    await bridge.deliverToConnection({ connectionId: connection.id, chatId: target, body: 'agent reply', conversationId: snapshot.conversationId });
    expect(sent.map((item) => item.body)).toEqual(['operator note', 'agent reply']);
  });

  it('does not claim a verified Owner chat when an operator sends through Agentis', async () => {
    const { bridge, handoffs } = buildBridge(ctx);
    const { transport, sent } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);
    const target = '5511999999999@s.whatsapp.net';
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'WA verified owner',
    });
    new ChannelIdentityService({ db: ctx.db, logger: ctx.logger }).grantAuthority({
      workspaceId: ctx.workspace.id,
      connectionId: connection.id,
      channelKind: 'whatsapp',
      handle: '+55 11 99999-9999',
      role: 'owner',
      userId: ctx.user.id,
      method: 'test_owner_setting',
    });

    await bridge.deliverToConnection({ connectionId: connection.id, chatId: target, body: 'owner note', actor: 'human' });
    const snapshot = handoffs.findByChannel(ctx.workspace.id, connection.id, target)!;
    expect(snapshot).toMatchObject({ state: 'agent', automationEpoch: 0 });
    await bridge.deliverToConnection({ connectionId: connection.id, chatId: target, body: 'agent reply', conversationId: snapshot.conversationId });
    expect(sent.map((item) => item.body)).toEqual(['owner note', 'agent reply']);
  });

  it('persists a client-only WhatsApp submission as queued, never as sent', async () => {
    const { bridge } = buildBridge(ctx);
    const { transport } = fakeTransport();
    transport.send = async (_connectionId, chatId) => ({
      provider: 'whatsapp',
      providerMessageId: '3EB0CLIENTONLY',
      status: 'queued',
      acceptedAt: '2026-07-16T00:00:00.000Z',
      recipient: chatId,
      providerAcknowledged: false,
      providerStatus: 0,
    });
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'WA',
    });
    const capture = ctx.captureBus();
    const receipt = await bridge.deliverToConnection({
      connectionId: connection.id,
      chatId: '1234567@s.whatsapp.net',
      body: 'pending',
      idempotencyKey: 'run-pending:send',
    });
    capture.stop();

    expect(receipt.status).toBe('queued');
    const journal = ctx.db.select().from(schema.channelOutboundDeliveries)
      .where(eq(schema.channelOutboundDeliveries.idempotencyKey, 'run-pending:send')).get();
    expect(journal?.status).toBe('queued');
    expect((journal?.receipt as { providerAcknowledged?: boolean })?.providerAcknowledged).toBe(false);
    expect(capture.events.some((event) => event.envelope.event === 'channel.message.sent')).toBe(false);
    expect(capture.events.some((event) => event.envelope.event === 'channel.message.status')).toBe(true);
  });

  it('normalizes explicit WhatsApp phone numbers before live send', async () => {
    const { bridge } = buildBridge(ctx);
    const { transport, sent } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'WA',
    });

    await bridge.deliverToConnection({ connectionId: connection.id, chatId: '+1 (234) 567-8901', body: 'pong' });
    expect(sent).toEqual([{ connectionId: connection.id, chatId: '12345678901@s.whatsapp.net', body: 'pong' }]);
  });

  it('reuses a durable outbound receipt instead of resending the same workflow delivery', async () => {
    const { bridge } = buildBridge(ctx);
    const { transport, sent } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'WA',
    });
    const request = {
      connectionId: connection.id,
      chatId: '1234567@s.whatsapp.net',
      body: 'generic notification',
      idempotencyKey: 'run-1:notify-node',
    };

    const first = await bridge.deliverToConnection(request);
    const replay = await bridge.deliverToConnection(request);

    expect(sent).toHaveLength(1);
    expect(first.providerMessageId).toBe('provider-1');
    expect(replay.providerMessageId).toBe('provider-1');
    expect(replay.deduplicated).toBe(true);
  });

  it('does not blindly resend an outbound attempt whose provider outcome is uncertain', async () => {
    const { bridge } = buildBridge(ctx);
    const { transport } = fakeTransport();
    let providerAttempts = 0;
    transport.send = async () => {
      providerAttempts += 1;
      throw new Error('provider connection closed before a receipt was returned');
    };
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'WA',
    });
    const request = {
      connectionId: connection.id,
      chatId: '1234567@s.whatsapp.net',
      body: 'generic notification',
      idempotencyKey: 'run-2:notify-node',
    };

    await expect(bridge.deliverToConnection(request)).rejects.toThrow(/before a receipt/);
    await expect(bridge.deliverToConnection(request)).rejects.toThrow(/status uncertain/);

    expect(providerAttempts).toBe(1);
    const journal = ctx.db.select()
      .from(schema.channelOutboundDeliveries)
      .where(eq(schema.channelOutboundDeliveries.idempotencyKey, request.idempotencyKey))
      .get();
    expect(journal?.status).toBe('uncertain');
    expect(journal?.providerMessageId).toBeNull();
  });

  it('marks open WhatsApp QR healthy without requiring a default recipient', async () => {
    const { bridge } = buildBridge(ctx);
    const { transport, setStatus } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'WA',
    });
    setStatus('open');

    const health = await bridge.test({ workspaceId: ctx.workspace.id, id: connection.id });
    expect(health.status).toBe('active');
    expect(health.checks.find((check) => check.name === 'outbound')?.code).toBe('outbound_ready_for_explicit_recipient');
    expect(health.checks.find((check) => check.name === 'inbound')?.code).toBe('inbound_live_ready_no_default');
  });

  it('keeps a healthy linked transport degraded, not dead, when only companion outbound is restricted', async () => {
    const { bridge } = buildBridge(ctx);
    const { transport, setStatus } = fakeTransport();
    transport.outboundHealth = async () => ({
      name: 'outbound',
      ok: false,
      code: 'whatsapp_companion_outbound_timelocked',
      message: 'Companion outbound is temporarily restricted; the primary phone may remain usable.',
      evidence: { restrictionScope: 'companion', primaryPhoneMayRemainUsable: true },
      checkedAt: '2026-07-16T00:00:00.000Z',
    });
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'WA restricted companion',
    });
    setStatus('open');

    const health = await bridge.test({ workspaceId: ctx.workspace.id, id: connection.id });

    expect(health.status).toBe('degraded');
    expect(health.checks.find((check) => check.name === 'transport')?.ok).toBe(true);
    expect(health.checks.find((check) => check.name === 'inbound')?.ok).toBe(true);
    expect(health.checks.find((check) => check.name === 'outbound')).toMatchObject({
      ok: false,
      code: 'whatsapp_companion_outbound_timelocked',
      evidence: { restrictionScope: 'companion', primaryPhoneMayRemainUsable: true },
    });
  });

  it('reconciles persisted status and health with authoritative live transport state', () => {
    const { bridge } = buildBridge(ctx);
    const { transport, setStatus } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'WA drift',
    });
    const row = ctx.db.select().from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connection.id)).get()!;
    ctx.db.update(schema.channelConnections).set({
      status: 'error',
      lastError: 'stale disconnect',
      settings: {
        ...(row.settings as Record<string, unknown>),
        transportStatus: 'logged_out',
        health: { status: 'error', checks: [], lastTestAt: '2026-07-01T00:00:00.000Z' },
      },
    }).where(eq(schema.channelConnections.id, connection.id)).run();

    setStatus('open');
    const healed = bridge.get(ctx.workspace.id, connection.id);
    expect(healed.status).toBe('active');
    expect(healed.transportStatus).toBe('open');
    expect(healed.health.status).toBe('active');
    expect(healed.lastError).toBeNull();
    expect(ctx.db.select().from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connection.id)).get()).toMatchObject({
        status: 'active', lastError: null,
      });

    setStatus('logged_out');
    const terminal = bridge.get(ctx.workspace.id, connection.id);
    expect(terminal.status).toBe('error');
    expect(terminal.health.status).toBe('error');
  });

  it('binds and unbinds a channel and its existing conversations to an App', () => {
    const { bridge, conversations } = buildBridge(ctx);
    const { transport } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'WA App',
    });
    const appId = randomUUID();
    ctx.db.insert(schema.apps).values({
      id: appId, workspaceId: ctx.workspace.id, slug: `test-${appId}`,
      name: 'Channel App', description: '', createdBy: ctx.user.id,
    }).run();
    const conversation = conversations.getOrCreateByChannel({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, channelConnectionId: connection.id, channelChatId: '5511@s.whatsapp.net',
    });

    expect(bridge.bindApp(ctx.workspace.id, connection.id, appId).appId).toBe(appId);
    expect(ctx.db.select().from(schema.conversations)
      .where(eq(schema.conversations.id, conversation.id)).get()?.appId).toBe(appId);
    expect(bridge.bindApp(ctx.workspace.id, connection.id, null).appId).toBeNull();
    expect(ctx.db.select().from(schema.conversations)
      .where(eq(schema.conversations.id, conversation.id)).get()?.appId).toBeNull();
    expect(() => bridge.bindApp(ctx.workspace.id, connection.id, randomUUID())).toThrow(/app .* not found/);
  });

  it('Telegram polling: onCreated fires and outbound routes through the live session', async () => {
    const { bridge } = buildBridge(ctx);
    const { transport, sent, created } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);

    // Telegram polling still needs the bot token, but does NOT need the webhook
    // adapter registered (it's delivered by the live session).
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'telegram', name: 'TG poll', token: '123456:bot-token', transport: 'polling',
    });
    expect(connection.status).toBe('verifying');
    expect(created).toEqual([connection.id]);

    await bridge.deliverToConnection({ connectionId: connection.id, chatId: '987', body: 'hi' });
    expect(sent).toEqual([{ connectionId: connection.id, chatId: '987', body: 'hi' }]);
  });

  it('setTyping routes to the live transport for persistent kinds only', async () => {
    const { bridge } = buildBridge(ctx);
    const { transport, typing } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'WA',
    });
    await bridge.setTyping(connection.id, '777@s.whatsapp.net', true);
    await bridge.setTyping(connection.id, '777@s.whatsapp.net', false);
    expect(typing).toEqual([
      { connectionId: connection.id, chatId: '777@s.whatsapp.net', on: true },
      { connectionId: connection.id, chatId: '777@s.whatsapp.net', on: false },
    ]);

    // A webhook (slack) connection is not handled by the persistent transport → no-op.
    const slack = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'slack', name: 'SL', token: 'xoxb-token',
    });
    await bridge.setTyping(slack.connection.id, 'C1', true);
    expect(typing).toHaveLength(2); // unchanged
  });

  it('Discord gateway: onCreated fires and outbound routes through the live session', async () => {
    const { bridge } = buildBridge(ctx);
    const { transport, sent, created } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'discord', name: 'DC gateway', token: 'discord-bot-token', transport: 'gateway',
    });
    expect(connection.status).toBe('verifying');
    expect(created).toEqual([connection.id]);
    await bridge.deliverToConnection({ connectionId: connection.id, chatId: 'chan-1', body: 'hi' });
    expect(sent).toEqual([{ connectionId: connection.id, chatId: 'chan-1', body: 'hi' }]);
  });

  it('delete stops the live session', () => {
    const { bridge } = buildBridge(ctx);
    const { transport, stopped } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'WA',
    });
    bridge.delete(ctx.workspace.id, connection.id);
    expect(stopped).toEqual([connection.id]);
  });
});
