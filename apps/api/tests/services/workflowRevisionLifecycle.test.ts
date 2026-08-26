import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentisError, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { AppStore } from '@agentis/app';
import { eq } from 'drizzle-orm';
import { WorkflowRevisionService } from '../../src/services/workflow/workflowRevisionService.js';
import { WorkflowExperienceService } from '../../src/services/workflow/workflowExperienceService.js';
import { classifyWorkflowFailure, workflowFailureFingerprint } from '../../src/services/workflow/workflowFailureClassification.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

function graph(renderAs: 'json' | 'text' = 'json'): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        title: 'Input',
        position: { x: 0, y: 0 },
        config: { kind: 'trigger', triggerType: 'manual' },
      },
      {
        id: 'result',
        type: 'return_output',
        title: 'Result',
        position: { x: 220, y: 0 },
        config: { kind: 'return_output', renderAs },
      },
    ],
    edges: [{ id: 'edge', source: 'trigger', target: 'result' }],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

describe('immutable workflow revision lifecycle', () => {
  let ctx: TestContext;
  let workflowId: string;
  let revisions: WorkflowRevisionService;

  beforeEach(async () => {
    ctx = await createTestContext();
    workflowId = randomUUID();
    ctx.db.insert(schema.workflows).values({
      id: workflowId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'Protected workflow',
      graph: graph(),
      settings: {},
    }).run();
    revisions = new WorkflowRevisionService(ctx.db);
  });

  afterEach(() => ctx.close());

  it('keeps production bytes unchanged until the exact candidate is proven and promoted', () => {
    const active = revisions.ensureWorkflow(ctx.workspace.id, workflowId).active;
    const candidate = revisions.createCandidate({
      workspaceId: ctx.workspace.id,
      workflowId,
      graph: graph('text'),
      baseRevisionId: active.id,
      source: 'user_edit',
      actor: { type: 'user', id: ctx.user.id },
      reason: 'Render as text',
    }).revision;

    const storedBefore = ctx.sqlite.prepare('SELECT graph, active_revision_id AS activeRevisionId FROM workflows WHERE id = ?')
      .get(workflowId) as { graph: string; activeRevisionId: string };
    expect(JSON.parse(storedBefore.graph)).toEqual(graph());
    expect(storedBefore.activeRevisionId).toBe(active.id);

    for (const gate of ['dry_run', 'regression', 'clean_debug', 'outcome'] as const) {
      revisions.recordProof({
        workspaceId: ctx.workspace.id,
        workflowId,
        revisionId: candidate.id,
        gate,
        status: 'passed',
        evidence: { test: true },
      });
    }
    expect(revisions.proofState(ctx.workspace.id, workflowId, candidate.id).readyForPromotion).toBe(true);
    revisions.promote({
      workspaceId: ctx.workspace.id,
      workflowId,
      revisionId: candidate.id,
      expectedActiveRevisionId: active.id,
      actor: { type: 'user', id: ctx.user.id },
    });

    const storedAfter = ctx.sqlite.prepare('SELECT graph, active_revision_id AS activeRevisionId, candidate_revision_id AS candidateRevisionId FROM workflows WHERE id = ?')
      .get(workflowId) as { graph: string; activeRevisionId: string; candidateRevisionId: string | null };
    expect(JSON.parse(storedAfter.graph)).toEqual(graph('text'));
    expect(storedAfter.activeRevisionId).toBe(candidate.id);
    expect(storedAfter.candidateRevisionId).toBeNull();
  });

  it('rejects stale editor bases and stale promotion compare-and-swap values', () => {
    const active = revisions.ensureWorkflow(ctx.workspace.id, workflowId).active;
    const first = revisions.createCandidate({
      workspaceId: ctx.workspace.id,
      workflowId,
      graph: graph('text'),
      baseRevisionId: active.id,
      source: 'user_edit',
      actor: { type: 'user', id: ctx.user.id },
      reason: 'First edit',
    }).revision;

    expect(() => revisions.createCandidate({
      workspaceId: ctx.workspace.id,
      workflowId,
      graph: graph(),
      baseRevisionId: active.id,
      source: 'user_edit',
      actor: { type: 'user', id: ctx.user.id },
      reason: 'Stale edit',
    })).toThrowError(AgentisError);

    for (const gate of ['dry_run', 'regression', 'clean_debug', 'outcome'] as const) {
      revisions.recordProof({
        workspaceId: ctx.workspace.id,
        workflowId,
        revisionId: first.id,
        gate,
        status: 'passed',
      });
    }
    expect(() => revisions.promote({
      workspaceId: ctx.workspace.id,
      workflowId,
      revisionId: first.id,
      expectedActiveRevisionId: 'stale-active-revision',
      actor: { type: 'user', id: ctx.user.id },
    })).toThrowError(AgentisError);
  });

  it('bounds unreferenced autosave checkpoints without removing the active working change', () => {
    const active = revisions.ensureWorkflow(ctx.workspace.id, workflowId).active;
    let baseRevisionId = active.id;
    for (let index = 0; index < 25; index += 1) {
      const next = graph(index % 2 === 0 ? 'text' : 'json');
      next.nodes[1] = { ...next.nodes[1]!, title: `Result ${index}` };
      baseRevisionId = revisions.createCandidate({
        workspaceId: ctx.workspace.id,
        workflowId,
        graph: next,
        baseRevisionId,
        source: 'user_edit',
        actor: { type: 'user', id: ctx.user.id },
        reason: `Autosave ${index}`,
      }).revision.id;
    }
    const rows = revisions.revisions(ctx.workspace.id, workflowId);
    expect(rows.filter((revision) => revision.source === 'user_edit' && revision.status === 'superseded')).toHaveLength(20);
    expect(revisions.candidate(ctx.workspace.id, workflowId)?.revision.id).toBe(baseRevisionId);
    expect(revisions.active(ctx.workspace.id, workflowId).revision.id).toBe(active.id);
  });

  it('publishes an independently proven App-owned workflow without sibling App gates', () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Delivery-only app' }).id;
    ctx.db.update(schema.workflows).set({ appId }).where(eq(schema.workflows.id, workflowId)).run();
    // Deliberately broken sibling: no executable graph, no proof, no trigger.
    // Its health belongs in App readiness, never in this workflow's promotion.
    ctx.db.insert(schema.workflows).values({
      id: randomUUID(),
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      appId,
      title: 'Unrelated broken sibling',
      graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
      settings: {},
    }).run();
    const active = revisions.ensureWorkflow(ctx.workspace.id, workflowId).active;
    const candidate = revisions.createCandidate({
      workspaceId: ctx.workspace.id,
      workflowId,
      graph: graph('text'),
      baseRevisionId: active.id,
      source: 'user_edit',
      actor: { type: 'user', id: ctx.user.id },
      reason: 'Semantic App edit',
    }).revision;
    for (const gate of ['dry_run', 'regression'] as const) {
      revisions.recordProof({ workspaceId: ctx.workspace.id, workflowId, revisionId: candidate.id, gate, status: 'passed' });
    }
    const runId = randomUUID();
    ctx.db.insert(schema.workflowRuns).values({
      id: runId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId,
      workflowRevisionId: candidate.id,
      userId: ctx.user.id,
      status: 'COMPLETED',
      runState: { verdict: { outcome: 'accomplished' } },
      graphSnapshot: graph('text'),
    }).run();
    for (const gate of ['clean_debug', 'outcome'] as const) {
      revisions.recordProof({
        workspaceId: ctx.workspace.id,
        workflowId,
        revisionId: candidate.id,
        gate,
        status: 'passed',
        runId,
        evidence: { delivery: true },
      });
    }

    const promoted = revisions.promote({
      workspaceId: ctx.workspace.id,
      workflowId,
      revisionId: candidate.id,
      expectedActiveRevisionId: active.id,
      actor: { type: 'user', id: ctx.user.id },
    });
    expect(promoted.activeRevisionId).toBe(candidate.id);
  });

  it('rejects an App delivery promotion backed by a contract-violating run', () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Dirty delivery app' }).id;
    ctx.db.update(schema.workflows).set({ appId }).where(eq(schema.workflows.id, workflowId)).run();
    const active = revisions.ensureWorkflow(ctx.workspace.id, workflowId).active;
    const candidate = revisions.createCandidate({
      workspaceId: ctx.workspace.id, workflowId, graph: graph('text'), baseRevisionId: active.id,
      source: 'user_edit', actor: { type: 'user', id: ctx.user.id }, reason: 'Dirty candidate',
    }).revision;
    const runId = randomUUID();
    ctx.db.insert(schema.workflowRuns).values({
      id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId,
      workflowRevisionId: candidate.id, userId: ctx.user.id,
      status: 'COMPLETED_WITH_CONTRACT_VIOLATION',
      runState: { verdict: { outcome: 'accomplished' } }, graphSnapshot: graph('text'),
    }).run();
    expect(() => revisions.promoteFromAppDelivery({
      workspaceId: ctx.workspace.id, workflowId, revisionId: candidate.id,
      expectedActiveRevisionId: active.id, actor: { type: 'system', id: 'delivery-test' }, deliveryRunId: runId,
    })).toThrowError(/clean delivery run/);
  });

  it('invalidates proof when the acceptance spec drifts and creates a new candidate for the spec', () => {
    const active = revisions.ensureWorkflow(ctx.workspace.id, workflowId).active;
    const graphCandidate = revisions.createCandidate({
      workspaceId: ctx.workspace.id,
      workflowId,
      graph: graph('text'),
      baseRevisionId: active.id,
      source: 'user_edit',
      actor: { type: 'user', id: ctx.user.id },
      reason: 'Graph edit before scope',
    }).revision;
    const spec = {
      version: 1 as const,
      objective: 'Return a non-empty result',
      acceptance: [{ id: 'result', claim: 'Result exists', verify: 'expr' as const, expr: 'output != null' }],
      createdAt: new Date().toISOString(),
    };
    ctx.db.update(schema.workflows).set({ settings: { spec } }).where(eq(schema.workflows.id, workflowId)).run();

    expect(revisions.proofState(ctx.workspace.id, workflowId, graphCandidate.id).specMatchesCurrent).toBe(false);
    expect(() => revisions.promote({
      workspaceId: ctx.workspace.id,
      workflowId,
      revisionId: graphCandidate.id,
      expectedActiveRevisionId: active.id,
      actor: { type: 'user', id: ctx.user.id },
      overrideReason: 'must not bypass spec drift',
    })).toThrowError(AgentisError);

    const specCandidate = revisions.createCandidate({
      workspaceId: ctx.workspace.id,
      workflowId,
      graph: graph('text'),
      baseRevisionId: graphCandidate.id,
      source: 'user_edit',
      actor: { type: 'user', id: ctx.user.id },
      reason: 'Pin updated acceptance spec',
    }).revision;
    expect(specCandidate.id).not.toBe(graphCandidate.id);
    expect(specCandidate.specJson).toEqual(spec);
    expect(revisions.proofState(ctx.workspace.id, workflowId, specCandidate.id).specMatchesCurrent).toBe(true);
  });

  it('migrates the latest accomplished snapshot to active and retains the divergent current graph as candidate', () => {
    const accomplishedGraph = graph('text');
    const runId = randomUUID();
    ctx.db.insert(schema.workflowRuns).values({
      id: runId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId,
      userId: ctx.user.id,
      status: 'COMPLETED',
      runState: { verdict: { outcome: 'accomplished' } },
      graphSnapshot: accomplishedGraph,
      createdAt: '2026-01-02T00:00:00.000Z',
    }).run();

    const migrated = revisions.reconcileLegacyWorkflow(ctx.workspace.id, workflowId);
    expect(migrated.changed).toBe(true);
    expect(migrated.candidateRevisionId).toBeTruthy();
    expect(migrated.candidateRevisionId).not.toBe(migrated.activeRevisionId);
    expect(revisions.active(ctx.workspace.id, workflowId).graph).toEqual(accomplishedGraph);
    expect(revisions.candidate(ctx.workspace.id, workflowId)?.graph).toEqual(graph());
    const stored = ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, workflowId)).get()!;
    expect(stored.graph).toEqual(accomplishedGraph);
    expect(stored.trustState).toBe('candidate');
  });

  it('allows only one repair attempt for a stable failure fingerprint and base revision', () => {
    const active = revisions.ensureWorkflow(ctx.workspace.id, workflowId).active;
    const experiences = new WorkflowExperienceService(ctx.db);
    const classification = classifyWorkflowFailure('CONTRACT_OUTPUT_INVALID: missing result.value');
    const fingerprint = workflowFailureFingerprint({
      classification,
      revisionKey: active.id,
      node: graph().nodes[1]!,
      error: 'CONTRACT_OUTPUT_INVALID: missing result.value',
      contractPath: 'result.value',
    });
    const input = {
      workspaceId: ctx.workspace.id,
      workflowId,
      baseRevisionId: active.id,
      failureFingerprint: fingerprint,
      runId: randomUUID(),
      nodeId: 'result',
      error: 'CONTRACT_OUTPUT_INVALID: missing result.value',
    };

    expect(experiences.reserveRepairAttempt(input).allowed).toBe(true);
    expect(experiences.reserveRepairAttempt({ ...input, runId: randomUUID() }).allowed).toBe(false);
  });

  it('promotes repeated accomplished evidence from the workflow into reusable app memory', async () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, {
      name: 'Learning app',
    }).id;
    ctx.db.update(schema.workflows).set({ appId }).where(eq(schema.workflows.id, workflowId)).run();
    const active = revisions.ensureWorkflow(ctx.workspace.id, workflowId).active;
    const experiences = new WorkflowExperienceService(ctx.db);
    const context = {
      workspaceId: ctx.workspace.id,
      workflowId,
      appId,
      activeRevisionId: active.id,
    };

    for (let index = 0; index < 3; index += 1) {
      await experiences.recordAccomplished({
        context,
        revisionId: active.id,
        semanticHash: active.semanticHash,
        graph: graph(),
        runId: randomUUID(),
        objective: 'Return the result reliably',
      });
    }

    const learned = ctx.db.select().from(schema.workflowExperiences)
      .where(eq(schema.workflowExperiences.workspaceId, ctx.workspace.id)).all();
    expect(learned.find((row) => row.scopeType === 'workflow' && row.kind === 'known_good_revision')?.successCount).toBe(3);
    expect(learned.some((row) => row.scopeType === 'app' && row.scopeId === appId && row.kind === 'promoted_pattern')).toBe(true);
    const dossier = experiences.dossier(context);
    expect(dossier.pinned[0]?.kind).toBe('known_good_revision');
    expect(dossier.secondary.some((row) => row.kind === 'promoted_pattern')).toBe(true);
  });

  it.each([
    ['BLOCKED_APPROVAL_REQUIRED: wait for operator', 'human_policy', false],
    ['credential API key missing', 'configuration_capability', false],
    ['agent_task node select_draft: pinned agent e34b5a36-85fc-4384-b8b9-a71392a198c6 has no connected runtime', 'configuration_capability', false],
    ['Bia Outreacher seleciona um novo lead: agent "Bia Outreacher" is offline. Reconnect its runtime or choose an online agent before running.', 'configuration_capability', false],
    ['provider returned 429 rate limit', 'transient_resource', false],
    ['Hermes produced no observable output for 3m 0s and appears stuck; the runtime was stopped', 'transient_resource', false],
    ['CONTRACT_OUTPUT_INVALID: missing result', 'data_contract', true],
    ['WORKFLOW_GRAPH_INVALID: dangling edge target', 'graph_design', true],
    ['internal invariant failed in sqlite transaction', 'platform', false],
  ] as const)('classifies %s centrally as %s', (error, category, repairEligible) => {
    const classification = classifyWorkflowFailure(error);
    expect(classification.category).toBe(category);
    expect(classification.graphRepairEligible).toBe(repairEligible);
  });
});
