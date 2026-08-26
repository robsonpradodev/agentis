/**
 * Agentic App routes (AGENTIC-APPS-10X-MASTERPLAN §3).
 *
 * CRUD + membership + workflow adoption for the App entity. Surfaces (§4) and
 * datastore (§5) routes mount separately in later phases. Thin layer over
 * `AppStore`; all workspace-scoping and validation live here.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  AgentisError,
  createAppSchema,
  updateAppSchema,
  appMemberRoleSchema,
  appStatusSchema,
  defineCollectionSchema,
  insertRecordSchema,
  updateRecordSchema,
  upsertRecordSchema,
  dataQuerySchema,
  collectionsInView,
  upsertSurfaceSchema,
  uiRenderSchema,
  uiPerformRegionSchema,
  promoteAppEnvironmentSchema,
  upsertAppEnvironmentSchema,
  appWorkflowBindingSchema,
  updateAppWorkflowBindingSchema,
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  type AppInstallPreview,
  type AppRecord,
  type AppWorkflowBinding,
  type AppWorkflowSummary,
  relationshipAutonomyPolicySchema,
  autonomyModeSchema,
  autonomyActionCategorySchema,
  autonomyDecisionSchema,
} from '@agentis/core';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { WorkflowGraph, AgentTool } from '@agentis/core';
import type { AuthService } from '../services/auth.js';
import type { EventBus } from '../event-bus.js';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import type { AgentToolRuntime } from '../services/agent/agentToolRuntime.js';
import { runPublishedWorkflow, startPublishedWorkflow } from '../engine/runPublishedWorkflow.js';
import {
  buildAppStores,
  AppEnvironmentStore,
  AppLifecycle,
  AppPackager,
  AppTestHarness,
  computeAppClosure,
  type AppWorkflowRevisionSink,
  type InterfacePageSnapshot,
} from '@agentis/app';
import type { EpisodicMemoryStore } from '../services/episodicMemoryStore.js';
import { EpisodicBrainPort } from '../services/brain/brainExport.js';
import { bundleFidelitySchema } from '@agentis/core';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { validationError } from '../middleware/error.js';
import { scanArtifactBytes, type ScanFinding } from '../services/registryScanner.js';
import { generateSurfaceView } from '../services/surfaceGenerator.js';
import { aggregateRunAnalytics } from '../services/run/runAnalytics.js';
import type { StructuredCompleter } from '../services/structuredCompleter.js';
import type { AppStaffingService } from '../services/app/appStaffing.js';
import type { ConversationStore } from '../services/conversation/conversationStore.js';
import { channelModelRole } from '../services/conversation/channelConversationRole.js';
import type { AppContactService } from '../services/app/appContacts.js';
import type { ConversationParticipantService } from '../services/conversation/conversationParticipants.js';
import type { AppPresenceService } from '../services/app/appPresence.js';
import type { AppLearningService } from '../services/app/appLearning.js';
import type { AppGoalService } from '../services/app/appGoal.js';
import type { StrategyService } from '../services/app/strategyService.js';
import type { StrategyEvolutionService } from '../services/app/strategyEvolution.js';
import type { ExperimentService } from '../services/experiments.js';
import type { RollingBaselineStore } from '../services/rollingBaselineStore.js';
import { AppLearningService as AppLearningStatic } from '../services/app/appLearning.js';
import type { ConversationSimulatorService } from '../services/conversation/conversationSimulator.js';
import type { OutboundPolicyService } from '../services/outboundPolicy.js';
import type { AppOrchestratorService } from '../services/app/appOrchestrator.js';
import type { TriggerRuntime } from '../engine/TriggerRuntime.js';
import { WorkflowTriggerDeploymentService } from '../services/workflow/workflowTriggerDeployment.js';
import { collectAppDoctorSnapshot } from '../services/app/appDoctorSnapshot.js';
import { validateAppConformance } from '../services/app/appDoctor.js';
import { compileAppReadiness } from '../services/app/appCompiler.js';
import { readWorkflowSpec } from '../services/workflow/workflowSpec.js';
import { evaluateRunOutcome } from '../services/workflow/runOutcome.js';
import { WorkflowRevisionService } from '../services/workflow/workflowRevisionService.js';
import { repairAppConformance } from '../services/app/appDoctorRepair.js';
import {
  deleteOrchestrationRule,
  listOrchestrationRules,
  orchestrationRuleInputSchema,
  upsertOrchestrationRule,
} from '../services/workflow/orchestrationRuleService.js';
import { isAcknowledgedChannelDelivery, type ChannelDeliveryReceipt } from '../adapters/channels/types.js';
import type { ConversationHandoffService } from '../services/conversation/conversationHandoffService.js';

export interface AppRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  bus?: EventBus;
  /** Enables `kind:'workflow'` actions (run a workflow synchronously). */
  engine?: WorkflowEngine;
  /** Enables `kind:'tool'` actions (invoke an agent tool in App context). */
  toolRuntime?: AgentToolRuntime;
  /** Powers agent-assisted surface generation. Omit → deterministic scaffold only. */
  completer?: StructuredCompleter;
  /** Births an App's cast at creation (Phase R). Omit → Apps are created unstaffed. */
  staffing?: AppStaffingService;
  /** Append + realtime-publish operator messages into a live thread (Phase 2 takeover). */
  conversations?: ConversationStore;
  handoffs?: ConversationHandoffService;
  /** Deliver an operator's reply out to the origin channel (Phase 2 takeover). */
  channels?: { deliverToConnection(args: { connectionId: string; chatId: string; body: string; idempotencyKey?: string; actor?: 'automation' | 'human'; conversationId?: string }): Promise<ChannelDeliveryReceipt> };
  /** App relationship pipeline — list/update contacts (Phase 3). */
  contacts?: AppContactService;
  /** Multi-party threads (G1) — list/add/remove conversation participants + warm handoff. */
  participants?: ConversationParticipantService;
  /** Conversational learning loop (Phase M2) — record outcomes, surface learnings. */
  learning?: AppLearningService;
  /** Conversation rehearsal (Phase 5 · G8) — drive a synthetic customer + score the run. */
  simulator?: ConversationSimulatorService;
  /** Live co-presence (G9) — ephemeral operator presence roster over the realtime bus. */
  presence?: AppPresenceService;
  /** Outbound safety envelope (G7) — records operator sends against the App's rolling counter. */
  outboundPolicy?: OutboundPolicyService;
  /** Multi-workflow rules executor (APP-INTERFACE-10X §2.3) — chains, schedules, run-all. */
  orchestrator?: AppOrchestratorService;
  /** Trigger arming runtime — powers the App's always-on (Go Live) lifecycle. */
  triggerRuntime?: TriggerRuntime;
  /** Brain store — enables carrying/rehydrating App + agent memory on `.agentisapp` export/import. */
  episodes?: EpisodicMemoryStore;
  /** Evolution Loop — the App's durable Goal (north-star). */
  appGoal?: AppGoalService;
  /** Evolution Loop — competing strategies + their measured stats. */
  strategies?: StrategyService;
  /** Evolution Loop — the controller (winner selection). */
  evolution?: StrategyEvolutionService;
  /** Evolution Loop — A/B experiment substrate (per-variant results). */
  experiments?: ExperimentService;
  /** Evolution Loop — rolling performance baselines. */
  baselines?: RollingBaselineStore;
}

const addMemberSchema = z.object({
  agentId: z.string().min(1),
  role: appMemberRoleSchema.default('worker'),
});

const batchInsertSchema = z.object({ records: z.array(z.record(z.unknown())).min(1).max(10_000) });
const adoptWorkflowSchema = z.object({ workflowId: z.string().min(1) });
const renameSurfaceSchema = z.object({ name: z.string().trim().min(1).max(120) });
const interfaceCandidateSchema = z.object({
  pages: z.array(z.unknown()).min(1),
  reason: z.string().trim().min(1).max(500).optional(),
  baseRevisionId: z.string().optional(),
  autoPublish: z.boolean().optional(),
});
const generateSurfaceRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  surface: z.string().min(1).optional(),
});
const operatorCommandSchema = z.object({ command: z.string().trim().min(1).max(4000) });
const takeoverSchema = z.object({ active: z.boolean() });
const operatorSendSchema = z.object({ body: z.string().trim().min(1).max(8000) });
// Living Apps Phase 2 — needs-you flag. `active:false` clears it (the operator has
// stepped in); a reason explains why the resident agent needs the human.
const needsAttentionSchema = z.object({
  active: z.boolean().default(true),
  reason: z.string().trim().max(500).nullable().optional(),
});
const addParticipantSchema = z.object({
  participantType: z.enum(['agent', 'human', 'contact']),
  participantId: z.string().trim().min(1).max(255).nullable().optional(),
  role: z.enum(['primary', 'specialist', 'operator', 'customer']).default('specialist'),
  active: z.boolean().default(true),
});
const contactPatchSchema = z.object({
  stage: z.string().trim().max(64).nullable().optional(),
  goal: z.string().trim().max(2000).nullable().optional(),
  displayName: z.string().trim().max(255).nullable().optional(),
  nextTouchAt: z.string().datetime().nullable().optional(),
  data: z.record(z.unknown()).optional(),
});
const contactAutonomySchema = z.object({
  mode: autonomyModeSchema.optional(),
  actions: z.record(autonomyActionCategorySchema, autonomyDecisionSchema).optional(),
});
const presenceHeartbeatSchema = z.object({
  conversationId: z.string().trim().min(1).max(255).nullable().optional(),
});
const doctorRepairRequestSchema = z.object({
  findingIds: z.array(z.string().min(1)).optional(),
  confirm: z.boolean().default(false),
});
const orchestrationRulePatchSchema = orchestrationRuleInputSchema.partial();
const contactOutcomeSchema = z.object({
  outcome: z.enum(['won', 'lost', 'abandoned']),
  note: z.string().trim().max(2000).nullable().optional(),
  setStage: z.string().trim().max(64).nullable().optional(),
});

// Conversation rehearsal (Phase 5 · G8). A scenario drives a synthetic customer
// against the resident agent and scores the transcript. Patterns are plain
// substrings (case-insensitive); guardrails/expectations are matched against agent replies.
const simulatePatternSchema = z.string().trim().min(1).max(400);
const simulateGuardrailSchema = z.object({
  id: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(200),
  pattern: simulatePatternSchema,
});
const simulateExpectationSchema = simulateGuardrailSchema;
const simulateScenarioSchema = z.object({
  name: z.string().trim().min(1).max(200),
  persona: z.object({
    name: z.string().trim().min(1).max(200),
    prompt: z.string().trim().min(1).max(4000),
  }),
  goal: z.string().trim().min(1).max(2000),
  customerTurns: z.array(z.string().trim().min(1).max(4000)).max(12).optional(),
  maxTurns: z.number().int().min(1).max(12).optional(),
  goalSignals: z.array(simulatePatternSchema).max(20).optional(),
  guardrails: z.array(simulateGuardrailSchema).max(20).optional(),
  expectations: z.array(simulateExpectationSchema).max(20).optional(),
});
const simulateRequestSchema = z.object({
  scenario: simulateScenarioSchema,
  agentId: z.string().trim().min(1).max(255).optional(),
});

const createAppRequestSchema = createAppSchema.extend({
  /** Create the first App workflow in the same transaction as the App itself. */
  createEntryWorkflow: z.boolean().default(false),
  entryWorkflowTitle: z.string().trim().min(1).max(255).optional(),
  /** Starter graph for the entry workflow (template gallery, masterplan 5.5). Empty when omitted. */
  entryWorkflowGraph: z.object({ version: z.literal(1), nodes: z.array(z.unknown()), edges: z.array(z.unknown()) }).passthrough().optional(),
}).refine(
  (input) => !(input.createEntryWorkflow && input.entryWorkflowId),
  { message: 'entryWorkflowId and createEntryWorkflow cannot be used together' },
);

// Import-path envelope shell: validates the wrapper but keeps `manifest` RAW.
// The packager verifies the checksum over the transported manifest bytes before
// schema-parsing it — parsing first strips/defaults fields and would break the
// checksum of authentic older exports (see AppPackager.deserialize).
const rawAppEnvelopeSchema = z.object({
  format: z.literal('.agentisapp'),
  formatVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  manifest: z.record(z.unknown()),
  checksum: z.string().min(1),
  exportedAt: z.string().optional(),
});

const importAppSchema = z.object({
  envelope: rawAppEnvelopeSchema,
  permissionsAcknowledged: z.array(z.string()).default([]),
});

const appTestSchema = z.object({
  envelope: rawAppEnvelopeSchema,
  actions: z.array(z.object({
    surface: z.string().min(1),
    name: z.string().min(1),
    args: z.record(z.unknown()).optional(),
  })).default([]),
  assertions: z.array(z.object({
    collection: z.string().min(1),
    query: dataQuerySchema.optional(),
    count: z.number().int().nonnegative().optional(),
    includes: z.record(z.unknown()).optional(),
  })).default([]),
});

/** Opaque public-share token: base64url("appId\0surfaceName"). The `shareable`
 * flag on the surface is the real gate; the token just avoids id enumeration. */
const SHARE_TOKEN_SEPARATOR = '\u001f';

function encodeShareToken(appId: string, surface: string): string {
  return Buffer.from(`${appId}${SHARE_TOKEN_SEPARATOR}${surface}`, 'utf8').toString('base64url');
}
function decodeShareToken(token: string): { appId: string; surface: string } | null {
  try {
    const [appId, surface] = Buffer.from(token, 'base64url').toString('utf8').split(SHARE_TOKEN_SEPARATOR);
    return appId && surface ? { appId, surface } : null;
  } catch {
    return null;
  }
}

function scanAppEnvelope(envelope: unknown): ScanFinding[] {
  const label =
    envelope && typeof envelope === 'object' && 'manifest' in envelope
      ? String((envelope as { manifest?: { identity?: { slug?: unknown } } }).manifest?.identity?.slug ?? '.agentisapp')
      : '.agentisapp';
  const scan = scanArtifactBytes(Buffer.from(JSON.stringify(envelope ?? null), 'utf8'), label);
  const blockers = scan.findings.filter((finding) => finding.severity === 'block');
  if (blockers.length > 0) {
    throw new AgentisError('APP_PACKAGE_SCAN_BLOCKED', 'App import blocked by security scan', {
      details: { findings: blockers },
    });
  }
  return scan.findings.filter((finding) => finding.severity === 'warn');
}

function appendScanWarnings(preview: AppInstallPreview, findings: ScanFinding[]): AppInstallPreview {
  const scanWarnings = findings.map((finding) => `${finding.rule}: ${finding.detail}`);
  return {
    ...preview,
    scanWarnings,
    warnings: [...preview.warnings, ...scanWarnings.map((warning) => `Security scan warning: ${warning}`)],
  };
}

function assertAppPermissionsAcknowledged(preview: AppInstallPreview, acknowledged: string[]): void {
  const expected = [...preview.permissions].sort();
  const actual = [...acknowledged].sort();
  if (expected.length === actual.length && expected.every((permission, index) => permission === actual[index])) return;
  throw new AgentisError('APP_PERMISSIONS_NOT_ACKNOWLEDGED', 'App permissions must be acknowledged before install', {
    details: { expected, acknowledged: actual },
  });
}

/** Validate a domain (or subdomain) belongs to this workspace before assigning. */
function ensureAppDomain(db: AgentisSqliteDb, workspaceId: string, domainId: string): void {
  const domain = db
    .select({ id: schema.domains.id })
    .from(schema.domains)
    .where(and(eq(schema.domains.id, domainId), eq(schema.domains.workspaceId, workspaceId)))
    .get();
  if (!domain) throw new AgentisError('RESOURCE_NOT_FOUND', `domain ${domainId} not found`);
}

export function buildAppRoutes(deps: AppRoutesDeps) {
  const app = new Hono<{ Variables: { user: { id: string } } }>();
  const { store, data, surfaces, interfaces } = buildAppStores(deps);
  const packager = new AppPackager(deps.db);
  const brainPort = deps.episodes ? new EpisodicBrainPort(deps.episodes) : undefined;
  const workflowRevisions = new WorkflowRevisionService(deps.db);
  const workflowRevisionSink: AppWorkflowRevisionSink = (input) => {
    const revisionService = new WorkflowRevisionService(input.db);
    const existingByTitle = new Map(
      input.db.select().from(schema.workflows)
        .where(and(
          eq(schema.workflows.workspaceId, input.workspaceId),
          eq(schema.workflows.appId, input.appId),
        ))
        .all()
        .map((workflow) => [workflow.title, workflow] as const),
    );
    for (const manifestWorkflow of input.workflows) {
      if (!manifestWorkflow.graph) {
        throw new AgentisError('WORKFLOW_GRAPH_INVALID', `App workflow "${manifestWorkflow.title}" has no graph`);
      }
      let workflow = existingByTitle.get(manifestWorkflow.title);
      if (!workflow) {
        const id = randomUUID();
        input.db.insert(schema.workflows).values({
          id,
          workspaceId: input.workspaceId,
          userId: input.userId,
          appId: input.appId,
          title: manifestWorkflow.title,
          description: manifestWorkflow.description ?? null,
          graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        }).run();
        workflow = input.db.select().from(schema.workflows).where(eq(schema.workflows.id, id)).get()!;
      } else {
        input.db.update(schema.workflows).set({
          description: manifestWorkflow.description ?? null,
          updatedAt: new Date().toISOString(),
        }).where(eq(schema.workflows.id, workflow.id)).run();
      }
      const base = revisionService.candidate(input.workspaceId, workflow.id)?.revision
        ?? revisionService.ensureWorkflow(input.workspaceId, workflow.id).active;
      revisionService.createCandidate({
        workspaceId: input.workspaceId,
        workflowId: workflow.id,
        graph: manifestWorkflow.graph as WorkflowGraph,
        baseRevisionId: base.id,
        source: 'import',
        actor: { type: 'user', id: input.userId },
        reason: 'App lifecycle change retained as a verification candidate',
      });
    }
  };
  const lifecycle = new AppLifecycle(deps.db, workflowRevisionSink);
  const environments = new AppEnvironmentStore(deps.db, workflowRevisionSink);
  const triggerDeployments = deps.triggerRuntime
    ? new WorkflowTriggerDeploymentService(deps.db, deps.triggerRuntime)
    : null;

  /** Fan out an App-lifecycle change so the control deck + home refetch live. */
  const emitAppChanged = (workspaceId: string, appId: string) => {
    deps.bus?.publish(REALTIME_ROOMS.app(appId), REALTIME_EVENTS.APP_UPDATED, { appId, op: 'updated' });
    deps.bus?.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.APP_UPDATED, { appId, op: 'updated' });
  };

  // ── Public, unauthed surface sharing (AGENTIC-APPS-10X §4.7) ────────────────
  // Registered BEFORE auth. Gated by the surface's `shareable` flag.
  const loadShared = (token: string) => {
    const decoded = decodeShareToken(token);
    if (!decoded) throw new AgentisError('RESOURCE_NOT_FOUND', 'share link invalid');
    const appRow = deps.db
      .select({ id: schema.apps.id, workspaceId: schema.apps.workspaceId, name: schema.apps.name, icon: schema.apps.icon })
      .from(schema.apps)
      .where(eq(schema.apps.id, decoded.appId))
      .get();
    if (!appRow) throw new AgentisError('RESOURCE_NOT_FOUND', 'share link invalid');
    const surface = surfaces.get(appRow.workspaceId, appRow.id, decoded.surface);
    if (!surface.shareable) throw new AgentisError('RESOURCE_NOT_FOUND', 'share link invalid');
    return { appRow, surface };
  };

  app.get('/public/surfaces/:token', (c) => {
    const { appRow, surface } = loadShared(c.req.param('token'));
    return c.json({ data: { app: { name: appRow.name, icon: appRow.icon }, surface } });
  });

  app.post('/public/surfaces/:token/query', async (c) => {
    const { appRow, surface } = loadShared(c.req.param('token'));
    const body = (await c.req.json().catch(() => ({}))) as { collection?: string } & Record<string, unknown>;
    if (!body.collection) throw new AgentisError('VALIDATION_FAILED', 'collection required');
    // Authorization: a public share may read ONLY the collections its own view
    // binds — never a sibling collection it doesn't display. Without this, a
    // share link to one surface could enumerate every collection in the app.
    if (!collectionsInView(surface.view).has(body.collection)) {
      throw new AgentisError('RESOURCE_NOT_FOUND', 'collection not available on this surface');
    }
    const query = dataQuerySchema.parse({
      ...(body.filter !== undefined ? { filter: body.filter } : {}),
      ...(body.sort !== undefined ? { sort: body.sort } : {}),
      ...(body.limit !== undefined ? { limit: body.limit } : {}),
      ...(body.cursor !== undefined ? { cursor: body.cursor } : {}),
    });
    return c.json(data.query(appRow.workspaceId, appRow.id, body.collection, query));
  });

  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.post('/:id/surfaces/:name/share', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    const name = c.req.param('name');
    surfaces.upsert(ws.workspaceId, appId, { ...surfaces.get(ws.workspaceId, appId, name), shareable: true });
    const token = encodeShareToken(appId, name);
    const url = new URL(c.req.url);
    url.pathname = `/public/apps/${encodeURIComponent(token)}`;
    url.search = '';
    return c.json({ data: { token, url: url.toString() } });
  });

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const statusRaw = c.req.query('status');
    const status = statusRaw ? appStatusSchema.parse(statusRaw) : undefined;
    return c.json({ data: store.list(ws.workspaceId, status ? { status } : {}) });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const parsed = createAppRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) throw validationError('Invalid app input', parsed.error);
    const { createEntryWorkflow, entryWorkflowTitle, entryWorkflowGraph, ...input } = parsed.data;
    if (input.domainId) ensureAppDomain(deps.db, ws.workspaceId, input.domainId);

    // Birth the App's cast (Phase R). Best-effort — re-reads so the new owner shows.
    const staffNewApp = async (app: AppRecord): Promise<AppRecord> => {
      if (!deps.staffing) return app;
      await deps.staffing.staffApp({
        workspaceId: ws.workspaceId,
        userId: user.id,
        appId: app.id,
        name: app.name,
        description: app.description ?? '',
      });
      return store.get(ws.workspaceId, app.id);
    };

    if (!createEntryWorkflow) {
      return c.json({ data: await staffNewApp(store.create(ws.workspaceId, user.id, input)) }, 201);
    }

    let created: AppRecord | null = null;
    const entryWorkflowId = randomUUID();
    const initialEntryGraph = entryWorkflowGraph ?? { version: 1 as const, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
    deps.db.transaction(() => {
      deps.db.insert(schema.workflows).values({
        id: entryWorkflowId,
        workspaceId: ws.workspaceId,
        ambientId: ws.ambientId ?? null,
        userId: user.id,
        title: entryWorkflowTitle ?? `${input.name} workflow`,
        graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        settings: {},
        concurrencyOverflow: 'queue',
      }).run();
      created = store.create(ws.workspaceId, user.id, { ...input, entryWorkflowId });
    });
    if (!created) throw new AgentisError('INTERNAL_ERROR', 'Failed to create app workflow');
    const base = workflowRevisions.ensureWorkflow(ws.workspaceId, entryWorkflowId).active;
    if (initialEntryGraph.nodes.length > 0) {
      workflowRevisions.createCandidate({
        workspaceId: ws.workspaceId,
        workflowId: entryWorkflowId,
        graph: initialEntryGraph as unknown as WorkflowGraph,
        baseRevisionId: base.id,
        source: 'create',
        actor: { type: 'user', id: user.id },
        reason: 'Initial App entry workflow',
      });
    }
    return c.json({ data: await staffNewApp(created) }, 201);
  });

  /**
   * Promote a legacy bare workflow to a first-class App-of-one. The workflow
   * itself is preserved verbatim; the transaction only assigns its owner App.
   */
  app.post('/from-workflow/:workflowId', (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const workflowId = c.req.param('workflowId');
    let appRecord: AppRecord | null = null;
    let promoted = false;

    deps.db.transaction(() => {
      const workflow = deps.db
        .select({ id: schema.workflows.id, title: schema.workflows.title, appId: schema.workflows.appId })
        .from(schema.workflows)
        .where(and(eq(schema.workflows.workspaceId, ws.workspaceId), eq(schema.workflows.id, workflowId)))
        .get();
      if (!workflow) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow not found: ${workflowId}`);
      if (workflow.appId) {
        appRecord = store.get(ws.workspaceId, workflow.appId);
      } else {
        promoted = true;
        appRecord = store.create(ws.workspaceId, user.id, {
          name: workflow.title,
          description: '',
          entryWorkflowId: workflow.id,
        });
      }
    });

    if (!appRecord) throw new AgentisError('INTERNAL_ERROR', 'Failed to promote workflow to app');
    return c.json({ data: appRecord }, promoted ? 201 : 200);
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    return c.json({ data: store.get(ws.workspaceId, c.req.param('id')) });
  });

  // ── Workflow control plane (E0) — an App governs its workflows ──────────────
  // The missing operator control: see every workflow the App owns, why it exists,
  // its order, status + last run, and run it — without leaving the App.

  app.get('/:id/workflows', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    if (!store.get(ws.workspaceId, appId)) throw new AgentisError('RESOURCE_NOT_FOUND', `app not found: ${appId}`);
    const rows = deps.db.select({
      id: schema.workflows.id,
      title: schema.workflows.title,
      description: schema.workflows.description,
      graph: schema.workflows.graph,
      settings: schema.workflows.settings,
    }).from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, ws.workspaceId), eq(schema.workflows.appId, appId)))
      // Oldest first so a newly created workflow always lands on the right of the tab row.
      .orderBy(asc(schema.workflows.createdAt))
      .all();
    // Arming state for every armable workflow in this App (one composite read).
    const appDeployment = triggerDeployments?.getForApp(ws.workspaceId, appId) ?? null;
    const deploymentByWorkflow = new Map(appDeployment?.workflows.map((w) => [w.workflowId, w]) ?? []);
    const summaries: AppWorkflowSummary[] = rows.map((row) => {
      const binding = readAppWorkflowBinding(row.settings);
      const lastRun = deps.db.select({
        id: schema.workflowRuns.id,
        status: schema.workflowRuns.status,
        runState: schema.workflowRuns.runState,
        startedAt: schema.workflowRuns.startedAt,
        createdAt: schema.workflowRuns.createdAt,
      }).from(schema.workflowRuns)
        .where(and(eq(schema.workflowRuns.workspaceId, ws.workspaceId), eq(schema.workflowRuns.workflowId, row.id)))
        .orderBy(desc(schema.workflowRuns.createdAt)).limit(1).get();
      const activeRun = deps.db.select({
        id: schema.workflowRuns.id,
        status: schema.workflowRuns.status,
        startedAt: schema.workflowRuns.startedAt,
        createdAt: schema.workflowRuns.createdAt,
      }).from(schema.workflowRuns)
        .where(and(
          eq(schema.workflowRuns.workspaceId, ws.workspaceId),
          eq(schema.workflowRuns.workflowId, row.id),
          inArray(schema.workflowRuns.status, ['RUNNING', 'WAITING', 'PAUSED']),
        ))
        .orderBy(desc(schema.workflowRuns.createdAt)).limit(1).get();
      const lastOutcome = lastRun ? evaluateRunOutcome({
        status: lastRun.status,
        runState: lastRun.runState,
        hasDefinitionOfDone: Boolean(readWorkflowSpec(row.settings)),
      }) : null;
      return {
        id: row.id,
        title: row.title,
        purpose: binding.purpose ?? (row.description?.trim() || null),
        order: binding.order ?? 0,
        enabled: binding.enabled ?? true,
        operatorEntrypoint: binding.operatorEntrypoint ?? (binding.dependsOn ?? []).length === 0,
        dependsOn: binding.dependsOn ?? [],
        triggerKind: triggerKindOf(row.graph as WorkflowGraph),
        lastRun: lastRun ? {
          id: lastRun.id,
          status: lastRun.status,
          at: lastRun.startedAt ?? lastRun.createdAt,
          outcome: lastOutcome?.verdict ?? null,
          verified: lastOutcome?.verified ?? false,
          accomplished: lastOutcome?.accomplished ?? false,
        } : null,
        activeRun: activeRun ? { id: activeRun.id, status: activeRun.status, startedAt: activeRun.startedAt ?? activeRun.createdAt } : null,
        schedule: binding.schedule ? { cron: binding.schedule.cron, enabled: binding.schedule.enabled } : null,
        nextRunAt: deps.orchestrator?.nextScheduledFire(row.id) ?? null,
        concurrency: binding.concurrency ?? 'parallel',
        chainOn: binding.chainOn ?? 'success',
        deployment: (() => {
          const dep = deploymentByWorkflow.get(row.id);
          if (!dep || dep.status === 'manual' || dep.triggerType === 'manual') return null;
          return {
            triggerType: dep.triggerType as 'cron' | 'webhook' | 'persistent_listener',
            status: dep.status as 'active' | 'paused' | 'error' | 'unarmed',
            lastFiredAt: dep.lastFiredAt,
            ...(dep.health !== undefined ? { health: dep.health } : {}),
          };
        })(),
      };
    }).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    return c.json({ data: summaries });
  });

  /** Truthful orchestration health: persisted runtime layers, never UI inference. */
  app.get('/:id/doctor', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    return c.json({ data: validateAppConformance(collectAppDoctorSnapshot(deps.db, ws.workspaceId, appId)) });
  });

  /** Full pre-execution compile gate used by agents, run admission, and UI. */
  app.get('/:id/compile', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    const target = c.req.query('target');
    const compileTarget = target === 'debug' || target === 'unattended' ? target : 'production';
    return c.json({ data: compileAppReadiness(deps.db, ws.workspaceId, appId, compileTarget) });
  });

  app.post('/:id/doctor/repair', async (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    const parsed = doctorRepairRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw validationError('Invalid Doctor repair request', parsed.error);
    return c.json({
      data: repairAppConformance(deps.db, ws.workspaceId, appId, {
        dryRun: parsed.data.confirm !== true,
        findingIds: parsed.data.findingIds,
      }),
    });
  });

  /** Executable event rules whose source or target belongs to this App. */
  app.get('/:id/orchestration-rules', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    return c.json({ data: listOrchestrationRules(deps.db, ws.workspaceId, appId) });
  });

  app.post('/:id/orchestration-rules', async (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    const parsed = orchestrationRuleInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw validationError('Invalid orchestration rule', parsed.error);
    return c.json({ data: upsertOrchestrationRule(deps.db, ws.workspaceId, parsed.data, { appId }) }, 201);
  });

  app.patch('/:id/orchestration-rules/:ruleId', async (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    const ruleId = c.req.param('ruleId');
    if (!listOrchestrationRules(deps.db, ws.workspaceId, appId).some((rule) => rule.id === ruleId)) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `workflow event rule not found in App: ${ruleId}`);
    }
    const parsed = orchestrationRulePatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw validationError('Invalid orchestration rule patch', parsed.error);
    return c.json({ data: upsertOrchestrationRule(deps.db, ws.workspaceId, parsed.data, { id: ruleId, appId }) });
  });

  app.delete('/:id/orchestration-rules/:ruleId', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    const ruleId = c.req.param('ruleId');
    if (!listOrchestrationRules(deps.db, ws.workspaceId, appId).some((rule) => rule.id === ruleId)) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `workflow event rule not found in App: ${ruleId}`);
    }
    deleteOrchestrationRule(deps.db, ws.workspaceId, ruleId);
    return c.json({ data: { ok: true } });
  });

  // ── App-level always-on lifecycle (Go Live) ─────────────────────────────────
  // An App is multi-workflow; "going live" arms every workflow that authors an
  // unattended trigger (schedule / webhook / listener). These compose the same
  // per-workflow activation the canvas uses — SWIFT arming gate included.

  app.get('/:id/deployment', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    if (!store.get(ws.workspaceId, appId)) throw new AgentisError('RESOURCE_NOT_FOUND', `app not found: ${appId}`);
    if (!triggerDeployments) throw new AgentisError('LISTENER_RUNTIME_UNAVAILABLE', 'Trigger activation is unavailable in this runtime.');
    return c.json({ data: triggerDeployments.getForApp(ws.workspaceId, appId) });
  });

  app.post('/:id/activate', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const appId = c.req.param('id');
    if (!store.get(ws.workspaceId, appId)) throw new AgentisError('RESOURCE_NOT_FOUND', `app not found: ${appId}`);
    if (!triggerDeployments) throw new AgentisError('LISTENER_RUNTIME_UNAVAILABLE', 'Trigger activation is unavailable in this runtime.');
    const body = (await c.req.json().catch(() => ({}))) as { override?: { ack?: string } };
    const override = body.override?.ack?.trim() ? { ack: body.override.ack.trim() } : undefined;
    const result = await triggerDeployments.activateApp({ workspaceId: ws.workspaceId, appId, userId: user.id, override });
    emitAppChanged(ws.workspaceId, appId);
    return c.json({ data: result });
  });

  app.post('/:id/deactivate', async (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    if (!store.get(ws.workspaceId, appId)) throw new AgentisError('RESOURCE_NOT_FOUND', `app not found: ${appId}`);
    if (!triggerDeployments) throw new AgentisError('LISTENER_RUNTIME_UNAVAILABLE', 'Trigger activation is unavailable in this runtime.');
    const result = await triggerDeployments.deactivateApp({ workspaceId: ws.workspaceId, appId });
    emitAppChanged(ws.workspaceId, appId);
    return c.json({ data: result });
  });

  // Per-workflow arm/disarm from the App control deck (single trigger).
  app.post('/:id/workflows/:wid/arm', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const appId = c.req.param('id');
    const wid = c.req.param('wid');
    if (!store.get(ws.workspaceId, appId)) throw new AgentisError('RESOURCE_NOT_FOUND', `app not found: ${appId}`);
    if (!triggerDeployments) throw new AgentisError('LISTENER_RUNTIME_UNAVAILABLE', 'Trigger activation is unavailable in this runtime.');
    const wf = deps.db
      .select({ id: schema.workflows.id, ambientId: schema.workflows.ambientId })
      .from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, ws.workspaceId), eq(schema.workflows.appId, appId), eq(schema.workflows.id, wid)))
      .get();
    if (!wf) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow not found in this app: ${wid}`);
    const body = (await c.req.json().catch(() => ({}))) as { override?: { ack?: string } };
    const override = body.override?.ack?.trim() ? { ack: body.override.ack.trim() } : undefined;
    const deployment = await triggerDeployments.activate({
      workspaceId: ws.workspaceId,
      workflowId: wid,
      ambientId: wf.ambientId ?? null,
      userId: user.id,
      override,
    });
    emitAppChanged(ws.workspaceId, appId);
    return c.json({ data: deployment });
  });

  app.post('/:id/workflows/:wid/disarm', async (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    const wid = c.req.param('wid');
    if (!store.get(ws.workspaceId, appId)) throw new AgentisError('RESOURCE_NOT_FOUND', `app not found: ${appId}`);
    if (!triggerDeployments) throw new AgentisError('LISTENER_RUNTIME_UNAVAILABLE', 'Trigger activation is unavailable in this runtime.');
    const deployment = await triggerDeployments.setStatus(ws.workspaceId, wid, 'paused');
    emitAppChanged(ws.workspaceId, appId);
    return c.json({ data: deployment });
  });

  // Continue from the first unresolved business frontier by default. A caller
  // must explicitly request `fresh` to replay accomplished roots.
  app.post('/:id/workflows/run-all', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const appId = c.req.param('id');
    if (!store.get(ws.workspaceId, appId)) throw new AgentisError('RESOURCE_NOT_FOUND', `app not found: ${appId}`);
    if (!deps.orchestrator) throw new AgentisError('INTERNAL_ERROR', 'app orchestrator is not available in this runtime');
    const body = await c.req.json().catch(() => ({})) as { mode?: unknown; override?: { ack?: unknown } };
    const mode = body.mode === 'fresh' ? 'fresh' : 'continue';
    const report = compileAppReadiness(deps.db, ws.workspaceId, appId, 'production');
    const blockers = report.checks.filter((check) => check.status === 'block' && check.blocksExecution !== false);
    const overrideAck = typeof body.override?.ack === 'string' ? body.override.ack.trim() : '';
    if (blockers.length > 0 && !overrideAck) {
      throw new AgentisError(
        'VALIDATION_FAILED',
        `App run blocked by ${blockers.length} execution finding${blockers.length === 1 ? '' : 's'}. Resolve them or pass override.ack with an audited reason.`,
        {
          httpStatus: 409,
          remediation: `Run agentis.app.compile and clear: ${blockers.slice(0, 3).map((finding) => finding.id).join(', ')}`,
          details: { appId, structuralReady: report.structuralReady, executableReady: report.executableReady, executionBlockerCount: report.executionBlockerCount, evidencePendingCount: report.evidencePendingCount, blockers, next: report.next },
        },
      );
    }
    const results = await deps.orchestrator.runAll(ws.workspaceId, appId, user.id, mode, overrideAck || undefined);
    return c.json({ data: { mode, results } }, 202);
  });

  app.post('/:id/workflows/:wid/run', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const appId = c.req.param('id');
    const wid = c.req.param('wid');
    const body = await c.req.json().catch(() => ({})) as { inputs?: unknown };
    const row = deps.db.select({ id: schema.workflows.id, appId: schema.workflows.appId, graph: schema.workflows.graph })
      .from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, ws.workspaceId), eq(schema.workflows.id, wid)))
      .get();
    if (!row || row.appId !== appId) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow ${wid} is not part of app ${appId}`);
    if (!deps.engine) throw new AgentisError('INTERNAL_ERROR', 'workflow engine is not available in this runtime');
    // Non-blocking start (reuses the engine run path); the UI polls run status.
    const { runId } = await startPublishedWorkflow({
      db: deps.db,
      engine: deps.engine,
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId ?? null,
      userId: user.id,
      workflowId: wid,
      graph: row.graph as WorkflowGraph,
      inputs: body.inputs && typeof body.inputs === 'object' ? body.inputs as Record<string, unknown> : {},
    });
    return c.json({ data: { runId } }, 202);
  });

  app.patch('/:id/workflows/:wid/binding', async (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    const wid = c.req.param('wid');
    const patch = updateAppWorkflowBindingSchema.parse(await c.req.json().catch(() => ({})));
    const row = deps.db.select({ appId: schema.workflows.appId, settings: schema.workflows.settings })
      .from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, ws.workspaceId), eq(schema.workflows.id, wid)))
      .get();
    if (!row || row.appId !== appId) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow ${wid} is not part of app ${appId}`);
    const next: AppWorkflowBinding = { ...readAppWorkflowBinding(row.settings), ...patch };
    deps.db.update(schema.workflows)
      .set({ settings: { ...(row.settings as Record<string, unknown>), appBinding: next }, updatedAt: new Date().toISOString() })
      .where(eq(schema.workflows.id, wid)).run();
    // Rules changed — re-arm the App-level schedule for this workflow.
    deps.orchestrator?.rearm(wid);
    // Realtime: the App control plane + canvas + home refetch the new order live
    // (same signal the agent's agentis.workflow.chain tool emits).
    deps.bus?.publish(REALTIME_ROOMS.workflow(wid), REALTIME_EVENTS.WORKFLOW_UPDATED, { workflowId: wid, appId });
    deps.bus?.publish(REALTIME_ROOMS.app(appId), REALTIME_EVENTS.APP_UPDATED, { appId, op: 'updated' });
    deps.bus?.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.APP_UPDATED, { appId, op: 'updated' });
    return c.json({ data: next });
  });

  // ── Packaging — `.agentisapp` export/import (§7.2) ──────────

  app.get('/:id/export', (c) => {
    const ws = getWorkspace(c);
    // Defaults to FULL: exporting an App should carry what it needs to actually
    // run elsewhere — its agents and their memory, the App Brain, knowledge and
    // data. `?fidelity=shareable` opts down to structure-only for public sharing.
    // `?exclude=agent:<id>,knowledgeBase:<id>` drops individual closure items.
    const fidelity = bundleFidelitySchema.catch('full').parse(c.req.query('fidelity'));
    const revisionTarget = c.req.query('revisionTarget') === 'candidate' ? 'candidate' : 'active';
    const exclude = (c.req.query('exclude') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return c.json({
      data: packager.export(ws.workspaceId, c.req.param('id'), {
        fidelity,
        revisionTarget,
        ...(exclude.length > 0 ? { exclude } : {}),
        ...(brainPort ? { brain: brainPort } : {}),
      }),
    });
  });

  /** What an App export contains, before exporting — powers the selection tree. */
  app.get('/:id/export/preview', (c) => {
    const ws = getWorkspace(c);
    const revisionTarget = c.req.query('revisionTarget') === 'candidate' ? 'candidate' : 'active';
    return c.json({ data: { ...computeAppClosure(deps.db, ws.workspaceId, c.req.param('id'), revisionTarget), revisionTarget } });
  });

  app.post('/import/preview', async (c) => {
    const ws = getWorkspace(c);
    const envelope = rawAppEnvelopeSchema.parse(await c.req.json());
    const warnings = scanAppEnvelope(envelope);
    return c.json({ data: appendScanWarnings(packager.preview(envelope, ws.workspaceId), warnings) });
  });

  app.post('/import', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const body = importAppSchema.parse(await c.req.json());
    const warnings = scanAppEnvelope(body.envelope);
    const preview = appendScanWarnings(packager.preview(body.envelope, ws.workspaceId), warnings);
    assertAppPermissionsAcknowledged(preview, body.permissionsAcknowledged);
    const imported = packager.import(ws.workspaceId, user.id, body.envelope, {
      ...(brainPort ? { brain: brainPort } : {}),
    });
    const importedWorkflows = deps.db.select({ id: schema.workflows.id })
      .from(schema.workflows)
      .where(and(
        eq(schema.workflows.workspaceId, ws.workspaceId),
        eq(schema.workflows.appId, imported.appId),
      ))
      .all();
    for (const workflow of importedWorkflows) {
      // The operator explicitly acknowledged this package before installation.
      // Materialize its imported graph as the active revision so a manual run
      // executes the graph they just reviewed, rather than an empty baseline.
      workflowRevisions.ensureWorkflow(ws.workspaceId, workflow.id);
    }
    return c.json({
      data: imported,
    }, 201);
  });

  app.post('/test', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const body = appTestSchema.parse(await c.req.json());
    scanAppEnvelope(body.envelope);
    const manifest = packager.deserialize(body.envelope);
    const result = new AppTestHarness(deps.db).runIsolated(ws.workspaceId, user.id, {
      manifest,
      actions: body.actions,
      assertions: body.assertions,
    });
    return c.json({ data: result });
  });

  app.post('/:id/upgrade/preview', async (c) => {
    const ws = getWorkspace(c);
    const envelope = rawAppEnvelopeSchema.parse(await c.req.json());
    const manifest = packager.deserialize(envelope);
    return c.json({ data: lifecycle.planUpgrade(ws.workspaceId, c.req.param('id'), manifest) });
  });

  app.post('/:id/upgrade', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const envelope = rawAppEnvelopeSchema.parse(await c.req.json());
    const manifest = packager.deserialize(envelope);
    return c.json({ data: lifecycle.upgrade(ws.workspaceId, user.id, c.req.param('id'), manifest, { installedChecksum: envelope.checksum }) });
  });

  app.post('/:id/rollback/:snapshotId', (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    return c.json({ data: lifecycle.rollback(ws.workspaceId, user.id, c.req.param('id'), c.req.param('snapshotId')) });
  });

  app.get('/:id/environments', (c) => {
    const ws = getWorkspace(c);
    return c.json({ data: environments.list(ws.workspaceId, c.req.param('id')) });
  });

  app.post('/:id/environments/:name/snapshot', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const body = z.object({ kind: z.enum(['dev', 'staging', 'production']).default('dev') }).parse(await c.req.json().catch(() => ({})));
    return c.json({ data: environments.snapshotRuntime(ws.workspaceId, user.id, c.req.param('id'), c.req.param('name'), body.kind) });
  });

  app.put('/:id/environments/:name', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const body = upsertAppEnvironmentSchema.parse(await c.req.json());
    return c.json({ data: environments.upsert(ws.workspaceId, user.id, c.req.param('id'), c.req.param('name'), body) });
  });

  app.post('/:id/environments/:name/promote', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const body = promoteAppEnvironmentSchema.parse(await c.req.json());
    return c.json({ data: environments.promote(ws.workspaceId, user.id, c.req.param('id'), c.req.param('name'), body) });
  });

  app.patch('/:id', async (c) => {
    const ws = getWorkspace(c);
    const parsed = updateAppSchema.safeParse(await c.req.json());
    if (!parsed.success) throw validationError('Invalid app update', parsed.error);
    if (parsed.data.domainId) ensureAppDomain(deps.db, ws.workspaceId, parsed.data.domainId);
    return c.json({ data: store.update(ws.workspaceId, c.req.param('id'), parsed.data) });
  });

  /** What deleting this App would remove — render before confirming. */
  app.get('/:id/deletion-preview', (c) => {
    const ws = getWorkspace(c);
    return c.json({ data: store.deletionPreview(ws.workspaceId, c.req.param('id')) });
  });

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    // Workflows go with the App unless the caller explicitly keeps them. Opt-IN
    // because silently orphaning them was the old behaviour, and the orphans had
    // no owning App page left to delete them from.
    const keepWorkflows = ['1', 'true', 'yes'].includes(
      (c.req.query('keepWorkflows') ?? '').toLowerCase(),
    );
    const result = store.delete(ws.workspaceId, c.req.param('id'), {
      keepWorkflows,
      // Cancel in-flight runs first so the FK cascade never pulls a run row out
      // from under a live execution.
      onWorkflowDeleting: (workflowId) => {
        for (const run of deps.db
          .select({ id: schema.workflowRuns.id })
          .from(schema.workflowRuns)
          .where(and(
            eq(schema.workflowRuns.workflowId, workflowId),
            sql`${schema.workflowRuns.status} NOT IN ('COMPLETED','FAILED','CANCELLED','COMPLETED_WITH_CONTRACT_VIOLATION')`,
          ))
          .all()) {
          void deps.engine?.cancelRun(run.id).catch(() => { /* cascade removes it anyway */ });
        }
      },
    });
    return c.json({ data: { ok: true, ...result } });
  });

  // ── Membership ──────────────────────────────────────────────

  app.get('/:id/members', (c) => {
    const ws = getWorkspace(c);
    return c.json({ data: store.listMembers(ws.workspaceId, c.req.param('id')) });
  });

  app.post('/:id/members', async (c) => {
    const ws = getWorkspace(c);
    const parsed = addMemberSchema.safeParse(await c.req.json());
    if (!parsed.success) throw validationError('Invalid member input', parsed.error);
    store.addMember(ws.workspaceId, c.req.param('id'), parsed.data.agentId, parsed.data.role);
    return c.json({ data: store.listMembers(ws.workspaceId, c.req.param('id')) }, 201);
  });

  app.delete('/:id/members/:agentId', (c) => {
    const ws = getWorkspace(c);
    store.removeMember(ws.workspaceId, c.req.param('id'), c.req.param('agentId'));
    return c.json({ data: { ok: true } });
  });

  /**
   * The App's cast (Phase R) — members joined with agent identity, the operator
   * marked, ordered operator-first. Powers the Team strip in the App view.
   */
  app.get('/:id/team', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    const app = store.get(ws.workspaceId, appId);
    const rows = deps.db
      .select({
        agentId: schema.appMembers.agentId,
        memberRole: schema.appMembers.role,
        name: schema.agents.name,
        functionalRole: schema.agents.role,
        colorHex: schema.agents.colorHex,
        avatarGlyph: schema.agents.avatarGlyph,
        status: schema.agents.status,
      })
      .from(schema.appMembers)
      .innerJoin(schema.agents, eq(schema.agents.id, schema.appMembers.agentId))
      .where(and(eq(schema.appMembers.appId, appId), eq(schema.agents.workspaceId, ws.workspaceId)))
      .all();
    const members = rows
      .map((r) => ({ ...r, isOwner: r.agentId === app.ownerAgentId }))
      .sort((a, b) => Number(b.isOwner) - Number(a.isOwner) || (a.memberRole === 'operator' ? -1 : 1));
    return c.json({ data: { ownerAgentId: app.ownerAgentId, members } });
  });

  // ── Live conversations (Living Apps Phase 1) ────────────────
  // The App's real customer threads — the `conversations`/`messages` spine
  // scoped to this App (conversations.app_id), NOT a datastore snapshot. Powers
  // the live Inbox/ChatThread nodes (source:'conversations').

  app.get('/:id/conversations', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId); // 404s if the App is not in this workspace
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
    const rows = deps.db
      .select({
        id: schema.conversations.id,
        title: schema.conversations.title,
        channelChatId: schema.conversations.channelChatId,
        lastMessageAt: schema.conversations.lastMessageAt,
        unreadCount: schema.conversations.unreadCount,
        handoffState: schema.conversations.handoffState,
        handoffSource: schema.conversations.handoffSource,
        handoffClaimedAt: schema.conversations.handoffClaimedAt,
        automationEpoch: schema.conversations.automationEpoch,
        needsAttention: schema.conversations.needsAttention,
        needsAttentionReason: schema.conversations.needsAttentionReason,
        kind: schema.channelConnections.kind,
      })
      .from(schema.conversations)
      .leftJoin(schema.channelConnections, eq(schema.channelConnections.id, schema.conversations.channelConnectionId))
      .where(and(eq(schema.conversations.workspaceId, ws.workspaceId), eq(schema.conversations.appId, appId)))
      .orderBy(desc(schema.conversations.lastMessageAt))
      .limit(limit)
      .all();
    return c.json({ data: rows.map((r) => ({
      id: r.id,
      title: r.title ?? r.channelChatId ?? 'Conversation',
      channel: r.kind ?? null,
      lastMessageAt: r.lastMessageAt,
      unread: r.unreadCount ?? 0,
      handoffState: r.handoffState ?? null,
      handoffSource: r.handoffSource ?? null,
      handoffClaimedAt: r.handoffClaimedAt ?? null,
      automationEpoch: r.automationEpoch ?? 0,
      needsAttention: Boolean(r.needsAttention),
      needsAttentionReason: r.needsAttentionReason ?? null,
    })) });
  });

  app.get('/:id/conversations/:conversationId/messages', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    const conversationId = c.req.param('conversationId');
    // Authorize: the thread must belong to this App in this workspace.
    const conv = deps.db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(and(
        eq(schema.conversations.id, conversationId),
        eq(schema.conversations.workspaceId, ws.workspaceId),
        eq(schema.conversations.appId, appId),
      ))
      .get();
    if (!conv) throw new AgentisError('RESOURCE_NOT_FOUND', `conversation ${conversationId} not found in this app`);
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 500);
    const rows = deps.db
      .select({
        id: schema.conversationMessages.id,
        authorType: schema.conversationMessages.authorType,
        participantSide: schema.conversationMessages.participantSide,
        body: schema.conversationMessages.body,
        createdAt: schema.conversationMessages.createdAt,
        metadata: schema.conversationMessages.metadata,
      })
      .from(schema.conversationMessages)
      .where(eq(schema.conversationMessages.conversationId, conversationId))
      .orderBy(desc(schema.conversationMessages.createdAt))
      .limit(limit)
      .all();
    // Resolve the external conversation side independently from platform actor identity.
    const messages = rows.reverse().map((r) => {
      const resolvedRole = channelModelRole(r, true);
      const role: 'user' | 'agent' | 'system' = resolvedRole === 'assistant' ? 'agent' : resolvedRole;
      return { id: r.id, role, content: r.body, at: r.createdAt };
    });
    return c.json({ data: messages });
  });

  // Operator takeover (Phase 2): park the resident agent so a human drives the
  // thread, or hand it back. `active:false` returns control to the agent.
  app.post('/:id/conversations/:conversationId/takeover', async (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    const conversationId = c.req.param('conversationId');
    const parsed = takeoverSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw validationError('Invalid takeover input', parsed.error);
    const conv = deps.db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(and(eq(schema.conversations.id, conversationId), eq(schema.conversations.workspaceId, ws.workspaceId), eq(schema.conversations.appId, appId)))
      .get();
    if (!conv) throw new AgentisError('RESOURCE_NOT_FOUND', `conversation ${conversationId} not found in this app`);
    if (!deps.handoffs) throw new AgentisError('INTERNAL_ERROR', 'conversation handoff service is unavailable');
    const snapshot = parsed.data.active
      ? deps.handoffs.claimHuman({ workspaceId: ws.workspaceId, conversationId, source: 'explicit' })
      : deps.handoffs.releaseToAgent(ws.workspaceId, conversationId);
    return c.json({ data: { conversationId, handoffState: snapshot.state === 'human' ? 'human' : null, source: snapshot.source, claimedAt: snapshot.claimedAt, automationEpoch: snapshot.automationEpoch } });
  });

  // Operator send (Phase 2): post a human reply into the live thread and deliver it
  // to the origin channel. The customer sees one continuous agent — no seam.
  app.post('/:id/conversations/:conversationId/send', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    const conversationId = c.req.param('conversationId');
    const parsed = operatorSendSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw validationError('Invalid send input', parsed.error);
    const conv = deps.db
      .select({ id: schema.conversations.id, channelConnectionId: schema.conversations.channelConnectionId, channelChatId: schema.conversations.channelChatId })
      .from(schema.conversations)
      .where(and(eq(schema.conversations.id, conversationId), eq(schema.conversations.workspaceId, ws.workspaceId), eq(schema.conversations.appId, appId)))
      .get();
    if (!conv) throw new AgentisError('RESOURCE_NOT_FOUND', `conversation ${conversationId} not found in this app`);
    deps.handoffs?.claimHuman({ workspaceId: ws.workspaceId, conversationId, source: 'explicit' });
    const body = parsed.data.body.trim();
    const operatorDeliveryId = `operator_reply:${conversationId}:${randomUUID()}`;
    const outboundMessage = deps.conversations?.appendOutbound({
      workspaceId: ws.workspaceId,
      conversationId,
      operatorId: user.id,
      participantSide: 'business',
      sessionMessageId: operatorDeliveryId,
      body,
      deliveryStatus: conv.channelConnectionId && conv.channelChatId && deps.channels ? 'sending' : 'failed',
      metadata: { operatorTakeover: true, channelReply: true, ...(conv.channelChatId ? { channelChatId: conv.channelChatId } : {}) },
    });
    let delivered = false;
    let pending = false;
    let receipt: ChannelDeliveryReceipt | undefined;
    if (conv.channelConnectionId && conv.channelChatId && deps.channels) {
      try {
        receipt = await deps.channels.deliverToConnection({
          connectionId: conv.channelConnectionId,
          chatId: conv.channelChatId,
          body,
          idempotencyKey: operatorDeliveryId,
          actor: 'human',
          conversationId,
        });
        delivered = isAcknowledgedChannelDelivery(receipt);
        pending = !delivered;
      } catch {
        delivered = false;
      }
    }
    if (outboundMessage) {
      deps.conversations?.updateDeliveryStatus({
        workspaceId: ws.workspaceId,
        conversationId,
        messageId: outboundMessage.id,
        deliveryStatus: delivered ? (receipt?.status === 'delivered' || receipt?.status === 'read' ? 'delivered' : 'sent') : pending ? 'sending' : 'failed',
        ...(receipt ? { metadata: { channelDeliveryReceipt: receipt } } : {}),
      });
    }
    // Operator sends are exempt from rate/quiet limits (a human action) but still
    // recorded against the App's rolling window so the counter stays honest (G7).
    if (delivered) deps.outboundPolicy?.record(appId, 'operator');
    return c.json({ data: { conversationId, delivered, pending, ...(receipt ? { receipt } : {}) } });
  });

  // Needs-you flag (Phase 2): the operator clears (or sets) the "needs attention"
  // marker on a thread. The resident agent sets it via the agentis.conversation
  // .flag_needs_attention tool; clearing it here (active:false) is the operator
  // acknowledging — "I've got this". The console counts flagged threads.
  app.post('/:id/conversations/:conversationId/needs-attention', async (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    const conversationId = c.req.param('conversationId');
    const parsed = needsAttentionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw validationError('Invalid needs-attention input', parsed.error);
    const conv = deps.db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(and(eq(schema.conversations.id, conversationId), eq(schema.conversations.workspaceId, ws.workspaceId), eq(schema.conversations.appId, appId)))
      .get();
    if (!conv) throw new AgentisError('RESOURCE_NOT_FOUND', `conversation ${conversationId} not found in this app`);
    const active = parsed.data.active;
    deps.db.update(schema.conversations).set({
      needsAttention: active ? 1 : 0,
      needsAttentionReason: active ? (parsed.data.reason ?? null) : null,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.conversations.id, conversationId)).run();
    return c.json({ data: { conversationId, needsAttention: active, needsAttentionReason: active ? (parsed.data.reason ?? null) : null } });
  });

  // ── Live co-presence (Living Apps G9 · ephemeral) ──────────
  // The operator's console heartbeats POST /presence while open (and which thread
  // it has focused); the server keeps an in-memory roster (never persisted) and
  // broadcasts APP_PRESENCE_UPDATED so other viewers see who's present. DELETE on
  // unmount drops the viewer. Best-effort — a missing presence service is a no-op.
  app.post('/:id/presence', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId); // 404s if the App is not in this workspace
    if (!deps.presence) return c.json({ data: { viewers: [] } });
    const parsed = presenceHeartbeatSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw validationError('Invalid presence input', parsed.error);
    const profile = deps.db
      .select({ displayName: schema.users.displayName, username: schema.users.username })
      .from(schema.users)
      .where(eq(schema.users.id, user.id))
      .get();
    const viewers = deps.presence.join({
      workspaceId: ws.workspaceId,
      appId,
      userId: user.id,
      name: profile?.displayName || profile?.username || 'Operator',
      ...(parsed.data.conversationId !== undefined ? { conversationId: parsed.data.conversationId } : {}),
    });
    return c.json({ data: { viewers } });
  });

  app.delete('/:id/presence', (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    if (!deps.presence) return c.json({ data: { viewers: [] } });
    return c.json({ data: { viewers: deps.presence.leave(appId, user.id) } });
  });

  // ── Multi-party participants (Living Apps Phase 2 · G1) ─────
  // The cast in a thread beside conversations.agentId (the primary): a customer,
  // the resident agent, an escalation specialist, a human operator. An active
  // 'specialist' agent becomes the inbound responder (warm handoff); hand back by
  // removing it. Authorized exactly like the conversation routes above.

  const authorizeConversation = (workspaceId: string, appId: string, conversationId: string): void => {
    const conv = deps.db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(and(
        eq(schema.conversations.id, conversationId),
        eq(schema.conversations.workspaceId, workspaceId),
        eq(schema.conversations.appId, appId),
      ))
      .get();
    if (!conv) throw new AgentisError('RESOURCE_NOT_FOUND', `conversation ${conversationId} not found in this app`);
  };

  app.get('/:id/conversations/:conversationId/participants', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    const conversationId = c.req.param('conversationId');
    authorizeConversation(ws.workspaceId, appId, conversationId);
    if (!deps.participants) return c.json({ data: [] });
    // Seed the primary from conversations.agentId so the cast is never empty.
    deps.participants.ensurePrimary(conversationId);
    return c.json({ data: deps.participants.list(conversationId) });
  });

  app.post('/:id/conversations/:conversationId/participants', async (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    const conversationId = c.req.param('conversationId');
    authorizeConversation(ws.workspaceId, appId, conversationId);
    if (!deps.participants) throw new AgentisError('INTERNAL_ERROR', 'participants service unavailable');
    const parsed = addParticipantSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw validationError('Invalid participant input', parsed.error);
    if (parsed.data.participantType !== 'contact' && !parsed.data.participantId) {
      throw new AgentisError('VALIDATION_FAILED', 'participantId is required for agent/human participants');
    }
    deps.participants.ensurePrimary(conversationId);
    const id = deps.participants.add({
      conversationId,
      participantType: parsed.data.participantType,
      participantId: parsed.data.participantId ?? null,
      role: parsed.data.role,
      active: parsed.data.active,
    });
    if (!id) throw new AgentisError('INTERNAL_ERROR', 'failed to add participant');
    return c.json({ data: { id, participants: deps.participants.list(conversationId) } });
  });

  app.delete('/:id/conversations/:conversationId/participants/:participantId', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    const conversationId = c.req.param('conversationId');
    authorizeConversation(ws.workspaceId, appId, conversationId);
    if (!deps.participants) throw new AgentisError('INTERNAL_ERROR', 'participants service unavailable');
    const participantId = c.req.param('participantId');
    const removed = deps.participants.remove(conversationId, participantId);
    if (!removed) throw new AgentisError('RESOURCE_NOT_FOUND', `participant ${participantId} not found`);
    return c.json({ data: { id: participantId, participants: deps.participants.list(conversationId) } });
  });

  // ── Relationship pipeline (Living Apps Phase 3) ─────────────
  // The App's contacts (leads/customers) with pipeline state + the proactivity
  // clock. PATCH sets stage/goal/nextTouchAt — the follow-up sweep reads nextTouchAt.

  app.get('/:id/contacts', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    if (!deps.contacts) return c.json({ data: [] });
    const appRecord = store.get(ws.workspaceId, appId);
    const autonomy = appRecord.policy.autonomy;
    const data = deps.contacts.list(ws.workspaceId, appId).map((contact) => {
      const subject = contact.subjectId
        ? deps.db.select({ state: schema.durableEntities.stateJson }).from(schema.durableEntities)
            .where(and(eq(schema.durableEntities.workspaceId, ws.workspaceId), eq(schema.durableEntities.id, contact.subjectId))).get()
        : null;
      return {
        ...contact,
        relationship: subject?.state ?? null,
        autonomy: contact.subjectId ? autonomy?.subjectOverrides?.[contact.subjectId] ?? null : null,
      };
    });
    return c.json({ data });
  });

  app.patch('/:id/contacts/:contactId', async (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    if (!deps.contacts) throw new AgentisError('INTERNAL_ERROR', 'contacts service not available');
    const contactId = c.req.param('contactId');
    const current = deps.contacts.get(ws.workspaceId, contactId);
    if (!current || current.appId !== appId) throw new AgentisError('RESOURCE_NOT_FOUND', `contact ${contactId} not found in this app`);
    const parsed = contactPatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw validationError('Invalid contact patch', parsed.error);
    const updated = deps.contacts.update(ws.workspaceId, contactId, parsed.data);
    // Phase M2 — a stage transition into a terminal stage (won/lost) IS an outcome.
    // Derive it so the learning loop fires with no separate call (non-throwing).
    const derived = AppLearningStatic.outcomeForStage(parsed.data.stage);
    if (derived && deps.learning) {
      void deps.learning.recordOutcome({ workspaceId: ws.workspaceId, appId, contactId, outcome: derived })
        .catch(() => {});
    }
    return c.json({ data: updated });
  });

  /** Per-case autonomy override: widen or narrow one relationship without changing the App default. */
  app.patch('/:id/contacts/:contactId/autonomy', async (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    const appRecord = store.get(ws.workspaceId, appId);
    if (!deps.contacts) throw new AgentisError('INTERNAL_ERROR', 'contacts service not available');
    const contact = deps.contacts.get(ws.workspaceId, c.req.param('contactId'));
    if (!contact || contact.appId !== appId || !contact.subjectId) {
      throw new AgentisError('RESOURCE_NOT_FOUND', 'grounded relationship contact not found');
    }
    const patch = contactAutonomySchema.parse(await c.req.json().catch(() => ({})));
    const current = relationshipAutonomyPolicySchema.parse(appRecord.policy.autonomy ?? {});
    const next = relationshipAutonomyPolicySchema.parse({
      ...current,
      subjectOverrides: {
        ...current.subjectOverrides,
        [contact.subjectId]: { ...(current.subjectOverrides[contact.subjectId] ?? {}), ...patch },
      },
    });
    const updated = store.update(ws.workspaceId, appId, { policy: { autonomy: next } });
    return c.json({ data: { subjectId: contact.subjectId, autonomy: updated.policy.autonomy?.subjectOverrides[contact.subjectId] } });
  });

  // Phase M2 — explicitly record a terminal relationship outcome (won|lost|abandoned).
  // Stamps the contact, deposits a graded lesson into the owner agent's memory plane,
  // and triggers a scoped reflection pass that can graduate recurring wins into an
  // ability. Non-throwing in the service; the loop never breaks the call.
  app.post('/:id/contacts/:contactId/outcome', async (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    if (!deps.learning) throw new AgentisError('INTERNAL_ERROR', 'learning service not available');
    const contactId = c.req.param('contactId');
    if (deps.contacts) {
      const current = deps.contacts.get(ws.workspaceId, contactId);
      if (!current || current.appId !== appId) throw new AgentisError('RESOURCE_NOT_FOUND', `contact ${contactId} not found in this app`);
    }
    const parsed = contactOutcomeSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw validationError('Invalid outcome (expected won|lost|abandoned)', parsed.error);
    const result = await deps.learning.recordOutcome({
      workspaceId: ws.workspaceId,
      appId,
      contactId,
      outcome: parsed.data.outcome,
      note: parsed.data.note ?? null,
      setStage: parsed.data.setStage ?? null,
    });
    return c.json({ data: result });
  });

  // ── Conversation rehearsal (Phase 5 · G8) ───────────────────
  // Drive a synthetic customer through a scenario against the resident agent and
  // score the run BEFORE it talks to real money. Sandboxed — no real channel send,
  // the live thread is untouched. Deterministic when the scenario is scripted.
  /** Recent durable lessons formed by this App's real outcomes. */
  app.get('/:id/learnings', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    if (!deps.learning) return c.json({ data: { appId, ownerAgentId: null, lessons: [] } });
    return c.json({ data: deps.learning.recentLearnings(ws.workspaceId, appId) });
  });

  // Evolution Loop — the Goal dashboard: the App's Goal, its competing strategies +
  // measured stats, live experiments, performance baselines, and the controller's
  // current promote/retire/spawn recommendations. Computed on-demand from state.
  app.get('/:id/goal', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    const appRec = store.get(ws.workspaceId, appId); // authorize + 404 in-workspace
    const goal = deps.appGoal?.get(ws.workspaceId, appId) ?? appRec.manifest.goal ?? null;
    const strategies = deps.strategies?.list(ws.workspaceId, appId) ?? [];
    const decisions = deps.evolution?.evaluate(ws.workspaceId, appId) ?? [];
    const experiments = (deps.experiments?.listExperiments(ws.workspaceId) ?? [])
      .filter((e) => e.appId === appId)
      .map((e) => ({ key: e.key, status: e.status, variants: e.variantsJson, results: deps.experiments?.results(ws.workspaceId, e.key)?.variants ?? [] }));
    const baselines = deps.baselines?.latestForScope(ws.workspaceId, appId) ?? [];
    return c.json({ data: { appId, goal, strategies, decisions, experiments, baselines } });
  });

  app.post('/:id/simulate', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId); // authorize + 404 in-workspace
    if (!deps.simulator) throw new AgentisError('INTERNAL_ERROR', 'conversation simulator not available');
    const parsed = simulateRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw validationError('Invalid simulation scenario', parsed.error);
    const result = await deps.simulator.runScenario({
      workspaceId: ws.workspaceId,
      userId: user.id,
      appId,
      scenario: parsed.data.scenario,
      ...(parsed.data.agentId ? { agentId: parsed.data.agentId } : {}),
    });
    return c.json({ data: result });
  });

  // ── Workflow adoption ───────────────────────────────────────
  // Listing is handled by the richer `GET /:id/workflows` control-plane route
  // above (returns AppWorkflowSummary[], not bare ids).

  app.post('/:id/workflows', async (c) => {
    const ws = getWorkspace(c);
    const parsed = adoptWorkflowSchema.safeParse(await c.req.json());
    if (!parsed.success) throw validationError('Invalid adopt input', parsed.error);
    store.adoptWorkflow(ws.workspaceId, c.req.param('id'), parsed.data.workflowId);
    return c.json({ data: store.listWorkflowIds(ws.workspaceId, c.req.param('id')) });
  });

  // ── App analytics (§7.1) ────────────────────────────────────
  // App-level rollup across every workflow the app owns (an app can own many;
  // the per-workflow monitor shows one). Same metric shape + a per-workflow split.
  app.get('/:id/analytics', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    const appRow = store.get(ws.workspaceId, appId);
    if (!appRow) throw new AgentisError('RESOURCE_NOT_FOUND', `app not found: ${appId}`);
    const workflowIds = store.listWorkflowIds(ws.workspaceId, appId);
    const workflows = workflowIds.length > 0
      ? deps.db.select({ id: schema.workflows.id, title: schema.workflows.title, graph: schema.workflows.graph })
          .from(schema.workflows)
          .where(and(eq(schema.workflows.workspaceId, ws.workspaceId), inArray(schema.workflows.id, workflowIds)))
          .all()
          .map((row) => ({ id: row.id, title: row.title, graph: row.graph as WorkflowGraph }))
      : [];
    const analytics = aggregateRunAnalytics(deps.db, ws.workspaceId, workflows);
    return c.json({ appId, ...analytics });
  });

  // ── App Datastore (§5) ──────────────────────────────────────

  app.get('/:id/collections', (c) => {
    const ws = getWorkspace(c);
    return c.json({ data: data.listCollections(ws.workspaceId, c.req.param('id')) });
  });

  app.post('/:id/collections', async (c) => {
    const ws = getWorkspace(c);
    const parsed = defineCollectionSchema.safeParse(await c.req.json());
    if (!parsed.success) throw validationError('Invalid collection schema', parsed.error);
    return c.json({ data: data.defineCollection(ws.workspaceId, c.req.param('id'), parsed.data) }, 201);
  });

  app.post('/:id/collections/:name/query', async (c) => {
    const ws = getWorkspace(c);
    const parsed = dataQuerySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw validationError('Invalid query', parsed.error);
    return c.json(data.query(ws.workspaceId, c.req.param('id'), c.req.param('name'), parsed.data));
  });

  app.post('/:id/collections/:name/records', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const parsed = insertRecordSchema.safeParse(await c.req.json());
    if (!parsed.success) throw validationError('Invalid record', parsed.error);
    return c.json({ data: data.insert(ws.workspaceId, c.req.param('id'), c.req.param('name'), parsed.data.record, user.id) }, 201);
  });

  // Bulk insert — powers CSV/JSON data import. Validates each row; per-row failures
  // are collected (not fatal) and one realtime change fires for the whole batch.
  app.post('/:id/collections/:name/records/batch', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const parsed = batchInsertSchema.safeParse(await c.req.json());
    if (!parsed.success) throw validationError('Invalid batch', parsed.error);
    const result = data.insertMany(ws.workspaceId, c.req.param('id'), c.req.param('name'), parsed.data.records, user.id);
    return c.json({ data: result }, 201);
  });

  app.patch('/:id/collections/:name/records/:recordId', async (c) => {
    const ws = getWorkspace(c);
    const parsed = updateRecordSchema.safeParse(await c.req.json());
    if (!parsed.success) throw validationError('Invalid patch', parsed.error);
    return c.json({ data: data.update(ws.workspaceId, c.req.param('id'), c.req.param('name'), c.req.param('recordId'), parsed.data.patch) });
  });

  app.put('/:id/collections/:name/records', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const parsed = upsertRecordSchema.safeParse(await c.req.json());
    if (!parsed.success) throw validationError('Invalid upsert', parsed.error);
    return c.json({ data: data.upsert(ws.workspaceId, c.req.param('id'), c.req.param('name'), parsed.data.match, parsed.data.record, user.id) });
  });

  app.delete('/:id/collections/:name/records/:recordId', (c) => {
    const ws = getWorkspace(c);
    data.delete(ws.workspaceId, c.req.param('id'), c.req.param('name'), c.req.param('recordId'));
    return c.json({ data: { ok: true } });
  });

  // ── AG-UI surfaces (§4) ─────────────────────────────────────

  app.get('/:id/interface', (c) => {
    const ws = getWorkspace(c);
    return c.json({ data: interfaces.state(ws.workspaceId, c.req.param('id')) });
  });

  app.get('/:id/interface/revisions', (c) => {
    const ws = getWorkspace(c);
    return c.json({ data: interfaces.list(ws.workspaceId, c.req.param('id')) });
  });

  app.get('/:id/interface/revisions/:revisionId', (c) => {
    const ws = getWorkspace(c);
    return c.json({ data: interfaces.get(ws.workspaceId, c.req.param('id'), c.req.param('revisionId')) });
  });

  app.post('/:id/interface/candidates', async (c) => {
    const ws = getWorkspace(c);
    const parsed = interfaceCandidateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw validationError('Invalid interface candidate', parsed.error);
    const candidate = interfaces.createCandidate(
      ws.workspaceId,
      c.req.param('id'),
      parsed.data.pages as InterfacePageSnapshot[],
      {
        source: 'editor',
        actorType: 'user',
        actorId: c.get('user').id,
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
        ...(parsed.data.baseRevisionId ? { baseRevisionId: parsed.data.baseRevisionId } : {}),
      },
    );
    const verification = interfaces.verify(ws.workspaceId, c.req.param('id'), candidate.id);
    if (candidate.status === 'active') {
      return c.json({ data: { revision: candidate, verification, unchanged: true } }, 200);
    }
    if (parsed.data.autoPublish !== false && verification.passed) {
      return c.json({ data: { revision: interfaces.publish(ws.workspaceId, c.req.param('id'), candidate.id), verification } }, 201);
    }
    return c.json({ data: { revision: candidate, verification } }, 201);
  });

  app.post('/:id/interface/revisions/:revisionId/verify', (c) => {
    const ws = getWorkspace(c);
    return c.json({ data: interfaces.verify(ws.workspaceId, c.req.param('id'), c.req.param('revisionId')) });
  });

  app.post('/:id/interface/revisions/:revisionId/publish', (c) => {
    const ws = getWorkspace(c);
    return c.json({ data: interfaces.publish(ws.workspaceId, c.req.param('id'), c.req.param('revisionId')) });
  });

  app.post('/:id/interface/revisions/:revisionId/restore', (c) => {
    const ws = getWorkspace(c);
    return c.json({ data: interfaces.restore(ws.workspaceId, c.req.param('id'), c.req.param('revisionId'), c.get('user').id) });
  });

  app.delete('/:id/interface/revisions/:revisionId', (c) => {
    const ws = getWorkspace(c);
    interfaces.abandon(ws.workspaceId, c.req.param('id'), c.req.param('revisionId'));
    return c.json({ data: { ok: true } });
  });

  app.get('/:id/surfaces', (c) => {
    const ws = getWorkspace(c);
    return c.json({ data: surfaces.list(ws.workspaceId, c.req.param('id')) });
  });

  app.get('/:id/surfaces/:name', (c) => {
    const ws = getWorkspace(c);
    return c.json({ data: surfaces.get(ws.workspaceId, c.req.param('id'), c.req.param('name')) });
  });

  app.patch('/:id/surfaces/:name', async (c) => {
    const ws = getWorkspace(c);
    const parsed = renameSurfaceSchema.safeParse(await c.req.json());
    if (!parsed.success) throw validationError('Invalid surface name', parsed.error);
    return c.json({
      data: surfaces.rename(ws.workspaceId, c.req.param('id'), c.req.param('name'), parsed.data.name),
    });
  });

  app.delete('/:id/surfaces/:name', (c) => {
    const ws = getWorkspace(c);
    surfaces.delete(ws.workspaceId, c.req.param('id'), c.req.param('name'));
    return c.json({ data: { ok: true } });
  });

  app.put('/:id/surfaces', async (c) => {
    const ws = getWorkspace(c);
    const parsed = upsertSurfaceSchema.safeParse(await c.req.json());
    if (!parsed.success) throw validationError('Invalid surface', parsed.error);
    return c.json({ data: surfaces.upsert(ws.workspaceId, c.req.param('id'), parsed.data) });
  });

  app.post('/:id/surfaces/:name/render', async (c) => {
    const ws = getWorkspace(c);
    const parsed = uiRenderSchema.shape.view.safeParse((await c.req.json()).view);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 12).map((issue) => `${issue.path.join('.') || 'view'}: ${issue.message}`);
      throw new AgentisError('VALIDATION_FAILED', `Invalid view tree — ${issues.join('; ')}`);
    }
    return c.json({ data: surfaces.render(ws.workspaceId, c.req.param('id'), c.req.param('name'), parsed.data) });
  });

  // Perform a transient region into a stable AgentRegion slot (Phase M3 / G12).
  // Operator-driven pin/dismiss go through here too (pin:true freezes the
  // current performed child into the stored tree; clear:true dismisses it).
  app.post('/:id/surfaces/:name/perform-region', async (c) => {
    const ws = getWorkspace(c);
    const body = await c.req.json().catch(() => ({}));
    const parsed = uiPerformRegionSchema.safeParse({ ...body, surface: c.req.param('name') });
    if (!parsed.success) throw validationError('Invalid perform-region request', parsed.error);
    return c.json({
      data: surfaces.performRegion(ws.workspaceId, c.req.param('id'), parsed.data.surface, {
        region: parsed.data.region,
        ...(parsed.data.view !== undefined ? { view: parsed.data.view } : {}),
        ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
        ...(parsed.data.pin !== undefined ? { pin: parsed.data.pin } : {}),
        ...(parsed.data.clear !== undefined ? { clear: parsed.data.clear } : {}),
      }),
    });
  });

  // Agent-assisted surface authoring: NL prompt → validated ViewNode tree.
  // Falls back to a deterministic scaffold when no model is configured or the
  // model's output is unparseable, so the builder is never left empty.
  app.post('/:id/surfaces/generate', async (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    const parsed = generateSurfaceRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw validationError('prompt required', parsed.error);
    const result = await generateSurfaceView({
      prompt: parsed.data.prompt,
      collections: data.listCollections(ws.workspaceId, appId),
      workspaceId: ws.workspaceId,
      ...(parsed.data.surface ? { surface: parsed.data.surface } : {}),
      ...(deps.completer ? { completer: deps.completer } : {}),
    });
    return c.json({ data: result });
  });

  // ── Operator — the agent that runs this App (the agentic core) ──────────────
  // Presence (who is operating + live status) and a command line that runs the
  // App's entry workflow with the human's instruction, so directing the operator
  // produces real work the ActivityStream then narrates live.

  app.get('/:id/operator', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId); // 404s if the app is not in this workspace
    const members = deps.db
      .select({
        agentId: schema.agents.id,
        name: schema.agents.name,
        status: schema.agents.status,
        colorHex: schema.agents.colorHex,
        role: schema.appMembers.role,
      })
      .from(schema.appMembers)
      .innerJoin(schema.agents, eq(schema.agents.id, schema.appMembers.agentId))
      .where(and(eq(schema.appMembers.appId, appId), eq(schema.agents.workspaceId, ws.workspaceId)))
      .all();
    const operator = members.find((m) => m.role === 'operator') ?? members[0] ?? null;
    const hasWorkflow = store.listWorkflowIds(ws.workspaceId, appId).length > 0;
    return c.json({ data: operator ? { ...operator, canCommand: hasWorkflow && Boolean(deps.engine) } : null });
  });

  app.post('/:id/operator/command', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const appId = c.req.param('id');
    const parsed = operatorCommandSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw validationError('command required', parsed.error);
    if (!deps.engine) throw new AgentisError('VALIDATION_FAILED', 'operator commands are not enabled in this runtime');
    const workflowId = store.listWorkflowIds(ws.workspaceId, appId)[0];
    if (!workflowId) throw new AgentisError('VALIDATION_FAILED', 'this app has no workflow yet — add one so the operator can act');
    const wf = deps.db
      .select({ id: schema.workflows.id, ambientId: schema.workflows.ambientId, graph: schema.workflows.graph })
      .from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, ws.workspaceId), eq(schema.workflows.id, workflowId)))
      .get();
    if (!wf) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow not found: ${workflowId}`);
    const result = await runPublishedWorkflow({
      db: deps.db,
      engine: deps.engine,
      workspaceId: ws.workspaceId,
      ambientId: wf.ambientId ?? null,
      userId: user.id,
      workflowId: wf.id,
      graph: wf.graph as WorkflowGraph,
      inputs: { command: parsed.data.command },
    });
    return c.json({ data: result });
  });

  // ── Action dispatch — the click → backend loop (§4.4) ───────
  // V1 resolves `kind: 'data'` fully (form/button → datastore mutation →
  // DATA_CHANGED → bound views refetch). 'workflow'/'tool' actions require the
  // engine/tool runtime and are wired in a later pass; they return a clear error.

  app.post('/:id/surfaces/:name/actions/:action', async (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    const surface = surfaces.get(ws.workspaceId, appId, c.req.param('name'));
    const actionName = c.req.param('action');
    const action = surface.actions.find((a) => a.name === actionName);
    if (!action) throw new AgentisError('RESOURCE_NOT_FOUND', `action not declared: ${actionName}`);
    const argsRaw = (await c.req.json().catch(() => ({}))) as { args?: Record<string, unknown> };
    const callArgs = argsRaw.args ?? {};

    if (action.kind === 'data') {
      const [collection, op] = action.target.split('.');
      if (!collection || !op) throw new AgentisError('VALIDATION_FAILED', `data action target must be "collection.op": ${action.target}`);
      const user = c.get('user');
      switch (op) {
        case 'insert':
          return c.json({ data: data.insert(ws.workspaceId, appId, collection, (callArgs.record as Record<string, unknown>) ?? callArgs, user.id) });
        case 'update':
          return c.json({ data: data.update(ws.workspaceId, appId, collection, String(callArgs.id), (callArgs.patch as Record<string, unknown>) ?? {}) });
        case 'upsert':
          return c.json({ data: data.upsert(ws.workspaceId, appId, collection, (callArgs.match as Record<string, unknown>) ?? {}, (callArgs.record as Record<string, unknown>) ?? {}, user.id) });
        case 'delete':
          data.delete(ws.workspaceId, appId, collection, String(callArgs.id));
          return c.json({ data: { ok: true } });
        default:
          throw new AgentisError('VALIDATION_FAILED', `unknown data op: ${op}`);
      }
    }

    if (action.kind === 'workflow') {
      const user = c.get('user');
      const wf = deps.db
        .select({ id: schema.workflows.id, ambientId: schema.workflows.ambientId, graph: schema.workflows.graph })
        .from(schema.workflows)
        .where(and(eq(schema.workflows.workspaceId, ws.workspaceId), eq(schema.workflows.appId, appId), eq(schema.workflows.id, action.target)))
        .get();
      if (!wf) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow not found: ${action.target}`);
      if (!deps.engine) throw new AgentisError('VALIDATION_FAILED', 'workflow actions are not enabled in this runtime');
      // Responsive, non-blackbox invoke: give a fast/deterministic workflow a
      // short budget to return its output inline, but never hang the App
      // interface for the whole run. After the budget we return { runId, status,
      // terminal:false } so the caller can subscribe to the run's realtime room
      // (REALTIME_ROOMS.run) — and the bound surfaces keep updating live via
      // DATA_CHANGED as the workflow writes rows in the background.
      const result = await runPublishedWorkflow({
        db: deps.db,
        engine: deps.engine,
        workspaceId: ws.workspaceId,
        ambientId: wf.ambientId ?? null,
        userId: user.id,
        workflowId: wf.id,
        graph: wf.graph as WorkflowGraph,
        inputs: callArgs,
        timeoutMs: 2_500,
      });
      return c.json({ data: result });
    }

    if (action.kind === 'tool') {
      if (!deps.toolRuntime) throw new AgentisError('VALIDATION_FAILED', 'tool actions are not enabled in this runtime');
      const user = c.get('user');
      const res = await deps.toolRuntime.execute(ws.workspaceId, action.target as AgentTool, callArgs, undefined, { appId, agentId: user.id });
      if (!res.ok) throw new AgentisError('VALIDATION_FAILED', res.error ?? 'tool execution failed');
      return c.json({ data: res.result });
    }

    if (action.kind === 'navigate' || action.kind === 'setState') {
      throw new AgentisError('VALIDATION_FAILED', `${action.kind} actions are handled by @agentis/app-client`);
    }

    if (action.kind === 'capability') {
      throw new AgentisError('VALIDATION_FAILED', 'capability actions must be invoked through /v1/capabilities in this runtime');
    }

    throw new AgentisError('VALIDATION_FAILED', `unknown action kind: ${String(action.kind)}`);
  });

  return app;
}

/** Read an App→workflow binding off the workflow's `settings.appBinding` (safe defaults). */
function readAppWorkflowBinding(settings: unknown): AppWorkflowBinding {
  const raw = settings && typeof settings === 'object' ? (settings as Record<string, unknown>).appBinding : undefined;
  const parsed = appWorkflowBindingSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { dependsOn: [] };
}

/** The trigger kind of a workflow graph (manual | cron | webhook | …), or null. */
function triggerKindOf(graph: WorkflowGraph | null | undefined): string | null {
  const trigger = graph?.nodes?.find((node) => node.config?.kind === 'trigger');
  return trigger && 'triggerType' in trigger.config ? String((trigger.config as { triggerType?: unknown }).triggerType ?? '') || null : null;
}
