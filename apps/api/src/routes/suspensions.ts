import { Hono } from 'hono';
import { AgentisError } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { DurableSuspensionService } from '../services/suspension/durableSuspensionService.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

/** Transport-neutral OSS surface for custom inboxes, portals, and plugins. */
export function buildSuspensionRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  suspensions: DurableSuspensionService;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const states = (c.req.query('state') ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    return c.json({ suspensions: deps.suspensions.list(ws.workspaceId, states.length ? states : undefined) });
  });

  app.get('/capabilities', (c) => {
    getWorkspace(c);
    return c.json(deps.suspensions.capabilities());
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    const suspension = deps.suspensions.get(ws.workspaceId, c.req.param('id'));
    if (!suspension) throw new AgentisError('RESOURCE_NOT_FOUND', 'Suspension not found');
    return c.json({ suspension });
  });

  app.post('/:id/resolve', async (c) => {
    const ws = getWorkspace(c);
    const body = await c.req.json().catch(() => ({})) as { kind?: string; data?: unknown };
    if (typeof body.kind !== 'string' || !body.kind.trim()) {
      throw new AgentisError('VALIDATION_FAILED', 'resolution kind is required');
    }
    const suspension = await deps.suspensions.resolve({
      workspaceId: ws.workspaceId,
      suspensionId: c.req.param('id'),
      resolution: {
        kind: body.kind.trim(),
        data: body.data ?? null,
        principal: { type: 'user', id: ws.user.id },
      },
    });
    return c.json({ suspension });
  });

  app.post('/:id/cancel', async (c) => {
    const ws = getWorkspace(c);
    const body = await c.req.json().catch(() => ({})) as { reason?: string };
    const suspension = await deps.suspensions.cancel(
      ws.workspaceId,
      c.req.param('id'),
      typeof body.reason === 'string' ? body.reason : 'cancelled by user',
    );
    return c.json({ suspension });
  });

  return app;
}
