/**
 * APP-INTERFACE-10X blocks — the archetype workhorses (Kanban / RecordMaster /
 * Roadmap / PipelineFlow) and the live-ops plane registrations. Proves they
 * register on the open seam, bind rows through the runtime client, and that
 * Kanban writes the groupBy field back through the declared update action.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentisAppClient } from '@agentis/app-client';
import type { ViewNode } from '@agentis/core';
import { RuntimeProvider, ViewRenderer } from '../../src/components/apps/ViewRenderer';
import { hasBlock } from '../../src/components/apps/blocks/registry';
import { appsApi } from '../../src/lib/appsApi';

vi.mock('socket.io-client', () => ({
  io: () => ({ on: () => {}, off: () => {}, emit: () => {}, disconnect: () => {}, io: { on: () => {} } }),
}));

// The ops blocks hit /v1/apps + /v1/runs + /v1/approvals through the api layer.
vi.mock('../../src/lib/appsApi', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/lib/appsApi')>();
  return {
    ...mod,
    appsApi: {
      ...mod.appsApi,
      listWorkflows: vi.fn(async () => []),
      doctor: vi.fn(async () => ({
        appId: 'app-1', generatedAt: new Date().toISOString(), health: 'healthy', readyForUnattended: true,
        summary: { critical: 0, error: 0, warning: 0, info: 0, workflows: 1, executableRules: 1 },
        topology: { roots: ['wf-1'], dependencyEdges: 0, activeEventSubscriptions: 1, activeTriggers: 0, conversationTransitions: 0 },
        findings: [],
      })),
      orchestrationRules: vi.fn(async () => [{
        id: 'rule-1', sourceWorkflowId: 'wf-1', targetWorkflowId: 'wf-1', eventType: 'run.accomplished',
        sourceNodeId: null, filterExpression: null, inputMapping: {}, coalescePolicy: 'latest_only', catchupPolicy: 'none', enabled: true,
      }]),
      createOrchestrationRule: vi.fn(async (_appId, body) => ({ id: 'rule-new', ...body })),
      updateOrchestrationRule: vi.fn(async (_appId, ruleId, body) => ({ id: ruleId, ...body })),
      deleteOrchestrationRule: vi.fn(async () => ({ ok: true as const })),
    },
  };
});
vi.mock('../../src/lib/opsApi', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/lib/opsApi')>();
  return {
    ...mod,
    opsApi: {
      ...mod.opsApi,
      listRuns: vi.fn(async () => []),
      listApprovals: vi.fn(async () => []),
    },
  };
});

function stubClient(rows: Array<Record<string, unknown>> = []) {
  const invoke = vi.fn(async () => ({}));
  const client = {
    data: { query: vi.fn(async () => rows) },
    state: { get: async () => undefined, set: async () => {}, subscribe: () => () => {} },
    actions: { invoke },
    navigation: { go: async () => {} },
    realtime: { subscribe: () => () => {} },
    files: { upload: async () => { throw new Error('unsupported'); } },
  } as unknown as AgentisAppClient;
  return { client, invoke };
}

function renderNode(node: ViewNode, rows: Array<Record<string, unknown>> = []) {
  const { client, invoke } = stubClient(rows);
  const utils = render(
    <RuntimeProvider value={{ appId: 'app-1', surface: 'main', client, surfaceActions: [{ name: 'update_leads', kind: 'data', target: 'leads.update' }], uiState: {}, allowCustomCode: false, dataRevision: 0 }}>
      <ViewRenderer node={node} />
    </RuntimeProvider>,
  );
  return { ...utils, invoke };
}

describe('block registrations (open seam)', () => {
  it('registers the archetype + live-ops kinds, and WorkflowControl stays aliased', () => {
    for (const kind of ['Kanban', 'RecordMaster', 'Roadmap', 'PipelineFlow', 'OrchestrationPanel', 'RunMonitor', 'AgentFeed', 'ApprovalsInbox', 'WorkflowControl']) {
      expect(hasBlock(kind), `missing block: ${kind}`).toBe(true);
    }
  });
});

describe('OrchestrationPanel', () => {
  it('starts as a compact card and expands to the workflow list', async () => {
    vi.mocked(appsApi.listWorkflows).mockResolvedValueOnce([
      {
        id: 'wf-1',
        title: 'Fashion ICP Finder',
        purpose: 'Qualifies the next store leads.',
        order: 0,
        enabled: true,
        dependsOn: [],
        triggerKind: 'manual',
        lastRun: null,
      } as Awaited<ReturnType<typeof appsApi.listWorkflows>>[number],
    ]);

    renderNode({ type: 'OrchestrationPanel' } as ViewNode);

    const expand = await screen.findByRole('button', { name: /expand orchestration/i });
    expect(screen.getByText('1 workflow')).toBeTruthy();
    expect(screen.queryByText('Fashion ICP Finder')).toBeNull();

    await userEvent.click(expand);
    expect((await screen.findAllByText('Fashion ICP Finder')).length).toBeGreaterThan(0);
    expect(await screen.findByText('Executable control plane')).toBeTruthy();
    expect(screen.getByText('run.accomplished')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /run pipeline/i })).toBeNull();
  });

  it('creates a persisted success-gated rule with mapped inputs', async () => {
    vi.mocked(appsApi.listWorkflows).mockResolvedValueOnce([
      { id: 'wf-1', title: 'Discover', purpose: null, order: 0, enabled: true, dependsOn: [], triggerKind: 'manual', lastRun: null },
      { id: 'wf-2', title: 'Contact', purpose: null, order: 1, enabled: true, dependsOn: [], triggerKind: 'manual', lastRun: null },
    ] as Awaited<ReturnType<typeof appsApi.listWorkflows>>);
    vi.mocked(appsApi.orchestrationRules).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    renderNode({ type: 'OrchestrationPanel' } as ViewNode);
    await userEvent.click(await screen.findByRole('button', { name: /expand orchestration/i }));
    await userEvent.click(await screen.findByRole('button', { name: /new event rule/i }));
    await userEvent.click(screen.getByRole('button', { name: /add mapping/i }));
    await userEvent.type(screen.getByLabelText('Target input key'), 'leadId');
    await userEvent.type(screen.getByLabelText('Source event path'), 'payload.output.lead.id');
    const doctorCallsBeforeSave = vi.mocked(appsApi.doctor).mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: /persist rule/i }));

    await waitFor(() => expect(appsApi.createOrchestrationRule).toHaveBeenCalledWith('app-1', expect.objectContaining({
      sourceWorkflowId: 'wf-1',
      targetWorkflowId: 'wf-2',
      eventType: 'run.accomplished',
      inputMapping: { leadId: 'payload.output.lead.id' },
      coalescePolicy: 'coalesce_pending',
      enabled: true,
    })));
    expect(vi.mocked(appsApi.doctor).mock.calls.length).toBeGreaterThan(doctorCallsBeforeSave);
  });

  it('edits, disables, and deletes an executable rule through persisted API operations', async () => {
    vi.mocked(appsApi.listWorkflows).mockResolvedValueOnce([
      { id: 'wf-1', title: 'Discover', purpose: null, order: 0, enabled: true, dependsOn: [], triggerKind: 'manual', lastRun: null },
      { id: 'wf-2', title: 'Contact', purpose: null, order: 1, enabled: true, dependsOn: [], triggerKind: 'manual', lastRun: null },
    ] as Awaited<ReturnType<typeof appsApi.listWorkflows>>);
    vi.mocked(appsApi.orchestrationRules).mockResolvedValue([{
      id: 'rule-1', sourceWorkflowId: 'wf-1', targetWorkflowId: 'wf-2', eventType: 'run.accomplished',
      sourceNodeId: null, filterExpression: null, inputMapping: {}, coalescePolicy: 'latest_only', catchupPolicy: 'none', enabled: true,
    }]);

    renderNode({ type: 'OrchestrationPanel' } as ViewNode);
    await userEvent.click(await screen.findByRole('button', { name: /expand orchestration/i }));
    await userEvent.click(await screen.findByRole('button', { name: /edit rule from discover/i }));
    await userEvent.type(screen.getByLabelText('Filter expression'), 'payload.score >= 0.8');
    await userEvent.click(screen.getByRole('button', { name: /persist rule/i }));
    await waitFor(() => expect(appsApi.updateOrchestrationRule).toHaveBeenCalledWith('app-1', 'rule-1', expect.objectContaining({ filterExpression: 'payload.score >= 0.8' })));

    await userEvent.click(screen.getByRole('button', { name: /disable rule from discover/i }));
    await waitFor(() => expect(appsApi.updateOrchestrationRule).toHaveBeenCalledWith('app-1', 'rule-1', { enabled: false }));

    await userEvent.click(screen.getByRole('button', { name: /delete rule from discover/i }));
    await userEvent.click(screen.getByRole('button', { name: /confirm delete rule/i }));
    await waitFor(() => expect(appsApi.deleteOrchestrationRule).toHaveBeenCalledWith('app-1', 'rule-1'));
  });
});

describe('Kanban', () => {
  const rows = [
    { id: 'r1', name: 'Acme', stage: 'new', amount: 1200 },
    { id: 'r2', name: 'Globex', stage: 'won', amount: 800 },
  ];
  const node: ViewNode = {
    type: 'Kanban',
    bind: { collection: 'leads', live: true },
    groupBy: 'stage',
    titleField: 'name',
    valueField: 'amount',
    update: { action: 'update_leads' },
  };

  it('groups rows into columns with counts', async () => {
    renderNode(node, rows);
    await waitFor(() => expect(screen.getByText('Acme')).toBeTruthy());
    expect(screen.getByText('Globex')).toBeTruthy();
    expect(screen.getByText('New')).toBeTruthy();
    expect(screen.getByText('Won')).toBeTruthy();
  });

  it('drop on another column dispatches the update action with {id, patch}', async () => {
    const { invoke } = renderNode(node, rows);
    await waitFor(() => expect(screen.getByText('Acme')).toBeTruthy());
    const card = screen.getByText('Acme').closest('[draggable]') as HTMLElement;
    const wonHeader = screen.getByText('Won').closest('.s-round') as HTMLElement;
    expect(card).toBeTruthy();
    expect(wonHeader).toBeTruthy();
    const dataTransfer = {
      data: {} as Record<string, string>,
      setData(type: string, value: string) { this.data[type] = value; },
      getData(type: string) { return this.data[type] ?? ''; },
      effectAllowed: '',
    };
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(wonHeader, { dataTransfer });
    fireEvent.drop(wonHeader, { dataTransfer });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_leads', { id: 'r1', patch: { stage: 'won' } }));
  });
});

describe('Calendar — drag-to-reschedule (INTEGRATION-CEILING-10X §6)', () => {
  const now = new Date();
  const day5 = new Date(now.getFullYear(), now.getMonth(), 5).toISOString();
  const rows = [{ id: 'post-1', title: 'Downtown Loft listing', date: day5 }];
  const node: ViewNode = {
    type: 'Calendar',
    bind: { collection: 'posts', live: true },
    dateField: 'date',
    labelField: 'title',
    update: { action: 'reschedule_post' },
  };

  it('renders the bound event on its day', async () => {
    renderNode(node, rows);
    await waitFor(() => expect(screen.getByText('Downtown Loft listing')).toBeTruthy());
  });

  it('dragging an event to a new day dispatches the update action with { id, patch: { date } }', async () => {
    const { invoke } = renderNode(node, rows);
    await waitFor(() => expect(screen.getByText('Downtown Loft listing')).toBeTruthy());
    const card = screen.getByText('Downtown Loft listing');
    expect(card.getAttribute('draggable')).toBe('true');

    // Day-20 cell: locate by its day-number label, walking up to the day cell container.
    const day20Label = screen.getByText('20');
    const day20Cell = day20Label.closest('div.min-h-14') as HTMLElement;
    expect(day20Cell).toBeTruthy();

    const dataTransfer = {
      data: {} as Record<string, string>,
      setData(type: string, value: string) { this.data[type] = value; },
      getData(type: string) { return this.data[type] ?? ''; },
      effectAllowed: '',
    };
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(day20Cell, { dataTransfer });
    fireEvent.drop(day20Cell, { dataTransfer });

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    const call = invoke.mock.calls[0]!;
    expect(call[0]).toBe('reschedule_post');
    const args = call[1] as { id: string; patch: { date: string } };
    expect(args.id).toBe('post-1');
    const patched = new Date(args.patch.date);
    expect(patched.getDate()).toBe(20);
    expect(patched.getMonth()).toBe(now.getMonth());
  });

  it('an unbound Calendar (no update action) renders events read-only, not draggable', async () => {
    renderNode({ type: 'Calendar', events: [{ date: day5, label: 'Static event' }] }, []);
    await waitFor(() => expect(screen.getByText('Static event')).toBeTruthy());
    expect(screen.getByText('Static event').getAttribute('draggable')).not.toBe('true');
  });
});

describe('RecordMaster', () => {
  it('renders the master list and the selected record page', async () => {
    renderNode(
      {
        type: 'RecordMaster',
        bind: { collection: 'contacts', live: true },
        titleField: 'name',
        statusField: 'status',
      },
      [
        { id: 'c1', name: 'Ada Lovelace', email: 'ada@calc.io', status: 'active' },
        { id: 'c2', name: 'Alan Turing', email: 'alan@bletchley.uk', status: 'paused' },
      ],
    );
    await waitFor(() => expect(screen.getAllByText('Ada Lovelace').length).toBeGreaterThan(0));
    // First record selected by default → its record page shows the email field
    // (the email also appears as the master-list subtitle, hence getAllByText).
    expect(screen.getAllByText('ada@calc.io').length).toBeGreaterThan(0);
    expect(screen.getByPlaceholderText('Search…')).toBeTruthy();
  });
  it('renders URL fields as clickable links in the selected record page', async () => {
    renderNode(
      {
        type: 'RecordMaster',
        bind: { collection: 'contacts', live: true },
        titleField: 'name',
        sections: [{ title: 'Contact', fields: ['whatsapp_link'] }],
      },
      [{ id: 'c1', name: 'Example Boutique', whatsapp_link: 'https://wa.me/15551234567' }],
    );

    const link = await screen.findByRole('link', { name: /wa\.me\/15551234567/i });
    expect(link).toHaveAttribute('href', 'https://wa.me/15551234567');
  });
});

describe('PipelineFlow', () => {
  it('computes stage counts and conversion', async () => {
    renderNode(
      { type: 'PipelineFlow', bind: { collection: 'leads', live: true }, stageField: 'stage', valueField: 'amount' },
      [
        { id: '1', stage: 'new', amount: 100 },
        { id: '2', stage: 'new', amount: 50 },
        { id: '3', stage: 'won', amount: 70 },
      ],
    );
    await waitFor(() => expect(screen.getByText('New')).toBeTruthy());
    expect(screen.getByText('2')).toBeTruthy(); // new count
    expect(screen.getByText('50%')).toBeTruthy(); // conversion new → won
  });
});

describe('Roadmap', () => {
  it('draws lane bars from date fields', async () => {
    renderNode(
      { type: 'Roadmap', bind: { collection: 'releases', live: true }, labelField: 'title', startField: 'start', endField: 'end', laneField: 'track' },
      [
        { id: '1', title: 'v1 launch', start: '2026-07-01', end: '2026-07-20', track: 'core' },
        { id: '2', title: 'mobile beta', start: '2026-07-10', end: '2026-08-01', track: 'mobile' },
      ],
    );
    await waitFor(() => expect(screen.getByText('v1 launch')).toBeTruthy());
    expect(screen.getByText('mobile beta')).toBeTruthy();
    expect(screen.getByText('Core')).toBeTruthy();
    expect(screen.getByText('Mobile')).toBeTruthy();
  });
});
