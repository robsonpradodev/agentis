import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  AgentisError,
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  type TurnChangeActionResult,
  type TurnChangeConflict,
  type TurnChangeResourceSummary,
  type TurnChangeSetState,
  type TurnChangeSummary,
} from '@agentis/core';
import type { EventBus } from '../../event-bus.js';
import type { Logger } from '../../logger.js';
import type { AgentisSqliteRaw } from '@agentis/db/sqlite';

type MutationBehavior = 'local' | 'mixed' | 'external' | 'none';
type SqlValue = string | number | bigint | Buffer | null;
type EncodedValue = string | number | null | { $agentisBlob: string } | { $agentisBigInt: string };
type EncodedRow = Record<string, EncodedValue>;

interface ColumnInfo {
  name: string;
  pk: number;
}

interface ForeignKeyInfo {
  table: string;
  from: string;
  to: string;
}

interface TableMeta {
  name: string;
  columns: string[];
  primaryKey: string[];
  workspaceScoped: boolean;
  foreignKeys: ForeignKeyInfo[];
  depth: number;
}

interface TableSnapshot {
  meta: TableMeta;
  rows: Map<string, EncodedRow>;
}

type WorkspaceSnapshot = Map<string, TableSnapshot>;

interface CapturedDiff {
  table: string;
  key: Record<string, EncodedValue>;
  before: EncodedRow | null;
  after: EncodedRow | null;
  operation: 'create' | 'update' | 'delete';
  sensitive: boolean;
  label: string;
}

interface StoredChangeRow {
  resource_kind: string;
  resource_id: string;
  resource_label: string;
  row_key: string | null;
  before_payload_id: string | null;
  after_payload_id: string | null;
  commit_ordinal: number;
  sensitive: number;
  reversible: number;
  external_effect: number;
}

interface ChangeSetRow {
  id: string;
  workspace_id: string;
  conversation_id: string;
  turn_id: string;
  state: TurnChangeSetState;
  version: number;
  reversible_count: number;
  sensitive_count: number;
  external_effect_count: number;
  affected_resources: string;
  updated_at: string;
}

interface NetChange {
  table: string;
  key: Record<string, EncodedValue>;
  resourceId: string;
  label: string;
  before: EncodedRow | null;
  after: EncodedRow | null;
  sensitive: boolean;
  ordinal: number;
}

interface PreparedWrite {
  kind: 'insert' | 'update' | 'delete';
  meta: TableMeta;
  key: Record<string, EncodedValue>;
  row?: EncodedRow;
  fields?: string[];
}

export interface CaptureToolInput {
  workspaceId: string;
  durableTurnId: string;
  toolCallId: string;
  toolId: string;
  behavior: MutationBehavior;
}

export interface TurnChangeJournalDeps {
  sqlite: AgentisSqliteRaw;
  logger: Logger;
  bus?: EventBus;
}

const INTERNAL_TABLES = new Set([
  'conversation_turn_change_payloads',
  'conversation_turn_change_sets',
  'conversation_turn_changes',
]);

// Execution traces, chat transcript rows, delivery receipts and append-only audit
// facts are evidence, not mutable product state. Restoring them would falsify
// history and can also swallow events produced concurrently with a long tool call.
const VOLATILE_TABLES = new Set([
  'schema_migrations',
  'audit_entries',
  'ledger_events',
  'ledger_events_search_content',
  'activity_events',
  'observability_events',
  'budget_events',
  'extension_executions',
  'workflow_runs',
  'workflow_run_snapshots',
  'workflow_run_queue',
  'workflow_repair_checkpoints',
  'workflow_event_deliveries',
  'schedule_runs',
  'node_execution_cache',
  'approval_requests',
  'conversation_messages',
  'conversation_turns',
  'conversation_turn_events',
  'conversation_message_queue',
  'conversation_swarms',
  'conversation_swarm_workers',
  'agent_consultations',
  'agent_consultation_messages',
  'room_messages',
  'runtime_sessions',
  'agent_execution_envelopes',
  'agent_sessions',
  'agent_session_messages',
  'channel_deliveries',
  'channel_outbound_deliveries',
  'channel_turn_queue',
  'webhook_deliveries',
  'async_jobs',
  'app_outbound_log',
]);

const SENSITIVE_TABLE = /(?:credential|api_key|auth_state|connection_agent_grant|permission|oauth)/i;
const IGNORED_UPDATE_FIELDS = new Set(['updated_at']);

/**
 * Durable, resource-agnostic Undo/Redo for mutations owned by a chat turn.
 *
 * Captures row images for every workspace-scoped product table around the one
 * shared tool-dispatch boundary. Restoration is field-wise three-way merge:
 * later non-overlapping edits survive, while overlap aborts the whole action.
 */
export class TurnChangeJournal {
  readonly #sqlite: AgentisSqliteRaw;
  readonly #logger: Logger;
  readonly #bus?: EventBus;
  readonly #workspaceTails = new Map<string, Promise<void>>();
  readonly #activeCaptures = new Map<string, number>();
  readonly #pendingSeals = new Set<string>();
  #tables: TableMeta[] | null = null;

  constructor(deps: TurnChangeJournalDeps) {
    this.#sqlite = deps.sqlite;
    this.#logger = deps.logger;
    this.#bus = deps.bus;
  }

  async captureTool<T>(input: CaptureToolInput, execute: () => Promise<T> | T): Promise<T> {
    if (input.behavior === 'none') return execute();
    const turn = this.#sqlite.prepare(
      'SELECT conversation_id FROM conversation_turns WHERE id = ? AND workspace_id = ?',
    ).get(input.durableTurnId, input.workspaceId) as { conversation_id: string } | undefined;
    // Channel-origin and workflow-origin synthetic ids deliberately do not own a
    // UI message action. Only a real durable operator turn can create a change set.
    if (!turn) return execute();

    const release = await this.#acquire(input.workspaceId);
    this.#activeCaptures.set(input.durableTurnId, (this.#activeCaptures.get(input.durableTurnId) ?? 0) + 1);
    let before: WorkspaceSnapshot | null = null;
    try {
      this.#ensureChangeSet(input.workspaceId, turn.conversation_id, input.durableTurnId);
      if (input.behavior === 'local' || input.behavior === 'mixed') {
        before = this.#snapshot(input.workspaceId);
      }
      let output: T;
      let thrown: unknown;
      try {
        output = await execute();
      } catch (error) {
        thrown = error;
        output = undefined as T;
      }

      const after = before ? this.#snapshot(input.workspaceId) : null;
      this.#recordCapture(input, before && after ? diffSnapshots(before, after) : []);
      if (thrown !== undefined) throw thrown;
      return output;
    } catch (error) {
      this.#logger.warn('chat.turn_change_capture_failed', {
        workspaceId: input.workspaceId,
        turnId: input.durableTurnId,
        toolId: input.toolId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      const active = Math.max(0, (this.#activeCaptures.get(input.durableTurnId) ?? 1) - 1);
      if (active === 0) {
        this.#activeCaptures.delete(input.durableTurnId);
        if (this.#pendingSeals.delete(input.durableTurnId)) this.#sealNow(input.workspaceId, input.durableTurnId);
      } else {
        this.#activeCaptures.set(input.durableTurnId, active);
      }
      release();
    }
  }

  seal(workspaceId: string, turnId: string): TurnChangeSummary | null {
    if ((this.#activeCaptures.get(turnId) ?? 0) > 0) {
      this.#pendingSeals.add(turnId);
      return this.summary(workspaceId, turnId);
    }
    return this.#sealNow(workspaceId, turnId);
  }

  #sealNow(workspaceId: string, turnId: string): TurnChangeSummary | null {
    const now = new Date().toISOString();
    this.#sqlite.prepare(`
      UPDATE conversation_turn_change_sets
      SET state = CASE WHEN state = 'recording' THEN 'undoable' ELSE state END,
          updated_at = ?
      WHERE workspace_id = ? AND turn_id = ?
    `).run(now, workspaceId, turnId);
    const summary = this.summary(workspaceId, turnId);
    if (summary) this.#publish(workspaceId, summary);
    return summary;
  }

  summary(workspaceId: string, turnId: string): TurnChangeSummary | null {
    const row = this.#sqlite.prepare(`
      SELECT id, workspace_id, conversation_id, turn_id, state, version,
             reversible_count, sensitive_count, external_effect_count,
             affected_resources, updated_at
      FROM conversation_turn_change_sets
      WHERE workspace_id = ? AND turn_id = ?
    `).get(workspaceId, turnId) as ChangeSetRow | undefined;
    return row ? toSummary(row) : null;
  }

  undo(args: { workspaceId: string; turnId: string; expectedVersion: number; confirmSensitive?: boolean }): TurnChangeActionResult {
    return this.#apply('undo', args);
  }

  redo(args: { workspaceId: string; turnId: string; expectedVersion: number; confirmSensitive?: boolean }): TurnChangeActionResult {
    return this.#apply('redo', args);
  }

  /** Remove content-addressed payloads no longer referenced by any live journal. */
  collectGarbage(): number {
    const result = this.#sqlite.prepare(`
      DELETE FROM conversation_turn_change_payloads
      WHERE id NOT IN (
        SELECT before_payload_id FROM conversation_turn_changes WHERE before_payload_id IS NOT NULL
        UNION
        SELECT after_payload_id FROM conversation_turn_changes WHERE after_payload_id IS NOT NULL
      )
    `).run();
    return result.changes;
  }

  #apply(
    direction: 'undo' | 'redo',
    args: { workspaceId: string; turnId: string; expectedVersion: number; confirmSensitive?: boolean },
  ): TurnChangeActionResult {
    const set = this.#requireSet(args.workspaceId, args.turnId);
    const expectedState: TurnChangeSetState = direction === 'undo' ? 'undoable' : 'undone';
    if (set.version !== args.expectedVersion || set.state !== expectedState) {
      throw new AgentisError('RESOURCE_CONFLICT', `This change set is no longer ready to ${direction}.`, {
        details: { expectedVersion: args.expectedVersion, actualVersion: set.version, state: set.state },
      });
    }
    const initialSummary = toSummary(set);
    if (set.sensitive_count > 0 && !args.confirmSensitive) {
      return {
        changeSet: initialSummary,
        requiresSensitiveConfirmation: true,
        externalEffectsRetained: set.external_effect_count > 0,
      };
    }

    const changes = this.#netChanges(set);
    let conflicts: TurnChangeConflict[] = [];
    try {
      const transaction = this.#sqlite.transaction(() => {
        this.#sqlite.pragma('defer_foreign_keys = ON');
        const writes: PreparedWrite[] = [];
        conflicts = this.#prepareWrites(direction, changes, writes);
        if (conflicts.length > 0) return;
        applyWrites(this.#sqlite, writes);
        this.#sqlite.prepare(`
          UPDATE conversation_turn_change_sets
          SET state = ?, version = version + 1, last_error = NULL, updated_at = ?
          WHERE id = ? AND version = ?
        `).run(direction === 'undo' ? 'undone' : 'undoable', new Date().toISOString(), set.id, set.version);
      });
      transaction.immediate();
    } catch (error) {
      conflicts = [{
        resourceKind: 'change_set',
        resourceId: set.turn_id,
        label: 'Turn changes',
        fields: [],
        reason: 'constraint',
      }];
      this.#logger.warn('chat.turn_change_apply_failed', {
        workspaceId: args.workspaceId,
        turnId: args.turnId,
        direction,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (conflicts.length > 0) {
      return {
        changeSet: initialSummary,
        conflicts,
        externalEffectsRetained: set.external_effect_count > 0,
      };
    }
    const summary = this.summary(args.workspaceId, args.turnId)!;
    this.#publish(args.workspaceId, summary);
    return { changeSet: summary, externalEffectsRetained: set.external_effect_count > 0 };
  }

  #prepareWrites(direction: 'undo' | 'redo', changes: NetChange[], writes: PreparedWrite[]): TurnChangeConflict[] {
    const conflicts: TurnChangeConflict[] = [];
    for (const change of changes) {
      const meta = this.#table(change.table);
      if (!meta) {
        conflicts.push(conflict(change, [], 'missing_dependency'));
        continue;
      }
      const source = direction === 'undo' ? change.after : change.before;
      const target = direction === 'undo' ? change.before : change.after;
      const current = readCurrent(this.#sqlite, meta, change.key);

      if (source === null && target !== null) {
        if (current === null) writes.push({ kind: 'insert', meta, key: change.key, row: target });
        else if (!rowsEqual(current, target)) conflicts.push(conflict(change, differingFields(current, target), 'overlapping_change'));
        continue;
      }
      if (source !== null && target === null) {
        if (current === null) continue;
        if (!rowsEqual(current, source)) {
          conflicts.push(conflict(change, differingFields(current, source), 'overlapping_change'));
          continue;
        }
        writes.push({ kind: 'delete', meta, key: change.key });
        continue;
      }
      if (source === null || target === null) continue;
      if (current === null) {
        conflicts.push(conflict(change, [], 'missing_dependency'));
        continue;
      }
      const changed = changedFields(source, target);
      const overlapping: string[] = [];
      const fields: string[] = [];
      const row = { ...current };
      for (const field of changed) {
        if (valuesEqual(current[field], source[field])) {
          row[field] = target[field]!;
          fields.push(field);
        } else if (!valuesEqual(current[field], target[field])) {
          overlapping.push(field);
        }
      }
      if (overlapping.length > 0) conflicts.push(conflict(change, overlapping, 'overlapping_change'));
      else if (fields.length > 0) writes.push({ kind: 'update', meta, key: change.key, row, fields });
    }
    return conflicts;
  }

  #netChanges(set: ChangeSetRow): NetChange[] {
    const rows = this.#sqlite.prepare(`
      SELECT resource_kind, resource_id, resource_label, row_key,
             before_payload_id, after_payload_id, commit_ordinal,
             sensitive, reversible, external_effect
      FROM conversation_turn_changes
      WHERE change_set_id = ? AND reversible = 1 AND external_effect = 0
      ORDER BY commit_ordinal ASC
    `).all(set.id) as StoredChangeRow[];
    const payloadCache = new Map<string, EncodedRow | null>();
    const byResource = new Map<string, NetChange>();
    for (const row of rows) {
      if (!row.row_key) continue;
      const key = JSON.parse(row.row_key) as Record<string, EncodedValue>;
      const identity = `${row.resource_kind}:${stableJson(key)}`;
      const before = this.#payload(row.before_payload_id, payloadCache);
      const after = this.#payload(row.after_payload_id, payloadCache);
      const existing = byResource.get(identity);
      if (existing) {
        existing.after = after;
        existing.ordinal = row.commit_ordinal;
        existing.sensitive ||= Boolean(row.sensitive);
      } else {
        byResource.set(identity, {
          table: row.resource_kind,
          key,
          resourceId: row.resource_id,
          label: row.resource_label,
          before,
          after,
          sensitive: Boolean(row.sensitive),
          ordinal: row.commit_ordinal,
        });
      }
    }
    return [...byResource.values()]
      .filter((change) => !rowsEqual(change.before, change.after))
      .sort((a, b) => b.ordinal - a.ordinal);
  }

  #payload(id: string | null, cache: Map<string, EncodedRow | null>): EncodedRow | null {
    if (!id) return null;
    if (cache.has(id)) return cache.get(id)!;
    const row = this.#sqlite.prepare(
      'SELECT payload FROM conversation_turn_change_payloads WHERE id = ?',
    ).get(id) as { payload: string } | undefined;
    if (!row) return null;
    const value = JSON.parse(gunzipSync(Buffer.from(row.payload, 'base64')).toString('utf8')) as EncodedRow;
    cache.set(id, value);
    return value;
  }

  #recordCapture(input: CaptureToolInput, diffs: CapturedDiff[]): void {
    const transaction = this.#sqlite.transaction(() => {
      const set = this.#requireSet(input.workspaceId, input.durableTurnId);
      let ordinal = (this.#sqlite.prepare(
        'SELECT COALESCE(MAX(commit_ordinal), 0) AS ordinal FROM conversation_turn_changes WHERE change_set_id = ?',
      ).get(set.id) as { ordinal: number }).ordinal;
      for (const diff of diffs) {
        ordinal += 1;
        this.#sqlite.prepare(`
          INSERT INTO conversation_turn_changes (
            id, workspace_id, change_set_id, turn_id, tool_call_id, tool_id,
            commit_ordinal, resource_kind, resource_id, resource_label, operation,
            row_key, before_payload_id, after_payload_id, sensitive, reversible,
            external_effect, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)
        `).run(
          randomUUID(), input.workspaceId, set.id, input.durableTurnId,
          input.toolCallId, input.toolId, ordinal, diff.table,
          stableJson(diff.key), diff.label, diff.operation, stableJson(diff.key),
          this.#storePayload(input.workspaceId, diff.before),
          this.#storePayload(input.workspaceId, diff.after),
          diff.sensitive ? 1 : 0,
          new Date().toISOString(),
        );
      }
      if (input.behavior === 'mixed' || input.behavior === 'external') {
        ordinal += 1;
        this.#sqlite.prepare(`
          INSERT INTO conversation_turn_changes (
            id, workspace_id, change_set_id, turn_id, tool_call_id, tool_id,
            commit_ordinal, resource_kind, resource_id, resource_label, operation,
            sensitive, reversible, external_effect, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'external', ?, ?, 'effect', 0, 0, 1, ?)
        `).run(
          randomUUID(), input.workspaceId, set.id, input.durableTurnId,
          input.toolCallId, input.toolId, ordinal, input.toolId,
          humanize(input.toolId), new Date().toISOString(),
        );
      }
      this.#refreshSummary(set.id);
    });
    transaction.immediate();
  }

  #storePayload(workspaceId: string, row: EncodedRow | null): string | null {
    if (row === null) return null;
    const canonical = stableJson(row);
    const hash = createHash('sha256').update(canonical).digest('hex');
    const existing = this.#sqlite.prepare(
      'SELECT id FROM conversation_turn_change_payloads WHERE workspace_id = ? AND hash = ?',
    ).get(workspaceId, hash) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = randomUUID();
    this.#sqlite.prepare(`
      INSERT INTO conversation_turn_change_payloads
        (id, workspace_id, hash, encoding, payload, byte_length, created_at)
      VALUES (?, ?, ?, 'gzip-json', ?, ?, ?)
    `).run(
      id,
      workspaceId,
      hash,
      gzipSync(Buffer.from(canonical, 'utf8')).toString('base64'),
      Buffer.byteLength(canonical),
      new Date().toISOString(),
    );
    return id;
  }

  #refreshSummary(changeSetId: string): void {
    const local = this.#sqlite.prepare(`
      SELECT resource_kind, resource_id, resource_label, sensitive
      FROM conversation_turn_changes
      WHERE change_set_id = ? AND reversible = 1 AND external_effect = 0
      ORDER BY commit_ordinal ASC
    `).all(changeSetId) as Array<{
      resource_kind: string;
      resource_id: string;
      resource_label: string;
      sensitive: number;
    }>;
    const external = this.#sqlite.prepare(`
      SELECT COUNT(*) AS count FROM conversation_turn_changes
      WHERE change_set_id = ? AND external_effect = 1
    `).get(changeSetId) as { count: number };
    const unique = new Map<string, TurnChangeResourceSummary>();
    for (const row of local) {
      unique.set(`${row.resource_kind}:${row.resource_id}`, {
        kind: row.resource_kind,
        id: row.resource_id,
        label: row.resource_label,
        sensitive: Boolean(row.sensitive),
      });
    }
    const resources = [...unique.values()];
    this.#sqlite.prepare(`
      UPDATE conversation_turn_change_sets
      SET reversible_count = ?, sensitive_count = ?, external_effect_count = ?,
          affected_resources = ?, updated_at = ?
      WHERE id = ?
    `).run(
      resources.length,
      resources.filter((resource) => resource.sensitive).length,
      external.count,
      JSON.stringify(resources.slice(0, 50)),
      new Date().toISOString(),
      changeSetId,
    );
  }

  #ensureChangeSet(workspaceId: string, conversationId: string, turnId: string): void {
    this.#sqlite.prepare(`
      INSERT INTO conversation_turn_change_sets (
        id, workspace_id, conversation_id, turn_id, state, version,
        reversible_count, sensitive_count, external_effect_count,
        affected_resources, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'recording', 1, 0, 0, 0, '[]', ?, ?)
      ON CONFLICT(turn_id) DO NOTHING
    `).run(randomUUID(), workspaceId, conversationId, turnId, new Date().toISOString(), new Date().toISOString());
  }

  #requireSet(workspaceId: string, turnId: string): ChangeSetRow {
    const row = this.#sqlite.prepare(`
      SELECT id, workspace_id, conversation_id, turn_id, state, version,
             reversible_count, sensitive_count, external_effect_count,
             affected_resources, updated_at
      FROM conversation_turn_change_sets
      WHERE workspace_id = ? AND turn_id = ?
    `).get(workspaceId, turnId) as ChangeSetRow | undefined;
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', 'No reversible changes were recorded for this turn.');
    return row;
  }

  #snapshot(workspaceId: string): WorkspaceSnapshot {
    const snapshot: WorkspaceSnapshot = new Map();
    for (const meta of this.#tableMetadata()) {
      const rows = meta.name === 'workspaces'
        ? this.#sqlite.prepare('SELECT * FROM "workspaces" WHERE id = ?').all(workspaceId) as Record<string, SqlValue>[]
        : this.#sqlite.prepare(`SELECT * FROM ${quoteIdentifier(meta.name)} WHERE workspace_id = ?`).all(workspaceId) as Record<string, SqlValue>[];
      const byKey = new Map<string, EncodedRow>();
      for (const row of rows) {
        const encoded = encodeRow(row);
        byKey.set(stableJson(primaryKey(meta, encoded)), encoded);
      }
      snapshot.set(meta.name, { meta, rows: byKey });
    }
    return snapshot;
  }

  #table(name: string): TableMeta | null {
    return this.#tableMetadata().find((table) => table.name === name) ?? null;
  }

  #tableMetadata(): TableMeta[] {
    if (this.#tables) return this.#tables;
    const names = this.#sqlite.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    const preliminary: TableMeta[] = [];
    for (const { name } of names) {
      if (INTERNAL_TABLES.has(name) || VOLATILE_TABLES.has(name)) continue;
      const columns = this.#sqlite.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as ColumnInfo[];
      const columnNames = columns.map((column) => column.name);
      const workspaceScoped = columnNames.includes('workspace_id');
      if (!workspaceScoped && name !== 'workspaces') continue;
      const primaryKeyColumns = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
      if (primaryKeyColumns.length === 0) continue;
      const foreignKeys = this.#sqlite.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`).all() as ForeignKeyInfo[];
      preliminary.push({ name, columns: columnNames, primaryKey: primaryKeyColumns, workspaceScoped, foreignKeys, depth: 0 });
    }
    const byName = new Map(preliminary.map((table) => [table.name, table]));
    const depth = (table: TableMeta, seen = new Set<string>()): number => {
      if (table.depth > 0 || seen.has(table.name)) return table.depth;
      seen.add(table.name);
      table.depth = table.foreignKeys.reduce((max, fk) => {
        const parent = byName.get(fk.table);
        return parent ? Math.max(max, depth(parent, new Set(seen)) + 1) : max;
      }, 0);
      return table.depth;
    };
    preliminary.forEach((table) => depth(table));
    this.#tables = preliminary;
    return preliminary;
  }

  async #acquire(workspaceId: string): Promise<() => void> {
    const previous = this.#workspaceTails.get(workspaceId) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
    this.#workspaceTails.set(workspaceId, current);
    await previous;
    return () => {
      releaseCurrent();
      if (this.#workspaceTails.get(workspaceId) === current) this.#workspaceTails.delete(workspaceId);
    };
  }

  #publish(workspaceId: string, summary: TurnChangeSummary): void {
    this.#bus?.publish(
      REALTIME_ROOMS.workspace(workspaceId),
      REALTIME_EVENTS.CONVERSATION_TURN_CHANGES_UPDATED,
      { workspaceId, turnId: summary.turnId, changeSet: summary },
      `turn-changes:${summary.turnId}:${summary.version}`,
    );
  }
}

function diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): CapturedDiff[] {
  const diffs: CapturedDiff[] = [];
  for (const [table, beforeTable] of before) {
    const afterTable = after.get(table);
    if (!afterTable) continue;
    const keys = new Set([...beforeTable.rows.keys(), ...afterTable.rows.keys()]);
    for (const keyString of keys) {
      const prior = beforeTable.rows.get(keyString) ?? null;
      const next = afterTable.rows.get(keyString) ?? null;
      if (rowsEqual(prior, next)) continue;
      const key = JSON.parse(keyString) as Record<string, EncodedValue>;
      diffs.push({
        table,
        key,
        before: prior,
        after: next,
        operation: prior === null ? 'create' : next === null ? 'delete' : 'update',
        sensitive: SENSITIVE_TABLE.test(table),
        label: resourceLabel(table, key),
      });
    }
  }
  return diffs;
}

function applyWrites(sqlite: AgentisSqliteRaw, writes: PreparedWrite[]): void {
  const updates = writes.filter((write) => write.kind === 'update');
  const deletes = writes.filter((write) => write.kind === 'delete').sort((a, b) => b.meta.depth - a.meta.depth);
  const inserts = writes.filter((write) => write.kind === 'insert').sort((a, b) => a.meta.depth - b.meta.depth);
  for (const write of [...updates, ...deletes, ...inserts]) {
    const where = whereClause(write.key);
    if (write.kind === 'delete') {
      sqlite.prepare(`DELETE FROM ${quoteIdentifier(write.meta.name)} WHERE ${where.sql}`).run(...where.values);
      continue;
    }
    if (write.kind === 'insert') {
      const row = write.row!;
      const columns = Object.keys(row);
      sqlite.prepare(`INSERT INTO ${quoteIdentifier(write.meta.name)} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
        .run(...columns.map((column) => decodeValue(row[column]!)));
      continue;
    }
    const fields = write.fields ?? [];
    if (fields.length === 0) continue;
    sqlite.prepare(`UPDATE ${quoteIdentifier(write.meta.name)} SET ${fields.map((field) => `${quoteIdentifier(field)} = ?`).join(', ')} WHERE ${where.sql}`)
      .run(...fields.map((field) => decodeValue(write.row![field]!)), ...where.values);
  }
}

function readCurrent(sqlite: AgentisSqliteRaw, meta: TableMeta, key: Record<string, EncodedValue>): EncodedRow | null {
  const where = whereClause(key);
  const row = sqlite.prepare(`SELECT * FROM ${quoteIdentifier(meta.name)} WHERE ${where.sql}`).get(...where.values) as Record<string, SqlValue> | undefined;
  return row ? encodeRow(row) : null;
}

function whereClause(key: Record<string, EncodedValue>): { sql: string; values: SqlValue[] } {
  const entries = Object.entries(key);
  return {
    sql: entries.map(([column]) => `${quoteIdentifier(column)} = ?`).join(' AND '),
    values: entries.map(([, value]) => decodeValue(value)),
  };
}

function primaryKey(meta: TableMeta, row: EncodedRow): Record<string, EncodedValue> {
  return Object.fromEntries(meta.primaryKey.map((column) => [column, row[column]!]));
}

function encodeRow(row: Record<string, SqlValue>): EncodedRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, encodeValue(value)]));
}

function encodeValue(value: SqlValue): EncodedValue {
  if (Buffer.isBuffer(value)) return { $agentisBlob: value.toString('base64') };
  if (typeof value === 'bigint') return { $agentisBigInt: value.toString() };
  return value;
}

function decodeValue(value: EncodedValue): SqlValue {
  if (value && typeof value === 'object' && '$agentisBlob' in value) return Buffer.from(value.$agentisBlob, 'base64');
  if (value && typeof value === 'object' && '$agentisBigInt' in value) return BigInt(value.$agentisBigInt);
  return value;
}

function changedFields(source: EncodedRow, target: EncodedRow): string[] {
  return [...new Set([...Object.keys(source), ...Object.keys(target)])]
    .filter((field) => !IGNORED_UPDATE_FIELDS.has(field) && !valuesEqual(source[field], target[field]));
}

function differingFields(left: EncodedRow, right: EncodedRow): string[] {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((field) => !IGNORED_UPDATE_FIELDS.has(field) && !valuesEqual(left[field], right[field]));
}

function rowsEqual(left: EncodedRow | null, right: EncodedRow | null): boolean {
  if (left === null || right === null) return left === right;
  return differingFields(left, right).length === 0;
}

function valuesEqual(left: EncodedValue | undefined, right: EncodedValue | undefined): boolean {
  return stableJson(left ?? null) === stableJson(right ?? null);
}

function conflict(change: NetChange, fields: string[], reason: TurnChangeConflict['reason']): TurnChangeConflict {
  return {
    resourceKind: change.table,
    resourceId: change.resourceId,
    label: change.label,
    fields: fields.filter((field) => !SENSITIVE_TABLE.test(field)),
    reason,
  };
}

function toSummary(row: ChangeSetRow): TurnChangeSummary {
  let resources: TurnChangeResourceSummary[] = [];
  try {
    resources = JSON.parse(row.affected_resources) as TurnChangeResourceSummary[];
  } catch {
    resources = [];
  }
  return {
    turnId: row.turn_id,
    state: row.state,
    version: row.version,
    reversibleCount: row.reversible_count,
    sensitiveCount: row.sensitive_count,
    externalEffectCount: row.external_effect_count,
    affectedResources: resources,
    updatedAt: row.updated_at,
  };
}

function resourceLabel(table: string, key: Record<string, EncodedValue>): string {
  const id = Object.values(key).map((value) => typeof value === 'object' ? 'binary' : String(value)).join(' / ');
  return `${humanize(table)} · ${id}`;
}

function humanize(value: string): string {
  return value
    .replace(/^agentis\./, '')
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
