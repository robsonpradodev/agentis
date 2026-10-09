import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Background,
  Controls,
  ControlButton,
  Handle,
  Panel,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import clsx from 'clsx';
import { Loader2, Plus, LayoutGrid } from 'lucide-react';
import { api } from '../../lib/api';
import { useAgentInstallSession } from '../../hooks/useBackgroundInstall';
import { dismissInstallSession, type InstallSession } from '../../lib/backgroundInstall';
import { AgentQuickDetailPanel } from './AgentQuickDetailPanel';

export type AgentHierarchyCreatePreset = {
  role?: 'orchestrator' | 'manager' | 'worker';
  spaceId?: string | null;
};

export interface AgentHierarchyAgent {
  id: string;
  name: string;
  description?: string | null;
  status?: string | null;
  adapterType?: string | null;
  runtimeModel?: string | null;
  avatarGlyph?: string | null;
  avatarUrl?: string | null;
  colorHex?: string | null;
  role?: string | null;
  reportsTo?: string | null;
  isPaused?: boolean | null;
  currentTaskId?: string | null;
  currentTask?: string | null;
  capabilityTags?: string[] | null;
  spaceId?: string | null;
  spaceName?: string | null;
  spaceColorHex?: string | null;
  spaceTag?: string | null;
  /** Top-level Domain (parent of the subdomain when the agent is a specialist). */
  domainId?: string | null;
  domainName?: string | null;
  /** Subdomain the specialist is responsible for (a domain row with a parent). */
  subdomainId?: string | null;
  subdomainName?: string | null;
  lastActiveAt?: string | null;
  lastHeartbeatAt?: string | null;
  currentMonthSpendCents?: number | null;
  monthlyBudgetCents?: number | null;
  canvasPosition?: { x: number; y: number } | null;
  runsToday?: number | null;
  spendTodayCents?: number | null;
  pendingApprovals?: number | null;
  connectionCounts?: {
    workflows: number;
  } | null;
  isGhost?: boolean | null;
  ghostDescription?: string | null;
  createPreset?: AgentHierarchyCreatePreset | null;
}

interface AgentNodeData extends Record<string, unknown> {
  agent: AgentHierarchyAgent;
  onGhostCreate?: (preset?: AgentHierarchyCreatePreset) => void;
  tierCount?: number;
  /** Specialists render as compact nodes clustered under their manager. */
  isSpecialist?: boolean;
}

const TIER_Y: Record<'orchestrator' | 'manager' | 'worker' | 'unassigned', number> = {
  orchestrator: 120,
  manager: 300,
  worker: 480,
  unassigned: 650,
};

const nodeTypes = { agentHierarchy: AgentHierarchyNode };
type AgentFleetFilterValue = 'all' | 'active' | 'idle' | 'setup_needed';

export function AgentHierarchyCanvas({
  agents,
  onChanged,
  onSelect,
  selectedAgent,
  onCloseSelection,
  onGhostCreate,
  filter,
  search,
  onClearFilters,
  topLeftSlot,
  topRightSlot,
}: {
  agents: AgentHierarchyAgent[];
  onChanged: () => void;
  onSelect: (agent: AgentHierarchyAgent) => void;
  selectedAgent: AgentHierarchyAgent | null;
  onCloseSelection: () => void;
  onGhostCreate?: (preset?: AgentHierarchyCreatePreset) => void;
  filter: AgentFleetFilterValue;
  search: string;
  onClearFilters: () => void;
  /** Controls floated directly on the canvas instead of a page header. */
  topLeftSlot?: ReactNode;
  topRightSlot?: ReactNode;
}) {
  const onGhostCreateRef = useRef(onGhostCreate);
  onGhostCreateRef.current = onGhostCreate;
  const stableOnGhostCreate = useMemo(
    () => (preset?: AgentHierarchyCreatePreset) => onGhostCreateRef.current?.(preset),
    [],
  );
  const visibleAgents = useMemo(
    // Specialists (workers) are now first-class on the canvas: they render as
    // smaller nodes clustered under the manager they report to.
    () => agents.filter((agent) => matchesFleetFilter(agent, filter) && matchesFleetSearch(agent, search)),
    [agents, filter, search],
  );
  const graph = useMemo(
    () => buildGraph(visibleAgents, {
      showGhostOrchestrator: !hasRole(agents, 'orchestrator') && filter === 'all' && search.trim().length === 0,
    }, stableOnGhostCreate),
    [agents, filter, search, stableOnGhostCreate, visibleAgents],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<AgentNodeData>>(graph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);
  const [resettingLayout, setResettingLayout] = useState(false);
  const persistTimers = useRef(new Map<string, number>());
  const reconcileSignatureRef = useRef<string>('');
  const autoLayoutSignatureRef = useRef<string>('');
  const fitSignatureRef = useRef<string>('');
  const flowRef = useRef<ReactFlowInstance<Node<AgentNodeData>, Edge> | null>(null);

  useEffect(() => {
    const unplacedSignature = agents
      .filter((agent) => !agent.isGhost && !isPersistedCanvasPosition(agent.canvasPosition))
      .map((agent) => agent.id)
      .sort()
      .join('|');
    if (!unplacedSignature) {
      autoLayoutSignatureRef.current = '';
      return;
    }
    if (resettingLayout || unplacedSignature === autoLayoutSignatureRef.current) return;
    autoLayoutSignatureRef.current = unplacedSignature;
    void resetLayout().catch(() => {
      if (autoLayoutSignatureRef.current === unplacedSignature) autoLayoutSignatureRef.current = '';
    });
  }, [agents, resettingLayout]);

  useEffect(() => {
    setNodes(graph.nodes);
    setEdges(graph.edges);
    const signature = graph.nodes
      .map((node) => `${node.id}:${normalizeRole(node.data.agent)}:${node.data.agent.reportsTo ?? 'root'}`)
      .join('|');
    if (signature !== fitSignatureRef.current) {
      fitSignatureRef.current = signature;
      requestFleetFit(flowRef.current);
    }
  }, [graph, setEdges, setNodes]);

  useEffect(() => {
    return () => {
      for (const timeoutId of persistTimers.current.values()) window.clearTimeout(timeoutId);
      persistTimers.current.clear();
    };
  }, []);

  useEffect(() => {
    const patches = hierarchyPatches(agents);
    const signature = patches.map((patch) => `${patch.id}:${patch.reportsTo ?? 'none'}`).join('|');
    if (!signature || signature === reconcileSignatureRef.current) return;
    reconcileSignatureRef.current = signature;
    let cancelled = false;
    void Promise.all(patches.map((patch) => api(`/v1/agents/${patch.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ reportsTo: patch.reportsTo }),
    }))).then(() => {
      if (!cancelled) onChanged();
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [agents, onChanged]);

  async function connectAgents(connection: Connection) {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    await api(`/v1/agents/${connection.target}`, {
      method: 'PATCH',
      body: JSON.stringify({ reportsTo: connection.source }),
    });
    onChanged();
  }

  function persistPosition(node: Node) {
    const existing = persistTimers.current.get(node.id);
    if (existing) window.clearTimeout(existing);
    const timeoutId = window.setTimeout(() => {
      void api(`/v1/agents/${node.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ canvasPosition: node.position }),
      }).then(() => onChanged()).finally(() => {
        if (persistTimers.current.get(node.id) === timeoutId) persistTimers.current.delete(node.id);
      });
    }, 180);
    persistTimers.current.set(node.id, timeoutId);
  }

  async function resetLayout() {
    setResettingLayout(true);
    try {
      const nextGraph = buildGraph(visibleAgents, {
        forceAutoLayout: true,
        showGhostOrchestrator: !hasRole(agents, 'orchestrator') && filter === 'all' && search.trim().length === 0,
      }, stableOnGhostCreate);
      setNodes(nextGraph.nodes);
      setEdges(nextGraph.edges);
      requestFleetFit(flowRef.current);
      await Promise.all(nextGraph.nodes.filter((node) => !node.data.agent.isGhost).map((node) => api(`/v1/agents/${node.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ canvasPosition: node.position }),
      })));
      onChanged();
    } finally {
      setResettingLayout(false);
    }
  }

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onInit={(instance) => {
          flowRef.current = instance as ReactFlowInstance<Node<AgentNodeData>, Edge>;
          requestFleetFit(flowRef.current);
        }}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={(connection) => void connectAgents(connection)}
        onNodeClick={(_event, node) => onSelect(node.data.agent)}
        onNodeDragStop={(_event, node) => void persistPosition(node)}
        fitView
        fitViewOptions={{ padding: { top: 0.3, right: 0.1, bottom: 0.1, left: 0.1 }, minZoom: 0.1, maxZoom: 1 }}
        nodesDraggable
        nodesConnectable
        elementsSelectable
        proOptions={{ hideAttribution: true }}
        className="bg-canvas"
      >
        <Background color="#23252d" gap={28} />
        <Controls position="bottom-right" className="!border-line !bg-surface-2">
          <ControlButton
            type="button"
            onClick={() => void resetLayout()}
            disabled={resettingLayout}
            title="Tidy layout"
            aria-label="Tidy layout"
          >
            <LayoutGrid size={14} className={clsx(resettingLayout && "animate-spin")} />
          </ControlButton>
        </Controls>
      </ReactFlow>
      {(topLeftSlot || topRightSlot) && (
        <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex items-start gap-2">
          {topLeftSlot && <div className="pointer-events-auto flex min-w-0 items-center gap-2">{topLeftSlot}</div>}
          {topRightSlot && <div className="pointer-events-auto ml-auto flex shrink-0 items-center gap-2">{topRightSlot}</div>}
        </div>
      )}
      {visibleAgents.length === 0 && (
        <div className="pointer-events-none absolute inset-x-0 top-20 z-10 flex justify-center px-4">
          <div className="pointer-events-auto rounded-2xl border border-line bg-surface/95 px-5 py-4 text-center shadow-2xl backdrop-blur-xl">
            <div className="text-subheading text-text-primary">No agents match this view</div>
            <p className="mt-1 text-[12px] text-text-muted">Clear the canvas filters to bring the fleet back into view.</p>
            <button
              type="button"
              onClick={onClearFilters}
              className="mt-3 inline-flex h-8 items-center rounded-btn border border-line bg-surface-2 px-3 text-[12px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
            >
              Clear filters
            </button>
          </div>
        </div>
      )}
      <AgentQuickDetailPanel
        open={Boolean(selectedAgent)}
        agent={selectedAgent}
        onClose={onCloseSelection}
        onAgentUpdated={onChanged}
      />
    </div>
  );
}

function buildGraph(
  agents: AgentHierarchyAgent[],
  options: { forceAutoLayout?: boolean; showGhostOrchestrator?: boolean } = {},
  onGhostCreate?: (preset?: AgentHierarchyCreatePreset) => void,
): { nodes: Node<AgentNodeData>[]; edges: Edge[] } {
  const forceAutoLayout = options.forceAutoLayout ?? false;
  const groups = {
    orchestrator: agents.filter((agent) => normalizeRole(agent) === 'orchestrator'),
    manager: agents.filter((agent) => normalizeRole(agent) === 'manager'),
    worker: agents.filter((agent) => normalizeRole(agent) === 'worker'),
    unassigned: agents.filter((agent) => normalizeRole(agent) === 'unassigned'),
  };

  // A specialist cluster is wider than a manager card. Size the manager lane
  // from the widest child cluster so Tidy leaves a real gutter between
  // neighboring managers and their subagents.
  const specialistCountByManager = new Map<string, number>();
  for (const worker of groups.worker) {
    if (worker.reportsTo && groups.manager.some((manager) => manager.id === worker.reportsTo)) {
      specialistCountByManager.set(worker.reportsTo, (specialistCountByManager.get(worker.reportsTo) ?? 0) + 1);
    }
  }
  const managerSpacing = managerLaneSpacing(specialistCountByManager);

  const nodes: Node<AgentNodeData>[] = [];
  const placeTier = (tier: 'orchestrator' | 'manager' | 'unassigned', list: AgentHierarchyAgent[]) => {
    list.sort((a, b) => a.name.localeCompare(b.name)).forEach((agent, index) => {
      const fallback = fallbackPosition(tier, index, list.length, managerSpacing);
      nodes.push({
        id: agent.id,
        type: 'agentHierarchy',
        position: forceAutoLayout ? fallback : safeCanvasPosition(tier, agent.canvasPosition, fallback),
        data: { agent, onGhostCreate, tierCount: list.length },
      });
    });
  };
  placeTier('orchestrator', groups.orchestrator);
  placeTier('manager', groups.manager);
  placeTier('unassigned', groups.unassigned);

  // Specialists (workers) cluster under the manager they report to, rendered as
  // smaller nodes. Workers whose manager isn't visible fall back to a global row.
  const managerXById = new Map<string, number>();
  for (const node of nodes) {
    if (normalizeRole(node.data.agent) === 'manager') managerXById.set(node.id, node.position.x);
  }
  const workersByManager = new Map<string, AgentHierarchyAgent[]>();
  const unplacedWorkers: AgentHierarchyAgent[] = [];
  for (const worker of groups.worker) {
    if (worker.reportsTo && managerXById.has(worker.reportsTo)) {
      const list = workersByManager.get(worker.reportsTo) ?? [];
      list.push(worker);
      workersByManager.set(worker.reportsTo, list);
    } else {
      unplacedWorkers.push(worker);
    }
  }
  const totalWorkers = groups.worker.length;
  for (const [managerId, workers] of workersByManager) {
    const baseX = managerXById.get(managerId) ?? 0;
    workers.sort(bySubdomainThenName).forEach((agent, index) => {
      const fallback = specialistFallbackUnderManager(baseX, index, workers.length);
      nodes.push({
        id: agent.id,
        type: 'agentHierarchy',
        position: forceAutoLayout ? fallback : safeCanvasPosition('worker', agent.canvasPosition, fallback),
        data: { agent, onGhostCreate, tierCount: totalWorkers, isSpecialist: true },
      });
    });
  }
  unplacedWorkers.sort((a, b) => a.name.localeCompare(b.name)).forEach((agent, index) => {
    const fallback = fallbackPosition('worker', index, unplacedWorkers.length);
    nodes.push({
      id: agent.id,
      type: 'agentHierarchy',
      position: forceAutoLayout ? fallback : safeCanvasPosition('worker', agent.canvasPosition, fallback),
      data: { agent, onGhostCreate, tierCount: totalWorkers, isSpecialist: true },
    });
  });

  // Ghost orchestrator — shown when no orchestrator exists
  if (options.showGhostOrchestrator) {
    nodes.push({
      id: '__ghost_orchestrator__',
      type: 'agentHierarchy',
      position: { x: 0, y: TIER_Y.orchestrator },
      data: {
        agent: {
          id: '__ghost_orchestrator__',
          name: 'Set up the workspace orchestrator',
          ghostDescription: 'The orchestrator routes work, approvals, and command.',
          isGhost: true,
          createPreset: { role: 'orchestrator' },
          role: 'orchestrator',
          status: null,
          adapterType: null,
          runtimeModel: null,
          reportsTo: null,
        },
        onGhostCreate,
        tierCount: 1,
      },
    });
  }

  const relationships = derivedRelationships(agents);
  const visibleIds = new Set(nodes.map((node) => node.id));
  const edges = relationships
    .filter((relationship) => visibleIds.has(relationship.source) && visibleIds.has(relationship.target))
    .map((relationship) => {
      const agent = agents.find((item) => item.id === relationship.target);
      return {
        id: `${relationship.source}-${relationship.target}`,
        source: relationship.source,
        target: relationship.target,
        type: 'smoothstep',
        animated: agent?.status === 'busy' || Boolean(agent?.currentTaskId),
        style: { stroke: 'var(--color-line-strong)', strokeWidth: 1.5 },
      } satisfies Edge;
    });

  return { nodes, edges };
}

function derivedRelationships(agents: AgentHierarchyAgent[]): Array<{ source: string; target: string }> {
  const orchestrator = primaryOrchestrator(agents);
  const managers = agents.filter((agent) => normalizeRole(agent) === 'manager');
  const managerIds = new Set(managers.map((agent) => agent.id));
  const relationships: Array<{ source: string; target: string }> = [];

  if (orchestrator) {
    for (const manager of managers) {
      relationships.push({ source: orchestrator.id, target: manager.id });
    }
  }

  for (const worker of agents.filter((agent) => normalizeRole(agent) === 'worker')) {
    if (worker.reportsTo && managerIds.has(worker.reportsTo)) {
      relationships.push({ source: worker.reportsTo, target: worker.id });
    }
  }

  return relationships;
}

function hierarchyPatches(agents: AgentHierarchyAgent[]): Array<{ id: string; reportsTo: string | null }> {
  const orchestrator = primaryOrchestrator(agents);
  const patches: Array<{ id: string; reportsTo: string | null }> = [];
  for (const manager of agents.filter((agent) => normalizeRole(agent) === 'manager')) {
    const expected = orchestrator?.id ?? null;
    if ((manager.reportsTo ?? null) !== expected) {
      patches.push({ id: manager.id, reportsTo: expected });
    }
  }
  return patches;
}

function primaryOrchestrator(agents: AgentHierarchyAgent[]): AgentHierarchyAgent | null {
  return [...agents]
    .filter((agent) => normalizeRole(agent) === 'orchestrator')
    .sort((a, b) => readinessRank(b) - readinessRank(a) || a.name.localeCompare(b.name))[0] ?? null;
}

function hasRole(agents: AgentHierarchyAgent[], role: 'orchestrator' | 'manager' | 'worker' | 'unassigned'): boolean {
  return agents.some((agent) => normalizeRole(agent) === role);
}

function matchesFleetFilter(agent: AgentHierarchyAgent, filter: AgentFleetFilterValue): boolean {
  if (filter === 'all') return true;
  const status = readinessOf(agent);
  if (filter === 'active') return status === 'live' || status === 'running';
  if (filter === 'idle') return status === 'offline' || status === 'standby';
  if (filter === 'setup_needed') return !agent.adapterType || status === 'failed' || agent.status === 'setup_needed';
  return true;
}

function matchesFleetSearch(agent: AgentHierarchyAgent, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return [
    agent.name,
    agent.description,
    agent.runtimeModel,
    harnessLabel(agent.adapterType),
    normalizeRole(agent),
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .some((value) => value.toLowerCase().includes(query));
}

function readinessRank(agent: AgentHierarchyAgent): number {
  const readiness = readinessOf(agent);
  if (readiness === 'running') return 4;
  if (readiness === 'live') return 3;
  if (readiness === 'standby') return 1;
  return 0;
}

function OrchestratorGlyph({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true"><polygon points="8,1 14,4.5 14,11.5 8,15 2,11.5 2,4.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round" /></svg>;
}
function ManagerGlyph({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true"><polygon points="8,1.5 14.5,8 8,14.5 1.5,8" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round" /></svg>;
}
function WorkerGlyph({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>;
}

// Tier-specific border colors — AGENTS-PAGE-REDESIGN.md §1.3.
interface NodeVisualSpec {
  width: number;
  padding: number;
  glyph: number;
  icon: number;
  handle: number;
  gap: number;
  titleSize: number;
  subtitleSize: number;
  activitySize: number;
  showSubtitle: boolean;
  showActivity: boolean;
  showProgress: boolean;
  compactProgress: boolean;
}

function nodeVisualSpec(role: 'orchestrator' | 'manager' | 'worker' | 'unassigned', tierCount: number, isSpecialist = false): NodeVisualSpec {
  // Specialists are deliberately compact (smaller than managers) and sized
  // independent of the global worker count — a manager's small cluster should
  // stay readable even when the workspace has many specialists overall.
  if (isSpecialist) {
    return {
      width: 150,
      padding: 9,
      glyph: 24,
      icon: 12,
      handle: 7,
      gap: 8,
      titleSize: 11,
      subtitleSize: 9.5,
      activitySize: 9.5,
      showSubtitle: true,
      showActivity: false,
      showProgress: false,
      compactProgress: true,
    };
  }
  if (role === 'orchestrator') {
    return {
      width: 268,
      padding: 14,
      glyph: 38,
      icon: 17,
      handle: 10,
      gap: 11,
      titleSize: 14,
      subtitleSize: 10.5,
      activitySize: 11,
      showSubtitle: true,
      showActivity: true,
      showProgress: true,
      compactProgress: false,
    };
  }

  if (role === 'manager') {
    return {
      width: 232,
      padding: 13,
      glyph: 34,
      icon: 16,
      handle: 10,
      gap: 10,
      titleSize: 13,
      subtitleSize: 10.5,
      activitySize: 11,
      showSubtitle: true,
      showActivity: true,
      showProgress: true,
      compactProgress: false,
    };
  }

  if (tierCount > 32) {
    return {
      width: 118,
      padding: 8,
      glyph: 22,
      icon: 12,
      handle: 6,
      gap: 7,
      titleSize: 10.5,
      subtitleSize: 9,
      activitySize: 9,
      showSubtitle: false,
      showActivity: false,
      showProgress: false,
      compactProgress: true,
    };
  }

  if (tierCount > 16) {
    return {
      width: 142,
      padding: 9,
      glyph: 24,
      icon: 12,
      handle: 7,
      gap: 8,
      titleSize: 11,
      subtitleSize: 9.5,
      activitySize: 10,
      showSubtitle: true,
      showActivity: false,
      showProgress: false,
      compactProgress: true,
    };
  }

  if (tierCount > 8) {
    return {
      width: 164,
      padding: 10,
      glyph: 26,
      icon: 13,
      handle: 8,
      gap: 8,
      titleSize: 11.5,
      subtitleSize: 10,
      activitySize: 10,
      showSubtitle: true,
      showActivity: false,
      showProgress: true,
      compactProgress: true,
    };
  }

  return {
    width: role === 'unassigned' ? 170 : 184,
    padding: 10,
    glyph: 28,
    icon: 14,
    handle: 8,
    gap: 9,
    titleSize: 12,
    subtitleSize: 10,
    activitySize: 10.5,
    showSubtitle: true,
    showActivity: true,
    showProgress: true,
    compactProgress: true,
  };
}

function AgentHierarchyNode({ data }: NodeProps<Node<AgentNodeData>>) {
  const agent = data.agent;
  const installSession = useAgentInstallSession(agent.id);

  if (agent.isGhost) {
    return (
      <div className="w-[240px] rounded-lg border border-dashed border-zinc-700 bg-surface px-3 py-3 shadow-card">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-dashed border-zinc-600 bg-zinc-900/70 text-zinc-300">?</span>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-text-primary">{agent.name}</div>
              {agent.ghostDescription ? <div className="mt-0.5 text-[11px] text-text-muted">{agent.ghostDescription}</div> : null}
            </div>
          </div>
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); data.onGhostCreate?.(agent.createPreset ?? undefined); }}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-line bg-surface-2 text-text-secondary transition-colors hover:bg-surface-3 hover:text-text-primary"
            aria-label="Set up the workspace orchestrator"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>
    );
  }

  const role = normalizeRole(agent);
  const installComplete = installSession?.phase === 'complete';
  const installFailed = installSession?.phase === 'error';
  const installActive = installSession?.phase === 'installing' || installSession?.phase === 'verifying';
  const staleSetup = agent.status === 'setting_up' && !installSession;
  const isSettingUp = installActive;
  const readiness = installComplete ? 'live' : installFailed || staleSetup ? 'failed' : isSettingUp ? 'setting_up' : readinessOf(agent);
  const GlyphIcon = role === 'orchestrator' ? OrchestratorGlyph : role === 'manager' ? ManagerGlyph : WorkerGlyph;
  const visual = nodeVisualSpec(role, data.tierCount ?? 1, data.isSpecialist === true);
  const activity = isSettingUp ? installActivity(installSession) : liveActivity(agent, readiness);
  const running = readiness === 'running';
  const settingUp = readiness === 'setting_up';
  // For a specialist the badge is its Subdomain (its area of responsibility).
  const domainName = agent.subdomainName ?? agent.spaceName ?? agent.spaceTag ?? null;
  const domainColor = agent.spaceColorHex ?? null;
  // Node color: a manager wears the color of the domain it owns (neutral when the
  // domain has none); the orchestrator wears a personal colorHex if set via the
  // detail panel's color picker, else falls back to its blue identity color;
  // specialists stay neutral. See the /home canvas for the same rule.
  const neutralColor = 'var(--color-line-strong)';
  const nodeColor = settingUp
    ? '#06b6d4'
    : role === 'orchestrator'
      ? agent.colorHex ?? '#3b82f6'
      : role === 'manager'
        ? domainColor ?? neutralColor
        : neutralColor;
  const subtitle = settingUp 
    ? 'setting up runtime' 
    : role === 'worker' 
        ? harnessLabel(agent.adapterType) 
        : `${role} - ${harnessLabel(agent.adapterType)}`;

  return (
    <div
      role="article"
      aria-label={`${agent.name} — ${readiness}`}
      className={clsx(
        'relative rounded-lg border-2 bg-surface shadow-card transition-colors',
        running && 'ring-1 ring-warn/20',
        settingUp && 'ring-1 ring-cyan-500/20',
      )}
      style={{
        width: visual.width,
        padding: visual.padding,
        borderColor: nodeColor,
        boxShadow: settingUp ? '0 0 16px rgba(6, 182, 212, 0.08)' : running ? `0 0 12px color-mix(in srgb, ${nodeColor} 22%, transparent)` : undefined,
      }}
    >
      <Handle type="target" position={Position.Top} className="!border-line !bg-surface" style={{ width: visual.handle, height: visual.handle }} />
      <div className="flex items-center" style={{ gap: visual.gap }}>
        <span
          className={clsx(
            'flex shrink-0 items-center justify-center rounded-md bg-canvas overflow-hidden',
            settingUp && 'animate-pulse',
          )}
          style={{ width: visual.glyph, height: visual.glyph, color: nodeColor }}
        >
          {settingUp
            ? <Loader2 size={visual.icon} className="animate-spin" />
            : agent.avatarUrl
              ? <img src={agent.avatarUrl} alt={agent.name} className="h-full w-full object-cover" />
              : (agent.avatarGlyph || <GlyphIcon size={visual.icon} />)
          }
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-text-primary" style={{ fontSize: visual.titleSize }}>{agent.name}</div>
          {visual.showSubtitle && (
            <div className="mt-1 truncate capitalize text-text-muted" style={{ fontSize: visual.subtitleSize }}>
              {subtitle}
            </div>
          )}
          {domainName && role !== 'orchestrator' && (
            <div
              className="mt-1.5 inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-canvas/55 px-1.5 py-0.5 text-[9.5px] font-medium text-text-secondary"
              style={domainColor ? { borderColor: `${domainColor}55`, color: domainColor } : undefined}
            >
              {domainColor && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: domainColor }} />}
              <span className="truncate">{domainName}</span>
            </div>
          )}
        </div>
        <StatusDot readiness={readiness} />
      </div>
      {settingUp && installSession && visual.showProgress ? (
        <SetupProgressBar session={installSession} compact={visual.compactProgress} />
      ) : visual.showActivity ? (
        <div className="mt-3 border-t border-line pt-2.5">
          <div className={clsx('truncate', activity.tone)} style={{ fontSize: visual.activitySize }} aria-live="polite">
            {activity.text}
          </div>
        </div>
      ) : (
        null
      )}
      <Handle type="source" position={Position.Bottom} className="!border-line !bg-surface" style={{ width: visual.handle, height: visual.handle }} />
    </div>
  );
}

/** Inline install progress bar shown on the fleet card during setup. */
function SetupProgressBar({ session, compact = false }: { session: InstallSession; compact?: boolean }) {
  const totalSteps = 4;
  const completedSteps = session.steps.filter((s) => s.status === 'done').length;
  const currentStep = session.steps.find((s) => s.status === 'running');
  const progress = Math.min(100, Math.round((completedSteps / totalSteps) * 100));
  const hasError = session.phase === 'error';

  return (
    <div className={clsx('border-t border-line space-y-1.5', compact ? 'mt-2 pt-2' : 'mt-3 pt-2.5')}>
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
          <div
            className={clsx(
              'h-full rounded-full transition-all duration-500',
              hasError ? 'bg-danger' : 'bg-cyan-500',
            )}
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="text-[10px] tabular-nums text-text-muted">{progress}%</span>
      </div>
      <div className={clsx('truncate', compact ? 'text-[10px]' : 'text-[11px]', hasError ? 'text-danger' : 'text-cyan-400')}>
        {hasError
          ? (session.error ?? 'Install failed')
          : currentStep
            ? currentStep.label
            : session.phase === 'complete'
              ? 'Ready!'
              : 'Starting install…'}
      </div>
    </div>
  );
}

/** Live activity text for an agent that is currently being set up. */
function installActivity(session: InstallSession | undefined): { text: string; tone: string } {
  if (!session) return { text: 'setting up…', tone: 'text-cyan-400' };
  if (session.phase === 'error') return { text: session.error ?? 'install failed', tone: 'text-danger' };
  if (session.phase === 'complete') return { text: 'runtime installed — going live', tone: 'text-accent' };
  const step = session.steps.find((s) => s.status === 'running');
  return { text: step?.label ?? 'installing runtime…', tone: 'text-cyan-400' };
}

function StatusDot({ readiness }: { readiness: string }) {
  if (readiness === 'running') {
    return (
      <span className="relative flex h-2.5 w-2.5 shrink-0" aria-label="running">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warn opacity-60" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-warn" />
      </span>
    );
  }
  if (readiness === 'setting_up') {
    return (
      <span className="relative flex h-2.5 w-2.5 shrink-0" aria-label="setting up">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-500 opacity-50" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-cyan-500" />
      </span>
    );
  }
  return <span className={clsx('h-2.5 w-2.5 shrink-0 rounded-full', readinessDot(readiness))} aria-label={readiness} />;
}

/** Single-sentence live activity line — AGENTS-PAGE-REDESIGN.md §1.3. */
function liveActivity(
  agent: AgentHierarchyAgent,
  readiness: string,
): { text: string; tone: string } {
  if (readiness === 'setting_up') {
    return { text: 'installing runtime…', tone: 'text-cyan-400' };
  }
  if (!agent.adapterType) {
    return { text: 'setup needed · connect harness', tone: 'text-warn' };
  }
  if (readiness === 'failed') {
    if (agent.status === 'setting_up') {
      return { text: 'setup needed - runtime missing', tone: 'text-danger' };
    }
    return { text: 'failed — needs review', tone: 'text-danger' };
  }
  if (readiness === 'running') {
    const task = (agent.currentTask ?? '').trim();
    return { text: task ? `running: ${truncate(task, 34)}` : 'running…', tone: 'text-warn' };
  }
  if (readiness === 'live') {
    const tags = (agent.capabilityTags ?? []).filter(Boolean).slice(0, 2);
    return { text: tags.length > 0 ? `ready — ${tags.join(', ')}` : 'ready for work', tone: 'text-success' };
  }
  const last = agent.lastActiveAt ?? agent.lastHeartbeatAt;
  return { text: last ? `idle — last active ${relativeTime(last)}` : 'idle', tone: 'text-text-muted' };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function fallbackPosition(
  tier: 'orchestrator' | 'manager' | 'worker' | 'unassigned',
  index: number,
  count: number,
  managerSpacing = 300,
) {
  if (tier === 'orchestrator') return { x: 0, y: TIER_Y.orchestrator };

  if (tier === 'manager') {
    const columns = count > 6 ? 6 : count;
    const row = Math.floor(index / columns);
    const col = index % columns;
    const columnsInRow = Math.min(columns, count - row * columns);
    return { x: (col - (columnsInRow - 1) / 2) * managerSpacing, y: TIER_Y.manager + row * 150 };
  }

  const layout = compactTierLayout(count);
  const row = Math.floor(index / layout.columns);
  const col = index % layout.columns;
  const columnsInRow = Math.min(layout.columns, count - row * layout.columns);
  return {
    x: (col - (columnsInRow - 1) / 2) * layout.spacingX,
    y: TIER_Y[tier] + row * layout.spacingY,
  };
}

/** Group specialists by subdomain (so same-subdomain peers sit together), then name. */
function bySubdomainThenName(a: AgentHierarchyAgent, b: AgentHierarchyAgent): number {
  const sa = (a.subdomainName ?? a.spaceTag ?? '').toLowerCase();
  const sb = (b.subdomainName ?? b.spaceTag ?? '').toLowerCase();
  if (sa !== sb) return sa.localeCompare(sb);
  return a.name.localeCompare(b.name);
}

/** Compact grid of specialist nodes centered under their manager's column. */
function specialistFallbackUnderManager(managerX: number, index: number, count: number) {
  const perRow = Math.min(count, count > 6 ? 4 : 3);
  const row = Math.floor(index / perRow);
  const col = index % perRow;
  const colsInRow = Math.min(perRow, count - row * perRow);
  const spacingX = 158;
  const spacingY = 104;
  return {
    x: managerX + (col - (colsInRow - 1) / 2) * spacingX,
    y: TIER_Y.worker + row * spacingY,
  };
}

function compactTierLayout(count: number) {
  if (count > 32) return { columns: 12, spacingX: 128, spacingY: 84 };
  if (count > 16) return { columns: 10, spacingX: 154, spacingY: 96 };
  if (count > 8) return { columns: 8, spacingX: 184, spacingY: 108 };
  return { columns: Math.max(1, count), spacingX: 220, spacingY: 132 };
}

function safeCanvasPosition(
  tier: 'orchestrator' | 'manager' | 'worker' | 'unassigned',
  value: unknown,
  fallback: { x: number; y: number },
) {
  if (!isPosition(value)) return fallback;
  if (tier === 'orchestrator' && value.y < 96) return fallback;
  if (value.y < -120 || value.y > 1800 || Math.abs(value.x) > 3000) return fallback;
  return value;
}

function requestFleetFit(instance: ReactFlowInstance<Node<AgentNodeData>, Edge> | null) {
  if (!instance) return;
  window.requestAnimationFrame(() => {
    instance.fitView({ padding: { top: 0.3, right: 0.1, bottom: 0.1, left: 0.1 }, minZoom: 0.1, maxZoom: 1, duration: 180 });
  });
}

function isPosition(value: unknown): value is { x: number; y: number } {
  return Boolean(value && typeof value === 'object' && typeof (value as { x?: unknown }).x === 'number' && typeof (value as { y?: unknown }).y === 'number');
}

function managerLaneSpacing(specialistCountByManager: Map<string, number>): number {
  let widestCluster = 0;
  for (const count of specialistCountByManager.values()) {
    const perRow = Math.min(count, count > 6 ? 4 : 3);
    widestCluster = Math.max(widestCluster, Math.max(0, perRow - 1) * 158 + 150);
  }
  return Math.max(300, widestCluster + 32);
}

/** Legacy rows can contain null, NaN, or coordinates outside a usable canvas. */
function isPersistedCanvasPosition(value: unknown): value is { x: number; y: number } {
  return isPosition(value)
    && Number.isFinite(value.x)
    && Number.isFinite(value.y)
    && value.y >= -120
    && value.y <= 1800
    && Math.abs(value.x) <= 3000;
}

function normalizeRole(agent: AgentHierarchyAgent): 'orchestrator' | 'manager' | 'worker' | 'unassigned' {
  if (agent.role === 'orchestrator' || agent.role === 'manager' || agent.role === 'worker') return agent.role;
  return agent.reportsTo ? 'worker' : 'unassigned';
}

function readinessOf(agent: AgentHierarchyAgent) {
  if (agent.status === 'setting_up') return 'failed';
  if (agent.isPaused || agent.status === 'paused') return 'standby';
  if (agent.status === 'error') return 'failed';
  if (agent.status === 'busy' || agent.currentTaskId) return 'running';
  if (agent.status === 'online') return 'live';
  if (agent.lastHeartbeatAt && Date.now() - new Date(agent.lastHeartbeatAt).getTime() < 120_000) return 'live';
  return 'offline';
}

function readinessDot(readiness: string) {
  if (readiness === 'live') return 'bg-success';
  if (readiness === 'running') return 'bg-warn';
  if (readiness === 'setting_up') return 'bg-cyan-500';
  if (readiness === 'failed') return 'bg-danger';
  if (readiness === 'standby') return 'bg-text-muted';
  return 'bg-line';
}

function harnessLabel(adapterType?: string | null) {
  switch (adapterType) {
    case 'openclaw': return 'OpenClaw';
    case 'hermes_agent': return 'Hermes';
    case 'claude_code': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'cursor': return 'Cursor';
    case 'antigravity': return 'Antigravity CLI';
    case 'http': return 'HTTP';
    default: return 'runtime';
  }
}

function labelize(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}



