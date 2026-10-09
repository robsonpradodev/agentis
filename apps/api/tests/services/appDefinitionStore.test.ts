import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDefinitionStore } from '@agentis/app';
import { schema } from '@agentis/db/sqlite';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
  ctx.db
    .insert(schema.apps)
    .values({
      id: 'contract-app',
      workspaceId: ctx.workspace.id,
      slug: 'contract-app',
      name: 'Contract App',
      createdBy: ctx.user.id,
    })
    .run();
});
afterEach(() => ctx.close());

describe('AppDefinitionStore', () => {
  it('persists a coherent v3 definition and advances its revision', () => {
    const definitions = new AppDefinitionStore(ctx.db);
    const first = definitions.upsert(ctx.workspace.id, 'contract-app', {
      contract: {
        operations: [
          {
            id: 'customer.lookup',
            title: 'Find customer',
            description: '',
            mode: 'query',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object' },
            scopes: ['customer:read'],
            effects: [],
            handler: { kind: 'component', component: 'crm', export: 'lookup' },
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
            exports: ['lookup'],
            network: 'none',
          },
        ],
      },
      permissionsV3: {
        scopes: ['customer:read'],
        egress: [],
        maxEffectLevel: 'read',
        maxSpendCentsPerTask: null,
        guardrails: [],
      },
      quality: {
        suites: [
          {
            id: 'lookup-regression',
            title: 'Lookup regression',
            kind: 'regression',
            rubric: [],
            minimumScore: 1,
          },
        ],
        budgets: {},
        slos: {},
        releaseGates: [{ suiteId: 'lookup-regression', required: true }],
      },
      projections: {
        rest: true,
        mcp: { enabled: true, tasks: true },
        a2a: { enabled: true, exposeOperations: ['customer.lookup'] },
      },
    });
    expect(first.revision).toBe(1);
    expect(first.contract?.operations[0]?.handler).toMatchObject({
      kind: 'component',
      component: 'crm',
    });
    expect(
      definitions.upsert(ctx.workspace.id, 'contract-app', {
        frontend: {
          framework: 'react',
          entry: 'src/main.tsx',
          outputDir: 'dist',
          styling: 'tailwind',
        },
      }).revision,
    ).toBe(2);
  });

  it('rejects broken cross-facet references instead of storing a partial contract', () => {
    const definitions = new AppDefinitionStore(ctx.db);
    expect(() =>
      definitions.upsert(ctx.workspace.id, 'contract-app', {
        contract: {
          operations: [
            {
              id: 'send',
              title: 'Send',
              description: '',
              mode: 'command',
              inputSchema: {},
              outputSchema: {},
              scopes: ['message:send'],
              effects: [
                {
                  kind: 'message',
                  level: 'compensatable',
                  approval: 'policy',
                  compensationOperationId: 'recall',
                },
              ],
              handler: { kind: 'component', component: 'missing', export: 'send' },
            },
          ],
          resources: [],
          events: [],
        },
        permissionsV3: {
          scopes: [],
          egress: [],
          maxEffectLevel: 'compensatable',
          maxSpendCentsPerTask: null,
          guardrails: [],
        },
      }),
    ).toThrow(/undeclared component.*missing.*missing compensation.*undeclared scope/s);
    expect(definitions.get(ctx.workspace.id, 'contract-app')).toBeNull();
  });
});
