/**
 * Brain tool family — agent-initiated recall (the PULL complement to the
 * automatic dispatch-context injection).
 *
 * The dispatch context PUSHES a pre-computed set of relevant atoms at the start
 * of a turn — before the agent has reasoned about the task. `agentis.brain.search`
 * lets the agent PULL from its Brain mid-task instead: durable memories, workspace
 * knowledge, and (opt-in) its Skill library. This is the fix for blind
 * pre-reasoning injection — the agent decides what it needs.
 *
 * `agentis.skill.load` returns a Skill's full SKILL.md body on demand (progressive
 * disclosure): the short description is discoverable via search / the materialized
 * skills; the whole procedure loads only when the agent commits to applying it.
 */

import { createHash } from 'node:crypto';
import { AgentisError, type AgentisToolContext, type KnowledgeAtomKind } from '@agentis/core';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

/** Agent-facing search facets → the underlying Brain atom kinds. */
const SEARCH_KINDS = ['memory', 'knowledge', 'skill', 'example', 'all'] as const;
type SearchKind = (typeof SEARCH_KINDS)[number];

const FACET_TO_ATOM_KINDS: Record<Exclude<SearchKind, 'all'>, KnowledgeAtomKind[]> = {
  memory: ['episode', 'pattern'],
  knowledge: ['knowledge_chunk', 'kb_chunk'],
  skill: ['skill'],
  example: ['example'],
};

function requireStr(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentisError('VALIDATION_FAILED', `'${name}' must be a non-empty string`);
  }
  return value.trim();
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

function snippet(text: string, max = 300): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function requireAgent(deps: ToolHandlerDeps, workspaceId: string, value: unknown): string {
  const agentId = requireStr(value, 'agentId');
  const row = deps.db.select({ id: schema.agents.id }).from(schema.agents)
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.workspaceId, workspaceId))).get();
  if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `agent ${agentId} not found in this workspace`);
  return row.id;
}

function inspectAgentBrain(deps: ToolHandlerDeps, ctx: AgentisToolContext, agentId: string) {
  const memories = deps.memory?.list({ workspaceId: ctx.workspaceId, scopeId: agentId, limit: 500 }) ?? [];
  const skills = deps.skills?.listForScopes(ctx.workspaceId, [agentId]) ?? [];
  const examples = (deps.skills?.listExamples(ctx.workspaceId) ?? []).filter((item) => item.scopeId === agentId);
  const categorizedIds = new Set([...memories, ...skills, ...examples].map((item) => item.id));
  const episodes = (deps.episodes?.list({ workspaceId: ctx.workspaceId, scopeId: agentId, limit: 500 }) ?? [])
    .filter((item) => !categorizedIds.has(item.id));
  const knowledgeBases = deps.knowledgeBases?.listKnowledgeBases(ctx.workspaceId, { scopeId: agentId }) ?? [];
  const knowledge = knowledgeBases.flatMap((base) =>
    (deps.knowledgeBases?.listDocuments(ctx.workspaceId, base.id) ?? []).map((doc) => ({
      id: doc.id,
      title: doc.name,
      status: doc.status,
      knowledgeBaseId: base.id,
    })));
  return {
    agentId,
    counts: {
      memories: memories.length,
      knowledge: knowledge.length,
      skills: skills.length,
      examples: examples.length,
      episodes: episodes.length,
    },
    memories: memories.map((item) => ({ id: item.id, title: item.title, kind: item.kind, preview: snippet(item.content, 500) })),
    knowledge,
    skills: skills.map((item) => ({
      id: item.id,
      slug: item.slug,
      name: item.name,
      confidence: item.confidence,
      description: snippet(item.description, 500),
    })),
    examples: examples.map((item) => ({ id: item.id, title: item.title, preview: snippet(item.content, 500) })),
    episodes: episodes.map((item) => ({
      id: item.id,
      title: item.title,
      type: item.type,
      source: item.source,
      preview: snippet(`${item.summary}\n${item.details ?? ''}`, 500),
    })),
  };
}

type BrainInventory = ReturnType<typeof inspectAgentBrain>;
type BrainKeepSelection = {
  memoryIds: string[];
  knowledgeIds: string[];
  skillIds: string[];
  exampleIds: string[];
  episodeIds: string[];
};

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new AgentisError('VALIDATION_FAILED', `'${name}' must be an array of non-empty ids`);
  }
  return [...new Set(value.map((item) => String(item).trim()))].sort();
}

function brainKeepSelection(value: unknown): BrainKeepSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentisError('VALIDATION_FAILED', "'keep' must identify the exact Brain atom ids to preserve");
  }
  const keep = value as Record<string, unknown>;
  return {
    memoryIds: stringArray(keep.memoryIds, 'keep.memoryIds'),
    knowledgeIds: stringArray(keep.knowledgeIds, 'keep.knowledgeIds'),
    skillIds: stringArray(keep.skillIds, 'keep.skillIds'),
    exampleIds: stringArray(keep.exampleIds, 'keep.exampleIds'),
    episodeIds: stringArray(keep.episodeIds, 'keep.episodeIds'),
  };
}

function validateBrainKeepSelection(inventory: BrainInventory, keep: BrainKeepSelection): void {
  const groups: Array<[keyof BrainKeepSelection, Array<{ id: string }>]> = [
    ['memoryIds', inventory.memories],
    ['knowledgeIds', inventory.knowledge],
    ['skillIds', inventory.skills],
    ['exampleIds', inventory.examples],
    ['episodeIds', inventory.episodes],
  ];
  for (const [key, records] of groups) {
    const available = new Set(records.map((item) => item.id));
    const unknown = keep[key].filter((id) => !available.has(id));
    if (unknown.length > 0) {
      throw new AgentisError(
        'VALIDATION_FAILED',
        `${key} contains ids that are not active in this agent Brain: ${unknown.join(', ')}. Inspect again and use exact ids.`,
      );
    }
  }
}

function brainPrunePlan(inventory: BrainInventory, keep: BrainKeepSelection) {
  const memoryIds = new Set(keep.memoryIds);
  const knowledgeIds = new Set(keep.knowledgeIds);
  const skillIds = new Set(keep.skillIds);
  const exampleIds = new Set(keep.exampleIds);
  const episodeIds = new Set(keep.episodeIds);
  return {
    memories: inventory.memories.filter((item) => !memoryIds.has(item.id)),
    knowledge: inventory.knowledge.filter((item) => !knowledgeIds.has(item.id)),
    skills: inventory.skills.filter((item) => !skillIds.has(item.id)),
    examples: inventory.examples.filter((item) => !exampleIds.has(item.id)),
    episodes: inventory.episodes.filter((item) => !episodeIds.has(item.id)),
  };
}

function brainPruneToken(agentId: string, keep: BrainKeepSelection, plan: ReturnType<typeof brainPrunePlan>): string {
  const candidates = {
    memories: plan.memories.map((item) => item.id).sort(),
    knowledge: plan.knowledge.map((item) => item.id).sort(),
    skills: plan.skills.map((item) => item.id).sort(),
    examples: plan.examples.map((item) => item.id).sort(),
    episodes: plan.episodes.map((item) => item.id).sort(),
  };
  return createHash('sha256')
    .update(JSON.stringify({ operation: 'agent-brain-prune-v1', agentId, keep, candidates }))
    .digest('hex');
}

export function registerBrainTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.agent.brain.inspect',
        family: 'inspect',
        mcpExposed: true,
        description: 'Inspect one specialist private Brain across Memory, Knowledge, Skills, and Examples, including ids and safe content previews. Use after configuring a specialist and before selective cleanup with agentis.agent.brain.prune; do not claim completion until the requested state is visible here.',
        inputSchema: {
          type: 'object',
          properties: { agentId: { type: 'string' } },
          required: ['agentId'],
        },
        mutating: false,
      },
      handler: (args, ctx) => inspectAgentBrain(deps, ctx, requireAgent(deps, ctx.workspaceId, args.agentId)),
    },
    {
      definition: {
        id: 'agentis.agent.brain.prune',
        family: 'build',
        mcpExposed: true,
        description:
          'Safely reset a target specialist private Brain without deleting the Agent or its Connections. Preserve exact atom ids in keep and archive every other private Memory, runtime Episode, Knowledge document, Skill, and Example. Call once without confirmationToken to receive a complete preview and token; then call again with that unchanged token to apply. Archived content is excluded from recall but remains recoverable. If the Brain changes, the token is rejected and a fresh preview is required.',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: { type: 'string' },
            keep: {
              type: 'object',
              properties: {
                memoryIds: { type: 'array', items: { type: 'string' } },
                knowledgeIds: { type: 'array', items: { type: 'string' } },
                skillIds: { type: 'array', items: { type: 'string' } },
                exampleIds: { type: 'array', items: { type: 'string' } },
                episodeIds: { type: 'array', items: { type: 'string' } },
              },
            },
            confirmationToken: {
              type: 'string',
              description: 'Exact token returned by the immediately preceding preview for the same keep selection.',
            },
          },
          required: ['agentId', 'keep'],
        },
        mutating: true,
        mutationBehavior: 'local',
        approval: { riskLevel: 'medium', reversible: true, externalSideEffects: false },
        autoExecute: true,
      },
      handler: (args, ctx) => {
        const agentId = requireAgent(deps, ctx.workspaceId, args.agentId);
        if (!deps.sharedIntelligence || !deps.knowledgeBases) {
          throw new AgentisError('VALIDATION_FAILED', 'Brain archive services are not available');
        }
        const keep = brainKeepSelection(args.keep);
        const before = inspectAgentBrain(deps, ctx, agentId);
        validateBrainKeepSelection(before, keep);
        const plan = brainPrunePlan(before, keep);
        const confirmationToken = brainPruneToken(agentId, keep, plan);
        const counts = {
          memories: plan.memories.length,
          knowledge: plan.knowledge.length,
          skills: plan.skills.length,
          examples: plan.examples.length,
          episodes: plan.episodes.length,
        };

        if (args.confirmationToken === undefined) {
          return {
            applied: false,
            agentId,
            keep,
            archive: plan,
            counts,
            confirmationToken,
            nextAction: 'Review archive candidates, then call this tool again with the same keep selection and confirmationToken.',
          };
        }
        if (typeof args.confirmationToken !== 'string' || args.confirmationToken !== confirmationToken) {
          throw new AgentisError(
            'VALIDATION_FAILED',
            'The Brain changed or the confirmation token does not match this exact prune plan. Inspect and preview again; nothing was archived.',
          );
        }
        if (plan.episodes.length > 0 && !deps.episodes) {
          throw new AgentisError('VALIDATION_FAILED', 'Runtime episode archive service is not available; nothing was archived');
        }

        const archived = {
          memories: [] as string[], knowledge: [] as string[], skills: [] as string[],
          examples: [] as string[], episodes: [] as string[],
        };
        for (const item of plan.examples) {
          if (deps.sharedIntelligence.archiveAtom(ctx.workspaceId, 'example', item.id, { scopeId: agentId })) archived.examples.push(item.id);
        }
        for (const item of plan.skills) {
          if (deps.sharedIntelligence.archiveAtom(ctx.workspaceId, 'skill', item.id, { scopeId: agentId })) archived.skills.push(item.id);
        }
        for (const item of plan.memories) {
          if (deps.sharedIntelligence.archiveAtom(ctx.workspaceId, 'memory', item.id, { scopeId: agentId })) archived.memories.push(item.id);
        }
        for (const item of plan.episodes) {
          if (deps.episodes?.archive(ctx.workspaceId, item.id)) archived.episodes.push(item.id);
        }
        for (const item of plan.knowledge) {
          deps.knowledgeBases.archiveDocument(ctx.workspaceId, item.knowledgeBaseId, item.id);
          archived.knowledge.push(item.id);
        }
        const materialized = deps.skillMaterializer?.materializeForAgent(ctx.workspaceId, agentId).materialized.length ?? null;
        const verification = inspectAgentBrain(deps, ctx, agentId);
        return {
          applied: true,
          agentId,
          archived,
          materializedSkills: materialized,
          verification,
        };
      },
    },
    {
      definition: {
        id: 'agentis.agent.brain.configure',
        family: 'build',
        mcpExposed: true,
        description:
          'Author or update a target specialist private Brain in one idempotent batch: durable memories, scoped knowledge documents, Living Skills, and worked examples. This is cross-agent administration; all content is stored under agentId, never the App/workspace Brain.',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: { type: 'string' },
            memories: { type: 'array', items: { type: 'object' } },
            knowledge: { type: 'array', items: { type: 'object' } },
            skills: { type: 'array', items: { type: 'object' } },
            examples: { type: 'array', items: { type: 'object' } },
          },
          required: ['agentId'],
        },
        mutating: true,
        autoExecute: true,
      },
      handler: async (args, ctx) => {
        const agentId = requireAgent(deps, ctx.workspaceId, args.agentId);
        if (!deps.memory || !deps.skills) throw new AgentisError('VALIDATION_FAILED', 'Brain memory and skills are not available');
        const results = { memories: [] as string[], knowledge: [] as string[], skills: [] as string[], examples: [] as string[] };
        for (const item of records(args.memories)) {
          const title = requireStr(item.title, 'memories[].title');
          const content = requireStr(item.content, 'memories[].content');
          const existing = deps.memory.list({ workspaceId: ctx.workspaceId, scopeId: agentId, limit: 500 })
            .find((row) => row.title.trim().toLowerCase() === title.toLowerCase());
          if (existing) {
            deps.memory.update(ctx.workspaceId, agentId, existing.id, { content });
            results.memories.push(existing.id);
          } else {
            results.memories.push(deps.memory.write({
              workspaceId: ctx.workspaceId,
              scopeId: agentId,
              kind: String(item.kind ?? 'rule') as 'rule',
              source: 'operator',
              title,
              content,
              trust: 0.9,
              importance: Number(item.importance ?? 0.8),
              tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
            }));
          }
        }
        const createdSkills = new Map<string, string>();
        for (const item of records(args.skills)) {
          const saved = deps.skills.upsertSkill({
            workspaceId: ctx.workspaceId,
            scopeId: agentId,
            name: requireStr(item.name, 'skills[].name'),
            description: requireStr(item.description, 'skills[].description'),
            body: requireStr(item.body, 'skills[].body'),
            source: 'agent',
            ...(typeof item.slug === 'string' ? { slug: item.slug } : {}),
          });
          createdSkills.set(saved.slug, saved.id);
          createdSkills.set(saved.name.toLowerCase(), saved.id);
          results.skills.push(saved.id);
        }
        if (records(args.knowledge).length > 0) {
          if (!deps.knowledgeBases) throw new AgentisError('VALIDATION_FAILED', 'knowledge bases are not available');
          const base = deps.knowledgeBases.listKnowledgeBases(ctx.workspaceId, { scopeId: agentId })
            .find((row) => row.scopeId === agentId)
            ?? deps.knowledgeBases.createKnowledgeBase({ workspaceId: ctx.workspaceId, scopeId: agentId, name: 'Private specialist knowledge' });
          const existingDocs = deps.knowledgeBases.listDocuments(ctx.workspaceId, base.id);
          for (const item of records(args.knowledge)) {
            const title = requireStr(item.title, 'knowledge[].title');
            const existing = existingDocs.find((doc) => doc.name.trim().toLowerCase() === title.toLowerCase());
            if (existing) { results.knowledge.push(existing.id); continue; }
            const doc = await deps.knowledgeBases.addDocument({
              workspaceId: ctx.workspaceId,
              knowledgeBaseId: base.id,
              name: title,
              content: requireStr(item.content, 'knowledge[].content'),
            });
            results.knowledge.push(doc.id);
          }
        }
        for (const item of records(args.examples)) {
          const ref = requireStr(item.skill, 'examples[].skill');
          const skillId = createdSkills.get(ref) ?? createdSkills.get(ref.toLowerCase())
            ?? deps.skills.getByScopeAndSlug(ctx.workspaceId, agentId, ref)?.id;
          if (!skillId) throw new AgentisError('RESOURCE_NOT_FOUND', `private skill "${ref}" not found for target agent`);
          const inputText = requireStr(item.input, 'examples[].input');
          const outputText = requireStr(item.output, 'examples[].output');
          const expectedContent = `Task: ${inputText.slice(0, 4000)}\nResponse: ${outputText.slice(0, 8000)}`;
          const existing = deps.skills.listLinkedExamples(ctx.workspaceId, skillId, 100)
            .find((example) => example.content === expectedContent);
          if (existing) {
            results.examples.push(existing.id);
            continue;
          }
          const id = deps.skills.promoteExample({
            workspaceId: ctx.workspaceId,
            skillId,
            inputText,
            outputText,
            source: 'agent',
          });
          if (id) results.examples.push(id);
        }
        const materialized = deps.skillMaterializer?.materializeForAgent(ctx.workspaceId, agentId).materialized.length ?? 0;
        return { configured: true, agentId, results, materialized, verification: inspectAgentBrain(deps, ctx, agentId) };
      },
    },
    {
      definition: {
        id: 'agentis.brain.search',
        family: 'run',
        description:
          'Search YOUR Brain by meaning, mid-task — durable memories, workspace knowledge, and (on request) your Skill library. Use it when you need a fact, rule, or procedure you were not handed at the start of the turn, instead of guessing. Especially useful after a PRE-TASK MEMORY note says nothing matched: that upfront pass can miss things a targeted re-query with different or broader terms finds — try again before concluding it doesn\'t exist. Returns ranked atoms ({ id, kind, title, snippet, score }). Skills/examples are EXCLUDED by default (they are reached on demand); pass kind:"skill" (or "example"/"all") to include them, then read a skill\'s full procedure with agentis.skill.load. Prefer short keyword-first queries. Example: {"query":"deploy migrations safely","kind":"skill"}.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What you are looking for (natural language or keywords).' },
            kind: {
              type: 'string',
              enum: [...SEARCH_KINDS],
              description:
                'Restrict the search. Omit to search durable memory + knowledge (the skill library is excluded). Use "skill"/"example" to search the skill library, or "all" for everything.',
            },
            limit: { type: 'number', description: 'Max results (1–20, default 6).' },
          },
          required: ['query'],
        },
        mutating: false,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: async (args: Record<string, unknown>, ctx: AgentisToolContext) => {
        if (!deps.sharedIntelligence) {
          throw new AgentisError('VALIDATION_FAILED', 'brain search is not available in this workspace');
        }
        const query = requireStr(args.query, 'query');
        const limit = clampLimit(args.limit, 6, 20);
        const facet = (typeof args.kind === 'string' && (SEARCH_KINDS as readonly string[]).includes(args.kind)
          ? args.kind
          : null) as SearchKind | null;
        // An agent searches the union of its OWN brain scope + workspace-shared,
        // under team RLS (its private atoms + shared, never another scope's private).
        const scopeId = ctx.agentId ?? null;
        const hits = await deps.sharedIntelligence.searchAtoms({
          workspaceId: ctx.workspaceId,
          scopeId,
          query,
          scope: scopeId ? 'both' : 'workspace',
          limit,
          requesterScopeId: scopeId,
          // Facet → kinds allowlist. No facet ⇒ default (skill library excluded).
          // "all" ⇒ clear the default exclusion so skills/examples surface too.
          ...(facet && facet !== 'all' ? { kinds: FACET_TO_ATOM_KINDS[facet] } : {}),
          ...(facet === 'all' ? { excludeKinds: [] } : {}),
        });
        return {
          count: hits.length,
          results: hits.map((h) => ({
            id: h.id,
            kind: h.kind,
            title: h.title,
            snippet: snippet(h.content),
            score: Math.round(h.score * 100) / 100,
            confidence: Math.round(h.confidence * 100) / 100,
          })),
        };
      },
    },
    {
      definition: {
        id: 'agentis.skill.load',
        family: 'run',
        description:
          "Load a Skill's full procedure (its SKILL.md body) by id or slug. Only pass a result returned by agentis.brain.search with kind:\"skill\"; knowledge and memory ids are not skills. The short description is discoverable via agentis.brain.search({kind:\"skill\"}) or from your materialized skills. Returns { id, slug, name, description, body, confidence }. Example: {\"skill\":\"deploy-migrations-safely\"}.",
        inputSchema: {
          type: 'object',
          properties: {
            skill: { type: 'string', description: 'Skill id or slug.' },
          },
          required: ['skill'],
        },
        mutating: false,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: (args: Record<string, unknown>, ctx: AgentisToolContext) => {
        if (!deps.skills) {
          throw new AgentisError('VALIDATION_FAILED', 'skills are not available in this workspace');
        }
        const ref = requireStr(args.skill, 'skill');
        // Resolve by id first, then by slug within the agent's scope, then global.
        const found =
          deps.skills.getSkill(ctx.workspaceId, ref)
          ?? deps.skills.getByScopeAndSlug(ctx.workspaceId, ctx.agentId ?? null, ref)
          ?? deps.skills.getByScopeAndSlug(ctx.workspaceId, null, ref);
        if (!found) {
          const available = deps.skills
            .listForScopes(ctx.workspaceId, [ctx.agentId ?? null, null])
            .slice(0, 8)
            .map((skill) => skill.slug);
          const suggestions = available.length > 0 ? ` Available skill slugs: ${available.join(', ')}.` : '';
          throw new AgentisError(
            'RESOURCE_NOT_FOUND',
            `skill "${ref}" not found. Search agentis.brain.search with kind:"skill" and pass an exact returned id or slug; do not pass a knowledge or memory id.${suggestions}`,
          );
        }
        // Loading a skill = committing to it. Attribute it to the run so the run's
        // verdict later moves the skill's confidence (Living Skills metabolism).
        deps.skills.recordUsage({
          workspaceId: ctx.workspaceId,
          skillId: found.id,
          runId: ctx.runId ?? null,
          agentId: ctx.agentId ?? null,
          scopeId: ctx.agentId ?? null,
        });
        // The metabolism rides along: worked examples + hard-won lessons.
        const examples = deps.skills.listLinkedExamples(ctx.workspaceId, found.id, 4).map((e) => e.content);
        const lessons = deps.skills.listLinkedLessons(ctx.workspaceId, found.id, 4).map((l) => l.content);
        return {
          id: found.id,
          slug: found.slug,
          name: found.name,
          description: found.description,
          body: found.body,
          confidence: Math.round(found.confidence * 100) / 100,
          ...(examples.length ? { examples } : {}),
          ...(lessons.length ? { lessons } : {}),
        };
      },
    },
    {
      definition: {
        id: 'agentis.skill.promote_example',
        family: 'run',
        description:
          "Save a worked input→output pair as an EXAMPLE of a skill done right — its demonstration set grows from real wins and rides along the next time the skill is loaded. Use after a skill produced a genuinely good result worth teaching. Returns { exampleId }. Example: {\"skill\":\"deploy-migrations-safely\",\"input\":\"ship column add\",\"output\":\"flagged, migrated, verified, flipped\"}.",
        inputSchema: {
          type: 'object',
          properties: {
            skill: { type: 'string', description: 'Skill id or slug the example demonstrates.' },
            input: { type: 'string', description: 'The task/input the skill handled.' },
            output: { type: 'string', description: 'The good result the skill produced.' },
          },
          required: ['skill', 'input', 'output'],
        },
        mutating: true,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: (args: Record<string, unknown>, ctx: AgentisToolContext) => {
        if (!deps.skills) {
          throw new AgentisError('VALIDATION_FAILED', 'skills are not available in this workspace');
        }
        const ref = requireStr(args.skill, 'skill');
        const inputText = requireStr(args.input, 'input');
        const outputText = requireStr(args.output, 'output');
        const skill =
          deps.skills.getSkill(ctx.workspaceId, ref)
          ?? deps.skills.getByScopeAndSlug(ctx.workspaceId, ctx.agentId ?? null, ref)
          ?? deps.skills.getByScopeAndSlug(ctx.workspaceId, null, ref);
        if (!skill) {
          throw new AgentisError('RESOURCE_NOT_FOUND', `skill "${ref}" not found in this workspace`);
        }
        const exampleId = deps.skills.promoteExample({
          workspaceId: ctx.workspaceId,
          skillId: skill.id,
          inputText,
          outputText,
          source: 'agent',
        });
        return { exampleId, skillId: skill.id };
      },
    },
    {
      definition: {
        id: 'agentis.skill.create',
        family: 'run',
        description:
          'Author a durable, reusable SKILL — a procedure you worked out that should be recalled and applied again, by you or a peer, instead of re-derived. Use this the moment you land a repeatable way of doing something (a deploy sequence, a data-cleaning recipe, a channel-onboarding flow). The `description` is the short trigger the Brain matches on for recall — write it as WHEN to reach for this skill; `body` is the full SKILL.md procedure loaded on demand via agentis.skill.load. Idempotent by slug within its scope: creating with an existing name/slug UPDATES that skill. Scope "agent" (default) keeps it private to you; "workspace" shares it with every agent here. Returns { skillId, slug, scope, replaced }. Example: {"name":"Deploy migrations safely","description":"shipping a DB schema change to production","body":"1. Flag the column...\\n2. Migrate...\\n3. Verify...\\n4. Flip the read path"}.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Human name for the skill (also the default slug).' },
            description: {
              type: 'string',
              description: 'The short recall trigger — WHEN to use this skill. This is what the Brain matches against, so make it about the situation, not the steps.',
            },
            body: { type: 'string', description: 'The full procedure (SKILL.md markdown body).' },
            scope: {
              type: 'string',
              enum: ['agent', 'workspace'],
              description: 'Who can recall it: "agent" (default) = private to you; "workspace" = shared with every agent here.',
            },
            slug: { type: 'string', description: 'Optional stable slug for idempotent updates. Defaults to a slug of the name.' },
            agentId: { type: 'string', description: 'Target specialist Brain. Omit to use the calling agent.' },
          },
          required: ['name', 'description', 'body'],
        },
        mutating: true,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: (args: Record<string, unknown>, ctx: AgentisToolContext) => {
        if (!deps.skills) {
          throw new AgentisError('VALIDATION_FAILED', 'skills are not available in this workspace');
        }
        const name = requireStr(args.name, 'name');
        const description = requireStr(args.description, 'description');
        const body = requireStr(args.body, 'body');
        // "agent" scopes the skill to the authoring agent's Brain; "workspace"
        // shares it. Absent an agent identity, "agent" degrades to workspace-global
        // (a null scope) rather than silently dropping the skill.
        const scope = args.scope === 'workspace' ? 'workspace' : 'agent';
        const scopeId = scope === 'workspace'
          ? null
          : args.agentId
            ? requireAgent(deps, ctx.workspaceId, args.agentId)
            : (ctx.agentId ?? null);
        const slug = typeof args.slug === 'string' && args.slug.trim() ? args.slug.trim() : undefined;
        const before = deps.skills.getByScopeAndSlug(ctx.workspaceId, scopeId, slug ?? name);
        const saved = deps.skills.upsertSkill({
          workspaceId: ctx.workspaceId,
          scopeId,
          name,
          description,
          body,
          source: 'agent',
          ...(slug ? { slug } : {}),
        });
        return {
          skillId: saved.id,
          slug: saved.slug,
          scope: scopeId ? 'agent' : 'workspace',
          replaced: before !== null,
          guidance:
            'Skill saved. It is now discoverable via agentis.brain.search (kind:"skill") and materialized to disk so harnesses load it natively; read the full procedure any time with agentis.skill.load. As runs that used it are judged, its confidence moves — a proven-good skill sticks, a proven-bad one sinks.',
        };
      },
    },
  ]);
}
