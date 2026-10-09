/**
 * AppPackager — the IR projection + `.agentisapp` envelope (AGENTIC-SYSTEMS §2/§17).
 *
 * DoD gate 1: `toManifest`/`fromManifest` round-trip is identity modulo
 * server-assigned ids/slug; `serialize`/`deserialize` preserve the manifest and
 * reject tampering; collections come back EMPTY (empty-with-schema).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { canonicalizeManifest } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import {
  AppDatastore,
  AppDefinitionStore,
  AppPackager,
  AppStore,
  AppSurfaceStore,
} from '@agentis/app';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let packager: AppPackager;
let appId: string;

beforeEach(async () => {
  ctx = await createTestContext();
  packager = new AppPackager(ctx.db);
  const store = new AppStore(ctx.db);
  appId = store.create(ctx.workspace.id, ctx.user.id, { name: 'Helpdesk Pro' }).id;
  store.update(ctx.workspace.id, appId, { version: '1.2.0', policy: { customCode: 'allowed' } });

  const data = new AppDatastore(ctx.db);
  data.defineCollection(ctx.workspace.id, appId, {
    name: 'tickets',
    schema: { fields: [{ key: 'subject', type: 'string', required: true }] },
  });
  data.insert(ctx.workspace.id, appId, 'tickets', { subject: 'private customer data' }); // must NOT travel

  new AppSurfaceStore({ db: ctx.db }).render(ctx.workspace.id, appId, 'home', {
    type: 'Stack',
    children: [{ type: 'Heading', value: 'Tickets' }],
  });

  ctx.db
    .insert(schema.workflows)
    .values({
      id: randomUUID(),
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      appId,
      title: 'Notify',
      graph: { version: 1, nodes: [], edges: [] },
    })
    .run();
});

afterEach(() => ctx.close());

/** Strip server-assigned identity (ids/slug) so two projections are comparable. */
function comparable(m: ReturnType<AppPackager['toManifest']>) {
  return {
    name: m.identity.name,
    version: m.identity.version,
    policy: m.policy,
    workflows: m.workflows.map((w) => ({ title: w.title, graph: w.graph })),
    surfaces: m.surfaces.map((s) => ({
      name: s.name,
      kind: s.kind,
      view: s.view,
      actions: s.actions,
    })),
    collections: m.collections.map((c) => ({ name: c.name, schema: c.schema })),
  };
}

describe('AppPackager — IR projection', () => {
  it('round-trips every Agentic App v3 definition facet', () => {
    new AppDefinitionStore(ctx.db).upsert(ctx.workspace.id, appId, {
      contract: {
        operations: [],
        resources: [],
        events: [],
      },
      frontend: {
        framework: 'react',
        entry: 'src/main.tsx',
        outputDir: 'dist',
        styling: 'tailwind',
      },
      permissionsV3: {
        scopes: [],
        egress: [],
        maxEffectLevel: 'read',
        maxSpendCentsPerTask: null,
        guardrails: [],
      },
      projections: {
        rest: true,
        mcp: { enabled: true, tasks: true },
        a2a: { enabled: true, exposeOperations: [] },
      },
    });

    const envelope = packager.export(ctx.workspace.id, appId);
    expect(envelope.formatVersion).toBe(3);
    expect(envelope.manifest).toMatchObject({
      manifestVersion: 3,
      frontend: { framework: 'react', styling: 'tailwind' },
      projections: { rest: true, mcp: { tasks: true } },
    });

    const imported = packager.import(ctx.workspace.id, ctx.user.id, envelope);
    const definition = new AppDefinitionStore(ctx.db).require(ctx.workspace.id, imported.appId);
    expect(definition.frontend).toEqual(envelope.manifest.frontend);
    expect(definition.permissionsV3).toEqual(envelope.manifest.permissionsV3);
    expect(definition.projections).toEqual(envelope.manifest.projections);
  });

  it('round-trips rows → manifest → rows → manifest as identity (modulo ids/slug)', () => {
    const m1 = packager.toManifest(ctx.workspace.id, appId);
    const { appId: newId } = packager.fromManifest(ctx.workspace.id, ctx.user.id, m1);
    expect(newId).not.toBe(appId);
    const m2 = packager.toManifest(ctx.workspace.id, newId);
    expect(comparable(m2)).toEqual(comparable(m1));

    // version + policy carried; collection recreated EMPTY (private row did not travel).
    expect(m2.identity.version).toBe('1.2.0');
    expect(m2.policy.customCode).toBe('allowed');
    const data = new AppDatastore(ctx.db);
    expect(data.query(ctx.workspace.id, newId, 'tickets', { limit: 50 }).rows).toHaveLength(0);
  });

  it('serialize/deserialize preserves the manifest and rejects tampering', () => {
    const m = packager.toManifest(ctx.workspace.id, appId);
    const envelope = packager.serialize(m);
    expect(envelope.format).toBe('.agentisapp');
    expect(packager.deserialize(envelope)).toEqual(m);

    envelope.manifest.identity.name = 'Evil Hijack'; // mutate after checksum
    expect(() => packager.deserialize(envelope)).toThrowError(/checksum mismatch/);
  });

  // Forward-compat: an authentic older export carries manifest fields that a
  // LATER schema no longer knows (real case: policy.audience/shareable were
  // dropped). The checksum was computed over those raw bytes at export time, so
  // verification must hash the RAW manifest — not a schema-parsed projection —
  // or every such file "mismatches" and can never be reimported.
  it('imports an authentic export carrying fields the current schema dropped', () => {
    const m = packager.toManifest(ctx.workspace.id, appId);
    // Simulate a manifest exported by an older/newer build: extra fields the
    // current appManifestSchema will strip on parse.
    const rawManifest = {
      ...m,
      policy: { ...m.policy, audience: [], shareable: false },
      unknownFutureField: 'from-another-version',
    };
    const envelope = {
      format: '.agentisapp' as const,
      formatVersion: 1 as const,
      manifest: rawManifest as never,
      checksum: createHash('sha256')
        .update(canonicalizeManifest(rawManifest as never))
        .digest('hex'),
      exportedAt: '2026-01-01T00:00:00.000Z',
    };
    // Verifies over raw bytes → passes; returns the strict (stripped) manifest.
    const parsed = packager.deserialize(envelope);
    expect(parsed.identity.name).toBe(m.identity.name);
    expect('unknownFutureField' in parsed).toBe(false);
    // And it installs end to end.
    const { appId: newId } = packager.import(ctx.workspace.id, ctx.user.id, envelope);
    expect(new AppStore(ctx.db).get(ctx.workspace.id, newId).id).toBe(newId);
  });

  it('export → import recreates the app end to end', () => {
    const envelope = packager.export(ctx.workspace.id, appId);
    expect(envelope.manifest.surfaces).toHaveLength(1);
    expect(envelope.manifest.collections).toHaveLength(1);
    expect(envelope.manifest.workflows).toHaveLength(1);

    const { appId: newId } = packager.import(ctx.workspace.id, ctx.user.id, envelope);
    expect(
      new AppSurfaceStore({ db: ctx.db }).list(ctx.workspace.id, newId).map((s) => s.name),
    ).toEqual(['home']);
    expect(new AppStore(ctx.db).get(ctx.workspace.id, newId).entrySurfaceId).toBe('home');
    expect(
      ctx.db
        .select({ id: schema.workflows.id })
        .from(schema.workflows)
        .where(eq(schema.workflows.appId, newId))
        .all(),
    ).toHaveLength(1);
  });

  it('preserves Hub provenance and checksum through install and export', () => {
    const manifest = packager.toManifest(ctx.workspace.id, appId);
    manifest.source = {
      kind: 'hub',
      id: 'agentishub:helpdesk-pro',
      remoteId: 'listing_123',
      author: { handle: 'agentis-labs' },
    };
    const envelope = packager.serialize(manifest);

    const { appId: installedId } = packager.import(ctx.workspace.id, ctx.user.id, envelope);
    const installed = new AppStore(ctx.db).get(ctx.workspace.id, installedId);
    expect(installed.source).toEqual(manifest.source);
    expect(installed.installedChecksum).toBe(envelope.checksum);

    const reexported = packager.export(ctx.workspace.id, installedId);
    expect(reexported.manifest.source).toEqual(manifest.source);
    expect(reexported.checksum).not.toBe('');
  });

  it('exports the immutable active graph by default and candidate only when explicit', () => {
    const workflow = ctx.db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.appId, appId))
      .get()!;
    const activeId = randomUUID();
    const candidateId = randomUUID();
    const activeGraph = {
      version: 1 as const,
      nodes: [],
      edges: [],
      viewport: { x: 1, y: 0, zoom: 1 },
    };
    const candidateGraph = {
      version: 1 as const,
      nodes: [],
      edges: [],
      viewport: { x: 2, y: 0, zoom: 1 },
    };
    for (const [id, graph, status] of [
      [activeId, activeGraph, 'active'],
      [candidateId, candidateGraph, 'candidate'],
    ] as const) {
      ctx.db
        .insert(schema.workflowGraphRevisions)
        .values({
          id,
          workspaceId: ctx.workspace.id,
          workflowId: workflow.id,
          graphJson: graph,
          semanticHash: `${id}-semantic`,
          presentationHash: `${id}-presentation`,
          source: 'test',
          reason: 'test',
          status,
          trustState: status === 'active' ? 'proven' : 'unverified',
        })
        .run();
    }
    ctx.db
      .update(schema.workflows)
      .set({ activeRevisionId: activeId, candidateRevisionId: candidateId, graph: candidateGraph })
      .where(eq(schema.workflows.id, workflow.id))
      .run();
    expect(packager.export(ctx.workspace.id, appId).manifest.workflows[0]!.graph).toEqual(
      activeGraph,
    );
    expect(
      packager.export(ctx.workspace.id, appId, { revisionTarget: 'candidate' }).manifest
        .workflows[0]!.graph,
    ).toEqual(candidateGraph);
  });
});
