import { spawn } from 'node:child_process';
import type {
  AgentAdapter,
  AdapterCapabilities,
  AdapterHealthStatus,
  ChatDelta,
  ChatInvocationOptions,
  ChatMessage,
  NormalizedAgentEvent,
  NormalizedTask,
  ToolDefinition,
  RuntimeContext,
  RuntimeDescriptor,
  RuntimeSessionInfo,
} from '@agentis/core';
import type { Logger } from '../logger.js';
import { resolveSpawnCwd, resolveSpawnTarget, withExpandedPath } from '../services/pathExpander.js';
import { buildMarkerToolPrompt } from './markerToolProtocol.js';
import { runtimeAttemptFromSessionKey, toolActivityLabel } from './runtimeProgress.js';
import { linkAbortSignal } from './abort.js';
import {
  chatHardCeilingMs,
  clampChatTimeout,
  DEFAULT_CHAT_TURN_TIMEOUT_MS,
  messagesForRuntimeSession,
  runCliChatTurn,
  type CliChatPart,
} from './cliChatRuntime.js';
import type { RuntimeSessionStore } from '../services/runtime/runtimeSessionStore.js';
import { probeCliRuntime } from './cliRuntimeProbe.js';
import { nativeRuntimeCapabilities } from './runtimeCapabilityDeclarations.js';

export interface CursorAdapterOptions {
  agentId: string;
  binaryPath?: string;
  cwd?: string;
  model?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
  workspaceId?: string;
  sessionStore?: RuntimeSessionStore;
  logger: Logger;
}

export class CursorAdapter implements AgentAdapter {
  readonly adapterType = 'cursor' as const;
  readonly #handlers = new Set<(event: NormalizedAgentEvent) => void>();
  readonly #inFlight = new Map<string, AbortController>();
  readonly #sessions = new Map<string, string>();
  #version: string | null = null;

  constructor(private readonly opts: CursorAdapterOptions) {}

  getWorkdir(): string | undefined { return this.opts.cwd; }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {
    for (const controller of this.#inFlight.values()) controller.abort();
    this.#inFlight.clear();
  }

  async healthCheck(): Promise<AdapterHealthStatus> {
    const result = await probeCliRuntime({
      binary: this.opts.binaryPath || 'agent',
      cwd: this.opts.cwd,
      env: this.opts.env,
      logger: this.opts.logger,
      logTag: 'cursor',
    });
    this.#version = result.version;
    return result.health;
  }

  capabilities(): AdapterCapabilities {
    return {
      interactiveChat: true,
      toolCalling: true,
      toolForwarding: 'marker_protocol',
      execution: {
        longRunning: true,
        pausable: true,
        sandbox: 'process',
        maxConcurrent: 1,
      },
      affordances: {
        codebaseIndex: true,
        fileSystem: true,
        terminal: true,
      },
      memory: {
        ingestible: true,
        injectable: true,
      },
      capabilityManifest: nativeRuntimeCapabilities([
        'interaction.chat',
        'interaction.tool-calling',
        'execution.file-system',
        'execution.terminal',
        'execution.long-running',
        'execution.pausable',
        'workspace.codebase-index',
        'memory.inject',
        'memory.ingest',
      ], {
        limits: { 'execution.long-running': { maxConcurrent: 1 } },
      }),
    };
  }

  async getRuntimeContext(): Promise<RuntimeContext> {
    const currentModel = this.opts.model ?? 'cursor-default';
    return {
      provider: 'cursor',
      models: [{
        id: currentModel,
        label: currentModel,
        source: this.opts.model ? 'agent_config' : 'fallback',
        verified: Boolean(this.opts.model),
      }],
      currentModel,
      currentModelSource: this.opts.model ? 'agent_config' : 'fallback',
      currentModelVerified: Boolean(this.opts.model),
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
        warm: false,
        activeSessions: this.#sessions.size,
      },
    };
  }

  async listRuntimeSessions(): Promise<RuntimeSessionInfo[]> {
    if (this.opts.sessionStore && this.opts.workspaceId) {
      return this.opts.sessionStore.list(this.opts.workspaceId, this.opts.agentId);
    }
    const now = new Date().toISOString();
    return [...this.#sessions.entries()].map(([sessionKey, runtimeSessionId]) => ({
      id: `${this.opts.agentId}:${sessionKey}`,
      sessionKey,
      runtimeSessionId,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    }));
  }

  async closeRuntimeSession(sessionKey: string): Promise<void> {
    this.#sessions.delete(sessionKey);
    if (this.opts.sessionStore && this.opts.workspaceId) {
      this.opts.sessionStore.remove(this.opts.workspaceId, this.opts.agentId, sessionKey);
    }
  }

  onEvent(handler: (event: NormalizedAgentEvent) => void): void {
    this.#handlers.add(handler);
  }

  async dispatchTask(task: NormalizedTask): Promise<void> {
    const controller = new AbortController();
    const unlinkAbort = linkAbortSignal(task.signal, controller);
    this.#inFlight.set(task.taskId, controller);
    const binary = this.opts.binaryPath || 'agent';
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      ...(task.preferredModel || this.opts.model ? [`--model=${task.preferredModel || this.opts.model}`] : []),
      ...(this.opts.extraArgs ?? []),
    ];
    let childProcess: ReturnType<typeof spawn>;
    let terminalEventEmitted = false;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const env = withExpandedPath({ ...process.env, ...(this.opts.env ?? {}) });
      // Isolated per-task directory when the engine allocated one (parallel swarm
      // subtask); otherwise the adapter's single-agent configured cwd. Re-validate
      // (and re-create) it every spawn: a managed home can vanish after the adapter
      // was registered, and a missing cwd makes a present binary throw ENOENT.
      const spawnCwd = resolveSpawnCwd(task.workdir ?? this.opts.cwd, { create: true });
      const target = resolveSpawnTarget(binary, args, spawnCwd ?? process.cwd(), env);
      childProcess = spawn(target.command, target.args, {
        cwd: spawnCwd,
        env,
        windowsHide: true,
        signal: controller.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.#emitFailure(task, `cursor_spawn_failed: ${(err as Error).message}`);
      unlinkAbort();
      this.#inFlight.delete(task.taskId);
      return;
    }

    if (this.opts.timeoutSec && this.opts.timeoutSec > 0) {
      timeout = setTimeout(() => controller.abort(), this.opts.timeoutSec * 1000);
      timeout.unref?.();
    }

    const timestamp = () => new Date().toISOString();
    this.#emit({
      eventType: 'task.started',
      agentId: this.opts.agentId,
      taskId: task.taskId,
      runId: task.runId,
      workflowId: task.workflowId,
      timestamp: timestamp(),
    });

    childProcess.on('error', (err) => {
      if (terminalEventEmitted) return;
      terminalEventEmitted = true;
      this.#emitFailure(task, `cursor_error: ${err.message}`);
      unlinkAbort();
      this.#inFlight.delete(task.taskId);
      if (timeout) clearTimeout(timeout);
    });
    childProcess.stderr?.on('data', (data) =>
      this.opts.logger.warn('cursor.stderr', { data: String(data).slice(0, 512) }),
    );

    let buffer = '';
    let transcript = '';
    let lastOutput: Record<string, unknown> | undefined;
    childProcess.stdout?.on('data', (chunk) => {
      buffer += String(chunk);
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as CursorJsonEvent;
          const text = extractText(event);
          if (text) {
            transcript += text;
            this.#emit({
              eventType: 'task.progress',
              agentId: this.opts.agentId,
              runId: task.runId,
              workflowId: task.workflowId,
              taskId: task.taskId,
              message: text,
              timestamp: timestamp(),
            });
          }
          const toolCall = extractToolCall(event);
          if (toolCall) {
            this.#emit({
              eventType: 'agent.tool_call',
              agentId: this.opts.agentId,
              runId: task.runId,
              workflowId: task.workflowId,
              taskId: task.taskId,
              tool: toolCall.tool,
              input: toolCall.input,
              timestamp: timestamp(),
            });
          }
          if (isCompletionEvent(event)) lastOutput = extractOutput(event, transcript);
        } catch {
          transcript += line + '\n';
          this.#emit({
            eventType: 'task.progress',
            agentId: this.opts.agentId,
            runId: task.runId,
            workflowId: task.workflowId,
            taskId: task.taskId,
            message: line,
            timestamp: timestamp(),
          });
        }
      }
    });

    childProcess.on('exit', (code) => {
      unlinkAbort();
      this.#inFlight.delete(task.taskId);
      if (timeout) clearTimeout(timeout);
      if (terminalEventEmitted) return;
      terminalEventEmitted = true;
      if (code === 0) {
        this.#emit({
          eventType: 'task.completed',
          agentId: this.opts.agentId,
          runId: task.runId,
          workflowId: task.workflowId,
          taskId: task.taskId,
          output: lastOutput ?? { text: transcript.trim() },
          timestamp: timestamp(),
        });
      } else {
        this.#emitFailure(task, `cursor exited ${code}`);
      }
    });

    childProcess.stdin?.end(buildPrompt(task));
  }

  async cancelTask(taskId: string): Promise<void> {
    this.#inFlight.get(taskId)?.abort();
    this.#inFlight.delete(taskId);
  }

  async *chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatInvocationOptions,
  ): AsyncIterable<ChatDelta> {
    const sessionKey = options?.sessionKey?.trim() || 'default';
    const storedSession = this.#sessions.get(sessionKey)
      ?? (this.opts.sessionStore && this.opts.workspaceId
        ? this.opts.sessionStore.get(this.opts.workspaceId, this.opts.agentId, sessionKey)?.runtimeSessionId
        : undefined);
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      ...(options?.preferredModel || this.opts.model ? [`--model=${options?.preferredModel || this.opts.model}`] : []),
      ...(storedSession ? ['--resume', storedSession] : []),
      ...(this.opts.extraArgs ?? []),
    ];
    const configuredTimeoutMs = this.opts.timeoutSec && this.opts.timeoutSec > 0
      ? this.opts.timeoutSec * 1000
      : DEFAULT_CHAT_TURN_TIMEOUT_MS;
    const idleTimeoutMs = clampChatTimeout(options?.timeoutMs ?? configuredTimeoutMs);

    const interpret = (event: unknown): CliChatPart => {
      const ev = event as CursorJsonEvent;
      const sessionId = firstString(ev.session_id, ev.sessionId, objectOf(ev.session)?.id);
      if (sessionId) {
        this.#sessions.set(sessionKey, sessionId);
        if (this.opts.sessionStore && this.opts.workspaceId) {
          this.opts.sessionStore.upsert({
            workspaceId: this.opts.workspaceId,
            agentId: this.opts.agentId,
            conversationId: sessionKey,
            sessionKey,
            runtimeSessionId: sessionId,
            selectedModel: options?.preferredModel ?? this.opts.model ?? null,
            status: 'idle',
          });
        }
      }
      return cursorJsonEventToChatPart(ev);
    };

    yield* runCliChatTurn({
      binary: this.opts.binaryPath ?? 'agent',
      args,
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdin: buildCursorChatPrompt(messagesForRuntimeSession(messages, Boolean(storedSession)), tools),
      displayName: 'Cursor',
      logTag: 'cursor.chat',
      logger: this.opts.logger,
      signal: options?.signal,
      idleTimeoutMs,
      hardCeilingMs: chatHardCeilingMs(idleTimeoutMs, 'AGENTIS_CURSOR_CHAT_HARD_CEILING_MS'),
      activityId: `cursor-cli-${sessionKey}`,
      transport: 'cursor_cli',
      attempt: runtimeAttemptFromSessionKey(sessionKey),
      interpret,
      formatExitError: (_code, stderr, stdoutError) => stdoutError.trim() || stderr.trim(),
    });
  }

  #emit(event: NormalizedAgentEvent): void {
    for (const handler of this.#handlers) {
      try {
        handler(event);
      } catch (err) {
        this.opts.logger.error('cursor.handler_threw', { err: (err as Error).message });
      }
    }
  }

  #emitFailure(task: NormalizedTask, message: string): void {
    this.#emit({
      eventType: 'task.failed',
      agentId: this.opts.agentId,
      runId: task.runId,
      workflowId: task.workflowId,
      taskId: task.taskId,
      error: message,
      timestamp: new Date().toISOString(),
    });
  }
}

type CursorJsonEvent = {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  error?: unknown;
  text?: unknown;
  content?: unknown;
  message?: unknown;
  delta?: unknown;
  item?: unknown;
  result?: unknown;
  output?: unknown;
  tool_call?: unknown;
  call_id?: unknown;
  request_id?: unknown;
  name?: unknown;
  tool?: unknown;
  input?: unknown;
  arguments?: unknown;
  session?: unknown;
  session_id?: unknown;
  sessionId?: unknown;
};

function buildPrompt(task: NormalizedTask): string {
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

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable]';
  }
}

function extractText(event: CursorJsonEvent): string {
  const direct = firstString(event.text, event.content, event.delta);
  if (direct) return direct;
  const message = objectOf(event.message);
  const messageText = firstString(message?.text, message?.content);
  if (messageText) return messageText;
  const choice = Array.isArray((event as { choices?: unknown }).choices)
    ? (event as { choices?: unknown[] }).choices?.[0]
    : null;
  const choiceObject = objectOf(choice);
  const delta = objectOf(choiceObject?.delta);
  const choiceMessage = objectOf(choiceObject?.message);
  const choiceText = firstString(delta?.content, delta?.text, choiceMessage?.content, choiceObject?.text);
  if (choiceText) return choiceText;
  const item = objectOf(event.item);
  return firstString(item?.text, item?.content) ?? '';
}

function extractToolCall(event: CursorJsonEvent): { tool: string; input: unknown } | null {
  const type = String(event.type ?? '').toLowerCase();
  if (!type.includes('tool') && !type.includes('function')) return null;
  const toolCall = objectOf(event.tool_call);
  const item = objectOf(event.item);
  const nested = firstObjectValueWithSuffix(toolCall, 'ToolCall');
  const tool = firstString(
    event.name,
    event.tool,
    toolCall?.name,
    toolCall?.tool,
    item?.name,
    item?.tool,
    nested?.key,
  ) ?? 'tool';
  return {
    tool: prettyToolName(tool),
    input: event.input
      ?? event.arguments
      ?? toolCall?.input
      ?? toolCall?.arguments
      ?? nested?.value?.args
      ?? nested?.value?.arguments
      ?? item?.input
      ?? item?.arguments
      ?? {},
  };
}

function isCompletionEvent(event: CursorJsonEvent): boolean {
  const type = String(event.type ?? '').toLowerCase();
  return type === 'result' || type === 'done' || type.includes('completed') || type.includes('finished');
}

function extractOutput(event: CursorJsonEvent, transcript: string): Record<string, unknown> {
  const result = objectOf(event.result) ?? objectOf(event.output);
  if (result) return result;
  const text = firstString(event.text, event.content) ?? transcript.trim();
  return { text };
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
    if (Array.isArray(value)) {
      const joined = value.map((item) => {
        if (typeof item === 'string') return item;
        const object = objectOf(item);
        return firstString(object?.text, object?.content) ?? '';
      }).join('');
      if (joined) return joined;
    }
  }
  return undefined;
}

export function cursorJsonEventToChatPart(event: CursorJsonEvent): CliChatPart {
  const streamError = cursorStreamError(event);
  if (streamError) return { kind: 'error', message: streamError };
  if (isReasoningEvent(event)) {
    const reasoning = extractText(event);
    return reasoning ? { kind: 'thinking', text: reasoning } : { kind: 'ignore' };
  }
  const toolCall = extractToolCall(event);
  if (toolCall) {
    return {
      kind: 'activity',
      delta: cursorToolActivity(event, toolCall.tool, toolCall.input),
    };
  }
  if (isCompletionEvent(event)) {
    const result = objectOf(event.result) ?? objectOf(event.output);
    const text = firstString(
      event.text,
      event.content,
      event.result,
      event.output,
      result?.text,
      result?.content,
      result?.message,
    );
    return text ? { kind: 'final', text } : { kind: 'ignore' };
  }
  const text = extractText(event);
  if (text) return { kind: 'text', text };
  return { kind: 'ignore' };
}

function cursorStreamError(event: CursorJsonEvent): string | null {
  const type = String(event.type ?? '').toLowerCase();
  const subtype = String(event.subtype ?? '').toLowerCase();
  const flagged = event.is_error === true || type === 'error' || subtype.includes('error');
  if (!flagged) return null;
  const errorObject = objectOf(event.error);
  return firstString(
    errorObject?.message,
    event.error,
    event.message,
    event.result,
    event.output,
    event.text,
  ) ?? 'Cursor reported an error.';
}

function cursorToolActivity(
  event: CursorJsonEvent,
  tool: string,
  input?: unknown,
): Extract<ChatDelta, { type: 'activity' }> {
  const subtype = String(event.subtype ?? '').toLowerCase();
  const failed = /fail|error|cancel/.test(subtype);
  const completed = failed || /complete|success|done|finished/.test(subtype);
  const id = firstString(event.call_id, event.request_id) ?? `cursor-${tool}`;
  return {
    type: 'activity',
    id: `cursor-${id}`,
    phase: 'tool',
    status: failed ? 'error' : completed ? 'success' : 'running',
    label: toolActivityLabel(failed ? 'Failed' : completed ? 'Used' : 'Using', tool, input),
    ...(completed
      ? { completedAt: new Date().toISOString() }
      : { startedAt: new Date().toISOString() }),
  };
}

function firstObjectValueWithSuffix(
  object: Record<string, unknown> | null,
  suffix: string,
): { key: string; value: Record<string, unknown> } | null {
  if (!object) return null;
  for (const [key, value] of Object.entries(object)) {
    const nested = objectOf(value);
    if (nested && key.endsWith(suffix)) {
      return { key: prettyToolName(key.replace(new RegExp(`${suffix}$`), '')), value: nested };
    }
  }
  return null;
}

function prettyToolName(raw: string): string {
  return raw.replace(/^mcp__[^_]+__/, '').replace(/[_-]?tool$/i, '').replace(/[._-]/g, ' ').trim() || 'tool';
}

function buildCursorChatPrompt(messages: ChatMessage[], tools: ToolDefinition[]): string {
  return [
    buildMarkerToolPrompt(tools),
    '',
    'Conversation:',
    formatMessagesForCursor(messages),
  ].join('\n');
}

function formatMessagesForCursor(messages: ChatMessage[]): string {
  return messages.map((message) => {
    const content = typeof message.content === 'string' ? message.content : safeJson(message.content);
    if (message.role === 'tool') {
      return `TOOL RESULT (${message.toolCallId ?? 'unknown'}):\n${content}`;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return [
        'ASSISTANT:',
        content,
        'REQUESTED TOOLS:',
        safeJson(message.toolCalls),
      ].join('\n');
    }
    return `${message.role.toUpperCase()}:\n${content}`;
  }).join('\n\n---\n\n');
}

function isReasoningEvent(event: CursorJsonEvent): boolean {
  const type = String(event.type ?? '').toLowerCase();
  if (type.includes('reason') || type.includes('think')) return true;
  const item = objectOf(event.item);
  const itemType = String(item?.type ?? '').toLowerCase();
  return itemType.includes('reason') || itemType.includes('think');
}
