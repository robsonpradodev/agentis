/**
 * /v1/workspaces — list/get/create/update + ambients sub-resource.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { and, eq } from 'drizzle-orm';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS, schemas } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { ApprovalInboxService } from '../services/approvalInbox.js';
import type { BusMessage, EventBus } from '../event-bus.js';
import type { GroundingDiscoveryService } from '../grounding/discovery.js';
import type { GroundingRuntime } from '../grounding/groundingRuntime.js';
import { requireAuth, getUser } from '../middleware/auth.js';
import { getSelfHealConfig, setSelfHealConfig } from '../services/selfHealSettings.js';
import { getEvolutionConfig, setEvolutionConfig, normalizeAuthority } from '../services/atomicEvolution.js';

export function buildWorkspaceRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  bus: EventBus;
  approvals?: ApprovalInboxService;
  groundingDiscovery?: GroundingDiscoveryService;
  groundingRuntime?: GroundingRuntime;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps));

  app.get('/', (c) => {
    const user = getUser(c);
    const rows = deps.db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.userId, user.id))
      .all();
    return c.json({ workspaces: rows });
  });

  app.post('/', async (c) => {
    const user = getUser(c);
    const body = schemas.createWorkspaceSchema.parse(await c.req.json());
    const id = randomUUID();
    deps.db
      .insert(schema.workspaces)
      .values({ id, userId: user.id, name: body.name, slug: body.slug })
      .run();
    await ensureWorkspaceBrainInternal(deps, id, user.id);
    return c.json({ workspace: { id, userId: user.id, name: body.name, slug: body.slug } }, 201);
  });

  app.get('/:id/canvas/stream', (c) => {
    const user = getUser(c);
    const workspaceId = c.req.param('id');
    const ws = deps.db
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.userId, user.id)))
      .get();
    if (!ws) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workspace not found');

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
      unsubscribe = deps.bus.subscribe((message) => {
        if (!messageBelongsToWorkspace(message, workspaceId)) return;
        for (const event of mapCanvasBusMessage(message)) {
          void write(event.event, event.data);
        }
      });
      heartbeat = setInterval(() => {
        void write('heartbeat', { type: 'HEARTBEAT', at: new Date().toISOString() });
      }, 15_000);
      if (typeof heartbeat === 'object' && 'unref' in heartbeat) heartbeat.unref();

      c.req.raw.signal.addEventListener('abort', close, { once: true });
      await write('snapshot', buildCanvasSnapshot(deps.db, workspaceId, deps.approvals));
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      close();
    });
  });

  // Self-healing workflow settings (AGENT-AUTONOMY §W7). Surfaced in the profile
  // dropdown + Settings → Automation.
  function ownedWorkspace(c: Parameters<typeof getUser>[0], id: string) {
    const user = getUser(c);
    const ws = deps.db.select().from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, id), eq(schema.workspaces.userId, user.id))).get();
    if (!ws) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workspace not found');
    return ws;
  }

  app.get('/:id/self-heal', (c) => {
    const id = c.req.param('id');
    ownedWorkspace(c, id);
    return c.json(getSelfHealConfig(deps.db, id));
  });

  app.put('/:id/self-heal', async (c) => {
    const id = c.req.param('id');
    ownedWorkspace(c, id);
    const body = (await c.req.json().catch(() => ({}))) as {
      enabled?: unknown; mode?: unknown; maxRepairPlans?: unknown; healerAgentId?: unknown;
    };
    const next = setSelfHealConfig(deps.db, id, {
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      mode: body.mode === 'guarded' || body.mode === 'bypass' ? body.mode : undefined,
      maxRepairPlans: typeof body.maxRepairPlans === 'number' ? body.maxRepairPlans : undefined,
      healerAgentId: body.healerAgentId === null || typeof body.healerAgentId === 'string' ? body.healerAgentId : undefined,
    });
    return c.json(next);
  });

  // AGENT-PRIMARY M3 — evolution authority (deterministic vs agent-primary).
  app.get('/:id/evolution', (c) => {
    const id = c.req.param('id');
    ownedWorkspace(c, id);
    return c.json(getEvolutionConfig(deps.db, id));
  });

  app.put('/:id/evolution', async (c) => {
    const id = c.req.param('id');
    ownedWorkspace(c, id);
    const body = (await c.req.json().catch(() => ({}))) as { defaultAuthority?: unknown };
    const next = setEvolutionConfig(deps.db, id, {
      defaultAuthority: normalizeAuthority(body.defaultAuthority),
    });
    return c.json(next);
  });

  app.get('/:id', (c) => {
    const user = getUser(c);
    const id = c.req.param('id');
    const ws = deps.db
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, id), eq(schema.workspaces.userId, user.id)))
      .get();
    if (!ws) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workspace not found');
    const ambients = deps.db
      .select()
      .from(schema.ambients)
      .where(eq(schema.ambients.workspaceId, ws.id))
      .all();
    return c.json({ workspace: ws, ambients });
  });

  app.post('/:id/ambients', async (c) => {
    const user = getUser(c);
    const id = c.req.param('id');
    const ws = deps.db
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, id), eq(schema.workspaces.userId, user.id)))
      .get();
    if (!ws) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workspace not found');
    const body = schemas.createAmbientSchema.parse({ ...(await c.req.json()), workspaceId: id });
    const ambientId = randomUUID();
    deps.db
      .insert(schema.ambients)
      .values({
        id: ambientId,
        workspaceId: ws.id,
        userId: user.id,
        name: body.name,
        kind: body.kind,
        settings: body.settings,
      })
      .run();
    return c.json({ ambient: { id: ambientId, ...body } }, 201);
  });

  // POST /v1/workspaces/:id/select — record the active workspace and emit
  // the realtime event so other tabs/sessions can react.
  app.post('/:id/select', async (c) => {
    const user = getUser(c);
    const id = c.req.param('id');
    const ws = deps.db
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, id), eq(schema.workspaces.userId, user.id)))
      .get();
    if (!ws) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workspace not found');
    await ensureWorkspaceBrainInternal(deps, ws.id, user.id);
    deps.bus.publish(
      REALTIME_ROOMS.user(user.id),
      REALTIME_EVENTS.WORKSPACE_SELECTED,
      { workspaceId: ws.id, name: ws.name, slug: ws.slug },
    );
    return c.json({ workspace: { id: ws.id, name: ws.name, slug: ws.slug, defaultAmbientId: ws.defaultAmbientId } });
  });

  // POST /v1/workspaces/:id/ambients/:ambientId/select — record the active
  // ambient inside the workspace and emit the realtime event. The dashboard
  // sends `x-agentis-ambient` on subsequent requests; the spec requires the
  // explicit endpoint for parity with the workspace selector.
  app.post('/:id/ambients/:ambientId/select', (c) => {
    const user = getUser(c);
    const id = c.req.param('id');
    const ambientId = c.req.param('ambientId');
    const ws = deps.db
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, id), eq(schema.workspaces.userId, user.id)))
      .get();
    if (!ws) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workspace not found');
    const amb = deps.db
      .select()
      .from(schema.ambients)
      .where(and(eq(schema.ambients.id, ambientId), eq(schema.ambients.workspaceId, ws.id)))
      .get();
    if (!amb) throw new AgentisError('RESOURCE_NOT_FOUND', 'Ambient not found in workspace');
    deps.db
      .update(schema.workspaces)
      .set({ defaultAmbientId: amb.id, updatedAt: new Date().toISOString() })
      .where(eq(schema.workspaces.id, ws.id))
      .run();
    deps.bus.publish(
      REALTIME_ROOMS.workspace(ws.id),
      REALTIME_EVENTS.AMBIENT_SELECTED,
      { workspaceId: ws.id, ambientId: amb.id, name: amb.name, kind: amb.kind },
    );
    return c.json({ ambient: { id: amb.id, name: amb.name, kind: amb.kind } });
  });

  app.patch('/:id', async (c) => {
    const user = getUser(c);
    const id = c.req.param('id');
    const ws = deps.db
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, id), eq(schema.workspaces.userId, user.id)))
      .get();
    if (!ws) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workspace not found');

    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      slug?: string;
      description?: string;
      imageDataUrl?: string;
    };

    const updates: Partial<typeof schema.workspaces.$inferSelect> = {
      updatedAt: new Date().toISOString(),
    };
    if (typeof body.name === 'string' && body.name.trim()) {
      updates.name = body.name.trim();
    }
    if (typeof body.slug === 'string' && body.slug.trim()) {
      const cleanSlug = body.slug.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (cleanSlug) updates.slug = cleanSlug;
    }
    if (typeof body.description === 'string') {
      updates.description = body.description.trim() || null;
    }
    if (typeof body.imageDataUrl === 'string') {
      updates.imageUrl = body.imageDataUrl || null;
    }

    deps.db
      .update(schema.workspaces)
      .set(updates)
      .where(eq(schema.workspaces.id, id))
      .run();

    return c.json({ ok: true });
  });

  app.delete('/:id', async (c) => {
    const user = getUser(c);
    const id = c.req.param('id');
    const ws = deps.db
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, id), eq(schema.workspaces.userId, user.id)))
      .get();
    if (!ws) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workspace not found');

    deps.db
      .delete(schema.workspaces)
      .where(eq(schema.workspaces.id, id))
      .run();

    return c.json({ ok: true });
  });

  return app;
}

async function ensureWorkspaceBrainInternal(
  deps: {
    groundingDiscovery?: GroundingDiscoveryService;
    groundingRuntime?: GroundingRuntime;
  },
  workspaceId: string,
  ownerUserId: string,
) {
  if (!deps.groundingDiscovery || !deps.groundingRuntime) return;
  const ensured = deps.groundingDiscovery.ensureInternalWorkspace({ workspaceId, ownerUserId });
  if (!ensured.created && !ensured.needsSync) return;
  await deps.groundingRuntime.tickWorkspace(workspaceId).catch(() => {});
}

function buildCanvasSnapshot(db: AgentisSqliteDb, workspaceId: string, approvalsService?: ApprovalInboxService) {
  const agents = db
    .select({
      id: schema.agents.id,
      name: schema.agents.name,
      status: schema.agents.status,
      role: schema.agents.role,
      managerId: schema.agents.reportsTo,
      currentTaskId: schema.agents.currentTaskId,
      lastHeartbeatAt: schema.agents.lastHeartbeatAt,
      domainColor: schema.agents.colorHex,
      canvasPosition: schema.agents.canvasPosition,
    })
    .from(schema.agents)
    .where(eq(schema.agents.workspaceId, workspaceId))
    .all();
  const runs = db
    .select({
      id: schema.workflowRuns.id,
      workflowId: schema.workflowRuns.workflowId,
      status: schema.workflowRuns.status,
      startedAt: schema.workflowRuns.startedAt,
      createdAt: schema.workflowRuns.createdAt,
    })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.workspaceId, workspaceId))
    .all()
    .filter((run) => run.status === 'RUNNING' || run.status === 'CREATED' || run.status === 'WAITING')
    .slice(0, 50);
  const approvals = approvalsService?.list(workspaceId, 'pending') ?? db
    .select({
      id: schema.approvalRequests.id,
      runId: schema.approvalRequests.runId,
      taskId: schema.approvalRequests.taskId,
      source: schema.approvalRequests.source,
      title: schema.approvalRequests.title,
      summary: schema.approvalRequests.summary,
      createdAt: schema.approvalRequests.createdAt,
    })
    .from(schema.approvalRequests)
    .where(and(eq(schema.approvalRequests.workspaceId, workspaceId), eq(schema.approvalRequests.status, 'pending')))
    .all();
  const artifacts = db
    .select({
      id: schema.artifacts.id,
      agentId: schema.artifacts.agentId,
      workflowId: schema.artifacts.workflowId,
      type: schema.artifacts.type,
      title: schema.artifacts.title,
      createdAt: schema.artifacts.createdAt,
      metadata: schema.artifacts.metadata,
    })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.workspaceId, workspaceId))
    .all()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 50);

  return {
    type: 'SNAPSHOT',
    workspaceId,
    agents,
    runs,
    approvals,
    artifacts,
    at: new Date().toISOString(),
  };
}

function messageBelongsToWorkspace(message: BusMessage, workspaceId: string): boolean {
  if (message.room === REALTIME_ROOMS.workspace(workspaceId)) return true;
  const payload = asRecord(message.envelope.payload);
  return payload.workspaceId === workspaceId;
}

function mapCanvasBusMessage(message: BusMessage): Array<{ event: string; data: unknown }> {
  const payload = asRecord(message.envelope.payload);
  const emittedAt = message.envelope.emittedAt;
  switch (message.envelope.event) {
    // Preserve build narration and individual canvas mutations for the SSE
    // fallback.  A websocket outage must not turn a progressive build into a
    // refresh-only experience.
    case REALTIME_EVENTS.WORKFLOW_BUILD_PHASE:
    case REALTIME_EVENTS.CANVAS_NODE_PLACED:
    case REALTIME_EVENTS.CANVAS_EDGE_CONNECTED:
      return [{
        event: message.envelope.event,
        data: { ...payload, at: emittedAt },
      }];
    case REALTIME_EVENTS.AGENT_WORK_STEP:
      return mapAgentWorkStep(payload, emittedAt);
    case REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL:
      return [{
        event: 'agent_state',
        data: {
          type: 'TOOL_CALL',
          agentId: stringField(payload, 'agentId'),
          runId: stringField(payload, 'runId'),
          workflowId: stringField(payload, 'workflowId'),
          tool: stringField(payload, 'tool') ?? 'tool',
          input: payload.input ?? payload.args ?? null,
          at: emittedAt,
        },
      }];
    case REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE:
      return [{
        event: 'agent_state',
        data: {
          type: 'OUTPUT_TOKEN',
          agentId: stringField(payload, 'agentId'),
          runId: stringField(payload, 'runId'),
          workflowId: stringField(payload, 'workflowId'),
          token: stringField(payload, 'message') ?? stringField(payload, 'text') ?? '',
          at: emittedAt,
        },
      }];
    case REALTIME_EVENTS.RUN_CREATED:
    case REALTIME_EVENTS.RUN_RUNNING:
      return [{
        event: 'workflow_progress',
        data: {
          type: 'RUN_START',
          runId: stringField(payload, 'runId') ?? stringField(payload, 'id'),
          workflowId: stringField(payload, 'workflowId'),
          at: emittedAt,
        },
      }];
    case REALTIME_EVENTS.RUN_COMPLETED:
      return [{
        event: 'workflow_progress',
        data: {
          type: 'RUN_COMPLETE',
          runId: stringField(payload, 'runId') ?? stringField(payload, 'id'),
          workflowId: stringField(payload, 'workflowId'),
          at: emittedAt,
        },
      }];
    case REALTIME_EVENTS.RUN_FAILED:
      return [
        {
          event: 'workflow_progress',
          data: {
            type: 'RUN_FAILED',
            runId: stringField(payload, 'runId') ?? stringField(payload, 'id'),
            workflowId: stringField(payload, 'workflowId'),
            error: stringField(payload, 'error') ?? 'Workflow failed',
            at: emittedAt,
          },
        },
        {
          event: 'attention_event',
          data: {
            type: 'EXECUTION_FAILED',
            itemId: stringField(payload, 'runId') ?? stringField(payload, 'id'),
            runId: stringField(payload, 'runId') ?? stringField(payload, 'id'),
            workflowId: stringField(payload, 'workflowId'),
            error: stringField(payload, 'error') ?? 'Workflow failed',
            at: emittedAt,
          },
        },
      ];
    case REALTIME_EVENTS.CANVAS_BUILD_COMPLETE:
      return [{
        event: 'workflow_progress',
        data: {
          ...payload,
          type: 'BUILD_COMPLETE',
          workflowId: stringField(payload, 'workflowId'),
          runId: stringField(payload, 'runId'),
          at: emittedAt,
        },
      }];
    case REALTIME_EVENTS.ARTIFACT_CREATED:
      return [{
        event: 'artifact_event',
        data: {
          type: 'CREATED',
          artifact: payload.artifact ?? payload,
          at: emittedAt,
        },
      }];
    case REALTIME_EVENTS.ARTIFACT_UPDATED:
      return [{
        event: 'artifact_event',
        data: {
          type: 'UPDATED',
          artifact: payload.artifact ?? payload,
          at: emittedAt,
        },
      }];
    case REALTIME_EVENTS.ARTIFACT_DELETED:
      return [{
        event: 'artifact_event',
        data: {
          type: 'DELETED',
          artifactId: stringField(payload, 'id') ?? stringField(payload, 'artifactId'),
          at: emittedAt,
        },
      }];
    case REALTIME_EVENTS.APPROVAL_REQUESTED:
      return [{
        event: 'attention_event',
        data: {
          type: 'APPROVAL_REQUIRED',
          itemId: stringField(payload, 'id'),
          entityId: stringField(payload, 'runId') ?? stringField(payload, 'taskId') ?? stringField(payload, 'id'),
          entityType: 'workflow',
          message: stringField(payload, 'summary') ?? stringField(payload, 'title') ?? 'Approval required',
          at: emittedAt,
        },
      }];
    case REALTIME_EVENTS.APPROVAL_RESOLVED:
      return [{
        event: 'attention_event',
        data: {
          type: 'RESOLVED',
          itemId: stringField(payload, 'id'),
          at: emittedAt,
        },
      }];
    case REALTIME_EVENTS.AGENT_STATUS_CHANGED:
      return [{
        event: 'agent_state',
        data: {
          type: 'STATUS_CHANGED',
          agentId: stringField(payload, 'agentId'),
          status: stringField(payload, 'status'),
          at: emittedAt,
        },
      }];
    case REALTIME_EVENTS.TASK_SPINE_ACCEPTED:
    case REALTIME_EVENTS.TASK_SPINE_UPDATED:
    case REALTIME_EVENTS.TASK_SPINE_BOUND:
    case REALTIME_EVENTS.TASK_SPINE_VERIFYING:
    case REALTIME_EVENTS.TASK_SPINE_VERIFIED:
    case REALTIME_EVENTS.TASK_SPINE_COMPLETED:
      return [mapTaskSpineProgress(message.envelope.event, payload, emittedAt)];
    case REALTIME_EVENTS.TASK_SPINE_DECISION_RECORDED:
      return [
        mapTaskSpineProgress(message.envelope.event, payload, emittedAt),
        mapTaskSpineAttention('TASK_DECISION_RECORDED', payload, emittedAt),
      ];
    case REALTIME_EVENTS.TASK_SPINE_DEVIATION_RECORDED:
      return [
        mapTaskSpineProgress(message.envelope.event, payload, emittedAt),
        mapTaskSpineAttention('TASK_DEVIATION_RECORDED', payload, emittedAt),
      ];
    case REALTIME_EVENTS.TASK_SPINE_BLOCKED:
      return [
        mapTaskSpineProgress(message.envelope.event, payload, emittedAt),
        mapTaskSpineAttention('TASK_BLOCKED', payload, emittedAt),
      ];
    case REALTIME_EVENTS.TASK_SPINE_FAILED:
      return [
        mapTaskSpineProgress(message.envelope.event, payload, emittedAt),
        mapTaskSpineAttention('TASK_FAILED', payload, emittedAt),
      ];
    case REALTIME_EVENTS.TASK_SPINE_REDIRECTED:
      return [
        mapTaskSpineProgress(message.envelope.event, payload, emittedAt),
        mapTaskSpineAttention('TASK_REDIRECTED', payload, emittedAt),
      ];
    default:
      return [];
  }
}

function mapTaskSpineProgress(event: string, payload: Record<string, unknown>, at: string): { event: string; data: unknown } {
  return {
    event: 'workflow_progress',
    data: {
      ...payload,
      type: taskSpineProgressType(event),
      taskId: stringField(payload, 'taskId') ?? stringField(payload, 'planId'),
      planId: stringField(payload, 'planId') ?? stringField(payload, 'taskId'),
      runId: stringField(payload, 'runId'),
      sessionId: stringField(payload, 'sessionId'),
      status: stringField(payload, 'status'),
      at,
    },
  };
}

function mapTaskSpineAttention(type: string, payload: Record<string, unknown>, at: string): { event: string; data: unknown } {
  return {
    event: 'attention_event',
    data: {
      type,
      itemId: stringField(payload, 'taskId') ?? stringField(payload, 'planId'),
      entityId: stringField(payload, 'taskId') ?? stringField(payload, 'planId'),
      entityType: 'task_spine',
      message: stringField(payload, 'reason')
        ?? stringField(payload, 'instruction')
        ?? stringField(payload, 'title')
        ?? 'Task spine updated',
      at,
    },
  };
}

function taskSpineProgressType(event: string): string {
  switch (event) {
    case REALTIME_EVENTS.TASK_SPINE_ACCEPTED:
      return 'TASK_ACCEPTED';
    case REALTIME_EVENTS.TASK_SPINE_BOUND:
      return 'TASK_BOUND';
    case REALTIME_EVENTS.TASK_SPINE_VERIFYING:
      return 'TASK_VERIFYING';
    case REALTIME_EVENTS.TASK_SPINE_VERIFIED:
      return 'TASK_VERIFIED';
    case REALTIME_EVENTS.TASK_SPINE_COMPLETED:
      return 'TASK_COMPLETED';
    case REALTIME_EVENTS.TASK_SPINE_BLOCKED:
      return 'TASK_BLOCKED';
    case REALTIME_EVENTS.TASK_SPINE_FAILED:
      return 'TASK_FAILED';
    case REALTIME_EVENTS.TASK_SPINE_DECISION_RECORDED:
      return 'TASK_DECISION_RECORDED';
    case REALTIME_EVENTS.TASK_SPINE_DEVIATION_RECORDED:
      return 'TASK_DEVIATION_RECORDED';
    case REALTIME_EVENTS.TASK_SPINE_REDIRECTED:
      return 'TASK_REDIRECTED';
    default:
      return 'TASK_UPDATED';
  }
}

function mapAgentWorkStep(payload: Record<string, unknown>, at: string): Array<{ event: string; data: unknown }> {
  const phase = stringField(payload, 'phase');
  const agentId = stringField(payload, 'agentId');
  const workflowId = stringField(payload, 'workflowId');
  const runId = stringField(payload, 'runId');
  const nodeId = stringField(payload, 'nodeId');
  const nodeLabel = stringField(payload, 'description') ?? stringField(payload, 'step') ?? 'Working';
  const agentStateType = phase === 'complete' ? 'TASK_COMPLETE' : phase === 'fail' ? 'TASK_ERROR' : 'TASK_START';
  return [
    {
      event: 'agent_state',
      data: {
        type: agentStateType,
        agentId,
        taskId: nodeId,
        workflowId,
        runId,
        nodeLabel,
        error: phase === 'fail' ? stringField(payload, 'detail') ?? nodeLabel : undefined,
        at,
      },
    },
    {
      event: 'workflow_progress',
      data: {
        type: phase === 'complete' || phase === 'fail' ? 'NODE_EXIT' : 'NODE_ENTER',
        workflowId,
        runId,
        nodeId,
        nodeLabel,
        agentId,
        status: phase === 'fail' ? 'error' : 'ok',
        at,
      },
    },
  ];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
