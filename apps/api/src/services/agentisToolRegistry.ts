/**
 * AgentisToolRegistry — AGENT-FIRST-ARCHITECTURE.md Plane 2.
 *
 * Single source of truth for the agent-facing machine surface. The registry
 * is independent of transport — chat, workflow tool execution, and external
 * MCP clients all dispatch through the same registry instance.
 *
 *   AgentisToolRegistry
 *     -> ChatToolExecutor (interactive)
 *     -> WorkflowEngine.tool_call (graph-driven)
 *     -> mcpInterop.expose() (external)
 *
 * Errors return as data (`{ ok: false, errorCode, errorMessage }`) — never
 * thrown. A throw is treated as a programming error and logged separately.
 */

import { createHash, randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import {
  AgentisError,
  type AgentisToolCallRequest,
  type AgentisToolCallResult,
  type AgentisToolCatalog,
  type AgentisToolContext,
  type AgentisToolDefinition,
} from '@agentis/core';
import type { Logger } from '../logger.js';
import { decideToolApproval } from './chat/chatApprovalPolicy.js';
import type { TurnChangeJournal } from './conversation/turnChangeJournal.js';

export interface AgentisToolHandler<TIn = Record<string, unknown>, TOut = unknown> {
  (args: TIn, ctx: AgentisToolContext): Promise<TOut> | TOut;
}

export interface RegisteredTool {
  definition: AgentisToolDefinition;
  handler: AgentisToolHandler;
}

export interface RegistryDeps {
  logger: Logger;
  turnChanges?: TurnChangeJournal;
  /** Optional clock — overridable in tests. */
  now?: () => Date;
  /** Optional minimal validator. Defaults to a permissive shape check. */
  validateArgs?: (schema: unknown, args: unknown) => { ok: true } | { ok: false; reason: string };
}

const noopValidate = (schema: unknown, args: unknown): { ok: true } | { ok: false; reason: string } => {
  // Minimal shape check: if schema is an object with required[], ensure args has those keys.
  if (
    schema &&
    typeof schema === 'object' &&
    'required' in (schema as Record<string, unknown>) &&
    Array.isArray((schema as { required: unknown[] }).required)
  ) {
    if (!args || typeof args !== 'object') return { ok: false, reason: 'arguments must be an object' };
    for (const key of (schema as { required: string[] }).required) {
      if (!(key in (args as Record<string, unknown>))) {
        return { ok: false, reason: `missing required argument '${key}'` };
      }
    }
  }
  return { ok: true };
};

export class AgentisToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #validate: NonNullable<RegistryDeps['validateArgs']>;
  readonly #turnChanges?: TurnChangeJournal;

  constructor(deps: RegistryDeps) {
    this.#logger = deps.logger;
    this.#now = deps.now ?? (() => new Date());
    this.#validate = deps.validateArgs ?? noopValidate;
    this.#turnChanges = deps.turnChanges;
  }

  /** Register a tool. Throws on duplicate id — registration is one-shot. */
  register<TIn extends Record<string, unknown> = Record<string, unknown>, TOut = unknown>(
    definition: AgentisToolDefinition,
    handler: AgentisToolHandler<TIn, TOut>,
  ): void {
    if (this.#tools.has(definition.id)) {
      throw new AgentisError('VALIDATION_FAILED', `tool '${definition.id}' is already registered`);
    }
    const normalized = definition.mutating && !definition.mutationBehavior
      ? { ...definition, mutationBehavior: inferMutationBehavior(definition.id) }
      : definition;
    this.#tools.set(definition.id, { definition: normalized, handler: handler as AgentisToolHandler });
  }

  /**
   * Bulk register; useful for handler families. `defaultMcpExposed` exposes the
   * whole family to MCP-native harnesses (codex/claude/cursor) unless an entry
   * sets `mcpExposed` explicitly — so a family of agent tools doesn't have to
   * repeat the flag on every definition (and can't silently forget it).
   */
  registerMany(
    entries: Array<{ definition: AgentisToolDefinition; handler: AgentisToolHandler }>,
    opts: { defaultMcpExposed?: boolean } = {},
  ): void {
    for (const e of entries) {
      const definition = opts.defaultMcpExposed && e.definition.mcpExposed === undefined
        ? { ...e.definition, mcpExposed: true }
        : e.definition;
      this.register(definition, e.handler);
    }
  }

  /** Returns true if the tool exists. */
  has(toolId: string): boolean {
    return this.#tools.has(toolId);
  }

  /** Returns a definition by id (or undefined). Read-only — do not mutate. */
  get(toolId: string): AgentisToolDefinition | undefined {
    return this.#tools.get(toolId)?.definition;
  }

  /** Returns the full catalog (for chat clients & MCP exposure). */
  catalog(opts: { mcpOnly?: boolean } = {}): AgentisToolCatalog {
    const tools: AgentisToolDefinition[] = [];
    for (const t of this.#tools.values()) {
      if (opts.mcpOnly && !t.definition.mcpExposed) continue;
      tools.push(t.definition);
    }
    tools.sort((a, b) => a.id.localeCompare(b.id));
    const hash = createHash('sha256').update(JSON.stringify(tools.map((t) => t.id + ':' + t.family))).digest('hex').slice(0, 16);
    return { tools, hash, generatedAt: this.#now().toISOString() };
  }

  /**
   * Execute a tool. Returns a structured result; never throws for tool-level
   * failures. Programming errors (handler throws an unexpected exception)
   * are logged and surfaced as `INTERNAL_TOOL_ERROR`.
   */
  async execute(req: AgentisToolCallRequest, ctx: AgentisToolContext): Promise<AgentisToolCallResult> {
    const callId = req.id || randomUUID();
    const startedAt = Date.now();
    const tool = this.#tools.get(req.toolId);
    if (!tool) {
      return {
        id: callId,
        toolId: req.toolId,
        ok: false,
        errorCode: 'TOOL_NOT_FOUND',
        errorMessage: `tool '${req.toolId}' is not registered`,
        durationMs: 0,
      };
    }

    // Cancellation is a dispatch boundary, not a cooperative suggestion. Check
    // before validation/permission/handler work so a stopped in-process turn can
    // never start another mutation while its model loop is winding down.
    if (ctx.signal?.aborted) {
      return {
        id: callId,
        toolId: req.toolId,
        ok: false,
        errorCode: 'TURN_CANCELLED',
        errorMessage: 'This conversation turn was stopped. The tool was not executed.',
        durationMs: Date.now() - startedAt,
      };
    }

    const planBlocked = ctx.executionMode === 'plan' && tool.definition.mutating;
    const askDecision = decideToolApproval({
      name: req.toolId,
      definition: tool.definition,
      permissionMode: ctx.executionMode === 'ask' ? 'ask' : 'auto',
      sensitivity: ctx.approvalSensitivity,
    });
    if (planBlocked || (ctx.executionMode === 'ask' && askDecision.requiresApproval)) {
      const ask = ctx.executionMode === 'ask';
      return {
        id: callId,
        toolId: req.toolId,
        ok: false,
        errorCode: ask ? 'ASK_MODE_CONFIRMATION_REQUIRED' : 'PLAN_MODE_MUTATION_BLOCKED',
        errorMessage: ask
          ? `tool '${req.toolId}' is ${askDecision.riskLevel} risk and meets this conversation's Ask threshold — it was NOT executed. Do not retry. Briefly explain the consequential effect and ask the operator to approve it. Routine lower-risk work remains autonomous.`
          : `tool '${req.toolId}' cannot mutate workspace state while the conversation is in Plan mode`,
        durationMs: Date.now() - startedAt,
      };
    }

    // Argument validation up front — keeps handlers focused on logic.
    const v = this.#validate(tool.definition.inputSchema, req.arguments);
    if (!v.ok) {
      return {
        id: callId,
        toolId: req.toolId,
        ok: false,
        errorCode: 'VALIDATION_FAILED',
        errorMessage: v.reason,
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      const invoke = () => tool.handler(req.arguments, ctx);
      const output = tool.definition.mutating && ctx.durableTurnId && this.#turnChanges
        ? await this.#turnChanges.captureTool({
            workspaceId: ctx.workspaceId,
            durableTurnId: ctx.durableTurnId,
            toolCallId: callId,
            toolId: req.toolId,
            behavior: tool.definition.mutationBehavior ?? 'local',
          }, invoke)
        : await invoke();
      return {
        id: callId,
        toolId: req.toolId,
        ok: true,
        output,
        costCents: 0,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      // A handler-side zod failure (e.g. `dataQuerySchema.parse`) is a CONTRACT
      // problem, not an internal crash. Render it as an instructive validation
      // error naming the offending field + shape so the agent's retry is correct —
      // never dump the raw multi-line ZodError JSON (which is what taught agents
      // nothing and burned retries).
      const zodMessage = err instanceof ZodError ? formatZodIssues(req.toolId, err) : null;
      const code = zodMessage ? 'VALIDATION_FAILED' : err instanceof AgentisError ? err.code : 'INTERNAL_TOOL_ERROR';
      const message = zodMessage ?? (err instanceof Error ? err.message : 'unknown error');
      this.#logger.warn('tool.execute_failed', { toolId: req.toolId, code, message, caller: ctx.caller });
      // Propagate the directive remediation + structured details the thrower wrote,
      // so the MCP boundary (routes/mcp.ts) can hand the agent a fix, not a bare code (§F7).
      const remediation = err instanceof AgentisError ? err.remediation : undefined;
      const details = err instanceof AgentisError ? err.details : undefined;
      return {
        id: callId,
        toolId: req.toolId,
        ok: false,
        errorCode: code,
        errorMessage: message,
        ...(remediation ? { remediation } : {}),
        ...(details ? { details } : {}),
        durationMs: Date.now() - startedAt,
      };
    }
  }

  /** Total registered tools — useful for boot-log metrics. */
  size(): number {
    return this.#tools.size;
  }
}

/**
 * Every mutating definition leaves registration with an explicit behavior.
 * Most Agentis tools only touch owned state; the narrow families below can
 * also act on providers, browsers, host code, or already-running executions.
 */
function inferMutationBehavior(toolId: string): NonNullable<AgentisToolDefinition['mutationBehavior']> {
  if (/^agentis\.(?:channel\.(?:reply|send|typing|react)|integration\.call|mcp\.call)$/.test(toolId)) return 'external';
  if (/^agentis\.(?:browser\.|media\.generate|code\.execute|run\.(?:start|cancel|replay|regrade))/.test(toolId)) return 'mixed';
  return 'local';
}

/**
 * Render a handler-side ZodError as one concise, actionable line the agent can
 * act on — "<field path>: <what was expected vs received>" — instead of the raw
 * multi-line JSON. This is what lets a CLI harness self-correct its next call.
 */
function formatZodIssues(toolId: string, err: ZodError): string {
  const parts = err.issues.slice(0, 4).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    if (issue.code === 'invalid_type') {
      return `${path}: expected ${issue.expected}, received ${issue.received}`;
    }
    return `${path}: ${issue.message}`;
  });
  const more = err.issues.length > parts.length ? ` (+${err.issues.length - parts.length} more)` : '';
  return `${toolId}: invalid arguments — ${parts.join('; ')}${more}. Fix the named field(s) and retry.`;
}
