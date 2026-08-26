import { normalizeToolInvocation, type ChatDelta } from '@agentis/core';
import { redactSecretString } from '../services/security/secretRedaction.js';

type RuntimeActivity = Extract<ChatDelta, { type: 'activity' }>;

export interface RuntimeProgressOptions {
  id: string;
  runtimeName: string;
  text?: string;
  /** A caller-provided status label that is already safe for operators. */
  safeLabel?: string;
  reasoning?: boolean;
  agentId?: string;
  transport?: string;
  attempt?: number;
  /** Stable start time for replace-in-place heartbeat updates. */
  startedAt?: string;
}

/** Build one stable activity row without exposing or paraphrasing model narration. */
export function runtimeProgressActivity(options: RuntimeProgressOptions): RuntimeActivity {
  return {
    type: 'activity',
    id: options.id,
    phase: 'runtime',
    status: 'running',
    label: options.safeLabel?.trim() || (options.reasoning
      ? `${options.runtimeName} is reasoning`
      : `${options.runtimeName} is working`),
    ...(options.reasoning && options.text?.trim()
      ? { detail: clipPublicSummary(redactSecretString(options.text.trim())) }
      : {}),
    startedAt: options.startedAt ?? new Date().toISOString(),
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
  };
}

/** Extract the workflow retry attempt from an isolated native session key. */
export function runtimeAttemptFromSessionKey(sessionKey: string | null | undefined): number | undefined {
  const match = sessionKey?.match(/:attempt:(\d+)$/);
  if (!match) return undefined;
  const attempt = Number(match[1]);
  return Number.isSafeInteger(attempt) && attempt > 0 ? attempt : undefined;
}

function clipPublicSummary(text: string): string {
  return text.length > 1_000 ? `${text.slice(0, 999)}…` : text;
}

/** Tool activity intentionally excludes prompts, commands, paths, and arguments. */
export function toolActivityLabel(verb: 'Using' | 'Used' | 'Failed', name: unknown, input?: unknown): string {
  const invocation = normalizeToolInvocation(name, input);
  return `${verb} ${prettyToolName(invocation.tool)}`;
}

/** Normalize a tool name for display: drop the `mcp__server__` prefix, de-snake. */
export function prettyToolName(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return 'a tool';
  return value.replace(/^mcp__[^_]+__/, '').replace(/[._]/g, ' ').trim() || 'a tool';
}
