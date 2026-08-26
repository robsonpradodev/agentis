import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
  RuntimeInputAttachment,
  RuntimeSessionInfo,
  ToolDefinition,
} from '@agentis/core';
import type { Logger } from '../logger.js';
import { withHarnessTurnHeaders, type McpHarnessServer } from '../services/mcp/mcpHarnessSession.js';
import type { RuntimeSessionStore } from '../services/runtime/runtimeSessionStore.js';
import { resolveSpawnCwd, resolveSpawnTarget, withExpandedPath } from '../services/pathExpander.js';
import { linkAbortSignal } from './abort.js';
import { buildMarkerToolPrompt } from './markerToolProtocol.js';
import { AcpClient, toAcpHttpMcpServers, type AcpModelInfo, type AcpSessionUpdate } from './acpClient.js';
import {
  chatHardCeilingMs,
  createChatQueue,
  DEFAULT_CHAT_TURN_TIMEOUT_MS,
  messagesForRuntimeSession,
  runCliChatTurn,
} from './cliChatRuntime.js';
import { probeCliRuntime } from './cliRuntimeProbe.js';
import { nativeRuntimeCapabilities } from './runtimeCapabilityDeclarations.js';
import { runtimeAttemptFromSessionKey, runtimeProgressActivity } from './runtimeProgress.js';

const DEFAULT_HERMES_STARTUP_TIMEOUT_MS = 120_000;
const MAX_HERMES_STARTUP_TIMEOUT_MS = 300_000;
// ACP occasionally accepts a prompt but stalls before it even starts the provider
// request. Workflow callers now retain the Agentis tool loop during CLI recovery,
// so waiting 90 seconds no longer buys capability safety; it only freezes the run.
const DEFAULT_HERMES_FIRST_EVENT_TIMEOUT_MS = 20_000;
// Interactive chat cannot sit silent for 90s while we wait to see whether the
// ACP build will EVER stream output. When the operator is at a keyboard
// (latencyClass 'interactive'), a session that opens but produces no first event
// quickly is treated as an ACP stall: in `auto` transport we cut over to the
// stable CLI path fast instead of freezing. Env-overridable for genuinely slow
// providers.
const DEFAULT_HERMES_INTERACTIVE_FIRST_EVENT_TIMEOUT_MS = 12_000;
const MIN_HERMES_FIRST_EVENT_TIMEOUT_MS = 2_000;
const MAX_HERMES_FIRST_EVENT_TIMEOUT_MS = 120_000;
// Once an `auto`-transport turn has had to abandon a stalled ACP attempt and fall
// back to the CLI, attempting ACP again next turn just re-burns the same
// ~startup + first-event-probe seconds for nothing. Latch the CLI route for this
// cooldown so subsequent turns are CLI-fast, then periodically re-try ACP in case
// the build recovered. Env-overridable; 0 disables the breaker.
const DEFAULT_HERMES_ACP_STALL_COOLDOWN_MS = 15 * 60_000;
// Hermes' quiet CLI emits only its final answer: its model calls and native tool
// work are written to Hermes' own log, not the child stdout/stderr pipes Agentis
// can observe. A short "silence" deadline therefore kills HEALTHY tool-using
// workflow tasks. Interactive turns retain a short operator-facing budget, while
// background/deep work gets the shared long-running harness ceiling. Both remain
// environment-overridable.
const DEFAULT_HERMES_INTERACTIVE_CLI_SILENCE_TIMEOUT_MS = 90_000;
const DEFAULT_HERMES_CLI_SILENCE_TIMEOUT_MS = 30 * 60_000;
// `context_engine` is a real Hermes toolset whose static definition is empty.
// Using a made-up name looked equivalent in unit tests, but Hermes printed an
// "Unknown toolsets" warning into quiet stdout and some builds fell back to the
// configured CLI tool surface. A real zero-tool profile makes caller-loop
// ownership explicit and keeps native skill/terminal loops from racing Agentis.
const HERMES_CALLER_LOOP_TOOLSET = 'context_engine';

export interface HermesAgentAdapterOptions {
  agentId: string;
  binaryPath?: string;
  cwd?: string;
  model?: string;
  chatTransport?: 'cli' | 'acp' | 'auto';
  maxTurns?: number;
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
  graceSec?: number;
  /**
   * Agentis-managed operating instructions. The chat executor injects the current
   * overlay into every turn; the adapter never overwrites runtime-owned files.
   */
  instructions?: string | null;
  workspaceId?: string;
  sessionStore?: RuntimeSessionStore;
  /**
   * Agentis MCP servers to mount into the harness so it calls Agentis tools
   * natively over MCP (real tools, real workspace state) and runs its own
   * agentic loop in ONE invocation — no marker-protocol re-spawn. When set, chat
   * runs over ACP (streaming) with these servers mounted. (UNIVERSAL-HARNESS §5.)
   */
  mcpServers?: McpHarnessServer[];
  logger: Logger;
}

export class HermesAgentAdapter implements AgentAdapter {
  readonly adapterType = 'hermes_agent' as const;
  readonly #handlers = new Set<(event: NormalizedAgentEvent) => void>();
  readonly #inFlight = new Map<string, AbortController>();
  #client: AcpClient | undefined;
  #clientReady: Promise<AcpClient> | undefined;
  #processGeneration = Date.now();
  #prewarmReady: Promise<void> | undefined;
  #prewarmedSession: {
    sessionId: string;
    processGeneration: number;
    models?: AcpModelInfo[];
  } | undefined;
  #activeSessionId: string | undefined;
  /**
   * Epoch ms until which `auto` transport should skip ACP and go straight to the
   * CLI, set after an ACP attempt stalled and fell back. 0 = ACP enabled.
   */
  #acpDisabledUntil = 0;
  #turnTail: Promise<void> = Promise.resolve();
  #version: string | null = null;
  readonly #sessions = new Map<string, {
    sessionId: string;
    processGeneration: number;
    selectedModel: string | null;
    createdAt: string;
    updatedAt: string;
  }>();
  /** Real model list advertised by the harness in `session/new` (cached per process). */
  #models: AcpModelInfo[] = [];

  constructor(private readonly opts: HermesAgentAdapterOptions) {}

  getWorkdir(): string | undefined { return this.opts.cwd; }

  async connect(): Promise<void> {
    if (!shouldPrewarmHermesOnConnect(this.opts.env) || this.#chatTransport() === 'cli' || this.#prewarmReady || this.#prewarmedSession) return;
    const startupTimeoutMs = boundedTimeout(
      process.env.AGENTIS_HERMES_STARTUP_TIMEOUT_MS,
      DEFAULT_HERMES_STARTUP_TIMEOUT_MS,
      MAX_HERMES_STARTUP_TIMEOUT_MS,
      DEFAULT_HERMES_STARTUP_TIMEOUT_MS,
    );
    this.#prewarmReady = this.#prewarm(startupTimeoutMs).catch((err) => {
      this.#prewarmReady = undefined;
      this.opts.logger.warn('hermes_agent.acp.prewarm_failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async disconnect(): Promise<void> {
    for (const controller of this.#inFlight.values()) controller.abort();
    this.#inFlight.clear();
    this.#client?.dispose();
    this.#client = undefined;
    this.#clientReady = undefined;
    this.#prewarmReady = undefined;
    this.#prewarmedSession = undefined;
    this.#activeSessionId = undefined;
  }

  async healthCheck(): Promise<AdapterHealthStatus> {
    const result = await probeCliRuntime({
      binary: this.opts.binaryPath || 'hermes',
      cwd: this.opts.cwd,
      env: this.opts.env,
      logger: this.opts.logger,
      logTag: 'hermes_agent',
      // Hermes is a Python CLI: `--version` cold-starts the interpreter + venv in
      // ~4s and spikes higher under load. The shared 5s default trips on a healthy
      // runtime, so give it real headroom (env-overridable).
      timeoutMs: hermesProbeTimeoutMs(),
    });
    this.#version = result.version;
    return result.health;
  }

  capabilities(): AdapterCapabilities {
    const acp = this.#chatTransport() !== 'cli';
    const mcpNative = acp && (this.opts.mcpServers?.length ?? 0) > 0;
    return {
      interactiveChat: true,
      // ACP owns its tool loop. It can reach Agentis tools only when an Agentis
      // MCP server is actually mounted; ACP transport alone is not MCP access.
      toolCalling: !acp || mcpNative,
      toolForwarding: mcpNative ? 'mcp_native' : acp ? 'session_event' : 'marker_protocol',
      ...(!acp ? {
        limitations: [
          'Using the stable Hermes CLI chat transport. Set chatTransport to acp or auto to use the experimental ACP stream.',
        ],
      } : {}),
      execution: {
        longRunning: true,
        pausable: true,
        sandbox: 'process',
        maxConcurrent: 1,
      },
      affordances: {
        fileSystem: true,
        terminal: true,
        ...(mcpNative ? { nativeMcp: true } : {}),
      },
      memory: {
        ingestible: true,
        injectable: true,
      },
      capabilityManifest: nativeRuntimeCapabilities([
        'interaction.chat',
        ...(!acp || mcpNative ? ['interaction.tool-calling' as const] : []),
        'execution.file-system',
        'execution.terminal',
        'execution.long-running',
        'execution.pausable',
        ...(mcpNative ? ['protocol.native-mcp' as const] : []),
        'memory.inject',
        'memory.ingest',
      ], {
        limits: { 'execution.long-running': { maxConcurrent: 1 } },
      }),
    };
  }

  async prepare(): Promise<void> {
    // Auto caller-loop work is intentionally served by the model-only CLI path
    // (see chat()). Prewarming ACP for those runs creates a second Hermes process
    // that competes for the same plugin/state locks and made the first CLI round
    // take minutes. Only an explicitly ACP-pinned runtime should be prewarmed.
    if (this.#chatTransport() !== 'acp' || this.#prewarmedSession) return;
    const startupTimeoutMs = boundedTimeout(
      process.env.AGENTIS_HERMES_STARTUP_TIMEOUT_MS,
      DEFAULT_HERMES_STARTUP_TIMEOUT_MS,
      MAX_HERMES_STARTUP_TIMEOUT_MS,
      DEFAULT_HERMES_STARTUP_TIMEOUT_MS,
    );
    this.#prewarmReady ??= this.#prewarm(startupTimeoutMs).catch((err) => {
      this.#prewarmReady = undefined;
      this.opts.logger.warn('hermes_agent.prewarm.failed', { agentId: this.opts.agentId, error: (err as Error).message });
    });
    await this.#prewarmReady;
  }

  async getRuntimeContext(): Promise<RuntimeContext> {
    const currentModel = this.opts.model ?? 'hermes-agent-default';
    // After the first chat turn we know the harness's REAL model catalog (from
    // ACP session/new) — surface it so the runtime picker offers actual choices
    // instead of a placeholder. Bare names (sans provider prefix) match how
    // Agentis stores the selection.
    const models = this.#models.length > 0
      ? this.#models.map((m) => ({
        id: m.name ?? m.modelId,
        label: m.name ?? m.modelId,
        source: 'runtime' as const,
        verified: true,
      }))
      : [{
        id: currentModel,
        label: currentModel,
        source: this.opts.model ? 'agent_config' as const : 'fallback' as const,
        verified: Boolean(this.opts.model),
      }];
    return {
      provider: 'hermes_agent',
      models,
      currentModel,
      currentModelSource: this.opts.model ? 'agent_config' : 'runtime',
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
        warm: Boolean(this.#client),
        generation: this.#processGeneration,
        activeSessions: this.#sessions.size,
      },
    };
  }

  async listRuntimeSessions(): Promise<RuntimeSessionInfo[]> {
    if (this.opts.sessionStore && this.opts.workspaceId) {
      return this.opts.sessionStore.list(this.opts.workspaceId, this.opts.agentId);
    }
    return [...this.#sessions.entries()].map(([sessionKey, session]) => ({
      id: `${this.opts.agentId}:${sessionKey}`,
      sessionKey,
      runtimeSessionId: session.sessionId,
      status: 'idle',
      selectedModel: session.selectedModel,
      processGeneration: session.processGeneration,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastUsedAt: session.updatedAt,
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
    if (this.#chatTransport() !== 'cli') {
      this.#dispatchTaskAcp(task);
      return;
    }

    const controller = new AbortController();
    const unlinkAbort = linkAbortSignal(task.signal, controller);
    this.#inFlight.set(task.taskId, controller);
    const binary = this.opts.binaryPath || 'hermes';
    const { args, cleanup } = this.#buildChatInvocation(buildPrompt(task));
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
      this.#emitFailure(task, `hermes_agent_spawn_failed: ${(err as Error).message}`);
      cleanup();
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
      // An operator cancellation tears down the Windows process tree and can
      // surface here as AbortError. It is not a task failure and must not race a
      // CANCELLED run with a late FAILED event.
      if (!controller.signal.aborted && !task.signal?.aborted) {
        this.#emitFailure(task, `hermes_agent_error: ${err.message}`);
      }
      cleanup();
      unlinkAbort();
      this.#inFlight.delete(task.taskId);
      if (timeout) clearTimeout(timeout);
    });
    let stderrTail = '';
    childProcess.stderr?.on('data', (data) => {
      const chunk = String(data);
      stderrTail = `${stderrTail}${chunk}`.slice(-1024);
      this.opts.logger.warn('hermes_agent.stderr', { data: chunk.slice(0, 512) });
    });

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
        const parsed = parseJson(line);
        if (!parsed) {
          transcript += line + '\n';
          this.#emitProgress(task, line, timestamp());
          continue;
        }
        const text = extractText(parsed);
        if (text) {
          transcript += text;
          this.#emitProgress(task, text, timestamp());
        }
        const toolCall = extractToolCall(parsed);
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
        if (isCompletionEvent(parsed)) lastOutput = extractOutput(parsed, transcript);
      }
    });

    childProcess.on('exit', (code) => {
      cleanup();
      unlinkAbort();
      this.#inFlight.delete(task.taskId);
      if (timeout) clearTimeout(timeout);
      if (terminalEventEmitted) return;
      terminalEventEmitted = true;
      // taskkill can report a clean exit even though the operator cancelled the
      // run. Never translate that exit into the false "Agent task completed"
      // event that used to repaint a cancelled node as running/completed.
      if (controller.signal.aborted || task.signal?.aborted) return;
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
        this.#emitFailure(task, `hermes_agent exited ${code}: ${stderrTail.trim() || 'see logs'}`);
      }
    });

    // The prompt is passed as the `-q` argument (hermes chat reads no stdin in
    // quiet mode), so close stdin immediately.
    childProcess.stdin?.end();
  }

  /**
   * Run workflow/background work through the same persistent ACP session used by
   * interactive chat. This is the only Hermes transport that can both stream its
   * live reasoning/tool activity and reach Agentis through the mounted MCP server.
   * The explicit `cli` compatibility mode keeps the legacy one-shot dispatcher.
   */
  #dispatchTaskAcp(task: NormalizedTask): void {
    const controller = new AbortController();
    const unlinkAbort = linkAbortSignal(task.signal, controller);
    this.#inFlight.set(task.taskId, controller);
    const timestamp = () => new Date().toISOString();
    this.#emit({
      eventType: 'task.started',
      agentId: this.opts.agentId,
      taskId: task.taskId,
      runId: task.runId,
      workflowId: task.workflowId,
      timestamp: timestamp(),
    });

    void (async () => {
      let transcript = '';
      let failure = '';
      try {
        const messages: ChatMessage[] = [
          {
            role: 'system',
            content: this.opts.instructions?.trim()
              || 'You are a Hermes agent operating inside Agentis. Complete the task, report useful progress, and return concrete artifacts when available.',
          },
          { role: 'user', content: buildPrompt(task) },
        ];
        for await (const delta of this.chat(messages, [], {
          signal: controller.signal,
          sessionKey: `task:${task.taskId}`,
          latencyClass: 'deliberate',
          timeoutMs: task.timeoutMs,
        })) {
          if (controller.signal.aborted || task.signal?.aborted) break;
          if (delta.type === 'text' && delta.delta) {
            transcript += delta.delta;
            this.#emitProgress(task, delta.delta, timestamp(), { kind: 'commentary' });
          } else if (delta.type === 'activity') {
            this.#emitProgress(task, delta.detail?.trim() || delta.label, timestamp(), {
              activityId: delta.id,
              kind: delta.phase === 'tool' ? 'tool' : delta.phase === 'waiting' ? 'waiting' : /reason/i.test(delta.label) ? 'reasoning' : 'runtime',
              phase: delta.phase,
              status: delta.status,
              transport: delta.transport,
              startedAt: delta.startedAt,
              completedAt: delta.completedAt,
              durationMs: delta.durationMs,
            });
          } else if (delta.type === 'tool_result' && delta.error) {
            failure = delta.error;
          } else if (delta.type === 'done') {
            if (controller.signal.aborted || task.signal?.aborted || delta.finishReason === 'interrupted') break;
            if (delta.finishReason === 'error') {
              this.#emitFailure(task, failure || 'Hermes ACP task failed.');
            } else {
              this.#emit({
                eventType: 'task.completed',
                agentId: this.opts.agentId,
                runId: task.runId,
                workflowId: task.workflowId,
                taskId: task.taskId,
                output: { text: transcript.trim() },
                timestamp: timestamp(),
              });
            }
          }
        }
      } catch (err) {
        // Aborting an ACP prompt rejects the stream. Cancellation is already a
        // terminal run state owned by the engine, so do not repaint it as a
        // provider failure after the operator has stopped the run.
        if (!controller.signal.aborted && !task.signal?.aborted) {
          this.#emitFailure(task, `hermes_agent_acp_failed: ${(err as Error).message}`);
        }
      } finally {
        unlinkAbort();
        this.#inFlight.delete(task.taskId);
      }
    })();
  }

  async cancelTask(taskId: string): Promise<void> {
    this.#inFlight.get(taskId)?.abort();
    this.#inFlight.delete(taskId);
  }

  /**
   * Build a `hermes chat` invocation for one headless turn.
   *
   * The prompt is ALWAYS delivered inline as the `-q` query so Hermes treats it as
   * the prompt to ACT ON. We deliberately NEVER use Hermes's `@file:` syntax: that
   * attaches the file as a DOCUMENT, so the model reads it back ("The content from
   * the specified file is too long … first 500 lines … Agentis interactive chat
   * session …") instead of acting — a real failure operators hit. When a full chat
   * prompt (system context + tool catalog + history) would exceed the OS command
   * line, we trim its MIDDLE to fit, preserving the tool protocol + identity (head)
   * and the operator's request + recent context (tail). An acted-upon trimmed
   * prompt beats a complete-but-echoed one. Hermes resolves to a direct `.exe`, so
   * the budget is the 32767-char Windows CreateProcess limit (env-overridable).
   *
   * `-Q` (quiet) is the documented programmatic mode: it suppresses the
   * banner/spinner/tool previews and prints only the final response to stdout
   * (the `session_id:` line goes to stderr). `--max-turns` and `-m` are
   * `chat`-subcommand flags — NOT top-level ones (passing `--max-turns` at the
   * top level is the "unrecognized arguments" crash this adapter used to hit).
   * `--yolo` avoids a TTY approval hang.
   *
   * `cleanup()` is retained for call-site symmetry but is now a no-op (no temp file).
   */
  #buildChatInvocation(
    prompt: string,
    model = this.opts.model,
    options: { callerManagedTools?: boolean } = {},
  ): { args: string[]; cleanup: () => void } {
    const baseArgs = (queryArg: string): string[] => options.callerManagedTools
      ? [
          // `-z` is Hermes' script-oriented, final-answer-only path. It bypasses
          // the classic chat shell/session UI and, paired with a real zero-tool
          // toolset, guarantees exactly one provider round. Agentis owns every
          // subsequent tool/result round through the marker protocol.
          '-z', queryArg,
          ...(model ? ['-m', model] : []),
          '-t', HERMES_CALLER_LOOP_TOOLSET,
          '--ignore-rules',
          '--yolo',
          ...(this.opts.extraArgs ?? []),
        ]
      : [
          'chat',
          '-q', queryArg,
          '-Q',
          ...(model ? ['-m', model] : []),
          // Codex parity: no native turn cap by default — a stale
          // `--max-turns 24` killed long runs mid-task. Pass it ONLY when
          // explicitly set; otherwise let Hermes run to completion.
          ...(this.opts.maxTurns && this.opts.maxTurns > 0 ? ['--max-turns', String(this.opts.maxTurns)] : []),
          '--ignore-rules',
          '--yolo',
          ...(this.opts.extraArgs ?? []),
        ];

    const limit = hermesInlinePromptLimit();
    const query = prompt.length <= limit ? prompt : truncateHermesPromptToInline(prompt, limit);
    return { args: baseArgs(query), cleanup: () => {} };
  }

  async *chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatInvocationOptions,
  ): AsyncIterable<ChatDelta> {
    const transport = this.#chatTransport();
    if (transport === 'cli') {
      yield* this.#chatCli(messages, tools, options);
      return;
    }
    const callerCanPreserveTools = options?.toolMode === 'caller_loop'
      && options.transportRecovery === 'capability_preserving';
    if (transport === 'auto' && callerCanPreserveTools) {
      // ACP is useful only when Hermes owns its native MCP/tool loop. A caller-
      // managed Agentis turn cannot consume that loop and previously paid a
      // guaranteed 20s probe before launching the same CLI chat uses. Go directly
      // to the capability-equivalent model-only path; explicit `acp` remains a pin.
      yield* this.#chatCli(messages, tools, options);
      return;
    }
    if (transport === 'auto' && options?.latencyClass === 'interactive') {
      // Human-facing channel/chat turns optimize for response latency. The
      // installed Hermes ACP can pass its handshake yet stall before the model
      // call, so probing it on every fresh process adds ~30s before the proven
      // CLI path even begins. Background/deep work still probes ACP for native
      // streaming + MCP; interactive auto turns take the reliable path now.
      yield* this.#chatCli(messages, tools, options);
      return;
    }
    if (transport === 'auto' && Date.now() < this.#acpDisabledUntil) {
      // ACP stalled recently in this environment — don't re-pay the startup +
      // first-event probe every turn; serve straight from the stable CLI until
      // the cooldown elapses, then ACP is re-attempted on the next turn.
      yield* this.#chatCli(messages, tools, options);
      return;
    }
    // CLI cannot inherit ACP-mounted MCP by itself. It is capability-equivalent
    // only when Agentis owns the caller loop and supplied the same tool catalogue;
    // in that mode marker calls come back to ChatSessionExecutor for enforcement.
    const allowCliFallback = transport === 'auto'
      && ((this.opts.mcpServers?.length ?? 0) === 0 || callerCanPreserveTools);

    const releaseTurn = await this.#acquireTurn();
    const queue = createChatQueue();
    const sessionKey = options?.sessionKey?.trim() || 'default';
    const attempt = runtimeAttemptFromSessionKey(sessionKey);
    const configuredTimeoutMs = this.opts.timeoutSec && this.opts.timeoutSec > 0
      ? this.opts.timeoutSec * 1000
      : DEFAULT_CHAT_TURN_TIMEOUT_MS;
    const requestedRoundMs = Math.max(30_000, options?.timeoutMs ?? configuredTimeoutMs);
    const hardCeilingMs = chatHardCeilingMs(requestedRoundMs, 'AGENTIS_HERMES_CHAT_HARD_CEILING_MS');
    const interactive = options?.latencyClass === 'interactive';
    const firstEventTimeoutMs = boundedTimeout(
      interactive
        ? (process.env.AGENTIS_HERMES_INTERACTIVE_FIRST_EVENT_TIMEOUT_MS ?? process.env.AGENTIS_HERMES_FIRST_EVENT_TIMEOUT_MS)
        : process.env.AGENTIS_HERMES_FIRST_EVENT_TIMEOUT_MS,
      interactive ? DEFAULT_HERMES_INTERACTIVE_FIRST_EVENT_TIMEOUT_MS : DEFAULT_HERMES_FIRST_EVENT_TIMEOUT_MS,
      Math.min(hardCeilingMs, MAX_HERMES_FIRST_EVENT_TIMEOUT_MS),
      MIN_HERMES_FIRST_EVENT_TIMEOUT_MS,
    );
    const startupTimeoutMs = boundedTimeout(
      process.env.AGENTIS_HERMES_STARTUP_TIMEOUT_MS,
      DEFAULT_HERMES_STARTUP_TIMEOUT_MS,
      MAX_HERMES_STARTUP_TIMEOUT_MS,
      DEFAULT_HERMES_STARTUP_TIMEOUT_MS,
    );
    let settled = false;
    let fallbackStarted = false;
    let client: AcpClient | undefined;
    let sessionId = '';
    let firstEventSeen = false;
    let firstEventTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    let waitingStartedAt = 0;
    const turnState: HermesAcpTurnState = {
      sessionKey,
      agentId: this.opts.agentId,
      thoughtText: '',
      toolLabels: new Map(),
    };

    const finish = (deltas: ChatDelta[]) => {
      if (settled) return;
      settled = true;
      if (firstEventTimer) clearTimeout(firstEventTimer);
      if (hardTimer) clearTimeout(hardTimer);
      for (const delta of deltas) queue.push(delta);
      queue.close();
    };
    const fallbackToCli = async (code: string, message: string) => {
      if (settled || fallbackStarted) return;
      fallbackStarted = true;
      settled = true;
      // Trip the breaker: this environment's ACP build couldn't deliver, so route
      // the next turns straight to the CLI instead of re-burning the probe.
      const cooldownMs = hermesAcpStallCooldownMs();
      if (cooldownMs > 0) this.#acpDisabledUntil = Date.now() + cooldownMs;
      this.opts.logger.warn('hermes_agent.acp.fallback_to_cli', {
        code,
        cooldownMs,
        agentId: this.opts.agentId,
      });
      if (firstEventTimer) clearTimeout(firstEventTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (client) {
        void client.cancel(sessionId);
        this.#invalidateClient(client);
      }
      if (this.opts.sessionStore && this.opts.workspaceId) {
        this.opts.sessionStore.markStatus(this.opts.workspaceId, this.opts.agentId, sessionKey, 'stale');
      }
      queue.push({
        type: 'activity',
        id: `hermes-fallback-${sessionKey}`,
        label: 'Switching Hermes transport',
        detail: `${code}: ${message}`,
        phase: 'runtime',
        status: 'running',
        transport: 'hermes_cli',
        attempt,
        startedAt: new Date().toISOString(),
        durationMs: waitingStartedAt ? Date.now() - waitingStartedAt : undefined,
        agentId: this.opts.agentId,
      });
      try {
        for await (const delta of this.#chatCli(messages, tools, options)) {
          if (delta.type === 'tool_result' && delta.id === 'adapter' && delta.error) {
            const acpElapsedMs = waitingStartedAt ? Date.now() - waitingStartedAt : undefined;
            queue.push({
              ...delta,
              error: `Hermes recovery failed: stage=first_meaningful_event transport=hermes_acp${acpElapsedMs != null ? ` elapsedMs=${acpElapsedMs}` : ''} reason=${code}; stage=fallback transport=hermes_cli error=${delta.error}. Retry or resume the node after checking the Hermes provider/runtime.`,
            });
          } else {
            queue.push(delta);
          }
        }
      } catch (err) {
        queue.push({
          type: 'tool_result',
          id: 'adapter',
          name: 'adapter.chat',
          result: null,
          error: `hermes_cli_fallback_failed: ${(err as Error).message}`,
        });
        queue.push({ type: 'done', finishReason: 'error' });
      } finally {
        queue.close();
      }
    };
    const failTurn = (code: string, message: string) => {
      if (allowCliFallback && !firstEventSeen && isHermesAcpFallbackEligible(code)) {
        void fallbackToCli(code, message);
        return;
      }
      if (client) {
        void client.cancel(sessionId);
        this.#invalidateClient(client);
      }
      if (this.opts.sessionStore && this.opts.workspaceId) {
        this.opts.sessionStore.markStatus(this.opts.workspaceId, this.opts.agentId, sessionKey, 'stale');
      }
      finish([
        { type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error: `${code}: ${message}` },
        { type: 'done', finishReason: 'error' },
      ]);
    };

    void (async () => {
      try {
        queue.push({
          type: 'activity',
          id: `hermes-runtime-${sessionKey}`,
          label: 'Starting Hermes runtime',
          detail: 'Connecting to the persistent ACP runtime.',
          phase: 'runtime',
          status: 'running',
          transport: 'hermes_acp',
          attempt,
          startedAt: new Date().toISOString(),
          agentId: this.opts.agentId,
        });
        client = await this.#ensureClient(startupTimeoutMs);
        queue.push({
          type: 'activity',
          id: `hermes-runtime-${sessionKey}`,
          label: 'Hermes runtime ready',
          phase: 'runtime',
          status: 'success',
          transport: 'hermes_acp',
          attempt,
          completedAt: new Date().toISOString(),
          agentId: this.opts.agentId,
        });
        queue.push({
          type: 'activity',
          id: `hermes-session-${sessionKey}`,
          label: 'Opening Hermes session',
          detail: 'Preparing the conversation and runtime tools.',
          phase: 'runtime',
          status: 'running',
          transport: 'hermes_acp',
          attempt,
          startedAt: new Date().toISOString(),
          agentId: this.opts.agentId,
        });
        const turnServers = withHarnessTurnHeaders(
          this.opts.mcpServers ?? [],
          options?.executionMode ?? 'chat',
          { conversationId: options?.conversationId, turnLease: options?.turnLease, approvalSensitivity: options?.approvalSensitivity },
        );
        const session = await this.#openSession(client, sessionKey, startupTimeoutMs, turnServers, Boolean(options?.turnLease));
        queue.push({
          type: 'activity',
          id: `hermes-session-${sessionKey}`,
          label: 'Hermes session ready',
          phase: 'runtime',
          status: 'success',
          transport: 'hermes_acp',
          attempt,
          completedAt: new Date().toISOString(),
          agentId: this.opts.agentId,
        });
        sessionId = session.sessionId;
        this.#activeSessionId = sessionId;
        if (session.models?.length) this.#models = session.models;

        const requestedModel = options?.preferredModel ?? this.opts.model;
        const resolvedModelId = resolveAcpModelId(requestedModel, session.models ?? this.#models);
        if (resolvedModelId && session.selectedModel !== resolvedModelId) {
          queue.push({
            type: 'activity',
            id: `hermes-model-${sessionKey}`,
            label: `Selecting ${requestedModel ?? resolvedModelId}`,
            phase: 'runtime',
            status: 'running',
            transport: 'hermes_acp',
            attempt,
            startedAt: new Date().toISOString(),
            agentId: this.opts.agentId,
          });
          await withDeadline(
            client.setModel(sessionId, resolvedModelId),
            startupTimeoutMs,
            'model_selection_timeout',
          );
          session.selectedModel = resolvedModelId;
          this.#persistSession(sessionKey, sessionId, resolvedModelId, 'active');
          queue.push({
            type: 'activity',
            id: `hermes-model-${sessionKey}`,
            label: `Using ${requestedModel ?? resolvedModelId}`,
            phase: 'runtime',
            status: 'success',
            transport: 'hermes_acp',
            attempt,
            completedAt: new Date().toISOString(),
            agentId: this.opts.agentId,
          });
        } else if (requestedModel && !resolvedModelId) {
          this.opts.logger.warn('hermes_agent.acp.model_not_offered', { requested: requestedModel });
        }

        queue.push({
          type: 'activity',
          id: `hermes-wait-${sessionKey}`,
          label: 'Waiting for Hermes',
          detail: requestedModel
            ? `The runtime is waiting for ${requestedModel}. Provider silence is allowed.`
            : 'The runtime is waiting for its configured provider. Provider silence is allowed.',
          phase: 'waiting',
          status: 'running',
          transport: 'hermes_acp',
          attempt,
          startedAt: new Date().toISOString(),
          agentId: this.opts.agentId,
        });
        waitingStartedAt = Date.now();

        firstEventTimer = setTimeout(() => {
          const secs = Math.round(firstEventTimeoutMs / 1000);
          failTurn(
            'first_event_timeout',
            interactive
              ? `Hermes opened a session but streamed no model output within ${secs}s (the ACP transport can stall before producing output).`
              : `Hermes produced no model event within ${secs} seconds.`,
          );
        }, firstEventTimeoutMs);
        firstEventTimer.unref?.();
        hardTimer = setTimeout(() => {
          failTurn(
            'hard_deadline',
            `Hermes exceeded the ${Math.round(hardCeilingMs / 1000)} second turn ceiling.`,
          );
        }, hardCeilingMs);
        hardTimer.unref?.();
        abortHandler = () => failTurn('canceled', 'The operator canceled this turn.');
        options?.signal?.addEventListener('abort', abortHandler, { once: true });

        const result = await client.sessionPrompt(
          { sessionId, prompt: [{ type: 'text', text: appendRuntimeInputAttachments(formatAcpPrompt(messagesForRuntimeSession(messages, session.resumed)), options?.inputAttachments) }] },
          (update) => {
            const delta = acpUpdateToDelta(update, turnState);
            // Lifecycle metadata (usage/command catalogs) is not model output.
            // Counting it as the first event left a broken ACP prompt hanging
            // forever because the first-output watchdog was cleared too early.
            if (delta) {
              if (!firstEventSeen) {
                firstEventSeen = true;
                if (firstEventTimer) clearTimeout(firstEventTimer);
                queue.push({
                  type: 'activity',
                  id: `hermes-wait-${sessionKey}`,
                  label: 'Hermes responded',
                  detail: 'The provider produced the first meaningful model or tool event.',
                  phase: 'waiting',
                  status: 'success',
                  transport: 'hermes_acp',
                  attempt,
                  completedAt: new Date().toISOString(),
                  durationMs: waitingStartedAt ? Date.now() - waitingStartedAt : undefined,
                  agentId: this.opts.agentId,
                });
              }
              if (!settled) queue.push(delta);
            }
          },
        );
        if (firstEventTimer) clearTimeout(firstEventTimer);
        this.#persistSession(sessionKey, sessionId, session.selectedModel, 'idle');
        const finishReason: Extract<ChatDelta, { type: 'done' }>['finishReason'] =
          result.stopReason === 'max_tokens' || result.stopReason === 'max_turn_requests' ? 'max_turns' : 'stop';
        finish([{ type: 'done', finishReason }]);
      } catch (err) {
        if (!settled) {
          const message = err instanceof Error ? err.message : String(err);
          failTurn(classifyHermesError(message), message);
        }
      } finally {
        if (abortHandler) options?.signal?.removeEventListener('abort', abortHandler);
        if (this.#activeSessionId === sessionId) this.#activeSessionId = undefined;
      }
    })();

    try {
      yield* queue.iterate();
    } finally {
      if (firstEventTimer) clearTimeout(firstEventTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (abortHandler) options?.signal?.removeEventListener('abort', abortHandler);
      releaseTurn();
    }
  }

  async *#chatCli(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatInvocationOptions,
  ): AsyncIterable<ChatDelta> {
    const configuredTimeoutMs = this.opts.timeoutSec && this.opts.timeoutSec > 0
      ? this.opts.timeoutSec * 1000
      : DEFAULT_CHAT_TURN_TIMEOUT_MS;
    const idleTimeoutMs = Math.max(30_000, options?.timeoutMs ?? configuredTimeoutMs);
    const requestedModel = normalizeHermesCliModel(options?.preferredModel) ?? normalizeHermesCliModel(this.opts.model);
    const callerManagedTools = options?.toolMode === 'caller_loop';
    const invocation = this.#buildChatInvocation(
      appendRuntimeInputAttachments(buildHermesCliPrompt(messages, tools, { callerManagedTools }), options?.inputAttachments),
      requestedModel,
      { callerManagedTools },
    );
    const cliStartedAt = Date.now();
    const cliActivityId = `hermes-cli-${options?.sessionKey ?? 'default'}`;
    const attempt = runtimeAttemptFromSessionKey(options?.sessionKey);

    yield {
      type: 'activity',
      id: cliActivityId,
      label: 'Starting Hermes',
      detail: callerManagedTools
        ? 'Hermes model-only turn; Agentis owns tool execution and preserves each tool boundary.'
        : 'Hermes exposes only the final answer in this mode, not live reasoning or tool activity.',
      phase: 'runtime',
      status: 'running',
      transport: 'hermes_cli',
      attempt,
      startedAt: new Date().toISOString(),
      agentId: this.opts.agentId,
    };

    try {
      for await (const delta of runCliChatTurn({
        binary: this.opts.binaryPath || 'hermes',
        args: invocation.args,
        cwd: this.opts.cwd,
        env: this.opts.env,
        stdin: '',
        displayName: 'Hermes',
        logTag: 'hermes_agent.chat',
        logger: this.opts.logger,
        signal: options?.signal,
        idleTimeoutMs,
        hardCeilingMs: hermesCliSilenceTimeoutMs(options?.latencyClass),
        progressVisibility: 'final_only',
        activityId: cliActivityId,
        transport: 'hermes_cli',
        attempt,
        // Hermes -Q is documented as final-answer-only, but native file edits can
        // still leak ANSI "review diff" previews to stdout. Those previews are
        // runtime activity, not the assistant's answer, and previously replaced
        // the node's structured result.
        keepRawFallbackLine: isHermesQuietAnswerLine,
        interpret: interpretHermesQuietEvent,
        formatExitError: (_code, stderr, stdoutErr) => formatHermesExitError(stderr, stdoutErr),
        onEmptyResult: () => {
          this.opts.logger.warn('hermes_agent.chat.empty_result', {
            agentId: this.opts.agentId,
            sessionKey: options?.sessionKey ?? 'default',
          });
        },
      })) {
        if (delta.type === 'done') {
          const requestedTool = delta.finishReason === 'tool_calls';
          yield {
            type: 'activity',
            id: cliActivityId,
            label: delta.finishReason === 'stop'
              ? 'Hermes CLI responded'
              : requestedTool
                ? 'Hermes CLI requested an Agentis tool'
                : 'Hermes CLI stopped',
            phase: 'runtime',
            // `tool_calls` is a healthy round boundary. ChatSessionExecutor now
            // executes the requested Agentis tool and starts the next round; it
            // must not flash as a runtime failure in the operations trace.
            status: delta.finishReason === 'stop' || requestedTool ? 'success' : 'error',
            transport: 'hermes_cli',
            attempt,
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - cliStartedAt,
            agentId: this.opts.agentId,
          };
        }
        if (
          delta.type === 'tool_result'
          && delta.id === 'adapter'
          && options?.signal?.aborted
        ) {
          yield {
            ...delta,
            error: 'canceled: The operator canceled this turn.',
          };
          continue;
        }
        yield delta;
      }
    } finally {
      invocation.cleanup();
    }
  }

  #chatTransport(): 'cli' | 'acp' | 'auto' {
    const configured = this.opts.chatTransport
      ?? this.opts.env?.AGENTIS_HERMES_CHAT_TRANSPORT
      ?? process.env.AGENTIS_HERMES_CHAT_TRANSPORT;
    const normalized = configured?.trim().toLowerCase();
    if (normalized === 'cli') return 'cli';
    if (normalized === 'acp') return 'acp';
    if (normalized === 'auto') return 'auto';
    return 'auto';
  }

  async #acquireTurn(): Promise<() => void> {
    const previous = this.#turnTail;
    let release!: () => void;
    this.#turnTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  async #ensureClient(startupTimeoutMs: number): Promise<AcpClient> {
    if (this.#client) return this.#client;
    if (this.#clientReady) return this.#clientReady;
    this.#clientReady = (async () => {
      let client: AcpClient;
      client = new AcpClient({
        command: this.opts.binaryPath || 'hermes',
        args: ['acp'],
        cwd: this.opts.cwd,
        env: this.opts.env,
        logger: this.opts.logger,
        logTag: 'hermes_agent.acp',
        stderrLogLevel: 'none',
        onPermission: (request) => {
          this.opts.logger.debug?.('hermes_agent.permission_requested', {
            tool: request.toolCall?.title ?? request.toolCall?.kind ?? 'unknown',
          });
          return null;
        },
        onClose: () => {
          if (this.#client === client) {
            this.#client = undefined;
            this.#clientReady = undefined;
            this.#prewarmReady = undefined;
            this.#prewarmedSession = undefined;
            this.#activeSessionId = undefined;
          }
        },
      });
      try {
        client.start();
        await withDeadline(client.initialize(), startupTimeoutMs, 'handshake_timeout');
        this.#processGeneration += 1;
        this.#client = client;
        return client;
      } catch (err) {
        client.dispose();
        throw err;
      } finally {
        if (!this.#client) this.#clientReady = undefined;
      }
    })();
    return this.#clientReady;
  }

  async #prewarm(startupTimeoutMs: number): Promise<void> {
    const client = await this.#ensureClient(startupTimeoutMs);
    if (this.#prewarmedSession?.processGeneration === this.#processGeneration) return;
    const created = await withDeadline(
      client.sessionNew({
        cwd: this.opts.cwd ?? process.cwd(),
        mcpServers: toAcpHttpMcpServers(this.opts.mcpServers ?? []),
      }),
      startupTimeoutMs,
      'session_prewarm_timeout',
    );
    if (created.models?.length) this.#models = created.models;
    this.#prewarmedSession = {
      sessionId: created.sessionId,
      processGeneration: this.#processGeneration,
      models: created.models,
    };
  }

  async #openSession(
    client: AcpClient,
    sessionKey: string,
    startupTimeoutMs: number,
    serverDescriptors: McpHarnessServer[] = this.opts.mcpServers ?? [],
    forceReload = false,
  ): Promise<{
    sessionId: string;
    models?: AcpModelInfo[];
    selectedModel: string | null;
    resumed: boolean;
  }> {
    const sessionCwd = this.opts.cwd ?? process.cwd();
    const mcpServers = toAcpHttpMcpServers(serverDescriptors);
    if (!forceReload && this.#prewarmReady) await this.#prewarmReady;
    const memorySession = this.#sessions.get(sessionKey);
    if (!forceReload && memorySession?.processGeneration === this.#processGeneration) {
      return {
        sessionId: memorySession.sessionId,
        models: this.#models,
        selectedModel: memorySession.selectedModel,
        resumed: true,
      };
    }

    const stored = this.opts.sessionStore && this.opts.workspaceId
      ? this.opts.sessionStore.get(this.opts.workspaceId, this.opts.agentId, sessionKey)
      : null;
    const persistedId = memorySession?.sessionId
      ?? (stored?.processGeneration === this.#processGeneration ? stored.runtimeSessionId : undefined);
    if (persistedId) {
      try {
        const loaded = await withDeadline(
          client.sessionLoad({ cwd: sessionCwd, sessionId: persistedId, mcpServers }),
          startupTimeoutMs,
          'session_load_timeout',
        );
        const now = new Date().toISOString();
        this.#sessions.set(sessionKey, {
          sessionId: loaded.sessionId,
          processGeneration: this.#processGeneration,
          selectedModel: memorySession?.selectedModel ?? stored?.selectedModel ?? null,
          createdAt: memorySession?.createdAt ?? stored?.createdAt ?? now,
          updatedAt: now,
        });
        this.#persistSession(
          sessionKey,
          loaded.sessionId,
          memorySession?.selectedModel ?? stored?.selectedModel ?? null,
          'active',
        );
        return {
          sessionId: loaded.sessionId,
          models: loaded.models ?? this.#models,
          selectedModel: memorySession?.selectedModel ?? stored?.selectedModel ?? null,
          resumed: true,
        };
      } catch (err) {
        this.opts.logger.warn('hermes_agent.acp.session_load_failed', {
          sessionKey,
          sessionId: persistedId,
          err: (err as Error).message,
        });
      }
    }

    const prewarmed = forceReload ? undefined : this.#prewarmedSession;
    if (prewarmed?.processGeneration === this.#processGeneration) {
      this.#prewarmedSession = undefined;
      const now = new Date().toISOString();
      this.#sessions.set(sessionKey, {
        sessionId: prewarmed.sessionId,
        processGeneration: this.#processGeneration,
        selectedModel: null,
        createdAt: now,
        updatedAt: now,
      });
      this.#persistSession(sessionKey, prewarmed.sessionId, null, 'active');
      return {
        sessionId: prewarmed.sessionId,
        models: prewarmed.models ?? this.#models,
        selectedModel: null,
        resumed: false,
      };
    }

    const created = await withDeadline(
      client.sessionNew({ cwd: sessionCwd, mcpServers }),
      startupTimeoutMs,
      'session_open_timeout',
    );
    const now = new Date().toISOString();
    this.#sessions.set(sessionKey, {
      sessionId: created.sessionId,
      processGeneration: this.#processGeneration,
      selectedModel: null,
      createdAt: now,
      updatedAt: now,
    });
    this.#persistSession(sessionKey, created.sessionId, null, 'active');
    return { sessionId: created.sessionId, models: created.models, selectedModel: null, resumed: false };
  }

  #persistSession(
    sessionKey: string,
    sessionId: string,
    selectedModel: string | null,
    status: RuntimeSessionInfo['status'],
  ): void {
    const now = new Date().toISOString();
    const existing = this.#sessions.get(sessionKey);
    this.#sessions.set(sessionKey, {
      sessionId,
      processGeneration: this.#processGeneration,
      selectedModel,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    if (this.opts.sessionStore && this.opts.workspaceId) {
      this.opts.sessionStore.upsert({
        workspaceId: this.opts.workspaceId,
        agentId: this.opts.agentId,
        conversationId: sessionKey,
        sessionKey,
        runtimeSessionId: sessionId,
        processGeneration: this.#processGeneration,
        selectedModel,
        status,
      });
    }
  }

  #invalidateClient(client: AcpClient): void {
    if (this.#client === client) {
      this.#client = undefined;
      this.#clientReady = undefined;
      this.#prewarmReady = undefined;
      this.#prewarmedSession = undefined;
      this.#activeSessionId = undefined;
    }
    client.dispose();
  }

  #emitProgress(
    task: NormalizedTask,
    message: string,
    timestamp: string,
    metadata: Omit<Extract<NormalizedAgentEvent, { eventType: 'task.progress' }>, 'eventType' | 'agentId' | 'runId' | 'workflowId' | 'taskId' | 'message' | 'timestamp'> = {},
  ): void {
    this.#emit({
      eventType: 'task.progress',
      agentId: this.opts.agentId,
      runId: task.runId,
      workflowId: task.workflowId,
      taskId: task.taskId,
      message,
      timestamp,
      ...metadata,
    });
  }

  #emit(event: NormalizedAgentEvent): void {
    for (const handler of this.#handlers) {
      try {
        handler(event);
      } catch (err) {
        this.opts.logger.error('hermes_agent.handler_threw', { err: (err as Error).message });
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

/**
 * Map one ACP `session/update` to an Agentis `ChatDelta`, or null to ignore it.
 * The agent's OWN tool calls (it ran them over MCP) surface as live activity —
 * never as executable `tool_call` deltas, so Agentis doesn't re-run them.
 */
interface HermesAcpTurnState {
  sessionKey: string;
  agentId: string;
  thoughtText: string;
  toolLabels: Map<string, string>;
}

function acpUpdateToDelta(update: AcpSessionUpdate, state: HermesAcpTurnState): ChatDelta | null {
  switch (update.sessionUpdate) {
    case 'agent_thought_chunk': {
      const text = textOf(update.content);
      if (!text) return null;
      state.thoughtText += text;
      return runtimeProgressActivity({
        id: `hermes-thought-${state.sessionKey}`,
        runtimeName: 'Hermes',
        text: state.thoughtText,
        reasoning: true,
        agentId: state.agentId,
        transport: 'hermes_acp',
      });
    }
    case 'agent_message_chunk': {
      const text = textOf(update.content);
      state.thoughtText = '';
      return text ? { type: 'text', delta: text } : null;
    }
    case 'tool_call': {
      const u = update as { toolCallId?: string; title?: string; kind?: string };
      const label = u.title?.trim() || prettyToolName(u.kind) || 'a tool';
      const toolCallId = u.toolCallId ?? randomUUID();
      state.toolLabels.set(toolCallId, label);
      return hermesToolActivity(toolCallId, label, String(update.status ?? 'running'));
    }
    case 'tool_call_update': {
      const u = update as { toolCallId?: string; title?: string; status?: string };
      const toolCallId = u.toolCallId ?? randomUUID();
      const label = u.title?.trim() || state.toolLabels.get(toolCallId) || 'a tool';
      state.toolLabels.set(toolCallId, label);
      return hermesToolActivity(toolCallId, label, u.status ?? 'running');
    }
    default:
      // usage_update / available_commands_update / plan are not operator-facing
      // execution events.
      return null;
  }
}

function hermesToolActivity(toolCallId: string, label: string, rawStatus: string): Extract<ChatDelta, { type: 'activity' }> {
  const status = rawStatus.toLowerCase();
  const failed = /fail|error|cancel/.test(status);
  const completed = failed || /complete|success|done|finished/.test(status);
  return {
    type: 'activity',
    id: `hermes-${toolCallId}`,
    phase: 'tool',
    status: failed ? 'error' : completed ? 'success' : 'running',
    transport: 'hermes_acp',
    label: failed ? `Failed ${label}` : completed ? `Used ${label}` : `Using ${label}`,
    ...(completed
      ? { completedAt: new Date().toISOString() }
      : { startedAt: new Date().toISOString() }),
  };
}

/**
 * Resolve the operator-configured model name against the model ids the agent
 * advertised in `session/new`. Harnesses namespace ids by provider
 * (`nous:anthropic/claude-opus-4.5`), while Agentis config stores the bare name
 * (`anthropic/claude-opus-4.5`) — so match exact id, then exact display name,
 * then provider-prefixed suffix.
 */
function resolveAcpModelId(requested: string | null | undefined, models: AcpModelInfo[] | undefined): string | null {
  const wanted = requested?.trim();
  if (!wanted || !models?.length) return null;
  const exact = models.find((m) => m.modelId === wanted);
  if (exact) return exact.modelId;
  const byName = models.find((m) => m.name === wanted);
  if (byName) return byName.modelId;
  const bySuffix = models.find((m) => m.modelId.endsWith(`:${wanted}`) || m.modelId.endsWith(`/${wanted}`));
  return bySuffix?.modelId ?? null;
}

function normalizeHermesCliModel(model: string | null | undefined): string | undefined {
  const value = model?.trim();
  if (!value || value === 'hermes-auto' || value === 'hermes-agent-default') return undefined;
  return value;
}

function hermesInlinePromptLimit(): number {
  // Windows CreateProcess caps a command line at 32767 chars; Hermes resolves to
  // a direct `.exe` (Node passes argv straight through), so we can use most of it
  // and only reserve headroom for the binary path + the handful of flags. Bigger
  // than before on purpose: every char that fits inline is a char that does NOT
  // have to be trimmed, and inline is the only delivery that Hermes acts on (never
  // `@file:`). Env-overridable for tighter shells.
  const raw = Number(process.env.AGENTIS_HERMES_INLINE_PROMPT_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30_000;
}

/**
 * Trim an over-long prompt to fit inline, removing the MIDDLE. Keeps the head (the
 * marker tool protocol + AUTHORITATIVE IDENTITY RULE) and the tail (recent history
 * + the operator's actual request), which are the parts the agent must act on, and
 * drops the bulky middle (older context / platform knowledge). A trimmed prompt the
 * model ACTS on is far better than a complete one it echoes back via `@file:`.
 */
function truncateHermesPromptToInline(prompt: string, limit: number): string {
  const marker = '\n\n…[earlier context trimmed to fit the runtime prompt limit — act on the TOOL PROTOCOL above and the OPERATOR REQUEST below; call agentis tools to fetch anything you still need]…\n\n';
  const budget = Math.max(0, limit - marker.length);
  const head = Math.floor(budget * 0.6);
  const tail = budget - head;
  return `${prompt.slice(0, head)}${marker}${prompt.slice(prompt.length - tail)}`;
}

function hermesProbeTimeoutMs(): number {
  const raw = Number(process.env.AGENTIS_HERMES_PROBE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8_000;
}

function hermesAcpStallCooldownMs(): number {
  const raw = Number(process.env.AGENTIS_HERMES_ACP_STALL_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_HERMES_ACP_STALL_COOLDOWN_MS;
}

function shouldPrewarmHermesOnConnect(env: Record<string, string> | undefined): boolean {
  const value = env?.AGENTIS_HERMES_PREWARM_ON_CONNECT ?? process.env.AGENTIS_HERMES_PREWARM_ON_CONNECT;
  return value === '1' || value?.toLowerCase() === 'true';
}

/**
 * Codes that mean "ACP couldn't deliver this turn" and so, in `auto` transport,
 * should transparently retry on the stable CLI transport instead of hard-failing.
 *
 * `first_event_timeout` is the most common one: the session opens fine but the
 * current Hermes ACP build stalls before streaming any model output. Without it
 * in this set, the adapter used to dead-end on a fabricated "gateway not running"
 * error instead of falling back to the CLI path the other harnesses use.
 */
function isHermesAcpFallbackEligible(code: string): boolean {
  return code === 'handshake_timeout'
    || code === 'session_prewarm_timeout'
    || code === 'session_load_timeout'
    || code === 'session_open_timeout'
    || code === 'model_selection_timeout'
    || code === 'first_event_timeout';
}

function boundedTimeout(raw: string | undefined, fallback: number, maximum: number, minimum = 1_000): number {
  const parsed = Number(raw);
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.max(minimum, Math.min(Math.floor(value), maximum));
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

/**
 * Build a useful exit-error detail for a failed `hermes chat -Q`.
 *
 * Hermes prints its REAL failure to STDOUT as plain text (e.g. "API call failed
 * after 3 retries: HTTP 404: No endpoints found for openrouter/owl-alpha.") and
 * always writes a `session_id: <id>` line to STDERR on exit — which is NOT an
 * error. Surfacing that stderr line gave the useless "Hermes exited 1: session_id:
 * …". Prefer the stdout error, strip the session_id/noise from stderr, and turn a
 * dead/removed model into a one-step fix.
 */
function formatHermesExitError(stderr: string, stdoutErr: string): string {
  const cleanStderr = stderr
    .split('\n')
    .filter((line) => !/^\s*session_id\s*:/i.test(line))
    .join('\n')
    .trim();
  const detail = (stdoutErr || '').trim() || cleanStderr;
  // Out of credits: OpenRouter/Nous returns 402 "This request requires more
  // credits, or fewer max_tokens…". A depleted account is the single most common
  // reason a Hermes turn dies, and the raw JSON blob buries it — name it and point
  // at the two real fixes (top up, or switch to a model you can afford / a free one).
  if (/\b402\b/.test(detail) || /requires more credits|add more credits|insufficient(?:\s+\w+)?\s+credit|not enough credits/i.test(detail)) {
    return `${detail} — your inference provider account is out of credits. Add credits (e.g. https://openrouter.ai/settings/credits) or switch this agent to a model you can afford (chat header model picker / agent settings, or \`hermes model\`).`;
  }
  // Auth/quota: a missing or invalid key surfaces as 401/403. Point at credentials
  // rather than leaving the operator to decode an HTTP status.
  if (/\b40[13]\b/.test(detail) || /invalid api key|unauthorized|not authenticated|no auth credentials|missing.*api.*key/i.test(detail)) {
    return `${detail} — the inference provider rejected the request as unauthenticated. Check this agent's provider API key (OpenRouter/Nous credentials in Hermes's .env or config).`;
  }
  // Rate limited: 429 / "rate limit". Free models hit this constantly; tell the
  // operator to retry or move to a less-contended model.
  if (/\b429\b/.test(detail) || /rate.?limit/i.test(detail)) {
    return `${detail} — the provider is rate-limiting this model (common on free tiers). Retry in a moment, or switch this agent to a less-contended model.`;
  }
  // Removed / unavailable model: OpenRouter returns 404 "No endpoints found for
  // <model>" (e.g. a retired stealth model). Make the fix obvious instead of a
  // cryptic HTTP code.
  const noEndpoints = detail.match(/no endpoints found for\s+([^\s."']+)/i);
  if (noEndpoints || /http\s*404/i.test(detail)) {
    const model = noEndpoints?.[1];
    return `${detail}${model ? ` — the model "${model}" is no longer available from the provider. Switch this agent's model (chat header model picker / agent settings, or \`hermes model\`) to an available one.` : ' — switch this agent to an available model.'}`;
  }
  return detail;
}

function classifyHermesError(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('handshake_timeout')) return 'handshake_timeout';
  if (normalized.includes('session_load_timeout')) return 'session_load_timeout';
  if (normalized.includes('session_open_timeout')) return 'session_open_timeout';
  if (normalized.includes('model_selection_timeout')) return 'model_selection_timeout';
  if (normalized.includes('auth') || normalized.includes('credential') || normalized.includes('api key')) {
    return 'authentication_failed';
  }
  if (normalized.includes('process error') || normalized.includes('exited')) return 'runtime_exited';
  return 'runtime_failed';
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
    ? raw.replace(/^mcp__[^_]+__/, '').replace(/[._]/g, ' ').trim()
    : '';
}

/**
 * Build the stdin prompt for the Hermes CLI (compatibility) transport.
 *
 * Unlike the ACP path, the one-shot CLI has NO MCP server mounted — so the agent
 * gets its tools the same way Codex/Claude Code do on their CLI path: the shared
 * marker-tool protocol (`buildMarkerToolPrompt`), which also tells the model it
 * IS Agentis and that there is no local filesystem to inspect. Without this, the
 * model falls back to its own built-in tools and narrates the operating manual as
 * "a prompt file from a previous session" instead of acting as the agent. The
 * AUTHORITATIVE IDENTITY RULE pins the SYSTEM/operating-manual block as the
 * agent's real identity over any Hermes product/persona defaults.
 */
function buildHermesCliPrompt(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  options: { callerManagedTools?: boolean } = {},
): string {
  const toolProtocol = tools.length > 0
    ? buildMarkerToolPrompt(tools, { compact: true, nativeTools: !options.callerManagedTools })
    : [
      'Agentis interactive chat session.',
      'Answer the operator naturally and directly. If the SYSTEM message defines an <agentis_identity> block, treat that as your identity for this turn.',
    ].join('\n');
  return [
    toolProtocol,
    '',
    'AUTHORITATIVE IDENTITY RULE:',
    'The SYSTEM message below is the Agentis operating prompt for this turn. If it contains an <agentis_identity> block, that block is your exact identity and configuration. Follow it over Hermes product defaults, project/home instruction files, previous resumed-session identity, or generic assistant persona text.',
    '',
    'Conversation:',
    formatAcpPrompt(messages),
  ].join('\n');
}

/**
 * Flatten the chat history into a single ACP prompt block. Tools come over MCP,
 * so — unlike the old marker path — NO tool catalog or marker instructions are
 * injected; the agent discovers the real tool surface and workspace state by
 * calling the mounted Agentis MCP server.
 */
function formatAcpPrompt(messages: ChatMessage[]): string {
  return messages.map((message) => {
    const content = typeof message.content === 'string' ? message.content : safeJson(message.content);
    if (message.role === 'system') return content;
    if (message.role === 'tool') return `TOOL RESULT (${message.toolCallId ?? 'unknown'}):\n${content}`;
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return ['ASSISTANT:', content, 'REQUESTED TOOLS:', safeJson(message.toolCalls)].join('\n');
    }
    return `${message.role.toUpperCase()}:\n${content}`;
  }).join('\n\n');
}

function hermesCliSilenceTimeoutMs(latencyClass: ChatInvocationOptions['latencyClass'] | undefined): number {
  const interactive = latencyClass === 'interactive';
  const raw = interactive
    ? (process.env.AGENTIS_HERMES_INTERACTIVE_CLI_SILENCE_TIMEOUT_MS
      ?? process.env.AGENTIS_HERMES_CLI_SILENCE_TIMEOUT_MS)
    : process.env.AGENTIS_HERMES_CLI_SILENCE_TIMEOUT_MS;
  const fallback = interactive
    ? DEFAULT_HERMES_INTERACTIVE_CLI_SILENCE_TIMEOUT_MS
    : DEFAULT_HERMES_CLI_SILENCE_TIMEOUT_MS;
  return boundedTimeout(raw, fallback, 30 * 60_000, 30_000);
}

function appendRuntimeInputAttachments(prompt: string, attachments?: RuntimeInputAttachment[]): string {
  if (!attachments?.length) return prompt;
  return [
    prompt,
    '',
    '<runtime_input_attachments>',
    'These are files attached by the user. Inspect them directly with your file/image tools before answering; never infer their contents from filenames.',
    ...attachments.map((attachment) => `- ${attachment.name} (${attachment.mimeType}): ${attachment.path}`),
    '</runtime_input_attachments>',
  ].join('\n');
}

type HermesJsonEvent = {
  type?: unknown;
  text?: unknown;
  content?: unknown;
  message?: unknown;
  delta?: unknown;
  item?: unknown;
  result?: unknown;
  output?: unknown;
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

function parseJson(line: string): HermesJsonEvent | null {
  try {
    return JSON.parse(line) as HermesJsonEvent;
  } catch {
    return null;
  }
}

function extractText(event: HermesJsonEvent): string {
  const direct = firstString(event.text, event.content, event.delta);
  if (direct) return direct;
  const message = objectOf(event.message);
  const messageText = firstString(message?.text, message?.content);
  if (messageText) return messageText;
  const item = objectOf(event.item);
  return firstString(item?.text, item?.content) ?? '';
}

function isHermesQuietAnswerLine(line: string): boolean {
  if (/\u001b\[[0-9;?]*[ -/]*[@-~]/.test(line)) return false;
  if (/^\s*[┊│]?\s*review diff\s*$/i.test(line)) return false;
  if (/^\s*warning:\s*unknown toolsets?:/i.test(line)) return false;
  if (/^\s*session_id:\s*\S+/i.test(line)) return false;
  return true;
}

function interpretHermesQuietEvent(event: unknown): { kind: 'final'; text: string } | { kind: 'ignore' } {
  const parsed = event && typeof event === 'object' && !Array.isArray(event)
    ? event as Record<string, unknown>
    : null;
  if (!parsed) return { kind: 'ignore' };
  const text = extractText(parsed);
  if (text) return { kind: 'final', text };
  // In -Q mode a correct workflow agent often prints the requested strict JSON
  // object directly. The shared CLI reader parses that line before its raw-text
  // fallback; treating an untyped object as an unknown event used to discard the
  // entire answer. Typed Hermes lifecycle/tool events remain ignored.
  if (!('type' in parsed) && Object.keys(parsed).length > 0) {
    return { kind: 'final', text: JSON.stringify(parsed) };
  }
  return { kind: 'ignore' };
}

function extractToolCall(event: HermesJsonEvent): { tool: string; input: unknown } | null {
  const type = String(event.type ?? '').toLowerCase();
  if (!type.includes('tool') && !type.includes('function')) return null;
  const item = objectOf(event.item);
  const tool = firstString(event.name, event.tool, item?.name, item?.tool) ?? 'tool';
  return { tool, input: event.input ?? event.arguments ?? item?.input ?? item?.arguments ?? {} };
}

function isCompletionEvent(event: HermesJsonEvent): boolean {
  const type = String(event.type ?? '').toLowerCase();
  return type === 'result' || type === 'done' || type.includes('completed') || type.includes('finished');
}

function extractOutput(event: HermesJsonEvent, transcript: string): Record<string, unknown> {
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
