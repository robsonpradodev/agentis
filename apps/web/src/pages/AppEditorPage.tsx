/**
 * AppEditorPage — the single editor for an Agentic App (route `/apps/:id`).
 *
 * One primitive, one page. Interface, Workflow, Data, Brain, and Runtime remain
 * first-class facets of the App. Interface can temporarily fill the workspace
 * when someone wants to focus on the product itself.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  ArrowLeft,
  BrainCircuit,
  Boxes,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  Database,
  Download,
  Eye,
  History,
  LayoutGrid,
  Loader2,
  Maximize2,
  MessageSquare,
  MoreVertical,
  Minimize2,
  Pencil,
  Plus,
  Save,
  Settings,
  Sparkles,
  Trash2,
  Upload,
  X,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import clsx from 'clsx';
import type {
  AppRecord,
  AppSurface,
  CollectionInfo,
  DesignLanguage,
  SurfaceAction,
  SurfaceKind,
  ViewNode,
} from '@agentis/core';
import { DESIGN_LANGUAGES } from '../components/apps/designLanguage';
import { appsApi, type AgenticAppBuild, type AppUpdatePayload } from '../lib/appsApi';
import { useAgentisStore } from '../store/agentisStore';
import { REALTIME_EVENTS } from '@agentis/core';
import { api, apiErrorMessage, apiText } from '../lib/api';
import { assembleManagedFrontendSrcDoc } from '../lib/managedFrontend';
import { rtSubscribe, useRealtime, type RealtimeEnvelope } from '../lib/realtime';
import { useResourceRevision } from '../lib/resourceRealtime';
import { ArtifactPanel } from '../components/ArtifactPanel/ArtifactPanel';
import type { Artifact } from '../components/ArtifactPanel/types';
import { AppRuntime } from '../components/apps/AppRuntime';
import { AppDataGrid } from '../components/apps/AppDataGrid';
import {
  AppEngineModal,
  type AppEngineDomain,
  type AppEngineAgent,
} from '../components/apps/AppEngineModal';
import { SurfaceCanvas } from '../components/apps/SurfaceCanvas';
import {
  SURFACE_GROUPS,
  buildBlock,
  isBlockKind,
  type BlockKind,
  type ElementKind,
  type PaletteItem,
} from '../components/apps/surfaceTemplates';
import {
  addChildAtPath,
  appendNode,
  canHaveChildren,
  emptySurfaceView,
  getNodeAtPath,
  parseViewDraft,
  pathToLastChild,
  removeNodeAtPath,
  updateNodeAtPath,
} from '../components/apps/viewTree';
import { SurfaceBuilder } from '../components/apps/SurfaceBuilder';
import { WorkflowCanvasPage, WorkflowBrainTab } from './WorkflowCanvasPage';
import { SegmentedControl, type SegmentDef } from '../components/shared/SegmentedControl';
import { useConfirm } from '../components/shared/ConfirmDialog';
import { ErrorBoundary } from '../components/shared/ErrorBoundary';

type AppFacet = 'interface' | 'workflow' | 'data' | 'brain';

interface WorkflowRef {
  id: string;
  title: string;
}

function workflowFilename(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'workflow'
  );
}

// When the orchestrator builds/edits a workflow, these arrive on the workspace
// room. The App view reacts so a created/edited workflow shows up LIVE instead of
// only after a manual reload.
const BUILD_REVEAL_EVENTS = [
  REALTIME_EVENTS.WORKFLOW_BUILD_PHASE,
  REALTIME_EVENTS.CANVAS_NODE_PLACED,
  REALTIME_EVENTS.CANVAS_BUILD_COMPLETE,
];
const INTERFACE_REVEAL_EVENTS = [
  REALTIME_EVENTS.SURFACE_RENDER,
  REALTIME_EVENTS.SURFACE_PATCH,
  REALTIME_EVENTS.SURFACE_DELETED,
  REALTIME_EVENTS.INTERFACE_PUBLISHED,
];

export function AppEditorPage() {
  const resourceRevision = useResourceRevision(['apps', 'workflows', 'interfaces', 'appData']);
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [app, setApp] = useState<AppRecord | null>(null);
  const [surfaces, setSurfaces] = useState<AppSurface[]>([]);
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowRef[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  // `load` is intentionally stable across query-string changes; retain the
  // latest deep-link target without forcing a complete App refetch whenever
  // the workflow switcher updates the URL.
  const requestedWorkflowIdRef = useRef<string | null>(searchParams.get('workflow'));
  useEffect(() => {
    requestedWorkflowIdRef.current = searchParams.get('workflow');
  }, [searchParams]);
  // Bumped when a build of the shown workflow completes, to hard-refresh the
  // embedded canvas onto the final persisted graph even if its own live link
  // missed the stream.
  const [canvasReloadKey, setCanvasReloadKey] = useState(0);
  const [selectedSurface, setSelectedSurface] = useState<string | null>(null);
  const [surfaceDraft, setSurfaceDraft] = useState('');
  const [surfaceActionsDraft, setSurfaceActionsDraft] = useState<SurfaceAction[]>([]);
  const [previewKey, setPreviewKey] = useState(0);
  const [nameDraft, setNameDraft] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [engineOpen, setEngineOpen] = useState(false);
  const [interfaceFullscreen, setInterfaceFullscreen] = useState(false);
  const [domains, setDomains] = useState<AppEngineDomain[]>([]);
  const [agents, setAgents] = useState<AppEngineAgent[]>([]);
  const facets = useMemo<ReadonlyArray<SegmentDef<AppFacet>>>(
    () => [
      { value: 'interface', label: t('appEditor.interface'), icon: <LayoutGrid size={13} /> },
      { value: 'workflow', label: t('appEditor.workflow'), icon: <WorkflowIcon size={13} /> },
      { value: 'data', label: t('appEditor.data'), icon: <Database size={13} /> },
      { value: 'brain', label: t('appEditor.brain'), icon: <BrainCircuit size={13} /> },
    ],
    [t],
  );

  // Org options for the App Engine modal (Domain/Owner assignment). Auxiliary —
  // failure here must not block the editor, so it loads independently.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api<{ data: AppEngineDomain[] }>('/v1/domains')
        .then((r) => r.data ?? [])
        .catch(() => [] as AppEngineDomain[]),
      api<{ agents: AppEngineAgent[] }>('/v1/agents')
        .then((r) => r.agents ?? [])
        .catch(() => [] as AppEngineAgent[]),
    ]).then(([domainRows, agentRows]) => {
      if (cancelled) return;
      setDomains(domainRows);
      setAgents(agentRows);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [appRow, surfaceRows, collectionRows, workflowSummaries] = await Promise.all([
        appsApi.get(id),
        appsApi.listSurfaces(id),
        appsApi.listCollections(id),
        appsApi.listWorkflows(id),
      ]);
      setApp(appRow);
      setNameDraft(appRow.name);
      setSurfaces(surfaceRows);
      setCollections(collectionRows);
      // The control-plane summary already carries id + title — no per-workflow fetch.
      const refs: WorkflowRef[] = workflowSummaries.map((w) => ({ id: w.id, title: w.title }));
      setWorkflows(refs);
      // Register real names so id-only surfaces (the "Viewing" pill) can resolve
      // "App · <name>" instead of showing the raw app/workflow id.
      const { registerResourceName } = useAgentisStore.getState();
      registerResourceName('app', appRow.id, appRow.name);
      for (const w of refs) registerResourceName('workflow', w.id, w.title);
      // Preserve a deep-linked workflow when it belongs to this App. The
      // current selection wins during ordinary refreshes; a stale selection
      // falls back to the URL target and then the first workflow.
      const requestedWorkflowId = requestedWorkflowIdRef.current;
      setSelectedWorkflowId((current) =>
        current && refs.some((workflow) => workflow.id === current)
          ? current
          : requestedWorkflowId && refs.some((workflow) => workflow.id === requestedWorkflowId)
            ? requestedWorkflowId
            : (refs[0]?.id ?? null),
      );
      setSelectedSurface((current) =>
        current && surfaceRows.some((surface) => surface.name === current)
          ? current
          : (surfaceRows[0]?.name ?? null),
      );
      setLoaded(true);
    } catch (e) {
      setError(apiErrorMessage(e));
      setLoaded(true);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load, resourceRevision]);

  // Keep the workspace room subscription alive so live build events reach us.
  useEffect(() => rtSubscribe('workspace', {}), []);

  // Live build reveal — the core fix for "when the agent creates things it does
  // not update in realtime". When the orchestrator builds or edits a workflow
  // watches it stream node-by-node; on completion, refresh so a brand-new
  // workflow appears in the switcher with its final graph.
  //
  // WORKFLOW_BUILD_PHASE fires ('analyzing'/'drafting'/'repairing'/'reviewing')
  // well before the workflow row is inserted (build.ts persists it right before
  // the node-placement loop). Selecting the canvas that early 404s the embedded
  // WorkflowCanvasPage's fetch and it never recovers — so only reveal on
  // CANVAS_NODE_PLACED/CANVAS_BUILD_COMPLETE, which are only ever published
  // after the row exists.
  const revealedBuildRef = useRef<string | null>(null);
  useRealtime(BUILD_REVEAL_EVENTS, (env: RealtimeEnvelope) => {
    if (env.event === REALTIME_EVENTS.WORKFLOW_BUILD_PHASE) return;
    const payload = (env.payload ?? {}) as { workflowId?: string; appId?: string };
    const wfId = payload.workflowId;
    if (!wfId) return;
    const known = workflows.some((w) => w.id === wfId);
    if (!known && payload.appId !== id) return; // not this App's build
    setSelectedWorkflowId(wfId);
    // on every phase if they navigate away while it streams.
    if (revealedBuildRef.current !== wfId) {
      revealedBuildRef.current = wfId;
      setFacet('workflow');
    }
    if (env.event === REALTIME_EVENTS.CANVAS_BUILD_COMPLETE) {
      void load();
      setCanvasReloadKey((k) => k + 1);
      revealedBuildRef.current = null; // let the next build reveal again
    }
  });

  // Surface creation/deletion/replacement and atomic interface publishes update
  // the editor immediately, including changes made by a chat agent.
  useRealtime(INTERFACE_REVEAL_EVENTS, (env: RealtimeEnvelope) => {
    const payload = (env.payload ?? {}) as { appId?: string };
    if (payload.appId !== id) return;
    void load();
    setPreviewKey((key) => key + 1);
  });

  // Deep-link from the /home canvas highlight ("Settings") opens straight into
  // the engine modal so Domain/Owner is one click away. Consume the flag once.
  useEffect(() => {
    if (searchParams.get('engine') !== '1') return;
    setEngineOpen(true);
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        next.delete('engine');
        return next;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams]);

  const facetParam = searchParams.get('facet') as AppFacet | null;
  const facet: AppFacet = facetParam && facets.some((item) => item.value === facetParam)
    ? facetParam
    : 'interface';

  useEffect(() => {
    if (facet !== 'workflow' || !selectedWorkflowId) return;
    setSearchParams((params) => {
      if (params.get('workflow') === selectedWorkflowId) return params;
      const next = new URLSearchParams(params);
      next.set('workflow', selectedWorkflowId);
      return next;
    }, { replace: true });
  }, [facet, selectedWorkflowId, setSearchParams]);

  const setFacet = useCallback(
    (value: AppFacet) => {
      setInterfaceFullscreen(false);
      setSearchParams(
        (params) => {
          const next = new URLSearchParams(params);
          next.set('facet', value);
          // `page`, `mode`, and `node` belong to the embedded interface runtime.
          // Keeping them while another facet is visible makes chat context describe
          // a stale surface instead of the workflow/data/brain currently on screen.
          if (value !== 'interface') {
            next.delete('page');
            next.delete('mode');
            next.delete('node');
          }
          if (value !== 'workflow') next.delete('workflow');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  useEffect(() => {
    if (!interfaceFullscreen) return;
    const exit = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setInterfaceFullscreen(false);
    };
    document.addEventListener('keydown', exit);
    return () => document.removeEventListener('keydown', exit);
  }, [interfaceFullscreen]);

  const currentSurface = useMemo(
    () => surfaces.find((s) => s.name === selectedSurface) ?? null,
    [surfaces, selectedSurface],
  );
  useEffect(() => {
    if (currentSurface) {
      setSurfaceDraft(JSON.stringify(currentSurface.view ?? emptySurfaceView(), null, 2));
      setSurfaceActionsDraft(currentSurface.actions ?? []);
    }
  }, [currentSurface]);

  // ── Actions ──────────────────────────────────────────────

  const commitName = useCallback(async () => {
    setEditingName(false);
    const next = nameDraft.trim();
    if (!app || !next || next === app.name) return;
    try {
      const updated = await appsApi.update(id, { name: next });
      setApp(updated);
    } catch (e) {
      setStatus(apiErrorMessage(e));
      setNameDraft(app.name);
    }
  }, [app, id, nameDraft]);

  const saveAppSettings = useCallback(
    async (patch: AppUpdatePayload) => {
      try {
        const updated = await appsApi.update(id, patch);
        setApp(updated);
        setNameDraft(updated.name);
        setStatus('Saved');
        return updated;
      } catch (e) {
        setStatus(apiErrorMessage(e));
        throw e;
      }
    },
    [id],
  );

  const addWorkflow = useCallback(async () => {
    setBusy('workflow');
    setStatus(null);
    try {
      const created = await api<{ workflow: { id: string; title: string } }>('/v1/workflows', {
        method: 'POST',
        body: JSON.stringify({ title: `${app?.name ?? 'App'} workflow ${workflows.length + 1}` }),
      });
      await appsApi.adoptWorkflow(id, created.workflow.id);
      await load();
      setSelectedWorkflowId(created.workflow.id);
      setFacet('workflow');
    } catch (e) {
      setStatus(apiErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [app, id, load, setFacet, workflows.length]);

  const renameWorkflow = useCallback(async (workflowId: string, title: string) => {
    const nextTitle = title.trim();
    if (!nextTitle) return;
    try {
      await api(`/v1/workflows/${workflowId}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: nextTitle }),
      });
      setWorkflows((current) =>
        current.map((workflow) =>
          workflow.id === workflowId ? { ...workflow, title: nextTitle } : workflow,
        ),
      );
      setStatus('Saved');
    } catch (e) {
      setStatus(apiErrorMessage(e));
      throw e;
    }
  }, []);

  const exportWorkflow = useCallback(async (workflow: WorkflowRef) => {
    setBusy('workflow-export');
    setStatus(null);
    try {
      const yaml = await apiText(`/v1/workflows/${workflow.id}/export`);
      const blob = new Blob([yaml], { type: 'text/yaml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${workflowFilename(workflow.title)}.workflow.yaml`;
      link.click();
      URL.revokeObjectURL(url);
      setStatus(`Exported ${workflow.title}`);
    } catch (e) {
      setStatus(apiErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const importWorkflow = useCallback(
    async (file: File) => {
      setBusy('workflow-import');
      setStatus(null);
      try {
        const yaml = await file.text();
        if (!yaml.trim()) throw new Error('The workflow file is empty');
        const imported = await api<{ workflowId: string; title: string }>('/v1/workflows/import', {
          method: 'POST',
          body: JSON.stringify({ yaml }),
        });
        await appsApi.adoptWorkflow(id, imported.workflowId);
        await load();
        setSelectedWorkflowId(imported.workflowId);
        setFacet('workflow');
        setStatus(`Imported ${imported.title}`);
      } catch (e) {
        setStatus(apiErrorMessage(e));
      } finally {
        setBusy(null);
      }
    },
    [id, load, setFacet],
  );

  const createSurface = useCallback(async () => {
    setBusy('surface');
    setStatus(null);
    try {
      const name = uniqueName(
        'surface',
        surfaces.map((s) => s.name),
      );
      // A new interface starts EMPTY and opens in Edit mode — you (or the agent on
      // request) build it from scratch, instead of dropping a generic template.
      await appsApi.upsertSurface(id, {
        name,
        kind: 'page',
        view: emptySurfaceView(),
        actions: [],
      });
      await load();
      setSelectedSurface(name);
      setFacet('interface');
    } catch (e) {
      setStatus(apiErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [id, load, setFacet, surfaces]);

  const renameSurface = useCallback(
    async (currentName: string, nextName: string) => {
      const trimmed = nextName.trim();
      if (!trimmed || trimmed === currentName) return;
      try {
        const updated = await appsApi.renameSurface(id, currentName, trimmed);
        setSurfaces((current) =>
          current.map((surface) => (surface.name === currentName ? updated : surface)),
        );
        setSelectedSurface(updated.name);
        setStatus('Saved');
      } catch (e) {
        setStatus(apiErrorMessage(e));
        throw e;
      }
    },
    [id],
  );

  const saveSurface = useCallback(async () => {
    if (!currentSurface) return;
    let view: unknown;
    try {
      view = JSON.parse(surfaceDraft);
    } catch {
      setStatus('Invalid JSON');
      return;
    }
    setBusy('surface-save');
    setStatus(null);
    try {
      await appsApi.upsertSurface(id, {
        name: currentSurface.name,
        kind: currentSurface.kind,
        view,
        actions: surfaceActionsDraft,
      });
      setStatus('Saved');
      setPreviewKey((k) => k + 1);
      await load();
    } catch (e) {
      setStatus(apiErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [currentSurface, id, load, surfaceActionsDraft, surfaceDraft]);

  const updateSurfaceMeta = useCallback(
    async (patch: { kind?: SurfaceKind; shareable?: boolean }) => {
      if (!currentSurface) return;
      setBusy('surface-save');
      setStatus(null);
      try {
        await appsApi.upsertSurface(id, {
          name: currentSurface.name,
          kind: patch.kind ?? currentSurface.kind,
          view: parseViewDraft(surfaceDraft) ?? currentSurface.view ?? emptySurfaceView(),
          actions: surfaceActionsDraft,
          shareable: patch.shareable ?? currentSurface.shareable,
        });
        setStatus('Saved');
        await load();
      } catch (e) {
        setStatus(apiErrorMessage(e));
      } finally {
        setBusy(null);
      }
    },
    [currentSurface, id, load, surfaceActionsDraft, surfaceDraft],
  );

  const duplicateSurface = useCallback(async () => {
    if (!currentSurface) return;
    setBusy('surface');
    setStatus(null);
    try {
      const name = uniqueName(
        `${currentSurface.name}-copy`,
        surfaces.map((s) => s.name),
      );
      await appsApi.upsertSurface(id, {
        name,
        kind: currentSurface.kind,
        view: parseViewDraft(surfaceDraft) ?? currentSurface.view ?? emptySurfaceView(),
        actions: surfaceActionsDraft,
        shareable: currentSurface.shareable,
      });
      await load();
      setSelectedSurface(name);
      setStatus('Duplicated');
    } catch (e) {
      setStatus(apiErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [currentSurface, id, load, surfaceActionsDraft, surfaceDraft, surfaces]);

  const deleteSurface = useCallback(
    async (surfaceName: string) => {
      setBusy('surface');
      setStatus(null);
      try {
        await appsApi.removeSurface(id, surfaceName);
        if (currentSurface?.name === surfaceName) {
          const next = surfaces.find((surface) => surface.name !== surfaceName)?.name ?? null;
          setSelectedSurface(next);
        }
        await load();
        setStatus('Deleted');
      } catch (e) {
        setStatus(apiErrorMessage(e));
      } finally {
        setBusy(null);
      }
    },
    [currentSurface, id, load, surfaces],
  );

  const deleteWorkflow = useCallback(
    async (workflowId: string) => {
      setBusy('workflow');
      setStatus(null);
      try {
        await api(`/v1/workflows/${workflowId}`, { method: 'DELETE' });
        await load();
        setStatus('Deleted workflow');
      } catch (e) {
        setStatus(apiErrorMessage(e));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  // ── Render ───────────────────────────────────────────────

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted">
        <Loader2 className="animate-spin" />
      </div>
    );
  }
  if (error || !app) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-text-muted">
        <span>{error ?? t('appEditor.appNotFound')}</span>
        <button
          type="button"
          onClick={() => navigate('/apps')}
          className="rounded-btn border border-line px-3 py-1 text-text-secondary hover:bg-canvas"
        >
          {t('appEditor.backToApps')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {/* Slim command strip — mirrors the workflow canvas chrome. */}
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2">
        <button
          onClick={() => navigate('/apps')}
          className="inline-flex items-center gap-1 text-[12px] text-text-muted transition-colors hover:text-text-primary"
        >
          <ArrowLeft size={12} /> Apps
        </button>
        <div className="mx-2 h-4 w-px bg-line" />
        {editingName ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => void commitName()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitName();
              if (e.key === 'Escape') {
                setNameDraft(app.name);
                setEditingName(false);
              }
            }}
            className="h-7 rounded-md border border-line bg-surface-2 px-2 text-[13px] font-medium text-text-primary focus:border-accent focus:outline-none"
          />
        ) : (
          <button
            onClick={() => setEditingName(true)}
            className="max-w-[min(22rem,45vw)] truncate rounded-md px-1.5 py-0.5 text-[13px] font-medium text-text-primary hover:bg-surface-2"
          >
            {app.name}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setEngineOpen(true);
          }}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
          title="App engine"
          aria-label="App engine"
        >
          <Settings size={13} />
        </button>
        <span className="text-[11px] text-text-muted">
          v{app.version} · {app.status}
        </span>
        <div className="ml-auto flex min-w-0 items-center justify-end gap-2">
          {status ? (
            <span className="max-w-[180px] truncate text-[11px] text-text-muted">{status}</span>
          ) : null}
          {facet === 'interface' ? (
            <button
              type="button"
              onClick={() => setInterfaceFullscreen(true)}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
              title="Open interface full screen"
              aria-label="Open interface full screen"
            >
              <Maximize2 size={12} />
            </button>
          ) : null}
          <SegmentedControl
            segments={facets}
            value={facet}
            onChange={setFacet}
            size="sm"
            className="min-w-0 flex-wrap justify-end"
          />
        </div>
      </div>

      {/* Facet body — each fills the remaining height. A render error in one
          facet (e.g. a malformed surface) is caught here so the app header +
          facet tabs stay usable and switching tabs recovers. */}
      <ErrorBoundary resetKey={facet} label="This view hit an error">
        <div className={clsx('h-full min-h-0 flex-1 overflow-hidden', interfaceFullscreen && facet === 'interface' && 'fixed inset-0 z-[80] bg-canvas')}>
          {facet === 'interface' && (
            <InterfaceFacet
              appId={id}
              surfaces={surfaces}
              selected={selectedSurface}
              current={currentSurface}
              draft={surfaceDraft}
              actions={surfaceActionsDraft}
              busy={busy === 'surface-save'}
              previewKey={previewKey + resourceRevision}
              creating={busy === 'surface'}
              collections={collections}
              onSelect={setSelectedSurface}
              onDraftChange={setSurfaceDraft}
              onActionsChange={setSurfaceActionsDraft}
              onCreate={() => void createSurface()}
              onRename={renameSurface}
              onSave={() => void saveSurface()}
              onUpdateSurface={(patch) => void updateSurfaceMeta(patch)}
              onDuplicateSurface={() => void duplicateSurface()}
              onDeleteSurface={(name) => void deleteSurface(name)}
            />
          )}
          {facet === 'workflow' && (
            <WorkflowFacet
              workflows={workflows}
              selectedId={selectedWorkflowId}
              reloadKey={canvasReloadKey}
              busy={busy?.startsWith('workflow') ?? false}
              onSelect={setSelectedWorkflowId}
              onAdd={() => void addWorkflow()}
              onRename={renameWorkflow}
              onExport={(workflow) => void exportWorkflow(workflow)}
              onImport={(file) => void importWorkflow(file)}
              onDelete={(workflowId) => void deleteWorkflow(workflowId)}
            />
          )}
          {facet === 'data' && <DataFacet collections={collections} appId={id} />}
          {facet === 'brain' && <BrainFacet app={app} />}
          {interfaceFullscreen && facet === 'interface' ? (
            <button
              type="button"
              onClick={() => setInterfaceFullscreen(false)}
              className="fixed right-3 top-3 z-[90] inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-black/70 text-white/75 shadow-lg backdrop-blur-xl transition hover:bg-black/90 hover:text-white"
              title="Return to App"
              aria-label="Return to App"
            >
              <Minimize2 size={13} />
            </button>
          ) : null}
        </div>
      </ErrorBoundary>
      <AppEngineModal
        open={engineOpen}
        app={app}
        surfaces={surfaces}
        domains={domains}
        agents={agents}
        onClose={() => setEngineOpen(false)}
        onSave={saveAppSettings}
        onDeleted={() => {
          setEngineOpen(false);
          navigate('/apps');
        }}
      />
    </div>
  );
}

// ── Workflow facet — switcher + the real embedded canvas ─────

function WorkflowFacet({
  workflows,
  selectedId,
  reloadKey,
  busy,
  onSelect,
  onAdd,
  onRename,
  onExport,
  onImport,
  onDelete,
}: {
  workflows: WorkflowRef[];
  selectedId: string | null;
  /** Bumped after a build completes so the embedded canvas remounts onto the latest persisted graph. */
  reloadKey: number;
  busy: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: (workflowId: string, title: string) => Promise<void>;
  onExport: (workflow: WorkflowRef) => void;
  onImport: (file: File) => void;
  onDelete: (workflowId: string) => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  function startRename(workflow: WorkflowRef) {
    setRenamingId(workflow.id);
    setTitleDraft(workflow.title);
  }

  async function commitRename(workflow: WorkflowRef) {
    const nextTitle = titleDraft.trim();
    if (!nextTitle || nextTitle === workflow.title) {
      setRenamingId(null);
      return;
    }
    try {
      await onRename(workflow.id, nextTitle);
      setRenamingId(null);
    } catch {
      // The page header carries the request failure without discarding the draft.
    }
  }

  if (workflows.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center justify-end border-b border-line bg-surface px-3 py-1.5">
          <input
            ref={importInputRef}
            type="file"
            accept=".yaml,.yml,text/yaml,application/x-yaml"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) onImport(file);
            }}
          />
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            disabled={busy}
            className="inline-flex h-7 items-center gap-1 rounded-btn border border-line px-2 text-[12px] text-text-secondary hover:bg-canvas disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            {t('appEditor.importWorkflow')}
          </button>
        </div>
        <FacetEmpty
          icon={<WorkflowIcon size={30} />}
          title={t('appEditor.noWorkflow')}
          body={t('appEditor.noWorkflowDescription')}
          action={{ label: t('appEditor.createWorkflow'), busy, onClick: onAdd }}
        />
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label={t('appEditor.appWorkflows')}
        className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line bg-surface px-3 py-1.5"
      >
        {workflows.map((wf) => (
          <div
            key={wf.id}
            className={clsx(
              'group flex h-7 shrink-0 items-center rounded-btn text-[12px] font-medium transition-colors',
              selectedId === wf.id
                ? 'bg-accent-soft text-accent'
                : 'text-text-muted hover:bg-canvas hover:text-text-primary',
            )}
          >
            {renamingId === wf.id ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={() => void commitRename(wf)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void commitRename(wf);
                  if (event.key === 'Escape') setRenamingId(null);
                }}
                className="h-6 w-40 rounded-md border border-line bg-surface px-2 text-[12px] text-text-primary outline-none focus:border-accent"
                aria-label={t('appEditor.workflowTitle')}
              />
            ) : (
              <button
                role="tab"
                aria-selected={selectedId === wf.id}
                type="button"
                onClick={() => onSelect(wf.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenuOpenId(wf.id);
                }}
                className="h-7 max-w-52 truncate px-2.5 text-left"
              >
                {wf.title}
              </button>
            )}
            {renamingId !== wf.id ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => startRename(wf)}
                className="rounded-btn p-1 text-text-muted opacity-0 hover:bg-canvas hover:text-text-primary group-hover:opacity-100 disabled:cursor-wait disabled:opacity-50"
                title={t('appEditor.renameWorkflow', { name: wf.title })}
                aria-label={t('appEditor.renameWorkflow', { name: wf.title })}
              >
                <Pencil size={11} />
              </button>
            ) : null}
            {renamingId !== wf.id ? (
              <DropdownMenu.Root
                open={menuOpenId === wf.id}
                onOpenChange={(open) => setMenuOpenId(open ? wf.id : null)}
              >
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    disabled={busy}
                    className={clsx(
                      'rounded-btn p-1 hover:bg-canvas disabled:cursor-wait disabled:opacity-50',
                      menuOpenId === wf.id
                        ? 'opacity-100 text-text-primary'
                        : 'opacity-0 group-hover:opacity-100 text-text-muted',
                    )}
                    title={t('appEditor.moreActions')}
                  >
                    <MoreVertical size={11} />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="start"
                    className="z-50 min-w-[140px] rounded-md border border-line bg-surface-2 p-1 text-[12px] shadow-lg animate-in fade-in zoom-in-95"
                  >
                    <DropdownMenu.Item
                      onClick={() => startRename(wf)}
                      className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 outline-none hover:bg-accent-soft hover:text-accent focus:bg-accent-soft focus:text-accent"
                    >
                      <Pencil size={12} /> {t('common.rename')}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      onClick={() => onExport(wf)}
                      className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 outline-none hover:bg-accent-soft hover:text-accent focus:bg-accent-soft focus:text-accent"
                    >
                      <Upload size={12} /> {t('common.export')}
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator className="my-1 h-px bg-line" />
                    <DropdownMenu.Item
                      onClick={async () => {
                        const ok = await confirm({
                          title: t('appEditor.deleteWorkflowTitle', { name: wf.title }),
                          body: t('appEditor.deleteWorkflowDescription'),
                          tone: 'danger',
                          confirmLabel: t('common.delete'),
                        });
                        if (ok) onDelete(wf.id);
                      }}
                      className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-red-500 outline-none hover:bg-red-500/10 focus:bg-red-500/10"
                    >
                      <Trash2 size={12} /> {t('common.delete')}
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            ) : null}
          </div>
        ))}
        <input
          ref={importInputRef}
          type="file"
          accept=".yaml,.yml,text/yaml,application/x-yaml"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) onImport(file);
          }}
        />
        {/* One add affordance: start from scratch or import (no separate button). */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              disabled={busy}
              aria-label={t('appEditor.addWorkflow')}
              title={t('appEditor.addWorkflow')}
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-btn border border-line px-2 text-[12px] text-text-secondary hover:bg-canvas disabled:opacity-50"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              className="z-50 min-w-[180px] rounded-md border border-line bg-surface-2 p-1 text-[12px] shadow-lg animate-in fade-in zoom-in-95"
            >
              <DropdownMenu.Item
                onClick={onAdd}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 outline-none hover:bg-accent-soft hover:text-accent focus:bg-accent-soft focus:text-accent"
              >
                <Plus size={12} /> Start from scratch
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onClick={() => importInputRef.current?.click()}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 outline-none hover:bg-accent-soft hover:text-accent focus:bg-accent-soft focus:text-accent"
              >
                <Download size={12} /> Import YAML
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      <div className="min-h-0 flex-1">
        {selectedId ? (
          <WorkflowCanvasPage key={`${selectedId}:${reloadKey}`} embedded workflowId={selectedId} />
        ) : null}
      </div>
    </div>
  );
}

// ── Interface facet — the living app (Live) with Edit/Code as opt-in modes ──

type BuilderMode = 'live' | 'edit' | 'history' | 'code';

interface InterfaceHistoryItem {
  id: string;
  reason: string;
  source: string;
  actorType: string;
  status: 'candidate' | 'active' | 'abandoned';
  trustState: string;
  createdAt: string;
  publishedAt: string | null;
  pages: Array<{ name: string }>;
}

function InterfaceFacet({
  appId,
  surfaces,
  selected,
  current,
  draft,
  actions,
  busy,
  creating,
  collections,
  previewKey,
  onSelect,
  onDraftChange,
  onActionsChange,
  onCreate,
  onRename,
  onSave,
  onUpdateSurface,
  onDuplicateSurface,
  onDeleteSurface,
}: {
  appId: string;
  surfaces: AppSurface[];
  selected: string | null;
  current: AppSurface | null;
  draft: string;
  actions: SurfaceAction[];
  busy: boolean;
  creating: boolean;
  collections: CollectionInfo[];
  previewKey: number;
  onSelect: (name: string) => void;
  onDraftChange: (value: string) => void;
  onActionsChange: (actions: SurfaceAction[]) => void;
  onCreate: () => void;
  onRename: (currentName: string, nextName: string) => Promise<void>;
  onSave: () => void;
  onUpdateSurface: (patch: { kind?: SurfaceKind; shareable?: boolean }) => void;
  onDuplicateSurface: () => void;
  onDeleteSurface: (surfaceName: string) => void;
}) {
  const confirm = useConfirm();
  const [, setInterfaceParams] = useSearchParams();
  const [mode, setMode] = useState<BuilderMode>('live');
  const [history, setHistory] = useState<InterfaceHistoryItem[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [renamingSurface, setRenamingSurface] = useState<string | null>(null);
  const [surfaceNameDraft, setSurfaceNameDraft] = useState('');
  const [menuOpenSurface, setMenuOpenSurface] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<number[]>([]);
  const [managedBuild, setManagedBuild] = useState<AgenticAppBuild | null | undefined>(undefined);
  const view = parseViewDraft(draft);
  const selectedNode = view ? getNodeAtPath(view, selectedPath) : null;

  // A new/empty surface opens in Edit mode — there's nothing to preview Live yet,
  // opens in Live. Re-evaluated only when switching surfaces, not on every edit.
  useEffect(() => {
    const v = current?.view as { type?: string; children?: unknown[] } | null | undefined;
    const empty = !v || (v.type === 'Stack' && (!v.children || v.children.length === 0));
    setMode(empty ? 'edit' : 'live');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // A completed managed React project is the authoritative Live interface.
  // Declarative surfaces remain available in Edit/History as the lightweight
  // schema editor, but must never hide a newer real frontend build.
  useEffect(() => {
    let cancelled = false;
    setManagedBuild(undefined);
    void appsApi
      .getProject(appId)
      .then(({ builds }) => {
        if (cancelled) return;
        setManagedBuild(
          builds.find((build) => build.status === 'completed' && build.artifactPath) ?? null,
        );
      })
      .catch(() => {
        if (!cancelled) setManagedBuild(null);
      });
    return () => {
      cancelled = true;
    };
  }, [appId, previewKey]);

  // A managed build can finish while this facet is sitting on the empty
  // low-code editor. Publication is an app.updated event, which advances the
  // preview key above and refetches the build. Reveal that real interface as
  // soon as it exists instead of leaving the person on a stale legacy canvas.
  useEffect(() => {
    if (managedBuild) setMode('live');
  }, [managedBuild?.id]);

  useEffect(() => {
    setInterfaceParams(
      (params) => {
        const next = new URLSearchParams(params);
        next.set('facet', 'interface');
        next.set('mode', mode);
        if (selected) next.set('page', selected);
        else next.delete('page');
        if (selectedNode?.nodeId) next.set('node', selectedNode.nodeId);
        else next.delete('node');
        return next;
      },
      { replace: true },
    );
  }, [mode, selected, selectedNode?.nodeId, setInterfaceParams]);

  useEffect(() => {
    if (mode !== 'history') return;
    setHistoryBusy(true);
    void api<{ data: InterfaceHistoryItem[] }>(
      `/v1/apps/${encodeURIComponent(appId)}/interface/revisions`,
    )
      .then((response) => setHistory(response.data))
      .catch(() => setHistory([]))
      .finally(() => setHistoryBusy(false));
  }, [appId, mode, previewKey]);

  async function restoreRevision(revisionId: string) {
    setHistoryBusy(true);
    try {
      await api(
        `/v1/apps/${encodeURIComponent(appId)}/interface/revisions/${encodeURIComponent(revisionId)}/restore`,
        { method: 'POST' },
      );
      setMode('live');
    } finally {
      setHistoryBusy(false);
    }
  }

  function setView(next: ViewNode) {
    onDraftChange(JSON.stringify(next, null, 2));
  }

  function mergeActions(next: SurfaceAction[]) {
    const byName = new Map(actions.map((action) => [action.name, action]));
    for (const action of next) byName.set(action.name, action);
    onActionsChange([...byName.values()]);
  }

  function addBlock(kind: BlockKind, target: 'root' | 'selected' = 'root') {
    const root = view ?? emptySurfaceView();
    const built = buildBlock(kind, collections);
    if (built.actions?.length) mergeActions(built.actions);
    if (target === 'selected' && selectedNode && canHaveChildren(selectedNode)) {
      setView(addChildAtPath(root, selectedPath, built.node));
      return;
    }
    const next = appendNode(root, built.node);
    setView(next);
    setSelectedPath(pathToLastChild(next));
  }

  function updateSelected(mutator: (node: ViewNode) => ViewNode) {
    if (!view || !selectedNode) return;
    setView(updateNodeAtPath(view, selectedPath, mutator));
  }

  function removeSelected() {
    if (!view || selectedPath.length === 0) return;
    setView(removeNodeAtPath(view, selectedPath));
    setSelectedPath([]);
  }

  async function commitSurfaceRename(surfaceName: string) {
    const next = surfaceNameDraft.trim();
    if (!next || next === surfaceName) {
      setRenamingSurface(null);
      return;
    }
    await onRename(surfaceName, next);
    setRenamingSurface(null);
  }

  function openPageChat(surfaceName: string) {
    window.dispatchEvent(
      new CustomEvent('agentis:chat-panel-open', {
        detail: {
          mode: 'docked',
          initialViewportOverride: {
            surface: 'app_detail',
            route: `${window.location.pathname}${window.location.search}${window.location.hash}`,
            title: `App · ${surfaceName}`,
            resourceId: appId,
            resourceKind: 'app',
            appView: {
              appId,
              page: surfaceName,
              mode: 'live',
              ...(selectedNode?.nodeId ? { selectedNodeId: selectedNode.nodeId } : {}),
              facet: 'interface',
              targetLocked: true,
            },
          },
        },
      }),
    );
  }

  if (mode === 'live' && managedBuild) {
    return <ManagedFrontendFrame appId={appId} build={managedBuild} />;
  }

  if (surfaces.length === 0) {
    if (managedBuild === undefined) {
      return (
        <div className="flex h-full items-center justify-center bg-canvas text-text-muted">
          <Loader2 size={18} className="animate-spin" aria-label="Loading managed interface" />
        </div>
      );
    }
    return (
      <FacetEmpty
        icon={<LayoutGrid size={30} />}
        title="No interface yet"
        body="Create a surface, then build it visually — drop sections, edit in place, or let the agent draft it from a prompt."
        action={{ label: 'Create surface', busy: creating, onClick: onCreate }}
      />
    );
  }

  const rootEmpty = !view || (canHaveChildren(view) && view.children.length === 0);

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {/* Inner sidebar: the interface's pages live here (single, collapsible). The
          live runtime's own page nav is suppressed in-editor so there's just one.
          Live is the default; Edit / Edit code are in each page's ⋯ menu. */}
      <aside
        className={clsx(
          'relative flex shrink-0 flex-col border-r border-line bg-surface transition-all duration-300 ease-in-out',
          sidebarCollapsed ? 'w-11' : 'w-52',
        )}
      >
        <div
          className={clsx(
            'flex items-center justify-between gap-1 px-2 py-2',
            sidebarCollapsed ? 'justify-center' : '',
          )}
        >
          {!sidebarCollapsed && (
            <span className="pl-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              Pages
            </span>
          )}
          {!sidebarCollapsed && (
            <button
              type="button"
              onClick={onCreate}
              disabled={creating}
              className="inline-flex h-6 w-6 items-center justify-center rounded-btn text-text-muted hover:bg-surface-2 hover:text-text-primary disabled:opacity-50"
              aria-label="Add surface"
              title="Add page"
            >
              {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={13} />}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setSidebarCollapsed((v) => !v)}
          title={sidebarCollapsed ? 'Expand pages' : 'Collapse pages'}
          className={clsx(
            'absolute top-6 z-50 flex h-6 w-6 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-full border border-line bg-surface text-text-muted shadow-sm transition-all duration-300 ease-in-out hover:bg-surface-2 hover:text-text-primary right-0',
          )}
        >
          {sidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>

        {sidebarCollapsed ? (
          <div className="flex flex-col items-center gap-1 px-1.5 pb-1.5">
            {surfaces.map((surface) => (
              <button
                key={surface.id}
                type="button"
                onClick={() => {
                  onSelect(surface.name);
                  setSelectedPath([]);
                }}
                title={surface.name}
                aria-label={surface.name}
                className={clsx(
                  'flex h-8 w-8 items-center justify-center rounded-btn text-[12px] font-medium uppercase',
                  selected === surface.name
                    ? 'bg-accent-soft text-accent'
                    : 'text-text-muted hover:bg-canvas hover:text-text-primary',
                )}
              >
                {surface.name.slice(0, 1)}
              </button>
            ))}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
            {surfaces.map((surface) => (
              <div
                key={surface.id}
                className={clsx(
                  'group flex items-center rounded-btn text-[12px]',
                  selected === surface.name
                    ? 'bg-accent-soft text-accent'
                    : 'text-text-muted hover:bg-canvas hover:text-text-primary',
                )}
              >
                {renamingSurface === surface.name ? (
                  <input
                    autoFocus
                    value={surfaceNameDraft}
                    onChange={(event) => setSurfaceNameDraft(event.target.value)}
                    onBlur={() => void commitSurfaceRename(surface.name)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void commitSurfaceRename(surface.name);
                      if (event.key === 'Escape') setRenamingSurface(null);
                    }}
                    className="h-7 w-full rounded-md border border-line bg-canvas px-2 text-[12px] text-text-primary outline-none focus:border-accent"
                    aria-label="Surface name"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(surface.name);
                      setSelectedPath([]);
                      setMode('live');
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenuOpenSurface(surface.name);
                    }}
                    className="h-7 min-w-0 flex-1 truncate px-2 text-left"
                  >
                    {surface.name}
                  </button>
                )}
                {renamingSurface !== surface.name ? (
                  <DropdownMenu.Root
                    open={menuOpenSurface === surface.name}
                    onOpenChange={(open) => setMenuOpenSurface(open ? surface.name : null)}
                  >
                    <DropdownMenu.Trigger asChild>
                      <button
                        type="button"
                        className={clsx(
                          'mr-1 rounded-btn p-1 hover:bg-canvas',
                          menuOpenSurface === surface.name
                            ? 'opacity-100 text-text-primary'
                            : 'opacity-0 group-hover:opacity-100 text-text-muted',
                        )}
                        title="More actions"
                      >
                        <MoreVertical size={11} />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        align="start"
                        className="z-50 min-w-[180px] rounded-md border border-line bg-surface-2 p-1 text-[12px] shadow-lg animate-in fade-in zoom-in-95"
                      >
                        <DropdownMenu.Label className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                          Open in
                        </DropdownMenu.Label>
                        {(
                          [
                            ['live', 'Live', Eye],
                            ['ask', 'Ask agent', MessageSquare],
                            ['edit', 'Edit', Pencil],
                            ['history', 'History', History],
                            ['code', 'Edit code', Code2],
                          ] as const
                        ).map(([nextMode, label, Icon]) => (
                          <DropdownMenu.Item
                            key={nextMode}
                            onClick={() => {
                              onSelect(surface.name);
                              setSelectedPath([]);
                              if (nextMode === 'ask') {
                                openPageChat(surface.name);
                              } else {
                                setTimeout(() => setMode(nextMode), 0);
                              }
                            }}
                            className={clsx(
                              'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 outline-none hover:bg-accent-soft hover:text-accent focus:bg-accent-soft focus:text-accent',
                              selected === surface.name && mode === nextMode && 'text-accent',
                            )}
                          >
                            <Icon size={12} /> {label}
                          </DropdownMenu.Item>
                        ))}
                        {selected === surface.name && mode === 'edit' && view ? (
                          <DropdownMenu.Sub>
                            <DropdownMenu.SubTrigger className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 outline-none hover:bg-accent-soft hover:text-accent focus:bg-accent-soft focus:text-accent">
                              <Sparkles size={12} /> Look
                              <ChevronRight size={12} className="ml-auto" />
                            </DropdownMenu.SubTrigger>
                            <DropdownMenu.Portal>
                              <DropdownMenu.SubContent
                                sideOffset={4}
                                className="z-[60] min-w-[170px] rounded-md border border-line bg-surface-2 p-1 text-[12px] shadow-lg animate-in fade-in zoom-in-95"
                              >
                                <DropdownMenu.RadioGroup
                                  value={view.style?.design ?? ''}
                                  onValueChange={(design) =>
                                    setView({
                                      ...view,
                                      style: {
                                        ...view.style,
                                        ...(design
                                          ? { design: design as DesignLanguage }
                                          : { design: undefined }),
                                      },
                                    })
                                  }
                                >
                                  <DropdownMenu.RadioItem
                                    value=""
                                    className="cursor-pointer rounded-sm px-2 py-1.5 outline-none hover:bg-accent-soft hover:text-accent focus:bg-accent-soft focus:text-accent"
                                  >
                                    Automatic
                                  </DropdownMenu.RadioItem>
                                  {DESIGN_LANGUAGES.map((design) => (
                                    <DropdownMenu.RadioItem
                                      key={design.id}
                                      value={design.id}
                                      className="cursor-pointer rounded-sm px-2 py-1.5 outline-none hover:bg-accent-soft hover:text-accent focus:bg-accent-soft focus:text-accent"
                                    >
                                      {design.label}
                                    </DropdownMenu.RadioItem>
                                  ))}
                                </DropdownMenu.RadioGroup>
                              </DropdownMenu.SubContent>
                            </DropdownMenu.Portal>
                          </DropdownMenu.Sub>
                        ) : null}
                        {selected === surface.name && (mode === 'edit' || mode === 'code') ? (
                          <DropdownMenu.Item
                            disabled={!current || busy}
                            onSelect={(event) => {
                              event.preventDefault();
                              void onSave();
                            }}
                            className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 font-medium text-accent outline-none hover:bg-accent-soft focus:bg-accent-soft data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                          >
                            {busy ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <Save size={12} />
                            )}{' '}
                            Publish
                          </DropdownMenu.Item>
                        ) : null}
                        <DropdownMenu.Separator className="my-1 h-px bg-line" />
                        <DropdownMenu.Item
                          onClick={() => {
                            setRenamingSurface(surface.name);
                            setSurfaceNameDraft(surface.name);
                          }}
                          className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 outline-none hover:bg-accent-soft hover:text-accent focus:bg-accent-soft focus:text-accent"
                        >
                          <Pencil size={12} /> Rename
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          onClick={() => {
                            if (selected !== surface.name) {
                              onSelect(surface.name);
                              setSelectedPath([]);
                            }
                            setTimeout(() => onDuplicateSurface(), 0);
                          }}
                          className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 outline-none hover:bg-accent-soft hover:text-accent focus:bg-accent-soft focus:text-accent"
                        >
                          <Copy size={12} /> Duplicate
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator className="my-1 h-px bg-line" />
                        <DropdownMenu.Item
                          onClick={async () => {
                            const ok = await confirm({
                              title: `Delete surface "${surface.name}"?`,
                              body: 'This action cannot be undone.',
                              tone: 'danger',
                              confirmLabel: 'Delete',
                            });
                            if (ok) onDeleteSurface(surface.name);
                          }}
                          className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-red-500 outline-none hover:bg-red-500/10 focus:bg-red-500/10"
                        >
                          <Trash2 size={12} /> Delete
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </aside>

      {/* Main column. Page modes and edit actions live in each page's overflow menu. */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Body */}
        <div className="min-h-0 flex-1 overflow-hidden">
          {mode === 'history' ? (
            <div className="h-full overflow-auto bg-canvas p-6">
              <div className="mx-auto max-w-3xl">
                <h2 className="text-lg font-semibold text-text-primary">Interface history</h2>
                <p className="mt-1 text-[13px] text-text-muted">
                  Every published interface is immutable. Restore creates and verifies a new
                  revision.
                </p>
                <div className="mt-5 space-y-2">
                  {historyBusy ? (
                    <div className="py-12 text-center text-text-muted">
                      <Loader2 size={18} className="mx-auto animate-spin" />
                    </div>
                  ) : (
                    history.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center gap-4 rounded-card border border-line bg-surface px-4 py-3"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[13px] font-medium text-text-primary">
                              {item.reason}
                            </span>
                            {item.status === 'active' ? (
                              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-500">
                                Active
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-1 text-[11px] text-text-muted">
                            {item.pages.length} page{item.pages.length === 1 ? '' : 's'} ·{' '}
                            {item.source} · {new Date(item.createdAt).toLocaleString()}
                          </div>
                        </div>
                        {item.status !== 'active' ? (
                          <button
                            type="button"
                            disabled={historyBusy}
                            onClick={() => void restoreRevision(item.id)}
                            className="h-8 rounded-btn border border-line px-3 text-[12px] font-medium text-text-secondary hover:bg-surface-2 hover:text-text-primary disabled:opacity-50"
                          >
                            Restore
                          </button>
                        ) : null}
                      </div>
                    ))
                  )}
                  {!historyBusy && history.length === 0 ? (
                    <div className="rounded-card border border-dashed border-line p-10 text-center text-[13px] text-text-muted">
                      No interface revisions yet.
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ) : mode === 'code' ? (
            <textarea
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              spellCheck={false}
              className="h-full w-full resize-none bg-canvas p-4 font-mono text-[12px] leading-relaxed text-text-primary outline-none"
              placeholder="ViewNode JSON…"
            />
          ) : mode === 'live' ? (
            <div className="h-full overflow-auto bg-canvas">
              {current ? (
                <AppRuntime
                  key={`${current.name}:${previewKey}`}
                  appId={appId}
                  surfaceName={current.name}
                  hideShellNav
                />
              ) : (
                <div className="flex h-full items-center justify-center text-text-muted">
                  No surface selected
                </div>
              )}
            </div>
          ) : current ? (
            <SurfaceBuilder
              appId={appId}
              current={current}
              draft={draft}
              actions={actions}
              collections={collections}
              onDraftChange={onDraftChange}
              onActionsChange={onActionsChange}
              onUpdateSurface={onUpdateSurface}
              onDuplicateSurface={onDuplicateSurface}
              onDeleteSurface={() => onDeleteSurface(current.name)}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-text-muted">
              No surface selected
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ManagedFrontendFrame({ appId, build }: { appId: string; build: AgenticAppBuild }) {
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const message = event.data as {
        source?: string;
        kind?: string;
        id?: number;
        operationId?: string;
        input?: Record<string, unknown>;
        conversationId?: string;
        active?: boolean;
        body?: string;
        reason?: string | null;
      } | null;
      if (
        !message ||
        message.source !== 'agentis-managed-frontend-v1' ||
        typeof message.id !== 'number'
      ) {
        return;
      }
      const reply = (payload: Record<string, unknown>) => {
        frameRef.current?.contentWindow?.postMessage(
          { source: 'agentis-managed-frontend-v1', id: message.id, ...payload },
          '*',
        );
      };
      if (message.kind === 'channels.list') {
        void api<{ connections?: Array<Record<string, unknown>> }>('/v1/channels')
          .then((result) => reply({
            ok: true,
            result: {
              connections: (result.connections ?? []).filter((connection) => connection.appId === appId),
            },
          }))
          .catch((error) => reply({ ok: false, error: apiErrorMessage(error) }));
        return;
      }
      if (message.kind === 'team.list') {
        void appsApi.team(appId)
          .then((result) => reply({ ok: true, result }))
          .catch((error) => reply({ ok: false, error: apiErrorMessage(error) }));
        return;
      }
      if (message.kind === 'conversations.list') {
        void appsApi.conversations(appId)
          .then((result) => reply({ ok: true, result }))
          .catch((error) => reply({ ok: false, error: apiErrorMessage(error) }));
        return;
      }
      if (message.kind === 'conversations.messages' && typeof message.conversationId === 'string') {
        void appsApi.conversationMessages(appId, message.conversationId)
          .then((result) => reply({ ok: true, result }))
          .catch((error) => reply({ ok: false, error: apiErrorMessage(error) }));
        return;
      }
      if (message.kind === 'conversations.takeover' && typeof message.conversationId === 'string') {
        void appsApi.takeoverConversation(appId, message.conversationId, message.active === true)
          .then((result) => reply({ ok: true, result }))
          .catch((error) => reply({ ok: false, error: apiErrorMessage(error) }));
        return;
      }
      if (
        message.kind === 'conversations.send' &&
        typeof message.conversationId === 'string' &&
        typeof message.body === 'string'
      ) {
        void appsApi.sendToConversation(appId, message.conversationId, message.body)
          .then((result) => reply({ ok: true, result }))
          .catch((error) => reply({ ok: false, error: apiErrorMessage(error) }));
        return;
      }
      if (message.kind === 'conversations.needs-attention' && typeof message.conversationId === 'string') {
        void appsApi.flagNeedsAttention(
          appId,
          message.conversationId,
          message.active === true,
          message.reason ?? null,
        )
          .then((result) => reply({ ok: true, result }))
          .catch((error) => reply({ ok: false, error: apiErrorMessage(error) }));
        return;
      }
      if (typeof message.operationId !== 'string') return;
      void appsApi
        .invokeOperation(appId, message.operationId, message.input ?? {})
        .then((result) => reply({ ok: true, result }))
        .catch((error) => reply({ ok: false, error: apiErrorMessage(error) }));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [appId]);

  useEffect(() => {
    let cancelled = false;
    setSrcDoc(null);
    setLoadError(null);
    const base = `/v1/apps/${encodeURIComponent(appId)}/frontend/`;
    void apiText(base)
      .then(async (html) => {
        const paths = [
          ...new Set(
            [...html.matchAll(/(?:src|href)="\.\/([^"?#]+)"/g)]
              .map((match) => match[1])
              .filter((value): value is string => Boolean(value)),
          ),
        ];
        const contents = new Map(
          await Promise.all(
            paths.map(
              async (assetPath) => [assetPath, await apiText(`${base}${assetPath}`)] as const,
            ),
          ),
        );
        const assembled = assembleManagedFrontendSrcDoc(
          html,
          contents,
          MANAGED_FRONTEND_BRIDGE,
        );
        if (!cancelled) setSrcDoc(assembled);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(apiErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [appId, build.id]);

  if (loadError) {
    return (
      <FacetEmpty
        icon={<Code2 size={28} />}
        title="Managed interface could not load"
        body={loadError}
      />
    );
  }
  if (!srcDoc) {
    return (
      <div className="flex h-full items-center justify-center bg-[#0b0b0a] text-white/50">
        <Loader2 size={18} className="animate-spin" aria-label="Loading managed interface assets" />
      </div>
    );
  }
  return (
    <div className="relative h-full min-h-0 bg-[#0b0b0a]">
      <iframe
        ref={frameRef}
        key={build.id}
        title="Managed app interface"
        srcDoc={srcDoc}
        sandbox="allow-scripts allow-forms allow-modals"
        className="h-full w-full border-0 bg-[#0b0b0a]"
      />
    </div>
  );
}

const MANAGED_FRONTEND_BRIDGE = `<script>
(function(){
  var source='agentis-managed-frontend-v1', nextId=0, pending=new Map();
  window.addEventListener('message',function(event){
    var message=event.data||{};
    if(message.source!==source||typeof message.id!=='number'||!pending.has(message.id)) return;
    var entry=pending.get(message.id); pending.delete(message.id);
    message.ok?entry.resolve(message.result):entry.reject(new Error(message.error||'Operation failed'));
  });
  function request(message){
    return new Promise(function(resolve,reject){
      var id=++nextId; pending.set(id,{resolve:resolve,reject:reject});
      parent.postMessage(Object.assign({source:source,id:id},message),'*');
    });
  }
  window.agentis={
    operations:{invoke:function(operationId,input){return request({operationId:operationId,input:input||{}});}},
    channels:{list:function(){return request({kind:'channels.list'});}},
    team:{list:function(){return request({kind:'team.list'});}},
    conversations:{
      list:function(){return request({kind:'conversations.list'});},
      messages:function(conversationId){return request({kind:'conversations.messages',conversationId:conversationId});},
      takeover:function(conversationId,active){return request({kind:'conversations.takeover',conversationId:conversationId,active:active});},
      send:function(conversationId,body){return request({kind:'conversations.send',conversationId:conversationId,body:body});},
      needsAttention:function(conversationId,active,reason){return request({kind:'conversations.needs-attention',conversationId:conversationId,active:active,reason:reason||null});}
    }
  };
})();
<\/script>`;

function PaletteGroup({
  title,
  items,
  onAdd,
  className,
}: {
  title: string;
  items: PaletteItem[];
  onAdd: (kind: BlockKind) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
        {title}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {items.map((item) => (
          <button
            key={item.kind}
            type="button"
            draggable
            title={item.hint}
            onDragStart={(event) => {
              event.dataTransfer.setData('application/x-agentis-block', item.kind);
              event.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => onAdd(item.kind)}
            className="flex h-16 flex-col items-start justify-between rounded-card border border-line bg-canvas p-2 text-left text-[11px] text-text-secondary transition-colors hover:border-accent/50 hover:bg-surface-2 hover:text-text-primary"
          >
            <span className="text-text-muted">{item.icon}</span>
            <span className="font-medium">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function EmptyCanvasHint() {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center text-text-muted">
      <LayoutGrid size={30} className="mb-3" />
      <div className="text-[13px] font-medium text-text-secondary">Build your surface</div>
      <p className="mt-1 max-w-xs text-[12px] leading-relaxed">
        Drop a section from the left, or describe it in the prompt bar and let the agent draft it.
      </p>
    </div>
  );
}

// ── Inspector — properties for the selected node ─────────────

function SurfaceProperties({
  node,
  collections,
  onChange,
  onRemove,
  onAddInside,
}: {
  node: ViewNode;
  collections: CollectionInfo[];
  onChange: (mutator: (node: ViewNode) => ViewNode) => void;
  onRemove?: () => void;
  onAddInside?: (kind: ElementKind) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-card border border-line bg-canvas p-3">
        <div className="text-[12px] font-semibold text-text-primary">{node.type}</div>
        <div className="mt-1 truncate text-[11px] text-text-muted">{surfaceNodeLabel(node)}</div>
      </div>
      <SurfaceNodeFields node={node} collections={collections} onChange={onChange} />
      {onAddInside ? (
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
            Add inside
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {(['heading', 'text', 'card', 'metric'] as ElementKind[]).map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => onAddInside(kind)}
                className="rounded-btn border border-line bg-canvas px-2 py-1 text-[11px] capitalize text-text-secondary hover:bg-surface-2 hover:text-text-primary"
              >
                {kind}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-btn border border-danger/30 bg-danger-soft px-2 text-[12px] font-medium text-danger"
        >
          <X size={13} /> Remove block
        </button>
      ) : null}
    </div>
  );
}

function SurfaceNodeFields({
  node,
  collections,
  onChange,
}: {
  node: ViewNode;
  collections: CollectionInfo[];
  onChange: (mutator: (node: ViewNode) => ViewNode) => void;
}) {
  if (node.type === 'Heading' || node.type === 'Text' || node.type === 'Markdown') {
    return (
      <PropertyTextarea
        label="Content"
        value={node.value}
        onChange={(value) => onChange((current) => ({ ...current, value }) as ViewNode)}
      />
    );
  }
  if (node.type === 'Card' || node.type === 'Section') {
    return (
      <PropertyInput
        label="Title"
        value={node.title ?? ''}
        onChange={(title) => onChange((current) => ({ ...current, title }) as ViewNode)}
      />
    );
  }
  if (node.type === 'Stack' || node.type === 'Row' || node.type === 'Grid') {
    return (
      <PropertyInput
        label="Gap"
        value={String(node.gap ?? 12)}
        onChange={(gap) =>
          onChange((current) => ({ ...current, gap: Number(gap) || 0 }) as ViewNode)
        }
      />
    );
  }
  if (node.type === 'Metric') {
    return (
      <>
        <PropertyInput
          label="Label"
          value={node.label}
          onChange={(label) => onChange((current) => ({ ...current, label }) as ViewNode)}
        />
        <PropertyInput
          label="Value"
          value={bindableToInput(node.value)}
          onChange={(value) =>
            onChange((current) => ({ ...current, value: inputToBindable(value) }) as ViewNode)
          }
        />
        <PropertyInput
          label="Delta"
          value={bindableToInput(node.delta ?? '')}
          onChange={(delta) =>
            onChange((current) => ({ ...current, delta: inputToBindable(delta) }) as ViewNode)
          }
        />
      </>
    );
  }
  if (node.type === 'Button') {
    return (
      <>
        <PropertyInput
          label="Label"
          value={node.label}
          onChange={(label) => onChange((current) => ({ ...current, label }) as ViewNode)}
        />
        <PropertyInput
          label="Action"
          value={node.action.action}
          onChange={(action) =>
            onChange(
              (current) =>
                ({
                  ...current,
                  action: { ...(current as Extract<ViewNode, { type: 'Button' }>).action, action },
                }) as ViewNode,
            )
          }
        />
      </>
    );
  }
  if (node.type === 'Image') {
    return (
      <>
        <PropertyInput
          label="Source"
          value={bindableToInput(node.src)}
          onChange={(src) =>
            onChange((current) => ({ ...current, src: inputToBindable(src) }) as ViewNode)
          }
        />
        <PropertyInput
          label="Alt"
          value={node.alt ?? ''}
          onChange={(alt) => onChange((current) => ({ ...current, alt }) as ViewNode)}
        />
      </>
    );
  }
  if (node.type === 'Table') {
    return (
      <>
        <CollectionSelect node={node} collections={collections} onChange={onChange} />
        <PropertyInput
          label="Columns"
          value={node.columns.map((column) => column.key).join(', ')}
          onChange={(value) =>
            onChange(
              (current) =>
                ({
                  ...current,
                  columns: value
                    .split(',')
                    .map((part) => part.trim())
                    .filter(Boolean)
                    .map((key) => ({ key, label: key })),
                }) as ViewNode,
            )
          }
        />
      </>
    );
  }
  if (node.type === 'Badge') {
    return (
      <PropertyInput
        label="Value"
        value={bindableToInput(node.value)}
        onChange={(value) =>
          onChange((current) => ({ ...current, value: inputToBindable(value) }) as ViewNode)
        }
      />
    );
  }
  return (
    <div className="rounded-card border border-line bg-canvas p-3 text-[12px] text-text-muted">
      No editable fields for this block.
    </div>
  );
}

function CollectionSelect({
  node,
  collections,
  onChange,
}: {
  node: Extract<ViewNode, { type: 'Table' }>;
  collections: CollectionInfo[];
  onChange: (mutator: (node: ViewNode) => ViewNode) => void;
}) {
  return (
    <label className="block text-[11px] font-medium text-text-muted">
      Collection
      <select
        value={node.bind.collection}
        onChange={(event) =>
          onChange(
            (current) =>
              ({
                ...current,
                bind: {
                  ...(current as Extract<ViewNode, { type: 'Table' }>).bind,
                  collection: event.target.value,
                },
              }) as ViewNode,
          )
        }
        className="mt-1 h-8 w-full rounded-md border border-line bg-canvas px-2 text-[12px] text-text-primary outline-none focus:border-accent"
      >
        {collections.length === 0 ? (
          <option value={node.bind.collection}>{node.bind.collection}</option>
        ) : null}
        {collections.map((collection) => (
          <option key={collection.id} value={collection.name}>
            {collection.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function PropertyInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-[11px] font-medium text-text-muted">
      {label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 h-8 w-full rounded-md border border-line bg-canvas px-2 text-[12px] text-text-primary outline-none focus:border-accent"
      />
    </label>
  );
}

function PropertyTextarea({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-[11px] font-medium text-text-muted">
      {label}
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 min-h-20 w-full resize-none rounded-md border border-line bg-canvas p-2 text-[12px] text-text-primary outline-none focus:border-accent"
      />
    </label>
  );
}

function bindableToInput(value: unknown): string {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.$row === 'string') return `$row.${record.$row}`;
    if (typeof record.$state === 'string') return `$state.${record.$state}`;
    if (typeof record.$bind === 'string') return `$bind.${record.$bind}`;
  }
  return value == null ? '' : String(value);
}

function inputToBindable(value: string) {
  if (value.startsWith('$row.')) return { $row: value.slice(5) };
  if (value.startsWith('$state.')) return { $state: value.slice(7) };
  if (value.startsWith('$bind.')) return { $bind: value.slice(6) };
  return value;
}

function surfaceNodeLabel(node: ViewNode): string {
  if (node.type === 'Metric') return node.label;
  if (node.type === 'Button') return node.label;
  if (node.type === 'Table') return node.bind.collection;
  if (node.type === 'Image') return bindableToInput(node.src);
  if ('value' in node) return bindableToInput(node.value);
  if ('title' in node && node.title) return node.title;
  return canHaveChildren(node) ? `${node.children.length} children` : '';
}

function DataFacet({ collections, appId }: { collections: CollectionInfo[]; appId: string }) {
  const [view, setView] = useState<'records' | 'assets'>('records');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-line bg-surface px-3 py-1.5">
        {(['records', 'assets'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={clsx(
              'rounded-btn px-3 py-1 text-[12px] font-medium capitalize',
              view === v ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-surface-2',
            )}
          >
            {v}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {view === 'records' ? (
          <AppDataGrid appId={appId} collections={collections} />
        ) : (
          <main className="h-full overflow-auto p-6">
            <AppAssets appId={appId} />
          </main>
        )}
      </div>
    </div>
  );
}

/** Assets produced by (or filed under) this App — screenshots, docs, exports. */
function AppAssets({ appId }: { appId: string }) {
  const [assets, setAssets] = useState<Artifact[]>([]);
  const [selected, setSelected] = useState<Artifact | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(() => {
    if (!appId) return;
    void api<{ artifacts: Artifact[] }>(
      `/v1/artifacts?appId=${encodeURIComponent(appId)}&limit=100`,
    )
      .then((res) => setAssets(res.artifacts ?? []))
      .catch(() => setAssets([]))
      .finally(() => setLoaded(true));
  }, [appId]);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-[15px] font-semibold text-text-primary">Assets</h2>
          <p className="mt-1 text-[12px] text-text-muted">
            Outputs this App has produced. Manage the full library under{' '}
            <Boxes size={11} className="inline -mt-0.5" /> Assets.
          </p>
        </div>
      </div>
      {!loaded ? (
        <div className="text-[12px] text-text-muted">Loading…</div>
      ) : assets.length === 0 ? (
        <FacetEmpty
          icon={<Boxes size={30} />}
          title="No assets yet"
          body="When this App's agents or workflows produce screenshots, docs, or exports, they appear here."
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
          {assets.map((a) => {
            const preview =
              a.thumbnailUrl ??
              (a.type === 'image' && a.content.startsWith('data:image/') ? a.content : null);
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => setSelected(a)}
                className="group flex flex-col overflow-hidden rounded-lg border border-line bg-surface text-left transition hover:border-accent/40 hover:shadow-lg"
              >
                <div className="relative h-40 w-full overflow-hidden bg-surface-2">
                  {preview ? (
                    <>
                      <img
                        src={preview}
                        alt={a.title}
                        className="absolute inset-0 h-full w-full object-cover object-top"
                      />
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface/95 to-transparent" />
                    </>
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-text-muted transition group-hover:text-accent">
                      <Database size={24} />
                    </span>
                  )}
                </div>
                <div className="p-2.5">
                  <div className="truncate text-[11px] font-medium text-text-primary">
                    {a.title}
                  </div>
                  <div className="mt-0.5 text-[9px] uppercase tracking-wider text-text-muted">
                    {a.type}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
      {selected && (
        <ArtifactPanel artifact={selected} state="fullscreen" onClose={() => setSelected(null)} />
      )}
    </section>
  );
}

// ── Brain facet — the App's intelligence (memory bound to this App) ──────────

function BrainFacet({ app }: { app: AppRecord }) {
  // Everything the App has learned — promoted records, memory, and lessons — is
  // shown as nodes in the scoped Brain map (with an Insights list behind the nav).
  // No separate "what this agent learned" panel; the map IS the surface.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkflowBrainTab workflow={{ id: app.id, title: app.name }} kind="app" />
    </div>
  );
}

// ── Shared helpers ───────────────────────────────────────────

function FacetEmpty({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: { label: string; onClick: () => void; busy?: boolean };
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center text-text-muted">
      <div className="mb-3 text-text-secondary">{icon}</div>
      <div className="text-[14px] font-medium text-text-secondary">{title}</div>
      <p className="mt-1 max-w-md text-[12px] leading-relaxed">{body}</p>
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          disabled={action.busy}
          className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-btn bg-accent px-4 text-[12px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-50"
        >
          {action.busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

function uniqueName(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
