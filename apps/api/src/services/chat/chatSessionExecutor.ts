import { randomUUID } from 'node:crypto';
import type { AdapterHealthStatus, AgentAdapter, ChatDelta, ChatInvocationOptions, ChatMessage, ChatToolCall, ChatTurnContext, RuntimeInputAttachment, ToolDefinition, ViewportContext } from '@agentis/core';
import { REALTIME_EVENTS, CONSTANTS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { and, desc, eq, like, or, sql } from 'drizzle-orm';
import { CHAT_TOOL_CATALOG, buildWorkspaceToolCatalog } from './chatToolCatalog.js';
import { composeOperatingManual, getWorkspaceManual } from '../agent/agentOperatingManual.js';
import { ChatToolExecutor } from './chatToolExecutor.js';
import { resolveToolApprovalPolicy } from './chatApprovalPolicy.js';
import { ChatProgressMonitor, hashValue, stopReasonMessage, type RoundObservation } from './chatProgressMonitor.js';
import { scanForInjection, wrapUntrusted } from '../security/promptInjection.js';
import { buildOrchestratorSystemPrompt, responseProfileForChannel } from '../orchestrator/orchestratorPrompt.js';
import { agentIdentityChecksum, chatSessionKeyWithIdentity, loadAgentIdentitySnapshot, renderAgentIdentityBlock } from '../agent/agentIdentity.js';
import type { WorkspaceAwarenessService } from '../workspace/workspaceAwarenessService.js';
import { BrowserSessionManager, resolveSessionOwner, renderOpenSessionsBlock } from '../browser/browserSessionManager.js';
import type { OrchestratorModelRouter } from '../orchestrator/orchestratorModelRouter.js';
import type { ModelRoutingDecision } from '../modelRoutingPolicy.js';
import { recordToolCall, recordTurn } from './chatMetrics.js';
import { toolActivityLabel } from '../../adapters/runtimeProgress.js';
import { withBudget } from '../util/withBudget.js';
import type { Logger } from '../../logger.js';
import type { EventBus } from '../../event-bus.js';
import type { AdapterManager } from '../../adapters/AdapterManager.js';
import type { AgentMemoryService } from '../agent/agentMemory.js';
import type { PersonalBrainService } from '../personalBrain.js';
import type { WorkspaceIntelligenceService } from '../workspace/workspaceIntelligence.js';
import type { KnowledgeBaseService } from '../knowledge/knowledgeBase.js';
import type { BrainDiscourseService } from '../brain/brainDiscourseService.js';
import type { SharedIntelligenceService } from '../sharedIntelligence.js';
import type { EmbeddingProvider } from '../embedding/embeddingProvider.js';
import { embedText } from '../embedding/embeddingProvider.js';
import type { WorkspaceHarnessRuntimeResolver } from '../workspace/workspaceHarnessRuntime.js';
import type { CapabilityIndex } from '../capability/capabilityIndex.js';
import type { CommandModelService } from '../command/commandModel.js';
import type { ConversationTurnLeaseRegistry } from '../conversation/conversationTurnLease.js';
import type { ConversationTurnExperience } from '../conversation/conversationTurnLease.js';
import type { RuntimeProfileService } from '../runtime/runtimeProfileService.js';
import type { TurnToolObservation } from '../conversation/conversationTurnLease.js';
import { guardCompletionClaims, resultProvidesCompletionEvidence } from './completionEvidence.js';
import type { ChatSwarmService } from './chatSwarmService.js';
import { compactPublicProgress } from '../../adapters/publicProgress.js';

export interface ChatSessionExecutorDeps {
  db?: AgentisSqliteDb;
  logger?: Logger;
  bus?: EventBus;
  adapters?: AdapterManager;
  /**
   * Optional native function-calling runtime used to answer chat turns for
   * agents whose own adapter forwards tools via the slow marker protocol
   * (Codex / Claude Code CLIs re-spawn a process per tool round). When set,
   * those turns are token-streamed through this runtime instead — the fast path
   * — while keeping the selected agent's persona, context, and attribution.
   * Unset = every agent uses its own adapter, unchanged.
   */
  orchestratorRuntime?: AgentAdapter;
  /**
   * Per-role model router. When set, the conversation runtime is resolved from
   * it per workspace (honoring per-workspace model overrides) instead of the
   * static `orchestratorRuntime`. Falls back to `orchestratorRuntime`.
   */
  modelRouter?: OrchestratorModelRouter;
  /** Live workspace harness fallback when no endpoint model override exists. */
  workspaceHarnesses?: WorkspaceHarnessRuntimeResolver;
  agentMemory?: AgentMemoryService;
  /**
   * §B3 — the single brain context composer. When set, chat injects the SAME
   * constitutional + relevance + abstention tiers as workflow dispatch
   * (buildDispatchContext), instead of the old newest-8 agent-memory slice. This
   * is what makes "never email before 9am" present on every chat turn.
   */
  sharedIntelligence?: SharedIntelligenceService;
  personalBrain?: PersonalBrainService;
  workspaceIntelligence?: WorkspaceIntelligenceService;
  knowledgeBases?: KnowledgeBaseService;
  brainDiscourse?: BrainDiscourseService;
  awareness?: WorkspaceAwarenessService;
  /** Live browser sessions — surfaced each turn so the agent continues an open session instead of restarting. */
  browserSessions?: BrowserSessionManager;
  /**
   * Reach + comprehension (AUTONOMOUS-ORCHESTRATOR-COMMAND-MODEL). The capability
   * index provides a constant-size CAPABILITY MANIFEST (know-of-everything without
   * holding it); the command model provides the scoped COMMAND BRIEFING (what this
   * agent manages, progress + deltas, App minds) so an orchestrator/manager has
   * progressive comprehension instead of a cold, amnesiac turn.
   */
  capabilityIndex?: CapabilityIndex;
  commandModel?: CommandModelService;
  /** Shared experience recorder for caller-loop/marker/HTTP tools. */
  turnLeases?: ConversationTurnLeaseRegistry;
  /** Records the exact non-secret runtime launch envelope before every turn. */
  runtimeProfiles?: RuntimeProfileService;
  /** Shared audit sink so interactive/model-repair turns are metered too. */
  audit?: { record(entry: {
    workspaceId: string; runId: string; agentId?: string | null; action: string;
    actorType: 'agent'; actorId: string; outputSummary?: string | null;
    costCents?: number | null; tokensIn?: number | null; tokensOut?: number | null;
  }): void };
  /** Agent monthly-spend ledger. Called only for provider-reported monetary cost. */
  budget?: { recordSpend(args: { workspaceId: string; agentId: string; runId?: string | null; amountCents: number }): unknown };
  /** Durable temporary-team runner for interactive chat. */
  chatSwarms?: ChatSwarmService;
}

export interface ChannelTurnContext {
  kind: string;
  from?: string | null;
  chatId?: string | null;
  threadId?: string | null;
  /** "Who is this" recall across channels (ChannelIdentityService). */
  senderSummary?: string | null;
}

export interface ChatTurnOptions {
  tools?: ToolDefinition[];
  viewport?: ViewportContext | null;
  maxTurns?: number;
  maxToolCalls?: number;
  systemAddendum?: string;
  /** Set when the turn originates from a messaging channel (OMNICHANNEL §4). */
  channelContext?: ChannelTurnContext | null;
  /** Preflight-selected quality class. Deep and Mission retain the native
   * runtime's configured reasoning profile instead of forcing a fast preset. */
  qualityMode?: 'quick' | 'deep' | 'mission';
  /** Override the runtime-native session lane (used by non-blocking companion turns). */
  sessionKey?: string;
  /** Force Agentis to retain ownership of tool execution for this turn. */
  toolMode?: 'adapter_native' | 'caller_loop';
  /** Allow adapters to change transport only when the caller-owned tool surface is preserved. */
  transportRecovery?: 'none' | 'capability_preserving';
  /** Skip the redundant CLI `--version` probe when the caller already owns a
   * connected adapter registration and the real invocation is self-diagnosing. */
  skipRuntimePreflight?: boolean;
  /**
   * Drain messages that arrived while this turn was executing. They join the
   * next model round after a tool boundary without cancelling completed work.
   */
  liveInput?: () => ChatMessage[] | Promise<ChatMessage[]>;
  /** Native inbound files (for example WhatsApp images) already materialized by the host. */
  inputAttachments?: RuntimeInputAttachment[];
}

interface PendingChatConfirmation {
  turnId: string;
  call: ChatToolCall;
  context: ChatTurnContext;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  maxTurns: number;
  maxToolCalls: number;
  toolCallCount: number;
  sessionKey?: string | null;
  createdAt: number;
  expiresAt: number;
}

const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

export class ChatSessionExecutor {
  static #deps: ChatSessionExecutorDeps = {};
  static #pendingConfirmations = new Map<string, PendingChatConfirmation>();
  /** Conversations already warned that they're on the slow CLI fast-path (warn once). */
  static #slowPathWarned = new Set<string>();
  /** Short-TTL health probe cache (per agent) so bursty turns don't each spawn a probe. */
  static #healthCache = new Map<string, { status: AdapterHealthStatus; expiresAt: number }>();

  static configure(deps: ChatSessionExecutorDeps): void {
    this.#deps = deps;
    this.#healthCache.clear();
  }

  static setTurnLeaseRegistry(turnLeases: ConversationTurnLeaseRegistry): void {
    this.#deps.turnLeases = turnLeases;
  }

  /** Shared chat-swarm control plane used by the conversation HTTP surface. */
  static chatSwarms(): ChatSwarmService | undefined {
    return this.#deps.chatSwarms;
  }

  /** Issue a revocable capability for adapters whose own MCP loop runs tools. */
  static issueTurnLease(
    workspaceId: string,
    conversationId: string,
    context?: Parameters<ConversationTurnLeaseRegistry['issue']>[2],
  ): string | undefined {
    return this.#deps.turnLeases?.issue(workspaceId, conversationId, context);
  }

  /** Read the evidence ledger before completing a channel-originated turn. */
  static turnExperience(
    workspaceId: string,
    conversationId: string,
    token: string,
  ): ConversationTurnExperience | null {
    try {
      return this.#deps.turnLeases?.experience(workspaceId, conversationId, token) ?? null;
    } catch {
      return null;
    }
  }

  static completeTurnLease(workspaceId: string, conversationId: string, token: string): void {
    this.#deps.turnLeases?.complete(workspaceId, conversationId, token);
  }

  /** Revoke every active capability for a conversation (for example on human takeover). */
  static revokeTurnLeases(workspaceId: string, conversationId: string): boolean {
    return this.#deps.turnLeases?.revoke(workspaceId, conversationId) ?? false;
  }

  /**
   * The configured orchestrator runtime (native function-calling brain), if any.
   * Channel turns whose bound agent has no chat-capable adapter of its own fall
   * back to this so the orchestrator can still answer over the channel.
   */
  static orchestratorAdapter(workspaceId?: string): AgentAdapter | undefined {
    return this.#deps.modelRouter?.resolve('conversation', workspaceId)
      ?? this.#deps.orchestratorRuntime
      ?? this.#deps.workspaceHarnesses?.resolve(workspaceId)?.adapter;
  }

  /**
   * Resolve which adapter actually answers a chat turn.
   *
   * The agent's OWN declared runtime is AUTHORITATIVE. If it is chat-capable, it
   * answers — and if its gateway/harness is unreachable, the real error surfaces
   * (the channel/UI renders the failure) instead of a different brain silently
   * impersonating it. We previously swapped any `marker_protocol`/`mcp_native`
   * harness to the configured orchestrator runtime as a latency optimization,
   * but that masked a down harness: a Hermes agent whose gateway was closed was
   * silently answered by Codex and attributed as Hermes. That substitution is
   * removed — a runtime you assigned must be the runtime that answers.
   *
   * The orchestrator runtime is used ONLY as a genuine fallback when the agent
   * has no chat-capable adapter of its own (otherwise the turn could not be
   * answered at all). That case is a DISCLOSED substitution: logged distinctly,
   * and the caller flags it (`fastPath`) so the operator/console can show that a
   * different runtime answered. It is never used to paper over a down harness.
   */
  static #resolveChatAdapter(adapter: AgentAdapter, workspaceId?: string, task?: string | null): AgentAdapter {
    // Agent runtime is authoritative when it can chat — never swap it out.
    const capabilities = adapter.capabilities?.();
    if (adapter.chat && capabilities?.interactiveChat !== false) return adapter;

    // Agent has no interactive chat of its own: fall back to the orchestrator so
    // the turn can still be answered, and disclose the substitution.
    const runtime = task
      ? this.#deps.modelRouter?.resolveRouted({ role: 'conversation', workspaceId, task, purpose: 'conversation' })
        ?? this.#deps.orchestratorRuntime
        ?? this.#deps.workspaceHarnesses?.resolve(workspaceId)?.adapter
      : this.orchestratorAdapter(workspaceId);
    if (runtime && runtime !== adapter && runtime.chat) {
      this.#deps.logger?.info?.('chat.fallback.substituted', {
        from: adapter.adapterType,
        to: runtime.adapterType,
        reason: 'agent adapter exposes no interactive chat; orchestrator runtime answering as a disclosed fallback',
      });
      return runtime;
    }
    return adapter;
  }

  /** A disclosed retry target when the selected CLI runtime is definitively down. */
  static #healthyFallbackAdapter(exclude: AgentAdapter, workspaceId?: string, task?: string | null): AgentAdapter | undefined {
    // Runtime bindings are authoritative. In particular, never send an
    // Antigravity/Gemini model id to the workspace Codex fallback: that produces
    // a misleading Codex-account error and hides the real Antigravity failure.
    if (exclude.adapterType === 'antigravity') return undefined;
    const fallback = task
      ? this.#deps.modelRouter?.resolveRouted({ role: 'conversation', workspaceId, task, purpose: 'runtime_recovery' })
        ?? this.#deps.orchestratorRuntime
        ?? this.#deps.workspaceHarnesses?.resolve(workspaceId)?.adapter
      : this.orchestratorAdapter(workspaceId);
    if (!fallback || fallback === exclude || !fallback.chat || fallback.capabilities?.().interactiveChat === false) return undefined;
    return fallback;
  }

  /**
   * Bounded health probe used as a chat preflight. Races the adapter's own
   * `healthCheck()` against a short deadline so a hung probe can't itself freeze
   * the turn, and caches the result for a few seconds so back-to-back turns don't
   * each spawn a process. Never throws — a thrown probe is reported as unhealthy.
   */
  static async #preflightHealth(adapter: AgentAdapter, agentId?: string): Promise<AdapterHealthStatus | null> {
    const key = agentId ?? adapter.adapterType ?? 'unknown';
    const cached = this.#healthCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.status;
    const timeoutMs = preflightHealthTimeoutMs();
    let timer: NodeJS.Timeout | undefined;
    let status: AdapterHealthStatus;
    try {
      status = await Promise.race([
        adapter.healthCheck(),
        new Promise<AdapterHealthStatus>((resolve) => {
          timer = setTimeout(() => resolve({
            isHealthy: false,
            // Ambiguous, not definitive: the adapter's own probe didn't return in
            // time. Flagged so the gate treats it as "unknown" and proceeds.
            timedOut: true,
            error: `health check timed out after ${Math.round(timeoutMs / 1000)}s`,
            checkedAt: new Date().toISOString(),
          }), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      status = {
        isHealthy: false,
        error: err instanceof Error ? err.message : String(err),
        checkedAt: new Date().toISOString(),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
    // Healthy results are cached longer than failures: a recovered runtime should
    // be retried promptly, while a healthy one need not be re-probed every turn.
    const ttlMs = status.isHealthy ? preflightHealthyTtlMs() : preflightUnhealthyTtlMs();
    this.#healthCache.set(key, { status, expiresAt: Date.now() + ttlMs });
    return status;
  }

  /**
   * Resolve human-meaningful names behind the viewport's opaque ids so the agent
   * knows WHAT it is looking at — the App's name and its workflows when an App is
   * open, or a workflow's title (and owning App) when a workflow is open. Without
   * this the prompt only carried `resourceKind=app resourceId=<uuid>`, so "fix
   * this workflow" had nothing to resolve against and the agent burned the turn
   * (or gave up) trying to figure out what the operator meant. The resolved facts
   * ride on `metadata` (no type change); a single-workflow App also fills
   * `metadata.workflowId` so it counts as "the" active workflow. Best-effort:
   * any failure returns the viewport untouched.
   */
  static #resolveViewport(viewport: ViewportContext | null, workspaceId?: string): ViewportContext | null {
    const db = this.#deps.db;
    if (!viewport || !db || !workspaceId || !viewport.resourceId) return viewport;
    try {
      if (viewport.resourceKind === 'app') {
        const app = db
          .select({ name: schema.apps.name })
          .from(schema.apps)
          .where(and(eq(schema.apps.id, viewport.resourceId), eq(schema.apps.workspaceId, workspaceId)))
          .get();
        const workflows = db
          .select({ id: schema.workflows.id, title: schema.workflows.title })
          .from(schema.workflows)
          .where(and(eq(schema.workflows.appId, viewport.resourceId), eq(schema.workflows.workspaceId, workspaceId)))
          .all();
        const surfaces = db
          .select({
            id: schema.appSurfaces.id,
            name: schema.appSurfaces.name,
            kind: schema.appSurfaces.kind,
            revision: schema.appSurfaces.revision,
            view: schema.appSurfaces.viewJson,
          })
          .from(schema.appSurfaces)
          .where(and(eq(schema.appSurfaces.appId, viewport.resourceId), eq(schema.appSurfaces.workspaceId, workspaceId)))
          .all();
        const requestedPage = viewport.appView?.page;
        const currentSurface = requestedPage ? surfaces.find((surface) => surface.name === requestedPage) : undefined;
        if (!app && workflows.length === 0) return viewport;
        return {
          ...viewport,
          appView: {
            appId: viewport.resourceId,
            ...(viewport.appView ?? {}),
            ...(currentSurface ? { page: currentSurface.name } : {}),
            targetLocked: true,
          },
          metadata: {
            ...viewport.metadata,
            appId: viewport.resourceId,
            appName: app?.name ?? null,
            workflows,
            surfaces: surfaces.map(({ view: _view, ...surface }) => surface),
            currentSurface: currentSurface ?? null,
            // A one-workflow App makes that workflow unambiguously "this workflow".
            workflowId: workflows.length === 1 ? workflows[0]!.id : viewport.metadata?.workflowId,
          },
        };
      }
      if (viewport.resourceKind === 'workflow') {
        const wf = db
          .select({ title: schema.workflows.title, appId: schema.workflows.appId })
          .from(schema.workflows)
          .where(and(eq(schema.workflows.id, viewport.resourceId), eq(schema.workflows.workspaceId, workspaceId)))
          .get();
        if (!wf) return viewport;
        const appName = wf.appId
          ? db.select({ name: schema.apps.name }).from(schema.apps).where(eq(schema.apps.id, wf.appId)).get()?.name ?? null
          : null;
        return {
          ...viewport,
          metadata: { ...viewport.metadata, workflowId: viewport.resourceId, workflowTitle: wf.title, appId: wf.appId ?? null, appName },
        };
      }
    } catch (err) {
      this.#deps.logger?.warn?.('chat.viewport.resolve_failed', { err: (err as Error).message });
    }
    return viewport;
  }

  /**
   * Build the tool catalog for a turn. The always-on platform verbs (run/status/
   * approve/…) come from the static catalog; on top we surface the workspace's
   * workflows as discrete `workflow.<id>` tools so the orchestrator can call them
   * with typed parameters. The dynamic set is capped small (WORKFLOW_TOOL_CAP)
   * and ranked by relevance — the open App's workflows and the viewport's active
   * workflow first, then most-recently-edited — because dumping dozens of tools
   * inflates the prompt and slows tool selection on every turn. Falls back to the
   * static catalog if the db is unavailable or the lookup fails.
   */
  static #buildCatalog(ctx: ChatTurnContext): ToolDefinition[] {
    const db = this.#deps.db;
    if (!db || !ctx.workspaceId) return this.#filterToRegistered(CHAT_TOOL_CATALOG);
    try {
      const rows = db
        .select({
          id: schema.workflows.id,
          title: schema.workflows.title,
          description: schema.workflows.description,
          graph: schema.workflows.graph,
          updatedAt: schema.workflows.updatedAt,
        })
        .from(schema.workflows)
        .where(eq(schema.workflows.workspaceId, ctx.workspaceId))
        .all();
      if (rows.length === 0) return this.#filterToRegistered(CHAT_TOOL_CATALOG);
      // The workflow(s) the operator is currently looking at are the ones they're
      // most likely to mean — always include them, then fill the rest by recency.
      // On an App surface that's the App's whole workflow set; on a workflow
      // surface it's the single active workflow.
      const activeWorkflowId = workflowIdFromViewport(ctx.viewport);
      const appWorkflowIds = new Set(
        (ctx.viewport?.metadata?.workflows as Array<{ id?: string }> | undefined)?.map((w) => w.id).filter(Boolean) as string[]
          ?? [],
      );
      const priority = (id: string): boolean => id === activeWorkflowId || appWorkflowIds.has(id);
      const ranked = rows.sort((a, b) => {
        const ap = priority(a.id);
        const bp = priority(b.id);
        if (ap && !bp) return -1;
        if (bp && !ap) return 1;
        return a.updatedAt > b.updatedAt ? -1 : 1;
      });
      return this.#filterToRegistered(buildWorkspaceToolCatalog(
        ranked.slice(0, WORKFLOW_TOOL_CAP).map((r) => ({
          id: r.id,
          title: r.title,
          description: r.description,
          inputContract: (r.graph as { inputContract?: { fields?: Array<{ key: string; type?: string; required?: boolean; description?: string }> } } | null)?.inputContract ?? null,
        })),
      ));
    } catch (err) {
      this.#deps.logger?.warn('chat.catalog.dynamic_failed', { err: (err as Error).message });
      return this.#filterToRegistered(CHAT_TOOL_CATALOG);
    }
  }

  /**
   * Drop any advertised tool the registry can't actually execute, so the model
   * never wastes a turn calling a phantom tool (e.g. `agentis.knowledge.search`
   * advertised in the static catalog but not registered). Dynamic `workflow.<id>`
   * tools are always kept (the executor rewrites them to agentis.workflow.run).
   * If the registry isn't configured yet, returns the catalog unfiltered rather
   * than hiding everything.
   */
  static #filterToRegistered(tools: ToolDefinition[]): ToolDefinition[] {
    const registered = ChatToolExecutor.registeredIds();
    if (registered.size === 0) return tools;
    const canonical = new Map(ChatToolExecutor.registeredDefinitions().map((definition) => [definition.id, definition]));
    const kept = tools
      .filter((tool) => tool.name === 'agentis.team.spawn' || tool.name.startsWith('workflow.') || registered.has(tool.name))
      .map((tool) => {
        const definition = canonical.get(tool.name);
        // Registered definitions are the transport-independent source of truth.
        // This prevents chat/channel runtimes from seeing an older, reduced
        // schema while MCP and workflows see the complete tool.
        return definition
          ? {
              name: definition.id,
              description: definition.description,
              parameters: definition.inputSchema as ToolDefinition['parameters'],
            }
          : tool;
      });
    const present = new Set(kept.map((tool) => tool.name));
    for (const definition of ChatToolExecutor.registeredDefinitions()) {
      if (present.has(definition.id)) continue;
      kept.push({
        name: definition.id,
        description: definition.description,
        parameters: definition.inputSchema as ToolDefinition['parameters'],
      });
      present.add(definition.id);
    }
    const dropped = tools.length - tools.filter((tool) => tool.name === 'agentis.team.spawn' || tool.name.startsWith('workflow.') || registered.has(tool.name)).length;
    if (dropped > 0) {
      this.#deps.logger?.debug?.('chat.catalog.filtered_unregistered', { dropped });
    }
    return kept;
  }

  static #chatRoutingDecision(
    task: string,
    workspaceId: string,
    lightweightConversation: boolean,
    _tools: ToolDefinition[],
  ): ModelRoutingDecision | null {
    if (!this.#deps.modelRouter) return null;
    const decision = this.#deps.modelRouter.route({
      role: 'conversation',
      workspaceId,
      task,
      purpose: lightweightConversation ? 'simple chat text' : 'conversation',
      requiredAffordances: [],
    });
    this.#deps.logger?.info?.('chat.model_routed', {
      workspaceId,
      taskClass: decision.taskClass,
      selectedRuntime: decision.selectedRuntime,
      selectedModel: decision.selectedModel,
      modelTier: decision.modelTier,
      explicitPin: decision.explicitPin,
      reason: decision.reason,
      alternatives: decision.alternatives.slice(0, 4),
    });
    return decision;
  }

  static async *turn(
    adapter: AgentAdapter,
    history: ChatMessage[],
    userMessage: string,
    ctx: ChatTurnContext,
    options: ChatTurnOptions = {},
  ): AsyncIterable<ChatDelta> {
    const startedAt = Date.now();
    const maxTurns = Math.max(1, Math.min(options.maxTurns ?? ctx.maxTurns ?? 5, 8));
    // High count backstop — the real governor is ChatProgressMonitor, not a cap.
    const maxToolCalls = Math.max(1, options.maxToolCalls ?? defaultMaxToolCalls());
    const viewport = this.#resolveViewport(options.viewport ?? ctx.viewport ?? null, ctx.workspaceId);
    const expandedUserMessage = expandUserMessage(userMessage);
    // Social turns cannot need platform actions. Leaving the catalog empty also
    // lets CLI harnesses skip MCP startup, removing its process/handshake cost.
    const lightweightConversation = isLightweightConversation(userMessage);
    const availableTools = options.tools ?? (lightweightConversation ? [] : this.#buildCatalog({ ...ctx, viewport }));
    const tools = ctx.allowedToolIds
      ? availableTools.filter((tool) => ctx.allowedToolIds!.includes(tool.name))
      : availableTools;
    let effectiveUserMessage = expandedUserMessage;
    let brainSystemInjection: string | null = null;

    const agentAdapter = adapter;
    this.#chatRoutingDecision(effectiveUserMessage, ctx.workspaceId, lightweightConversation, tools);
    adapter = this.#resolveChatAdapter(adapter, ctx.workspaceId, effectiveUserMessage);
    if (ctx.agentId && this.#deps.runtimeProfiles) {
      await this.#deps.runtimeProfiles.captureExecution(ctx.workspaceId, ctx.agentId, {
        runId: ctx.runId,
        conversationId: ctx.conversationId,
      }).catch((error) => this.#deps.logger?.warn?.('chat.runtime_envelope.failed', {
        workspaceId: ctx.workspaceId,
        agentId: ctx.agentId,
        error: (error as Error).message,
      }));
    }
    // Developer observability (not a user prompt — the harness is the intended
    // default brain). A marker-protocol CLI harness (Codex / Claude Code) re-spawns
    // per tool round, so multi-step tasks pay a per-round cold-start. Note it once
    // per conversation; pointing a Conversation model at a streaming endpoint in
    // Settings → Runtimes is an OPTIONAL speed-up, never a required second setup.
    const agentForwarding = agentAdapter.capabilities?.().toolForwarding;
    if (adapter === agentAdapter && (agentForwarding === 'marker_protocol' || agentForwarding === 'mcp_native')) {
      const key = ctx.conversationId ?? ctx.agentId;
      if (!ChatSessionExecutor.#slowPathWarned.has(key)) {
        ChatSessionExecutor.#slowPathWarned.add(key);
        this.#deps.logger?.info?.(`chat.harness.${agentForwarding}`, {
          workspaceId: ctx.workspaceId,
          agentId: ctx.agentId,
          adapterType: agentAdapter.adapterType,
          note: agentForwarding === 'mcp_native'
            ? 'Answering on the agent\'s harness with Agentis tools mounted natively over MCP (single streaming invocation).'
            : 'Answering on the agent\'s CLI harness (re-spawns per tool round). Optional: set a streaming Conversation model in Settings → Runtimes for a faster path.',
        });
      }
    } else if (adapter !== agentAdapter) {
      // Disclosed substitution: the bound agent has no chat runtime of its own,
      // so a fallback runtime is answering. Surface it so the operator is never
      // led to believe the agent's declared runtime replied.
      yield this.#activity(
        ctx,
        'runtime',
        'Answering on a fallback runtime',
        `${agentAdapter.adapterType ?? 'This agent'} has no interactive chat runtime, so ${adapter.adapterType ?? 'the orchestrator'} is answering on its behalf.`,
        'fallback-runtime',
      );
    }

    const capabilities = adapter.capabilities?.();
    if (!adapter.chat || capabilities?.interactiveChat === false) {
      const reason = capabilities?.limitations?.[0];
      yield { type: 'text', delta: reason ?? 'This agent adapter is connected for workflow tasks, but it does not expose interactive chat yet.' };
      yield { type: 'done', finishReason: 'stop' };
      return;
    }

    // Fast preflight for the agent's OWN CLI harness. These runtimes cold-start a
    // process and can otherwise sit in a 90–120s startup/first-event budget before
    // surfacing a failure — what the operator sees as a frozen "thinking…". A
    // bounded (<~6s, cached) health probe lets a down runtime fail IMMEDIATELY
    // with an attributed error instead of hanging. Only the agent's own harness is
    // probed; the orchestrator/native fallback streams over HTTP and fails fast on
    // its own, so it is left untouched.
    if (
      adapter === agentAdapter
      && (agentForwarding === 'marker_protocol' || agentForwarding === 'mcp_native')
      && !options.skipRuntimePreflight
    ) {
      const health = await this.#preflightHealth(adapter, ctx.agentId);
      if (health && !health.isHealthy) {
        const label = adapter.adapterType ?? 'agent';
        const reason = health.error?.trim() || 'the runtime did not respond to a health check';
        // A TIMEOUT is ambiguous, not a verdict: a Python harness (Hermes) cold-
        // starts in ~4s and can blow a tight probe budget under load while still
        // being perfectly able to serve the turn. Hard-aborting on that nukes a
        // working agent. The original reason for blocking — a 90–120s ACP "frozen
        // thinking" hang — is already bounded by the first-event timeout + breaker
        // and the CLI path's own ceilings, so on an ambiguous timeout we PROCEED
        // and let the real chat path succeed (or fail fast on its own). We still
        // hard-fail on a DEFINITIVE failure (spawn error, non-zero exit).
        if (health.timedOut) {
          this.#deps.logger?.warn?.('chat.preflight.timeout_proceeding', {
            agentId: ctx.agentId,
            adapterType: adapter.adapterType,
            error: reason,
          });
        } else {
          this.#deps.logger?.warn?.('chat.preflight.unhealthy', {
            agentId: ctx.agentId,
            adapterType: adapter.adapterType,
            error: reason,
          });
          const fallback = this.#healthyFallbackAdapter(adapter, ctx.workspaceId, effectiveUserMessage);
          if (!fallback) {
            yield {
              type: 'tool_result',
              id: 'adapter',
              name: 'adapter.chat',
              result: null,
              error: `The ${label} runtime is unavailable: ${reason}`,
            };
            yield { type: 'done', finishReason: 'error' };
            return;
          }
          adapter = fallback;
          yield this.#activity(
            ctx,
            'runtime',
            'Retrying on a healthy runtime',
            `${label} is unavailable; this turn is being retried once on ${fallback.adapterType ?? 'the workspace fallback'}.`,
            'runtime-recovery',
          );
        }
      }
    }

    yield this.#activity(ctx, 'context', 'Loading workspace context', 'Collecting viewport, memory, tools, and agent instructions.', 'context');
    const promptCtx = this.#loadPromptContext(ctx);
    const logger = this.#deps.logger;

    // §B3 — chat memory is now composed by the SAME injector as workflow
    // dispatch (buildDispatchContext): constitutional rules + relevance + honest
    // abstention, refreshed every turn. Resolved concurrently below (it is async
    // + does retrieval). The legacy newest-8 contextSection remains only as a
    // fallback when SharedIntelligence is not wired (tests / minimal builds).
    let agentMemory: string | null = null;

    // The three remote/expensive retrievers — brain discourse, personal brain,
    // and workspace intelligence (which fires a knowledge-base embedding search)
    // — run CONCURRENTLY and each time-boxed via withBudget. A slow or failed
    // retriever degrades to "omitted" instead of blocking the turn, so per-turn
    // context cost is max(builders) capped at the budget, not the serial sum.
    // Knowledge retrieval is additionally gated on the message carrying a real
    // query signal, so trivial chatter never pays for an embedding round-trip.
    const brainDiscourse = this.#deps.brainDiscourse;
    const personalBrainDep = this.#deps.personalBrain;
    const workspaceIntelligence = this.#deps.workspaceIntelligence;
    const knowledgeBases = this.#deps.knowledgeBases;
    const wantKnowledge = hasRetrievalSignal(userMessage);

    const sharedIntelligence = this.#deps.sharedIntelligence;
    const [discourse, personalBrain, workspaceContext, brainContext] = await Promise.all([
      !lightweightConversation && brainDiscourse
        ? withBudget(async () => {
            try {
              const d = await brainDiscourse.buildTurn({
                workspaceId: ctx.workspaceId,
                scopeId: ctx.agentId,
                sessionId: ctx.conversationId,
                userId: ctx.userId,
                agentId: ctx.agentId,
                turnCount: countUserTurns(history) + 1,
                userMessage: expandedUserMessage,
                recentMessages: history.map(historyMessageText).filter(Boolean).slice(-8),
              });
              return { injectedMessage: d.injectedMessage, systemInjection: d.systemInjection || null };
            } catch (err) {
              logger?.warn?.('chat.brain_discourse.failed', { workspaceId: ctx.workspaceId, conversationId: ctx.conversationId, err: (err as Error).message });
              return null;
            }
          }, CONTEXT_BUILDER_BUDGET_MS, null, () => logger?.warn?.('chat.brain_discourse.budget_exceeded', { workspaceId: ctx.workspaceId }))
        : Promise.resolve(null),

      !lightweightConversation && ctx.agentId && personalBrainDep
        ? withBudget(async () => {
            try {
              return await personalBrainDep.contextForAgent(ctx.userId, ctx.agentId, userMessage);
            } catch (err) {
              logger?.warn?.('chat.personal_brain.failed', { agentId: ctx.agentId, err: (err as Error).message });
              return null;
            }
          }, CONTEXT_BUILDER_BUDGET_MS, null, () => logger?.warn?.('chat.personal_brain.budget_exceeded', { agentId: ctx.agentId }))
        : Promise.resolve<string | null>(null),

      !lightweightConversation && workspaceIntelligence
        ? withBudget(async () => {
            try {
              return await workspaceIntelligence.buildContextBlock(ctx.workspaceId, {
                knowledgeQuery: wantKnowledge ? (userMessage || undefined) : undefined,
                knowledgeBases,
              });
            } catch (err) {
              logger?.warn?.('chat.workspace_context.failed', { workspaceId: ctx.workspaceId, err: (err as Error).message });
              return null;
            }
          }, CONTEXT_BUILDER_BUDGET_MS, null, () => logger?.warn?.('chat.workspace_context.budget_exceeded', { workspaceId: ctx.workspaceId }))
        : Promise.resolve<string | null>(null),

      // §B3 — the unified brain injector (same path as workflow dispatch).
      !lightweightConversation && ctx.agentId && sharedIntelligence
        ? withBudget(async () => {
            try {
              const brain = await sharedIntelligence.buildDispatchContext({
                workspaceId: ctx.workspaceId,
                scopeId: ctx.agentId,
                // §G11 — a resident App turn recalls the UNION of [appId, agentId]
                // (the App's relationship brain + the agent's own memory), not the
                // workspace at large. Falls back to the agent's scope when unset.
                ...(ctx.recallScopeIds && ctx.recallScopeIds.length > 0 ? { scopeIds: ctx.recallScopeIds } : {}),
                agentId: ctx.agentId,
                taskDescription: userMessage,
                limit: 8,
                surface: 'chat', // §C5 — chat leans working + semantic scales.
              });
              // Carry the atom count so the turn can SHOW the recall happening
              // ("Recalled N memories") — an invisible mind reads as a dead one.
              // `relevant` excludes Tier-0 backfill (a weak-threshold quota
              // filler) — the count an operator sees should mean "N memories
              // that actually cleared relevance", not "N padded up to the
              // limit to look full".
              return { block: brain.block || null, atomIds: brain.atomIds, atoms: brain.atomIds.length, relevant: brain.relevantCount };
            } catch (err) {
              logger?.warn?.('chat.brain_context.failed', { agentId: ctx.agentId, err: (err as Error).message });
              return null;
            }
          }, CONTEXT_BUILDER_BUDGET_MS, null, () => logger?.warn?.('chat.brain_context.budget_exceeded', { agentId: ctx.agentId }))
        : Promise.resolve<{ block: string | null; atomIds: string[]; atoms: number; relevant: number } | null>(null),
    ]);

    // §B3 — prefer the unified brain context; fall back to the legacy newest-8
    // slice only when SharedIntelligence is not wired.
    // BRAIN-BLUEPRINT-10X §visibility — surface the recall like a desktop harness
    // does ("Recalled N memories"): the operator finally SEES the mind engage.
    if (brainContext && brainContext.relevant > 0) {
      yield this.#activity(
        ctx,
        'context',
        `Recalled ${brainContext.relevant} ${brainContext.relevant === 1 ? 'memory' : 'memories'}`,
        'Relevant Brain memories were injected into this turn\'s context.',
        'memory-recall',
      );
    } else if (brainContext && brainContext.atoms > 0) {
      // Nothing cleared the relevance floor — what's injected is Tier-0
      // background filler, not a genuine match. Say so honestly rather than
      // reporting a count that implies a stronger signal than there is.
      yield this.#activity(
        ctx,
        'context',
        `Loaded ${brainContext.atoms} background ${brainContext.atoms === 1 ? 'memory' : 'memories'}`,
        'No memory cleared the relevance bar for this task; background context was included as a fallback.',
        'memory-recall',
      );
    }
    if (brainContext?.block) {
      agentMemory = brainContext.block;
      if (ctx.turnLease && this.#deps.turnLeases && brainContext.atoms > 0) {
        // The lease stores exact atom ids separately from prompt prose so a later
        // verified outcome can strengthen the memories that were actually
        // available to this runtime, independent of the adapter implementation.
        try {
          this.#deps.turnLeases.recordRecalledAtoms(ctx.workspaceId, ctx.conversationId, ctx.turnLease, brainContext.atomIds);
        } catch { /* best-effort outcome attribution */ }
      }
    } else if (!lightweightConversation && ctx.agentId && this.#deps.agentMemory) {
      try {
        agentMemory = this.#deps.agentMemory.contextSection(ctx.agentId, ctx.workspaceId);
      } catch (err) {
        logger?.warn?.('chat.agent_memory.failed', { agentId: ctx.agentId, err: (err as Error).message });
      }
    }

    if (discourse) {
      effectiveUserMessage = discourse.injectedMessage;
      brainSystemInjection = discourse.systemInjection;
    }

    let agentInstructions: string | null = null;
    let agentIdentity: string | null = null;
    let identityChecksum: string | null = null;
    const db = this.#deps.db;
    if (db && ctx.agentId) {
      try {
        const identity = loadAgentIdentitySnapshot(db, ctx.workspaceId, ctx.agentId);
        agentInstructions = identity?.instructions ?? null;
        agentIdentity = renderAgentIdentityBlock(identity);
        identityChecksum = agentIdentityChecksum(identity);
      } catch (err) {
        this.#deps.logger?.warn?.('chat.agent_identity.failed', { agentId: ctx.agentId, err: (err as Error).message });
      }
    }

    // Channel turns lead with workspace situational awareness instead of a
    // viewport, and shape their output for the surface (OMNICHANNEL §4.1/§4.3).
    const channelContext = options.channelContext ?? null;
    let situationalModel: string | null = null;
    if (channelContext && this.#deps.awareness) {
      try {
        situationalModel = this.#deps.awareness.buildContextBlock(ctx.workspaceId) || null;
      } catch (err) {
        this.#deps.logger?.warn?.('chat.awareness.failed', { workspaceId: ctx.workspaceId, err: (err as Error).message });
      }
    }
    // Live browser-session awareness (applies to web AND channel turns): if the
    // agent has an open session, tell it to CONTINUE that session and read the
    // current page — the fix for restarting a task from scratch mid-automation.
    if (this.#deps.browserSessions) {
      try {
        const owner = resolveSessionOwner({ conversationId: ctx.conversationId, agentId: ctx.agentId });
        const open = owner ? this.#deps.browserSessions.listForOwner(ctx.workspaceId, owner) : [];
        const block = renderOpenSessionsBlock(open);
        if (block) situationalModel = [situationalModel, block].filter(Boolean).join('\n\n');
      } catch (err) {
        this.#deps.logger?.warn?.('chat.browser_awareness.failed', { workspaceId: ctx.workspaceId, err: (err as Error).message });
      }
    }
    const responseProfile = channelContext ? responseProfileForChannel(channelContext.kind) : null;

    // Constant prompt size: clamp every injected block that GROWS with accumulated
    // workspace state (memory, brain notes, knowledge, situational model) to a
    // fixed char budget. This keeps per-turn token cost flat over the lifetime of
    // a workspace — retrievers are mostly top-K already, but this is the single
    // guarantee that they can never bloat the prompt. (Agent instructions are
    // user-authored and fixed-size, so they're left intact.)
    const promptMeta = promptCtx as {
      workspaceName?: string | null;
      agentName?: string | null;
      agentRole?: string | null;
      agentDomain?: string | null;
    };
    const channelScopedWorker = Boolean(ctx.channelOrigin)
      && !/(?:orchestrat|manager)/i.test(promptMeta.agentRole ?? '');
    const compactConversationPrompt = lightweightConversation || channelScopedWorker;
    const baseSystemPrompt = compactConversationPrompt
      ? buildLightweightConversationSystemPrompt({
        context: { ...ctx, viewport },
        workspaceName: promptMeta.workspaceName,
        agentName: promptMeta.agentName,
        agentRole: promptMeta.agentRole,
        agentDomain: promptMeta.agentDomain,
        agentInstructions,
        agentIdentity,
        channelContext,
        responseProfile,
      })
      : buildOrchestratorSystemPrompt({
        context: { ...ctx, viewport },
        viewport,
        // mcp_native harnesses discover the live tool surface over MCP; injecting
        // the full static platform manual just dilutes the agent's own identity.
        toolSurface: capabilities?.toolForwarding === 'mcp_native' ? 'mcp_native' : 'injected',
        ...promptCtx,
        ...this.#extractInlineContext(userMessage, ctx),
        agentInstructions,
        agentIdentity,
        agentMemory: clampBlock(agentMemory, CONTEXT_BUDGET.agentMemory),
        personalBrain: clampBlock(personalBrain, CONTEXT_BUDGET.personalBrain),
        workspaceContext: clampBlock(workspaceContext, CONTEXT_BUDGET.workspaceContext),
        channelContext,
        situationalModel: clampBlock(situationalModel, CONTEXT_BUDGET.situationalModel),
        responseProfile,
        routingIntelligence: this.#deps.modelRouter?.describeRouting(ctx.workspaceId, effectiveUserMessage) ?? null,
      });
    // W1/W2 — the operating manual reaches CHAT agents too (not only task agents),
    // so an agent has the same agentic briefing everywhere it runs.
    let operatingManualBlock: string | null = null;
    try {
      const db = this.#deps.db;
      if (db && ctx.workspaceId && !channelScopedWorker) {
        const role = ctx.agentId
          ? (db.select({ role: schema.agents.role }).from(schema.agents).where(eq(schema.agents.id, ctx.agentId)).get()?.role ?? null)
          : null;
        operatingManualBlock = composeOperatingManual({ role, workspaceManual: getWorkspaceManual(db, ctx.workspaceId) });
      }
    } catch { /* best-effort — never block a chat turn on the manual */ }
    // COMMAND-MODEL — the resident comprehension + reach layer. A manager/orchestrator
    // gets its SCOPED Command Briefing (what it manages + progress/deltas since last
    // look + App minds + the use-your-mind doctrine); any other substantive turn gets
    // the constant-size CAPABILITY MANIFEST so the agent knows what EXISTS and can
    // reach it via capability.search/invoke. The briefing subsumes the manifest, so
    // both are never injected at once. Best-effort — never blocks a turn.
    let commandBriefingBlock: string | null = null;
    let capabilityManifestBlock: string | null = null;
    if (!lightweightConversation && !channelScopedWorker) {
      try {
        if (this.#deps.commandModel && ctx.agentId) {
          commandBriefingBlock = this.#deps.commandModel.briefingBlock(ctx.workspaceId, ctx.agentId) || null;
        }
        if (!commandBriefingBlock && this.#deps.capabilityIndex) {
          capabilityManifestBlock = this.#deps.capabilityIndex.manifestBlock(ctx.workspaceId) || null;
        }
      } catch (err) {
        this.#deps.logger?.warn?.('chat.command_model.failed', { workspaceId: ctx.workspaceId, agentId: ctx.agentId, err: (err as Error).message });
      }
    }
    // The live mounted-connections surface (MCP servers + credentialed integrations).
    // Injected ALWAYS on a substantive turn — including for managers, who get the
    // Command Briefing instead of the manifest and would otherwise never be told what
    // is actually connected. This is the block that stops an agent assuming it has no
    // integrations/MCP when the workspace has them mounted. Best-effort.
    let mountedConnectionsBlock: string | null = null;
    if (!lightweightConversation && !channelScopedWorker && this.#deps.capabilityIndex) {
      try {
        mountedConnectionsBlock = (await this.#deps.capabilityIndex.mountedConnectionsBlock(ctx.workspaceId)) || null;
      } catch (err) {
        this.#deps.logger?.warn?.('chat.mounted_connections.failed', { workspaceId: ctx.workspaceId, err: (err as Error).message });
      }
    }
    const systemAddendum = [clampBlock(operatingManualBlock, 4000), clampBlock(commandBriefingBlock, 2600), clampBlock(capabilityManifestBlock, 900), clampBlock(mountedConnectionsBlock, 1200), clampBlock(brainSystemInjection, CONTEXT_BUDGET.brainInjection), options.systemAddendum]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    const systemPrompt = systemAddendum.length > 0
      ? `${baseSystemPrompt}\n\n${systemAddendum.join('\n\n')}`
      : baseSystemPrompt;
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...trimHistory(history),
      { role: 'user', content: effectiveUserMessage },
    ];

    yield this.#activity(ctx, 'runtime', 'Invoking agent runtime', 'Streaming the turn through the selected chat harness.', 'runtime');
    // Context is fully assembled here; everything after is model + tools. This is
    // the boundary the CLB trace measures as `contextMs` (Phase A instrumentation).
    yield* this.#executeLoop(adapter, messages, { ...ctx, viewport, allowedToolIds: ctx.allowedToolIds ?? tools.map((tool) => tool.name) }, {
      tools,
      maxTurns,
      maxToolCalls,
      startedAt,
      toolCallCount: 0,
      contextMs: Date.now() - startedAt,
      fastPath: adapter !== agentAdapter,
      adapterType: adapter.adapterType ?? 'unknown',
      lightweightConversation,
      qualityMode: options.qualityMode ?? ctx.qualityMode ?? (lightweightConversation ? 'quick' : 'deep'),
      sessionKey: options.sessionKey ?? cliSessionKey(ctx.conversationId, capabilities?.toolForwarding, identityChecksum),
      liveInput: options.liveInput,
      inputAttachments: options.inputAttachments,
      toolMode: options.toolMode,
      transportRecovery: options.transportRecovery,
      // The agent's own harness should answer on the model the operator picked in
      // the UI — not whatever default the harness happens to boot with.
      preferredModel: adapter === agentAdapter && 'agentRuntimeModel' in promptCtx ? promptCtx.agentRuntimeModel : null,
    });
  }

  static async *confirm(
    adapter: AgentAdapter,
    turnId: string,
    confirmed: boolean,
    guard: {
      workspaceId: string;
      userId: string;
      conversationId: string;
      signal?: AbortSignal;
      turnLease?: string;
      channelOrigin?: ChatTurnContext['channelOrigin'];
    },
  ): AsyncIterable<ChatDelta> {
    adapter = this.#resolveChatAdapter(adapter, guard.workspaceId);
    this.#cleanupPendingConfirmations();
    const pending = this.#pendingConfirmations.get(turnId);
    if (!pending) {
      yield { type: 'text', delta: 'That action is no longer waiting for confirmation. Please send the request again.' };
      yield { type: 'done', finishReason: 'error' };
      return;
    }
    if (
      pending.context.workspaceId !== guard.workspaceId ||
      pending.context.userId !== guard.userId ||
      pending.context.conversationId !== guard.conversationId
    ) {
      yield { type: 'text', delta: 'That confirmation belongs to a different conversation.' };
      yield { type: 'done', finishReason: 'error' };
      return;
    }

    this.#pendingConfirmations.delete(turnId);

    if (!confirmed) {
      yield { type: 'text', delta: `Canceled. I did not run ${pending.call.name}.` };
      yield { type: 'done', finishReason: 'stop' };
      return;
    }

    const capabilities = adapter.capabilities?.();
    if (!adapter.chat || capabilities?.interactiveChat === false) {
      yield { type: 'text', delta: capabilities?.limitations?.[0] ?? 'This agent cannot resume the confirmed action because its adapter does not expose interactive chat.' };
      yield { type: 'done', finishReason: 'error' };
      return;
    }

    // Resume under THIS request's lifetime, not the original turn's: the stored
    // context's signal belongs to a request that has already ended (it would read
    // as aborted and instantly bail). Override with the confirm request's signal.
    const resumeCtx: ChatTurnContext = {
      ...pending.context,
      signal: guard.signal,
      ...(guard.turnLease ? { turnLease: guard.turnLease } : { turnLease: undefined }),
      ...(guard.channelOrigin ? { channelOrigin: guard.channelOrigin } : {}),
    };

    const resumedIntent = chatToolIntentCommentary(pending.call.name);
    if (resumedIntent) {
      yield {
        type: 'commentary',
        id: `chat-tool-intent-${pending.call.id}`,
        text: resumedIntent,
        source: 'host',
        createdAt: new Date().toISOString(),
      };
    }
    yield {
      type: 'activity',
      id: `chat-tool-${pending.call.id}`,
      phase: 'tool',
      status: 'running',
      label: chatToolProgressLabel('Using', pending.call.name, pending.call.arguments),
      startedAt: new Date().toISOString(),
    };
    yield { type: 'tool_call', id: pending.call.id, name: pending.call.name, args: pending.call.arguments };
    const executed = await this.#executeToolCall(pending.call, resumeCtx);
    yield {
      type: 'activity',
      id: `chat-tool-${pending.call.id}`,
      phase: 'tool',
      status: executed.result.error ? 'error' : 'success',
      label: chatToolProgressLabel(executed.result.error ? 'Failed' : 'Used', pending.call.name, pending.call.arguments),
      completedAt: new Date().toISOString(),
    };
    yield executed.delta;

    const messages = [
      ...pending.messages,
      {
        role: 'tool' as const,
        toolCallId: pending.call.id,
        content: executed.result.error
          ? JSON.stringify({ error: executed.result.error })
          : JSON.stringify(executed.summarized),
      },
    ];

    yield* this.#executeLoop(adapter, messages, resumeCtx, {
      tools: pending.tools,
      maxTurns: pending.maxTurns,
      maxToolCalls: pending.maxToolCalls,
      startedAt: Date.now(),
      toolCallCount: pending.toolCallCount + 1,
      sessionKey: pending.sessionKey,
      contextMs: null, // resume after a confirmation — no context-build phase
      fastPath: false,
      adapterType: adapter.adapterType ?? 'unknown',
    });
  }

  static async *#executeLoop(
    adapter: AgentAdapter,
    messages: ChatMessage[],
    ctx: ChatTurnContext,
    options: {
      tools: ToolDefinition[];
      maxTurns: number;
      maxToolCalls: number;
      startedAt: number;
      toolCallCount: number;
      /** Context-build wall-clock from `turn()`; null on a confirmation resume. */
      contextMs: number | null;
      /** Whether this turn is answered through the orchestrator fast-path. */
      fastPath: boolean;
      adapterType: string;
      /** Skip native MCP startup for turns that cannot need platform actions. */
      lightweightConversation?: boolean;
      /** Runtime-native session key, identity-versioned for CLI harnesses. */
      sessionKey?: string | null;
      /** The agent's UI-selected runtime model, forwarded to the adapter per call. */
      preferredModel?: string | null;
      qualityMode?: 'quick' | 'deep' | 'mission';
      liveInput?: () => ChatMessage[] | Promise<ChatMessage[]>;
      inputAttachments?: RuntimeInputAttachment[];
      toolMode?: 'adapter_native' | 'caller_loop';
      transportRecovery?: 'none' | 'capability_preserving';
    },
  ): AsyncIterable<ChatDelta> {
    let toolCallCount = options.toolCallCount;
    const requestedWork = latestUserText(messages);
    const localObservations: TurnToolObservation[] = [];
    // CLB stage timers (Phase A). firstTokenMs is the perceived latency; modelMs
    // and toolMs accumulate wall-clock across rounds so the trace shows exactly
    // where an N-round turn spends its time.
    const timings: TurnTimings = {
      contextMs: options.contextMs,
      firstTokenMs: null,
      modelMs: 0,
      toolMs: 0,
      rounds: 0,
      fastPath: options.fastPath,
      adapterType: options.adapterType,
    };
    // Whether ANY assistant text has been streamed across all rounds of this
    // turn. Used to guarantee the turn never ends silently — if we reach a
    // terminal state having shown the operator nothing, we emit an honest
    // summary instead of a bare `done` (which the UI renders as a stuck "?").
    let producedText = false;
    // Whether the model streamed reasoning (chain-of-thought) this turn. A turn
    // that reasoned but emitted no answer is a reasoning model spending its whole
    // budget thinking — recoverable with one more pass, not a dead end.
    let producedThinking = false;
    // One-shot recovery guard + the bumped output budget used on the retry.
    let emptyRetryUsed = false;
    // A runtime can pass a binary health probe and still violate the turn
    // protocol (for example returning CLI-help prose). Retry exactly once on a
    // different configured runtime before showing an adapter failure.
    let runtimeRecoveryUsed = false;
    let retryMaxTokens: number | undefined;
    // Per-round + whole-turn budgets are ADAPTER-DERIVED, not one-size-fits-all. A
    // CLI harness (Codex / Claude Code — `marker_protocol` or `mcp_native`) re-spawns
    // the binary every round: a cold process start + model reasoning + (marker
    // protocol) a tool marker. That cannot finish inside the sub-15s budget a
    // streaming HTTP runtime answers in — forcing the interactive budget on a harness
    // IS the "request timed out after 15 seconds" failure on any real task (build a
    // workflow, author an extension), and it hits EVERY harness, not one vendor. So
    // harnesses get a realistic per-round timeout and a longer multi-round deadline,
    // while streaming runtimes keep the tight budget that protects their latency.
    // Build/extension work streams live canvas events, so the longer harness turn
    // shows continuous progress instead of a frozen spinner. The per-round idle
    // watchdog (HermesAdapter.chat) still bounds each streaming call.
    const forwarding = adapter.capabilities?.().toolForwarding;
    const isCliHarness = forwarding === 'marker_protocol' || forwarding === 'mcp_native';
    const modelRoundTimeoutMs = isCliHarness ? harnessRoundTimeoutMs(Boolean(options.lightweightConversation)) : INTERACTIVE_MODEL_ROUND_TIMEOUT_MS;
    const adapterMcpNative = forwarding === 'mcp_native';
    // Per-conversation permission mode (default ask). `auto` runs mutating tools
    // freely; `ask` confirms them; `plan` blocks them upstream (executionMode).
    const permissionMode = ctx.permissionMode ?? 'ask';
    const approvalSensitivity = ctx.approvalSensitivity ?? 'balanced';
    // Intelligent, time-free stop. The turn runs until the model is done, the
    // operator cancels, or the monitor detects a loop / oscillation / error storm
    // / no-progress — NOT on a wall clock. `absoluteMaxRounds()` is only a
    // defensive ceiling the monitor should always beat to the punch.
    const monitor = new ChatProgressMonitor();
    // `maxTurns` is the caller/node's explicit model-round contract. It used to
    // be carried through confirmations but ignored by the loop in favour of the
    // global 2000-round emergency ceiling, letting agent_task models wander for
    // minutes or hours while still technically making novel calls. Keep the
    // progress monitor, but honor the configured local budget as the hard backstop.
    const maxRounds = Math.min(options.maxTurns, absoluteMaxRounds());
    // IPI taint: set once a tool round ingests content carrying prompt-injection
    // signals. While tainted, high-impact tools are force-confirmed even in
    // `auto` mode — so injected content cannot silently trigger a dangerous
    // action in a later round.
    let turnTainted = false;
    for (let turn = 0; turn < maxRounds; turn += 1) {
      // Operator disconnected (or the turn was otherwise canceled): stop before
      // starting another model round so we don't keep spending on a turn nobody
      // is listening to. Checked every round, including round 0 (abort during
      // context build). In-flight model/tool work is aborted via ctx.signal too.
      if (ctx.signal?.aborted) {
        this.#logTurn(ctx, options.startedAt, toolCallCount, 'aborted', timings);
        yield { type: 'done', finishReason: 'interrupted' };
        return;
      }
      if (turn > 0 && options.liveInput) {
        const joined = await options.liveInput();
        if (joined.length > 0) messages.push(...joined);
      }
      const toolCalls: ChatToolCall[] = [];
      let assistantText = '';
      let reasoningSeg = '';
      let surfacedReasoning = false;
      const progressiveCommentaryId = `assistant-progress-${ctx.clientTurnId ?? ctx.conversationId}-${turn + 1}`;
      let progressiveCommentaryVisible = false;
      const bufferedDeltas: ChatDelta[] = [];
      let surfacedConfirmation = false;
      let finishReason: Extract<ChatDelta, { type: 'done' }>['finishReason'] = 'stop';
      let roundUsage: Extract<ChatDelta, { type: 'done' }>['usage'];

      try {
        yield this.#activity(ctx, 'runtime', 'Waiting for model output', `Runtime pass ${turn + 1} is in progress.`, `runtime-${turn + 1}`);
        timings.rounds += 1;
        const roundStart = Date.now();
        const qualityMode = options.qualityMode ?? ctx.qualityMode ?? 'deep';
        const configuredEffort = qualityMode === 'mission' && adapter.getRuntimeContext
          ? await adapter.getRuntimeContext().then((runtime) => runtime.currentEffort).catch(() => undefined)
          : undefined;
        const missionEffort = qualityMode === 'mission' ? reasoningFloor(configuredEffort, 'high') : undefined;
        const selectedToolMode = options.toolMode
          ?? (adapterMcpNative
            ? (options.lightweightConversation ? 'caller_loop' : 'adapter_native')
            : undefined);
        const chatOptions: ChatInvocationOptions = {
          latencyClass: qualityMode === 'quick' ? 'interactive' : 'deliberate',
          ...(missionEffort ? { reasoningEffort: missionEffort, fastMode: false } : {}),
          timeoutMs: modelRoundTimeoutMs,
          sessionKey: options.sessionKey ?? ctx.conversationId,
          ...(ctx.turnLease ? { conversationId: ctx.conversationId, turnLease: ctx.turnLease } : {}),
          ...(selectedToolMode ? { toolMode: selectedToolMode } : {}),
          ...(options.transportRecovery ? { transportRecovery: options.transportRecovery } : {}),
          ...(adapterMcpNative
            ? {
                // Real (registry-level) permission enforcement for the harness's own
                // tool loop: the adapter turns this into an execution-mode header on
                // the per-turn MCP descriptor. `plan` hard-blocks mutations; `ask`
                // blocks-and-instructs (operator approves / switches to Auto); `auto`
                // → chat (allow). This is what makes Ask/Plan real on mcp_native,
                // where there is no interceptable per-tool confirmation dialog.
                executionMode: permissionMode === 'plan' ? 'plan' : permissionMode === 'ask' ? 'ask' : 'chat',
                approvalSensitivity,
              }
            : {}),
          // A recovery adapter has its own model catalogue. Never forward the
          // selected runtime's model across that boundary (e.g. Gemini -> Codex).
          ...(options.preferredModel && adapter.adapterType === options.adapterType
            ? { preferredModel: options.preferredModel }
            : {}),
          ...(options.inputAttachments?.length ? { inputAttachments: options.inputAttachments } : {}),
        };
        if (ctx.signal) chatOptions.signal = ctx.signal;
        if (retryMaxTokens) chatOptions.maxTokens = retryMaxTokens;
        for await (const delta of adapter.chat!(messages, options.tools, Object.keys(chatOptions).length > 0 ? chatOptions : undefined)) {
          if (delta.type === 'text') {
            assistantText += delta.delta;
            const progressiveText = compactPublicProgress(assistantText);
            if (progressiveText) {
              progressiveCommentaryVisible = true;
              yield {
                type: 'commentary',
                id: progressiveCommentaryId,
                text: progressiveText,
                source: 'assistant_preamble',
                createdAt: new Date().toISOString(),
              };
            }
          }
          if (delta.type === 'thinking' && delta.delta) producedThinking = true;
          if ((delta.type === 'text' && delta.delta) || delta.type === 'tool_call') {
            if (timings.firstTokenMs === null) timings.firstTokenMs = Date.now() - options.startedAt;
          }
          if (delta.type === 'tool_call') toolCalls.push({ id: delta.id, name: delta.name, arguments: delta.args });
          if (delta.type === 'confirmation_required') surfacedConfirmation = true;
          if (delta.type === 'done') {
            finishReason = delta.finishReason;
            roundUsage = delta.usage;
            continue;
          }
          // Runtime prose is ambiguous until the round finishes. Buffer text so
          // tool-round narration cannot leak into the final answer, but stream
          // factual activity immediately so the operator never stares at a dead
          // "Waiting for runtime" card while the harness is actively working.
          if (delta.type === 'activity') {
            yield delta;
          } else if (delta.type === 'commentary') {
            yield { ...delta, text: compactPublicProgress(delta.text) };
          } else if (delta.type === 'thinking') {
            // Surface harness reasoning as a streaming, replace-in-place reasoning
            // row (the SAME `activity` shape adapters like Codex already emit)
            // instead of DROPPING it. This is the root fix for "watch the agent
            // think": every harness that yields raw thinking now streams live — in
            // chat AND in agent_task (the run relay picks up these activity deltas
            // run-scoped). Flush on a natural boundary / readable chunk so it flows
            // like a thought stream without per-token event spam.
            if (!surfacedReasoning) {
              surfacedReasoning = true;
              yield this.#activity(ctx, 'runtime', 'Model is reasoning', 'The runtime is preparing the next operator-visible step.', 'reasoning');
            }
            if (false && reasoningSeg.length >= 80) {
              const seg = reasoningSeg.replace(/\s+/g, ' ').trim();
              reasoningSeg = '';
              if (seg) yield this.#activity(ctx, 'runtime', seg.length > 600 ? `${seg.slice(0, 599)}…` : seg, '', 'reasoning');
            }
          } else {
            bufferedDeltas.push(delta);
          }
        }
        // Flush any trailing reasoning that didn't hit a boundary.
        if (false && reasoningSeg.trim()) {
          const seg = reasoningSeg.replace(/\s+/g, ' ').trim();
          reasoningSeg = '';
          yield this.#activity(ctx, 'runtime', seg.length > 600 ? `${seg.slice(0, 599)}…` : seg, '', 'reasoning');
        }
        timings.modelMs += Date.now() - roundStart;
        this.#recordModelUsage(ctx, roundUsage ?? estimateRoundUsage(messages, assistantText), turn + 1, options.adapterType);
      } catch (err) {
        if (ctx.signal?.aborted) {
          this.#logTurn(ctx, options.startedAt, toolCallCount, 'aborted', timings);
          yield { type: 'done', finishReason: 'interrupted' };
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        this.#deps.logger?.warn('chat.turn.adapter_failed', { agentId: ctx.agentId, err: message });
        yield { type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error: message };
        yield { type: 'done', finishReason: 'error' };
        return;
      }

      const adapterFailure = bufferedDeltas.find((delta) =>
        delta.type === 'tool_result' && delta.name === 'adapter.chat' && Boolean(delta.error));
      if (adapterFailure && !runtimeRecoveryUsed && toolCalls.length === 0) {
        const adapterError = adapterFailure.type === 'tool_result' ? adapterFailure.error : undefined;
        const fallback = this.#healthyFallbackAdapter(adapter, ctx.workspaceId, String(messages.at(-1)?.content ?? ''));
        if (fallback) {
          runtimeRecoveryUsed = true;
          adapter = fallback;
          yield this.#activity(
            ctx,
            'runtime',
            'Retrying on a healthy runtime',
            `${adapterError ?? 'The selected runtime failed'} Retrying once on ${fallback.adapterType ?? 'the workspace fallback'}.`,
            'runtime-recovery',
          );
          continue;
        }
      }

      if (toolCalls.length === 0 || finishReason !== 'tool_calls') {
        // The provisional row made the answer readable while chunks arrived.
        // Clear it before promoting the same text into the final assistant body.
        if (progressiveCommentaryVisible) {
          yield {
            type: 'commentary',
            id: progressiveCommentaryId,
            text: '',
            source: 'assistant_preamble',
            createdAt: new Date().toISOString(),
          };
        }
        const leaseObservations = ctx.turnLease
          ? this.turnExperience(ctx.workspaceId, ctx.conversationId, ctx.turnLease)?.observations ?? []
          : [];
        const evidenceVerdict = finishReason === 'stop'
          ? guardCompletionClaims({
              userMessage: requestedWork,
              assistantText,
              observations: leaseObservations.length > 0 ? leaseObservations : localObservations,
            })
          : { allowed: true, claimed: [], missing: [] };
        for (const delta of bufferedDeltas) {
          if (delta.type === 'text' && delta.delta) producedText = true;
          yield delta;
        }
        if (!evidenceVerdict.allowed) {
          // Evidence enforcement remains durable/auditable, but an internal
          // ledger dump is not a chat answer. Keep the model's useful response
          // readable and let the normal run/history surfaces carry the receipts.
          this.#deps.logger?.warn('chat.completion_claim.withheld', {
            workspaceId: ctx.workspaceId,
            agentId: ctx.agentId,
            conversationId: ctx.conversationId,
            claimed: evidenceVerdict.claimed,
            missing: evidenceVerdict.missing,
          });
        }
        const noOutput = !assistantText.trim() && !surfacedConfirmation && finishReason !== 'error';
        // Empty-turn recovery. A turn can end with zero answer text in three ways:
        // a reasoning model burned its budget thinking (`length`, or a clean `stop`
        // after only `thinking`), OR a non-streaming CLI harness (e.g. Hermes over
        // the marker protocol) finished its loop and exited clean WITHOUT surfacing
        // a final answer — a bare `stop` with no text and no thinking. All three
        // used to dump the canned "completed without returning an answer" and throw
        // the work away. Instead retry ONCE with more room and an explicit nudge to
        // write the answer. Model-agnostic: no model-family branching, just "give it
        // room + ask plainly", bounded to a single extra round. `max_turns` (a real
        // cap/pause) is deliberately excluded so we never re-burn a long budget.
        if (noOutput && !emptyRetryUsed && (finishReason === 'length' || finishReason === 'stop' || producedThinking)) {
          emptyRetryUsed = true;
          retryMaxTokens = EMPTY_RETRY_MAX_TOKENS;
          this.#deps.logger?.warn('chat.turn.empty_recovered', {
            workspaceId: ctx.workspaceId, agentId: ctx.agentId, conversationId: ctx.conversationId,
            finishReason, producedThinking, round: turn + 1,
          });
          messages.push({ role: 'user', content: REASONING_NUDGE });
          continue;
        }
        this.#logTurn(ctx, options.startedAt, toolCallCount, finishReason, timings);
        // Never finish a turn with nothing on screen. A model that returns no
        // text and no tool call (or an empty single-shot) would otherwise leave
        // the operator staring at a "?" — emit an honest fallback instead. But
        // not when the turn already surfaced a confirmation card (that IS the
        // content) or failed (the route surfaces the adapter error message).
        if (noOutput) {
          // Pick the most honest fallback for HOW the turn came up empty:
          // - tools already ran this turn (real work, possibly with side effects),
          //   then the runtime's wrap-up round returned nothing → warn that a blind
          //   retry may REPEAT that work, instead of implying a free retry;
          // - the model reasoned but wouldn't answer even after the retry;
          // - otherwise a bare empty completion (a remote-model harness returning
          //   no output — often an unavailable / rate-limited / out-of-quota model).
          const message = toolCallCount > 0
            ? DID_WORK_NO_ANSWER_MESSAGE
            : producedThinking ? REASONED_NO_ANSWER_MESSAGE : EMPTY_TURN_MESSAGE;
          yield { type: 'text', delta: message };
        }
        // `length` is not a clean stop — report it as max_turns so the route/UI
        // treats it as a guardrail outcome, not a satisfied answer.
        const terminal = finishReason === 'length' ? 'max_turns' : finishReason;
        yield { type: 'done', finishReason: terminal };
        return;
      }

      // Text emitted alongside a tool-call finish is an assistant preamble, not
      // the final answer. Preserve it as safe live commentary instead of silently
      // dropping the exact "I found X; now I am checking Y" narration users rely on.
      const assistantPreamble = assistantText.replace(/\s+/g, ' ').trim();
      if (assistantPreamble) {
        yield {
          type: 'commentary',
          id: progressiveCommentaryId,
          text: compactPublicProgress(assistantPreamble),
          source: 'assistant_preamble',
          createdAt: new Date().toISOString(),
        };
      }

      // Preserve the tool-call protocol for the executor, but deliberately drop
      // any text emitted before those calls from the operator transcript.
      for (const delta of bufferedDeltas) {
        if (delta.type === 'tool_call' || delta.type === 'confirmation_required') {
          yield delta;
        }
      }
      messages.push({ role: 'assistant', content: assistantText, toolCalls });

      // Cap batch to remaining budget before kicking off parallel execution.
      const remaining = options.maxToolCalls - toolCallCount;
      const batch = toolCalls.slice(0, remaining);
      if (batch.length < toolCalls.length) {
        this.#logTurn(ctx, options.startedAt, toolCallCount, 'max_tool_calls', timings);
        if (!producedText) yield { type: 'text', delta: TURN_LIMIT_MESSAGE };
        yield { type: 'done', finishReason: 'max_turns' };
        return;
      }

      const confirmationCall = batch.find((call) =>
        ChatToolExecutor.requiresConfirmation(call.name, permissionMode, approvalSensitivity) ||
        // IPI escalation: a tainted turn cannot run a high-impact tool without
        // an explicit operator OK, regardless of permission mode.
        (turnTainted && ChatToolExecutor.isHighImpact(call.name)),
      );
      if (confirmationCall) {
        const turnId = randomUUID();
        const now = Date.now();
        const assistantForConfirmation: ChatMessage = {
          role: 'assistant',
          content: assistantText,
          toolCalls: [confirmationCall],
        };
        this.#pendingConfirmations.set(turnId, {
          turnId,
          call: confirmationCall,
          // Don't retain this request's abort signal — the confirmation resumes on
          // a SEPARATE request (see confirm()), which supplies its own signal.
          context: { ...ctx, signal: undefined },
          messages: [...messages.slice(0, -1), assistantForConfirmation],
          tools: options.tools,
          maxTurns: options.maxTurns,
          maxToolCalls: options.maxToolCalls,
          toolCallCount,
          sessionKey: options.sessionKey ?? ctx.conversationId,
          createdAt: now,
          expiresAt: now + CONFIRMATION_TTL_MS,
        });
        yield this.#buildConfirmationDelta(turnId, confirmationCall, now + CONFIRMATION_TTL_MS);
        this.#logTurn(ctx, options.startedAt, toolCallCount, 'confirmation_required', timings);
        yield { type: 'done', finishReason: 'stop' };
        return;
      }

      toolCallCount += batch.length;

      // Don't kick off tools (some spend model credits — e.g. build_workflow) if
      // the turn was canceled while the model round was streaming.
      if (ctx.signal?.aborted) {
        this.#logTurn(ctx, options.startedAt, toolCallCount, 'aborted', timings);
        yield { type: 'done', finishReason: 'interrupted' };
        return;
      }
      // If the model is building a workflow this round, give the build a known
      // runId and stream its live narration into the chat (same bridge as the
      // fast-path direct build) so model-driven builds are just as legible.
      const buildCall = batch.find((call) => call.name === 'agentis.build_workflow');
      const buildRunId = buildCall ? (ctx.runId ?? `build_${ctx.clientTurnId ?? randomUUID()}`) : null;
      const execCtx = buildRunId ? { ...ctx, runId: buildRunId } : ctx;
      // Live "Using <tool>" cards for the marker-protocol tool round — parity with
      // the Codex CLI's shell cards, so a multi-round agent (Hermes/Antigravity, or
      // any marker-protocol runtime) is legible while it works instead of a silent
      // "Waiting for model output". `build_workflow` is skipped: it streams its own
      // richer backend narration via #streamBuildNarration below.
      const carded = batch.filter((call) => call.name !== 'agentis.build_workflow' && call.name !== 'agentis.team.spawn' && !isBackgroundChatTool(call.name));
      // Some CLI runtimes legitimately provide no pre-tool prose. In that case
      // emit one factual intent derived from the operation itself: it is live,
      // useful and auditable, without manufacturing a fake inner monologue.
      for (const call of batch) {
        const commentary = chatToolIntentCommentary(call.name);
        if (!commentary) continue;
        yield {
          type: 'commentary',
          id: `chat-tool-intent-${call.id}`,
          text: commentary,
          source: 'host',
          createdAt: new Date().toISOString(),
        };
      }
      for (const call of carded) {
        yield {
          type: 'activity',
          id: `chat-tool-${call.id}`,
          phase: 'tool',
          status: 'running',
          label: chatToolProgressLabel('Using', call.name, call.arguments),
          startedAt: new Date().toISOString(),
        };
      }

      // Execute all tool calls in parallel — SQLite builtins are sub-ms, HTTP
      // tools can take hundreds of ms. Parallel execution is the spec §6.2 design.
      const toolRoundStart = Date.now();
      const swarmCalls = batch.filter((call) => call.name === 'agentis.team.spawn');
      const standardCalls = batch.filter((call) => call.name !== 'agentis.team.spawn');
      const runBatch = () => Promise.all(standardCalls.map((call) => this.#executeToolCall(call, execCtx)));
      let settled: Awaited<ReturnType<typeof runBatch>> = [];
      // A chat team is a streaming tool, not a background black box. Drain its
      // safe state snapshots before giving the lead the consolidated tool result.
      for (const call of swarmCalls) {
        const startedAt = Date.now();
        let result: { data?: unknown; error?: string } = { error: 'The chat swarm runner is not configured.' };
        if (this.#deps.chatSwarms) {
          for await (const delta of this.#deps.chatSwarms.run(call.arguments as Parameters<ChatSwarmService['run']>[0], execCtx, call.id)) {
            if (delta.type === 'tool_result') {
              result = delta.error ? { error: delta.error } : { data: delta.result };
            } else {
              yield delta;
            }
          }
        }
        const durationMs = Date.now() - startedAt;
        const summarized = summarizeToolResult(result.data ?? result.error ?? null);
        settled.push({
          call,
          result,
          summarized,
          durationMs,
          delta: { type: 'tool_result', id: call.id, name: call.name, result: summarized, ...(result.error ? { error: result.error } : {}) },
        });
      }
      if (buildRunId) {
        const holder: { result?: Awaited<ReturnType<typeof runBatch>> } = {};
        yield* this.#streamBuildNarration(execCtx, buildRunId, holder, runBatch);
        settled.push(...holder.result!);
      } else {
        settled.push(...await runBatch());
      }
      timings.toolMs += Date.now() - toolRoundStart;

      let consultationAwaitingApproval = false;
      for (const { call, result, summarized, delta, durationMs } of settled) {
        localObservations.push({
          index: localObservations.length + 1,
          name: call.name,
          args: call.arguments,
          result: result.data ?? result.error ?? null,
          ok: !result.error,
          mutating: ChatToolExecutor.isMutating(call.name),
          repeats: 1,
          durationMs,
        });
        // Close out the live card (replace-in-place by id) before its result.
        if (call.name !== 'agentis.build_workflow' && call.name !== 'agentis.team.spawn' && !isBackgroundChatTool(call.name)) {
          const failed = Boolean(result.error);
          yield {
            type: 'activity',
            id: `chat-tool-${call.id}`,
            phase: 'tool',
            status: failed ? 'error' : 'success',
            label: chatToolProgressLabel(failed ? 'Failed' : 'Used', call.name, call.arguments),
            completedAt: new Date().toISOString(),
          };
        }
        if (call.name === 'agentis.agent.consult' && result.data && typeof result.data === 'object') {
          const consultation = result.data as {
            agentConsultation?: boolean;
            consultationId?: string;
            caller?: { id?: string; name?: string };
            target?: { id?: string; name?: string };
            round?: number;
            maxRounds?: number;
            status?: string;
          };
          if (consultation.agentConsultation && consultation.consultationId && consultation.caller?.id && consultation.target?.id) {
            const awaiting = consultation.status === 'awaiting_approval';
            consultationAwaitingApproval ||= awaiting;
            yield {
              type: 'agent_consultation',
              consultationId: consultation.consultationId,
              phase: awaiting ? 'awaiting_approval' : 'completed',
              callerAgentId: consultation.caller.id,
              targetAgentId: consultation.target.id,
              callerName: consultation.caller.name,
              targetName: consultation.target.name,
              round: consultation.round ?? 1,
              maxRounds: consultation.maxRounds ?? 3,
              summary: awaiting
                ? `${consultation.target.name ?? 'Specialist'} is awaiting operator approval.`
                : `${consultation.target.name ?? 'Specialist'} answered ${consultation.caller.name ?? 'the calling agent'}.`,
              status: awaiting ? 'running' : 'success',
              createdAt: new Date().toISOString(),
            };
          }
        }
        yield delta;
        let toolContent = result.error
          ? JSON.stringify({ error: result.error })
          : JSON.stringify(summarized);
        // IPI quarantine: scan a successful tool result for injection carriers.
        // If found, strip the invisible carriers, taint the turn (escalating the
        // NEXT high-impact call to operator confirmation), and hand the model an
        // explicitly-labelled "untrusted data" envelope instead of raw content.
        if (!result.error) {
          const scan = scanForInjection(toolContent);
          if (scan.suspicious) {
            turnTainted = true;
            this.#deps.logger?.warn('chat.ipi.suspicious_tool_result', {
              workspaceId: ctx.workspaceId,
              agentId: ctx.agentId,
              tool: call.name,
              signals: scan.signals,
            });
            toolContent = wrapUntrusted(scan.sanitized, {
              source: call.name,
              note: `injection signals: ${scan.signals.join(', ')}`,
            });
          }
        }
        messages.push({ role: 'tool', toolCallId: call.id, content: toolContent });
      }

      if (consultationAwaitingApproval) {
        this.#logTurn(ctx, options.startedAt, toolCallCount, 'consultation_awaiting_approval', timings);
        yield { type: 'done', finishReason: 'stop' };
        return;
      }

      // Intelligent stop: feed this round to the progress monitor. A round counts
      // as progress when it issues a never-before-seen call or yields a new
      // result; the monitor stops the turn the moment it detects a pathology
      // (identical repetition, oscillation, error storm, or a no-progress streak).
      // Pre-tool model prose is dropped from a tool round (see above), so it is not
      // counted as operator-visible text here.
      const observation: RoundObservation = {
        toolCalls: batch.map((call) => ({ name: call.name, argsHash: hashValue(call.arguments) })),
        resultHashes: settled.map(({ result, summarized }) =>
          hashValue(result.error ? { error: result.error } : (summarized ?? null)),
        ),
        allToolsErrored: settled.length > 0 && settled.every(({ result }) => Boolean(result.error)),
        producedText: false,
      };
      const stop = monitor.record(observation);
      if (stop) {
        this.#logTurn(ctx, options.startedAt, toolCallCount, `stalled:${stop.kind}`, timings);
        yield { type: 'text', delta: stopReasonMessage(stop) };
        yield { type: 'done', finishReason: 'stop' };
        return;
      }
    }

    // Absolute defensive ceiling reached (maxRounds) — the monitor should always
    // have stopped a real loop long before this. Honest terminal message.
    this.#logTurn(ctx, options.startedAt, toolCallCount, 'max_rounds', timings);
    if (!producedText) yield { type: 'text', delta: TURN_LIMIT_MESSAGE };
    yield { type: 'done', finishReason: 'max_turns' };
  }

  static async #executeToolCall(call: ChatToolCall, ctx: ChatTurnContext) {
    const toolStartedAt = Date.now();
    const result = await ChatToolExecutor.run(call.name, call.arguments, ctx);
    const durationMs = Date.now() - toolStartedAt;
    const summarized = summarizeToolResult(result.data ?? result.error ?? null);
    const ok = !result.error && resultProvidesCompletionEvidence(result.data);
    if (ctx.turnLease && this.#deps.turnLeases) {
      try {
        this.#deps.turnLeases.recordToolResult({
          workspaceId: ctx.workspaceId,
          conversationId: ctx.conversationId,
          token: ctx.turnLease,
          name: call.name,
          toolArgs: call.arguments,
          result: result.data ?? result.error ?? null,
          ok,
          mutating: ChatToolExecutor.isMutating(call.name),
          durationMs,
        });
      } catch (err) {
        // Stop may revoke the lease after the tool completed. Experience capture
        // is best-effort and must never convert real work into a second failure.
        this.#deps.logger?.debug?.('chat.tool_experience.skipped', { tool: call.name, reason: (err as Error).message });
      }
    }
    recordToolCall(call.name, durationMs, ok);
    this.#deps.logger?.info('chat.tool_call', {
      workspaceId: ctx.workspaceId,
      agentId: ctx.agentId,
      tool: call.name,
      ok,
      durationMs,
    });
    return {
      call,
      result,
      summarized,
      durationMs,
      delta: {
        type: 'tool_result' as const,
        id: call.id,
        name: call.name,
        result: summarized,
        ...(result.error ? { error: result.error } : {}),
      },
    };
  }

  /**
   * Bridge a workflow build's real backend narration into the chat turn. While
   * `build` is in flight, subscribe to the event bus for THIS run's build/canvas
   * events and yield each as a `phase:'workflow'` activity delta — the same shape
   * the chat already renders in its live execution trace. This makes the build
   * legible from inside the chat itself, independent of the realtime socket (the
   * socket carries the same events for the canvas; this guarantees the chat is
   * never a black box even when the socket is down). Bus events are published
   * synchronously during the build, so the queue is fully drained once it settles.
   */
  static async *#streamBuildNarration<T>(
    ctx: ChatTurnContext,
    runId: string,
    holder: { result?: T },
    run: () => Promise<T>,
  ): AsyncIterable<ChatDelta> {
    const bus = this.#deps.bus;
    if (!bus) { holder.result = await run(); return; }

    const queue: ChatDelta[] = [];
    let wake: (() => void) | null = null;
    const ping = () => { const w = wake; wake = null; w?.(); };
    let settled = false;

    // Subscribe BEFORE starting the build so the first, fast events (e.g. the
    // `analyzing` phase) can never fire before we're listening.
    const unsubscribe = bus.subscribe((msg) => {
      const payload = msg.envelope.payload as Record<string, unknown> | undefined;
      if (!payload || payload.runId !== runId) return;
      const delta = buildNarrationDelta(msg.envelope.event, payload, ctx, runId);
      if (delta) { queue.push(delta); ping(); }
    });
    const build = run();
    void build.then((result) => { holder.result = result; settled = true; ping(); }, () => { settled = true; ping(); });

    try {
      while (true) {
        while (queue.length > 0) yield queue.shift()!;
        if (settled) break;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
      while (queue.length > 0) yield queue.shift()!; // flush any final events
    } finally {
      unsubscribe();
    }
    // Surface a rejection to the caller (matches a plain `await run()`).
    if (holder.result === undefined) await build;
  }

  static #activity(
    ctx: ChatTurnContext,
    phase: Extract<ChatDelta, { type: 'activity' }>['phase'],
    label: string,
    detail: string,
    suffix: string,
    status: Extract<ChatDelta, { type: 'activity' }>['status'] = 'running',
  ): Extract<ChatDelta, { type: 'activity' }> {
    return {
      type: 'activity',
      id: `activity-${ctx.clientTurnId ?? ctx.conversationId}-${suffix}`,
      phase,
      status,
      label,
      detail,
      startedAt: new Date().toISOString(),
      agentId: ctx.agentId,
      ...(workflowIdFromViewport(ctx.viewport) ? { workflowId: workflowIdFromViewport(ctx.viewport) } : {}),
      ...(ctx.clientTurnId ? { clientTurnId: ctx.clientTurnId } : {}),
    };
  }

  static #buildConfirmationDelta(turnId: string, call: ChatToolCall, expiresAt: number): Extract<ChatDelta, { type: 'confirmation_required' }> {
    const title = confirmationTitle(call.name);
    const definition = ChatToolExecutor.definition(call.name);
    const impact = confirmationImpact(call.name, call.arguments, definition?.description, this.#deps.db);
    const approval = resolveToolApprovalPolicy(call.name, definition);
    impact.riskLevel = approval.riskLevel === 'critical' ? 'danger' : approval.riskLevel;
    impact.reversible = approval.reversible ?? impact.reversible;
    impact.externalSideEffects = approval.externalSideEffects ?? impact.externalSideEffects;
    const args = safeJson(call.arguments);
    const clippedArgs = args.length > 900 ? `${args.slice(0, 900)}...` : args;
    return {
      type: 'confirmation_required',
      turnId,
      toolCall: { id: call.id, name: call.name, args: call.arguments },
      title,
      body: [
        impact.summary,
        '',
        ...(impact.details.length > 0 ? ['Action details:', ...impact.details.map((detail) => `- ${detail}`), ''] : []),
        `Arguments:\n${clippedArgs}`,
      ].join('\n'),
      impact,
      confirmLabel: confirmationConfirmLabel(call.name),
      cancelLabel: 'Cancel',
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  static #cleanupPendingConfirmations(): void {
    const now = Date.now();
    for (const [turnId, pending] of this.#pendingConfirmations) {
      if (pending.expiresAt <= now) this.#pendingConfirmations.delete(turnId);
    }
  }

  static #loadPromptContext(ctx: ChatTurnContext) {
    const db = this.#deps.db;
    if (!db) return {};
    const workspace = db
      .select({ name: schema.workspaces.name })
      .from(schema.workspaces).where(eq(schema.workspaces.id, ctx.workspaceId)).get();
    const agent = db
      .select({ name: schema.agents.name, role: schema.agents.role, spaceTag: schema.agents.spaceTag, runtimeModel: schema.agents.runtimeModel })
      .from(schema.agents).where(eq(schema.agents.id, ctx.agentId)).get();
    // PERF: project only the columns we render and push filter/order/limit into
    // SQL. These tables grow without bound (workflow_runs accumulates one row +
    // a full runState/graphSnapshot JSON blob per execution); a prior `.all()`
    // here deserialized EVERY run's state on EVERY chat turn — the cause of the
    // "fast at first, slower over time" degradation. Now O(few), not O(history).
    const agentInventory = db
      .select({ id: schema.agents.id, name: schema.agents.name, status: schema.agents.status, adapterType: schema.agents.adapterType })
      .from(schema.agents).where(eq(schema.agents.workspaceId, ctx.workspaceId)).all();
    const activeRuns = db
      .select({ id: schema.workflowRuns.id, workflowId: schema.workflowRuns.workflowId, status: schema.workflowRuns.status, createdAt: schema.workflowRuns.createdAt })
      .from(schema.workflowRuns)
      .where(and(eq(schema.workflowRuns.workspaceId, ctx.workspaceId), eq(schema.workflowRuns.status, 'RUNNING')))
      .orderBy(desc(schema.workflowRuns.createdAt))
      .limit(10)
      .all()
      .map((run) => ({ id: run.id, workflowId: run.workflowId ?? `ephemeral:${run.id}`, status: run.status, createdAt: run.createdAt }));
    const pendingApprovals = db
      .select({ id: schema.approvalRequests.id, title: schema.approvalRequests.title, summary: schema.approvalRequests.summary })
      .from(schema.approvalRequests)
      .where(and(eq(schema.approvalRequests.workspaceId, ctx.workspaceId), eq(schema.approvalRequests.status, 'pending')))
      .orderBy(desc(schema.approvalRequests.createdAt))
      .limit(10)
      .all();
    const gateways = db
      .select({ id: schema.openclawGateways.id, name: schema.openclawGateways.name, status: schema.openclawGateways.status, lastHeartbeatAt: schema.openclawGateways.lastHeartbeatAt })
      .from(schema.openclawGateways).where(eq(schema.openclawGateways.workspaceId, ctx.workspaceId)).all();
    const adapterHealth = this.#deps.adapters?.list()
      .filter((registration) => agentInventory.some((agentRow) => agentRow.id === registration.agentId))
      .map((registration) => ({
        agentId: registration.agentId,
        adapterType: registration.adapterType,
        capabilities: registration.adapter.capabilities?.() ?? null,
      })) ?? [];
    return {
      workspaceName: workspace?.name,
      agentName: agent?.name,
      agentRole: agent?.role ?? null,
      agentDomain: agent?.spaceTag ?? null,
      agentRuntimeModel: agent?.runtimeModel ?? null,
      agentInventory,
      activeRuns,
      pendingApprovals,
      gatewayHealth: { gateways, registeredAdapters: adapterHealth },
    };
  }

  /**
   * Scan the user message for `@AgentName` and `#resourceRef` tokens.
   * Looks each up in the DB and returns structured context to inject into the
   * system prompt — this is the §6 @mention / #resource context injection.
   */
  static #extractInlineContext(
    userMessage: string,
    ctx: ChatTurnContext,
  ): { mentionedAgents: Array<{ id: string; name: string; adapterType: string | null; status: string | null; instructions: string | null }>; referencedResources: Array<{ kind: string; id: string; name: string; detail: string }> } {
    const db = this.#deps.db;
    if (!db) return { mentionedAgents: [], referencedResources: [] };

    // @AgentName — match words like @Foo or @Foo_Bar (underscores from autocomplete)
    const mentionNames = Array.from(
      new Set((userMessage.match(/@([\w_-]+)/g) ?? []).map((m) => m.slice(1).replace(/_/g, ' '))),
    );
    const mentionedAgents: Array<{ id: string; name: string; adapterType: string | null; status: string | null; instructions: string | null }> = [];
    for (const rawName of mentionNames) {
      // PERF: resolve by name in SQL (projected columns) instead of loading the
      // whole agent table (config/capabilityTags JSON) and scanning in JS.
      const row = db
        .select({ id: schema.agents.id, name: schema.agents.name, adapterType: schema.agents.adapterType, status: schema.agents.status, instructions: schema.agents.instructions })
        .from(schema.agents)
        .where(and(eq(schema.agents.workspaceId, ctx.workspaceId), sql`lower(${schema.agents.name}) = ${rawName.toLowerCase()}`))
        .limit(1)
        .get();
      if (row) {
        mentionedAgents.push({
          id: row.id,
          name: row.name,
          adapterType: row.adapterType ?? null,
          status: row.status ?? null,
          instructions: row.instructions ? row.instructions.slice(0, 400) : null,
        });
      }
    }

    // #resourceRef — try to match workflow name or run ID
    const resourceRefs = Array.from(
      new Set((userMessage.match(/#([\w_-]+)/g) ?? []).map((m) => m.slice(1))),
    );
    const referencedResources: Array<{ kind: string; id: string; name: string; detail: string }> = [];
    for (const ref of resourceRefs) {
      // Try run ID first — projected columns + SQL match so we never load the
      // run's runState/graphSnapshot JSON blobs just to resolve a #reference.
      const run = db
        .select({ id: schema.workflowRuns.id, workflowId: schema.workflowRuns.workflowId, ephemeralTitle: schema.workflowRuns.ephemeralTitle, status: schema.workflowRuns.status, createdAt: schema.workflowRuns.createdAt })
        .from(schema.workflowRuns)
        .where(and(
          eq(schema.workflowRuns.workspaceId, ctx.workspaceId),
          or(eq(schema.workflowRuns.id, ref), like(schema.workflowRuns.id, `${ref}%`)),
        ))
        .limit(1)
        .get();
      if (run) {
        referencedResources.push({
          kind: 'run',
          id: run.id,
          name: run.workflowId ?? run.ephemeralTitle ?? `ephemeral:${run.id}`,
          detail: `status=${run.status} createdAt=${run.createdAt}`,
        });
        continue;
      }
      // Try workflow by name — project {id,title} only (avoid the graph JSON blob).
      const wf = db
        .select({ id: schema.workflows.id, title: schema.workflows.title })
        .from(schema.workflows)
        .where(eq(schema.workflows.workspaceId, ctx.workspaceId))
        .all()
        .find((w) => w.title.toLowerCase().replace(/\s+/g, '_') === ref.toLowerCase() || w.id === ref);
      if (wf) {
        referencedResources.push({
          kind: 'workflow',
          id: wf.id,
          name: wf.title,
          detail: `id=${wf.id}`,
        });
      }
    }

    return { mentionedAgents, referencedResources };
  }

  static #logTurn(
    ctx: ChatTurnContext,
    startedAt: number,
    toolCalls: number,
    finishReason: string,
    timings: TurnTimings,
  ) {
    const totalMs = Date.now() - startedAt;
    this.#deps.logger?.info('chat.turn.completed', {
      workspaceId: ctx.workspaceId,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
      finishReason,
      toolCalls,
      durationMs: totalMs,
      // CLB stage breakdown (Phase A): see where the turn actually spent time.
      contextMs: timings.contextMs,
      firstTokenMs: timings.firstTokenMs,
      modelMs: timings.modelMs,
      toolMs: timings.toolMs,
      rounds: timings.rounds,
      fastPath: timings.fastPath,
      adapterType: timings.adapterType,
    });
    recordTurn({
      totalMs,
      contextMs: timings.contextMs,
      firstTokenMs: timings.firstTokenMs,
      modelMs: timings.modelMs,
      toolMs: timings.toolMs,
      toolCalls,
      rounds: timings.rounds,
      finishReason,
      fastPath: timings.fastPath,
      adapterType: timings.adapterType,
    });
  }

  static #recordModelUsage(
    ctx: ChatTurnContext,
    usage: NonNullable<Extract<ChatDelta, { type: 'done' }>['usage']>,
    round: number,
    adapterType: string,
  ): void {
    const tokensIn = Math.max(0, Math.round(usage.inputTokens));
    const tokensOut = Math.max(0, Math.round(usage.outputTokens));
    const costCents = usage.costCents === undefined ? null : Math.max(0, Math.ceil(usage.costCents));
    if (tokensIn === 0 && tokensOut === 0 && !costCents) return;
    const runId = ctx.runId ?? `chat:${ctx.conversationId}:${ctx.clientTurnId ?? 'turn'}`;
    this.#deps.audit?.record({
      workspaceId: ctx.workspaceId,
      runId,
      agentId: ctx.agentId,
      action: 'chat.model.completed',
      actorType: 'agent',
      actorId: ctx.agentId,
      outputSummary: `${usage.estimated ? 'estimated' : 'reported'} usage; adapter=${adapterType}; round=${round}; cached_input_tokens=${Math.max(0, Math.round(usage.cachedInputTokens ?? 0))}; uncached_input_tokens=${Math.max(0, tokensIn - Math.round(usage.cachedInputTokens ?? 0))}`,
      costCents,
      tokensIn,
      tokensOut,
    });
    if (costCents && costCents > 0) {
      this.#deps.budget?.recordSpend({ workspaceId: ctx.workspaceId, agentId: ctx.agentId, runId, amountCents: costCents });
    }
  }
}

/** Per-turn stage timers accumulated across rounds (CLB instrumentation). */
interface TurnTimings {
  contextMs: number | null;
  firstTokenMs: number | null;
  modelMs: number;
  toolMs: number;
  rounds: number;
  fastPath: boolean;
  adapterType: string;
}

/** Conservative fallback for runtimes that expose no usage lifecycle event. */
function estimateRoundUsage(messages: ChatMessage[], assistantText: string): NonNullable<Extract<ChatDelta, { type: 'done' }>['usage']> {
  const inputChars = messages.reduce((total, message) => total + stringifyChatContent(message.content).length, 0);
  return {
    inputTokens: Math.ceil(inputChars / 4),
    outputTokens: Math.ceil(assistantText.length / 4),
    estimated: true,
  };
}

function stringifyChatContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  try { return JSON.stringify(content); } catch { return ''; }
}

// Per-MODEL-ROUND liveness timeout (ms). This is NOT a task time limit — it
// bounds a single network/stdio call so a dead socket can't hang the turn
// forever. The turn itself has no wall clock: it runs until done, until the
// operator cancels, or until ChatProgressMonitor detects a pathology. A harness
// re-spawns the binary per round, so its single round is inherently slower than a
// streaming runtime's — measured: a slow/free harness model takes ~60–115s to
// first token even for "Hi" and is silent on stdio while the remote model runs.
const INTERACTIVE_MODEL_ROUND_TIMEOUT_MS = 15_000;
const LIGHTWEIGHT_HARNESS_MODEL_ROUND_TIMEOUT_MS = 30_000;
const HARNESS_MODEL_ROUND_TIMEOUT_MS = 240_000;
function harnessRoundTimeoutMs(lightweightConversation = false): number {
  const fromEnv = Number(process.env.AGENTIS_HARNESS_ROUND_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return lightweightConversation ? LIGHTWEIGHT_HARNESS_MODEL_ROUND_TIMEOUT_MS : HARNESS_MODEL_ROUND_TIMEOUT_MS;
}

/**
 * Deadline for the chat preflight health probe. Short so a definitively-down
 * runtime fails fast, but generous enough not to pre-empt a healthy Python
 * harness (Hermes) whose `--version` cold-starts in ~4s and spikes under load —
 * a premature cut just reads as an (ambiguous) timeout. Env-overridable.
 */
function preflightHealthTimeoutMs(): number {
  const fromEnv = Number(process.env.AGENTIS_CHAT_PREFLIGHT_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return 9_000;
}

/** How long a HEALTHY preflight result is reused before re-probing. */
function preflightHealthyTtlMs(): number {
  const fromEnv = Number(process.env.AGENTIS_CHAT_PREFLIGHT_HEALTHY_TTL_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return 15_000;
}

/** How long an UNHEALTHY preflight result is reused before re-probing (short — recovery should be picked up quickly). */
function preflightUnhealthyTtlMs(): number {
  const fromEnv = Number(process.env.AGENTIS_CHAT_PREFLIGHT_UNHEALTHY_TTL_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return 5_000;
}

/**
 * Absolute defensive ceiling on tool rounds in a single turn. This is NOT the
 * governor — ChatProgressMonitor stops real loops far sooner. It exists only so a
 * pathological case the monitor somehow never catches can't spin forever.
 *
 * It MUST be high enough to never clip legitimate long work: a marker-protocol CLI
 * harness (Claude Code / Codex editing files) runs one tool per round, so a real
 * coding task is hundreds of rounds. The old 150 guillotined those mid-task — the
 * exact bug the ProgressMonitor was built to make impossible. Env-overridable via
 * AGENTIS_CHAT_MAX_ROUNDS.
 */
function absoluteMaxRounds(): number {
  const fromEnv = Number(process.env.AGENTIS_CHAT_MAX_ROUNDS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return 2000;
}

function latestUserText(messages: ChatMessage[]): string {
  const message = [...messages].reverse().find((entry) => entry.role === 'user');
  return message ? stringifyChatContent(message.content) : '';
}

const REASONING_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

function reasoningFloor(current: string | undefined, floor: string): string {
  const currentIndex = current ? REASONING_ORDER.indexOf(current as (typeof REASONING_ORDER)[number]) : -1;
  const floorIndex = REASONING_ORDER.indexOf(floor as (typeof REASONING_ORDER)[number]);
  if (currentIndex >= floorIndex) return current!;
  return floor;
}

/**
 * Default per-turn tool-call ceiling — a high count backstop, not a time limit.
 * A marker-protocol harness spends one tool call per round, so this must clear a
 * real multi-step task (build a feature, refactor a repo). The old 80 cut agents
 * off ~step 80 mid-task; the ProgressMonitor — not this number — stops true loops.
 * Env-overridable via AGENTIS_CHAT_MAX_TOOL_CALLS.
 */
function defaultMaxToolCalls(): number {
  const fromEnv = Number(process.env.AGENTIS_CHAT_MAX_TOOL_CALLS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return 2000;
}

/**
 * Max number of dynamic `workflow.<id>` tools advertised per turn. Small on
 * purpose: a large tool list inflates the prompt and slows tool selection on a
 * reasoning model every turn. The viewport's active workflow is always included.
 */
const WORKFLOW_TOOL_CAP = 12;

/** Human labels for the build's WORKFLOW_BUILD_PHASE stages. */
const BUILD_PHASE_LABEL: Record<string, string> = {
  analyzing: 'Analyzing your request',
  drafting: 'Drafting the workflow graph',
  repairing: 'Repairing the graph structure',
  reviewing: 'Reviewing against the workflow rules',
  building: 'Assembling the workflow',
  complete: 'Build complete',
  blocked: 'Build blocked',
};

/**
 * Map one build/canvas bus event onto a chat `activity` delta (phase 'workflow',
 * which the chat renders in its live trace), or null to ignore it. Kept minimal
 * on purpose — phase milestones, the cast roster, each node as it lands, and the
 * final summary — so the chat reads like plain-language progress, not a firehose.
 */
function buildNarrationDelta(
  event: string,
  payload: Record<string, unknown>,
  ctx: ChatTurnContext,
  runId: string,
): Extract<ChatDelta, { type: 'activity' }> | null {
  const workflowId = typeof payload.workflowId === 'string' ? payload.workflowId : undefined;
  const mk = (
    suffix: string,
    label: string,
    detail: string | undefined,
    status: Extract<ChatDelta, { type: 'activity' }>['status'] = 'running',
  ): Extract<ChatDelta, { type: 'activity' }> => ({
    type: 'activity',
    id: `build-${runId}-${suffix}`,
    phase: 'workflow',
    status,
    label,
    ...(detail ? { detail } : {}),
    startedAt: new Date().toISOString(),
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx.clientTurnId ? { clientTurnId: ctx.clientTurnId } : {}),
    ...(workflowId ? { workflowId } : {}),
    runId,
  });

  switch (event) {
    case REALTIME_EVENTS.WORKFLOW_BUILD_PHASE: {
      const phaseName = typeof payload.phase === 'string' ? payload.phase : 'building';
      const label = BUILD_PHASE_LABEL[phaseName] ?? `Build: ${phaseName}`;
      const detail = typeof payload.detail === 'string' ? payload.detail : undefined;
      const status = phaseName === 'complete' ? 'success' : phaseName === 'blocked' ? 'error' : 'running';
      // One row per phase name so repeated emissions of the same phase update in place.
      return mk(`phase-${phaseName}`, label, detail, status);
    }
    case REALTIME_EVENTS.WORKFLOW_TEAM_ROSTER: {
      const roster = Array.isArray(payload.roster) ? payload.roster : [];
      if (roster.length === 0) return null;
      return mk('roster', `Casting ${roster.length} specialist${roster.length === 1 ? '' : 's'}`, undefined);
    }
    case REALTIME_EVENTS.CANVAS_NODE_PLACED: {
      const node = (payload.node ?? {}) as { id?: unknown };
      const nodeId = node.id ? String(node.id) : randomUUID();
      const nodeLabel = typeof payload.nodeLabel === 'string' ? payload.nodeLabel : 'a step';
      const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
      return mk(`node-${nodeId}`, `Placed ${nodeLabel}`, reason);
    }
    case REALTIME_EVENTS.CANVAS_BUILD_COMPLETE: {
      const n = typeof payload.nodeCount === 'number' ? payload.nodeCount : undefined;
      const e = typeof payload.edgeCount === 'number' ? payload.edgeCount : undefined;
      const detail = n !== undefined
        ? `${n} node${n === 1 ? '' : 's'}${e !== undefined ? `, ${e} connection${e === 1 ? '' : 's'}` : ''}`
        : undefined;
      return mk('complete', 'Workflow ready', detail, 'success');
    }
    default:
      return null;
  }
}

/**
 * Per-builder time budget (ms) for the concurrent context retrievers. A builder
 * that exceeds it is dropped from this turn (it keeps running but its result is
 * ignored), so a slow retriever degrades gracefully instead of blocking output.
 */
const CONTEXT_BUILDER_BUDGET_MS = 1200;


/**
 * Whether a message carries enough of a query signal to justify a knowledge-base
 * embedding search. This gates retrieval on information content — not a phrase
 * whitelist — so trivial chatter ("hi", "ok", "?") skips the network round-trip
 * while any substantive request still retrieves.
 */
function hasRetrievalSignal(message: string): boolean {
  const text = message.trim();
  if (text.length < 6) return false;
  const tokens = text.match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  if (tokens.length >= 2) return true;
  return tokens.some((token) => token.length >= 6);
}

/**
 * A deliberately narrow set of turns that can be answered without workspace
 * tools or remote memory enrichment. Full-string matching prevents action
 * requests such as "Hi, build a workflow" from accidentally taking this path.
 */
function isLightweightConversation(message: string): boolean {
  const text = message.trim().toLowerCase().replace(/[!.?]+$/g, '').trim();
  return /^(?:hi|hello|hey|hiya|howdy|good (?:morning|afternoon|evening)|thanks|thank you|thx|ok|okay|got it|who are you|what are you|how are you)$/.test(text);
}

function buildLightweightConversationSystemPrompt(args: {
  context: ChatTurnContext;
  workspaceName?: string | null;
  agentName?: string | null;
  agentRole?: string | null;
  agentDomain?: string | null;
  agentInstructions?: string | null;
  agentIdentity?: string | null;
  channelContext?: { kind: string; from?: string | null; chatId?: string | null; threadId?: string | null; senderSummary?: string | null } | null;
  responseProfile?: string | null;
}): string {
  const role = args.agentRole?.trim() || 'agent';
  const rolePhrase = role === 'agent' ? 'an Agentis agent' : `a ${role} agent`;
  const identityHeader = [
    `You are ${args.agentName ?? 'an Agentis agent'}, ${rolePhrase}${args.agentDomain ? ` for the "${args.agentDomain}" domain` : ''} working inside the Agentis workspace "${args.workspaceName ?? args.context.workspaceId}".`,
    'You are NOT the platform orchestrator. Stay in character: your scope, escalation rules, and operating style come from the authoritative Agentis identity/config below.',
  ].join('\n');
  const identity = [
    identityHeader,
    args.agentIdentity?.trim() || (args.agentInstructions?.trim() ? `Operating instructions:\n${args.agentInstructions.trim()}` : ''),
  ].filter(Boolean).join('\n\n');
  const channel = args.channelContext
    ? [
      `Channel: ${args.channelContext.kind}.`,
      args.channelContext.from ? `From: ${args.channelContext.from}.` : '',
      args.responseProfile?.trim() ?? '',
    ].filter(Boolean).join('\n')
    : null;
  return [
    clampBlock(identity, 4000),
    'This is lightweight social chat. Answer naturally, warmly, and directly in a sentence or two.',
    'Do not narrate platform operations, tool use, or workspace setup unless the operator asks for an action.',
    channel,
  ].map((value) => value?.trim()).filter(Boolean).join('\n\n');
}

/** Honest terminal messages for turns that hit a guardrail instead of a clean stop. */
const TURN_LIMIT_MESSAGE =
  'I worked through several steps but reached the per-turn action limit before finishing. Tell me to continue and I’ll keep going from where I left off.';
const EMPTY_TURN_MESSAGE =
  'The runtime completed without returning an answer. I stopped the turn so you can retry without wondering whether it is still running.';
/** Shown when tools already ran this turn but the runtime's final round returned
 *  no closing answer — so the operator knows real work happened and that a blind
 *  retry may repeat it (relevant for re-spawn/marker-protocol harnesses). */
const DID_WORK_NO_ANSWER_MESSAGE =
  'I ran one or more tools this turn but the runtime didn’t return a closing answer. Check the workspace for what changed before retrying — repeating the request may run those actions again.';
/** Shown when the model reasoned but never surfaced an answer, even after the
 *  recovery retry — honest about what happened instead of blaming the operator. */
const REASONED_NO_ANSWER_MESSAGE =
  'I worked through that but didn’t manage to put my answer into words before running out of room. Tell me to continue and I’ll write it out — or narrow the ask and I’ll be more direct.';
/** Appended on the one-shot recovery pass to coax a reasoning-only turn into
 *  emitting its final answer as normal reply text (and any needed tool calls). */
const REASONING_NUDGE =
  'Write your final answer now as a normal reply, and call any tools you need. Do not return empty content.';
/** Bumped output budget for the recovery retry, so a reasoning model has room to
 *  emit the answer after the original pass exhausted its budget thinking. */
const EMPTY_RETRY_MAX_TOKENS = 4_096;

/**
 * Per-block char budgets for injected context that grows with workspace state.
 * Sum (~12.5KB ≈ ~3K tokens) is the constant ceiling added per turn regardless
 * of how much memory/brain/knowledge has accumulated.
 */
const CONTEXT_BUDGET = {
  agentMemory: 2500,
  personalBrain: 2000,
  workspaceContext: 3500,
  situationalModel: 2500,
  brainInjection: 2000,
  abilityInjection: 4000,
} as const;

/** Truncate an injected context block to a fixed budget so prompt size stays constant. */
function clampBlock(text: string | null, maxChars: number): string | null {
  if (!text || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n…(truncated to keep context size constant)`;
}

function trimHistory(history: ChatMessage[]): ChatMessage[] {
  return history
    .filter((message) => message.role !== 'system')
    .slice(-40);
}

function countUserTurns(history: ChatMessage[]): number {
  return history.filter((message) => message.role === 'user').length;
}

function historyMessageText(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((block) => block.text ?? block.content ?? '')
    .filter(Boolean)
    .join(' ')
    .trim();
}

function workflowIdFromViewport(viewport: ViewportContext | null | undefined): string | undefined {
  if (!viewport) return undefined;
  if (viewport.resourceKind === 'workflow' && viewport.resourceId) return viewport.resourceId;
  if (typeof viewport.metadata?.workflowId === 'string') return viewport.metadata.workflowId;
  return undefined;
}

function expandUserMessage(message: string): string {
  if (!message.startsWith('/')) return message;
  const match = message.match(/^\/(\w+)\s*(.*)$/);
  if (!match) return message;
  const [, command, rest = ''] = match;
  const mapping: Record<string, string> = {
    run: `The operator used /run. Resolve the workflow they mean, then use agentis.workflow.run when safe. Request missing IDs instead of guessing. Request: ${rest}`,
    approve: `The operator used /approve. List pending approvals, identify the intended approval, and only resolve it if the instruction is explicit. Request: ${rest}`,
    approvals: `The operator used /approvals. List the pending approvals with their ids and summaries using tools, then ask which to approve or reject. Request: ${rest}`,
    status: `The operator used /status. Summarize current runs, agents, gateways, and approvals using tools. Request: ${rest}`,
    agents: `The operator used /agents. List the workspace agents — name, role, status, and what each is for — using tools. Request: ${rest}`,
    runs: `The operator used /runs. Summarize the active and most recent workflow runs with their status using tools. Request: ${rest}`,
    stop: `The operator used /stop. Identify the most recent active run and, only after confirming, cancel it with agentis.run.cancel. Request: ${rest}`,
    history: `The operator used /history. Query recent runs and audit trails relevant to: ${rest}`,
    help: 'The operator used /help. Briefly explain what the Agentis orchestrator can do through chat.',
  };
  return mapping[command?.toLowerCase() ?? ''] ?? message;
}

/**
 * A human label for a tool-activity card. Platform verbs read naturally
 * (`agentis.workflow.run` → "workflow run"); a dynamic `workflow.<id>` tool is
 * just "run workflow" since the id is meaningless to the operator.
 */
function prettyToolLabel(name: string): string {
  if (name.startsWith('workflow.')) return 'run workflow';
  return name.replace(/^agentis\./, '').replace(/[._]/g, ' ').trim() || name;
}

/**
 * The chat transcript is a narrative, not a terminal. Keep routine discovery
 * calls out of it and give consequential actions a concrete operator-facing
 * label. The raw tool identity remains available in the durable event ledger.
 */
function isBackgroundChatTool(name: string): boolean {
  return [
    'agentis.orient',
    'agentis.command.review',
    'agentis.run.query',
    'agentis.workflow.loop.status',
    'agentis.data.query',
    'agentis.canvas.context',
  ].includes(name);
}

function chatToolIntentCommentary(name: string): string | null {
  const intent: Record<string, string> = {
    'agentis.workflow.loop.status': 'Checking the latest workflow state to locate where new results stop appearing.',
    'agentis.run.query': 'Reviewing recent runs to identify the concrete failure or stale result.',
    'agentis.data.query': 'Checking the saved records before deciding whether the issue is data or workflow logic.',
    'agentis.command.review': 'Reviewing the current workspace state before changing anything.',
    'agentis.capability.search': 'Finding the exact workspace capability needed for the next step.',
    'agentis.capability.load': 'Loading the selected capability details before using it.',
    'agentis.capability.invoke': 'Handing the focused subtask to the selected specialist.',
    'agentis.workflow.run': 'Starting the selected workflow and following its result.',
  };
  return intent[name] ?? null;
}

function chatToolProgressLabel(verb: 'Using' | 'Used' | 'Failed', name: string, args: unknown): string {
  const done = verb === 'Used';
  const failed = verb === 'Failed';
  const labels: Record<string, { running: string; done: string; failed: string }> = {
    'agentis.capability.search': { running: 'Searching the workspace for the right capability', done: 'Found matching workspace capabilities', failed: 'Could not search workspace capabilities' },
    'agentis.capability.load': { running: 'Loading the selected capability details', done: 'Loaded capability details', failed: 'Could not load capability details' },
    'agentis.capability.invoke': { running: 'Handing the focused task to the selected specialist', done: 'Specialist work returned', failed: 'Specialist work could not start' },
    'agentis.workflow.run': { running: 'Starting the selected workflow', done: 'Workflow started', failed: 'Workflow could not start' },
    'agentis.run.cancel': { running: 'Stopping the selected run', done: 'Run stopped', failed: 'Run could not be stopped' },
    'agentis.build_workflow': { running: 'Building the workflow', done: 'Workflow build finished', failed: 'Workflow build failed' },
    'agentis.team.spawn': { running: 'Starting the temporary team', done: 'Team work returned', failed: 'Team could not start' },
  };
  const mapped = labels[name];
  if (mapped) return failed ? mapped.failed : done ? mapped.done : mapped.running;
  return toolActivityLabel(verb, prettyToolLabel(name), args);
}

function summarizeToolResult(value: unknown): unknown {
  const text = typeof value === 'string' ? value : safeJson(value);
  if (text.length <= 2000) return value;
  return {
    summary: text.slice(0, 1800),
    truncated: true,
    originalLength: text.length,
  };
}

function confirmationTitle(toolName: string): string {
  const titles: Record<string, string> = {
    'agentis.workflow.run': 'Run workflow?',
    'agentis.run.cancel': 'Cancel run?',
    'agentis.approval.resolve': 'Resolve approval?',
    'agentis.ephemeral.run': 'Run ephemeral workflow?',
  };
  return titles[toolName] ?? 'Confirm platform action?';
}

function confirmationConfirmLabel(toolName: string): string {
  const labels: Record<string, string> = {
    'agentis.workflow.run': 'Run workflow',
    'agentis.run.cancel': 'Cancel run',
    'agentis.approval.resolve': 'Resolve approval',
    'agentis.ephemeral.run': 'Run once',
  };
  return labels[toolName] ?? 'Confirm';
}

function confirmationImpact(toolName: string, args: unknown, fallbackDescription?: string, db?: AgentisSqliteDb): {
  summary: string;
  details: string[];
  riskLevel: 'low' | 'medium' | 'high' | 'danger';
  reversible: boolean;
  externalSideEffects: boolean;
} {
  const record = recordFromUnknown(args);
  const details: string[] = [];
  const workflowId = stringFrom(record.workflowId);
  const runId = stringFrom(record.runId);
  const approvalId = stringFrom(record.approvalId);
  const decision = stringFrom(record.decision);
  const dynamicWorkflowId = toolName.startsWith('workflow.') ? toolName.slice('workflow.'.length) : null;

  if (workflowId || dynamicWorkflowId) details.push(`Workflow: ${workflowId ?? dynamicWorkflowId}`);
  if (runId) details.push(`Run: ${runId}`);
  if (approvalId) details.push(`Approval: ${approvalId}`);
  if (decision) details.push(`Decision: ${decision}`);

  if (toolName === 'agentis.memory.delete') {
    const id = record.id ? String(record.id) : null;
    let memoryTitle = 'Unknown memory';
    let memoryContent = '';
    if (id && db) {
      try {
        // §B4 — typed memory lives in the episode substrate.
        const mem = db.select().from(schema.memoryEpisodes).where(eq(schema.memoryEpisodes.id, id)).get();
        if (mem) {
          memoryTitle = mem.title;
          memoryContent = mem.summary;
        }
      } catch (err) {
        // ignore db error
      }
    }
    return {
      summary: `Delete memory entry: "${memoryTitle}"`,
      details: [
        `Memory ID: ${id}`,
        ...(memoryContent ? [`Content: "${memoryContent.length > 100 ? memoryContent.slice(0, 100) + '...' : memoryContent}"`] : []),
      ],
      riskLevel: 'medium',
      reversible: false,
      externalSideEffects: false,
    };
  }

  if (toolName === 'agentis.memory.write') {
    const title = stringFrom(record.title) ?? 'Untitled memory';
    const content = stringFrom(record.content) ?? '';
    const kind = stringFrom(record.kind) ?? 'fact';
    return {
      summary: `Create workspace memory: "${title}"`,
      details: [
        `Kind: ${kind}`,
        ...(content ? [`Content: "${content.length > 100 ? content.slice(0, 100) + '...' : content}"`] : []),
      ],
      riskLevel: 'low',
      reversible: true,
      externalSideEffects: false,
    };
  }

  if (toolName === 'agentis.knowledge.archive') {
    const documentId = record.documentId ? String(record.documentId) : null;
    let docName = 'Unknown document';
    if (documentId && db) {
      try {
        const doc = db.select().from(schema.kbDocuments).where(eq(schema.kbDocuments.id, documentId)).get();
        if (doc) {
          docName = doc.name;
        }
      } catch (err) {
        // ignore db error
      }
    }
    return {
      summary: `Archive knowledge document: "${docName}"`,
      details: [
        `Document ID: ${documentId}`,
      ],
      riskLevel: 'medium',
      reversible: true,
      externalSideEffects: false,
    };
  }

  if (toolName === 'agentis.knowledge.delete') {
    const documentIds = Array.isArray(record.documentIds) ? record.documentIds.map(String) : [];
    return {
      summary: `Permanently delete ${documentIds.length} knowledge document${documentIds.length === 1 ? '' : 's'}`,
      details: [
        `Knowledge base ID: ${stringFrom(record.knowledgeBaseId) ?? 'Unknown'}`,
        ...documentIds.slice(0, 20).map((id) => `Document ID: ${id}`),
        ...(documentIds.length > 20 ? [`And ${documentIds.length - 20} more documents`] : []),
      ],
      riskLevel: 'high',
      reversible: false,
      externalSideEffects: false,
    };
  }

  if (toolName === 'agentis.knowledge_base.delete') {
    return {
      summary: 'Permanently delete an entire knowledge base',
      details: [`Knowledge base ID: ${stringFrom(record.knowledgeBaseId) ?? 'Unknown'}`],
      riskLevel: 'high',
      reversible: false,
      externalSideEffects: false,
    };
  }

  if (toolName === 'agentis.knowledge.write') {
    const name = stringFrom(record.name) ?? 'Untitled document';
    return {
      summary: `Upload/write knowledge document: "${name}"`,
      details: [
        `Mime Type: ${stringFrom(record.mimeType) ?? 'text/plain'}`,
      ],
      riskLevel: 'low',
      reversible: true,
      externalSideEffects: false,
    };
  }

  if (toolName === 'agentis.workflow.run' || toolName.startsWith('workflow.')) {
    return {
      summary: 'This will start a real workflow run in the current workspace.',
      details: [
        ...details,
        'The workflow may execute agents, extensions, integrations, or checkpoints depending on its graph.',
      ],
      riskLevel: 'medium',
      reversible: false,
      externalSideEffects: true,
    };
  }

  if (toolName === 'agentis.ephemeral.run') {
    return {
      summary: 'This will execute a temporary workflow graph once without saving it first.',
      details: [
        ...details,
        'Any side effects inside the graph still happen during the run.',
      ],
      riskLevel: 'medium',
      reversible: false,
      externalSideEffects: true,
    };
  }

  if (toolName === 'agentis.run.cancel') {
    return {
      summary: 'This will stop an active workflow run and mark unfinished nodes as cancelled.',
      details,
      riskLevel: 'high',
      reversible: false,
      externalSideEffects: false,
    };
  }

  if (toolName === 'agentis.approval.resolve') {
    return {
      summary: `This will ${decision === 'reject' ? 'reject' : 'approve'} a pending human approval.`,
      details: [
        ...details,
        'The waiting workflow may immediately continue or stop based on this decision.',
      ],
      riskLevel: decision === 'reject' ? 'danger' : 'high',
      reversible: false,
      externalSideEffects: true,
    };
  }

  return {
    summary: fallbackDescription ?? 'This action changes platform state.',
    details,
    riskLevel: 'medium',
    reversible: false,
    externalSideEffects: false,
  };
}

function cliSessionKey(
  conversationId: string | null | undefined,
  forwarding: unknown,
  checksum: string | null,
): string | null | undefined {
  return forwarding === 'marker_protocol' || forwarding === 'mcp_native'
    ? chatSessionKeyWithIdentity(conversationId, checksum)
    : conversationId;
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringFrom(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
