import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { ModelChooser } from './ModelChooser';
import {
  configToRuntimeConfig,
  DEFAULT_RUNTIME_CONFIG,
  isSupportedAdapterType,
  runtimeConfigToAdapterConfig,
  runtimeModelFor,
  type AdapterType,
} from './RuntimePicker';
import { runtimeModelValue, withRuntimeModel } from './runtimeModelField';
import { HARNESS } from './harnessMeta';

// The runtimes a local Agentis workspace can drive. Order = most common first.
const RUNTIME_OPTIONS: AdapterType[] = ['claude_code', 'codex', 'cursor', 'antigravity', 'hermes_agent', 'openclaw', 'openrouter', 'http'];

interface AgentRecord {
  id: string;
  name: string;
  adapterType?: string | null;
  runtimeModel?: string | null;
  config?: Record<string, unknown> | null;
}

type ControlVariant = 'drawer' | 'rail';

export function SelectedAgentModelControl({
  agentId,
  adapterType,
  onUpdated,
  variant = 'drawer',
}: {
  agentId: string;
  adapterType?: string | null;
  onUpdated?: () => void;
  variant?: ControlVariant;
}) {
  const toast = useToast();
  const [agent, setAgent] = useState<AgentRecord | null>(null);
  const [selectedModel, setSelectedModel] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);

  useEffect(() => {
    if (!isSupportedAdapterType(adapterType ?? '')) {
      setAgent(null);
      setSelectedModel('');
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setAgent(null);
    void api<{ agent: AgentRecord }>(`/v1/agents/${agentId}`)
      .then((data) => {
        if (cancelled) return;
        const fullAgent = data.agent;
        setAgent(fullAgent);
        if (!isSupportedAdapterType(fullAgent.adapterType ?? '')) {
          setSelectedModel('');
          return;
        }
        const fullAdapterType = fullAgent.adapterType as AdapterType;
        const runtimeConfig = configToRuntimeConfig(fullAdapterType, (fullAgent.config ?? {}) as Record<string, unknown>);
        setSelectedModel(runtimeModelValue(runtimeConfig, fullAdapterType));
      })
      .catch(() => {
        if (!cancelled) {
          setAgent(null);
          setSelectedModel('');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [agentId, adapterType]);

  if (!isSupportedAdapterType(adapterType ?? '')) return null;
  const requestedAdapterType = adapterType as AdapterType;
  if (agent && !isSupportedAdapterType(agent.adapterType ?? '')) return null;

  const fetchedAdapterType = isSupportedAdapterType(agent?.adapterType ?? '')
    ? (agent?.adapterType as AdapterType)
    : null;
  const effectiveAdapterType: AdapterType = fetchedAdapterType ?? requestedAdapterType;

  async function updateModel(nextModel: string) {
    if (!agent || !isSupportedAdapterType(agent.adapterType ?? '')) return;
    const agentAdapterType = agent.adapterType as AdapterType;
    const previousModel = selectedModel;
    const storedConfig = (agent.config ?? {}) as Record<string, unknown>;
    const runtimeConfig = configToRuntimeConfig(agentAdapterType, storedConfig);
    const nextRuntimeConfig = withRuntimeModel(runtimeConfig, agentAdapterType, nextModel);
    const nextKnownConfig = runtimeConfigToAdapterConfig(agentAdapterType, nextRuntimeConfig);
    // A model-only edit must not silently opt a legacy agent into a synthesized
    // execution profile. The Runtime editor is the explicit migration point;
    // here we preserve an existing profile but otherwise leave it absent.
    if (!Object.prototype.hasOwnProperty.call(storedConfig, 'runtimeProfile')) {
      delete nextKnownConfig.runtimeProfile;
    }
    const nextConfig = { ...storedConfig, ...nextKnownConfig };
    if (!Object.prototype.hasOwnProperty.call(nextKnownConfig, 'model')) delete nextConfig.model;

    setSelectedModel(nextModel);
    setSaving(true);
    try {
      await api(`/v1/agents/${agent.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          config: nextConfig,
          runtimeModel: runtimeModelFor(agentAdapterType, nextRuntimeConfig),
        }),
      });
      setAgent({
        ...agent,
        config: nextConfig,
        runtimeModel: runtimeModelFor(agentAdapterType, nextRuntimeConfig),
      });
      toast.success('Model updated');
      onUpdated?.();
    } catch (error) {
      setSelectedModel(previousModel);
      toast.error('Model update failed', apiErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function updateRuntime(nextAdapter: AdapterType) {
    if (!agent || nextAdapter === effectiveAdapterType) return;
    if (nextAdapter === 'openrouter') {
      toast.error('Configuration required', 'Choose an API key and model in this agent\'s Runtime settings, then save. The active runtime is unchanged.');
      return;
    }
    const previous = agent;
    // Switch harness with that runtime's default config + model. Advanced
    // per-runtime settings (binary paths, cwd…) live in the Runtime tab.
    const nextConfig = runtimeConfigToAdapterConfig(nextAdapter, DEFAULT_RUNTIME_CONFIG);
    const nextModel = runtimeModelFor(nextAdapter, DEFAULT_RUNTIME_CONFIG);
    const nextSelectedModel = runtimeModelValue(configToRuntimeConfig(nextAdapter, nextConfig), nextAdapter);
    setAgent({ ...agent, adapterType: nextAdapter, config: nextConfig, runtimeModel: nextModel });
    setSelectedModel(nextSelectedModel);
    setSaving(true);
    try {
      // Dedicated rebind endpoint — swaps the runtime binding without touching the
      // agent's identity, Brain, or hierarchy (Track R).
      await api(`/v1/agents/${agent.id}/runtime`, {
        method: 'POST',
        body: JSON.stringify({ adapterType: nextAdapter, config: nextConfig, runtimeModel: nextModel }),
      });
      const updated = { ...agent, adapterType: nextAdapter, config: nextConfig, runtimeModel: nextModel };
      setAgent(updated);
      toast.success('Runtime updated');
      onUpdated?.();
    } catch (error) {
      setAgent(previous);
      if (isSupportedAdapterType(previous.adapterType ?? '')) {
        setSelectedModel(runtimeModelValue(configToRuntimeConfig(previous.adapterType as AdapterType, (previous.config ?? {}) as Record<string, unknown>), previous.adapterType as AdapterType));
      }
      toast.error('Runtime update failed', apiErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  const disabled = loading || saving || catalogLoading || !agent;
  const statusBody = loading
    ? 'Loading the current runtime model and saved adapter settings.'
    : saving
      ? 'Saving the new runtime model now.'
      : null;

  return (
    <section className={variant === 'drawer' ? 'space-y-2' : 'mb-3 border-b border-line/70 pb-3'}>
      <div className="flex items-center gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">Runtime</div>
        {(loading || saving) && <Loader2 size={12} className="animate-spin text-text-muted" />}
      </div>
      <select
        aria-label="Runtime"
        value={effectiveAdapterType}
        onChange={(event) => void updateRuntime(event.target.value as AdapterType)}
        disabled={disabled}
        className="h-8 w-full rounded-input border border-line bg-surface-2 px-2.5 text-[12px] text-text-primary outline-none focus:border-accent disabled:opacity-50"
      >
        {RUNTIME_OPTIONS.map((adapter) => (
          <option key={adapter} value={adapter}>{HARNESS[adapter]?.label ?? adapter}</option>
        ))}
      </select>
      <div className="pt-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">Model</div>
      <ModelChooser
        adapterType={effectiveAdapterType}
        agentId={agentId}
        value={selectedModel}
        onChange={(next) => void updateModel(next)}
        disabled={disabled}
        loading={saving}
        loadingLabel="Saving model"
        onLoadingChange={setCatalogLoading}
        className={variant === 'rail' ? 'mt-0.5' : undefined}
      />
      {statusBody && <p className="text-[11px] leading-relaxed text-text-muted">{statusBody}</p>}
    </section>
  );
}



