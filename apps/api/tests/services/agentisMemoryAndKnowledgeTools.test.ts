import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerInspectTools } from '../../src/services/agentisToolHandlers/inspect.js';
import { registerRunTools } from '../../src/services/agentisToolHandlers/run.js';
import { MemoryStore } from '../../src/services/memory/memoryStore.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => ctx.close());

function deps(): ToolHandlerDeps {
  return {
    db: ctx.db,
    logger: ctx.logger,
    bus: ctx.bus,
    engine: {} as ToolHandlerDeps['engine'],
    adapters: {} as ToolHandlerDeps['adapters'],
    ledger: { listForRun: async () => [] } as unknown as ToolHandlerDeps['ledger'],
    scratchpad: {} as ToolHandlerDeps['scratchpad'],
    approvals: { list: () => [] } as unknown as ToolHandlerDeps['approvals'],
    activity: {} as ToolHandlerDeps['activity'],
    replay: {} as ToolHandlerDeps['replay'],
    // §B4 — the memory tools write/read/delete through the unified MemoryStore
    // facade; the real store runs fine on the in-memory test db.
    memory: new MemoryStore(ctx.db, ctx.logger),
    knowledgeBases: {
      listKnowledgeBases: () => [{ id: 'default_kb', name: 'Default KB' }],
      addDocument: async (args: any) => ({ id: 'doc_123', name: args.name, chunks: 1 }),
      archiveDocument: (wsId: any, kbId: any, docId: any) => ({ id: docId, archived: true }),
      deleteDocument: (wsId: any, kbId: any, docId: any) => ({ id: docId, deleted: true }),
      deleteKnowledgeBase: (wsId: any, kbId: any) => ({ id: kbId, deleted: true }),
    } as unknown as ToolHandlerDeps['knowledgeBases'],
  };
}

function toolContext() {
  return {
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    caller: 'test',
  };
}

describe('agentis memory and knowledge native tools', () => {
  it('performs full write, read, and delete flow for memory', async () => {
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerInspectTools(registry, deps());
    registerRunTools(registry, deps());

    // 1. Write Memory
    const writeResult = await registry.execute({
      toolId: 'agentis.memory.write',
      arguments: {
        title: 'The rule of lorem',
        content: 'Never reference lorem ipsum in workspace outputs.',
        kind: 'rule',
        importance: '8',
        tags: '["workflow", "safety"]',
      },
    }, toolContext());

    expect(writeResult.ok).toBe(true);
    const writeOutput = writeResult.output as { id: string; title: string; kind: string };
    expect(writeOutput.title).toBe('The rule of lorem');
    expect(writeOutput.kind).toBe('rule');
    expect(writeOutput.id).toBeDefined();

    // 2. Read Memory
    const readResult = await registry.execute({
      toolId: 'agentis.memory.read',
      arguments: { query: 'lorem' },
    }, toolContext());

    expect(readResult.ok).toBe(true);
    const readOutput = readResult.output as { memories: Array<{ id: string; title: string }> };
    expect(readOutput.memories).toHaveLength(1);
    expect(readOutput.memories[0].id).toBe(writeOutput.id);
    expect(readOutput.memories[0].title).toBe('The rule of lorem');

    // 3. Delete Memory
    const deleteResult = await registry.execute({
      toolId: 'agentis.memory.delete',
      arguments: { id: writeOutput.id },
    }, toolContext());

    expect(deleteResult.ok).toBe(true);
    expect(deleteResult.output).toEqual({ id: writeOutput.id, deleted: true });

    // 4. Verify Deleted
    const readAgainResult = await registry.execute({
      toolId: 'agentis.memory.read',
      arguments: { query: 'lorem' },
    }, toolContext());

    expect(readAgainResult.ok).toBe(true);
    const readAgainOutput = readAgainResult.output as { memories: Array<{ id: string }> };
    expect(readAgainOutput.memories).toHaveLength(0);
  });

  it('performs write and archive flow for knowledge bases', async () => {
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerInspectTools(registry, deps());
    registerRunTools(registry, deps());

    // 1. Write Knowledge
    const writeResult = await registry.execute({
      toolId: 'agentis.knowledge.write',
      arguments: {
        title: 'Architecture details',
        content: 'Agentis is an agent platform designed in May 2026.',
        tags: '["arch"]',
      },
    }, toolContext());

    expect(writeResult.ok).toBe(true);
    const writeOutput = writeResult.output as { id: string; name: string };
    expect(writeOutput.name).toBe('Architecture details');
    expect(writeOutput.id).toBe('doc_123');

    // 2. Archive Knowledge
    const archiveResult = await registry.execute({
      toolId: 'agentis.knowledge.archive',
      arguments: {
        documentId: writeOutput.id,
        knowledgeBaseId: 'default_kb',
      },
    }, toolContext());

    expect(archiveResult.ok).toBe(true);
    expect(archiveResult.output).toEqual({ id: writeOutput.id, archived: true });
  });

  it('permanently deletes knowledge documents in a batch and whole knowledge bases', async () => {
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerRunTools(registry, deps());

    const deleteDocuments = await registry.execute({
      toolId: 'agentis.knowledge.delete',
      arguments: { knowledgeBaseId: 'default_kb', documentIds: ['doc_1', 'doc_2', 'doc_1'] },
    }, toolContext());
    expect(deleteDocuments.ok).toBe(true);
    expect(deleteDocuments.output).toEqual({
      knowledgeBaseId: 'default_kb',
      deleted: [{ id: 'doc_1', deleted: true }, { id: 'doc_2', deleted: true }],
      count: 2,
    });

    const deleteBase = await registry.execute({
      toolId: 'agentis.knowledge_base.delete',
      arguments: { knowledgeBaseId: 'default_kb' },
    }, toolContext());
    expect(deleteBase.ok).toBe(true);
    expect(deleteBase.output).toEqual({ id: 'default_kb', deleted: true });
  });
});
