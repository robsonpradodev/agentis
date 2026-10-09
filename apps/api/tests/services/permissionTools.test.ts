import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerPermissionTools } from '../../src/services/agentisToolHandlers/permissions.js';
import { registerBrowserTools } from '../../src/services/agentisToolHandlers/browser.js';
import { registerChannelTools } from '../../src/services/agentisToolHandlers/channel.js';
import { decideToolApproval } from '../../src/services/chat/chatApprovalPolicy.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

describe('agentis.permissions.configure', () => {
  it('persists a conversation preference from Ask mode without self-blocking', async () => {
    const agentId = randomUUID();
    const conversationId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Agent',
      adapterType: 'http',
    }).run();
    ctx.db.insert(schema.conversations).values({
      id: conversationId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
    }).run();

    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerPermissionTools(registry, { db: ctx.db } as ToolHandlerDeps);
    const result = await registry.execute({
      id: randomUUID(),
      toolId: 'agentis.permissions.configure',
      arguments: { sensitivity: 'autonomous' },
    }, {
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      agentId,
      conversationId,
      executionMode: 'ask',
      approvalSensitivity: 'balanced',
      caller: 'chat',
    });

    expect(result.ok).toBe(true);
    const row = ctx.db.select({ sensitivity: schema.conversations.approvalSensitivity })
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conversationId))
      .get();
    expect(row?.sensitivity).toBe('autonomous');
  });

  it('allows a requested screenshot in balanced Ask mode', async () => {
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerBrowserTools(registry, {
      db: ctx.db,
      browserPool: { screenshot: async () => Buffer.from('png') },
    } as unknown as ToolHandlerDeps);

    const result = await registry.execute({
      id: randomUUID(),
      toolId: 'agentis.browser.screenshot',
      arguments: { url: 'https://example.com' },
    }, {
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      executionMode: 'ask',
      approvalSensitivity: 'balanced',
      artifactPolicy: { mode: 'none' },
      caller: 'chat',
    });

    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({ saved: false, mimeType: 'image/png' });
  });

  it('classifies ordinary channel delivery below the balanced Ask threshold', () => {
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerChannelTools(registry, { db: ctx.db } as ToolHandlerDeps);
    const definition = registry.get('agentis.channel.send');
    expect(decideToolApproval({
      name: 'agentis.channel.send',
      definition,
      permissionMode: 'ask',
      sensitivity: 'balanced',
    }).requiresApproval).toBe(false);
  });

  it('keeps an unverified channel peer inside the originating conversation', async () => {
    const deliverToConnection = vi.fn(async ({ chatId }: { chatId: string }) => ({
      provider: 'whatsapp' as const,
      providerMessageId: 'wamid-1',
      status: 'accepted' as const,
      acceptedAt: new Date().toISOString(),
      recipient: chatId,
      providerAcknowledged: true,
    }));
    const channels = {
      list: () => [{
        id: 'wa-1', kind: 'whatsapp', name: 'WA', status: 'active', agentId: null,
        defaultChatId: '5599@s.whatsapp.net', targetAliases: {}, isDefault: true,
        health: { status: 'ok' },
      }],
      defaultConnectionFor: () => 'wa-1',
      resolveDestination: ({ to }: { to?: string | null }) => ({
        chatId: to?.includes('@') ? to : `${String(to).replace(/\D/g, '')}@s.whatsapp.net`,
        source: 'explicit' as const,
      }),
      deliverToConnection,
    };
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerChannelTools(registry, { db: ctx.db, channels } as unknown as ToolHandlerDeps);
    const baseContext = {
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      executionMode: 'chat' as const,
      caller: 'chat' as const,
      channelOrigin: {
        kind: 'whatsapp', connectionId: 'wa-1', chatId: '5511@s.whatsapp.net', ownerVerified: false,
      },
    };

    const blocked = await registry.execute({
      id: randomUUID(), toolId: 'agentis.channel.send', arguments: { to: '+5522', body: 'Oi' },
    }, baseContext);
    expect(blocked).toMatchObject({ ok: false, errorCode: 'CONNECTION_SCOPE_MISSING' });
    expect(deliverToConnection).not.toHaveBeenCalled();

    const current = await registry.execute({
      id: randomUUID(), toolId: 'agentis.channel.send', arguments: { body: 'Reply' },
    }, baseContext);
    expect(current.ok).toBe(true);
    expect(deliverToConnection).toHaveBeenCalledWith(expect.objectContaining({ chatId: '5511@s.whatsapp.net' }));
  });

  it('lets an explicitly linked owner use an explicit third-party recipient', async () => {
    const deliverToConnection = vi.fn(async ({ chatId }: { chatId: string }) => ({
      provider: 'whatsapp' as const,
      providerMessageId: 'wamid-owner',
      status: 'accepted' as const,
      acceptedAt: new Date().toISOString(),
      recipient: chatId,
      providerAcknowledged: true,
    }));
    const channels = {
      list: () => [{
        id: 'wa-1', kind: 'whatsapp', name: 'WA', status: 'active', agentId: null,
        defaultChatId: '5511@s.whatsapp.net', targetAliases: {}, isDefault: true,
        health: { status: 'ok' },
      }],
      defaultConnectionFor: () => 'wa-1',
      resolveDestination: ({ to }: { to?: string | null }) => ({
        chatId: `${String(to).replace(/\D/g, '')}@s.whatsapp.net`, source: 'explicit' as const,
      }),
      deliverToConnection,
    };
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerChannelTools(registry, { db: ctx.db, channels } as unknown as ToolHandlerDeps);
    const ownerContext = {
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      executionMode: 'chat' as const,
      caller: 'chat' as const,
      channelOrigin: {
        kind: 'whatsapp', connectionId: 'wa-1', chatId: '5511@s.whatsapp.net', ownerVerified: true,
        explicitRecipients: ['5522@s.whatsapp.net'],
      },
    };
    const missingRecipient = await registry.execute({
      id: randomUUID(), toolId: 'agentis.channel.send', arguments: { body: 'Oi' },
    }, ownerContext);
    expect(missingRecipient).toMatchObject({ ok: false, errorCode: 'VALIDATION_FAILED' });
    expect(deliverToConnection).not.toHaveBeenCalled();

    const result = await registry.execute({
      id: randomUUID(), toolId: 'agentis.channel.send', arguments: { to: '+5522', body: 'Oi' },
    }, ownerContext);

    expect(result.ok).toBe(true);
    expect(deliverToConnection).toHaveBeenCalledWith(expect.objectContaining({ chatId: '5522@s.whatsapp.net' }));
  });

  it('binds a raw-number owner action to the target peer instead of the owner conversation', async () => {
    const createAndExecute = vi.fn(async (input: Record<string, unknown>) => ({
      result: {
        sent: true,
        connectionId: input.connectionId,
        to: '15551234567@s.whatsapp.net',
        receipt: { providerMessageId: 'wamid-target', status: 'accepted', providerAcknowledged: true },
      },
      action: { id: 'action-target', status: 'delivered' },
    }));
    const channels = {
      list: () => [{
        id: 'wa-1', kind: 'whatsapp', name: 'Ava WhatsApp', status: 'active', agentId: 'sample-1',
        defaultChatId: '15559876543@s.whatsapp.net', targetAliases: {}, isDefault: true,
        health: { status: 'ok' },
      }],
      get: () => ({ id: 'wa-1', kind: 'whatsapp', agentId: 'sample-1' }),
      defaultConnectionFor: () => 'wa-1',
      resolveDestination: ({ to }: { to?: string | null }) => ({
        chatId: `${String(to).replace(/\D/g, '')}@s.whatsapp.net`, source: 'explicit' as const,
      }),
    };
    const channelInbox = {
      ensurePeer: vi.fn(() => ({
        recipientRef: 'peer:target', peerIdentityId: 'target', connectionId: 'wa-1',
        channelKind: 'whatsapp', conversationId: null, subjectId: null,
      })),
    };
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerChannelTools(registry, {
      db: ctx.db,
      channels,
      channelInbox,
      channelActions: { createAndExecute },
    } as unknown as ToolHandlerDeps);

    const result = await registry.execute({
      id: randomUUID(),
      toolId: 'agentis.channel.send',
      arguments: { to: '+15551234567', body: 'oi', goal: 'Send the owner-requested greeting' },
    }, {
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      agentId: 'sample-1',
      missionId: 'mission-1',
      executionMode: 'chat',
      caller: 'chat',
      channelOrigin: {
        kind: 'whatsapp', connectionId: 'wa-1', chatId: '15559876543@s.whatsapp.net',
        conversationId: 'owner-conversation', ownerVerified: true,
        explicitRecipients: ['15551234567@s.whatsapp.net'],
      },
    });

    expect(result.ok).toBe(true);
    expect(createAndExecute).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: 'wa-1',
      recipientRef: 'peer:target',
      conversationId: null,
      authorizationBasis: 'verified_owner_command',
      missionId: 'mission-1',
    }));
  });

  it('retains media when an owner sends through a resolved recipient reference', async () => {
    const createAndExecute = vi.fn(async (input: Record<string, unknown>) => ({
      result: { sent: true, verified: true, connectionId: input.connectionId, to: '15551234567@s.whatsapp.net' },
      action: { id: 'action-media', status: 'delivered' },
    }));
    const channels = {
      get: () => ({ id: 'wa-1', kind: 'whatsapp', agentId: 'sample-1' }),
    };
    const channelInbox = {
      resolve: vi.fn(() => ({
        resolved: true,
        to: '15551234567@s.whatsapp.net',
        peer: {
          recipientRef: 'peer:target', peerIdentityId: 'target', connectionId: 'wa-1',
          channelKind: 'whatsapp', conversationId: 'target-conversation', subjectId: 'lead-1',
        },
      })),
    };
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerChannelTools(registry, {
      db: ctx.db,
      channels,
      channelInbox,
      channelActions: { createAndExecute },
    } as unknown as ToolHandlerDeps);

    const result = await registry.execute({
      id: randomUUID(),
      toolId: 'agentis.channel.send',
      arguments: {
        connectionId: 'wa-1',
        recipientRef: 'peer:target',
        body: 'Aqui está a imagem.',
        attachments: [{ artifactId: 'asset-1', kind: 'image', filename: 'acme.png' }],
        goal: 'Send the requested existing Acme image',
      },
    }, {
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      agentId: 'sample-1',
      missionId: 'mission-media',
      executionMode: 'chat',
      caller: 'chat',
      channelOrigin: {
        kind: 'whatsapp', connectionId: 'wa-1', chatId: '15559876543@s.whatsapp.net',
        ownerVerified: true,
      },
    });

    expect(result.ok).toBe(true);
    expect(createAndExecute).toHaveBeenCalledWith(expect.objectContaining({
      body: '',
      recipientRef: 'peer:target',
      messages: [{
        body: 'Aqui está a imagem.',
        attachments: [{ artifactId: 'asset-1', kind: 'image', filename: 'acme.png' }],
      }],
      authorizationBasis: 'verified_owner_command',
    }));
  });
});
