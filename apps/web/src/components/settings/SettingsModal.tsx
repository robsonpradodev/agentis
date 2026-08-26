/**
 * SettingsPage tabs: Profile / Workspace / Channels / MCP / Integrations /
 * Governance / API Keys / Budget / Runtimes.
 *
 * Channels = gateways + inbound messaging (WhatsApp/Slack/…) + channel
 * identities. MCP = external MCP-server mounts (its own subpage — mounts are
 * their own concern, distinct from messaging channels).
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  Save,
  Plug,
  Hash,
  Key,
  Trash2,
  Plus,
  Upload,
  Copy,
  X,
  MessageSquare,
  MessageCircle,
  Webhook as WebhookIcon,
  User,
  Briefcase,
  Link as LinkIcon,
  Loader2,
  CheckCircle2,
  Users,
  ChevronDown,
  ChevronUp,
  Clock,
  RefreshCcw,
  BrainCircuit,
  ShieldCheck,
  PackageOpen,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import clsx from 'clsx';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { useConfirm } from '../shared/ConfirmDialog';
import { Button } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';
import { ThemeToggle } from '../shared/ThemeToggle';
import { StatusBadge } from '../shared/StatusBadge';
import { GovernancePanel } from './GovernancePanel';
import { BrowserControlPanel } from './BrowserControlPanel';
import { McpConnectionsPanel } from './McpConnectionsPanel';
import { ChannelIdentitiesPanel } from './ChannelIdentitiesPanel';
import { OrchestratorModelsPanel } from './OrchestratorModelsPanel';
import { MediaModelsPanel } from './MediaModelsPanel';
import { CustomOAuthProvidersPanel } from './CustomOAuthProvidersPanel';
import { BrainMemoryTierPanel } from './BrainMemoryTierPanel';
import { SelfHealingPanel } from './SelfHealingPanel';
import { AutonomyPanel } from './AutonomyPanel';
import { IntegrationsPanel } from './IntegrationsPanel';
import { DataOwnershipPanel } from './DataOwnershipPanel';
import { StartupPanel } from './StartupPanel';
import { WorkspaceBundleModal } from '../packages/WorkspaceBundleModal';
import {
  useAgentisStore,
  type SettingsDestination,
  type SettingsSubsection,
} from '../../store/agentisStore';
import { normalizeLocale, setLocale, supportedLocales, type SupportedLocale } from '../../i18n';
import type en from '../../i18n/locales/en';

type DestinationKey = keyof typeof en.settings.destinations;
const DESTINATIONS: { value: SettingsDestination; key: DestinationKey; icon: React.ReactNode }[] = [
  { value: 'account', key: 'account', icon: <User size={17} /> },
  { value: 'workspace', key: 'workspace', icon: <Briefcase size={17} /> },
  { value: 'connections', key: 'connections', icon: <Plug size={17} /> },
  { value: 'intelligence', key: 'intelligence', icon: <BrainCircuit size={17} /> },
  { value: 'advanced', key: 'advanced', icon: <ShieldCheck size={17} /> },
];

function SettingsSection({ id, children }: { id: SettingsSubsection; children: React.ReactNode }) {
  return <section id={`settings-${id}`} className="scroll-mt-8 border-b border-line/70 pb-10 last:border-0 last:pb-2">{children}</section>;
}

export function SettingsModal() {
  const { t } = useTranslation();
  const {
    settingsOpen, settingsDestination, settingsSubsection, setSettingsOpen, closeSettings,
  } = useAgentisStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  function hasUnsavedChanges() {
    return Boolean(dialogRef.current?.querySelector('[data-settings-dirty="true"]'));
  }

  function confirmDiscard() {
    return !hasUnsavedChanges() || window.confirm('Discard your unsaved changes?');
  }

  function attemptClose() {
    if (confirmDiscard()) closeSettings();
  }

  function navigateTo(destination: SettingsDestination) {
    if (destination === settingsDestination || confirmDiscard()) setSettingsOpen(true, destination);
  }

  useEffect(() => {
    if (!settingsOpen) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        attemptClose();
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hasAttribute('hidden') && element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [settingsOpen, closeSettings]);

  useEffect(() => {
    if (!settingsOpen) return;
    requestAnimationFrame(() => {
      const target = document.getElementById(`settings-${settingsSubsection}`);
      if (target && contentRef.current?.contains(target)) target.scrollIntoView?.({ block: 'start' });
      else contentRef.current?.scrollTo?.({ top: 0 });
    });
  }, [settingsOpen, settingsDestination, settingsSubsection]);

  if (!settingsOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-canvas/80 p-0 backdrop-blur-sm animate-fade-in sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        tabIndex={-1}
        className="flex h-full w-full max-w-[1120px] flex-col overflow-hidden bg-surface shadow-2xl outline-none animate-slide-up sm:max-h-[860px] sm:rounded-[20px] sm:border sm:border-line"
      >
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Sidebar */}
          <div className="hidden w-[238px] shrink-0 border-r border-line bg-surface-2/65 md:flex md:flex-col">
            <div className="px-7 pb-5 pt-7">
              <h2 id="settings-dialog-title" className="text-[17px] font-semibold tracking-tight text-text-primary">{t('settings.title')}</h2>
            </div>
            <nav aria-label={t('settings.navigationLabel')} className="flex-1 space-y-1 overflow-y-auto px-3">
              {DESTINATIONS.map((item) => {
                const isActive = settingsDestination === item.value;
                return (
                  <button
                    key={item.value}
                    onClick={() => navigateTo(item.value)}
                    aria-current={isActive ? 'page' : undefined}
                    className={clsx(
                      'group flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-[13px] transition-colors',
                      isActive
                        ? 'bg-surface text-text-primary font-medium shadow-sm ring-1 ring-line/80'
                        : 'text-text-secondary hover:bg-surface/70 hover:text-text-primary',
                    )}
                  >
                    <span className={isActive ? 'text-accent' : 'text-text-muted group-hover:text-text-secondary'}>{item.icon}</span>
                    {t(`settings.destinations.${item.key}.title`)}
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Content Area */}
          <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
            <div className="flex items-center gap-3 border-b border-line px-4 py-3 md:hidden">
              <label htmlFor="settings-mobile-section" className="sr-only">{t('settings.mobileSection')}</label>
              <select
                id="settings-mobile-section"
                value={settingsDestination}
                onChange={(event) => navigateTo(event.target.value as SettingsDestination)}
                className="h-10 min-w-0 flex-1 rounded-input border border-line bg-surface-2 px-3 text-[14px] font-medium text-text-primary outline-none focus:border-accent"
              >
                {DESTINATIONS.map((item) => <option key={item.value} value={item.value}>{t(`settings.destinations.${item.key}.title`)}</option>)}
              </select>
            </div>
            <div className="absolute right-4 top-[70px] z-10 md:right-6 md:top-6">
              <button
                onClick={attemptClose}
                aria-label={t('settings.closeLabel')}
                className="flex h-8 w-8 items-center justify-center rounded-full text-text-muted hover:bg-surface-3 hover:text-text-primary transition-colors"
              >
                <X size={18} />
              </button>
            </div>
            <div ref={contentRef} className="flex-1 overflow-y-auto px-5 pb-12 pt-8 sm:px-8 md:px-12 md:pt-10">
              <header className="mb-10 max-w-2xl pr-10">
                <h1 className="text-[26px] font-semibold tracking-[-0.025em] text-text-primary">{t(`settings.destinations.${settingsDestination}.title`)}</h1>
                <p className="mt-1.5 text-[13px] leading-relaxed text-text-muted">{t(`settings.destinations.${settingsDestination}.description`)}</p>
              </header>
              <div className="mx-auto max-w-3xl space-y-10">
                {settingsDestination === 'account' && <>
                  <SettingsSection id="profile"><ProfileTab /></SettingsSection>
                  <SettingsSection id="data"><DataOwnershipPanel /></SettingsSection>
                </>}
                {settingsDestination === 'workspace' && <>
                  <SettingsSection id="workspace"><WorkspaceTab /></SettingsSection>
                  <SettingsSection id="budget"><BudgetTab /></SettingsSection>
                  <SettingsSection id="models"><AutonomyPanel /></SettingsSection>
                </>}
                {settingsDestination === 'connections' && <>
                  <SettingsSection id="channels"><div className="space-y-10"><ConnectionsTab /><ChannelIdentitiesPanel /></div></SettingsSection>
                  <SettingsSection id="integrations"><div className="space-y-8"><IntegrationsPanel /><CustomOAuthProvidersPanel /></div></SettingsSection>
                  <SettingsSection id="mcp"><McpConnectionsPanel /></SettingsSection>
                  <SettingsSection id="apiKeys"><ApiKeysTab /></SettingsSection>
                </>}
                {settingsDestination === 'intelligence' && <SettingsSection id="models"><div className="space-y-10"><OrchestratorModelsPanel /><MediaModelsPanel /><BrainMemoryTierPanel /></div></SettingsSection>}
                {settingsDestination === 'advanced' && <>
                  <SettingsSection id="governance"><div className="space-y-8"><GovernancePanel /><BrowserControlPanel /><SelfHealingPanel /></div></SettingsSection>
                  <SettingsSection id="runtimes">
                    <details className="group rounded-card border border-line bg-surface-2/40">
                      <summary className="cursor-pointer list-none px-5 py-4 text-[13px] font-medium text-text-primary marker:hidden">Runtime diagnostics <span className="float-right text-text-muted group-open:rotate-180">⌄</span></summary>
                      <div className="border-t border-line px-5 py-5"><RuntimesTab /></div>
                    </details>
                  </SettingsSection>
                </>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Runtimes tab — tool-availability matrix per adapter type. Mirrors the
// capabilities each adapter declares server-side (apps/api/src/adapters/*),
// so operators can see at a glance which runtimes can drive platform tools
// from chat and which run in relay mode. (CHAT-10X-VISION §4.4.3)
type ToolSupport = 'native' | 'marker' | 'relay' | 'none';

interface RuntimeRow {
  type: string;
  label: string;
  interactiveChat: boolean;
  support: ToolSupport;
  note: string;
}

const RUNTIME_MATRIX: RuntimeRow[] = [
  {
    type: 'http',
    label: 'HTTP',
    interactiveChat: true,
    support: 'native',
    note: 'Generic HTTP endpoint. Native tool calls work when the endpoint implements the Agentis chat contract.',
  },
  {
    type: 'codex',
    label: 'Codex CLI',
    interactiveChat: true,
    support: 'marker',
    note: 'Marker protocol. Slower (re-spawns per tool round). Use the orchestrator fast path for native speed.',
  },
  {
    type: 'claude_code',
    label: 'Claude Code CLI',
    interactiveChat: true,
    support: 'marker',
    note: 'Marker protocol. Same fast-path recommendation as Codex.',
  },
  {
    type: 'openclaw',
    label: 'OpenClaw',
    interactiveChat: true,
    support: 'relay',
    note: 'Chats through the gateway session: Agentis relays your message and streams the reply. Platform tool calls run on the gateway agent, not the local chat loop.',
  },
  {
    type: 'hermes_agent',
    label: 'Hermes Agent',
    interactiveChat: true,
    support: 'native',
    note: 'ACP-native streaming with live reasoning, tool activity, and Agentis tools over MCP. Quiet CLI remains a final-answer-only fallback.',
  },
  {
    type: 'cursor',
    label: 'Cursor',
    interactiveChat: true,
    support: 'marker',
    note: 'Marker protocol. Chat and tool forwarding via spawn-level JSON stream.',
  },
];

const SUPPORT_META: Record<ToolSupport, { label: string; cls: string }> = {
  native: { label: 'Native', cls: 'bg-accent-soft text-accent' },
  marker: { label: 'Marker', cls: 'bg-warn-soft text-warn' },
  relay: { label: 'Relay', cls: 'bg-surface-3 text-text-muted' },
  none: { label: 'None', cls: 'bg-surface-3 text-text-muted' },
};

function RuntimesTab() {
  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h2 className="text-subheading text-text-primary">Runtime tool support</h2>
        <p className="mt-1 text-[13px] text-text-muted">
          Which agent runtimes can drive Agentis platform tools (build workflows, run, dispatch,
          etc.) directly from chat. Runtimes marked{' '}
          <span className="font-medium text-warn">Marker</span> work but re-spawn a process per tool
          round — configure the orchestrator fast path (
          <code className="rounded bg-canvas/70 px-1 font-mono text-[11px]">
            AGENTIS_ORCHESTRATOR_BASE_URL
          </code>
          ) to answer their chats through a native runtime instead.
        </p>
      </div>
      <div className="overflow-hidden rounded-card border border-line">
        <table className="w-full text-left text-[13px]">
          <thead className="bg-surface-2 text-[11px] uppercase tracking-wide text-text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Runtime</th>
              <th className="px-3 py-2 font-medium">Chat</th>
              <th className="px-3 py-2 font-medium">Tools</th>
              <th className="px-3 py-2 font-medium">Notes</th>
            </tr>
          </thead>
          <tbody>
            {RUNTIME_MATRIX.map((row) => {
              const meta = SUPPORT_META[row.support];
              return (
                <tr key={row.type} className="border-t border-line align-top">
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-text-primary">{row.label}</div>
                    <div className="font-mono text-[10px] text-text-muted">{row.type}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={clsx(
                        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px]',
                        row.interactiveChat
                          ? 'bg-accent-soft text-accent'
                          : 'bg-surface-3 text-text-muted',
                      )}
                    >
                      {row.interactiveChat ? 'Interactive' : 'Relay only'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={clsx(
                        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
                        meta.cls,
                      )}
                    >
                      {meta.label}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-[12px] text-text-muted">{row.note}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProfileTab() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [me, setMe] = useState<{
    id: string;
    email: string;
    name: string;
    avatarUrl?: string;
  } | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void api<{
      user: { id: string; email: string | null; displayName: string; avatarUrl?: string };
    }>('/v1/auth/me')
      .then((d) => {
        const mapped = {
          id: d.user.id,
          email: d.user.email ?? '',
          name: d.user.displayName ?? '',
          avatarUrl: d.user.avatarUrl,
        };
        setMe(mapped);
        setName(mapped.name);
        setEmail(mapped.email);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    if (!me) return;
    setSaving(true);
    try {
      await api('/v1/auth/me', { method: 'PATCH', body: JSON.stringify({ name, email }) });
      toast.success('Profile updated');
      setMe((prev) => (prev ? { ...prev, name, email } : null));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2_000);
    } catch (e) {
      toast.error('Failed to update', apiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Skeleton height={200} />;
  const profileDirty = Boolean(me && (name !== me.name || email !== me.email));

  return (
    <div className="max-w-xl space-y-5" data-settings-dirty={profileDirty}>
      <div>
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Profile
        </h2>
        <div className="space-y-4 rounded-card border border-line bg-surface p-5">
          <div className="space-y-1.5">
            <label htmlFor="settings-display-name" className="text-[12px] font-medium text-text-secondary">Display name</label>
            <input
              id="settings-display-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[14px] text-text-primary focus:border-accent focus:outline-none"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="settings-email" className="text-[12px] font-medium text-text-secondary">Email</label>
            <input
              id="settings-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[14px] text-text-primary focus:border-accent focus:outline-none"
            />
          </div>
          <div className="flex min-h-8 items-center gap-3">
            {profileDirty && <Button
              variant="primary"
              size="md"
              iconLeft={<Save size={12} />}
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </Button>}
            {saved && <span role="status" className="inline-flex items-center gap-1.5 text-[12px] text-success"><CheckCircle2 size={13} /> Saved</span>}
          </div>
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Theme
        </h2>
        <div className="rounded-card border border-line bg-surface p-5">
          <ThemeToggle variant="full" />
          <p className="mt-3 text-[12px] text-text-muted">
            Match the system theme, or pick light/dark explicitly.
          </p>
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          {t('settings.language.title')}
        </h2>
        <div className="space-y-3 rounded-card border border-line bg-surface p-5">
          <div className="space-y-1.5">
            <label
              htmlFor="agentis-language"
              className="text-[12px] font-medium text-text-secondary"
            >
              {t('settings.language.label')}
            </label>
            <select
              id="agentis-language"
              value={normalizeLocale(i18n.resolvedLanguage ?? i18n.language)}
              onChange={(event) => {
                void setLocale(event.target.value as SupportedLocale);
              }}
              className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[14px] text-text-primary focus:border-accent focus:outline-none"
            >
              {supportedLocales.map((locale) => (
                <option key={locale} value={locale}>
                  {locale === 'en'
                    ? t('settings.language.english')
                    : t('settings.language.portugueseBrazil')}
                </option>
              ))}
            </select>
          </div>
          <p className="text-[12px] text-text-muted">{t('settings.language.description')}</p>
        </div>
      </div>

      <StartupPanel />
    </div>
  );
}

function WorkspaceTab() {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const [ws, setWs] = useState<{
    id: string;
    name: string;
    slug: string;
    description?: string;
    imageUrl?: string | null;
  } | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [bundleOpen, setBundleOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api<{ workspaces: (typeof ws)[] }>('/v1/workspaces')
      .then((d) => {
        const wsId = localStorage.getItem('agentis.workspace');
        const current = d.workspaces.find((x: any) => x?.id === wsId) ?? d.workspaces[0];
        if (current) {
          setWs(current);
          setName(current.name);
          setSlug(current.slug);
          setDescription(current.description ?? '');
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    if (!ws) return;
    setSaving(true);
    try {
      await api(`/v1/workspaces/${ws.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name,
          slug,
          description,
          ...(imageDataUrl ? { imageDataUrl } : {}),
        }),
      });
      toast.success(t('settings.workspace.updated'));
      setWs((prev) => (prev ? { ...prev, name, slug, description, imageUrl: imageDataUrl ?? prev.imageUrl } : null));
      setImageDataUrl(null);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2_000);
    } catch (e) {
      toast.error(t('settings.workspace.updateFailed'), apiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function deleteWorkspace() {
    if (!ws) return;
    const ok = await confirm({
      title: t('settings.workspace.deleteConfirmTitle', { name: ws.name }),
      body: t('settings.workspace.deleteConfirmBody'),
      confirmLabel: t('settings.workspace.delete'),
      tone: 'danger',
      typeToConfirm: ws.name,
    });
    if (!ok) return;
    try {
      await api(`/v1/workspaces/${ws.id}`, { method: 'DELETE' });
      toast.success(t('settings.workspace.deleted'));
      window.location.reload();
    } catch (e) {
      toast.error(t('settings.workspace.deleteFailed'), apiErrorMessage(e));
    }
  }

  function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setImageDataUrl(ev.target?.result as string);
    reader.readAsDataURL(file);
  }

  if (loading) return <Skeleton height={300} />;
  if (!ws) return <div className="text-[13px] text-text-muted">{t('settings.workspace.noWorkspace')}</div>;

  const previewImage = imageDataUrl ?? ws.imageUrl;
  const workspaceDirty = name !== ws.name || slug !== ws.slug || description !== (ws.description ?? '') || Boolean(imageDataUrl);

  return (
    <div className="max-w-xl space-y-5" data-settings-dirty={workspaceDirty}>
      <div>
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          {t('settings.workspace.title')}
        </h2>
        <div className="space-y-4 rounded-card border border-line bg-surface p-5">
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-card border border-line bg-surface-2"
              aria-label={t('settings.workspace.imageLabel')}
            >
              {previewImage ? (
                <img src={previewImage} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-[24px] font-bold text-text-primary">
                  {name.charAt(0).toUpperCase() || '?'}
                </span>
              )}
              <span className="absolute inset-0 hidden items-center justify-center bg-overlay group-hover:flex">
                <Upload size={16} className="text-white" />
              </span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={handleImageChange}
              className="hidden"
            />
            <div className="text-[12px] text-text-muted">{t('settings.workspace.imageHint')}</div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="settings-workspace-name" className="text-[12px] font-medium text-text-secondary">{t('settings.workspace.name')}</label>
            <input
              id="settings-workspace-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[14px] text-text-primary focus:border-accent focus:outline-none"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="settings-workspace-slug" className="text-[12px] font-medium text-text-secondary">{t('settings.workspace.slug')}</label>
            <input
              id="settings-workspace-slug"
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 font-mono text-[14px] text-text-primary focus:border-accent focus:outline-none"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="settings-workspace-description" className="text-[12px] font-medium text-text-secondary">{t('settings.workspace.description')}</label>
            <textarea
              id="settings-workspace-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full resize-none rounded-input border border-line bg-surface-2 px-3 py-2 text-[14px] text-text-primary focus:border-accent focus:outline-none"
            />
          </div>
          <div className="flex min-h-8 items-center gap-3">
            {workspaceDirty && <Button
              variant="primary"
              size="md"
              iconLeft={<Save size={12} />}
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : t('settings.workspace.saveChanges')}
            </Button>}
            {saved && <span role="status" className="inline-flex items-center gap-1.5 text-[12px] text-success"><CheckCircle2 size={13} /> Saved</span>}
          </div>
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Complete transfer</h2>
        <div className="rounded-card border border-line bg-surface p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card border border-accent/25 bg-accent-soft text-accent">
              <PackageOpen size={17} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-text-primary">Move this workspace to another machine</div>
              <p className="mt-1 text-[12px] leading-5 text-text-muted">
                Export apps, current workflow drafts, agents, extensions, knowledge, Brain memory, collection rows, and workspace structure as one <span className="font-mono text-text-secondary">.agentis</span> file.
              </p>
              <p className="mt-1 text-[11px] text-text-muted">Secret values never enter the file; credential and channel slots are listed for safe reconnection.</p>
              <Button variant="primary" size="md" iconLeft={<PackageOpen size={13} />} className="mt-3" onClick={() => setBundleOpen(true)}>
                Export complete workspace
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-danger">
          {t('settings.workspace.dangerZone')}
        </h2>
        <div className="space-y-3 rounded-card border border-danger/20 bg-danger-soft/30 p-5">
          <div className="text-[13px] text-text-primary">{t('settings.workspace.deleteTitle')}</div>
          <div className="text-[12px] text-text-muted">
            {t('settings.workspace.deleteDescription')}
          </div>
          <Button
            variant="danger"
            size="md"
            iconLeft={<Trash2 size={12} />}
            onClick={() => void deleteWorkspace()}
          >
            {t('settings.workspace.delete')}
          </Button>
        </div>
      </div>
      {bundleOpen && createPortal(
        <WorkspaceBundleModal onClose={() => setBundleOpen(false)} onImported={() => {}} />,
        document.body,
      )}
    </div>
  );
}

interface Connection {
  id: string;
  kind: 'gateway' | 'whatsapp' | 'telegram' | 'discord' | 'slack' | 'webhook' | 'voice';
  name: string;
  status?: string;
  agentCount?: number;
  isDefault?: boolean;
  /** Owner label for channels: agent name, or "Workspace" when agentless. */
  owner?: string;
  /** Owning agent id, or null/undefined for a workspace-owned (agentless) connection. */
  agentId?: string | null;
}

function ConnectionsTab() {
  const toast = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [permissionsFor, setPermissionsFor] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const [g, c, a] = await Promise.allSettled([
        api<{ gateways: Array<{ id: string; name: string; status: string; agentCount?: number }> }>(
          '/v1/gateways',
        ),
        // NOTE: /v1/channels returns { connections: [...] }, NOT { channels }.
        // Reading the wrong key is why the list showed "No connections configured".
        api<{
          connections: Array<{
            id: string;
            kind: string;
            name: string;
            status?: string;
            isDefault?: boolean;
            agentId?: string | null;
          }>;
        }>('/v1/channels'),
        api<{ agents: Array<{ id: string; name: string }> }>('/v1/agents'),
      ]);
      const agentName = new Map(
        (a.status === 'fulfilled' ? (a.value.agents ?? []) : []).map((x) => [x.id, x.name]),
      );
      const merged: Connection[] = [];
      if (g.status === 'fulfilled') {
        for (const x of g.value.gateways ?? []) merged.push({ ...x, kind: 'gateway' });
      }
      if (c.status === 'fulfilled') {
        for (const x of c.value.connections ?? []) {
          merged.push({
            id: x.id,
            kind: x.kind as Connection['kind'],
            name: x.name,
            status: x.status,
            isDefault: x.isDefault,
            owner: x.agentId ? (agentName.get(x.agentId) ?? 'Agent') : 'Workspace',
            agentId: x.agentId ?? null,
          });
        }
      }
      setItems(merged);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleDelete(c: Connection) {
    const ok = await confirm({
      title: `Disconnect "${c.name}"?`,
      body: 'This will remove the connection. Agents using it will lose access.',
      confirmLabel: 'Disconnect',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const path = c.kind === 'gateway' ? `/v1/gateways/${c.id}` : `/v1/channels/${c.id}`;
      await api(path, { method: 'DELETE' });
      toast.success('Disconnected', c.name);
      void refresh();
    } catch (e) {
      toast.error('Failed to disconnect', apiErrorMessage(e));
    }
  }

  async function makeDefault(c: Connection) {
    try {
      await api(`/v1/channels/${c.id}/default`, {
        method: 'POST',
        body: JSON.stringify({ default: true }),
      });
      toast.success('Default set', `Deterministic ${c.kind} sends now use "${c.name}".`);
      void refresh();
    } catch (e) {
      toast.error('Could not set default', apiErrorMessage(e));
    }
  }

  // WhatsApp relink — a disconnected/errored QR session needs a new device scan.
  // Kick the login session and poll for the QR + connected state (same endpoints
  // the connect flow uses), showing the QR in a modal above this settings modal.
  const relinkPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [relink, setRelink] = useState<{
    id: string;
    name: string;
    status: string;
    qrDataUrl?: string;
  } | null>(null);
  const stopRelinkPoll = () => {
    if (relinkPollRef.current) {
      clearInterval(relinkPollRef.current);
      relinkPollRef.current = null;
    }
  };
  useEffect(() => stopRelinkPoll, []);

  async function startRelink(c: Connection) {
    try {
      const login = await api<{ status: string; qrDataUrl?: string }>(
        `/v1/channels/${c.id}/login`,
        { method: 'POST', body: '{}' },
      );
      setRelink({ id: c.id, name: c.name, status: login.status, qrDataUrl: login.qrDataUrl });
      stopRelinkPoll();
      relinkPollRef.current = setInterval(() => {
        void (async () => {
          try {
            const state = await api<{ status: string; qrDataUrl?: string }>(
              `/v1/channels/${c.id}/login`,
            );
            setRelink((prev) =>
              prev && prev.id === c.id
                ? { ...prev, status: state.status, qrDataUrl: state.qrDataUrl ?? prev.qrDataUrl }
                : prev,
            );
            if (['open', 'active', 'connected'].includes(state.status)) {
              stopRelinkPoll();
              setRelink(null);
              toast.success('Reconnected', c.name);
              void refresh();
            }
          } catch {
            /* keep polling */
          }
        })();
      }, 1000);
    } catch (e) {
      toast.error('Could not start relink', apiErrorMessage(e));
    }
  }

  const RELINK_STATES = [
    'error',
    'needs_action',
    'degraded',
    'paused',
    'disconnected',
    'logged_out',
  ];

  // A kind has "competing" connections when >1 of it exists — that's when a
  // default matters for deterministic sends.
  const kindCounts = items.reduce<Record<string, number>>((acc, i) => {
    acc[i.kind] = (acc[i.kind] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Gateways &amp; channels
        </h2>
        <Button
          variant="primary"
          size="md"
          iconLeft={<Plus size={14} />}
          onClick={() => setAddOpen(true)}
        >
          Add connection
        </Button>
      </div>
      <AddConnectionDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={() => {
          setAddOpen(false);
          void refresh();
        }}
      />

      {loading ? (
        <Skeleton height={200} />
      ) : items.length === 0 ? (
        <div className="rounded-card border border-dashed border-line bg-surface/40 p-8 text-center">
          <Plug size={32} className="mx-auto text-text-muted opacity-60" />
          <h3 className="mt-3 text-subheading text-text-primary">No connections configured</h3>
          <p className="mt-1 text-[13px] text-text-secondary">
            Connect an OpenClaw gateway or messaging integration to bring agents online.
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {items.map((c) => {
            const canGovern = c.kind !== 'gateway' && c.kind !== 'webhook';
            // §3.3 agent-grants only make sense on a SHARED (workspace-owned)
            // connection — "which agents may use it". An individually-owned
            // connection is already scoped to its one agent; the equivalent
            // permission question there is "who it may talk to", which lives on
            // that agent's own Channels tab (People with rules), not here.
            const canRestrictToAgents = canGovern && !c.agentId;
            const expanded = permissionsFor === c.id;
            return (
              <div key={c.id} className="rounded-card border border-line bg-surface">
                <div className="flex items-center gap-3 px-4 py-3">
                  <span
                    className={`flex h-8 w-8 items-center justify-center rounded-card ${
                      c.kind === 'gateway'
                        ? 'bg-info-soft text-info'
                        : c.kind === 'whatsapp'
                          ? 'bg-success-soft text-success'
                          : c.kind === 'telegram'
                            ? 'bg-info-soft text-info'
                            : c.kind === 'discord'
                              ? 'bg-accent-soft text-accent'
                              : c.kind === 'slack'
                                ? 'bg-warn-soft text-warn'
                                : 'bg-surface-2 text-text-secondary'
                    }`}
                  >
                    {c.kind === 'gateway' ? (
                      <Plug size={14} />
                    ) : c.kind === 'whatsapp' ? (
                      <MessageCircle size={14} />
                    ) : c.kind === 'telegram' ? (
                      <MessageSquare size={14} />
                    ) : (
                      <Hash size={14} />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-text-primary">{c.name}</span>
                      <StatusBadge status={c.status ?? 'unknown'} size="sm" />
                      {c.isDefault && (
                        <span className="inline-flex items-center rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                          Default
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] capitalize text-text-muted">
                      {c.kind}
                      {c.owner ? ` · ${c.owner}` : ''}
                      {c.agentCount != null
                        ? ` · ${c.agentCount} agent${c.agentCount === 1 ? '' : 's'}`
                        : ''}
                    </div>
                  </div>
                  {/* Only messaging channels with a sibling of the same kind need a default. */}
                  {canGovern && !c.isDefault && (kindCounts[c.kind] ?? 0) > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void makeDefault(c)}
                      title={`Use this for deterministic ${c.kind} sends`}
                    >
                      Set default
                    </Button>
                  )}
                  {canRestrictToAgents && (
                    <Button
                      variant="ghost"
                      size="sm"
                      iconLeft={<Users size={12} />}
                      onClick={() => setPermissionsFor(expanded ? null : c.id)}
                      title="Choose which agents may use this shared connection"
                    >
                      Permissions {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    </Button>
                  )}
                  {canGovern && c.agentId && (
                    <Link
                      to={`/agents/${c.agentId}?tab=channels`}
                      className="text-[11px] text-text-muted hover:text-accent hover:underline"
                      title="This connection belongs to one agent — manage who it talks to on that agent's Channels tab"
                    >
                      Individual connection · manage on {c.owner} →
                    </Link>
                  )}
                  {c.kind === 'whatsapp' && RELINK_STATES.includes(c.status ?? '') && (
                    <Button
                      variant="secondary"
                      size="sm"
                      iconLeft={<RefreshCcw size={12} />}
                      onClick={() => void startRelink(c)}
                      title="Scan a new QR to reconnect this WhatsApp"
                    >
                      Relink
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Disconnect"
                    onClick={() => void handleDelete(c)}
                  >
                    <Trash2 size={12} />
                  </Button>
                </div>
                {expanded && <ConnectionPermissions connectionId={c.id} owner={c.owner} />}
              </div>
            );
          })}
        </div>
      )}

      {relink && (
        <div
          className="animate-fade-in fixed inset-0 z-[110] flex items-center justify-center bg-overlay p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => {
            stopRelinkPoll();
            setRelink(null);
          }}
        >
          <div
            className="animate-scale-in w-full max-w-sm rounded-modal border border-line bg-surface p-5 text-center shadow-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-subheading text-text-primary">Relink {relink.name}</h3>
            {['open', 'active', 'connected'].includes(relink.status) ? (
              <div className="mt-4 flex flex-col items-center gap-2 text-success">
                <CheckCircle2 size={32} /> Connected
              </div>
            ) : relink.qrDataUrl ? (
              <>
                <img
                  src={relink.qrDataUrl}
                  alt="WhatsApp pairing QR"
                  className="mx-auto mt-4 h-52 w-52 rounded-card border border-line bg-white p-2"
                />
                <p className="mt-3 text-[12px] text-text-secondary">
                  On your phone: WhatsApp → Linked devices → Link a device, then scan this code.
                </p>
              </>
            ) : (
              <div className="mt-6 flex items-center justify-center gap-2 text-text-muted">
                <Loader2 size={16} className="animate-spin" /> Generating QR…
              </div>
            )}
            <div className="mt-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  stopRelinkPoll();
                  setRelink(null);
                }}
              >
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface AgentOption {
  id: string;
  name: string;
}
interface Grant {
  id: string;
  agentId: string;
  status: string;
  scope: string;
}

/**
 * Inline permissions panel for one connection (§3.3 grants). A connection with
 * zero grants is open to every agent — that's the default. Granting the FIRST
 * agent flips it to default-deny for that connection: only its owner (if any)
 * plus explicitly checked agents may send on it. Unchecking the last agent
 * does NOT re-open it — revoke leaves a (revoked) row; add a note below.
 */
function ConnectionPermissions({ connectionId, owner }: { connectionId: string; owner?: string }) {
  const toast = useToast();
  const [agents, setAgents] = useState<AgentOption[] | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    const [a, g] = await Promise.allSettled([
      api<{ agents: AgentOption[] }>('/v1/agents'),
      api<{ grants: Grant[] }>(`/v1/channels/${connectionId}/grants`),
    ]);
    if (a.status === 'fulfilled') setAgents(a.value.agents ?? []);
    if (g.status === 'fulfilled') setGrants(g.value.grants ?? []);
  }

  useEffect(() => {
    void refresh();
  }, [connectionId]);

  const activeGrants = grants.filter((g) => g.status === 'active');
  const restricted = activeGrants.length > 0;
  const grantedIds = new Set(activeGrants.map((g) => g.agentId));

  async function toggle(agentId: string) {
    setBusy(agentId);
    try {
      const existing = activeGrants.find((g) => g.agentId === agentId);
      if (existing) {
        await api(`/v1/channels/${connectionId}/grants/${existing.id}`, { method: 'DELETE' });
      } else {
        await api(`/v1/channels/${connectionId}/grants`, {
          method: 'POST',
          body: JSON.stringify({ agentId, scope: 'send' }),
        });
      }
      await refresh();
    } catch (e) {
      toast.error('Could not update permission', apiErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border-t border-line bg-surface-2/60 px-4 py-3">
      <div
        className={clsx(
          'mb-2 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
          restricted ? 'bg-warn-soft text-warn' : 'bg-success-soft text-success',
        )}
      >
        {restricted
          ? `Restricted — ${activeGrants.length} agent${activeGrants.length === 1 ? '' : 's'} allowed`
          : 'Open — every agent may send on this connection'}
      </div>
      <p className="mb-2 text-[11px] text-text-secondary">
        {owner ? `${owner} (the owner) always has access. ` : ''}
        Check an agent to restrict this connection to only checked agents
        {owner ? ' plus the owner' : ''}. Leave everything unchecked to keep it open to all.
      </p>
      {agents === null ? (
        <div className="text-[11px] text-text-muted">Loading agents…</div>
      ) : agents.length === 0 ? (
        <div className="text-[11px] text-text-muted">No agents in this workspace yet.</div>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          {agents.map((a) => (
            <label
              key={a.id}
              className="flex cursor-pointer items-center gap-2 py-0.5 text-[12px] text-text-primary"
            >
              <input
                type="checkbox"
                checked={grantedIds.has(a.id)}
                disabled={busy === a.id}
                onChange={() => void toggle(a.id)}
                className="h-3.5 w-3.5 rounded border-line"
              />
              {a.name}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

interface ApiKeyRow {
  id: string;
  name: string;
  preview: string;
  createdAt: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
}

/** Expiry urgency → badge tone + label, shared between the list and the reveal dialog. */
function expiryStatus(expiresAt?: string | null): {
  tone: 'muted' | 'success' | 'warn' | 'danger';
  label: string;
} {
  if (!expiresAt) return { tone: 'muted', label: 'No expiration' };
  const ms = new Date(expiresAt).getTime() - Date.now();
  const relative = formatDistanceToNow(new Date(expiresAt), { addSuffix: true });
  if (ms <= 0) return { tone: 'danger', label: `Expired ${relative}` };
  if (ms <= 7 * 24 * 60 * 60 * 1000) return { tone: 'warn', label: `Expires ${relative}` };
  return { tone: 'success', label: `Expires ${relative}` };
}

function ApiKeysTab() {
  const toast = useToast();
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const confirm = useConfirm();
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [revealedKey, setRevealedKey] = useState<{
    name: string;
    secret: string;
    expiresAt: string | null;
  } | null>(null);

  async function refresh() {
    try {
      const data = await api<{ keys: ApiKeyRow[] }>('/v1/auth/api-keys');
      setKeys(data.keys ?? []);
    } catch {
      setKeys([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function createKey(name: string, expiresInDays: number | null) {
    if (!name.trim()) return;
    try {
      const data = await api<{ key: { id: string; secret: string; expiresAt: string | null } }>(
        '/v1/auth/api-keys',
        {
          method: 'POST',
          body: JSON.stringify({ name: name.trim(), expiresInDays }),
        },
      );
      setCreatingOpen(false);
      setRevealedKey({ name: name.trim(), secret: data.key.secret, expiresAt: data.key.expiresAt });
      void refresh();
    } catch (e) {
      toast.error('Failed to create key', apiErrorMessage(e));
    }
  }

  async function revoke(id: string) {
    const ok = await confirm({
      title: 'Revoke this API key?',
      body: 'Anything using this key will stop working immediately.',
      confirmLabel: 'Revoke',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api(`/v1/auth/api-keys/${id}`, { method: 'DELETE' });
      toast.success('Key revoked');
      void refresh();
    } catch (e) {
      toast.error('Failed to revoke', apiErrorMessage(e));
    }
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            API Keys
          </h2>
          <p className="mt-1 text-[12px] text-text-muted">
            Authenticate programmatic access to Agentis. Give each key a limited lifetime so a
            forgotten or leaked key stops working on its own.
          </p>
        </div>
        <Button
          variant="primary"
          size="md"
          iconLeft={<Plus size={14} />}
          onClick={() => setCreatingOpen(true)}
        >
          New key
        </Button>
      </div>
      <ApiKeyCreateDialog
        open={creatingOpen}
        onClose={() => setCreatingOpen(false)}
        onCreate={createKey}
      />
      <ApiKeyRevealDialog keyValue={revealedKey} onClose={() => setRevealedKey(null)} />

      {loading ? (
        <Skeleton height={150} />
      ) : keys.length === 0 ? (
        <div className="rounded-card border border-dashed border-line bg-surface/40 p-8 text-center">
          <Key size={32} className="mx-auto text-text-muted opacity-60" />
          <h3 className="mt-3 text-subheading text-text-primary">No API keys yet</h3>
          <p className="mt-1 text-[13px] text-text-secondary">
            Create an API key to authenticate programmatic access.
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {keys.map((k) => {
            const status = expiryStatus(k.expiresAt);
            return (
              <div
                key={k.id}
                className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-card bg-surface-2 text-text-secondary">
                  <Key size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-text-primary">{k.name}</span>
                    <StatusBadge
                      tone={status.tone}
                      label={status.label}
                      size="sm"
                      dot={status.tone !== 'muted'}
                    />
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-text-muted">
                    <span className="font-mono">{k.preview}</span>
                    <span>·</span>
                    <span>
                      {k.lastUsedAt
                        ? `Last used ${formatDistanceToNow(new Date(k.lastUsedAt), { addSuffix: true })}`
                        : 'Never used'}
                    </span>
                  </div>
                </div>
                <Button
                  variant="danger"
                  size="sm"
                  iconLeft={<Trash2 size={11} />}
                  onClick={() => void revoke(k.id)}
                >
                  Revoke
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Common expirations for programmatic-access keys, mirroring GitHub/GitLab PAT
// UX. Defaulting to a bounded lifetime (90 days) nudges toward key rotation;
// "No expiration" stays one click away for long-lived automation.
const API_KEY_EXPIRY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: '', label: 'No expiration' },
];

function ApiKeyCreateDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, expiresInDays: number | null) => Promise<void> | void;
}) {
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState('90');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setExpiry('90');
    }
  }, [open]);
  if (!open) return null;

  return (
    <div
      className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-overlay p-4"
      role="dialog"
      aria-modal="true"
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim() || busy) return;
          setBusy(true);
          try {
            await onCreate(name, expiry ? Number(expiry) : null);
          } finally {
            setBusy(false);
          }
        }}
        className="animate-scale-in w-full max-w-sm rounded-modal border border-line bg-surface shadow-modal"
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h3 className="text-heading text-text-primary">New API key</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </header>
        <div className="space-y-3 px-5 py-5">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-text-secondary">Name</span>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., CI deploy script"
              className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[14px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-text-secondary">
              <Clock size={12} /> Expiration
            </span>
            <select
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[14px] text-text-primary focus:border-accent focus:outline-none"
            >
              {API_KEY_EXPIRY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[11px] text-text-muted">
              A limited lifetime means a forgotten or leaked key stops working on its own.
            </span>
          </label>
          <p className="text-[11px] text-text-muted">
            The full key will only be shown once after creation. Save it somewhere safe.
          </p>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-btn border border-line bg-transparent px-3 text-[13px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || busy}
            className="inline-flex h-9 items-center rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-60"
          >
            {busy ? 'Creating…' : 'Create key'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function ApiKeyRevealDialog({
  keyValue,
  onClose,
}: {
  keyValue: { name: string; secret: string; expiresAt: string | null } | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  if (!keyValue) return null;
  const status = expiryStatus(keyValue.expiresAt);
  return (
    <div
      className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-overlay p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="animate-scale-in w-full max-w-md rounded-modal border border-line bg-surface shadow-modal">
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h3 className="text-heading text-text-primary">Save your API key</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </header>
        <div className="space-y-3 px-5 py-5">
          <div className="rounded-card border border-warn/30 bg-warn-soft px-3 py-2 text-[12px] text-text-primary">
            This is the only time this key will be shown. Copy and store it somewhere safe.
          </div>
          <div className="flex items-center justify-between">
            <div className="space-y-1.5">
              <span className="text-[12px] text-text-muted">Key name</span>
              <div className="text-[13px] text-text-primary">{keyValue.name}</div>
            </div>
            <StatusBadge
              tone={status.tone}
              label={status.label}
              size="sm"
              dot={status.tone !== 'muted'}
            />
          </div>
          <div className="space-y-1.5">
            <span className="text-[12px] text-text-muted">Secret</span>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded-input border border-line bg-surface-2 px-3 py-2 font-mono text-[12px] text-text-primary">
                {keyValue.secret}
              </code>
              <Button
                variant="secondary"
                size="md"
                iconLeft={<Copy size={12} />}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(keyValue.secret);
                    setCopied(true);
                    toast.success('Copied');
                    setTimeout(() => setCopied(false), 2000);
                  } catch {
                    /* ignore */
                  }
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas hover:bg-accent-hover"
          >
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

interface AddConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

// `flow` drives the connect UI: 'qr' = scan a QR to pair (WhatsApp), 'token' =
// paste a bot token, 'gateway' = provision compute, 'webhook' = inbound HTTP.
const CONNECTION_KINDS = [
  {
    kind: 'whatsapp',
    label: 'WhatsApp',
    desc: 'Scan a QR to pair',
    icon: MessageCircle,
    group: 'messaging',
    flow: 'qr',
  },
  {
    kind: 'telegram',
    label: 'Telegram',
    desc: 'Bot token',
    icon: MessageSquare,
    group: 'messaging',
    flow: 'token',
  },
  {
    kind: 'discord',
    label: 'Discord',
    desc: 'Bot token',
    icon: Hash,
    group: 'messaging',
    flow: 'token',
  },
  {
    kind: 'slack',
    label: 'Slack',
    desc: 'Bot token',
    icon: Hash,
    group: 'messaging',
    flow: 'token',
  },
  {
    kind: 'gateway',
    label: 'OpenClaw Gateway',
    desc: 'Self-hosted compute',
    icon: Plug,
    group: 'compute',
    flow: 'gateway',
  },
  {
    kind: 'webhook',
    label: 'Webhook',
    desc: 'Inbound HTTP',
    icon: WebhookIcon,
    group: 'inbound',
    flow: 'webhook',
  },
] as const;

const CONNECTION_GROUPS: Array<{ id: string; label: string }> = [
  { id: 'messaging', label: 'Messaging channels' },
  { id: 'compute', label: 'Gateway / compute' },
  { id: 'inbound', label: 'Inbound' },
];

function AddConnectionDialog({ open, onClose, onCreated }: AddConnectionDialogProps) {
  const toast = useToast();
  const [pickedKind, setPickedKind] = useState<(typeof CONNECTION_KINDS)[number]['kind'] | null>(
    null,
  );
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [gatewayUrl, setGatewayUrl] = useState('');
  const [busy, setBusy] = useState(false);
  // A channel connection is OWNED by an agent (inbound routes to it; outbound
  // sends as it), so messaging kinds must pick one.
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [agentId, setAgentId] = useState('');
  // WhatsApp QR pairing sub-flow.
  const [qr, setQr] = useState<{
    connectionId: string;
    qrDataUrl?: string;
    qr?: string;
    status: string;
  } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const picked = pickedKind ? (CONNECTION_KINDS.find((c) => c.kind === pickedKind) ?? null) : null;
  const needsAgent = picked?.flow === 'token' || picked?.flow === 'qr';

  const stopPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };
  useEffect(() => {
    if (open) {
      setPickedKind(null);
      setName('');
      setToken('');
      setAgentId('');
      setQr(null);
      stopPoll();
      void api<{ agents: Array<{ id: string; name: string }> }>('/v1/agents')
        .then((r) => setAgents(r.agents ?? []))
        .catch(() => setAgents([]));
    }
    return stopPoll;
  }, [open]);

  if (!open) return null;

  function beginQrPolling(connectionId: string) {
    stopPoll();
    // Poll quickly so the QR appears as soon as baileys emits it (usually 1–2s),
    // not several seconds later.
    pollRef.current = setInterval(async () => {
      try {
        const state = await api<{
          connectionId: string;
          status: string;
          qr?: string;
          qrDataUrl?: string;
        }>(`/v1/channels/${connectionId}/login`);
        setQr({ connectionId, status: state.status, qr: state.qr, qrDataUrl: state.qrDataUrl });
        if (state.status === 'open' || state.status === 'active' || state.status === 'connected') {
          stopPoll();
          toast.success('WhatsApp connected', name.trim());
          onCreated();
        }
      } catch {
        /* transient; keep polling */
      }
    }, 1000);
  }

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    if (!picked || !name.trim() || busy) return;
    // The gateway flow needs a URL + device token to provision a reusable
    // openclaw_gateways row — agents then reference it by id. Guard here so the
    // submit doesn't fire an incomplete pairing.
    if (picked.flow === 'gateway' && (!gatewayUrl.trim() || !token.trim())) return;
    setBusy(true);
    try {
      if (picked.flow === 'gateway') {
        // Provision a reusable gateway via the pairing route (the old POST /v1/gateways
        // with only {name} hit a non-existent handler and 404'd).
        await api('/v1/gateways/pair', {
          method: 'POST',
          body: JSON.stringify({
            name: name.trim(),
            gatewayUrl: gatewayUrl.trim(),
            deviceToken: token.trim(),
          }),
        });
        toast.success('Gateway paired', name.trim());
        onCreated();
      } else if (picked.flow === 'qr') {
        // WhatsApp: create the connection (QR-local, no token) owned by the chosen
        // agent, then start the login session and poll for the QR + connected state.
        const created = await api<{ connection: { id: string } }>('/v1/channels', {
          method: 'POST',
          body: JSON.stringify({
            kind: 'whatsapp',
            mode: 'qr_local',
            name: name.trim(),
            ...(agentId ? { agentId } : {}),
          }),
        });
        const id = created.connection.id;
        const login = await api<{
          connectionId: string;
          status: string;
          qr?: string;
          qrDataUrl?: string;
        }>(`/v1/channels/${id}/login`, { method: 'POST', body: '{}' });
        setQr({ connectionId: id, status: login.status, qr: login.qr, qrDataUrl: login.qrDataUrl });
        beginQrPolling(id);
      } else {
        await api('/v1/channels', {
          method: 'POST',
          body: JSON.stringify({
            kind: pickedKind,
            name: name.trim(),
            ...(agentId ? { agentId } : {}),
            ...(token.trim() ? { token: token.trim() } : {}),
          }),
        });
        toast.success('Connected', name.trim());
        onCreated();
      }
    } catch (e) {
      toast.error('Failed to connect', apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-overlay p-4"
      role="dialog"
      aria-modal="true"
    >
      <form
        onSubmit={connect}
        className="animate-scale-in w-full max-w-md rounded-modal border border-line bg-surface shadow-modal"
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h3 className="text-heading text-text-primary">
            {qr ? 'Connect WhatsApp' : 'Add connection'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </header>
        <div className="space-y-4 px-5 py-5">
          {qr ? (
            // WhatsApp QR pairing screen.
            <div className="flex flex-col items-center gap-3 text-center">
              {qr.status === 'open' || qr.status === 'active' || qr.status === 'connected' ? (
                <>
                  <CheckCircle2 size={40} className="text-success" />
                  <p className="text-[14px] text-text-primary">Connected!</p>
                </>
              ) : qr.qrDataUrl ? (
                <>
                  <img
                    src={qr.qrDataUrl}
                    alt="WhatsApp pairing QR"
                    className="h-52 w-52 rounded-card border border-line bg-white p-2"
                  />
                  <p className="text-[13px] text-text-secondary">
                    On your phone:{' '}
                    <strong>WhatsApp → Settings → Linked Devices → Link a Device</strong>, then scan
                    this code.
                  </p>
                  <p className="inline-flex items-center gap-1.5 text-[12px] text-text-muted">
                    <Loader2 size={12} className="animate-spin" /> Waiting for scan…
                  </p>
                </>
              ) : (
                <p className="inline-flex items-center gap-1.5 py-8 text-[13px] text-text-muted">
                  <Loader2 size={14} className="animate-spin" /> Generating pairing code…
                </p>
              )}
            </div>
          ) : !pickedKind ? (
            <div className="space-y-4">
              {CONNECTION_GROUPS.map((g) => {
                const items = CONNECTION_KINDS.filter((c) => c.group === g.id);
                if (items.length === 0) return null;
                return (
                  <div key={g.id}>
                    <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                      {g.label}
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      {items.map((c) => {
                        const Icon = c.icon;
                        return (
                          <button
                            key={c.kind}
                            type="button"
                            onClick={() => setPickedKind(c.kind)}
                            className="flex flex-col items-start gap-1.5 rounded-card border border-line bg-surface-2 p-3 text-left transition-colors hover:border-line-strong hover:bg-surface-3"
                          >
                            <Icon size={16} className="text-text-secondary" />
                            <span className="text-subheading text-text-primary">{c.label}</span>
                            <span className="text-[11px] text-text-muted">{c.desc}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <>
              <div>
                <button
                  type="button"
                  onClick={() => setPickedKind(null)}
                  className="text-[12px] text-text-muted hover:text-text-primary"
                >
                  ← Back
                </button>
              </div>
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                  Name
                </span>
                <input
                  autoFocus
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={`My ${picked?.label ?? pickedKind}`}
                  className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[14px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                />
              </label>
              {needsAgent && (
                <label className="block">
                  <span className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                    Owner
                  </span>
                  <select
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                    className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[14px] text-text-primary focus:border-accent focus:outline-none"
                  >
                    <option value="">Workspace — shared by all agents &amp; automation</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        Agent: {a.name}
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 block text-[11px] text-text-muted">
                    {agentId
                      ? 'This agent receives inbound messages and owns this channel.'
                      : 'Workspace channel: inbound routes to the orchestrator; workflows and any agent can send on it.'}
                  </span>
                </label>
              )}
              {picked?.flow === 'token' && (
                <label className="block">
                  <span className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                    Bot token
                  </span>
                  <input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="Paste token"
                    className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 font-mono text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                  />
                </label>
              )}
              {picked?.flow === 'gateway' && (
                <>
                  <label className="block">
                    <span className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                      Gateway URL
                    </span>
                    <input
                      type="text"
                      value={gatewayUrl}
                      onChange={(e) => setGatewayUrl(e.target.value)}
                      placeholder="wss://gateway.example.com/agent"
                      className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 font-mono text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                    />
                    <span className="mt-1 block text-[11px] text-text-muted">
                      Your OpenClaw gateway’s WebSocket URL. Agents connect through this.
                    </span>
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                      Device token
                    </span>
                    <input
                      type="password"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="Paste the gateway device token"
                      className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 font-mono text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                    />
                    <span className="mt-1 block text-[11px] text-text-muted">
                      Stored encrypted; never leaves this workspace.
                    </span>
                  </label>
                </>
              )}
              {picked?.flow === 'qr' && (
                <p className="text-[12px] text-text-muted">
                  No token needed — you'll scan a QR code with WhatsApp on the next step.
                </p>
              )}
            </>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-btn border border-line bg-transparent px-3 text-[13px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
          >
            {qr ? 'Done' : 'Cancel'}
          </button>
          {!qr && (
            <button
              type="submit"
              disabled={!pickedKind || !name.trim() || busy}
              className="inline-flex h-9 items-center rounded-btn bg-accent px-3 text-[13px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-60"
            >
              {busy ? 'Connecting…' : picked?.flow === 'qr' ? 'Get QR code' : 'Connect'}
            </button>
          )}
        </footer>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Budget tab
// ---------------------------------------------------------------------------

interface BudgetAgentRow {
  id: string;
  name: string;
  monthlyBudgetCents?: number | null;
  currentMonthSpendCents?: number | null;
}

interface BudgetEventRow {
  id: string;
  agentId: string;
  runId?: string | null;
  eventType: string;
  amountCents: number;
  createdAt: string;
}

interface BudgetData {
  agents: BudgetAgentRow[];
  events: BudgetEventRow[];
}

function budgetMoney(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function BudgetTab() {
  const toast = useToast();
  const [data, setData] = useState<BudgetData | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const res = await api<BudgetData>('/v1/budgets');
      setData({ agents: res.agents ?? [], events: res.events ?? [] });
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  function startEdit(agent: BudgetAgentRow) {
    setEditingId(agent.id);
    setEditValue(agent.monthlyBudgetCents != null ? String(agent.monthlyBudgetCents / 100) : '');
  }

  async function saveEdit(agentId: string) {
    setSaving(true);
    const dollars = parseFloat(editValue);
    const monthlyBudgetCents =
      isNaN(dollars) || editValue.trim() === '' ? null : Math.round(dollars * 100);
    try {
      await api(`/v1/budgets/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ monthlyBudgetCents }),
      });
      toast.success('Budget updated');
      setEditingId(null);
      void refresh();
    } catch (e) {
      toast.error('Failed to update', apiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Skeleton height={300} />;

  if (!data) {
    return (
      <div className="rounded-card border border-dashed border-line bg-surface/40 p-8 text-center text-[13px] text-text-muted">
        Could not load budget data.
      </div>
    );
  }

  const totalSpend = data.agents.reduce(
    (s, a) => s + Math.max(0, a.currentMonthSpendCents ?? 0),
    0,
  );
  const allCapped =
    data.agents.length > 0 && data.agents.every((a) => a.monthlyBudgetCents != null);
  const totalCap = allCapped
    ? data.agents.reduce((s, a) => s + (a.monthlyBudgetCents ?? 0), 0)
    : null;
  const recentEvents = [...data.events]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 20);

  function agentName(id: string) {
    return data!.agents.find((a) => a.id === id)?.name ?? id.slice(0, 8);
  }

  return (
    <div className="max-w-2xl space-y-6">
      {/* Summary strip */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-card border border-line bg-surface p-4">
          <div className="text-[11px] text-text-muted">This month's spend</div>
          <div className="mt-1 text-[20px] font-semibold text-text-primary">
            {budgetMoney(totalSpend)}
          </div>
        </div>
        <div className="rounded-card border border-line bg-surface p-4">
          <div className="text-[11px] text-text-muted">Monthly cap</div>
          <div className="mt-1 text-[20px] font-semibold text-text-primary">
            {totalCap != null ? (
              budgetMoney(totalCap)
            ) : (
              <span className="text-[14px] text-text-muted">None set</span>
            )}
          </div>
        </div>
        <div className="rounded-card border border-line bg-surface p-4">
          <div className="text-[11px] text-text-muted">Spend events</div>
          <div className="mt-1 text-[20px] font-semibold text-text-primary">
            {data.events.length}
          </div>
        </div>
      </div>

      {/* Per-agent limits */}
      <div>
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Per-agent limits
        </h2>
        {data.agents.length === 0 ? (
          <div className="rounded-card border border-dashed border-line bg-surface/40 p-6 text-center text-[13px] text-text-muted">
            No agents in this workspace.
          </div>
        ) : (
          <div className="space-y-1.5">
            {data.agents.map((agent) => {
              const spend = agent.currentMonthSpendCents ?? 0;
              const cap = agent.monthlyBudgetCents;
              const pct = cap != null && cap > 0 ? Math.min(100, (spend / cap) * 100) : 0;
              const isEditing = editingId === agent.id;
              return (
                <div
                  key={agent.id}
                  className="rounded-card border border-line bg-surface px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">
                      {agent.name}
                    </span>
                    <span className="text-[12px] text-text-secondary">
                      {budgetMoney(spend)} this month
                    </span>
                    {isEditing ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-[12px] text-text-muted">$</span>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="No cap"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          className="w-24 rounded-input border border-line bg-canvas px-2 py-1 text-[12px] text-text-primary outline-none focus:border-accent"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void saveEdit(agent.id);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                        />
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={saving}
                          onClick={() => void saveEdit(agent.id)}
                        >
                          Save
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] text-text-muted">
                          Cap: {cap != null ? budgetMoney(cap) : 'None'}
                        </span>
                        <Button variant="ghost" size="sm" onClick={() => startEdit(agent)}>
                          Edit
                        </Button>
                      </div>
                    )}
                  </div>
                  {cap != null && cap > 0 && (
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                      <div
                        className={clsx(
                          'h-full rounded-full transition-all',
                          pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-amber-400' : 'bg-accent',
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent spend events */}
      <div>
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Recent spend events
        </h2>
        {recentEvents.length === 0 ? (
          <div className="rounded-card border border-dashed border-line bg-surface/40 p-6 text-center text-[13px] text-text-muted">
            No spend events yet.
          </div>
        ) : (
          <div className="space-y-1">
            {recentEvents.map((event) => (
              <div
                key={event.id}
                className="flex items-center gap-3 rounded-card border border-line/70 bg-surface px-3 py-2"
              >
                <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-info" />
                <span className="min-w-0 flex-1 truncate text-[12px] text-text-secondary">
                  {agentName(event.agentId)}
                </span>
                <span className="text-[12px] font-medium text-text-primary">
                  {budgetMoney(event.amountCents)}
                </span>
                <span className="text-[11px] text-text-muted">
                  {new Date(event.createdAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
