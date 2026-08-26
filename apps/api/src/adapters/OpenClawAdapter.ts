/**
 * OpenClawAdapter — bridge Agentis to OpenClaw through OpenClaw's official ACP
 * CLI server (`openclaw acp`).
 *
 * The previous implementation spoke an ad-hoc WebSocket dialect directly to the
 * gateway. OpenClaw's gateway protocol now requires a connect/challenge flow and
 * exposes chat through ACP, so the stable boundary for Agentis is the ACP bridge:
 * initialize -> session/new -> session/prompt with streaming session/update
 * notifications.
 */

import type {
  AgentAdapter,
  AdapterCapabilities,
  AdapterHealthStatus,
  ChatDelta,
  ChatInvocationOptions,
  ChatMessage,
  NormalizedAgentEvent,
  NormalizedTask,
  RuntimeContext,
  RuntimeDescriptor,
  RuntimeSessionInfo,
  ToolDefinition,
  TriggerConfig,
  TriggerListenerHandle,
} from '@agentis/core';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../logger.js';
import {
  AcpClient,
  type AcpModelInfo,
  type AcpSessionUpdate,
} from './acpClient.js';
import {
  chatHardCeilingMs,
  clampChatTimeout,
  createChatQueue,
  DEFAULT_CHAT_TURN_TIMEOUT_MS,
} from './cliChatRuntime.js';
import { probeCliRuntime } from './cliRuntimeProbe.js';
import { runtimeAttemptFromSessionKey, runtimeProgressActivity } from './runtimeProgress.js';
import { nativeRuntimeCapabilities } from './runtimeCapabilityDeclarations.js';
import { buildMarkerToolPrompt, extractMarkerToolCalls } from './markerToolProtocol.js';

const DEFAULT_OPENCLAW_STARTUP_TIMEOUT_MS = 60_000;
const MAX_OPENCLAW_STARTUP_TIMEOUT_MS = 180_000;

export interface OpenClawAdapterOptions {
  agentId: string;
  gatewayUrl: string;
  /** Path to the `openclaw` binary. Falls back to `openclaw` on PATH. */
  binaryPath?: string;
  cwd?: string;
  env?: Record<string, string>;
  model?: string;
  /** Decrypted device token. NEVER persisted in plaintext. */
  deviceToken?: string;
  headers?: Record<string, string>;
  password?: string;
  agentName?: string;
  sessionKeyStrategy?: 'issue' | 'fixed' | 'run';
  sessionKey?: string;
  disableDeviceAuth?: boolean;
  timeoutSec?: number;
  payloadTemplate?: Record<string, unknown>;
  /** Optional: the gateway-side session id/key to bind to. */
  defaultSessionId?: string;
  logger: Logger;
}

export class OpenClawAdapter implements AgentAdapter {
  readonly adapterType = 'openclaw' as const;
  readonly #handlers = new Set<(e: NormalizedAgentEvent) => void>();
  readonly #activeClients = new Map<string, AcpClient>();
  readonly #taskSessionKeys = new Map<string, string>();
  readonly #sessions = new Map<string, {
    runtimeSessionId: string;
    createdAt: string;
    updatedAt: string;
  }>();
  #version: string | null = null;
  #models: AcpModelInfo[] = [];

  constructor(private readonly opts: OpenClawAdapterOptions) {}

  async connect(): Promise<void> {
    // The ACP child is started lazily per turn. This keeps commissioning fast and
    // avoids a long-lived bridge process when the chat is idle.
  }

  async disconnect(): Promise<void> {
    for (const client of this.#activeClients.values()) client.dispose();
    this.#activeClients.clear();
  }

  async healthCheck(): Promise<AdapterHealthStatus> {
    if (!this.opts.gatewayUrl?.trim()) {
      return {
        isHealthy: false,
        checkedAt: new Date().toISOString(),
        error: 'openclaw gatewayUrl is required',
      };
    }
    const result = await probeCliRuntime({
      binary: this.opts.binaryPath || 'openclaw',
      cwd: this.opts.cwd,
      env: this.#bridgeEnv(),
      logger: this.opts.logger,
      logTag: 'openclaw',
    });
    this.#version = result.version;
    return result.health;
  }

  capabilities(): AdapterCapabilities {
    return {
      interactiveChat: true,
      // OpenClaw retains its remote native tools, while Agentis platform calls use
      // the marker protocol when the caller owns the workflow tool loop.
      toolCalling: true,
      toolForwarding: 'marker_protocol',
      execution: {
        longRunning: true,
        pausable: true,
        sandbox: 'none',
      },
      affordances: {
        browser: true,
        computerUse: true,
        terminal: true,
      },
      memory: {
        injectable: true,
      },
      capabilityManifest: nativeRuntimeCapabilities([
        'interaction.chat',
        'execution.terminal',
        'execution.browser',
        'execution.computer-use',
        'execution.long-running',
        'execution.pausable',
        'memory.inject',
      ]),
      limitations: [
        'OpenClaw native tools run inside the gateway and stream through ACP; Agentis platform tools are caller-managed through marker calls.',
      ],
    };
  }

  async getRuntimeContext(): Promise<RuntimeContext> {
    const models = this.#models.length > 0
      ? this.#models.map((model) => ({
        id: model.modelId,
        label: model.name ?? model.modelId,
        source: 'runtime' as const,
        verified: true,
      }))
      : [{ id: 'openclaw-gateway', label: 'OpenClaw Gateway', source: 'fallback' as const, verified: false }];
    return {
      provider: 'openclaw',
      models,
      currentModel: this.opts.model ?? models[0]?.id ?? 'openclaw-gateway',
      currentModelSource: this.opts.model ? 'agent_config' : (this.#models.length ? 'runtime' : 'fallback'),
      currentModelVerified: this.#models.length > 0,
      fastModeSupported: false,
    };
  }

  async describeRuntime(): Promise<Partial<RuntimeDescriptor>> {
    const observedAt = new Date().toISOString();
    return {
      version: this.#version
        ? { value: this.#version, source: 'runtime', observedAt, verified: true }
        : null,
      process: {
        warm: this.#activeClients.size > 0,
        activeSessions: this.#sessions.size,
      },
    };
  }

  async listRuntimeSessions(): Promise<RuntimeSessionInfo[]> {
    return [...this.#sessions.entries()].map(([sessionKey, session]) => ({
      id: `${this.opts.agentId}:${sessionKey}`,
      sessionKey,
      runtimeSessionId: session.runtimeSessionId,
      status: this.#activeClients.has(sessionKey) ? 'active' : 'idle',
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastUsedAt: session.updatedAt,
    }));
  }

  async closeRuntimeSession(sessionKey: string): Promise<void> {
    this.#sessions.delete(sessionKey);
    this.#activeClients.get(sessionKey)?.dispose();
    this.#activeClients.delete(sessionKey);
  }

  async createPersistentListener(trigger: TriggerConfig): Promise<TriggerListenerHandle> {
    return {
      triggerId: trigger.triggerId,
      startedAt: new Date().toISOString(),
      close: async () => {},
    };
  }

  onEvent(handler: (e: NormalizedAgentEvent) => void): void {
    this.#handlers.add(handler);
  }

  async dispatchTask(task: NormalizedTask): Promise<void> {
    const at = () => new Date().toISOString();
    this.#emit({
      eventType: 'task.started',
      agentId: this.opts.agentId,
      taskId: task.taskId,
      runId: task.runId,
      workflowId: task.workflowId,
      timestamp: at(),
    });

    let failed = false;
    let transcript = '';
    const sessionKey = this.#taskSessionKey(task);
    this.#taskSessionKeys.set(task.taskId, sessionKey);
    try {
      for await (const delta of this.#runAcpTurn({
        sessionKey,
        prompt: buildTaskPrompt(task),
        signal: task.signal,
        timeoutMs: this.opts.timeoutSec ? this.opts.timeoutSec * 1000 : undefined,
      })) {
        if (delta.type === 'text') {
          transcript += delta.delta;
          this.#emit({
            eventType: 'task.progress',
            agentId: this.opts.agentId,
            taskId: task.taskId,
            runId: task.runId,
            workflowId: task.workflowId,
            message: delta.delta,
            timestamp: at(),
          });
        } else if (delta.type === 'activity' && delta.phase === 'tool') {
          this.#emit({
            eventType: 'agent.tool_call',
            agentId: this.opts.agentId,
            taskId: task.taskId,
            runId: task.runId,
            workflowId: task.workflowId,
            tool: delta.label,
            input: {},
            timestamp: at(),
          });
        } else if (delta.type === 'tool_result' && delta.error) {
          failed = true;
          this.#emitFailure(task, delta.error);
        }
      }
      if (!failed) {
        this.#emit({
          eventType: 'task.completed',
          agentId: this.opts.agentId,
          taskId: task.taskId,
          runId: task.runId,
          workflowId: task.workflowId,
          output: { text: transcript.trim() },
          timestamp: at(),
        });
      }
    } catch (err) {
      this.#emitFailure(task, (err as Error).message);
    } finally {
      this.#taskSessionKeys.delete(task.taskId);
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    const sessionKey = this.#taskSessionKeys.get(taskId);
    if (sessionKey) {
      this.#activeClients.get(sessionKey)?.dispose();
      this.#activeClients.delete(sessionKey);
    }
  }

  /** Best-effort operator message relay for legacy mirrored-session routes. */
  async sendSessionMessage(args: { sessionId?: string; body: string }): Promise<void> {
    const sessionKey = args.sessionId?.trim() || this.#chatSessionKey(undefined);
    void (async () => {
      try {
        for await (const delta of this.#runAcpTurn({
          sessionKey,
          prompt: args.body,
          timeoutMs: this.opts.timeoutSec ? this.opts.timeoutSec * 1000 : undefined,
        })) {
          if (delta.type === 'tool_result' && delta.error) {
            this.opts.logger.warn('openclaw.session_send_failed', { error: delta.error });
          }
        }
      } catch (err) {
        this.opts.logger.warn('openclaw.session_send_failed', { error: (err as Error).message });
      }
    })();
  }

  async *chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatInvocationOptions,
  ): AsyncIterable<ChatDelta> {
    const sessionKey = this.#chatSessionKey(options?.sessionKey);
    const callerManagedTools = options?.toolMode === 'caller_loop' && tools.length > 0;
    const prompt = callerManagedTools
      ? [buildMarkerToolPrompt(tools, { compact: true }), '', formatChatPrompt(messages)].join('\n')
      : formatChatPrompt(messages);
    yield* this.#runAcpTurn({
      sessionKey,
      prompt,
      callerManagedTools,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
  }

  async *#runAcpTurn(args: {
    sessionKey: string;
    prompt: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    callerManagedTools?: boolean;
  }): AsyncIterable<ChatDelta> {
    const queue = createChatQueue();
    const idleTimeoutMs = clampChatTimeout(args.timeoutMs ?? (this.opts.timeoutSec ? this.opts.timeoutSec * 1000 : DEFAULT_CHAT_TURN_TIMEOUT_MS));
    const hardCeilingMs = chatHardCeilingMs(idleTimeoutMs, 'AGENTIS_OPENCLAW_CHAT_HARD_CEILING_MS');
    const startupTimeoutMs = boundedTimeout(
      process.env.AGENTIS_OPENCLAW_STARTUP_TIMEOUT_MS,
      DEFAULT_OPENCLAW_STARTUP_TIMEOUT_MS,
      MAX_OPENCLAW_STARTUP_TIMEOUT_MS,
    );
    const turnState: OpenClawAcpTurnState = {
      sessionKey: args.sessionKey,
      agentId: this.opts.agentId,
      thoughtText: '',
      toolLabels: new Map(),
      attempt: runtimeAttemptFromSessionKey(args.sessionKey),
    };
    let settled = false;
    let client: AcpClient | undefined;
    let sessionId = '';
    let hardTimer: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    let bufferedAssistantText = '';

    const finish = (deltas: ChatDelta[]) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      for (const delta of deltas) queue.push(delta);
      queue.close();
    };
    const fail = (message: string) => {
      if (client && sessionId) void client.cancel(sessionId);
      finish([
        { type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error: message },
        { type: 'done', finishReason: 'error' },
      ]);
    };

    void (async () => {
      try {
        queue.push({
          type: 'activity',
          id: `openclaw-runtime-${args.sessionKey}`,
          label: 'Starting OpenClaw',
          detail: 'Connecting through openclaw acp.',
          phase: 'runtime',
          status: 'running',
          transport: 'openclaw_acp',
          attempt: turnState.attempt,
          startedAt: new Date().toISOString(),
          agentId: this.opts.agentId,
        });
        client = this.#createClient(args.sessionKey);
        this.#activeClients.set(args.sessionKey, client);
        client.start();
        await withDeadline(client.initialize(), startupTimeoutMs, 'openclaw_handshake_timeout');
        const session = await withDeadline(
          client.sessionNew({ cwd: this.opts.cwd ?? process.cwd(), mcpServers: [] }),
          startupTimeoutMs,
          'openclaw_session_timeout',
        );
        sessionId = session.sessionId;
        if (session.models?.length) this.#models = session.models;
        this.#rememberSession(args.sessionKey, sessionId);
        queue.push({
          type: 'activity',
          id: `openclaw-runtime-${args.sessionKey}`,
          label: 'OpenClaw ready',
          phase: 'runtime',
          status: 'success',
          transport: 'openclaw_acp',
          attempt: turnState.attempt,
          completedAt: new Date().toISOString(),
          agentId: this.opts.agentId,
        });

        hardTimer = setTimeout(
          () => fail(`OpenClaw exceeded the ${Math.round(hardCeilingMs / 1000)} second turn ceiling.`),
          hardCeilingMs,
        );
        hardTimer.unref?.();
        abortHandler = () => fail('OpenClaw request was canceled');
        args.signal?.addEventListener('abort', abortHandler, { once: true });

        const result = await client.sessionPrompt(
          { sessionId, prompt: [{ type: 'text', text: args.prompt }] },
          (update) => {
            const delta = openClawUpdateToDelta(update, turnState);
            if (!delta || settled) return;
            if (args.callerManagedTools && delta.type === 'text') {
              bufferedAssistantText += delta.delta;
            } else {
              queue.push(delta);
            }
          },
        );
        if (args.callerManagedTools) {
          const callerDeltas = openClawCallerManagedDeltas(bufferedAssistantText);
          for (const delta of callerDeltas) queue.push(delta);
          if (callerDeltas.some((delta) => delta.type === 'tool_call')) {
            finish([{ type: 'done', finishReason: 'tool_calls' }]);
            return;
          }
        }
        const finishReason: Extract<ChatDelta, { type: 'done' }>['finishReason'] =
          result.stopReason === 'max_tokens' || result.stopReason === 'max_turn_requests' ? 'max_turns' : 'stop';
        finish([{ type: 'done', finishReason }]);
      } catch (err) {
        fail((err as Error).message);
      } finally {
        if (abortHandler) args.signal?.removeEventListener('abort', abortHandler);
        if (hardTimer) clearTimeout(hardTimer);
        this.#activeClients.delete(args.sessionKey);
        client?.dispose();
      }
    })();

    try {
      yield* queue.iterate();
    } finally {
      if (!settled) {
        if (client && sessionId) void client.cancel(sessionId);
        client?.dispose();
        this.#activeClients.delete(args.sessionKey);
      }
    }
  }

  #createClient(sessionKey: string): AcpClient {
    return new AcpClient({
      command: this.opts.binaryPath || 'openclaw',
      args: this.#acpArgs(sessionKey),
      cwd: this.opts.cwd,
      env: this.#bridgeEnv(),
      logger: this.opts.logger,
      logTag: 'openclaw.acp',
      onPermission: () => null,
    });
  }

  #acpArgs(sessionKey: string): string[] {
    return [
      'acp',
      '--url', this.opts.gatewayUrl,
      '--session', sessionKey,
    ];
  }

  #bridgeEnv(): Record<string, string> {
    const headerToken = openClawTokenFromHeaders(this.opts.headers);
    const headerPassword = this.opts.headers?.['x-openclaw-password'] ?? this.opts.headers?.['X-OpenClaw-Password'];
    return {
      ...(this.opts.env ?? {}),
      OPENCLAW_HIDE_BANNER: this.opts.env?.OPENCLAW_HIDE_BANNER ?? '1',
      OPENCLAW_SUPPRESS_NOTES: this.opts.env?.OPENCLAW_SUPPRESS_NOTES ?? '1',
      ...(this.opts.deviceToken || headerToken ? { OPENCLAW_GATEWAY_TOKEN: this.opts.deviceToken ?? headerToken } : {}),
      ...(this.opts.password || headerPassword ? { OPENCLAW_GATEWAY_PASSWORD: this.opts.password ?? headerPassword } : {}),
    };
  }

  #chatSessionKey(sessionKey: string | undefined): string {
    if (this.opts.defaultSessionId) return this.opts.defaultSessionId;
    if (this.opts.sessionKeyStrategy === 'fixed' && this.opts.sessionKey) return this.opts.sessionKey;
    const leaf = sanitizeSessionSegment(sessionKey ?? 'main');
    const agent = sanitizeSessionSegment(this.opts.agentName ?? this.opts.agentId);
    return `agent:${agent}:${leaf}`;
  }

  #taskSessionKey(task: NormalizedTask): string {
    if (this.opts.sessionKeyStrategy === 'fixed' && this.opts.sessionKey) return this.opts.sessionKey;
    if (this.opts.sessionKeyStrategy === 'run') return `agentis-run-${sanitizeSessionSegment(task.runId)}`;
    const issueId = typeof task.inputData.issueId === 'string' ? task.inputData.issueId : task.runId;
    return `agentis-issue-${sanitizeSessionSegment(issueId)}`;
  }

  #rememberSession(sessionKey: string, runtimeSessionId: string): void {
    const now = new Date().toISOString();
    const existing = this.#sessions.get(sessionKey);
    this.#sessions.set(sessionKey, {
      runtimeSessionId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  #emit(event: NormalizedAgentEvent): void {
    for (const handler of this.#handlers) {
      try {
        handler(event);
      } catch (err) {
        this.opts.logger.error('openclaw.handler_threw', { err: (err as Error).message });
      }
    }
  }

  #emitFailure(task: NormalizedTask, message: string): void {
    this.#emit({
      eventType: 'task.failed',
      agentId: this.opts.agentId,
      taskId: task.taskId,
      runId: task.runId,
      workflowId: task.workflowId,
      error: message,
      timestamp: new Date().toISOString(),
    });
  }
}

/** Convert the buffered ACP assistant response into the same safe marker-call
 * boundary used by the other caller-managed runtimes. Exported so this critical
 * capability path can be tested without starting a real OpenClaw gateway. */
export function openClawCallerManagedDeltas(text: string): ChatDelta[] {
  const { cleaned, calls } = extractMarkerToolCalls(text);
  return [
    ...(cleaned.trim() ? [{ type: 'text' as const, delta: cleaned.trim() }] : []),
    ...calls.map((call) => ({
      type: 'tool_call' as const,
      id: randomUUID(),
      name: call.name,
      args: call.args,
    })),
  ];
}

interface OpenClawAcpTurnState {
  sessionKey: string;
  agentId: string;
  thoughtText: string;
  toolLabels: Map<string, string>;
  attempt?: number;
}

function openClawUpdateToDelta(update: AcpSessionUpdate, state: OpenClawAcpTurnState): ChatDelta | null {
  switch (update.sessionUpdate) {
    case 'agent_thought_chunk': {
      const text = textOf(update.content);
      if (!text) return null;
      state.thoughtText += text;
      return runtimeProgressActivity({
        id: `openclaw-thought-${state.sessionKey}`,
        runtimeName: 'OpenClaw',
        text: state.thoughtText,
        reasoning: true,
        agentId: state.agentId,
        transport: 'openclaw_acp',
        attempt: state.attempt,
      });
    }
    case 'agent_message_chunk': {
      const text = textOf(update.content);
      state.thoughtText = '';
      return text ? { type: 'text', delta: text } : null;
    }
    case 'tool_call': {
      const u = update as { toolCallId?: string; title?: string; kind?: string; status?: string };
      const toolCallId = u.toolCallId ?? `tool-${Math.random().toString(36).slice(2)}`;
      const label = u.title?.trim() || prettyToolName(u.kind) || 'a tool';
      state.toolLabels.set(toolCallId, label);
      return openClawToolActivity(toolCallId, label, u.status ?? 'running', state.attempt);
    }
    case 'tool_call_update': {
      const u = update as { toolCallId?: string; title?: string; status?: string };
      const toolCallId = u.toolCallId ?? `tool-${Math.random().toString(36).slice(2)}`;
      const label = u.title?.trim() || state.toolLabels.get(toolCallId) || 'a tool';
      state.toolLabels.set(toolCallId, label);
      return openClawToolActivity(toolCallId, label, u.status ?? 'running', state.attempt);
    }
    default:
      return null;
  }
}

function openClawToolActivity(
  toolCallId: string,
  label: string,
  rawStatus: string,
  attempt?: number,
): Extract<ChatDelta, { type: 'activity' }> {
  const status = rawStatus.toLowerCase();
  const failed = /fail|error|cancel/.test(status);
  const completed = failed || /complete|success|done|finished/.test(status);
  return {
    type: 'activity',
    id: `openclaw-${toolCallId}`,
    phase: 'tool',
    status: failed ? 'error' : completed ? 'success' : 'running',
    transport: 'openclaw_acp',
    ...(attempt !== undefined ? { attempt } : {}),
    label: failed ? `Failed ${label}` : completed ? `Used ${label}` : `Using ${label}`,
    ...(completed
      ? { completedAt: new Date().toISOString() }
      : { startedAt: new Date().toISOString() }),
  };
}

function formatChatPrompt(messages: ChatMessage[]): string {
  return messages.map((message) => {
    const content = typeof message.content === 'string' ? message.content : safeJson(message.content);
    if (message.role === 'tool') return `TOOL RESULT (${message.toolCallId ?? 'unknown'}):\n${content}`;
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return ['ASSISTANT:', content, 'REQUESTED TOOLS:', safeJson(message.toolCalls)].join('\n');
    }
    return `${message.role.toUpperCase()}:\n${content}`;
  }).join('\n\n');
}

function buildTaskPrompt(task: NormalizedTask): string {
  return [
    `Task: ${task.title}`,
    '',
    task.description,
    '',
    'Input data:',
    safeJson(task.inputData),
    '',
    'Scratchpad snapshot:',
    safeJson(task.scratchpadSnapshot),
  ].join('\n');
}

function sanitizeSessionSegment(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || 'main';
}

function boundedTimeout(raw: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(raw);
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.max(1_000, Math.min(Math.floor(value), maximum));
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${code}: exceeded ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function textOf(content: unknown): string {
  if (content && typeof content === 'object' && 'text' in content) {
    const text = (content as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  }
  return '';
}

function prettyToolName(raw: unknown): string {
  return typeof raw === 'string'
    ? raw.replace(/^mcp__[^_]+__/, '').replace(/[._-]/g, ' ').trim()
    : '';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable]';
  }
}

function openClawTokenFromHeaders(headers: Record<string, string> | undefined): string | undefined {
  const direct = headers?.['x-openclaw-token'] ?? headers?.['X-OpenClaw-Token'];
  if (direct?.trim()) return direct.trim();
  const auth = headers?.authorization ?? headers?.Authorization;
  const match = auth?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}
