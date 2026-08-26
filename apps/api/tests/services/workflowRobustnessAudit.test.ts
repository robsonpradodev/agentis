/**
 * Workflow Robustness Audit (WORKFLOW-DESIGN-10X Phase 2) — proves the deterministic
 * enforcement of the design doctrine: missing state on a recurring run, unbounded
 * batches (auto-repaired), single-branch routers, ungated deliveries, and
 * failure-handling-free fetch fans are all flagged.
 */
import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@agentis/core';
import { auditWorkflowRobustness } from '../../src/services/workflow/workflowRobustnessAudit.js';

type N = WorkflowGraph['nodes'][number];
const node = (id: string, kind: string, extra: Record<string, unknown> = {}): N =>
  ({ id, type: kind, title: id, position: { x: 0, y: 0 }, config: { kind, ...extra } }) as unknown as N;
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target });
const graphOf = (nodes: N[], edges: Array<{ id: string; source: string; target: string }>): WorkflowGraph =>
  ({ version: 1, nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } }) as WorkflowGraph;

const codes = (r: { warnings: Array<{ code: string }> }) => r.warnings.map((w) => w.code);

describe('auditWorkflowRobustness', () => {
  it('rejects an agent-owned external send with a self-reported receipt and no native delivery sink', () => {
    const g = graphOf(
      [
        node('t', 'trigger'),
        node('compose-and-send', 'agent_task', {
          prompt: 'Choose the recipient and send the WhatsApp message. Require a real provider acknowledgement.',
          outputKeys: ['sent_count', 'provider_ack', 'status'],
        }),
        node('o', 'return_output'),
      ],
      [edge('t', 'compose-and-send'), edge('compose-and-send', 'o')],
    );

    const result = auditWorkflowRobustness(g, { triggerType: 'manual', archetype: 'pipeline' });

    expect(codes(result)).toContain('MISSING_DELIVERY_SINK');
    expect(result.warnings.find((warning) => warning.code === 'MISSING_DELIVERY_SINK')?.message).toMatch(/channel or integration node/i);
  });

  it('accepts agent judgment followed by a native channel delivery node', () => {
    const g = graphOf(
      [
        node('t', 'trigger'),
        node('compose', 'agent_task', { prompt: 'Compose a short WhatsApp message.', outputKeys: ['body'] }),
        node('send', 'channel', { channelKind: 'whatsapp', to: '{{input.to}}', body: '{{nodes.compose.body}}' }),
        node('o', 'return_output'),
      ],
      [edge('t', 'compose'), edge('compose', 'send'), edge('send', 'o')],
    );

    const result = auditWorkflowRobustness(g, { triggerType: 'manual', archetype: 'pipeline' });

    expect(codes(result)).not.toContain('MISSING_DELIVERY_SINK');
  });

  it('flags a recurring workflow with no workflow_store (D4 missing dedup state)', () => {
    const g = graphOf(
      [node('t', 'trigger', { triggerType: 'cron' }), node('f', 'http_request'), node('o', 'return_output')],
      [edge('t', 'f'), edge('f', 'o')],
    );
    const r = auditWorkflowRobustness(g, { triggerType: 'cron', archetype: 'pipeline' });
    expect(codes(r)).toContain('MISSING_STATE');
  });

  it('D9: flags an agent_task told to RUN a script (it has no shell → it fabricates)', () => {
    const g = graphOf(
      [
        node('t', 'trigger'),
        node('harvest', 'agent_task', { prompt: 'Run scripts/harvest-catalog-assets.py for the handle and save 15 curated items to assets/.' }),
        node('o', 'return_output'),
      ],
      [edge('t', 'harvest'), edge('harvest', 'o')],
    );
    const r = auditWorkflowRobustness(g, { triggerType: 'manual', archetype: 'pipeline' });
    expect(codes(r)).toContain('AGENT_ASKED_TO_RUN_SCRIPT');
    expect(r.warnings.find((w) => w.code === 'AGENT_ASKED_TO_RUN_SCRIPT')!.message).toMatch(/fabricate|code.*python/i);
  });

  it('D9: a genuine judgment agent_task (no script/command) is NOT flagged', () => {
    const g = graphOf(
      [
        node('t', 'trigger'),
        node('curate', 'agent_task', { prompt: 'Review the harvested posts and choose the 15 best products for a fashion storefront, writing a short rationale for each.' }),
        node('o', 'return_output'),
      ],
      [edge('t', 'curate'), edge('curate', 'o')],
    );
    const r = auditWorkflowRobustness(g, { triggerType: 'manual', archetype: 'pipeline' });
    expect(codes(r)).not.toContain('AGENT_ASKED_TO_RUN_SCRIPT');
  });

  it('does NOT flag missing state when a workflow_store node is present', () => {
    const g = graphOf(
      [node('t', 'trigger', { triggerType: 'cron' }), node('s', 'workflow_store'), node('o', 'return_output')],
      [edge('t', 's'), edge('s', 'o')],
    );
    const r = auditWorkflowRobustness(g, { triggerType: 'cron', archetype: 'pipeline' });
    expect(codes(r)).not.toContain('MISSING_STATE');
  });

  it('auto-repairs an unbounded loop by bounding its concurrency (D5)', () => {
    const g = graphOf([node('t', 'trigger'), node('l', 'loop'), node('o', 'return_output')], [edge('t', 'l'), edge('l', 'o')]);
    const r = auditWorkflowRobustness(g, { triggerType: 'manual', archetype: 'pipeline' });
    const loop = r.graph.nodes.find((n) => n.id === 'l')!;
    expect((loop.config as { maxConcurrency?: number }).maxConcurrency).toBe(5);
    expect(r.repairs.join(' ')).toMatch(/maxConcurrency=5/);
  });

  it('flags a single-branch router as a missing reject path (D1)', () => {
    const g = graphOf(
      [node('t', 'trigger'), node('r', 'router'), node('o', 'return_output')],
      [edge('t', 'r'), edge('r', 'o')], // router has ONE outgoing edge
    );
    const res = auditWorkflowRobustness(g, { triggerType: 'manual', archetype: 'pipeline' });
    expect(codes(res)).toContain('SINGLE_BRANCH_ROUTER');
  });

  it('flags an ungated delivery in a non-trivial workflow (D2)', () => {
    const g = graphOf(
      [
        node('t', 'trigger'), node('a', 'agent_task'), node('b', 'transform'), node('c', 'http_request'),
        node('d', 'agent_task'), node('i', 'integration'), node('o', 'return_output'),
      ],
      [edge('t', 'a'), edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('d', 'i'), edge('i', 'o')],
    );
    const r = auditWorkflowRobustness(g, { triggerType: 'manual', archetype: 'orchestrated' });
    expect(codes(r)).toContain('MISSING_DELIVERY_GUARD');
  });

  it('does NOT flag a delivery when an evaluator gates it', () => {
    const g = graphOf(
      [
        node('t', 'trigger'), node('a', 'agent_task'), node('b', 'transform'), node('c', 'http_request'),
        node('e', 'evaluator'), node('i', 'integration'), node('o', 'return_output'),
      ],
      [edge('t', 'a'), edge('a', 'b'), edge('b', 'c'), edge('c', 'e'), edge('e', 'i'), edge('i', 'o')],
    );
    const r = auditWorkflowRobustness(g, { triggerType: 'manual', archetype: 'orchestrated' });
    expect(codes(r)).not.toContain('MISSING_DELIVERY_GUARD');
  });

  it('flags an open-ended iterative goal with no converge node (D7)', () => {
    const g = graphOf(
      [node('t', 'trigger'), node('a', 'agent_task'), node('o', 'return_output')],
      [edge('t', 'a'), edge('a', 'o')],
    );
    const r = auditWorkflowRobustness(g, { triggerType: 'manual', archetype: 'orchestrated', robustness: { qualifies: false, approval: false, validates: false, irreversible: false, batch: false, iterative: true } });
    expect(codes(r)).toContain('MISSING_CONVERGENCE');
  });

  it('does NOT flag an iterative goal when a converge node is present (D7)', () => {
    const g = graphOf(
      [node('t', 'trigger'), node('c', 'converge'), node('o', 'return_output')],
      [edge('t', 'c'), edge('c', 'o')],
    );
    const r = auditWorkflowRobustness(g, { triggerType: 'manual', archetype: 'orchestrated', robustness: { qualifies: false, approval: false, validates: false, irreversible: false, batch: false, iterative: true } });
    expect(codes(r)).not.toContain('MISSING_CONVERGENCE');
  });

  it('flags multiple external fetches with no failure handling (D3)', () => {
    const g = graphOf(
      [node('t', 'trigger'), node('f1', 'http_request'), node('f2', 'browser'), node('o', 'return_output')],
      [edge('t', 'f1'), edge('f1', 'f2'), edge('f2', 'o')],
    );
    const r = auditWorkflowRobustness(g, { triggerType: 'manual', archetype: 'pipeline' });
    expect(codes(r)).toContain('NO_FAILURE_HANDLING');
  });
});
