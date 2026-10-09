/**
 * A2A surface — Agentis speaks Agent2Agent (UNIVERSAL-HARNESS §8, Pillar 5).
 *
 * Discovery (Agent Cards):
 *   GET  /v1/a2a/agent-card.json         → the workspace's A2A Agent Card; its
 *                                          skills are the published workflows.
 *   GET  /v1/a2a/agents                  → per-agent cards (capability discovery)
 *   GET  /v1/a2a/agents/:id/card         → one agent's card
 *
 * Interaction (task reception):
 *   POST /v1/a2a/message:send            → run the addressed skill (published
 *                                          workflow), await it, return an A2A
 *                                          Task with the output as an artifact.
 *
 * A2A is the horizontal (agent↔agent) complement to MCP's vertical (agent↔tool)
 * surface. Reception reuses the exact `runPublishedWorkflow` mechanism MCP uses,
 * so the two protocol surfaces cannot drift.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { AgentisError, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import { runPublishedWorkflow, startPublishedWorkflow, inputSchemaFor } from '../engine/runPublishedWorkflow.js';
import { streamSSE } from 'hono/streaming';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';
import type { AgentMissionService } from '../services/agentMissions.js';
import { AppOperationRuntime } from '../services/appOperationRuntime.js';
import { AppDefinitionStore } from '@agentis/app';
import type { ExtensionRuntime } from '../services/extensionRuntime.js';

const PROTOCOL_VERSION = '1.0.0';

export interface A2aRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  adapters: AdapterManager;
  engine: WorkflowEngine;
  missions?: AgentMissionService;
  extensions?: ExtensionRuntime;
  /** Records the inbound A2A call as a conversation-theater interaction. */
  activity?: import('../services/activityFeed.js').ActivityFeedService;
}

interface WorkflowSkill {
  id: string;            // the published slug — used as the A2A skill id
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function buildA2aRoutes(deps: A2aRoutesDeps) {
  const app = new Hono();
  const operationRuntime = deps.missions ? new AppOperationRuntime({ ...deps, missions: deps.missions }) : null;
  const definitions = new AppDefinitionStore(deps.db);
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  // ── Discovery: the workspace Agent Card ──────────────────────────────────
  app.get('/agent-card.json', (c) => {
    const ws = getWorkspace(c);
    const skills = [...publishedSkills(deps.db, ws.workspaceId), ...publishedAppSkills(deps.db, definitions, ws.workspaceId)];
    return c.json({
      protocolVersion: PROTOCOL_VERSION,
      name: 'Agentis workspace',
      description: 'Agentis orchestration workspace exposed as an A2A agent. Skills are published workflows.',
      version: '1.0.0',
      url: '/v1/a2a',
      capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true, extendedAgentCard: true },
      defaultInputModes: ['text', 'application/json'],
      defaultOutputModes: ['text', 'application/json'],
      skills: skills.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        tags: ['workflow'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      })),
    });
  });

  // ── Discovery: per-agent cards ───────────────────────────────────────────
  app.get('/agents', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.db.select().from(schema.agents).where(eq(schema.agents.workspaceId, ws.workspaceId)).all();
    return c.json({ agents: rows.map((a) => buildAgentCard(deps, a)) });
  });

  app.get('/agents/:id/card', (c) => {
    const ws = getWorkspace(c);
    const agent = deps.db.select().from(schema.agents)
      .where(and(eq(schema.agents.id, c.req.param('id')), eq(schema.agents.workspaceId, ws.workspaceId))).get();
    if (!agent) return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'agent not found' } }, 404);
    return c.json(buildAgentCard(deps, agent));
  });

  // ── Interaction: A2A message:send ────────────────────────────────────────
  app.post('/message:send', async (c) => {
    const ws = getWorkspace(c);
    const body = (await c.req.json().catch(() => ({}))) as A2aSendParams;
    const message = body.message;
    if (!message || !Array.isArray(message.parts)) {
      throw new AgentisError('VALIDATION_FAILED', 'message.parts is required');
    }
    const skillId = body.skillId ?? message.skillId;
    if (!skillId) throw new AgentisError('VALIDATION_FAILED', 'a skillId (published workflow slug) is required');

    const inputs = inputsFromParts(message.parts);
    const appSkill = parseAppSkill(skillId);
    if (appSkill) {
      if (!operationRuntime || !deps.missions) throw new AgentisError('VALIDATION_FAILED', 'Durable App operations are not configured on this A2A server.');
      const result = await operationRuntime.invoke({
        workspaceId: ws.workspaceId, ambientId: ws.ambientId, userId: ws.user.id,
        appId: appSkill.appId, operationId: appSkill.operationId, input: inputs,
        idempotencyKey: body.idempotencyKey ?? `a2a:${message.messageId ?? randomUUID()}`,
      });
      if (isObject(result) && result.kind === 'task' && isObject(result.task) && typeof result.task.id === 'string') {
        return c.json(toA2aTask(deps.missions.inspect(ws.workspaceId, result.task.id)));
      }
      return c.json({ kind: 'message', role: 'agent', messageId: randomUUID(), parts: [{ kind: 'data', data: result }] });
    }
    const wf = publishedWorkflowBySlug(deps.db, ws.workspaceId, skillId);
    if (!wf) throw new AgentisError('RESOURCE_NOT_FOUND', `no published A2A skill '${skillId}'`);
    if (!deps.missions) {
      const completed = await runPublishedWorkflow({
        db: deps.db, engine: deps.engine, workspaceId: ws.workspaceId, ambientId: ws.ambientId,
        userId: ws.user.id, workflowId: wf.id, graph: wf.graph as WorkflowGraph, inputs,
      });
      if (!completed.terminal || completed.executionStatus !== 'completed') {
        throw new AgentisError('INTERNAL_ERROR', `A2A workflow settled as ${completed.status}`);
      }
      return c.json({
        id: completed.runId, contextId: completed.runId, kind: 'task',
        status: { state: 'completed', timestamp: new Date().toISOString() },
        artifacts: [{ artifactId: `run:${completed.runId}:output`, name: 'Workflow output', parts: [{ kind: 'data', data: completed.output }] }],
        history: [], metadata: { workflowId: wf.id },
      });
    }
    const ownerAgentId = ownerAgentForWorkflow(deps.db, ws.workspaceId, wf.id);
    if (!ownerAgentId) throw new AgentisError('VALIDATION_FAILED', 'Published A2A workflows require an owning App agent.');
    const task = deps.missions.create({
      workspaceId: ws.workspaceId, ownerAgentId, appId: wf.appId ?? null, sourceKind: 'api',
      correlationKey: body.idempotencyKey ?? `a2a:${message.messageId ?? randomUUID()}`,
      objective: `A2A task: ${wf.title}`, outcomeContract: { requiredEffects: [] },
    });
    // CONVERSATION THEATER: record the inbound agent-to-agent call.
    try {
      deps.activity?.record({
        workspaceId: ws.workspaceId,
        ambientId: ws.ambientId,
        userId: ws.user.id,
        eventType: 'a2a.message_received',
        actorType: 'agent',
        actorId: null,
        entityType: 'workflow',
        entityId: wf.id,
        summary: `A2A: an external agent invoked skill “${skillId}”`,
        metadata: { skillId, workflowId: wf.id },
      });
    } catch { /* best-effort */ }
    const run = await startPublishedWorkflow({
      db: deps.db, engine: deps.engine,
      workspaceId: ws.workspaceId, ambientId: ws.ambientId, userId: ws.user.id,
      workflowId: wf.id, graph: wf.graph as WorkflowGraph, inputs, missionId: task.id,
    });
    deps.missions.linkWorkflowRun(ws.workspaceId, task.id, run.runId);
    return c.json(toA2aTask(deps.missions.inspect(ws.workspaceId, task.id)));
  });

  app.get('/tasks', (c) => {
    const ws = getWorkspace(c);
    if (!deps.missions) throw new AgentisError('VALIDATION_FAILED', 'Durable A2A tasks are not configured.');
    const limit = Math.max(1, Math.min(100, Number(c.req.query('pageSize')) || 50));
    return c.json({ tasks: deps.missions.list(ws.workspaceId, { limit }).map(toA2aTask), nextPageToken: '' });
  });

  app.get('/tasks/:id', (c) => {
    const ws = getWorkspace(c);
    if (!deps.missions) throw new AgentisError('VALIDATION_FAILED', 'Durable A2A tasks are not configured.');
    return c.json(toA2aTask(deps.missions.inspect(ws.workspaceId, c.req.param('id'))));
  });

  app.post('/tasks/:id/cancel', (c) => {
    const ws = getWorkspace(c);
    if (!deps.missions) throw new AgentisError('VALIDATION_FAILED', 'Durable A2A tasks are not configured.');
    return c.json(toA2aTask(deps.missions.cancel(ws.workspaceId, c.req.param('id'), 'Cancelled by A2A client')));
  });

  app.get('/tasks/:id/subscribe', (c) => {
    const ws = getWorkspace(c);
    if (!deps.missions) throw new AgentisError('VALIDATION_FAILED', 'Durable A2A tasks are not configured.');
    const missions = deps.missions;
    const id = c.req.param('id');
    missions.inspect(ws.workspaceId, id);
    return streamSSE(c, async (stream) => {
      let last = '';
      while (!c.req.raw.signal.aborted) {
        const task = missions.inspect(ws.workspaceId, id);
        const serialized = JSON.stringify(toA2aTask(task));
        if (serialized !== last) {
          await stream.writeSSE({ event: 'task.status', data: serialized });
          last = serialized;
        }
        if (['accomplished', 'blocked', 'failed', 'cancelled', 'rejected'].includes(task.status)) break;
        await new Promise((resolve) => { const timer = setTimeout(resolve, 750); timer.unref?.(); });
      }
    });
  });

  return app;
}

// ─── Agent Card builder ─────────────────────────────────────────────────────

function buildAgentCard(deps: A2aRoutesDeps, agent: typeof schema.agents.$inferSelect) {
  const capabilities = deps.adapters.capabilities(agent.id);
  const affordances = capabilities?.affordances ?? {};
  const tags = Array.isArray(agent.capabilityTags) ? (agent.capabilityTags as string[]) : [];

  const affordanceTags = Object.entries(affordances).filter(([, v]) => v === true).map(([k]) => k);
  const skills = [
    ...tags.map((t) => ({ id: `tag:${t}`, name: t, description: `Capability tag: ${t}`, tags: ['capability'] })),
  ];

  return {
    protocolVersion: PROTOCOL_VERSION,
    name: agent.name,
    description: agent.description ?? `${agent.name} — ${agent.adapterType} agent on Agentis`,
    version: '1.0.0',
    url: `/v1/a2a/agents/${agent.id}`,
    provider: { organization: 'Agentis', adapterType: agent.adapterType },
    capabilities: {
      streaming: capabilities?.interactiveChat ?? false,
      pushNotifications: false,
      // Surface Agentis affordances so peers can route to the right agent.
      affordances: affordanceTags,
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills,
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

interface A2aPart { kind?: string; text?: string; data?: unknown }
interface A2aMessage { role?: string; parts: A2aPart[]; skillId?: string; messageId?: string }
interface A2aSendParams { skillId?: string; message?: A2aMessage; idempotencyKey?: string }

/** Map A2A message parts → workflow inputs. DataParts merge as structured inputs; TextParts become `input`. */
function inputsFromParts(parts: A2aPart[]): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  const texts: string[] = [];
  for (const part of parts) {
    if (part.kind === 'data' && part.data && typeof part.data === 'object' && !Array.isArray(part.data)) {
      Object.assign(inputs, part.data as Record<string, unknown>);
    } else if (typeof part.text === 'string') {
      texts.push(part.text);
    }
  }
  if (texts.length > 0 && inputs.input === undefined) inputs.input = texts.join('\n');
  return inputs;
}

function publishedSkills(db: AgentisSqliteDb, workspaceId: string): WorkflowSkill[] {
  return db.select().from(schema.workflows).where(eq(schema.workflows.workspaceId, workspaceId)).all()
    .map((r) => ({ r, mcp: mcpOf(r.settings) }))
    .filter((x) => x.mcp.published && x.mcp.slug)
    .map(({ r, mcp }) => ({
      id: mcp.slug!,
      name: r.title,
      description: r.description ?? r.title,
      inputSchema: inputSchemaFor(r.graph as WorkflowGraph),
    }));
}

function publishedWorkflowBySlug(db: AgentisSqliteDb, workspaceId: string, slug: string) {
  return db.select().from(schema.workflows).where(eq(schema.workflows.workspaceId, workspaceId)).all()
    .find((r) => { const m = mcpOf(r.settings); return Boolean(m.published && m.slug === slug); });
}

function mcpOf(settings: unknown): { published?: boolean; slug?: string } {
  const s = settings && typeof settings === 'object' ? (settings as Record<string, unknown>).mcp : undefined;
  return s && typeof s === 'object' ? (s as { published?: boolean; slug?: string }) : {};
}

function publishedAppSkills(db: AgentisSqliteDb, definitions: AppDefinitionStore, workspaceId: string): WorkflowSkill[] {
  return db.select({ id: schema.apps.id }).from(schema.apps).where(eq(schema.apps.workspaceId, workspaceId)).all().flatMap((app) => {
    const definition = definitions.get(workspaceId, app.id);
    if (definition?.projections?.a2a.enabled === false) return [];
    const allow = new Set(definition?.projections?.a2a.exposeOperations ?? []);
    return (definition?.contract?.operations ?? []).filter((operation) => allow.size === 0 || allow.has(operation.id)).map((operation) => ({
      id: `app:${app.id}:${operation.id}`, name: operation.title, description: operation.description,
      inputSchema: operation.inputSchema,
    }));
  });
}

function parseAppSkill(skillId: string): { appId: string; operationId: string } | null {
  const match = /^app:([^:]+):(.+)$/.exec(skillId);
  return match ? { appId: match[1]!, operationId: match[2]! } : null;
}

function ownerAgentForWorkflow(db: AgentisSqliteDb, workspaceId: string, workflowId: string): string | null {
  const workflow = db.select({ appId: schema.workflows.appId }).from(schema.workflows).where(and(
    eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.id, workflowId),
  )).get();
  if (workflow?.appId) {
    const app = db.select({ ownerAgentId: schema.apps.ownerAgentId }).from(schema.apps).where(eq(schema.apps.id, workflow.appId)).get();
    if (app?.ownerAgentId) return app.ownerAgentId;
    return db.select({ agentId: schema.appMembers.agentId }).from(schema.appMembers).where(eq(schema.appMembers.appId, workflow.appId)).get()?.agentId ?? null;
  }
  return db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.workspaceId, workspaceId)).get()?.id ?? null;
}

function toA2aTask(task: import('@agentis/core').AgentMission) {
  const state = task.status === 'accomplished' ? 'completed'
    : task.status === 'cancelled' ? 'canceled'
    : task.status === 'rejected' ? 'rejected'
    : task.status === 'input_required' ? 'input_required'
    : task.status === 'approval_required' ? 'auth_required'
    : ['blocked', 'failed'].includes(task.status) ? 'failed' : 'working';
  return {
    id: task.id, contextId: task.rootMissionId, kind: 'task',
    status: { state, timestamp: task.updatedAt, message: task.lastProgress ? { role: 'agent', parts: [{ kind: 'text', text: task.lastProgress }] } : undefined },
    artifacts: task.artifacts.map((artifact) => ({
      artifactId: artifact.id, name: artifact.name,
      parts: [{ kind: 'data', data: artifact }],
    })),
    history: (task.timeline ?? []).map((event) => ({ role: 'agent', messageId: event.id, parts: [{ kind: 'data', data: { type: event.eventType, payload: event.payload } }] })),
    metadata: { appId: task.appId, operationId: task.operationId, parentTaskId: task.parentMissionId, childTaskIds: task.childMissionIds },
  };
}

function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
