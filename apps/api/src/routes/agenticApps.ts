import { Hono } from 'hono';
import { AppDefinitionStore } from '@agentis/app';
import { AgentisError, authorityContextSchema } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import type { AuthService } from '../services/auth.js';
import type { AgentMissionService } from '../services/agentMissions.js';
import type { ExtensionRuntime } from '../services/extensionRuntime.js';
import { AppOperationRuntime } from '../services/appOperationRuntime.js';
import { AppProjectService } from '../services/appProjectService.js';
import type { Logger } from '../logger.js';
import type { EventBus } from '../event-bus.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

export function buildAgenticAppRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  engine: WorkflowEngine;
  missions: AgentMissionService;
  extensions: ExtensionRuntime;
  dataDir: string;
  logger: Logger;
  bus: EventBus;
}) {
  const app = new Hono();
  const definitions = new AppDefinitionStore(deps.db);
  const operations = new AppOperationRuntime(deps);
  const projects = new AppProjectService(deps);
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/:id/definition', (c) => {
    const ws = getWorkspace(c);
    return c.json({ definition: definitions.get(ws.workspaceId, c.req.param('id')) });
  });

  app.put('/:id/definition', async (c) => {
    const ws = getWorkspace(c);
    const body = await jsonObject(c.req.raw);
    const definition = definitions.upsert(ws.workspaceId, c.req.param('id'), body);
    return c.json({ definition });
  });

  app.get('/:id/operations', (c) => {
    const ws = getWorkspace(c);
    return c.json({ operations: operations.list(ws.workspaceId, c.req.param('id')) });
  });

  app.post('/:id/operations/:operationId/invoke', async (c) => {
    const ws = getWorkspace(c);
    const body = await jsonObject(c.req.raw);
    const input = isObject(body.input) ? body.input : {};
    const authority =
      body.authorityContext == null
        ? undefined
        : authorityContextSchema.parse(body.authorityContext);
    const result = await operations.invoke({
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      userId: ws.user.id,
      appId: c.req.param('id'),
      operationId: c.req.param('operationId'),
      input,
      authorityContext: authority,
      idempotencyKey: clean(body.idempotencyKey),
    });
    return c.json(result, isObject(result) && result.kind === 'task' ? 202 : 200);
  });

  app.get('/:id/tasks', (c) => {
    const ws = getWorkspace(c);
    return c.json({
      tasks: deps.missions.list(ws.workspaceId, {
        appId: c.req.param('id'),
        limit: finite(c.req.query('limit')),
      }),
    });
  });

  app.get('/:id/project', (c) => {
    const ws = getWorkspace(c);
    const project = projects.get(ws.workspaceId, c.req.param('id'));
    return c.json({
      project,
      builds: project ? projects.listBuilds(ws.workspaceId, c.req.param('id')) : [],
    });
  });

  app.get('/:id/frontend/*', async (c) => {
    const ws = getWorkspace(c);
    // Hono drops the unnamed wildcard value when this router is mounted below
    // `/v1/apps`; derive the suffix from the canonical request path so asset
    // requests cannot accidentally fall back to index.html.
    const marker = '/frontend/';
    const markerAt = c.req.path.indexOf(marker);
    const requestedPath = markerAt >= 0 ? c.req.path.slice(markerAt + marker.length) : '';
    const asset = await projects.readLatestFrontendAsset(
      ws.workspaceId,
      c.req.param('id'),
      requestedPath || 'index.html',
    );
    c.header('Content-Type', frontendContentType(requestedPath));
    c.header('Cache-Control', requestedPath ? 'private, max-age=31536000, immutable' : 'no-cache');
    c.header('ETag', `"${asset.artifactSha256 ?? asset.buildId}"`);
    const body = asset.bytes.buffer.slice(
      asset.bytes.byteOffset,
      asset.bytes.byteOffset + asset.bytes.byteLength,
    ) as ArrayBuffer;
    return c.body(body);
  });

  app.post('/:id/project/initialize', async (c) => {
    const ws = getWorkspace(c);
    return c.json({ project: await projects.initialize(ws.workspaceId, c.req.param('id')) }, 201);
  });

  app.post('/:id/builds', async (c) => {
    const ws = getWorkspace(c);
    return c.json({ build: await projects.build(ws.workspaceId, c.req.param('id')) }, 201);
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

function frontendContentType(file: string): string {
  const extension = file.toLowerCase().split('.').pop();
  switch (extension) {
    case 'js':
      return 'text/javascript; charset=utf-8';
    case 'css':
      return 'text/css; charset=utf-8';
    case 'json':
    case 'map':
      return 'application/json; charset=utf-8';
    case 'svg':
      return 'image/svg+xml';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'woff2':
      return 'font/woff2';
    default:
      return 'text/html; charset=utf-8';
  }
}
