/**
 * WorkflowEngine — `channel` node.
 *
 * A deterministic workflow can actually SEND on a native channel (the gap: an
 * outreach workflow could compute a message but never deliver it). Success →
 * a delivery receipt as output + the port called; a send failure → the node
 * FAILS (never a hollow success), and `{{templates}}` in the body resolve from
 * upstream output.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import type { ChannelSendPort, ChannelSendResult } from '../../src/services/conversation/channelSend.js';
import { buildInitialRunState } from '../../src/engine/initialRunState.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

async function runChannel(port: ChannelSendPort, ownerAgentId: string | null = null): Promise<{ status: string; output: Record<string, unknown> }> {
  const graph = {
    version: 1, viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 't', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      // compose an object with `name`, then the channel node templates it into the body.
      { id: 'C', type: 'transform', title: 'c', position: { x: 1, y: 0 }, config: { kind: 'transform', expression: '({ name: "Ada" })' } },
      { id: 'S', type: 'channel', title: 'send', position: { x: 2, y: 0 }, config: { kind: 'channel', channelKind: 'whatsapp', to: 'default', body: 'Oi {{nodes.C.name}}', outputKey: 'delivery' } },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'C' }, { id: 'e2', source: 'C', target: 'S' }],
  } as unknown as WorkflowGraph;
  const wfId = randomUUID();
  const runId = randomUUID();
  ctx.db.insert(schema.workflows).values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, ownerAgentId, title: 'ch-wf', graph, settings: {} }).run();
  ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'CREATED', runState: {} }).run();

  const engine = new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    extensions: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
    channelSend: port,
  });
  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
  const status = await new Promise<string>((resolve) => {
    const off = ctx.bus.subscribe((m) => {
      if (m.room !== `run:${runId}`) return;
      if (m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED) { off(); resolve('COMPLETED'); }
      else if (m.envelope.event === REALTIME_EVENTS.RUN_FAILED) { off(); resolve('FAILED'); }
    });
    void engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph });
  });
  const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
  const state = run.runState as { nodeStates: Record<string, { outputData?: Record<string, unknown> }> };
  return { status: run.status ?? status, output: state.nodeStates.S?.outputData ?? {} };
}

describe('WorkflowEngine — channel node', () => {
  it('delivers via the channel port (templated body) and stores a delivery receipt', async () => {
    const calls: Array<{ kind?: string | null; body: string; to?: string | null; agentId?: string | null; persistOutboundContext?: boolean }> = [];
    const port: ChannelSendPort = {
      async send(args) {
        calls.push({ kind: args.kind, body: args.body, to: args.to, agentId: args.agentId, persistOutboundContext: args.persistOutboundContext });
        return {
          sent: true,
          verified: true,
          connectionId: 'wa1',
          kind: 'whatsapp',
          to: '+5511',
          targetSource: 'default',
          status: 'active',
          attachments: 0,
          providerMessageId: 'wamid.generic-1',
          deliveryStatus: 'accepted',
          acceptedAt: '2026-07-14T00:00:00.000Z',
          receipt: { provider: 'whatsapp', providerMessageId: 'wamid.generic-1', status: 'accepted', acceptedAt: '2026-07-14T00:00:00.000Z', recipient: '+5511' },
        } satisfies ChannelSendResult;
      },
    };
    const { status, output } = await runChannel(port);
    expect(status).toBe('COMPLETED');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe('whatsapp');
    expect(calls[0]!.body).toBe('Oi Ada'); // {{nodes.C.name}} resolved
    expect(calls[0]!.persistOutboundContext).toBe(true);
    expect((output.delivery as { sent: boolean }).sent).toBe(true);
    expect((output.delivery as { connectionId: string }).connectionId).toBe('wa1');
    expect((output.delivery as { verified: boolean }).verified).toBe(true);
    expect((output.delivery as { providerMessageId: string }).providerMessageId).toBe('wamid.generic-1');
  });

  it('attributes a deterministic channel delivery to the workflow owner', async () => {
    const ownerAgentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: ownerAgentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id,
      userId: ctx.user.id, name: 'Ava', adapterType: 'http',
    }).run();
    let callerAgentId: string | null | undefined;
    const port: ChannelSendPort = {
      async send(args) {
        callerAgentId = args.agentId;
        return {
          sent: true, verified: true, connectionId: 'wa1', kind: 'whatsapp', to: '+5511', targetSource: 'default', status: 'active', attachments: 0,
          providerMessageId: 'wamid.owner-1', deliveryStatus: 'accepted', acceptedAt: '2026-07-14T00:00:00.000Z',
          receipt: { provider: 'whatsapp', providerMessageId: 'wamid.owner-1', status: 'accepted', acceptedAt: '2026-07-14T00:00:00.000Z', recipient: '+5511' },
        } satisfies ChannelSendResult;
      },
    };
    const { status } = await runChannel(port, ownerAgentId);
    expect(status).toBe('COMPLETED');
    expect(callerAgentId).toBe(ownerAgentId);
  });

  it('FAILS the node when the send does not go through (no hollow success)', async () => {
    const port: ChannelSendPort = {
      async send() { return { sent: false, errorCode: 'CHANNEL_TARGET_AMBIGUOUS_OR_MISSING', error: 'no whatsapp connection' }; },
    };
    const { status } = await runChannel(port);
    expect(status).toBe('FAILED');
  });
});
