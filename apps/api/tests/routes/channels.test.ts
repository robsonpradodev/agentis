/**
 * /v1/channels — route unit tests (Batch 4 / D35).
 *
 * Stubs the Telegram channel adapter to avoid network calls. Asserts the
 * outbound surface (CRUD + test + webhook-info) and the unauth ingress on
 * /v1/webhooks/channel/:id (mounted via buildWebhookRoutes).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { eq } from 'drizzle-orm';
import { ConversationStore } from '../../src/services/conversation/conversationStore.js';
import {
  ChannelBridge,
  type PersistentChannelTransport,
} from '../../src/services/conversation/channelBridge.js';
import { ConnectionGrantService } from '../../src/services/connectionGrants.js';
import { buildChannelRoutes } from '../../src/routes/channels.js';
import { buildWebhookRoutes } from '../../src/routes/webhooks.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import type { ChannelAdapter, ParsedInboundMessage } from '../../src/adapters/channels/types.js';
import type { TriggerRuntime } from '../../src/engine/TriggerRuntime.js';
import { SlackChannelAdapter } from '../../src/adapters/channels/slack.js';
import { ChannelIdentityService } from '../../src/services/conversation/channelIdentityService.js';
import { ChannelInboxService } from '../../src/services/conversation/channelInboxService.js';

class StubAdapter implements ChannelAdapter {
  readonly kind = 'telegram' as const;
  readonly sent: Array<{ chatId: string; body: string }> = [];
  probeError: Error | null = null;
  acceptVerify = true;
  parseResult: ParsedInboundMessage | null = {
    externalId: 'telegram:101',
    chatId: '777',
    body: 'inbound text',
  };
  async send(args: { chatId: string; body: string }): Promise<void> {
    this.sent.push({ chatId: args.chatId, body: args.body });
  }
  verify(): boolean {
    return this.acceptVerify;
  }
  parseInbound(): ParsedInboundMessage | null {
    return this.parseResult;
  }

  async probeCredential(): Promise<import('@agentis/core').ChannelHealthCheck> {
    if (this.probeError) throw this.probeError;
    return {
      name: 'credential',
      ok: true,
      code: 'telegram_credential_ok',
      message: 'Telegram credentials are valid.',
      checkedAt: new Date().toISOString(),
    };
  }
}

let ctx: TestContext;
let bridge: ChannelBridge;
let adapter: StubAdapter;
let connectionGrants: ConnectionGrantService;
let identity: ChannelIdentityService;
let inbox: ChannelInboxService;

function seedAgent() {
  const id = randomUUID();
  ctx.db
    .insert(schema.agents)
    .values({
      id,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Hermes',
      adapterType: 'http',
    })
    .run();
  return id;
}

function app() {
  return ctx.buildApp([
    {
      path: '/v1/channels',
      app: buildChannelRoutes({
        db: ctx.db,
        auth: ctx.auth,
        bridge,
        connectionGrants,
        identity,
        inbox,
      }),
    },
    {
      path: '/v1/webhooks',
      app: buildWebhookRoutes({
        runtime: {} as unknown as TriggerRuntime,
        bridge,
      }),
    },
  ]);
}

function fakePersistentTransport(): PersistentChannelTransport {
  return {
    handles: (conn) => conn.kind === 'whatsapp',
    requiresNoToken: (kind) => kind === 'whatsapp',
    status: () => ({ status: 'idle' }),
    send: async () => {
      throw new Error('should not send during QR-local create');
    },
  };
}

beforeEach(async () => {
  ctx = await createTestContext();
  adapter = new StubAdapter();
  const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
  identity = new ChannelIdentityService({ db: ctx.db, logger: ctx.logger });
  bridge = new ChannelBridge({
    db: ctx.db,
    vault: ctx.vault,
    conversations,
    bus: ctx.bus,
    logger: ctx.logger,
    adapters: { telegram: adapter, slack: new SlackChannelAdapter() },
    identity,
  });
  connectionGrants = new ConnectionGrantService(ctx.db);
  inbox = new ChannelInboxService({ db: ctx.db, identities: identity });
});

afterEach(() => {
  vi.unstubAllGlobals();
  ctx.close();
});

describe('WhatsApp Cloud shared webhook E2E', () => {
  it('routes a batch to its tenant, deduplicates inbound events, reconciles receipts, and supports read/typing', async () => {
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
      kind: 'whatsapp',
      name: 'Cloud customer',
      mode: 'cloud',
      token: 'meta-access-token',
      phoneNumberId: 'phone-tenant-a',
      graphApiVersion: 'v21.0',
      appSecret: 'meta-app-secret',
      verifyToken: 'verify-shared',
    });
    expect(bridge.capabilitiesFor(connection.id)).toMatchObject({
      providerApiVersion: 'v21.0',
      supportsTemplates: true,
      supportsReadReceipts: true,
    });
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (
        url.endsWith('/messages') &&
        init?.method === 'POST' &&
        typeof init.body === 'string' &&
        !init.body.includes('typing_indicator')
      ) {
        return new Response(JSON.stringify({ messages: [{ id: 'wamid.outbound-1' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', mockFetch);
    const webhook = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: {
                  phone_number_id: 'phone-tenant-a',
                  display_phone_number: '5531999990000',
                },
                messages: [
                  {
                    id: 'wamid.inbound-1',
                    from: '5531888880000',
                    timestamp: '1790000000',
                    type: 'text',
                    text: { body: 'Oi' },
                  },
                  {
                    id: 'wamid.inbound-2',
                    from: '5531888880000',
                    timestamp: '1790000001',
                    type: 'text',
                    text: { body: 'Quero orçamento' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const rawBody = JSON.stringify(webhook);
    const signature = `sha256=${createHmac('sha256', 'meta-app-secret').update(rawBody).digest('hex')}`;
    const response = await app().request('/v1/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'x-hub-signature-256': signature },
      body: rawBody,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: true, processedConnections: 1 });
    const rows = ctx.db
      .select()
      .from(schema.channelDeliveries)
      .where(eq(schema.channelDeliveries.connectionId, connection.id))
      .all();
    expect(rows.map((row) => row.externalId)).toEqual([
      'whatsapp:wamid.inbound-1',
      'whatsapp:wamid.inbound-2',
    ]);

    const replay = await app().request('/v1/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'x-hub-signature-256': signature },
      body: rawBody,
    });
    expect(await replay.json()).toMatchObject({ accepted: true, idempotent: true });
    expect(
      ctx.db
        .select()
        .from(schema.channelDeliveries)
        .where(eq(schema.channelDeliveries.connectionId, connection.id))
        .all(),
    ).toHaveLength(2);

    const conversation = ctx.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.channelConnectionId, connection.id))
      .get()!;
    await bridge.deliverToConnection({
      connectionId: connection.id,
      chatId: '5531888880000',
      body: 'Recebi seu pedido.',
      conversationId: conversation.id,
      persistOutboundContext: true,
    });
    expect(
      ctx.db
        .select()
        .from(schema.channelOutboundDeliveries)
        .where(eq(schema.channelOutboundDeliveries.connectionId, connection.id))
        .get(),
    ).toMatchObject({ providerMessageId: 'wamid.outbound-1', conversationId: conversation.id });

    const receiptBody = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'phone-tenant-a' },
                statuses: [
                  {
                    id: 'wamid.outbound-1',
                    status: 'delivered',
                    timestamp: '1790000010',
                    recipient_id: '5531888880000',
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const receiptSignature = `sha256=${createHmac('sha256', 'meta-app-secret').update(receiptBody).digest('hex')}`;
    await app().request('/v1/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'x-hub-signature-256': receiptSignature },
      body: receiptBody,
    });
    expect(
      ctx.db
        .select()
        .from(schema.channelOutboundDeliveries)
        .where(eq(schema.channelOutboundDeliveries.connectionId, connection.id))
        .get(),
    ).toMatchObject({
      status: 'delivered',
      receipt: expect.objectContaining({ status: 'delivered', providerStatus: 'delivered' }),
    });
    expect(
      ctx.db
        .select()
        .from(schema.conversationMessages)
        .where(eq(schema.conversationMessages.conversationId, conversation.id))
        .all(),
    ).toContainEqual(
      expect.objectContaining({ body: 'Recebi seu pedido.', deliveryStatus: 'delivered' }),
    );

    await bridge.markWhatsAppCloudMessageRead(ctx.workspace.id, connection.id, 'wamid.inbound-1');
    await bridge.setTyping(connection.id, '5531888880000', true);
    await bridge.setTyping(connection.id, '5531888880000', false);
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) => String(url).endsWith('/messages') && init?.method === 'PUT',
      ),
    ).toBe(true);
    expect(
      mockFetch.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith('/messages') &&
          typeof init?.body === 'string' &&
          init.body.includes('typing_indicator'),
      ),
    ).toBe(true);
  });

  it('shared callback verification accepts a configured connection token and rejects a bad signature', async () => {
    const agentId = seedAgent();
    bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'whatsapp',
      name: 'Cloud verify',
      mode: 'cloud',
      token: 'meta-access-token',
      phoneNumberId: 'phone-tenant-b',
      appSecret: 'secret-for-b',
      verifyToken: 'verify-shared',
    });
    const valid = await app().request(
      '/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-shared&hub.challenge=challenge-123',
    );
    expect(valid.status).toBe(200);
    expect(await valid.text()).toBe('challenge-123');
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const invalid = await app().request('/v1/webhooks/whatsapp', { method: 'POST', body });
    expect(invalid.status).toBe(401);
  });

  it('turns explicit Portuguese opt-out into a durable per-connection suppression', async () => {
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'whatsapp',
      name: 'Cloud opt-out',
      mode: 'cloud',
      token: 'meta-access-token',
      phoneNumberId: 'phone-optout',
      appSecret: 'meta-app-secret',
      verifyToken: 'verify-optout',
    });
    const body = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'phone-optout' },
                messages: [
                  {
                    id: 'wamid.optout',
                    from: '5531777000000',
                    type: 'text',
                    text: { body: 'SAIR' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const signature = `sha256=${createHmac('sha256', 'meta-app-secret').update(body).digest('hex')}`;
    await bridge.handleWhatsAppCloudWebhook({
      headers: { 'x-hub-signature-256': signature },
      rawBody: body,
    });
    expect(identity.list(ctx.workspace.id)).toContainEqual(
      expect.objectContaining({
        connectionId: connection.id,
        handle: '5531777000000',
        blocked: true,
      }),
    );
    await expect(
      bridge.deliverToConnection({
        connectionId: connection.id,
        chatId: '5531777000000',
        body: 'follow-up',
      }),
    ).rejects.toMatchObject({ code: 'CHANNEL_SEND_BLOCKED' });
  });
});

describe('POST /v1/channels', () => {
  it('persists a failed health check instead of leaving a new connection verifying', async () => {
    adapter.probeError = new Error('provider probe unavailable');
    const agentId = seedAgent();
    const res = await app().request('/v1/channels', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        kind: 'telegram',
        name: 'Tg probe failure',
        agentId,
        token: 'super-secret-bot-token',
        runInitialTest: true,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      health: { status: string; checks: Array<{ name: string; code: string }> };
    };
    expect(body.health.status).not.toBe('verifying');
    expect(body.health.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'credential', ok: false })]),
    );
  });

  it('creates a connection, returns webhookSecret + URL once, never returns the token', async () => {
    const agentId = seedAgent();
    const res = await app().request('/v1/channels', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        kind: 'telegram',
        name: 'Tg main',
        agentId,
        token: 'super-secret-bot-token',
        defaultChatId: '999',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.webhookSecret).toMatch(/^[0-9a-f]{48}$/);
    expect(body.webhookUrl).toMatch(/^\/v1\/webhooks\/channel\//);
    expect(JSON.stringify(body)).not.toContain('super-secret-bot-token');
  });

  it('defaults Telegram to long polling when AGENTIS_PUBLIC_URL is not set', async () => {
    const previous = process.env.AGENTIS_PUBLIC_URL;
    delete process.env.AGENTIS_PUBLIC_URL;
    try {
      const agentId = seedAgent();
      const res = await app().request('/v1/channels', {
        method: 'POST',
        headers: ctx.authHeaders,
        body: JSON.stringify({
          kind: 'telegram',
          name: 'Tg poll',
          agentId,
          token: 'super-secret-bot-token',
          runInitialTest: false,
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { connection: { transport: string | null } };
      expect(body.connection.transport).toBe('polling');
    } finally {
      if (previous) process.env.AGENTIS_PUBLIC_URL = previous;
      else delete process.env.AGENTIS_PUBLIC_URL;
    }
  });

  it('normalizes a labelled Telegram chat id (e.g. "ID: 7905735992") to the bare id', async () => {
    const agentId = seedAgent();
    const res = await app().request('/v1/channels', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        kind: 'telegram',
        name: 'Tg labelled',
        agentId,
        token: 'super-secret-bot-token',
        defaultChatId: 'ID: 7905735992',
        runInitialTest: false,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { connection: { defaultChatId: string | null } };
    // The label must be stripped, otherwise sendMessage fails with "chat not found".
    expect(body.connection.defaultChatId).toBe('7905735992');
  });

  it('does not auto-test WhatsApp QR-local connections before login', async () => {
    bridge.setPersistentTransport(fakePersistentTransport());
    const agentId = seedAgent();
    const res = await app().request('/v1/channels', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        kind: 'whatsapp',
        mode: 'qr_local',
        name: 'WA local',
        agentId,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      loginUrl?: string;
      health: { status: string; checks: Array<{ code: string }> };
    };
    expect(body.loginUrl).toMatch(/^\/v1\/channels\/.+\/login$/);
    expect(body.health.status).toBe('needs_action');
    expect(body.health.checks.every((check) => check.code === 'not_checked')).toBe(true);
  });

  it('rejects without auth (401)', async () => {
    const res = await app().request('/v1/channels', {
      method: 'POST',
      body: JSON.stringify({ kind: 'telegram', name: 'x', agentId: 'x', token: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 422 on validation failure (missing fields)', async () => {
    const res = await app().request('/v1/channels', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ kind: 'telegram', name: 'x' }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 4xx for unknown kind', async () => {
    const agentId = seedAgent();
    const res = await app().request('/v1/channels', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ kind: 'whatsapp', name: 'x', agentId, token: 'aaaaaaaa' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe('GET /v1/channels', () => {
  it('lists connections without exposing tokens', async () => {
    const agentId = seedAgent();
    bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
    });
    const res = await app().request('/v1/channels', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connections: Array<Record<string, unknown>> };
    expect(body.connections).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('"tok"');
  });
});

describe('/v1/channels/:id/grants', () => {
  it('grants and revokes per-agent authority over a connection', async () => {
    const owner = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId: owner,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
    });
    const other = seedAgent();

    const empty = await app().request(`/v1/channels/${connection.id}/grants`, {
      headers: ctx.authHeaders,
    });
    expect(((await empty.json()) as { grants: unknown[] }).grants).toHaveLength(0);

    const granted = await app().request(`/v1/channels/${connection.id}/grants`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ agentId: other, scope: 'send' }),
    });
    expect(granted.status).toBe(201);
    const { grant } = (await granted.json()) as {
      grant: { id: string; agentId: string; status: string };
    };
    expect(grant.agentId).toBe(other);
    expect(grant.status).toBe('active');

    const listed = await app().request(`/v1/channels/${connection.id}/grants`, {
      headers: ctx.authHeaders,
    });
    expect(((await listed.json()) as { grants: unknown[] }).grants).toHaveLength(1);

    const revoked = await app().request(`/v1/channels/${connection.id}/grants/${grant.id}`, {
      method: 'DELETE',
      headers: ctx.authHeaders,
    });
    expect(revoked.status).toBe(200);
  });
});

describe('POST /v1/channels/:id/test', () => {
  it('runs read-only health checks without sending a test message', async () => {
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
      defaultChatId: '999',
    });
    const res = await app().request(`/v1/channels/${connection.id}/test`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ body: 'ping' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { health: { checks: Array<{ code: string }> } };
    expect(body.health.checks.some((check) => check.code === 'outbound_route_ready')).toBe(true);
    expect(adapter.sent).toEqual([]);
  });

  it('returns structured diagnostics when no chatId is available', async () => {
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
    });
    const res = await app().request(`/v1/channels/${connection.id}/test`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      health: { status: string; checks: Array<{ code: string }> };
    };
    expect(body.ok).toBe(false);
    expect(body.health.status).toBe('needs_action');
    expect(body.health.checks.some((check) => check.code === 'missing_default_target')).toBe(true);
  });
});

describe('GET /v1/channels/:id/health', () => {
  it('returns current health without sending a message', async () => {
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
    });
    const res = await app().request(`/v1/channels/${connection.id}/health`, {
      headers: ctx.authHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connection: { id: string };
      health: { status: string; checks: unknown[] };
    };
    expect(body.connection.id).toBe(connection.id);
    expect(body.health.status).toBe('verifying');
    expect(adapter.sent).toEqual([]);
  });
});

describe('PATCH /v1/channels/:id/targets', () => {
  it('saves a default target and aliases without exposing secrets', async () => {
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
    });
    const res = await app().request(`/v1/channels/${connection.id}/targets`, {
      method: 'PATCH',
      headers: ctx.authHeaders,
      body: JSON.stringify({ defaultChatId: '777', targetAliases: { work: '888' } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connection: { defaultChatId: string; targetAliases: Record<string, string> };
    };
    expect(body.connection.defaultChatId).toBe('777');
    expect(body.connection.targetAliases.work).toBe('888');
    expect(JSON.stringify(body)).not.toContain('tok');
  });

  it('materializes owner authority at the authenticated configuration boundary', async () => {
    bridge.setPersistentTransport(fakePersistentTransport());
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'whatsapp',
      name: 'wa owner',
    });
    const res = await app().request(`/v1/channels/${connection.id}/targets`, {
      method: 'PATCH',
      headers: ctx.authHeaders,
      body: JSON.stringify({ ownerChatId: '+55 31 7144-3148', ownerName: 'Jordan' }),
    });
    expect(res.status).toBe(200);
    expect(
      identity.principal({
        workspaceId: ctx.workspace.id,
        connectionId: connection.id,
        channelKind: 'whatsapp',
        handle: '553171443148@s.whatsapp.net',
      }),
    ).toMatchObject({ role: 'owner', verified: true, displayName: 'Jordan' });
  });
});

describe('GET /v1/channels/inbox/resolve', () => {
  it('resolves the latest direct inbound contact to an opaque recipient reference', async () => {
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg inbox',
      token: 'tok',
    });
    const peer = identity.observeAliases({
      workspaceId: ctx.workspace.id,
      connectionId: connection.id,
      channelKind: 'telegram',
      primaryHandle: '777',
      displayName: 'Latest lead',
      source: 'test',
      countMessage: true,
    });
    const conversation = new ConversationStore({ db: ctx.db, bus: ctx.bus }).getOrCreateByChannel({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      channelConnectionId: connection.id,
      channelChatId: '777',
      channelPeerIdentityId: peer.id,
    });
    new ConversationStore({ db: ctx.db, bus: ctx.bus }).appendReconciledChannelMessage({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      sessionMessageId: 'last-inbound-route',
      body: 'hello',
      participantSide: 'customer',
      occurredAt: new Date().toISOString(),
    });
    const res = await app().request(
      `/v1/channels/inbox/resolve?connectionId=${connection.id}&selector=last_inbound`,
      {
        headers: ctx.authHeaders,
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resolved: true,
      peer: { recipientRef: `peer:${peer.id}`, displayName: 'Latest lead' },
      to: '777',
    });
  });
});

describe('DELETE /v1/channels/:id', () => {
  it('removes the connection', async () => {
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
    });
    const res = await app().request(`/v1/channels/${connection.id}`, {
      method: 'DELETE',
      headers: ctx.authHeaders,
    });
    expect(res.status).toBe(200);
    expect(bridge.list(ctx.workspace.id)).toHaveLength(0);
  });

  it('returns 404 for unknown id', async () => {
    const res = await app().request(`/v1/channels/${randomUUID()}`, {
      method: 'DELETE',
      headers: ctx.authHeaders,
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/channels/:id/webhook-info', () => {
  it('returns the inbound URL without re-disclosing the one-time secret', async () => {
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
    });
    const res = await app().request(`/v1/channels/${connection.id}/webhook-info`, {
      headers: ctx.authHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.webhookSecret).toBeUndefined();
    expect(body.webhookUrl).toContain(connection.id);
  });
});

describe('POST /v1/webhooks/channel/:connectionId — unauth ingress', () => {
  it('accepts a verified inbound update without auth and acks 202', async () => {
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
    });
    const res = await app().request(`/v1/webhooks/channel/${connection.id}`, {
      method: 'POST',
      body: '{}',
      // Note: NO Authorization or workspace headers — this is the unauth path.
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);
  });

  it('returns 401 when adapter.verify rejects the signature', async () => {
    adapter.acceptVerify = false;
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
    });
    const res = await app().request(`/v1/webhooks/channel/${connection.id}`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(401);
    // Connection persisted as 'error'.
    const row = ctx.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connection.id))
      .get()!;
    expect(row.status).toBe('error');
  });

  it('returns 200 + idempotent on duplicate externalId', async () => {
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
    });
    const first = await app().request(`/v1/webhooks/channel/${connection.id}`, {
      method: 'POST',
      body: '{}',
    });
    expect(first.status).toBe(202);
    const second = await app().request(`/v1/webhooks/channel/${connection.id}`, {
      method: 'POST',
      body: '{}',
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as Record<string, unknown>;
    expect(body.idempotent).toBe(true);
  });

  it('answers Slack URL verification challenge after signature validation', async () => {
    const agentId = seedAgent();
    const signingSecret = 'slack-signing-secret';
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'slack',
      name: 'slack',
      token: 'xoxb-token',
      signingSecret,
    });
    const rawBody = JSON.stringify({ type: 'url_verification', challenge: 'challenge-123' });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
    const res = await app().request(`/v1/webhooks/channel/${connection.id}`, {
      method: 'POST',
      headers: {
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signature,
      },
      body: rawBody,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'challenge-123' });
  });
});

describe('GET /v1/webhooks/channel/:connectionId', () => {
  it('answers WhatsApp Cloud webhook verification', async () => {
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'whatsapp',
      name: 'wa cloud',
      mode: 'cloud',
      token: 'meta-access-token',
      phoneNumberId: '123456789',
      appSecret: 'meta-app-secret',
      verifyToken: 'verify-me',
    });
    const res = await app().request(
      `/v1/webhooks/channel/${connection.id}?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc123`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('abc123');
  });
});
