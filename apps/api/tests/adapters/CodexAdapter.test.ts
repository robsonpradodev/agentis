import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatDelta, ChatMessage, NormalizedAgentEvent, NormalizedTask } from '@agentis/core';
import { CodexAdapter, isCodexModelCacheFailure, recoverCodexModelCache } from '../../src/adapters/CodexAdapter.js';
import type { Logger } from '../../src/logger.js';

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
  title: 'Write patch',
  description: 'Implement the requested code change.',
  inputData: { ticket: 42 },
  scratchpadSnapshot: {},
  capabilityTags: ['code'],
  timeoutMs: 10_000,
};

describe('CodexAdapter', () => {
  // Isolate CODEX_HOME so the service_tier self-heal (which reads the real
  // ~/.codex/config.toml) never perturbs these deterministic arg assertions.
  const emptyCodexHome = mkdtempSync(join(tmpdir(), 'codex-empty-'));
  const prevCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    spawnMock.mockReset();
    process.env.CODEX_HOME = emptyCodexHome;
  });

  afterEach(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
  });

  it('spawns the Codex CLI and normalizes JSONL progress, tool, and completion events', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new CodexAdapter({ agentId: 'agent-1', logger, binaryPath: 'codex-test', cwd: 'C:/repo', model: 'codex', maxTurns: 3, env: { OPENAI_API_KEY: 'test-key' } });
    const events: NormalizedAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.dispatchTask(task);
    child.stdout.write('{"type":"assistant","text":"Working"}\n');
    child.stdout.write('{"type":"tool_call","name":"shell","input":{"cmd":"pnpm test"}}\n');
    child.stdout.write('{"type":"result","result":{"text":"done"}}\n');
    child.emit('exit', 0);

    expect(spawnMock).toHaveBeenCalledWith('codex-test', ['exec', '--json', '--ignore-user-config', '--model=codex', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'], expect.objectContaining({ cwd: 'C:/repo' }));
    expect(events.map((event) => event.eventType)).toEqual(['task.started', 'task.progress', 'agent.tool_call', 'task.completed']);
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'task.progress', message: 'Working' }));
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'agent.tool_call', tool: 'shell', input: { cmd: 'pnpm test' } }));
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'task.completed', output: { text: 'done' } }));
  });

  it('passes the operator-selected model and isolates the user config under Codex login auth (no API key)', async () => {
    // Regression: ChatGPT-auth Codex (no OPENAI_API_KEY/CODEX_API_KEY) used to drop
    // `--model`, so the agent silently ran on config.toml's default model instead of
    // the one the operator selected. The model is now always forwarded, and
    // `--ignore-user-config` keeps the user's interactive plugins/MCP/marketplace
    // (which time out on every headless spawn) out of the server-driven run.
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousCodexKey = process.env.CODEX_API_KEY;
    const previousLoadConfig = process.env.AGENTIS_CODEX_LOAD_USER_CONFIG;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
    delete process.env.AGENTIS_CODEX_LOAD_USER_CONFIG;
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    try {
      const adapter = new CodexAdapter({
        agentId: 'agent-1',
        logger,
        binaryPath: 'codex-test',
        // gpt-5.5 is forwarded verbatim under ChatGPT auth; `*-codex` ids are
        // remapped (covered by the dedicated remap test below).
        model: 'gpt-5.5',
        dangerouslyBypassApprovalsAndSandbox: false,
      });
      const deltas: ChatDelta[] = [];
      const consume = (async () => {
        for await (const delta of adapter.chat([{ role: 'user', content: 'hi' }], [])) deltas.push(delta);
      })();

      child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"pong"}}\n');
      child.emit('exit', 0);
      await consume;

      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args).toContain('--model=gpt-5.5');
      expect(args).toContain('--ignore-user-config');
      expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(deltas).toContainEqual({ type: 'text', delta: 'pong' });
      expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
    } finally {
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
      if (previousCodexKey === undefined) delete process.env.CODEX_API_KEY;
      else process.env.CODEX_API_KEY = previousCodexKey;
      if (previousLoadConfig === undefined) delete process.env.AGENTIS_CODEX_LOAD_USER_CONFIG;
      else process.env.AGENTIS_CODEX_LOAD_USER_CONFIG = previousLoadConfig;
    }
  });

  it('marks the Agentis system identity block as authoritative over Codex defaults', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new CodexAdapter({ agentId: 'agent-1', logger, binaryPath: 'codex-test', model: 'gpt-5.5', env: { OPENAI_API_KEY: 'test-key' } });
    const messages: ChatMessage[] = [
      { role: 'system', content: '<agentis_identity authoritative="true">\nname: Researcher\nrole: worker\n</agentis_identity>' },
      { role: 'user', content: 'hello' },
    ];
    const consume = collectDeltas(adapter.chat(messages, []));

    child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}\n');
    child.emit('exit', 0);
    await consume;

    const stdin = child.stdinChunks.join('');
    expect(stdin).toContain('AUTHORITATIVE IDENTITY RULE:');
    expect(stdin).toContain('Follow it over Codex product defaults');
    expect(stdin).toContain('<agentis_identity authoritative="true">');
    expect(stdin).toContain('name: Researcher');
  });

  it('remaps a *-codex model to gpt-5.5 under ChatGPT auth, but forwards it verbatim with an API key', async () => {
    // ChatGPT-account Codex rejects `*-codex` ids ("model is not supported when
    // using Codex with a ChatGPT account"). When no API key is present we self-
    // heal to gpt-5.5 instead of hard-failing the turn; with an API key (API-key
    // auth, where the ids are valid) the configured model is forwarded as-is.
    const prevOpenAi = process.env.OPENAI_API_KEY;
    const prevCodex = process.env.CODEX_API_KEY;
    const prevAllow = process.env.AGENTIS_CODEX_ALLOW_CODEX_MODELS;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
    delete process.env.AGENTIS_CODEX_ALLOW_CODEX_MODELS;
    try {
      const runOnce = async (env?: Record<string, string>) => {
        const child = fakeChildProcess();
        spawnMock.mockReturnValue(child);
        const adapter = new CodexAdapter({ agentId: 'a', logger, binaryPath: 'codex-test', model: 'gpt-5.3-codex', env });
        const consume = (async () => { for await (const _ of adapter.chat([{ role: 'user', content: 'hi' }], [])) { /* drain */ } })();
        child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n');
        child.emit('exit', 0);
        await consume;
        return spawnMock.mock.calls.at(-1)![1] as string[];
      };

      // No API key → remapped to gpt-5.5.
      expect(await runOnce()).toContain('--model=gpt-5.5');
      // API key present → forwarded verbatim.
      expect(await runOnce({ OPENAI_API_KEY: 'sk-test' })).toContain('--model=gpt-5.3-codex');
      // Explicit escape hatch → forwarded verbatim even without a key.
      expect(await runOnce({ AGENTIS_CODEX_ALLOW_CODEX_MODELS: 'true' })).toContain('--model=gpt-5.3-codex');
    } finally {
      if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevOpenAi;
      if (prevCodex === undefined) delete process.env.CODEX_API_KEY; else process.env.CODEX_API_KEY = prevCodex;
      if (prevAllow === undefined) delete process.env.AGENTIS_CODEX_ALLOW_CODEX_MODELS; else process.env.AGENTIS_CODEX_ALLOW_CODEX_MODELS = prevAllow;
    }
  });

  it('loads the user config (and its MCP-disable shim) only when AGENTIS_CODEX_LOAD_USER_CONFIG=true', async () => {
    const previousLoadConfig = process.env.AGENTIS_CODEX_LOAD_USER_CONFIG;
    process.env.AGENTIS_CODEX_LOAD_USER_CONFIG = 'true';
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    try {
      const adapter = new CodexAdapter({
        agentId: 'agent-1',
        logger,
        binaryPath: 'codex-test',
        model: 'gpt-5.3-codex',
        env: { OPENAI_API_KEY: 'test-key' },
      });
      const deltas: ChatDelta[] = [];
      const consume = (async () => {
        for await (const delta of adapter.chat([{ role: 'user', content: 'hi' }], [])) deltas.push(delta);
      })();
      child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"pong"}}\n');
      child.emit('exit', 0);
      await consume;

      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args).not.toContain('--ignore-user-config');
      expect(args).toContain('--model=gpt-5.3-codex');
    } finally {
      if (previousLoadConfig === undefined) delete process.env.AGENTIS_CODEX_LOAD_USER_CONFIG;
      else process.env.AGENTIS_CODEX_LOAD_USER_CONFIG = previousLoadConfig;
    }
  });

  it('normalizes the modern `msg`-envelope for workflow dispatch (no empty output)', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new CodexAdapter({ agentId: 'agent-1', logger, binaryPath: 'codex-test', model: 'gpt-5.3-codex' });
    const events: NormalizedAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.dispatchTask(task);
    child.stdout.write('{"id":"0","msg":{"type":"task_started"}}\n');
    child.stdout.write('{"id":"1","msg":{"type":"mcp_tool_call_begin","invocation":{"server":"agentis","tool":"shell","arguments":{"cmd":"pnpm test"}}}}\n');
    child.stdout.write('{"id":"2","msg":{"type":"agent_message","message":"Patch applied."}}\n');
    child.stdout.write('{"id":"3","msg":{"type":"task_complete","last_agent_message":"Patch applied."}}\n');
    child.emit('exit', 0);

    expect(events).toContainEqual(expect.objectContaining({ eventType: 'task.progress', message: 'Patch applied.' }));
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'agent.tool_call', tool: 'shell', input: { cmd: 'pnpm test' } }));
    expect(events).toContainEqual(expect.objectContaining({ eventType: 'task.completed', output: { text: 'Patch applied.' } }));
  });

  it('emits task.failed when spawning fails', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('missing binary');
    });
    const adapter = new CodexAdapter({ agentId: 'agent-1', logger });
    const events: NormalizedAgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    await adapter.dispatchTask(task);

    expect(events).toContainEqual(expect.objectContaining({ eventType: 'task.failed', error: 'codex_spawn_failed: missing binary' }));
  });

  it('does not yield chat spawn failures as assistant text', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('missing binary');
    });
    const adapter = new CodexAdapter({ agentId: 'agent-1', logger });
    const deltas: ChatDelta[] = [];
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];

    for await (const delta of adapter.chat(messages, [])) {
      deltas.push(delta);
    }

    expect(deltas.some((delta) => delta.type === 'text')).toBe(false);
    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      name: 'adapter.chat',
      error: expect.stringContaining('missing binary'),
    }));
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'error' });
  });

  it('surfaces Codex stdout JSON errors instead of losing them behind stderr noise', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new CodexAdapter({
      agentId: 'agent-1',
      logger,
      binaryPath: 'codex-test',
      model: 'gpt-5.3-codex',
      env: { OPENAI_API_KEY: 'test-key' },
    });
    const deltas: ChatDelta[] = [];
    const consume = (async () => {
      for await (const delta of adapter.chat([{ role: 'user', content: 'hi' }], [])) deltas.push(delta);
    })();

    child.stderr.write('Reading prompt from stdin...\n');
    child.stdout.write('{"type":"error","message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"message\\":\\"The model is not supported for this account.\\"}}"}\n');
    child.stdout.write('{"type":"turn.failed","error":{"message":"The model is not supported for this account."}}\n');
    child.emit('exit', 1);
    await consume;

    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      name: 'adapter.chat',
      error: expect.stringContaining('The model is not supported for this account.'),
    }));
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'error' });
  });

  it('uses the Codex exec JSONL contract for chat without legacy CLI flags', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new CodexAdapter({
      agentId: 'agent-1',
      logger,
      binaryPath: 'codex-test',
      model: 'gpt-5.3-codex',
      maxTurns: 12,
      fastMode: true,
      dangerouslyBypassApprovalsAndSandbox: true,
      env: { OPENAI_API_KEY: 'test-key' },
    });
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    const deltas: ChatDelta[] = [];
    const consume = (async () => {
      for await (const delta of adapter.chat(messages, [])) {
        deltas.push(delta);
      }
    })();

    child.stdout.write('{"type":"assistant","text":"Hi"}\n');
    child.emit('exit', 0);
    await consume;

    expect(spawnMock).toHaveBeenCalledWith('codex-test', [
      'exec',
      '--json',
      '--ignore-user-config',
      '--model=gpt-5.3-codex',
      '-c',
      'model_reasoning_effort="minimal"',
      '-c',
      'service_tier="fast"',
      '-c',
      'features.fast_mode=true',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
    ], expect.any(Object));
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('--json');
    expect(args.some((arg) => arg.startsWith('--max-turns'))).toBe(false);
    expect(args).not.toContain('--fast');
    expect(deltas).toContainEqual({ type: 'text', delta: 'Hi' });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('uses lightweight fast inference for interactive chat without changing task settings', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new CodexAdapter({
      agentId: 'agent-1',
      logger,
      binaryPath: 'codex-test',
      model: 'gpt-5.5',
      modelReasoningEffort: 'high',
      fastMode: false,
      env: { OPENAI_API_KEY: 'test-key' },
    });
    const consume = (async () => {
      for await (const _delta of adapter.chat(
        [{ role: 'user', content: 'Reply briefly.' }],
        [],
        { latencyClass: 'interactive', timeoutMs: 15_000 },
      )) {
        // Drain the stream.
      }
    })();

    child.stdout.write('{"type":"assistant","text":"Done."}\n');
    child.emit('exit', 0);
    await consume;

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain('model_reasoning_effort="low"');
    expect(args).toContain('service_tier="fast"');
    expect(args).toContain('features.fast_mode=true');
    expect(args).not.toContain('model_reasoning_effort="high"');
    expect(args).not.toContain('model_reasoning_effort="minimal"');
  });

  it('uses bounded fast inference without MCP for structured completions', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new CodexAdapter({
      agentId: 'agent-1',
      logger,
      binaryPath: 'codex-test',
      model: 'gpt-5.5',
      modelReasoningEffort: 'high',
      fastMode: false,
      mcpServers: [{ name: 'agentis', url: 'http://127.0.0.1:3737/mcp' }],
      env: { OPENAI_API_KEY: 'test-key' },
    });
    const consume = (async () => {
      for await (const _delta of adapter.chat(
        [{ role: 'user', content: 'Return a workflow graph as JSON.' }],
        [],
        { latencyClass: 'structured', toolMode: 'caller_loop', timeoutMs: 30_000 },
      )) {
        // Drain the stream.
      }
    })();

    child.stdout.write('{"type":"assistant","text":"{\\"nodes\\":[]}"}\n');
    child.emit('exit', 0);
    await consume;

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain('model_reasoning_effort="medium"');
    expect(args).toContain('service_tier="fast"');
    expect(args).toContain('features.fast_mode=true');
    expect(args).not.toContain('model_reasoning_effort="high"');
    expect(args.some((arg) => arg.includes('mcp_servers.agentis'))).toBe(false);
  });

  it('preserves configured reasoning for deliberate chat calls', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new CodexAdapter({
      agentId: 'agent-1',
      logger,
      binaryPath: 'codex-test',
      model: 'gpt-5.5',
      modelReasoningEffort: 'high',
      fastMode: false,
      env: { OPENAI_API_KEY: 'test-key' },
    });
    const consume = (async () => {
      for await (const _delta of adapter.chat(
        [{ role: 'user', content: 'Analyze deeply.' }],
        [],
        { latencyClass: 'deliberate' },
      )) {
        // Drain the stream.
      }
    })();

    child.stdout.write('{"type":"assistant","text":"Analysis."}\n');
    child.emit('exit', 0);
    await consume;

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args).not.toContain('features.fast_mode=true');
  });

  it('honors a per-call preferred model for evaluator-backed chat', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new CodexAdapter({
      agentId: 'agent-1',
      logger,
      binaryPath: 'codex-test',
      model: 'gpt-5.2-codex',
      env: { OPENAI_API_KEY: 'test-key' },
    });
    const consume = (async () => {
      for await (const _delta of adapter.chat(
        [{ role: 'user', content: 'evaluate this' }],
        [],
        { preferredModel: 'gpt-5.3-codex' },
      )) {
        // Drain the stream so the adapter reaches its terminal state.
      }
    })();

    child.stdout.write('{"type":"assistant","text":"{\\"score\\":9}"}\n');
    child.emit('exit', 0);
    await consume;

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain('--model=gpt-5.3-codex');
    expect(args).not.toContain('--model=gpt-5.2-codex');
  });

  it('turns AGENTIS_TOOL_CALL markers into chat tool calls', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new CodexAdapter({ agentId: 'agent-1', logger, binaryPath: 'codex-test' });
    const messages: ChatMessage[] = [{ role: 'user', content: 'build hello world' }];
    const deltas: ChatDelta[] = [];
    const consume = (async () => {
      for await (const delta of adapter.chat(messages, [{
        name: 'agentis.build_workflow',
        description: 'Build a workflow.',
        parameters: {
          type: 'object',
          properties: { description: { type: 'string' } },
          required: ['description'],
        },
      }])) {
        deltas.push(delta);
      }
    })();

    child.stdout.write('{"type":"assistant","text":"AGENTIS_TOOL_CALL {\\"name\\":\\"agentis.build_workflow\\",\\"arguments\\":{\\"description\\":\\"Hello World\\"}}"}\n');
    child.emit('exit', 0);
    await consume;

    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'tool_call',
      name: 'agentis.build_workflow',
      args: { description: 'Hello World' },
    }));
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });

  it('captures the final answer from the modern `msg`-envelope so mcp_native turns are not empty', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    // mcpServers set → mcp_native mode.
    const adapter = new CodexAdapter({ agentId: 'agent-1', logger, binaryPath: 'codex-test', mcpServers: [{ name: 'agentis', url: 'http://localhost:1', headers: {} }] });
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    const deltas: ChatDelta[] = [];
    const consume = (async () => {
      for await (const delta of adapter.chat(messages, [])) deltas.push(delta);
    })();

    // Exactly what `codex exec --json` emits: bookkeeping, a reasoning event, an
    // MCP tool call it ran itself, then the final agent_message + task_complete.
    child.stdout.write('{"id":"0","msg":{"type":"task_started"}}\n');
    child.stdout.write('{"id":"1","msg":{"type":"agent_reasoning","text":"Greeting the user."}}\n');
    child.stdout.write('{"id":"2","msg":{"type":"mcp_tool_call_begin","invocation":{"server":"agentis","tool":"agentis.status","arguments":{}}}}\n');
    child.stdout.write('{"id":"3","msg":{"type":"agent_message","message":"Hi! How can I help?"}}\n');
    child.stdout.write('{"id":"4","msg":{"type":"task_complete","last_agent_message":"Hi! How can I help?"}}\n');
    child.emit('exit', 0);
    await consume;

    // The final text must be surfaced exactly once (no delta/full doubling).
    expect(deltas).toContainEqual({ type: 'text', delta: 'Hi! How can I help?' });
    const textJoined = deltas
      .filter((d): d is Extract<ChatDelta, { type: 'text' }> => d.type === 'text')
      .map((d) => d.delta)
      .join('');
    expect(textJoined).toBe('Hi! How can I help?');
    // The completed provider summary is operator-safe commentary; raw token-level
    // chain-of-thought is never emitted through the private thinking channel.
    expect(deltas.some((d) => d.type === 'thinking')).toBe(false);
    expect(deltas).toContainEqual(expect.objectContaining({ type: 'commentary', id: 'codex-commentary-1', text: 'Greeting the user.' }));
    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'commentary',
      source: 'assistant_preamble',
      text: 'Hi!',
    }));
    // The MCP tool it ran is surfaced as an informational step.
    expect(deltas).toContainEqual(expect.objectContaining({ type: 'tool_call', name: 'agentis.status' }));
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });

  it('surfaces codex-cli 0.138 item.* events without exposing raw reasoning', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new CodexAdapter({ agentId: 'agent-1', logger, binaryPath: 'codex-test', model: 'gpt-5.5', env: { OPENAI_API_KEY: 'test-key' } });
    const deltas: ChatDelta[] = [];
    const consume = (async () => {
      for await (const delta of adapter.chat([{ role: 'user', content: 'look at this folder' }], [])) deltas.push(delta);
    })();

    // The exact shape codex-cli 0.138.0-alpha.7 emits for `exec --json`.
    child.stdout.write('{"type":"thread.started","thread_id":"t1"}\n');
    child.stdout.write('{"type":"turn.started"}\n');
    child.stdout.write('{"type":"item.reasoning","id":"r-flat","text":"I am mapping the relevant files first."}\n');
    child.stdout.write('{"type":"item.completed","item":{"id":"r0","type":"reasoning","text":"I should list the files first."}}\n');
    child.stdout.write('{"type":"item.started","item":{"id":"c0","type":"command_execution","command":"\\"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\\" -Command \'Get-ChildItem -Force\'","status":"in_progress"}}\n');
    child.stdout.write('{"type":"item.completed","item":{"id":"c0","type":"command_execution","command":"powershell -Command \'Get-ChildItem -Force\'","aggregated_output":"abort.ts\\nCodexAdapter.ts","exit_code":0,"status":"completed"}}\n');
    child.stdout.write('{"type":"item.completed","item":{"id":"m0","type":"agent_message","text":"This is the adapters folder."}}\n');
    child.stdout.write('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n');
    child.emit('exit', 0);
    await consume;

    // Shell command surfaced as a live, in-place-updating activity (NOT a tool_call,
    // which the executor would try to re-run).
    const running = deltas.find((d) => d.type === 'activity' && d.id === 'codex-c0' && d.status === 'running');
    const done = deltas.find((d) => d.type === 'activity' && d.id === 'codex-c0' && d.status === 'success');
    expect(running).toMatchObject({ type: 'activity', phase: 'tool', label: 'Running Get-ChildItem -Force' });
    expect(done).toMatchObject({ type: 'activity', phase: 'tool', label: 'Ran Get-ChildItem -Force' });
    expect(deltas.some((d) => d.type === 'tool_call')).toBe(false);
    // The provider's completed summary becomes commentary; agent_message remains
    // the only final answer text.
    expect(deltas.some((d) => d.type === 'thinking')).toBe(false);
    expect(deltas).toContainEqual(expect.objectContaining({ type: 'commentary', id: 'codex-commentary-r-flat', text: 'I am mapping the relevant files first.' }));
    expect(deltas).toContainEqual(expect.objectContaining({ type: 'commentary', id: 'codex-commentary-r0', text: 'I should list the files first.' }));
    expect(deltas).toContainEqual({ type: 'text', delta: 'This is the adapters folder.' });
    expect(deltas.at(-1)).toEqual({
      type: 'done', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 },
    });
  });

  it('uses only the explicit final message and drops intermediate assistant narration', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new CodexAdapter({ agentId: 'agent-1', logger, binaryPath: 'codex-test' });
    const deltas: ChatDelta[] = [];
    const consume = (async () => {
      for await (const delta of adapter.chat([{ role: 'user', content: 'fix the workflow' }], [])) deltas.push(delta);
    })();

    child.stdout.write('{"id":"1","msg":{"type":"agent_message","message":"I’ll inspect the failed run first."}}\n');
    child.stdout.write('{"id":"2","msg":{"type":"agent_message","message":"The extension uses CommonJS, so I’m correcting it."}}\n');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'commentary',
      text: 'I’ll inspect the failed run first.',
      source: 'assistant_preamble',
    }));
    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'commentary',
      text: 'The extension uses CommonJS, so I’m correcting it.',
      source: 'assistant_preamble',
    }));
    child.stdout.write('{"id":"3","msg":{"type":"task_complete","last_agent_message":"Fixed the extension and verified the workflow."}}\n');
    child.emit('exit', 0);
    await consume;

    const answer = deltas
      .filter((delta): delta is Extract<ChatDelta, { type: 'text' }> => delta.type === 'text')
      .map((delta) => delta.delta)
      .join('');
    expect(answer).toBe('Fixed the extension and verified the workflow.');
    expect(answer).not.toContain('I’ll inspect');
    expect(deltas.some((delta) => delta.type === 'activity' && delta.label === 'Codex is working')).toBe(false);
  });

  it('resumes the native Codex thread only for the same Agentis conversation', async () => {
    const first = fakeChildProcess();
    const second = fakeChildProcess();
    const third = fakeChildProcess();
    spawnMock
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
      .mockReturnValueOnce(third);
    const adapter = new CodexAdapter({
      agentId: 'agent-1',
      logger,
      binaryPath: 'codex-test',
      model: 'gpt-5.5',
    });

    const firstRun = collectDeltas(adapter.chat(
      [{ role: 'user', content: 'first turn' }],
      [],
      { sessionKey: 'conversation-a' },
    ));
    first.stdout.write('{"type":"thread.started","thread_id":"thread-a"}\n');
    first.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"first"}}\n');
    first.emit('exit', 0);
    await firstRun;

    const secondRun = collectDeltas(adapter.chat(
      [{ role: 'user', content: 'follow up' }],
      [],
      { sessionKey: 'conversation-a' },
    ));
    second.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"second"}}\n');
    second.emit('exit', 0);
    await secondRun;

    const thirdRun = collectDeltas(adapter.chat(
      [{ role: 'user', content: 'unrelated' }],
      [],
      { sessionKey: 'conversation-b' },
    ));
    third.stdout.write('{"type":"thread.started","thread_id":"thread-b"}\n');
    third.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"third"}}\n');
    third.emit('exit', 0);
    await thirdRun;

    expect(spawnMock.mock.calls[1]![1]).toEqual(expect.arrayContaining([
      'exec',
      'resume',
      'thread-a',
      '--json',
    ]));
    expect((spawnMock.mock.calls[1]![1] as string[]).slice(0, 3)).toEqual(['exec', 'resume', 'thread-a']);
    expect((spawnMock.mock.calls[2]![1] as string[]).slice(0, 2)).toEqual(['exec', '--json']);
  });

  it('recognizes the newer base_instructions cache mismatch and only quarantines a model cache', () => {
    expect(isCodexModelCacheFailure('failed to load models cache: missing field base_instructions at line 86 column 5')).toBe(true);
    const cacheRoot = mkdtempSync(join(tmpdir(), 'codex-model-cache-'));
    const cache = join(cacheRoot, 'models-cache.json');
    writeFileSync(cache, JSON.stringify({ models: [] }));

    expect(recoverCodexModelCache(cacheRoot)).toBe('models-cache.json');
    expect(existsSync(cache)).toBe(false);
  });

  it('native profile preserves user config/profile while enforcing the named permission envelope', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new CodexAdapter({
      agentId: 'agent-1', logger, binaryPath: 'codex-test', cwd: 'C:/repo',
      runtimeProfile: {
        version: 2,
        mode: 'native',
        profileName: 'work',
        projectRoot: 'C:/repo',
        permissionProfile: 'read_only',
        inheritUserConfig: true,
        inheritProjectInstructions: true,
        inheritPlugins: true,
        inheritSkills: true,
        browser: 'inherit',
        sessionPolicy: 'persistent',
      },
    });
    await adapter.dispatchTask(task);
    const invocation = spawnMock.mock.calls[0]![1] as string[];
    expect(invocation).toContain('--profile=work');
    expect(invocation).not.toContain('--ignore-user-config');
    expect(invocation).toContain('--sandbox=read-only');
    expect(invocation).toContain('--ask-for-approval=never');
    expect(invocation).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    child.emit('exit', 0);
  });

  it('does not resend prior Agentis history into a resumed Codex thread', async () => {
    const first = fakeChildProcess();
    const second = fakeChildProcess();
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const adapter = new CodexAdapter({
      agentId: 'agent-1', logger, binaryPath: 'codex-test', model: 'gpt-5.5',
    });

    const initial = collectDeltas(adapter.chat([
      { role: 'system', content: 'current brain' },
      { role: 'user', content: 'first request' },
    ], [], { sessionKey: 'conversation-a' }));
    first.stdout.write('{"type":"thread.started","thread_id":"thread-a"}\n');
    first.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"first answer"}}\n');
    first.emit('exit', 0);
    await initial;

    const resumed = collectDeltas(adapter.chat([
      { role: 'system', content: 'refreshed brain' },
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second request' },
    ], [], { sessionKey: 'conversation-a' }));
    second.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"second answer"}}\n');
    second.emit('exit', 0);
    await resumed;

    const stdin = second.stdinChunks.join('');
    expect(stdin).toContain('refreshed brain');
    expect(stdin).toContain('second request');
    expect(stdin).not.toContain('first request');
    expect(stdin).not.toContain('first answer');
  });

  it('on a stall (total silence past the ceiling), preserves the partial answer and pauses (max_turns), not FAILED', async () => {
    // A quiet stretch no longer kills — only TOTAL silence past the ceiling does.
    // Shrink that ceiling via env so the genuinely-stuck case fires fast in-test.
    const prevCeiling = process.env.AGENTIS_CODEX_CHAT_HARD_CEILING_MS;
    process.env.AGENTIS_CODEX_CHAT_HARD_CEILING_MS = '1000';
    try {
      const child = fakeChildProcess();
      spawnMock.mockReturnValue(child);
      const adapter = new CodexAdapter({ agentId: 'agent-1', logger, binaryPath: 'codex-test', model: 'gpt-5.5', env: { OPENAI_API_KEY: 'test-key' } });
      const deltas: ChatDelta[] = [];
      const consume = (async () => {
        for await (const delta of adapter.chat([{ role: 'user', content: 'explore the repo' }], [], { latencyClass: 'interactive', timeoutMs: 50 })) deltas.push(delta);
      })();

      // The harness streams a partial answer, then goes SILENT (no completion).
      child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"Found 3 services so far."}}\n');
      await new Promise((r) => setTimeout(r, 1300)); // > silence ceiling → controller.abort()
      child.emit('error', new Error('aborted')); // real spawn emits this on abort
      await consume;

      const text = deltas.filter((d): d is Extract<ChatDelta, { type: 'text' }> => d.type === 'text').map((d) => d.delta).join('');
      expect(text).toContain('Found 3 services so far.');
      expect(text.toLowerCase()).toContain('paused');
      // Not a hard error: the work is preserved and the turn ends as a guardrail stop.
      expect(deltas.some((d) => d.type === 'tool_result' && d.error)).toBe(false);
      expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'max_turns' });
    } finally {
      if (prevCeiling === undefined) delete process.env.AGENTIS_CODEX_CHAT_HARD_CEILING_MS;
      else process.env.AGENTIS_CODEX_CHAT_HARD_CEILING_MS = prevCeiling;
    }
  });

  it('keeps a quiet-but-alive turn going with a heartbeat instead of killing it', async () => {
    // No env ceiling override → the default 30-min silence ceiling is far away.
    // A turn that streams a partial then stays quiet must NOT be reaped; it should
    // emit a "still working" heartbeat and remain open (no terminal delta yet).
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new CodexAdapter({ agentId: 'agent-1', logger, binaryPath: 'codex-test', model: 'gpt-5.5', env: { OPENAI_API_KEY: 'test-key' } });
    const deltas: ChatDelta[] = [];
    const consume = (async () => {
      for await (const delta of adapter.chat([{ role: 'user', content: 'do a big task' }], [], { latencyClass: 'interactive', timeoutMs: 50 })) deltas.push(delta);
    })();

    child.stdout.write('{"type":"item.reasoning","text":"thinking hard"}\n');
    await new Promise((r) => setTimeout(r, 5200)); // past the 5s heartbeat cadence

    // Still alive: a heartbeat activity was emitted, and the turn has NOT terminated.
    expect(deltas.some((d) => d.type === 'activity'
      && d.id === 'codex-cli-default'
      && /codex is working/i.test(d.label)
      && Boolean(d.startedAt))).toBe(true);
    expect(deltas.some((d) => d.type === 'done')).toBe(false);

    // Clean completion afterwards still works.
    child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n');
    child.emit('exit', 0);
    await consume;
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  }, 10_000);

  it('does not claim the runtime "is working" before it has produced any output', async () => {
    // A turn that opens but stays TOTALLY silent (no stdout, no stderr) — e.g. a
    // hung/unreachable model — must not be narrated as "is working". The heartbeat
    // tells the truth: still waiting, no output yet.
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new CodexAdapter({ agentId: 'agent-1', logger, binaryPath: 'codex-test', model: 'gpt-5.5', env: { OPENAI_API_KEY: 'test-key' } });
    const deltas: ChatDelta[] = [];
    const consume = (async () => {
      for await (const delta of adapter.chat([{ role: 'user', content: 'hi' }], [], { latencyClass: 'interactive', timeoutMs: 50 })) deltas.push(delta);
    })();

    await new Promise((r) => setTimeout(r, 5200)); // past the 5s heartbeat cadence, still silent

    const heartbeat = deltas.find((d): d is Extract<ChatDelta, { type: 'activity' }> =>
      d.type === 'activity' && /waiting for codex provider output/i.test(d.label));
    expect(heartbeat).toBeDefined();
    expect(heartbeat?.id).toBe('codex-cli-default');
    expect(heartbeat?.startedAt).toBeDefined();
    expect(deltas.some((d) => d.type === 'activity' && /is working/i.test(d.label))).toBe(false);
    expect(deltas.some((d) => d.type === 'done')).toBe(false);

    // Once real output arrives, the heartbeat flips to the working narration.
    child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n');
    child.emit('exit', 0);
    await consume;
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  }, 10_000);

  it('opts into the native browser: loads the user config, keeps its MCP backend, declares the affordance', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-browser-'));
    writeFileSync(join(codexHome, 'config.toml'), '[mcp_servers.node_repl]\ncommand = "node_repl"\n');
    const adapter = new CodexAdapter({
      agentId: 'agent-1', logger, binaryPath: 'codex-test', model: 'gpt-5.5', browser: true,
      env: { OPENAI_API_KEY: 'test-key', CODEX_HOME: codexHome },
    });

    // Browser turns advertise the affordance so routing/UI can see it.
    expect(adapter.capabilities().affordances).toMatchObject({ browser: true, computerUse: true });

    const consume = (async () => {
      for await (const _ of adapter.chat([{ role: 'user', content: 'open example.com' }], [], { latencyClass: 'interactive', toolMode: 'caller_loop' })) { /* drain */ }
    })();
    child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n');
    child.emit('exit', 0);
    await consume;

    const args = spawnMock.mock.calls[0]![1] as string[];
    // The native config is LOADED (not isolated) so the browser plugin/backend exist…
    expect(args).not.toContain('--ignore-user-config');
    // …and its node_repl backend is NOT disabled (that's the browser).
    expect(args.some((a) => a.includes('mcp_servers.node_repl') && a.includes('enabled=false'))).toBe(false);
  });

  it('skips MCP startup when Agentis owns the interactive tool loop', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-mcp-'));
    writeFileSync(join(codexHome, 'config.toml'), '[mcp_servers.node_repl]\ncommand = "node"\n');
    const adapter = new CodexAdapter({
      agentId: 'agent-1',
      logger,
      binaryPath: 'codex-test',
      env: { CODEX_HOME: codexHome },
      mcpServers: [{ name: 'agentis', url: 'http://localhost:1', headers: {} }],
    });
    const consume = (async () => {
      for await (const _delta of adapter.chat(
        [{ role: 'user', content: 'hi' }],
        [],
        { latencyClass: 'interactive', toolMode: 'caller_loop' },
      )) {
        // Drain the stream.
      }
    })();

    child.stdout.write('{"type":"assistant","text":"Hi"}\n');
    child.emit('exit', 0);
    await consume;

    const args = spawnMock.mock.calls[0]![1] as string[];
    // `--ignore-user-config` means the user's config (and its node_repl MCP server)
    // is never loaded — so there is nothing to spawn or to explicitly disable — and
    // Agentis withholds its own server because the caller owns the tool loop.
    expect(args).toContain('--ignore-user-config');
    expect(args.some((arg) => arg.includes('mcp_servers.node_repl'))).toBe(false);
    expect(args.some((arg) => arg.includes('mcp_servers.agentis.'))).toBe(false);
  });

  it('falls back to last_agent_message when only a task_complete carries the answer', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new CodexAdapter({ agentId: 'agent-1', logger, binaryPath: 'codex-test' });
    const deltas: ChatDelta[] = [];
    const consume = (async () => {
      for await (const delta of adapter.chat([{ role: 'user', content: 'hi' }], [])) deltas.push(delta);
    })();

    child.stdout.write('{"id":"0","msg":{"type":"task_complete","last_agent_message":"All done."}}\n');
    child.emit('exit', 0);
    await consume;

    expect(deltas).toContainEqual({ type: 'text', delta: 'All done.' });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('parses tool-call markers even when Windows taskkill noise follows, and never leaks PID spam', async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const adapter = new CodexAdapter({ agentId: 'agent-1', logger, binaryPath: 'codex-test' });
    const messages: ChatMessage[] = [{ role: 'user', content: 'build hello world LP' }];
    const deltas: ChatDelta[] = [];
    const consume = (async () => {
      for await (const delta of adapter.chat(messages, [{
        name: 'agentis.build_workflow',
        description: 'Build a workflow.',
        parameters: {
          type: 'object',
          properties: { description: { type: 'string' } },
          required: ['description'],
        },
      }])) {
        deltas.push(delta);
      }
    })();

    // Assistant emits the marker as a JSON event...
    child.stdout.write('{"type":"assistant","text":"AGENTIS_TOOL_CALL {\\"name\\":\\"agentis.build_workflow\\",\\"arguments\\":{\\"description\\":\\"Hello World LP\\"}}"}\n');
    // ...then the Codex sandbox teardown prints taskkill output as raw stdout
    // (the exact spam from the bug report, Portuguese locale).
    child.stdout.write('ÊXITO: o processo com PID 12388 (processo filho de PID 6616) foi finalizado.\n');
    child.stdout.write('ÊXITO: o processo com PID 6616 (processo filho de PID 17788) foi finalizado.\n');
    child.emit('exit', 0);
    await consume;

    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'tool_call',
      name: 'agentis.build_workflow',
      args: { description: 'Hello World LP' },
    }));
    const text = deltas
      .filter((delta): delta is Extract<ChatDelta, { type: 'text' }> => delta.type === 'text')
      .map((delta) => delta.delta)
      .join('');
    expect(text).not.toMatch(/PID|XITO|AGENTIS_TOOL_CALL/);
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });
});

function fakeChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: Writable;
    stdinChunks: string[];
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdinChunks = [];
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      child.stdinChunks.push(String(chunk));
      callback();
    },
  });
  return child;
}

async function collectDeltas(iterable: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const deltas: ChatDelta[] = [];
  for await (const delta of iterable) deltas.push(delta);
  return deltas;
}
