

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Bot,
  Boxes,
  CheckCircle2,
  Code2,
  Copy,
  Database,
  Edit3,
  FileJson,
  Globe,
  HardDrive,
  Key,
  LayoutGrid,
  MoreHorizontal,
  Plus,
  Puzzle,
  Radio,
  SearchX,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  Workflow as WorkflowIcon,
  X,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AppRecord, AppManifestEnvelope, WorkspaceBundleEnvelope } from '@agentis/core';
import { api, apiCached, peekCached, apiErrorMessage } from '../lib/api';
import { useResourceRevision } from '../lib/resourceRealtime';
import { appsApi } from '../lib/appsApi';
import { isWorkspaceBundle } from '../lib/workspaceBundle';
import { WorkspaceBundleModal } from '../components/packages/WorkspaceBundleModal';
import { useToast } from '../components/shared/Toast';
import { useConfirm } from '../components/shared/ConfirmDialog';
import { Button } from '../components/shared/Button';
import { SearchInput } from '../components/shared/SearchInput';
import { Skeleton } from '../components/shared/Skeleton';
import { EmptyState } from '../components/shared/EmptyState';
import { StatusBadge } from '../components/shared/StatusBadge';
import { ExtensionStudioModal } from '../components/extensions/ExtensionStudioModal';

type LibraryFilter = 'all' | 'apps' | 'agents' | 'workflows' | 'extensions';
type LibraryKind = 'app' | 'agent' | 'workflow' | 'extension';
type ExtensionPermission =
  | 'network' | 'credentials' | 'workspace.read' | 'workspace.write' | 'filesystem'
  | 'listener' | 'listener.emit' | 'listener.cursor' | 'kv.read' | 'kv.write'
  | 'browser' | 'browser.evaluate' | 'browser.session.persist' | 'browser.auth';

interface WorkflowPackage {
  id: string;
  name: string;
  slug: string;
  kind: 'workflow' | 'agent';
  version?: string;
  description?: string;
  isTemplate?: boolean;
  role?: string | null;
}

interface ExtensionManifest {
  name?: string;
  slug?: string;
  version?: string;
  description?: string;
  permissions?: string[];
  allowedDomains?: string[];
  credentialKeys?: string[];
  categories?: string[];
  capabilityTags?: string[];
  operations?: ExtensionOperation[];
  source?: string;
  timeoutMs?: number;
}

interface ExtensionOperation {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

interface WorkspaceExtension {
  id: string;
  name: string;
  slug: string;
  version: string;
  runtime: 'builtin' | 'node_worker' | 'docker_sandbox' | string;
  manifest: ExtensionManifest;
  createdAt?: string;
  updatedAt?: string;
}

interface PackageDetail {
  package: {
    id: string;
    name: string;
    version: string;
    slug: string;
    kind: WorkflowPackage['kind'];
    description: string;
    installedAt: string;
    manifest: unknown;
  };
  workflows: { id: string; title: string }[];
  agents?: { id: string; name: string; role?: string }[];
}

interface LibraryItem {
  id: string;
  kind: LibraryKind;
  name: string;
  slug: string;
  version?: string;
  description?: string | null;
  searchText: string;
  source: WorkflowPackage | WorkspaceExtension | AppRecord;
}

const PERMISSIONS: Array<{
  value: ExtensionPermission;
  label: string;
  description: string;
  icon: LucideIcon;
  tone: string;
}> = [
  {
    value: 'network',
    label: 'Network',
    description: 'HTTP/HTTPS access to declared domains only.',
    icon: Globe,
    tone: 'text-sky-300 bg-sky-500/10 border-sky-400/20',
  },
  {
    value: 'browser',
    label: 'Browser',
    description: 'Drive headless Chromium on declared domains.',
    icon: Globe,
    tone: 'text-sky-300 bg-sky-500/10 border-sky-400/20',
  },
  {
    value: 'browser.evaluate',
    label: 'Page evaluate',
    description: 'Run bounded JavaScript inside the loaded page.',
    icon: Globe,
    tone: 'text-indigo-300 bg-indigo-500/10 border-indigo-400/20',
  },
  {
    value: 'browser.session.persist',
    label: 'Persistent browser session',
    description: 'Keep a live page and encrypted resumable checkpoint.',
    icon: Radio,
    tone: 'text-violet-300 bg-violet-500/10 border-violet-400/20',
  },
  {
    value: 'browser.auth',
    label: 'Browser auth profiles',
    description: 'Restore operator-saved encrypted browser authentication.',
    icon: Key,
    tone: 'text-amber-300 bg-amber-500/10 border-amber-400/20',
  },
  {
    value: 'credentials',
    label: 'Credentials',
    description: 'Read named secrets from the workspace vault.',
    icon: Key,
    tone: 'text-amber-300 bg-amber-500/10 border-amber-400/20',
  },
  {
    value: 'workspace.read',
    label: 'Read state',
    description: 'Read run/workspace scratchpad context.',
    icon: Database,
    tone: 'text-emerald-300 bg-emerald-500/10 border-emerald-400/20',
  },
  {
    value: 'workspace.write',
    label: 'Write state',
    description: 'Write deterministic state during a run.',
    icon: Edit3,
    tone: 'text-lime-300 bg-lime-500/10 border-lime-400/20',
  },
  {
    value: 'filesystem',
    label: 'Filesystem',
    description: 'Use the extension sandbox temporary directory.',
    icon: HardDrive,
    tone: 'text-cyan-300 bg-cyan-500/10 border-cyan-400/20',
  },
  {
    value: 'listener',
    label: 'Listener source',
    description: 'Allow operations to run as a persistent trigger source.',
    icon: Radio,
    tone: 'text-violet-300 bg-violet-500/10 border-violet-400/20',
  },
  {
    value: 'listener.emit',
    label: 'Emit events',
    description: 'Allow ctx.emit() so a source can push events to the runtime.',
    icon: Radio,
    tone: 'text-violet-300 bg-violet-500/10 border-violet-400/20',
  },
  {
    value: 'listener.cursor',
    label: 'Listener cursor',
    description: 'Read/write the durable resume cursor (ctx.cursor / ctx.setCursor).',
    icon: Radio,
    tone: 'text-violet-300 bg-violet-500/10 border-violet-400/20',
  },
  {
    value: 'kv.read',
    label: 'KV read',
    description: 'Read the workspace-scoped extension KV store (ctx.kv.get).',
    icon: Database,
    tone: 'text-emerald-300 bg-emerald-500/10 border-emerald-400/20',
  },
  {
    value: 'kv.write',
    label: 'KV write',
    description: 'Write the workspace-scoped extension KV store (ctx.kv.set).',
    icon: Edit3,
    tone: 'text-lime-300 bg-lime-500/10 border-lime-400/20',
  },
];

export function PackagesPage() {
  const resourceRevision = useResourceRevision(['packages', 'apps']);
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [workflows, setWorkflows] = useState<WorkflowPackage[]>(() =>
    (peekCached<{ packages: WorkflowPackage[] }>('/v1/packages')?.packages ?? [])
      .filter((pkg) => !pkg.isTemplate && (pkg.kind === 'workflow' || pkg.kind === 'agent')));
  const [extensions, setExtensions] = useState<WorkspaceExtension[]>(() => peekCached<{ extensions: WorkspaceExtension[] }>('/v1/extensions')?.extensions ?? []);
  const [apps, setApps] = useState<AppRecord[]>(() => peekCached<{ data: AppRecord[] }>('/v1/apps')?.data ?? []);
  const [loading, setLoading] = useState(() => peekCached('/v1/packages') === undefined);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [openWorkflow, setOpenWorkflow] = useState<WorkflowPackage | null>(null);
  const [openExtension, setOpenExtension] = useState<WorkspaceExtension | null>(null);
  const [extensionStudioOpen, setExtensionStudioOpen] = useState(false);
  const [workspaceBundleOpen, setWorkspaceBundleOpen] = useState(false);
  const [importBundle, setImportBundle] = useState<WorkspaceBundleEnvelope | null>(null);

  async function refresh() {
    if (peekCached('/v1/packages') === undefined) setLoading(true);
    try {
      const [packageRes, extensionRes, appRes] = await Promise.allSettled([
        apiCached<{ packages: WorkflowPackage[] }>('/v1/packages'),
        apiCached<{ extensions: WorkspaceExtension[] }>('/v1/extensions'),
        appsApi.list(),
      ]);
      setWorkflows(
        packageRes.status === 'fulfilled'
          ? (packageRes.value.packages ?? []).filter((pkg) => !pkg.isTemplate && (pkg.kind === 'workflow' || pkg.kind === 'agent'))
          : [],
      );
      setExtensions(extensionRes.status === 'fulfilled' ? extensionRes.value.extensions ?? [] : []);
      setApps(appRes.status === 'fulfilled' ? appRes.value ?? [] : []);
    } catch {
      setWorkflows([]);
      setExtensions([]);
      setApps([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceRevision]);

  const items = useMemo<LibraryItem[]>(() => {
    const appItems = apps.map((app): LibraryItem => ({
      id: `app:${app.id}`,
      kind: 'app',
      name: app.name,
      slug: app.slug,
      version: app.version,
      description: app.description,
      searchText: [app.name, app.slug, app.description, ...(app.manifest?.capabilities ?? [])].filter(Boolean).join(' ').toLowerCase(),
      source: app,
    }));
    const packageItems = workflows.map((pkg): LibraryItem => ({
      id: `${pkg.kind}:${pkg.id}`,
      kind: pkg.kind,
      name: pkg.name,
      slug: pkg.slug,
      version: pkg.version,
      description: pkg.description ?? '',
      searchText: [pkg.name, pkg.slug, pkg.description].filter(Boolean).join(' ').toLowerCase(),
      source: pkg,
    }));
    const extensionItems = extensions.map((extension): LibraryItem => ({
      id: `extension:${extension.id}`,
      kind: 'extension',
      name: extension.name || extension.manifest.name || extension.slug,
      slug: extension.slug,
      version: extension.version,
      description: extension.manifest.description ?? '',
      searchText: [
        extension.name,
        extension.slug,
        extension.runtime,
        extension.manifest.description,
        ...(extension.manifest.permissions ?? []),
        ...(extension.manifest.capabilityTags ?? []),
      ].filter(Boolean).join(' ').toLowerCase(),
      source: extension,
    }));
    return [...appItems, ...extensionItems, ...packageItems];
  }, [apps, extensions, workflows]);

  const counts = useMemo(() => ({
    all: items.length,
    apps: apps.length,
    agents: items.filter((item) => item.kind === 'agent').length,
    workflows: items.filter((item) => item.kind === 'workflow').length,
    extensions: extensions.length,
  }), [apps.length, items, extensions.length]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((item) => {
      const kindMatches = filter === 'all' || pluralKind(item.kind) === filter;
      const searchMatches = !q || item.searchText.includes(q);
      return kindMatches && searchMatches;
    });
  }, [filter, items, search]);

  async function handleImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.agentishub,.agentisapp,.agentiswf,.agentisagt,.agentisext,.agentis,.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const json = JSON.parse(text) as Record<string, unknown>;
        if (json.format === '.agentishub' || file.name.endsWith('.agentishub')) {
          await importHubArtifact(json);
          toast.success('Installed from AgentisHub', file.name);
          void refresh();
          return;
        }
        // A whole-workspace `.agentis` bundle goes through preview+confirm, not a silent import.
        if (isWorkspaceBundle(json)) {
          setImportBundle(json);
          return;
        }
        await routeImport(file.name, json);
        toast.success('Imported', file.name);
        void refresh();
      } catch (err) {
        toast.error('Import failed', apiErrorMessage(err));
      }
    };
    input.click();
  }

  async function importHubArtifact(envelope: Record<string, unknown>) {
    type HubImportResponse = {
      status: 'installed' | 'activation_required' | 'pending' | 'approved' | 'expired' | 'denied';
      activation?: { deviceCode: string; verificationUriComplete: string; expiresIn?: number; interval?: number };
    };
    let response = await api<HubImportResponse>('/v1/hub/import', {
      method: 'POST',
      body: JSON.stringify({ envelope, permissionsAcknowledged: true }),
    });
    if (response.status === 'installed') return;
    if (response.status !== 'activation_required' || !response.activation) throw new Error(`Unexpected AgentisHub import state: ${response.status}`);
    const activation = response.activation;
    const popup = window.open(activation.verificationUriComplete, '_blank', 'noopener,noreferrer');
    if (!popup) toast.info('Activation required', `Open ${activation.verificationUriComplete} to approve this workspace.`);
    else toast.info('Activation required', 'Approve this workspace in the AgentisHub window. Import will continue automatically.');
    const deadline = Date.now() + Math.min((activation.expiresIn ?? 600) * 1000, 10 * 60_000);
    const intervalMs = Math.max(2_000, (activation.interval ?? 3) * 1000);
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
      response = await api<HubImportResponse>('/v1/hub/import', {
        method: 'POST',
        body: JSON.stringify({ envelope, permissionsAcknowledged: true, deviceCode: activation.deviceCode }),
      });
      if (response.status === 'installed') return;
      if (response.status === 'expired' || response.status === 'denied') throw new Error(`AgentisHub activation ${response.status}`);
    }
    throw new Error('AgentisHub activation timed out. Start the import again to receive a new code.');
  }

  /** Detect the package kind from its envelope shape (or extension) and import via the right route. */
  async function routeImport(fileName: string, json: Record<string, unknown>) {
    // Agentic App — `.agentisapp` envelope carries a discriminating `format`.
    if (json.format === '.agentisapp' || fileName.endsWith('.agentisapp')) {
      const envelope = json as unknown as AppManifestEnvelope;
      const preview = await appsApi.previewImport(envelope);
      await appsApi.importApp(envelope, preview.permissions ?? []);
      return;
    }
    // Extension — a raw node-worker manifest with operations + permissions.
    if (fileName.endsWith('.agentisext') || isExtensionManifest(json)) {
      await api('/v1/extensions/install-local', {
        method: 'POST',
        body: JSON.stringify({ manifest: json, permissionsAcknowledged: json.permissions ?? [] }),
      });
      return;
    }
    // Workflow / agent package (default) — `.agentiswf` / `.agentisagt` / legacy `.agentis`.
    const manifest = 'manifest' in json
      ? json.manifest
      : 'packageManifest' in json
        ? json.packageManifest
        : json;
    await api('/v1/packages/import', { method: 'POST', body: JSON.stringify({ manifest }) });
  }

  async function handleExportWorkflow(pkg: WorkflowPackage) {
    try {
      const detail = await api<PackageDetail>(`/v1/packages/${pkg.id}`);
      const ext = detail.package.kind === 'agent' ? 'agentisagt' : 'agentiswf';
      downloadJson(detail.package.manifest, `${pkg.slug || slugify(pkg.name)}.${ext}`);
      toast.success('Exported', pkg.name);
    } catch (err) {
      toast.error('Export failed', apiErrorMessage(err));
    }
  }

  async function handleExportApp(app: AppRecord) {
    try {
      const envelope = await appsApi.exportApp(app.id);
      downloadJson(envelope, `${app.slug || slugify(app.name)}.agentisapp`);
      toast.success('Exported', app.name);
    } catch (err) {
      toast.error('Export failed', apiErrorMessage(err));
    }
  }

  function handleExportExtension(extension: WorkspaceExtension) {
    try {
      // The manifest (incl. source, operations, permissions) is already on the record —
      // serialize it directly as a portable, re-importable `.agentisext`.
      downloadJson(extension.manifest, `${extension.slug || slugify(extension.name)}.agentisext`);
      toast.success('Exported', extension.name);
    } catch (err) {
      toast.error('Export failed', apiErrorMessage(err));
    }
  }

  async function handleDuplicateWorkflow(pkg: WorkflowPackage) {
    try {
      await api(`/v1/packages/${pkg.id}/duplicate`, { method: 'POST' });
      toast.success('Duplicated', `Copy of ${pkg.name}`);
      void refresh();
    } catch (err) {
      toast.error('Duplicate failed', apiErrorMessage(err));
    }
  }

  async function handleDeleteWorkflow(pkg: WorkflowPackage) {
    const ok = await confirm({
      title: `Delete "${pkg.name}"?`,
      body: 'You can undo this for 5 seconds.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;

    let manifestSnapshot: unknown = null;
    try {
      const detail = await api<PackageDetail>(`/v1/packages/${pkg.id}`);
      manifestSnapshot = detail.package.manifest;
    } catch {
    }

    try {
      await api(`/v1/packages/${pkg.id}`, { method: 'DELETE' });
      toast.undo(`Deleted "${pkg.name}"`, async () => {
        if (!manifestSnapshot) return;
        try {
          await api('/v1/packages/import', {
            method: 'POST',
            body: JSON.stringify({ manifest: manifestSnapshot }),
          });
          toast.success('Restored', pkg.name);
          void refresh();
        } catch {
          toast.error('Could not restore', pkg.name);
        }
      });
      void refresh();
    } catch (err) {
      toast.error('Failed to delete', apiErrorMessage(err));
    }
  }

  function handleOpenItem(item: LibraryItem) {
    if (item.kind === 'app') nav(`/apps/${(item.source as AppRecord).id}`);
    if (item.kind === 'workflow' || item.kind === 'agent') setOpenWorkflow(item.source as WorkflowPackage);
    if (item.kind === 'extension') setOpenExtension(item.source as WorkspaceExtension);
  }

  const emptyTitle = filter === 'apps'
    ? 'No apps yet'
    : filter === 'extensions'
      ? 'No extensions installed yet'
        : filter === 'workflows'
          ? 'No workflow packages yet'
          : filter === 'agents'
            ? 'No agent packages yet'
            : 'No library items yet';

  const emptyBody = filter === 'apps'
    ? 'Apps you build or install appear here. Create one from the Apps page, or import an .agentisapp package.'
    : filter === 'extensions'
      ? 'Create a sandboxed node-worker extension to make deterministic runtime work available to workflows.'
        : filter === 'workflows'
          ? 'Workflows are mirrored into packages automatically when you create or update them.'
          : filter === 'agents'
            ? 'Agents can be packaged to carry their full configuration (instructions, role, memory configuration).'
            : 'Create apps, workflows, agents, or extensions to fill this workspace library.';

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-4">
        <div>
          <h1 className="text-display text-text-primary">Packages</h1>
          <div className="mt-0.5 text-[12px] text-text-muted">
            One library for Agentic Apps, agents, runtime extensions, and reusable workflows.
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="secondary" size="md" iconLeft={<ArrowDownToLine size={14} />} onClick={() => void handleImport()}>
            Import
          </Button>
          <Button variant="secondary" size="md" iconLeft={<Boxes size={14} />} onClick={() => setWorkspaceBundleOpen(true)}>
            Export workspace
          </Button>
          <Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={() => setExtensionStudioOpen(true)}>
            New extension
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-6 py-3">
        <FilterTabs value={filter} counts={counts} onChange={setFilter} />
        <div className="ml-auto w-full sm:w-80">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder={`Search ${filter === 'all' ? 'library' : filter}...`}
            bindSlashShortcut
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {filter === 'extensions' && (
          <ExtensionStudioIntro extensionCount={extensions.length} onCreate={() => setExtensionStudioOpen(true)} />
        )}

        {loading && filtered.length === 0 ? (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-3 md:grid-cols-2">
            <Skeleton height={172} />
            <Skeleton height={172} />
            <Skeleton height={172} />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={filter === 'extensions' ? <Puzzle size={48} /> : <SearchX size={48} />}
            title={search.trim() ? `No matching ${filter === 'all' ? 'items' : filter}` : emptyTitle}
            body={search.trim() ? 'Try adjusting your search or changing the filter.' : emptyBody}
            primaryAction={
              search.trim()
                ? <Button variant="secondary" size="sm" onClick={() => setSearch('')}>Clear search</Button>
                : filter === 'extensions'
                  ? <Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={() => setExtensionStudioOpen(true)}>Create extension</Button>
                  : undefined
            }
            variant="page"
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-3 md:grid-cols-2">
            {filtered.map((item) => (
              <LibraryCard
                key={item.id}
                item={item}
                onOpen={() => handleOpenItem(item)}
                onExportWorkflow={() => void handleExportWorkflow(item.source as WorkflowPackage)}
                onExportApp={() => void handleExportApp(item.source as AppRecord)}
                onExportExtension={() => handleExportExtension(item.source as WorkspaceExtension)}
                onDuplicateWorkflow={() => void handleDuplicateWorkflow(item.source as WorkflowPackage)}
                onDeleteWorkflow={() => void handleDeleteWorkflow(item.source as WorkflowPackage)}
              />
            ))}
          </div>
        )}
      </div>

      {openWorkflow && (
        <PackageDetailDrawer
          pkg={openWorkflow}
          onClose={() => setOpenWorkflow(null)}
          onDeleted={() => { void refresh(); }}
          onDuplicated={() => { void refresh(); }}
        />
      )}
      {openExtension && (
        <ExtensionDetailDrawer
          extension={openExtension}
          onClose={() => setOpenExtension(null)}
          onDeleted={() => {
            setOpenExtension(null);
            void refresh();
          }}
        />
      )}
      {extensionStudioOpen && (
        <ExtensionStudioModal
          onClose={() => setExtensionStudioOpen(false)}
          onCreated={() => {
            setExtensionStudioOpen(false);
            setFilter('extensions');
            setSearch('');
            void refresh();
          }}
        />
      )}
      {(workspaceBundleOpen || importBundle) && (
        <WorkspaceBundleModal
          {...(importBundle ? { importEnvelope: importBundle } : {})}
          onClose={() => { setWorkspaceBundleOpen(false); setImportBundle(null); }}
          onImported={() => { void refresh(); }}
        />
      )}
    </div>
  );
}

function FilterTabs({
  value,
  counts,
  onChange,
}: {
  value: LibraryFilter;
  counts: Record<LibraryFilter, number>;
  onChange: (filter: LibraryFilter) => void;
}) {
  const tabs: Array<{ value: LibraryFilter; label: string; icon: ReactNode }> = [
    { value: 'all', label: 'All', icon: <Boxes size={12} /> },
    { value: 'apps', label: 'Apps', icon: <LayoutGrid size={12} /> },
    { value: 'agents', label: 'Agents', icon: <Bot size={12} /> },
    { value: 'workflows', label: 'Workflows', icon: <WorkflowIcon size={12} /> },
    { value: 'extensions', label: 'Extensions', icon: <Puzzle size={12} /> },
  ];

  return (
    <div role="tablist" aria-label="Package library filter" className="flex rounded-pill border border-line bg-surface-2 p-1 text-[12px]">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={value === tab.value}
          onClick={() => onChange(tab.value)}
          className={`inline-flex h-7 items-center gap-1.5 rounded-pill px-3 transition-colors ${
            value === tab.value ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-primary'
          }`}
        >
          {tab.icon}
          {tab.label}
          <span className="rounded-pill border border-line bg-surface px-1.5 py-0.5 text-[10px] leading-none text-text-muted">
            {counts[tab.value]}
          </span>
        </button>
      ))}
    </div>
  );
}

function ExtensionStudioIntro({ extensionCount, onCreate }: { extensionCount: number; onCreate: () => void }) {
  return (
    <section className="mb-4 overflow-hidden rounded-card border border-line bg-surface">
      <div className="grid gap-0 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="p-5">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-accent">
            <ShieldCheck size={12} /> Extension runtime
          </div>
          <h2 className="mt-2 text-heading text-text-primary">Sandboxed code, explicit permissions, reusable workflow nodes.</h2>
          <p className="mt-2 max-w-2xl text-[13px] leading-5 text-text-secondary">
            Extensions are deterministic capability units: typed inputs, declared permissions, structured outputs, and workflow-ready execution.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Pill icon={<Puzzle size={11} />} label={`${extensionCount} installed`} />
            <Pill icon={<Code2 size={11} />} label="node_worker local authoring" />
            <Pill icon={<FileJson size={11} />} label="manifest-backed" />
          </div>
        </div>
        <div className="border-t border-line bg-canvas/35 p-5 lg:border-l lg:border-t-0">
          <div className="grid grid-cols-2 gap-2">
            {PERMISSIONS.slice(0, 4).map((permission) => {
              const Icon = permission.icon;
              return (
                <div key={permission.value} className={`rounded-card border px-3 py-2.5 ${permission.tone}`}>
                  <Icon size={14} />
                  <div className="mt-2 text-[12px] font-semibold">{permission.label}</div>
                  <div className="mt-0.5 line-clamp-2 text-[11px] opacity-80">{permission.description}</div>
                </div>
              );
            })}
          </div>
          <Button className="mt-3 w-full" variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={onCreate}>
            Create local extension
          </Button>
        </div>
      </div>
    </section>
  );
}

function Pill({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-pill border border-line bg-surface-2 px-2.5 py-1 text-[11px] text-text-secondary">
      {icon}
      {label}
    </span>
  );
}

function LibraryCard({
  item,
  onOpen,
  onExportWorkflow,
  onExportApp,
  onExportExtension,
  onDuplicateWorkflow,
  onDeleteWorkflow,
}: {
  item: LibraryItem;
  onOpen: () => void;
  onExportWorkflow: () => void;
  onExportApp: () => void;
  onExportExtension: () => void;
  onDuplicateWorkflow: () => void;
  onDeleteWorkflow: () => void;
}) {
  if (item.kind === 'app') {
    return <AppLibraryCard app={item.source as AppRecord} onOpen={onOpen} onExport={onExportApp} />;
  }
  if (item.kind === 'extension') {
    return <ExtensionCard extension={item.source as WorkspaceExtension} onOpen={onOpen} onExport={onExportExtension} />;
  }
  if (item.kind === 'agent') {
    return (
      <AgentPackageCard
        p={item.source as WorkflowPackage}
        onOpen={onOpen}
        onExport={onExportWorkflow}
        onDuplicate={onDuplicateWorkflow}
        onDelete={onDeleteWorkflow}
      />
    );
  }
  return (
    <WorkflowPackageCard
      p={item.source as WorkflowPackage}
      onOpen={onOpen}
      onExport={onExportWorkflow}
      onDuplicate={onDuplicateWorkflow}
      onDelete={onDeleteWorkflow}
    />
  );
}

function AppLibraryCard({ app, onOpen, onExport }: { app: AppRecord; onOpen: () => void; onExport: () => void }) {
  const iconIsImage = Boolean(app.icon && (app.icon.startsWith('http') || app.icon.startsWith('data:image/')));
  return (
    <article className="group rounded-card border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-surface-2">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-card border border-violet-400/20 bg-violet-500/10 text-violet-300">
          {iconIsImage ? <img src={app.icon ?? ''} alt="" className="h-full w-full object-cover" /> : app.icon ? <span className="text-[17px]">{app.icon}</span> : <LayoutGrid size={17} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <button type="button" onClick={onOpen} className="min-w-0 truncate text-left text-subheading text-text-primary hover:underline">
              {app.name}
            </button>
            <span className="shrink-0 rounded-pill border border-line bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-muted">{app.status}</span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-text-muted">{app.slug}{app.version ? `@${app.version}` : ''}</div>
          {app.description && <div className="mt-2 line-clamp-2 text-[12px] leading-5 text-text-secondary">{app.description}</div>}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Pill icon={<LayoutGrid size={11} />} label="Agentic App" />
      </div>
      <div className="mt-4 flex gap-1.5">
        <Button variant="secondary" size="sm" iconLeft={<LayoutGrid size={12} />} onClick={onOpen}>Open app</Button>
        <Button variant="ghost" size="sm" iconLeft={<ArrowUpFromLine size={11} />} onClick={onExport}>Export</Button>
      </div>
    </article>
  );
}

function ExtensionCard({ extension, onOpen, onExport }: { extension: WorkspaceExtension; onOpen: () => void; onExport: () => void }) {
  const permissions = extension.manifest.permissions ?? [];
  const operationCount = extension.manifest.operations?.length ?? 1;
  return (
    <article className="group rounded-card border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-surface-2">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card border border-emerald-400/20 bg-emerald-500/10 text-emerald-300">
          <Puzzle size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <button type="button" onClick={onOpen} className="min-w-0 truncate text-left text-subheading text-text-primary hover:underline">
              {extension.name || extension.slug}
            </button>
            <span className="shrink-0 rounded-pill border border-line bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-muted">
              {extension.runtime}
            </span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-text-muted">{extension.slug}{extension.version ? `@${extension.version}` : ''}</div>
          <div className="mt-2 inline-flex rounded-pill border border-emerald-400/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300">
            {operationCount} {operationCount === 1 ? 'operation' : 'operations'}
          </div>
          {extension.manifest.description && (
            <div className="mt-2 line-clamp-2 text-[12px] leading-5 text-text-secondary">{extension.manifest.description}</div>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {permissions.length > 0 ? permissions.slice(0, 4).map((permission) => (
          <PermissionBadge key={permission} permission={permission} />
        )) : (
          <span className="rounded-pill border border-line bg-surface-2 px-2 py-1 text-[11px] text-text-muted">no permissions</span>
        )}
        {permissions.length > 4 && <span className="text-[11px] text-text-muted">+{permissions.length - 4}</span>}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <Button variant="secondary" size="sm" iconLeft={<FileJson size={12} />} onClick={onOpen}>Inspect</Button>
        <Button variant="ghost" size="sm" iconLeft={<ArrowUpFromLine size={11} />} onClick={onExport}>Export</Button>
        <button
          type="button"
          onClick={() => void navigator.clipboard?.writeText(extension.slug)}
          className="inline-flex h-8 items-center gap-1.5 rounded-btn px-2.5 text-[12px] text-text-muted hover:bg-surface-3 hover:text-text-primary"
        >
          <Copy size={12} /> Slug
        </button>
      </div>
    </article>
  );
}

function WorkflowPackageCard({
  p,
  onExport,
  onDelete,
  onOpen,
  onDuplicate,
}: {
  p: WorkflowPackage;
  onExport: () => void;
  onDelete: () => void;
  onOpen: () => void;
  onDuplicate: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <article className="group rounded-card border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-surface-2">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card border border-sky-400/20 bg-sky-500/10 text-sky-300">
          <WorkflowIcon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <button type="button" onClick={onOpen} className="block w-full truncate text-left text-subheading text-text-primary hover:underline">
            {p.name}
          </button>
          <div className="mt-0.5 truncate font-mono text-[11px] text-text-muted">{p.slug}{p.version ? `@${p.version}` : ''}</div>
          {p.description && <div className="mt-2 line-clamp-2 text-[12px] text-text-secondary">{p.description}</div>}
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Actions"
            className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-3 hover:text-text-primary"
          >
            <MoreHorizontal size={14} />
          </button>
          {menuOpen && (
            <div onMouseLeave={() => setMenuOpen(false)} className="absolute right-0 z-10 mt-1 w-44 rounded-card border border-line bg-surface shadow-dropdown">
              <MenuItem icon={<Edit3 size={12} />} onClick={() => { setMenuOpen(false); onOpen(); }}>Open</MenuItem>
              <MenuItem icon={<Copy size={12} />} onClick={() => { setMenuOpen(false); onDuplicate(); }}>Duplicate</MenuItem>
              <MenuItem icon={<ArrowUpFromLine size={12} />} onClick={() => { setMenuOpen(false); onExport(); }}>Export</MenuItem>
              <div className="my-1 border-t border-line" />
              <MenuItem icon={<Trash2 size={12} />} danger onClick={() => { setMenuOpen(false); onDelete(); }}>Delete</MenuItem>
            </div>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Pill icon={<WorkflowIcon size={11} />} label="workflow package" />
      </div>
      <div className="mt-4 flex gap-1.5">
        <Button variant="secondary" size="sm" onClick={onOpen}>Open</Button>
        <Button variant="ghost" size="sm" iconLeft={<ArrowUpFromLine size={11} />} onClick={onExport}>Export</Button>
      </div>
    </article>
  );
}

function AgentPackageCard({
  p,
  onExport,
  onDelete,
  onOpen,
  onDuplicate,
}: {
  p: WorkflowPackage;
  onExport: () => void;
  onDelete: () => void;
  onOpen: () => void;
  onDuplicate: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const normRole = (p.role ?? 'worker').toLowerCase();
  const roleLabel = normRole === 'orchestrator' ? 'Orchestrator'
    : normRole === 'manager' ? 'Manager'
    : 'Specialist';

  const roleColorTone = normRole === 'orchestrator' ? 'text-violet-300 bg-violet-500/10 border-violet-400/20'
    : normRole === 'manager' ? 'text-sky-300 bg-sky-500/10 border-sky-400/20'
    : 'text-emerald-300 bg-emerald-500/10 border-emerald-400/20';

  return (
    <article className="group rounded-card border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-surface-2">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card border border-violet-400/20 bg-violet-500/10 text-violet-300">
          <Bot size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <button type="button" onClick={onOpen} className="min-w-0 truncate text-left text-subheading text-text-primary hover:underline">
              {p.name}
            </button>
            <span className={`shrink-0 rounded-pill border px-1.5 py-0.5 text-[10px] ${roleColorTone}`}>
              {roleLabel}
            </span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-text-muted">{p.slug}{p.version ? `@${p.version}` : ''}</div>
          {p.description && <div className="mt-2 line-clamp-2 text-[12px] text-text-secondary">{p.description}</div>}
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Actions"
            className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-3 hover:text-text-primary"
          >
            <MoreHorizontal size={14} />
          </button>
          {menuOpen && (
            <div onMouseLeave={() => setMenuOpen(false)} className="absolute right-0 z-10 mt-1 w-44 rounded-card border border-line bg-surface shadow-dropdown">
              <MenuItem icon={<Edit3 size={12} />} onClick={() => { setMenuOpen(false); onOpen(); }}>Open</MenuItem>
              <MenuItem icon={<Copy size={12} />} onClick={() => { setMenuOpen(false); onDuplicate(); }}>Duplicate</MenuItem>
              <MenuItem icon={<ArrowUpFromLine size={12} />} onClick={() => { setMenuOpen(false); onExport(); }}>Export</MenuItem>
              <div className="my-1 border-t border-line" />
              <MenuItem icon={<Trash2 size={12} />} danger onClick={() => { setMenuOpen(false); onDelete(); }}>Delete</MenuItem>
            </div>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Pill icon={<Bot size={11} />} label="agent package" />
      </div>
      <div className="mt-4 flex gap-1.5">
        <Button variant="secondary" size="sm" onClick={onOpen}>Open</Button>
        <Button variant="ghost" size="sm" iconLeft={<ArrowUpFromLine size={11} />} onClick={onExport}>Export</Button>
      </div>
    </article>
  );
}

function PermissionBadge({ permission }: { permission: string }) {
  const meta = PERMISSIONS.find((p) => p.value === permission);
  const Icon = meta?.icon ?? ShieldCheck;
  return (
    <span className={`inline-flex items-center gap-1 rounded-pill border px-2 py-1 text-[11px] ${meta?.tone ?? 'border-line bg-surface-2 text-text-muted'}`}>
      <Icon size={10} />
      {meta?.label ?? permission}
    </span>
  );
}

function MenuItem({
  icon,
  danger,
  onClick,
  children,
}: {
  icon?: ReactNode;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-surface-2 ${
        danger ? 'text-danger hover:text-danger' : 'text-text-secondary hover:text-text-primary'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function ExtensionDetailDrawer({
  extension,
  onClose,
  onDeleted,
}: {
  extension: WorkspaceExtension;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const permissions = extension.manifest.permissions ?? [];
  const operations = extension.manifest.operations?.length
    ? extension.manifest.operations
    : [{ name: 'execute', description: 'Default operation', inputSchema: {}, outputSchema: {} }];

  async function deleteExtension() {
    const ok = await confirm({
      title: `Uninstall "${extension.name}"?`,
      body: 'Workflow nodes that reference this extension will need a replacement before they can run.',
      confirmLabel: 'Uninstall',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api(`/v1/extensions/${extension.id}`, { method: 'DELETE' });
      toast.success('Extension uninstalled', extension.name);
      onDeleted();
    } catch (err) {
      toast.error('Uninstall failed', apiErrorMessage(err));
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-[55] bg-overlay-soft" onClick={onClose} />
      <div className="animate-slide-in-right fixed inset-y-0 right-0 z-[56] flex w-full max-w-xl flex-col border-l border-line bg-surface shadow-modal">
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card border border-emerald-400/20 bg-emerald-500/10 text-emerald-300">
            <Puzzle size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-heading text-text-primary">{extension.name || extension.slug}</div>
            <div className="mt-0.5 font-mono text-[11px] text-text-muted">{extension.slug}@{extension.version}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="space-y-5">
            {extension.manifest.description && <p className="text-[13px] leading-5 text-text-secondary">{extension.manifest.description}</p>}

            <section>
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                <ShieldCheck size={10} /> Permissions
              </div>
              <div className="flex flex-wrap gap-1.5">
                {permissions.length > 0 ? permissions.map((permission) => (
                  <PermissionBadge key={permission} permission={permission} />
                )) : (
                  <span className="rounded-pill border border-line bg-surface-2 px-2 py-1 text-[11px] text-text-muted">no permissions</span>
                )}
              </div>
            </section>

            <section className="grid grid-cols-2 gap-2">
              <Metric label="Runtime" value={extension.runtime} />
              <Metric label="Timeout" value={`${extension.manifest.timeoutMs ?? 30000}ms`} />
              <Metric label="Operations" value={String(operations.length)} />
              <Metric label="Allowed domains" value={String(extension.manifest.allowedDomains?.length ?? 0)} />
            </section>

            <section>
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                <Boxes size={10} /> Operations
              </div>
              <div className="space-y-2">
                {operations.map((operation) => (
                  <div key={operation.name} className="rounded-card border border-line bg-surface-2 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-mono text-[12px] font-semibold text-text-primary">{operation.name}</div>
                      <span className="rounded-pill border border-line bg-surface px-2 py-0.5 text-[10px] text-text-muted">
                        {schemaType(JSON.stringify(operation.inputSchema))} → {schemaType(JSON.stringify(operation.outputSchema))}
                      </span>
                    </div>
                    {operation.description && (
                      <p className="mt-1 text-[12px] leading-5 text-text-secondary">{operation.description}</p>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <ExtensionTestConsole extension={extension} operations={operations} />

            <section>
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                <Terminal size={10} /> Source
              </div>
              <pre className="max-h-72 overflow-auto rounded-card border border-line bg-canvas p-3 text-[11px] leading-5 text-text-secondary">
                {extension.manifest.source ?? '// source not stored on manifest'}
              </pre>
            </section>

            <section className="grid gap-3 md:grid-cols-2">
              <SchemaBlock title="Input schema" value={operations[0]?.inputSchema ?? {}} />
              <SchemaBlock title="Output schema" value={operations[0]?.outputSchema ?? {}} />
            </section>
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-line bg-surface-2 px-5 py-3">
          <Button variant="secondary" size="sm" iconLeft={<Copy size={12} />} onClick={() => void navigator.clipboard?.writeText(extension.slug)}>
            Copy slug
          </Button>
          <button
            type="button"
            onClick={() => void deleteExtension()}
            className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-btn px-2.5 text-[12px] font-medium text-danger hover:bg-danger-soft"
          >
            <Trash2 size={12} />
            Uninstall
          </button>
        </div>
      </div>
    </>
  );
}

function ExtensionTestConsole({
  extension,
  operations,
}: {
  extension: WorkspaceExtension;
  operations: ExtensionOperation[];
}) {
  const [operationName, setOperationName] = useState(operations[0]?.name ?? 'execute');
  const [input, setInput] = useState('{\n  "url": "https://example.com"\n}');
  const [result, setResult] = useState<unknown>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const parsed = JSON.parse(input) as Record<string, unknown>;
      const response = await api<{ result: unknown }>(`/v1/extensions/${extension.id}/test`, {
        method: 'POST',
        body: JSON.stringify({ operationName, input: parsed }),
      });
      setResult(response.result);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <section>
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        <Terminal size={10} /> Test console
      </div>
      <div className="rounded-card border border-line bg-surface-2 p-3">
        <div className="grid gap-2 md:grid-cols-[160px_1fr]">
          <select className={INPUT_CLS} value={operationName} onChange={(event) => setOperationName(event.target.value)}>
            {operations.map((operation) => (
              <option key={operation.name} value={operation.name}>{operation.name}</option>
            ))}
          </select>
          <Button variant="secondary" size="sm" iconLeft={<Zap size={12} />} loading={running} onClick={() => void run()}>
            Run test
          </Button>
        </div>
        <textarea value={input} onChange={(event) => setInput(event.target.value)} rows={5} className={`${CODE_TEXTAREA_CLS} mt-2`} spellCheck={false} />
        {error && <div className="mt-2 rounded-card border border-danger/30 bg-danger-soft px-3 py-2 text-[12px] text-danger">{error}</div>}
        {result !== null && (
          <pre className="mt-2 max-h-56 overflow-auto rounded-card border border-line bg-canvas p-3 text-[11px] leading-5 text-text-secondary">
            {JSON.stringify(result, null, 2)}
          </pre>
        )}
      </div>
    </section>
  );
}

function PackageDetailDrawer({
  pkg,
  onClose,
  onDeleted,
  onDuplicated,
}: {
  pkg: WorkflowPackage;
  onClose: () => void;
  onDeleted: () => void;
  onDuplicated: () => void;
}) {
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [detail, setDetail] = useState<PackageDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [duplicating, setDuplicating] = useState(false);

  useEffect(() => {
    setLoading(true);
    setDetail(null);
    void api<PackageDetail>(`/v1/packages/${pkg.id}`)
      .then(setDetail)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [pkg.id]);

  async function drawerExport() {
    if (!detail) return;
    const ext = detail.package.kind === 'agent' ? 'agentisagt' : 'agentiswf';
    downloadJson(detail.package.manifest, `${detail.package.slug}.${ext}`);
    toast.success('Exported', detail.package.name);
  }

  async function drawerDuplicate() {
    if (!detail || duplicating) return;
    setDuplicating(true);
    try {
      await api(`/v1/packages/${pkg.id}/duplicate`, { method: 'POST' });
      toast.success('Duplicated', `Copy of ${detail.package.name}`);
      onDuplicated();
      onClose();
    } catch (err) {
      toast.error('Duplicate failed', apiErrorMessage(err));
    } finally {
      setDuplicating(false);
    }
  }

  async function drawerDelete() {
    const ok = await confirm({
      title: `Delete "${pkg.name}"?`,
      body: 'You can undo this for 5 seconds.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;

    const manifest = detail ? (detail.package.manifest as Record<string, unknown>) : null;
    try {
      await api(`/v1/packages/${pkg.id}`, { method: 'DELETE' });
      onClose();
      onDeleted();
      toast.undo(`Deleted "${pkg.name}"`, async () => {
        try {
          if (manifest) {
            await api('/v1/packages/import', { method: 'POST', body: JSON.stringify({ manifest }) });
          }
          toast.success('Restored', pkg.name);
          onDeleted();
        } catch {
          toast.error('Could not restore', pkg.name);
        }
      });
    } catch (err) {
      toast.error('Delete failed', apiErrorMessage(err));
    }
  }

  const totalItems = (detail?.workflows.length ?? 0) + (detail?.agents?.length ?? 0);

  return (
    <>
      <div className="fixed inset-0 z-[55] bg-overlay-soft" onClick={onClose} />
      <div className="animate-slide-in-right fixed inset-y-0 right-0 z-[56] flex w-full max-w-md flex-col border-l border-line bg-surface shadow-modal">
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          {pkg.kind === 'agent' ? (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card border border-violet-400/20 bg-violet-500/10 text-violet-300">
              <Bot size={18} />
            </span>
          ) : (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card border border-sky-400/20 bg-sky-500/10 text-sky-300">
              <WorkflowIcon size={18} />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-heading text-text-primary">{pkg.name}</div>
            <div className="mt-0.5 font-mono text-[11px] text-text-muted">{pkg.slug}{pkg.version ? `@${pkg.version}` : ''}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="space-y-3">
              <Skeleton height={20} />
              <Skeleton height={80} />
            </div>
          ) : (
            <div className="space-y-5">
              {pkg.description && <p className="text-[13px] text-text-secondary">{pkg.description}</p>}
              {(detail?.workflows.length ?? 0) > 0 && (
                <section>
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                    <WorkflowIcon size={10} /> Workflows
                  </div>
                  <div className="space-y-1">
                    {detail!.workflows.map((workflow) => (
                      <div key={workflow.id} className="flex items-center justify-between rounded-card border border-line bg-surface-2 px-3 py-2.5">
                        <span className="text-[13px] text-text-primary">{workflow.title}</span>
                        {workflow.id && !workflow.id.startsWith('pkg:') && (
                          <button
                            type="button"
                            onClick={() => { onClose(); nav(`/apps/workflows/${workflow.id}`); }}
                            className="text-[11px] font-medium text-accent hover:underline"
                          >
                            Open canvas
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {detail?.package?.kind === 'agent' && detail?.agents && detail.agents.length > 0 && (
                <section>
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                    <Bot size={10} /> Agents
                  </div>
                  <div className="space-y-1">
                    {detail.agents.map((agent) => (
                      <div key={agent.id} className="flex items-center justify-between rounded-card border border-line bg-surface-2 px-3 py-2.5">
                        <span className="text-[13px] text-text-primary">{agent.name}</span>
                        {agent.id && (
                          <button
                            type="button"
                            onClick={() => { onClose(); nav(`/agents/${agent.id}`); }}
                            className="text-[11px] font-medium text-accent hover:underline"
                          >
                            Open agent
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {!loading && totalItems === 0 && (
                <div className="rounded-card border border-line bg-surface-2 px-4 py-8 text-center text-[12px] text-text-muted">
                  No linked items in this package.
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-line bg-surface-2 px-5 py-3">
          <Button variant="secondary" size="sm" iconLeft={<Copy size={12} />} onClick={() => void drawerDuplicate()} disabled={!detail || duplicating}>
            {duplicating ? 'Duplicating...' : 'Duplicate'}
          </Button>
          <Button variant="secondary" size="sm" iconLeft={<ArrowUpFromLine size={12} />} onClick={() => void drawerExport()} disabled={!detail}>
            Export
          </Button>
          <button type="button" onClick={() => void drawerDelete()} className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-btn px-2.5 text-[12px] font-medium text-danger hover:bg-danger-soft">
            <Trash2 size={12} />
            Delete
          </button>
        </div>
      </div>
    </>
  );
}

function Field({
  label,
  children,
  className = '',
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-text-muted">{label}</span>
      {children}
    </label>
  );
}

function PreviewRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-text-muted">{label}</span>
      <span className={`truncate text-text-primary ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-line bg-surface-2 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className="mt-1 truncate text-[13px] font-semibold text-text-primary">{value}</div>
    </div>
  );
}

function SchemaBlock({ title, value }: { title: string; value: Record<string, unknown> }) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        <FileJson size={10} /> {title}
      </div>
      <pre className="max-h-44 overflow-auto rounded-card border border-line bg-canvas p-3 text-[11px] leading-5 text-text-secondary">
        {JSON.stringify(value, null, 2)}
      </pre>
    </section>
  );
}

function downloadJson(value: unknown, fileName: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}


function schemaType(value: string): string {
  try {
    const parsed = JSON.parse(value) as { type?: unknown };
    return typeof parsed.type === 'string' ? parsed.type : 'object';
  } catch {
    return 'invalid';
  }
}

/** A node-worker extension manifest is identified by its runtime + operations. */
function isExtensionManifest(json: Record<string, unknown>): boolean {
  return json.runtime === 'node_worker' && Array.isArray(json.operations);
}

function pluralKind(kind: LibraryKind): Exclude<LibraryFilter, 'all'> {
  if (kind === 'app') return 'apps';
  if (kind === 'agent') return 'agents';
  if (kind === 'workflow') return 'workflows';
  return 'extensions';
}

const INPUT_CLS =
  'w-full rounded-input border border-line bg-surface-2 px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted outline-none focus:border-accent';

const TEXTAREA_CLS =
  'w-full resize-none rounded-input border border-line bg-surface-2 px-3 py-2 text-[13px] leading-5 text-text-primary placeholder:text-text-muted outline-none focus:border-accent';

const CODE_TEXTAREA_CLS =
  'w-full resize-none rounded-input border border-line bg-canvas px-3 py-2 font-mono text-[12px] leading-5 text-text-primary placeholder:text-text-muted outline-none focus:border-accent';



