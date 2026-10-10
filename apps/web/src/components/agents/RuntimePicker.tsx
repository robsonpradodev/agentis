import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { ComponentType } from 'react';
import { AlertTriangle, Check, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { AntigravityIcon, ClaudeIcon, CodexIcon, CursorIcon, HermesIcon, HttpIcon, OpenClawIcon } from '../icons';
import { ModelChooser } from './ModelChooser';
import { OpenRouterConnectionFields } from './OpenRouterConnectionFields';
import { runtimeModelValue, withRuntimeModel } from './runtimeModelField';

export type AdapterType = 'openclaw' | 'hermes_agent' | 'claude_code' | 'codex' | 'cursor' | 'antigravity' | 'openrouter' | 'http';

export interface AdapterModelOption {
  id: string;
  label: string;
  tier?: 'flagship' | 'balanced' | 'fast' | 'auto';
  recommended?: boolean;
}

export interface RuntimeConfig {
  openrouterAuthCredentialId: string;
  openrouterModel: string;
  openrouterTimeoutMs: string;
  runtimeMode: string;
  runtimePermissionProfile: string;
  runtimeProfileName: string;
  runtimeInheritUserConfig: string;
  runtimeInheritProjectInstructions: string;
  runtimeSessionPolicy: string;
  openclawGatewayId: string;
  openclawGatewayUrl: string;
  openclawModel: string;
  openclawDeviceTokenCredentialId: string;
  openclawAgentName: string;
  openclawSessionKeyStrategy: string;
  openclawSessionKey: string;
  openclawTimeoutSec: string;
  openclawPayloadTemplate: string;
  hermesBinaryPath: string;
  hermesCwd: string;
  hermesModel: string;
  hermesChatTransport: string;
  hermesMaxTurns: string;
  hermesExtraArgs: string;
  hermesEnv: string;
  hermesTimeoutSec: string;
  hermesGraceSec: string;
  claudeBinaryPath: string;
  claudeCwd: string;
  claudeModel: string;
  claudeMaxTurns: string;
  claudeAllowedTools: string;
  claudeSkipPermissions: string;
  claudeExtraArgs: string;
  claudeEnv: string;
  claudeTimeoutSec: string;
  codexBinaryPath: string;
  codexCwd: string;
  codexModel: string;
  codexMaxTurns: string;
  codexReasoningEffort: string;
  codexFastMode: string;
  codexBrowser: string;
  codexBypassApprovalsAndSandbox: string;
  codexExtraArgs: string;
  codexEnv: string;
  codexTimeoutSec: string;
  cursorBinaryPath: string;
  cursorCwd: string;
  cursorModel: string;
  cursorExtraArgs: string;
  cursorEnv: string;
  cursorTimeoutSec: string;
  antigravityBinaryPath: string;
  antigravityCwd: string;
  antigravityModel: string;
  antigravityYolo: string;
  antigravityExtraArgs: string;
  antigravityEnv: string;
  antigravityTimeoutSec: string;
  httpBaseUrl: string;
  httpAuthCredentialId: string;
  httpSharedSecretCredentialId: string;
  httpDispatchPath: string;
  httpCancelPath: string;
  httpHealthPath: string;
  httpMethod: string;
  httpHeaders: string;
  httpPayloadTemplate: string;
  httpDispatchTimeoutMs: string;
  httpModel: string;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  openrouterAuthCredentialId: '',
  openrouterModel: '',
  openrouterTimeoutMs: '75000',
  runtimeMode: 'native',
  runtimePermissionProfile: 'trusted_local',
  runtimeProfileName: '',
  runtimeInheritUserConfig: 'true',
  runtimeInheritProjectInstructions: 'true',
  runtimeSessionPolicy: 'persistent',
  openclawGatewayId: '',
  openclawGatewayUrl: '',
  openclawModel: '',
  openclawDeviceTokenCredentialId: '',
  openclawAgentName: '',
  openclawSessionKeyStrategy: 'issue',
  openclawSessionKey: '',
  openclawTimeoutSec: '120',
  openclawPayloadTemplate: '',
  hermesBinaryPath: '',
  hermesCwd: '',
  hermesModel: '',
  hermesChatTransport: 'auto',
  hermesMaxTurns: '24',
  hermesExtraArgs: '',
  hermesEnv: '',
  hermesTimeoutSec: '',
  hermesGraceSec: '',
  claudeBinaryPath: '',
  claudeCwd: '',
  claudeModel: '',
  claudeMaxTurns: '24',
  claudeAllowedTools: '',
  claudeSkipPermissions: 'false',
  claudeExtraArgs: '',
  claudeEnv: '',
  claudeTimeoutSec: '',
  codexBinaryPath: '',
  codexCwd: '',
  codexModel: '',
  codexMaxTurns: '24',
  codexReasoningEffort: '',
  codexFastMode: 'false',
  codexBrowser: 'false',
  codexBypassApprovalsAndSandbox: 'true',
  codexExtraArgs: '',
  codexEnv: '',
  codexTimeoutSec: '',
  cursorBinaryPath: '',
  cursorCwd: '',
  cursorModel: '',
  cursorExtraArgs: '',
  cursorEnv: '',
  cursorTimeoutSec: '',
  antigravityBinaryPath: '',
  antigravityCwd: '',
  antigravityModel: '',
  antigravityYolo: 'true',
  antigravityExtraArgs: '',
  antigravityEnv: '',
  antigravityTimeoutSec: '',
  httpBaseUrl: '',
  httpAuthCredentialId: '',
  httpSharedSecretCredentialId: '',
  httpDispatchPath: '/task',
  httpCancelPath: '',
  httpHealthPath: '/health',
  httpMethod: 'POST',
  httpHeaders: '',
  httpPayloadTemplate: '',
  httpDispatchTimeoutMs: '30000',
  httpModel: '',
};

export interface HarnessDetectionResult {
  adapterType: AdapterType;
  harness: string;
  status: 'found' | 'not_found' | 'error';
  detail?: string;
  binaryPath?: string;
  detectedModel?: string;
  detectedVersion?: string;
  authStatus?: 'authenticated' | 'unknown';
  authDetail?: string;
  config?: Record<string, unknown>;
  installCommand?: string;
  /** Installed but missing required config — never auto-select these. */
  needsConfig?: boolean;
}

const ADAPTERS: Array<{
  id: AdapterType;
  title: string;
  icon: ComponentType<{ className?: string }>;
  recommended?: boolean;
}> = [
  { id: 'openclaw', title: 'OpenClaw', icon: OpenClawIcon },
  { id: 'hermes_agent', title: 'Hermes', icon: HermesIcon },
  { id: 'claude_code', title: 'Claude', icon: ClaudeIcon, recommended: true },
  { id: 'codex', title: 'Codex', icon: CodexIcon, recommended: true },
  { id: 'cursor', title: 'Cursor', icon: CursorIcon },
  { id: 'antigravity', title: 'Antigravity', icon: AntigravityIcon, recommended: true },
  { id: 'http', title: 'HTTP', icon: HttpIcon },
  { id: 'openrouter', title: 'OpenRouter', icon: HttpIcon },
];

export function RuntimePicker({
  agentId,
  adapterType,
  runtimeConfig,
  onAdapterChange,
  onConfigChange,
  editing = false,
  detections: controlledDetections,
  detecting: controlledDetecting,
  onRefreshDetections,
}: {
  agentId?: string | null;
  adapterType: AdapterType;
  runtimeConfig: RuntimeConfig;
  onAdapterChange: (value: AdapterType) => void;
  onConfigChange: (value: RuntimeConfig) => void;
  editing?: boolean;
  detections?: HarnessDetectionResult[];
  detecting?: boolean;
  onRefreshDetections?: () => Promise<void> | void;
}) {
  const [internalDetections, setInternalDetections] = useState<HarnessDetectionResult[]>([]);
  const [internalDetecting, setInternalDetecting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const userPickedRef = useRef(false);

  const detections = controlledDetections ?? internalDetections;
  const detecting = controlledDetecting ?? internalDetecting;

  async function refreshDetections() {
    if (controlledDetections !== undefined) {
      await onRefreshDetections?.();
      return;
    }
    setInternalDetecting(true);
    try {
      const result = await api<{ adapters?: HarnessDetectionResult[]; harnesses?: HarnessDetectionResult[] }>('/v1/harness/detect');
      setInternalDetections(result.adapters ?? result.harnesses ?? []);
    } catch {
      setInternalDetections([]);
    } finally {
      setInternalDetecting(false);
    }
  }

  useEffect(() => {
    // Detection is read-only and provides the availability indicators in the
    // Runtime tab. Editing never auto-selects or rewrites a runtime (guarded
    // below), but it must still refresh these indicators.
    if (controlledDetections !== undefined) return;
    void refreshDetections();
  }, [controlledDetections, editing]);

  const detectionByType = useMemo(
    () => new Map(detections.map((detection) => [detection.adapterType, detection])),
    [detections],
  );
  const foundDetections = useMemo(
    () => detections.filter((detection) => detection.status === 'found'),
    [detections],
  );
  const activeAdapter = ADAPTERS.find((adapter) => adapter.id === adapterType) ?? ADAPTERS[0]!;
  const activeDetection = detectionByType.get(adapterType);

  useEffect(() => {
    if (editing || userPickedRef.current || adapterType === 'openrouter') return;
    if (foundDetections.length !== 1) return;
    const detection = foundDetections[0]!;
    if (adapterType !== detection.adapterType) onAdapterChange(detection.adapterType);
    const next = prefillConfigFromDetection(runtimeConfig, detection.adapterType, detection);
    if (next !== runtimeConfig) onConfigChange(next);
  }, [adapterType, editing, foundDetections, onAdapterChange, onConfigChange, runtimeConfig]);

  function chooseAdapter(value: AdapterType) {
    userPickedRef.current = true;
    onAdapterChange(value);
    const detection = detectionByType.get(value);
    if (!detection) return;
    const next = prefillConfigFromDetection(runtimeConfig, value, detection);
    if (next !== runtimeConfig) onConfigChange(next);
  }

  const setConfig = (key: keyof RuntimeConfig, value: string) => {
    onConfigChange({ ...runtimeConfig, [key]: value });
  };

  return (
    <div className="space-y-4">
      {editing ? (
        <div className="space-y-3">
          {/* Track R: the runtime is a swappable binding. Picking a different
              harness rebinds this agent in place — identity, memory and abilities
              are unchanged. The agent is Agentis-owned, not the runtime's. */}
          <div className="flex items-start gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2.5">
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-canvas text-text-primary">
              <activeAdapter.icon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-text-primary">Selected runtime: {activeAdapter.title}</div>
              <div className="text-xs text-text-muted">Switch runtime below — keeps this agent's identity, memory and abilities. Only the execution backend changes.</div>
            </div>
          </div>
          <HarnessGrid
            adapters={ADAPTERS}
            adapterType={adapterType}
            detectionByType={detectionByType}
            detecting={detecting}
            onAdapterChange={chooseAdapter}
          />
          <HarnessModelPassthrough
            agentId={agentId}
            adapterType={adapterType}
            config={runtimeConfig}
            onConfigChange={onConfigChange}
          />
        </div>
      ) : (
        <div className="space-y-4">
          {detecting && detections.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs text-text-muted">
              <Loader2 size={12} className="animate-spin" />
              Detecting runtimes on this machine...
            </div>
          ) : null}
          <HarnessGrid
            adapters={ADAPTERS}
            adapterType={adapterType}
            detectionByType={detectionByType}
            detecting={detecting}
            onAdapterChange={chooseAdapter}
          />

          {/* Missing Harness Warning Banner */}
          {!editing && adapterType !== 'openrouter' && activeDetection?.status !== 'found' && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs text-text-secondary flex items-start gap-2">
              <span className="mt-0.5 shrink-0 text-amber-500">??</span>
              <span>
                <strong>{activeAdapter.title} harness is not detected on your system.</strong> Make sure it is installed locally to execute tasks using this runtime.
              </span>
            </div>
          )}

          {/* Nous Hermes Agent Informational Banner */}
          {adapterType === 'hermes_agent' && (
            <div className="rounded-lg border border-line bg-surface-2 p-3 text-xs text-text-secondary flex items-start gap-3">
              <span className="shrink-0 inline-flex h-8 w-8 items-center justify-center rounded bg-canvas overflow-hidden">
                <activeAdapter.icon className="h-full w-full object-cover" />
              </span>
              <div className="min-w-0 flex-1">
                <div>
                  <strong>Hermes Agent</strong> is an open-source agent framework developed by Nous Research.
                </div>
                <div className="mt-1">
                  <a
                    href="https://github.com/nousresearch/hermes-agent"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-accent hover:underline"
                  >
                    View on GitHub <ExternalLink size={10} />
                  </a>
                </div>
              </div>
            </div>
          )}

          {!editing && (
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => void refreshDetections()}
                className="inline-flex h-8 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-3 text-[11px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
              >
                <RefreshCw size={12} /> Refresh detection
              </button>
            </div>
          )}

          {/* Model Chooser first */}
          <HarnessModelPassthrough
            agentId={agentId}
            adapterType={adapterType}
            config={runtimeConfig}
            onConfigChange={onConfigChange}
          />

          {/* Connection settings accordion last */}
          {adapterType !== 'openrouter' && <ConnectionDetailsAccordion
            adapterType={adapterType}
            config={runtimeConfig}
            setConfig={setConfig}
            defaultOpen={activeDetection?.status !== 'found' && adapterType !== 'claude_code' && adapterType !== 'codex' && adapterType !== 'antigravity'}
          />}
        </div>
      )}
      {adapterType === 'openrouter' && <OpenRouterConnectionFields credentialId={runtimeConfig.openrouterAuthCredentialId} model={runtimeConfig.openrouterModel} onCredentialChange={(id) => setConfig('openrouterAuthCredentialId', id)} />}
      {editing && adapterType !== 'openrouter' && (
        <div className="rounded-lg border border-line bg-surface-2">
          <button
            type="button"
            onClick={() => setShowAdvanced((value) => !value)}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-text-secondary hover:text-text-primary"
          >
            <span>Advanced connection settings</span>
            <span>{showAdvanced ? 'Hide' : 'Show'}</span>
          </button>
          {showAdvanced && <div className="border-t border-line p-3"><AdapterConfigFields adapterType={adapterType} config={runtimeConfig} setConfig={setConfig} /></div>}
        </div>
      )}
    </div>
  );
}

function detectionCommand(detection: HarnessDetectionResult): string {
  return stringOf(detection.config?.command)
    || stringOf(detection.config?.binaryPath)
    || detection.binaryPath
    || '';
}

function runtimeDetectionDetail(detection: HarnessDetectionResult): string {
  const command = detectionCommand(detection);
  return [
    detection.detectedVersion ? `v${detection.detectedVersion}` : 'Installed',
    command || detection.detail,
  ].filter(Boolean).join(' - ');
}

function HarnessModelPassthrough({
  agentId,
  adapterType,
  config,
  onConfigChange,
}: {
  agentId?: string | null;
  adapterType: AdapterType;
  config: RuntimeConfig;
  onConfigChange: (value: RuntimeConfig) => void;
}) {
  const value = runtimeModelValue(config, adapterType);

  return (
    <ModelChooser
      adapterType={adapterType}
      agentId={agentId}
      value={value}
      onChange={(next) => onConfigChange(withRuntimeModel(config, adapterType, next))}
    />
  );
}

function ConnectionDetailsAccordion({
  adapterType,
  config,
  setConfig,
  defaultOpen,
}: {
  adapterType: AdapterType;
  config: RuntimeConfig;
  setConfig: (key: keyof RuntimeConfig, value: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);

  useEffect(() => {
    setOpen(defaultOpen ?? false);
  }, [adapterType, defaultOpen]);

  if (adapterType === 'openclaw' || adapterType === 'cursor') return null;

  return (
    <div className="rounded-lg border border-line bg-surface-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-text-secondary hover:text-text-primary"
      >
        <span>Connection settings</span>
        <span className="text-text-muted">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="border-t border-line p-3">
          {adapterType === 'http' ? (
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Base URL"><input value={config.httpBaseUrl} onChange={(event) => setConfig('httpBaseUrl', event.target.value)} placeholder="https://agent.example.com" className={inputCls} /></Field>
              <Field label="Dispatch Path"><input value={config.httpDispatchPath} onChange={(event) => setConfig('httpDispatchPath', event.target.value)} placeholder="/task" className={inputCls} /></Field>
              <Field label="Health Path"><input value={config.httpHealthPath} onChange={(event) => setConfig('httpHealthPath', event.target.value)} placeholder="/health" className={inputCls} /></Field>
              <Field label="Model"><input value={config.httpModel} onChange={(event) => setConfig('httpModel', event.target.value)} placeholder="provider-default" className={inputCls} /></Field>
            </div>
          ) : adapterType === 'hermes_agent' ? (
            <div className="grid gap-3 md:grid-cols-4">
              <Field label="Binary path"><input value={config.hermesBinaryPath} onChange={(event) => setConfig('hermesBinaryPath', event.target.value)} placeholder="hermes" className={inputCls} /></Field>
              <Field label="Working directory"><input value={config.hermesCwd} onChange={(event) => setConfig('hermesCwd', event.target.value)} placeholder="Repository path" className={inputCls} /></Field>
              <Field label="Transport" hint={hermesTransportHint(config.hermesChatTransport)}><select value={config.hermesChatTransport} onChange={(event) => setConfig('hermesChatTransport', event.target.value)} className={inputCls}><option value="auto">Auto (recommended)</option><option value="acp">ACP (streaming)</option><option value="cli">CLI (final answer only)</option></select></Field>
              <Field label="Timeout (s)"><input value={config.hermesTimeoutSec} onChange={(event) => setConfig('hermesTimeoutSec', event.target.value)} inputMode="numeric" placeholder="120" className={inputCls} /></Field>
            </div>
          ) : adapterType === 'claude_code' ? (
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Binary path"><input value={config.claudeBinaryPath} onChange={(event) => setConfig('claudeBinaryPath', event.target.value)} placeholder="claude" className={inputCls} /></Field>
              <Field label="Working directory"><input value={config.claudeCwd} onChange={(event) => setConfig('claudeCwd', event.target.value)} placeholder="Repository path" className={inputCls} /></Field>
              <Field label="Timeout (s)"><input value={config.claudeTimeoutSec} onChange={(event) => setConfig('claudeTimeoutSec', event.target.value)} inputMode="numeric" placeholder="120" className={inputCls} /></Field>
            </div>
          ) : adapterType === 'codex' ? (
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Binary path"><input value={config.codexBinaryPath} onChange={(event) => setConfig('codexBinaryPath', event.target.value)} placeholder="codex" className={inputCls} /></Field>
              <Field label="Working directory"><input value={config.codexCwd} onChange={(event) => setConfig('codexCwd', event.target.value)} placeholder="Repository path" className={inputCls} /></Field>
              <Field label="Timeout (s)"><input value={config.codexTimeoutSec} onChange={(event) => setConfig('codexTimeoutSec', event.target.value)} inputMode="numeric" placeholder="120" className={inputCls} /></Field>
            </div>
          ) : adapterType === 'antigravity' ? (
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Binary path"><input value={config.antigravityBinaryPath} onChange={(event) => setConfig('antigravityBinaryPath', event.target.value)} placeholder="agy" className={inputCls} /></Field>
              <Field label="Working directory"><input value={config.antigravityCwd} onChange={(event) => setConfig('antigravityCwd', event.target.value)} placeholder="Repository path" className={inputCls} /></Field>
              <Field label="Timeout (s)"><input value={config.antigravityTimeoutSec} onChange={(event) => setConfig('antigravityTimeoutSec', event.target.value)} inputMode="numeric" placeholder="120" className={inputCls} /></Field>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function HarnessGrid({
  adapters,
  adapterType,
  detectionByType,
  detecting,
  onAdapterChange,
}: {
  adapters: typeof ADAPTERS;
  adapterType: AdapterType;
  detectionByType: Map<AdapterType, HarnessDetectionResult>;
  detecting: boolean;
  onAdapterChange: (value: AdapterType) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2 xl:grid-cols-6">
      {adapters.map((adapter) => {
        const Icon = adapter.icon;
        const selected = adapterType === adapter.id;
        const detection = detectionByType.get(adapter.id);
        const isOnline = detection?.status === 'found';
        const isChecking = adapter.id !== 'openrouter' && detecting && !detection;

        const statusText = adapter.id === 'openrouter' ? 'Connect with an API key and choose a model.' : isOnline
          ? `${adapter.title} harness is detected and ready to use.`
          : `${adapter.title} harness is not detected on this machine.`;

        return (
          <button
            key={adapter.id}
            type="button"
            onClick={() => onAdapterChange(adapter.id)}
            title={statusText}
            className={clsx(
              'relative flex min-w-0 flex-col items-center justify-center gap-2 rounded-lg border p-3 h-20 text-center transition',
              selected ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-surface-2 text-text-primary hover:border-accent/40 hover:bg-surface-3',
            )}
          >
            <div className="relative">
              {isChecking ? (
                <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
              ) : (
                <Icon className="h-6 w-6" />
              )}
              {!isChecking && (
                <span
                  role="status"
                  aria-label={adapter.id === 'openrouter' ? 'Remote API' : isOnline ? 'Online' : 'Offline'}
                  title={statusText}
                  className={clsx(
                    'absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border border-canvas',
                    isOnline ? 'bg-success' : 'bg-text-muted'
                  )}
                />
              )}
            </div>

            <span className="max-w-full truncate text-[12px] font-semibold">{adapter.title}</span>
          </button>
        );
      })}
    </div>
  );
}

function prefillConfigFromDetection(config: RuntimeConfig, adapterType: AdapterType, detection: HarnessDetectionResult): RuntimeConfig {
  if (adapterType === 'openclaw') {
    const gatewayUrl = stringOf(detection.config?.gatewayUrl);
    const gatewayId = stringOf(detection.config?.gatewayId);
    const model = stringOf(detection.config?.model ?? detection.detectedModel);
    if (!gatewayUrl && !gatewayId && !model) return config;
    return {
      ...config,
      openclawGatewayUrl: config.openclawGatewayUrl || gatewayUrl,
      openclawGatewayId: config.openclawGatewayId || gatewayId,
      openclawModel: config.openclawModel || model,
    };
  }
  if (adapterType === 'claude_code') {
    const command = detectionCommand(detection);
    if (!command && !detection.detectedModel) return config;
    return {
      ...config,
      claudeBinaryPath: config.claudeBinaryPath || command,
      claudeModel: config.claudeModel || detection.detectedModel || '',
    };
  }
  if (adapterType === 'codex') {
    const command = detectionCommand(detection);
    if (!command && !detection.detectedModel) return config;
    return {
      ...config,
      codexBinaryPath: config.codexBinaryPath || command,
      codexModel: config.codexModel || detection.detectedModel || '',
    };
  }
  if (adapterType === 'cursor') {
    const command = detectionCommand(detection);
    if (!command && !detection.detectedModel) return config;
    return {
      ...config,
      cursorBinaryPath: config.cursorBinaryPath || command,
      cursorModel: config.cursorModel || detection.detectedModel || '',
    };
  }
  if (adapterType === 'antigravity') {
    const command = detectionCommand(detection);
    if (!command && !detection.detectedModel) return config;
    return {
      ...config,
      antigravityBinaryPath: config.antigravityBinaryPath || command,
      antigravityModel: config.antigravityModel || detection.detectedModel || '',
    };
  }
  if (adapterType === 'hermes_agent') {
    const command = detectionCommand(detection);
    if (!command && !detection.detectedModel) return config;
    return {
      ...config,
      hermesBinaryPath: config.hermesBinaryPath || command,
      hermesModel: config.hermesModel || detection.detectedModel || '',
    };
  }
  if (adapterType === 'http') {
    const baseUrl = stringOf(detection.config?.baseUrl);
    const dispatchPath = stringOf(detection.config?.dispatchPath);
    if (!baseUrl && !dispatchPath) return config;
    return {
      ...config,
      httpBaseUrl: config.httpBaseUrl || baseUrl,
      httpDispatchPath: config.httpDispatchPath || dispatchPath,
    };
  }
  return config;
}

function AdapterConfigFields({
  adapterType,
  config,
  setConfig,
}: {
  adapterType: AdapterType;
  config: RuntimeConfig;
  setConfig: (key: keyof RuntimeConfig, value: string) => void;
}) {
  if (adapterType === 'openclaw') {
    return (
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Gateway">
          {/* Pick a gateway paired in Settings → Connections. Selecting one fills
              the id so registration resolves its URL — no UUID to type. */}
          <GatewaySelect value={config.openclawGatewayId} onChange={(id) => setConfig('openclawGatewayId', id)} />
        </Field>
        <Field label="Gateway URL (or override)"><input value={config.openclawGatewayUrl} onChange={(event) => setConfig('openclawGatewayUrl', event.target.value)} placeholder="wss://gateway.example.com" className={inputCls} /></Field>
        <Field label="Device token credential ID"><input value={config.openclawDeviceTokenCredentialId} onChange={(event) => setConfig('openclawDeviceTokenCredentialId', event.target.value)} placeholder="Credential vault ID" className={inputCls} /></Field>
        <Field label="Agent Name"><input value={config.openclawAgentName} onChange={(event) => setConfig('openclawAgentName', event.target.value)} placeholder="Agent Name" className={inputCls} /></Field>
        <Field label="Session key strategy"><select value={config.openclawSessionKeyStrategy} onChange={(event) => setConfig('openclawSessionKeyStrategy', event.target.value)} className={inputCls}><option value="issue">Issue</option><option value="fixed">Fixed</option><option value="run">Run</option></select></Field>
        <Field label="Session key"><input value={config.openclawSessionKey} onChange={(event) => setConfig('openclawSessionKey', event.target.value)} placeholder="Fixed session key" className={inputCls} /></Field>
        <Field label="Timeout"><input value={config.openclawTimeoutSec} onChange={(event) => setConfig('openclawTimeoutSec', event.target.value)} inputMode="numeric" className={inputCls} /></Field>
        <Field label="Payload template"><textarea value={config.openclawPayloadTemplate} onChange={(event) => setConfig('openclawPayloadTemplate', event.target.value)} placeholder="{}" className={textareaCls} /></Field>
      </div>
    );
  }
  if (adapterType === 'hermes_agent') {
    return (
      <div className="grid gap-3 md:grid-cols-5">
        <Field label="Binary path"><input value={config.hermesBinaryPath} onChange={(event) => setConfig('hermesBinaryPath', event.target.value)} placeholder="hermes" className={inputCls} /></Field>
        <Field label="Working directory"><input value={config.hermesCwd} onChange={(event) => setConfig('hermesCwd', event.target.value)} placeholder="Repository path" className={inputCls} /></Field>
        <Field label="Transport" hint={hermesTransportHint(config.hermesChatTransport)}><select value={config.hermesChatTransport} onChange={(event) => setConfig('hermesChatTransport', event.target.value)} className={inputCls}><option value="auto">Auto (recommended)</option><option value="acp">ACP (streaming)</option><option value="cli">CLI (final answer only)</option></select></Field>
        <Field label="Max turns"><input value={config.hermesMaxTurns} onChange={(event) => setConfig('hermesMaxTurns', event.target.value)} inputMode="numeric" className={inputCls} /></Field>
        <Field label="Extra args"><input value={config.hermesExtraArgs} onChange={(event) => setConfig('hermesExtraArgs', event.target.value)} placeholder="--flag value" className={inputCls} /></Field>
        <Field label="Env"><textarea value={config.hermesEnv} onChange={(event) => setConfig('hermesEnv', event.target.value)} placeholder="{}" className={textareaCls} /></Field>
        <Field label="Timeout"><input value={config.hermesTimeoutSec} onChange={(event) => setConfig('hermesTimeoutSec', event.target.value)} inputMode="numeric" className={inputCls} /></Field>
        <Field label="Grace"><input value={config.hermesGraceSec} onChange={(event) => setConfig('hermesGraceSec', event.target.value)} inputMode="numeric" className={inputCls} /></Field>
      </div>
    );
  }
  if (adapterType === 'claude_code') {
    return (
      <><RuntimeProfileFields config={config} setConfig={setConfig} /><div className="grid gap-3 md:grid-cols-5">
        <Field label="Binary path"><input value={config.claudeBinaryPath} onChange={(event) => setConfig('claudeBinaryPath', event.target.value)} placeholder="claude" className={inputCls} /></Field>
        <Field label="Working directory"><input value={config.claudeCwd} onChange={(event) => setConfig('claudeCwd', event.target.value)} placeholder="Repository path" className={inputCls} /></Field>
        <Field label="Max turns"><input value={config.claudeMaxTurns} onChange={(event) => setConfig('claudeMaxTurns', event.target.value)} inputMode="numeric" className={inputCls} /></Field>
        <Field label="Allowed tools"><input value={config.claudeAllowedTools} onChange={(event) => setConfig('claudeAllowedTools', event.target.value)} placeholder="FileRead, FileWrite" className={inputCls} /></Field>
        <Field label="Skip permissions"><select value={config.claudeSkipPermissions} onChange={(event) => setConfig('claudeSkipPermissions', event.target.value)} className={inputCls}><option value="false">Off</option><option value="true">On</option></select></Field>
        <Field label="Extra args"><input value={config.claudeExtraArgs} onChange={(event) => setConfig('claudeExtraArgs', event.target.value)} placeholder="--flag value" className={inputCls} /></Field>
        <Field label="Env"><textarea value={config.claudeEnv} onChange={(event) => setConfig('claudeEnv', event.target.value)} placeholder="{}" className={textareaCls} /></Field>
        <Field label="Timeout"><input value={config.claudeTimeoutSec} onChange={(event) => setConfig('claudeTimeoutSec', event.target.value)} inputMode="numeric" className={inputCls} /></Field>
      </div></>
    );
  }
  if (adapterType === 'codex') {
    return (
      <><RuntimeProfileFields config={config} setConfig={setConfig} /><div className="grid gap-3 md:grid-cols-4">
        <Field label="Binary path"><input value={config.codexBinaryPath} onChange={(event) => setConfig('codexBinaryPath', event.target.value)} placeholder="codex" className={inputCls} /></Field>
        <Field label="Working directory"><input value={config.codexCwd} onChange={(event) => setConfig('codexCwd', event.target.value)} placeholder="Repository path" className={inputCls} /></Field>
        <Field label="Max turns"><input value={config.codexMaxTurns} onChange={(event) => setConfig('codexMaxTurns', event.target.value)} inputMode="numeric" className={inputCls} /></Field>
        <Field label="Reasoning effort"><select value={config.codexReasoningEffort} onChange={(event) => setConfig('codexReasoningEffort', event.target.value)} className={inputCls}><option value="">Default</option><option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Xhigh</option><option value="max">Max</option><option value="ultra">Ultra</option></select></Field>
        <Field label="Fast mode"><select value={config.codexFastMode} onChange={(event) => setConfig('codexFastMode', event.target.value)} className={inputCls}><option value="false">Off</option><option value="true">On</option></select></Field>
        <Field label="Native browser" hint="Loads the runtime's browser/computer-use config. Heavier cold start; real web browsing.">
          <select value={config.codexBrowser} onChange={(event) => setConfig('codexBrowser', event.target.value)} className={inputCls}><option value="false">Off</option><option value="true">On</option></select>
        </Field>
        <Field label="Extra args"><input value={config.codexExtraArgs} onChange={(event) => setConfig('codexExtraArgs', event.target.value)} placeholder="--flag value" className={inputCls} /></Field>
        <Field label="Env"><textarea value={config.codexEnv} onChange={(event) => setConfig('codexEnv', event.target.value)} placeholder="{}" className={textareaCls} /></Field>
        <Field label="Timeout"><input value={config.codexTimeoutSec} onChange={(event) => setConfig('codexTimeoutSec', event.target.value)} inputMode="numeric" className={inputCls} /></Field>
      </div></>
    );
  }
  if (adapterType === 'cursor') {
    return (
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Binary path"><input value={config.cursorBinaryPath} onChange={(event) => setConfig('cursorBinaryPath', event.target.value)} placeholder="agent" className={inputCls} /></Field>
        <Field label="Working directory"><input value={config.cursorCwd} onChange={(event) => setConfig('cursorCwd', event.target.value)} placeholder="Repository path" className={inputCls} /></Field>
        <Field label="Extra args"><input value={config.cursorExtraArgs} onChange={(event) => setConfig('cursorExtraArgs', event.target.value)} placeholder="--flag value" className={inputCls} /></Field>
        <Field label="Env"><textarea value={config.cursorEnv} onChange={(event) => setConfig('cursorEnv', event.target.value)} placeholder="{}" className={textareaCls} /></Field>
        <Field label="Timeout"><input value={config.cursorTimeoutSec} onChange={(event) => setConfig('cursorTimeoutSec', event.target.value)} inputMode="numeric" className={inputCls} /></Field>
      </div>
    );
  }
  if (adapterType === 'antigravity') {
    return (
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Binary path" hint="Antigravity CLI (`agy`). Install from antigravity.google, then run `agy` once to sign in.">
          <input value={config.antigravityBinaryPath} onChange={(event) => setConfig('antigravityBinaryPath', event.target.value)} placeholder="agy" className={inputCls} />
        </Field>
        <Field label="Working directory"><input value={config.antigravityCwd} onChange={(event) => setConfig('antigravityCwd', event.target.value)} placeholder="Repository path" className={inputCls} /></Field>
        <Field label="Auto-approve tools" hint="Runs the CLI in YOLO mode so it never blocks on an approval prompt. Recommended for headless use.">
          <select value={config.antigravityYolo} onChange={(event) => setConfig('antigravityYolo', event.target.value)} className={inputCls}><option value="true">On</option><option value="false">Off</option></select>
        </Field>
        <Field label="Extra args"><input value={config.antigravityExtraArgs} onChange={(event) => setConfig('antigravityExtraArgs', event.target.value)} placeholder="--flag value" className={inputCls} /></Field>
        <Field label="Env"><textarea value={config.antigravityEnv} onChange={(event) => setConfig('antigravityEnv', event.target.value)} placeholder="{}" className={textareaCls} /></Field>
        <Field label="Timeout"><input value={config.antigravityTimeoutSec} onChange={(event) => setConfig('antigravityTimeoutSec', event.target.value)} inputMode="numeric" className={inputCls} /></Field>
      </div>
    );
  }
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <Field label="Base URL"><input value={config.httpBaseUrl} onChange={(event) => setConfig('httpBaseUrl', event.target.value)} placeholder="https://agent.example.com" className={inputCls} /></Field>
      <Field label="Dispatch Path"><input value={config.httpDispatchPath} onChange={(event) => setConfig('httpDispatchPath', event.target.value)} placeholder="/task" className={inputCls} /></Field>
      <Field label="Cancel Path"><input value={config.httpCancelPath} onChange={(event) => setConfig('httpCancelPath', event.target.value)} placeholder="/cancel" className={inputCls} /></Field>
      <Field label="Health Path"><input value={config.httpHealthPath} onChange={(event) => setConfig('httpHealthPath', event.target.value)} placeholder="/health" className={inputCls} /></Field>
      <Field label="Method"><select value={config.httpMethod} onChange={(event) => setConfig('httpMethod', event.target.value)} className={inputCls}><option value="POST">POST</option><option value="GET">GET</option><option value="PUT">PUT</option><option value="PATCH">PATCH</option></select></Field>
      <Field label="Auth credential ID"><input value={config.httpAuthCredentialId} onChange={(event) => setConfig('httpAuthCredentialId', event.target.value)} placeholder="Credential vault ID" className={inputCls} /></Field>
      <Field label="Shared secret credential ID"><input value={config.httpSharedSecretCredentialId} onChange={(event) => setConfig('httpSharedSecretCredentialId', event.target.value)} placeholder="Credential vault ID" className={inputCls} /></Field>
      <Field label="Dispatch Timeout"><input value={config.httpDispatchTimeoutMs} onChange={(event) => setConfig('httpDispatchTimeoutMs', event.target.value)} inputMode="numeric" className={inputCls} /></Field>
      <Field label="Headers"><textarea value={config.httpHeaders} onChange={(event) => setConfig('httpHeaders', event.target.value)} placeholder="{}" className={textareaCls} /></Field>
      <Field label="Payload template"><textarea value={config.httpPayloadTemplate} onChange={(event) => setConfig('httpPayloadTemplate', event.target.value)} placeholder="{}" className={textareaCls} /></Field>
    </div>
  );
}

function RuntimeProfileFields({ config, setConfig }: { config: RuntimeConfig; setConfig: (key: keyof RuntimeConfig, value: string) => void }) {
  return (
    <div className="mb-3 grid gap-3 rounded-lg border border-accent/20 bg-accent/5 p-3 md:grid-cols-3">
      <Field label="Execution profile" hint="Native preserves your CLI profile; hermetic deliberately isolates it."><select value={config.runtimeMode} onChange={(event) => setConfig('runtimeMode', event.target.value)} className={inputCls}><option value="native">Native parity</option><option value="hermetic">Hermetic</option><option value="containerized">Externally containerized</option></select></Field>
      <Field label="Permission envelope"><select value={config.runtimePermissionProfile} onChange={(event) => setConfig('runtimePermissionProfile', event.target.value)} className={inputCls}><option value="trusted_local">Trusted local</option><option value="workspace_write">Workspace write</option><option value="read_only">Read only</option><option value="externally_sandboxed">Externally sandboxed</option></select></Field>
      <Field label="Native profile name"><input value={config.runtimeProfileName} onChange={(event) => setConfig('runtimeProfileName', event.target.value)} placeholder="default" className={inputCls} /></Field>
      <Field label="User config"><select value={config.runtimeInheritUserConfig} onChange={(event) => setConfig('runtimeInheritUserConfig', event.target.value)} className={inputCls}><option value="true">Inherit</option><option value="false">Do not inherit</option></select></Field>
      <Field label="Project instructions"><select value={config.runtimeInheritProjectInstructions} onChange={(event) => setConfig('runtimeInheritProjectInstructions', event.target.value)} className={inputCls}><option value="true">Inherit</option><option value="false">Do not inherit</option></select></Field>
      <Field label="Session policy"><select value={config.runtimeSessionPolicy} onChange={(event) => setConfig('runtimeSessionPolicy', event.target.value)} className={inputCls}><option value="persistent">Persistent</option><option value="ephemeral">Ephemeral</option></select></Field>
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <label className="block"><span className="mb-1 block text-xs font-medium uppercase tracking-wider text-text-muted">{label}</span>{children}{hint ? <span className="mt-1 block text-[11px] leading-snug text-text-muted/80">{hint}</span> : null}</label>;
}

function hermesTransportHint(value: string): string {
  if (value === 'cli') return 'Compatibility mode. Hermes buffers reasoning and tool activity, so Agentis receives only the final response.';
  if (value === 'acp') return 'Persistent native stream with live reasoning, tool activity, and Agentis MCP tools. Fails instead of falling back if ACP stalls.';
  return 'Uses native ACP streaming and Agentis MCP tools, with a final-answer-only CLI fallback if ACP is unavailable.';
}

export function configToRuntimeConfig(adapterType: AdapterType, stored: Record<string, unknown>): RuntimeConfig {
  if (adapterType === 'openrouter') return { ...DEFAULT_RUNTIME_CONFIG, openrouterAuthCredentialId: stringOf(stored.authCredentialId), openrouterModel: stringOf(stored.model), openrouterTimeoutMs: stringOf(stored.timeoutMs, '75000') };
  const profile = objectOf(stored.runtimeProfile);
  const base = {
    ...DEFAULT_RUNTIME_CONFIG,
    runtimeMode: stringOf(profile.mode, DEFAULT_RUNTIME_CONFIG.runtimeMode),
    runtimePermissionProfile: stringOf(profile.permissionProfile, DEFAULT_RUNTIME_CONFIG.runtimePermissionProfile),
    runtimeProfileName: stringOf(profile.profileName),
    runtimeInheritUserConfig: boolText(profile.inheritUserConfig, DEFAULT_RUNTIME_CONFIG.runtimeInheritUserConfig),
    runtimeInheritProjectInstructions: boolText(profile.inheritProjectInstructions, DEFAULT_RUNTIME_CONFIG.runtimeInheritProjectInstructions),
    runtimeSessionPolicy: stringOf(profile.sessionPolicy, DEFAULT_RUNTIME_CONFIG.runtimeSessionPolicy),
  };
  if (adapterType === 'openclaw') return { ...base, openclawGatewayId: stringOf(stored.gatewayId), openclawGatewayUrl: stringOf(stored.gatewayUrl), openclawModel: stringOf(stored.model), openclawDeviceTokenCredentialId: stringOf(stored.deviceTokenCredentialId), openclawAgentName: stringOf(stored.agentName), openclawSessionKeyStrategy: stringOf(stored.sessionKeyStrategy, DEFAULT_RUNTIME_CONFIG.openclawSessionKeyStrategy), openclawSessionKey: stringOf(stored.sessionKey), openclawTimeoutSec: stringOf(stored.timeoutSec, DEFAULT_RUNTIME_CONFIG.openclawTimeoutSec), openclawPayloadTemplate: jsonText(stored.payloadTemplate) };
  if (adapterType === 'hermes_agent') return { ...base, hermesBinaryPath: stringOf(stored.command) || stringOf(stored.binaryPath), hermesCwd: stringOf(stored.cwd), hermesModel: stringOf(stored.model), hermesChatTransport: stringOf(stored.chatTransport, DEFAULT_RUNTIME_CONFIG.hermesChatTransport), hermesMaxTurns: stringOf(stored.maxTurns, DEFAULT_RUNTIME_CONFIG.hermesMaxTurns), hermesExtraArgs: arrayText(stored.extraArgs), hermesEnv: jsonText(stored.env), hermesTimeoutSec: stringOf(stored.timeoutSec), hermesGraceSec: stringOf(stored.graceSec) };
  if (adapterType === 'claude_code') return { ...base, claudeBinaryPath: stringOf(stored.command) || stringOf(stored.binaryPath), claudeCwd: stringOf(stored.cwd), claudeModel: stringOf(stored.model), claudeMaxTurns: stringOf(stored.maxTurns, DEFAULT_RUNTIME_CONFIG.claudeMaxTurns), claudeAllowedTools: arrayText(stored.allowedTools), claudeSkipPermissions: boolText(stored.dangerouslySkipPermissions, DEFAULT_RUNTIME_CONFIG.claudeSkipPermissions), claudeExtraArgs: arrayText(stored.extraArgs), claudeEnv: jsonText(stored.env), claudeTimeoutSec: stringOf(stored.timeoutSec) };
  if (adapterType === 'codex') return { ...base, codexBinaryPath: stringOf(stored.command) || stringOf(stored.binaryPath), codexCwd: stringOf(stored.cwd), codexModel: stringOf(stored.model, DEFAULT_RUNTIME_CONFIG.codexModel), codexMaxTurns: stringOf(stored.maxTurns, DEFAULT_RUNTIME_CONFIG.codexMaxTurns), codexReasoningEffort: stringOf(stored.modelReasoningEffort), codexFastMode: boolText(stored.fastMode, DEFAULT_RUNTIME_CONFIG.codexFastMode), codexBrowser: boolText(stored.browser, DEFAULT_RUNTIME_CONFIG.codexBrowser), codexBypassApprovalsAndSandbox: 'true', codexExtraArgs: arrayText(stored.extraArgs), codexEnv: jsonText(stored.env), codexTimeoutSec: stringOf(stored.timeoutSec) };
  if (adapterType === 'cursor') return { ...base, cursorBinaryPath: stringOf(stored.command) || stringOf(stored.binaryPath), cursorCwd: stringOf(stored.cwd), cursorModel: stringOf(stored.model, DEFAULT_RUNTIME_CONFIG.cursorModel), cursorExtraArgs: arrayText(stored.extraArgs), cursorEnv: jsonText(stored.env), cursorTimeoutSec: stringOf(stored.timeoutSec) };
  if (adapterType === 'antigravity') return { ...base, antigravityBinaryPath: stringOf(stored.command) || stringOf(stored.binaryPath), antigravityCwd: stringOf(stored.cwd), antigravityModel: stringOf(stored.model, DEFAULT_RUNTIME_CONFIG.antigravityModel), antigravityYolo: boolText(stored.yolo, DEFAULT_RUNTIME_CONFIG.antigravityYolo), antigravityExtraArgs: arrayText(stored.extraArgs), antigravityEnv: jsonText(stored.env), antigravityTimeoutSec: stringOf(stored.timeoutSec) };
  return { ...base, httpBaseUrl: stringOf(stored.baseUrl), httpAuthCredentialId: stringOf(stored.authCredentialId), httpSharedSecretCredentialId: stringOf(stored.sharedSecretCredentialId), httpDispatchPath: stringOf(stored.dispatchPath, DEFAULT_RUNTIME_CONFIG.httpDispatchPath), httpCancelPath: stringOf(stored.cancelPath), httpHealthPath: stringOf(stored.healthPath, DEFAULT_RUNTIME_CONFIG.httpHealthPath), httpMethod: stringOf(stored.method, DEFAULT_RUNTIME_CONFIG.httpMethod).toUpperCase(), httpHeaders: jsonText(stored.headers), httpPayloadTemplate: jsonText(stored.payloadTemplate), httpDispatchTimeoutMs: stringOf(stored.dispatchTimeoutMs, DEFAULT_RUNTIME_CONFIG.httpDispatchTimeoutMs), httpModel: stringOf(stored.model) };
}

export function runtimeConfigToAdapterConfig(adapterType: AdapterType, config: RuntimeConfig): Record<string, unknown> {
  if (adapterType === 'openrouter') return compact({ authCredentialId: config.openrouterAuthCredentialId, model: config.openrouterModel, timeoutMs: positiveNumber(config.openrouterTimeoutMs) });
  if (adapterType === 'openclaw') return compact({ gatewayId: config.openclawGatewayId, gatewayUrl: normalizeGatewayUrl(config.openclawGatewayUrl), model: config.openclawModel, agentName: config.openclawAgentName, deviceTokenCredentialId: config.openclawDeviceTokenCredentialId, sessionKeyStrategy: config.openclawSessionKeyStrategy, sessionKey: config.openclawSessionKey, timeoutSec: positiveNumber(config.openclawTimeoutSec), payloadTemplate: jsonObject(config.openclawPayloadTemplate) });
  if (adapterType === 'hermes_agent') return compact({ binaryPath: config.hermesBinaryPath, command: config.hermesBinaryPath, cwd: config.hermesCwd, model: config.hermesModel, chatTransport: config.hermesChatTransport, chatTransportVersion: 2, maxTurns: positiveNumber(config.hermesMaxTurns), extraArgs: splitArgs(config.hermesExtraArgs), env: jsonStringRecord(config.hermesEnv), timeoutSec: positiveNumber(config.hermesTimeoutSec), graceSec: positiveNumber(config.hermesGraceSec) });
  if (adapterType === 'claude_code') return compact({ binaryPath: config.claudeBinaryPath, command: config.claudeBinaryPath, cwd: config.claudeCwd, model: config.claudeModel, maxTurns: positiveNumber(config.claudeMaxTurns), allowedTools: splitCsv(config.claudeAllowedTools), runtimeProfile: runtimeProfileConfig(config, config.claudeCwd, false), dangerouslySkipPermissions: boolValue(config.claudeSkipPermissions), extraArgs: splitArgs(config.claudeExtraArgs), env: jsonStringRecord(config.claudeEnv), timeoutSec: positiveNumber(config.claudeTimeoutSec) });
  if (adapterType === 'codex') return compact({ binaryPath: config.codexBinaryPath, command: config.codexBinaryPath, cwd: config.codexCwd, model: config.codexModel, maxTurns: positiveNumber(config.codexMaxTurns), modelReasoningEffort: config.codexReasoningEffort, fastMode: boolValue(config.codexFastMode), browser: boolValue(config.codexBrowser), runtimeProfile: runtimeProfileConfig(config, config.codexCwd, boolValue(config.codexBrowser) ?? false), dangerouslyBypassApprovalsAndSandbox: config.runtimePermissionProfile === 'trusted_local', extraArgs: splitArgs(config.codexExtraArgs), env: jsonStringRecord(config.codexEnv), timeoutSec: positiveNumber(config.codexTimeoutSec) });
  if (adapterType === 'cursor') return compact({ binaryPath: config.cursorBinaryPath, command: config.cursorBinaryPath, cwd: config.cursorCwd, model: config.cursorModel, extraArgs: splitArgs(config.cursorExtraArgs), env: jsonStringRecord(config.cursorEnv), timeoutSec: positiveNumber(config.cursorTimeoutSec) });
  if (adapterType === 'antigravity') return compact({ binaryPath: config.antigravityBinaryPath, command: config.antigravityBinaryPath, cwd: config.antigravityCwd, model: config.antigravityModel, yolo: boolValue(config.antigravityYolo), extraArgs: splitArgs(config.antigravityExtraArgs), env: jsonStringRecord(config.antigravityEnv), timeoutSec: positiveNumber(config.antigravityTimeoutSec) });
  return compact({ baseUrl: config.httpBaseUrl, authCredentialId: config.httpAuthCredentialId, sharedSecretCredentialId: config.httpSharedSecretCredentialId, dispatchPath: config.httpDispatchPath, cancelPath: config.httpCancelPath, healthPath: config.httpHealthPath, method: config.httpMethod, headers: jsonStringRecord(config.httpHeaders), payloadTemplate: jsonObject(config.httpPayloadTemplate), dispatchTimeoutMs: positiveNumber(config.httpDispatchTimeoutMs), model: config.httpModel });
}

export function runtimeModelFor(adapterType: AdapterType, config: RuntimeConfig): string | null {
  if (adapterType === 'openrouter') return config.openrouterModel || null;
  if (adapterType === 'openclaw') return config.openclawModel || null;
  if (adapterType === 'http') return config.httpModel || null;
  if (adapterType === 'hermes_agent') return config.hermesModel || null;
  if (adapterType === 'claude_code') return config.claudeModel || null;
  if (adapterType === 'codex') return config.codexModel || DEFAULT_RUNTIME_CONFIG.codexModel;
  if (adapterType === 'cursor') return config.cursorModel || DEFAULT_RUNTIME_CONFIG.cursorModel;
  if (adapterType === 'antigravity') return config.antigravityModel || null;
  return config.cursorModel || DEFAULT_RUNTIME_CONFIG.cursorModel;
}

export function runtimeLabelFor(adapterType: AdapterType, config: RuntimeConfig): string {
  if (adapterType === 'openrouter') return config.openrouterModel || 'OpenRouter';
  if (adapterType === 'openclaw') return config.openclawModel || config.openclawAgentName || 'OpenClaw';
  if (adapterType === 'hermes_agent') return config.hermesModel || 'Hermes Agent';
  if (adapterType === 'claude_code') return config.claudeModel || 'Claude Code';
  if (adapterType === 'codex') return config.codexModel || DEFAULT_RUNTIME_CONFIG.codexModel;
  if (adapterType === 'cursor') return config.cursorModel || DEFAULT_RUNTIME_CONFIG.cursorModel;
  if (adapterType === 'antigravity') return config.antigravityModel || 'Antigravity CLI';
  return config.httpModel || 'HTTP / Webhook';
}

export function isSupportedAdapterType(value: string): value is AdapterType {
  return ADAPTERS.some((adapter) => adapter.id === value);
}

function runtimeProfileConfig(config: RuntimeConfig, projectRoot: string, browserEnabled: boolean): Record<string, unknown> {
  return compact({
    version: 2,
    mode: config.runtimeMode,
    projectRoot,
    profileName: config.runtimeProfileName,
    permissionProfile: config.runtimePermissionProfile,
    inheritUserConfig: boolValue(config.runtimeInheritUserConfig),
    inheritProjectInstructions: boolValue(config.runtimeInheritProjectInstructions),
    inheritPlugins: boolValue(config.runtimeInheritUserConfig),
    inheritSkills: boolValue(config.runtimeInheritUserConfig),
    browser: browserEnabled ? 'enabled' : 'inherit',
    sessionPolicy: config.runtimeSessionPolicy,
  });
}

function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== '' && value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0)));
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function normalizeGatewayUrl(value: string): string {
  const parsed = parseUrl(value);
  if (!parsed) return value;
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  return parsed.toString();
}

function gatewayHealthUrl(value: string): string {
  const parsed = parseUrl(value);
  if (!parsed) return value.replace(/\/$/, '') + '/health';
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/health`;
  return parsed.toString();
}

function stringOf(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return fallback;
}

function arrayText(value: unknown): string {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join(', ') : '';
}

function jsonText(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return JSON.stringify(value, null, 2);
}

function jsonObject(value: string): Record<string, unknown> | undefined {
  if (!value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function jsonStringRecord(value: string): Record<string, string> | undefined {
  const object = jsonObject(value);
  if (!object) return undefined;
  const entries = Object.entries(object).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function boolText(value: unknown, fallback: string): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string' && (value === 'true' || value === 'false')) return value;
  return fallback;
}

function boolValue(value: string): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function splitCsv(value: string): string[] | undefined {
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

function splitArgs(value: string): string[] | undefined {
  const entries = value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((entry) => entry.replace(/^"|"$/g, '')) ?? [];
  return entries.length > 0 ? entries : undefined;
}

function positiveNumber(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const inputCls = 'w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent';

/** Pick a gateway provisioned in Settings, so the agent references it by id. */
function GatewaySelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [gateways, setGateways] = useState<Array<{ id: string; name: string; gatewayUrl: string }>>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api<{ gateways?: Array<{ id: string; name: string; gatewayUrl: string }> }>('/v1/gateways')
      .then((r) => { if (!cancelled) setGateways(r.gateways ?? []); })
      .catch(() => { /* none configured yet */ })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);
  if (loaded && gateways.length === 0) {
    return (
      <div className="rounded-md border border-line bg-canvas px-3 py-2 text-[12px] text-text-muted">
        No gateways yet — pair one in Settings → Connections → OpenClaw Gateway.
      </div>
    );
  }
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
      <option value="">— Select a paired gateway —</option>
      {gateways.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
    </select>
  );
}
const textareaCls = `${inputCls} min-h-20 resize-y font-mono text-xs`;



