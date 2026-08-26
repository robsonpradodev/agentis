import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { KnowledgeAutoLinker } from './knowledgeAutoLinker.js';
import { cosineSimilarity, embedText, selectEmbeddingProvider, type EmbeddingProvider } from '../embedding/embeddingProvider.js';
import type { BrainEnrichmentProvider, ChunkEnrichment, EnrichedKnowledgeGraphWriter } from '../brain/brainEnrichment.js';
import { isCjkToken, segment } from '../brain/brainText.js';

export interface CreateKnowledgeBaseArgs {
  workspaceId: string;
  /** Null means shared workspace knowledge; a workflow id scopes the base. */
  scopeId?: string | null;
  name: string;
  description?: string | null;
}

export interface AddKnowledgeDocumentArgs {
  workspaceId: string;
  knowledgeBaseId: string;
  name: string;
  mimeType?: string;
  content: string;
}

export interface AddKnowledgeDocumentBytesArgs {
  workspaceId: string;
  knowledgeBaseId: string;
  name: string;
  mimeType?: string;
  bytes: Buffer;
  describeImage?: boolean;
}

export interface UpdateKnowledgeBaseArgs {
  workspaceId: string;
  knowledgeBaseId: string;
  name?: string;
  description?: string | null;
}

export interface UpdateKnowledgeDocumentArgs {
  workspaceId: string;
  knowledgeBaseId: string;
  documentId: string;
  name?: string;
  chunks?: Array<{ id: string; content: string }>;
}

export interface SearchKnowledgeArgs {
  workspaceId: string;
  knowledgeBaseId: string;
  query: string;
  topK?: number;
  retrievalMode?: 'contextual' | 'strict' | 'exploratory';
}

export interface ListKnowledgeBaseOptions {
  /**
   * Undefined returns every base for workspace management. Null selects only
   * workspace-shared bases; an id selects that workflow's bases.
   */
  scopeId?: string | null;
  /** Include workspace-shared bases alongside an explicit workflow scope. */
  includeWorkspace?: boolean;
}

/** A document's chunks queued for background enrich + embed + link. */
interface IndexJob {
  documentId: string;
  workspaceId: string;
  name: string;
  mimeType: string;
  scopeId: string | null;
  chunks: string[];
  chunkIds: string[];
}

export class KnowledgeBaseService {
  private autoLinker: Pick<KnowledgeAutoLinker, 'autoLink' | 'autoLinkSemantic'> | null = null;
  private embeddingProviderResolver: ((workspaceId: string) => EmbeddingProvider) | null = null;
  private enrichmentProvider: BrainEnrichmentProvider | null = null;
  private graphWriter: Pick<EnrichedKnowledgeGraphWriter, 'writeDocument'> | null = null;
  /** In-flight background indexing jobs — awaited by `flushPendingIndexing`. */
  readonly #pendingIndexing = new Set<Promise<unknown>>();

  constructor(private readonly db: AgentisSqliteDb) {}

  /**
   * Attach the Brain linker after both services have been composed. Existing
   * documents may predate graph linking, so bootstrap can repair only missing
   * structural links without reinforcing complete documents on each restart.
   */
  setAutoLinker(linker: Pick<KnowledgeAutoLinker, 'autoLink' | 'autoLinkSemantic'>, repairExisting = false): number {
    this.autoLinker = linker;
    return repairExisting ? this.repairOrphanedDocumentLinks() : 0;
  }

  /**
   * §PERF-BOOT — public entry for the orphan-link repair so bootstrap can DEFER
   * it. Passing `repairExisting: true` above ran the full scan synchronously
   * inside `bootstrap()` — measured 3.2s on local NVMe and ~8s on a real 732 MB
   * workspace — every boot, before the port could bind. The scan is idempotent
   * housekeeping over existing rows; nothing about first-request correctness
   * depends on it having run.
   */
  repairOrphanedLinks(): number {
    return this.repairOrphanedDocumentLinks();
  }

  setEmbeddingProviderResolver(resolver: (workspaceId: string) => EmbeddingProvider): void {
    this.embeddingProviderResolver = resolver;
  }

  setEnrichmentProvider(
    provider: BrainEnrichmentProvider | null,
    graphWriter?: Pick<EnrichedKnowledgeGraphWriter, 'writeDocument'> | null,
  ): void {
    this.enrichmentProvider = provider;
    this.graphWriter = graphWriter ?? null;
  }

  listKnowledgeBases(workspaceId: string, options?: ListKnowledgeBaseOptions) {
    const targetScopeId = options?.scopeId;
    const scoped = targetScopeId !== undefined;
    const scopeFilter = !scoped
      ? undefined
      : targetScopeId === null
        ? isNull(schema.knowledgeBases.scopeId)
        : options?.includeWorkspace
          ? or(eq(schema.knowledgeBases.scopeId, targetScopeId), isNull(schema.knowledgeBases.scopeId))
          : eq(schema.knowledgeBases.scopeId, targetScopeId);
    return this.db
      .select()
      .from(schema.knowledgeBases)
      .where(and(eq(schema.knowledgeBases.workspaceId, workspaceId), ...(scopeFilter ? [scopeFilter] : [])))
      .all()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  getKnowledgeBase(workspaceId: string, knowledgeBaseId: string) {
    const kb = this.db
      .select()
      .from(schema.knowledgeBases)
      .where(
        and(
          eq(schema.knowledgeBases.id, knowledgeBaseId),
          eq(schema.knowledgeBases.workspaceId, workspaceId),
        ),
      )
      .get();
    if (!kb) throw new AgentisError('RESOURCE_NOT_FOUND', 'Knowledge base not found');
    return kb;
  }

  createKnowledgeBase(args: CreateKnowledgeBaseArgs) {
    const now = new Date().toISOString();
    const kb = {
      id: randomUUID(),
      workspaceId: args.workspaceId,
      scopeId: args.scopeId ?? null,
      name: args.name,
      description: args.description ?? null,
      embeddingModel: 'lexical-v1',
      embeddingDimension: 0,
      chunkingConfig: { maxTokens: 240, overlapTokens: 40 } as unknown as object,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(schema.knowledgeBases).values(kb).run();
    return kb;
  }

  updateKnowledgeBase(args: UpdateKnowledgeBaseArgs) {
    const existing = this.getKnowledgeBase(args.workspaceId, args.knowledgeBaseId);
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (args.name !== undefined) patch.name = args.name;
    if (args.description !== undefined) patch.description = args.description;
    this.db.update(schema.knowledgeBases).set(patch).where(eq(schema.knowledgeBases.id, existing.id)).run();
    return this.getKnowledgeBase(args.workspaceId, args.knowledgeBaseId);
  }

  deleteKnowledgeBase(workspaceId: string, knowledgeBaseId: string) {
    this.getKnowledgeBase(workspaceId, knowledgeBaseId);
    const documents = this.listDocuments(workspaceId, knowledgeBaseId);
    const archivedDocuments = this.db.select({ id: schema.kbDocuments.id }).from(schema.kbDocuments).where(and(
      eq(schema.kbDocuments.workspaceId, workspaceId),
      eq(schema.kbDocuments.knowledgeBaseId, knowledgeBaseId),
    )).all();
    const documentIds = [...new Set([...documents.map((document) => document.id), ...archivedDocuments.map((document) => document.id)])];
    for (const documentId of documentIds) this.deleteDocument(workspaceId, knowledgeBaseId, documentId);
    this.db.delete(schema.knowledgeBases).where(eq(schema.knowledgeBases.id, knowledgeBaseId)).run();
    return { id: knowledgeBaseId, deleted: true };
  }

  listDocuments(workspaceId: string, knowledgeBaseId: string) {
    this.getKnowledgeBase(workspaceId, knowledgeBaseId);
    return this.db
      .select()
      .from(schema.kbDocuments)
      .where(
        and(
          eq(schema.kbDocuments.workspaceId, workspaceId),
          eq(schema.kbDocuments.knowledgeBaseId, knowledgeBaseId),
        ),
      )
      .all()
      .filter((document) => !document.archivedAt)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  getDocument(workspaceId: string, knowledgeBaseId: string, documentId: string) {
    this.getKnowledgeBase(workspaceId, knowledgeBaseId);
    const document = this.db
      .select()
      .from(schema.kbDocuments)
      .where(
        and(
          eq(schema.kbDocuments.workspaceId, workspaceId),
          eq(schema.kbDocuments.knowledgeBaseId, knowledgeBaseId),
          eq(schema.kbDocuments.id, documentId),
        ),
      )
      .get();
    if (!document || document.archivedAt) throw new AgentisError('RESOURCE_NOT_FOUND', 'Document not found');
    return document;
  }

  listDocumentChunks(workspaceId: string, knowledgeBaseId: string, documentId: string) {
    this.getDocument(workspaceId, knowledgeBaseId, documentId);
    return this.db
      .select({
        id: schema.kbChunks.id,
        chunkIndex: schema.kbChunks.chunkIndex,
        content: schema.kbChunks.content,
        metadata: schema.kbChunks.metadata,
        tokenCount: schema.kbChunks.tokenCount,
        createdAt: schema.kbChunks.createdAt,
      })
      .from(schema.kbChunks)
      .where(
        and(
          eq(schema.kbChunks.workspaceId, workspaceId),
          eq(schema.kbChunks.knowledgeBaseId, knowledgeBaseId),
          eq(schema.kbChunks.documentId, documentId),
        ),
      )
      .all()
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  updateDocument(args: UpdateKnowledgeDocumentArgs) {
    const existing = this.getDocument(args.workspaceId, args.knowledgeBaseId, args.documentId);
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (args.name !== undefined) patch.name = args.name;
    this.db.update(schema.kbDocuments)
      .set(patch)
      .where(eq(schema.kbDocuments.id, existing.id))
      .run();
    if (args.name !== undefined) {
      const chunks = this.db.select().from(schema.kbChunks)
        .where(and(
          eq(schema.kbChunks.workspaceId, args.workspaceId),
          eq(schema.kbChunks.knowledgeBaseId, args.knowledgeBaseId),
          eq(schema.kbChunks.documentId, args.documentId),
        ))
        .all();
      for (const chunk of chunks) {
        const metadata = parseJsonRecord(chunk.metadata);
        this.db.update(schema.kbChunks)
          .set({ metadata: { ...metadata, source: args.name } as unknown as object })
          .where(eq(schema.kbChunks.id, chunk.id))
          .run();
      }
    }
    if (args.chunks) {
      const existingChunks = this.db.select().from(schema.kbChunks)
        .where(and(
          eq(schema.kbChunks.workspaceId, args.workspaceId),
          eq(schema.kbChunks.knowledgeBaseId, args.knowledgeBaseId),
          eq(schema.kbChunks.documentId, args.documentId),
        ))
        .all();
      const allowedIds = new Set(existingChunks.map((chunk) => chunk.id));
      for (const chunk of args.chunks) {
        const content = chunk.content.trim();
        if (!allowedIds.has(chunk.id)) throw new AgentisError('RESOURCE_NOT_FOUND', 'Chunk not found');
        if (!content) throw new AgentisError('VALIDATION_FAILED', 'Chunk content cannot be empty');
        const existingChunk = existingChunks.find((item) => item.id === chunk.id);
        const metadata = parseJsonRecord(existingChunk?.metadata);
        this.db.update(schema.kbChunks)
          .set({
            content,
            tokenCount: tokenize(content).length,
            embedding: null,
            metadata: {
              ...metadata,
              source: args.name ?? existing.name,
              editedAt: new Date().toISOString(),
              editedVia: 'knowledge_inspector',
            } as unknown as object,
          })
          .where(eq(schema.kbChunks.id, chunk.id))
          .run();
      }
      const nextChunks = this.db.select({ tokenCount: schema.kbChunks.tokenCount })
        .from(schema.kbChunks)
        .where(and(
          eq(schema.kbChunks.workspaceId, args.workspaceId),
          eq(schema.kbChunks.knowledgeBaseId, args.knowledgeBaseId),
          eq(schema.kbChunks.documentId, args.documentId),
        ))
        .all();
      this.db.update(schema.kbDocuments)
        .set({ tokenCount: nextChunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0), updatedAt: new Date().toISOString() })
        .where(eq(schema.kbDocuments.id, args.documentId))
        .run();
    }
    return this.getDocument(args.workspaceId, args.knowledgeBaseId, args.documentId);
  }

  async addDocument(args: AddKnowledgeDocumentArgs) {
    const knowledgeBase = this.getKnowledgeBase(args.workspaceId, args.knowledgeBaseId);
    const mimeType = args.mimeType ?? mimeTypeFromName(args.name);
    const content = extractText(args.content, mimeType);
    if (!content.trim()) throw new AgentisError('VALIDATION_FAILED', 'Document content is empty');

    return this.persistDocument({
      workspaceId: args.workspaceId,
      knowledgeBaseId: args.knowledgeBaseId,
      name: args.name,
      mimeType,
      content,
    });
  }

  async addDocumentFromBytes(args: AddKnowledgeDocumentBytesArgs) {
    this.getKnowledgeBase(args.workspaceId, args.knowledgeBaseId);
    const mimeType = args.mimeType ?? mimeTypeFromName(args.name);
    const content = await extractTextFromBytes(args.workspaceId, args.bytes, mimeType, args.name, this.enrichmentProvider, args.describeImage ?? false);
    if (!content.trim()) throw new AgentisError('VALIDATION_FAILED', 'Document content is empty');

    return this.persistDocument({
      workspaceId: args.workspaceId,
      knowledgeBaseId: args.knowledgeBaseId,
      name: args.name,
      mimeType,
      content,
    });
  }

  private async persistDocument(args: AddKnowledgeDocumentArgs & { content: string }) {
    const knowledgeBase = this.getKnowledgeBase(args.workspaceId, args.knowledgeBaseId);
    const now = new Date().toISOString();
    const documentId = randomUUID();
    const mimeType = args.mimeType ?? 'text/plain';
    const chunks = chunkText(args.content);
    // §perf — the document + ALL its chunks are inserted SYNCHRONOUSLY (text +
    // deterministic context only), so the upload request returns in milliseconds.
    // Embedding, per-chunk LLM grounding, link- and graph-writing used to run
    // inside this request — dozens of model calls deep for a multi-chunk doc —
    // which hung the upload AND starved the single-threaded API (every other
    // request, including the SPA bootstrap, stalled → "Loading…" everywhere).
    // They now run in the background (see #indexDocumentInBackground), which
    // yields to the event loop between chunks so the API stays responsive. The
    // document shows immediately as `indexing` and flips to `ready` when indexed.
    const document = {
      id: documentId,
      knowledgeBaseId: args.knowledgeBaseId,
      workspaceId: args.workspaceId,
      name: args.name,
      mimeType,
      status: 'indexing',
      tokenCount: tokenize(args.content).length,
      error: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(schema.kbDocuments).values(document).run();
    const chunkIds: string[] = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      const chunkId = randomUUID();
      chunkIds.push(chunkId);
      const contextPrefix = contextualPrefix(args.name, index, chunks.length, mimeType);
      this.db.insert(schema.kbChunks).values({
        id: chunkId,
        documentId,
        knowledgeBaseId: args.knowledgeBaseId,
        workspaceId: args.workspaceId,
        chunkIndex: index,
        content: chunk,
        metadata: {
          source: args.name,
          contextPrefix,
          importanceScore: inferImportance(chunk),
          entities: extractEntities(chunk),
          ingestionType: ingestionType(mimeType),
          enrichment: { generated: false, strategy: 'pending' },
        } as unknown as object,
        tokenCount: tokenize(chunk).length,
        createdAt: now,
      }).run();
    }

    this.#startIndexing({
      documentId,
      workspaceId: args.workspaceId,
      name: args.name,
      mimeType,
      scopeId: knowledgeBase.scopeId,
      chunks,
      chunkIds,
    });

    return { ...document, chunks: chunks.length };
  }

  /** Spawn + track a background indexing job so tests can await completion. */
  #startIndexing(job: IndexJob): void {
    const p = this.#indexDocumentInBackground(job);
    this.#pendingIndexing.add(p);
    void p.finally(() => this.#pendingIndexing.delete(p));
  }

  /**
   * Await all in-flight background indexing. Production never needs this (uploads
   * return immediately and index asynchronously); tests use it to assert the
   * fully-indexed state deterministically.
   */
  async flushPendingIndexing(): Promise<void> {
    await Promise.allSettled([...this.#pendingIndexing]);
  }

  /**
   * §perf — the heavy half of ingestion, run OFF the upload request. Enriches +
   * embeds each chunk (updating its row in place), then links + graph-writes,
   * then flips the document to `ready`. A short breather between chunks keeps the
   * event loop responsive so a large document never blocks the API.
   */
  #indexDocumentInBackground(job: IndexJob): Promise<void> {
    const markReady = () => {
      try {
        this.db.update(schema.kbDocuments)
          .set({ status: 'ready', updatedAt: new Date().toISOString() })
          .where(and(eq(schema.kbDocuments.workspaceId, job.workspaceId), eq(schema.kbDocuments.id, job.documentId)))
          .run();
      } catch { /* document may have been deleted mid-index */ }
    };
    return (async () => {
      const provider = this.embeddingProvider(job.workspaceId);
      const enrichments: Array<ChunkEnrichment | null> = [];
      for (let index = 0; index < job.chunks.length; index += 1) {
        const chunk = job.chunks[index]!;
        const chunkId = job.chunkIds[index]!;
        const generated = (await this.enrichmentProvider?.enrichChunk({
          workspaceId: job.workspaceId,
          documentName: job.name,
          mimeType: job.mimeType,
          chunkIndex: index,
          chunkCount: job.chunks.length,
          content: chunk,
        }).catch(() => null)) ?? null;
        const contextPrefix = generated?.contextPrefix ?? contextualPrefix(job.name, index, job.chunks.length, job.mimeType);
        let embedding: number[] | null = null;
        try {
          const raw = provider.embed(`${contextPrefix}\n\n${chunk}`);
          embedding = raw instanceof Promise ? await raw : raw;
        } catch { embedding = null; }
        try {
          this.db.update(schema.kbChunks).set({
            metadata: {
              source: job.name,
              contextPrefix,
              importanceScore: generated?.importanceScore ?? inferImportance(chunk),
              entities: generated?.entities ?? extractEntities(chunk),
              ingestionType: ingestionType(job.mimeType),
              ...(generated ? {
                generatedSummary: generated.summary,
                keyFacts: generated.keyFacts,
                enrichment: { generated: true, model: generated.model ?? 'configured-model' },
              } : { enrichment: { generated: false, strategy: 'deterministic_context' } }),
            } as unknown as object,
            ...(Array.isArray(embedding) ? { embedding } : {}),
          }).where(and(eq(schema.kbChunks.workspaceId, job.workspaceId), eq(schema.kbChunks.id, chunkId))).run();
        } catch { /* keep indexing the rest */ }
        enrichments.push(generated);
        // §perf — a real breather, not just setImmediate. Each embed blocks the
        // main thread ~80–160ms (the on-device model's JS tokenize/pool work runs
        // synchronously), so back-to-back chunks could otherwise starve incoming
        // requests. A short timer hands the event loop dedicated idle time between
        // chunks, so the rest of Agentis stays fully responsive while a large
        // document indexes in the background — it just indexes a touch slower.
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      try {
        await this.linkDocumentChunks(job.documentId, job.workspaceId, job.name, job.scopeId);
        if (this.graphWriter && enrichments.some(Boolean)) {
          await this.graphWriter.writeDocument({
            workspaceId: job.workspaceId,
            documentId: job.documentId,
            documentName: job.name,
            chunkIds: job.chunkIds,
            enrichments,
          });
        }
      } catch { /* best effort — links/graph are enhancements */ }
      markReady();
    })().catch(markReady);
  }

  /**
   * §perf — re-run background indexing for any document left `indexing` by a
   * restart mid-ingest, so it never stays stuck without embeddings. Called once
   * at startup. Re-embedding already-embedded chunks is an idempotent UPDATE.
   */
  resumeStalledIndexing(): void {
    const stalled = this.db.select().from(schema.kbDocuments)
      .where(eq(schema.kbDocuments.status, 'indexing')).all();
    for (const doc of stalled) {
      const chunkRows = this.db.select({ id: schema.kbChunks.id, content: schema.kbChunks.content })
        .from(schema.kbChunks)
        .where(and(eq(schema.kbChunks.workspaceId, doc.workspaceId), eq(schema.kbChunks.documentId, doc.id)))
        .orderBy(schema.kbChunks.chunkIndex)
        .all();
      if (chunkRows.length === 0) { // nothing to index — don't leave it stuck
        this.db.update(schema.kbDocuments).set({ status: 'ready' }).where(eq(schema.kbDocuments.id, doc.id)).run();
        continue;
      }
      const kb = this.db.select({ scopeId: schema.knowledgeBases.scopeId })
        .from(schema.knowledgeBases).where(eq(schema.knowledgeBases.id, doc.knowledgeBaseId)).get();
      this.#startIndexing({
        documentId: doc.id,
        workspaceId: doc.workspaceId,
        name: doc.name,
        mimeType: doc.mimeType,
        scopeId: kb?.scopeId ?? null,
        chunks: chunkRows.map((row) => row.content),
        chunkIds: chunkRows.map((row) => row.id),
      });
    }
  }

  archiveDocument(workspaceId: string, knowledgeBaseId: string, documentId: string) {
    this.getKnowledgeBase(workspaceId, knowledgeBaseId);
    const document = this.db
      .select()
      .from(schema.kbDocuments)
      .where(
        and(
          eq(schema.kbDocuments.workspaceId, workspaceId),
          eq(schema.kbDocuments.knowledgeBaseId, knowledgeBaseId),
          eq(schema.kbDocuments.id, documentId),
        ),
      )
      .get();
    if (!document) throw new AgentisError('RESOURCE_NOT_FOUND', 'Document not found');
    const now = new Date().toISOString();
    this.db.update(schema.kbDocuments)
      .set({ status: 'archived', archivedAt: now, updatedAt: now })
      .where(eq(schema.kbDocuments.id, documentId))
      .run();
    return { id: documentId, archived: true };
  }

  deleteDocument(workspaceId: string, knowledgeBaseId: string, documentId: string) {
    this.getKnowledgeBase(workspaceId, knowledgeBaseId);
    const document = this.db
      .select({ id: schema.kbDocuments.id })
      .from(schema.kbDocuments)
      .where(
        and(
          eq(schema.kbDocuments.workspaceId, workspaceId),
          eq(schema.kbDocuments.knowledgeBaseId, knowledgeBaseId),
          eq(schema.kbDocuments.id, documentId),
        ),
      )
      .get();
    if (!document) throw new AgentisError('RESOURCE_NOT_FOUND', 'Document not found');

    const chunkIds = this.db.select({ id: schema.kbChunks.id }).from(schema.kbChunks).where(and(
      eq(schema.kbChunks.workspaceId, workspaceId),
      eq(schema.kbChunks.knowledgeBaseId, knowledgeBaseId),
      eq(schema.kbChunks.documentId, documentId),
    )).all().map((chunk) => chunk.id);
    if (chunkIds.length > 0) {
      this.db.delete(schema.knowledgeLinks).where(and(
        eq(schema.knowledgeLinks.workspaceId, workspaceId),
        or(inArray(schema.knowledgeLinks.sourceId, chunkIds), inArray(schema.knowledgeLinks.targetId, chunkIds)),
      )).run();
    }

    // Do not rely solely on FK cascades: existing SQLite installations may have
    // foreign_keys disabled, and a permanent agent operation must not leave
    // retrievable chunks behind.
    this.db.delete(schema.kbChunks).where(and(
      eq(schema.kbChunks.workspaceId, workspaceId),
      eq(schema.kbChunks.knowledgeBaseId, knowledgeBaseId),
      eq(schema.kbChunks.documentId, documentId),
    )).run();
    this.db.delete(schema.kbDocuments).where(and(
      eq(schema.kbDocuments.workspaceId, workspaceId),
      eq(schema.kbDocuments.knowledgeBaseId, knowledgeBaseId),
      eq(schema.kbDocuments.id, documentId),
    )).run();
    return { id: documentId, deleted: true };
  }

  async search(args: SearchKnowledgeArgs) {
    this.getKnowledgeBase(args.workspaceId, args.knowledgeBaseId);
    if (tokenize(args.query).length === 0) return [];
    const topK = Math.min(Math.max(args.topK ?? 5, 1), 20);
    const chunks = this.db
      .select()
      .from(schema.kbChunks)
      .where(
        and(
          eq(schema.kbChunks.workspaceId, args.workspaceId),
          eq(schema.kbChunks.knowledgeBaseId, args.knowledgeBaseId),
        ),
      )
      .all();

    const activeChunks = chunks
      .filter((chunk) => this.isDocumentActive(args.workspaceId, chunk.documentId))
    const now = Date.now();
    const provider = this.embeddingProvider(args.workspaceId);
    const rankForQuery = async (query: string) => {
      const queryTokens = new Set(tokenize(query));
      let queryEmbedding: number[] | null = null;
      try {
        queryEmbedding = await embedText(provider, query);
      } catch {
        queryEmbedding = null;
      }
      return activeChunks
        .map((chunk) => {
          const lexical = scoreChunk(queryTokens, chunk.content);
          const embedding = parseJsonArray<number>(chunk.embedding);
          const semantic = queryEmbedding && embedding.length > 0 ? Math.max(0, cosineSimilarity(queryEmbedding, embedding)) : 0;
          const metadata = parseJsonRecord(chunk.metadata);
          const importance = typeof metadata.importanceScore === 'number' ? metadata.importanceScore : 0.5;
          const ageDays = Math.max(0, (now - Date.parse(chunk.createdAt)) / 86_400_000);
          const recency = Math.exp(-0.007 * ageDays);
          const retrieval = semantic > 0 ? 0.7 * semantic + 0.3 * lexical : lexical;
          const score = 0.65 * retrieval + 0.2 * importance + 0.15 * recency;
          return { chunk, score, retrieval, retrievalMethod: semantic > 0 ? 'hybrid' : 'lexical' as 'hybrid' | 'lexical' };
        })
        .filter((result) => result.retrieval > (args.retrievalMode === 'strict' ? 0.18 : 0.01))
        .sort((a, b) => b.score - a.score);
    };
    const initial = await rankForQuery(args.query);
    let ranked = initial.slice(0, topK);
    if (args.retrievalMode === 'exploratory' && this.enrichmentProvider && initial.length > 0) {
      const expanded = await this.enrichmentProvider.expandGroundedQuery({
        workspaceId: args.workspaceId,
        query: args.query,
        snippets: initial.slice(0, 4).map((result) => result.chunk.content),
      }).catch(() => []);
      if (expanded.length > 0) {
        const resultLists = [initial, ...(await Promise.all(expanded.map((query) => rankForQuery(query))))];
        const fused = new Map<string, { item: typeof initial[number]; rrf: number }>();
        for (const list of resultLists) {
          for (const [rank, item] of list.slice(0, 20).entries()) {
            const existing = fused.get(item.chunk.id);
            const rrf = 1 / (60 + rank + 1);
            fused.set(item.chunk.id, { item, rrf: (existing?.rrf ?? 0) + rrf });
          }
        }
        ranked = [...fused.values()]
          .sort((a, b) => b.rrf - a.rrf)
          .slice(0, topK)
          .map(({ item, rrf }) => ({ ...item, score: rrf, retrievalMethod: 'hybrid' as const }));
      }
    }
    const accessedAt = new Date().toISOString();
    for (const result of ranked) {
      this.db.update(schema.kbChunks)
        .set({ accessCount: sql`${schema.kbChunks.accessCount} + 1`, lastAccessedAt: accessedAt })
        .where(eq(schema.kbChunks.id, result.chunk.id))
        .run();
    }
    return ranked.map(({ chunk, score, retrievalMethod }) => ({
        id: chunk.id,
        documentId: chunk.documentId,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        metadata: chunk.metadata,
        score,
        retrievalMethod,
      }));
  }

  async backfillEmbeddings(workspaceId: string): Promise<{ embedded: number; failed: number }> {
    const provider = this.embeddingProvider(workspaceId);
    const rows = this.db.select().from(schema.kbChunks).where(eq(schema.kbChunks.workspaceId, workspaceId)).all();
    let embedded = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const metadata = parseJsonRecord(row.metadata);
        const prefix = typeof metadata.contextPrefix === 'string' ? metadata.contextPrefix : '';
        const embedding = await embedText(provider, `${prefix}\n\n${row.content}`.trim());
        this.db.update(schema.kbChunks).set({ embedding }).where(eq(schema.kbChunks.id, row.id)).run();
        embedded += 1;
      } catch {
        failed += 1;
      }
    }
    return { embedded, failed };
  }

  private embeddingProvider(workspaceId: string): EmbeddingProvider {
    if (this.embeddingProviderResolver) return this.embeddingProviderResolver(workspaceId);
    const row = this.db.select({
      type: schema.workspaces.embeddingProviderType,
      config: schema.workspaces.embeddingProviderConfig,
    }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get();
    return selectEmbeddingProvider(row?.type ?? 'local', parseJsonRecord(row?.config));
  }

  private isDocumentActive(workspaceId: string, documentId: string): boolean {
    const document = this.db.select({ archivedAt: schema.kbDocuments.archivedAt })
      .from(schema.kbDocuments)
      .where(and(eq(schema.kbDocuments.workspaceId, workspaceId), eq(schema.kbDocuments.id, documentId)))
      .get();
    return Boolean(document && !document.archivedAt);
  }

  private async linkDocumentChunks(documentId: string, workspaceId: string, name: string, scopeId: string | null): Promise<number> {
    if (!this.autoLinker) return 0;
    const chunks = this.db.select().from(schema.kbChunks)
      .where(and(eq(schema.kbChunks.workspaceId, workspaceId), eq(schema.kbChunks.documentId, documentId)))
      .all()
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
    const head = chunks[0];
    if (!head) return 0;
    let linked = 0;
    for (const chunk of chunks) {
      const input = {
        workspaceId,
        sourceId: chunk.id,
        sourceKind: 'kb_chunk' as const,
        sourceTitle: name,
        sourceContent: chunk.content,
        scopeId,
        siblingHeadId: chunk.id === head.id ? null : head.id,
        siblingHeadKind: chunk.id === head.id ? null : 'kb_chunk' as const,
      };
      linked += this.autoLinker.autoLink(input);
      // §perf — semantic linking embeds the source + classifies relations (LLM).
      // Run it SERIALLY with a breather, not fired-and-forgotten once per chunk:
      // the old burst started N semantic passes at once (each re-embedding every
      // candidate) and pinned the event loop for minutes. Awaiting + yielding
      // keeps the rest of Agentis responsive while the document links.
      try { await this.autoLinker.autoLinkSemantic(input); } catch { /* best effort */ }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    return linked;
  }

  private repairOrphanedDocumentLinks(): number {
    if (!this.autoLinker) return 0;
    const documents = this.db.select({ document: schema.kbDocuments, scopeId: schema.knowledgeBases.scopeId })
      .from(schema.kbDocuments)
      .innerJoin(schema.knowledgeBases, eq(schema.kbDocuments.knowledgeBaseId, schema.knowledgeBases.id))
      .all()
      .filter(({ document }) => !document.archivedAt);
    let linked = 0;
    for (const { document, scopeId } of documents) {
      const chunks = this.db.select().from(schema.kbChunks)
        .where(and(
          eq(schema.kbChunks.workspaceId, document.workspaceId),
          eq(schema.kbChunks.documentId, document.id),
        ))
        .all()
        .sort((a, b) => a.chunkIndex - b.chunkIndex);
      const head = chunks[0];
      if (!head) continue;
      if (chunks.length === 1) {
        if (!this.atomHasAnyLink(document.workspaceId, head.id)) {
          linked += this.autoLinker.autoLink({
            workspaceId: document.workspaceId,
            sourceId: head.id,
            sourceKind: 'kb_chunk',
            sourceTitle: document.name,
            sourceContent: head.content,
            scopeId,
          });
        }
        continue;
      }
      for (const chunk of chunks.slice(1)) {
        if (this.hasSiblingLink(document.workspaceId, chunk.id, head.id)) continue;
        linked += this.autoLinker.autoLink({
          workspaceId: document.workspaceId,
          sourceId: chunk.id,
          sourceKind: 'kb_chunk',
          sourceTitle: document.name,
          sourceContent: chunk.content,
          scopeId,
          siblingHeadId: head.id,
          siblingHeadKind: 'kb_chunk',
        });
      }
    }
    return linked;
  }

  private hasSiblingLink(workspaceId: string, chunkId: string, headId: string): boolean {
    return Boolean(this.db.select({ id: schema.knowledgeLinks.id }).from(schema.knowledgeLinks)
      .where(and(
        eq(schema.knowledgeLinks.workspaceId, workspaceId),
        eq(schema.knowledgeLinks.sourceId, chunkId),
        eq(schema.knowledgeLinks.sourceKind, 'kb_chunk'),
        eq(schema.knowledgeLinks.targetId, headId),
        eq(schema.knowledgeLinks.targetKind, 'kb_chunk'),
        eq(schema.knowledgeLinks.relation, 'derived_from'),
      ))
      .get());
  }

  private atomHasAnyLink(workspaceId: string, atomId: string): boolean {
    return Boolean(this.db.select({ id: schema.knowledgeLinks.id }).from(schema.knowledgeLinks)
      .where(and(
        eq(schema.knowledgeLinks.workspaceId, workspaceId),
        or(eq(schema.knowledgeLinks.sourceId, atomId), eq(schema.knowledgeLinks.targetId, atomId))!,
      ))
      .get());
  }
}

function extractText(content: string, mimeType: string): string {
  const normalizedType = mimeType.toLowerCase();
  if (isHtmlDocument(normalizedType)) {
    return htmlToText(content);
  }
  if (normalizedType.includes('json')) {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return content;
    }
  }
  return content;
}

export async function extractTextFromBytes(
  workspaceId: string,
  bytes: Buffer,
  mimeType: string,
  fileName: string,
  enrichment: BrainEnrichmentProvider | null,
  describeImage: boolean,
): Promise<string> {
  const normalizedType = mimeType.toLowerCase();
  const normalizedName = fileName.toLowerCase();
  if (normalizedType.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/.test(normalizedName)) {
    if (describeImage && enrichment?.describeImage) {
      try {
        return await enrichment.describeImage({ workspaceId, bytes, mimeType, fileName });
      } catch (error) {
        throw new AgentisError('VALIDATION_FAILED', `Could not describe image: ${(error as Error).message}`);
      }
    }
    return extractImageText(bytes, fileName);
  }

  if (
    normalizedType.includes('spreadsheet')
    || normalizedType.includes('excel')
    || normalizedName.endsWith('.xlsx')
    || normalizedName.endsWith('.xls')
  ) {
    return extractSpreadsheetText(bytes, fileName);
  }

  if (normalizedType.startsWith('audio/') || /\.(mp3|m4a|wav|ogg)$/.test(normalizedName)) {
    if (!enrichment?.transcribeAudio) {
      throw new AgentisError('VALIDATION_FAILED', 'Audio transcription is not configured on this installation. Upload a transcript or configure a transcription provider.');
    }
    try {
      return await enrichment.transcribeAudio({ workspaceId, bytes, mimeType, fileName });
    } catch (error) {
      throw new AgentisError('VALIDATION_FAILED', `Could not transcribe audio: ${(error as Error).message}`);
    }
  }
  if (normalizedType.includes('pdf') || normalizedName.endsWith('.pdf')) {
    try {
      const { PDFParse } = await import('pdf-parse') as typeof import('pdf-parse');
      const parser = new PDFParse({ data: bytes });
      try {
        const result = await parser.getText();
        return result.text ?? '';
      } finally {
        await parser.destroy();
      }
    } catch (err) {
      throw new AgentisError('VALIDATION_FAILED', `Could not extract text from PDF: ${(err as Error).message}`);
    }
  }

  if (
    normalizedType.includes('wordprocessingml.document')
    || normalizedType.includes('msword')
    || normalizedName.endsWith('.docx')
  ) {
    try {
      const mammoth = await import('mammoth') as typeof import('mammoth');
      const result = await mammoth.extractRawText({ buffer: bytes });
      return result.value ?? '';
    } catch (err) {
      throw new AgentisError('VALIDATION_FAILED', `Could not extract text from DOCX: ${(err as Error).message}`);
    }
  }

  const text = bytes.toString('utf8');
  if (looksBinary(text)) {
    throw new AgentisError('VALIDATION_FAILED', 'Unsupported binary document type. Upload PDF, DOCX, HTML, Markdown, text, CSV, or JSON.');
  }
  return isHtmlDocument(mimeType, fileName) ? htmlToText(text) : extractText(text, mimeType);
}

function looksBinary(text: string): boolean {
  if (!text) return false;
  const replacementChars = (text.match(/\uFFFD/g) ?? []).length;
  const nullChars = (text.match(/\0/g) ?? []).length;
  return replacementChars + nullChars > Math.max(8, text.length * 0.01);
}

export function mimeTypeFromName(fileName: string): string {
  const name = fileName.toLowerCase();
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.csv')) return 'text/csv';
  if (name.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (name.endsWith('.xls')) return 'application/vnd.ms-excel';
  if (/\.(png|jpg|jpeg|webp|gif)$/.test(name)) return `image/${name.endsWith('.jpg') ? 'jpeg' : name.slice(name.lastIndexOf('.') + 1)}`;
  if (/\.(mp3|m4a|wav|ogg)$/.test(name)) return `audio/${name.slice(name.lastIndexOf('.') + 1)}`;
  if (name.endsWith('.html') || name.endsWith('.htm')) return 'text/html';
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'text/markdown';
  return 'text/plain';
}

function isHtmlDocument(mimeType: string, fileName = ''): boolean {
  const type = mimeType.toLowerCase();
  const name = fileName.toLowerCase();
  return type.includes('html') || name.endsWith('.html') || name.endsWith('.htm');
}

function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|article|header|footer|main|aside|li|ul|ol|table|thead|tbody|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  return decodeHtmlEntities(withBreaks)
    .replace(/\r/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return isValidCodePoint(code) ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return isValidCodePoint(code) ? String.fromCodePoint(code) : match;
    }
    return named[lower] ?? match;
  });
}

function isValidCodePoint(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0x10FFFF;
}

function chunkText(content: string, maxTokens = 240, overlapTokens = 40): string[] {
  const words = content.split(/\s+/).filter(Boolean);
  if (words.length <= maxTokens) return [content.trim()];
  const chunks: string[] = [];
  const step = Math.max(maxTokens - overlapTokens, 1);
  for (let start = 0; start < words.length; start += step) {
    chunks.push(words.slice(start, start + maxTokens).join(' '));
    if (start + maxTokens >= words.length) break;
  }
  return chunks;
}

function scoreChunk(queryTokens: Set<string>, content: string): number {
  const contentTokens = new Set(tokenize(content));
  if (contentTokens.size === 0) return 0;
  let hits = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) hits += 1;
  }
  return hits / Math.sqrt(queryTokens.size * contentTokens.size);
}

function tokenize(value: string): string[] {
  // Segmentation is shared (§B5.4) so non-Latin text survives; the length
  // policy stays local because chunk scoring deliberately keeps stop-words.
  return segment(value).filter((token) => isCjkToken(token) || token.length > 1);
}

async function extractImageText(bytes: Buffer, fileName: string): Promise<string> {
  const packageName = 'tesseract.js';
  try {
    const tesseract = await import(packageName) as { recognize?: (image: Buffer, language: string) => Promise<{ data?: { text?: string } }> };
    const result = tesseract.recognize ? await tesseract.recognize(bytes, 'eng') : null;
    const text = result?.data?.text?.trim() ?? '';
    if (text) return `[Image source: ${fileName}]\n${text}`;
  } catch {
    // Optional OCR dependency is intentionally absent on minimal installs.
  }
  // No OCR available — store the image as a named reference so it still
  // appears in the ability's knowledge list and can be embedded by filename.
  return `[Image: ${fileName}]`;
}

async function extractSpreadsheetText(bytes: Buffer, fileName: string): Promise<string> {
  try {
    if (fileName.toLowerCase().endsWith('.xls')) {
      throw new AgentisError('VALIDATION_FAILED', 'Legacy .xls files are not supported. Save as .xlsx or CSV before upload.');
    }
    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    const lines: string[] = [];
    workbook.eachSheet((sheet) => {
      lines.push(`[Sheet: ${sheet.name}]`);
      const headers: string[] = [];
      sheet.eachRow((row, rowNumber) => {
        const values = row.values as unknown[];
        if (rowNumber === 1) {
          for (const value of values.slice(1)) headers.push(String(value ?? '').trim());
          return;
        }
        const rendered = values.slice(1)
          .map((value, index) => `${headers[index] || `Column ${index + 1}`}: ${String(value ?? '')}`)
          .join(' | ');
        if (rendered.trim()) lines.push(rendered);
      });
    });
    return lines.join('\n').trim();
  } catch (error) {
    if (error instanceof AgentisError) throw error;
    throw new AgentisError('VALIDATION_FAILED', `Could not parse spreadsheet ${fileName}: ${(error as Error).message}`);
  }
}

function contextualPrefix(name: string, index: number, count: number, mimeType: string): string {
  return `Context: chunk ${index + 1} of ${count} from "${name}" (${mimeType || 'text/plain'}).`;
}

function inferImportance(content: string): number {
  const signal = /\b(must|critical|decision|requirement|risk|deadline|policy|failure|lesson)\b/i.test(content) ? 0.72 : 0.5;
  return signal;
}

function extractEntities(content: string): string[] {
  const values = content.match(/\b[A-Z][A-Za-z0-9-]{2,}(?:\s+[A-Z][A-Za-z0-9-]{2,}){0,2}\b/g) ?? [];
  return [...new Set(values)].slice(0, 12);
}

function ingestionType(mimeType: string): string {
  if (mimeType.startsWith('image/')) return 'image_ocr';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return 'spreadsheet';
  return 'document';
}

function parseJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
