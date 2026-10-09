/**
 * acpClient — a minimal client for the Agent Client Protocol (ACP), the
 * JSON-RPC-over-stdio protocol that editor-grade harnesses (Hermes `acp`, and
 * increasingly Codex/Gemini/Claude) speak for streaming, tool-using turns.
 *
 * Why this exists: the marker protocol hands a CLI a giant text prompt and parses
 * tool-call markers out of its output, re-spawning the process per round. That
 * makes the agent feel *external* — it reads a document instead of acting inside
 * the platform, and quiet/one-shot modes show no live thinking. ACP fixes both:
 * the harness runs ONE agentic loop, calls real tools mounted over MCP, and
 * streams `session/update` notifications (thinking, tool calls, answer deltas) as
 * it works. This client drives that conversation.
 *
 * Wire format (verified against `hermes acp` v0.16.0): newline-delimited
 * JSON-RPC 2.0 over stdio. Flow:
 *   initialize → session/new { cwd, mcpServers } → session/prompt { sessionId,
 *   prompt } …streaming session/update notifications… → result { stopReason }.
 * The agent may call back to the client (session/request_permission, fs/*); we
 * handle those so an autonomous tool-using turn never blocks on a TTY prompt.
 *
 * This module is transport-only and harness-agnostic; adapters map ACP updates
 * to Agentis `ChatDelta`s.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from '../logger.js';
import { resolveSpawnCwd, resolveSpawnTarget, withExpandedPath } from '../services/pathExpander.js';
import { linkAbortSignal } from './abort.js';

/** An MCP server descriptor in ACP's `session/new` shape (HTTP transport). */
export interface AcpHttpMcpServer {
  type: 'http';
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

/** Content blocks Agentis sends to ACP-capable runtimes. */
export interface AcpTextBlock {
  type: 'text';
  text: string;
}

export interface AcpImageBlock {
  type: 'image';
  data: string;
  mimeType: string;
  uri?: string;
}

export type AcpPromptBlock = AcpTextBlock | AcpImageBlock;

/** A model offered by the agent, surfaced from `session/new`. */
export interface AcpModelInfo {
  modelId: string;
  name: string;
  description?: string;
}

export interface AcpSessionNewResult {
  sessionId: string;
  models?: AcpModelInfo[];
}

export interface AcpSessionLoadResult {
  sessionId: string;
  models?: AcpModelInfo[];
}

/**
 * The discriminated `session/update` payloads we act on. ACP defines more; the
 * rest pass through as `{ sessionUpdate: string }` and are ignored by adapters.
 */
export type AcpSessionUpdate =
  | { sessionUpdate: 'agent_thought_chunk'; content: { type: string; text?: string } }
  | { sessionUpdate: 'agent_message_chunk'; content: { type: string; text?: string } }
  | { sessionUpdate: 'tool_call'; toolCallId: string; title?: string; kind?: string; status?: string; rawInput?: unknown }
  | { sessionUpdate: 'tool_call_update'; toolCallId: string; title?: string; status?: string }
  | { sessionUpdate: 'usage_update'; size?: number; used?: number }
  | { sessionUpdate: string; [key: string]: unknown };

export interface AcpPromptResult {
  stopReason: string;
  [key: string]: unknown;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface AcpClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  logger: Logger;
  /** Log namespace, e.g. "hermes_agent.acp". */
  logTag: string;
  /** Caller's cancellation signal; aborts the child and rejects in-flight calls. */
  signal?: AbortSignal;
  /**
   * Resolve an agent→client `session/request_permission`. Return the chosen
   * `optionId`, or null to let the client auto-pick an allow option. Defaults to
   * deny by default so an autonomous tool-using turn cannot silently escalate.
   */
  onPermission?: (params: PermissionRequest) => string | null;
  /** Stderr from ACP children is often verbose provider/runtime noise. */
  stderrLogLevel?: 'debug' | 'none';
  /**
   * Fired on ANY child activity (every stdout line and stderr chunk). Lets the
   * caller run an idle watchdog that is not fooled by a long boot or a long
   * model round: as long as the harness is logging, it is alive.
   */
  onActivity?: () => void;
  onClose?: (error: string | null) => void;
}

export interface PermissionRequest {
  options?: Array<{ optionId: string; name?: string; kind?: string }>;
  toolCall?: { title?: string; kind?: string };
  [key: string]: unknown;
}

const JSONRPC_METHOD_NOT_FOUND = -32601;

/**
 * Drives one ACP conversation over a child process's stdio. Construct, `start()`,
 * run a turn, then `dispose()`. Not safe for concurrent prompts on one instance
 * (one turn per process), which matches how chat turns are dispatched.
 */
export class AcpClient {
  readonly #controller = new AbortController();
  readonly #unlinkAbort: () => void;
  readonly #pending = new Map<number, { resolve: (msg: JsonRpcMessage) => void; reject: (err: Error) => void }>();
  #child: ChildProcess | undefined;
  #buffer = '';
  #stderrTail = '';
  #nextId = 1;
  #closed = false;
  #exitError: string | null = null;

  constructor(private readonly opts: AcpClientOptions) {
    this.#unlinkAbort = linkAbortSignal(opts.signal, this.#controller);
  }

  /** Spawn the harness in ACP mode and begin reading its JSON-RPC stream. */
  start(): void {
    const env = withExpandedPath({ ...process.env, ...(this.opts.env ?? {}) });
    // Self-heal a vanished workdir so a present binary can't throw the misleading
    // `spawn <binary> ENOENT` (Windows reports a missing cwd against the command).
    const cwd = resolveSpawnCwd(this.opts.cwd, { create: true });
    const target = resolveSpawnTarget(this.opts.command, this.opts.args ?? [], cwd ?? process.cwd(), env);
    this.#child = spawn(target.command, target.args, {
      cwd,
      env,
      windowsHide: true,
      signal: this.#controller.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child.stderr?.on('data', (data) => {
      const chunk = String(data);
      this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-2048);
      if (this.opts.stderrLogLevel !== 'none') {
        this.opts.logger.debug?.(`${this.opts.logTag}.stderr`, { data: chunk.slice(0, 256) });
      }
      this.opts.onActivity?.();
    });
    this.#child.stdout?.on('data', (chunk) => this.#onStdout(String(chunk)));
    this.#child.on('error', (err) => this.#fail(`${this.opts.logTag} process error: ${err.message}`));
    this.#child.on('exit', (code) => this.#fail(code === 0 ? null : `${this.opts.logTag} exited ${code}: ${this.#stderrTail.trim().slice(-300) || 'no detail'}`));
  }

  /** ACP handshake. Resolves with the agent's capabilities. */
  async initialize(): Promise<unknown> {
    const res = await this.#request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    return res.result;
  }

  /** Open a session, mounting the given MCP servers so the agent gets real tools. */
  async sessionNew(params: { cwd: string; mcpServers: AcpHttpMcpServer[] }): Promise<AcpSessionNewResult> {
    const res = await this.#request('session/new', params);
    const result = (res.result ?? {}) as { sessionId?: string; models?: { availableModels?: AcpModelInfo[] } };
    if (!result.sessionId) throw new Error('ACP session/new returned no sessionId');
    return { sessionId: result.sessionId, models: result.models?.availableModels };
  }

  async sessionLoad(params: {
    cwd: string;
    sessionId: string;
    mcpServers: AcpHttpMcpServer[];
  }): Promise<AcpSessionLoadResult> {
    const res = await this.#request('session/load', params);
    if (res.result == null) throw new Error(`ACP session/load could not find ${params.sessionId}`);
    const result = (res.result ?? {}) as { models?: { availableModels?: AcpModelInfo[] } };
    return { sessionId: params.sessionId, models: result.models?.availableModels };
  }

  async sessionResume(params: {
    cwd: string;
    sessionId: string;
    mcpServers: AcpHttpMcpServer[];
  }): Promise<AcpSessionLoadResult> {
    const res = await this.#request('session/resume', params);
    const result = (res.result ?? {}) as {
      sessionId?: string;
      models?: { availableModels?: AcpModelInfo[] };
    };
    return {
      sessionId: result.sessionId ?? params.sessionId,
      models: result.models?.availableModels,
    };
  }

  /**
   * Send a prompt and stream the agent's work. `onUpdate` fires for every
   * `session/update` notification until the turn ends; the promise resolves with
   * the final `{ stopReason }`.
   */
  async sessionPrompt(
    params: { sessionId: string; prompt: AcpPromptBlock[] },
    onUpdate: (update: AcpSessionUpdate, sessionId: string) => void,
  ): Promise<AcpPromptResult> {
    this.#updateHandler = onUpdate;
    try {
      const res = await this.#request('session/prompt', params);
      return (res.result ?? { stopReason: 'end_turn' }) as AcpPromptResult;
    } finally {
      this.#updateHandler = undefined;
    }
  }

  /**
   * Switch the session's model (`session/set_model`, verified against Hermes
   * v0.16.0 — returns `{}` on success). `modelId` must be one of the ids the
   * agent listed in `session/new` (e.g. `nous:anthropic/claude-opus-4.5`).
   */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.#request('session/set_model', { sessionId, modelId });
  }

  /** Best-effort cancel of the active turn. */
  async cancel(sessionId: string): Promise<void> {
    if (this.#closed) return;
    try {
      this.#notify('session/cancel', { sessionId });
    } catch {
      // The dispose() below tears the process down regardless.
    }
  }

  /** Terminate the child and reject any in-flight calls. */
  dispose(): void {
    this.#fail(this.#exitError);
    this.#unlinkAbort();
    try {
      this.#controller.abort();
    } catch {
      // already aborted
    }
  }


  #updateHandler: ((update: AcpSessionUpdate, sessionId: string) => void) | undefined;

  #onStdout(chunk: string): void {
    this.opts.onActivity?.();
    this.#buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, newlineIndex).trim();
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        // ACP is pure JSON-RPC; any non-JSON line is harness log noise.
        this.opts.logger.debug?.(`${this.opts.logTag}.non_json`, { line: line.slice(0, 200) });
        continue;
      }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg: JsonRpcMessage): void {
    // Agent → client REQUEST (has both method and id): permission / fs / terminal.
    if (msg.method && msg.id !== undefined) {
      this.#handleServerRequest(msg);
      return;
    }
    // Agent → client NOTIFICATION (method, no id): session/update and friends.
    if (msg.method) {
      if (msg.method === 'session/update') {
        const params = (msg.params ?? {}) as { sessionId?: string; update?: AcpSessionUpdate };
        if (params.update && this.#updateHandler) this.#updateHandler(params.update, params.sessionId ?? '');
      }
      return;
    }
    // Response to one of our requests.
    if (msg.id !== undefined) {
      const waiter = this.#pending.get(msg.id as number);
      if (!waiter) return;
      this.#pending.delete(msg.id as number);
      if (msg.error) waiter.reject(new Error(`ACP ${msg.error.code}: ${msg.error.message}`));
      else waiter.resolve(msg);
    }
  }

  #handleServerRequest(msg: JsonRpcMessage): void {
    const method = msg.method!;
    if (method === 'session/request_permission') {
      const params = (msg.params ?? {}) as PermissionRequest;
      const chosen = this.opts.onPermission?.(params) ?? selectAllowPermission(params.options);
      if (chosen) {
        this.#respond(msg.id!, { outcome: { outcome: 'selected', optionId: chosen } });
      } else {
        // No allow option offered — cancel rather than hang the turn.
        this.#respond(msg.id!, { outcome: { outcome: 'cancelled' } });
      }
      return;
    }
    // fs/* and terminal/* — we declared no fs capability, so decline cleanly
    // instead of leaving the agent waiting on a response.
    this.#respondError(msg.id!, JSONRPC_METHOD_NOT_FOUND, `client does not support ${method}`);
  }

  #request(method: string, params: unknown): Promise<JsonRpcMessage> {
    if (this.#closed) return Promise.reject(new Error(this.#exitError ?? `${this.opts.logTag} connection closed`));
    const id = this.#nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#child!.stdin!.write(payload);
      } catch (err) {
        this.#pending.delete(id);
        reject(err as Error);
      }
    });
  }

  #notify(method: string, params: unknown): void {
    if (this.#closed) return;
    this.#child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  #respond(id: number | string, result: unknown): void {
    this.#child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  #respondError(id: number | string, code: number, message: string): void {
    this.#child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
  }

  #fail(error: string | null): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#exitError = error;
    const err = new Error(error ?? `${this.opts.logTag} connection closed`);
    for (const waiter of this.#pending.values()) waiter.reject(err);
    this.#pending.clear();
    this.opts.onClose?.(error);
  }
}

function selectAllowPermission(options: PermissionRequest['options']): string | null {
  if (!options?.length) return null;
  const affirmative = options.filter((option) => {
    const text = `${option.kind ?? ''} ${option.name ?? ''}`.toLowerCase();
    return /\b(allow|approve|accept|yes)\b/.test(text)
      && !/\b(deny|reject|cancel|disallow)\b/.test(text);
  });
  const once = affirmative.find((option) => /\b(once|one[-_\s]?time|this time)\b/i.test(`${option.kind ?? ''} ${option.name ?? ''}`));
  return once?.optionId ?? affirmative[0]?.optionId ?? null;
}

/** Convert Agentis MCP header records into ACP's array-of-{name,value} shape. */
export function toAcpHttpMcpServers(
  servers: Array<{ name: string; url: string; headers: Record<string, string> }>,
): AcpHttpMcpServer[] {
  return servers.map((server) => ({
    type: 'http',
    name: server.name,
    url: server.url,
    headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })),
  }));
}
