/**
 * ChatToolExecutor — CHAT-AGENT-LOOP.md §2.4.
 *
 * Executes tool calls requested by the LLM during a chat turn.
 * Routes through AgentisToolRegistry, the same platform tool plane exposed
 * over /v1/tools and available to workflow/MCP transports.
 */

import { randomUUID } from 'node:crypto';
import type { AgentisToolDefinition, ApprovalSensitivity, ChatPermissionMode, ChatTurnContext } from '@agentis/core';
import type { Logger } from '../../logger.js';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { AgentMissionService } from '../agentMissions.js';
import { decideToolApproval } from './chatApprovalPolicy.js';
import { canonicalAgentisToolName, reconcileMissionToolResult } from '../missionToolResultReconciler.js';

export { canonicalAgentisToolName } from '../missionToolResultReconciler.js';

export interface ChatToolExecutorDeps {
  registry: AgentisToolRegistry;
  logger?: Logger;
  missions?: AgentMissionService;
}

export class ChatToolExecutor {
  static #deps: ChatToolExecutorDeps | null = null;

  static configure(deps: ChatToolExecutorDeps | null): void {
    this.#deps = deps;
  }

  static definition(name: string): AgentisToolDefinition | undefined {
    return this.#deps?.registry.get(canonicalAgentisToolName(name));
  }

  /**
   * The set of tool ids the registry can actually execute. Used to filter the
   * advertised chat catalog so the model never sees (and wastes a turn calling)
   * a tool that isn't registered. Empty when the registry isn't configured —
   * callers must treat empty as "don't filter" to avoid hiding everything.
   */
  static registeredIds(): Set<string> {
    if (!this.#deps) return new Set();
    return new Set(this.#deps.registry.catalog().tools.map((tool) => tool.id));
  }

  /**
   * Whether a tool call must pause for operator confirmation before running,
   * given the conversation's permission mode.
   *
   * - `auto` — never confirm (the bypass): the operator opted into free action.
   * - `plan` — don't confirm; mutating calls are blocked upstream by the tool
   *   registry (executionMode 'plan'), which returns an error the model adapts to.
   * - `ask` (default) — apply the shared graduated risk policy. Routine work
   *   continues; consequential actions pause at the conversation's threshold.
   */
  static requiresConfirmation(
    name: string,
    mode: ChatPermissionMode = 'ask',
    sensitivity: ApprovalSensitivity = 'balanced',
  ): boolean {
    return decideToolApproval({
      name,
      definition: this.definition(name),
      permissionMode: mode,
      sensitivity,
    }).requiresApproval;
  }

  /**
   * Tools whose invocation is HIGH‑IMPACT (real‑world side effects, code
   * authoring, or outbound messaging). Used by the IPI taint gate: after a turn
   * ingests untrusted content, these require operator confirmation even in
   * `auto` mode, so injected instructions cannot silently trigger them.
   * The `mutating` flag covers most; the explicit set catches dangerous tools
   * that may not be flagged mutating, and the prefixes catch dynamic ids.
   */
  static readonly #HIGH_IMPACT_TOOL_IDS: ReadonlySet<string> = new Set([
    'agentis.component.install',
    'agentis.extension.create',
    'agentis.extension.test',
    'agentis.ability.create',
    'agentis.channel.send',
    'agentis.agents.create',
    'agentis.mcp.add',
    'agentis.build_workflow',
    'agentis.deploy',
  ]);

  static isHighImpact(name: string): boolean {
    name = canonicalAgentisToolName(name);
    if (name.startsWith('workflow.')) return true;
    if (name.startsWith('agentis.command.')) return true;
    if (this.#HIGH_IMPACT_TOOL_IDS.has(name)) return true;
    return Boolean(this.definition(name)?.mutating);
  }

  /** Registry-backed definitions are the source of truth. The authored chat
   * catalog may enrich these with examples, but it must never hide an executable
   * orchestrator capability merely because a second list drifted. */
  static registeredDefinitions(): AgentisToolDefinition[] {
    return this.#deps?.registry.catalog().tools ?? [];
  }

  static isMutating(name: string): boolean {
    name = canonicalAgentisToolName(name);
    if (name.startsWith('workflow.')) return true;
    return Boolean(this.definition(name)?.mutating);
  }

  /**
   * Execute a single tool call by name.
   *
   * Returns `{ data }` on success or `{ error }` on failure.
   * Never throws — the LLM handles errors better with a structured result.
   */
  static async run(
    name: string,
    args: unknown,
    ctx: ChatTurnContext,
    sourceToolCallId?: string,
  ): Promise<{ data?: unknown; error?: string }> {
    if (!this.#deps) {
      return { error: `Tool "${name}" is not available because the Agentis tool registry is not configured.` };
    }

    const input = args && typeof args === 'object' && !Array.isArray(args)
      ? args as Record<string, unknown>
      : {};

    // Dynamic per-workflow tools surface as `workflow.<id>`. Rewrite them to
    // the generic agentis.workflow.run handler with the id pulled from the
    // tool name and the model's args passed straight through as inputs.
    let toolId = canonicalAgentisToolName(name);
    let toolInput = name === 'image.generate' ? { modality: 'image', ...input } : input;
    if (name.startsWith('workflow.')) {
      const workflowId = name.slice('workflow.'.length);
      toolId = 'agentis.workflow.run';
      toolInput = { workflowId, inputs: input };
    }

    const toolCallId = sourceToolCallId?.trim() || randomUUID();
    const outcome = await this.#deps.registry.execute(
      { id: toolCallId, toolId, arguments: toolInput },
      {
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId ?? null,
        agentId: ctx.agentId,
        userId: ctx.userId,
        runId: ctx.runId,
        conversationId: ctx.conversationId,
        missionId: ctx.missionId,
        durableTurnId: ctx.durableTurnId,
        consultationId: ctx.consultationId,
        consultationDepth: ctx.consultationDepth,
        consultationAncestors: ctx.consultationAncestors,
        allowedToolIds: ctx.allowedToolIds,
        channelContinuation: ctx.channelContinuation,
        permissionMode: ctx.permissionMode,
        executionMode: ctx.executionMode,
        approvalSensitivity: ctx.approvalSensitivity,
        ...(ctx.channelOrigin ? { channelOrigin: ctx.channelOrigin } : {}),
        viewport: ctx.viewport ?? null,
        appId: ctx.appId ?? null,
        artifactPolicy: ctx.artifactPolicy ?? null,
        caller: 'chat',
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      },
    );

    if (outcome.ok) {
      if (ctx.missionId && this.#deps.missions) reconcileMissionToolResult(
        this.#deps.missions,
        this.#deps.registry,
        {
          workspaceId: ctx.workspaceId,
          missionId: ctx.missionId,
          toolId,
          toolCallId,
          toolInput,
          output: outcome.output,
        },
      );
      return { data: outcome.output };
    }

    const error = outcome.errorMessage ?? `Tool "${name}" failed.`;
    this.#deps.logger?.warn('chat.tool_call.failed', {
      tool: name,
      code: outcome.errorCode,
      error,
      workspaceId: ctx.workspaceId,
      agentId: ctx.agentId,
    });
    return { error };
  }
}
