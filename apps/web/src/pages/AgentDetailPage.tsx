/**
 * AgentDetailPage — restructured tabs (Overview / Instructions / Memory / Connections / History).
 *
 * No more playground tab. Avatar uses image fallback to initials.
 * Instructions renders files discovered from the real runtime profile and
 * project, with the Agentis overlay shown as one explicit context layer.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, MessageCircle, Save, Trash2, FileText, Upload, Sparkles, Pin, PinOff, ArrowUpFromLine, Pencil, Check, X as XIcon, Brain, PauseCircle, PlayCircle } from 'lucide-react';
import { api, apiErrorMessage } from '../lib/api';
import { openRunModal } from '../lib/runModal';
import { useToast } from '../components/shared/Toast';
import { useConfirm } from '../components/shared/ConfirmDialog';
import { Tabs } from '../components/shared/Tabs';
import { Button } from '../components/shared/Button';
import { Skeleton } from '../components/shared/Skeleton';
import { StatusBadge } from '../components/shared/StatusBadge';
import { EmptyState } from '../components/shared/EmptyState';
import { AgentConfigPanel } from '../components/agents/AgentConfigPanel';
import { AgentChannelsTab } from '../components/agents/AgentChannelsTab';
import { AgentInteractionFeed } from '../components/agents/AgentInteractionFeed';
import { rtSubscribe, useRealtime } from '../lib/realtime';
import { REALTIME_ACTIVITY_EVENTS, describeRealtimeActivity, type RealtimeActivity } from '../lib/realtimeActivity';
import { RuntimeNativePanel } from '../components/agents/RuntimeNativePanel';
import { DeleteAgentDialog } from '../components/agents/DeleteAgentDialog';
import { DomainEditorSheet, type DomainOption } from '../components/agents/DomainEditorSheet';
import { AgentAutonomyTab } from '../components/agents/AgentAutonomyTab';
import { useAgentInstallSession } from '../hooks/useBackgroundInstall';

type TabKey = 'identity' | 'instructions' | 'autonomy' | 'runtime' | 'channels' | 'history';

/** Map legacy tab values (overview / connections / interactions) onto the redesigned set. */
function normalizeTab(raw: string | null): TabKey {
  switch (raw) {
    case 'overview':
    case 'identity':
      return 'identity';
    case 'connections':
    case 'runtime':
      return 'runtime';
    // Interactions merged into History.
    case 'interactions':
    case 'history':
      return 'history';
    case 'instructions':
    case 'autonomy':
    case 'channels':
      return raw;
    default:
      return 'identity';
  }
}

interface AgentDetail {
  id: string;
  name: string;
  description?: string;
  status?: string;
  spaceId?: string;
  spaceName?: string;
  adapterType?: string;
  runtimeModel?: string | null;
  config?: Record<string, unknown> | null;
  role?: string | null;
  colorHex?: string | null;
  capabilityTags?: string[] | null;
  instructions?: string | null;
  avatarGlyph?: string | null;
  monthlyBudgetCents?: number | null;
  currentMonthSpendCents?: number | null;
  isPaused?: boolean | null;
  reportsTo?: string | null;
  adapter?: { type?: string; model?: string; config?: Record<string, unknown> };
  avatarUrl?: string | null;
  systemPrompt?: string;
  createdAt?: string;
}

interface RunHistoryEntry {
  id: string;
  workflowName?: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
}

interface AgentSummary {
  id: string;
  name: string;
  role?: string | null;
}


function initials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) return '?';
  const first = p[0] ?? '';
  if (p.length === 1) return first.slice(0, 2).toUpperCase();
  const last = p[p.length - 1] ?? '';
  return ((first[0] ?? '') + (last[0] ?? '')).toUpperCase();
}

function relativeTime(iso: string): string {
  try {
    const d = Date.now() - new Date(iso).getTime();
    if (d < 60000) return 'just now';
    if (d < 3600_000) return `${Math.floor(d / 60000)}m ago`;
    if (d < 86_400_000) return `${Math.floor(d / 3600_000)}h ago`;
    return `${Math.floor(d / 86_400_000)}d ago`;
  } catch { return ''; }
}

export function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const tab = normalizeTab(searchParams.get('tab'));
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [allAgents, setAllAgents] = useState<AgentSummary[]>([]);
  const [allSpaces, setAllSpaces] = useState<Array<{ id: string; name: string; parentDomainId?: string | null }>>([]);
  const [loading, setLoading] = useState(true);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [packMenu, setPackMenu] = useState(false);
  const installSession = useAgentInstallSession(agent?.id);

  async function togglePause() {
    if (!agent) return;
    const next = !(agent.isPaused ?? false);
    setPausing(true);
    // Optimistic: reflect immediately so the header button state doesn't lag.
    setAgent((prev) => (prev ? { ...prev, isPaused: next } : prev));
    try {
      await api(`/v1/agents/${agent.id}`, { method: 'PATCH', body: JSON.stringify({ isPaused: next }) });
      toast.success(next ? `Paused ${agent.name}` : `Resumed ${agent.name}`);
      void refresh();
    } catch (err) {
      setAgent((prev) => (prev ? { ...prev, isPaused: !next } : prev));
      toast.error(next ? 'Could not pause agent' : 'Could not resume agent', apiErrorMessage(err));
    } finally {
      setPausing(false);
    }
  }

  async function refresh() {
    if (!id) return;
    setLoading(true);
    try {
      const [agentResult, agentsResult, spacesResult] = await Promise.allSettled([
        api<{ agent: AgentDetail }>(`/v1/agents/${id}`),
        api<{ agents: AgentSummary[] }>('/v1/agents'),
        api<{ data: Array<{ id: string; name: string }> }>('/v1/domains'),
      ]);
      if (agentResult.status === 'fulfilled') setAgent(agentResult.value.agent);
      else setAgent(null);
      if (agentsResult.status === 'fulfilled') setAllAgents(agentsResult.value.agents ?? []);
      if (spacesResult.status === 'fulfilled') setAllSpaces(spacesResult.value.data ?? []);
    } catch { setAgent(null); }
    finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  function handleDelete() {
    if (!agent) return;
    setDeleteOpen(true);
  }

  async function handlePackageAgent(includeBrain: boolean) {
    if (!agent) return;
    try {
      // The pack route returns the row WRAPPED as { package: … } — reading `.id`
      // off the envelope yields undefined and exports `/packages/undefined/export`.
      const packed = await api<{ package: { id: string } }>(`/v1/packages/pack/agent/${agent.id}`, {
        method: 'POST',
        body: JSON.stringify({ includeBrain }),
      });
      const envelope = await api<Record<string, unknown>>(`/v1/packages/${packed.package.id}/export`);
      const filename = `${agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.agentisagt`;
      downloadJson(envelope, filename);
      toast.success('Agent packaged successfully', includeBrain ? `${agent.name} · with memory` : `${agent.name} · without memory`);
    } catch (e) {
      toast.error('Failed to package agent', apiErrorMessage(e));
    }
  }

  function downloadJson(value: unknown, fileName: string) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  if (loading && !agent) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton width={200} height={28} />
        <Skeleton height={120} />
        <Skeleton height={400} />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="p-8">
        <EmptyState
          icon={<FileText size={48} />}
          title="Agent not found"
          body="This agent may have been deleted or you don't have access."
          primaryAction={<Button variant="primary" size="md" onClick={() => nav('/agents')}>Back to agents</Button>}
          variant="page"
        />
      </div>
    );
  }

  const installActive = installSession?.phase === 'installing' || installSession?.phase === 'verifying';
  const displayStatus = agent.status === 'setting_up' && !installActive ? 'error' : agent.status ?? 'offline';
  const displayStatusLabel = agent.status === 'setting_up' && !installActive ? 'runtime missing' : undefined;

  if (rawTab === 'memory' || rawTab === 'knowledge') {
    const brainTab = rawTab === 'memory' ? 'memory' : 'knowledge';
    return <Navigate to={`/agents?tab=brain&agentId=${encodeURIComponent(agent.id)}&brainTab=${brainTab}`} replace />;
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-line px-6 py-4">
        <button
          onClick={() => nav('/agents')}
          className="mb-3 inline-flex items-center gap-1 text-[12px] text-text-muted hover:text-text-primary"
        >
          <ArrowLeft size={12} /> Agents
        </button>
        <div className="flex items-start gap-4">
          <div className="h-16 w-16 shrink-0 overflow-hidden rounded-full border border-line bg-surface-2">
            {agent.avatarUrl ? (
              <img src={agent.avatarUrl} alt={agent.name} className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-[20px] font-bold text-text-primary">
                {initials(agent.name)}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-display text-text-primary">{agent.name}</h1>
              <StatusBadge status={displayStatus} label={displayStatusLabel} pulse={installActive ? undefined : false} size="sm" />
            </div>
            {agent.description && (
              <p className="mt-1 text-[13px] text-text-secondary">{agent.description}</p>
            )}
            <div className="mt-2 flex flex-wrap gap-3 text-[12px] text-text-muted">
              {agent.spaceName && <span>{agent.spaceName}</span>}
              <span>{harnessLabel(agentHarnessType(agent))}{agentRuntimeModel(agent) ? ` · ${agentRuntimeModel(agent)}` : ''}</span>
              {agent.createdAt && <span>Created {relativeTime(agent.createdAt)}</span>}
            </div>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<MessageCircle size={12} />}
              onClick={() => window.dispatchEvent(new CustomEvent('agentis:chat-panel-open', {
                detail: { agentId: agent.id, name: agent.name, mode: 'fullscreen' },
              }))}
            >
              Talk
            </Button>
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<Brain size={12} />}
              onClick={() => nav(`/agents?tab=brain&agentId=${encodeURIComponent(agent.id)}`)}
              title={`Open ${agent.name}'s Brain — the memories and skills it carries`}
            >
              Brain
            </Button>
            <Button
              variant="secondary"
              size="sm"
              iconLeft={agent.isPaused ? <PlayCircle size={12} /> : <PauseCircle size={12} />}
              disabled={pausing}
              onClick={() => void togglePause()}
              title={agent.isPaused ? 'Resume this agent' : 'Pause this agent — it stops taking work until resumed'}
            >
              {agent.isPaused ? 'Resume' : 'Pause'}
            </Button>
            <div className="relative">
              <Button variant="secondary" size="sm" iconLeft={<ArrowUpFromLine size={12} />} onClick={() => setPackMenu((v) => !v)}>Package</Button>
              {packMenu ? (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setPackMenu(false)} />
                  <div className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-btn border border-line bg-surface shadow-dropdown">
                    <button
                      type="button"
                      onClick={() => { setPackMenu(false); void handlePackageAgent(true); }}
                      className="block w-full px-3 py-2 text-left text-[12px] text-text-secondary hover:bg-surface-2"
                    >
                      <div className="font-medium text-text-primary">Package with memory</div>
                      <div className="text-[11px] text-text-muted">Carries the agent&apos;s learned Brain.</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => { setPackMenu(false); void handlePackageAgent(false); }}
                      className="block w-full border-t border-line px-3 py-2 text-left text-[12px] text-text-secondary hover:bg-surface-2"
                    >
                      <div className="font-medium text-text-primary">Package without memory</div>
                      <div className="text-[11px] text-text-muted">Definition only — a blank-slate agent.</div>
                    </button>
                  </div>
                </>
              ) : null}
            </div>
            <Button variant="danger" size="sm" iconLeft={<Trash2 size={12} />} onClick={() => void handleDelete()}>Delete</Button>
          </div>
        </div>
      </div>

      <Tabs
        param="tab"
        value={tab}
        defaultValue="identity"
        tabs={[
          { value: 'identity',     label: 'Identity' },
          { value: 'instructions', label: 'Instructions' },
          { value: 'autonomy',     label: 'Autonomy' },
          { value: 'runtime',      label: 'Runtime' },
          { value: 'channels',     label: 'Channels' },
          { value: 'history',      label: 'History' },
        ]}
        className="px-6"
      />

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {tab === 'identity' && <IdentityTab agent={agent} allAgents={allAgents} allSpaces={allSpaces} onChange={refresh} />}
        {tab === 'instructions' && <RuntimeNativePanel agentId={agent.id} mode="resources" />}
        {tab === 'autonomy' && <AgentAutonomyTab agent={agent} />}
        {tab === 'runtime' && <RuntimeTab agent={agent} allAgents={allAgents} onChange={refresh} />}
        {tab === 'channels' && <AgentChannelsTab agentId={agent.id} agentName={agent.name} />}
        {tab === 'history' && <HistoryTab agent={agent} />}
      </div>
      {deleteOpen && (
        <DeleteAgentDialog
          agent={{ id: agent.id, name: agent.name }}
          allAgents={allAgents.map((a) => ({ id: a.id, name: a.name }))}
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => { setDeleteOpen(false); toast.success(`Deleted ${agent.name}`); nav('/agents'); }}
        />
      )}
    </div>
  );
}

const ROLE_OPTIONS = [
  { value: 'orchestrator', label: 'Orchestrator' },
  { value: 'manager', label: 'Manager' },
  { value: 'worker', label: 'Specialist' },
] as const;

const IDENTITY_INPUT_CLS =
  'w-full rounded-input border border-line bg-surface-2 px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none';

/**
 * Identity tab — who the agent is: name, role, avatar, description, and the
 * chain-of-command placement (AGENTS-PAGE-REDESIGN.md §3.2). Technical harness
 * and model fields live in the Runtime tab.
 */
function IdentityTab({
  agent,
  allAgents,
  allSpaces,
  onChange,
}: {
  agent: AgentDetail;
  allAgents: AgentSummary[];
  allSpaces: Array<{ id: string; name: string; parentDomainId?: string | null }>;
  onChange: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState(agent.role ?? 'worker');
  const [description, setDescription] = useState(agent.description ?? '');
  const [reportsTo, setReportsTo] = useState(agent.reportsTo ?? '');
  const [spaceId, setSpaceId] = useState(agent.spaceId ?? '');
  const [spaces, setSpaces] = useState<DomainOption[]>(() => allSpaces.map((space) => ({ id: space.id, name: space.name, parentDomainId: space.parentDomainId ?? null })));
  const [avatarUrl, setAvatarUrl] = useState(agent.avatarUrl ?? '');
  const [domainEditorOpen, setDomainEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const managers = useMemo(
    () => allAgents
      .filter((candidate) => candidate.id !== agent.id && candidate.role === 'manager')
      .map((candidate) => ({ id: candidate.id, name: candidate.name, role: candidate.role ?? null })),
    [agent.id, allAgents],
  );

  useEffect(() => {
    setName(agent.name);
    setRole(agent.role ?? 'worker');
    setDescription(agent.description ?? '');
    setReportsTo(agent.reportsTo ?? '');
    setSpaceId(agent.spaceId ?? '');
    setAvatarUrl(agent.avatarUrl ?? '');
  }, [agent]);

  useEffect(() => {
    setSpaces(allSpaces.map((space) => ({ id: space.id, name: space.name, parentDomainId: space.parentDomainId ?? null })));
  }, [allSpaces]);

  function handleAvatarInput(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Unsupported image', 'Use PNG, JPG, or WEBP.');
      return;
    }
    if (file.size > 2_500_000) {
      toast.error('Image too large', 'Use an image up to 2.5MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => setAvatarUrl(String(event.target?.result ?? ''));
    reader.readAsDataURL(file);
  }

  function handleSpaceChange(value: string) {
    if (value === '__create__') {
      setDomainEditorOpen(true);
      return;
    }
    setSpaceId(value);
  }

  const needsSupervisor = role === 'manager' || role === 'worker';
  const dirty =
    name.trim() !== agent.name ||
    role !== (agent.role ?? 'worker') ||
    description !== (agent.description ?? '') ||
    (needsSupervisor ? reportsTo : '') !== (agent.reportsTo ?? '') ||
    (needsSupervisor ? spaceId : '') !== (agent.spaceId ?? '') ||
    avatarUrl !== (agent.avatarUrl ?? '');

  async function save() {
    if (!name.trim()) {
      toast.error('Name is required');
      return;
    }
    setSaving(true);
    try {
      const currentOrchestrator = allAgents.find((candidate) => candidate.id !== agent.id && candidate.role === 'orchestrator');
      const replaceExistingOrchestrator = role === 'orchestrator' && Boolean(currentOrchestrator);
      if (replaceExistingOrchestrator && currentOrchestrator) {
        const ok = await confirm({
          title: `Make ${agent.name} the orchestrator?`,
          body: `${currentOrchestrator.name} is the current workspace orchestrator. This will demote ${currentOrchestrator.name} to manager and route managers to ${agent.name}.`,
          confirmLabel: 'Make orchestrator',
          tone: 'warn',
        });
        if (!ok) return;
      }
      await api(`/v1/agents/${agent.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim(),
          role,
          description: description.trim() || null,
          reportsTo: needsSupervisor ? reportsTo || null : null,
          spaceId: needsSupervisor ? spaceId || null : null,
          avatarUrl: avatarUrl || null,
          ...(replaceExistingOrchestrator ? { replaceExistingOrchestrator: true } : {}),
        }),
      });
      toast.success('Identity saved');
      onChange();
    } catch (err) {
      toast.error('Could not save identity', String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-xl space-y-5">
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-full border border-line bg-surface-2"
          aria-label="Upload avatar image"
        >
          {avatarUrl ? (
            <img src={avatarUrl} alt={agent.name} className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-[20px] font-bold text-text-primary">
              {agent.avatarGlyph || initials(agent.name)}
            </span>
          )}
          <span className="absolute inset-0 hidden items-center justify-center bg-black/55 text-white group-hover:flex">
            <Upload size={14} />
          </span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(event) => {
            handleAvatarInput(event.target.files?.[0]);
            event.target.value = '';
          }}
          className="hidden"
        />
        <div className="text-[12px] text-text-muted">
          {avatarUrl ? (
            <button type="button" onClick={() => setAvatarUrl('')} className="text-text-secondary hover:text-text-primary">
              Remove image
            </button>
          ) : (
            'Upload an avatar image (optional).'
          )}
        </div>
      </div>

      <IdentityField label="Name">
        <input value={name} onChange={(event) => setName(event.target.value)} className={IDENTITY_INPUT_CLS} />
      </IdentityField>

      <IdentityField label="Role">
        <div className="flex flex-wrap gap-2">
          {ROLE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setRole(option.value)}
              className={
                'rounded-btn border px-3 py-1.5 text-[13px] font-medium transition-colors ' +
                (role === option.value
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-line bg-surface-2 text-text-secondary hover:border-line-strong hover:text-text-primary')
              }
            >
              {option.label}
            </button>
          ))}
        </div>
      </IdentityField>

      <IdentityField label="Description" hint="Optional">
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={3}
          className={IDENTITY_INPUT_CLS + ' resize-none'}
          placeholder="What this agent is responsible for."
        />
      </IdentityField>

      {needsSupervisor && (
        <>
          <IdentityField label="Reports to">
            <select value={reportsTo} onChange={(event) => setReportsTo(event.target.value)} className={IDENTITY_INPUT_CLS}>
              <option value="">No supervisor</option>
              {allAgents
                .filter((candidate) => candidate.id !== agent.id)
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
                ))}
            </select>
          </IdentityField>
          <IdentityField label="Domain">
            <select value={spaceId} onChange={(event) => handleSpaceChange(event.target.value)} className={IDENTITY_INPUT_CLS}>
              <option value="">No domain</option>
              {spaces.map((space) => {
                const parent = space.parentDomainId ? spaces.find((d) => d.id === space.parentDomainId) : null;
                return <option key={space.id} value={space.id}>{parent ? `${parent.name} › ${space.name}` : space.name}</option>;
              })}
              <option value="__create__">Create new domain...</option>
            </select>
          </IdentityField>
        </>
      )}

      <Button variant="primary" size="md" iconLeft={<Save size={13} />} disabled={saving || !dirty} onClick={() => void save()}>
        {saving ? 'Saving…' : 'Save identity'}
      </Button>
      <DomainEditorSheet
        open={domainEditorOpen}
        managers={managers}
        onClose={() => setDomainEditorOpen(false)}
        onSaved={(domain) => {
          if (!domain) return;
          setSpaces((current) => [...current.filter((item) => item.id !== domain.id), domain].sort((a, b) => a.name.localeCompare(b.name)));
          setSpaceId(domain.id);
          onChange();
        }}
      />
    </div>
  );
}

function IdentityField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        {label}
        {hint && <span className="font-normal normal-case tracking-normal text-text-muted">· {hint}</span>}
      </span>
      {children}
    </label>
  );
}

/**
 * Runtime tab — how the agent connects to a harness, its model, capability
 * tags, budget, and supervisor (AGENTS-PAGE-REDESIGN.md §3.4).
 */
function RuntimeTab({ agent, allAgents, onChange }: { agent: AgentDetail; allAgents: AgentSummary[]; onChange: () => void }) {
  return (
    <div className="space-y-6">
      <RuntimeNativePanel agentId={agent.id} onRuntimeChanged={onChange} />
      <div className="rounded-card border border-line bg-surface p-5">
        <div className="mb-4">
          <h2 className="text-heading text-text-primary">Agentis runtime policy</h2>
          <p className="mt-1 text-[12px] text-text-secondary">
            Configure the Agentis-side model, budget, capabilities, and connection policy.
          </p>
        </div>
        <AgentConfigPanel
          agent={{
            id: agent.id,
            name: agent.name,
            adapterType: agentHarnessType(agent),
            runtimeModel: agentRuntimeModel(agent),
            role: agent.role ?? null,
            status: agent.status ?? 'offline',
            colorHex: agent.colorHex ?? null,
            capabilityTags: agent.capabilityTags ?? null,
            instructions: agent.instructions ?? agent.systemPrompt ?? null,
            avatarGlyph: agent.avatarGlyph ?? null,
            isPaused: agent.isPaused ?? null,
            monthlyBudgetCents: agent.monthlyBudgetCents ?? null,
            currentMonthSpendCents: agent.currentMonthSpendCents ?? null,
            config: agent.config ?? agent.adapter?.config ?? null,
            reportsTo: agent.reportsTo ?? null,
          }}
          allAgents={allAgents}
          onSaved={onChange}
        />
      </div>
    </div>
  );
}

function agentHarnessType(agent: AgentDetail) {
  return agent.adapterType ?? agent.adapter?.type ?? 'http';
}

function agentRuntimeModel(agent: AgentDetail) {
  return agent.runtimeModel ?? agent.adapter?.model ?? null;
}

function harnessLabel(adapterType: string) {
  switch (adapterType) {
    case 'openclaw': return 'OpenClaw';
    case 'hermes_agent': return 'Hermes Agent';
    case 'claude_code': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'cursor': return 'Cursor';
    case 'antigravity': return 'Antigravity CLI';
    case 'http': return 'HTTP / Webhook';
    default: return 'Harness';
  }
}

function HistoryTab({ agent }: { agent: AgentDetail }) {
  const [runs, setRuns] = useState<RunHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api<{ runs: RunHistoryEntry[] }>(`/v1/agents/${agent.id}/runs?limit=20`);
        if (!cancelled) setRuns(data.runs ?? []);
      } catch { if (!cancelled) setRuns([]); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [agent.id]);

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className="text-subheading text-text-primary">Runs</h3>
        {loading ? (
          <Skeleton height={160} />
        ) : runs.length === 0 ? (
          <p className="text-[13px] text-text-muted">No runs yet. Workflow runs for this agent will appear here.</p>
        ) : (
          <div className="space-y-1">
            {runs.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => openRunModal({ runId: r.id, source: 'agent-history' })}
                className="flex w-full items-center gap-3 rounded-md border border-line bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-2"
              >
                <StatusBadge status={r.status} size="sm" />
                <span className="flex-1 truncate text-[13px] text-text-primary">{r.workflowName ?? 'Workflow run'}</span>
                <span className="text-[11px] text-text-muted">{relativeTime(r.startedAt)}</span>
              </button>
            ))}
          </div>
        )}
      </section>
      {/* Live "watch this agent think" — its reasoning/tool stream across every run. */}
      <AgentLiveThinking agentId={agent.id} />
      {/* Agent↔agent interactions merged into History (former Interactions tab). */}
      <AgentInteractionFeed agentId={agent.id} />
    </div>
  );
}

/**
 * Live reasoning feed for one agent — subscribes to the agent's realtime room and
 * streams its thinking / tool activity across all its runs, so clicking an agent
 * shows what it is doing right now (not just a static run list). Renders nothing
 * until there's activity. Mirrors the canvas node feed, keyed to the agent room.
 */
function AgentLiveThinking({ agentId }: { agentId: string }) {
  const [feed, setFeed] = useState<RealtimeActivity[]>([]);
  const seqRef = useRef(0);

  useEffect(() => rtSubscribe('agent', { agentId }), [agentId]);

  useRealtime([...REALTIME_ACTIVITY_EVENTS], (env) => {
    const activity = describeRealtimeActivity(env);
    if (!activity || activity.agentId !== agentId) return;
    seqRef.current += 1;
    setFeed((current) => {
      // Collapse a copy that arrives from more than one joined room.
      if (current.slice(0, 12).some((c) => c.id.replace(/:\d+$/, '') === activity.id)) return current;
      return [{ ...activity, id: `${activity.id}:${seqRef.current}` }, ...current].slice(0, 50);
    });
  });

  if (feed.length === 0) return null;

  return (
    <section className="mt-4 rounded-md border border-accent/25 bg-accent-soft/5 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent">Live thinking</span>
      </div>
      <div className="mt-2 space-y-1.5">
        {feed.map((item) => (
          <div key={item.id} className="flex items-start gap-2">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent/70" />
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-text-secondary">
              {item.tool ? <span className="text-text-muted">{item.tool}: </span> : null}{item.detail || item.title}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ────────────────────────────────────────────────────────────
// Memory tab — the agent's personal Brain (§G11)
// ────────────────────────────────────────────────────────────

interface AgentMemoryRow {
  id: string;
  section: string;
  content: string;
  tags: string[];
  createdAt: string;
}

/**
 * The agent's own memory: findings and decisions it has accumulated across every
 * workflow and chat it has run — separate from the shared workspace memory log.
 */
function MemoryTab({ agent }: { agent: AgentDetail }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [entries, setEntries] = useState<AgentMemoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api<{ entries: AgentMemoryRow[] }>(`/v1/brain/agents/${agent.id}/memory`);
        if (!cancelled) setEntries(data.entries ?? []);
      } catch { if (!cancelled) setEntries([]); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [agent.id]);

  async function clearAll() {
    const ok = await confirm({
      title: 'Clear agent memory',
      body: `Permanently delete everything ${agent.name} has remembered? This cannot be undone.`,
      confirmLabel: 'Clear memory',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api(`/v1/brain/agents/${agent.id}/memory`, { method: 'DELETE' });
      toast.success('Agent memory cleared');
      setEntries([]);
    } catch (err) {
      toast.error('Failed to clear memory', err instanceof Error ? err.message : undefined);
    }
  }

  async function removeOne(id: string) {
    try {
      await api(`/v1/brain/agents/${agent.id}/memory/${id}`, { method: 'DELETE' });
      setEntries((prev) => prev.filter((e) => e.id !== id));
      setSelected((prev) => { const next = new Set(prev); next.delete(id); return next; });
    } catch (err) {
      toast.error('Failed to delete entry', err instanceof Error ? err.message : undefined);
    }
  }

  async function deleteSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    const ok = await confirm({
      title: `Delete ${ids.length} ${ids.length === 1 ? 'memory' : 'memories'}?`,
      body: 'This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    const results = await Promise.allSettled(
      ids.map((id) => api(`/v1/brain/agents/${agent.id}/memory/${id}`, { method: 'DELETE' })),
    );
    const deleted = new Set(ids.filter((_, i) => results[i]?.status === 'fulfilled'));
    setEntries((prev) => prev.filter((e) => !deleted.has(e.id)));
    setSelected(new Set());
    if (deleted.size < ids.length) toast.error('Some memories could not be deleted');
    else toast.success(`Deleted ${deleted.size} ${deleted.size === 1 ? 'memory' : 'memories'}`);
  }

  async function saveEdit(id: string) {
    const content = editDraft.trim();
    if (!content) return;
    try {
      await api(`/v1/brain/atoms/memory/${id}`, { method: 'PATCH', body: JSON.stringify({ content }) });
      setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, content } : e)));
      setEditingId(null);
      toast.success('Memory updated');
    } catch (err) {
      toast.error('Failed to update memory', err instanceof Error ? err.message : undefined);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  if (loading) return <Skeleton height={300} />;

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<FileText size={48} />}
        title="No memories yet"
        body={`As ${agent.name} runs tasks, the findings and decisions it chooses to remember will accumulate here — its personal expertise, separate from the shared workspace memory.`}
      />
    );
  }

  const bySection = new Map<string, AgentMemoryRow[]>();
  for (const e of entries) {
    const list = bySection.get(e.section) ?? [];
    list.push(e);
    bySection.set(e.section, list);
  }

  const allSelected = entries.length > 0 && selected.size === entries.length;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-[12px] text-text-muted">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => setSelected(allSelected ? new Set() : new Set(entries.map((e) => e.id)))}
            className="h-3.5 w-3.5 rounded border-line bg-surface text-accent"
          />
          {selected.size > 0
            ? `${selected.size} selected`
            : `${entries.length} ${entries.length === 1 ? 'memory' : 'memories'} this agent carries across every workflow it runs.`}
        </label>
        {selected.size > 0 ? (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" iconLeft={<Trash2 size={12} />} onClick={deleteSelected}>Delete selected</Button>
            <button type="button" onClick={() => setSelected(new Set())} className="text-[12px] text-text-muted hover:text-text-primary">Clear</button>
          </div>
        ) : (
          <Button variant="ghost" size="sm" iconLeft={<Trash2 size={12} />} onClick={clearAll}>Clear all</Button>
        )}
      </div>
      {[...bySection.entries()].map(([section, rows]) => (
        <section key={section}>
          <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-text-muted">{section}</h3>
          <div className="space-y-1.5">
            {rows.map((e) => (
              <div key={e.id} className={`group flex items-start gap-3 rounded-md border border-line bg-surface px-4 py-2.5 ${selected.has(e.id) ? 'ring-1 ring-accent/40' : ''}`}>
                <input
                  type="checkbox"
                  checked={selected.has(e.id)}
                  onChange={() => toggle(e.id)}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-line bg-surface text-accent"
                  aria-label="Select memory"
                />
                {editingId === e.id ? (
                  <div className="flex-1 space-y-1.5">
                    <textarea
                      value={editDraft}
                      onChange={(ev) => setEditDraft(ev.target.value)}
                      rows={3}
                      autoFocus
                      className="w-full resize-y rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[13px] leading-snug text-text-primary outline-none focus:border-accent"
                    />
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => void saveEdit(e.id)} className="inline-flex items-center gap-1 rounded-btn bg-accent px-2 py-1 text-[11px] font-medium text-on-accent hover:bg-accent-hover"><Check size={12} /> Save</button>
                      <button type="button" onClick={() => setEditingId(null)} className="inline-flex items-center gap-1 rounded-btn px-2 py-1 text-[11px] text-text-muted hover:bg-surface-2"><XIcon size={12} /> Cancel</button>
                    </div>
                  </div>
                ) : (
                  <span className="flex-1 whitespace-pre-wrap break-words text-[13px] leading-snug text-text-primary">{e.content}</span>
                )}
                <span className="shrink-0 text-[11px] text-text-muted">{relativeTime(e.createdAt)}</span>
                {editingId === e.id ? null : (
                  <>
                    <button
                      type="button"
                      onClick={() => { setEditingId(e.id); setEditDraft(e.content); }}
                      className="shrink-0 text-text-muted opacity-0 transition-opacity hover:text-text-primary group-hover:opacity-100"
                      aria-label="Edit memory"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeOne(e.id)}
                      className="shrink-0 text-text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                      aria-label="Delete memory"
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}




