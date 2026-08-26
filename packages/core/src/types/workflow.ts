/**
 * Workflow graph & run-state types.
 *
 * The shape of these types is the contract between the canvas, the engine,
 * and the persistence layer. Touch them here, then propagate.
 *
 * Mirrors V1-SPEC §6.2 and §6.3.
 */

import type { AgentRole } from './specialist.js';
import type { AgentRequirements } from './adapter.js';
import type { ListenerConfig } from './listener.js';

export type WorkflowNodeType =
  // Control flow
  | 'trigger'
  | 'router'
  | 'merge'
  | 'subflow'
  | 'wait'
  | 'loop'
  | 'parallel'
  // Data & logic — deterministic, zero LLM tokens
  | 'transform'
  | 'filter'
  | 'integration'
  | 'mcp'
  | 'data_query'
  | 'data_mutate'
  | 'aggregate_window'
  | 'http_request'
  | 'workflow_store'
  | 'workspace_store'
  | 'scratchpad'
  // Intelligence — LLM-powered
  | 'agent_task'
  | 'agent_session'
  | 'extension_task'
  | 'component_task'
  | 'agent_swarm'
  | 'dynamic_swarm'
  | 'planner'
  | 'evaluator'
  | 'guardrails'
  // Knowledge & enrichment
  | 'knowledge'
  | 'knowledge_ingest'     // write upstream content into the workspace Brain (KnowledgeBaseService)
  | 'artifact_collect'
  // Output surface — Layer 6
  | 'return_output'
  | 'artifact_save'
  // Native browser control — Layer 3 §3.2
  | 'browser'
  // Human interaction
  | 'checkpoint'
  | 'human_input'
  // Utility & data primitives (WORKFLOW-UPDATE — n8n-inspired) — deterministic
  | 'error_trigger'        // fires a workflow on another workflow's failure
  | 'stop_error'           // terminate the run with a custom error
  | 'code'
  | 'datetime'             // date/time parse, format, diff, add/subtract
  | 'crypto_util'          // hash, HMAC, base64 encode/decode, uuid
  | 'xml_parse'            // XML ↔ JSON
  | 'markdown'             // Markdown ↔ HTML
  | 'json_schema_validate' // validate data against a JSON Schema
  | 'sticky_note'          // canvas annotation; no execution
  | 'spreadsheet'          // parse/build .csv / .xlsx
  | 'html_extract'         // CSS-selector extraction from an HTML string
  | 'graphql';             // structured GraphQL query


export type OutputRenderAs = 'html' | 'markdown' | 'table' | 'json' | 'text';

// UI surfaces now live on the Agentic App, not the workflow graph
// (AGENTIC-APPS-10X §4 — the legacy fixed-block "Studio" was replaced by the
// AG-UI ViewNode protocol + app_surfaces). See packages/core/src/types/view.ts.

export interface WorkflowGraph {
  version: 1;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  viewport: { x: number; y: number; zoom: number };
  /** Optional input/output contracts — declared shape of what triggers this workflow + what it produces. */
  inputContract?: WorkflowContract;
  outputContract?: WorkflowContract;
  /** Named phase groups for large graphs. */
  phases?: WorkflowPhase[];
}

/**
 * Versioned, portable Workflow-as-Code document.
 *
 * This is separate from the persisted workflow row: IDs, workspace ownership,
 * run history, and deployment settings must not travel with a workflow. The
 * document is the stable unit for source control and Agentis Hub.
 */
export const WORKFLOW_FILE_API_VERSION = 'agentis/workflow/v1' as const;

export interface WorkflowFile {
  apiVersion: typeof WORKFLOW_FILE_API_VERSION;
  kind: 'Workflow';
  metadata: {
    name: string;
    description?: string | null;
  };
  spec: {
    graph: WorkflowGraph;
  };
}

/**
 * Generic per-node retry policy. Applies to deterministic / integration / IO
 * node kinds (transform, code, http_request, integration, browser, graphql,
 * extension_task, …). Agent-like nodes (`agent_task`/`agent_swarm`/
 * `agent_session`) are EXCLUDED — they run through self-heal / their own
 * `AgentRetryPolicy`, and double-retrying them would re-bill model calls.
 */
export interface NodeRetryPolicy {
  /** Retries AFTER the first failure (0/undefined = no retry). Capped by the engine. */
  maxAttempts: number;
  /** Delay before the first retry; doubled each attempt up to a cap. Default 1000ms. */
  backoffMs?: number;
  /**
   * Only retry when the error message matches one of these substrings (case-
   * insensitive). Empty/undefined = retry on any error.
   */
  retryOn?: string[];
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  title: string;
  position: { x: number; y: number };
  config: WorkflowNodeConfig;
  /**
   * Optional generic retry policy for transient failures. Handled centrally by
   * the engine BEFORE error-edge routing, so any IO/deterministic node gets the
   * resilience that previously only `agent_task` had. See {@link NodeRetryPolicy}.
   */
  retryPolicy?: NodeRetryPolicy;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  sourceHandle?: string;
  target: string;
  targetHandle?: string;
  /** Safe expression (no eval). Evaluated by SafeConditionParser. */
  condition?: string;
  /**
   * Edge semantics. Defaults to `'default'`.
   * - `'default'`  → normal success edge.
   * - `'error'`    → only traversed when the source node fails. Replaces run termination.
   * - `'condition'`→ traversed when the (already-evaluated) condition is truthy. Hint for renderer.
   */
  type?: 'default' | 'error' | 'condition';
}

/**
 * Declared contract for what a workflow accepts as trigger input or produces as final output.
 * Mirrors the shape Brain runtime evaluation references for workflow
 * inputs and outputs. Keep this shape stable.
 */
export interface WorkflowContract {
  fields: Array<{
    key: string;
    type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any';
    required?: boolean;
    description?: string;
    /** JSON Schema string for additional validation when `type` is `'object'` or `'array'`. */
    schema?: string;
  }>;
}

/**
 * A phase is both a canvas grouping AND an execution primitive (Layer 5).
 * When `slaDurationMs` / `budgetCents` / `humanGate` are set, the engine
 * enforces them: SLA breach emits an alert (does not kill), budget overrun
 * halts the run, and human gates pause between phases.
 */
export interface WorkflowPhase {
  id: string;
  name: string;
  /** Plain-language purpose shown in the phase lane and inspector. */
  description?: string;
  /** Hex color used for the canvas region background. */
  color: string;
  nodeIds: string[];
  collapsed?: boolean;
  /** SLA window for the whole phase. Breach alerts; it does not kill the run. */
  slaDurationMs?: number;
  /** Cost ceiling (cents) for the phase. Overrun halts the run with BUDGET_LIMIT_EXCEEDED. */
  budgetCents?: number;
  /** Human approval gate evaluated when the phase's first node becomes ready. */
  humanGate?: {
    type: 'approve' | 'provide_input' | 'review_output';
    message?: string;
    approvers?: string[];
    timeoutMs?: number;
    onTimeout?: 'escalate' | 'auto_approve' | 'fail';
    escalateTo?: string;
  };
  /** JS expression evaluated after the phase completes (advisory in V1). */
  successCriteria?: string;
  rollbackPlan?: string;
}

export interface WorkflowOutputConfig {
  
  isOutput?: boolean;
  /**
   * Declared cost estimate (cents) for this node. Accumulated per-phase by the
   * engine for budget governance (Layer 5.3) and surfaced in the audit trail.
   */
  estimatedCostCents?: number;
}

export type WorkflowNodeConfig = (
  | TriggerNodeConfig
  | AgentTaskNodeConfig
  | AgentSessionNodeConfig
  | ExtensionTaskNodeConfig
  | ComponentTaskNodeConfig
  | KnowledgeNodeConfig
  | KnowledgeIngestNodeConfig
  | RouterNodeConfig
  | MergeNodeConfig
  | CheckpointNodeConfig
  | HumanInputNodeConfig
  | SubflowNodeConfig
  | ScratchpadNodeConfig
  | AgentSwarmNodeConfig
  | DynamicSwarmNodeConfig
  | PlannerNodeConfig
  | ArtifactCollectNodeConfig
  | WaitNodeConfig
  | TransformNodeConfig
  | FilterNodeConfig
  | IntegrationNodeConfig
  | McpNodeConfig
  | ChannelSendNodeConfig
  | DataQueryNodeConfig
  | DataMutateNodeConfig
  | AggregateWindowNodeConfig
  | HttpRequestNodeConfig
  | WorkflowStoreNodeConfig
  | WorkspaceStoreNodeConfig
  | EvaluatorNodeConfig
  | GuardrailsNodeConfig
  | LoopNodeConfig
  | ConvergeNodeConfig
  | PursueNodeConfig
  | ParallelNodeConfig
  | ReturnOutputNodeConfig
  | ArtifactSaveNodeConfig
  | BrowserNodeConfig
  | ErrorTriggerNodeConfig
  | StopErrorNodeConfig
  | CodeNodeConfig
  | DateTimeNodeConfig
  | CryptoUtilNodeConfig
  | XmlParseNodeConfig
  | MarkdownNodeConfig
  | JsonSchemaValidateNodeConfig
  | StickyNoteNodeConfig
  | SpreadsheetNodeConfig
  | HtmlExtractNodeConfig
  | GraphQlNodeConfig
) & WorkflowOutputConfig;

/**
 * Multi-rule schedule (n8n-inspired). Each rule is an independent cron
 * expression on the same trigger, so one trigger can fire on several unrelated
 * cadences (e.g. "every Monday 9am" AND "every day at midnight").
 */
export interface ScheduleRule {
  /** Five-field cron expression. */
  expression: string;
  /** IANA timezone; defaults to the trigger's timezone. */
  timezone?: string;
  label?: string;
}

/** Trigger node config. */
export interface TriggerNodeConfig {
  kind: 'trigger';
  triggerType:
    | 'manual'
    | 'cron'
    | 'webhook'
    | 'persistent_listener'
    | 'error_trigger'   // fires when a target workflow reaches FAILED/CANCELLED
    | 'email_imap'      // IMAP inbox poller
    | 'rss_feed';       // RSS/Atom feed poller
  triggerId?: string;
  /** Five-field cron expression authored on the canvas. */
  schedule?: string;
  /** IANA timezone used by node-cron. Defaults to UTC. */
  timezone?: string;
  /**
   * Multiple independent cron rules on one trigger. When present (and non-empty)
   * the runtime schedules one cron job per rule; `schedule` still applies as the
   * single-expression form for backward compatibility.
   */
  scheduleRules?: ScheduleRule[];
  /** Structured persistent-listener authoring config. */
  listenerConfig?: ListenerConfig;
  /** error_trigger scope: which workflow's failure fires this trigger. */
  errorTrigger?: ErrorTriggerNodeConfig;
  /** email_imap poller config. */
  emailImap?: EmailImapTriggerConfig;
  /** rss_feed poller config. */
  rssFeed?: RssFeedTriggerConfig;
}

/** IMAP inbox poller authoring config (for `triggerType: 'email_imap'`). */
export interface EmailImapTriggerConfig {
  host: string;
  port?: number;
  secure?: boolean;
  /** Credential id holding { username, password }. */
  credentialId?: string;
  mailbox?: string;
  /** Only emit messages matching this search (e.g. 'UNSEEN'). */
  search?: string;
  pollIntervalMs?: number;
}

/** RSS/Atom feed poller authoring config (for `triggerType: 'rss_feed'`). */
export interface RssFeedTriggerConfig {
  feedUrl: string;
  pollIntervalMs?: number;
}

/**
 * Retry / self-healing policy for an agent task (AGENTIS-PLATFORM-10X §A9).
 * When `selfHeal` is on, a failed agent task is re-dispatched with the error
 * context appended to its prompt so the agent can correct itself.
 */
export interface AgentRetryPolicy {
  selfHeal?: boolean;
  maxSelfHealAttempts?: number;
}

export interface AgentArtifactPolicy {
  /**
   * `intentional` keeps screenshots/transient captures ephemeral unless a tool
   * call explicitly asks to save them. `all` preserves legacy capture-everything
   * behavior. `none` blocks incidental tool-created assets for the task.
   */
  mode?: 'intentional' | 'all' | 'none';
  /** Persist browser screenshots/captures even when the tool call omits `save`. */
  saveScreenshots?: boolean;
  /** Persist generated outputs that are clearly deliverables for this task. */
  saveGeneratedAssets?: boolean;
}

export interface AgentTaskNodeConfig {
  kind: 'agent_task';
  agentId?: string;
  /**
   * Reference a specialist by role; the engine resolves it to the workspace's
   * agent carrying that role at dispatch time (Layer 2 §2.2). `agentId` wins
   * when both are set.
   */
  agentRole?: AgentRole;
  agentPackageRef?: string;
  capabilityTags: string[];
  /** Required runtime affordances used for capability-aware routing. */
  requires?: AgentRequirements;
  prompt: string;
  inputKeys: string[];
  outputKeys: string[];
  retryPolicy?: AgentRetryPolicy;
  
  skills?: string[];
  /** Optional behavioral protocol names injected into the prompt at dispatch. */
  extensions?: string[];
  /** Per-node model override (does not change the agent's global config). */
  modelOverride?: string;
  /**
   * Runtime/adapter this task should execute on (e.g. `claude_code`, `codex`,
   * `cursor`, `hermes_agent`, `openclaw`, `http`). Only takes effect the first
   * time `agentRole` casts a brand-new specialist for this workspace — an
   * already-materialized specialist keeps whatever runtime it's connected to.
   */
  preferredAdapter?: string;
  /** One-sentence rationale for the chosen specialist role (shown in the inspector). */
  castingReason?: string;
  /**
   * Run this task in-process via the agentic tool-use loop (§2.2) instead of
   * dispatching to an external adapter. Requires `agentRole` + a configured LLM
   * runtime; the loop is bounded by the role's tool manifest and `maxToolSteps`.
   */
  useRoleTools?: boolean;
  /** Cap on tool-use loop steps when `useRoleTools` is set (default 6, max 12). */
  maxToolSteps?: number;
  /**
   * Memory write-policy override (Brain Memory Formation §4.1). Controls what
   * this task may write to the Brain: `form` (may form durable memory),
   * `episodic_only` (one decaying outcome marker), or `none`. When unset, the
   * engine resolves a policy from the task's role and output shape.
   */
  memoryPolicy?: 'form' | 'episodic_only' | 'none';
  /**
   * Asset retention policy for tools called by this task. Defaults to
   * `intentional`: screenshots and other inspection captures stay transient
   * unless the task/tool explicitly asks to save them.
   */
  artifactPolicy?: AgentArtifactPolicy;
  /**
   * Run this task as a persistent AgentSession (SMARTER-AGENTS-10X §VI) instead
   * of a one-shot dispatch: working memory, suspend/wake yield points, and
   * context compaction. Requires a configured session adapter. `agent_session`
   * nodes are the explicit form; this flag is the compat bridge for existing
   * `agent_task` nodes.
   */
  useSession?: boolean;
}

/**
 * A persistent agent session node (SMARTER-AGENTS-10X §VI). The engine drives a
 * thinking⇄doing loop with working memory and yield points (delegate, await
 * event, sleep, request approval) until the agent calls `complete_task`. Between
 * steps the session is a DB row, so a node can suspend for hours at zero cost.
 */
export interface AgentSessionNodeConfig {
  kind: 'agent_session';
  agentId?: string;
  agentRole?: AgentRole;
  /** The objective handed to the agent — seeds its `task` memory block. */
  prompt: string;
  /** Optional persona override; the specialist role's system prompt is used otherwise. */
  persona?: string;
  inputKeys: string[];
  outputKeys: string[];
  /** Hard cap on cognitive steps (engine-bounded regardless). */
  maxSteps?: number;
  capabilityTags: string[];
  /** Required runtime affordances used for capability-aware routing. */
  requires?: AgentRequirements;
  /**
   * Asset retention policy for tools called by this session. Defaults to
   * intentional-only persistence for screenshots and inspection captures.
   */
  artifactPolicy?: AgentArtifactPolicy;
}

/**
 * Dynamic swarm (SMARTER-AGENTS-10X §VII). A planner agent decides the task list
 * at runtime from a goal, then the engine fans those tasks out across worker
 * agents — bounded by `maxTasks`/`maxParallel`. Unlike `agent_swarm`, the task
 * set is not a static input array; it is synthesized per run.
 */
export interface DynamicSwarmNodeConfig {
  kind: 'dynamic_swarm';
  /** The objective the planner decomposes into parallel worker tasks. */
  goal: string;
  /** Worker specialist role applied to every synthesized task. */
  agentRole?: AgentRole;
  /** Planner specialist role that decides the task list (defaults to 'planner'). */
  plannerRole?: AgentRole;
  /** Hard cap on synthesized tasks (determinism cage). */
  maxTasks: number;
  maxParallel: number;
  mergeStrategy: 'collect_all' | 'first_success' | 'majority_vote';
  outputKey: string;
  capabilityTags: string[];
  /** Required runtime affordances applied to each worker session. */
  requires?: AgentRequirements;
}

/**
 * Planner node (SMARTER-AGENTS-10X §VII). A planner agent decomposes a goal into
 * a subgraph of `agent_session` steps and splices them into the live run via a
 * validated graph patch. The determinism cage bounds how many nodes one pass may
 * add.
 */
export interface PlannerNodeConfig {
  kind: 'planner';
  /** The objective to decompose. */
  goal: string;
  /** Planner specialist role (defaults to 'planner'). */
  agentRole?: AgentRole;
  agentId?: string;
  /** Worker role assigned to each synthesized plan step. */
  workerRole?: AgentRole;
  /** Max nodes the planner may add in one pass. */
  maxNodes?: number;
  inputKeys: string[];
  outputKeys: string[];
}

/**
 * Parallel agent fan-out. The engine spawns one task per element of the
 * input array (bounded by `maxParallel`) and merges results.
 */
export interface AgentSwarmNodeConfig {
  kind: 'agent_swarm';
  /** Template prompt — applied to each input element. */
  prompt: string;
  /** JSONPath to the input array; each element becomes one agent task. */
  inputArrayPath: string;
  maxParallel: number;
  mergeStrategy: 'collect_all' | 'first_success' | 'majority_vote';
  capabilityTags: string[];
  /** Optional explicit agent — otherwise resolved by capability tags. */
  agentId?: string;
  /** Optional specialist role; resolved to a workspace agent at dispatch (Layer 2). */
  agentRole?: AgentRole;
  /** Required runtime affordances used when selecting the swarm worker agent. */
  requires?: AgentRequirements;
  outputKey: string;
}

/**
 * Collect artifacts (files, media, generated pages) from upstream nodes into a
 * named, versioned collection. The node gathers `ArtifactRef` objects from the
 * input data and writes them to the artifact store.
 */
export interface ArtifactCollectNodeConfig {
  kind: 'artifact_collect';
  /** Human-readable collection name (e.g. "Campaign Pack Q3"). */
  collectionName: string;
  /** JSONPath into the node input to find artifact refs. Defaults to whole input. */
  artifactPath?: string;
  /** Artifact types to accept. If omitted, all types accepted. */
  acceptTypes?: Array<'html' | 'image' | 'document' | 'code' | 'data'>;
  /** Whether to version the collection (increment on each run). Default true. */
  versioned?: boolean;
  
  requireApproval?: boolean;
}

export interface ExtensionTaskNodeConfig {
  kind: 'extension_task';
  extensionId?: string;
  extensionSlug?: string;
  operationName: string;
  version?: string;
  inputMapping: Record<string, string>;
  outputMapping: Record<string, string>;
  timeoutMs?: number;
}

export interface KnowledgeNodeConfig {
  kind: 'knowledge';
  knowledgeBaseId?: string;
  queryMode?: 'static' | 'dynamic';
  query?: string;
  queryNodeId?: string;
  queryPath?: string;
  retrievalMode?: 'contextual' | 'strict' | 'exploratory';
  topK?: number;
}

/**
 * knowledge_ingest — the write-side twin of the `knowledge` node, into the
 * Knowledge Base (`KnowledgeBaseService`, RAG docs — NOT the Brain memory).
 *
 * @deprecated For AUTHORING. Writing knowledge/memory should not be a hand-wired
 * graph node: the Brain (memory) fills automatically from chat + completed runs,
 * and agents write to the Knowledge Base on purpose via the `agentis.knowledge.write`
 * tool. This kind is retained only so pre-existing graphs keep executing; it is no
 * longer offered in the node palette or the synthesis catalog. Do not add new uses.
 */
export interface KnowledgeIngestNodeConfig {
  kind: 'knowledge_ingest';
  /** Target knowledge base. When omitted, the first base is used (or one is created). */
  knowledgeBaseId?: string;
  /** Name for the knowledge base to create when none exists / id is unset. */
  knowledgeBaseName?: string;
  /** Static document content. Used when `contentPath` is unset or resolves empty. */
  content?: string;
  /** Dot-path into the node input for the document content (e.g. `body`, `page.text`). */
  contentPath?: string;
  /** Static document name/title shown in the Brain. */
  documentName?: string;
  /** Dot-path into the node input for the document name. */
  documentNamePath?: string;
  /** MIME-type hint to drive text extraction (e.g. text/markdown, text/html, application/json). */
  mimeType?: string;
}

export interface RouterNodeConfig {
  kind: 'router';
  routingMode: 'first_match' | 'all_matching' | 'llm_route' | 'space_route';
  branches: Array<{ branchId: string; label: string; condition: string }>;
}

export interface MergeNodeConfig {
  kind: 'merge';
  requiredInputs: 'all' | 'any' | string[];
  /**
   * Explicitly bind this merge to the `parallel` node whose fan-out it joins.
   * When set, the engine reads join policy (waitFor / onBranchError /
   * mergeStrategy) from THAT parallel instead of guessing the nearest upstream
   * one — removes the ambiguity in diamond / nested fan-ins. Falls back to the
   * nearest-upstream heuristic when unset or unresolvable.
   */
  parallelSourceId?: string;
}

export interface CheckpointNodeConfig {
  kind: 'checkpoint';
  approvalMode: 'manual' | 'auto_after_timeout';
  timeoutMs?: number;
}


export interface HumanInputNodeConfig {
  kind: 'human_input';
  /** Prompt shown above the form. */
  prompt?: string;
  /** The fields the human fills. */
  fields: Array<{
    key: string;
    label?: string;
    type?: 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'date';
    required?: boolean;
    options?: Array<{ value: string; label?: string }>;
  }>;
  /** Wrap the submitted values under this key in the node output. Omitted = the values ARE the output. */
  outputKey?: string;
}

export interface SubflowNodeConfig {
  kind: 'subflow';
  workflowId: string;
  inputMapping: Record<string, string>;
  outputMapping: Record<string, string>;
}

export interface ScratchpadNodeConfig {
  kind: 'scratchpad';
  operation: 'read' | 'write' | 'append' | 'delete';
  key: string;
  valuePath?: string;
}

// ────────────────────────────────────────────────────────────
// Control-flow & deterministic primitives
// ────────────────────────────────────────────────────────────

/** Time-based delay. Resumes the downstream chain after `delayMs`. */
export interface WaitNodeConfig {
  kind: 'wait';
  /** Delay in milliseconds. ≤0 completes instantly. */
  delayMs: number;
  /**
   * Absolute wake time (ISO 8601, e.g. "2026-07-01T09:00:00Z"). When set, the
   * engine waits until then instead of for `delayMs` — enabling "send Monday 9am"
   * / SLA-style schedules. A time already in the past completes instantly.
   * Supports `{{variable}}` templates (resolved before this handler).
   */
  untilIso?: string;
}

/** JS expression evaluated against `input`. Output replaces the node's outputData. */
export interface TransformNodeConfig {
  kind: 'transform';
  /** A JS expression. Receives `input` bound to inputData. Must return the output object. */
  expression: string;
  /** Optional key under which the result is also stored; otherwise the result is the whole output. */
  outputKey?: string;
  /** Optional bounded execution deadline. The engine derives workload headroom when omitted. */
  timeoutMs?: number;
}

/** Boolean gate. Truthy → `pass` handle; falsy → `skip` handle. */
export interface FilterNodeConfig {
  kind: 'filter';
  /** Boolean JS expression. Receives `input`. */
  condition: string;
  passLabel?: string;
  skipLabel?: string;
  /** Optional bounded execution deadline. The engine derives workload headroom when omitted. */
  timeoutMs?: number;
}

/** Call a registered integration connector (Slack / Gmail / GitHub / Sheets / HTTP …). */
export interface IntegrationNodeConfig {
  kind: 'integration';
  /** Connector slug from `ConnectorRegistry.list()`. */
  integrationId: string;
  /** Operation slug from the connector's manifest. */
  operationId: string;
  /** Resolved at dispatch time — values may contain `{{variable}}` templates. */
  inputs: Record<string, string>;
  /** Credential ID from the workspace credential store. Optional for connectors that don't require auth. */
  credentialId?: string;
}

/**
 * Call a tool on a registered MCP server (masterplan 2.3). The workspace's MCP
 * servers (`mcp:servers`) become callable from a workflow — the same bridge that
 * exposes them to agents. `toolId` is the server-prefixed bridged tool id.
 */
export interface McpNodeConfig {
  kind: 'mcp';
  toolId: string;
  /** Argument values (may contain `{{variable}}` templates). */
  arguments?: Record<string, unknown>;
  /** Key under which the tool result is stored. Defaults to `content`. */
  outputKey?: string;
}

/**
 * Deterministically send a message on a native channel connection (WhatsApp,
 * Telegram, Slack, Discord) — the zero-token "actually reach the world" step a
 * deterministic outreach workflow needs. Resolves the connection by `kind` (the
 * one active authorized connection of that kind) or an explicit `connectionId`,
 * delivers via the same path as `agentis.channel.send`, and returns a delivery
 * receipt SWIFT can verify. A node that can't resolve/authorize/deliver FAILS —
 * it never reports a hollow success.
 */
export interface ChannelSendNodeConfig {
  kind: 'channel';
  /** Channel kind to resolve when `connectionId` is omitted, e.g. "whatsapp". */
  channelKind?: 'telegram' | 'discord' | 'slack' | 'whatsapp';
  /** Pin an exact connection instead of resolving by kind. */
  connectionId?: string;
  /** Destination — a phone/JID/alias, or "default"/"me" for the saved default target. May contain `{{variable}}`. */
  to?: string;
  /** Message body / caption. May contain `{{variable}}` templates. */
  body: string;
  /** Attachment sources (artifact:<id>, data:, or http(s) URL). May contain templates. */
  attachments?: Array<{ url?: string; artifactId?: string; filename?: string; mimeType?: string; kind?: 'image' | 'video' | 'audio' | 'voice' | 'sticker' | 'file'; caption?: string }>;
  /** Send a natural burst of messages in order. When set, `body`/`attachments` are ignored. */
  messages?: Array<{ body?: string; attachments?: Array<{ url?: string; artifactId?: string; filename?: string; mimeType?: string; kind?: 'image' | 'video' | 'audio' | 'voice' | 'sticker' | 'file'; caption?: string }> }>;
  /** Key under which the delivery receipt is stored. Defaults to `delivery`. */
  outputKey?: string;
}

/**
 * Read or aggregate an Agentic App datastore collection from a workflow
 * (masterplan 4.x). `mode: 'query'` returns rows (filter/sort/limit/cursor);
 * `mode: 'aggregate'` returns count/sum/avg/min/max with optional group-by.
 */
export interface DataQueryNodeConfig {
  kind: 'data_query';
  appId: string;
  collection: string;
  mode?: 'query' | 'aggregate';
  /** query: filter / sort / pagination. */
  filter?: Record<string, unknown>;
  sort?: Array<{ field: string; dir: 'asc' | 'desc' }>;
  limit?: number;
  cursor?: string;
  /** aggregate: op (+ field for sum/avg/min/max) and optional groupBy. */
  op?: 'count' | 'sum' | 'avg' | 'min' | 'max';
  field?: string;
  groupBy?: string;
  
  paginate?: boolean;
  /** Hard cap on rows when `paginate` is set (default 1000, max 10000). */
  maxRows?: number;
  /** Key under which the result is stored. Defaults to `rows`/`buckets`. */
  outputKey?: string;
}

/** Write to an Agentic App datastore collection from a workflow (insert/update/upsert/delete). */
export interface DataMutateNodeConfig {
  kind: 'data_mutate';
  /** Omitted = resolve the App that owns the running workflow. */
  appId?: string;
  collection: string;
  operation: 'insert' | 'update' | 'upsert' | 'delete';
  /** Record body for insert/update/upsert (may contain `{{variable}}` templates). */
  record?: Record<string, unknown>;
  /** Transactional batch body for insert/upsert. Maximum 1,000 records. */
  records?: Array<Record<string, unknown>>;
  /** Target record id for update/delete. */
  recordId?: string;
  /** Match filter for upsert. */
  match?: Record<string, unknown>;
  /** Fields copied from each batch record to form its upsert match filter. */
  matchFields?: string[];
  outputKey?: string;
}

/**
 * Batch events across runs (masterplan 1.7). Each run appends its input to a
 * persistent buffer; downstream only fires once the window CLOSES — when the
 * buffered count hits `maxCount` or `windowMs` has elapsed since the first item.
 * Until then the node "holds" (completes without firing downstream), so a
 * high-frequency trigger collapses into periodic batches (digests, lead batching).
 */
export interface AggregateWindowNodeConfig {
  kind: 'aggregate_window';
  /** Separate buffers per key (e.g. per customer). Defaults to one shared buffer. */
  key?: string;
  /** Flush when the buffer reaches this many items. */
  maxCount?: number;
  /** Flush when this long has elapsed since the first buffered item. */
  windowMs?: number;
  /** Key under which the flushed batch array is emitted. Defaults to `items`. */
  outputKey?: string;
}

/** Raw outbound HTTP for cases without a named connector. */
export interface HttpRequestNodeConfig {
  kind: 'http_request';
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** URL template — supports `{{variable}}`. */
  url: string;
  /** Header templates. */
  headers?: Record<string, string>;
  /** Body template. Sent as-is when present. */
  body?: string;
  auth?:
    | { type: 'none' }
    | { type: 'bearer'; credentialId: string }
    | { type: 'api_key'; header: string; credentialId: string }
    | { type: 'basic'; credentialId: string };
  /** Optional response extraction. */
  responseMapping?: {
    /** JSON-path-like dot notation (e.g. `data.items[0].id`). */
    bodyPath?: string;
    /** Key under which the extracted value is stored. */
    outputKey: string;
  };
  /** Status codes that trigger a retry (e.g. `[429, 503]`). */
  retryOn?: number[];
  /** Max retry attempts after the initial dispatch (default 0). */
  maxRetries?: number;
  /** Per-request timeout (default 30000). */
  timeoutMs?: number;
}

/**
 * Workflow-scoped persistent KV.
 *
 * Distinct from `scratchpad` (run-scoped, disposed on completion). `workflow_store`
 * survives run boundaries — a daily workflow can accumulate state across 30+ runs.
 * The Brain will index these entries as structured facts; the schema carries
 * `workspaceId` to support that without later migration.
 */
export interface WorkflowStoreNodeConfig {
  kind: 'workflow_store';
  operations: Array<{
    op: 'get' | 'set' | 'delete' | 'increment' | 'append' | 'get_all';
    /** Key template — supports `{{variable}}`. Required for everything except `get_all`. */
    key?: string;
    /** Value template — supports `{{variable}}`. Required for `set` / `append`. */
    value?: string;
    /** Result is stored under this key in the node's output. Defaults to the key name. */
    outputKey?: string;
    /** For `increment`. Defaults to 1. */
    incrementBy?: number;
  }>;
}

/**
 * Workspace-scoped persistent KV (Tier 3). Same operation shape as
 * `workflow_store`, but the key space is shared across every workflow in the
 * workspace. Surfaced to templates as `{{workspace.kv.*}}`.
 */
export interface WorkspaceStoreNodeConfig {
  kind: 'workspace_store';
  operations: Array<{
    op: 'get' | 'set' | 'delete' | 'increment' | 'append' | 'get_all';
    key?: string;
    value?: string;
    outputKey?: string;
    incrementBy?: number;
  }>;
}

// ────────────────────────────────────────────────────────────
// Intelligence
// ────────────────────────────────────────────────────────────

/** LLM-as-judge: scores an upstream output and routes pass/fail. */
export interface EvaluatorNodeConfig {
  kind: 'evaluator';
  /** Path into the node's input to find what should be evaluated (dot notation). */
  targetPath: string;
  /** Natural-language acceptance criteria. */
  criteria: string;
  /** Minimum score (0–10) to pass. Default 7. */
  passThreshold?: number;
  /** Max times the FAIL edge may cycle back before terminating. Default 3. */
  maxRetries?: number;
  /** Optional rubric dimensions for multi-axis scoring. */
  rubric?: Array<{ dimension: string; weight: number }>;
}

/** Deterministic policy enforcement — rule-based, no LLM. */
export interface GuardrailsNodeConfig {
  kind: 'guardrails';
  rules: Array<{
    type: 'not_empty' | 'min_length' | 'max_length' | 'contains' | 'not_contains' | 'regex' | 'json_schema';
    /** Dot-notation path into input data. */
    target: string;
    /** Match string, regex pattern, or JSON Schema string depending on `type`. */
    value?: string;
    /** Length bound for `min_length` / `max_length`. */
    limit?: number;
    /** Human-readable message attached to violations. */
    message?: string;
  }>;
  /** `block` routes to the error edge; `flag` adds the violation array to output and continues. */
  onViolation: 'block' | 'flag';
}

// ────────────────────────────────────────────────────────────
// Loop / Parallel
// ────────────────────────────────────────────────────────────

/** Array iteration. Each item dispatches a child subflow with `{{loop.item}}` / `{{loop.index}}` bound. */
export interface LoopNodeConfig {
  kind: 'loop';
  /** Template expression resolving to the array (e.g. `{{nodes.step1.results}}`). */
  itemsExpression: string;
  /** Concurrency cap — 1 is sequential, >1 fans out in parallel. */
  maxConcurrency: number;
  /** Body workflow ID — invoked once per item via SubflowExecutor. */
  bodyWorkflowId: string;
  /** What happens when a single iteration fails. */
  onIterationError: 'stop_all' | 'continue' | 'collect_errors';
  /** Key under which iteration outputs are collected. */
  outputArrayKey: string;
  /**
   * For very large arrays: process this many at a time. Engine emits LOOP_PROGRESS
   * after each chunk completes. Defaults to processing all items at once.
   */
  chunkSize?: number;
}

/** Structural fan-out: every outgoing edge is a branch executed simultaneously. */
export interface ParallelNodeConfig {
  kind: 'parallel';
  /** `all` waits for every branch; `first` settles when any single branch completes. */
  waitFor: 'all' | 'first';
  onBranchError: 'fail_all' | 'continue_with_results';
  mergeStrategy: 'merge_keys' | 'collect_all' | 'first_non_null';
}

// ────────────────────────────────────────────────────────────
// Convergence loop — iterate a cohort until a goal is met
// (AGENT-COOPERATION-10X §Pillar 1). The general agentic loop primitive:
// the body (not one node), governed by a pluggable continuation policy, and
// protected by a hard iteration ceiling + budget + stall detection.
// ────────────────────────────────────────────────────────────

/** How a convergence loop decides whether to run another iteration. */
export type ConvergeContinuation =
  | {
      /** Deterministic predicate over the body output. Loop CONTINUES while true. */
      type: 'deterministic';
      /** Safe condition, e.g. `body.openBugCount > 0`. `{{ }}` wrappers are stripped. */
      expr: string;
    }
  | {
      /** LLM judge against criteria. Loop CONTINUES while the verdict FAILS. */
      type: 'judge';
      /** Dot path into the body output to evaluate. */
      targetPath: string;
      criteria: string;
      /** Minimum score (0–10) that counts as converged. Default 7. */
      passThreshold?: number;
      rubric?: Array<{ dimension: string; weight: number }>;
    }
  | {
      
      type: 'signal';
      
      channel?: string;
    }
  | {
      /**
       * OBJECTIVE (COGNITIVE-LOOPING-RFC P1). The done-check IS the workflow's
       * scoped Objective — its `WorkflowSpec` acceptance checks, run against the
       * WORLD (http/data/file/expr/judge) by the SWIFT verdict engine. The Pursuit
       * is done when the verdict is `accomplished`; progress = the fraction of
       * acceptance checks passing, so distance-to-goal is real, not guessed.
       * No hand-written predicate — the objective and its verification are one.
       */
      type: 'objective';
    };

export interface ConvergeNodeConfig {
  kind: 'converge';
  /** The cohort sub-graph, invoked once per iteration via SubflowExecutor. */
  bodyWorkflowId: string;
  /** When to keep iterating. */
  continuation: ConvergeContinuation;
  /** Hard ceiling on iterations (safety net). Default 8. */
  maxIterations?: number;
  /** Circuit breaker — abort the loop when any limit is crossed. */
  budget?: { usd?: number; ms?: number; tokens?: number };
  /** Early-stop when iterations stop making progress (the efficiency guard). */
  stallPolicy?: {
    /** Consecutive no-change iterations that trigger a stall stop. Default 2. */
    window?: number;
    on?: 'no_progress' | 'oscillation';
  };
  
  stateKey?: string;
  /** How iteration N sees N-1's output. Default 'accumulate'. */
  carryStrategy?: 'accumulate' | 'replace' | 'diff';
  /** Filesystem isolation for the cohort (AGENT-COOPERATION-10X §Pillar 3). Default 'auto'. */
  isolation?: 'auto' | 'shared' | 'worktree' | 'tempdir';
  /** What to do with the isolated worktree when the loop settles. Default 'discard'. */
  preserve?: 'discard' | 'branch' | 'pr';
  /**
   * ASSESS (COGNITIVE-LOOPING-RFC §3.2/§6). Measure distance-to-goal (progress
   * 0..1) each iteration and record the trajectory, so a stall can be detected
   * as a progress *plateau/regression* — not only an identical-output repeat.
   * Cheap when `continuation` is a `judge` (reuses its 0..10 score). Default
   * false for `converge` (behavioural parity); a `pursue` node defaults it true.
   */
  assess?: boolean;
  /**
   * REFLECT (RFC §8). Max reflective pivots before settling `stalled`. On a
   * detected stall the loop feeds a verbal self-critique (the judge's own
   * critique, or a synthesized hint) into the NEXT iteration and tries again,
   * instead of stopping. `0` = stop-on-stall (converge parity). A `pursue` node
   * defaults 2.
   */
  maxPivots?: number;
}

// ────────────────────────────────────────────────────────────
// Pursuit — the cognitive-loop primitive (COGNITIVE-LOOPING-RFC).
// A forward-reading rename of `converge`: "pursue an Objective until done".
// It is normalized to a ConvergeNodeConfig at dispatch (see
// pursueConfigToConverge in WorkflowEngine), so the engine loop, worktree,
// realtime events, durable resume, and knowledge promotion are all SHARED — no
// fork. Existing stored `converge` graphs keep working unchanged and keep their
// content hash (hash-safe, RFC §10.1); new work authors `pursue`.
// ────────────────────────────────────────────────────────────
export interface PursueNodeConfig {
  kind: 'pursue';
  /** The cohort sub-graph, invoked once per iteration via SubflowExecutor. */
  bodyWorkflowId: string;
  /** How the Pursuit knows it is finished. (Forward-reading rename of `continuation`.) */
  doneWhen: ConvergeContinuation;
  /** Hard ceiling on iterations (safety net). Default 8. */
  maxIterations?: number;
  /** Circuit breaker — abort the Pursuit when any limit is crossed. */
  budget?: { usd?: number; ms?: number; tokens?: number };
  /** Early-stop when iterations stop advancing. (Rename of `stallPolicy`.) */
  stopWhenStalled?: {
    /** Consecutive no-change iterations that trip a stall. Default 2. */
    after?: number;
    on?: 'no_progress' | 'oscillation';
  };
  
  stateKey?: string;
  /** How iteration N sees N-1's output. (Rename of `carryStrategy`.) Default 'keep'. */
  carry?: 'keep' | 'latest' | 'delta';
  /** Filesystem isolation for the cohort. Default 'auto'. */
  isolation?: 'auto' | 'shared' | 'worktree' | 'tempdir';
  /** What to do with the isolated worktree when the Pursuit settles. Default 'discard'. */
  preserve?: 'discard' | 'branch' | 'pr';
  /** ASSESS — measure distance-to-goal each iteration. Default true for a Pursuit. */
  assess?: boolean;
  /** REFLECT — max reflective pivots before settling `stalled`. Default 2. */
  maxPivots?: number;
}

// ────────────────────────────────────────────────────────────
// Output surface — Layer 6
// ────────────────────────────────────────────────────────────


export interface ReturnOutputNodeConfig {
  kind: 'return_output';
  /** Viewer hint for the Output Surface. Defaults to `'json'`. */
  renderAs?: OutputRenderAs;
  /** Optional human label shown above the rendered output. */
  title?: string;
  /**
   * Dot path into the node input selecting the value to render. When omitted,
   * the whole merged input is the output. Supports `{{variable}}` templates too.
   */
  valuePath?: string;
}

/**
 * Persist a value as a workspace artifact (immutable run receipt). V1 stores
 * content inline in the `artifacts` table (same store as `artifact_collect`);
 * a future ArtifactStore backend swaps in transparently. Emits an artifact ref
 * downstream so subsequent nodes / the Output tab can reference it.
 */
export interface ArtifactSaveNodeConfig {
  kind: 'artifact_save';
  /** Artifact filename, e.g. "report.html". Supports `{{variable}}`. */
  name: string;
  /** Coarse artifact class used by the Output gallery / viewers. */
  artifactType?: 'html' | 'image' | 'document' | 'code' | 'data';
  /** Dot path into input for the content to persist. Defaults to whole input (JSON-encoded). */
  contentPath?: string;
  /** Dot path into input for an optional title. */
  titlePath?: string;
}

// ────────────────────────────────────────────────────────────
// Native browser control — Layer 3 §3.2
// ────────────────────────────────────────────────────────────

/**
 * Native Playwright-backed browser node. Renders HTML / navigates URLs and
 * produces artifacts (screenshot PNG, PDF) — no external screenshot service.
 * Runs in the engine's BrowserPool (headless Chromium, capped concurrency).
 */
export interface BrowserNodeConfig {
  kind: 'browser';
  operation:
    | 'serve_html'      // render an HTML string, screenshot it, emit html + image artifact
    | 'screenshot'      // screenshot a URL (or inline html) → image artifact
    | 'pdf'             // print a URL (or inline html) to PDF → document artifact
    | 'navigate'        // load a URL, return { title, text, html }
    | 'extract_text'    // load a URL/html, return visible text under selector
    | 'fill_form'       // fill fields by selector, optionally submit
    | 'extract_table'   // extract a <table> into row objects
    | 'session';        // drive a PERSISTENT run-scoped session (stateful multi-step / login)
  /** For `session`: the session action (open|navigate|click|fill|type|press|select_option|hover|scroll|wait_for|get|save_auth|close). */
  sessionAction?: string;
  /** For `session`: names the persistent session; the same id across nodes/runs reuses the live page. */
  sessionId?: string;
  /** For `session`: extra args forwarded to the action (e.g. { value, text, key, restoreAuth, authName }). Supports `{{variable}}`. */
  sessionArgs?: Record<string, unknown>;
  /** Target URL. Supports `{{variable}}` interpolation. */
  url?: string;
  /** Inline HTML to render (serve_html / screenshot / pdf). Supports templates. */
  html?: string;
  /** Dot path into the node input to read the HTML from (chains after a transform). */
  htmlPath?: string;
  /** CSS selector for extract_text / extract_table (defaults to body / first table). */
  selector?: string;
  /** For fill_form: selector → value map. Supports `{{variable}}` in values. */
  formData?: Record<string, string>;
  /** For fill_form: optional element to click after filling (submit). */
  submitSelector?: string;
  /** Full-page screenshot (default true). */
  fullPage?: boolean;
  
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** Per-op timeout (default 30000ms). */
  timeout?: number;
  /** Artifact filename for the produced screenshot/pdf. */
  artifactName?: string;
}

// ────────────────────────────────────────────────────────────
// Utility & data primitives (WORKFLOW-UPDATE — n8n-inspired)
// ────────────────────────────────────────────────────────────

/**
 * Error-trigger entry node. A workflow whose entry is an `error_trigger` is run
 * when a *target* workflow reaches a terminal failure state. `targetWorkflowId`
 * undefined → any workflow in this workspace (except error-handler workflows
 * themselves, to prevent trigger loops).
 */
export interface ErrorTriggerNodeConfig {
  kind: 'error_trigger';
  targetWorkflowId?: string;
  onStatus: Array<'FAILED' | 'CANCELLED'>;
}

/** Explicitly terminate the run with a custom error (n8n "Stop and Error"). */
export interface StopErrorNodeConfig {
  kind: 'stop_error';
  errorMessage: string;
  errorCode?: string;
}


export interface CodeNodeConfig {
  kind: 'code';
  language: 'javascript' | 'python';
  code: string;
  /** Keys lifted from the node input into the script's `input` object. Empty = whole input. */
  inputKeys: string[];
  outputKey?: string;
  timeoutMs?: number;
}

/** Date/time parse, format, diff, arithmetic. Deterministic except `now`. */
export interface DateTimeNodeConfig {
  kind: 'datetime';
  operation: 'parse' | 'format' | 'diff' | 'add' | 'subtract' | 'now';
  /** Dot path into the node input for the primary date value. */
  inputPath?: string;
  inputFormat?: string;
  outputFormat?: string;
  timezone?: string;
  /** For `diff`: the unit of the returned difference. */
  diffUnit?: 'seconds' | 'minutes' | 'hours' | 'days' | 'months' | 'years';
  /** Second date for `diff` (dot path); defaults to now. */
  comparePath?: string;
  /** For add/subtract. */
  amount?: number;
  unit?: 'seconds' | 'minutes' | 'hours' | 'days' | 'months' | 'years';
  outputKey?: string;
}

/** Hash / HMAC / base64 / uuid primitives. */
export interface CryptoUtilNodeConfig {
  kind: 'crypto_util';
  operation: 'hash' | 'hmac' | 'base64_encode' | 'base64_decode' | 'uuid';
  algorithm?: 'sha256' | 'sha512' | 'md5';
  inputPath?: string;
  /** Dot path to the HMAC secret. */
  secretPath?: string;
  outputKey?: string;
}

/** XML ↔ JSON. */
export interface XmlParseNodeConfig {
  kind: 'xml_parse';
  operation: 'parse' | 'build';
  inputPath?: string;
  outputKey?: string;
}

/** Markdown ↔ HTML. */
export interface MarkdownNodeConfig {
  kind: 'markdown';
  operation: 'to_html' | 'from_html';
  inputPath?: string;
  outputKey?: string;
}

/** Validate the input (or a sub-path) against a JSON Schema string. */
export interface JsonSchemaValidateNodeConfig {
  kind: 'json_schema_validate';
  /** JSON Schema as a JSON string. */
  schema: string;
  inputPath?: string;
  /** `block` → throw on violation (routes to error edge); `flag` → add `violations` and continue. */
  onViolation: 'block' | 'flag';
}

/** Canvas annotation. No execution; a passthrough at run time. */
export interface StickyNoteNodeConfig {
  kind: 'sticky_note';
  content: string;
  color?: string;
  fontSize?: number;
}

/** Parse/build CSV or XLSX. */
export interface SpreadsheetNodeConfig {
  kind: 'spreadsheet';
  operation: 'parse' | 'build';
  format: 'csv' | 'xlsx';
  /** Dot path to CSV/base64-xlsx string (parse) or row array (build). */
  inputPath?: string;
  /** Sheet name or index for xlsx. */
  sheet?: string;
  hasHeaders?: boolean;
  outputKey?: string;
}

/** Extract values from an HTML string by CSS selector. */
export interface HtmlExtractNodeConfig {
  kind: 'html_extract';
  inputPath?: string;
  selector: string;
  extractAs: 'text' | 'html' | 'attribute';
  attribute?: string;
  multiple?: boolean;
  outputKey?: string;
}

/** Structured GraphQL query with variable binding. */
export interface GraphQlNodeConfig {
  kind: 'graphql';
  endpoint: string;
  query: string;
  /** `{{variable}}` templates resolved at dispatch. */
  variables?: Record<string, string>;
  headers?: Record<string, string>;
  credentialId?: string;
  outputKey?: string;
  timeoutMs?: number;
}

// ────────────────────────────────────────────────────────────
// Run state
// ────────────────────────────────────────────────────────────

export type WorkflowRunStatus =
  | 'CREATED'
  | 'PLANNING'
  | 'RUNNING'
  
  | 'PAUSED'
  | 'WAITING'
  | 'COMPLETED'
  /** The graph ran to completion but the final output did not match the declared outputContract. */
  | 'COMPLETED_WITH_CONTRACT_VIOLATION'
  /** The graph reached the end but a node errored (even if "handled" by an error edge) — NOT a clean success. Treated as a failure for surfacing + diagnosis. */
  | 'COMPLETED_WITH_ERRORS'
  | 'FAILED'
  | 'CANCELLED';

/** Mechanical process lifecycle, intentionally independent of worldly success. */
export type RunExecutionStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Business outcome. Only `accomplished` is a successful delivery. */
export type RunOutcomeStatus =
  | 'unverified'
  | 'accomplished'
  | 'blocked'
  | 'not_accomplished';

export interface RunEvidenceRef {
  kind: 'check' | 'artifact' | 'record' | 'http' | 'browser' | 'operator';
  id?: string;
  summary: string;
}

/** Public build input shared by chat, MCP, REST, import, and canvas callers. */
export interface WorkflowBuildRequest {
  description: string;
  title?: string;
  workflowId?: string;
  appId?: string;
  graphDraft?: WorkflowGraph | { graph: WorkflowGraph };
  patchDraft?: Record<string, unknown>;
  trigger?: { type?: 'manual' | 'cron' | 'webhook' | 'persistent_listener'; cron?: string };
}

/** Stable, repair-oriented validation response for authored workflow drafts. */
export interface WorkflowDraftDiagnostic {
  code: 'WORKFLOW_DRAFT_INVALID';
  summary: string;
  field?: string;
  acceptedShape: string;
  repair: string;
}

/** Executes a portable Component bundle through the hardened OCI runtime. */
export interface ComponentTaskNodeConfig {
  kind: 'component_task';
  componentId?: string;
  componentSlug?: string;
  operationName: string;
  /** Pin in production for reproducible execution. */
  version?: string;
  inputMapping: Record<string, string>;
  outputMapping: Record<string, string>;
  /** Durable workflow-scoped state loaded before execution and committed only after success. */
  stateBindings?: Record<string, {
    key: string;
    mode: 'read' | 'read_write' | 'set';
    /** Dot path in the component output used for write-back. Defaults to the binding name. */
    writeFrom?: string;
  }>;
  /** Dot path in the component input used as the stable execution identity. */
  idempotencyKeyPath?: string;
  timeoutMs?: number;
}

export interface RunSettlement {
  executionStatus: RunExecutionStatus;
  outcomeStatus: RunOutcomeStatus;
  revisionId: string | null;
  semanticHash: string | null;
  evidence: RunEvidenceRef[];
  deficiencies: Array<{ code: string; detail: string; producingNodeIds?: string[] }>;
  settledAt: string | null;
}

export interface MutationReceiptItem {
  id?: string;
  status: 'succeeded' | 'failed' | 'skipped';
  detail?: string;
}

export interface MutationReceipt {
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  idempotencyKey?: string;
  items: MutationReceiptItem[];
  verification: { performed: boolean; passed: boolean; detail?: string };
}

export type WorkflowNodeStatus =
  | 'PENDING'
  | 'WAITING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'SKIPPED';

export interface WorkflowRunState {
  runId: string;
  workflowId: string;
  status: WorkflowRunStatus;
  readyQueue: ReadyQueueItem[];
  waitingInputs: Record<string, WaitingInputBuffer>;
  nodeStates: Record<string, WorkflowNodeState>;
  activeExecutions: Record<string, ActiveExecution>;
  completedNodeIds: string[];
  failedNodeIds: string[];
  skippedNodeIds: string[];
  graphRevision: number;
  replanCount: number;
  lastLedgerSequence: number;
  /** Durable per-node self-heal attempt counts. Prevents restart-reset retry loops. */
  selfHealAttempts?: Record<string, number>;
  /** Durable per-node self-heal incidents. Keeps repair/blocked state visible across refresh/restart. */
  selfHealIncidents?: Record<string, WorkflowSelfHealIncident>;
}

export type WorkflowRevisionStatus =
  | 'candidate'
  | 'verifying'
  | 'verified'
  | 'active'
  | 'rejected'
  | 'superseded';

export type WorkflowTrustState =
  | 'proven'
  | 'candidate'
  | 'legacy_unverified'
  | 'unverified'
  | 'proven_equivalent'
  | 'break_glass'
  | 'regressed'
  | 'rejected';

export interface WorkflowRevisionSummary {
  id: string;
  workflowId: string;
  parentRevisionId?: string | null;
  semanticHash: string;
  presentationHash: string;
  source: string;
  reason: string;
  status: WorkflowRevisionStatus;
  trustState: WorkflowTrustState;
  proofProfile: string;
  verifiedAt?: string | null;
  promotedAt?: string | null;
  createdAt: string;
}

export type WorkflowFailureClass =
  | 'expected_business'
  | 'human_policy'
  | 'configuration_capability'
  | 'transient_resource'
  | 'data_contract'
  | 'graph_design'
  | 'platform'
  | 'cancellation_propagated'
  | 'unknown';

/** How much autonomy the workspace grants the recovery ladder. */
export type WorkflowRecoveryMode = 'guarded' | 'bypass';

/** Ordered recovery ladder. A tier is never retried with the same repair fingerprint. */
export type WorkflowRecoveryTier = 'deterministic' | 'minimal_patch' | 'rebuild';

export type WorkflowRepairPlanStatus = 'planned' | 'awaiting_approval' | 'applied' | 'rejected' | 'blocked' | 'rolled_back';

/** A durable record of one distinct repair plan within a failure lineage. */
export interface WorkflowRepairPlanRecord {
  id: string;
  tier: WorkflowRecoveryTier;
  /** Canonical patch fingerprint; duplicates are a hard circuit-breaker. */
  fingerprint: string;
  status: WorkflowRepairPlanStatus;
  requiresApproval: boolean;
  patchId?: string;
  checkpointId?: string;
  resumeNodeId?: string;
  riskReason?: string;
  createdAt: string;
  completedAt?: string;
}

export type WorkflowSelfHealIncidentStatus =
  | 'DIAGNOSING'
  | 'PLANNING'
  | 'RETRYING'
  | 'AWAITING_APPROVAL'
  | 'APPLYING'
  | 'APPLIED'
  | 'BLOCKED'
  | 'EXHAUSTED'
  | 'ROLLED_BACK';

export interface WorkflowSelfHealTraceEntry {
  id: string;
  phase: 'diagnose' | 'inspect' | 'repair' | 'verify' | 'resume' | 'blocked';
  status: WorkflowSelfHealIncidentStatus;
  summary: string;
  detail?: string;
  attempt: number;
  tier?: WorkflowRecoveryTier;
  createdAt: string;
}

export interface WorkflowSelfHealIncident {
  /** Stable lineage key. Legacy incidents use their node id. */
  incidentId?: string;
  nodeId: string;
  nodeTitle?: string;
  status: WorkflowSelfHealIncidentStatus;
  mode: WorkflowRecoveryMode;
  attempt: number;
  maxAttempts: number;
  tier?: WorkflowRecoveryTier;
  /** Normalized root-cause signature; survives engine restarts and graph revisions. */
  failureFingerprint?: string;
  failureClass?: WorkflowFailureClass;
  /** Structural fixes are always scoped to this run until a separate replay proves a candidate. */
  repairScope?: 'run_local';
  baseRevisionId?: string;
  candidateRevisionId?: string;
  recurrent?: boolean;
  /** All distinct plans considered for this incident, in execution order. */
  plans?: WorkflowRepairPlanRecord[];
  /** Durable, operator-safe reasoning trace. This is diagnostic evidence and
   * actions, never hidden model chain-of-thought. */
  trace?: WorkflowSelfHealTraceEntry[];
  error?: string;
  diagnosis?: string;
  reason?: string;
  riskReason?: string;
  approvalId?: string;
  checkpointId?: string;
  resumeNodeId?: string;
  outcome?:
    | 'output_fixed'
    | 'graph_patch_applied'
    | 'graph_patch_awaiting_approval'
    | 'retrying'
    | 'retry_awaiting_approval'
    | 'runtime_rebound'
    | 'runtime_rerouted'
    | 'blocked'
    | 'exhausted'
    | 'rolled_back';
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ReadyQueueItem {
  nodeId: string;
  priority: number;
  insertedAt: string;
  inputData: Record<string, unknown>;
  /**
   * AEJ idempotency key (NATIVE-ADVANCEMENT Proposal 1). Set when a node is
   * re-dispatched after crash recovery so dedup-capable handlers/connectors
   * (e.g. an HTTP `Idempotency-Key` header) make the retry effectively once.
   */
  idempotencyKey?: string;
}

export interface WaitingInputBuffer {
  requiredInputs: string[];
  receivedInputs: Record<string, unknown>;
  sourceNodeIds: string[];
}

export interface WorkflowNodeState {
  nodeId: string;
  status: WorkflowNodeStatus;
  /** Monotonic execution attempt within this run; survives pause/restart. */
  attempt?: number;
  startedAt?: string;
  completedAt?: string;
  inputData?: Record<string, unknown>;
  outputData?: Record<string, unknown>;
  /**
   * Set on the persisted snapshot when a terminal (COMPLETED/SKIPPED) node's
   * `inputData` was dropped to keep the run_state blob small. The input is
   * recoverable from the upstream nodes' `outputData` (retained). Never set on
   * live in-memory state — only in what `toPersistedRunState` writes to the DB.
   */
  inputOmitted?: boolean;
  /**
   * Present when an agent-like node completed with useful output, but could not
   * ground every declared output key. The run stays auditable and is downgraded
   * to COMPLETED_WITH_CONTRACT_VIOLATION at terminal status.
   */
  contractDeviation?: WorkflowNodeContractDeviation;
  /** Immutable presentation-safe snapshot of a message delivered by an integration. */
  deliveryReceipt?: IntegrationDeliveryReceipt;
  error?: string;
  
  blockedReason?: string;
}

export interface WorkflowNodeContractDeviation {
  kind: 'missing_declared_output_keys';
  declaredKeys: string[];
  missingKeys: string[];
  recoveredKeys: string[];
  message: string;
  outputPreview: Record<string, unknown>;
}

export interface IntegrationDeliveryReceipt {
  integrationId: string;
  operationId: string;
  /** Provider-issued proof for channel/message delivery operations. */
  providerMessageId?: string;
  deliveryStatus?: 'accepted' | 'delivered' | 'read' | 'queued';
  verified?: boolean;
  recipient?: string;
  subject?: string;
  contentType: 'html' | 'markdown' | 'text';
  content: string;
  /** Plain-text alternative when the delivered content was rich text. */
  text?: string;
  capturedAt?: string;
}

export interface ActiveExecution {
  taskId: string;
  nodeId: string;
  executorType:
    | 'agent'
    | 'extension'
    | 'subflow'
    | 'router'
    | 'wait'
    | 'http'
    | 'integration'
    | 'evaluator'
    | 'loop'
    | 'converge'
    | 'browser'
    | 'session';
  executorRef: string;
  startedAt: string;
  heartbeatAt?: string;
}

// ────────────────────────────────────────────────────────────
// Graph patches (dynamic edits during a run)
// ────────────────────────────────────────────────────────────

export interface WorkflowGraphPatch {
  patchId: string;
  reason: 'planner_replan' | 'user_edit' | 'hub_package_update' | 'self_heal' | 'agent_evolve';
  baseGraphRevision: number;
  addNodes: WorkflowNode[];
  updateNodes: WorkflowNode[];
  removeNodeIds: string[];
  addEdges: WorkflowEdge[];
  removeEdgeIds: string[];
}



