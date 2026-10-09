import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, ChatDelta, ToolDefinition } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { AgentExecutionController } from '../../src/services/agentExecutionController.js';
import { AgentMissionService } from '../../src/services/agentMissions.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

describe('AgentExecutionController', () => {
  it('uses the model to compile two ordered effects into distinct durable commitments', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId, workspaceId: ctx.workspace.id, userId: ctx.user.id,
      name: 'Ava', adapterType: 'http',
    }).run();
    const adapter = {
      capabilities: () => ({ interactiveChat: true }),
      async *chat(): AsyncIterable<ChatDelta> {
        yield { type: 'text', delta: JSON.stringify({
          decision: 'act',
          objective: 'Send an existing sticker, then an existing PDF.',
          steps: [
            { id: 'find-assets', kind: 'observe', title: 'Find matching Assets', toolName: 'agentis.assets.search' },
            { id: 'send-sticker', kind: 'effect', title: 'Send the sticker', dependsOn: ['find-assets'], toolName: 'agentis.channel.send', effectKind: 'channel_delivery', evidence: 'provider_acknowledgement' },
            { id: 'send-pdf', kind: 'effect', title: 'Send the PDF', dependsOn: ['send-sticker'], toolName: 'agentis.channel.send', effectKind: 'channel_delivery', evidence: 'provider_acknowledgement' },
          ],
        }) };
        yield { type: 'done', finishReason: 'stop' };
      },
    } as unknown as AgentAdapter;
    const tools: ToolDefinition[] = [
      { name: 'agentis.assets.search', description: 'Find Assets.', parameters: { type: 'object', properties: {} } },
      { name: 'agentis.channel.send', description: 'Send a channel burst.', parameters: { type: 'object', properties: {} } },
    ];
    const missions = new AgentMissionService(ctx.db, ctx.bus);
    const controller = new AgentExecutionController({ missions, logger: ctx.logger });
    const prepared = await controller.prepare({
      adapter,
      request: 'me envie uma figurinha e depois um PDF que tenha',
      context: {
        workspaceId: ctx.workspace.id, agentId, userId: ctx.user.id,
        conversationId: 'owner-chat', durableTurnId: 'turn-1',
      },
      tools,
    });

    expect(prepared?.decision.decision).toBe('act');
    expect(prepared?.mission?.outcomeContract.requiredEffects).toEqual([
      expect.objectContaining({ id: 'requirement:send-sticker', kind: 'channel_delivery', planStepId: 'send-sticker' }),
      expect.objectContaining({ id: 'requirement:send-pdf', kind: 'channel_delivery', planStepId: 'send-pdf', dependsOn: ['send-sticker'] }),
    ]);
    expect(prepared?.mission?.executionPlan?.steps[2]).toMatchObject({
      id: 'send-pdf', dependsOn: ['send-sticker'], effectRequirementIds: ['requirement:send-pdf'],
    });
    expect(prepared?.runtimeDirective).toContain('messages[]');
    expect(prepared?.runtimeDirective).toContain('requirement:send-sticker');
    expect(prepared?.runtimeDirective).toContain('requirement:send-pdf');
  });
});
