/**
 * AgentChannelsTab — provider cards + WhatsApp QR flow
 * (OMNICHANNEL-ORCHESTRATOR-10X §3).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentChannelsTab } from '../../src/components/agents/AgentChannelsTab';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('<AgentChannelsTab />', () => {
  beforeEach(() => {
    localStorage.setItem('agentis.access', 'a.b.c');
    localStorage.setItem('agentis.workspace', 'ws-1');
  });
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('renders all four provider cards', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ connections: [] })));
    render(<AgentChannelsTab agentId="a1" agentName="Orchestrator" />);
    await waitFor(() => expect(screen.getByText('Telegram')).toBeInTheDocument());
    expect(screen.getByText('WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('Slack')).toBeInTheDocument();
    expect(screen.getByText('Discord')).toBeInTheDocument();
  });

  it('WhatsApp connect creates a connection then shows a QR to scan', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method });
      if (url === '/v1/channels' && method === 'GET') return jsonResponse({ connections: [] });
      if (url === '/v1/channels' && method === 'POST') return jsonResponse({ connection: { id: 'c1', kind: 'whatsapp' } }, 201);
      if (url === '/v1/channels/c1/login' && method === 'POST') {
        return jsonResponse({ connectionId: 'c1', status: 'qr', qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=' });
      }
      if (url === '/v1/channels/c1/login' && method === 'GET') return jsonResponse({ connectionId: 'c1', status: 'qr' });
      return jsonResponse({});
    }));

    render(<AgentChannelsTab agentId="a1" agentName="Orchestrator" />);
    await waitFor(() => expect(screen.getByText('WhatsApp')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /Connect WhatsApp/i }));
    await userEvent.click(screen.getByRole('button', { name: /Show QR/i }));

    // QR image appears + linked-devices instruction.
    await waitFor(() => expect(screen.getByAltText(/WhatsApp login QR/i)).toBeInTheDocument());
    expect(screen.getByText(/Linked Devices/i)).toBeInTheDocument();

    // It created the connection (no token) then started a login.
    expect(calls.some((c) => c.url === '/v1/channels' && c.method === 'POST')).toBe(true);
    expect(calls.some((c) => c.url === '/v1/channels/c1/login' && c.method === 'POST')).toBe(true);
  });

  it('replaces a closed pairing spinner with an immediate retry action', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method });
      if (url === '/v1/channels' && method === 'GET') return jsonResponse({ connections: [] });
      if (url === '/v1/channels' && method === 'POST') return jsonResponse({ connection: { id: 'c1', kind: 'whatsapp' } }, 201);
      if (url === '/v1/channels/c1/login') {
        return jsonResponse({
          connectionId: 'c1', status: 'closed',
          recovery: { reason: 'connection_closed', attempt: 2, nextRetryAt: '2026-08-17T14:13:50.512Z' },
        });
      }
      return jsonResponse({});
    }));

    render(<AgentChannelsTab agentId="a1" agentName="Orchestrator" />);
    await waitFor(() => expect(screen.getByText('WhatsApp')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Connect WhatsApp/i }));
    await userEvent.click(screen.getByRole('button', { name: /Show QR/i }));

    expect(await screen.findByText(/closed the pairing transport/i)).toBeInTheDocument();
    expect(screen.queryByAltText(/WhatsApp login QR/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Retry now/i }));
    await waitFor(() => expect(calls.filter((call) => call.url === '/v1/channels/c1/login' && call.method === 'POST')).toHaveLength(2));
  });

  it('Telegram shows a token form with a long-polling toggle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ connections: [] })));
    render(<AgentChannelsTab agentId="a1" agentName="Orchestrator" />);
    await waitFor(() => expect(screen.getByText('Telegram')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /Connect Telegram/i }));
    expect(screen.getByText(/long polling/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Paste token/i)).toBeInTheDocument();
  });

  it('saves a default recipient on an existing channel', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url === '/v1/channels' && method === 'GET') {
        return jsonResponse({
          connections: [{
            id: 'wa1',
            agentId: 'a1',
            kind: 'whatsapp',
            name: 'Orchy WhatsApp',
            status: 'active',
            mode: 'qr_local',
            defaultChatId: null,
            targetAliases: {},
            health: { status: 'active', checks: [] },
          }],
        });
      }
      if (url === '/v1/channels/wa1/targets' && method === 'PATCH') {
        return jsonResponse({
          connection: {
            id: 'wa1',
            agentId: 'a1',
            kind: 'whatsapp',
            name: 'Orchy WhatsApp',
            status: 'active',
            mode: 'qr_local',
            defaultChatId: '12345678901@s.whatsapp.net',
            targetAliases: { me: '12345678901@s.whatsapp.net' },
            health: { status: 'active', checks: [] },
          },
          health: { status: 'active', checks: [] },
        });
      }
      return jsonResponse({});
    }));

    render(<AgentChannelsTab agentId="a1" agentName="Orchestrator" />);
    await waitFor(() => expect(screen.getByText(/Orchy WhatsApp/)).toBeInTheDocument());

    await userEvent.type(screen.getByPlaceholderText(/\+12345678901/i), '+1 234 567-8901');
    await userEvent.click(screen.getByLabelText(/This is my owner\/operator chat/i));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Robson/i), 'Robson');
    await userEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(calls.some((call) => call.url === '/v1/channels/wa1/targets' && call.method === 'PATCH')).toBe(true));
    const targetCall = calls.find((call) => call.url === '/v1/channels/wa1/targets');
    expect(targetCall?.body).toContain('+1 234 567-8901');
    expect(targetCall?.body).toContain('ownerChatId');
    expect(targetCall?.body).toContain('ownerName');
  });

  it('exposes manual handoff controls while keeping the owner/operator exception unconditional', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const connection = {
      id: 'wa-owner', agentId: 'a1', kind: 'whatsapp', name: 'Owner WhatsApp', status: 'active', mode: 'qr_local',
      defaultChatId: '553171443148@s.whatsapp.net', ownerChatId: '553171443148@s.whatsapp.net', targetAliases: {},
      whatsappProfile: {
        version: 3, ownerReasoningVisibility: 'off', manualOutboundTakeover: 'until_handback',
        ownerManualOutboundTakeover: 'off', historyReconciliation: 'recent',
      },
      health: { status: 'active', checks: [] },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url === '/v1/channels' && method === 'GET') return jsonResponse({ connections: [connection] });
      if (url === '/v1/channels/wa-owner/behavior' && method === 'PATCH') return jsonResponse({ connection });
      return jsonResponse({});
    }));

    render(<AgentChannelsTab agentId="a1" agentName="Orchestrator" />);
    await waitFor(() => expect(screen.getByDisplayValue('553171443148@s.whatsapp.net')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Behavior & safety/i }));
    expect(screen.getByLabelText(/Pause automation in a conversation/i)).toBeChecked();
    expect(screen.queryByLabelText(/Also pause automation for the owner\/operator chat/i)).not.toBeInTheDocument();
    expect(screen.getByText(/owner\/operator conversation always remains active/i)).toBeInTheDocument();
    expect(calls.some((call) => call.url === '/v1/channels/wa-owner/behavior')).toBe(false);
  });

  it('renders canonical contact context and the durable outbound action ledger', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/v1/channels') return jsonResponse({
        connections: [{
          id: 'wa1', agentId: 'a1', kind: 'whatsapp', name: 'Bia WhatsApp', status: 'active', mode: 'qr_local',
          defaultChatId: null, ownerChatId: null, targetAliases: {}, health: { status: 'active', checks: [] },
        }],
      });
      if (url.startsWith('/v1/channels/inbox?')) return jsonResponse({
        peers: [{
          recipientRef: 'peer:p1', peerIdentityId: 'p1', connectionId: 'wa1', channelKind: 'whatsapp',
          displayName: 'atacadaosertaneja', conversationId: 'conv1', lastInboundAt: '2026-08-25T16:30:00.000Z',
          lastOutboundAt: null, lastMessageAt: '2026-08-25T16:30:00.000Z', lastMessagePreview: 'Boa tarde',
          lastMessageDirection: 'inbound', handoffState: 'agent', subjectId: 'subject1', stage: 'qualified',
          goal: 'Book a product demonstration', aliases: [
            { value: '5531999@s.whatsapp.net', kind: 'pn', verified: true },
            { value: '8822@lid', kind: 'lid', verified: true },
          ],
        }],
      });
      if (url.startsWith('/v1/channels/actions?')) return jsonResponse({
        actions: [{
          id: 'action1', agentId: 'a1', connectionId: 'wa1', peerIdentityId: 'p1',
          goal: 'Explain how AI helps', body: 'Nossa IA pode ajudar seu negócio.', authorizationBasis: 'standing_goal',
          status: 'delivered', attempts: 1, scheduledFor: null, lastError: null,
          deliveredAt: '2026-08-25T16:31:00.000Z', createdAt: '2026-08-25T16:31:00.000Z',
        }],
      });
      return jsonResponse({});
    }));

    render(<AgentChannelsTab agentId="a1" agentName="Bia" />);
    expect((await screen.findAllByText('atacadaosertaneja')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Boa tarde')).toBeInTheDocument();
    expect(screen.getByText('qualified')).toBeInTheDocument();
    expect(screen.getByText('2 linked identities')).toBeInTheDocument();
    expect(screen.getByText('Nossa IA pode ajudar seu negócio.')).toBeInTheDocument();
    expect(screen.getByText('Standing goal')).toBeInTheDocument();
    expect(screen.getByText('delivered')).toBeInTheDocument();
  });
});
