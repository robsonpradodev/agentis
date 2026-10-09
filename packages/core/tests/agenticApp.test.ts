import { describe, expect, it } from 'vitest';
import {
  appManifestSchema,
  assertDelegationDoesNotAmplify,
  authorityContextSchema,
} from '../src/index.js';

describe('Agentic Apps v3 contracts', () => {
  it('parses a full semantic operation contract while preserving v1 manifests', () => {
    const v3 = appManifestSchema.parse({
      manifestVersion: 3,
      identity: { slug: 'crm', name: 'CRM', version: '1.0.0' },
      policy: {},
      contract: {
        operations: [
          {
            id: 'contacts.create',
            title: 'Create contact',
            mode: 'command',
            inputSchema: {
              type: 'object',
              required: ['name'],
              properties: { name: { type: 'string' } },
            },
            outputSchema: { type: 'object' },
            scopes: ['contacts:write'],
            effects: [{ kind: 'data_mutation', level: 'reversible', approval: 'policy' }],
            handler: { kind: 'workflow', workflow: 'Create contact' },
          },
        ],
      },
      permissionsV3: { scopes: ['contacts:write'], maxEffectLevel: 'reversible' },
      quality: {
        suites: [{ id: 'contact-contract', title: 'Contact contract', kind: 'correctness' }],
      },
    });
    expect(v3.contract?.operations[0]?.id).toBe('contacts.create');
    expect(v3.quality?.suites[0]?.minimumScore).toBe(1);

    expect(
      appManifestSchema.parse({
        identity: { slug: 'legacy', name: 'Legacy', version: '0.1.0' },
        policy: {},
      }).manifestVersion,
    ).toBe(1);
  });

  it('rejects delegation which amplifies effects, spend, scope, or lifetime', () => {
    const parent = authorityContextSchema.parse({
      workspaceId: 'w',
      ownerPrincipalId: 'owner',
      initiatorPrincipalId: 'owner',
      actorPrincipalId: 'planner',
      delegationChain: [],
      scopes: ['crm:read', 'crm:write'],
      maxEffectLevel: 'compensatable',
      maxSpendCents: 500,
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    const child = authorityContextSchema.parse({
      ...parent,
      actorPrincipalId: 'worker',
      scopes: ['crm:read'],
      maxEffectLevel: 'reversible',
      maxSpendCents: 100,
      expiresAt: '2029-01-01T00:00:00.000Z',
    });
    expect(() => assertDelegationDoesNotAmplify(parent, child)).not.toThrow();
    expect(() => assertDelegationDoesNotAmplify(parent, { ...child, scopes: ['admin'] })).toThrow(
      /add scopes/,
    );
    expect(() =>
      assertDelegationDoesNotAmplify(parent, { ...child, maxEffectLevel: 'irreversible' }),
    ).toThrow(/effect authority/);
    expect(() => assertDelegationDoesNotAmplify(parent, { ...child, maxSpendCents: 600 })).toThrow(
      /spend ceiling/,
    );
  });
});
