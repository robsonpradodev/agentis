import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REALTIME_EVENTS } from '@agentis/core';

const realtime = vi.hoisted(() => ({
  handler: null as null | ((env: { event: string; payload: unknown; emittedAt: string }) => void),
}));
const apiMock = vi.hoisted(() => vi.fn());
const workspaceMock = vi.hoisted(() => ({
  activeRuns: [] as Array<Record<string, unknown>>,
  failedRuns: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../src/lib/realtime', () => ({
  rtSubscribe: () => () => undefined,
  useRealtime: (_events: string[], handler: typeof realtime.handler) => {
    realtime.handler = handler;
  },
}));

vi.mock('../../src/lib/api', () => ({
  api: (...args: unknown[]) => apiMock(...args),
}));

vi.mock('../../src/lib/workspaceData', () => ({
  useWorkspaceData: () => ({
    workspaceId: 'workspace-1',
    approvals: [],
    activeRuns: workspaceMock.activeRuns,
    failedRuns: workspaceMock.failedRuns,
  }),
  refreshWorkspaceSnapshot: vi.fn(async () => undefined),
}));

import { WorkflowMonitorCard } from '../../src/components/canvas/WorkflowMonitorCard';

function emit(event: string, payload: Record<string, unknown>) {
  act(() => realtime.handler?.({ event, payload, emittedAt: '2026-06-09T12:00:00.000Z' }));
}

describe('WorkflowMonitorCard', () => {
  beforeEach(() => {
    realtime.handler = null;
    workspaceMock.activeRuns = [];
    workspaceMock.failedRuns = [
      {
        id: 'run-self-heal',
        workflowId: 'workflow-self-heal',
        workflowName: 'Daily digest',
        failedNode: 'Draft',
        selfHealIncident: {
          nodeId: 'node-draft',
          nodeTitle: 'Draft',
          status: 'BLOCKED',
          mode: 'guarded',
          attempt: 1,
          maxAttempts: 2,
          reason: 'No workspace model available to ground a repair.',
          startedAt: '2026-06-09T12:00:00.000Z',
          updatedAt: '2026-06-09T12:00:01.000Z',
        },
      },
    ];
    apiMock.mockReset();
    apiMock.mockImplementation(async (path: string) => {
      if (path.includes('/preflight')) {
        return {
          status: 'healthy',
          durationMs: 12,
          nodes: { trigger: { status: 'passed' }, deliver: { status: 'passed' } },
          issues: [],
        };
      }
      if (path.includes('/analytics')) {
        return {
          runs: 4,
          successRate: 0.75,
          avgDurationMs: 2_300,
          avgCostCents: 25,
          totalCostCents: 100,
          totalTokens: 840,
          avgTokensPerRun: 210,
          byStatus: { COMPLETED: 3, FAILED: 1 },
          nodeFailures: [{ nodeId: 'node-1', title: 'Send email', failures: 1, sampleError: 'mail unavailable' }],
        };
      }
      return { activity: [] };
    });
  });

  it('deduplicates node activity and latches a non-animated completed state', async () => {
    render(
      <WorkflowMonitorCard
        workflowId="workflow-1"
        workflowTitle="Daily digest"
        activeRunId="run-1"
        nodeTitles={new Map([['node-1', 'Send email']])}
        revision="rev-1"
        onFocusNode={vi.fn()}
        onOpenRun={vi.fn()}
        onRunStarted={vi.fn()}
        onOpenHistory={vi.fn()}
      />,
    );
    await act(async () => undefined);

    emit(REALTIME_EVENTS.NODE_STARTED, {
      workflowId: 'workflow-1',
      runId: 'run-1',
      nodeId: 'node-1',
    });
    emit(REALTIME_EVENTS.NODE_COMPLETED, {
      workflowId: 'workflow-1',
      runId: 'run-1',
      nodeId: 'node-1',
      outputPreview: 'Email sent',
    });

    expect(screen.getAllByText('Send email')).toHaveLength(1);

    emit(REALTIME_EVENTS.RUN_COMPLETED, {
      workflowId: 'workflow-1',
      runId: 'run-1',
      summary: 'Done',
    });

    expect(screen.getByText('Execution finished')).toBeInTheDocument();
    expect(screen.queryByText(/Realtime monitor|Events|Review|1m|seconds/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('workflow-realtime-monitor').querySelector('.animate-pulse')).toBeNull();
  });

  it('treats canvas build completion as terminal and removes the stop control', async () => {
    render(
      <WorkflowMonitorCard
        workflowId="workflow-1"
        workflowTitle="Daily digest"
        activeRunId="build-1"
        nodeTitles={new Map()}
        revision="rev-1"
        onFocusNode={vi.fn()}
        onOpenRun={vi.fn()}
        onRunStarted={vi.fn()}
        onOpenHistory={vi.fn()}
      />,
    );
    await act(async () => undefined);

    emit(REALTIME_EVENTS.AGENT_WORK_STEP, {
      workflowId: 'workflow-1',
      runId: 'build-1',
      agentId: 'agent-1',
      description: 'Drafting the workflow',
    });
    emit(REALTIME_EVENTS.AGENT_WORK_STEP, {
      workflowId: 'workflow-1',
      runId: 'build-1',
      agentId: 'agent-1',
      description: 'Workflow ready',
    });
    emit(REALTIME_EVENTS.CANVAS_BUILD_COMPLETE, {
      workflowId: 'workflow-1',
      runId: 'build-1',
      nodeCount: 12,
      edgeCount: 11,
    });

    expect(screen.getAllByText('Workflow ready').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Stop run' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open run drawer' })).not.toBeInTheDocument();
    expect(screen.getByTestId('workflow-realtime-monitor').querySelector('.animate-pulse')).toBeNull();
    expect(screen.queryByText('Agent update')).not.toBeInTheDocument();
  });

  it('renders blocked self-heal incidents in the activity surface', async () => {
    render(
      <WorkflowMonitorCard
        workflowId="workflow-self-heal"
        workflowTitle="Daily digest"
        activeRunId="run-self-heal"
        nodeTitles={new Map()}
        revision="rev-1"
        onFocusNode={vi.fn()}
        onOpenRun={vi.fn()}
        onRunStarted={vi.fn()}
        onOpenHistory={vi.fn()}
      />,
    );
    await act(async () => undefined);

    expect(screen.getByTestId('self-heal-console')).toBeInTheDocument();
    expect(screen.getByText(/Couldn't safely repair/)).toBeInTheDocument();
    expect(screen.getByText(/No workspace model available to ground a repair/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Report to team/ })).toBeInTheDocument();
  });

  it('does not keep showing an active repair incident after the run fails', async () => {
    workspaceMock.failedRuns = [
      {
        id: 'run-stale-repair',
        workflowId: 'workflow-stale-repair',
        workflowName: 'Daily digest',
        failedNode: 'Release validator',
        failedNodeId: 'release-validator',
        selfHealIncident: {
          nodeId: 'release-validator',
          nodeTitle: 'Release validator',
          status: 'PLANNING',
          mode: 'guarded',
          attempt: 1,
          maxAttempts: 2,
          diagnosis: 'Orchestrator is repairing the workflow with the chat tool loop.',
          startedAt: '2026-06-09T12:00:00.000Z',
          updatedAt: '2026-06-09T12:00:01.000Z',
        },
      },
    ];
    const props = {
      workflowId: 'workflow-stale-repair',
      workflowTitle: 'Daily digest',
      activeRunId: 'run-stale-repair',
      activeRunStatus: 'running' as const,
      nodeTitles: new Map<string, string>(),
      revision: 'rev-1',
      onFocusNode: vi.fn(),
      onOpenRun: vi.fn(),
      onRunStarted: vi.fn(),
      onOpenHistory: vi.fn(),
    };
    const { rerender } = render(<WorkflowMonitorCard {...props} />);

    emit(REALTIME_EVENTS.RUN_FAILED, { workflowId: 'workflow-stale-repair', runId: 'run-stale-repair' });
    rerender(<WorkflowMonitorCard {...props} activeRunId={null} activeRunStatus={null} />);
    await act(async () => undefined);

    expect(screen.queryByTestId('self-heal-console')).not.toBeInTheDocument();
    expect(screen.getByText('Latest run failed')).toBeInTheDocument();
    expect(screen.getByText(/Failed at Release validator/)).toBeInTheDocument();
  });

  it('keeps the completed run visible instead of falling back to an older failure', async () => {
    const props = {
      workflowId: 'workflow-1',
      workflowTitle: 'Daily digest',
      nodeTitles: new Map<string, string>(),
      revision: 'rev-1',
      onFocusNode: vi.fn(),
      onOpenRun: vi.fn(),
      onRunStarted: vi.fn(),
      onOpenHistory: vi.fn(),
    };
    const { rerender } = render(<WorkflowMonitorCard {...props} activeRunId="run-success" activeRunStatus="running" />);

    emit(REALTIME_EVENTS.RUN_COMPLETED, { workflowId: 'workflow-1', runId: 'run-success' });
    rerender(<WorkflowMonitorCard {...props} activeRunId={null} activeRunStatus={null} />);
    await act(async () => undefined);

    expect(screen.getByText('Execution finished')).toBeInTheDocument();
    expect(screen.queryByText('Latest run failed')).not.toBeInTheDocument();
  });

  it('loads refreshable health and analytics data from the workflow endpoints', async () => {
    render(
      <WorkflowMonitorCard
        workflowId="workflow-1"
        workflowTitle="Daily digest"
        activeRunId="run-1"
        activeRunStatus="running"
        nodeTitles={new Map([['node-1', 'Send email']])}
        revision="rev-1"
        onFocusNode={vi.fn()}
        onOpenRun={vi.fn()}
        onRunStarted={vi.fn()}
        onOpenHistory={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'health' }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.getAllByText('2')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'analytics' }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('Run analytics')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('2.3s')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/v1/workflows/workflow-1/analytics');
  });

  it('replays typed diagnostics for the latched paused run after activeRunId clears', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/v1/runs/run-paused/activity') {
        return { activity: [{
          activityId: 'fallback-1',
          event: REALTIME_EVENTS.AGENT_WORK_STEP,
          emittedAt: '2026-08-23T12:00:20.000Z',
          payload: {
            activityId: 'fallback-1', workflowId: 'workflow-1', runId: 'run-paused', nodeId: 'node-1',
            nodeTitle: 'Select lead', description: 'ACP stalled; continuing through Hermes CLI.',
            activityKind: 'fallback', activityStatus: 'running', transport: 'hermes_cli', attempt: 1,
            startedAt: '2026-08-23T12:00:00.000Z', durationMs: 20_000,
          },
        }] };
      }
      if (path.includes('/preflight')) return { status: 'healthy', durationMs: 1, nodes: {}, issues: [] };
      if (path.includes('/analytics')) return { runs: 0, successRate: 0, avgDurationMs: 0, avgCostCents: 0, totalCostCents: 0, totalTokens: 0, avgTokensPerRun: 0, byStatus: {}, nodeFailures: [] };
      return { activity: [] };
    });
    const props = {
      workflowId: 'workflow-1', workflowTitle: 'Outbound', nodeTitles: new Map([['node-1', 'Select lead']]),
      revision: 'rev-1', onFocusNode: vi.fn(), onOpenRun: vi.fn(), onRunStarted: vi.fn(), onOpenHistory: vi.fn(),
    };
    const { rerender } = render(<WorkflowMonitorCard {...props} activeRunId="run-paused" activeRunStatus="running" />);
    emit(REALTIME_EVENTS.RUN_PAUSED, { workflowId: 'workflow-1', runId: 'run-paused' });
    rerender(<WorkflowMonitorCard {...props} activeRunId={null} activeRunStatus={null} />);
    await act(async () => { await Promise.resolve(); });

    expect(apiMock).toHaveBeenCalledWith('/v1/runs/run-paused/activity');
    expect(screen.getByText('Run paused')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'health' }));
    expect(await screen.findByText('ACP stalled; continuing through Hermes CLI.')).toBeInTheDocument();
    expect(screen.getAllByText(/hermes cli/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('attempt 1')).toBeInTheDocument();
  });

  it('coalesces legacy Hermes final-only heartbeat rows from durable replay', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/v1/runs/run-legacy/activity') {
        return { activity: [16, 31, 46].map((seconds) => ({
          activityId: `legacy-${seconds}`,
          event: REALTIME_EVENTS.AGENT_WORK_STEP,
          emittedAt: `2026-08-23T12:00:${String(seconds % 60).padStart(2, '0')}.000Z`,
          payload: {
            activityId: `legacy-${seconds}`, workflowId: 'workflow-1', runId: 'run-legacy', nodeId: 'node-1',
            agentId: 'agent-1', agentName: 'Ava', phase: 'thinking',
            description: `Hermes is running — ${seconds}s elapsed; final-answer-only mode`,
          },
        })) };
      }
      return { activity: [] };
    });
    render(
      <WorkflowMonitorCard
        workflowId="workflow-1" workflowTitle="Outbound" activeRunId="run-legacy" activeRunStatus="running"
        nodeTitles={new Map([['node-1', 'Select lead']])} revision="rev-1"
        onFocusNode={vi.fn()} onOpenRun={vi.fn()} onRunStarted={vi.fn()} onOpenHistory={vi.fn()}
      />,
    );
    await act(async () => { await Promise.resolve(); });

    expect(screen.getAllByText(/Hermes is running/)).toHaveLength(1);
  });
});
