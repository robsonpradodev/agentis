import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  REALTIME_EVENTS,
  type AdapterCapabilities,
  type AdapterType,
  type AgentAdapter,
  type ChatDelta,
  type ChatInvocationOptions,
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
import { createCustomIntegrationManifest, normalizeIntegrationManifest } from '../../src/services/integrationRegistry.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

class JsonEnvelopeAgentAdapter implements AgentAdapter {
  readonly adapterType: AdapterType = 'codex';
  readonly #handlers = new Set<(event: NormalizedAgentEvent) => void>();

  constructor(
    private readonly agentId: string,
    private readonly output: Record<string, unknown> = {
      text: [
        '```json',
        JSON.stringify({
          subject: 'Daily AI News Insights',
          sentCount: 0,
          markdown: 'Ready-to-send digest body.',
        }),
        '```',
      ].join('\n'),
    },
  ) {}

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck() {
    return { isHealthy: true, checkedAt: new Date().toISOString() };
  }
  capabilities(): AdapterCapabilities {
    return { interactiveChat: true, toolCalling: false };
  }
  onEvent(handler: (event: NormalizedAgentEvent) => void): void {
    this.#handlers.add(handler);
  }
  async dispatchTask(task: NormalizedTask): Promise<void> {
    queueMicrotask(() => {
      for (const handler of this.#handlers) {
        handler({
          eventType: 'task.completed',
          agentId: this.agentId,
          taskId: task.taskId,
          runId: task.runId,
          workflowId: task.workflowId,
          output: this.output,
          timestamp: new Date().toISOString(),
        });
      }
    });
  }
  async *chat(
    _history: ChatMessage[],
    _tools: ToolDefinition[],
    _options?: ChatInvocationOptions,
  ): AsyncIterable<ChatDelta> {
    yield { type: 'done', finishReason: 'stop' };
  }
  async cancelTask(): Promise<void> {}
}

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  ctx.close();
});

describe('WorkflowEngine output and integration contracts', () => {
  it('materializes declared agent outputs from structured text envelopes', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Delivery Agent',
      adapterType: 'codex',
      capabilityTags: [],
      config: {},
      role: 'worker',
      status: 'online',
    }).run();

    const adapters = new AdapterManager(ctx.logger);
    const adapter = new JsonEnvelopeAgentAdapter(agentId);
    adapters.register(agentId, adapter);
    const engine = makeEngine(adapters);
    adapters.onEvent((event) => {
      if (event.eventType === 'task.completed') {
        void engine.notifyTaskCompleted({
          runId: event.runId,
          nodeId: event.taskId,
          output: event.output,
        });
      }
    });

    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          title: 'Manual',
          position: { x: 0, y: 0 },
          config: { kind: 'trigger', triggerType: 'manual' },
        },
        {
          id: 'draft',
          type: 'agent_task',
          title: 'Draft',
          position: { x: 200, y: 0 },
          config: {
            kind: 'agent_task',
            agentId,
            prompt: 'Return a digest payload.',
            inputKeys: [],
            outputKeys: ['subject', 'markdownBody', 'topStories', 'sentStoryKeys', 'sentCount'],
            capabilityTags: [],
          },
        },
        {
          id: 'shape',
          type: 'transform',
          title: 'Shape',
          position: { x: 400, y: 0 },
          config: {
            kind: 'transform',
            expression: '({ subject: input.subject, body: input.markdownBody, topStories: input.topStories, sentStoryKeys: input.sentStoryKeys, sentCount: input.sentCount })',
            isOutput: true,
          },
        },
      ],
      edges: [
        { id: 'trigger-to-draft', source: 'trigger', target: 'draft' },
        { id: 'draft-to-shape', source: 'draft', target: 'shape' },
      ],
    };
    const { runId, workflowId, initialState } = persistWorkflow(graph);
    const terminal = waitForTerminal(runId);

    await engine.startRun({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId,
      userId: ctx.user.id,
      triggerId: null,
      inputs: {},
      initialState,
      graph,
    });
    await terminal;

    const run = ctx.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .get()!;
    const state = run.runState as {
      nodeStates: Record<string, { outputData?: Record<string, unknown>; error?: string }>;
    };
    expect(run.status).toBe('COMPLETED');
    expect(state.nodeStates.draft?.outputData).toMatchObject({
      subject: 'Daily AI News Insights',
      markdownBody: 'Ready-to-send digest body.',
      topStories: [],
      sentStoryKeys: [],
      sentCount: 0,
    });
    expect(state.nodeStates.shape?.outputData).toEqual({
      subject: 'Daily AI News Insights',
      body: 'Ready-to-send digest body.',
      topStories: [],
      sentStoryKeys: [],
      sentCount: 0,
    });
  });

  it('recovers digest fields from fenced JSON without cross-filling unrelated arrays', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Digest Writer',
      adapterType: 'codex',
      capabilityTags: [],
      config: {},
      role: 'worker',
      status: 'online',
    }).run();

    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, new JsonEnvelopeAgentAdapter(agentId, {
      text: [
        '```json',
        JSON.stringify({
          subject: 'AI Dispatch',
          html: '<p>Two grounded stories.</p>',
          topStories: [{ key: 'story-a', title: 'Story A' }],
          sentStoryKeys: ['story-a', 'story-b'],
        }),
        '```',
      ].join('\n'),
    }));
    const engine = makeEngine(adapters);
    adapters.onEvent((event) => {
      if (event.eventType === 'task.completed') {
        void engine.notifyTaskCompleted({
          runId: event.runId,
          nodeId: event.taskId,
          output: event.output,
        });
      }
    });

    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          title: 'Manual',
          position: { x: 0, y: 0 },
          config: { kind: 'trigger', triggerType: 'manual' },
        },
        {
          id: 'draft',
          type: 'agent_task',
          title: 'Draft',
          position: { x: 200, y: 0 },
          config: {
            kind: 'agent_task',
            agentId,
            prompt: 'Return a digest payload.',
            inputKeys: [],
            outputKeys: ['subject', 'htmlBody', 'topStories', 'sentStoryKeys', 'sentCount'],
            capabilityTags: [],
          },
        },
      ],
      edges: [{ id: 'trigger-to-draft', source: 'trigger', target: 'draft' }],
    };
    const { runId, workflowId, initialState } = persistWorkflow(graph);
    const terminal = waitForTerminal(runId);

    await engine.startRun({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId,
      userId: ctx.user.id,
      triggerId: null,
      inputs: {},
      initialState,
      graph,
    });
    await terminal;

    const run = ctx.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .get()!;
    const state = run.runState as {
      nodeStates: Record<string, {
        outputData?: Record<string, unknown>;
        contractDeviation?: unknown;
      }>;
    };
    expect(run.status).toBe('COMPLETED');
    expect(state.nodeStates.draft?.contractDeviation).toBeUndefined();
    expect(state.nodeStates.draft?.outputData).toMatchObject({
      subject: 'AI Dispatch',
      htmlBody: '<p>Two grounded stories.</p>',
      topStories: [{ key: 'story-a', title: 'Story A' }],
      sentStoryKeys: ['story-a', 'story-b'],
      sentCount: 2,
    });
    expect(state.nodeStates.draft?.outputData?.sentStoryKeys).not.toEqual(state.nodeStates.draft?.outputData?.topStories);
  });

  it('fails honestly when an agent returns none of a multi-field declared contract', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Digest Writer',
      adapterType: 'codex',
      capabilityTags: [],
      config: {},
      role: 'worker',
      status: 'online',
    }).run();

    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, new JsonEnvelopeAgentAdapter(agentId, {
      text: 'The runtime printed activity but returned no delivery receipt.',
    }));
    const engine = makeEngine(adapters);
    adapters.onEvent((event) => {
      if (event.eventType === 'task.completed') {
        void engine.notifyTaskCompleted({
          runId: event.runId,
          nodeId: event.taskId,
          output: event.output,
        });
      }
    });

    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          title: 'Manual',
          position: { x: 0, y: 0 },
          config: { kind: 'trigger', triggerType: 'manual' },
        },
        {
          id: 'draft',
          type: 'agent_task',
          title: 'Send',
          position: { x: 200, y: 0 },
          config: {
            kind: 'agent_task',
            agentId,
            prompt: 'Send one message and return its receipt.',
            inputKeys: [],
            outputKeys: ['sent_count', 'failed_count', 'status'],
            capabilityTags: [],
          },
        },
      ],
      edges: [{ id: 'trigger-to-draft', source: 'trigger', target: 'draft' }],
    };
    const { runId, workflowId, initialState } = persistWorkflow(graph);
    const terminal = waitForTerminal(runId);

    await engine.startRun({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId,
      userId: ctx.user.id,
      triggerId: null,
      inputs: {},
      initialState,
      graph,
    });
    await terminal;

    const run = ctx.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .get()!;
    const state = run.runState as {
      nodeStates: Record<string, {
        status?: string;
        outputData?: Record<string, unknown>;
        contractDeviation?: {
          kind: string;
          declaredKeys: string[];
          missingKeys: string[];
          recoveredKeys: string[];
          message: string;
        };
      }>;
      contractViolations?: string[];
    };
    expect(run.status).toBe('FAILED');
    expect(state.nodeStates.draft?.status).toBe('FAILED');
    expect((state.nodeStates.draft as { error?: string })?.error).toMatch(/OUTPUT_CONTRACT_UNSATISFIED/);
  });

  it('executes custom manifest integrations through the engine path', async () => {
    vi.stubEnv('AGENTIS_INTEGRATION_HTTP_ALLOW_PRIVATE', 'true');
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        url: String(url),
        headers: new Headers({ 'content-type': 'application/json' }),
        async text() { return JSON.stringify({ id: 'msg_1' }); },
      } as unknown as Response;
    }));

    createCustomIntegrationManifest(
      ctx.db,
      { workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id },
      normalizeIntegrationManifest({
        service: 'custom_mailer',
        name: 'Custom Mailer',
        version: '1.0.0',
        category: 'Communication',
        description: 'A custom manifest-backed mailer.',
        auth: { type: 'none' },
        operationSpecs: [{
          name: 'send',
          method: 'POST',
          urlTemplate: 'https://custom.example.test/send',
          bodyTemplate: {
            to: '{{params.to}}',
            subject: '{{params.subject}}',
            text: '{{params.text}}',
          },
          paramSchema: { type: 'object', required: ['to', 'subject', 'text'] },
        }],
      }),
    );

    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'send',
          type: 'integration',
          title: 'Send',
          position: { x: 0, y: 0 },
          config: {
            kind: 'integration',
            integrationId: 'custom_mailer',
            operationId: 'send',
            inputs: { to: 'op@example.com', subject: 'Hello', text: 'Body' },
          },
        },
      ],
      edges: [],
    };
    const { workflowId } = persistWorkflow(graph);
    const engine = makeEngine(new AdapterManager(ctx.logger));

    const result = await engine.testNode({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      workflowId,
      nodeId: 'send',
      inputs: {},
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://custom.example.test/send');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      to: 'op@example.com',
      subject: 'Hello',
      text: 'Body',
    });
  });
});

function makeEngine(adapters: AdapterManager): WorkflowEngine {
  return new WorkflowEngine({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    extensions: {} as unknown as ExtensionRuntime,
    adapters,
  });
}

function persistWorkflow(graph: WorkflowGraph): {
  workflowId: string;
  runId: string;
  initialState: ReturnType<typeof buildInitialRunState>;
} {
  const workflowId = randomUUID();
  const runId = randomUUID();
  const initialState = buildInitialRunState({ runId, workflowId, graph, inputs: {} });
  ctx.db.insert(schema.workflows).values({
    id: workflowId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    title: 'Output contracts',
    graph,
    settings: {},
  }).run();
  ctx.db.insert(schema.workflowRuns).values({
    id: runId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId,
    userId: ctx.user.id,
    status: 'CREATED',
    runState: initialState,
  }).run();
  return { workflowId, runId, initialState };
}

function waitForTerminal(runId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
    const unsubscribe = ctx.bus.subscribe((message) => {
      if (
        message.room === `run:${runId}`
        && (
          message.envelope.event === REALTIME_EVENTS.RUN_COMPLETED
          || message.envelope.event === REALTIME_EVENTS.RUN_FAILED
        )
      ) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}
