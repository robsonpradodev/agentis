import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AppEditorPage } from '../../src/pages/AppEditorPage';

vi.mock('../../src/pages/WorkflowCanvasPage', () => ({
  WorkflowCanvasPage: ({ workflowId }: { workflowId?: string }) => (
    <div data-testid="workflow-canvas">Canvas {workflowId}</div>
  ),
  WorkflowBrainTab: () => <div>Brain tab</div>,
}));

vi.mock('../../src/components/apps/AppRuntime', () => ({
  AppRuntime: () => <div data-testid="app-runtime">App runtime</div>,
}));

// The builder canvas subscribes to realtime via socket.io; stub it so tests
// never open a real connection.
vi.mock('socket.io-client', () => ({
  io: () => ({ on: () => {}, off: () => {}, emit: () => {}, disconnect: () => {}, io: { on: () => {} } }),
}));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function realtimeStreamResponse(path: string, method: string): Response | null {
  if (path === '/v1/workspaces/ws-1/canvas/stream' && method === 'GET') return new Response(null, { status: 204 });
  return null;
}

function appRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'app-1',
    workspaceId: 'ws-1',
    slug: 'store-outreach',
    name: 'Store outreach',
    description: '',
    version: '0.1.0',
    status: 'draft',
    entrySurfaceId: null,
    icon: null,
    manifest: { slug: 'store-outreach', name: 'Store outreach', version: '0.1.0', capabilities: [], requiredPlugins: [] },
    policy: { customCode: 'disabled', grants: [] },
    source: null,
    installedChecksum: null,
    createdBy: 'u-1',
    createdAt: '2026-06-23T00:00:00.000Z',
    updatedAt: '2026-06-23T00:00:00.000Z',
    ...overrides,
  };
}

function surfaceRow(name: string, view: unknown = { type: 'Stack', children: [] }, overrides: Record<string, unknown> = {}) {
  return {
    id: 'surface-1',
    appId: 'app-1',
    name,
    kind: 'page',
    view,
    actions: [],
    shareable: false,
    revision: 0,
    updatedAt: '2026-06-23T00:00:00.000Z',
    ...overrides,
  };
}

function renderEditor(facet: 'interface' | 'workflow' | 'data' | 'brain' = 'interface') {
  render(
    <MemoryRouter initialEntries={[`/apps/app-1?facet=${facet}`]}>
      <Routes>
        <Route path="/apps/:id" element={<><AppEditorPage /><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
}

describe('<AppEditorPage />', () => {
  beforeEach(() => {
    localStorage.setItem('agentis.access', 'a.b.c');
    localStorage.setItem('agentis.workspace', 'ws-1');
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reveals a completed managed React build instead of an empty legacy editor', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const realtime = realtimeStreamResponse(path, method);
      if (realtime) return realtime;
      if (path === '/v1/apps/app-1' && method === 'GET') return jsonResponse({ data: appRecord() });
      if (path === '/v1/apps/app-1/surfaces' && method === 'GET') {
        return jsonResponse({ data: [surfaceRow('legacy')] });
      }
      if (path === '/v1/apps/app-1/collections' && method === 'GET') return jsonResponse({ data: [] });
      if (path === '/v1/apps/app-1/workflows' && method === 'GET') return jsonResponse({ data: [] });
      if (path === '/v1/apps/app-1/project' && method === 'GET') return jsonResponse({
        project: { appId: 'app-1', headCommit: '1234567890abcdef' },
        builds: [{
          id: 'build-1', appId: 'app-1', workspaceId: 'ws-1', sourceCommit: '1234567890abcdef',
          status: 'completed', artifactPath: 'artifact', artifactSha256: 'sha', sbomPath: null,
          log: '', startedAt: null, completedAt: null, createdAt: '', updatedAt: '',
        }],
      });
      if (path === '/v1/apps/app-1/frontend/' && method === 'GET') {
        return new Response('<!doctype html><html><head></head><body><div>Real React UI</div></body></html>');
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderEditor('interface');

    expect(await screen.findByTitle('Managed app interface', {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(screen.queryByText('Empty surface')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent('mode=live'));
    expect(screen.getByRole('tab', { name: 'Workflow' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Runtime' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open interface full screen' }));
    expect(screen.getByRole('button', { name: 'Return to App' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Return to App' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open interface full screen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Return to App' }));
    expect(screen.queryByRole('button', { name: 'Return to App' })).not.toBeInTheDocument();
  });

  it('keeps the workflow facet mounted after renaming a workflow', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const realtime = realtimeStreamResponse(path, method);
      if (realtime) return realtime;

      if (path === '/v1/apps/app-1' && method === 'GET') return jsonResponse({ data: appRecord() });
      if (path === '/v1/apps/app-1/surfaces' && method === 'GET') return jsonResponse({ data: [] });
      if (path === '/v1/apps/app-1/collections' && method === 'GET') return jsonResponse({ data: [] });
      // Control-plane summary shape (E0): the page reads id + title directly, no per-workflow fetch.
      if (path === '/v1/apps/app-1/workflows' && method === 'GET') return jsonResponse({ data: [{ id: 'wf-1', title: 'Original workflow', purpose: null, order: 0, enabled: true, dependsOn: [], triggerKind: 'manual', lastRun: null }] });
      if (path === '/v1/workflows/wf-1' && method === 'PATCH') return jsonResponse({ ok: true });
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    vi.stubGlobal('fetch', fetchMock);
    renderEditor('workflow');

    await waitFor(() => expect(screen.getByTestId('workflow-canvas')).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'Original workflow' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Rename Original workflow' }));
    const input = screen.getByLabelText('Workflow title');
    await userEvent.clear(input);
    await userEvent.type(input, 'Renamed workflow');
    await userEvent.keyboard('{Enter}');

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/v1/workflows/wf-1',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ title: 'Renamed workflow' }) }),
      );
    });
    expect(screen.getByRole('tab', { name: 'Renamed workflow' })).toBeInTheDocument();
    expect(screen.getByTestId('workflow-canvas')).toHaveTextContent('Canvas wf-1');
  });

  it('keeps the selected workflow in the URL so viewport-aware chat can target it', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const realtime = realtimeStreamResponse(path, method);
      if (realtime) return realtime;
      if (path === '/v1/apps/app-1' && method === 'GET') return jsonResponse({ data: appRecord() });
      if (path === '/v1/apps/app-1/surfaces' && method === 'GET') return jsonResponse({ data: [] });
      if (path === '/v1/apps/app-1/collections' && method === 'GET') return jsonResponse({ data: [] });
      if (path === '/v1/apps/app-1/workflows' && method === 'GET') {
        return jsonResponse({ data: [
          { id: 'wf-1', title: 'Outbound ICP', purpose: null, order: 0, enabled: true, dependsOn: [], triggerKind: 'manual', lastRun: null },
          { id: 'wf-2', title: 'Follow-up', purpose: null, order: 1, enabled: true, dependsOn: [], triggerKind: 'manual', lastRun: null },
        ] });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderEditor('workflow');

    expect(await screen.findByTestId('workflow-canvas')).toHaveTextContent('Canvas wf-1');
    await userEvent.click(screen.getByRole('tab', { name: 'Follow-up' }));
    await waitFor(() => expect(screen.getByTestId('workflow-canvas')).toHaveTextContent('Canvas wf-2'));
    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent('workflow=wf-2'));
  });

  it('renames surfaces and adds a block on the live builder canvas', async () => {
    let surfaceName = 'surface';
    let lastSavedView: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const realtime = realtimeStreamResponse(path, method);
      if (realtime) return realtime;

      if (path === '/v1/apps/app-1' && method === 'GET') return jsonResponse({ data: appRecord() });
      if (path === '/v1/apps/app-1/surfaces' && method === 'GET') return jsonResponse({ data: [surfaceRow(surfaceName)] });
      if (path === '/v1/apps/app-1/collections' && method === 'GET') return jsonResponse({ data: [] });
      if (path === '/v1/apps/app-1/workflows' && method === 'GET') return jsonResponse({ data: [] });
      if (path === '/v1/apps/app-1/surfaces/surface' && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { name: string };
        surfaceName = body.name;
        return jsonResponse({ data: surfaceRow(surfaceName, { type: 'Stack', children: [] }, { revision: 1 }) });
      }
      if (path === '/v1/apps/app-1/surfaces' && method === 'PUT') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { view: unknown };
        lastSavedView = body.view;
        return jsonResponse({ data: surfaceRow(surfaceName, body.view, { revision: 2 }) });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    vi.stubGlobal('fetch', fetchMock);
    renderEditor('interface');

    await waitFor(() => expect(screen.getByRole('button', { name: 'surface' })).toBeInTheDocument());
    // Rename lives in the page's ⋯ menu (sidebar row).
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const surfaceInput = screen.getByLabelText('Surface name');
    await userEvent.clear(surfaceInput);
    await userEvent.type(surfaceInput, 'Main dashboard');
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Main dashboard' })).toBeInTheDocument());

    // Interface opens Live; editing is opt-in via the page's ⋯ menu.
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));

    // Add a Heading element from the palette — it renders live on the canvas.
    await userEvent.click(screen.getByRole('button', { name: 'Heading' }));
    expect(screen.getAllByText('New heading').length).toBeGreaterThan(0);

    await userEvent.click((await screen.findAllByRole('button', { name: 'More actions' }))[0]!);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Publish' }));
    await waitFor(() => {
      expect(lastSavedView).toMatchObject({ type: 'Stack', children: [{ type: 'Heading', value: 'New heading' }] });
    });
  });

  it('drops a data-bound section and persists its declared action', async () => {
    let lastSavedView: any = null;
    let lastSavedActions: any = null;
    const collection = {
      id: 'c1',
      appId: 'app-1',
      name: 'tasks',
      schema: { fields: [{ key: 'title', type: 'string', required: false, indexed: false }] },
      createdAt: '2026-06-23T00:00:00.000Z',
      updatedAt: '2026-06-23T00:00:00.000Z',
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const realtime = realtimeStreamResponse(path, method);
      if (realtime) return realtime;

      if (path === '/v1/apps/app-1' && method === 'GET') return jsonResponse({ data: appRecord() });
      if (path === '/v1/apps/app-1/surfaces' && method === 'GET') return jsonResponse({ data: [surfaceRow('surface')] });
      if (path === '/v1/apps/app-1/collections' && method === 'GET') return jsonResponse({ data: [collection] });
      if (path === '/v1/apps/app-1/workflows' && method === 'GET') return jsonResponse({ data: [] });
      if (path.startsWith('/v1/apps/app-1/collections/tasks/query')) return jsonResponse({ rows: [] });
      if (path === '/v1/apps/app-1/surfaces' && method === 'PUT') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { view: unknown; actions: unknown };
        lastSavedView = body.view;
        lastSavedActions = body.actions;
        return jsonResponse({ data: surfaceRow('surface', body.view, { revision: 2 }) });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    vi.stubGlobal('fetch', fetchMock);
    renderEditor('interface');

    await userEvent.click((await screen.findAllByRole('button', { name: 'More actions' }))[0]!);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Form' }));

    // The create form renders the collection field, and its insert action is declared.
    expect((await screen.findAllByText('Title')).length).toBeGreaterThan(0);

    await userEvent.click((await screen.findAllByRole('button', { name: 'More actions' }))[0]!);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Publish' }));
    await waitFor(() => {
      expect(JSON.stringify(lastSavedView)).toContain('"type":"Form"');
      expect(lastSavedActions).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'create_tasks', kind: 'data', target: 'tasks.insert' })]),
      );
    });
  });

  it('renders the GenUI palette in edit mode', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const realtime = realtimeStreamResponse(path, method);
      if (realtime) return realtime;
      if (path === '/v1/apps/app-1' && method === 'GET') return jsonResponse({ data: appRecord() });
      if (path === '/v1/apps/app-1/surfaces' && method === 'GET') return jsonResponse({ data: [surfaceRow('surface')] });
      if (path === '/v1/apps/app-1/collections' && method === 'GET') return jsonResponse({ data: [] });
      if (path === '/v1/apps/app-1/workflows' && method === 'GET') return jsonResponse({ data: [] });
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderEditor('interface');

    await userEvent.click((await screen.findAllByRole('button', { name: 'More actions' }))[0]!);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    for (const name of ['Hero', 'KPI strip', 'Chart', 'Table', 'Board', 'Tabs', 'Split', 'Callout', 'Code surface']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('opens the main chat with the exact selected page context', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const realtime = realtimeStreamResponse(path, method);
      if (realtime) return realtime;

      if (path === '/v1/apps/app-1' && method === 'GET') return jsonResponse({ data: appRecord() });
      if (path === '/v1/apps/app-1/surfaces' && method === 'GET') return jsonResponse({ data: [surfaceRow('surface')] });
      if (path === '/v1/apps/app-1/collections' && method === 'GET') return jsonResponse({ data: [] });
      if (path === '/v1/apps/app-1/workflows' && method === 'GET') return jsonResponse({ data: [] });
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    vi.stubGlobal('fetch', fetchMock);
    renderEditor('interface');
    const openChat = vi.fn();
    window.addEventListener('agentis:chat-panel-open', openChat, { once: true });

    await userEvent.click((await screen.findAllByRole('button', { name: 'More actions' }))[0]!);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Ask agent' }));

    expect(openChat).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.objectContaining({
        initialViewportOverride: expect.objectContaining({
          resourceId: 'app-1',
          appView: expect.objectContaining({ appId: 'app-1', page: 'surface', targetLocked: true }),
        }),
      }),
    }));
    expect(screen.queryByLabelText('Describe a surface')).not.toBeInTheDocument();
  });

  it('renders the activity stream without an operator command line', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const realtime = realtimeStreamResponse(path, method);
      if (realtime) return realtime;

      if (path === '/v1/apps/app-1' && method === 'GET') return jsonResponse({ data: appRecord() });
      if (path === '/v1/apps/app-1/surfaces' && method === 'GET') {
        return jsonResponse({ data: [surfaceRow('surface', { type: 'Stack', children: [{ type: 'ActivityStream' }] })] });
      }
      if (path === '/v1/apps/app-1/collections' && method === 'GET') return jsonResponse({ data: [] });
      if (path === '/v1/apps/app-1/workflows' && method === 'GET') return jsonResponse({ data: [] });
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    vi.stubGlobal('fetch', fetchMock);
    renderEditor('interface');

    await userEvent.click((await screen.findAllByRole('button', { name: 'More actions' }))[0]!);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));

    expect(await screen.findByText('Live activity')).toBeInTheDocument();
    expect(screen.queryByLabelText('Direct the operator')).not.toBeInTheDocument();
    expect(screen.getByText('Waiting for activity...')).toBeInTheDocument();
  });

  it('opens the App engine and saves settings from the merged Overview page', async () => {
    let appState = appRecord();
    let lastPatch: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const realtime = realtimeStreamResponse(path, method);
      if (realtime) return realtime;

      if (path === '/v1/apps/app-1' && method === 'GET') return jsonResponse({ data: appState });
      if (path === '/v1/apps/app-1/surfaces' && method === 'GET') return jsonResponse({ data: [surfaceRow('Dashboard')] });
      if (path === '/v1/apps/app-1/collections' && method === 'GET') return jsonResponse({ data: [] });
      if (path === '/v1/apps/app-1/workflows' && method === 'GET') return jsonResponse({ data: [] });
      if (path === '/v1/apps/app-1/definition' && method === 'GET') return jsonResponse({ definition: null });
      if (path === '/v1/apps/app-1/operations' && method === 'GET') return jsonResponse({ operations: [] });
      if (path === '/v1/apps/app-1/tasks' && method === 'GET') return jsonResponse({ tasks: [] });
      if (path === '/v1/effects?appId=app-1' && method === 'GET') return jsonResponse({ effects: [] });
      if (path === '/v1/apps/app-1/project' && method === 'GET') return jsonResponse({ project: null, builds: [] });
      if (path === '/v1/apps/app-1' && method === 'PATCH') {
        lastPatch = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        appState = {
          ...appState,
          ...lastPatch,
          policy: { ...(appState.policy as Record<string, unknown>), ...((lastPatch.policy as Record<string, unknown>) ?? {}) },
        };
        return jsonResponse({ data: appState });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    vi.stubGlobal('fetch', fetchMock);
    renderEditor('interface');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Store outreach' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'App engine' }));

    const dialog = screen.getByRole('dialog', { name: 'App engine' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Runtime' }));
    expect(await within(dialog).findByText('AGENTIC APP · SEMANTIC CONTROL PLANE')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Overview' }));
    // Overview is the default, merged (identity + entry surface + organization) page.
    await userEvent.clear(within(dialog).getByLabelText('Name'));
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Store Command Center');
    await userEvent.type(within(dialog).getByLabelText('Description'), 'Operator-facing store app.');
    await userEvent.selectOptions(within(dialog).getByLabelText('Entry surface'), 'surface-1');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Advanced' }));
    await userEvent.click(within(dialog).getByLabelText('Allow custom-coded views'));

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save settings' }));

    await waitFor(() => {
      expect(lastPatch).toMatchObject({
        name: 'Store Command Center',
        description: 'Operator-facing store app.',
        entrySurfaceId: 'surface-1',
        policy: { customCode: 'allowed', grants: [] },
      });
    });
    expect(screen.getByRole('button', { name: 'Store Command Center' })).toBeInTheDocument();
  });
});
