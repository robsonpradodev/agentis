import { describe, expect, it } from 'vitest';
import { REALTIME_EVENTS } from '@agentis/core';
import {
  REALTIME_ACTIVITY_EVENTS,
  describeRealtimeActivity,
} from '../../src/lib/realtimeActivity';

describe('realtimeActivity task spine events', () => {
  it('projects safe durable narration into the workspace feed', () => {
    expect(REALTIME_ACTIVITY_EVENTS).toContain(REALTIME_EVENTS.CONVERSATION_TURN_EVENT);
    const activity = describeRealtimeActivity({
      event: REALTIME_EVENTS.CONVERSATION_TURN_EVENT,
      emittedAt: '2026-08-12T12:00:00.000Z',
      payload: {
        version: 2,
        id: 'event-1',
        workspaceId: 'workspace-1',
        conversationId: 'conversation-1',
        turnId: 'turn-1',
        agentId: 'agent-1',
        seq: 2,
        category: 'narration',
        visibility: 'both',
        summary: 'I will verify the exact revision before publishing it.',
        createdAt: '2026-08-12T12:00:00.000Z',
      },
    });
    expect(activity).toMatchObject({
      id: 'event-1',
      kind: 'message',
      detail: 'I will verify the exact revision before publishing it.',
      conversationId: 'conversation-1',
      agentId: 'agent-1',
    });
  });

  it('does not duplicate technical ledger operations in the workspace feed', () => {
    expect(describeRealtimeActivity({
      event: REALTIME_EVENTS.CONVERSATION_TURN_EVENT,
      emittedAt: '2026-08-12T12:00:00.000Z',
      payload: { category: 'operation', visibility: 'technical', summary: 'Started a tool' },
    })).toBeNull();
  });

  it('maps task spine verification into Mission Control activity', () => {
    expect(REALTIME_ACTIVITY_EVENTS).toContain(REALTIME_EVENTS.TASK_SPINE_VERIFYING);

    const activity = describeRealtimeActivity({
      event: REALTIME_EVENTS.TASK_SPINE_VERIFYING,
      emittedAt: '2026-06-17T12:00:00.000Z',
      payload: {
        taskId: 'task-1',
        planId: 'task-1',
        title: 'Ship verified answer',
        status: 'verifying',
      },
    });

    expect(activity).toMatchObject({
      kind: 'task',
      tone: 'warn',
      taskId: 'task-1',
      title: 'Ship verified answer',
    });
  });

  it('surfaces blocked task spine details from verification evidence', () => {
    const activity = describeRealtimeActivity({
      event: REALTIME_EVENTS.TASK_SPINE_BLOCKED,
      emittedAt: '2026-06-17T12:00:00.000Z',
      payload: {
        taskId: 'task-2',
        title: 'Collect evidence',
        verification: {
          status: 'failed',
          criteria: [{ criterion: 'Evidence is complete', passed: false, reason: 'Missing source link.' }],
        },
      },
    });

    expect(activity).toMatchObject({
      kind: 'task',
      tone: 'warn',
      detail: 'Missing source link.',
    });
  });

  it('keeps a repair work-step detail instead of collapsing it into the node title', () => {
    const activity = describeRealtimeActivity({
      event: REALTIME_EVENTS.AGENT_WORK_STEP,
      emittedAt: '2026-06-21T14:00:00.000Z',
      payload: {
        runId: 'run-1',
        nodeId: 'evaluate-digest-quality',
        description: 'Repairing Evaluator',
        detail: 'Orchestrator is inspecting the completed digest bundle.',
        phase: 'thinking',
      },
    });

    expect(activity).toMatchObject({
      kind: 'agent',
      detail: 'Orchestrator is inspecting the completed digest bundle.',
    });
  });

  it('preserves typed runtime metadata and uses a stable activity id for cumulative updates', () => {
    const first = describeRealtimeActivity({
      event: REALTIME_EVENTS.AGENT_WORK_STEP,
      emittedAt: '2026-08-23T12:00:00.000Z',
      payload: {
        activityId: 'runtime-wait-1', runId: 'run-1', nodeId: 'node-1',
        activityKind: 'waiting', activityStatus: 'running', phase: 'model_waiting',
        description: 'Provider has not produced output yet.', transport: 'hermes_acp',
        attempt: 1, startedAt: '2026-08-23T11:59:45.000Z', durationMs: 15_000,
      },
    });
    const update = describeRealtimeActivity({
      event: REALTIME_EVENTS.AGENT_WORK_STEP,
      emittedAt: '2026-08-23T12:00:05.000Z',
      payload: {
        activityId: 'runtime-wait-1', runId: 'run-1', nodeId: 'node-1',
        activityKind: 'fallback', activityStatus: 'success', phase: 'transport_recovery',
        description: 'Continuing through Hermes CLI.', transport: 'hermes_cli',
        attempt: 1, completedAt: '2026-08-23T12:00:05.000Z', durationMs: 20_000,
      },
    });

    expect(first).toMatchObject({
      id: 'runtime-wait-1', activityKind: 'waiting', status: 'running',
      transport: 'hermes_acp', attempt: 1, durationMs: 15_000,
    });
    expect(update).toMatchObject({ id: 'runtime-wait-1', activityKind: 'fallback', transport: 'hermes_cli' });
  });

  it('does not present mechanical completion as success when the business verdict failed', () => {
    const activity = describeRealtimeActivity({
      event: REALTIME_EVENTS.RUN_COMPLETED,
      emittedAt: '2026-07-15T12:00:00.000Z',
      payload: {
        runId: 'run-deficient',
        status: 'COMPLETED',
        accomplished: false,
        verdict: 'failed_checks',
      },
    });

    expect(activity).toMatchObject({
      kind: 'run',
      tone: 'danger',
      title: 'Run finished — outcome not accomplished',
    });
    expect(activity?.detail).toContain('failed_checks');
  });
});
