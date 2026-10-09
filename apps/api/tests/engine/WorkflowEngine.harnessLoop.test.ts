/**
 * AGENT-WORKFLOW-CAPABILITY-10X E1 — a marker_protocol CLI harness (Codex /
 * Claude Code) bound to an agent_task runs through a REAL Agentis chat tool loop
 * (not awareness-only dispatch): it is offered the `agentis.*` integration catalog
 * (minus the recursion blocklist), reasons on its own runtime, and the node
 * completes with its final result.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, type AgentAdapter, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { buildInitialRunState } from '../../src/engine/initialRunState.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { ChatToolExecutor } from '../../src/services/chat/chatToolExecutor.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => { ChatToolExecutor.configure(null); ctx.close(); });

function markerChatAdapter(
  seenTools: string[][],
  finalText: string,
  seenSessions: string[] = [],
  forwarding: 'marker_protocol' | 'mcp_native' = 'marker_protocol',
  finishReason: 'stop' | 'max_turns' | 'error' = 'stop',
): AgentAdapter {
  return {
    adapterType: 'claude_code',
    connect: async () => {},
    disconnect: async () => {},
    healthCheck: async () => ({ isHealthy: true, checkedAt: new Date().toISOString() }),
    capabilities: () => ({
      interactiveChat: true,
      toolCalling: true,
      toolForwarding: forwarding,
      affordances: { fileSystem: true, terminal: true },
    }),
    dispatchTask: async () => {
      throw new Error('dispatch must not be used — E1 runs the chat loop');
    },
    cancelTask: async () => {},
    onEvent: () => {},
    chat: async function* (_messages, tools, options) {
      seenTools.push(tools.map((t) => t.name));
      seenSessions.push(options?.sessionKey ?? '');
      yield {
        type: 'activity', id: 'provider-wait', phase: 'waiting', status: 'running',
        label: 'Waiting for provider', detail: 'Authorization: Bearer abcdefghijklmnop', transport: 'test_acp',
        startedAt: new Date().toISOString(),
      };
      yield {
        type: 'activity', id: 'provider-wait', phase: 'waiting', status: 'success',
        label: 'Provider responded', detail: 'Provider produced output.', transport: 'test_acp',
        completedAt: new Date().toISOString(), durationMs: 10,
      };
      yield {
        type: 'activity', id: 'secret-check', phase: 'runtime', status: 'running',
        label: 'Safe diagnostic', detail: 'Authorization: Bearer abcdefghijklmnop', transport: 'test_acp',
        startedAt: new Date().toISOString(),
      };
      yield { type: 'text', delta: finalText };
      yield { type: 'done', finishReason };
    },
  } as unknown as AgentAdapter;
}

function waitForRunStatus(runId: string, target: 'COMPLETED' | 'FAILED'): Promise<string | null> {
  return new Promise<string>((resolve, reject) => {
    const evt = target === 'COMPLETED' ? REALTIME_EVENTS.RUN_COMPLETED : REALTIME_EVENTS.RUN_FAILED;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${target}`)), 15_000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room === `run:${runId}` && m.envelope.event === evt) { clearTimeout(timer); off(); resolve(target); }
    });
  }).catch(() => null);
}

describe('WorkflowEngine — E1 harness chat tool loop', () => {
  it('runs a marker_protocol harness through a real Agentis tool loop, offers the catalog (minus blocklist), and completes the node', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      name: 'Claude Coder', role: 'coder', adapterType: 'claude_code', capabilityTags: ['code'], config: {}, status: 'online',
    }).run();

    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registry.register(
      { id: 'agentis.channel.send', family: 'app', description: 'message a human', inputSchema: { type: 'object', properties: { to: {}, text: {} } }, mutating: true, mcpExposed: true },
      async () => ({ ok: true }),
    );
    registry.register(
      { id: 'agentis.build_workflow', family: 'build', description: 'build a workflow', inputSchema: { type: 'object', properties: {} }, mutating: true, mcpExposed: true },
      async () => ({ ok: true }),
    );

    const seenTools: string[][] = [];
    const seenSessions: string[] = [];
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, markerChatAdapter(seenTools, 'Found 3 fashion stores on Instagram. Done.', seenSessions));

    const engine = new WorkflowEngine({
      db: ctx.db, bus: ctx.bus, logger: ctx.logger,
      ledger: new LedgerService(ctx.db, ctx.bus),
      scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
      activity: new ActivityFeedService(ctx.db, ctx.bus),
      approvals: new ApprovalInboxService(ctx.db, ctx.bus),
      extensions: {} as unknown as ExtensionRuntime,
      adapters,
      toolRegistry: registry,
    });

    const graph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'A', type: 'agent_task', title: 'Scout', position: { x: 1, y: 0 }, config: { kind: 'agent_task', agentId, agentRole: 'coder', prompt: 'Find fashion stores on Instagram.', outputKeys: [] } },
      ],
      edges: [{ id: 'e', source: 'T', target: 'A' }],
    } as unknown as WorkflowGraph;

    const wfId = randomUUID();
    const runId = randomUUID();
    ctx.db.insert(schema.workflows).values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'harness-wf', graph, settings: {} }).run();
    ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'CREATED', runState: {} }).run();

    const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
    const done = Promise.race([waitForRunStatus(runId, 'COMPLETED'), waitForRunStatus(runId, 'FAILED')]);
    await engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph });
    const status = (await done) ?? 'UNKNOWN';

    const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(row.status ?? status).toBe('COMPLETED');
    const state = row.runState as { nodeStates?: Record<string, { outputData?: { output?: string } }> };
    expect(state.nodeStates?.A?.outputData?.output).toContain('Found 3 fashion stores');
    // The harness was offered the integration catalog, minus the recursion blocklist.
    expect(seenTools[0]).toContain('agentis.channel.send');
    expect(seenTools[0]).not.toContain('agentis.build_workflow');
    expect(seenSessions[0]).toBe(`agent-task:${runId}:A:attempt:1`);

    const secondRunId = randomUUID();
    ctx.db.insert(schema.workflowRuns).values({ id: secondRunId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'CREATED', runState: {} }).run();
    const secondDone = Promise.race([waitForRunStatus(secondRunId, 'COMPLETED'), waitForRunStatus(secondRunId, 'FAILED')]);
    await engine.startRun({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: wfId,
      userId: ctx.user.id,
      triggerId: null,
      inputs: {},
      initialState: buildInitialRunState({ runId: secondRunId, workflowId: wfId, graph, inputs: {} }),
      graph,
    });
    await secondDone;
    expect(seenSessions[1]).toBe(`agent-task:${secondRunId}:A:attempt:1`);
    expect(seenSessions[1]).not.toBe(seenSessions[0]);
    const durableActivity = ctx.db.select().from(schema.runActivityEvents).where(eq(schema.runActivityEvents.runId, runId)).all();
    expect(durableActivity.length).toBeGreaterThan(0);
    const providerRows = durableActivity.filter((event) => event.activityId === 'provider-wait');
    expect(providerRows).toHaveLength(1);
    expect(providerRows[0]).toMatchObject({ status: 'success', transport: 'test_acp', durationMs: 10 });
    expect(JSON.stringify(durableActivity)).not.toContain('abcdefghijklmnop');
    expect(JSON.stringify(durableActivity)).toContain('«redacted»');
    // Terminal cleanup removes the live run context; replay still comes from the
    // durable store and therefore survives a process restart as well.
    expect(engine.getRunActivity(runId).length).toBe(durableActivity.length);
  });

  it('never turns a legacy action prompt green when Hermes returns raw tool syntax without receipts', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      name: 'Ava', role: 'specialist', adapterType: 'hermes_agent', capabilityTags: [], config: {}, status: 'online',
    }).run();
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, markerChatAdapter([], '<tool_call>\nagentis.channel.send {"to":"Valente Store","body":"Olá"}\n</tool_call>'));
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registry.register(
      { id: 'agentis.channel.send', family: 'run', description: 'send', inputSchema: { type: 'object', properties: {} }, mutating: true, mcpExposed: true },
      async () => ({ sent: true }),
    );
    registry.register(
      { id: 'agentis.data.update', family: 'data', description: 'update', inputSchema: { type: 'object', properties: {} }, mutating: true, mcpExposed: true },
      async () => ({ id: 'lead-1' }),
    );
    const engine = new WorkflowEngine({
      db: ctx.db, bus: ctx.bus, logger: ctx.logger,
      ledger: new LedgerService(ctx.db, ctx.bus), scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
      activity: new ActivityFeedService(ctx.db, ctx.bus), approvals: new ApprovalInboxService(ctx.db, ctx.bus),
      extensions: {} as unknown as ExtensionRuntime, adapters, toolRegistry: registry,
    });
    const graph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'A', type: 'agent_task', title: 'First contact', position: { x: 1, y: 0 }, config: {
          kind: 'agent_task', agentId, prompt: 'Select a new lead, send a WhatsApp message, and move the lead to contacted after success.', outputKeys: [],
        } },
      ], edges: [{ id: 'e', source: 'T', target: 'A' }],
    } as unknown as WorkflowGraph;
    const workflowId = randomUUID(); const runId = randomUUID();
    ctx.db.insert(schema.workflows).values({ id: workflowId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'receipt-gate', graph, settings: {} }).run();
    ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId, userId: ctx.user.id, status: 'CREATED', runState: {} }).run();
    const done = Promise.race([waitForRunStatus(runId, 'COMPLETED'), waitForRunStatus(runId, 'FAILED')]);
    await engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState: buildInitialRunState({ runId, workflowId, graph, inputs: {} }), graph });
    await done;
    const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(row.status).toBe('FAILED');
    expect(JSON.stringify(row.runState)).toContain('ACTION_NOT_ACCOMPLISHED');
  });

  it('completes a legacy Sample action only after delivery acknowledgement then verified lead mutation', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      name: 'Ava', role: 'specialist', adapterType: 'hermes_agent', capabilityTags: [], config: {}, status: 'online',
    }).run();
    let round = 0; const seenTools: string[][] = [];
    const adapter = {
      ...markerChatAdapter([], 'unused'),
      adapterType: 'hermes_agent',
      chat: async function* (_messages: unknown, tools: Array<{ name: string }>) {
        seenTools.push(tools.map((tool) => tool.name));
        round += 1;
        if (round === 1) {
          yield { type: 'tool_call', id: 'send-1', name: 'agentis.channel.send', args: { to: '+15551234567', body: 'Conheça a Acme.' } } as const;
          yield { type: 'done', finishReason: 'tool_calls' } as const;
          return;
        }
        if (round === 2) {
          yield { type: 'tool_call', id: 'update-1', name: 'agentis.data.update', args: { id: 'lead-1', stage: 'contacted' } } as const;
          yield { type: 'done', finishReason: 'tool_calls' } as const;
          return;
        }
        yield { type: 'text', delta: 'WhatsApp acknowledged message wa-1. Moved lead to Contacted.' } as const;
        yield { type: 'done', finishReason: 'stop' } as const;
      },
    } as unknown as AgentAdapter;
    const adapters = new AdapterManager(ctx.logger); adapters.register(agentId, adapter);
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registry.register(
      { id: 'agentis.channel.send', family: 'run', description: 'send', inputSchema: { type: 'object', properties: {} }, mutating: true, mcpExposed: true },
      async () => ({ sent: true, providerAcknowledged: true, receipt: { providerMessageId: 'wa-1', status: 'accepted', acceptedAt: new Date().toISOString() } }),
    );
    registry.register(
      { id: 'agentis.data.update', family: 'data', description: 'update', inputSchema: { type: 'object', properties: {} }, mutating: true, mcpExposed: true },
      async () => ({ id: 'lead-1', stage: 'contacted', mutationReceipt: { failed: 0, verification: { performed: true, passed: true } } }),
    );
    registry.register(
      { id: 'agentis.code.execute', family: 'run', description: 'run code', inputSchema: { type: 'object', properties: {} }, mutating: true, mcpExposed: true },
      async () => ({ ok: true }),
    );
    ChatToolExecutor.configure({ registry, logger: ctx.logger });
    const engine = new WorkflowEngine({
      db: ctx.db, bus: ctx.bus, logger: ctx.logger,
      ledger: new LedgerService(ctx.db, ctx.bus), scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
      activity: new ActivityFeedService(ctx.db, ctx.bus), approvals: new ApprovalInboxService(ctx.db, ctx.bus),
      extensions: {} as unknown as ExtensionRuntime, adapters, toolRegistry: registry,
    });
    const graph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'A', type: 'agent_task', title: 'First contact', position: { x: 1, y: 0 }, config: {
          kind: 'agent_task', agentId, prompt: 'Select a lead, send the Acme message by WhatsApp, and move it to contacted only after success.', outputKeys: [],
        } },
      ], edges: [{ id: 'e', source: 'T', target: 'A' }],
    } as unknown as WorkflowGraph;
    const workflowId = randomUUID(); const runId = randomUUID();
    ctx.db.insert(schema.workflows).values({ id: workflowId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'sample-receipts', graph, settings: {} }).run();
    ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId, userId: ctx.user.id, status: 'CREATED', runState: {} }).run();
    const done = Promise.race([waitForRunStatus(runId, 'COMPLETED'), waitForRunStatus(runId, 'FAILED')]);
    await engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState: buildInitialRunState({ runId, workflowId, graph, inputs: {} }), graph });
    await done;
    const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(row.status, JSON.stringify(row.runState)).toBe('COMPLETED');
    const state = row.runState as { nodeStates?: Record<string, { outputData?: { _effectReceipts?: Array<{ kind: string }> } }> };
    expect(state.nodeStates?.A?.outputData?._effectReceipts?.map((receipt) => receipt.kind)).toEqual(['channel_delivery', 'data_mutation']);
    expect(seenTools[0]).not.toContain('agentis.code.execute');
  });

  it('routes an mcp_native adapter through the same caller-managed chat executor', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      name: 'Hermes Worker', role: 'specialist', adapterType: 'hermes_agent', capabilityTags: [], config: {}, status: 'online',
    }).run();
    const seenTools: string[][] = [];
    const seenSessions: string[] = [];
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, markerChatAdapter(seenTools, '{"result":"ok"}', seenSessions, 'mcp_native'));
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registry.register(
      { id: 'agentis.data.query', family: 'data', description: 'query data', inputSchema: { type: 'object', properties: {} }, mutating: false, mcpExposed: true },
      async () => ({ ok: true }),
    );
    const engine = new WorkflowEngine({
      db: ctx.db, bus: ctx.bus, logger: ctx.logger,
      ledger: new LedgerService(ctx.db, ctx.bus), scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
      activity: new ActivityFeedService(ctx.db, ctx.bus), approvals: new ApprovalInboxService(ctx.db, ctx.bus),
      extensions: {} as unknown as ExtensionRuntime, adapters, toolRegistry: registry,
    });
    const graph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'A', type: 'agent_task', title: 'Hermes task', position: { x: 1, y: 0 }, config: { kind: 'agent_task', agentId, agentRole: 'specialist', prompt: 'Return ok.', outputKeys: ['result'] } },
      ], edges: [{ id: 'e', source: 'T', target: 'A' }],
    } as unknown as WorkflowGraph;
    const workflowId = randomUUID();
    const runId = randomUUID();
    ctx.db.insert(schema.workflows).values({ id: workflowId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'native-harness', graph, settings: {} }).run();
    ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId, userId: ctx.user.id, status: 'CREATED', runState: {} }).run();
    const done = Promise.race([waitForRunStatus(runId, 'COMPLETED'), waitForRunStatus(runId, 'FAILED')]);
    await engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState: buildInitialRunState({ runId, workflowId, graph, inputs: {} }), graph });
    await done;

    expect(seenTools[0]).toContain('agentis.data.query');
    expect(seenSessions[0]).toBe(`agent-task:${runId}:A:attempt:1`);
  });

  it('pauses instead of treating max-turn guidance as a successful node result', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      name: 'Bounded Worker', role: 'specialist', adapterType: 'codex', capabilityTags: [], config: {}, status: 'online',
    }).run();
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, markerChatAdapter([], 'Turn limit reached. Say continue.', [], 'marker_protocol', 'max_turns'));
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registry.register(
      { id: 'agentis.data.query', family: 'data', description: 'query data', inputSchema: { type: 'object', properties: {} }, mutating: false, mcpExposed: true },
      async () => ({ ok: true }),
    );
    const engine = new WorkflowEngine({
      db: ctx.db, bus: ctx.bus, logger: ctx.logger,
      ledger: new LedgerService(ctx.db, ctx.bus), scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
      activity: new ActivityFeedService(ctx.db, ctx.bus), approvals: new ApprovalInboxService(ctx.db, ctx.bus),
      extensions: {} as unknown as ExtensionRuntime, adapters, toolRegistry: registry,
    });
    const graph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'A', type: 'agent_task', title: 'Bounded task', position: { x: 1, y: 0 }, config: { kind: 'agent_task', agentId, agentRole: 'specialist', prompt: 'Do bounded work.', outputKeys: [] } },
      ], edges: [{ id: 'e', source: 'T', target: 'A' }],
    } as unknown as WorkflowGraph;
    const workflowId = randomUUID();
    const runId = randomUUID();
    ctx.db.insert(schema.workflows).values({ id: workflowId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'bounded-harness', graph, settings: {} }).run();
    ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId, userId: ctx.user.id, status: 'CREATED', runState: {} }).run();

    await engine.startRun({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId, userId: ctx.user.id, triggerId: null,
      inputs: {}, initialState: buildInitialRunState({ runId, workflowId, graph, inputs: {} }), graph,
    });
    await expect.poll(
      () => ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()?.status,
      { timeout: 5_000 },
    ).toBe('WAITING');
    const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    const state = row.runState as { nodeStates?: Record<string, { status?: string; blockedReason?: string; outputData?: unknown }> };
    expect(state.nodeStates?.A?.status).toBe('WAITING');
    expect(state.nodeStates?.A?.outputData).toBeUndefined();
    expect(state.nodeStates?.A?.blockedReason).toContain('stage=max_turns');
    expect(state.nodeStates?.A?.blockedReason).toContain(`session=agent-task:${runId}:A:attempt:1`);
  });

  it('cancels the live harness turn and its adapter task when the run is cancelled', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      name: 'Cancelable Coder', role: 'coder', adapterType: 'claude_code', capabilityTags: ['code'], config: {}, status: 'online',
    }).run();

    let signalAborted = false;
    const cancelledTaskIds: string[] = [];
    let notifyChatStarted!: () => void;
    const chatStarted = new Promise<void>((resolve) => { notifyChatStarted = resolve; });
    const adapter: AgentAdapter = {
      adapterType: 'claude_code',
      connect: async () => {},
      disconnect: async () => {},
      healthCheck: async () => ({ isHealthy: true, checkedAt: new Date().toISOString() }),
      capabilities: () => ({
        interactiveChat: true,
        toolCalling: true,
        toolForwarding: 'marker_protocol',
        affordances: { fileSystem: true, terminal: true },
      }),
      dispatchTask: async () => { throw new Error('dispatch must not be used'); },
      cancelTask: async (taskId) => { cancelledTaskIds.push(taskId); },
      onEvent: () => {},
      chat: async function* (_messages, _tools, options) {
        notifyChatStarted();
        await new Promise<void>((resolve) => {
          const stop = () => { signalAborted = true; resolve(); };
          if (options?.signal?.aborted) stop();
          else options?.signal?.addEventListener('abort', stop, { once: true });
        });
        // Deliberately complete *after* cancellation. This simulates a CLI that
        // acknowledges abort but flushes a late final response from its process.
        yield { type: 'text', delta: 'late answer that must not revive the run' };
        yield { type: 'done', finishReason: 'stop' };
      },
    };

    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registry.register(
      { id: 'agentis.channel.send', family: 'app', description: 'message a human', inputSchema: { type: 'object', properties: {} }, mutating: true, mcpExposed: true },
      async () => ({ ok: true }),
    );
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, adapter);
    const engine = new WorkflowEngine({
      db: ctx.db, bus: ctx.bus, logger: ctx.logger,
      ledger: new LedgerService(ctx.db, ctx.bus),
      scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
      activity: new ActivityFeedService(ctx.db, ctx.bus),
      approvals: new ApprovalInboxService(ctx.db, ctx.bus),
      extensions: {} as unknown as ExtensionRuntime,
      adapters,
      toolRegistry: registry,
    });

    const graph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'A', type: 'agent_task', title: 'Long task', position: { x: 1, y: 0 }, config: { kind: 'agent_task', agentId, agentRole: 'coder', prompt: 'Keep working.', outputKeys: [] } },
      ],
      edges: [{ id: 'e', source: 'T', target: 'A' }],
    } as unknown as WorkflowGraph;
    const workflowId = randomUUID();
    const runId = randomUUID();
    ctx.db.insert(schema.workflows).values({ id: workflowId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'cancel-harness', graph, settings: {} }).run();
    ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId, userId: ctx.user.id, status: 'CREATED', runState: {} }).run();
    const initialState = buildInitialRunState({ runId, workflowId, graph, inputs: {} });

    await engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph });
    await Promise.race([
      chatStarted,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('chat did not start')), 5_000)),
    ]);
    await engine.cancelRun(runId);

    const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(row.status).toBe('CANCELLED');
    expect(signalAborted).toBe(true);
    expect(cancelledTaskIds).toContain('A');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()?.status).toBe('CANCELLED');
  });
});
