import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { DurableSuspensionService } from '../../src/services/suspension/durableSuspensionService.js';
import { HumanResponseSuspensionPresenter } from '../../src/services/suspension/humanResponsePresenter.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
  ctx.db.insert(schema.agents).values({
    id: 'agent-1',
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    name: 'General Agent',
    role: 'agent',
    adapterType: 'http',
    status: 'online',
  }).run();
});

afterEach(() => ctx.close());

describe('DurableSuspensionService', () => {
  it('supports plugin-defined conditions and origins with idempotent wait and single-consumption replay', async () => {
    const service = new DurableSuspensionService({ db: ctx.db, logger: ctx.logger });
    const present = vi.fn(async () => ({ ref: 'custom-presentation-1' }));
    const resume = vi.fn(async () => undefined);
    service.registerPresenter('resource_transition', { present });
    service.registerResumer('plugin_job', { resume });

    const input = {
      workspaceId: ctx.workspace.id,
      ownerAgentId: 'agent-1',
      requesterUserId: ctx.user.id,
      origin: { type: 'plugin_job', id: 'job-42' },
      condition: { type: 'resource_transition', payload: { resource: 'invoice-7', state: 'settled' } },
      audience: { type: 'event_bus', target: 'billing.events' },
      reason: 'The invoice must settle before fulfillment.',
      publicReceipt: 'I am waiting for settlement and will continue automatically.',
      continuation: { attempt: 2 },
    };

    const first = await service.suspend(input);
    const duplicate = await service.suspend(input);
    expect(first.state).toBe('waiting');
    expect(duplicate.suspensionId).toBe(first.suspensionId);
    expect(present).toHaveBeenCalledTimes(1);

    await service.resolve({
      workspaceId: ctx.workspace.id,
      suspensionId: first.suspensionId,
      resolution: { kind: 'resource_transition', data: { state: 'settled', version: 3 } },
    });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]![0].origin).toEqual(expect.objectContaining({ type: 'plugin_job', id: 'job-42' }));
    expect(resume.mock.calls[0]![1]).toEqual({ attempt: 2 });

    const consumed = await service.suspend(input);
    expect(consumed.state).toBe('resolved');
    expect(consumed.resolution).toEqual(expect.objectContaining({
      kind: 'resource_transition',
      data: { state: 'settled', version: 3 },
    }));
    expect(service.get(ctx.workspace.id, first.suspensionId)?.state).toBe('resumed');

    // Once consumed, the same correlation key is historical and cannot create a
    // duplicate wait or replay the same resolution twice.
    const historical = await service.suspend(input);
    expect(historical.suspensionId).toBe(first.suspensionId);
    expect(historical.state).toBe('resolved');
    expect(present).toHaveBeenCalledTimes(1);
  });

  it('uses human response as one presenter and resumes with structured fields', async () => {
    const approvals = new ApprovalInboxService(ctx.db, ctx.bus);
    const service = new DurableSuspensionService({ db: ctx.db, logger: ctx.logger });
    service.registerPresenter('human_response', new HumanResponseSuspensionPresenter({ approvals, suspensions: service }));
    const resume = vi.fn(async () => undefined);
    service.registerResumer('conversation_turn', { resume });

    const waiting = await service.suspend({
      workspaceId: ctx.workspace.id,
      ownerAgentId: 'agent-1',
      requesterUserId: ctx.user.id,
      origin: { type: 'conversation_turn', id: 'turn-1' },
      condition: {
        type: 'human_response',
        payload: {
          title: 'Clarify the policy',
          prompt: 'Which refund window should I communicate?',
          fields: [{ key: 'days', label: 'Refund window in days', type: 'number', required: true }],
        },
      },
      audience: { type: 'workspace_role', target: 'operator' },
      reason: 'No authoritative refund window is available.',
      publicReceipt: "I'm checking the policy owner and will get back to you.",
    });

    const inbox = approvals.list(ctx.workspace.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toEqual(expect.objectContaining({
      source: 'durable_suspension',
      title: 'Clarify the policy',
      summary: 'Which refund window should I communicate?',
    }));

    await expect(approvals.resolve({
      workspaceId: ctx.workspace.id,
      approvalId: inbox[0]!.id,
      decision: 'approve',
      resolvedByUserId: ctx.user.id,
      data: {},
    })).rejects.toThrow('Required response fields are missing');

    await approvals.resolve({
      workspaceId: ctx.workspace.id,
      approvalId: inbox[0]!.id,
      decision: 'approve',
      resolvedByUserId: ctx.user.id,
      data: { days: 30 },
    });
    expect(resume).toHaveBeenCalledTimes(1);

    const consumed = await service.suspend({
      workspaceId: ctx.workspace.id,
      ownerAgentId: 'agent-1',
      requesterUserId: ctx.user.id,
      origin: { type: 'conversation_turn', id: 'turn-1' },
      condition: { type: 'human_response', payload: { prompt: 'This text may differ after restart.' } },
      audience: { type: 'workspace_role', target: 'operator' },
      reason: 'Resume the original execution.',
    });
    expect(consumed.state).toBe('resolved');
    expect(consumed.resolution?.data).toEqual({ days: 30 });
    expect(consumed.suspensionId).toBe(waiting.suspensionId);
  });

  it('recovers ready continuations and expires due waits without knowing their domains', async () => {
    const service = new DurableSuspensionService({ db: ctx.db, logger: ctx.logger });
    service.registerPresenter('webhook', { present: async () => ({ ref: 'hook-1' }) });
    const resume = vi.fn(async () => undefined);
    service.registerResumer('external_process', { resume });

    const ready = await service.suspend({
      workspaceId: ctx.workspace.id,
      origin: { type: 'external_process', id: 'process-ready' },
      condition: { type: 'webhook', payload: { topic: 'done' } },
      audience: { type: 'webhook', target: 'integration-a' },
      reason: 'Wait for callback.',
    });
    await service.resolve({
      workspaceId: ctx.workspace.id,
      suspensionId: ready.suspensionId,
      resolution: { kind: 'callback', data: { ok: true } },
    });
    resume.mockClear();

    const expired = await service.suspend({
      workspaceId: ctx.workspace.id,
      origin: { type: 'external_process', id: 'process-expired' },
      condition: { type: 'webhook', payload: { topic: 'late' } },
      audience: { type: 'webhook', target: 'integration-a' },
      reason: 'Wait for a late callback.',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    ctx.sqlite.prepare('UPDATE durable_suspensions SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), expired.suspensionId);

    const recovered = await service.recover();
    expect(recovered).toEqual({ expired: 1, resumed: 1 });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(service.get(ctx.workspace.id, expired.suspensionId)?.state).toBe('expired');
  });
});
