/**
 * AppEngineModal — App-level settings, framed as a product control surface.
 *
 * Four tabs, ordered by what someone configuring an Agentic App actually cares
 * about: **Overview** (a friendly summary), **Identity** (name / description /
 * icon / version / lifecycle), **Access** (who can use it, sharing, entry
 * surface), and **Advanced** (custom-code policy, capability grants, and
 * read-only distribution metadata). Implementation plumbing — checksum, source,
 * raw grant JSON — lives only under Advanced, never up front.
 *
 * All edits map to the existing `PATCH /v1/apps/:id` contract; no new fields.
 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import { AppExportModal } from './AppExportModal';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Target,
  Boxes,
  FileText,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { AppRecord, AppSurface } from '@agentis/core';
import { appsApi, type AppUpdatePayload } from '../../lib/appsApi';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { useConfirm } from '../shared/ConfirmDialog';
import { nestedDomainOptions } from '../shared/DomainToolbar';
import { AppGoalPanel } from './AppGoalPanel';
import { AgenticAppControlPlane } from './AgenticAppControlPlane';

/** App-level run analytics — shape of `GET /v1/apps/:id/analytics`. */
interface AppAnalytics {
  runs: number;
  successRate: number | null;
  avgDurationMs: number | null;
  avgCostCents: number;
  totalCostCents: number;
  metered: boolean;
  totalTokensIn: number;
  totalTokensOut: number;
  totalTokens: number;
  avgTokensPerRun: number;
  perWorkflow: Array<{
    workflowId: string;
    title: string;
    runs: number;
    successRate: number | null;
    totalTokens: number;
    totalCostCents: number;
  }>;
  perAgent?: Array<{ agentId: string | null; name: string; tokensIn: number; tokensOut: number; totalTokens: number }>;
}

/** A field of a workflow's input contract — drives the on-demand Run inputs form. */
interface RunInputField {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any';
  required?: boolean;
  description?: string;
}

/** Coerce the form's string values to the contract's declared types. */
function coerceRunInputs(fields: RunInputField[], values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = values[f.key] ?? '';
    if (raw === '' && !f.required) continue;
    if (f.type === 'number') out[f.key] = raw === '' ? null : Number(raw);
    else if (f.type === 'boolean') out[f.key] = raw === 'true' || raw === '1';
    else if (f.type === 'array' || f.type === 'object') {
      try { out[f.key] = JSON.parse(raw); } catch { out[f.key] = raw; }
    } else out[f.key] = raw;
  }
  return out;
}

/** Domain (or Subdomain) the App can be organized under. */
export interface AppEngineDomain {
  id: string;
  name: string;
  colorHex?: string | null;
  managerId?: string | null;
  parentDomainId?: string | null;
}

/** Agent that can own an App (manager or specialist). */
export interface AppEngineAgent {
  id: string;
  name: string;
  role?: string | null;
}

type AppEnginePage = 'overview' | 'goal' | 'runtime' | 'analytics' | 'advanced';
type CapabilityGrant = AppRecord['policy']['grants'][number];

const ENGINE_PAGES: Array<{ id: AppEnginePage; label: string; icon: ReactNode }> = [
  { id: 'overview', label: 'Overview', icon: <Settings size={13} /> },
  { id: 'goal', label: 'Goal', icon: <Target size={13} /> },
  { id: 'runtime', label: 'Runtime', icon: <Activity size={13} /> },
  { id: 'analytics', label: 'Analytics', icon: <BarChart3 size={13} /> },
  { id: 'advanced', label: 'Advanced', icon: <SlidersHorizontal size={13} /> },
];

export function AppEngineModal({
  open,
  app,
  surfaces,
  domains = [],
  agents = [],
  onClose,
  onSave,
  onDeleted,
}: {
  open: boolean;
  app: AppRecord | null;
  surfaces: AppSurface[];
  domains?: AppEngineDomain[];
  agents?: AppEngineAgent[];
  onClose: () => void;
  onSave: (patch: AppUpdatePayload) => Promise<AppRecord>;
  /** Called after the app has been permanently deleted on the server. */
  onDeleted: (appId: string) => void;
}) {
  const [page, setPage] = useState<AppEnginePage>('overview');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [version, setVersion] = useState('');
  const [status, setStatus] = useState<AppRecord['status']>('active');
  const [icon, setIcon] = useState('');
  const [domainId, setDomainId] = useState('');
  const [ownerAgentId, setOwnerAgentId] = useState('');
  const [entrySurfaceId, setEntrySurfaceId] = useState('');
  const [customCode, setCustomCode] = useState<AppRecord['policy']['customCode']>('disabled');
  const [grants, setGrants] = useState<CapabilityGrant[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<AppAnalytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open || !app) return;
    setPage('overview');
    setName(app.name);
    setDescription(app.description ?? '');
    setVersion(app.version);
    setStatus(app.status);
    setIcon(app.icon ?? '');
    setDomainId(app.domainId ?? '');
    setOwnerAgentId(app.ownerAgentId ?? '');
    setEntrySurfaceId(app.entrySurfaceId ?? '');
    setCustomCode(app.policy.customCode);
    setGrants(app.policy.grants);
    setError(null);
    setSaving(false);
    setAnalytics(null);
    setAnalyticsError(null);
  }, [app, open]);

  const appId = app?.id ?? null;
  const confirm = useConfirm();
  const [deleting, setDeleting] = useState(false);
  const deleteApp = useCallback(async () => {
    if (!app) return;
    const ok = await confirm({
      title: `Delete "${app.name}"?`,
      body: 'This permanently deletes the app, its workflows, surfaces, data, and conversation history. This cannot be undone.',
      confirmLabel: 'Delete app',
      tone: 'danger',
      typeToConfirm: app.name,
    });
    if (!ok) return;
    setDeleting(true);
    setError(null);
    try {
      await appsApi.remove(app.id);
      onDeleted(app.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to delete app');
      setDeleting(false);
    }
  }, [app, confirm, onDeleted]);
  // Export opens a preview of the App's full dependency closure so the operator
  // sees (and can adjust) what actually travels — it used to download a skeleton
  // silently, leaving agents, memory, knowledge and data behind with no signal.
  const [exportOpen, setExportOpen] = useState(false);
  const loadAnalytics = useCallback(async () => {
    if (!appId) return;
    setAnalyticsLoading(true);
    setAnalyticsError(null);
    try {
      setAnalytics(await api<AppAnalytics>(`/v1/apps/${appId}/analytics`));
    } catch {
      setAnalytics(null);
      setAnalyticsError('Could not load app analytics right now.');
    } finally {
      setAnalyticsLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    if (!open || page !== 'analytics' || analytics || analyticsLoading) return;
    void loadAnalytics();
  }, [open, page, analytics, analyticsLoading, loadAnalytics]);

  if (!open || !app) return null;

  const trimmedIcon = icon.trim();
  const selectedDomain = domains.find((domain) => domain.id === domainId) ?? null;
  const selectedOwner = agents.find((agent) => agent.id === ownerAgentId) ?? null;
  const domainManager = selectedDomain?.managerId
    ? agents.find((agent) => agent.id === selectedDomain.managerId) ?? null
    : null;

  async function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (!app || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim() || app.name,
        description: description.trim(),
        version: version.trim() || app.version,
        status,
        icon: trimmedIcon || null,
        domainId: domainId || null,
        ownerAgentId: ownerAgentId || null,
        entrySurfaceId: entrySurfaceId || null,
        policy: {
          customCode,
          grants: grants.filter((grant) => grant.capability.trim()),
        },
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save app settings');
    } finally {
      setSaving(false);
    }
  }

  async function loadIconFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setIcon(dataUrl);
    } finally {
      event.currentTarget.value = '';
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-canvas/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="App engine"
      onClick={onClose}
    >
      <form
        onSubmit={(event) => void submit(event)}
        className="flex h-[min(760px,88vh)] w-[min(980px,94vw)] overflow-hidden rounded-2xl border border-line bg-surface shadow-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <aside className="w-52 shrink-0 border-r border-line bg-canvas/55 p-2">
          <div className="px-2 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">App engine</div>
            <div className="mt-2 flex items-center gap-2">
              <AppIconPreview icon={trimmedIcon} />
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold text-text-primary">{name || app.name}</div>
                <div className="truncate text-[11px] text-text-muted">v{version || app.version}</div>
              </div>
            </div>
          </div>
          <nav className="mt-2 space-y-1">
            {ENGINE_PAGES.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setPage(item.id)}
                className={clsx(
                  'flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] font-medium transition-colors',
                  page === item.id
                    ? 'bg-surface-2 text-text-primary'
                    : 'text-text-muted hover:bg-surface hover:text-text-secondary',
                )}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </nav>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-text-muted">App engine</div>
              <div className="text-[13px] font-semibold text-text-primary">{ENGINE_PAGES.find((item) => item.id === page)?.label}</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close app engine"
              className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
            >
              <X size={16} />
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            {error ? (
              <div className="mb-3 rounded-card border border-danger/30 bg-danger-soft px-3 py-2 text-[12px] text-danger">{error}</div>
            ) : null}

            {page === 'overview' && (
              <div className="space-y-4">
                <div className="flex items-start gap-4 rounded-xl border border-line bg-canvas/45 p-3">
                  <IconUploadField icon={trimmedIcon} onPick={() => fileInputRef.current?.click()} onClear={() => setIcon('')} />
                  <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void loadIconFile(event)} />
                  <div className="min-w-0 flex-1 space-y-2">
                    <TextField label="Name" value={name} onChange={setName} />
                    <TextareaField label="Description" value={description} onChange={setDescription} rows={3} />
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <TextField label="Version" value={version} onChange={setVersion} />
                  <SelectField label="Lifecycle status" value={status} onChange={(value) => setStatus(value as AppRecord['status'])}>
                    <option value="active">active</option>
                    <option value="archived">archived</option>
                  </SelectField>
                </div>
                <SelectField label="Entry surface" value={entrySurfaceId} onChange={setEntrySurfaceId}>
                  <option value="">No entry surface</option>
                  {surfaces.map((surface) => (
                    <option key={surface.id} value={surface.id}>{surface.name}</option>
                  ))}
                </SelectField>
                {surfaces.length === 0 ? (
                  <InfoPanel title="No surfaces yet">Build a surface in the Interface tab before choosing an entry surface.</InfoPanel>
                ) : null}
                <div className="space-y-3 border-t border-line pt-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Organization</div>
                  <p className="-mt-1 text-[11px] text-text-muted">
                    Place this app under a domain (and its manager). Its workflows inherit this when they have no owner of their own.
                  </p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <SelectField label="Domain" value={domainId} onChange={setDomainId}>
                      <option value="">Unassigned</option>
                      {nestedDomainOptions(domains).map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </SelectField>
                    <SelectField label="Owner (specialist)" value={ownerAgentId} onChange={setOwnerAgentId}>
                      <option value="">{domainManager ? `Domain manager (${domainManager.name})` : 'No specific owner'}</option>
                      {agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}{agent.role ? ` · ${agent.role}` : ''}
                        </option>
                      ))}
                    </SelectField>
                  </div>
                  {selectedOwner ? (
                    <p className="text-[11px] text-text-muted">This app is owned by {selectedOwner.name}.</p>
                  ) : null}
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
                  <div className="min-w-0">
                    <div className="text-[12px] font-medium text-text-primary">Export app</div>
                    <div className="text-[11px] text-text-muted">Choose what travels — agents, memory, knowledge and data.</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setExportOpen(true)}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-2.5 text-[12px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
                  >
                    <Upload size={13} /> Export
                  </button>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger-soft/20 p-3">
                  <div className="min-w-0">
                    <div className="text-[12px] font-medium text-danger">Delete this app</div>
                    <div className="text-[11px] text-text-muted">
                      Permanently removes the app, its workflows, surfaces, and data. This cannot be undone.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void deleteApp()}
                    disabled={deleting}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-btn border border-danger/40 bg-transparent px-2.5 text-[12px] font-medium text-danger hover:bg-danger-soft disabled:opacity-50"
                  >
                    {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Delete
                  </button>
                </div>
              </div>
            )}

            {page === 'goal' && appId && <AppGoalPanel appId={appId} />}

            {page === 'runtime' && appId && (
              <AgenticAppControlPlane appId={appId} appName={app.name} />
            )}

            {page === 'analytics' && (
              <AppAnalyticsPanel
                analytics={analytics}
                loading={analyticsLoading}
                error={analyticsError}
                onRefresh={() => void loadAnalytics()}
              />
            )}

            {page === 'advanced' && (
              <div className="space-y-4">
                <ToggleField label="Allow custom-coded views" checked={customCode === 'allowed'} onChange={(value) => setCustomCode(value ? 'allowed' : 'disabled')} />
                <p className="-mt-2 text-[11px] text-text-muted">
                  Custom views run agent-written HTML in a hardened sandbox. Leave off for fully portable apps.
                </p>
                <GrantsEditor grants={grants} onChange={setGrants} />
                <div className="space-y-2 border-t border-line pt-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Distribution</div>
                  <InfoPanel title="Slug">{app.slug}</InfoPanel>
                  <InfoPanel title="Source">{app.source ? `${app.source.kind}:${app.source.id}` : 'Local app, no Hub source attached.'}</InfoPanel>
                  <InfoPanel title="Installed checksum">{app.installedChecksum ?? 'None — this app was built here.'}</InfoPanel>
                </div>
              </div>
            )}
          </div>

          <footer className="flex items-center justify-between gap-3 border-t border-line bg-surface-2 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2 text-[11px] text-text-muted">
              <SlidersHorizontal size={13} />
              <span className="truncate">Settings save to this self-hosted Agentis runtime.</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="inline-flex h-8 items-center justify-center rounded-btn border border-line bg-transparent px-3 text-[12px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="inline-flex h-8 items-center gap-1.5 rounded-btn bg-accent px-3 text-[12px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-50"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                Save settings
              </button>
            </div>
          </footer>
        </section>
      </form>
      {exportOpen && app && (
        <AppExportModal
          appId={app.id}
          appName={app.name}
          appSlug={app.slug}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  );
}

function GrantsEditor({ grants, onChange }: { grants: CapabilityGrant[]; onChange: (grants: CapabilityGrant[]) => void }) {
  function update(index: number, capability: string) {
    onChange(grants.map((grant, i) => (i === index ? { ...grant, capability } : grant)));
  }
  function remove(index: number) {
    onChange(grants.filter((_, i) => i !== index));
  }
  function add() {
    onChange([...grants, { capability: '', scopes: [] }]);
  }
  return (
    <div>
      <div className="mb-1 text-[12px] font-semibold text-text-primary">Capability grants</div>
      <div className="mb-2 text-[11px] text-text-muted">Cross-app or plugin capabilities this app may use. Most apps need none.</div>
      <div className="space-y-2">
        {grants.length === 0 ? (
          <div className="rounded-card border border-dashed border-line px-3 py-2 text-[11px] text-text-muted">No grants.</div>
        ) : grants.map((grant, index) => (
          <div key={index} className="flex items-center gap-2">
            <input
              value={grant.capability}
              onChange={(event) => update(index, event.target.value)}
              placeholder="capability id (e.g. agentmail.send)"
              aria-label={`Grant ${index + 1}`}
              className="h-8 flex-1 rounded-input border border-line bg-surface-2 px-2.5 text-[12px] text-text-primary outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={() => remove(index)}
              aria-label={`Remove grant ${index + 1}`}
              className="rounded-btn p-1.5 text-text-muted hover:bg-danger-soft hover:text-danger"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={add}
        className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-2.5 text-[12px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
      >
        <Plus size={13} /> Add grant
      </button>
    </div>
  );
}

/**
 * Editable app image — mirrors the operator avatar UX: click (or hover) the
 * photo itself to upload; no separate button or URL text box. Emoji/URL icons
 * still render if the app already had one.
 */
function IconUploadField({ icon, onPick, onClear }: { icon: string; onPick: () => void; onClear: () => void }) {
  const isImage = icon.startsWith('http://') || icon.startsWith('https://') || icon.startsWith('data:image/');
  return (
    <div className="shrink-0">
      <button
        type="button"
        onClick={onPick}
        aria-label="Upload app image"
        title="Click to upload an image"
        className="group relative flex h-20 w-20 items-center justify-center overflow-hidden rounded-xl border border-line bg-canvas text-text-secondary"
      >
        {isImage ? (
          <img src={icon} alt="" className="h-full w-full object-cover" />
        ) : icon ? (
          <span className="px-2 text-center text-[24px]">{icon}</span>
        ) : (
          <Boxes size={24} />
        )}
        <span className="absolute inset-0 hidden items-center justify-center bg-black/55 text-white group-hover:flex">
          <Upload size={18} />
        </span>
      </button>
      {isImage ? (
        <button type="button" onClick={onClear} className="mt-1 block w-full text-center text-[10px] text-text-muted hover:text-text-primary">
          Remove
        </button>
      ) : null}
    </div>
  );
}

function AppIconPreview({ icon, size = 'md' }: { icon: string; size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'h-20 w-20 rounded-xl' : 'h-9 w-9 rounded-lg';
  const isImage = icon.startsWith('http://') || icon.startsWith('https://') || icon.startsWith('data:image/');
  return (
    <span className={clsx('flex shrink-0 items-center justify-center overflow-hidden border border-line bg-canvas text-text-secondary', box)}>
      {isImage ? (
        <img src={icon} alt="" className="h-full w-full object-cover" />
      ) : icon ? (
        <span className={size === 'lg' ? 'px-2 text-center text-[24px]' : 'px-1 text-center text-[15px]'}>{icon}</span>
      ) : (
        <Boxes size={size === 'lg' ? 24 : 15} />
      )}
    </span>
  );
}

function EngineStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-canvas/45 p-3">
      <div className="text-[11px] text-text-muted">{label}</div>
      <div className="mt-1 truncate text-[16px] font-semibold text-text-primary">{value}</div>
    </div>
  );
}

/**
 * App-level analytics — a rollup across every workflow the app owns. Tokens are
 * the headline signal (most runtimes are subscription harnesses with no $ cost);
 * the per-workflow table shows where consumption concentrates.
 */
function AppAnalyticsPanel({
  analytics,
  loading,
  error,
  onRefresh,
}: {
  analytics: AppAnalytics | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const toast = useToast();
  const [launching, setLaunching] = useState<string | null>(null);
  // When a workflow declares an input contract, collect the inputs first so an
  // input-requiring run isn't blocked by the run-gate; otherwise run directly.
  const [runForm, setRunForm] = useState<{ workflowId: string; title: string; fields: RunInputField[] } | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});

  // Fire the run from the app engine. The run inspector remains available from
  // explicit inspect actions instead of opening automatically.
  const submitRun = useCallback(
    async (workflowId: string, inputs: Record<string, unknown>) => {
      setLaunching(workflowId);
      try {
        await api<{ runId: string }>(`/v1/workflows/${workflowId}/run`, {
          method: 'POST',
          body: JSON.stringify({ inputs }),
        });
        setRunForm(null);
      } catch (err) {
        toast.error('Could not start run', apiErrorMessage(err));
      } finally {
        setLaunching(null);
      }
    },
    [toast],
  );

  const onRunClick = useCallback(
    async (workflowId: string, title: string) => {
      setLaunching(workflowId);
      try {
        const { workflow } = await api<{ workflow: { graph?: { inputContract?: { fields?: RunInputField[] } } } }>(
          `/v1/workflows/${workflowId}`,
        );
        const fields = workflow?.graph?.inputContract?.fields ?? [];
        if (fields.length > 0) {
          setFormValues({});
          setRunForm({ workflowId, title, fields });
          setLaunching(null);
          return;
        }
      } catch {
        /* fall through to a plain run — the run-gate will report any missing input */
      }
      await submitRun(workflowId, {});
    },
    [submitRun],
  );
  if (loading && !analytics) {
    return (
      <div className="flex items-center gap-2 py-6 text-[12px] text-text-muted">
        <Loader2 size={14} className="animate-spin" /> Loading app analytics…
      </div>
    );
  }
  if (error && !analytics) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2.5 text-[12px] text-danger">
        <span>{error}</span>
        <button type="button" onClick={onRefresh} className="rounded-btn p-1 hover:bg-danger/15" aria-label="Retry">
          <RefreshCw size={13} />
        </button>
      </div>
    );
  }
  if (!analytics) return null;
  const successLabel = analytics.successRate == null ? '–' : `${Math.round(analytics.successRate * 100)}%`;
  return (
    <div className="space-y-4">
      {runForm ? (
        <div className="rounded-xl border border-accent/30 bg-accent-soft/20 p-3">
          <div className="mb-2 flex items-center gap-2">
            <Play size={13} className="text-accent" />
            <span className="flex-1 truncate text-[12px] font-semibold text-text-primary">Run “{runForm.title}? — inputs</span>
          </div>
          <div className="space-y-2">
            {runForm.fields.map((f) => (
              <label key={f.key} className="block">
                <span className="text-[11px] font-medium text-text-secondary">
                  {f.key}{f.required ? ' *' : ''} <span className="text-text-muted">({f.type})</span>
                </span>
                <input
                  value={formValues[f.key] ?? ''}
                  onChange={(e) => setFormValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  placeholder={f.description ?? (f.type === 'array' || f.type === 'object' ? 'JSON' : f.type)}
                  className="mt-0.5 w-full rounded-btn border border-line bg-canvas px-2 py-1 text-[12px] text-text-primary outline-none focus:border-accent"
                />
              </label>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-end gap-2">
            <button type="button" onClick={() => setRunForm(null)} className="rounded-btn px-2.5 py-1 text-[11px] text-text-muted hover:bg-surface-2">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => submitRun(runForm.workflowId, coerceRunInputs(runForm.fields, formValues))}
              disabled={launching === runForm.workflowId}
              className="inline-flex items-center gap-1 rounded-btn bg-accent px-2.5 py-1 text-[11px] font-medium text-on-accent hover:bg-accent/90 disabled:opacity-50"
            >
              {launching === runForm.workflowId ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
              Run
            </button>
          </div>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <BarChart3 size={14} className="text-accent" />
        <span className="flex-1 text-[12px] font-semibold text-text-primary">Run analytics — all workflows</span>
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh analytics"
          className="rounded-btn p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <EngineStat label="Runs" value={String(analytics.runs)} />
        <EngineStat label="Success" value={successLabel} />
        <EngineStat label="Avg duration" value={formatDurationShort(analytics.avgDurationMs)} />
      </div>

      <div className="rounded-xl border border-accent/25 bg-accent-soft/30 p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-accent">Tokens consumed</span>
          <span className="text-[11px] text-text-muted">~{formatTokens(analytics.avgTokensPerRun)}/run</span>
        </div>
        <div className="mt-1 text-[24px] font-semibold leading-tight text-text-primary">{formatTokens(analytics.totalTokens)}</div>
        <div className="mt-1.5 flex items-center gap-4 text-[12px] text-text-secondary">
          <span className="inline-flex items-center gap-1"><ArrowDownRight size={13} className="text-text-muted" /> {formatTokens(analytics.totalTokensIn)} in</span>
          <span className="inline-flex items-center gap-1"><ArrowUpRight size={13} className="text-text-muted" /> {formatTokens(analytics.totalTokensOut)} out</span>
        </div>
      </div>

      {analytics.metered ? (
        <div className="grid grid-cols-2 gap-2">
          <EngineStat label="Avg cost / run" value={`$${(analytics.avgCostCents / 100).toFixed(3)}`} />
          <EngineStat label="Total cost" value={`$${(analytics.totalCostCents / 100).toFixed(2)}`} />
        </div>
      ) : (
        <div className="rounded-xl border border-line bg-canvas/45 px-3 py-2 text-[11.5px] text-text-muted">
          Subscription runtime — cost is not metered. Tokens above are the spend signal.
        </div>
      )}

      <div>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Per workflow</div>
        {analytics.perWorkflow.length === 0 ? (
          <div className="rounded-card border border-dashed border-line px-3 py-2 text-[11px] text-text-muted">
            This app has no workflows yet.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-line">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-canvas/45 text-left text-[10px] uppercase tracking-wider text-text-muted">
                  <th className="px-3 py-1.5 font-medium">Workflow</th>
                  <th className="px-2 py-1.5 text-right font-medium">Runs</th>
                  <th className="px-2 py-1.5 text-right font-medium">Success</th>
                  <th className="px-3 py-1.5 text-right font-medium">Tokens</th>
                  <th className="px-2 py-1.5 text-right font-medium">Run</th>
                </tr>
              </thead>
              <tbody>
                {analytics.perWorkflow.map((wf) => (
                  <tr key={wf.workflowId} className="border-t border-line/70">
                    <td className="max-w-0 truncate px-3 py-1.5 text-text-primary" title={wf.title}>{wf.title}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-text-secondary">{wf.runs}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-text-secondary">
                      {wf.successRate == null ? '–' : `${Math.round(wf.successRate * 100)}%`}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-text-secondary">{formatTokens(wf.totalTokens)}</td>
                    <td className="px-2 py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => onRunClick(wf.workflowId, wf.title)}
                        disabled={launching === wf.workflowId}
                        className="inline-flex items-center gap-1 rounded-btn border border-accent/40 bg-accent-soft/40 px-2 py-1 text-[11px] font-medium text-accent hover:bg-accent-soft disabled:opacity-50"
                        aria-label={`Run ${wf.title}`}
                        title={`Run ${wf.title} now`}
                      >
                        {launching === wf.workflowId ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                        Run
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {analytics.perAgent && analytics.perAgent.length > 0 && (
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Tokens by agent</div>
          <div className="space-y-1.5">
            {analytics.perAgent.map((row) => {
              const share = analytics.totalTokens > 0 ? row.totalTokens / analytics.totalTokens : 0;
              return (
                <div key={row.agentId ?? 'system'} className="flex items-center gap-3">
                  <span className={`min-w-0 flex-1 truncate text-[12px] ${row.agentId ? 'text-text-primary' : 'italic text-text-muted'}`} title={row.name}>{row.name}</span>
                  <span className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-canvas">
                    <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.round(share * 100)}%` }} />
                  </span>
                  <span className="w-16 shrink-0 text-right font-mono text-[11.5px] tabular-nums text-text-secondary" title={`${row.tokensIn} in · ${row.tokensOut} out`}>{formatTokens(row.totalTokens)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Compact token count: 1234 → "1.2k", 1_200_000 → "1.2M". */
function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}

/** Short human duration for the analytics tiles: 49800 → "49.8s", 125000 → "2.1m". */
function formatDurationShort(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '–';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function InfoPanel({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('rounded-xl border border-line bg-canvas/45 p-3', className)}>
      <div className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-text-primary">
        <FileText size={13} />
        {title}
      </div>
      <div className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-text-secondary">{children}</div>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block text-[12px] font-medium text-text-secondary">
      {label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="mt-1.5 h-9 w-full rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary outline-none focus:border-accent"
      />
    </label>
  );
}

function TextareaField({
  label,
  value,
  onChange,
  rows,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
}) {
  return (
    <label className="block text-[12px] font-medium text-text-secondary">
      {label}
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={rows}
        className="mt-1.5 w-full resize-y rounded-input border border-line bg-surface-2 px-3 py-2.5 text-[13px] leading-relaxed text-text-primary outline-none focus:border-accent"
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="block text-[12px] font-medium text-text-secondary">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1.5 h-9 w-full rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary outline-none focus:border-accent"
      >
        {children}
      </select>
    </label>
  );
}

function ToggleField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex h-10 items-center justify-between gap-3 rounded-card border border-line bg-canvas/45 px-3 text-[12px] text-text-secondary">
      <span className="font-medium text-text-primary">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="h-4 w-4 rounded border-line bg-surface text-accent"
      />
    </label>
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read image'));
    reader.readAsDataURL(file);
  });
}


