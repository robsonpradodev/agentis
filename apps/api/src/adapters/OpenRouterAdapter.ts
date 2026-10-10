import type { AgentAdapter, AdapterCapabilities, ChatDelta, ChatInvocationOptions, ChatMessage, NormalizedAgentEvent, NormalizedTask, ToolDefinition } from '@agentis/core';
import { buildOpenAiToolNameMaps, toOpenAiMessage, toOpenAiTool } from './HttpAdapter.js';
import { linkAbortSignal } from './abort.js';
import { nativeRuntimeCapabilities } from './runtimeCapabilityDeclarations.js';
import { OPENROUTER_BASE_URL, OPENROUTER_TIMEOUT_MS, openRouterError, requireOpenRouterToolModel } from '../services/runtime/openRouter.js';

export interface OpenRouterAdapterOptions {
  agentId: string; apiKey: string; model: string; timeoutMs?: number;
  runTask?: (adapter: AgentAdapter, task: NormalizedTask, signal: AbortSignal, progress: (message: string) => void) => Promise<Record<string, unknown>>;
}

/** Inference is remote; Agentis owns history, permissions and tool execution. */
export class OpenRouterAdapter implements AgentAdapter {
  readonly adapterType = 'openrouter' as const;
  readonly #handlers = new Set<(event: NormalizedAgentEvent) => void>();
  readonly #tasks = new Map<string, AbortController>();
  constructor(private readonly opts: OpenRouterAdapterOptions) {}
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> { for (const controller of this.#tasks.values()) controller.abort(); }
  async healthCheck() { return { isHealthy: Boolean(this.opts.apiKey && this.opts.model), checkedAt: new Date().toISOString() }; }
  capabilities(): AdapterCapabilities {
    return {
      interactiveChat: true, toolCalling: true, toolForwarding: 'http_contract',
      execution: { longRunning: Boolean(this.opts.runTask), pausable: false, sandbox: 'none' }, affordances: {}, memory: { injectable: true },
      capabilityManifest: nativeRuntimeCapabilities(['interaction.chat', 'interaction.tool-calling', 'memory.inject', ...(this.opts.runTask ? ['execution.long-running' as const] : [])]),
    };
  }
  async getRuntimeContext() { return { provider: 'OpenRouter', models: [{ id: this.opts.model, label: this.opts.model }], currentModel: this.opts.model, fastModeSupported: false }; }
  onEvent(handler: (event: NormalizedAgentEvent) => void): void { this.#handlers.add(handler); }
  #emit(event: NormalizedAgentEvent): void { for (const handler of this.#handlers) handler(event); }
  async cancelTask(taskId: string): Promise<void> { this.#tasks.get(taskId)?.abort(); }
  async dispatchTask(task: NormalizedTask): Promise<void> {
    if (this.#tasks.has(task.taskId)) return;
    if (!this.opts.runTask) throw new Error('OpenRouter task runner is unavailable.');
    const controller = new AbortController();
    const unlink = linkAbortSignal(task.signal, controller);
    const timer = setTimeout(() => controller.abort(), task.timeoutMs || OPENROUTER_TIMEOUT_MS).unref();
    this.#tasks.set(task.taskId, controller);
    const event = { agentId: this.opts.agentId, taskId: task.taskId, runId: task.runId, workflowId: task.workflowId };
    this.#emit({ ...event, eventType: 'task.started', timestamp: new Date().toISOString() });
    void this.opts.runTask(this, task, controller.signal, (message) => this.#emit({ ...event, eventType: 'task.progress', message, timestamp: new Date().toISOString() }))
      .then((output) => { if (controller.signal.aborted) throw new Error('OpenRouter task was cancelled or timed out.'); this.#emit({ ...event, eventType: 'task.completed', output, timestamp: new Date().toISOString() }); })
      .catch((error) => this.#emit({ ...event, eventType: 'task.failed', error: controller.signal.aborted ? 'OpenRouter task was cancelled or timed out.' : String((error as Error).message).replaceAll(this.opts.apiKey, '[redacted]'), timestamp: new Date().toISOString() }))
      .finally(() => { clearTimeout(timer); unlink(); this.#tasks.delete(task.taskId); });
  }
  async *chat(messages: ChatMessage[], tools: ToolDefinition[], options?: ChatInvocationOptions): AsyncIterable<ChatDelta> {
    const controller = new AbortController();
    const unlink = linkAbortSignal(options?.signal, controller);
    const timer = setTimeout(() => controller.abort(), Math.min(options?.timeoutMs ?? Infinity, this.opts.timeoutMs ?? OPENROUTER_TIMEOUT_MS)).unref();
    try {
      const model = options?.preferredModel ?? this.opts.model;
      const catalogModel = await requireOpenRouterToolModel(model, controller.signal);
      if (controller.signal.aborted) throw new Error('Request aborted');
      const names = buildOpenAiToolNameMaps(tools);
      const wire = messages.map((message) => ({ ...toOpenAiMessage(message, names.originalToWire),
        ...(message.role === 'assistant' && message.providerMetadata?.openrouterReasoningDetails ? { reasoning_details: message.providerMetadata.openrouterReasoningDetails } : {}),
      }));
      const inputEstimate = Math.ceil(JSON.stringify({ messages: wire, tools }).length / 3);
      if (catalogModel.contextLength > 0 && inputEstimate + (options?.maxTokens ?? 1024) > catalogModel.contextLength) throw new Error('OpenRouter model context is too small for this turn. Shorten the context or explicitly choose a larger model.');
      const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.opts.apiKey}`, 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ model, messages: wire, stream: true, stream_options: { include_usage: true },
          ...(tools.length ? { tools: tools.map((tool) => toOpenAiTool(tool, names.originalToWire.get(tool.name)!)), tool_choice: 'auto', provider: { require_parameters: true } } : {}),
          ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
        }),
      });
      if (!response.ok) throw new Error(openRouterError(response.status));
      const calls = new Map<number, { id: string; name: string; args: string }>();
      const reasoning = new Map<string, Record<string, unknown>>();
      let finish: string | undefined;
      let usage: Extract<ChatDelta, { type: 'done' }>['usage'];
      for await (const chunk of openRouterChunks(response)) {
        if (chunk.error) throw new Error(openRouterError(Number(chunk.error.code) || 502));
        if (chunk.usage) usage = { inputTokens: Number(chunk.usage.prompt_tokens ?? 0), outputTokens: Number(chunk.usage.completion_tokens ?? 0),
          ...(typeof chunk.usage.cost === 'number' ? { costCents: chunk.usage.cost * 100 } : {}) };
        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta ?? choice.message ?? {};
          if (delta.content) yield { type: 'text', delta: delta.content };
          if (Array.isArray(delta.reasoning_details)) for (const [position, fragment] of delta.reasoning_details.entries()) {
            const key = String(fragment.index ?? fragment.id ?? `${fragment.type}:${position}`);
            const previous = reasoning.get(key);
            const merged = { ...previous, ...fragment };
            for (const field of ['text', 'summary', 'data', 'signature']) if (typeof previous?.[field] === 'string' && typeof fragment[field] === 'string') merged[field] = previous[field] + fragment[field];
            reasoning.set(key, merged);
          }
          for (const [position, call] of (delta.tool_calls ?? []).entries()) {
            const index = call.index ?? position;
            const current = calls.get(index) ?? { id: '', name: '', args: '' };
            if (call.id) current.id = call.id;
            if (call.function?.name) current.name += call.function.name;
            if (call.function?.arguments) current.args += call.function.arguments;
            calls.set(index, current);
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      }
      if (!finish) throw new Error('OpenRouter stream ended before completion. Retry the turn.');
      if (calls.size && finish !== 'tool_calls') throw new Error('OpenRouter tool stream has an inconsistent finish reason.');
      if (finish === 'tool_calls') {
        if (!calls.size) throw new Error('OpenRouter returned an empty tool call.');
        // Parse every call before emitting any: malformed streams must never perform partial writes.
        const parsed = [...calls.values()].map((call) => {
          const name = names.wireToOriginal.get(call.name);
          if (!call.id || !name) throw new Error('OpenRouter returned an unknown or incomplete tool call.');
          return { type: 'tool_call' as const, id: call.id, name, args: JSON.parse(call.args || '{}') };
        });
        for (const call of parsed) yield call;
      }
      yield { type: 'done', finishReason: finish === 'tool_calls' ? 'tool_calls' : finish === 'length' ? 'length' : finish === 'stop' ? 'stop' : 'error', usage,
        ...(reasoning.size ? { providerMetadata: { openrouterReasoningDetails: [...reasoning.values()] } } : {}) };
    } catch (error) {
      yield { type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null,
        error: controller.signal.aborted ? 'OpenRouter request was cancelled or timed out.' : String((error as Error).message).replaceAll(this.opts.apiKey, '[redacted]') };
      yield { type: 'done', finishReason: 'error' };
    } finally { clearTimeout(timer); unlink(); }
  }
}

async function* openRouterChunks(response: Response): AsyncIterable<Record<string, any>> {
  if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) { yield await response.json(); return; }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('OpenRouter returned no response body.');
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? '';
      if (chunk.done && buffer.trim()) { blocks.push(buffer); buffer = ''; }
      for (const block of blocks) {
        const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
        if (data && data !== '[DONE]') yield JSON.parse(data);
      }
      if (chunk.done) break;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
