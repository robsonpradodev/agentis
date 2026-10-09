import { describe, expect, it, vi } from 'vitest';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { ConversationTurnLeaseRegistry, proofReceiptsFromExperience } from '../../src/services/conversation/conversationTurnLease.js';
import { createLogger } from '../../src/logger.js';

describe('ConversationTurnLeaseRegistry', () => {
  it('can attach server-selected Mission context after the lease is issued', () => {
    const leases = new ConversationTurnLeaseRegistry();
    const token = leases.issue('workspace-1', 'conversation-1', { allowedToolIds: ['agentis.echo'] });

    expect(leases.updateContext('workspace-1', 'conversation-1', token, { missionId: 'mission-1' }))
      .toEqual({ allowedToolIds: ['agentis.echo'], missionId: 'mission-1' });
    expect(leases.context('workspace-1', 'conversation-1', token)?.missionId).toBe('mission-1');
  });

  it('supersedes prior generations and never lets stale completion revoke the new turn', () => {
    const leases = new ConversationTurnLeaseRegistry();
    const first = leases.issue('ws', 'conv');
    const firstSignal = leases.assertActive('ws', 'conv', first);
    const second = leases.issue('ws', 'conv');
    expect(firstSignal.aborted).toBe(true);
    expect(() => leases.assertActive('ws', 'conv', first)).toThrow(/not executed/i);
    leases.complete('ws', 'conv', first);
    const secondSignal = leases.assertActive('ws', 'conv', second);
    expect(leases.revoke('ws', 'conv')).toBe(true);
    expect(secondSignal.aborted).toBe(true);
  });

  it('carries server-authored channel authority through the opaque lease', () => {
    const leases = new ConversationTurnLeaseRegistry();
    const channelOrigin = {
      kind: 'whatsapp', connectionId: 'wa-1', chatId: '5511@s.whatsapp.net', ownerVerified: false,
    } as const;
    const token = leases.issue('ws', 'conv', { channelOrigin });
    expect(leases.context('ws', 'conv', token)).toEqual({ channelOrigin });
    leases.complete('ws', 'conv', token);
    expect(() => leases.context('ws', 'conv', token)).toThrow(/not executed/i);
  });

  it('blocks an in-process handler before invocation when the caller signal is aborted', async () => {
    const registry = new AgentisToolRegistry({ logger: createLogger({ level: 'error' }) });
    const handler = vi.fn(() => ({ mutated: true }));
    registry.register({
      id: 'test.mutate', family: 'build', description: 'test', inputSchema: { type: 'object' }, mutating: true,
    }, handler);
    const controller = new AbortController();
    controller.abort();
    const result = await registry.execute(
      { id: 'call', toolId: 'test.mutate', arguments: {} },
      { workspaceId: 'ws', userId: 'user', caller: 'chat', signal: controller.signal },
    );
    expect(result).toMatchObject({ ok: false, errorCode: 'TURN_CANCELLED' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('publishes an explicit restoration behavior for every mutating registration', () => {
    const registry = new AgentisToolRegistry({ logger: createLogger({ level: 'error' }) });
    registry.register({
      id: 'agentis.agents.update', family: 'build', description: 'local', inputSchema: {}, mutating: true,
    }, () => ({}));
    registry.register({
      id: 'agentis.channel.send', family: 'run', description: 'external', inputSchema: {}, mutating: true,
    }, () => ({}));
    expect(registry.catalog().tools.map((tool) => [tool.id, tool.mutationBehavior])).toEqual([
      ['agentis.agents.update', 'local'],
      ['agentis.channel.send', 'external'],
    ]);
  });

  it('records unlimited-capability compact experience and coalesces unchanged reads', () => {
    const leases = new ConversationTurnLeaseRegistry();
    const token = leases.issue('ws', 'conv');
    const first = leases.recordToolResult({
      workspaceId: 'ws', conversationId: 'conv', token,
      name: 'agentis.app.compile', toolArgs: { appId: 'app-1' },
      result: { counts: { block: 4 } }, ok: true, mutating: false, durationMs: 12,
    });
    const repeated = leases.recordToolResult({
      workspaceId: 'ws', conversationId: 'conv', token,
      name: 'agentis.app.compile', toolArgs: { appId: 'app-1' },
      result: { counts: { block: 4 } }, ok: true, mutating: false, durationMs: 8,
    });
    leases.recordToolResult({
      workspaceId: 'ws', conversationId: 'conv', token,
      name: 'agentis.data.batch', toolArgs: { operations: [{ operation: 'update' }] },
      result: { ok: true }, ok: true, mutating: true, durationMs: 4,
    });
    const afterMutation = leases.recordToolResult({
      workspaceId: 'ws', conversationId: 'conv', token,
      name: 'agentis.app.compile', toolArgs: { appId: 'app-1' },
      result: { counts: { block: 2 } }, ok: true, mutating: false, durationMs: 7,
    });
    leases.recordRecalledAtoms('ws', 'conv', token, ['mem-1', 'mem-1', 'mem-2']);

    expect(first.repeated).toBe(false);
    expect(repeated).toMatchObject({ repeated: true, observationIndex: 1 });
    expect(afterMutation.repeated).toBe(false);
    const experience = leases.experience('ws', 'conv', token);
    expect(experience.toolCalls).toBe(4);
    expect(experience.observations).toHaveLength(3);
    expect(experience.observations[0]).toMatchObject({ repeats: 2, durationMs: 20 });
    expect(experience.recalledAtomIds).toEqual(['mem-1', 'mem-2']);
    expect(experience.efficiency).toMatchObject({
      uniqueObservations: 3,
      coalescedReads: 1,
      mutatingCalls: 1,
      repeatedResultChars: expect.any(Number),
    });
    expect(experience.efficiency.repeatedResultChars).toBeGreaterThan(0);
  });

  it('derives revision-bound mutation and verification receipts without trusting prose', () => {
    const receipts = proofReceiptsFromExperience({
      toolCalls: 2,
      recalledAtomIds: [],
      efficiency: { uniqueObservations: 2, coalescedReads: 0, mutatingCalls: 1, argumentCharsObserved: 0, resultCharsObserved: 0, repeatedResultChars: 0 },
      observations: [
        { index: 1, name: 'agentis.ui.render', args: {}, result: { appId: 'app-1', interfaceRevisionId: 'rev-1', semanticHash: 'hash-1' }, ok: true, mutating: true, repeats: 1, durationMs: 4 },
        { index: 2, name: 'agentis.app.verify', args: {}, result: { appId: 'app-1', revisionId: 'rev-1', passed: true }, ok: true, mutating: false, repeats: 1, durationMs: 6 },
      ],
    });
    expect(receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'persisted_mutation', resourceId: 'app-1', revisionId: 'rev-1', status: 'passed' }),
      expect.objectContaining({ kind: 'functional_verification', resourceId: 'app-1', revisionId: 'rev-1', status: 'passed' }),
    ]));
  });

  it('does not mistake inspection or synthetic dry-run output for functional proof', () => {
    const receipts = proofReceiptsFromExperience({
      toolCalls: 3,
      recalledAtomIds: [],
      efficiency: { uniqueObservations: 3, coalescedReads: 0, mutatingCalls: 1, argumentCharsObserved: 0, resultCharsObserved: 0, repeatedResultChars: 0 },
      observations: [
        { index: 1, name: 'agentis.workflow.revision.inspect', args: {}, result: { workflowId: 'wf-1', revisionId: 'old', passed: true }, ok: true, mutating: false, repeats: 1, durationMs: 1 },
        { index: 2, name: 'agentis.workflow.build', args: {}, result: { workflowId: 'wf-1', revisionId: 'rev-2', semanticHash: 'hash-2' }, ok: true, mutating: true, repeats: 1, durationMs: 2 },
        { index: 3, name: 'agentis.workflow.dry_run', args: {}, result: { workflowId: 'wf-1', revisionId: 'rev-2', passed: true }, ok: true, mutating: false, repeats: 1, durationMs: 3 },
      ],
    });
    expect(receipts.some((receipt) => receipt.kind === 'functional_verification')).toBe(false);
    expect(receipts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'observed_state', revisionId: 'rev-2' })]));
  });

  it('does not count a proof-run mutation as construction of the requested resource', () => {
    const receipts = proofReceiptsFromExperience({
      toolCalls: 1,
      recalledAtomIds: [],
      efficiency: { uniqueObservations: 1, coalescedReads: 0, mutatingCalls: 1, argumentCharsObserved: 0, resultCharsObserved: 0, repeatedResultChars: 0 },
      observations: [
        { index: 1, name: 'agentis.workflow.revision.verify', args: {}, result: { workflowId: 'wf-1', revisionId: 'rev-1', passed: true }, ok: true, mutating: true, repeats: 1, durationMs: 3 },
      ],
    });
    expect(receipts).toEqual([]);
  });
});
