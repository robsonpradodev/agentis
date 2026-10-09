import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { REALTIME_EVENTS } from '@agentis/core';
import { ConversationStore } from '../../src/services/conversation/conversationStore.js';
import { ConversationTurnService, classifyConversationExecutionMode } from '../../src/services/conversation/conversationTurnService.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

describe('ConversationTurnService', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => ctx.close());

  it('persists a turn before execution and records a replayable ordered event log', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Durable Agent',
      adapterType: 'http',
    }).run();
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const conversation = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
    });
    const message = conversations.appendOutbound({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      operatorId: ctx.user.id,
      body: 'Build the complete system',
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const realtimeEvents: Array<{ event: string; payload: unknown }> = [];
    const unsubscribe = ctx.bus.subscribe(({ envelope }) => {
      realtimeEvents.push({ event: envelope.event, payload: envelope.payload });
    });
    const service = new ConversationTurnService({
      db: ctx.db,
      logger: ctx.logger,
      bus: ctx.bus,
      execute: async (_turn, sink) => {
        await gate;
        await sink.writeSSE({ event: 'delta', data: JSON.stringify({ type: 'text', delta: 'done' }) });
        await sink.writeSSE({ event: 'done', data: JSON.stringify({ finishReason: 'stop' }) });
        return { status: 'completed' };
      },
    });
    const turn = service.enqueue({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      agentId,
      userId: ctx.user.id,
      messageId: message.id,
      clientTurnId: randomUUID(),
      prompt: 'Build the complete system',
      requestedMode: 'auto',
      effectiveMode: 'mission',
      permissionMode: 'auto',
      attachmentIds: [],
      contextManifest: { version: 1, generatedAt: new Date().toISOString(), historyMessages: 0, attachmentCount: 0, attachments: [], sources: [], warnings: [] },
      executionEnvelope: { version: 1, requestedMode: 'auto', effectiveMode: 'mission', classificationReason: 'test', adapterType: 'http', model: 'test', configuredReasoningEffort: 'high', effectiveReasoningEffort: 'high', fastMode: false, loadedSources: ['agentis'], toolMode: 'none', durable: true, createdAt: new Date().toISOString(), warnings: [] },
    });

    expect(ctx.db.select().from(schema.conversationTurns).where(eq(schema.conversationTurns.id, turn.id)).get()).toMatchObject({ status: 'queued' });
    expect(service.events(ctx.workspace.id, turn.id, 0)).toHaveLength(2);
    expect(service.events(ctx.workspace.id, turn.id, 0)[0]?.data).toMatchObject({ type: 'turn_status', status: 'queued' });
    expect(service.events(ctx.workspace.id, turn.id, 0)[1]?.data).toMatchObject({ type: 'execution' });
    const secondMessage = conversations.appendOutbound({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      operatorId: ctx.user.id,
      body: 'Follow up after the first task',
    });
    const queuedTurn = service.enqueue({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      agentId,
      userId: ctx.user.id,
      messageId: secondMessage.id,
      clientTurnId: randomUUID(),
      prompt: 'Follow up after the first task',
      requestedMode: 'auto',
      effectiveMode: 'mission',
      permissionMode: 'auto',
      attachmentIds: [],
      contextManifest: { version: 1, generatedAt: new Date().toISOString(), historyMessages: 1, attachmentCount: 0, attachments: [], sources: [], warnings: [] },
      executionEnvelope: { version: 1, requestedMode: 'auto', effectiveMode: 'mission', classificationReason: 'test', adapterType: 'http', model: 'test', configuredReasoningEffort: 'high', effectiveReasoningEffort: 'high', fastMode: false, loadedSources: ['agentis'], toolMode: 'none', durable: true, createdAt: new Date().toISOString(), warnings: [] },
    });
    expect(service.queuePosition(ctx.workspace.id, turn.id)).toBe(0);
    expect(service.queuePosition(ctx.workspace.id, queuedTurn.id)).toBe(1);
    await Promise.resolve();
    expect(service.require(ctx.workspace.id, queuedTurn.id).status).toBe('queued');
    release();
    await expect.poll(() => service.require(ctx.workspace.id, turn.id).status).toBe('completed');
    await expect.poll(() => service.require(ctx.workspace.id, queuedTurn.id).status).toBe('completed');
    const events = service.events(ctx.workspace.id, turn.id, 0);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events.map((event) => event.event)).toEqual(['turn', 'delta', 'turn', 'delta', 'done', 'turn']);
    expect(events.map((event) => event.data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'turn_status', status: 'queued' }),
      expect.objectContaining({ type: 'turn_status', status: 'running' }),
    ]));
    expect(service.events(ctx.workspace.id, turn.id, 1).map((event) => event.seq)).toEqual([2, 3, 4, 5, 6]);
    const history = service.history(ctx.workspace.id, conversation.id);
    expect(history).toHaveLength(2);
    const firstHistory = history.find((entry) => entry.turn.id === turn.id);
    expect(firstHistory?.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(firstHistory?.events.some((event) => event.category === 'narration')).toBe(false);
    expect(realtimeEvents.some((event) => event.event === REALTIME_EVENTS.CONVERSATION_TURN_EVENT)).toBe(true);
    unsubscribe();
  });

  it('recovers a running turn after a process restart and completes it from persisted state', async () => {
    const agentId = randomUUID();
    const turnId = randomUUID();
    const now = new Date().toISOString();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Recovered Agent',
      adapterType: 'http',
    }).run();
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const conversation = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
    });
    const message = conversations.appendOutbound({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      operatorId: ctx.user.id,
      body: 'Continue the mission',
    });
    ctx.db.insert(schema.conversationTurns).values({
      id: turnId,
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      agentId,
      userId: ctx.user.id,
      messageId: message.id,
      planId: null,
      clientTurnId: randomUUID(),
      prompt: 'Continue the mission',
      requestedMode: 'auto',
      effectiveMode: 'mission',
      permissionMode: 'auto',
      status: 'running',
      attachments: [],
      viewport: null,
      executionEnvelope: { version: 1, requestedMode: 'auto', effectiveMode: 'mission', classificationReason: 'test', adapterType: 'http', model: 'test', configuredReasoningEffort: 'high', effectiveReasoningEffort: 'high', fastMode: false, loadedSources: ['agentis'], toolMode: 'none', durable: true, createdAt: now, warnings: [] },
      contextManifest: { version: 1, generatedAt: now, historyMessages: 0, attachmentCount: 0, attachments: [], sources: [], warnings: [] },
      lastEventSeq: 0,
      leaseOwner: 'dead-worker',
      leaseExpiresAt: now,
      error: null,
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    }).run();
    const service = new ConversationTurnService({
      db: ctx.db,
      logger: ctx.logger,
      execute: async (_turn, sink) => {
        await sink.writeSSE({ event: 'done', data: JSON.stringify({ finishReason: 'stop' }) });
        return { status: 'completed' };
      },
    });

    service.recover();

    await expect.poll(() => service.require(ctx.workspace.id, turnId).status).toBe('completed');
    expect(service.events(ctx.workspace.id, turnId, 0).map((event) => event.event)).toEqual(['delta', 'turn', 'done', 'turn']);
    expect(service.events(ctx.workspace.id, turnId, 0)[0]?.data).toMatchObject({ label: 'Recovered after restart' });
  });

  it('resolves an approval-waiting turn and records its terminal status', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Approval Agent',
      adapterType: 'http',
    }).run();
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const conversation = conversations.getOrCreateByAgent({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId });
    const message = conversations.appendOutbound({ workspaceId: ctx.workspace.id, conversationId: conversation.id, operatorId: ctx.user.id, body: 'Approve this' });
    const now = new Date().toISOString();
    const service = new ConversationTurnService({
      db: ctx.db,
      logger: ctx.logger,
      execute: async () => ({ status: 'awaiting_approval' }),
    });
    const turn = service.enqueue({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      agentId,
      userId: ctx.user.id,
      messageId: message.id,
      clientTurnId: randomUUID(),
      prompt: 'Approve this',
      requestedMode: 'mission',
      effectiveMode: 'mission',
      permissionMode: 'ask',
      attachmentIds: [],
      contextManifest: { version: 1, generatedAt: now, historyMessages: 0, attachmentCount: 0, attachments: [], sources: [], warnings: [] },
      executionEnvelope: { version: 1, requestedMode: 'mission', effectiveMode: 'mission', classificationReason: 'test', adapterType: 'http', model: 'test', configuredReasoningEffort: 'high', effectiveReasoningEffort: 'high', fastMode: false, loadedSources: ['agentis'], toolMode: 'none', durable: true, createdAt: now, warnings: [] },
    });

    await expect.poll(() => service.require(ctx.workspace.id, turn.id).status).toBe('awaiting_approval');
    expect(service.resolveAwaiting(ctx.workspace.id, conversation.id, 'completed')).toMatchObject({ id: turn.id, status: 'completed' });
    expect(service.events(ctx.workspace.id, turn.id, 0).at(-1)?.data).toMatchObject({ type: 'turn_status', status: 'completed' });
  });

  it('keeps runtime capacity failures recoverable instead of marking the turn complete', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      name: 'Capacity Agent', adapterType: 'http',
    }).run();
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const conversation = conversations.getOrCreateByAgent({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId });
    const message = conversations.appendOutbound({ workspaceId: ctx.workspace.id, conversationId: conversation.id, operatorId: ctx.user.id, body: 'Build this' });
    const now = new Date().toISOString();
    const service = new ConversationTurnService({
      db: ctx.db,
      logger: ctx.logger,
      execute: async () => { throw new Error('Selected model is at capacity. Please try again.'); },
    });
    const turn = service.enqueue({
      workspaceId: ctx.workspace.id, conversationId: conversation.id, agentId, userId: ctx.user.id,
      messageId: message.id, clientTurnId: randomUUID(), prompt: 'Build this', requestedMode: 'mission',
      effectiveMode: 'mission', permissionMode: 'auto', attachmentIds: [],
      contextManifest: { version: 1, generatedAt: now, historyMessages: 0, attachmentCount: 0, attachments: [], sources: [], warnings: [] },
      executionEnvelope: { version: 1, requestedMode: 'mission', effectiveMode: 'mission', classificationReason: 'test', adapterType: 'http', model: 'test', configuredReasoningEffort: 'high', effectiveReasoningEffort: 'high', fastMode: false, loadedSources: ['agentis'], toolMode: 'none', durable: true, createdAt: now, warnings: [] },
    });
    await expect.poll(() => service.require(ctx.workspace.id, turn.id).status).toBe('blocked');
    expect(service.listActive(ctx.workspace.id, conversation.id)).toEqual(expect.arrayContaining([expect.objectContaining({ id: turn.id, status: 'blocked' })]));
  });

  it('terminates a missing interactive harness error even when its copy says to try again', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      name: 'Unconfigured Agent', adapterType: 'claude_code',
    }).run();
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const conversation = conversations.getOrCreateByAgent({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId });
    const message = conversations.appendOutbound({ workspaceId: ctx.workspace.id, conversationId: conversation.id, operatorId: ctx.user.id, body: 'Hello' });
    const service = new ConversationTurnService({
      db: ctx.db,
      logger: ctx.logger,
      execute: async () => {
        throw new Error('This agent is not connected to an interactive chat harness yet. Configure a V1 harness, then try again.');
      },
    });
    const now = new Date().toISOString();
    const turn = service.enqueue({
      workspaceId: ctx.workspace.id, conversationId: conversation.id, agentId, userId: ctx.user.id,
      messageId: message.id, clientTurnId: randomUUID(), prompt: 'Hello', requestedMode: 'auto',
      effectiveMode: 'quick', permissionMode: 'auto', attachmentIds: [],
      contextManifest: { version: 1, generatedAt: now, historyMessages: 0, attachmentCount: 0, attachments: [], sources: [], warnings: [] },
      executionEnvelope: { version: 1, requestedMode: 'auto', effectiveMode: 'quick', classificationReason: 'test', adapterType: 'claude_code', model: 'test', configuredReasoningEffort: 'high', effectiveReasoningEffort: 'high', fastMode: false, loadedSources: ['agentis'], toolMode: 'none', durable: true, createdAt: now, warnings: [] },
    });

    await expect.poll(() => service.require(ctx.workspace.id, turn.id).status).toBe('failed');
    expect(service.require(ctx.workspace.id, turn.id)).toMatchObject({ completedAt: expect.any(String), error: expect.stringContaining('not connected to an interactive chat harness') });
    expect(service.listActive(ctx.workspace.id, conversation.id)).not.toContainEqual(expect.objectContaining({ id: turn.id }));
  });
});

describe('classifyConversationExecutionMode', () => {
  it('keeps greetings Quick and promotes substantial build specifications to Mission', () => {
    expect(classifyConversationExecutionMode('auto', { body: 'Hello!', attachmentCount: 0, permissionMode: 'ask' }).mode).toBe('quick');
    expect(classifyConversationExecutionMode('auto', {
      body: 'Build and implement the entire production-ready application from start to finish, then verify and deliver it.',
      attachmentCount: 0,
      permissionMode: 'auto',
    }).mode).toBe('mission');
  });

  it('honors explicit mode and promotes attachment analysis out of Quick', () => {
    expect(classifyConversationExecutionMode('quick', { body: 'Build everything', attachmentCount: 1, permissionMode: 'auto' }).mode).toBe('quick');
    expect(classifyConversationExecutionMode('auto', { body: 'Please review this', attachmentCount: 1, permissionMode: 'ask' }).mode).toBe('deep');
  });

  it('never promotes Plan permission into Mission acceptance', () => {
    const classified = classifyConversationExecutionMode('mission', {
      body: 'Build and implement the entire production-ready app from start to finish.',
      attachmentCount: 0,
      permissionMode: 'plan',
    });
    expect(classified.mode).toBe('deep');
    expect(classified.reason).toMatch(/Plan mode/i);
  });

  it('keeps short continuation turns on the unfinished mission path', () => {
    const classified = classifyConversationExecutionMode('auto', {
      body: 'Proceed',
      attachmentCount: 0,
      permissionMode: 'auto',
      previousMode: 'mission',
      hasActiveBuildSession: true,
    });
    expect(classified.mode).toBe('mission');
    expect(classified.reason).toMatch(/unfinished App build/i);
  });
});
