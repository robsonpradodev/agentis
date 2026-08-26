import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { KnowledgeBaseService } from '../../src/services/knowledge/knowledgeBase.js';
import { KnowledgeAutoLinker } from '../../src/services/knowledge/knowledgeAutoLinker.js';
import { EnrichedKnowledgeGraphWriter, type BrainEnrichmentProvider } from '../../src/services/brain/brainEnrichment.js';
import type { EmbeddingProvider } from '../../src/services/embedding/embeddingProvider.js';
import ExcelJS from 'exceljs';
import { SharedIntelligenceService } from '../../src/services/sharedIntelligence.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { buildKnowledgeBaseRoutes } from '../../src/routes/knowledgeBases.js';
import { AppStore } from '@agentis/app';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let knowledge: KnowledgeBaseService;

beforeEach(async () => {
  ctx = await createTestContext();
  knowledge = new KnowledgeBaseService(ctx.db);
});

afterEach(() => ctx.close());

function app() {
  return ctx.buildApp([{
    path: '/v1/knowledge-bases',
    app: buildKnowledgeBaseRoutes({ db: ctx.db, auth: ctx.auth, knowledge }),
  }]);
}

function wireAutoLinker(repairExisting = false) {
  const episodes = new EpisodicMemoryStore(ctx.db, ctx.logger);
  const intelligence = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
  const linker = new KnowledgeAutoLinker(intelligence, ctx.logger);
  return { intelligence, linker, repaired: knowledge.setAutoLinker(linker, repairExisting) };
}

const enrichment: BrainEnrichmentProvider = {
  async enrichChunk({ documentName, content }) {
    return {
      summary: `Summary of ${documentName}`,
      contextPrefix: `Grounded context for ${documentName}.`,
      keyFacts: [content.slice(0, 80)],
      entities: ['Release Safety'],
      importanceScore: 0.88,
      model: 'test-model',
    };
  },
  async expandGroundedQuery() {
    return ['backup restoration procedure'];
  },
  async classifyRelation() {
    return 'supports';
  },
  async describeImage() {
    return '[Visual description: diagram.png]\nA deployment diagram with rollback arrows.';
  },
  async transcribeAudio() {
    return '[Audio transcript: meeting.wav]\nApprove the release after backup validation.';
  },
};

const semanticProvider: EmbeddingProvider = {
  dimension: 2,
  embed: () => [1, 0],
};

describe('/v1/knowledge-bases document uploads', () => {
  it('permanently deletes a document, its chunks, and graph links', async () => {
    wireAutoLinker();
    const kb = knowledge.createKnowledgeBase({ workspaceId: ctx.workspace.id, name: 'disposable docs' });
    const document = await knowledge.addDocument({
      workspaceId: ctx.workspace.id,
      knowledgeBaseId: kb.id,
      name: 'obsolete.md',
      content: Array.from({ length: 520 }, (_, index) => `obsolete-policy-${index % 15}`).join(' '),
    });
    await knowledge.flushPendingIndexing();
    const chunkIds = ctx.db.select({ id: schema.kbChunks.id }).from(schema.kbChunks)
      .where(eq(schema.kbChunks.documentId, document.id)).all().map((chunk) => chunk.id);
    expect(chunkIds.length).toBeGreaterThan(1);
    expect(ctx.db.select().from(schema.knowledgeLinks).all()
      .some((link) => chunkIds.includes(link.sourceId) || chunkIds.includes(link.targetId))).toBe(true);

    expect(knowledge.deleteDocument(ctx.workspace.id, kb.id, document.id)).toEqual({ id: document.id, deleted: true });
    expect(ctx.db.select().from(schema.kbDocuments).where(eq(schema.kbDocuments.id, document.id)).get()).toBeUndefined();
    expect(ctx.db.select().from(schema.kbChunks).where(eq(schema.kbChunks.documentId, document.id)).all()).toHaveLength(0);
    expect(ctx.db.select().from(schema.knowledgeLinks).all()
      .filter((link) => chunkIds.includes(link.sourceId) || chunkIds.includes(link.targetId))).toHaveLength(0);
  });

  it('presents workflow-scoped knowledge with owner provenance and document counts', async () => {
    const workflowId = randomUUID();
    ctx.db.insert(schema.workflows)
      .values({
        id: workflowId,
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        userId: ctx.user.id,
        title: 'Catalog Launch Workflow',
        graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        settings: {},
      })
      .run();
    const workspaceBase = knowledge.createKnowledgeBase({ workspaceId: ctx.workspace.id, name: 'Workspace runbooks' });
    const workflowBase = knowledge.createKnowledgeBase({ workspaceId: ctx.workspace.id, scopeId: workflowId, name: 'Workflow knowledge' });
    await knowledge.addDocument({
      workspaceId: ctx.workspace.id,
      knowledgeBaseId: workflowBase.id,
      name: 'factory.md',
      content: 'A scoped workflow knowledge document.',
    });

    const workspaceRes = await app().request('/v1/knowledge-bases', { headers: ctx.authHeaders });
    expect(workspaceRes.status).toBe(200);
    const workspaceJson = await workspaceRes.json() as {
      knowledgeBases: Array<{
        id: string;
        scopeKind: string;
        ownerScope?: { id: string; kind: string; title: string } | null;
        ownerWorkflow?: { id: string; title: string } | null;
        documentCount: number;
      }>;
    };
    const scoped = workspaceJson.knowledgeBases.find((base) => base.id === workflowBase.id);
    const shared = workspaceJson.knowledgeBases.find((base) => base.id === workspaceBase.id);
    expect(scoped).toMatchObject({
      scopeKind: 'workflow',
      ownerScope: { id: workflowId, kind: 'workflow', title: 'Catalog Launch Workflow' },
      ownerWorkflow: { id: workflowId, title: 'Catalog Launch Workflow' },
      documentCount: 1,
    });
    expect(shared).toMatchObject({ scopeKind: 'workspace', ownerScope: null, ownerWorkflow: null, documentCount: 0 });

    const scopedRes = await app().request(`/v1/knowledge-bases?scopeId=${workflowId}`, { headers: ctx.authHeaders });
    const scopedJson = await scopedRes.json() as { knowledgeBases: Array<{ id: string }> };
    expect(scopedJson.knowledgeBases.map((base) => base.id)).toEqual([workflowBase.id]);
  });

  it('resolves App-scoped knowledge (App Brain → Knowledge) instead of 404 "Workflow not found"', async () => {
    // The App Brain → Knowledge facet binds the scope to app.id, NOT a workflow
    // id. The scope validation used to check only the workflows table and threw
    // "Workflow not found"; an App is now a valid Knowledge scope.
    const appRecord = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Agentis Catalog Launch Workflow' });

    const listRes = await app().request(`/v1/knowledge-bases?scopeId=${appRecord.id}`, { headers: ctx.authHeaders });
    expect(listRes.status).toBe(200);

    const createRes = await app().request(`/v1/knowledge-bases?scopeId=${appRecord.id}`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ name: 'App knowledge' }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as {
      knowledgeBase: {
        id: string;
        scopeId: string;
        scopeKind: string;
        ownerScope?: { id: string; kind: string; title: string } | null;
        ownerWorkflow?: { id: string; title: string } | null;
      };
    };
    expect(created.knowledgeBase.scopeId).toBe(appRecord.id);
    expect(created.knowledgeBase.scopeKind).toBe('app');
    expect(created.knowledgeBase.ownerScope).toMatchObject({ id: appRecord.id, kind: 'app', title: 'Agentis Catalog Launch Workflow' });
    expect(created.knowledgeBase.ownerWorkflow).toMatchObject({ id: appRecord.id, title: 'Agentis Catalog Launch Workflow' });

    const scopedList = await app().request(`/v1/knowledge-bases?scopeId=${appRecord.id}`, { headers: ctx.authHeaders });
    const scopedJson = await scopedList.json() as { knowledgeBases: Array<{ id: string }> };
    expect(scopedJson.knowledgeBases.map((base) => base.id)).toContain(created.knowledgeBase.id);

    // A bogus scope still 404s — the validation didn't simply go permissive.
    const bogusRes = await app().request(`/v1/knowledge-bases?scopeId=${randomUUID()}`, { headers: ctx.authHeaders });
    expect(bogusRes.status).toBe(404);
  });

  it('resolves Agent-scoped knowledge as agent-owned Brain content', async () => {
    const { intelligence } = wireAutoLinker();
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Research Brain',
      adapterType: 'http',
      role: 'worker',
    }).run();

    const createRes = await app().request(`/v1/knowledge-bases?scopeId=${agentId}`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ name: 'Research playbook' }),
    });

    expect(createRes.status).toBe(201);
    const created = await createRes.json() as {
      knowledgeBase: {
        id: string;
        scopeId: string;
        scopeKind: string;
        ownerScope?: { id: string; kind: string; title: string } | null;
      };
    };
    expect(created.knowledgeBase).toMatchObject({
      scopeId: agentId,
      scopeKind: 'agent',
      ownerScope: { id: agentId, kind: 'agent', title: 'Research Brain' },
    });

    const scopedList = await app().request(`/v1/knowledge-bases?scopeId=${agentId}`, { headers: ctx.authHeaders });
    const scopedJson = await scopedList.json() as { knowledgeBases: Array<{ id: string; scopeKind: string }> };
    expect(scopedJson.knowledgeBases.map((base) => ({ id: base.id, scopeKind: base.scopeKind })))
      .toEqual([{ id: created.knowledgeBase.id, scopeKind: 'agent' }]);

    await knowledge.addDocument({
      workspaceId: ctx.workspace.id,
      knowledgeBaseId: created.knowledgeBase.id,
      name: 'agent.md',
      content: 'Agent-owned knowledge must render inside this agent Brain.',
    });
    const graph = intelligence.getGraph(ctx.workspace.id, { scope: 'scoped', scopeId: agentId, includeWorkspace: false });
    expect(graph.nodes.some((node) => node.scopeId === agentId && node.summary?.includes('Agent-owned knowledge'))).toBe(true);
  });

  it('loads document chunk previews and safely renames document metadata', async () => {
    const kb = knowledge.createKnowledgeBase({ workspaceId: ctx.workspace.id, name: 'docs' });
    const document = await knowledge.addDocument({
      workspaceId: ctx.workspace.id,
      knowledgeBaseId: kb.id,
      name: 'original.md',
      content: 'Knowledge preview content for the inspector drawer.',
    });

    const detailRes = await app().request(`/v1/knowledge-bases/${kb.id}/documents/${document.id}`, { headers: ctx.authHeaders });
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json() as { document: { name: string }; chunks: Array<{ id: string; content: string }> };
    expect(detail.document.name).toBe('original.md');
    expect(detail.chunks[0]!.content).toContain('Knowledge preview content');

    const renameRes = await app().request(`/v1/knowledge-bases/${kb.id}/documents/${document.id}`, {
      method: 'PATCH',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        name: 'renamed.md',
        chunks: [{ id: detail.chunks[0]!.id, content: 'Edited chunk content that should feed the Brain map.' }],
      }),
    });
    expect(renameRes.status).toBe(200);
    const renamed = await renameRes.json() as { document: { name: string }; chunks: Array<{ content: string }> };
    expect(renamed.document.name).toBe('renamed.md');
    expect(renamed.chunks[0]!.content).toContain('Edited chunk content');
    const chunk = ctx.db.select().from(schema.kbChunks).where(eq(schema.kbChunks.documentId, document.id)).get()!;
    expect(chunk.metadata).toMatchObject({ source: 'renamed.md', editedVia: 'knowledge_inspector' });
    expect(chunk.embedding).toBeNull();
  });

  it('embeds uploaded chunks natively and tracks hybrid retrieval access', async () => {
    const kb = knowledge.createKnowledgeBase({ workspaceId: ctx.workspace.id, name: 'searchable docs' });
    await knowledge.addDocument({
      workspaceId: ctx.workspace.id,
      knowledgeBaseId: kb.id,
      name: 'operations.md',
      content: 'Release readiness requires a rollback plan and database backup validation.',
    });
    await knowledge.flushPendingIndexing();

    const results = await knowledge.search({
      workspaceId: ctx.workspace.id,
      knowledgeBaseId: kb.id,
      query: 'rollback plan backup validation',
      topK: 3,
    });
    const chunk = ctx.db.select().from(schema.kbChunks).where(eq(schema.kbChunks.id, results[0]!.id)).get()!;

    expect(results[0]!.retrievalMethod).toBe('hybrid');
    expect(Array.isArray(chunk.embedding)).toBe(true);
    expect(chunk.accessCount).toBe(1);
    expect(chunk.lastAccessedAt).toBeTruthy();
  });

  it('rejects document content larger than 10 MiB', async () => {
    const kb = knowledge.createKnowledgeBase({ workspaceId: ctx.workspace.id, name: 'docs' });
    const res = await app().request(`/v1/knowledge-bases/${kb.id}/documents`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        name: 'huge.txt',
        mimeType: 'text/plain',
        content: 'x'.repeat(10 * 1024 * 1024 + 1),
      }),
    });

    expect(res.status).toBe(422);
    expect(knowledge.listDocuments(ctx.workspace.id, kb.id)).toHaveLength(0);
  });

  it('connects chunks from a newly uploaded document in the Brain graph', async () => {
    const { intelligence } = wireAutoLinker();
    const kb = knowledge.createKnowledgeBase({ workspaceId: ctx.workspace.id, name: 'docs' });
    const content = Array.from({ length: 520 }, (_, index) => `tracking-policy-${index % 20}`).join(' ');
    const res = await app().request(`/v1/knowledge-bases/${kb.id}/documents`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ name: 'policy.txt', mimeType: 'text/plain', content }),
    });

    expect(res.status).toBe(201);
    const document = (await res.json()) as { document: { id: string; chunks: number } };
    expect(document.document.chunks).toBeGreaterThan(1);
    await knowledge.flushPendingIndexing();
    const links = ctx.db.select().from(schema.knowledgeLinks)
      .where(eq(schema.knowledgeLinks.workspaceId, ctx.workspace.id))
      .all()
      .filter((link) => link.relation === 'derived_from');
    expect(links).toHaveLength(document.document.chunks - 1);
    expect(intelligence.getGraph(ctx.workspace.id).meta.linkCount).toBeGreaterThanOrEqual(links.length);
  });

  it('repairs structural links for documents indexed before auto-linking was configured', async () => {
    const kb = knowledge.createKnowledgeBase({ workspaceId: ctx.workspace.id, name: 'legacy docs' });
    await knowledge.addDocument({
      workspaceId: ctx.workspace.id,
      knowledgeBaseId: kb.id,
      name: 'legacy.txt',
      content: Array.from({ length: 520 }, (_, index) => `legacy-topic-${index % 15}`).join(' '),
    });

    expect(ctx.db.select().from(schema.knowledgeLinks).all()).toHaveLength(0);
    const { intelligence, linker, repaired } = wireAutoLinker(true);
    const graph = intelligence.getGraph(ctx.workspace.id);
    const repairedLinkCount = graph.meta.linkCount;

    expect(repaired).toBeGreaterThan(0);
    expect(graph.links.some((link) => link.relation === 'derived_from')).toBe(true);
    expect(graph.meta.linkCount).toBeGreaterThan(0);
    expect(knowledge.setAutoLinker(linker, true)).toBe(0);
    expect(intelligence.getGraph(ctx.workspace.id).meta.linkCount).toBe(repairedLinkCount);
  });

  it('stores grounded model summaries and materializes entity and community graph atoms', async () => {
    const { intelligence } = wireAutoLinker();
    knowledge.setEnrichmentProvider(
      enrichment,
      new EnrichedKnowledgeGraphWriter(ctx.db, intelligence, ctx.logger, () => semanticProvider),
    );
    const kb = knowledge.createKnowledgeBase({ workspaceId: ctx.workspace.id, name: 'enriched' });

    await knowledge.addDocument({
      workspaceId: ctx.workspace.id,
      knowledgeBaseId: kb.id,
      name: 'release.md',
      content: 'Release Safety requires a tested rollback plan.',
    });
    await knowledge.addDocument({
      workspaceId: ctx.workspace.id,
      knowledgeBaseId: kb.id,
      name: 'approval.md',
      content: 'Release Safety requires approval after validation.',
    });
    await knowledge.flushPendingIndexing();

    const chunk = ctx.db.select().from(schema.kbChunks).where(eq(schema.kbChunks.knowledgeBaseId, kb.id)).get()!;
    expect(chunk.metadata).toMatchObject({
      generatedSummary: 'Summary of release.md',
      keyFacts: ['Release Safety requires a tested rollback plan.'],
      enrichment: { generated: true, model: 'test-model' },
    });
    const graph = intelligence.getGraph(ctx.workspace.id, { limit: 100 });
    expect(graph.nodes.some((node) => node.label === 'Entity: Release Safety')).toBe(true);
    expect(graph.nodes.some((node) => node.label === 'Community: Release Safety')).toBe(true);
    expect(graph.nodes.filter((node) => node.label === 'Community: Release Safety')).toHaveLength(1);
  });

  it('uses grounded multi-query fusion only for exploratory retrieval', async () => {
    knowledge.setEnrichmentProvider(enrichment);
    const kb = knowledge.createKnowledgeBase({ workspaceId: ctx.workspace.id, name: 'exploration' });
    await knowledge.addDocument({
      workspaceId: ctx.workspace.id,
      knowledgeBaseId: kb.id,
      name: 'overview.md',
      content: 'Resilience planning introduces incident readiness.',
    });
    await knowledge.addDocument({
      workspaceId: ctx.workspace.id,
      knowledgeBaseId: kb.id,
      name: 'recovery.md',
      content: 'The backup restoration procedure verifies restored rows.',
    });
    await knowledge.flushPendingIndexing();

    const results = await knowledge.search({
      workspaceId: ctx.workspace.id,
      knowledgeBaseId: kb.id,
      query: 'resilience',
      retrievalMode: 'exploratory',
      topK: 5,
    });
    expect(results.map((result) => result.content).join('\n')).toContain('backup restoration procedure');
  });

  it('keeps visual descriptions optional and accepts configured audio transcription', async () => {
    knowledge.setEnrichmentProvider(enrichment);
    const kb = knowledge.createKnowledgeBase({ workspaceId: ctx.workspace.id, name: 'media' });
    await knowledge.addDocumentFromBytes({
      workspaceId: ctx.workspace.id,
      knowledgeBaseId: kb.id,
      name: 'diagram.png',
      mimeType: 'image/png',
      bytes: Buffer.from('fake-image'),
      describeImage: true,
    });
    await knowledge.addDocumentFromBytes({
      workspaceId: ctx.workspace.id,
      knowledgeBaseId: kb.id,
      name: 'meeting.wav',
      mimeType: 'audio/wav',
      bytes: Buffer.from('fake-audio'),
    });
    const text = ctx.db.select().from(schema.kbChunks).where(eq(schema.kbChunks.knowledgeBaseId, kb.id)).all()
      .map((chunk) => chunk.content).join('\n');
    expect(text).toContain('deployment diagram');
    expect(text).toContain('Approve the release');
  });

  it('extracts XLSX worksheets into searchable grounded text', async () => {
    const kb = knowledge.createKnowledgeBase({ workspaceId: ctx.workspace.id, name: 'sheets' });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Risks');
    sheet.addRow(['Risk', 'Mitigation']);
    sheet.addRow(['Database loss', 'Validate backup restoration']);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());

    await knowledge.addDocumentFromBytes({
      workspaceId: ctx.workspace.id,
      knowledgeBaseId: kb.id,
      name: 'risks.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes,
    });
    const result = await knowledge.search({
      workspaceId: ctx.workspace.id,
      knowledgeBaseId: kb.id,
      query: 'backup restoration',
    });
    expect(result[0]?.content).toContain('Validate backup restoration');
  });

  it('classifies semantic relation links through the model-backed classifier', async () => {
    const episodes = new EpisodicMemoryStore(ctx.db, ctx.logger);
    const intelligence = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
    const linker = new KnowledgeAutoLinker(intelligence, ctx.logger, () => semanticProvider, (args) => enrichment.classifyRelation(args));
    // Semantic linking compares the source vector against candidates' STORED
    // vectors, so ingestion + linking must embed with the SAME provider (the
    // production invariant — both resolve the workspace provider).
    knowledge.setEmbeddingProviderResolver(() => semanticProvider);
    const kb = knowledge.createKnowledgeBase({ workspaceId: ctx.workspace.id, name: 'relations' });
    const first = await knowledge.addDocument({ workspaceId: ctx.workspace.id, knowledgeBaseId: kb.id, name: 'a.md', content: 'Deployment policy requires rollback.' });
    const second = await knowledge.addDocument({ workspaceId: ctx.workspace.id, knowledgeBaseId: kb.id, name: 'b.md', content: 'Rollback supports safe deployment.' });
    await knowledge.flushPendingIndexing();
    const chunks = ctx.db.select().from(schema.kbChunks).where(eq(schema.kbChunks.knowledgeBaseId, kb.id)).all();
    await linker.autoLinkSemantic({
      workspaceId: ctx.workspace.id,
      sourceId: chunks.find((chunk) => chunk.documentId === second.id)!.id,
      sourceKind: 'kb_chunk',
      sourceTitle: 'b.md',
      sourceContent: 'Rollback supports safe deployment.',
    });
    expect(first.id).toBeTruthy();
    expect(ctx.db.select().from(schema.knowledgeLinks).all().some((link) => link.relation === 'supports')).toBe(true);
  });
});
