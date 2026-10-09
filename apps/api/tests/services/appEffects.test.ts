import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import { AgentMissionService } from '../../src/services/agentMissions.js';
import { AppEffectService } from '../../src/services/appEffects.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(() => ctx.close());

function setup() {
  const agentId = randomUUID();
  ctx.db
    .insert(schema.agents)
    .values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      name: 'Operator',
      adapterType: 'http',
      config: {},
    })
    .run();
  const missions = new AgentMissionService(ctx.db, ctx.bus);
  const mission = missions.create({
    workspaceId: ctx.workspace.id,
    ownerAgentId: agentId,
    sourceKind: 'api',
    objective: 'Send the invoice',
  });
  const authority = {
    workspaceId: ctx.workspace.id,
    ownerPrincipalId: ctx.user.id,
    initiatorPrincipalId: ctx.user.id,
    actorPrincipalId: agentId,
    delegationChain: [],
    scopes: ['invoice:send'],
    maxEffectLevel: 'compensatable' as const,
    maxSpendCents: 200,
  };
  return { missions, mission, authority };
}

describe('AppEffectService', () => {
  it('binds authorization to an immutable plan and reconciles a compensatable effect', () => {
    const { missions, mission, authority } = setup();
    const effects = new AppEffectService(ctx.db, missions);
    const prepared = effects.prepare({
      workspaceId: ctx.workspace.id,
      missionId: mission.id,
      operationId: 'invoice.send',
      input: { invoiceId: 'inv-1' },
      targets: [{ resourceType: 'invoice', resourceId: 'inv-1' }],
      consequences: ['Send invoice to customer'],
      reversibility: 'compensatable',
      compensationOperationId: 'invoice.recall',
      estimatedCostCents: { min: 2, max: 5 },
      idempotencyKey: 'invoice:inv-1',
      authorityContext: authority,
      approval: 'policy',
    });
    expect(prepared.status).toBe('awaiting_authorization');
    expect(missions.inspect(ctx.workspace.id, mission.id).status).toBe('approval_required');

    const replay = effects.prepare({
      workspaceId: ctx.workspace.id,
      missionId: mission.id,
      operationId: 'invoice.send',
      input: { ignored: true },
      reversibility: 'compensatable',
      compensationOperationId: 'invoice.recall',
      idempotencyKey: 'invoice:inv-1',
      authorityContext: authority,
      approval: 'policy',
    });
    expect(replay.id).toBe(prepared.id);
    expect(replay.planHash).toBe(prepared.planHash);

    const authorized = effects.authorize(ctx.workspace.id, prepared.id, {
      approvedBy: ctx.user.id,
      authorityContext: authority,
    });
    expect(authorized.grant.planHash).toBe(prepared.planHash);
    expect(authorized.plan.status).toBe('authorized');
    expect(missions.inspect(ctx.workspace.id, mission.id).status).toBe('queued');

    const authorizationReplay = effects.authorize(ctx.workspace.id, prepared.id, {
      approvedBy: ctx.user.id,
      authorityContext: authority,
    });
    expect(authorizationReplay.grant.id).toBe(authorized.grant.id);

    effects.beginExecution(ctx.workspace.id, prepared.id);
    const inFlightReplay = effects.authorize(ctx.workspace.id, prepared.id, {
      approvedBy: ctx.user.id,
      authorityContext: authority,
    });
    expect(inFlightReplay.plan.status).toBe('executing');
    expect(inFlightReplay.grant.id).toBe(authorized.grant.id);
    effects.executed(ctx.workspace.id, prepared.id, { providerId: 'mail-1' });
    expect(effects.reconcile(ctx.workspace.id, prepared.id, { delivered: true }).status).toBe(
      'completed',
    );
    expect(effects.compensate(ctx.workspace.id, prepared.id, { recalled: true }).status).toBe(
      'compensated',
    );
  });

  it('enforces effect and spend ceilings before a plan is persisted', () => {
    const { missions, mission, authority } = setup();
    const effects = new AppEffectService(ctx.db, missions);
    expect(() =>
      effects.prepare({
        workspaceId: ctx.workspace.id,
        missionId: mission.id,
        operationId: 'invoice.delete',
        input: {},
        reversibility: 'irreversible',
        idempotencyKey: 'delete:1',
        authorityContext: authority,
        approval: 'always',
      }),
    ).toThrow(/does not allow irreversible/);
    expect(() =>
      effects.prepare({
        workspaceId: ctx.workspace.id,
        missionId: mission.id,
        operationId: 'invoice.send',
        input: {},
        reversibility: 'reversible',
        estimatedCostCents: { min: 300, max: 400 },
        idempotencyKey: 'send:expensive',
        authorityContext: authority,
        approval: 'never',
      }),
    ).toThrow(/spend ceiling/);
  });
});
