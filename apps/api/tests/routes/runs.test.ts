/**
 * /v1/runs — route unit tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { WorkflowGraph, WorkflowRunState } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { buildRunRoutes } from '../../src/routes/runs.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import type { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';

let ctx: TestContext;
let engine: {
  startRun: ReturnType<typeof vi.fn>;
  cancelRun: ReturnType<typeof vi.fn>;
  resumeBlockedRun: ReturnType<typeof vi.fn>;
  applyGraphPatch: ReturnType<typeof vi.fn>;
  getRunActivity: ReturnType<typeof vi.fn>;
};
let ledger: LedgerService;
let scratchpad: ScratchpadService;

beforeEach(async () => {
  ctx = await createTestContext();
  engine = {
    startRun: vi.fn().mockResolvedValue(undefined),
    cancelRun: vi.fn().mockResolvedValue(undefined),
    resumeBlockedRun: vi.fn().mockResolvedValue({ resumed: 1 }),
    applyGraphPatch: vi.fn().mockResolvedValue({ newRevision: 2 }),
    getRunActivity: vi.fn().mockReturnValue([]),
  };
  ledger = new LedgerService(ctx.db, ctx.bus);
  scratchpad = new ScratchpadService(ctx.bus, ctx.logger);
});

function app() {
  return ctx.buildApp([
    {
      path: '/v1/runs',
      app: buildRunRoutes({
        db: ctx.db,
        auth: ctx.auth,
        engine: engine as unknown as WorkflowEngine,
        ledger,
        scratchpad,
      }),
    },
  ]);
}

function seedRun() {
  const wfId = randomUUID();
  const runId = randomUUID();
  const graph: WorkflowGraph = {
    version: 1,
    nodes: [
      {
        id: 'writer',
        type: 'agent_task',
        title: 'Write summary',
        position: { x: 0, y: 0 },
        config: { kind: 'agent_task', prompt: 'Write a summary', capabilityTags: [], inputKeys: [], outputKeys: [] },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  const startedAt = '2026-05-20T10:00:00.000Z';
  const completedAt = '2026-05-20T10:00:05.000Z';
  const runState: WorkflowRunState = {
    runId,
    workflowId: wfId,
    status: 'FAILED',
    readyQueue: [],
    waitingInputs: {},
    nodeStates: {
      writer: {
        nodeId: 'writer',
        status: 'FAILED',
        startedAt,
        completedAt,
        inputData: { topic: 'Status update' },
        outputData: { partial: 'Drafted intro' },
        error: 'model timeout',
      },
    },
    activeExecutions: {},
    completedNodeIds: [],
    failedNodeIds: ['writer'],
    skippedNodeIds: [],
    graphRevision: 0,
    replanCount: 0,
    lastLedgerSequence: 0,
  };
  ctx.db
    .insert(schema.workflows)
    .values({
      id: wfId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'WF',
      graph,
      settings: {},
    })
    .run();
  ctx.db
    .insert(schema.workflowRuns)
    .values({
      id: runId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: wfId,
      userId: ctx.user.id,
      status: 'FAILED',
      runState,
      startedAt,
      completedAt,
    })
    .run();
  return { wfId, runId };
}

function seedHandledErrorRun() {
  const wfId = randomUUID();
  const runId = randomUUID();
  const graph: WorkflowGraph = {
    version: 1,
    nodes: [
      {
        id: 'send',
        type: 'integration',
        title: 'Send Email',
        position: { x: 0, y: 0 },
        config: { kind: 'integration', integrationId: 'agentmail', operationId: 'send_message', inputs: {} } as never,
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  const startedAt = '2026-05-20T10:00:00.000Z';
  const completedAt = '2026-05-20T10:00:05.000Z';
  const runState: WorkflowRunState = {
    runId,
    workflowId: wfId,
    status: 'COMPLETED_WITH_ERRORS',
    readyQueue: [],
    waitingInputs: {},
    nodeStates: {
      send: {
        nodeId: 'send',
        status: 'COMPLETED',
        startedAt,
        completedAt,
        inputData: { approved: true },
        outputData: { approved: true, error: { message: "operation 'send_email' is not supported by agentmail" } },
        error: "operation 'send_email' is not supported by agentmail",
      },
    },
    activeExecutions: {},
    completedNodeIds: ['send'],
    failedNodeIds: [],
    skippedNodeIds: [],
    graphRevision: 0,
    replanCount: 0,
    lastLedgerSequence: 0,
  };
  ctx.db
    .insert(schema.workflows)
    .values({
      id: wfId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'WF with catch',
      graph,
      settings: {},
    })
    .run();
  ctx.db
    .insert(schema.workflowRuns)
    .values({
      id: runId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: wfId,
      userId: ctx.user.id,
      status: 'COMPLETED_WITH_ERRORS',
      runState,
      startedAt,
      completedAt,
    })
    .run();
  return { wfId, runId };
}

function seedPausedRun() {
  const wfId = randomUUID();
  const runId = randomUUID();
  const graph: WorkflowGraph = {
    version: 1,
    nodes: [
      {
        id: 'writer',
        type: 'agent_task',
        title: 'Write summary',
        position: { x: 0, y: 0 },
        config: { kind: 'agent_task', prompt: 'Write a summary', capabilityTags: [], inputKeys: [], outputKeys: [] },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  const startedAt = '2026-05-20T10:00:00.000Z';
  const blockedReason = 'The model account is out of credits. Add credits or switch the agent model, then resume the run.';
  const runState: WorkflowRunState = {
    runId,
    workflowId: wfId,
    status: 'WAITING',
    readyQueue: [],
    waitingInputs: {},
    nodeStates: {
      writer: {
        nodeId: 'writer',
        status: 'WAITING',
        startedAt,
        inputData: { topic: 'Status update' },
        blockedReason,
      },
    },
    activeExecutions: {},
    completedNodeIds: [],
    failedNodeIds: [],
    skippedNodeIds: [],
    graphRevision: 0,
    replanCount: 0,
    lastLedgerSequence: 0,
  };
  ctx.db
    .insert(schema.workflows)
    .values({
      id: wfId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'Paused WF',
      graph,
      settings: {},
    })
    .run();
  ctx.db
    .insert(schema.workflowRuns)
    .values({
      id: runId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: wfId,
      userId: ctx.user.id,
      status: 'WAITING',
      runState,
      startedAt,
    })
    .run();
  return { wfId, runId, blockedReason };
}

/**
 * A run that FAILED at one node (`evaluate`) while a DIFFERENT node (`draft`)
 * carries a stale APPLIED ("self-healed") incident. The presenter must NOT
 * report the run as self-healed — that's the "it says it worked and it didn't"
 * lie. The failed node has no incident of its own.
 */
function seedFailedRunWithStaleAppliedIncident() {
  const wfId = randomUUID();
  const runId = randomUUID();
  const graph: WorkflowGraph = {
    version: 1,
    nodes: [
      { id: 'draft', type: 'agent_task', title: 'Draft', position: { x: 0, y: 0 }, config: { kind: 'agent_task', prompt: 'draft', capabilityTags: [], inputKeys: [], outputKeys: [] } },
      { id: 'evaluate', type: 'evaluator', title: 'Evaluator', position: { x: 200, y: 0 }, config: { kind: 'evaluator' } as never },
    ],
    edges: [{ id: 'e1', source: 'draft', target: 'evaluate' }],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  const runState = {
    runId, workflowId: wfId, status: 'FAILED', readyQueue: [], waitingInputs: {},
    nodeStates: {
      draft: { nodeId: 'draft', status: 'COMPLETED', outputData: { subject: 'x' } },
      evaluate: { nodeId: 'evaluate', status: 'FAILED', error: "evaluator: targetPath '{{nodes.draft}}' did not resolve" },
    },
    activeExecutions: {}, completedNodeIds: ['draft'], failedNodeIds: ['evaluate'], skippedNodeIds: [],
    graphRevision: 0, replanCount: 0, lastLedgerSequence: 0,
    selfHealIncidents: {
      draft: { nodeId: 'draft', nodeTitle: 'Draft', status: 'APPLIED', mode: 'guarded', attempt: 1, maxAttempts: 2, outcome: 'output_fixed', diagnosis: 'Recovered subject from the node output.', startedAt: '2026-05-20T10:00:00.000Z', updatedAt: '2026-05-20T10:00:02.000Z' },
    },
  } as unknown as WorkflowRunState;
  ctx.db.insert(schema.workflows).values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'Digest', graph, settings: {} }).run();
  ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'FAILED', runState, startedAt: '2026-05-20T10:00:00.000Z', completedAt: '2026-05-20T10:00:05.000Z' }).run();
  return { wfId, runId };
}

describe('GET /v1/runs', () => {
  it('lists runs in the workspace', async () => {
    seedRun();
    const res = await app().request('/v1/runs', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runs: Array<{ workflowName?: string; failedNode?: string; durationMs?: number; finishedAt?: string | null }>;
    };
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      workflowName: 'WF',
      failedNode: 'Write summary',
      durationMs: 5000,
      finishedAt: '2026-05-20T10:00:05.000Z',
    });
  });

  it('rejects without auth (401)', async () => {
    const res = await app().request('/v1/runs');
    expect(res.status).toBe(401);
  });

  it('treats COMPLETED_WITH_ERRORS as failed for failed filters', async () => {
    seedHandledErrorRun();
    const res = await app().request('/v1/runs?status=failed', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Array<{ status: string; failedNode?: string }> };
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({ status: 'failed', failedNode: 'Send Email' });
  });

  it('includes operator-paused runs in the active filter', async () => {
    const { runId } = seedPausedRun();
    const res = await app().request('/v1/runs?status=active', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Array<{ id: string; status: string }> };
    expect(body.runs).toEqual([expect.objectContaining({ id: runId, status: 'paused' })]);
  });

  it('filters by workflowId', async () => {
    const { wfId, runId } = seedRun();
    seedHandledErrorRun(); // a second, unrelated workflow run
    const res = await app().request(`/v1/runs?workflowId=${wfId}`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Array<{ id: string }> };
    expect(body.runs).toEqual([expect.objectContaining({ id: runId })]);
  });
});

describe('GET /v1/runs/node-history', () => {
  it('projects recent runs onto a single node (status + output + error)', async () => {
    const { wfId } = seedRun();
    const res = await app().request(
      `/v1/runs/node-history?workflowId=${wfId}&nodeId=writer`,
      { headers: ctx.authHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      history: Array<{
        runId: string;
        runStatus: string;
        node: { status: string; outputSummary?: string; output?: unknown; error?: string } | null;
      }>;
    };
    expect(body.history).toHaveLength(1);
    expect(body.history[0]!.runStatus).toBe('failed');
    expect(body.history[0]!.node).toMatchObject({
      status: 'failed',
      error: 'model timeout',
      outputSummary: 'partial',
    });
    expect(body.history[0]!.node!.output).toMatchObject({ partial: 'Drafted intro' });
  });

  it('returns a null node projection when the node never ran in a run', async () => {
    const { wfId } = seedRun();
    const res = await app().request(
      `/v1/runs/node-history?workflowId=${wfId}&nodeId=does-not-exist`,
      { headers: ctx.authHeaders },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { history: Array<{ node: unknown | null }> };
    expect(body.history).toHaveLength(1);
    expect(body.history[0]!.node).toBeNull();
  });

  it('requires workflowId and nodeId', async () => {
    const res = await app().request('/v1/runs/node-history?workflowId=x', { headers: ctx.authHeaders });
    expect(res.status).toBe(422); // VALIDATION_FAILED
  });
});

describe('GET /v1/runs/:id', () => {
  it('returns an operator-facing run detail payload', async () => {
    const { runId } = seedRun();
    const res = await app().request(`/v1/runs/${runId}`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: {
        workflowName: string;
        status: string;
        durationMs: number;
        nodes: Array<{
          title: string;
          status: string;
          error?: string;
          inputs?: { topic?: string };
          outputSummary?: string;
        }>;
      };
    };
    expect(body.run.workflowName).toBe('WF');
    expect(body.run.status).toBe('failed');
    expect(body.run.durationMs).toBe(5000);
    expect(body.run.nodes).toHaveLength(1);
    expect(body.run.nodes[0]).toMatchObject({
      title: 'Write summary',
      status: 'failed',
      error: 'model timeout',
      inputs: { topic: 'Status update' },
      outputSummary: 'partial',
    });
  });

  it('never reports a failed run as self-healed using a stale incident from another node', async () => {
    const { runId } = seedFailedRunWithStaleAppliedIncident();
    const res = await app().request(`/v1/runs/${runId}`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: { status: string; selfHealIncident: unknown | null } };
    expect(body.run.status).toBe('failed');
    // The failed `evaluate` node has no incident → must NOT surface the APPLIED
    // `draft` incident (the lie).
    expect(body.run.selfHealIncident).toBeNull();
  });

  it('returns 404 with WORKFLOW_RUN_NOT_FOUND for unknown id', async () => {
    const res = await app().request(`/v1/runs/${randomUUID()}`, { headers: ctx.authHeaders });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('WORKFLOW_RUN_NOT_FOUND');
  });

  it('surfaces a handled node error as a failed node in detail', async () => {
    const { runId } = seedHandledErrorRun();
    const res = await app().request(`/v1/runs/${runId}`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: {
        status: string;
        keyMetrics: Array<{ label: string; value: string | number }>;
        nodes: Array<{ title: string; status: string; error?: string }>;
      };
    };
    expect(body.run.status).toBe('failed');
    expect(body.run.keyMetrics).toContainEqual({ label: 'Failed nodes', value: 1 });
    expect(body.run.nodes[0]).toMatchObject({
      title: 'Send Email',
      status: 'failed',
      error: "operation 'send_email' is not supported by agentmail",
    });
  });

  it('surfaces a recoverable model failure as a paused run detail', async () => {
    const { runId, blockedReason } = seedPausedRun();
    const res = await app().request(`/v1/runs/${runId}`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: {
        status: string;
        blockedReason?: string;
        nodes: Array<{ title: string; status: string; blockedReason?: string }>;
      };
    };
    expect(body.run.status).toBe('paused');
    expect(body.run.blockedReason).toBe(blockedReason);
    expect(body.run.nodes[0]).toMatchObject({
      title: 'Write summary',
      status: 'waiting',
      blockedReason,
    });
  });
});

describe('POST /v1/runs/:id/cancel', () => {
  it('calls engine.cancelRun and returns ok', async () => {
    const { runId } = seedRun();
    const res = await app().request(`/v1/runs/${runId}/cancel`, {
      method: 'POST',
      headers: ctx.authHeaders,
    });
    expect(res.status).toBe(200);
    expect(engine.cancelRun).toHaveBeenCalledWith(runId);
  });

  it('returns 404 for unknown run', async () => {
    const res = await app().request(`/v1/runs/${randomUUID()}/cancel`, {
      method: 'POST',
      headers: ctx.authHeaders,
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/runs/:id/ledger', () => {
  it('returns an empty list for a fresh run', async () => {
    const { runId } = seedRun();
    const res = await app().request(`/v1/runs/${runId}/ledger`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
  });
});

describe('GET /v1/runs/:id/activity', () => {
  it('returns bounded durable replay with a cursor', async () => {
    const { runId } = seedRun();
    const events = [
      { activityId: 'runtime-1', event: 'agent.work.step', payload: { activityId: 'runtime-1', transport: 'hermes_acp' }, emittedAt: '2026-05-20T10:00:01.000Z' },
      { activityId: 'reason-1', event: 'agent.terminal.message', payload: { activityId: 'reason-1', activityKind: 'thinking' }, emittedAt: '2026-05-20T10:00:02.000Z' },
    ];
    engine.getRunActivity.mockReturnValue(events);
    const res = await app().request(`/v1/runs/${runId}/activity?limit=2&cursor=2026-05-20T10%3A00%3A00.000Z`, { headers: ctx.authHeaders });

    expect(res.status).toBe(200);
    expect(engine.getRunActivity).toHaveBeenCalledWith(runId, { limit: 2, cursor: '2026-05-20T10:00:00.000Z' });
    expect(await res.json()).toEqual({ activity: events, nextCursor: '2026-05-20T10:00:02.000Z' });
  });

  it('enforces workspace isolation before reading activity', async () => {
    const { runId } = seedRun();
    const otherWorkspace = randomUUID();
    const res = await app().request(`/v1/runs/${runId}/activity`, {
      headers: { ...ctx.authHeaders, 'x-agentis-workspace': otherWorkspace },
    });
    expect(res.status).toBe(403);
    expect(engine.getRunActivity).not.toHaveBeenCalled();
  });
});

describe('POST /v1/runs/:id/resume', () => {
  it('calls engine.resumeBlockedRun and returns the resume count', async () => {
    const { runId } = seedPausedRun();
    const res = await app().request(`/v1/runs/${runId}/resume`, {
      method: 'POST',
      headers: ctx.authHeaders,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, resumed: 1 });
    expect(engine.resumeBlockedRun).toHaveBeenCalledWith(runId);
  });

  it('returns 404 for unknown run', async () => {
    const res = await app().request(`/v1/runs/${randomUUID()}/resume`, {
      method: 'POST',
      headers: ctx.authHeaders,
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/runs/:id/scratchpad', () => {
  it('returns a stable entries array for the drawer', async () => {
    const { runId } = seedRun();
    scratchpad.write(runId, 'message', { subject: 'Hi Alex', body: 'Hi Alex' });
    const res = await app().request(`/v1/runs/${runId}/scratchpad`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scratchpad: Record<string, unknown>; entries: Array<{ key: string; value: unknown }> };
    expect(body.scratchpad).toHaveProperty('message');
    expect(body.entries).toEqual([
      expect.objectContaining({
        key: 'message',
        value: { subject: 'Hi Alex', body: 'Hi Alex' },
      }),
    ]);
  });
});

describe('GET /v1/runs/:id/blackboard', () => {
  it('returns the durable blackboard entries for a run', async () => {
    const { runId } = seedRun();
    scratchpad.write(runId, 'progress', { step: 1 });
    const res = await app().request(`/v1/runs/${runId}/blackboard`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ key?: string; value?: unknown }> };
    expect(body.entries).toEqual([
      expect.objectContaining({ key: 'progress', value: { step: 1 } }),
    ]);
  });

  it('returns 404 with WORKFLOW_RUN_NOT_FOUND for unknown run', async () => {
    const res = await app().request(`/v1/runs/${randomUUID()}/blackboard`, { headers: ctx.authHeaders });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('WORKFLOW_RUN_NOT_FOUND');
  });

  it('rejects without auth (401)', async () => {
    const { runId } = seedRun();
    const res = await app().request(`/v1/runs/${runId}/blackboard`);
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/runs/:id/graph-patches', () => {
  function basePatch(overrides: Record<string, unknown> = {}) {
    return {
      patchId: randomUUID(),
      reason: 'planner_replan',
      baseGraphRevision: 1,
      addNodes: [],
      updateNodes: [],
      removeNodeIds: [],
      addEdges: [],
      removeEdgeIds: [],
      ...overrides,
    };
  }

  it('forwards a valid patch to engine.applyGraphPatch', async () => {
    const { runId } = seedRun();
    const body = basePatch();
    const res = await app().request(`/v1/runs/${runId}/graph-patches`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { runId: string; newRevision: number; patchId: string };
    expect(json).toMatchObject({ runId, newRevision: 2, patchId: body.patchId });
    expect(engine.applyGraphPatch).toHaveBeenCalledTimes(1);
  });

  it('returns 422 on schema-invalid body', async () => {
    const { runId } = seedRun();
    const res = await app().request(`/v1/runs/${runId}/graph-patches`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ reason: 'planner_replan' }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 404 for unknown run', async () => {
    const res = await app().request(`/v1/runs/${randomUUID()}/graph-patches`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify(basePatch()),
    });
    expect(res.status).toBe(404);
  });

  it('rejects unauthenticated requests', async () => {
    const { runId } = seedRun();
    const res = await app().request(`/v1/runs/${runId}/graph-patches`, {
      method: 'POST',
      body: JSON.stringify(basePatch()),
    });
    expect(res.status).toBe(401);
  });
});
