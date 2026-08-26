import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AdapterHealthStatus, ChatDelta, ChatInvocationOptions, ChatMessage, NormalizedAgentEvent, NormalizedTask, ToolDefinition } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { eq } from 'drizzle-orm';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { buildConversationRoutes } from '../../src/routes/conversations.js';
import { ConversationStore } from '../../src/services/conversation/conversationStore.js';
import { TurnChangeJournal } from '../../src/services/conversation/turnChangeJournal.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

class DurableAdapter implements AgentAdapter {
  readonly adapterType = 'http' as const;
  seenOptions?: ChatInvocationOptions;
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck(): Promise<AdapterHealthStatus> { return { isHealthy: true, checkedAt: new Date().toISOString() }; }
  onEvent(_handler: (event: NormalizedAgentEvent) => void): void {}
  async dispatchTask(_task: NormalizedTask): Promise<void> {}
  async cancelTask(_taskId: string): Promise<void> {}
  async *chat(_messages: ChatMessage[], _tools: ToolDefinition[], options?: ChatInvocationOptions): AsyncIterable<ChatDelta> {
    this.seenOptions = options;
    yield { type: 'commentary', id: 'summary-1', text: 'I am validating the workspace before I build the result.', source: 'reasoning_summary', createdAt: new Date().toISOString() };
    yield { type: 'activity', id: 'work-1', phase: 'progress', status: 'running', label: 'Building durable result' };
    yield { type: 'text', delta: 'Durable result' };
    yield { type: 'done', finishReason: 'stop' };
  }
}

class StopAwareDurableAdapter implements AgentAdapter {
  readonly adapterType = 'http' as const;
  aborted = false;
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck(): Promise<AdapterHealthStatus> { return { isHealthy: true, checkedAt: new Date().toISOString() }; }
  onEvent(_handler: (event: NormalizedAgentEvent) => void): void {}
  async dispatchTask(_task: NormalizedTask): Promise<void> {}
  async cancelTask(_taskId: string): Promise<void> {}
  async *chat(_messages: ChatMessage[], _tools: ToolDefinition[], options?: ChatInvocationOptions): AsyncIterable<ChatDelta> {
    await new Promise<void>((resolve) => {
      if (options?.signal?.aborted) return resolve();
      options?.signal?.addEventListener('abort', resolve, { once: true });
    });
    this.aborted = true;
    yield { type: 'done', finishReason: 'interrupted' };
  }
}

describe('durable conversation turn routes', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => ctx.close());

  it('keeps executing without a connected stream, then replays the completed event log', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Mission Agent',
      adapterType: 'http',
    }).run();
    const adapter = new DurableAdapter();
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, adapter);
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const app = ctx.buildApp([{ path: '/v1/conversations', app: buildConversationRoutes({
      db: ctx.db,
      auth: ctx.auth,
      conversations,
      adapters,
      logger: ctx.logger,
      bus: ctx.bus,
    }) }]);

    const create = await app.request(`/v1/conversations/${agentId}/turns`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ body: 'Build and implement the entire production-ready system from start to finish.', executionMode: 'mission', permissionMode: 'auto' }),
    });
    expect(create.status).toBe(202);
    const created = await create.json() as { turn: { id: string; effectiveMode: string; status: string }; conversationId: string };
    expect(created.turn).toMatchObject({ effectiveMode: 'mission', status: 'queued' });

    await expect.poll(async () => {
      const response = await app.request(`/v1/conversations/${agentId}/turns/${created.turn.id}`, { headers: ctx.authHeaders });
      return ((await response.json()) as { turn: { status: string } }).turn.status;
    }).toBe('completed');

    const eventsResponse = await app.request(`/v1/conversations/${agentId}/turns/${created.turn.id}/events`, { headers: ctx.authHeaders });
    expect(eventsResponse.status).toBe(200);
    const stream = await eventsResponse.text();
    expect(stream).toContain('"type":"execution"');
    expect(stream).toContain('Building durable result');
    expect(stream).toContain('I am validating the workspace before I build the result.');
    expect(stream).toContain('Durable result');
    expect(stream).toContain('event: message');

    const historyResponse = await app.request(
      `/v1/conversations/${agentId}/turns?conversationId=${created.conversationId}`,
      { headers: ctx.authHeaders },
    );
    expect(historyResponse.status).toBe(200);
    const history = await historyResponse.json() as { history: Array<{ turn: { status: string }; events: Array<{ category: string; visibility: string; seq: number }> }> };
    expect(history.history).toHaveLength(1);
    expect(history.history[0]?.turn.status).toBe('completed');
    expect(history.history[0]?.events.some((event) => event.category === 'narration' && event.visibility === 'both')).toBe(true);
    expect(history.history[0]?.events.map((event) => event.seq)).toEqual([...history.history[0]!.events.map((event) => event.seq)].sort((a, b) => a - b));

    expect(adapter.seenOptions).toMatchObject({ latencyClass: 'deliberate', reasoningEffort: 'high', fastMode: false });
  });

  it('cancels an in-flight turn by client id and releases its interactive lease', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Stop-aware Agent',
      adapterType: 'http',
    }).run();
    const adapter = new StopAwareDurableAdapter();
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, adapter);
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const app = ctx.buildApp([{ path: '/v1/conversations', app: buildConversationRoutes({
      db: ctx.db,
      auth: ctx.auth,
      conversations,
      adapters,
      logger: ctx.logger,
      bus: ctx.bus,
    }) }]);
    const clientTurnId = randomUUID();
    const create = await app.request(`/v1/conversations/${agentId}/turns`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ body: 'Start a long-running task', clientTurnId, executionMode: 'mission', permissionMode: 'auto' }),
    });
    expect(create.status).toBe(202);
    const created = await create.json() as { turn: { id: string } };
    await expect.poll(() => adapters.interactiveLease(agentId)).not.toBeNull();

    const cancel = await app.request(`/v1/conversations/${agentId}/turns/by-client/${clientTurnId}/cancel`, {
      method: 'POST',
      headers: ctx.authHeaders,
    });
    expect(cancel.status).toBe(200);
    expect((await cancel.json()) as { turn: { id: string; status: string } | null }).toMatchObject({
      turn: { id: created.turn.id, status: 'cancelled' },
    });
    await expect.poll(() => adapter.aborted).toBe(true);
    await expect.poll(() => adapters.interactiveLease(agentId)).toBeNull();
  });

  it('exposes Undo/Redo for changes committed before a cancelled turn settled', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Reversible Agent',
      adapterType: 'http',
    }).run();
    const adapter = new StopAwareDurableAdapter();
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, adapter);
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const turnChanges = new TurnChangeJournal({ sqlite: ctx.sqlite, logger: ctx.logger, bus: ctx.bus });
    const app = ctx.buildApp([{ path: '/v1/conversations', app: buildConversationRoutes({
      db: ctx.db,
      auth: ctx.auth,
      conversations,
      adapters,
      logger: ctx.logger,
      bus: ctx.bus,
      turnChanges,
    }) }]);
    const clientTurnId = randomUUID();
    const create = await app.request(`/v1/conversations/${agentId}/turns`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ body: 'Change then wait', clientTurnId, permissionMode: 'auto' }),
    });
    const created = await create.json() as { turn: { id: string } };
    await expect.poll(() => adapters.interactiveLease(agentId)).not.toBeNull();

    await turnChanges.captureTool({
      workspaceId: ctx.workspace.id,
      durableTurnId: created.turn.id,
      toolCallId: 'tool-call-1',
      toolId: 'agentis.agents.update',
      behavior: 'local',
    }, () => {
      ctx.db.update(schema.agents).set({ description: 'Agent-authored change' }).where(eq(schema.agents.id, agentId)).run();
    });

    await app.request(`/v1/conversations/${agentId}/turns/by-client/${clientTurnId}/cancel`, {
      method: 'POST', headers: ctx.authHeaders,
    });
    const changes = await app.request(`/v1/conversations/${agentId}/turns/${created.turn.id}/changes`, { headers: ctx.authHeaders });
    expect(changes.status).toBe(200);
    const summary = (await changes.json() as { changeSet: { state: string; version: number; reversibleCount: number } }).changeSet;
    expect(summary).toMatchObject({ state: 'undoable', reversibleCount: 1 });

    const undo = await app.request(`/v1/conversations/${agentId}/turns/${created.turn.id}/undo`, {
      method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ expectedVersion: summary.version }),
    });
    expect(undo.status).toBe(200);
    expect(ctx.db.select({ description: schema.agents.description }).from(schema.agents).where(eq(schema.agents.id, agentId)).get()).toEqual({ description: null });
    const undone = await undo.json() as { changeSet: { state: string; version: number } };
    expect(undone.changeSet.state).toBe('undone');

    const redo = await app.request(`/v1/conversations/${agentId}/turns/${created.turn.id}/redo`, {
      method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ expectedVersion: undone.changeSet.version }),
    });
    expect(redo.status).toBe(200);
    expect(ctx.db.select({ description: schema.agents.description }).from(schema.agents).where(eq(schema.agents.id, agentId)).get()).toEqual({ description: 'Agent-authored change' });
  });
});
