// §PERF-BOOT — subpath import; see lib/realtime.ts.
import { REALTIME_EVENTS } from '@agentis/core/events';
import { normalizeToolInvocation } from '@agentis/core';
import type { RealtimeEnvelope } from './realtime';

export type RealtimeActivityKind =
  | 'run'
  | 'node'
  | 'agent'
  | 'tool'
  | 'message'
  | 'task'
  | 'approval'
  | 'status'
  | 'progress';

export type RealtimeActivityTone = 'accent' | 'success' | 'warn' | 'danger' | 'muted';

export interface RealtimeActivity {
  id: string;
  event: string;
  kind: RealtimeActivityKind;
  tone: RealtimeActivityTone;
  title: string;
  detail: string;
  at: string;
  runId?: string;
  workflowId?: string;
  taskId?: string;
  taskTitle?: string;
  nodeId?: string;
  nodeTitle?: string;
  agentId?: string;
  agentName?: string;
  conversationId?: string;
  clientTurnId?: string;
  phase?: string;
  status?: string;
  activityKind?: string;
  transport?: string;
  attempt?: number;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  tool?: string;
  approvalId?: string;
  progress?: { completed: number; total: number };
  /** A concrete thing the agent produced (record/artifact/surface…) — the "creation" feed. */
  creation?: { kind: string; title?: string; count?: number; collection?: string; ref?: string };
  /** Present when this work-step belongs to a delegated child session, not the emitting node's own agent. */
  delegate?: { childSessionId: string; role?: string; parentSessionId?: string };
  raw: Record<string, unknown>;
}

export const REALTIME_ACTIVITY_EVENTS = [
  REALTIME_EVENTS.RUN_CREATED,
  REALTIME_EVENTS.RUN_RUNNING,
  REALTIME_EVENTS.RUN_PAUSED,
  REALTIME_EVENTS.RUN_CANCELLED,
  REALTIME_EVENTS.RUN_COMPLETED,
  REALTIME_EVENTS.RUN_FAILED,
  REALTIME_EVENTS.NODE_STARTED,
  REALTIME_EVENTS.NODE_COMPLETED,
  REALTIME_EVENTS.NODE_FAILED,
  REALTIME_EVENTS.NODE_RETRY_SCHEDULED,
  REALTIME_EVENTS.NODE_WAITING_FOR_INPUT,
  REALTIME_EVENTS.TASK_SPINE_ACCEPTED,
  REALTIME_EVENTS.TASK_SPINE_UPDATED,
  REALTIME_EVENTS.TASK_SPINE_BOUND,
  REALTIME_EVENTS.TASK_SPINE_VERIFYING,
  REALTIME_EVENTS.TASK_SPINE_VERIFIED,
  REALTIME_EVENTS.TASK_SPINE_COMPLETED,
  REALTIME_EVENTS.TASK_SPINE_BLOCKED,
  REALTIME_EVENTS.TASK_SPINE_FAILED,
  REALTIME_EVENTS.TASK_SPINE_DECISION_RECORDED,
  REALTIME_EVENTS.TASK_SPINE_DEVIATION_RECORDED,
  REALTIME_EVENTS.TASK_SPINE_REDIRECTED,
  REALTIME_EVENTS.LOOP_PROGRESS,
  REALTIME_EVENTS.APPROVAL_REQUESTED,
  REALTIME_EVENTS.APPROVAL_RESOLVED,
  REALTIME_EVENTS.AGENT_WORK_STEP,
  REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL,
  REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE,
  REALTIME_EVENTS.AGENT_STATUS_CHANGED,
  REALTIME_EVENTS.CANVAS_BUILD_COMPLETE,
  REALTIME_EVENTS.CONVERSATION_TURN_EVENT,
] as const;

export function describeRealtimeActivity(
  env: RealtimeEnvelope,
  options: { nodeTitle?: (nodeId: string) => string | undefined } = {},
): RealtimeActivity | null {
  const payload = isRecord(env.payload) ? env.payload : {};
  const runId = stringField(payload, ['runId']);
  const workflowId = stringField(payload, ['workflowId']);
  const taskId = stringField(payload, ['taskId', 'planId']);
  const taskTitle = stringField(payload, ['taskTitle', 'title']);
  const nodeId = stringField(payload, ['nodeId', 'taskId']);
  const nodeTitle = nodeId ? options.nodeTitle?.(nodeId) : undefined;
  const agentId = stringField(payload, ['agentId']);
  const agentName = stringField(payload, ['agentName', 'actorName']);
  const conversationId = stringField(payload, ['conversationId']);
  const clientTurnId = stringField(payload, ['clientTurnId']);
  const phase = stringField(payload, ['activityPhase', 'phase', 'status']);
  const status = stringField(payload, ['activityStatus', 'status']);
  const activityKind = stringField(payload, ['activityKind', 'kind']);
  const transport = stringField(payload, ['transport']);
  const attempt = numberField(payload, ['attempt']);
  const startedAt = stringField(payload, ['startedAt']);
  const completedAt = stringField(payload, ['completedAt']);
  const durationMs = numberField(payload, ['durationMs']);
  const rawTool = stringField(payload, ['tool', 'toolName', 'name', 'command']);
  const invocation = normalizeToolInvocation(rawTool, payload.args ?? payload.input);
  const tool = invocation.tool === 'tool' && !rawTool ? undefined : invocation.tool;
  const approvalId = stringField(payload, ['approvalId', 'id']);
  const at = stringField(payload, ['at', 'timestamp']) ?? env.emittedAt;
  const explicitActivityId = stringField(payload, ['activityId']);
  const baseId = explicitActivityId ?? [
    env.event, at, runId, nodeId, agentId, approvalId,
    stringField(payload, ['phase', 'status', 'tool']),
  ].filter(Boolean).join(':');

  const base = {
    id: baseId,
    event: env.event,
    at,
    runId,
    workflowId,
    taskId,
    taskTitle,
    nodeId,
    nodeTitle,
    agentId,
    agentName,
    conversationId,
    clientTurnId,
    phase,
    status,
    activityKind,
    transport,
    attempt,
    startedAt,
    completedAt,
    durationMs,
    tool,
    approvalId,
    raw: payload,
  };

  switch (env.event) {
    case REALTIME_EVENTS.CONVERSATION_TURN_EVENT: {
      const category = stringField(payload, ['category']);
      const visibility = stringField(payload, ['visibility']);
      const summary = stringField(payload, ['summary']);
      // Tool and execution events already have richer workspace projections.
      // The ledger event fills the historical gap for safe host/provider
      // narration without exposing private reasoning or sensitive arguments.
      if (category !== 'narration' || visibility === 'technical' || !summary) return null;
      return {
        ...base,
        id: stringField(payload, ['id']) ?? base.id,
        kind: 'message',
        tone: 'muted',
        title: agentName ?? 'Agent update',
        detail: summary,
      };
    }
    case REALTIME_EVENTS.RUN_CREATED:
    case REALTIME_EVENTS.RUN_RUNNING: {
      const status = stringField(payload, ['status']);
      const waiting = status === 'WAITING' || status === 'waiting' || status === 'paused';
      return {
        ...base,
        kind: 'run',
        tone: waiting ? 'warn' : 'accent',
        title: waiting
          ? stringField(payload, ['workflowName', 'title']) ?? 'Run paused'
          : stringField(payload, ['workflowName', 'title']) ?? 'Run started',
        detail: waiting
          ? stringField(payload, ['reason', 'blockedReason', 'currentStep', 'status']) ?? 'Execution is waiting for operator action.'
          : stringField(payload, ['currentStep', 'status']) ?? 'Execution is underway.',
      };
    }
    case REALTIME_EVENTS.RUN_PAUSED:
      return {
        ...base,
        kind: 'run',
        tone: 'warn',
        title: 'Run paused',
        // A run parked on a recoverable blocker (out of credits, rate limit)
        // carries WHY. The old hardcoded sentence threw that away, so an operator
        // whose agent ran out of credits saw a generic "paused" with no cause.
        detail: stringField(payload, ['blockedReason', 'reason', 'error', 'detail'])
          ?? 'Execution can resume from its preserved frontier.',
      };
    case REALTIME_EVENTS.RUN_CANCELLED:
      return { ...base, kind: 'run', tone: 'muted', title: 'Run cancelled', detail: 'Execution was stopped.' };
    case REALTIME_EVENTS.RUN_COMPLETED:
      {
        const accomplished = payload.accomplished;
      return {
        ...base,
        kind: 'run',
        tone: accomplished === false ? 'danger' : accomplished === true ? 'success' : 'warn',
        title: stringField(payload, ['workflowName', 'title'])
          ?? (accomplished === false ? 'Run finished — outcome not accomplished' : 'Run completed'),
        detail: stringField(payload, ['summary', 'result'])
          ?? (accomplished === true
            ? 'Execution completed and the business outcome was verified.'
            : accomplished === false
              ? `Execution completed mechanically, but the business verdict is ${stringField(payload, ['verdict']) ?? 'deficient'}.`
              : 'Execution completed without a business-outcome verdict.'),
      };
      }
    case REALTIME_EVENTS.RUN_FAILED:
      return {
        ...base,
        kind: 'run',
        tone: 'danger',
        title: stringField(payload, ['workflowName', 'title']) ?? 'Run failed',
        detail: stringField(payload, ['error', 'failedNode', 'reason']) ?? 'The latest run needs attention.',
      };
    case REALTIME_EVENTS.CANVAS_BUILD_COMPLETE:
      return {
        ...base,
        kind: 'status',
        tone: 'success',
        title: 'Workflow ready',
        detail: 'The workflow build completed.',
      };
    case REALTIME_EVENTS.NODE_STARTED:
      return {
        ...base,
        kind: 'node',
        tone: 'accent',
        title: nodeTitle ?? 'Node started',
        detail: 'Executing node.',
      };
    case REALTIME_EVENTS.NODE_COMPLETED:
      return {
        ...base,
        kind: 'node',
        tone: 'success',
        title: nodeTitle ?? 'Node completed',
        detail: stringField(payload, ['outputPreview', 'summary']) ?? 'Output produced.',
      };
    case REALTIME_EVENTS.NODE_FAILED:
      return {
        ...base,
        kind: 'node',
        tone: 'danger',
        title: nodeTitle ?? 'Node failed',
        detail: stringField(payload, ['error', 'reason', 'detail']) ?? 'Execution failed at this node.',
      };
    case REALTIME_EVENTS.NODE_RETRY_SCHEDULED:
      return {
        ...base,
        kind: 'node',
        tone: 'warn',
        title: nodeTitle ?? 'Retry scheduled',
        detail: stringField(payload, ['reason', 'detail']) ?? 'The engine will retry this node.',
      };
    case REALTIME_EVENTS.NODE_WAITING_FOR_INPUT:
      return {
        ...base,
        kind: 'node',
        tone: 'warn',
        title: nodeTitle ?? 'Waiting for input',
        detail: stringField(payload, ['summary', 'detail']) ?? 'Human input is required before continuing.',
      };
    case REALTIME_EVENTS.TASK_SPINE_ACCEPTED:
      return {
        ...base,
        kind: 'task',
        tone: 'accent',
        title: taskTitle ?? 'Task accepted',
        detail: stringField(payload, ['objective', 'status']) ?? 'A durable task spine was created.',
      };
    case REALTIME_EVENTS.TASK_SPINE_UPDATED:
      return {
        ...base,
        kind: 'task',
        tone: 'muted',
        title: taskTitle ?? 'Task updated',
        detail: stringField(payload, ['status', 'objective']) ?? 'The durable task spine changed.',
      };
    case REALTIME_EVENTS.TASK_SPINE_BOUND: {
      const binding = stringField(payload, ['binding']);
      return {
        ...base,
        kind: 'task',
        tone: 'accent',
        title: taskTitle ?? 'Task connected',
        detail: binding === 'session'
          ? 'Linked to an agent session.'
          : binding === 'run'
            ? 'Linked to a workflow run.'
            : 'Linked to execution.',
      };
    }
    case REALTIME_EVENTS.TASK_SPINE_VERIFYING:
      return {
        ...base,
        kind: 'task',
        tone: 'warn',
        title: taskTitle ?? 'Verifying task',
        detail: 'Checking the agent output against the durable completion contract.',
      };
    case REALTIME_EVENTS.TASK_SPINE_VERIFIED:
      return {
        ...base,
        kind: 'task',
        tone: 'success',
        title: taskTitle ?? 'Task verified',
        detail: stringField(payload, ['verificationStatus', 'status']) ?? 'Completion passed verification.',
      };
    case REALTIME_EVENTS.TASK_SPINE_COMPLETED:
      return {
        ...base,
        kind: 'task',
        tone: 'success',
        title: taskTitle ?? 'Task completed',
        detail: stringField(payload, ['status', 'objective']) ?? 'Execution completed successfully.',
      };
    case REALTIME_EVENTS.TASK_SPINE_BLOCKED:
      return {
        ...base,
        kind: 'task',
        tone: 'warn',
        title: taskTitle ?? 'Task blocked',
        detail: nestedStringField(payload, 'deviation', ['reason', 'proposed'])
          ?? failedCriterionReason(payload)
          ?? stringField(payload, ['reason', 'status'])
          ?? 'The task needs operator attention before it can complete.',
      };
    case REALTIME_EVENTS.TASK_SPINE_FAILED:
      return {
        ...base,
        kind: 'task',
        tone: 'danger',
        title: taskTitle ?? 'Task failed',
        detail: stringField(payload, ['reason', 'error', 'status']) ?? 'Execution failed before the task could complete.',
      };
    case REALTIME_EVENTS.TASK_SPINE_DECISION_RECORDED:
      return {
        ...base,
        kind: 'task',
        tone: 'muted',
        title: taskTitle ?? 'Decision recorded',
        detail: nestedStringField(payload, 'decision', ['summary', 'rationale'])
          ?? stringField(payload, ['summary'])
          ?? 'A durable decision was added to the task spine.',
      };
    case REALTIME_EVENTS.TASK_SPINE_DEVIATION_RECORDED:
      return {
        ...base,
        kind: 'task',
        tone: 'warn',
        title: taskTitle ?? 'Deviation recorded',
        detail: nestedStringField(payload, 'deviation', ['reason', 'proposed'])
          ?? stringField(payload, ['reason'])
          ?? 'The agent recorded a change from the original task path.',
      };
    case REALTIME_EVENTS.TASK_SPINE_REDIRECTED:
      return {
        ...base,
        kind: 'task',
        tone: 'warn',
        title: taskTitle ?? 'Task redirected',
        detail: stringField(payload, ['instruction', 'reason']) ?? 'An operator redirected the active task.',
      };
    case REALTIME_EVENTS.LOOP_PROGRESS: {
      const completed = numberField(payload, ['completed', 'done']);
      const total = numberField(payload, ['total']);
      return {
        ...base,
        kind: 'progress',
        tone: 'accent',
        title: nodeTitle ?? 'Loop progress',
        detail: completed != null && total != null ? `${completed} / ${total}` : 'Loop advanced.',
        progress: completed != null && total != null ? { completed, total } : undefined,
      };
    }
    case REALTIME_EVENTS.APPROVAL_REQUESTED:
      return {
        ...base,
        kind: 'approval',
        tone: 'warn',
        title: stringField(payload, ['agentName', 'title']) ?? 'Approval requested',
        detail: stringField(payload, ['summary', 'workflowName']) ?? 'Operator input is required.',
      };
    case REALTIME_EVENTS.APPROVAL_RESOLVED:
      return {
        ...base,
        kind: 'approval',
        tone: 'muted',
        title: 'Approval resolved',
        detail: stringField(payload, ['status', 'summary', 'decision']) ?? 'The pending question has been handled.',
      };
    case REALTIME_EVENTS.AGENT_WORK_STEP: {
      const phase = stringField(payload, ['phase']);
      const text = stringField(payload, ['detail', 'description', 'text', 'summary', 'step', 'message']) ?? 'Working';
      // A concrete creation (record/artifact/surface…) renders as a distinct, richer
      const creationRaw = isRecord(payload.creation) ? payload.creation : null;
      if (creationRaw) {
        const ref = stringField(creationRaw, ['ref']);
        return {
          ...base,
          kind: 'tool',
          tone: 'success',
          title: stringField(creationRaw, ['title']) ?? agentName ?? 'Created',
          detail: text,
          creation: {
            kind: stringField(creationRaw, ['kind']) ?? 'output',
            title: stringField(creationRaw, ['title']),
            count: numberField(creationRaw, ['count']),
            collection: stringField(creationRaw, ['collection']),
            ...(ref ? { ref } : {}),
          },
        };
      }
      const childSessionId = payload.delegate === true ? stringField(payload, ['childSessionId']) : undefined;
      return {
        ...base,
        kind: 'agent',
        tone: phase === 'fail' ? 'danger' : phase === 'complete' ? 'success' : 'accent',
        title: agentName ?? nodeTitle ?? 'Agent update',
        detail: text,
        progress: normalizeProgress(payload.progress),
        ...(childSessionId ? {
          delegate: {
            childSessionId,
            role: stringField(payload, ['role']),
            parentSessionId: stringField(payload, ['parentSessionId']),
          },
        } : {}),
      };
    }
    case REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL: {
      const toolName = tool ?? 'tool call';
      return {
        ...base,
        kind: 'tool',
        tone: 'accent',
        title: agentName ?? 'Tool call',
        detail: toolName,
        tool: toolName,
      };
    }
    case REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE: {
      const message = stringField(payload, ['message', 'text', 'line']);
      if (!message) return null;
      return {
        ...base,
        kind: 'message',
        tone: 'muted',
        title: agentName ?? 'Agent message',
        detail: message,
      };
    }
    case REALTIME_EVENTS.AGENT_STATUS_CHANGED:
      return {
        ...base,
        kind: 'status',
        tone: 'muted',
        title: agentName ?? 'Agent status changed',
        detail: stringField(payload, ['status', 'nextStatus']) ?? 'Status updated.',
      };
    default:
      return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function stringField(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function numberField(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function nestedStringField(source: Record<string, unknown>, key: string, fields: string[]): string | undefined {
  const value = source[key];
  if (!isRecord(value)) return undefined;
  return stringField(value, fields);
}

function failedCriterionReason(source: Record<string, unknown>): string | undefined {
  const verification = source.verification;
  if (!isRecord(verification) || !Array.isArray(verification.criteria)) return undefined;
  const failed = verification.criteria.find((criterion) =>
    isRecord(criterion) && criterion.passed === false);
  return isRecord(failed) ? stringField(failed, ['reason', 'criterion']) : undefined;
}

function normalizeProgress(value: unknown): { completed: number; total: number } | undefined {
  if (!isRecord(value)) return undefined;
  const completed = numberField(value, ['completed', 'done']);
  const total = numberField(value, ['total']);
  if (completed == null || total == null || total <= 0) return undefined;
  return { completed, total };
}



