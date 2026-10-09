/**
 * /v1/runs — list, get, cancel, ledger, snapshot.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  AgentisError,
  REALTIME_ROOMS,
  schemas,
  type WorkflowGraph,
  type WorkflowGraphPatch,
  type WorkflowSelfHealIncident,
  type WorkflowRunState,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { EventBus } from '../event-bus.js';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import type { LedgerService } from '../services/ledger.js';
import type { ScratchpadService } from '../services/scratchpad.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { failedNodeCount, firstFailedNodeId, isFailedNodeId } from '../services/run/runStateFailures.js';
import type { ColdArchiveStore } from '../services/storage/coldArchiveStore.js';
import { normalizeRunOutcomeStatus } from '../services/workflow/runOutcome.js';
import type { AgentMissionService } from '../services/agentMissions.js';

export function buildRunRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  engine: WorkflowEngine;
  ledger: LedgerService;
  scratchpad: ScratchpadService;
  bus: EventBus;
  archiveStore?: ColdArchiveStore;
  missions?: AgentMissionService;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 200);
    const status = normalizeRunStatus(c.req.query('status'));
    const workflowId = c.req.query('workflowId')?.trim() || null;
    const filters = [eq(schema.workflowRuns.workspaceId, ws.workspaceId)];
    if (status.length > 0) filters.push(inArray(schema.workflowRuns.status, status));
    if (workflowId) filters.push(eq(schema.workflowRuns.workflowId, workflowId));
    const predicate = filters.length > 1 ? and(...filters) : filters[0];
    const rows = deps.db
      .select()
      .from(schema.workflowRuns)
      .where(predicate)
      .orderBy(desc(schema.workflowRuns.createdAt))
      .limit(limit)
      .all();
    const workflowsById = loadWorkflowMap(deps.db, ws.workspaceId, rows.map((row) => row.workflowId));
    const agentsById = loadAgentMap(deps.db, ws.workspaceId, collectRunAgentIds(rows));
    const tokenUsageMap = loadBatchRunTokenUsage(deps.db, ws.workspaceId, rows.map((row) => row.id));
    return c.json({
      runs: rows.map((row) => presentRunSummary(row, workflowsById.get(row.workflowId ?? ''), agentsById, tokenUsageMap.get(row.id))),
    });
  });

  app.get('/interrupted', (c) => {
    const ws = getWorkspace(c);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 200);
    const rows = deps.db
      .select()
      .from(schema.workflowRuns)
      .where(and(
        eq(schema.workflowRuns.workspaceId, ws.workspaceId),
        inArray(schema.workflowRuns.status, ['RUNNING', 'WAITING', 'PAUSED']),
      ))
      .orderBy(desc(schema.workflowRuns.updatedAt))
      .limit(limit)
      .all();
    const workflowsById = loadWorkflowMap(deps.db, ws.workspaceId, rows.map((row) => row.workflowId));
    const agentsById = loadAgentMap(deps.db, ws.workspaceId, collectRunAgentIds(rows));
    const tokenUsageMap = loadBatchRunTokenUsage(deps.db, ws.workspaceId, rows.map((row) => row.id));
    return c.json({
      runs: rows.map((row) => presentRunSummary(row, workflowsById.get(row.workflowId ?? ''), agentsById, tokenUsageMap.get(row.id))),
    });
  });
  // Per-node run history — one call backs the canvas node card's
  // realtime/history/output view so it never has to fan out to N run details.
  // Returns recent runs of a workflow projected onto a single node:
  // status, duration, output summary + full output, error.
  app.get('/node-history', (c) => {
    const ws = getWorkspace(c);
    const workflowId = c.req.query('workflowId');
    const nodeId = c.req.query('nodeId');
    if (!workflowId || !nodeId) {
      throw new AgentisError('VALIDATION_FAILED', 'workflowId and nodeId are required');
    }
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 8), 1), 30);
    const workflow = deps.db
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.id, workflowId), eq(schema.workflows.workspaceId, ws.workspaceId)))
      .get() ?? null;
    const rows = deps.db
      .select()
      .from(schema.workflowRuns)
      .where(and(eq(schema.workflowRuns.workspaceId, ws.workspaceId), eq(schema.workflowRuns.workflowId, workflowId)))
      .orderBy(desc(schema.workflowRuns.createdAt))
      .limit(limit)
      .all();
    const history = rows.map((run) => {
      const state = (deps.archiveStore?.hydrateRunState(run.runState) ?? run.runState) as WorkflowRunState;
      const graph = resolveRunGraph(run, workflow ?? undefined);
      const node = buildRunNodes(graph, state).find((n) => n.nodeId === nodeId) ?? null;
      return {
        runId: run.id,
        runStatus: mapRunStatus(run.status),
        startedAt: run.startedAt ?? run.createdAt,
        finishedAt: run.completedAt ?? undefined,
        node: node
          ? {
              status: node.status,
              durationMs: node.durationMs,
              outputSummary: node.outputSummary,
              output: node.output,
              error: node.error,
            }
          : null,
      };
    });
    return c.json({ history });
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const run = loadRunRow(deps.db, ws.workspaceId, id);
    const workflow = run.workflowId
      ? deps.db
        .select()
        .from(schema.workflows)
        .where(and(eq(schema.workflows.id, run.workflowId), eq(schema.workflows.workspaceId, ws.workspaceId)))
        .get()
      : null;
    const agentsById = loadAgentMap(deps.db, ws.workspaceId, collectRunAgentIds([run]));
    const tokenUsage = loadRunTokenUsage(deps.db, ws.workspaceId, run.id);
    const hydrated = deps.archiveStore
      ? { ...run, runState: deps.archiveStore.hydrateRunState(run.runState) as object }
      : run;
    const mission = run.missionId && deps.missions ? deps.missions.inspect(ws.workspaceId, run.missionId) : null;
    return c.json({ run: { ...presentRunDetail(hydrated, workflow ?? null, agentsById, tokenUsage), mission } });
  });

  app.post('/:id/cancel', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    loadRunRow(deps.db, ws.workspaceId, id);
    await deps.engine.cancelRun(id);
    return c.json({ ok: true });
  });

  app.post('/:id/resume', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    loadRunRow(deps.db, ws.workspaceId, id);
    const result = await deps.engine.resumeBlockedRun(id);
    return c.json({ ok: true, ...result });
  });

  // LAYER 1: replayable activity tail — a surface opened mid-run back-fills the
  // recent reasoning/tool/step history, then streams live (no "EVENTS 0").
  app.get('/:id/activity', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    loadRunRow(deps.db, ws.workspaceId, id);
    const requested = Number(c.req.query('limit'));
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(Math.floor(requested), 400)) : 400;
    const activity = deps.engine.getRunActivity(id, { limit, cursor: c.req.query('cursor') });
    return c.json({
      activity,
      nextCursor: activity.length === limit ? activity.at(-1)?.emittedAt ?? null : null,
    });
  });

  // TRANSPORT: a run-scoped SSE stream — every run-room event (node/run status,
  // agent reasoning, tool calls) live, independent of the websocket. This is what
  // makes a watched run's realtime work even when the socket can't connect. It
  // first replays the in-memory tail (so a late joiner sees recent history), then
  // relays raw bus envelopes for the run room with their original event names so
  // the client's `useRealtime` consumers pick them up unchanged.
  app.get('/:id/stream', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    loadRunRow(deps.db, ws.workspaceId, id);
    const runRoom = REALTIME_ROOMS.run(id);
    return streamSSE(c, async (stream) => {
      let closed = false;
      let unsubscribe: () => void = () => {};
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
      };
      const write = async (event: string, data: unknown) => {
        if (closed) return;
        try {
          await stream.writeSSE({ event, data: JSON.stringify(data) });
        } catch {
          close();
        }
      };
      // Replay the recent tail first.
      for (const env of deps.engine.getRunActivity(id)) {
        await write(env.event, env.payload);
      }
      // Then stream live run-room events.
      unsubscribe = deps.bus.subscribe((message) => {
        if (message.room !== runRoom) return;
        void write(message.envelope.event, message.envelope.payload);
      });
      heartbeat = setInterval(() => {
        void write('heartbeat', { type: 'HEARTBEAT', at: new Date().toISOString() });
      }, 15_000);
      if (typeof heartbeat === 'object' && 'unref' in heartbeat) heartbeat.unref();
      c.req.raw.signal.addEventListener('abort', close, { once: true });
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      close();
    });
  });

  app.get('/:id/ledger', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    loadRunRow(deps.db, ws.workspaceId, id);
    const after = c.req.query('after_sequence')
      ? Number(c.req.query('after_sequence'))
      : undefined;
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
    const events = await deps.ledger.listForRun({ runId: id, afterSequence: after, limit });
    return c.json({ events });
  });

  app.get('/:id/scratchpad', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    loadRunRow(deps.db, ws.workspaceId, id);
    const scratchpad = deps.scratchpad.snapshotOf(id);
    const entries = Object.entries(scratchpad).map(([key, value]) => ({
      key,
      value,
      updatedAt: new Date().toISOString(),
    }));
    return c.json({ scratchpad, entries });
  });

  // Durable, identity-tagged blackboard log — the operator Blackboard panel
  // hydrates from here, then streams live via BLACKBOARD_ENTRY events.
  // Optional ?namespace= filters to a convergence loop's state. (§Pillar 2/3.)
  app.get('/:id/blackboard', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    loadRunRow(deps.db, ws.workspaceId, id);
    const namespace = c.req.query('namespace') || undefined;
    const entries = deps.scratchpad.listEntries(id, namespace ? { namespace } : undefined);
    return c.json({ entries });
  });

  // V1-SPEC §6.6 — apply a graph patch to a (possibly live) run.
  app.post('/:id/graph-patches', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    loadRunRow(deps.db, ws.workspaceId, id);
    const patch = schemas.workflowGraphPatchSchema.parse(await c.req.json()) as WorkflowGraphPatch;
    const result = await deps.engine.applyGraphPatch({ runId: id, patch });
    return c.json({ runId: id, patchId: patch.patchId, ...result });
  });

  app.post('/:id/pause', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    loadRunRow(deps.db, ws.workspaceId, id);
    await deps.engine.pauseRun(id);
    return c.json({ ok: true });
  });

  app.post('/:id/self-heal/checkpoints/:checkpointId/rollback', async (c) => {
    const ws = getWorkspace(c);
    const runId = c.req.param('id');
    loadRunRow(deps.db, ws.workspaceId, runId);
    const result = await deps.engine.rollbackSelfHeal({ runId, checkpointId: c.req.param('checkpointId') });
    return c.json({ runId, ...result });
  });

  return app;
}

function normalizeRunStatus(status: string | undefined): string[] {
  const value = status?.trim().toUpperCase();
  if (!value) return [];
  if (value === 'ACTIVE') return ['RUNNING', 'WAITING', 'PAUSED', 'CREATED'];
  if (value === 'PENDING') return ['CREATED', 'PLANNING', 'WAITING'];
  if (value === 'FAILED') return ['FAILED', 'COMPLETED_WITH_ERRORS'];
  const allowed = new Set([
    'CREATED',
    'PLANNING',
    'RUNNING',
    'PAUSED',
    'WAITING',
    'COMPLETED',
    'COMPLETED_WITH_CONTRACT_VIOLATION',
    'COMPLETED_WITH_ERRORS',
    'FAILED',
    'CANCELLED',
  ]);
  return allowed.has(value) ? [value] : [];
}

type WorkflowRunRow = typeof schema.workflowRuns.$inferSelect;
type WorkflowRow = typeof schema.workflows.$inferSelect;

function loadRunRow(db: AgentisSqliteDb, workspaceId: string, id: string) {
  const run = db
    .select()
    .from(schema.workflowRuns)
    .where(and(eq(schema.workflowRuns.id, id), eq(schema.workflowRuns.workspaceId, workspaceId)))
    .get();
  if (!run) throw new AgentisError('WORKFLOW_RUN_NOT_FOUND', 'Run not found');
  return run;
}

function loadWorkflowMap(
  db: AgentisSqliteDb,
  workspaceId: string,
  workflowIds: Array<string | null>,
): Map<string, WorkflowRow> {
  const ids = [...new Set(workflowIds.filter((workflowId): workflowId is string => Boolean(workflowId)))];
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, workspaceId), inArray(schema.workflows.id, ids)))
      .all()
      .map((workflow) => [workflow.id, workflow]),
  );
}

function loadAgentMap(
  db: AgentisSqliteDb,
  workspaceId: string,
  agentIds: string[],
): Map<string, { id: string; name: string }> {
  const ids = [...new Set(agentIds)];
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select({ id: schema.agents.id, name: schema.agents.name })
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), inArray(schema.agents.id, ids)))
      .all()
      .map((agent) => [agent.id, agent]),
  );
}

function collectRunAgentIds(rows: WorkflowRunRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    const state = row.runState as WorkflowRunState;
    for (const execution of Object.values(state.activeExecutions ?? {})) {
      if (execution.executorType === 'agent' && execution.executorRef) ids.add(execution.executorRef);
    }
  }
  return [...ids];
}

function presentRunSummary(
  run: WorkflowRunRow,
  workflow: WorkflowRow | undefined,
  agentsById: Map<string, { id: string; name: string }>,
  tokenUsage?: { tokensIn: number; tokensOut: number },
) {
  const state = run.runState as WorkflowRunState;
  const graph = resolveRunGraph(run, workflow);
  const currentNodeId = currentRunNodeId(state);
  const currentNode = currentNodeId ? graph.nodes.find((node) => node.id === currentNodeId) : null;
  const failedNodeId = firstFailedNodeId(state);
  const failedNode = failedNodeId ? graph.nodes.find((node) => node.id === failedNodeId) : null;
  const selfHealIncident = presentSelfHealIncident(state, {
    preferredNodeId: failedNodeId ?? currentNodeId ?? undefined,
    failedNodeId: failedNodeId ?? undefined,
  });
  const totalSteps = graph.nodes.length > 0 ? graph.nodes.length : undefined;
  const failed = failedNodeCount(state);
  const stepIndex = totalSteps
    ? Math.min(totalSteps, (state.completedNodeIds?.length ?? 0) + failed + (currentNode ? 1 : 0))
    : undefined;
  return {
    id: run.id,
    workflowId: run.workflowId ?? '',
    workflowName: workflow?.title ?? run.ephemeralTitle ?? undefined,
    status: mapRunSummaryStatus(run, state),
    executionStatus: run.executionStatus,
    outcomeStatus: normalizeRunOutcomeStatus(run.outcomeStatus),
    settlement: run.settlement,
    revisionId: run.workflowRevisionId,
    createdAt: run.createdAt,
    startedAt: run.startedAt ?? run.createdAt,
    completedAt: run.completedAt ?? null,
    finishedAt: run.completedAt ?? null,
    durationMs: computeDurationMs(run.startedAt ?? run.createdAt, run.completedAt),
    currentStep: currentNode?.title,
    totalSteps,
    stepIndex,
    failedNodeId: failedNodeId ?? undefined,
    failedNode: failedNode?.title ?? failedNodeId ?? undefined,
    failureReason: failedNodeId ? state.nodeStates?.[failedNodeId]?.error ?? null : null,
    selfHealIncident,
    agents: collectRunAgents(state, agentsById),
    tokenUsage: {
      input: tokenUsage?.tokensIn ?? 0,
      output: tokenUsage?.tokensOut ?? 0,
      total: (tokenUsage?.tokensIn ?? 0) + (tokenUsage?.tokensOut ?? 0),
    },
  };
}

function presentRunDetail(
  run: WorkflowRunRow,
  workflow: WorkflowRow | null,
  agentsById: Map<string, { id: string; name: string }>,
  tokenUsage: { tokensIn: number; tokensOut: number } = { tokensIn: 0, tokensOut: 0 },
) {
  const state = run.runState as WorkflowRunState;
  const graph = resolveRunGraph(run, workflow ?? undefined);
  const nodes = buildRunNodes(graph, state);
  const selfHealIncident = presentSelfHealIncident(state, { failedNodeId: firstFailedNodeId(state) ?? undefined });
  const completedCount = nodes.filter((node) => node.status === 'completed').length;
  const failedCount = nodes.filter((node) => node.status === 'failed').length;
  const activeAgents = collectRunAgents(state, agentsById);
  // A run blocked on a recoverable failure (out of credits) is PAUSED — distinct
  // from a generic WAITING (scheduled/approval) — so the UI shows Resume + reason.
  const blockedNode = Object.values(state?.nodeStates ?? {}).find((n) => n?.status === 'WAITING' && n?.blockedReason);
  const status = blockedNode
    ? 'paused' as const
    : run.status === 'WAITING'
      ? 'waiting' as const
      : mapRunStatus(run.status);
  return {
    id: run.id,
    workflowId: run.workflowId ?? '',
    workflowName: workflow?.title ?? run.ephemeralTitle ?? 'Run',
    status,
    executionStatus: run.executionStatus,
    outcomeStatus: normalizeRunOutcomeStatus(run.outcomeStatus),
    settlement: run.settlement,
    revisionId: run.workflowRevisionId,
    ...(blockedNode?.blockedReason ? { blockedReason: blockedNode.blockedReason } : {}),
    startedAt: run.startedAt ?? run.createdAt,
    finishedAt: run.completedAt ?? undefined,
    // SWIFT layer 3 — the run's world-verified outcome (checks + evidence +
    // deficiencies), when the workflow carries a spec. Completion is not accomplishment.
    ...((state as unknown as { verdict?: unknown }).verdict ? { verdict: (state as unknown as { verdict?: unknown }).verdict } : {}),
    selfHealIncident,
    durationMs: computeDurationMs(run.startedAt ?? run.createdAt, run.completedAt),
    triggeredBy: 'manual',
    keyMetrics: [
      { label: 'Completed nodes', value: completedCount },
      { label: 'Failed nodes', value: failedCount },
      { label: 'Active agents', value: activeAgents.length },
      { label: 'Tokens', value: tokenUsage.tokensIn + tokenUsage.tokensOut },
    ],
    tokenUsage: {
      input: tokenUsage.tokensIn,
      output: tokenUsage.tokensOut,
      total: tokenUsage.tokensIn + tokenUsage.tokensOut,
    },
    nodes,
  };
}

function presentSelfHealIncident(
  state: WorkflowRunState,
  opts: { preferredNodeId?: string; failedNodeId?: string } = {},
): WorkflowSelfHealIncident | null {
  const incidents = Object.values(state.selfHealIncidents ?? {});
  if (incidents.length === 0) return null;
  const latest = (list: WorkflowSelfHealIncident[]): WorkflowSelfHealIncident | null =>
    list.slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] ?? null;

  // 1) The incident for the node we care about most (the failed / current node).
  if (opts.preferredNodeId) {
    const exact = incidents.find((incident) => incident.nodeId === opts.preferredNodeId);
    if (exact) return exact;
  }

  // 2) Correctness guard: a run that FAILED at a node with no self-heal incident
  //    of its own must NEVER headline a stale APPLIED ("self-healed") incident
  //    from a different, successful node — that's the "it says it worked and it
  //    didn't" lie. Surface an unresolved incident if one is genuinely open,
  //    otherwise nothing (the failed-node detail tells the real story).
  if (opts.failedNodeId && !incidents.some((i) => i.nodeId === opts.failedNodeId)) {
    return latest(incidents.filter((i) => i.status !== 'APPLIED'));
  }

  return latest(incidents);
}

// Per-run token usage reads the SAME sink as runAnalytics: the terminal
// `node.completed` audit entries (`tokens_in/out`), written by every agent
// execution path regardless of runtime. The `agent_sessions` table this used to
// sum is never populated for non-agent_task runtimes (extension/CLI/deterministic
// nodes), so mixed-runtime workflows used to read 0 while their real usage sat
// in the audit trail.
function loadRunTokenUsage(db: AgentisSqliteDb, workspaceId: string, runId: string): { tokensIn: number; tokensOut: number } {
  const row = db.select({
    tokensIn: sql<number>`coalesce(sum(${schema.auditEntries.tokensIn}), 0)`,
    tokensOut: sql<number>`coalesce(sum(${schema.auditEntries.tokensOut}), 0)`,
  })
    .from(schema.auditEntries)
    .where(and(eq(schema.auditEntries.workspaceId, workspaceId), eq(schema.auditEntries.runId, runId)))
    .get();
  return { tokensIn: Number(row?.tokensIn ?? 0), tokensOut: Number(row?.tokensOut ?? 0) };
}

function loadBatchRunTokenUsage(db: AgentisSqliteDb, workspaceId: string, runIds: string[]): Map<string, { tokensIn: number; tokensOut: number }> {
  if (runIds.length === 0) return new Map();
  const rows = db.select({
    runId: schema.auditEntries.runId,
    tokensIn: sql<number>`coalesce(sum(${schema.auditEntries.tokensIn}), 0)`,
    tokensOut: sql<number>`coalesce(sum(${schema.auditEntries.tokensOut}), 0)`,
  })
    .from(schema.auditEntries)
    .where(and(eq(schema.auditEntries.workspaceId, workspaceId), inArray(schema.auditEntries.runId, runIds)))
    .groupBy(schema.auditEntries.runId)
    .all();

  const map = new Map<string, { tokensIn: number; tokensOut: number }>();
  for (const row of rows) {
    if (row.runId) {
      map.set(row.runId, { tokensIn: Number(row.tokensIn), tokensOut: Number(row.tokensOut) });
    }
  }
  return map;
}

function buildRunNodes(graph: WorkflowGraph, state: WorkflowRunState) {
  const ids = new Set<string>();
  for (const node of graph.nodes) ids.add(node.id);
  for (const nodeId of Object.keys(state.nodeStates ?? {})) ids.add(nodeId);

  return [...ids].map((nodeId) => {
    const graphNode = graph.nodes.find((node) => node.id === nodeId);
    const nodeState = state.nodeStates?.[nodeId];
    return {
      id: nodeId,
      nodeId,
      title: graphNode?.title ?? nodeId,
      type: graphNode?.type ?? 'unknown',
      kind: graphNode?.config.kind ?? graphNode?.type ?? 'unknown',
      status: mapNodeStatus(nodeId, state),
      startedAt: nodeState?.startedAt,
      finishedAt: nodeState?.completedAt,
      durationMs: computeDurationMs(nodeState?.startedAt, nodeState?.completedAt),
      output: nodeState?.outputData,
      outputSummary: summarizeValue(nodeState?.outputData),
      inputs: nodeState?.inputData,
      // A completed node's input is dropped from the persisted snapshot to keep
      // run_state small — it equals the upstream nodes' output (shown above).
      inputOmitted: nodeState?.inputOmitted ?? false,
      error: nodeState?.error,
      ...(nodeState?.blockedReason ? { blockedReason: nodeState.blockedReason } : {}),
    };
  });
}

function resolveRunGraph(run: WorkflowRunRow, workflow: WorkflowRow | undefined): WorkflowGraph {
  const fromSnapshot = run.graphSnapshot as WorkflowGraph | null;
  const fromWorkflow = workflow?.graph as WorkflowGraph | undefined;
  return fromSnapshot ?? fromWorkflow ?? {
    version: 1,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

function currentRunNodeId(state: WorkflowRunState): string | null {
  return Object.keys(state.activeExecutions ?? {})[0] ?? state.readyQueue?.[0]?.nodeId ?? null;
}

function collectRunAgents(
  state: WorkflowRunState,
  agentsById: Map<string, { id: string; name: string }>,
): Array<{ id: string; name: string }> {
  const ids = new Set<string>();
  for (const execution of Object.values(state.activeExecutions ?? {})) {
    if (execution.executorType === 'agent' && execution.executorRef) ids.add(execution.executorRef);
  }
  return [...ids].map((id) => ({ id, name: agentsById.get(id)?.name ?? id }));
}

type UiRunStatus = 'running' | 'completed' | 'completed_with_issues' | 'failed' | 'pending' | 'cancelled' | 'paused' | 'waiting';

function mapRunSummaryStatus(run: WorkflowRunRow, state: WorkflowRunState): UiRunStatus {
  if (run.status === 'PAUSED') return 'paused';
  const blockedNode = Object.values(state.nodeStates ?? {}).find((node) => node.status === 'WAITING' && node.blockedReason);
  if (blockedNode) return 'paused';
  if (run.status === 'WAITING') return 'waiting';
  return mapRunStatus(run.status);
}

function mapRunStatus(status: string): Exclude<UiRunStatus, 'waiting'> {
  switch (status) {
    case 'COMPLETED':
      return 'completed';
    // A contract violation means the run finished but its output was off-spec —
    // NOT a clean success. Surface it as its own "needs attention" state instead
    // of a green completed, so "completed ≠ accomplished" is visible in the list.
    case 'COMPLETED_WITH_CONTRACT_VIOLATION':
      return 'completed_with_issues';
    case 'COMPLETED_WITH_ERRORS':
    case 'FAILED':
      return 'failed';
    case 'CANCELLED':
      return 'cancelled';
    case 'PAUSED':
      return 'paused';
    case 'RUNNING':
      return 'running';
    default:
      return 'pending';
  }
}

function mapNodeStatus(nodeId: string, state: WorkflowRunState): 'completed' | 'failed' | 'running' | 'skipped' | 'pending' | 'waiting' {
  if (isFailedNodeId(state, nodeId)) return 'failed';
  if (state.completedNodeIds?.includes(nodeId) || state.nodeStates?.[nodeId]?.status === 'COMPLETED') return 'completed';
  if (state.skippedNodeIds?.includes(nodeId) || state.nodeStates?.[nodeId]?.status === 'SKIPPED') return 'skipped';
  if (state.activeExecutions?.[nodeId] || state.nodeStates?.[nodeId]?.status === 'RUNNING') return 'running';
  if (state.nodeStates?.[nodeId]?.status === 'WAITING') return 'waiting';
  return 'pending';
}

function computeDurationMs(startedAt?: string | null, finishedAt?: string | null): number | undefined {
  if (!startedAt || !finishedAt) return undefined;
  const duration = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function summarizeValue(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value.length > 72 ? `${value.slice(0, 69)}...` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length > 0 ? `${value.length} items` : '0 items';
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    return keys.slice(0, 3).join(', ');
  }
  return undefined;
}
