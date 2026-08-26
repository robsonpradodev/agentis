/**
 * Workflow Engine.
 *
 * Owns the run lifecycle. BullMQ (or in-process queue) is plumbing for
 * durability and delayed wake-ups; the engine owns:
 *   - run-state transitions
 *   - the deterministic ready queue
 *   - multi-input buffering (waitingInputs)
 *   - dispatch to extensions/agents/subflows/routers
 *   - ledger writes
 *   - snapshot cadence
 *   - completion / failure / cancellation
 *
 * V1 scope: full happy path for extension_task and trigger nodes; agent_task
 * dispatches through AdapterManager but completion arrives async via
 * `notifyTaskCompleted()`/`notifyTaskFailed()`. Router/merge/checkpoint/
 * subflow/scratchpad nodes are scaffolded with their happy-path semantics
 * and are exercised by the dashboard. Replay paths are implemented at the
 * level the spec demands but not all branches have e2e tests yet
 * (DEBT in DECISIONS.md).
 */

import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import {
  CONSTANTS,
  AgentisError,
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowRunState,
  type WorkflowRunStatus,
  type WorkflowSelfHealIncident,
  type WorkflowNodeContractDeviation,
  type ReadyQueueItem,
  type ExtensionTaskNodeConfig,
  type ComponentTaskNodeConfig,
  type AgentTaskNodeConfig,
  type KnowledgeNodeConfig,
  type KnowledgeIngestNodeConfig,
  type RouterNodeConfig,
  type MergeNodeConfig,
  type CheckpointNodeConfig,
  type HumanInputNodeConfig,
  type ScratchpadNodeConfig,
  type AgentSwarmNodeConfig,
  type ArtifactCollectNodeConfig,
  type WaitNodeConfig,
  type TransformNodeConfig,
  type FilterNodeConfig,
  type IntegrationNodeConfig,
  type McpNodeConfig,
  type ChannelSendNodeConfig,
  type DataQueryNodeConfig,
  type DataMutateNodeConfig,
  type AggregateWindowNodeConfig,
  type HttpRequestNodeConfig,
  type WorkflowStoreNodeConfig,
  type WorkspaceStoreNodeConfig,
  type EvaluatorNodeConfig,
  type GuardrailsNodeConfig,
  type LoopNodeConfig,
  type ConvergeNodeConfig,
  type PursueNodeConfig,
  type ParallelNodeConfig,
  type ReturnOutputNodeConfig,
  type ArtifactSaveNodeConfig,
  type BrowserNodeConfig,
  type AgentSessionNodeConfig,
  type DynamicSwarmNodeConfig,
  type PlannerNodeConfig,
  type StopErrorNodeConfig,
  type CodeNodeConfig,
  type SpreadsheetNodeConfig,
  type GraphQlNodeConfig,
  type WorkflowEdge,
  type WorkflowGraphPatch,
  type WorkflowRecoveryMode,
  type WorkflowRecoveryTier,
  type AgentRole,
  type AgentTool,
  type AgentRequirements,
  type AgentAdapter,
  type ChatDelta,
  type ToolDefinition,
  type SpecialistDefinition,
  agentSatisfiesRequirements as adapterSatisfiesRequirements,
  describeAgentRequirements,
  hasAgentRequirements,
  requiredAffordanceKeys,
  runtimeRequirementsFromAgentRequirements,
  affordanceLabel,
  type AgentAffordance,
  specialistForRole,
  genericSpecialist,
  roleTools,
  effectiveSpecialistTools,
  DEFAULT_SPECIALIST_TOOLS,
  normalizeRole,
  isAgentRole,
  buildNodeAliasMap,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { EventBus } from '../event-bus.js';
import type { LedgerService } from '../services/ledger.js';
import type { ScratchpadService } from '../services/scratchpad.js';
import type { ActivityFeedService } from '../services/activityFeed.js';
import type { ApprovalInboxService } from '../services/approvalInbox.js';
import type { ExtensionRuntime } from '../services/extensionRuntime.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import type { WorktreeManager, WorktreeHandle } from '../services/worktreeManager.js';
import type { SubflowExecutor } from '../services/subflowExecutor.js';
import type { KnowledgeBaseService } from '../services/knowledge/knowledgeBase.js';
import type { ConversationStore } from '../services/conversation/conversationStore.js';
import type { ChannelSendPort } from '../services/conversation/channelSend.js';
import { buildIntegrationDeliveryReceipt, manifestHttpConnector, type ConnectorRegistry } from '@agentis/integrations';
import type { WorkflowStoreService } from '../services/workflow/workflowStore.js';
import type { WorkspaceStoreService } from '../services/workspace/workspaceStore.js';
import type { EvaluationRuntime } from '../services/structuredEvaluatorRuntime.js';
import { StructuredEvaluatorRuntime } from '../services/structuredEvaluatorRuntime.js';
import { AdapterStructuredCompleter, FallbackStructuredCompleter, type StructuredCompleter } from '../services/structuredCompleter.js';
import { WorkflowSelfHealService, type IntentAnchor, type RepairResourceContext, type DeepPlanArgs, type DeepPlanResult } from '../services/workflow/workflowSelfHeal.js';
import { getSelfHealConfig, type SelfHealConfig } from '../services/selfHealSettings.js';
import { selfHealGuardDecision } from '../services/workflow/workflowBlueprint.js';
import {
  evaluateEvolution,
  summarizeContract,
  resolveEvolutionAuthority,
  firstOutwardNode,
  type EvolveResult,
  type EvolutionRegression,
} from '../services/atomicEvolution.js';
import { type IntentManifest } from '../services/intentContract.js';
import { graphContentHash, stampBuildLoop, readBuildLoop, type BuildLoopOutcomeHealth } from '../services/workflow/workflowCompass.js';
import { readWorkflowSpec, type WorkflowSpec } from '../services/workflow/workflowSpec.js';
import { evaluateRunVerdict, terminalOutputPaths, unwrapReturnEnvelope, type RunVerdict, type VerdictProbeDeps } from '../services/workflow/workflowVerdict.js';
import { buildRunSettlement } from '../services/workflow/runOutcome.js';
import { decideRecoveryPolicy, recoveryFailureFingerprint, recoveryTierForPlan, repairPlanFingerprint } from '../services/workflow/workflowRecoveryPolicy.js';
import { composeOperatingManual, getWorkspaceManual } from '../services/agent/agentOperatingManual.js';
import { loadAgentIdentitySnapshot, renderAgentIdentityBlock } from '../services/agent/agentIdentity.js';
import { parseGeneric } from '../services/evaluatorRuntime.js';
import type { CredentialVault } from '../services/credentialVault.js';
import type { WorkspaceIntelligenceService } from '../services/workspace/workspaceIntelligence.js';
import type { BrowserPool } from '../services/browserPool.js';
import type { BrowserSessionManager } from '../services/browser/browserSessionManager.js';
import type { SpecialistAgentService } from '../services/specialist/specialistAgents.js';
import { resolveResponsibleSpecialist } from '../services/responsibleSpecialist.js';
import type { SpecialistProfileService } from '../services/specialist/specialistProfileService.js';
import type { SpecialistRuntimeService } from '../services/specialist/specialistRuntimeService.js';
import type { AuditTrailService } from '../services/auditTrail.js';
import type { InstinctEngine } from '../services/instinctEngine.js';
import type { RunSettledInput } from '../services/app/appLearning.js';
import type { AgentToolRuntime } from '../services/agent/agentToolRuntime.js';
import { AgentToolLoop, type StructuredLlm } from '../services/agent/agentToolLoop.js';
import type { AgentisToolRegistry } from '../services/agentisToolRegistry.js';
import { ChatSessionExecutor } from '../services/chat/chatSessionExecutor.js';
import { isSensitiveFieldName, redactSecretString } from '../services/security/secretRedaction.js';
import type { AgentSessionService } from '../services/agent/agentSession.js';
import { estimateTokens } from '../services/agent/agentSession.js';
import type { AgentSessionRuntime, SessionRunContext, SessionOutcome, SessionYield } from '../services/agent/agentSessionRuntime.js';
import { waitForAllRunsSettle, summarizeFanIn } from '../services/run/runSettle.js';
import { attenuateGrant } from '../services/agent/agentSessionRuntime.js';
import type { PlanService } from '../services/planService.js';
import type { AgentMemoryService } from '../services/agent/agentMemory.js';
import type { PersonalBrainService } from '../services/personalBrain.js';
import type { FailureReflectionService } from '../services/failureReflection.js';
import { FeynmanReflectionService, REPEAT_FAILURE_THRESHOLD, type FeynmanTrigger } from '../services/feynmanReflection.js';
import type { SpecialistMindService } from '../services/specialist/specialistMindService.js';
import type { EmbeddingProvider } from '../services/embedding/embeddingProvider.js';
import { embedText as embedTextHelper } from '../services/embedding/embeddingProvider.js';
import type { SharedIntelligenceService } from '../services/sharedIntelligence.js';
import type { CognitivePromotionQueueWorker } from '../services/cognitivePromotionQueueWorker.js';
import { resolveMemoryPolicy } from '../services/memory/memoryPolicyResolver.js';
import type { PeerProfileService } from '../services/peerProfileService.js';
import { evalCondition } from './SafeConditionParser.js';
import { validateWorkflowGraph } from './validateGraph.js';
import { noopTelemetry, type Telemetry } from '../telemetry/index.js';
import { buildTemplateContext, resolveTemplate, resolveTemplateDeep, readTemplatePath, type TemplateContext } from './templateResolver.js';
import { readDotPath } from './dotPath.js';
import { NodeExecutorController, type NodeExecutorHost } from './executors/nodeExecutors.js';
import { SelfHealController, type SelfHealHost } from './selfHeal/selfHealController.js';
import {
  isRuntimeBindingFailure,
  isSelfHealableNode,
  declaredOutputKeys,
  graphDiffPatch,
  stringValue,
  toolInputSchemaToChatParameters,
} from './selfHeal/selfHealHelpers.js';
export { capabilityGapReason } from './selfHeal/selfHealHelpers.js';
import { sleep, backoffMs, redactUrl, asString } from './executorHelpers.js';
import { ConvergeLoopController, type LoopEngineHost } from './convergeLoop.js';
import { nodeIdempotencyKey } from './idempotency.js';
import { toPersistedRunState } from './runStatePersistence.js';
import { NodeHandlerRegistry, type PureNodeHandler } from './handlers/NodeHandler.js';
import { registerPureNodeHandlers } from './handlers/pureHandlers.js';
import { registerUtilityNodeHandlers } from './handlers/utilityHandlers.js';
import { evaluateExpression, evaluateBooleanExpression } from './safeExpression.js';
import { repairExpressionReferences } from './validateExpressions.js';
import { assertSafeUrl } from '../services/safeUrl.js';
import { normalizeWorkflowGraph } from '../services/workflow/workflowGraphNormalization.js';
import { getCustomIntegrationManifest } from '../services/integrationRegistry.js';
import { routeModelForTask } from '../services/modelRoutingPolicy.js';
import { artifactPolicyFromUnknown } from '../services/artifactRetentionPolicy.js';
import type { WorkflowRevisionService } from '../services/workflow/workflowRevisionService.js';
import type { WorkflowExperienceService } from '../services/workflow/workflowExperienceService.js';
import { classifyWorkflowFailure, workflowFailureFingerprint } from '../services/workflow/workflowFailureClassification.js';

export interface EngineDeps {
  db: AgentisSqliteDb;
  bus: EventBus;
  logger: Logger;
  ledger: LedgerService;
  scratchpad: ScratchpadService;
  activity: ActivityFeedService;
  approvals: ApprovalInboxService;
  /** Immutable active/candidate workflow revision authority. */
  revisions?: WorkflowRevisionService;
  /** Evidence-backed workflow/app/role experience ledger. */
  workflowExperience?: WorkflowExperienceService;
  extensions: ExtensionRuntime;
  adapters: AdapterManager;
  subflows?: SubflowExecutor;
  knowledgeBases?: KnowledgeBaseService;
  /** Conversation bridge — lets chat-started runs report terminal state back to the thread. */
  conversations?: ConversationStore;
  /** Integration connector registry — required for `integration` and `http_request` nodes. */
  connectors?: ConnectorRegistry;
  /** Registered MCP servers' tools, callable from an `mcp` node (masterplan 2.3). */
  mcpBridge?: McpBridgePort;
  /**
   * The capability plane — used here only to inject the resident "mounted
   * connections" block (live MCP servers + credentialed integrations) into the
   * agent_task dispatch prompt, so a task agent knows the same connected surface a
   * chat agent does. Structurally typed to avoid a hard dependency on the service.
   */
  capabilityIndex?: { mountedConnectionsBlock(workspaceId: string): Promise<string>; manifestBlock(workspaceId: string): string };
  /** Scoped command briefing parity for workflow-bound agents. */
  commandModel?: { briefingBlock(workspaceId: string, agentId: string): string };
  /** Native channel send — required for the deterministic `channel` node. */
  channelSend?: ChannelSendPort;
  /** Agentic App datastore access for the `data_query` / `data_mutate` nodes. */
  appData?: AppDataPort;
  /** Resolve the owning App id from the running workflow when a data node omits `appId`. */
  resolveAppIdForWorkflow?: (workspaceId: string, workflowId: string) => string | undefined;
  /** Workflow-scoped KV — required for `workflow_store` nodes. */
  workflowStore?: WorkflowStoreService;
  /** Workspace-scoped KV (Tier 3) — required for `workspace_store` nodes + `{{workspace.kv.*}}`. */
  workspaceStore?: WorkspaceStoreService;
  /** Dedicated LLM-as-judge runtime. Live agent adapters are used as a fallback. */
  evaluatorRuntime?: EvaluationRuntime;
  /**
   * Optional per-workspace evaluator resolution (OMNICHANNEL §4.4 model overrides).
   * When set, `evaluator`/`router` nodes honor a workspace's evaluation-role model;
   * falls back to `evaluatorRuntime`.
   */
  resolveEvaluatorRuntime?: (
    workspaceId: string,
    role: 'synthesis' | 'evaluation',
    hint?: { task?: string | null; purpose?: string | null; explicitModel?: string | null },
  ) => EvaluationRuntime | undefined;
  /**
   * LAYER 0 (immersive-realtime): mint a real, model-backed runtime for an agent
   * that has no explicitly configured adapter — so `agent_task` always runs on a
   * working brain (the workspace's default model) instead of a dead `offline`
   * http stub. Bound to the agent's id so its thoughts/tool-calls attribute
   * correctly. Returns undefined only when NO model is configured at all.
   */
  resolveAgentRuntime?: (workspaceId: string, agentId: string, task?: string | null, explicitModel?: string | null) => AgentAdapter | undefined;
  modelAssistedRuntimeEnabled?: (workspaceId: string) => boolean;
  /** Credential vault — required for `integration` nodes that need decrypted credentials. */
  vault?: CredentialVault;
  /** Workspace Intelligence - injects operator-authored workspace docs into agent prompts. */
  workspaceIntelligence?: WorkspaceIntelligenceService;
  /** Native Playwright runtime — required for `browser` nodes. */
  browserPool?: BrowserPool;
  /** Persistent browser sessions — closed per run at settle so no session outlives its run. */
  browserSessions?: BrowserSessionManager;
  /** Specialist agent library — resolves `agent_task.agentRole` → agentId (Layer 2). */
  specialists?: SpecialistAgentService;
  specialistProfiles?: SpecialistProfileService;
  specialistRuntime?: SpecialistRuntimeService;
  /** Full per-run audit trail (§5.4). Best-effort; never blocks a run. */
  audit?: AuditTrailService;
  /** Self-improvement: analyzes failed runs for repeat patterns (§7.2). */
  instincts?: InstinctEngine;
  /**
   * Deposits every terminal run's graded outcome as a durable atom in the brain
   * scope that OWNS the run (the App, else the workflow). Without this the only
   * writer into those scopes is run-output mining, which stages everything as
   * `unconsolidated` — hidden from the graph — and only fires on agent nodes, so a
   * deterministic App could run forever and its Brain map would stay empty.
   */
  appBrain?: { onRunSettled(input: RunSettledInput): Promise<unknown> };
  /** SWIFT-T: fired when a hardened workflow regresses (production verdict not
   *  accomplished) — bootstrap wires this to pause unattended triggers. */
  onWorkflowDemoted?: (args: { workspaceId: string; workflowId: string; runId: string; verdict: RunVerdict }) => void;
  /** Role-scoped tool execution (§2.2.1) — consumed by the agentic tool-use loop. */
  agentTools?: AgentToolRuntime;
  /** Agent-scoped personal memory (§G11) — injected into each dispatched agent's preamble. */
  agentMemory?: AgentMemoryService;
  /** Operator-owned notes shared with an agent only after an explicit grant. */
  personalBrain?: PersonalBrainService;
  /** Records deterministic failure lessons into the responsible agent's memory. */
  failureReflection?: FailureReflectionService;
  /** Phase 4 — queued, grounded Feynman repair loop for stubborn failures. */
  feynmanReflection?: FeynmanReflectionService;
  /** Phase 2 - specialist-specific mind context (sources, atoms, visual patterns). */
  specialistMind?: SpecialistMindService;
  /** Canonical shared brain graph retrieval and evaluator feedback. */
  sharedIntelligence?: SharedIntelligenceService;
  /**
   * Real accumulated spend for a run AND its descendant subflow runs — recorded
   * cost (cents) + model tokens. Drives the `converge` node's budget breaker
   * (AGENT-COOPERATION-10X §Pillar 1). Absent → only ms + the ceiling enforce.
   */
  resolveRunSpend?: (rootRunId: string) => { costCents: number; tokens: number };
  /**
   * Learn from a node failure (COGNITIVE-LOOPING — "fail-forward, don't dead-end").
   * The engine emits every hard node failure; the wiring classifies instructive
   * failures (guard/precondition/validation/contract) and records a workspace
   * playbook lesson that `build_workflow` already recalls, so the NEXT build
   * designs the corrective loop instead of repeating the dead-end. Non-throwing.
   */
  recordFailureLesson?: (args: {
    workspaceId: string;
    workflowId: string;
    nodeId: string;
    nodeTitle: string;
    error: string;
    agentId: string | null;
  }) => void;
  /** Autonomous, intent-preserving workflow self-healing (AGENT-AUTONOMY §W7/W5.0). */
  selfHeal?: WorkflowSelfHealService;
  /**
   * The full agent tool registry (the same surface chat uses) — build/create
   * extensions, abilities, agents, workflows. Drives the self-heal deep replan so
   * the orchestrator has FULL creation power, not just read-only discovery.
   */
  toolRegistry?: AgentisToolRegistry;
  /** Durable promotion queue for successful workflow outputs. */
  brainQueue?: CognitivePromotionQueueWorker;
  /** User/agent peer-card context learned from chat and sessions. */
  peerProfiles?: PeerProfileService;
  /** Persistent agent-session store — required for `agent_session`/`planner`/`dynamic_swarm` nodes + `agent_task.useSession`. */
  sessions?: AgentSessionService;
  /** The session cognitive loop (THINK→EXECUTE→DECIDE) — paired with `sessions`. */
  sessionRuntime?: AgentSessionRuntime;
  /** Durable task spine above conversations/runs; executors only report into it. */
  plans?: PlanService;
  /**
   * Scored, explainable specialist selection (SPECIALISTS-10X §Demand Router).
   * When an `agent_task` is underspecified (no explicit agent and only a generic
   * role), the engine consults the router so selection is scored + recorded
   * instead of a bare `specialist` fallback. Narrow port over
   * `SpecialistDemandRouter` to keep the engine decoupled.
   */
  specialistRouter?: SpecialistRouterPort;
  /**
   * Per-task filesystem isolation for parallel agents. When present, the engine
   * allocates an isolated working directory for each swarm subtask so concurrent
   * agents never share one checkout. Absent = no isolation (single-agent default
   * behavior; subtasks fall back to the adapter's configured cwd).
   */
  worktrees?: WorktreeManager;
  /** Optional tracer; defaults to a no-op so tests stay free of OTel deps. */
  telemetry?: Telemetry;
}

/**
 * Narrow structural port over `SpecialistDemandRouter.request` so the engine can
 * consult it for scored role selection without importing the concrete service.
 */
/** Narrow port over McpToolBridge.call so the engine stays decoupled from it. */
export interface McpBridgePort {
  call(workspaceId: string, toolId: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

/** Narrow port over AppDatastore for the `data_query` / `data_mutate` nodes. */
export interface AppDataPort {
  query(workspaceId: string, appId: string, collection: string, q: { filter?: Record<string, unknown>; sort?: Array<{ field: string; dir: 'asc' | 'desc' }>; limit?: number; cursor?: string }): { rows: unknown[]; nextCursor?: string };
  aggregate(workspaceId: string, appId: string, collection: string, input: { op: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string; groupBy?: string; filter?: Record<string, unknown>; limit?: number }): Array<{ group: string | number | null; value: number }>;
  insert(workspaceId: string, appId: string, collection: string, record: Record<string, unknown>): { id: string };
  update(workspaceId: string, appId: string, collection: string, id: string, patch: Record<string, unknown>): { id: string };
  upsert(workspaceId: string, appId: string, collection: string, match: Record<string, unknown>, record: Record<string, unknown>): { id: string };
  mutateMany(workspaceId: string, appId: string, collection: string, operation: 'insert' | 'upsert', records: Record<string, unknown>[], matchFields?: string[]): Array<{ id: string; data?: Record<string, unknown> }>;
  delete(workspaceId: string, appId: string, collection: string, id: string): void;
  getRecord(workspaceId: string, appId: string, collection: string, id: string): { id: string; data?: Record<string, unknown> };
}

export interface SpecialistRouterPort {
  request(
    workspaceId: string,
    userId: string,
    input: {
      task: string;
      callerAgentId?: string | null;
      workflowId?: string | null;
      runId?: string | null;
      materialize?: boolean;
      createRun?: boolean;
    },
  ): Promise<{
    selectedRole: string;
    selectedAgentId: string | null;
    explanation: string;
    traceId: string;
    topology: string;
    score: number;
  }>;
}

export type SelfHealEngineResult =
  | { kind: 'output_fixed'; output: Record<string, unknown> }
  | { kind: 'structural_applied' }
  | { kind: 'awaiting_approval' }
  | { kind: 'none'; reason?: string; diagnosis?: string };

export interface StartRunArgs {
  workspaceId: string;
  ambientId: string | null;
  conversationId?: string | null;
  workflowId: string;
  planId?: string | null;
  userId: string;
  triggerId: string | null;
  inputs: Record<string, unknown>;
  initialState: WorkflowRunState;
  graph: WorkflowGraph;
  /** Exact immutable revision whose graph is being executed. */
  workflowRevisionId?: string | null;
  /** P1.2: when true, suppress self-heal + fallback recovery so a debugging agent
   *  observes the RAW per-node failure. For test/debug runs, not production. */
  debugRun?: boolean;
}

export interface RunHandle {
  runId: string;
  workflowId: string;
}

export class WorkflowEngine {
  /** In-flight run-state cache keyed by runId. */
  readonly #runs = new Map<string, RunningContext>();
  /** P1.2: runIds started in debug/test mode — self-heal + fallback recovery are
   *  suppressed so an agent debugging a build sees the RAW failure, not a heal. */
  readonly #debugRuns = new Set<string>();
  /**
   * LAYER 1 (immersive-realtime): a capped, in-memory replayable activity tail per
   * run — every node step, agent thought, tool call, and status change as a
   * RealtimeEnvelope. Lets a surface opened mid-run BACK-FILL recent history via
   * `getRunActivity(runId)` (GET /v1/runs/:id/activity) and then stream live, so it
   * never shows "EVENTS 0". Dropped when the run leaves memory.
   */
  readonly #runActivity = new Map<string, RunActivityEnvelope[]>();
  /**
   * Coalesced run_state persistence. Best-effort mid-run checkpoints
   * (`#schedulePersist`) collapse into at most one write per run per
   * RUN_STATE_PERSIST_DEBOUNCE_MS window — a growing multi-MB blob rewritten
   * synchronously on every node transition was stalling the event loop. Keyed
   * by runId: `#persistTimers` holds the pending flush timer, `#pendingPersist`
   * the latest context to write. Boundary writes (`#persistRun`,
   * `#transitionRunStatus`) cancel any pending flush so a stale trailing write
   * can never clobber a durable one.
   */
  readonly #persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #pendingPersist = new Map<string, RunningContext>();
  readonly #telemetry: Telemetry;
  /** Decomposition seam (NATIVE-ADVANCEMENT Proposal 4): pure node kinds resolve here, not in the dispatch switch. */
  readonly #nodeHandlers = new NodeHandlerRegistry();
  /** Agentic looping (loop / converge / pursue) lives in its own controller (Phase A extraction). */
  readonly #convergeLoop: ConvergeLoopController;
  /** Node-kind executors live in their own controller (Phase A extraction). */
  readonly #executors: NodeExecutorController;
  /** Self-heal / recovery subsystem in its own controller (Phase A extraction). */
  readonly #selfHeal: SelfHealController;

  constructor(private readonly deps: EngineDeps) {
    this.#telemetry = deps.telemetry ?? noopTelemetry;
    registerPureNodeHandlers(this.#nodeHandlers);
    registerUtilityNodeHandlers(this.#nodeHandlers);
    this.#convergeLoop = new ConvergeLoopController({
      deps: this.deps,
      startRun: (args) => this.startRun(args),
      completeNode: (ctx, nodeId, output) => this.#completeNode(ctx, nodeId, output),
      failNode: (ctx, nodeId, error) => this.#failNode(ctx, nodeId, error),
      tick: (ctx) => this.#tick(ctx),
      persistRun: (ctx) => this.#persistRun(ctx),
      buildConditionScope: (ctx, data) => this.#buildConditionScope(ctx, data),
      specForRun: (ctx) => this.#specForRun(ctx),
      verdictProbeDeps: (ctx, spec) => this.#verdictProbeDeps(ctx, spec),
      resolveEvaluationRuntime: (ctx, node, targetPath) => this.#resolveEvaluationRuntime(ctx, node, targetPath),
      recordEvaluationTokens: (ctx, nodeId, usage, agentId) => this.#recordEvaluationTokens(ctx, nodeId, usage, agentId),
    });
    this.#executors = new NodeExecutorController({
      deps: this.deps,
      buildConditionScope: (ctx, data) => this.#buildConditionScope(ctx, data),
      enforceSpecConstraints: (ctx, service, callRef, ...aliases) => this.#enforceSpecConstraints(ctx, service, callRef, ...aliases),
      persistArtifact: (ctx, node, args) => this.#persistArtifact(ctx, node, args),
      persistRun: (ctx) => this.#persistRun(ctx),
      recordEvaluationTokens: (ctx, nodeId, usage, agentId) => this.#recordEvaluationTokens(ctx, nodeId, usage, agentId),
      resolveEvaluationRuntime: (ctx, node, targetPath) => this.#resolveEvaluationRuntime(ctx, node, targetPath),
    });
    this.#selfHeal = new SelfHealController({
      deps: this.deps,
      debugRuns: this.#debugRuns,
      agentConfiguredModel: (agentId) => this.#agentConfiguredModel(agentId),
      agentHasConnectedRuntime: (agentId) => this.#agentHasConnectedRuntime(agentId),
      agentRole: (agentId) => this.#agentRole(agentId),
      audit: (ctx, entry) => this.#audit(ctx, entry),
      dispatchAgentTask: (ctx, node, config, inputData) => this.#dispatchAgentTask(ctx, node, config, inputData),
      dispatchNode: (ctx, node, item) => this.#dispatchNode(ctx, node, item),
      emitWorkStep: (ctx, node, phase, detail) => this.#emitWorkStep(ctx, node, phase, detail),
      failNode: (ctx, nodeId, error) => this.#failNode(ctx, nodeId, error),
      findAgentByRole: (workspaceId, role) => this.#findAgentByRole(workspaceId, role),
      pendingApprovals: (ctx) => this.#pendingApprovals(ctx),
      persistRun: (ctx) => this.#persistRun(ctx),
      resolveConnectedFallbackAgent: (workspaceId, capabilityTags, requires, preferredRole) => this.#resolveConnectedFallbackAgent(workspaceId, capabilityTags, requires, preferredRole),
      tick: (ctx) => this.#tick(ctx),
      applyGraphPatch: (args) => this.applyGraphPatch(args),
      notifyAgentActivity: (args) => this.notifyAgentActivity(args),
    });
  }

  // ────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────

  async startRun(args: StartRunArgs): Promise<RunHandle> {
    const normalized = normalizeWorkflowGraph(this.deps.db, args.workspaceId, args.graph);
    let graph = normalized.graph;
    let workflowRevisionId = args.workflowRevisionId ?? null;
    if (!workflowRevisionId && this.deps.revisions) {
      try {
        workflowRevisionId = this.deps.revisions.active(args.workspaceId, args.workflowId).revision.id;
      } catch {
        // Ephemeral/internal workflows are allowed to execute without a durable
        // workflow revision. Persisted workflows are resolved above.
      }
    }
    // P1.2: mark a debug/test run so self-heal + fallback recovery are suppressed
    // and the agent observes the RAW per-node failure instead of a healed result.
    if (args.debugRun) this.#debugRuns.add(args.initialState.runId);
    if (normalized.repairs.length > 0) {
      this.deps.logger.info('engine.graph.normalized', {
        runId: args.initialState.runId,
        workflowId: args.workflowId,
        repairs: normalized.repairs,
      });
      if (this.deps.revisions) {
        const existingCandidate = this.deps.revisions.candidate(args.workspaceId, args.workflowId);
        const normalizedCandidate = this.deps.revisions.createCandidate({
          workspaceId: args.workspaceId,
          workflowId: args.workflowId,
          graph,
          baseRevisionId: workflowRevisionId,
          source: 'normalization',
          actor: { type: 'system' },
          reason: `Runtime normalization found ${normalized.repairs.length} compatibility repair(s)`,
          allowBranch: true,
          setAsHead: !existingCandidate || existingCandidate.revision.id === workflowRevisionId,
        });
        workflowRevisionId = normalizedCandidate.revision.id;
        graph = normalizedCandidate.revision.graphJson as WorkflowGraph;
        if (!args.debugRun) {
          throw new AgentisError(
            'WORKFLOW_GRAPH_INVALID',
            'The production revision required normalization. A candidate was created; verify it with a clean debug run before promotion.',
            {
              httpStatus: 409,
              details: {
                code: 'WORKFLOW_NORMALIZATION_CANDIDATE_CREATED',
                candidateRevisionId: normalizedCandidate.revision.id,
                repairs: normalized.repairs,
              },
            },
          );
        }
      }
    }
    validateWorkflowGraph(graph, { currentWorkflowId: args.workflowId });
    try {
      this.#preparePinnedAgentRuntimes(args.workspaceId, graph);
    } catch (error) {
      const now = new Date().toISOString();
      this.deps.db
        .update(schema.workflowRuns)
        .set({ status: 'FAILED', executionStatus: 'failed', outcomeStatus: 'not_accomplished', completedAt: now, updatedAt: now })
        .where(eq(schema.workflowRuns.id, args.initialState.runId))
        .run();
      const payload = {
        runId: args.initialState.runId,
        status: 'FAILED' as const,
        workflowId: args.workflowId,
        workspaceId: args.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      };
      this.deps.bus.publish(REALTIME_ROOMS.run(args.initialState.runId), REALTIME_EVENTS.RUN_FAILED, payload);
      this.deps.bus.publish(REALTIME_ROOMS.workspace(args.workspaceId), REALTIME_EVENTS.RUN_FAILED, payload);
      return { runId: args.initialState.runId, workflowId: args.workflowId };
    }
    const ctx: RunningContext = {
      runId: args.initialState.runId,
      workflowId: args.workflowId,
      planId: args.planId ?? null,
      workspaceId: args.workspaceId,
      ambientId: args.ambientId,
      conversationId: args.conversationId ?? null,
      userId: args.userId,
      workflowRevisionId,
      graph,
      downstreamEdges: buildDownstreamEdges(graph),
      state: args.initialState,
      eventsSinceSnapshot: 0,
      inflightDispatches: 0,
      swarms: new Map(),
      selfHealAttempts: hydrateSelfHealAttempts(args.initialState),
      abortController: new AbortController(),
    };
    this.#runs.set(ctx.runId, ctx);
    if (ctx.planId && this.deps.plans) {
      this.deps.plans.bindRun(ctx.workspaceId, ctx.userId, ctx.planId, ctx.runId);
    }
    await this.deps.db
      .update(schema.workflowRuns)
      .set({
        graphSnapshot: graph as unknown as object,
        workflowRevisionId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workflowRuns.id, ctx.runId));

    await this.#transitionRunStatus(ctx, 'RUNNING');
    this.deps.activity.record({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      userId: ctx.userId,
      eventType: 'run.started',
      actorType: 'user',
      actorId: ctx.userId,
      entityType: 'workflow_run',
      entityId: ctx.runId,
      summary: `Workflow run started`,
      metadata: { workflowId: ctx.workflowId, triggerId: args.triggerId },
    });
    this.#audit(ctx, {
      action: 'run.started',
      actorType: args.triggerId ? 'scheduler' : 'user',
      actorId: ctx.userId,
      inputSummary: summarizeForAudit(args.inputs),
    });

    // Kick the dispatch loop. Don't await — runs are async.
    queueMicrotask(() => {
      void this.#tick(ctx).catch((err) => {
        this.deps.logger.error('engine.tick.unhandled', {
          runId: ctx.runId,
          err: (err as Error).message,
        });
      });
    });

    return { runId: ctx.runId, workflowId: ctx.workflowId };
  }

  /**
   * Re-evaluate a COMPLETED run against the workflow's current, graph-reconciled
   * definition of done. This never dispatches a node, replays a graph, or repeats
   * an outward side effect; it grades the persisted evidence surface in place.
   * It is the safe recovery path when execution was sound but an acceptance
   * expression or probe contract was repaired after the run settled.
   */
  async regradeCompletedRun(args: { workspaceId: string; runId: string }): Promise<{
    runId: string;
    workflowId: string;
    previousOutcome: RunVerdict['outcome'] | null;
    verdict: RunVerdict;
    terminalOutputPaths: string[];
  }> {
    const run = this.deps.db
      .select()
      .from(schema.workflowRuns)
      .where(and(eq(schema.workflowRuns.id, args.runId), eq(schema.workflowRuns.workspaceId, args.workspaceId)))
      .get();
    if (!run || !run.workflowId) throw new AgentisError('WORKFLOW_RUN_NOT_FOUND', `run ${args.runId} not found`);
    if (run.status !== 'COMPLETED') {
      throw new AgentisError('VALIDATION_FAILED', `only a COMPLETED run can be regraded from persisted evidence; run is ${run.status}`);
    }
    const workflow = this.deps.db
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.id, run.workflowId), eq(schema.workflows.workspaceId, args.workspaceId)))
      .get();
    if (!workflow) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow ${run.workflowId} not found`);
    const spec = readWorkflowSpec(workflow.settings);
    if (!spec) throw new AgentisError('VALIDATION_FAILED', 'workflow has no definition-of-done spec to regrade');
    const graph = (run.graphSnapshot ?? workflow.graph) as WorkflowGraph;
    const graphHash = graphContentHash(graph);
    if (spec.reconciledHash && spec.reconciledHash !== graphHash) {
      throw new AgentisError(
        'VALIDATION_FAILED',
        `definition-of-done is stale for this evidence (spec ${spec.reconciledHash}, run graph ${graphHash}); reconcile the spec to the run graph before regrading`,
      );
    }
    const state = run.runState as WorkflowRunState & { verdict?: RunVerdict };
    const ctx: RunningContext = {
      runId: run.id,
      workflowId: run.workflowId,
      planId: null,
      workspaceId: run.workspaceId,
      ambientId: run.ambientId,
      conversationId: run.conversationId,
      userId: run.userId,
      graph,
      downstreamEdges: buildDownstreamEdges(graph),
      state,
      eventsSinceSnapshot: 0,
      inflightDispatches: 0,
      swarms: new Map(),
      selfHealAttempts: hydrateSelfHealAttempts(state),
      abortController: new AbortController(),
    };
    (ctx as unknown as { __swiftSpec: WorkflowSpec }).__swiftSpec = spec;
    const previousOutcome = state.verdict?.outcome ?? null;
    const verdict = await this.#evaluateVerdict(ctx, spec);
    if (!verdict) throw new AgentisError('VALIDATION_FAILED', 'persisted-evidence regrade could not evaluate the verdict');
    state.verdict = verdict;
    this.deps.db
      .update(schema.workflowRuns)
      .set({ runState: state, updatedAt: new Date().toISOString() })
      .where(eq(schema.workflowRuns.id, run.id))
      .run();
    const output = this.#collectVerdictSurface(ctx);
    return {
      runId: run.id,
      workflowId: run.workflowId,
      previousOutcome,
      verdict,
      terminalOutputPaths: terminalOutputPaths(output),
    };
  }

  /**
   * Recover runs interrupted by a process restart.
   *
   * Called once at boot. The in-memory `#runs` map is empty after a restart,
   * so any run left in `RUNNING` would hang forever. We split them:
   *
   *   - RESUMABLE: a run whose ONLY in-flight work is `wait` timers. The wait
   *     node's sole effect is the delay, and we persisted `wakeAt` + inputs,
   *     so we can rebuild the context, re-arm the timer for the remaining
   *     delay (firing immediately if it already elapsed), and re-enter the
   *     dispatch loop. This makes "wait an hour, then send" survive restarts.
   *
   *   - NON-RECOVERABLE: a run with an in-flight agent / extension / http /
   *     integration / subflow / evaluator execution. We can't know whether
   *     that external work completed, so re-dispatching risks double
   *     side-effects. These are failed loud with a clear reason.
   *
   * Returns a summary so bootstrap can log it.
   */
  async recoverInterruptedRuns(): Promise<{ resumed: number; failed: number }> {
    // A session parked on `request_approval` persists BOTH an approval row
    // (source 'checkpoint') and a waiting agent_session whose wakeCondition is
    // `approval:*`. Those resume through the session-recovery pass (kind
    // 'session'), not the checkpoint pass — collect their (run,node) keys so the
    // checkpoint pass skips them and doesn't mis-register them as plain gates.
    const sessionApprovalKeys = new Set<string>();
    if (this.deps.sessions) {
      for (const s of this.deps.sessions.listWaiting()) {
        if (s.runId && s.nodeId && (s.wakeCondition ?? '').startsWith('approval:')) {
          sessionApprovalKeys.add(`${s.runId}::${s.nodeId}`);
        }
      }
    }
    const isSessionApproval = (runId: string, approval: { targetId: string | null }): boolean =>
      Boolean(approval.targetId) && sessionApprovalKeys.has(`${runId}::${approval.targetId}`);
    const isGateApproval = (runId: string, approval: { source: string; targetId: string | null }): boolean =>
      (approval.source === 'checkpoint' || approval.source === 'phase_gate' || approval.source === 'self_heal') && !isSessionApproval(runId, approval);

    const running = this.deps.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.status, 'RUNNING'))
      .all();
    const waitingForApproval = this.deps.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.status, 'WAITING'))
      .all()
      .filter((run) => this.deps.db
        .select()
        .from(schema.approvalRequests)
        .where(and(eq(schema.approvalRequests.runId, run.id), eq(schema.approvalRequests.status, 'pending')))
        .all()
        .some((approval) => isGateApproval(run.id, approval)));
    const terminalPaused = this.deps.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.status, 'PAUSED'))
      .all()
      .filter((run) => {
        const state = run.runState as unknown as WorkflowRunState | null;
        return Boolean(state && hasTerminalSelfHealFailure(state));
      });
    let resumed = 0;
    let failed = 0;
    for (const run of [...running, ...waitingForApproval, ...terminalPaused]) {
      const state = run.runState as unknown as WorkflowRunState | null;
      if (run.status === 'PAUSED' && state && hasTerminalSelfHealFailure(state)) {
        markOpenNodesSkipped(state, 'Skipped because self-healing reached a terminal blocker');
        state.status = 'FAILED';
        const now = new Date().toISOString();
        this.deps.db.update(schema.workflowRuns).set({
          status: 'FAILED', executionStatus: 'failed', outcomeStatus: 'not_accomplished', runState: state as unknown as object, completedAt: now, updatedAt: now,
        }).where(eq(schema.workflowRuns.id, run.id)).run();
        const payload = { runId: run.id, status: 'FAILED', workflowId: run.workflowId, workspaceId: run.workspaceId };
        this.deps.bus.publish(REALTIME_ROOMS.run(run.id), REALTIME_EVENTS.RUN_FAILED, payload);
        this.deps.bus.publish(REALTIME_ROOMS.workspace(run.workspaceId), REALTIME_EVENTS.RUN_FAILED, payload);
        this.deps.logger.info('engine.run_terminal_self_heal_reconciled', { runId: run.id });
        failed += 1;
        continue;
      }
      const activeExecs = state?.activeExecutions ? Object.values(state.activeExecutions) : [];
      const approvalRows = this.deps.db
        .select()
        .from(schema.approvalRequests)
        .where(and(eq(schema.approvalRequests.runId, run.id), eq(schema.approvalRequests.status, 'pending')))
        .all()
        .filter((approval) => isGateApproval(run.id, approval));
      if (activeExecs.length === 0 && approvalRows.length > 0 && run.workflowId && state) {
        try {
          const graph = this.#loadWorkflowGraph(run.workflowId);
          const ctx: RunningContext = {
            runId: run.id,
            workflowId: run.workflowId,
            planId: this.deps.plans?.findByRun(run.workspaceId, run.id)?.id ?? null,
            workspaceId: run.workspaceId,
            ambientId: run.ambientId,
            conversationId: run.conversationId ?? null,
            userId: run.userId,
            graph,
            downstreamEdges: buildDownstreamEdges(graph),
            state,
            eventsSinceSnapshot: 0,
            inflightDispatches: 0,
            swarms: new Map(),
            selfHealAttempts: hydrateSelfHealAttempts(state),
          };
          for (const approval of approvalRows) {
            if (!approval.targetId) {
              throw new Error(`approval ${approval.id} is missing its resume target`);
            }
            const kind = approval.source === 'phase_gate' ? 'phase_gate' : approval.source === 'self_heal' ? 'self_heal' : 'checkpoint';
            if (kind === 'self_heal') {
              const payload = approval.payload as Record<string, unknown> | null;
              if (payload?.kind === 'retry_with_repair_context') {
                this.#pendingApprovals(ctx).set(approval.id, {
                  kind,
                  targetId: approval.targetId,
                  healAction: 'retry_with_repair_context',
                  retryError: typeof payload.error === 'string' ? payload.error : 'Previous attempt failed.',
                  retryDiagnosis: typeof payload.diagnosis === 'string' ? payload.diagnosis : 'Retry requested by self-healing.',
                  retryAttempt: typeof payload.attempt === 'number' ? payload.attempt : 1,
                  retryMaxAttempts: typeof payload.maxAttempts === 'number' ? payload.maxAttempts : 1,
                });
              } else {
                const healPatch = selfHealPatchFromPayload(approval.payload);
                if (!healPatch) throw new Error(`self-heal approval ${approval.id} is missing its durable patch`);
                this.#pendingApprovals(ctx).set(approval.id, { kind, targetId: approval.targetId, healAction: 'graph_patch', healPatch });
              }
            } else {
              this.#pendingApprovals(ctx).set(approval.id, { kind, targetId: approval.targetId });
            }
            if (kind === 'phase_gate') {
              const phase = graph.phases?.find((item) => item.id === approval.targetId);
              const held = (phase?.nodeIds ?? [])
                .filter((nodeId) => state.nodeStates[nodeId]?.status === 'WAITING')
                .map((nodeId) => ({
                  nodeId,
                  priority: 0,
                  insertedAt: new Date().toISOString(),
                  inputData: state.nodeStates[nodeId]?.inputData ?? {},
                }));
              if (!phase || held.length === 0) {
                throw new Error(`phase gate ${approval.targetId} has no persisted held node`);
              }
              this.#phaseRuntime(ctx).set(phase.id, {
                started: false,
                startedAt: 0,
                cost: 0,
                slaBreached: false,
                gateState: 'pending',
                held,
              });
            }
          }
          this.#runs.set(ctx.runId, ctx);
          this.deps.logger.info('engine.run_approval_resumed', { runId: run.id, approvals: approvalRows.length });
          resumed += 1;
          continue;
        } catch (err) {
          this.deps.logger.warn('engine.run_approval_resume_failed', { runId: run.id, err: (err as Error).message });
        }
      }
      if (!run.workflowId || !state) {
        // Truly unrecoverable (no graph or no persisted state) — fail loud.
        this.deps.db
          .update(schema.workflowRuns)
          .set({ status: 'FAILED', executionStatus: 'failed', outcomeStatus: 'not_accomplished', completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
          .where(eq(schema.workflowRuns.id, run.id))
          .run();
        failed += 1;
        continue;
      }
      // Orphan sweep: a RUNNING run with nothing in flight (no active executions,
      // no pending gate approval) AND nothing queued to advance it cannot make
      // progress on its own — the worker that was driving it is gone (crash /
      // restart between ticks / a Stop that never transitioned). Left alone it
      // shows as "running" forever in the pipeline. Reconcile it to a truthful
      // terminal state: COMPLETED only if every node already reached a terminal,
      // otherwise FAILED so the operator can retry. WAITING runs are excluded —
      // they may legitimately be parked on a reply/session and are handled below.
      if (run.status === 'RUNNING' && activeExecs.length === 0 && approvalRows.length === 0
        && (state.readyQueue?.length ?? 0) === 0) {
        const allTerminal = Object.values(state.nodeStates).every(
          (node) => !node || node.status === 'COMPLETED' || node.status === 'FAILED' || node.status === 'SKIPPED',
        );
        const terminal: WorkflowRunStatus = allTerminal ? 'COMPLETED' : 'FAILED';
        if (!allTerminal) markOpenNodesSkipped(state, 'Run was interrupted and could not be resumed');
        state.status = terminal;
        const now = new Date().toISOString();
        this.deps.db
          .update(schema.workflowRuns)
          .set({ status: terminal, runState: state as unknown as object, completedAt: now, updatedAt: now })
          .where(eq(schema.workflowRuns.id, run.id))
          .run();
        const event = terminal === 'COMPLETED' ? REALTIME_EVENTS.RUN_COMPLETED : REALTIME_EVENTS.RUN_FAILED;
        const payload = { runId: run.id, status: terminal, workflowId: run.workflowId, workspaceId: run.workspaceId };
        this.deps.bus.publish(REALTIME_ROOMS.run(run.id), event, payload);
        this.deps.bus.publish(REALTIME_ROOMS.workspace(run.workspaceId), event, payload);
        this.deps.logger.info('engine.run_orphan_reconciled', { runId: run.id, terminal });
        if (terminal === 'FAILED') failed += 1; else resumed += 1;
        continue;
      }
      try {
        const graph = this.#loadWorkflowGraph(run.workflowId);
        const ctx: RunningContext = {
          runId: run.id,
          workflowId: run.workflowId,
          planId: this.deps.plans?.findByRun(run.workspaceId, run.id)?.id ?? null,
          workspaceId: run.workspaceId,
          ambientId: run.ambientId,
          conversationId: run.conversationId ?? null,
          userId: run.userId,
          graph,
          downstreamEdges: buildDownstreamEdges(graph),
          state,
          eventsSinceSnapshot: 0,
          inflightDispatches: 0,
          swarms: new Map(),
          selfHealAttempts: hydrateSelfHealAttempts(state),
        };
        this.#runs.set(ctx.runId, ctx);
        // AEJ crash recovery (NATIVE-ADVANCEMENT Proposal 1):
        //  - `wait` executions re-arm their timer for the remaining delay.
        //  - every OTHER in-flight execution (agent / integration / http /
        //    subflow / extension / …) had an UNKNOWN outcome at crash time.
        //    Rather than failing the whole run (the old "fail loud"), we
        //    RE-DISPATCH it so the run survives the restart. Each carries a
        //    stable idempotency key (runId+nodeId), journaled to the ledger, so
        //    dedup-capable handlers/connectors make the retry effectively once.
        //    (Effectively-once still requires downstream dedup support — the
        //    standard durable-execution caveat — but resuming beats a dead run.)
        let redispatched = 0;
        for (const exec of activeExecs) {
          const inputData = ((exec as unknown as { inputData?: Record<string, unknown> }).inputData)
            ?? ctx.state.nodeStates[exec.nodeId]?.inputData
            ?? {};
          if (exec.executorType === 'wait') {
            const wakeAt = (exec as unknown as { wakeAt?: string }).wakeAt;
            const remaining = wakeAt ? Math.max(0, new Date(wakeAt).getTime() - Date.now()) : 0;
            const fire = () => {
              delete ctx.state.activeExecutions[exec.nodeId];
              void (async () => {
                await this.#completeNode(ctx, exec.nodeId, inputData);
                void this.#tick(ctx);
              })();
            };
            if (remaining <= 0) {
              queueMicrotask(fire);
            } else {
              this.#armTimer(remaining, fire);
            }
          } else if (exec.executorType === 'subflow' && this.deps.subflows) {
            // Durable delegation (1.4): a subflow parent must NOT be re-dispatched
            // (that would spawn a *second* child run and orphan the first). Instead
            // re-bind to the child run that survived in the DB; if that child already
            // finished during downtime, resume the parent immediately.
            this.#recoverSubflowParent(ctx, exec);
          } else {
            const idempotencyKey = nodeIdempotencyKey(ctx.runId, exec.nodeId, 0);
            delete ctx.state.activeExecutions[exec.nodeId];
            const ns = ctx.state.nodeStates[exec.nodeId];
            if (ns) ns.status = 'PENDING';
            ctx.state.readyQueue.push({
              nodeId: exec.nodeId,
              priority: 0,
              insertedAt: new Date().toISOString(),
              inputData,
              idempotencyKey,
            });
            void this.deps.ledger.append({
              workspaceId: ctx.workspaceId,
              ambientId: ctx.ambientId,
              runId: ctx.runId,
              eventType: 'node.redispatched',
              nodeId: exec.nodeId,
              payload: { idempotencyKey, reason: 'crash_recovery' },
            });
            redispatched += 1;
          }
        }
        if (redispatched > 0) queueMicrotask(() => void this.#tick(ctx));
        this.deps.logger.info('engine.run_resumed', {
          runId: run.id,
          waits: activeExecs.length - redispatched,
          redispatched,
        });
        resumed += 1;
      } catch (err) {
        this.deps.logger.warn('engine.run_resume_failed', { runId: run.id, err: (err as Error).message });
        this.deps.db
          .update(schema.workflowRuns)
          .set({ status: 'FAILED', executionStatus: 'failed', outcomeStatus: 'not_accomplished', completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
          .where(eq(schema.workflowRuns.id, run.id))
          .run();
        failed += 1;
      }
    }
    // SMARTER-AGENTS-10X durability: re-arm parked agent sessions (await_event /
    // sleep_until / request_approval) so a process restart resumes them instead
    // of leaving the run WAITING forever. Runs to handle: any WAITING run with a
    // parked session — including those whose ONLY in-flight work is a session
    // yield (no approval, no active exec), which the passes above never see.
    try {
      const sessionRecovery = await this.#recoverParkedSessions();
      if (sessionRecovery.recovered > 0) {
        this.deps.logger.info('engine.parked_sessions_recovered', { count: sessionRecovery.recovered });
      }
    } catch (err) {
      this.deps.logger.warn('engine.parked_session_recovery_failed', { err: (err as Error).message });
    }
    return { resumed, failed };
  }

  /**
   * Reap runs whose owning workflow no longer exists. A deleted workflow — or an
   * app deletion that orphaned its workflows ([[project_app_lifecycle_side_effects]])
   * — can leave runs in a non-terminal state that can NEVER resume or be
   * controlled: uncontrollable zombies that inflate the "N running / N waiting"
   * pill and the run monitor forever ([[project_phantom_running_pill]]). Mark them
   * CANCELLED with an explaining reason and emit RUN_CANCELLED so every run surface
   * drops them. This is the ONE safe reaping signal: a legitimately-parked run
   * (sleep_until, paused-on-credits, awaiting approval) always has a LIVE workflow,
   * so operator-owned parks are never touched — the human still controls those
   * manually via the run monitor. (LIVING-INTERFACES-COCKPIT-10X §4.2.)
   *
   * Idempotent and cheap: only scans non-terminal runs, only acts on ones whose
   * workflow row is gone. Runs at boot (after recovery) and is safe to call again.
   */
  reapOrphanedRuns(): { reaped: number } {
    const nonTerminal = this.deps.db
      .select()
      .from(schema.workflowRuns)
      .where(inArray(schema.workflowRuns.status, ['CREATED', 'PLANNING', 'RUNNING', 'WAITING', 'PAUSED']))
      .all();
    let reaped = 0;
    for (const run of nonTerminal) {
      // A live owning workflow → NOT an orphan, never touch it.
      const workflow = run.workflowId
        ? this.deps.db.select({ id: schema.workflows.id }).from(schema.workflows).where(eq(schema.workflows.id, run.workflowId)).get()
        : undefined;
      if (workflow) continue;
      const now = new Date().toISOString();
      const state = run.runState as unknown as WorkflowRunState | null;
      if (state) {
        // Defensive: a zombie may carry a partial/corrupt state — never let one
        // malformed run abort the whole sweep.
        if (state.nodeStates) markOpenNodesSkipped(state, 'Skipped: the owning workflow no longer exists');
        state.status = 'CANCELLED';
      }
      this.deps.db
        .update(schema.workflowRuns)
        .set({ status: 'CANCELLED', executionStatus: 'cancelled', outcomeStatus: 'blocked', ...(state ? { runState: state as unknown as object } : {}), completedAt: now, updatedAt: now })
        .where(eq(schema.workflowRuns.id, run.id))
        .run();
      const payload = { runId: run.id, status: 'CANCELLED', workflowId: run.workflowId, workspaceId: run.workspaceId, reason: 'workflow no longer exists' };
      this.deps.bus.publish(REALTIME_ROOMS.run(run.id), REALTIME_EVENTS.RUN_CANCELLED, payload);
      this.deps.bus.publish(REALTIME_ROOMS.workspace(run.workspaceId), REALTIME_EVENTS.RUN_CANCELLED, payload);
      reaped += 1;
    }
    if (reaped > 0) this.deps.logger.info('engine.orphan_runs_reaped', { count: reaped });
    return { reaped };
  }

  /**
   * Rehydrate and re-arm every parked agent session so suspensions survive a
   * restart. For each waiting session it rebuilds the run context (reusing an
   * already-recovered run when present), then re-registers the wake hook by kind:
   *   - `event:NAME`   → run-event waiter (resumes via notifySessionEvent)
   *   - `time:ISO`     → timer (fires immediately if the deadline already passed)
   *   - `approval:TID` → pending-approval link (resumes when the human decides)
   * Delegation parks never persist (resolved inline), so they never appear here.
   */
  async #recoverParkedSessions(): Promise<{ recovered: number }> {
    if (!this.deps.sessions || !this.deps.sessionRuntime) return { recovered: 0 };
    const waiting = this.deps.sessions.listWaiting();
    if (waiting.length === 0) return { recovered: 0 };
    const byRun = new Map<string, typeof waiting>();
    for (const s of waiting) {
      if (!s.runId || !s.nodeId) continue;
      const list = byRun.get(s.runId) ?? [];
      list.push(s);
      byRun.set(s.runId, list);
    }
    let recovered = 0;
    for (const [runId, sessions] of byRun) {
      const ctx = this.#ensureRecoveredCtx(runId);
      if (!ctx) continue;
      for (const session of sessions) {
        const node = ctx.graph.nodes.find((n) => n.id === session.nodeId);
        const cond = session.wakeCondition ?? '';
        if (!node || !cond) continue;
        const toolCallId = typeof session.suspendPayload?.toolCallId === 'string'
          ? session.suspendPayload.toolCallId
          : '';
        const runCtx = await this.#rebuildSessionRunCtx(ctx, session.agentId, node);
        if (cond.startsWith('event:')) {
          const event = cond.slice('event:'.length);
          const list = this.#sessionWaiters(ctx).get(event) ?? [];
          list.push({ sessionId: session.id, nodeId: node.id, toolCallId, runCtx });
          this.#sessionWaiters(ctx).set(event, list);
          recovered += 1;
        } else if (cond.startsWith('time:')) {
          const untilIso = cond.slice('time:'.length);
          const remaining = Math.max(0, Date.parse(untilIso) - Date.now());
          const fire = () => void this.#wakeSession(ctx, node, session.id, runCtx, toolCallId, { sleptUntil: untilIso });
          if (remaining <= 0) queueMicrotask(fire);
          else this.#armTimer(remaining, fire);
          recovered += 1;
        } else if (cond.startsWith('runs:')) {
          // A parked `await_runs` fan-in — re-arm the wait from the persisted run
          // set (some may have settled during downtime; the helper resolves those
          // immediately from current state, so a fully-finished set wakes at once).
          const runIds = Array.isArray(session.suspendPayload?.runIds)
            ? (session.suspendPayload!.runIds as unknown[]).filter((v): v is string => typeof v === 'string')
            : [];
          if (runIds.length > 0) {
            void waitForAllRunsSettle({ db: this.deps.db, bus: this.deps.bus }, ctx.workspaceId, runIds, { timeoutMs: 6 * 60 * 60_000 })
              .then((res) => this.#wakeSession(ctx, node, session.id, runCtx, toolCallId, summarizeFanIn(runIds, res)))
              .catch(() => {});
            recovered += 1;
          }
        } else if (cond.startsWith('approval:')) {
          const approval = this.deps.db
            .select()
            .from(schema.approvalRequests)
            .where(and(
              eq(schema.approvalRequests.runId, runId),
              eq(schema.approvalRequests.targetId, node.id),
              eq(schema.approvalRequests.status, 'pending'),
            ))
            .all()[0];
          if (approval) {
            this.#pendingApprovals(ctx).set(approval.id, { kind: 'session', targetId: node.id, sessionId: session.id, toolCallId, runCtx });
            recovered += 1;
          }
        }
      }
    }
    return { recovered };
  }

  /**
   * Durable delegation (masterplan 1.4): re-attach a subflow parent node to the
   * child run that outlived a restart. The child persists its own run row keyed
   * by `parentRunId`; the parent node's id is recovered from its own persisted
   * `activeExecutions` entry. We rebind the resume/fail callbacks over the
   * rehydrated parent context, then:
   *   - child already terminal (finished during downtime) → resume/fail now;
   *   - child still in-flight → leave the parent RUNNING; its eventual terminal
   *     transition finds the freshly-rebound pending and resumes the parent.
   * If no child row exists at all (the start never persisted), we fall back to a
   * plain re-dispatch so the run can't hang.
   */
  #recoverSubflowParent(ctx: RunningContext, exec: { nodeId: string; executorRef?: string }): void {
    const subflows = this.deps.subflows;
    if (!subflows) return;
    const parentNodeId = exec.nodeId;
    const childWorkflowId = exec.executorRef;
    // Find the child run this parent node spawned. (parentRunId + child workflow
    // id is the durable link; pick the most recent if a workflow is reused.)
    const candidates = this.deps.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.parentRunId, ctx.runId))
      .all()
      .filter((row) => !childWorkflowId || row.workflowId === childWorkflowId)
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
    const child = candidates[0];
    if (!child) {
      // The child was never persisted — re-dispatch the node so the run survives.
      delete ctx.state.activeExecutions[parentNodeId];
      const ns = ctx.state.nodeStates[parentNodeId];
      if (ns) ns.status = 'PENDING';
      ctx.state.readyQueue.push({
        nodeId: parentNodeId,
        priority: 0,
        insertedAt: new Date().toISOString(),
        inputData: ns?.inputData ?? {},
        idempotencyKey: nodeIdempotencyKey(ctx.runId, parentNodeId, 0),
      });
      queueMicrotask(() => void this.#tick(ctx));
      return;
    }

    if (!subflows.hasPending(ctx.runId, parentNodeId)) {
      subflows.rebind({
        parentRunId: ctx.runId,
        parentNodeId,
        childRunId: child.id,
        resumeParent: async (output) => {
          await this.#completeNode(ctx, parentNodeId, output);
          void this.#tick(ctx);
        },
        failParent: async (msg) => {
          await this.#failNode(ctx, parentNodeId, msg);
          void this.#tick(ctx);
        },
      });
    }

    const terminal = child.status === 'COMPLETED' || child.status === 'FAILED' || child.status === 'CANCELLED';
    if (terminal) {
      // The child finished while we were down — drive the parent resume now,
      // since the child's terminal transition already fired (and found no binding).
      const childState = child.runState as unknown as WorkflowRunState | null;
      const finalNodeId = childState?.completedNodeIds?.at(-1);
      const finalOutput = (finalNodeId && childState?.nodeStates?.[finalNodeId]?.outputData) || {};
      void subflows.onChildRunFinished({
        childRunId: child.id,
        parentRunId: ctx.runId,
        parentNodeId,
        status: child.status as 'COMPLETED' | 'FAILED' | 'CANCELLED',
        finalOutput: finalOutput as Record<string, unknown>,
        workspaceId: child.workspaceId,
        ambientId: child.ambientId,
        ...(child.status !== 'COMPLETED' ? { error: `child run ${child.id} ${child.status}` } : {}),
      });
    }
    // else: parent stays RUNNING; the in-flight child (recovered as its own run)
    // will notify on its terminal transition via the rebound pending.
  }

  /** Get a live run ctx, rehydrating it from DB when not already in memory. */
  #ensureRecoveredCtx(runId: string): RunningContext | null {
    const existing = this.#runs.get(runId);
    if (existing) return existing;
    const run = this.deps.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
    const state = run?.runState as unknown as WorkflowRunState | null;
    if (!run || run.status !== 'WAITING' || !run.workflowId || !state) return null;
    try {
      const graph = this.#loadWorkflowGraph(run.workflowId);
      const ctx: RunningContext = {
        runId: run.id,
        workflowId: run.workflowId,
        planId: this.deps.plans?.findByRun(run.workspaceId, run.id)?.id ?? null,
        workspaceId: run.workspaceId,
        ambientId: run.ambientId,
        conversationId: run.conversationId ?? null,
        userId: run.userId,
        graph,
        downstreamEdges: buildDownstreamEdges(graph),
        state,
        eventsSinceSnapshot: 0,
        inflightDispatches: 0,
        swarms: new Map(),
        selfHealAttempts: hydrateSelfHealAttempts(state),
      };
      this.#runs.set(ctx.runId, ctx);
      return ctx;
    } catch (err) {
      this.deps.logger.warn('engine.session_run_rehydrate_failed', { runId, err: (err as Error).message });
      return null;
    }
  }

  /** Rebuild a session run-context for wake (workspace/brain addendum + role). */
  async #rebuildSessionRunCtx(ctx: RunningContext, agentId: string, node: WorkflowNode): Promise<SessionRunContext> {
    const cfg = node.config as { agentRole?: AgentRole };
    const role = cfg.agentRole && isAgentRole(cfg.agentRole) ? cfg.agentRole : undefined;
    let runContextBlock = '';
    try {
      runContextBlock = (await this.#withWorkspaceContext(ctx, '', undefined, '', agentId)).prompt;
    } catch {
      runContextBlock = '';
    }
    return {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      runId: ctx.runId,
      nodeId: node.id,
      agentId,
      workflowId: ctx.workflowId,
      planId: ctx.planId,
      ...(role ? { role } : {}),
      runContextBlock,
    };
  }

  /**
   * Dry-run a single node in isolation.
   *
   * Builds an ephemeral RunningContext that does NOT persist to the database
   * or fire ledger events, dispatches the node's handler against the provided
   * inputs, and returns either the output or a structured error. The node's
   * own side-effects (HTTP calls, integration writes, agent dispatches) still
   * happen — this is "run this one node now" with real credentials, not a mock.
   *
   * Used by the canvas Test tab.
   */
  async testNode(args: {
    workspaceId: string;
    ambientId: string | null;
    userId: string;
    workflowId: string;
    nodeId: string;
    inputs: Record<string, unknown>;
  }): Promise<{ ok: true; output: Record<string, unknown>; durationMs: number }
              | { ok: false; error: string; code?: string; durationMs: number }> {
    const startedAt = Date.now();
    const wf = this.deps.db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.id, args.workflowId))
      .get();
    if (!wf || wf.workspaceId !== args.workspaceId) {
      return { ok: false, error: `workflow ${args.workflowId} not found`, code: 'RESOURCE_NOT_FOUND', durationMs: Date.now() - startedAt };
    }
    const graph = normalizeWorkflowGraph(this.deps.db, args.workspaceId, wf.graph as unknown as WorkflowGraph).graph;
    const node = graph.nodes.find((n) => n.id === args.nodeId);
    if (!node) {
      return { ok: false, error: `node ${args.nodeId} not found in workflow`, code: 'RESOURCE_NOT_FOUND', durationMs: Date.now() - startedAt };
    }
    // Async node kinds (agent_task, subflow, agent_swarm, checkpoint) cannot
    // be dry-run synchronously through #dispatchNode without setting up the
    // full callback machinery. Reject them explicitly so the UI can surface
    // a friendly message instead of hanging.
    const asyncKinds: ReadonlyArray<string> = ['agent_task', 'agent_swarm', 'subflow', 'checkpoint', 'loop', 'converge', 'pursue', 'agent_session', 'dynamic_swarm', 'planner'];
    if (asyncKinds.includes(node.config.kind)) {
      return {
        ok: false,
        error: `'${node.config.kind}' is async — test it via a real run`,
        code: 'VALIDATION_FAILED',
        durationMs: Date.now() - startedAt,
      };
    }

    // Build a throwaway context. We use a fake runId so any ledger/bus calls
    // (none should fire in test mode) are clearly tagged.
    const testRunId = `test-${randomUUID()}`;
    const initialState: WorkflowRunState = {
      runId: testRunId,
      workflowId: args.workflowId,
      status: 'RUNNING',
      readyQueue: [],
      waitingInputs: {},
      nodeStates: {
        [args.nodeId]: {
          nodeId: args.nodeId,
          status: 'PENDING',
          inputData: args.inputs,
        },
      },
      activeExecutions: {},
      completedNodeIds: [],
      failedNodeIds: [],
      skippedNodeIds: [],
      graphRevision: 0,
      replanCount: 0,
      lastLedgerSequence: 0,
    };
    const ctx: RunningContext = {
      runId: testRunId,
      workflowId: args.workflowId,
      planId: null,
      workspaceId: args.workspaceId,
      ambientId: args.ambientId,
      conversationId: null,
      userId: args.userId,
      graph,
      downstreamEdges: buildDownstreamEdges(graph),
      state: initialState,
      eventsSinceSnapshot: 0,
      inflightDispatches: 0,
      swarms: new Map(),
      selfHealAttempts: hydrateSelfHealAttempts(initialState),
    };

    // Build the template context and resolve config templates the same way
    // the real dispatch path does.
    const item: ReadyQueueItem = {
      nodeId: args.nodeId,
      priority: 0,
      insertedAt: new Date().toISOString(),
      inputData: args.inputs,
    };
    const tctx = this.#buildTemplateContext(ctx, item);
    const resolvedConfig = resolveTemplateDeep(node.config, tctx);

    try {
      let output: Record<string, unknown> = {};
      switch (node.config.kind) {
        case 'trigger':
        case 'merge':
        case 'parallel':
          output = args.inputs;
          break;
        case 'scratchpad':
          output = await this.#executeScratchpadNode(ctx, resolvedConfig as ScratchpadNodeConfig, args.inputs);
          break;
        case 'router': {
          const cfg = resolvedConfig as RouterNodeConfig;
          const branchOutputs = cfg.routingMode === 'llm_route'
            ? await this.#executors.executeRouterLlm(ctx, node, cfg, args.inputs)
            : this.#executors.executeRouter(ctx, cfg, args.inputs);
          output = { branches: branchOutputs };
          break;
        }
        case 'extension_task':
          output = await this.#executeExtensionTask(ctx, node, resolvedConfig as ExtensionTaskNodeConfig, args.inputs);
          break;
        case 'component_task':
          output = await this.#executeComponentTask(ctx, node, resolvedConfig as ComponentTaskNodeConfig, args.inputs);
          break;
        case 'knowledge':
          output = await this.#executeKnowledgeNode(ctx, resolvedConfig as KnowledgeNodeConfig, args.inputs);
          break;
        case 'knowledge_ingest':
          output = await this.#executeKnowledgeIngestNode(ctx, resolvedConfig as KnowledgeIngestNodeConfig, args.inputs);
          break;
        case 'artifact_collect':
          output = await this.#executeArtifactCollect(ctx, node, resolvedConfig as ArtifactCollectNodeConfig, args.inputs);
          break;
        case 'wait':
          // No-op for tests — return inputs immediately.
          output = args.inputs;
          break;
        case 'transform':
        case 'filter':
          // Pure kinds resolve through the handler registry (Proposal 4).
          output = this.#nodeHandlers.get(node.config.kind)!.execute(node.config, { inputData: args.inputs, tctx });
          break;
        case 'return_output':
          output = this.#executeReturnOutput(node.config as ReturnOutputNodeConfig, args.inputs, tctx);
          break;
        case 'artifact_save':
          output = await this.#executeArtifactSave(ctx, node, resolvedConfig as ArtifactSaveNodeConfig, args.inputs);
          break;
        case 'browser':
          output = await this.#executors.executeBrowser(ctx, node, resolvedConfig as BrowserNodeConfig, args.inputs);
          break;
        case 'integration':
          output = await this.#executors.executeIntegration(ctx, node, resolvedConfig as IntegrationNodeConfig, args.inputs);
          break;
        case 'http_request':
          output = await this.#executors.executeHttpRequest(ctx, node, resolvedConfig as HttpRequestNodeConfig);
          break;
        case 'workflow_store':
          output = await this.#executors.executeWorkflowStore(ctx, node.config as WorkflowStoreNodeConfig, tctx);
          break;
        case 'workspace_store':
          output = await this.#executors.executeWorkspaceStore(ctx, node.config as WorkspaceStoreNodeConfig, tctx);
          break;
        case 'evaluator':
          output = await this.#executeEvaluator(ctx, node, node.config as EvaluatorNodeConfig, args.inputs, tctx);
          break;
        case 'guardrails': {
          const result = this.#executors.executeGuardrails(node.config as GuardrailsNodeConfig, args.inputs);
          if (result.shouldFail) {
            return { ok: false, error: result.message, code: 'VALIDATION_FAILED', durationMs: Date.now() - startedAt };
          }
          output = result.output;
          break;
        }
        case 'code':
          output = await this.#executors.executeCode(ctx, node, resolvedConfig as CodeNodeConfig, args.inputs, tctx);
          break;
        case 'spreadsheet':
          output = await this.#executors.executeSpreadsheet(node, resolvedConfig as SpreadsheetNodeConfig, args.inputs);
          break;
        case 'graphql':
          output = await this.#executors.executeGraphQl(ctx, node, resolvedConfig as GraphQlNodeConfig);
          break;
        case 'stop_error': {
          const cfg = resolvedConfig as StopErrorNodeConfig;
          return { ok: false, error: cfg.errorMessage || 'Workflow stopped by stop_error node', code: 'WORKFLOW_STOPPED', durationMs: Date.now() - startedAt };
        }
        case 'error_trigger':
          output = args.inputs;
          break;
        default: {
          // Pure utility kinds (datetime, crypto_util, xml_parse, markdown,
          // json_schema_validate, html_extract, sticky_note) resolve through the
          // handler registry — same path the live dispatch uses.
          const pure = this.#nodeHandlers.get(node.config.kind);
          if (pure) {
            output = pure.execute(node.config, { inputData: args.inputs, tctx });
            break;
          }
          return { ok: false, error: `node kind '${node.config.kind}' is not testable in isolation`, code: 'VALIDATION_FAILED', durationMs: Date.now() - startedAt };
        }
      }
      return { ok: true, output, durationMs: Date.now() - startedAt };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return {
        ok: false,
        error: e.message ?? String(err),
        code: e.code,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  /**
   * P1.3: is a LIVE run of this workflow currently self-healing (DIAGNOSING /
   * PLANNING)? Lets an editing tool warn before it races the healer's own graph
   * patch on the same workflow. Reads live in-memory run state (not the DB).
   */
  isSelfHealInFlight(workflowId: string): boolean {
    for (const ctx of this.#runs.values()) {
      if (ctx.workflowId !== workflowId) continue;
      for (const incident of Object.values(ctx.state.selfHealIncidents ?? {})) {
        const status = (incident as { status?: string })?.status;
        if (status === 'DIAGNOSING' || status === 'PLANNING') return true;
      }
    }
    return false;
  }

  async cancelRun(runId: string): Promise<void> {
    const ctx = this.#runs.get(runId);
    if (!ctx) {
      await this.#cancelPersistedRun(runId);
      return;
    }
    // Fence the run *before* awaiting adapter cancellation. A completion can race
    // the adapter's cancel acknowledgement; without this fence that late callback
    // could re-open nodes and settle the run as completed after the operator has
    // explicitly cancelled it.
    ctx.cancellationRequested = true;
    // Stop in-flight work that honors the run signal (e.g. outbound HTTP, agent
    // model calls) rather than letting it run to completion after cancellation
    // (NATIVE-ADVANCEMENT Proposal 7, Agentis-native run-scoped cancellation).
    await this.#interruptActiveWork(ctx, { cancelSessions: true });
    // Don't leave the active node stuck "running": mark open nodes skipped so the
    // UI reflects a stopped run, not a frozen one (same as the persisted path).
    markOpenNodesSkipped(ctx.state, 'Run cancelled');
    await this.#transitionRunStatus(ctx, 'CANCELLED');
    this.#disposeRunState(runId);
  }

  /**
   * Pause is deliberately different from cancel: preserve the unfinished
   * frontier as WAITING work so the exact nodes can be resumed later.
   */
  async pauseRun(runId: string): Promise<void> {
    const ctx = this.#runs.get(runId);
    if (!ctx) {
      await this.#pausePersistedRun(runId);
      return;
    }
    await this.#interruptActiveWork(ctx);
    if (hasTerminalSelfHealFailure(ctx.state)) {
      this.#skipBlockedNodes(ctx, 'Skipped because self-healing reached a terminal blocker');
      await this.#transitionRunStatus(ctx, 'FAILED');
      this.#disposeRunState(runId);
      return;
    }
    for (const nodeId of Object.keys(ctx.state.activeExecutions)) {
      const node = ctx.state.nodeStates[nodeId];
      if (node?.status === 'RUNNING') {
        node.status = 'WAITING';
        node.blockedReason = 'Paused by operator';
      }
      delete ctx.state.activeExecutions[nodeId];
    }
    await this.#transitionRunStatus(ctx, 'PAUSED');
  }

  /** Never let a non-cooperative adapter make the operator wait forever. */
  async #interruptActiveWork(ctx: RunningContext, options: { cancelSessions?: boolean } = {}): Promise<void> {
    try { ctx.abortController?.abort(); } catch { /* best-effort */ }
    // agent_task nodes commonly execute as persistent sessions. They are not
    // AdapterManager tasks, so aborting adapters alone left those model loops
    // running (and parked sessions eligible to wake) after a run was stopped.
    if (options.cancelSessions) this.deps.sessions?.failRunSessions(ctx.runId, 'Run cancelled');
    await Promise.all(Object.values(ctx.state.activeExecutions).map(async (exec) => {
      if (!exec?.taskId || exec.executorType !== 'agent' || !exec.executorRef) return;
      await Promise.race([
        this.deps.adapters.cancelTask(exec.executorRef, exec.taskId).catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ]);
    }));
  }

  /**
   * Start every pending run buffered in `workflow_run_queue` for a workflow.
   * Drains the concurrency-overflow queue; called by SchedulerService.tick().
   */
  async drainWorkflowQueue(workflowId: string, now = new Date()): Promise<number> {
    // `scheduledAt` gates the ROW, not just the sweep. processDueQueue picks
    // workflows that have something due; without this filter, draining one due
    // row would start every deferred row for the same workflow alongside it —
    // collapsing a staggered fan-out into a single burst.
    const nowIso = now.toISOString();
    const pending = this.deps.db
      .select()
      .from(schema.workflowRunQueue)
      .where(and(
        eq(schema.workflowRunQueue.workflowId, workflowId),
        eq(schema.workflowRunQueue.status, 'pending'),
        or(
          isNull(schema.workflowRunQueue.scheduledAt),
          lte(schema.workflowRunQueue.scheduledAt, nowIso),
        ),
      ))
      .all();
    let started = 0;
    for (const item of pending) {
      const initialState = item.initialState as unknown as WorkflowRunState | null;
      const graph = item.graphSnapshot as unknown as WorkflowGraph | null;
      const claimed = this.deps.db
        .update(schema.workflowRunQueue)
        .set({
          status: initialState && graph ? 'dequeued' : 'dropped',
          updatedAt: new Date().toISOString(),
        })
        .where(and(
          eq(schema.workflowRunQueue.id, item.id),
          eq(schema.workflowRunQueue.status, 'pending'),
        ))
        .run();
      // Another scheduler/engine instance won the claim. Starting the same
      // durable run twice would duplicate every non-idempotent node side effect.
      if (claimed.changes === 0) continue;
      if (!initialState || !graph) continue;
      await this.startRun({
        workspaceId: item.workspaceId,
        ambientId: item.ambientId,
        conversationId: null,
        workflowId,
        userId: item.userId,
        triggerId: item.triggerId,
        inputs: (item.inputs as Record<string, unknown>) ?? {},
        initialState,
        graph,
      });
      started += 1;
    }
    return started;
  }

  /**
   * Async completion callback for agent-dispatched tasks.
   * Adapters emit task.completed via NormalizedAgentEvent; the adapter
   * manager forwards into here.
   */
  async notifyTaskCompleted(args: {
    runId: string;
    nodeId: string;
    output: Record<string, unknown>;
  }): Promise<void> {
    const ctx = this.#runs.get(args.runId);
    if (!ctx) return;
    if (ctx.state.status === 'PAUSED' || isTerminalRunStatus(ctx.state.status)) return;
    const swarm = parseSwarmTaskId(args.nodeId);
    if (swarm) {
      await this.#onSwarmSubtask(ctx, swarm.nodeId, swarm.index, args.output, null);
      return;
    }
    const active = ctx.state.activeExecutions[args.nodeId];
    const node = ctx.graph.nodes.find((candidate) => candidate.id === args.nodeId);
    const agentId = active?.executorType === 'agent'
      ? active.executorRef
      : node?.config.kind === 'agent_task'
        ? node.config.agentId
        : undefined;
    let output: Record<string, unknown>;
    try {
      output = node ? normalizeDeclaredNodeOutput(node, args.output) : args.output;
    } catch (err) {
      // W5.0/W7 — a declared-output miss must not be a dead run. Recover the key(s)
      // from the agent's OWN output, or apply/queue a structural repair, before
      // failing. Only `output_fixed` continues inline; structural outcomes
      // re-dispatch or pause the node themselves.
      const heal = node ? await this.#selfHeal.runSelfHeal(ctx, node, args.output, (err as Error).message) : { kind: 'none' as const };
      if (heal.kind === 'structural_applied' || heal.kind === 'awaiting_approval') return;
      if (heal.kind !== 'output_fixed') {
        await this.#failNode(ctx, args.nodeId, selfHealFailureMessage((err as Error).message, heal));
        void this.#tick(ctx);
        return;
      }
      output = heal.output;
    }
    // Attribute the dispatch path's tokens (estimated): the input prompt stashed
    // at dispatch + the returned output. Exact usage isn't reported by most CLI
    // harnesses, so a grounded estimate lands on the terminal node.completed entry.
    const dispatchInputTokens = ctx.nodeDispatchInputTokens?.get(args.nodeId);
    if (dispatchInputTokens !== undefined) {
      ctx.nodeDispatchInputTokens?.delete(args.nodeId);
      this.#recordNodeTokens(ctx, args.nodeId, dispatchInputTokens, estimateTokens(safeJson(args.output)));
    }
    try {
      const completedOutput = await this.#completeNode(ctx, args.nodeId, output);
      if (!completedOutput) {
        void this.#tick(ctx);
        return;
      }
      output = completedOutput;
    } catch (err) {
      await this.#failNode(ctx, args.nodeId, (err as Error).message);
      void this.#tick(ctx);
      return;
    }
    this.#enqueueSuccessfulBrainCapture(ctx, args.nodeId, output, agentId ?? null);
    // CONVERSATION THEATER: the specialist reports its result back (dispatch path).
    if (agentId && node && node.config.kind === 'agent_task') {
      this.#recordSpecialistResult(ctx, node, agentId, output);
    }
    void this.#tick(ctx);
  }






  /**
   * The owning App's id for a workflow, or null for a bare workflow. When an
   * App owns the workflow, its run's memory forms into — and is recalled from —
   * the App's brain scope (AGENTIC-APPS-10X §5.4), so an Agentic App's
   * intelligence is bound to the App and travels with it. Memoized per workflow.
   */
  #appScopeId(workspaceId: string, workflowId: string): string | null {
    const cached = this.#appScopeCache.get(workflowId);
    if (cached !== undefined) return cached;
    let appId: string | null = null;
    try {
      const row = this.deps.db
        .select({ appId: schema.workflows.appId })
        .from(schema.workflows)
        .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.id, workflowId)))
        .get();
      appId = row?.appId ?? null;
    } catch {
      appId = null;
    }
    this.#appScopeCache.set(workflowId, appId);
    return appId;
  }
  readonly #appScopeCache = new Map<string, string | null>();

























  async notifyTaskFailed(args: { runId: string; nodeId: string; error: string }): Promise<void> {
    const ctx = this.#runs.get(args.runId);
    if (!ctx) return;
    if (ctx.state.status === 'PAUSED' || isTerminalRunStatus(ctx.state.status)) return;
    const swarm = parseSwarmTaskId(args.nodeId);
    if (swarm) {
      await this.#onSwarmSubtask(ctx, swarm.nodeId, swarm.index, null, args.error);
      return;
    }
    // RELIABILITY: a bound agent/harness that hard-fails (e.g. `claude_code exited 1`,
    // a dead model pin) must not be terminal for the whole run. Re-run the task once
    // on a guaranteed workspace runtime before failing the node.
    const node = ctx.graph.nodes.find((n) => n.id === args.nodeId);
    if (node) {
      const recovered = await this.#recoverAgentNodeViaFallback(ctx, node, args.error);
      if (recovered) {
        try {
          await this.#completeNode(ctx, args.nodeId, recovered);
          void this.#tick(ctx);
          return;
        } catch (err) {
          this.deps.logger.warn('engine.agent_fallback.complete_failed', { runId: ctx.runId, nodeId: args.nodeId, err: (err as Error).message });
        }
      }
    }
    await this.#failNode(ctx, args.nodeId, args.error);
    void this.#tick(ctx);
  }

  /**
   * LAYER 1: stream an agent's live reasoning / output / tool-call during a run.
   * Called by the adapter-event bridge (bootstrap) for `agent.thinking`,
   * `task.progress`, and `agent.tool_call`. Resolves the active node (so the UI
   * attributes the thought to the right step), publishes to the run + workspace
   * rooms in the SAME shape the frontend already consumes
   * (AGENT_TERMINAL_MESSAGE / AGENT_TERMINAL_TOOL_CALL), and appends to the
   * replayable tail. This is what makes a run's thinking visible everywhere.
   */
  notifyAgentActivity(args: {
    runId: string;
    agentId?: string;
    taskId?: string;
    kind: 'thinking' | 'text' | 'tool_call' | 'tool_result';
    text?: string;
    tool?: string;
    toolInput?: unknown;
    toolResult?: unknown;
    activityId?: string;
    activityPhase?: string;
    activityStatus?: 'running' | 'success' | 'error';
    activityTitle?: string;
    transport?: string;
    attempt?: number;
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
  }): void {
    const ctx = this.#runs.get(args.runId);
    if (!ctx) return;
    const nodeId = this.#activeNodeForAgent(ctx, args.agentId, args.taskId);
    const node = nodeId ? ctx.graph.nodes.find((n) => n.id === nodeId) : undefined;
    const agentName = args.agentId
      ? this.deps.db.select({ name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, args.agentId)).get()?.name
      : undefined;
    const event = args.kind === 'tool_call' || args.kind === 'tool_result'
      ? REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL
      : REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE;
    const payload: Record<string, unknown> = {
      runId: ctx.runId,
      workflowId: ctx.workflowId,
      workspaceId: ctx.workspaceId,
      agentId: args.agentId,
      agentName,
      nodeId,
      nodeTitle: node?.title,
      activityKind: args.kind,
      activityId: args.activityId,
      activityPhase: args.activityPhase,
      activityStatus: args.activityStatus,
      activityTitle: args.activityTitle,
      transport: args.transport,
      attempt: args.attempt,
      startedAt: args.startedAt,
      completedAt: args.completedAt,
      durationMs: args.durationMs,
      at: new Date().toISOString(),
      ...(args.text ? { message: args.text } : {}),
      ...(args.tool ? { tool: args.tool, args: args.toolInput } : {}),
      ...(args.toolResult !== undefined ? { result: args.toolResult } : {}),
    };
    // Run room only: the workspace-room copy is published by `publishAdapterRealtime`
    // (bootstrap). This adds the run-scoped delivery the canvas monitor needs, with
    // the CORRECT node attribution (resolved via activeExecutions, not the taskId),
    // plus the replayable tail.
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), event, payload);
    // Also fan out to the AGENT room so "click the agent → watch it think" works:
    // the agent-detail view follows this one agent's reasoning across all its runs
    // without needing to resolve run ids. No existing surface joins the agent room,
    // so this adds no duplicate on the run/workspace views. (Reasoning parity.)
    if (args.agentId) this.deps.bus.publish(REALTIME_ROOMS.agent(args.agentId), event, payload);
    this.#appendActivityTail(ctx.runId, event, payload);
  }

  /** The node this agent/task is currently executing (for thought attribution). */
  #activeNodeForAgent(ctx: RunningContext, agentId?: string, taskId?: string): string | null {
    for (const [nodeId, exec] of Object.entries(ctx.state.activeExecutions)) {
      if (!exec) continue;
      if (taskId && exec.taskId === taskId) return nodeId;
      if (agentId && exec.executorRef === agentId) return nodeId;
    }
    // Fall back to the single active node if there's exactly one.
    const active = Object.keys(ctx.state.activeExecutions);
    return active.length === 1 ? active[0]! : null;
  }

  /** Append to the capped, in-memory replayable activity tail for a run. */
  #appendActivityTail(runId: string, event: string, payload: Record<string, unknown>): void {
    const safePayload = sanitizeRunActivityPayload(payload);
    const emittedAt = stringValue(safePayload.at) ?? new Date().toISOString();
    const activityId = stringValue(safePayload.activityId)
      ?? runActivityIdentity(event, safePayload, emittedAt);
    safePayload.activityId = activityId;
    let tail = this.#runActivity.get(runId);
    if (!tail) { tail = []; this.#runActivity.set(runId, tail); }
    const existing = tail.findIndex((item) => item.activityId === activityId);
    const envelope = { activityId, event, payload: safePayload, emittedAt };
    if (existing >= 0) tail[existing] = envelope;
    else tail.push(envelope);
    if (tail.length > RUN_ACTIVITY_TAIL_CAP) tail.splice(0, tail.length - RUN_ACTIVITY_TAIL_CAP);
    this.#persistRunActivity(runId, envelope);
  }

  #persistRunActivity(runId: string, envelope: RunActivityEnvelope): void {
    const payload = envelope.payload;
    const workspaceId = stringValue(payload.workspaceId);
    if (!workspaceId) return;
    const now = new Date().toISOString();
    const values = {
      id: randomUUID(),
      workspaceId,
      runId,
      nodeId: stringValue(payload.nodeId),
      agentId: stringValue(payload.agentId),
      activityId: envelope.activityId,
      event: envelope.event,
      kind: stringValue(payload.activityKind) ?? stringValue(payload.kind),
      phase: stringValue(payload.activityPhase) ?? stringValue(payload.phase),
      status: stringValue(payload.activityStatus) ?? stringValue(payload.status),
      title: stringValue(payload.activityTitle) ?? stringValue(payload.nodeTitle) ?? stringValue(payload.title),
      detail: clipActivityText(stringValue(payload.message) ?? stringValue(payload.detail) ?? stringValue(payload.description)),
      transport: stringValue(payload.transport),
      attempt: numberValue(payload.attempt),
      startedAt: stringValue(payload.startedAt),
      completedAt: stringValue(payload.completedAt),
      durationMs: numberValue(payload.durationMs),
      payload,
      createdAt: envelope.emittedAt,
      updatedAt: now,
    };
    try {
      this.deps.db.insert(schema.runActivityEvents).values(values).onConflictDoUpdate({
        target: [schema.runActivityEvents.runId, schema.runActivityEvents.activityId],
        set: {
          event: values.event,
          kind: values.kind,
          phase: values.phase,
          status: values.status,
          title: values.title,
          detail: values.detail,
          transport: values.transport,
          attempt: values.attempt,
          startedAt: values.startedAt,
          completedAt: values.completedAt,
          durationMs: values.durationMs,
          payload: values.payload,
          updatedAt: now,
        },
      }).run();
    } catch (err) {
      // Synthetic test runs have no workflow_runs parent. Activity must never
      // interfere with execution, but real persisted runs remain durable.
      this.deps.logger.debug?.('engine.run_activity.persist_skipped', { runId, error: (err as Error).message });
    }
  }

  /** Durable recent activity for a run, with the in-memory tail as a test fallback. */
  getRunActivity(runId: string, options: { limit?: number; cursor?: string } = {}): RunActivityEnvelope[] {
    const limit = Math.max(1, Math.min(options.limit ?? RUN_ACTIVITY_TAIL_CAP, RUN_ACTIVITY_TAIL_CAP));
    try {
      const filters = [eq(schema.runActivityEvents.runId, runId)];
      if (options.cursor) filters.push(gt(schema.runActivityEvents.createdAt, options.cursor));
      const rows = this.deps.db.select().from(schema.runActivityEvents)
        .where(and(...filters)).orderBy(asc(schema.runActivityEvents.createdAt)).limit(limit).all();
      if (rows.length > 0) return rows.map((row) => ({
        activityId: row.activityId,
        event: row.event,
        payload: recordValue(row.payload),
        emittedAt: row.createdAt,
      }));
    } catch {
      // Migration-less unit fixtures keep using the bounded in-memory tail.
    }
    return (this.#runActivity.get(runId) ?? [])
      .filter((item) => !options.cursor || item.emittedAt > options.cursor)
      .slice(0, limit);
  }

  /**
   * Drop all in-memory state for a terminated run. The activity tail is capped
   * per-run but never expired on its own, so without this the #runActivity Map
   * grows unbounded across the process lifetime (one capped tail per run, kept
   * forever). Call this anywhere a run reaches a terminal status.
   */
  #disposeRunState(runId: string): void {
    // Drop any pending coalesced flush — the terminal write already landed via
    // #transitionRunStatus, so a trailing flush would only re-write stale state.
    this.#cancelPendingPersist(runId);
    this.#runs.delete(runId);
    this.#runActivity.delete(runId);
    this.#debugRuns.delete(runId);
  }

  /** Resolve an agent's display name for conversation/activity attribution. */
  #agentName(agentId: string | null | undefined): string | undefined {
    if (!agentId) return undefined;
    return this.deps.db
      .select({ name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, agentId)).get()?.name;
  }

  /**
   * Apply a dynamic graph patch to a live run (V1-SPEC §6.6).
   *
   * Used by the planner/replan flow, in-canvas user edits, and hub package
   * updates that need to splice nodes into a running workflow. Validates
   * cycles + node references on the merged graph, increments the run's
   * `graphRevision`, persists the merged graph only to the run snapshot,
   * mutates the live `RunningContext.graph` so subsequent ticks see the
   * change, and emits `workflow.graph_patched` on the run room.
   */
  async applyGraphPatch(args: {
    runId: string;
    patch: WorkflowGraphPatch;
  }): Promise<{ newRevision: number }> {
    const { runId, patch } = args;
    const ctx = this.#runs.get(runId);
    const run = await this.deps.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .get();
    if (!run) {
      throw new AgentisError('WORKFLOW_RUN_NOT_FOUND', `Run ${runId} not found`);
    }
    const currentState = run.runState as unknown as WorkflowRunState;
    const currentRevision = ctx?.state.graphRevision ?? currentState.graphRevision;
    if (patch.baseGraphRevision !== currentRevision) {
      throw new AgentisError(
        'GRAPH_REVISION_CONFLICT',
        `Patch baseGraphRevision ${patch.baseGraphRevision} does not match current ${currentRevision}`,
        { details: { current: currentRevision, base: patch.baseGraphRevision } },
      );
    }

    const baseGraph = ctx?.graph
      ?? (run.graphSnapshot as WorkflowGraph | null)
      ?? (run.workflowId ? this.#loadWorkflowGraph(run.workflowId) : null);
    if (!baseGraph) {
      throw new AgentisError('WORKFLOW_RUN_INVALID_STATE', 'Run has no saved workflow or graph snapshot to patch');
    }
    let merged: WorkflowGraph;
    try {
      merged = mergeGraphPatch(baseGraph, patch);
    } catch (err) {
      throw new AgentisError('GRAPH_PATCH_INVALID', (err as Error).message);
    }
    try {
      validateWorkflowGraph(merged, { currentWorkflowId: run.workflowId });
    } catch (err) {
      // Re-throw as GRAPH_PATCH_INVALID so callers can distinguish cycles
      // discovered at patch-apply time from at-rest WORKFLOW_GRAPH_INVALID.
      const msg = err instanceof AgentisError ? err.message : (err as Error).message;
      throw new AgentisError('GRAPH_PATCH_INVALID', msg);
    }

    const newRevision = currentRevision + 1;

    // Run-local repair/evolution is deliberately isolated. A successful terminal
    // run may create a candidate revision, but only clean verification can
    // promote it; this method never mutates the active workflow.
    await this.deps.db
      .update(schema.workflowRuns)
      .set({
        graphSnapshot: merged as unknown as object,
        repairedFromRevisionId: run.repairedFromRevisionId ?? run.workflowRevisionId ?? null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workflowRuns.id, run.id));

    if (ctx) {
      ctx.graph = merged;
      ctx.repairedFromRevisionId ??= run.repairedFromRevisionId ?? run.workflowRevisionId ?? null;
      ctx.downstreamEdges = buildDownstreamEdges(merged);
      ctx.state.graphRevision = newRevision;
      await this.#persistRun(ctx);
    } else {
      const nextState: WorkflowRunState = { ...currentState, graphRevision: newRevision };
      await this.deps.db
        .update(schema.workflowRuns)
        .set({
          runState: nextState as unknown as object,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.workflowRuns.id, runId));
    }

    this.deps.bus.publish(REALTIME_ROOMS.run(runId), REALTIME_EVENTS.WORKFLOW_GRAPH_PATCHED, {
      runId,
      workflowId: run.workflowId ?? null,
      patchId: patch.patchId,
      reason: patch.reason,
      newRevision,
    });

    this.deps.activity.record({
      workspaceId: run.workspaceId,
      ambientId: run.ambientId,
      userId: run.userId,
      eventType: 'workflow.graph_patched',
      actorType: 'system',
      actorId: 'engine',
      entityType: 'workflow_run',
      entityId: runId,
      summary: `Graph patched (${patch.reason}) → revision ${newRevision}`,
      metadata: {
        patchId: patch.patchId,
        addNodes: patch.addNodes.length,
        updateNodes: patch.updateNodes.length,
        removeNodes: patch.removeNodeIds.length,
      },
    });

    return { newRevision };
  }

  /**
   * ORGAN 3 / AGENT-PRIMARY M1 — evolve a LIVE run's graph through the contract
   * transaction. Unlike raw {@link applyGraphPatch} (which only checks revision +
   * structure), this runs the full green ratchet: an evolution that breaks a data
   * coupling (Organ 1), forces an approval bypass (Organ 2), or removes the
   * running/completed spine is REJECTED with named regressions the agent can fix
   * and re-propose — it never corrupts the graph. Authority-gated: `operator`
   * mode (deterministic) refuses agent self-evolution; the agent modes commit
   * within the ratchet. On commit it reuses `applyGraphPatch` (the proven
   * validate+persist+revision+audit primitive) so there is one commit path.
   */
  async evolveGraph(args: {
    runId: string;
    patch: WorkflowGraphPatch;
    /** Override the resolved authority (tests / operator route). */
    authority?: 'operator' | 'agent_within_green' | 'agent';
    actorId?: string;
  }): Promise<EvolveResult> {
    const { runId } = args;
    function reject(rejected: 'regression' | 'authority' | 'conflict' | 'invalid', regressions: EvolutionRegression[]): EvolveResult {
      return { committed: false, rejected, regressions };
    }
    const run = await this.deps.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
    if (!run) return reject('invalid', [{ code: 'STRUCTURAL', message: `Run ${runId} not found` }]);

    const ctx = this.#runs.get(runId);
    const currentState = run.runState as unknown as WorkflowRunState;
    const currentRevision = ctx?.state.graphRevision ?? currentState.graphRevision ?? 0;

    // Normalize the patch (the MCP-harness caller may omit arrays) + stamp the
    // current revision and reason — the agent authors shape, not bookkeeping.
    const patch: WorkflowGraphPatch = {
      patchId: typeof args.patch.patchId === 'string' && args.patch.patchId ? args.patch.patchId : randomUUID(),
      reason: 'agent_evolve',
      baseGraphRevision: currentRevision,
      addNodes: Array.isArray(args.patch.addNodes) ? args.patch.addNodes : [],
      updateNodes: Array.isArray(args.patch.updateNodes) ? args.patch.updateNodes : [],
      removeNodeIds: Array.isArray(args.patch.removeNodeIds) ? args.patch.removeNodeIds : [],
      addEdges: Array.isArray(args.patch.addEdges) ? args.patch.addEdges : [],
      removeEdgeIds: Array.isArray(args.patch.removeEdgeIds) ? args.patch.removeEdgeIds : [],
    };

    // Workflow settings carry the intent manifest (Organ 2 baseline) + any pinned authority.
    const wf = run.workflowId
      ? this.deps.db.select().from(schema.workflows).where(eq(schema.workflows.id, run.workflowId)).get()
      : undefined;
    const settings = (wf?.settings ?? {}) as { intentManifest?: IntentManifest; evolutionAuthority?: unknown; executionMode?: unknown };
    const authority = args.authority
      ?? resolveEvolutionAuthority(this.deps.db, run.workspaceId, settings);

    if (authority === 'operator') {
      return reject('authority', [{
        code: 'STRUCTURAL',
        message:
          'This workflow runs in deterministic (operator) mode — an agent cannot self-evolve the graph. '
          + 'Flag a deviation with your proposed change instead, or the operator can raise the evolution authority.',
      }]);
    }

    const baseGraph = ctx?.graph
      ?? (run.graphSnapshot as WorkflowGraph | null)
      ?? (run.workflowId ? this.#loadWorkflowGraph(run.workflowId) : null);
    if (!baseGraph) return reject('invalid', [{ code: 'STRUCTURAL', message: 'Run has no graph to evolve' }]);

    // Never let an evolution rewrite the spine that is already running or done —
    // check the live ctx first, else the persisted run state (parked runs).
    const nodeStates = ctx?.state.nodeStates ?? currentState.nodeStates ?? {};
    for (const removeId of patch.removeNodeIds) {
      const st = nodeStates[removeId]?.status;
      if (st === 'COMPLETED' || st === 'RUNNING') {
        return reject('regression', [{
          code: 'IMMUTABLE_NODE', nodeId: removeId,
          message: `Cannot remove node '${removeId}': it is already ${st.toLowerCase()}. Evolve the plan AHEAD of what has run, not behind it.`,
        }]);
      }
    }

    // Outward/irreversible new step: under agent_within_green it must not
    // auto-commit — that is an operator decision (full `agent` authority allows).
    if (authority === 'agent_within_green') {
      const outward = firstOutwardNode(patch.addNodes);
      if (outward) {
        return reject('authority', [{
          code: 'STRUCTURAL', nodeId: outward.id,
          message:
            `Node '${outward.id}' performs an outward/irreversible action (integration or external write). `
            + 'In green-guarded mode you cannot auto-commit an outward step — flag a deviation with this proposal for operator approval, '
            + 'or evolve only the internal steps and route the outward action through an existing approval checkpoint.',
        }]);
      }
    }

    let merged: WorkflowGraph;
    try {
      merged = mergeGraphPatch(baseGraph, patch);
    } catch (err) {
      return reject('invalid', [{ code: 'STRUCTURAL', message: (err as Error).message }]);
    }
    try {
      validateWorkflowGraph(merged, { currentWorkflowId: run.workflowId });
    } catch (err) {
      return reject('regression', [{ code: 'STRUCTURAL', message: err instanceof AgentisError ? err.message : (err as Error).message }]);
    }

    // The green ratchet (Organ 1 + Organ 2), diffed against the base graph.
    const decision = evaluateEvolution(baseGraph, merged, settings.intentManifest ?? null);
    if (!decision.ok) return reject('regression', decision.regressions);

    // Commit through the one proven path.
    let newRevision: number;
    try {
      ({ newRevision } = await this.applyGraphPatch({ runId, patch }));
    } catch (err) {
      const code = err instanceof AgentisError ? err.code : 'UNKNOWN';
      return reject(code === 'GRAPH_REVISION_CONFLICT' ? 'conflict' : 'invalid', [{
        code: 'STRUCTURAL', message: err instanceof AgentisError ? err.message : (err as Error).message,
      }]);
    }

    // M6 — snapshot the pre-evolve graph so an operator can one-click revert via
    // the existing rollbackSelfHeal path (reuses the repair-checkpoint table +
    // rollback mechanism; the synthetic incident/plan ids just satisfy its NOT NULL
    // columns — a missing incident is handled gracefully on rollback).
    try {
      await this.deps.db.insert(schema.workflowRepairCheckpoints).values({
        id: randomUUID(),
        workspaceId: run.workspaceId,
        runId,
        workflowId: run.workflowId || null,
        incidentId: 'evolve',
        planId: `evolve:${patch.patchId}`,
        revisionBefore: currentRevision,
        revisionAfter: newRevision,
        graphBefore: baseGraph as unknown as object,
        graphAfter: merged as unknown as object,
        patch: patch as unknown as object,
      });
    } catch (err) {
      this.deps.logger.warn('engine.evolve.checkpoint_failed', { runId, err: (err as Error).message });
    }

    // Seed run bookkeeping for the new nodes (applyGraphPatch updates
    // ctx.graph/downstreamEdges but not nodeStates/waitingInputs). Without a
    // waiting buffer keyed on its incoming edges, a completing upstream's fan-out
    // finds no target to promote and the evolved node is silently orphaned —
    // mirror buildInitialRunState so the new node joins the live dataflow.
    if (ctx) {
      const incomingByTarget = new Map<string, string[]>();
      const addedIds = new Set(patch.addNodes.map((n) => n.id));
      for (const e of ctx.graph.edges) {
        if (!addedIds.has(e.target)) continue;
        const list = incomingByTarget.get(e.target) ?? [];
        list.push(e.source);
        incomingByTarget.set(e.target, list);
      }
      for (const added of patch.addNodes) {
        if (ctx.state.nodeStates[added.id]) continue; // never clobber existing state
        ctx.state.nodeStates[added.id] = { nodeId: added.id, status: 'PENDING' };
        const incoming = incomingByTarget.get(added.id) ?? [];
        if (incoming.length === 0) {
          ctx.state.readyQueue.push({ nodeId: added.id, priority: 0, insertedAt: new Date().toISOString(), inputData: {} });
          continue;
        }
        const buffer = { requiredInputs: incoming.slice(), receivedInputs: {} as Record<string, unknown>, sourceNodeIds: incoming.slice() };
        // Absorb any upstream that ALREADY completed before this evolution, so a
        // node wired behind finished work is promoted instead of hanging forever.
        for (const src of incoming) {
          const ss = ctx.state.nodeStates[src];
          if (ss?.status === 'COMPLETED') {
            buffer.receivedInputs[src] = ss.outputData ?? {};
            buffer.requiredInputs = buffer.requiredInputs.filter((id) => id !== src);
          }
        }
        ctx.state.waitingInputs[added.id] = buffer;
        this.#promoteOrSkipTarget(ctx, added.id, 'Skipped: evolved node has no reachable input');
      }
      await this.#persistRun(ctx);
    }

    this.deps.logger.info('engine.evolve.committed', {
      runId, authority, newRevision,
      added: patch.addNodes.length, edges: patch.addEdges.length, warnings: decision.warnings.length,
    });
    return { committed: true, newRevision, contractSummary: summarizeContract(merged), warnings: decision.warnings };
  }

  /** Roll back the newest unapplied self-healing checkpoint without clobbering later edits. */
  async rollbackSelfHeal(args: { runId: string; checkpointId: string }): Promise<{ newRevision: number }> {
    const ctx = this.#runs.get(args.runId) ?? this.#ensureRecoveredCtx(args.runId);
    if (!ctx) throw new AgentisError('WORKFLOW_RUN_NOT_FOUND', `Run ${args.runId} not found`);
    const checkpoint = this.deps.db
      .select()
      .from(schema.workflowRepairCheckpoints)
      .where(and(eq(schema.workflowRepairCheckpoints.id, args.checkpointId), eq(schema.workflowRepairCheckpoints.runId, args.runId)))
      .get();
    if (!checkpoint || checkpoint.rolledBackAt) throw new AgentisError('RESOURCE_NOT_FOUND', 'Repair checkpoint is unavailable');
    if ((ctx.state.graphRevision ?? 0) !== checkpoint.revisionAfter) {
      throw new AgentisError('GRAPH_REVISION_CONFLICT', 'Only the latest graph repair can be rolled back safely');
    }
    const current = ctx.graph;
    const expected = checkpoint.graphAfter as unknown as WorkflowGraph;
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new AgentisError('GRAPH_REVISION_CONFLICT', 'The workflow changed after this repair; rollback would overwrite newer work');
    }
    const patch = graphDiffPatch(current, checkpoint.graphBefore as unknown as WorkflowGraph, ctx.state.graphRevision ?? 0);
    const result = await this.applyGraphPatch({ runId: args.runId, patch });
    const now = new Date().toISOString();
    await this.deps.db.update(schema.workflowRepairCheckpoints)
      .set({ rolledBackAt: now, updatedAt: now })
      .where(eq(schema.workflowRepairCheckpoints.id, checkpoint.id));
    const incident = Object.values(ctx.state.selfHealIncidents ?? {}).find((item) => item.plans?.some((plan) => plan.id === checkpoint.planId));
    if (incident) {
      const node = ctx.graph.nodes.find((candidate) => candidate.id === incident.nodeId) ?? {
        id: incident.nodeId,
        title: incident.nodeTitle ?? incident.nodeId,
      } as WorkflowNode;
      this.#selfHeal.completeRepairPlan(ctx, node, checkpoint.planId, 'rolled_back', checkpoint.id);
      this.#selfHeal.recordSelfHealIncident(ctx, node, { status: 'ROLLED_BACK', outcome: 'rolled_back', checkpointId: checkpoint.id, reason: 'The latest self-healing repair was rolled back by the operator.' });
      await this.#persistRun(ctx);
    }
    await this.deps.ledger.append({
      workspaceId: ctx.workspaceId, ambientId: ctx.ambientId, runId: ctx.runId,
      eventType: 'self_heal.rolled_back', nodeId: incident?.nodeId,
      payload: { checkpointId: checkpoint.id, planId: checkpoint.planId },
    }).catch(() => {});
    return result;
  }

  #loadWorkflowGraph(workflowId: string): WorkflowGraph {
    const wf = this.deps.db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.id, workflowId))
      .get();
    if (!wf) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `Workflow ${workflowId} not found`);
    }
    return wf.graph as unknown as WorkflowGraph;
  }

  // ────────────────────────────────────────────────────────────
  // Dispatch loop
  // ────────────────────────────────────────────────────────────

  async #tick(ctx: RunningContext): Promise<void> {
    if (ctx.cancellationRequested || isTerminalRunStatus(ctx.state.status)) return;
    if (ctx.state.status !== 'RUNNING' && ctx.state.status !== 'WAITING') return;

    return await this.#telemetry.span(
      'engine.tick',
      async () => this.#tickBody(ctx),
      { 'agentis.run_id': ctx.runId, 'agentis.workflow_id': ctx.workflowId },
    );
  }

  async #tickBody(ctx: RunningContext): Promise<void> {
    const parallelism = resolveParallelism();
    while (
      ctx.state.readyQueue.length > 0 &&
      Object.keys(ctx.state.activeExecutions).length < parallelism
    ) {
      const item = ctx.state.readyQueue.shift()!;
      const node = ctx.graph.nodes.find((n) => n.id === item.nodeId);
      if (!node) {
        this.deps.logger.warn('engine.tick.unknown_node', { runId: ctx.runId, nodeId: item.nodeId });
        continue;
      }
      const readiness = this.#dispatchReadiness(ctx, node.id);
      if (readiness.kind === 'waiting') {
        ctx.state.waitingInputs[node.id] = readiness.buffer;
        continue;
      }
      if (readiness.kind === 'skipped') {
        this.#skipUnreachable(ctx, node.id, readiness.reason);
        continue;
      }
      ctx.inflightDispatches += 1;
      void this.#dispatchNode(ctx, node, item)
        .then(() => {
          ctx.inflightDispatches -= 1;
          void this.#tick(ctx);
        })
        .catch(async (err) => {
          try {
            // Failure bookkeeping is part of the dispatch lifecycle. Keep this
            // chain in-flight until failed/skipped/error-edge state is durable.
            await this.#failNode(ctx, node.id, (err as Error).message);
          } finally {
            ctx.inflightDispatches -= 1;
          }
          await this.#tick(ctx);
        });
    }

    // Settle: if no active executions, no in-flight dispatch chains, no
    // waiting inputs left to receive, and ready queue is empty, the run is
    // done. The inflightDispatches counter prevents settling mid-dispatch
    // for passthrough nodes (trigger/merge/router/scratchpad) which never
    // register in activeExecutions.
    if (
      ctx.state.readyQueue.length === 0 &&
      Object.keys(ctx.state.activeExecutions).length === 0 &&
      ctx.inflightDispatches === 0
    ) {
      if (ctx.budgetHalt) {
        this.#skipBlockedNodes(ctx, 'Skipped: phase budget exceeded');
        await this.#transitionRunStatus(ctx, 'FAILED');
        this.#disposeRunState(ctx.runId);
      } else if (ctx.state.failedNodeIds.length > 0) {
        this.#skipBlockedNodes(ctx, 'Skipped because an upstream node failed');
        await this.#transitionRunStatus(ctx, 'FAILED');
        this.#disposeRunState(ctx.runId);
      } else {
        // A run is still waiting if a downstream node is blocked on inputs OR a
        // node is itself parked WAITING (a checkpoint/phase-gate/agent_session
        // yield). The latter matters when the parked node is terminal — there is
        // no downstream waitingInput to hold the run open, so without this check
        // a parked terminal session would wrongly settle to COMPLETED.
        const stillWaiting =
          Object.values(ctx.state.waitingInputs).some((b) => b.requiredInputs.length > 0) ||
          Object.values(ctx.state.nodeStates).some((n) => n.status === 'WAITING');
        if (!stillWaiting) {
          await this.#transitionRunStatus(ctx, 'COMPLETED');
          this.#disposeRunState(ctx.runId);
        } else {
          await this.#transitionRunStatus(ctx, 'WAITING');
        }
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  // Per-node dispatch
  // ────────────────────────────────────────────────────────────

  #dispatchReadiness(
    ctx: RunningContext,
    nodeId: string,
  ): { kind: 'ready' } | { kind: 'waiting'; buffer: WorkflowRunState['waitingInputs'][string] } | { kind: 'skipped'; reason: string } {
    const nodeState = ctx.state.nodeStates[nodeId];
    if (!nodeState) return { kind: 'skipped', reason: 'Skipped: node state is missing' };
    if (nodeState.status !== 'PENDING') {
      return { kind: 'skipped', reason: `Skipped: node is already ${nodeState.status.toLowerCase()}` };
    }

    const incoming = ctx.graph.edges.filter((edge) => edge.target === nodeId);
    if (incoming.length === 0) return { kind: 'ready' };

    const requiredInputs: string[] = [];
    const receivedInputs: Record<string, unknown> = {};
    let blockedByCondition = false;
    // P0.1: lazily-built condition scope base (built once, only if a conditional
    // edge is present); `condScopeFor` layers each source's output on top.
    let condBase: Record<string, unknown> | null = null;
    const condScopeFor = (data: Record<string, unknown>) =>
      withCurrentData((condBase ??= this.#buildConditionScopeBase(ctx)), data);

    for (const edge of incoming) {
      const sourceState = ctx.state.nodeStates[edge.source];
      if (edge.type === 'error') {
        if (
          sourceState?.status === 'FAILED'
          || (sourceState?.status === 'COMPLETED' && Boolean(sourceState.error))
        ) {
          receivedInputs[edge.source] = sourceState.outputData ?? {};
        } else if (sourceState && sourceState.status !== 'COMPLETED' && sourceState.status !== 'SKIPPED') {
          requiredInputs.push(edge.source);
        }
        continue;
      }

      if (sourceState?.status === 'COMPLETED') {
        const srcOut = sourceState.outputData ?? {};
        if (shouldTraverseEdge(edge, srcOut, () => condScopeFor(srcOut))) {
          receivedInputs[edge.source] = srcOut;
        } else {
          blockedByCondition = true;
        }
        continue;
      }

      if (!sourceState || (sourceState.status !== 'FAILED' && sourceState.status !== 'SKIPPED')) {
        requiredInputs.push(edge.source);
      }
    }

    const buffer = {
      requiredInputs: [...new Set(requiredInputs)],
      receivedInputs,
      sourceNodeIds: [...new Set(incoming.map((edge) => edge.source))],
    };

    // Nothing can ever feed this node (every upstream skipped / branch untaken
    // and none delivered) — it's unreachable regardless of join policy.
    if (buffer.requiredInputs.length === 0 && Object.keys(receivedInputs).length === 0) {
      return {
        kind: 'skipped',
        reason: blockedByCondition
          ? 'Skipped: branch condition not met'
          : 'Skipped: upstream path never produced an input',
      };
    }

    // Apply the node's join policy. A `merge` node may declare an OR-join
    // ('any' — fire on the first arrival) or a subset-join (string[]); every
    // other kind uses the default AND-join. When already satisfied at first
    // evaluation (an upstream completed before this node was dequeued), go
    // straight to ready instead of parking in waitingInputs.
    const node = ctx.graph.nodes.find((n) => n.id === nodeId);
    if (this.#joinSatisfied(ctx, node, buffer)) {
      return { kind: 'ready' };
    }

    return { kind: 'waiting', buffer };
  }

  /**
   * Decide whether a waiting node's join gate is satisfied. The default is an
   * AND-join ('all'): every required input must have arrived. A `merge` node may
   * instead declare:
   *   - 'any'    → OR-join: fire on the FIRST arriving input (race / first-wins).
   *   - string[] → subset-join: fire once the listed sources have all arrived,
   *                or once no further inputs can arrive (fire with what we have
   *                rather than hang). Sources outside the list don't gate.
   * Every node kind other than `merge` always uses the AND-join.
   */
  #joinSatisfied(
    ctx: RunningContext,
    node: WorkflowNode | undefined,
    buf: { requiredInputs: string[]; receivedInputs: Record<string, unknown> },
  ): boolean {
    const policy = this.#resolveJoinPolicy(ctx, node).requiredInputs;
    if (policy === 'any') {
      return Object.keys(buf.receivedInputs).length > 0;
    }
    if (Array.isArray(policy)) {
      if (policy.length > 0 && policy.every((src) => src in buf.receivedInputs)) return true;
      // No listed source can still arrive → don't block the run forever.
      return buf.requiredInputs.length === 0;
    }
    return buf.requiredInputs.length === 0;
  }

  /**
   * Resolve the effective join behaviour for a node. Only `merge` nodes carry a
   * policy; everything else uses the defaults. A `merge` is usually the point
   * where a `parallel` fan-out reconverges, so — without forcing the user to
   * duplicate config — the merge INHERITS its nearest upstream `parallel` node's
   * `waitFor` / `onBranchError` / `mergeStrategy`. The merge's own `requiredInputs`
   * (when set to something other than the default `'all'`) always wins for the
   * join COUNT; the parallel only fills in the gaps. This is what makes a
   * `parallel` node's settings actually do something instead of being inert
   * canvas decoration.
   */
  #resolveJoinPolicy(
    ctx: RunningContext,
    node: WorkflowNode | undefined,
  ): {
    requiredInputs: 'all' | 'any' | string[];
    mergeStrategy: 'merge_keys' | 'collect_all' | 'first_non_null';
    onError: 'fail' | 'continue';
  } {
    if (node?.config.kind !== 'merge') {
      return { requiredInputs: 'all', mergeStrategy: 'merge_keys', onError: 'fail' };
    }
    const mergeCfg = node.config as MergeNodeConfig;
    const parallel = this.#parallelForMerge(ctx, mergeCfg, node.id);
    const requiredInputs = mergeCfg.requiredInputs !== 'all'
      ? mergeCfg.requiredInputs
      : parallel?.waitFor === 'first'
        ? 'any'
        : 'all';
    return {
      requiredInputs,
      mergeStrategy: parallel?.mergeStrategy ?? 'merge_keys',
      onError: parallel?.onBranchError === 'continue_with_results' ? 'continue' : 'fail',
    };
  }

  /**
   * The `parallel` whose policy governs a merge: the explicitly-bound
   * `parallelSourceId` when it resolves to a parallel node, otherwise the
   * nearest upstream parallel (heuristic). Explicit binding removes the
   * ambiguity in diamond / nested fan-ins.
   */
  #parallelForMerge(ctx: RunningContext, mergeCfg: MergeNodeConfig, mergeNodeId: string): ParallelNodeConfig | undefined {
    if (mergeCfg.parallelSourceId) {
      const named = ctx.graph.nodes.find((n) => n.id === mergeCfg.parallelSourceId);
      if (named?.config.kind === 'parallel') return named.config as ParallelNodeConfig;
      // Bound but unresolvable (stale id / not a parallel) → fall back, don't break.
    }
    return this.#nearestUpstreamParallel(ctx, mergeNodeId);
  }

  /** Nearest `parallel` ancestor of a node (BFS backward through edges), if any. */
  #nearestUpstreamParallel(ctx: RunningContext, startId: string): ParallelNodeConfig | undefined {
    const visited = new Set<string>([startId]);
    let frontier = ctx.graph.edges.filter((e) => e.target === startId).map((e) => e.source);
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        if (visited.has(id)) continue;
        visited.add(id);
        const n = ctx.graph.nodes.find((nn) => nn.id === id);
        if (n?.config.kind === 'parallel') return n.config as ParallelNodeConfig;
        for (const e of ctx.graph.edges) if (e.target === id) next.push(e.source);
      }
      frontier = next;
    }
    return undefined;
  }

  /**
   * Re-evaluate a waiting node's join gate after one of its incoming edges
   * resolved (delivered an input, was dropped as an untaken branch, or the
   * source was skipped). Promotes the node to the ready queue when its join
   * policy is satisfied, or skip-cascades it when it can never be fed. Replaces
   * the duplicated "if requiredInputs is empty" promote/skip blocks so the
   * non-default join policies ('any' / subset) are honored everywhere a buffer
   * is drained — and fixes the latent AND-join hang where a merge fed by both a
   * success edge and a (dropped) error edge could end up with no required inputs
   * left yet never get promoted.
   */
  #promoteOrSkipTarget(ctx: RunningContext, targetId: string, skipReason: string): void {
    const buf = ctx.state.waitingInputs[targetId];
    if (!buf) return;
    const node = ctx.graph.nodes.find((n) => n.id === targetId);
    if (this.#joinSatisfied(ctx, node, buf)) {
      if (Object.keys(buf.receivedInputs).length === 0) {
        // Satisfied only because nothing more can arrive, and nothing did.
        this.#skipUnreachable(ctx, targetId, skipReason);
        return;
      }
      ctx.state.readyQueue.push({
        nodeId: targetId,
        priority: 0,
        insertedAt: new Date().toISOString(),
        inputData: mergeBufferedInputs(buf, this.#resolveJoinPolicy(ctx, node).mergeStrategy),
      });
      delete ctx.state.waitingInputs[targetId];
      return;
    }
    // Still waiting on inputs that can yet arrive. Only when none can — and none
    // did — is the node unreachable.
    if (buf.requiredInputs.length === 0 && Object.keys(buf.receivedInputs).length === 0) {
      this.#skipUnreachable(ctx, targetId, skipReason);
    }
  }

  async #dispatchNode(
    ctx: RunningContext,
    node: WorkflowNode,
    item: ReadyQueueItem,
  ): Promise<void> {
    // A queued/retry dispatch may wake after cancel. Never start new work once
    // the run has crossed the cancellation fence.
    if (ctx.cancellationRequested || isTerminalRunStatus(ctx.state.status)) return;
    // Infinite-cycle backstop (masterplan 1.4): cap how many times any single
    // node may be dispatched in one run. An author-wired retry cycle, a runaway
    // self-heal/retry, or a planner-spliced loop could otherwise re-dispatch a
    // node without bound, burning unlimited LLM/IO cost. The ceiling is generous;
    // legit retries cap far lower. Hitting it fails the RUN (not a retryable node
    // failure) so it cannot itself re-enter the cycle.
    const dispatchCounts = this.#nodeDispatchCounts(ctx);
    const dispatchCount = (dispatchCounts.get(node.id) ?? 0) + 1;
    dispatchCounts.set(node.id, dispatchCount);
    const dispatchState = ctx.state.nodeStates[node.id];
    if (dispatchState) dispatchState.attempt = dispatchCount;
    const ceiling = nodeDispatchCeiling();
    if (dispatchCount > ceiling) {
      const ns = ctx.state.nodeStates[node.id];
      if (ns) {
        ns.status = 'FAILED';
        ns.error = `node dispatch ceiling exceeded (${ceiling}) — likely an infinite cycle`;
      }
      delete ctx.state.activeExecutions[node.id];
      this.deps.logger.warn('engine.node_dispatch_ceiling', { runId: ctx.runId, nodeId: node.id, count: dispatchCount, ceiling });
      await this.#transitionRunStatus(ctx, 'FAILED');
      return;
    }

    // Layer 5 human gate: hold the node before it starts if its phase requires
    // approval and the gate hasn't been granted yet. The downstream nodes stay in
    // waitingInputs, so the run settles to WAITING (not COMPLETED) until approved.
    if (await this.#maybeHoldForPhaseGate(ctx, node, item)) return;

    await this.#startNode(ctx, node, item.inputData);

    // Build template context once per dispatch and resolve every templated
    // field in the node's config before any handler sees it. Handlers that
    // need the raw value (transform/filter expressions, evaluator targetPath,
    // workflow_store keys/values) re-read from the original config and call
    // `readTemplatePath()` directly to avoid double-encoding.
    const tctx = this.#buildTemplateContext(ctx, item);
    const resolvedConfig = resolveTemplateDeep(node.config, tctx);

    // NATIVE-ADVANCEMENT Proposal 4: pure node kinds (transform, filter, …) are
    // resolved by the handler registry instead of this switch. They re-read the
    // RAW config (not the template-resolved one) + the template context.
    const pureHandler = this.#nodeHandlers.get(node.config.kind);
    if (pureHandler) {
      let result: Record<string, unknown>;
      try {
        result = pureHandler.execute(node.config, { inputData: item.inputData, tctx });
      } catch (err) {
        // Phase 2 rung 0 — deterministic, zero-token expression repair. A
        // transform/filter that throws on an off-contract reference (`noeds`,
        // a near-miss typo) is fixed in-place and retried BEFORE we spend a
        // single self-heal token. Anything we can't confidently fix re-throws
        // into the normal failure / self-heal path.
        result = this.#repairAndRetryPureNode(ctx, node, item, tctx, pureHandler, err as Error);
      }
      await this.#completeNode(ctx, node.id, result);
      return;
    }

    switch (node.config.kind) {
      case 'trigger': {
        // Triggers are pure pass-throughs at run time — they were the seed.
        await this.#completeNode(ctx, node.id, item.inputData);
        return;
      }
      case 'scratchpad': {
        const result = await this.#executeScratchpadNode(ctx, resolvedConfig as ScratchpadNodeConfig, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'merge': {
        // Merge node passes through the union of received inputs.
        await this.#completeNode(ctx, node.id, item.inputData);
        return;
      }
      case 'router': {
        const cfg = resolvedConfig as RouterNodeConfig;
        if (cfg.routingMode === 'llm_route') {
          const branchOutputs = await this.#executors.executeRouterLlm(ctx, node, cfg, item.inputData);
          await this.#completeNode(ctx, node.id, { branches: branchOutputs });
        } else {
          const branchOutputs = this.#executors.executeRouter(ctx, cfg, item.inputData);
          await this.#completeNode(ctx, node.id, { branches: branchOutputs });
        }
        return;
      }
      case 'checkpoint': {
        await this.#executeCheckpoint(ctx, node, resolvedConfig as CheckpointNodeConfig, item.inputData);
        return;
      }
      case 'human_input': {
        await this.#executeHumanInput(ctx, node, resolvedConfig as HumanInputNodeConfig, item.inputData);
        return;
      }
      case 'extension_task': {
        const result = await this.#executeExtensionTask(ctx, node, resolvedConfig as ExtensionTaskNodeConfig, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'component_task': {
        const result = await this.#executeComponentTask(ctx, node, resolvedConfig as ComponentTaskNodeConfig, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'knowledge': {
        const result = await this.#executeKnowledgeNode(ctx, resolvedConfig as KnowledgeNodeConfig, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'knowledge_ingest': {
        const result = await this.#executeKnowledgeIngestNode(ctx, resolvedConfig as KnowledgeIngestNodeConfig, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'agent_task': {
        // SPECIALISTS-10X demand router: when the task names no concrete
        // specialist, score + select one (and record an explainable decision)
        // instead of silently dispatching a generic agent.
        const agentCfg = await this.#maybeRouteSpecialist(ctx, node, resolvedConfig as AgentTaskNodeConfig);
        // SMARTER-AGENTS-10X: a role/capability-resolved specialist runs as a
        // full persistent AgentSession by DEFAULT — working memory, sub-agent
        // delegation, and zero-cost yield/sleep — not a one-shot completion. This
        // is the autonomy unlock: agent_task and agent_session converge unless the
        // node opts out or an explicitly-bound agent owns its own runtime.
        if (this.#shouldRunAsSession(ctx, agentCfg)) {
          await this.#runAgentSession(ctx, node, agentTaskAsSession(agentCfg), item.inputData);
          return;
        }
        // §2.2 agentic tool-use loop: when the session runtime is unavailable (no
        // evaluation model wired), run in-process against the role-scoped tool
        // runtime and complete synchronously. Otherwise fall through to the
        // external-adapter dispatch (async completion).
        if (await this.#maybeRunAgentToolLoop(ctx, node, agentCfg, item.inputData)) return;
        await this.#dispatchAgentTask(ctx, node, agentCfg, item.inputData);
        return; // adapter event will call notifyTaskCompleted
      }
      case 'agent_session': {
        await this.#runAgentSession(ctx, node, resolvedConfig as AgentSessionNodeConfig, item.inputData);
        return; // session yields/completion resolve the node async
      }
      case 'dynamic_swarm': {
        await this.#runDynamicSwarm(ctx, node, resolvedConfig as DynamicSwarmNodeConfig, item.inputData);
        return;
      }
      case 'planner': {
        await this.#runPlanner(ctx, node, resolvedConfig as PlannerNodeConfig, item.inputData);
        return;
      }
      case 'agent_swarm': {
        await this.#dispatchAgentSwarm(ctx, node, resolvedConfig as AgentSwarmNodeConfig, item.inputData);
        return; // swarm subtask events resolve the node
      }
      case 'artifact_collect': {
        const result = await this.#executeArtifactCollect(ctx, node, resolvedConfig as ArtifactCollectNodeConfig, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'wait': {
        await this.#executeWait(ctx, node, resolvedConfig as WaitNodeConfig, item.inputData);
        return;
      }
      // transform + filter are handled by the node handler registry above.
      case 'return_output': {
        const result = this.#executeReturnOutput(node.config as ReturnOutputNodeConfig, item.inputData, tctx);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'artifact_save': {
        const result = await this.#executeArtifactSave(ctx, node, resolvedConfig as ArtifactSaveNodeConfig, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'browser': {
        const result = await this.#executors.executeBrowser(ctx, node, resolvedConfig as BrowserNodeConfig, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'integration': {
        const integrationConfig = resolvedConfig as IntegrationNodeConfig;
        const result = await this.#executors.executeIntegration(ctx, node, integrationConfig, item.inputData);
        const receipt = buildIntegrationDeliveryReceipt(
          integrationConfig.integrationId,
          integrationConfig.operationId,
          integrationConfig.inputs ?? {},
        );
        if (receipt) {
          ctx.state.nodeStates[node.id]!.deliveryReceipt = {
            ...receipt,
            capturedAt: new Date().toISOString(),
          };
        }
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'mcp': {
        const result = await this.#executors.executeMcp(ctx, node, resolvedConfig as McpNodeConfig);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'channel': {
        const result = await this.#executors.executeChannelSend(
          ctx,
          node,
          resolvedConfig as ChannelSendNodeConfig,
          item.idempotencyKey ?? nodeIdempotencyKey(ctx.runId, node.id, 0),
        );
        const key = (resolvedConfig as ChannelSendNodeConfig).outputKey ?? 'delivery';
        const delivery = result[key] as Record<string, unknown> | undefined;
        const providerMessageId = typeof delivery?.providerMessageId === 'string' ? delivery.providerMessageId : '';
        if (!providerMessageId) {
          throw new AgentisError('INTEGRATION_OPERATION_FAILED', 'channel node completed without provider-issued delivery proof');
        }
        const provenDelivery = delivery!;
        ctx.state.nodeStates[node.id]!.deliveryReceipt = {
          integrationId: `channel:${String(provenDelivery.kind ?? 'unknown')}`,
          operationId: 'send',
          providerMessageId,
          deliveryStatus: provenDelivery.status as 'accepted' | 'delivered' | 'read' | 'queued',
          verified: provenDelivery.verified === true,
          ...(typeof provenDelivery.to === 'string' ? { recipient: provenDelivery.to } : {}),
          contentType: 'text',
          content: '[outbound message redacted]',
          capturedAt: new Date().toISOString(),
        };
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'data_query': {
        const result = this.#executors.executeDataQuery(ctx, resolvedConfig as DataQueryNodeConfig);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'data_mutate': {
        const result = this.#executors.executeDataMutate(ctx, resolvedConfig as DataMutateNodeConfig);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'aggregate_window': {
        const result = this.#executors.executeAggregateWindow(ctx, node, resolvedConfig as AggregateWindowNodeConfig, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'http_request': {
        const result = await this.#executors.executeHttpRequest(ctx, node, resolvedConfig as HttpRequestNodeConfig, item.idempotencyKey);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'error_trigger': {
        // Entry node for error-handler workflows. At run time it is a pure
        // passthrough — the failure payload arrives as the run's seed inputs.
        await this.#completeNode(ctx, node.id, item.inputData);
        return;
      }
      case 'stop_error': {
        const cfg = resolvedConfig as StopErrorNodeConfig;
        throw new AgentisError('WORKFLOW_STOPPED', cfg.errorMessage || 'Workflow stopped by stop_error node', {
          details: cfg.errorCode ? { errorCode: cfg.errorCode } : undefined,
        });
      }
      case 'code': {
        const result = await this.#executors.executeCode(ctx, node, resolvedConfig as CodeNodeConfig, item.inputData, tctx);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'spreadsheet': {
        const result = await this.#executors.executeSpreadsheet(node, resolvedConfig as SpreadsheetNodeConfig, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'graphql': {
        const result = await this.#executors.executeGraphQl(ctx, node, resolvedConfig as GraphQlNodeConfig);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'workflow_store': {
        const result = await this.#executors.executeWorkflowStore(ctx, node.config as WorkflowStoreNodeConfig, tctx);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'workspace_store': {
        const result = await this.#executors.executeWorkspaceStore(ctx, node.config as WorkspaceStoreNodeConfig, tctx);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'evaluator': {
        const result = await this.#executeEvaluator(ctx, node, node.config as EvaluatorNodeConfig, item.inputData, tctx);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'guardrails': {
        const result = this.#executors.executeGuardrails(node.config as GuardrailsNodeConfig, item.inputData);
        if (result.shouldFail) {
          throw new AgentisError('VALIDATION_FAILED', result.message);
        }
        await this.#completeNode(ctx, node.id, result.output);
        return;
      }
      case 'loop': {
        await this.#dispatchLoop(ctx, node, resolvedConfig as LoopNodeConfig, item.inputData, tctx);
        return;
      }
      case 'converge': {
        await this.#dispatchConverge(ctx, node, resolvedConfig as ConvergeNodeConfig, item.inputData, tctx);
        return; // iterations resolve the node async
      }
      case 'pursue': {
        // A Pursuit is a `converge` with forward-reading names + ASSESS/REFLECT
        // on by default. Normalize and reuse the whole converge machine — no
        // fork (COGNITIVE-LOOPING-RFC §10). Stored `converge` graphs are
        // untouched, so their content hash / blueprint blessing is preserved.
        const asConverge = pursueConfigToConverge(resolvedConfig as unknown as PursueNodeConfig);
        await this.#dispatchConverge(ctx, node, asConverge, item.inputData, tctx);
        return; // iterations resolve the node async
      }
      case 'parallel': {
        // Parallel is a pure passthrough at dispatch time — fan-out happens via
        // the regular edge mechanism (every outgoing edge fires concurrently).
        // The JOIN itself runs on the downstream `merge`, which INHERITS this
        // node's `waitFor` / `onBranchError` / `mergeStrategy` (see
        // `#resolveJoinPolicy` / `#nearestUpstreamParallel`): `waitFor: 'first'`
        // makes the merge an OR-join, `onBranchError: 'continue_with_results'`
        // absorbs a failed branch so the merge still produces survivor output,
        // and `mergeStrategy` controls how branch outputs are combined.
        await this.#completeNode(ctx, node.id, item.inputData);
        return;
      }
      case 'subflow': {
        const cfg = node.config as { kind: 'subflow'; workflowId: string; inputMapping?: Record<string, string> };
        if (!this.deps.subflows) {
          // Without a subflow executor wired (legacy embed), surface a clean failure.
          throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'subflow node present but SubflowExecutor not wired');
        }
        const childInputs = cfg.inputMapping ? mapInputs(cfg.inputMapping, item.inputData, this.deps.scratchpad.snapshotOf(ctx.runId)) : item.inputData;
        // Track the parent node as a synthetic active execution so the engine
        // doesn't settle this branch as completed before the child returns.
        ctx.state.activeExecutions[node.id] = {
          taskId: `subflow:${node.id}`,
          nodeId: node.id,
          executorType: 'subflow',
          executorRef: cfg.workflowId,
          startedAt: new Date().toISOString(),
        };
        // Persist the dispatch transition so observers see the child in flight
        // (same staleness class as agent_task/wait).
        await this.#persistRun(ctx).catch(() => {});
        await this.deps.subflows.start({
          parentRunId: ctx.runId,
          parentNodeId: node.id,
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId,
          userId: ctx.userId,
          childWorkflowId: cfg.workflowId,
          inputs: childInputs,
          resumeParent: async (output) => {
            await this.#completeNode(ctx, node.id, output);
            void this.#tick(ctx);
          },
          failParent: async (msg) => {
            await this.#failNode(ctx, node.id, msg);
            void this.#tick(ctx);
          },
          startChildRun: async (childArgs) => {
            const handle = await this.startRun(childArgs);
            return { runId: handle.runId };
          },
        });
        return;
      }
      default: {
        // Defense-in-depth. No explicit case above and no registered pure
        // handler (checked before this switch) matches this node kind. Every
        // entry point (startRun / applyGraphPatch / evolveGraph) runs
        // `validateWorkflowGraph`, whose SUPPORTED_NODE_KINDS allowlist already
        // rejects truly-unknown kinds, so this is normally unreachable. It
        // guards allowlist/dispatch DRIFT: a kind that passes the allowlist but
        // has no handler (e.g. an allowlisted kind whose case was removed).
        // Without it, such a node would be STARTED but never completed and the
        // run would hang forever. Fail loudly instead: the dispatch caller's
        // `.catch()` funnels this into `#failNode`, so the run settles to FAILED.
        throw new AgentisError(
          'WORKFLOW_GRAPH_INVALID',
          `node kind '${String((node.config as { kind?: unknown }).kind)}' has no execution handler wired`,
        );
      }
    }
  }

  async #executeExtensionTask(
    ctx: RunningContext,
    node: WorkflowNode,
    config: ExtensionTaskNodeConfig,
    inputData: Record<string, unknown>,
    extraInput: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const extensionInput = { ...mapInputs(config.inputMapping, inputData, ctx.scratchpad?.snapshot ?? {}), ...extraInput };
    // Extensions can run long (node worker / docker sandbox) — register the
    // in-flight execution and persist so observers see it (same staleness
    // class as agent_task); removed in the finally below.
    ctx.state.activeExecutions[node.id] = {
      taskId: `extension:${node.id}`,
      nodeId: node.id,
      executorType: 'extension',
      executorRef: config.extensionId ?? config.extensionSlug ?? config.operationName,
      startedAt: new Date().toISOString(),
    };
    await this.#persistRun(ctx).catch(() => {});
    let result: Awaited<ReturnType<typeof this.deps.extensions.execute>>;
    try {
      result = await this.deps.extensions.execute({
        workspaceId: ctx.workspaceId,
        extensionId: config.extensionId,
        extensionSlug: config.extensionSlug,
        operationName: config.operationName,
        version: config.version,
        runId: ctx.runId,
        taskId: node.id,
        input: extensionInput,
        scratchpadSnapshot: ctx.scratchpad?.snapshot ?? {},
        // Run-scoped cancellation: Stop settles the node immediately with an
        // honest ABORTED outcome (node_worker isolates are hard-stopped).
        ...(ctx.abortController ? { signal: ctx.abortController.signal } : {}),
      });
    } finally {
      delete ctx.state.activeExecutions[node.id];
    }

    if (!result.ok) {
      throw new AgentisError(
        result.errorCode === 'EXTENSION_TIMEOUT' ? 'EXTENSION_TIMEOUT' : 'INTERNAL_ERROR',
        `Extension ${config.extensionId ?? config.extensionSlug ?? node.id} failed: ${result.message}`,
      );
    }

    // Apply output mapping to scratchpad.
    if (config.outputMapping) {
      for (const [outKey, padKey] of Object.entries(config.outputMapping)) {
        if (outKey in result.output) {
          this.deps.scratchpad.write(ctx.runId, padKey, result.output[outKey]);
        }
      }
    }

    return result.output;
  }

  async #executeComponentTask(
    ctx: RunningContext,
    node: WorkflowNode,
    config: ComponentTaskNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const bindings = Object.entries(config.stateBindings ?? {});
    if (bindings.length > 0 && !this.deps.workflowStore) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'component_task stateBindings require the workflow state service');
    }
    const loaded = bindings.map(([name, binding]) => ({
      name,
      binding,
      entry: this.deps.workflowStore?.getEntry(ctx.workspaceId, ctx.workflowId, binding.key),
    }));
    const state = Object.fromEntries(loaded.map(({ name, entry }) => [name, entry?.value]));

    let receiptKey: string | undefined;
    if (config.idempotencyKeyPath && this.deps.workflowStore) {
      const identity = readDotPath(inputData, config.idempotencyKeyPath);
      if (identity !== undefined && identity !== null && String(identity).trim()) {
        const digest = createHash('sha256').update(stableComponentIdentity(identity)).digest('hex');
        receiptKey = `component.receipt.${node.id}.${digest}`;
        const receipt = this.deps.workflowStore.get(ctx.workspaceId, ctx.workflowId, receiptKey);
        if (receipt && typeof receipt === 'object' && !Array.isArray(receipt)) return receipt as Record<string, unknown>;
      }
    }

    const output = await this.#executeExtensionTask(
      ctx,
      node,
      componentAsExtension(config),
      inputData,
      bindings.length > 0 ? { state } : {},
    );
    if (this.deps.workflowStore) {
      const writes = loaded.flatMap(({ name, binding, entry }) => {
        if (binding.mode === 'read') return [];
        const value = readDotPath(output, binding.writeFrom ?? name);
        if (value === undefined) return [];
        return [{
          key: binding.key,
          expectedVersion: entry?.version ?? 0,
          value,
          mode: binding.mode === 'set' ? 'set' as const : 'replace' as const,
        }];
      });
      if (receiptKey) writes.push({ key: receiptKey, expectedVersion: 0, value: output, mode: 'replace' });
      this.deps.workflowStore.commit(ctx.workspaceId, ctx.workflowId, writes);
    }
    return output;
  }

  async #executeKnowledgeNode(
    ctx: RunningContext,
    config: KnowledgeNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.deps.knowledgeBases) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'knowledge node present but KnowledgeBaseService not wired');
    }

    const query = resolveKnowledgeQuery(config, inputData, ctx.state.nodeStates).trim();
    if (!query) throw new AgentisError('VALIDATION_FAILED', 'knowledge node query is empty');

    const topK = Math.min(Math.max(config.topK ?? 5, 1), 20);
    const bases = config.knowledgeBaseId
      ? [this.deps.knowledgeBases.getKnowledgeBase(ctx.workspaceId, config.knowledgeBaseId)]
      : this.deps.knowledgeBases.listKnowledgeBases(ctx.workspaceId, { scopeId: ctx.workflowId, includeWorkspace: true });
    const perBaseTopK = config.knowledgeBaseId ? topK : Math.max(topK, 5);

    const batches = await Promise.all(bases
      .map(async (base) => (await this.deps.knowledgeBases!.search({
        workspaceId: ctx.workspaceId,
        knowledgeBaseId: base.id,
        query,
        topK: perBaseTopK,
        retrievalMode: config.retrievalMode ?? 'contextual',
      })).map((hit) => ({
        ...hit,
        knowledgeBaseId: base.id,
        knowledgeBaseName: base.name,
      }))));
    const results = batches
      .flat()
      .sort((left, right) => right.score - left.score)
      .slice(0, topK);

    return {
      query,
      topK,
      retrievalMode: config.retrievalMode ?? 'contextual',
      knowledgeBaseId: config.knowledgeBaseId ?? null,
      resultCount: results.length,
      results,
      context: results.map((result, index) => ({
        index: index + 1,
        title: result.knowledgeBaseName,
        content: result.content,
        score: result.score,
        source: result.metadata,
      })),
    };
  }

  /**
   * knowledge_ingest — write-side twin of `knowledge`. Routes upstream content
   * into the same `KnowledgeBaseService` the retrieval node reads from, so a
   * workflow's output becomes recallable by future agents and `knowledge` nodes.
   * No bespoke ingestion logic: it delegates to `addDocument`, the same path the
   * Brain UI uses.
   */
  async #executeKnowledgeIngestNode(
    ctx: RunningContext,
    config: KnowledgeIngestNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.deps.knowledgeBases) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'knowledge_ingest node present but KnowledgeBaseService not wired');
    }

    const content = stringifyKnowledgeContent(
      config.contentPath ? lookupPath(inputData, config.contentPath) : (config.content ?? inputData),
    ).trim();
    if (!content) throw new AgentisError('VALIDATION_FAILED', 'knowledge_ingest node has no content to store');

    const nameValue = config.documentNamePath
      ? lookupPath(inputData, config.documentNamePath)
      : config.documentName;
    const name = (typeof nameValue === 'string' && nameValue.trim())
      ? nameValue.trim()
      : `Workflow ${ctx.workflowId} — ${new Date().toISOString()}`;

    // Resolve a target base without friction: explicit id → first existing → create one.
    let knowledgeBaseId = config.knowledgeBaseId;
    if (knowledgeBaseId) {
      this.deps.knowledgeBases.getKnowledgeBase(ctx.workspaceId, knowledgeBaseId);
    } else {
      const existing = this.deps.knowledgeBases.listKnowledgeBases(ctx.workspaceId, { scopeId: ctx.workflowId });
      const workflow = this.deps.db.select({ title: schema.workflows.title })
        .from(schema.workflows)
        .where(and(eq(schema.workflows.workspaceId, ctx.workspaceId), eq(schema.workflows.id, ctx.workflowId)))
        .get();
      knowledgeBaseId = existing[0]?.id
        ?? this.deps.knowledgeBases.createKnowledgeBase({
          workspaceId: ctx.workspaceId,
          scopeId: ctx.workflowId,
          name: config.knowledgeBaseName?.trim() || workflow?.title?.trim() || 'Workflow Knowledge',
        }).id;
    }

    const document = await this.deps.knowledgeBases.addDocument({
      workspaceId: ctx.workspaceId,
      knowledgeBaseId,
      name,
      mimeType: config.mimeType,
      content,
    });

    return {
      knowledgeBaseId,
      documentId: document.id,
      name: document.name,
      chunks: document.chunks,
      mimeType: document.mimeType,
      status: document.status,
    };
  }

  /**
   * §2.2 agentic tool-use loop — now the DEFAULT execution for `agent_task`.
   *
   * Any agent task whose specialist has a tool manifest (platform role tools, or
   * the universal default toolbox for custom/generated roles) runs a bounded
   * think→act→observe loop in-process against the role-scoped, manifest-enforced
   * tool runtime, completing the node synchronously while STREAMING its reasoning
   * and tool calls into the run activity spine. This is what turns a specialist
   * from a single fire-and-forget completion into a real, tool-using agent.
   *
   * Returns false (→ single external-adapter dispatch) only when: the workspace
   * has no tool runtime / evaluation model wired, the task explicitly opts out
   * (`useRoleTools: false` — for a pure one-shot transform), or the resolved
   * specialist genuinely has no tools.
   *
   * Agentic harness adapters (marker_protocol, mcp_native, session_event) keep
   * their own loop; the platform loop upgrades inherited/toolless runtimes.
   */
  /**
   * When an `agent_task` is underspecified (no explicit agent and only a generic
   * role), consult the SpecialistDemandRouter for a scored, explainable role
   * selection instead of falling back to a bare `specialist`. Records the
   * decision as a conversation-theater event so the operator sees WHY this
   * specialist was chosen. No-op when the router is unwired or the task already
   * names a concrete specialist.
   */
  async #maybeRouteSpecialist(
    ctx: RunningContext,
    node: WorkflowNode,
    config: AgentTaskNodeConfig,
  ): Promise<AgentTaskNodeConfig> {
    // Manager-owned org structure: a workflow owned by a specialist (or belonging
    // to a subdomain that specialist runs) auto-dispatches its unpinned tasks to
    // that specialist — deterministic, and independent of the demand router. The
    // manager fallback ('domain') is NOT applied here: a manager delegates, it
    // doesn't execute the leaf task.
    if (!config.agentId && ctx.workflowId) {
      const responsible = resolveResponsibleSpecialist(this.deps.db, ctx.workspaceId, { workflowId: ctx.workflowId });
      if (responsible && responsible.via !== 'domain' && this.#agentHasConnectedRuntime(responsible.agentId)) {
        this.deps.activity.record({
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId,
          userId: ctx.userId,
          eventType: 'specialist.routed',
          actorType: 'system',
          actorId: 'responsibility',
          entityType: 'run',
          entityId: ctx.runId,
          summary: `Routed to the specialist responsible for this workflow (${responsible.via}).`,
          metadata: { runId: ctx.runId, nodeId: node.id, agentId: responsible.agentId, via: responsible.via },
        });
        return { ...config, agentId: responsible.agentId };
      }
    }
    if (!this.deps.specialistRouter || config.agentId) return config;
    const GENERIC_ROLES = new Set(['specialist', 'agent', 'worker', '']);
    const hasConcreteRole = config.agentRole
      && isAgentRole(config.agentRole)
      && !GENERIC_ROLES.has(normalizeRole(config.agentRole));
    if (hasConcreteRole) return config;
    const task = `${node.title}\n${config.prompt ?? ''}`.trim();
    if (!task) return config;
    try {
      const decision = await this.deps.specialistRouter.request(ctx.workspaceId, ctx.userId, {
        task,
        callerAgentId: null,
        workflowId: ctx.workflowId,
        runId: ctx.runId,
        materialize: true,
        createRun: false,
      });
      if (!decision.selectedRole) return config;
      this.deps.activity.record({
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId,
        userId: ctx.userId,
        eventType: 'specialist.routed',
        actorType: 'system',
        actorId: 'router',
        entityType: 'run',
        entityId: ctx.runId,
        summary: decision.explanation,
        metadata: {
          runId: ctx.runId,
          nodeId: node.id,
          role: decision.selectedRole,
          topology: decision.topology,
          score: decision.score,
          traceId: decision.traceId,
        },
      });
      return { ...config, agentRole: decision.selectedRole as AgentRole };
    } catch (err) {
      this.deps.logger.warn('specialist.route_failed', {
        runId: ctx.runId,
        nodeId: node.id,
        error: (err as Error).message,
      });
      return config;
    }
  }

  /**
   * Decide whether an `agent_task` should run as a full persistent AgentSession
   * (the SMARTER-AGENTS-10X default) rather than a bounded tool loop / one-shot
   * dispatch. A session gives the specialist working memory, sub-agent
   * delegation, and yield/sleep — the autonomy the platform promises.
   *
   * Defaults ON when the session runtime is wired, UNLESS:
   *  - the node explicitly opts out (`useSession:false` or `useRoleTools:false`,
   *    for a deterministic one-shot transform), or
   *  - an explicit `agentId` is bound to a connected runtime (its own adapter or
   *    CLI harness owns the loop — never downgrade it to the shared session LLM).
   */
  #shouldRunAsSession(ctx: RunningContext, config: AgentTaskNodeConfig): boolean {
    if (!this.deps.sessions || !this.deps.sessionRuntime) return false;
    // A session needs a resolvable model for this workspace (Settings → env →
    // first connected agent). With none, degrade cleanly to the tool loop /
    // single-shot dispatch rather than failing the node at its first step.
    if (!this.deps.sessionRuntime.canRun(ctx.workspaceId)) return false;
    if (config.useSession === true) return true;
    if (config.useSession === false) return false;
    if (config.useRoleTools === false) return false;
    if (config.agentId && this.#agentHasConnectedRuntime(config.agentId)) return false;
    return true;
  }

  async #maybeRunAgentToolLoop(
    ctx: RunningContext,
    node: WorkflowNode,
    config: AgentTaskNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<boolean> {
    // Explicit opt-out for a deterministic one-shot transform task.
    if (config.useRoleTools === false) return false;

    // E1 — a marker_protocol CLI harness (Codex / Claude Code) bound to this node
    // runs its OWN reasoning, but in workflow dispatch it was awareness-only. Bind
    // it (idempotent, like dispatch) and give it a REAL Agentis tool loop so it
    // wields its native tools AND the Agentis platform surface (search/brain/app/
    // data/cooperation/channels) mid-task, then completes the node with its result.
    // Chat-capable native and marker harnesses both enter the shared executor. The
    // caller-owned loop preserves the Agentis catalog when transport recovery is
    // required, while the adapter still supplies its native reasoning runtime.
    if (config.agentId) {
      if (!this.deps.adapters.get(config.agentId)) {
        const pin = stringValue(config.modelOverride) ?? this.#agentConfiguredModel(config.agentId);
        const runtime = this.deps.resolveAgentRuntime?.(ctx.workspaceId, config.agentId, config.prompt, pin);
        if (runtime) this.deps.adapters.register(config.agentId, runtime);
      }
      const adapter = this.deps.adapters.get(config.agentId)?.adapter;
      const capabilities = adapter?.capabilities?.();
      if (adapter?.chat && capabilities?.interactiveChat
        && await this.#runHarnessChatToolLoop(ctx, node, config, config.agentId, inputData)) {
        return true;
      }
    }

    // The loop needs a structured-LLM (evaluation role) + the tool runtime. When
    // unwired (e.g. minimal test engines), fall through to single-shot dispatch.
    const toolLoopLlm = this.deps.resolveEvaluatorRuntime?.(ctx.workspaceId, 'evaluation', { task: config.prompt, purpose: 'agent_tool_loop' }) ?? this.deps.evaluatorRuntime;
    if (!this.deps.agentTools || !toolLoopLlm) return false;

    const resolved = this.#resolveAgentForToolLoop(ctx, config);
    if (!resolved) return false;
    const { agentId, role } = resolved;

    // Defer to an agentic CLI harness (Codex / Claude Code) bound to this agent: it
    // runs its OWN superior tool loop via dispatch. The in-engine loop exists to fix
    // the single-completion *inherited* runtime (the toolless default) — never to
    // downgrade an agent deliberately bound to a powerful coding harness.
    const boundAdapter = agentId ? this.deps.adapters.get(agentId)?.adapter : undefined;
    if (agentId && boundAdapter?.chat && boundAdapter.capabilities?.().interactiveChat) {
        return this.#runHarnessChatToolLoop(ctx, node, config, agentId, inputData);
    }

    const def = this.#specialistDef(ctx, role);
    // A workflow agent gets its FULL Agentis-native toolbox, not a starved subset:
    // the role manifest UNION the universal floor UNION whatever its declared
    // capabilities imply. This is the fix for "agents don't have their total
    // abilities" — declaring a capability now actually grants the tools, and no
    // agent_task drops below the knowledge-worker floor (search, browser, brain,
    // data, compute).
    const tools = resolveAgentTaskTools(def, config);
    if (tools.length === 0) return false;

    // Conversation theater: the work hand-off (workflow → specialist) on the loop
    // path too, so collaboration is recorded regardless of execution path.
    this.#recordSpecialistAssignment(ctx, node, agentId, config.prompt);

    const preambleResult = await this.#withWorkspaceContext(ctx, '', def.systemPrompt, '', agentId);
    const preamble = preambleResult.prompt;
    const inputBlock = Object.keys(inputData).length > 0 ? `\n\nINPUT:\n${safeJson(inputData)}` : '';

    // Phase 2/3A/4 — dynamic capability surface. Bridged MCP tools (computer-use,
    // browser, any operator-mounted server) are offered alongside the static
    // manifest, and the bound runtime's native affordances are surfaced so the
    // agent knows its real powers instead of describing what it would do.
    const bridgedTools = (await this.deps.agentTools.listBridgedTools(ctx.workspaceId)).map((spec) => ({
      id: spec.id,
      description: spec.provides ? `${spec.description} [grants ${spec.provides}]` : spec.description,
    }));
    // E2 — the agent is a full Agentis citizen: offer the `agentis.*` integration
    // catalog (channels, cooperation, app management, …) alongside its native +
    // bridged tools, so it can talk to humans, cooperate, and operate the App
    // mid-task instead of being confined to the AgentTool enum.
    const platformTools = this.deps.agentTools.listPlatformTools();
    const extraTools = [...bridgedTools, ...platformTools];
    const liveAffordances = agentId ? this.deps.adapters.capabilities(agentId)?.affordances ?? {} : {};
    const runtimeAffordances = (Object.keys(liveAffordances) as AgentAffordance[])
      .filter((key) => liveAffordances[key] === true)
      .map(affordanceLabel);

    const loop = new AgentToolLoop({
      runtime: this.deps.agentTools,
      llm: toolLoopLlm,
      logger: this.deps.logger,
    });
    const result = await loop.run({
      workspaceId: ctx.workspaceId,
      role,
      task: `${config.prompt}${buildNodeProcessBriefing(ctx.graph, node, config)}${inputBlock}`,
      systemPreamble: preamble,
      tools,
      ...(extraTools.length > 0 ? { extraTools } : {}),
      ...(runtimeAffordances.length > 0 ? { runtimeAffordances } : {}),
      maxSteps: config.maxToolSteps,
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      agentId,
      userId: ctx.userId,
      artifactPolicy: artifactPolicyFromUnknown(config.artifactPolicy),
      // Stream the agent's live reasoning + tool use into the run room (the
      // immersive monitor/triage/canvas all read this), correctly attributed to
      // this node via taskId=node.id.
      onStep: (step) => {
        if (step.phase === 'thinking' && step.thought) {
          this.notifyAgentActivity({ runId: ctx.runId, agentId, taskId: node.id, kind: 'thinking', text: step.thought });
        } else if (step.phase === 'tool_call' && step.tool) {
          this.notifyAgentActivity({ runId: ctx.runId, agentId, taskId: node.id, kind: 'tool_call', tool: step.tool, toolInput: step.args });
        } else if (step.phase === 'tool_result' && step.tool) {
          this.notifyAgentActivity({ runId: ctx.runId, agentId, taskId: node.id, kind: 'tool_result', tool: step.tool, toolResult: step.error ? { error: step.error } : step.observation });
        }
      },
      ...(ctx.abortController ? { signal: ctx.abortController.signal } : {}),
    });

    if (ctx.abortController?.signal.aborted || ctx.state.status === 'CANCELLED') return true;

    if (result.error && (result.stoppedReason === 'no_decision' || !result.output)) {
      // Recoverable (out-of-credits) errors pause; everything else fails honestly.
      await this.#failNode(ctx, node.id, result.error);
      return true;
    }

    this.#audit(ctx, {
      nodeId: node.id,
      action: 'agent.tool_loop',
      actorType: 'agent',
      actorId: role,
      outputSummary: `${result.stoppedReason}: ${result.toolCalls} tool call(s)`,
    });
    const output = {
      output: result.output,
      toolCalls: result.toolCalls,
      steps: result.steps.length,
      stoppedReason: result.stoppedReason,
    };
    this.#recordNodeTokens(ctx, node.id, result.tokensIn, result.tokensOut);
    // Attribute to the RESOLVED agent (more precise than the node's config, which
    // may carry a role rather than a concrete agent id).
    this.#attributeNodeTokens(ctx, node.id, agentId);
    this.#recordSpecialistResult(ctx, node, agentId, output);
    await this.#completeNode(ctx, node.id, output);
    return true;
  }

  /**
   * E1 — run a marker_protocol CLI harness through a REAL Agentis chat tool loop
   * inside a workflow node: it reasons with its OWN native tools AND the Agentis
   * platform surface (autonomous via permissionMode 'auto' — no confirmation
   * gating), and the node completes with its final result through the same
   * `#completeNode` chokepoint the in-engine loop uses (so declared-output
   * contracts + self-heal apply identically). Returns false WITHOUT side effects
   * when the harness can't run here (no chat / no tool registry) so the caller
   * falls back to dispatch; once committed it always completes or fails the node.
   */
  async #runHarnessChatToolLoop(
    ctx: RunningContext,
    node: WorkflowNode,
    config: AgentTaskNodeConfig,
    agentId: string,
    inputData: Record<string, unknown>,
  ): Promise<boolean> {
    const adapter = this.deps.adapters.get(agentId)?.adapter;
    if (!adapter?.chat || adapter.capabilities?.().interactiveChat === false) return false;
    const tools = this.#agentChatTools();
    if (!tools) return false;

    // ── committed: from here this method OWNS the node completion. ──
    this.#recordSpecialistAssignment(ctx, node, agentId, config.prompt);
    const role = (this.#agentRole(agentId) ?? config.agentRole ?? 'specialist') as AgentRole;
    const rolePrompt = this.#specialistDef(ctx, role).systemPrompt;
    const inputBlock = Object.keys(inputData).length > 0 ? `\n\nINPUT:\n${safeJson(inputData)}` : '';
    const brief = `${config.prompt}${buildNodeProcessBriefing(ctx.graph, node, config)}${inputBlock}`;
    const systemAddendum = [
      rolePrompt,
      'You are executing a workflow step. Use your OWN native tools AND the Agentis platform tools below — search, browser, the workspace/app/agent brain, app data, cooperation, and channels — whichever the task needs. Work autonomously; do not ask the operator to confirm. Finish with your result as your final message.',
    ].filter(Boolean).join('\n\n');
    const appId = this.deps.resolveAppIdForWorkflow?.(ctx.workspaceId, ctx.workflowId);
    const attempt = ctx.state.nodeStates[node.id]?.attempt ?? this.#nodeDispatchCounts(ctx).get(node.id) ?? 1;
    const sessionKey = `agent-task:${ctx.runId}:${node.id}:attempt:${attempt}`;
    const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

    ctx.state.activeExecutions[node.id] = {
      taskId: node.id,
      nodeId: node.id,
      executorType: 'agent',
      executorRef: agentId,
      startedAt: new Date().toISOString(),
    };
    await this.#persistRun(ctx).catch(() => {});
    this.#emitWorkStep(ctx, node, 'thinking', 'Running on its full-power runtime with the Agentis toolset');
    let text = '';
    let finishReason: Extract<ChatDelta, { type: 'done' }>['finishReason'] | undefined;
    let adapterFailure: string | undefined;
    const executionStartedAt = Date.now();
    try {
      for await (const delta of ChatSessionExecutor.turn(adapter, [], brief, {
        workspaceId: ctx.workspaceId,
        agentId,
        userId: ctx.userId,
        conversationId: sessionKey,
        clientTurnId: sessionKey,
        executionMode: 'chat',
        permissionMode: 'auto',
        runId: ctx.runId,
        ambientId: ctx.ambientId,
        ...(appId ? { appId } : {}),
        viewport: {
          surface: 'run_detail',
          route: `/runs/${ctx.runId}`,
          resourceId: ctx.runId,
          resourceKind: 'run',
          activeRunId: ctx.runId,
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId,
        },
        ...(ctx.abortController ? { signal: ctx.abortController.signal } : {}),
      }, {
        tools,
        maxTurns: Math.max(2, Math.min(config.maxToolSteps ?? 8, 12)),
        // A workflow agent doing real work is not a 24-step task. This is a high
        // backstop, not the governor — ChatProgressMonitor stops true loops far
        // sooner. The old 24 guillotined legitimate multi-step agent_task nodes
        // mid-work (the same class of bug as the chat loop's old 80). Honor an
        // explicit operator step budget when set; otherwise stay generous.
        maxToolCalls: config.maxToolSteps && config.maxToolSteps > 24 ? config.maxToolSteps : 2000,
        systemAddendum,
        sessionKey,
        // `agent_task` must be able to recover from a stalled native runtime
        // without losing the Agentis tool surface.
        toolMode: 'caller_loop',
        transportRecovery: 'capability_preserving',
        // AdapterManager already validated this bound runtime. Re-running a
        // Hermes/Python `--version` process here cost ~9s before every fresh
        // agent_task while the real invocation has precise spawn/provider errors.
        skipRuntimePreflight: true,
      })) {
        if (ctx.abortController?.signal.aborted || ctx.state.status === 'CANCELLED') break;
        if (delta.type === 'text') text += delta.delta;
        if (delta.type === 'tool_result' && delta.error) adapterFailure = delta.error;
        if (delta.type === 'done') finishReason = delta.finishReason;
        this.#selfHeal.relayChatDelta(ctx, node, agentId, delta, clip);
      }
    } catch (err) {
      if (ctx.abortController?.signal.aborted || ctx.state.status === 'CANCELLED') return true;
      this.deps.logger.warn('engine.agent_task.harness_loop_failed', { runId: ctx.runId, nodeId: node.id, error: (err as Error).message });
      await this.#failNode(ctx, node.id, `agent runtime failed: ${(err as Error).message}`);
      return true;
    }
    if (ctx.abortController?.signal.aborted || ctx.state.status === 'CANCELLED') return true;

    // A workflow node may complete only after the shared executor reports a
    // clean terminal stop. Runtime error prose, turn-limit guidance, and an
    // unconsumed tool-call boundary are diagnostics—not business output. The
    // previous behavior appended that prose to `text` and could falsely mark an
    // unfinished agent_task successful.
    if (finishReason !== 'stop') {
      const elapsedMs = Date.now() - executionStartedAt;
      const transport = adapter.adapterType || 'unknown runtime';
      const stage = finishReason ?? 'stream ended without a terminal event';
      const detail = adapterFailure ? ` ${adapterFailure}` : '';
      await this.#pauseNodeBlocked(
        ctx,
        node.id,
        `Agent task runtime did not produce a completed result (runtime=${transport}, stage=${stage}, elapsedMs=${elapsedMs}, attempt=${attempt}, session=${sessionKey}).${detail} Retry or resume the run; the next attempt uses a fresh isolated runtime session.`,
      );
      return true;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      const elapsedMs = Date.now() - executionStartedAt;
      await this.#pauseNodeBlocked(
        ctx,
        node.id,
        `Agent task runtime stopped without a result (runtime=${adapter.adapterType}, stage=empty_result, elapsedMs=${elapsedMs}, attempt=${attempt}, session=${sessionKey}). Retry or resume the run; the next attempt uses a fresh isolated runtime session.`,
      );
      return true;
    }
    const structured = parseGeneric(trimmed);
    const output: Record<string, unknown> = structured && typeof structured === 'object' && !Array.isArray(structured)
      ? (structured as Record<string, unknown>)
      : { output: trimmed };
    this.#audit(ctx, { nodeId: node.id, action: 'agent.harness_tool_loop', actorType: 'agent', actorId: agentId, outputSummary: clip(trimmed, 200) });
    this.#recordSpecialistResult(ctx, node, agentId, output);
    const completedOutput = await this.#completeNode(ctx, node.id, output);
    // BRAIN-BLUEPRINT-10X — this harness tool-loop path was the ONE agent_task
    // completion that never enqueued brain formation (dispatch/session/swarm all
    // do). What the agent learned doing the work now flows through the same
    // policy-gated pipeline, so it exists for future runs.
    if (completedOutput) {
      this.#enqueueSuccessfulBrainCapture(ctx, node.id, completedOutput, agentId, {
        task: (node.config as { prompt?: string }).prompt ?? node.title,
      });
    }
    return true;
  }

  /** The `agentis.*` platform tools a workflow harness agent may call (E1) — the
   *  mcp-exposed catalog (vetted for autonomous harnesses) minus the recursion /
   *  run-control blocklist. Same safe set the in-engine loop gets (E2). */
  #agentChatTools(): ToolDefinition[] | undefined {
    const registry = this.deps.toolRegistry;
    if (!registry) return undefined;
    const tools = registry.catalog({ mcpOnly: true }).tools
      .filter((tool) => !WORKFLOW_AGENT_TOOL_BLOCKLIST.has(tool.id))
      .map((tool) => ({
        name: tool.id,
        description: tool.longDescription ?? tool.description,
        parameters: toolInputSchemaToChatParameters(tool.inputSchema),
      }));
    return tools.length > 0 ? tools : undefined;
  }

  /** Resolve the identity the platform tool loop should run as, or defer. */
  #resolveAgentForToolLoop(
    ctx: RunningContext,
    config: AgentTaskNodeConfig,
  ): { agentId?: string; role: AgentRole } | null {
    if (!this.#toolLoopSatisfiesRequirements(config.requires)) return null;

    const validRole = config.agentRole && isAgentRole(config.agentRole) ? config.agentRole : undefined;
    const roleForAgent = (agentId?: string): AgentRole => {
      return (validRole ?? normalizeRole(this.#agentRole(agentId) ?? 'specialist')) as AgentRole;
    };
    const shouldDeferToAdapter = (agentId?: string): boolean => {
      return Boolean(
        agentId
          && this.#agentHasOwnAgenticRuntime(agentId)
          && this.#agentSatisfiesRequirements(agentId, config.requires),
      );
    };

    if (config.agentId) {
      if (shouldDeferToAdapter(config.agentId)) return null;
      return { agentId: config.agentId, role: roleForAgent(config.agentId) };
    }

    if (validRole && this.deps.specialists) {
      const agentId = this.deps.specialists.ensureRole(ctx.workspaceId, ctx.userId, validRole);
      if (shouldDeferToAdapter(agentId)) return null;
      return { agentId, role: validRole };
    }

    const fallback = this.#resolveConnectedFallbackAgent(
      ctx.workspaceId,
      config.capabilityTags ?? [],
      config.requires,
      validRole,
    );
    if (fallback) {
      if (shouldDeferToAdapter(fallback)) return null;
      return { agentId: fallback, role: roleForAgent(fallback) };
    }

    return { role: (validRole ?? 'specialist') as AgentRole };
  }

  /** Conversation-theater: record a workflow -> specialist work hand-off. */
  #recordSpecialistAssignment(ctx: RunningContext, node: WorkflowNode, agentId: string | undefined, instruction?: string): void {
    this.deps.activity.record({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      userId: ctx.userId,
      eventType: 'agent.task_assigned',
      actorType: 'agent',
      actorId: agentId ?? null,
      entityType: 'run',
      entityId: ctx.runId,
      summary: `${this.#agentName(agentId) ?? 'Specialist'} ← “${node.title}”`,
      metadata: { runId: ctx.runId, workflowId: ctx.workflowId, nodeId: node.id, instruction: instruction?.slice(0, 400) },
    });
  }

  /** Conversation-theater: record a specialist → workflow result. */
  #recordSpecialistResult(ctx: RunningContext, node: WorkflowNode, agentId: string | undefined, output: Record<string, unknown>): void {
    this.deps.activity.record({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      userId: ctx.userId,
      eventType: 'agent.task_completed',
      actorType: 'agent',
      actorId: agentId ?? null,
      entityType: 'run',
      entityId: ctx.runId,
      summary: `${this.#agentName(agentId) ?? 'Specialist'} → finished “${node.title}”`,
      metadata: { runId: ctx.runId, workflowId: ctx.workflowId, nodeId: node.id, outputPreview: safeJson(output).slice(0, 300) },
    });
  }

  /** Resolve an agent's functional role slug from the DB. */
  #agentRole(agentId: string | null | undefined): string | undefined {
    if (!agentId) return undefined;
    return this.deps.db
      .select({ role: schema.agents.role }).from(schema.agents).where(eq(schema.agents.id, agentId)).get()?.role ?? undefined;
  }

  #findAgentByRole(workspaceId: string, role: string): string | null {
    return this.deps.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.role, role)))
      .get()?.id ?? null;
  }

  /**
   * Registry-aware specialist resolution for system-prompt injection. Resolves
   * a role string to a full definition without ever throwing: built-in platform
   * role → workspace agent library (custom/generated) → synthesized generic
   * specialist. This is what lets a workflow reference a custom `agentRole`
   * (e.g. `frontend_architect`) and still get a coherent persona at dispatch.
   */
  #specialistDef(ctx: RunningContext, role: AgentRole): SpecialistDefinition {
    return (
      this.deps.specialists?.defForRole(ctx.workspaceId, role)
      ?? specialistForRole(role, null)
      ?? genericSpecialist(role)
    );
  }

  async #dispatchAgentTask(
    ctx: RunningContext,
    node: WorkflowNode,
    config: AgentTaskNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<void> {
    // P0.3: honor inputKeys as an input allow-list, matching the agent_session /
    // planner / code paths — previously agent_task silently ignored it, so the
    // field lied about scoping the agent's input. Empty (default) = full input.
    // GUARD (found against a real 71-node workflow): agents commonly misuse
    // inputKeys, putting node references ("nodes.prospect-plan") instead of
    // top-level key names. Honoring that literally strips the input to {} and
    // starves the node. So only narrow when the keys actually select something;
    // if they match nothing in a non-empty input, keep the full input.
    if (config.inputKeys.length > 0) {
      const scoped = pickKeys(inputData, config.inputKeys);
      if (Object.keys(scoped).length > 0 || Object.keys(inputData).length === 0) {
        inputData = scoped;
      }
    }
    if (config.agentId && !this.deps.adapters.get(config.agentId)) {
      const runtimePin = stringValue(config.modelOverride) ?? this.#agentConfiguredModel(config.agentId);
      const runtime = this.deps.resolveAgentRuntime?.(ctx.workspaceId, config.agentId, config.prompt, runtimePin);
      if (runtime) {
        this.deps.adapters.register(config.agentId, runtime);
        this.deps.logger.info('engine.agent_task.runtime_bound', { runId: ctx.runId, agentId: config.agentId, nodeId: node.id, phase: 'pre_resolve' });
      }
    }
    const resolved = this.#resolveAgentForNode(ctx, {
      explicitAgentId: config.agentId,
      role: config.agentRole,
      capabilityTags: config.capabilityTags,
      requires: config.requires,
      preferredAdapter: stringValue(config.preferredAdapter) ?? undefined,
      label: `agent_task node ${node.id}`,
    });
    const agentId = resolved.agentId;
    const rolePrompt = resolved.role ? this.#specialistDef(ctx, resolved.role).systemPrompt : undefined;
    // The task id MUST be the node id: adapters echo `task.taskId` on completion and
    // the bridge maps it straight back to the node (bootstrap: "taskId carries node
    // binding in V1"). A random uuid here silently broke completion mapping — the
    // model would run but the node would hang RUNNING forever because
    // notifyTaskCompleted({ nodeId: <uuid> }) never matched a real node.
    const taskId = node.id;
    ctx.state.activeExecutions[node.id] = {
      taskId,
      nodeId: node.id,
      executorType: 'agent',
      executorRef: agentId,
      startedAt: new Date().toISOString(),
    };
    // Persist the dispatch transition IMMEDIATELY (same reason as the wait
    // node): an agent node runs for minutes, and until this write the DB row
    // still shows it queued with activeExecutions:{} — every external observer
    // (run.status, check_run, the UI, another agent) reads a phantom
    // "dispatcher stalled" and may cancel a healthy run over it.
    await this.#persistRun(ctx).catch(() => {});

    // Compose the system preamble: role identity (Layer 2) → workspace context
    // (Layer 1) → agent memory (§G11) → the task
    // prompt. No agent call starts from zero (Principle #2).
    const contextResult = await this.#withWorkspaceContext(
      ctx,
      `${config.prompt}${buildNodeProcessBriefing(ctx.graph, node, config)}`,
      rolePrompt,
      '',
      agentId,
    );
    const prompt = contextResult.prompt;

    // LAYER 0: ensure the agent has a working brain. Specialists are minted
    // `offline` with no adapter; without this, dispatch hits a dead http stub and
    // the node hangs with zero model consumption. Lazily bind the workspace's
    // default model runtime (bound to this agent id) so the task actually runs and
    // streams real thoughts. Registered once — its events flow through the normal
    // AdapterManager → engine pipeline.
    if (!this.deps.adapters.get(agentId)) {
      const runtimePin = stringValue(config.modelOverride) ?? this.#agentConfiguredModel(agentId);
      const runtime = this.deps.resolveAgentRuntime?.(ctx.workspaceId, agentId, config.prompt, runtimePin);
      if (runtime) {
        this.deps.adapters.register(agentId, runtime);
        this.deps.logger.info('engine.agent_task.runtime_bound', { runId: ctx.runId, agentId, nodeId: node.id });
      }
    }

    // CONVERSATION THEATER: record the work hand-off (workflow → specialist).
    this.#recordSpecialistAssignment(ctx, node, agentId, config.prompt);

    const routing = this.#routeAgentTaskModel(ctx, agentId, config, null);
    const preferredModel = routing.selectedModel ?? null;
    this.deps.logger.info('engine.agent_task.model_routed', {
      runId: ctx.runId,
      workflowId: ctx.workflowId,
      nodeId: node.id,
      agentId,
      taskClass: routing.taskClass,
      selectedModel: routing.selectedModel,
      modelTier: routing.modelTier,
      explicitPin: routing.explicitPin,
      reason: routing.reason,
      alternatives: routing.alternatives.slice(0, 4),
    });

    // Estimate the input tokens this dispatch sends so the dispatch path can
    // attribute consumption on completion (most CLI harnesses report no usage).
    if (!ctx.nodeDispatchInputTokens) ctx.nodeDispatchInputTokens = new Map();
    ctx.nodeDispatchInputTokens.set(
      node.id,
      estimateTokens(prompt) + (Object.keys(inputData).length > 0 ? estimateTokens(safeJson(inputData)) : 0),
    );
    // Capture the resolved input so the reliability fallback can rebuild the task
    // if this bound runtime returns empty / fails.
    this.#recordNodeInput(ctx, node.id, inputData);

    try {
      await this.deps.adapters.dispatchTask({
        taskId,
        runId: ctx.runId,
        workflowId: ctx.workflowId,
        nodeId: node.id,
        title: node.title,
        description: prompt,
        inputData,
        scratchpadSnapshot: this.deps.scratchpad.snapshotOf(ctx.runId),
        capabilityTags: config.capabilityTags,
        runtimeRequirements: runtimeRequirementsFromAgentRequirements(
          config.requires,
          `Workflow node ${node.id} (${node.title})`,
        ),
        timeoutMs: CONSTANTS.AGENT_TASK_RESPONSE_TIMEOUT_MS,
        preferredModel,
        // Run-scoped cancellation: Stop aborts this so the in-flight model call ends.
        ...(ctx.abortController ? { signal: ctx.abortController.signal } : {}),
      }, agentId);
    } catch (err) {
      // A bare ADAPTER_UNAVAILABLE tells the operator nothing actionable —
      // name the agent, the node, and the two real remedies.
      if (err instanceof AgentisError && err.code === 'ADAPTER_UNAVAILABLE') {
        throw new AgentisError(
          'ADAPTER_UNAVAILABLE',
          `Agent "${agentId}" has no live runtime for node "${node.title || node.id}": no harness is connected and no workspace model could be bound. `
          + 'Connect the agent\'s harness (or set a default model in Settings), then re-run or replay from this node.',
        );
      }
      throw err;
    }
  }

  // ────────────────────────────────────────────────────────────
  // Persistent agent sessions (SMARTER-AGENTS-10X §VI–IX)
  //
  // An `agent_session` node is a parallel execution path to `agent_task`. The
  // engine owns orchestration: it seeds a DB-backed session, drives the
  // cognitive loop via AgentSessionRuntime, and on a YIELD parks the session
  // (the node leaves `activeExecutions`, its nodeState goes WAITING, the run
  // settles to WAITING like a checkpoint). Wake signals — a fired event, an
  // elapsed timer, an approval decision — re-open the node and re-advance.
  // Delegation is resolved synchronously inline (bounded by
  // SESSION_MAX_DELEGATION_DEPTH) so it never needs cross-tick parking.
  // ────────────────────────────────────────────────────────────

  #routeAgentTaskModel(
    ctx: RunningContext,
    agentId: string,
    config: AgentTaskNodeConfig,
    contextPreferredModel: string | null,
  ) {
    const row = this.deps.db
      .select({
        adapterType: schema.agents.adapterType,
        runtimeModel: schema.agents.runtimeModel,
        config: schema.agents.config,
      })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId))
      .get();
    const registration = this.deps.adapters.get(agentId);
    const explicitNodeModel = stringValue(config.modelOverride);
    const explicitAgentModel = agentConfiguredModel(row);
    const runtime = registration?.adapter.adapterType ?? row?.adapterType ?? null;
    return routeModelForTask({
      task: config.prompt,
      purpose: 'agent_task',
      runtime,
      explicitModel: explicitNodeModel ?? explicitAgentModel,
      currentModel: contextPreferredModel,
      candidateModels: contextPreferredModel ? [{ model: contextPreferredModel, runtime, source: 'agent_config' }] : [],
      requiredAffordances: [
        ...(config.capabilityTags ?? []),
        ...(config.requires ? requiredAffordanceKeys(config.requires) : []),
      ].map(String),
    });
  }

  #agentConfiguredModel(agentId: string): string | null {
    const row = this.deps.db
      .select({ runtimeModel: schema.agents.runtimeModel, config: schema.agents.config })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId))
      .get();
    return agentConfiguredModel(row);
  }

  async #runAgentSession(
    ctx: RunningContext,
    node: WorkflowNode,
    config: AgentSessionNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.sessions || !this.deps.sessionRuntime) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', `agent_session node ${node.id} present but session runtime not wired`);
    }
    const { agentId, role } = this.#resolveSessionAgent(ctx, config.agentId, config.agentRole, config.capabilityTags, config.requires, node.id);
    const persona = config.persona || (role ? this.#specialistDef(ctx, role).systemPrompt : '');
    const runContextResult = await this.#withWorkspaceContext(ctx, config.prompt, undefined, '', agentId);
    const runContextBlock = runContextResult.prompt;
    const scoped = config.inputKeys.length > 0 ? pickKeys(inputData, config.inputKeys) : inputData;
    const promptWithContract = `${config.prompt}${buildNodeProcessBriefing(ctx.graph, node, config)}`;
    const taskBlock = Object.keys(scoped).length > 0
      ? `${promptWithContract}\n\nINPUT:\n${safeJson(scoped)}`
      : promptWithContract;
    // (runId, nodeId)-keyed so a woken node reuses its persistent identity.
    const session = this.deps.sessions.getOrCreate({
      agentId,
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      nodeId: node.id,
      personaBlock: persona,
      taskBlock,
    });
    const runCtx: SessionRunContext = {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      runId: ctx.runId,
      nodeId: node.id,
      agentId,
      workflowId: ctx.workflowId,
      appId: this.deps.resolveAppIdForWorkflow?.(ctx.workspaceId, ctx.workflowId) ?? null,
      artifactPolicy: artifactPolicyFromUnknown(config.artifactPolicy),
      planId: ctx.planId,
      role,
      runContextBlock,
      maxSteps: config.maxSteps,
      ...(ctx.abortController ? { signal: ctx.abortController.signal } : {}),
    };
    if (ctx.planId && this.deps.plans) {
      this.deps.plans.bindSession(ctx.workspaceId, ctx.userId, ctx.planId, session.id);
    }
    this.#openSession(ctx, node, session.id);
    void this.#driveSession(ctx, node, session.id, runCtx);
  }

  /** Hold the session node open with a synthetic active execution. */
  #openSession(ctx: RunningContext, node: WorkflowNode, sessionId: string): void {
    ctx.state.activeExecutions[node.id] = {
      taskId: `session:${node.id}`,
      nodeId: node.id,
      executorType: 'session',
      executorRef: sessionId,
      startedAt: new Date().toISOString(),
    };
    // Persist the dispatch transition so observers see the session in flight
    // (fire-and-forget: this is observability, not a completion write).
    void this.#persistRun(ctx).catch(() => {});
  }

  /** Drive a session to its next non-delegate outcome, then resolve the node. */
  async #driveSession(ctx: RunningContext, node: WorkflowNode, sessionId: string, runCtx: SessionRunContext): Promise<void> {
    try {
      const outcome = await this.#advanceSessionLoop(ctx, node, sessionId, runCtx);
      if (ctx.cancellationRequested || ctx.abortController?.signal.aborted) return;
      await this.#onSessionOutcome(ctx, node, sessionId, runCtx, outcome);
    } catch (err) {
      if (ctx.cancellationRequested || ctx.abortController?.signal.aborted) return;
      this.deps.sessions?.fail(sessionId, (err as Error).message);
      await this.#failNode(ctx, node.id, (err as Error).message);
      void this.#tick(ctx);
    }
  }

  /**
   * Advance the session, resolving any `delegate` yields synchronously inline
   * (a nested session advanced to terminal, its result injected as the tool
   * response). Returns the first non-delegate outcome.
   */
  async #advanceSessionLoop(ctx: RunningContext, node: WorkflowNode, sessionId: string, runCtx: SessionRunContext): Promise<SessionOutcome> {
    let outcome = await this.deps.sessionRuntime!.advance(sessionId, runCtx);
    if (runCtx.signal?.aborted) return { kind: 'cancelled' };
    while (outcome.kind === 'suspended' && (outcome.yield.kind === 'delegate' || outcome.yield.kind === 'delegate_team')) {
      const y = outcome.yield;
      const payload = y.kind === 'delegate'
        ? await this.#runDelegate(ctx, node, sessionId, runCtx, y)
        : await this.#runDelegateTeam(ctx, node, sessionId, runCtx, y);
      this.deps.sessionRuntime!.injectWake(sessionId, y.toolCallId, payload);
      outcome = await this.deps.sessionRuntime!.advance(sessionId, runCtx);
      if (runCtx.signal?.aborted) return { kind: 'cancelled' };
    }
    return outcome;
  }

  /**
   * W3 — run a TEAM of delegates in PARALLEL, await all, and return the array of
   * results for the parent to synthesize. Each member reuses #runDelegate (depth
   * guard, grant attenuation, on-demand specialist creation all apply per member).
   */
  async #runDelegateTeam(
    ctx: RunningContext,
    node: WorkflowNode,
    parentSessionId: string,
    parentRunCtx: SessionRunContext,
    y: Extract<SessionYield, { kind: 'delegate_team' }>,
  ): Promise<unknown> {
    const results = await Promise.all(
      y.members.map(async (m, index) => {
        const single: Extract<SessionYield, { kind: 'delegate' }> = { kind: 'delegate', toolCallId: `${y.toolCallId}::${index}`, ...m };
        const result = await this.#runDelegate(ctx, node, parentSessionId, parentRunCtx, single);
        return { role: m.role, ...(result as Record<string, unknown>) };
      }),
    );
    return { ok: true, team: results };
  }

  /** Run a delegated subtask as a child session, synchronously, to terminal. */
  async #runDelegate(
    ctx: RunningContext,
    node: WorkflowNode,
    parentSessionId: string,
    parentRunCtx: SessionRunContext,
    y: Extract<SessionYield, { kind: 'delegate' }>,
  ): Promise<unknown> {
    const parent = this.deps.sessions!.get(parentSessionId);
    const depth = (parent?.delegationDepth ?? 0) + 1;
    if (depth > CONSTANTS.SESSION_MAX_DELEGATION_DEPTH) {
      return { ok: false, error: `delegation depth limit (${CONSTANTS.SESSION_MAX_DELEGATION_DEPTH}) reached — handle this subtask yourself` };
    }
    const resolved = await this.#resolveDelegateAgent(ctx, node, parentRunCtx.agentId, y);
    if (!resolved) {
      return { ok: false, error: `no agent available for role '${y.role}'. Create it first or pass create_if_missing/temporary.` };
    }
    const { agentId } = resolved;
    // Honor the specialist profile's runtime budget: a `maxDepth` cap refuses the
    // delegation before spinning up a child session. Before this the profile's
    // budget was authored but never enforced.
    if (resolved.runtimeBudget?.maxDepth != null && depth > resolved.runtimeBudget.maxDepth) {
      return { ok: false, error: `specialist role '${y.role}' profile caps delegation depth at ${resolved.runtimeBudget.maxDepth} (this delegate would run at depth ${depth})` };
    }
    const child = this.deps.sessions!.create({
      agentId,
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      nodeId: `${node.id}::delegate::${y.toolCallId}`,
      personaBlock: this.#specialistDef(ctx, y.role).systemPrompt,
      taskBlock: y.task,
      parentSessionId,
      delegationDepth: depth,
    });
    // CONVERSATION THEATER: one agent handing a sub-task to another (A2A delegation).
    const fromAgentId = parent?.agentId;
    this.deps.activity.record({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      userId: ctx.userId,
      eventType: 'agent.delegated',
      actorType: 'agent',
      actorId: fromAgentId ?? agentId,
      entityType: 'run',
      entityId: ctx.runId,
      summary: `${this.#agentName(fromAgentId) ?? 'Agent'} → ${this.#agentName(agentId) ?? y.role}: ${y.task.slice(0, 120)}`,
      metadata: {
        runId: ctx.runId,
        fromAgentId,
        toAgentId: agentId,
        role: y.role,
        task: y.task.slice(0, 400),
        ...(resolved.created ? { created: true } : {}),
        ...(resolved.instanceId ? { specialistInstanceId: resolved.instanceId, temporary: Boolean(y.temporary) } : {}),
      },
    });
    this.#emitDelegateStep(ctx, {
      nodeId: child.nodeId!,
      childSessionId: child.id,
      parentSessionId,
      agentId,
      role: y.role,
      phase: 'start',
      description: `${this.#agentName(agentId) ?? y.role} started: ${y.task.slice(0, 120)}`,
    });
    // Attenuate the parent's delegation scope against what it granted this
    // delegate (§8). The child can only ever narrow — never widen — its parent's
    // tool scope. A top-level session with no grant + no request stays
    // unrestricted, preserving existing behavior.
    // Fold the profile budget's maxTokens into the delegate's grant (narrowest
    // wins) so `runtimeProfile.budget.maxTokens` actually bounds the child.
    const budgetMaxTokens = [y.maxTokens, resolved.runtimeBudget?.maxTokens]
      .filter((value): value is number => typeof value === 'number' && value > 0);
    const grant = attenuateGrant(
      parentRunCtx.grant,
      { tools: y.allowedTools, paths: y.allowedPaths, ...(budgetMaxTokens.length ? { maxTokens: Math.min(...budgetMaxTokens) } : {}) },
      depth,
    );
    const childRunContext = await this.#withWorkspaceContext(ctx, y.task, undefined, '', agentId);
    const childCtx: SessionRunContext = {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      runId: ctx.runId,
      nodeId: node.id,
      agentId,
      workflowId: ctx.workflowId,
      planId: parentRunCtx.planId ?? ctx.planId,
      role: y.role,
      runContextBlock: childRunContext.prompt,
      ...(grant ? { grant } : {}),
      ...(parentRunCtx.signal ? { signal: parentRunCtx.signal } : {}),
    };
    // Specialist run telemetry — record the delegation as a specialist run and
    // advance it planned → running → completed/failed. Before this, delegation
    // created a specialist INSTANCE but no run, and the demand-router path left
    // run rows stuck at `planned` (write-only). Best-effort: a telemetry failure
    // must never break the delegation itself.
    let specialistRunId: string | null = null;
    if (this.deps.specialistRuntime && resolved.instanceId) {
      try {
        specialistRunId = this.deps.specialistRuntime.recordPlannedRun({
          workspaceId: ctx.workspaceId,
          role: y.role,
          agentId,
          topology: 'direct',
          task: y.task,
        }).id;
        this.deps.specialistRuntime.updateRun(ctx.workspaceId, specialistRunId, {
          status: 'running',
          traceEvent: { event: 'running', summary: 'Delegation started.' },
        });
      } catch { /* telemetry is best-effort */ }
    }
    const settleSpecialistRun = (status: 'completed' | 'failed', summary: string) => {
      if (!specialistRunId || !this.deps.specialistRuntime) return;
      try {
        this.deps.specialistRuntime.updateRun(ctx.workspaceId, specialistRunId, {
          status,
          outputSummary: summary.slice(0, 400),
          traceEvent: { event: status, summary: `Delegation ${status}.` },
        });
      } catch { /* telemetry is best-effort */ }
    };
    const outcome = await this.#advanceSessionLoop(ctx, node, child.id, childCtx);
    if (outcome.kind === 'completed' || outcome.kind === 'max_steps') {
      settleSpecialistRun('completed', typeof outcome.output === 'string' ? outcome.output : JSON.stringify(outcome.output ?? {}));
      this.#emitDelegateStep(ctx, {
        nodeId: child.nodeId!,
        childSessionId: child.id,
        parentSessionId,
        agentId,
        role: y.role,
        phase: 'complete',
        description: `${this.#agentName(agentId) ?? y.role} finished`,
      });
      return { ok: true, result: outcome.output };
    }
    if (outcome.kind === 'failed') {
      settleSpecialistRun('failed', outcome.error);
      this.#emitDelegateStep(ctx, {
        nodeId: child.nodeId!,
        childSessionId: child.id,
        parentSessionId,
        agentId,
        role: y.role,
        phase: 'fail',
        description: outcome.error.slice(0, 200),
      });
      return { ok: false, error: outcome.error };
    }
    settleSpecialistRun('failed', 'delegated sub-agent attempted an unsupported non-delegate yield');
    this.#emitDelegateStep(ctx, {
      nodeId: child.nodeId!,
      childSessionId: child.id,
      parentSessionId,
      agentId,
      role: y.role,
      phase: 'fail',
      description: 'unsupported non-delegate yield',
    });
    // A delegated child cannot park (no cross-tick wake path for sub-sessions).
    return { ok: false, error: 'delegated sub-agent attempted a non-delegate yield (await/sleep/approval), which is unsupported inside synchronous delegation' };
  }

  async #resolveDelegateAgent(
    ctx: RunningContext,
    node: WorkflowNode,
    parentAgentId: string,
    y: Extract<SessionYield, { kind: 'delegate' }>,
  ): Promise<{ agentId: string; created?: boolean; instanceId?: string; runtimeBudget?: { maxTokens?: number; maxDollars?: number; maxDelegations?: number; maxDepth?: number } } | null> {
    const role = normalizeRole(y.role);
    let agentId = this.deps.specialists?.resolveRole(ctx.workspaceId, role) ?? this.#findAgentByRole(ctx.workspaceId, role);
    let created = false;
    let def: SpecialistDefinition | null = null;

    if (!agentId && (y.createIfMissing || y.temporary)) {
      if (!this.deps.specialists) return null;
      const authored = await this.deps.specialists.authorSpecialist(ctx.workspaceId, ctx.userId, {
        role,
        name: y.name,
        description: `Specialist delegated from workflow node "${node.title || node.id}".`,
        instructions: y.instructions ?? y.task,
        source: 'generated',
      });
      agentId = authored.agentId;
      created = authored.created;
      def = authored.def;
    }

    if (!agentId) return null;

    def ??= this.#specialistDef(ctx, role);
    const profile = this.deps.specialistProfiles?.ensureFromDef(ctx.workspaceId, def, ctx.userId);
    const leaseMinutes = y.temporary ? Math.max(1, Math.min(y.leaseMinutes ?? 60, 24 * 60)) : undefined;
    const instanceId = this.deps.specialistRuntime?.ensureInstance({
      workspaceId: ctx.workspaceId,
      role,
      agentId,
      profileId: profile?.id ?? null,
      mode: y.temporary ? 'ephemeral' : 'durable',
      parentAgentId,
      reportsTo: parentAgentId,
      leaseExpiresAt: leaseMinutes ? new Date(Date.now() + leaseMinutes * 60_000).toISOString() : null,
    });

    const runtimeBudget = profile?.runtimeProfile?.budget;
    return { agentId, ...(created ? { created } : {}), ...(instanceId ? { instanceId } : {}), ...(runtimeBudget ? { runtimeBudget } : {}) };
  }

  async #onSessionOutcome(
    ctx: RunningContext,
    node: WorkflowNode,
    sessionId: string,
    runCtx: SessionRunContext,
    outcome: SessionOutcome,
  ): Promise<void> {
    switch (outcome.kind) {
      case 'completed':
      case 'max_steps':
        {
          // Roll the session's accumulated token usage onto this node so it lands
          // on the terminal node.completed audit entry (the single analytics sink).
          const session = this.deps.sessions?.get(sessionId);
          if (session) this.#recordNodeTokens(ctx, node.id, session.totalTokensIn, session.totalTokensOut);
          const completedOutput = await this.#completeNode(ctx, node.id, outcome.output);
          if (!completedOutput) return;
          this.#enqueueSuccessfulBrainCapture(ctx, node.id, completedOutput, runCtx.agentId);
        }
        void this.#tick(ctx);
        return;
      case 'failed':
        await this.#failNode(ctx, node.id, outcome.error);
        void this.#tick(ctx);
        return;
      case 'cancelled':
        return;
      case 'suspended':
        await this.#parkSession(ctx, node, sessionId, runCtx, outcome.yield);
        return;
    }
  }

  /**
   * Park a yielded session: release the node (so the run settles to WAITING,
   * mirroring the checkpoint gate) and register the wake condition. Delegation
   * never reaches here — it is resolved inline by #advanceSessionLoop.
   */
  async #parkSession(ctx: RunningContext, node: WorkflowNode, sessionId: string, runCtx: SessionRunContext, y: SessionYield): Promise<void> {
    delete ctx.state.activeExecutions[node.id];
    const ns = ctx.state.nodeStates[node.id];
    if (ns) ns.status = 'WAITING';

    switch (y.kind) {
      case 'await_event': {
        const list = this.#sessionWaiters(ctx).get(y.event) ?? [];
        list.push({ sessionId, nodeId: node.id, toolCallId: y.toolCallId, runCtx });
        this.#sessionWaiters(ctx).set(y.event, list);
        break;
      }
      case 'await_runs': {
        // Fan-in: park (zero tokens) until EVERY run in the set settles, then wake
        // this session with all their statuses — the in-session twin of
        // agentis.run.await_all. Shares the one settle helper. A generous 6h cap
        // bounds a truly stuck set; on a partial timeout the agent resumes with the
        // pending ids and can await_runs them again (mirrors the tool).
        const runIds = y.runIds;
        void waitForAllRunsSettle({ db: this.deps.db, bus: this.deps.bus }, ctx.workspaceId, runIds, { timeoutMs: 6 * 60 * 60_000 })
          .then((res) => this.#wakeSession(ctx, node, sessionId, runCtx, y.toolCallId, summarizeFanIn(runIds, res)))
          .catch((err) => this.#wakeSession(ctx, node, sessionId, runCtx, y.toolCallId, { ok: false, error: (err as Error).message }));
        break;
      }
      case 'sleep_until': {
        const remaining = Math.max(0, Date.parse(y.untilIso) - Date.now());
        this.#armTimer(remaining, () => {
          void this.#wakeSession(ctx, node, sessionId, runCtx, y.toolCallId, { sleptUntil: y.untilIso });
        });
        break;
      }
      case 'run_workflow': {
        // W4 — run a saved workflow as a subroutine and wake this session with its
        // result. Reuses SubflowExecutor (child-run lifecycle + completion bridge).
        if (!this.deps.subflows) {
          await this.#wakeSession(ctx, node, sessionId, runCtx, y.toolCallId, { ok: false, error: 'workflow-as-tool is not available on this deployment' });
          break;
        }
        try {
          await this.deps.subflows.start({
            parentRunId: ctx.runId,
            // Colon-free: the subflow pending-key is `parentRunId:parentNodeId`
            // and is split on ':', so the synthetic id must contain no colons.
            parentNodeId: `${node.id}__wf__${y.toolCallId}`.replace(/:/g, '_'),
            workspaceId: ctx.workspaceId,
            ambientId: ctx.ambientId,
            userId: ctx.userId,
            childWorkflowId: y.workflowId,
            inputs: y.inputs ?? {},
            resumeParent: async (output) => { await this.#wakeSession(ctx, node, sessionId, runCtx, y.toolCallId, { ok: true, result: output }); },
            failParent: async (msg) => { await this.#wakeSession(ctx, node, sessionId, runCtx, y.toolCallId, { ok: false, error: msg }); },
            startChildRun: async (childArgs) => { const handle = await this.startRun(childArgs); return { runId: handle.runId }; },
          });
        } catch (err) {
          await this.#wakeSession(ctx, node, sessionId, runCtx, y.toolCallId, { ok: false, error: (err as Error).message });
        }
        break;
      }
      case 'build_workflow': {
        // W4 — author + persist a new saved workflow (validated). The wake is
        // deferred to a microtask so it runs AFTER #parkSession settles (mirrors
        // the async resolution of the other yields).
        let payload: Record<string, unknown>;
        try {
          const graph = normalizeWorkflowGraph(this.deps.db, ctx.workspaceId, y.graph as unknown as WorkflowGraph).graph;
          validateWorkflowGraph(graph, { strict: true });
          const workflowId = randomUUID();
          const initialGraph: WorkflowGraph = this.deps.revisions
            ? { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }
            : graph;
          this.deps.db.insert(schema.workflows).values({
            id: workflowId, workspaceId: ctx.workspaceId, ambientId: ctx.ambientId,
            userId: ctx.userId, title: y.title.slice(0, 200), graph: initialGraph as unknown as object, settings: {},
          }).run();
          const candidate = this.deps.revisions
            ? this.deps.revisions.createCandidate({
                workspaceId: ctx.workspaceId,
                workflowId,
                graph,
                baseRevisionId: this.deps.revisions.ensureWorkflow(ctx.workspaceId, workflowId).active.id,
                source: 'agent_build',
                actor: { type: 'agent', id: runCtx.agentId },
                reason: `Created by running agent ${runCtx.agentId}`,
              }).revision
            : null;
          payload = {
            ok: true,
            workflowId,
            title: y.title,
            ...(candidate ? { candidateRevisionId: candidate.id, verificationRequired: true } : {}),
          };
        } catch (err) {
          payload = { ok: false, error: `invalid workflow: ${(err as Error).message}` };
        }
        queueMicrotask(() => { void this.#wakeSession(ctx, node, sessionId, runCtx, y.toolCallId, payload); });
        break;
      }
      case 'request_approval': {
        const approval = await this.deps.approvals.create({
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId,
          userId: ctx.userId,
          runId: ctx.runId,
          taskId: null,
          targetId: node.id,
          gatewayId: null,
          source: 'checkpoint',
          title: y.title || 'Agent approval',
          summary: y.summary || `Agent session paused for approval in run ${ctx.runId}`,
          confidence: null,
        });
        this.#pendingApprovals(ctx).set(approval.id, { kind: 'session', targetId: node.id, sessionId, toolCallId: y.toolCallId, runCtx });
        break;
      }
      case 'delegate':
        return; // unreachable — resolved inline
    }

    await this.#persistRun(ctx);
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_WAITING_FOR_INPUT, {
      runId: ctx.runId,
      nodeId: node.id,
      reason: y.kind,
    });
    void this.#tick(ctx);
  }

  /** Re-open a parked session, inject the awaited result, and re-advance it. */
  async #wakeSession(
    ctx: RunningContext,
    node: WorkflowNode,
    sessionId: string,
    runCtx: SessionRunContext,
    toolCallId: string,
    payload: unknown,
  ): Promise<void> {
    const session = this.deps.sessions?.get(sessionId);
    if (!session || session.status !== 'waiting') return; // already woken / terminal
    this.deps.sessionRuntime!.injectWake(sessionId, toolCallId, payload);
    const ns = ctx.state.nodeStates[node.id];
    if (ns) ns.status = 'RUNNING';
    this.#openSession(ctx, node, sessionId);
    await this.#driveSession(ctx, node, sessionId, runCtx);
  }

  #sessionWaiters(ctx: RunningContext): Map<string, SessionWaiter[]> {
    if (!ctx.sessionWaiters) ctx.sessionWaiters = new Map();
    return ctx.sessionWaiters;
  }

  /**
   * `setTimeout`'s delay is a 32-bit signed int internally — Node clamps any
   * delay beyond ~24.8 days (2147483647ms) to ~1ms, firing almost instantly
   * instead of waiting. `wait` nodes and `sleep_until` sessions can be parked
   * far longer than that, so long delays are chained in capped hops.
   */
  #armTimer(remainingMs: number, fire: () => void): void {
    const MAX_DELAY_MS = 2_147_483_647;
    if (remainingMs <= MAX_DELAY_MS) {
      const timer = setTimeout(fire, Math.max(0, remainingMs));
      timer.unref?.();
      return;
    }
    const timer = setTimeout(() => this.#armTimer(remainingMs - MAX_DELAY_MS, fire), MAX_DELAY_MS);
    timer.unref?.();
  }

  /**
   * Public wake entry-point for `await_event` yields. A trigger, webhook, or a
   * peer node calls this with a run-scoped event name; every session parked on
   * that name resumes with the payload.
   */
  async notifySessionEvent(args: { runId: string; event: string; payload?: unknown }): Promise<void> {
    const ctx = this.#runs.get(args.runId);
    if (!ctx) return;
    const waiters = ctx.sessionWaiters?.get(args.event);
    if (!waiters || waiters.length === 0) return;
    ctx.sessionWaiters!.delete(args.event);
    for (const w of waiters) {
      const node = ctx.graph.nodes.find((n) => n.id === w.nodeId);
      if (!node) continue;
      await this.#wakeSession(ctx, node, w.sessionId, w.runCtx, w.toolCallId, { event: args.event, payload: args.payload ?? null });
    }
  }

  /** Resolve an agent identity for a session from explicit id → role → capability tags. */
  #resolveSessionAgent(
    ctx: RunningContext,
    explicitAgentId: string | undefined,
    role: AgentRole | undefined,
    capabilityTags: string[] | undefined,
    requires: AgentRequirements | undefined,
    label: string,
  ): { agentId: string; role?: AgentRole } {
    // agent_session nodes are driven by the shared AgentSessionRuntime adapter,
    // not by a per-agent AdapterManager runtime — so the resolved identity needs
    // only to exist (persona/memory/scoping), never its own connected runtime.
    return this.#resolveAgentForNode(ctx, { explicitAgentId, role, capabilityTags, requires, label, executorProvided: true });
  }

  #resolveAgentForNode(
    ctx: RunningContext,
    args: {
      explicitAgentId?: string;
      role?: AgentRole;
      capabilityTags?: string[];
      requires?: AgentRequirements;
      /**
       * Runtime/adapter to seed a brand-new role-cast specialist with (see
       * {@link AgentTaskNodeConfig.preferredAdapter}). Ignored once the role
       * already has a materialized specialist — operator runtime choices win.
       */
      preferredAdapter?: string;
      label: string;
      /**
       * When true a dedicated executor (the AgentSessionRuntime's shared session
       * adapter) drives the node, so the resolved agent is an identity only and
       * need NOT have a connected AdapterManager runtime. Dispatch nodes
       * (`agent_task`/`agent_swarm`) leave this false and still require one.
       */
      executorProvided?: boolean;
    },
  ): { agentId: string; role?: AgentRole } {
    const validRole = args.role && isAgentRole(args.role) ? args.role : undefined;
    const hasRuntime = (id: string): boolean => Boolean(args.executorProvided) || this.#agentHasConnectedRuntime(id);
    if (args.explicitAgentId) {
      const explicitReady = hasRuntime(args.explicitAgentId)
        && this.#agentSatisfiesRequirements(args.explicitAgentId, args.requires);
      if (explicitReady) {
        return { agentId: args.explicitAgentId, role: validRole };
      }
      if (!this.#isSoftPinnedSpecialist(args.explicitAgentId)) {
        this.#assertAgentSatisfiesRequirements(args.explicitAgentId, args.requires, args.label);
        const agentName = this.#agentName(args.explicitAgentId) ?? args.explicitAgentId;
        throw new AgentisError(
          'WORKFLOW_GRAPH_INVALID',
          `${args.label}: agent "${agentName}" is offline. Reconnect its runtime or choose an online agent before running.`,
          {
            remediation: 'Reconnect the assigned agent runtime or bind this node to an online compatible agent.',
            details: {
              failureClass: 'configuration_capability',
              code: 'AGENT_RUNTIME_UNAVAILABLE',
              agentId: args.explicitAgentId,
            },
          },
        );
      }
    }
    if (validRole && this.deps.specialists) {
      const runtimeSeed = args.preferredAdapter ? { adapterType: args.preferredAdapter } : undefined;
      const id = this.deps.specialists.ensureRole(ctx.workspaceId, ctx.userId, validRole, runtimeSeed);
      if (id && hasRuntime(id) && this.#agentSatisfiesRequirements(id, args.requires)) {
        return { agentId: id, role: validRole };
      }
    }
    const fallback = this.#resolveConnectedFallbackAgent(
      ctx.workspaceId,
      args.capabilityTags ?? [],
      args.requires,
      validRole,
    );
    if (fallback) return { agentId: fallback, role: validRole };
    const requirements = describeAgentRequirements(args.requires);
    throw new AgentisError(
      'WORKFLOW_GRAPH_INVALID',
      requirements
        ? `${args.label}: could not resolve an agent satisfying ${requirements} (no agentId, resolvable role, or capability match)`
        : `${args.label}: could not resolve an agent (no agentId, resolvable role, or capability match)`,
    );
  }

  #assertAgentSatisfiesRequirements(agentId: string, requires: AgentRequirements | undefined, label: string): void {
    if (!hasAgentRequirements(requires)) return;
    if (this.#agentSatisfiesRequirements(agentId, requires)) return;
    throw new AgentisError(
      'WORKFLOW_GRAPH_INVALID',
      `${label}: agent ${agentId} does not satisfy required affordances (${describeAgentRequirements(requires)})`,
    );
  }

  #agentSatisfiesRequirements(agentId: string, requires: AgentRequirements | undefined): boolean {
    if (!hasAgentRequirements(requires)) return true;
    const capabilities = this.deps.adapters.capabilities(agentId);
    return adapterSatisfiesRequirements(capabilities, requires);
  }

  #toolLoopSatisfiesRequirements(requires: AgentRequirements | undefined): boolean {
    if (!hasAgentRequirements(requires)) return true;
    return requiredAffordanceKeys(requires).every((key) => key === 'fileSystem');
  }

  #agentHasOwnAgenticRuntime(agentId: string): boolean {
    const forwarding = this.deps.adapters.capabilities(agentId)?.toolForwarding;
    return forwarding === 'marker_protocol'
      || forwarding === 'mcp_native'
      || forwarding === 'session_event';
  }

  #agentHasConnectedRuntime(agentId: string): boolean {
    return Boolean(this.deps.adapters.get(agentId));
  }

  /**
   * Resolve every explicit specialist binding before the run becomes RUNNING.
   * This closes the old failure mode where a workflow started successfully and
   * then spent its self-heal budget discovering that its assigned HTTP/CLI agent
   * was merely a database placeholder. Runtime inheritance is attempted once;
   * if neither a bound runtime nor the workspace session model can execute the
   * node, the run is rejected at the readiness boundary with a precise message.
   */
  #preparePinnedAgentRuntimes(workspaceId: string, graph: WorkflowGraph): void {
    for (const node of graph.nodes) {
      if (node.config.kind !== 'agent_task' && node.config.kind !== 'agent_session') continue;
      const config = node.config;
      const agentId = config.agentId?.trim();
      if (!agentId) continue;
      const row = this.deps.db
        .select({
          id: schema.agents.id,
          name: schema.agents.name,
          isPaused: schema.agents.isPaused,
          status: schema.agents.status,
        })
        .from(schema.agents)
        .where(and(eq(schema.agents.id, agentId), eq(schema.agents.workspaceId, workspaceId)))
        .get();
      if (!row) {
        throw new AgentisError(
          'WORKFLOW_GRAPH_INVALID',
          `${node.title || node.id}: assigned specialist ${agentId} no longer exists. Re-bind this step before running.`,
        );
      }
      if (row.isPaused || row.status === 'paused') {
        throw new AgentisError(
          'WORKFLOW_GRAPH_INVALID',
          `${node.title || node.id}: assigned specialist "${row.name}" is paused. Resume or re-bind it before running.`,
        );
      }

      if (!this.deps.adapters.get(agentId)) {
        const runtime = this.deps.resolveAgentRuntime?.(
          workspaceId,
          agentId,
          config.prompt,
          this.#agentConfiguredModel(agentId),
        );
        if (runtime) this.deps.adapters.register(agentId, runtime);
      }

      const registration = this.deps.adapters.get(agentId);
      if (registration?.adapter.prepare) {
        void registration.adapter.prepare().catch((error) => {
          this.deps.logger.warn('engine.agent_task.prewarm_failed', {
            agentId,
            nodeId: node.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      const sessionEligible = config.kind === 'agent_session'
        || (config.useSession !== false && config.useRoleTools !== false);
      const canUseManagedSession = sessionEligible
        && Boolean(this.deps.sessions && this.deps.sessionRuntime?.canRun(workspaceId));
      if (!registration && !canUseManagedSession) {
        // Auto-authored specialists are intentionally soft pins: let the normal
        // role/capability resolver choose a connected runtime when their own
        // adapter has not been materialized yet.
        if (this.#isSoftPinnedSpecialist(agentId)) continue;
        throw new AgentisError(
          'WORKFLOW_GRAPH_INVALID',
          `${node.title || node.id}: agent "${row.name}" is offline. Reconnect its runtime or choose an online agent before running.`,
          {
            remediation: 'Reconnect the assigned agent runtime or bind this node to an online compatible agent.',
            details: {
              failureClass: 'configuration_capability',
              code: 'AGENT_RUNTIME_UNAVAILABLE',
              agentId,
              nodeId: node.id,
            },
          },
        );
      }
      if (registration && hasAgentRequirements(config.requires)
        && !adapterSatisfiesRequirements(registration.adapter.capabilities?.(), config.requires)) {
        throw new AgentisError(
          'WORKFLOW_GRAPH_INVALID',
          `${node.title || node.id}: "${row.name}" is online but its runtime lacks ${describeAgentRequirements(config.requires)}.`,
        );
      }
    }
  }

  #isSoftPinnedSpecialist(agentId: string): boolean {
    try {
      const row = this.deps.db
        .select({ config: schema.agents.config })
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId))
        .get();
      const config = row?.config;
      return Boolean(
        config
          && typeof config === 'object'
          && !Array.isArray(config)
          && (config as Record<string, unknown>).specialist === true,
      );
    } catch {
      return false;
    }
  }

  /**
   * `dynamic_swarm` (§VII): a planner decomposes a goal into independent tasks
   * at runtime; the engine runs them as worker sessions with bounded
   * parallelism and merges per `mergeStrategy`. Each worker runs to terminal —
   * a worker that parks is treated as a failure (no cross-tick wake for
   * pooled workers).
   */
  async #runDynamicSwarm(
    ctx: RunningContext,
    node: WorkflowNode,
    config: DynamicSwarmNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.sessions || !this.deps.sessionRuntime) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', `dynamic_swarm node ${node.id} present but session runtime not wired`);
    }
    const plannerRole = (config.plannerRole && isAgentRole(config.plannerRole) ? config.plannerRole : 'planner') as AgentRole;
    const tasks = await this.#planTaskList(ctx, config.goal, plannerRole, Math.max(1, config.maxTasks), inputData);
    if (tasks.length === 0) {
      await this.#completeNode(ctx, node.id, { [config.outputKey]: [], count: 0, tasks: [] });
      return;
    }
    const maxParallel = Math.min(Math.max(config.maxParallel || 1, 1), 16);
    const results: Record<string, unknown>[] = new Array(tasks.length);
    const failures: string[] = [];
    let cursor = 0;
    let stop = false;
    const worker = async (): Promise<void> => {
      while (!stop && cursor < tasks.length) {
        const idx = cursor++;
        const taskText = tasks[idx];
        if (!taskText) continue;
        try {
          const out = await this.#runWorkerSession(ctx, node, `${node.id}::dyn::${idx}`, config.agentRole, config.capabilityTags, config.requires, taskText);
          results[idx] = out;
          if (config.mergeStrategy === 'first_success') stop = true;
        } catch (err) {
          failures.push((err as Error).message);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(maxParallel, tasks.length) }, () => worker()));
    const collected = results.filter((r): r is Record<string, unknown> => Boolean(r));
    if (collected.length === 0) {
      await this.#failNode(ctx, node.id, `dynamic_swarm: all ${tasks.length} worker(s) failed (${failures[0] ?? 'unknown'})`);
      void this.#tick(ctx);
      return;
    }
    const merged = config.mergeStrategy === 'first_success'
      ? { [config.outputKey]: [collected[0]], count: 1, strategy: 'first_success', tasks }
      : { [config.outputKey]: collected, count: collected.length, tasks };
    await this.#completeNode(ctx, node.id, merged);
    void this.#tick(ctx);
  }

  /**
   * `planner` (§VII): a planner agent decomposes a goal, then SPLICES the plan
   * into the live run as a chain of `agent_session` worker nodes via a validated
   * graph patch — so the operator watches the plan materialize on the canvas and
   * each step executes through the normal engine tick (full memory + delegation).
   * If the splice cannot validate (e.g. the planner was a terminal node), it
   * falls back to deterministic inline-sequential execution.
   */
  async #runPlanner(
    ctx: RunningContext,
    node: WorkflowNode,
    config: PlannerNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.sessions || !this.deps.sessionRuntime) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', `planner node ${node.id} present but session runtime not wired`);
    }
    const plannerRole = (config.agentRole && isAgentRole(config.agentRole) ? config.agentRole : 'planner') as AgentRole;
    const scoped = config.inputKeys.length > 0 ? pickKeys(inputData, config.inputKeys) : inputData;
    const steps = await this.#planTaskList(ctx, config.goal, plannerRole, config.maxNodes ?? 8, scoped);
    if (steps.length === 0) {
      await this.#completeNode(ctx, node.id, { plan: [], results: [] });
      void this.#tick(ctx);
      return;
    }
    const workerRole = config.workerRole && isAgentRole(config.workerRole) ? config.workerRole : plannerRole;

    // Preferred: rewrite the live graph so the plan becomes real, observable,
    // independently-replayable nodes the engine runs itself.
    try {
      const spliced = await this.#splicePlanIntoGraph(ctx, node, steps, workerRole);
      await this.#completeNode(ctx, node.id, {
        plan: steps,
        generatedNodes: spliced.count,
        planRevision: spliced.newRevision,
        mode: 'live_graph',
      });
      void this.#tick(ctx);
      return;
    } catch (err) {
      this.deps.logger.warn('planner.splice_failed_fallback_sequential', {
        runId: ctx.runId,
        nodeId: node.id,
        error: (err as Error).message,
      });
    }

    // Fallback: inline sequential execution (no live graph edit).
    const results: Array<{ step: string; output: Record<string, unknown> }> = [];
    let accumulated: Record<string, unknown> = { ...scoped };
    for (let i = 0; i < steps.length; i += 1) {
      const stepText = steps[i]!;
      const task = `${stepText}\n\nPRIOR RESULTS:\n${safeJson(accumulated)}`;
      let out: Record<string, unknown>;
      try {
        out = await this.#runWorkerSession(ctx, node, `${node.id}::plan::${i}`, workerRole, [], undefined, task);
      } catch (err) {
        await this.#failNode(ctx, node.id, `planner step ${i + 1}/${steps.length} failed: ${(err as Error).message}`);
        void this.#tick(ctx);
        return;
      }
      results.push({ step: stepText, output: out });
      accumulated = { ...accumulated, [`step_${i + 1}`]: out };
    }
    await this.#completeNode(ctx, node.id, { plan: steps, results, mode: 'inline_sequential', ...accumulated });
    void this.#tick(ctx);
  }

  /**
   * Splice a decomposed plan into the running graph: one `agent_session` node per
   * step, chained planner → step1 → … → stepN, with the planner's original
   * successors re-routed to hang off the final step. Emits canvas placement
   * events so the new nodes animate in live. Throws (→ caller fallback) if the
   * resulting graph fails validation.
   */
  async #splicePlanIntoGraph(
    ctx: RunningContext,
    node: WorkflowNode,
    steps: string[],
    workerRole: AgentRole,
  ): Promise<{ count: number; newRevision: number }> {
    const base = ctx.state.graphRevision;
    const outgoing = ctx.graph.edges.filter((e) => e.source === node.id);
    const pos = node.position ?? { x: 0, y: 0 };
    const addNodes: WorkflowNode[] = [];
    const addEdges: WorkflowEdge[] = [];
    let prevId = node.id;
    steps.forEach((stepText, i) => {
      const stepId = `${node.id}__plan_${i + 1}`;
      addNodes.push({
        id: stepId,
        type: 'agent_session',
        title: `Plan ${i + 1}/${steps.length}`,
        position: { x: pos.x + (i + 1) * 280, y: pos.y },
        config: {
          kind: 'agent_session',
          agentRole: workerRole,
          prompt: stepText,
          inputKeys: [],
          outputKeys: [],
          capabilityTags: [],
        },
      });
      addEdges.push({ id: `${node.id}__plan_e_${i}`, source: prevId, target: stepId, type: 'default' });
      prevId = stepId;
    });
    // Re-route the planner's former successors onto the tail of the plan chain.
    outgoing.forEach((e, i) => {
      addEdges.push({
        id: `${node.id}__plan_join_${i}`,
        source: prevId,
        target: e.target,
        ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
        type: 'default',
      });
    });
    const patch: WorkflowGraphPatch = {
      patchId: randomUUID(),
      reason: 'planner_replan',
      baseGraphRevision: base,
      addNodes,
      updateNodes: [],
      removeNodeIds: [],
      addEdges,
      removeEdgeIds: outgoing.map((e) => e.id),
    };
    const { newRevision } = await this.applyGraphPatch({ runId: ctx.runId, patch });
    for (const n of addNodes) {
      this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.CANVAS_NODE_PLACED, {
        runId: ctx.runId, nodeId: n.id, node: n,
      });
    }
    for (const e of addEdges) {
      this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.CANVAS_EDGE_CONNECTED, {
        runId: ctx.runId, edgeId: e.id, edge: e,
      });
    }
    return { count: addNodes.length, newRevision };
  }

  /** Run one worker session to terminal and return its output (throws on park/fail). */
  async #runWorkerSession(
    ctx: RunningContext,
    node: WorkflowNode,
    sessionNodeId: string,
    role: AgentRole | undefined,
    capabilityTags: string[] | undefined,
    requires: AgentRequirements | undefined,
    task: string,
  ): Promise<Record<string, unknown>> {
    const { agentId, role: resolved } = this.#resolveSessionAgent(ctx, undefined, role, capabilityTags, requires, sessionNodeId);
    const session = this.deps.sessions!.create({
      agentId,
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      nodeId: sessionNodeId,
      personaBlock: resolved ? this.#specialistDef(ctx, resolved).systemPrompt : '',
      taskBlock: task,
    });
    const runContextResult = await this.#withWorkspaceContext(ctx, task, undefined, '', agentId);
    const runContextBlock = runContextResult.prompt;
    const runCtx: SessionRunContext = {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      runId: ctx.runId,
      nodeId: node.id,
      agentId,
      workflowId: ctx.workflowId,
      planId: ctx.planId,
      role: resolved,
      runContextBlock,
    };
    const outcome = await this.#advanceSessionLoop(ctx, node, session.id, runCtx);
    if (outcome.kind === 'completed' || outcome.kind === 'max_steps') {
      this.#enqueueSuccessfulBrainCapture(ctx, sessionNodeId, outcome.output, agentId, { task });
      return outcome.output;
    }
    if (outcome.kind === 'failed') throw new AgentisError('INTERNAL_ERROR', outcome.error);
    throw new AgentisError('INTERNAL_ERROR', 'worker session yielded (await/sleep/approval), unsupported in this context');
  }

  /** Run a planner session and parse its JSON task list (bounded by `max`). */
  async #planTaskList(
    ctx: RunningContext,
    goal: string,
    plannerRole: AgentRole,
    max: number,
    inputData: Record<string, unknown>,
  ): Promise<string[]> {
    const { agentId } = this.#resolveSessionAgent(ctx, undefined, plannerRole, [], undefined, 'planner');
    const contextBlock = Object.keys(inputData).length > 0 ? `\n\nCONTEXT:\n${safeJson(inputData)}` : '';
    const task =
      `Decompose this goal into at most ${max} independent subtasks.\n` +
      `Goal: ${goal}${contextBlock}\n\n` +
      `Reply by calling complete_task with output set to a JSON array of strings — ` +
      `each string a self-contained subtask. No prose.`;
    const session = this.deps.sessions!.create({
      agentId,
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      nodeId: `planner::${randomUUID()}`,
      personaBlock: this.#specialistDef(ctx, plannerRole).systemPrompt,
      taskBlock: task,
    });
    const runContextResult = await this.#withWorkspaceContext(ctx, task, undefined, '', agentId);
    const runCtx: SessionRunContext = {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      runId: ctx.runId,
      nodeId: 'planner',
      agentId,
      workflowId: ctx.workflowId,
      planId: ctx.planId,
      role: plannerRole,
      runContextBlock: runContextResult.prompt,
      maxSteps: 6,
    };
    const outcome = await this.deps.sessionRuntime!.advance(session.id, runCtx);
    const text = (outcome.kind === 'completed' || outcome.kind === 'max_steps') ? extractPlanText(outcome.output) : '';
    return parseTaskList(text, max);
  }

  /**
   * Compose an agent prompt's system preamble: optional role identity, then the
   * workspace context block (Layer 1), the agent's personal memory (§G11), then
   * the task prompt. Best effort: a context-read failure must never block a
   * dispatch.
   */
  async #withWorkspaceContext(
    ctx: RunningContext,
    prompt: string,
    rolePrompt?: string,
    skillBlock?: string,
    agentId?: string
  ): Promise<{ prompt: string }> {
    // Authored workspace context (the operator "charter") and knowledge-base
    // passages are no longer injected as a separate block: they are atoms in
    // the DB brain now, surfaced by `brainBlock` below — the charter via the
    // always-on constitutional tier, KB passages via relevance retrieval. A
    // separate block would double-inject them.
    const block = '';
    let agentIdentityBlock = '';
    if (agentId) {
      try {
        agentIdentityBlock = renderAgentIdentityBlock(loadAgentIdentitySnapshot(this.deps.db, ctx.workspaceId, agentId)) ?? '';
      } catch (err) {
        this.deps.logger.warn('engine.agent_identity.failed', { runId: ctx.runId, agentId, err: (err as Error).message });
      }
    }
    let brainBlock = '';
    if (this.deps.sharedIntelligence) {
      try {
        // §C7 — App-owned runs recall the UNION of the App's brain and the
        // operating agent's own memory (neither is amnesic to the other); a
        // plain run just recalls the agent's scope. Workspace-shared atoms come
        // through either pass.
        const appScopeId = this.#appScopeId(ctx.workspaceId, ctx.workflowId);
        const recallScopes = [appScopeId, agentId].filter((s): s is string => Boolean(s));
        const brain = await this.deps.sharedIntelligence.buildDispatchContext({
          workspaceId: ctx.workspaceId,
          scopeId: appScopeId ?? agentId ?? null,
          scopeIds: recallScopes.length > 0 ? Array.from(new Set(recallScopes)) : undefined,
          agentId: agentId ?? null,
          runId: ctx.runId,
          taskDescription: prompt,
          limit: 8,
        });
        if (brain.block) brainBlock = `<workspace_brain>\n${brain.block}\n</workspace_brain>`;
      } catch (err) {
        this.deps.logger.warn('engine.shared_brain_context.failed', { runId: ctx.runId, err: (err as Error).message });
      }
    }
    let peerContext = '';
    if (this.deps.peerProfiles) {
      try {
        const observerScope = agentId ?? 'global';
        const instructions = this.deps.peerProfiles.renderSystemInstructions(ctx.workspaceId, 'user', ctx.userId, observerScope);
        const facts = this.deps.peerProfiles.renderContextFacts(ctx.workspaceId, 'user', ctx.userId, observerScope);
        const parts = [instructions, facts.length > 0 ? `PEER CARD FACTS\n${facts.map((fact) => `- ${fact}`).join('\n')}` : ''].filter(Boolean);
        if (parts.length > 0) peerContext = `<peer_context>\n${parts.join('\n\n')}\n</peer_context>`;
      } catch (err) {
        this.deps.logger.warn('engine.peer_context.failed', { runId: ctx.runId, err: (err as Error).message });
      }
    }
    // §G11 — the dispatched agent's personal memory. It now lives in the
    // canonical brain (memory_episodes, scope_id = agentId) and is already
    // surfaced by `brainBlock` above (buildDispatchContext retrieves scope
    // "both" = workspace + this agent's scope). No separate injection — that
    // would double-inject the same atoms.
    const agentMemory = '';
    let personalBrain = '';
    if (agentId && this.deps.personalBrain) {
      try {
        personalBrain = await this.deps.personalBrain.contextForAgent(ctx.userId, agentId, prompt);
      } catch (err) {
        this.deps.logger.warn('engine.personal_brain.failed', { runId: ctx.runId, err: (err as Error).message });
      }
    }
    let spaceContext = '';
    if (agentId && this.deps.db) {
      try {
        const spaceRow = this.deps.db
          .select({
             name: schema.spaces.name,
             description: schema.spaces.description,
             managerId: schema.spaces.managerId
          })
          .from(schema.agents)
          .leftJoin(schema.spaces, eq(schema.agents.spaceId, schema.spaces.id))
          .where(eq(schema.agents.id, agentId))
          .get();

        if (spaceRow && spaceRow.name) {
          spaceContext = `<space_context>\nSpace: ${spaceRow.name}`;
          if (spaceRow.description) spaceContext += `\nDescription: ${spaceRow.description}`;
          if (spaceRow.managerId) {
             const managerRow = this.deps.db.select({ name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, spaceRow.managerId)).get();
             if (managerRow) spaceContext += `\nManager: ${managerRow.name}`;
          }
          spaceContext += `\n</space_context>`;
        }
      } catch (err) {
        this.deps.logger.warn('engine.space_context.failed', { runId: ctx.runId, err: (err as Error).message });
      }
    }

    let specialistMindBlock = '';
    if (agentId && this.deps.specialistMind) {
      try {
        const roleRow = this.deps.db.select({ role: schema.agents.role }).from(schema.agents).where(eq(schema.agents.id, agentId)).get();
        if (roleRow?.role) specialistMindBlock = await this.deps.specialistMind.contextBlock(ctx.workspaceId, roleRow.role, prompt, 6);
      } catch (err) {
        this.deps.logger.warn('engine.specialist_mind.failed', { runId: ctx.runId, err: (err as Error).message });
      }
    }

    // W2 — the operating manual: brief the agent on its full agentic surface
    // (spawn/delegate/workflow-as-tool/replan) + the hard anti-hallucination rules,
    // layered by role. Leads the prompt so it frames everything below it.
    let operatingManualBlock = '';
    try {
      const role = agentId
        ? (this.deps.db.select({ role: schema.agents.role }).from(schema.agents).where(eq(schema.agents.id, agentId)).get()?.role ?? null)
        : null;
      const manual = composeOperatingManual({ role, workspaceManual: getWorkspaceManual(this.deps.db, ctx.workspaceId) });
      if (manual) operatingManualBlock = `<operating_manual>\n${manual}\n</operating_manual>`;
    } catch (err) {
      this.deps.logger.warn('engine.operating_manual.failed', { runId: ctx.runId, err: (err as Error).message });
    }
    // AGENT-PRIMARY M5 — the global tier: the live plan the agent may EVOLVE.
    // Carries the Intent Manifest goal + the typed contract summary (so the agent
    // reasons over the whole plan, not 70 node bodies) AND the runId + how to
    // extend it — which also gives an external harness the run handle it needs (M2).
    const evolutionBlock = this.#buildLivePlanBlock(ctx);
    // The live mounted-connections surface (MCP servers + credentialed integrations),
    // so a task agent reaches for what is actually connected instead of assuming none
    // exists. Best-effort — never block a dispatch on it.
    let connectionsBlock = '';
    try {
      if (this.deps.capabilityIndex) {
        const raw = await this.deps.capabilityIndex.mountedConnectionsBlock(ctx.workspaceId);
        if (raw) connectionsBlock = `<mounted_connections>\n${raw}\n</mounted_connections>`;
      }
    } catch (err) {
      this.deps.logger.warn('engine.mounted_connections.failed', { runId: ctx.runId, err: (err as Error).message });
    }
    // WORKER SELF-MODEL PARITY — a task agent also gets the CAPABILITY MANIFEST
    // (the ~constant-size "you know everything exists but hold none of it in
    // context — reach it via capability.search/load/invoke" digest) that the chat
    // orchestrator gets. Without it a delegated worker was half-blind to the apps,
    // workflows, extensions, and skills it could compose. Best-effort.
    let capabilityManifestBlock = '';
    try {
      if (this.deps.capabilityIndex) {
        const raw = this.deps.capabilityIndex.manifestBlock(ctx.workspaceId);
        if (raw) capabilityManifestBlock = `<capability_manifest>\n${raw}\n</capability_manifest>`;
      }
    } catch (err) {
      this.deps.logger.warn('engine.capability_manifest.failed', { runId: ctx.runId, err: (err as Error).message });
    }

    let workflowExperienceBlock = '';
    if (this.deps.workflowExperience && ctx.workflowId) {
      try {
        const workflow = this.deps.db.select({
          appId: schema.workflows.appId,
          activeRevisionId: schema.workflows.activeRevisionId,
          candidateRevisionId: schema.workflows.candidateRevisionId,
        }).from(schema.workflows).where(and(
          eq(schema.workflows.id, ctx.workflowId),
          eq(schema.workflows.workspaceId, ctx.workspaceId),
        )).get();
        const role = agentId
          ? this.deps.db.select({ role: schema.agents.role }).from(schema.agents).where(eq(schema.agents.id, agentId)).get()?.role
          : null;
        if (workflow) {
          workflowExperienceBlock = this.deps.workflowExperience.renderDossier({
            workspaceId: ctx.workspaceId,
            workflowId: ctx.workflowId,
            appId: workflow.appId,
            agentId: agentId ?? null,
            specialistRole: role ?? null,
            activeRevisionId: workflow.activeRevisionId,
            candidateRevisionId: workflow.candidateRevisionId,
          });
        }
      } catch (err) {
        this.deps.logger.warn('engine.workflow_experience.failed', { runId: ctx.runId, err: (err as Error).message });
      }
    }
    // A workflow-bound orchestrator/manager needs the same scoped command model
    // as chat: inventory, work in motion, failures, approvals, and recent deltas.
    let commandBriefingBlock = '';
    try {
      if (agentId && this.deps.commandModel) {
        const raw = this.deps.commandModel.briefingBlock(ctx.workspaceId, agentId);
        if (raw) commandBriefingBlock = `<command_briefing>\n${raw}\n</command_briefing>`;
      }
    } catch (err) {
      this.deps.logger.warn('engine.command_briefing.failed', { runId: ctx.runId, err: (err as Error).message });
    }
    return {
      prompt: [agentIdentityBlock, operatingManualBlock, evolutionBlock, workflowExperienceBlock, connectionsBlock, capabilityManifestBlock, commandBriefingBlock, rolePrompt, peerContext, block, brainBlock, specialistMindBlock, spaceContext, agentMemory, personalBrain, skillBlock, prompt].filter(Boolean).join('\n\n'),
    };
  }

  /**
   * AGENT-PRIMARY M5 — the "global tier" block: the live plan the agent can
   * evolve. Only injected when this run's authority is agent-primary (deterministic
   * runs omit it, so their agents are never told to reshape a frozen pipeline).
   */
  #buildLivePlanBlock(ctx: RunningContext): string {
    try {
      const wf = ctx.workflowId
        ? this.deps.db.select({ settings: schema.workflows.settings }).from(schema.workflows).where(eq(schema.workflows.id, ctx.workflowId)).get()
        : undefined;
      const settings = (wf?.settings ?? {}) as { intentManifest?: IntentManifest; evolutionAuthority?: unknown; executionMode?: unknown };
      const authority = resolveEvolutionAuthority(this.deps.db, ctx.workspaceId, settings);
      if (authority === 'operator') return '';
      const goal = settings.intentManifest?.goal;
      const lines = [
        `You are executing inside live run "${ctx.runId}". The workflow graph below is the plan you OWN and may EVOLVE.`,
        goal ? `Objective (intent): ${goal}` : '',
        `Current plan contract:`,
        summarizeContract(ctx.graph),
        `If a step is missing to reach the objective, EXTEND the plan: in-session call evolve_plan; over MCP call agentis.workflow.patch with { runId: "${ctx.runId}", patch: { addNodes, addEdges } }. The engine validates against the contracts and either commits or names exactly what to fix. Never gut a step or fabricate to avoid evolving.`,
      ].filter(Boolean);
      return `<live_plan>\n${lines.join('\n')}\n</live_plan>`;
    } catch (err) {
      this.deps.logger.warn('engine.live_plan_block.failed', { runId: ctx.runId, err: (err as Error).message });
      return '';
    }
  }

  /**
   * Translate terminal execution evidence into immutable revision proof.
   * Repaired production runs can only propose candidates; a fresh debug run
   * (self-heal disabled by construction) is what certifies the exact candidate.
   */
  async #recordRevisionOutcome(
    ctx: RunningContext,
    status: WorkflowRunStatus,
    verdict: RunVerdict | null,
  ): Promise<void> {
    if (!this.deps.revisions || !ctx.workflowId) return;
    const isDebug = this.#debugRuns.has(ctx.runId);
    const clean = status === 'COMPLETED'
      && ctx.state.failedNodeIds.length === 0
      && (!verdict || verdict.outcome === 'accomplished');
    const workflow = this.deps.db.select({
      appId: schema.workflows.appId,
      settings: schema.workflows.settings,
      activeRevisionId: schema.workflows.activeRevisionId,
      candidateRevisionId: schema.workflows.candidateRevisionId,
    }).from(schema.workflows).where(and(
      eq(schema.workflows.id, ctx.workflowId),
      eq(schema.workflows.workspaceId, ctx.workspaceId),
    )).get();
    if (!workflow) return;

    if (isDebug && ctx.workflowRevisionId) {
      this.deps.revisions.recordProof({
        workspaceId: ctx.workspaceId,
        workflowId: ctx.workflowId,
        revisionId: ctx.workflowRevisionId,
        gate: 'clean_debug',
        status: clean ? 'passed' : 'failed',
        runId: ctx.runId,
        evidence: { status, failedNodeIds: ctx.state.failedNodeIds, selfHealDisabled: true },
      });
      this.deps.revisions.recordProof({
        workspaceId: ctx.workspaceId,
        workflowId: ctx.workflowId,
        revisionId: ctx.workflowRevisionId,
        gate: 'outcome',
        status: verdict?.outcome === 'accomplished' ? 'passed' : 'failed',
        runId: ctx.runId,
        evidence: {
          verdict: verdict?.outcome ?? null,
          deficiencies: verdict?.deficiencies ?? [],
          reason: verdict ? undefined : 'No world/outcome specification was evaluated.',
        },
      });

      if (clean) {
        const repairAttempts = this.deps.db.select().from(schema.workflowRepairAttempts).where(and(
          eq(schema.workflowRepairAttempts.workspaceId, ctx.workspaceId),
          eq(schema.workflowRepairAttempts.workflowId, ctx.workflowId),
          eq(schema.workflowRepairAttempts.candidateRevisionId, ctx.workflowRevisionId),
        )).all();
        for (const attempt of repairAttempts) {
          const classification = classifyWorkflowFailure(attempt.lastError ?? 'workflow graph defect');
          this.deps.revisions.recordProof({
            workspaceId: ctx.workspaceId,
            workflowId: ctx.workflowId,
            revisionId: ctx.workflowRevisionId,
            gate: 'regression',
            status: 'passed',
            fixtureKey: attempt.failureFingerprint,
            runId: ctx.runId,
            evidence: {
              failureFingerprint: attempt.failureFingerprint,
              nodeId: attempt.nodeId,
              assertion: 'The original failure did not recur during the clean replay.',
            },
          });
          this.deps.workflowExperience?.completeRepairAttempt({
            workspaceId: ctx.workspaceId,
            workflowId: ctx.workflowId,
            baseRevisionId: attempt.baseRevisionId ?? workflow.activeRevisionId ?? ctx.workflowRevisionId,
            failureFingerprint: attempt.failureFingerprint,
            status: 'verified',
            candidateRevisionId: ctx.workflowRevisionId,
          });
          this.deps.workflowExperience?.recordVerifiedRepair({
            context: {
              workspaceId: ctx.workspaceId,
              workflowId: ctx.workflowId,
              appId: workflow.appId,
              activeRevisionId: workflow.activeRevisionId,
              candidateRevisionId: ctx.workflowRevisionId,
            },
            baseRevisionId: attempt.baseRevisionId ?? workflow.activeRevisionId ?? ctx.workflowRevisionId,
            candidateRevisionId: ctx.workflowRevisionId,
            fingerprint: attempt.failureFingerprint,
            classification,
            rootCause: classification.reason,
            repairSummary: `Run-local repair produced candidate ${ctx.workflowRevisionId}; clean replay ${ctx.runId} completed with self-healing disabled.`,
            proofRunId: ctx.runId,
            regressionFixture: {
              fingerprint: attempt.failureFingerprint,
              nodeId: attempt.nodeId,
              expected: 'no recurrence and accomplished outcome',
            },
          });
        }
      }

      const proof = this.deps.revisions.proofState(ctx.workspaceId, ctx.workflowId, ctx.workflowRevisionId);
      if (proof.readyForPromotion && !proof.approvalRequired && workflow.activeRevisionId && !workflow.appId) {
        this.deps.revisions.promote({
          workspaceId: ctx.workspaceId,
          workflowId: ctx.workflowId,
          revisionId: ctx.workflowRevisionId,
          expectedActiveRevisionId: workflow.activeRevisionId,
          actor: { type: 'system', id: 'verification-engine' },
        });
      }
    }

    // A production recovery is useful evidence but never proof of its own patch.
    // Only create the candidate after the repaired execution actually accomplishes
    // its objective, then require the clean replay above.
    const ranDifferentGraph = Boolean(
      ctx.repairedFromRevisionId
      && workflow.activeRevisionId
      && graphContentHash(ctx.graph)
        !== this.deps.revisions.revision(ctx.workspaceId, ctx.workflowId, workflow.activeRevisionId)?.semanticHash,
    );
    const structuralIncidents = Object.values(ctx.state.selfHealIncidents ?? {})
      .filter((incident) => incident.outcome === 'graph_patch_applied' && incident.failureFingerprint);
    if (!isDebug && ranDifferentGraph && verdict?.outcome !== 'accomplished' && workflow.activeRevisionId) {
      for (const incident of structuralIncidents) {
        const fingerprint = incident.failureFingerprint!;
        this.deps.workflowExperience?.completeRepairAttempt({
          workspaceId: ctx.workspaceId,
          workflowId: ctx.workflowId,
          baseRevisionId: workflow.activeRevisionId,
          failureFingerprint: fingerprint,
          status: 'rejected',
        });
        this.deps.workflowExperience?.recordRejectedRepair({
          context: {
            workspaceId: ctx.workspaceId,
            workflowId: ctx.workflowId,
            appId: workflow.appId,
            activeRevisionId: workflow.activeRevisionId,
            candidateRevisionId: workflow.candidateRevisionId,
          },
          revisionId: workflow.activeRevisionId,
          fingerprint,
          title: `Rejected run-local repair for ${incident.nodeTitle ?? incident.nodeId}`,
          repairSummary: incident.diagnosis ?? incident.reason ?? 'The repaired execution did not accomplish its objective.',
          evidence: { runId: ctx.runId, status, verdict: verdict?.outcome ?? null },
        });
      }
    }
    if (!isDebug && ranDifferentGraph && verdict?.outcome === 'accomplished' && workflow.activeRevisionId) {
      const created = this.deps.revisions.createCandidate({
        workspaceId: ctx.workspaceId,
        workflowId: ctx.workflowId,
        graph: ctx.graph,
        baseRevisionId: workflow.activeRevisionId,
        source: structuralIncidents.length > 0 ? 'self_heal' : 'agent_evolve',
        actor: { type: 'system', id: structuralIncidents.length > 0 ? 'self-heal' : 'evolution-engine' },
        reason: `Recovered run ${ctx.runId} accomplished its objective; clean replay is still required.`,
        allowBranch: true,
        setAsHead: !workflow.candidateRevisionId,
      });
      for (const incident of structuralIncidents) {
        const fingerprint = incident.failureFingerprint!;
        this.deps.workflowExperience?.completeRepairAttempt({
          workspaceId: ctx.workspaceId,
          workflowId: ctx.workflowId,
          baseRevisionId: workflow.activeRevisionId,
          failureFingerprint: fingerprint,
          status: 'candidate',
          candidateRevisionId: created.revision.id,
        });
      }
    }

    if (ctx.workflowRevisionId && verdict?.outcome === 'accomplished') {
      const revision = this.deps.revisions.revision(ctx.workspaceId, ctx.workflowId, ctx.workflowRevisionId);
      if (revision) {
        await this.deps.workflowExperience?.recordAccomplished({
          context: {
            workspaceId: ctx.workspaceId,
            workflowId: ctx.workflowId,
            appId: workflow.appId,
            activeRevisionId: workflow.activeRevisionId,
            candidateRevisionId: workflow.candidateRevisionId,
          },
          revisionId: revision.id,
          semanticHash: revision.semanticHash,
          graph: revision.graphJson as WorkflowGraph,
          runId: ctx.runId,
          objective: readWorkflowSpec(workflow.settings)?.objective ?? null,
        });
      }
    }
  }

  /**
   * Project a terminal run into the shape the App/workflow learning loop consumes:
   * what it was, how it ended, what it failed at, and how the verdict engine graded
   * it. Reads only run state the engine already holds — no extra queries on the
   * terminal path beyond the workflow title.
   */
  #runSettledInput(ctx: RunningContext, status: WorkflowRunStatus, verdict: RunVerdict | null): RunSettledInput {
    const failures: Array<{ nodeId: string; nodeTitle: string; error: string }> = [];
    for (const nodeId of ctx.state.failedNodeIds) {
      const nodeState = ctx.state.nodeStates[nodeId];
      if (!nodeState?.error) continue;
      failures.push({
        nodeId,
        nodeTitle: ctx.graph.nodes.find((n) => n.id === nodeId)?.title ?? nodeId,
        error: nodeState.error,
      });
    }
    let title = ctx.workflowId;
    try {
      title = this.deps.db
        .select({ title: schema.workflows.title })
        .from(schema.workflows)
        .where(eq(schema.workflows.id, ctx.workflowId))
        .get()?.title ?? ctx.workflowId;
    } catch { /* title is cosmetic — never fail a terminal transition for it */ }

    return {
      workspaceId: ctx.workspaceId,
      workflowId: ctx.workflowId,
      workflowTitle: title,
      runId: ctx.runId,
      status,
      verdict: verdict
        ? {
            outcome: verdict.outcome,
            deficiencies: verdict.deficiencies.map((d) => ({ claim: d.claim, detail: d.detail })),
          }
        : null,
      failures,
      agentId: this.#primaryRunAgentId(ctx),
    };
  }

  /** The agent that did the most work in this run — attribution for its lessons. */
  #primaryRunAgentId(ctx: RunningContext): string | null {
    for (const nodeId of [...ctx.state.completedNodeIds].reverse()) {
      const node = ctx.graph.nodes.find((n) => n.id === nodeId);
      const agentId = (node?.config as { agentId?: unknown } | undefined)?.agentId;
      if (typeof agentId === 'string' && agentId) return agentId;
    }
    return null;
  }

  #enqueueSuccessfulBrainCapture(
    ctx: RunningContext,
    nodeId: string,
    output: Record<string, unknown>,
    agentId: string | null,
    extraInput: Record<string, unknown> = {},
  ): void {
    const queue = this.deps.brainQueue;
    if (!queue) return;
    try {
      const baseNodeId = nodeId.includes('::') ? nodeId.split('::')[0] || nodeId : nodeId;
      const node = ctx.graph.nodes.find((candidate) => candidate.id === baseNodeId) ?? null;
      const inputData = ctx.state.nodeStates[baseNodeId]?.inputData ?? null;

      // Write-policy gate (§P1): decide what this run may write to the Brain
      // BEFORE any text is mined. Transient deliverables (digests, reports) are
      // gated to a single episodic marker and can never form pattern atoms.
      let agentRole: string | null = null;
      if (agentId) {
        try {
          agentRole = this.deps.db.select({ role: schema.agents.role }).from(schema.agents).where(eq(schema.agents.id, agentId)).get()?.role ?? null;
        } catch { /* role lookup is best-effort */ }
      }
      const nodeConfig = (node?.config ?? {}) as Record<string, unknown>;
      const { policy } = resolveMemoryPolicy({
        explicitPolicy: nodeConfig.memoryPolicy,
        surface: 'run_completion',
        nodeKind: node?.config.kind ?? null,
        nodeTitle: node?.title ?? nodeId,
        agentRole,
        output,
      });

      queue.enqueue({
        workspaceId: ctx.workspaceId,
        itemType: 'atom_promotion',
        priority: 'normal',
        payload: {
          workspaceId: ctx.workspaceId,
          workflowId: ctx.workflowId,
          runId: ctx.runId,
          nodeId,
          agentId,
          // App-owned runs form their lessons into the App's brain (portable with
          // the App); bare workflows keep forming into the agent's own scope.
          scopeId: this.#appScopeId(ctx.workspaceId, ctx.workflowId) ?? agentId,
          taskTitle: node?.title ?? nodeId,
          memoryPolicy: policy,
          originSurface: 'run_completion',
          taskInput: {
            nodeTitle: node?.title ?? nodeId,
            nodeKind: node?.config.kind ?? null,
            inputData,
            ...extraInput,
          },
          taskOutput: output,
        },
      });
    } catch (err) {
      this.deps.logger.warn('engine.brain_capture.enqueue_failed', { runId: ctx.runId, nodeId, err: (err as Error).message });
    }
  }

  #logContextFailure(ctx: RunningContext, err: unknown): void {
    this.deps.logger.warn('engine.workspace_context.failed', {
      runId: ctx.runId,
      workspaceId: ctx.workspaceId,
      err: (err as Error).message,
    });
  }

  // ────────────────────────────────────────────────────────────
  // Artifact collect node
  // ────────────────────────────────────────────────────────────

  async #executeArtifactCollect(
    ctx: RunningContext,
    node: WorkflowNode,
    config: ArtifactCollectNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Extract artifact references from upstream input.
    const raw = config.artifactPath ? lookupPath(inputData, config.artifactPath) : inputData;
    const refs: unknown[] = Array.isArray(raw) ? raw : raw ? [raw] : [];

    // Filter by accepted types when specified.
    const accepted = config.acceptTypes;
    const filtered = accepted
      ? refs.filter((r) => {
          const t = r && typeof r === 'object' ? (r as Record<string, unknown>).type : null;
          return typeof t === 'string' && accepted.includes(t as 'html' | 'image' | 'document' | 'code' | 'data');
        })
      : refs;

    // Persist each artifact to the workspace artifact store.
    const collectedIds: string[] = [];
    const now = new Date().toISOString();
    for (const ref of filtered) {
      const rec = ref && typeof ref === 'object' ? (ref as Record<string, unknown>) : {};
      const type = typeof rec.type === 'string' ? rec.type : 'document';
      const title = typeof rec.title === 'string' ? rec.title : config.collectionName;
      const content = typeof rec.content === 'string' ? rec.content : typeof rec.url === 'string' ? rec.url : '';
      const id = randomUUID();
      try {
        this.deps.db
          .insert(schema.artifacts)
          .values({
            id,
            workspaceId: ctx.workspaceId,
            userId: ctx.userId,
            type: type as 'html' | 'image' | 'document' | 'code' | 'data',
            title: `${config.collectionName}: ${title}`.slice(0, 200),
            content,
            thumbnailUrl: typeof rec.thumbnailUrl === 'string' ? rec.thumbnailUrl : null,
            runId: ctx.runId,
            workflowId: ctx.state.workflowId,
            agentId: null,
            appId: this.#appScopeId(ctx.workspaceId, ctx.state.workflowId),
            origin: 'workflow',
            conversationId: null,
            nodeId: node.id,
            metadata: {
              collectionName: config.collectionName,
              versioned: config.versioned !== false,
              requireApproval: config.requireApproval ?? false,
              ...(rec.metadata && typeof rec.metadata === 'object' ? rec.metadata : {}),
            },
            createdAt: now,
            updatedAt: now,
          })
          .run();
        collectedIds.push(id);
      } catch (err) {
        this.deps.logger.warn('artifact_collect.insert_failed', {
          runId: ctx.runId, nodeId: node.id,
          message: (err as Error).message,
        });
      }
    }

    this.deps.logger.info('artifact_collect.done', {
      runId: ctx.runId,
      nodeId: node.id,
      collectionName: config.collectionName,
      collected: collectedIds.length,
      total: refs.length,
    });

    return {
      collectionName: config.collectionName,
      artifactIds: collectedIds,
      count: collectedIds.length,
      requireApproval: config.requireApproval ?? false,
    };
  }

  // ────────────────────────────────────────────────────────────
  // Agent swarm node (AGENTIS-PLATFORM-10X §A8)
  // ────────────────────────────────────────────────────────────

  async #dispatchAgentSwarm(
    ctx: RunningContext,
    node: WorkflowNode,
    config: AgentSwarmNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<void> {
    const arrRaw = lookupPath(inputData, config.inputArrayPath);
    const items = Array.isArray(arrRaw) ? arrRaw : [];
    if (items.length === 0) {
      await this.#completeNode(ctx, node.id, { [config.outputKey]: [], count: 0 });
      return;
    }
    const agentId = config.agentId
      ?? this.#resolveConnectedFallbackAgent(ctx.workspaceId, config.capabilityTags, config.requires);
    if (config.agentId) this.#assertAgentSatisfiesRequirements(config.agentId, config.requires, `agent_swarm node ${node.id}`);
    if (!agentId) {
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        `agent_swarm node ${node.id}: no agent bound and none match capability tags`,
      );
    }
    // Honor the runtime's declared concurrency: a swarm must never spawn more
    // parallel processes than the adapter says it can handle (e.g. CLI harnesses
    // that declare maxConcurrent:1). Otherwise 64 child processes hit a runtime
    // built for one — exhausting RAM/PIDs on the host.
    const adapterMaxConcurrent = this.deps.adapters.capabilities(agentId)?.execution?.maxConcurrent;
    const ceiling = adapterMaxConcurrent && adapterMaxConcurrent > 0 ? Math.min(64, adapterMaxConcurrent) : 64;
    const maxParallel = Math.min(Math.max(config.maxParallel || 1, 1), ceiling);
    const swarm: SwarmState = {
      nodeId: node.id,
      total: items.length,
      next: 0,
      items,
      agentId,
      config,
      results: new Map(),
      failures: new Map(),
      settled: false,
      worktrees: new Map(),
      inFlight: new Set(),
    };
    ctx.swarms.set(node.id, swarm);
    // Hold the node open with a synthetic active execution.
    ctx.state.activeExecutions[node.id] = {
      taskId: `swarm:${node.id}`,
      nodeId: node.id,
      executorType: 'agent',
      executorRef: agentId,
      startedAt: new Date().toISOString(),
    };
    // Persist the dispatch transition so observers see the swarm in flight.
    await this.#persistRun(ctx).catch(() => {});
    const initial = Math.min(maxParallel, items.length);
    for (let i = 0; i < initial; i++) {
      void this.#dispatchSwarmSubtask(ctx, node, swarm, swarm.next++);
    }
  }

  #resolveConnectedFallbackAgent(
    workspaceId: string,
    capabilityTags: string[],
    requires?: AgentRequirements,
    preferredRole?: AgentRole,
  ): string | null {
    try {
      // Prefer a real WORKER specialist. The orchestrator stays only as the
      // last-resort RUNTIME a node can borrow when it is the sole connected, capable
      // brain (single-runtime workspaces) — its IDENTITY is never AUTHORED onto a
      // task node (materializeCast guarantees that at build time).
      const candidates = this.deps.adapters
        .list()
        .filter((registration) => this.#agentSatisfiesRequirements(registration.agentId, requires));
      const registered = new Set(candidates.map((r) => r.agentId));
      if (registered.size === 0) return null;
      if (preferredRole) {
        const matchingRole = this.deps.db
          .select({ id: schema.agents.id })
          .from(schema.agents)
          .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.role, preferredRole)))
          .all()
          .find((agent) => registered.has(agent.id));
        if (matchingRole) return matchingRole.id;
      }
      if (capabilityTags.length > 0) {
        const agents = this.deps.db
          .select({ id: schema.agents.id, capabilityTags: schema.agents.capabilityTags })
          .from(schema.agents)
          .where(eq(schema.agents.workspaceId, workspaceId))
          .all();
        for (const a of agents) {
          if (!registered.has(a.id)) continue;
          const tags = Array.isArray(a.capabilityTags) ? (a.capabilityTags as string[]) : [];
          if (tags.some((t) => capabilityTags.includes(t))) return a.id;
        }
      }
      const orchestrator = this.deps.db
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.role, 'orchestrator')))
        .get();
      if (orchestrator && registered.has(orchestrator.id)) return orchestrator.id;
      return candidates[0]?.agentId ?? null;
    } catch {
      return null;
    }
  }

  async #dispatchSwarmSubtask(
    ctx: RunningContext,
    node: WorkflowNode,
    swarm: SwarmState,
    index: number,
  ): Promise<void> {
    const item = swarm.items[index];
    const taskId = `${node.id}::swarm::${index}`;
    swarm.inFlight.add(index);
    try {
      const contextResult = await this.#withWorkspaceContext(ctx, swarm.config.prompt, undefined, '', swarm.agentId);
      // Per-task isolation: each parallel subtask gets its own working directory
      // so concurrent agents never share one checkout and clobber each other.
      // Best-effort — a failed/absent allocation degrades to the adapter's cwd.
      const workdir = await this.#acquireSwarmWorktree(swarm, index, taskId);
      await this.deps.adapters.dispatchTask(
        {
          taskId,
          runId: ctx.runId,
          workflowId: ctx.workflowId,
          nodeId: taskId,
          title: `${node.title} [${index + 1}/${swarm.total}]`,
          description: contextResult.prompt,
          inputData: { item, index, prompt: swarm.config.prompt },
          scratchpadSnapshot: this.deps.scratchpad.snapshotOf(ctx.runId),
          capabilityTags: swarm.config.capabilityTags,
          runtimeRequirements: runtimeRequirementsFromAgentRequirements(
            swarm.config.requires,
            `Swarm node ${node.id} (${node.title})`,
          ),
          timeoutMs: CONSTANTS.AGENT_TASK_RESPONSE_TIMEOUT_MS,
          // Run-scoped cancellation so Stop aborts in-flight swarm subtasks
          // instead of letting them run (and bill) to completion.
          signal: ctx.abortController?.signal,
          workdir,
        },
        swarm.agentId,
      );
    } catch (err) {
      void this.#onSwarmSubtask(ctx, node.id, index, null, (err as Error).message);
    }
  }

  /**
   * Allocate an isolated working directory for one swarm subtask. Stores the
   * handle on the swarm so it can be released when the subtask settles. Returns
   * the path, or undefined when isolation is unavailable (no WorktreeManager
   * wired, gateway adapter with no local cwd, or allocation failed) — in which
   * case the adapter falls back to its configured cwd.
   */
  async #acquireSwarmWorktree(swarm: SwarmState, index: number, taskId: string): Promise<string | undefined> {
    if (!this.deps.worktrees) return undefined;
    try {
      const handle = await this.deps.worktrees.acquire({
        baseCwd: this.deps.adapters.workdirOf(swarm.agentId),
        taskId,
      });
      if (!handle.path) return undefined;
      swarm.worktrees.set(index, handle);
      return handle.path;
    } catch (err) {
      this.deps.logger.warn('swarm.worktree_acquire_failed', { taskId, err: (err as Error).message });
      return undefined;
    }
  }

  /** Release one subtask's isolated directory (idempotent, best-effort). */
  async #releaseSwarmWorktree(swarm: SwarmState, index: number): Promise<void> {
    const handle = swarm.worktrees.get(index);
    if (!handle) return;
    swarm.worktrees.delete(index);
    try { await handle.release(); } catch { /* best-effort */ }
  }

  /** Release every remaining isolated directory for a settled swarm. */
  async #releaseAllSwarmWorktrees(swarm: SwarmState): Promise<void> {
    const handles = [...swarm.worktrees.values()];
    swarm.worktrees.clear();
    await Promise.all(handles.map((h) => h.release().catch(() => {})));
  }

  /**
   * When a swarm settles early (first_success), abandon the still-running
   * siblings: cancel each in-flight subtask so it stops consuming the runtime and
   * billing, THEN reclaim every isolated directory. Cancelling before releasing
   * avoids yanking a worktree out from under a live process.
   */
  async #abandonInFlightSwarmSiblings(nodeId: string, swarm: SwarmState): Promise<void> {
    const inFlight = [...swarm.inFlight];
    swarm.inFlight.clear();
    await Promise.all(
      inFlight.map((idx) =>
        this.deps.adapters.cancelTask(swarm.agentId, `${nodeId}::swarm::${idx}`).catch(() => {}),
      ),
    );
    await this.#releaseAllSwarmWorktrees(swarm);
  }

  async #onSwarmSubtask(
    ctx: RunningContext,
    nodeId: string,
    index: number,
    output: Record<string, unknown> | null,
    error: string | null,
  ): Promise<void> {
    const swarm = ctx.swarms.get(nodeId);
    if (!swarm || swarm.settled) return;
    // The subtask reported terminal — it is no longer in flight, and its isolated
    // dir can be reclaimed.
    swarm.inFlight.delete(index);
    await this.#releaseSwarmWorktree(swarm, index);
    if (error) {
      swarm.failures.set(index, error);
    } else {
      const capturedOutput = output ?? {};
      swarm.results.set(index, capturedOutput);
      this.#enqueueSuccessfulBrainCapture(ctx, `${nodeId}::swarm::${index}`, capturedOutput, swarm.agentId, {
        swarmNodeId: nodeId,
        item: swarm.items[index] ?? null,
      });
    }

    const node = ctx.graph.nodes.find((n) => n.id === nodeId);

    // first_success: settle as soon as one subtask succeeds.
    if (swarm.config.mergeStrategy === 'first_success' && !error && node) {
      swarm.settled = true;
      ctx.swarms.delete(nodeId);
      delete ctx.state.activeExecutions[nodeId];
      // One subtask won — cancel the in-flight siblings (stop wasted work + cost)
      // and reclaim their isolated dirs instead of orphaning them.
      await this.#abandonInFlightSwarmSiblings(nodeId, swarm);
      await this.#completeNode(ctx, nodeId, {
        [swarm.config.outputKey]: [output ?? {}],
        count: 1,
        strategy: 'first_success',
      });
      void this.#tick(ctx);
      return;
    }

    // Dispatch the next queued item to keep the pool saturated.
    if (swarm.next < swarm.total && node) {
      void this.#dispatchSwarmSubtask(ctx, node, swarm, swarm.next++);
    }

    const done = swarm.results.size + swarm.failures.size;
    if (done < swarm.total || !node) return;

    swarm.settled = true;
    ctx.swarms.delete(nodeId);
    delete ctx.state.activeExecutions[nodeId];
    await this.#releaseAllSwarmWorktrees(swarm);

    if (swarm.results.size === 0) {
      await this.#failNode(
        ctx,
        nodeId,
        `agent_swarm: all ${swarm.total} subtasks failed`,
      );
      void this.#tick(ctx);
      return;
    }
    const merged = this.#mergeSwarm(swarm);
    await this.#completeNode(ctx, nodeId, merged);
    void this.#tick(ctx);
  }

  #mergeSwarm(swarm: SwarmState): Record<string, unknown> {
    const ordered = [...swarm.results.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v);
    if (swarm.config.mergeStrategy === 'majority_vote') {
      const tally = new Map<string, number>();
      for (const r of ordered) {
        const key = JSON.stringify(r);
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
      let bestKey = '';
      let bestN = -1;
      for (const [k, n] of tally) {
        if (n > bestN) {
          bestN = n;
          bestKey = k;
        }
      }
      return {
        [swarm.config.outputKey]: bestKey ? JSON.parse(bestKey) : null,
        votes: bestN,
        count: ordered.length,
        strategy: 'majority_vote',
      };
    }
    return {
      [swarm.config.outputKey]: ordered,
      count: ordered.length,
      failures: swarm.failures.size,
      strategy: 'collect_all',
    };
  }

  async #executeScratchpadNode(
    ctx: RunningContext,
    config: ScratchpadNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (config.operation) {
      case 'read': {
        const value = this.deps.scratchpad.read(ctx.runId, config.key);
        return { [config.key]: value ?? null };
      }
      case 'write': {
        const value =
          config.valuePath !== undefined ? lookupPath(inputData, config.valuePath) : inputData;
        this.deps.scratchpad.write(ctx.runId, config.key, value);
        return { [config.key]: value };
      }
      case 'append': {
        const existing = this.deps.scratchpad.read(ctx.runId, config.key);
        const arr = Array.isArray(existing) ? [...existing] : [];
        const value =
          config.valuePath !== undefined ? lookupPath(inputData, config.valuePath) : inputData;
        arr.push(value);
        this.deps.scratchpad.write(ctx.runId, config.key, arr);
        return { [config.key]: arr };
      }
      case 'delete': {
        this.deps.scratchpad.delete(ctx.runId, config.key);
        return { [config.key]: null };
      }
    }
  }

  /**
   * Phase 2 rung 0 — deterministic, zero-token repair of a pure node that threw
   * on an off-contract expression reference. Fixes a near-miss typo in-place
   * (`noeds`→`nodes`) and retries the handler once; if nothing can be confidently
   * repaired (or the retry still fails) the error propagates into the normal
   * failure / LLM self-heal path. This is the cheapest rung of the recovery
   * ladder: most expression failures are typos, and a typo should never cost a
   * model call.
   */
  #repairAndRetryPureNode(
    ctx: RunningContext,
    node: WorkflowNode,
    item: ReadyQueueItem,
    tctx: TemplateContext,
    handler: PureNodeHandler,
    err: Error,
  ): Record<string, unknown> {
    const cfg = node.config as { kind?: string; expression?: string; condition?: string };
    const field = cfg.kind === 'transform' ? 'expression' : cfg.kind === 'filter' ? 'condition' : null;
    const original = field ? cfg[field] : undefined;
    if (!field || typeof original !== 'string') throw err;
    const repair = repairExpressionReferences(original);
    if (!repair.changed) throw err;
    (node.config as unknown as Record<string, unknown>)[field] = repair.expression;
    const summary = repair.rewrites.map((r) => `${r.from} → ${r.to}`).join(', ');
    this.#emitWorkStep(ctx, node, 'thinking', `Deterministic repair: corrected expression reference ${summary} (0 tokens)`);
    this.#audit(ctx, { nodeId: node.id, action: 'self_heal.expression_repaired', actorType: 'system', actorId: 'engine', outputSummary: summary });
    this.deps.logger.info('engine.self_heal.expression_repaired', { runId: ctx.runId, nodeId: node.id, rewrites: repair.rewrites });
    return handler.execute(node.config, { inputData: item.inputData, tctx });
  }



  // ────────────────────────────────────────────────────────────
  // New deterministic primitives — wait / transform / filter
  // ────────────────────────────────────────────────────────────

  async #executeWait(
    ctx: RunningContext,
    node: WorkflowNode,
    config: WaitNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<void> {
    // Absolute wake time wins over a relative delay when set: "wait until <ISO>".
    let delayMs: number;
    if (config.untilIso) {
      const untilMs = Date.parse(config.untilIso);
      if (Number.isNaN(untilMs)) {
        throw new AgentisError('VALIDATION_FAILED', `wait node: untilIso '${config.untilIso}' is not a valid ISO 8601 timestamp`);
      }
      delayMs = Math.max(0, untilMs - Date.now());
    } else {
      delayMs = Math.max(0, Math.floor(config.delayMs ?? 0));
    }
    if (delayMs <= 0) {
      await this.#completeNode(ctx, node.id, inputData);
      return;
    }
    // Persist the wake-at on the active execution so a crash mid-wait isn't
    // a silent run loss — the WaitRecovery boot scan can pick it up. The
    // synthetic execution keeps the settle loop from marking the run COMPLETED
    // while the timer is pending.
    const wakeAt = new Date(Date.now() + delayMs).toISOString();
    ctx.state.activeExecutions[node.id] = {
      taskId: `wait:${node.id}`,
      nodeId: node.id,
      executorType: 'wait',
      executorRef: `timer:${delayMs}ms`,
      startedAt: new Date().toISOString(),
      ...({ wakeAt, inputData } as Record<string, unknown>),
    };
    // Persist the run-state mid-wait so a restart can recover this exact
    // wait state. Without this the runState row reflects the pre-wait
    // moment and the recovery pass can't see the pending timer.
    await this.#persistRun(ctx);
    const timer = setTimeout(() => {
      delete ctx.state.activeExecutions[node.id];
      void (async () => {
        await this.#completeNode(ctx, node.id, inputData);
        void this.#tick(ctx);
      })();
    }, delayMs);
    // Don't keep the process alive solely for a long wait.
    timer.unref?.();
  }

  // transform + filter logic now lives in engine/handlers/pureHandlers.ts and
  // is dispatched via #nodeHandlers (NATIVE-ADVANCEMENT Proposal 4).

  // ────────────────────────────────────────────────────────────
  // Output surface — return_output / artifact_save (Layer 6)
  // ────────────────────────────────────────────────────────────

  /**
   * Terminal output node. Selects the value to render and tags it with the
   * `renderAs` viewer hint. The Output API surfaces `renderAs`/`value` to the
   * web Output Surface, which dispatches to the matching viewer (iframe for
   * html, table for rows, etc.).
   */
  #executeReturnOutput(
    config: ReturnOutputNodeConfig,
    inputData: Record<string, unknown>,
    tctx: TemplateContext,
  ): Record<string, unknown> {
    const renderAs = config.renderAs ?? 'json';
    const value = config.valuePath
      ? readTemplatePath(tctx, config.valuePath) ?? readDotPath(inputData, config.valuePath)
      : inputData;
    return {
      renderAs,
      ...(config.title ? { title: config.title } : {}),
      value: value ?? null,
    };
  }

  /**
   * Persist a value as a workspace artifact (immutable run receipt). V1 stores
   * content inline in the `artifacts` table — the same store used by
   * `artifact_collect`. Returns an artifact ref so downstream nodes and the
   * Output gallery can reference it.
   */
  async #executeArtifactSave(
    ctx: RunningContext,
    node: WorkflowNode,
    config: ArtifactSaveNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const name = (config.name ?? 'artifact').trim() || 'artifact';
    const rawContent = config.contentPath ? readDotPath(inputData, config.contentPath) : inputData;
    const content = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent ?? null, null, 2);
    const title = config.titlePath ? String(readDotPath(inputData, config.titlePath) ?? name) : name;
    const type = config.artifactType ?? inferArtifactType(name, content);
    const artifact = this.#persistArtifact(ctx, node, { name, title, type, content, savedBy: 'artifact_save' });
    return { artifact, artifactId: artifact.id };
  }

  /**
   * Insert an artifact row (immutable run receipt). Shared by `artifact_save`
   * and the `browser` node. Content is stored inline (V1); binary payloads
   * (screenshots/PDFs) are persisted as `data:` URLs so the Output gallery can
   * preview + download them without a separate blob endpoint.
   */
  #persistArtifact(
    ctx: RunningContext,
    node: WorkflowNode,
    args: { name: string; title?: string; type: 'html' | 'image' | 'document' | 'code' | 'data'; content: string; savedBy: string },
  ): { id: string; name: string; title: string; type: string; contentType: string; size: number } {
    const id = randomUUID();
    const now = new Date().toISOString();
    const title = (args.title ?? args.name).slice(0, 200);
    // testNode() uses a synthetic `test-…` runId with no workflow_runs row —
    // null the FK so dry-running an artifact_save/browser node from the canvas
    // Test tab doesn't trip the run_id foreign key.
    const runId = ctx.runId.startsWith('test-') ? null : ctx.runId;
    try {
      this.deps.db
        .insert(schema.artifacts)
        .values({
          id,
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          type: args.type,
          title,
          content: args.content,
          thumbnailUrl: null,
          runId,
          workflowId: ctx.workflowId,
          agentId: null,
          appId: this.#appScopeId(ctx.workspaceId, ctx.workflowId),
          origin: 'workflow',
          conversationId: null,
          nodeId: node.id,
          metadata: { name: args.name, savedBy: args.savedBy },
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } catch (err) {
      this.deps.logger.warn('artifact.persist_failed', {
        runId: ctx.runId, nodeId: node.id, message: (err as Error).message,
      });
      throw new AgentisError('INTERNAL_ERROR', `artifact persist failed: ${(err as Error).message}`);
    }
    return { id, name: args.name, title, type: args.type, contentType: contentTypeFor(args.name, args.type), size: args.content.length };
  }


  // ────────────────────────────────────────────────────────────
  // Integration / HTTP
  // ────────────────────────────────────────────────────────────



  /**
   * Run a connector operation standalone — the agent-facing analog of an
   * `integration` node, backing `agentis.integration.call`. Resolves the
   * workspace-bound (or explicit) credential from the vault exactly as node
   * execution does, so an agent inside a task can deploy to Vercel, write to
   * Supabase, etc. WITHOUT first adding a node to the graph. Secrets stay in the
   * vault; the agent never sees them.
   */
  async runIntegrationOperation(
    workspaceId: string,
    integrationId: string,
    operationId: string,
    params: Record<string, unknown>,
    opts?: { credentialId?: string },
  ): Promise<Record<string, unknown>> {
    if (!integrationId?.trim()) throw new AgentisError('VALIDATION_FAILED', 'integrationId is required');
    if (!operationId?.trim()) throw new AgentisError('VALIDATION_FAILED', 'operationId is required');
    const credential = this.#executors.resolveIntegrationCredential(workspaceId, {
      integrationId,
      operationId,
      ...(opts?.credentialId ? { credentialId: opts.credentialId } : {}),
    } as IntegrationNodeConfig);
    return this.#executors.invokeConnector(workspaceId, integrationId, {
      operation: operationId,
      params: params ?? {},
      credential,
      inputData: {},
    });
  }

  /**
   * Is a workspace-bound credential present for `integrationId`? Backs
   * `agentis.integration.list`, which must report what the agent can call RIGHT
   * NOW rather than what the static catalog merely supports. Shares the vault
   * lookup with {@link runIntegrationOperation}, so list and call agree.
   * Existence only — no secret is decrypted or returned.
   */
  hasIntegrationCredential(workspaceId: string, integrationId: string): boolean {
    if (!integrationId?.trim()) return false;
    return this.#executors.hasIntegrationCredential(workspaceId, integrationId);
  }











  // ─────────────────────────────────────────────────────────────────────────
  // Utility & data primitives — code / spreadsheet / graphql (WORKFLOW-UPDATE)
  // ─────────────────────────────────────────────────────────────────────────





  // ────────────────────────────────────────────────────────────
  // Workflow-scoped persistent KV
  // ────────────────────────────────────────────────────────────



  // ────────────────────────────────────────────────────────────
  // Evaluator / Guardrails
  // ────────────────────────────────────────────────────────────

  async #executeEvaluator(
    ctx: RunningContext,
    node: WorkflowNode,
    config: EvaluatorNodeConfig,
    inputData: Record<string, unknown>,
    tctx: TemplateContext,
  ): Promise<Record<string, unknown>> {
    if (!config.targetPath) {
      throw new AgentisError('VALIDATION_FAILED', 'evaluator node missing targetPath');
    }
    const resolved = this.#resolveEvaluationRuntime(ctx, node, config.targetPath);
    const evaluator = resolved?.runtime;
    if (!evaluator) {
      // RELIABILITY: a missing evaluation runtime is an infra gap, not a quality
      // failure. Don't kill the run — DEGRADE to a visible pass so downstream work
      // proceeds, and surface the gap via audit + critique.
      this.deps.logger.warn('engine.evaluator.no_runtime_degrade', { runId: ctx.runId, nodeId: node.id });
      this.#audit(ctx, { nodeId: node.id, action: 'evaluator.degraded', actorType: 'system', actorId: 'engine', outputSummary: 'no evaluation runtime — passed by default' });
      const prevIteration = Number(inputData['__evalIteration'] ?? 0);
      return {
        score: config.passThreshold ?? 7,
        passed: true,
        critique: 'Evaluator skipped: no evaluation model or chat-capable agent is available. Passed by default so the run can continue — connect an evaluation model to enforce this gate.',
        dimensionScores: [],
        iterationCount: prevIteration + 1,
        maxRetriesReached: true,
      };
    }
    // Read the raw value (typed, not stringified) from the input or run context.
    let target = readTemplatePath({ ...tctx, trigger: inputData, nodes: { ...tctx.nodes, input: inputData } }, config.targetPath)
      ?? readDotPath(inputData, config.targetPath);
    if (target === undefined) {
      // RELIABILITY: a targetPath that doesn't resolve (e.g. a hyphenated
      // `{{nodes.x-y}}` ref, or the upstream output shaped differently than the
      // planner assumed) must NOT abort the run. Degrade to evaluating the node's
      // whole input rather than throwing `did not resolve`.
      this.deps.logger.warn('engine.evaluator.targetpath_degrade', { runId: ctx.runId, nodeId: node.id, targetPath: config.targetPath });
      target = inputData;
    }
    ctx.state.activeExecutions[node.id] = {
      taskId: `evaluator:${node.id}`,
      nodeId: node.id,
      executorType: 'evaluator',
      executorRef: 'llm_judge',
      startedAt: new Date().toISOString(),
    };
    // Persist the dispatch transition so observers see the judge in flight.
    await this.#persistRun(ctx).catch(() => {});
    try {
      // Track FAIL→retry cycles via a tagged inputData field — the evaluator-retry
      // pattern routes back to the upstream agent_task, which receives a bumped
      // iterationCount on each cycle.
      const prevIteration = Number(inputData['__evalIteration'] ?? 0);
      const verdict = await evaluator.evaluate({
        workspaceId: ctx.workspaceId,
        target,
        criteria: config.criteria,
        rubric: config.rubric,
        passThreshold: config.passThreshold,
      });
      // Meter the judge's model spend onto this node (so it counts in run/agent
      // totals) and attribute it to the agent whose model ran the evaluation.
      this.#recordEvaluationTokens(ctx, node.id, evaluator.lastUsage, resolved?.agentId ?? null);
      try {
        this.deps.sharedIntelligence?.applyEvaluatorVerdict({
          workspaceId: ctx.workspaceId,
          runId: ctx.runId,
          scopeId: null,
          agentId: null,
          verdict: verdict.passed ? 'pass' : 'fail',
          evaluatorConfidence: verdict.score,
          responseText: typeof target === 'string' ? target : JSON.stringify(target),
        });
      } catch (err) {
        this.deps.logger.warn('engine.evaluator_brain_feedback.failed', { runId: ctx.runId, err: (err as Error).message });
      }
      return {
        score: verdict.score,
        passed: verdict.passed,
        critique: verdict.critique,
        dimensionScores: verdict.dimensionScores,
        iterationCount: prevIteration + 1,
        maxRetriesReached: prevIteration + 1 >= (config.maxRetries ?? 3),
      };
    } finally {
      delete ctx.state.activeExecutions[node.id];
    }
  }

  /**
   * Resolve evaluation in agentic-default order:
   * dedicated workspace/runtime model -> evaluated node's agent -> nearest
   * upstream agent -> workspace orchestrator -> any chat-capable workspace agent.
   */
  #resolveEvaluationRuntime(
    ctx: RunningContext,
    node: WorkflowNode,
    targetPath?: string,
  ): { runtime: EvaluationRuntime; agentId: string | null } | undefined {
    const config = node.config.kind === 'evaluator' ? node.config : null;
    const evaluationTask = config
      ? `${config.criteria}${config.rubric ? `\n${config.rubric}` : ''}`
      : node.title;
    const dedicated =
      this.deps.resolveEvaluatorRuntime?.(ctx.workspaceId, 'evaluation', { task: evaluationTask, purpose: 'workflow_evaluation' })
      ?? this.deps.evaluatorRuntime;
    // The dedicated evaluator is a system model (no owning agent) — its spend is
    // metered but attributed to the evaluation role, not a workspace agent.
    if (dedicated) return { runtime: dedicated, agentId: null };
    if (this.deps.modelAssistedRuntimeEnabled?.(ctx.workspaceId) === false) return undefined;

    const preferred = this.#evaluationAgentCandidates(ctx, node, targetPath);
    const workspaceAgents = this.deps.db
      .select({ id: schema.agents.id, role: schema.agents.role })
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, ctx.workspaceId))
      .all();
    const workspaceIds = new Set(workspaceAgents.map((agent) => agent.id));
    const orchestratorId = workspaceAgents.find((agent) => agent.role === 'orchestrator')?.id;
    if (orchestratorId) preferred.push({ agentId: orchestratorId });
    for (const registration of this.deps.adapters.list()) {
      if (workspaceIds.has(registration.agentId)) {
        preferred.push({ agentId: registration.agentId });
      }
    }

    const unique = new Map<string, { agentId: string; preferredModel?: string }>();
    for (const candidate of preferred) {
      if (!unique.has(candidate.agentId)) unique.set(candidate.agentId, candidate);
    }
    for (const { agentId, preferredModel } of unique.values()) {
      const registered = this.deps.adapters.get(agentId)?.adapter;
      const adapter = registered ?? this.deps.resolveAgentRuntime?.(ctx.workspaceId, agentId, evaluationTask, preferredModel);
      if (!adapter?.chat || adapter.capabilities?.().interactiveChat === false) continue;
      this.deps.logger.info('engine.evaluator.agent_runtime', {
        nodeId: node.id,
        agentId,
        adapterType: adapter.adapterType,
      });
      return {
        runtime: new StructuredEvaluatorRuntime(
          new AdapterStructuredCompleter(adapter, `agent:${agentId}`, preferredModel),
          this.deps.logger,
        ),
        // The evaluation ran on THIS agent's model — attribute its spend here.
        agentId,
      };
    }
    return undefined;
  }

  #evaluationAgentCandidates(
    ctx: RunningContext,
    evaluatorNode: WorkflowNode,
    targetPath?: string,
  ): Array<{ agentId: string; preferredModel?: string }> {
    const candidates: Array<{ agentId: string; preferredModel?: string }> = [];
    const visited = new Set<string>();
    const queue: string[] = [];
    const targetNodeId = targetPath ? nodeIdFromTargetPath(ctx.graph, targetPath) : null;
    if (targetNodeId) queue.push(targetNodeId);
    queue.push(...ctx.graph.edges.filter((edge) => edge.target === evaluatorNode.id).map((edge) => edge.source));

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      const sourceNode = ctx.graph.nodes.find((candidate) => candidate.id === nodeId);
      const binding = evaluationAgentBindingFromNode(sourceNode);
      if (binding) candidates.push(binding);
      queue.push(...ctx.graph.edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source));
    }
    return candidates;
  }


  // ────────────────────────────────────────────────────────────
  // Loop
  // ────────────────────────────────────────────────────────────

  async #dispatchLoop(
    ctx: RunningContext,
    node: WorkflowNode,
    config: LoopNodeConfig,
    inputData: Record<string, unknown>,
    tctx: TemplateContext,
  ): Promise<void> {
    return this.#convergeLoop.dispatchLoop(ctx, node, config, inputData, tctx);
  }

  async #dispatchConverge(
    ctx: RunningContext,
    node: WorkflowNode,
    config: ConvergeNodeConfig,
    inputData: Record<string, unknown>,
    tctx: TemplateContext,
  ): Promise<void> {
    return this.#convergeLoop.dispatchConverge(ctx, node, config, inputData, tctx);
  }
  async #executeCheckpoint(
    ctx: RunningContext,
    node: WorkflowNode,
    config: CheckpointNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<void> {
    // `task_id` has an FK to `tasks` — we can't stash the node id there, so the
    // resume target is tracked in-memory keyed by the approval id.
    const approvalCopy = checkpointApprovalCopy(ctx, node, inputData);
    const approval = await this.deps.approvals.create({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      userId: ctx.userId,
      runId: ctx.runId,
      taskId: null,
      targetId: node.id,
      gatewayId: null,
      source: 'checkpoint',
      title: approvalCopy.title,
      summary: approvalCopy.summary,
      confidence: null,
      payload: approvalCopy.payload,
    });
    this.#pendingApprovals(ctx).set(approval.id, { kind: 'checkpoint', targetId: node.id });
    // Mark node WAITING; an explicit operator approval will resume the run
    // through ApprovalInboxService.resolve() → engine.notifyTaskCompleted().
    const ns = ctx.state.nodeStates[node.id]!;
    ns.status = 'WAITING';
    await this.#persistRun(ctx);
    this.deps.bus.publish(
      REALTIME_ROOMS.run(ctx.runId),
      REALTIME_EVENTS.NODE_WAITING_FOR_INPUT,
      { runId: ctx.runId, nodeId: node.id, reason: 'checkpoint' },
    );
    // `auto_after_timeout`: if no operator decision arrives within `timeoutMs`,
    // auto-approve and resume. Goes through the same ApprovalInboxService.resolve
    // path an operator uses, so the row is marked resolved and the run resumes via
    // the bound checkpoint handler. If the operator already decided, `resolve`
    // throws RESOURCE_CONFLICT (status != pending) and we no-op. (In-memory timer:
    // a process restart before it fires falls back to manual approval.)
    if (config.approvalMode === 'auto_after_timeout' && (config.timeoutMs ?? 0) > 0) {
      const timer = setTimeout(() => {
        void this.deps.approvals
          .resolve({
            workspaceId: ctx.workspaceId,
            approvalId: approval.id,
            decision: 'approve',
            reason: 'auto-approved after checkpoint timeout',
          })
          .catch(() => { /* already resolved by the operator, or the run moved on */ });
      }, config.timeoutMs);
      timer.unref?.();
    }
  }

  /**
   * `human_input`: pause the run and collect structured form values from a human,
   * then resume with those values as the node output. Reuses the checkpoint
   * approval/resume path (source 'checkpoint'); `resolveApproval` detects the
   * human_input node and completes it with the submitted `data` instead of a
   * bare `{ approved: true }`.
   */
  async #executeHumanInput(
    ctx: RunningContext,
    node: WorkflowNode,
    config: HumanInputNodeConfig,
    _inputData: Record<string, unknown>,
  ): Promise<void> {
    const fieldCount = Array.isArray(config.fields) ? config.fields.length : 0;
    const approval = await this.deps.approvals.create({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      userId: ctx.userId,
      runId: ctx.runId,
      taskId: null,
      targetId: node.id,
      gatewayId: null,
      source: 'checkpoint',
      title: (config.prompt?.trim() || `Provide input: ${node.title}`).slice(0, 200),
      summary: `Fill ${fieldCount} field(s) to continue.`,
      confidence: null,
      // Carry the form spec so the operator UI can render inputs and submit real
      // `data` — without it, a UI approve sends no field values and the node
      // re-parks. (The realtime NODE_WAITING_FOR_INPUT event carries the same
      // spec for live surfaces; this persists it for the approvals list.)
      payload: { humanInputForm: { targetId: node.id, prompt: config.prompt ?? null, fields: config.fields ?? [] } },
    });
    this.#pendingApprovals(ctx).set(approval.id, { kind: 'checkpoint', targetId: node.id });
    const ns = ctx.state.nodeStates[node.id]!;
    ns.status = 'WAITING';
    await this.#persistRun(ctx);
    // Carry the form spec so the UI can render the inputs to collect.
    this.deps.bus.publish(
      REALTIME_ROOMS.run(ctx.runId),
      REALTIME_EVENTS.NODE_WAITING_FOR_INPUT,
      { runId: ctx.runId, nodeId: node.id, reason: 'human_input', approvalId: approval.id, form: { prompt: config.prompt ?? null, fields: config.fields } },
    );
  }

  /**
   * An "approve" arrived for a human_input node without its required fields.
   * Keep the node WAITING and open a FRESH pending approval that names the gap,
   * so the run stays paused for a real decision instead of completing empty.
   * (The prior approval row was already consumed by the inbox.)
   */
  async #reparkHumanInput(
    ctx: RunningContext,
    node: WorkflowNode,
    config: HumanInputNodeConfig,
    missing: string[],
  ): Promise<void> {
    const fieldCount = Array.isArray(config.fields) ? config.fields.length : 0;
    const gap = `Missing required field(s): ${missing.join(', ')}.`;
    const approval = await this.deps.approvals.create({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      userId: ctx.userId,
      runId: ctx.runId,
      taskId: null,
      targetId: node.id,
      gatewayId: null,
      source: 'checkpoint',
      title: (config.prompt?.trim() || `Provide input: ${node.title}`).slice(0, 200),
      summary: `${gap} Fill ${fieldCount} field(s) to continue.`,
      confidence: null,
      payload: { humanInputForm: { targetId: node.id, prompt: config.prompt ?? null, fields: config.fields ?? [], blocked: gap } },
    });
    this.#pendingApprovals(ctx).set(approval.id, { kind: 'checkpoint', targetId: node.id });
    const ns = ctx.state.nodeStates[node.id];
    if (ns) ns.status = 'WAITING';
    await this.#persistRun(ctx).catch(() => {});
    this.#audit(ctx, {
      nodeId: node.id,
      action: 'human_input.repark',
      actorType: 'system',
      actorId: 'engine',
      outputSummary: gap,
    });
    this.deps.bus.publish(
      REALTIME_ROOMS.run(ctx.runId),
      REALTIME_EVENTS.NODE_WAITING_FOR_INPUT,
      {
        runId: ctx.runId,
        nodeId: node.id,
        reason: 'human_input',
        approvalId: approval.id,
        blocked: gap,
        form: { prompt: config.prompt ?? null, fields: config.fields },
      },
    );
    this.deps.logger.info('engine.human_input.reparked', { runId: ctx.runId, nodeId: node.id, missing });
  }

  // ────────────────────────────────────────────────────────────
  // Lifecycle helpers
  // ────────────────────────────────────────────────────────────

  async #startNode(ctx: RunningContext, node: WorkflowNode, inputData: Record<string, unknown>) {
    const ns = ctx.state.nodeStates[node.id]!;
    ns.status = 'RUNNING';
    ns.startedAt = new Date().toISOString();
    ns.inputData = inputData;
    await this.deps.ledger.append({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      runId: ctx.runId,
      eventType: 'node.started',
      nodeId: node.id,
      payload: { title: node.title, type: node.type },
    });
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_STARTED, {
      runId: ctx.runId,
      nodeId: node.id,
    });
    this.#emitWorkStep(ctx, node, 'start');
    this.#onPhaseNodeStart(ctx, node);
    this.#audit(ctx, {
      nodeId: node.id,
      action: 'node.started',
      actorType: node.config.kind === 'agent_task' || node.config.kind === 'agent_swarm' ? 'agent' : 'system',
      actorId: nodeActorId(node),
      inputSummary: summarizeForAudit(inputData),
    });
    ctx.eventsSinceSnapshot += 1;
  }

  /** Record an audit entry, enriching it with the node's phase. Best-effort. */
  #audit(ctx: RunningContext, entry: {
    nodeId?: string;
    action: string;
    actorType: 'agent' | 'user' | 'system' | 'scheduler';
    actorId: string;
    inputSummary?: string | null;
    outputSummary?: string | null;
    costCents?: number | null;
    tokensIn?: number | null;
    tokensOut?: number | null;
  }): void {
    if (!this.deps.audit) return;
    this.deps.audit.record({
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      phaseId: entry.nodeId ? phaseIdForNode(ctx.graph, entry.nodeId) : null,
      nodeId: entry.nodeId ?? null,
      agentId: entry.actorType === 'agent' ? entry.actorId : null,
      action: entry.action,
      actorType: entry.actorType,
      actorId: entry.actorId,
      inputSummary: entry.inputSummary ?? null,
      outputSummary: entry.outputSummary ?? null,
      costCents: entry.costCents ?? null,
      tokensIn: entry.tokensIn ?? null,
      tokensOut: entry.tokensOut ?? null,
    });
  }

  // ────────────────────────────────────────────────────────────
  // Phase execution model (Layer 5): SLA tracking + budget governance
  // ────────────────────────────────────────────────────────────

  #phaseRuntime(ctx: RunningContext): Map<string, PhaseRuntimeState> {
    if (!ctx.phaseRuntime) ctx.phaseRuntime = new Map();
    return ctx.phaseRuntime;
  }

  #pendingApprovals(ctx: RunningContext): Map<string, PendingApproval> {
    if (!ctx.pendingApprovals) ctx.pendingApprovals = new Map();
    return ctx.pendingApprovals;
  }

  #nodeRetryAttempts(ctx: RunningContext): Map<string, number> {
    if (!ctx.nodeRetryAttempts) ctx.nodeRetryAttempts = new Map();
    return ctx.nodeRetryAttempts;
  }

  #nodeDispatchCounts(ctx: RunningContext): Map<string, number> {
    if (!ctx.nodeDispatchCounts) ctx.nodeDispatchCounts = new Map();
    return ctx.nodeDispatchCounts;
  }

  /**
   * Record real model token consumption for a node so it lands on the terminal
   * `node.completed` audit entry. Accumulates across re-dispatch / multi-step.
   */
  #recordNodeTokens(ctx: RunningContext, nodeId: string, tokensIn: number, tokensOut: number): void {
    if (!(tokensIn > 0) && !(tokensOut > 0)) return;
    if (!ctx.nodeTokenUsage) ctx.nodeTokenUsage = new Map();
    const prev = ctx.nodeTokenUsage.get(nodeId) ?? { tokensIn: 0, tokensOut: 0 };
    ctx.nodeTokenUsage.set(nodeId, {
      tokensIn: prev.tokensIn + Math.max(0, Math.round(tokensIn)),
      tokensOut: prev.tokensOut + Math.max(0, Math.round(tokensOut)),
    });
  }

  /**
   * Attribute a node's recorded tokens to a specific agent, overriding the
   * node-kind default on the terminal `node.completed` audit entry. Used by paths
   * where the spending agent is known but the completing node is NOT an
   * `agent_task` (the tool loop's resolved agent; an evaluator/router whose model
   * ran on a workspace agent) — so no agent's spend reads as anonymous "engine".
   */
  #attributeNodeTokens(ctx: RunningContext, nodeId: string, agentId: string | null | undefined): void {
    if (!agentId) return;
    if (!ctx.nodeTokenAttribution) ctx.nodeTokenAttribution = new Map();
    ctx.nodeTokenAttribution.set(nodeId, agentId);
  }

  /** Meter an evaluator/router LLM call: record its usage on the node AND, when
   * the judge ran on a workspace agent's model, attribute the spend to that agent.
   * A dedicated (agentless) evaluator model records tokens but stays system-scoped. */
  #recordEvaluationTokens(ctx: RunningContext, nodeId: string, usage: { tokensIn: number; tokensOut: number } | null | undefined, agentId: string | null): void {
    if (usage && (usage.tokensIn > 0 || usage.tokensOut > 0)) {
      this.#recordNodeTokens(ctx, nodeId, usage.tokensIn, usage.tokensOut);
      this.#attributeNodeTokens(ctx, nodeId, agentId);
    }
  }

  /** Capture an agent node's resolved input so the reliability fallback can rebuild its task. */
  #recordNodeInput(ctx: RunningContext, nodeId: string, inputData: Record<string, unknown>): void {
    if (!ctx.nodeLastInput) ctx.nodeLastInput = new Map();
    ctx.nodeLastInput.set(nodeId, inputData);
  }

  /**
   * RELIABILITY (W-reliability): last-resort recovery for an agent node whose bound
   * runtime returned EMPTY output or exited non-zero. Re-runs the SAME task once
   * against a guaranteed workspace structured-completion runtime (synthesis role →
   * the configured evaluator/orchestrator model), parses the JSON, and — if it
   * satisfies the declared output contract — completes the node instead of failing
   * the whole run. Returns true when it recovered the node.
   *
   * This is what stops "agent produced nothing" (a flaky/unconnected CLI harness,
   * a bad model pin, a `claude_code exited 1`) from cascading into a dead run.
   *
   * Returns the recovered, contract-satisfying output for the caller to complete
   * the node with — or null when no fallback runtime is available or it couldn't
   * satisfy the contract. Does NOT complete the node itself (the caller owns that),
   * so it never re-enters the completion chokepoint.
   */
  async #recoverAgentNodeViaFallback(ctx: RunningContext, node: WorkflowNode, reason: string): Promise<Record<string, unknown> | null> {
    // P1.2: debug/test runs surface the raw agent failure — no fallback recovery.
    if (this.#debugRuns.has(ctx.runId)) return null;
    if (node.config.kind !== 'agent_task' && node.config.kind !== 'agent_session') return null;
    // Infrastructure/setup failures need the resource repaired or resumed. A
    // structured-completion fallback cannot reproduce native tool side effects
    // and must never fabricate success (provider_ack, sent_count, deployment id,
    // etc.) after a timed-out or disconnected executor.
    const failureClass = classifyWorkflowFailure(reason).category;
    if (failureClass === 'transient_resource' || failureClass === 'configuration_capability') return null;
    if (!ctx.nodeFallbackAttempted) ctx.nodeFallbackAttempted = new Set();
    if (ctx.nodeFallbackAttempted.has(node.id)) return null;
    ctx.nodeFallbackAttempted.add(node.id);

    const config = node.config as AgentTaskNodeConfig;
    const runtime = this.deps.resolveEvaluatorRuntime?.(ctx.workspaceId, 'synthesis', { task: config.prompt, purpose: 'agent_output_fallback' })
      ?? this.deps.evaluatorRuntime;
    if (!runtime) return null;

    const inputData = ctx.nodeLastInput?.get(node.id) ?? {};
    const inputBlock = Object.keys(inputData).length > 0 ? `\n\nINPUT:\n${safeJson(inputData)}` : '';
    const system = 'You are completing one step of an automated workflow on behalf of an agent whose runtime was unavailable. '
      + 'Do the task from the instructions and INPUT below. Respond with ONE strict JSON object and nothing else — no prose, no code fences.';
    const user = `${config.prompt}${buildNodeProcessBriefing(ctx.graph, node, config)}${inputBlock}`;

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = await runtime.completeStructured<Record<string, unknown>>({
        system,
        user,
        maxTokens: 4_000,
        ...(ctx.abortController ? { signal: ctx.abortController.signal } : {}),
      });
    } catch (err) {
      this.deps.logger.warn('engine.agent_fallback.failed', { runId: ctx.runId, nodeId: node.id, err: (err as Error).message });
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;

    // Must satisfy the declared contract (if any) to count as a real recovery.
    const result = normalizeDeclaredNodeOutputResult(node, parsed);
    if (result.missingKeys.length > 0) {
      this.deps.logger.warn('engine.agent_fallback.contract_unmet', { runId: ctx.runId, nodeId: node.id, missing: result.missingKeys });
      return null;
    }

    this.deps.logger.info('engine.agent_fallback.recovered', { runId: ctx.runId, nodeId: node.id, reason });
    this.#audit(ctx, {
      nodeId: node.id,
      action: 'agent.output_fallback',
      actorType: 'system',
      actorId: 'engine',
      outputSummary: `recovered via workspace runtime after: ${reason}`.slice(0, 200),
    });
    return result.output;
  }

  /**
   * INTELLIGENT OUTPUT ADAPTATION (reshape). The agent produced USABLE output but
   * not in the declared shape (e.g. returned {stores:[…]} for `candidates`). One
   * bounded, GROUNDED structured-completion call maps its own output onto the
   * contract — never invents data; a genuinely-absent field is left for typed
   * defaulting. Gated to a WIRED synthesis runtime (a no-op on the stub-only test
   * path, which sets evaluatorRuntime not resolveEvaluatorRuntime) and one-shot
   * per node. Returns the reshaped object merged over the original.
   */
  async #reshapeAgentOutputToContract(ctx: RunningContext, node: WorkflowNode, output: Record<string, unknown>, missingKeys: string[]): Promise<Record<string, unknown> | null> {
    if (this.#debugRuns.has(ctx.runId)) return null;
    if (!ctx.nodeReshapeAttempted) ctx.nodeReshapeAttempted = new Set();
    if (ctx.nodeReshapeAttempted.has(node.id)) return null;
    ctx.nodeReshapeAttempted.add(node.id);
    const runtime = this.deps.resolveEvaluatorRuntime?.(ctx.workspaceId, 'synthesis', { task: 'reshape output to contract', purpose: 'output_reshape' });
    if (!runtime) return null;
    const config = node.config as AgentTaskNodeConfig;
    const system = 'You reshape one automated step\'s output to a strict JSON contract. '
      + 'Map and EXTRACT the SOURCE object\'s EXISTING evidence onto the required keys — same facts, correct shape/names. '
      + 'Concrete prose is evidence: for example, an explicitly delivered message entails its stated provider acknowledgement and count; an explicitly absent duplicate entails duplicate count zero. '
      + 'Never invent facts that SOURCE does not state or logically entail; only then use the field\'s empty default ([], false, 0, "", {}). '
      + 'Respond with ONE strict JSON object and nothing else — no prose, no code fences.';
    const user = `SOURCE (the step's actual output):\n${safeJson(output)}\n\nMissing required keys: ${missingKeys.join(', ')}${buildNodeProcessBriefing(ctx.graph, node, config)}`;
    try {
      const parsed = await runtime.completeStructured<Record<string, unknown>>({
        system,
        user,
        maxTokens: 4_000,
        ...(ctx.abortController ? { signal: ctx.abortController.signal } : {}),
      });
      if (!parsed || typeof parsed !== 'object') return null;
      this.deps.logger.info('engine.output_reshaped', { runId: ctx.runId, nodeId: node.id });
      return { ...output, ...parsed };
    } catch (err) {
      this.deps.logger.warn('engine.output_reshape.failed', { runId: ctx.runId, nodeId: node.id, err: (err as Error).message });
      return null;
    }
  }

  /** Whether a failed node qualifies for generic `retryPolicy` re-dispatch. */
  #shouldGenericRetry(node: WorkflowNode, error: string): boolean {
    const policy = node.retryPolicy;
    if (!policy || !(policy.maxAttempts > 0)) return false;
    // Agent-like kinds run through self-heal / AgentRetryPolicy — never double-retry.
    if (GENERIC_RETRY_EXCLUDED_KINDS.has(node.config.kind)) return false;
    // Self-heal-terminal / recoverable-model errors are handled separately upstream.
    if (isSelfHealTerminalError(error)) return false;
    if (policy.retryOn && policy.retryOn.length > 0) {
      const lc = error.toLowerCase();
      if (!policy.retryOn.some((s) => lc.includes(s.toLowerCase()))) return false;
    }
    return true;
  }

  /**
   * Route an approval resolution to the right resume path (checkpoint node or
   * phase gate). The resume target is looked up from the in-memory map keyed by
   * the approval id. Public — called from the approval-resolution wiring.
   */
  async resolveApproval(args: { runId: string; approvalId: string; decision: 'approve' | 'reject' | 'revise'; data?: Record<string, unknown>; feedback?: string }): Promise<void> {
    const ctx = this.#runs.get(args.runId) ?? this.#ensureRecoveredCtx(args.runId);
    if (!ctx) return;
    const pending = ctx.pendingApprovals?.get(args.approvalId) ?? this.#recoverPendingApproval(ctx, args.approvalId);
    if (!pending) return;
    ctx.pendingApprovals!.delete(args.approvalId);
    // `revise` — the operator sends a new instruction back INSTEAD of approving
    // or cancelling. The run is never torn down: an agent session is woken with
    // the note (it decides what to do and may re-request approval); any other
    // gate is re-parked so it stays waiting with the operator's note attached.
    if (args.decision === 'revise') {
      await this.#reviseApproval(ctx, pending, args.feedback ?? '');
      return;
    }
    if (pending.kind === 'phase_gate') {
      if (args.decision === 'approve') await this.resumePhaseGate({ runId: args.runId, phaseId: pending.targetId });
      else await this.failRunForGate({ runId: args.runId, phaseId: pending.targetId, reason: 'Phase gate rejected' });
      return;
    }
    if (pending.kind === 'session') {
      // Resume the session either way — the agent decides what to do with a
      // rejection. Missing bookkeeping means the run moved on; ignore.
      if (!pending.sessionId || !pending.toolCallId || !pending.runCtx) return;
      const node = ctx.graph.nodes.find((n) => n.id === pending.targetId);
      if (!node) return;
      await this.#wakeSession(ctx, node, pending.sessionId, pending.runCtx, pending.toolCallId, {
        approved: args.decision === 'approve',
        decision: args.decision,
      });
      return;
    }
    if (pending.kind === 'self_heal') {
      // W7 approve mode: apply the certified patch + re-run the node; on reject,
      // fail the node honestly (no silent bad apply).
      const node = ctx.graph.nodes.find((candidate) => candidate.id === pending.targetId);
      if (args.decision === 'approve' && pending.healAction === 'retry_with_repair_context' && node) {
        const retried = await this.#selfHeal.retryWithRepairContext(
          ctx,
          node,
          pending.retryError ?? 'Previous attempt failed.',
          pending.retryDiagnosis ?? 'Retry requested by self-healing.',
          pending.retryAttempt ?? 1,
          pending.retryMaxAttempts ?? 1,
          'guarded',
        );
        this.#audit(ctx, { nodeId: pending.targetId, action: 'self_heal.retry_approved', actorType: 'user', actorId: 'operator', outputSummary: retried ? 'approved and retried' : 'approved but retry failed' });
        if (!retried) void this.#tick(ctx);
      } else if (args.decision === 'approve' && pending.healPatch) {
        const applied = await this.#selfHeal.applyHealAndRedispatch(ctx, pending.healResumeNodeId ?? pending.targetId, pending.healPatch, pending.repairPlanId);
        if (node) {
          if (pending.repairPlanId) this.#selfHeal.completeRepairPlan(ctx, node, pending.repairPlanId, applied ? 'applied' : 'blocked');
          this.#selfHeal.recordSelfHealIncident(ctx, node, {
            status: applied ? 'APPLIED' : 'BLOCKED',
            outcome: applied ? 'graph_patch_applied' : 'blocked',
            reason: applied ? 'Operator approved the self-healing fix.' : 'Approved self-healing patch could not be applied.',
          });
          await this.#persistRun(ctx).catch(() => {});
        }
        if (!applied) await this.#failNode(ctx, pending.targetId, 'self-healing patch could not be applied');
        this.#audit(ctx, { nodeId: pending.targetId, action: 'self_heal.approved', actorType: 'user', actorId: 'operator', outputSummary: applied ? 'approved and applied' : 'approved but apply failed' });
      } else {
        if (node) {
          if (pending.repairPlanId) this.#selfHeal.completeRepairPlan(ctx, node, pending.repairPlanId, 'rejected');
          this.#selfHeal.recordSelfHealIncident(ctx, node, {
            status: 'BLOCKED',
            outcome: 'blocked',
            reason: 'Self-healing fix was rejected by the operator.',
          });
          await this.#persistRun(ctx).catch(() => {});
        }
        await this.#failNode(ctx, pending.targetId, 'self-healing fix was rejected by the operator');
        this.#audit(ctx, { nodeId: pending.targetId, action: 'self_heal.rejected', actorType: 'user', actorId: 'operator', outputSummary: 'operator rejected repair' });
        void this.#tick(ctx);
      }
      return;
    }
    // checkpoint / human_input. A human_input node completes with the SUBMITTED
    // form values as its output; a plain checkpoint completes with { approved }.
    const resolvedNode = ctx.graph.nodes.find((n) => n.id === pending.targetId);
    if (resolvedNode?.config.kind === 'human_input') {
      if (args.decision === 'approve') {
        const cfg = resolvedNode.config as HumanInputNodeConfig;
        const submitted = args.data ?? {};
        // ENFORCE THE NODE'S OWN CONTRACT. An "approve" that omits the required
        // form fields is not a decision — it is a missing decision. Completing
        // with `{}` silently passes an empty payload downstream (the exact
        // "seed-approval → {} → gate throws BLOCKED" failure). Instead, keep the
        // node WAITING and re-open a fresh pending approval naming the gap, so
        // the run stays paused for a REAL decision rather than green-washing one.
        const missing = missingRequiredHumanInputFields(cfg, submitted);
        if (missing.length > 0) {
          await this.#reparkHumanInput(ctx, resolvedNode, cfg, missing);
          return;
        }
        const output = cfg.outputKey ? { [cfg.outputKey]: submitted } : submitted;
        await this.notifyTaskCompleted({ runId: args.runId, nodeId: pending.targetId, output });
      } else {
        // The human declined to provide input — fail the node so the run doesn't hang.
        await this.#failNode(ctx, pending.targetId, 'human input was declined');
        void this.#tick(ctx);
      }
      return;
    }
    // checkpoint: approve completes the node; reject leaves it waiting (V1).
    if (args.decision === 'approve') {
      await this.notifyTaskCompleted({ runId: args.runId, nodeId: pending.targetId, output: { approved: true } });
    }
  }

  /**
   * `revise` — the operator's third decision. Instead of approving or cancelling
   * (which loses the run), they send a new instruction back to whoever is
   * waiting. For an agent session (orchestrator/manager parked on
   * `request_approval`) we WAKE it with the note so it can adjust and continue —
   * the run never dies. For a deterministic gate (plain checkpoint / human_input
   * / phase gate / self-heal) there is no agent to talk to, so we RE-PARK a fresh
   * pending approval carrying the note, keeping the run WAITING and actionable.
   */
  async #reviseApproval(ctx: RunningContext, pending: PendingApproval, feedback: string): Promise<void> {
    const note = feedback.trim();
    const node = ctx.graph.nodes.find((n) => n.id === pending.targetId);
    if (pending.kind === 'session') {
      if (!pending.sessionId || !pending.toolCallId || !pending.runCtx || !node) return;
      // The note becomes the result of the agent's `request_approval` tool call.
      await this.#wakeSession(ctx, node, pending.sessionId, pending.runCtx, pending.toolCallId, {
        approved: false,
        decision: 'revise',
        feedback: note,
      });
      this.#audit(ctx, { nodeId: pending.targetId, action: 'approval.revised', actorType: 'user', actorId: 'operator', outputSummary: note ? `operator instruction: ${note.slice(0, 160)}` : 'operator asked for a change' });
      return;
    }
    // Deterministic gate: re-park so the run stays alive with the note attached.
    const approval = await this.deps.approvals.create({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      userId: ctx.userId,
      runId: ctx.runId,
      taskId: null,
      targetId: pending.targetId,
      gatewayId: null,
      source: pending.kind === 'phase_gate' ? 'phase_gate' : pending.kind === 'self_heal' ? 'self_heal' : 'checkpoint',
      title: node ? `Revise: ${node.title ?? pending.targetId}` : 'Approval needs a decision',
      summary: note ? `Operator asked for a change:\n\n${note}` : 'Operator asked for a change before approving.',
      confidence: null,
      payload: note ? { operatorNote: note } : null,
    });
    this.#pendingApprovals(ctx).set(approval.id, pending);
    await this.#persistRun(ctx).catch(() => {});
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_WAITING_FOR_INPUT, {
      runId: ctx.runId,
      nodeId: pending.targetId,
      reason: 'approval_revise',
    });
    this.#audit(ctx, { nodeId: pending.targetId, action: 'approval.revised', actorType: 'user', actorId: 'operator', outputSummary: note ? `operator note: ${note.slice(0, 160)}` : 'operator asked for a change' });
  }

  #recoverPendingApproval(ctx: RunningContext, approvalId: string): PendingApproval | null {
    const row = this.deps.db
      .select()
      .from(schema.approvalRequests)
      .where(and(eq(schema.approvalRequests.id, approvalId), eq(schema.approvalRequests.runId, ctx.runId)))
      .get();
    if (!row?.targetId) return null;
    const kind = row.source === 'phase_gate'
      ? 'phase_gate'
      : row.source === 'self_heal'
        ? 'self_heal'
        : row.source === 'checkpoint'
          ? 'checkpoint'
          : null;
    if (!kind) return null;
    if (kind === 'self_heal') {
      const payload = row.payload as Record<string, unknown> | null;
      if (payload?.kind === 'retry_with_repair_context') {
        const pending: PendingApproval = {
          kind,
          targetId: row.targetId,
          healAction: 'retry_with_repair_context',
          retryError: typeof payload.error === 'string' ? payload.error : 'Previous attempt failed.',
          retryDiagnosis: typeof payload.diagnosis === 'string' ? payload.diagnosis : 'Retry requested by self-healing.',
          retryAttempt: typeof payload.attempt === 'number' ? payload.attempt : 1,
          retryMaxAttempts: typeof payload.maxAttempts === 'number' ? payload.maxAttempts : 1,
        };
        this.#pendingApprovals(ctx).set(approvalId, pending);
        return pending;
      }
      const healPatch = selfHealPatchFromPayload(row.payload);
      if (!healPatch) return null;
      const pending: PendingApproval = {
        kind,
        targetId: row.targetId,
        healAction: 'graph_patch',
        healPatch,
        healResumeNodeId: typeof payload?.resumeNodeId === 'string' ? payload.resumeNodeId : undefined,
        repairPlanId: typeof payload?.repairPlanId === 'string' ? payload.repairPlanId : undefined,
      };
      this.#pendingApprovals(ctx).set(approvalId, pending);
      return pending;
    }
    const pending: PendingApproval = { kind, targetId: row.targetId };
    this.#pendingApprovals(ctx).set(approvalId, pending);
    return pending;
  }

  /** Start the phase clock + SLA timer the first time any of its nodes runs. */
  #onPhaseNodeStart(ctx: RunningContext, node: WorkflowNode): void {
    const phaseId = phaseIdForNode(ctx.graph, node.id);
    if (!phaseId) return;
    const phase = ctx.graph.phases?.find((p) => p.id === phaseId);
    if (!phase) return;
    const rt = this.#phaseRuntime(ctx);
    let st = rt.get(phaseId);
    if (!st) { st = { started: false, startedAt: 0, cost: 0, slaBreached: false }; rt.set(phaseId, st); }
    if (st.started) return;
    st.started = true;
    st.startedAt = Date.now();
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.PHASE_STARTED, {
      runId: ctx.runId, phaseId, name: phase.name,
    });
    if (typeof phase.slaDurationMs === 'number' && phase.slaDurationMs > 0) {
      const timer = setTimeout(() => {
        st!.slaBreached = true;
        const payload = { runId: ctx.runId, phaseId, name: phase.name, slaDurationMs: phase.slaDurationMs };
        this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.PHASE_SLA_BREACHED, payload);
        this.deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), REALTIME_EVENTS.PHASE_SLA_BREACHED, payload);
        this.#audit(ctx, { action: 'phase.sla_breached', actorType: 'system', actorId: 'engine', outputSummary: `phase ${phase.name} exceeded ${phase.slaDurationMs}ms` });
      }, phase.slaDurationMs);
      timer.unref?.();
      st.slaTimer = timer;
    }
  }

  /**
   * Accrue a completed node's cost into its phase. Returns true when the phase
   * budget is exceeded (the caller halts the run). Also emits PHASE_COMPLETED
   * and clears the SLA timer when the phase finishes.
   */
  #onPhaseNodeComplete(ctx: RunningContext, node: WorkflowNode): boolean {
    const phaseId = phaseIdForNode(ctx.graph, node.id);
    if (!phaseId) return false;
    const phase = ctx.graph.phases?.find((p) => p.id === phaseId);
    if (!phase) return false;
    const rt = this.#phaseRuntime(ctx);
    const st = rt.get(phaseId) ?? { started: true, startedAt: Date.now(), cost: 0, slaBreached: false };
    rt.set(phaseId, st);
    st.cost += nodeCostCents(node) ?? 0;

    if (typeof phase.budgetCents === 'number' && st.cost > phase.budgetCents) {
      const payload = { runId: ctx.runId, phaseId, name: phase.name, spentCents: st.cost, budgetCents: phase.budgetCents };
      this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.BUDGET_PHASE_EXCEEDED, payload);
      this.deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), REALTIME_EVENTS.BUDGET_PHASE_EXCEEDED, payload);
      this.#audit(ctx, { action: 'budget.phase_exceeded', actorType: 'system', actorId: 'engine', outputSummary: `phase ${phase.name} spent ${st.cost}c > ${phase.budgetCents}c` });
      if (st.slaTimer) clearTimeout(st.slaTimer);
      return true;
    }

    const allDone = phase.nodeIds.every((id) =>
      ctx.state.completedNodeIds.includes(id) || ctx.state.skippedNodeIds.includes(id));
    if (allDone) {
      if (st.slaTimer) clearTimeout(st.slaTimer);
      this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.PHASE_COMPLETED, {
        runId: ctx.runId, phaseId, name: phase.name, spentCents: st.cost,
        durationMs: st.startedAt ? Date.now() - st.startedAt : null, slaBreached: st.slaBreached,
      });
      this.#audit(ctx, { action: 'phase.completed', actorType: 'system', actorId: 'engine', outputSummary: `${phase.name}: ${st.cost}c` });
    }
    return false;
  }

  /**
   * Per-run workflow cost ceiling (§5.3): the middle budget tier between
   * per-phase and workspace/day. Accrues the completed node's cost into the run
   * total and returns true when it exceeds `workflows.budget_cents`.
   */
  #workflowRunBudgetExceeded(ctx: RunningContext, node: WorkflowNode): boolean {
    ctx.runCostCents = (ctx.runCostCents ?? 0) + (nodeCostCents(node) ?? 0);
    if (ctx.workflowBudgetCents === undefined) {
      const wf = this.deps.db
        .select({ budget: schema.workflows.budgetCents })
        .from(schema.workflows)
        .where(eq(schema.workflows.id, ctx.workflowId))
        .get();
      ctx.workflowBudgetCents = wf?.budget ?? null;
    }
    const cap = ctx.workflowBudgetCents;
    if (cap == null || cap <= 0 || ctx.runCostCents <= cap) return false;
    const payload = { runId: ctx.runId, workflowId: ctx.workflowId, spentCents: ctx.runCostCents, budgetCents: cap };
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.BUDGET_RUN_EXCEEDED, payload);
    this.deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), REALTIME_EVENTS.BUDGET_RUN_EXCEEDED, payload);
    this.#audit(ctx, { action: 'budget.run_exceeded', actorType: 'system', actorId: 'engine', outputSummary: `run spent ${ctx.runCostCents}c > ${cap}c` });
    return true;
  }

  /**
   * Workspace/day cost ceiling (§5.3): the outermost budget cage above per-phase.
   * Sums the workspace's audited spend since UTC midnight (the just-completed
   * node's cost is already recorded synchronously) and returns true when it
   * exceeds `workspaces.daily_budget_cents`. Uncapped workspaces never trip.
   */
  #workspaceDailyBudgetExceeded(ctx: RunningContext): boolean {
    if (!this.deps.audit) return false;
    const ws = this.deps.db
      .select({ cap: schema.workspaces.dailyBudgetCents })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, ctx.workspaceId))
      .get();
    const cap = ws?.cap;
    if (cap == null || cap <= 0) return false;
    const startOfDay = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
    const spent = this.deps.audit.workspaceSpendSince(ctx.workspaceId, startOfDay);
    if (spent <= cap) return false;
    const payload = { runId: ctx.runId, workspaceId: ctx.workspaceId, spentCents: spent, budgetCents: cap };
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.BUDGET_WORKSPACE_EXCEEDED, payload);
    this.deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), REALTIME_EVENTS.BUDGET_WORKSPACE_EXCEEDED, payload);
    this.#audit(ctx, { action: 'budget.workspace_exceeded', actorType: 'system', actorId: 'engine', outputSummary: `workspace spent ${spent}c > ${cap}c/day` });
    return true;
  }

  /**
   * Hold a node before dispatch when its phase has a human gate that hasn't been
   * granted. Creates a `phase_gate` approval the first time, marks the node
   * WAITING, and stashes the ready item for re-enqueue on approval. Returns true
   * when the node was held (caller must not dispatch it).
   */
  async #maybeHoldForPhaseGate(ctx: RunningContext, node: WorkflowNode, item: ReadyQueueItem): Promise<boolean> {
    const phaseId = phaseIdForNode(ctx.graph, node.id);
    if (!phaseId) return false;
    const phase = ctx.graph.phases?.find((p) => p.id === phaseId);
    if (!phase?.humanGate) return false;
    const rt = this.#phaseRuntime(ctx);
    let st = rt.get(phaseId);
    if (!st) { st = { started: false, startedAt: 0, cost: 0, slaBreached: false }; rt.set(phaseId, st); }
    if (st.gateState === 'approved') return false;

    st.held = st.held ?? [];
    st.held.push(item);
    const ns = ctx.state.nodeStates[node.id];
    if (ns) ns.status = 'WAITING';

    if (st.gateState !== 'pending') {
      st.gateState = 'pending';
      const approval = await this.deps.approvals.create({
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId,
        userId: ctx.userId,
        runId: ctx.runId,
        taskId: null,
        targetId: phaseId,
        gatewayId: null,
        source: 'phase_gate',
        title: `Approve phase: ${phase.name}`,
        summary: phase.humanGate.message ?? `Phase "${phase.name}" requires approval before it runs.`,
        confidence: null,
      });
      this.#pendingApprovals(ctx).set(approval.id, { kind: 'phase_gate', targetId: phaseId });
      this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_WAITING_FOR_INPUT, {
        runId: ctx.runId, nodeId: node.id, reason: 'phase_gate', phaseId,
      });
      this.#audit(ctx, { nodeId: node.id, action: 'human_gate.requested', actorType: 'system', actorId: 'engine', outputSummary: `phase ${phase.name}` });
    }
    await this.#persistRun(ctx);
    return true;
  }

  /**
   * Release a phase gate (operator approved). Re-enqueues every node held behind
   * the gate and re-enters the dispatch loop. Public — called from the approval
   * resolution handler.
   */
  async resumePhaseGate(args: { runId: string; phaseId: string }): Promise<void> {
    const ctx = this.#runs.get(args.runId);
    if (!ctx) return;
    const st = ctx.phaseRuntime?.get(args.phaseId);
    if (!st || st.gateState === 'approved') return;
    st.gateState = 'approved';
    const held = st.held ?? [];
    st.held = [];
    this.#audit(ctx, { action: 'human_gate.approved', actorType: 'user', actorId: 'operator', outputSummary: `phase ${args.phaseId}` });
    for (const item of held) {
      const ns = ctx.state.nodeStates[item.nodeId];
      if (ns) ns.status = 'PENDING';
      ctx.state.readyQueue.push(item);
    }
    if (ctx.state.status === 'WAITING') ctx.state.status = 'RUNNING';
    await this.#persistRun(ctx);
    void this.#tick(ctx);
  }

  /** Fail a run because a phase gate was rejected. Public — called from approval resolution. */
  async failRunForGate(args: { runId: string; phaseId: string; reason: string }): Promise<void> {
    const ctx = this.#runs.get(args.runId);
    if (!ctx) {
      await this.#cancelPersistedRun(args.runId);
      return;
    }
    this.#audit(ctx, { action: 'human_gate.rejected', actorType: 'user', actorId: 'operator', outputSummary: `phase ${args.phaseId}: ${args.reason}` });
    markOpenNodesSkipped(ctx.state, args.reason);
    await this.#transitionRunStatus(ctx, 'FAILED');
    this.#disposeRunState(args.runId);
  }

  /** Clear any pending phase SLA timers (called on run terminal). */
  #clearPhaseTimers(ctx: RunningContext): void {
    if (!ctx.phaseRuntime) return;
    for (const st of ctx.phaseRuntime.values()) {
      if (st.slaTimer) clearTimeout(st.slaTimer);
    }
  }

  async #completeNode(
    ctx: RunningContext,
    nodeId: string,
    output: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    // All executor paths converge here. Treat late completion after cancellation
    // as an acknowledgement only; it must not mutate graph state or fan out.
    if (ctx.cancellationRequested || isTerminalRunStatus(ctx.state.status)) return null;
    const ns = ctx.state.nodeStates[nodeId];
    if (!ns) return null;
    const completedNode = ctx.graph.nodes.find((n) => n.id === nodeId);
    // W5.0/W7 — the universal completion chokepoint. If the output misses its
    // declared contract, self-heal (recover from the agent's own output, or
    // apply/queue a structural repair) before failing. structural outcomes
    // re-dispatch or pause the node — abort this completion.
    let normalizedOutput: Record<string, unknown>;
    try {
      normalizedOutput = completedNode ? normalizeDeclaredNodeOutput(completedNode, output) : output;
    } catch (err) {
      const heal = completedNode ? await this.#selfHeal.runSelfHeal(ctx, completedNode, output, (err as Error).message) : { kind: 'none' as const };
      if (heal.kind === 'structural_applied' || heal.kind === 'awaiting_approval') return null;
      if (heal.kind !== 'output_fixed') throw new Error(selfHealFailureMessage((err as Error).message, heal));
      normalizedOutput = completedNode ? normalizeDeclaredNodeOutput(completedNode, heal.output) : heal.output;
    }
    let normalization = completedNode
      ? normalizeDeclaredNodeOutputResult(completedNode, normalizedOutput)
      : outputNormalization(normalizedOutput);
    if (completedNode && normalization.missingKeys.length > 0) {
      const missingMessage = missingDeclaredOutputMessage(completedNode, normalization.missingKeys);
      // RELIABILITY fast path: when an agent produced NO usable output, extraction-
      // based self-heal is pointless (there is nothing to extract) and would burn
      // ~3 LLM repair attempts before giving up. Go straight to a one-shot retry on
      // a guaranteed workspace runtime. If it recovers we skip self-heal entirely;
      // if not, we fall through to the existing self-heal ladder unchanged (the
      // one-shot guard stops the later fallback rung from re-running).
      const isAgentNode = completedNode.config.kind === 'agent_task' || completedNode.config.kind === 'agent_session';
      if (isAgentNode && !hasAnyUsableOutput(output)) {
        const recovered = await this.#recoverAgentNodeViaFallback(ctx, completedNode, agentOutputFailureReason(output, missingMessage));
        if (recovered) {
          normalization = normalizeDeclaredNodeOutputResult(completedNode, recovered);
          normalizedOutput = normalization.output;
        }
      }
    }
    if (completedNode && normalization.missingKeys.length > 0) {
      const missingMessage = missingDeclaredOutputMessage(completedNode, normalization.missingKeys);
      const heal = await this.#selfHeal.runSelfHeal(
        ctx,
        completedNode,
        output,
        missingMessage,
      );
      if (heal.kind === 'structural_applied' || heal.kind === 'awaiting_approval') return null;
      if (heal.kind === 'output_fixed') {
        normalization = normalizeDeclaredNodeOutputResult(completedNode, heal.output);
        normalizedOutput = normalization.output;
      } else if (heal.kind === 'none' && heal.reason) {
        // RELIABILITY: self-heal couldn't recover the contract from the agent's own
        // output (dominant real case: the bound runtime returned EMPTY — flaky/
        // unconnected harness or a bad model pin). Last resort: re-run the task once
        // on a guaranteed workspace runtime, then complete with that output inline.
        const recovered = await this.#recoverAgentNodeViaFallback(ctx, completedNode, agentOutputFailureReason(output, missingMessage));
        if (recovered) {
          normalization = normalizeDeclaredNodeOutputResult(completedNode, recovered);
          normalizedOutput = normalization.output;
        } else if (!hasAnyUsableOutput(normalizedOutput)) {
          // Genuinely no usable output (runtime returned empty) and the fallback
          // could not recover → honest hard failure.
          throw new Error(selfHealFailureMessage(agentOutputFailureReason(output, missingMessage), heal));
        }
        // else: the agent produced usable output but not every declared key —
        // fall through; the typed-empty defaults below complete the contract.
      }
    }
    // INTELLIGENT OUTPUT ADAPTATION: an agent that produced usable output but
    // omitted some declared keys COMPLETES with typed-empty defaults for the
    // absent ones (empty-but-complete contract = success — e.g. `candidates: []`
    // is a valid "no store found", not a run-killing failure). A node that
    // produced NOTHING usable was already hard-failed above.
    if (completedNode && normalization.missingKeys.length > 0 && hasAnyUsableOutput(normalizedOutput)) {
      // 1. RESHAPE — recover the declared keys' SUBSTANCE from the agent's actual
      //    output shape (one bounded, grounded call) before defaulting to empty.
      const isAgentNode = completedNode.config.kind === 'agent_task' || completedNode.config.kind === 'agent_session';
      if (isAgentNode) {
        const reshaped = await this.#reshapeAgentOutputToContract(ctx, completedNode, normalizedOutput, normalization.missingKeys);
        if (reshaped) {
          const re = normalizeDeclaredNodeOutputResult(completedNode, reshaped);
          if (re.missingKeys.length < normalization.missingKeys.length) { normalization = re; normalizedOutput = re.output; }
        }
      }
      // A prose transcript (or runtime/tool noise) that satisfies NONE of a
      // multi-field contract is not a partially useful structured result. Filling
      // every field with false/0/"" previously turned real side effects into a
      // mechanically completed node and made the final verifier contradict the
      // outside world. Partial omissions remain adaptable; total contract loss is
      // an honest node failure with the original evidence preserved for diagnosis.
      if (
        isEvidenceBearingOutputContract(normalization.declaredKeys)
        && normalization.missingKeys.length === normalization.declaredKeys.length
      ) {
        throw new Error(`OUTPUT_CONTRACT_UNSATISFIED: ${missingDeclaredOutputMessage(completedNode, normalization.missingKeys)}; the runtime returned no declared fields.`);
      }
      // 2. TYPED-EMPTY DEFAULTS — complete any keys STILL absent. Keeps the
      //    adaptation HONEST + VISIBLE: the run is COMPLETED_WITH_CONTRACT_VIOLATION
      //    (a deviation records the defaulted keys), downstream reads get typed
      //    empties instead of undefined, and the run neither crashes nor loops. A
      //    node that produced NOTHING usable was already hard-failed above.
      if (normalization.missingKeys.length > 0) {
        const filled = normalizeDeclaredNodeOutputResult(completedNode, normalizedOutput, { fillTypedDefaults: true });
        normalizedOutput = filled.output;
        normalization = { ...filled, missingKeys: filled.defaultedKeys };
        // fall through to the tripwire below — a typed-empty fill on a floored
        // key must trip NOW, not 20 nodes later.
        if (filled.defaultedKeys.length > 0) {
          this.deps.logger.info('engine.output_adapted', { runId: ctx.runId, nodeId, defaultedKeys: filled.defaultedKeys });
        }
      }
    }
    // ── SWIFT V6 — mid-run sufficiency tripwire (anti-hollow). A producer
    // handing a hollow payload downstream trips a LOGIC failure NOW (with the
    // named deficiency) instead of 20 nodes later at the verdict. Only fires
    // when the workflow's spec declares floors for keys this node produced;
    // control-flow kinds (filter legitimately yields empty) are exempt, and a
    // node may opt out with `allowEmptyOutput: true`.
    if (completedNode && this.#sufficiencyTripwireApplies(completedNode)) {
      const violation = this.#sufficiencyViolation(ctx, completedNode, normalizedOutput);
      if (violation) {
        const message = `SUFFICIENCY_FLOOR: ${violation} — downstream steps (and the acceptance checks) need real content here, not a hollow payload.`;
        const heal = await this.#selfHeal.runSelfHeal(ctx, completedNode, normalizedOutput, message);
        if (heal.kind === 'structural_applied' || heal.kind === 'awaiting_approval') return null;
        if (heal.kind === 'output_fixed' && !this.#sufficiencyViolation(ctx, completedNode, heal.output)) {
          normalizedOutput = heal.output;
        } else {
          throw new Error(message);
        }
      }
    }
    const deviation = normalization.missingKeys.length > 0
      ? buildContractDeviation(completedNode, normalization)
      : undefined;
    ns.status = 'COMPLETED';
    ns.completedAt = new Date().toISOString();
    ns.outputData = normalizedOutput;
    if (deviation) ns.contractDeviation = deviation;
    else delete ns.contractDeviation;
    if (!ctx.state.completedNodeIds.includes(nodeId)) ctx.state.completedNodeIds.push(nodeId);
    delete ctx.state.activeExecutions[nodeId];

    await this.deps.ledger.append({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      runId: ctx.runId,
      eventType: 'node.completed',
      nodeId,
      payload: { output: normalizedOutput },
    });
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_COMPLETED, {
      runId: ctx.runId,
      nodeId,
      outputPreview: compactRealtimePayload(normalizedOutput),
    });
    if (deviation) {
      this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.CONTRACT_VIOLATION, {
        runId: ctx.runId,
        nodeId,
        violations: [deviation.message],
        deviation,
      });
    }
    if (completedNode) this.#emitWorkStep(ctx, completedNode, 'complete');
    const nodeTokens = ctx.nodeTokenUsage?.get(nodeId);
    // Prefer an explicit token attribution (tool-loop resolved agent, or an
    // evaluator/router that ran on an agent's model) so the spend is stamped with
    // the real agent even when the completing node isn't an `agent_task`. Falls
    // back to the node-kind default (agent_task/swarm → its agent, else engine).
    const attributedAgentId = ctx.nodeTokenAttribution?.get(nodeId);
    const isAgentNode = completedNode !== undefined && (completedNode.config.kind === 'agent_task' || completedNode.config.kind === 'agent_swarm');
    this.#audit(ctx, {
      nodeId,
      action: 'node.completed',
      actorType: attributedAgentId || isAgentNode ? 'agent' : 'system',
      actorId: attributedAgentId ?? (completedNode ? nodeActorId(completedNode) : 'engine'),
      outputSummary: summarizeForAudit(normalizedOutput),
      costCents: completedNode ? nodeCostCents(completedNode) : null,
      tokensIn: nodeTokens?.tokensIn ?? null,
      tokensOut: nodeTokens?.tokensOut ?? null,
    });
    // Usage has been persisted on the terminal entry; drop it so a re-dispatch
    // of the same node id (retry / loop body) starts a fresh tally.
    ctx.nodeTokenUsage?.delete(nodeId);
    ctx.nodeTokenAttribution?.delete(nodeId);
    ctx.eventsSinceSnapshot += 1;

    // Phase governance (Layer 5): accrue cost; on budget overrun, halt the run
    // before fanning out so no further spend occurs. The settle loop in #tick
    // transitions the run to FAILED when `budgetHalt` is set.
    if (completedNode && this.#onPhaseNodeComplete(ctx, completedNode)) {
      ctx.budgetHalt = true;
      markOpenNodesSkipped(ctx.state, 'Halted: phase budget exceeded');
      await this.#persistRun(ctx);
      return normalizedOutput;
    }

    // Per-run workflow ceiling (§5.3) — the middle budget tier.
    if (completedNode && this.#workflowRunBudgetExceeded(ctx, completedNode)) {
      ctx.budgetHalt = true;
      markOpenNodesSkipped(ctx.state, 'Halted: workflow run budget exceeded');
      await this.#persistRun(ctx);
      return normalizedOutput;
    }

    // Workspace/day ceiling (§5.3) — the outermost budget cage. Checked after
    // every node so a single run can't blow the workspace's daily allowance.
    if (this.#workspaceDailyBudgetExceeded(ctx)) {
      ctx.budgetHalt = true;
      markOpenNodesSkipped(ctx.state, 'Halted: workspace daily budget exceeded');
      await this.#persistRun(ctx);
      return normalizedOutput;
    }

    // Fan out to downstream nodes. Error edges are reserved for `#failNode`
    // and must NOT be traversed on a successful completion — but their
    // downstream target IS still waiting on this source's id. Drop it from
    // the required list so the target doesn't block the run from settling.
    // `__hold`: a node (e.g. aggregate_window with an open window) completed but
    // explicitly defers its downstream — fire NO outgoing edges this run; drop
    // this node from each target's required inputs so the run still settles.
    const held = (normalizedOutput as { __hold?: unknown } | null)?.__hold === true;

    // P0.1: one lazily-built condition scope for the whole fan-out (all edges
    // share this node's `normalizedOutput`); base snapshots built once, and only
    // if some edge actually carries a condition.
    let fanoutScope: Record<string, unknown> | null = null;
    const buildFanoutScope = () => (fanoutScope ??= this.#buildConditionScope(ctx, normalizedOutput));
    for (const edge of ctx.downstreamEdges.get(nodeId) ?? []) {
      const buf = ctx.state.waitingInputs[edge.target];
      if (!buf) continue;

      if (held) {
        buf.requiredInputs = buf.requiredInputs.filter((id) => id !== nodeId);
        this.#promoteOrSkipTarget(ctx, edge.target, 'Skipped: upstream is buffering (window still open)');
        continue;
      }

      if (edge.type === 'error') {
        // Catch branch — source completed successfully, so this edge never
        // fires. Drop it from required; the join gate decides whether the
        // target can still be fed (promote) or is now unreachable (skip).
        buf.requiredInputs = buf.requiredInputs.filter((id) => id !== nodeId);
        this.#promoteOrSkipTarget(ctx, edge.target, 'Skipped: catch-only branch with no error to handle');
        continue;
      }

      // Conditional / branch edge gating (router branches, filter gates, etc.).
      if (!shouldTraverseEdge(edge, normalizedOutput, buildFanoutScope)) {
          // NATIVE-ADVANCEMENT Proposal 3 (Agentis-native skip propagation):
          // the branch was NOT taken, so this edge will never deliver. Drop it
          // from the target's required inputs so the target doesn't block the
          // run forever; the join gate then promotes (if another branch already
          // satisfied it) or skip-cascades when nothing else can feed it.
          buf.requiredInputs = buf.requiredInputs.filter((id) => id !== nodeId);
          this.#promoteOrSkipTarget(ctx, edge.target, 'Skipped: branch condition not met');
          continue;
      }

      buf.receivedInputs[nodeId] = normalizedOutput;
      buf.requiredInputs = buf.requiredInputs.filter((id) => id !== nodeId);
      this.#promoteOrSkipTarget(ctx, edge.target, 'Skipped: upstream path never produced an input');
    }

    await this.#maybeSnapshot(ctx);
    // Per-node-completion checkpoint of the run_state resume cache. This is the
    // hot path — it fires on EVERY node completion, and a growing multi-MB blob
    // rewritten synchronously here on each one is what stalls the (single-thread,
    // synchronous SQLite) event loop mid-run. Coalesce it: the completion is
    // already durable in the ledger and live via the NODE_COMPLETED realtime
    // event, so the DB cache lagging by ≤debounce is safe. Any immediate boundary
    // write (downstream dispatch transition, terminal settle) flushes it early.
    this.#schedulePersist(ctx);
    return normalizedOutput;
  }

  /**
   * Agentis-native skip propagation (NATIVE-ADVANCEMENT Proposal 3). A node that
   * can never receive its required inputs (an untaken branch's subtree) is
   * marked SKIPPED; since it will never complete, its outgoing edges will never
   * fire either, so we drop it from each downstream target's required inputs and
   * recursively skip any target that thereby becomes unreachable. This is the
   * "the silence is intentional and structural" behaviour without a Pulse table.
   */
  #skipUnreachable(ctx: RunningContext, nodeId: string, reason: string): void {
    const ns = ctx.state.nodeStates[nodeId];
    // Only skip nodes that haven't started/finished on another path.
    if (!ns || ns.status === 'COMPLETED' || ns.status === 'SKIPPED'
      || ns.status === 'RUNNING' || ns.status === 'WAITING') {
      return;
    }
    ns.status = 'SKIPPED';
    ns.completedAt = new Date().toISOString();
    if (!ctx.state.skippedNodeIds.includes(nodeId)) ctx.state.skippedNodeIds.push(nodeId);
    delete ctx.state.waitingInputs[nodeId];
    delete ctx.state.activeExecutions[nodeId];
    this.deps.logger.debug?.('engine.node.skipped', { runId: ctx.runId, nodeId, reason });
    for (const edge of ctx.downstreamEdges.get(nodeId) ?? []) {
      if (!ctx.state.waitingInputs[edge.target]) continue;
      ctx.state.waitingInputs[edge.target]!.requiredInputs =
        ctx.state.waitingInputs[edge.target]!.requiredInputs.filter((id) => id !== nodeId);
      this.#promoteOrSkipTarget(ctx, edge.target, reason);
    }
  }

  /**
   * Pause a node on a recoverable infrastructure failure (out of credits / model
   * billing). The node parks in WAITING with a `blockedReason`, the run settles to
   * WAITING, and the operator can fix the cause and `resumeBlockedRun` from here —
   * nothing is lost and the run never lies "running".
   */
  async #pauseNodeBlocked(ctx: RunningContext, nodeId: string, reason: string): Promise<void> {
    const ns = ctx.state.nodeStates[nodeId];
    if (!ns) return;
    delete ctx.state.activeExecutions[nodeId];
    ns.status = 'WAITING';
    ns.blockedReason = reason;
    this.deps.logger.warn('engine.node.paused_blocked', { runId: ctx.runId, nodeId, reason });
    await this.deps.ledger.append({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      runId: ctx.runId,
      eventType: 'node.failed',
      nodeId,
      payload: { error: reason, paused: true, recoverable: true },
    }).catch(() => {});
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_WAITING_FOR_INPUT, {
      runId: ctx.runId, nodeId, reason: 'blocked', detail: reason,
    });
    const node = ctx.graph.nodes.find((n) => n.id === nodeId);
    if (node) this.#emitWorkStep(ctx, node, 'fail', `Paused — ${reason}`);
    this.#audit(ctx, { nodeId, action: 'node.paused', actorType: 'system', actorId: 'engine', outputSummary: reason });
    // Persist node state (blockedReason) then set the run status column to WAITING.
    await this.#persistRun(ctx);
    await this.#transitionRunStatus(ctx, 'WAITING');
  }

  /**
   * Resume a run paused on a recoverable failure: every blocked node is reset to
   * PENDING and re-enqueued from its saved input, the run goes RUNNING, and the
   * dispatch loop re-enters — re-running exactly the node(s) that stalled. Rebuilds
   * the in-memory context if the run isn't resident (e.g. after a restart).
   */
  async resumeBlockedRun(runId: string): Promise<{ resumed: number }> {
    let ctx = this.#runs.get(runId);
    const persistedRun = this.deps.db.select({ status: schema.workflowRuns.status }).from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
    if (!ctx) {
      const rebuilt = this.#rebuildContextFromPersisted(runId);
      if (!rebuilt) return { resumed: 0 };
      this.#runs.set(runId, rebuilt);
      ctx = rebuilt;
    }
    // An operator pause aborts the previous run-scoped signal. A resumed run is
    // a fresh execution epoch and must not inherit that cancellation.
    if (persistedRun?.status === 'PAUSED' || persistedRun?.status === 'FAILED') ctx.abortController = new AbortController();
    let resumed = 0;
    for (const ns of Object.values(ctx.state.nodeStates)) {
      if (ns && ns.status === 'WAITING' && ns.blockedReason) {
        ns.status = 'PENDING';
        delete ns.blockedReason;
        ctx.state.readyQueue.push({
          nodeId: ns.nodeId,
          priority: 0,
          insertedAt: new Date().toISOString(),
          inputData: ns.inputData ?? {},
        });
        resumed += 1;
      }
    }
    if (resumed === 0 && persistedRun?.status === 'PAUSED' && ctx.state.readyQueue.length > 0) {
      resumed = ctx.state.readyQueue.length;
    }
    if (resumed === 0 && (persistedRun?.status === 'RUNNING' || persistedRun?.status === 'WAITING')) {
      const queued = new Set(ctx.state.readyQueue.map((item) => item.nodeId));
      const activeNodeIds = new Set(Object.keys(ctx.state.activeExecutions ?? {}));
      for (const ns of Object.values(ctx.state.nodeStates)) {
        if (!ns || (ns.status !== 'RUNNING' && ns.status !== 'WAITING')) continue;
        if (queued.has(ns.nodeId)) continue;
        ns.status = 'PENDING';
        delete ns.blockedReason;
        ctx.state.readyQueue.push({
          nodeId: ns.nodeId,
          priority: 0,
          insertedAt: new Date().toISOString(),
          inputData: ns.inputData ?? {},
        });
        resumed += 1;
      }
      for (const nodeId of activeNodeIds) delete ctx.state.activeExecutions[nodeId];
    }
    if (resumed === 0 && persistedRun?.status === 'FAILED') {
      const queued = new Set(ctx.state.readyQueue.map((item) => item.nodeId));
      const activeNodeIds = new Set(Object.keys(ctx.state.activeExecutions ?? {}));
      for (const ns of Object.values(ctx.state.nodeStates)) {
        if (!ns || ns.status !== 'FAILED' || queued.has(ns.nodeId)) continue;
        ns.status = 'PENDING';
        delete ns.blockedReason;
        delete ns.error;
        ctx.state.readyQueue.push({
          nodeId: ns.nodeId,
          priority: 0,
          insertedAt: new Date().toISOString(),
          inputData: ns.inputData ?? {},
        });
        resumed += 1;
      }
      for (const nodeId of activeNodeIds) delete ctx.state.activeExecutions[nodeId];
    }
    if (resumed === 0) return { resumed: 0 };
    await this.#transitionRunStatus(ctx, 'RUNNING');
    void this.#tick(ctx);
    return { resumed };
  }

  /** Rebuild a RunningContext from a persisted run row (resume after restart). */
  #rebuildContextFromPersisted(runId: string): RunningContext | null {
    const run = this.deps.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
    if (!run || !run.workflowId) return null;
    const state = run.runState as unknown as WorkflowRunState | null;
    if (!state) return null;
    try {
      const graph = (run.graphSnapshot as WorkflowGraph | null) ?? this.#loadWorkflowGraph(run.workflowId);
      return {
        runId: run.id,
        workflowId: run.workflowId,
        planId: this.deps.plans?.findByRun(run.workspaceId, run.id)?.id ?? null,
        workspaceId: run.workspaceId,
        ambientId: run.ambientId,
        conversationId: run.conversationId ?? null,
        userId: run.userId,
        workflowRevisionId: run.workflowRevisionId ?? null,
        repairedFromRevisionId: run.repairedFromRevisionId ?? null,
        graph,
        downstreamEdges: buildDownstreamEdges(graph),
        state,
        eventsSinceSnapshot: 0,
        inflightDispatches: 0,
        swarms: new Map(),
        selfHealAttempts: hydrateSelfHealAttempts(state),
        nodeDispatchCounts: new Map(
          Object.values(state.nodeStates)
            .filter((nodeState): nodeState is NonNullable<typeof nodeState> => Boolean(nodeState))
            .map((nodeState) => [nodeState.nodeId, nodeState.attempt ?? 0]),
        ),
        abortController: new AbortController(),
      };
    } catch (err) {
      this.deps.logger.warn('engine.resume.rebuild_failed', { runId, err: (err as Error).message });
      return null;
    }
  }

  async #failNode(ctx: RunningContext, nodeId: string, error: string): Promise<void> {
    // A cancellation is terminal intent, not a failure to self-heal, retry, or
    // route through an error edge. Ignore late executor rejections for the same
    // reason we ignore late completions above.
    if (ctx.cancellationRequested || isTerminalRunStatus(ctx.state.status)) return;
    const ns = ctx.state.nodeStates[nodeId];
    if (!ns) return;
    // Recoverable infrastructure failure (model out of credits / billing): do NOT
    // fail the run — PAUSE this node so the operator can add credits or switch the
    // model and resume from exactly here. Takes precedence over error-edge routing
    // (a catch branch can't fix "no credits"). This is the fix for runs that used
    // to either hang as "running" forever or fail opaquely on an out-of-credits model.
    const node = ctx.graph.nodes.find((candidate) => candidate.id === nodeId);
    error = contextualizeNodeFailure(error, node);
    const classification = classifyWorkflowFailure(error);
    if (node && this.deps.workflowExperience) {
      try {
        const workflow = this.deps.db.select({ appId: schema.workflows.appId })
          .from(schema.workflows)
          .where(and(eq(schema.workflows.id, ctx.workflowId), eq(schema.workflows.workspaceId, ctx.workspaceId)))
          .get();
        const revisionKey = ctx.workflowRevisionId ?? graphContentHash(ctx.graph);
        this.deps.workflowExperience.recordFailureObservation({
          context: {
            workspaceId: ctx.workspaceId,
            workflowId: ctx.workflowId,
            appId: workflow?.appId ?? null,
            agentId: (node.config as { agentId?: string }).agentId ?? null,
          },
          revisionId: ctx.workflowRevisionId ?? null,
          node,
          error,
          fingerprint: workflowFailureFingerprint({ classification, revisionKey, node, error }),
          classification,
          runId: ctx.runId,
          inputs: ns.inputData,
        });
      } catch (recordError) {
        this.deps.logger.warn('engine.workflow_failure_observation.failed', {
          runId: ctx.runId,
          nodeId,
          error: (recordError as Error).message,
        });
      }
    }
    const recoverableModelFailure = isRecoverableModelError(error);
    // Organ 4 — failure taxonomy: a RESOURCE failure on an AGENT node (rate/usage
    // limit, quota, auth/captcha wall, transient 5xx/network) is NOT a logic bug.
    // Quarantine the node (pause with a blocker) BEFORE self-heal can edit its logic
    // — so a rate-limited scout is never "fixed" by rewriting or deleting it. Scoped
    // to agent nodes so non-agent kinds keep their own retryPolicy / fail semantics.
    const isAgentNodeFailure = node?.config.kind === 'agent_task' || node?.config.kind === 'agent_session';
    if (isAgentNodeFailure && isResourceFailure(error)) {
      await this.#pauseNodeBlocked(ctx, nodeId, resourceBlockerReason(error));
      return;
    }
    // Organ 4 — POLICY class: a deliberate gate throw (`BLOCKED_*`) is the
    // workflow WORKING AS INTENDED (an approval/policy boundary refusing to
    // pass). It is not a bug: never run the self-heal ladder or retries on it
    // — the "repair" a healer derives for an approval gate is always wrong.
    // Error-edge routing below still applies (a graph may catch the block).
    const policyBlock = classification.category === 'human_policy'
      || classification.category === 'expected_business'
      || isPolicyBlockError(error);
    const runtimeBindingFailure = Boolean(node && isRuntimeBindingFailure(error));
    if (!isSelfHealTerminalError(error) && !policyBlock && (classification.graphRepairEligible || runtimeBindingFailure)) {
      if (node && isSelfHealableNode(node)) {
        const heal = await this.#selfHeal.runSelfHeal(ctx, node, {}, error);
        if (heal.kind === 'structural_applied' || heal.kind === 'awaiting_approval') return;
        if (heal.kind === 'output_fixed') {
          try {
            delete ctx.state.activeExecutions[nodeId];
            const completedOutput = await this.#completeNode(ctx, nodeId, heal.output);
            if (completedOutput) {
              void this.#tick(ctx);
              return;
            }
          } catch (err) {
            error = selfHealFailureMessage((err as Error).message, {
              kind: 'none',
              reason: 'Recovered output could not satisfy the node contract after self-healing.',
            });
          }
        } else if (heal.reason) {
          error = selfHealFailureMessage(error, heal);
        }
      }
    }
    if (recoverableModelFailure) {
      await this.#pauseNodeBlocked(ctx, nodeId, friendlyBlockedReason(error));
      return;
    }
    if (!isSelfHealTerminalError(error) && !policyBlock && node?.config.kind === 'agent_task') {
      const retried = await this.#selfHeal.tryLegacyAgentTaskSelfHealRetry(ctx, node, error);
      if (retried) return;
    }
    if (node?.config.kind === 'agent_task') {
      this.#selfHeal.reflectHardNodeFailure(ctx, node, error);
    }
    // Learn from EVERY hard node failure (any kind) — "fail-forward, don't
    // dead-end". The wiring keeps only instructive failures (guard / precondition
    // / validation / contract) as a workspace playbook lesson, which build_workflow
    // already recalls so the next build wires a corrective loop instead of a hard
    // stop. Must never break the failure path.
    if (node && classification.learnerEligible && this.deps.recordFailureLesson) {
      try {
        this.deps.recordFailureLesson({
          workspaceId: ctx.workspaceId,
          workflowId: ctx.workflowId,
          nodeId: node.id,
          nodeTitle: node.title,
          error,
          agentId: (node.config as { agentId?: string }).agentId ?? null,
        });
      } catch (err) {
        this.deps.logger.warn('engine.failure_lesson.failed', { runId: ctx.runId, nodeId: node.id, err: (err as Error).message });
      }
    }
    // Generic per-node retryPolicy: bounded re-dispatch of transient IO /
    // deterministic failures BEFORE error-edge routing, so any non-agent node
    // gets the resilience that previously only agent_task had. Agent-like kinds
    // are excluded (they use self-heal / AgentRetryPolicy above).
    if (node && !policyBlock && this.#shouldGenericRetry(node, error)) {
      const attempts = this.#nodeRetryAttempts(ctx);
      const prior = attempts.get(nodeId) ?? 0;
      const cap = Math.min(Math.max(node.retryPolicy!.maxAttempts, 0), 10);
      if (prior < cap) {
        const attempt = prior + 1;
        attempts.set(nodeId, attempt);
        const base = node.retryPolicy!.backoffMs && node.retryPolicy!.backoffMs > 0 ? node.retryPolicy!.backoffMs : 1000;
        const delay = Math.min(base * 2 ** (attempt - 1), 60_000);
        const inputData = ns.inputData ?? {};
        // Hold the run open during the backoff — a synthetic execution keeps the
        // settle loop from marking the run done while the retry timer is pending.
        delete ctx.state.activeExecutions[nodeId];
        ctx.state.activeExecutions[nodeId] = {
          taskId: `retry:${nodeId}`,
          nodeId,
          executorType: 'wait',
          executorRef: `retry:${attempt}/${cap}`,
          startedAt: new Date().toISOString(),
        };
        ns.status = 'WAITING';
        this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_RETRY_SCHEDULED, {
          runId: ctx.runId,
          nodeId,
          attempt,
          reason: 'retry_policy',
        });
        await this.#persistRun(ctx).catch(() => {});
        const timer = setTimeout(() => {
          delete ctx.state.activeExecutions[nodeId];
          void (async () => {
            try {
              await this.#dispatchNode(ctx, node, { nodeId, priority: 0, insertedAt: new Date().toISOString(), inputData });
            } catch (err) {
              await this.#failNode(ctx, nodeId, (err as Error).message);
            }
            void this.#tick(ctx);
          })();
        }, delay);
        timer.unref?.();
        return; // retrying — do not route the error / fail the node yet
      }
    }
    delete ctx.state.activeExecutions[nodeId];

    // ── Error-edge routing (must happen BEFORE we mark the node as FAILED
    //    or push to failedNodeIds). When a connected error edge exists, the
    //    failure is "handled" — the catch branch runs and the node is
    //    treated as COMPLETED-with-error for settle purposes. This ordering
    //    matters because #tick() can re-enter from another path between
    //    `void this.#failNode()` and its first await, and would see the
    //    failed state and transition the run to FAILED.
    const downstream = ctx.downstreamEdges.get(nodeId) ?? [];
    const errorEdges = downstream.filter((e) => e.type === 'error');
    // PARALLEL onBranchError='continue_with_results': a failed branch that feeds a
    // merge whose resolved policy is `continue` is ABSORBED — the merge proceeds
    // with the surviving branches instead of the whole run failing. We treat such
    // a continue-merge edge exactly like an implicit error (catch) edge: it
    // receives the failed branch's error payload and the run carries on.
    const continueEdges = downstream.filter(
      (e) => e.type !== 'error'
        && this.#resolveJoinPolicy(ctx, ctx.graph.nodes.find((n) => n.id === e.target)).onError === 'continue',
    );
    const handledEdges = [...errorEdges, ...continueEdges];
    if (handledEdges.length > 0) {
      const handledIds = new Set(handledEdges.map((e) => e.id));
      const viaContinueOnly = errorEdges.length === 0;
      const errorPayload = {
        ...(ns.inputData ?? {}),
        error: {
          nodeId,
          message: error,
          at: new Date().toISOString(),
        },
      };
      // Mark as completed (not failed) — the failure was handled (catch branch
      // or a continue-on-error merge).
      ns.status = 'COMPLETED';
      ns.completedAt = new Date().toISOString();
      ns.error = error;        // keep the error for debugging
      ns.outputData = errorPayload;
      if (!ctx.state.completedNodeIds.includes(nodeId)) ctx.state.completedNodeIds.push(nodeId);

      for (const edge of handledEdges) {
        const buf = ctx.state.waitingInputs[edge.target];
        if (!buf) continue;
        buf.receivedInputs[nodeId] = errorPayload;
        buf.requiredInputs = buf.requiredInputs.filter((id) => id !== nodeId);
        this.#promoteOrSkipTarget(ctx, edge.target, 'Skipped: upstream path never produced an input');
      }

      // The failure was handled, so the node's remaining (non-handled) SUCCESS
      // edges will NEVER deliver. Drop them from downstream targets and
      // skip-cascade any that thereby become unreachable — otherwise the success
      // branch hangs and the whole run sits in WAITING forever (the "stuck on
      // Pending" UX). Mirrors the conditional skip in #completeNode (Proposal 3).
      for (const edge of downstream.filter((e) => e.type !== 'error' && !handledIds.has(e.id))) {
        if (!ctx.state.waitingInputs[edge.target]) continue;
        ctx.state.waitingInputs[edge.target]!.requiredInputs =
          ctx.state.waitingInputs[edge.target]!.requiredInputs.filter((id) => id !== nodeId);
        this.#promoteOrSkipTarget(ctx, edge.target, 'Skipped: the upstream step failed and was handled');
      }

      // Emit an explanatory ledger event + bus event so observers still see
      // the failure even though the run continues.
      await this.deps.ledger.append({
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId,
        runId: ctx.runId,
        eventType: 'node.failed',
        nodeId,
        payload: { error, handledBy: viaContinueOnly ? 'parallel_continue' : 'error_edge' },
      });
      this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_FAILED, {
        runId: ctx.runId,
        nodeId,
        error,
        handledByErrorEdge: !viaContinueOnly,
      });
      const failedNode = ctx.graph.nodes.find((n) => n.id === nodeId);
      if (failedNode) this.#emitWorkStep(ctx, failedNode, 'fail', error);
      this.#audit(ctx, { nodeId, action: 'node.failed', actorType: 'system', actorId: 'engine', outputSummary: `${viaContinueOnly ? 'absorbed by continue-on-error merge' : 'handled by error edge'}: ${error}` });
      await this.#persistRun(ctx);
      return;
    }

    // No error edge wired — terminal failure for the node + the run.
    ns.status = 'FAILED';
    ns.completedAt = new Date().toISOString();
    ns.error = error;
    delete ns.blockedReason;
    if (!ctx.state.failedNodeIds.includes(nodeId)) ctx.state.failedNodeIds.push(nodeId);

    await this.deps.ledger.append({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      runId: ctx.runId,
      eventType: 'node.failed',
      nodeId,
      payload: { error },
    });
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_FAILED, {
      runId: ctx.runId,
      nodeId,
      error,
    });
    const failedNode = ctx.graph.nodes.find((n) => n.id === nodeId);
    if (failedNode) this.#emitWorkStep(ctx, failedNode, 'fail', error);
    this.#audit(ctx, { nodeId, action: 'node.failed', actorType: 'system', actorId: 'engine', outputSummary: error });
    await this.#persistRun(ctx);
    if (ctx.state.status === 'PAUSED' && hasTerminalSelfHealFailure(ctx.state)) {
      this.#skipBlockedNodes(ctx, 'Skipped because self-healing reached a terminal blocker');
      await this.#transitionRunStatus(ctx, 'FAILED');
      this.#disposeRunState(ctx.runId);
    }
  }

  /**
   * Build the template-resolver context snapshot for the current dispatch.
   *
   * Captured once per node so the resolver sees a consistent view even if
   * other nodes complete concurrently. The `nodes` map is keyed by node id;
   * we expose the `outputData` directly so `{{nodes.foo.bar}}` matches the
   * user's intuition about node outputs.
   */
  #buildTemplateContext(ctx: RunningContext, item: ReadyQueueItem, loop?: { item: unknown; index: number }): TemplateContext {
    const nodeOutputs: Record<string, Record<string, unknown>> = {};
    for (const [id, ns] of Object.entries(ctx.state.nodeStates)) {
      if (ns.outputData) nodeOutputs[id] = ns.outputData as Record<string, unknown>;
    }
    // The trigger inputs are whatever the run was started with — the first
    // queued item's inputData on the trigger node carries them.
    const triggerNode = ctx.graph.nodes.find((n) => n.type === 'trigger');
    const triggerInputs = (triggerNode && ctx.state.nodeStates[triggerNode.id]?.inputData) as
      | Record<string, unknown>
      | undefined;
    const scratchpadSnap = this.deps.scratchpad.snapshotOf(ctx.runId);
    // Workflow-store snapshot — empty when the service isn't wired or workflowId is missing.
    const storeSnap = this.deps.workflowStore && ctx.workflowId
      ? this.deps.workflowStore.snapshot(ctx.workspaceId, ctx.workflowId)
      : {};
    // Workspace-store (Tier 3) snapshot — powers `{{workspace.kv.*}}`.
    const workspaceKvSnap = this.deps.workspaceStore
      ? this.deps.workspaceStore.snapshot(ctx.workspaceId)
      : {};
    return buildTemplateContext({
      inputData: item.inputData ?? {},
      triggerInputs: triggerInputs ?? item.inputData ?? {},
      nodeOutputs,
      graphNodes: ctx.graph.nodes,
      scratchpad: scratchpadSnap,
      store: storeSnap,
      workspace: { id: ctx.workspaceId, kv: workspaceKvSnap },
      run: { id: ctx.runId, startedAt: ctx.startedAt },
      loop,
    });
  }

  /**
   * P0.1 (WORKFLOW-BUILD-LOOP): the UNIFIED condition scope. Router branches,
   * edge conditions, and the build-time validator (`assertConditionSyntax`) must
   * see the same variables with the same meaning, or a condition that lints
   * clean silently evaluates against `undefined` at runtime. The base carries
   * the expensive snapshots (real per-id `nodes`, real `trigger`, plus
   * scratchpad/store/workspace/run); `withCurrentData` layers the current value.
   */
  #buildConditionScopeBase(ctx: RunningContext): Record<string, unknown> {
    const nodeOutputs: Record<string, Record<string, unknown>> = {};
    for (const [id, ns] of Object.entries(ctx.state.nodeStates)) {
      if (ns.outputData) nodeOutputs[id] = ns.outputData as Record<string, unknown>;
    }
    // Same readable-slug aliasing as buildTemplateContext, so a condition like
    // `nodes.qualified_lead.status === 'ok'` resolves identically to the raw id.
    for (const [slug, id] of Object.entries(buildNodeAliasMap(ctx.graph.nodes))) {
      if (nodeOutputs[id] !== undefined) nodeOutputs[slug] = nodeOutputs[id]!;
    }
    const triggerNode = ctx.graph.nodes.find((n) => n.type === 'trigger');
    const triggerInputs = (triggerNode && ctx.state.nodeStates[triggerNode.id]?.inputData) as
      | Record<string, unknown>
      | undefined;
    const storeSnap = this.deps.workflowStore && ctx.workflowId
      ? this.deps.workflowStore.snapshot(ctx.workspaceId, ctx.workflowId)
      : {};
    const workspaceKvSnap = this.deps.workspaceStore
      ? this.deps.workspaceStore.snapshot(ctx.workspaceId)
      : {};
    return {
      trigger: triggerInputs ?? {},
      nodes: nodeOutputs,
      scratchpad: this.deps.scratchpad.snapshotOf(ctx.runId),
      store: storeSnap,
      workspace: { id: ctx.workspaceId, kv: workspaceKvSnap },
      run: { id: ctx.runId, startedAt: ctx.startedAt },
    };
  }

  /** Full condition scope with `input`/`inputs`/`output` aliased to `currentData`. */
  #buildConditionScope(ctx: RunningContext, currentData: Record<string, unknown>): Record<string, unknown> {
    return withCurrentData(this.#buildConditionScopeBase(ctx), currentData);
  }

  #skipBlockedNodes(ctx: RunningContext, reason: string): void {
    markOpenNodesSkipped(ctx.state, reason);
  }

  async #cancelPersistedRun(runId: string): Promise<void> {
    const run = await this.deps.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .get();
    if (!run || isTerminalRunStatus(run.status)) return;

    // A waiting session can outlive this engine process. Cancelling its durable
    // run must fence that row too, otherwise restart recovery can wake it later.
    this.deps.sessions?.failRunSessions(runId, 'Run cancelled');

    const state = run.runState as unknown as WorkflowRunState | null;
    if (state) {
      state.status = 'CANCELLED';
      markOpenNodesSkipped(state, 'Run cancelled');
    }
    const now = new Date().toISOString();
    await this.deps.db
      .update(schema.workflowRuns)
      .set({
        status: 'CANCELLED',
        executionStatus: 'cancelled',
        outcomeStatus: 'blocked',
        runState: (state ?? run.runState) as unknown as object,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.workflowRuns.id, runId));
    const payload = { runId, status: 'CANCELLED', workflowId: run.workflowId, workspaceId: run.workspaceId };
    this.deps.bus.publish(REALTIME_ROOMS.run(runId), REALTIME_EVENTS.RUN_CANCELLED, payload);
    this.deps.bus.publish(REALTIME_ROOMS.workspace(run.workspaceId), REALTIME_EVENTS.RUN_CANCELLED, payload);
  }

  async #pausePersistedRun(runId: string): Promise<void> {
    const run = await this.deps.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
    if (!run || isTerminalRunStatus(run.status)) return;
    const state = run.runState as unknown as WorkflowRunState | null;
    if (state && hasTerminalSelfHealFailure(state)) {
      markOpenNodesSkipped(state, 'Skipped because self-healing reached a terminal blocker');
      state.status = 'FAILED';
      const now = new Date().toISOString();
      await this.deps.db.update(schema.workflowRuns).set({
        status: 'FAILED', executionStatus: 'failed', outcomeStatus: 'not_accomplished', runState: state as unknown as object, completedAt: now, updatedAt: now,
      }).where(eq(schema.workflowRuns.id, runId));
      const payload = { runId, status: 'FAILED', workflowId: run.workflowId, workspaceId: run.workspaceId };
      this.deps.bus.publish(REALTIME_ROOMS.run(runId), REALTIME_EVENTS.RUN_FAILED, payload);
      this.deps.bus.publish(REALTIME_ROOMS.workspace(run.workspaceId), REALTIME_EVENTS.RUN_FAILED, payload);
      return;
    }
    if (run.status === 'PAUSED') return;
    if (state) {
      state.status = 'PAUSED';
      for (const node of Object.values(state.nodeStates)) {
        if (node?.status === 'RUNNING') {
          node.status = 'WAITING';
          node.blockedReason = 'Paused by operator';
        }
      }
      state.activeExecutions = {};
    }
    const now = new Date().toISOString();
    await this.deps.db.update(schema.workflowRuns).set({
      status: 'PAUSED', executionStatus: 'waiting', outcomeStatus: 'unverified', runState: (state ?? run.runState) as unknown as object, updatedAt: now,
    }).where(eq(schema.workflowRuns.id, runId));
    const payload = { runId, status: 'PAUSED', workflowId: run.workflowId, workspaceId: run.workspaceId };
    this.deps.bus.publish(REALTIME_ROOMS.run(runId), REALTIME_EVENTS.RUN_PAUSED, payload);
    this.deps.bus.publish(REALTIME_ROOMS.workspace(run.workspaceId), REALTIME_EVENTS.RUN_PAUSED, payload);
  }

  /**
   * Publish a human-readable AGENT_WORK_STEP to the workspace room so the
   * canvas Live feed can attribute work to a named agent in real time.
   * NODE_* events stay run-scoped and id-only; this is the agent-facing layer.
   */
  #emitWorkStep(
    ctx: RunningContext,
    node: WorkflowNode,
    phase: 'start' | 'complete' | 'fail' | 'thinking',
    detail?: string,
  ): void {
    const config = node.config as { kind?: string; agentId?: string | null };
    const agentId =
      config.kind === 'agent_task' || config.kind === 'agent_swarm'
        ? config.agentId ?? null
        : null;
    let agentName: string | undefined;
    if (agentId) {
      const row = this.deps.db
        .select({ name: schema.agents.name })
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId))
        .get();
      agentName = row?.name;
    }
    const description =
      phase === 'start'
        ? node.title
        : phase === 'complete'
          ? `Completed ${node.title}`
          : phase === 'thinking'
            // NOT "Repairing" — this phase is emitted by every agent_task's live
            // reasoning relay, not just self-heal. `detail` carries the real
            // thought and wins in the frontend normalizer; this is the fallback.
            ? `Working on ${node.title}`
          : `Failed at ${node.title}`;
    const workStepPayload = {
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      workflowId: ctx.workflowId,
      nodeId: node.id,
      agentId,
      agentName,
      step: config.kind ?? 'node',
      phase,
      description,
      detail,
      progress: {
        done: ctx.state.completedNodeIds.length,
        total: ctx.graph.nodes.length,
      },
    };
    this.deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), REALTIME_EVENTS.AGENT_WORK_STEP, workStepPayload);
    this.#appendActivityTail(ctx.runId, REALTIME_EVENTS.AGENT_WORK_STEP, workStepPayload);
  }

  /**
   * Publish a delegate child's lifecycle as an AGENT_WORK_STEP so the Live
   * Workspace panel can render it under the parent session (same runId).
   * Mirrors #emitWorkStep's payload shape but for a synthetic delegate "node"
   * that has no WorkflowNode — agentId/agentName are the CHILD's, not the
   * parent's. #runDelegate has no WorkflowNode for the child, so this can't
   * reuse #emitWorkStep directly.
   */
  #emitDelegateStep(
    ctx: RunningContext,
    args: {
      nodeId: string;
      childSessionId: string;
      parentSessionId: string;
      agentId: string;
      role: string;
      phase: 'start' | 'complete' | 'fail';
      description: string;
    },
  ): void {
    const workStepPayload = {
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      workflowId: ctx.workflowId,
      nodeId: args.nodeId,
      agentId: args.agentId,
      agentName: this.#agentName(args.agentId),
      step: 'delegate',
      phase: args.phase,
      description: args.description,
      detail: args.description,
      delegate: true,
      role: args.role,
      parentSessionId: args.parentSessionId,
      childSessionId: args.childSessionId,
    };
    this.deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), REALTIME_EVENTS.AGENT_WORK_STEP, workStepPayload);
    this.#appendActivityTail(ctx.runId, REALTIME_EVENTS.AGENT_WORK_STEP, workStepPayload);
  }

  /**
   * Run-level self-heal. The run completed every reachable node but produced NO
   * terminal output — a routing DEAD-END (classically: a gate's `fail`/reject
   * verdict whose only wired path is an error-catch that never fires, so every
   * return node is skipped). Node-level self-heal never sees this because no node
   * FAILED. With self-heal on, "every workflow must run", so we engage the
   * orchestrator to repair the routing and resume to a real terminal output —
   * reusing the exact node-level ladder (deep replan → finalize → validate →
   * certify → resume → bounded escalation). Returns true when a repair is
   * applied/queued (the run continues or pauses instead of failing).
   */
  async #healRunDeadEnd(ctx: RunningContext): Promise<boolean> {
    if (!this.deps.selfHeal) return false;
    let cfg: SelfHealConfig;
    try { cfg = getSelfHealConfig(this.deps.db, ctx.workspaceId); } catch { return false; }
    if (!cfg.enabled) return false;
    // Anchor the repair on the last completed decision node (the branch point that
    // dead-ended); the orchestrator gets the whole graph and chooses the resume
    // node (typically the skipped return node for this outcome).
    const anchorId = ctx.state.completedNodeIds.at(-1);
    const node = anchorId ? ctx.graph.nodes.find((n) => n.id === anchorId) : undefined;
    if (!node || !isSelfHealableNode(node)) return false;
    this.deps.logger.info('engine.self_heal.run_dead_end', { runId: ctx.runId, anchorNodeId: node.id });
    const heal = await this.#selfHeal.runSelfHeal(
      ctx,
      node,
      {},
      'Workflow reached no declared terminal output; every output path was skipped — a branch outcome (e.g. a gate "fail"/reject verdict) has no wired path to a return/terminal node. Repair the routing so this outcome reaches a terminal output node, preserving intent.',
    );
    return heal.kind === 'structural_applied' || heal.kind === 'awaiting_approval';
  }

  async #transitionRunStatus(ctx: RunningContext, status: WorkflowRunStatus): Promise<void> {
    if (ctx.state.status === status) return;
    // Do not let a late asynchronous executor overwrite a terminal settlement.
    // CANCELLED is the only permitted transition once an operator has requested
    // cancellation, even while adapter shutdown is still in progress.
    if (isTerminalRunStatus(ctx.state.status)) {
      this.deps.logger.debug('engine.run.transition_ignored_terminal', {
        runId: ctx.runId,
        current: ctx.state.status,
        requested: status,
      });
      return;
    }
    if (ctx.cancellationRequested && status !== 'CANCELLED') return;

    // Output contract enforcement: a run transitioning to COMPLETED must match
    // the workflow's declared `outputContract` (when set). Mismatches downgrade
    // to COMPLETED_WITH_CONTRACT_VIOLATION so operators see the problem on the
    // canvas instead of silently shipping bad data. Brain evaluation reuses
    // this path when validating typed workflow output.
    // A node that errored — even one "handled" by an error/catch edge (it ends
    // COMPLETED but carries `ns.error`) — means the run did NOT cleanly succeed.
    // Report it honestly as COMPLETED_WITH_ERRORS instead of a green
    // "ran successfully", so the operator sees it and auto-diagnosis fires.
    if (status === 'COMPLETED') {
      const errored = Object.values(ctx.state.nodeStates).some((n) => Boolean(n?.error) && n?.status === 'COMPLETED');
      if (errored) status = 'COMPLETED_WITH_ERRORS';
    }

    if (status === 'COMPLETED') {
      const deviations = Object.values(ctx.state.nodeStates)
        .map((n) => n.contractDeviation)
        .filter((d): d is WorkflowNodeContractDeviation => Boolean(d));
      if (deviations.length > 0) {
        status = 'COMPLETED_WITH_CONTRACT_VIOLATION';
        (ctx.state as unknown as { contractViolations?: string[] }).contractViolations = deviations.map((d) => d.message);
      }
    }

    if (status === 'COMPLETED') {
      // Branches may intentionally skip alternate work, but an explicit output
      // workflow has not succeeded until at least one of its terminal outputs
      // actually ran. This prevents an untaken success branch plus an error-only
      // failure branch from becoming a green run with no result.
      const declaredOutputs = ctx.graph.nodes.filter((node) => {
        const config = node.config as { kind?: string; isOutput?: boolean };
        return config.kind === 'return_output' || config.isOutput === true;
      });
      if (declaredOutputs.length > 0 && !declaredOutputs.some((node) => ctx.state.nodeStates[node.id]?.status === 'COMPLETED')) {
        // A run-level dead-end is a self-heal trigger too: with self-heal on, the
        // orchestrator repairs the routing and resumes to a real terminal output
        // instead of the run silently failing. Only when it can't do we finalize
        // as errored (and the operator gets the "send to Agentis team" path).
        if (await this.#healRunDeadEnd(ctx)) return;
        status = 'COMPLETED_WITH_ERRORS';
        const reason = 'Workflow reached no declared terminal output; every output path was skipped.';
        (ctx.state as unknown as { completionFailure?: string }).completionFailure = reason;
        this.deps.logger.warn('engine.run.no_terminal_output', { runId: ctx.runId, outputNodeIds: declaredOutputs.map((node) => node.id) });
      }
    }

    if (status === 'COMPLETED') {
      const contract = (ctx.graph as { outputContract?: { fields?: Array<{ key: string; type: string; required?: boolean }> } }).outputContract;
      if (contract?.fields && contract.fields.length > 0) {
        const finalOutput = unwrapReturnEnvelope(this.#collectFinalOutput(ctx));
        const violations = validateAgainstContract(finalOutput, contract.fields);
        if (violations.length > 0) {
          this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.CONTRACT_VIOLATION, {
            runId: ctx.runId,
            violations,
          });
          status = 'COMPLETED_WITH_CONTRACT_VIOLATION';
          // Persist the violations alongside the run state for the Output tab.
          (ctx.state as unknown as { contractViolations?: string[] }).contractViolations = violations;
        }
      }
    }

    // ── SWIFT layer 3 — the run verdict (SWIFT-WORKFLOW-QUALITY-10X §2-T). ──
    // COMPLETED is a topology fact; ACCOMPLISHED is a world fact. When the
    // workflow carries a spec, every completed run is verified against the
    // WORLD (probes + judge, never the run's self-report) and the verdict is
    // stamped into runState. A deficient PRODUCTION run gets one bounded
    // outcome-heal attempt (deficiency-driven re-work of the producing node);
    // a debug run surfaces the deficiencies raw for the iterating agent.
    let runVerdict: RunVerdict | null = null;
    if (status === 'COMPLETED' || status === 'COMPLETED_WITH_CONTRACT_VIOLATION' || status === 'COMPLETED_WITH_ERRORS') {
      const spec = this.#specForRun(ctx);
      if (spec) {
        runVerdict = await this.#evaluateVerdict(ctx, spec);
        if (runVerdict) {
          (ctx.state as unknown as { verdict?: RunVerdict }).verdict = runVerdict;
          if (runVerdict.outcome !== 'accomplished' && await this.#healDeficientOutcome(ctx, spec, runVerdict)) {
            return; // re-work applied — the run resumes; the next settle re-verifies.
          }
        }
      }
    }

    const previous = ctx.state.status;
    ctx.state.status = status;
    const finishing = status === 'COMPLETED'
      || status === 'COMPLETED_WITH_CONTRACT_VIOLATION'
      || status === 'COMPLETED_WITH_ERRORS'
      || status === 'FAILED'
      || status === 'CANCELLED';
    // This IS the durable status write; a pending coalesced flush would only
    // race it with a staler snapshot, so drop it first.
    this.#cancelPendingPersist(ctx.runId);
    const persistedState = toPersistedRunState(ctx.state);
    const settledAt = finishing ? new Date().toISOString() : null;
    const settlement = buildRunSettlement({
      status,
      runState: persistedState,
      revisionId: ctx.workflowRevisionId ?? null,
      semanticHash: graphContentHash(ctx.graph),
      settledAt,
    });
    await this.deps.db
      .update(schema.workflowRuns)
      .set({
        status,
        runState: persistedState,
        executionStatus: settlement.executionStatus,
        outcomeStatus: settlement.outcomeStatus,
        settlement,
        ...(status === 'RUNNING' && !ctx.startedAt
          ? { startedAt: new Date().toISOString() }
          : {}),
        ...(finishing ? { completedAt: settledAt! } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workflowRuns.id, ctx.runId));
    if (finishing) {
      await this.#recordRevisionOutcome(ctx, status, runVerdict).catch((error) => {
        this.deps.logger.warn('workflow.revision.outcome_failed', {
          runId: ctx.runId,
          workflowId: ctx.workflowId,
          error: (error as Error).message,
        });
      });
    }
    // A finished run's periodic recovery snapshots are dead weight — they exist
    // only to cold-resume an in-flight run and are never read once terminal.
    if (finishing) {
      try {
        this.deps.db.delete(schema.workflowRunSnapshots).where(eq(schema.workflowRunSnapshots.runId, ctx.runId)).run();
      } catch (err) {
        this.deps.logger.warn('engine.snapshot.cleanup_failed', { runId: ctx.runId, err: (err as Error).message });
      }
    }

    // Finalize all internal bookkeeping (terminal conversation message,
    // subflow parent notification) BEFORE we publish the terminal event.
    // External observers (schedulers, tests, the activity feed) treat
    // RUN_COMPLETED / RUN_FAILED / RUN_CANCELLED as the "everything is done"
    // signal — so any further work performed after the publish would race.
    if (finishing && previous !== status) {
      if (ctx.planId && this.deps.plans) {
        const nextPlanStatus = status === 'COMPLETED' ? 'completed'
          : status === 'FAILED' || status === 'CANCELLED' || status === 'COMPLETED_WITH_ERRORS' || status === 'COMPLETED_WITH_CONTRACT_VIOLATION'
            ? 'failed'
            : null;
        if (nextPlanStatus) this.deps.plans.setStatus(ctx.workspaceId, ctx.userId, ctx.planId, nextPlanStatus);
      }
      this.#clearPhaseTimers(ctx);
      await this.#appendTerminalConversationMessage(ctx, status);
      this.#audit(ctx, {
        action: `run.${status.toLowerCase()}`,
        actorType: 'system',
        actorId: 'engine',
        outputSummary: `${ctx.state.completedNodeIds.length} completed, ${ctx.state.failedNodeIds.length} failed`,
      });
      // Close any persistent browser sessions this run opened — a session must
      // never outlive its run (the idle reaper is only a backstop). Best-effort;
      // fires for every terminal status including CANCELLED.
      void this.deps.browserSessions?.closeOwner({ kind: 'run', id: ctx.runId });
      // Self-improvement: after a failure, look for a repeat pattern (§7.2).
      if ((status === 'FAILED' || status === 'COMPLETED_WITH_ERRORS') && this.deps.instincts) {
        void this.deps.instincts.onRunFailed({
          workspaceId: ctx.workspaceId,
          workflowId: ctx.workflowId,
          runId: ctx.runId,
          state: ctx.state,
          // PAVED-ROAD P4 — the Sentinel files Issues only for production runs;
          // a debug run's failure is the building agent's business, not backlog.
          debugRun: this.#debugRuns.has(ctx.runId),
          userId: ctx.userId,
        });
      }
      // The run's graded outcome becomes durable memory in the scope that owns it
      // (the App, else the workflow) — this is what fills an App's Brain. A debug
      // run proves nothing about the App, so it never forms memory.
      if (this.deps.appBrain && !this.#debugRuns.has(ctx.runId)) {
        void this.deps.appBrain.onRunSettled(this.#runSettledInput(ctx, status, runVerdict));
      }
      // PAVED-ROAD P1 — close the build loop on the workflow row: a debug run
      // stamps debugRun evidence, a production run stamps productionRun, both
      // keyed to the current graph hash so a later edit stales them. This is
      // what lets loop_status / the compass answer "was this graph ever proven
      // by a real run?" without folklore. Best-effort; never affects the run.
      if (status !== 'CANCELLED') {
        try {
          const wfRow = this.deps.db
            .select({
              graph: schema.workflows.graph,
              settings: schema.workflows.settings,
              contentHash: schema.workflows.contentHash,
              activeRevisionId: schema.workflows.activeRevisionId,
              trustState: schema.workflows.trustState,
            })
            .from(schema.workflows)
            .where(eq(schema.workflows.id, ctx.workflowId))
            .get();
          if (wfRow?.graph) {
            const stamp = {
              at: new Date().toISOString(),
              runId: ctx.runId,
              status,
              graphHash: graphContentHash(ctx.graph),
              ...(runVerdict ? { verdict: runVerdict.outcome } : {}),
            };
            const isDebug = this.#debugRuns.has(ctx.runId);
            // SWIFT-T: roll the production accomplishment health (the metric the
            // Sentinel and the health indicator read). Debug runs never count.
            let healthPatch: { outcomeHealth?: BuildLoopOutcomeHealth } = {};
            if (!isDebug && runVerdict) {
              const prior = readBuildLoop(wfRow.settings).outcomeHealth;
              const recent: Array<0 | 1> = [runVerdict.outcome === 'accomplished' ? 1 : 0, ...(prior?.recent ?? [])].slice(0, 20) as Array<0 | 1>;
              healthPatch = {
                outcomeHealth: {
                  recent,
                  ...(runVerdict.outcome !== 'accomplished'
                    ? { lastDeficientRunId: ctx.runId }
                    : prior?.lastDeficientRunId
                      ? { lastDeficientRunId: prior.lastDeficientRunId }
                      : {}),
                },
              };
            }
            stampBuildLoop(
              this.deps.db,
              ctx.workflowId,
              isDebug ? { debugRun: stamp } : { productionRun: stamp, ...healthPatch },
            );
            // BRAIN-BLUEPRINT-10X — BLESS: an ACCOMPLISHED production run ratchets
            // the blueprint stamp to the graph that actually RAN (ctx.graph — its
            // bytes live in the run's graphSnapshot). Unlike productionRun (which
            // every terminal run overwrites, including failures), this only moves
            // forward on proof. It is what the self-heal guard respects and what
            // agentis.workflow.restore_blueprint rolls back to.
            if (!isDebug && runVerdict?.outcome === 'accomplished') {
              const blessedHash = graphContentHash(ctx.graph);
              stampBuildLoop(this.deps.db, ctx.workflowId, {
                blueprint: { at: stamp.at, runId: ctx.runId, graphHash: blessedHash },
              });
              this.#audit(ctx, {
                action: 'workflow.blessed',
                actorType: 'system',
                actorId: 'verdict-engine',
                outputSummary: `blueprint blessed @${blessedHash.slice(0, 12)} by accomplished run ${ctx.runId}`,
              });
            }
            // A hardened workflow whose production run is no longer accomplished
            // has REGRESSED: demote the hardened stamp (hash-keyed honesty) and
            // let the Sentinel file the Issue + pause unattended triggers.
            if (!isDebug && runVerdict && runVerdict.outcome !== 'accomplished') {
              const loop = readBuildLoop(wfRow.settings);
              if (loop.hardened && loop.hardened.graphHash === stamp.graphHash) {
                stampBuildLoop(this.deps.db, ctx.workflowId, { hardened: undefined });
                this.#audit(ctx, {
                  action: 'workflow.demoted',
                  actorType: 'system',
                  actorId: 'verdict-engine',
                  outputSummary: `hardened stamp cleared: production run ${ctx.runId} verdict ${runVerdict.outcome}`,
                });
              }
              // Trust is operational, not a permanent badge. A deficient
              // production run against the exact active bytes makes that active
              // revision regressed until it is freshly verified and promoted.
              if (wfRow.activeRevisionId
                && wfRow.contentHash === stamp.graphHash
                && (wfRow.trustState === 'proven' || wfRow.trustState === 'break_glass')) {
                this.deps.db.update(schema.workflows).set({
                  trustState: 'regressed',
                  updatedAt: stamp.at,
                }).where(eq(schema.workflows.id, ctx.workflowId)).run();
                this.deps.db.update(schema.workflowGraphRevisions).set({
                  trustState: 'regressed',
                  updatedAt: stamp.at,
                }).where(eq(schema.workflowGraphRevisions.id, wfRow.activeRevisionId)).run();
              }
              this.deps.onWorkflowDemoted?.({
                workspaceId: ctx.workspaceId,
                workflowId: ctx.workflowId,
                runId: ctx.runId,
                verdict: runVerdict,
              });
              // Sentinel on outcomes: a deficient production run files an Issue
              // exactly like a failed one — silence is not an option.
              if (this.deps.instincts) {
                void this.deps.instincts.onRunDeficient?.({
                  workspaceId: ctx.workspaceId,
                  workflowId: ctx.workflowId,
                  runId: ctx.runId,
                  verdict: runVerdict,
                  userId: ctx.userId,
                });
              }
            }
          }
        } catch {
          /* stamping is bookkeeping — never fail a terminal transition */
        }
      }
    }

    // If this is a child subflow run reaching a terminal state, notify the executor.
    if (finishing && this.deps.subflows && previous !== status) {
      const child = this.deps.db
        .select()
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.id, ctx.runId))
        .get();
      if (child?.parentRunId) {
        const parent = this.deps.subflows.findParentByChildRunId(ctx.runId);
        if (parent) {
          // Final output: union of all completed-node outputs, dominated by the
          // last completed terminal node. Lightweight fallback when there's no
          // explicit "return" node.
          const finalNodeId = ctx.state.completedNodeIds.at(-1);
          const finalOutput = (finalNodeId && ctx.state.nodeStates[finalNodeId]?.outputData) || {};
          await this.deps.subflows.onChildRunFinished({
            childRunId: ctx.runId,
            parentRunId: parent.parentRunId,
            parentNodeId: parent.parentNodeId,
            status: status as 'COMPLETED' | 'FAILED' | 'CANCELLED',
            finalOutput: finalOutput as Record<string, unknown>,
            workspaceId: child.workspaceId,
            ambientId: child.ambientId,
            ...(status !== 'COMPLETED' ? { error: `child run ${ctx.runId} ${status}` } : {}),
          });
        }
      }
    }

    // A run parked on a recoverable blocker (out of credits / rate limit) sets the
    // run status to WAITING with a `blockedReason` on the node. WAITING has no
    // branch below, so it used to fall through to RUN_RUNNING — the run announced
    // "running" and then went permanently silent, which is exactly what a freeze
    // looks like to an operator. It is a PAUSE (the REST layer already reports
    // these as `status: 'paused'` + blockedReason); say so on the wire too.
    // Plain WAITING with no blocker is a legitimate wait (approval, schedule,
    // await_event) and must keep its existing signal.
    const blockedReason = Object.values(ctx.state.nodeStates ?? {})
      .find((n) => n?.status === 'WAITING' && n?.blockedReason)?.blockedReason;
    const eventName =
      status === 'COMPLETED'
        ? REALTIME_EVENTS.RUN_COMPLETED
        // COMPLETED_WITH_ERRORS is surfaced as a FAILURE: it triggers the
        // proactive auto-diagnosis and shows red in the UI, matching the user's
        // mental model ("a node failed → the workflow failed").
        : status === 'CANCELLED'
          ? REALTIME_EVENTS.RUN_CANCELLED
          : status === 'PAUSED' || (status === 'WAITING' && blockedReason)
            ? REALTIME_EVENTS.RUN_PAUSED
            : status === 'FAILED' || status === 'COMPLETED_WITH_ERRORS' || status === 'COMPLETED_WITH_CONTRACT_VIOLATION'
          ? REALTIME_EVENTS.RUN_FAILED
          : REALTIME_EVENTS.RUN_RUNNING;
    // workspaceId lets the workspace-level SSE fallback forward this run-status
    // event (its filter keys on room OR payload.workspaceId).
    const runStatusPayload = {
      runId: ctx.runId,
      status,
      executionStatus: settlement.executionStatus,
      outcomeStatus: settlement.outcomeStatus,
      settlement,
      ...(settledAt ? { settledAt } : {}),
      workflowId: ctx.workflowId,
      workspaceId: ctx.workspaceId,
      // WHY the run parked, on the wire — so a surface can say "out of credits"
      // immediately instead of showing a bare "paused" and waiting for a refetch
      // (or, before this, showing nothing at all). Scoped to the pause signal:
      // a lingering blockedReason on some other node must never ride along on a
      // COMPLETED/FAILED payload and misreport why the run ended.
      ...(blockedReason && eventName === REALTIME_EVENTS.RUN_PAUSED
        ? { blockedReason, error: blockedReason }
        : {}),
      ...(runVerdict ? {
        verdict: runVerdict.outcome,
        accomplished: runVerdict.outcome === 'accomplished',
        summary: runVerdict.outcome === 'accomplished'
          ? 'Execution completed and the business outcome was verified.'
          : `Execution completed mechanically, but the business outcome is ${runVerdict.outcome}.`,
      } : status === 'COMPLETED' ? {
        accomplished: null,
        summary: 'Execution completed mechanically without a definition-of-done verdict.',
      } : {}),
    };
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), eventName, runStatusPayload);
    this.deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), eventName, runStatusPayload);
    this.#appendActivityTail(ctx.runId, eventName, runStatusPayload);
    if (finishing) {
      this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.RUN_SETTLED, runStatusPayload);
      this.deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), REALTIME_EVENTS.RUN_SETTLED, runStatusPayload);
      this.#appendActivityTail(ctx.runId, REALTIME_EVENTS.RUN_SETTLED, runStatusPayload);
    }
    // Business progression gets its own strong event. `run.completed` remains
    // an execution-lifecycle signal for compatibility; rules that mean "the
    // objective was achieved" subscribe to this verdict-backed event instead.
    if (status === 'COMPLETED' && runVerdict?.outcome === 'accomplished') {
      const accomplishedPayload = { ...runStatusPayload, verdict: runVerdict.outcome };
      this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.RUN_ACCOMPLISHED, accomplishedPayload);
      this.deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), REALTIME_EVENTS.RUN_ACCOMPLISHED, accomplishedPayload);
      this.#appendActivityTail(ctx.runId, REALTIME_EVENTS.RUN_ACCOMPLISHED, accomplishedPayload);
    }
  }

  /**
   * Durable checkpoint of the run_state resume cache. Immediate + synchronous:
   * callers that need read-after-write (approvals, evolve, terminal boundaries)
   * use this. Cancels any pending coalesced flush for the run first so ordering
   * stays correct.
   */
  async #persistRun(ctx: RunningContext): Promise<void> {
    this.#cancelPendingPersist(ctx.runId);
    this.#writeRunState(ctx);
  }

  /**
   * Best-effort mid-run checkpoint. Coalesces into at most one write per run per
   * debounce window (throttle-with-trailing: the first call arms the timer,
   * later calls within the window only refresh the pending context). The ledger
   * is the replay source of truth, so a ≤debounce lag in this cache is safe and
   * keeps a large blob from stalling the event loop on every transition.
   */
  #schedulePersist(ctx: RunningContext): void {
    this.#pendingPersist.set(ctx.runId, ctx);
    if (this.#persistTimers.has(ctx.runId)) return;
    const timer = setTimeout(() => {
      this.#persistTimers.delete(ctx.runId);
      const pending = this.#pendingPersist.get(ctx.runId);
      if (!pending) return;
      this.#pendingPersist.delete(ctx.runId);
      try {
        this.#writeRunState(pending);
      } catch (err) {
        this.deps.logger.warn('engine.persist.coalesced_failed', { runId: ctx.runId, err: (err as Error).message });
      }
    }, CONSTANTS.RUN_STATE_PERSIST_DEBOUNCE_MS);
    timer.unref?.();
    this.#persistTimers.set(ctx.runId, timer);
  }

  /** Drop any pending coalesced flush for a run without writing. */
  #cancelPendingPersist(runId: string): void {
    const timer = this.#persistTimers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.#persistTimers.delete(runId);
    }
    this.#pendingPersist.delete(runId);
  }

  /** The actual synchronous write, shaping the state to its persisted form. */
  #writeRunState(ctx: RunningContext): void {
    this.deps.db
      .update(schema.workflowRuns)
      .set({
        runState: toPersistedRunState(ctx.state),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workflowRuns.id, ctx.runId))
      .run();
  }

  /**
   * Compute the final-output payload for a run, used for outputContract
   * validation. Prefers nodes marked `config.isOutput` over the
   * "last-completed node" heuristic; falls back to the union of every
   * sink node's output when no nodes are explicitly marked.
   */
  #collectFinalOutput(ctx: RunningContext): Record<string, unknown> {
    const outputNodes = ctx.graph.nodes.filter((n) => {
      const cfg = n.config as { isOutput?: boolean };
      return cfg.isOutput === true;
    });
    if (outputNodes.length > 0) {
      const merged: Record<string, unknown> = {};
      for (const n of outputNodes) {
        const out = ctx.state.nodeStates[n.id]?.outputData;
        if (out && typeof out === 'object' && !Array.isArray(out)) {
          Object.assign(merged, out);
        }
      }
      return merged;
    }
    // Fallback — last completed node's output. Matches the subflow parent
    // notification semantics so contract validation and parent handoff agree.
    const finalNodeId = ctx.state.completedNodeIds.at(-1);
    const out = (finalNodeId && ctx.state.nodeStates[finalNodeId]?.outputData) || {};
    return (out && typeof out === 'object' && !Array.isArray(out)) ? (out as Record<string, unknown>) : {};
  }

  // ─── SWIFT layer 3 — verdict + outcome heal ────────────────────────────────

  /** The workflow's spec, loaded once per run (cached on the context). */
  #specForRun(ctx: RunningContext): WorkflowSpec | null {
    const holder = ctx as unknown as { __swiftSpec?: WorkflowSpec | null };
    if (holder.__swiftSpec !== undefined) return holder.__swiftSpec;
    try {
      const row = this.deps.db
        .select({ settings: schema.workflows.settings })
        .from(schema.workflows)
        .where(eq(schema.workflows.id, ctx.workflowId))
        .get();
      holder.__swiftSpec = row ? readWorkflowSpec(row.settings) : null;
    } catch {
      holder.__swiftSpec = null;
    }
    return holder.__swiftSpec;
  }

  /**
   * SWIFT V8 — compile-to-enforcement of `spec.constraints` at external-call
   * dispatch. Out-of-scope service → BLOCKED_POLICY_SERVICE (a POLICY-class
   * failure: self-heal skips it — the fix is widening the spec, not retrying).
   * Every external call counts against `maxMutatingCalls` when set.
   */
  #enforceSpecConstraints(ctx: RunningContext, service: string, callRef: string, ...aliases: string[]): void {
    const constraints = this.#specForRun(ctx)?.constraints;
    if (!constraints) return;
    const allowed = constraints.allowedServices;
    if (allowed && allowed.length > 0) {
      const candidates = [service, ...aliases].map((s) => s.toLowerCase());
      if (!allowed.some((a) => candidates.includes(a.toLowerCase()))) {
        throw new AgentisError(
          'INTEGRATION_OPERATION_FAILED',
          `BLOCKED_POLICY_SERVICE: "${callRef}" uses service "${service}", which is outside this workflow's scoped allowedServices [${allowed.join(', ')}]. Widen the scope explicitly via agentis.workflow.scope if this call is intended.`,
        );
      }
    }
    if (constraints.maxMutatingCalls !== undefined) {
      const holder = ctx.state as unknown as { externalCallCount?: number };
      const next = (holder.externalCallCount ?? 0) + 1;
      if (next > constraints.maxMutatingCalls) {
        throw new AgentisError(
          'INTEGRATION_OPERATION_FAILED',
          `BLOCKED_POLICY_BUDGET: external-call budget exhausted (${constraints.maxMutatingCalls} per run, per the workflow spec). "${callRef}" was call #${next}.`,
        );
      }
      holder.externalCallCount = next;
    }
  }

  /** Producer kinds the sufficiency tripwire watches. Control-flow kinds are
   *  exempt (a filter legitimately yields empty); explicit opt-out honored. */
  #sufficiencyTripwireApplies(node: WorkflowNode): boolean {
    const cfg = node.config as { kind?: string; allowEmptyOutput?: boolean };
    if (cfg.allowEmptyOutput === true) return false;
    return ['agent_task', 'agent_session', 'agent_swarm', 'integration', 'mcp', 'extension_task', 'component_task', 'code', 'http_request', 'browser', 'subflow', 'transform'].includes(cfg.kind ?? '');
  }

  /** First floor violation in this node's output, or null. */
  #sufficiencyViolation(ctx: RunningContext, node: WorkflowNode, output: Record<string, unknown>): string | null {
    const spec = this.#specForRun(ctx);
    if (!spec?.sufficiency?.length) return null;
    for (const floor of spec.sufficiency) {
      if (!(floor.key in output)) continue;
      const value = output[floor.key];
      const empty = value === null
        || (typeof value === 'string' && value.trim() === '')
        || (Array.isArray(value) && value.length === 0)
        || (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0);
      if (floor.nonEmpty && empty) return `"${node.title}" produced an empty "${floor.key}"`;
      if (floor.minItems !== undefined && Array.isArray(value) && value.length < floor.minItems) {
        return `"${node.title}" produced ${value.length} item(s) in "${floor.key}" but the spec requires ≥${floor.minItems}`;
      }
      if (floor.minLength !== undefined && typeof value === 'string' && value.trim().length < floor.minLength) {
        return `"${node.title}" produced ${value.trim().length} chars in "${floor.key}" but the spec requires ≥${floor.minLength}`;
      }
    }
    return null;
  }

  /**
   * Execute the spec's acceptance checks against the WORLD (never the run's
   * self-report) and return the verdict. Never throws — an unverifiable run is
   * a `partial`, not a crash.
   */
  async #evaluateVerdict(ctx: RunningContext, spec: WorkflowSpec): Promise<RunVerdict | null> {
    try {
      const isDebug = this.#debugRuns.has(ctx.runId);
      const nodeOutputs: Record<string, Record<string, unknown>> = {};
      for (const [nodeId, ns] of Object.entries(ctx.state.nodeStates)) {
        if (ns?.outputData && typeof ns.outputData === 'object') nodeOutputs[nodeId] = ns.outputData as Record<string, unknown>;
      }
      const verdictOutput = this.#collectVerdictSurface(ctx);
      const verdict = await evaluateRunVerdict({
        spec,
        graphHash: graphContentHash(ctx.graph),
        output: verdictOutput,
        nodeOutputs,
        trigger: (ctx.state.nodeStates[ctx.graph.nodes.find((n) => (n.config as { kind?: string }).kind === 'trigger')?.id ?? '']?.outputData ?? {}) as Record<string, unknown>,
        // Debug runs always get the full verdict; production honors the spec's
        // verification mode (probes_only for high-frequency crons).
        mode: !isDebug && spec.verification === 'probes_only' ? 'probes_only' : 'full',
        deps: this.#verdictProbeDeps(ctx, spec),
      });
      this.deps.logger.info('engine.run.verdict', {
        runId: ctx.runId,
        outcome: verdict.outcome,
        checks: verdict.checks.length,
        deficiencies: verdict.deficiencies.length,
      });
      this.#audit(ctx, {
        action: 'run.verdict',
        actorType: 'system',
        actorId: 'verdict-engine',
        outputSummary: `${verdict.outcome}: ${verdict.checks.filter((c) => c.passed).length}/${verdict.checks.length} checks passed${verdict.deficiencies.length > 0 ? `; deficiencies: ${verdict.deficiencies.map((d) => d.claim).join(' | ').slice(0, 300)}` : ''}`,
      });
      return verdict;
    } catch (err) {
      this.deps.logger.warn('engine.run.verdict_failed', { runId: ctx.runId, error: (err as Error).message });
      return null;
    }
  }

  /** Canonical DATA surface shared by initial grading, diagnostics, and regrade. */
  #collectVerdictSurface(ctx: RunningContext): Record<string, unknown> {
    const terminalNodes = ctx.graph.nodes.filter((n) => {
      const cfg = n.config as { kind?: string; isOutput?: boolean };
      return cfg.kind === 'return_output' || cfg.isOutput === true;
    });
    if (terminalNodes.length === 0) return unwrapReturnEnvelope(this.#collectFinalOutput(ctx));
    const output: Record<string, unknown> = {};
    for (const n of terminalNodes) {
      const value = ctx.state.nodeStates[n.id]?.outputData;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        Object.assign(output, unwrapReturnEnvelope(value as Record<string, unknown>));
      }
    }
    return output;
  }

  /**
   * Build the world-probe deps for the verdict engine — the http / browser /
   * data / file probes + the judge seam. Shared by the run-settle verdict AND
   * the `pursue` node's `doneWhen: { type: 'objective' }` done-check, so both
   * verify against the world through exactly the same evidence path (RFC P1).
   */
  #verdictProbeDeps(ctx: RunningContext, spec: WorkflowSpec): VerdictProbeDeps {
    const evaluator = this.deps.resolveEvaluatorRuntime?.(ctx.workspaceId, 'evaluation', { task: spec.objective, purpose: 'run_verdict' })
      ?? this.deps.evaluatorRuntime;
    return {
      allowPrivateNetwork: String(process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
      ...(this.deps.browserPool
        ? {
            browser: {
              navigate: async (url: string) => this.deps.browserPool!.navigate({ url }),
              screenshot: async (url: string) => this.deps.browserPool!.screenshot({ url }),
            },
          }
        : {}),
      runIntegration: async (integration, operation, params) => {
        if (integration === 'agentis_app') {
          if (operation !== 'query') throw new AgentisError('VALIDATION_FAILED', `agentis_app data probe does not support '${operation}'`);
          if (!this.deps.appData) throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'agentis_app data probe requires the App datastore');
          const collection = typeof params.collection === 'string' ? params.collection : '';
          if (!collection) throw new AgentisError('VALIDATION_FAILED', 'agentis_app data probe requires collection');
          const appId = typeof params.appId === 'string' && params.appId
            ? params.appId
            : this.#appScopeId(ctx.workspaceId, ctx.workflowId);
          if (!appId) throw new AgentisError('VALIDATION_FAILED', 'agentis_app data probe could not resolve the owning App');
          return this.deps.appData.query(ctx.workspaceId, appId, collection, {
            ...(params.filter && typeof params.filter === 'object' && !Array.isArray(params.filter)
              ? { filter: params.filter as Record<string, unknown> }
              : {}),
            limit: typeof params.limit === 'number' ? Math.min(Math.max(Math.trunc(params.limit), 1), 1000) : 1000,
          }) as unknown as Record<string, unknown>;
        }
        return this.runIntegrationOperation(ctx.workspaceId, integration, operation, params);
      },
      ...(evaluator
        ? {
            judge: async (a: { target: unknown; criteria: string }) => {
              const v = await evaluator.evaluate({ workspaceId: ctx.workspaceId, target: a.target, criteria: a.criteria });
              return { score: v.score, passed: v.passed, critique: v.critique };
            },
          }
        : {}),
      saveEvidence: async (name, content, mimeType) => this.#saveVerdictEvidence(ctx, name, content, mimeType),
      statPath: async (p: string) => this.#statVerdictPath(p),
    };
  }

  /** Persist probe evidence (screenshots…) as a workspace artifact. */
  async #saveVerdictEvidence(ctx: RunningContext, name: string, content: Buffer | string, mimeType: string): Promise<string | undefined> {
    try {
      const id = randomUUID();
      const now = new Date().toISOString();
      this.deps.db.insert(schema.artifacts).values({
        id,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        type: mimeType.startsWith('image/') ? 'image' : 'file',
        title: name,
        content: Buffer.isBuffer(content) ? content.toString('base64') : content,
        thumbnailUrl: null,
        runId: ctx.runId.startsWith('test-') ? null : ctx.runId,
        workflowId: ctx.workflowId,
        agentId: null,
        appId: this.#appScopeId(ctx.workspaceId, ctx.workflowId),
        origin: 'workflow',
        conversationId: null,
        nodeId: null,
        metadata: { name, savedBy: 'verdict-engine', mimeType },
        createdAt: now,
        updatedAt: now,
      }).run();
      return id;
    } catch {
      return undefined;
    }
  }

  /**
   * Stat a local path for a `file_probe` acceptance check — the filesystem is
   * the world for a local harvest/build (this is what catches an agent_task that
   * fabricated "15 products harvested" while the directory is empty). Path-
   * guarded: only paths that resolve WITHIN the API's working tree (cwd) or the
   * configured data dir are readable — a probe can never stat `/etc/passwd`.
   * Returns null when the path does not exist. For a directory, counts files and
   * total bytes ONE level deep (enough to prove a harvest wrote real output).
   */
  async #statVerdictPath(rawPath: string): Promise<{ isDir: boolean; fileCount: number; totalBytes: number } | null> {
    try {
      const path = await import('node:path');
      const fs = await import('node:fs/promises');
      const roots = [process.cwd(), process.env.AGENTIS_DATA_DIR ? path.resolve(process.env.AGENTIS_DATA_DIR) : null]
        .filter((r): r is string => Boolean(r))
        .map((r) => path.resolve(r));
      const resolved = path.resolve(rawPath);
      if (!roots.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
        this.deps.logger.warn('engine.verdict.file_probe_out_of_root', { path: resolved });
        return null;
      }
      const stat = await fs.stat(resolved).catch(() => null);
      if (!stat) return null;
      if (!stat.isDirectory()) return { isDir: false, fileCount: 1, totalBytes: stat.size };
      const entries = await fs.readdir(resolved, { withFileTypes: true }).catch(() => []);
      let fileCount = 0;
      let totalBytes = 0;
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const info = await fs.stat(path.join(resolved, entry.name)).catch(() => null);
        if (info) { fileCount += 1; totalBytes += info.size; }
      }
      return { isDir: true, fileCount, totalBytes };
    } catch {
      return null;
    }
  }

  /**
   * Outcome heal (SWIFT §2-T3) — the outcome-level sibling of self-heal. A
   * PRODUCTION run whose verdict is deficient gets bounded re-work: the first
   * deficient producing node is re-run through the self-heal seam with the
   * deficiency (and its evidence) as the briefing. Debug runs never re-work —
   * `#runSelfHeal` already no-ops for them, surfacing raw truth to the
   * iterating agent. Returns true when the run resumed (do not finish it).
   */
  async #healDeficientOutcome(ctx: RunningContext, spec: WorkflowSpec, verdict: RunVerdict): Promise<boolean> {
    if (this.#debugRuns.has(ctx.runId)) return false;
    const budget = spec.reworkBudget ?? 1;
    const holder = ctx.state as unknown as { outcomeRework?: { attempts: number; nodesReworked: string[] } };
    const attempts = holder.outcomeRework?.attempts ?? 0;
    if (attempts >= budget) {
      // Converge-honest: budget exhausted, the verdict stands — never faked.
      verdict.rework = { attempts, nodesReworked: holder.outcomeRework?.nodesReworked ?? [] };
      return false;
    }
    const target = verdict.deficiencies
      .flatMap((d) => d.producingNodeIds.map((nodeId) => ({ nodeId, deficiency: d })))
      .map(({ nodeId, deficiency }) => ({ node: ctx.graph.nodes.find((n) => n.id === nodeId), deficiency }))
      .find(({ node }) => node && isSelfHealableNode(node));
    if (!target?.node) return false;
    const briefing = [
      `OUTCOME VERIFICATION FAILED (verdict: ${verdict.outcome}). The run completed but did not accomplish its objective: "${spec.objective}".`,
      `Deficiency on this node's output: ${target.deficiency.detail}`,
      ...verdict.deficiencies.slice(0, 4).map((d) => `- ${d.claim}: ${d.detail}`),
      'Re-do this step so its output SATISFIES the acceptance evidence above — real content, no placeholders, no advisory text.',
    ].join('\n');
    this.deps.logger.info('engine.run.outcome_rework', { runId: ctx.runId, nodeId: target.node.id, attempt: attempts + 1, budget });
    const heal = await this.#selfHeal.runSelfHeal(ctx, target.node, {}, briefing);
    if (heal.kind === 'structural_applied' || heal.kind === 'awaiting_approval' || heal.kind === 'output_fixed') {
      holder.outcomeRework = { attempts: attempts + 1, nodesReworked: [...(holder.outcomeRework?.nodesReworked ?? []), target.node.id] };
      verdict.rework = holder.outcomeRework;
      this.#audit(ctx, {
        nodeId: target.node.id,
        action: 'run.outcome_rework',
        actorType: 'system',
        actorId: 'verdict-engine',
        outputSummary: `attempt ${attempts + 1}/${budget}: re-working "${target.node.title}" — ${target.deficiency.claim}`,
      });
      // output_fixed patched the node's data in place — re-verify by falling
      // through to a fresh transition attempt rather than resuming dispatch.
      if (heal.kind === 'output_fixed') return false;
      return true;
    }
    verdict.rework = { attempts, nodesReworked: holder.outcomeRework?.nodesReworked ?? [] };
    return false;
  }

  async #maybeSnapshot(ctx: RunningContext): Promise<void> {
    if (ctx.eventsSinceSnapshot < CONSTANTS.RUN_STATE_SNAPSHOT_INTERVAL_EVENTS) return;
    ctx.eventsSinceSnapshot = 0;
    // Only the latest snapshot per run is ever needed to cold-resume it, so
    // supersede older ones instead of accumulating multi-MB rows for the life of
    // the run. Shape it the same lean way as the run_state cache.
    this.deps.db.delete(schema.workflowRunSnapshots).where(eq(schema.workflowRunSnapshots.runId, ctx.runId)).run();
    await this.deps.db.insert(schema.workflowRunSnapshots).values({
      id: randomUUID(),
      runId: ctx.runId,
      sequenceNumber: ctx.state.lastLedgerSequence,
      runState: toPersistedRunState(ctx.state),
    });
  }

  async #appendTerminalConversationMessage(ctx: RunningContext, status: WorkflowRunStatus): Promise<void> {
    // Workflow state belongs to the Run surface and the compact chat work
    // trace, not as a sequence of system messages underneath an answer. The
    // lead agent synthesizes meaningful outcomes into its normal reply.
    void ctx;
    void status;
  }
}

export interface RunningContext {
  runId: string;
  workflowId: string;
  planId: string | null;
  workspaceId: string;
  ambientId: string | null;
  conversationId: string | null;
  userId: string;
  /** Immutable revision selected at run start. */
  workflowRevisionId?: string | null;
  /** Set when the run graph diverges through a local repair/evolution. */
  repairedFromRevisionId?: string | null;
  graph: WorkflowGraph;
  downstreamEdges: Map<string, WorkflowEdge[]>;
  state: WorkflowRunState;
  eventsSinceSnapshot: number;
  /**
   * Number of #dispatchNode promise chains currently in-flight. Tracked
   * in-memory only (not persisted). Required because passthrough node kinds
   * never register in activeExecutions but still hold the run open until
   * their #completeNode fan-out runs.
   */
  inflightDispatches: number;
  startedAt?: string;
  scratchpad?: { snapshot: Record<string, unknown> };
  /** Active agent_swarm nodes keyed by node id. */
  swarms: Map<string, SwarmState>;
  /** Self-heal attempt counters keyed by agent_task node id. */
  selfHealAttempts: Map<string, number>;
  /** Generic `retryPolicy` attempt counters keyed by node id (non-agent nodes). */
  nodeRetryAttempts?: Map<string, number>;
  /** Per-node dispatch counts for the infinite-cycle ceiling. */
  nodeDispatchCounts?: Map<string, number>;
  /**
   * Real model token consumption per node, keyed by node id. Every agent
   * execution path (session / tool-loop / dispatch) records here; the terminal
   * `node.completed` audit entry reads + persists it so analytics can SUM
   * tokens from a single sink with no double counting. Exact when the runtime
   * reports usage, estimated from prompt+output text otherwise.
   */
  nodeTokenUsage?: Map<string, { tokensIn: number; tokensOut: number }>;
  /**
   * Explicit agent attribution for a node's recorded tokens, keyed by node id.
   * Set by paths that know the spending agent but complete a non-`agent_task`
   * node (the tool loop's resolved agent; an evaluator/router run on an agent's
   * model). `node.completed` uses it to stamp `agent_id` so no spend is anonymous.
   */
  nodeTokenAttribution?: Map<string, string>;
  /** Estimated input tokens of a dispatched task prompt, keyed by node id —
   *  combined with the returned output to attribute tokens for the dispatch path. */
  nodeDispatchInputTokens?: Map<string, number>;
  /**
   * Resolved input data per agent node, captured at dispatch. Lets the reliability
   * fallback (a structured-completion retry on a guaranteed runtime) reconstruct
   * the task when the bound agent/harness returns empty output or exits non-zero.
   */
  nodeLastInput?: Map<string, Record<string, unknown>>;
  /** Agent nodes that already used their one-shot fallback-runtime retry. */
  nodeFallbackAttempted?: Set<string>;
  /** Agent nodes that already used their one-shot output-reshape attempt. */
  nodeReshapeAttempted?: Set<string>;
  /**
   * Run-scoped cancellation (NATIVE-ADVANCEMENT Proposal 7, Agentis-native form).
   * `cancelRun` aborts this so in-flight work that honors the signal (HTTP
   * requests today; other handlers can adopt it) stops promptly instead of
   * running to completion after the run was cancelled.
   */
  abortController?: AbortController;
  /** Set synchronously when the operator cancels, before adapter shutdown awaits. */
  cancellationRequested?: boolean;
  /** Per-phase execution runtime (cost accrual + SLA timer). Lazily created. */
  phaseRuntime?: Map<string, PhaseRuntimeState>;
  /** Set when a phase / run / workspace budget is exceeded — settles the run as FAILED. */
  budgetHalt?: boolean;
  /** Accrued cost for this run (cents) — drives the per-run workflow ceiling (§5.3). */
  runCostCents?: number;
  /** Cached workflow per-run budget: undefined = not yet loaded, null = uncapped. */
  workflowBudgetCents?: number | null;
  /** In-memory map of pending approval id → resume target (checkpoint node / phase / session). */
  pendingApprovals?: Map<string, PendingApproval>;
  /** Sessions parked on `await_event`, keyed by event name. */
  sessionWaiters?: Map<string, SessionWaiter[]>;
}

/** Resume target for a pending approval. `session` carries the wake bookkeeping. */
export interface PendingApproval {
  kind: 'checkpoint' | 'phase_gate' | 'session' | 'self_heal';
  targetId: string;
  sessionId?: string;
  toolCallId?: string;
  runCtx?: SessionRunContext;
  healAction?: 'graph_patch' | 'retry_with_repair_context';
  /** For kind 'self_heal' — the certified, validated patch awaiting approval (W7). */
  healPatch?: WorkflowGraphPatch;
  healResumeNodeId?: string;
  repairPlanId?: string;
  retryError?: string;
  retryDiagnosis?: string;
  retryAttempt?: number;
  retryMaxAttempts?: number;
}

/** A session parked on a named run event, with everything needed to wake it. */
interface SessionWaiter {
  sessionId: string;
  nodeId: string;
  toolCallId: string;
  runCtx: SessionRunContext;
}

interface PhaseRuntimeState {
  started: boolean;
  startedAt: number;
  cost: number;
  slaTimer?: ReturnType<typeof setTimeout>;
  slaBreached: boolean;
  /** Human-gate state (§5.1). `none` until the phase's first node is reached. */
  gateState?: 'none' | 'pending' | 'approved';
  /** Ready-queue items held while the gate is pending — re-enqueued on approval. */
  held?: ReadyQueueItem[];
}

interface SwarmState {
  nodeId: string;
  total: number;
  /** Index of the next item to dispatch. */
  next: number;
  items: unknown[];
  agentId: string;
  config: AgentSwarmNodeConfig;
  results: Map<number, Record<string, unknown>>;
  failures: Map<number, string>;
  settled: boolean;
  /** Isolated per-subtask working directories, keyed by item index. Released on settle. */
  worktrees: Map<number, WorktreeHandle>;
  /** Dispatched-but-not-yet-reported subtask indices. Used to cancel siblings on early settle. */
  inFlight: Set<number>;
}

/** Parse a `${nodeId}::swarm::${index}` synthetic task id. */
function parseSwarmTaskId(taskId: string): { nodeId: string; index: number } | null {
  const marker = '::swarm::';
  const at = taskId.lastIndexOf(marker);
  if (at < 0) return null;
  const index = Number(taskId.slice(at + marker.length));
  if (!Number.isInteger(index)) return null;
  return { nodeId: taskId.slice(0, at), index };
}

/**
 * Hard ceiling on engine tick concurrency. Even `unbounded` resolves to this —
 * `Number.MAX_SAFE_INTEGER` was a footgun that let one fan-out schedule
 * effectively limitless dispatches and exhaust the host's RAM/PIDs/file handles.
 * 256 is far above any real need while keeping a runaway bounded.
 */
export const WORKFLOW_PARALLELISM_HARD_CAP = 256;

/** Node kinds that own their retry/self-heal path; excluded from generic retryPolicy. */
const GENERIC_RETRY_EXCLUDED_KINDS = new Set<string>([
  'agent_task',
  'agent_swarm',
  'agent_session',
  'dynamic_swarm',
  'planner',
]);

/** Max times one node may be dispatched per run before the run is failed as a cycle. */
function nodeDispatchCeiling(): number {
  const raw = Number(process.env.AGENTIS_NODE_DISPATCH_CEILING);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 200;
}

export function resolveParallelism(): number {
  const raw = process.env.AGENTIS_WORKFLOW_PARALLELISM ?? CONSTANTS.WORKFLOW_PARALLELISM_DEFAULT;
  if (raw === 'unbounded') return WORKFLOW_PARALLELISM_HARD_CAP;
  if (raw === 'auto') {
    const cpu = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
      ?.hardwareConcurrency;
    return Math.max(2, Math.min((cpu ?? 4) * 2, WORKFLOW_PARALLELISM_HARD_CAP));
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, WORKFLOW_PARALLELISM_HARD_CAP) : 8;
}

function buildDownstreamEdges(graph: WorkflowGraph): Map<string, WorkflowEdge[]> {
  const downstream = new Map<string, WorkflowEdge[]>();
  for (const edge of graph.edges) {
    const edges = downstream.get(edge.source);
    if (edges) edges.push(edge);
    else downstream.set(edge.source, [edge]);
  }
  return downstream;
}

function compactRealtimePayload(value: Record<string, unknown>): Record<string, unknown> {
  const preview: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 8)) {
    if (entry === null || typeof entry !== 'object') {
      preview[key] = entry;
      continue;
    }
    if (Array.isArray(entry)) {
      preview[key] = { type: 'array', count: entry.length };
      continue;
    }
    preview[key] = { type: 'object', keys: Object.keys(entry).slice(0, 8) };
  }
  return preview;
}

function hydrateSelfHealAttempts(state: WorkflowRunState): Map<string, number> {
  const attempts = new Map<string, number>();
  const raw = state.selfHealAttempts ?? {};
  if (!raw || typeof raw !== 'object') return attempts;
  for (const [nodeId, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      attempts.set(nodeId, Math.floor(value));
    }
  }
  return attempts;
}




function isSelfHealTerminalError(error: string): boolean {
  return /Self-healing stopped:|self-healing patch could not be applied|self-healing fix was rejected/i.test(error);
}


/**
 * Capability-aware self-heal (AGENT-WORKFLOW-CAPABILITY-10X E4). A failure that
 * means "a capability / provider / tool / binary this step needs is not present"
 * is NOT a structural problem: rewriting the graph or swapping the agent/model
 * cannot add a missing capability. Detecting this lets the engine escalate
 * honestly ("enable X") instead of burning LLM replans that pointlessly reroute
 * the agent (the sonnet→hermes loop the operator hit). High precision by design —
 * it only matches the platform's explicit "not configured / not wired / not
 * available / requires <binary>" phrasings, so genuine structural failures still
 * reach the replan.
 */
/** Platform tools a workflow agent must NOT call — recursion / run-control / spawn
 *  (mirrors the in-engine E2 bridge's blocklist in bootstrap). */
const WORKFLOW_AGENT_TOOL_BLOCKLIST = new Set<string>([
  'agentis.build_workflow',
  'agentis.workflow.patch',
  'agentis.workflow.graph.replace',
  'agentis.workflow.graph.patch',
  'agentis.workflow.graph.rollback',
  'agentis.run.graph.evolve',
  'agentis.workflow.run',
  // deliver builds + runs + repairs a whole workflow — an agent INSIDE a
  // workflow must never recursively deliver new apps (runaway). The top-level
  // chat orchestrator keeps it; agent_task nodes do not.
  'agentis.workflow.deliver',
  'agentis.ephemeral.run',
  'agentis.run.cancel',
  'agentis.approval.resolve',
]);



function selfHealFailureMessage(error: string, heal: SelfHealEngineResult | null): string {
  if (!heal || heal.kind !== 'none' || !heal.reason) return error;
  const diagnosis = heal.diagnosis ? ` Diagnosis: ${heal.diagnosis}` : '';
  return `${error}\n\nSelf-healing stopped: ${heal.reason}.${diagnosis} If this looks like a platform-level workflow repair gap, send this run to the Agentis team with the failing node and run id.`;
}

function selfHealPatchFromPayload(payload: unknown): WorkflowGraphPatch | null {
  if (!payload || typeof payload !== 'object') return null;
  const patch = (payload as { patch?: unknown }).patch;
  if (!patch || typeof patch !== 'object') return null;
  const candidate = patch as Partial<WorkflowGraphPatch>;
  if (typeof candidate.patchId !== 'string') return null;
  if (typeof candidate.reason !== 'string') return null;
  if (typeof candidate.baseGraphRevision !== 'number') return null;
  if (!Array.isArray(candidate.addNodes)) return null;
  if (!Array.isArray(candidate.updateNodes)) return null;
  if (!Array.isArray(candidate.removeNodeIds)) return null;
  if (!Array.isArray(candidate.addEdges)) return null;
  if (!Array.isArray(candidate.removeEdgeIds)) return null;
  return candidate as WorkflowGraphPatch;
}


function mergeGraphPatch(base: WorkflowGraph, patch: WorkflowGraphPatch): WorkflowGraph {
  const removeIds = new Set(patch.removeNodeIds);
  const updateById = new Map<string, WorkflowNode>(
    patch.updateNodes.map((n) => [n.id, n] as const),
  );
  const removeEdgeIds = new Set(patch.removeEdgeIds);

  // Reject add/update collisions early so the resulting graph stays unique.
  const baseNodeIds = new Set(base.nodes.map((n) => n.id));
  for (const n of patch.addNodes) {
    if (baseNodeIds.has(n.id) && !removeIds.has(n.id)) {
      throw new Error(`Cannot add node ${n.id}: already exists`);
    }
  }
  for (const n of patch.updateNodes) {
    if (!baseNodeIds.has(n.id)) {
      throw new Error(`Cannot update node ${n.id}: not in base graph`);
    }
  }
  for (const id of patch.removeNodeIds) {
    if (!baseNodeIds.has(id)) {
      throw new Error(`Cannot remove node ${id}: not in base graph`);
    }
  }

  const nextNodes: WorkflowNode[] = [];
  for (const n of base.nodes) {
    if (removeIds.has(n.id)) continue;
    nextNodes.push(updateById.get(n.id) ?? n);
  }
  for (const n of patch.addNodes) nextNodes.push(n);

  const surviving = new Set(nextNodes.map((n) => n.id));
  const baseEdgeIds = new Set(base.edges.map((e) => e.id));
  for (const id of patch.removeEdgeIds) {
    if (!baseEdgeIds.has(id)) {
      throw new Error(`Cannot remove edge ${id}: not in base graph`);
    }
  }
  for (const e of patch.addEdges) {
    if (baseEdgeIds.has(e.id)) {
      throw new Error(`Cannot add edge ${e.id}: already exists`);
    }
  }

  const nextEdges: WorkflowEdge[] = [];
  for (const e of base.edges) {
    if (removeEdgeIds.has(e.id)) continue;
    // Drop edges whose endpoints were removed by the patch.
    if (!surviving.has(e.source) || !surviving.has(e.target)) continue;
    nextEdges.push(e);
  }
  for (const e of patch.addEdges) nextEdges.push(e);

  return { ...base, nodes: nextNodes, edges: nextEdges };
}

export function mapInputs(
  mapping: Record<string, unknown>,
  inputData: Record<string, unknown>,
  scratchpad: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.keys(mapping).length === 0) return inputData;
  const out: Record<string, unknown> = {};
  for (const [field, source] of Object.entries(mapping)) {
    // Graph input mappings created by the visual editor may intentionally use
    // literal values (objects, arrays, booleans, numbers, or null). Treat only
    // strings as path expressions. Previously `source.startsWith(...)` crashed
    // the entire run/self-heal path when a valid literal reached this boundary.
    if (typeof source !== 'string') {
      out[field] = source;
      continue;
    }
    // Convention: "scratchpad.x.y" pulls from scratchpad; "inputs.x" or just
    // "x" pulls from the upstream node output. Anything not found becomes
    // null — we never throw at the boundary because workflows often have
    // optional inputs.
    if (source.startsWith('scratchpad.')) {
      out[field] = lookupPath(scratchpad, source.slice('scratchpad.'.length));
    } else if (source.startsWith('inputs.')) {
      out[field] = lookupPath(inputData, source.slice('inputs.'.length));
    } else {
      out[field] = lookupPath(inputData, source);
    }
  }
  return out;
}

function markOpenNodesSkipped(state: WorkflowRunState, reason: string): void {
  const now = new Date().toISOString();
  state.readyQueue = [];
  state.waitingInputs = {};
  state.activeExecutions = {};
  for (const ns of Object.values(state.nodeStates)) {
    if (ns.status === 'PENDING' || ns.status === 'WAITING' || ns.status === 'RUNNING') {
      ns.status = 'SKIPPED';
      ns.completedAt = now;
      ns.error = reason;
      if (!state.skippedNodeIds.includes(ns.nodeId)) state.skippedNodeIds.push(ns.nodeId);
    }
  }
}

/**
 * Whether a node failure is a recoverable INFRASTRUCTURE problem (the agent's
 * model is out of credits / billing / quota) rather than a logical task failure.
 * These pause the run (operator fixes billing, then resumes) instead of failing
 * it. Model-agnostic: matches the common provider signals, not a single vendor.
 */
function isRecoverableModelError(error: string): boolean {
  const e = (error || '').toLowerCase();
  return /\b402\b/.test(e)
    || /status=402/.test(e)
    || /insufficient[_\s]?quota/.test(e)
    || /insufficient[_\s]?(funds|credit|credits|balance)/.test(e)
    || /out of credits?/.test(e)
    || /payment required/.test(e)
    || /quota exceeded|exceeded your current quota/.test(e)
    || /billing (hard limit|issue|required)/.test(e)
    || /\bno credits?\b/.test(e);
}

/**
 * Organ 4 — a RESOURCE failure (external/infra), NOT a workflow logic bug: rate /
 * usage limits, exhausted quota, auth/captcha walls, transient 5xx / network. These
 * must be QUARANTINED (pause + resume), never "repaired" by editing or deleting the
 * node — the exact reason agents gut a workflow when a scout hits a rate limit.
 */
function isResourceFailure(error: string): boolean {
  if (isRecoverableModelError(error)) return true;
  const e = (error || '').toLowerCase();
  return /\b429\b|rate.?limit|too many requests/.test(e)
    || /usage limit|hit your usage limit|quota (?:exceeded|exhausted)|out of quota/.test(e)
    || /login wall|captcha required|\b403\b|access denied|401 unauthorized|permission denied/.test(e)
    || /\b(502|503|504)\b|service unavailable|temporarily unavailable|bad gateway|gateway timeout/.test(e)
    || /econnreset|etimedout|timed out|timeout|appears stuck|went quiet|enotfound|socket hang up/.test(e);
}

/**
 * Organ 4 — POLICY class: a DELIBERATE gate throw. Workflow authors signal
 * "stop here until a human/policy condition is met" by throwing an error whose
 * message carries a `BLOCKED_*` marker (e.g. `BLOCKED_SEED_NOT_APPROVED: …`).
 * That is the workflow working as intended — never a repairable logic bug, so
 * the self-heal ladder and retries must not touch it.
 */
function isPolicyBlockError(error: string): boolean {
  return /\bBLOCKED_[A-Z0-9_]{2,}\b/.test(error || '');
}

/** Operator-facing reason for a resource quarantine (distinct from a logic failure). */
function resourceBlockerReason(error: string): string {
  if (isRecoverableModelError(error)) return friendlyBlockedReason(error);
  const e = (error || '').toLowerCase();
  const tail = ` (source: ${(error || '').slice(0, 160)})`;
  if (/\b429\b|rate.?limit|too many requests|usage limit/.test(e)) {
    return 'Rate/usage limit hit on an external service or model — this is NOT a workflow bug. Wait for the limit to reset (or add capacity), then resume the run from here.' + tail;
  }
  if (/login|captcha|unauthorized|\b403\b|401|access denied|permission denied/.test(e)) {
    return 'An external service returned an access/auth wall (login / captcha / 401 / 403) — connect a session or credential, then resume. NOT a workflow logic bug.' + tail;
  }
  return 'A transient external/resource failure (network / timeout / 5xx) — retry or resume the run. NOT a workflow logic bug.' + tail;
}

/** A replayable activity item — a RealtimeEnvelope kept in the per-run tail. */
interface RunActivityEnvelope {
  activityId: string;
  event: string;
  payload: Record<string, unknown>;
  emittedAt: string;
}

function sanitizeRunActivityPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  const blocked = new Set(['args', 'input', 'result', 'toolInput', 'toolResult', 'output', 'payload']);
  for (const [key, value] of Object.entries(payload)) {
    if (blocked.has(key) || isSensitiveFieldName(key)) continue;
    if (typeof value === 'string') safe[key] = clipActivityText(redactSecretString(value));
    else if (value == null || typeof value === 'number' || typeof value === 'boolean') safe[key] = value;
    else if (Array.isArray(value)) safe[key] = value.slice(0, 20).map((item) => typeof item === 'string' ? clipActivityText(redactSecretString(item)) : '[redacted]');
    else safe[key] = '[redacted]';
  }
  return safe;
}

function clipActivityText(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length > 4000 ? `${value.slice(0, 3999)}…` : value;
}

function runActivityIdentity(event: string, payload: Record<string, unknown>, emittedAt: string): string {
  const stable = [
    event,
    stringValue(payload.nodeId),
    stringValue(payload.agentId),
    stringValue(payload.activityKind),
    stringValue(payload.activityPhase),
    stringValue(payload.phase),
  ].filter(Boolean).join(':');
  // Lifecycle/status events replace their prior projection. Free-form messages
  // remain discrete so meaningful commentary is not overwritten.
  return stringValue(payload.message) || stringValue(payload.description)
    ? `${stable}:${emittedAt}`
    : stable || `${event}:${emittedAt}`;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Max items kept in a run's in-memory activity tail. */
const RUN_ACTIVITY_TAIL_CAP = 400;

/** Operator-facing reason for a credit/model pause. */
function friendlyBlockedReason(error: string): string {
  return 'This agent’s model is out of credits (or its billing/quota was rejected). '
    + 'Add credits or switch the agent’s model, then resume the run. '
    + `(provider said: ${(error || '').slice(0, 180)})`;
}

function isTerminalRunStatus(status: string): boolean {
  return status === 'COMPLETED'
    || status === 'COMPLETED_WITH_CONTRACT_VIOLATION'
    || status === 'COMPLETED_WITH_ERRORS'
    || status === 'FAILED'
    || status === 'CANCELLED';
}

/** A terminal healer incident plus a failed node has no durable wake source. */
function hasTerminalSelfHealFailure(state: WorkflowRunState): boolean {
  if ((state.failedNodeIds?.length ?? 0) === 0) return false;
  return Object.values(state.selfHealIncidents ?? {}).some((incident) =>
    incident?.status === 'BLOCKED' || incident?.status === 'EXHAUSTED');
}

function lookupPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const normalized = path.startsWith('$.') ? path.slice(2) : path.startsWith('$') ? path.slice(1) : path;
  const parts = normalized.split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Coerce a resolved content value into the string `addDocument` expects. */
function stringifyKnowledgeContent(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function resolveKnowledgeQuery(
  config: KnowledgeNodeConfig,
  inputData: Record<string, unknown>,
  nodeStates: WorkflowRunState['nodeStates'],
): string {
  if ((config.queryMode ?? 'static') === 'dynamic') {
    const source = config.queryNodeId ? nodeStates[config.queryNodeId]?.outputData : inputData;
    const value = lookupPath(source ?? inputData, config.queryPath ?? '');
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    return JSON.stringify(value);
  }
  return config.query ?? '';
}

function mergeBufferedInputs(
  buf: { receivedInputs: Record<string, unknown> },
  strategy: 'merge_keys' | 'collect_all' | 'first_non_null' = 'merge_keys',
): Record<string, unknown> {
  const entries = Object.entries(buf.receivedInputs);

  // collect_all — keep every branch output distinct as an ordered array rather
  // than flattening keys (which would let a later branch clobber an earlier one).
  if (strategy === 'collect_all') {
    return { results: entries.map(([, value]) => value) };
  }

  // first_non_null — take the first branch that produced a meaningful payload.
  if (strategy === 'first_non_null') {
    for (const [src, value] of entries) {
      const isEmptyObject =
        value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
      if (value !== null && value !== undefined && !isEmptyObject) {
        return value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : { [src]: value };
      }
    }
    return {};
  }

  // merge_keys (default) — shallow-merge branch object outputs.
  const merged: Record<string, unknown> = {};
  for (const [src, value] of entries) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(merged, value);
    } else {
      merged[src] = value;
    }
  }
  return merged;
}

/**
 * Validate a final-output payload against a `WorkflowContract.fields` shape.
 * Returns human-readable violation messages; empty array means the contract
 * is satisfied. The Brain' runtime contract reuses this same function via
 * the `WorkflowContract` shape — keep it pure and dependency-free.
 */
function validateAgainstContract(
  output: Record<string, unknown>,
  fields: Array<{ key: string; type: string; required?: boolean }>,
): string[] {
  const violations: string[] = [];
  for (const field of fields) {
    const value = output[field.key];
    const present = value !== undefined && value !== null;
    if (!present) {
      if (field.required) violations.push(`Required field "${field.key}" is missing`);
      continue;
    }
    if (field.type === 'any') continue;
    const actual = Array.isArray(value) ? 'array' : typeof value;
    if (field.type === 'object' && (actual !== 'object' || Array.isArray(value))) {
      violations.push(`Field "${field.key}" expected object, got ${actual}`);
    } else if (field.type === 'array' && !Array.isArray(value)) {
      violations.push(`Field "${field.key}" expected array, got ${actual}`);
    } else if (field.type === 'string' && actual !== 'string') {
      violations.push(`Field "${field.key}" expected string, got ${actual}`);
    } else if (field.type === 'number' && actual !== 'number') {
      violations.push(`Field "${field.key}" expected number, got ${actual}`);
    } else if (field.type === 'boolean' && actual !== 'boolean') {
      violations.push(`Field "${field.key}" expected boolean, got ${actual}`);
    }
  }
  return violations;
}










/** The phase id (if any) a node belongs to — for audit + SLA/budget attribution. */
/**
 * Approval copy for a checkpoint node — a GENERIC preview of whatever
 * side-effecting action the checkpoint guards (any integration, HTTP request,
 * or agent task), so the operator sees exactly what they're approving. Not
 * specialised to any one connector.
 */
/**
 * The required fields a human_input submission is missing. A field is present
 * when its key exists with a non-empty value; a boolean `false` counts as
 * present (an explicit negative decision), an empty string / null / undefined
 * does not. Non-required fields never block completion.
 */
function missingRequiredHumanInputFields(
  config: HumanInputNodeConfig,
  submitted: Record<string, unknown>,
): string[] {
  const fields = Array.isArray(config.fields) ? config.fields : [];
  const missing: string[] = [];
  for (const field of fields) {
    if (!field?.required) continue;
    const value = submitted[field.key];
    const present = value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');
    if (!present) missing.push(field.label?.trim() || field.key);
  }
  return missing;
}

function checkpointApprovalCopy(
  ctx: RunningContext,
  node: WorkflowNode,
  inputData: Record<string, unknown>,
): { title: string; summary: string; payload: Record<string, unknown> } {
  const action = checkpointGuardedAction(ctx, node, inputData);
  if (!action) {
    return {
      title: node.title || 'Checkpoint approval',
      summary: `Approve to continue workflow run ${ctx.runId}.`,
      payload: {
        approvalPreview: {
          kind: 'checkpoint',
          runId: ctx.runId,
          workflowId: ctx.workflowId,
          gatedNode: approvalNodeRef(node),
          input: redactApprovalPreviewValue(inputData),
          assets: collectApprovalAssets(inputData),
          records: extractApprovalRecords(inputData),
        },
      },
    };
  }
  const title = node.title && !/^checkpoint\b/i.test(node.title)
    ? node.title
    : `Approve: ${action.label}`;
  const parts = [`Approve running ${action.label}.`];
  for (const [key, value] of action.fields) parts.push(`${key}: ${value}.`);
  const sourcePreview = {
    upstream: inputData,
    resolvedAction: action.payload,
  };
  return {
    title,
    summary: parts.join(' '),
    payload: {
      approvalPreview: {
        kind: 'checkpoint',
        runId: ctx.runId,
        workflowId: ctx.workflowId,
        gatedNode: approvalNodeRef(node),
        action: {
          nodeId: action.nodeId,
          title: action.nodeTitle,
          type: action.nodeType,
          kind: action.kind,
          label: action.label,
          fields: action.fields.map(([key, value]) => ({ key, value })),
        },
        input: redactApprovalPreviewValue(inputData),
        resolvedAction: redactApprovalPreviewValue(action.payload),
        assets: collectApprovalAssets(sourcePreview),
        records: extractApprovalRecords(sourcePreview),
      },
    },
  };
}

/**
 * Describe the next side-effecting node a checkpoint gates, with a compact,
 * resolved preview of its inputs. Works for any integration / http_request /
 * agent node — connector-agnostic.
 */
function checkpointGuardedAction(
  ctx: RunningContext,
  node: WorkflowNode,
  inputData: Record<string, unknown>,
): {
  nodeId: string;
  nodeTitle: string;
  nodeType: string;
  kind: string;
  label: string;
  fields: Array<[string, string]>;
  payload: Record<string, unknown>;
} | null {
  const target = (ctx.downstreamEdges.get(node.id) ?? [])
    .map((edge) => ctx.graph.nodes.find((candidate) => candidate.id === edge.target))
    .find((candidate): candidate is WorkflowNode => {
      const kind = (candidate?.config as { kind?: string } | undefined)?.kind;
      return kind === 'integration' || kind === 'http_request' || kind === 'agent_task' || kind === 'agent_session';
    });
  if (!target) return null;

  const tctx = checkpointTemplateContext(ctx, inputData);
  const cfg = target.config as Record<string, unknown> & { kind?: string };

  if (cfg.kind === 'integration') {
    const integrationId = String(cfg.integrationId ?? 'integration');
    const op = cfg.operationId ? ` · ${String(cfg.operationId)}` : '';
    const inputs = resolveTemplateDeep((cfg.inputs as Record<string, unknown>) ?? {}, tctx) as Record<string, unknown>;
    return {
      ...approvalActionRef(target, cfg.kind),
      label: `${target.title || integrationId} (${integrationId}${op})`,
      fields: previewFields(inputs),
      payload: { integrationId, operationId: cfg.operationId ?? null, inputs },
    };
  }
  if (cfg.kind === 'http_request') {
    const url = resolveTemplate(String(cfg.url ?? ''), tctx);
    const method = String(cfg.method ?? 'GET').toUpperCase();
    const headers = resolveTemplateDeep((cfg.headers as Record<string, unknown>) ?? {}, tctx) as Record<string, unknown>;
    const body = resolveTemplateDeep((cfg as { body?: unknown }).body ?? {}, tctx);
    return {
      ...approvalActionRef(target, cfg.kind),
      label: `${target.title || 'HTTP request'} (${method} ${url ? redactUrl(url) : 'unset URL'})`,
      fields: previewFields({ url: redactUrl(url), method, body }),
      payload: { method, url: redactUrl(url), headers, body },
    };
  }
  // agent_task / agent_session
  const prompt = previewText(resolveTemplate(String((cfg as { prompt?: unknown }).prompt ?? ''), tctx));
  return {
    ...approvalActionRef(target, cfg.kind ?? 'agent_task'),
    label: target.title || 'agent task',
    fields: prompt ? [['Task', prompt]] : [],
    payload: {
      prompt,
      agentId: typeof cfg.agentId === 'string' ? cfg.agentId : null,
      sessionId: typeof cfg.sessionId === 'string' ? cfg.sessionId : null,
    },
  };
}

function approvalNodeRef(node: WorkflowNode): Record<string, unknown> {
  const cfg = node.config as { kind?: unknown } | undefined;
  return {
    id: node.id,
    title: node.title ?? node.id,
    type: node.type,
    kind: typeof cfg?.kind === 'string' ? cfg.kind : null,
  };
}

function approvalActionRef(node: WorkflowNode, kind: string): {
  nodeId: string;
  nodeTitle: string;
  nodeType: string;
  kind: string;
} {
  return {
    nodeId: node.id,
    nodeTitle: node.title || node.id,
    nodeType: node.type,
    kind,
  };
}

/** First few non-empty, resolved input fields of a node, for a compact approval preview. */
function previewFields(inputs: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(inputs ?? {})) {
    const preview = previewText(value);
    if (preview) out.push([key, preview]);
    if (out.length >= 5) break;
  }
  return out;
}

const APPROVAL_SECRET_KEY = /(password|secret|token|api[-_ ]?key|service[-_ ]?role|credential|authorization|bearer|private[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret)/i;
const APPROVAL_RECORD_KEY = /^(store_identity|brand_config|brandConfig|storeIdentity|records|diff|tables)$/i;

function redactApprovalPreviewValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[Truncated]';
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactApprovalPreviewValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = APPROVAL_SECRET_KEY.test(key) ? '[Redacted]' : redactApprovalPreviewValue(nested, depth + 1);
  }
  return out;
}

function extractApprovalRecords(value: unknown): Record<string, unknown> | undefined {
  const records: Record<string, unknown> = {};
  const visit = (node: unknown, depth: number) => {
    if (depth > 6 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 60)) visit(item, depth + 1);
      return;
    }
    for (const [key, nested] of Object.entries(node as Record<string, unknown>)) {
      if (APPROVAL_RECORD_KEY.test(key)) {
        records[key] = redactApprovalPreviewValue(nested);
      } else if (nested && typeof nested === 'object') {
        visit(nested, depth + 1);
      }
    }
  };
  visit(value, 0);
  return Object.keys(records).length > 0 ? records : undefined;
}

function collectApprovalAssets(value: unknown): Array<Record<string, unknown>> {
  const assets: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const push = (asset: Record<string, unknown>) => {
    const key = String(asset.artifactId ?? asset.ref ?? asset.url ?? '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    assets.push(asset);
  };
  const visit = (node: unknown, depth: number) => {
    if (depth > 8 || assets.length >= 16 || !node) return;
    if (typeof node === 'string') {
      if (/^artifact:[\w-]+/.test(node)) {
        push({ ref: node, artifactId: node.replace(/^artifact:/, ''), title: 'Artifact', type: 'artifact' });
      } else if (/^https?:\/\/.+\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i.test(node) || /^data:image\//i.test(node)) {
        push({ url: node, title: 'Image preview', type: 'image' });
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 80)) visit(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const artifactId = typeof obj.artifactId === 'string' ? obj.artifactId : typeof obj.id === 'string' && obj.type === 'artifact' ? obj.id : null;
    const ref = typeof obj.ref === 'string' ? obj.ref : null;
    const url = typeof obj.url === 'string' ? obj.url : typeof obj.thumbnailUrl === 'string' ? obj.thumbnailUrl : null;
    const mimeType = typeof obj.mimeType === 'string' ? obj.mimeType : null;
    const type = typeof obj.type === 'string' ? obj.type : mimeType?.startsWith('image/') ? 'image' : undefined;
    if (artifactId || ref || url) {
      push({
        ...(artifactId ? { artifactId } : {}),
        ...(ref ? { ref } : {}),
        ...(url ? { url } : {}),
        title: typeof obj.title === 'string' ? obj.title : typeof obj.name === 'string' ? obj.name : artifactId ?? ref ?? 'Asset',
        ...(type ? { type } : {}),
        ...(mimeType ? { mimeType } : {}),
      });
    }
    for (const nested of Object.values(obj)) visit(nested, depth + 1);
  };
  visit(value, 0);
  return assets;
}

function checkpointTemplateContext(ctx: RunningContext, inputData: Record<string, unknown>): TemplateContext {
  const nodeOutputs: Record<string, Record<string, unknown>> = {};
  for (const [id, ns] of Object.entries(ctx.state.nodeStates)) {
    if (ns.outputData) nodeOutputs[id] = ns.outputData as Record<string, unknown>;
  }
  const triggerNode = ctx.graph.nodes.find((candidate) => candidate.type === 'trigger');
  const triggerInputs = triggerNode
    ? (ctx.state.nodeStates[triggerNode.id]?.inputData as Record<string, unknown> | undefined)
    : undefined;
  return buildTemplateContext({
    inputData,
    triggerInputs: triggerInputs ?? inputData,
    nodeOutputs,
    graphNodes: ctx.graph.nodes,
    scratchpad: ctx.scratchpad?.snapshot ?? {},
    store: {},
    workspace: { id: ctx.workspaceId, kv: {} },
    run: { id: ctx.runId, startedAt: ctx.startedAt },
  });
}

function previewText(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    const joined = value.map((item) => previewText(item)).filter(Boolean).join(', ');
    return joined || undefined;
  }
  const text = asString(value).replace(/\s+/g, ' ').trim();
  if (!text || text === '{}') return undefined;
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function phaseIdForNode(graph: WorkflowGraph, nodeId: string): string | null {
  for (const phase of graph.phases ?? []) {
    if (phase.nodeIds?.includes(nodeId)) return phase.id;
  }
  return null;
}

/** Best identifier for the actor behind a node — agent id/role for agent nodes, else 'engine'. */
function nodeActorId(node: WorkflowNode): string {
  const cfg = node.config as { kind?: string; agentId?: string; agentRole?: string };
  if (cfg.kind === 'agent_task' || cfg.kind === 'agent_swarm') {
    return cfg.agentId ?? cfg.agentRole ?? 'agent';
  }
  return 'engine';
}

/** Declared per-node cost estimate (cents), if the node carries one. */
function nodeCostCents(node: WorkflowNode): number | null {
  const c = (node.config as { estimatedCostCents?: unknown }).estimatedCostCents;
  return typeof c === 'number' ? c : null;
}

/** Short, log-safe preview of a node payload for the audit trail. */
function summarizeForAudit(value: unknown): string | null {
  if (value == null) return null;
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return s.length > 280 ? `${s.slice(0, 279)}…` : s;
  } catch {
    return null;
  }
}

/** Best-effort JSON for embedding input data in a tool-loop task prompt. */
function safeJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s.length > 4_000 ? `${s.slice(0, 3_999)}…` : s;
  } catch {
    return String(value);
  }
}


/**
 * Build the PROCESS BRIEFING appended to an agent_task's prompt — the structural
 * guarantee that an agent inside a workflow node UNDERSTANDS the process it is in,
 * not just its local instruction. It is derived entirely from the live graph (no
 * DB calls, no guessing), so it always matches the real run:
 *
 *   • WHERE it sits — its step, what upstream nodes feed it (so the input blob has
 *     provenance), and what downstream nodes consume its output.
 *   • WHAT IT MUST RETURN — the declared output keys with an INFERRED TYPE and a
 *     concrete JSON example (the old contract gave key NAMES only, so the agent
 *     guessed shapes and missed the contract → self-heal churn).
 *   • THE FLOW RULES — why the contract is non-negotiable: the run routes off this
 *     output, so an empty-but-complete object is success and a missing key stalls
 *     or misroutes the whole workflow.
 *
 * This is scaffolding, not a cage: it never constrains HOW the agent works or what
 * tools it uses — it only makes the contract and the surrounding process legible.
 */
export function buildNodeProcessBriefing(graph: WorkflowGraph, node: WorkflowNode, config: { outputKeys?: string[] }): string {
  const outputKeys = (config.outputKeys ?? []).map((key) => key.trim()).filter(Boolean);
  const nodeById = new Map(graph.nodes.map((candidate) => [candidate.id, candidate] as const));
  const upstream = graph.edges.filter((edge) => edge.target === node.id);
  const downstream = graph.edges.filter((edge) => edge.source === node.id);

  const lines: string[] = [
    '',
    '',
    'PROCESS BRIEFING — you are ONE node inside a running Agentis workflow. Use this so your output keeps the whole run flowing (it does not limit how you work):',
    `- YOUR STEP: "${node.title}".`,
  ];

  const goal = workflowGoalLine(graph);
  if (goal) lines.push(goal);

  if (upstream.length > 0) {
    lines.push('- FEEDS INTO YOU (your input data was produced by these upstream steps):');
    for (const edge of upstream) {
      const src = nodeById.get(edge.source);
      if (!src) continue;
      const keys = nodeOutputKeys(src);
      lines.push(`    • "${src.title}"${keys.length ? ` → ${keys.join(', ')}` : ''}`);
    }
  } else {
    lines.push('- FEEDS INTO YOU: the workflow trigger input.');
  }

  if (outputKeys.length > 0) {
    lines.push(
      '',
      'OUTPUT CONTRACT — return EXACTLY one strict JSON object with these top-level keys (no markdown, no code fences, no prose). Shape:',
      '{',
    );
    outputKeys.forEach((key, index) => {
      const info = inferContractKey(key, graph, downstream);
      const comma = index < outputKeys.length - 1 ? ',' : '';
      lines.push(`  ${JSON.stringify(key)}: ${info.example}${comma}   // ${info.type}${info.note ? ` — ${info.note}` : ''}`);
    });
    lines.push('}');
  }

  if (downstream.length > 0) {
    lines.push('', 'WHAT YOUR OUTPUT DRIVES NEXT (the run routes off these — a missing or wrong key stalls or misroutes it):');
    for (const edge of downstream) {
      const tgt = nodeById.get(edge.target);
      if (!tgt) continue;
      const cond = edge.condition?.trim();
      lines.push(`    • "${tgt.title}"${cond ? ` — runs only when: ${cond}` : ''}`);
    }
  }

  lines.push(
    '',
    'FLOW RULES (these keep the run alive — they are correctness, not style):',
    ...(outputKeys.length > 0
      ? [
        '- Return EVERY key above on EVERY run, even when there is nothing to do: [] for an empty list, a safe default for scalars, and set boolean gates honestly (e.g. {"passed": false}). Never omit a key.',
        '- Do NOT fail or refuse just because the result is empty — emitting the empty-but-complete contract IS success; it lets the downstream branches route correctly.',
        '- Return ONLY the JSON object. No explanation before or after, no markdown fences.',
      ]
      : [
        '- Complete the step and return your result as the node output. Do not fail just because the result is empty — say so plainly so the run can continue.',
      ]),
  );

  return lines.join('\n');
}

/**
 * The workflow's end goal, summarized from its declared final output contract so
 * the agent understands the WHOLE objective it is contributing to — not just its
 * local step. Graph-derived (no DB); returns null when the workflow declares no
 * output contract.
 */
function workflowGoalLine(graph: WorkflowGraph): string | null {
  const fields = (graph.outputContract?.fields ?? []).filter((field) => field.key?.trim());
  if (fields.length === 0) return null;
  const summary = fields
    .map((field) => (field.description?.trim() ? `${field.key} (${field.description.trim()})` : field.key))
    .join(', ');
  return `- THE WORKFLOW'S GOAL: produce → ${summary}. Your step contributes to that end.`;
}

/** Output keys a node advertises (agent/session/swarm and other declared kinds). */
function nodeOutputKeys(node: WorkflowNode): string[] {
  const config = node.config as { outputKeys?: unknown };
  return Array.isArray(config.outputKeys)
    ? config.outputKeys.filter((key): key is string => typeof key === 'string' && key.trim().length > 0)
    : [];
}

/**
 * Infer the type + a concrete JSON example for one declared output key, plus a
 * note on how the run uses it. Prefers the workflow's typed `outputContract`;
 * otherwise reads the key name; and flags keys a downstream edge branches on.
 */
function inferContractKey(
  key: string,
  graph: WorkflowGraph,
  downstream: WorkflowGraph['edges'],
): { type: string; example: string; note?: string } {
  const declared = graph.outputContract?.fields?.find((field) => field.key === key);
  const type = declared && declared.type !== 'any' ? declared.type : inferTypeFromKeyName(key);
  const branches = downstream.some((edge) => edge.condition && new RegExp(`\\b${escapeRegExp(key)}\\b`).test(edge.condition));
  const note = branches
    ? 'the run BRANCHES on this — set it correctly'
    : declared?.description?.trim() || undefined;
  return { type, example: exampleForContractType(type), note };
}

function inferTypeFromKeyName(key: string): 'string' | 'number' | 'boolean' | 'array' | 'object' {
  const k = key.toLowerCase();
  // Prefix checks use the ORIGINAL key with a camelCase/underscore boundary so
  // "canDeploy" → boolean but "candidates" (which merely starts with "can") does not.
  if (/^(is|has|should|can|did|was|are|needs|allow|will)([A-Z_]|$)/.test(key)
    || /(passed|ready|valid|enabled|done|sent|skip|skipped|success|approved|exhausted|complete|completed|finished|found|blocked|present|exists|ok)$/.test(k)) return 'boolean';
  if (/(count|number|num|total|score|amount|qty|quantity|index|size|length|rank|cents|price)$/.test(k) || /^(count|num)([A-Z_]|$)/.test(key)) return 'number';
  if (/(list|items|results|articles|entries|rows|records|messages|urls|links|ids|tags|candidates|leads|matches|sources|chunks|handles|queries|blockers|errors|warnings|reasons|signals|notes|steps|events|logs)$/.test(k)
    || /(handles|queries|blockers|candidates|results|leads|records|signals|errors|warnings|reasons)/.test(k)) return 'array';
  if (/(data|payload|record|meta|metadata|config|map|object|details)$/.test(k)) return 'object';
  return 'string';
}

function exampleForContractType(type: string): string {
  switch (type) {
    case 'boolean': return 'false';
    case 'number': return '0';
    case 'array': return '[]';
    case 'object': return '{}';
    default: return '"…"';
  }
}

/** The empty-but-valid default value for an inferred output type — used to
 *  complete an agent's declared contract when a metadata key is genuinely absent
 *  (empty-but-complete = success), instead of hard-failing the run. */
function typedEmptyDefault(type: 'string' | 'number' | 'boolean' | 'array' | 'object'): unknown {
  switch (type) {
    case 'array': return [];
    case 'boolean': return false;
    case 'number': return 0;
    case 'object': return {};
    default: return '';
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface DeclaredOutputNormalizationResult {
  output: Record<string, unknown>;
  declaredKeys: string[];
  missingKeys: string[];
  recoveredKeys: string[];
  /** Keys the agent genuinely omitted, completed with a typed-empty default. */
  defaultedKeys: string[];
}

function outputNormalization(output: Record<string, unknown>): DeclaredOutputNormalizationResult {
  return { output, declaredKeys: [], missingKeys: [], recoveredKeys: [], defaultedKeys: [] };
}

function normalizeDeclaredNodeOutput(node: WorkflowNode, output: Record<string, unknown>): Record<string, unknown> {
  return normalizeDeclaredNodeOutputResult(node, output).output;
}

function normalizeDeclaredNodeOutputResult(node: WorkflowNode, output: Record<string, unknown>, opts?: { fillTypedDefaults?: boolean }): DeclaredOutputNormalizationResult {
  const keys = declaredOutputKeys(node);
  if (keys.length === 0) return outputNormalization(output);
  const parsed = parseStructuredOutputEnvelope(output);
  const normalized: Record<string, unknown> = parsed ? { ...output, ...parsed } : { ...output };
  const recovered = new Set<string>();
  if (parsed) {
    for (const key of keys) {
      if (!isOutputValuePresent(output[key]) && isOutputValuePresent(parsed[key])) {
        recovered.add(key);
      }
    }
  }

  for (const key of keys) {
    if (isOutputValuePresent(normalized[key])) continue;
    const aliasValue = firstOutputAliasValue(normalized, key);
    if (isOutputValuePresent(aliasValue)) {
      normalized[key] = aliasValue;
      recovered.add(key);
      continue;
    }
    const inferredCount = inferCountValue(normalized, key);
    if (isOutputValuePresent(inferredCount)) {
      normalized[key] = inferredCount;
      recovered.add(key);
      continue;
    }
    if (looksCollectionOutputKey(key) && outputDeclaresZeroItems(normalized)) {
      normalized[key] = [];
      recovered.add(key);
    }
  }
  if (keys.length === 1 && !isOutputValuePresent(normalized[keys[0]!])) {
    const text = firstOutputAliasValue(normalized, keys[0]!) ?? outputTextEnvelope(output);
    if (isOutputValuePresent(text)) {
      normalized[keys[0]!] = text;
      recovered.add(keys[0]!);
    }
  }
  let missing = keys.filter((key) => !isOutputValuePresent(normalized[key]));
  const defaultedKeys: string[] = [];
  // Intelligent adaptation: complete genuinely-absent declared keys with a
  // typed-empty default (candidates: [], exhausted: false, …) so an agent that
  // did real work but omitted a metadata key satisfies its contract instead of
  // hard-failing. Gated by the caller (only when the node produced usable output).
  if (opts?.fillTypedDefaults && missing.length > 0) {
    for (const key of missing) {
      normalized[key] = typedEmptyDefault(inferTypeFromKeyName(key));
      defaultedKeys.push(key);
    }
    missing = [];
  }
  return {
    output: normalized,
    declaredKeys: keys,
    missingKeys: missing,
    recoveredKeys: [...recovered].filter((key) => !missing.includes(key) && !defaultedKeys.includes(key)),
    defaultedKeys,
  };
}

function missingDeclaredOutputMessage(node: WorkflowNode, missing: string[]): string {
  return `agent node '${node.id}' did not produce declared output key(s): ${missing.join(', ')}`;
}

function isEvidenceBearingOutputContract(keys: string[]): boolean {
  const normalized = new Set(keys.map(normalizeOutputKey));
  const has = (...candidates: string[]) => candidates.some((key) => normalized.has(normalizeOutputKey(key)));
  if (has('provider_ack', 'delivery_receipt', 'provider_message_id', 'message_id')) return true;
  if (has('sent_count') && has('status', 'failed_count', 'verified')) return true;
  return has('verified') && has('duplicates', 'missing_acks');
}

/**
 * Honest failure reason for an agent node. When the agent produced NO usable
 * output at all (the common "harness returned empty / exited / bad model pin"
 * case), say that plainly instead of blaming the declared-output contract — the
 * misleading "missing keys" message sends self-heal (and the operator) chasing
 * an output-extraction problem that doesn't exist.
 */
function agentOutputFailureReason(output: Record<string, unknown>, originalError: string): string {
  return hasAnyUsableOutput(output)
    ? originalError
    : 'agent produced no usable output — its runtime returned empty or failed (check the agent has a working, connected model)';
}

function hasAnyUsableOutput(output: Record<string, unknown>): boolean {
  if (!output || typeof output !== 'object') return false;
  return Object.values(output).some((value) => {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true; // number / boolean
  });
}

function buildContractDeviation(
  node: WorkflowNode | undefined,
  result: DeclaredOutputNormalizationResult,
): WorkflowNodeContractDeviation {
  const missing = result.missingKeys;
  const message = node
    ? missingDeclaredOutputMessage(node, missing)
    : `node did not produce declared output key(s): ${missing.join(', ')}`;
  return {
    kind: 'missing_declared_output_keys',
    declaredKeys: result.declaredKeys,
    missingKeys: missing,
    recoveredKeys: result.recoveredKeys,
    message,
    outputPreview: compactRealtimePayload(result.output),
  };
}

/**
 * The full tool surface a workflow agent_task receives: its role manifest, the
 * universal knowledge-worker floor (DEFAULT_SPECIALIST_TOOLS — search, browser,
 * brain, data, compute), and the tools its declared capabilities imply. Tags and
 * `requires` are ADDITIVE — declaring a capability now actually grants its tools,
 * and no agent drops below the floor. This is the "agents have their total
 * abilities and are driven by Agentis capacities" fix.
 */
function resolveAgentTaskTools(def: SpecialistDefinition, config: AgentTaskNodeConfig): AgentTool[] {
  const set = new Set<AgentTool>([...effectiveSpecialistTools(def), ...DEFAULT_SPECIALIST_TOOLS]);
  const tags = (config.capabilityTags ?? []).map((t) => String(t).toLowerCase());
  const wants = (...kw: string[]): boolean => tags.some((t) => kw.some((k) => t.includes(k)));
  const requires = config.requires as { fileSystem?: boolean; terminal?: boolean } | undefined;
  if (requires?.fileSystem || wants('code', 'develop', 'engineer', 'file', 'refactor', 'debug')) {
    set.add('read_file');
    set.add('write_file');
    set.add('search_code');
  }
  if (requires?.terminal || wants('git', 'deploy', 'ci', 'code')) {
    set.add('git_status');
    set.add('git_diff');
  }
  return [...set];
}


function parseStructuredOutputEnvelope(output: Record<string, unknown>): Record<string, unknown> | null {
  const objectEnvelope = objectOutputEnvelope(output);
  if (objectEnvelope) return objectEnvelope;
  const text = outputTextEnvelope(output);
  return text ? parseGeneric(text) : null;
}

function objectOutputEnvelope(output: Record<string, unknown>): Record<string, unknown> | null {
  for (const key of ['output', 'result', 'content', 'message', 'response', 'answer', 'body', 'digest']) {
    const value = output[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

function outputTextEnvelope(output: Record<string, unknown>): string | null {
  for (const key of ['text', 'output', 'result', 'content', 'message', 'response', 'answer', 'body', 'markdown', 'markdownBody', 'html', 'htmlBody', 'digest']) {
    const value = output[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function firstOutputAliasValue(output: Record<string, unknown>, key: string): unknown {
  for (const alias of outputAliasesForKey(key)) {
    const value = output[alias];
    if (isOutputValuePresent(value)) return value;
  }
  return undefined;
}

function inferCountValue(output: Record<string, unknown>, key: string): number | undefined {
  const normalized = normalizeOutputKey(key);
  if (!normalized.endsWith('count')) return undefined;
  for (const alias of countSourceAliasesForKey(key)) {
    const value = output[alias];
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
}

function outputAliasesForKey(key: string): string[] {
  const normalized = normalizeOutputKey(key);
  const aliases = new Set<string>([key]);
  if (
    normalized.includes('body')
    || normalized.includes('content')
    || normalized.includes('markdown')
    || normalized.includes('message')
    || normalized.includes('digest')
    || normalized.includes('summary')
    || normalized.includes('report')
    || normalized.includes('analysis')
    || normalized.includes('finding')
    || normalized === 'result'
  ) {
    for (const alias of bodyAliasesForKey(normalized)) {
      aliases.add(alias);
    }
  }
  if (normalized.includes('subject') || normalized.includes('title')) {
    aliases.add('subject');
    aliases.add('title');
  }
  if (looksCollectionOutputKey(key)) {
    for (const alias of collectionAliasesForKey(normalized)) {
      aliases.add(alias);
    }
  }
  return [...aliases];
}

function normalizeOutputKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function bodyAliasesForKey(normalized: string): string[] {
  if (normalized.includes('html')) {
    return ['htmlBody', 'html', 'body', 'content', 'message', 'digest', 'output', 'result', 'answer', 'response'];
  }
  if (normalized.includes('markdown')) {
    return ['markdownBody', 'markdown', 'body', 'content', 'text', 'message', 'digest', 'summary', 'report', 'analysis', 'findings', 'output', 'result', 'answer', 'response'];
  }
  return ['body', 'content', 'text', 'message', 'digest', 'summary', 'report', 'analysis', 'findings', 'output', 'result', 'answer', 'response', 'markdownBody', 'markdown', 'htmlBody', 'html'];
}

function collectionAliasesForKey(normalized: string): string[] {
  if (normalized.includes('sent') && normalized.includes('story') && normalized.includes('key')) {
    return ['sentStoryKeys', 'storyKeys', 'sentKeys', 'keys'];
  }
  if (normalized.includes('story') || normalized.includes('stori')) {
    return ['topStories', 'stories', 'articles', 'items', 'results'];
  }
  if (normalized.includes('article')) {
    return ['articles', 'stories', 'items', 'results'];
  }
  if (normalized.includes('key')) {
    return ['keys', 'storyKeys'];
  }
  if (normalized.includes('record')) return ['records', 'rows', 'items', 'results'];
  if (normalized.includes('row')) return ['rows', 'records', 'items', 'results'];
  return ['items', 'results', 'records', 'rows'];
}

function countSourceAliasesForKey(key: string): string[] {
  const normalized = normalizeOutputKey(key);
  if (normalized === 'sentcount') return ['sentStoryKeys', 'sentKeys'];
  const stem = normalized.replace(/count$/, '');
  const rawStem = key.replace(/count$/i, '');
  const aliases = new Set<string>([
    rawStem,
    `${rawStem}s`,
    `${rawStem}Items`,
    `${rawStem}Records`,
    `${rawStem}Rows`,
    `${stem}s`,
    `${stem}Items`,
    `${stem}Records`,
    `${stem}Rows`,
  ].filter(Boolean));
  for (const alias of collectionAliasesForKey(stem)) aliases.add(alias);
  return [...aliases];
}

function looksCollectionOutputKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.endsWith('s')
    || normalized.includes('list')
    || normalized.includes('items')
    || normalized.includes('keys')
    || normalized.includes('records')
    || normalized.includes('rows');
}

function outputDeclaresZeroItems(output: Record<string, unknown>): boolean {
  return Object.entries(output).some(([key, value]) => /count$/i.test(key) && Number(value) === 0);
}

function isOutputValuePresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function nodeIdFromTargetPath(graph: WorkflowGraph, targetPath: string): string | null {
  const path = targetPath.trim().replace(/^\{\{\s*|\s*\}\}$/g, '');
  const nodesBySpecificity = [...graph.nodes].sort((a, b) => b.id.length - a.id.length);
  for (const node of nodesBySpecificity) {
    if (
      path === node.id
      || path === `nodes.${node.id}`
      || path.startsWith(`${node.id}.`)
      || path.startsWith(`nodes.${node.id}.`)
    ) {
      return node.id;
    }
  }
  return null;
}

function agentConfiguredModel(agent: { runtimeModel?: string | null; config?: unknown } | null | undefined): string | null {
  const runtimeModel = stringValue(agent?.runtimeModel);
  if (runtimeModel) return runtimeModel;
  const raw = agent?.config;
  let config: Record<string, unknown> | null = null;
  try {
    config = typeof raw === 'string'
      ? JSON.parse(raw) as Record<string, unknown>
      : raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : null;
  } catch {
    return null;
  }
  return stringValue(config?.model);
}


function evaluationAgentBindingFromNode(
  node: WorkflowNode | undefined,
): { agentId: string; preferredModel?: string } | null {
  if (!node) return null;
  const config = node.config as { kind?: string; agentId?: unknown; modelOverride?: unknown };
  if (
    typeof config.agentId === 'string'
    && (
      config.kind === 'agent_task'
      || config.kind === 'agent_session'
      || config.kind === 'agent_swarm'
      || config.kind === 'planner'
    )
  ) {
    return {
      agentId: config.agentId,
      ...(typeof config.modelOverride === 'string' && config.modelOverride
        ? { preferredModel: config.modelOverride }
        : {}),
    };
  }
  return null;
}

/** Project a subset of keys from an input map. Missing keys are dropped. */
function pickKeys(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in input) out[key] = input[key];
  }
  return out;
}

/** Adapt a `useSession` agent_task into the agent_session config shape. */
function agentTaskAsSession(cfg: AgentTaskNodeConfig): AgentSessionNodeConfig {
  return {
    kind: 'agent_session',
    agentId: cfg.agentId,
    agentRole: cfg.agentRole,
    prompt: cfg.prompt,
    inputKeys: [],
    outputKeys: cfg.outputKeys ?? [],
    maxSteps: cfg.maxToolSteps,
    capabilityTags: cfg.capabilityTags ?? [],
    requires: cfg.requires,
  };
}

/** Pull the textual payload out of a session's terminal output. */
function extractPlanText(output: Record<string, unknown>): string {
  const result = output.result ?? output.output ?? output;
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Parse a planner's reply into a clean task list. Prefers a JSON array embedded
 * anywhere in the text; falls back to non-empty lines. Bounded by `max`.
 */
function parseTaskList(text: string, max: number): string[] {
  if (!text || !text.trim()) return [];
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) {
        const tasks = parsed
          .map((t) => (typeof t === 'string' ? t : typeof t === 'object' && t ? safeJson(t) : String(t)))
          .map((t) => t.trim())
          .filter(Boolean);
        if (tasks.length > 0) return tasks.slice(0, max);
      }
    } catch {
      // fall through to line-splitting
    }
  }
  const lines = text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
  return lines.slice(0, max);
}


/** Best-effort artifact class from a filename + content shape. */
function inferArtifactType(name: string, content: string): 'html' | 'image' | 'document' | 'code' | 'data' {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['json', 'csv', 'tsv', 'yaml', 'yml'].includes(ext)) return 'data';
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'css'].includes(ext)) return 'code';
  if (['md', 'markdown', 'txt', 'pdf', 'docx'].includes(ext)) return 'document';
  const trimmed = content.trim();
  if (/^<!doctype html|^<html|^<h\d|^<div|^<body/i.test(trimmed)) return 'html';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'data';
  return 'document';
}

/** MIME type from filename + coarse artifact class. */
function contentTypeFor(name: string, type: 'html' | 'image' | 'document' | 'code' | 'data'): string {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  const byExt: Record<string, string> = {
    html: 'text/html', htm: 'text/html', md: 'text/markdown', markdown: 'text/markdown',
    json: 'application/json', csv: 'text/csv', pdf: 'application/pdf',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', txt: 'text/plain',
  };
  if (byExt[ext]) return byExt[ext];
  if (type === 'html') return 'text/html';
  if (type === 'image') return 'image/png';
  if (type === 'data') return 'application/json';
  if (type === 'code') return 'text/x-code-file';
  return 'text/plain';
}

/**
 * Layer the "current value" aliases onto a condition scope base. `input`,
 * `inputs`, and `output` all point at the same value (the node's merged input
 * for a router; the source node's output for an edge) - mirroring the unified
 * expression contract in `safeExpression`, so one condition string means the
 * same thing on a router branch and on a conditional edge.
 */
function withCurrentData(
  base: Record<string, unknown>,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return { ...base, input: data, inputs: data, output: data };
}

function shouldTraverseEdge(
  edge: WorkflowEdge,
  output: Record<string, unknown>,
  buildScope: () => Record<string, unknown>,
): boolean {
  if (edge.type === 'error') return false;
  if (edge.condition) {
    // P0.1: evaluate against the unified condition scope (real nodes/trigger/
    // store/workspace/run), built lazily so the no-condition path pays nothing.
    return evalCondition(edge.condition, buildScope());
  }
  if (edge.type === 'condition') {
    return implicitConditionEdgeResult(output);
  }
  return true;
}

function implicitConditionEdgeResult(output: Record<string, unknown> | unknown): boolean {
  if (typeof output === 'boolean') return output;
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const record = output as Record<string, unknown>;
    for (const key of ['passed', 'ok', 'approved', 'allow', 'allowed', 'continue', 'shouldContinue', 'go']) {
      if (typeof record[key] === 'boolean') return record[key] as boolean;
    }
  }
  return true;
}

/** Turn schema-only errors into an actionable graph diagnostic. */
function contextualizeNodeFailure(error: string, node: WorkflowNode | undefined): string {
  if (!node || !/connectionId/i.test(error) || !/(undefined|required|expected)/i.test(error)) return error;
  if (/Node .+ requires a configured connectionId/i.test(error)) return error;
  return `Node "${node.title}" (${node.id}) requires a configured connectionId. `
    + 'Configure its integration connection, or replace/remove this outbound node for a manual workflow. '
    + `Runtime detail: ${error}`;
}

function componentAsExtension(config: ComponentTaskNodeConfig): ExtensionTaskNodeConfig {
  return {
    kind: 'extension_task',
    extensionId: config.componentId,
    extensionSlug: config.componentSlug,
    operationName: config.operationName,
    version: config.version,
    inputMapping: config.inputMapping,
    outputMapping: config.outputMapping,
    timeoutMs: config.timeoutMs,
  };
}

function stableComponentIdentity(value: unknown): string {
  if (!value || typeof value !== 'object') return `${typeof value}:${String(value)}`;
  if (Array.isArray(value)) return `[${value.map(stableComponentIdentity).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${key}:${stableComponentIdentity(item)}`)
    .join(',')}}`;
}




// ───────────────────────────────────────────────────────────────────────────
// Convergence loop (`converge`) — module-scope helpers (AGENT-COOPERATION-10X).
// ───────────────────────────────────────────────────────────────────────────

/**
 * Normalize a friendly `pursue` config into the internal `converge` shape so the
 * one engine loop serves both (COGNITIVE-LOOPING-RFC §10). ASSESS + REFLECT
 * default ON for a Pursuit; a raw `converge` keeps them OFF for exact parity.
 */
function pursueConfigToConverge(cfg: PursueNodeConfig): ConvergeNodeConfig {
  const carryMap = { keep: 'accumulate', latest: 'replace', delta: 'diff' } as const;
  return {
    kind: 'converge',
    bodyWorkflowId: cfg.bodyWorkflowId,
    continuation: cfg.doneWhen,
    maxIterations: cfg.maxIterations,
    budget: cfg.budget,
    stallPolicy: cfg.stopWhenStalled
      ? { window: cfg.stopWhenStalled.after, on: cfg.stopWhenStalled.on }
      : undefined,
    stateKey: cfg.stateKey,
    carryStrategy: cfg.carry ? carryMap[cfg.carry] : undefined,
    isolation: cfg.isolation,
    preserve: cfg.preserve,
    assess: cfg.assess ?? true,
    maxPivots: cfg.maxPivots ?? 2,
  };
}
