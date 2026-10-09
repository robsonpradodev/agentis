import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  AgentisError,
  REALTIME_ROOMS,
  appArtifactRefSchema,
  authorityContextSchema,
  type AgentMissionStatus,
  type ExecutionPlan,
  type MissionOutcomeContract,
} from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';
import type { AuthService } from '../services/auth.js';
import type { AgentMissionService } from '../services/agentMissions.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export function buildMissionRoutes(deps: { db: AgentisSqliteDb; auth: AuthService; missions: AgentMissionService; bus: EventBus }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const status = parseStatuses(c.req.query('status'));
    return c.json({ missions: deps.missions.list(ws.workspaceId, {
      ownerAgentId: clean(c.req.query('agentId')), appId: clean(c.req.query('appId')),
      subjectId: clean(c.req.query('subjectId')), sourceRef: clean(c.req.query('sourceRef')),
      ...(status.length ? { status } : {}), limit: number(c.req.query('limit')),
    }) });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const input = parseMissionCreateBody(await optionalJson(c.req.raw));
    return c.json({ mission: deps.missions.create({ workspaceId: ws.workspaceId, ...input }) }, 201);
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    return c.json({ mission: deps.missions.inspect(ws.workspaceId, c.req.param('id')) });
  });

  app.get('/:id/stream', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const mission = deps.missions.inspect(ws.workspaceId, id);
    const room = REALTIME_ROOMS.mission(id);
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
        try { await stream.writeSSE({ event, data: JSON.stringify(data) }); }
        catch { close(); }
      };
      await write('mission.snapshot', mission);
      unsubscribe = deps.bus.subscribe((message) => {
        if (message.room !== room) return;
        void write(message.envelope.event, message.envelope.payload);
      });
      heartbeat = setInterval(() => {
        void write('heartbeat', { type: 'HEARTBEAT', at: new Date().toISOString() });
      }, 10_000);
      if (typeof heartbeat === 'object' && 'unref' in heartbeat) heartbeat.unref();
      c.req.raw.signal.addEventListener('abort', close, { once: true });
      await new Promise<void>((resolve) => c.req.raw.signal.addEventListener('abort', () => resolve(), { once: true }));
      close();
    });
  });

  app.post('/:id/resume', async (c) => {
    const ws = getWorkspace(c);
    const body = await optionalJson(c.req.raw) as { reason?: unknown };
    return c.json({ mission: deps.missions.resume(ws.workspaceId, c.req.param('id'), clean(body.reason) ?? 'Mission resumed by operator') });
  });

  app.post('/:id/input-requests', async (c) => {
    const ws = getWorkspace(c);
    const body = await optionalJson(c.req.raw) as Record<string, unknown>;
    const id = clean(body.id) ?? crypto.randomUUID();
    const title = clean(body.title);
    if (!title) throw new AgentisError('VALIDATION_FAILED', 'title is required');
    return c.json({ mission: deps.missions.requestInput(ws.workspaceId, c.req.param('id'), {
      id, title, description: clean(body.description),
      schema: isObject(body.schema) ? body.schema : { type: 'object' },
    }) }, 201);
  });

  app.post('/:id/input-requests/:requestId/respond', async (c) => {
    const ws = getWorkspace(c);
    const body = await optionalJson(c.req.raw) as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(body, 'response')) throw new AgentisError('VALIDATION_FAILED', 'response is required');
    return c.json({ mission: deps.missions.submitInput(
      ws.workspaceId, c.req.param('id'), c.req.param('requestId'), body.response, ws.user.id,
    ) });
  });

  app.post('/:id/approval-requests', async (c) => {
    const ws = getWorkspace(c);
    const body = await optionalJson(c.req.raw) as Record<string, unknown>;
    const title = clean(body.title);
    if (!title) throw new AgentisError('VALIDATION_FAILED', 'title is required');
    return c.json({ mission: deps.missions.requestApproval(ws.workspaceId, c.req.param('id'), {
      id: clean(body.id) ?? crypto.randomUUID(), title, detail: clean(body.detail),
      effectPlanId: clean(body.effectPlanId) ?? null,
    }) }, 201);
  });

  app.post('/:id/approval-requests/:requestId/decide', async (c) => {
    const ws = getWorkspace(c);
    const body = await optionalJson(c.req.raw) as Record<string, unknown>;
    const decision = clean(body.decision);
    if (decision !== 'approved' && decision !== 'rejected') throw new AgentisError('VALIDATION_FAILED', 'decision must be approved or rejected');
    return c.json({ mission: deps.missions.resolveApproval(
      ws.workspaceId, c.req.param('id'), c.req.param('requestId'), decision, ws.user.id,
    ) });
  });

  app.post('/:id/artifacts', async (c) => {
    const ws = getWorkspace(c);
    const artifact = appArtifactRefSchema.parse(await optionalJson(c.req.raw));
    return c.json({ mission: deps.missions.attachArtifact(ws.workspaceId, c.req.param('id'), artifact, ws.user.id) }, 201);
  });

  app.post('/:id/cancel', async (c) => {
    const ws = getWorkspace(c);
    const body = await optionalJson(c.req.raw) as { reason?: unknown };
    return c.json({ mission: deps.missions.cancel(ws.workspaceId, c.req.param('id'), clean(body.reason) ?? 'Cancelled by operator') });
  });

  return app;
}

export function parseMissionCreateBody(body: unknown, ownerAgentId?: string) {
  const value = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const objective = clean(value.objective);
  const agentId = ownerAgentId ?? clean(value.agentId);
  if (!objective) throw new AgentisError('VALIDATION_FAILED', 'objective must be a non-empty string');
  if (!agentId) throw new AgentisError('VALIDATION_FAILED', 'agentId must be a non-empty string');
  const sourceKind = clean(value.sourceKind) ?? 'api';
  if (!['conversation', 'channel', 'workflow', 'standing_goal', 'followup', 'api'].includes(sourceKind)) {
    throw new AgentisError('VALIDATION_FAILED', 'sourceKind is invalid');
  }
  return {
    ownerAgentId: agentId, objective, sourceKind: sourceKind as 'conversation' | 'channel' | 'workflow' | 'standing_goal' | 'followup' | 'api',
    appId: clean(value.appId) ?? null, subjectId: clean(value.subjectId) ?? null,
    operationId: clean(value.operationId) ?? null, parentMissionId: clean(value.parentMissionId) ?? null,
    delegationId: clean(value.delegationId) ?? null,
    authorityContext: isObject(value.authorityContext) ? authorityContextSchema.parse(value.authorityContext) : undefined,
    standingGoalId: clean(value.standingGoalId) ?? null, sourceRef: clean(value.sourceRef) ?? null,
    correlationKey: clean(value.correlationKey),
    outcomeContract: isObject(value.outcomeContract) ? value.outcomeContract as unknown as MissionOutcomeContract : undefined,
    executionPlan: isObject(value.executionPlan) ? value.executionPlan as unknown as ExecutionPlan : undefined,
    maxAttempts: typeof value.maxAttempts === 'number' ? value.maxAttempts : undefined,
    tokenBudget: typeof value.tokenBudget === 'number' ? value.tokenBudget : undefined,
    costBudgetCents: typeof value.costBudgetCents === 'number' ? value.costBudgetCents : undefined,
    latencyBudgetMs: typeof value.latencyBudgetMs === 'number' ? value.latencyBudgetMs : undefined,
    deadlineAt: clean(value.deadlineAt) ?? null,
    nextWakeAt: clean(value.nextWakeAt) ?? null,
  };
}

function parseStatuses(value: string | undefined): AgentMissionStatus[] {
  const allowed = new Set<AgentMissionStatus>(['queued', 'running', 'input_required', 'approval_required', 'waiting', 'replanning', 'accomplished', 'blocked', 'failed', 'cancelled', 'rejected']);
  return (value ?? '').split(',').map((part) => part.trim()).filter((part): part is AgentMissionStatus => allowed.has(part as AgentMissionStatus));
}
function clean(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function number(value: unknown): number | undefined { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; }
function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
async function optionalJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  try { return JSON.parse(text) as unknown; } catch { throw new AgentisError('VALIDATION_FAILED', 'request body must be valid JSON'); }
}
