import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { AgentStandingGoalService } from '../../src/services/agentStandingGoals.js';
import { StandingGoalWakeRouter } from '../../src/services/standingGoalWakeRouter.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

describe('StandingGoalWakeRouter', () => {
  it('routes inbound and delivery-state events only from an allowed connection', () => {
    const agentId = randomUUID(); const connectionId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId, workspaceId: ctx.workspace.id, userId: ctx.user.id,
      name: 'Ava', adapterType: 'http', config: {},
    }).run();
    const goals = new AgentStandingGoalService(ctx.db);
    const goal = goals.compile({
      workspaceId: ctx.workspace.id, agentId, instructions: 'Continue durable customer conversations.',
      policy: { connectionIds: [connectionId] },
    });
    goals.activate(ctx.workspace.id, agentId, goal.id);
    const post = vi.fn();
    const router = new StandingGoalWakeRouter(ctx.db, {
      getByKey: () => ({ id: 'resident-entity', status: 'active' }),
      post,
    } as never);
    const event = (name: typeof REALTIME_EVENTS.CHANNEL_MESSAGE_RECEIVED | typeof REALTIME_EVENTS.CHANNEL_MESSAGE_STATUS, id: string) => ({
      room: REALTIME_ROOMS.workspace(ctx.workspace.id),
      envelope: { event: name, emittedAt: new Date().toISOString(), payload: { workspaceId: ctx.workspace.id, connectionId: id } },
    });

    expect(router.handle(event(REALTIME_EVENTS.CHANNEL_MESSAGE_RECEIVED, connectionId))).toBe(1);
    expect(router.handle(event(REALTIME_EVENTS.CHANNEL_MESSAGE_STATUS, connectionId))).toBe(1);
    expect(router.handle(event(REALTIME_EVENTS.CHANNEL_MESSAGE_RECEIVED, 'another-connection'))).toBe(0);
    expect(post.mock.calls.map((call) => call[1])).toEqual(['channel.inbound', 'channel.action.settled']);
  });
});
