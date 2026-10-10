import { useEffect, useState } from 'react';
import { Check, KeyRound, Loader2 } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';

export function OpenRouterConnectionFields({ credentialId, model, onCredentialChange }: {
  credentialId: string; model: string; onCredentialChange: (id: string) => void;
}) {
  const [key, setKey] = useState('');
  const [credentials, setCredentials] = useState<Array<{ id: string; name: string; credentialType: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api<{ credentials: typeof credentials }>('/v1/credentials').then((data) => {
      if (!cancelled) setCredentials(data.credentials.filter((entry) => entry.credentialType === 'openrouter_api_key'));
    }).catch(() => { if (!cancelled) setResult({ ok: false, text: 'Could not load saved keys.' }); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { setResult(null); }, [model]);
  async function test() {
    setBusy(true); setResult(null);
    try {
      let id = credentialId;
      if (key.trim()) {
        const saved = await api<{ id: string }>('/v1/credentials', { method: 'POST', body: JSON.stringify({ name: 'OpenRouter', credentialType: 'openrouter_api_key', value: key.trim() }) });
        id = saved.id;
        setCredentials((rows) => [...rows, { id, name: 'OpenRouter', credentialType: 'openrouter_api_key' }]);
        setKey(''); onCredentialChange(id);
      }
      const data = await api<{ status: string; checks: Array<{ message: string }> }>('/v1/harness/test', {
        method: 'POST', body: JSON.stringify({ adapterType: 'openrouter', config: { authCredentialId: id, model } }),
      });
      setResult({ ok: data.status === 'pass', text: data.checks.map((check) => check.message).join(' ') });
    } catch (error) { setResult({ ok: false, text: apiErrorMessage(error) }); }
    finally { setBusy(false); }
  }
  const input = 'w-full rounded-input border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent';
  return <div role="group" aria-label="OpenRouter connection" className="space-y-3 rounded-lg border border-line bg-surface-2 p-3">
    <div className="flex items-center gap-2 text-sm font-medium"><KeyRound size={14} /> OpenRouter connection</div>
    {credentials.length > 0 && <label className="block text-xs text-text-secondary">Saved API key
      <select className={`${input} mt-1`} value={credentialId} onChange={(event) => { setKey(''); setResult(null); onCredentialChange(event.target.value); }} disabled={busy}>
        <option value="">Use a new key</option>{credentials.map((credential) => <option key={credential.id} value={credential.id}>{credential.name}</option>)}
      </select>
    </label>}
    <label className="block text-xs text-text-secondary">{credentialId ? 'Replace API key (optional)' : 'API key'}
      <input className={`${input} mt-1`} type="password" autoComplete="new-password" value={key} onChange={(event) => { setKey(event.target.value); setResult(null); }} placeholder={credentialId ? 'Leave blank to keep the saved key' : 'sk-or-…'} disabled={busy} />
    </label>
    <div className="flex items-center justify-between gap-3">
      <p className="text-[11px] text-text-muted">The key is saved securely when you test. No model generation is billed.</p>
      <button type="button" className="inline-flex shrink-0 items-center gap-1.5 rounded-btn border border-line bg-canvas px-3 py-2 text-xs hover:bg-surface-3 disabled:opacity-50" disabled={busy || (!key.trim() && !credentialId) || !model} onClick={() => void test()}>
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Test connection
      </button>
    </div>
    {result && <p role="status" className={`text-xs ${result.ok ? 'text-success' : 'text-danger'}`}>{result.text}</p>}
  </div>;
}
