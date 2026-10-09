/**
 * Workflow Spec (SWIFT Scope artifact) — validation is mechanical at scope
 * time (bad exprs, unknown services, undeclared template keys caught BEFORE a
 * run), and derivation produces worldly checks (or the elicitation question).
 */
import { describe, expect, it } from 'vitest';
import {
  deriveSpecDraft,
  readWorkflowSpec,
  renderOutputTemplate,
  validateWorkflowSpec,
  type WorkflowSpec,
} from '../../src/services/workflow/workflowSpec.js';
import type { WorkflowGraph } from '@agentis/core';

function baseSpec(overrides: Partial<WorkflowSpec> = {}): WorkflowSpec {
  return {
    version: 1,
    objective: 'Deploy the store',
    acceptance: [
      { id: 'live', claim: 'site is live', verify: 'http_probe', url: '{output.deploymentUrl}', expectStatus: 200 },
    ],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('validateWorkflowSpec', () => {
  it('accepts a well-formed spec', () => {
    expect(validateWorkflowSpec(baseSpec())).toEqual([]);
  });

  it('rejects an expr that does not parse', () => {
    const spec = baseSpec({ acceptance: [{ id: 'x', claim: 'c', verify: 'expr', expr: 'output..??' }] });
    expect(validateWorkflowSpec(spec).join(' ')).toMatch(/does not parse/);
  });

  it('rejects a data_probe against a service the workspace cannot run', () => {
    const spec = baseSpec({ acceptance: [{ id: 'd', claim: 'c', verify: 'data_probe', integration: 'nonexistent_db', operation: 'select', expr: 'probe.rows.length >= 1' }] });
    expect(validateWorkflowSpec(spec, { knownServices: ['supabase', 'vercel'] }).join(' ')).toMatch(/not a runnable service/);
  });

  it('accepts a file_probe and rejects one with no path', () => {
    const ok = baseSpec({ acceptance: [{ id: 'f', claim: 'assets on disk', verify: 'file_probe', path: '{output.assetsDir}', minFiles: 15 }] });
    expect(validateWorkflowSpec(ok)).toEqual([]);
    const bad = baseSpec({ acceptance: [{ id: 'f', claim: 'c', verify: 'file_probe', path: '' } as never] });
    expect(validateWorkflowSpec(bad).join(' ')).toMatch(/path is required/);
  });

  it('rejects a probe template referencing an undeclared output key', () => {
    const graph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [],
      outputContract: { fields: [{ key: 'reportUrl', type: 'string' }] },
    } as unknown as WorkflowGraph;
    const errors = validateWorkflowSpec(baseSpec(), { graph });
    expect(errors.join(' ')).toMatch(/declares no "deploymentUrl" key/);
  });

  it('rejects an unrelated data probe even when that integration exists elsewhere in the workspace', () => {
    const graph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 }, edges: [],
      nodes: [
        { id: 'leads', title: 'Load leads', position: { x: 0, y: 0 }, config: { kind: 'data_query', collection: 'leads' } },
        { id: 'send', title: 'Send WhatsApp', position: { x: 200, y: 0 }, config: { kind: 'channel', operation: 'send' } },
      ],
    } as unknown as WorkflowGraph;
    const spec = baseSpec({ acceptance: [{
      id: 'wrong_store', claim: 'Rows exist in Airtable', verify: 'data_probe', integration: 'airtable',
      operation: 'select', params: {}, expr: 'probe.rows.length >= 1',
    }] });
    expect(validateWorkflowSpec(spec, { graph, knownServices: ['airtable'] }).join(' ')).toMatch(/outside this workflow's execution closure/);
  });

  it('accepts a native App data probe when the graph uses App data nodes', () => {
    const graph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 }, edges: [],
      nodes: [{ id: 'leads', title: 'Load leads', position: { x: 0, y: 0 }, config: { kind: 'data_query', collection: 'leads' } }],
    } as unknown as WorkflowGraph;
    const spec = baseSpec({ acceptance: [{
      id: 'lead_state', claim: 'The exact lead is contacted', verify: 'data_probe', integration: 'agentis_app',
      operation: 'query', params: { collection: 'leads' }, expr: 'probe.rows.length >= 1',
    }] });
    expect(validateWorkflowSpec(spec, { graph })).toEqual([]);
  });

  it('rejects an expr that guesses a viewer envelope instead of the declared terminal data', () => {
    const graph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [],
      outputContract: { fields: [{ key: 'lastResult', type: 'object' }] },
    } as unknown as WorkflowGraph;
    const spec = baseSpec({ acceptance: [{ id: 'sent', claim: 'sent', verify: 'expr', expr: 'output.value.lastResult.status == "sent"' }] });
    expect(validateWorkflowSpec(spec, { graph }).join(' ')).toMatch(/expr references output\.value.*declares no "value" key/);
  });

  it('validates native App probe limits and nested output templates at scope time', () => {
    const graph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [],
      outputContract: { fields: [{ key: 'searchRun', type: 'object' }] },
    } as unknown as WorkflowGraph;
    const tooLarge = baseSpec({ acceptance: [{
      id: 'rows', claim: 'rows exist', verify: 'data_probe', integration: 'agentis_app', operation: 'query',
      params: { collection: 'restaurants', filter: { runId: '{output.searchRun.runId}' }, limit: 1000 },
      expr: 'probe.rows.length >= 1',
    }] });
    expect(validateWorkflowSpec(tooLarge, { graph }).join(' ')).toMatch(/limit must be an integer from 1 to 500/);

    const unknownPath = baseSpec({ acceptance: [{
      id: 'rows', claim: 'rows exist', verify: 'data_probe', integration: 'agentis_app', operation: 'query',
      params: { collection: 'restaurants', filter: { runId: '{output.unknown.runId}' }, limit: 25 },
      expr: 'probe.rows.length >= 1',
    }] });
    expect(validateWorkflowSpec(unknownPath, { graph }).join(' ')).toMatch(/params reference \{output\.unknown\}.*declares no "unknown" key/);
  });

  it('requires at least one acceptance claim + duplicate-id detection', () => {
    expect(validateWorkflowSpec(baseSpec({ acceptance: [] })).join(' ')).toMatch(/at least one verifiable claim/);
    const dup = baseSpec({
      acceptance: [
        { id: 'a', claim: 'c1', verify: 'expr', expr: 'output.x == 1' },
        { id: 'a', claim: 'c2', verify: 'expr', expr: 'output.y == 2' },
      ],
    });
    expect(validateWorkflowSpec(dup).join(' ')).toMatch(/duplicate id/);
  });
});

describe('deriveSpecDraft', () => {
  it('derives a worldly http_probe + floors for a deploy request', () => {
    const { spec, question } = deriveSpecDraft({ description: 'Build a fashion store with at least 10 products and deploy it live.', services: ['vercel'] });
    expect(question).toBeUndefined();
    const kinds = spec.acceptance.map((c) => c.verify);
    expect(kinds).toContain('http_probe');
    expect(kinds).toContain('expr');       // at least 10 products
    expect(kinds).not.toContain('judge');  // no unavailable evaluator is invented
    expect(spec.sufficiency).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'deploymentUrl', format: 'url' }),
      expect.objectContaining({ key: 'products', minItems: 10 }),
    ]));
    expect(spec.reworkBudget).toBe(1);
  });

  it('derives a data_probe when persistence is requested and a data service is runnable', () => {
    const { spec } = deriveSpecDraft({ description: 'Collect leads and save them to the database.', services: ['supabase'] });
    expect(spec.acceptance.some((c) => c.verify === 'data_probe' && (c as { integration: string }).integration === 'supabase')).toBe(true);
  });

  it('asks the ONE pointed question when nothing worldly is derivable', () => {
    const { spec, question } = deriveSpecDraft({ description: 'Think about strategy.' });
    expect(question).toMatch(/what URL, record, file, or measurable value/i);
    expect(spec.acceptance).toEqual([]);
  });

  it('rejects judge-only acceptance because it cannot prove a functional workflow', () => {
    const spec = baseSpec({ acceptance: [{ id: 'judge', claim: 'looks right', verify: 'judge', rubric: 'Review it' }] });
    expect(validateWorkflowSpec(spec).join(' ')).toMatch(/judge cannot be the only proof/);
  });

  it('derives a mechanical check from the declared output contract', () => {
    const graph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [],
      outputContract: { fields: [{ key: 'businesses', type: 'array', required: true }] },
    } as unknown as WorkflowGraph;
    const { spec, question } = deriveSpecDraft({ description: 'Prospect companies.', graph });
    expect(question).toBeUndefined();
    expect(spec.acceptance).toEqual([expect.objectContaining({ verify: 'expr', expr: 'output.businesses.length >= 1' })]);
  });
});

describe('helpers', () => {
  it('renderOutputTemplate substitutes nested output values', () => {
    expect(renderOutputTemplate('{output.deploy.url}/health', { deploy: { url: 'https://x.vercel.app' } }))
      .toBe('https://x.vercel.app/health');
    expect(renderOutputTemplate('{output.missing}', {})).toBe('');
  });

  it('readWorkflowSpec tolerates junk settings', () => {
    expect(readWorkflowSpec(null)).toBeNull();
    expect(readWorkflowSpec({ spec: { acceptance: 'nope' } })).toBeNull();
    expect(readWorkflowSpec({ spec: baseSpec() })?.objective).toBe('Deploy the store');
  });
});
