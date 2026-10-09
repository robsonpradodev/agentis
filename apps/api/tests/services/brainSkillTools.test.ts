import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisToolContext } from '@agentis/core';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerBrainTools } from '../../src/services/agentisToolHandlers/brain.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { SharedIntelligenceService } from '../../src/services/sharedIntelligence.js';
import { MemoryStore } from '../../src/services/memory/memoryStore.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { SkillService } from '../../src/services/skillService.js';
import { KnowledgeBaseService } from '../../src/services/knowledge/knowledgeBase.js';
import { StubEmbeddingProvider } from '../_helpers/stubEmbeddingProvider.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let registry: AgentisToolRegistry;
let skills: SkillService;
let memory: MemoryStore;
let knowledge: KnowledgeBaseService;
let episodes: EpisodicMemoryStore;

function toolCtx(agentId: string | null = null): AgentisToolContext {
  return { workspaceId: ctx.workspace.id, agentId, caller: 'agent' } as unknown as AgentisToolContext;
}

beforeEach(async () => {
  ctx = await createTestContext();
  episodes = new EpisodicMemoryStore(ctx.db, ctx.logger, new StubEmbeddingProvider());
  const brain = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
  memory = new MemoryStore(ctx.db, ctx.logger);
  memory.setEpisodicStore(episodes);
  skills = new SkillService(ctx.db, memory, brain, ctx.logger);
  knowledge = new KnowledgeBaseService(ctx.db);
  registry = new AgentisToolRegistry({ logger: ctx.logger });
  registerBrainTools(registry, {
    db: ctx.db,
    logger: ctx.logger,
    sharedIntelligence: brain,
    skills,
    memory,
    episodes,
    knowledgeBases: knowledge,
  } as unknown as ToolHandlerDeps);
});

afterEach(() => ctx.close());

describe('agentis.skill.load', () => {
  it('loads a skill full body by slug and by id', async () => {
    const created = skills.upsertSkill({
      workspaceId: ctx.workspace.id, scopeId: null,
      name: 'Deploy Migrations Safely', description: 'Gate migrations behind a flag.',
      body: '# Steps\n1. Flag it.\n2. Migrate.\n3. Verify.\n',
    });

    const bySlug = await registry.execute({ toolId: 'agentis.skill.load', arguments: { skill: 'deploy-migrations-safely' } }, toolCtx());
    expect(bySlug.ok).toBe(true);
    const out = bySlug.output as { name: string; body: string; slug: string };
    expect(out.name).toBe('Deploy Migrations Safely');
    expect(out.body).toContain('Migrate');

    const byId = await registry.execute({ toolId: 'agentis.skill.load', arguments: { skill: created.id } }, toolCtx());
    expect(byId.ok).toBe(true);
  });

  it('resolves an agent-scoped skill for that agent', async () => {
    skills.upsertSkill({ workspaceId: ctx.workspace.id, scopeId: 'agent-7', name: 'Private Skill', description: '', body: 'secret steps' });
    const res = await registry.execute({ toolId: 'agentis.skill.load', arguments: { skill: 'private-skill' } }, toolCtx('agent-7'));
    expect(res.ok).toBe(true);
    expect((res.output as { body: string }).body).toBe('secret steps');
  });

  it('returns a not-found error for an unknown skill', async () => {
    const res = await registry.execute({ toolId: 'agentis.skill.load', arguments: { skill: 'nope' } }, toolCtx());
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('RESOURCE_NOT_FOUND');
    expect(res.errorMessage).toMatch(/kind:"skill"/i);
  });
});

describe('agentis.brain.search', () => {
  it('executes and excludes the skill library by default', async () => {
    skills.upsertSkill({ workspaceId: ctx.workspace.id, scopeId: null, name: 'A Skill', description: 'about widgets', body: 'x' });
    const res = await registry.execute({ toolId: 'agentis.brain.search', arguments: { query: 'widgets' } }, toolCtx());
    expect(res.ok).toBe(true);
    const out = res.output as { count: number; results: Array<{ kind: string }> };
    // Default search never surfaces skill-library atoms.
    expect(out.results.every((r) => r.kind !== 'skill' && r.kind !== 'example')).toBe(true);
  });

  it('validates that query is required', async () => {
    const res = await registry.execute({ toolId: 'agentis.brain.search', arguments: {} }, toolCtx());
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('VALIDATION_FAILED');
  });
});

describe('agentis.skill.create', () => {
  it('authors a new agent-scoped skill that is then loadable and above the materialize floor', async () => {
    const res = await registry.execute(
      {
        toolId: 'agentis.skill.create',
        arguments: {
          name: 'Onboard a WhatsApp lead',
          description: 'a new lead messages in on WhatsApp for the first time',
          body: '1. Greet.\n2. Capture name + intent.\n3. Route to the right app.',
        },
      },
      toolCtx('agent-42'),
    );
    expect(res.ok).toBe(true);
    const out = res.output as { skillId: string; slug: string; scope: string; replaced: boolean };
    expect(out.scope).toBe('agent');
    expect(out.replaced).toBe(false);
    expect(out.slug).toBe('onboard-a-whatsapp-lead');

    // Persisted with the authoring agent's scope and full body.
    const stored = skills.getSkill(ctx.workspace.id, out.skillId);
    expect(stored?.scopeId).toBe('agent-42');
    expect(stored?.body).toContain('Route to the right app');
    // Non-seed source ⇒ confidence 0.7, above the 0.3 materialize floor.
    expect(stored?.confidence ?? 0).toBeGreaterThanOrEqual(0.3);

    // Reachable through the on-demand loader for the same agent.
    const load = await registry.execute(
      { toolId: 'agentis.skill.load', arguments: { skill: 'onboard-a-whatsapp-lead' } },
      toolCtx('agent-42'),
    );
    expect(load.ok).toBe(true);
    expect((load.output as { name: string }).name).toBe('Onboard a WhatsApp lead');
  });

  it('is idempotent by slug within scope — re-creating updates and reports replaced', async () => {
    const first = await registry.execute(
      { toolId: 'agentis.skill.create', arguments: { name: 'Ship a release', description: 'cutting a release', body: 'v1 steps' } },
      toolCtx('agent-42'),
    );
    const second = await registry.execute(
      { toolId: 'agentis.skill.create', arguments: { name: 'Ship a release', description: 'cutting a release', body: 'v2 steps' } },
      toolCtx('agent-42'),
    );
    expect((second.output as { replaced: boolean }).replaced).toBe(true);
    expect((first.output as { skillId: string }).skillId).toBe((second.output as { skillId: string }).skillId);
    const stored = skills.getSkill(ctx.workspace.id, (second.output as { skillId: string }).skillId);
    expect(stored?.body).toBe('v2 steps');
  });

  it('scope:"workspace" shares the skill workspace-globally (null scope)', async () => {
    const res = await registry.execute(
      { toolId: 'agentis.skill.create', arguments: { name: 'Shared Skill', description: 'anyone can use this', body: 'steps', scope: 'workspace' } },
      toolCtx('agent-42'),
    );
    expect((res.output as { scope: string }).scope).toBe('workspace');
    const stored = skills.getSkill(ctx.workspace.id, (res.output as { skillId: string }).skillId);
    expect(stored?.scopeId).toBeNull();
    // A different agent can load a workspace-global skill.
    const load = await registry.execute({ toolId: 'agentis.skill.load', arguments: { skill: 'shared-skill' } }, toolCtx('someone-else'));
    expect(load.ok).toBe(true);
  });

  it('requires a body', async () => {
    const res = await registry.execute(
      { toolId: 'agentis.skill.create', arguments: { name: 'No body', description: 'x' } },
      toolCtx('agent-42'),
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('VALIDATION_FAILED');
  });
});

describe('specialist private Brain administration', () => {
  it('configures and verifies another specialist Brain idempotently', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Prospector',
      adapterType: 'codex',
      capabilityTags: ['research'],
      config: {},
      status: 'online',
      role: 'prospector',
    }).run();

    const configure = () => registry.execute({
      toolId: 'agentis.agent.brain.configure',
      arguments: {
        agentId,
        memories: [{ title: 'ICP boundary', content: 'Only qualify companies with a verified service area.', kind: 'rule' }],
        skills: [{
          name: 'Qualify a prospect',
          description: 'Determine whether a prospect fits the ICP.',
          body: '1. Verify geography.\n2. Verify need.\n3. Record evidence.',
        }],
        examples: [{
          skill: 'qualify-a-prospect',
          input: 'A local clinic requests lead generation.',
          output: 'Qualified after geography and need are verified.',
        }],
      },
    }, toolCtx());

    const first = await configure();
    expect(first.ok).toBe(true);
    const firstVerification = (first.output as { verification: { counts: Record<string, number> } }).verification;
    expect(firstVerification.counts.memories).toBe(1);
    expect(firstVerification.counts.skills).toBe(1);
    expect(firstVerification.counts.examples).toBe(1);

    const second = await configure();
    expect(second.ok).toBe(true);
    const inspect = await registry.execute({
      toolId: 'agentis.agent.brain.inspect',
      arguments: { agentId },
    }, toolCtx());
    expect(inspect.ok).toBe(true);
    const counts = (inspect.output as { counts: Record<string, number> }).counts;
    expect(counts.memories).toBe(1);
    expect(counts.skills).toBe(1);
    expect(counts.examples).toBe(1);
  });

  it('rejects cross-workspace or missing specialist targets', async () => {
    const result = await registry.execute({
      toolId: 'agentis.agent.brain.configure',
      arguments: { agentId: randomUUID(), memories: [{ title: 'x', content: 'y' }] },
    }, toolCtx());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('RESOURCE_NOT_FOUND');
  });

  it('previews and selectively archives a legacy Brain without deleting the agent', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Ava Attendant',
      adapterType: 'hermes_agent',
      capabilityTags: ['whatsapp'],
      config: {},
      status: 'online',
      role: 'attendant',
    }).run();

    const canonicalMemoryId = memory.write({
      workspaceId: ctx.workspace.id,
      scopeId: agentId,
      kind: 'rule',
      source: 'operator',
      title: 'Canonical commercial precedence',
      content: 'The Acme master prompt is authoritative.',
    });
    memory.write({
      workspaceId: ctx.workspace.id,
      scopeId: agentId,
      kind: 'rule',
      source: 'operator',
      title: 'Core v5 legacy pricing',
      content: 'Offer the old R$397 plan.',
    });
    const legacySkill = skills.upsertSkill({
      workspaceId: ctx.workspace.id,
      scopeId: agentId,
      name: 'Legacy sales script',
      description: 'Old opening and pricing.',
      body: 'Quote R$397.',
    });
    skills.promoteExample({
      workspaceId: ctx.workspace.id,
      skillId: legacySkill.id,
      inputText: 'Quanto custa?',
      outputText: 'R$397.',
      source: 'operator',
    });
    const base = knowledge.createKnowledgeBase({ workspaceId: ctx.workspace.id, scopeId: agentId, name: 'Ava private knowledge' });
    const master = await knowledge.addDocument({
      workspaceId: ctx.workspace.id,
      knowledgeBaseId: base.id,
      name: 'ACME COMMERCIAL — MASTER SYSTEM PROMPT.md',
      content: 'Canonical Acme commercial policy.',
    });
    await knowledge.addDocument({
      workspaceId: ctx.workspace.id,
      knowledgeBaseId: base.id,
      name: 'Legacy commercial notes.md',
      content: 'Conflicting old prices.',
    });
    episodes.write({
      workspaceId: ctx.workspace.id,
      scopeId: agentId,
      agentId,
      type: 'failure',
      source: 'system_write',
      title: 'Failure lessons',
      summary: 'Legacy runtime lesson that should not survive a keep-only reset.',
    });

    const keep = {
      memoryIds: [canonicalMemoryId],
      knowledgeIds: [master.id],
      skillIds: [],
      exampleIds: [],
      episodeIds: [],
    };
    const preview = await registry.execute({
      toolId: 'agentis.agent.brain.prune',
      arguments: { agentId, keep },
    }, toolCtx());
    expect(preview.ok).toBe(true);
    const previewOutput = preview.output as {
      applied: boolean;
      confirmationToken: string;
      counts: Record<string, number>;
    };
    expect(previewOutput.applied).toBe(false);
    expect(previewOutput.counts).toMatchObject({ memories: 1, knowledge: 1, skills: 1, examples: 1, episodes: 1 });

    const stillIntact = await registry.execute({
      toolId: 'agentis.agent.brain.inspect',
      arguments: { agentId },
    }, toolCtx());
    expect((stillIntact.output as { counts: Record<string, number> }).counts)
      .toMatchObject({ memories: 2, knowledge: 2, skills: 1, examples: 1, episodes: 1 });

    const applied = await registry.execute({
      toolId: 'agentis.agent.brain.prune',
      arguments: { agentId, keep, confirmationToken: previewOutput.confirmationToken },
    }, toolCtx());
    expect(applied.ok).toBe(true);
    const output = applied.output as {
      applied: boolean;
      verification: { counts: Record<string, number>; memories: Array<{ id: string }>; knowledge: Array<{ id: string }> };
    };
    expect(output.applied).toBe(true);
    expect(output.verification.counts).toMatchObject({ memories: 1, knowledge: 1, skills: 0, examples: 0, episodes: 0 });
    expect(output.verification.memories.map((item) => item.id)).toEqual([canonicalMemoryId]);
    expect(output.verification.knowledge.map((item) => item.id)).toEqual([master.id]);
    expect(ctx.db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.id, agentId)).get()?.id).toBe(agentId);
  });

  it('rejects a stale prune token before changing the Brain', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Mutable Brain',
      adapterType: 'codex',
      capabilityTags: [],
      config: {},
      status: 'online',
      role: 'specialist',
    }).run();
    memory.write({ workspaceId: ctx.workspace.id, scopeId: agentId, kind: 'rule', source: 'operator', title: 'Old', content: 'old' });
    const keep = { memoryIds: [], knowledgeIds: [], skillIds: [], exampleIds: [], episodeIds: [] };
    const preview = await registry.execute({ toolId: 'agentis.agent.brain.prune', arguments: { agentId, keep } }, toolCtx());
    const token = (preview.output as { confirmationToken: string }).confirmationToken;
    memory.write({ workspaceId: ctx.workspace.id, scopeId: agentId, kind: 'rule', source: 'operator', title: 'New', content: 'new' });

    const apply = await registry.execute({
      toolId: 'agentis.agent.brain.prune',
      arguments: { agentId, keep, confirmationToken: token },
    }, toolCtx());
    expect(apply.ok).toBe(false);
    expect(apply.errorCode).toBe('VALIDATION_FAILED');
    const inspect = await registry.execute({ toolId: 'agentis.agent.brain.inspect', arguments: { agentId } }, toolCtx());
    expect((inspect.output as { counts: { memories: number } }).counts.memories).toBe(2);
  });
});
