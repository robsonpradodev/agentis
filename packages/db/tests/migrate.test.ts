import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import {
  runSqliteMigrations,
  getSqliteMigrationStatus,
  SQLITE_MIGRATIONS,
} from '../src/index.js';
import { openSqlite } from '../src/sqlite/index.js';
import { EMBEDDED_INIT_SQL } from '../src/sqlite/embedded-sql.js';
import * as sqliteSchema from '../src/sqlite/schema.js';
import * as pgSchema from '../src/pg/schema.js';

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentis-db-test-'));
  return join(dir, 'data.db');
}

describe('runSqliteMigrations', () => {
  it('removes the legacy cross-connection channel identity index on every open', () => {
    const path = tempDbPath();
    const first = openSqlite({ path });
    try {
      // Reproduce the regression from an already-upgraded build: embedded
      // startup recreated the obsolete index after migration v135 completed.
      first.sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_peer ON channel_peer_identities(workspace_id, channel_kind, handle)');
    } finally {
      first.sqlite.close();
    }

    const reopened = openSqlite({ path });
    try {
      const indexes = reopened.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='channel_peer_identities'").all() as Array<{ name: string }>;
      const names = indexes.map((row) => row.name);
      expect(names).not.toContain('uq_channel_peer');
      expect(names).toContain('uq_channel_peer_principal');
      expect(SQLITE_MIGRATIONS.find((migration) => migration.version === 136)?.name)
        .toBe('repair_connection_scoped_channel_principal_index');
    } finally {
      reopened.sqlite.close();
    }
  });

  it('creates the durable chat-turn change journal', () => {
    const { sqlite } = openSqlite({ path: tempDbPath() });
    try {
      for (const table of ['conversation_turn_change_payloads', 'conversation_turn_change_sets', 'conversation_turn_changes']) {
        expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table)).toBeDefined();
      }
      expect(SQLITE_MIGRATIONS.find((migration) => migration.version === 134)?.name).toBe('conversation_turn_change_journal');
      expect(sqliteSchema.conversationTurnChangeSets).toBeDefined();
      expect(sqliteSchema.conversationTurnChanges).toBeDefined();
    } finally {
      sqlite.close();
    }
  });
  it('creates durable workflow run activity storage in both schemas', () => {
    const { sqlite } = openSqlite({ path: tempDbPath() });
    try {
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='run_activity_events'").get()).toBeDefined();
      expect(SQLITE_MIGRATIONS.find((migration) => migration.version === 137)?.name).toBe('durable_run_activity_events');
      expect(sqliteSchema.runActivityEvents).toBeDefined();
      expect(pgSchema.runActivityEvents).toBeDefined();
    } finally {
      sqlite.close();
    }
  });
  it('creates canonical channel aliases and the durable outbound action ledger', () => {
    const { sqlite } = openSqlite({ path: tempDbPath() });
    try {
      expect(SQLITE_MIGRATIONS.find((migration) => migration.version === 138)?.name)
        .toBe('canonical_channel_peers_and_action_intents');
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='channel_peer_aliases'").get()).toBeDefined();
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='channel_action_intents'").get()).toBeDefined();
      const conversationColumns = sqlite.prepare("PRAGMA table_info('conversations')").all() as Array<{ name: string }>;
      expect(conversationColumns.map((column) => column.name)).toContain('channel_peer_identity_id');
      const actionColumns = sqlite.prepare("PRAGMA table_info('channel_action_intents')").all() as Array<{ name: string }>;
      expect(actionColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'requester_identity_id', 'peer_identity_id', 'goal', 'authorization_basis',
        'idempotency_key', 'scheduled_for', 'provider_receipt_json',
      ]));
      const indexes = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('channel_peer_aliases','channel_action_intents')").all() as Array<{ name: string }>;
      expect(indexes.map((row) => row.name)).toEqual(expect.arrayContaining([
        'uq_channel_peer_alias', 'idx_channel_peer_alias_peer', 'uq_channel_action_idempotency',
        'idx_channel_action_due', 'idx_channel_action_peer', 'idx_channel_action_requester',
      ]));
      expect(sqliteSchema.channelPeerAliases).toBeDefined();
      expect(sqliteSchema.channelActionIntents).toBeDefined();
    } finally {
      sqlite.close();
    }
  });
  it('adds agent standing goals and resumable unresolved channel targets', () => {
    const { sqlite } = openSqlite({ path: tempDbPath() });
    try {
      expect(SQLITE_MIGRATIONS.find((migration) => migration.version === 139)?.name)
        .toBe('agent_standing_goals_and_resumable_channel_targets');
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_standing_goals'").get()).toBeDefined();
      const goalColumns = sqlite.prepare("PRAGMA table_info('agent_standing_goals')").all() as Array<{ name: string }>;
      expect(goalColumns.map((column) => column.name)).toEqual(expect.arrayContaining(['agent_id', 'objective', 'source_instructions', 'status', 'version', 'policy_json']));
      const actionColumns = sqlite.prepare("PRAGMA table_info('channel_action_intents')").all() as Array<{ name: string; notnull: number }>;
      expect(actionColumns.map((column) => column.name)).toEqual(expect.arrayContaining(['recipient_query', 'required_slots_json', 'effect_receipts_json']));
      expect(actionColumns.find((column) => column.name === 'peer_identity_id')?.notnull).toBe(0);
      expect(sqliteSchema.agentStandingGoals).toBeDefined();
    } finally { sqlite.close(); }
  });
  it('installs durable missions, normalized effect receipts, and workflow/channel linkage', () => {
    const { sqlite } = openSqlite({ path: tempDbPath() });
    try {
      expect(SQLITE_MIGRATIONS.find((migration) => migration.version === 140)?.name)
        .toBe('durable_agent_missions_and_effect_ledger');
      expect(SQLITE_MIGRATIONS.find((migration) => migration.version === 142)?.name)
        .toBe('agent_execution_requirement_receipts');
      expect(SQLITE_MIGRATIONS.find((migration) => migration.version === 143)?.name)
        .toBe('remove_legacy_two_turn_mission_budget');
      const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agent_missions','effect_receipts')").all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name).sort()).toEqual(['agent_missions', 'effect_receipts']);
      const missionColumns = sqlite.prepare("PRAGMA table_info('agent_missions')").all() as Array<{ name: string }>;
      expect(missionColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'owner_agent_id', 'objective', 'status', 'outcome_contract_json', 'execution_plan_json', 'next_wake_at', 'blocker_json',
      ]));
      expect((missionColumns.find((column) => column.name === 'max_attempts') as { dflt_value?: string } | undefined)?.dflt_value).toBe('12');
      const receiptColumns = sqlite.prepare("PRAGMA table_info('effect_receipts')").all() as Array<{ name: string }>;
      expect(receiptColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'mission_id', 'requirement_id', 'plan_step_id', 'kind', 'provider_message_id', 'acknowledged', 'resource_id', 'idempotency_key',
      ]));
      const runColumns = sqlite.prepare("PRAGMA table_info('workflow_runs')").all() as Array<{ name: string }>;
      expect(runColumns.map((column) => column.name)).toContain('mission_id');
      const actionColumns = sqlite.prepare("PRAGMA table_info('channel_action_intents')").all() as Array<{ name: string }>;
      expect(actionColumns.map((column) => column.name)).toEqual(expect.arrayContaining(['mission_id', 'post_ack_mutations_json']));
      expect(sqliteSchema.agentMissions).toBeDefined();
      expect(sqliteSchema.effectReceipts).toBeDefined();
    } finally { sqlite.close(); }
  });
  it('installs Agentic Apps v3 task, effect, and definition storage', () => {
    const { sqlite } = openSqlite({ path: tempDbPath() });
    try {
      expect(SQLITE_MIGRATIONS.find((migration) => migration.version === 144)?.name)
        .toBe('agentic_apps_v3_tasks_effects_and_definitions');
      const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('mission_events','effect_plans','effect_authorization_grants','app_definitions')").all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name).sort()).toEqual(['app_definitions', 'effect_authorization_grants', 'effect_plans', 'mission_events']);
      const missionColumns = sqlite.prepare("PRAGMA table_info('agent_missions')").all() as Array<{ name: string }>;
      expect(missionColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'operation_id', 'root_mission_id', 'parent_mission_id', 'authority_context_json',
        'input_requests_json', 'approval_requests_json', 'artifacts_json', 'cost_budget_cents', 'latency_budget_ms',
      ]));
      expect(sqliteSchema.effectPlans).toBeDefined();
      expect(sqliteSchema.effectAuthorizationGrants).toBeDefined();
      expect(sqliteSchema.appDefinitions).toBeDefined();
    } finally { sqlite.close(); }
  });
  it('installs managed App Git project and immutable build records', () => {
    const { sqlite } = openSqlite({ path: tempDbPath() });
    try {
      expect(SQLITE_MIGRATIONS.find((migration) => migration.version === 145)?.name).toBe('managed_agentic_app_git_projects');
      const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('app_projects','app_builds')").all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name).sort()).toEqual(['app_builds', 'app_projects']);
      expect(sqliteSchema.appProjects).toBeDefined();
      expect(sqliteSchema.appBuilds).toBeDefined();
    } finally { sqlite.close(); }
  });
  it('repairs a database where the mission migration was recorded only partially', () => {
    const { sqlite } = openSqlite({ path: tempDbPath() });
    try {
      sqlite.exec(`
        ALTER TABLE channel_action_intents DROP COLUMN post_ack_mutations_json;
        DELETE FROM schema_migrations WHERE version = 141;
      `);

      expect(
        (sqlite.prepare("PRAGMA table_info('channel_action_intents')").all() as Array<{ name: string }>)
          .map((column) => column.name),
      ).not.toContain('post_ack_mutations_json');

      runSqliteMigrations(sqlite);

      const actionColumns = sqlite.prepare("PRAGMA table_info('channel_action_intents')").all() as Array<{ name: string }>;
      expect(actionColumns.map((column) => column.name)).toContain('post_ack_mutations_json');
      expect(sqlite.prepare('SELECT name FROM schema_migrations WHERE version = 141').get())
        .toEqual({ name: 'repair_partial_agent_mission_effect_columns' });
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_channel_action_mission'").get())
        .toEqual({ name: 'idx_channel_action_mission' });
    } finally { sqlite.close(); }
  });
  it('uses an external-content ledger FTS index instead of duplicating payload storage', () => {
    const { sqlite } = openSqlite({ path: tempDbPath() });
    try {
      const fts = sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = 'ledger_events_fts'").get() as { sql: string };
      expect(fts.sql).toContain("content='ledger_events_search_content'");
      const shadow = sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'ledger_events_fts_content'").get();
      expect(shadow).toBeUndefined();
      const triggers = sqlite.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'ledger_events_fts_%'").get() as { count: number };
      expect(triggers.count).toBe(2);
    } finally {
      sqlite.close();
    }
  });
  it('reserves the Agentic App migration versions and mirrors schema exports', () => {
    // The Agentic App migration block (82–88), asserted by version so unrelated
    // later migrations (memory indexes, artifacts) don't make this brittle.
    expect(
      SQLITE_MIGRATIONS.filter((m) => m.version >= 82 && m.version <= 88).map((m) => [m.version, m.name]),
    ).toEqual([
      [82, 'agentic_apps'],
      [83, 'app_datastore'],
      [84, 'app_surfaces'],
      [85, 'app_lifecycle_snapshots'],
      [86, 'app_hub_ready_seams'],
      [87, 'app_lifecycle_origin_checksum'],
      [88, 'app_domain_and_owner'],
    ]);

    for (const table of ['apps', 'appMembers', 'appCollections', 'appRecords', 'appRecordIndex', 'appSurfaces', 'appLifecycleSnapshots', 'appEnvironments'] as const) {
      expect(sqliteSchema[table]).toBeDefined();
      expect(pgSchema[table]).toBeDefined();
    }
  });

  it('creates the Agentic App tables and nullable workflow adoption column', () => {
    const path = tempDbPath();
    const sqlite = new Database(path);
    try {
      runSqliteMigrations(sqlite);

      for (const table of ['apps', 'app_members', 'app_collections', 'app_records', 'app_record_index', 'app_surfaces', 'app_lifecycle_snapshots', 'app_environments']) {
        expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table)).toBeDefined();
      }

      const appColumns = sqlite.prepare("PRAGMA table_info('apps')").all() as Array<{ name: string }>;
      expect(appColumns.map((column) => column.name)).toEqual(expect.arrayContaining(['source_json', 'installed_checksum', 'domain_id', 'owner_agent_id']));

      const workflowColumns = sqlite.prepare("PRAGMA table_info('workflows')").all() as Array<{
        name: string;
        notnull: number;
      }>;
      const appId = workflowColumns.find((column) => column.name === 'app_id');
      expect(appId).toBeDefined();
      expect(appId?.notnull).toBe(0);

      // Assets §1 (v90) — artifacts gain app_id (nullable) + origin (default 'manual').
      const artifactColumns = sqlite.prepare("PRAGMA table_info('artifacts')").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      expect(artifactColumns.map((c) => c.name)).toEqual(expect.arrayContaining(['app_id', 'origin']));
      const origin = artifactColumns.find((c) => c.name === 'origin');
      expect(origin?.notnull).toBe(1);
      expect(origin?.dflt_value).toBe("'manual'");
    } finally {
      sqlite.close();
    }
  });

  it('v98 creates conversation_participants and backfills the primary for App conversations', () => {
    const path = tempDbPath();
    const { sqlite } = openSqlite({ path });
    try {
      // Table exists after migration.
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_participants'").get()).toBeDefined();

      const v98 = SQLITE_MIGRATIONS.find((m) => m.version === 98);
      expect(v98?.name).toBe('living_apps_conversation_participants');

      // Seed a minimal App conversation (FKs off — we only exercise the backfill SQL).
      sqlite.pragma('foreign_keys = OFF');
      sqlite.exec(`
INSERT INTO conversations (id, workspace_id, user_id, agent_id, app_id)
VALUES ('conv-1', 'ws-1', 'user-1', 'agent-1', 'app-1');
INSERT INTO conversations (id, workspace_id, user_id, agent_id)
VALUES ('conv-bare', 'ws-1', 'user-1', 'agent-2');
`);

      // Re-run the backfill statement (idempotent NOT EXISTS guard).
      sqlite.exec(v98!.sql);

      const parties = sqlite.prepare("SELECT conversation_id AS conv, participant_type AS type, participant_id AS pid, role, active FROM conversation_participants").all() as Array<{ conv: string; type: string; pid: string; role: string; active: number }>;
      // The App conversation is seeded with its primary agent; the bare one is not.
      expect(parties).toEqual([
        { conv: 'conv-1', type: 'agent', pid: 'agent-1', role: 'primary', active: 1 },
      ]);

      // Second run is a no-op (no duplicate primary).
      sqlite.exec(v98!.sql);
      const count = sqlite.prepare("SELECT COUNT(*) AS n FROM conversation_participants").get() as { n: number };
      expect(count.n).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it('v99 adds outcome columns to app_contacts (the learning loop)', () => {
    const path = tempDbPath();
    const { sqlite } = openSqlite({ path });
    try {
      const v99 = SQLITE_MIGRATIONS.find((m) => m.version === 99);
      expect(v99?.name).toBe('living_apps_contact_outcome');

      const cols = sqlite.prepare("PRAGMA table_info('app_contacts')").all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(['outcome', 'outcome_at']));
    } finally {
      sqlite.close();
    }
  });

  it('v100 creates the durable channel_turn_queue with a unique dedup index', () => {
    const path = tempDbPath();
    const { sqlite } = openSqlite({ path });
    try {
      const v100 = SQLITE_MIGRATIONS.find((m) => m.version === 100);
      expect(v100?.name).toBe('living_apps_channel_turn_queue');

      // Table + key columns exist.
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='channel_turn_queue'").get()).toBeDefined();
      const cols = sqlite.prepare("PRAGMA table_info('channel_turn_queue')").all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toEqual(
        expect.arrayContaining(['id', 'workspace_id', 'conversation_id', 'app_id', 'dedup_key', 'payload', 'status', 'attempts', 'leased_at', 'scheduled_for', 'fail_reason']),
      );

      // The dedup index is UNIQUE — a redelivered inbound never enqueues twice.
      sqlite.pragma('foreign_keys = OFF');
      sqlite.exec(`
INSERT INTO channel_turn_queue (id, workspace_id, conversation_id, dedup_key, status)
VALUES ('q1', 'ws-1', 'conv-1', 'msg-1', 'pending');
`);
      expect(() =>
        sqlite.exec(`
INSERT INTO channel_turn_queue (id, workspace_id, conversation_id, dedup_key, status)
VALUES ('q2', 'ws-1', 'conv-1', 'msg-1', 'pending');
`),
      ).toThrow(/UNIQUE/i);
    } finally {
      sqlite.close();
    }
  });

  it('v101 creates the app_outbound_log counter (the outbound safety envelope · G7)', () => {
    const path = tempDbPath();
    const { sqlite } = openSqlite({ path });
    try {
      const v101 = SQLITE_MIGRATIONS.find((m) => m.version === 101);
      expect(v101?.name).toBe('living_apps_outbound_log');

      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_outbound_log'").get()).toBeDefined();
      const cols = sqlite.prepare("PRAGMA table_info('app_outbound_log')").all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(['id', 'app_id', 'source', 'sent_at']));

      // The rolling-window index exists.
      const idx = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_app_outbound_log_app_time'").get();
      expect(idx).toBeDefined();

      // A send is recordable (counter row inserts cleanly).
      sqlite.exec(`INSERT INTO app_outbound_log (id, app_id, source) VALUES ('o1', 'app-1', 'agent');`);
      const row = sqlite.prepare("SELECT source FROM app_outbound_log WHERE id='o1'").get() as { source: string };
      expect(row.source).toBe('agent');
    } finally {
      sqlite.close();
    }
  });

  it('v104 adds needs_attention flag columns to conversations', () => {
    const path = tempDbPath();
    const { sqlite } = openSqlite({ path });
    try {
      const v104 = SQLITE_MIGRATIONS.find((m) => m.version === 104);
      expect(v104?.name).toBe('living_apps_conversation_needs_attention');

      const cols = sqlite.prepare("PRAGMA table_info('conversations')").all() as Array<{ name: string; dflt_value: string | null }>;
      const byName = new Map(cols.map((c) => [c.name, c]));
      expect(byName.has('needs_attention')).toBe(true);
      expect(byName.has('needs_attention_reason')).toBe(true);
      // Defaults to not-flagged so every existing row is unchanged.
      expect(byName.get('needs_attention')?.dflt_value).toBe('0');
    } finally {
      sqlite.close();
    }
  });

  it('v111 creates the outbound channel idempotency journal', () => {
    const path = tempDbPath();
    const { sqlite } = openSqlite({ path });
    try {
      const v111 = SQLITE_MIGRATIONS.find((m) => m.version === 111);
      expect(v111?.name).toBe('channel_outbound_delivery_journal');
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='channel_outbound_deliveries'").get()).toBeDefined();
      const cols = sqlite.prepare("PRAGMA table_info('channel_outbound_deliveries')").all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining([
        'workspace_id', 'connection_id', 'idempotency_key', 'chat_id', 'body_hash',
        'status', 'provider_message_id', 'receipt_json', 'error',
      ]));
      sqlite.pragma('foreign_keys = OFF');
      sqlite.exec("INSERT INTO channel_outbound_deliveries (id,workspace_id,connection_id,idempotency_key,chat_id,body_hash) VALUES ('d1','w1','c1','run:node','chat','hash')");
      expect(() => sqlite.exec("INSERT INTO channel_outbound_deliveries (id,workspace_id,connection_id,idempotency_key,chat_id,body_hash) VALUES ('d2','w1','c1','run:node','chat','hash')")).toThrow(/UNIQUE/i);
    } finally {
      sqlite.close();
    }
  });

  it('v113 creates the leased workflow-event journal and queue idempotency key', () => {
    const path = tempDbPath();
    const { sqlite } = openSqlite({ path });
    try {
      const v113 = SQLITE_MIGRATIONS.find((m) => m.version === 113);
      expect(v113?.name).toBe('durable_workflow_event_delivery');
      const queueCols = sqlite.prepare("PRAGMA table_info('workflow_run_queue')").all() as Array<{ name: string }>;
      expect(queueCols.map((column) => column.name)).toEqual(expect.arrayContaining(['run_id', 'idempotency_key']));
      const deliveryCols = sqlite.prepare("PRAGMA table_info('workflow_event_deliveries')").all() as Array<{ name: string }>;
      expect(deliveryCols.map((column) => column.name)).toEqual(expect.arrayContaining([
        'subscription_id', 'event_identity', 'event_payload', 'source_run_id',
        'status', 'attempts', 'available_at', 'lease_owner', 'lease_expires_at',
        'target_queue_id', 'target_run_id', 'last_error', 'delivered_at',
      ]));
      const indexes = sqlite.prepare("PRAGMA index_list('workflow_event_deliveries')").all() as Array<{ name: string; unique: number }>;
      expect(indexes).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'idx_workflow_event_delivery_identity', unique: 1 }),
        expect.objectContaining({ name: 'idx_workflow_event_delivery_due' }),
      ]));
    } finally {
      sqlite.close();
    }
  });

  it('applies all registered migrations on a fresh database', () => {
    const path = tempDbPath();
    const sqlite = new Database(path);
    try {
      const result = runSqliteMigrations(sqlite);
      expect(result.applied.length).toBe(SQLITE_MIGRATIONS.length);
      // Status reflects applied set, no pending.
      const status = getSqliteMigrationStatus(sqlite);
      expect(status.applied.map((a) => a.version)).toEqual(
        SQLITE_MIGRATIONS.map((m) => m.version),
      );
      expect(status.pending).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('is idempotent — second invocation applies nothing', () => {
    const path = tempDbPath();
    const sqlite = new Database(path);
    try {
      runSqliteMigrations(sqlite);
      const second = runSqliteMigrations(sqlite);
      expect(second.applied).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('recovers when an additive migration already changed the schema but was not recorded', () => {
    const path = tempDbPath();
    const sqlite = new Database(path);
    try {
      runSqliteMigrations(sqlite);
      // Use an additive migration whose target table is still part of the
      // current schema. v52 targeted `abilities`, which v106 intentionally
      // removed, so replaying it no longer represents a recoverable state.
      sqlite.prepare('DELETE FROM schema_migrations WHERE version = ?').run(104);

      const result = runSqliteMigrations(sqlite);

      expect(result.applied.map((migration) => migration.version)).toEqual([104]);
      expect(
        sqlite.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(104),
      ).toBeDefined();
    } finally {
      sqlite.close();
    }
  });

  it('backfills version 1 when an old database has core tables but no schema_migrations', () => {
    // Simulate a database initialised by a pre-runner build: tables exist,
    // schema_migrations does not.
    const path = tempDbPath();
    const sqlite = new Database(path);
    try {
      sqlite.exec(EMBEDDED_INIT_SQL);
      // Sanity: schema_migrations is not present yet.
      const before = sqlite
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`,
        )
        .get();
      expect(before).toBeUndefined();

      const result = runSqliteMigrations(sqlite);
      // Version 1 is backfilled, then newer forward migrations are applied.
      expect(result.applied.map((m) => m.version)).toEqual(
        SQLITE_MIGRATIONS.filter((m) => m.version > 1).map((m) => m.version),
      );

      const status = getSqliteMigrationStatus(sqlite);
      expect(status.applied.map((a) => a.version)).toEqual(
        SQLITE_MIGRATIONS.map((m) => m.version),
      );
    } finally {
      sqlite.close();
    }
  });

  it('applies new migrations after historical migration ids from older builds', () => {
    const path = tempDbPath();
    const sqlite = new Database(path);
    try {
      sqlite.exec(EMBEDDED_INIT_SQL);
      sqlite.exec(`
CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO schema_migrations (version, name) VALUES (1, 'init'), (2, 'company_os_layer');
`);

      const memoryMigration = SQLITE_MIGRATIONS.find((migration) => migration.name === 'agent_memories');
      expect(memoryMigration?.version).toBeGreaterThan(38);
      expect(
        sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='agent_memories'`).get(),
      ).toBeUndefined();

      const result = runSqliteMigrations(sqlite);
      // agent_memories was created at v39 then retired at v51 — both apply, and
      // the table is gone afterward (agent-private memory moved to
      // memory_episodes, scope_id = agentId).
      expect(result.applied.map((migration) => migration.name)).toContain('agent_memories');
      expect(result.applied.map((migration) => migration.name)).toContain('retire_agent_memories');
      expect(
        sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='agent_memories'`).get(),
      ).toBeUndefined();
      expect(
        sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_episodes'`).get(),
      ).toBeDefined();
    } finally {
      sqlite.close();
    }
  });

  it('openSqlite wires the runner — schema_migrations is present after open', () => {
    const path = tempDbPath();
    const { sqlite } = openSqlite({ path });
    try {
      const status = getSqliteMigrationStatus(sqlite);
      expect(status.applied.map((a) => a.version)).toContain(1);
      expect(status.pending).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('upgrades a pre-v125 plans table before embedded indexes are created', () => {
    const path = tempDbPath();
    const initial = openSqlite({ path });
    initial.sqlite.exec(`
DROP INDEX IF EXISTS idx_plans_owner_agent;
ALTER TABLE plans DROP COLUMN owner_agent_id;
DELETE FROM schema_migrations WHERE version IN (125, 126);
`);
    initial.sqlite.close();

    const { sqlite } = openSqlite({ path });
    try {
      const columns = sqlite.prepare("PRAGMA table_info('plans')").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain('owner_agent_id');
      expect(
        sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_plans_owner_agent'").get(),
      ).toBeDefined();
      expect(
        sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notification_receipts'").get(),
      ).toBeDefined();
      expect(
        sqlite.prepare('SELECT version FROM schema_migrations WHERE version = 125').get(),
      ).toBeDefined();
    } finally {
      sqlite.close();
    }
  });

  it('migrate:false on openSqlite skips the runner entirely', () => {
    const path = tempDbPath();
    const { sqlite } = openSqlite({ path, migrate: false });
    try {
      const tables = sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`)
        .get();
      expect(tables).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  it('normalizes a legacy NOT-NULL-without-default workflows.concurrency_overflow column', () => {
    const path = tempDbPath();

    // 1. Reproduce the exact legacy drift: concurrency_overflow NOT NULL, no default.
    const legacy = new Database(path);
    legacy.exec(`
CREATE TABLE workflows (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  ambient_id            TEXT,
  user_id               TEXT NOT NULL,
  registry_entry_id     TEXT,
  registry_version      TEXT,
  title                 TEXT NOT NULL,
  summary               TEXT,
  intended_behavior     TEXT,
  graph                 TEXT NOT NULL,
  settings              TEXT NOT NULL DEFAULT '{}',
  is_from_registry      INTEGER NOT NULL DEFAULT 0,
  max_concurrent_runs   INTEGER,
  concurrency_overflow  TEXT NOT NULL,
  tags                  TEXT NOT NULL DEFAULT '[]',
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);
    legacy
      .prepare('INSERT INTO workflows (id, workspace_id, user_id, title, summary, intended_behavior, graph, concurrency_overflow) VALUES (?,?,?,?,?,?,?,?)')
      .run('wf-legacy', 'ws-1', 'user-1', 'Legacy WF', 'Legacy summary', 'Legacy intent', '{}', 'queue');
    // Confirm the legacy constraint actually bites when the column is omitted.
    expect(() =>
      legacy
        .prepare('INSERT INTO workflows (id, workspace_id, user_id, title, graph) VALUES (?,?,?,?,?)')
        .run('wf-fail', 'ws-1', 'user-1', 'Should fail', '{}'),
    ).toThrow(/NOT NULL constraint failed: workflows\.concurrency_overflow/);
    legacy.close();

    // 2. Open through the runtime path — runs the embedded migrations incl. the rebuild.
    const { sqlite } = openSqlite({ path });
    try {
      const col = (sqlite.prepare("PRAGMA table_info('workflows')").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>).find((c) => c.name === 'concurrency_overflow');
      expect(col?.notnull).toBe(1);
      expect(col?.dflt_value?.replace(/'/g, '')).toBe('queue');

      // Legacy row survives the rebuild.
      const legacyRow = sqlite.prepare("SELECT concurrency_overflow AS v, description AS d FROM workflows WHERE id = 'wf-legacy'").get() as { v: string; d: string };
      expect(legacyRow.v).toBe('queue');
      expect(legacyRow.d).toBe('Legacy intent');
      const migratedColumns = sqlite.prepare("PRAGMA table_info('workflows')").all() as Array<{ name: string }>;
      expect(migratedColumns.map((column) => column.name)).toContain('description');
      expect(migratedColumns.map((column) => column.name)).not.toContain('summary');
      expect(migratedColumns.map((column) => column.name)).not.toContain('intended_behavior');

      // Inserting WITHOUT the column now succeeds and defaults to 'queue'
      // (FK off to isolate the column behaviour from parent-row requirements).
      sqlite.pragma('foreign_keys = OFF');
      sqlite
        .prepare('INSERT INTO workflows (id, workspace_id, user_id, title, graph) VALUES (?,?,?,?,?)')
        .run('wf-new', 'ws-1', 'user-1', 'New WF', '{}');
      const newRow = sqlite.prepare("SELECT concurrency_overflow AS v FROM workflows WHERE id = 'wf-new'").get() as { v: string };
      expect(newRow.v).toBe('queue');
    } finally {
      sqlite.close();
    }
  });

  it('reconciles legacy domains columns to the current schema', () => {
    const path = tempDbPath();
    const legacy = new Database(path);
    try {
      legacy.exec(EMBEDDED_INIT_SQL);
      legacy.exec(`
CREATE TABLE spaces (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  color        TEXT,
  icon_glyph   TEXT,
  team_id      TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO spaces (id, workspace_id, user_id, name, color, icon_glyph, team_id)
VALUES ('space-1', 'ws-1', 'user-1', 'Revenue Ops', '#123456', 'R', 'team-1');
`);
    } finally {
      legacy.close();
    }

    const { sqlite } = openSqlite({ path });
    try {
      const legacyTable = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='spaces'").get();
      expect(legacyTable).toBeUndefined();

      const columns = sqlite.prepare("PRAGMA table_info('domains')").all() as Array<{ name: string }>;
      const names = columns.map((column) => column.name);
      expect(names).toContain('slug');
      expect(names).toContain('description');
      expect(names).toContain('color_hex');
      expect(names).toContain('icon_emoji');
      expect(names).toContain('manager_id');
      const agentColumns = sqlite.prepare("PRAGMA table_info('agents')").all() as Array<{ name: string }>;
      const workflowColumns = sqlite.prepare("PRAGMA table_info('workflows')").all() as Array<{ name: string }>;
      expect(agentColumns.map((column) => column.name)).toContain('domain_id');
      expect(agentColumns.map((column) => column.name)).toContain('domain_tag');
      expect(workflowColumns.map((column) => column.name)).toContain('domain_id');

      const row = sqlite.prepare("SELECT slug, color_hex AS colorHex, icon_emoji AS iconEmoji FROM domains WHERE id = 'space-1'").get() as {
        slug: string;
        colorHex: string;
        iconEmoji: string;
      };
      expect(row.slug).toBe('revenue-ops');
      expect(row.colorHex).toBe('#123456');
      expect(row.iconEmoji).toBe('R');
    } finally {
      sqlite.close();
    }
  });

  it('normalizes legacy room team fields away from the current schema', () => {
    const path = tempDbPath();
    const legacy = new Database(path);
    try {
      legacy.exec(EMBEDDED_INIT_SQL);
      legacy.exec(`
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  ambient_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE team_context (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
DROP TABLE rooms;
CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  team_id TEXT,
  kind TEXT NOT NULL DEFAULT 'team',
  name TEXT NOT NULL,
  description TEXT,
  is_team_default INTEGER NOT NULL DEFAULT 1,
  visibility TEXT NOT NULL DEFAULT 'team',
  pinned_at TEXT,
  last_message_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO rooms (id, workspace_id, user_id, team_id, kind, name, is_team_default, visibility)
VALUES ('room-1', 'ws-1', 'user-1', 'team-1', 'team', 'Ops', 1, 'team');
`);
    } finally {
      legacy.close();
    }

    const { sqlite } = openSqlite({ path });
    try {
      const columns = sqlite.prepare("PRAGMA table_info('rooms')").all() as Array<{ name: string }>;
      const names = columns.map((column) => column.name);
      expect(names).not.toContain('team_id');
      expect(names).not.toContain('is_team_default');
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='teams'").get()).toBeUndefined();
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='team_context'").get()).toBeUndefined();

      const row = sqlite.prepare("SELECT kind, visibility FROM rooms WHERE id = 'room-1'").get() as {
        kind: string;
        visibility: string;
      };
      expect(row.kind).toBe('workspace');
      expect(row.visibility).toBe('workspace');
    } finally {
      sqlite.close();
    }
  });
  it('installs durable agent ownership sync state and audit indexes', () => {
    const path = tempDbPath();
    const { sqlite } = openSqlite({ path });
    try {
      const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_sync_%'").all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name).sort()).toEqual(['agent_sync_items', 'agent_sync_runs', 'agent_sync_sources']);
      const sourceColumns = sqlite.prepare("PRAGMA table_info('agent_sync_sources')").all() as Array<{ name: string }>;
      expect(sourceColumns.map((column) => column.name)).toEqual(expect.arrayContaining(['mode', 'policy_json', 'last_scan_at', 'last_success_at', 'last_error']));
      const indexes = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name LIKE 'agent_sync_%'").all() as Array<{ name: string }>;
      expect(indexes.map((row) => row.name)).toEqual(expect.arrayContaining(['idx_agent_sync_sources_agent', 'idx_agent_sync_items_key', 'idx_agent_sync_runs_source']));
    } finally {
      sqlite.close();
    }
  });

  it('installs durable channel handoff, participant side, and summary watermark columns', () => {
    const path = tempDbPath();
    const { sqlite } = openSqlite({ path });
    try {
      const conversationColumns = sqlite.prepare("PRAGMA table_info('conversations')").all() as Array<{ name: string }>;
      expect(conversationColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'handoff_source',
        'handoff_claimed_at',
        'automation_epoch',
      ]));

      const messageColumns = sqlite.prepare("PRAGMA table_info('conversation_messages')").all() as Array<{ name: string }>;
      expect(messageColumns.map((column) => column.name)).toContain('participant_side');

      const summaryColumns = sqlite.prepare("PRAGMA table_info('conversation_summaries')").all() as Array<{ name: string }>;
      expect(summaryColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'covered_through_message_id',
        'covered_through_at',
      ]));
    } finally {
      sqlite.close();
    }
  });

  it('installs encrypted extension browser checkpoint storage', () => {
    const path = tempDbPath();
    const { sqlite } = openSqlite({ path });
    try {
      const columns = sqlite.prepare("PRAGMA table_info('extension_browser_checkpoints')").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'workspace_id',
        'extension_id',
        'session_name',
        'encrypted_value',
        'last_used_at',
      ]));
      const indexes = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='extension_browser_checkpoints'").all() as Array<{ name: string }>;
      expect(indexes.map((row) => row.name)).toEqual(expect.arrayContaining([
        'idx_extension_browser_checkpoint_owner',
        'idx_extension_browser_checkpoint_recent',
      ]));
    } finally {
      sqlite.close();
    }
  });
});
