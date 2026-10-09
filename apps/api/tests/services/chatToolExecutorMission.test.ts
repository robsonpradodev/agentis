import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { AgentMissionService } from '../../src/services/agentMissions.js';
import { ChatToolExecutor } from '../../src/services/chat/chatToolExecutor.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => { ChatToolExecutor.configure(null); ctx.close(); });

describe('ChatToolExecutor Mission evidence', () => {
  it('records an exact receipt for any successful model-planned local effect', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      name: 'Brain administrator',
      adapterType: 'http',
      config: {},
    }).run();
    const missions = new AgentMissionService(ctx.db, ctx.bus);
    const mission = missions.create({
      workspaceId: ctx.workspace.id,
      ownerAgentId: agentId,
      sourceKind: 'conversation',
      sourceRef: 'owner-chat',
      objective: 'Archive conflicting private Brain content.',
      outcomeContract: { requiredEffects: [{
        id: 'requirement:prune-brain',
        kind: 'data_mutation',
        planStepId: 'prune-brain',
        targetRef: agentId,
        evidence: 'mutation_receipt',
      }] },
      executionPlan: { version: 1, steps: [{
        id: 'prune-brain',
        kind: 'effect',
        title: 'Archive conflicting Brain content',
        toolName: 'agentis.agent.brain.prune',
        effectRequirementIds: ['requirement:prune-brain'],
      }] },
    });
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registry.register({
      id: 'agentis.agent.brain.prune',
      family: 'build',
      description: 'Apply a reviewed Brain prune.',
      inputSchema: { type: 'object', properties: { agentId: { type: 'string' } }, required: ['agentId'] },
      mutating: true,
      autoExecute: true,
    }, async () => ({ applied: true, agentId, archived: { memories: ['legacy-memory'] } }));
    ChatToolExecutor.configure({ registry, missions });

    const result = await ChatToolExecutor.run('agentis.agent.brain.prune', { agentId }, {
      workspaceId: ctx.workspace.id,
      agentId,
      userId: ctx.user.id,
      conversationId: 'owner-chat',
      missionId: mission.id,
      permissionMode: 'auto',
    }, 'model-call-prune');

    expect(result.error).toBeUndefined();
    const settled = missions.inspect(ctx.workspace.id, mission.id);
    expect(settled.status).toBe('accomplished');
    expect(settled.receipts).toHaveLength(1);
    expect(settled.receipts?.[0]).toMatchObject({
      requirementId: 'requirement:prune-brain',
      planStepId: 'prune-brain',
      kind: 'data_mutation',
      resourceType: 'agent_brain',
      resourceId: agentId,
      toolCallId: 'model-call-prune',
      acknowledged: true,
    });
  });

  it('does not invent a provider receipt for a planned channel tool', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId, workspaceId: ctx.workspace.id, userId: ctx.user.id,
      name: 'Sender', adapterType: 'http', config: {},
    }).run();
    const missions = new AgentMissionService(ctx.db, ctx.bus);
    const mission = missions.create({
      workspaceId: ctx.workspace.id, ownerAgentId: agentId, sourceKind: 'conversation',
      objective: 'Send a message.',
      outcomeContract: { requiredEffects: [{ id: 'requirement:send', kind: 'channel_delivery', planStepId: 'send' }] },
      executionPlan: { version: 1, steps: [{
        id: 'send', kind: 'effect', title: 'Send', toolName: 'agentis.channel.send',
        effectRequirementIds: ['requirement:send'],
      }] },
    });
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registry.register({
      id: 'agentis.channel.send', family: 'run', description: 'Submit to a provider.',
      inputSchema: { type: 'object', properties: {} }, mutating: true, autoExecute: true,
    }, async () => ({ status: 'provider_submitted', providerAcknowledged: false }));
    ChatToolExecutor.configure({ registry, missions });

    await ChatToolExecutor.run('agentis.channel.send', {}, {
      workspaceId: ctx.workspace.id, agentId, userId: ctx.user.id,
      conversationId: 'owner-chat', missionId: mission.id, permissionMode: 'auto',
    }, 'model-call-send');

    const pending = missions.inspect(ctx.workspace.id, mission.id);
    expect(pending.status).not.toBe('accomplished');
    expect(pending.receipts).toHaveLength(0);
  });

  it('reconciles multiple planned effects executed through a composed tool result', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId, workspaceId: ctx.workspace.id, userId: ctx.user.id,
      name: 'Composer', adapterType: 'http', config: {},
    }).run();
    const missions = new AgentMissionService(ctx.db, ctx.bus);
    const mission = missions.create({
      workspaceId: ctx.workspace.id,
      ownerAgentId: agentId,
      sourceKind: 'conversation',
      objective: 'Apply two coordinated changes.',
      outcomeContract: { requiredEffects: [
        { id: 'requirement:first', kind: 'data_mutation', planStepId: 'first', targetRef: 'first-resource' },
        { id: 'requirement:second', kind: 'data_mutation', planStepId: 'second', targetRef: 'second-resource' },
      ] },
      executionPlan: { version: 1, steps: [
        { id: 'first', kind: 'effect', title: 'First', toolName: 'agentis.first.apply', effectRequirementIds: ['requirement:first'] },
        { id: 'second', kind: 'effect', title: 'Second', toolName: 'agentis.second.apply', dependsOn: ['first'], effectRequirementIds: ['requirement:second'] },
      ] },
    });
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    for (const id of ['agentis.first.apply', 'agentis.second.apply']) registry.register({
      id, family: 'build', description: id, inputSchema: { type: 'object' }, mutating: true,
    }, async () => ({ applied: true }));
    registry.register({
      id: 'agentis.code.execute', family: 'build', description: 'Compose calls.',
      inputSchema: { type: 'object' }, mutating: true,
    }, async () => ({
      ok: true,
      calls: [
        { tool: 'agentis.first.apply', ok: true },
        { tool: 'agentis.second.apply', ok: true },
      ],
    }));
    ChatToolExecutor.configure({ registry, missions });

    const result = await ChatToolExecutor.run('agentis.code.execute', { code: 'compose' }, {
      workspaceId: ctx.workspace.id,
      agentId,
      userId: ctx.user.id,
      conversationId: 'owner-chat',
      missionId: mission.id,
      permissionMode: 'auto',
    }, 'model-call-compose');

    expect(result.error).toBeUndefined();
    const settled = missions.inspect(ctx.workspace.id, mission.id);
    expect(settled.status).toBe('accomplished');
    expect(settled.receipts?.map((receipt) => receipt.requirementId).sort())
      .toEqual(['requirement:first', 'requirement:second']);
  });
});
