/**
 * ChannelTurnDispatcher — inbound channel message → real orchestrator turn →
 * reply delivered back to the channel (OMNICHANNEL-ORCHESTRATOR-10X §3.3).
 *
 * Also covers the end-to-end wiring: ChannelBridge.handleInbound fires the
 * dispatcher, and the orchestrator's reply reaches adapter.send.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { REALTIME_EVENTS, REALTIME_ROOMS, type AgentAdapter, type ChatDelta, type ChatMessage } from '@agentis/core';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { ConversationStore } from '../../src/services/conversation/conversationStore.js';
import { ChannelBridge, DEFAULT_WHATSAPP_CONNECTION_PROFILE } from '../../src/services/conversation/channelBridge.js';
import { ChannelTurnDispatcher, extractExplicitChannelRecipients, interpretConfirmation } from '../../src/services/conversation/channelTurnDispatcher.js';
import { ConversationTurnLeaseRegistry } from '../../src/services/conversation/conversationTurnLease.js';
import { ChatSessionExecutor } from '../../src/services/chat/chatSessionExecutor.js';
import { ChannelIdentityService } from '../../src/services/conversation/channelIdentityService.js';
import { ConversationSummaryService } from '../../src/services/conversation/conversationSummaryService.js';
import { ConversationHandoffService } from '../../src/services/conversation/conversationHandoffService.js';
import { AppContactService } from '../../src/services/app/appContacts.js';
import { AppStore } from '@agentis/app';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import type { ChannelAdapter, ParsedInboundMessage } from '../../src/adapters/channels/types.js';

const ackReceipt = (recipient = '999') => ({
  provider: 'telegram' as const,
  providerMessageId: `provider-${recipient}`,
  status: 'accepted' as const,
  acceptedAt: '2026-07-16T00:00:00.000Z',
  recipient,
  providerAcknowledged: true,
});

/** A chat-capable adapter stub — only `.chat`/`.capabilities` are exercised. */
function chatStub(reply: string): AgentAdapter {
  return {
    capabilities: () => ({ interactiveChat: true }),
    async *chat(): AsyncIterable<ChatDelta> {
      yield { type: 'text', delta: reply };
      yield { type: 'done', finishReason: 'stop' };
    },
  } as unknown as AgentAdapter;
}

function seedAgent(ctx: TestContext) {
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

describe('ChannelTurnDispatcher', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => ctx.close());

  it('runs a turn, persists the reply as an agent message, and delivers it', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });

    const delivered: Array<{ connectionId: string; chatId: string; body: string }> = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: async (args) => { delivered.push(args); return ackReceipt(args.chatId); },
      fallbackAdapter: () => chatStub('Hello from the orchestrator.'),
    });

    const result = await dispatcher.dispatch({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
      conversationId: conv.id,
      connectionId: 'conn-1',
      kind: 'telegram',
      chatId: '999',
      text: 'hi',
    });

    expect(result.replied).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ connectionId: 'conn-1', chatId: '999', body: 'Hello from the orchestrator.' });

    const messages = conversations.messages(conv.id, 50);
    const agentMsg = messages.find((m) => m.authorType === 'agent');
    expect(agentMsg?.body).toBe('Hello from the orchestrator.');
    expect((agentMsg?.metadata as { channelReply?: boolean })?.channelReply).toBe(true);
  });

  it('keeps inbound channel artifacts typed and compiles them into the agent turn', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    let seenPrompt = '';
    let compiledIds: string[] = [];
    let seenInputAttachments: unknown;
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: async (args) => ackReceipt(args.chatId),
      fallbackAdapter: () => chatStub('unused'),
      compileAttachments: async ({ body, attachmentIds }) => {
        compiledIds = attachmentIds;
        return {
          prompt: `${body}\n<attachment>horse visible</attachment>`,
          runtimeInputAttachments: [{
            path: 'C:/agentis/runtime/image-1.jpg',
            name: 'image-1.jpg',
            mimeType: 'image/jpeg',
            kind: 'image' as const,
          }],
        };
      },
      runTurn: async function* (_adapter, _history, userMessage, _ctx, options) {
        seenPrompt = userMessage;
        seenInputAttachments = options?.inputAttachments;
        yield { type: 'text', delta: 'I can see a horse.' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'wa-1', kind: 'whatsapp', chatId: '5511',
      text: '[Image received]\nAttachment: artifact:image-1', attachmentIds: ['image-1'],
    });

    expect(compiledIds).toEqual(['image-1']);
    expect(seenPrompt).toContain('<attachment>horse visible</attachment>');
    expect(seenInputAttachments).toEqual([expect.objectContaining({ path: 'C:/agentis/runtime/image-1.jpg', kind: 'image' })]);
  });

  it('keeps an agent reply pending when the channel has no provider acknowledgement', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: async () => ({
        provider: 'whatsapp', providerMessageId: '3EB0CLIENTONLY', status: 'queued',
        acceptedAt: '2026-07-16T00:00:00.000Z', providerAcknowledged: false,
      }),
      fallbackAdapter: () => chatStub('pending reply'),
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'wa-1', kind: 'whatsapp', chatId: '5511@s.whatsapp.net', text: 'hi',
    });

    const agentMsg = conversations.messages(conv.id, 50).find((message) => message.authorType === 'agent');
    expect(agentMsg?.deliveryStatus).toBe('sending');
    expect((agentMsg?.metadata as { channelDeliveryReceipt?: { providerAcknowledged?: boolean } })?.channelDeliveryReceipt?.providerAcknowledged).toBe(false);
  });

  it('auto-delivers a saved screenshot artifact with the final channel reply', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    const delivered: Array<{ body: string; attachments?: Array<{ url?: string; kind?: string }> }> = [];
    let artifactPolicy: unknown;
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: async (args) => { delivered.push(args); return ackReceipt(args.chatId); },
      fallbackAdapter: () => chatStub('unused'),
      runTurn: async function* (_a, _h, _t, turnContext) {
        artifactPolicy = turnContext.artifactPolicy;
        yield {
          type: 'tool_result', id: 'shot', name: 'agentis.browser.screenshot',
          result: { saved: true, ref: 'artifact:shot-1', mimeType: 'image/png' },
        } as ChatDelta;
        yield { type: 'text', delta: 'Here is the requested screenshot.' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'wa-1', kind: 'whatsapp', chatId: '5511', text: 'send a screenshot',
    });

    expect(artifactPolicy).toMatchObject({ saveScreenshots: true, saveGeneratedAssets: true });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      body: 'Here is the requested screenshot.',
      attachments: [{ url: 'artifact:shot-1', kind: 'image' }],
    });
  });

  it('does not duplicate a reply after agentis.channel.send already verified delivery', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    const delivered: unknown[] = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: async (args) => { delivered.push(args); return ackReceipt(args.chatId); },
      fallbackAdapter: () => chatStub('unused'),
      runTurn: async function* () {
        yield {
          type: 'tool_result', id: 'send', name: 'agentis.channel.send',
          result: { sent: true, verified: true, connectionId: 'wa-1', to: '5511', deliveryRole: 'final' },
        } as ChatDelta;
        yield { type: 'text', delta: 'Sent.' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    const result = await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'wa-1', kind: 'whatsapp', chatId: '5511', text: 'send it',
    });

    expect(result.replied).toBe(true);
    expect(delivered).toEqual([]);
  });

  it('treats an unspecified successful send to the current peer as terminal', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    const delivered: unknown[] = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger,
      deliver: async (args) => { delivered.push(args); return ackReceipt(args.chatId); },
      fallbackAdapter: () => chatStub('unused'),
      runTurn: async function* () {
        yield {
          type: 'tool_result', id: 'send', name: 'agentis.channel.send',
          result: { sent: true, verified: true, connectionId: 'wa-1', to: '5511@s.whatsapp.net', deliveryRole: 'unspecified' },
        } as ChatDelta;
        yield { type: 'text', delta: 'Same message again.' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'wa-1', kind: 'whatsapp', chatId: '5511', text: 'reply here',
    });

    expect(delivered).toEqual([]);
  });

  it('still replies to the requester after a verified send to a different recipient', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    const delivered: Array<{ chatId: string; body: string }> = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger,
      deliver: async (args) => { delivered.push(args); return ackReceipt(args.chatId); },
      fallbackAdapter: () => chatStub('unused'),
      runTurn: async function* () {
        yield {
          type: 'tool_result', id: 'send', name: 'agentis.channel.send',
          result: { sent: true, verified: true, connectionId: 'wa-1', to: '5522@s.whatsapp.net', deliveryRole: 'final' },
        } as ChatDelta;
        yield { type: 'text', delta: 'Done.' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'wa-1', kind: 'whatsapp', chatId: '5511', text: 'message 5522',
    });

    expect(delivered).toEqual([expect.objectContaining({ chatId: '5511', body: 'Done.' })]);
  });

  it('deduplicates a current-peer send recorded only by an MCP-native turn lease', async () => {
    const leases = new ConversationTurnLeaseRegistry();
    ChatSessionExecutor.setTurnLeaseRegistry(leases);
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    const delivered: unknown[] = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger,
      deliver: async (args) => { delivered.push(args); return ackReceipt(args.chatId); },
      fallbackAdapter: () => chatStub('unused'),
      runTurn: async function* (_adapter, _history, _text, turnContext) {
        leases.recordToolResult({
          workspaceId: turnContext.workspaceId,
          conversationId: turnContext.conversationId,
          token: turnContext.turnLease!,
          name: 'agentis.channel.send',
          toolArgs: { to: '5511', body: 'Actually delivered.' },
          result: { sent: true, verified: true, connectionId: 'wa-1', to: '5511@s.whatsapp.net', providerMessageId: 'wamid-current', deliveryStatus: 'accepted', deliveryRole: 'unspecified' },
          ok: true,
          mutating: true,
          durationMs: 1,
        });
        yield { type: 'text', delta: 'Duplicate wrap-up.' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'wa-1', kind: 'whatsapp', chatId: '5511', text: 'send it',
    });

    expect(delivered).toEqual([]);
    expect(conversations.messages(conv.id, 50).filter((message) => message.authorType === 'agent'))
      .toEqual([expect.objectContaining({ body: 'Actually delivered.', sessionMessageId: 'channel_tool_wamid-current' })]);
  });

  it('keeps a progress delivery non-terminal so an optional intro never suppresses the final reply', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    const delivered: Array<{ body: string }> = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: async (args) => { delivered.push(args); return ackReceipt(args.chatId); },
      fallbackAdapter: () => chatStub('unused'),
      runTurn: async function* () {
        yield {
          type: 'tool_result', id: 'intro', name: 'agentis.channel.send',
          result: { sent: true, verified: true, connectionId: 'wa-1', deliveryRole: 'progress' },
        } as ChatDelta;
        yield { type: 'text', delta: 'The long task is complete.' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'wa-1', kind: 'whatsapp', chatId: '5511', text: 'do a long task',
    });

    expect(delivered).toEqual([expect.objectContaining({ body: 'The long task is complete.' })]);
  });

  it('grants owner channel authority only to an explicitly linked peer identity', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const identity = new ChannelIdentityService({ db: ctx.db, logger: ctx.logger });
    const agentId = seedAgent(ctx);
    const handle = '5511888888888@s.whatsapp.net';
    const connectionId = randomUUID();
    ctx.db.insert(schema.channelConnections).values({
      id: connectionId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'Owner boundary', tokenEncrypted: 'x',
      settings: { defaultChatId: handle },
    }).run();
    const conv = conversations.getOrCreateByChannel({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, channelConnectionId: connectionId, channelChatId: handle,
    });
    let ownerVerified: boolean | undefined;
    let addendum = '';
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, identity, logger: ctx.logger,
      deliver: async (args) => ackReceipt(args.chatId), fallbackAdapter: () => chatStub('unused'),
      runTurn: async function* (_adapter, _history, _text, turnContext, options) {
        ownerVerified = turnContext.channelOrigin?.ownerVerified;
        addendum = options?.systemAddendum ?? '';
        yield { type: 'text', delta: 'ok' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId, kind: 'whatsapp', chatId: handle, text: 'before link',
    });
    expect(ownerVerified).toBe(false);
    expect(addendum).toContain('Address that person, never an imagined operator');
    expect(addendum).toContain('Keep runtime state');

    identity.grantAuthority({
      workspaceId: ctx.workspace.id, connectionId, channelKind: 'whatsapp', handle,
      role: 'owner', userId: ctx.user.id, method: 'test',
    });
    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId, kind: 'whatsapp', chatId: handle, text: 'after link',
    });
    expect(ownerVerified).toBe(true);
  });

  it('keeps a worker channel in its own operational scope while exposing its Brain', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const identity = new ChannelIdentityService({ db: ctx.db, logger: ctx.logger });
    const agentId = seedAgent(ctx);
    ctx.db.update(schema.agents).set({ role: 'worker' }).where(eq(schema.agents.id, agentId)).run();
    const handle = '5511777777777@s.whatsapp.net';
    const connectionId = randomUUID();
    ctx.db.insert(schema.channelConnections).values({
      id: connectionId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'Bounded worker', tokenEncrypted: 'x',
      settings: { ownerChatId: handle, ownerName: 'Owner' },
    }).run();
    identity.grantAuthority({
      workspaceId: ctx.workspace.id,
      connectionId,
      channelKind: 'whatsapp',
      handle,
      role: 'owner',
      userId: ctx.user.id,
      method: 'test',
    });
    const conv = conversations.getOrCreateByChannel({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, channelConnectionId: connectionId, channelChatId: handle,
    });
    let allowed: string[] | undefined;
    let addendum = '';
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, identity, logger: ctx.logger,
      deliver: async (args) => ackReceipt(args.chatId), fallbackAdapter: () => chatStub('unused'),
      runTurn: async function* (_adapter, _history, _text, turnContext, options) {
        allowed = turnContext.allowedToolIds;
        addendum = options?.systemAddendum ?? '';
        yield { type: 'text', delta: 'ok' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId, kind: 'whatsapp', chatId: handle,
      text: 'remember this correction',
    });

    expect(allowed).toEqual(expect.arrayContaining(['agentis.brain.search', 'agentis.memory.write']));
    expect(allowed).not.toContain('agentis.agents.list');
    expect(allowed).not.toContain('agentis.agent.brain.configure');
    expect(allowed).not.toContain('agentis.channel.list');
    expect(addendum).toContain('DURABLE BRAIN AVAILABILITY');
    expect(addendum).toContain('Never claim that platform memory is unavailable');
  });

  it('releases a legacy phone-observed handoff when its chat is configured as the owner/operator', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const handoffs = new ConversationHandoffService({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const handle = '5511991234567@s.whatsapp.net';
    const connectionId = randomUUID();
    ctx.db.insert(schema.channelConnections).values({
      id: connectionId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'Owner recovery', tokenEncrypted: 'x',
      settings: { ownerChatId: handle, ownerName: 'Robson' },
    }).run();
    const conv = conversations.getOrCreateByChannel({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, channelConnectionId: connectionId, channelChatId: handle,
    });
    handoffs.claimHuman({ workspaceId: ctx.workspace.id, conversationId: conv.id, source: 'provider_observed' });
    const delivered: string[] = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger, handoffs,
      deliver: async ({ body, chatId }) => { delivered.push(body); return ackReceipt(chatId); },
      fallbackAdapter: () => chatStub('unused'),
      runTurn: async function* () {
        yield { type: 'text', delta: 'I am back.' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof ChatSessionExecutor.turn,
    });

    const result = await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId, kind: 'whatsapp', chatId: handle, text: 'Are you there?',
    });
    expect(result).toMatchObject({ replied: true });
    expect(delivered).toEqual(['I am back.']);
    expect(handoffs.current(ctx.workspace.id, conv.id)).toMatchObject({ state: 'agent', automationEpoch: 2 });
  });

  it('releases a stale handoff for a verified Owner identity even without ownerChatId', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const handoffs = new ConversationHandoffService({ db: ctx.db, bus: ctx.bus });
    const identity = new ChannelIdentityService({ db: ctx.db, logger: ctx.logger });
    const agentId = seedAgent(ctx);
    const configuredHandle = '+55 11 99123-4567';
    const inboundHandle = '5511991234567:4@s.whatsapp.net';
    const connectionId = randomUUID();
    ctx.db.insert(schema.channelConnections).values({
      id: connectionId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'Verified owner recovery', tokenEncrypted: 'x', settings: {},
    }).run();
    identity.grantAuthority({
      workspaceId: ctx.workspace.id, connectionId, channelKind: 'whatsapp', handle: configuredHandle,
      role: 'owner', userId: ctx.user.id, method: 'test_owner_setting',
    });
    const conv = conversations.getOrCreateByChannel({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, channelConnectionId: connectionId, channelChatId: inboundHandle,
    });
    handoffs.claimHuman({ workspaceId: ctx.workspace.id, conversationId: conv.id, source: 'provider_observed' });
    const delivered: string[] = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, identity, logger: ctx.logger, handoffs,
      deliver: async ({ body, chatId }) => { delivered.push(body); return ackReceipt(chatId); },
      fallbackAdapter: () => chatStub('unused'),
      runTurn: async function* () {
        yield { type: 'text', delta: 'Owner chat remains automated.' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof ChatSessionExecutor.turn,
    });

    const result = await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId, kind: 'whatsapp', chatId: inboundHandle, text: 'Continue replying.',
    });
    expect(result).toMatchObject({ replied: true });
    expect(delivered).toEqual(['Owner chat remains automated.']);
    expect(handoffs.current(ctx.workspace.id, conv.id)).toMatchObject({ state: 'agent', automationEpoch: 2 });
  });

  it('silently drops an inbound turn from a BLOCKED sender (no reply, no agent turn)', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const identity = new ChannelIdentityService({ db: ctx.db, logger: ctx.logger });
    identity.setBlocked({ workspaceId: ctx.workspace.id, channelKind: 'telegram', handle: '999', blocked: true });

    const delivered: unknown[] = [];
    let turnRan = false;
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      identity,
      logger: ctx.logger,
      deliver: async (args) => { delivered.push(args); return ackReceipt(args.chatId); },
      fallbackAdapter: () => { turnRan = true; return chatStub('should not run'); },
    });

    const result = await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      connectionId: 'conn-1', kind: 'telegram', chatId: '999', text: 'spam',
    });

    expect(result).toEqual({ replied: false, reason: 'blocked' });
    expect(delivered).toEqual([]);
    expect(turnRan).toBe(false);
  });

  it('publishes channel turn progress into the workspace activity feed', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    const cap = ctx.captureBus();
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      bus: ctx.bus,
      deliver: async () => ackReceipt(),
      fallbackAdapter: () => chatStub('unused'),
      runTurn: async function* () {
        yield {
          type: 'activity',
          id: 'activity-channel-runtime',
          phase: 'runtime',
          status: 'running',
          label: 'Waiting for model output',
        } as ChatDelta;
        yield { type: 'tool_call', id: 'tool-1', name: 'agentis.lookup', args: { q: 'status' } } as ChatDelta;
        yield { type: 'tool_result', id: 'tool-1', name: 'agentis.lookup', result: { ok: true } } as ChatDelta;
        yield { type: 'text', delta: 'ok' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
      conversationId: conv.id,
      connectionId: 'conn-1',
      kind: 'telegram',
      chatId: '999',
      text: 'hi',
    });
    cap.stop();

    const workSteps = cap.events
      .filter((event) => event.envelope.event === REALTIME_EVENTS.AGENT_WORK_STEP)
      .map((event) => event.envelope.payload as { conversationId?: string; description?: string; phase?: string });
    expect(workSteps.some((event) => event.conversationId === conv.id && /Telegram message received/.test(event.description ?? ''))).toBe(true);
    expect(workSteps.some((event) => event.conversationId === conv.id && /Waiting for model output/.test(event.description ?? ''))).toBe(true);
    expect(workSteps.some((event) => event.conversationId === conv.id && /agentis.lookup completed/.test(event.description ?? ''))).toBe(true);
  });

  it('keeps every internal runtime status out of WhatsApp while preserving native typing', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    const delivered: string[] = [];
    const typing: boolean[] = [];

    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: async (args) => { delivered.push(args.body); return ackReceipt(args.chatId); },
      setTyping: async (_connectionId, _chatId, on) => { typing.push(on); },
      fallbackAdapter: () => chatStub('unused'),
      runTurn: async function* () {
        yield { type: 'activity', id: 'a1', phase: 'runtime', status: 'running', label: 'Hermes runtime ready' } as ChatDelta;
        yield { type: 'activity', id: 'a2', phase: 'runtime', status: 'running', label: 'Hermes session ready' } as ChatDelta;
        yield { type: 'activity', id: 'a3', phase: 'runtime', status: 'running', label: 'Hermes is reasoning' } as ChatDelta;
        yield { type: 'activity', id: 'a4', phase: 'tool', status: 'running', label: 'Run Tool: web_search' } as ChatDelta;
        yield { type: 'text', delta: 'final answer' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    const result = await dispatcher.dispatch({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
      conversationId: conv.id,
      connectionId: 'conn-1',
      kind: 'whatsapp',
      chatId: '5511999999999@s.whatsapp.net',
      text: 'do a lot of work',
    });

    expect(result.replied).toBe(true);
    // The peer sees only the actual answer. Runtime and tool states stay in the
    // internal event bus and never become WhatsApp/Telegram/other channel text.
    expect(delivered).toEqual(['final answer']);
    expect(typing).toEqual([true, false]);

    // No internal progress line is persisted as a visible channel message.
    const messages = conversations.messages(conv.id, 50);
    expect(messages.map((message) => message.body)).toEqual(['final answer']);
  });

  it('delivers one generic indicator only to an explicitly linked WhatsApp owner', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const identity = new ChannelIdentityService({ db: ctx.db, logger: ctx.logger });
    const agentId = seedAgent(ctx);
    const handle = '5511999999999@s.whatsapp.net';
    const connectionId = randomUUID();
    ctx.db.insert(schema.channelConnections).values({
      id: connectionId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'Owner WhatsApp', tokenEncrypted: 'x',
      settings: {
        defaultChatId: handle,
        whatsappProfile: { ...DEFAULT_WHATSAPP_CONNECTION_PROFILE, ownerReasoningVisibility: 'indicator' },
      },
    }).run();
    identity.grantAuthority({
      workspaceId: ctx.workspace.id, connectionId, channelKind: 'whatsapp', handle,
      role: 'owner', userId: ctx.user.id, method: 'test',
    });
    const conv = conversations.getOrCreateByChannel({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, channelConnectionId: connectionId, channelChatId: handle,
    });
    const delivered: string[] = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, identity, logger: ctx.logger,
      deliver: async ({ body, chatId }) => { delivered.push(body); return ackReceipt(chatId); },
      fallbackAdapter: () => chatStub('unused'), ownerReasoningIndicatorDelayMs: 1,
      runTurn: async function* () {
        yield { type: 'thinking', delta: 'private chain of thought' } as ChatDelta;
        yield { type: 'activity', id: 'boot', phase: 'runtime', status: 'running', label: 'Hermes session ready' } as ChatDelta;
        yield { type: 'tool_call', id: 'tool', name: 'agentis.secret_tool', args: {} } as ChatDelta;
        yield { type: 'tool_result', id: 'tool', name: 'agentis.secret_tool', result: null, error: 'private error' } as ChatDelta;
        await new Promise((resolve) => setTimeout(resolve, 15));
        yield { type: 'text', delta: 'final answer' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId, kind: 'whatsapp', chatId: handle, text: 'hello',
    });

    expect(delivered).toEqual(['Hermes is reasoning', 'final answer']);
    expect(delivered.join('\n')).not.toMatch(/session ready|secret_tool|private error|chain of thought/i);
    const messages = conversations.messages(conv.id, 10);
    expect(messages.find((message) => message.body === 'Hermes is reasoning')?.metadata)
      .toMatchObject({ channelDeliveryClass: 'owner_reasoning_indicator' });
  });

  it('keeps an explicitly linked owner silent when the indicator is off', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const identity = new ChannelIdentityService({ db: ctx.db, logger: ctx.logger });
    const agentId = seedAgent(ctx);
    const handle = '5511666666666@s.whatsapp.net';
    const connectionId = randomUUID();
    ctx.db.insert(schema.channelConnections).values({
      id: connectionId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'Owner WhatsApp', tokenEncrypted: 'x',
      settings: { whatsappProfile: DEFAULT_WHATSAPP_CONNECTION_PROFILE },
    }).run();
    identity.record({ workspaceId: ctx.workspace.id, channelKind: 'whatsapp', handle });
    identity.link({ workspaceId: ctx.workspace.id, channelKind: 'whatsapp', handle, userId: ctx.user.id });
    const conv = conversations.getOrCreateByChannel({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, channelConnectionId: connectionId, channelChatId: handle,
    });
    const delivered: string[] = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, identity, logger: ctx.logger,
      deliver: async ({ body, chatId }) => { delivered.push(body); return ackReceipt(chatId); },
      fallbackAdapter: () => chatStub('unused'), ownerReasoningIndicatorDelayMs: 1,
      runTurn: async function* () {
        await new Promise((resolve) => setTimeout(resolve, 15));
        yield { type: 'text', delta: 'final answer' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });
    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId, kind: 'whatsapp', chatId: handle, text: 'hello',
    });
    expect(delivered).toEqual(['final answer']);
  });

  it('never unlocks the owner indicator through a default recipient or a non-owner identity', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const identity = new ChannelIdentityService({ db: ctx.db, logger: ctx.logger });
    const agentId = seedAgent(ctx);
    const otherUserId = randomUUID();
    ctx.db.insert(schema.users).values({ id: otherUserId, username: `other-${otherUserId}`, displayName: 'Other', passwordHash: 'x', isAdmin: false }).run();
    const handles = ['5511888888888@s.whatsapp.net', '5511777777777@s.whatsapp.net'];
    for (const [index, handle] of handles.entries()) {
      const connectionId = randomUUID();
      ctx.db.insert(schema.channelConnections).values({
        id: connectionId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
        agentId, kind: 'whatsapp', name: `WhatsApp ${index}`, tokenEncrypted: 'x',
        settings: {
          // This intentionally matches the sender: it still cannot unlock diagnostics.
          defaultChatId: handle,
          whatsappProfile: { ...DEFAULT_WHATSAPP_CONNECTION_PROFILE, ownerReasoningVisibility: 'indicator' },
        },
      }).run();
      if (index === 1) {
        identity.record({ workspaceId: ctx.workspace.id, channelKind: 'whatsapp', handle });
        identity.link({ workspaceId: ctx.workspace.id, channelKind: 'whatsapp', handle, userId: otherUserId });
      }
      const conv = conversations.getOrCreateByChannel({
        workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
        agentId, channelConnectionId: connectionId, channelChatId: handle,
      });
      const delivered: string[] = [];
      const dispatcher = new ChannelTurnDispatcher({
        db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, identity, logger: ctx.logger,
        deliver: async ({ body, chatId }) => { delivered.push(body); return ackReceipt(chatId); },
        fallbackAdapter: () => chatStub('unused'), ownerReasoningIndicatorDelayMs: 1,
        runTurn: async function* () {
          await new Promise((resolve) => setTimeout(resolve, 15));
          yield { type: 'text', delta: 'final answer' } as ChatDelta;
          yield { type: 'done', finishReason: 'stop' } as ChatDelta;
        } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
      });
      await dispatcher.dispatch({
        workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
        agentId, conversationId: conv.id, connectionId, kind: 'whatsapp', chatId: handle, text: 'hello',
      });
      expect(delivered).toEqual(['final answer']);
    }
  });

  it('does not emit status messages on a fast channel turn', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    const delivered: string[] = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: async (args) => { delivered.push(args.body); return ackReceipt(args.chatId); },
      fallbackAdapter: () => chatStub('unused'),
      runTurn: async function* () {
        yield { type: 'activity', id: 'a1', phase: 'tool', status: 'running', label: 'Run Tool: quick_lookup' } as ChatDelta;
        yield { type: 'activity', id: 'a1', phase: 'tool', status: 'success', label: 'Used quick_lookup' } as ChatDelta;
        yield { type: 'text', delta: 'quick answer' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
      conversationId: conv.id,
      connectionId: 'conn-1',
      kind: 'telegram',
      chatId: '999',
      text: 'quick question',
    });

    expect(delivered).toEqual(['quick answer']);
  });

  it('persists and delivers a credit/quota failure notice instead of going silent', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    const delivered: string[] = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      bus: ctx.bus,
      deliver: async (args) => { delivered.push(args.body); return ackReceipt(args.chatId); },
      fallbackAdapter: () => chatStub('unused'),
      runTurn: async function* () {
        throw new Error('insufficient_quota: out of credits');
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    const result = await dispatcher.dispatch({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
      conversationId: conv.id,
      connectionId: 'conn-1',
      kind: 'telegram',
      chatId: '999',
      text: 'hi',
    });

    expect(result).toEqual({ replied: true, reason: 'error_notified' });
    expect(delivered[0]).toMatch(/out of credits|quota/i);
    const messages = conversations.messages(conv.id, 50);
    const failure = messages.find((message) => message.authorType === 'agent' && /out of credits|quota/i.test(message.body));
    // This is a successfully transported failure notice. Delivery status reflects
    // provider evidence, not whether the model turn itself succeeded.
    expect(failure?.deliveryStatus).toBe('sent');
  });

  it('never sends raw database errors to a channel recipient', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    const delivered: string[] = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: async (args) => { delivered.push(args.body); return ackReceipt(args.chatId); },
      fallbackAdapter: () => chatStub('unused'),
      runTurn: async function* () {
        throw new Error('UNIQUE constraint failed: channel_peer_identities.workspace_id, channel_peer_identities.channel_kind, channel_peer_identities.handle');
      } as unknown as typeof ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'conn-1', kind: 'telegram', chatId: '999', text: 'hello',
    });

    expect(delivered).toEqual(['I’m having trouble answering right now. Please try again in a moment.']);
    expect(delivered[0]).not.toMatch(/UNIQUE|constraint|channel_peer_identities/i);
  });

  it('maps prior channel-inbound system messages to user role in history', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    // Prior turn: a channel-inbound human message + an agent reply.
    conversations.appendMirrored({
      workspaceId: ctx.workspace.id, conversationId: conv.id, sessionMessageId: 'ext-1',
      authorType: 'system', body: 'earlier question', metadata: { channelInbound: true },
    });
    conversations.appendMirrored({
      workspaceId: ctx.workspace.id, conversationId: conv.id, sessionMessageId: 'reply-1',
      authorType: 'agent', body: 'earlier answer',
    });

    let captured: ChatMessage[] = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: async () => ackReceipt(),
      fallbackAdapter: () => chatStub('ok'),
      runTurn: async function* (_adapter, history) {
        captured = history;
        yield { type: 'text', delta: 'ok' };
        yield { type: 'done', finishReason: 'stop' };
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'c', kind: 'telegram', chatId: '1', text: 'follow up',
    });

    expect(captured).toEqual([
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ]);
  });

  it('scopes turn history to the active thread (subject isolation)', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    // Two prior human turns in two different threads of the same conversation.
    conversations.appendMirrored({
      workspaceId: ctx.workspace.id, conversationId: conv.id, sessionMessageId: 'tA-1',
      authorType: 'system', body: 'about the budget', metadata: { channelInbound: true, threadId: 'chan:A' },
    });
    conversations.appendMirrored({
      workspaceId: ctx.workspace.id, conversationId: conv.id, sessionMessageId: 'tB-1',
      authorType: 'system', body: 'about the deploy', metadata: { channelInbound: true, threadId: 'chan:B' },
    });

    let captured: ChatMessage[] = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger,
      deliver: async () => ackReceipt(), fallbackAdapter: () => chatStub('ok'),
      runTurn: async function* (_a, history) {
        captured = history;
        yield { type: 'text', delta: 'ok' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'c', kind: 'slack', chatId: 'chan:thread:A',
      threadId: 'chan:A', text: 'follow up on budget',
    });

    // Only the thread-A message survives; thread-B is excluded.
    expect(captured).toEqual([{ role: 'user', content: 'about the budget' }]);
  });

  it('delivers a not-connected notice when no chat adapter is available', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    const delivered: string[] = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: async (a) => { delivered.push(a.body); return ackReceipt(a.chatId); },
      fallbackAdapter: () => undefined,
    });
    const result = await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'c', kind: 'telegram', chatId: '1', text: 'hi',
    });
    expect(result.replied).toBe(false);
    expect(result.reason).toBe('no_chat_adapter');
    expect(delivered[0]).toMatch(/not connected to an interactive runtime/);
  });

  it('stays quiet when an operator has taken over the thread (Living Apps Phase 2)', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    // Operator took over: park the agent.
    ctx.db.update(schema.conversations).set({ handoffState: 'human' }).where(eq(schema.conversations.id, conv.id)).run();

    let turnRan = false;
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger,
      deliver: async () => ackReceipt(), fallbackAdapter: () => chatStub('should not run'),
      runTurn: async function* () { turnRan = true; yield { type: 'done', finishReason: 'stop' } as ChatDelta; } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    const result = await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'c', kind: 'telegram', chatId: '1', text: 'hi',
    });

    expect(turnRan).toBe(false);
    expect(result).toEqual({ replied: false, reason: 'human_handling' });
  });

  it('runs an App-bound channel turn in App context (Living Apps Phase 0)', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const app = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Acme Sales' });

    // A channel connection bound to the App.
    const connId = randomUUID();
    ctx.db.insert(schema.channelConnections).values({
      id: connId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
      appId: app.id,
      kind: 'telegram',
      name: 'Acme line',
      tokenEncrypted: 'x',
    }).run();

    // The channel-bound conversation adopts the App.
    const conv = conversations.getOrCreateByChannel({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, channelConnectionId: connId, channelChatId: '42', appId: app.id,
    });
    expect((conv as { appId?: string | null }).appId).toBe(app.id);

    let capturedCtx: { appId?: string | null } | null = null;
    let capturedOptions: { systemAddendum?: string } | null = null;
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger,
      deliver: async () => ackReceipt(), fallbackAdapter: () => chatStub('ok'),
      runTurn: async function* (_a, _h, _t, c, o) {
        capturedCtx = c as { appId?: string | null };
        capturedOptions = (o ?? null) as { systemAddendum?: string } | null;
        yield { type: 'text', delta: 'ok' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, appId: app.id, conversationId: conv.id, connectionId: connId, kind: 'telegram', chatId: '42', text: 'hi',
    });

    // The turn carries the App in context (so data_insert resolves to it)…
    expect(capturedCtx?.appId).toBe(app.id);
    // …and the resident-agent operating doctrine is injected, naming the App.
    expect(capturedOptions?.systemAddendum ?? '').toMatch(/Acme Sales/);
    expect(capturedOptions?.systemAddendum ?? '').toMatch(/data_insert|datastore/);
  });

  it('withholds an App-bound reply that hits a blocked claim, and holds an approval-gated reply (G7)', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const app = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Acme Sales' });
    // Policy: never promise a refund; price talk needs approval.
    ctx.db.update(schema.apps).set({
      policyJson: { audience: [], shareable: false, customCode: 'disabled', grants: [], outbound: { blockedClaims: ['refund'], requireApprovalFor: ['discount'] } },
    }).where(eq(schema.apps.id, app.id)).run();

    const connId = randomUUID();
    ctx.db.insert(schema.channelConnections).values({
      id: connId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, appId: app.id, kind: 'telegram', name: 'Acme line', tokenEncrypted: 'x',
    }).run();
    const conv = conversations.getOrCreateByChannel({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, channelConnectionId: connId, channelChatId: '42', appId: app.id,
    });

    const { OutboundPolicyService } = await import('../../src/services/outboundPolicy.js');
    const outboundPolicy = new OutboundPolicyService({ db: ctx.db, logger: ctx.logger });
    const delivered: string[] = [];
    const approvals: Array<{ body: string; reason: string }> = [];
    let replyText = '';
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger,
      deliver: async (a) => { delivered.push(a.body); return ackReceipt(a.chatId); },
      fallbackAdapter: () => chatStub('placeholder'),
      outboundPolicy,
      requestOutboundApproval: async (a) => { approvals.push({ body: a.body, reason: a.reason }); return true; },
      runTurn: async function* () {
        yield { type: 'text', delta: replyText } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    // 1) A blocked-claim reply is WITHHELD — nothing reaches the channel.
    replyText = 'Yes, we offer a full refund anytime.';
    const blocked = await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, appId: app.id, conversationId: conv.id, connectionId: connId, kind: 'telegram', chatId: '42', text: 'can I get a refund?',
    });
    expect(blocked).toMatchObject({ replied: false, reason: 'blocked_claim' });
    expect(delivered).toHaveLength(0);
    expect(approvals).toHaveLength(0);

    // 2) An approval-gated reply is HELD for the operator, not delivered.
    replyText = 'I can offer you a 10% discount.';
    const held = await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, appId: app.id, conversationId: conv.id, connectionId: connId, kind: 'telegram', chatId: '42', text: 'any deal?',
    });
    expect(held).toMatchObject({ replied: false, reason: 'held_for_approval' });
    expect(delivered).toHaveLength(0);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.body).toMatch(/discount/);

    // 3) A clean reply goes out normally + is recorded against the counter.
    replyText = 'Sure, here is the brochure.';
    const ok = await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, appId: app.id, conversationId: conv.id, connectionId: connId, kind: 'telegram', chatId: '42', text: 'tell me more',
    });
    expect(ok.replied).toBe(true);
    expect(delivered).toEqual(['Sure, here is the brochure.']);
    const rows = ctx.db.select().from(schema.appOutboundLog).where(eq(schema.appOutboundLog.appId, app.id)).all();
    expect(rows).toHaveLength(1); // only the delivered reply counted
  });

  it('surfaces resident-agent activity in the App console on an App-bound turn (G9 co-presence)', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const app = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Acme Sales' });
    const connId = randomUUID();
    ctx.db.insert(schema.channelConnections).values({
      id: connId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, appId: app.id, kind: 'telegram', name: 'Acme line', tokenEncrypted: 'x',
    }).run();
    const conv = conversations.getOrCreateByChannel({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, channelConnectionId: connId, channelChatId: '42', appId: app.id,
    });

    const activity: Array<{ room: string; payload: { state?: string; conversationId?: string; appId?: string } }> = [];
    const unsub = ctx.bus.subscribe(({ room, envelope }) => {
      if (envelope.event === REALTIME_EVENTS.APP_AGENT_ACTIVITY) {
        activity.push({ room, payload: envelope.payload as { state?: string } });
      }
    });

    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger, bus: ctx.bus,
      deliver: async () => ackReceipt(), fallbackAdapter: () => chatStub('ok'),
      runTurn: async function* () {
        yield { type: 'thinking', delta: 'weighing the discount' } as ChatDelta;
        yield { type: 'text', delta: 'ok' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, appId: app.id, conversationId: conv.id, connectionId: connId, kind: 'telegram', chatId: '42', text: 'hi',
    });
    unsub();

    const states = activity.map((a) => a.payload.state);
    // thinking → typing while the turn runs, then idle to clear the indicator.
    expect(states).toContain('thinking');
    expect(states).toContain('typing');
    expect(states[states.length - 1]).toBe('idle');
    // Every activity event is scoped to this App + thread and dual-published to the App room.
    expect(activity.every((a) => a.payload.appId === app.id && a.payload.conversationId === conv.id)).toBe(true);
    expect(activity.some((a) => a.room === REALTIME_ROOMS.app(app.id))).toBe(true);
  });

  it('does NOT emit App console activity for a non-App channel turn', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const connId = randomUUID();
    ctx.db.insert(schema.channelConnections).values({
      id: connId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, kind: 'telegram', name: 'Plain line', tokenEncrypted: 'x',
    }).run();
    const conv = conversations.getOrCreateByChannel({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, channelConnectionId: connId, channelChatId: '43',
    });
    let activityCount = 0;
    const unsub = ctx.bus.subscribe(({ envelope }) => {
      if (envelope.event === REALTIME_EVENTS.APP_AGENT_ACTIVITY) activityCount += 1;
    });
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger, bus: ctx.bus,
      deliver: async () => ackReceipt(), fallbackAdapter: () => chatStub('ok'),
      runTurn: async function* () {
        yield { type: 'thinking', delta: 'hmm' } as ChatDelta;
        yield { type: 'text', delta: 'ok' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });
    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: connId, kind: 'telegram', chatId: '43', text: 'hi',
    });
    unsub();
    expect(activityCount).toBe(0);
  });

  it('channel-delivered confirmation: prompts yes/no, then resolves on the next reply', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    const delivered: string[] = [];
    const confirmCalls: Array<{ turnId: string; confirmed: boolean }> = [];

    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: async (a) => { delivered.push(a.body); return ackReceipt(a.chatId); },
      fallbackAdapter: () => chatStub('unused'),
      // First turn asks for confirmation.
      runTurn: async function* () {
        yield { type: 'confirmation_required', turnId: 't-99', toolCall: { id: 'x', name: 'agentis.run.cancel', args: {} }, title: 'Cancel run?', body: 'This stops run r1.', confirmLabel: 'Cancel run', cancelLabel: 'Cancel', expiresAt: new Date(Date.now() + 60000).toISOString() } as unknown as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
      runConfirm: async function* (_adapter, turnId, confirmed) {
        confirmCalls.push({ turnId, confirmed });
        yield { type: 'text', delta: confirmed ? 'Run cancelled.' : 'Left it running.' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.confirm,
    });

    const base = {
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'c1', kind: 'telegram', chatId: '42',
    };
    // Turn 1: triggers a confirmation prompt.
    await dispatcher.dispatch({ ...base, text: 'stop the run' });
    expect(delivered[0]).toContain('Cancel run?');
    expect(delivered[0]).toContain('Reply "yes" to confirm');
    expect(confirmCalls).toHaveLength(0);

    // Turn 2: "yes" resolves the pending confirmation.
    await dispatcher.dispatch({ ...base, text: 'yes' });
    expect(confirmCalls).toEqual([{ turnId: 't-99', confirmed: true }]);
    expect(delivered[1]).toBe('Run cancelled.');
  });

  it('debounces rapid-fire messages into a single turn with combined text', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    // Two inbound messages already persisted (as the bridge would) before dispatch.
    const m1 = conversations.appendMirrored({
      workspaceId: ctx.workspace.id, conversationId: conv.id, sessionMessageId: 'i1',
      authorType: 'system', body: 'first', metadata: { channelInbound: true },
    });
    const m2 = conversations.appendMirrored({
      workspaceId: ctx.workspace.id, conversationId: conv.id, sessionMessageId: 'i2',
      authorType: 'system', body: 'second', metadata: { channelInbound: true },
    });

    const turns: Array<{ text: string; history: ChatMessage[] }> = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger,
      deliver: async () => ackReceipt(), fallbackAdapter: () => chatStub('ok'), debounceMs: 40,
      runTurn: async function* (_a, history, userMessage) {
        turns.push({ text: userMessage as string, history });
        yield { type: 'text', delta: 'ok' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    const base = {
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'c', kind: 'telegram', chatId: '1',
    };
    await dispatcher.dispatch({ ...base, text: 'first', inboundMessageId: m1.id });
    await dispatcher.dispatch({ ...base, text: 'second', inboundMessageId: m2.id });
    await new Promise((r) => setTimeout(r, 90));

    // Exactly one turn, combined text, and both inbound messages excluded from history.
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toBe('first\nsecond');
    expect(turns[0]!.history).toEqual([]);
  });

  it('maps a human business-side outbound as assistant context, not as a new customer request', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    conversations.appendOutbound({
      workspaceId: ctx.workspace.id, conversationId: conv.id, operatorId: ctx.user.id,
      participantSide: 'business', sessionMessageId: 'phone-1', body: 'I will send the proposal today.',
    });
    conversations.appendMirrored({
      workspaceId: ctx.workspace.id, conversationId: conv.id, sessionMessageId: 'customer-1',
      authorType: 'system', participantSide: 'customer', body: 'Great, what time?', metadata: { channelInbound: true },
    });
    let captured: ChatMessage[] = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger,
      deliver: async () => ackReceipt(), fallbackAdapter: () => chatStub('ok'),
      runTurn: async function* (_adapter, history) {
        captured = history;
        yield { type: 'text', delta: 'ok' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });
    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'wa', kind: 'whatsapp', chatId: '5511', text: 'live follow-up',
    });
    expect(captured).toEqual([
      { role: 'assistant', content: 'I will send the proposal today.' },
      { role: 'user', content: 'Great, what time?' },
    ]);
  });

  it('aborts the model lane, revokes its tool lease and blocks final delivery on human takeover', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const handoffs = new ConversationHandoffService({ db: ctx.db, bus: ctx.bus });
    const leases = new ConversationTurnLeaseRegistry();
    ChatSessionExecutor.setTurnLeaseRegistry(leases);
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    const delivered: string[] = [];
    const typing: boolean[] = [];
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    let lease = '';
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger, handoffs,
      deliver: async ({ body }) => { delivered.push(body); return ackReceipt(); },
      setTyping: async (_connectionId, _chatId, on) => { typing.push(on); },
      fallbackAdapter: () => chatStub('unused'),
      runTurn: async function* (_adapter, _history, _text, turnContext) {
        lease = turnContext.turnLease ?? '';
        started();
        await new Promise<void>((resolve) => turnContext.signal?.addEventListener('abort', () => resolve(), { once: true }));
        if (turnContext.signal?.aborted) throw new Error('aborted');
        yield { type: 'text', delta: 'stale reply' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });
    handoffs.subscribe((snapshot) => dispatcher.handleHandoffChanged(snapshot));
    const running = dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'wa', kind: 'whatsapp', chatId: '5511', text: 'long task',
    });
    await didStart;
    const snapshot = handoffs.claimHuman({ workspaceId: ctx.workspace.id, conversationId: conv.id, source: 'provider_observed' });
    expect(snapshot.automationEpoch).toBe(1);
    expect(() => leases.assertActive(ctx.workspace.id, conv.id, lease)).toThrow(/stopped|superseded/i);
    expect(await running).toEqual({ replied: false, reason: 'human_handling' });
    expect(delivered).toEqual([]);
    expect(typing).toContain(false);
  });

  it('keeps the work lane alive and answers only an explicit status request through the companion lane', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    const firstInbound = conversations.appendMirrored({
      workspaceId: ctx.workspace.id, conversationId: conv.id, sessionMessageId: 'rapid-1',
      authorType: 'system', body: 'first detail', metadata: { channelInbound: true },
    });
    const secondInbound = conversations.appendMirrored({
      workspaceId: ctx.workspace.id, conversationId: conv.id, sessionMessageId: 'rapid-2',
      authorType: 'system', body: 'second question', metadata: { channelInbound: true },
    });
    let releaseWork: (() => void) | undefined;
    let mainSignal: AbortSignal | undefined;
    let joinedInput: ChatMessage[] = [];
    let companionState = '';
    const delivered: Array<{ body: string; pacing?: string }> = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger,
      deliver: async (args) => { delivered.push(args); return ackReceipt(args.chatId); },
      fallbackAdapter: () => chatStub('unused'),
      runTurn: async function* (_adapter, _history, _userMessage, turnContext, options) {
        mainSignal = turnContext.signal;
        await new Promise<void>((resolve) => { releaseWork = resolve; });
        joinedInput = await options?.liveInput?.() ?? [];
        yield { type: 'text', delta: 'original task completed' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
      runConcurrentTurn: async function* (_adapter, _history, userMessage, _turnContext, options) {
        companionState = options?.systemAddendum ?? '';
        expect(userMessage).toBe('status?');
        expect(options?.sessionKey).toBe(`${conv.id}:companion`);
        yield { type: 'text', delta: 'The original task is still running.' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });
    const base = {
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'rapid-connection', kind: 'whatsapp', chatId: '5511999999999',
    };

    const first = dispatcher.dispatch({ ...base, text: 'first detail', inboundMessageId: firstInbound.id });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releaseWork).toBeTypeOf('function');
    const companion = await dispatcher.dispatch({ ...base, text: 'status?', inboundMessageId: secondInbound.id });
    expect(companion).toEqual({ replied: true, reason: 'active_turn_companion' });
    expect(mainSignal?.aborted).toBe(false);
    releaseWork!();
    await first;

    expect(joinedInput).toEqual([{ role: 'user', content: 'status?' }]);
    expect(companionState).toContain('ACTIVE_TASK_STATE');
    expect(companionState).toContain('"objective":"first detail"');
    expect(delivered).toEqual([
      expect.objectContaining({ body: 'The original task is still running.', pacing: 'immediate' }),
      expect.objectContaining({ body: 'original task completed', pacing: 'immediate' }),
    ]);
    expect(conversations.listQueue(ctx.workspace.id, conv.id)).toEqual([]);
  });

  it('interpretConfirmation maps affirmatives/negatives, null otherwise', () => {
    for (const yes of ['yes', 'Y', 'approve', 'ok', 'do it', '👍', 'sim']) expect(interpretConfirmation(yes)).toBe(true);
    for (const no of ['no', 'cancel', 'stop', 'reject', '👎', 'não']) expect(interpretConfirmation(no)).toBe(false);
    for (const other of ['build me a workflow', 'maybe later', 'what runs are active?']) expect(interpretConfirmation(other)).toBeNull();
  });

  it('extracts only explicit WhatsApp recipient addresses from a request', () => {
    expect(extractExplicitChannelRecipients('whatsapp', 'Envie Oi para +55 31 97050-8700. Dia 10/08.'))
      .toEqual(['5531970508700@s.whatsapp.net']);
    expect(extractExplicitChannelRecipients('whatsapp', 'envie 10 itens amanhã')).toEqual([]);
    expect(extractExplicitChannelRecipients('telegram', 'fale com +5531970508700')).toEqual([]);
  });

  it('end-to-end: ChannelBridge.handleInbound fires the turn and the reply is sent', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const sent: Array<{ chatId: string; body: string }> = [];
    const channelAdapter: ChannelAdapter = {
      kind: 'telegram',
      async send(args) { sent.push({ chatId: args.chatId, body: args.body }); },
      verify: () => true,
      parseInbound: (): ParsedInboundMessage => ({ externalId: 'u1', chatId: '777', body: 'ping', from: 'Bob' }),
    };
    const bridge = new ChannelBridge({
      db: ctx.db, vault: ctx.vault, conversations, bus: ctx.bus, logger: ctx.logger,
      adapters: { telegram: channelAdapter },
    });
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'telegram', name: 'tg', token: 'tok',
    });

    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: (args) => bridge.deliverToConnection(args),
      fallbackAdapter: () => chatStub('pong'),
    });
    bridge.setTurnDispatcher(dispatcher);

    await bridge.handleInbound({ connectionId: connection.id, headers: {}, rawBody: '{}' });
    // Dispatcher runs fire-and-forget; drain microtasks.
    await new Promise((r) => setTimeout(r, 20));

    expect(sent).toEqual([{ chatId: '777', body: 'pong' }]);
    const conv = conversations.list(ctx.workspace.id)[0]!;
    const messages = conversations.messages(conv.id, 50);
    // inbound (system) + reply (agent)
    expect(messages.some((m) => m.authorType === 'system' && m.body.includes('ping'))).toBe(true);
    expect(messages.some((m) => m.authorType === 'agent' && m.body === 'pong')).toBe(true);
  });

  it('G4: a long thread produces a rolling per-conversation summary that is injected', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });

    // Seed a long thread: 40 alternating inbound/agent turns (well beyond the
    // 20-message window) with a distinctive early fact that scrolls out.
    conversations.appendMirrored({
      workspaceId: ctx.workspace.id, conversationId: conv.id, sessionMessageId: 'early',
      authorType: 'system', body: 'My budget ceiling is exactly 7500 dollars.', metadata: { channelInbound: true },
    });
    for (let i = 0; i < 40; i += 1) {
      conversations.appendMirrored({
        workspaceId: ctx.workspace.id, conversationId: conv.id, sessionMessageId: `u${i}`,
        authorType: 'system', body: `customer message number ${i}`, metadata: { channelInbound: true },
      });
      conversations.appendMirrored({
        workspaceId: ctx.workspace.id, conversationId: conv.id, sessionMessageId: `a${i}`,
        authorType: 'agent', body: `agent reply number ${i}`,
      });
    }

    let capturedAddendum = '';
    const summaries = new ConversationSummaryService({ db: ctx.db, logger: ctx.logger });
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger,
      deliver: async () => ackReceipt(), fallbackAdapter: () => chatStub('ok'), summaries,
      runTurn: async function* (_a, _h, _t, _c, o) {
        capturedAddendum = (o as { systemAddendum?: string } | undefined)?.systemAddendum ?? '';
        yield { type: 'text', delta: 'ok' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'c', kind: 'telegram', chatId: '1', text: 'where were we',
    });

    // A summary row exists and covers the out-of-window turns without delaying
    // the first live response.
    await vi.waitFor(() => expect(summaries.current(conv.id)).not.toBeNull());
    const stored = summaries.current(conv.id);
    expect(stored).not.toBeNull();
    expect(stored!.coveredCount).toBeGreaterThan(20);
    // The fallback chatStub is not JSON-structured, so the deterministic path runs.
    expect(stored!.source).toBe('deterministic');
    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'c', kind: 'telegram', chatId: '1', text: 'and now?',
    });
    expect(capturedAddendum).toMatch(/CONVERSATION MEMORY/);
    expect(capturedAddendum).toMatch(/beyond the recent window/);
  });

  it('G11: an App-bound turn scopes brain recall to the App + contact + agent', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const app = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Acme Sales' });
    const connId = randomUUID();
    ctx.db.insert(schema.channelConnections).values({
      id: connId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, appId: app.id, kind: 'telegram', name: 'Acme line', tokenEncrypted: 'x',
    }).run();
    const conv = conversations.getOrCreateByChannel({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, channelConnectionId: connId, channelChatId: '42', appId: app.id,
    });

    const contacts = new AppContactService(ctx.db);
    let capturedCtx: { recallScopeIds?: string[] } | null = null;
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger,
      deliver: async () => ackReceipt(), fallbackAdapter: () => chatStub('ok'), contacts,
      runTurn: async function* (_a, _h, _t, c) {
        capturedCtx = c as { recallScopeIds?: string[] };
        yield { type: 'text', delta: 'ok' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chat/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, appId: app.id, conversationId: conv.id, connectionId: connId, kind: 'telegram', chatId: '42', text: 'hi',
    });

    // The contact was upserted, and recall is scoped to [appId, contactId, agentId].
    const contact = contacts.list(ctx.workspace.id, app.id)[0]!;
    expect(capturedCtx?.recallScopeIds).toEqual(
      expect.arrayContaining([app.id, contact.id, agentId]),
    );
    // A non-App turn carries no recall scope override (back-compat).
  });
});
