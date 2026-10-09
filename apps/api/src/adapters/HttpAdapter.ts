/**
 * HttpAdapter — generic HTTP-based agent adapter.
 *
 * Dispatch: POST `${dispatchUrl}` with JSON body `{ task }`.
 * Callback: agent POSTs back to `/v1/adapters/http/callback/:agentId` with
 * HMAC-SHA256 signature in `x-agentis-signature: t=<unix>,v1=<hex>` header.
 * The callback is verified by HttpAdapterCallbackVerifier (in routes layer)
 * which then calls back into adapter.handleCallback().
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  AgentAdapter,
  AdapterCapabilities,
  AdapterHealthStatus,
  AdapterType,
  ChatInvocationOptions,
  ChatMessage,
  ChatDelta,
  ToolDefinition,
  NormalizedAgentEvent,
  NormalizedTask,
  RuntimeContext,
  RuntimeCapabilityDeclaration,
} from '@agentis/core';
import { CONSTANTS } from '@agentis/core';
import type { Logger } from '../logger.js';
import { CircuitBreaker } from './CircuitBreaker.js';
import { assertSafeUrl } from '../services/safeUrl.js';
import { linkAbortSignal } from './abort.js';
import { nativeRuntimeCapabilities } from './runtimeCapabilityDeclarations.js';
import { buildMarkerToolPrompt, extractMarkerToolCalls } from './markerToolProtocol.js';

export interface HttpAdapterOptions {
  agentId: string;
  dispatchUrl: string;
  cancelUrl?: string;
  healthUrl?: string;
  chatUrl?: string;
  supportsTools?: boolean;
  /** Wire format used by the remote chat endpoint. Defaults to Agentis-native. */
  chatProtocol?: 'agentis' | 'openai';
  /** Explicit powers implemented by the remote runtime behind this contract. */
  capabilityManifest?: RuntimeCapabilityDeclaration[];
  model?: string;
  method?: 'POST' | 'GET' | 'PUT' | 'PATCH';
  headers?: Record<string, string>;
  payloadTemplate?: Record<string, unknown>;
  dispatchTimeoutMs?: number;
  chatTimeoutMs?: number;
  /** Shared secret used for both outbound auth header and inbound HMAC. */
  sharedSecret?: string;
  authToken?: string;
  logger: Logger;
}

export class HttpAdapter implements AgentAdapter {
  readonly adapterType = 'http' as const;
  readonly #handlers = new Set<(e: NormalizedAgentEvent) => void>();
  readonly #breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000 });

  constructor(private readonly opts: HttpAdapterOptions) {}

  async connect(): Promise<void> {
    // Stateless adapter; nothing to do at connect.
  }

  async disconnect(): Promise<void> {
    // No persistent connection.
  }

  async healthCheck(): Promise<AdapterHealthStatus> {
    if (this.#breaker.state() === 'open') {
      return { isHealthy: false, checkedAt: new Date().toISOString(), error: 'circuit_breaker_open' };
    }
    if (!this.opts.healthUrl) return { isHealthy: true, checkedAt: new Date().toISOString() };
    try {
      const safe = await assertSafeUrl(this.opts.healthUrl, {
        allowPrivate: String(process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.opts.dispatchTimeoutMs ?? 30_000).unref?.();
      try {
        const res = await fetch(safe, { method: 'HEAD', headers: this.#headers(), signal: controller.signal });
        return { isHealthy: res.ok || res.status === 401, latencyMs: undefined, checkedAt: new Date().toISOString(), ...(res.ok || res.status === 401 ? {} : { error: `status=${res.status}` }) };
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    } catch (err) {
      return { isHealthy: false, error: (err as Error).message, checkedAt: new Date().toISOString() };
    }
  }

  capabilities(): AdapterCapabilities {
    const interactiveChat = Boolean(this.opts.chatUrl);
    return {
      interactiveChat,
      toolCalling: interactiveChat && this.opts.supportsTools === true,
      toolForwarding: interactiveChat && this.opts.supportsTools === true ? 'http_contract' : 'none',
      execution: {
        longRunning: true,
        pausable: false,
        sandbox: 'none',
      },
      affordances: {},
      memory: {
        injectable: true,
      },
      capabilityManifest: nativeRuntimeCapabilities([
        ...(interactiveChat ? ['interaction.chat' as const] : []),
        ...(interactiveChat && this.opts.supportsTools === true ? ['interaction.tool-calling' as const] : []),
        'execution.long-running',
        'memory.inject',
      ], { additional: this.opts.capabilityManifest }),
      ...(!interactiveChat
        ? { limitations: ['Interactive chat is off because this HTTP agent has no chat endpoint. Set `chatUrl` (or `baseUrl` + `chatPath`) in its adapter config to enable it; until then it can only run workflow tasks.'] }
        : this.opts.supportsTools !== true
          ? { limitations: ['HTTP chat endpoint is configured, but `supportsTools` is off, so Agentis tools are not offered to this agent. Enable `supportsTools` to let it build/run workflows from chat.'] }
          : {}),
    };
  }

  async getRuntimeContext(): Promise<RuntimeContext> {
    const currentModel = this.opts.model ?? 'http-default';
    return {
      provider: 'http',
      models: [{ id: currentModel, label: currentModel }],
      currentModel,
      fastModeSupported: false,
    };
  }

  onEvent(handler: (e: NormalizedAgentEvent) => void): void {
    this.#handlers.add(handler);
  }

  async dispatchTask(task: NormalizedTask): Promise<void> {
    const safe = await assertSafeUrl(this.opts.dispatchUrl, {
      allowPrivate: String(process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
    });
    await this.#breaker.exec(async () => {
      const method = this.opts.method ?? 'POST';
      const payload = { ...(this.opts.payloadTemplate ?? {}), task };
      const body = JSON.stringify(payload);
      const ts = Math.floor(Date.now() / 1000);
      const sig = this.opts.sharedSecret ? createHmac('sha256', this.opts.sharedSecret).update(`${ts}.${body}`).digest('hex') : null;
      const controller = new AbortController();
      const unlinkAbort = linkAbortSignal(task.signal, controller);
      const t = setTimeout(() => controller.abort(), this.opts.dispatchTimeoutMs ?? CONSTANTS.AGENT_TASK_RESPONSE_TIMEOUT_MS).unref?.();
      try {
        const dispatchUrl = method === 'GET' ? appendQuery(safe, 'task', body) : safe.toString();
        const res = await fetch(dispatchUrl, {
          method,
          headers: this.#headers(sig ? { 'x-agentis-signature': `t=${ts},v1=${sig}` } : undefined),
          ...(method === 'GET' ? {} : { body }),
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`http_adapter_dispatch_failed status=${res.status}`);
        }
      } finally {
        unlinkAbort();
        if (t) clearTimeout(t);
      }
    });
  }

  async cancelTask(taskId: string): Promise<void> {
    // Best-effort cancel.
    try {
      await this.#breaker.exec(async () => {
        const safe = await assertSafeUrl(this.opts.cancelUrl ?? this.opts.dispatchUrl, {
          allowPrivate: String(process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
        });
        const url = this.opts.cancelUrl ? safe.toString() : `${safe.toString().replace(/\/$/, '')}/cancel/${encodeURIComponent(taskId)}`;
        await fetch(url, { method: 'POST', headers: this.#headers() });
      });
    } catch {
      // ignore
    }
  }

  async *chat(messages: ChatMessage[], tools: ToolDefinition[], options?: ChatInvocationOptions): AsyncIterable<ChatDelta> {
    if (!this.opts.chatUrl) {
      yield { type: 'text', delta: 'This HTTP agent has no chat endpoint configured yet. Add `chatUrl` or `baseUrl + chatPath` to enable interactive chat.' };
      yield { type: 'done', finishReason: 'error' };
      return;
    }
    const safe = await assertSafeUrl(this.opts.chatUrl, {
      allowPrivate: String(process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
    });
    const controller = new AbortController();
    const unlinkAbort = linkAbortSignal(options?.signal, controller);
    const timeout = setTimeout(
      () => controller.abort(),
      options?.timeoutMs ?? this.opts.chatTimeoutMs ?? this.opts.dispatchTimeoutMs ?? CONSTANTS.AGENT_TASK_RESPONSE_TIMEOUT_MS,
    ).unref?.();
    const markerFallback = this.opts.supportsTools !== true
      && options?.toolMode === 'caller_loop'
      && tools.length > 0;
    const requestMessages = markerFallback
      ? [{ role: 'system' as const, content: buildMarkerToolPrompt(tools, { compact: true }) }, ...messages]
      : messages;
    const openAiProtocol = this.opts.chatProtocol === 'openai';
    const toolNames = openAiProtocol ? buildOpenAiToolNameMaps(tools) : null;
    const wireMessages = openAiProtocol ? requestMessages.map((message) => toOpenAiMessage(message, toolNames!.originalToWire)) : requestMessages;
    const wireTools = this.opts.supportsTools === true
      ? openAiProtocol ? tools.map((tool) => toOpenAiTool(tool, toolNames!.originalToWire.get(tool.name) ?? tool.name)) : tools
      : [];
    try {
      const response = await this.#breaker.exec(() => fetch(safe, {
        method: 'POST',
        headers: {
          ...this.#headers(),
          accept: 'text/event-stream, application/json',
        },
        body: JSON.stringify({
          ...(this.opts.payloadTemplate ?? {}),
          agentId: this.opts.agentId,
          model: options?.preferredModel ?? this.opts.model,
          sessionKey: options?.sessionKey,
          timeoutMs: options?.timeoutMs,
          messages: wireMessages,
          tools: wireTools,
          supportsTools: this.opts.supportsTools === true,
        }),
        signal: controller.signal,
      }));
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        yield {
          type: 'tool_result',
          id: 'adapter',
          name: 'adapter.chat',
          result: null,
          error: `HTTP chat failed status=${response.status}${body ? ` ${body.slice(0, 256)}` : ''}`,
        };
        yield { type: 'done', finishReason: 'error' };
        return;
      }
      if (!markerFallback) {
        yield* parseHttpChatResponse(response, toolNames?.wireToOriginal);
      } else {
        let text = '';
        let terminal: Extract<ChatDelta, { type: 'done' }> | undefined;
        for await (const delta of parseHttpChatResponse(response)) {
          if (delta.type === 'text') text += delta.delta;
          else if (delta.type === 'done') terminal = delta;
          else yield delta;
        }
        const { cleaned, calls } = extractMarkerToolCalls(text, tools);
        if (cleaned.trim()) yield { type: 'text', delta: cleaned.trim() };
        for (const call of calls) {
          yield { type: 'tool_call', id: randomUUID(), name: call.name, args: call.args };
        }
        yield {
          type: 'done',
          finishReason: calls.length > 0 ? 'tool_calls' : (terminal?.finishReason ?? 'stop'),
          ...(terminal?.usage ? { usage: terminal.usage } : {}),
        };
      }
    } catch (err) {
      yield {
        type: 'tool_result',
        id: 'adapter',
        name: 'adapter.chat',
        result: null,
        error: (err as Error).message,
      };
      yield { type: 'done', finishReason: 'error' };
    } finally {
      unlinkAbort();
      if (timeout) clearTimeout(timeout);
    }
  }

  /**
   * Verify an inbound callback's HMAC signature, then emit the normalized event.
   * Call this from the route handler.
   */
  handleCallback(args: {
    rawBody: string;
    signatureHeader: string;
    payload: { eventType: NormalizedAgentEvent['eventType']; taskId: string; runId: string } & Record<string, unknown>;
  }): boolean {
    if (!this.opts.sharedSecret) {
      this.opts.logger.warn('http_adapter.callback_no_shared_secret', { agentId: this.opts.agentId });
      return false;
    }
    const ok = verifySignature(args.rawBody, args.signatureHeader, this.opts.sharedSecret);
    if (!ok) {
      this.opts.logger.warn('http_adapter.callback_bad_signature', { agentId: this.opts.agentId });
      return false;
    }
    const at = new Date().toISOString();
    const event = {
      ...args.payload,
      agentId: this.opts.agentId,
      at,
    } as unknown as NormalizedAgentEvent;
    for (const h of this.#handlers) {
      try {
        h(event);
      } catch (err) {
        this.opts.logger.error('http_adapter.handler_threw', { err: (err as Error).message });
      }
    }
    return true;
  }

  breakerState() {
    return this.#breaker.state();
  }

  #headers(extra?: Record<string, string>): Record<string, string> {
    return {
      ...(this.opts.headers ?? {}),
      'content-type': 'application/json',
      ...(this.opts.authToken ? { authorization: `Bearer ${this.opts.authToken}` } : {}),
      ...(extra ?? {}),
      'user-agent': 'Agentis/1.0 (HttpAdapter)',
    };
  }
}

function toOpenAiTool(tool: ToolDefinition, wireName: string): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: wireName,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function toOpenAiMessage(message: ChatMessage, originalToWire: Map<string, string>): Record<string, unknown> {
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: originalToWire.get(call.name) ?? call.name,
          arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
        },
      })),
    };
  }
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    };
  }
  return { role: message.role, content: message.content };
}

function buildOpenAiToolNameMaps(tools: ToolDefinition[]): {
  originalToWire: Map<string, string>;
  wireToOriginal: Map<string, string>;
} {
  const originalToWire = new Map<string, string>();
  const wireToOriginal = new Map<string, string>();
  for (const [index, tool] of tools.entries()) {
    const base = tool.name.replace(/[^A-Za-z0-9_-]/g, '__').slice(0, 58) || `tool_${index + 1}`;
    let wire = base;
    let suffix = 2;
    while (wireToOriginal.has(wire) && wireToOriginal.get(wire) !== tool.name) {
      wire = `${base.slice(0, 55)}_${suffix}`;
      suffix += 1;
    }
    originalToWire.set(tool.name, wire);
    wireToOriginal.set(wire, tool.name);
  }
  return { originalToWire, wireToOriginal };
}

function appendQuery(url: URL, key: string, value: string): string {
  const next = new URL(url.toString());
  next.searchParams.set(key, value);
  return next.toString();
}

function verifySignature(rawBody: string, header: string, secret: string): boolean {
  // header format: "t=<unix>,v1=<hex>"
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const [k, v] = p.split('=');
      return [k?.trim() ?? '', v?.trim() ?? ''];
    }),
  );
  const ts = Number(parts.t ?? 0);
  const sig = String(parts.v1 ?? '');
  if (!ts || !sig) return false;
  const skew = Math.abs(Date.now() / 1000 - ts);
  if (skew > CONSTANTS.WEBHOOK_TIMESTAMP_TOLERANCE_MS / 1000) return false;
  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  if (expected.length !== sig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
}

async function* parseHttpChatResponse(response: Response, toolNameMap?: Map<string, string>): AsyncIterable<ChatDelta> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    yield* parseHttpChatStream(response, toolNameMap);
    return;
  }
  const json = await response.json().catch(() => null) as unknown;
  yield* normalizeHttpChatJson(json, toolNameMap);
}

async function* parseHttpChatStream(response: Response, toolNameMap?: Map<string, string>): AsyncIterable<ChatDelta> {
  const reader = response.body?.getReader();
  if (!reader) {
    yield { type: 'done', finishReason: 'error' };
    return;
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let sawDone = false;
  while (true) {
    const read = await reader.read();
    buffer += decoder.decode(read.value ?? new Uint8Array(), { stream: !read.done });
    let sepIdx: number;
    while ((sepIdx = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + (buffer[sepIdx] === '\r' ? 4 : 2));
      for (const delta of parseHttpStreamBlock(block, toolNameMap)) {
        if (delta.type === 'done') sawDone = true;
        yield delta;
      }
    }
    if (read.done) break;
  }
  for (const delta of parseHttpStreamBlock(buffer, toolNameMap)) {
    if (delta.type === 'done') sawDone = true;
    yield delta;
  }
  if (!sawDone) yield { type: 'done', finishReason: 'stop' };
}

function* parseHttpStreamBlock(block: string, toolNameMap?: Map<string, string>): Iterable<ChatDelta> {
  const trimmed = block.trim();
  if (!trimmed) return;
  const dataLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  const payloads = dataLines.length > 0 ? dataLines : [trimmed];
  for (const payload of payloads) {
    if (!payload || payload === '[DONE]') {
      yield { type: 'done', finishReason: 'stop' };
      continue;
    }
    try {
      yield* normalizeHttpChatJson(JSON.parse(payload) as unknown, toolNameMap);
    } catch {
      yield { type: 'text', delta: payload };
    }
  }
}

export function* normalizeHttpChatJson(value: unknown, toolNameMap?: Map<string, string>): Iterable<ChatDelta> {
  const object = objectOf(value);
  if (!object) {
    yield { type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error: 'HTTP chat returned a non-object JSON payload.' };
    yield { type: 'done', finishReason: 'error' };
    return;
  }
  const error = httpErrorMessage(object.error ?? (object.ok === false ? object : undefined));
  if (error) {
    yield { type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error };
    yield { type: 'done', finishReason: 'error' };
    return;
  }
  const deltas = object.deltas;
  if (Array.isArray(deltas)) {
    let sawDone = false;
    for (const delta of deltas) {
      const normalized = normalizeDelta(delta);
      if (!normalized) continue;
      if (normalized.type === 'done') sawDone = true;
      yield normalized;
    }
    if (!sawDone) yield { type: 'done', finishReason: 'stop' };
    return;
  }

  const directDelta = normalizeDelta(object);
  if (directDelta && object.type) {
    yield directDelta;
    return;
  }

  const text = firstString(object.text, object.content, object.message);
  if (text) yield { type: 'text', delta: text };

  const rawToolCalls = object.toolCalls ?? object.tool_calls ?? object.tools;
  const toolCalls = extractToolCalls(rawToolCalls, toolNameMap);
  for (const call of toolCalls) {
    yield { type: 'tool_call', id: call.id, name: call.name, args: call.args };
  }

  const choice = Array.isArray(object.choices) ? object.choices[0] : null;
  const choiceObject = objectOf(choice);
  if (choiceObject) {
    const delta = objectOf(choiceObject.delta);
    const message = objectOf(choiceObject.message);
    const choiceText = firstString(delta?.content, delta?.text, message?.content, choiceObject.text);
    if (choiceText) yield { type: 'text', delta: choiceText };
    for (const call of extractToolCalls(delta?.tool_calls ?? message?.tool_calls ?? choiceObject.tool_calls, toolNameMap)) {
      yield { type: 'tool_call', id: call.id, name: call.name, args: call.args };
      toolCalls.push(call);
    }
  }

  const finish = firstString(object.finishReason, object.finish_reason, choiceObject?.finish_reason);
  yield { type: 'done', finishReason: finish === 'tool_calls' || toolCalls.length > 0 ? 'tool_calls' : finish === 'error' ? 'error' : 'stop' };
}

function normalizeDelta(value: unknown): ChatDelta | null {
  const object = objectOf(value);
  if (!object) return null;
  const type = firstString(object.type);
  if (type === 'text') return { type: 'text', delta: firstString(object.delta, object.text, object.content) ?? '' };
  if (type === 'thinking') return { type: 'thinking', delta: firstString(object.delta, object.text, object.content) ?? '' };
  if (type === 'activity') {
    const status = firstString(object.status);
    const phase = firstString(object.phase);
    return {
      type: 'activity',
      id: firstString(object.id) ?? `activity_${Math.random().toString(36).slice(2)}`,
      label: firstString(object.label, object.text, object.content) ?? 'Agent activity',
      ...(firstString(object.detail) ? { detail: firstString(object.detail) } : {}),
      phase: phase === 'received' || phase === 'context' || phase === 'runtime' || phase === 'tool' || phase === 'workflow' || phase === 'waiting' || phase === 'complete' || phase === 'error' ? phase : 'runtime',
      status: status === 'success' || status === 'error' ? status : 'running',
      ...(firstString(object.startedAt) ? { startedAt: firstString(object.startedAt) } : {}),
      ...(firstString(object.completedAt) ? { completedAt: firstString(object.completedAt) } : {}),
    };
  }
  if (type === 'tool_call') {
    return {
      type: 'tool_call',
      id: firstString(object.id) ?? `tc_${Math.random().toString(36).slice(2)}`,
      name: firstString(object.name, object.tool, object.toolName) ?? 'tool',
      args: object.args ?? object.arguments ?? object.input ?? {},
    };
  }
  if (type === 'tool_result') {
    return {
      type: 'tool_result',
      id: firstString(object.id) ?? `tr_${Math.random().toString(36).slice(2)}`,
      name: firstString(object.name, object.tool, object.toolName) ?? 'tool',
      result: object.result ?? null,
      ...(object.error ? { error: String(object.error) } : {}),
    };
  }
  if (type === 'done') {
    const reason = firstString(object.finishReason, object.finish_reason);
    return { type: 'done', finishReason: reason === 'tool_calls' || reason === 'error' || reason === 'max_turns' ? reason : 'stop' };
  }
  return null;
}

function httpErrorMessage(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  const object = objectOf(value);
  if (!object) return String(value);
  return firstString(object.message, object.error, object.detail, object.reason) ?? safeStringify(object);
}

function extractToolCalls(value: unknown, toolNameMap?: Map<string, string>): Array<{ id: string; name: string; args: unknown }> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const object = objectOf(item);
    const fn = objectOf(object?.function);
    const rawArgs = fn?.arguments ?? object?.arguments ?? object?.args ?? object?.input ?? {};
    let parsedArgs: unknown = rawArgs;
    if (typeof rawArgs === 'string') {
      try {
        parsedArgs = JSON.parse(rawArgs) as unknown;
      } catch {
        parsedArgs = rawArgs;
      }
    }
    return {
      id: firstString(object?.id) ?? `tc_${Math.random().toString(36).slice(2)}`,
      name: (() => {
        const wireName = firstString(fn?.name, object?.name, object?.tool, object?.toolName) ?? 'tool';
        return toolNameMap?.get(wireName) ?? wireName;
      })(),
      args: parsedArgs,
    };
  });
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
