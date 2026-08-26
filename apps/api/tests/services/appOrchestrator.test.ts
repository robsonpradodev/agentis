/**
 * AppOrchestrator — dependsOn chains, binding schedules, concurrency, run-all
 * (APP-INTERFACE-10X §2.3). Uses the same in-memory context as scheduler tests;
 * the engine is a drain stub — the run + queue ROWS are the assertions.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AppWorkflowBinding, WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { AppOrchestratorService } from '../../src/services/app/appOrchestrator.js';
import { nextCronFire, nextCronFireInTimezone, describeCron } from '../../src/services/cronNextFire.js';
import type { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let engine: { drainWorkflowQueue: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  ctx = await createTestContext();
  engine = { drainWorkflowQueue: vi.fn().mockResolvedValue(undefined) };
});

afterEach(() => ctx.close());

function trivialGraph(): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      { id: 'start', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

function seedApp(): string {
  const id = randomUUID();
  ctx.db.insert(schema.apps).values({
    id,
    workspaceId: ctx.workspace.id,
    slug: `app-${id.slice(0, 8)}`,
    name: 'Factory',
    description: '',
    version: '0.1.0',
    status: 'draft',
    manifest: { manifestVersion: 1, slug: `app-${id.slice(0, 8)}`, name: 'Factory', version: '0.1.0', capabilities: [], requiredPlugins: [] },
    policy: { audience: [], shareable: false, customCode: 'disabled', grants: [] },
    createdBy: ctx.user.id,
  }).run();
  return id;
}

function seedWorkflow(appId: string | null, title: string, binding?: Partial<AppWorkflowBinding>, withSpec = false) {
  const id = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    appId,
    title,
    graph: trivialGraph(),
    settings: {
      ...(binding ? { appBinding: { dependsOn: [], ...binding } } : {}),
      ...(withSpec ? { spec: { version: 1, objective: `Accomplish ${title}`, acceptance: [{ id: 'done', claim: 'Goal achieved', verify: 'expr', expr: 'output.ok == true' }], createdAt: '2026-07-14T00:00:00.000Z' } } : {}),
    },
  }).run();
  return id;
}

function seedRun(workflowId: string, status: string, parentRunId?: string | null, outcome?: 'accomplished' | 'partial' | 'hollow' | 'failed_checks') {
  const id = randomUUID();
  ctx.db.insert(schema.workflowRuns).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId,
    userId: ctx.user.id,
    status,
    runState: { runId: id, workflowId, status, nodeStates: {}, completedNodeIds: [], ...(outcome ? { verdict: { outcome } } : {}) },
    graphSnapshot: trivialGraph(),
    replanCount: 0,
    ...(parentRunId ? { parentRunId } : {}),
  }).run();
  return id;
}

/**
 * A settled run carrying real terminal output. trivialGraph declares no explicit
 * output node, so the surface is its last node — the same rule the chain reader
 * and the dry-run trace use.
 */
function seedRunWithOutput(workflowId: string, status: string, output: Record<string, unknown>) {
  const id = randomUUID();
  ctx.db.insert(schema.workflowRuns).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId,
    userId: ctx.user.id,
    status,
    runState: { runId: id, workflowId, status, nodeStates: { start: { output } }, completedNodeIds: ['start'] },
    graphSnapshot: trivialGraph(),
    replanCount: 0,
  }).run();
  return id;
}

function orchestrator() {
  return new AppOrchestratorService({ db: ctx.db, bus: ctx.bus, engine: engine as unknown as WorkflowEngine, logger: ctx.logger });
}

function queuedFor(workflowId: string) {
  return ctx.db.select().from(schema.workflowRunQueue).where(eq(schema.workflowRunQueue.workflowId, workflowId)).all();
}

describe('AppOrchestratorService — dependsOn chains', () => {
  it('queues an enabled dependent after a clean upstream completion', async () => {
    const appId = seedApp();
    const a = seedWorkflow(appId, 'A');
    const b = seedWorkflow(appId, 'B', { dependsOn: [a] });
    const runId = seedRun(a, 'COMPLETED');

    const { fired } = await orchestrator().handleRunSettled(runId);
    expect(fired).toBe(1);
    const queue = queuedFor(b);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.reason).toBe('app_chain');
    expect(queue[0]?.parentRunId).toBe(runId);
    expect(engine.drainWorkflowQueue).toHaveBeenCalledWith(b);
  });

  it('does not fire on failure by default, fires with chainOn always, skips disabled', async () => {
    const appId = seedApp();
    const a = seedWorkflow(appId, 'A');
    const onSuccess = seedWorkflow(appId, 'B success-only', { dependsOn: [a] });
    const always = seedWorkflow(appId, 'C always', { dependsOn: [a], chainOn: 'always' });
    const disabled = seedWorkflow(appId, 'D disabled', { dependsOn: [a], enabled: false });
    const runId = seedRun(a, 'FAILED');

    const { fired } = await orchestrator().handleRunSettled(runId);
    expect(fired).toBe(1);
    expect(queuedFor(onSuccess)).toHaveLength(0);
    expect(queuedFor(always)).toHaveLength(1);
    expect(queuedFor(disabled)).toHaveLength(0);
  });

  it('does not advance a scoped app chain until the upstream goal is accomplished', async () => {
    const appId = seedApp();
    const source = seedWorkflow(appId, 'Research source', undefined, true);
    const dependent = seedWorkflow(appId, 'Publish result', { dependsOn: [source] });

    const deficientRun = seedRun(source, 'COMPLETED', null, 'failed_checks');
    expect((await orchestrator().handleRunSettled(deficientRun)).fired).toBe(0);
    expect(queuedFor(dependent)).toHaveLength(0);

    const accomplishedRun = seedRun(source, 'COMPLETED', null, 'accomplished');
    expect((await orchestrator().handleRunSettled(accomplishedRun)).fired).toBe(1);
    expect(queuedFor(dependent)).toHaveLength(1);
  });

  it('fails closed for a scoped workflow whose verdict is missing', async () => {
    const appId = seedApp();
    const source = seedWorkflow(appId, 'Generate report', undefined, true);
    const dependent = seedWorkflow(appId, 'Notify stakeholders', { dependsOn: [source] });
    const runId = seedRun(source, 'COMPLETED');

    expect((await orchestrator().handleRunSettled(runId)).fired).toBe(0);
    expect(queuedFor(dependent)).toHaveLength(0);
  });

  it('skips an exclusive dependent that already has an active run', async () => {
    const appId = seedApp();
    const a = seedWorkflow(appId, 'A');
    const b = seedWorkflow(appId, 'B', { dependsOn: [a], concurrency: 'exclusive' });
    seedRun(b, 'RUNNING'); // already busy
    const runId = seedRun(a, 'COMPLETED');

    const { fired } = await orchestrator().handleRunSettled(runId);
    expect(fired).toBe(0);
    expect(queuedFor(b)).toHaveLength(0);
  });

  it('caps chain depth so dependsOn cycles terminate', async () => {
    const appId = seedApp();
    const a = seedWorkflow(appId, 'A', { dependsOn: [] });
    const b = seedWorkflow(appId, 'B', { dependsOn: [a] });
    // Build a deep parent lineage: 16 completed ancestors.
    let parent: string | null = null;
    for (let i = 0; i < 17; i += 1) parent = seedRun(a, 'COMPLETED', parent);

    const { fired } = await orchestrator().handleRunSettled(parent!);
    expect(fired).toBe(0);
    expect(queuedFor(b)).toHaveLength(0);
  });

  it('waits for EVERY dependency before firing a fan-in dependent, then fires once', async () => {
    const appId = seedApp();
    const a = seedWorkflow(appId, 'A');
    const c = seedWorkflow(appId, 'C');
    const b = seedWorkflow(appId, 'B', { dependsOn: [a, c] });

    // A settles first — C has not run at all, so the join must hold.
    const aRun = seedRun(a, 'COMPLETED');
    expect((await orchestrator().handleRunSettled(aRun)).fired).toBe(0);
    expect(queuedFor(b)).toHaveLength(0);

    // C settles — the last dependency lands, so B starts exactly once.
    const cRun = seedRun(c, 'COMPLETED');
    expect((await orchestrator().handleRunSettled(cRun)).fired).toBe(1);
    expect(queuedFor(b)).toHaveLength(1);
    expect(queuedFor(b)[0]?.parentRunId).toBe(cRun);
  });

  it('holds a fan-in join when one dependency failed under the default success policy', async () => {
    const appId = seedApp();
    const a = seedWorkflow(appId, 'A');
    const c = seedWorkflow(appId, 'C');
    const b = seedWorkflow(appId, 'B', { dependsOn: [a, c] });

    seedRun(a, 'FAILED');
    const cRun = seedRun(c, 'COMPLETED');

    expect((await orchestrator().handleRunSettled(cRun)).fired).toBe(0);
    expect(queuedFor(b)).toHaveLength(0);
  });

  it('joins a failed dependency when the dependent opts into chainOn always', async () => {
    const appId = seedApp();
    const a = seedWorkflow(appId, 'A');
    const c = seedWorkflow(appId, 'C');
    const b = seedWorkflow(appId, 'B', { dependsOn: [a, c], chainOn: 'always' });

    seedRun(a, 'FAILED');
    const cRun = seedRun(c, 'COMPLETED');

    expect((await orchestrator().handleRunSettled(cRun)).fired).toBe(1);
    expect(queuedFor(b)).toHaveLength(1);
  });

  it('never treats a vanished dependency as satisfied', async () => {
    const appId = seedApp();
    const a = seedWorkflow(appId, 'A');
    const b = seedWorkflow(appId, 'B', { dependsOn: [a, randomUUID()] });
    const aRun = seedRun(a, 'COMPLETED');

    expect((await orchestrator().handleRunSettled(aRun)).fired).toBe(0);
    expect(queuedFor(b)).toHaveLength(0);
  });

  it('defers a chain link by its configured delay, and starts immediately without one', async () => {
    const appId = seedApp();
    const a = seedWorkflow(appId, 'A');
    const delayed = seedWorkflow(appId, 'delayed', { dependsOn: [a], delay: { ms: 5 * 60_000 } });
    const immediate = seedWorkflow(appId, 'immediate', { dependsOn: [a] });
    const runId = seedRun(a, 'COMPLETED');

    expect((await orchestrator().handleRunSettled(runId)).fired).toBe(2);

    const scheduledAt = queuedFor(delayed)[0]?.scheduledAt;
    expect(scheduledAt).toBeTruthy();
    const waitMs = new Date(scheduledAt!).getTime() - Date.now();
    expect(waitMs).toBeGreaterThan(4 * 60_000);
    expect(waitMs).toBeLessThanOrEqual(5 * 60_000);

    // Absent delay must stay null — the queue treats null as "due now", so this
    // is what keeps every pre-existing chain starting immediately.
    expect(queuedFor(immediate)[0]?.scheduledAt).toBeNull();
  });

  it('fires a failure branch ONLY when the upstream settled without succeeding', async () => {
    const appId = seedApp();
    const a = seedWorkflow(appId, 'A');
    const onFailure = seedWorkflow(appId, 'handle failure', { dependsOn: [a], chainOn: 'failure' });
    const onSuccess = seedWorkflow(appId, 'continue', { dependsOn: [a] });

    expect((await orchestrator().handleRunSettled(seedRun(a, 'FAILED'))).fired).toBe(1);
    expect(queuedFor(onFailure)).toHaveLength(1);
    expect(queuedFor(onSuccess)).toHaveLength(0);

    // ...and stays quiet on success, unlike `always`.
    expect((await orchestrator().handleRunSettled(seedRun(a, 'COMPLETED'))).fired).toBe(1);
    expect(queuedFor(onFailure)).toHaveLength(1);
    expect(queuedFor(onSuccess)).toHaveLength(1);
  });

  it('passes the upstream terminal output to the dependent instead of ids alone', async () => {
    const appId = seedApp();
    const a = seedWorkflow(appId, 'A');
    const b = seedWorkflow(appId, 'B', { dependsOn: [a] });
    const runId = seedRunWithOutput(a, 'COMPLETED', { leadCount: 7, brand: 'acme' });

    await orchestrator().handleRunSettled(runId);

    expect(queuedFor(b)[0]?.inputs).toMatchObject({
      upstreamRunId: runId,
      upstreamOutput: { leadCount: 7, brand: 'acme' },
    });
  });

  it('gates a link on its `when` predicate over the upstream output', async () => {
    const appId = seedApp();
    const a = seedWorkflow(appId, 'A');
    const b = seedWorkflow(appId, 'B', { dependsOn: [a], when: 'upstream.output.leadCount > 0' });

    expect((await orchestrator().handleRunSettled(seedRunWithOutput(a, 'COMPLETED', { leadCount: 0 }))).fired).toBe(0);
    expect(queuedFor(b)).toHaveLength(0);

    expect((await orchestrator().handleRunSettled(seedRunWithOutput(a, 'COMPLETED', { leadCount: 3 }))).fired).toBe(1);
    expect(queuedFor(b)).toHaveLength(1);
  });

  it('fails closed on an invalid `when` rather than firing the link', async () => {
    const appId = seedApp();
    const a = seedWorkflow(appId, 'A');
    const b = seedWorkflow(appId, 'B', { dependsOn: [a], when: 'this is not <<< an expression' });

    expect((await orchestrator().handleRunSettled(seedRunWithOutput(a, 'COMPLETED', { ok: true }))).fired).toBe(0);
    expect(queuedFor(b)).toHaveLength(0);
  });

  it('ignores runs of workflows outside any app', async () => {
    const bare = seedWorkflow(null, 'bare');
    const runId = seedRun(bare, 'COMPLETED');
    const { fired } = await orchestrator().handleRunSettled(runId);
    expect(fired).toBe(0);
  });
});

describe('AppOrchestratorService — run-all', () => {
  it('starts enabled roots in order and skips exclusive-busy ones', async () => {
    const appId = seedApp();
    const first = seedWorkflow(appId, 'first', { order: 1 });
    const second = seedWorkflow(appId, 'second', { order: 2 });
    const dependent = seedWorkflow(appId, 'chained', { order: 0, dependsOn: [first] });
    const paused = seedWorkflow(appId, 'paused', { order: 3, enabled: false });
    const busy = seedWorkflow(appId, 'busy', { order: 4, concurrency: 'exclusive' });
    seedRun(busy, 'RUNNING');

    const results = await orchestrator().runAll(ctx.workspace.id, appId, ctx.user.id);
    const started = results.filter((r) => r.runId);
    expect(started.map((r) => r.workflowId)).toEqual([first, second]);
    expect(results.find((r) => r.workflowId === busy)?.skipped).toBe('active_run_exclusive');
    expect(results.some((r) => r.workflowId === dependent)).toBe(false);
    expect(results.some((r) => r.workflowId === paused)).toBe(false);
  });
});

describe('AppOrchestratorService — binding schedules', () => {
  it('arms, reports nextScheduledFire, and fires a due cron through the queue', async () => {
    const appId = seedApp();
    const wf = seedWorkflow(appId, 'nightly', { schedule: { cron: '*/5 * * * *', enabled: true } });
    const orch = orchestrator();
    orch.rearmAll(new Date());
    expect(orch.nextScheduledFire(wf)).toBeTruthy();

    // Pretend the due moment arrived: sweep "now" far in the future.
    const fired = await orch.sweepSchedules(new Date(Date.now() + 6 * 60_000));
    expect(fired).toBe(1);
    const queue = queuedFor(wf);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.reason).toBe('app_schedule');
    // Re-armed for the next window, not dropped.
    expect(orch.nextScheduledFire(wf)).toBeTruthy();
  });

  it('does not fire disabled schedules or invalid cron expressions', async () => {
    const appId = seedApp();
    const off = seedWorkflow(appId, 'off', { schedule: { cron: '*/5 * * * *', enabled: false } });
    const bad = seedWorkflow(appId, 'bad', { schedule: { cron: 'not a cron', enabled: true } });
    const orch = orchestrator();
    orch.rearmAll(new Date());
    expect(orch.nextScheduledFire(off)).toBeNull();
    expect(orch.nextScheduledFire(bad)).toBeNull();
    const fired = await orch.sweepSchedules(new Date(Date.now() + 60 * 60_000));
    expect(fired).toBe(0);
  });
});

describe('AppOrchestratorService — continuation semantics', () => {
  it('never starts an event-only root from Run Pipeline', async () => {
    const appId = seedApp();
    const operatorRoot = seedWorkflow(appId, 'Operator root', { order: 1, operatorEntrypoint: true });
    const eventRoot = seedWorkflow(appId, 'Inbound reply', { order: 2, operatorEntrypoint: false });

    const results = await orchestrator().runAll(ctx.workspace.id, appId, ctx.user.id);

    expect(results.map((result) => result.workflowId)).toEqual([operatorRoot]);
    expect(queuedFor(operatorRoot)).toHaveLength(1);
    expect(queuedFor(eventRoot)).toHaveLength(0);
  });

  it('does not duplicate an already-active frontier even when workflow concurrency allows parallel starts', async () => {
    const appId = seedApp();
    const root = seedWorkflow(appId, 'Root', { operatorEntrypoint: true, concurrency: 'parallel' });
    const activeRun = seedRun(root, 'RUNNING');

    const results = await orchestrator().runAll(ctx.workspace.id, appId, ctx.user.id);

    expect(results).toEqual([{ workflowId: root, runId: null, skipped: 'active_run_in_progress', reusedRunId: activeRun }]);
    expect(queuedFor(root)).toHaveLength(0);
  });

  it('continues at the first unresolved workflow without rerunning an accomplished root', async () => {
    const appId = seedApp();
    const discover = seedWorkflow(appId, 'Discover', { order: 1 }, true);
    const contact = seedWorkflow(appId, 'Contact', { order: 2, dependsOn: [discover] }, true);
    seedWorkflow(appId, 'Deliver', { order: 3, dependsOn: [contact] }, true);
    const accomplished = seedRun(discover, 'COMPLETED', null, 'accomplished');
    seedRun(contact, 'COMPLETED', null, 'failed_checks');

    const results = await orchestrator().runAll(ctx.workspace.id, appId, ctx.user.id);

    expect(results.find((result) => result.workflowId === discover)).toMatchObject({
      runId: null,
      skipped: 'current_graph_accomplished',
      reusedRunId: accomplished,
    });
    expect(queuedFor(discover)).toHaveLength(0);
    expect(queuedFor(contact)).toHaveLength(1);
    expect(queuedFor(contact)[0]?.reason).toBe('app_run_continue');
  });

  it('only restarts roots when fresh mode is explicit', async () => {
    const appId = seedApp();
    const discover = seedWorkflow(appId, 'Discover', { order: 1 }, true);
    const contact = seedWorkflow(appId, 'Contact', { order: 2, dependsOn: [discover] }, true);
    seedRun(discover, 'COMPLETED', null, 'accomplished');

    const results = await orchestrator().runAll(ctx.workspace.id, appId, ctx.user.id, 'fresh');

    expect(results.map((result) => result.workflowId)).toEqual([discover]);
    expect(queuedFor(discover)).toHaveLength(1);
    expect(queuedFor(discover)[0]?.reason).toBe('app_run_all_fresh');
    expect(queuedFor(contact)).toHaveLength(0);
  });
});

describe('nextCronFire', () => {
  it('computes daily, step, and weekday schedules', () => {
    const from = new Date('2026-07-02T10:30:00Z'); // a Thursday
    expect(nextCronFire('0 9 * * *', from)?.toISOString()).toBe('2026-07-03T09:00:00.000Z');
    expect(nextCronFire('*/15 * * * *', from)?.toISOString()).toBe('2026-07-02T10:45:00.000Z');
    expect(nextCronFire('0 8 * * mon', from)?.toISOString()).toBe('2026-07-06T08:00:00.000Z');
    expect(nextCronFire('30 6 1 * *', from)?.toISOString()).toBe('2026-08-01T06:30:00.000Z');
    expect(nextCronFire('garbage', from)).toBeNull();
    expect(nextCronFire('0 9 31 2 *', from)).toBeNull(); // Feb 31 never exists
    expect(nextCronFireInTimezone('0 9 * * *', 'America/Sao_Paulo', from)?.toISOString())
      .toBe('2026-07-02T12:00:00.000Z');
    expect(nextCronFireInTimezone('0 9 * * *', 'Not/A_Timezone', from)).toBeNull();
  });

  it('describes common expressions', () => {
    expect(describeCron('0 9 * * *')).toBe('daily 09:00');
    expect(describeCron('*/15 * * * *')).toBe('every 15 min');
    expect(describeCron('0 8 * * 1')).toBe('mon 08:00');
  });
});
