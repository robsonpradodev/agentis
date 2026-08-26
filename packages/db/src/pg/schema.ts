/**
 * Postgres dialect — Agentis standard mode.
 *
 * Activated when AGENTIS_DATABASE_URL is set. Uses the `postgres` driver +
 * Drizzle's pg-core dialect. Schema mirrors the SQLite version with native
 * types (`uuid`, `jsonb`, `timestamptz`, `boolean`).
 *
 * NOTE: Standard mode is opt-in. Embedded mode is the default for V1
 * (V1-SPEC §3.1). This module is loaded lazily by db/factory.ts only when
 * AGENTIS_DATABASE_URL is present, so the SQLite-only path doesn't pull in
 * `postgres` at runtime.
 */

import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  integer,
  boolean,
  bigint,
  real,
  primaryKey,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

const baseTimestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: varchar('username', { length: 64 }).notNull().unique(),
  email: text('email'),
  displayName: varchar('display_name', { length: 100 }).notNull(),
  passwordHash: text('password_hash').notNull(),
  isAdmin: boolean('is_admin').notNull().default(true),
  ...baseTimestamps(),
});

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  slug: varchar('slug', { length: 120 }).notNull(),
  description: text('description'),
  imageUrl: text('image_url'),
  defaultAmbientId: uuid('default_ambient_id'),
  ...baseTimestamps(),
});

export const ambients = pgTable('ambients', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  kind: text('kind').notNull().default('local'),
  settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
  ...baseTimestamps(),
});

// The remaining tables follow the same name-and-shape mapping as
// sqlite/schema.ts. They are stubbed here for parity; flesh out as standard
// mode is exercised. Embedded mode is the V1 launch path (V1-SPEC §3.1).
//
// DEBT: full PG schema parity. Triggered when:

export const workflows = pgTable('workflows', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: uuid('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  hubEntryId: text('hub_entry_id'),
  hubVersion: text('hub_version'),
  /** Agentic App that owns this workflow (AGENTIC-APPS-10X §3). Null = bare workflow. */
  appId: uuid('app_id').references(() => apps.id, { onDelete: 'set null' }),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  graph: jsonb('graph').notNull(),
  contentHash: text('content_hash'),
  activeRevisionId: uuid('active_revision_id'),
  candidateRevisionId: uuid('candidate_revision_id'),
  trustState: text('trust_state').notNull().default('legacy_unverified'),
  settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
  isPublishedToHub: boolean('is_published_to_hub').notNull().default(false),
  ...baseTimestamps(),
});

// ── Agentic Apps (AGENTIC-APPS-10X-MASTERPLAN §3/§4/§5) ──────────────────────
// Mirrored here on creation per §10.4 ("every new table ships on both paths").
// The wider ~40-table PG parity remains deferred debt (see note above); these
// are PG-portable by design — the only non-portable bit is the AppDatastore's

export const apps = pgTable('apps', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  slug: varchar('slug', { length: 120 }).notNull(),
  name: varchar('name', { length: 160 }).notNull(),
  description: text('description').notNull().default(''),
  version: varchar('version', { length: 64 }).notNull().default('0.1.0'),
  status: text('status').notNull().default('draft'),
  entrySurfaceId: text('entry_surface_id'),
  activeInterfaceRevisionId: uuid('active_interface_revision_id'),
  candidateInterfaceRevisionId: uuid('candidate_interface_revision_id'),
  interfaceTrustState: text('interface_trust_state').notNull().default('legacy_unverified'),
  icon: text('icon'),
  // Org placement (workflows inherit). FK targets live in the wider deferred PG
  // parity set, so these are plain uuids in the stub (enforced in SQLite).
  domainId: uuid('domain_id'),
  ownerAgentId: uuid('owner_agent_id'),
  manifestJson: jsonb('manifest_json').notNull().default(sql`'{}'::jsonb`),
  policyJson: jsonb('policy_json').notNull().default(sql`'{}'::jsonb`),
  sourceJson: jsonb('source_json'),
  installedChecksum: text('installed_checksum'),
  createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  ...baseTimestamps(),
});

export const appMembers = pgTable('app_members', {
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').notNull(),
  role: text('role').notNull().default('worker'),
});

export const appCollections = pgTable('app_collections', {
  id: uuid('id').primaryKey().defaultRandom(),
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 64 }).notNull(),
  schemaJson: jsonb('schema_json').notNull(),
  policyJson: jsonb('policy_json').notNull().default(sql`'{}'::jsonb`),
  ...baseTimestamps(),
});

export const appRecords = pgTable('app_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  collectionId: uuid('collection_id').notNull().references(() => appCollections.id, { onDelete: 'cascade' }),
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  dataJson: jsonb('data_json').notNull().default(sql`'{}'::jsonb`),
  version: integer('version').notNull().default(1),
  createdBy: text('created_by'),
  ...baseTimestamps(),
});

export const appRecordIndex = pgTable('app_record_index', {
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  collectionId: uuid('collection_id').notNull().references(() => appCollections.id, { onDelete: 'cascade' }),
  recordId: uuid('record_id').notNull().references(() => appRecords.id, { onDelete: 'cascade' }),
  fieldKey: varchar('field_key', { length: 64 }).notNull(),
  valueText: text('value_text'),
  valueNumber: real('value_number'),
  valueBoolean: boolean('value_boolean'),
}, (table) => ({
  pk: primaryKey({ columns: [table.collectionId, table.recordId, table.fieldKey] }),
  lookupText: index('idx_app_record_index_text').on(table.collectionId, table.fieldKey, table.valueText),
  lookupNumber: index('idx_app_record_index_number').on(table.collectionId, table.fieldKey, table.valueNumber),
  lookupBoolean: index('idx_app_record_index_boolean').on(table.collectionId, table.fieldKey, table.valueBoolean),
}));

export const appSurfaces = pgTable('app_surfaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 120 }).notNull(),
  kind: text('kind').notNull().default('page'),
  viewJson: jsonb('view_json'),
  actionsJson: jsonb('actions_json').notNull().default(sql`'[]'::jsonb`),
  shareable: boolean('shareable').notNull().default(false),
  revision: integer('revision').notNull().default(0),
  ...baseTimestamps(),
});

export const appBlueprints = pgTable('app_blueprints', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  appId: uuid('app_id').references(() => apps.id, { onDelete: 'set null' }),
  semanticKey: text('semantic_key').notNull(),
  name: text('name').notNull(),
  intent: text('intent').notNull(),
  revision: integer('revision').notNull().default(1),
  status: text('status').notNull().default('draft'),
  topology: jsonb('topology_json').notNull().default(sql`'{}'::jsonb`),
  acceptanceCriteria: jsonb('acceptance_json').notNull().default(sql`'[]'::jsonb`),
  validation: jsonb('validation_json').notNull().default(sql`'{"valid":false,"issues":[]}'::jsonb`),
  createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  ...baseTimestamps(),
}, (table) => ({
  semanticRevision: uniqueIndex('uq_app_blueprints_semantic_revision').on(table.workspaceId, table.semanticKey, table.revision),
  byApp: index('idx_app_blueprints_app').on(table.workspaceId, table.appId, table.updatedAt),
}));

export const buildSessions = pgTable('build_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  blueprintId: uuid('blueprint_id').notNull().references(() => appBlueprints.id, { onDelete: 'cascade' }),
  appId: uuid('app_id').references(() => apps.id, { onDelete: 'set null' }),
  conversationId: uuid('conversation_id'),
  ownerAgentId: uuid('owner_agent_id'),
  stage: text('stage').notNull().default('discover'),
  status: text('status').notNull().default('running'),
  snapshot: jsonb('snapshot_json').notNull().default(sql`'{}'::jsonb`),
  evidence: jsonb('evidence_json').notNull().default(sql`'[]'::jsonb`),
  diagnostic: jsonb('diagnostic_json'),
  repairAttempts: integer('repair_attempts').notNull().default(0),
  createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  ...baseTimestamps(),
}, (table) => ({
  byWorkspace: index('idx_build_sessions_workspace').on(table.workspaceId, table.updatedAt),
  byApp: index('idx_build_sessions_app').on(table.workspaceId, table.appId, table.updatedAt),
  byConversation: index('idx_build_sessions_conversation').on(table.workspaceId, table.conversationId, table.updatedAt),
}));

export const appInterfaceRevisions = pgTable('app_interface_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  parentRevisionId: uuid('parent_revision_id'),
  pagesJson: jsonb('pages_json').notNull().default(sql`'[]'::jsonb`),
  semanticHash: text('semantic_hash').notNull(),
  source: text('source').notNull().default('operator'),
  actorType: text('actor_type').notNull().default('user'),
  actorId: text('actor_id'),
  reason: text('reason').notNull().default('Interface update'),
  status: text('status').notNull().default('candidate'),
  trustState: text('trust_state').notNull().default('candidate'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  rejectedAt: timestamp('rejected_at', { withTimezone: true }),
  ...baseTimestamps(),
}, (table) => ({
  byApp: index('idx_app_interface_revisions_app').on(table.workspaceId, table.appId, table.createdAt),
  appHash: index('idx_app_interface_revisions_hash').on(table.appId, table.semanticHash),
}));

export const appInterfaceProofs = pgTable('app_interface_proofs', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  revisionId: uuid('revision_id').notNull().references(() => appInterfaceRevisions.id, { onDelete: 'cascade' }),
  gate: text('gate').notNull(),
  status: text('status').notNull(),
  semanticHash: text('semantic_hash').notNull(),
  evidenceJson: jsonb('evidence_json').notNull().default(sql`'{}'::jsonb`),
  ...baseTimestamps(),
}, (table) => ({
  revisionGate: uniqueIndex('uq_app_interface_proof_gate').on(table.revisionId, table.gate),
  byRevision: index('idx_app_interface_proofs_revision').on(table.revisionId, table.status),
}));

export const appLifecycleSnapshots = pgTable('app_lifecycle_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  version: varchar('version', { length: 64 }).notNull(),
  manifestJson: jsonb('manifest_json').notNull(),
  installedChecksum: text('installed_checksum'),
  collectionsJson: jsonb('collections_json').notNull().default(sql`'[]'::jsonb`),
  reason: text('reason').notNull().default('upgrade'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const appEnvironments = pgTable('app_environments', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 64 }).notNull(),
  kind: text('kind').notNull().default('dev'),
  manifestJson: jsonb('manifest_json').notNull(),
  sourceEnvironmentId: uuid('source_environment_id'),
  promotedAt: timestamp('promoted_at', { withTimezone: true }),
  createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  appName: uniqueIndex('idx_app_environments_app_name').on(table.workspaceId, table.appId, table.name),
  byApp: index('idx_app_environments_app').on(table.workspaceId, table.appId, table.kind),
}));

export const workflowGraphRevisions = pgTable('workflow_graph_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  workflowId: uuid('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  parentRevisionId: uuid('parent_revision_id'),
  graphJson: jsonb('graph_json').notNull(),
  semanticHash: text('semantic_hash').notNull(),
  presentationHash: text('presentation_hash').notNull(),
  source: text('source').notNull(),
  actorType: text('actor_type').notNull().default('system'),
  actorId: text('actor_id'),
  reason: text('reason').notNull().default(''),
  changeSummaryJson: jsonb('change_summary_json').notNull().default(sql`'{}'::jsonb`),
  specJson: jsonb('spec_json'),
  capabilityManifestJson: jsonb('capability_manifest_json').notNull().default(sql`'{}'::jsonb`),
  proofProfile: text('proof_profile').notNull().default('standard'),
  status: text('status').notNull().default('candidate'),
  trustState: text('trust_state').notNull().default('unverified'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  promotedAt: timestamp('promoted_at', { withTimezone: true }),
  rejectedAt: timestamp('rejected_at', { withTimezone: true }),
  ...baseTimestamps(),
}, (table) => ({
  workflowCreated: index('idx_workflow_graph_revisions_workflow').on(table.workspaceId, table.workflowId, table.createdAt),
  workflowHash: index('idx_workflow_graph_revisions_hash').on(table.workspaceId, table.workflowId, table.semanticHash),
  workflowStatus: index('idx_workflow_graph_revisions_status').on(table.workspaceId, table.workflowId, table.status),
}));

export const workflowRevisionProofs = pgTable('workflow_revision_proofs', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  workflowId: uuid('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  revisionId: uuid('revision_id').notNull().references(() => workflowGraphRevisions.id, { onDelete: 'cascade' }),
  gate: text('gate').notNull(),
  status: text('status').notNull(),
  semanticHash: text('semantic_hash').notNull(),
  fixtureKey: text('fixture_key').notNull().default('default'),
  runId: uuid('run_id'),
  capabilityCatalogVersion: text('capability_catalog_version'),
  evidenceJson: jsonb('evidence_json').notNull().default(sql`'{}'::jsonb`),
  ...baseTimestamps(),
}, (table) => ({
  revisionGate: uniqueIndex('uq_workflow_revision_proof_gate').on(table.revisionId, table.gate, table.fixtureKey),
  revisionStatus: index('idx_workflow_revision_proofs_status').on(table.revisionId, table.status),
}));

export const workflowExperiences = pgTable('workflow_experiences', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  workflowId: uuid('workflow_id').references(() => workflows.id, { onDelete: 'cascade' }),
  appId: uuid('app_id').references(() => apps.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id'),
  revisionId: uuid('revision_id').references(() => workflowGraphRevisions.id, { onDelete: 'set null' }),
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
  preconditionsJson: jsonb('preconditions_json').notNull().default(sql`'{}'::jsonb`),
  regressionFixtureJson: jsonb('regression_fixture_json'),
  evidenceJson: jsonb('evidence_json').notNull().default(sql`'{}'::jsonb`),
  confidence: real('confidence').notNull().default(0),
  successCount: integer('success_count').notNull().default(0),
  supersedesId: uuid('supersedes_id'),
  ...baseTimestamps(),
}, (table) => ({
  scopeApplicability: index('idx_workflow_experiences_scope').on(table.workspaceId, table.scopeType, table.scopeId, table.status),
  workflowFingerprint: index('idx_workflow_experiences_fingerprint').on(table.workspaceId, table.workflowId, table.failureFingerprint),
  activeApplicability: index('idx_workflow_experiences_applicability').on(
    table.workspaceId,
    table.scopeType,
    table.scopeId,
    table.applicabilityKey,
    table.status,
  ),
}));

export const workflowRepairAttempts = pgTable('workflow_repair_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  workflowId: uuid('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  baseRevisionId: uuid('base_revision_id').references(() => workflowGraphRevisions.id, { onDelete: 'set null' }),
  failureFingerprint: text('failure_fingerprint').notNull(),
  runId: uuid('run_id'),
  nodeId: text('node_id'),
  status: text('status').notNull().default('proposed'),
  candidateRevisionId: uuid('candidate_revision_id').references(() => workflowGraphRevisions.id, { onDelete: 'set null' }),
  attemptCount: integer('attempt_count').notNull().default(1),
  lastError: text('last_error'),
  ...baseTimestamps(),
}, (table) => ({
  fingerprintRevision: uniqueIndex('uq_workflow_repair_attempt_fingerprint').on(
    table.workspaceId,
    table.workflowId,
    table.baseRevisionId,
    table.failureFingerprint,
  ),
}));

export const workflowRuns = pgTable('workflow_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: uuid('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  workflowId: uuid('workflow_id')
    .notNull()
    .references(() => workflows.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id),
  status: text('status').notNull().default('CREATED'),
  executionStatus: text('execution_status').notNull().default('queued'),
  outcomeStatus: text('outcome_status').notNull().default('unverified'),
  settlement: jsonb('settlement_json').notNull().default(sql`'{}'::jsonb`),
  runState: jsonb('run_state').notNull(),
  graphSnapshot: jsonb('graph_snapshot'),
  workflowRevisionId: uuid('workflow_revision_id').references(() => workflowGraphRevisions.id, { onDelete: 'set null' }),
  repairedFromRevisionId: uuid('repaired_from_revision_id').references(() => workflowGraphRevisions.id, { onDelete: 'set null' }),
  replanCount: integer('replan_count').notNull().default(0),
  triggerId: uuid('trigger_id'),
  parentRunId: uuid('parent_run_id'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  ...baseTimestamps(),
});

export const runActivityEvents = pgTable('run_activity_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  runId: uuid('run_id').notNull().references(() => workflowRuns.id, { onDelete: 'cascade' }),
  nodeId: text('node_id'),
  agentId: uuid('agent_id'),
  activityId: text('activity_id').notNull(),
  event: text('event').notNull(),
  kind: text('kind'),
  phase: text('phase'),
  status: text('status'),
  title: text('title'),
  detail: text('detail'),
  transport: text('transport'),
  attempt: integer('attempt'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  durationMs: integer('duration_ms'),
  payload: jsonb('payload_json').notNull().default(sql`'{}'::jsonb`),
  ...baseTimestamps(),
}, (table) => ({
  owner: uniqueIndex('uq_run_activity_owner').on(table.runId, table.activityId),
  timeline: index('idx_run_activity_timeline').on(table.workspaceId, table.runId, table.createdAt),
}));

export const agentExecutionEnvelopes = pgTable('agent_execution_envelopes', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  // Agent table is part of the wider deferred PG parity set; SQLite enforces FK.
  agentId: uuid('agent_id').notNull(),
  runId: uuid('run_id'),
  conversationId: uuid('conversation_id'),
  envelope: jsonb('envelope_json').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ledgerEvents = pgTable('ledger_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: uuid('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  runId: uuid('run_id').notNull().references(() => workflowRuns.id, { onDelete: 'cascade' }),
  sequenceNumber: bigint('sequence_number', { mode: 'number' }).notNull(),
  eventType: text('event_type').notNull(),
  nodeId: text('node_id'),
  taskId: text('task_id'),
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});



