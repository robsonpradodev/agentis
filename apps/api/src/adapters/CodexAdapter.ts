/**
 * CodexAdapter — spawn the OpenAI Codex CLI as a child process.
 *
 * The adapter is intentionally protocol-specific rather than a generic HTTP
 * wrapper: operators see Codex as a first-class runtime, while the engine still
 * receives the same NormalizedAgentEvent stream as every other adapter.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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
  RuntimeProfile,
  RuntimeSessionInfo,
  ToolDefinition,
} from '@agentis/core';
import type { Logger } from '../logger.js';
import { resolveSpawnCwd, resolveSpawnTarget, withExpandedPath } from '../services/pathExpander.js';
import { buildMarkerToolPrompt, formatToolManifestAwareness, stripProcessNoise } from './markerToolProtocol.js';
import { harnessMcpArgs, type McpHarnessServer } from '../services/mcp/mcpHarnessSession.js';
import { codexServiceTierArgs } from './codexServiceTier.js';
import { linkAbortSignal } from './abort.js';
import {
  chatHardCeilingMs,
  clampChatTimeout,
  DEFAULT_CHAT_TURN_TIMEOUT_MS,
  messagesForRuntimeSession,
  runCliChatTurn,
  type CliChatPart,
  type CliChatRuntimeConfig,
} from './cliChatRuntime.js';
import { probeCliRuntime } from './cliRuntimeProbe.js';
import { nativeRuntimeCapabilities } from './runtimeCapabilityDeclarations.js';
import type { RuntimeSessionStore } from '../services/runtime/runtimeSessionStore.js';
import { runtimeAttemptFromSessionKey, toolActivityLabel } from './runtimeProgress.js';

const DEFAULT_INTERACTIVE_CHAT_TIMEOUT_MS = 15_000;
const DEFAULT_STRUCTURED_CHAT_TIMEOUT_MS = 30_000;
/** Idle floor for browser-enabled turns, sized to outlast the node_repl 120s boot. */
const BROWSER_BOOT_IDLE_MS = 150_000;

export interface CodexAdapterOptions {
  agentId: string;
  /** Path to the `codex` binary. Falls back to `codex` on PATH. */
  binaryPath?: string;
  /** Working directory the CLI is spawned in. */
  cwd?: string;
  model?: string;
  maxTurns?: number;
  modelReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  fastMode?: boolean;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
  /**
   * Opt in to the harness's NATIVE browser / computer-use. The browser lives in
   * the user's Codex config (the `browser@openai-bundled` plugin + the `node_repl`
   * MCP backend with `BROWSER_USE_*`), which `--ignore-user-config` normally strips
   * for fast, hermetic chat. When this is set, Agentis loads that config instead so
   * the agent can really browse — at the cost of a heavier cold boot (the chat path
   * gives browser turns a longer idle budget to absorb it). Off by default; set only
   * for agents that declare the `browser` affordance. (UNIVERSAL-HARNESS §4/§6.)
   */
  browser?: boolean;
  /** Effective, already-migrated launch policy. Native mode preserves Codex. */
  runtimeProfile?: RuntimeProfile;
  /**
   * Agentis MCP servers to mount so the harness calls Agentis tools natively and
   * runs its own loop in ONE invocation (no marker-protocol re-spawn). When set,
   * `toolForwarding` becomes `mcp_native`. (UNIVERSAL-HARNESS §5.)
   */
  mcpServers?: McpHarnessServer[];
  workspaceId?: string;
  sessionStore?: RuntimeSessionStore;
  logger: Logger;
}

export class CodexAdapter implements AgentAdapter {
  readonly adapterType = 'codex' as const;
  readonly #handlers = new Set<(event: NormalizedAgentEvent) => void>();
  readonly #inFlight = new Map<string, AbortController>();
  readonly #sessions = new Map<string, string>();
  #version: string | null = null;

  constructor(private readonly opts: CodexAdapterOptions) {}

  getWorkdir(): string | undefined { return this.opts.cwd; }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {
    for (const controller of this.#inFlight.values()) controller.abort();
    this.#inFlight.clear();
  }

  async healthCheck(): Promise<AdapterHealthStatus> {
    const result = await probeCliRuntime({
      binary: this.opts.binaryPath ?? 'codex',
      cwd: this.opts.cwd,
      env: this.opts.env,
      logger: this.opts.logger,
      logTag: 'codex',
    });
    this.#version = result.version;
    return result.health;
  }

  #mcpNative(): boolean {
    return (this.opts.mcpServers?.length ?? 0) > 0;
  }

  #browser(): boolean {
    return this.opts.browser === true;
  }

  capabilities(): AdapterCapabilities {
    const mcpNative = this.#mcpNative();
    const browser = this.#browser();
    return {
      interactiveChat: true,
      toolCalling: true,
      toolForwarding: mcpNative ? 'mcp_native' : 'marker_protocol',
      execution: {
        longRunning: true,
        pausable: false,
        sandbox: 'process',
        maxConcurrent: 1,
      },
      affordances: {
        fileSystem: true,
        terminal: true,
        ...(browser ? { browser: true, computerUse: true } : {}),
        ...(mcpNative ? { nativeMcp: true } : {}),
      },
      memory: {
        ingestible: true,
        injectable: true,
      },
      capabilityManifest: nativeRuntimeCapabilities([
        'interaction.chat', 'interaction.tool-calling', 'execution.file-system', 'execution.terminal', 'execution.long-running',
        ...(browser ? ['execution.browser' as const, 'execution.computer-use' as const] : []),
        ...(mcpNative ? ['protocol.native-mcp' as const] : []),
        'memory.inject', 'memory.ingest',
      ], { limits: { 'execution.long-running': { maxConcurrent: 1 } } }),
    };
  }

  async getRuntimeContext(): Promise<RuntimeContext> {
    const configuredModel = this.opts.model?.trim();
    return {
      provider: 'OpenAI',
      models: configuredModel
        ? [{
          id: configuredModel,
          label: configuredModel,
          source: 'agent_config',
          verified: false,
        }]
        : [],
      currentModel: configuredModel ?? 'unknown',
      currentModelSource: configuredModel ? 'agent_config' : 'fallback',
      currentModelVerified: false,
      efforts: [
        { id: 'minimal', label: 'Minimal' },
        { id: 'low', label: 'Low' },
        { id: 'medium', label: 'Medium' },
        { id: 'high', label: 'High' },
        { id: 'xhigh', label: 'Extra High' },
      ],
      currentEffort: this.opts.modelReasoningEffort ?? (this.opts.fastMode ? 'minimal' : undefined),
      fastModeSupported: true,
      fastModeEnabled: this.opts.fastMode ?? false,
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
    const binary = this.opts.binaryPath ?? 'codex';
    const args = buildCodexArgs(this.opts, task.preferredModel);
    let childProcess: ReturnType<typeof spawn>;
    let terminalEventEmitted = false;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const env = withExpandedPath({ ...process.env, ...(this.opts.env ?? {}), ...(task.abilityEnv ?? {}) });
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
      this.#emitFailure(task, `codex_spawn_failed: ${(err as Error).message}`);
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
      this.#emitFailure(task, `codex_error: ${err.message}`);
      unlinkAbort();
      this.#inFlight.delete(task.taskId);
      if (timeout) clearTimeout(timeout);
    });
    let stderrText = '';
    childProcess.stderr?.on('data', (data) => {
      const chunk = String(data);
      stderrText = `${stderrText}${chunk}`.slice(-4096);
      this.opts.logger.warn('codex.stderr', { data: chunk.slice(0, 512) });
    });

    let buffer = '';
    let transcript = '';
    let stdoutError = '';
    let lastOutput: Record<string, unknown> | undefined;
    childProcess.stdout?.on('data', (chunk) => {
      buffer += String(chunk);
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        // The codex stream is JSONL. On Windows, child-process teardown can leak
        // non-JSON OS noise into stdout (e.g. taskkill's "ÊXITO: o processo com PID
        // … foi finalizado."). Such a line is not a malformed event — skip it
        // silently; only a line that LOOKS like JSON but won't parse is worth a warn.
        if (line[0] !== '{' && line[0] !== '[') continue;
        try {
          const event = JSON.parse(line) as CodexJsonEvent;
          stdoutError = extractCodexError(event) ?? stdoutError;
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
          // Reasoning: the dispatch path historically surfaced only answer text +
          // tools, never the agent's THINKING — so a dispatched (mcp_native) Codex
          // agent_task was thinner than chat. Emit reasoning via the same
          // interpreter chat uses (guarded to `reasoning` so it can't double with
          // the text/tool emits above). (Reasoning parity, all harnesses.)
          const interp = interpretCodexChatEvent(event);
          if (interp.kind === 'commentary' && interp.text) {
            this.#emit({
              eventType: 'agent.thinking',
              agentId: this.opts.agentId,
              runId: task.runId,
              workflowId: task.workflowId,
              taskId: task.taskId,
              text: interp.text,
              timestamp: timestamp(),
            });
          }
          if (isCompletionEvent(event)) {
            lastOutput = extractOutput(event, transcript);
          }
        } catch {
          this.opts.logger.warn('codex.malformed_jsonl', { line: line.slice(0, 256) });
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
        this.#emitFailure(task, formatCodexExitError(code, stderrText, stdoutError));
      }
    });

    childProcess.stdin?.end(buildCodexPrompt(task));
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
    const interactive = options?.latencyClass === 'interactive';
    const structured = options?.latencyClass === 'structured';
    const callerOwnsToolLoop = options?.toolMode === 'caller_loop';
    const execMode = options?.executionMode ?? 'chat';
    const explicitQuality = options?.reasoningEffort || options?.fastMode !== undefined
      ? {
          ...(options?.reasoningEffort ? { reasoningEffort: options.reasoningEffort as CodexAdapterOptions['modelReasoningEffort'] } : {}),
          ...(options?.fastMode !== undefined ? { fastMode: options.fastMode } : {}),
          mountMcp: !callerOwnsToolLoop,
          executionMode: execMode,
          conversationId: options?.conversationId,
          turnLease: options?.turnLease,
          approvalSensitivity: options?.approvalSensitivity,
        }
      : null;
    const baseArgs = buildCodexArgs(this.opts, options?.preferredModel, explicitQuality ?? (interactive
      // `minimal` is rejected when Codex built-ins such as web_search or
      // image_gen are available. `low` is the fastest universally compatible
      // interactive profile.
      ? { reasoningEffort: 'low', fastMode: true, mountMcp: !callerOwnsToolLoop, executionMode: execMode, conversationId: options?.conversationId, turnLease: options?.turnLease, approvalSensitivity: options?.approvalSensitivity }
      : structured
        ? { reasoningEffort: 'medium', fastMode: true, mountMcp: !callerOwnsToolLoop, executionMode: execMode, conversationId: options?.conversationId, turnLease: options?.turnLease, approvalSensitivity: options?.approvalSensitivity }
        : { mountMcp: !callerOwnsToolLoop, executionMode: execMode, conversationId: options?.conversationId, turnLease: options?.turnLease, approvalSensitivity: options?.approvalSensitivity }));
    const imageArgs = (options?.inputAttachments ?? [])
      .filter((attachment) => attachment.kind === 'image')
      .flatMap((attachment) => ['--image', attachment.path]);
    const args = storedSession
      ? ['exec', 'resume', storedSession, ...baseArgs.slice(1), ...imageArgs]
      : [...baseArgs, ...imageArgs];
    // IDLE-based budget, not wall-clock (see cliChatRuntime). Browser turns load
    // the heavy native config (node_repl has a 120s startup), which is silent —
    // give them a longer idle floor or the watchdog kills the boot before the
    // first browser event ever streams.
    const configuredTimeoutMs = this.opts.timeoutSec && this.opts.timeoutSec > 0
      ? this.opts.timeoutSec * 1000
      : interactive
        ? DEFAULT_INTERACTIVE_CHAT_TIMEOUT_MS
        : structured
          ? DEFAULT_STRUCTURED_CHAT_TIMEOUT_MS
        : DEFAULT_CHAT_TURN_TIMEOUT_MS;
    const baseIdleMs = clampChatTimeout(options?.timeoutMs ?? configuredTimeoutMs);
    const idleTimeoutMs = this.#browser() ? Math.max(baseIdleMs, BROWSER_BOOT_IDLE_MS) : baseIdleMs;

    // Every event `type` we saw — logged if the turn captured no text, so a future
    // Codex CLI schema change surfaces immediately instead of silent empty replies.
    const seenTypes = new Set<string>();
    const interpret = (event: unknown): CliChatPart[] => {
      const ev = event as CodexJsonEvent;
      const envelope = objectOf(ev.msg) ?? ev;
      const runtimeSessionId = firstString(
        envelope.thread_id,
        envelope.threadId,
        ev.thread_id,
        ev.threadId,
      );
      if (runtimeSessionId) {
        this.#sessions.set(sessionKey, runtimeSessionId);
        if (this.opts.sessionStore && this.opts.workspaceId) {
          this.opts.sessionStore.upsert({
            workspaceId: this.opts.workspaceId,
            agentId: this.opts.agentId,
            conversationId: sessionKey,
            sessionKey,
            runtimeSessionId,
            selectedModel: options?.preferredModel ?? this.opts.model ?? null,
            status: 'idle',
          });
        }
      }
      seenTypes.add(String(envelope.type ?? '').toLowerCase() || '(none)');
      const parts: CliChatPart[] = [];
      const usage = codexUsage(envelope.usage ?? ev.usage);
      if (usage) parts.push({ kind: 'usage', ...usage });
      const error = extractCodexError(ev);
      if (error) parts.push({ kind: 'error', message: error });
      const interp = interpretCodexChatEvent(ev);
      switch (interp.kind) {
        case 'commentary':
          parts.push({ kind: 'commentary', id: interp.id, text: interp.text, source: 'reasoning_summary' });
          break;
        case 'text':
          parts.push({ kind: 'text', text: interp.text, ...(interp.id ? { id: interp.id } : {}) });
          break;
        case 'final':
          parts.push({ kind: 'final', text: interp.text });
          break;
        case 'activity':
          // The harness's own shell/tool actions, surfaced live as progress.
          parts.push({ kind: 'activity', delta: interp.delta });
          break;
        case 'tool':
          parts.push({ kind: 'tool', name: interp.tool, args: interp.input });
          break;
        case 'ignore':
          break;
      }
      return parts;
    };

    let runtimeConfig: CliChatRuntimeConfig = {
      binary: this.opts.binaryPath ?? 'codex',
      args,
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdin: buildCodexChatPrompt(messages, tools, this.#mcpNative() && !callerOwnsToolLoop, Boolean(storedSession), callerOwnsToolLoop),
      displayName: 'Codex',
      logTag: 'codex.chat',
      logger: this.opts.logger,
      tools,
      signal: options?.signal,
      idleTimeoutMs,
      hardCeilingMs: chatHardCeilingMs(idleTimeoutMs, 'AGENTIS_CODEX_CHAT_HARD_CEILING_MS'),
      activityId: `codex-cli-${sessionKey}`,
      transport: 'codex_cli',
      attempt: runtimeAttemptFromSessionKey(sessionKey),
      interpret,
      formatExitError: (code, stderr, stdoutErr) => formatCodexExitError(code, stderr, stdoutErr),
      onEmptyResult: () => this.opts.logger.warn('codex.chat.no_output_parsed', { types: [...seenTypes].slice(0, 40) }),
    };
    let cacheRecoveryUsed = false;
    let sessionRecoveryUsed = false;
    for (;;) {
      let retry = false;
      let retryReason: 'model_cache' | 'stale_session' | null = null;
      for await (const delta of runCliChatTurn(runtimeConfig)) {
        if (storedSession && !sessionRecoveryUsed && delta.type === 'tool_result' && delta.id === 'adapter'
          && delta.name === 'adapter.chat' && typeof delta.error === 'string'
          && isCodexSessionResumeFailure(delta.error)) {
          sessionRecoveryUsed = true;
          retry = true;
          retryReason = 'stale_session';
          this.#sessions.delete(sessionKey);
          if (this.opts.sessionStore && this.opts.workspaceId) {
            this.opts.sessionStore.remove(this.opts.workspaceId, this.opts.agentId, sessionKey);
          }
          runtimeConfig = {
            ...runtimeConfig,
            args: [...baseArgs, ...imageArgs],
            stdin: buildCodexChatPrompt(messages, tools, this.#mcpNative() && !callerOwnsToolLoop, false, callerOwnsToolLoop),
          };
          this.opts.logger.warn('codex.chat.stale_session_recovered', { sessionKey });
          continue;
        }
        if (!cacheRecoveryUsed && delta.type === 'tool_result' && delta.id === 'adapter'
          && delta.name === 'adapter.chat' && typeof delta.error === 'string'
          && isCodexModelCacheFailure(delta.error)) {
          const recovered = recoverCodexModelCache();
          if (recovered) {
            cacheRecoveryUsed = true;
            retry = true;
            retryReason = 'model_cache';
            yield {
              type: 'activity', id: 'codex-model-cache-recovery', phase: 'runtime', status: 'running',
              label: 'Refreshing incompatible Codex model cache',
              detail: `Quarantined ${recovered}; retrying this turn once.`,
            };
            continue;
          }
        }
        if (retry && delta.type === 'done') continue;
        yield delta;
      }
      if (!retry) return;
      yield retryReason === 'stale_session'
        ? {
            type: 'activity', id: 'codex-session-recovery', phase: 'runtime', status: 'running',
            label: 'Refreshing the conversation runtime', detail: 'The saved runtime session was unavailable; retrying this turn once in a fresh session.',
          }
        : {
            type: 'activity', id: 'codex-model-cache-recovery', phase: 'runtime', status: 'success',
            label: 'Codex model cache refreshed', detail: 'Retrying the original request with a fresh model catalogue.',
          };
    }
  }

  #emit(event: NormalizedAgentEvent): void {
    for (const handler of this.#handlers) {
      try {
        handler(event);
      } catch (err) {
        this.opts.logger.error('codex.handler_threw', { err: (err as Error).message });
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

/** A persisted Codex thread can disappear after an upgrade, cleanup, or runtime switch. */
export function isCodexSessionResumeFailure(detail: string): boolean {
  return /(?:thread|session|conversation).{0,80}(?:not found|does not exist|missing|unavailable|failed to (?:load|resume))/iu.test(detail)
    || /failed to resume/iu.test(detail);
}

function buildCodexArgs(
  opts: CodexAdapterOptions,
  preferredModel?: string | null,
  options: {
    omitModel?: boolean;
    reasoningEffort?: CodexAdapterOptions['modelReasoningEffort'];
    fastMode?: boolean;
    mountMcp?: boolean;
    executionMode?: 'chat' | 'plan' | 'ask';
    conversationId?: string;
    turnLease?: string;
    approvalSensitivity?: import('@agentis/core').ApprovalSensitivity;
  } = {},
): string[] {
  const fastMode = options.fastMode ?? opts.fastMode ?? false;
  const reasoningEffort = options.reasoningEffort ?? opts.modelReasoningEffort ?? (fastMode ? 'minimal' : undefined);
  const fastModeArgs = fastMode ? ['-c', 'service_tier="fast"', '-c', 'features.fast_mode=true'] : [];
  // Runtime profiles default locally attached agents to native parity. The
  // legacy environment switch remains a compatibility override, but it no longer
  // silently strips a healthy user's skills/plugins/project configuration.
  // Headless isolation is still available through the explicit hermetic profile.
  // Agentis drives Codex as a server subprocess,
  // but `~/.codex/config.toml` is authored for INTERACTIVE desktop use: it mounts
  // plugins (github/browser), a `node_repl` MCP server (120s startup timeout), and
  // the `openai-bundled` "apps" marketplace. Loaded on every `codex exec` spawn,
  // those cold-start child processes and reach the ChatGPT apps backend
  // (`.../wham/apps`) + model-manager refresh — which time out ("failed to refresh
  // available models: timeout waiting for child process to exit", rmcp worker quit)
  // and burn the WHOLE turn budget before the model runs, so workflow synthesis and
  // even plain chat fail (finishReason=error) regardless of how capable the model
  // is. `--ignore-user-config` skips that file entirely; auth still resolves from
  // CODEX_HOME, and everything Agentis needs (model, sandbox bypass, reasoning,
  // service tier, its own MCP server) is supplied explicitly below via flags/`-c`,
  // which apply on top of defaults independent of this flag. Opt back in (rare —
  // e.g. a custom `[model_providers.*]` endpoint in config.toml) with
  // AGENTIS_CODEX_LOAD_USER_CONFIG=true.
  // Browser-enabled agents (`opts.browser`) deliberately load the user config so
  // the `browser@openai-bundled` plugin + `node_repl` browser backend are present
  // — that is the whole point of the opt-in, and the only place the native browser
  // lives.
  const profile = opts.runtimeProfile;
  const browser = profile?.browser === 'enabled'
    || (profile?.browser === 'inherit' && opts.browser === true)
    || (!profile && opts.browser === true);
  const loadUserConfig = profile
    ? profile.mode === 'native' && profile.inheritUserConfig
    : browser || String(
    opts.env?.AGENTIS_CODEX_LOAD_USER_CONFIG ?? process.env.AGENTIS_CODEX_LOAD_USER_CONFIG ?? '',
  ).toLowerCase() === 'true';
  const mcpArgs = options.mountMcp === false
    // Keep the user's configured MCP servers (e.g. `node_repl`, the browser
    // backend) when the browser is opted in; only disable them when loading the
    // config purely for a custom provider, where they would be dead-weight boots.
    ? (loadUserConfig && !browser ? disableConfiguredMcpArgs(opts) : [])
    : harnessMcpArgs('codex', opts.mcpServers ?? [], options.executionMode ?? 'chat', {
        conversationId: options.conversationId,
        turnLease: options.turnLease,
        approvalSensitivity: options.approvalSensitivity,
      });
  // Honor the model Agentis resolved for this agent/turn. With the user config
  // ignored the CLI no longer reads `model` from config.toml, so we MUST pass it
  // ourselves — and this is also the fix for the agent model picker being silently
  // dropped on ChatGPT-authenticated Codex (no API key → the old `canForceCodexModel`
  // gate skipped `--model`, so the CLI fell back to config.toml's default model
  // instead of the one the operator selected). `-m/--model` is honored under both
  // API-key and ChatGPT auth as long as the account has access to the model.
  const model = options.omitModel ? null : resolveCodexModel(preferredModel || opts.model || null, opts.env);
  return [
    'exec',
    '--json',
    ...(loadUserConfig && profile?.profileName ? [`--profile=${profile.profileName}`] : []),
    // See the headless-isolation note above.
    ...(loadUserConfig ? [] : ['--ignore-user-config']),
    ...(model ? [`--model=${model}`] : []),
    ...(reasoningEffort ? ['-c', `model_reasoning_effort="${reasoningEffort}"`] : []),
    ...fastModeArgs,
    // Self-heal a version-skewed `service_tier` in the user's config.toml that
    // would otherwise hard-fail the CLI at load (e.g. "default" → unknown variant).
    // Only relevant when that file is actually loaded; `--ignore-user-config`
    // already sidesteps the bad value, so skip the override there.
    ...(loadUserConfig ? codexServiceTierArgs(opts.env) : []),
    // Agentis drives Codex autonomously — there is NEVER a human at the keyboard to
    // answer an approval prompt, and Codex's OS sandbox is unsupported on Windows.
    // Without bypassing both, `codex exec` blocks on stdin ("Reading prompt from
    // stdin...") until the turn times out and is killed → finishReason=error, empty
    // chat. This mirrors ClaudeCodeAdapter's hardcoded `--dangerously-skip-permissions`.
    // Don't refuse / prompt when the workspace cwd isn't a git repo.
    '--skip-git-repo-check',
    ...codexPermissionArgs(profile?.permissionProfile ?? 'trusted_local'),
    // Mount Agentis tools over MCP so the harness runs its own loop natively.
    ...mcpArgs,
    ...(opts.extraArgs ?? []),
  ];
}

function codexPermissionArgs(profile: RuntimeProfile['permissionProfile']): string[] {
  if (profile === 'read_only') return ['--sandbox=read-only', '--ask-for-approval=never'];
  if (profile === 'workspace_write') return ['--sandbox=workspace-write', '--ask-for-approval=never'];
  // trusted_local preserves legacy behavior. externally_sandboxed is safe to
  // bypass because the enclosing runner, not Codex, owns the sandbox boundary.
  return ['--dangerously-bypass-approvals-and-sandbox'];
}

function disableConfiguredMcpArgs(opts: CodexAdapterOptions): string[] {
  const explicitHome = opts.env?.CODEX_HOME ?? process.env.CODEX_HOME;
  const candidates = [
    resolve(opts.cwd ?? process.cwd(), '.codex', 'config.toml'),
    explicitHome?.trim()
      ? join(explicitHome, 'config.toml')
      : join(homedir(), '.codex', 'config.toml'),
  ];
  const names = new Set<string>();
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const config = readFileSync(path, 'utf8');
      for (const match of config.matchAll(/^\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))(?:\.|\])/gm)) {
        const name = match[1] ?? match[2];
        if (name) names.add(name);
      }
    } catch {
      // A missing/unreadable optional config must not prevent chat startup.
    }
  }
  return [...names].flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]);
}

type CodexJsonEvent = {
  type?: unknown;
  thread_id?: unknown;
  threadId?: unknown;
  /** Modern `codex exec --json` envelope: `{ id, msg: { type, ... } }`. */
  msg?: unknown;
  text?: unknown;
  summary?: unknown;
  content?: unknown;
  message?: unknown;
  delta?: unknown;
  item?: unknown;
  result?: unknown;
  output?: unknown;
  error?: unknown;
  name?: unknown;
  tool?: unknown;
  input?: unknown;
  arguments?: unknown;
  usage?: unknown;
};

function buildCodexPrompt(task: NormalizedTask): string {
  return [
    `Task: ${task.title}`,
    '',
    task.description,
    formatToolManifestAwareness(task.toolManifest),
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

function extractText(event: CodexJsonEvent): string {
  // Modern envelope: only the FULL assistant message is progress text. Streaming
  // deltas, reasoning, tool, and completion events are handled elsewhere — never
  // here — so the answer is captured exactly once (no delta/full doubling).
  const msg = objectOf(event.msg);
  if (msg) {
    const type = String(msg.type ?? '').toLowerCase();
    if (type === 'agent_message' || type === 'agent_message_complete') {
      return firstString(msg.message, msg.text, msg.content) ?? '';
    }
    return '';
  }
  const direct = firstString(event.text, event.content, event.delta);
  if (direct) return direct;
  const message = objectOf(event.message);
  const messageText = firstString(message?.text, message?.content);
  if (messageText) return messageText;
  const item = objectOf(event.item);
  return firstString(item?.text, item?.content) ?? '';
}

type CodexChatInterpretation =
  | { kind: 'text'; text: string; id?: string }
  | { kind: 'final'; text: string }
  | { kind: 'commentary'; id: string; text: string }
  | { kind: 'tool'; tool: string; input: unknown }
  | { kind: 'activity'; delta: Extract<ChatDelta, { type: 'activity' }> }
  | { kind: 'ignore' };

/**
 * Classify one `codex exec --json` event for the chat loop. Handles THREE wire
 * formats so chat survives CLI upgrades:
 *
 * 1. The **0.138+ Responses schema** — top-level `item.*` / `turn.*` /
 *    `thread.*`, with the real kind nested in `item.type`
 *    (`agent_message`, `reasoning`, `command_execution`, tool/mcp/file items).
 *    Checked FIRST: these carry no `msg` envelope, so the old branch below would
 *    silently drop every shell command and surface the answer only by a lucky
 *    `item.text` fallback — the "no realtime thinking / 90s blind timeout" bug.
 * 2. The **modern `msg` envelope** `{ id, msg: { type, ... } }` (codex-rs ≤0.137).
 * 3. The **legacy flat shape** `{ type: 'assistant', text }` the older tests use.
 *
 * The harness's OWN shell/tool actions become `activity` deltas (visible, live)
 * rather than `tool_call` deltas — Agentis must never re-execute what the harness
 * already ran. Only `agent_message` → text and `reasoning` → thinking; the final
 * answer is taken once (on `*.completed`) so streamed partials never double it.
 */
function interpretCodexChatEvent(event: CodexJsonEvent): CodexChatInterpretation {
  const topType = String(event.type ?? '').toLowerCase();
  if (topType.startsWith('item.') || topType.startsWith('turn.') || topType.startsWith('thread.')) {
    const item = objectOf(event.item);
    if (!item) {
      // Some Codex builds emit the completed reasoning summary directly as
      // `{ type: "item.reasoning", text: "..." }` instead of nesting it in an
      // `item.completed` envelope. It is still provider-designated commentary,
      // not raw token-level chain-of-thought.
      if ((topType.includes('reason') || topType.includes('think')) && !topType.includes('delta')) {
        const text = firstString(event.summary, event.text, event.content) ?? '';
        const id = firstString((event as unknown as Record<string, unknown>).id) ?? randomUUID();
        return text ? { kind: 'commentary', id: `codex-commentary-${id}`, text } : { kind: 'ignore' };
      }
      return { kind: 'ignore' }; // turn.started / turn.completed / thread.started
    }
    const itemType = String(item.type ?? '').toLowerCase();
    const completed = topType.endsWith('.completed');
    const started = topType.endsWith('.started');

    if (itemType.includes('reason') || itemType.includes('think')) {
      // Consolidated reasoning, taken once so streamed partials don't double it.
      if (!completed) return { kind: 'ignore' };
      const text = firstString(item.summary, item.text, item.content) ?? '';
      return text ? { kind: 'commentary', id: `codex-commentary-${String(item.id ?? randomUUID())}`, text } : { kind: 'ignore' };
    }
    if (itemType === 'agent_message' || itemType === 'assistant_message' || itemType === 'message') {
      if (!completed) return { kind: 'ignore' };
      const text = firstString(item.text, item.message, item.content) ?? '';
      return text ? { kind: 'text', text, id: String(item.id ?? randomUUID()) } : { kind: 'ignore' };
    }
    if (itemType.includes('command') || itemType.includes('shell') || itemType.includes('exec')) {
      // Codex's OWN shell command (it runs autonomously under sandbox bypass).
      // Surface as a live step — NEVER an executable tool_call.
      return { kind: 'activity', delta: codexCommandActivity(item, started) };
    }
    if (
      itemType.includes('tool') || itemType.includes('function') || itemType.includes('mcp')
      || itemType.includes('web_search') || itemType.includes('search')
      || itemType.includes('file') || itemType.includes('patch')
    ) {
      return { kind: 'activity', delta: codexItemActivity(item, itemType, started) };
    }
    return { kind: 'ignore' };
  }

  const msg = objectOf(event.msg);
  if (msg) {
    const type = String(msg.type ?? '').toLowerCase();
    if (type === 'agent_message' || type === 'agent_message_complete') {
      return {
        kind: 'text',
        text: firstString(msg.message, msg.text, msg.content) ?? '',
        id: firstString((event as unknown as Record<string, unknown>).id, msg.id) ?? randomUUID(),
      };
    }
    if (type === 'task_complete') {
      return { kind: 'final', text: firstString(msg.last_agent_message, msg.message) ?? '' };
    }
    if (type.includes('reason') || type.includes('think')) {
      // Take the consolidated reasoning event, not the per-token deltas.
      if (type.includes('delta')) return { kind: 'ignore' };
      const text = firstString(msg.summary, msg.text, msg.message, msg.content) ?? '';
      const eventId = firstString((event as unknown as Record<string, unknown>).id, msg.id);
      return text ? { kind: 'commentary', id: `codex-commentary-${eventId ?? randomUUID()}`, text } : { kind: 'ignore' };
    }
    if ((type.includes('tool') || type.includes('function')) && (type.includes('begin') || type.includes('call') || type.includes('start'))) {
      const inv = objectOf(msg.invocation) ?? objectOf(msg.tool_call);
      const tool = firstString(inv?.tool, inv?.name, msg.tool, msg.name) ?? 'tool';
      return { kind: 'tool', tool, input: inv?.arguments ?? inv?.input ?? msg.arguments ?? msg.input ?? {} };
    }
    // agent_message_delta, token_count, task_started, exec_command_*, etc.
    return { kind: 'ignore' };
  }
  // Legacy / non-envelope events: {"type":"assistant","text":"..."} and friends.
  if (isReasoningEvent(event)) {
    const reasoning = extractText(event);
    return reasoning ? { kind: 'commentary', id: `codex-commentary-${firstString((event as unknown as Record<string, unknown>).id) ?? randomUUID()}`, text: reasoning } : { kind: 'ignore' };
  }
  const toolCall = extractToolCall(event);
  if (toolCall) return { kind: 'tool', tool: toolCall.tool, input: toolCall.input };
  const text = extractText(event);
  return text ? { kind: 'text', text } : { kind: 'ignore' };
}

/** A live activity step for one of Codex's own shell command executions. */
function codexCommandActivity(
  item: Record<string, unknown>,
  started: boolean,
): Extract<ChatDelta, { type: 'activity' }> {
  const id = `codex-${String(item.id ?? randomUUID())}`;
  const pretty = prettyCommand(firstString(item.command, item.cmd, item.input) ?? 'command');
  if (started) {
    return { type: 'activity', id, phase: 'tool', status: 'running', label: `Running ${pretty}`, startedAt: new Date().toISOString() };
  }
  const exit = typeof item.exit_code === 'number' ? item.exit_code : null;
  const failed = item.status === 'failed' || (exit !== null && exit !== 0);
  const out = firstString(item.aggregated_output, item.output);
  const detail = out ? clipText(stripProcessNoise(out).trim(), 240) : undefined;
  return {
    type: 'activity', id, phase: 'tool', status: failed ? 'error' : 'success',
    label: `Ran ${pretty}`, ...(detail ? { detail } : {}), completedAt: new Date().toISOString(),
  };
}

/** A live activity step for a non-shell Codex item (tool / mcp / file / search). */
function codexItemActivity(
  item: Record<string, unknown>,
  itemType: string,
  started: boolean,
): Extract<ChatDelta, { type: 'activity' }> {
  const id = `codex-${String(item.id ?? randomUUID())}`;
  const inv = objectOf(item.invocation) ?? objectOf(item.tool_call);
  const name = firstString(inv?.tool, inv?.name, item.name, item.tool) ?? humanizeCodexItemType(itemType);
  const input = inv?.arguments ?? inv?.input ?? item.arguments ?? item.input;
  const failed = item.status === 'failed' || Boolean(item.error);
  const verb = started ? 'Using' : 'Used';
  return {
    type: 'activity', id, phase: 'tool',
    status: started ? 'running' : failed ? 'error' : 'success',
    label: toolActivityLabel(failed ? 'Failed' : verb, name, input),
    ...(started ? { startedAt: new Date().toISOString() } : { completedAt: new Date().toISOString() }),
  };
}

/** Reduce a spawned command to the meaningful part (drop the shell wrapper). */
function prettyCommand(raw: string): string {
  let cmd = raw.trim();
  cmd = cmd.replace(/^"[^"]*"\s+/, '');                                              // quoted interpreter path
  cmd = cmd.replace(/^\S*[\\/](?:powershell|pwsh|bash|zsh|cmd|sh)(?:\.exe)?\s+/i, ''); // unquoted interpreter path
  cmd = cmd.replace(/^(?:powershell|pwsh|bash|zsh|cmd|sh)(?:\.exe)?\s+/i, '');        // bare interpreter
  cmd = cmd.replace(/^-(?:Command|c|lc|EncodedCommand)\s+/i, '');                     // shell command flag
  cmd = cmd.replace(/^(['"])([\s\S]*)\1$/, '$2');                                     // unwrap a fully-quoted command
  cmd = cmd.replace(/\s+/g, ' ').trim() || raw.trim();
  return clipText(cmd, 320);
}

function humanizeCodexItemType(itemType: string): string {
  if (itemType.includes('web_search') || itemType.includes('search')) return 'web search';
  if (itemType.includes('file') || itemType.includes('patch')) return 'a file change';
  if (itemType.includes('mcp')) return 'an MCP tool';
  return 'a tool';
}

function clipText(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function extractToolCall(event: CodexJsonEvent): { tool: string; input: unknown } | null {
  const msg = objectOf(event.msg);
  if (msg) {
    const type = String(msg.type ?? '').toLowerCase();
    if ((type.includes('tool') || type.includes('function')) && (type.includes('begin') || type.includes('call') || type.includes('start'))) {
      const inv = objectOf(msg.invocation) ?? objectOf(msg.tool_call);
      const tool = firstString(inv?.tool, inv?.name, msg.tool, msg.name) ?? 'tool';
      return { tool, input: inv?.arguments ?? inv?.input ?? msg.arguments ?? msg.input ?? {} };
    }
    return null;
  }
  const type = String(event.type ?? '').toLowerCase();
  if (!type.includes('tool') && !type.includes('function')) return null;
  const item = objectOf(event.item);
  const tool = firstString(event.name, event.tool, item?.name, item?.tool) ?? 'tool';
  return { tool, input: event.input ?? event.arguments ?? item?.input ?? item?.arguments ?? {} };
}

function isCompletionEvent(event: CodexJsonEvent): boolean {
  const type = String((objectOf(event.msg) ?? event).type ?? '').toLowerCase();
  return type === 'result' || type === 'done' || type === 'task_complete' || type.includes('completed') || type.includes('finished');
}

/**
 * Whether a Codex JSONL event carries chain-of-thought rather than the final
 * answer. Routed to `thinking` deltas so the UI renders it in the collapsible
 * generic progress channel instead of the answer body. Deliberately conservative so the
 * plain `{"type":"assistant"}` message contract is unaffected.
 */
function isReasoningEvent(event: CodexJsonEvent): boolean {
  const type = String(event.type ?? '').toLowerCase();
  if (type.includes('reason') || type.includes('think')) return true;
  const item = objectOf(event.item);
  const itemType = String(item?.type ?? '').toLowerCase();
  return itemType.includes('reason') || itemType.includes('think');
}

function extractOutput(event: CodexJsonEvent, transcript: string): Record<string, unknown> {
  const msg = objectOf(event.msg);
  if (msg) {
    const text = firstString(msg.last_agent_message, msg.message, msg.text) ?? transcript.trim();
    return { text };
  }
  const result = objectOf(event.result) ?? objectOf(event.output);
  if (result) return result;
  const text = firstString(event.text, event.content) ?? transcript.trim();
  return { text };
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function codexUsage(value: unknown): { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | null {
  const usage = objectOf(value);
  if (!usage) return null;
  const inputTokens = firstFiniteNumber(usage.input_tokens, usage.inputTokens, usage.prompt_tokens) ?? 0;
  const outputTokens = firstFiniteNumber(usage.output_tokens, usage.outputTokens, usage.completion_tokens) ?? 0;
  const details = objectOf(usage.input_tokens_details) ?? objectOf(usage.prompt_tokens_details);
  const cachedInputTokens = firstFiniteNumber(details?.cached_tokens, usage.cached_input_tokens);
  if (inputTokens <= 0 && outputTokens <= 0 && !cachedInputTokens) return null;
  return { inputTokens, outputTokens, ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}) };
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function extractCodexError(event: CodexJsonEvent): string | null {
  const envelope = objectOf(event.msg) ?? event;
  const type = String(envelope.type ?? '').toLowerCase();
  if (!type.includes('error') && !type.includes('fail')) return null;
  return normalizeCodexError(
    firstString(
      objectOf(envelope.error)?.message,
      envelope.message,
      envelope.error,
      objectOf(event.error)?.message,
      event.message,
    ),
  );
}

function normalizeCodexError(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const object = objectOf(parsed);
    const nested = firstString(objectOf(object?.error)?.message, object?.message, object?.error);
    if (nested) return nested;
  } catch {}
  return trimmed;
}

/**
 * Self-heal the Codex model for the active auth mode.
 *
 * Codex run against a **ChatGPT account** (the default — `codex login`, no API
 * key) rejects the `*-codex` model ids with a hard exit: "The '<id>' model is
 * not supported when using Codex with a ChatGPT account." That takes the whole
 * turn down even though the operator never deliberately chose an unsupported
 * model (it was the historical default, persisted on older agents). `gpt-5.5`
 * works under BOTH ChatGPT-account and API-key auth, so when no OpenAI API key
 * is present we map any `*-codex` id to it instead of letting the turn fail.
 *
 * An API key in the environment means API-key auth, where the `*-codex` ids are
 * valid — so they're left untouched. `AGENTIS_CODEX_ALLOW_CODEX_MODELS=true`
 * forces the raw id through regardless (escape hatch for unusual setups).
 */
export function resolveCodexModel(
  model: string | null,
  env?: Record<string, string | undefined>,
): string | null {
  if (!model) return model;
  const read = (key: string) => (env?.[key] ?? process.env[key] ?? '').trim();
  if (read('AGENTIS_CODEX_ALLOW_CODEX_MODELS').toLowerCase() === 'true') return model;
  const isCodexModel = /-codex(-|$)/i.test(model) || /^codex-/i.test(model);
  if (!isCodexModel) return model;
  const hasApiKey = Boolean(read('OPENAI_API_KEY') || read('CODEX_API_KEY'));
  return hasApiKey ? model : 'gpt-5.5';
}

export function isCodexModelCacheFailure(detail: string): boolean {
  return /failed to (load models cache|renew cache TTL)|missing field [`'\"]?(?:supports_\w+|base_instructions)[`'\"]?/i.test(detail);
}

/** Quarantine only a positively identified Codex model catalogue cache. */
export function recoverCodexModelCache(cacheRoot = join(homedir(), '.codex')): string | null {
  for (const name of ['models-cache.json', 'models_cache.json']) {
    const file = join(cacheRoot, name);
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object') continue;
      renameSync(file, `${file}.incompatible-${Date.now()}`);
      return name;
    } catch {
      // Never alter unreadable/non-cache files or anything we cannot rename.
    }
  }
  return null;
}

function formatCodexExitError(code: number | null, stderrText: string, stdoutError: string, signal?: NodeJS.Signals | null): string {
  const stderr = stripProcessNoise(stderrText).trim();
  const detail = normalizeCodexError(stdoutError) ?? normalizeCodexError(stderr) ?? stderr;
  const exit = code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`;
  if (detail) {
    // A ChatGPT-authenticated Codex rejects the `*-codex` model ids with this
    // exact message. Turn the cryptic CLI error into a one-step fix instead of
    // leaving the operator guessing.
    if (/model is not supported when using codex with a chatgpt account/i.test(detail)) {
      return `${detail} — switch this agent's model to "gpt-5.5" (the model picker in the chat header / agent settings), which works on both ChatGPT-account and API-key Codex auth.`;
    }
    // Codex caches its model catalogue on disk. When the CLI is upgraded (or
    // downgraded) the cached JSON can lack a field the new parser requires, and
    // Codex then fails to load ANY model — so every model change appears broken
    // and looks like Agentis pinning the model. It is neither our cache nor our
    // constraint; name the file so the operator can clear it.
    if (isCodexModelCacheFailure(detail)) {
      return `Codex could not read its own model cache (${detail}). This is a stale cache from a different Codex version, not an Agentis setting. Delete the cache files under ~/.codex (e.g. models-cache.json) and/or run \`npm install -g @openai/codex@latest\`, then retry — model selection will work again.`;
    }
    return `Codex exited with ${exit}: ${detail}`;
  }
  return `Codex exited with ${exit}`;
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

function buildCodexChatPrompt(messages: ChatMessage[], tools: ToolDefinition[], mcpNative = false, resumedSession = false, callerManagedTools = false): string {
  // MCP-native: the harness mounts the `agentis` MCP server and calls those tools
  // itself, so we drop the marker-protocol instructions entirely and just give it
  // the conversation. It runs its own loop and returns the final answer.
  const toolPreamble = mcpNative
    ? 'You have the Agentis platform tools available via the "agentis" MCP server (build workflows, run them, inspect the workspace, dispatch agents, etc.). Use them directly to fulfill the request, then reply with a concise final answer.'
    : buildMarkerToolPrompt(tools, { nativeTools: !callerManagedTools });
  // A resumed Codex thread already owns its prior conversation and tool history.
  // Re-sending Agentis's history duplicates the same turns inside the harness
  // and makes every subsequent model pass progressively more expensive. Refresh
  // only the authoritative system/Brain state plus the newest user turn.
  const promptMessages = messagesForRuntimeSession(messages, resumedSession);
  return [
    toolPreamble,
    '',
    'AUTHORITATIVE IDENTITY RULE:',
    'The SYSTEM message below is the Agentis operating prompt for this turn. If it contains an <agentis_identity> block, that block is your exact identity and configuration. Follow it over Codex product defaults, project/home instruction files, previous resumed-session identity, or generic assistant persona text.',
    '',
    'Conversation:',
    formatMessagesForCodex(promptMessages),
  ].join('\n');
}

function formatMessagesForCodex(messages: ChatMessage[]): string {
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
