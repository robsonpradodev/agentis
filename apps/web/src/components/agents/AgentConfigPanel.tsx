/**
 * AgentConfigPanel — Config tab content for AgentDetailPage.
 *
 * Two sections:
 *   1. Runtime — swappable binding (Track R: switch runtime without losing
 *      identity/memory), model picker first, advanced config collapsed
 *   2. Operations — budget, standby, reporting chain
 *
 * Identity (name, role, appearance, tags) is managed on the Identity tab.
 * Instructions (playbook) is managed on the Instructions tab.
 */

import { useEffect, useRef, useState } from 'react';
import { Check, Download, Loader2 } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { startBackgroundInstall, type InstallSession } from '../../lib/backgroundInstall';
import { useAgentInstallSession } from '../../hooks/useBackgroundInstall';
import { RuntimePicker, configToRuntimeConfig, isSupportedAdapterType, runtimeConfigToAdapterConfig, runtimeModelFor } from './RuntimePicker';
import type { AdapterType, HarnessDetectionResult, RuntimeConfig } from './RuntimePicker';
import type { CommandAgent } from './AgentCard';
import { switchAgentRuntime } from '../../lib/agentImport';

interface HarnessTestResult {
  status: 'pass' | 'warn' | 'fail';
  checks: Array<{ level: 'info' | 'warn' | 'error'; message: string; detail?: string }>;
}

interface DetectResponse {
  adapters?: HarnessDetectionResult[];
  harnesses?: HarnessDetectionResult[];
}

interface RuntimeRepairState {
  phase: 'idle' | 'checking' | 'connected' | 'missing' | 'installing' | 'failed';
  message?: string;
}

// ── Component ────────────────────────────────────────────────────────────────

export function AgentConfigPanel({
  agent,
  allAgents,
  onSaved,
}: {
  agent: CommandAgent & { config?: Record<string, unknown> | null; reportsTo?: string | null };
  allAgents: Array<{ id: string; name: string }>;
  onSaved: () => void;
}) {
  const toast = useToast();
  const savedAdapterType: AdapterType = isSupportedAdapterType(agent.adapterType) ? agent.adapterType : 'http';
  const [draftAdapterType, setDraftAdapterType] = useState<AdapterType | null>(null);
  const adapterType = draftAdapterType ?? savedAdapterType;
  const storedConfig = (agent.config ?? {}) as Record<string, unknown>;

  // Runtime section state
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig>(() =>
    configToRuntimeConfig(adapterType, storedConfig),
  );
  const [savingRuntime, setSavingRuntime] = useState(false);
  const [testingRuntime, setTestingRuntime] = useState(false);
  const [testResult, setTestResult] = useState<HarnessTestResult | null>(null);
  const [runtimeRepair, setRuntimeRepair] = useState<RuntimeRepairState>(() =>
    runtimeRepairState(agent.status, adapterType),
  );
  const installSession = useAgentInstallSession(agent.id);
  const autoConnectStartedRef = useRef('');
  const handledInstallPhaseRef = useRef('');

  // Operations section state
  const [budget, setBudget] = useState(agent.monthlyBudgetCents != null ? String(agent.monthlyBudgetCents / 100) : '');
  const [isPaused, setIsPaused] = useState(agent.isPaused ?? false);
  const [reportsTo, setReportsTo] = useState(agent.reportsTo ?? '');
  const [savingOperations, setSavingOperations] = useState(false);

  useEffect(() => {
    setDraftAdapterType(null);
    setRuntimeConfig(configToRuntimeConfig(savedAdapterType, storedConfig));
    setTestResult(null);
    setRuntimeRepair(runtimeRepairState(agent.status, adapterType));
    autoConnectStartedRef.current = '';
    handledInstallPhaseRef.current = '';
  }, [agent.id, agent.status, savedAdapterType]);

  useEffect(() => {
    if (agent.status !== 'setting_up') return;
    if (installSession?.phase === 'installing' || installSession?.phase === 'verifying') return;
    const connectKey = `${agent.id}:${adapterType}`;
    if (autoConnectStartedRef.current === connectKey) return;
    autoConnectStartedRef.current = connectKey;
    void connectRuntime('auto');
  }, [agent.id, agent.status, adapterType, installSession?.phase]);

  useEffect(() => {
    if (!installSession) return;
    const phaseKey = `${installSession.phase}:${installSession.completedAt ?? ''}:${installSession.error ?? ''}`;
    if (handledInstallPhaseRef.current === phaseKey) return;
    handledInstallPhaseRef.current = phaseKey;

    if (installSession.phase === 'complete') {
      if (installSession.result?.binaryPath) {
        setRuntimeConfig((current) => setRuntimeBinaryPath(current, adapterType, installSession.result?.binaryPath ?? ''));
      }
      setRuntimeRepair({ phase: 'connected', message: `${runtimeDisplayName(adapterType)} is connected.` });
      onSaved();
    }
    if (installSession.phase === 'error') {
      setRuntimeRepair({ phase: 'failed', message: installSession.error ?? `${runtimeDisplayName(adapterType)} setup failed.` });
    }
  }, [adapterType, installSession, onSaved]);

  async function persistRuntime(nextRuntimeConfig: RuntimeConfig, status?: 'online' | 'setting_up' | 'error') {
    const config = runtimeConfigToAdapterConfig(adapterType, nextRuntimeConfig);
    if (adapterType !== savedAdapterType) {
      await switchAgentRuntime(agent.id, { adapterType, config, runtimeModel: runtimeModelFor(adapterType, nextRuntimeConfig) });
      return;
    }
    await api(`/v1/agents/${agent.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        config,
        runtimeModel: runtimeModelFor(adapterType, nextRuntimeConfig),
        ...(status ? { status } : {}),
      }),
    });
  }

  // Track R: rebind this agent to a different runtime WITHOUT losing its
  // identity, Brain or abilities. The agent is Agentis-owned; the runtime is a
  // swappable binding.
  async function rebindRuntime(next: AdapterType) {
    if (next === adapterType) return;
    setSavingRuntime(true);
    try {
      await switchAgentRuntime(agent.id, {
        adapterType: next,
        config: runtimeConfigToAdapterConfig(next, runtimeConfig),
        runtimeModel: runtimeModelFor(next, runtimeConfig),
      });
      toast.success('Runtime switched', `${runtimeDisplayName(next)} is now this agent's runtime — identity and memory are unchanged.`);
      onSaved();
    } catch (err) {
      toast.error('Switch failed', apiErrorMessage(err));
    } finally {
      setSavingRuntime(false);
    }
  }

  async function markRuntimeMissing(message: string) {
    setRuntimeRepair({ phase: 'missing', message });
    if (agent.status !== 'setting_up') return;
    try {
      await api(`/v1/agents/${agent.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'error' }),
      });
      onSaved();
    } catch {
    }
  }

  async function saveRuntime() {
    setSavingRuntime(true);
    try {
      await persistRuntime(runtimeConfig);
      toast.success('Runtime saved', 'Adapter config updated.');
      onSaved();
    } catch (err) {
      toast.error('Save failed', apiErrorMessage(err));
    } finally {
      setSavingRuntime(false);
    }
  }

  async function connectRuntime(trigger: 'auto' | 'manual'): Promise<boolean> {
    const runtimeName = runtimeDisplayName(adapterType);
    setRuntimeRepair({ phase: 'checking', message: `Checking this machine for ${runtimeName}...` });
    try {
      const response = await api<DetectResponse>('/v1/harness/detect');
      const detections = response.adapters ?? response.harnesses ?? [];
      const detection = detections.find((entry) => entry.adapterType === adapterType);

      if (detection?.status === 'found') {
        const nextRuntimeConfig = runtimeConfigFromDetection(runtimeConfig, adapterType, detection);
        setRuntimeConfig(nextRuntimeConfig);
        await persistRuntime(nextRuntimeConfig, 'online');
        setRuntimeRepair({ phase: 'connected', message: `${runtimeName} was found and connected automatically.` });
        if (trigger === 'manual') toast.success('Runtime connected', `${runtimeName} is ready for this agent.`);
        onSaved();
        return true;
      }

      if (hasConnectableRuntimeConfig(adapterType, runtimeConfig)) {
        await persistRuntime(runtimeConfig, 'online');
        const result = await api<HarnessTestResult>(`/v1/agents/${agent.id}/test-harness`, { method: 'POST' });
        setTestResult(result);
        if (result.status !== 'fail') {
          setRuntimeRepair({ phase: 'connected', message: `${runtimeName} was reconnected from saved settings.` });
          if (trigger === 'manual') toast.success('Runtime connected', `${runtimeName} is ready for this agent.`);
          onSaved();
          return true;
        }
      }

      const message = missingRuntimeMessage(adapterType, detection);
      await markRuntimeMissing(message);
      if (trigger === 'manual') toast.warn('Runtime not found', message);
      return false;
    } catch (error) {
      setRuntimeRepair({ phase: 'failed', message: apiErrorMessage(error) });
      if (trigger === 'manual') toast.error('Runtime check failed', apiErrorMessage(error));
      return false;
    }
  }

  async function startRuntimeInstall() {
    if (!isAutoInstallableAdapter(adapterType)) return;
    if (installSession?.phase === 'installing' || installSession?.phase === 'verifying') return;

    const runtimeName = runtimeDisplayName(adapterType);
    setRuntimeRepair({ phase: 'installing', message: `${runtimeName} setup is starting...` });
    try {
      await api(`/v1/agents/${agent.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'setting_up' }),
      });
      startBackgroundInstall({
        agentId: agent.id,
        agentName: agent.name,
        adapterType,
        adapterConfig: runtimeConfigToAdapterConfig(adapterType, runtimeConfig),
        runtimeModel: runtimeModelFor(adapterType, runtimeConfig),
      });
      toast.success('Runtime setup started', `${runtimeName} is setting up in the background.`);
      onSaved();
    } catch (error) {
      setRuntimeRepair({ phase: 'failed', message: apiErrorMessage(error) });
      toast.error('Runtime setup failed', apiErrorMessage(error));
    }
  }

  async function testRuntime() {
    setTestingRuntime(true);
    setTestResult(null);
    try {
      const result = adapterType === 'openrouter'
        ? await api<HarnessTestResult>('/v1/harness/test', { method: 'POST', body: JSON.stringify({ adapterType, config: runtimeConfigToAdapterConfig(adapterType, runtimeConfig) }) })
        : await api<HarnessTestResult>(`/v1/agents/${agent.id}/test-harness`, { method: 'POST' });
      setTestResult(result);
      if (result.status === 'pass') toast.success('Connection verified');
      else if (result.status === 'warn') toast.success('Connected with caveats');
      else if (adapterType !== 'openrouter' && await connectRuntime('manual')) return;
      else toast.error('Connection failed', result.checks.find((check) => check.level === 'error')?.message ?? 'Harness check failed.');
    } catch (err) {
      if (adapterType !== 'openrouter' && await connectRuntime('manual')) return;
      toast.error('Test failed', apiErrorMessage(err));
    } finally {
      setTestingRuntime(false);
    }
  }

  async function saveOperations() {
    setSavingOperations(true);
    try {
      const monthlyBudgetCents = budget ? Math.round(parseFloat(budget) * 100) : null;
      await api(`/v1/agents/${agent.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          monthlyBudgetCents,
          isPaused,
          reportsTo: reportsTo || null,
        }),
      });
      toast.success('Operations saved');
      onSaved();
    } catch (err) {
      toast.error('Save failed', err instanceof Error ? err.message : 'Could not save operations.');
    } finally {
      setSavingOperations(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* ── Runtime ─────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-line bg-surface p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Runtime</div>
            <div className="mt-0.5 text-xs text-text-muted">Model first. Connection details stay tucked away until you need them.</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void testRuntime()}
              disabled={testingRuntime || (adapterType === 'openrouter' && !hasConnectableRuntimeConfig(adapterType, runtimeConfig))}
              className="rounded-md border border-line px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-2 hover:text-text-primary disabled:opacity-50"
            >
              {testingRuntime ? 'Testing...' : 'Test connection'}
            </button>
            <button
              onClick={() => void saveRuntime()}
              disabled={savingRuntime || (adapterType === 'openrouter' && !hasConnectableRuntimeConfig(adapterType, runtimeConfig))}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-canvas disabled:opacity-50"
            >
              {savingRuntime ? 'Saving...' : 'Save runtime'}
            </button>
          </div>
        </div>
        {adapterType !== 'openrouter' && <RuntimeConnectPanel
          adapterType={adapterType}
          state={runtimeRepair}
          session={installSession}
          onConnect={() => void connectRuntime('manual')}
          onInstall={isAutoInstallableAdapter(adapterType) ? () => void startRuntimeInstall() : undefined}
        />}
        <RuntimePicker
          agentId={agent.id}
          adapterType={adapterType}
          runtimeConfig={runtimeConfig}
          onAdapterChange={(next) => {
            if (next === 'openrouter') { setDraftAdapterType(next); setTestResult(null); return; }
            setDraftAdapterType(null); void rebindRuntime(next);
          }}
          onConfigChange={setRuntimeConfig}
          editing
        />
        {testResult && (
          <div className="mt-4 rounded-lg border border-line bg-surface-2 p-3 text-xs">
            <div className={testResult.status === 'fail' ? 'text-danger' : testResult.status === 'warn' ? 'text-accent' : 'text-text-primary'}>
              {testResult.status === 'pass' ? 'Connection verified' : testResult.status === 'warn' ? 'Connected with caveats' : 'Connection failed'}
            </div>
            <div className="mt-2 space-y-1 text-text-muted">
              {testResult.checks.map((check, index) => (
                <div key={`${check.message}-${index}`}>
                  <span className={check.level === 'error' ? 'text-danger' : 'text-text-primary'}>{check.message}</span>
                  {check.detail ? <span> - {check.detail}</span> : null}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── Operations ──────────────────────────────────────────────── */}
      <section className="rounded-xl border border-line bg-surface p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Operations</div>
            <div className="mt-0.5 text-xs text-text-muted">Budget, standby state, and hierarchy reporting.</div>
          </div>
          <button
            onClick={() => void saveOperations()}
            disabled={savingOperations}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-canvas disabled:opacity-50"
          >
            {savingOperations ? 'Saving…' : 'Save operations'}
          </button>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Field label="Monthly budget (USD)">
            <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" placeholder="No limit" className={inputCls} />
            <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
              Applies only to <strong>metered</strong> runtimes billed per token (e.g. an API/HTTP model). Subscription CLIs (Claude Code, Codex, Cursor…) aren't metered, so the cap doesn't apply. Leave blank for no limit.
            </p>
          </Field>
          <Field label="Current spend">
            <input value={`$${((agent.currentMonthSpendCents ?? 0) / 100).toFixed(2)}`} readOnly className={`${inputCls} text-text-muted`} />
          </Field>
          <Field label="Reports to">
            <select value={reportsTo} onChange={(e) => setReportsTo(e.target.value)} className={inputCls}>
              <option value="">None</option>
              {allAgents
                .filter((a) => a.id !== agent.id)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Standby mode">
            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                role="switch"
                aria-checked={isPaused}
                onClick={() => setIsPaused((v) => !v)}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${isPaused ? 'bg-accent' : 'bg-line'}`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${isPaused ? 'translate-x-4' : 'translate-x-0'}`}
                />
              </button>
              <span className="text-xs text-text-muted">{isPaused ? 'Agent is on standby' : 'Agent is active'}</span>
            </div>
          </Field>
        </div>
      </section>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1">
        <span className="text-xs font-medium uppercase tracking-wider text-text-muted">{label}</span>
        {hint && <span className="text-[10px] text-text-muted">({hint})</span>}
      </span>
      {children}
    </label>
  );
}

function RuntimeConnectPanel({
  adapterType,
  state,
  session,
  onConnect,
  onInstall,
}: {
  adapterType: AdapterType;
  state: RuntimeRepairState;
  session?: InstallSession;
  onConnect: () => void;
  onInstall?: () => void;
}) {
  const runtimeName = runtimeDisplayName(adapterType);
  const phase = session?.phase;
  const installing = phase === 'installing' || phase === 'verifying' || state.phase === 'checking' || state.phase === 'installing';
  const complete = phase === 'complete' || state.phase === 'connected';
  const failed = phase === 'error' || state.phase === 'failed';
  const missing = state.phase === 'missing';
  const installEligible = state.phase === 'idle' || state.phase === 'missing' || state.phase === 'failed';
  const completedSteps = session?.steps.filter((step) => step.status === 'done').length ?? 0;
  const totalSteps = 4;
  const progress = complete ? 100 : Math.min(100, Math.round((completedSteps / totalSteps) * 100));
  const activeStep = session?.steps.find((step) => step.status === 'running');
  const message = failed
    ? (session?.error ?? state.message ?? `${runtimeName} setup failed.`)
    : complete
      ? (state.message ?? `${runtimeName} is connected.`)
      : activeStep?.label ?? state.message ?? `Agentis can search this machine and connect ${runtimeName} if it is already available.`;

  const canAct = !installing && !complete;

  return (
    <div className="mb-4 rounded-lg border border-line bg-surface-2 px-3 py-3 text-xs">
      <div className="flex items-center gap-2">
        {complete ? <Check size={13} className="text-accent" /> : failed ? <span className="text-danger">!</span> : installing ? <Loader2 size={13} className="animate-spin text-accent" /> : <Download size={13} className="text-text-muted" />}
        <span className={failed ? 'text-danger' : complete ? 'text-accent' : missing ? 'text-text-secondary' : 'text-text-primary'}>{message}</span>
        {canAct && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button type="button" onClick={onConnect} className="rounded-btn border border-line bg-canvas px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-3 hover:text-text-primary">
              Find and connect
            </button>
            {installEligible && onInstall && (
              <button type="button" onClick={onInstall} className="rounded-btn bg-accent px-2 py-1 text-[11px] font-medium text-canvas hover:bg-accent-hover">
                Install
              </button>
            )}
          </div>
        )}
      </div>

      {(installing || complete || failed) && session && (
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-canvas">
              <div className={`h-full rounded-full transition-all duration-500 ${failed ? 'bg-danger' : complete ? 'bg-accent' : 'bg-cyan-500'}`} style={{ width: `${progress}%` }} />
            </div>
            <span className="text-[10px] tabular-nums text-text-muted">{progress}%</span>
          </div>
          {session.logs.length > 0 && (
            <div className="max-h-24 overflow-y-auto rounded-md bg-canvas p-2 font-mono text-[10px] leading-relaxed text-text-muted">
              {session.logs.slice(-20).map((line, index) => <div key={`${line}-${index}`} className="break-all">{line}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function runtimeRepairState(status: CommandAgent['status'], adapterType: AdapterType): RuntimeRepairState {
  if (status === 'online' || status === 'busy') {
    return {
      phase: 'connected',
      message: `${runtimeDisplayName(adapterType)} is connected.`,
    };
  }
  if (status === 'setting_up') {
    return {
      phase: 'checking',
      message: `Checking this machine for ${runtimeDisplayName(adapterType)}...`,
    };
  }
  return { phase: 'idle' };
}

function isAutoInstallableAdapter(adapterType: AdapterType): adapterType is 'claude_code' | 'codex' {
  return adapterType === 'claude_code' || adapterType === 'codex';
}

function runtimeDisplayName(adapterType: AdapterType): string {
  if (adapterType === 'openrouter') return 'OpenRouter';
  if (adapterType === 'codex') return 'Codex';
  if (adapterType === 'claude_code') return 'Claude Code';
  if (adapterType === 'cursor') return 'Cursor';
  if (adapterType === 'antigravity') return 'Antigravity CLI';
  if (adapterType === 'hermes_agent') return 'Hermes Agent';
  if (adapterType === 'openclaw') return 'OpenClaw';
  return 'HTTP';
}

function runtimeConfigFromDetection(config: RuntimeConfig, adapterType: AdapterType, detection: HarnessDetectionResult): RuntimeConfig {
  let next = config;
  if (adapterType === 'openclaw') {
    const gatewayUrl = detectionConfigString(detection, 'gatewayUrl');
    const gatewayId = detectionConfigString(detection, 'gatewayId');
    const model = detectionConfigString(detection, 'model') || detection.detectedModel;
    if (gatewayUrl) next = { ...next, openclawGatewayUrl: gatewayUrl };
    if (gatewayId) next = { ...next, openclawGatewayId: gatewayId };
    if (model) next = { ...next, openclawModel: next.openclawModel || model };
    return next;
  }
  if (adapterType === 'http') {
    const baseUrl = detectionConfigString(detection, 'baseUrl');
    if (baseUrl) next = { ...next, httpBaseUrl: baseUrl };
    return next;
  }
  const command = detectionCommand(detection);
  if (command) next = setRuntimeBinaryPath(next, adapterType, command);
  if (detection.detectedModel) next = setRuntimeModel(next, adapterType, detection.detectedModel);
  return next;
}

function setRuntimeBinaryPath(config: RuntimeConfig, adapterType: AdapterType, binaryPath: string): RuntimeConfig {
  if (adapterType === 'claude_code') return { ...config, claudeBinaryPath: binaryPath };
  if (adapterType === 'codex') return { ...config, codexBinaryPath: binaryPath };
  if (adapterType === 'cursor') return { ...config, cursorBinaryPath: binaryPath };
  if (adapterType === 'antigravity') return { ...config, antigravityBinaryPath: binaryPath };
  if (adapterType === 'hermes_agent') return { ...config, hermesBinaryPath: binaryPath };
  return config;
}

function setRuntimeModel(config: RuntimeConfig, adapterType: AdapterType, model: string): RuntimeConfig {
  if (adapterType === 'openrouter') return { ...config, openrouterModel: config.openrouterModel || model };
  if (adapterType === 'openclaw') return { ...config, openclawModel: config.openclawModel || model };
  if (adapterType === 'claude_code') return { ...config, claudeModel: config.claudeModel || model };
  if (adapterType === 'codex') return { ...config, codexModel: config.codexModel || model };
  if (adapterType === 'cursor') return { ...config, cursorModel: config.cursorModel || model };
  if (adapterType === 'antigravity') return { ...config, antigravityModel: config.antigravityModel || model };
  if (adapterType === 'hermes_agent') return { ...config, hermesModel: config.hermesModel || model };
  if (adapterType === 'http') return { ...config, httpModel: config.httpModel || model };
  return config;
}

function detectionConfigString(detection: HarnessDetectionResult, key: string): string {
  const value = detection.config?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function detectionCommand(detection: HarnessDetectionResult): string {
  return detectionConfigString(detection, 'command')
    || detectionConfigString(detection, 'binaryPath')
    || detection.binaryPath
    || '';
}

function missingRuntimeMessage(adapterType: AdapterType, detection?: HarnessDetectionResult): string {
  if (adapterType === 'openrouter') return 'Save an OpenRouter API key and select a model, then test the connection.';
  if (adapterType === 'openclaw') return detection?.detail ?? 'No OpenClaw gateway was discovered. Connect a gateway URL or configure OPENCLAW_GATEWAY_URL, then run detection again.';
  if (adapterType === 'http') return detection?.detail ?? 'No HTTP endpoint was discovered. Add the HTTP base URL in connection settings, then save and test the runtime.';
  const runtimeName = runtimeDisplayName(adapterType);
  return detection?.detail ?? `${runtimeName} was not found on PATH. Install it or set its binary path, then run detection again.`;
}

function hasConnectableRuntimeConfig(adapterType: AdapterType, config: RuntimeConfig): boolean {
  if (adapterType === 'openrouter') return Boolean(config.openrouterAuthCredentialId && config.openrouterModel);
  if (adapterType === 'openclaw') return Boolean(config.openclawGatewayUrl.trim());
  if (adapterType === 'http') return Boolean(config.httpBaseUrl.trim());
  if (adapterType === 'claude_code') return Boolean(config.claudeBinaryPath.trim());
  if (adapterType === 'codex') return Boolean(config.codexBinaryPath.trim());
  if (adapterType === 'cursor') return Boolean(config.cursorBinaryPath.trim());
  if (adapterType === 'antigravity') return Boolean(config.antigravityBinaryPath.trim());
  if (adapterType === 'hermes_agent') return Boolean(config.hermesBinaryPath.trim());
  return false;
}

const inputCls = 'w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent';



