import { Hono } from 'hono';
import { AgentisError, authorityContextSchema, effectLevelSchema } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import type { AuthService } from '../services/auth.js';
import type { AgentMissionService } from '../services/agentMissions.js';
import { AppEffectService } from '../services/appEffects.js';
import { AppOperationRuntime } from '../services/appOperationRuntime.js';
import type { ExtensionRuntime } from '../services/extensionRuntime.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

export function buildEffectRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  engine: WorkflowEngine;
  missions: AgentMissionService;
  extensions: ExtensionRuntime;
}) {
  const app = new Hono();
  const effects = new AppEffectService(deps.db, deps.missions);
  const operations = new AppOperationRuntime(deps);
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    return c.json({
      effects: effects.list(ws.workspaceId, {
        missionId: clean(c.req.query('missionId')),
        appId: clean(c.req.query('appId')),
        limit: finite(c.req.query('limit')),
      }),
    });
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    return c.json({ effect: effects.get(ws.workspaceId, c.req.param('id')) });
  });

  app.post('/prepare', async (c) => {
    const ws = getWorkspace(c);
    const body = await jsonObject(c.req.raw);
    const reversibility = effectLevelSchema.parse(body.reversibility);
    if (reversibility === 'read')
      throw new AgentisError(
        'VALIDATION_FAILED',
        'Read-only operations do not require an effect plan',
      );
    const operationId = clean(body.operationId);
    const idempotencyKey = clean(body.idempotencyKey);
    if (!operationId || !idempotencyKey)
      throw new AgentisError('VALIDATION_FAILED', 'operationId and idempotencyKey are required');
    const authority = authorityContextSchema.parse(body.authorityContext);
    const effect = effects.prepare({
      workspaceId: ws.workspaceId,
      missionId: clean(body.missionId) ?? null,
      appId: clean(body.appId) ?? null,
      operationId,
      input: body.input ?? {},
      targets: Array.isArray(body.targets) ? (body.targets as never) : [],
      consequences: Array.isArray(body.consequences) ? body.consequences.map(String) : [],
      reversibility,
      compensationOperationId: clean(body.compensationOperationId) ?? null,
      estimatedCostCents: isObject(body.estimatedCostCents)
        ? (body.estimatedCostCents as { min: number; max: number })
        : null,
      estimatedLatencyMs:
        typeof body.estimatedLatencyMs === 'number' ? body.estimatedLatencyMs : null,
      idempotencyKey,
      authorityContext: authority,
      approval: body.approval === 'never' || body.approval === 'always' ? body.approval : 'policy',
      expiresAt: clean(body.expiresAt) ?? null,
    });
    return c.json({ effect }, 201);
  });

  app.post('/:id/authorize', async (c) => {
    const ws = getWorkspace(c);
    const body = await jsonObject(c.req.raw);
    const authority = authorityContextSchema.parse(body.authorityContext);
    const result = effects.authorize(ws.workspaceId, c.req.param('id'), {
      approvedBy: ws.user.id,
      authorityContext: authority,
      scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : undefined,
      maxEffectLevel: body.maxEffectLevel
        ? effectLevelSchema.parse(body.maxEffectLevel)
        : undefined,
      maxSpendCents: typeof body.maxSpendCents === 'number' ? body.maxSpendCents : undefined,
      expiresAt: clean(body.expiresAt) ?? null,
    });
    const invocation =
      result.plan.appId && isObject(result.plan.input)
        ? await operations.invoke({
            workspaceId: ws.workspaceId,
            ambientId: ws.ambientId,
            userId: ws.user.id,
            appId: result.plan.appId,
            operationId: result.plan.operationId,
            input: result.plan.input,
            authorityContext: authority,
            idempotencyKey: result.plan.idempotencyKey,
          })
        : null;
    return c.json({ ...result, invocation });
  });

  app.post('/:id/reconcile', async (c) => {
    const ws = getWorkspace(c);
    const body = await jsonObject(c.req.raw);
    return c.json({
      effect: effects.reconcile(ws.workspaceId, c.req.param('id'), body.evidence ?? body),
    });
  });

  app.post('/:id/compensate', async (c) => {
    const ws = getWorkspace(c);
    const body = await jsonObject(c.req.raw);
    return c.json({
      effect: effects.compensate(ws.workspaceId, c.req.param('id'), body.result ?? body),
    });
  });

  return app;
}

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  const value = await request.json().catch(() => null);
  if (!isObject(value))
    throw new AgentisError('VALIDATION_FAILED', 'request body must be a JSON object');
  return value;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function clean(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function finite(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
