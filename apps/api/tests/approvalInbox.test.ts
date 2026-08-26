/**
 * ApprovalInboxService — V1-SPEC §11.10 approval lifecycle.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AgentisError, REALTIME_EVENTS } from '@agentis/core';
import { openSqlite, schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import { ApprovalInboxService } from '../src/services/approvalInbox.js';
import { createInProcessEventBus, type EventBus } from '../src/event-bus.js';

let db: AgentisSqliteDb;
let bus: EventBus;
let svc: ApprovalInboxService;
const baseArgs = {
  workspaceId: 'ws1',
  ambientId: null,
  userId: 'u1',
  runId: 'r1',
  taskId: 't1',
  gatewayId: null,
  source: 'checkpoint' as const,
  title: 'Confirm step',
  summary: 'About to delete a thing',
  confidence: 0.9,
};

beforeEach(() => {
  const opened = openSqlite({ path: ':memory:' });
  db = opened.db;
  opened.sqlite.pragma('foreign_keys = OFF');
  bus = createInProcessEventBus();
  svc = new ApprovalInboxService(db, bus);
});

describe('ApprovalInboxService', () => {
  it('creates pending approvals and emits APPROVAL_REQUESTED', async () => {
    const events: string[] = [];
    bus.subscribe((m) => {
      if (m.room === 'workspace:ws1') events.push(m.envelope.event);
    });
    const created = await svc.create(baseArgs);
    expect(created.status).toBe('pending');
    expect(events).toContain(REALTIME_EVENTS.APPROVAL_REQUESTED);
  });

  it('lists pending vs all', async () => {
    await svc.create(baseArgs);
    expect(svc.list('ws1', 'pending')).toHaveLength(1);
    expect(svc.list('ws1', 'all')).toHaveLength(1);
  });

  it('expires a pending run-bound approval when its run is terminal', async () => {
    db.insert(schema.workflowRuns).values({
      id: 'terminal-run',
      workspaceId: 'ws1',
      userId: 'u1',
      workflowId: 'wf1',
      status: 'FAILED',
      runState: {},
    }).run();
    const created = await svc.create({ ...baseArgs, runId: 'terminal-run' });
    expect(svc.list('ws1', 'pending')).toHaveLength(0);
    expect(svc.get('ws1', created.id)?.status).toBe('expired');
    expect(svc.list('ws1', 'all')).toHaveLength(1);
  });

  it('expires a revision approval when its candidate was abandoned before review', async () => {
    db.insert(schema.workflows).values({
      id: 'workflow-1',
      workspaceId: 'ws1',
      userId: 'u1',
      title: 'Prospecting',
      graph: {},
      settings: {},
      activeRevisionId: 'active-revision',
      candidateRevisionId: null,
    }).run();
    db.insert(schema.workflowGraphRevisions).values({
      id: 'candidate-revision',
      workspaceId: 'ws1',
      workflowId: 'workflow-1',
      graphJson: {},
      semanticHash: 'reviewed-hash',
      presentationHash: 'presentation-hash',
      source: 'agent_patch',
      status: 'rejected',
    }).run();
    const approval = await svc.create({
      ...baseArgs,
      runId: null,
      taskId: null,
      source: 'workflow_revision',
      payload: {
        workspaceId: 'ws1',
        workflowId: 'workflow-1',
        revisionId: 'candidate-revision',
        semanticHash: 'reviewed-hash',
        expectedActiveRevisionId: 'active-revision',
      },
    });

    expect(svc.list('ws1', 'pending')).toEqual([]);
    expect(svc.get('ws1', approval.id)).toMatchObject({
      status: 'expired',
      resolutionReason: 'Workflow revision is no longer the current candidate.',
    });
    await expect(svc.resolve({
      workspaceId: 'ws1',
      approvalId: approval.id,
      decision: 'approve',
    })).rejects.toThrow('Approval already expired');
  });

  it('resolve(approve) on a checkpoint fires the resume handler with decision', async () => {
    let handlerCalled: { runId: string; approvalId: string; source: string; decision: string } | null = null;
    svc.bindCheckpointHandler(async (a) => {
      handlerCalled = a;
    });
    const created = await svc.create(baseArgs);
    const resolved = await svc.resolve({
      workspaceId: 'ws1',
      approvalId: created.id,
      decision: 'approve',
    });
    expect(resolved.status).toBe('approved');
    // Human-gate enforcement: the handler carries source + decision so the
    // engine can resume the held run.
    expect(handlerCalled).toMatchObject({ runId: 'r1', approvalId: created.id, source: 'checkpoint', decision: 'approve' });
  });

  it('resolve(reject) fires the handler so the run-gate can fail deterministically', async () => {
    let handlerCalled: { decision: string } | null = null;
    svc.bindCheckpointHandler(async (a) => {
      handlerCalled = a;
    });
    const created = await svc.create(baseArgs);
    const resolved = await svc.resolve({
      workspaceId: 'ws1',
      approvalId: created.id,
      decision: 'reject',
      reason: 'no thanks',
    });
    expect(resolved.status).toBe('rejected');
    expect(resolved.resolutionReason).toBe('no thanks');
    // Reject must reach the engine (failRunForGate) — not silently drop.
    expect(handlerCalled).toMatchObject({ decision: 'reject' });
  });

  it('persists self-heal payloads and routes them through the run resume handler', async () => {
    let handlerCalled: { source: string; targetId: string | null; decision: string } | null = null;
    svc.bindCheckpointHandler(async (a) => {
      handlerCalled = a;
    });
    const created = await svc.create({
      ...baseArgs,
      source: 'self_heal',
      targetId: 'node-a',
      payload: { kind: 'self_heal', patch: { patchId: 'p1' } },
    });

    expect(created.payload).toMatchObject({ kind: 'self_heal' });
    expect(svc.list('ws1', 'pending')[0]?.payload).toMatchObject({ kind: 'self_heal' });

    await svc.resolve({
      workspaceId: 'ws1',
      approvalId: created.id,
      decision: 'approve',
    });

    expect(handlerCalled).toMatchObject({ source: 'self_heal', targetId: 'node-a', decision: 'approve' });
  });

  it('fires the outbound handler on an outbound approval (G7 deliver-on-approve)', async () => {
    const calls: Array<{ decision: string; payload: Record<string, unknown> }> = [];
    svc.bindOutboundHandler(async (a) => { calls.push({ decision: a.decision, payload: a.payload }); });
    const created = await svc.create({
      ...baseArgs,
      runId: null,
      taskId: null,
      source: 'outbound',
      title: 'Approve outbound to Maria',
      summary: 'The resident agent wants to send: "10% discount".',
      payload: { appId: 'app-1', conversationId: 'conv-1', connectionId: 'conn-1', chatId: '42', body: '10% discount' },
    });
    await svc.resolve({ workspaceId: 'ws1', approvalId: created.id, decision: 'approve' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ decision: 'approve', payload: { appId: 'app-1', body: '10% discount' } });
  });

  it('fires the outbound handler on reject too (so the held message is dropped)', async () => {
    const calls: string[] = [];
    svc.bindOutboundHandler(async (a) => { calls.push(a.decision); });
    const created = await svc.create({ ...baseArgs, runId: null, taskId: null, source: 'outbound', payload: { body: 'x' } });
    await svc.resolve({ workspaceId: 'ws1', approvalId: created.id, decision: 'reject' });
    expect(calls).toEqual(['reject']);
  });

  it('throws RESOURCE_CONFLICT when resolving an already-resolved approval', async () => {
    const created = await svc.create(baseArgs);
    await svc.resolve({ workspaceId: 'ws1', approvalId: created.id, decision: 'approve' });
    await expect(
      svc.resolve({ workspaceId: 'ws1', approvalId: created.id, decision: 'approve' }),
    ).rejects.toThrow(AgentisError);
  });

  it('throws RESOURCE_NOT_FOUND for unknown approvals', async () => {
    await expect(
      svc.resolve({ workspaceId: 'ws1', approvalId: 'nope', decision: 'approve' }),
    ).rejects.toThrow(AgentisError);
  });
});
