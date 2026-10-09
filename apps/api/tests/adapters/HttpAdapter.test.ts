import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatDelta, ChatMessage } from '@agentis/core';
import { HttpAdapter } from '../../src/adapters/HttpAdapter.js';
import type { Logger } from '../../src/logger.js';

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

async function collect(iterable: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const deltas: ChatDelta[] = [];
  for await (const delta of iterable) deltas.push(delta);
  return deltas;
}

describe('HttpAdapter chat', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('reports task-only capabilities without a chat endpoint', () => {
    const adapter = new HttpAdapter({
      agentId: 'agent-http',
      dispatchUrl: 'http://127.0.0.1/dispatch',
      logger,
    });

    expect(adapter.capabilities()).toEqual(expect.objectContaining({
      interactiveChat: false,
      toolCalling: false,
      toolForwarding: 'none',
    }));
  });

  it('posts chat messages with tools when supportsTools is enabled and normalizes tool calls', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      toolCalls: [{
        id: 'call_1',
        name: 'agentis.build_workflow',
        arguments: { description: 'Hello World' },
      }],
      finishReason: 'tool_calls',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE', 'true');
    const adapter = new HttpAdapter({
      agentId: 'agent-http',
      dispatchUrl: 'http://127.0.0.1/dispatch',
      chatUrl: 'http://127.0.0.1/chat',
      supportsTools: true,
      logger,
    });
    const messages: ChatMessage[] = [{ role: 'user', content: 'build hello world' }];

    const deltas = await collect(adapter.chat(messages, [{
      name: 'agentis.build_workflow',
      description: 'Build a workflow.',
      parameters: { type: 'object', properties: {} },
    }]));

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as { tools: unknown[]; supportsTools: boolean };
    expect(body.supportsTools).toBe(true);
    expect(body.tools).toHaveLength(1);
    expect(deltas).toContainEqual({
      type: 'tool_call',
      id: 'call_1',
      name: 'agentis.build_workflow',
      args: { description: 'Hello World' },
    });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });

  it('translates Agentis messages and tools to the OpenAI chat-completions protocol', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'call_openai_1',
            type: 'function',
            function: { name: 'agentis__data__query', arguments: '{"collection":"slots"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE', 'true');
    const adapter = new HttpAdapter({
      agentId: 'agent-http',
      dispatchUrl: 'http://127.0.0.1/dispatch',
      chatUrl: 'http://127.0.0.1/chat',
      supportsTools: true,
      chatProtocol: 'openai',
      logger,
    });

    const deltas = await collect(adapter.chat(
      [
        { role: 'assistant', content: '', toolCalls: [{ id: 'prior', name: 'agentis.data.query', arguments: { collection: 'services' } }] },
        { role: 'tool', toolCallId: 'prior', content: '{"rows":[]}' },
        { role: 'user', content: 'Check slots.' },
      ],
      [{ name: 'agentis.data.query', description: 'Query data.', parameters: { type: 'object', properties: { collection: { type: 'string' } } } }],
    ));

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as {
      messages: Array<Record<string, unknown>>;
      tools: Array<Record<string, unknown>>;
    };
    expect(body.tools[0]).toEqual(expect.objectContaining({
      type: 'function',
      function: expect.objectContaining({ name: 'agentis__data__query' }),
    }));
    expect(body.messages[0]).toEqual(expect.objectContaining({ role: 'assistant', tool_calls: expect.any(Array) }));
    expect(body.messages[1]).toEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'prior' }));
    expect(deltas).toContainEqual({
      type: 'tool_call', id: 'call_openai_1', name: 'agentis.data.query', args: { collection: 'slots' },
    });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });

  it('uses marker calls when a text-only HTTP model runs a caller-managed agent_task', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      text: 'AGENTIS_TOOL_CALL {"name":"agentis.data.query","arguments":{"collection":"leads"}}',
      finishReason: 'stop',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE', 'true');
    const adapter = new HttpAdapter({
      agentId: 'agent-http', dispatchUrl: 'http://127.0.0.1/dispatch', chatUrl: 'http://127.0.0.1/chat', logger,
    });

    const deltas = await collect(adapter.chat(
      [{ role: 'user', content: 'Select the next lead.' }],
      [{ name: 'agentis.data.query', description: 'Query data.', parameters: { type: 'object' } }],
      { toolMode: 'caller_loop', sessionKey: 'agent-task:run-1:node-1:attempt:1' },
    ));

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as { messages: ChatMessage[]; tools: unknown[]; supportsTools: boolean };
    expect(body.supportsTools).toBe(false);
    expect(body.tools).toHaveLength(0);
    expect(body.messages[0]?.role).toBe('system');
    expect(String(body.messages[0]?.content)).toContain('agentis.data.query');
    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'tool_call', name: 'agentis.data.query', args: { collection: 'leads' },
    }));
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });
});
