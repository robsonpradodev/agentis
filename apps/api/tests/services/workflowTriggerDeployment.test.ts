import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { WorkflowGraph } from '@agentis/core';
import { AppStore } from '@agentis/app';
import { schema } from '@agentis/db/sqlite';
import type { TriggerRuntime } from '../../src/engine/TriggerRuntime.js';
import { WorkflowTriggerDeploymentService } from '../../src/services/workflow/workflowTriggerDeployment.js';
import { graphContentHash } from '../../src/services/workflow/workflowCompass.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { WorkflowRevisionService } from '../../src/services/workflow/workflowRevisionService.js';

let ctx: TestContext;
let activate: ReturnType<typeof vi.fn>;
let deactivate: ReturnType<typeof vi.fn>;
let service: WorkflowTriggerDeploymentService;

beforeEach(async () => {
  ctx = await createTestContext();
  activate = vi.fn(async (trigger: { triggerId: string }) => {
    ctx.db.update(schema.triggers).set({ status: 'active' }).where(eq(schema.triggers.id, trigger.triggerId)).run();
  });
  deactivate = vi.fn(async (triggerId: string) => {
    ctx.db.update(schema.triggers).set({ status: 'paused' }).where(eq(schema.triggers.id, triggerId)).run();
  });
  service = new WorkflowTriggerDeploymentService(ctx.db, {
    activate,
    deactivate,
    listeners: { health: vi.fn(() => ({ connected: true, eventCount: 0, fireCount: 0 })) },
  } as unknown as TriggerRuntime);
});

afterEach(() => ctx.close());

function seedWorkflow(graph: WorkflowGraph, appId: string | null = null): string {
  const id = crypto.randomUUID();
  ctx.db.insert(schema.workflows).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    appId,
    title: 'Automation',
    graph,
    // These fences target the deployment MECHANICS (runtime linking, webhook
    // secrets, listener health) — seed the workflow HARDENED at this graph so
    // the SWIFT arming gate passes. The gate itself is fenced in
    // swiftLifecycle.test.ts.
    settings: { buildLoop: { hardened: { at: new Date().toISOString(), graphHash: graphContentHash(graph), specHash: 'test' } } },
  }).run();
  const active = new WorkflowRevisionService(ctx.db).ensureWorkflow(ctx.workspace.id, id).active;
  ctx.db.update(schema.workflowGraphRevisions).set({
    trustState: 'proven',
    proofProfile: 'legacy_proven',
  }).where(eq(schema.workflowGraphRevisions.id, active.id)).run();
  ctx.db.update(schema.workflows).set({ trustState: 'proven' }).where(eq(schema.workflows.id, id)).run();
  return id;
}

function graphWithTrigger(config: WorkflowGraph['nodes'][number]['config']): WorkflowGraph {
  return {
    version: 1,
    nodes: [{
      id: 'trigger',
      type: 'trigger',
      title: 'Trigger',
      position: { x: 0, y: 0 },
      config,
    }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

describe('WorkflowTriggerDeploymentService', () => {
  it('activates a cron node through the existing trigger runtime and links the graph', async () => {
    const workflowId = seedWorkflow(graphWithTrigger({
      kind: 'trigger',
      triggerType: 'cron',
      schedule: '*/5 * * * *',
      timezone: 'UTC',
    }));

    const deployment = await service.activate({
      workspaceId: ctx.workspace.id,
      workflowId,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
    });

    expect(deployment).toMatchObject({
      triggerType: 'cron',
      authoredTriggerType: 'cron',
      status: 'active',
      config: { expression: '*/5 * * * *', timezone: 'UTC' },
    });
    expect(Date.parse(deployment.nextRunAt!)).toBeGreaterThan(Date.now());
    expect(activate).toHaveBeenCalledOnce();
    const workflow = ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, workflowId)).get()!;
    const trigger = (workflow.graph as WorkflowGraph).nodes[0]!.config as { triggerId?: string; schedule?: string };
    expect(trigger).toMatchObject({ schedule: '*/5 * * * *' });
    expect(trigger.triggerId).toBeUndefined();
  });

  it('activates the visible candidate trigger instead of the stale published trigger', async () => {
    const publishedGraph = graphWithTrigger({ kind: 'trigger', triggerType: 'manual' });
    const workflowId = seedWorkflow(publishedGraph);
    const candidateGraph = graphWithTrigger({
      kind: 'trigger',
      triggerType: 'cron',
      schedule: '* * * * *',
      timezone: 'UTC',
    });
    const revisions = new WorkflowRevisionService(ctx.db);
    const active = revisions.active(ctx.workspace.id, workflowId).revision;
    revisions.createCandidate({
      workspaceId: ctx.workspace.id,
      workflowId,
      graph: candidateGraph,
      baseRevisionId: active.id,
      source: 'user_edit',
      actor: { type: 'user', id: ctx.user.id },
      reason: 'Changed the visible trigger to a schedule',
    });

    const deployment = await service.activate({
      workspaceId: ctx.workspace.id,
      workflowId,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
    });

    expect(deployment).toMatchObject({
      triggerType: 'cron',
      authoredTriggerType: 'cron',
      status: 'active',
      config: { expression: '* * * * *', timezone: 'UTC' },
    });
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({
      triggerType: 'cron',
      config: expect.objectContaining({ expression: '* * * * *' }),
    }));
  });

  it('preserves an RSS authored type while using the listener runtime', async () => {
    const workflowId = seedWorkflow(graphWithTrigger({
      kind: 'trigger',
      triggerType: 'rss_feed',
      rssFeed: { feedUrl: 'https://example.com/feed.xml', pollIntervalMs: 60_000 },
    }));

    const deployment = await service.activate({
      workspaceId: ctx.workspace.id,
      workflowId,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
    });

    expect(deployment).toMatchObject({
      triggerType: 'persistent_listener',
      authoredTriggerType: 'rss_feed',
      nextRunAt: null,
      config: { source: { kind: 'rss', feedUrl: 'https://example.com/feed.xml', intervalMs: 60_000 } },
    });
  });

  it('activates an extension-backed persistent listener and exposes health', async () => {
    const extensionId = crypto.randomUUID();
    ctx.db.insert(schema.extensions).values({
      id: extensionId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      packageId: null,
      name: 'AI Website Watcher',
      slug: 'ai-website-watcher',
      version: '1.0.0',
      runtime: 'node_worker',
      manifest: {
        name: 'AI Website Watcher',
        slug: 'ai-website-watcher',
        version: '1.0.0',
        runtime: 'node_worker',
        source: 'export async function watch() {}',
        permissions: ['listener', 'listener.emit'],
        operations: [{
          name: 'watch',
          inputSchema: {},
          outputSchema: {},
          isListenerSource: true,
        }],
        capabilityTags: ['monitoring'],
      },
    }).run();
    const workflowId = seedWorkflow(graphWithTrigger({
      kind: 'trigger',
      triggerType: 'persistent_listener',
      listenerConfig: {
        source: {
          kind: 'extension',
          extensionId,
          operationName: 'watch',
          pollIntervalMs: 30_000,
        },
      },
    }));

    const deployment = await service.activate({
      workspaceId: ctx.workspace.id,
      workflowId,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
    });

    expect(deployment).toMatchObject({
      triggerType: 'persistent_listener',
      status: 'active',
      health: { connected: true },
      config: {
        source: { kind: 'extension', extensionId, operationName: 'watch' },
        predicate: { kind: 'always' },
        firePolicy: { mode: 'immediate' },
      },
    });
  });

  it('returns a webhook secret only when the endpoint is first created', async () => {
    const workflowId = seedWorkflow(graphWithTrigger({
      kind: 'trigger',
      triggerType: 'webhook',
    }));
    const args = {
      workspaceId: ctx.workspace.id,
      workflowId,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
    };

    const first = await service.activate(args);
    const second = await service.activate(args);

    expect(first.webhookSecret).toBeTruthy();
    expect(first.webhookUrl).toContain(first.triggerId);
    expect(second.webhookSecret).toBeUndefined();
    expect(second.triggerId).toBe(first.triggerId);
  });

  it('activates a manual workflow without invoking trigger runtime', async () => {
    const workflowId = seedWorkflow(graphWithTrigger({
      kind: 'trigger',
      triggerType: 'manual',
    }));

    const deployment = await service.activate({
      workspaceId: ctx.workspace.id,
      workflowId,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
    });

    expect(deployment).toMatchObject({
      triggerType: 'manual',
      status: 'active',
      config: {},
    });
    expect(activate).not.toHaveBeenCalled();
    const row = ctx.db.select().from(schema.triggers).where(eq(schema.triggers.workflowId, workflowId)).get();
    expect(row).toMatchObject({ triggerType: 'manual', status: 'active' });
  });
});

describe('WorkflowTriggerDeploymentService — App always-on lifecycle', () => {
  it('reports armable/armed composite and arms only unattended triggers on Go Live', async () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Monitor' }).id;
    const cronWf = seedWorkflow(graphWithTrigger({ kind: 'trigger', triggerType: 'cron', schedule: '*/5 * * * *', timezone: 'UTC' }), appId);
    const manualWf = seedWorkflow(graphWithTrigger({ kind: 'trigger', triggerType: 'manual' }), appId);

    // Before Go Live: the cron trigger is armable but unarmed; the manual one is not armable.
    const before = service.getForApp(ctx.workspace.id, appId);
    expect(before).toMatchObject({ status: 'paused', armable: 1, armed: 0 });
    expect(before.workflows.find((w) => w.workflowId === cronWf)).toMatchObject({ triggerType: 'cron', status: 'unarmed' });
    expect(before.workflows.find((w) => w.workflowId === manualWf)).toMatchObject({ status: 'manual' });

    const { deployment, results } = await service.activateApp({ workspaceId: ctx.workspace.id, appId, userId: ctx.user.id });
    expect(deployment).toMatchObject({ status: 'live', armable: 1, armed: 1 });
    expect(results.find((r) => r.workflowId === cronWf)).toMatchObject({ outcome: 'armed' });
    expect(results.find((r) => r.workflowId === manualWf)).toMatchObject({ outcome: 'skipped' });
    expect(activate).toHaveBeenCalledOnce();

    const { deployment: afterOff } = await service.deactivateApp({ workspaceId: ctx.workspace.id, appId });
    expect(afterOff).toMatchObject({ status: 'paused', armed: 0 });
    expect(deactivate).toHaveBeenCalledOnce();
  });

  it('listActive returns armed workflows workspace-wide with next-run/last-fired', async () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Monitors' }).id;
    const cronWf = seedWorkflow(graphWithTrigger({ kind: 'trigger', triggerType: 'cron', schedule: '*/5 * * * *', timezone: 'UTC' }), appId);
    seedWorkflow(graphWithTrigger({ kind: 'trigger', triggerType: 'manual' }), appId);

    // Nothing armed yet → empty.
    expect(service.listActive(ctx.workspace.id)).toHaveLength(0);

    await service.activate({ workspaceId: ctx.workspace.id, workflowId: cronWf, ambientId: ctx.ambient.id, userId: ctx.user.id });

    const active = service.listActive(ctx.workspace.id);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      workflowId: cronWf,
      appId,
      appName: 'Monitors',
      triggerType: 'cron',
      status: 'active',
    });
    expect(active[0]!.nextRunAt).toBeTruthy(); // cron next fire is computed
  });

  it('listActive surfaces interval period + run-history shape for an interval trigger', async () => {
    const workflowId = seedWorkflow(graphWithTrigger({
      kind: 'trigger',
      triggerType: 'persistent_listener',
      listenerConfig: {
        source: { kind: 'interval', intervalMs: 10_000, fireOnStart: true },
        predicate: { kind: 'always' },
        firePolicy: { mode: 'immediate' },
      },
    }));
    await service.activate({ workspaceId: ctx.workspace.id, workflowId, ambientId: ctx.ambient.id, userId: ctx.user.id });

    const active = service.listActive(ctx.workspace.id);
    const row = active.find((a) => a.workflowId === workflowId)!;
    expect(row).toBeTruthy();
    expect(row.triggerType).toBe('persistent_listener');
    expect(row.intervalMs).toBe(10_000);
    expect(Array.isArray(row.recentRuns)).toBe(true);
    expect(typeof row.totalRuns).toBe('number');
  });

  it('reports status "none" when an app has no unattended triggers', async () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Manual-only' }).id;
    seedWorkflow(graphWithTrigger({ kind: 'trigger', triggerType: 'manual' }), appId);
    const summary = service.getForApp(ctx.workspace.id, appId);
    expect(summary).toMatchObject({ status: 'none', armable: 0, armed: 0 });
  });

  it('surfaces a per-workflow block instead of failing the whole sweep', async () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Mixed' }).id;
    // Seed a listener workflow with an invalid (empty) listener config so activate throws.
    const id = crypto.randomUUID();
    ctx.db.insert(schema.workflows).values({
      id,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      appId,
      title: 'Broken listener',
      graph: graphWithTrigger({ kind: 'trigger', triggerType: 'persistent_listener' }),
      settings: {},
    }).run();
    const okCron = seedWorkflow(graphWithTrigger({ kind: 'trigger', triggerType: 'cron', schedule: '*/5 * * * *', timezone: 'UTC' }), appId);

    const { results } = await service.activateApp({ workspaceId: ctx.workspace.id, appId, userId: ctx.user.id });
    expect(results.find((r) => r.workflowId === okCron)).toMatchObject({ outcome: 'armed' });
    const broken = results.find((r) => r.workflowId === id)!;
    expect(broken.outcome === 'blocked' || broken.outcome === 'error').toBe(true);
    expect(broken.message).toBeTruthy();
  });
});
