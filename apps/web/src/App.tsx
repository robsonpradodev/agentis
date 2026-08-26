import { Routes, Route, Navigate, useNavigate, useParams, useLocation } from 'react-router-dom';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Check, Plus, ChevronDown, PackageOpen } from 'lucide-react';
import clsx from 'clsx';
import { LoginPage } from './pages/LoginPage';
import { LiveStrip } from './components/LiveStrip';
import { OnboardingStrip } from './components/OnboardingStrip';
import { Sidebar } from './components/Sidebar';
import { ChatPanelMount } from './components/chat/ChatPanelMount';
import { RealtimeStatusIndicator } from './components/shared/RealtimeStatusIndicator';
import { ChatPanelHeaderButton } from './components/chat/ChatPanelHeaderButton';
import { BrandMark } from './components/shared/BrandMark';
import { RunModalProvider } from './components/runs/RunModalProvider';
import { ApprovalModalProvider } from './components/shared/ApprovalModalProvider';
import { ConfirmProvider } from './components/shared/ConfirmDialog';
import { ErrorBoundary } from './components/shared/ErrorBoundary';
import { ToastProvider } from './components/shared/Toast';
import { openRunModal } from './lib/runModal';
import { tokens, workspace as wsStore, ambient as ambientStore, api, logout } from './lib/api';
import {
  LOCAL_BYPASS_LAUNCH_TOKEN,
  clearStoredLaunchToken,
  getLaunchTokenFromUrl,
  getStoredLaunchToken,
  isLocalLaunchOrigin,
  loginWithLaunchToken,
  probeServerReachable,
  removeLaunchTokenFromUrl,
  setStoredLaunchToken,
} from './lib/launchAuth';
import { useAgentisStore } from './store/agentisStore';
// Initialize theme on app boot
import './components/shared/ThemeToggle';

// §PERF-BOOT — the settings modal and its ~10 panels were statically imported,
// putting ~100 KB raw of settings UI into the entry chunk for a surface nobody
// sees at boot. It already renders null while closed; the cost was purely the
// import. Mounted lazily on first open instead.
const LazySettingsModal = lazy(() =>
  import('./components/settings/SettingsModal').then((m) => ({ default: m.SettingsModal })),
);
const LazyCommandPalette = lazy(() =>
  import('./components/CommandPalette').then((m) => ({ default: m.CommandPalette })),
);
const LazyNotificationPanel = lazy(() =>
  import('./components/shared/NotificationPanel').then((m) => ({ default: m.NotificationPanel })),
);
const LazyAvatarMenu = lazy(() =>
  import('./components/shared/AvatarMenu').then((m) => ({ default: m.AvatarMenu })),
);
const LazyWorkspaceRealtimeMount = lazy(() =>
  import('./lib/resourceRealtime').then((m) => ({ default: m.WorkspaceRealtimeMount })),
);

function SettingsModalMount() {
  const settingsOpen = useAgentisStore((s) => s.settingsOpen);
  if (!settingsOpen) return null;
  return (
    <Suspense fallback={null}>
      <LazySettingsModal />
    </Suspense>
  );
}

/** Full-screen brand boot/loading state — the mark breathes above a quiet label. */
type BootLabel = 'app.loading' | 'app.opening' | 'app.waitingForServer';

function BootScreen({ label }: { label: BootLabel }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-5 bg-canvas">
      <BrandMark size={48} className="s-pulse text-text-primary" />
      <span className="text-[12px] tracking-wide text-text-muted">{t(label)}</span>
    </div>
  );
}

const HomePage = lazy(() => import('./pages/HomePage').then((m) => ({ default: m.HomePage })));
const AppsPage = lazy(() => import('./pages/AppsPage').then((m) => ({ default: m.AppsPage })));
const AppEditorPage = lazy(() =>
  import('./pages/AppEditorPage').then((m) => ({ default: m.AppEditorPage })),
);
const WorkflowCanvasPage = lazy(() =>
  import('./pages/WorkflowCanvasPage').then((m) => ({ default: m.WorkflowCanvasPage })),
);
const PublicAppSurfacePage = lazy(() =>
  import('./pages/PublicAppSurfacePage').then((m) => ({ default: m.PublicAppSurfacePage })),
);
const GenUIShowcasePage = lazy(() =>
  import('./pages/GenUIShowcasePage').then((m) => ({ default: m.GenUIShowcasePage })),
);
const AgentsPage = lazy(() =>
  import('./pages/AgentsPage').then((m) => ({ default: m.AgentsPage })),
);
const AgentDetailPage = lazy(() =>
  import('./pages/AgentDetailPage').then((m) => ({ default: m.AgentDetailPage })),
);

const PackagesPage = lazy(() =>
  import('./pages/PackagesPage').then((m) => ({ default: m.PackagesPage })),
);
const BrainPage = lazy(() =>
  import('./pages/UnifiedBrainPage').then((m) => ({ default: m.UnifiedBrainPage })),
);
const KnowledgeBasePage = lazy(() =>
  import('./pages/KnowledgeBasePage').then((m) => ({ default: m.KnowledgeBasePage })),
);
const HistoryPage = lazy(() =>
  import('./pages/HistoryPage').then((m) => ({ default: m.HistoryPage })),
);
const WorkspacesPage = lazy(() =>
  import('./pages/WorkspacesPage').then((m) => ({ default: m.WorkspacesPage })),
);
const ChatPage = lazy(() => import('./pages/ChatPage').then((m) => ({ default: m.ChatPage })));
const ArtifactsPage = lazy(() =>
  import('./pages/ArtifactsPage').then((m) => ({ default: m.ArtifactsPage })),
);

interface Workspace {
  id: string;
  name: string;
  slug: string;
  imageUrl?: string | null;
}

interface OperatorMe {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string | null;
}

async function tryLaunchTokenAuth(
  token: string,
  options: { removeUrlToken?: boolean } = {},
): Promise<boolean> {
  try {
    await loginWithLaunchToken(token);
    if (options.removeUrlToken) removeLaunchTokenFromUrl();
    return true;
  } catch {
    return false;
  }
}

/** Shown while polling /healthz — the API binds its port late on big workspaces. */
const SERVER_WAIT_LABEL: BootLabel = 'app.waitingForServer';
const SERVER_RETRY_MS = 1_500;

export function App() {
  const location = useLocation();
  const [authed, setAuthed] = useState<boolean>(false);
  const [initializing, setInitializing] = useState<boolean>(true);
  const [initializingLabel, setInitializingLabel] = useState<BootLabel>('app.loading');
  const [ws, setWs] = useState<Workspace | null>(null);
  const [wsReady, setWsReady] = useState<boolean>(false);
  const [me, setMe] = useState<OperatorMe | null>(null);
  // §PERF-BOOT — bumping these re-runs the auth / workspace effects while the
  // server is still coming up, instead of treating "not up yet" as "rejected".
  const [initRetry, setInitRetry] = useState(0);
  const [wsRetry, setWsRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // §PERF-BOOT — a failed launch while the server is UNREACHABLE is not an
    // invalid token. The old path treated them identically, so opening the app
    // while the API was still booting cleared the stored launch token and
    // stranded the operator on the login form. Now: probe /healthz, keep the
    // token, keep the BootScreen, and retry until the server answers.
    const waitForServer = () => {
      if (cancelled) return;
      setInitializingLabel(SERVER_WAIT_LABEL);
      setTimeout(() => {
        if (!cancelled) setInitRetry((n) => n + 1);
      }, SERVER_RETRY_MS);
    };
    void (async () => {
      const urlToken = getLaunchTokenFromUrl();
      const hasAccessToken = Boolean(tokens.access());
      if (!urlToken && hasAccessToken) {
        setAuthed(true);
        setInitializing(false);
        return;
      }
      const launchToken = urlToken ?? (!hasAccessToken ? getStoredLaunchToken() : null);
      if (launchToken) {
        try {
          logout();
        } catch {
          /* noop */
        }
        setInitializingLabel('app.opening');
        const launched = await tryLaunchTokenAuth(launchToken, {
          removeUrlToken: Boolean(urlToken),
        });
        if (cancelled) return;
        if (launched) {
          setStoredLaunchToken(launchToken);
          setAuthed(true);
          setInitializing(false);
          return;
        }
        if (!(await probeServerReachable())) {
          waitForServer();
          return;
        }
        clearStoredLaunchToken();
      }

      if (!hasAccessToken && isLocalLaunchOrigin()) {
        try {
          logout();
        } catch {
          /* noop */
        }
        setInitializingLabel('app.opening');
        const launched = await tryLaunchTokenAuth(LOCAL_BYPASS_LAUNCH_TOKEN);
        if (cancelled) return;
        if (launched) {
          setAuthed(true);
          setInitializing(false);
          return;
        }
        if (!(await probeServerReachable())) {
          waitForServer();
          return;
        }
      }

      if (tokens.access()) {
        setAuthed(true);
        setInitializing(false);
        return;
      }
      if (cancelled) return;
      setInitializingLabel('app.loading');
      setInitializing(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [initRetry]);

  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    void (async () => {
      try {
        const [data, meData] = await Promise.all([
          api<{ workspaces: Workspace[] }>('/v1/workspaces'),
          api<{ user: OperatorMe }>('/v1/auth/me').catch(() => null),
        ]);
        if (cancelled) return;
        const current = wsStore.get();
        const picked = data.workspaces.find((w) => w.id === current) ?? data.workspaces[0] ?? null;
        if (picked) {
          wsStore.set(picked.id);
          useAgentisStore.getState().setContext(picked.id, ambientStore.get());
          setWs(picked);
        }
        if (meData?.user) {
          const user = meData.user as any;
          setMe({
            id: user.id,
            email: user.email ?? '',
            name: user.displayName ?? user.name ?? 'Operator',
            avatarUrl: user.avatarUrl,
          });
        }
        setWsReady(true);
      } catch {
        if (cancelled) return;
        // §PERF-BOOT — this catch used to treat EVERY failure as an auth
        // rejection: logout() destroyed valid tokens and the operator landed on
        // the login form whenever the API was merely still booting or briefly
        // restarting. Probe first; only a REACHABLE server that rejects us is
        // an auth problem.
        if (!(await probeServerReachable())) {
          if (cancelled) return;
          setInitializingLabel(SERVER_WAIT_LABEL);
          setTimeout(() => {
            if (!cancelled) setWsRetry((n) => n + 1);
          }, SERVER_RETRY_MS);
          return; // wsReady stays false → BootScreen keeps showing, tokens survive
        }
        logout();
        const launchToken = getStoredLaunchToken();
        if (launchToken) {
          setInitializingLabel('app.opening');
          const launched = await tryLaunchTokenAuth(launchToken);
          if (launched) {
            window.location.reload();
            return;
          }
          clearStoredLaunchToken();
        }
        if (cancelled) return;
        setAuthed(false);
        setWsReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authed, wsRetry]);

  if (location.pathname.startsWith('/public/apps/')) {
    return (
      <ErrorBoundary resetKey={location.pathname} label="This app couldn't be displayed">
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/public/apps/:token" element={<PublicAppSurfacePage />} />
            <Route path="*" element={<Navigate to="/public/apps/invalid" replace />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    );
  }

  // DEV-only GenUI gallery — renders the real ViewRenderer with an in-memory
  // client (no API/auth) so the surface vocabulary can be previewed in isolation.
  if (import.meta.env.DEV && location.pathname.startsWith('/genui-showcase')) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <GenUIShowcasePage />
      </Suspense>
    );
  }

  if (initializing) {
    return <BootScreen label={initializingLabel} />;
  }

  if (!authed) {
    return (
      <Routes>
        <Route
          path="*"
          element={
            <LoginPage
              onSuccess={() => {
                setWsReady(false);
                setAuthed(true);
              }}
            />
          }
        />
      </Routes>
    );
  }

  if (!wsReady) {
    // Shows the "waiting for server" message while /healthz polling is active.
    return (
      <BootScreen
        label={initializingLabel === SERVER_WAIT_LABEL ? SERVER_WAIT_LABEL : 'app.loading'}
      />
    );
  }

  return (
    <ToastProvider>
      <Suspense fallback={null}><LazyWorkspaceRealtimeMount /></Suspense>
      <ConfirmProvider>
        <RunModalProvider>
          <ApprovalModalProvider>
            <Shell
              workspaceName={ws?.name ?? '…'}
              workspaceImage={ws?.imageUrl ?? null}
              workspaceId={ws?.id ?? null}
              operator={me}
              onLogout={() => {
                logout();
                clearStoredLaunchToken();
                useAgentisStore.getState().clearContext();
                setAuthed(false);
                setWsReady(false);
              }}
            >
              <ErrorBoundary resetKey={location.pathname}>
                <Suspense fallback={<RouteFallback />}>
                  <Routes>
                    <Route path="/" element={<Navigate to="/home" replace />} />
                    <Route path="/home" element={<HomePage />} />
                    <Route path="/agents" element={<AgentsPage />} />
                    <Route path="/agents/:id" element={<AgentDetailPage />} />

                    <Route path="/apps" element={<AppsPage />} />
                    <Route path="/apps/workflows/:id" element={<WorkflowCanvasRoute />} />
                    <Route path="/apps/:id" element={<AppEditorPage />} />
                    <Route path="/apps/:id/build" element={<Navigate to="../" replace />} />
                    <Route path="/workflows" element={<Navigate to="/apps" replace />} />
                    <Route path="/workflows/build" element={<Navigate to="/apps" replace />} />
                    <Route path="/workflows/:id" element={<WorkflowLegacyRedirect />} />
                    <Route path="/brain/*" element={<BrainPage />} />
                    <Route path="/knowledge" element={<BrainPage />} />
                    <Route
                      path="/knowledge/bases/:knowledgeBaseId"
                      element={<KnowledgeBasePage />}
                    />
                    <Route path="/assets" element={<ArtifactsPage />} />
                    {/* Legacy alias — chat/share links still point at /artifacts. */}
                    <Route path="/artifacts" element={<ArtifactsPage />} />
                    <Route path="/abilities" element={<Navigate to="/agents" replace />} />
                    <Route path="/abilities/:id" element={<Navigate to="/brain" replace />} />
                    <Route path="/packages" element={<PackagesPage />} />
                    <Route path="/history" element={<HistoryPage />} />
                    {/* Approvals no longer have a page — they open in a global review modal
                  (ApprovalModalProvider). Legacy links redirect home. */}
                    <Route path="/approvals" element={<Navigate to="/home" replace />} />
                    <Route path="/runs/:id" element={<RunRouteBridge />} />
                    <Route path="/chat" element={<ChatPage />} />
                    <Route path="/chat/agent/:agentId" element={<ChatPage />} />
                    <Route path="/workspaces" element={<WorkspacesPage />} />
                    <Route path="/settings" element={<Navigate to="/home" replace />} />

                    {/* Backward-compat redirects */}
                    <Route path="/fleet" element={<Navigate to="/home" replace />} />
                    <Route path="/runs" element={<Navigate to="/history?tab=runs" replace />} />
                    <Route
                      path="/activity"
                      element={<Navigate to="/history?tab=activity" replace />}
                    />
                    <Route path="/spaces" element={<Navigate to="/home" replace />} />
                    <Route path="/spaces/:id" element={<Navigate to="/home" replace />} />
                    <Route path="/gateways" element={<Navigate to="/home" replace />} />
                    <Route path="/conversations" element={<ChatPage />} />
                    <Route path="/conversations/:agentId" element={<ChatPage />} />
                    <Route path="/settings/channels" element={<Navigate to="/home" replace />} />
                    <Route path="*" element={<Navigate to="/home" replace />} />
                  </Routes>
                </Suspense>
              </ErrorBoundary>
              <Suspense fallback={null}>
                <LazyCommandPalette />
              </Suspense>
              <SettingsModalMount />
            </Shell>
          </ApprovalModalProvider>
        </RunModalProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

function RouteFallback() {
  return (
    <div className="flex h-full items-center justify-center text-[13px] text-text-muted">
      Loading…
    </div>
  );
}

function RunRouteBridge() {
  const { id } = useParams<{ id: string }>();

  useEffect(() => {
    if (id) openRunModal({ runId: id, source: 'legacy-route' });
  }, [id]);

  return <Navigate to="/history?tab=runs" replace />;
}

function WorkflowLegacyRedirect() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  return <Navigate to={`/apps/workflows/${id ?? ''}${location.search}`} replace />;
}

/**
 * A workflow is the logic layer of an Agentic App, never a standalone destination.
 * Resolve the workflow's owning App and forward to it; only a legacy ownerless
 * workflow falls back to the raw canvas. This makes every `/apps/workflows/:id`
 * link (chat "Logic", run modal, packages, knowledge) land on the App.
 */
function WorkflowCanvasRoute() {
  const { id } = useParams<{ id: string }>();
  const [resolved, setResolved] = useState<{ loading: boolean; appId: string | null }>({
    loading: true,
    appId: null,
  });

  useEffect(() => {
    let cancelled = false;
    if (!id) {
      setResolved({ loading: false, appId: null });
      return;
    }
    setResolved({ loading: true, appId: null });
    api<{ workflow?: { appId?: string | null } }>(`/v1/workflows/${id}`)
      .then((res) => {
        if (!cancelled) setResolved({ loading: false, appId: res.workflow?.appId ?? null });
      })
      .catch(() => {
        if (!cancelled) setResolved({ loading: false, appId: null });
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (resolved.loading) return <RouteFallback />;
  if (resolved.appId) return <Navigate to={`/apps/${resolved.appId}`} replace />;
  return <WorkflowCanvasPage />;
}

function Shell({
  children,
  workspaceName,
  workspaceImage,
  workspaceId,
  operator,
  onLogout,
}: {
  children: React.ReactNode;
  workspaceName: string;
  workspaceImage: string | null;
  workspaceId: string | null;
  operator: OperatorMe | null;
  onLogout: () => void;
}) {
  const nav = useNavigate();
  const location = useLocation();
  const embedded = new URLSearchParams(location.search).get('embed') === '1';

  useEffect(() => {
    function onOpenCanvas(event: Event) {
      const detail = (event as CustomEvent<{ workflowId?: string; appId?: string | null }>).detail;
      // The App is the destination; the bare workflow canvas is only a fallback
      // for legacy ownerless workflows.
      if (detail?.appId) {
        nav(`/apps/${detail.appId}`);
        return;
      }
      if (!detail?.workflowId) return;
      nav(`/apps/workflows/${detail.workflowId}`);
    }
    window.addEventListener('agentis:open-canvas', onOpenCanvas);
    return () => window.removeEventListener('agentis:open-canvas', onOpenCanvas);
  }, [nav]);

  if (embedded) {
    return <main className="h-full min-h-0 bg-canvas">{children}</main>;
  }

  return (
    <div className="flex h-full flex-col bg-canvas" data-agentis-shell>
      <header
        data-agentis-shell-header
        className="flex h-12 min-w-0 shrink-0 items-center gap-3 border-b border-line bg-surface px-4"
      >
        <button
          onClick={() => nav('/home')}
          className="flex h-9 items-center text-text-primary"
          aria-label="Agentis home"
        >
          <BrandMark variant="full" size={18} />
        </button>
        <span className="text-text-muted">/</span>
        <WorkspaceSwitcher
          workspaceName={workspaceName}
          workspaceImage={workspaceImage}
          workspaceId={workspaceId}
        />
        <div className="ml-auto flex min-w-0 items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              const ev = new KeyboardEvent('keydown', { key: 'k', metaKey: true });
              window.dispatchEvent(ev);
            }}
            className="inline-flex h-9 w-9 items-center justify-center rounded-btn border border-line bg-surface-2 text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary"
            aria-label="Search"
            title="Search (⌘K)"
          >
            <Search size={14} />
          </button>
          <RealtimeStatusIndicator />
          <Suspense fallback={null}>
            <LazyNotificationPanel />
          </Suspense>
          <ChatPanelHeaderButton />
          <Suspense fallback={null}>
            <LazyAvatarMenu
              name={operator?.name ?? 'Operator'}
              email={operator?.email}
              imageUrl={operator?.avatarUrl ?? undefined}
              onLogout={onLogout}
            />
          </Suspense>
        </div>
      </header>
      <div data-agentis-onboarding-strip>
        <OnboardingStrip />
      </div>
      <div data-agentis-shell-layout className="flex min-h-0 min-w-0 flex-1">
        <Sidebar />
        <main data-agentis-shell-main className="min-h-0 min-w-0 flex-1 overflow-auto">
          {children}
        </main>
        <ChatPanelMount />
      </div>
      <div data-agentis-live-strip>
        <LiveStrip />
      </div>
    </div>
  );
}

function workspaceInitial(name: string): string {
  return (name?.[0] ?? '?').toUpperCase();
}

function WorkspaceSwitcher({
  workspaceName,
  workspaceImage,
  workspaceId,
}: {
  workspaceName: string;
  workspaceImage: string | null;
  workspaceId: string | null;
}) {
  const { setSettingsOpen } = useAgentisStore();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Workspace[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api<{ workspaces: Workspace[] }>('/v1/workspaces')
      .then((d) => {
        if (!cancelled) setItems(d.workspaces ?? []);
      })
      .catch(() => {});
    const onClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      cancelled = true;
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function pick(ws: Workspace) {
    if (ws.id === workspaceId) {
      setOpen(false);
      return;
    }
    wsStore.set(ws.id);
    setOpen(false);
    // Hard reload to re-fetch all workspace-scoped data cleanly.
    window.location.reload();
  }

  async function createWorkspace(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      const slug =
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || `workspace-${Date.now().toString(36)}`;
      const res = await api<{ workspace: Workspace }>('/v1/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name, slug }),
      });
      wsStore.set(res.workspace.id);
      setNewName('');
      setCreating(false);
      window.location.reload();
    } catch {
      // Toast would be nice here but the parent owns ToastProvider context.
      setCreating(false);
    }
  }

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          'flex items-center gap-2 rounded-md px-1.5 py-0.5 text-[13px] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary',
          open && 'bg-surface-2 text-text-primary',
        )}
      >
        {workspaceImage ? (
          <img src={workspaceImage} alt="" className="h-5 w-5 rounded-md object-cover" />
        ) : (
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-surface-2 text-[10px] font-semibold text-text-primary">
            {workspaceInitial(workspaceName)}
          </span>
        )}
        {workspaceName}
        <ChevronDown size={12} className="text-text-muted" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-card border border-line bg-surface shadow-dropdown">
          <div className="max-h-72 overflow-y-auto py-1">
            {items.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-text-muted">Loading…</div>
            ) : (
              items.map((w) => {
                const isActive = w.id === workspaceId;
                return (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => pick(w)}
                    className={clsx(
                      'flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors',
                      isActive
                        ? 'bg-surface-2 text-text-primary'
                        : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary',
                    )}
                  >
                    {w.imageUrl ? (
                      <img src={w.imageUrl} alt="" className="h-5 w-5 rounded-md object-cover" />
                    ) : (
                      <span className="flex h-5 w-5 items-center justify-center rounded-md bg-surface-2 text-[10px] font-semibold text-text-primary">
                        {workspaceInitial(w.name)}
                      </span>
                    )}
                    <span className="flex-1 truncate">{w.name}</span>
                    {isActive && <Check size={12} className="text-accent" />}
                  </button>
                );
              })
            )}
          </div>
          <div className="border-t border-line">
            {creating ? (
              <form onSubmit={createWorkspace} className="flex gap-1.5 p-2">
                <input
                  autoFocus
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setCreating(false);
                      setNewName('');
                    }
                  }}
                  placeholder="Workspace name"
                  className="h-7 flex-1 rounded-input border border-line bg-surface-2 px-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={!newName.trim()}
                  className="inline-flex h-7 items-center rounded-btn bg-accent px-2 text-[11px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-50"
                >
                  Add
                </button>
              </form>
            ) : (
              <div className="grid grid-cols-2 gap-1.5 border-t border-line p-2">
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="group flex min-h-[62px] min-w-0 flex-col items-start gap-1 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors hover:border-line hover:bg-surface-2"
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-2 text-text-muted transition-colors group-hover:bg-surface-3 group-hover:text-text-primary">
                    <Plus size={13} />
                  </span>
                  <span className="text-[11px] font-medium leading-tight text-text-secondary group-hover:text-text-primary">New workspace</span>
                  <span className="text-[10px] leading-tight text-text-muted">Start fresh</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    navigate('/workspaces');
                  }}
                  className="group flex min-h-[62px] min-w-0 flex-col items-start gap-1 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors hover:border-accent/30 hover:bg-accent-soft/30"
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent-soft text-accent transition-colors group-hover:bg-accent group-hover:text-canvas">
                    <PackageOpen size={13} />
                  </span>
                  <span className="text-[11px] font-medium leading-tight text-text-secondary group-hover:text-text-primary">Import workspace</span>
                  <span className="text-[10px] leading-tight text-text-muted">.agentis bundle</span>
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setSettingsOpen(true, 'workspace');
              }}
              className="block w-full border-t border-line px-3 py-2 text-left text-[11px] text-text-muted hover:bg-surface-2 hover:text-text-primary"
            >
              Manage workspace settings →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
