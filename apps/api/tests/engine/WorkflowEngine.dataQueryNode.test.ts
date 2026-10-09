/**
 * WorkflowEngine — `data_query` node (masterplan 4.x).
 *
 * A workflow can read (rows) or aggregate an Agentic App datastore collection.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS, type WorkflowGraph } from '@agentis/core';
import { AppStore, AppDatastore } from '@agentis/app';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { buildInitialRunState } from '../../src/engine/initialRunState.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let appId: string;
beforeEach(async () => {
  ctx = await createTestContext();
  const ds = new AppDatastore(ctx.db);
  appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Sales' }).id;
  ds.defineCollection(ctx.workspace.id, appId, { name: 'deals', schema: { fields: [{ key: 'stage', type: 'string', required: true }, { key: 'amount', type: 'number' }] } });
  for (const r of [{ stage: 'won', amount: 100 }, { stage: 'won', amount: 250 }, { stage: 'lost', amount: 50 }]) ds.insert(ctx.workspace.id, appId, 'deals', r);
});
afterEach(() => ctx.close());

async function runDataQuery(
  config: Record<string, unknown>,
  options: { quietWorkspaceEvents?: boolean; workspaceEvents?: string[] } = {},
): Promise<Record<string, unknown>> {
  const graph = {
    version: 1, viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 't', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'Q', type: 'data_query', title: 'q', position: { x: 1, y: 0 }, config: { kind: 'data_query', appId, collection: 'deals', ...config } },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'Q' }],
  } as unknown as WorkflowGraph;
  const wfId = randomUUID();
  const runId = randomUUID();
  ctx.db.insert(schema.workflows).values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'q-wf', graph, settings: {} }).run();
  ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'CREATED', runState: {} }).run();

  const engine = new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    extensions: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
    appData: new AppDatastore(ctx.db),
  });
  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
  const stopWorkspaceCapture = ctx.bus.subscribe((message) => {
    if (message.room === REALTIME_ROOMS.workspace(ctx.workspace.id)) {
      options.workspaceEvents?.push(message.envelope.event);
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room === `run:${runId}` && (m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED || m.envelope.event === REALTIME_EVENTS.RUN_FAILED)) { clearTimeout(timer); off(); resolve(); }
    });
    void engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph, quietWorkspaceEvents: options.quietWorkspaceEvents });
  });
  stopWorkspaceCapture();
  const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
  expect(run.status).toBe('COMPLETED');
  const state = run.runState as { nodeStates: Record<string, { outputData?: Record<string, unknown> }> };
  return state.nodeStates.Q?.outputData ?? {};
}

describe('WorkflowEngine — data_query node', () => {
  it('reads rows with a filter', async () => {
    const out = await runDataQuery({ mode: 'query', filter: { stage: 'won' }, outputKey: 'deals' });
    const deals = out.deals as Array<{ data: { stage: string } }>;
    expect(deals).toHaveLength(2);
    expect(deals.every((d) => d.data.stage === 'won')).toBe(true);
  });

  it('aggregates (sum grouped by stage)', async () => {
    const out = await runDataQuery({ mode: 'aggregate', op: 'sum', field: 'amount', groupBy: 'stage', outputKey: 'totals' });
    const totals = out.totals as Array<{ group: string; value: number }>;
    const byStage = Object.fromEntries(totals.map((t) => [t.group, t.value]));
    expect(byStage).toEqual({ won: 350, lost: 50 });
  });

  it('paginates internally, returning every row across pages', async () => {
    // 3 seeded + 22 more = 25 rows; page size 10 → 3 internal pages.
    const ds = new AppDatastore(ctx.db);
    for (let i = 0; i < 22; i += 1) ds.insert(ctx.workspace.id, appId, 'deals', { stage: 'won', amount: i });
    const out = await runDataQuery({ mode: 'query', paginate: true, limit: 10, outputKey: 'deals' });
    expect((out.deals as unknown[]).length).toBe(25);
    expect(out.count).toBe(25);
  });

  it('keeps internal query lifecycle events out of the workspace notification room', async () => {
    const workspaceEvents: string[] = [];
    await runDataQuery({ mode: 'query', outputKey: 'deals' }, { quietWorkspaceEvents: true, workspaceEvents });
    expect(workspaceEvents).not.toContain(REALTIME_EVENTS.RUN_RUNNING);
    expect(workspaceEvents).not.toContain(REALTIME_EVENTS.RUN_COMPLETED);
    expect(workspaceEvents).not.toContain(REALTIME_EVENTS.RUN_SETTLED);
  });
});
