/**
 * MCP server surface — Agentis as an MCP provider (UNIVERSAL-HARNESS §5, Pillar 5).
 *
 * Two layers, one source of truth:
 *
 *   1. Workflow publication (REST convenience):
 *        POST /v1/mcp/publish    { workflowId, slug? }  → mark a workflow published
 *        POST /v1/mcp/unpublish  { workflowId }
 *        GET  /v1/mcp/tools                              → list published tools
 *        POST /v1/mcp/tools/:slug { inputs }             → run it, await, return output
 *
 *   2. Protocol-compliant MCP endpoint (JSON-RPC 2.0, Streamable HTTP shape):
 *        POST /v1/mcp/rpc        { jsonrpc, method, params, id }
 *        GET  /v1/mcp/server-card                        → discovery metadata
 *      Methods: `initialize`, `tools/list`, `tools/call`. The tool surface is the
 *      union of (a) the workspace's published workflows and (b) the
 *      MCP-exposed entries of the shared AgentisToolRegistry — so external MCP
 *      clients (Claude Code, Cursor, Codex) call the exact same tools the engine
 *      and chat use. No second tool table.
 *
 * Publication state lives in `workflow.settings.mcp`.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import {
  AgentisError,
  type AgentisToolContext,
  type ApprovalSensitivity,
  type ChannelToolOrigin,
  type WorkflowGraph,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import type { AgentisToolRegistry } from '../services/agentisToolRegistry.js';
import { listMcpResources, readMcpResource } from '../services/mcp/mcpResources.js';
import { runPublishedWorkflow, inputSchemaFor } from '../engine/runPublishedWorkflow.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';
import type { ConversationTurnLeaseRegistry } from '../services/conversation/conversationTurnLease.js';
import { APPROVAL_SENSITIVITY_HEADER, CONVERSATION_ID_HEADER, TURN_LEASE_HEADER } from '../services/mcp/mcpHarnessSession.js';
import { decideToolApproval, resolveToolApprovalPolicy } from '../services/chat/chatApprovalPolicy.js';
import { resultProvidesCompletionEvidence } from '../services/chat/completionEvidence.js';
import type { AgentMissionService } from '../services/agentMissions.js';
import { AppOperationRuntime } from '../services/appOperationRuntime.js';
import { AppDefinitionStore } from '@agentis/app';
import type { ExtensionRuntime } from '../services/extensionRuntime.js';
import { reconcileMissionToolResult } from '../services/missionToolResultReconciler.js';

interface McpSettings { published?: boolean; slug?: string }

const WORKFLOW_TOOL_PREFIX = 'agentis__';
const PROTOCOL_VERSION = '2025-06-18';
const MCP_CAPABILITIES = {
  tools: { listChanged: false },
  resources: { listChanged: false },
  extensions: { 'io.modelcontextprotocol/tasks': {} },
};
const APP_OPERATION_PREFIX = 'agentis_app__';
const AGENTIS_GATEWAY_INSTRUCTIONS = [
  'Agentis exposes a progressive-disclosure gateway, not its full internal control plane.',
  'Start with agentis.orient. Use agentis.tools.search, then agentis.tools.describe, then agentis.tools.call.',
  'Use agentis.code.execute for bounded multi-operation orchestration and agentis.task.status for run progress.',
  'A tool result is not delivery proof: verify the requested world-state and require an accomplished settlement.',
].join(' ');

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'workflow';
}

function mcpOf(settings: unknown): McpSettings {
  const s = settings && typeof settings === 'object' ? (settings as Record<string, unknown>).mcp : undefined;
  return s && typeof s === 'object' ? (s as McpSettings) : {};
}

export interface McpRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  engine: WorkflowEngine;
  /** Shared tool registry — the same tools chat and the engine use. */
  toolRegistry?: AgentisToolRegistry;
  /** Revocable capabilities for tools called by interactive CLI harness turns. */
  turnLeases?: ConversationTurnLeaseRegistry;
  missions: AgentMissionService;
  extensions?: ExtensionRuntime;
}

export function buildMcpRoutes(deps: McpRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  // ── Workflow publication (REST convenience) ──────────────────────────────
  app.post('/publish', async (c) => {
    const ws = getWorkspace(c);
    const body = (await c.req.json().catch(() => ({}))) as { workflowId?: string; slug?: string };
    if (!body.workflowId) throw new AgentisError('VALIDATION_FAILED', 'workflowId is required');
    const wf = deps.db.select().from(schema.workflows)
      .where(and(eq(schema.workflows.id, body.workflowId), eq(schema.workflows.workspaceId, ws.workspaceId))).get();
    if (!wf) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow ${body.workflowId} not found`);
    const slug = slugify(body.slug ?? wf.title);
    const clash = deps.db.select({ id: schema.workflows.id, settings: schema.workflows.settings })
      .from(schema.workflows).where(eq(schema.workflows.workspaceId, ws.workspaceId)).all()
      .find((r) => r.id !== wf.id && mcpOf(r.settings).slug === slug && mcpOf(r.settings).published);
    if (clash) throw new AgentisError('RESOURCE_CONFLICT', `MCP slug '${slug}' is already in use`);
    const settings = { ...(wf.settings as Record<string, unknown> ?? {}), mcp: { published: true, slug } };
    deps.db.update(schema.workflows).set({ settings, updatedAt: new Date().toISOString() }).where(eq(schema.workflows.id, wf.id)).run();
    return c.json({ workflowId: wf.id, toolName: `${WORKFLOW_TOOL_PREFIX}${slug}`, slug, endpoint: `/v1/mcp/tools/${slug}` });
  });

  app.post('/unpublish', async (c) => {
    const ws = getWorkspace(c);
    const body = (await c.req.json().catch(() => ({}))) as { workflowId?: string };
    const wf = body.workflowId ? deps.db.select().from(schema.workflows)
      .where(and(eq(schema.workflows.id, body.workflowId), eq(schema.workflows.workspaceId, ws.workspaceId))).get() : null;
    if (!wf) throw new AgentisError('RESOURCE_NOT_FOUND', 'workflow not found');
    const settings = { ...(wf.settings as Record<string, unknown> ?? {}), mcp: { published: false } };
    deps.db.update(schema.workflows).set({ settings, updatedAt: new Date().toISOString() }).where(eq(schema.workflows.id, wf.id)).run();
    return c.json({ workflowId: wf.id, published: false });
  });

  app.get('/tools', (c) => {
    const ws = getWorkspace(c);
    return c.json({ tools: listWorkflowTools(deps.db, ws.workspaceId) });
  });

  app.post('/tools/:slug', async (c) => {
    const ws = getWorkspace(c);
    const slug = c.req.param('slug');
    const body = (await c.req.json().catch(() => ({}))) as { inputs?: Record<string, unknown> };
    const wf = findPublishedBySlug(deps.db, ws.workspaceId, slug);
    if (!wf) throw new AgentisError('RESOURCE_NOT_FOUND', `no published MCP tool '${slug}'`);
    const result = await runPublishedWorkflow({
      db: deps.db, engine: deps.engine,
      workspaceId: ws.workspaceId, ambientId: ws.ambientId, userId: ws.user.id,
      workflowId: wf.id, graph: wf.graph as WorkflowGraph, inputs: body.inputs ?? {},
    });
    return c.json({ runId: result.runId, status: result.status, executionStatus: result.executionStatus, outcomeStatus: result.outcomeStatus, settlement: result.settlement, output: result.output });
  });

  // ── Discovery card ───────────────────────────────────────────────────────
  app.get('/server-card', (c) => {
    const ws = getWorkspace(c);
    const tools = collectMcpTools(deps, ws.workspaceId);
    return c.json({
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: { name: 'agentis', version: '1.0.0' },
      capabilities: MCP_CAPABILITIES,
      toolCount: tools.length,
      endpoint: '/v1/mcp/rpc',
      instructions: AGENTIS_GATEWAY_INSTRUCTIONS,
    });
  });

  // ── Protocol-compliant JSON-RPC endpoint ──────────────────────────────────
  app.post('/rpc', async (c) => {
    const ws = getWorkspace(c);
    const agentId = resolveMcpAgentId(deps.db, ws.workspaceId, c.req.header('x-agentis-agent'));
    // Per-turn permission posture: an mcp_native harness tags its descriptor with
    // this header, so the tool registry gates mutating tools for the harness's OWN
    // loop — real enforcement, not just the prompt addendum. `plan` hard-blocks,
    // `ask` blocks-and-instructs (operator approves), anything else = Auto (allow).
    const headerMode = c.req.header('x-agentis-execution-mode');
    const executionMode: 'chat' | 'plan' | 'ask' = headerMode === 'plan' ? 'plan' : headerMode === 'ask' ? 'ask' : 'chat';
    const headerSensitivity = c.req.header(APPROVAL_SENSITIVITY_HEADER);
    const approvalSensitivity: ApprovalSensitivity = headerSensitivity === 'cautious'
      ? 'cautious'
      : headerSensitivity === 'autonomous' ? 'autonomous' : 'balanced';
    const body = (await c.req.json().catch(() => null)) as JsonRpcRequest | null;
    if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return c.json(rpcError(body?.id ?? null, -32600, 'Invalid Request'));
    }
    const id = body.id ?? null;

    try {
      const conversationId = c.req.header(CONVERSATION_ID_HEADER)?.trim();
      const turnLease = c.req.header(TURN_LEASE_HEADER)?.trim();
      if (Boolean(conversationId) !== Boolean(turnLease)) {
        throw new AgentisError('TURN_CANCELLED', 'Incomplete conversation turn capability. The tool was not executed.');
      }
      const leaseContext = conversationId && turnLease && deps.turnLeases
        ? deps.turnLeases.context(ws.workspaceId, conversationId, turnLease)
        : undefined;
      const allowedToolIds = leaseContext?.allowedToolIds ? new Set(leaseContext.allowedToolIds) : null;
      switch (body.method) {
        case 'initialize':
          return c.json(rpcResult(id, {
            protocolVersion: PROTOCOL_VERSION,
            serverInfo: { name: 'agentis', version: '1.0.0' },
            capabilities: MCP_CAPABILITIES,
            // PAVED-ROAD P2 — deliver the doctrine at the door. MCP clients
            // surface `instructions` to the model as system context, so an
            // external harness gets the build loop + data-flow contract instead
            // of a flat pile of ~70 undocumented tool names.
            instructions: AGENTIS_GATEWAY_INSTRUCTIONS,
          }));
        case 'notifications/initialized':
          // Notification — no response body expected, but return 202-style ack.
          return c.body(null, 202);
        case 'resources/list':
          return c.json(rpcResult(id, { resources: listMcpResources() }));
        case 'resources/templates/list':
          return c.json(rpcResult(id, { resourceTemplates: [] }));
        case 'resources/read': {
          const params = (body.params ?? {}) as { uri?: string };
          if (!params.uri) return c.json(rpcError(id, -32602, 'resources/read requires params.uri'));
          const contents = readMcpResource(deps.db, ws.workspaceId, params.uri);
          if (!contents) return c.json(rpcError(id, -32602, `Unknown resource '${params.uri}'`));
          return c.json(rpcResult(id, contents));
        }
        case 'tasks/get': {
          const params = (body.params ?? {}) as { taskId?: string };
          if (!params.taskId) return c.json(rpcError(id, -32602, 'tasks/get requires params.taskId'));
          return c.json(rpcResult(id, toMcpTask(deps.missions.inspect(ws.workspaceId, params.taskId))));
        }
        case 'tasks/list': {
          const params = (body.params ?? {}) as { limit?: number };
          return c.json(rpcResult(id, { tasks: deps.missions.list(ws.workspaceId, { limit: params.limit }).map(toMcpTask) }));
        }
        case 'tasks/cancel': {
          const params = (body.params ?? {}) as { taskId?: string };
          if (!params.taskId) return c.json(rpcError(id, -32602, 'tasks/cancel requires params.taskId'));
          return c.json(rpcResult(id, toMcpTask(deps.missions.cancel(ws.workspaceId, params.taskId, 'Cancelled by MCP client'))));
        }
        case 'tasks/update': {
          const params = (body.params ?? {}) as { taskId?: string; inputResponses?: Record<string, unknown> };
          if (!params.taskId || !params.inputResponses) return c.json(rpcError(id, -32602, 'tasks/update requires taskId and inputResponses'));
          let task = deps.missions.inspect(ws.workspaceId, params.taskId);
          for (const [requestId, response] of Object.entries(params.inputResponses)) {
            task = deps.missions.submitInput(ws.workspaceId, task.id, requestId, response, ws.user.id);
          }
          return c.json(rpcResult(id, toMcpTask(task)));
        }
        case 'tools/list': {
          // A conversation lease already carries the exact catalog selected by
          // ChatSessionExecutor. Native harnesses need those real schemas (not
          // the generic progressive-disclosure gateway), and must see nothing
          // outside that set. Unleased integrations retain the compact gateway.
          const visible = allowedToolIds
            ? allMcpOperations(deps, ws.workspaceId).filter((tool) => allowedToolIds.has(tool.name))
            : collectMcpTools(deps, ws.workspaceId);
          return c.json(rpcResult(id, { tools: visible.map(toMcpDescriptor) }));
        }
        case 'tools/call': {
          const params = (body.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
          if (!params.name) return c.json(rpcError(id, -32602, 'tools/call requires params.name'));
          const effectiveToolName = params.name === 'agentis.tools.call' && typeof params.arguments?.name === 'string'
            ? params.arguments.name : params.name;
          if (allowedToolIds && !allowedToolIds.has(effectiveToolName)) {
            throw new AgentisError('AUTH_FORBIDDEN', `Tool '${effectiveToolName}' is outside this turn's bounded capability set.`);
          }
          let turnSignal: AbortSignal | undefined;
          let channelOrigin: ChannelToolOrigin | undefined;
          if (conversationId && turnLease) {
            if (!deps.turnLeases) throw new AgentisError('TURN_CANCELLED', 'Conversation turn capability enforcement is unavailable. The tool was not executed.');
            turnSignal = deps.turnLeases.assertActive(ws.workspaceId, conversationId, turnLease);
            channelOrigin = leaseContext?.channelOrigin;
          }
          const startedAt = Date.now();
          const effectiveArguments = params.name === 'agentis.tools.call'
            && params.arguments?.arguments && typeof params.arguments.arguments === 'object' && !Array.isArray(params.arguments.arguments)
            ? params.arguments.arguments as Record<string, unknown> : params.arguments ?? {};
          const toolCallId = `mcp:${turnLease ?? 'unleased'}:${String(id ?? randomUUID())}`;
          const appOperation = parseAppOperationTool(effectiveToolName);
          if (appOperation) {
            const invoked = await new AppOperationRuntime(deps).invoke({
              workspaceId: ws.workspaceId, ambientId: ws.ambientId, userId: ws.user.id,
              appId: appOperation.appId, operationId: appOperation.operationId, input: effectiveArguments,
            });
            if (isObject(invoked) && invoked.kind === 'task' && isObject(invoked.task) && typeof invoked.task.id === 'string') {
              const task = deps.missions.inspect(ws.workspaceId, invoked.task.id);
              return c.json(rpcResult(id, textResult(JSON.stringify({ resultType: 'task', taskId: task.id, status: toMcpTask(task).status, pollIntervalMs: 1000 }))));
            }
            if (leaseContext?.missionId) reconcileMissionToolResult(deps.missions, deps.toolRegistry, {
              workspaceId: ws.workspaceId,
              missionId: leaseContext.missionId,
              toolId: effectiveToolName,
              toolCallId,
              toolInput: effectiveArguments,
              output: invoked,
            });
            // MCP tools/call results MUST carry `content` as a ContentBlock[];
            // AppOperationRuntime's own `content` field is an unrelated
            // ContentEnvelope (object), so returning `invoked` verbatim here
            // shadows that key and fails strict MCP client validation.
            return c.json(rpcResult(id, textResult(JSON.stringify(invoked))));
          }
          const result = await callMcpTool(
            deps,
            {
              ...ws,
              agentId,
              executionMode,
              approvalSensitivity,
              ...(conversationId ? { conversationId } : {}),
              ...(leaseContext?.missionId ? { missionId: leaseContext.missionId } : {}),
              ...(turnSignal ? { turnSignal } : {}),
              ...(channelOrigin ? { channelOrigin } : {}),
              toolCallId,
            },
            params.name,
            params.arguments ?? {},
          );
          const resultPayload = experiencePayload(result);
          if (result.isError !== true && leaseContext?.missionId) reconcileMissionToolResult(deps.missions, deps.toolRegistry, {
            workspaceId: ws.workspaceId,
            missionId: leaseContext.missionId,
            toolId: effectiveToolName,
            toolCallId,
            toolInput: effectiveArguments,
            output: resultPayload,
          });
          if (conversationId && turnLease && deps.turnLeases) {
            const gatewayTarget = params.name === 'agentis.tools.call' && typeof params.arguments?.name === 'string'
              ? params.arguments.name
              : params.name;
            const gatewayArguments = params.name === 'agentis.tools.call'
              && params.arguments?.arguments
              && typeof params.arguments.arguments === 'object'
              && !Array.isArray(params.arguments.arguments)
              ? params.arguments.arguments as Record<string, unknown>
              : params.arguments ?? {};
            // The compact gateway must remain transparent to the capability
            // ledger. Record the invoked operation (and its mutation posture),
            // otherwise a write hidden behind tools.call would not advance the
            // conversation's state frontier and later reads could be deduped
            // against stale observations.
            const mutating = gatewayTarget.startsWith(WORKFLOW_TOOL_PREFIX)
              || Boolean(deps.toolRegistry?.get(gatewayTarget)?.mutating);
            const observation = deps.turnLeases.recordToolResult({
              workspaceId: ws.workspaceId,
              conversationId,
              token: turnLease,
              name: gatewayTarget,
              toolArgs: gatewayArguments,
              result: resultPayload,
              ok: result.isError !== true && resultProvidesCompletionEvidence(resultPayload),
              mutating,
              durationMs: Date.now() - startedAt,
            });
            if (observation.repeated) {
              return c.json(rpcResult(id, textResult(JSON.stringify({
                unchanged: true,
                sameAsObservation: observation.observationIndex,
                stateVersion: observation.stateVersion,
                message: 'This read returned the same result at the same mutation frontier. Reuse the earlier observation; no payload was repeated.',
              }))));
            }
          }
          return c.json(rpcResult(id, result));
        }
        default:
          return c.json(rpcError(id, -32601, `Method not found: ${body.method}`));
      }
    } catch (err) {
      // §F7 — an AgentisError carries a code + directive remediation the platform
      // wrote for exactly this failure. Return it as JSON-RPC error `data` instead
      // of discarding everything but the message under a bare -32603.
      if (err instanceof AgentisError) {
        return c.json(rpcError(id, -32603, err.message, {
          code: err.code,
          ...(err.remediation ? { remediation: err.remediation } : {}),
          ...(err.details ? { details: err.details } : {}),
        }));
      }
      const message = err instanceof Error ? err.message : 'internal error';
      return c.json(rpcError(id, -32603, message));
    }
  });

  return app;
}

// ─── Tool collection (published workflows + registry) ───────────────────────

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  kind: 'workflow' | 'registry' | 'app';
  /** workflow slug or registry tool id. */
  ref: string;
  annotations?: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
}

function collectMcpTools(deps: McpRoutesDeps, workspaceId: string): McpTool[] {
  return gatewayMcpTools(deps, workspaceId);
}

/**
 * Keep the model-facing surface intentionally tiny. Legacy direct names remain
 * callable for compatibility, but are discovered through search/describe rather
 * than forcing every model turn to ingest more than one hundred schemas.
 */
function gatewayMcpTools(deps: McpRoutesDeps, workspaceId: string): McpTool[] {
  const exposed = allMcpOperations(deps, workspaceId);
  const direct = (name: string): McpTool | null => exposed.find((tool) => tool.name === name) ?? null;
  return [
    direct('agentis.orient'),
    {
      name: 'agentis.tools.search',
      description: 'Search Agentis operations by goal, family, or name. Returns compact matches; call describe before invoking an unfamiliar operation.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query'], additionalProperties: false },
      kind: 'registry', ref: 'gateway:search',
    },
    {
      name: 'agentis.tools.describe',
      description: 'Load the exact schema and mutation policy for one Agentis operation.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
      kind: 'registry', ref: 'gateway:describe',
    },
    {
      name: 'agentis.tools.call',
      description: 'Invoke one operation discovered through search/describe. Server-side validation and conversation permissions still apply.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name'], additionalProperties: false },
      kind: 'registry', ref: 'gateway:call',
    },
    direct('agentis.code.execute'),
    {
      name: 'agentis.task.status',
      description: 'Read the durable status and settlement of a workflow run.',
      inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'], additionalProperties: false },
      kind: 'registry', ref: 'gateway:status',
    },
  ].filter((tool): tool is McpTool => Boolean(tool));
}

function allMcpOperations(deps: McpRoutesDeps, workspaceId: string): McpTool[] {
  const tools: McpTool[] = listWorkflowTools(deps.db, workspaceId).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    kind: 'workflow' as const,
    ref: t.slug,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }));
  if (deps.toolRegistry) {
    for (const def of deps.toolRegistry.catalog({ mcpOnly: true }).tools) {
      tools.push({
        name: def.id,
        description: def.description,
        inputSchema: (def.inputSchema && typeof def.inputSchema === 'object'
          ? def.inputSchema
          : { type: 'object' }) as Record<string, unknown>,
      kind: 'registry',
      ref: def.id,
      annotations: {
        readOnlyHint: !def.mutating,
        destructiveHint: Boolean(def.approval?.destructive),
        openWorldHint: Boolean(def.approval?.externalSideEffects),
      },
      });
    }
  }
  const definitions = new AppDefinitionStore(deps.db);
  const apps = deps.db.select({ id: schema.apps.id }).from(schema.apps)
    .where(eq(schema.apps.workspaceId, workspaceId)).all();
  for (const app of apps) {
    const definition = definitions.get(workspaceId, app.id);
    if (definition?.projections?.mcp.enabled === false) continue;
    for (const operation of definition?.contract?.operations ?? []) {
      tools.push({
        name: `${APP_OPERATION_PREFIX}${app.id}__${operation.id}`,
        description: operation.description || operation.title,
        inputSchema: operation.inputSchema,
        kind: 'app', ref: `${app.id}:${operation.id}`,
        annotations: {
          readOnlyHint: operation.effects.every((effect) => effect.level === 'read'),
          destructiveHint: operation.effects.some((effect) => effect.level === 'irreversible'),
          openWorldHint: operation.effects.some((effect) => effect.kind !== 'data_mutation'),
        },
      });
    }
  }
  return tools;
}

function listWorkflowTools(db: AgentisSqliteDb, workspaceId: string) {
  return db.select().from(schema.workflows).where(eq(schema.workflows.workspaceId, workspaceId)).all()
    .map((r) => ({ r, mcp: mcpOf(r.settings) }))
    .filter((x) => x.mcp.published && x.mcp.slug)
    .map(({ r, mcp }) => ({
      name: `${WORKFLOW_TOOL_PREFIX}${mcp.slug}`,
      slug: mcp.slug!,
      workflowId: r.id,
      description: r.description ?? r.title,
      inputSchema: inputSchemaFor(r.graph as WorkflowGraph),
      endpoint: `/v1/mcp/tools/${mcp.slug}`,
    }));
}

function findPublishedBySlug(db: AgentisSqliteDb, workspaceId: string, slug: string) {
  return db.select().from(schema.workflows).where(eq(schema.workflows.workspaceId, workspaceId)).all()
    .find((r) => { const m = mcpOf(r.settings); return Boolean(m.published && m.slug === slug); });
}

function resolveMcpAgentId(db: AgentisSqliteDb, workspaceId: string, agentId?: string): string | undefined {
  if (!agentId) return undefined;
  const agent = db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.workspaceId, workspaceId)))
    .get();
  if (!agent) throw new AgentisError('CROSS_WORKSPACE_ACCESS', 'Agent not in workspace');
  return agent.id;
}

function toMcpDescriptor(t: McpTool) {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.annotations ? { annotations: t.annotations } : {}),
  };
}

/** Execute an MCP tool call → MCP `content` result shape. */
async function callMcpTool(
  deps: McpRoutesDeps,
  ws: { workspaceId: string; ambientId: string | null; user: { id: string }; agentId?: string; executionMode?: 'chat' | 'plan' | 'ask'; approvalSensitivity?: ApprovalSensitivity; conversationId?: string; missionId?: string; toolCallId?: string; turnSignal?: AbortSignal; channelOrigin?: ChannelToolOrigin },
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  if (name === 'agentis.tools.search') {
    const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
    if (!query) return textResult(JSON.stringify({ error: 'query is required', path: 'query', expected: 'non-empty string' }), true);
    const limit = Math.max(1, Math.min(20, Number(args.limit) || 10));
    const terms = query.split(/\s+/).filter(Boolean);
    const matches = allMcpOperations(deps, ws.workspaceId)
      .map((tool) => {
        const haystack = `${tool.name} ${tool.description}`.toLowerCase();
        const score = terms.reduce((total, term) => total + (tool.name.toLowerCase().includes(term) ? 4 : haystack.includes(term) ? 1 : 0), 0);
        return { tool, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
      .slice(0, limit)
      .map(({ tool }) => ({ name: tool.name, description: tool.description, kind: tool.kind }));
    return textResult(JSON.stringify({ query, matches, next: matches.length ? 'Describe one exact operation before calling it.' : 'Try a broader goal or domain term.' }));
  }
  if (name === 'agentis.tools.describe') {
    const target = typeof args.name === 'string' ? args.name.trim() : '';
    const tool = allMcpOperations(deps, ws.workspaceId).find((candidate) => candidate.name === target);
    if (!tool) return textResult(JSON.stringify({ error: `Unknown operation '${target}'`, remediation: 'Use agentis.tools.search first.' }), true);
    const definition = tool.kind === 'registry' ? deps.toolRegistry?.get(tool.ref) : undefined;
    return textResult(JSON.stringify({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      mutating: tool.kind === 'workflow' || Boolean(definition?.mutating),
      approval: resolveToolApprovalPolicy(tool.kind === 'workflow' ? 'workflow.published' : tool.name, definition),
    }));
  }
  if (name === 'agentis.tools.call') {
    const target = typeof args.name === 'string' ? args.name.trim() : '';
    if (!target || target.startsWith('agentis.tools.')) return textResult(JSON.stringify({ error: 'name must identify a non-gateway operation' }), true);
    const callArgs = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
      ? args.arguments as Record<string, unknown>
      : {};
    return callMcpTool(deps, ws, target, callArgs);
  }
  if (name === 'agentis.task.status') {
    return callMcpTool(deps, ws, 'agentis.run.status', args);
  }
  // Workflow tool?
  if (name.startsWith(WORKFLOW_TOOL_PREFIX)) {
    if (ws.executionMode === 'plan') {
      return textResult(JSON.stringify({
        error: `tool '${name}' cannot mutate workspace state while the conversation is in Plan mode`,
        code: 'PLAN_MODE_MUTATION_BLOCKED',
      }), true);
    }
    const approval = decidePublishedWorkflowApproval(name, ws);
    if (approval) return approval;
    const slug = name.slice(WORKFLOW_TOOL_PREFIX.length);
    const wf = findPublishedBySlug(deps.db, ws.workspaceId, slug);
    if (!wf) return textResult(`No published MCP workflow tool '${name}'`, true);
    const result = await runPublishedWorkflow({
      db: deps.db, engine: deps.engine,
      workspaceId: ws.workspaceId, ambientId: ws.ambientId, userId: ws.user.id,
      workflowId: wf.id, graph: wf.graph as WorkflowGraph, inputs: args,
      conversationId: ws.conversationId ?? null,
    });
    const ok = result.executionStatus === 'completed' && result.outcomeStatus === 'accomplished';
    return textResult(JSON.stringify({
      runId: result.runId,
      status: result.status,
      executionStatus: result.executionStatus,
      outcomeStatus: result.outcomeStatus,
      settlement: result.settlement,
      output: result.output,
      ok,
      ...(!ok ? { remediation: 'Execution stopping is not delivery proof. Add or satisfy a definition of done, then rerun/regrade the exact revision.' } : {}),
    }), !ok);
  }

  // Registry tool?
  if (deps.toolRegistry?.has(name)) {
    const def = deps.toolRegistry.get(name);
    if (!def?.mcpExposed) return textResult(`Tool '${name}' is not exposed over MCP`, true);
    const ctx: AgentisToolContext = {
      workspaceId: ws.workspaceId,
      userId: ws.user.id,
      ambientId: ws.ambientId,
      ...(ws.agentId ? { agentId: ws.agentId } : {}),
      ...(ws.executionMode ? { executionMode: ws.executionMode } : {}),
      ...(ws.approvalSensitivity ? { approvalSensitivity: ws.approvalSensitivity } : {}),
      ...(ws.conversationId ? { conversationId: ws.conversationId } : {}),
      ...(ws.missionId ? { missionId: ws.missionId } : {}),
      ...(ws.channelOrigin ? { channelOrigin: ws.channelOrigin } : {}),
      ...(ws.turnSignal ? { signal: ws.turnSignal } : {}),
      caller: 'mcp',
    };
    const res = await deps.toolRegistry.execute({ id: ws.toolCallId ?? '', toolId: name, arguments: args }, ctx);
    // §F7 — hand the agent the directive: code + message + remediation + details, not a bare enum.
    return res.ok
      ? textResult(JSON.stringify(compactMcpOutput(res.output, args)))
      : textResult(JSON.stringify({
          error: res.errorMessage,
          code: res.errorCode,
          ...(res.remediation ? { remediation: res.remediation } : {}),
          ...(res.details ? { details: res.details } : {}),
        }), true);
  }

  return textResult(`Unknown tool '${name}'`, true);
}

function decidePublishedWorkflowApproval(
  name: string,
  ws: { executionMode?: 'chat' | 'plan' | 'ask'; approvalSensitivity?: ApprovalSensitivity },
): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } | null {
  if (ws.executionMode !== 'ask') return null;
  const decision = decideToolApproval({
    name: 'workflow.published',
    permissionMode: 'ask',
    sensitivity: ws.approvalSensitivity,
  });
  if (!decision.requiresApproval) return null;
  return textResult(JSON.stringify({
    error: `tool '${name}' is ${decision.riskLevel} risk and meets this conversation's Ask threshold — it was NOT executed. Do not retry. Ask the operator to approve the workflow run.`,
    code: 'ASK_MODE_CONFIRMATION_REQUIRED',
  }), true);
}

// Roughly 3k tokens: enough for a useful structured observation without making
// every subsequent native-harness inference re-ingest a 6k-token payload. Full
// fidelity remains explicit and resource-scoped, so this is progressive
// disclosure rather than a capability restriction.
const MAX_DEFAULT_MCP_OUTPUT_CHARS = 12_000;

/**
 * CLI harnesses append every MCP response to the model context. Keep the
 * default bounded; exact full payloads remain available through an explicit
 * detail:"full"/"graph" request on tools that support them.
 */
function compactMcpOutput(output: unknown, args: Record<string, unknown>): unknown {
  const serialized = JSON.stringify(output);
  if (serialized.length <= MAX_DEFAULT_MCP_OUTPUT_CHARS) return output;
  if (args.detail === 'full' || args.detail === 'graph') return output;
  return {
    truncated: true,
    originalChars: serialized.length,
    preview: serialized.slice(0, MAX_DEFAULT_MCP_OUTPUT_CHARS),
    remediation: 'Use narrower filters or request detail:"full"/"graph" for one exact resource only. Do not repeat broad full-result calls.',
  };
}

function textResult(text: string, isError = false): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function experiencePayload(result: { content: Array<{ type: 'text'; text: string }>; isError?: boolean }): unknown {
  const text = result.content.map((entry) => entry.text).join('\n');
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

function parseAppOperationTool(name: string): { appId: string; operationId: string } | null {
  if (!name.startsWith(APP_OPERATION_PREFIX)) return null;
  const separator = name.indexOf('__', APP_OPERATION_PREFIX.length);
  if (separator < 0) return null;
  return { appId: name.slice(APP_OPERATION_PREFIX.length, separator), operationId: name.slice(separator + 2) };
}

function toMcpTask(task: import('@agentis/core').AgentMission) {
  const status = task.status === 'accomplished' ? 'completed'
    : task.status === 'cancelled' || task.status === 'rejected' ? 'cancelled'
    : task.status === 'input_required' || task.status === 'approval_required' ? 'input_required'
    : task.status === 'failed' || task.status === 'blocked' ? 'failed' : 'working';
  return {
    taskId: task.id, status, statusMessage: task.lastProgress ?? undefined,
    inputRequests: status === 'input_required'
      ? Object.fromEntries(task.inputRequests.filter((request) => request.status === 'pending').map((request) => [request.id, {
        type: 'elicitation', message: request.description ?? request.title, schema: request.schema,
      }])) : undefined,
    result: status === 'completed' ? { artifacts: task.artifacts, receipts: task.receipts } : undefined,
    error: status === 'failed' ? { code: task.blocker?.code ?? 'TASK_FAILED', message: task.blocker?.detail ?? 'Task failed' } : undefined,
    createdAt: task.createdAt, updatedAt: task.updatedAt,
  };
}

function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

// ─── JSON-RPC helpers ───────────────────────────────────────────────────────

interface JsonRpcRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown }

function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string, data?: Record<string, unknown>) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}
