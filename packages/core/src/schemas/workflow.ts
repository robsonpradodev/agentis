import { z } from 'zod';
import { listenerConfigSchema } from './listener.js';

// ────────────────────────────────────────────────────────────
// Node configs
// ────────────────────────────────────────────────────────────

const outputConfigFields = {
  isOutput: z.boolean().optional(),
};

const scheduleRuleSchema = z.object({
  expression: z.string().min(1),
  timezone: z.string().optional(),
  label: z.string().optional(),
});

const triggerConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('trigger'),
  triggerType: z.enum([
    'manual',
    'cron',
    'webhook',
    'persistent_listener',
    'error_trigger',
    'email_imap',
    'rss_feed',
  ]),
  triggerId: z.string().uuid().optional(),
  /** Authoring form retained in the graph; deployment translates this to triggers.config.expression. */
  schedule: z.string().optional(),
  timezone: z.string().optional(),
  /** Multiple independent cron rules on one trigger (n8n-inspired). */
  scheduleRules: z.array(scheduleRuleSchema).optional(),
  /** Authoring form retained in the graph; deployment stores this object directly in triggers.config. */
  listenerConfig: listenerConfigSchema.optional(),
}).passthrough();

// Roles are an OPEN vocabulary (packages/core/src/types/specialist.ts —
// `AgentRole = PlatformRole | (string & {})`): any non-empty string is a legal
// specialist role, resolved on-demand via the workspace specialist system
// (POST /v1/specialists authors a brand-new specialist for an unknown role at
// dispatch time). This used to be a closed enum of the 10 legacy platform
// roles, which contradicted that design and rejected every custom role.
const agentRoleSchema = z.string().trim().min(1).max(64);

const agentRequirementsSchema = z.object({
  browser: z.boolean().optional(),
  codebaseIndex: z.boolean().optional(),
  fileSystem: z.boolean().optional(),
  terminal: z.boolean().optional(),
  computerUse: z.boolean().optional(),
  nativeMcp: z.boolean().optional(),
}).partial();

const agentArtifactPolicySchema = z.object({
  mode: z.enum(['intentional', 'all', 'none']).optional(),
  saveScreenshots: z.boolean().optional(),
  saveGeneratedAssets: z.boolean().optional(),
}).partial();

const agentTaskConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('agent_task'),
  agentId: z.string().uuid().optional(),
  agentRole: agentRoleSchema.optional(),
  agentPackageRef: z.string().optional(),
  capabilityTags: z.array(z.string()).default([]),
  requires: agentRequirementsSchema.optional(),
  prompt: z.string().min(1),
  inputKeys: z.array(z.string()).default([]).describe('Input allow-list: keep ONLY these top-level keys from the merged upstream input before this node runs. EMPTY (default) = pass the ENTIRE input through. Non-empty = every key NOT listed is dropped.'),
  outputKeys: z.array(z.string()).default([]).describe('The keys this node MUST return in its output object. Return EVERY key even when empty (typed empty: [] / false / 0 / "" / {}); an empty-but-complete contract is success. A genuinely-absent key is auto-completed with a typed empty at run time rather than failing the run.'),
  skills: z.array(z.string()).optional(),
  extensions: z.array(z.string()).optional(),
  modelOverride: z.string().optional(),
  castingReason: z.string().optional(),
  useRoleTools: z.boolean().optional(),
  useSession: z.boolean().optional(),
  maxToolSteps: z.number().int().min(1).max(12).optional(),
  memoryPolicy: z.enum(['form', 'episodic_only', 'none']).optional(),
  artifactPolicy: agentArtifactPolicySchema.optional(),
});

const agentSessionConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('agent_session'),
  agentId: z.string().uuid().optional(),
  agentRole: agentRoleSchema.optional(),
  prompt: z.string().min(1),
  persona: z.string().optional(),
  inputKeys: z.array(z.string()).default([]).describe('Input allow-list: keep ONLY these top-level keys from the merged upstream input before this node runs. EMPTY (default) = pass the ENTIRE input through. Non-empty = every key NOT listed is dropped.'),
  outputKeys: z.array(z.string()).default([]).describe('The keys this node MUST return in its output object. Return EVERY key even when empty (typed empty: [] / false / 0 / "" / {}); an empty-but-complete contract is success. A genuinely-absent key is auto-completed with a typed empty at run time rather than failing the run.'),
  maxSteps: z.number().int().positive().optional(),
  capabilityTags: z.array(z.string()).default([]),
  requires: agentRequirementsSchema.optional(),
  artifactPolicy: agentArtifactPolicySchema.optional(),
});

const extensionTaskConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('extension_task'),
  extensionId: z.string().min(1).optional(),
  extensionSlug: z.string().min(1).optional(),
  operationName: z.string().min(1),
  version: z.string().min(1).optional(),
  inputMapping: z.record(z.string(), z.string()).default({}).describe('Field remap { targetField: sourcePath }. EMPTY (default) = pass the ENTIRE upstream input through unchanged. Non-empty = build a NEW object with ONLY the mapped targetFields; every unmapped field is DROPPED (becomes undefined). sourcePath forms: "field", "inputs.field", or "scratchpad.x.y".'),
  outputMapping: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().positive().optional(),
});

const componentTaskConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('component_task'),
  componentId: z.string().min(1).optional(),
  componentSlug: z.string().min(1).optional(),
  operationName: z.string().min(1),
  version: z.string().min(1).optional(),
  inputMapping: z.record(z.string(), z.string()).default({}),
  outputMapping: z.record(z.string(), z.string()).default({}),
  stateBindings: z.record(z.string(), z.object({
    key: z.string().min(1),
    mode: z.enum(['read', 'read_write', 'set']),
    writeFrom: z.string().min(1).optional(),
  })).optional(),
  idempotencyKeyPath: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const knowledgeConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('knowledge'),
  knowledgeBaseId: z.string().optional(),
  queryMode: z.enum(['static', 'dynamic']).default('static'),
  query: z.string().optional(),
  queryNodeId: z.string().optional(),
  queryPath: z.string().optional(),
  retrievalMode: z.enum(['contextual', 'strict', 'exploratory']).default('contextual'),
  topK: z.number().int().min(1).max(20).default(5),
});

const knowledgeIngestConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('knowledge_ingest'),
  knowledgeBaseId: z.string().optional(),
  knowledgeBaseName: z.string().optional(),
  content: z.string().optional(),
  contentPath: z.string().optional(),
  documentName: z.string().optional(),
  documentNamePath: z.string().optional(),
  mimeType: z.string().optional(),
});

const routerConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('router'),
  routingMode: z.enum(['first_match', 'all_matching', 'llm_route', 'space_route']),
  branches: z
    .array(
      z.object({
        branchId: z.string(),
        label: z.string(),
        condition: z.string(),
      }),
    )
    .min(1),
});

const mergeConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('merge'),
  requiredInputs: z.union([z.literal('all'), z.literal('any'), z.array(z.string())]),
  parallelSourceId: z.string().min(1).optional(),
});

const checkpointConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('checkpoint'),
  approvalMode: z.enum(['manual', 'auto_after_timeout']),
  timeoutMs: z.number().int().positive().optional(),
});

const subflowConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('subflow'),
  workflowId: z.string().uuid(),
  inputMapping: z.record(z.string(), z.string()).default({}).describe('Field remap { targetField: sourcePath }. EMPTY (default) = pass the ENTIRE upstream input through unchanged. Non-empty = build a NEW object with ONLY the mapped targetFields; every unmapped field is DROPPED (becomes undefined). sourcePath forms: "field", "inputs.field", or "scratchpad.x.y".'),
  outputMapping: z.record(z.string(), z.string()).default({}),
});

const scratchpadConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('scratchpad'),
  operation: z.enum(['read', 'write', 'append', 'delete']),
  key: z.string().min(1),
  valuePath: z.string().optional(),
});

const workspaceStoreConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('workspace_store'),
  operations: z.array(z.object({
    op: z.enum(['get', 'set', 'delete', 'increment', 'append', 'get_all']),
    key: z.string().optional(),
    value: z.string().optional(),
    outputKey: z.string().optional(),
    incrementBy: z.number().optional(),
  })).default([]),
});

const returnOutputConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('return_output'),
  renderAs: z.enum(['html', 'markdown', 'table', 'json', 'text']).optional(),
  title: z.string().max(255).optional(),
  valuePath: z.string().optional(),
});

const artifactSaveConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('artifact_save'),
  name: z.string().min(1),
  artifactType: z.enum(['html', 'image', 'document', 'code', 'data']).optional(),
  contentPath: z.string().optional(),
  titlePath: z.string().optional(),
});

const browserConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('browser'),
  operation: z.enum(['serve_html', 'screenshot', 'pdf', 'navigate', 'extract_text', 'fill_form', 'extract_table', 'session']),
  sessionAction: z.string().optional(),
  sessionId: z.string().optional(),
  sessionArgs: z.record(z.string(), z.unknown()).optional(),
  url: z.string().optional(),
  html: z.string().optional(),
  htmlPath: z.string().optional(),
  selector: z.string().optional(),
  formData: z.record(z.string(), z.string()).optional(),
  submitSelector: z.string().optional(),
  fullPage: z.boolean().optional(),
  headless: z.boolean().optional(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  timeout: z.number().int().positive().optional(),
  artifactName: z.string().optional(),
});

// ────────────────────────────────────────────────────────────
// n8n-inspired utility & data primitives (WORKFLOW-UPDATE). These kinds have
// no dedicated inspector form on the canvas (they render through a generic
// schema-driven form — see ContextInspector.tsx's GenericForm), so the shapes
// here double as the introspection source for that renderer: field name,
// optionality, and (for enums) the option list all come straight from these
// schemas. Field sets mirror the authoritative TS configs in
// packages/core/src/types/workflow.ts one-for-one.
// ────────────────────────────────────────────────────────────

const dataQueryConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('data_query'),
  appId: z.string().min(1),
  collection: z.string().min(1),
  mode: z.enum(['query', 'aggregate']).optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
  sort: z.array(z.object({ field: z.string(), dir: z.enum(['asc', 'desc']) })).optional(),
  limit: z.number().int().positive().optional(),
  cursor: z.string().optional(),
  op: z.enum(['count', 'sum', 'avg', 'min', 'max']).optional(),
  field: z.string().optional(),
  groupBy: z.string().optional(),
  paginate: z.boolean().optional(),
  maxRows: z.number().int().positive().optional(),
  outputKey: z.string().optional(),
}).passthrough();

/** Normalize legacy batch authoring without keeping invented operations alive. */
export function normalizeLegacyDataMutateConfig(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const operation = source.operation === 'insert_many'
    ? 'insert'
    : source.operation === 'upsert_many'
      ? 'upsert'
      : source.operation;
  const { matchKey, ...rest } = source;
  return {
    ...rest,
    operation,
    ...(rest.matchFields === undefined && typeof matchKey === 'string' && matchKey.trim()
      ? { matchFields: [matchKey.trim()] }
      : {}),
  };
}

const dataMutateConfigObjectSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('data_mutate'),
  appId: z.string().min(1).optional(),
  collection: z.string().min(1),
  operation: z.enum(['insert', 'update', 'upsert', 'delete']),
  record: z.union([z.record(z.string(), z.unknown()), z.string().min(1)]).optional(),
  records: z.union([z.array(z.record(z.string(), z.unknown())).min(1).max(1000), z.string().min(1)]).optional(),
  recordId: z.string().optional(),
  match: z.record(z.string(), z.unknown()).optional(),
  matchFields: z.array(z.string().trim().min(1)).min(1).optional(),
  outputKey: z.string().optional(),
}).strict();

export const dataMutateConfigSchema = dataMutateConfigObjectSchema.superRefine((config, ctx) => {
  if (config.record && config.records) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'data_mutate accepts record or records, never both' });
  }
  if (config.operation === 'insert' && !config.record && !config.records) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'data_mutate insert requires record or records' });
  }
  if (config.operation === 'upsert') {
    if (!config.record && !config.records) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'data_mutate upsert requires record or records' });
    }
    if (config.records && !config.matchFields) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'data_mutate batch upsert requires matchFields' });
    }
    if (config.record && !config.match) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'data_mutate single upsert requires match' });
    }
  }
  if ((config.operation === 'update' || config.operation === 'delete') && !config.recordId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `data_mutate ${config.operation} requires recordId` });
  }
  if ((config.operation === 'update' || config.operation === 'delete') && config.records) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `data_mutate ${config.operation} does not support records` });
  }
});

const aggregateWindowConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('aggregate_window'),
  key: z.string().optional(),
  maxCount: z.number().int().positive().optional(),
  windowMs: z.number().int().positive().optional(),
  outputKey: z.string().optional(),
}).passthrough();

const errorTriggerConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('error_trigger'),
  targetWorkflowId: z.string().optional(),
  onStatus: z.array(z.enum(['FAILED', 'CANCELLED'])).default([]),
}).passthrough();

const stopErrorConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('stop_error'),
  errorMessage: z.string().min(1),
  errorCode: z.string().optional(),
}).passthrough();

const codeConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('code'),
  language: z.enum(['javascript', 'python']),
  code: z.string().min(1),
  inputKeys: z.array(z.string()).default([]),
  outputKey: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
}).passthrough();

const dateTimeConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('datetime'),
  operation: z.enum(['parse', 'format', 'diff', 'add', 'subtract', 'now']),
  inputPath: z.string().optional(),
  inputFormat: z.string().optional(),
  outputFormat: z.string().optional(),
  timezone: z.string().optional(),
  diffUnit: z.enum(['seconds', 'minutes', 'hours', 'days', 'months', 'years']).optional(),
  comparePath: z.string().optional(),
  amount: z.number().optional(),
  unit: z.enum(['seconds', 'minutes', 'hours', 'days', 'months', 'years']).optional(),
  outputKey: z.string().optional(),
}).passthrough();

const cryptoUtilConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('crypto_util'),
  operation: z.enum(['hash', 'hmac', 'base64_encode', 'base64_decode', 'uuid']),
  algorithm: z.enum(['sha256', 'sha512', 'md5']).optional(),
  inputPath: z.string().optional(),
  secretPath: z.string().optional(),
  outputKey: z.string().optional(),
}).passthrough();

const xmlParseConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('xml_parse'),
  operation: z.enum(['parse', 'build']),
  inputPath: z.string().optional(),
  outputKey: z.string().optional(),
}).passthrough();

const markdownConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('markdown'),
  operation: z.enum(['to_html', 'from_html']),
  inputPath: z.string().optional(),
  outputKey: z.string().optional(),
}).passthrough();

const jsonSchemaValidateConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('json_schema_validate'),
  schema: z.string().min(1),
  inputPath: z.string().optional(),
  onViolation: z.enum(['block', 'flag']),
}).passthrough();

const stickyNoteConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('sticky_note'),
  content: z.string().default(''),
  color: z.string().optional(),
  fontSize: z.number().optional(),
}).passthrough();

const spreadsheetConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('spreadsheet'),
  operation: z.enum(['parse', 'build']),
  format: z.enum(['csv', 'xlsx']),
  inputPath: z.string().optional(),
  sheet: z.string().optional(),
  hasHeaders: z.boolean().optional(),
  outputKey: z.string().optional(),
}).passthrough();

const htmlExtractConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('html_extract'),
  inputPath: z.string().optional(),
  selector: z.string().min(1),
  extractAs: z.enum(['text', 'html', 'attribute']),
  attribute: z.string().optional(),
  multiple: z.boolean().optional(),
  outputKey: z.string().optional(),
}).passthrough();

const graphqlConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('graphql'),
  endpoint: z.string().min(1),
  query: z.string().min(1),
  variables: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  credentialId: z.string().optional(),
  outputKey: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
}).passthrough();

/**
 * Kind → schema map for the ~15 utility/data-primitive kinds that share the
 * canvas's generic schema-driven inspector form (no bespoke `XxxForm`
 * component). Exported so the web app can introspect field name/type/options
 * straight from the same zod object the API validates against, instead of a
 * hand-duplicated field list that can drift.
 */
export const genericFormNodeConfigSchemas = {
  data_query: dataQueryConfigSchema,
  data_mutate: dataMutateConfigObjectSchema,
  aggregate_window: aggregateWindowConfigSchema,
  error_trigger: errorTriggerConfigSchema,
  stop_error: stopErrorConfigSchema,
  code: codeConfigSchema,
  datetime: dateTimeConfigSchema,
  crypto_util: cryptoUtilConfigSchema,
  xml_parse: xmlParseConfigSchema,
  markdown: markdownConfigSchema,
  json_schema_validate: jsonSchemaValidateConfigSchema,
  sticky_note: stickyNoteConfigSchema,
  spreadsheet: spreadsheetConfigSchema,
  html_extract: htmlExtractConfigSchema,
  graphql: graphqlConfigSchema,
} as const;

// Permissive config: accepts any object with a `kind` string. Concrete kinds
// (triggerConfigSchema, etc.) are validated by the engine when a node actually
// runs — at edit-time we don't want to reject draft workflows that still have
// incomplete or non-canonical config (e.g., a freshly dragged "approval" node
// with no fields yet, or legacy `variables` nodes from older versions).
const fallbackConfigSchema = z
  .object({ kind: z.string().min(1), ...outputConfigFields })
  .passthrough();

export const workflowNodeConfigSchema = z.union([
  triggerConfigSchema,
  agentTaskConfigSchema,
  agentSessionConfigSchema,
  extensionTaskConfigSchema,
  componentTaskConfigSchema,
  knowledgeConfigSchema,
  knowledgeIngestConfigSchema,
  routerConfigSchema,
  mergeConfigSchema,
  checkpointConfigSchema,
  subflowConfigSchema,
  scratchpadConfigSchema,
  workspaceStoreConfigSchema,
  returnOutputConfigSchema,
  artifactSaveConfigSchema,
  browserConfigSchema,
  dataQueryConfigSchema,
  dataMutateConfigSchema,
  aggregateWindowConfigSchema,
  errorTriggerConfigSchema,
  stopErrorConfigSchema,
  codeConfigSchema,
  dateTimeConfigSchema,
  cryptoUtilConfigSchema,
  xmlParseConfigSchema,
  markdownConfigSchema,
  jsonSchemaValidateConfigSchema,
  stickyNoteConfigSchema,
  spreadsheetConfigSchema,
  htmlExtractConfigSchema,
  graphqlConfigSchema,
  fallbackConfigSchema,
]);

export const workflowNodeSchema = z.object({
  id: z.string().min(1),
  // Permissive at edit-time. Engine validates execution-time semantics. `type`
  // and `title` are display/derived fields — the engine never requires them and
  // happily persists graphs without them, so the edit-time schema must accept
  // those too or autosave fails on graphs the engine just built. (A title is
  // backfilled from the node kind on persist; see normalizeWorkflowGraphTitles.)
  type: z.string().optional(),
  title: z.string().max(255).optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  config: workflowNodeConfigSchema,
  retryPolicy: z.object({
    maxAttempts: z.number().int().min(0).max(10),
    backoffMs: z.number().int().positive().optional(),
    retryOn: z.array(z.string()).optional(),
  }).optional(),
});

export const workflowEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceHandle: z.string().optional(),
  target: z.string().min(1),
  targetHandle: z.string().optional(),
  condition: z.string().optional(),
  type: z.enum(['default', 'error', 'condition']).optional(),
});

export const workflowPhaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  nodeIds: z.array(z.string().min(1)).min(1),
  collapsed: z.boolean().optional(),
  slaDurationMs: z.number().int().positive().optional(),
  budgetCents: z.number().int().nonnegative().optional(),
  humanGate: z.object({
    type: z.enum(['approve', 'provide_input', 'review_output']),
    message: z.string().max(1000).optional(),
    approvers: z.array(z.string()).optional(),
    timeoutMs: z.number().int().positive().optional(),
    onTimeout: z.enum(['escalate', 'auto_approve', 'fail']).optional(),
    escalateTo: z.string().optional(),
  }).optional(),
  successCriteria: z.string().max(4000).optional(),
  rollbackPlan: z.string().max(4000).optional(),
});

export const workflowContractSchema = z.object({
  fields: z.array(z.object({
    key: z.string().trim().min(1),
    type: z.enum(['string', 'number', 'boolean', 'array', 'object', 'any']),
    required: z.boolean().optional(),
    description: z.string().optional(),
    schema: z.string().optional(),
  })).min(1),
});

// Legacy "Studio" surface schemas removed — UI surfaces now live on the Agentic
// App (app_surfaces + AG-UI ViewNode, AGENTIC-APPS-10X §4). `.passthrough()`
// keeps any stored graph JSON that still carries an old `surfaces` key valid.

export const workflowGraphSchema = z.object({
  version: z.literal(1),
  nodes: z.array(workflowNodeSchema),
  edges: z.array(workflowEdgeSchema),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }),
  inputContract: workflowContractSchema.optional(),
  outputContract: workflowContractSchema.optional(),
  phases: z.array(workflowPhaseSchema).optional(),
}).passthrough();

/** Editor/API ingress accepts id-less edges; persistence canonicalization supplies stable ids. */
export const workflowIngressEdgeSchema = workflowEdgeSchema.extend({
  id: z.string().trim().min(1).optional(),
});

export const workflowGraphIngressSchema = workflowGraphSchema.extend({
  edges: z.array(workflowIngressEdgeSchema),
});


// ────────────────────────────────────────────────────────────
// API request bodies
// ────────────────────────────────────────────────────────────

export const createWorkflowSchema = z.object({
  workspaceId: z.string().uuid(),
  ambientId: z.string().uuid().nullable().optional(),
  spaceId: z.string().uuid().nullable().optional(),
  /** Specialist agent that owns this workflow (direct per-workflow responsibility). */
  ownerAgentId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(255),
  description: z.string().max(8000).nullable().optional(),
  graph: workflowGraphIngressSchema.optional(),
  settings: z.record(z.string(), z.unknown()).default({}),
});

export const updateWorkflowSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  spaceId: z.string().uuid().nullable().optional(),
  ownerAgentId: z.string().uuid().nullable().optional(),
  description: z.string().max(8000).nullable().optional(),
  graph: workflowGraphIngressSchema.optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  /** Optimistic-concurrency base for semantic graph edits. */
  baseRevisionId: z.string().min(1).optional(),
});

export const runWorkflowSchema = z.object({
  triggerId: z.string().uuid().optional(),
  inputs: z.record(z.string(), z.unknown()).default({}),
  /** Production runs omit this and always resolve the active revision. */
  revisionId: z.string().min(1).optional(),
  /**
   * `latest` is the editor's one-click path: run the current candidate when it
   * exists, otherwise the active revision. Scheduled/production callers still
   * default to `active`; `debug` remains the strict candidate-only API.
   */
  mode: z.enum(['active', 'debug', 'latest']).default('active'),
});

export const workflowDeploymentStatusSchema = z.object({
  status: z.enum(['active', 'paused']),
});

export const replayFromNodeSchema = z.object({
  preserveCompletedUpstream: z.boolean().default(true),
  inputsOverride: z.record(z.string(), z.unknown()).optional(),
});

export const workflowGraphPatchSchema = z.object({
  patchId: z.string().min(1),
  reason: z.enum(['planner_replan', 'user_edit', 'hub_package_update', 'self_heal', 'agent_evolve']),
  baseGraphRevision: z.number().int().nonnegative(),
  addNodes: z.array(workflowNodeSchema).default([]),
  updateNodes: z.array(workflowNodeSchema).default([]),
  removeNodeIds: z.array(z.string().min(1)).default([]),
  addEdges: z.array(workflowEdgeSchema).default([]),
  removeEdgeIds: z.array(z.string().min(1)).default([]),
});



