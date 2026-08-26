/**
 * Workflow engine reliability — make medium workflows survive the real failure
 * modes pulled from the live DB (agent runtime returns empty / exits non-zero;
 * evaluator targetPath doesn't resolve; no evaluation runtime wired). Each of
 * these used to be TERMINAL and cascade-kill the whole run; here they recover or
 * degrade so the run completes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  REALTIME_EVENTS,
  type AdapterCapabilities,
  type AdapterType,
  type AgentAdapter,
  type ChatDelta,
  type ChatMessage,
  type NormalizedAgentEvent,
  type NormalizedTask,
  type ToolDefinition,
  type WorkflowGraph,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { buildInitialRunState } from '../../src/engine/initialRunState.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import type { EvaluationRuntime } from '../../src/services/structuredEvaluatorRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

/** An agent whose bound runtime HARD-FAILS on dispatch (e.g. `claude_code exited 1`). */
class FailingAgentAdapter implements AgentAdapter {
  readonly adapterType: AdapterType = 'claude_code';
  readonly #handlers = new Set<(event: NormalizedAgentEvent) => void>();
  constructor(
    private readonly agentId: string,
    private readonly failure = 'claude_code exited 1',
  ) {}
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck() { return { isHealthy: true, checkedAt: new Date().toISOString() }; }
  capabilities(): AdapterCapabilities { return { interactiveChat: true, toolCalling: true, toolForwarding: 'marker_protocol' }; }
  onEvent(handler: (event: NormalizedAgentEvent) => void): void { this.#handlers.add(handler); }
  async dispatchTask(task: NormalizedTask): Promise<void> {
    queueMicrotask(() => {
      for (const handler of this.#handlers) {
        handler({ eventType: 'task.failed', agentId: this.agentId, taskId: task.taskId, runId: task.runId, workflowId: task.workflowId, error: this.failure, timestamp: new Date().toISOString() });
      }
    });
  }
  async *chat(_h: ChatMessage[], _t: ToolDefinition[]): AsyncIterable<ChatDelta> { yield { type: 'done', finishReason: 'stop' }; }
  async cancelTask(): Promise<void> {}
}

function mockRuntime(opts: { complete?: Record<string, unknown> | null }): EvaluationRuntime {
  return {
    lastError: null,
    async completeStructured() { return (opts.complete ?? null) as never; },
    async evaluate() { return { score: 9, passed: true, critique: 'ok' }; },
    async routeBranch() { return null; },
  } as unknown as EvaluationRuntime;
}

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => { ctx.close(); });

function buildEngine(adapters: AdapterManager, evaluatorRuntime?: EvaluationRuntime) {
  const engine = new WorkflowEngine({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    extensions: {} as unknown as ExtensionRuntime,
    adapters,
    ...(evaluatorRuntime ? { evaluatorRuntime } : {}),
  });
  adapters.onEvent((event) => {
    if (event.eventType === 'task.completed') void engine.notifyTaskCompleted({ runId: event.runId, nodeId: event.taskId, output: event.output });
    if (event.eventType === 'task.failed') void engine.notifyTaskFailed({ runId: event.runId, nodeId: event.taskId, error: event.error });
  });
  return engine;
}

async function runToTerminal(engine: WorkflowEngine, graph: WorkflowGraph): Promise<{ status: string; nodeStates: Record<string, { outputData?: Record<string, unknown>; error?: string; status?: string }> }> {
  const workflowId = randomUUID();
  const runId = randomUUID();
  const initialState = buildInitialRunState({ runId, workflowId, graph, inputs: {} });
  ctx.db.insert(schema.workflows).values({ id: workflowId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'reliability', graph, settings: {} }).run();
  ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId, userId: ctx.user.id, status: 'CREATED', runState: initialState }).run();
  const terminal = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
    const unsub = ctx.bus.subscribe((m) => {
      if (m.room === `run:${runId}` && (m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED || m.envelope.event === REALTIME_EVENTS.RUN_FAILED)) {
        clearTimeout(timer); unsub(); resolve();
      }
    });
  });
  await engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph });
  await terminal;
  const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
  return run.runState as never;
}

function agentNode(agentId: string, outputKeys: string[]) {
  return {
    id: 'write', type: 'agent_task', title: 'Write', position: { x: 200, y: 0 },
    config: { kind: 'agent_task', agentId, prompt: 'Produce the structured result.', inputKeys: [], outputKeys, capabilityTags: [] },
  } as WorkflowGraph['nodes'][number];
}
const triggerNode = { id: 'trigger', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } } as WorkflowGraph['nodes'][number];

describe('WorkflowEngine reliability', () => {
  it('recovers an agent node on a guaranteed runtime when the bound harness exits non-zero', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({ id: agentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, name: 'Coder', adapterType: 'claude_code', capabilityTags: [], config: {}, role: 'worker', status: 'online' }).run();
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, new FailingAgentAdapter(agentId));
    const engine = buildEngine(adapters, mockRuntime({ complete: { subject: 'Daily AI', body: '<p>hi</p>' } }));

    const graph: WorkflowGraph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [triggerNode, agentNode(agentId, ['subject', 'body'])],
      edges: [{ id: 'e1', source: 'trigger', target: 'write' }],
    };
    const state = await runToTerminal(engine, graph);
    expect(state.status).toBe('COMPLETED');
    expect(state.nodeStates['write']?.status).toBe('COMPLETED');
    expect(state.nodeStates['write']?.outputData).toMatchObject({ subject: 'Daily AI', body: '<p>hi</p>' });
  });

  it('fails honestly ("no usable output", not "missing keys") when no fallback runtime exists', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({ id: agentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, name: 'Coder', adapterType: 'claude_code', capabilityTags: [], config: {}, role: 'worker', status: 'online' }).run();
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, new FailingAgentAdapter(agentId));
    const engine = buildEngine(adapters); // no evaluatorRuntime → no fallback

    const graph: WorkflowGraph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [triggerNode, agentNode(agentId, ['subject', 'body'])],
      edges: [{ id: 'e1', source: 'trigger', target: 'write' }],
    };
    const state = await runToTerminal(engine, graph);
    expect(state.status).toBe('FAILED');
    // The honest harness error survives — not a misleading declared-output message.
    expect(state.nodeStates['write']?.error ?? '').toMatch(/exited 1|no usable output|no working/i);
  });

  it('parks a timed-out agent task without asking a text-only fallback to fabricate its result', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({ id: agentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, name: 'Worker', adapterType: 'claude_code', capabilityTags: [], config: {}, role: 'worker', status: 'online' }).run();
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, new FailingAgentAdapter(
      agentId,
      'Hermes produced no observable output for 30m 0s and appears stuck; the runtime was stopped',
    ));
    let fallbackCalls = 0;
    const runtime = mockRuntime({ complete: { sent_count: 1, status: 'sent' } });
    const originalComplete = runtime.completeStructured.bind(runtime);
    runtime.completeStructured = async (...args: Parameters<EvaluationRuntime['completeStructured']>) => {
      fallbackCalls += 1;
      return originalComplete(...args);
    };
    const engine = buildEngine(adapters, runtime);
    const graph: WorkflowGraph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [triggerNode, agentNode(agentId, ['sent_count', 'status'])],
      edges: [{ id: 'e1', source: 'trigger', target: 'write' }],
    };
    const workflowId = randomUUID();
    const runId = randomUUID();
    const initialState = buildInitialRunState({ runId, workflowId, graph, inputs: {} });
    ctx.db.insert(schema.workflows).values({ id: workflowId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'timeout safety', graph, settings: {} }).run();
    ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId, userId: ctx.user.id, status: 'CREATED', runState: initialState }).run();
    const paused = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for pause')), 15_000);
      const unsubscribe = ctx.bus.subscribe((message) => {
        if (message.room === `run:${runId}` && message.envelope.event === REALTIME_EVENTS.RUN_PAUSED) {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        }
      });
    });

    await engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph });
    await paused;
    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    const state = run.runState as { nodeStates: Record<string, { status?: string; blockedReason?: string; outputData?: unknown }> };

    expect(run.status).toBe('WAITING');
    expect(state.nodeStates.write?.status).toBe('WAITING');
    expect(state.nodeStates.write?.blockedReason).toMatch(/transient external|timeout/i);
    expect(state.nodeStates.write?.outputData).toBeUndefined();
    expect(fallbackCalls).toBe(0);
  });

  it('evaluator degrades to a pass when no evaluation runtime is available (run still completes)', async () => {
    const adapters = new AdapterManager(ctx.logger); // no agents, no runtime
    const engine = buildEngine(adapters);
    const graph: WorkflowGraph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        triggerNode,
        { id: 'seed', type: 'transform', title: 'Seed', position: { x: 200, y: 0 }, config: { kind: 'transform', expression: "({ digest: 'seed text' })" } } as WorkflowGraph['nodes'][number],
        { id: 'gate', type: 'evaluator', title: 'Gate', position: { x: 400, y: 0 }, config: { kind: 'evaluator', targetPath: '{{nodes.seed}}', criteria: 'must be useful', passThreshold: 8 } } as WorkflowGraph['nodes'][number],
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 'seed' }, { id: 'e2', source: 'seed', target: 'gate' }],
    };
    const state = await runToTerminal(engine, graph);
    expect(state.status).toBe('COMPLETED');
    expect(state.nodeStates['gate']?.outputData).toMatchObject({ passed: true });
  });

  it('evaluator degrades (does not abort) when its targetPath does not resolve', async () => {
    const adapters = new AdapterManager(ctx.logger);
    const engine = buildEngine(adapters, mockRuntime({ complete: null }));
    const graph: WorkflowGraph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        triggerNode,
        { id: 'seed', type: 'transform', title: 'Seed', position: { x: 200, y: 0 }, config: { kind: 'transform', expression: "({ digest: 'seed text' })" } } as WorkflowGraph['nodes'][number],
        // Existing node, but a sub-field that resolves to undefined at runtime —
        // the real-world `targetPath did not resolve` shape (not a missing node,
        // which the build-time validator already catches).
        { id: 'gate', type: 'evaluator', title: 'Gate', position: { x: 400, y: 0 }, config: { kind: 'evaluator', targetPath: '{{nodes.seed.nonexistentField}}', criteria: 'must be useful', passThreshold: 8 } } as WorkflowGraph['nodes'][number],
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 'seed' }, { id: 'e2', source: 'seed', target: 'gate' }],
    };
    const state = await runToTerminal(engine, graph);
    // The unresolved targetPath no longer throws "did not resolve" and abort the run.
    expect(state.nodeStates['gate']?.error ?? '').not.toMatch(/did not resolve/i);
    expect(state.status).toBe('COMPLETED');
  });
});
