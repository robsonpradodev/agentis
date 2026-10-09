import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { SharedIntelligenceService } from '../../src/services/sharedIntelligence.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { MemoryStore } from '../../src/services/memory/memoryStore.js';
import { StubEmbeddingProvider } from '../_helpers/stubEmbeddingProvider.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let brain: SharedIntelligenceService;

beforeEach(async () => {
  ctx = await createTestContext();
  const episodes = new EpisodicMemoryStore(ctx.db, ctx.logger, new StubEmbeddingProvider());
  brain = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
});

afterEach(() => ctx.close());

function lastAccessedAt(id: string): string | null {
  const row = ctx.db
    .select({ lastAccessedAt: schema.memoryEpisodes.lastAccessedAt })
    .from(schema.memoryEpisodes)
    .where(eq(schema.memoryEpisodes.id, id))
    .get();
  return row?.lastAccessedAt ?? null;
}

describe('SharedIntelligenceService — dispatch retrieval marks access', () => {
  it('bumps lastAccessedAt for episodes surfaced into a dispatch context', async () => {
    const atom = await brain.addAtom({
      workspaceId: ctx.workspace.id,
      content: 'Always deploy database migrations behind a reversible feature flag.',
      confidence: 0.92,
      source: 'system_write',
      tags: ['deployment'],
    });

    // Freshly written episodes have not been accessed yet.
    expect(lastAccessedAt(atom.id)).toBeNull();

    const dispatch = await brain.buildDispatchContext({
      workspaceId: ctx.workspace.id,
      taskDescription: 'How should we deploy database migrations safely?',
      limit: 8,
    });

    // The atom was injected into the dispatch block …
    expect(dispatch.atomIds).toContain(atom.id);
    expect(dispatch.block).toMatch(/reversible feature flag/i);
    // … and that injection counts as an access for adaptive forgetting.
    expect(lastAccessedAt(atom.id)).not.toBeNull();
  });

  it('recalls a stored memory with a missing embedding via lexical fallback (hybrid recall)', async () => {
    const atom = await brain.addAtom({
      workspaceId: ctx.workspace.id,
      content: 'My name is Jordan Lee.',
      confidence: 1,
      source: 'operator_write',
    });
    // Simulate an operator-inserted / un-embedded / mixed-provider memory: strip the
    // vector so semantic scoring yields 0. Before the hybrid fix this atom was
    // invisible to agent recall even though the UI's lexical search found it.
    ctx.db.update(schema.memoryEpisodes)
      .set({ embedding: null, embeddingModel: null, embeddingDims: null })
      .where(eq(schema.memoryEpisodes.id, atom.id))
      .run();

    const hits = await brain.searchAtoms({
      workspaceId: ctx.workspace.id,
      query: "what's my name",
      scope: 'workspace',
      limit: 5,
    });
    expect(hits.some((h) => h.content.includes('Jordan Lee'))).toBe(true);
  });

  it('honors an agent-scoped governing rule as constitutional for that agent only, regardless of query relevance', async () => {
    const memory = new MemoryStore(ctx.db, ctx.logger);
    const closerId = 'agent-closer';
    // A hard guardrail pinned to ONE specialist's mind (scopeId = agentId), the
    // way the orchestrator should persist a correction (kind:'rule').
    const ruleId = memory.write({
      workspaceId: ctx.workspace.id,
      scopeId: closerId,
      kind: 'rule',
      source: 'operator',
      title: 'Never answer as the store',
      content: 'The Closer must never draft or send a message as if it were the store. Outreach only, workflow-gated.',
      importance: 0.7,
    });

    // Dispatch for the Closer on a task that has NOTHING to do with the rule —
    // a query-relevance tier would never surface it; the constitutional tier must.
    const own = await brain.buildDispatchContext({
      workspaceId: ctx.workspace.id,
      agentId: closerId,
      scopeId: closerId,
      taskDescription: 'Summarize this month sales spreadsheet into three bullets.',
      limit: 8,
    });
    expect(own.atomIds).toContain(ruleId);
    expect(own.block).toMatch(/never answer as the store/i);

    // A DIFFERENT agent must not inherit another specialist's private guardrail.
    const other = await brain.buildDispatchContext({
      workspaceId: ctx.workspace.id,
      agentId: 'agent-other',
      scopeId: 'agent-other',
      taskDescription: 'Summarize this month sales spreadsheet into three bullets.',
      limit: 8,
    });
    expect(other.atomIds).not.toContain(ruleId);
  });

  it('returns the full graph by default instead of silently capping the canvas working set', () => {
    const memory = new MemoryStore(ctx.db, ctx.logger);
    const agentId = 'agent-with-large-brain';
    for (let i = 0; i < 240; i += 1) {
      memory.write({
        workspaceId: ctx.workspace.id,
        scopeId: agentId,
        kind: 'lesson',
        source: 'operator',
        title: `Agent lesson ${i}`,
        content: `Agent lesson ${i}: preserve visible Brain atoms by default.`,
      });
    }

    const graph = brain.getGraph(ctx.workspace.id, {
      scope: 'scoped',
      scopeId: agentId,
      includeWorkspace: false,
    });

    expect(graph.nodes.filter((node) => node.id !== 'core')).toHaveLength(240);
    expect(graph.meta.atomCount).toBe(240);
  });

  it('does not touch episodes that are not surfaced', async () => {
    const surfaced = await brain.addAtom({
      workspaceId: ctx.workspace.id,
      content: 'Prefer feature flags for risky deploys.',
      confidence: 0.9,
      source: 'system_write',
    });
    const unrelated = await brain.addAtom({
      workspaceId: ctx.workspace.id,
      content: 'The quarterly marketing budget review happens in March.',
      confidence: 0.4,
      source: 'system_write',
    });

    await brain.buildDispatchContext({
      workspaceId: ctx.workspace.id,
      taskDescription: 'feature flags for risky deploys',
      limit: 2,
    });

    expect(lastAccessedAt(surfaced.id)).not.toBeNull();
    expect(lastAccessedAt(unrelated.id)).toBeNull();
  });
});

describe('SharedIntelligenceService — applyEvaluatorVerdict usage-weighted deltas', () => {
  function confidenceOf(id: string): number {
    const row = ctx.db.select({ confidence: schema.memoryEpisodes.confidence }).from(schema.memoryEpisodes).where(eq(schema.memoryEpisodes.id, id)).get();
    return Number(row?.confidence ?? 0);
  }

  it('gives a cited atom a larger confidence delta than one that was merely injected', async () => {
    const cited = await brain.addAtom({ workspaceId: ctx.workspace.id, content: 'Refunds over $500 require manager approval.', confidence: 0.5, source: 'system_write' });
    const uncited = await brain.addAtom({ workspaceId: ctx.workspace.id, content: 'The office coffee machine needs descaling monthly.', confidence: 0.5, source: 'system_write' });
    const runId = 'run-usage-weighted';
    // What buildDispatchContext's recordInjected does for every atom it puts in context.
    for (const id of [cited.id, uncited.id]) {
      brain.recordQualityEvent({ workspaceId: ctx.workspace.id, runId, eventType: 'atom_injected', atomId: id });
    }

    brain.applyEvaluatorVerdict({
      workspaceId: ctx.workspace.id,
      runId,
      verdict: 'pass',
      evaluatorConfidence: 0.9,
      // Cites `cited` by its stable [mem:id8] tag; never mentions `uncited`.
      responseText: `Approved per policy, citing [mem:${cited.id.slice(0, 8)}].`,
    });

    const citedDelta = confidenceOf(cited.id) - 0.5;
    const uncitedDelta = confidenceOf(uncited.id) - 0.5;
    expect(citedDelta).toBeGreaterThan(uncitedDelta);
    // Uncited still earns SOME (damped) credit, not zero — it wasn't blamed for
    // the failure, just not relied on.
    expect(uncitedDelta).toBeGreaterThan(0);
  });

  it('keeps the legacy uniform delta when responseText is omitted (back-compat)', async () => {
    const atom = await brain.addAtom({ workspaceId: ctx.workspace.id, content: 'Deployment safety checklist item.', confidence: 0.5, source: 'system_write' });
    const runId = 'run-legacy-no-response-text';
    brain.recordQualityEvent({ workspaceId: ctx.workspace.id, runId, eventType: 'atom_injected', atomId: atom.id });

    brain.applyEvaluatorVerdict({ workspaceId: ctx.workspace.id, runId, verdict: 'pass' });

    expect(confidenceOf(atom.id)).toBeGreaterThan(0.5);
  });
});

describe('SharedIntelligenceService — commitDurableAtom quality gate (§Mem0-teardown-followup)', () => {
  it('rejects structural garbage instead of writing it', async () => {
    const res = await brain.commitDurableAtom({
      workspaceId: ctx.workspace.id,
      scopeId: 'app-1',
      title: 'row',
      content: '| 8 | hn:48446141 | 3.70 | some ranked row',
    });
    expect(res).toEqual({ atomId: '', created: false, reinforced: false });
  });

  it('still reinforces a near-duplicate instead of writing a second copy (unaffected by the new gate)', async () => {
    const first = await brain.commitDurableAtom({
      workspaceId: ctx.workspace.id,
      scopeId: 'app-1',
      title: 'Deal outcome',
      content: 'A per-contact conversation ended WON for this App.',
    });
    expect(first.created).toBe(true);
    const second = await brain.commitDurableAtom({
      workspaceId: ctx.workspace.id,
      scopeId: 'app-1',
      title: 'Deal outcome',
      content: 'A per-contact conversation ended WON for this App.',
    });
    expect(second).toEqual({ atomId: first.atomId, created: false, reinforced: true });
  });
});

describe('SharedIntelligenceService — immediate governing contradiction check (§Mem0-teardown-followup)', () => {
  // NOTE: this test's exact phrasing is tuned to land between the dedup
  // threshold (EMBED_HIGH_SIMILARITY, 0.88 — must NOT fire, or the second
  // statement reinforces the first instead of being written as a new atom to
  // check) and the contradiction jaccard threshold (0.4 — must fire). It is
  // UNVERIFIED (the repo's DB-backed tests could not be run this session —
  // see session notes on the broken packages/db migration) — if it fails,
  // check which of those two thresholds the statement pair actually landed on
  // before assuming the contradiction-check logic itself is wrong.
  it('flags an operator correction that opposes an existing constitutional-tier rule in the same scope, without waiting for the weekly sweep', async () => {
    // First operator statement — becomes a constitutional-tier (importance 0.8)
    // atom via the no-model #commitOperatorMemory fallback (no
    // setFormationCompleter configured).
    await brain.promote({
      workspaceId: ctx.workspace.id,
      scopeId: 'agent-closer',
      originSurface: 'operator_chat',
      operatorText: 'Always escalate a payment failure to the on-call engineer within five minutes of detection.',
      taskOutput: '',
      memoryPolicy: 'form',
    });
    // Second, opposing statement in the SAME scope — should be flagged as a
    // dispute immediately, not left to the ~weekly reflection sweep.
    await brain.promote({
      workspaceId: ctx.workspace.id,
      scopeId: 'agent-closer',
      originSurface: 'operator_chat',
      operatorText: 'Do not escalate a payment failure to the on-call engineer under any circumstances.',
      taskOutput: '',
      memoryPolicy: 'form',
    });

    const disputed = ctx.db.select().from(schema.memoryEpisodes)
      .where(eq(schema.memoryEpisodes.workspaceId, ctx.workspace.id)).all()
      .filter((r) => r.isDisputed);
    expect(disputed.length).toBeGreaterThanOrEqual(2);
  });
});
