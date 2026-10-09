import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  Crosshair,
  Minimize2,
  Play,
  RadioTower,
  RefreshCw,
  ShieldCheck,
  Square,
  History,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { REALTIME_EVENTS } from '@agentis/core';
import { api } from '../../lib/api';
import { rtSubscribe, useRealtime, type RealtimeEnvelope } from '../../lib/realtime';
import {
  REALTIME_ACTIVITY_EVENTS,
  describeRealtimeActivity,
  type RealtimeActivity,
  type RealtimeActivityTone,
} from '../../lib/realtimeActivity';
import {
  refreshWorkspaceSnapshot,
  useWorkspaceData,
  type WorkspaceApproval,
  type WorkspaceSelfHealIncident,
} from '../../lib/workspaceData';
import { SelfHealConsole } from './SelfHealConsole';
import { ApprovalPreviewCard, ApprovalReviewModal } from '../shared/ApprovalReviewModal';
import { formatDuration, type WorkflowRunSummary } from '../workflows/runFormat';
import { RunVerdictBanner } from '../workflows/RunVerdictBanner';

type MonitorMode = 'minimized' | 'expanded';
type MonitorStatus = 'idle' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed';
type OperationsTab = 'activity' | 'health' | 'analytics';

// Show a fuller live trace by default — following an agent's reasoning needs more
// than a 4-line peephole (the "Show earlier" toggle still reveals the rest).
const DEFAULT_VISIBLE_EVENTS = 12;
const DEFAULT_WIDTH = 372;
const MIN_WIDTH = 300;
const MAX_WIDTH = 560;
const ACTIVE_SELF_HEAL_STATUSES = new Set(['DIAGNOSING', 'PLANNING', 'APPLYING', 'RETRYING']);
const TERMINAL_SELF_HEAL_STATUSES = new Set(['APPLIED', 'BLOCKED', 'EXHAUSTED', 'ROLLED_BACK']);

interface HealthIssue {
  code: string;
  severity: 'error' | 'warning';
  nodeId?: string;
  nodeTitle?: string;
  message: string;
  remediation?: string;
}

interface HealthReport {
  status: 'healthy' | 'unverified' | 'blocked';
  durationMs: number;
  nodes: Record<string, { status: 'passed' | 'mocked' | 'unverified' | 'failed' }>;
  issues: HealthIssue[];
}

interface WorkflowAnalytics {
  runs: number;
  successRate: number | null;
  avgDurationMs: number | null;
  avgCostCents: number;
  totalCostCents: number;
  /** Whether real $ cost was recorded (false for subscription CLI runtimes). */
  metered: boolean;
  totalTokensIn: number;
  totalTokensOut: number;
  totalTokens: number;
  avgTokensPerRun: number;
  byStatus: Record<string, number>;
  nodeFailures: Array<{ nodeId: string; title: string; failures: number; sampleError: string }>;
  perAgent?: Array<{ agentId: string | null; name: string; tokensIn: number; tokensOut: number; totalTokens: number }>;
}

export function WorkflowMonitorCard({
  workflowId,
  workflowTitle,
  activeRunId,
  activeRunStatus,
  nodeTitles,
  revision,
  onFocusNode,
  onOpenRun,
  onRunStarted,
  onOpenHistory,
}: {
  workflowId: string;
  workflowTitle: string;
  activeRunId: string | null;
  activeRunStatus?: WorkflowRunSummary['status'] | null;
  nodeTitles: Map<string, string>;
  revision: string;
  onFocusNode: (nodeId: string) => void;
  onOpenRun: (runId?: string) => void;
  onRunStarted: (runId: string) => void;
  onOpenHistory: () => void;
}) {
  const { workspaceId, approvals, activeRuns, failedRuns } = useWorkspaceData();
  const [mode, setMode] = useState<MonitorMode>(() => (activeRunId ? 'expanded' : 'minimized'));
  const [tab, setTab] = useState<OperationsTab>('activity');
  const [feed, setFeed] = useState<RealtimeActivity[]>([]);
  const [status, setStatus] = useState<MonitorStatus>(() => monitorStatusFromRun(activeRunStatus, activeRunId));
  const [trackedRunId, setTrackedRunId] = useState<string | null>(activeRunId);
  const [terminalKind, setTerminalKind] = useState<'run' | 'build' | null>(null);
  const [showEarlier, setShowEarlier] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [selectedApproval, setSelectedApproval] = useState<WorkspaceApproval | null>(null);
  const [stopping, setStopping] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [healthChecking, setHealthChecking] = useState(true);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<WorkflowAnalytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [clock, setClock] = useState(() => Date.now());
  const previousRunId = useRef<string | null>(activeRunId);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    handle: HTMLElement;
  } | null>(null);
  const resizeRef = useRef<{
    pointerId: number;
    startX: number;
    originWidth: number;
    handle: HTMLElement;
  } | null>(null);
  const monitorRunId = activeRunId ?? trackedRunId;

  useEffect(() => {
    if (status !== 'running' && status !== 'waiting') return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [status]);

  const workflowApprovals = useMemo(
    () => {
      const runId = monitorRunId;
      return runId ? approvals.filter((approval) => approval.runId === runId) : [];
    },
    [approvals, monitorRunId],
  );
  const topApproval = workflowApprovals[0] ?? null;

  const loadHealth = useCallback(async () => {
    setHealthChecking(true);
    setHealthError(null);
    try {
      setHealth(await api<HealthReport>(`/v1/workflows/${workflowId}/preflight`, {
        method: 'POST',
        body: JSON.stringify({}),
      }));
    } catch {
      setHealth(null);
      setHealthError('Could not check this workflow right now.');
    } finally {
      setHealthChecking(false);
    }
  }, [workflowId]);

  const loadAnalytics = useCallback(async (force = false) => {
    if (analyticsLoading || (!force && analytics)) return;
    setAnalyticsLoading(true);
    setAnalyticsError(null);
    try {
      setAnalytics(await api<WorkflowAnalytics>(`/v1/workflows/${workflowId}/analytics`));
    } catch {
      setAnalytics(null);
      setAnalyticsError('Could not load run analytics right now.');
    } finally {
      setAnalyticsLoading(false);
    }
  }, [analytics, analyticsLoading, workflowId]);

  useEffect(() => {
    if (!activeRunId) {
      if (previousRunId.current === null) return;
      previousRunId.current = null;
      // The canvas clears its live-run ID the instant a run terminates. Keep the
      // monitor latched to that exact run so completion does not fall back to an
      // unrelated earlier failure in workspace history.
      return;
    }
    if (activeRunId === previousRunId.current) return;
    previousRunId.current = activeRunId;
    setTrackedRunId(activeRunId);
    setFeed([]);
    setStatus(monitorStatusFromRun(activeRunStatus, activeRunId));
    setTerminalKind(null);
    setMode('expanded');
    setTab('activity');
    setShowEarlier(false);
    setAnalytics(null);
    setAnalyticsError(null);
  }, [activeRunId, activeRunStatus]);

  useEffect(() => {
    // The canvas intentionally clears activeRunId when a run pauses or
    // terminates. Keep the monitor's status latched to the tracked run until a
    // different active run arrives; realtime/history owns that status now.
    if (!activeRunId && trackedRunId) return;
    let next = monitorStatusFromRun(activeRunStatus, activeRunId);
    if (topApproval) {
      if (next === 'running') next = 'waiting';
    } else {
      if (next === 'waiting' && activeRunId) next = 'running';
    }

    setStatus((current) => {
      // If we are in a terminal state for the current run, don't revert to running/waiting
      if ((current === 'completed' || current === 'failed') && activeRunId === previousRunId.current) {
        return current;
      }
      return next;
    });
  }, [activeRunId, activeRunStatus, topApproval, trackedRunId]);

  useEffect(() => {
    let cancelled = false;
    setHealthChecking(true);
    setHealth(null);
    setHealthError(null);
    const timer = window.setTimeout(() => {
      if (!cancelled) void loadHealth();
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [loadHealth, revision]);

  useEffect(
    () => () => {
      stopDrag();
      stopResize();
    },
    [],
  );

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    if (workspaceId) unsubs.push(rtSubscribe('workspace', { workspaceId }));
    if (monitorRunId) unsubs.push(rtSubscribe('run', { runId: monitorRunId }));
    else unsubs.push(rtSubscribe('workflow', { workflowId }));
    return () => unsubs.forEach((fn) => fn());
  }, [monitorRunId, workflowId, workspaceId]);

  useRealtime([...REALTIME_ACTIVITY_EVENTS], (env) => {
    const activity = describeRealtimeActivity(env, {
      nodeTitle: (nodeId) => nodeTitles.get(nodeId),
    });
    if (!activity || !matchesWorkflowActivity(activity, workflowId, monitorRunId)) return;
    upsertActivity(setFeed, activity);
    updateMonitorStatus(env, setStatus, setTerminalKind);
    if (activity.runId) setTrackedRunId(activity.runId);
    // On terminal events refresh the cumulative workflow analytics.
    if (env.event === REALTIME_EVENTS.RUN_COMPLETED || env.event === REALTIME_EVENTS.RUN_FAILED) {
      void loadAnalytics(true);
    }
  });

  useEffect(() => {
    void loadAnalytics(false);
  }, [loadAnalytics]);

  useEffect(() => {
    if (!monitorRunId) return;
    let cancelled = false;
    void api<{ activity: Array<{ event: string; payload: Record<string, unknown>; emittedAt: string }> }>(
      `/v1/runs/${monitorRunId}/activity`,
    )
      .then((res) => {
        if (cancelled) return;
        const historical = (res.activity ?? [])
          .map((env) => {
            updateMonitorStatus({ event: env.event, payload: env.payload }, setStatus, setTerminalKind);
            return describeRealtimeActivity(
              { event: env.event, payload: env.payload, emittedAt: env.emittedAt },
              { nodeTitle: (nodeId) => nodeTitles.get(nodeId) },
            );
          })
          .filter((activity): activity is RealtimeActivity => (
            Boolean(activity) && matchesWorkflowActivity(activity!, workflowId, monitorRunId)
          ));
        setFeed(dedupeActivities(historical).reverse());
      })
      .catch(() => {  });
    return () => { cancelled = true; };
  }, [monitorRunId, nodeTitles, workflowId]);


  const selfHealIncident = useMemo(
    () => {
      const runId = monitorRunId;
      if (!runId) return null;
      const candidates = [...activeRuns, ...failedRuns].filter((run) => run.id === runId);
      return candidates
        .map((run) => run.selfHealIncident ?? null)
        .filter((incident): incident is WorkspaceSelfHealIncident => Boolean(incident))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] ?? null;
    },
    [activeRuns, failedRuns, monitorRunId],
  );
  const visibleSelfHealIncident = useMemo(() => {
    if (!selfHealIncident) return null;
    if (TERMINAL_SELF_HEAL_STATUSES.has(selfHealIncident.status)) return selfHealIncident;
    if (ACTIVE_SELF_HEAL_STATUSES.has(selfHealIncident.status)) {
      const runStillActive = status === 'running' || status === 'waiting' || status === 'paused';
      return runStillActive && activeRunId && monitorRunId === activeRunId ? selfHealIncident : null;
    }
    return selfHealIncident;
  }, [activeRunId, monitorRunId, selfHealIncident, status]);
  const currentFailedRun = useMemo(
    () => monitorRunId ? failedRuns.find((run) => run.id === monitorRunId) ?? null : null,
    [failedRuns, monitorRunId],
  );

  // Consolidated status updates in the first useEffect to prevent conflicting triggers.

  const displayFeed = (status === 'completed' || status === 'failed'
    ? feed.filter((item) => item.kind !== 'run')
    : feed
  ).filter((item) => !isRuntimeDiagnostic(item)).filter((item) => !(
    terminalKind === 'build'
    && item.kind === 'agent'
    && /workflow ready|response ready|finished this turn/i.test(item.detail)
  ));
  const visibleFeed = showEarlier ? displayFeed : displayFeed.slice(0, DEFAULT_VISIBLE_EVENTS);
  const hiddenCount = Math.max(0, displayFeed.length - visibleFeed.length);
  const tone: RealtimeActivityTone = status === 'failed'
    ? 'danger'
    : status === 'completed'
      ? 'success'
      : status === 'paused'
        ? 'warn'
      : status === 'waiting'
        ? 'warn'
        : status === 'running'
          ? 'accent'
          : 'muted';

  async function resolveSelfHeal(approvalId: string, decision: 'approve' | 'reject') {
    setResolving(true);
    try {
      await api(`/v1/approvals/${approvalId}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      await refreshWorkspaceSnapshot();
    } finally {
      setResolving(false);
    }
  }

  async function reportSelfHeal(incident: WorkspaceSelfHealIncident) {
    setResolving(true);
    try {
      await api('/v1/issues', {
        method: 'POST',
        body: JSON.stringify({
          title: `Self-healing blocked: ${incident.nodeTitle ?? workflowTitle}`,
          description: [
            `Workflow: ${workflowTitle}`,
            incident.nodeTitle ? `Step: ${incident.nodeTitle}` : null,
            incident.diagnosis ? `Diagnosis: ${incident.diagnosis}` : null,
            incident.reason ? `Reason: ${incident.reason}` : null,
            incident.error ? `Error: ${incident.error}` : null,
            `Attempts: ${incident.attempt}/${incident.maxAttempts}`,
          ].filter(Boolean).join('\n'),
          priority: 'high',
          labels: ['self-heal'],
        }),
      });
      await refreshWorkspaceSnapshot();
    } catch (err) {
      console.warn('[agentis] failed to file self-heal issue', err);
    } finally {
      setResolving(false);
    }
  }

  async function rollbackSelfHeal(checkpointId: string) {
    const runId = monitorRunId;
    if (!runId) return;
    setResolving(true);
    try {
      await api(`/v1/runs/${runId}/self-heal/checkpoints/${checkpointId}/rollback`, { method: 'POST' });
      await refreshWorkspaceSnapshot();
      onOpenRun(runId);
    } catch (err) {
      console.warn('[agentis] failed to roll back self-healing repair', err);
    } finally {
      setResolving(false);
    }
  }

  async function pauseRun() {
    if (!activeRunId || stopping) return;
    setStopping(true);
    try {
      await api(`/v1/runs/${activeRunId}/pause`, { method: 'POST' });
      await refreshWorkspaceSnapshot();
    } catch (err) {
      console.warn('[agentis] failed to stop run from monitor', err);
    } finally {
      setStopping(false);
    }
  }

  async function resumeRun() {
    if (!activeRunId || resuming) return;
    setResuming(true);
    try {
      await api(`/v1/runs/${activeRunId}/resume`, { method: 'POST', body: JSON.stringify({}) });
      await refreshWorkspaceSnapshot();
    } catch (err) {
      console.warn('[agentis] failed to resume run from monitor', err);
    } finally {
      setResuming(false);
    }
  }

  async function cancelRun() {
    if (!activeRunId || cancelling) return;
    setCancelling(true);
    try {
      await api(`/v1/runs/${activeRunId}/cancel`, { method: 'POST' });
      await refreshWorkspaceSnapshot();
    } catch (err) {
      console.warn('[agentis] failed to cancel run from monitor', err);
    } finally {
      setCancelling(false);
    }
  }

  async function retryFailedRun(fromNode: boolean) {
    if (!currentFailedRun) return;
    try {
      if (fromNode && currentFailedRun.failedNodeId) {
        const result = await api<{ runId: string }>(`/v1/runs/${currentFailedRun.id}/replay`, {
          method: 'POST',
          body: JSON.stringify({ mode: 'replay-from-node', targetNodeId: currentFailedRun.failedNodeId }),
        });
        onRunStarted(result.runId);
      } else if (fromNode) {
        const result = await api<{ runId: string }>(`/v1/runs/${currentFailedRun.id}/replay`, {
          method: 'POST',
          body: JSON.stringify({ mode: 'replay-failed-branch' }),
        });
        onRunStarted(result.runId);
      } else {
        await api(`/v1/runs/${currentFailedRun.id}/retry`, { method: 'POST' });
      }
      await refreshWorkspaceSnapshot();
      onOpenRun(currentFailedRun.id);
    } catch (err) {
      console.warn('[agentis] failed to retry run from monitor', err);
    }
  }

  function stopDrag(pointerId?: number) {
    const drag = dragRef.current;
    if (!drag) return;
    window.removeEventListener('pointermove', handleWindowDragMove);
    window.removeEventListener('pointerup', handleWindowDragUp);
    window.removeEventListener('pointercancel', handleWindowDragCancel);
    window.removeEventListener('blur', handleWindowDragBlur);
    if (pointerId != null) {
      try { drag.handle.releasePointerCapture(pointerId); } catch { /* already released */ }
    }
    dragRef.current = null;
  }

  function stopResize(pointerId?: number) {
    const resize = resizeRef.current;
    if (!resize) return;
    window.removeEventListener('pointermove', handleWindowResizeMove);
    window.removeEventListener('pointerup', handleWindowResizeUp);
    window.removeEventListener('pointercancel', handleWindowResizeCancel);
    window.removeEventListener('blur', handleWindowResizeBlur);
    if (pointerId != null) {
      try { resize.handle.releasePointerCapture(pointerId); } catch { /* already released */ }
    }
    resizeRef.current = null;
  }

  function handleWindowDragMove(event: PointerEvent) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    setOffset({
      x: drag.originX + (event.clientX - drag.startX),
      y: drag.originY + (event.clientY - drag.startY),
    });
  }

  function handleWindowDragUp(event: PointerEvent) {
    stopDrag(event.pointerId);
  }

  function handleWindowDragCancel(event: PointerEvent) {
    stopDrag(event.pointerId);
  }

  function handleWindowDragBlur() {
    const drag = dragRef.current;
    if (drag) stopDrag(drag.pointerId);
  }

  function handleWindowResizeMove(event: PointerEvent) {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    event.preventDefault();
    setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, resize.originWidth + event.clientX - resize.startX)));
  }

  function handleWindowResizeUp(event: PointerEvent) {
    stopResize(event.pointerId);
  }

  function handleWindowResizeCancel(event: PointerEvent) {
    stopResize(event.pointerId);
  }

  function handleWindowResizeBlur() {
    const resize = resizeRef.current;
    if (resize) stopResize(resize.pointerId);
  }

  function handleHeaderPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button, a, input, select, textarea')) return;
    event.preventDefault();
    const handle = event.currentTarget;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
      handle,
    };
    window.addEventListener('pointermove', handleWindowDragMove, { passive: false });
    window.addEventListener('pointerup', handleWindowDragUp);
    window.addEventListener('pointercancel', handleWindowDragCancel);
    window.addEventListener('blur', handleWindowDragBlur);
    try { handle.setPointerCapture(event.pointerId); } catch { /* unavailable */ }
  }

  function handleResizePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      originWidth: width,
      handle,
    };
    window.addEventListener('pointermove', handleWindowResizeMove, { passive: false });
    window.addEventListener('pointerup', handleWindowResizeUp);
    window.addEventListener('pointercancel', handleWindowResizeCancel);
    window.addEventListener('blur', handleWindowResizeBlur);
    try { handle.setPointerCapture(event.pointerId); } catch { /* unavailable */ }
  }

  const headerLabel = statusLabel(status, workflowTitle, terminalKind);
  const canPauseRun = (status === 'running' || status === 'waiting')
    && Boolean(activeRunId)
    && terminalKind !== 'build';
  const canResumeRun = status === 'paused' && Boolean(activeRunId) && terminalKind !== 'build';
  const canCancelRun = (status === 'running' || status === 'waiting' || status === 'paused')
    && Boolean(activeRunId)
    && terminalKind !== 'build';
  return (
    <section
      data-canvas-control
      data-testid="workflow-realtime-monitor"
      className={clsx(
        'pointer-events-auto relative overflow-hidden rounded-xl border border-white/10 bg-canvas/90 text-text-primary',
        'shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_18px_45px_rgba(0,0,0,0.32)] backdrop-blur-xl',
        mode === 'minimized' && 'w-auto',
      )}
      style={{
        width: mode === 'expanded' ? width : undefined,
        transform: `translate(${offset.x}px, ${offset.y}px)`,
      }}
      aria-label="Workflow realtime monitor"
    >
      <header
        className={clsx(
          'flex min-h-10 cursor-grab items-center gap-2 px-3 py-2 active:cursor-grabbing',
          mode === 'expanded' && 'border-b border-white/10',
        )}
        onPointerDown={handleHeaderPointerDown}
      >
        <StatusIcon status={status} tone={tone} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-text-primary">
            {mode === 'expanded' ? 'Workflow operations' : headerLabel}
          </div>
          {mode === 'expanded' && (
            <div className="truncate text-[10px] leading-3 text-text-muted">{headerLabel}</div>
          )}
        </div>
        {mode === 'expanded' && (
          <button
            type="button"
            onClick={onOpenHistory}
            className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[10.5px] font-medium text-text-muted transition hover:bg-surface-2 hover:text-text-primary active:scale-95"
            title="Run history"
          >
            <History size={11} /> History
          </button>
        )}
        {canResumeRun && activeRunId && (
          <button
            type="button"
            onClick={() => void resumeRun()}
            disabled={resuming}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-text-muted transition hover:bg-accent-soft hover:text-accent active:scale-95 disabled:opacity-50"
            aria-label="Resume run"
            title="Resume run"
          >
            <Play size={11} />
          </button>
        )}
        {canPauseRun && activeRunId && (
          <button
            type="button"
            onClick={() => void pauseRun()}
            disabled={stopping}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-text-muted transition hover:bg-danger-soft hover:text-danger active:scale-95 disabled:opacity-50"
            aria-label="Pause run"
            title="Pause run"
          >
            <Square size={11} />
          </button>
        )}
        {canCancelRun && activeRunId && (
          <button
            type="button"
            onClick={() => void cancelRun()}
            disabled={cancelling}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-danger transition hover:bg-danger-soft active:scale-95 disabled:opacity-50"
            aria-label="Cancel run permanently"
            title="Cancel run permanently"
          >
            <X size={12} />
          </button>
        )}
        {monitorRunId && terminalKind !== 'build' && (
          <button
            type="button"
            onClick={() => onOpenRun(monitorRunId)}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-text-muted transition hover:bg-surface-2 hover:text-text-primary active:scale-95"
            aria-label="Inspect run"
            title="Inspect run"
          >
            <History size={12} />
          </button>
        )}
        <button
          type="button"
          onClick={() => setMode((current) => current === 'expanded' ? 'minimized' : 'expanded')}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-text-muted transition hover:bg-surface-2 hover:text-text-primary active:scale-95"
          aria-label={mode === 'expanded' ? 'Minimize monitor' : 'Expand monitor'}
        >
          {mode === 'expanded' ? <Minimize2 size={12} /> : <ChevronDown size={12} />}
        </button>
      </header>

      {mode === 'expanded' && (
        <div className="max-h-[min(440px,calc(100vh-190px))] overflow-y-auto px-3 py-2.5">
          {/* SWIFT layer 3: the world-verified outcome ? completion is not accomplishment. */}
          {monitorRunId && (status === 'completed' || status === 'failed') && (
            <RunVerdictBanner runId={monitorRunId} refreshKey={status} />
          )}
          {(canResumeRun || canPauseRun || canCancelRun || (monitorRunId && terminalKind !== 'build')) && (
            <div className="mb-2 flex items-center gap-2 rounded-lg border border-white/10 bg-surface/55 p-2">
              <span className="min-w-0 flex-1 text-[10.5px] font-medium text-text-muted">Run controls</span>
              {canResumeRun && activeRunId && (
                <button
                  type="button"
                  onClick={() => void resumeRun()}
                  disabled={resuming}
                  className="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-[11px] font-medium text-canvas transition hover:bg-accent-hover disabled:opacity-50"
                >
                  <Play size={11} /> Resume
                </button>
              )}
              {canPauseRun && activeRunId && (
                <button
                  type="button"
                  onClick={() => void pauseRun()}
                  disabled={stopping}
                  className="inline-flex h-7 items-center gap-1 rounded-md bg-danger-soft px-2.5 text-[11px] font-medium text-danger transition hover:bg-danger/20 disabled:opacity-50"
                >
                  <Square size={11} /> Pause
                </button>
              )}
              {canCancelRun && activeRunId && (
                <button
                  type="button"
                  onClick={() => void cancelRun()}
                  disabled={cancelling}
                  className="inline-flex h-7 items-center gap-1 rounded-md bg-danger px-2.5 text-[11px] font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
                >
                  <X size={11} /> Cancel
                </button>
              )}
              {monitorRunId && (
                <button
                  type="button"
                  onClick={() => onOpenRun(monitorRunId)}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-line px-2.5 text-[11px] font-medium text-text-secondary transition hover:bg-surface-2 hover:text-text-primary"
                >
                  <History size={11} /> Inspect
                </button>
              )}
            </div>
          )}
          <div className="mb-2 flex items-center gap-1 rounded-lg border border-white/10 bg-surface/55 p-1">
            {(['activity', 'health', 'analytics'] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => {
                  setTab(item);
                  if (item === 'health') void loadHealth();
                  if (item === 'analytics') void loadAnalytics(true);
                }}
                className={clsx(
                  'flex-1 rounded-md px-2 py-1 text-[10.5px] font-medium capitalize transition',
                  tab === item ? 'bg-surface-2 text-text-primary' : 'text-text-muted hover:text-text-secondary',
                )}
              >
                {item}
              </button>
            ))}
          </div>

          {tab === 'activity' && topApproval && (
            <div className="mb-3">
              <ApprovalPreviewCard
                approval={topApproval}
                busy={resolving}
                compact
                onReview={setSelectedApproval}
              />
            </div>
          )}

          {tab === 'activity' && !topApproval && visibleSelfHealIncident && (
            <SelfHealConsole
              incident={visibleSelfHealIncident}
              activity={feed}
              busy={resolving}
              onResolve={(approvalId, decision) => void resolveSelfHeal(approvalId, decision)}
              onReport={(incident) => void reportSelfHeal(incident)}
              onRollback={(checkpointId) => void rollbackSelfHeal(checkpointId)}
            />
          )}

          {tab === 'activity' && !topApproval && !visibleSelfHealIncident && currentFailedRun && status === 'failed' && (
            <div className="mb-3 border-l border-danger/70 pl-3">
              <div className="flex items-center gap-1.5 text-[12px] font-medium text-text-primary">
                <AlertTriangle size={12} className="text-danger" />
                Latest run failed
              </div>
              <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
                {currentFailedRun.failedNode ? `Failed at ${currentFailedRun.failedNode}.` : 'This run needs attention.'}
              </p>
              <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                <button type="button" onClick={() => onOpenRun(currentFailedRun.id)} className="font-medium text-accent hover:underline">Inspect</button>
                <button type="button" onClick={() => void retryFailedRun(false)} className="font-medium text-text-secondary hover:text-text-primary">Retry</button>
                <button type="button" onClick={() => void retryFailedRun(true)} className="font-medium text-text-secondary hover:text-text-primary">Retry from failed node</button>
              </div>
            </div>
          )}

          {tab === 'activity' && (visibleFeed.length === 0 ? (
            <div className="py-2 text-[11px] text-text-muted">
              {status === 'idle' ? 'No run activity yet.' : 'Waiting for the first activity.'}
            </div>
          ) : (
            <div className="space-y-2">
              {visibleFeed.map((item, index) => {
                const repeatedNode = Boolean(item.nodeId && visibleFeed[index - 1]?.nodeId === item.nodeId);
                const badge = activityBadge(item, clock);
                const elapsed = activityElapsed(item, clock);
                return (
                <button
                  key={activityKey(item)}
                  type="button"
                  onClick={() => item.nodeId && onFocusNode(item.nodeId)}
                  disabled={!item.nodeId}
                  className={clsx(
                    'group flex w-full items-start gap-2 text-left',
                    !item.nodeId && 'cursor-default',
                  )}
                >
                  <ActivityDot tone={item.tone} active={status === 'running' && item === visibleFeed[0]} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-[12px] text-text-secondary">
                        {repeatedNode ? item.title : item.nodeTitle ?? item.title}
                      </span>
                      {badge && (
                        <span className="shrink-0 rounded border border-border-subtle px-1 py-0.5 text-[9px] uppercase tracking-wide text-text-muted">
                          {badge}
                        </span>
                      )}
                      {elapsed && <span className="shrink-0 text-[9px] tabular-nums text-text-muted">{elapsed}</span>}
                      {item.nodeId && (
                        <Crosshair size={11} className="shrink-0 text-text-muted opacity-0 transition-opacity group-hover:opacity-100" />
                      )}
                    </div>
                    {item.detail && (
                      <div className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-text-muted">
                        {item.detail}
                      </div>
                    )}
                  </div>
                </button>
                );
              })}
            </div>
          ))}

          {tab === 'activity' && hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowEarlier(true)}
              className="mt-3 inline-flex items-center gap-1 text-[11px] text-text-muted transition-colors hover:text-text-secondary"
            >
              <ChevronUp size={11} />
              Show {hiddenCount} earlier event{hiddenCount === 1 ? '' : 's'}
            </button>
          )}
          {tab === 'activity' && showEarlier && displayFeed.length > DEFAULT_VISIBLE_EVENTS && (
            <button
              type="button"
              onClick={() => setShowEarlier(false)}
              className="mt-3 inline-flex items-center gap-1 text-[11px] text-text-muted transition-colors hover:text-text-secondary"
            >
              <ChevronDown size={11} />
              Show latest only
            </button>
          )}
          {tab === 'health' && (
            <div className="space-y-3">
              <HealthDetails
                health={health}
                checking={healthChecking}
                error={healthError}
                onFocusNode={onFocusNode}
                onRefresh={() => void loadHealth()}
              />
              <RuntimeDiagnostics activity={feed} />
            </div>
          )}
          {tab === 'analytics' && (
            <AnalyticsDetails
              analytics={analytics}
              loading={analyticsLoading}
              error={analyticsError}
              onRefresh={() => void loadAnalytics(true)}
              onFocusNode={onFocusNode}
            />
          )}
        </div>
      )}
      {mode === 'expanded' && (
        <button
          type="button"
          aria-label="Resize workflow operations"
          title="Resize workflow operations"
          onPointerDown={handleResizePointerDown}
          className="absolute bottom-1.5 right-1.5 flex h-4 w-4 items-end justify-end rounded-sm text-text-muted/80 hover:bg-surface-2 hover:text-text-primary"
        >
          <span className="h-2.5 w-2.5 border-b border-r border-current" />
        </button>
      )}
      <ApprovalReviewModal
        approval={selectedApproval}
        open={Boolean(selectedApproval)}
        onClose={() => setSelectedApproval(null)}
      />
    </section>
  );
}

function HealthStrip({
  health,
  checking,
  tone,
  onOpen,
}: {
  health: HealthReport | null;
  checking: boolean;
  tone: 'checking' | HealthReport['status'];
  onOpen: () => void;
}) {
  const nodeCount = health ? Object.keys(health.nodes).length : 0;
  const errorCount = health?.issues.filter((issue) => issue.severity === 'error').length ?? 0;
  const label = checking
    ? 'Checking health'
    : tone === 'healthy'
      ? `Healthy · ${nodeCount} nodes`
      : tone === 'blocked'
        ? `Blocked · ${errorCount} issue${errorCount === 1 ? '' : 's'}`
        : 'Needs run evidence';
  const Icon = checking ? RadioTower : tone === 'healthy' ? ShieldCheck : tone === 'blocked' ? AlertTriangle : CheckCircle2;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mb-3 flex w-full items-center gap-2 rounded-lg border border-white/10 bg-canvas/55 px-2.5 py-2 text-left hover:bg-surface/70"
    >
      <Icon
        size={13}
        className={clsx(
          'shrink-0',
          checking && 'text-text-muted',
          tone === 'healthy' && 'text-success',
          tone === 'blocked' && 'text-danger',
          tone === 'unverified' && 'text-warn',
        )}
      />
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-text-secondary">{label}</span>
      {health && !checking && <span className="font-mono text-[10px] text-text-muted">{health.durationMs}ms</span>}
    </button>
  );
}

function RuntimeDiagnostics({ activity }: { activity: RealtimeActivity[] }) {
  const diagnostics = activity.filter(isRuntimeDiagnostic).slice(0, 6);
  if (diagnostics.length === 0) return null;
  return (
    <div className="border-t border-white/10 pt-2">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">Runtime diagnostics</div>
      <div className="space-y-1.5">
        {diagnostics.map((item) => (
          <div key={`diagnostic-${activityKey(item)}`} className="rounded-md bg-surface/45 px-2 py-1.5 text-[10px] text-text-muted">
            <div className="flex gap-2">
              <span className="min-w-0 flex-1 truncate text-text-secondary">{item.title}</span>
              {item.transport && <span>{item.transport.replace('_', ' ')}</span>}
              {typeof item.attempt === 'number' && <span>attempt {item.attempt}</span>}
              {typeof item.durationMs === 'number' && <span>{formatActivityDuration(item.durationMs)}</span>}
            </div>
            {item.detail && <div className="mt-0.5 line-clamp-2">{item.detail}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function isRuntimeDiagnostic(item: RealtimeActivity): boolean {
  return Boolean(item.transport)
    || typeof item.durationMs === 'number'
    || item.activityKind === 'fallback'
    || item.activityKind === 'heartbeat'
    || item.phase === 'runtime'
    || item.phase === 'context'
    || /^waiting for .+ (response|output)/i.test(item.detail.trim());
}

function HealthDetails({
  health,
  checking,
  error,
  onFocusNode,
  onRefresh,
}: {
  health: HealthReport | null;
  checking: boolean;
  error: string | null;
  onFocusNode: (nodeId: string) => void;
  onRefresh: () => void;
}) {
  if (checking) return <LoadingPanel label="Checking workflow health..." />;
  if (!health) return <LoadError message={error ?? 'Health check unavailable.'} onRetry={onRefresh} />;
  const nodeStates = Object.values(health.nodes);
  const counts = {
    passed: nodeStates.filter((node) => node.status === 'passed').length,
    mocked: nodeStates.filter((node) => node.status === 'mocked').length,
    unverified: nodeStates.filter((node) => node.status === 'unverified').length,
  };
  const statusLabel = health.status === 'healthy'
    ? 'Healthy'
    : health.status === 'blocked'
      ? 'Blocked'
      : 'Unverified';
  const statusTone = health.status === 'healthy'
    ? 'text-success'
    : health.status === 'blocked'
      ? 'text-danger'
      : 'text-warn';
  if (health.issues.length === 0) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 border-b border-white/10 pb-2">
          <ShieldCheck size={14} className={statusTone} />
          <span className="flex-1 text-[11px] font-medium text-text-primary">{statusLabel}</span>
          <span className="font-mono text-[10px] text-text-muted">{health.durationMs}ms</span>
          <RefreshButton label="Refresh workflow health" onClick={onRefresh} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Metric label="Checked" value={String(nodeStates.length)} />
          <Metric label="Passed" value={String(counts.passed)} />
          {counts.mocked > 0 && <Metric label="Mocked" value={String(counts.mocked)} />}
          {counts.unverified > 0 && <Metric label="Unverified" value={String(counts.unverified)} />}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 border-b border-white/10 pb-2">
        <AlertTriangle size={14} className={statusTone} />
        <span className="flex-1 text-[11px] font-medium text-text-primary">{statusLabel}</span>
        <span className="font-mono text-[10px] text-text-muted">{health.durationMs}ms</span>
        <RefreshButton label="Refresh workflow health" onClick={onRefresh} />
      </div>
      {health.issues.map((issue, index) => (
        <button
          key={`${issue.code}-${issue.nodeId ?? index}`}
          type="button"
          disabled={!issue.nodeId}
          onClick={() => issue.nodeId && onFocusNode(issue.nodeId)}
          className="w-full rounded-lg border border-white/10 bg-surface/50 px-3 py-2 text-left hover:bg-surface-2 disabled:cursor-default"
        >
          <div className="flex items-center gap-2">
            <span className={clsx('text-[10px] font-semibold uppercase', issue.severity === 'error' ? 'text-danger' : 'text-warn')}>
              {issue.severity}
            </span>
            {issue.nodeTitle && <span className="truncate text-[11px] font-medium text-text-primary">{issue.nodeTitle}</span>}
          </div>
          <p className="mt-0.5 text-[10.5px] leading-4 text-text-muted">{issue.message}</p>
          {issue.remediation && <p className="mt-0.5 text-[10.5px] leading-4 text-text-secondary">{issue.remediation}</p>}
        </button>
      ))}
    </div>
  );
}

function AnalyticsDetails({
  analytics,
  loading,
  error,
  onRefresh,
  onFocusNode,
}: {
  analytics: WorkflowAnalytics | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onFocusNode: (nodeId: string) => void;
}) {
  if (loading) return <LoadingPanel label="Loading run analytics..." />;
  if (!analytics) return <LoadError message={error ?? 'No run history yet.'} onRetry={onRefresh} />;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 border-b border-white/10 pb-2">
        <RadioTower size={14} className="text-accent" />
        <span className="flex-1 text-[11px] font-medium text-text-primary">Run analytics</span>
        <RefreshButton label="Refresh workflow analytics" onClick={onRefresh} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Metric label="Runs" value={String(analytics.runs)} />
        <Metric label="Success" value={analytics.successRate == null ? '–' : `${Math.round(analytics.successRate * 100)}%`} />
        <Metric label="Avg duration" value={formatDuration(analytics.avgDurationMs)} />
      </div>
      <TokenSummary
        total={analytics.totalTokens}
        tokensIn={analytics.totalTokensIn}
        tokensOut={analytics.totalTokensOut}
        perRun={analytics.avgTokensPerRun}
      />
      <CostSummary metered={analytics.metered} avgCostCents={analytics.avgCostCents} totalCostCents={analytics.totalCostCents} />
      {analytics.perAgent && analytics.perAgent.length > 0 && (
        <div className="border-t border-white/10 pt-2">
          <div className="mb-1.5 text-[9px] font-semibold uppercase tracking-wider text-text-muted">Tokens by agent</div>
          <div className="space-y-1">
            {analytics.perAgent.slice(0, 6).map((row) => {
              const share = analytics.totalTokens > 0 ? row.totalTokens / analytics.totalTokens : 0;
              return (
                <div key={row.agentId ?? 'system'} className="flex items-center gap-2 text-[10.5px]">
                  <span className={`min-w-0 flex-1 truncate ${row.agentId ? 'text-text-secondary' : 'italic text-text-muted'}`}>{row.name}</span>
                  <span className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-surface-2">
                    <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.round(share * 100)}%` }} />
                  </span>
                  <span className="w-12 shrink-0 text-right font-mono text-text-muted">{formatTokens(row.totalTokens)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {Object.keys(analytics.byStatus).length > 0 && (
        <div className="border-t border-white/10 pt-2">
          <div className="mb-1.5 text-[9px] font-semibold uppercase tracking-wider text-text-muted">Run outcomes</div>
          <div className="space-y-1">
            {Object.entries(analytics.byStatus).map(([status, count]) => (
              <div key={status} className="flex items-center gap-2 text-[10.5px] text-text-secondary">
                <span className="min-w-0 flex-1 truncate">{formatRunStatus(status)}</span>
                <span className="font-mono text-text-muted">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {analytics.nodeFailures.length > 0 && (
        <div className="border-t border-white/10 pt-2">
          <div className="mb-1.5 text-[9px] font-semibold uppercase tracking-wider text-text-muted">Failure hotspots</div>
          <div className="space-y-1.5">
            {analytics.nodeFailures.slice(0, 3).map((failure) => (
              <button
                key={failure.nodeId}
                type="button"
                onClick={() => onFocusNode(failure.nodeId)}
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-surface-2"
              >
                <AlertTriangle size={11} className="shrink-0 text-danger" />
                <span className="min-w-0 flex-1 truncate text-[10.5px] text-text-secondary">{failure.title}</span>
                <span className="font-mono text-[10px] text-text-muted">{failure.failures}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LoadingPanel({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-4 text-[11px] text-text-muted">
      <RadioTower size={13} className="animate-pulse" />
      {label}
    </div>
  );
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-danger/25 bg-danger-soft/30 px-3 py-2.5">
      <AlertTriangle size={13} className="shrink-0 text-danger" />
      <span className="min-w-0 flex-1 text-[11px] leading-4 text-text-secondary">{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-muted hover:bg-surface-2 hover:text-text-primary"
        aria-label="Retry monitor data"
        title="Retry"
      >
        <RefreshCw size={12} />
      </button>
    </div>
  );
}

function RefreshButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-6 w-6 items-center justify-center rounded text-text-muted hover:bg-surface-2 hover:text-text-primary"
      aria-label={label}
      title={label}
    >
      <RefreshCw size={12} />
    </button>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-surface/50 px-2.5 py-2">
      <div className="text-[9px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className="mt-0.5 text-[13px] font-semibold text-text-primary">{value}</div>
    </div>
  );
}

/**
 * Token consumption ? the headline analytics signal. One tile replaces the old
 * confusing "Tokens" + "Avg tokens" pair: a big total, the in/out split, and the
 * per-run average folded in as a caption.
 */
function TokenSummary({
  total,
  tokensIn,
  tokensOut,
  perRun,
}: {
  total: number;
  tokensIn: number;
  tokensOut: number;
  perRun: number;
}) {
  return (
    <div className="rounded-lg border border-accent/25 bg-accent-soft/30 px-3 py-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-accent">Tokens consumed</span>
        <span className="text-[10px] text-text-muted">~{formatTokens(perRun)}/run</span>
      </div>
      <div className="mt-0.5 text-[20px] font-semibold leading-tight text-text-primary">{formatTokens(total)}</div>
      <div className="mt-1 flex items-center gap-3 text-[10.5px] text-text-secondary">
        <span className="inline-flex items-center gap-1"><ArrowDownRight size={11} className="text-text-muted" /> {formatTokens(tokensIn)} in</span>
        <span className="inline-flex items-center gap-1"><ArrowUpRight size={11} className="text-text-muted" /> {formatTokens(tokensOut)} out</span>
      </div>
    </div>
  );
}

/**
 * Cost is meaningful only on metered (API-key) runtimes. Subscription CLI
 * harnesses (Codex / Claude / Antigravity) have no per-run dollar cost, so we
 * say so honestly instead of showing a misleading $0.000.
 */
function CostSummary({ metered, avgCostCents, totalCostCents }: { metered: boolean; avgCostCents: number; totalCostCents: number }) {
  if (!metered) {
    return (
      <div className="rounded-lg border border-white/10 bg-surface/40 px-3 py-2 text-[10.5px] text-text-muted">
        Subscription runtime ? cost not metered. Tokens above are the spend signal.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      <Metric label="Avg cost / run" value={`$${(avgCostCents / 100).toFixed(3)}`} />
      <Metric label="Total cost" value={`$${(totalCostCents / 100).toFixed(2)}`} />
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

function formatRunStatus(status: string): string {
  return status.toLowerCase().replace(/_/g, ' ');
}

function updateMonitorStatus(
  env: Pick<RealtimeEnvelope, 'event' | 'payload'>,
  setStatus: React.Dispatch<React.SetStateAction<MonitorStatus>>,
  setTerminalKind: React.Dispatch<React.SetStateAction<'run' | 'build' | null>>,
) {
  if (env.event === REALTIME_EVENTS.RUN_COMPLETED) {
    setTerminalKind('run');
    setStatus('completed');
    return;
  }
  if (env.event === REALTIME_EVENTS.RUN_FAILED) {
    setTerminalKind('run');
    setStatus('failed');
    return;
  }
  if (env.event === REALTIME_EVENTS.RUN_PAUSED) {
    setStatus('paused');
    return;
  }
  if (env.event === REALTIME_EVENTS.RUN_CANCELLED) {
    setTerminalKind('run');
    setStatus('completed');
    return;
  }
  if (env.event === REALTIME_EVENTS.CANVAS_BUILD_COMPLETE) {
    setTerminalKind('build');
    setStatus('completed');
    return;
  }
  if (env.event === REALTIME_EVENTS.NODE_WAITING_FOR_INPUT || env.event === REALTIME_EVENTS.APPROVAL_REQUESTED) {
    setStatus('waiting');
    return;
  }
  if (
    env.event === REALTIME_EVENTS.RUN_CREATED
    || env.event === REALTIME_EVENTS.RUN_RUNNING
  ) {
    setStatus((current) => current === 'completed' || current === 'failed' ? current : 'running');
    return;
  }
  if (env.event === REALTIME_EVENTS.NODE_STARTED || env.event === REALTIME_EVENTS.AGENT_WORK_STEP) {
    // Historical or late work events describe the run but cannot resume a
    // deterministically paused/waiting run. Only an explicit run-running event
    // may advance those lifecycle states.
    setStatus((current) => ['completed', 'failed', 'paused', 'waiting'].includes(current) ? current : 'running');
  }
}

function upsertActivity(
  setFeed: React.Dispatch<React.SetStateAction<RealtimeActivity[]>>,
  activity: RealtimeActivity,
) {
  const key = activityKey(activity);
  setFeed((current) => [
    activity,
    ...current.filter((item) => activityKey(item) !== key),
  ].slice(0, 80));
}

function dedupeActivities(activities: RealtimeActivity[]): RealtimeActivity[] {
  const deduped = new Map<string, RealtimeActivity>();
  for (const activity of activities) deduped.set(activityKey(activity), activity);
  return [...deduped.values()];
}

function activityKey(activity: RealtimeActivity): string {
  // Runs created before stable typed activity IDs shipped persisted the CLI
  // final-only heartbeat as a fresh generic work-step every 15 seconds. Collapse
  // those historical rows too, even though each one now has a generated durable
  // ID, so reopening an old run does not resurrect the original spam.
  if (
    /^Waiting for .+ to respond — .+ no output yet$/i.test(activity.detail.trim())
    || /^Hermes is running — .+ elapsed; final-answer-only mode$/i.test(activity.detail.trim())
  ) {
    return [
      activity.runId ?? activity.workflowId ?? 'activity',
      activity.nodeId ?? 'node',
      activity.agentId ?? activity.agentName ?? 'agent',
      'provider-wait',
    ].join(':');
  }
  const durableId = typeof activity.raw.activityId === 'string' ? activity.raw.activityId : null;
  if (durableId) return `${activity.runId ?? activity.workflowId ?? 'activity'}:${durableId}`;
  if (
    activity.event === REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE
    || activity.event === REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL
    || (activity.event === REALTIME_EVENTS.AGENT_WORK_STEP && activity.phase === 'thinking')
  ) {
    return [
      activity.runId ?? activity.workflowId ?? 'activity',
      activity.event,
      activity.at,
      activity.agentId ?? activity.agentName ?? 'agent',
      activity.detail,
    ].join(':');
  }
  if (activity.nodeId) return `${activity.runId ?? activity.workflowId ?? 'activity'}:node:${activity.nodeId}`;
  if (activity.kind === 'run') return `${activity.runId ?? activity.workflowId ?? 'activity'}:run`;
  if (activity.kind === 'approval') return `approval:${activity.approvalId ?? activity.detail}`;
  if (activity.kind === 'agent') {
    return `${activity.runId ?? activity.workflowId ?? 'activity'}:agent:${activity.agentId ?? activity.agentName ?? 'update'}`;
  }
  if (activity.event === REALTIME_EVENTS.CANVAS_BUILD_COMPLETE) {
    return `${activity.runId ?? activity.workflowId ?? 'activity'}:build:complete`;
  }
  return [
    activity.runId ?? activity.workflowId ?? 'activity',
    activity.kind,
    activity.agentId ?? activity.agentName ?? activity.title,
    activity.detail,
  ].join(':');
}

function activityBadge(activity: RealtimeActivity, now: number): string | null {
  if (activity.transport === 'hermes_acp') {
    if (activity.phase !== 'waiting') return 'Hermes ACP';
    const started = activity.startedAt ? Date.parse(activity.startedAt) : Number.NaN;
    return Number.isFinite(started) && activity.status === 'running' && now - started >= 15_000
      ? 'Hermes ACP · watchdog'
      : 'Hermes ACP · waiting';
  }
  if (activity.transport === 'hermes_cli') return 'Hermes CLI · fallback';
  if (activity.activityKind === 'tool_call' || activity.kind === 'tool') return 'Using tool';
  if (activity.activityKind === 'thinking') return 'Reasoning';
  if (activity.phase === 'waiting') return 'Waiting';
  if (activity.phase === 'runtime') return 'Starting';
  return activity.status ?? null;
}

function activityElapsed(activity: RealtimeActivity, now: number): string | null {
  if (typeof activity.durationMs === 'number') return formatActivityDuration(activity.durationMs);
  if (!activity.startedAt || activity.status === 'success' || activity.status === 'error') return null;
  const started = Date.parse(activity.startedAt);
  return Number.isFinite(started) ? formatActivityDuration(Math.max(0, now - started)) : null;
}

function formatActivityDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function statusLabel(status: MonitorStatus, workflowTitle: string, terminalKind: 'run' | 'build' | null): string {
  if (status === 'completed') return terminalKind === 'build' ? 'Build execution finished' : 'Execution finished';
  if (status === 'failed') return 'Run failed';
  if (status === 'paused') return 'Run paused';
  if (status === 'waiting') return 'Waiting for approval';
  if (status === 'running') return 'Run in progress';
  return `${workflowTitle} ready`;
}

function StatusIcon({ status, tone }: { status: MonitorStatus; tone: RealtimeActivityTone }) {
  if (status === 'completed') return <CheckCircle2 size={13} className="shrink-0 text-success" />;
  if (status === 'failed') return <AlertTriangle size={13} className="shrink-0 text-danger" />;
  if (status === 'paused') return <Play size={12} className="shrink-0 text-warn" />;
  if (status === 'waiting') return <Circle size={12} className="shrink-0 text-warn" />;
  return (
    <RadioTower
      size={13}
      className={clsx('shrink-0', tone === 'accent' ? 'text-accent' : 'text-text-muted')}
    />
  );
}

function matchesWorkflowActivity(
  activity: RealtimeActivity,
  workflowId: string,
  trackedRunId: string | null,
): boolean {
  if (trackedRunId && activity.runId === trackedRunId) return true;
  return activity.workflowId === workflowId;
}

function monitorStatusFromRun(
  status: WorkflowRunSummary['status'] | null | undefined,
  activeRunId: string | null,
): MonitorStatus {
  if (status === 'paused') return 'paused';
  if (status === 'waiting') return 'waiting';
  if (status === 'running' || status === 'pending') return 'running';
  if (status === 'failed') return 'failed';
  if (status === 'completed' || status === 'completed_with_violation' || status === 'cancelled') return 'completed';
  return activeRunId ? 'running' : 'idle';
}

function ActivityDot({ tone, active }: { tone: RealtimeActivityTone; active: boolean }) {
  return (
    <span className={clsx(
      'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
      tone === 'success' && 'bg-success',
      tone === 'warn' && 'bg-warn',
      tone === 'danger' && 'bg-danger',
      tone === 'accent' && 'bg-accent',
      tone === 'muted' && 'bg-text-muted/60',
      active && 'animate-pulse',
    )} />
  );
}



