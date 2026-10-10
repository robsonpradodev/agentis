import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OpenRouterConnectionFields } from '../../src/components/agents/OpenRouterConnectionFields';
import { RuntimePicker, DEFAULT_RUNTIME_CONFIG, configToRuntimeConfig, runtimeConfigToAdapterConfig } from '../../src/components/agents/RuntimePicker';
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
describe('OpenRouter configuration', () => {
  beforeEach(() => { localStorage.setItem('agentis.access', 'a.b.c'); localStorage.setItem('agentis.workspace', 'ws'); });
  afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });
  it('stores a new key in the vault and tests only the credential reference', async () => {
    const requests: Array<{ path: string; body: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined; requests.push({ path, body });
      if (path.endsWith('/v1/credentials')) return json(init?.method === 'POST' ? { id: 'cred-new' } : { credentials: [] });
      return json({ status: 'pass', checks: [{ message: 'No generation billed' }] });
    }));
    function Fields() { const [id, setId] = useState(''); return <OpenRouterConnectionFields credentialId={id} model="test/tools:free" onCredentialChange={setId} />; }
    render(<Fields />);
    await userEvent.type(screen.getByLabelText('API key'), 'secret-key');
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByText('No generation billed');
    expect((screen.getByLabelText('Replace API key (optional)') as HTMLInputElement).value).toBe('');
    expect(requests.find((r) => r.path.endsWith('/harness/test'))?.body).toEqual({ adapterType: 'openrouter', config: { authCredentialId: 'cred-new', model: 'test/tools:free' } });
    expect(requests.filter((r) => r.path.endsWith('/harness/test')).some((r) => JSON.stringify(r.body).includes('secret-key'))).toBe(false);
  });
  it('preserves a saved key when the replacement field is empty', async () => {
    const fetch = vi.fn(async (path: string) => path.endsWith('/credentials') ? json({ credentials: [{ id: 'saved', name: 'Clinic', credentialType: 'openrouter_api_key' }] }) : json({ status: 'pass', checks: [{ message: 'Accepted' }] }));
    vi.stubGlobal('fetch', fetch); const change = vi.fn();
    render(<OpenRouterConnectionFields credentialId="saved" model="test/tools:free" onCredentialChange={change} />);
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' })); await screen.findByText('Accepted');
    expect(change).not.toHaveBeenCalled(); expect(fetch.mock.calls).toHaveLength(2);
  });
  it('round-trips only credential ID, model and timeout and never selects a default', () => {
    const stored = runtimeConfigToAdapterConfig('openrouter', { ...DEFAULT_RUNTIME_CONFIG, openrouterAuthCredentialId: 'id', openrouterModel: 'test/tools:free' });
    expect(stored).toEqual({ authCredentialId: 'id', model: 'test/tools:free', timeoutMs: 75000 });
    expect(configToRuntimeConfig('openrouter', stored)).toMatchObject({ openrouterAuthCredentialId: 'id', openrouterModel: 'test/tools:free' });
    expect(DEFAULT_RUNTIME_CONFIG.openrouterModel).toBe('');
  });
  it('offers the API runtime without local detection and does not replace Hermes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ models: [], supportsManual: false, defaultModel: null, defaultLabel: 'Choose a model' })));
    const change = vi.fn();
    render(<RuntimePicker adapterType="hermes_agent" runtimeConfig={DEFAULT_RUNTIME_CONFIG} onAdapterChange={change} onConfigChange={vi.fn()} detections={[]} editing />);
    await waitFor(() => expect(screen.getByText('OpenRouter')).toBeTruthy());
    expect(change).not.toHaveBeenCalled();
  });
});
