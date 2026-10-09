/**
 * /v1/workflows — list/get/create/update + run trigger.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  AgentisError,
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  schemas,
  summarizeGraphCapabilities,
  type IntegrationDeliveryReceipt,
  type WorkflowGraph,
  type WorkflowRunState,
} from '@agentis/core';
import { buildIntegrationDeliveryReceipt } from '@agentis/integrations';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import type { TriggerRuntime } from '../engine/TriggerRuntime.js';
import type { EventBus } from '../event-bus.js';
import type { PackagerService } from '../services/packager.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { validateWorkflowGraph } from '../engine/validateGraph.js';
import { validateGraphReferences } from '../engine/validateGraphReferences.js';
import { analyzeWorkflowReadiness } from '../services/workflow/workflowReadiness.js';
import { buildInitialRunState } from '../engine/initialRunState.js';
import { hashWorkflowGraph } from '../services/graphHash.js';
import { normalizeWorkflowGraph } from '../services/workflow/workflowGraphNormalization.js';
import { buildTemplateContext, resolveTemplateDeep } from '../engine/templateResolver.js';
import { WorkflowTriggerDeploymentService } from '../services/workflow/workflowTriggerDeployment.js';
import { preflightWorkflow } from '../services/workflow/workflowPreflight.js';
import { LOOP_STAGE_LABEL, compassForWorkflow, deriveLoopStage, detectProvenDivergence, graphContentHash, readBuildLoop } from '../services/workflow/workflowCompass.js';
import { WorkflowRevisionService } from '../services/workflow/workflowRevisionService.js';
import type { WorkflowExperienceService } from '../services/workflow/workflowExperienceService.js';
import { readWorkflowTests, type WorkflowTestCase } from '../services/workflow/workflowTestGenerator.js';
import { readWorkflowSpec } from '../services/workflow/workflowSpec.js';
import { evalCondition } from '../engine/SafeConditionParser.js';
import { resolveWorkflowExecutionTarget } from '../services/workflow/workflowExecutionTarget.js';
import type { AgentMissionService } from '../services/agentMissions.js';

export function buildWorkflowRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  engine: WorkflowEngine;
  bus: EventBus;
  triggerRuntime?: TriggerRuntime;
  revisions?: WorkflowRevisionService;
  experience?: WorkflowExperienceService;
  missions?: AgentMissionService;
  /** Optional: when provided, every create/update mirrors the workflow into Packages. */
  packager?: PackagerService;
}) {
  const app = new Hono();

  // Legacy Studio public-surface route removed — public sharing now lives on the
  // Agentic App surface (AGENTIC-APPS-10X §4: GET /v1/apps/public/surfaces/:token).

  app.use('*', requireAuth(deps), requireWorkspace(deps));
  const deletedWorkflowsCache = new Map<string, any>();
  const revisions = deps.revisions ?? new WorkflowRevisionService(deps.db);
  const loadEditorWorkflow = (workspaceId: string, workflowId: string) => {
    const workflow = loadWorkflow(deps.db, workspaceId, workflowId);
    const candidate = revisions.candidate(workspaceId, workflowId);
    return candidate
      ? { ...workflow, graph: candidate.graph, editorRevisionId: candidate.revision.id }
      : { ...workflow, editorRevisionId: workflow.activeRevisionId };
  };
  const triggerDeployments = deps.triggerRuntime
    ? new WorkflowTriggerDeploymentService(deps.db, deps.triggerRuntime)
    : null;

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.workspaceId, ws.workspaceId))
      .all();
    const latestRuns = loadLatestRunsByWorkflow(deps.db, ws.workspaceId, rows.map((row) => row.id));
    const triggerMap = resolveTriggerTypes(
      deps.db,
      [...latestRuns.values()].map((run) => run.triggerId),
    );
    return c.json({
      workflows: rows.map((row) => presentWorkflowListItem(row, latestRuns.get(row.id), triggerMap)),
    });
  });

  // ── Workflow collections (UI grouping) ────────────────────────────────
  // A "collection" is a free-form string operators assign in workflow
  // settings.collection. We expose distinct collection names + counts so the
  // Workflows page can render named groups ("Growth Funnel", "Onboarding").
  app.get('/collections', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.db
      .select({
        id: schema.workflows.id,
        settings: schema.workflows.settings,
        title: schema.workflows.title,
      })
      .from(schema.workflows)
      .where(eq(schema.workflows.workspaceId, ws.workspaceId))
      .all();
    const counts = new Map<string, number>();
    for (const row of rows) {
      const collection = (
        ((row.settings as Record<string, unknown> | null) ?? {}).collection as string | undefined
      )?.trim();
      if (!collection) continue;
      counts.set(collection, (counts.get(collection) ?? 0) + 1);
    }
    const collections = Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ collections });
  });

  // Workspace-wide "always-on" workflows: every workflow whose entry trigger is
  // currently ARMED (schedule / webhook / listener), with next-run / last-fired /
  // last-run / listener health. Powers /home's Active section.
  app.get('/active', (c) => {
    const ws = getWorkspace(c);
    if (!triggerDeployments) return c.json({ workflows: [] });
    return c.json({ workflows: triggerDeployments.listActive(ws.workspaceId) });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = schemas.createWorkflowSchema.parse({
      ...(await c.req.json()),
      workspaceId: ws.workspaceId,
    });
    const requestedGraph = (body.graph ?? {
      version: 1,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    }) as WorkflowGraph;
    const normalizedGraph = normalizeWorkflowGraph(deps.db, ws.workspaceId, requestedGraph).graph;
    const emptyGraph: WorkflowGraph = {
      version: 1,
      nodes: [],
      edges: [],
      viewport: normalizedGraph.viewport ?? { x: 0, y: 0, zoom: 1 },
    };
    const id = randomUUID();
    if (body.spaceId) ensureWorkflowSpace(deps.db, ws.workspaceId, body.spaceId);
    if (normalizedGraph.nodes.length > 0)
      validateWorkflowGraph(normalizedGraph, { currentWorkflowId: id, strict: false });
    deps.db
      .insert(schema.workflows)
      .values({
        id,
        workspaceId: ws.workspaceId,
        ambientId: ws.ambientId ?? body.ambientId ?? null,
        userId: ws.user.id,
        spaceId: body.spaceId ?? null,
        ownerAgentId: body.ownerAgentId ?? null,
        title: body.title,
        description: body.description?.trim() || null,
        graph: emptyGraph,
        contentHash: hashWorkflowGraph(emptyGraph),
        settings: body.settings,
        concurrencyOverflow: 'queue',
      })
      .run();
    const initial = revisions.ensureWorkflow(ws.workspaceId, id);
    const candidate = normalizedGraph.nodes.length > 0
      ? revisions.createCandidate({
          workspaceId: ws.workspaceId,
          workflowId: id,
          graph: normalizedGraph,
          baseRevisionId: initial.active.id,
          source: 'create',
          actor: { type: 'user', id: ws.user.id },
          reason: 'Initial workflow implementation',
        }).revision
      : null;
    // 10.14: auto-save into the Packages library
    try {
      deps.packager?.mirrorWorkflow(
        { workspaceId: ws.workspaceId, ambientId: ws.ambientId ?? null, userId: ws.user.id },
        id,
      );
    } catch {
      /* best-effort mirror */
    }
    return c.json({
      workflow: {
        id,
        ...body,
        graph: candidate ? candidate.graphJson : emptyGraph,
        contentHash: candidate?.semanticHash ?? initial.active.semanticHash,
        activeRevision: presentRevision(initial.active),
        candidateRevision: candidate ? presentRevision(candidate) : null,
        trustState: candidate ? 'candidate' : 'legacy_unverified',
      },
    }, 201);
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const wf = loadEditorWorkflow(ws.workspaceId, id);
    revisions.reconcileLegacyWorkflow(ws.workspaceId, id);
    const active = revisions.active(ws.workspaceId, id);
    const candidate = revisions.candidate(ws.workspaceId, id);
    return c.json({
      workflow: {
        ...wf,
        graph: candidate?.graph ?? active.graph,
        contentHash: candidate?.revision.semanticHash ?? active.revision.semanticHash,
        activeGraphHash: active.revision.semanticHash,
        activeRevision: presentRevision(active.revision),
        candidateRevision: candidate ? presentRevision(candidate.revision) : null,
        trustState: candidate ? 'candidate' : active.revision.trustState,
      },
    });
  });

  app.get('/:id/revisions', (c) => {
    const ws = getWorkspace(c);
    const workflowId = c.req.param('id');
    const workflow = revisions.active(ws.workspaceId, workflowId).workflow;
    const rows = revisions.revisions(ws.workspaceId, workflowId);
    return c.json({
      activeRevisionId: workflow.activeRevisionId,
      candidateRevisionId: workflow.candidateRevisionId,
      trustState: workflow.trustState,
      revisions: rows.map((revision) => ({
        ...presentRevision(revision),
        proof: revisions.proofState(ws.workspaceId, workflowId, revision.id),
      })),
    });
  });

  // User-facing history contains publication milestones only. Draft, proof,
  // and autosave revisions remain available through the agent-facing revision
  // API above, but are deliberately not presented as workflow versions.
  app.get('/:id/versions', (c) => {
    const ws = getWorkspace(c);
    const workflowId = c.req.param('id');
    const workflow = revisions.active(ws.workspaceId, workflowId).workflow;
    const published = revisions.revisions(ws.workspaceId, workflowId)
      .filter((revision) => Boolean(revision.promotedAt))
      .sort((a, b) => {
        const promoted = String(a.promotedAt).localeCompare(String(b.promotedAt));
        return promoted || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
      });
    return c.json({
      currentVersionId: workflow.activeRevisionId,
      versions: published.map((revision, index) => ({
        id: revision.id,
        number: index + 1,
        label: `Version ${index + 1}`,
        isCurrent: revision.id === workflow.activeRevisionId,
        publishedAt: revision.promotedAt,
        actor: { type: revision.actorType, id: revision.actorId },
        source: revision.source,
        summary: revision.reason,
        changeSummary: revision.changeSummaryJson,
      })).reverse(),
    });
  });

  app.get('/:id/revisions/:revisionId', (c) => {
    const ws = getWorkspace(c);
    const workflowId = c.req.param('id');
    const revision = revisions.revision(ws.workspaceId, workflowId, c.req.param('revisionId'));
    if (!revision) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workflow revision not found');
    return c.json({
      revision: {
        ...presentRevision(revision),
        graph: revision.graphJson,
        changeSummary: revision.changeSummaryJson,
        capabilityManifest: revision.capabilityManifestJson,
        spec: revision.specJson,
      },
      proof: revisions.proofState(ws.workspaceId, workflowId, revision.id),
    });
  });

  app.get('/:id/experience', (c) => {
    const ws = getWorkspace(c);
    const workflowId = c.req.param('id');
    const workflow = revisions.active(ws.workspaceId, workflowId).workflow;
    return c.json({
      dossier: deps.experience?.dossier({
        workspaceId: ws.workspaceId,
        workflowId,
        appId: workflow.appId,
        activeRevisionId: workflow.activeRevisionId,
        candidateRevisionId: workflow.candidateRevisionId,
      }) ?? null,
    });
  });

  app.post('/:id/revisions/:revisionId/verify', async (c) => {
    const ws = getWorkspace(c);
    const workflowId = c.req.param('id');
    const revisionId = c.req.param('revisionId');
    const revision = revisions.revision(ws.workspaceId, workflowId, revisionId);
    if (!revision) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workflow revision not found');
    if (revision.status === 'active') {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'The active revision is already deployed; verify a candidate revision.');
    }
    const body = (await c.req.json().catch(() => ({}))) as { inputs?: Record<string, unknown> };
    const inputs = body.inputs && typeof body.inputs === 'object' && !Array.isArray(body.inputs) ? body.inputs : {};
    const graph = revision.graphJson as WorkflowGraph;
    let staticError: string | null = null;
    try {
      validateWorkflowGraph(graph, { currentWorkflowId: workflowId });
      const referenceErrors = validateGraphReferences(graph).filter((issue) => issue.severity === 'error');
      if (referenceErrors.length > 0) throw new Error(referenceErrors.map((issue) => issue.message).join('; '));
    } catch (error) {
      staticError = (error as Error).message;
    }
    revisions.recordProof({
      workspaceId: ws.workspaceId,
      workflowId,
      revisionId,
      gate: 'static',
      status: staticError ? 'failed' : 'passed',
      evidence: staticError ? { error: staticError } : { validated: true },
    });
    if (staticError) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', `Static verification failed: ${staticError}`);
    }

    const report = preflightWorkflow({
      db: deps.db,
      workspaceId: ws.workspaceId,
      workflowId,
      graph,
      inputs,
      mode: 'canvas',
    });
    const capabilityIssues = report.issues.filter((issue) =>
      /(?:CAPABILITY|CREDENTIAL|EXTENSION|INTEGRATION|AGENT_(?:NOT_FOUND|PAUSED|NO_RUNTIME)|OPERATION)/.test(issue.code)
      && issue.severity === 'error');
    revisions.recordProof({
      workspaceId: ws.workspaceId,
      workflowId,
      revisionId,
      gate: 'capability',
      status: capabilityIssues.length === 0 ? 'passed' : 'failed',
      evidence: { issues: capabilityIssues },
    });
    const blocking = report.issues.filter((issue) => issue.severity === 'error');
    revisions.recordProof({
      workspaceId: ws.workspaceId,
      workflowId,
      revisionId,
      gate: 'dry_run',
      status: blocking.length === 0 ? 'passed' : 'failed',
      evidence: { status: report.status, issues: blocking, scenario: report.scenario },
    });

    const workflow = revisions.active(ws.workspaceId, workflowId).workflow;
    const suite = readWorkflowTests(workflow.settings).filter((testCase) => testCase.origin !== 'generated');
    const suiteResults = suite.map((testCase) =>
      verifyRevisionCase(deps.db, ws.workspaceId, workflowId, graph, testCase));
    const hasHappy = suite.some((testCase) => testCase.kind === 'happy');
    const hasNonHappy = suite.some((testCase) => testCase.kind !== 'happy');
    const regressionPassed = hasHappy && hasNonHappy && suiteResults.every((result) => result.passed);
    revisions.recordProof({
      workspaceId: ws.workspaceId,
      workflowId,
      revisionId,
      gate: 'regression',
      status: regressionPassed ? 'passed' : 'failed',
      evidence: { hasHappy, hasNonHappy, results: suiteResults },
    });
    if (blocking.length > 0 || capabilityIssues.length > 0 || !regressionPassed) {
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        'Candidate verification stopped before real execution because deterministic gates failed.',
        {
          details: {
            proof: revisions.proofState(ws.workspaceId, workflowId, revisionId),
            blocking,
            suiteResults,
          },
        },
      );
    }

    const runId = randomUUID();
    const mission = deps.missions ? createWorkflowMission(deps.db, deps.missions, ws.workspaceId, workflowId, runId, graph) : null;
    const state = buildInitialRunState({ runId, workflowId, graph, inputs });
    deps.db.insert(schema.workflowRuns).values({
      id: runId,
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      workflowId,
      missionId: mission?.id ?? null,
      userId: ws.user.id,
      status: 'CREATED',
      runState: state,
      graphSnapshot: graph,
      workflowRevisionId: revisionId,
      triggerId: null,
    }).run();
    await deps.engine.startRun({
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      workflowId,
      userId: ws.user.id,
      triggerId: null,
      inputs,
      initialState: state,
      graph,
      workflowRevisionId: revisionId,
      debugRun: true,
    });
    return c.json({
      runId,
      missionId: mission?.id ?? null,
      revisionId,
      mode: 'debug',
      selfHealEnabled: false,
      proof: revisions.proofState(ws.workspaceId, workflowId, revisionId),
    }, 202);
  });

  app.post('/:id/revisions/:revisionId/promote', async (c) => {
    const ws = getWorkspace(c);
    const workflowId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      operatorApproval?: boolean;
      overrideReason?: string;
    };
    const operator = deps.db.select({ isAdmin: schema.users.isAdmin })
      .from(schema.users).where(eq(schema.users.id, ws.user.id)).get();
    if ((body.overrideReason?.trim() || body.operatorApproval === true) && !operator?.isAdmin) {
      throw new AgentisError('AUTH_FORBIDDEN', 'Workflow revision activation requires an administrator.');
    }
    const workflow = revisions.active(ws.workspaceId, workflowId).workflow;
    if (!workflow.activeRevisionId) throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'Workflow has no active base revision');
    const result = revisions.promote({
      workspaceId: ws.workspaceId,
      workflowId,
      revisionId: c.req.param('revisionId'),
      expectedActiveRevisionId: workflow.activeRevisionId,
      actor: { type: 'user', id: ws.user.id },
      operatorApproval: body.operatorApproval === true,
      overrideReason: body.overrideReason,
    });
    try {
      deps.packager?.mirrorWorkflow(
        { workspaceId: ws.workspaceId, ambientId: ws.ambientId ?? null, userId: ws.user.id },
        workflowId,
      );
    } catch {
      /* best-effort mirror */
    }
    return c.json({ ok: true, promotion: result });
  });

  app.post('/:id/revisions/:revisionId/abandon', async (c) => {
    const ws = getWorkspace(c);
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    revisions.abandon({
      workspaceId: ws.workspaceId,
      workflowId: c.req.param('id'),
      revisionId: c.req.param('revisionId'),
      actor: { type: 'user', id: ws.user.id },
      reason: body.reason?.trim() || 'Abandoned by operator',
    });
    return c.json({ ok: true });
  });

  app.post('/:id/revisions/:revisionId/restore', async (c) => {
    const ws = getWorkspace(c);
    const workflowId = c.req.param('id');
    const source = revisions.revision(ws.workspaceId, workflowId, c.req.param('revisionId'));
    if (!source) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workflow revision not found');
    if (!source.promotedAt) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'Only a published workflow version can be restored');
    }
    const workflow = revisions.active(ws.workspaceId, workflowId).workflow;
    const restored = revisions.createCandidate({
      workspaceId: ws.workspaceId,
      workflowId,
      graph: source.graphJson as WorkflowGraph,
      baseRevisionId: workflow.candidateRevisionId ?? workflow.activeRevisionId,
      source: 'rollback',
      actor: { type: 'user', id: ws.user.id },
      reason: `Restore revision ${source.id} as a new candidate`,
      allowBranch: true,
    });
    return c.json({ ok: true, candidateRevision: presentRevision(restored.revision) });
  });

  /**
   * GET /:id/capabilities — pre-run security/audit summary (NATIVE-ADVANCEMENT
   * Proposal 6b). Aggregates every node's capability manifest into "what does
   * this workflow actually touch" — external hosts, credentials, code execution
   * — so the canvas can surface it before a run. Also returns `contentHash` so
   * the client can detect divergence between its local graph and the saved one.
   */
  app.get('/:id/capabilities', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const wf = loadEditorWorkflow(ws.workspaceId, id);
    const graph = wf.graph as WorkflowGraph;
    return c.json({
      contentHash: (wf as { contentHash?: string | null }).contentHash ?? null,
      capabilities: summarizeGraphCapabilities(graph),
    });
  });

  /**
   * GET /:id/lint — static template-reference check (NATIVE-ADVANCEMENT
   * Proposal 2, reframed). Surfaces `{{nodes.X}}` references that are dangling
   * (X doesn't exist) or forward (X isn't upstream, so it won't have run yet) —
   * the bug class that otherwise resolves silently to empty input. Intended for
   * canvas annotations before a run; non-mutating.
   */
  app.get('/:id/lint', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const wf = loadEditorWorkflow(ws.workspaceId, id);
    const issues = validateGraphReferences(wf.graph as WorkflowGraph);
    return c.json({
      issues,
      errorCount: issues.filter((i) => i.severity === 'error').length,
      warningCount: issues.filter((i) => i.severity === 'warning').length,
    });
  });

  /**
   * GET /:id/readiness — plain-language setup the workflow still needs before it
   * can actually run (connect an account, supply credentials). Connector-agnostic
   * and advisory; lets the UI/chat ask intelligently instead of dead-ending a run.
   */
  app.get('/:id/readiness', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const wf = loadEditorWorkflow(ws.workspaceId, id);
    return c.json(analyzeWorkflowReadiness(deps.db, ws.workspaceId, wf.graph as WorkflowGraph));
  });

  app.get('/:id/health', (c) => {
    const ws = getWorkspace(c);
    const wf = loadEditorWorkflow(ws.workspaceId, c.req.param('id'));
    return c.json(preflightWorkflow({
      db: deps.db,
      workspaceId: ws.workspaceId,
      workflowId: wf.id,
      graph: wf.graph as WorkflowGraph,
    }));
  });

  app.post('/:id/preflight', async (c) => {
    const ws = getWorkspace(c);
    const wf = loadEditorWorkflow(ws.workspaceId, c.req.param('id'));
    const body = (await c.req.json().catch(() => ({}))) as { inputs?: Record<string, unknown> };
    return c.json(preflightWorkflow({
      db: deps.db,
      workspaceId: ws.workspaceId,
      workflowId: wf.id,
      graph: wf.graph as WorkflowGraph,
      inputs: body.inputs,
    }));
  });

  // PAVED-ROAD P5 — where this workflow stands on the build loop (authored →
  // dry-run → debug-run → production), with staleness vs the CURRENT graph and
  // the exact next step. Same substrate the agent tools read.
  app.get('/:id/loop-status', (c) => {
    const ws = getWorkspace(c);
    const wf = loadEditorWorkflow(ws.workspaceId, c.req.param('id'));
    const graph = wf.graph as WorkflowGraph;
    const state = readBuildLoop(wf.settings);
    const hash = graphContentHash(graph);
    const stage = deriveLoopStage(state, hash);
    return c.json({
      workflowId: wf.id,
      stage,
      stageLabel: LOOP_STAGE_LABEL[stage],
      graphHash: hash,
      evidence: {
        validatedAt: state.validatedAt ?? null,
        dryRun: state.dryRun ? { ...state.dryRun, stale: state.dryRun.graphHash !== hash } : null,
        suite: state.suite ? { ...state.suite, stale: state.suite.graphHash !== hash } : null,
        debugRun: state.debugRun ? { ...state.debugRun, stale: state.debugRun.graphHash !== hash } : null,
        hardened: state.hardened ? { ...state.hardened, stale: state.hardened.graphHash !== hash } : null,
        productionRun: state.productionRun ? { ...state.productionRun, stale: state.productionRun.graphHash !== hash } : null,
      },
      // SWIFT-T: rolling production accomplishment (world-verified) — the health metric.
      outcomeHealth: state.outcomeHealth ?? null,
      // SWIFT proactive guard: non-null when the current graph was edited away from
      // a PROVEN blueprint/hardened version → UNVERIFIED, re-verify before running.
      divergence: detectProvenDivergence(state, hash, wf.id),
      compass: compassForWorkflow({ workflowId: wf.id, graph, settings: wf.settings }),
    });
  });

  app.get('/:id/reliability', (c) => {
    const ws = getWorkspace(c);
    const workflow = loadWorkflow(deps.db, ws.workspaceId, c.req.param('id'));
    const runs = deps.db.select({
      id: schema.workflowRuns.id,
      runState: schema.workflowRuns.runState,
    }).from(schema.workflowRuns).where(and(
      eq(schema.workflowRuns.workspaceId, ws.workspaceId),
      eq(schema.workflowRuns.workflowId, workflow.id),
    )).orderBy(desc(schema.workflowRuns.createdAt)).limit(200).all();
    const fingerprintCounts = new Map<string, number>();
    const failureClassCounts = new Map<string, number>();
    let healedRuns = 0;
    let repairPlans = 0;
    let recurrentBlocks = 0;
    for (const run of runs) {
      const incidents = Object.values((run.runState as WorkflowRunState).selfHealIncidents ?? {});
      if (incidents.length > 0) healedRuns += 1;
      for (const incident of incidents) {
        repairPlans += incident.plans?.length ?? 0;
        if (incident.recurrent) recurrentBlocks += 1;
        if (incident.failureFingerprint) {
          fingerprintCounts.set(incident.failureFingerprint, (fingerprintCounts.get(incident.failureFingerprint) ?? 0) + 1);
        }
        if (incident.failureClass) {
          failureClassCounts.set(incident.failureClass, (failureClassCounts.get(incident.failureClass) ?? 0) + 1);
        }
      }
    }
    const active = revisions.active(ws.workspaceId, workflow.id).revision;
    const candidate = revisions.candidate(ws.workspaceId, workflow.id)?.revision ?? null;
    const repairAttempts = deps.db.select().from(schema.workflowRepairAttempts).where(and(
      eq(schema.workflowRepairAttempts.workspaceId, ws.workspaceId),
      eq(schema.workflowRepairAttempts.workflowId, workflow.id),
    )).all();
    const selfHealRate = runs.length > 0 ? healedRuns / runs.length : 0;
    const recurrence = [...fingerprintCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([fingerprint, count]) => ({ fingerprint, count }))
      .sort((a, b) => b.count - a.count);
    return c.json({
      workflowId: workflow.id,
      windowRuns: runs.length,
      healedRuns,
      selfHealRate,
      repairPlans,
      recurrentBlocks,
      repairAttempts: repairAttempts.length,
      verifiedRepairs: repairAttempts.filter((attempt) => attempt.status === 'verified').length,
      recurrence,
      failureClasses: Object.fromEntries(failureClassCounts),
      activeRevision: {
        ...presentRevision(active),
        proof: revisions.proofState(ws.workspaceId, workflow.id, active.id),
      },
      candidateRevision: candidate
        ? {
            ...presentRevision(candidate),
            proof: revisions.proofState(ws.workspaceId, workflow.id, candidate.id),
          }
        : null,
      slo: {
        targetSelfHealRate: 0.05,
        healthy: selfHealRate <= 0.05,
        targetRepeatedFingerprintCount: 0,
        recurrenceHealthy: recurrence.length === 0,
      },
    });
  });

  app.get('/:id/deployment', (c) => {
    const ws = getWorkspace(c);
    if (!triggerDeployments) {
      throw new AgentisError('LISTENER_RUNTIME_UNAVAILABLE', 'Workflow trigger deployment is unavailable.');
    }
    return c.json({ deployment: triggerDeployments.get(ws.workspaceId, c.req.param('id')) });
  });

  app.post('/:id/activate', async (c) => {
    const ws = getWorkspace(c);
    if (!triggerDeployments) {
      throw new AgentisError('LISTENER_RUNTIME_UNAVAILABLE', 'Workflow trigger deployment is unavailable.');
    }
    // SWIFT arming gate: an explicit override (audited) may arm an unhardened workflow.
    const body = (await c.req.json().catch(() => ({}))) as { override?: { ack?: string } };
    const revisionState = revisions.active(ws.workspaceId, c.req.param('id'));
    const trusted = revisionState.workflow.trustState === 'proven'
      || revisionState.workflow.trustState === 'break_glass';
    const operator = deps.db.select({ isAdmin: schema.users.isAdmin })
      .from(schema.users)
      .where(eq(schema.users.id, ws.user.id))
      .get();
    const isAdmin = operator?.isAdmin === true;

    if (!trusted && !body.override?.ack?.trim() && !isAdmin) {
      throw new AgentisError(
        'AUTH_FORBIDDEN',
        'Unattended triggers require a proven active revision. Verify and promote the candidate, or use an audited override.',
        {
          details: {
            code: 'WORKFLOW_REVISION_UNPROVEN',
            activeRevisionId: revisionState.revision.id,
            trustState: revisionState.workflow.trustState,
          },
        },
      );
    }
    const deployment = await triggerDeployments.activate({
      workspaceId: ws.workspaceId,
      workflowId: c.req.param('id'),
      ambientId: ws.ambientId ?? null,
      userId: ws.user.id,
      ...(body.override?.ack?.trim() ? { override: { ack: String(body.override.ack) } } : {}),
    });
    emitWorkflowDeploymentChanged(deps.bus, ws.workspaceId, c.req.param('id'));
    return c.json({ deployment });
  });

  app.patch('/:id/deployment', async (c) => {
    const ws = getWorkspace(c);
    if (!triggerDeployments) {
      throw new AgentisError('LISTENER_RUNTIME_UNAVAILABLE', 'Workflow trigger deployment is unavailable.');
    }
    const body = schemas.workflowDeploymentStatusSchema.parse(await c.req.json());
    const deployment = await triggerDeployments.setStatus(
      ws.workspaceId,
      c.req.param('id'),
      body.status,
    );
    emitWorkflowDeploymentChanged(deps.bus, ws.workspaceId, c.req.param('id'));
    return c.json({ deployment });
  });

  app.patch('/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const wf = loadWorkflow(deps.db, ws.workspaceId, id);
    const body = schemas.updateWorkflowSchema.parse(await c.req.json());
    if (body.spaceId) ensureWorkflowSpace(deps.db, ws.workspaceId, body.spaceId);
    const normalizedGraph = body.graph
      ? normalizeWorkflowGraph(deps.db, ws.workspaceId, body.graph as WorkflowGraph).graph
      : undefined;
    const specChanged = body.settings !== undefined
      && JSON.stringify(readWorkflowSpec(body.settings))
        !== JSON.stringify(readWorkflowSpec(wf.settings));
    if (normalizedGraph)
      validateWorkflowGraph(normalizedGraph, { currentWorkflowId: id, strict: false });
    deps.db
      .update(schema.workflows)
      .set({
        title: body.title ?? wf.title,
        description:
          body.description === undefined
            ? wf.description
            : body.description?.trim() || null,
        spaceId: body.spaceId === undefined ? wf.spaceId : body.spaceId ?? null,
        ownerAgentId: body.ownerAgentId === undefined ? wf.ownerAgentId : body.ownerAgentId ?? null,
        settings: body.settings ?? (wf.settings as Record<string, unknown>),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workflows.id, id))
      .run();
    const selectedGraph = normalizedGraph
      ?? revisions.candidate(ws.workspaceId, id)?.graph
      ?? revisions.active(ws.workspaceId, id).graph;
    const candidateMutation = normalizedGraph || specChanged
      ? revisions.createCandidate({
          workspaceId: ws.workspaceId,
          workflowId: id,
          graph: selectedGraph,
          baseRevisionId: body.baseRevisionId,
          source: 'user_edit',
          actor: { type: 'user', id: ws.user.id },
          reason: normalizedGraph
            ? 'Saved from the workflow editor'
            : 'Updated workflow acceptance specification',
        })
      : null;
    // 10.14: keep the mirrored package in sync
    try {
      deps.packager?.mirrorWorkflow(
        { workspaceId: ws.workspaceId, ambientId: ws.ambientId ?? null, userId: ws.user.id },
        id,
      );
    } catch {
      /* best-effort mirror */
    }
    // SWIFT "warn previously": if this save edited a PROVEN workflow away from its
    // blueprint/hardened graph, tell the editor NOW — it is UNVERIFIED until it is
    // re-proven, and a proven workflow only breaks when it changes. The save still
    // succeeds (non-blocking); the warning steers to re-verify (or restore) next.
    const active = revisions.active(ws.workspaceId, id);
    // createCandidate is intentionally idempotent: an unchanged save can return
    // the active base revision, and a presentation-only save can auto-promote.
    // Neither is a candidate. Always read the authoritative head after mutation
    // instead of relabeling the mutation result as editable working state.
    const currentCandidate = revisions.candidate(ws.workspaceId, id)?.revision ?? null;
    return c.json({
      ok: true,
      activeRevision: presentRevision(active.revision),
      candidateRevision: currentCandidate ? presentRevision(currentCandidate) : null,
      trustState: currentCandidate ? 'candidate' : active.revision.trustState,
      ...(candidateMutation && currentCandidate ? {
        divergence: {
          workflowId: id,
          graphHash: currentCandidate.semanticHash,
          protectedGraphHash: active.revision.semanticHash,
          source: 'active_revision',
          message: 'Saved as an unverified candidate. Production continues to use the active revision.',
        },
      } : {}),
    });
  });

  app.post('/:id/run', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const body = schemas.runWorkflowSchema.parse(await c.req.json().catch(() => ({})));
    const target = resolveWorkflowExecutionTarget({
      db: deps.db,
      revisions,
      workspaceId: ws.workspaceId,
      workflowId: id,
      mode: body.mode === 'debug'
        ? 'candidate'
        : body.mode === 'latest'
          ? 'candidate_or_active'
          : 'active',
      // `latest` is deliberately server-authoritative. Ignore any accidental
      // client revision id so a stale editor can never override the current head.
      revisionId: body.mode === 'latest' ? undefined : body.revisionId,
    });
    const selected = target.revision;
    const rawGraph = target.graph;
    const normalized = normalizeWorkflowGraph(deps.db, ws.workspaceId, rawGraph);
    if (normalized.repairs.length > 0) {
      const existingCandidate = revisions.candidate(ws.workspaceId, id);
      const normalizedCandidate = revisions.createCandidate({
        workspaceId: ws.workspaceId,
        workflowId: id,
        graph: normalized.graph,
        baseRevisionId: selected.id,
        source: 'normalization',
        actor: { type: 'system', id: 'workflow-normalizer' },
        reason: `Execution normalization proposed ${normalized.repairs.length} semantic repair(s).`,
        allowBranch: true,
        setAsHead: !existingCandidate || existingCandidate.revision.id === selected.id,
      });
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        'The selected revision requires normalization and cannot be changed at run time. Verify the generated normalization candidate first.',
        { details: { candidateRevisionId: normalizedCandidate.revision.id, repairs: normalized.repairs } },
      );
    }
    const graph = rawGraph;
    if (graph.nodes.length === 0) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'Cannot run an empty workflow');
    }
    validateWorkflowGraph(graph, { currentWorkflowId: id });
    const health = preflightWorkflow({
      db: deps.db,
      workspaceId: ws.workspaceId,
      workflowId: id,
      graph,
      inputs: body.inputs,
      // Gate the REAL run against the EXACT input the engine will use — a missing
      // required input is blocked here with the field name instead of dead-ending
      // mid-run with a raw expression error.
      mode: 'run-gate',
    });
    if (health.status === 'blocked') {
      const first = health.issues.find((issue) => issue.severity === 'error');
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        `Workflow preflight failed${first ? `: ${first.nodeTitle ? `${first.nodeTitle}: ${first.message}` : first.message}${first.remediation ? ` — ${first.remediation}` : ''}` : ''}`,
      );
    }
    // Heal the stored row when the normalization actually changed something, so
    // the persisted graph matches what the engine will run (and so the next read
    // is a no-op). Skipping this left the database permanently out of sync.
    const runId = randomUUID();
    const mission = deps.missions ? createWorkflowMission(deps.db, deps.missions, ws.workspaceId, id, runId, graph) : null;
    const state = buildInitialRunState({
      runId,
      workflowId: id,
      graph,
      inputs: body.inputs,
    });

    deps.db
      .insert(schema.workflowRuns)
      .values({
        id: runId,
        workspaceId: ws.workspaceId,
        ambientId: ws.ambientId,
        workflowId: id,
        missionId: mission?.id ?? null,
        userId: ws.user.id,
        status: 'CREATED',
        runState: state,
        graphSnapshot: graph,
        workflowRevisionId: selected.id,
        triggerId: body.triggerId ?? null,
      })
      .run();
    // V1-SPEC §12: announce the run to the workspace before the engine
    // emits its first node event, so the dashboard's run history can flip
    // to CREATED state immediately.
    deps.bus.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.RUN_CREATED, {
      runId,
      missionId: mission?.id ?? null,
      workflowId: id,
      ambientId: ws.ambientId,
    });

    const debugRun = body.mode === 'debug'
      || (body.mode === 'latest' && selected.id !== target.workflow.activeRevisionId);
    await deps.engine.startRun({
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      workflowId: id,
      userId: ws.user.id,
      triggerId: body.triggerId ?? null,
      inputs: body.inputs,
      initialState: state,
      graph,
      workflowRevisionId: selected.id,
      debugRun,
    });

    // Return the immutable revision actually selected. Editor-head candidate runs
    // are explicit debug executions; active runs retain production self-healing.
    return c.json({
      runId,
      missionId: mission?.id ?? null,
      revisionId: selected.id,
      mode: body.mode,
      selfHealEnabled: !debugRun,
      trustState: selected.trustState,
    }, 202);
  });

  /**
   * POST /:id/nodes/:nodeId/test
   *
   * Dry-run a single node in isolation with the supplied inputs. Used by the
   * canvas Test tab so users can iterate on a node config without running
   * the entire workflow. Side-effecting nodes (integration, http_request,
   * agent_task, etc.) still hit real systems — this is a real dispatch
   * scoped to one node, not a mock.
   */
  app.post('/:id/nodes/:nodeId/test', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const nodeId = c.req.param('nodeId');
    loadWorkflow(deps.db, ws.workspaceId, id);
    const body = (await c.req.json().catch(() => ({}))) as { inputs?: Record<string, unknown> };
    const inputs =
      body.inputs && typeof body.inputs === 'object' && !Array.isArray(body.inputs)
        ? body.inputs
        : {};
    const result = await deps.engine.testNode({
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      userId: ws.user.id,
      workflowId: id,
      nodeId,
      inputs,
    });
    deps.bus.publish(
      REALTIME_ROOMS.workspace(ws.workspaceId),
      REALTIME_EVENTS.NODE_TEST_COMPLETED,
      {
        workflowId: id,
        nodeId,
        ok: result.ok,
        durationMs: result.durationMs,
      },
    );
    return c.json(result, result.ok ? 200 : 422);
  });

  // ── Workflow Page Redesign — Runs / Output tabs ────────────────────────
  // WORKFLOW-PAGE-REDESIGN.md: the workflow page answers two questions —
  // "what has this run?" (Runs tab) and "what did it produce?" (Output tab).

  /**
   * Scoped run history for one workflow. Drives the Runs tab.
   * Returns runs newest-first with operator-facing fields (lowercased status,
   * resolved trigger type, computed duration).
   */
  app.get('/:id/runs', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    loadWorkflow(deps.db, ws.workspaceId, id);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 30), 1), 100);
    const rows = deps.db
      .select()
      .from(schema.workflowRuns)
      .where(
        and(
          eq(schema.workflowRuns.workflowId, id),
          eq(schema.workflowRuns.workspaceId, ws.workspaceId),
        ),
      )
      .orderBy(desc(schema.workflowRuns.createdAt))
      .limit(limit)
      .all();
    const triggerMap = resolveTriggerTypes(
      deps.db,
      rows.map((r) => r.triggerId),
    );
    return c.json({ runs: rows.map((r) => mapRunSummary(r, triggerMap)) });
  });

  // One compact projection for canvas node labels. This intentionally avoids
  // the old N-per-node history fan-out.
  app.get('/:id/node-activity', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const rows = deps.db.select().from(schema.workflowRuns)
      .where(and(eq(schema.workflowRuns.workspaceId, ws.workspaceId), eq(schema.workflowRuns.workflowId, id)))
      .orderBy(desc(schema.workflowRuns.createdAt)).limit(40).all();
    const nodes: Record<string, { status: string; startedAt?: string; completedAt?: string; durationMs?: number }> = {};
    for (const run of rows) {
      const state = run.runState as WorkflowRunState | null;
      for (const node of Object.values(state?.nodeStates ?? {})) {
        if (!node || nodes[node.nodeId]) continue;
        const startedAt = node.startedAt;
        const completedAt = node.completedAt;
        const durationMs = startedAt && completedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) : undefined;
        nodes[node.nodeId] = { status: node.status, ...(startedAt ? { startedAt } : {}), ...(completedAt ? { completedAt } : {}), ...(durationMs !== undefined ? { durationMs } : {}) };
      }
    }
    return c.json({ nodes });
  });

  /** Output history, newest first, with immutable delivery artifacts per run. */
  app.get('/:id/output', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const wf = loadWorkflow(deps.db, ws.workspaceId, id);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20), 1), 50);
    const rows = deps.db
      .select()
      .from(schema.workflowRuns)
      .where(
        and(
          eq(schema.workflowRuns.workflowId, id),
          eq(schema.workflowRuns.workspaceId, ws.workspaceId),
          inArray(schema.workflowRuns.status, ['COMPLETED', 'COMPLETED_WITH_CONTRACT_VIOLATION', 'COMPLETED_WITH_ERRORS']),
        ),
      )
      .orderBy(desc(schema.workflowRuns.completedAt), desc(schema.workflowRuns.createdAt))
      .limit(limit + 1)
      .all();
    if (rows.length === 0) return c.json({ lastRun: null, outputs: [], runs: [], hasMore: false });

    const hasMore = rows.length > limit;
    const visibleRows = rows.slice(0, limit);
    const triggerMap = resolveTriggerTypes(deps.db, visibleRows.map((run) => run.triggerId));
    const runs = visibleRows.map((run) => {
      const graph = (run.graphSnapshot as WorkflowGraph | null) ??
        (wf.graph as WorkflowGraph) ?? {
          version: 1,
          nodes: [],
          edges: [],
          viewport: { x: 0, y: 0, zoom: 1 },
        };
      const state = run.runState as WorkflowRunState;
      return {
        run: mapRunSummary(run, triggerMap),
        outputs: buildFinalNodeOutputs(graph, state, {
          runId: run.id,
          startedAt: run.startedAt ?? run.createdAt,
          triggeredBy: triggerMap.get(run.triggerId ?? '') ?? 'manual',
        }),
      };
    });
    return c.json({
      lastRun: runs[0]!.run,
      outputs: runs[0]!.outputs,
      runs,
      hasMore,
    });
  });

  app.delete('/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    // Existence is the ONLY 404. This used to wrap the whole handler in a catch
    // that reported every failure as "Workflow not found", hiding the real cause.
    const row = deps.db
      .select({ id: schema.workflows.id })
      .from(schema.workflows)
      .where(and(eq(schema.workflows.id, id), eq(schema.workflows.workspaceId, ws.workspaceId)))
      .get();
    if (!row) return c.json({ error: 'Workflow not found' }, 404);

    // Snapshot for /restore — best-effort. A workflow whose graph no longer
    // normalizes must still be DELETABLE; losing its undo is the lesser cost.
    try {
      deletedWorkflowsCache.set(id, loadWorkflow(deps.db, ws.workspaceId, id));
    } catch {
      deletedWorkflowsCache.delete(id);
    }

    deps.db
      .delete(schema.workflows)
      .where(and(eq(schema.workflows.id, id), eq(schema.workflows.workspaceId, ws.workspaceId)))
      .run();

    // Drop the library mirror, or the deleted workflow keeps appearing in Packages.
    try {
      deps.packager?.dropWorkflowMirror(ws.workspaceId, id);
    } catch {
      /* best-effort — a stale mirror must never fail the delete */
    }

    deps.bus.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.WORKFLOW_DELETED, {
      workflowId: id,
      workspaceId: ws.workspaceId,
    });

    return c.json({ ok: true });
  });

  app.post('/:id/restore', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const cached = deletedWorkflowsCache.get(id);
    if (!cached) {
      return c.json({ error: 'Workflow not found in restore cache' }, 404);
    }
    deps.db
      .insert(schema.workflows)
      .values({
        id: cached.id,
        workspaceId: cached.workspaceId,
        ambientId: cached.ambientId,
        userId: cached.userId,
        registryEntryId: cached.registryEntryId,
        registryVersion: cached.registryVersion,
        title: cached.title,
        description: cached.description,
        graph: cached.graph,
        settings: cached.settings,
        isFromRegistry: cached.isFromRegistry,
        maxConcurrentRuns: cached.maxConcurrentRuns,
        budgetCents: cached.budgetCents,
        concurrencyOverflow: cached.concurrencyOverflow,
        tags: cached.tags,
        createdAt: cached.createdAt,
        updatedAt: new Date().toISOString(),
      })
      .run();
    revisions.ensureWorkflow(ws.workspaceId, id);

    try {
      deps.packager?.mirrorWorkflow(
        {
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId ?? null,
          userId: ws.user.id,
        },
        id,
      );
    } catch {
      /* best-effort */
    }

    deps.bus.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.WORKFLOW_CREATED, {
      workflowId: id,
      workspaceId: ws.workspaceId,
    });

    deletedWorkflowsCache.delete(id);
    return c.json({ ok: true });
  });

  return app;
}

type WorkflowRow = typeof schema.workflows.$inferSelect;
type WorkflowRunRow = typeof schema.workflowRuns.$inferSelect;

function loadLatestRunsByWorkflow(
  db: AgentisSqliteDb,
  workspaceId: string,
  workflowIds: string[],
): Map<string, WorkflowRunRow> {
  if (workflowIds.length === 0) return new Map();
  // Runs carry very large `runState`/`graphSnapshot` JSON blobs (multi-MB each).
  // Selecting full rows for EVERY run of every workflow — just to keep the latest
  // per workflow — reads hundreds of MB per request (seconds of latency on a big
  // workspace). Instead: a slim scan (id/workflowId/createdAt only) picks the
  // latest run id per workflow, then we hydrate full rows for just those (~one
  // per workflow), so blob reads scale with #workflows, not #runs.
  const slim = db
    .select({
      id: schema.workflowRuns.id,
      workflowId: schema.workflowRuns.workflowId,
    })
    .from(schema.workflowRuns)
    .where(
      and(
        eq(schema.workflowRuns.workspaceId, workspaceId),
        inArray(schema.workflowRuns.workflowId, workflowIds),
      ),
    )
    .orderBy(desc(schema.workflowRuns.createdAt))
    .all();
  const latestIdByWorkflow = new Map<string, string>();
  for (const row of slim) {
    if (!row.workflowId || latestIdByWorkflow.has(row.workflowId)) continue;
    latestIdByWorkflow.set(row.workflowId, row.id);
  }
  const latestIds = [...latestIdByWorkflow.values()];
  if (latestIds.length === 0) return new Map();
  const fullRows = db
    .select()
    .from(schema.workflowRuns)
    .where(inArray(schema.workflowRuns.id, latestIds))
    .all();
  const latest = new Map<string, WorkflowRunRow>();
  for (const row of fullRows) {
    if (!row.workflowId) continue;
    latest.set(row.workflowId, row);
  }
  return latest;
}

function presentWorkflowListItem(
  workflow: WorkflowRow,
  latestRun: WorkflowRunRow | undefined,
  triggerMap: Map<string, string>,
) {
  const latest = latestRun ? mapRunSummary(latestRun, triggerMap) : null;
  const status = latestRun ? workflowStatusFromRun(latestRun, latest?.status) : 'idle';
  return {
    ...workflow,
    triggerType: inferWorkflowTriggerType(workflow.graph as WorkflowGraph),
    status,
    lastRun: latest,
    activeRunStep: latestRun && isActiveRunStatus(latestRun.status)
      ? activeRunStep(workflow, latestRun)
      : undefined,
  };
}

function workflowStatusFromRun(
  run: WorkflowRunRow,
  mappedStatus: ReturnType<typeof mapRunSummary>['status'] | undefined,
): 'running' | 'paused' | 'waiting' | 'failed' | 'idle' | 'pending' {
  if (mappedStatus === 'paused') return 'paused';
  if (mappedStatus === 'waiting') return 'waiting';
  if (run.status === 'RUNNING') return 'running';
  if (run.status === 'CREATED' || run.status === 'PLANNING') return 'pending';
  if (mappedStatus === 'failed') return 'failed';
  return 'idle';
}

function isActiveRunStatus(status: string): boolean {
  return status === 'RUNNING' || status === 'WAITING' || status === 'CREATED' || status === 'PLANNING';
}

function activeRunStep(workflow: WorkflowRow, run: WorkflowRunRow): { current: number; total: number; durationMs?: number } | undefined {
  const graph = ((run.graphSnapshot as WorkflowGraph | null) ?? (workflow.graph as WorkflowGraph)) ?? null;
  const nodes = graph?.nodes ?? [];
  if (nodes.length === 0) return undefined;
  const state = run.runState as WorkflowRunState;
  const currentNodeId = currentRunNodeId(state);
  const failedCount = state.failedNodeIds?.length ?? 0;
  const current = Math.min(nodes.length, (state.completedNodeIds?.length ?? 0) + failedCount + (currentNodeId ? 1 : 0));
  const durationMs = run.startedAt
    ? Math.max(0, Date.now() - new Date(run.startedAt).getTime())
    : undefined;
  return {
    current: Math.max(1, current),
    total: nodes.length,
    ...(Number.isFinite(durationMs) ? { durationMs } : {}),
  };
}

function currentRunNodeId(state: WorkflowRunState): string | null {
  const active = Object.keys(state.activeExecutions ?? {})[0];
  if (active) return active;
  const queued = state.readyQueue?.[0]?.nodeId;
  if (queued) return queued;
  const running = Object.values(state.nodeStates ?? {}).find((node) => node.status === 'RUNNING');
  if (running) return running.nodeId;
  const waiting = Object.values(state.nodeStates ?? {}).find((node) => node.status === 'WAITING');
  return waiting?.nodeId ?? null;
}

function inferWorkflowTriggerType(graph: WorkflowGraph): 'manual' | 'cron' | 'webhook' | 'event' {
  const trigger = graph.nodes.find((node) => node.config.kind === 'trigger');
  const raw = trigger?.config.kind === 'trigger' ? String(trigger.config.triggerType ?? '') : '';
  if (raw === 'cron') return 'cron';
  if (raw === 'webhook') return 'webhook';
  if (raw === 'persistent_listener' || raw === 'event') return 'event';
  return 'manual';
}

/** CREATED/PLANNING collapse to "pending"; WAITING stays distinct for paused/waiting UX. */
function mapRunStatus(
  status: string,
): 'running' | 'completed' | 'completed_with_violation' | 'failed' | 'pending' | 'cancelled' | 'waiting' {
  switch (status) {
    case 'COMPLETED':
      return 'completed';
    case 'COMPLETED_WITH_CONTRACT_VIOLATION':
      return 'completed_with_violation';
    case 'COMPLETED_WITH_ERRORS':
    case 'FAILED':
      return 'failed';
    case 'CANCELLED':
      return 'cancelled';
    case 'RUNNING':
      return 'running';
    case 'WAITING':
      return 'waiting';
    default:
      return 'pending';
  }
}

/** Build a triggerId → triggerType lookup for a batch of runs. */
function resolveTriggerTypes(
  db: AgentisSqliteDb,
  triggerIds: Array<string | null>,
): Map<string, string> {
  const ids = [...new Set(triggerIds.filter((t): t is string => Boolean(t)))];
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  for (const row of db
    .select({ id: schema.triggers.id, triggerType: schema.triggers.triggerType })
    .from(schema.triggers)
    .where(inArray(schema.triggers.id, ids))
    .all()) {
    map.set(row.id, row.triggerType);
  }
  return map;
}

function mapRunSummary(run: WorkflowRunRow, triggerMap: Map<string, string>) {
  const startedAt = run.startedAt ?? run.createdAt;
  const finishedAt = run.completedAt ?? null;
  let durationMs: number | null = null;
  if (startedAt && finishedAt) {
    const d = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
    durationMs = Number.isFinite(d) && d >= 0 ? d : null;
  }
  const rawType = run.triggerId ? triggerMap.get(run.triggerId) : null;
  const triggeredBy =
    rawType === 'cron'
      ? 'cron'
      : rawType === 'webhook'
        ? 'webhook'
        : rawType === 'persistent_listener'
          ? 'event'
          : 'manual';
  const runState = run.runState as ({ contractViolations?: string[] } & Partial<WorkflowRunState>) | null;
  const paused = Object.values(runState?.nodeStates ?? {}).some((node) => node?.status === 'WAITING' && node?.blockedReason);
  return {
    id: run.id,
    status: paused ? 'paused' : mapRunStatus(run.status),
    startedAt,
    finishedAt,
    durationMs,
    triggeredBy,
    isReplay: run.isReplay,
    contractViolations: Array.isArray(runState?.contractViolations)
      ? runState!.contractViolations
      : undefined,
  };
}

interface FinalNodeOutput {
  nodeId: string;
  nodeTitle: string;
  kind: string;
  value: unknown;
  /** Viewer hint for the Output Surface (Layer 6). Set by `return_output` nodes. */
  renderAs?: 'html' | 'markdown' | 'table' | 'json' | 'text';
  role?: 'delivery' | 'declared';
  delivery?: IntegrationDeliveryReceipt;
}

type CompletedNodeOutput = {
  nid: string;
  st: NonNullable<WorkflowRunState['nodeStates'][string]>;
};

/**
 * Identify the output nodes of a completed run.
 * Explicit declarations are returned in graph order; zero-config leaf outputs
 * are returned newest-first by node completion time.
 */
function buildFinalNodeOutputs(
  graph: WorkflowGraph,
  state: WorkflowRunState,
  run?: { runId: string; startedAt?: string | null; triggeredBy?: string },
): FinalNodeOutput[] {
  const completedIds = state.completedNodeIds ?? [];
  if (completedIds.length === 0) return [];
  const hasOutgoing = new Set((graph.edges ?? []).map((e) => e.source));
  const nodeById = new Map((graph.nodes ?? []).map((n) => [n.id, n] as const));

  const completed = completedIds
    .map((nid) => ({ nid, st: state.nodeStates?.[nid] }))
    .filter((x): x is CompletedNodeOutput => Boolean(x.st));
  if (completed.length === 0) return [];

  const completedById = new Map(completed.map((item) => [item.nid, item] as const));
  const deliveryOutputs = buildDeliveryOutputs(graph, state, completedById, run);
  const deliveryNodeIds = new Set(deliveryOutputs.map((output) => output.nodeId));
  const declaredOutputNodes = (graph.nodes ?? []).filter((node) => {
    const cfg = node.config as { isOutput?: unknown; kind?: string };
    // `return_output` nodes are always part of the output surface; the legacy
    // `isOutput: true` flag on any node remains supported.
    return cfg?.isOutput === true || cfg?.kind === 'return_output';
  });
  if (declaredOutputNodes.length > 0) {
    const declared = declaredOutputNodes
      .filter((node) => !deliveryNodeIds.has(node.id))
      .map((node) => completedById.get(node.id))
      .filter((item): item is CompletedNodeOutput => Boolean(item))
      .map((item) => ({ ...formatFinalNodeOutput(item.nid, item.st, nodeById), role: 'declared' as const }));
    return [...deliveryOutputs, ...declared];
  }

  const sinks = completed
    .filter((item) => !hasOutgoing.has(item.nid))
    .sort((a, b) => {
      const ta = a.st.completedAt ? new Date(a.st.completedAt).getTime() : 0;
      const tb = b.st.completedAt ? new Date(b.st.completedAt).getTime() : 0;
      return tb - ta;
    });

  return [
    ...deliveryOutputs,
    ...sinks
      .filter((item) => !deliveryNodeIds.has(item.nid))
      .map((item) => formatFinalNodeOutput(item.nid, item.st, nodeById)),
  ];
}

function buildDeliveryOutputs(
  graph: WorkflowGraph,
  state: WorkflowRunState,
  completedById: Map<string, CompletedNodeOutput>,
  run?: { runId: string; startedAt?: string | null; triggeredBy?: string },
): FinalNodeOutput[] {
  const nodeOutputs = Object.fromEntries(
    Object.entries(state.nodeStates ?? {})
      .filter(([, nodeState]) => nodeState?.outputData)
      .map(([nodeId, nodeState]) => [nodeId, nodeState!.outputData!]),
  );
  const incoming = new Set((graph.edges ?? []).map((edge) => edge.target));
  const root = (graph.nodes ?? []).find((node) => !incoming.has(node.id));
  const triggerInputs = root ? state.nodeStates?.[root.id]?.inputData ?? {} : {};
  const tctx = buildTemplateContext({
    triggerInputs,
    nodeOutputs,
    scratchpad: {},
    store: {},
    run: run ? {
      id: run.runId,
      ...(run.startedAt ? { startedAt: run.startedAt } : {}),
      ...(run.triggeredBy ? { triggeredBy: run.triggeredBy } : {}),
    } : undefined,
  });

  return (graph.nodes ?? []).flatMap((node) => {
    const completed = completedById.get(node.id);
    if (!completed) return [];
    const cfg = node.config as {
      kind?: string;
      integrationId?: string;
      operationId?: string;
      inputs?: Record<string, unknown>;
    };
    if (cfg.kind !== 'integration' || !cfg.integrationId || !cfg.operationId) return [];
    const persisted = completed.st.deliveryReceipt;
    const reconstructed = persisted ?? buildIntegrationDeliveryReceipt(
      cfg.integrationId,
      cfg.operationId,
      resolveTemplateDeep(cfg.inputs ?? {}, tctx),
    );
    if (!reconstructed) return [];
    return [{
      nodeId: node.id,
      nodeTitle: reconstructed.subject ?? node.title,
      kind: 'delivery',
      value: reconstructed.content,
      renderAs: reconstructed.contentType,
      role: 'delivery',
      delivery: reconstructed,
    }];
  });
}

function formatFinalNodeOutput(
  nodeId: string,
  nodeState: CompletedNodeOutput['st'],
  nodeById: Map<string, WorkflowGraph['nodes'][number]>,
): FinalNodeOutput {
  const node = nodeById.get(nodeId);
  const cfg =
    (node?.config as { kind?: string; renderAs?: FinalNodeOutput['renderAs'] } | undefined) ??
    undefined;
  const kind = cfg?.kind ?? node?.type ?? 'unknown';
  const out = nodeState.outputData ?? null;
  // `return_output` unwraps to its rendered value + carries the renderAs hint.
  if (kind === 'return_output' && out && typeof out === 'object') {
    const o = out as { renderAs?: FinalNodeOutput['renderAs']; value?: unknown };
    return {
      nodeId,
      nodeTitle: node?.title ?? nodeId,
      kind,
      value: 'value' in o ? o.value : out,
      renderAs: o.renderAs ?? cfg?.renderAs ?? 'json',
    };
  }
  return {
    nodeId,
    nodeTitle: node?.title ?? nodeId,
    kind,
    value: out,
    ...(cfg?.renderAs ? { renderAs: cfg.renderAs } : {}),
  };
}

function presentRevision(revision: typeof schema.workflowGraphRevisions.$inferSelect) {
  return {
    id: revision.id,
    workflowId: revision.workflowId,
    parentRevisionId: revision.parentRevisionId,
    semanticHash: revision.semanticHash,
    presentationHash: revision.presentationHash,
    source: revision.source,
    reason: revision.reason,
    status: revision.status,
    trustState: revision.trustState,
    proofProfile: revision.proofProfile,
    verifiedAt: revision.verifiedAt,
    promotedAt: revision.promotedAt,
    rejectedAt: revision.rejectedAt,
    createdAt: revision.createdAt,
    updatedAt: revision.updatedAt,
  };
}

function verifyRevisionCase(
  db: AgentisSqliteDb,
  workspaceId: string,
  workflowId: string,
  graph: WorkflowGraph,
  testCase: WorkflowTestCase,
) {
  const report = preflightWorkflow({
    db,
    workspaceId,
    workflowId,
    graph,
    inputs: testCase.inputs,
    mode: 'canvas',
  });

  const blocking = report.issues.filter((issue) => issue.severity === 'error');
  const nodes = Object.fromEntries(Object.entries(report.nodes).map(([nodeId, result]) => [nodeId, result.output ?? {}]));
  const assertionFailures: string[] = [];
  for (const assertion of testCase.assertions) {
    const result = report.nodes[assertion.nodeId];
    if (!result) {
      assertionFailures.push(`node "${assertion.nodeId}" was not present`);
      continue;
    }
    try {
      const passed = evalCondition(assertion.expr, {
        input: result.input ?? {},
        inputs: result.input ?? {},
        output: result.output ?? {},
        nodes,
        trigger: report.scenario.input,
      });
      if (!passed) assertionFailures.push(assertion.message ?? assertion.expr);
    } catch (error) {
      assertionFailures.push(`${assertion.expr}: ${(error as Error).message}`);
    }
  }
  const expectsFailure = testCase.expectOutcome?.verdict === 'failed_checks'
    || testCase.expectOutcome?.verdict === 'hollow';
  const passed = expectsFailure
    ? blocking.length > 0 || assertionFailures.length > 0
    : blocking.length === 0 && assertionFailures.length === 0;
  return {
    id: testCase.id,
    name: testCase.name,
    kind: testCase.kind,
    passed,
    blocking: blocking.map((issue) => ({ code: issue.code, nodeId: issue.nodeId, message: issue.message })),
    assertionFailures,
  };
}

function loadWorkflow(db: AgentisSqliteDb, workspaceId: string, id: string) {
  const wf = db
    .select()
    .from(schema.workflows)
    .where(and(eq(schema.workflows.id, id), eq(schema.workflows.workspaceId, workspaceId)))
    .get();
  if (!wf) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workflow not found');
  // Return the exact persisted active bytes. Compatibility normalization is a
  // semantic mutation and must become a candidate, never an invisible read-time
  // graph that differs from what the revision/proof UI displays.
  return wf;
}

function createWorkflowMission(
  db: AgentisSqliteDb,
  missions: AgentMissionService,
  workspaceId: string,
  workflowId: string,
  runId: string,
  graph: WorkflowGraph,
) {
  const workflow = db.select({
    title: schema.workflows.title, ownerAgentId: schema.workflows.ownerAgentId, appId: schema.workflows.appId,
  }).from(schema.workflows).where(and(
    eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.id, workflowId),
  )).get();
  if (!workflow) return null;
  const requirements: Array<{ id: string; kind: 'channel_delivery' | 'data_mutation' | 'schedule' | 'subject_update'; planStepId: string; minimum: number }> = [];
  let configuredAgentId: string | null = null;
  for (const node of graph.nodes) {
    const config = node.config as unknown as Record<string, unknown>;
    if (typeof config.agentId === 'string' && !configuredAgentId) configuredAgentId = config.agentId;
    if (config.kind === 'agent_task') {
      const contract = config.completionContract && typeof config.completionContract === 'object'
        ? config.completionContract as { requiredEffects?: unknown } : null;
      if (Array.isArray(contract?.requiredEffects)) {
        for (const effect of contract.requiredEffects) {
          if (effect === 'channel_delivery' || effect === 'data_mutation' || effect === 'schedule' || effect === 'subject_update') {
            requirements.push({ id: `workflow:${node.id}:${effect}`, kind: effect, planStepId: node.id, minimum: 1 });
          }
        }
      }
    }
    if (config.kind === 'channel') requirements.push({ id: `workflow:${node.id}:channel_delivery`, kind: 'channel_delivery', planStepId: node.id, minimum: 1 });
    if (config.kind === 'data_mutate' && config.operation !== 'query' && config.operation !== 'get') {
      requirements.push({ id: `workflow:${node.id}:data_mutation`, kind: 'data_mutation', planStepId: node.id, minimum: 1 });
    }
  }
  if (requirements.length === 0) return null;
  const appOwner = workflow.appId ? db.select({ ownerAgentId: schema.apps.ownerAgentId }).from(schema.apps)
    .where(and(eq(schema.apps.workspaceId, workspaceId), eq(schema.apps.id, workflow.appId))).get()?.ownerAgentId ?? null : null;
  const fallback = db.select({ id: schema.agents.id }).from(schema.agents).where(and(
    eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.role, 'orchestrator'),
  )).get()?.id ?? null;
  const ownerAgentId = workflow.ownerAgentId ?? configuredAgentId ?? appOwner ?? fallback;
  if (!ownerAgentId) return null;
  return missions.create({
    workspaceId, ownerAgentId, appId: workflow.appId, sourceKind: 'workflow', sourceRef: runId,
    correlationKey: `workflow-run:${runId}`,
    objective: `Execute workflow "${workflow.title}" and produce its verified external outcome.`,
    outcomeContract: { requiredEffects: requirements, successPolicy: 'all_required_effects' },
    executionPlan: {
      version: 1,
      steps: graph.nodes.map((node) => {
        const kind = (node.config as { kind?: string }).kind;
        return {
          id: node.id,
          title: node.title,
          kind: kind === 'wait' ? 'wait'
            : kind === 'agent_task' ? 'decide'
              : kind === 'channel' || kind === 'data_mutate' ? 'effect'
                : 'verify',
          status: 'pending' as const,
          dependsOn: graph.edges.filter((edge) => edge.target === node.id).map((edge) => edge.source),
          effectRequirementIds: requirements.filter((requirement) => requirement.planStepId === node.id).map((requirement) => requirement.id),
        };
      }),
    },
    nextWakeAt: new Date().toISOString(),
  });
}

function ensureWorkflowSpace(db: AgentisSqliteDb, workspaceId: string, spaceId: string) {
  const space = db
    .select({ id: schema.spaces.id })
    .from(schema.spaces)
    .where(and(eq(schema.spaces.id, spaceId), eq(schema.spaces.workspaceId, workspaceId)))
    .get();
  if (!space) throw new AgentisError('RESOURCE_NOT_FOUND', `space ${spaceId} not found`);
}

/**
 * Fan out a workflow arming change to the workspace room so /home's Active
 * section and any live indicator refresh — arming is not a run, so it rides the
 * WORKFLOW_UPDATED event rather than the RUN_* stream.
 */
function emitWorkflowDeploymentChanged(bus: EventBus, workspaceId: string, workflowId: string) {
  bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.WORKFLOW_UPDATED, {
    workflowId,
    reason: 'deployment',
  });
}
