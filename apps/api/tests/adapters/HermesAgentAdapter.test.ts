import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatDelta, NormalizedAgentEvent, NormalizedTask } from '@agentis/core';
import { HermesAgentAdapter } from '../../src/adapters/HermesAgentAdapter.js';
import type { Logger } from '../../src/logger.js';
import type { RuntimeSessionStore } from '../../src/services/runtime/runtimeSessionStore.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

const task: NormalizedTask = {
  taskId: 'task-1',
  runId: 'run-1',
  workflowId: 'workflow-1',
  nodeId: 'node-1',
  title: 'Summarize',
  description: 'Summarize the input.',
  inputData: {},
  scratchpadSnapshot: {},
  capabilityTags: [],
  timeoutMs: 10_000,
};

describe('HermesAgentAdapter', () => {
  beforeEach(() => {
    vi.useRealTimers();
    spawnMock.mockReset();
  });

  it('does not claim native Agentis tools for ACP until an MCP server is mounted', () => {
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test' });
    const caps = adapter.capabilities();
    expect(caps.interactiveChat).toBe(true);
    expect(caps.toolCalling).toBe(false);
    expect(caps.toolForwarding).toBe('session_event');
    expect(caps.limitations).toBeUndefined();
  });

  it('advertises native MCP only when ACP has a mounted MCP server', () => {
    const adapter = new HermesAgentAdapter({
      agentId: 'agent-1',
      logger,
      binaryPath: 'hermes-test',
      chatTransport: 'acp',
      mcpServers: [{ name: 'agentis', url: 'http://127.0.0.1:3737/mcp', headers: {} }],
    });
    const caps = adapter.capabilities();
    expect(caps.toolCalling).toBe(true);
    expect(caps.toolForwarding).toBe('mcp_native');
    expect(caps.affordances?.nativeMcp).toBe(true);
  });

  it('keeps the one-shot CLI transport as an explicit compatibility mode', () => {
    const adapter = new HermesAgentAdapter({
      agentId: 'agent-1',
      logger,
      binaryPath: 'hermes-test',
      chatTransport: 'cli',
    });
    expect(adapter.capabilities().toolForwarding).toBe('marker_protocol');
    expect(adapter.capabilities().limitations).toContainEqual(expect.stringContaining('stable Hermes CLI chat transport'));
  });

  it('does not prewarm ACP on connect unless explicitly enabled', async () => {
    const child = fakeAcpChild();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test' });

    await adapter.connect();

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('prewarms ACP on connect when explicitly enabled and reuses the prepared session for the first chat', async () => {
    const child = fakeAcpChild();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({
      agentId: 'agent-1',
      logger,
      binaryPath: 'hermes-test',
      chatTransport: 'acp',
      env: { AGENTIS_HERMES_PREWARM_ON_CONNECT: '1' },
    });

    await adapter.connect();
    await vi.waitFor(() => expect(child.sessionNewCalls).toBe(1));

    child.on('__prompt', () => {
      child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Warm reply' } });
      child.finishPrompt('end_turn');
    });
    const deltas = await collectDeltas(adapter.chat(
      [{ role: 'user', content: 'hi' }],
      [],
      { sessionKey: 'conversation-a' },
    ));

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(child.sessionNewCalls).toBe(1);
    expect(deltas).toContainEqual({ type: 'text', delta: 'Warm reply' });
  });

  it('ignores a too-low startup timeout and falls back from stalled ACP session open to CLI in auto mode', async () => {
    vi.useFakeTimers();
    const prior = process.env.AGENTIS_HERMES_STARTUP_TIMEOUT_MS;
    process.env.AGENTIS_HERMES_STARTUP_TIMEOUT_MS = '30000';
    const acp = fakeAcpChild({ hangSessionNew: true });
    const cli = fakeChildProcess();
    spawnMock
      .mockReturnValueOnce(acp)
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          cli.stdout.write('CLI_FALLBACK\n');
          cli.emit('exit', 0);
        });
        return cli;
      });
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'auto' });

    try {
      const run = collectDeltas(adapter.chat(
        [{ role: 'user', content: 'hi' }],
        [],
        { sessionKey: 'conversation-a' },
      ));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(spawnMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(90_000);
      await vi.advanceTimersByTimeAsync(0);
      const deltas = await run;

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(deltas).toContainEqual(expect.objectContaining({
        type: 'activity',
        label: 'Switching Hermes transport',
      }));
      expect(deltas).toContainEqual({ type: 'text', delta: 'CLI_FALLBACK' });
      expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
    } finally {
      if (prior === undefined) delete process.env.AGENTIS_HERMES_STARTUP_TIMEOUT_MS;
      else process.env.AGENTIS_HERMES_STARTUP_TIMEOUT_MS = prior;
    }
  });

  it('fails a pinned background ACP turn after the 20 second first-meaningful-event watchdog', async () => {
    vi.useFakeTimers();
    const child = fakeAcpChild();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'acp' });

    child.on('__prompt', () => {
      // Simulate a provider that accepted the prompt but never streams a model event.
    });
    const run = collectDeltas(adapter.chat(
      [{ role: 'user', content: 'slow' }],
      [],
      { sessionKey: 'conversation-a' },
    ));
    await vi.advanceTimersByTimeAsync(19_500);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    const deltas = await run;

    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      error: expect.stringContaining('first_event_timeout'),
    }));
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'error' });
  });

  it('fails an INTERACTIVE acp-pinned turn after the first-output budget with an honest stall message', async () => {
    vi.useFakeTimers();
    const child = fakeAcpChild();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'acp' });

    child.on('__prompt', () => {
      // Session opens, but the ACP build stalls before streaming a model event.
    });
    const run = collectDeltas(adapter.chat(
      [{ role: 'user', content: 'hi' }],
      [],
      { sessionKey: 'conversation-a', latencyClass: 'interactive' },
    ));
    // Still waiting just before the interactive stall budget...
    await vi.advanceTimersByTimeAsync(11_500);
    // ...fails just after 12s, before a second provider-sized wait accumulates.
    await vi.advanceTimersByTimeAsync(1_000);
    const deltas = await run;

    const failure = deltas.find((d) => d.type === 'tool_result' && d.error) as { error: string } | undefined;
    expect(failure).toBeTruthy();
    expect(failure!.error).toContain('first_event_timeout');
    // Honest about the symptom (no model output / stall), not a fabricated
    // "the gateway is not running" diagnosis we can't actually verify.
    expect(failure!.error.toLowerCase()).toContain('stall');
    expect(failure!.error.toLowerCase()).not.toContain('not appear to be running');
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'error' });
  });

  it('routes interactive auto turns directly to the reliable CLI transport', async () => {
    const cli = fakeChildProcess();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        cli.stdout.write('CLI_FAST\n');
        cli.emit('exit', 0);
      });
      return cli;
    });
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'auto' });

    const deltas = await collectDeltas(adapter.chat(
      [{ role: 'user', content: 'hi' }],
      [],
      { sessionKey: 'conversation-a', latencyClass: 'interactive' },
    ));

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![1]![0]).toBe('chat');
    expect(deltas.some((d) => d.type === 'activity' && d.label === 'Switching Hermes transport')).toBe(false);
    expect(deltas).toContainEqual({ type: 'text', delta: 'CLI_FAST' });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('runs caller-managed Agentis tasks through the model-only one-shot path and parses split markers', async () => {
    const cli = fakeChildProcess();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        // Hermes sometimes emits the marker keyword as prose and the JSON object
        // as a separately parsed line. Preserve their original order.
        cli.stdout.write('Warning: Unknown toolsets: stale-profile\n');
        cli.stdout.write('AGENTIS_TOOL_CALL\n');
        cli.stdout.write('{"name":"agentis.data.query","arguments":{}}\n');
        cli.emit('exit', 0);
      });
      return cli;
    });
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'cli' });

    const deltas = await collectDeltas(adapter.chat(
      [{ role: 'user', content: 'Select the next lead.' }],
      [{ name: 'agentis.data.query', description: 'Query app data', parameters: { type: 'object' } }],
      { sessionKey: 'agent-task:run-1:node-1:attempt:1', latencyClass: 'deliberate', toolMode: 'caller_loop' },
    ));

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args[0]).toBe('-z');
    expect(args).not.toContain('chat');
    expect(args).toContain('-t');
    expect(args[args.indexOf('-t') + 1]).toBe('context_engine');
    expect(args.join(' ')).toContain('intentionally model-only');
    expect(deltas).toContainEqual(expect.objectContaining({ type: 'tool_call', name: 'agentis.data.query' }));
    expect(deltas.some((delta) => delta.type === 'text' && /unknown toolsets/i.test(delta.delta))).toBe(false);
    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'activity',
      label: 'Hermes CLI requested an Agentis tool',
      status: 'success',
    }));
    expect(deltas.some((delta) => delta.type === 'activity' && delta.status === 'error')).toBe(false);
  });

  it('does not kill a healthy quiet background Hermes turn after three minutes', async () => {
    vi.useFakeTimers();
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'cli' });

    const run = collectDeltas(adapter.chat(
      [{ role: 'user', content: 'Complete a multi-step workflow task.' }],
      [],
      { sessionKey: 'workflow-node', latencyClass: 'deliberate' },
    ));
    // Hermes quiet mode reports native tool work only in its own log. Three
    // minutes without pipe output is therefore not evidence that it is stuck.
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 1);
    child.stdout.write('BACKGROUND_OK\n');
    child.emit('exit', 0);
    const deltas = await run;

    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'activity',
      label: 'Waiting for Hermes CLI final response',
    }));
    expect(deltas).toContainEqual({ type: 'text', delta: 'BACKGROUND_OK' });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('reports the silence ceiling as a timeout instead of an opaque exit code', async () => {
    vi.useFakeTimers();
    const prior = process.env.AGENTIS_HERMES_CLI_SILENCE_TIMEOUT_MS;
    process.env.AGENTIS_HERMES_CLI_SILENCE_TIMEOUT_MS = '30000';
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'cli' });
    try {
      const run = collectDeltas(adapter.chat(
        [{ role: 'user', content: 'Run.' }],
        [],
        { sessionKey: 'workflow-node', latencyClass: 'deliberate' },
      ));
      await vi.advanceTimersByTimeAsync(30_001);
      // The real process exits non-zero after Agentis terminates its tree.
      child.emit('exit', 1);
      const deltas = await run;
      const failure = deltas.find((delta) => delta.type === 'tool_result' && delta.error);

      expect(failure).toEqual(expect.objectContaining({
        type: 'tool_result',
        error: expect.stringMatching(/no observable output.*appears stuck/i),
      }));
      expect((failure as { error?: string } | undefined)?.error).not.toMatch(/exited 1/i);
      expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'error' });
    } finally {
      if (prior === undefined) delete process.env.AGENTIS_HERMES_CLI_SILENCE_TIMEOUT_MS;
      else process.env.AGENTIS_HERMES_CLI_SILENCE_TIMEOUT_MS = prior;
    }
  });

  it('trips a breaker after an ACP stall so the next auto turn goes straight to the CLI (no re-probe)', async () => {
    vi.useFakeTimers();
    const acp = fakeAcpChild();
    const cli1 = fakeChildProcess();
    const cli2 = fakeChildProcess();
    spawnMock
      .mockReturnValueOnce(acp) // turn 1: ACP attempt (stalls)
      .mockImplementationOnce(() => { // turn 1: CLI fallback
        queueMicrotask(() => { cli1.stdout.write('FIRST\n'); cli1.emit('exit', 0); });
        return cli1;
      })
      .mockImplementationOnce(() => { // turn 2: should be CLI directly, NOT another `acp`
        queueMicrotask(() => { cli2.stdout.write('SECOND\n'); cli2.emit('exit', 0); });
        return cli2;
      });
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'auto' });
    acp.on('__prompt', () => { /* never streams a first event */ });

    // Turn 1: a deliberate/background ACP turn stalls (~90s), then CLI answers
    // and trips the shared adapter breaker.
    const run1 = collectDeltas(adapter.chat([{ role: 'user', content: 'one' }], [], { sessionKey: 'c', latencyClass: 'deliberate' }));
    await vi.advanceTimersByTimeAsync(91_000);
    await vi.advanceTimersByTimeAsync(0);
    const deltas1 = await run1;
    expect(deltas1).toContainEqual({ type: 'text', delta: 'FIRST' });

    // Turn 2: no ACP spawn, no first-event probe — CLI answers immediately.
    const run2 = collectDeltas(adapter.chat([{ role: 'user', content: 'two' }], [], { sessionKey: 'c', latencyClass: 'deliberate' }));
    await vi.advanceTimersByTimeAsync(0);
    const deltas2 = await run2;

    expect(deltas2).toContainEqual({ type: 'text', delta: 'SECOND' });
    // Exactly one `acp` spawn across both turns: turn 2 skipped it.
    const acpSpawns = spawnMock.mock.calls.filter((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'acp');
    expect(acpSpawns).toHaveLength(1);
    // Turn 2 did not emit the transport-switch activity (it never tried ACP).
    expect(deltas2.some((d) => d.type === 'activity' && d.label === 'Switching Hermes transport')).toBe(false);
  });

  it('does not load a stale Hermes session from an older ACP process', async () => {
    const child = fakeAcpChild();
    spawnMock.mockReturnValue(child);
    const store = {
      get: vi.fn(() => ({
        runtimeSessionId: 'stale-session',
        processGeneration: 1,
      })),
      upsert: vi.fn(),
      markStatus: vi.fn(),
    } as unknown as RuntimeSessionStore;
    const adapter = new HermesAgentAdapter({
      agentId: 'agent-1',
      workspaceId: 'workspace-1',
      sessionStore: store,
      logger,
      binaryPath: 'hermes-test',
      chatTransport: 'acp',
    });

    child.on('__prompt', () => child.finishPrompt('end_turn'));
    await collectDeltas(adapter.chat(
      [{ role: 'user', content: 'hi' }],
      [],
      { sessionKey: 'conversation-a' },
    ));

    expect(child.sessionLoadCalls).toBe(0);
    expect(child.sessionNewCalls).toBe(1);
  });

  it('chats over ACP: streams thinking + answer and ends with done(stop)', async () => {
    const child = fakeAcpChild();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'acp' });
    const deltas: ChatDelta[] = [];

    child.on('__prompt', () => {
      child.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'considering' } });
      child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello operator' } });
      child.finishPrompt('end_turn');
    });

    for await (const delta of adapter.chat([{ role: 'user', content: 'hi' }], [])) deltas.push(delta);

    // Spawned in ACP mode, not the old one-shot chat path.
    expect(spawnMock.mock.calls[0]![1]).toEqual(['acp']);
    // Reasoning surfaces the REAL thought text as a runtime activity (operator-facing).
    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'activity',
      phase: 'runtime',
      status: 'running',
      label: 'Hermes is reasoning',
      detail: 'considering',
    }));
    expect(deltas.some((delta) => delta.type === 'thinking')).toBe(false);
    expect(deltas).toContainEqual({ type: 'text', delta: 'Hello operator' });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('mounts the Agentis MCP server in session/new so tools are real', async () => {
    const child = fakeAcpChild();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({
      agentId: 'agent-1',
      logger,
      binaryPath: 'hermes-test',
      chatTransport: 'acp',
      mcpServers: [{ name: 'agentis', url: 'http://127.0.0.1:8787/v1/mcp/rpc', headers: { authorization: 'Bearer k', 'x-agentis-workspace': 'ws1' } }],
    });
    const deltas: ChatDelta[] = [];

    child.on('__prompt', () => child.finishPrompt('end_turn'));
    for await (const delta of adapter.chat([{ role: 'user', content: 'hi' }], [])) deltas.push(delta);

    const newParams = child.sessionNewParams as { mcpServers?: unknown[] };
    expect(newParams.mcpServers).toEqual([
      {
        type: 'http',
        name: 'agentis',
        url: 'http://127.0.0.1:8787/v1/mcp/rpc',
        headers: [
          { name: 'authorization', value: 'Bearer k' },
          { name: 'x-agentis-workspace', value: 'ws1' },
        ],
      },
    ]);
  });

  it('selects a one-turn allow option for ACP permission requests', async () => {
    const child = fakeAcpChild();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'acp' });

    child.on('__prompt', () => {
      child.requestPermission([
        { optionId: 'deny', name: 'Deny', kind: 'deny' },
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
      ]);
      queueMicrotask(() => child.finishPrompt('end_turn'));
    });
    for await (const _ of adapter.chat([{ role: 'user', content: 'use a tool' }], [])) { /* drain */ }

    expect(child.permissionResponses).toContainEqual(expect.objectContaining({
      result: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    }));
  });

  it('surfaces the harness own tool calls as live activity, never executable tool_calls', async () => {
    const child = fakeAcpChild();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'acp' });
    const deltas: ChatDelta[] = [];

    child.on('__prompt', () => {
      child.update({ sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'List workflows', kind: 'mcp__agentis__workflow_list', status: 'pending' });
      child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
      child.finishPrompt('end_turn');
    });
    for await (const delta of adapter.chat([{ role: 'user', content: 'list workflows' }], [])) deltas.push(delta);

    expect(deltas).toContainEqual(expect.objectContaining({ type: 'activity', phase: 'tool', label: 'Using List workflows' }));
    // The agent ran the tool itself over MCP — Agentis must NOT re-execute it.
    expect(deltas.some((d) => d.type === 'tool_call')).toBe(false);
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('updates Hermes tool activity in place when ACP reports completion', async () => {
    const child = fakeAcpChild();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'acp' });
    const deltas: ChatDelta[] = [];

    child.on('__prompt', () => {
      child.update({ sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'List workflows', status: 'pending' });
      child.update({ sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed' });
      child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
      child.finishPrompt('end_turn');
    });
    for await (const delta of adapter.chat([{ role: 'user', content: 'list workflows' }], [])) deltas.push(delta);

    const toolActivities = deltas.filter((delta): delta is Extract<ChatDelta, { type: 'activity' }> => (
      delta.type === 'activity' && delta.id === 'hermes-tc1'
    ));
    expect(toolActivities).toEqual([
      expect.objectContaining({ status: 'running', label: 'Using List workflows' }),
      expect.objectContaining({ status: 'success', label: 'Used List workflows' }),
    ]);
  });

  it('switches the ACP session to the configured model, resolving provider-prefixed ids', async () => {
    const child = fakeAcpChild({
      models: {
        availableModels: [
          { modelId: 'nous:stepfun/step-3.7-flash:free', name: 'stepfun/step-3.7-flash:free' },
          { modelId: 'nous:anthropic/claude-opus-4.5', name: 'anthropic/claude-opus-4.5' },
        ],
        currentModelId: 'nous:stepfun/step-3.7-flash:free',
      },
    });
    spawnMock.mockReturnValue(child);
    // Agentis stores the bare model name; the agent namespaces it by provider.
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', model: 'anthropic/claude-opus-4.5', chatTransport: 'acp' });

    child.on('__prompt', () => child.finishPrompt('end_turn'));
    for await (const _ of adapter.chat([{ role: 'user', content: 'hi' }], [])) { /* drain */ }

    expect(child.setModelParams).toEqual({ sessionId: 'sess-1', modelId: 'nous:anthropic/claude-opus-4.5' });
  });

  it('prefers the per-call model override (UI runtime picker) over the static config', async () => {
    const child = fakeAcpChild({
      models: { availableModels: [{ modelId: 'nous:zai-org/glm-4.7', name: 'zai-org/glm-4.7' }], currentModelId: 'x' },
    });
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', model: 'anthropic/claude-opus-4.5', chatTransport: 'acp' });

    child.on('__prompt', () => child.finishPrompt('end_turn'));
    for await (const _ of adapter.chat([{ role: 'user', content: 'hi' }], [], { preferredModel: 'zai-org/glm-4.7' })) { /* drain */ }

    expect(child.setModelParams).toEqual({ sessionId: 'sess-1', modelId: 'nous:zai-org/glm-4.7' });
  });

  it('maps a token-exhausted stop to a guardrail pause (max_turns), not an error', async () => {
    const child = fakeAcpChild();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'acp' });
    const deltas: ChatDelta[] = [];

    child.on('__prompt', () => {
      child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } });
      child.finishPrompt('max_tokens');
    });
    for await (const delta of adapter.chat([{ role: 'user', content: 'hi' }], [])) deltas.push(delta);

    expect(deltas.some((d) => d.type === 'tool_result' && d.error)).toBe(false);
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'max_turns' });
  });

  it('keeps one warm ACP process and isolates native sessions by conversation', async () => {
    const child = fakeAcpChild();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'acp' });
    child.on('__prompt', () => child.finishPrompt('end_turn'));

    for await (const _ of adapter.chat(
      [{ role: 'user', content: 'first' }],
      [],
      { sessionKey: 'conversation-a' },
    )) { /* drain */ }
    for await (const _ of adapter.chat(
      [{ role: 'user', content: 'second' }],
      [],
      { sessionKey: 'conversation-a' },
    )) { /* drain */ }
    for await (const _ of adapter.chat(
      [{ role: 'user', content: 'other conversation' }],
      [],
      { sessionKey: 'conversation-b' },
    )) { /* drain */ }

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(child.sessionNewCalls).toBe(2);
    expect(child.promptSessionIds).toEqual(['sess-1', 'sess-1', 'sess-2']);
  });

  it('does not mistake ACP lifecycle metadata for the first model/tool event', async () => {
    vi.useFakeTimers();
    const child = fakeAcpChild();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'acp' });
    let prompted = false;
    child.on('__prompt', () => {
      prompted = true;
    });

    const run = collectDeltas(adapter.chat(
      [{ role: 'user', content: 'take the time you need' }],
      [],
      { sessionKey: 'slow-conversation', timeoutMs: 90_000, latencyClass: 'interactive' },
    ));
    await vi.advanceTimersByTimeAsync(0);
    expect(prompted).toBe(true);

    child.update({ sessionUpdate: 'available_commands_update', availableCommands: [] });
    await vi.advanceTimersByTimeAsync(13_000);

    const deltas = await run;
    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      error: expect.stringContaining('first_event_timeout'),
    }));
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'error' });
  });

  it('does not yield chat spawn failures as assistant text', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('missing binary');
    });
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger });
    const deltas: ChatDelta[] = [];
    for await (const delta of adapter.chat([{ role: 'user', content: 'hi' }], [])) deltas.push(delta);

    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      error: expect.stringContaining('missing binary'),
    }));
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'error' });
    expect(deltas.some((d) => d.type === 'text')).toBe(false);
  });

  it('answers chat through the documented Hermes CLI compatibility transport', async () => {
    const child = fakeChildProcess();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.write('CLI_OK\n');
        child.emit('exit', 0);
      });
      return child;
    });
    const adapter = new HermesAgentAdapter({
      agentId: 'agent-1',
      logger,
      binaryPath: 'hermes-test',
      chatTransport: 'cli',
    });

    const deltas = await collectDeltas(adapter.chat(
      [{ role: 'user', content: 'Reply with exactly CLI_OK' }],
      [],
      { preferredModel: 'hermes-auto' },
    ));

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args[0]).toBe('chat');
    expect(args).toContain('-Q');
    expect(args).not.toContain('-m');
    expect(deltas).toContainEqual({ type: 'text', delta: 'CLI_OK' });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('delivers the prompt INLINE (not as a @file document) with the tool catalog + identity rule', async () => {
    let promptContent = '';
    let usedFileRef = false;
    const child = fakeChildProcess();
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      const qIndex = args.indexOf('-q');
      const queryArg = args[qIndex + 1] ?? '';
      usedFileRef = queryArg.startsWith('@file:');
      // Inline: the prompt IS the -q argument (Hermes treats it as the real
      // prompt). @file: would make Hermes wrap it as a 📄 document to summarize.
      promptContent = usedFileRef ? readFileSync(queryArg.replace(/^@file:/, ''), 'utf8') : queryArg;
      queueMicrotask(() => { child.stdout.write('OK\n'); child.emit('exit', 0); });
      return child;
    });
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'cli' });

    await collectDeltas(adapter.chat(
      [{ role: 'system', content: 'You are hermes, a Department Manager.' }, { role: 'user', content: 'how many agents do I have?' }],
      [{ name: 'agentis.workflow_run', description: 'Run a workflow', parameters: { type: 'object', properties: { workflowId: {} } } }],
    ));

    // A normal turn is delivered INLINE — not wrapped as a @file document.
    expect(usedFileRef).toBe(false);
    // Identity isolation: Hermes must not absorb the cwd's AGENTS.md/SOUL.md/etc.
    expect(spawnMock.mock.calls[0]![1]).toContain('--ignore-rules');
    // The marker protocol + compact tool catalog (name + arg keys) are present.
    expect(promptContent).toContain('AGENTIS_TOOL_CALL');
    expect(promptContent).toContain('agentis.workflow_run(workflowId)');
    // Platform tools framed as ADDITIONAL — truthful, no "no filesystem" lie.
    expect(promptContent).toContain('AGENTIS PLATFORM TOOLS');
    expect(promptContent.toLowerCase()).not.toContain('no local filesystem');
    // The operating-manual/system block is pinned as the real identity.
    expect(promptContent).toContain('AUTHORITATIVE IDENTITY RULE');
    expect(promptContent).toContain('You are hermes, a Department Manager.');
  });

  it('truncates an over-long prompt to fit INLINE (never @file) — preserving tool protocol + the operator request', async () => {
    const prior = process.env.AGENTIS_HERMES_INLINE_PROMPT_LIMIT;
    process.env.AGENTIS_HERMES_INLINE_PROMPT_LIMIT = '2000'; // force the overflow path
    const child = fakeChildProcess();
    let queryArg = '';
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      queryArg = args[args.indexOf('-q') + 1] ?? '';
      queueMicrotask(() => { child.stdout.write('OK\n'); child.emit('exit', 0); });
      return child;
    });
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'cli' });
    try {
      await collectDeltas(adapter.chat(
        // A bulky system block (the kind that used to overflow into @file) + a short
        // request at the tail.
        [{ role: 'system', content: `OPERATING MANUAL ${'x'.repeat(6000)}` }, { role: 'user', content: 'OPERATOR-REQUEST-TAIL' }],
        [{ name: 'agentis.workflow_run', description: 'Run a workflow', parameters: { type: 'object', properties: {} } }],
      ));
      // NEVER @file (that makes Hermes echo the prompt as a document); always inline.
      expect(queryArg.startsWith('@file:')).toBe(false);
      expect(queryArg.length).toBeLessThanOrEqual(2000);
      expect(queryArg).toContain('AGENTIS_TOOL_CALL');     // head: tool protocol kept
      expect(queryArg).toContain('OPERATOR-REQUEST-TAIL');  // tail: the request kept
      expect(queryArg).toContain('trimmed to fit');         // middle elided with a marker
    } finally {
      if (prior === undefined) delete process.env.AGENTIS_HERMES_INLINE_PROMPT_LIMIT;
      else process.env.AGENTIS_HERMES_INLINE_PROMPT_LIMIT = prior;
    }
  });

  it('dispatches background tasks through ACP and streams runtime progress', async () => {
    const child = fakeAcpChild();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test' });
    const events: NormalizedAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    child.on('__prompt', () => {
      child.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Planning the task' } });
      child.update({ sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Build interface', status: 'pending' });
      child.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Interface created.' } });
      child.finishPrompt('end_turn');
    });

    await adapter.dispatchTask(task);
    await vi.waitFor(() => expect(events.some((event) => event.eventType === 'task.completed')).toBe(true));

    expect(spawnMock.mock.calls[0]![1]).toEqual(['acp']);
    expect(events).toContainEqual(expect.objectContaining({
      eventType: 'task.progress',
      activityId: 'hermes-thought-task:task-1',
      kind: 'reasoning',
      message: 'Planning the task',
    }));
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'task.progress', message: 'Using Build interface' }));
    expect(events).toContainEqual(expect.objectContaining({
      eventType: 'task.completed',
      output: { text: 'Interface created.' },
    }));
  });

  it('does not mistake Hermes ANSI review diffs for the quiet-mode final answer', async () => {
    const child = fakeChildProcess();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.write('┊ review diff\n');
        child.stdout.write('\u001b[38;2;218;165;32ma/C:\\tmp\\send.ps1 → b/C:\\tmp\\send.ps1\u001b[0m\n');
        child.stdout.write('\u001b[38;2;255;255;255m+Invoke-RestMethod /send\u001b[0m\n');
        child.stdout.write('{"sent_count":1,"status":"delivered"}\n');
        child.emit('exit', 0);
      });
      return child;
    });
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'cli' });

    const deltas = await collectDeltas(adapter.chat([{ role: 'user', content: 'send' }], []));

    expect(deltas).toContainEqual({ type: 'text', delta: '{"sent_count":1,"status":"delivered"}' });
    expect(deltas.some((delta) => delta.type === 'text' && /review diff|Invoke-RestMethod/.test(delta.delta))).toBe(false);
  });

  it('never degrades an MCP-mounted workflow turn to the tool-blind CLI fallback', async () => {
    vi.useFakeTimers();
    const child = fakeAcpChild();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({
      agentId: 'agent-1',
      logger,
      binaryPath: 'hermes-test',
      chatTransport: 'auto',
      mcpServers: [{ name: 'agentis', url: 'http://127.0.0.1:3737/mcp', headers: {} }],
    });
    child.on('__prompt', () => { /* no model event */ });

    const run = collectDeltas(adapter.chat(
      [{ role: 'user', content: 'use the native channel tool' }],
      [],
      { sessionKey: 'workflow-node', latencyClass: 'deliberate' },
    ));
    await vi.advanceTimersByTimeAsync(20_000);
    const deltas = await run;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![1]).toEqual(['acp']);
    expect(deltas.some((delta) => delta.type === 'activity' && delta.label === 'Switching Hermes transport')).toBe(false);
    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      error: expect.stringContaining('first_event_timeout'),
    }));
  });

  it('routes auto caller-loop workflow turns directly to the capability-preserving CLI path', async () => {
    const firstCli = fakeChildProcess();
    const secondCli = fakeChildProcess();
    spawnMock
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          firstCli.stdout.write('{"answer":"direct-first"}\n');
          firstCli.emit('exit', 0);
        });
        return firstCli;
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          secondCli.stdout.write('{"answer":"direct-second"}\n');
          secondCli.emit('exit', 0);
        });
        return secondCli;
      });
    const adapter = new HermesAgentAdapter({
      agentId: 'agent-1',
      logger,
      binaryPath: 'hermes-test',
      chatTransport: 'auto',
      mcpServers: [{ name: 'agentis', url: 'http://127.0.0.1:3737/mcp', headers: {} }],
    });
    const tools = [{
      name: 'agentis.lead_search',
      description: 'Search leads',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    }];

    const first = await collectDeltas(adapter.chat(
      [{ role: 'user', content: 'find the next lead' }],
      tools,
      {
        sessionKey: 'agent-task:run-a:node-a:attempt:1',
        latencyClass: 'deliberate',
        toolMode: 'caller_loop',
        transportRecovery: 'capability_preserving',
      },
    ));

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![1]![0]).toBe('-z');
    expect(spawnMock.mock.calls[0]![1]!.join(' ')).toContain('agentis.lead_search');
    expect(first.some((delta) => delta.type === 'activity' && delta.label === 'Switching Hermes transport')).toBe(false);
    expect(first).toContainEqual({ type: 'text', delta: '{"answer":"direct-first"}' });

    const second = await collectDeltas(adapter.chat(
      [{ role: 'user', content: 'summarize without calling a tool' }],
      [],
      {
        sessionKey: 'agent-task:run-b:node-a:attempt:1',
        latencyClass: 'deliberate',
        toolMode: 'caller_loop',
        transportRecovery: 'capability_preserving',
      },
    ));
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[1]![1]![0]).toBe('-z');
    expect(second).toContainEqual({ type: 'text', delta: '{"answer":"direct-second"}' });
  });

  it('does not emit a false completed or failed task event after operator cancellation', async () => {
    const child = fakeAcpChild();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test' });
    const events: NormalizedAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    child.on('__prompt', () => {
      // A provider that remains silent until the operator stops the run.
    });

    await adapter.dispatchTask(task);
    await vi.waitFor(() => expect(events.some((event) => event.eventType === 'task.started')).toBe(true));
    await adapter.cancelTask(task.taskId);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events.some((event) => event.eventType === 'task.completed')).toBe(false);
    expect(events.some((event) => event.eventType === 'task.failed')).toBe(false);
  });

  it('dispatches workflow tasks through the real `hermes chat -q … -Q --ignore-rules` contract', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', model: 'hermes-pro', chatTransport: 'cli' });
    const events: NormalizedAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.dispatchTask(task);
    child.stdout.write('Summary: all good.\n');
    child.emit('exit', 0);
    await new Promise((r) => setTimeout(r, 0));

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args[0]).toBe('chat');
    const qIndex = args.indexOf('-q');
    // Small task prompt → delivered inline (the actual prompt, not a @file ref).
    expect(args[qIndex + 1]).not.toMatch(/^@file:/);
    expect(args[qIndex + 1]).toContain('Summarize');
    expect(args).toContain('-Q');
    expect(args).toContain('--ignore-rules');
    expect(args.some((a) => a.startsWith('--max-turns='))).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'task.completed', output: { text: 'Summary: all good.' } }));
  });

  it('surfaces the REAL stdout error (and strips the session_id noise) when hermes chat exits 1', async () => {
    const child = fakeChildProcess();
    // Drive output from inside the mock so it lands AFTER the runtime attaches its
    // stdout/stderr/exit handlers. Hermes prints its failure to STDOUT; stderr
    // carries only the non-error "session_id: …" line it always emits on exit.
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.write('API call failed after 3 retries: HTTP 404: No endpoints found for openrouter/owl-alpha.\n');
        child.stderr.write('\nsession_id: 20260630_095002_cddf99\n');
        child.emit('exit', 1);
      });
      return child;
    });
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'cli' });
    const deltas: ChatDelta[] = [];
    for await (const d of adapter.chat([{ role: 'user', content: 'fix the workflow' }], [])) deltas.push(d);

    const err = deltas.find((d): d is Extract<ChatDelta, { type: 'tool_result' }> =>
      d.type === 'tool_result' && d.name === 'adapter.chat');
    expect(err?.error).toContain('No endpoints found');
    expect(err?.error).toContain('owl-alpha');
    expect(err?.error).toMatch(/switch this agent/i); // actionable next step
    expect(err?.error).not.toContain('session_id');    // boilerplate stripped
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'error' });
  });

  it('classifies an out-of-credits (402) exit into an actionable "add credits" message', async () => {
    const child = fakeChildProcess();
    // OpenRouter/Nous reports a depleted account on STDERR as a 402 JSON blob; the
    // raw text buries the real cause, so the adapter must name it and point at fixes.
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stderr.write("Error: Error code: 402 - {'error': {'message': 'This request requires more credits, or fewer max_tokens. You requested up to 16384 tokens, but can only afford 8556.'}}\n");
        child.stderr.write('\nsession_id: 20260713_090238_d32e47\n');
        child.emit('exit', 1);
      });
      return child;
    });
    const adapter = new HermesAgentAdapter({ agentId: 'agent-1', logger, binaryPath: 'hermes-test', chatTransport: 'cli' });
    const deltas: ChatDelta[] = [];
    for await (const d of adapter.chat([{ role: 'user', content: 'do it' }], [])) deltas.push(d);

    const err = deltas.find((d): d is Extract<ChatDelta, { type: 'tool_result' }> =>
      d.type === 'tool_result' && d.name === 'adapter.chat');
    expect(err?.error).toMatch(/out of credits/i);      // named, not a raw HTTP code
    expect(err?.error).toMatch(/add credits|afford/i);  // actionable next step
    expect(err?.error).not.toContain('session_id');     // boilerplate stripped
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'error' });
  });
});

/** A fake `hermes acp` child: auto-answers the ACP handshake over JSON-RPC. */
function fakeAcpChild(opts?: { models?: unknown; hangSessionNew?: boolean }) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: Writable;
    update: (u: Record<string, unknown>) => void;
    finishPrompt: (stopReason?: string) => void;
    sessionNewParams?: unknown;
    sessionNewCalls: number;
    sessionLoadCalls: number;
    promptSessionIds: string[];
    setModelParams?: unknown;
    permissionResponses: Array<{ id?: number; result?: unknown }>;
    requestPermission: (options: Array<{ optionId: string; name?: string; kind?: string }>) => void;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.sessionNewCalls = 0;
  child.sessionLoadCalls = 0;
  child.promptSessionIds = [];
  child.permissionResponses = [];
  let promptId: number | undefined;
  let permissionRequestId = 10_000;
  const write = (obj: unknown) => child.stdout.write(JSON.stringify(obj) + '\n');
  const reply = (id: number, result: unknown) => write({ jsonrpc: '2.0', id, result });

  child.stdin = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') reply(msg.id, { protocolVersion: 1, agentCapabilities: {} });
        else if (msg.method === 'session/new') {
          child.sessionNewCalls += 1;
          child.sessionNewParams = msg.params;
          if (opts?.hangSessionNew) continue;
          reply(msg.id, {
            sessionId: `sess-${child.sessionNewCalls}`,
            ...(opts?.models ? { models: opts.models } : {}),
          });
        } else if (msg.method === 'session/load') {
          child.sessionLoadCalls += 1;
          reply(msg.id, { sessionId: msg.params.sessionId });
        } else if (msg.method === 'session/set_model') {
          child.setModelParams = msg.params;
          reply(msg.id, {});
        } else if (msg.method === 'session/prompt') {
          promptId = msg.id;
          child.promptSessionIds.push(msg.params.sessionId);
          queueMicrotask(() => child.emit('__prompt', msg.params));
        } else if (msg.id !== undefined && msg.result !== undefined) {
          child.permissionResponses.push({ id: msg.id, result: msg.result });
        }
      }
      cb();
    },
  });

  child.update = (update) => write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update } });
  child.requestPermission = (options) => write({
    jsonrpc: '2.0',
    id: permissionRequestId++,
    method: 'session/request_permission',
    params: { options, toolCall: { title: 'Run tool', kind: 'tool' } },
  });
  child.finishPrompt = (stopReason = 'end_turn') => {
    if (promptId !== undefined) reply(promptId, { stopReason });
  };
  return child;
}

async function collectDeltas(iterable: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const deltas: ChatDelta[] = [];
  for await (const delta of iterable) deltas.push(delta);
  return deltas;
}

function fakeChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: Writable;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  return child;
}
