import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AdapterCapabilities, AgentAdapter, AdapterHealthStatus, ChatDelta, ChatInvocationOptions, ChatMessage, NormalizedAgentEvent, NormalizedTask, ToolDefinition } from '@agentis/core';
import { REALTIME_EVENTS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { ChatSessionExecutor } from '../../src/services/chat/chatSessionExecutor.js';
import { ChatToolExecutor } from '../../src/services/chat/chatToolExecutor.js';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { createInProcessEventBus } from '../../src/event-bus.js';
import { createLogger } from '../../src/logger.js';
import { createTestContext } from '../_helpers/createTestContext.js';
import { OrchestratorModelRouter } from '../../src/services/orchestrator/orchestratorModelRouter.js';
import { routeModelForTask, type ModelRoutingDecision } from '../../src/services/modelRoutingPolicy.js';

class FakeChatAdapter implements AgentAdapter {
  readonly adapterType = 'http' as const;
  calls: ChatMessage[][] = [];
  chatOptions: Array<ChatInvocationOptions | undefined> = [];
  constructor(
    private readonly impl: (messages: ChatMessage[], tools: ToolDefinition[], callIndex: number) => AsyncIterable<ChatDelta>,
    private readonly adapterCapabilities: AdapterCapabilities = {
      interactiveChat: true,
      toolCalling: true,
      toolForwarding: 'native',
    },
  ) {}
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck(): Promise<AdapterHealthStatus> {
    return { isHealthy: true, checkedAt: new Date().toISOString() };
  }
  capabilities(): AdapterCapabilities {
    return this.adapterCapabilities;
  }
  onEvent(_handler: (event: NormalizedAgentEvent) => void): void {}
  async dispatchTask(_task: NormalizedTask): Promise<void> {}
  async cancelTask(_taskId: string): Promise<void> {}
  chat(messages: ChatMessage[], tools: ToolDefinition[], options?: ChatInvocationOptions): AsyncIterable<ChatDelta> {
    this.calls.push(messages);
    this.chatOptions.push(options);
    return this.impl(messages, tools, this.calls.length - 1);
  }
}

async function collect(iterable: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const deltas: ChatDelta[] = [];
  for await (const delta of iterable) deltas.push(delta);
  return deltas;
}

let mutatingToolCalls = 0;
let autoMutatingToolCalls = 0;
let directBuildToolCalls = 0;
let directBuildToolRunIds: string[] = [];
let directBuildToolArgs: Array<Record<string, unknown>> = [];

describe('ChatSessionExecutor', () => {
  beforeEach(() => {
    mutatingToolCalls = 0;
    autoMutatingToolCalls = 0;
    directBuildToolCalls = 0;
    directBuildToolRunIds = [];
    directBuildToolArgs = [];
    const registry = new AgentisToolRegistry({ logger: createLogger({ level: 'error' }) });
    registry.register(
      {
        id: 'agentis.plan',
        family: 'inspect',
        description: 'Test planner.',
        inputSchema: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] },
        mutating: false,
      },
      async (args) => ({ goal: args.goal, steps: [`Plan ${String(args.goal)}`] }),
    );
    registry.register(
      {
        id: 'agentis.write_test',
        family: 'run',
        description: 'Test write action.',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
        mutating: true,
        approval: { riskLevel: 'high', reversible: false, externalSideEffects: true },
      },
      async (args) => {
        mutatingToolCalls += 1;
        return { wrote: args.value };
      },
    );
    registry.register(
      {
        id: 'agentis.auto_write_test',
        family: 'build',
        description: 'Test auto-executed write action.',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
        mutating: true,
        autoExecute: true,
      },
      async (args) => {
        autoMutatingToolCalls += 1;
        return { wrote: args.value };
      },
    );
    registry.register(
      {
        id: 'agentis.build_workflow',
        family: 'build',
        description: 'Build a workflow from a description.',
        inputSchema: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            title: { type: 'string' },
            workflowId: { type: 'string' },
            graphDraft: { type: 'object' },
            patchDraft: { type: 'object' },
          },
          required: ['description'],
        },
        mutating: true,
        autoExecute: true,
      },
      async (args, toolCtx) => {
        directBuildToolCalls += 1;
        directBuildToolRunIds.push(String(toolCtx.runId ?? ''));
        directBuildToolArgs.push(args);
        return {
          workflowId: 'wf_direct',
          runId: toolCtx.runId,
          title: typeof args.title === 'string' ? args.title : 'Email Alex',
          description: args.description,
          nodeCount: 5,
          edgeCount: 4,
          approvalRequired: true,
          warnings: [],
          estimatedDurationMs: 1900,
          deliveryPreview: [
            {
              service: 'agentmail',
              to: 'me@example.com',
              summary: 'Agentmail -> me@example.com',
            },
          ],
        };
      },
    );
    ChatToolExecutor.configure({ registry });
    ChatSessionExecutor.configure({});
  });

  it('streams a normal assistant response and terminates', async () => {
    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'hello' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'answer normally', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_1',
    }));

    expect(deltas).toContainEqual({ type: 'text', delta: 'hello' });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
    expect(adapter.calls[0]![0]!.role).toBe('system');
    expect(adapter.calls[0]!.at(-1)).toMatchObject({ role: 'user', content: 'answer normally' });
    expect(adapter.chatOptions[0]).toMatchObject({
      latencyClass: 'deliberate',
      timeoutMs: 15_000,
    });
  });

  it('honors the caller model-round budget even when every tool call is novel', async () => {
    const adapter = new FakeChatAdapter(async function* (_messages, _tools, callIndex) {
      yield {
        type: 'tool_call', id: `plan-${callIndex}`, name: 'agentis.plan',
        args: { goal: `novel-goal-${callIndex}` },
      };
      yield { type: 'done', finishReason: 'tool_calls' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(
      adapter,
      [],
      'Keep planning forever.',
      { workspaceId: 'ws_budget', agentId: 'agent_budget', userId: 'user_budget', conversationId: 'conv_budget' },
      {
        tools: [{ name: 'agentis.plan', description: 'Plan', parameters: { type: 'object' } }],
        maxTurns: 2,
        maxToolCalls: 100,
      },
    ));

    expect(adapter.calls).toHaveLength(2);
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'max_turns' });
  });

  it('uses low-latency inference only when the turn is explicitly Quick', async () => {
    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'quick answer' };
      yield { type: 'done', finishReason: 'stop' };
    });
    await collect(ChatSessionExecutor.turn(adapter, [], 'summarize this', {
      workspaceId: 'ws_quick', agentId: 'agent_quick', userId: 'user_quick', conversationId: 'conv_quick', qualityMode: 'quick',
    }, { qualityMode: 'quick' }));
    expect(adapter.chatOptions[0]).toMatchObject({ latencyClass: 'interactive' });
  });

  it('enforces deliberate inference and a high reasoning floor for Missions', async () => {
    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'mission complete' };
      yield { type: 'done', finishReason: 'stop' };
    });
    await collect(ChatSessionExecutor.turn(adapter, [], 'build and verify the complete application', {
      workspaceId: 'ws_mission', agentId: 'agent_mission', userId: 'user_mission', conversationId: 'conv_mission', qualityMode: 'mission',
    }, { qualityMode: 'mission' }));
    expect(adapter.chatOptions[0]).toMatchObject({ latencyClass: 'deliberate', reasoningEffort: 'high', fastMode: false });
  });

  it('records provider-reported chat usage in audit and agent monthly spend telemetry', async () => {
    const auditEntries: Array<Record<string, unknown>> = [];
    const spends: Array<Record<string, unknown>> = [];
    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'metered answer' };
      yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, costCents: 2 } };
    });
    ChatSessionExecutor.configure({
      audit: { record: (entry) => { auditEntries.push(entry); } },
      budget: { recordSpend: (entry) => { spends.push(entry); return entry; } },
    });

    await collect(ChatSessionExecutor.turn(adapter, [], 'hello', {
      workspaceId: 'ws_meter', agentId: 'agent_meter', userId: 'user_meter', conversationId: 'conv_meter',
    }));

    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]).toMatchObject({
      action: 'chat.model.completed', agentId: 'agent_meter', tokensIn: 120, tokensOut: 30, costCents: 2,
    });
    expect(spends).toEqual([expect.objectContaining({ agentId: 'agent_meter', amountCents: 2 })]);
  });

  it('records a marked token estimate when an adapter omits usage without fabricating monetary cost', async () => {
    const auditEntries: Array<Record<string, unknown>> = [];
    const spends: Array<Record<string, unknown>> = [];
    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'answer' };
      yield { type: 'done', finishReason: 'stop' };
    });
    ChatSessionExecutor.configure({
      audit: { record: (entry) => { auditEntries.push(entry); } },
      budget: { recordSpend: (entry) => { spends.push(entry); return entry; } },
    });

    await collect(ChatSessionExecutor.turn(adapter, [], 'hello', {
      workspaceId: 'ws_est', agentId: 'agent_est', userId: 'user_est', conversationId: 'conv_est',
    }));

    expect(auditEntries).toHaveLength(1);
    expect(Number(auditEntries[0]?.tokensIn)).toBeGreaterThan(0);
    expect(Number(auditEntries[0]?.tokensOut)).toBeGreaterThan(0);
    expect(auditEntries[0]?.outputSummary).toContain('estimated usage');
    expect(auditEntries[0]?.costCents).toBeNull();
    expect(spends).toHaveLength(0);
  });

  it('answers greetings through the real harness (no canned shortcut)', async () => {
    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'Hey! What can I help you with?' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'hi', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_1',
      clientTurnId: 'turn_1',
    }));

    // The greeting now flows to the model like any other turn — the response is
    // whatever the harness produced, never a hardcoded string.
    expect(deltas).toContainEqual({ type: 'text', delta: 'Hey! What can I help you with?' });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
    expect(adapter.calls.length).toBe(1);
    expect(adapter.calls[0]!.at(-1)).toMatchObject({ role: 'user', content: 'hi' });
  });

  it('never ends a turn silently — emits a terminal message when the model returns no text', async () => {
    // Model produces neither text nor a tool call and just signals done.
    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'do the thing', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_1',
    }));

    const text = deltas.filter((d): d is Extract<ChatDelta, { type: 'text' }> => d.type === 'text').map((d) => d.delta).join('');
    expect(text.length).toBeGreaterThan(0);
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('does not inject a fallback message when the model already produced text', async () => {
    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'real answer' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'do the thing', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_1',
    }));

    const text = deltas.filter((d): d is Extract<ChatDelta, { type: 'text' }> => d.type === 'text').map((d) => d.delta).join('');
    expect(text).toBe('real answer');
  });

  it('executes tool calls and feeds summarized tool results into the next model turn', async () => {
    const adapter = new FakeChatAdapter(async function* (_messages, _tools, callIndex) {
      if (callIndex === 0) {
        yield { type: 'tool_call', id: 'tool_1', name: 'agentis.plan', args: { goal: 'ship chat loop' } };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', delta: 'planned' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'plan this', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_1',
    }));

    expect(deltas.some((delta) => delta.type === 'tool_result' && delta.name === 'agentis.plan')).toBe(true);
    expect(deltas).toContainEqual({ type: 'text', delta: 'planned' });
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]!.some((message) => message.role === 'tool' && String(message.content).includes('ship chat loop'))).toBe(true);
  });

  it('joins live inbox messages at the next safe model boundary without cancelling completed work', async () => {
    const adapter = new FakeChatAdapter(async function* (messages, _tools, callIndex) {
      if (callIndex === 0) {
        yield { type: 'tool_call', id: 'tool_1', name: 'agentis.plan', args: { goal: 'long task' } };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      expect(messages).toContainEqual({ role: 'user', content: 'What is the status?' });
      yield { type: 'text', delta: 'The task continued with the new context.' };
      yield { type: 'done', finishReason: 'stop' };
    });
    let inboxReads = 0;

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'perform the long task', {
      workspaceId: 'ws_live', agentId: 'agent_live', userId: 'user_live', conversationId: 'conv_live',
    }, {
      liveInput: () => {
        inboxReads += 1;
        return inboxReads === 1 ? [{ role: 'user', content: 'What is the status?' }] : [];
      },
    }));

    expect(adapter.calls).toHaveLength(2);
    expect(inboxReads).toBe(1);
    expect(deltas).toContainEqual({ type: 'text', delta: 'The task continued with the new context.' });
  });

  it('emits live "Using <tool>" activity cards for the marker-protocol tool round', async () => {
    const adapter = new FakeChatAdapter(async function* (_messages, _tools, callIndex) {
      if (callIndex === 0) {
        yield { type: 'tool_call', id: 'tool_1', name: 'agentis.plan', args: { goal: 'x' } };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', delta: 'done' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'plan this', {
      workspaceId: 'ws_1', agentId: 'agent_1', userId: 'user_1', conversationId: 'conv_1',
    }));

    const cards = deltas.filter((d): d is Extract<ChatDelta, { type: 'activity' }> =>
      d.type === 'activity' && d.id === 'chat-tool-tool_1');
    expect(cards.some((c) => c.status === 'running' && /Using plan/.test(c.label))).toBe(true);
    expect(cards.some((c) => c.status === 'success' && /Used plan/.test(c.label))).toBe(true);
  });

  it('stops a runaway tool loop via the progress monitor, not a wall clock', async () => {
    // The model issues the SAME tool call with identical args every round — a
    // classic loop. There is no turn time limit anymore; the progress monitor must
    // detect the identical repetition and stop within a few rounds (well short of
    // the absolute defensive ceiling), with an honest explanation.
    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'tool_call', id: 'tool_1', name: 'agentis.plan', args: { goal: 'loop' } };
      yield { type: 'done', finishReason: 'tool_calls' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'loop', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_1',
    }));

    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
    // A handful of identical rounds, not the absolute round ceiling — the monitor caught it fast.
    expect(adapter.calls.length).toBeLessThan(6);
    const text = deltas
      .filter((d): d is Extract<ChatDelta, { type: 'text' }> => d.type === 'text')
      .map((d) => d.delta)
      .join(' ')
      .toLowerCase();
    expect(text).toContain('repeating');
  });

  it('pauses mutating tools for confirmation and resumes after approval', async () => {
    const adapter = new FakeChatAdapter(async function* (_messages, _tools, callIndex) {
      if (callIndex === 0) {
        yield { type: 'tool_call', id: 'tool_write', name: 'agentis.write_test', args: { value: 'confirmed' } };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', delta: 'write complete' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const ctx = {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_confirm',
    };
    const initial = await collect(ChatSessionExecutor.turn(adapter, [], 'write this', ctx));
    const confirmation = initial.find(
      (delta): delta is Extract<ChatDelta, { type: 'confirmation_required' }> => delta.type === 'confirmation_required',
    );

    expect(confirmation).toBeTruthy();
    expect(confirmation!.impact).toEqual(expect.objectContaining({
      summary: 'Test write action.',
      riskLevel: 'high',
      reversible: false,
    }));
    expect(initial.some((delta) => delta.type === 'tool_result')).toBe(false);
    expect(mutatingToolCalls).toBe(0);

    const resumed = await collect(ChatSessionExecutor.confirm(adapter, confirmation!.turnId, true, ctx));

    expect(mutatingToolCalls).toBe(1);
    const resumedActivity = resumed.filter((delta): delta is Extract<ChatDelta, { type: 'activity' }> =>
      delta.type === 'activity' && delta.id === 'chat-tool-tool_write');
    expect(resumedActivity[0]).toEqual(expect.objectContaining({ status: 'running', label: expect.stringMatching(/Using write test/i) }));
    expect(resumedActivity.at(-1)).toEqual(expect.objectContaining({ status: 'success', label: expect.stringMatching(/Used write test/i) }));
    expect(resumed.findIndex((delta) => delta.type === 'activity' && delta.status === 'running'))
      .toBeLessThan(resumed.findIndex((delta) => delta.type === 'tool_result' && delta.name === 'agentis.write_test'));
    expect(resumed.some((delta) => delta.type === 'tool_result' && delta.name === 'agentis.write_test')).toBe(true);
    expect(resumed).toContainEqual({ type: 'text', delta: 'write complete' });
    expect(adapter.calls).toHaveLength(2);
  });

  it('auto-executes mutating tools that explicitly opt in', async () => {
    const adapter = new FakeChatAdapter(async function* (_messages, _tools, callIndex) {
      if (callIndex === 0) {
        yield { type: 'tool_call', id: 'tool_auto', name: 'agentis.auto_write_test', args: { value: 'built' } };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', delta: 'auto write complete' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'build this', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_auto',
    }));

    expect(autoMutatingToolCalls).toBe(1);
    expect(deltas.some((delta) => delta.type === 'confirmation_required')).toBe(false);
    expect(deltas.some((delta) => delta.type === 'tool_result' && delta.name === 'agentis.auto_write_test')).toBe(true);
    expect(deltas).toContainEqual({ type: 'text', delta: 'auto write complete' });
  });

  it('routes obvious workflow requests through the agent tool loop', async () => {
    const adapter = new FakeChatAdapter(async function* (_messages, _tools, callIndex) {
      if (callIndex === 0) {
        yield {
          type: 'tool_call',
          id: 'build-agent-draft',
          name: 'agentis.build_workflow',
          args: {
            title: 'Email Alex',
            description: 'build a workflow that sends Hi Alex to my email me@example.com',
            graphDraft: {
              version: 1,
              nodes: [
                { id: 'trigger', type: 'trigger', title: 'Manual Trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
                { id: 'output', type: 'return_output', title: 'Return Output', position: { x: 240, y: 0 }, config: { kind: 'return_output', renderAs: 'text' } },
              ],
              edges: [{ id: 'trigger-output', source: 'trigger', target: 'output' }],
              viewport: { x: 0, y: 0, zoom: 1 },
            },
          },
        };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', delta: 'Built the email workflow.' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'build a workflow that sends Hi Alex to my email me@example.com', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_direct_build',
      clientTurnId: 'turn_build_1',
    }));

    expect(adapter.calls).toHaveLength(2);
    expect(directBuildToolCalls).toBe(1);
    expect(directBuildToolRunIds).toEqual(['build_turn_build_1']);
    expect(directBuildToolArgs[0]).toMatchObject({
      title: 'Email Alex',
      graphDraft: expect.objectContaining({ version: 1 }),
    });
    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'tool_call',
      name: 'agentis.build_workflow',
    }));
    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      name: 'agentis.build_workflow',
      result: expect.objectContaining({
        workflowId: 'wf_direct',
        runId: 'build_turn_build_1',
      }),
    }));
    expect(deltas).toContainEqual({ type: 'text', delta: 'Built the email workflow.' });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('answers marker-protocol (CLI) agents on their OWN runtime, never silently swapping to the orchestrator', async () => {
    // The agent's declared runtime is authoritative. Even with an orchestrator
    // runtime configured, a chat-capable harness answers itself — so that when
    // its gateway is down the real error surfaces instead of a different brain
    // silently impersonating it (e.g. a Hermes agent answered by Codex).
    const cliAdapter: AgentAdapter = {
      adapterType: 'codex',
      async connect() {},
      async disconnect() {},
      async healthCheck() {
        return { isHealthy: true, checkedAt: new Date().toISOString() };
      },
      onEvent() {},
      async dispatchTask() {},
      async cancelTask() {},
      capabilities() {
        return { interactiveChat: true, toolCalling: true, toolForwarding: 'marker_protocol' as const };
      },
      async *chat() {
        yield { type: 'text', delta: 'FROM_AGENT_RUNTIME' };
        yield { type: 'done', finishReason: 'stop' as const };
      },
    };
    const runtime = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'FROM_ORCHESTRATOR' };
      yield { type: 'done', finishReason: 'stop' };
    });
    ChatSessionExecutor.configure({ orchestratorRuntime: runtime });

    const deltas = await collect(ChatSessionExecutor.turn(cliAdapter, [], 'hi', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_fast',
    }));

    expect(deltas).toContainEqual({ type: 'text', delta: 'FROM_AGENT_RUNTIME' });
    expect(deltas.some((delta) => delta.type === 'text' && delta.delta === 'FROM_ORCHESTRATOR')).toBe(false);
    expect(runtime.calls).toHaveLength(0);
  });

  it('fails a CLI-harness turn FAST with an attributed error when its runtime is unhealthy (no freeze)', async () => {
    // The agent's own harness is down. A bounded preflight health probe must
    // surface an immediate, attributed error instead of entering the harness and
    // sitting in its long startup/first-event budget (the "thinking…" freeze).
    let chatCalls = 0;
    const downHarness: AgentAdapter = {
      adapterType: 'hermes_agent',
      async connect() {},
      async disconnect() {},
      async healthCheck() {
        return { isHealthy: false, error: 'hermes acp gateway not reachable', checkedAt: new Date().toISOString() };
      },
      onEvent() {},
      async dispatchTask() {},
      async cancelTask() {},
      capabilities() {
        return { interactiveChat: true, toolCalling: true, toolForwarding: 'mcp_native' as const };
      },
      async *chat() {
        chatCalls += 1;
        yield { type: 'text', delta: 'SHOULD_NOT_REACH_HARNESS' };
        yield { type: 'done', finishReason: 'stop' as const };
      },
    };

    const deltas = await collect(ChatSessionExecutor.turn(downHarness, [], 'hi', {
      workspaceId: 'ws_1',
      agentId: 'agent_down',
      userId: 'user_1',
      conversationId: 'conv_down',
    }));

    expect(chatCalls).toBe(0);
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'error' });
    const failure = deltas.find((d) => d.type === 'tool_result' && d.error);
    expect(failure).toBeTruthy();
    expect((failure as { error: string }).error).toContain('hermes_agent runtime is unavailable');
    expect((failure as { error: string }).error).toContain('hermes acp gateway not reachable');
  });

  it('works when turn() is DETACHED from the class and re-bound (broadcast/channel dispatch path)', async () => {
    // The broadcast + channel dispatchers store `ChatSessionExecutor.turn` in a
    // variable and call it. `turn` is a STATIC method that reads static private
    // fields via `this`, so an unbound reference throws "Receiver must be class
    // ChatSessionExecutor" and every dispatched turn dies before producing output.
    // The dispatchers must `.bind(ChatSessionExecutor)`; this guards that contract.
    const detachedTurn = ChatSessionExecutor.turn.bind(ChatSessionExecutor);
    const downHarness: AgentAdapter = {
      adapterType: 'hermes_agent',
      async connect() {},
      async disconnect() {},
      async healthCheck() {
        return { isHealthy: false, error: 'runtime offline', checkedAt: new Date().toISOString() };
      },
      onEvent() {},
      async dispatchTask() {},
      async cancelTask() {},
      capabilities() {
        return { interactiveChat: true, toolCalling: true, toolForwarding: 'mcp_native' as const };
      },
      async *chat() {
        yield { type: 'text', delta: 'unreached' };
        yield { type: 'done', finishReason: 'stop' as const };
      },
    };

    const deltas = await collect(detachedTurn(downHarness, [], 'hi', {
      workspaceId: 'ws_1',
      agentId: 'agent_detached',
      userId: 'user_1',
      conversationId: 'conv_detached',
    }));

    // Reached the executor (static-private access succeeded) instead of throwing
    // the receiver error — surfaced as the normal attributed-unavailable result.
    const failure = deltas.find((d) => d.type === 'tool_result' && d.error) as { error: string } | undefined;
    expect(failure?.error).toContain('runtime is unavailable');
    expect(failure?.error ?? '').not.toContain('Receiver must be class');
  });

  it('PROCEEDS into the harness when the preflight probe merely TIMED OUT (ambiguous, not down)', async () => {
    // A slow-to-probe-but-working runtime (e.g. Hermes Python cold-start under
    // load) reports an AMBIGUOUS timeout. That must NOT nuke the turn — the real
    // chat path bounds its own failure, so we proceed and let it answer.
    let chatCalls = 0;
    const slowProbe: AgentAdapter = {
      adapterType: 'hermes_agent',
      async connect() {},
      async disconnect() {},
      async healthCheck() {
        return { isHealthy: false, timedOut: true, error: 'hermes probe timed out', checkedAt: new Date().toISOString() };
      },
      onEvent() {},
      async dispatchTask() {},
      async cancelTask() {},
      capabilities() {
        return { interactiveChat: true, toolCalling: true, toolForwarding: 'mcp_native' as const };
      },
      async *chat() {
        chatCalls += 1;
        yield { type: 'text', delta: 'REAL_ANSWER' };
        yield { type: 'done', finishReason: 'stop' as const };
      },
    };

    const deltas = await collect(ChatSessionExecutor.turn(slowProbe, [], 'hi', {
      workspaceId: 'ws_1',
      agentId: 'agent_slow',
      userId: 'user_1',
      conversationId: 'conv_slow',
    }));

    expect(chatCalls).toBe(1);
    expect(deltas.some((d) => d.type === 'text' && d.delta === 'REAL_ANSWER')).toBe(true);
    expect(deltas.some((d) => d.type === 'tool_result' && d.error)).toBe(false);
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('does not divert a chat-capable agent through task-aware routing', async () => {
    // The model router's resolveRouted (used to pick a streaming runtime) must
    // NOT be consulted to swap a chat-capable agent away from its own runtime.
    const cliAdapter: AgentAdapter = {
      adapterType: 'claude_code',
      async connect() {},
      async disconnect() {},
      async healthCheck() {
        return { isHealthy: true, checkedAt: new Date().toISOString() };
      },
      onEvent() {},
      async dispatchTask() {},
      async cancelTask() {},
      capabilities() {
        return { interactiveChat: true, toolCalling: true, toolForwarding: 'marker_protocol' as const };
      },
      async *chat() {
        yield { type: 'text', delta: 'FROM_AGENT_RUNTIME' };
        yield { type: 'done', finishReason: 'stop' as const };
      },
    };
    const runtime = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'FROM_ROUTED_RUNTIME' };
      yield { type: 'done', finishReason: 'stop' };
    });
    let resolveRoutedCalls = 0;
    class RecordingRouter extends OrchestratorModelRouter {
      decision: ModelRoutingDecision | null = null;
      override route(args: Parameters<OrchestratorModelRouter['route']>[0]): ModelRoutingDecision {
        this.decision = routeModelForTask({
          task: args.task,
          purpose: args.purpose,
          runtime: 'claude_code',
          currentModel: 'claude-opus-4-8',
          requiredAffordances: args.requiredAffordances,
        });
        return this.decision;
      }
      override resolveRouted(args: Parameters<OrchestratorModelRouter['resolveRouted']>[0]): AgentAdapter | undefined {
        resolveRoutedCalls += 1;
        this.route(args);
        return runtime;
      }
      override describeRouting(): string {
        return 'RUNTIME ROUTING INTELLIGENCE';
      }
    }
    const router = new RecordingRouter();
    ChatSessionExecutor.configure({ modelRouter: router });

    const deltas = await collect(ChatSessionExecutor.turn(cliAdapter, [], 'Write a short welcome email.', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_routed',
    }));

    // The agent answered itself; the routed runtime was never used to swap it.
    expect(deltas).toContainEqual({ type: 'text', delta: 'FROM_AGENT_RUNTIME' });
    expect(deltas.some((delta) => delta.type === 'text' && delta.delta === 'FROM_ROUTED_RUNTIME')).toBe(false);
    expect(runtime.calls).toHaveLength(0);
    expect(resolveRoutedCalls).toBe(0);
  });

  it('falls back to the orchestrator — disclosed — only when the agent has NO interactive chat', async () => {
    // An agent whose adapter cannot chat (workflow-only) must still be able to
    // answer a turn via the orchestrator, but the substitution is surfaced so the
    // operator is never led to believe the agent's own runtime replied.
    const workflowOnly: AgentAdapter = {
      adapterType: 'hermes_agent',
      async connect() {},
      async disconnect() {},
      async healthCheck() {
        return { isHealthy: true, checkedAt: new Date().toISOString() };
      },
      onEvent() {},
      async dispatchTask() {},
      async cancelTask() {},
      capabilities() {
        return { interactiveChat: false, toolCalling: true, toolForwarding: 'marker_protocol' as const };
      },
    };
    const runtime = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'FROM_ORCHESTRATOR' };
      yield { type: 'done', finishReason: 'stop' };
    });
    ChatSessionExecutor.configure({ orchestratorRuntime: runtime });

    const deltas = await collect(ChatSessionExecutor.turn(workflowOnly, [], 'hi', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_fallback',
    }));

    expect(deltas).toContainEqual({ type: 'text', delta: 'FROM_ORCHESTRATOR' });
    expect(runtime.calls).toHaveLength(1);
    // Disclosed: a user-visible activity announces the fallback substitution.
    expect(deltas.some((d) => d.type === 'activity' && /fallback runtime/i.test(d.label))).toBe(true);
  });

  it('gives a CLI harness a realistic per-round timeout when it answers directly (no runtime)', async () => {
    // With no orchestrator runtime configured the harness answers the turn itself.
    // A re-spawning CLI cannot meet the 15s streaming budget, so the loop must hand
    // it the larger harness budget — otherwise every real task dies with
    // "request timed out after 15 seconds".
    const seenOptions: Array<ChatInvocationOptions | undefined> = [];
    const cliAdapter: AgentAdapter = {
      adapterType: 'codex',
      async connect() {},
      async disconnect() {},
      async healthCheck() {
        return { isHealthy: true, checkedAt: new Date().toISOString() };
      },
      onEvent() {},
      async dispatchTask() {},
      async cancelTask() {},
      capabilities() {
        return { interactiveChat: true, toolCalling: true, toolForwarding: 'marker_protocol' as const };
      },
      async *chat(_messages, _tools, options) {
        seenOptions.push(options);
        yield { type: 'text', delta: 'built it' };
        yield { type: 'done', finishReason: 'stop' as const };
      },
    };

    await collect(ChatSessionExecutor.turn(cliAdapter, [], 'create a workflow with a new extension', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_harness',
    }));

    expect(seenOptions[0]?.latencyClass).toBe('deliberate');
    expect(seenOptions[0]?.timeoutMs).toBe(240_000);
    expect(seenOptions[0]?.timeoutMs).not.toBe(15_000);
  });

  it('keeps lightweight social chat on a short harness round budget', async () => {
    const seenOptions: Array<ChatInvocationOptions | undefined> = [];
    const cliAdapter: AgentAdapter = {
      adapterType: 'hermes_agent',
      async connect() {},
      async disconnect() {},
      async healthCheck() {
        return { isHealthy: true, checkedAt: new Date().toISOString() };
      },
      onEvent() {},
      async dispatchTask() {},
      async cancelTask() {},
      capabilities() {
        return { interactiveChat: true, toolCalling: true, toolForwarding: 'marker_protocol' as const };
      },
      async *chat(_messages, _tools, options) {
        seenOptions.push(options);
        yield { type: 'text', delta: "I'm good." };
        yield { type: 'done', finishReason: 'stop' as const };
      },
    };

    await collect(ChatSessionExecutor.turn(cliAdapter, [], 'how are you?', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_lightweight_harness',
    }));

    expect(seenOptions[0]?.latencyClass).toBe('interactive');
    expect(seenOptions[0]?.timeoutMs).toBe(30_000);
  });

  it('does not divert native adapters when an orchestrator runtime is configured', async () => {
    const native = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'FROM_NATIVE' };
      yield { type: 'done', finishReason: 'stop' };
    });
    const runtime = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'FROM_RUNTIME' };
      yield { type: 'done', finishReason: 'stop' };
    });
    ChatSessionExecutor.configure({ orchestratorRuntime: runtime });

    const deltas = await collect(ChatSessionExecutor.turn(native, [], 'hi', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_native',
    }));

    expect(deltas).toContainEqual({ type: 'text', delta: 'FROM_NATIVE' });
    expect(runtime.calls).toHaveLength(0);
  });

  it('injects persisted identity for legacy null-role agents without the orchestrator persona', async () => {
    const dbCtx = await createTestContext();
    const agentId = randomUUID();
    try {
      dbCtx.db.insert(schema.agents).values({
        id: agentId,
        workspaceId: dbCtx.workspace.id,
        ambientId: dbCtx.ambient.id,
        userId: dbCtx.user.id,
        name: 'Legacy Specialist',
        description: 'Handles focused analysis.',
        adapterType: 'codex',
        capabilityTags: ['analysis'],
        config: {
          cwd: 'C:/repo',
          token: 'super-secret-token',
          nested: { password: 'hunter2', safe: 'visible' },
          specialist: true,
          specialistSource: 'manual',
          defaultModel: 'gpt-5.5',
          tools: ['research'],
        },
        status: 'online',
        role: null,
        runtimeModel: 'gpt-5.5',
        instructions: 'Persisted specialist instructions. Never claim to be the orchestrator.',
      }).run();
      const adapter = new FakeChatAdapter(async function* () {
        yield { type: 'text', delta: 'ok' };
        yield { type: 'done', finishReason: 'stop' };
      });
      ChatSessionExecutor.configure({ db: dbCtx.db });

      await collect(ChatSessionExecutor.turn(adapter, [], 'hello', {
        workspaceId: dbCtx.workspace.id,
        agentId,
        userId: dbCtx.user.id,
        conversationId: 'conv_legacy',
      }));

      const systemPrompt = adapter.calls[0]![0]!.content;
      expect(systemPrompt).not.toContain('You are the Agentis platform orchestrator');
      expect(systemPrompt).toContain('You are Legacy Specialist, an Agentis agent');
      expect(systemPrompt).toContain('You are NOT the platform orchestrator');
      expect(systemPrompt.match(/<agentis_identity/g)).toHaveLength(1);
      expect(systemPrompt).toContain('role: agent');
      expect(systemPrompt).toContain('runtimeModel: gpt-5.5');
      expect(systemPrompt).toContain('capabilityTags: analysis');
      expect(systemPrompt).toContain('"cwd":"C:/repo"');
      expect(systemPrompt).toContain('"safe":"visible"');
      expect(systemPrompt).toContain('"token":"[redacted]"');
      expect(systemPrompt).toContain('"password":"[redacted]"');
      expect(systemPrompt).not.toContain('super-secret-token');
      expect(systemPrompt).not.toContain('hunter2');
      const instructionsIndex = systemPrompt.indexOf('Persisted specialist instructions');
      expect(instructionsIndex).toBeGreaterThan(-1);
      expect(systemPrompt.lastIndexOf('Persisted specialist instructions')).toBe(instructionsIndex);
    } finally {
      ChatSessionExecutor.configure({});
      dbCtx.close();
    }
  });

  it('versions CLI-backed chat session keys by identity checksum', async () => {
    const dbCtx = await createTestContext();
    const agentId = randomUUID();
    try {
      dbCtx.db.insert(schema.agents).values({
        id: agentId,
        workspaceId: dbCtx.workspace.id,
        ambientId: dbCtx.ambient.id,
        userId: dbCtx.user.id,
        name: 'CLI Specialist',
        adapterType: 'codex',
        capabilityTags: ['code'],
        config: { cwd: 'C:/repo', approvalMode: 'safe' },
        status: 'online',
        role: 'worker',
        runtimeModel: 'gpt-5.5',
        instructions: 'Initial CLI identity.',
      }).run();
      const adapter = new FakeChatAdapter(
        async function* () {
          yield { type: 'text', delta: 'ok' };
          yield { type: 'done', finishReason: 'stop' };
        },
        { interactiveChat: true, toolCalling: true, toolForwarding: 'marker_protocol' },
      );
      ChatSessionExecutor.configure({ db: dbCtx.db });
      const turnCtx = {
        workspaceId: dbCtx.workspace.id,
        agentId,
        userId: dbCtx.user.id,
        conversationId: 'conv_identity',
      };

      await collect(ChatSessionExecutor.turn(adapter, [], 'first', turnCtx));
      await collect(ChatSessionExecutor.turn(adapter, [], 'second', turnCtx));
      const firstKey = adapter.chatOptions[0]?.sessionKey;
      const secondKey = adapter.chatOptions[1]?.sessionKey;
      expect(firstKey).toMatch(/^conv_identity:identity:[a-f0-9]{16}$/);
      expect(secondKey).toBe(firstKey);

      dbCtx.db.update(schema.agents)
        .set({ instructions: 'Changed CLI identity.' })
        .where(eq(schema.agents.id, agentId))
        .run();
      await collect(ChatSessionExecutor.turn(adapter, [], 'third', turnCtx));
      const thirdKey = adapter.chatOptions[2]?.sessionKey;
      expect(thirdKey).toMatch(/^conv_identity:identity:[a-f0-9]{16}$/);
      expect(thirdKey).not.toBe(firstKey);
    } finally {
      ChatSessionExecutor.configure({});
      dbCtx.close();
    }
  });

  it('injects agent memory, personal brain, workspace context, and agent instructions into the system prompt when wired', async () => {
    const native = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'ok' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const fakeAgentMemory = {
      contextSection: (agentId: string, workspaceId: string) => `FAKE_AGENT_MEMORY_FOR_${agentId}_IN_${workspaceId}`,
    } as any;

    const fakePersonalBrain = {
      contextForAgent: async (userId: string, agentId: string, query: string) => `FAKE_PERSONAL_BRAIN_FOR_${agentId}`,
    } as any;

    const fakeWorkspaceIntelligence = {
      buildContextBlock: async (workspaceId: string, opts: any) => `FAKE_WORKSPACE_CONTEXT_IN_${workspaceId}_QUERY_${opts.knowledgeQuery}`,
    } as any;

    // Chainable query stub: where(...).orderBy(...).limit(...).all()/.get().
    const queryChain: any = {
      get: () => ({ id: 'agent_1', name: 'Test Agent', instructions: 'FAKE_AGENT_INSTRUCTIONS_HERE' }),
      all: () => [],
      orderBy: () => queryChain,
      limit: () => queryChain,
    };
    const fakeDb = {
      select: () => ({ from: () => ({ where: () => queryChain }) }),
    } as any;

    ChatSessionExecutor.configure({
      db: fakeDb,
      agentMemory: fakeAgentMemory,
      personalBrain: fakePersonalBrain,
      workspaceIntelligence: fakeWorkspaceIntelligence,
    });

    await collect(ChatSessionExecutor.turn(native, [], 'summarize the latest workflow run', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_1',
    }));

    expect(native.calls).toHaveLength(1);
    const systemPrompt = native.calls[0]![0]!.content;
    expect(systemPrompt).toContain('FAKE_AGENT_INSTRUCTIONS_HERE');
    expect(systemPrompt).toContain('FAKE_AGENT_MEMORY_FOR_agent_1_IN_ws_1');
    expect(systemPrompt).toContain('FAKE_PERSONAL_BRAIN_FOR_agent_1');
    // A substantive message carries a query signal, so knowledge retrieval runs
    // and the message is forwarded as the knowledge query.
    expect(systemPrompt).toContain('FAKE_WORKSPACE_CONTEXT_IN_ws_1_QUERY_summarize the latest workflow run');
  });

  it('clamps injected memory/brain context to a fixed budget so prompt size stays constant', async () => {
    const native = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'ok' };
      yield { type: 'done', finishReason: 'stop' };
    });
    // A retriever that returns a huge block (simulating years of accumulated memory).
    const huge = 'X'.repeat(50_000);
    const queryChain: any = {
      get: () => ({ id: 'agent_1', name: 'Test Agent', instructions: 'INSTR' }),
      all: () => [], orderBy: () => queryChain, limit: () => queryChain,
    };
    ChatSessionExecutor.configure({
      db: { select: () => ({ from: () => ({ where: () => queryChain }) }) } as any,
      agentMemory: { contextSection: () => huge } as any,
      personalBrain: { contextForAgent: async () => huge } as any,
      workspaceIntelligence: { buildContextBlock: async () => huge } as any,
    });

    await collect(ChatSessionExecutor.turn(native, [], 'hi', {
      workspaceId: 'ws_1', agentId: 'agent_1', userId: 'user_1', conversationId: 'conv_2',
    }));

    const systemPrompt = native.calls[0]![0]!.content as string;
    // The 3 × 50KB blocks must be clamped to their budgets (~8KB total), not 150KB.
    expect(systemPrompt.length).toBeLessThan(20_000);
    expect(systemPrompt).toContain('truncated to keep context size constant');
  });

  it('gives mcp_native harnesses native tool ownership while preserving the bounded fallback loop', async () => {
    let chatCalls = 0;
    const invocationOptions: Array<ChatInvocationOptions | undefined> = [];
    const harness: AgentAdapter = {
      adapterType: 'codex' as AgentAdapter['adapterType'],
      capabilities: () => ({ interactiveChat: true, toolCalling: true, toolForwarding: 'mcp_native' }),
      async connect() {},
      async disconnect() {},
      async healthCheck() { return { isHealthy: true, checkedAt: new Date().toISOString() }; },
      onEvent() {},
      async dispatchTask() {},
      async cancelTask() {},
      chat(_messages, _tools, options) {
        chatCalls += 1;
        invocationOptions.push(options);
        const call = chatCalls;
        return (async function* () {
          if (call === 1) {
            yield { type: 'tool_call', id: 't1', name: 'agentis.plan', args: { goal: 'x' } } as ChatDelta;
            yield { type: 'done', finishReason: 'tool_calls' } as ChatDelta;
            return;
          }
          yield { type: 'text', delta: 'Done.' } as ChatDelta;
          yield { type: 'done', finishReason: 'stop' } as ChatDelta;
        })();
      },
    };

    const deltas = await collect(ChatSessionExecutor.turn(harness, [], 'build me a thing', {
      workspaceId: 'ws_1', agentId: 'agent_1', userId: 'user_1', conversationId: 'conv_mcp',
    }));

    expect(chatCalls).toBe(2);
    expect(invocationOptions[0]).toMatchObject({
      toolMode: 'adapter_native',
      sessionKey: 'conv_mcp',
    });
    expect(deltas.some((d) => d.type === 'tool_call')).toBe(true);
    expect(deltas).toContainEqual({ type: 'text', delta: 'Done.' });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('skips MCP and remote context enrichment for lightweight conversation', async () => {
    let receivedTools: ToolDefinition[] = [];
    let enrichmentCalls = 0;
    const invocationOptions: Array<ChatInvocationOptions | undefined> = [];
    const harness: AgentAdapter = {
      adapterType: 'codex',
      capabilities: () => ({ interactiveChat: true, toolCalling: true, toolForwarding: 'mcp_native' }),
      async connect() {},
      async disconnect() {},
      async healthCheck() { return { isHealthy: true, checkedAt: new Date().toISOString() }; },
      onEvent() {},
      async dispatchTask() {},
      async cancelTask() {},
      chat(_messages, tools, options) {
        receivedTools = tools;
        invocationOptions.push(options);
        return (async function* () {
          yield { type: 'text', delta: 'Hello.' } as ChatDelta;
          yield { type: 'done', finishReason: 'stop' } as ChatDelta;
        })();
      },
    };
    ChatSessionExecutor.configure({
      brainDiscourse: { buildTurn: async () => { enrichmentCalls += 1; return null; } } as any,
      personalBrain: { contextForAgent: async () => { enrichmentCalls += 1; return null; } } as any,
      workspaceIntelligence: { buildContextBlock: async () => { enrichmentCalls += 1; return null; } } as any,
    });

    const deltas = await collect(ChatSessionExecutor.turn(harness, [], 'Hi', {
      workspaceId: 'ws_1', agentId: 'agent_1', userId: 'user_1', conversationId: 'conv_hi',
    }));

    expect(receivedTools).toEqual([]);
    expect(invocationOptions[0]).toMatchObject({
      toolMode: 'caller_loop',
      sessionKey: 'conv_hi',
    });
    expect(enrichmentCalls).toBe(0);
    expect(deltas).toContainEqual({ type: 'text', delta: 'Hello.' });
  });

  it('lets the agent submit a scoped patch for the active workflow', async () => {
    const adapter = new FakeChatAdapter(async function* (_messages, _tools, callIndex) {
      if (callIndex === 0) {
        yield {
          type: 'tool_call',
          id: 'patch-active-workflow',
          name: 'agentis.build_workflow',
          args: {
            workflowId: 'wf_active',
            description: 'update this workflow to send html emails',
            patchDraft: {
              addNodes: [],
              updateNodes: [],
              removeNodeIds: [],
              addEdges: [],
              removeEdgeIds: [],
            },
          },
        };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', delta: 'Updated the active workflow.' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(
      adapter,
      [],
      'update this workflow to send html emails',
      {
        workspaceId: 'ws_1',
        agentId: 'agent_1',
        userId: 'user_1',
        conversationId: 'conv_direct_update',
        clientTurnId: 'turn_update_1',
      },
      {
        viewport: {
          surface: 'workflow_detail',
          resourceKind: 'workflow',
          resourceId: 'wf_active',
          title: 'Workflow canvas',
        },
      },
    ));

    expect(adapter.calls).toHaveLength(2);
    expect(directBuildToolCalls).toBe(1);
    expect(directBuildToolArgs[0]).toMatchObject({
      workflowId: 'wf_active',
      description: 'update this workflow to send html emails',
      patchDraft: expect.objectContaining({ updateNodes: [] }),
    });
    expect(deltas).toContainEqual({ type: 'text', delta: 'Updated the active workflow.' });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('does not mutate a workflow when no target resource is available', async () => {
    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'Which workflow should I update?' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'update this workflow to send html emails', {
      workspaceId: 'ws_1',
      agentId: 'agent_1',
      userId: 'user_1',
      conversationId: 'conv_missing_target',
    }));

    expect(directBuildToolCalls).toBe(0);
    expect(adapter.calls).toHaveLength(1);
    expect(deltas).toContainEqual({ type: 'text', delta: 'Which workflow should I update?' });
  });

  it('keeps workflow architecture discussion in ordinary chat', async () => {
    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'Architecture explanation' };
      yield { type: 'done', finishReason: 'stop' };
    });

    await collect(ChatSessionExecutor.turn(
      adapter,
      [],
      'explain how to improve this workflow architecture',
      {
        workspaceId: 'ws_1',
        agentId: 'agent_1',
        userId: 'user_1',
        conversationId: 'conv_meta',
      },
      {
        viewport: {
          surface: 'workflow_detail',
          resourceKind: 'workflow',
          resourceId: 'wf_active',
          title: 'Workflow canvas',
        },
      },
    ));

    expect(directBuildToolCalls).toBe(0);
    expect(adapter.calls).toHaveLength(1);
  });

  it('uses the full tool loop when a workflow request also requires creating a capability', async () => {
    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'I will create the listener extension before building the workflow.' };
      yield { type: 'done', finishReason: 'stop' };
    });

    await collect(ChatSessionExecutor.turn(
      adapter,
      [],
      'Create a new extension that watches social posts, then build a workflow that emails matching posts.',
      {
        workspaceId: 'ws_1',
        agentId: 'agent_1',
        userId: 'user_1',
        conversationId: 'conv_capability_build',
      },
    ));

    expect(directBuildToolCalls).toBe(0);
    expect(adapter.calls).toHaveLength(1);
  });

  it('streams live build narration (phases + nodes) into the chat turn', async () => {
    // A build tool that publishes the real backend narration on the bus, keyed by
    // the build runId — exactly as createWorkflowFromDescription does.
    const bus = createInProcessEventBus();
    const registry = new AgentisToolRegistry({ logger: createLogger({ level: 'error' }) });
    registry.register(
      {
        id: 'agentis.build_workflow', family: 'build', description: 'b',
        inputSchema: { type: 'object', properties: { description: { type: 'string' } }, required: ['description'] },
        mutating: true, autoExecute: true,
      },
      async (args, toolCtx) => {
        const runId = String(toolCtx.runId ?? '');
        bus.publish('workspace:ws_1', REALTIME_EVENTS.WORKFLOW_BUILD_PHASE, { workflowId: 'wf1', runId, phase: 'drafting' });
        bus.publish('workspace:ws_1', REALTIME_EVENTS.CANVAS_NODE_PLACED, { workflowId: 'wf1', runId, node: { id: 'n1' }, nodeLabel: 'Fetch AI news' });
        bus.publish('workspace:ws_1', REALTIME_EVENTS.CANVAS_BUILD_COMPLETE, { workflowId: 'wf1', runId, nodeCount: 5, edgeCount: 4 });
        return { workflowId: 'wf1', runId, title: 'AI News', description: String(args.description), nodeCount: 5, edgeCount: 4, warnings: [] };
      },
    );
    ChatToolExecutor.configure({ registry });
    ChatSessionExecutor.configure({ bus });

    const adapter = new FakeChatAdapter(async function* (_messages, _tools, callIndex) {
      if (callIndex === 0) {
        yield {
          type: 'tool_call',
          id: 'build-narrated',
          name: 'agentis.build_workflow',
          args: {
            description: 'create a workflow that emails me the AI news',
            graphDraft: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
          },
        };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', delta: 'Workflow built.' };
      yield { type: 'done', finishReason: 'stop' };
    });
    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'create a workflow that emails me the AI news', {
      workspaceId: 'ws_1', agentId: 'agent_1', userId: 'user_1', conversationId: 'conv_narr', clientTurnId: 'turn_narr',
    }));

    const labels = deltas
      .filter((d): d is Extract<ChatDelta, { type: 'activity' }> => d.type === 'activity')
      .map((d) => d.label);
    expect(labels).toContain('Drafting the workflow graph');
    expect(labels.some((l) => l.startsWith('Placed Fetch AI news'))).toBe(true);
    expect(labels).toContain('Workflow ready');
  });

  it('keeps tool-round narration out of the final answer', async () => {
    const adapter = new FakeChatAdapter(async function* (_messages, _tools, callIndex) {
      if (callIndex === 0) {
        yield { type: 'thinking', delta: 'private reasoning' };
        yield { type: 'commentary', id: 'summary-1', text: 'I will inspect the available agents first.', source: 'reasoning_summary', createdAt: new Date().toISOString() };
        yield { type: 'text', delta: 'I will inspect the repository first.' };
        yield { type: 'tool_call', id: 'inspect-1', name: 'agentis.list_agents', args: {} };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', delta: 'The repository is ready.' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'Inspect it', {
      workspaceId: 'ws_1', agentId: 'agent_1', userId: 'user_1', conversationId: 'conv_final_only',
    }));

    const text = deltas
      .filter((delta): delta is Extract<ChatDelta, { type: 'text' }> => delta.type === 'text')
      .map((delta) => delta.delta)
      .join('');
    expect(text).toBe('The repository is ready.');
    expect(deltas.some((delta) => delta.type === 'thinking')).toBe(false);
    expect(deltas.some((delta) => delta.type === 'commentary' && delta.text === 'I will inspect the available agents first.')).toBe(true);
    expect(deltas.some((delta) => delta.type === 'commentary' && delta.source === 'assistant_preamble' && delta.text === 'I will inspect the repository first.')).toBe(true);
    expect(deltas.some((delta) => delta.type === 'tool_call' && delta.id === 'inspect-1')).toBe(true);
  });

  it('does not invent commentary when a runtime emits a bare tool call', async () => {
    const adapter = new FakeChatAdapter(async function* (_messages, _tools, callIndex) {
      if (callIndex === 0) {
        yield { type: 'tool_call', id: 'inspect-1', name: 'agentis.list_agents', args: {} };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', delta: 'Inspection complete.' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'Inspect it', {
      workspaceId: 'ws_1', agentId: 'agent_1', userId: 'user_1', conversationId: 'conv_no_fake_commentary',
    }));

    expect(deltas.some((delta) => delta.type === 'commentary' && delta.source === 'host')).toBe(false);
    expect(deltas.some((delta) => delta.type === 'activity' && /list agents/i.test(delta.label))).toBe(true);
  });

  it('streams assistant progress before the tool-call round finishes', async () => {
    let releaseToolCall!: () => void;
    const gate = new Promise<void>((resolve) => { releaseToolCall = resolve; });
    const adapter = new FakeChatAdapter(async function* (_messages, _tools, callIndex) {
      if (callIndex === 0) {
        yield { type: 'text', delta: 'I found the blocked workflow. ' };
        await gate;
        yield { type: 'text', delta: 'I am loading its repair capability now.' };
        yield { type: 'tool_call', id: 'load-1', name: 'agentis.list_agents', args: {} };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', delta: 'Repair capability loaded.' };
      yield { type: 'done', finishReason: 'stop' };
    });
    const iterator = ChatSessionExecutor.turn(adapter, [], 'Repair it', {
      workspaceId: 'ws_1', agentId: 'agent_1', userId: 'user_1', conversationId: 'conv_progressive',
    })[Symbol.asyncIterator]();

    let firstProgress: Extract<ChatDelta, { type: 'commentary' }> | undefined;
    for (let index = 0; index < 8; index += 1) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.type === 'commentary' && next.value.text.includes('blocked workflow')) {
        firstProgress = next.value;
        break;
      }
    }

    expect(firstProgress?.text).toBe('I found the blocked workflow.');
    releaseToolCall();
    const remaining: ChatDelta[] = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value);
    }
    expect(remaining).toContainEqual(expect.objectContaining({
      type: 'commentary',
      id: firstProgress?.id,
      text: 'I found the blocked workflow.',
    }));
  });

  it('keeps public progress to one bounded sentence', async () => {
    const longFollowUp = 'I am now describing routine implementation details that should not become a second answer in the live work transcript. '.repeat(4);
    const adapter = new FakeChatAdapter(async function* (_messages, _tools, callIndex) {
      if (callIndex === 0) {
        yield { type: 'commentary', id: 'compact-progress', text: `I found the cause. ${longFollowUp}`, source: 'reasoning_summary', createdAt: new Date().toISOString() };
        yield { type: 'tool_call', id: 'inspect-compact', name: 'agentis.list_agents', args: {} };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', delta: 'Done.' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'Inspect it', {
      workspaceId: 'ws_1', agentId: 'agent_1', userId: 'user_1', conversationId: 'conv_compact_progress',
    }));
    expect(deltas).toContainEqual(expect.objectContaining({
      type: 'commentary',
      id: 'compact-progress',
      text: 'I found the cause.',
    }));
  });

  it('streams runtime activity before the model turn completes', async () => {
    let releaseRuntime!: () => void;
    const runtimeGate = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    const adapter = new FakeChatAdapter(async function* () {
      yield {
        type: 'activity',
        id: 'runtime-live',
        phase: 'runtime',
        status: 'running',
        label: 'Inspecting the failed run',
        startedAt: new Date().toISOString(),
      };
      await runtimeGate;
      yield { type: 'text', delta: 'The run is fixed.' };
      yield { type: 'done', finishReason: 'stop' };
    });
    const iterator = ChatSessionExecutor.turn(adapter, [], 'Fix the run', {
      workspaceId: 'ws_1', agentId: 'agent_1', userId: 'user_1', conversationId: 'conv_live_activity',
    })[Symbol.asyncIterator]();

    const seen: ChatDelta[] = [];
    let foundLiveActivity = false;
    try {
      for (let index = 0; index < 10; index += 1) {
        const next = await new Promise<IteratorResult<ChatDelta>>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Runtime activity was buffered')), 500);
          iterator.next().then(
            (value) => {
              clearTimeout(timeout);
              resolve(value);
            },
            (error) => {
              clearTimeout(timeout);
              reject(error);
            },
          );
        });
        if (next.done) break;
        seen.push(next.value);
        if (next.value.type === 'activity' && next.value.id === 'runtime-live') {
          foundLiveActivity = true;
          break;
        }
      }
    } finally {
      releaseRuntime();
    }

    expect(foundLiveActivity).toBe(true);
    expect(seen.some((delta) => delta.type === 'text')).toBe(false);

    const remaining: ChatDelta[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value);
    }
    const finalText = remaining
      .filter((delta): delta is Extract<ChatDelta, { type: 'text' }> => delta.type === 'text')
      .map((delta) => delta.delta)
      .join('');
    expect(finalText).toBe('The run is fixed.');
  });

  it('recovers a reasoning-only turn instead of returning the empty fallback', async () => {
    // Round 0: the model reasons but emits no answer text (reasoning model burning
    // its budget thinking). Round 1 (the recovery retry): a real answer.
    const adapter = new FakeChatAdapter(async function* (_m, _t, callIndex) {
      if (callIndex === 0) {
        yield { type: 'thinking', delta: 'let me think about this…' };
        yield { type: 'done', finishReason: 'stop' };
      } else {
        yield { type: 'text', delta: 'here is the answer' };
        yield { type: 'done', finishReason: 'stop' };
      }
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'fix the trigger then', {
      workspaceId: 'ws_1', agentId: 'agent_1', userId: 'user_1', conversationId: 'conv_recover',
    }));

    const text = deltas.filter((d): d is Extract<ChatDelta, { type: 'text' }> => d.type === 'text').map((d) => d.delta).join('');
    expect(text).toContain('here is the answer');
    expect(text).not.toContain('didn’t produce a reply');
    expect(adapter.calls.length).toBe(2);
    // The retry appends an explicit "write your final answer" nudge.
    expect(String(adapter.calls[1]!.at(-1)!.content)).toContain('final answer');
  });

  it('recovers a truncated (finish_reason length) turn with a retry', async () => {
    const adapter = new FakeChatAdapter(async function* (_m, _t, callIndex) {
      if (callIndex === 0) {
        yield { type: 'done', finishReason: 'length' };
      } else {
        yield { type: 'text', delta: 'recovered answer' };
        yield { type: 'done', finishReason: 'stop' };
      }
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'summarize the long thing', {
      workspaceId: 'ws_1', agentId: 'agent_1', userId: 'user_1', conversationId: 'conv_len',
    }));

    const text = deltas.filter((d): d is Extract<ChatDelta, { type: 'text' }> => d.type === 'text').map((d) => d.delta).join('');
    expect(text).toContain('recovered answer');
    expect(adapter.calls.length).toBe(2);
  });

  it('gives an honest message when a reasoning-only turn stays empty after the retry', async () => {
    // Both passes reason without answering — after one retry, give up honestly
    // (and do NOT loop forever).
    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'thinking', delta: 'thinking…' };
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'do the thing', {
      workspaceId: 'ws_1', agentId: 'agent_1', userId: 'user_1', conversationId: 'conv_giveup',
    }));

    const text = deltas.filter((d): d is Extract<ChatDelta, { type: 'text' }> => d.type === 'text').map((d) => d.delta).join('');
    expect(text).toContain('didn’t manage to put my answer into words');
    expect(adapter.calls.length).toBe(2);
  });

  it('warns about repeated work when tools ran but the final round returned nothing', async () => {
    // Round 0 runs a real tool (side effects), then every later round (incl. the
    // retry) returns an empty stop — how a re-spawn/marker harness ends when its
    // wrap-up round surfaces nothing. The operator must be told work happened and
    // that a blind retry may repeat it — NOT the generic "retry freely" fallback.
    const adapter = new FakeChatAdapter(async function* (_messages, _tools, callIndex) {
      if (callIndex === 0) {
        yield { type: 'tool_call', id: 'tool_1', name: 'agentis.plan', args: { goal: 'rebuild interface' } };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'done', finishReason: 'stop' };
    });

    const deltas = await collect(ChatSessionExecutor.turn(adapter, [], 'do it', {
      workspaceId: 'ws_1', agentId: 'agent_1', userId: 'user_1', conversationId: 'conv_didwork',
    }));

    const text = deltas.filter((d): d is Extract<ChatDelta, { type: 'text' }> => d.type === 'text').map((d) => d.delta).join('');
    expect(deltas.some((d) => d.type === 'tool_result' && d.name === 'agentis.plan')).toBe(true);
    expect(text).toMatch(/ran one or more tools/i);
    expect(text).toMatch(/repeating the request may run those actions again/i);
    // Not the generic empty-turn message that implies a free retry.
    expect(text).not.toContain('completed without returning an answer');
  });
});
