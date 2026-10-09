import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgenticAppControlPlane } from '../../src/components/apps/AgenticAppControlPlane';

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('<AgenticAppControlPlane />', () => {
  beforeEach(() => {
    localStorage.setItem('agentis.access', 'a.b.c');
    localStorage.setItem('agentis.workspace', 'ws-1');
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('discovers and invokes a semantic operation through the shared runtime', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      if (path === '/v1/apps/app-1/definition' && method === 'GET') {
        return response({ definition: null });
      }
      if (path === '/v1/apps/app-1/operations' && method === 'GET') {
        return response({
          operations: [
            {
              id: 'contact.search',
              title: 'Search contacts',
              description: 'Find matching CRM contacts.',
              mode: 'query',
              inputSchema: { type: 'object' },
              outputSchema: { type: 'object' },
              scopes: [],
              effects: [],
              handler: { kind: 'workflow', workflow: 'search-contacts' },
            },
          ],
        });
      }
      if (path === '/v1/apps/app-1/tasks' && method === 'GET') return response({ tasks: [] });
      if (path === '/v1/effects?appId=app-1' && method === 'GET') {
        return response({ effects: [] });
      }
      if (path === '/v1/apps/app-1/project' && method === 'GET') {
        return response({ project: null, builds: [] });
      }
      if (path === '/v1/apps/app-1/operations/contact.search/invoke' && method === 'POST') {
        expect(JSON.parse(String(init?.body))).toEqual({ input: {} });
        return response({ kind: 'result', data: { contacts: [] } });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AgenticAppControlPlane appId="app-1" appName="Revenue OS" />);

    expect(await screen.findByText('Find matching CRM contacts.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Invoke operation' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/v1/apps/app-1/operations/contact.search/invoke',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ input: {} }) }),
      );
    });
    expect(await screen.findByText('Search contacts invoked.')).toBeInTheDocument();
  });
});
