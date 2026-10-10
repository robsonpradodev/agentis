import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Check, ChevronDown, Loader2, Search } from 'lucide-react';
import { api } from '../../lib/api';
import type { AdapterType } from './RuntimePicker';

export interface RuntimeModelOption {
  free?: boolean;
  id: string;
  label: string;
  provider: string;
  tier?: 'flagship' | 'balanced' | 'fast' | 'auto' | 'custom';
  recommended?: boolean;
  description?: string;
}

interface RuntimeModelCatalog {
  adapterType: AdapterType;
  defaultModel: string | null;
  defaultLabel: string;
  supportsManual: boolean;
  models: RuntimeModelOption[];
}

export function ModelChooser({
  adapterType,
  agentId,
  value,
  onChange,
  onLoadingChange,
  disabled = false,
  loading = false,
  loadingLabel = 'Saving model',
  variant = 'full',
  align = 'left',
  openDirection = 'down',
  className,
}: {
  adapterType: AdapterType;
  agentId?: string | null;
  value: string;
  onChange: (value: string) => void;
  onLoadingChange?: (loading: boolean) => void;
  disabled?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  variant?: 'full' | 'compact';
  align?: 'left' | 'right';
  openDirection?: 'up' | 'down';
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [manualModel, setManualModel] = useState('');
  const [catalog, setCatalog] = useState<RuntimeModelCatalog | null>(null);

  useEffect(() => {
    let cancelled = false;
    const queryStr = agentId ? `?agentId=${agentId}` : '';
    onLoadingChange?.(true);
    void api<RuntimeModelCatalog>(`/v1/harness/models/${adapterType}${queryStr}`)
      .then((data) => {
        if (!cancelled) setCatalog(data);
      })
      .catch(() => {
        if (!cancelled) {
          setCatalog({
            adapterType,
            defaultModel: null,
            defaultLabel: 'Runtime default',
            supportsManual: adapterType !== 'openrouter',
            models: [],
          });
        }
      })
      .finally(() => {
        if (!cancelled) onLoadingChange?.(false);
      });
    return () => {
      cancelled = true;
      onLoadingChange?.(false);
    };
  }, [adapterType, agentId, onLoadingChange]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
      setQuery('');
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const models = catalog?.models ?? [];
  const current = value ? models.find((model) => model.id === value) : null;
  const defaultModel = catalog?.defaultModel ?? '';
  const defaultModelLabel = defaultModel
    ? (models.find((m) => m.id === defaultModel)?.label ?? defaultModel)
    : null;
  const displayLabel = value
    ? current?.label ?? value
    : defaultModelLabel ?? catalog?.defaultLabel ?? 'Runtime default';
  const displayDetail = value
    ? current?.provider ?? 'Manual model'
    : defaultModel || 'No override';

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((model) => (
      model.id.toLowerCase().includes(q)
      || model.label.toLowerCase().includes(q)
      || model.provider.toLowerCase().includes(q)
    ));
  }, [models, query]);

  const groups = useMemo(() => {
    const ordered = new Map<string, RuntimeModelOption[]>();
    for (const model of filtered) {
      const group = ordered.get(model.provider) ?? [];
      group.push(model);
      ordered.set(model.provider, group);
    }
    return Array.from(ordered.entries());
  }, [filtered]);

  const manualValue = manualModel.trim();
  const canUseManual = Boolean(
    catalog?.supportsManual
    && manualValue
    && !models.some((model) => model.id.toLowerCase() === manualValue.toLowerCase()),
  );

  function choose(next: string) {
    onChange(next);
    setOpen(false);
    setQuery('');
    setManualModel('');
  }

  useEffect(() => {
    const selectedIsListed = Boolean(value) && models.some((model) => model.id === value);
    setManualModel(selectedIsListed ? '' : value);
  }, [models, value]);

  const button = (
    <button
      type="button"
      disabled={disabled}
      aria-busy={loading}
      onClick={() => setOpen((currentOpen) => !currentOpen)}
      className={clsx(
        'group inline-flex items-center text-left transition disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'compact'
          ? 'gap-1 rounded-md px-1.5 py-1 text-[11px] text-text-secondary hover:bg-surface-2 hover:text-text-primary'
          : 'h-11 w-full gap-2 rounded-input border border-line bg-canvas px-3 text-[13px] text-text-primary hover:border-line-strong hover:bg-surface-3',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{loading ? loadingLabel : displayLabel}</span>
        {variant === 'full' && <span className="block truncate text-[11px] text-text-muted">{displayDetail}</span>}
      </span>
      {loading ? (
        <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
      ) : (
        <ChevronDown size={13} className={clsx('shrink-0 text-text-muted transition', open && 'rotate-180')} />
      )}
    </button>
  );

  return (
    <div ref={rootRef} className={clsx('relative', className)}>
      {variant === 'full' ? (
        <div className="space-y-1.5 rounded-lg border border-line bg-surface-2 p-3">
          <div className="text-xs font-medium uppercase tracking-wider text-text-muted">Model</div>
          {button}
          <div className="text-[11px] text-text-muted">{adapterType === 'openrouter' ? 'Choose a tool-capable model explicitly. No model is selected automatically.' : 'Choose the LLM for this agent, or keep the runtime default.'}</div>
        </div>
      ) : button}

      {open && (
        <div
          className={clsx(
            'absolute z-[80] max-w-[calc(100vw-2rem)] overflow-hidden rounded-card border border-line bg-surface shadow-dropdown',
            variant === 'compact' ? 'w-[250px]' : 'w-[320px]',
            openDirection === 'up' ? 'bottom-full mb-2' : 'top-full mt-2',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <Search size={13} className="text-text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search models"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-muted"
            />
          </div>
          <div className="max-h-[340px] overflow-y-auto p-1.5">
            {adapterType !== 'openrouter' && <ModelRow
              selected={!value}
              label="Default"
              detail={defaultModel || catalog?.defaultLabel || 'Runtime default'}
              badge="Auto"
              onClick={() => choose('')}
            />}
            {groups.map(([provider, options]) => (
              <div key={provider} className="mt-1">
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">{provider}</div>
                {options.map((model) => (
                  <ModelRow
                    key={model.id}
                    selected={value === model.id}
                    label={model.label}
                    detail={model.description ?? model.id}
                    badge={model.free ? 'Free' : model.recommended ? 'Recommended' : tierLabel(model.tier)}
                    onClick={() => choose(model.id)}
                  />
                ))}
              </div>
            ))}
            {catalog?.supportsManual && (
              <div className="mt-2 border-t border-line px-2 pt-2">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Custom</div>
                <div className="flex items-center gap-2">
                  <input
                    value={manualModel}
                    onChange={(event) => setManualModel(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && canUseManual) choose(manualValue);
                    }}
                    placeholder="Custom model id"
                    className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 py-1.5 text-[12px] text-text-primary outline-none placeholder:text-text-muted"
                  />
                  <button
                    type="button"
                    disabled={!canUseManual}
                    onClick={() => choose(manualValue)}
                    className="rounded-md border border-line bg-canvas px-2 py-1.5 text-[11px] font-medium text-text-secondary transition hover:border-line-strong hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Use
                  </button>
                </div>
                {canUseManual ? (
                  <div className="mt-1 text-[11px] text-text-muted">Save any runtime-supported model ID, even if it is not listed above.</div>
                ) : (
                  <div className="mt-1 text-[11px] text-text-muted">Enter a model ID that is not in the catalog to pin a custom runtime model.</div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ModelRow({
  selected,
  label,
  detail,
  badge,
  onClick,
}: {
  selected: boolean;
  label: string;
  detail: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition',
        selected ? 'bg-accent-soft text-text-primary' : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary',
      )}
    >
      <span className={clsx('flex h-4 w-4 shrink-0 items-center justify-center rounded-full border', selected ? 'border-accent text-accent' : 'border-line text-transparent')}>
        <Check size={11} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{label}</span>
        <span className="block truncate text-[11px] text-text-muted">{detail}</span>
      </span>
      {badge && <span className="shrink-0 rounded-pill border border-line bg-canvas px-1.5 py-0.5 text-[10px] text-text-muted">{badge}</span>}
    </button>
  );
}

function tierLabel(tier: RuntimeModelOption['tier']): string | undefined {
  if (tier === 'flagship') return 'Deep';
  if (tier === 'balanced') return 'Balanced';
  if (tier === 'fast') return 'Fast';
  if (tier === 'auto') return 'Auto';
  if (tier === 'custom') return 'Custom';
  return undefined;
}



