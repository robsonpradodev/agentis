/**
 * SQLite schema — Agentis embedded mode.
 *
 * Conventions:
 *  - Primary keys are TEXT UUIDs generated at the application layer
 *    (crypto.randomUUID()) for parity with PostgreSQL's `uuid` column.
 *  - JSON columns use `text({ mode: 'json' })`. SQLite stores JSON as TEXT;
 *    application code MUST treat reads as already-parsed values.
 *  - Timestamps are stored as ISO-8601 TEXT for sortability and zero-friction
 *    parity with PostgreSQL `timestamptz` columns. Default value is computed
 *    in `defaultTimestamps()` because better-sqlite3's CURRENT_TIMESTAMP
 *    omits timezone offset.
 *  - Every workspace-scoped row carries `workspace_id` and `user_id`. This is
 *    the multi-tenancy isolation contract; every query must filter by
 *    workspace, every API route must verify ownership.
 */

import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, real, primaryKey, uniqueIndex, index, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

const isoNow = () => sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

const baseTimestamps = () => ({
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
});

// ────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  email: text('email'),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(true),
  ...baseTimestamps(),
});

// ────────────────────────────────────────────────────────────
// Workspaces & ambients
// ────────────────────────────────────────────────────────────

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  description: text('description'),
  imageUrl: text('image_url'),
  defaultAmbientId: text('default_ambient_id'),
  issuePrefix: text('issue_prefix').notNull().default('AGT'),
  /** Layer 5 §5.3 — workspace/day cost ceiling (cents). null = uncapped. */
  dailyBudgetCents: integer('daily_budget_cents'),
  /** Brain — embedding provider for knowledge/memory vectorization + settings. */
  embeddingProviderType: text('embedding_provider_type').notNull().default('local'),
  embeddingProviderConfig: text('embedding_provider_config', { mode: 'json' }).notNull().default(sql`'{}'`),
  brainSettings: text('brain_settings', { mode: 'json' }).notNull().default(sql`'{}'`),
  ...baseTimestamps(),
});

export const ambients = sqliteTable('ambients', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** local | dev | staging | prod | fleet | custom */
  kind: text('kind').notNull().default('local'),
  settings: text('settings', { mode: 'json' }).notNull().default(sql`'{}'`),
  ...baseTimestamps(),
});

// OpenClaw Gateways
// ────────────────────────────────────────────────────────────

export const openclawGateways = sqliteTable('openclaw_gateways', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  gatewayUrl: text('gateway_url').notNull(),
  deviceTokenCredentialId: text('device_token_credential_id'),
  /** connected | degraded | disconnected | error */
  status: text('status').notNull().default('disconnected'),
  lastHeartbeatAt: text('last_heartbeat_at'),
  lastSyncAt: text('last_sync_at'),
  healthSnapshot: text('health_snapshot', { mode: 'json' }).notNull().default(sql`'{}'`),
  ...baseTimestamps(),
});

// ────────────────────────────────────────────────────────────
// Credentials (encrypted at rest with AES-256-GCM in CredentialVault)
// ────────────────────────────────────────────────────────────

export const credentials = sqliteTable('credentials', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  credentialType: text('credential_type').notNull(),
  /** AES-256-GCM ciphertext, base64; iv + ciphertext + tag concatenated. */
  encryptedValue: text('encrypted_value').notNull(),
  ...baseTimestamps(),
});

// ────────────────────────────────────────────────────────────
// Browser auth profiles — reusable "log in once" session state.
// storageState (cookies + localStorage) = credential-equivalent, so it is
// AES-256-GCM encrypted at rest in CredentialVault, same as `credentials`.
// Named + workspace-scoped so a session can be re-hydrated across runs.
// ────────────────────────────────────────────────────────────
export const browserAuthStates = sqliteTable('browser_auth_states', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** Provenance only — who saved it; the profile itself is workspace-scoped. */
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  /** AES-256-GCM ciphertext, base64, of the Playwright storageState JSON. */
  encryptedValue: text('encrypted_value').notNull(),
  ...baseTimestamps(),
}, (table) => ({
  nameUnique: uniqueIndex('idx_browser_auth_states_name').on(table.workspaceId, table.name),
}));

// ────────────────────────────────────────────────────────────
// OAuth app credentials (BYOC) — client id/secret per provider, entered via
// Settings → Integrations instead of env vars + a restart. Instance-wide
// (no workspace_id): the redirect URI registered with the provider is fixed
// per deployment (AGENTIS_PUBLIC_URL), not per workspace.
// ────────────────────────────────────────────────────────────
export const oauthAppCredentials = sqliteTable('oauth_app_credentials', {
  provider: text('provider').primaryKey(),
  /** AES-256-GCM ciphertext, base64, of JSON {clientId, clientSecret}. */
  encryptedValue: text('encrypted_value').notNull(),
  ...baseTimestamps(),
});

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  preview: text('preview').notNull(),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
  expiresAt: text('expires_at'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

// ────────────────────────────────────────────────────────────
// Spaces
// ────────────────────────────────────────────────────────────

export const domains = sqliteTable('domains', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  description: text('description'),
  colorHex: text('color_hex'),
  iconEmoji: text('icon_emoji'),
  /** The designated orchestrator/manager for this domain. For a subdomain (parentDomainId set) this is the responsible specialist. */
  managerId: text('manager_id').references((): AnySQLiteColumn => agents.id, { onDelete: 'set null' }),
  /** When set, this domain is a Subdomain nested under the referenced parent Domain. */
  parentDomainId: text('parent_domain_id').references((): AnySQLiteColumn => domains.id, { onDelete: 'set null' }),
  ...baseTimestamps(),
});

export const spaces = domains;

// ────────────────────────────────────────────────────────────
// Agents
// ────────────────────────────────────────────────────────────

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  gatewayId: text('gateway_id').references(() => openclawGateways.id, { onDelete: 'set null' }),
  packageId: text('package_id'),
  name: text('name').notNull(),
  description: text('description'),
  /** openclaw | claude_code | http */
  adapterType: text('adapter_type').notNull(),
  capabilityTags: text('capability_tags', { mode: 'json' }).notNull().default(sql`'[]'`),
  /** Adapter-specific config; validated by adapter schema before connect(). */
  config: text('config', { mode: 'json' }).notNull().default(sql`'{}'`),
  /** online | busy | offline | error */
  status: text('status').notNull().default('offline'),
  lastHeartbeatAt: text('last_heartbeat_at'),
  currentTaskId: text('current_task_id'),
  colorHex: text('color_hex'),
  instructions: text('instructions'),
  avatarGlyph: text('avatar_glyph'),
  avatarUrl: text('avatar_url'),
  runtimeModel: text('runtime_model'),
  /** orchestrator | manager | worker, with legacy free-text roles tolerated. */
  role: text('role'),
  reportsTo: text('reports_to'),
  spaceId: text('domain_id').references((): AnySQLiteColumn => domains.id, { onDelete: 'set null' }),
  /** Human-readable domain label (e.g. "marketing", "engineering"). Powers canvas cluster halos. */
  spaceTag: text('domain_tag'),
  isPaused: integer('is_paused', { mode: 'boolean' }).notNull().default(false),
  monthlyBudgetCents: integer('monthly_budget_cents'),
  currentMonthSpendCents: integer('current_month_spend_cents').notNull().default(0),
  budgetResetDay: integer('budget_reset_day').notNull().default(1),
  canvasPosition: text('canvas_position', { mode: 'json' }).$type<{ x: number; y: number } | null>(),
  ...baseTimestamps(),
});

// ────────────────────────────────────────────────────────────
// extensions & packages
// ────────────────────────────────────────────────────────────

export const agentPackages = sqliteTable('agent_packages', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  registryEntryId: text('registry_entry_id'),
  name: text('name').notNull(),
  version: text('version').notNull(),
  manifest: text('manifest', { mode: 'json' }).notNull(),
  installedAt: text('installed_at').notNull().default(isoNow() as unknown as string),
});

export const extensions = sqliteTable('extensions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  packageId: text('package_id').references(() => agentPackages.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  version: text('version').notNull(),
  /** builtin | node_worker | docker_sandbox */
  runtime: text('runtime').notNull(),
  manifest: text('manifest', { mode: 'json' }).notNull(),
  /**
   * Operator-set mapping of the manifest's declared `credentialKeys` (a name
   * the extension AUTHOR chose, e.g. "instagram_token") to a real `credentials`
   * row id in this workspace (INTEGRATION-CEILING-10X §3). Set by the operator
   * when installing/configuring the extension — never by the extension's own
   * code — so a sandboxed script can reference a credential by name but can
   * never choose which real secret backs it.
   */
  credentialBindings: text('credential_bindings', { mode: 'json' }).notNull().default('{}'),
  ...baseTimestamps(),
});

export const extensionExecutions = sqliteTable('extension_executions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  extensionId: text('extension_id')
    .notNull()
    .references(() => extensions.id, { onDelete: 'cascade' }),
  operationName: text('operation_name').notNull(),
  runId: text('run_id'),
  taskId: text('task_id'),
  status: text('status').notNull(),
  durationMs: integer('duration_ms'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  startedAt: text('started_at').notNull().default(isoNow() as unknown as string),
  finishedAt: text('finished_at'),
});

/**
 * Workspace-scoped extension KV store — EXTENSIONS-AND-LISTENER-10X §2.5.
 *
 * Distinct from the run-scoped scratchpad and the workflow-scoped KV: this is
 * keyed by (workspace, extension) so a listener-source extension can maintain
 * rolling state (last-seen cursor, rate-limit window, watched set) across every
 * workflow run that uses it. TTL is supported via `expires_at`.
 */
export const extensionKv = sqliteTable(
  'extension_kv',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    extensionId: text('extension_id')
      .notNull()
      .references(() => extensions.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value', { mode: 'json' }).notNull(),
    updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
    expiresAt: text('expires_at'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.extensionId, table.key] }),
  }),
);

// ────────────────────────────────────────────────────────────
// (AGENT-COOPERATION-10X). The run-scoped scratchpad/channel bus persists here
// so a convergence loop's working memory survives restart and is auditable.
// ────────────────────────────────────────────────────────────

export const blackboardEntries = sqliteTable(
  'blackboard_entries',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** converge.stateKey for loop state, else 'run'. */
    namespace: text('namespace').notNull().default('run'),
    /** fact | message | claim | artifact_ref */
    kind: text('kind').notNull(),
    /** KV key for facts. */
    key: text('key'),
    /** Channel name for messages (the gossip bus). */
    channel: text('channel'),
    /** Authoring identity — who + which runtime wrote it. */
    authorAgentId: text('author_agent_id'),
    authorRuntime: text('author_runtime'),
    authorLabel: text('author_label'),
    /** Convergence iteration that produced this entry. */
    iteration: integer('iteration').notNull().default(0),
    /** 0..1 confidence for claims. */
    confidence: real('confidence'),
    /** id of the entry this revises (disagreement is visible). */
    supersedes: text('supersedes'),
    value: text('value', { mode: 'json' }),
    createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  },
  (table) => ({
    byRun: index('idx_blackboard_run').on(table.runId, table.createdAt),
    byRunNs: index('idx_blackboard_run_ns').on(table.runId, table.namespace),
  }),
);

// ────────────────────────────────────────────────────────────
// Workflows, runs, run-state snapshots, tasks
// ────────────────────────────────────────────────────────────

export const workflows = sqliteTable('workflows', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  spaceId: text('domain_id').references(() => domains.id, { onDelete: 'set null' }),
  /** Specialist agent that owns this workflow (direct per-workflow responsibility). */
  ownerAgentId: text('owner_agent_id').references((): AnySQLiteColumn => agents.id, { onDelete: 'set null' }),
  /** Agentic App that owns this workflow. Null = bare workflow (App-of-one). AGENTIC-APPS-10X §3. */
  appId: text('app_id').references((): AnySQLiteColumn => apps.id, { onDelete: 'set null' }),
  registryEntryId: text('registry_entry_id'),
  registryVersion: text('registry_version'),
  title: text('title').notNull(),
  description: text('description'),
  graph: text('graph', { mode: 'json' }).notNull(),
  /** SHA-256 fingerprint of the canonical graph (divergence detection). Null until next save. */
  contentHash: text('content_hash'),
  /** Immutable revision currently trusted for production execution. */
  activeRevisionId: text('active_revision_id'),
  /** Editable revision head. It never affects production until promoted. */
  candidateRevisionId: text('candidate_revision_id'),
  /** proven | candidate | legacy_unverified | break_glass. */
  trustState: text('trust_state').notNull().default('legacy_unverified'),
  settings: text('settings', { mode: 'json' }).notNull().default(sql`'{}'`),
  isFromRegistry: integer('is_from_registry', { mode: 'boolean' }).notNull().default(false),
  maxConcurrentRuns: integer('max_concurrent_runs'),
  /** §5.3 — per-run cost ceiling (cents). null = uncapped. */
  budgetCents: integer('budget_cents'),
  /** queue | reject | replace_oldest. NOT NULL DEFAULT 'queue' so an omitted value can never trip the constraint. */
  concurrencyOverflow: text('concurrency_overflow').notNull().default('queue'),
  tags: text('tags', { mode: 'json' }).notNull().default(sql`'[]'`),
  ...baseTimestamps(),
});

/**
 * Encrypted, resumable browser state owned by one extension session.
 * The ciphertext contains Playwright storageState plus the last safe URL;
 * neither cookies nor token-bearing URLs are stored in plaintext.
 */
export const extensionBrowserCheckpoints = sqliteTable('extension_browser_checkpoints', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  extensionId: text('extension_id')
    .notNull()
    .references(() => extensions.id, { onDelete: 'cascade' }),
  sessionName: text('session_name').notNull(),
  encryptedValue: text('encrypted_value').notNull(),
  lastUsedAt: text('last_used_at').notNull(),
  ...baseTimestamps(),
}, (table) => ({
  ownerUnique: uniqueIndex('idx_extension_browser_checkpoint_owner').on(
    table.workspaceId,
    table.extensionId,
    table.sessionName,
  ),
  workspaceRecent: index('idx_extension_browser_checkpoint_recent').on(table.workspaceId, table.lastUsedAt),
}));

/** Non-secret, immutable launch facts for runtime parity and postmortems. */
export const agentExecutionEnvelopes = sqliteTable('agent_execution_envelopes', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  runId: text('run_id'),
  conversationId: text('conversation_id'),
  envelope: text('envelope_json', { mode: 'json' }).notNull(),
  observedAt: text('observed_at').notNull(),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
}, (table) => ({
  agentRecency: index('idx_agent_execution_envelopes_agent').on(table.workspaceId, table.agentId, table.observedAt),
}));

/**
 * Immutable workflow source revisions. `workflows.graph` remains a
 * compatibility mirror of the active row; this table is the source of truth.
 */
export const workflowGraphRevisions = sqliteTable(
  'workflow_graph_revisions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    parentRevisionId: text('parent_revision_id'),
    graphJson: text('graph_json', { mode: 'json' }).notNull(),
    semanticHash: text('semantic_hash').notNull(),
    presentationHash: text('presentation_hash').notNull(),
    source: text('source').notNull(),
    actorType: text('actor_type').notNull().default('system'),
    actorId: text('actor_id'),
    reason: text('reason').notNull().default(''),
    changeSummaryJson: text('change_summary_json', { mode: 'json' }).notNull().default(sql`'{}'`),
    specJson: text('spec_json', { mode: 'json' }),
    capabilityManifestJson: text('capability_manifest_json', { mode: 'json' }).notNull().default(sql`'{}'`),
    proofProfile: text('proof_profile').notNull().default('standard'),
    status: text('status').notNull().default('candidate'),
    trustState: text('trust_state').notNull().default('unverified'),
    verifiedAt: text('verified_at'),
    promotedAt: text('promoted_at'),
    rejectedAt: text('rejected_at'),
    createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
    updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
  },
  (table) => ({
    workflowCreated: index('idx_workflow_graph_revisions_workflow').on(
      table.workspaceId,
      table.workflowId,
      table.createdAt,
    ),
    workflowHash: index('idx_workflow_graph_revisions_hash').on(
      table.workspaceId,
      table.workflowId,
      table.semanticHash,
    ),
    workflowStatus: index('idx_workflow_graph_revisions_status').on(
      table.workspaceId,
      table.workflowId,
      table.status,
    ),
  }),
);

export const workflowRevisionProofs = sqliteTable(
  'workflow_revision_proofs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    revisionId: text('revision_id')
      .notNull()
      .references(() => workflowGraphRevisions.id, { onDelete: 'cascade' }),
    gate: text('gate').notNull(),
    status: text('status').notNull(),
    semanticHash: text('semantic_hash').notNull(),
    fixtureKey: text('fixture_key').notNull().default('default'),
    runId: text('run_id'),
    capabilityCatalogVersion: text('capability_catalog_version'),
    evidenceJson: text('evidence_json', { mode: 'json' }).notNull().default(sql`'{}'`),
    createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
    updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
  },
  (table) => ({
    revisionGate: uniqueIndex('uq_workflow_revision_proof_gate').on(
      table.revisionId,
      table.gate,
      table.fixtureKey,
    ),
    revisionStatus: index('idx_workflow_revision_proofs_status').on(table.revisionId, table.status),
  }),
);

/**
 * A durable, evidence-backed lesson. Raw failures are observations; only a
 * verified repair or accomplished run may become an active experience.
 */
export const workflowExperiences = sqliteTable(
  'workflow_experiences',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id').references(() => workflows.id, { onDelete: 'cascade' }),
    appId: text('app_id').references((): AnySQLiteColumn => apps.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').references((): AnySQLiteColumn => agents.id, { onDelete: 'set null' }),
    revisionId: text('revision_id').references(() => workflowGraphRevisions.id, { onDelete: 'set null' }),
    scopeType: text('scope_type').notNull(),
    scopeId: text('scope_id').notNull(),
    applicabilityKey: text('applicability_key').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('pending'),
    failureFingerprint: text('failure_fingerprint'),
    failureClass: text('failure_class'),
    title: text('title').notNull(),
    rootCause: text('root_cause').notNull().default(''),
    repairSummary: text('repair_summary').notNull().default(''),
    preconditionsJson: text('preconditions_json', { mode: 'json' }).notNull().default(sql`'{}'`),
    regressionFixtureJson: text('regression_fixture_json', { mode: 'json' }),
    evidenceJson: text('evidence_json', { mode: 'json' }).notNull().default(sql`'{}'`),
    confidence: real('confidence').notNull().default(0),
    successCount: integer('success_count').notNull().default(0),
    supersedesId: text('supersedes_id'),
    createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
    updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
  },
  (table) => ({
    scopeApplicability: index('idx_workflow_experiences_scope').on(
      table.workspaceId,
      table.scopeType,
      table.scopeId,
      table.status,
    ),
    workflowFingerprint: index('idx_workflow_experiences_fingerprint').on(
      table.workspaceId,
      table.workflowId,
      table.failureFingerprint,
    ),
    activeApplicability: index('idx_workflow_experiences_applicability').on(
      table.workspaceId,
      table.scopeType,
      table.scopeId,
      table.applicabilityKey,
      table.status,
    ),
  }),
);

/** Cross-run repair budget keyed by stable failure fingerprint and base revision. */
export const workflowRepairAttempts = sqliteTable(
  'workflow_repair_attempts',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    baseRevisionId: text('base_revision_id').references(() => workflowGraphRevisions.id, { onDelete: 'set null' }),
    failureFingerprint: text('failure_fingerprint').notNull(),
    runId: text('run_id'),
    nodeId: text('node_id'),
    status: text('status').notNull().default('proposed'),
    candidateRevisionId: text('candidate_revision_id').references(() => workflowGraphRevisions.id, { onDelete: 'set null' }),
    attemptCount: integer('attempt_count').notNull().default(1),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
    updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
  },
  (table) => ({
    fingerprintRevision: uniqueIndex('uq_workflow_repair_attempt_fingerprint').on(
      table.workspaceId,
      table.workflowId,
      table.baseRevisionId,
      table.failureFingerprint,
    ),
  }),
);

export const triggers = sqliteTable('triggers', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  workflowId: text('workflow_id')
    .notNull()
    .references(() => workflows.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** manual | cron | webhook | persistent_listener */
  triggerType: text('trigger_type').notNull(),
  config: text('config', { mode: 'json' }).notNull().default(sql`'{}'`),
  /** active | paused | error */
  status: text('status').notNull().default('paused'),
  lastFiredAt: text('last_fired_at'),
  /** HMAC secret for webhook triggers, base64. Never returned over the wire. */
  webhookSecret: text('webhook_secret'),
  ...baseTimestamps(),
});

/**
 * Workflow-scoped persistent KV — survives run boundaries.
 *
 * Distinct from the run-scoped scratchpad: a daily workflow can accumulate
 * state across 30+ runs without external infrastructure. Brain can index
 * these entries as structured facts per workflow - the `workspace_id`
 * column already provides the scope needed for that without a migration.
 */
export const workflowKvEntries = sqliteTable('workflow_kv_entries', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  workflowId: text('workflow_id')
    .notNull()
    .references(() => workflows.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  /** JSON-encoded value. */
  value: text('value', { mode: 'json' }).notNull(),
  /** Bumped on every write — supports optimistic concurrency in v1.1. */
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
}, (table) => ({
  workflowKeyUnique: uniqueIndex('uq_workflow_kv_key').on(table.workspaceId, table.workflowId, table.key),
}));

/** Tier-3 state: workspace-scoped KV shared across all workflows (§4.1). */
export const workspaceKv = sqliteTable('workspace_kv', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  value: text('value', { mode: 'json' }).notNull(),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
});

/** Full per-run audit trail — every node/run action attributed (§5.4). */
export const auditEntries = sqliteTable('audit_entries', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull(),
  phaseId: text('phase_id'),
  nodeId: text('node_id'),
  agentId: text('agent_id'),
  action: text('action').notNull(),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id').notNull(),
  inputSummary: text('input_summary'),
  outputSummary: text('output_summary'),
  costCents: integer('cost_cents'),
  // Real model token consumption for this node, recorded on the single terminal
  // (`node.completed`) entry per node so analytics can SUM without double counting.
  // Populated by every agent execution path (session / tool-loop / dispatch);
  // exact when the runtime reports usage, estimated otherwise. Migration v105.
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  at: text('at').notNull().default(isoNow() as unknown as string),
});

export const workflowRuns = sqliteTable('workflow_runs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  workflowId: text('workflow_id')
    .references(() => workflows.id, { onDelete: 'cascade' }),
  conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  /** CREATED | PLANNING | RUNNING | WAITING | COMPLETED | FAILED | CANCELLED */
  status: text('status').notNull().default('CREATED'),
  /** Mechanical lifecycle projected from legacy status. */
  executionStatus: text('execution_status').notNull().default('queued'),
  /** World/business result; successful only when accomplished. */
  outcomeStatus: text('outcome_status').notNull().default('unverified'),
  settlement: text('settlement_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  runState: text('run_state', { mode: 'json' }).notNull(),
  replanCount: integer('replan_count').notNull().default(0),
  isReplay: integer('is_replay', { mode: 'boolean' }).notNull().default(false),
  isEphemeral: integer('is_ephemeral', { mode: 'boolean' }).notNull().default(false),
  ephemeralTitle: text('ephemeral_title'),
  graphSnapshot: text('graph_snapshot', { mode: 'json' }),
  /** Exact immutable source revision used to create this run. */
  workflowRevisionId: text('workflow_revision_id').references(() => workflowGraphRevisions.id, { onDelete: 'set null' }),
  /** Base revision when this run was repaired locally. */
  repairedFromRevisionId: text('repaired_from_revision_id').references(() => workflowGraphRevisions.id, { onDelete: 'set null' }),
  triggerId: text('trigger_id').references(() => triggers.id, { onDelete: 'set null' }),
  /** When this run was forked from a previous one (replay-from-node). */
  parentRunId: text('parent_run_id'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  ...baseTimestamps(),
});

export const workflowRunSnapshots = sqliteTable('workflow_run_snapshots', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => workflowRuns.id, { onDelete: 'cascade' }),
  /** Monotonic counter of ledger events at snapshot time; used for recovery. */
  sequenceNumber: integer('sequence_number').notNull(),
  runState: text('run_state', { mode: 'json' }).notNull(),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

/** Durable before/after snapshots for self-healing rollback. */
export const workflowRepairCheckpoints = sqliteTable('workflow_repair_checkpoints', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull().references(() => workflowRuns.id, { onDelete: 'cascade' }),
  workflowId: text('workflow_id').references(() => workflows.id, { onDelete: 'set null' }),
  incidentId: text('incident_id').notNull(),
  planId: text('plan_id').notNull(),
  revisionBefore: integer('revision_before').notNull(),
  revisionAfter: integer('revision_after').notNull(),
  graphBefore: text('graph_before', { mode: 'json' }).notNull(),
  graphAfter: text('graph_after', { mode: 'json' }).notNull(),
  patch: text('patch', { mode: 'json' }).notNull(),
  rolledBackAt: text('rolled_back_at'),
  ...baseTimestamps(),
}, (table) => ({
  runRecency: index('idx_workflow_repair_checkpoints_run').on(table.runId, table.createdAt),
  planUnique: uniqueIndex('idx_workflow_repair_checkpoints_plan').on(table.runId, table.planId),
}));

export const workflowRunQueue = sqliteTable('workflow_run_queue', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  workflowId: text('workflow_id')
    .notNull()
    .references(() => workflows.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  triggerId: text('trigger_id').references(() => triggers.id, { onDelete: 'set null' }),
  inputs: text('inputs', { mode: 'json' }).notNull().default(sql`'{}'`),
  initialState: text('initial_state', { mode: 'json' }),
  graphSnapshot: text('graph_snapshot', { mode: 'json' }),
  enqueuedAt: text('enqueued_at').notNull().default(isoNow() as unknown as string),
  scheduledAt: text('scheduled_at'),
  priority: integer('priority').notNull().default(0),
  reason: text('reason').notNull(),
  parentRunId: text('parent_run_id'),
  chainDepth: integer('chain_depth').notNull().default(0),
  /** Stable identity of the already-created workflow run carried by this queue row. */
  runId: text('run_id').references(() => workflowRuns.id, { onDelete: 'cascade' }),
  /** Caller-supplied durable enqueue identity. NULL keeps legacy/manual enqueues unrestricted. */
  idempotencyKey: text('idempotency_key'),
  status: text('status').notNull().default('pending'),
  ...baseTimestamps(),
}, (table) => ({
  idempotencyUnique: uniqueIndex('idx_workflow_run_queue_idempotency').on(table.workspaceId, table.idempotencyKey),
}));

export const nodeExecutionCache = sqliteTable(
  'node_execution_cache',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').notNull(),
    inputHash: text('input_hash').notNull(),
    output: text('output', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
    expiresAt: text('expires_at').notNull(),
    hitCount: integer('hit_count').notNull().default(0),
    byteSize: integer('byte_size').notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.workflowId, table.nodeId, table.inputHash] }),
  }),
);

export const workflowEventSubscriptions = sqliteTable('workflow_event_subscriptions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  sourceWorkflowId: text('source_workflow_id')
    .notNull()
    .references(() => workflows.id, { onDelete: 'cascade' }),
  targetWorkflowId: text('target_workflow_id')
    .notNull()
    .references(() => workflows.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  sourceNodeId: text('source_node_id'),
  filterExpression: text('filter_expression'),
  inputMapping: text('input_mapping', { mode: 'json' }).notNull().default(sql`'{}'`),
  coalescePolicy: text('coalesce_policy').notNull().default('always_enqueue'),
  catchupPolicy: text('catchup_policy').notNull().default('enqueue_missed_with_cap:5'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  ...baseTimestamps(),
});

/**
 * Durable inbox/outbox bridge for workflow-to-workflow event rules.
 *
 * An event is first journaled here with a stable identity, then claimed with a
 * lease and idempotently converted into a workflow_run_queue row. This makes a
 * bus replay, concurrent consumer, or process crash at-least-once at the
 * delivery layer while keeping target-run creation exactly-once.
 */
export const workflowEventDeliveries = sqliteTable('workflow_event_deliveries', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  subscriptionId: text('subscription_id')
    .notNull()
    .references(() => workflowEventSubscriptions.id, { onDelete: 'cascade' }),
  eventIdentity: text('event_identity').notNull(),
  eventType: text('event_type').notNull(),
  eventPayload: text('event_payload', { mode: 'json' }).notNull().default(sql`'{}'`),
  eventEmittedAt: text('event_emitted_at').notNull(),
  correlationId: text('correlation_id'),
  sourceRunId: text('source_run_id')
    .notNull()
    .references(() => workflowRuns.id, { onDelete: 'cascade' }),
  sourceNodeId: text('source_node_id'),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  availableAt: text('available_at').notNull().default(isoNow() as unknown as string),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: text('lease_expires_at'),
  targetQueueId: text('target_queue_id').references(() => workflowRunQueue.id, { onDelete: 'set null' }),
  targetRunId: text('target_run_id').references(() => workflowRuns.id, { onDelete: 'set null' }),
  lastError: text('last_error'),
  deliveredAt: text('delivered_at'),
  ...baseTimestamps(),
}, (table) => ({
  eventUnique: uniqueIndex('idx_workflow_event_delivery_identity').on(table.subscriptionId, table.eventIdentity),
  due: index('idx_workflow_event_delivery_due').on(table.status, table.availableAt),
  lease: index('idx_workflow_event_delivery_lease').on(table.status, table.leaseExpiresAt),
}));

export const scheduleRuns = sqliteTable('schedule_runs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  workflowId: text('workflow_id')
    .notNull()
    .references(() => workflows.id, { onDelete: 'cascade' }),
  triggerId: text('trigger_id')
    .notNull()
    .references(() => triggers.id, { onDelete: 'cascade' }),
  scheduledAt: text('scheduled_at').notNull(),
  lastFiredAt: text('last_fired_at'),
  missedFires: integer('missed_fires').notNull().default(0),
  status: text('status').notNull().default('active'),
  ...baseTimestamps(),
});

export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  runId: text('run_id').references(() => workflowRuns.id, { onDelete: 'set null' }),
  workflowId: text('workflow_id').references(() => workflows.id, { onDelete: 'set null' }),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  /** Assets §1 — the App that produced/owns this artifact (when any). */
  appId: text('app_id').references(() => apps.id, { onDelete: 'set null' }),
  conversationId: text('conversation_id'),
  nodeId: text('node_id'),
  /** Assets §1 — what generated it: agent | app | workflow | channel | manual. */
  origin: text('origin').notNull().default('manual'),
  /** html | image | document | code | data */
  type: text('type').notNull().default('document'),
  title: text('title').notNull(),
  content: text('content').notNull().default(''),
  thumbnailUrl: text('thumbnail_url'),
  metadata: text('metadata', { mode: 'json' }).notNull().default(sql`'{}'`),
  /** §6.4 — pinned to the workspace output gallery (survives run cleanup). */
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  ...baseTimestamps(),
});

export const rooms = sqliteTable('rooms', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** workspace | custom | thread */
  kind: text('kind').notNull().default('custom'),
  name: text('name').notNull(),
  description: text('description'),
  
  visibility: text('visibility').notNull().default('workspace'),
  pinnedAt: text('pinned_at'),
  lastMessageAt: text('last_message_at'),
  ...baseTimestamps(),
});

export const roomAgents = sqliteTable('room_agents', {
  roomId: text('room_id')
    .notNull()
    .references(() => rooms.id, { onDelete: 'cascade' }),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  addedAt: text('added_at').notNull().default(isoNow() as unknown as string),
  addedBy: text('added_by'),
});

export const roomMessages = sqliteTable('room_messages', {
  id: text('id').primaryKey(),
  roomId: text('room_id')
    .notNull()
    .references(() => rooms.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  
  authorType: text('author_type').notNull(),
  authorId: text('author_id'),
  contentType: text('content_type').notNull().default('text'),
  content: text('content', { mode: 'json' }).notNull().default(sql`'{}'`),
  replyToId: text('reply_to_id'),
  mentions: text('mentions', { mode: 'json' }).notNull().default(sql`'[]'`),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  workflowId: text('workflow_id')
    .notNull()
    .references(() => workflows.id, { onDelete: 'cascade' }),
  runId: text('run_id').references(() => workflowRuns.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  nodeId: text('node_id').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  /** agent | extension | subflow | router */
  executorType: text('executor_type').notNull(),
  /** agentId, extensionId, workflowId, or router id. */
  executorRef: text('executor_ref').notNull(),
  capabilityTags: text('capability_tags', { mode: 'json' }).notNull().default(sql`'[]'`),
  status: text('status').notNull().default('PENDING'),
  inputData: text('input_data', { mode: 'json' }).notNull().default(sql`'{}'`),
  outputData: text('output_data', { mode: 'json' }),
  error: text('error'),
  ...baseTimestamps(),
});

// ────────────────────────────────────────────────────────────
// Ledger — append-only event log per run.
// Indexed by (run_id, sequence_number); see migrations/0000_init.sql.
// ────────────────────────────────────────────────────────────

export const ledgerEvents = sqliteTable('ledger_events', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  runId: text('run_id')
    .notNull()
    .references(() => workflowRuns.id, { onDelete: 'cascade' }),
  /** Monotonic per-run sequence. Replay reads in this order. */
  sequenceNumber: integer('sequence_number').notNull(),
  eventType: text('event_type').notNull(),
  nodeId: text('node_id'),
  taskId: text('task_id'),
  payload: text('payload', { mode: 'json' }).notNull().default(sql`'{}'`),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

// ────────────────────────────────────────────────────────────
// Activity, approvals, conversations
// ────────────────────────────────────────────────────────────

export const activityEvents = sqliteTable('activity_events', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  /** user | agent | gateway | system */
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id'),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  summary: text('summary').notNull(),
  metadata: text('metadata', { mode: 'json' }).notNull().default(sql`'{}'`),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

/**
 * Realtime observability spine.
 *
 * Unlike `activity_events` (human audit/activity history) and `ledger_events`
 * (run-local engine log), this table is the durable, replayable event stream
 * that powers live command-center surfaces across workspace/run/agent/workflow
 * scopes.
 */
export const observabilityEvents = sqliteTable(
  'observability_events',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sequenceNumber: integer('sequence_number').notNull(),
    scopeType: text('scope_type').notNull().default('workspace'),
    scopeId: text('scope_id'),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('info'),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    detail: text('detail'),
    actorType: text('actor_type'),
    actorId: text('actor_id'),
    targetType: text('target_type'),
    targetId: text('target_id'),
    runId: text('run_id').references(() => workflowRuns.id, { onDelete: 'set null' }),
    workflowId: text('workflow_id').references(() => workflows.id, { onDelete: 'set null' }),
    agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    nodeId: text('node_id'),
    approvalId: text('approval_id'),
    correlationId: text('correlation_id'),
    parentEventId: text('parent_event_id'),
    progress: text('progress', { mode: 'json' }).$type<{ completed?: number; total?: number; label?: string } | null>(),
    evidence: text('evidence', { mode: 'json' }).notNull().default(sql`'[]'`).$type<Array<Record<string, unknown>>>(),
    rawPayloadRedacted: text('raw_payload_redacted', { mode: 'json' }).notNull().default(sql`'{}'`).$type<Record<string, unknown>>(),
    sourceEvent: text('source_event').notNull(),
    createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  },
  (table) => ({
    workspaceSequence: uniqueIndex('observability_events_workspace_sequence')
      .on(table.workspaceId, table.sequenceNumber),
    workspaceCreated: index('observability_events_workspace_created')
      .on(table.workspaceId, table.createdAt),
    scopeSequence: index('observability_events_scope_sequence')
      .on(table.scopeType, table.scopeId, table.sequenceNumber),
    runSequence: index('observability_events_run_sequence')
      .on(table.runId, table.sequenceNumber),
    agentSequence: index('observability_events_agent_sequence')
      .on(table.agentId, table.sequenceNumber),
    workflowSequence: index('observability_events_workflow_sequence')
      .on(table.workflowId, table.sequenceNumber),
  }),
);

export const budgetEvents = sqliteTable('budget_events', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  runId: text('run_id').references(() => workflowRuns.id, { onDelete: 'set null' }),
  /** spend | limit_hit | extension_granted | reset */
  eventType: text('event_type').notNull(),
  amountCents: integer('amount_cents').notNull(),
  /** Headroom remaining after this event, in cents. */
  balanceAfterCents: integer('balance_after_cents').notNull(),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

export const approvalRequests = sqliteTable('approval_requests', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  runId: text('run_id').references(() => workflowRuns.id, { onDelete: 'cascade' }),
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  /** Checkpoint node id or phase id used to resume a persisted workflow wait. */
  targetId: text('target_id'),
  gatewayId: text('gateway_id').references(() => openclawGateways.id, { onDelete: 'set null' }),
  /** checkpoint | phase_gate | openclaw_exec | package_install | credential_access */
  source: text('source').notNull(),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  confidence: integer('confidence'),
  /** Source-specific structured data. Self-heal approvals persist the patch here. */
  payload: text('payload', { mode: 'json' }).notNull().default(sql`'{}'`),
  /** pending | approved | rejected | expired | cancelled */
  status: text('status').notNull().default('pending'),
  resolutionReason: text('resolution_reason'),
  resolvedAt: text('resolved_at'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  /** OpenClaw Gateway session id when mirrored; null for Agentis-originated threads. */
  mirroredSessionId: text('mirrored_session_id'),
  /** Channel-scoped thread owner, when this conversation is isolated to an external chat. */
  channelConnectionId: text('channel_connection_id')
    .references((): AnySQLiteColumn => channelConnections.id, { onDelete: 'set null' }),
  /** Provider chat/thread id used with channelConnectionId to isolate external conversations. */
  channelChatId: text('channel_chat_id'),
  /** Canonical provider peer. Multiple legacy PN/LID conversations may share one peer. */
  channelPeerIdentityId: text('channel_peer_identity_id')
    .references((): AnySQLiteColumn => channelPeerIdentities.id, { onDelete: 'set null' }),
  /** When set, this thread belongs to an Agentic App — the agent answers in App context (Living Apps Phase 0, migration v95). */
  appId: text('app_id').references((): AnySQLiteColumn => apps.id, { onDelete: 'set null' }),
  /** null | human. Human ownership is conversation-scoped and survives restarts. */
  handoffState: text('handoff_state'),
  /** explicit | provider_observed. Kept separate from state for audit and UX. */
  handoffSource: text('handoff_source'),
  handoffClaimedAt: text('handoff_claimed_at'),
  /** Incremented on every ownership transition; stale automation must present the epoch it started under. */
  automationEpoch: integer('automation_epoch').notNull().default(0),
  
  needsAttention: integer('needs_attention').notNull().default(0),
  
  needsAttentionReason: text('needs_attention_reason'),
  title: text('title'),
  /** chat | plan */
  executionMode: text('execution_mode').notNull().default('chat'),
  /** Per-conversation permission mode: ask | plan | auto (see migration v93). */
  permissionMode: text('permission_mode').notNull().default('ask'),
  /** Ask-mode escalation threshold: cautious | balanced | autonomous (v129). */
  approvalSensitivity: text('approval_sensitivity').notNull().default('balanced'),
  archivedAt: text('archived_at'),
  unreadCount: integer('unread_count').notNull().default(0),
  lastMessageAt: text('last_message_at'),
  ...baseTimestamps(),
});

export const runtimeSessions = sqliteTable(
  'runtime_sessions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),
    sessionKey: text('session_key').notNull(),
    executionMode: text('execution_mode').notNull().default('chat'),
    runtimeProfileId: text('runtime_profile_id'),
    runtimeSessionId: text('runtime_session_id').notNull(),
    processGeneration: integer('process_generation').notNull().default(1),
    selectedModel: text('selected_model'),
    status: text('status').notNull().default('idle'),
    lastUsedAt: text('last_used_at').notNull().default(isoNow() as unknown as string),
    ...baseTimestamps(),
  },
  (table) => ({
    owner: uniqueIndex('runtime_sessions_owner').on(
      table.workspaceId,
      table.agentId,
      table.sessionKey,
      table.executionMode,
    ),
  }),
);

export const conversationMessages = sqliteTable('conversation_messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  
  authorType: text('author_type').notNull(),
  authorId: text('author_id'),
  /** Channel conversational side. Null keeps ordinary platform-chat semantics. */
  participantSide: text('participant_side').$type<'customer' | 'business' | null>(),
  /** Reference to the OpenClaw session.message id when mirrored. */
  sessionMessageId: text('session_message_id'),
  issueId: text('issue_id'),
  body: text('body').notNull(),
  metadata: text('metadata', { mode: 'json' }).notNull().default(sql`'{}'`),
  /** sent | delivered | failed | mirrored */
  deliveryStatus: text('delivery_status').notNull().default('sent'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

/** Durable, sanitized operator-facing activity for workflow runs. */
export const runActivityEvents = sqliteTable('run_activity_events', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull().references(() => workflowRuns.id, { onDelete: 'cascade' }),
  nodeId: text('node_id'),
  agentId: text('agent_id'),
  activityId: text('activity_id').notNull(),
  event: text('event').notNull(),
  kind: text('kind'),
  phase: text('phase'),
  status: text('status'),
  title: text('title'),
  detail: text('detail'),
  transport: text('transport'),
  attempt: integer('attempt'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  durationMs: integer('duration_ms'),
  payload: text('payload_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  ...baseTimestamps(),
}, (table) => ({
  owner: uniqueIndex('uq_run_activity_owner').on(table.runId, table.activityId),
  timeline: index('idx_run_activity_timeline').on(table.workspaceId, table.runId, table.createdAt),
}));

// Durable, operator-private agent consultations. Unlike room messages these
// records are never projected into a customer transcript; they correlate the
// internal question/answer thread back to the chat turn, workflow run, or
// persistent agent session that requested the expertise.
export const agentConsultations = sqliteTable(
  'agent_consultations',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    callerAgentId: text('caller_agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    targetAgentId: text('target_agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    targetRole: text('target_role'),
    parentConsultationId: text('parent_consultation_id'),
    conversationId: text('conversation_id').references((): AnySQLiteColumn => conversations.id, { onDelete: 'set null' }),
    turnId: text('turn_id'),
    runId: text('run_id').references((): AnySQLiteColumn => workflowRuns.id, { onDelete: 'set null' }),
    parentSessionId: text('parent_session_id'),
    source: text('source').notNull().default('chat'),
    status: text('status').notNull().default('active'),
    roundCount: integer('round_count').notNull().default(0),
    maxRounds: integer('max_rounds').notNull().default(3),
    depth: integer('depth').notNull().default(1),
    substituted: integer('substituted', { mode: 'boolean' }).notNull().default(false),
    requestedTargetAgentId: text('requested_target_agent_id'),
    /** Private restart payload for channel-originated parent turns. Never returned by interaction APIs. */
    continuationPayload: text('continuation_payload', { mode: 'json' }).$type<Record<string, unknown> | null>(),
    error: text('error'),
    createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
    updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
    completedAt: text('completed_at'),
  },
  (table) => ({
    byWorkspaceTime: index('idx_agent_consultations_workspace').on(table.workspaceId, table.createdAt),
    byConversation: index('idx_agent_consultations_conversation').on(table.workspaceId, table.conversationId, table.createdAt),
    byRun: index('idx_agent_consultations_run').on(table.workspaceId, table.runId, table.createdAt),
    byCaller: index('idx_agent_consultations_caller').on(table.workspaceId, table.callerAgentId, table.createdAt),
    byTarget: index('idx_agent_consultations_target').on(table.workspaceId, table.targetAgentId, table.createdAt),
  }),
);

export const agentConsultationMessages = sqliteTable(
  'agent_consultation_messages',
  {
    id: text('id').primaryKey(),
    consultationId: text('consultation_id').notNull().references(() => agentConsultations.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    sequenceNumber: integer('sequence_number').notNull(),
    authorAgentId: text('author_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    body: text('body').notNull(),
    metadata: text('metadata', { mode: 'json' }).notNull().default(sql`'{}'`),
    createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  },
  (table) => ({
    sequence: uniqueIndex('uq_agent_consultation_messages_sequence').on(table.consultationId, table.sequenceNumber),
    byConsultation: index('idx_agent_consultation_messages_consultation').on(table.consultationId, table.createdAt),
  }),
);

/** Durable, request-independent operator turns (Chat V2). */
export const conversationTurns = sqliteTable(
  'conversation_turns',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    messageId: text('message_id').references(() => conversationMessages.id, { onDelete: 'set null' }),
    planId: text('plan_id'),
    clientTurnId: text('client_turn_id').notNull(),
    prompt: text('prompt').notNull(),
    requestedMode: text('requested_mode').notNull().default('auto'),
    effectiveMode: text('effective_mode').notNull().default('deep'),
    permissionMode: text('permission_mode').notNull().default('ask'),
    status: text('status').notNull().default('queued'),
    attachments: text('attachments', { mode: 'json' }).notNull().default(sql`'[]'`),
    viewport: text('viewport', { mode: 'json' }),
    executionEnvelope: text('execution_envelope', { mode: 'json' }),
    contextManifest: text('context_manifest', { mode: 'json' }),
    lastEventSeq: integer('last_event_seq').notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: text('lease_expires_at'),
    error: text('error'),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    ...baseTimestamps(),
  },
  (table) => ({
    conversationStatus: index('idx_conversation_turns_conversation_status').on(table.workspaceId, table.conversationId, table.status, table.createdAt),
    agentStatus: index('idx_conversation_turns_agent_status').on(table.workspaceId, table.agentId, table.status, table.createdAt),
    clientTurn: uniqueIndex('uq_conversation_turns_client').on(table.workspaceId, table.conversationId, table.clientTurnId),
  }),
);

/** Ordered replay log. SSE/WebSocket clients are subscribers, never turn owners. */
export const conversationTurnEvents = sqliteTable(
  'conversation_turn_events',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    turnId: text('turn_id').notNull().references(() => conversationTurns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    event: text('event').notNull(),
    data: text('data', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  },
  (table) => ({
    turnSequence: uniqueIndex('uq_conversation_turn_events_sequence').on(table.turnId, table.seq),
    workspaceTurn: index('idx_conversation_turn_events_turn').on(table.workspaceId, table.turnId, table.seq),
  }),
);

/** Content-addressed, compressed row snapshots used by chat-turn Undo/Redo. */
export const conversationTurnChangePayloads = sqliteTable(
  'conversation_turn_change_payloads',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    hash: text('hash').notNull(),
    encoding: text('encoding').notNull().default('gzip-json'),
    payload: text('payload').notNull(),
    byteLength: integer('byte_length').notNull(),
    createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  },
  (table) => ({
    workspaceHash: uniqueIndex('uq_conversation_turn_change_payloads_hash').on(table.workspaceId, table.hash),
  }),
);

/** One durable, reversible local change set per operator chat turn. */
export const conversationTurnChangeSets = sqliteTable(
  'conversation_turn_change_sets',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
    turnId: text('turn_id').notNull().references(() => conversationTurns.id, { onDelete: 'cascade' }),
    state: text('state').notNull().default('recording'),
    version: integer('version').notNull().default(1),
    reversibleCount: integer('reversible_count').notNull().default(0),
    sensitiveCount: integer('sensitive_count').notNull().default(0),
    externalEffectCount: integer('external_effect_count').notNull().default(0),
    affectedResources: text('affected_resources', { mode: 'json' }).notNull().default(sql`'[]'`),
    lastError: text('last_error'),
    ...baseTimestamps(),
  },
  (table) => ({
    turn: uniqueIndex('uq_conversation_turn_change_sets_turn').on(table.turnId),
    conversation: index('idx_conversation_turn_change_sets_conversation').on(table.workspaceId, table.conversationId, table.updatedAt),
  }),
);

/** Ordered row-level mutations captured around successful or partially-successful tool calls. */
export const conversationTurnChanges = sqliteTable(
  'conversation_turn_changes',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    changeSetId: text('change_set_id').notNull().references(() => conversationTurnChangeSets.id, { onDelete: 'cascade' }),
    turnId: text('turn_id').notNull().references(() => conversationTurns.id, { onDelete: 'cascade' }),
    toolCallId: text('tool_call_id').notNull(),
    toolId: text('tool_id').notNull(),
    commitOrdinal: integer('commit_ordinal').notNull(),
    resourceKind: text('resource_kind').notNull(),
    resourceId: text('resource_id').notNull(),
    resourceLabel: text('resource_label').notNull(),
    operation: text('operation').notNull(),
    rowKey: text('row_key', { mode: 'json' }),
    beforePayloadId: text('before_payload_id').references(() => conversationTurnChangePayloads.id, { onDelete: 'set null' }),
    afterPayloadId: text('after_payload_id').references(() => conversationTurnChangePayloads.id, { onDelete: 'set null' }),
    sensitive: integer('sensitive', { mode: 'boolean' }).notNull().default(false),
    reversible: integer('reversible', { mode: 'boolean' }).notNull().default(true),
    externalEffect: integer('external_effect', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  },
  (table) => ({
    ordered: uniqueIndex('uq_conversation_turn_changes_order').on(table.changeSetId, table.commitOrdinal),
    byTurn: index('idx_conversation_turn_changes_turn').on(table.workspaceId, table.turnId, table.commitOrdinal),
  }),
);

/** Temporary parallel workers created by one durable chat turn. They are audit
 * records, not entries in the workspace agent roster. */
export const conversationSwarms = sqliteTable(
  'conversation_swarms',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
    turnId: text('turn_id').notNull().references(() => conversationTurns.id, { onDelete: 'cascade' }),
    coordinatorAgentId: text('coordinator_agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    objective: text('objective').notNull(),
    mergeStrategy: text('merge_strategy').notNull().default('collect_all'),
    maxWorkers: integer('max_workers').notNull().default(6),
    maxParallel: integer('max_parallel').notNull().default(3),
    status: text('status').notNull().default('queued'),
    steering: text('steering', { mode: 'json' }).notNull().default(sql`'[]'`),
    synthesis: text('synthesis'),
    error: text('error'),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    ...baseTimestamps(),
  },
  (table) => ({
    byTurn: index('idx_conversation_swarms_turn').on(table.workspaceId, table.turnId, table.createdAt),
    active: index('idx_conversation_swarms_active').on(table.workspaceId, table.conversationId, table.status, table.updatedAt),
  }),
);

export const conversationSwarmWorkers = sqliteTable(
  'conversation_swarm_workers',
  {
    id: text('id').primaryKey(),
    swarmId: text('swarm_id').notNull().references(() => conversationSwarms.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    parentWorkerId: text('parent_worker_id'),
    durableAgentId: text('durable_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    role: text('role').notNull().default('temporary specialist'),
    task: text('task').notNull(),
    capabilityTags: text('capability_tags', { mode: 'json' }).notNull().default(sql`'[]'`),
    runtime: text('runtime'),
    status: text('status').notNull().default('queued'),
    latestProgress: text('latest_progress'),
    result: text('result', { mode: 'json' }),
    error: text('error'),
    retryOfWorkerId: text('retry_of_worker_id'),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    ...baseTimestamps(),
  },
  (table) => ({
    swarmOrdinal: uniqueIndex('uq_conversation_swarm_workers_ordinal').on(table.swarmId, table.ordinal),
    active: index('idx_conversation_swarm_workers_active').on(table.workspaceId, table.swarmId, table.status, table.updatedAt),
  }),
);

export const plans = sqliteTable('plans', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ownerAgentId: text('owner_agent_id').references(() => agents.id, { onDelete: 'set null' }),
  conversationId: text('conversation_id')
    .references(() => conversations.id, { onDelete: 'cascade' }),
  messageId: text('message_id').references(() => conversationMessages.id, { onDelete: 'set null' }),
  runIds: text('run_ids', { mode: 'json' }).notNull().default(sql`'[]'`),
  sessionId: text('session_id'),
  title: text('title').notNull(),
  objective: text('objective').notNull(),
  status: text('status').notNull().default('draft'),
  activeVersion: integer('active_version').notNull().default(1),
  approvedVersion: integer('approved_version'),
  decisions: text('decisions', { mode: 'json' }).notNull().default(sql`'[]'`),
  deviations: text('deviations', { mode: 'json' }).notNull().default(sql`'[]'`),
  verification: text('verification', { mode: 'json' }),
  ...baseTimestamps(),
}, (table) => ({
  byConversation: index('idx_plans_conversation').on(table.workspaceId, table.conversationId, table.updatedAt),
  byOwner: index('idx_plans_owner_agent').on(table.workspaceId, table.ownerAgentId, table.updatedAt),
}));

export const planVersions = sqliteTable(
  'plan_versions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    content: text('content', { mode: 'json' }).notNull(),
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  },
  (table) => ({
    planVersion: uniqueIndex('plan_versions_plan_version').on(table.planId, table.version),
  }),
);

export const issues = sqliteTable('issues', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  assigneeAgentId: text('assignee_agent_id').references(() => agents.id, { onDelete: 'set null' }),
  linkedWorkflowId: text('linked_workflow_id').references(() => workflows.id, { onDelete: 'set null' }),
  activeRunId: text('active_run_id').references(() => workflowRuns.id, { onDelete: 'set null' }),
  identifier: text('identifier').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').notNull().default('backlog'),
  priority: text('priority').notNull().default('medium'),
  labels: text('labels', { mode: 'json' }).notNull().default(sql`'[]'`),
  /** ISO timestamp the assigned agent should auto-start this issue (the due sweep). */
  scheduledFor: text('scheduled_for'),
  /** Optional cron expression to reschedule scheduledFor after each due fire. */
  recurrenceCron: text('recurrence_cron'),
  ...baseTimestamps(),
});

export const workspaceCounters = sqliteTable('workspace_counters', {
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  counterName: text('counter_name').notNull(),
  counterValue: integer('counter_value').notNull().default(0),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
}, (table) => ({
  pk: primaryKey({ columns: [table.workspaceId, table.counterName] }),
}));

// ────────────────────────────────────────────────────────────
// extension registry
// ───────────────────────────────────────────────────────────

export const installedRegistryArtifacts = sqliteTable('installed_registry_artifacts', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  entryId: text('entry_id').notNull(),
  /** workflow | extension | agent_package | workflow_template */
  entryType: text('entry_type').notNull(),
  version: text('version').notNull(),
  sha256: text('sha256').notNull(),
  localResourceId: text('local_resource_id').notNull(),
  
  permissionsAcknowledgedAt: text('permissions_acknowledged_at').notNull(),
  installedAt: text('installed_at').notNull().default(isoNow() as unknown as string),
});

// ────────────────────────────────────────────────────────────
// Webhook deliveries (idempotency + replay defense)
// ────────────────────────────────────────────────────────────

export const webhookDeliveries = sqliteTable('webhook_deliveries', {
  id: text('id').primaryKey(),
  triggerId: text('trigger_id')
    .notNull()
    .references(() => triggers.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** Idempotency key derived from x-agentis-delivery or HMAC of body+ts. */
  deliveryId: text('delivery_id').notNull(),
  receivedAt: text('received_at').notNull().default(isoNow() as unknown as string),
  status: text('status').notNull(),
  responseRunId: text('response_run_id'),
});

// ────────────────────────────────────────────────────────────
// Channel bridge — Telegram/Discord/etc. (V1-SPEC §0.3 #24, §11)
// ────────────────────────────────────────────────────────────

export const channelConnections = sqliteTable('channel_connections', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Owning agent for inbound routing + conversational identity. NULL = a
   *  workspace-owned (global/agentless) connection: inbound routes to the
   *  orchestrator; deterministic sends use it; any agent may send on it. */
  agentId: text('agent_id')
    .references(() => agents.id, { onDelete: 'set null' }),
  /** When set, inbound turns on this channel run in the App's context (Living Apps Phase 0, migration v95). */
  appId: text('app_id').references((): AnySQLiteColumn => apps.id, { onDelete: 'set null' }),
  /** telegram | discord */
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  /** Bot token, AES-256-GCM encrypted via CredentialVault. Never returned. */
  tokenEncrypted: text('token_encrypted').notNull(),
  /** Inbound HMAC / Telegram secret_token shared secret. Never returned. */
  webhookSecret: text('webhook_secret'),
  /** Adapter-specific JSON (e.g. { defaultChatId } for outbound). */
  settings: text('settings', { mode: 'json' }).notNull().default(sql`'{}'`),
  /** active | paused | error */
  status: text('status').notNull().default('active'),
  lastEventAt: text('last_event_at'),
  lastError: text('last_error'),
  ...baseTimestamps(),
});

export const channelDeliveries = sqliteTable('channel_deliveries', {
  id: text('id').primaryKey(),
  connectionId: text('connection_id')
    .notNull()
    .references(() => channelConnections.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** Adapter-issued unique id (Telegram update_id, Discord message id, etc.). */
  externalId: text('external_id').notNull(),
  receivedAt: text('received_at').notNull().default(isoNow() as unknown as string),
  conversationMessageId: text('conversation_message_id'),
});

/**
 * Durable outbound delivery journal. Workflow sends reserve a stable run+node
 * key; interactive sends receive an internal attempt key. Every provider-bound
 * attempt is therefore available for asynchronous acknowledgement correlation.
 * A crash reuses accepted proof or blocks an uncertain in-flight attempt instead
 * of sending twice. Migration v111.
 */
export const channelOutboundDeliveries = sqliteTable(
  'channel_outbound_deliveries',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id').notNull().references(() => channelConnections.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    chatId: text('chat_id').notNull(),
    /** SHA-256 only; message content is never duplicated into the journal. */
    bodyHash: text('body_hash').notNull(),
    /** sending | queued | accepted | delivered | read | failed | uncertain */
    status: text('status').notNull().default('sending'),
    providerMessageId: text('provider_message_id'),
    receipt: text('receipt_json', { mode: 'json' }),
    error: text('error'),
    ...baseTimestamps(),
  },
  (table) => ({
    uniqueWorkspaceKey: uniqueIndex('idx_channel_outbound_workspace_key').on(table.workspaceId, table.idempotencyKey),
    byConnectionStatus: index('idx_channel_outbound_connection_status').on(table.connectionId, table.status),
  }),
);

/**
 * Durable channel-turn queue (Living Apps Phase 5 / G2, migration v100).
 *
 * The inbound dispatcher was fire-and-forget, in-process: a 24/7 desk dropped
 * turns on restart with no backpressure or resumption. This table makes a
 * channel turn a durable, at-least-once job. The `ChannelTurnInput` payload is
 * stored verbatim; a polling worker claims `pending` rows, runs the turn, and
 * marks them `done`. A crash mid-flight (lease expiry) re-picks the row;
 * `dedup_key` (the inbound conversation-message id) makes enqueue idempotent so
 * a redelivered webhook never doubles a turn. Mirrored in migrations.ts (v100)
 * — new table, so inline FKs are fine (conversations/workspaces exist by v100).
 */
export const channelTurnQueue = sqliteTable('channel_turn_queue', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** Concurrency + ordering bucket: turns for one conversation run serially, in arrival order. */
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  /** App bucket (when the channel belongs to an App) for per-App concurrency fairness. NULL = bare agent. */
  appId: text('app_id'),
  /** Idempotency key — the inbound conversation-message id. Unique so a redelivered turn never re-runs. */
  dedupKey: text('dedup_key'),
  /** The full ChannelTurnInput, stored verbatim so the worker can resume after a crash. */
  payload: text('payload', { mode: 'json' }).notNull().default(sql`'{}'`),
  /** pending | processing | done | failed. */
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  /** Set while a worker holds the row; cleared on terminal/retry. Expiry → reclaim (crash resume). */
  leasedAt: text('leased_at'),
  lastAttemptAt: text('last_attempt_at'),
  /** Backoff clock — the row is invisible to the poller until now passes scheduledFor. */
  scheduledFor: text('scheduled_for').notNull().default(isoNow() as unknown as string),
  failReason: text('fail_reason'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
});

/**
 * Cross-surface peer identity (OMNICHANNEL §5.2). One row per
 * (workspace, connection, channelKind, handle). `userId` + `peerKey` are opt-in: linking a
 * handle to a workspace user assigns a stable `peerKey` so the same human is
 * recognized across WhatsApp / Telegram / Slack.
 */
export const channelPeerIdentities = sqliteTable('channel_peer_identities', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  channelKind: text('channel_kind').notNull(),
  /** Identity is connection-scoped: the same handle on two accounts is not automatically the same principal. */
  connectionId: text('connection_id').references(() => channelConnections.id, { onDelete: 'cascade' }),
  /** Channel-side stable address for the sender (DM chat id / Slack user id). */
  handle: text('handle').notNull(),
  displayName: text('display_name'),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  /** Stable cross-channel identity key once linked (e.g. `user:<id>`). */
  peerKey: text('peer_key'),
  /** Durable Subject grounding this principal's long-term relationship state. */
  groundingEntityId: text('grounding_entity_id').references((): AnySQLiteColumn => durableEntities.id, { onDelete: 'set null' }),
  /** external | owner | delegate. Never inferred from defaultChatId. */
  authorityRole: text('authority_role').notNull().default('external'),
  authorityMethod: text('authority_method'),
  verifiedAt: text('verified_at'),
  grantExpiresAt: text('grant_expires_at'),
  /** Operator-blocked sender: inbound turns from this handle are silently ignored. */
  blocked: integer('blocked', { mode: 'boolean' }).notNull().default(false),
  messageCount: integer('message_count').notNull().default(0),
  firstSeenAt: text('first_seen_at').notNull().default(isoNow() as unknown as string),
  lastSeenAt: text('last_seen_at').notNull().default(isoNow() as unknown as string),
}, (table) => ({
  uniquePrincipal: uniqueIndex('uq_channel_peer_principal').on(table.workspaceId, table.connectionId, table.channelKind, table.handle),
  byPeer: index('idx_channel_peer_key').on(table.workspaceId, table.peerKey),
  byAuthority: index('idx_channel_peer_authority').on(table.workspaceId, table.connectionId, table.authorityRole),
}));

/** Provider-specific addresses that resolve to one canonical channel peer. */
export const channelPeerAliases = sqliteTable('channel_peer_aliases', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  connectionId: text('connection_id').notNull().references(() => channelConnections.id, { onDelete: 'cascade' }),
  channelKind: text('channel_kind').notNull(),
  peerIdentityId: text('peer_identity_id').notNull().references(() => channelPeerIdentities.id, { onDelete: 'cascade' }),
  alias: text('alias').notNull(),
  /** primary | pn | lid | phone | username | provider */
  aliasKind: text('alias_kind').notNull().default('provider'),
  source: text('source').notNull().default('observed'),
  verified: integer('verified', { mode: 'boolean' }).notNull().default(false),
  displayName: text('display_name'),
  lastSeenAt: text('last_seen_at').notNull().default(isoNow() as unknown as string),
  ...baseTimestamps(),
}, (table) => ({
  uniqueAlias: uniqueIndex('uq_channel_peer_alias').on(table.workspaceId, table.connectionId, table.channelKind, table.alias),
  byPeer: index('idx_channel_peer_alias_peer').on(table.workspaceId, table.peerIdentityId),
}));

/** Durable, resumable outbound action. It is the at-most-once delivery ledger. */
export const channelActionIntents = sqliteTable('channel_action_intents', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  appId: text('app_id').references((): AnySQLiteColumn => apps.id, { onDelete: 'set null' }),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  requesterIdentityId: text('requester_identity_id').references(() => channelPeerIdentities.id, { onDelete: 'set null' }),
  connectionId: text('connection_id').notNull().references(() => channelConnections.id, { onDelete: 'cascade' }),
  peerIdentityId: text('peer_identity_id').notNull().references(() => channelPeerIdentities.id, { onDelete: 'cascade' }),
  conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  subjectId: text('subject_id').references((): AnySQLiteColumn => durableEntities.id, { onDelete: 'set null' }),
  goalRef: text('goal_ref'),
  goal: text('goal').notNull(),
  body: text('body').notNull().default(''),
  messagesJson: text('messages_json', { mode: 'json' }).notNull().default(sql`'[]'`),
  authorizationBasis: text('authorization_basis').notNull(),
  riskCategory: text('risk_category').notNull().default('ordinary'),
  /** planned | awaiting_approval | authorized | executing | delivered | failed | cancelled | superseded */
  status: text('status').notNull().default('planned'),
  approvalId: text('approval_id').references(() => approvalRequests.id, { onDelete: 'set null' }),
  idempotencyKey: text('idempotency_key').notNull(),
  attempts: integer('attempts').notNull().default(0),
  scheduledFor: text('scheduled_for'),
  providerReceiptJson: text('provider_receipt_json', { mode: 'json' }),
  lastError: text('last_error'),
  authorizedAt: text('authorized_at'),
  executedAt: text('executed_at'),
  deliveredAt: text('delivered_at'),
  cancelledAt: text('cancelled_at'),
  ...baseTimestamps(),
}, (table) => ({
  uniqueDelivery: uniqueIndex('uq_channel_action_idempotency').on(table.workspaceId, table.idempotencyKey),
  due: index('idx_channel_action_due').on(table.status, table.scheduledFor),
  peerTimeline: index('idx_channel_action_peer').on(table.workspaceId, table.peerIdentityId, table.createdAt),
  requesterPending: index('idx_channel_action_requester').on(table.workspaceId, table.requesterIdentityId, table.status, table.createdAt),
}));

/** Restart-durable utterance assembly. Provider bubbles become one semantic turn before cognition. */
export const channelUtteranceBatches = sqliteTable('channel_utterance_batches', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  connectionId: text('connection_id').notNull().references(() => channelConnections.id, { onDelete: 'cascade' }),
  chatId: text('chat_id').notNull(),
  status: text('status').notNull().default('collecting'),
  payloadJson: text('payload_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  messageIdsJson: text('message_ids_json', { mode: 'json' }).notNull().default(sql`'[]'`),
  attachmentIdsJson: text('attachment_ids_json', { mode: 'json' }).notNull().default(sql`'[]'`),
  softDeadlineAt: text('soft_deadline_at').notNull(),
  hardDeadlineAt: text('hard_deadline_at').notNull(),
  settledAt: text('settled_at'),
  ...baseTimestamps(),
}, (table) => ({
  openPerChat: index('idx_channel_utterance_open').on(table.workspaceId, table.connectionId, table.chatId, table.status),
  due: index('idx_channel_utterance_due').on(table.status, table.softDeadlineAt),
}));

/**
 * Per-workspace orchestrator model-role overrides (OMNICHANNEL §4.4). One row
 * per (workspace, role). `apiKeyEncrypted` is vault ciphertext. Absent rows fall
 * back to the env-configured default model for that role.
 */
export const workspaceModelConfig = sqliteTable('workspace_model_config', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  baseUrl: text('base_url'),
  model: text('model').notNull(),
  apiKeyEncrypted: text('api_key_encrypted'),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
});

/**
 * Per-workspace media (image/audio/video) generation model override — the
 * SAME "bring your own model" shape as `workspaceModelConfig`, but for the
 * media-generation seam instead of chat cognition roles (INTEGRATION-CEILING-10X
 * §1: media generation was hardcoded to OpenAI while chat was already free-text
 * provider-agnostic; this closes that gap the same way, not a new pattern).
 */
/**
 * User-configured "bring your own OAuth app" providers (INTEGRATION-CEILING-10X
 * §2). The built-in provider list (google/slack/github/…) is a hardcoded enum;
 * this table lets a workspace register a FULLY CUSTOM OAuth2 app — any authUrl/
 * tokenUrl/scopes/clientId/clientSecret — for a service Agentis-core has never
 * heard of, using the same generic authorize→callback mechanics (oauthFlow.ts).
 * Workspace-scoped (unlike the instance-wide built-in BYOC credentials) since a
 * custom integration is naturally per-workspace, not a shared deployment app.
 */
export const oauthCustomProviders = sqliteTable('oauth_custom_providers', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  providerId: text('provider_id').notNull(),
  label: text('label').notNull(),
  authUrl: text('auth_url').notNull(),
  tokenUrl: text('token_url').notNull(),
  /** JSON array of scope strings. */
  scopes: text('scopes').notNull().default('[]'),
  scopeSeparator: text('scope_separator').notNull().default(' '),
  pkce: integer('pkce', { mode: 'boolean' }).notNull().default(false),
  tokenAuth: text('token_auth').notNull().default('body'),
  tokenBodyFormat: text('token_body_format').notNull().default('form'),
  clientId: text('client_id').notNull(),
  clientSecretEncrypted: text('client_secret_encrypted').notNull(),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
}, (table) => ({
  providerUnique: uniqueIndex('idx_oauth_custom_providers_id').on(table.workspaceId, table.providerId),
}));

export const workspaceMediaConfig = sqliteTable('workspace_media_config', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  modality: text('modality').notNull(),
  baseUrl: text('base_url'),
  model: text('model').notNull(),
  apiKeyEncrypted: text('api_key_encrypted'),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
});

/**
 * Vault-encrypted persistent-channel auth state (OMNICHANNEL §3.4/§7). WhatsApp
 * (baileys) creds + signal keys live here, encrypted, instead of plaintext files
 * on disk. Key-value per (connectionId, key).
 */
export const channelAuthState = sqliteTable('channel_auth_state', {
  connectionId: text('connection_id')
    .notNull()
    .references(() => channelConnections.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  valueEncrypted: text('value_encrypted').notNull(),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
}, (table) => ({
  pk: primaryKey({ columns: [table.connectionId, table.key] }),
}));

// Package library (PackagerService)
// ────────────────────────────────────────────────────────────

/**
 * Canonical package library row.
 * Written by PackagerService.create / packFrom* / importManifest.
 * Read by PackagerService.list/get/usePackage.
 */
export const libraryPackages = sqliteTable('library_packages', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  version: text('version').notNull().default('1.0.0'),
  /** agent | workflow | extension | agentis | integration. */
  kind: text('kind').notNull(),
  description: text('description'),
  tags: text('tags', { mode: 'json' }).notNull().default(sql`'[]'`),
  /** Typed PackageContents JSON. */
  contents: text('contents', { mode: 'json' }).notNull(),
  /** ID of the resource this package was packed from (null for imports). */
  sourceId: text('source_id'),
  /** Kind of the source resource. */
  sourceKind: text('source_kind'),
  /** SHA-256 hex of stable-JSON contents. */
  checksum: text('checksum'),
  /** Remote registry ID (null for local packages). */
  remoteId: text('remote_id'),
  ...baseTimestamps(),
});

/**
 * Durable async job queue (AGENTIS-PLATFORM-10X §A4). A background poller
 * picks up `pending` rows; jobs survive server restarts.
 */
export const asyncJobs = sqliteTable('async_jobs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** workflow.run | (future kinds). */
  type: text('type').notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
  /** pending | running | completed | failed. */
  status: text('status').notNull().default('pending'),
  /** low | normal | high — pollers drain high first. */
  priority: text('priority').notNull().default('normal'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  /** Earliest time the job may run — supports retry backoff. */
  scheduledFor: text('scheduled_for').notNull().default(isoNow() as unknown as string),
  lastError: text('last_error'),
  /** Worker lease — set when claimed, cleared on completion. Detects stuck jobs. */
  leasedAt: text('leased_at'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
});

// ────────────────────────────────────────────────────────────
// Knowledge bases, documents, chunks
// ────────────────────────────────────────────────────────────

export const knowledgeBases = sqliteTable('knowledge_bases', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /**
   * Null = workspace knowledge; set = knowledge owned by one scope's Brain.
   * Polymorphic: a Workflow id OR an Agentic App id (App Brain → Knowledge). No
   * FK — ownership is validated in the route against both tables (migration v92).
   */
  scopeId: text('scope_id'),
  name: text('name').notNull(),
  description: text('description'),
  embeddingModel: text('embedding_model').notNull().default('lexical-v1'),
  embeddingDimension: integer('embedding_dimension').notNull().default(0),
  chunkingConfig: text('chunking_config', { mode: 'json' }).notNull().default(sql`'{}'`),
  ...baseTimestamps(),
});

export const kbDocuments = sqliteTable('kb_documents', {
  id: text('id').primaryKey(),
  knowledgeBaseId: text('knowledge_base_id')
    .notNull()
    .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  mimeType: text('mime_type').notNull().default('text/plain'),
  /** pending | ready | error | archived. */
  status: text('status').notNull().default('pending'),
  tokenCount: integer('token_count').notNull().default(0),
  error: text('error'),
  archivedAt: text('archived_at'),
  ...baseTimestamps(),
});

export const kbChunks = sqliteTable('kb_chunks', {
  id: text('id').primaryKey(),
  documentId: text('document_id')
    .notNull()
    .references(() => kbDocuments.id, { onDelete: 'cascade' }),
  knowledgeBaseId: text('knowledge_base_id')
    .notNull()
    .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  chunkIndex: integer('chunk_index').notNull().default(0),
  content: text('content').notNull(),
  metadata: text('metadata', { mode: 'json' }).notNull().default(sql`'{}'`),
  /** Workspace-provider embedding for native KB hybrid retrieval. */
  embedding: text('embedding', { mode: 'json' }),
  tokenCount: integer('token_count').notNull().default(0),
  accessCount: integer('access_count').notNull().default(0),
  lastAccessedAt: text('last_accessed_at'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

/**
 * Agent-scoped memory — the personal Brain of a single agent. Distinct from the
 * shared workspace_memory atoms and workflow_kv_entries (scoped to one workflow):
 * these entries belong to one agent and follow it across every
 * workflow and chat it ever participates in, so its expertise compounds over time.
 */
// lives in `memory_episodes` (scope_id = agentId) so there is a single brain
// store — see AgentMemoryService. The table is dropped; no schema export.

// ────────────────────────────────────────────────────────────
// Fleet / Organization layer — migration v12
// docs/memory/MEMORY-ARCHITECTURE.md
// ────────────────────────────────────────────────────────────

/** Workspace teams — each team owns a dedicated Ambient. */
// ────────────────────────────────────────────────────────────
// Brain — knowledge graph + memory subsystem (workspace-scoped)
// scope_id columns are nullable; workspace-scoped rows leave them null.
// ────────────────────────────────────────────────────────────

export const knowledgeChunks = sqliteTable('knowledge_chunks', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** Optional intelligence scope identifier. */
  scopeId: text('scope_id'),
  title: text('title').notNull(),
  content: text('content').notNull(),
  /** Tokenised content, used by the V1 lexical retriever. JSON array of strings. */
  contentTokens: text('content_tokens', { mode: 'json' }).notNull().default(sql`'[]'`),
  /** seed | import | promotion. */
  source: text('source').notNull(),
  /** Provenance — package version, dataset key, ingestion job id, etc. */
  provenance: text('provenance', { mode: 'json' }).notNull().default(sql`'{}'`),
  tags: text('tags', { mode: 'json' }).notNull().default(sql`'[]'`),
  /** Reserved for vector retrieval. JSON array of floats — null on lexical-only path. */
  embedding: text('embedding', { mode: 'json' }),
  /** 0..1 stored as text for precision. */
  trust: text('trust').notNull().default('1'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
}, (table) => ({
  // The recall hot path filters by (workspace_id, scope_id) and orders by
  // updated_at DESC (see KnowledgeStore candidate scan). Without this index that
  // query is a full table scan + transient sort on every recall, which grows
  // linearly with corpus size. Mirrored by migration v78.
  scopeRecency: index('idx_knowledge_chunks_scope_recency')
    .on(table.workspaceId, table.scopeId, table.updatedAt),
}));

export const datasetImports = sqliteTable('dataset_imports', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  scopeId: text('scope_id'),
  datasetKey: text('dataset_key').notNull(),
  /** pending | parsing | chunking | indexing | completed | failed | cancelled. */
  status: text('status').notNull(),
  sourceMeta: text('source_meta', { mode: 'json' }).notNull().default(sql`'{}'`),
  totalItems: integer('total_items').notNull().default(0),
  processedItems: integer('processed_items').notNull().default(0),
  storedItems: integer('stored_items').notNull().default(0),
  errors: text('errors', { mode: 'json' }).notNull().default(sql`'[]'`),
  /** Filled in once status === 'completed'. */
  impact: text('impact', { mode: 'json' }),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

export const workflowBaselines = sqliteTable('workflow_baselines', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  scopeId: text('scope_id'),
  workflowId: text('workflow_id').notNull(),
  /** seed | derived. */
  source: text('source').notNull(),
  p50DurationMs: integer('p50_duration_ms'),
  p95DurationMs: integer('p95_duration_ms'),
  /** 0..1 stored as text. */
  successRate: text('success_rate'),
  costCentsPerRun: integer('cost_cents_per_run'),
  sampleSize: integer('sample_size').notNull().default(0),
  windowStart: text('window_start').notNull(),
  windowEnd: text('window_end').notNull(),
  capturedAt: text('captured_at').notNull().default(isoNow() as unknown as string),
});

export const datasetImportItems = sqliteTable('dataset_import_items', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** Parent ingestion job. */
  importJobId: text('import_job_id')
    .notNull()
    .references(() => datasetImports.id, { onDelete: 'cascade' }),
  /** 0-indexed position in the parsed payload. */
  itemIndex: integer('item_index').notNull(),
  /** pending | completed | failed | skipped. */
  status: text('status').notNull().default('pending'),
  /** SHA-256 hex of the item's content — dedup key for resume. */
  contentHash: text('content_hash').notNull(),
  /** ID of the record written to the target store (first chunk's id). */
  storedId: text('stored_id'),
  /** Error message if status === 'failed'. */
  error: text('error'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
});

export const memoryEpisodes = sqliteTable('memory_episodes', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** Optional intelligence scope. NULL = workspace-global. */
  scopeId: text('scope_id'),
  workflowId: text('workflow_id'),
  runId: text('run_id'),
  agentId: text('agent_id'),
  /** decision | failure | recovery | success_pattern | approval | evaluator_outcome | incident | artifact_outcome | distilled_lesson. */
  type: text('type').notNull(),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  details: text('details'),
  
  source: text('source').notNull(),
  /** 0..1 stored as text for precision (matches the wedge's convention). */
  confidence: text('confidence').notNull().default('0.5'),
  importance: text('importance').notNull().default('0.5'),
  trust: text('trust').notNull().default('0.5'),
  tags: text('tags', { mode: 'json' }).notNull().default(sql`'[]'`),
  entities: text('entities', { mode: 'json' }).notNull().default(sql`'[]'`),
  /** good | bad | mixed | NULL. */
  outcomeStatus: text('outcome_status'),
  /** Vector retrieval — JSON array of floats (B4: real embeddings). */
  embedding: text('embedding', { mode: 'json' }),
  /** Brain 10x §B1.2 — embedding provenance: which model + dimension produced the vector. */
  embeddingModel: text('embedding_model'),
  embeddingDims: integer('embedding_dims'),
  /** True when the stored vector no longer matches the workspace provider; sweep re-embeds. */
  needsReembed: integer('needs_reembed', { mode: 'boolean' }).notNull().default(false),
  
  governing: integer('governing', { mode: 'boolean' }).notNull().default(false),
  /** Brain 10x §B7.3 — scope-affinity links (agent/workflow ids this atom applies to). */
  appliesTo: text('applies_to', { mode: 'json' }).notNull().default(sql`'[]'`),
  
  shared: integer('shared', { mode: 'boolean' }).notNull().default(true),
  metadata: text('metadata', { mode: 'json' }).notNull().default(sql`'{}'`),
  /** When the episode was last reinforced (re-promoted or re-confirmed). */
  reinforcedAt: text('reinforced_at'),
  /** When the episode was archived. NULL = active. */
  archivedAt: text('archived_at'),
  /** ID of an episode that supersedes this one (NULL = current). */
  supersededBy: text('superseded_by'),
  /** B5 — explicit lifecycle state: active | stale | archived. */
  status: text('status').notNull().default('active'),
  
  managed: integer('managed', { mode: 'boolean' }).notNull().default(true),
  /** Pinned atoms are exempt from all automated lifecycle transitions. */
  pinnedAt: text('pinned_at'),
  /** Bumped whenever the atom is retrieved into a dispatch context block. */
  lastAccessedAt: text('last_accessed_at'),
  /** Gap15 — set when a contradicting atom is detected on the same topic. */
  isDisputed: integer('is_disputed', { mode: 'boolean' }).notNull().default(false),
  disputeReason: text('dispute_reason'),
  disputeResolvedAt: text('dispute_resolved_at'),
  disputeSnoozedUntil: text('dispute_snoozed_until'),
  contextCondition: text('context_condition'),
  compressedFrom: text('compressed_from', { mode: 'json' }),
  compressionTier: integer('compression_tier'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
});

export const knowledgeLinks = sqliteTable('knowledge_links', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  sourceId: text('source_id').notNull(),
  /** kb_chunk | knowledge_chunk | episode | memory | pattern. */
  sourceKind: text('source_kind').notNull(),
  targetId: text('target_id').notNull(),
  /** kb_chunk | knowledge_chunk | episode | memory | pattern. */
  targetKind: text('target_kind').notNull(),
  /** supports | contradicts | refines | derived_from | co_observed. */
  relation: text('relation').notNull(),
  confidence: real('confidence').notNull().default(0.5),
  reinforceCount: integer('reinforce_count').notNull().default(1),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  adapterType: text('adapter_type'),
  runId: text('run_id'),
  scopeId: text('scope_id'),
  /** Context-split disputes no longer count as unresolved contradictions. */
  contextSplit: integer('context_split', { mode: 'boolean' }).notNull().default(false),
  resolvedAt: text('resolved_at'),
  /** Temporal validity: superseded links remain auditable but are no longer current. */
  validFrom: text('valid_from'),
  invalidAt: text('invalid_at'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
});

// Personal Brain: explicitly user-owned and visible to agents only via grants.
export const userNotes = sqliteTable('user_notes', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title'),
  content: text('content').notNull(),
  noteType: text('note_type').notNull().default('note'),
  embedding: text('embedding', { mode: 'json' }),
  /** Brain 10x §B1.2 — embedding provenance. */
  embeddingModel: text('embedding_model'),
  embeddingDims: integer('embedding_dims'),
  needsReembed: integer('needs_reembed', { mode: 'boolean' }).notNull().default(false),
  tags: text('tags', { mode: 'json' }).notNull().default(sql`'[]'`),
  source: text('source').notNull().default('user_typed'),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  ...baseTimestamps(),
});

export const userLinks = sqliteTable('user_links', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sourceId: text('source_id').notNull(),
  sourceKind: text('source_kind').notNull(),
  targetId: text('target_id').notNull(),
  targetKind: text('target_kind').notNull(),
  relation: text('relation').notNull(),
  confidence: real('confidence').notNull().default(0.6),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

export const personalBrainGrants = sqliteTable('personal_brain_grants', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  accessLevel: text('access_level').notNull().default('read'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

export const cognitivePromotionQueue = sqliteTable('cognitive_promotion_queue', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** atom_promotion | ability_review | peer_update | contradiction_check. */
  itemType: text('item_type').notNull(),
  /** high | normal | low — drained high-first. */
  priority: text('priority').notNull().default('normal'),
  /** JSON; schema depends on itemType. */
  payload: text('payload', { mode: 'json' }).notNull().default(sql`'{}'`),
  /** pending | processing | done | failed. */
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastAttemptAt: text('last_attempt_at'),
  failReason: text('fail_reason'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
});

export const peerProfiles = sqliteTable('peer_profiles', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** user | agent. */
  peerType: text('peer_type').notNull(),
  /** User id or agent id. */
  peerId: text('peer_id').notNull(),
  summary: text('summary').notNull().default(''),
  peerCard: text('peer_card', { mode: 'json' }).notNull().default(sql`'[]'`),
  lastDreamAt: text('last_dream_at'),
  embedding: text('embedding', { mode: 'json' }),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

export const peerProfileConclusions = sqliteTable('peer_profile_conclusions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  subjectPeerId: text('subject_peer_id').notNull(),
  observerPeerId: text('observer_peer_id').notNull(),
  content: text('content').notNull(),
  sourceSessionId: text('source_session_id'),
  confidence: real('confidence').notNull().default(0.7),
  conclusionType: text('conclusion_type').notNull().default('deductive'),
  volatilityClass: text('volatility_class').notNull().default('contextual'),
  supportingSessionCount: integer('supporting_session_count').notNull().default(1),
  supersededById: text('superseded_by_id'),
  status: text('status').notNull().default('active'),
  embedding: text('embedding', { mode: 'json' }),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
});

export const sessionMoments = sqliteTable('session_moments', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  scopeId: text('scope_id'),
  content: text('content').notNull(),
  confidence: real('confidence').notNull().default(0.6),
  embedding: text('embedding', { mode: 'json' }),
  /** Brain 10x §B1.2 — embedding provenance. */
  embeddingModel: text('embedding_model'),
  embeddingDims: integer('embedding_dims'),
  needsReembed: integer('needs_reembed', { mode: 'boolean' }).notNull().default(false),
  promotedAt: text('promoted_at'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  expiresAt: text('expires_at').notNull(),
});

export const brainQualityEvents = sqliteTable('brain_quality_events', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  scopeId: text('scope_id'),
  agentId: text('agent_id'),
  /** atom_injected | evaluator_pass | evaluator_fail | atom_confidence_delta | ability_used | ability_confidence_delta. */
  eventType: text('event_type').notNull(),
  atomId: text('atom_id'),
  abilityId: text('ability_id'),
  runId: text('run_id'),
  /** Confidence change, positive or negative. */
  delta: real('delta'),
  metadata: text('metadata', { mode: 'json' }).notNull().default(sql`'{}'`),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

export const brainForgetRequests = sqliteTable('brain_forget_requests', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  requestedByUserId: text('requested_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  topic: text('topic').notNull(),
  scope: text('scope').notNull().default('all'),
  status: text('status').notNull().default('pending'),
  matches: text('matches', { mode: 'json' }).notNull().default(sql`'{}'`),
  counts: text('counts', { mode: 'json' }).notNull().default(sql`'{}'`),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  executedAt: text('executed_at'),
});


// Brain - scoped memory atom stores (workspace-scoped; scope_id nullable).
//
// Brain 10x §B4 — the standalone `workspace_memory` table was COLLAPSED into the
// canonical `memory_episodes` substrate (migration v69). Typed workspace memory
// now lives there with a `plane:workspace_memory` tag; the `MemoryStore` facade
// preserves the kind/source contract. There is one physical memory store.

// Brain 10x §C2 — sleep-time precomputed working set (Tier-0 retrieval cache).
export const brainWorkingSet = sqliteTable('brain_working_set', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  scopeId: text('scope_id'),
  /** JSON array of { id, title, content, kind, score }. */
  atoms: text('atoms', { mode: 'json' }).notNull().default(sql`'[]'`),
  atomCount: integer('atom_count').notNull().default(0),
  builtAt: text('built_at').notNull().default(isoNow() as unknown as string),
});

export const evaluatorExamples = sqliteTable('evaluator_examples', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  scopeId: text('scope_id'),
  evaluatorKey: text('evaluator_key').notNull(),
  
  source: text('source').notNull(),
  input: text('input', { mode: 'json' }).notNull(),
  expected: text('expected', { mode: 'json' }).notNull(),
  /** pass | fail. */
  verdict: text('verdict').notNull(),
  score: text('score'),
  reason: text('reason'),
  
  originRunId: text('origin_run_id'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

export const memoryPromotionEvents = sqliteTable('memory_promotion_events', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  scopeId: text('scope_id'),
  runId: text('run_id'),
  candidateTitle: text('candidate_title').notNull(),
  candidatePayload: text('candidate_payload', { mode: 'json' }).notNull().default(sql`'{}'`),
  
  candidateSource: text('candidate_source').notNull(),
  /** promoted | rejected | merged | superseded. */
  decision: text('decision').notNull(),
  
  reason: text('reason').notNull(),
  /** Episode that was created or updated (NULL on rejection). */
  episodeId: text('episode_id'),
  /** 0..1 score at decision time. */
  score: text('score').notNull().default('0'),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

export const rollingBaselineSnapshots = sqliteTable('rolling_baseline_snapshots', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  scopeId: text('scope_id'),
  workflowId: text('workflow_id').notNull(),
  /** rolling_7d | rolling_30d | rolling_90d. */
  window: text('window').notNull(),
  /** 0..1 stored as text. */
  successRate: text('success_rate').notNull().default('0'),
  p50LatencyMs: integer('p50_latency_ms').notNull().default(0),
  p95LatencyMs: integer('p95_latency_ms').notNull().default(0),
  avgCostMicros: integer('avg_cost_micros').notNull().default(0),
  /** Stored as text (allows fractional averages: 1.5 replays/run). */
  avgReplayCount: text('avg_replay_count').notNull().default('0'),
  avgApprovalCount: text('avg_approval_count').notNull().default('0'),
  evaluatorPassRate: text('evaluator_pass_rate').notNull().default('0'),
  sampleSize: integer('sample_size').notNull().default(0),
  windowStart: text('window_start').notNull(),
  windowEnd: text('window_end').notNull(),
  capturedAt: text('captured_at').notNull().default(isoNow() as unknown as string),
});

export const promotedPatterns = sqliteTable('promoted_patterns', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  scopeId: text('scope_id'),
  /** successful_playbook | failure_with_fix | approved_output_pattern | business_rule | recurring_exception. */
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  /** Schema depends on kind. */
  payload: text('payload', { mode: 'json' }).notNull().default(sql`'{}'`),
  /** 0..1 stored as text. */
  confidence: text('confidence').notNull().default('0.5'),
  trust: text('trust').notNull().default('0.8'),
  evidenceCount: integer('evidence_count').notNull().default(1),
  provenance: text('provenance', { mode: 'json' }).notNull().default(sql`'{}'`),
  reinforcedAt: text('reinforced_at').notNull().default(isoNow() as unknown as string),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
});

/**
 * Phase 1 (SPECIALISTS-10X) — the durable expert definition for a functional
 * role: identity, runtime contract, generated card, status, version. One per
 * (workspace, role); materialized agents are its instances.
 */
export const specialistProfiles = sqliteTable(
  'specialist_profiles',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    name: text('name').notNull(),
    title: text('title'),
    description: text('description'),
    identityPrompt: text('identity_prompt'),
    responsibilityContract: text('responsibility_contract'),
    boundaries: text('boundaries'),
    /** draft | ready | degraded | archived */
    status: text('status').notNull().default('draft'),
    runtimeProfile: text('runtime_profile', { mode: 'json' }).notNull().default(sql`'{}'`),
    card: text('card', { mode: 'json' }),
    version: integer('version').notNull().default(1),
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
    updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
  },
  (table) => ({
    unique: uniqueIndex('idx_specialist_profile_role').on(table.workspaceId, table.role),
  }),
);

/** Phase 2 (SPECIALISTS-10X) — a specialist's curated, multimodal mind. */
export const specialistMinds = sqliteTable(
  'specialist_minds',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    summary: text('summary'),
    retrievalPolicy: text('retrieval_policy', { mode: 'json' }).notNull().default(sql`'{}'`),
    distilledContext: text('distilled_context'),
    embedding: text('embedding', { mode: 'json' }),
    qualityScore: real('quality_score').notNull().default(0.5),
    freshnessScore: real('freshness_score').notNull().default(1.0),
    provenanceScore: real('provenance_score').notNull().default(0.5),
    /** ingesting | extracting | embedding | ready */
    status: text('status').notNull().default('ready'),
    createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
    updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
  },
  (table) => ({ unique: uniqueIndex('idx_specialist_mind_role').on(table.workspaceId, table.role) }),
);

export const specialistMindSources = sqliteTable('specialist_mind_sources', {
  id: text('id').primaryKey(),
  mindId: text('mind_id').notNull().references(() => specialistMinds.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  /** text | url | file | image | audio | video | run | brain_atom | ability */
  kind: text('kind').notNull().default('text'),
  title: text('title'),
  uri: text('uri'),
  
  trust: text('trust').notNull().default('workspace'),
  license: text('license'),
  /** pending | extracting | ready | failed */
  status: text('status').notNull().default('ready'),
  rawExcerpt: text('raw_excerpt'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

export const specialistMindAtoms = sqliteTable('specialist_mind_atoms', {
  id: text('id').primaryKey(),
  mindId: text('mind_id').notNull().references(() => specialistMinds.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  sourceId: text('source_id').references(() => specialistMindSources.id, { onDelete: 'set null' }),
  /** fact | preference | rule | visual_pattern | anti_pattern | example | decision */
  atomType: text('atom_type').notNull().default('fact'),
  content: text('content').notNull(),
  embedding: text('embedding', { mode: 'json' }),
  confidence: real('confidence').notNull().default(0.7),
  tags: text('tags', { mode: 'json' }).notNull().default(sql`'[]'`),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

export const specialistMindMedia = sqliteTable('specialist_mind_media', {
  id: text('id').primaryKey(),
  mindId: text('mind_id').notNull().references(() => specialistMinds.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  sourceId: text('source_id').references(() => specialistMindSources.id, { onDelete: 'cascade' }),
  mimeType: text('mime_type'),
  storageRef: text('storage_ref'),
  caption: text('caption'),
  ocrText: text('ocr_text'),
  palette: text('palette', { mode: 'json' }).notNull().default(sql`'[]'`),
  layoutNotes: text('layout_notes'),
  tags: text('tags', { mode: 'json' }).notNull().default(sql`'[]'`),
  embedding: text('embedding', { mode: 'json' }),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

/** Built-in and reusable specialist blueprints. */
export const specialistTemplates = sqliteTable(
  'specialist_templates',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    category: text('category').notNull().default('platform'),
    defaultIdentity: text('default_identity', { mode: 'json' }).notNull().default(sql`'{}'`),
    recommendedAbilities: text('recommended_abilities', { mode: 'json' }).notNull().default(sql`'[]'`),
    requiredTools: text('required_tools', { mode: 'json' }).notNull().default(sql`'[]'`),
    defaultRuntimeProfile: text('default_runtime_profile', { mode: 'json' }).notNull().default(sql`'{}'`),
    starterMindSources: text('starter_mind_sources', { mode: 'json' }).notNull().default(sql`'[]'`),
    creationQuestions: text('creation_questions', { mode: 'json' }).notNull().default(sql`'[]'`),
    evalPack: text('eval_pack', { mode: 'json' }).notNull().default(sql`'[]'`),
    version: integer('version').notNull().default(1),
    ...baseTimestamps(),
  },
  (table) => ({ unique: uniqueIndex('idx_specialist_templates_slug').on(table.slug) }),
);

/** Materialized runnable agent instances backed by specialist profiles. */
export const specialistInstances = sqliteTable(
  'specialist_instances',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    specialistProfileId: text('specialist_profile_id').references(() => specialistProfiles.id, { onDelete: 'set null' }),
    /** durable | ephemeral | swarm_member | shadow_eval */
    mode: text('mode').notNull().default('durable'),
    parentAgentId: text('parent_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    reportsTo: text('reports_to').references(() => agents.id, { onDelete: 'set null' }),
    leaseExpiresAt: text('lease_expires_at'),
    lastUsedAt: text('last_used_at'),
    ...baseTimestamps(),
  },
  (table) => ({ uniqueAgent: uniqueIndex('idx_specialist_instances_agent').on(table.workspaceId, table.agentId) }),
);

/** Demand-router decisions with explainable scoring and chosen topology. */
export const specialistRoutingDecisions = sqliteTable('specialist_routing_decisions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  task: text('task').notNull(),
  modality: text('modality').notNull().default('text'),
  desiredTopology: text('desired_topology'),
  selectedRole: text('selected_role').notNull(),
  selectedAgentId: text('selected_agent_id'),
  topology: text('topology').notNull(),
  score: real('score').notNull().default(0),
  explanation: text('explanation').notNull(),
  contextSummary: text('context_summary', { mode: 'json' }).notNull().default(sql`'{}'`),
  constraints: text('constraints', { mode: 'json' }).notNull().default(sql`'{}'`),
  createdBy: text('created_by'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

/** Observable specialist execution record, separate from workflow_runs. */
export const specialistRuns = sqliteTable('specialist_runs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  routingDecisionId: text('routing_decision_id').references(() => specialistRoutingDecisions.id, { onDelete: 'set null' }),
  role: text('role').notNull(),
  agentId: text('agent_id'),
  topology: text('topology').notNull().default('direct'),
  status: text('status').notNull().default('planned'),
  task: text('task').notNull(),
  artifactPolicy: text('artifact_policy', { mode: 'json' }).notNull().default(sql`'{}'`),
  budgetPolicy: text('budget_policy', { mode: 'json' }).notNull().default(sql`'{}'`),
  trace: text('trace', { mode: 'json' }).notNull().default(sql`'[]'`),
  outputSummary: text('output_summary'),
  artifactId: text('artifact_id'),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  ...baseTimestamps(),
});

export const specialistEvalProfiles = sqliteTable(
  'specialist_eval_profiles',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    rubric: text('rubric').notNull().default('Quality, correctness, usefulness, safety.'),
    version: integer('version').notNull().default(1),
    ...baseTimestamps(),
  },
  (table) => ({ unique: uniqueIndex('idx_specialist_eval_profile_role').on(table.workspaceId, table.role) }),
);

export const specialistEvalCases = sqliteTable('specialist_eval_cases', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  evalProfileId: text('eval_profile_id').notNull().references(() => specialistEvalProfiles.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  name: text('name').notNull(),
  input: text('input').notNull(),
  expected: text('expected'),
  rubric: text('rubric'),
  tags: text('tags', { mode: 'json' }).notNull().default(sql`'[]'`),
  ...baseTimestamps(),
});

export const specialistEvalRuns = sqliteTable('specialist_eval_runs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  evalCaseId: text('eval_case_id').notNull().references(() => specialistEvalCases.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  status: text('status').notNull().default('completed'),
  score: real('score').notNull().default(0),
  output: text('output'),
  reasoning: text('reasoning'),
  promotedAtomId: text('promoted_atom_id'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

export const specialistQualityEvents = sqliteTable('specialist_quality_events', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  eventType: text('event_type').notNull(),
  severity: text('severity').notNull().default('info'),
  summary: text('summary').notNull(),
  metadata: text('metadata', { mode: 'json' }).notNull().default(sql`'{}'`),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

export const agentPeerCards = sqliteTable('agent_peer_cards', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** Observer agent id. */
  observerPeerId: text('observer_peer_id').notNull(),
  /** User id or agent id being modeled. */
  subjectPeerId: text('subject_peer_id').notNull(),
  subjectPeerType: text('subject_peer_type').notNull().default('user'),
  summary: text('summary').notNull().default(''),
  peerCard: text('peer_card', { mode: 'json' }).notNull().default(sql`'[]'`),
  embedding: text('embedding', { mode: 'json' }),
  lastDreamAt: text('last_dream_at'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
});

// ────────────────────────────────────────────────────────────
// Agent Sessions — persistent, DB-backed agent identity at work.
// SMARTER-AGENTS-10X §VI. A session is a row, not a process: it lives
// between LLM inference calls so an agent spends zero tokens while a tool
// runs. Memory blocks are working memory always present in the rebuilt
// context window; messages are the episodic log (evictable to archival).
// ────────────────────────────────────────────────────────────

export const agentSessions = sqliteTable('agent_sessions', {
  id: text('id').primaryKey(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** The workflow run this session belongs to (null for chat-based sessions). */
  runId: text('run_id'),
  /** The agent_task node that owns this session within the run. */
  nodeId: text('node_id'),
  /** idle | active | suspended | waiting | completed | failed */
  status: text('status').notNull().default('idle'),
  /** Memory blocks — working memory, always rebuilt into the context window. */
  personaBlock: text('persona_block').notNull().default(''),
  taskBlock: text('task_block').notNull().default(''),
  planBlock: text('plan_block').notNull().default(''),
  observationsBlock: text('observations_block').notNull().default(''),
  /** Suspension state — see SMARTER-AGENTS-10X "Five Yield Points". */
  suspendReason: text('suspend_reason'),
  suspendPayload: text('suspend_payload', { mode: 'json' }),
  suspendedAt: text('suspended_at'),
  /** "task_id:abc" | "event:RUN_COMPLETED" | "time:ISO" — indexed when waiting. */
  wakeCondition: text('wake_condition'),
  /** Parent session that delegated to this one (delegation lineage). */
  parentSessionId: text('parent_session_id'),
  /** Delegation depth from the root session — hard-capped to prevent cycles. */
  delegationDepth: integer('delegation_depth').notNull().default(0),
  totalSteps: integer('total_steps').notNull().default(0),
  totalTokensIn: integer('total_tokens_in').notNull().default(0),
  totalTokensOut: integer('total_tokens_out').notNull().default(0),
  lastCompactionAt: text('last_compaction_at'),
  /** Terminal output captured when the session completes (returned to the engine). */
  output: text('output', { mode: 'json' }),
  error: text('error'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
});

export const agentSessionMessages = sqliteTable('agent_session_messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => agentSessions.id, { onDelete: 'cascade' }),
  stepNumber: integer('step_number').notNull(),
  /** system | user | assistant | tool */
  role: text('role').notNull(),
  /** Serialized ChatMessage content (string or content-block array as JSON text). */
  content: text('content').notNull(),
  /** When role==='assistant' and the model requested tools — serialized ChatToolCall[]. */
  toolCalls: text('tool_calls', { mode: 'json' }),
  /** When role==='tool' — the tool_call id this result answers. */
  toolCallId: text('tool_call_id'),
  tokenCount: integer('token_count'),
  /** 1 while the message is in the live context window; 0 once evicted to archival. */
  inContextWindow: integer('in_context_window', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

// ────────────────────────────────────────────────────────────
// Grounding — continuous organizational reasoning engine (Workspace
// Brain "Sources" experience). Migration v63. Engineering-named
// tables; the user never sees "Grounding" in the UI.
// Conventions: learning briefs fold into source connections,
// entity aliases fold into entities, access policies are per-row
// JSON — leaner physical layout than the RFC's logical list.
// ────────────────────────────────────────────────────────────

export const groundingOwnerProfiles = sqliteTable('grounding_owner_profiles', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ownerUserId: text('owner_user_id'),
  name: text('name'),
  intent: text('intent'),
  /** personal_project | professional_practice | product | owner_run_company. */
  operatingShape: text('operating_shape').notNull().default('personal_project'),
  charter: text('charter'),
  /** pending | discovered | previewed | launched. */
  onboardingState: text('onboarding_state').notNull().default('pending'),
  defaultsJson: text('defaults_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  ...baseTimestamps(),
});

export const groundingSourceConnections = sqliteTable('grounding_source_connections', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** agentis_native | slack | google_drive | github | … (KnowledgeSource.sourceType). */
  sourceType: text('source_type').notNull(),
  displayName: text('display_name').notNull(),
  /** ready | connect | needs_attention | paused | revoked. */
  status: text('status').notNull().default('connect'),
  /** Credential vault row id — never raw secrets. */
  credentialId: text('credential_id'),
  includedScopesJson: text('included_scopes_json', { mode: 'json' }).notNull().default(sql`'[]'`),
  excludedScopesJson: text('excluded_scopes_json', { mode: 'json' }).notNull().default(sql`'[]'`),
  /** SourceLearningBrief (RFC §7.3) folded in. */
  learningBriefJson: text('learning_brief_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  /** InformationBoundary defaults (RFC §8.1). */
  informationDefaultsJson: text('information_defaults_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  retentionPolicy: text('retention_policy').notNull().default('standard'),
  /** core | adaptive | deep. */
  reasoningMode: text('reasoning_mode').notNull().default('adaptive'),
  scheduleJson: text('schedule_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  healthJson: text('health_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  lastSyncAt: text('last_sync_at'),
  ...baseTimestamps(),
});

export const groundingSyncRuns = sqliteTable('grounding_sync_runs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  connectionId: text('connection_id')
    .notNull()
    .references(() => groundingSourceConnections.id, { onDelete: 'cascade' }),
  /** backfill | incremental | reconcile | sample. */
  mode: text('mode').notNull().default('incremental'),
  /** queued | running | completed | failed | paused. */
  status: text('status').notNull().default('queued'),
  cursor: text('cursor'),
  checkpointJson: text('checkpoint_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  countsJson: text('counts_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  error: text('error'),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

export const groundingSourceObjects = sqliteTable('grounding_source_objects', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  connectionId: text('connection_id')
    .notNull()
    .references(() => groundingSourceConnections.id, { onDelete: 'cascade' }),
  sourceType: text('source_type').notNull(),
  externalId: text('external_id').notNull(),
  objectType: text('object_type').notNull(),
  title: text('title'),
  nativeUrl: text('native_url'),
  /** active | deleted | inaccessible | expired (RFC §8.1 lifecycle). */
  lifecycleState: text('lifecycle_state').notNull().default('active'),
  lifecycleAt: text('lifecycle_at'),
  currentVersionId: text('current_version_id'),
  ...baseTimestamps(),
}, (table) => ({ identity: uniqueIndex('grounding_source_objects_identity_uq').on(table.workspaceId, table.connectionId, table.externalId) }));

export const groundingEvidenceVersions = sqliteTable('grounding_evidence_versions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  sourceObjectId: text('source_object_id')
    .notNull()
    .references(() => groundingSourceObjects.id, { onDelete: 'cascade' }),
  predecessorVersionId: text('predecessor_version_id'),
  sourceVersionId: text('source_version_id'),
  contentHash: text('content_hash').notNull(),
  /** CanonicalSourceObject (RFC §8.1) — append-only; corrections are new versions. */
  normalizedJson: text('normalized_json', { mode: 'json' }).notNull(),
  /** pending | ready | partial | rejected | failed. */
  extractionStatus: text('extraction_status').notNull().default('pending'),
  securityLabelsJson: text('security_labels_json', { mode: 'json' }).notNull().default(sql`'[]'`),
  /** InformationBoundary — origin vs exposure (RFC §8.3). */
  boundaryJson: text('boundary_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  aclJson: text('acl_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  validFrom: text('valid_from'),
  validUntil: text('valid_until'),
  observedAt: text('observed_at').notNull(),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
}, (table) => ({ idempotent: uniqueIndex('grounding_evidence_versions_idempotent_uq').on(table.sourceObjectId, table.contentHash) }));

export const groundingSourcePrincipals = sqliteTable('grounding_source_principals', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  connectionId: text('connection_id')
    .notNull()
    .references(() => groundingSourceConnections.id, { onDelete: 'cascade' }),
  externalPrincipalId: text('external_principal_id').notNull(),
  /** person | group | service | channel | domain | public. */
  kind: text('kind').notNull().default('person'),
  displayName: text('display_name'),
  email: text('email'),
  attributesJson: text('attributes_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  status: text('status').notNull().default('active'),
  ...baseTimestamps(),
}, (table) => ({ identity: uniqueIndex('grounding_source_principals_identity_uq').on(table.workspaceId, table.connectionId, table.externalPrincipalId) }));

export const groundingEntities = sqliteTable('grounding_entities', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** person | team | agent | customer | system | product | project | process | metric | other. */
  kind: text('kind').notNull().default('other'),
  name: text('name').notNull(),
  domain: text('domain'),
  aliasesJson: text('aliases_json', { mode: 'json' }).notNull().default(sql`'[]'`),
  attributesJson: text('attributes_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  status: text('status').notNull().default('active'),
  ...baseTimestamps(),
});

export const groundingIdentityLinks = sqliteTable('grounding_identity_links', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  entityId: text('entity_id')
    .notNull()
    .references(() => groundingEntities.id, { onDelete: 'cascade' }),
  principalId: text('principal_id')
    .notNull()
    .references(() => groundingSourcePrincipals.id, { onDelete: 'cascade' }),
  /** email_exact | oauth_subject | owner_asserted | probabilistic (RFC §9.2 split). */
  method: text('method').notNull(),
  confidence: real('confidence').notNull().default(0),
  /** active | review | rejected | split — deterministic methods activate; probabilistic stays in review. */
  status: text('status').notNull().default('review'),
  supportingJson: text('supporting_json', { mode: 'json' }).notNull().default(sql`'[]'`),
  conflictingJson: text('conflicting_json', { mode: 'json' }).notNull().default(sql`'[]'`),
  reviewedBy: text('reviewed_by'),
  validFrom: text('valid_from'),
  validUntil: text('valid_until'),
  ...baseTimestamps(),
});

export const groundingClaims = sqliteTable('grounding_claims', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  subjectEntityId: text('subject_entity_id'),
  subjectRefJson: text('subject_ref_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  predicate: text('predicate').notNull(),
  objectJson: text('object_json', { mode: 'json' }).notNull(),
  /** observation | description | procedure | ownership | decision | dependency | policy | metric | causal_hypothesis. */
  claimType: text('claim_type').notNull().default('observation'),
  /** candidate | active | disputed | superseded | rejected | expired — formation-gated (RFC §10.6). */
  status: text('status').notNull().default('candidate'),
  /** Computed, never narrated (RFC §10.3). */
  confidence: real('confidence').notNull().default(0),
  confidenceJson: text('confidence_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  authorityJson: text('authority_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  accessPolicyJson: text('access_policy_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  protectedDomain: integer('protected_domain', { mode: 'boolean' }).notNull().default(false),
  validFrom: text('valid_from'),
  validUntil: text('valid_until'),
  reasoningVersion: text('reasoning_version'),
  recordedAt: text('recorded_at').notNull().default(isoNow() as unknown as string),
  ...baseTimestamps(),
});

export const groundingClaimEvidence = sqliteTable('grounding_claim_evidence', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  claimId: text('claim_id')
    .notNull()
    .references(() => groundingClaims.id, { onDelete: 'cascade' }),
  evidenceVersionId: text('evidence_version_id')
    .notNull()
    .references(() => groundingEvidenceVersions.id, { onDelete: 'cascade' }),
  /** supports | contradicts | contextualizes | supersedes. */
  role: text('role').notNull().default('supports'),
  directness: real('directness').notNull().default(1),
  locatorJson: text('locator_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  /** Copied/forwarded text collapses to one key — corroboration counts independent origins only (RFC §10.6). */
  independenceKey: text('independence_key'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

export const groundingClaimConflicts = sqliteTable('grounding_claim_conflicts', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** knowledge_links row (relation='contradicts') — conflicts surface through the EXISTING dispute system (RFC §10.5). */
  disputeLinkId: text('dispute_link_id'),
  claimIdsJson: text('claim_ids_json', { mode: 'json' }).notNull().default(sql`'[]'`),
  activeClaimId: text('active_claim_id'),
  /** confidence_winner | authority_winner | temporal_successor | human_decision | unresolved. */
  resolution: text('resolution').notNull().default('unresolved'),
  /** low | normal | protected — protected never auto-resolves by confidence. */
  consequentiality: text('consequentiality').notNull().default('normal'),
  rationaleJson: text('rationale_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  ...baseTimestamps(),
});

export const groundingModelArtifacts = sqliteTable('grounding_model_artifacts', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** process | ownership | decision | system | dependency | narrative | gap. */
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  bodyJson: text('body_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  claimIdsJson: text('claim_ids_json', { mode: 'json' }).notNull().default(sql`'[]'`),
  status: text('status').notNull().default('active'),
  snapshotId: text('snapshot_id'),
  version: integer('version').notNull().default(1),
  accessPolicyJson: text('access_policy_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  ...baseTimestamps(),
});

export const groundingModelSnapshots = sqliteTable('grounding_model_snapshots', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  predecessorId: text('predecessor_id'),
  /** building | active | superseded | rejected. */
  status: text('status').notNull().default('building'),
  claimSetHash: text('claim_set_hash'),
  entityGraphHash: text('entity_graph_hash'),
  reasoningVersion: text('reasoning_version'),
  sourceCoverageJson: text('source_coverage_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  builtAt: text('built_at'),
  activatedAt: text('activated_at'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

export const groundingLearningPlans = sqliteTable('grounding_learning_plans', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ownerUserId: text('owner_user_id'),
  sourceConnectionIdsJson: text('source_connection_ids_json', { mode: 'json' }).notNull().default(sql`'[]'`),
  /** Array<{kind, mode, status}> (RFC §10.8). */
  stagesJson: text('stages_json', { mode: 'json' }).notNull().default(sql`'[]'`),
  reasoningMode: text('reasoning_mode').notNull().default('adaptive'),
  dailyBudgetJson: text('daily_budget_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  status: text('status').notNull().default('active'),
  ...baseTimestamps(),
}, (table) => ({ unique: uniqueIndex('grounding_learning_plans_ws_uq').on(table.workspaceId) }));

export const groundingAgentGrants = sqliteTable('grounding_agent_grants', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull(),
  /** none | full_delegated | agent_decides | human_approval (RFC §9.5). */
  mode: text('mode').notNull().default('agent_decides'),
  allowedSourcesJson: text('allowed_sources_json', { mode: 'json' }).notNull().default(sql`'["*"]'`),
  allowedDomainsJson: text('allowed_domains_json', { mode: 'json' }).notNull().default(sql`'["*"]'`),
  
  maxConfidentiality: text('max_confidentiality').notNull().default('internal'),
  allowedAudiencesJson: text('allowed_audiences_json', { mode: 'json' }).notNull().default(sql`'["private"]'`),
  /** deny | approval_required | authoritative_only. */
  protectedDomainPolicy: text('protected_domain_policy').notNull().default('deny'),
  tokenBudgetPerRun: integer('token_budget_per_run'),
  expiresAt: text('expires_at'),
  ...baseTimestamps(),
}, (table) => ({ unique: uniqueIndex('grounding_agent_grants_agent_uq').on(table.workspaceId, table.agentId) }));


export const connectionAgentGrants = sqliteTable('connection_agent_grants', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** channel | credential | mcp — the resource family this grant governs. */
  connectionKind: text('connection_kind').notNull(),
  /** id of the governed resource (channel_connections.id / credential id / mcp server id). Polymorphic — no hard FK. */
  connectionId: text('connection_id').notNull(),
  agentId: text('agent_id').notNull(),
  /** read | send | manage — least-privilege scope ceiling (manage ⊃ send ⊃ read). */
  scope: text('scope').notNull().default('send'),
  
  status: text('status').notNull().default('active'),
  
  note: text('note'),
  
  grantedBy: text('granted_by'),
  expiresAt: text('expires_at'),
  ...baseTimestamps(),
}, (table) => ({ unique: uniqueIndex('connection_agent_grants_uq').on(table.workspaceId, table.connectionId, table.agentId) }));

/**
 * The Durable Entity spine (Agent-Native Platform Plan §3.0) — the ONE unification.
 *
 * A keyed, restart-durable, single-writer-per-key record with a typed inbox and a
 * wake clock, driven by one dispatcher. This is the shape Restate Virtual Objects /
 * Cloudflare Durable Objects / Temporal entity workflows all converge on, and what
 * `ConversationContactState` + `WorkflowRunState.waitingInputs` + `app_contacts`
 * already are, three-quarters-built and split. A persistent Agent and a per-subject
 * Subject are the SAME primitive at different `kind`. A run stays the transient
 * per-wake execution an entity spawns — related by FK, never merged (R1's rule).
 */
export const durableEntities = sqliteTable('durable_entities', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** agent | subject | <domain kind> — which projection of the spine this row is. */
  kind: text('kind').notNull(),
  /** Stable identity within (workspace, kind) — an agentId, a lead handle, a ticket id. */
  key: text('key').notNull(),
  appId: text('app_id'),
  /** active | done — a terminal entity stops being woken. */
  status: text('status').notNull().default('active'),
  /** Small, agent-editable working-memory blocks (Letta-style) — NOT an ever-growing log. */
  stateJson: text('state_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  /** Timer wake — the entity is due when nextWakeAt <= now. */
  nextWakeAt: text('next_wake_at'),
  /** Correlation token handed to the outside world; an inbound reply matches on it. */
  awaitingCorrelationJson: text('awaiting_correlation_json', { mode: 'json' }),
  /** Single-writer lease (SQLite is single-writer for the FILE, not per-entity — this is mandatory). */
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: text('lease_expires_at'),
  ...baseTimestamps(),
}, (table) => ({
  unique: uniqueIndex('durable_entities_key_uq').on(table.workspaceId, table.kind, table.key),
  due: index('durable_entities_due_idx').on(table.status, table.nextWakeAt),
}));

/** The per-entity durable inbox — external events queue here and are drained under the entity's lease. */
export const entityInbox = sqliteTable('entity_inbox', {
  id: text('id').primaryKey(),
  entityId: text('entity_id')
    .notNull()
    .references(() => durableEntities.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  payloadJson: text('payload_json', { mode: 'json' }),
  receivedAt: text('received_at').notNull().default(isoNow() as unknown as string),
  consumedAt: text('consumed_at'),
}, (table) => ({ scan: index('entity_inbox_scan_idx').on(table.entityId, table.consumedAt) }));

/**
 * Experiment substrate (Agent-Native Platform Plan §3.5) — the one genuinely-absent
 * primitive. A general variant/metric layer: assign each subject to a variant, record
 * its outcome, aggregate success rate PER variant. Domain-neutral — any decision point
 * (which message, which model, which prompt) is an experiment; not message-specific.
 */
export const experiments = sqliteTable('experiments', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  appId: text('app_id'),
  /** Stable experiment key within the workspace (e.g. "first_message"). */
  key: text('key').notNull(),
  /** The arms, e.g. ["A","B","C"]. */
  variantsJson: text('variants_json', { mode: 'json' }).notNull().default(sql`'[]'`),
  /** running | stopped. */
  status: text('status').notNull().default('running'),
  ...baseTimestamps(),
}, (table) => ({ unique: uniqueIndex('experiments_key_uq').on(table.workspaceId, table.key) }));

/** One row per subject assigned to a variant; its outcome is recorded later (sticky arm). */
export const experimentAssignments = sqliteTable('experiment_assignments', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  experimentId: text('experiment_id')
    .notNull()
    .references(() => experiments.id, { onDelete: 'cascade' }),
  /** Stable subject identity (a lead handle, a contact id…). */
  subjectKey: text('subject_key').notNull(),
  variant: text('variant').notNull(),
  /** null until a terminal outcome is recorded (e.g. won | lost). */
  outcome: text('outcome'),
  assignedAt: text('assigned_at').notNull().default(isoNow() as unknown as string),
  outcomeAt: text('outcome_at'),
}, (table) => ({
  unique: uniqueIndex('experiment_assignments_uq').on(table.experimentId, table.subjectKey),
  byVariant: index('experiment_assignments_variant_idx').on(table.experimentId, table.variant),
}));

/**
 * Evolution Loop — a Strategy is a competing, recalled approach an App runs to
 * advance its Goal. `wins`/`trials` are the measured outcome; `confidence` is the
 * outcome-weighted recall weight (not recurrence). Status: active | proven | retired.
 */
export const strategies = sqliteTable('strategies', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  appId: text('app_id').notNull(),
  /** Stable strategy key within (workspace, app). */
  key: text('key').notNull(),
  /** The approach this strategy embodies (the hypothesis being tested). */
  hypothesis: text('hypothesis').notNull(),
  /** Linked experiment key + the arm this strategy IS (optional). */
  experimentKey: text('experiment_key'),
  variant: text('variant'),
  /** Generation number — spawned variants increment it. */
  generation: integer('generation').notNull().default(0),
  /** The strategy this was spawned from, if any. */
  parentId: text('parent_id'),
  /** North-star metric this strategy is measured on (denormalized from the Goal). */
  metric: text('metric'),
  /** active | proven | retired. */
  status: text('status').notNull().default('active'),
  wins: integer('wins').notNull().default(0),
  trials: integer('trials').notNull().default(0),
  /** Outcome-weighted recall confidence (Laplace-smoothed win rate, sample-aware). */
  confidence: real('confidence').notNull().default(0.5),
  /** The mirrored recall atom id, when a proven strategy has been written to the Brain. */
  atomId: text('atom_id'),
  ...baseTimestamps(),
}, (table) => ({
  keyUnique: uniqueIndex('strategies_key_uq').on(table.workspaceId, table.appId, table.key),
  byApp: index('strategies_app_idx').on(table.workspaceId, table.appId, table.status),
  byExperiment: index('strategies_experiment_idx').on(table.workspaceId, table.experimentKey, table.variant),
}));

export const groundingBehaviorInfluences = sqliteTable('grounding_behavior_influences', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull(),
  runId: text('run_id'),
  grantId: text('grant_id'),
  sourceClaimIdsJson: text('source_claim_ids_json', { mode: 'json' }).notNull().default(sql`'[]'`),
  /** context | routing_hint | procedure | constraint | escalation | tool_preference. */
  kind: text('kind').notNull().default('context'),
  interactionAudience: text('interaction_audience').notNull().default('private'),
  protectedDomain: integer('protected_domain', { mode: 'boolean' }).notNull().default(false),
  /** automatic | authority_approved | human_approved. */
  activation: text('activation').notNull().default('automatic'),
  /** Logged BEFORE dispatch — inspectable, attributable, reversible (RFC invariant 6). */
  renderedInstruction: text('rendered_instruction').notNull(),
  precedence: integer('precedence').notNull().default(0),
  /** active | revoked | expired. */
  status: text('status').notNull().default('active'),
  expiresAt: text('expires_at'),
  revokedAt: text('revoked_at'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

export const groundingMigrationCandidates = sqliteTable('grounding_migration_candidates', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  observedProcessArtifactId: text('observed_process_artifact_id'),
  supportingClaimIdsJson: text('supporting_claim_ids_json', { mode: 'json' }).notNull().default(sql`'[]'`),
  currentSystemsJson: text('current_systems_json', { mode: 'json' }).notNull().default(sql`'[]'`),
  recurrence: real('recurrence').notNull().default(0),
  determinism: real('determinism').notNull().default(0),
  dataReadiness: real('data_readiness').notNull().default(0),
  expectedValue: real('expected_value').notNull().default(0),
  operationalRisk: real('operational_risk').notNull().default(0),
  reversibility: real('reversibility').notNull().default(0),
  /** agent_task | workflow | ability | listener | keep_external. */
  recommendedTarget: text('recommended_target').notNull().default('keep_external'),
  /** observing | candidate | investigating | draft_ready | shadowing | owner_approved | active | rejected.
   *  Trust gate (RFC §18): cannot leave 'observing' until supporting claims are active + corroborated + dispute-free. */
  status: text('status').notNull().default('observing'),
  evidenceJson: text('evidence_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  ...baseTimestamps(),
});

export const groundingInvestigations = sqliteTable('grounding_investigations', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  question: text('question').notNull(),
  requesterJson: text('requester_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  scopeJson: text('scope_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  /** queued | running | completed | inconclusive | failed (RFC §11.2). */
  status: text('status').notNull().default('queued'),
  /** Plain-language explanation produced by the Feynman loop. */
  explanation: text('explanation'),
  findingsJson: text('findings_json', { mode: 'json' }).notNull().default(sql`'[]'`),
  gapsJson: text('gaps_json', { mode: 'json' }).notNull().default(sql`'[]'`),
  evidenceVersionIdsJson: text('evidence_version_ids_json', { mode: 'json' }).notNull().default(sql`'[]'`),
  claimIdsJson: text('claim_ids_json', { mode: 'json' }).notNull().default(sql`'[]'`),
  /** 0..1 — computed grounding/coverage score; low grounding publishes a no-op. */
  grounding: real('grounding').notNull().default(0),
  modelVersionsJson: text('model_versions_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

export const groundingAccessRequests = sqliteTable('grounding_access_requests', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull(),
  runId: text('run_id'),
  /** What the agent wants to know and why the task needs it (RFC §9.5). */
  purpose: text('purpose').notNull(),
  requestedDomainsJson: text('requested_domains_json', { mode: 'json' }).notNull().default(sql`'[]'`),
  interactionAudience: text('interaction_audience').notNull().default('private'),
  /** pending | approved | rejected | expired. */
  status: text('status').notNull().default('pending'),
  /** once | run | session | standing — how long the approval holds. */
  decisionScope: text('decision_scope'),
  decidedBy: text('decided_by'),
  decidedAt: text('decided_at'),
  expiresAt: text('expires_at'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

export const groundingAuditEvents = sqliteTable('grounding_audit_events', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** owner | agent | system. */
  actor: text('actor').notNull().default('system'),
  agentId: text('agent_id'),
  eventType: text('event_type').notNull(),
  subjectKind: text('subject_kind'),
  subjectId: text('subject_id'),
  payloadJson: text('payload_json', { mode: 'json' }).notNull().default(sql`'{}'`),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

// ────────────────────────────────────────────────────────────
// Agentic Apps (AGENTIC-APPS-10X-MASTERPLAN §3) — the first-class deployable
// unit. An App owns workflows (workflows.appId). Surfaces (§4) and datastore
// (§5) land in later migrations and reference apps.id. Migration v82.
// ────────────────────────────────────────────────────────────

export const apps = sqliteTable(
  'apps',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    version: text('version').notNull().default('0.1.0'),
    /** draft | published | archived. */
    status: text('status').notNull().default('draft'),
    entrySurfaceId: text('entry_surface_id'),
    /** Immutable App-interface pointers. Surfaces are the active projection. */
    activeInterfaceRevisionId: text('active_interface_revision_id'),
    candidateInterfaceRevisionId: text('candidate_interface_revision_id'),
    interfaceTrustState: text('interface_trust_state').notNull().default('legacy_unverified'),
    icon: text('icon'),
    /** Domain (or Subdomain) this App is organized under. Its workflows inherit. */
    spaceId: text('domain_id').references((): AnySQLiteColumn => domains.id, { onDelete: 'set null' }),
    /** Specialist agent that owns this App (App-level responsibility; workflows inherit). */
    ownerAgentId: text('owner_agent_id').references((): AnySQLiteColumn => agents.id, { onDelete: 'set null' }),
    manifestJson: text('manifest_json', { mode: 'json' }).notNull().default(sql`'{}'`),
    policyJson: text('policy_json', { mode: 'json' }).notNull().default(sql`'{}'`),
    sourceJson: text('source_json', { mode: 'json' }),
    installedChecksum: text('installed_checksum'),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...baseTimestamps(),
  },
  (table) => ({
    workspaceSlug: uniqueIndex('idx_apps_workspace_slug').on(table.workspaceId, table.slug),
  }),
);

export const appMembers = sqliteTable(
  'app_members',
  {
    appId: text('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    
    role: text('role').notNull().default('worker'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.appId, table.agentId] }),
    byAgent: index('idx_app_members_agent').on(table.agentId),
  }),
);

/**
 * Validated, revisioned construction blueprint for newly built Apps. The App
 * reference is nullable until validation succeeds and materialization begins.
 */
export const appBlueprints = sqliteTable(
  'app_blueprints',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    appId: text('app_id').references(() => apps.id, { onDelete: 'set null' }),
    semanticKey: text('semantic_key').notNull(),
    name: text('name').notNull(),
    intent: text('intent').notNull(),
    revision: integer('revision').notNull().default(1),
    status: text('status').notNull().default('draft'),
    topology: text('topology_json', { mode: 'json' }).notNull().default(sql`'{}'`),
    acceptanceCriteria: text('acceptance_json', { mode: 'json' }).notNull().default(sql`'[]'`),
    validation: text('validation_json', { mode: 'json' }).notNull().default(sql`'{"valid":false,"issues":[]}'`),
    createdBy: text('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
    ...baseTimestamps(),
  },
  (table) => ({
    semanticRevision: uniqueIndex('uq_app_blueprints_semantic_revision').on(table.workspaceId, table.semanticKey, table.revision),
    byApp: index('idx_app_blueprints_app').on(table.workspaceId, table.appId, table.updatedAt),
  }),
);

/** Server-owned build state. Chat prose is a projection of this record. */
export const buildSessions = sqliteTable(
  'build_sessions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    blueprintId: text('blueprint_id').notNull().references(() => appBlueprints.id, { onDelete: 'cascade' }),
    appId: text('app_id').references(() => apps.id, { onDelete: 'set null' }),
    conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
    ownerAgentId: text('owner_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    stage: text('stage').notNull().default('discover'),
    status: text('status').notNull().default('running'),
    snapshot: text('snapshot_json', { mode: 'json' }).notNull().default(sql`'{}'`),
    evidence: text('evidence_json', { mode: 'json' }).notNull().default(sql`'[]'`),
    diagnostic: text('diagnostic_json', { mode: 'json' }),
    repairAttempts: integer('repair_attempts').notNull().default(0),
    createdBy: text('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
    completedAt: text('completed_at'),
    ...baseTimestamps(),
  },
  (table) => ({
    byWorkspace: index('idx_build_sessions_workspace').on(table.workspaceId, table.updatedAt),
    byApp: index('idx_build_sessions_app').on(table.workspaceId, table.appId, table.updatedAt),
    byConversation: index('idx_build_sessions_conversation').on(table.workspaceId, table.conversationId, table.updatedAt),
  }),
);

// Living Apps Phase 3 — the relationship entity (migration v97). One row per
// contact an App talks to (a lead/customer), unifying a person across channels
// via peerId and carrying the pipeline state (stage/goal) + the proactivity
// clock (nextTouchAt → the follow-up sweep dispatches a turn when due).
export const appContacts = sqliteTable(
  'app_contacts',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    appId: text('app_id').notNull().references((): AnySQLiteColumn => apps.id, { onDelete: 'cascade' }),
    /** The channel this identity came in on (telegram/whatsapp/…). */
    channelKind: text('channel_kind'),
    /** The per-channel handle (chat id / sender id). */
    handle: text('handle'),
    /** Cross-channel peer identity (ChannelIdentityService) — same person across channels. */
    peerId: text('peer_id'),
    /** Canonical relationship actor; this table remains a query/UI projection. */
    subjectId: text('subject_id').references((): AnySQLiteColumn => durableEntities.id, { onDelete: 'set null' }),
    displayName: text('display_name'),
    /** Pipeline stage (new | qualifying | …) — App-defined. */
    stage: text('stage'),
    /** The agent's goal for this relationship. */
    goal: text('goal'),
    /** Terminal relationship outcome (LIVING-APPS-10X Phase M2 · G10): won | lost | abandoned. */
    outcome: text('outcome'),
    /** When the outcome was recorded — feeds the graded-lesson + graduation loop. */
    outcomeAt: text('outcome_at'),
    dataJson: text('data_json', { mode: 'json' }).notNull().default(sql`'{}'`),
    lastTouchAt: text('last_touch_at'),
    /** When set + due, the proactive sweep dispatches a follow-up turn. */
    nextTouchAt: text('next_touch_at'),
    ...baseTimestamps(),
  },
  (table) => ({
    uniqueHandle: uniqueIndex('idx_app_contacts_handle').on(table.appId, table.channelKind, table.handle),
    dueIdx: index('idx_app_contacts_due').on(table.workspaceId, table.nextTouchAt),
    byApp: index('idx_app_contacts_app').on(table.appId, table.stage),
  }),
);


export const appOutboundLog = sqliteTable(
  'app_outbound_log',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    
    source: text('source').notNull().default('agent'),
    sentAt: text('sent_at').notNull().default(isoNow() as unknown as string),
  },
  (table) => ({
    byAppTime: index('idx_app_outbound_log_app_time').on(table.appId, table.sentAt),
  }),
);


export const conversationParticipants = sqliteTable(
  'conversation_participants',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references((): AnySQLiteColumn => conversations.id, { onDelete: 'cascade' }),
    /** agent | human | contact */
    participantType: text('participant_type').notNull(),
    /** agentId / userId / app_contact id — nullable for an external contact identified by handle. */
    participantId: text('participant_id'),
    
    role: text('role').notNull(),
    /** Active participants are in the thread now; specialists drive inbound when active. */
    active: integer('active').notNull().default(1),
    joinedAt: text('joined_at').notNull().default(isoNow() as unknown as string),
    leftAt: text('left_at'),
  },
  (table) => ({
    uniqueParty: uniqueIndex('idx_conversation_participants_party').on(
      table.conversationId,
      table.participantType,
      table.participantId,
    ),
    byConversation: index('idx_conversation_participants_conversation').on(table.conversationId, table.active),
  }),
);

/**
 * Long-horizon per-conversation memory (LIVING-APPS-10X Phase 6 · G4, migration v103).
 *
 * The channel turn only sees a 20-message window (HISTORY_LIMIT), so the agent
 * forgets the middle of a month-long thread. This holds ONE rolling "state of
 * this relationship" summary per conversation — refreshed as messages accrue past
 * the window (via the workspace StructuredCompleter, with a deterministic
 * last-N + counts fallback) and injected into every turn's context.
 */
export const conversationSummaries = sqliteTable(
  'conversation_summaries',
  {
    conversationId: text('conversation_id')
      .primaryKey()
      .references((): AnySQLiteColumn => conversations.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull(),
    appId: text('app_id'),
    /** The rolling narrative summary injected into the turn ("state of this relationship"). */
    summary: text('summary').notNull().default(''),
    /** High-water mark — how many messages have been folded into the summary so far. */
    coveredCount: integer('covered_count').notNull().default(0),
    /** Stable watermark for incremental compaction when history is inserted out of order. */
    coveredThroughMessageId: text('covered_through_message_id'),
    coveredThroughAt: text('covered_through_at'),
    /** 'model' (StructuredCompleter) or 'deterministic' (last-N + counts fallback). */
    source: text('source').notNull().default('deterministic'),
    ...baseTimestamps(),
  },
  (table) => ({
    byWorkspace: index('idx_conversation_summaries_workspace').on(table.workspaceId),
  }),
);

// App Datastore (§5) — typed collections + schema-validated records. Migration v83.
export const appCollections = sqliteTable(
  'app_collections',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    schemaJson: text('schema_json', { mode: 'json' }).notNull(),
    policyJson: text('policy_json', { mode: 'json' }).notNull().default(sql`'{}'`),
    ...baseTimestamps(),
  },
  (table) => ({
    appName: uniqueIndex('idx_app_collections_app_name').on(table.appId, table.name),
  }),
);

export const appRecords = sqliteTable(
  'app_records',
  {
    id: text('id').primaryKey(),
    collectionId: text('collection_id')
      .notNull()
      .references(() => appCollections.id, { onDelete: 'cascade' }),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    dataJson: text('data_json', { mode: 'json' }).notNull().default(sql`'{}'`),
    version: integer('version').notNull().default(1),
    createdBy: text('created_by'),
    ...baseTimestamps(),
  },
  (table) => ({
    byCollection: index('idx_app_records_collection').on(table.collectionId, table.updatedAt),
  }),
);

// AG-UI surfaces (§4) — agent-authored ViewNode tree + declared actions. Migration v84.
export const appSurfaces = sqliteTable(
  'app_surfaces',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** page | dashboard | thread | embed | public. */
    kind: text('kind').notNull().default('page'),
    viewJson: text('view_json', { mode: 'json' }),
    actionsJson: text('actions_json', { mode: 'json' }).notNull().default(sql`'[]'`),
    shareable: integer('shareable', { mode: 'boolean' }).notNull().default(false),
    revision: integer('revision').notNull().default(0),
    ...baseTimestamps(),
  },
  (table) => ({
    appName: uniqueIndex('idx_app_surfaces_app_name').on(table.appId, table.name),
  }),
);

/** Per-operator notification state. Notification IDs identify stable occurrences. */
export const notificationReceipts = sqliteTable('notification_receipts', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  notificationId: text('notification_id').notNull(),
  seenAt: text('seen_at'),
  dismissedAt: text('dismissed_at'),
  ...baseTimestamps(),
}, (table) => ({
  occurrence: uniqueIndex('uq_notification_receipts_occurrence')
    .on(table.workspaceId, table.userId, table.notificationId),
  byUser: index('idx_notification_receipts_user')
    .on(table.workspaceId, table.userId, table.updatedAt),
}));

export const appInterfaceRevisions = sqliteTable(
  'app_interface_revisions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    parentRevisionId: text('parent_revision_id'),
    /** Complete page snapshot. Keeping revisions self-contained makes publish/restore atomic. */
    pagesJson: text('pages_json', { mode: 'json' }).notNull().default(sql`'[]'`),
    semanticHash: text('semantic_hash').notNull(),
    source: text('source').notNull().default('operator'),
    actorType: text('actor_type').notNull().default('user'),
    actorId: text('actor_id'),
    reason: text('reason').notNull().default('Interface update'),
    /** candidate | active | abandoned. */
    status: text('status').notNull().default('candidate'),
    /** legacy_unverified | candidate | verified | rejected. */
    trustState: text('trust_state').notNull().default('candidate'),
    verifiedAt: text('verified_at'),
    publishedAt: text('published_at'),
    rejectedAt: text('rejected_at'),
    ...baseTimestamps(),
  },
  (table) => ({
    byApp: index('idx_app_interface_revisions_app').on(table.workspaceId, table.appId, table.createdAt),
    appHash: index('idx_app_interface_revisions_hash').on(table.appId, table.semanticHash),
  }),
);

export const appInterfaceProofs = sqliteTable(
  'app_interface_proofs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    revisionId: text('revision_id')
      .notNull()
      .references(() => appInterfaceRevisions.id, { onDelete: 'cascade' }),
    gate: text('gate').notNull(),
    status: text('status').notNull(),
    semanticHash: text('semantic_hash').notNull(),
    evidenceJson: text('evidence_json', { mode: 'json' }).notNull().default(sql`'{}'`),
    ...baseTimestamps(),
  },
  (table) => ({
    revisionGate: uniqueIndex('uq_app_interface_proof_gate').on(table.revisionId, table.gate),
    byRevision: index('idx_app_interface_proofs_revision').on(table.revisionId, table.status),
  }),
);

export const appRecordIndex = sqliteTable(
  'app_record_index',
  {
    appId: text('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    collectionId: text('collection_id')
      .notNull()
      .references(() => appCollections.id, { onDelete: 'cascade' }),
    recordId: text('record_id')
      .notNull()
      .references(() => appRecords.id, { onDelete: 'cascade' }),
    fieldKey: text('field_key').notNull(),
    valueText: text('value_text'),
    valueNumber: real('value_number'),
    valueBoolean: integer('value_boolean', { mode: 'boolean' }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.collectionId, table.recordId, table.fieldKey] }),
    lookupText: index('idx_app_record_index_text').on(table.collectionId, table.fieldKey, table.valueText),
    lookupNumber: index('idx_app_record_index_number').on(table.collectionId, table.fieldKey, table.valueNumber),
    lookupBoolean: index('idx_app_record_index_boolean').on(table.collectionId, table.fieldKey, table.valueBoolean),
  }),
);

// App lifecycle snapshots (§9) — manifest + live collection rows captured before
// an upgrade so rollback can restore both definition and data.
export const appLifecycleSnapshots = sqliteTable(
  'app_lifecycle_snapshots',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    manifestJson: text('manifest_json', { mode: 'json' }).notNull(),
    installedChecksum: text('installed_checksum'),
    collectionsJson: text('collections_json', { mode: 'json' }).notNull().default(sql`'[]'`),
    reason: text('reason').notNull().default('upgrade'),
    createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  },
  (table) => ({
    byApp: index('idx_app_lifecycle_snapshots_app').on(table.workspaceId, table.appId, table.createdAt),
  }),
);

export const appEnvironments = sqliteTable(
  'app_environments',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('dev'),
    manifestJson: text('manifest_json', { mode: 'json' }).notNull(),
    sourceEnvironmentId: text('source_environment_id'),
    promotedAt: text('promoted_at'),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
    updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
  },
  (table) => ({
    appName: uniqueIndex('idx_app_environments_app_name').on(table.workspaceId, table.appId, table.name),
    byApp: index('idx_app_environments_app').on(table.workspaceId, table.appId, table.kind),
  }),
);

/**
 * Queue-then-auto-continue mid-turn composer (migration v110). While a
 * conversation's turn is streaming, further sends are not dropped or
 * steered into the live model call — they are durably queued here (so a
 * page reload never silently loses them) and auto-dispatched, oldest
 * first, the moment the in-flight turn's SSE stream ends. Mirrored in
 * src/sqlite/migrations.ts (conversation_message_queue).
 */
export const conversationMessageQueue = sqliteTable(
  'conversation_message_queue',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    /** Reserved for future composer attachments; unused today (nullable JSON). */
    attachments: text('attachments', { mode: 'json' }),
    createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
    /** Monotonic per-conversation ordering bucket (oldest dispatches first). */
    position: integer('position').notNull().default(0),
    /** pending | sent | discarded. */
    status: text('status').notNull().default('pending'),
  },
  (table) => ({
    byConversation: index('idx_conversation_message_queue_conversation').on(table.conversationId, table.status, table.position),
  }),
);

// Durable external-agent ownership sync (migration v114). Source policy,
// observed revisions/items, and immutable sync runs are separate facts.
export const agentSyncSources = sqliteTable(
  'agent_sync_sources',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    adapterType: text('adapter_type').notNull(),
    externalId: text('external_id').notNull(),
    rootPath: text('root_path'),
    /** manual_review | auto_trusted | disabled. */
    mode: text('mode').notNull().default('manual_review'),
    policyJson: text('policy_json', { mode: 'json' }).notNull().default(sql`'{}'`),
    lastScanAt: text('last_scan_at'),
    lastSuccessAt: text('last_success_at'),
    lastError: text('last_error'),
    ...baseTimestamps(),
  },
  (table) => ({
    byAgent: uniqueIndex('idx_agent_sync_sources_agent').on(table.workspaceId, table.agentId),
    byExternal: uniqueIndex('idx_agent_sync_sources_external').on(table.workspaceId, table.adapterType, table.externalId),
  }),
);

export const agentSyncItems = sqliteTable(
  'agent_sync_items',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceId: text('source_id').notNull().references(() => agentSyncSources.id, { onDelete: 'cascade' }),
    itemKey: text('item_key').notNull(),
    /** memory | skill | identity. */
    itemType: text('item_type').notNull(),
    sourcePath: text('source_path'),
    origin: text('origin'),
    contentHash: text('content_hash').notNull(),
    previousHash: text('previous_hash'),
    /** pending | quarantined | applied | rejected | deleted | conflict. */
    status: text('status').notNull().default('pending'),
    quality: real('quality'),
    decisionReason: text('decision_reason'),
    targetKind: text('target_kind'),
    targetId: text('target_id'),
    payloadJson: text('payload_json', { mode: 'json' }).notNull().default(sql`'{}'`),
    firstSeenAt: text('first_seen_at').notNull().default(isoNow() as unknown as string),
    lastSeenAt: text('last_seen_at').notNull().default(isoNow() as unknown as string),
    appliedAt: text('applied_at'),
    ...baseTimestamps(),
  },
  (table) => ({
    byKey: uniqueIndex('idx_agent_sync_items_key').on(table.sourceId, table.itemKey),
    byStatus: index('idx_agent_sync_items_status').on(table.workspaceId, table.sourceId, table.status),
  }),
);

export const agentSyncRuns = sqliteTable(
  'agent_sync_runs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceId: text('source_id').notNull().references(() => agentSyncSources.id, { onDelete: 'cascade' }),
    trigger: text('trigger').notNull().default('manual'),
    mode: text('mode').notNull(),
    status: text('status').notNull().default('scanning'),
    detectedJson: text('detected_json', { mode: 'json' }).notNull().default(sql`'{}'`),
    appliedJson: text('applied_json', { mode: 'json' }).notNull().default(sql`'{}'`),
    error: text('error'),
    startedAt: text('started_at').notNull().default(isoNow() as unknown as string),
    completedAt: text('completed_at'),
  },
  (table) => ({ bySource: index('idx_agent_sync_runs_source').on(table.sourceId, table.startedAt) }),
);



