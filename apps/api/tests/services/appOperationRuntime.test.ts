import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDefinitionStore } from '@agentis/app';
import { schema } from '@agentis/db/sqlite';
import type { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { AgentMissionService } from '../../src/services/agentMissions.js';
import { AppOperationRuntime } from '../../src/services/appOperationRuntime.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => ctx.close());

function setup(output: Record<string, unknown>) {
  const agentId = randomUUID();
  ctx.db
    .insert(schema.agents)
    .values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      name: 'CRM specialist',
      adapterType: 'http',
      config: {},
    })
    .run();
  ctx.db
    .insert(schema.apps)
    .values({
      id: 'crm-app',
      workspaceId: ctx.workspace.id,
      slug: 'crm-app',
      name: 'CRM App',
      ownerAgentId: agentId,
      createdBy: ctx.user.id,
    })
    .run();
  new AppDefinitionStore(ctx.db).upsert(ctx.workspace.id, 'crm-app', {
    contract: {
      operations: [
        {
          id: 'contact.update',
          title: 'Update contact',
          description: 'Updates a CRM contact through a sandboxed component.',
          mode: 'command',
          inputSchema: {
            type: 'object',
            required: ['contactId'],
            properties: { contactId: { type: 'string' } },
          },
          outputSchema: {
            type: 'object',
            required: ['updated'],
            properties: { updated: { type: 'boolean' } },
          },
          scopes: ['contact:write'],
          effects: [
            {
              kind: 'contact.update',
              level: 'reversible',
              targetResourceType: 'contact',
              approval: 'never',
            },
          ],
          idempotency: { required: true },
          handler: { kind: 'component', component: 'crm', export: 'updateContact' },
        },
      ],
      resources: [],
      events: [],
    },
    components: {
      components: [
        {
          id: 'crm',
          runtime: 'node',
          entry: 'crm-extension',
          exports: ['updateContact'],
          network: 'none',
        },
      ],
    },
    permissionsV3: {
      scopes: ['contact:write'],
      egress: [],
      maxEffectLevel: 'reversible',
      maxSpendCentsPerTask: null,
      guardrails: [],
    },
  });
  const execute = vi.fn().mockResolvedValue({
    ok: true,
    output,
    durationMs: 4,
    operationName: 'updateContact',
  });
  const missions = new AgentMissionService(ctx.db, ctx.bus);
  const runtime = new AppOperationRuntime({
    db: ctx.db,
    engine: {} as WorkflowEngine,
    missions,
    extensions: { execute } as unknown as ExtensionRuntime,
  });
  const authorityContext = {
    workspaceId: ctx.workspace.id,
    ownerPrincipalId: ctx.user.id,
    initiatorPrincipalId: ctx.user.id,
    actorPrincipalId: agentId,
    delegationChain: [],
    scopes: ['contact:write'],
    maxEffectLevel: 'reversible' as const,
    maxSpendCents: null,
  };
  return { execute, missions, runtime, authorityContext };
}

describe('AppOperationRuntime', () => {
  it('executes a declared component through the effect ledger and replays idempotently', async () => {
    const { execute, runtime, authorityContext } = setup({ updated: true });
    const invocation = {
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      appId: 'crm-app',
      operationId: 'contact.update',
      input: { contactId: 'contact-1' },
      authorityContext,
      idempotencyKey: 'contact.update:contact-1:v1',
    };

    const result = (await runtime.invoke(invocation)) as Record<string, unknown>;
    expect(result).toMatchObject({
      kind: 'result',
      data: { updated: true },
      content: {
        data: { updated: true },
        provenance: { origin: 'generated' },
        trust: 'unknown',
        instructionAuthority: 'none',
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(ctx.db.select().from(schema.effectPlans).get()).toMatchObject({ status: 'completed' });
    expect(ctx.db.select().from(schema.agentMissions).get()).toMatchObject({
      status: 'accomplished',
    });

    const replay = (await runtime.invoke(invocation)) as Record<string, unknown>;
    expect(replay).toMatchObject({ kind: 'result' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(ctx.db.select().from(schema.effectPlans).all()).toHaveLength(1);
    expect(ctx.db.select().from(schema.agentMissions).all()).toHaveLength(1);
  });

  it('rejects invalid component output and durably fails the task and effect', async () => {
    const { runtime, authorityContext } = setup({ updated: 'yes' });

    await expect(
      runtime.invoke({
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        userId: ctx.user.id,
        appId: 'crm-app',
        operationId: 'contact.update',
        input: { contactId: 'contact-1' },
        authorityContext,
        idempotencyKey: 'contact.update:invalid-output',
      }),
    ).rejects.toThrow(/output violates the operation contract/i);
    expect(ctx.db.select().from(schema.effectPlans).get()).toMatchObject({ status: 'failed' });
    expect(ctx.db.select().from(schema.agentMissions).get()).toMatchObject({ status: 'failed' });
  });
});
