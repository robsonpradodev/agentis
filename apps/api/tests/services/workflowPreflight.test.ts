import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ExtensionManifest, WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { eq } from 'drizzle-orm';
import { preflightWorkflow } from '../../src/services/workflow/workflowPreflight.js';
import { createTestContext } from '../_helpers/createTestContext.js';

/** Insert a node_worker extension row and return its id. */
function seedExtension(db: AgentisSqliteDb, workspaceId: string, userId: string, source: string, outputSchema: Record<string, unknown> = {}): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  const manifest: ExtensionManifest = {
    name: 'Scraper',
    slug: 'scraper',
    version: '1.0.0',
    runtime: 'node_worker',
    entrypoint: 'scraper.js',
    source,
    operations: [{ name: 'execute', inputSchema: {}, outputSchema }],
    permissions: ['network'],
    capabilityTags: [],
  };
  db.insert(schema.extensions).values({
    id, workspaceId, ambientId: null, userId, packageId: null,
    name: manifest.name, slug: manifest.slug, version: manifest.version,
    runtime: manifest.runtime, manifest, createdAt: now, updatedAt: now,
  }).run();
  return id;
}

function extensionGraph(extensionId: string): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      { id: 'trigger', type: 'trigger', title: 'Input', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      {
        id: 'ext', type: 'extension_task', title: 'Scrape', position: { x: 200, y: 0 },
        config: { kind: 'extension_task', extensionId, operationName: 'execute', inputMapping: {}, outputMapping: {} },
      },
    ],
    edges: [{ id: 'edge', source: 'trigger', target: 'ext' }],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

function integrationGraph(
  inputs: Record<string, string>,
  options?: {
    integrationId?: string;
    operationId?: string;
    inputContract?: WorkflowGraph['inputContract'];
  },
): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      { id: 'trigger', type: 'trigger', title: 'Input', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      {
        id: 'notify', type: 'integration', title: 'Notify', position: { x: 200, y: 0 },
        config: {
          kind: 'integration',
          integrationId: options?.integrationId ?? 'slack',
          operationId: options?.operationId ?? 'send_message',
          inputs,
        },
      },
    ],
    edges: [{ id: 'edge', source: 'trigger', target: 'notify' }],
    viewport: { x: 0, y: 0, zoom: 1 },
    ...(options?.inputContract ? { inputContract: options.inputContract } : {}),
  };
}

function httpGraph(url: string): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      { id: 'trigger', type: 'trigger', title: 'Input', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      {
        id: 'call', type: 'http_request', title: 'Call API', position: { x: 200, y: 0 },
        config: { kind: 'http_request', method: 'GET', url },
      },
    ],
    edges: [{ id: 'edge', source: 'trigger', target: 'call' }],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

function agentGraph(): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      { id: 'trigger', type: 'trigger', title: 'Input', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      {
        id: 'draft',
        type: 'agent_task',
        title: 'Draft Digest',
        position: { x: 200, y: 0 },
        config: {
          kind: 'agent_task',
          prompt: 'Draft a digest.',
          capabilityTags: [],
          inputKeys: [],
          outputKeys: ['subject', 'htmlBody'],
        },
      },
    ],
    edges: [{ id: 'edge', source: 'trigger', target: 'draft' }],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

/** An agent_task explicitly PINNED to a specific agentId (for binding checks). */
function pinnedAgentGraph(agentId: string): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      { id: 'trigger', type: 'trigger', title: 'Input', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      {
        id: 'draft', type: 'agent_task', title: 'Draft Digest', position: { x: 200, y: 0 },
        config: { kind: 'agent_task', agentId, prompt: 'Draft a digest.', capabilityTags: [], inputKeys: [], outputKeys: ['subject'] },
      },
    ],
    edges: [{ id: 'edge', source: 'trigger', target: 'draft' }],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

function graph(expression: string): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        title: 'Lead input',
        position: { x: 0, y: 0 },
        config: { kind: 'trigger', triggerType: 'manual' },
      },
      {
        id: 'normalize',
        type: 'transform',
        title: 'Normalize Lead',
        position: { x: 200, y: 0 },
        config: { kind: 'transform', expression },
      },
    ],
    edges: [{ id: 'edge', source: 'trigger', target: 'normalize' }],
    viewport: { x: 0, y: 0, zoom: 1 },
    inputContract: {
      fields: [{ key: 'instagramHandle', type: 'string', required: true }],
    },
  };
}

describe('preflightWorkflow', () => {
  it('runs deterministic nodes with contract-derived input in milliseconds', async () => {
    const ctx = await createTestContext();
    const report = preflightWorkflow({
      db: ctx.db,
      workspaceId: ctx.workspace.id,
      workflowId: 'wf',
      graph: graph(`({ handle: input.instagramHandle || (() => { throw new Error('instagramHandle required') })() })`),
    });

    expect(report.status).toBe('healthy');
    expect(report.nodes.normalize?.status).toBe('passed');
    expect(report.nodes.normalize?.output).toEqual({ handle: 'sample_instagramHandle' });
    expect(report.durationMs).toBeLessThan(500);
  });

  it('blocks a workflow when representative input cannot execute a node', async () => {
    const ctx = await createTestContext();
    const broken = graph(`(() => { throw new Error('instagramHandle required') })()`);
    broken.inputContract = undefined;
    const report = preflightWorkflow({
      db: ctx.db,
      workspaceId: ctx.workspace.id,
      workflowId: 'wf-broken',
      graph: broken,
    });

    expect(report.status).toBe('blocked');
    expect(report.nodes.normalize?.status).toBe('failed');
    expect(report.issues[0]?.message).toContain('instagramHandle required');
  });

  it('run-gate mode does NOT fabricate input — a missing required value is blocked (matches the real run)', async () => {
    const ctx = await createTestContext();
    // The exact failing shape: a node that throws when its required input is absent.
    const g = graph(`({ handle: input.instagramHandle || (() => { throw new Error('instagramHandle is required') })() })`);
    // Canvas mode fabricates a sample and (intentionally) reports healthy.
    expect(preflightWorkflow({ db: ctx.db, workspaceId: ctx.workspace.id, workflowId: 'wf-rg', graph: g }).status)
      .toBe('healthy');
    // run-gate mode with the empty input the engine will actually use → blocked.
    const gated = preflightWorkflow({
      db: ctx.db, workspaceId: ctx.workspace.id, workflowId: 'wf-rg', graph: g, mode: 'run-gate', inputs: {},
    });
    expect(gated.status).toBe('blocked');
    expect(gated.scenario.source).toBe('empty');
    // The declared contract catches the missing field before simulation even runs.
    expect(gated.issues.some((i) => i.code === 'REQUIRED_INPUT_MISSING' && i.message.includes('instagramHandle'))).toBe(true);
  });

  it('run-gate blocks via node simulation when an uncontracted required input is missing', async () => {
    const ctx = await createTestContext();
    // No inputContract: the missing-input failure can only be caught by actually
    // simulating the node with the real empty input (not a fabricated sample).
    const g = graph(`({ handle: input.instagramHandle || (() => { throw new Error('instagramHandle is required') })() })`);
    g.inputContract = undefined;
    const gated = preflightWorkflow({
      db: ctx.db, workspaceId: ctx.workspace.id, workflowId: 'wf-rg2', graph: g, mode: 'run-gate', inputs: {},
    });
    expect(gated.status).toBe('blocked');
    expect(gated.nodes.normalize?.status).toBe('failed');
    expect(gated.issues.some((i) => i.message.includes('instagramHandle is required'))).toBe(true);
  });

  it('blocks a workflow whose extension uses require() — the "require is not defined" class', async () => {
    const ctx = await createTestContext();
    const extId = seedExtension(
      ctx.db, ctx.workspace.id, ctx.user.id,
      `const crypto = require('crypto');
       export async function execute(inputs, ctx) { return { id: crypto.randomUUID() }; }`,
    );
    const report = preflightWorkflow({
      db: ctx.db, workspaceId: ctx.workspace.id, workflowId: 'wf-ext', graph: extensionGraph(extId),
    });
    expect(report.status).toBe('blocked');
    expect(report.nodes.ext?.status).toBe('failed');
    const issue = report.issues.find((i) => i.nodeId === 'ext');
    expect(issue?.code).toBe('EXTENSION_SOURCE_INVALID');
    expect(issue?.autoRepairable).toBe(false);
  });

  it('passes (as mocked) a workflow whose extension source is sound', async () => {
    const ctx = await createTestContext();
    const extId = seedExtension(
      ctx.db, ctx.workspace.id, ctx.user.id,
      `export async function execute(inputs, ctx) {
         const res = await ctx.http.fetch('https://example.com');
         return { ok: res.ok };
       }`,
    );
    const report = preflightWorkflow({
      db: ctx.db, workspaceId: ctx.workspace.id, workflowId: 'wf-ext-ok', graph: extensionGraph(extId),
    });
    expect(report.status).toBe('unverified');
    expect(report.nodes.ext?.status).toBe('mocked');
  });

  it('synthesizes extension mock output from the declared operation schema', async () => {
    const ctx = await createTestContext();
    const extId = seedExtension(
      ctx.db, ctx.workspace.id, ctx.user.id,
      'export async function execute() { return { restaurants: [] }; }',
      {
        type: 'object',
        properties: {
          restaurants: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' }, latitude: { type: 'number' }, longitude: { type: 'number' } } },
          },
          fetchedCount: { type: 'number' },
        },
      },
    );
    const report = preflightWorkflow({
      db: ctx.db, workspaceId: ctx.workspace.id, workflowId: 'wf-ext-schema', graph: extensionGraph(extId),
    });

    expect(report.nodes.ext?.output).toMatchObject({
      restaurants: [{ name: 'sample_name', latitude: 1, longitude: 1 }],
      fetchedCount: 1,
    });

    const row = ctx.db.select().from(schema.extensions).where(eq(schema.extensions.id, extId)).get()!;
    const manifest = structuredClone(row.manifest as ExtensionManifest);
    manifest.operations[0]!.outputSchema = {
      type: 'object', properties: { fetchedCount: { type: 'number', default: 7 } },
    };
    ctx.db.update(schema.extensions).set({ manifest, updatedAt: new Date(Date.now() + 1_000).toISOString() })
      .where(eq(schema.extensions.id, extId)).run();
    const refreshed = preflightWorkflow({
      db: ctx.db, workspaceId: ctx.workspace.id, workflowId: 'wf-ext-schema', graph: extensionGraph(extId),
    });
    expect(refreshed.cacheHit).toBe(false);
    expect(refreshed.nodes.ext?.output).toMatchObject({ fetchedCount: 7 });
  });

  it('mocks data_mutate with the same receipt shape downstream nodes use at runtime', async () => {
    const ctx = await createTestContext();
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        { id: 'trigger', type: 'trigger', title: 'Input', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        {
          id: 'persist', type: 'data_mutate', title: 'Persist', position: { x: 200, y: 0 },
          config: { kind: 'data_mutate', operation: 'upsert', collection: 'rows', records: '{{= [trigger] }}', matchFields: ['id'], outputKey: 'stored' },
        },
        {
          id: 'summary', type: 'transform', title: 'Summary', position: { x: 400, y: 0 },
          config: { kind: 'transform', expression: '({ persistedCount: nodes.persist.mutationReceipt.succeeded })' },
        },
      ],
      edges: [
        { id: 'a', source: 'trigger', target: 'persist' },
        { id: 'b', source: 'persist', target: 'summary' },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    const report = preflightWorkflow({
      db: ctx.db, workspaceId: ctx.workspace.id, workflowId: 'wf-data-receipt', graph, inputs: { id: 'row-1' },
    });

    expect(report.status).not.toBe('blocked');
    expect(report.nodes.persist?.output).toMatchObject({ mutationReceipt: { attempted: 1, succeeded: 1, failed: 0 } });
    expect(report.nodes.summary?.output).toEqual({ persistedCount: 1 });
  });

  it('blocks an extension operation that is absent from the installed manifest', async () => {
    const ctx = await createTestContext();
    const extId = seedExtension(ctx.db, ctx.workspace.id, ctx.user.id, 'export async function execute() { return {}; }');
    const graph = extensionGraph(extId);
    const extensionNode = graph.nodes.find((node) => node.id === 'ext')!;
    extensionNode.config = { ...extensionNode.config, operationName: 'invented_operation' };
    const report = preflightWorkflow({
      db: ctx.db,
      workspaceId: ctx.workspace.id,
      workflowId: 'wf-ext-unknown-operation',
      graph,
    });

    expect(report.status).toBe('blocked');
    expect(report.issues).toContainEqual(expect.objectContaining({
      nodeId: 'ext',
      code: 'EXTENSION_OPERATION_NOT_FOUND',
      severity: 'error',
    }));
  });

  it('blocks when an extension_task references an extension that does not exist', async () => {
    const ctx = await createTestContext();
    const report = preflightWorkflow({
      db: ctx.db, workspaceId: ctx.workspace.id, workflowId: 'wf-ext-missing', graph: extensionGraph('does-not-exist'),
    });
    expect(report.status).toBe('blocked');
    expect(report.issues.find((i) => i.nodeId === 'ext')?.code).toBe('EXTENSION_NOT_FOUND');
  });

  it('blocks an integration node whose required operation field is unmapped', async () => {
    const ctx = await createTestContext();
    // slack.send_message requires channel + text; text is never mapped.
    const report = preflightWorkflow({
      db: ctx.db, workspaceId: ctx.workspace.id, workflowId: 'wf-int', graph: integrationGraph({ channel: '#general' }),
    });
    expect(report.status).toBe('blocked');
    expect(report.nodes.notify?.status).toBe('failed');
    const issue = report.issues.find((i) => i.nodeId === 'notify' && i.code === 'INTEGRATION_CONFIG_INCOMPLETE');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain('text');
    expect(issue?.autoRepairable).toBe(false);
  });

  it('passes (as mocked) an integration node whose contract is satisfied', async () => {
    const ctx = await createTestContext();
    const report = preflightWorkflow({
      db: ctx.db, workspaceId: ctx.workspace.id, workflowId: 'wf-int-ok',
      graph: integrationGraph({ channel: '#general', text: 'Hello team' }),
    });
    expect(report.status).toBe('unverified');
    expect(report.nodes.notify?.status).toBe('mocked');
    expect(report.issues.some((i) => i.code === 'INTEGRATION_CONFIG_INCOMPLETE')).toBe(false);
  });

  it('blocks when a requiredAny group has no mapped field', async () => {
    const ctx = await createTestContext();
    // agentmail.send_message requires to + subject + one of text/html/markdown/body.
    const report = preflightWorkflow({
      db: ctx.db, workspaceId: ctx.workspace.id, workflowId: 'wf-int-any',
      graph: integrationGraph({ to: 'a@b.com', subject: 'Hi' }, { integrationId: 'agentmail', operationId: 'send_message' }),
    });
    expect(report.status).toBe('blocked');
    const issue = report.issues.find((i) => i.nodeId === 'notify' && i.code === 'INTEGRATION_CONFIG_INCOMPLETE');
    expect(issue).toBeDefined();
    expect(issue?.message).toContain('text or html or markdown or body');
  });

  it('treats a field mapped from resolved upstream output as satisfied', async () => {
    const ctx = await createTestContext();
    // The text comes from a template — canvas mode fabricates a contract sample
    // so it resolves to a real value, satisfying the contract.
    const report = preflightWorkflow({
      db: ctx.db, workspaceId: ctx.workspace.id, workflowId: 'wf-int-tmpl',
      graph: integrationGraph(
        { channel: '#general', text: '{{trigger.message}}' },
        { inputContract: { fields: [{ key: 'message', type: 'string', required: true }] } },
      ),
    });
    expect(report.nodes.notify?.status).toBe('mocked');
    expect(report.issues.some((i) => i.code === 'INTEGRATION_CONFIG_INCOMPLETE')).toBe(false);
  });

  it('blocks an http_request node whose url resolves to empty', async () => {
    const ctx = await createTestContext();
    // The url is a non-empty template (passes the static graph check) but the
    // referenced value is absent, so it collapses to empty against real input.
    const report = preflightWorkflow({
      db: ctx.db, workspaceId: ctx.workspace.id, workflowId: 'wf-http', graph: httpGraph('{{trigger.endpoint}}'),
    });
    expect(report.status).toBe('blocked');
    expect(report.nodes.call?.status).toBe('failed');
    const issue = report.issues.find((i) => i.nodeId === 'call');
    expect(issue?.code).toBe('INTEGRATION_CONFIG_INCOMPLETE');
    expect(issue?.message).toContain('url');
  });

  it('passes (as mocked) an http_request node with a resolvable url', async () => {
    const ctx = await createTestContext();
    const report = preflightWorkflow({
      db: ctx.db, workspaceId: ctx.workspace.id, workflowId: 'wf-http-ok', graph: httpGraph('https://example.com/health'),
    });
    expect(report.nodes.call?.status).toBe('mocked');
    expect(report.issues.some((i) => i.code === 'INTEGRATION_CONFIG_INCOMPLETE')).toBe(false);
  });

  it('marks agent nodes with declared output keys as unverified preflight samples', async () => {
    const ctx = await createTestContext();
    const report = preflightWorkflow({
      db: ctx.db, workspaceId: ctx.workspace.id, workflowId: 'wf-agent', graph: agentGraph(),
    });

    expect(report.status).toBe('unverified');
    expect(report.nodes.draft?.status).toBe('unverified');
    expect(report.nodes.draft?.output).toMatchObject({
      subject: 'sample_subject',
      htmlBody: 'sample_htmlBody',
      _preflight: {
        mocked: true,
        declaredOutputKeys: ['subject', 'htmlBody'],
      },
    });
  });

  it('warns when an agent node is pinned to a non-functional (no-runtime) agent', async () => {
    const ctx = await createTestContext();
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      name: 'Claude Code', adapterType: 'http', capabilityTags: [], config: {}, runtimeModel: null, role: 'worker', status: 'offline',
    }).run();
    const report = preflightWorkflow({ db: ctx.db, workspaceId: ctx.workspace.id, workflowId: 'wf-pin', graph: pinnedAgentGraph(agentId) });
    const issue = report.issues.find((i) => i.nodeId === 'draft' && i.code === 'AGENT_NO_RUNTIME');
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toContain('no connected runtime');
  });

  it('warns when an agent node is pinned to an agent that no longer exists', async () => {
    const ctx = await createTestContext();
    const report = preflightWorkflow({ db: ctx.db, workspaceId: ctx.workspace.id, workflowId: 'wf-missing', graph: pinnedAgentGraph(randomUUID()) });
    expect(report.issues.some((i) => i.nodeId === 'draft' && i.code === 'AGENT_NOT_FOUND')).toBe(true);
  });

  it('does not warn when the pinned agent has a working model', async () => {
    const ctx = await createTestContext();
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      name: 'Orchy', adapterType: 'codex', capabilityTags: [], config: { model: 'gpt-5' }, runtimeModel: 'gpt-5', role: 'orchestrator', status: 'online',
    }).run();
    const report = preflightWorkflow({ db: ctx.db, workspaceId: ctx.workspace.id, workflowId: 'wf-ok', graph: pinnedAgentGraph(agentId) });
    expect(report.issues.some((i) => i.code === 'AGENT_NO_RUNTIME' || i.code === 'AGENT_NOT_FOUND')).toBe(false);
  });

  it('returns cached reports without rerunning the graph', async () => {
    const ctx = await createTestContext();
    const args = {
      db: ctx.db,
      workspaceId: ctx.workspace.id,
      workflowId: 'wf-cache',
      graph: graph(`({ handle: input.instagramHandle })`),
    };
    expect(preflightWorkflow(args).cacheHit).toBe(false);
    const cached = preflightWorkflow(args);
    expect(cached.cacheHit).toBe(true);
    expect(cached.durationMs).toBeLessThan(10);
  });

  it('blocks an action Agent Task without an effect contract', async () => {
    const ctx = await createTestContext();
    const graph = agentGraph();
    const task = graph.nodes.find((node) => node.id === 'draft')!;
    task.config = { ...task.config, kind: 'agent_task', prompt: 'Send a WhatsApp message and update the lead', taskMode: 'act', completionContract: undefined } as never;
    const report = preflightWorkflow({ db: ctx.db, workspaceId: ctx.workspace.id, workflowId: 'wf-action-contract', graph });
    expect(report.issues.some((issue) => issue.code === 'ACTION_COMPLETION_CONTRACT_MISSING' && issue.severity === 'error')).toBe(true);
  });

  it('allows a minimal action Agent Task with declared native effects', async () => {
    const ctx = await createTestContext();
    const graph = agentGraph();
    const task = graph.nodes.find((node) => node.id === 'draft')!;
    task.config = { ...task.config, kind: 'agent_task', prompt: 'Send a WhatsApp message and update the lead', taskMode: 'act', completionContract: { requiredEffects: ['channel_delivery', 'data_mutation'] } } as never;
    const report = preflightWorkflow({ db: ctx.db, workspaceId: ctx.workspace.id, workflowId: 'wf-minimal-action', graph });
    expect(report.issues.some((issue) => issue.code === 'ACTION_COMPLETION_CONTRACT_MISSING' || issue.code === 'AGENT_SELF_REPORTED_DELIVERY')).toBe(false);
  });
});
