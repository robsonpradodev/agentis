import type { ChatPlan, PlanLifecycleEvent } from './plan.js';

/**
 * Chat-agent loop types — CHAT-AGENT-LOOP.md §2.
 *
 * Shared between the API (HermesAdapter, chatToolCatalog, chatToolExecutor)
 * and the web app (ChatPanel SSE consumer, future streaming hooks).
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * Per-conversation permission mode (Claude-Code style), sticky per thread.
 * - `ask`  — act autonomously below the conversation's approval-risk threshold
 *            and ask before consequential actions (default).
 * - `plan` — propose a plan and block mutations this turn (maps to
 *            executionMode 'plan', enforced at the tool registry).
 * - `auto` — run everything without confirmation (bypass).
 */
export type ChatPermissionMode = 'ask' | 'plan' | 'auto';

/** How readily Ask mode escalates an action to the operator. */
export type ApprovalSensitivity = 'cautious' | 'balanced' | 'autonomous';
export type ToolRiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * Host-owned safety metadata. It is deliberately separate from `mutating`:
 * creating a local screenshot and deleting production data both mutate state,
 * but they should not have the same approval posture.
 */
export interface AgentisToolApprovalPolicy {
  riskLevel: ToolRiskLevel;
  reversible?: boolean;
  externalSideEffects?: boolean;
  destructive?: boolean;
  /** Protected action: Ask mode always pauses, regardless of sensitivity. */
  alwaysConfirm?: boolean;
}

/** Operator-facing quality/durability policy for a conversation turn. */
export type ConversationExecutionMode = 'auto' | 'quick' | 'deep' | 'mission';
export type EffectiveConversationExecutionMode = Exclude<ConversationExecutionMode, 'auto'>;
export type ConversationTurnStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'blocked'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface ChatAttachmentManifestEntry {
  artifactId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  status: 'ready' | 'unsupported' | 'failed';
  extraction: 'text' | 'document' | 'spreadsheet' | 'vision' | 'transcription' | 'none';
  extractedChars?: number;
  truncated?: boolean;
  error?: string;
}

export interface ChatContextManifest {
  version: 1;
  generatedAt: string;
  historyMessages: number;
  attachmentCount: number;
  attachments: ChatAttachmentManifestEntry[];
  sources: Array<{ id: string; label: string; status: 'included' | 'summarized' | 'unavailable'; chars?: number }>;
  warnings: string[];
}

/** The non-secret, operator-visible facts that actually governed one turn. */
export interface ChatExecutionEnvelope {
  version: 1;
  requestedMode: ConversationExecutionMode;
  effectiveMode: EffectiveConversationExecutionMode;
  classificationReason: string;
  adapterType: string;
  model: string | null;
  configuredReasoningEffort: string | null;
  effectiveReasoningEffort: string | null;
  fastMode: boolean;
  runtimeProfile?: string | null;
  cwd?: string | null;
  loadedSources: string[];
  toolMode: 'none' | 'caller_loop' | 'adapter_native';
  durable: boolean;
  createdAt: string;
  warnings: string[];
}

export interface ChatMessage {
  role: ChatRole;
  content: string | ChatContentBlock[];
  /** Present when role === 'tool'. Must match the tool_call id from the preceding assistant turn. */
  toolCallId?: string;
  /** Present when role === 'assistant' and the model requested tool invocations. */
  toolCalls?: ChatToolCall[];
}

export interface ChatContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  toolUseId?: string;
  name?: string;
  input?: unknown;
  content?: string;
}

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ChatConfirmationRequest {
  turnId: string;
  toolCall: {
    id: string;
    name: string;
    args: unknown;
  };
  title: string;
  body: string;
  impact?: {
    summary: string;
    details?: string[];
    riskLevel?: 'low' | 'medium' | 'high' | 'danger';
    reversible?: boolean;
    externalSideEffects?: boolean;
  };
  confirmLabel: string;
  cancelLabel: string;
  expiresAt: string;
}

/** A terminal reason is an execution fact, not a provider-specific error string. */
export type ChatFinishReason = 'stop' | 'tool_calls' | 'max_turns' | 'error' | 'length' | 'interrupted';

/**
 * Durable, operator-safe execution progress. `detail` is intentionally a
 * summary: adapters must never place private chain-of-thought in this record.
 */
export interface OperatorProgressEvent {
  id: string;
  kind: 'lifecycle' | 'tool' | 'progress' | 'artifact' | 'error';
  label: string;
  detail?: string;
  status: 'running' | 'success' | 'error';
  tool?: string;
  gatewayTool?: string;
  resourceId?: string;
  resourceType?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  conversationId?: string;
  runId?: string;
  agentId?: string;
}

export interface ChatTurnTrace {
  clientTurnId?: string;
  /** Durable conversation_turns identity when this chat is executing through the turn ledger. */
  durableTurnId?: string;
  /** Bounded nested-consultation lineage, used by chat tool handlers. */
  consultationId?: string;
  consultationDepth?: number;
  consultationAncestors?: string[];
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  finishReason?: ChatFinishReason;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted' | 'blocked';
}

/**
 * Provider-designated, operator-safe commentary emitted while a turn is
 * running. This is never raw chain-of-thought: adapters may only promote
 * explicit reasoning summaries or assistant preambles. `host` remains in the
 * source union only for replay compatibility with older persisted turns; new
 * turns do not manufacture host narration to fill runtime silence.
 */
export interface ChatCommentary {
  id: string;
  text: string;
  source: 'reasoning_summary' | 'assistant_preamble' | 'host';
  createdAt: string;
}

/** A replay-safe projection of a temporary team created from an interactive chat. */
export type ChatSwarmStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'blocked' | 'cancelled';
export type ChatSwarmWorkerStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'blocked' | 'cancelled';

export interface ChatSwarmWorker {
  id: string;
  role: string;
  task: string;
  status: ChatSwarmWorkerStatus;
  capabilityTags: string[];
  runtime?: string | null;
  latestProgress?: string | null;
  result?: unknown;
  error?: string | null;
  retryOfWorkerId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

/**
 * Operator-safe team state. It deliberately excludes private model reasoning;
 * progress is only explicit commentary, tool lifecycle or a short host status.
 */
export interface ChatSwarm {
  id: string;
  objective: string;
  status: ChatSwarmStatus;
  mergeStrategy: string;
  maxWorkers: number;
  maxParallel: number;
  steering: string[];
  synthesis?: string | null;
  error?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  workers: ChatSwarmWorker[];
}

/**
 * Durable, replay-safe projection of a conversation turn event. The stored
 * transport payload remains provider-compatible, while this envelope gives
 * every consumer (Chat, Home and Tech) the same scoped ordering and safe
 * operator-facing summary.
 */
export interface TurnEventV2 {
  version: 2;
  id: string;
  workspaceId: string;
  conversationId: string;
  turnId: string;
  agentId: string;
  runId?: string;
  seq: number;
  transportEvent: string;
  category: 'narration' | 'operation' | 'verification' | 'status';
  visibility: 'chat' | 'technical' | 'both';
  summary: string;
  /** Sanitized replay payload. Never contains private reasoning or secrets. */
  data: unknown;
  createdAt: string;
}

/**
 * Discriminated union streamed by `AgentAdapter.chat()`.
 * Consumers accumulate `text` deltas, act on `tool_call` events,
 * and terminate on `done`.
 */
export type ChatDelta =
  | { type: 'execution'; envelope: ChatExecutionEnvelope; context: ChatContextManifest }
  | ({ type: 'commentary' } & ChatCommentary)
  | { type: 'swarm'; swarm: ChatSwarm }
  | {
      type: 'agent_consultation';
      consultationId: string;
      phase: 'requested' | 'responding' | 'answered' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
      callerAgentId: string;
      targetAgentId: string;
      callerName?: string;
      targetName?: string;
      round: number;
      maxRounds: number;
      summary: string;
      status: 'running' | 'success' | 'error';
      createdAt: string;
    }
  | {
      type: 'suspension';
      suspensionId: string;
      phase: 'waiting' | 'resolved' | 'cancelled' | 'expired' | 'failed';
      conditionType?: string;
      audienceType?: string;
      summary: string;
      status: 'running' | 'success' | 'error';
      createdAt: string;
    }
  | {
      type: 'activity';
      id: string;
      label: string;
      detail?: string;
      phase: 'received' | 'context' | 'runtime' | 'tool' | 'workflow' | 'waiting' | 'complete' | 'error';
      status: 'running' | 'success' | 'error';
      startedAt?: string;
      completedAt?: string;
      durationMs?: number;
      workflowId?: string;
      runId?: string;
      nodeId?: string;
      agentId?: string;
      clientTurnId?: string;
      /** Normalized underlying operation; wrapper names remain only as gatewayTool. */
      tool?: string;
      gatewayTool?: string;
      /** Safe runtime diagnostics for workflow/run activity surfaces. */
      transport?: string;
      attempt?: number;
    }
  | { type: 'thinking'; delta: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | ({ type: 'confirmation_required' } & ChatConfirmationRequest)
  | { type: 'tool_result'; id: string; name: string; result: unknown; error?: string }
  | { type: 'plan'; event: PlanLifecycleEvent; plan: ChatPlan }
  // `length` = the model hit its output-token ceiling (typically a reasoning
  // model that spent the budget thinking and never emitted a final answer). It
  // is surfaced distinctly so the turn loop can recover (retry with more room)
  // instead of treating a truncated turn as a clean, empty stop.
  | {
      type: 'done';
      finishReason: ChatFinishReason;
      /** Provider-reported model usage; estimates are explicitly marked. */
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens?: number;
        costCents?: number;
        estimated?: boolean;
      };
    };

export type JsonSchemaObject = {
  type?: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchemaObject>;
  items?: JsonSchemaObject;
  required?: string[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
};

export interface ToolDefinition {
  name: string;
  description: string;
  examples?: Array<{
    description: string;
    input: Record<string, unknown>;
    expectedOutput?: unknown;
  }>;
  parameters: {
    type: 'object';
    properties: Record<string, JsonSchemaObject>;
    required?: string[];
  };
}

/** Runtime context injected into every chat turn, threaded through the tool executor. */
export interface ChatTurnContext {
  workspaceId: string;
  agentId: string;
  userId: string;
  conversationId: string;
  /** Durable mission whose outcome this turn is advancing. */
  missionId?: string;
  /**
   * When set, the turn runs in an Agentic App's context (Living Apps Phase 0):
   * datastore tools (`agentis.appData.*` / `data_insert`) resolve to this App, so
   * the agent persists what it learns where the App's surfaces read it.
   */
  appId?: string | null;
  /**
   * Brain-recall scope union for this turn (LIVING-APPS-10X · G11). When set, the
   * turn's `buildDispatchContext` recalls the UNION of these scopes instead of the
   * agent's scope alone — e.g. `[appId, agentId]` so a resident App turn sees both
   * the App's relationship brain and the operating agent's own memory. Omitted →
   * the agent's own scope (back-compat).
   */
  recallScopeIds?: string[];
  clientTurnId?: string;
  /** Durable conversation turn owning this runtime invocation, when available. */
  durableTurnId?: string;
  /** Internal A2A lineage. Never exposed to the customer transcript. */
  consultationId?: string;
  consultationDepth?: number;
  consultationAncestors?: string[];
  /** Attenuated tool surface inherited by a private consultant. */
  allowedToolIds?: string[];
  /** Private server-owned channel restart data; never serialized to customer messages. */
  channelContinuation?: Record<string, unknown>;
  /** Opaque server-issued capability for MCP calls made by this exact turn. */
  turnLease?: string;
  executionMode?: 'chat' | 'plan';
  /** Optional operation/run correlation id for direct tool turns. */
  runId?: string;
  /** Optional turn-level retention policy for tool-created assets. */
  artifactPolicy?: {
    mode?: 'intentional' | 'all' | 'none';
    saveScreenshots?: boolean;
    saveGeneratedAssets?: boolean;
  } | null;
  ambientId?: string | null;
  maxTurns?: number;
  /**
   * Per-conversation permission mode. Governs whether mutating tools confirm
   * (`ask`), are blocked behind a plan (`plan`), or run freely (`auto`).
   * Defaults to `ask` when unset.
   */
  permissionMode?: ChatPermissionMode;
  /** Ask-mode threshold. Defaults to `balanced`; ignored by Plan and Auto. */
  approvalSensitivity?: ApprovalSensitivity;
  /**
   * Verified transport origin for a turn that began on a messaging channel.
   * This is runtime authority context, not prompt prose: tool handlers use it
   * to prevent an external peer from inheriting the connection owner's account
   * privileges or silently redirecting a reply to another recipient.
   */
  channelOrigin?: ChannelToolOrigin;
  /** Effective quality class selected before the model is invoked. */
  qualityMode?: EffectiveConversationExecutionMode;
  viewport?: ViewportContext | null;
  
  signal?: AbortSignal;
}

/** Viewport metadata attached to each chat session for context-aware tool filtering. */
export interface ViewportContext {
  surface: AgentisSurface;
  route?: string;
  title?: string;
  workspaceId?: string;
  ambientId?: string | null;
  /** Active resource id on the current surface (e.g. workflowId, agentId, runId). */
  resourceId?: string;
  resourceKind?: 'workflow' | 'run' | 'agent' | 'artifact' | 'extension' | 'package' | 'ledger' | 'room' | 'app' | 'unknown';
  selection?: {
    ids?: string[];
    label?: string;
    kind?: string;
  } | null;
  activeRunId?: string | null;
  /**
   * Exact App-interface lease captured from the visible URL. UI authoring tools
   * must honor this target instead of guessing from an App-level ambient id.
   */
  appView?: {
    appId: string;
    page?: string;
    mode?: 'live' | 'ask' | 'edit' | 'history' | 'code';
    selectedNodeId?: string | null;
    facet?: string | null;
    targetLocked?: boolean;
  } | null;
  metadata?: Record<string, unknown>;
}

export type AgentisSurface =
  | 'home'
  | 'apps'
  | 'app_detail'
  | 'workflows'
  | 'workflow_detail'
  | 'agents'
  | 'agent_detail'
  | 'canvas'
  | 'runs'
  | 'run_detail'
  | 'run_modal'
  | 'artifacts'
  | 'artifact_detail'
  | 'packages'
  | 'extensions'
  | 'ledger'
  | 'history'
  | 'settings'
  | 'chat'
  | 'unknown';

export interface AgentisToolCallRequest {
  id: string;
  toolId: string;
  arguments: Record<string, unknown>;
}

export interface AgentisToolCallResult {
  id: string;
  toolId: string;
  ok: boolean;
  output?: unknown;
  errorCode?: string;
  errorMessage?: string;
  /** Directive remediation from an AgentisError — what the agent should DO next. Surfaced over MCP (§F7). */
  remediation?: string;
  /** Structured error details from an AgentisError (offending field, candidates, …). Surfaced over MCP. */
  details?: Record<string, unknown>;
  nextActions?: Array<{ toolId: string; rationale: string }>;
  costCents?: number;
  durationMs?: number;
}

export type AgentisToolFamily = 'build' | 'run' | 'inspect' | 'data' | 'environment' | 'app';

export interface AgentisToolDefinition {
  id: string;
  family: AgentisToolFamily;
  description: string;
  longDescription?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  mutating: boolean;
  /** How a successful mutation participates in durable chat-turn restoration. */
  mutationBehavior?: 'local' | 'mixed' | 'external' | 'none';
  /** Graduated Ask-mode policy. Unclassified mutations fail safe as high risk. */
  approval?: AgentisToolApprovalPolicy;
  autoExecute?: boolean;
  mcpExposed?: boolean;
  requires?: string[];
  examples?: Array<{
    description: string;
    input: Record<string, unknown>;
    expectedOutput?: unknown;
  }>;
}

export interface AgentisToolContext {
  workspaceId: string;
  userId: string;
  ambientId?: string | null;
  agentId?: string;
  runId?: string;
  conversationId?: string;
  /** Durable mission whose outcome this tool call advances. */
  missionId?: string;
  durableTurnId?: string;
  consultationId?: string;
  consultationDepth?: number;
  consultationAncestors?: string[];
  /** Attenuated tool surface inherited by a private consultant. */
  allowedToolIds?: string[];
  /** Private server-owned channel restart data; never serialized to customer messages. */
  channelContinuation?: Record<string, unknown>;
  permissionMode?: ChatPermissionMode;
  executionMode?: 'chat' | 'plan' | 'ask';
  /** Ask-mode threshold propagated across native MCP tool loops. */
  approvalSensitivity?: ApprovalSensitivity;
  /** Channel-side authority boundary propagated through caller and MCP loops. */
  channelOrigin?: ChannelToolOrigin;
  viewport?: ViewportContext | null;
  /**
   * Ambient Agentic App for this turn (Living Apps Phase 0). When set, App-scoped
   * tools (`agentis.appData.*` / `data_insert`) resolve to it without an explicit
   * `appId` — so a resident channel agent persists to its App's datastore.
   */
  appId?: string | null;
  /**
   * Tool-created asset retention for this turn/run. When omitted, tools should
   * treat screenshots and visual checks as transient unless explicitly saved.
   */
  artifactPolicy?: {
    mode?: 'intentional' | 'all' | 'none';
    saveScreenshots?: boolean;
    saveGeneratedAssets?: boolean;
  } | null;
  caller: 'chat' | 'workflow' | 'mcp' | 'system';
  /**
   * Cancellation signal propagated from the calling turn. A long, model-backed
   * tool (e.g. `agentis.build_workflow`) should honor it so an aborted turn stops
   * spending instead of running to completion in the background.
   */
  signal?: AbortSignal;
}

export type TurnChangeSetState = 'recording' | 'undoable' | 'undone' | 'failed';

export interface TurnChangeResourceSummary {
  kind: string;
  id: string;
  label: string;
  sensitive: boolean;
}

/** Redacted, UI-safe projection of the reversible work owned by one durable turn. */
export interface TurnChangeSummary {
  turnId: string;
  state: TurnChangeSetState;
  version: number;
  reversibleCount: number;
  sensitiveCount: number;
  externalEffectCount: number;
  affectedResources: TurnChangeResourceSummary[];
  updatedAt: string;
}

export interface TurnChangeConflict {
  resourceKind: string;
  resourceId: string;
  label: string;
  fields: string[];
  reason: 'overlapping_change' | 'missing_dependency' | 'constraint';
}

export interface TurnChangeActionResult {
  changeSet: TurnChangeSummary;
  conflicts?: TurnChangeConflict[];
  requiresSensitiveConfirmation?: boolean;
  externalEffectsRetained?: boolean;
}

/** Trusted facts about the channel request that initiated a tool-capable turn. */
export interface ChannelToolOrigin {
  kind: string;
  connectionId: string;
  chatId: string;
  /** Durable channel conversation whose ownership fences this tool-capable turn. */
  conversationId?: string;
  /** Provider message id that started this turn, used as the default quote target. */
  inboundMessageId?: string;
  durableTurnId?: string;
  consultationId?: string;
  consultationDepth?: number;
  consultationAncestors?: string[];
  permissionMode?: ChatPermissionMode;
  /** Ownership epoch captured before the turn began; mismatches cancel stale sends. */
  automationEpoch?: number;
  /** True only when this exact channel identity is explicitly linked to the owner. */
  ownerVerified: boolean;
  /** Explicit recipient addresses present in the initiating request, normalized by the channel host. */
  explicitRecipients?: string[];
}

export interface AgentisToolCatalog {
  tools: AgentisToolDefinition[];
  hash: string;
  generatedAt: string;
}



