import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Loader2, Upload, X } from 'lucide-react';
import clsx from 'clsx';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';
import {
  DEFAULT_RUNTIME_CONFIG,
  RuntimePicker,
  runtimeConfigToAdapterConfig,
  runtimeModelFor,
  type AdapterType,
  type HarnessDetectionResult,
  type RuntimeConfig,
} from './RuntimePicker';
import { PlaybookLibrary, type PlaybookEntry } from './PlaybookLibrary';
import { ManagerGlyph, OrchestratorGlyph, WorkerGlyph } from './AgentRoleGlyphs';
import { DomainEditorSheet, type DomainOption } from './DomainEditorSheet';
type AgentRole = 'orchestrator' | 'manager' | 'worker';
type ChannelKind = 'telegram' | 'discord' | 'slack' | 'whatsapp';
type GlyphComponent = (props: { size?: number }) => JSX.Element;

interface ExistingAgent {
  id: string;
  name: string;
  role?: AgentRole | null;
  spaceId?: string | null;
}

interface PlaybookResponse {
  entries: PlaybookEntry[];
}

interface DetectResponse {
  adapters?: HarnessDetectionResult[];
  harnesses?: HarnessDetectionResult[];
}

interface HarnessCheck {
  code?: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  detail?: string;
  hint?: string;
}

interface HarnessTestResult {
  status: 'pass' | 'warn' | 'fail';
  checks: HarnessCheck[];
}

interface ChannelDraft {
  kind: ChannelKind;
  open: boolean;
  token: string;
  defaultChatId: string;
  signingSecret?: string;
  phoneNumberId?: string;
  appSecret?: string;
  verifyToken?: string;
}

interface AgentCreateWizardProps {
  open: boolean;
  onClose: () => void;
  onCreated: (agent: { id: string; name: string; role?: string }) => void;
  initialRole?: AgentRole | null;
  initialSpaceId?: string | null;
  /** Preset manager a created specialist reports to (e.g. when owning a subdomain). */
  initialReportsTo?: string | null;
  lockInitialRole?: boolean;
  flipFrom?: unknown;
  heading?: string;
  intro?: string;
}

const ADAPTER_PRIORITY: AdapterType[] = ['claude_code', 'codex', 'cursor', 'antigravity', 'hermes_agent', 'openclaw'];

const EMPTY_DETECTIONS: HarnessDetectionResult[] = [];
const EMPTY_PLAYBOOKS: PlaybookEntry[] = [];
const DEFAULT_CHANNELS: Record<ChannelKind, ChannelDraft> = {
  telegram: { kind: 'telegram', open: false, token: '', defaultChatId: '' },
  discord: { kind: 'discord', open: false, token: '', defaultChatId: '' },
  slack: { kind: 'slack', open: false, token: '', defaultChatId: '', signingSecret: '' },
  whatsapp: { kind: 'whatsapp', open: false, token: '', defaultChatId: '', phoneNumberId: '', appSecret: '', verifyToken: '' },
};

const ROLE_COLOR: Record<AgentRole, string> = {
  orchestrator: '#8b5cf6',
  manager: '#06b6d4',
  worker: '#60a5fa',
};

const ROLE_OPTIONS: Array<{
  value: AgentRole;
  title: string;
  subtitle: string;
  icon: GlyphComponent;
}> = [
  {
    value: 'orchestrator',
    title: 'Orchestrator',
    subtitle: 'The workspace orchestrator. Routes goals and managers.',
    icon: OrchestratorGlyph,
  },
  {
    value: 'manager',
    title: 'Manager',
    subtitle: 'Owns a domain. Coordinates execution under the orchestrator.',
    icon: ManagerGlyph,
  },
  {
    value: 'worker',
    title: 'Specialist',
    subtitle: 'An expert operator that executes tasks in workflows or for a manager.',
    icon: WorkerGlyph,
  },
];

function initials(name: string): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0] ?? '';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? '';
  return ((first[0] ?? '') + (last[0] ?? '')).toUpperCase();
}

function defaultNameForRole(role: AgentRole): string {
  if (role === 'orchestrator') return 'The Brain';
  if (role === 'manager') return 'Department Manager';
  return 'Specialist';
}

function roleSummary(role: AgentRole): string {
  if (role === 'orchestrator') return 'Workspace orchestrator';
  if (role === 'manager') return 'Manager';
  return 'Specialist';
}

function renderTemplate(markdown: string, name: string): string {
  return markdown.replaceAll('{{name}}', name || 'The Brain');
}

function playbookRoles(entry: PlaybookEntry): AgentRole[] | undefined {
  if (!('roles' in entry)) return undefined;
  return (entry as PlaybookEntry & { roles?: AgentRole[] }).roles;
}

function filterPlaybooks(entries: PlaybookEntry[], role: AgentRole): PlaybookEntry[] {
  const filtered = entries.filter((entry) => {
    const roles = playbookRoles(entry);
    return !roles || roles.includes(role);
  });
  return filtered.length > 0 ? filtered : entries;
}

function cloneChannels(): Record<ChannelKind, ChannelDraft> {
  return {
    telegram: { ...DEFAULT_CHANNELS.telegram },
    discord: { ...DEFAULT_CHANNELS.discord },
    slack: { ...DEFAULT_CHANNELS.slack },
    whatsapp: { ...DEFAULT_CHANNELS.whatsapp },
  };
}

function labelForSupervisor(agents: ExistingAgent[], id: string): string {
  return agents.find((agent) => agent.id === id)?.name ?? 'Unassigned';
}

function inboxSummary(channels: Record<ChannelKind, ChannelDraft>): string {
  const active = Object.values(channels)
    .filter((channel) => channel.token.trim())
    .map((channel) => channel.kind);

  if (active.length === 0) return 'None';
  return active.join(', ');
}

function budgetToCents(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

export function AgentCreateWizard({
  open,
  onClose,
  onCreated,
  initialRole,
  initialSpaceId,
  initialReportsTo,
  lockInitialRole = false,
  flipFrom,
  heading,
  intro,
}: AgentCreateWizardProps) {
  const toast = useToast();
  const seededRoleRef = useRef<AgentRole | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [spaceId, setSpaceId] = useState('');
  const [spaces, setSpaces] = useState<DomainOption[]>([]);
  const [domainEditorOpen, setDomainEditorOpen] = useState(false);
  const [role, setRole] = useState<AgentRole>(initialRole ?? 'manager');
  const [reportsTo, setReportsTo] = useState('');
  const [agents, setAgents] = useState<ExistingAgent[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  // First-agent on-ramp: when the workspace is empty, hide the org-chart vocabulary
  // full role/hierarchy controls with "Set up a team structure".
  const [showHierarchy, setShowHierarchy] = useState(false);
  const [detections, setDetections] = useState<HarnessDetectionResult[]>(EMPTY_DETECTIONS);
  const [detecting, setDetecting] = useState(false);
  const [playbookEntries, setPlaybookEntries] = useState<PlaybookEntry[]>(EMPTY_PLAYBOOKS);
  const [adapterType, setAdapterType] = useState<AdapterType>('claude_code');
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig>(DEFAULT_RUNTIME_CONFIG);
  // opens this to override. Stays collapsed unless they ask, or nothing was detected.
  const [playbook, setPlaybook] = useState('');
  const [capabilityTags, setCapabilityTags] = useState<string[]>([]);
  const [monthlyBudget, setMonthlyBudget] = useState('100');
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(null);
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [channels, setChannels] = useState<Record<ChannelKind, ChannelDraft>>(cloneChannels());
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<HarnessTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const avatarFileRef = useRef<HTMLInputElement>(null);

  // True while we're commissioning the very first agent of an empty workspace and
  const firstAgentOnRamp = agentsLoaded && agents.length === 0 && !initialRole && !lockInitialRole && !showHierarchy;
  const orchestrator = useMemo(() => agents.find((agent) => agent.role === 'orchestrator') ?? null, [agents]);
  const managers = useMemo(() => agents.filter((agent) => agent.role === 'manager'), [agents]);
  const detectionsByType = useMemo(() => new Map(detections.map((detection) => [detection.adapterType, detection])), [detections]);
  const activeDetection = detectionsByType.get(adapterType);
  const visiblePlaybooks = useMemo(() => filterPlaybooks(playbookEntries, role), [playbookEntries, role]);
  const supervisorOptions = useMemo(() => {
    if (role === 'manager') return orchestrator ? [orchestrator] : [];
    if (role === 'worker') return [...managers, ...(orchestrator ? [orchestrator] : [])];
    return [] as ExistingAgent[];
  }, [managers, orchestrator, role]);
  // For a specialist, an inline new domain is a Subdomain under its manager's domain.
  const managerDomainId = useMemo(() => {
    if (role !== 'worker' || !reportsTo) return null;
    const supervisor = agents.find((agent) => agent.id === reportsTo);
    const sid = supervisor?.spaceId ?? null;
    // Only nest under a top-level domain (not a subdomain).
    return sid && !spaces.find((s) => s.id === sid)?.parentDomainId ? sid : null;
  }, [agents, reportsTo, role, spaces]);
  const specialistOwnerOptions = useMemo(
    () => agents.filter((a) => a.role && a.role !== 'orchestrator' && a.role !== 'manager').map((a) => ({ id: a.id, name: a.name, role: a.role ?? null })),
    [agents],
  );

  useEffect(() => {
    if (!open) return;

    const nextRole = initialRole ?? 'manager';
    setName(nextRole === 'orchestrator' ? 'The Brain' : '');
    setDescription('');
    setSpaceId(nextRole === 'orchestrator' ? '' : initialSpaceId ?? '');
    setRole(nextRole);
    setReportsTo(nextRole === 'orchestrator' ? '' : initialReportsTo ?? '');
    setDetections(EMPTY_DETECTIONS);
    setDetecting(true);
    setPlaybookEntries(EMPTY_PLAYBOOKS);
    setAdapterType('claude_code');
    setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
    setPlaybook('');
    setCapabilityTags([]);
    setMonthlyBudget('100');
    setAvatarDataUrl(null);
    setChannelsOpen(false);
    setChannels(cloneChannels());
    setTesting(false);
    setTestResult(null);
    setTestError(null);
    setAgentsLoaded(false);
    setShowHierarchy(false);
    seededRoleRef.current = null;

    void Promise.allSettled([
      api<{ agents: ExistingAgent[] }>('/v1/agents'),
      api<DetectResponse>('/v1/harness/detect'),
      api<PlaybookResponse>('/v1/agents/playbook-library'),
      api<{ data: DomainOption[] }>('/v1/domains'),
    ]).then(([agentsResult, detectResult, playbookResult, spacesResult]) => {
      const loadedAgents = agentsResult.status === 'fulfilled' ? agentsResult.value.agents ?? [] : [];
      setAgents(loadedAgents);
      setAgentsLoaded(true);
      // Empty workspace + no preset role → first-agent mode: default to orchestrator
      // ("the agent you talk to") and keep the hierarchy controls tucked away.
      if (loadedAgents.length === 0 && !initialRole && !lockInitialRole) {
        setRole('orchestrator');
        setName((current) => current.trim() || 'The Brain');
      }
      setSpaces(spacesResult.status === 'fulfilled' ? spacesResult.value.data ?? [] : []);
      const existingOrchestrator = loadedAgents.find((agent) => agent.role === 'orchestrator');
      if (nextRole === 'manager' && existingOrchestrator && !initialReportsTo) {
        setReportsTo(existingOrchestrator.id);
      }

      const loadedDetections = detectResult.status === 'fulfilled'
        ? detectResult.value.adapters ?? detectResult.value.harnesses ?? []
        : [];
      setDetections(loadedDetections);

      // ("found") harness in priority order; otherwise leave the default and
      // let the operator choose. Skip any harness flagged `needsConfig`: it is
      // installed but missing required config, so auto-selecting it creates an
      // agent that immediately fails its runtime probe (e.g. openclaw is "found"
      // whenever its binary is on PATH, but the adapter requires a gatewayUrl).
      const found = ADAPTER_PRIORITY.find((type) =>
        loadedDetections.some((d) => d.adapterType === type && d.status === 'found' && !d.needsConfig),
      );
      if (found) {
        setAdapterType(found);
      }

      setDetecting(false);
      setPlaybookEntries(playbookResult.status === 'fulfilled' ? playbookResult.value.entries ?? [] : []);
    });
  }, [initialRole, initialReportsTo, initialSpaceId, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (role === 'orchestrator') {
      setReportsTo('');
      setSpaceId('');
      return;
    }

    if (reportsTo) return;
    if (role === 'manager' && orchestrator) {
      setReportsTo(orchestrator.id);
      return;
    }
    if (role === 'worker') {
      const workerSupervisor = managers[0] ?? orchestrator;
      if (workerSupervisor) setReportsTo(workerSupervisor.id);
    }
  }, [managers, orchestrator, reportsTo, role]);

  useEffect(() => {
    if (!open || role !== 'worker' || spaceId) return;
    const supervisor = agents.find((agent) => agent.id === reportsTo);
    if (supervisor?.spaceId) setSpaceId(supervisor.spaceId);
  }, [agents, open, reportsTo, role, spaceId]);

  useEffect(() => {
    if (!open || visiblePlaybooks.length === 0) return;
    if (seededRoleRef.current === role && playbook.trim()) return;
    const preferred = visiblePlaybooks[0];
    if (!preferred) return;
    setPlaybook(renderTemplate(preferred.markdown, name.trim() || defaultNameForRole(role)));
    setCapabilityTags(preferred.suggestedTags ?? []);
    seededRoleRef.current = role;
  }, [name, open, playbook, role, visiblePlaybooks]);

  if (!open) return null;

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
    reader.onload = (event) => setAvatarDataUrl(event.target?.result as string);
    reader.readAsDataURL(file);
  }

  async function refreshDetections() {
    setDetecting(true);
    try {
      const response = await api<DetectResponse>('/v1/harness/detect');
      setDetections(response.adapters ?? response.harnesses ?? []);
    } catch {
      setDetections([]);
    } finally {
      setDetecting(false);
    }
  }

  function updateChannel(kind: ChannelKind, patch: Partial<ChannelDraft>) {
    setChannels((current) => ({
      ...current,
      [kind]: { ...current[kind], ...patch },
    }));
  }

  function pickTemplate(entry: PlaybookEntry) {
    setPlaybook(renderTemplate(entry.markdown, name.trim() || defaultNameForRole(role)));
    setCapabilityTags(entry.suggestedTags ?? []);
    seededRoleRef.current = role;
  }

  const functionalRole = role === 'worker' ? 'specialist' : role;

  async function handleCreate() {
    if (!name.trim()) return;

    setCreating(true);
    try {
      const runtimeUnavailable = activeDetection?.status !== 'found';
      const adapterConfig = runtimeConfigToAdapterConfig(adapterType, runtimeConfig);
      const runtimeModel = runtimeModelFor(adapterType, runtimeConfig);

      const created = await api<{ agent: { id: string; name: string } }>('/v1/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          role: functionalRole,
          reportsTo: reportsTo || undefined,
          spaceId: spaceId || undefined,
          avatarGlyph: initials(name.trim()),
          avatarUrl: avatarDataUrl || undefined,
          colorHex: ROLE_COLOR[role],
          adapterType,
          runtimeModel,
          capabilityTags,
          instructions: playbook,
          monthlyBudgetCents: budgetToCents(monthlyBudget) ?? undefined,
          config: adapterConfig,
        }),
      });

      const channelErrors: string[] = [];
      if (role === 'orchestrator') {
        for (const channel of Object.values(channels)) {
          if (!channel.token.trim()) continue;
          try {
            const isWhatsAppCloud = channel.kind === 'whatsapp';
            await api('/v1/channels', {
              method: 'POST',
              body: JSON.stringify({
                kind: channel.kind,
                name: `${name.trim()} ${channel.kind}`,
                agentId: created.agent.id,
                token: channel.token.trim(),
                defaultChatId: channel.defaultChatId.trim() || undefined,
                ...(channel.kind === 'slack' && channel.signingSecret?.trim() ? { signingSecret: channel.signingSecret.trim() } : {}),
                ...(isWhatsAppCloud
                  ? {
                      mode: 'cloud',
                      defaultRecipient: channel.defaultChatId.trim() || undefined,
                      phoneNumberId: channel.phoneNumberId?.trim() || undefined,
                      appSecret: channel.appSecret?.trim() || undefined,
                      verifyToken: channel.verifyToken?.trim() || undefined,
                    }
                  : {}),
              }),
            });
          } catch (channelError) {
            channelErrors.push(`${channel.kind}: ${apiErrorMessage(channelError)}`);
          }
        }
      }

      if (runtimeUnavailable) {
        toast.success(
          'Agent commissioned - runtime missing',
          `${name.trim()} was created. Connect or install ${activeDetection?.harness ?? adapterType} from Runtime settings.`,
        );
      } else {
        toast.success('Agent commissioned', name.trim());
      }

      if (channelErrors.length > 0) {
        toast.error('Some inbox channels were not saved', channelErrors.join(' | '));
      }

      onCreated({ ...created.agent, role: functionalRole });
    } catch (error) {
      toast.error('Could not commission agent', apiErrorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  async function handleTestRuntime() {
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      const config = runtimeConfigToAdapterConfig(adapterType, runtimeConfig);
      const result = await api<HarnessTestResult>('/v1/harness/test', {
        method: 'POST',
        body: JSON.stringify({ adapterType, config }),
      });
      setTestResult(result);
    } catch (error) {
      setTestError(apiErrorMessage(error));
    } finally {
      setTesting(false);
    }
  }

  function handleDomainChange(value: string) {
    if (value === '__create__') {
      setDomainEditorOpen(true);
      return;
    }
    setSpaceId(value);
  }

  const canCreate = name.trim().length >= 2
    && !(role === 'orchestrator' && Boolean(orchestrator));

  return (
    <div
      data-canvas-control
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      className="fixed inset-0 z-[60] flex justify-end bg-overlay-soft"
      role="dialog"
      aria-modal="true"
    >
      <aside className="flex h-full w-full max-w-[620px] animate-slide-in-right flex-col border-l border-line bg-surface shadow-modal">
        <header className="border-b border-line px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-heading text-text-primary">{heading ?? 'Commission agent'}</h2>
              <div className="mt-1 text-xs text-text-muted">Name it, give it a runtime, commission it.</div>
              {intro ? <p className="mt-2 max-w-[44rem] text-[12px] leading-relaxed text-text-muted">{intro}</p> : null}
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
              <X size={16} />
            </button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <div className="space-y-6">
            <div className="space-y-5">
              <section className="space-y-3">
                <div className="flex items-center gap-4">
                  <button
                    type="button"
                    onClick={() => avatarFileRef.current?.click()}
                    className="group relative h-16 w-16 overflow-hidden rounded-full border border-line bg-surface-2 text-base font-bold text-text-primary"
                    style={{ boxShadow: `0 0 0 4px ${ROLE_COLOR[role]}22` }}
                    aria-label="Upload avatar image"
                  >
                    {avatarDataUrl ? (
                      <img src={avatarDataUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center">
                        {initials(name)}
                      </span>
                    )}
                    <span className="absolute inset-0 hidden items-center justify-center bg-overlay text-white group-hover:flex">
                      <Upload size={14} />
                    </span>
                  </button>
                  <input
                    ref={avatarFileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(event) => {
                      handleAvatarInput(event.target.files?.[0]);
                      event.target.value = '';
                    }}
                    className="hidden"
                  />
                  <label className="min-w-0 flex-1">
                    <span className="text-xs font-medium text-text-secondary">Name</span>
                    <input
                      autoFocus
                      type="text"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder={role === 'orchestrator' ? 'The Brain' : 'e.g. Research lead'}
                      className={inputCls}
                    />
                  </label>
                </div>
                {avatarDataUrl ? (
                  <div className="text-[11px] text-text-muted">
                    <button type="button" onClick={() => setAvatarDataUrl(null)} className="text-text-secondary hover:text-text-primary">Remove image</button>
                  </div>
                ) : null}

                {role !== 'orchestrator' && (
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-text-secondary">Domain</span>
                    <div className="relative">
                      <select
                        value={spaceId}
                        onChange={(event) => handleDomainChange(event.target.value)}
                        className={clsx(inputCls, 'appearance-none pr-8')}
                      >
                        <option value="">{role === 'manager' ? 'No domain' : 'Inherit supervisor domain'}</option>
                        {spaces.map(s => {
                          const parent = s.parentDomainId ? spaces.find((d) => d.id === s.parentDomainId) : null;
                          return <option key={s.id} value={s.id}>{parent ? `${parent.name} › ${s.name}` : s.name}</option>;
                        })}
                        <option value="__create__">{managerDomainId ? 'Create new subdomain...' : 'Create new domain...'}</option>
                      </select>
                      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
                        <svg className="h-4 w-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                      </div>
                    </div>
                    <p className="text-[11px] text-text-muted">
                      {role === 'manager'
                        ? 'Optional. Use a domain when this manager owns a clear area.'
                        : managerDomainId
                          ? 'Pick a subdomain this specialist is responsible for, or create one under its manager’s domain.'
                          : 'Specialists can inherit their manager domain or be placed manually.'}
                    </p>
                  </label>
                )}

                {role !== 'orchestrator' && (
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-text-secondary">Description</span>
                    <input
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      maxLength={160}
                      placeholder={role === 'manager' ? 'What does this manager coordinate?' : 'What does this agent do?'}
                      className={inputCls}
                    />
                  </label>
                )}

              </section>

              {firstAgentOnRamp ? (
                <section className="rounded-lg border border-line bg-surface-2 px-3 py-3 text-[12px] leading-relaxed text-text-muted">
                  This is your first agent — it’ll be the one you talk to and that coordinates everything else.
                  You can add managers and specialists under it later.
                  <button
                    type="button"
                    onClick={() => setShowHierarchy(true)}
                    className="ml-1 text-accent hover:underline"
                  >
                    Set up a team structure instead
                  </button>
                </section>
              ) : (
              <section className="space-y-2">
                <span className="text-xs font-medium text-text-secondary">Role</span>
                <div className="flex flex-wrap gap-2">
                  {ROLE_OPTIONS.map((option) => {
                    const GlyphIcon = option.icon;
                    const selected = role === option.value;
                    const blocked = option.value === 'orchestrator' && Boolean(orchestrator) && option.value !== role;
                    const disabled = (lockInitialRole && option.value !== role) || blocked;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        disabled={disabled}
                        onClick={() => setRole(option.value)}
                        title={blocked ? `An orchestrator already exists: ${orchestrator?.name}` : option.subtitle}
                        className={clsx(
                          'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition',
                          selected ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-surface-2 text-text-secondary hover:border-accent/40 hover:text-text-primary',
                          disabled && 'cursor-not-allowed opacity-40',
                        )}
                      >
                        <GlyphIcon size={11} />
                        {option.title}
                        {blocked && <span className="text-[10px] text-text-muted">(exists)</span>}
                      </button>
                    );
                  })}
                </div>
                {role !== 'orchestrator' && (
                  <p className="text-[11px] text-text-muted">{ROLE_OPTIONS.find((o) => o.value === role)?.subtitle}</p>
                )}

              </section>
              )}

              {!firstAgentOnRamp && (
                <HierarchyNotice
                  role={role}
                  orchestrator={orchestrator}
                  reportsTo={reportsTo}
                  supervisors={supervisorOptions}
                  onReportsToChange={setReportsTo}
                  onBecomeOrchestrator={() => {
                    if (!lockInitialRole) setRole('orchestrator');
                  }}
                />
              )}

              {role === 'orchestrator' && (
                <section className="rounded-lg border border-line bg-surface-2">
                  <button
                    type="button"
                    onClick={() => setChannelsOpen((value) => !value)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-text-secondary hover:text-text-primary"
                  >
                    <span>Connect your inbox</span>
                    <span className="text-text-muted">{channelsOpen ? 'Hide' : 'Optional'}</span>
                  </button>
                  {channelsOpen && (
                    <div className="space-y-3 border-t border-line p-3">
                      <InboxChannelCard
                        draft={channels.telegram}
                        title="Telegram"
                        chatLabel="Default chat ID"
                        help="Bot token from BotFather. Chat ID can be a user or chat target."
                        onToggle={() => updateChannel('telegram', { open: !channels.telegram.open })}
                        onTokenChange={(value) => updateChannel('telegram', { token: value })}
                        onChatChange={(value) => updateChannel('telegram', { defaultChatId: value })}
                      />
                      <InboxChannelCard
                        draft={channels.discord}
                        title="Discord"
                        chatLabel="Default channel ID"
                        help="Bot token plus a Discord channel ID."
                        onToggle={() => updateChannel('discord', { open: !channels.discord.open })}
                        onTokenChange={(value) => updateChannel('discord', { token: value })}
                        onChatChange={(value) => updateChannel('discord', { defaultChatId: value })}
                      />
                      <InboxChannelCard
                        draft={channels.slack}
                        title="Slack"
                        chatLabel="Default channel ID"
                        help="Bot token, signing secret, and a Slack channel ID. Invite the bot to the channel."
                        onToggle={() => updateChannel('slack', { open: !channels.slack.open })}
                        onTokenChange={(value) => updateChannel('slack', { token: value })}
                        onChatChange={(value) => updateChannel('slack', { defaultChatId: value })}
                        extra={(
                          <label className="block space-y-1.5">
                            <span className="text-xs font-medium text-text-secondary">Signing secret</span>
                            <input
                              type="password"
                              value={channels.slack.signingSecret ?? ''}
                              onChange={(event) => updateChannel('slack', { signingSecret: event.target.value })}
                              placeholder="Slack signing secret"
                              className={inputCls}
                            />
                          </label>
                        )}
                      />
                      <InboxChannelCard
                        draft={channels.whatsapp}
                        title="WhatsApp Cloud"
                        chatLabel="Default recipient"
                        help="Recommended production WhatsApp path. QR linking is available from the agent Channels tab after creation."
                        onToggle={() => updateChannel('whatsapp', { open: !channels.whatsapp.open })}
                        onTokenChange={(value) => updateChannel('whatsapp', { token: value })}
                        onChatChange={(value) => updateChannel('whatsapp', { defaultChatId: value })}
                        extra={(
                          <div className="grid gap-3 sm:grid-cols-2">
                            <label className="block space-y-1.5">
                              <span className="text-xs font-medium text-text-secondary">Phone number ID</span>
                              <input
                                value={channels.whatsapp.phoneNumberId ?? ''}
                                onChange={(event) => updateChannel('whatsapp', { phoneNumberId: event.target.value })}
                                className={inputCls}
                              />
                            </label>
                            <label className="block space-y-1.5">
                              <span className="text-xs font-medium text-text-secondary">Verify token</span>
                              <input
                                type="password"
                                value={channels.whatsapp.verifyToken ?? ''}
                                onChange={(event) => updateChannel('whatsapp', { verifyToken: event.target.value })}
                                className={inputCls}
                              />
                            </label>
                            <label className="block space-y-1.5 sm:col-span-2">
                              <span className="text-xs font-medium text-text-secondary">App secret</span>
                              <input
                                type="password"
                                value={channels.whatsapp.appSecret ?? ''}
                                onChange={(event) => updateChannel('whatsapp', { appSecret: event.target.value })}
                                className={inputCls}
                              />
                            </label>
                          </div>
                        )}
                      />
                    </div>
                  )}
                </section>
              )}
            </div>

            <section className="space-y-3 border-t border-line pt-5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-text-secondary">Runtime</span>
                <button
                  type="button"
                  onClick={() => void handleTestRuntime()}
                  disabled={testing}
                  className={secondaryBtnCls}
                >
                  {testing ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  {testing ? 'Testing runtime…' : 'Test runtime'}
                </button>
              </div>

              {/* The full runtime choice is always visible — no "Configure" gate. */}
              <RuntimePicker
                adapterType={adapterType}
                runtimeConfig={runtimeConfig}
                onAdapterChange={(value) => { setAdapterType(value); setTestResult(null); setTestError(null); }}
                onConfigChange={setRuntimeConfig}
                detections={detections}
                detecting={detecting}
                onRefreshDetections={refreshDetections}
              />
              <RuntimeTestReport testing={testing} result={testResult} error={testError} />
            </section>
          </div>
        </main>

        <footer className="flex items-center justify-between gap-2 border-t border-line bg-surface-2 px-5 py-3">
          <button type="button" onClick={onClose} className={secondaryBtnCls}>Cancel</button>
          <button type="button" disabled={creating || !canCreate} onClick={() => void handleCreate()} className={primaryBtnCls}>
            {creating ? 'Commissioning…' : 'Commission agent'}
          </button>
        </footer>
      </aside>
      <DomainEditorSheet
        open={domainEditorOpen}
        managers={managers}
        parentOptions={spaces.filter((space) => !space.parentDomainId)}
        specialists={specialistOwnerOptions}
        initialParentDomainId={managerDomainId}
        onClose={() => setDomainEditorOpen(false)}
        onSaved={(domain) => {
          if (!domain) return;
          setSpaces((current) => [...current.filter((item) => item.id !== domain.id), domain].sort((a, b) => a.name.localeCompare(b.name)));
          setSpaceId(domain.id);
        }}
      />
    </div>
  );
}

function RuntimeTestReport({
  testing,
  result,
  error,
}: {
  testing: boolean;
  result: HarnessTestResult | null;
  error: string | null;
}) {
  if (testing) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-xs text-text-muted">
        <Loader2 size={13} className="animate-spin" />
        Running a live runtime probe — this can take up to 45 seconds.
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5 text-xs text-danger">
        Could not run the runtime test: {error}
      </div>
    );
  }

  if (!result) return null;

  const summary = result.status === 'pass'
    ? 'Runtime is live and ready'
    : result.status === 'warn'
      ? 'Runtime works with warnings'
      : 'Runtime is not ready';
  const summaryCls = result.status === 'pass'
    ? 'border-accent/30 bg-accent/10 text-text-primary'
    : result.status === 'warn'
      ? 'border-amber-500/30 bg-amber-500/5 text-text-primary'
      : 'border-danger/30 bg-danger/5 text-text-primary';

  return (
    <div className={clsx('space-y-2 rounded-lg border px-3 py-3', summaryCls)}>
      <div className="flex items-center gap-2 text-sm font-medium">
        <CheckGlyph level={result.status === 'pass' ? 'info' : result.status === 'warn' ? 'warn' : 'error'} />
        {summary}
      </div>
      <ul className="space-y-1.5">
        {result.checks.map((check, index) => (
          <li key={`${check.code ?? 'check'}-${index}`} className="flex gap-2 text-[12px] leading-relaxed">
            <span className="mt-0.5 shrink-0"><CheckGlyph level={check.level} /></span>
            <span className="min-w-0 text-text-secondary">
              <span className="text-text-primary">{check.message}</span>
              {check.detail ? <span className="text-text-muted"> — {check.detail}</span> : null}
              {check.hint ? <span className="mt-0.5 block text-text-muted">↳ {check.hint}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CheckGlyph({ level }: { level: 'info' | 'warn' | 'error' }) {
  if (level === 'error') return <AlertTriangle size={13} className="text-danger" />;
  if (level === 'warn') return <AlertTriangle size={13} className="text-amber-500" />;
  return <Check size={13} className="text-accent" />;
}

function HierarchyNotice({
  role,
  orchestrator,
  reportsTo,
  supervisors,
  onReportsToChange,
  onBecomeOrchestrator,
}: {
  role: AgentRole;
  orchestrator: ExistingAgent | null;
  reportsTo: string;
  supervisors: ExistingAgent[];
  onReportsToChange: (value: string) => void;
  onBecomeOrchestrator: () => void;
}) {
  if (role === 'orchestrator') {
    return (
      <div className={clsx('rounded-lg border px-3 py-3 text-sm', orchestrator ? 'border-danger/30 bg-danger/5 text-danger' : 'border-line bg-surface-2 text-text-muted')}>
        {orchestrator
          ? `A workspace orchestrator already exists: ${orchestrator.name}. Commission this agent as a manager or specialist instead.`
          : 'This agent will be the workspace orchestrator. One orchestrator per workspace.'}
      </div>
    );
  }

  if (role === 'manager' && !orchestrator) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-3 text-sm text-text-muted">
        Managers need a workspace orchestrator to report to.
        <button type="button" onClick={onBecomeOrchestrator} className="ml-2 text-accent hover:underline">Commission orchestrator instead</button>
      </div>
    );
  }

  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-text-secondary">{role === 'manager' ? 'Reports to' : 'Supervised by'}</span>
      <select value={reportsTo} onChange={(event) => onReportsToChange(event.target.value)} className={inputCls}>
        <option value="">{role === 'manager' ? 'No orchestrator selected' : 'No supervisor selected'}</option>
        {supervisors.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}{agent.role ? ` - ${agent.role}` : ''}</option>)}
      </select>
    </label>
  );
}

function InboxChannelCard({
  draft,
  title,
  chatLabel,
  help,
  onToggle,
  onTokenChange,
  onChatChange,
  extra,
}: {
  draft: ChannelDraft;
  title: string;
  chatLabel: string;
  help: string;
  onToggle: () => void;
  onTokenChange: (value: string) => void;
  onChatChange: (value: string) => void;
  extra?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line bg-canvas">
      <button type="button" onClick={onToggle} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-text-primary">
        <span>{title}</span>
        <span className="text-[11px] text-text-muted">{draft.token.trim() ? 'Configured' : 'Not set'}</span>
      </button>

      {draft.open && (
        <div className="space-y-3 border-t border-line p-3">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-text-secondary">Token</span>
            <input
              type="password"
              value={draft.token}
              onChange={(event) => onTokenChange(event.target.value)}
              placeholder="Paste token"
              className={inputCls}
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-text-secondary">{chatLabel}</span>
            <input
              value={draft.defaultChatId}
              onChange={(event) => onChatChange(event.target.value)}
              placeholder="Target ID"
              className={inputCls}
            />
          </label>

          {extra}

          <div className="text-[11px] text-text-muted">{help}</div>
        </div>
      )}
    </div>
  );
}

const inputCls = 'mt-1 h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent';
const secondaryBtnCls = 'inline-flex h-9 items-center gap-1.5 rounded-btn border border-line px-3 text-xs font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary';
const primaryBtnCls = 'inline-flex h-9 items-center gap-1.5 rounded-btn bg-accent px-3 text-xs font-semibold text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40';


