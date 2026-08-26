/**
 * /v1/channels — channel-bridge connections (Telegram/Discord/...).
 *
 *   GET    /                  list connections
 *   POST   /                  create connection (token encrypted via vault)
 *   DELETE /:id               remove connection
 *   POST   /:id/test          run read-only credential/transport/route checks
 *   GET    /:id/webhook-info  return inbound webhook URL
 *
 * Tokens are NEVER returned in responses. The webhook secret is returned ONLY
 * in the POST create response.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { AgentisError } from '@agentis/core';
import type { AuthService } from '../services/auth.js';
import type { ChannelBridge } from '../services/conversation/channelBridge.js';
import { resolveAndSend } from '../services/conversation/channelSend.js';
import type { ChannelConnectionSupervisor } from '../services/conversation/channelConnectionSupervisor.js';
import type { ChannelIdentityService } from '../services/conversation/channelIdentityService.js';
import type { ConnectionGrantService } from '../services/connectionGrants.js';
import type { ChannelInboxService } from '../services/conversation/channelInboxService.js';
import type { ChannelActionIntentService } from '../services/conversation/channelActionIntentService.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const createSchema = z
  .object({
    // WhatsApp QR is tokenless; WhatsApp Cloud and the others are token/API based.
    kind: z.enum(['telegram', 'discord', 'slack', 'whatsapp', 'voice']),
    name: z.string().min(1).max(120),
    /** Owning agent, or omit/null for a workspace-owned (global) connection. */
    agentId: z.string().min(1).nullish(),
    token: z.string().min(8).max(4096).optional(),
    defaultChatId: z.string().min(1).max(120).optional(),
    ownerChatId: z.string().min(1).max(120).optional(),
    ownerName: z.string().min(1).max(120).optional(),
    defaultRecipient: z.string().min(1).max(120).optional(),
    mode: z.enum(['qr_local', 'cloud']).optional(),
    signingSecret: z.string().min(8).max(4096).optional(),
    phoneNumberId: z.string().min(1).max(120).optional(),
    appSecret: z.string().min(8).max(4096).optional(),
    verifyToken: z.string().min(4).max(512).optional(),
    runInitialTest: z.boolean().optional(),
    // Persistent transports: Telegram 'polling' (long-poll), Discord 'gateway'
    // (live message events) — both avoid a public webhook.
    transport: z.enum(['polling', 'webhook', 'gateway']).optional(),
    ambientId: z.string().nullish(),
  })
  .refine((v) => (v.kind === 'whatsapp' && v.mode !== 'cloud') || v.kind === 'voice' || Boolean(v.token), {
    message: 'token is required for this channel kind',
    path: ['token'],
  })
  .refine((v) => v.kind !== 'whatsapp' || v.mode !== 'cloud' || Boolean(v.phoneNumberId && v.appSecret && v.verifyToken), {
    message: 'WhatsApp Cloud requires phoneNumberId, appSecret, and verifyToken',
    path: ['mode'],
  });

const linkSchema = z.object({
  connectionId: z.string().min(1).nullish(),
  channelKind: z.enum(['telegram', 'discord', 'slack', 'whatsapp']),
  handle: z.string().min(1).max(256),
  /** Null unlinks the handle from any workspace user. */
  userId: z.string().min(1).nullish(),
});

const blockSchema = z.object({
  connectionId: z.string().min(1).nullish(),
  channelKind: z.enum(['telegram', 'discord', 'slack', 'whatsapp']),
  handle: z.string().min(1).max(256),
  blocked: z.boolean(),
});

const defaultSchema = z.object({ default: z.boolean().optional() });

const behaviorSchema = z.object({
  persona: z.enum(['instant', 'human', 'warm']).optional(),
  rateLimit: z
    .object({ perMinute: z.number().nullable().optional(), perDay: z.number().nullable().optional() })
    .nullable()
    .optional(),
  requireOptIn: z.boolean().optional(),
  startWarmup: z.boolean().optional(),
  ownerReasoningVisibility: z.enum(['off', 'indicator']).optional(),
  manualOutboundTakeover: z.enum(['until_handback', 'off']).optional(),
  ownerManualOutboundTakeover: z.enum(['until_handback', 'off']).optional(),
  historyReconciliation: z.enum(['recent', 'off']).optional(),
});

const authoritySchema = z.object({
  connectionId: z.string().min(1),
  channelKind: z.enum(['telegram', 'discord', 'slack', 'whatsapp']),
  handle: z.string().min(1).max(256),
  role: z.enum(['owner', 'delegate']),
  expiresAt: z.string().datetime().nullish(),
});

const sendAttachmentSchema = z.object({
  url: z.string().optional(),
  artifactId: z.string().optional(),
  filename: z.string().optional(),
  mimeType: z.string().optional(),
  kind: z.enum(['image', 'video', 'audio', 'voice', 'sticker', 'file']).optional(),
  caption: z.string().optional(),
});
const operatorSendSchema = z.object({
  to: z.string().optional(),
  body: z.string().optional(),
  attachments: z.array(sendAttachmentSchema).optional(),
  messages: z.array(z.object({ body: z.string().optional(), attachments: z.array(sendAttachmentSchema).optional() })).optional(),
});

const grantSchema = z.object({
  agentId: z.string().min(1),
  scope: z.enum(['read', 'send', 'manage']).optional(),
  expiresAt: z.string().nullish(),
});

const testSchema = z.object({
  chatId: z.string().min(1).max(120).optional(),
  body: z.string().min(1).max(2048).optional(),
});

const accessSchema = z
  .object({
    recipients: z
      .array(
        z.object({
          handle: z.string().min(1).max(256),
          name: z.string().max(120).optional(),
          rules: z.string().max(4000).optional(),
        }),
      )
      .max(200)
      .optional(),
    answerAnyone: z.boolean().optional(),
    anyoneRules: z.string().max(4000).optional(),
    unknownReply: z.enum(['ignore', 'decline']).optional(),
  })
  .nullable()
  .optional();

const targetSchema = z.object({
  defaultChatId: z.string().min(1).max(120).nullable().optional(),
  ownerChatId: z.string().min(1).max(120).nullable().optional(),
  ownerName: z.string().min(1).max(120).nullable().optional(),
  targetAliases: z.record(z.string().min(1).max(80), z.string().min(1).max(120).nullable()).optional(),
  access: accessSchema,
});

const actionCreateSchema = z.object({
  agentId: z.string().min(1),
  connectionId: z.string().min(1),
  recipientRef: z.string().min(1),
  appId: z.string().nullish(),
  subjectId: z.string().nullish(),
  goalRef: z.string().nullish(),
  goal: z.string().min(1).max(4000),
  body: z.string().max(20_000).optional(),
  messages: z.array(z.object({ body: z.string().max(20_000).optional() })).optional(),
  scheduledFor: z.string().datetime().nullish(),
  requireApproval: z.boolean().optional(),
});

export function buildChannelRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  bridge: ChannelBridge;
  /** Persistent-transport supervisor (WhatsApp). Optional — absent in some tests. */
  supervisor?: ChannelConnectionSupervisor;
  /** Cross-surface peer identity. Optional — absent in some tests. */
  identity?: ChannelIdentityService;
  inbox?: ChannelInboxService;
  actions?: ChannelActionIntentService;
  /** §3.3 per-agent connection authority. Optional — absent in some tests. */
  connectionGrants?: ConnectionGrantService;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    return c.json({ connections: deps.bridge.list(ws.workspaceId) });
  });

  // ── Cross-surface peer identity (§5.2) ───────────────────
  app.get('/identities', (c) => {
    const ws = getWorkspace(c);
    if (!deps.identity) return c.json({ identities: [] });
    return c.json({ identities: deps.identity.list(ws.workspaceId) });
  });

  app.post('/identities/link', async (c) => {
    const ws = getWorkspace(c);
    if (!deps.identity) throw new AgentisError('RESOURCE_NOT_FOUND', 'identity service not available');
    const body = linkSchema.parse(await c.req.json());
    const linked = deps.identity.link({
      workspaceId: ws.workspaceId,
      channelKind: body.channelKind,
      connectionId: body.connectionId ?? null,
      handle: body.handle,
      userId: body.userId ?? null,
    });
    if (!linked) throw new AgentisError('RESOURCE_NOT_FOUND', 'peer identity not found');
    return c.json({ identity: linked });
  });

  app.post('/identities/authority', async (c) => {
    const ws = getWorkspace(c);
    if (!deps.identity) throw new AgentisError('RESOURCE_NOT_FOUND', 'identity service not available');
    const body = authoritySchema.parse(await c.req.json());
    deps.bridge.get(ws.workspaceId, body.connectionId);
    const identity = deps.identity.grantAuthority({
      workspaceId: ws.workspaceId,
      connectionId: body.connectionId,
      channelKind: body.channelKind,
      handle: body.handle,
      role: body.role,
      userId: body.role === 'owner' ? ws.user.id : null,
      method: 'operator_grant',
      expiresAt: body.expiresAt ?? null,
    });
    return c.json({ identity });
  });

  app.delete('/identities/:identityId/authority', (c) => {
    const ws = getWorkspace(c);
    if (!deps.identity) throw new AgentisError('RESOURCE_NOT_FOUND', 'identity service not available');
    const identity = deps.identity.revokeAuthority({ workspaceId: ws.workspaceId, identityId: c.req.param('identityId') });
    if (!identity) throw new AgentisError('RESOURCE_NOT_FOUND', 'peer identity not found');
    return c.json({ identity });
  });

  app.post('/identities/block', async (c) => {
    const ws = getWorkspace(c);
    if (!deps.identity) throw new AgentisError('RESOURCE_NOT_FOUND', 'identity service not available');
    const body = blockSchema.parse(await c.req.json());
    const identity = deps.identity.setBlocked({
      workspaceId: ws.workspaceId,
      channelKind: body.channelKind,
      connectionId: body.connectionId ?? null,
      handle: body.handle,
      blocked: body.blocked,
    });
    return c.json({ identity });
  });

  app.get('/inbox', (c) => {
    const ws = getWorkspace(c);
    if (!deps.inbox) throw new AgentisError('RESOURCE_NOT_FOUND', 'channel inbox is not available');
    const limit = Number(c.req.query('limit') ?? 20);
    return c.json(deps.inbox.list({
      workspaceId: ws.workspaceId,
      connectionId: c.req.query('connectionId') ?? null,
      query: c.req.query('query') ?? null,
      excludeOwner: c.req.query('includeOwner') !== 'true',
      limit: Number.isFinite(limit) ? limit : 20,
      cursor: c.req.query('cursor') ?? null,
    }));
  });

  app.get('/inbox/resolve', (c) => {
    const ws = getWorkspace(c);
    if (!deps.inbox) throw new AgentisError('RESOURCE_NOT_FOUND', 'channel inbox is not available');
    const selector = c.req.query('selector');
    const result = deps.inbox.resolve({
      workspaceId: ws.workspaceId,
      connectionId: c.req.query('connectionId') ?? null,
      recipientRef: c.req.query('recipientRef') ?? null,
      conversationId: c.req.query('conversationId') ?? null,
      ...(selector === 'last_inbound' || selector === 'last_contact' ? { selector } : {}),
      query: c.req.query('query') ?? null,
    });
    return c.json(result, result.resolved ? 200 : 404);
  });

  app.get('/inbox/:recipientRef', (c) => {
    const ws = getWorkspace(c);
    if (!deps.inbox) throw new AgentisError('RESOURCE_NOT_FOUND', 'channel inbox is not available');
    const ref = decodeURIComponent(c.req.param('recipientRef'));
    const peer = deps.inbox.get(ws.workspaceId, ref);
    if (!peer) throw new AgentisError('RESOURCE_NOT_FOUND', 'channel recipient not found');
    const limit = Number(c.req.query('limit') ?? 30);
    return c.json({ peer, messages: deps.inbox.history(ws.workspaceId, ref, Number.isFinite(limit) ? limit : 30) });
  });

  app.get('/actions', (c) => {
    const ws = getWorkspace(c);
    if (!deps.actions) throw new AgentisError('RESOURCE_NOT_FOUND', 'channel action engine is not available');
    return c.json({ actions: deps.actions.list(ws.workspaceId, {
      ...(c.req.query('connectionId') ? { connectionId: c.req.query('connectionId') } : {}),
      ...(c.req.query('status') ? { status: c.req.query('status') as never } : {}),
      limit: Number(c.req.query('limit') ?? 30),
    }) });
  });

  app.post('/actions', async (c) => {
    const ws = getWorkspace(c);
    if (!deps.actions) throw new AgentisError('RESOURCE_NOT_FOUND', 'channel action engine is not available');
    const body = actionCreateSchema.parse(await c.req.json());
    const result = await deps.actions.createAndExecute({
      workspaceId: ws.workspaceId,
      appId: body.appId ?? null,
      agentId: body.agentId,
      connectionId: body.connectionId,
      recipientRef: body.recipientRef,
      subjectId: body.subjectId ?? null,
      goalRef: body.goalRef ?? null,
      goal: body.goal,
      body: body.body ?? '',
      messages: body.messages,
      // This endpoint is authenticated operator control, not an unsupervised
      // model action. The durable intent still records who/what/where was sent.
      authorizationBasis: 'verified_owner_command',
      scheduledFor: body.scheduledFor ?? null,
      requireApproval: body.requireApproval,
      userId: ws.user.id,
    });
    return c.json(result, result.action.status === 'delivered' ? 200 : 202);
  });

  app.post('/actions/:actionId/cancel', async (c) => {
    const ws = getWorkspace(c);
    if (!deps.actions) throw new AgentisError('RESOURCE_NOT_FOUND', 'channel action engine is not available');
    const payload = await c.req.json().catch(() => ({})) as { reason?: unknown };
    return c.json({ action: deps.actions.cancel(ws.workspaceId, c.req.param('actionId'), typeof payload.reason === 'string' ? payload.reason : 'cancelled by operator') });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = createSchema.parse(await c.req.json());
    const input: Parameters<ChannelBridge['create']>[0] = {
      workspaceId: ws.workspaceId,
      ambientId: body.ambientId ?? null,
      userId: ws.user.id,
      agentId: body.agentId,
      kind: body.kind,
      name: body.name,
    };
    if (body.token) input.token = body.token;
    if (body.defaultChatId) input.defaultChatId = body.defaultChatId;
    if (body.ownerChatId) input.ownerChatId = body.ownerChatId;
    if (body.ownerName) input.ownerName = body.ownerName;
    if (body.defaultRecipient) input.defaultRecipient = body.defaultRecipient;
    if (body.transport) input.transport = body.transport;
    if (body.mode) input.mode = body.mode;
    if (body.signingSecret) input.signingSecret = body.signingSecret;
    if (body.phoneNumberId) input.phoneNumberId = body.phoneNumberId;
    if (body.appSecret) input.appSecret = body.appSecret;
    if (body.verifyToken) input.verifyToken = body.verifyToken;
    const { connection, webhookSecret } = deps.bridge.create(input);
    const shouldRunInitialTest = body.runInitialTest ?? !(body.kind === 'whatsapp' && body.mode !== 'cloud');
    const health = shouldRunInitialTest
      ? await deps.bridge.test({
          workspaceId: ws.workspaceId,
          id: connection.id,
          ...(body.defaultChatId || body.defaultRecipient ? { chatId: body.defaultChatId ?? body.defaultRecipient } : {}),
        })
      : deps.bridge.health(ws.workspaceId, connection.id);
    const refreshed = deps.bridge.get(ws.workspaceId, connection.id);
    return c.json(
      {
        connection: refreshed,
        health,
        webhookSecret,
        // WhatsApp links via QR (POST /:id/login); the others ingest via webhook.
        ...(refreshed.kind === 'whatsapp' && refreshed.mode !== 'cloud'
          ? { loginUrl: `/v1/channels/${connection.id}/login` }
          : { webhookUrl: `/v1/webhooks/channel/${connection.id}` }),
      },
      201,
    );
  });

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    deps.bridge.delete(ws.workspaceId, c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── WhatsApp QR login (persistent transport) ─────────────
  // POST starts/refreshes the login and returns the current QR; GET polls state.
  app.post('/:id/login', async (c) => {
    const ws = getWorkspace(c);
    const conn = deps.bridge.get(ws.workspaceId, c.req.param('id')); // 404s if missing
    if (conn.kind !== 'whatsapp') {
      throw new AgentisError('VALIDATION_FAILED', `channel kind '${conn.kind}' does not use QR login`);
    }
    if (!deps.supervisor) {
      throw new AgentisError('CHANNEL_KIND_UNAVAILABLE', 'WhatsApp transport is not available on this server');
    }
    const state = await deps.supervisor.startLogin(conn.id);
    return c.json({ connectionId: conn.id, ...state });
  });

  app.get('/:id/login', (c) => {
    const ws = getWorkspace(c);
    const conn = deps.bridge.get(ws.workspaceId, c.req.param('id')); // 404s if missing
    if (conn.kind !== 'whatsapp') {
      throw new AgentisError('VALIDATION_FAILED', `channel kind '${conn.kind}' does not use QR login`);
    }
    if (!deps.supervisor) {
      throw new AgentisError('CHANNEL_KIND_UNAVAILABLE', 'WhatsApp transport is not available on this server');
    }
    return c.json({ connectionId: conn.id, ...deps.supervisor.loginState(conn.id) });
  });

  app.post('/:id/test', async (c) => {
    const ws = getWorkspace(c);
    let parsed: { chatId?: string; body?: string } = {};
    try {
      parsed = testSchema.parse(await c.req.json());
    } catch {
      // empty body is allowed; falls through to defaults
    }
    const args: Parameters<ChannelBridge['test']>[0] = {
      workspaceId: ws.workspaceId,
      id: c.req.param('id'),
    };
    if (parsed.chatId) args.chatId = parsed.chatId;
    if (parsed.body) args.body = parsed.body;
    const health = await deps.bridge.test(args);
    return c.json({ ok: health.status === 'active', health });
  });

  app.patch('/:id/targets', async (c) => {
    const ws = getWorkspace(c);
    const body = targetSchema.parse(await c.req.json());
    const connection = deps.bridge.updateTargets(ws.workspaceId, c.req.param('id'), body);
    return c.json({ connection, health: connection.health });
  });

  // Designate (or clear) the workspace DEFAULT connection for its kind — the one
  // deterministic sends (the `channel` workflow node / agentis.channel.send by
  // kind) use when several connections of that kind exist.
  app.post('/:id/default', async (c) => {
    const ws = getWorkspace(c);
    const body = defaultSchema.parse(await c.req.json().catch(() => ({})));
    const connection = deps.bridge.setDefault(ws.workspaceId, c.req.param('id'), body.default ?? true);
    return c.json({ connection });
  });

  // ── Per-agent authority over this connection (§3.3) ──────
  // A connection with zero grant rows is OPEN (any agent may send). Issuing the
  // first grant flips it to default-deny — only the owner + granted agents may
  // use it. This is what lets a workspace/global connection be restricted to a
  // chosen set of agents instead of staying open to the whole workspace.
  app.get('/:id/grants', (c) => {
    const ws = getWorkspace(c);
    if (!deps.connectionGrants) return c.json({ grants: [] });
    const id = c.req.param('id');
    deps.bridge.get(ws.workspaceId, id); // 404s if missing
    return c.json({ grants: deps.connectionGrants.list(ws.workspaceId, id) });
  });

  app.post('/:id/grants', async (c) => {
    const ws = getWorkspace(c);
    if (!deps.connectionGrants) throw new AgentisError('CONNECTION_GRANTS_UNAVAILABLE', 'connection grant service not configured');
    const id = c.req.param('id');
    deps.bridge.get(ws.workspaceId, id); // 404s if missing
    const body = grantSchema.parse(await c.req.json());
    const grant = deps.connectionGrants.grant({
      workspaceId: ws.workspaceId,
      connectionKind: 'channel',
      connectionId: id,
      agentId: body.agentId,
      scope: body.scope ?? 'send',
      grantedBy: ws.user.id,
      expiresAt: body.expiresAt ?? null,
    });
    return c.json({ grant }, 201);
  });

  app.delete('/:id/grants/:grantId', (c) => {
    const ws = getWorkspace(c);
    if (!deps.connectionGrants) throw new AgentisError('CONNECTION_GRANTS_UNAVAILABLE', 'connection grant service not configured');
    deps.connectionGrants.revoke(ws.workspaceId, c.req.param('grantId'));
    return c.json({ ok: true });
  });

  app.get('/:id/health', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const connection = deps.bridge.get(ws.workspaceId, id);
    return c.json({ connection, health: deps.bridge.health(ws.workspaceId, id) });
  });

  // What this channel can send (media kinds, reactions, presence, …) — drives
  // the cockpit composer affordances and lets clients degrade gracefully.
  app.get('/:id/capabilities', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    deps.bridge.get(ws.workspaceId, id); // 404s if missing
    const capabilities = deps.bridge.capabilitiesFor(id);
    if (!capabilities) throw new AgentisError('RESOURCE_NOT_FOUND', `channel connection ${id} not found`);
    return c.json({ capabilities });
  });

  // Human-like persona (§6) + anti-ban rails (§7) for a connection.
  app.patch('/:id/behavior', async (c) => {
    const ws = getWorkspace(c);
    const body = behaviorSchema.parse(await c.req.json());
    const connection = deps.bridge.updateBehavior(ws.workspaceId, c.req.param('id'), body);
    return c.json({ connection });
  });

  // Operator composer — send AS this channel identity to an end-user from the
  // cockpit. Bypasses the §7 rails because it is a deliberate, audited human send.
  app.post('/:id/send', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    deps.bridge.get(ws.workspaceId, id); // 404s if missing
    const body = operatorSendSchema.parse(await c.req.json());
    const result = await resolveAndSend(
      { channels: deps.bridge, ...(deps.connectionGrants ? { connectionGrants: deps.connectionGrants } : {}) },
      {
        workspaceId: ws.workspaceId,
        connectionId: id,
        body: body.body ?? '',
        to: body.to ?? null,
        agentId: null,
        bypassGuards: true,
        actor: 'human',
        ...(body.attachments ? { attachments: body.attachments } : {}),
        ...(body.messages ? { messages: body.messages } : {}),
      },
    );
    return c.json({ result }, result.sent ? 200 : 422);
  });

  app.get('/:id/webhook-info', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const conn = deps.bridge.get(ws.workspaceId, id); // 404s if missing
    return c.json({
      connection: conn,
      webhookUrl: `/v1/webhooks/channel/${id}`,
    });
  });

  return app;
}
