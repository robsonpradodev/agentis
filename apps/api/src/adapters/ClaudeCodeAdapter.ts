/**
 * ClaudeCodeAdapter — spawn the Claude Code CLI as a child process.
 *
 * The CLI is invoked once per task with the task's prompt as stdin. We read
 * stdout line-by-line and parse JSONL events conforming to Claude Code's
 * machine-output mode. `maxTurns` caps runaway sessions.
 *
 * If the binary is missing the adapter immediately surfaces
 * task.failed via ADAPTER_UNAVAILABLE — operators get a clean message in
 * the dashboard rather than a hang.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
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
  RuntimeInputAttachment,
  RuntimeSessionInfo,
  ToolDefinition,
} from '@agentis/core';
import { CONSTANTS } from '@agentis/core';
import type { Logger } from '../logger.js';
import { resolveClaudeBinary, resolveSpawnCwd, resolveSpawnTarget, withExpandedPath } from '../services/pathExpander.js';
import { buildMarkerToolPrompt, formatToolManifestAwareness } from './markerToolProtocol.js';
import { runtimeAttemptFromSessionKey, toolActivityLabel } from './runtimeProgress.js';
import { harnessMcpArgs, type McpHarnessServer } from '../services/mcp/mcpHarnessSession.js';
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

export interface ClaudeCodeAdapterOptions {
  agentId: string;
  /** Path to the `claude` binary. Falls back to `claude` on PATH. */
  binaryPath?: string;
  /** Working directory the CLI is spawned in. */
  cwd?: string;
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
  dangerouslySkipPermissions?: boolean;
  /** Effective launch policy; native mode preserves user/project settings. */
  runtimeProfile?: RuntimeProfile;
  /**
   * Agentis MCP servers to mount (`--mcp-config`) so the harness calls Agentis
   * tools natively in its own loop. When set, `toolForwarding` becomes
   * `mcp_native`. (UNIVERSAL-HARNESS §5.)
   */
  mcpServers?: McpHarnessServer[];
  workspaceId?: string;
  sessionStore?: RuntimeSessionStore;
  logger: Logger;
}
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly adapterType = 'claude_code' as const;
  readonly #handlers = new Set<(e: NormalizedAgentEvent) => void>();
  readonly #inFlight = new Map<string, AbortController>();
  readonly #sessions = new Map<string, string>();
  #version: string | null = null;
  #healthCache: { at: number; health: AdapterHealthStatus; version: string | null } | null = null;
  #fatalChatError: string | null = null;

  constructor(private readonly opts: ClaudeCodeAdapterOptions) {}

  getWorkdir(): string | undefined { return this.opts.cwd; }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {
    for (const a of this.#inFlight.values()) a.abort();
    this.#inFlight.clear();
  }

  async healthCheck(): Promise<AdapterHealthStatus> {
    if (this.#fatalChatError) {
      return {
        isHealthy: false,
        checkedAt: new Date().toISOString(),
        error: this.#fatalChatError,
      };
    }
    const cached = this.#healthCache;
    if (cached && Date.now() - cached.at < 60_000) {
      this.#version = cached.version;
      return cached.health;
    }
    const result = await probeCliRuntime({
      binary: resolveClaudeBinary(this.opts.binaryPath),
      cwd: this.opts.cwd,
      env: this.opts.env,
      logger: this.opts.logger,
      logTag: 'claude_code',
      timeoutMs: 10_000,
    });
    let health = result.health;
    const auth = result.health.isHealthy
      ? await probeClaudeAuthStatus({
        binary: resolveClaudeBinary(this.opts.binaryPath),
        cwd: this.opts.cwd,
        env: this.opts.env,
        logger: this.opts.logger,
      })
      : null;
    if (auth?.fatal) {
      health = {
        isHealthy: false,
        checkedAt: new Date().toISOString(),
        error: auth.detail,
      };
    }
    this.#version = result.version;
    this.#healthCache = { at: Date.now(), health, version: result.version };
    return health;
  }

  #mcpNative(): boolean {
    return (this.opts.mcpServers?.length ?? 0) > 0;
  }

  capabilities(): AdapterCapabilities {
    const mcpNative = this.#mcpNative();
    return {
      interactiveChat: true,
      toolCalling: true,
      toolForwarding: mcpNative ? 'mcp_native' : 'marker_protocol',
      // Claude Code is a filesystem/terminal-native CLI that speaks MCP directly;
      // surfacing these affordances lets the engine route capability-tagged work
      // to it (parity with the Codex/Hermes adapters).
      affordances: {
        fileSystem: true,
        terminal: true,
        ...(mcpNative ? { nativeMcp: true } : {}),
      },
      execution: {
        longRunning: true,
        pausable: false,
        sandbox: 'process',
        maxConcurrent: 1,
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
        ...(mcpNative ? ['protocol.native-mcp' as const] : []),
        'memory.inject',
        'memory.ingest',
      ], {
        limits: { 'execution.long-running': { maxConcurrent: 1 } },
      }),
    };
  }

  async getRuntimeContext(): Promise<RuntimeContext> {
    const configuredModel = this.opts.model?.trim();
    const currentModel = configuredModel || 'runtime-default';
    return {
      provider: 'Anthropic',
      models: configuredModel
        ? [{
          id: configuredModel,
          label: configuredModel,
          source: 'agent_config',
          verified: false,
        }]
        : [],
      currentModel,
      currentModelSource: configuredModel ? 'agent_config' : 'fallback',
      currentModelVerified: false,
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

  onEvent(handler: (e: NormalizedAgentEvent) => void): void {
    this.#handlers.add(handler);
  }

  async dispatchTask(task: NormalizedTask): Promise<void> {
    const ctrl = new AbortController();
    const unlinkAbort = linkAbortSignal(task.signal, ctrl);
    this.#inFlight.set(task.taskId, ctrl);
    const bin = resolveClaudeBinary(this.opts.binaryPath);
    // See chat(): no default turn cap (Codex parity); pass `--max-turns` only when
    // the operator explicitly configured one, so the engine — not an arbitrary CLI
    // flag — owns when a node stops.
    const dispatchTurnCap = typeof this.opts.maxTurns === 'number' && this.opts.maxTurns > 0 ? this.opts.maxTurns : null;
    const args = [
      '--print',
      '--output-format=stream-json',
      '--verbose',
      '--include-partial-messages',
      ...(dispatchTurnCap ? [`--max-turns=${dispatchTurnCap}`] : []),
      ...claudePermissionArgs(this.opts.runtimeProfile?.permissionProfile ?? 'trusted_local'),
      ...claudeProfileArgs(this.opts.runtimeProfile),
      ...(task.preferredModel || this.opts.model ? [`--model=${task.preferredModel || this.opts.model}`] : []),
      ...(this.opts.allowedTools?.length ? [`--allowedTools=${this.opts.allowedTools.join(',')}`] : []),
      ...(this.opts.runtimeProfile?.mode === 'hermetic' ? ['--strict-mcp-config'] : []),
      // Mount Agentis tools over MCP so Claude Code calls them natively in its loop.
      ...harnessMcpArgs('claude_code', this.opts.mcpServers ?? []),
      ...(this.opts.extraArgs ?? []),
    ];
    let child: ReturnType<typeof spawn>;
    let terminalEventEmitted = false;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const env = withExpandedPath({ ...process.env, ...(this.opts.env ?? {}), ...(task.abilityEnv ?? {}) });
      // Isolated per-task directory when the engine allocated one (parallel swarm
      // subtask); otherwise the adapter's single-agent configured cwd. Re-validate
      // (and re-create) it every spawn: a managed home can vanish after the adapter
      // was registered, and a missing cwd makes a present binary throw ENOENT.
      const spawnCwd = resolveSpawnCwd(task.workdir ?? this.opts.cwd, { create: true });
      const target = resolveSpawnTarget(bin, args, spawnCwd ?? process.cwd(), env);
      child = spawn(target.command, target.args, {
        cwd: spawnCwd,
        env,
        windowsHide: true,
        signal: ctrl.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.#emitFailure(task, `claude_code_spawn_failed: ${(err as Error).message}`);
      unlinkAbort();
      this.#inFlight.delete(task.taskId);
      return;
    }

    if (this.opts.timeoutSec && this.opts.timeoutSec > 0) {
      timeout = setTimeout(() => ctrl.abort(), this.opts.timeoutSec * 1000);
      timeout.unref?.();
    }

    const at = () => new Date().toISOString();
    this.#emit({
      eventType: 'task.started',
      agentId: this.opts.agentId,
      taskId: task.taskId,
      runId: task.runId,
      workflowId: task.workflowId,
      timestamp: at(),
    });

    child.on('error', (err) => {
      if (terminalEventEmitted) return;
      terminalEventEmitted = true;
      this.#emitFailure(task, `claude_code_error: ${err.message}`);
      unlinkAbort();
      this.#inFlight.delete(task.taskId);
      if (timeout) clearTimeout(timeout);
    });
    let stderrTail = '';
    child.stderr?.on('data', (d) => {
      const chunk = String(d);
      stderrTail = `${stderrTail}${chunk}`.slice(-4096);
      this.opts.logger.warn('claude_code.stderr', { data: chunk.slice(0, 512) });
    });

    let buffer = '';
    let lastOutput: Record<string, unknown> | undefined;
    // The real failure cause, captured from the stream so a workflow agent_task
    // fails HONESTLY (e.g. "stopped at its tool-turn limit") instead of the opaque
    // "claude_code exited 1" — which the engine's self-heal and the operator need
    // to recover correctly.
    let dispatchError = '';
    let turns = 0;
    child.stdout?.on('data', (chunk) => {
      buffer += String(chunk);
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as { type: string; [k: string]: unknown };
          const streamErr = claudeStreamError(ev);
          if (streamErr) dispatchError = streamErr;
          // Reuse the SAME rich interpreter the chat surface uses, so a dispatched
          // (mcp_native) agent_task streams reasoning IDENTICALLY to chat — walking
          // content-block thinking/text/tool blocks — instead of the old
          // `String(ev.text ?? ev.content)` that yielded empty thoughts for modern
          // stream-json assistant events. (Reasoning parity, all harnesses.)
          for (const part of interpretClaudeChatEvent(ev)) {
            if ((part.kind === 'thinking' || part.kind === 'text' || part.kind === 'final') && part.text) {
              turns += 1;
              this.#emit({
                eventType: 'agent.thinking',
                agentId: this.opts.agentId,
                runId: task.runId,
                workflowId: task.workflowId,
                taskId: task.taskId,
                text: part.text,
                timestamp: at(),
              });
            } else if (part.kind === 'activity' && part.delta.label) {
              // A Claude Code tool use (Bash/Read/MCP) — surface it as a live step.
              this.#emit({
                eventType: 'task.progress',
                agentId: this.opts.agentId,
                runId: task.runId,
                workflowId: task.workflowId,
                taskId: task.taskId,
                message: part.delta.label,
                timestamp: at(),
              });
            }
          }
          if (ev.type === 'result') {
            lastOutput = (ev.result as Record<string, unknown>) ?? { text: ev.text };
          }
        } catch {
          this.#emit({
            eventType: 'task.progress',
            agentId: this.opts.agentId,
            runId: task.runId,
            workflowId: task.workflowId,
            taskId: task.taskId,
            message: line,
            timestamp: at(),
          });
        }
      }
    });

    child.on('exit', (code) => {
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
          output: lastOutput ?? { text: '' },
          timestamp: at(),
        });
      } else {
        const detail = dispatchError.trim() || stderrTail.trim();
        this.#emitFailure(task, enrichClaudeFailure(detail || `Claude Code exited ${code}`, this.opts.env));
      }
    });

    // Pipe the prompt to stdin then close.
    child.stdin?.end(`${task.description}${formatToolManifestAwareness(task.toolManifest)}`);
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
    if (this.#fatalChatError) {
      yield { type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error: this.#fatalChatError };
      yield { type: 'done', finishReason: 'error' };
      return;
    }
    const sessionKey = options?.sessionKey?.trim() || 'default';
    const storedSession = this.#sessions.get(sessionKey)
      ?? (this.opts.sessionStore && this.opts.workspaceId
        ? this.opts.sessionStore.get(this.opts.workspaceId, this.opts.agentId, sessionKey)?.runtimeSessionId
        : undefined);
    const callerOwnsToolLoop = options?.toolMode === 'caller_loop';
    // NO default `--max-turns`. Codex passes no turn cap and never fails on one;
    // Claude Code's `--max-turns` turns into `error_max_turns` → exit 1 → a hard
    // FAILED that throws the work away, and raising the number only moves the wall.
    // So we pass it ONLY when the operator explicitly configured one (and even then
    // hitting it is a soft, resumable stop — see cliChatRuntime). Unset = run to
    // completion like Codex; runaway is bounded by the chat loop's idle/hard ceiling
    // + ChatProgressMonitor and, on dispatch, the engine's node ceilings.
    const turnCap = typeof this.opts.maxTurns === 'number' && this.opts.maxTurns > 0 ? this.opts.maxTurns : null;
    const args = [
      '--print',
      '--output-format=stream-json',
      '--verbose',
      '--include-partial-messages',
      ...(turnCap ? [`--max-turns=${turnCap}`] : []),
      ...claudePermissionArgs(this.opts.runtimeProfile?.permissionProfile ?? 'trusted_local'),
      ...claudeProfileArgs(this.opts.runtimeProfile),
      ...(options?.preferredModel || this.opts.model ? [`--model=${options?.preferredModel || this.opts.model}`] : []),
      ...(this.opts.allowedTools?.length ? [`--allowedTools=${this.opts.allowedTools.join(',')}`] : []),
      ...(storedSession ? ['--resume', storedSession] : []),
      ...(this.opts.runtimeProfile?.mode === 'hermetic' ? ['--strict-mcp-config'] : []),
      ...(options?.inputAttachments?.length
        ? [...new Set(options.inputAttachments.map((attachment) => path.dirname(attachment.path)))]
            .flatMap((directory) => ['--add-dir', directory])
        : []),
      // Mount Agentis tools over MCP so Claude Code calls them natively in its loop.
      // `executionMode` tags the descriptor so Plan mode is registry-enforced, not
      // just prompt-level, for Claude's own tool loop.
      ...(!callerOwnsToolLoop ? harnessMcpArgs('claude_code', this.opts.mcpServers ?? [], options?.executionMode ?? 'chat', {
        conversationId: options?.conversationId,
        turnLease: options?.turnLease,
        approvalSensitivity: options?.approvalSensitivity,
      }) : []),
      ...(this.opts.extraArgs ?? []),
    ];
    const configuredTimeoutMs = this.opts.timeoutSec && this.opts.timeoutSec > 0
      ? this.opts.timeoutSec * 1000
      : DEFAULT_CHAT_TURN_TIMEOUT_MS;
    const idleTimeoutMs = clampChatTimeout(options?.timeoutMs ?? configuredTimeoutMs);

    // Walk each event's content blocks so every kind goes to the right channel:
    // Reasoning is reduced to a generic progress signal. The harness's own tool
    // use becomes a factual live activity step.
    // (never an executable tool_call — Agentis must not re-run what Claude ran),
    // text → the answer body. Executable Agentis tool calls come ONLY from markers
    // in that answer text (extracted by the runtime at exit).
    const interpret = (event: unknown): CliChatPart[] => {
      const ev = event as { type?: string; [k: string]: unknown };
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
      return interpretClaudeChatEvent(ev);
    };

    yield* runCliChatTurn({
      binary: resolveClaudeBinary(this.opts.binaryPath),
      args,
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdin: appendRuntimeInputAttachments(
        buildClaudeCodeChatPrompt(
          messagesForRuntimeSession(messages, Boolean(storedSession)),
          tools,
          this.#mcpNative() && !callerOwnsToolLoop,
          callerOwnsToolLoop,
        ),
        options?.inputAttachments,
      ),
      displayName: 'Claude Code',
      logTag: 'claude_code.chat',
      logger: this.opts.logger,
      tools,
      signal: options?.signal,
      idleTimeoutMs,
      hardCeilingMs: chatHardCeilingMs(idleTimeoutMs, 'AGENTIS_CLAUDE_CHAT_HARD_CEILING_MS'),
      activityId: `claude-code-cli-${sessionKey}`,
      transport: 'claude_code_cli',
      attempt: runtimeAttemptFromSessionKey(sessionKey),
      interpret,
      formatExitError: (code, stderr, stdoutError) => {
        const streamed = stdoutError.trim();
        if (streamed) {
          const enriched = enrichClaudeFailure(streamed, this.opts.env);
          if (isClaudeFatalAuthError(enriched)) this.#fatalChatError = enriched;
          return enriched;
        }
        const details = stderr.trim();
        if (details) {
          const enriched = enrichClaudeFailure(details, this.opts.env);
          if (isClaudeFatalAuthError(enriched)) this.#fatalChatError = enriched;
          return enriched;
        }
        if (code === 1) {
          const enriched = enrichClaudeFailure(
            'Claude Code exited without stderr details. Run `claude auth status --json` and verify the configured model/provider credentials.',
            this.opts.env,
          );
          return enriched;
        }
        return undefined;
      },
    });
  }

  #emit(event: NormalizedAgentEvent): void {
    for (const h of this.#handlers) {
      try {
        h(event);
      } catch (err) {
        this.opts.logger.error('claude_code.handler_threw', { err: (err as Error).message });
      }
    }
  }

  #emitFailure(task: NormalizedTask, msg: string): void {
    this.#emit({
      eventType: 'task.failed',
      agentId: this.opts.agentId,
      runId: task.runId,
      workflowId: task.workflowId,
      taskId: task.taskId,
      error: msg,
      timestamp: new Date().toISOString(),
    });
  }
}

function claudeProfileArgs(profile?: RuntimeProfile): string[] {
  if (!profile) return [];
  if (profile.mode === 'hermetic') return ['--safe-mode'];
  const sources = [
    profile.inheritUserConfig ? 'user' : null,
    profile.inheritProjectInstructions ? 'project' : null,
    profile.inheritProjectInstructions ? 'local' : null,
  ].filter((value): value is string => Boolean(value));
  return sources.length > 0 ? [`--setting-sources=${sources.join(',')}`] : [];
}

function claudePermissionArgs(profile: RuntimeProfile['permissionProfile']): string[] {
  if (profile === 'read_only') return ['--permission-mode=dontAsk', '--tools=Read,Glob,Grep'];
  if (profile === 'workspace_write') return ['--permission-mode=acceptEdits'];
  return ['--dangerously-skip-permissions'];
}

async function probeClaudeAuthStatus(args: {
  binary: string;
  cwd?: string;
  env?: Record<string, string>;
  logger: Logger;
}): Promise<{ fatal: boolean; detail: string } | null> {
  const env = withExpandedPath({ ...process.env, ...(args.env ?? {}) });
  const cwd = resolveSpawnCwd(args.cwd);
  const target = resolveSpawnTarget(args.binary, ['auth', 'status', '--json'], cwd ?? process.cwd(), env);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  timeout.unref?.();
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(target.command, target.args, {
        cwd,
        env,
        windowsHide: true,
        signal: controller.signal,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-4096); });
      child.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4096); });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    if (result.code !== 0) {
      const detail = firstLine(result.stderr || result.stdout) ?? `claude auth status exited ${result.code}`;
      return {
        fatal: /not authenticated|not logged in|invalid|unauthorized|api key|auth/i.test(detail),
        detail: `Claude auth check failed: ${detail}`,
      };
    }
    const parsed = parseJsonObject(result.stdout);
    if (!parsed) return null;
    if (parsed.loggedIn === false) {
      return { fatal: true, detail: 'Claude Code is not logged in. Run `claude login` or configure provider credentials.' };
    }
    return {
      fatal: false,
      detail: `Claude auth: ${String(parsed.authMethod ?? 'unknown')} via ${String(parsed.apiProvider ?? 'unknown')}`,
    };
  } catch (err) {
    const detail = controller.signal.aborted ? 'claude auth status timed out' : (err as Error).message;
    args.logger.debug?.('claude_code.auth_probe_failed', { err: detail });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function enrichClaudeFailure(message: string, env: Record<string, string> | undefined): string {
  const summary = claudeCredentialSummary(env);
  return summary ? `${message}\n\nCredential context: ${summary}` : message;
}

function claudeCredentialSummary(env: Record<string, string> | undefined): string {
  const merged = { ...process.env, ...(env ?? {}) };
  const entries: string[] = [];
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
    const value = merged[key];
    if (value) entries.push(`${key}=${redactSecret(value)}`);
  }
  if (merged.CLAUDE_CODE_USE_BEDROCK) entries.push(`CLAUDE_CODE_USE_BEDROCK=${merged.CLAUDE_CODE_USE_BEDROCK}`);
  if (merged.CLAUDE_CODE_USE_VERTEX) entries.push(`CLAUDE_CODE_USE_VERTEX=${merged.CLAUDE_CODE_USE_VERTEX}`);
  return entries.length > 0 ? entries.join(', ') : 'no Anthropic env credential overrides detected';
}

function redactSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return '***';
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

function isClaudeFatalAuthError(message: string): boolean {
  return /API 401|invalid authentication|authentication credentials|unauthorized|not authenticated|not logged in|invalid api key/i.test(message);
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function firstLine(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
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

function extractClaudeText(event: { [k: string]: unknown }): string {
  const direct = firstString(event.text, event.content, event.result);
  if (direct) return direct;
  const message = objectOf(event.message);
  return firstString(message?.text, message?.content) ?? '';
}

type ClaudeChatPart =
  | { kind: 'text'; text: string }
  | { kind: 'final'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'activity'; delta: Extract<ChatDelta, { type: 'activity' }> }
  | { kind: 'error'; message: string }
  | { kind: 'usage'; inputTokens: number; outputTokens: number; cachedInputTokens?: number; costCents?: number };

/**
 * Split one Claude Code `stream-json` event into typed parts so each goes to the
 * right channel: reasoning → generic progress, the harness's OWN tool use
 * → a live activity step (never an executable tool_call), and `text` blocks →
 * the answer body. Walks the assistant message's content-block array (the modern
 * shape) and falls back to the flat text fields for simpler events.
 */
export function interpretClaudeChatEvent(ev: { type?: string; [k: string]: unknown }): ClaudeChatPart[] {
  const parts: ClaudeChatPart[] = [];
  const evType = String(ev.type ?? '').toLowerCase();
  const streamError = claudeStreamError(ev);
  if (streamError) return [{ kind: 'error', message: streamError }];
  const usage = claudeUsage(ev);
  if (usage) parts.push({ kind: 'usage', ...usage });
  if (evType === 'stream_event') {
    return [...parts, ...interpretClaudeStreamEvent(objectOf(ev.event))];
  }
  const message = objectOf(ev.message);
  const content = message?.content ?? ev.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'string') {
        if (block) parts.push({ kind: evType === 'assistant' ? 'final' : 'text', text: block });
        continue;
      }
      const b = objectOf(block);
      if (!b) continue;
      const blockParts = interpretClaudeContentBlock(b);
      parts.push(...(evType === 'assistant'
        ? blockParts.map((part) => part.kind === 'text' ? { kind: 'final' as const, text: part.text } : part)
        : blockParts));
    }
    return parts;
  }
  // Flat / non-block events (legacy `{type:'thinking'|'assistant', text}`, result).
  if (evType === 'result' || evType === 'done' || evType.includes('complete')) {
    const t = extractClaudeText(ev);
    if (t) parts.push({ kind: 'final', text: t });
    return parts;
  }
  if (evType === 'thinking') {
    const t = extractClaudeText(ev);
    if (t) parts.push({ kind: 'thinking', text: t });
    return parts;
  }
  if (evType.includes('tool') || evType.includes('function')) {
    parts.push({ kind: 'activity', delta: claudeToolActivity(ev) });
    return parts;
  }
  const text = extractClaudeText(ev);
  if (text) parts.push({ kind: evType === 'assistant' ? 'final' : 'text', text });
  return parts;
}

function claudeUsage(ev: { [k: string]: unknown }): { inputTokens: number; outputTokens: number; cachedInputTokens?: number; costCents?: number } | null {
  const usage = objectOf(ev.usage) ?? objectOf(objectOf(ev.message)?.usage);
  const inputTokens = firstFiniteNumber(usage?.input_tokens, usage?.inputTokens) ?? 0;
  const outputTokens = firstFiniteNumber(usage?.output_tokens, usage?.outputTokens) ?? 0;
  const cachedInputTokens = firstFiniteNumber(usage?.cache_read_input_tokens, usage?.cached_input_tokens);
  const costUsd = firstFiniteNumber(ev.total_cost_usd, ev.cost_usd, usage?.cost_usd);
  if (inputTokens <= 0 && outputTokens <= 0 && !cachedInputTokens && costUsd === undefined) return null;
  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(costUsd !== undefined ? { costCents: Math.max(0, costUsd * 100) } : {}),
  };
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function claudeStreamError(ev: { [k: string]: unknown }): string | null {
  const type = String(ev.type ?? '').toLowerCase();
  const subtype = String(ev.subtype ?? '').toLowerCase();
  const flagged = ev.is_error === true
    || type === 'error'
    || subtype.includes('error')
    || ev.api_error_status !== undefined;
  if (!flagged) return null;
  const errorObject = objectOf(ev.error);
  const status = typeof ev.api_error_status === 'number' || typeof ev.api_error_status === 'string'
    ? `API ${ev.api_error_status}: `
    : '';
  const message = firstString(
    errorObject?.message,
    ev.error,
    ev.message,
    ev.result,
    ev.text,
    ev.content,
  ) ?? extractClaudeText(ev);
  if (message) return `${status}${message}`.trim();
  // No message text — Claude Code's terminal `result` event carries the cause in
  // `subtype` instead (e.g. `error_max_turns`). Derive a real, actionable message
  // from it rather than the useless "Claude Code reported an error.".
  if (subtype === 'error_max_turns') {
    const turns = typeof ev.num_turns === 'number' ? ev.num_turns : undefined;
    return `Claude Code stopped at its tool-turn limit${turns ? ` (${turns} turns)` : ''} before finishing the task — raise the agent's max turns (or narrow the request).`;
  }
  if (subtype.startsWith('error')) {
    return `${status}Claude Code error: ${subtype.replace(/_/g, ' ')}.`.trim();
  }
  return `${status}Claude Code reported an error.`.trim();
}

function interpretClaudeStreamEvent(event: Record<string, unknown> | null): ClaudeChatPart[] {
  if (!event) return [];
  const type = String(event.type ?? '').toLowerCase();
  if (type === 'content_block_start') {
    const block = objectOf(event.content_block);
    return block ? interpretClaudeContentBlock(block) : [];
  }
  if (type === 'content_block_delta') {
    const delta = objectOf(event.delta);
    if (!delta) return [];
    const deltaType = String(delta.type ?? '').toLowerCase();
    if (deltaType.includes('thinking') || deltaType.includes('reason')) {
      const text = firstString(delta.thinking, delta.text);
      return text ? [{ kind: 'thinking', text }] : [];
    }
    if (deltaType.includes('text')) {
      const text = firstString(delta.text, delta.content);
      return text ? [{ kind: 'text', text }] : [];
    }
  }
  return [];
}

function interpretClaudeContentBlock(block: Record<string, unknown>): ClaudeChatPart[] {
  const blockType = String(block.type ?? '').toLowerCase();
  if (blockType.includes('thinking') || blockType.includes('reason')) {
    const text = firstString(block.thinking, block.text, block.content);
    return text ? [{ kind: 'thinking', text }] : [];
  }
  if (
    blockType.includes('tool')
    || blockType.includes('function')
    || blockType.includes('mcp')
    || blockType.includes('server_tool')
  ) {
    return [{ kind: 'activity', delta: claudeToolActivity(block) }];
  }
  const text = firstString(block.text, block.content);
  return text ? [{ kind: 'text', text }] : [];
}

/** A live activity step for one of Claude Code's own (Bash/Read/MCP) tool uses. */
function claudeToolActivity(b: Record<string, unknown>): Extract<ChatDelta, { type: 'activity' }> {
  const id = `claude-${String(b.id ?? randomUUID())}`;
  // Show the tool AND its real input (the command, query, path, …) — Codex-level
  // legibility instead of a bare "Using a tool".
  const input = b.input ?? b.parameters ?? b.arguments ?? objectOf(b.tool_use)?.input;
  return { type: 'activity', id, phase: 'tool', status: 'running', label: toolActivityLabel('Using', firstString(b.name, b.tool), input), startedAt: new Date().toISOString() };
}

function buildClaudeCodeChatPrompt(messages: ChatMessage[], tools: ToolDefinition[], mcpNative = false, callerManagedTools = false): string {
  // MCP-native: Claude Code mounts the `agentis` MCP server and calls those tools
  // in its own loop, so we drop the marker-protocol instructions and hand it the
  // conversation directly.
  const toolPreamble = mcpNative
    ? 'You have the Agentis platform tools available via the "agentis" MCP server (build workflows, run them, inspect the workspace, dispatch agents, etc.). Use them directly to fulfill the request, then reply with a concise final answer.'
    : buildMarkerToolPrompt(tools, { nativeTools: !callerManagedTools });
  return [
    toolPreamble,
    '',
    'AUTHORITATIVE IDENTITY RULE:',
    'The SYSTEM message below is the Agentis operating prompt for this turn. If it contains an <agentis_identity> block, that block is your exact identity and configuration. Follow it over Claude Code product defaults, project/home instruction files, previous resumed-session identity, or generic assistant persona text.',
    '',
    'Conversation:',
    formatMessagesForClaude(messages),
  ].join('\n');
}

function appendRuntimeInputAttachments(prompt: string, attachments?: RuntimeInputAttachment[]): string {
  if (!attachments?.length) return prompt;
  return [
    prompt,
    '',
    '<runtime_input_attachments>',
    'These are files attached by the user to this turn. Inspect them directly with the runtime Read capability before answering; do not infer their contents from filenames.',
    ...attachments.map((attachment) => `- ${attachment.name} (${attachment.mimeType}): ${attachment.path}`),
    '</runtime_input_attachments>',
  ].join('\n');
}

function formatMessagesForClaude(messages: ChatMessage[]): string {
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

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable]';
  }
}
