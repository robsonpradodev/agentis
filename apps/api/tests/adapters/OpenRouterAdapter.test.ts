import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatDelta, ChatMessage, NormalizedAgentEvent, NormalizedTask, ToolDefinition } from '@agentis/core';
import { OpenRouterAdapter } from '../../src/adapters/OpenRouterAdapter.js';
import { clearOpenRouterCatalogCache, testOpenRouter } from '../../src/services/runtime/openRouter.js';
import { listRuntimeModels } from '../../src/services/runtime/runtimeModels.js';

const models = { data: [
  { id: 'test/tools:free', name: 'Tool model', supported_parameters: ['tools'], context_length: 32000, pricing: { prompt: '0', completion: '0' } },
  { id: 'test/no-tools', name: 'Text model', supported_parameters: [], pricing: { prompt: '0.1', completion: '0.2' } },
] };
const tool: ToolDefinition = { name: 'agentis.calendar.find_availability', description: 'Find dates', parameters: { type: 'object', properties: { service: { type: 'string' } } } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const completion = (text = 'Pronto') => json({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });
async function collect(stream: AsyncIterable<ChatDelta>) { const out: ChatDelta[] = []; for await (const d of stream) out.push(d); return out; }
function runtime(extra: Partial<ConstructorParameters<typeof OpenRouterAdapter>[0]> = {}) { return new OpenRouterAdapter({ agentId: 'agent', apiKey: 'secret-test-key', model: 'test/tools:free', ...extra }); }
function mockProvider(infer: (body: any, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => url.endsWith('/models') ? json(models) : url.endsWith('/key') ? json({ data: { limit_remaining: 1 } }) : infer(JSON.parse(String(init?.body)), init));
  vi.stubGlobal('fetch', mock); return mock;
}
describe('OpenRouter runtime', () => {
  beforeEach(clearOpenRouterCatalogCache);
  afterEach(() => { vi.unstubAllGlobals(); clearOpenRouterCatalogCache(); });

  it('lists only tool-capable models with explicit selection and tests without inference', async () => {
    const infer = vi.fn(() => completion()); const fetch = mockProvider(infer);
    const catalog = await listRuntimeModels('openrouter');
    expect(catalog.defaultModel).toBeNull(); expect(catalog.supportsManual).toBe(false);
    expect(catalog.models).toMatchObject([{ id: 'test/tools:free', free: true, contextLength: 32000 }]);
    expect(await testOpenRouter('secret-test-key', 'test/tools:free')).toMatchObject({ status: 'pass' });
    expect(infer).not.toHaveBeenCalled(); expect(fetch.mock.calls.every(([url]) => url.endsWith('/key') || url.endsWith('/models'))).toBe(true);
  });
  it('refuses unsupported models without submitting an inference request', async () => {
    const infer = vi.fn(() => completion()); mockProvider(infer);
    expect((await collect(runtime({ model: 'test/no-tools' }).chat([], [tool]))).at(-1)).toMatchObject({ finishReason: 'error' });
    expect(infer).not.toHaveBeenCalled();
  });
  it('accumulates fragmented tool arguments, preserves IDs and metadata across rounds', async () => {
    const bodies: any[] = [];
    mockProvider((body) => {
      bodies.push(body);
      if (bodies.length > 1) return completion('Dias consultados');
      const name = body.tools[0].function.name;
      const blocks = [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name, arguments: '{"ser' } }], reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque', id: 'r1' }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'vice":"OFT"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0 } },
      ].map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
      // Split the transport even inside JSON and line delimiters.
      return new Response(new ReadableStream({ start(controller) { const bytes = new TextEncoder().encode(blocks); for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
    });
    const adapter = runtime(); const first = await collect(adapter.chat([{ role: 'user', content: 'Oftalmo' }], [tool]));
    expect(first.filter((d) => d.type === 'tool_call')).toEqual([{ type: 'tool_call', id: 'call-1', name: tool.name, args: { service: 'OFT' } }]);
    const done = first.at(-1) as Extract<ChatDelta, { type: 'done' }>;
    const history: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: tool.name, args: { service: 'OFT' } }], providerMetadata: done.providerMetadata },
      { role: 'tool', content: '{"dates":["2026-10-13"]}', toolCallId: 'call-1', name: tool.name },
    ];
    expect((await collect(adapter.chat(history, [tool]))).at(-1)).toMatchObject({ finishReason: 'stop' });
    expect(bodies[1].messages[0].reasoning_details).toEqual([{ type: 'reasoning.encrypted', data: 'opaque', id: 'r1' }]);
    expect(bodies[1].messages[1].tool_call_id).toBe('call-1');
    expect(bodies[1].tools).toHaveLength(1); expect(bodies[0].model).toBe('test/tools:free');
  });
  it('never emits partial or malformed tool calls', async () => {
    mockProvider((body) => json({ choices: [{ message: { tool_calls: [{ id: 'one', function: { name: body.tools[0].function.name, arguments: '{' } }] }, finish_reason: 'tool_calls' }] }));
    const deltas = await collect(runtime().chat([], [tool]));
    expect(deltas.some((d) => d.type === 'tool_call')).toBe(false); expect(deltas.at(-1)).toMatchObject({ finishReason: 'error' });
  });
  it.each([401, 402, 404, 429, 503])('reports %i without exposing provider bodies or changing model', async (status) => {
    const infer = vi.fn(() => json({ error: 'secret-test-key provider private detail' }, status)); mockProvider(infer);
    const deltas = await collect(runtime().chat([], []));
    expect(deltas.at(-1)).toMatchObject({ finishReason: 'error' }); expect(JSON.stringify(deltas)).not.toContain('secret-test-key');
    expect(infer).toHaveBeenCalledTimes(1);
  });
  it('honors cancellation and the shorter caller deadline', async () => {
    mockProvider((_body, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
    const result = await collect(runtime().chat([], [], { timeoutMs: 20 }));
    expect(result.at(-1)).toMatchObject({ finishReason: 'error' }); expect(JSON.stringify(result)).toContain('timed out');
    const controller = new AbortController(); controller.abort();
    expect((await collect(runtime().chat([], [], { signal: controller.signal }))).at(-1)).toMatchObject({ finishReason: 'error' });
  });
  it('emits direct task lifecycle events and fails cancelled tasks', async () => {
    const events: NormalizedAgentEvent[] = [];
    const task: NormalizedTask = { taskId: 't', runId: 'r', workflowId: 'w', nodeId: 'n', title: 'Task', description: '', inputData: {}, scratchpadSnapshot: {}, capabilityTags: [], timeoutMs: 500 };
    const adapter = runtime({ runTask: async (_adapter, _task, signal, progress) => { progress('Checking'); if (signal.aborted) throw new Error('abort'); return { verified: true }; } });
    adapter.onEvent((e) => events.push(e)); await adapter.dispatchTask(task);
    await vi.waitFor(() => expect(events.at(-1)?.eventType).toBe('task.completed'));
    expect(events.map((e) => e.eventType)).toEqual(['task.started', 'task.progress', 'task.completed']);
    const cancelled: NormalizedAgentEvent[] = [];
    const second = runtime({ runTask: async (_a, _t, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('abort')))) });
    second.onEvent((e) => cancelled.push(e)); await second.dispatchTask({ ...task, taskId: 'cancel' }); await second.cancelTask('cancel');
    await vi.waitFor(() => expect(cancelled.at(-1)?.eventType).toBe('task.failed'));
  });
});
