/**
 * AppDatastore — typed collection + record persistence (AGENTIC-APPS-10X §5).
 *
 * Records are validated against the collection's field schema on write. Queries
 * filter via SQLite json_extract over `data_json` (V1; a later pass projects
 * indexed fields into generated columns for scale). This is the App's
 * operational data store — distinct from the Brain, which handles memory.
 *
 * All methods are workspace-scoped and resolve the collection by (appId, name).
 */

import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import {
  AgentisError,
  collectionSchemaSchema,
  dataQuerySchema,
  type CollectionField,
  type CollectionInfo,
  type CollectionRecord,
  type CollectionSchema,
  type DataQuery,
  type DefineCollectionInput,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { z } from 'zod';

type CollectionRow = typeof schema.appCollections.$inferSelect;
type RecordRow = typeof schema.appRecords.$inferSelect;

/** Server-side aggregation request (masterplan 4.1) — drives Chart/DataBoard at scale. */
export interface AggregateInput {
  filter?: DataQuery['filter'];
  /** Field to group by (json field). Omitted = one total over all matching rows. */
  groupBy?: string;
  /** Aggregate operation. `count` needs no field; the others require `field`. */
  op: 'count' | 'sum' | 'avg' | 'min' | 'max';
  /** Numeric field for sum/avg/min/max. */
  field?: string;
  /** Max groups returned (default 100, cap 1000). */
  limit?: number;
}

export interface AggregateBucket {
  /** The group value (null when not grouped). */
  group: string | number | null;
  value: number;
}

const FILTER_OPS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in']);

export type DataChangeOp = 'insert' | 'update' | 'delete';

export class AppDatastore {
  /**
   * Optional realtime sink. `record` carries the changed row for insert/update so
   * bound views can apply a row-level DELTA in place (no full-query refetch);
   * delete and bulk changes omit it (delete needs only the id; bulk → refetch).
   */
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly onChange?: (args: { workspaceId: string; appId: string; collection: string; op: DataChangeOp; id: string; record?: CollectionRecord }) => void,
  ) {}

  // ── Collections ─────────────────────────────────────────────

  defineCollection(workspaceId: string, appId: string, input: DefineCollectionInput): CollectionInfo {
    this.requireApp(workspaceId, appId);
    const schemaParsed = collectionSchemaSchema.parse(input.schema);
    const now = new Date().toISOString();
    const existing = this.findCollectionRow(appId, input.name);
    if (existing) {
      this.db
        .update(schema.appCollections)
        .set({ schemaJson: schemaParsed, updatedAt: now })
        .where(eq(schema.appCollections.id, existing.id))
        .run();
      const info = this.toCollectionInfo({ ...existing, schemaJson: schemaParsed, updatedAt: now });
      this.rebuildCollectionIndex(workspaceId, appId, info.id, info.schema);
      return info;
    }
    const id = randomUUID();
    this.db
      .insert(schema.appCollections)
      .values({ id, appId, workspaceId, name: input.name, schemaJson: schemaParsed, createdAt: now, updatedAt: now })
      .run();
    return this.toCollectionInfo(this.findCollectionRow(appId, input.name)!);
  }

  listCollections(workspaceId: string, appId: string): CollectionInfo[] {
    this.requireApp(workspaceId, appId);
    const rows = this.db
      .select()
      .from(schema.appCollections)
      .where(eq(schema.appCollections.appId, appId))
      .orderBy(asc(schema.appCollections.name))
      .all();
    // One grouped count so the UI can show how many records live in each
    // collection (not the field count).
    const counts = this.db
      .select({ collectionId: schema.appRecords.collectionId, n: sql<number>`COUNT(*)` })
      .from(schema.appRecords)
      .where(eq(schema.appRecords.appId, appId))
      .groupBy(schema.appRecords.collectionId)
      .all();
    const countBy = new Map(counts.map((c) => [c.collectionId, Number(c.n)]));
    return rows.map((r) => ({ ...this.toCollectionInfo(r), recordCount: countBy.get(r.id) ?? 0 }));
  }

  // ── Records ─────────────────────────────────────────────────

  insert(workspaceId: string, appId: string, collection: string, record: Record<string, unknown>, userId?: string): CollectionRecord {
    const col = this.requireCollection(workspaceId, appId, collection);
    const data = this.recordValidator(col.schema).parse(record);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .insert(schema.appRecords)
      .values({ id, collectionId: col.id, appId, workspaceId, dataJson: data, version: 1, createdBy: userId ?? null, createdAt: now, updatedAt: now })
      .run();
    this.writeIndexEntries(workspaceId, appId, col.id, id, col.schema, data);
    const saved = this.getRecord(workspaceId, appId, collection, id);
    this.onChange?.({ workspaceId, appId, collection, op: 'insert', id, record: saved });
    return saved;
  }

  update(workspaceId: string, appId: string, collection: string, id: string, patch: Record<string, unknown>): CollectionRecord {
    const col = this.requireCollection(workspaceId, appId, collection);
    const current = this.getRecord(workspaceId, appId, collection, id);
    const merged = { ...current.data, ...patch };
    const data = this.recordValidator(col.schema).parse(merged);
    const now = new Date().toISOString();
    this.db
      .update(schema.appRecords)
      .set({ dataJson: data, version: current.version + 1, updatedAt: now })
      .where(eq(schema.appRecords.id, id))
      .run();
    this.deleteIndexEntries(col.id, id);
    this.writeIndexEntries(workspaceId, appId, col.id, id, col.schema, data);
    const saved = this.getRecord(workspaceId, appId, collection, id);
    this.onChange?.({ workspaceId, appId, collection, op: 'update', id, record: saved });
    return saved;
  }

  upsert(workspaceId: string, appId: string, collection: string, match: Record<string, unknown>, record: Record<string, unknown>, userId?: string): CollectionRecord {
    const existing = this.query(workspaceId, appId, collection, { filter: match as DataQuery['filter'], limit: 1 }).rows[0];
    if (existing) return this.update(workspaceId, appId, collection, existing.id, record);
    return this.insert(workspaceId, appId, collection, { ...match, ...record }, userId);
  }

  /**
   * Validate and apply an insert/upsert batch atomically. The batch is rejected
   * before the transaction starts when any row is invalid, so callers never
   * receive a partial-success receipt for a deterministic datastore mutation.
   */
  mutateMany(
    workspaceId: string,
    appId: string,
    collection: string,
    operation: 'insert' | 'upsert',
    records: Record<string, unknown>[],
    matchFields: string[] = [],
    userId?: string,
  ): CollectionRecord[] {
    if (records.length < 1 || records.length > 1000) {
      throw new AgentisError('VALIDATION_FAILED', 'data mutation batch must contain between 1 and 1000 records');
    }
    const col = this.requireCollection(workspaceId, appId, collection);
    const validate = this.recordValidator(col.schema);
    const prepared = records.map((record) => validate.parse(record));
    const normalizedMatchFields = [...new Set(matchFields.map((field) => field.trim()).filter(Boolean))];
    if (operation === 'upsert' && normalizedMatchFields.length === 0) {
      throw new AgentisError('VALIDATION_FAILED', 'batch upsert requires at least one match field');
    }
    if (operation === 'upsert') {
      for (let index = 0; index < prepared.length; index += 1) {
        for (const field of normalizedMatchFields) {
          if (!(field in prepared[index]!)) {
            throw new AgentisError('VALIDATION_FAILED', `batch upsert record ${index} is missing match field '${field}'`);
          }
        }
      }
    }

    return this.db.transaction(() => prepared.map((record) => {
      if (operation === 'insert') return this.insert(workspaceId, appId, collection, record, userId);
      const match = Object.fromEntries(normalizedMatchFields.map((field) => [field, record[field]]));
      return this.upsert(workspaceId, appId, collection, match, record, userId);
    }));
  }

  delete(workspaceId: string, appId: string, collection: string, id: string): void {
    const col = this.requireCollection(workspaceId, appId, collection);
    this.deleteIndexEntries(col.id, id);
    this.db.delete(schema.appRecords).where(and(eq(schema.appRecords.id, id), eq(schema.appRecords.collectionId, col.id))).run();
    this.onChange?.({ workspaceId, appId, collection, op: 'delete', id });
  }

  getRecord(workspaceId: string, appId: string, collection: string, id: string): CollectionRecord {
    const col = this.requireCollection(workspaceId, appId, collection);
    const row = this.db
      .select()
      .from(schema.appRecords)
      .where(and(eq(schema.appRecords.id, id), eq(schema.appRecords.collectionId, col.id)))
      .get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `record not found: ${id}`);
    return this.toRecord(row, col.name);
  }

  query(workspaceId: string, appId: string, collection: string, q: DataQuery): { rows: CollectionRecord[]; nextCursor?: string } {
    const col = this.requireCollection(workspaceId, appId, collection);
    const query = dataQuerySchema.parse(q);
    const conditions: SQL[] = [eq(schema.appRecords.collectionId, col.id)];
    const indexedCondition = this.indexedCondition(col, query.filter ?? {});
    if (indexedCondition) conditions.push(indexedCondition);
    for (const [key, raw] of Object.entries(query.filter ?? {})) {
      conditions.push(this.filterCondition(key, raw));
    }
    // Keyset pagination (masterplan 4.1): order by the requested sort (or
    // updatedAt desc) plus a stable `id asc` tiebreaker, and seek past the
    // cursor's row values. Unlike the old offset cursor this is O(log n) and
    // never skips/duplicates rows when the collection is written concurrently.
    const sortKeys = this.#sortKeys(query.sort);
    const cursorValues = this.#decodeKeysetCursor(query.cursor);
    if (cursorValues && cursorValues.length === sortKeys.length) {
      conditions.push(this.#keysetPredicate(sortKeys, cursorValues));
    }
    const orderExprs = sortKeys.map((k) => (k.dir === 'desc' ? desc(k.expr) : asc(k.expr)));
    const rows = this.db
      .select()
      .from(schema.appRecords)
      .where(and(...conditions))
      .orderBy(...orderExprs)
      .limit(query.limit + 1)
      .all();
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    let nextCursor: string | undefined;
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1]!;
      nextCursor = this.#encodeKeysetCursor(sortKeys.map((k) => k.read(last)));
    }
    return {
      rows: page.map((r) => this.toRecord(r, col.name)),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  /**
   * Read every record's `data` for a collection (bounded by `cap`), for export.
   * Loops the keyset `query` so it never skips/duplicates rows. Returns bare data
   * objects (no id/version) — the shape `manifestCollectionSchema.seed` expects —
   * and a `truncated` flag when the collection exceeds `cap`.
   */
  exportRows(workspaceId: string, appId: string, collection: string, cap = 5000): { rows: Record<string, unknown>[]; truncated: boolean } {
    const out: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    let truncated = false;
    for (;;) {
      const remaining = cap - out.length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const page = this.query(workspaceId, appId, collection, { limit: Math.min(500, remaining), ...(cursor ? { cursor } : {}) });
      for (const r of page.rows) out.push(r.data);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return { rows: out, truncated };
  }

  /** Full-fidelity export used by machine-to-machine packages. */
  exportRecords(workspaceId: string, appId: string, collection: string, cap = 5000) {
    const col = this.requireCollection(workspaceId, appId, collection);
    const rows = this.db.select().from(schema.appRecords)
      .where(and(eq(schema.appRecords.workspaceId, workspaceId), eq(schema.appRecords.collectionId, col.id)))
      .orderBy(asc(schema.appRecords.createdAt), asc(schema.appRecords.id))
      .limit(cap + 1).all();
    return {
      records: rows.slice(0, cap).map((row) => ({
        id: row.id,
        data: (row.dataJson ?? {}) as Record<string, unknown>,
        version: row.version,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
      truncated: rows.length > cap,
    };
  }

  /** Restore full-fidelity row envelopes while rebuilding target-side indexes. */
  importRecords(
    workspaceId: string,
    appId: string,
    collection: string,
    records: Array<{ id: string; data: Record<string, unknown>; version: number; createdBy: string | null; createdAt: string; updatedAt: string }>,
  ): { inserted: number; failed: Array<{ index: number; error: string }> } {
    const col = this.requireCollection(workspaceId, appId, collection);
    const validate = this.recordValidator(col.schema);
    let inserted = 0;
    const failed: Array<{ index: number; error: string }> = [];
    for (let index = 0; index < records.length; index += 1) {
      try {
        const record = records[index]!;
        const data = validate.parse(record.data);
        this.db.insert(schema.appRecords).values({
          id: record.id,
          collectionId: col.id,
          appId,
          workspaceId,
          dataJson: data,
          version: record.version,
          createdBy: record.createdBy,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        }).run();
        this.writeIndexEntries(workspaceId, appId, col.id, record.id, col.schema, data);
        inserted += 1;
      } catch (err) {
        failed.push({ index, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (inserted > 0) this.onChange?.({ workspaceId, appId, collection, op: 'insert', id: 'bulk' });
    return { inserted, failed };
  }

  /**
   * Bulk-insert records (import / seed). Validates each row against the schema,
   * writes its index entries, and skips (collecting) rows that fail rather than
   * aborting the whole batch. Fires a SINGLE realtime change so a large import is
   * one refetch, not N. Returns the count inserted and the per-row failures.
   */
  insertMany(
    workspaceId: string,
    appId: string,
    collection: string,
    records: Record<string, unknown>[],
    userId?: string,
  ): { inserted: number; failed: Array<{ index: number; error: string }> } {
    const col = this.requireCollection(workspaceId, appId, collection);
    const validate = this.recordValidator(col.schema);
    const now = new Date().toISOString();
    let inserted = 0;
    const failed: Array<{ index: number; error: string }> = [];
    for (let i = 0; i < records.length; i += 1) {
      try {
        const data = validate.parse(records[i]);
        const id = randomUUID();
        this.db
          .insert(schema.appRecords)
          .values({ id, collectionId: col.id, appId, workspaceId, dataJson: data, version: 1, createdBy: userId ?? null, createdAt: now, updatedAt: now })
          .run();
        this.writeIndexEntries(workspaceId, appId, col.id, id, col.schema, data);
        inserted += 1;
      } catch (err) {
        failed.push({ index: i, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (inserted > 0) this.onChange?.({ workspaceId, appId, collection, op: 'insert', id: 'bulk' });
    return { inserted, failed };
  }

  /** Sort keys for keyset pagination: requested fields (or updatedAt desc) + id asc tiebreaker. */
  #sortKeys(sort: DataQuery['sort']): Array<{ expr: SQLWrapper; dir: 'asc' | 'desc'; read: (row: RecordRow) => unknown }> {
    const keys: Array<{ expr: SQLWrapper; dir: 'asc' | 'desc'; read: (row: RecordRow) => unknown }> = [];
    if (sort && sort.length > 0) {
      for (const s of sort) {
        keys.push({ expr: this.jsonPath(s.field), dir: s.dir, read: (row) => (row.dataJson as Record<string, unknown> | null)?.[s.field] ?? null });
      }
    } else {
      keys.push({ expr: schema.appRecords.updatedAt, dir: 'desc', read: (row) => row.updatedAt });
    }
    keys.push({ expr: schema.appRecords.id, dir: 'asc', read: (row) => row.id });
    return keys;
  }

  /** Lexicographic keyset predicate: rows strictly after the cursor in sort order. */
  #keysetPredicate(keys: Array<{ expr: SQLWrapper; dir: 'asc' | 'desc' }>, values: unknown[]): SQL {
    const build = (i: number): SQL => {
      const key = keys[i]!;
      const value = this.scalar(values[i]);
      const cmp = key.dir === 'asc' ? sql`${key.expr} > ${value}` : sql`${key.expr} < ${value}`;
      if (i === keys.length - 1) return cmp;
      return sql`(${cmp} OR (${key.expr} = ${value} AND ${build(i + 1)}))`;
    };
    return build(0);
  }

  #encodeKeysetCursor(values: unknown[]): string {
    return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
  }

  #decodeKeysetCursor(cursor: string | undefined): unknown[] | null {
    if (!cursor) return null;
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Server-side aggregation (count/sum/avg/min/max, optional group-by) over a
   * collection. Replaces client-side grouping of a capped fetch — Charts and
   * DataBoards are now correct over the full collection, not just the first page.
   */
  aggregate(workspaceId: string, appId: string, collection: string, input: AggregateInput): AggregateBucket[] {
    const col = this.requireCollection(workspaceId, appId, collection);
    if (input.op !== 'count' && !input.field) {
      throw new AgentisError('VALIDATION_FAILED', `aggregate op '${input.op}' requires a field`);
    }
    const conditions: SQL[] = [eq(schema.appRecords.collectionId, col.id)];
    const indexedCondition = this.indexedCondition(col, input.filter ?? {});
    if (indexedCondition) conditions.push(indexedCondition);
    for (const [key, raw] of Object.entries(input.filter ?? {})) {
      conditions.push(this.filterCondition(key, raw));
    }

    const num = input.field ? sql`CAST(${this.jsonPath(input.field)} AS REAL)` : sql`0`;
    const valueSql: SQL<number> =
      input.op === 'count' ? sql<number>`COUNT(*)`
        : input.op === 'sum' ? sql<number>`COALESCE(SUM(${num}), 0)`
          : input.op === 'avg' ? sql<number>`AVG(${num})`
            : input.op === 'min' ? sql<number>`MIN(${num})`
              : sql<number>`MAX(${num})`;

    if (input.groupBy) {
      const grpExpr = this.jsonPath(input.groupBy);
      const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
      const rows = this.db
        .select({ grp: grpExpr, value: valueSql })
        .from(schema.appRecords)
        .where(and(...conditions))
        .groupBy(grpExpr)
        .orderBy(desc(valueSql))
        .limit(limit)
        .all();
      return rows.map((r) => ({ group: normalizeGroup(r.grp), value: Number(r.value ?? 0) }));
    }

    const row = this.db
      .select({ value: valueSql })
      .from(schema.appRecords)
      .where(and(...conditions))
      .get();
    return [{ group: null, value: Number(row?.value ?? 0) }];
  }


  private requireApp(workspaceId: string, appId: string): void {
    const row = this.db
      .select({ id: schema.apps.id })
      .from(schema.apps)
      .where(and(eq(schema.apps.workspaceId, workspaceId), eq(schema.apps.id, appId)))
      .get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `app not found: ${appId}`);
  }

  private findCollectionRow(appId: string, name: string): CollectionRow | undefined {
    return this.db
      .select()
      .from(schema.appCollections)
      .where(and(eq(schema.appCollections.appId, appId), eq(schema.appCollections.name, name)))
      .get();
  }

  private requireCollection(workspaceId: string, appId: string, name: string): { id: string; name: string; schema: CollectionSchema } {
    this.requireApp(workspaceId, appId);
    const row = this.findCollectionRow(appId, name);
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `collection not found: ${name}`);
    return { id: row.id, name: row.name, schema: collectionSchemaSchema.parse(row.schemaJson) };
  }

  /** Build a zod validator from the field DSL. Unknown keys pass through untyped. */
  private recordValidator(collectionSchema: CollectionSchema): z.ZodType<Record<string, unknown>> {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const field of collectionSchema.fields) {
      let base: z.ZodTypeAny;
      switch (field.type) {
        case 'string':
        case 'date':
          base = z.string();
          break;
        case 'number':
          base = z.number();
          break;
        case 'boolean':
          base = z.boolean();
          break;
        default:
          base = z.unknown();
      }
      shape[field.key] = field.required ? base : base.optional();
    }
    const object = collectionSchema.strict ? z.object(shape).strict() : z.object(shape).passthrough();
    return object as unknown as z.ZodType<Record<string, unknown>>;
  }

  private jsonPath(field: CollectionField['key']): SQL<unknown> {
    return sql`json_extract(${schema.appRecords.dataJson}, ${'$.' + field})`;
  }

  private indexedCondition(col: { id: string; schema: CollectionSchema }, filter: NonNullable<DataQuery['filter']>): SQL | null {
    const indexed = new Set(col.schema.fields.filter((field) => field.indexed).map((field) => field.key));
    for (const [key, raw] of Object.entries(filter)) {
      if (!indexed.has(key)) continue;
      const values = indexedLookupValues(raw);
      if (!values) continue;
      return sql`${schema.appRecords.id} IN (
        SELECT ${schema.appRecordIndex.recordId}
        FROM ${schema.appRecordIndex}
        WHERE ${schema.appRecordIndex.collectionId} = ${col.id}
          AND ${schema.appRecordIndex.fieldKey} = ${key}
          AND ${indexedValuePredicate(values)}
      )`;
    }
    return null;
  }

  private filterCondition(key: string, raw: unknown): SQL {
    const path = this.jsonPath(key);
    if (raw !== null && typeof raw === 'object' && 'op' in (raw as object)) {
      const { op, value } = raw as { op: string; value: unknown };
      if (!FILTER_OPS.has(op)) throw new AgentisError('VALIDATION_FAILED', `unknown filter op: ${op}`);
      switch (op) {
        case 'eq':
          return sql`${path} = ${this.scalar(value)}`;
        case 'ne':
          return sql`${path} != ${this.scalar(value)}`;
        case 'gt':
          return sql`${path} > ${this.scalar(value)}`;
        case 'gte':
          return sql`${path} >= ${this.scalar(value)}`;
        case 'lt':
          return sql`${path} < ${this.scalar(value)}`;
        case 'lte':
          return sql`${path} <= ${this.scalar(value)}`;
        case 'contains':
          return sql`${path} LIKE ${'%' + String(value) + '%'}`;
        case 'in': {
          const arr = Array.isArray(value) ? value : [value];
          if (arr.length === 0) return sql`1 = 0`;
          return sql`${path} IN (${sql.join(arr.map((v) => sql`${this.scalar(v)}`), sql`, `)})`;
        }
        default:
          throw new AgentisError('VALIDATION_FAILED', `unknown filter op: ${op}`);
      }
    }
    // Bare value → equality.
    return sql`${path} = ${this.scalar(raw)}`;
  }

  /** Coerce a JS value to a json_extract-comparable scalar (booleans become 0/1 as SQLite stores them). */
  private scalar(value: unknown): string | number {
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number') return value;
    return String(value);
  }

  private toCollectionInfo(row: CollectionRow): CollectionInfo {
    return {
      id: row.id,
      appId: row.appId,
      name: row.name,
      schema: collectionSchemaSchema.parse(row.schemaJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toRecord(row: RecordRow, collectionName: string): CollectionRecord {
    return {
      id: row.id,
      appId: row.appId,
      collectionId: row.collectionId,
      name: collectionName,
      data: (row.dataJson ?? {}) as Record<string, unknown>,
      version: row.version,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private rebuildCollectionIndex(workspaceId: string, appId: string, collectionId: string, collectionSchema: CollectionSchema): void {
    this.db.delete(schema.appRecordIndex).where(eq(schema.appRecordIndex.collectionId, collectionId)).run();
    const rows = this.db
      .select()
      .from(schema.appRecords)
      .where(and(eq(schema.appRecords.workspaceId, workspaceId), eq(schema.appRecords.appId, appId), eq(schema.appRecords.collectionId, collectionId)))
      .all();
    for (const row of rows) {
      this.writeIndexEntries(workspaceId, appId, collectionId, row.id, collectionSchema, (row.dataJson ?? {}) as Record<string, unknown>);
    }
  }

  private deleteIndexEntries(collectionId: string, recordId: string): void {
    this.db
      .delete(schema.appRecordIndex)
      .where(and(eq(schema.appRecordIndex.collectionId, collectionId), eq(schema.appRecordIndex.recordId, recordId)))
      .run();
  }

  private writeIndexEntries(
    workspaceId: string,
    appId: string,
    collectionId: string,
    recordId: string,
    collectionSchema: CollectionSchema,
    data: Record<string, unknown>,
  ): void {
    for (const field of collectionSchema.fields) {
      if (!field.indexed) continue;
      const value = data[field.key];
      if (!isIndexableScalar(value)) continue;
      this.db
        .insert(schema.appRecordIndex)
        .values({
          workspaceId,
          appId,
          collectionId,
          recordId,
          fieldKey: field.key,
          ...indexValueColumns(value),
        })
        .run();
    }
  }
}

function normalizeGroup(raw: unknown): string | number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' || typeof raw === 'string') return raw;
  return String(raw);
}

function indexedLookupValues(raw: unknown): unknown[] | null {
  if (raw !== null && typeof raw === 'object' && 'op' in (raw as object)) {
    const { op, value } = raw as { op: string; value: unknown };
    if (op === 'eq') return [value];
    if (op === 'in') return Array.isArray(value) ? value : [value];
    return null;
  }
  return [raw];
}

function indexedValuePredicate(values: unknown[]): SQL {
  const clauses = values.filter(isIndexableScalar).map((value) => {
    if (typeof value === 'number') return sql`${schema.appRecordIndex.valueNumber} = ${value}`;
    // better-sqlite3 cannot bind a raw boolean ("can only bind numbers, strings,
    // bigints, buffers, and null"); the index column stores 0/1, so bind 0/1.
    if (typeof value === 'boolean') return sql`${schema.appRecordIndex.valueBoolean} = ${value ? 1 : 0}`;
    return sql`${schema.appRecordIndex.valueText} = ${String(value)}`;
  });
  if (clauses.length === 0) return sql`1 = 0`;
  return sql.join(clauses.map((clause) => sql`(${clause})`), sql` OR `);
}

function isIndexableScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function indexValueColumns(value: string | number | boolean): {
  valueText: string | null;
  valueNumber: number | null;
  valueBoolean: boolean | null;
} {
  if (typeof value === 'number') return { valueText: null, valueNumber: value, valueBoolean: null };
  if (typeof value === 'boolean') return { valueText: null, valueNumber: null, valueBoolean: value };
  return { valueText: value, valueNumber: null, valueBoolean: null };
}



