import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { WorkflowGraph } from '@agentis/core';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerInspectTools } from '../../src/services/agentisToolHandlers/inspect.js';
import { registerBuildTools } from '../../src/services/agentisToolHandlers/build.js';
import { registerCapabilityTools } from '../../src/services/agentisToolHandlers/capability.js';
import { registerChannelTools } from '../../src/services/agentisToolHandlers/channel.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { ChannelBridge } from '../../src/services/conversation/channelBridge.js';
import type { PersistentChannelTransport } from '../../src/services/conversation/channelBridge.js';
import { ConversationStore } from '../../src/services/conversation/conversationStore.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { WorkflowRevisionService } from '../../src/services/workflow/workflowRevisionService.js';
import { bindWorkflowRevisionApproval } from '../../src/services/workflow/workflowRevisionApproval.js';
import { ArtifactService } from '../../src/services/artifactService.js';
import type { ChannelAdapter, ParsedInboundMessage } from '../../src/adapters/channels/types.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
const componentRoots: string[] = [];

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => {
  ctx.close();
  for (const root of componentRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.AGENTIS_DATA_DIR;
});

function deps(): ToolHandlerDeps {
  return {
    db: ctx.db,
    logger: ctx.logger,
    bus: ctx.bus,
    engine: {} as ToolHandlerDeps['engine'],
    adapters: { get: () => undefined } as unknown as ToolHandlerDeps['adapters'],
    ledger: { listForRun: async () => [] } as unknown as ToolHandlerDeps['ledger'],
    scratchpad: {} as ToolHandlerDeps['scratchpad'],
    approvals: { list: () => [] } as unknown as ToolHandlerDeps['approvals'],
    activity: {} as ToolHandlerDeps['activity'],
    replay: {} as ToolHandlerDeps['replay'],
  };
}

function toolContext(agentId?: string) {
  return {
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    caller: 'test',
    ...(agentId ? { agentId } : {}),
  };
}

function seedSkill(overrides: Partial<typeof schema.extensions.$inferInsert> = {}) {
  const id = randomUUID();
  ctx.db.insert(schema.extensions).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    packageId: null,
    name: 'http_fetch',
    slug: 'http_fetch',
    version: '1.0.0',
    runtime: 'builtin',
    manifest: {
      name: 'http_fetch',
      slug: 'http_fetch',
      version: '1.0.0',
      runtime: 'builtin',
      entrypoint: 'http_fetch',
      capabilityTags: ['builtin', 'http'],
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      outputSchema: { type: 'object' },
    },
    ...overrides,
  }).run();
  return id;
}

class StubTelegramAdapter implements ChannelAdapter {
  readonly kind = 'telegram' as const;
  readonly sent: Array<{ chatId: string; body: string }> = [];
  async send(args: { chatId: string; body: string }) {
    this.sent.push({ chatId: args.chatId, body: args.body });
    return {
      provider: 'telegram' as const,
      providerMessageId: `telegram-test-${this.sent.length}`,
      status: 'accepted' as const,
      acceptedAt: new Date().toISOString(),
      recipient: args.chatId,
    };
  }
  verify(): boolean { return true; }
  parseInbound(): ParsedInboundMessage | null { return null; }
}

function stubPersistentTransport(sent: Array<{ connectionId: string; chatId: string; body: string }>): PersistentChannelTransport {
  return {
    handles: (conn) => conn.kind === 'whatsapp',
    requiresNoToken: (kind) => kind === 'whatsapp',
    status: () => ({ status: 'open' }),
    send: async (connectionId, chatId, body) => {
      sent.push({ connectionId, chatId, body });
      return {
        provider: 'whatsapp' as const,
        providerMessageId: `whatsapp-test-${sent.length}`,
        status: 'accepted' as const,
        acceptedAt: new Date().toISOString(),
        recipient: chatId,
      };
    },
  };
}

function seedAgent() {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    name: 'Orchestrator',
    adapterType: 'http',
  }).run();
  return id;
}

describe('agent-facing skill tools', () => {
  it('lists workspace skills with real IDs and schemas', async () => {
    const skillId = seedSkill();
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerInspectTools(registry, deps());

    const result = await registry.execute({
      toolId: 'agentis.skills.list',
      arguments: { query: 'http', runtime: 'builtin' },
    }, toolContext());

    expect(result.ok).toBe(true);
    const output = result.output as { extensions: Array<{ id: string; slug: string; runtime: string; capabilityTags: string[] }> };
    expect(output.extensions).toEqual([
      expect.objectContaining({
        id: skillId,
        slug: 'http_fetch',
        runtime: 'builtin',
        capabilityTags: expect.arrayContaining(['http']),
      }),
    ]);
  });

  it('inspects a skill by slug before workflow wiring', async () => {
    const skillId = seedSkill();
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerInspectTools(registry, deps());

    const result = await registry.execute({
      toolId: 'agentis.skill.inspect',
      arguments: { slug: 'http_fetch' },
    }, toolContext());

    expect(result.ok).toBe(true);
    const output = result.output as { found: boolean; usableInWorkflows: boolean; skill: { id: string; capabilityTags: string[] } };
    expect(output.found).toBe(true);
    expect(output.usableInWorkflows).toBe(true);
    expect(output.skill.id).toBe(skillId);
    expect(output.skill.capabilityTags).toContain('http');
  });
});

describe('agent-facing capability authoring tools', () => {
  it('resolves an installed listener capability before creation', async () => {
    const extensionId = seedSkill({
      name: 'AI News Site Monitor',
      slug: 'ai_news_site_monitor',
      runtime: 'node_worker',
      manifest: {
        name: 'AI News Site Monitor',
        slug: 'ai_news_site_monitor',
        version: '1.0.0',
        runtime: 'node_worker',
        entrypoint: 'ai_news_site_monitor.js',
        description: 'Monitors an AI news site for new posts.',
        capabilityTags: ['listener', 'monitoring', 'ai-news'],
        permissions: ['network', 'listener', 'listener.emit'],
        operations: [{
          name: 'fetchRecentPosts',
          inputSchema: {},
          outputSchema: {},
          isListenerSource: true,
        }],
      },
    });
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerCapabilityTools(registry, deps());

    const result = await registry.execute({
      toolId: 'agentis.extension.resolve',
      arguments: {
        query: 'AI News Site Monitor',
        requiresListenerSource: true,
        capabilityTags: ['monitoring', 'ai-news'],
      },
    }, toolContext());

    expect(result.ok).toBe(true);
    expect(result.output).toEqual(expect.objectContaining({
      recommendation: 'reuse',
      selectedExtensionId: extensionId,
      candidates: [
        expect.objectContaining({
          extensionId,
          reusable: true,
          listenerOperations: ['fetchRecentPosts'],
        }),
      ],
    }));
  });

  // NOTE: the "reusable ability from intent" test was removed 2026-07-05 — the
  // Abilities subsystem (agentis.ability.create + ToolHandlerDeps.abilityCreation)
  // was deleted wholesale on 2026-07-04 in favor of Living Skills in the Brain
  // (SKILL.md materializer + brain skill/example atoms), which has its own tests.

  it('creates a listener extension and returns its real executable ID', async () => {
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    const createCalls: unknown[] = [];
    const toolDeps = deps();
    toolDeps.extensionLibrary = {
      createNodeWorkerExtension: async (scope: unknown, input: unknown) => {
        createCalls.push({ scope, input });
        return {
          id: 'extension_1',
          path: 'extensions/social-listener.md',
          manifest: {
            name: 'Social Listener',
            slug: 'social-listener',
            runtime: 'node_worker',
            operations: [{ name: 'listen' }],
          },
        };
      },
    } as ToolHandlerDeps['extensionLibrary'];
    registerCapabilityTools(registry, toolDeps);

    const result = await registry.execute({
      toolId: 'agentis.extension.create',
      arguments: {
        name: 'Social Listener',
        source: 'export async function listen(input, ctx) { await ctx.emit(input); }',
        permissions: ['listener', 'listener.emit', 'root'],
        operations: [{
          name: 'listen',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          isListenerSource: true,
        }],
      },
    }, toolContext());

    expect(result.ok).toBe(true);
    expect(createCalls).toEqual([expect.objectContaining({
      scope: expect.objectContaining({ workspaceId: ctx.workspace.id, userId: ctx.user.id }),
      input: expect.objectContaining({
        name: 'Social Listener',
        permissions: ['listener', 'listener.emit'],
      }),
    })]);
    expect(result.output).toEqual(expect.objectContaining({
      extensionId: 'extension_1',
      operations: ['listen'],
    }));
  });

  it('upgrades a node_worker extension to a persisted Component bundle in place', async () => {
    const extensionId = seedSkill({
      name: 'Prospect Search',
      slug: 'prospect-search',
      runtime: 'node_worker',
      version: '1.0.0',
      manifest: {
        name: 'Prospect Search', slug: 'prospect-search', version: '1.0.0', runtime: 'node_worker',
        source: 'async function search() { return {}; }', operations: [{ name: 'search', inputSchema: {}, outputSchema: {} }],
        permissions: [], capabilityTags: ['prospecting'],
      },
    });
    const root = mkdtempSync(join(tmpdir(), 'agentis-component-tool-'));
    componentRoots.push(root);
    process.env.AGENTIS_DATA_DIR = root;
    const source = 'export async function search(input) { return { leads: input.leads ?? [] }; }\n';
    const lock = '{}\n';
    const files = [bundleFile('index.js', source), bundleFile('package-lock.json', lock)]
      .sort((a, b) => a.path.localeCompare(b.path));
    const aggregate = createHash('sha256');
    for (const file of files) aggregate.update(file.path).update('\0').update(Buffer.from(file.dataBase64, 'base64')).update('\0');
    const bundleHash = aggregate.digest('hex');

    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerCapabilityTools(registry, deps());
    const result = await registry.execute({
      toolId: 'agentis.component.install',
      arguments: {
        extensionId,
        manifest: {
          name: 'Prospect Search', slug: 'prospect-search', version: '2.0.0', runtime: 'component_oci',
          permissions: [], capabilityTags: ['prospecting', 'deterministic'],
          component: {
            manifestVersion: 2, id: 'prospect-search', version: '2.0.0',
            runtime: { language: 'node', version: '20' }, entrypoint: 'index.js', dependencyLock: 'package-lock.json',
            bundleHash, permissions: [], operations: [{ name: 'search', inputSchema: {}, outputSchema: {} }],
            resources: { cpu: 0.5, memoryMb: 128, timeoutSec: 30 },
          },
        },
        bundleFiles: files,
        permissionsAcknowledged: [],
      },
    }, toolContext());

    expect(result.ok).toBe(true);
    expect(result.output).toEqual(expect.objectContaining({ extensionId, runtime: 'component_oci', upgraded: true }));
    const stored = ctx.db.select().from(schema.extensions).where(eq(schema.extensions.id, extensionId)).get();
    expect(stored?.runtime).toBe('component_oci');
    expect(stored?.packageId).toBeNull();
    expect(stored?.manifest).toEqual(expect.objectContaining({
      runtime: 'component_oci',
      bundleDir: expect.stringContaining(bundleHash),
      component: expect.objectContaining({ manifestVersion: 2, bundleHash }),
    }));
  });
});

function bundleFile(path: string, value: string) {
  const data = Buffer.from(value);
  return { path, sha256: createHash('sha256').update(data).digest('hex'), dataBase64: data.toString('base64') };
}

describe('agent-facing native channel tools', () => {
  it('binds a channel to an App and exposes the binding in channel inventory', async () => {
    const bridge = new ChannelBridge({
      db: ctx.db,
      vault: ctx.vault,
      conversations: new ConversationStore({ db: ctx.db, bus: ctx.bus }),
      bus: ctx.bus,
      logger: ctx.logger,
      adapters: { telegram: new StubTelegramAdapter() },
    });
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'telegram', name: 'App channel', token: 'bot-token',
    });
    const appId = randomUUID();
    ctx.db.insert(schema.apps).values({
      id: appId, workspaceId: ctx.workspace.id, slug: `channel-${appId}`,
      name: 'Bound App', description: '', createdBy: ctx.user.id,
    }).run();
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    const toolDeps = deps();
    toolDeps.channels = bridge;
    registerChannelTools(registry, toolDeps);

    const bound = await registry.execute({
      toolId: 'agentis.connection.bind_app',
      arguments: { connectionId: connection.id, appId },
    }, toolContext(agentId));
    expect(bound.ok).toBe(true);
    expect(bound.output).toEqual(expect.objectContaining({ bound: true, connectionId: connection.id, appId }));

    const listed = await registry.execute({ toolId: 'agentis.channel.list', arguments: {} }, toolContext());
    expect(listed.output).toEqual(expect.objectContaining({
      channels: [expect.objectContaining({ id: connection.id, appId })],
    }));
  });

  it('lists channels with health and sends to the saved default target', async () => {
    const adapter = new StubTelegramAdapter();
    const bridge = new ChannelBridge({
      db: ctx.db,
      vault: ctx.vault,
      conversations: new ConversationStore({ db: ctx.db, bus: ctx.bus }),
      bus: ctx.bus,
      logger: ctx.logger,
      adapters: { telegram: adapter },
    });
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'Telegram main',
      token: 'bot-token',
      defaultChatId: '777',
    });
    ctx.db.update(schema.channelConnections).set({ status: 'active' }).run();

    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    const toolDeps = deps();
    toolDeps.channels = bridge;
    registerChannelTools(registry, toolDeps);

    const listed = await registry.execute({
      toolId: 'agentis.channel.list',
      arguments: { kind: 'telegram' },
    }, toolContext());
    expect(listed.ok).toBe(true);
    expect(listed.output).toEqual(expect.objectContaining({
      count: 1,
      channels: [expect.objectContaining({
        id: connection.id,
        kind: 'telegram',
        defaultChatId: '777',
        capabilities: expect.objectContaining({
          mediaKinds: ['image', 'video', 'audio', 'voice', 'sticker', 'file'],
          supportsLocation: true,
          supportsContacts: true,
        }),
        mediaGeneration: { modalities: [], note: expect.any(String) },
      })],
    }));

    const sent = await registry.execute({
      toolId: 'agentis.channel.send',
      arguments: { kind: 'telegram', to: 'default', body: 'hello over native channel', deliveryRole: 'progress' },
    }, toolContext(agentId));
    expect(sent.ok).toBe(true);
    expect(sent.output).toEqual(expect.objectContaining({
      sent: true,
      connectionId: connection.id,
      to: '777',
      deliveryRole: 'progress',
    }));
    expect(adapter.sent).toEqual([{ chatId: '777', body: 'hello over native channel' }]);
  });

  it('returns an actionable error when target resolution is ambiguous', async () => {
    const bridge = new ChannelBridge({
      db: ctx.db,
      vault: ctx.vault,
      conversations: new ConversationStore({ db: ctx.db, bus: ctx.bus }),
      bus: ctx.bus,
      logger: ctx.logger,
      adapters: { telegram: new StubTelegramAdapter() },
    });
    const agentId = seedAgent();
    for (const suffix of ['one', 'two']) {
      bridge.create({
        workspaceId: ctx.workspace.id,
        ambientId: null,
        userId: ctx.user.id,
        agentId,
        kind: 'telegram',
        name: `Telegram ${suffix}`,
        token: `bot-token-${suffix}`,
        defaultChatId: suffix,
      });
    }
    ctx.db.update(schema.channelConnections).set({ status: 'active' }).run();

    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    const toolDeps = deps();
    toolDeps.channels = bridge;
    registerChannelTools(registry, toolDeps);

    const result = await registry.execute({
      toolId: 'agentis.channel.send',
      arguments: { kind: 'telegram', to: 'default', body: 'hello' },
    }, toolContext());

    expect(result.ok).toBe(true);
    expect(result.output).toEqual(expect.objectContaining({
      sent: false,
      errorCode: 'CHANNEL_TARGET_AMBIGUOUS_OR_MISSING',
    }));
  });

  it('sends WhatsApp to an explicit phone number without a saved default target', async () => {
    const bridge = new ChannelBridge({
      db: ctx.db,
      vault: ctx.vault,
      conversations: new ConversationStore({ db: ctx.db, bus: ctx.bus }),
      bus: ctx.bus,
      logger: ctx.logger,
    });
    const sent: Array<{ connectionId: string; chatId: string; body: string }> = [];
    bridge.setPersistentTransport(stubPersistentTransport(sent));
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'whatsapp',
      name: 'WhatsApp QR',
    });
    ctx.db.update(schema.channelConnections).set({ status: 'active' }).run();

    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    const toolDeps = deps();
    toolDeps.channels = bridge;
    registerChannelTools(registry, toolDeps);

    const result = await registry.execute({
      toolId: 'agentis.channel.send',
      arguments: { kind: 'whatsapp', to: '+55 11 99999-9999', body: 'hello wa' },
    }, toolContext(agentId));

    expect(result.ok).toBe(true);
    expect(result.output).toEqual(expect.objectContaining({
      sent: true,
      connectionId: connection.id,
      to: '5511999999999@s.whatsapp.net',
      targetSource: 'explicit',
    }));
    expect(sent).toEqual([{ connectionId: connection.id, chatId: '5511999999999@s.whatsapp.net', body: 'hello wa' }]);
  });

  it('sends files and native contacts through a typed reply to the current WhatsApp conversation', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const bridge = new ChannelBridge({
      db: ctx.db,
      vault: ctx.vault,
      conversations,
      bus: ctx.bus,
      logger: ctx.logger,
      artifacts: new ArtifactService(ctx.db, ctx.logger, ctx.bus),
    });
    const delivered: Array<{
      connectionId: string;
      chatId: string;
      body: string;
      attachments?: Array<{ kind: string; filename: string; mimeType: string; data: Buffer }>;
      native?: { kind: string; displayName?: string; phone?: string };
      quotedMessageId?: string;
    }> = [];
    const readReceipts: string[] = [];
    bridge.setPersistentTransport({
      handles: (connection) => connection.kind === 'whatsapp',
      requiresNoToken: (kind) => kind === 'whatsapp',
      status: () => ({ status: 'open' }),
      send: async (connectionId, chatId, body, attachments, _humanize, native, authority) => {
        delivered.push({
          connectionId,
          chatId,
          body,
          attachments,
          native,
          quotedMessageId: authority?.quotedMessage?.providerMessageId,
        });
        return {
          provider: 'whatsapp' as const,
          providerMessageId: `wamid-${delivered.length}`,
          status: 'accepted' as const,
          acceptedAt: new Date().toISOString(),
          recipient: chatId,
          providerAcknowledged: true,
        };
      },
      markRead: async (_connectionId, _chatId, messageId) => { readReceipts.push(messageId); },
    });
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'whatsapp',
      name: 'WhatsApp rich reply',
    });
    ctx.db.update(schema.channelConnections).set({ status: 'active' }).run();
    const conversation = conversations.getOrCreateByChannel({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
      channelConnectionId: connection.id,
      channelChatId: '5511999999999@s.whatsapp.net',
    });
    const inbound = conversations.appendMirrored({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      sessionMessageId: 'whatsapp:provider-inbound-1',
      authorType: 'system',
      participantSide: 'customer',
      body: 'Can you send me the document?',
      metadata: { channelInbound: true },
    });

    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    const toolDeps = deps();
    toolDeps.channels = bridge;
    registerChannelTools(registry, toolDeps);
    const origin = {
      kind: 'whatsapp',
      connectionId: connection.id,
      chatId: '5511999999999@s.whatsapp.net',
      conversationId: conversation.id,
      inboundMessageId: inbound.id,
      durableTurnId: 'turn-rich',
      ownerVerified: true,
    };
    const richContext = {
      ...toolContext(agentId),
      conversationId: origin.conversationId,
      durableTurnId: origin.durableTurnId,
      channelOrigin: origin,
      executionMode: 'chat' as const,
    };

    const file = await registry.execute({
      toolId: 'agentis.channel.reply',
      arguments: {
        body: 'Requested file',
        attachments: [{
          url: 'data:text/plain;base64,aGVsbG8=',
          kind: 'file',
          filename: 'hello.txt',
          mimeType: 'text/plain',
        }],
      },
    }, richContext);
    const contact = await registry.execute({
      toolId: 'agentis.channel.reply',
      arguments: { native: { kind: 'contact', displayName: 'Jordan Lee', phone: '+15557654321' } },
    }, { ...richContext, durableTurnId: 'turn-contact' });
    const markedRead = await registry.execute({
      toolId: 'agentis.channel.read',
      arguments: {},
    }, richContext);
    const quoted = await registry.execute({
      toolId: 'agentis.channel.reply',
      arguments: {
        body: 'Here is the document you requested.',
        quotedMessage: { messageId: inbound.id },
      },
    }, { ...richContext, durableTurnId: 'turn-quoted' });

    expect(file.ok).toBe(true);
    expect(file.output).toEqual(expect.objectContaining({ sent: true, verified: true, to: origin.chatId, deliveryRole: 'final' }));
    expect(contact.ok).toBe(true);
    expect(contact.output).toEqual(expect.objectContaining({ sent: true, verified: true, to: origin.chatId, deliveryRole: 'final' }));
    expect(markedRead.ok).toBe(true);
    expect(readReceipts).toEqual(['provider-inbound-1']);
    expect(quoted.ok).toBe(true);
    expect(delivered[0]).toMatchObject({
      connectionId: connection.id,
      chatId: origin.chatId,
      body: 'Requested file',
      attachments: [{ kind: 'file', filename: 'hello.txt', mimeType: 'text/plain' }],
    });
    expect(delivered[0]?.attachments?.[0]?.data.toString('utf8')).toBe('hello');
    expect(delivered[1]).toMatchObject({
      connectionId: connection.id,
      chatId: origin.chatId,
      body: '',
      native: { kind: 'contact', displayName: 'Jordan Lee', phone: '+15557654321' },
    });
    expect(delivered[2]).toMatchObject({
      body: 'Here is the document you requested.',
      quotedMessageId: 'provider-inbound-1',
    });
  });

  it('does not expose Cloud templates on a WhatsApp QR connection', async () => {
    const bridge = new ChannelBridge({
      db: ctx.db,
      vault: ctx.vault,
      conversations: new ConversationStore({ db: ctx.db, bus: ctx.bus }),
      bus: ctx.bus,
      logger: ctx.logger,
    });
    bridge.setPersistentTransport(stubPersistentTransport([]));
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      kind: 'whatsapp',
      name: 'WhatsApp QR templates guard',
    });
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    const toolDeps = deps();
    toolDeps.channels = bridge;
    registerChannelTools(registry, toolDeps);

    const result = await registry.execute({
      toolId: 'agentis.channel.templates',
      arguments: { connectionId: connection.id },
    }, toolContext());

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain('does not support templates');
  });
});

describe('agentis.build_workflow agent-authored drafts', () => {
  it('builds a fixed Hello World workflow from an agent-authored graph', async () => {
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerBuildTools(registry, deps());

    const result = await registry.execute({
      toolId: 'agentis.build_workflow',
      arguments: {
        title: 'Hello World',
        description: 'Create a manual Hello World workflow that returns the fixed object { text: "Workflow is working" }.',
        graphDraft: {
          version: 1,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [
            { id: 'trigger', type: 'trigger', title: 'Manual Trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
            { id: 'produce_output', type: 'transform', title: 'Produce Output', position: { x: 280, y: 0 }, config: { kind: 'transform', expression: '{"text":"Workflow is working"}' } },
            { id: 'return_output', type: 'return_output', title: 'Return Output', position: { x: 560, y: 0 }, config: { kind: 'return_output', renderAs: 'text' } },
          ],
          edges: [
            { id: 'trigger-produce', source: 'trigger', target: 'produce_output' },
            { id: 'produce-output', source: 'produce_output', target: 'return_output' },
          ],
        },
      },
    }, toolContext());

    expect(result.ok).toBe(true);
    const output = result.output as { workflowId: string; graph: WorkflowGraph };
    const workflow = ctx.db.select().from(schema.workflows).all().find((row) => row.id === output.workflowId);
    expect(workflow).toBeDefined();
    // New shape: trigger → transform (produce_output) → return_output(renderAs).
    expect(output.graph.nodes).toHaveLength(3);
    expect(output.graph.nodes[1]).toEqual(expect.objectContaining({
      id: 'produce_output',
      type: 'transform',
      config: expect.objectContaining({ kind: 'transform', expression: '{"text":"Workflow is working"}' }),
    }));
    expect(output.graph.nodes[2]).toEqual(expect.objectContaining({
      id: 'return_output',
      type: 'return_output',
      config: expect.objectContaining({ kind: 'return_output', renderAs: 'text' }),
    }));
  });

  it('reuses the current MCP agent draft instead of creating duplicate workflows', async () => {
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerBuildTools(registry, deps());
    const mcpContext = {
      ...toolContext(),
      caller: 'mcp',
      agentId: randomUUID(),
      conversationId: undefined,
    };

    // Domain-agnostic: a re-build with the same MCP context must REVISE the same
    // workflow, never spawn a twin.
    const description = 'Create a manual Hello World workflow that returns the fixed object { text: "Workflow is working" }.';
    const graphDraft = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'trigger', type: 'trigger', title: 'Manual Trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'output', type: 'return_output', title: 'Return Output', position: { x: 280, y: 0 }, config: { kind: 'return_output', renderAs: 'text' } },
      ],
      edges: [{ id: 'trigger-output', source: 'trigger', target: 'output' }],
    };
    const first = await registry.execute({
      toolId: 'agentis.build_workflow',
      arguments: { title: 'Hello World', description, graphDraft },
    }, mcpContext);
    const second = await registry.execute({
      toolId: 'agentis.build_workflow',
      arguments: { title: 'Hello World', description, graphDraft },
    }, mcpContext);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const firstId = (first.output as { workflowId: string }).workflowId;
    const secondId = (second.output as { workflowId: string }).workflowId;
    expect(secondId).toBe(firstId);
    const workflows = ctx.db.select().from(schema.workflows).all();
    expect(workflows).toHaveLength(1);
  });

  it('instantiates an agent-authored research pipeline with specialist roles', async () => {
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerBuildTools(registry, deps());

    const result = await registry.execute({
      toolId: 'agentis.build_workflow',
      arguments: {
        title: 'Competitor brief',
        description: 'Every Monday, research our top competitors and write a report summarizing key moves.',
        graphDraft: {
          version: 1,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [
            { id: 'trigger', type: 'trigger', title: 'Weekly Schedule', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'cron', schedule: '0 9 * * 1' } },
            { id: 'research', type: 'agent_task', title: 'Research Competitors', position: { x: 280, y: 0 }, config: { kind: 'agent_task', agentRole: 'researcher', prompt: 'Research competitor moves.', inputKeys: ['trigger'], outputKeys: ['findings'] } },
            { id: 'analyze', type: 'agent_task', title: 'Analyze Moves', position: { x: 560, y: 0 }, config: { kind: 'agent_task', agentRole: 'analyst', prompt: 'Analyze the findings.', inputKeys: ['research'], outputKeys: ['analysis'], skills: ['aarrr-framework'] } },
            { id: 'write', type: 'agent_task', title: 'Write Report', position: { x: 840, y: 0 }, config: { kind: 'agent_task', agentRole: 'writer', prompt: 'Write the final report.', inputKeys: ['analyze'], outputKeys: ['report'] } },
            { id: 'output', type: 'return_output', title: 'Return Report', position: { x: 1120, y: 0 }, config: { kind: 'return_output', renderAs: 'markdown' } },
          ],
          edges: [
            { id: 'trigger-research', source: 'trigger', target: 'research' },
            { id: 'research-analyze', source: 'research', target: 'analyze' },
            { id: 'analyze-write', source: 'analyze', target: 'write' },
            { id: 'write-output', source: 'write', target: 'output' },
          ],
        },
      },
    }, toolContext());

    expect(result.ok).toBe(true);
    const output = result.output as { graph: WorkflowGraph };
    const roles = output.graph.nodes
      .filter((n) => n.config.kind === 'agent_task')
      .map((n) => (n.config as { agentRole?: string }).agentRole);
    expect(roles).toEqual(['researcher', 'analyst', 'writer']);
    // Weekly schedule was inferred from "Every Monday".
    const trigger = output.graph.nodes.find((n) => n.type === 'trigger');
    expect((trigger!.config as { triggerType?: string }).triggerType).toBe('cron');
    // Produces a return_output terminal path even after recurring-state repair
    // appends workflow_store bookkeeping nodes.
    const terminal = output.graph.nodes.find((n) => n.type === 'return_output');
    expect(terminal).toBeTruthy();
    expect(output.graph.edges.some((e) => e.target === terminal!.id)).toBe(true);
    // Analyst carries the injected aarrr-framework skill.
    const analyst = output.graph.nodes.find((n) => (n.config as { agentRole?: string }).agentRole === 'analyst');
    expect((analyst!.config as { skills?: string[] }).skills).toContain('aarrr-framework');
  });

  it('promotes an exact outward candidate through an administrator approval', async () => {
    const workflowId = randomUUID();
    const activeGraph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'trigger', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'output', type: 'return_output', title: 'Result', position: { x: 240, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
      ],
      edges: [{ id: 'active-edge', source: 'trigger', target: 'output' }],
    };
    const candidateGraph: WorkflowGraph = {
      ...activeGraph,
      nodes: [
        activeGraph.nodes[0]!,
        {
          id: 'component', type: 'component_task', title: 'Deterministic prospect search', position: { x: 240, y: 0 },
          config: { kind: 'component_task', componentSlug: 'prospect-search', operationName: 'search', version: '2.0.0', inputMapping: {}, outputMapping: {} },
        },
        { ...activeGraph.nodes[1]!, position: { x: 480, y: 0 } },
      ],
      edges: [
        { id: 'candidate-1', source: 'trigger', target: 'component' },
        { id: 'candidate-2', source: 'component', target: 'output' },
      ],
    };
    ctx.db.insert(schema.workflows).values({
      id: workflowId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'Protected prospecting',
      graph: activeGraph,
      settings: {},
    }).run();

    const revisions = new WorkflowRevisionService(ctx.db);
    const active = revisions.ensureWorkflow(ctx.workspace.id, workflowId).active;
    const candidate = revisions.createCandidate({
      workspaceId: ctx.workspace.id,
      workflowId,
      graph: candidateGraph,
      baseRevisionId: active.id,
      source: 'agent_patch',
      actor: { type: 'agent', id: null },
      reason: 'Replace agent search with a deterministic component',
    }).revision;
    for (const gate of ['dry_run', 'regression', 'clean_debug', 'outcome'] as const) {
      revisions.recordProof({ workspaceId: ctx.workspace.id, workflowId, revisionId: candidate.id, gate, status: 'passed' });
    }

    const approvals = new ApprovalInboxService(ctx.db, ctx.bus);
    bindWorkflowRevisionApproval({ approvals, revisions });
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerBuildTools(registry, { ...deps(), revisions, approvals });
    const requested = await registry.execute({
      toolId: 'agentis.workflow.revision.promote',
      arguments: { workflowId, revisionId: candidate.id },
    }, toolContext());

    expect(requested.ok).toBe(true);
    const request = requested.output as { outcome: string; approvalId: string };
    expect(request.outcome).toBe('blocked_on_human');
    expect(revisions.active(ctx.workspace.id, workflowId).revision.id).toBe(active.id);

    await approvals.resolve({
      workspaceId: ctx.workspace.id,
      approvalId: request.approvalId,
      decision: 'approve',
      resolvedByUserId: ctx.user.id,
    });

    expect(revisions.active(ctx.workspace.id, workflowId).revision.id).toBe(candidate.id);
    expect(revisions.candidate(ctx.workspace.id, workflowId)).toBeNull();
    expect(revisions.proofState(ctx.workspace.id, workflowId, candidate.id).passed).toContain('operator_approval');
  });
});
