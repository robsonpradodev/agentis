import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import { AgentStandingGoalService } from '../../src/services/agentStandingGoals.js';
import { readResidency } from '../../src/services/residency.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

describe('AgentStandingGoalService', () => {
  it('compiles a draft and activates it on the existing residency driver', () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({ id: agentId, workspaceId: ctx.workspace.id, userId: ctx.user.id, name: 'Ava', adapterType: 'http', config: {} }).run();
    const service = new AgentStandingGoalService(ctx.db);
    const draft = service.compile({ workspaceId: ctx.workspace.id, agentId, instructions: 'Contact eligible leads and follow up within policy.' });
    expect(draft.status).toBe('draft');
    expect(service.inspect(ctx.workspace.id, agentId, draft.id).id).toBe(draft.id);
    const review = service.reviewDiff(ctx.workspace.id, agentId, draft.id);
    expect(review.source.instructions).toBe('Contact eligible leads and follow up within policy.');
    expect(review.compiled.policy.eventWakes).toEqual(expect.arrayContaining(['channel.inbound', 'channel.action.settled', 'workflow.failed']));
    expect(review.changes.some((change) => change.field === 'policy.capabilities')).toBe(true);
    const active = service.activate(ctx.workspace.id, agentId, draft.id);
    expect(active.status).toBe('active');
    const agent = ctx.db.select({ config: schema.agents.config }).from(schema.agents).get()!;
    expect(readResidency(agent.config)?.activeGoalIds).toContain(draft.id);
    const paused = service.pause(ctx.workspace.id, agentId, draft.id);
    expect(paused.status).toBe('paused');
    expect(readResidency(ctx.db.select({ config: schema.agents.config }).from(schema.agents).get()!.config)).toBeNull();
  });

  it('revises a paused goal as a new inactive draft version', () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({ id: agentId, workspaceId: ctx.workspace.id, userId: ctx.user.id, name: 'Ava', adapterType: 'http', config: {} }).run();
    const service = new AgentStandingGoalService(ctx.db);
    const draft = service.compile({ workspaceId: ctx.workspace.id, agentId, instructions: 'Contact eligible leads.' });
    service.activate(ctx.workspace.id, agentId, draft.id);
    service.pause(ctx.workspace.id, agentId, draft.id);

    const revised = service.revise({
      workspaceId: ctx.workspace.id,
      agentId,
      goalId: draft.id,
      title: 'First contact',
      instructions: 'Contact eligible leads and stop after a reply.',
      policy: { maxActionsPerHour: 5, eventWakes: ['lead.created', 'channel.inbound'] },
    });

    expect(revised).toMatchObject({ status: 'draft', version: 2, title: 'First contact' });
    expect(revised.policy.maxActionsPerHour).toBe(5);
    expect(revised.policy.eventWakes).toEqual(['lead.created', 'channel.inbound']);
    expect(readResidency(ctx.db.select({ config: schema.agents.config }).from(schema.agents).get()!.config)).toBeNull();
  });

  it('requires an active goal to be paused before editing', () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({ id: agentId, workspaceId: ctx.workspace.id, userId: ctx.user.id, name: 'Ava', adapterType: 'http', config: {} }).run();
    const service = new AgentStandingGoalService(ctx.db);
    const draft = service.compile({ workspaceId: ctx.workspace.id, agentId, instructions: 'Contact eligible leads.' });
    service.activate(ctx.workspace.id, agentId, draft.id);

    expect(() => service.revise({ workspaceId: ctx.workspace.id, agentId, goalId: draft.id, title: 'Changed live' }))
      .toThrowError(/Pause this standing goal before editing/);
  });
});
