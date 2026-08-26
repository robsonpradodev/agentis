import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';
import { EMBEDDED_INIT_SQL } from './embedded-sql.js';
import { runSqliteMigrations } from '../migrate.js';

export type AgentisSqliteDb = BetterSQLite3Database<typeof schema>;
export type AgentisSqliteRaw = Database.Database;

export interface SqliteOpenOptions {
  /** Filesystem path to the database file. Will be created if missing. */
  path: string;
  /** Run embedded migrations on open. Defaults to true. */
  migrate?: boolean;
}

/**
 * Open the embedded SQLite database, ensure the directory exists, apply WAL,
 * enable foreign keys, and run migrations idempotently.
 *
 * Two migration layers run, in order:
 *   1. runEmbeddedMigrations — authoritative for the actual V1 schema: it
 *      execs EMBEDDED_INIT_SQL and applies the idempotent drift-patch
 *      ALTERs/rebuilds that keep pre-existing databases current.
 *   2. runSqliteMigrations — the versioned schema_migrations layer. Because
 *      step 1 already created the core tables, it backfills version 1 (the
 *      init) rather than re-running it, then applies any future versioned
 *      migrations. This is the authoritative *record* of applied versions.
 */
export function openSqlite(options: SqliteOpenOptions): { db: AgentisSqliteDb; sqlite: Database.Database } {
  mkdirSync(dirname(options.path), { recursive: true });
  const isNewDatabase = !existsSync(options.path);
  const sqlite = new Database(options.path);
  // Incremental auto-vacuum must be selected before the first table exists.
  // It lets lifecycle maintenance return archived hot pages to the filesystem
  // in bounded chunks instead of requiring a second full-size VACUUM copy.
  if (isNewDatabase) sqlite.pragma('auto_vacuum = INCREMENTAL');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  if (options.migrate !== false) {
    runEmbeddedMigrations(sqlite);
    runSqliteMigrations(sqlite);
  }

  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

function runEmbeddedMigrations(sqlite: Database.Database): void {
  // Older databases can have a plans table without columns referenced by
  // indexes in EMBEDDED_INIT_SQL. Add those columns before the embedded schema
  // creates its indexes; the versioned runner records their migrations below.
  {
    const plansTable = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plans'")
      .get() as { name: string } | undefined;
    if (plansTable) {
      const planColumns = sqlite.prepare("SELECT name FROM pragma_table_info('plans')").all() as Array<{ name: string }>;
      if (!planColumns.some((column) => column.name === 'session_id')) {
        sqlite.exec('ALTER TABLE plans ADD COLUMN session_id TEXT');
      }
      if (!planColumns.some((column) => column.name === 'owner_agent_id')) {
        sqlite.exec('ALTER TABLE plans ADD COLUMN owner_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL');
      }
    }
  }

  // Existing databases can have the knowledge_bases table without workflow
  // scoping. EMBEDDED_INIT_SQL now creates idx_knowledge_bases_scope, so add
  // the compatibility column before the init SQL creates indexes.
  {
    const knowledgeBasesTable = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_bases'")
      .get() as { name: string } | undefined;
    if (knowledgeBasesTable) {
      const columns = sqlite.prepare("SELECT name FROM pragma_table_info('knowledge_bases')").all() as Array<{
        name: string;
      }>;
      if (!columns.some((column) => column.name === 'scope_id')) {
        // Polymorphic scope (workflow OR app) — no FK (see migration v92).
        sqlite.exec('ALTER TABLE knowledge_bases ADD COLUMN scope_id TEXT');
      }
    }
  }

  // Embedded migrations are inlined as a string literal in embedded-sql.ts
  // so distribution stays a single JS bundle with zero file-resolution risk.
  sqlite.exec(EMBEDDED_INIT_SQL);

  // ── Idempotent column additions ─────────────────────────────────────────
  // For pre-existing databases, the CREATE TABLE statements above are no-ops
  // (IF NOT EXISTS), so newly added columns must be added explicitly via
  // ALTER TABLE. SQLite has no `ADD COLUMN IF NOT EXISTS`; we check
  // pragma_table_info first.
  const tableExists = (table: string): boolean => {
    const row = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { name: string } | undefined;
    return Boolean(row);
  };
  const columnExists = (table: string, column: string): boolean => {
    if (!tableExists(table)) return false;
    const rows = sqlite
      .prepare(`SELECT name FROM pragma_table_info(?)`)
      .all(table) as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  };
  const addColumn = (table: string, column: string, ddl: string): void => {
    if (!tableExists(table)) return;
    if (!columnExists(table, column)) {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  };
  const renameTable = (from: string, to: string): void => {
    if (!tableExists(from) || tableExists(to)) return;
    sqlite.exec(`ALTER TABLE ${from} RENAME TO ${to}`);
  };
  const renameColumn = (table: string, from: string, to: string): void => {
    if (!tableExists(table) || !columnExists(table, from) || columnExists(table, to)) return;
    sqlite.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
  };

  // Workspace issue queue defaults.
  addColumn('workspaces', 'issue_prefix', "TEXT NOT NULL DEFAULT 'AGT'");

  // Layer 5 §5.3 — workspace/day cost ceiling.
  addColumn('workspaces', 'daily_budget_cents', 'INTEGER');

  // Workspace metadata fields.
  addColumn('workspaces', 'description', 'TEXT');
  addColumn('workspaces', 'image_url', 'TEXT');

  // Extensions: operation-level execution audit.
  addColumn('extension_executions', 'operation_name', "TEXT NOT NULL DEFAULT 'execute'");

  // Layer 6 §6.4 — pin artifacts to the workspace output gallery.
  addColumn('artifacts', 'pinned', 'INTEGER NOT NULL DEFAULT 0');

  // Assets §1 (migration v90) — group artifacts by producing App + origin class.
  addColumn('artifacts', 'app_id', 'TEXT REFERENCES apps(id) ON DELETE SET NULL');
  addColumn('artifacts', 'origin', "TEXT NOT NULL DEFAULT 'manual'");

  // Live Workspace §C (migration v91) — issues become the schedulable backlog.
  addColumn('issues', 'scheduled_for', 'TEXT');
  addColumn('issues', 'recurrence_cron', 'TEXT');
  addColumn('channel_peer_identities', 'blocked', 'INTEGER NOT NULL DEFAULT 0');
  // Relationship principals (v135/v136). These must be present before the
  // embedded index block below runs, because an older database already has the
  // table and CREATE TABLE IF NOT EXISTS cannot add the new columns for it.
  addColumn('channel_peer_identities', 'connection_id', 'TEXT REFERENCES channel_connections(id) ON DELETE CASCADE');
  addColumn('channel_peer_identities', 'grounding_entity_id', 'TEXT REFERENCES durable_entities(id) ON DELETE SET NULL');
  addColumn('channel_peer_identities', 'authority_role', "TEXT NOT NULL DEFAULT 'external'");
  addColumn('channel_peer_identities', 'authority_method', 'TEXT');
  addColumn('channel_peer_identities', 'verified_at', 'TEXT');
  addColumn('channel_peer_identities', 'grant_expires_at', 'TEXT');

  // Company OS layer (migration v2): conversation messages can be linked to an
  // issue. embedded-sql.ts predates this column — patch the drift here.
  addColumn('conversation_messages', 'issue_id', 'TEXT');
  addColumn('conversations', 'title', 'TEXT');
  addColumn('conversations', 'archived_at', 'TEXT');
  addColumn('conversations', 'channel_connection_id', 'TEXT REFERENCES channel_connections(id) ON DELETE SET NULL');
  addColumn('conversations', 'channel_chat_id', 'TEXT');
  addColumn('conversations', 'permission_mode', "TEXT NOT NULL DEFAULT 'ask'");
  addColumn('conversations', 'approval_sensitivity', "TEXT NOT NULL DEFAULT 'balanced'");

  // Living Apps Phase 0 (migration v95) — a channel/conversation can belong to an App.
  // Plain TEXT: this drift runs before the apps table exists, so no inline FK
  // (the Drizzle schema .references() carries the ORM relation).
  addColumn('channel_connections', 'app_id', 'TEXT');
  addColumn('conversations', 'app_id', 'TEXT');
  addColumn('conversations', 'handoff_state', 'TEXT');
  // Living Apps Phase 2 (migration v104) — "needs-you" flags. Both columns are on
  // the embedded baseline conversations table; plain INTEGER/TEXT, no FK.
  addColumn('conversations', 'needs_attention', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('conversations', 'needs_attention_reason', 'TEXT');
  // Living Apps Phase M2 (migration v99) — terminal relationship outcome (the
  // learning loop). Plain TEXT, no FK. app_contacts is post-baseline so this is a
  // no-op until the versioned runner creates it; kept for drift safety.
  addColumn('app_contacts', 'outcome', 'TEXT');
  addColumn('app_contacts', 'outcome_at', 'TEXT');
  sqlite.exec(`
CREATE INDEX IF NOT EXISTS idx_channel_connections_app ON channel_connections(app_id);
CREATE INDEX IF NOT EXISTS idx_conversations_app ON conversations(app_id);
`);

  // Agentless (workspace-owned) channel connections: drop the NOT NULL + cascade
  // on agent_id so a connection can be workspace-global (NULL agent → inbound
  // routes to the orchestrator, any agent may send). SQLite can't ALTER a
  // column's NOT NULL, so rebuild the (tiny) table. Guarded on the current
  // agent_id being NOT NULL so it runs at most once.
  if (tableExists('channel_connections')) {
    const agentCol = (sqlite.prepare(`SELECT "notnull" AS nn FROM pragma_table_info('channel_connections') WHERE name = 'agent_id'`).get() as { nn?: number } | undefined);
    if (agentCol && agentCol.nn === 1) {
      sqlite.exec(`
PRAGMA foreign_keys = OFF;
CREATE TABLE channel_connections_next (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id      TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id        TEXT REFERENCES agents(id) ON DELETE SET NULL,
  app_id          TEXT REFERENCES apps(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL,
  name            TEXT NOT NULL,
  token_encrypted TEXT NOT NULL,
  webhook_secret  TEXT,
  settings        TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'active',
  last_event_at   TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO channel_connections_next (
  id, workspace_id, ambient_id, user_id, agent_id, app_id, kind, name, token_encrypted, webhook_secret, settings, status, last_event_at, last_error, created_at, updated_at
)
SELECT
  id, workspace_id, ambient_id, user_id, agent_id, app_id, kind, name, token_encrypted, webhook_secret, settings, status, last_event_at, last_error, created_at, updated_at
FROM channel_connections;
DROP TABLE channel_connections;
ALTER TABLE channel_connections_next RENAME TO channel_connections;
CREATE INDEX IF NOT EXISTS idx_channel_connections_app ON channel_connections(app_id);
PRAGMA foreign_keys = ON;
`);
    }
  }
  sqlite.exec(`
DROP INDEX IF EXISTS uq_conversation_agent;
DROP INDEX IF EXISTS uq_conversation_agent_active;
CREATE INDEX IF NOT EXISTS idx_conversation_history ON conversations(workspace_id, agent_id, archived_at, last_message_at);
CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations(workspace_id, agent_id, channel_connection_id, channel_chat_id, archived_at);
`);

  // PackagerService: agent personality fields.
  addColumn('agents', 'instructions', 'TEXT');
  addColumn('agents', 'avatar_glyph', 'TEXT');
  addColumn('agents', 'avatar_url', 'TEXT');
  addColumn('agents', 'runtime_model', 'TEXT');
  addColumn('agents', 'role', 'TEXT');
  addColumn('agents', 'description', 'TEXT');
  addColumn('agents', 'reports_to', 'TEXT REFERENCES agents(id) ON DELETE SET NULL');
  addColumn('agents', 'is_paused', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('agents', 'monthly_budget_cents', 'INTEGER');
  addColumn('agents', 'current_month_spend_cents', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('agents', 'budget_reset_day', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('agents', 'canvas_position', 'TEXT');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_agents_reports_to ON agents(workspace_id, reports_to)');
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS agents_workspace_orchestrator ON agents(workspace_id) WHERE role = 'orchestrator'");

  // PackagerService: workflow concurrency + tagging.
  addColumn('workflows', 'max_concurrent_runs', 'INTEGER');
  // §5.3 — per-run workflow cost ceiling.
  addColumn('workflows', 'budget_cents', 'INTEGER');
  addColumn('workflows', 'concurrency_overflow', "TEXT NOT NULL DEFAULT 'queue'");
  addColumn('workflows', 'tags', "TEXT NOT NULL DEFAULT '[]'");
  addColumn('workflows', 'description', 'TEXT');
  normalizeDomainSchema(sqlite, { tableExists, columnExists, addColumn });
  renameColumn('agents', 'space_id', 'domain_id');
  renameColumn('agents', 'space_tag', 'domain_tag');
  renameColumn('workflows', 'space_id', 'domain_id');
  addColumn('agents', 'domain_id', 'TEXT REFERENCES domains(id) ON DELETE SET NULL');
  addColumn('agents', 'domain_tag', 'TEXT');
  addColumn('workflows', 'domain_id', 'TEXT REFERENCES domains(id) ON DELETE SET NULL');
  // Subdomains: a domain row with parent_domain_id set is nested under another
  // domain; its manager_id is the responsible specialist. owner_agent_id gives a
  // workflow a direct specialist owner. Mirrored in schema.ts + migration v80.
  addColumn('domains', 'parent_domain_id', 'TEXT REFERENCES domains(id) ON DELETE SET NULL');
  addColumn('workflows', 'owner_agent_id', 'TEXT REFERENCES agents(id) ON DELETE SET NULL');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_domains_parent ON domains(workspace_id, parent_domain_id)');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_workflows_owner ON workflows(workspace_id, owner_agent_id)');
  // Apps as the org primitive: domain placement + specialist owner (workflows
  // inherit). Mirrored in schema.ts (apps.spaceId, apps.ownerAgentId) + migration v88.
  // Guarded: the apps table is created by the versioned migrations, which may run
  // after this drift block on a fresh embedded DB.
  if (tableExists('apps')) {
    addColumn('apps', 'domain_id', 'TEXT REFERENCES domains(id) ON DELETE SET NULL');
    addColumn('apps', 'owner_agent_id', 'TEXT REFERENCES agents(id) ON DELETE SET NULL');
    sqlite.exec('CREATE INDEX IF NOT EXISTS idx_apps_domain ON apps(workspace_id, domain_id)');
    sqlite.exec('CREATE INDEX IF NOT EXISTS idx_apps_owner ON apps(workspace_id, owner_agent_id)');
  }
  normalizeRoomSchema(sqlite, { tableExists, columnExists });
  // Normalize workflow metadata + concurrency. Older builds had summary and
  // intended_behavior columns, and one drifted build added concurrency_overflow
  // as NOT NULL without a default. Rebuild once into the current shape.
  migrateWorkflowsConcurrencyOverflow(sqlite);
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS workflow_run_queue (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ambient_id TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  trigger_id TEXT REFERENCES triggers(id) ON DELETE SET NULL,
  inputs TEXT NOT NULL DEFAULT '{}',
  initial_state TEXT,
  graph_snapshot TEXT,
  enqueued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  scheduled_at TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  parent_run_id TEXT,
  chain_depth INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_workflow_run_queue_pending ON workflow_run_queue(workflow_id, status, scheduled_at, priority, enqueued_at);
CREATE INDEX IF NOT EXISTS idx_workflow_run_queue_workspace ON workflow_run_queue(workspace_id, status, enqueued_at);

CREATE TABLE IF NOT EXISTS node_execution_cache (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  output TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  byte_size INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, workflow_id, node_id, input_hash)
);
CREATE INDEX IF NOT EXISTS idx_cache_expiry ON node_execution_cache(expires_at);

CREATE TABLE IF NOT EXISTS workflow_event_subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  target_workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  source_node_id TEXT,
  filter_expression TEXT,
  input_mapping TEXT NOT NULL DEFAULT '{}',
  coalesce_policy TEXT NOT NULL DEFAULT 'always_enqueue',
  catchup_policy TEXT NOT NULL DEFAULT 'enqueue_missed_with_cap:5',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_event_sub_source ON workflow_event_subscriptions(source_workflow_id, enabled);
CREATE INDEX IF NOT EXISTS idx_event_sub_target ON workflow_event_subscriptions(target_workflow_id, enabled);

CREATE TABLE IF NOT EXISTS schedule_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  scheduled_at TEXT NOT NULL,
  last_fired_at TEXT,
  missed_fires INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_schedule_due ON schedule_runs(status, scheduled_at);
`);

  migrateWorkflowRunsEphemeral(sqlite);
  addColumn('workflow_runs', 'conversation_id', 'TEXT REFERENCES conversations(id) ON DELETE SET NULL');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_runs_conversation ON workflow_runs(conversation_id, created_at DESC)');
  migratePlansTaskSpine(sqlite, { tableExists, columnExists, addColumn });

  migrateChannelDeliveriesUniqueness(sqlite);

  // Cross-surface peer identity (OMNICHANNEL §5.2): one principal per exact
  // connection + channel kind + handle. A phone number can legitimately reach
  // two WhatsApp connections in the same workspace; routing identity and
  // authority must therefore never collapse at workspace/channel scope.
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS channel_peer_identities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id TEXT REFERENCES channel_connections(id) ON DELETE CASCADE,
  channel_kind TEXT NOT NULL,
  handle TEXT NOT NULL,
  display_name TEXT,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  peer_key TEXT,
  grounding_entity_id TEXT REFERENCES durable_entities(id) ON DELETE SET NULL,
  authority_role TEXT NOT NULL DEFAULT 'external',
  authority_method TEXT,
  verified_at TEXT,
  grant_expires_at TEXT,
  blocked INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
DROP INDEX IF EXISTS uq_channel_peer;
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_peer_principal
  ON channel_peer_identities(workspace_id, connection_id, channel_kind, handle);
CREATE INDEX IF NOT EXISTS idx_channel_peer_user ON channel_peer_identities(workspace_id, user_id);
CREATE INDEX IF NOT EXISTS idx_channel_peer_key ON channel_peer_identities(workspace_id, peer_key);
CREATE INDEX IF NOT EXISTS idx_channel_peer_authority
  ON channel_peer_identities(workspace_id, connection_id, authority_role);
`);

  // Per-App outbound safety envelope counter (LIVING-APPS §7 · G7, v101). Append-only
  // row per agent-initiated outbound send; powers the durable rolling-hour rate limit.
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS app_outbound_log (
  id       TEXT PRIMARY KEY,
  app_id   TEXT NOT NULL,
  source   TEXT NOT NULL DEFAULT 'agent',
  sent_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_app_outbound_log_app_time ON app_outbound_log(app_id, sent_at);
`);

  // Per-workspace orchestrator model-role overrides (OMNICHANNEL §4.4). One row
  // per (workspace, role); api_key is vault-encrypted. Absent rows fall back to
  // the env-configured default model.
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS workspace_model_config (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  base_url TEXT,
  model TEXT NOT NULL,
  api_key_encrypted TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_model_role ON workspace_model_config(workspace_id, role);
`);

  // Vault-encrypted persistent-channel auth state (OMNICHANNEL §3.4 / §7).
  // WhatsApp (baileys) creds + signal keys live here instead of plaintext files
  // on disk. Key-value per (connection, key); value is vault ciphertext.
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS channel_auth_state (
  connection_id TEXT NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_encrypted TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (connection_id, key)
);
`);

  sqlite.exec(`
CREATE TABLE IF NOT EXISTS async_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  priority TEXT NOT NULL DEFAULT 'normal',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  scheduled_for TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_error TEXT,
  leased_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_async_jobs_poll ON async_jobs(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_async_jobs_workspace ON async_jobs(workspace_id, created_at);
`);
  // async_jobs was created in migration v7 without priority or leased_at;
  // migration v30 drops and recreates it, but the embedded path uses CREATE TABLE IF NOT EXISTS
  // which is a no-op for pre-existing databases. Patch the drift here.
  addColumn('async_jobs', 'priority', "TEXT NOT NULL DEFAULT 'normal'");
  addColumn('async_jobs', 'leased_at', 'TEXT');

  // SMARTER-AGENTS-10X §VI — persistent, DB-backed agent sessions. A session is
  // a row that lives between LLM inference calls (zero tokens while tools run);
  // its messages are the episodic log, evictable to archival on compaction.
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT,
  node_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  persona_block TEXT NOT NULL DEFAULT '',
  task_block TEXT NOT NULL DEFAULT '',
  plan_block TEXT NOT NULL DEFAULT '',
  observations_block TEXT NOT NULL DEFAULT '',
  suspend_reason TEXT,
  suspend_payload TEXT,
  suspended_at TEXT,
  wake_condition TEXT,
  parent_session_id TEXT,
  delegation_depth INTEGER NOT NULL DEFAULT 0,
  total_steps INTEGER NOT NULL DEFAULT 0,
  total_tokens_in INTEGER NOT NULL DEFAULT 0,
  total_tokens_out INTEGER NOT NULL DEFAULT 0,
  last_compaction_at TEXT,
  output TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_run ON agent_sessions(run_id, node_id);
CREATE INDEX IF NOT EXISTS idx_sessions_wake ON agent_sessions(wake_condition) WHERE status = 'waiting';

CREATE TABLE IF NOT EXISTS agent_session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  tool_call_id TEXT,
  token_count INTEGER,
  in_context_window INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_session_messages ON agent_session_messages(session_id, step_number);
`);

  sqlite.exec(`
CREATE VIEW IF NOT EXISTS ledger_events_search_content AS
SELECT rowid, event_type, trim(
  coalesce(json_extract(payload, '$.content'), '') || ' ' ||
  coalesce(json_extract(payload, '$.output'), '') || ' ' ||
  coalesce(json_extract(payload, '$.summary'), '') || ' ' ||
  coalesce(json_extract(payload, '$.error'), '') || ' ' ||
  coalesce(payload, '')
) AS payload_text FROM ledger_events;
CREATE VIRTUAL TABLE IF NOT EXISTS ledger_events_fts USING fts5(
  event_type,
  payload_text,
  content='ledger_events_search_content',
  content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS ledger_events_fts_insert AFTER INSERT ON ledger_events BEGIN
  INSERT INTO ledger_events_fts(rowid, event_type, payload_text)
  VALUES (
    new.rowid,
    new.event_type,
    trim(
      coalesce(json_extract(new.payload, '$.content'), '') || ' ' ||
      coalesce(json_extract(new.payload, '$.output'), '') || ' ' ||
      coalesce(json_extract(new.payload, '$.summary'), '') || ' ' ||
      coalesce(json_extract(new.payload, '$.error'), '') || ' ' ||
      coalesce(new.payload, '')
    )
  );
END;
CREATE TRIGGER IF NOT EXISTS ledger_events_fts_delete AFTER DELETE ON ledger_events BEGIN
  INSERT INTO ledger_events_fts(ledger_events_fts, rowid, event_type, payload_text)
  VALUES (
    'delete', old.rowid, old.event_type,
    trim(
      coalesce(json_extract(old.payload, '$.content'), '') || ' ' ||
      coalesce(json_extract(old.payload, '$.output'), '') || ' ' ||
      coalesce(json_extract(old.payload, '$.summary'), '') || ' ' ||
      coalesce(json_extract(old.payload, '$.error'), '') || ' ' ||
      coalesce(old.payload, '')
    )
  );
END;

CREATE VIRTUAL TABLE IF NOT EXISTS conversation_messages_fts USING fts5(
  body,
  content='conversation_messages',
  content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS conversation_messages_fts_insert AFTER INSERT ON conversation_messages BEGIN
  INSERT INTO conversation_messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER IF NOT EXISTS conversation_messages_fts_delete AFTER DELETE ON conversation_messages BEGIN
  INSERT INTO conversation_messages_fts(conversation_messages_fts, rowid, body) VALUES('delete', old.rowid, old.body);
END;
CREATE TRIGGER IF NOT EXISTS conversation_messages_fts_update AFTER UPDATE ON conversation_messages BEGIN
  INSERT INTO conversation_messages_fts(conversation_messages_fts, rowid, body) VALUES('delete', old.rowid, old.body);
  INSERT INTO conversation_messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;
`);
}

function migrateWorkflowRunsEphemeral(sqlite: Database.Database): void {
  const columns = sqlite.prepare("PRAGMA table_info('workflow_runs')").all() as Array<{
    name: string;
    notnull: number;
  }>;
  const names = new Set(columns.map((column) => column.name));
  const workflowId = columns.find((column) => column.name === 'workflow_id');
  const hasAllEphemeralColumns = names.has('is_ephemeral') && names.has('ephemeral_title') && names.has('graph_snapshot');
  if (workflowId?.notnull === 0 && hasAllEphemeralColumns) return;

  const selectColumn = (name: string, fallback: string) => (names.has(name) ? name : fallback);
  sqlite.exec(`
PRAGMA foreign_keys = OFF;
CREATE TABLE IF NOT EXISTS workflow_runs_next (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id      TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  workflow_id     TEXT REFERENCES workflows(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id),
  status          TEXT NOT NULL DEFAULT 'CREATED',
  run_state       TEXT NOT NULL,
  replan_count    INTEGER NOT NULL DEFAULT 0,
  is_replay       INTEGER NOT NULL DEFAULT 0,
  is_ephemeral    INTEGER NOT NULL DEFAULT 0,
  ephemeral_title TEXT,
  graph_snapshot  TEXT,
  trigger_id      TEXT REFERENCES triggers(id) ON DELETE SET NULL,
  parent_run_id   TEXT,
  started_at      TEXT,
  completed_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO workflow_runs_next (
  id, workspace_id, ambient_id, workflow_id, user_id, status, run_state, replan_count, is_replay,
  is_ephemeral, ephemeral_title, graph_snapshot, trigger_id, parent_run_id, started_at,
  completed_at, created_at, updated_at
)
SELECT
  id, workspace_id, ambient_id, workflow_id, user_id, status, run_state, replan_count, ${selectColumn('is_replay', '0')},
  ${selectColumn('is_ephemeral', '0')}, ${selectColumn('ephemeral_title', 'NULL')}, ${selectColumn('graph_snapshot', 'NULL')},
  trigger_id, parent_run_id, started_at, completed_at, created_at, updated_at
FROM workflow_runs;
DROP TABLE workflow_runs;
ALTER TABLE workflow_runs_next RENAME TO workflow_runs;
PRAGMA foreign_keys = ON;
CREATE INDEX IF NOT EXISTS idx_runs_workflow ON workflow_runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON workflow_runs(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_runs_workspace_created ON workflow_runs(workspace_id, created_at DESC);
`);
}

function normalizeDomainSchema(
  sqlite: Database.Database,
  helpers: {
    tableExists: (table: string) => boolean;
    columnExists: (table: string, column: string) => boolean;
    addColumn: (table: string, column: string, ddl: string) => void;
  },
): void {
  if (helpers.tableExists('spaces') && !helpers.tableExists('domains')) {
    sqlite.exec('ALTER TABLE spaces RENAME TO domains');
  }
  if (!helpers.tableExists('domains')) {
    sqlite.exec(`
CREATE TABLE IF NOT EXISTS domains (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL,
  description  TEXT,
  color_hex    TEXT,
  icon_emoji   TEXT,
  manager_id   TEXT REFERENCES agents(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);
  }

  const hasLegacyColor = helpers.columnExists('domains', 'color');
  const hasLegacyIcon = helpers.columnExists('domains', 'icon_glyph');
  const hasLegacyTeam = helpers.columnExists('domains', 'team_id');

  helpers.addColumn('domains', 'slug', "TEXT NOT NULL DEFAULT ''");
  helpers.addColumn('domains', 'description', 'TEXT');
  helpers.addColumn('domains', 'color_hex', 'TEXT');
  helpers.addColumn('domains', 'icon_emoji', 'TEXT');
  helpers.addColumn('domains', 'manager_id', 'TEXT REFERENCES agents(id) ON DELETE SET NULL');

  sqlite.exec(`
UPDATE domains
SET slug = COALESCE(NULLIF(lower(replace(trim(name), ' ', '-')), ''), 'domain-' || substr(id, 1, 8))
WHERE slug IS NULL OR trim(slug) = '';
`);

  if (hasLegacyColor) {
    sqlite.exec(`
UPDATE domains
SET color_hex = color
WHERE (color_hex IS NULL OR color_hex = '') AND color IS NOT NULL;
`);
  }

  if (hasLegacyIcon) {
    sqlite.exec(`
UPDATE domains
SET icon_emoji = icon_glyph
WHERE (icon_emoji IS NULL OR icon_emoji = '') AND icon_glyph IS NOT NULL;
`);
  }

  if (hasLegacyColor || hasLegacyIcon || hasLegacyTeam) {
    sqlite.exec(`
PRAGMA foreign_keys = OFF;
CREATE TABLE domains_next (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL,
  description  TEXT,
  color_hex    TEXT,
  icon_emoji   TEXT,
  manager_id   TEXT REFERENCES agents(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO domains_next (
  id, workspace_id, user_id, name, slug, description, color_hex, icon_emoji, manager_id, created_at, updated_at
)
SELECT
  id, workspace_id, user_id, name, slug, description, color_hex, icon_emoji, manager_id, created_at, updated_at
FROM domains;
DROP TABLE domains;
ALTER TABLE domains_next RENAME TO domains;
PRAGMA foreign_keys = ON;
`);
  }
}

function migratePlansTaskSpine(
  sqlite: Database.Database,
  helpers: {
    tableExists: (table: string) => boolean;
    columnExists: (table: string, column: string) => boolean;
    addColumn: (table: string, column: string, ddl: string) => void;
  },
): void {
  if (!helpers.tableExists('plans')) return;
  helpers.addColumn('plans', 'run_ids', "TEXT NOT NULL DEFAULT '[]'");
  helpers.addColumn('plans', 'session_id', 'TEXT');
  helpers.addColumn('plans', 'decisions', "TEXT NOT NULL DEFAULT '[]'");
  helpers.addColumn('plans', 'deviations', "TEXT NOT NULL DEFAULT '[]'");
  helpers.addColumn('plans', 'verification', 'TEXT');

  const columns = sqlite.prepare("PRAGMA table_info('plans')").all() as Array<{
    name: string;
    notnull: number;
  }>;
  const conversationId = columns.find((column) => column.name === 'conversation_id');
  const needsRebuild = conversationId?.notnull === 1;
  if (!needsRebuild) {
    sqlite.exec(`
CREATE INDEX IF NOT EXISTS plans_conversation ON plans(workspace_id, conversation_id, updated_at);
CREATE INDEX IF NOT EXISTS plans_session ON plans(workspace_id, session_id);
`);
    return;
  }

  sqlite.exec(`
PRAGMA foreign_keys = OFF;
CREATE TABLE plans_next (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES conversation_messages(id) ON DELETE SET NULL,
  run_ids TEXT NOT NULL DEFAULT '[]',
  session_id TEXT,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  active_version INTEGER NOT NULL DEFAULT 1,
  approved_version INTEGER,
  decisions TEXT NOT NULL DEFAULT '[]',
  deviations TEXT NOT NULL DEFAULT '[]',
  verification TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO plans_next (
  id, workspace_id, conversation_id, message_id, run_ids, session_id, title, objective, status,
  active_version, approved_version, decisions, deviations, verification, created_at, updated_at
)
SELECT
  id, workspace_id, conversation_id, message_id, run_ids, session_id, title, objective, status,
  active_version, approved_version, decisions, deviations, verification, created_at, updated_at
FROM plans;
DROP TABLE plans;
ALTER TABLE plans_next RENAME TO plans;
PRAGMA foreign_keys = ON;
CREATE INDEX IF NOT EXISTS plans_conversation ON plans(workspace_id, conversation_id, updated_at);
CREATE INDEX IF NOT EXISTS plans_session ON plans(workspace_id, session_id);
`);
}

function normalizeRoomSchema(
  sqlite: Database.Database,
  helpers: {
    tableExists: (table: string) => boolean;
    columnExists: (table: string, column: string) => boolean;
  },
): void {
  if (!helpers.tableExists('rooms')) return;
  const hasTeamId = helpers.columnExists('rooms', 'team_id');
  const hasTeamDefault = helpers.columnExists('rooms', 'is_team_default');
  if (!hasTeamId && !hasTeamDefault) {
    sqlite.exec('DROP TABLE IF EXISTS team_context;');
    sqlite.exec('DROP TABLE IF EXISTS teams;');
    return;
  }

  sqlite.exec(`
PRAGMA foreign_keys = OFF;
CREATE TABLE rooms_next (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL DEFAULT 'custom',
  name              TEXT NOT NULL,
  description       TEXT,
  visibility        TEXT NOT NULL DEFAULT 'workspace',
  pinned_at         TEXT,
  last_message_at   TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO rooms_next (
  id, workspace_id, user_id, kind, name, description, visibility, pinned_at, last_message_at, created_at, updated_at
)
SELECT
  id,
  workspace_id,
  user_id,
  CASE WHEN kind = 'team' THEN 'workspace' ELSE kind END,
  name,
  description,
  CASE WHEN visibility = 'team' THEN 'workspace' ELSE visibility END,
  pinned_at,
  last_message_at,
  created_at,
  updated_at
FROM rooms;
DROP TABLE rooms;
ALTER TABLE rooms_next RENAME TO rooms;
PRAGMA foreign_keys = ON;
CREATE INDEX IF NOT EXISTS idx_rooms_workspace_last ON rooms(workspace_id, last_message_at DESC);
DROP TABLE IF EXISTS team_context;
DROP TABLE IF EXISTS teams;
`);
}

function migrateWorkflowsConcurrencyOverflow(sqlite: Database.Database): void {
  const columns = sqlite.prepare("PRAGMA table_info('workflows')").all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>;
  if (columns.length === 0) return; // table doesn't exist yet

  const overflow = columns.find((column) => column.name === 'concurrency_overflow');
  const alreadyNormalized = Boolean(
    overflow
      && overflow.notnull === 1
      && typeof overflow.dflt_value === 'string'
      && overflow.dflt_value.replace(/'/g, '').trim() === 'queue',
  );

  const names = new Set(columns.map((column) => column.name));
  const hasLegacyDescriptionColumns = names.has('summary') || names.has('intended_behavior');
  if (alreadyNormalized && names.has('description') && !hasLegacyDescriptionColumns) return;

  // Tolerate very old DBs that predate some columns by substituting a literal.
  const pick = (name: string, fallback: string) => (names.has(name) ? name : fallback);
  const coalesceDescription = [
    names.has('description') ? "NULLIF(description, '')" : null,
    names.has('intended_behavior') ? "NULLIF(intended_behavior, '')" : null,
    names.has('summary') ? "NULLIF(summary, '')" : null,
  ].filter(Boolean).join(', ');
  const descriptionExpr = coalesceDescription ? `COALESCE(${coalesceDescription})` : 'NULL';
  const overflowExpr = names.has('concurrency_overflow')
    ? "COALESCE(concurrency_overflow, 'queue')"
    : "'queue'";
  const optionalDefinitions: string[] = [];
  const optionalInsertColumns: string[] = [];
  const optionalSelectExprs: string[] = [];
  if (names.has('domain_id')) {
    optionalDefinitions.push('  domain_id             TEXT REFERENCES domains(id) ON DELETE SET NULL,');
    optionalInsertColumns.push('domain_id');
    optionalSelectExprs.push('domain_id');
  }

  sqlite.exec(`
PRAGMA foreign_keys = OFF;
CREATE TABLE workflows_next (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id            TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
${optionalDefinitions.length > 0 ? `${optionalDefinitions.join('\n')}\n` : ''}
  registry_entry_id     TEXT,
  registry_version      TEXT,
  title                 TEXT NOT NULL,
  description           TEXT,
  graph                 TEXT NOT NULL,
  settings              TEXT NOT NULL DEFAULT '{}',
  is_from_registry      INTEGER NOT NULL DEFAULT 0,
  max_concurrent_runs   INTEGER,
  budget_cents          INTEGER,
  concurrency_overflow  TEXT NOT NULL DEFAULT 'queue',
  tags                  TEXT NOT NULL DEFAULT '[]',
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO workflows_next (
  id, workspace_id, ambient_id, user_id, ${optionalInsertColumns.length > 0 ? `${optionalInsertColumns.join(', ')}, ` : ''}registry_entry_id, registry_version,
  title, description, graph, settings, is_from_registry,
  max_concurrent_runs, budget_cents, concurrency_overflow, tags, created_at, updated_at
)
SELECT
  id, workspace_id, ambient_id, user_id, ${optionalSelectExprs.length > 0 ? `${optionalSelectExprs.join(', ')}, ` : ''}${pick('registry_entry_id', 'NULL')}, ${pick('registry_version', 'NULL')},
  title, ${descriptionExpr}, graph, settings, ${pick('is_from_registry', '0')},
  ${pick('max_concurrent_runs', 'NULL')}, ${pick('budget_cents', 'NULL')}, ${overflowExpr}, ${pick('tags', "'[]'")}, ${pick('created_at', "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))")}, ${pick('updated_at', "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))")}
FROM workflows;
DROP TABLE workflows;
ALTER TABLE workflows_next RENAME TO workflows;
PRAGMA foreign_keys = ON;
CREATE INDEX IF NOT EXISTS idx_workflows_workspace ON workflows(workspace_id);
`);
}

function migrateChannelDeliveriesUniqueness(sqlite: Database.Database): void {
  const indexes = sqlite.prepare("PRAGMA index_list('channel_deliveries')").all() as Array<{
    name: string;
    unique: number;
  }>;
  const hasGlobalExternalIdUnique = indexes.some((index) => {
    if (!index.unique) return false;
    const columns = sqlite.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{ name: string }>;
    return columns.length === 1 && columns[0]?.name === 'external_id';
  });
  if (hasGlobalExternalIdUnique) {
    sqlite.exec(`
CREATE TABLE IF NOT EXISTS channel_deliveries_next (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  conversation_message_id TEXT
);
INSERT OR IGNORE INTO channel_deliveries_next (id, connection_id, workspace_id, external_id, received_at, conversation_message_id)
  SELECT id, connection_id, workspace_id, external_id, received_at, conversation_message_id FROM channel_deliveries;
DROP TABLE channel_deliveries;
ALTER TABLE channel_deliveries_next RENAME TO channel_deliveries;
`);
  }
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_delivery_conn_external ON channel_deliveries(connection_id, external_id)');
}

export { schema };



