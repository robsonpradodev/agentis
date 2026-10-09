import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  type BrainGraph,
  type BrainGraphLink,
  type BrainGraphNode,
  type BrainGraphScope,
  type BrainScopeKind,
  type KnowledgeAtomKind,
  type KnowledgeLinkRelation,
  type RuntimeEpisodeOutcome,
  type RuntimeEpisodeType,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { EventBus } from '../event-bus.js';
import type { EpisodicMemoryStore } from './episodicMemoryStore.js';
import { EMBED_HIGH_SIMILARITY, bestCosine, bestLexical, resolveDuplicate, type EpisodeVector } from './util/brainDedup.js';
import { directivePolarity, directiveTopicSignature, jaccard } from './memory/memoryReflectionService.js';
import { SKILL_LIBRARY_PLANE } from './memory/memoryStore.js';

/** SQL LIKE pattern matching the Skill-library plane tag on an episode row. */
const SKILL_LIBRARY_PLANE_LIKE = `%plane:${SKILL_LIBRARY_PLANE}%`;
/** Atom kinds that must never be force-injected at dispatch (reached on demand). */
const SKILL_LIBRARY_KINDS: KnowledgeAtomKind[] = ['skill', 'example'];
import {
  type EmbeddingProvider,
  cosineSimilarity,
  embedText,
  isEmbeddingModelCoolingDown,
  isEmbeddingModelUnavailable,
  providerIdentity,
  selectEmbeddingProvider,
  vectorIsComparable,
} from './embedding/embeddingProvider.js';
import type { EmbeddingProviderRegistry } from './embedding/embeddingProviderRegistry.js';
import {
  embeddingRuntimeManager,
  type EmbeddingRuntimeSnapshot,
} from './embedding/embeddingRuntimeManager.js';
import {
  extractCandidateStatements,
  extractOperatorCandidates,
  isRejectable,
  scoreStatement,
  FormationJudge,
  FORMATION_MIN_SCORE,
  type FormationNeighbor,
  type FormedMemory,
  type MemoryWritePolicy,
  type ScoredStatement,
} from './brain/brainFormation.js';
import type { StructuredCompleter } from './structuredCompleter.js';
import {
  classifyPacer,
  pacerRouting,
  type PacerClass,
  type SourceSurface,
} from './brain/brainPacer.js';
import { segment } from './brain/brainText.js';
import { resolveMemoryFormationTier, type MemoryFormationTier } from './brain/memoryFormationTier.js';
import type { MemoryDropLog } from './brain/memoryDropLog.js';
import {
  clamp01,
  compactValue,
  estimateTokens,
  parseJsonArray,
  parseJsonRecord,
  similarity,
  synthesizePreTaskContext,
  tokenize,
  truncate,
  uniqueByNormalized,
} from './brain/sharedIntelligenceUtils.js';

/**
 * Structural seam for the Grounding organizational-context layer (apps/api/src/grounding).
 * Kept structural (not an import) so the Brain composer has no hard dependency
 * on the Grounding module — bootstrap wires the real composer via setGroundingComposer.
 */
export interface GroundingDispatchComposer {
  composeForDispatch(args: {
    workspaceId: string;
    agentId: string;
    runId?: string | null;
    taskDescription: string;
    interactionAudience?: 'private' | 'customer' | 'public';
    limit?: number;
  }): { block: string };
}

export interface CollectiveCognitivePromotionInput {
  workspaceId: string;
  workflowId?: string | null;
  runId?: string | null;
  nodeId?: string | null;
  agentId?: string | null;
  adapterType?: string | null;
  scopeId?: string | null;
  taskInput?: unknown;
  taskOutput: unknown;
  /**
   * Authoritative operator speech (the user side of a chat turn). When set with
   * `originSurface: 'operator_chat'`, it is mined with the permissive operator
   * gate (`extractOperatorCandidates`) so terse/first-person statements survive,
   * and — even without a Formation Judge — is committed as durable operator
   * memory rather than ephemeral staging.
   */
  operatorText?: string | null;
  /** Human-readable task label, used by the Formation Judge for context. */
  taskTitle?: string | null;
  /**
   * What the run is allowed to write. Resolved by the write-policy gate at
   * enqueue time. Defaults to `form` for backward compatibility.
   */
  memoryPolicy?: MemoryWritePolicy;
  /**
   * Where the content came from (Phase 2). Drives PACER classification +
   * source-aware routing. Defaults to `run_completion`.
   */
  originSurface?: SourceSurface | null;
}

export interface BrainGraphOptions {
  scope?: BrainGraphScope;
  scopeId?: string | null;
  includeWorkspace?: boolean;
  kinds?: KnowledgeAtomKind[];
  /**
   * Kinds to omit even when otherwise selected. The always-inject dispatch tier
   * passes `['skill','example']` so Skill-library atoms are never force-injected
   * — they are reached via search / materialization instead.
   */
  excludeKinds?: KnowledgeAtomKind[];
  minConfidence?: number;
  limit?: number;
  /** Upper clamp for `limit`. Defaults to MAX_GRAPH_LIMIT; the visual graph raises
   *  it to GRAPH_RENDER_CAP so it can show every atom. */
  maxLimit?: number;
  /**
   * §C7 — row-level access. When set, retrieval enforces team privacy: an
   * episode is visible only if it is `shared` OR belongs to this requester's own
   * scope. A private atom of ANY other scope is never surfaced. Leave undefined
   * to disable RLS (graph/admin views).
   */
  requesterScopeId?: string | null;
  /**
   * §B5.6 — include staged (`unconsolidated`) traces.
   *
   * Staging and VISIBILITY were conflated: everything the no-model mining path
   * writes is tagged `unconsolidated`, and this query dropped that tag, so an
   * operator without a Formation Judge model saw a permanently empty Brain
   * canvas no matter how much their agents learned. The web UI was already
   * built for the other behaviour — `BrainDetailRail` renders a
   * "Staged (decays unless reused)" badge for exactly these atoms, dead code
   * because the API could never send one.
   *
   * The graph opts in (an operator should see everything their brain holds);
   * RECALL deliberately does not, so low-confidence staged traces never leak
   * into dispatch context. Staged atoms still carry their TTL and are still
   * expired by maintenance, so "visible" does not mean "permanent".
   */
  includeStaged?: boolean;
  /**
   * §B5.7 — override the per-kind candidate pool. Retrieval passes
   * RETRIEVAL_CANDIDATE_CAP so scoring sees coverage rather than the last
   * `limit/4` rows by recency. See RETRIEVAL_CANDIDATE_CAP.
   */
  perKind?: number;
}

export interface KnowledgeLinkInput {
  workspaceId: string;
  sourceId: string;
  sourceKind: KnowledgeAtomKind;
  targetId: string;
  targetKind: KnowledgeAtomKind;
  relation: KnowledgeLinkRelation;
  confidence?: number;
  agentId?: string | null;
  adapterType?: string | null;
  runId?: string | null;
  scopeId?: string | null;
}

interface AtomCandidate {
  id: string;
  kind: KnowledgeAtomKind;
  text: string;
  node: BrainGraphNode;
  // §0.1/§3.4 — the stored vector + its provenance, carried straight off the row
  // `loadAtoms` already read. Lets `searchAtoms` score EVERY kind from the atoms
  // it loaded (bounded), instead of a second full-workspace embedding scan.
  embedding?: number[] | null;
  embeddingModel?: string | null;
  embeddingDims?: number | null;
}

interface SimilarAtom {
  atom: AtomCandidate;
  score: number;
}

interface BrainAtomDetail {
  content: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  agentId?: string | null;
  workflowId?: string | null;
  runId?: string | null;
}

interface BrainUsageSummary {
  id: string;
  type: 'agent' | 'workflow';
  name: string;
  count: number;
}

export interface BrainSearchResult {
  id: string;
  kind: KnowledgeAtomKind;
  title: string;
  content: string;
  confidence: number;
  score: number;
  scopeId: string | null;
  tags: string[];
  status?: string | null;
  managed?: boolean | null;
  updatedAt: string;
}

export interface BrainSummary {
  workspaceIntelligence: { count: number; averageConfidence: number; capacityTokens: number };
  scopedBrain: { count: number; averageConfidence: number; capacityTokens: number };
  SessionMoments: { count: number; capacityTokens: number };
  compressionStatus: { lastRunAt: string | null; atomsArchived: number; nextTriggerAt: string | null };
}

const DEFAULT_GRAPH_LIMIT = 200;
// Bound for search / auto-linker candidate scans (retrieval quality, not display).
const MAX_GRAPH_LIMIT = 500;
// The Brain MAP renders on a bespoke <canvas> + d3-force simulation (the Obsidian
// approach), so node count is not the bottleneck and there is no product reason to
// hide atoms - it shows every atom. Node responses carry no embeddings, so the
// payload stays light regardless of count. This is only a query sanity valve
// (matches the quarantine cap), NOT a "show fewer of your notes" limit.
const GRAPH_RENDER_CAP = 20_000;

/**
 * §B5.7 — how many rows PER KIND retrieval may consider before scoring.
 *
 * `loadAtoms` derives `perKind` from the requested result limit
 * (`max(12, ceil(limit/4))`). Search asked for MAX_GRAPH_LIMIT (500), so the
 * pool was 125 episodes ordered by `updatedAt DESC` — meaning semantic search
 * was not searching the brain, it was searching the *recent* brain. A rule
 * stated four months ago could not be retrieved at any similarity score, and
 * the Formation Judge's ADD/UPDATE context was drawn from the same window, so
 * it could not see the atom it should have been updating.
 *
 * Scoring happens in memory, so the pool must be sized for COVERAGE, not for
 * the result count. Bounded (rather than unbounded) because an earlier
 * full-workspace scan had to be removed for performance.
 */
const RETRIEVAL_CANDIDATE_CAP = 2_000;
const HIGH_SIMILARITY = 0.86;
const RELATED_SIMILARITY = 0.52;
const GLOBAL_CONFIDENCE_THRESHOLD = 0.7;

// Brain & Abilities Replan — embedding-aware promotion (B4) thresholds.
/** Cosine similarity above which two atoms get a `refines`/`related` link. */
/** Minimum cosine relevance for an atom to enter a dispatch context block. */
const DISPATCH_MIN_RELEVANCE = 0.32;
/** Minimum lexical overlap for the hybrid recall fallback to count an atom as a
 *  match (rescues un-embedded/mixed-provider atoms without flooding weak noise). */
const LEXICAL_RECALL_FLOOR = 0.06;
/**
 * Per-provider relevance floor. Cosine distributions differ wildly by model:
 * `local`/e5 sits in a high, compressed band (~0.78–0.92 even for unrelated
 * text), so the generic 0.32 floor would admit everything and flood dispatch
 * with noise; OpenAI sits lower; unknown/test-stub providers keep the permissive
 * default. (Measured for multilingual-e5-small; tune as providers are added.)
 */
function dispatchRelevanceFloor(modelId: string): number {
  if (modelId.startsWith('local:')) return 0.82;
  if (modelId.startsWith('openai:')) return 0.35;
  return DISPATCH_MIN_RELEVANCE;
}
/**
 * §B2.2 — MMR diversity weight. 1.0 = pure relevance (today's behavior); lower
 * values trade a little relevance for diversity so a single dispatch never gets
 * five near-duplicate atoms eating the budget. 0.72 keeps relevance dominant.
 */
const MMR_LAMBDA = 0.72;
/**
 * Max slots reserved for the always-on constitutional tier (operator-authored
 * rules + charter) within a single dispatch. Bounds the charter so it can never
 * crowd out relevance retrieval; the rest of the budget goes to relevance.
 */
const CONSTITUTIONAL_MAX = 5;
/** Evaluator ? brain confidence deltas (Gap14). */
const EVAL_DELTA_PASS = 0.04;
const EVAL_DELTA_PASS_TOP = 0.08;
const EVAL_DELTA_FAIL = -0.06;
/** An atom that was injected but never cited in the response earns/loses only
 * half credit — it was present, not necessarily useful. */
const EVAL_DELTA_UNCITED_FACTOR = 0.5;

/**
 * Pull every `[mem:id8]`-style citation prefix out of a response (the format
 * `renderLine` stamps on each injected atom — see §B2.4). Returns null when
 * there's no text to scan, so callers can distinguish "no usage signal" from
 * "usage signal found, but this response cited nothing."
 */
function extractCitedMemPrefixes(responseText: string | null | undefined): string[] | null {
  if (!responseText) return null;
  const matches = responseText.matchAll(/mem:([0-9a-f]{4,8})/gi);
  const prefixes = [...matches].map((m) => m[1]!.toLowerCase());
  return prefixes;
}
/** Atoms below this confidence are auto-archived. */
const ARCHIVE_CONFIDENCE_FLOOR = 0.05;

export class SharedIntelligenceService {
  /** Per-workspace embedding provider cache (resolved from workspace config). */
  readonly #embeddingProviders = new Map<string, EmbeddingProvider>();
  /** Exactly one deferred-backfill worker per workspace. */
  readonly #reembedOperations = new Map<string, Promise<{ reembedded: number; failed: number }>>();

  /**
   * Optional model behind the Formation Judge (the Mem0-style extract+classify
   * +reconcile step). When set, `promote()` forms typed, durable memory; when
   * unset, survivors are merely staged as low-confidence episodic traces that
   * decay. Wired from the configured evaluator runtime in bootstrap.
   */
  #formationCompleter: StructuredCompleter | null = null;
  #modelAssistedRuntimeEnabled: (workspaceId: string) => boolean = () => true;

  /**
   * §B7 — optional recorder for candidates that did NOT become memory. Optional
   * so every existing construction site keeps working; when unset, behaviour is
   * exactly as before (silent), so wiring it can never change formation.
   */
  #drops: MemoryDropLog | null = null;

  setDropLog(log: MemoryDropLog | null): void {
    this.#drops = log;
  }

  /**
   * Optional Grounding layer (the Workspace Brain's organizational reasoning
   * engine). When set, buildDispatchContext appends grant-gated, audited
   * organizational claims after the existing Brain tiers. Same extension
   * pattern as the Formation Judge: Grounding extends this composer, it never
   * forks it (RFC §12.2).
   */
  #groundingComposer: GroundingDispatchComposer | null = null;

  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly bus: EventBus,
    private readonly episodes: EpisodicMemoryStore,
    private readonly logger: Logger,
    /** §B1.1 — the single provider owner. When present, resolution delegates here. */
    private readonly embeddingRegistry?: EmbeddingProviderRegistry,
  ) {}

  /** Wire (or clear) the Formation Judge model. */
  setFormationCompleter(completer: StructuredCompleter | null): void {
    this.#formationCompleter = completer;
  }

  setModelAssistedRuntimeEnabled(resolver: (workspaceId: string) => boolean): void {
    this.#modelAssistedRuntimeEnabled = resolver;
  }

  /**
   * §B5.9 — the operator's formation tier, read fresh from the workspace row.
   *
   * Deliberately NOT injected as a resolver at bootstrap like
   * `#modelAssistedRuntimeEnabled`: this service already owns `db`, and an
   * injected resolver is one more place a future change could capture a value
   * once and turn a live setting into a silent restart requirement.
   */
  #memoryFormationTier(workspaceId: string): MemoryFormationTier {
    try {
      return resolveMemoryFormationTier(this.db, workspaceId);
    } catch {
      return 'model_assisted';
    }
  }

  /**
   * §B2.2 — OPTIONAL model reranker. Off by default (null) so retrieval has zero
   * per-dispatch model latency; the cheap MMR+feature reranker already orders
   * results. When an operator opts in, retrieval does a second structured pass
   * that reorders the top candidates by task relevance. Model-agnostic.
   */
  setRerankCompleter(completer: StructuredCompleter | null): void {
    this.#rerankCompleter = completer;
  }
  #rerankCompleter: StructuredCompleter | null = null;

  /** Wire (or clear) the Grounding organizational-context layer. */
  setGroundingComposer(composer: GroundingDispatchComposer | null): void {
    this.#groundingComposer = composer;
  }

  /**
   * Resolve (and cache) the embedding provider for a workspace from its
   * `embedding_provider_type` column. Appendix A: provider is user-selectable.
   */
  #resolveEmbeddingProvider(workspaceId: string): EmbeddingProvider {
    // Query with the SAME provider the episodes store writes with, so stored
    // vectors and query vectors are always comparable (no write/query drift in
    // prod OR tests, which inject a deterministic stub into the episodes store).
    const fromStore = this.episodes.embeddingProviderFor(workspaceId);
    if (fromStore) return fromStore;
    // §B1.1 — else delegate to the single registry when wired; the local cache
    // below is the legacy fallback for code paths constructed without one.
    if (this.embeddingRegistry) return this.embeddingRegistry.resolve(workspaceId);
    const cached = this.#embeddingProviders.get(workspaceId);
    if (cached) return cached;
    let type = 'local';
    let config: Record<string, unknown> = {};
    try {
      const row = this.db
        .select({
          type: schema.workspaces.embeddingProviderType,
          config: schema.workspaces.embeddingProviderConfig,
        })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .get();
      if (row?.type) type = row.type;
      config = parseJsonRecord(row?.config);
    } catch {
      // Column may not exist on very old DBs — degrade to hashing.
    }
    const provider = selectEmbeddingProvider(type, config);
    this.#embeddingProviders.set(workspaceId, provider);
    return provider;
  }

  /** Drop a cached provider — call after the operator changes workspace config. */
  invalidateEmbeddingProvider(workspaceId: string): void {
    this.embeddingRegistry?.invalidate(workspaceId);
    this.#embeddingProviders.delete(workspaceId);
  }

  embeddingProvider(workspaceId: string): EmbeddingProvider {
    return this.#resolveEmbeddingProvider(workspaceId);
  }

  embeddingStatus(workspaceId: string): {
    type: string;
    degraded: boolean;
    retrievalPaused: boolean;
    migration: Record<string, unknown> | null;
    runtime: EmbeddingRuntimeSnapshot | null;
  } {
    const row = this.db.select({
      type: schema.workspaces.embeddingProviderType,
      brainSettings: schema.workspaces.brainSettings,
    }).from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .get();
    const settings = parseJsonRecord(row?.brainSettings);
    const migration = settings.embeddingMigration && typeof settings.embeddingMigration === 'object' && !Array.isArray(settings.embeddingMigration)
      ? settings.embeddingMigration as Record<string, unknown>
      : null;
    const type = row?.type ?? 'local';
    const provider = this.#resolveEmbeddingProvider(workspaceId);
    // The managed runtime only governs LocalEmbeddingProvider. Tests and
    // embedders injected by a store may intentionally use a different provider
    // while the workspace's persisted type remains at its default `local`.
    const runtime = type === 'local' && provider.modelId.startsWith('local:')
      ? embeddingRuntimeManager.snapshot()
      : null;
    const runtimeUnavailable = runtime != null && runtime.status !== 'ready';
    return {
      type,
      degraded: runtimeUnavailable,
      retrievalPaused: runtimeUnavailable || migration?.status === 'running',
      migration,
      runtime,
    };
  }

  /**
   * Memory FORMATION (the heart of the brain write-path fix). Called by the
   * durable queue worker after a task completes. Three-stage pipeline:
   *
   *   policy gate → deterministic extraction → (LLM Formation Judge | staging)
   *
   * - `none`          → writes nothing.
   * - `episodic_only` → writes at most ONE low-confidence outcome marker
   *                     (hidden from the graph); never forms pattern atoms.
   * - `form`          → deterministic gate drops structural garbage, then:
   *      • with a Formation Judge model: extract durable statements, type them,
   *        and ADD/UPDATE/NOOP against existing memory (Mem0 two-phase).
   *      • without a model: stage survivors as low-confidence `observation`
   *        episodes tagged `unconsolidated` that decay if never reinforced.
   */
  async promote(input: CollectiveCognitivePromotionInput): Promise<{ created: number; reinforced: number; linked: number }> {
    const ZERO = { created: 0, reinforced: 0, linked: 0 };
    const policy: MemoryWritePolicy = input.memoryPolicy ?? 'form';
    if (policy === 'none') return ZERO;

    // §B5.9 — operator-chosen formation tier. Resolved per call (never captured
    // at bootstrap) so a settings change takes effect on the next pass rather
    // than the next restart.
    const tier = this.#memoryFormationTier(input.workspaceId);
    if (tier === 'off') {
      this.#drops?.record({
        workspaceId: input.workspaceId,
        gate: 'policy_none',
        detail: 'memory formation tier is off',
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.originSurface ? { originSurface: input.originSurface } : {}),
      });
      return ZERO;
    }

    const provider = this.#resolveEmbeddingProvider(input.workspaceId);
    const resolvedAgent = input.agentId ? this.resolveAgent(input.workspaceId, input.agentId) : null;
    const adapterType = input.adapterType ?? resolvedAgent?.adapterType ?? null;

    if (policy === 'episodic_only') {
      const created = this.#writeEpisodicMarker(input, provider, adapterType);
      return { created, reinforced: 0, linked: 0 };
    }

    // Authoritative operator chat is mined permissively (terse/first-person
    // statements survive) and merged with any strict candidates from the
    // assistant side; everything else uses the strict agent-output gate.
    // §B6.1 — `operator_chat` is the AUTHORITATIVE surface: it is mined
    // permissively and commits durable, consolidated memory without a judge.
    // The check is deliberately an exact match on the one trusted surface
    // rather than a list of untrusted ones, so a future surface is untrusted by
    // default. `external_contact` (a customer on a channel) must never satisfy
    // it — its statements stage and decay like any other unverified evidence.
    const operatorChat = input.originSurface === 'operator_chat';

    // §B6.1 — READING a counterparty and TRUSTING them are separate decisions.
    //
    // These were previously the same flag, so mining the inbound human message
    // was coupled to granting it operator authority. The consequence was an
    // either/or with no correct setting: label a channel turn `operator_chat`
    // and a stranger could write workspace constitution; label it anything else
    // and the agent learned NOTHING from the conversation, because only the
    // agent's own reply was mined and the customer's words were discarded.
    //
    // Split: `minesInboundText` decides what is READ (an external contact is
    // worth learning from — their questions, constraints, and objections are
    // the whole point of a support channel), while `operatorChat` alone decides
    // what is BELIEVED. External statements flow to the staging path, where
    // they decay unless reinforced, and stay in the counterparty's own scope.
    const externalContact = input.originSurface === 'external_contact';
    const minesInboundText = operatorChat || externalContact;
    const candidates: ScoredStatement[] = minesInboundText
      ? dedupeCandidates([
        ...extractOperatorCandidates(typeof input.operatorText === 'string' ? input.operatorText : ''),
        ...extractCandidateStatements(input.taskOutput),
      ])
      : extractCandidateStatements(input.taskOutput);
    if (candidates.length === 0) {
      // §B7 — the most common invisible outcome: text arrived, nothing survived
      // the deterministic gate, and the operator was told nothing at all.
      this.#drops?.record({
        workspaceId: input.workspaceId,
        gate: 'below_score',
        text: typeof input.operatorText === 'string' ? input.operatorText : null,
        detail: 'no candidate cleared extraction',
        ...(input.scopeId ? { scopeId: input.scopeId } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.originSurface ? { originSurface: input.originSurface } : {}),
      });
      return ZERO;
    }

    const existing = this.#loadEpisodeVectors(input.workspaceId, input.scopeId ?? null);

    // Preferred path: a Formation Judge model forms typed, durable memory.
    if (tier === 'model_assisted' && this.#formationCompleter && this.#modelAssistedRuntimeEnabled(input.workspaceId)) {
      try {
        const neighbors = await this.#formationNeighbors(input, candidates);
        const judge = new FormationJudge(this.#formationCompleter);
        const formed = await judge.judge(candidates, {
          workspaceId: input.workspaceId,
          taskTitle: input.taskTitle ?? null,
          agentScopeId: input.scopeId ?? null,
          neighbors,
        });
        if (formed) {
          const result = await this.#commitFormedMemories(input, formed, provider, adapterType, existing);
          this.logger.info('collective_brain.formation.applied', {
            workspaceId: input.workspaceId,
            runId: input.runId,
            candidates: candidates.length,
            ...result,
          });
          return result;
        }
        // Judge unavailable/failed → fall through to episodic staging.
      } catch (err) {
        this.logger.warn('collective_brain.formation.failed', {
          workspaceId: input.workspaceId,
          message: (err as Error).message,
        });
      }
    }

    // Fallback: stage survivors as low-confidence episodic traces (no model).
    let created = 0;
    let reinforced = 0;
    let linked = 0;
    for (const cand of candidates) {
      // Operator chat is authoritative → durable even without a judge; agent
      // output stays ephemeral until reinforced.
      const r = operatorChat
        ? await this.#commitOperatorMemory(input, cand, provider, adapterType, existing)
        : await this.#stageOrReinforce(input, cand, provider, adapterType, existing);
      created += r.created;
      reinforced += r.reinforced;
      linked += r.linked;
    }
    if (created || reinforced) {
      this.logger.info('collective_brain.staged', {
        workspaceId: input.workspaceId,
        runId: input.runId,
        created,
        reinforced,
      });
    }
    return { created, reinforced, linked };
  }

  /** TTL (days) before an unconsolidated episodic trace is eligible for expiry. */
  static readonly STAGED_TTL_DAYS = 14;
  static readonly MARKER_TTL_DAYS = 30;

  /** Write one low-confidence outcome marker for a transient (episodic_only) run. */
  #writeEpisodicMarker(input: CollectiveCognitivePromotionInput, provider: EmbeddingProvider, adapterType: string | null): number {
    const summary = episodicMarkerSummary(input);
    if (!summary) return 0;
    const title = truncate(input.taskTitle?.trim() || 'Task run', 92);
    this.episodes.write({
      workspaceId: input.workspaceId,
      scopeId: input.scopeId ?? null,
      workflowId: input.workflowId ?? null,
      runId: input.runId ?? null,
      agentId: input.agentId ?? null,
      type: 'observation',
      title,
      summary,
      source: 'run_promotion',
      confidence: 0.25,
      importance: 0.3,
      trust: 0.4,
      tags: ['episodic_marker', 'unconsolidated', 'pacer:evidence', ...(adapterType ? [adapterType] : [])],
      entities: input.nodeId ? [input.nodeId] : [],
      outcomeStatus: 'mixed',
      metadata: {
        adapterType,
        nodeId: input.nodeId ?? null,
        origin: 'episodic_marker',
        // PACER (Phase 1): an outcome marker is grounded run-local evidence.
        pacerClass: 'evidence' as PacerClass,
        originSurface: input.originSurface ?? 'run_completion',
        formationMode: 'episodic_marker',
        ttlExpiresAt: ttlIso(SharedIntelligenceService.MARKER_TTL_DAYS),
        embeddingProvider: provider.dimension,
      },
    });
    return 1;
  }

  /** Retrieve nearby existing memories for the Formation Judge to reconcile against. */
  async #formationNeighbors(input: CollectiveCognitivePromotionInput, candidates: { text: string }[]): Promise<FormationNeighbor[]> {
    const query = candidates.slice(0, 6).map((c) => c.text).join(' ');
    try {
      const hits = await this.searchAtoms({
        workspaceId: input.workspaceId,
        scopeId: input.scopeId ?? null,
        query,
        scope: input.scopeId ? 'both' : 'workspace',
        limit: 6,
        minConfidence: 0,
      });
      return hits.map((h) => ({ id: h.id, title: h.title, summary: h.content }));
    } catch {
      return [];
    }
  }

  /** Commit the Formation Judge's decisions into typed, durable episode atoms. */
  async #commitFormedMemories(
    input: CollectiveCognitivePromotionInput,
    formed: FormedMemory[],
    provider: EmbeddingProvider,
    adapterType: string | null,
    existing: EpisodeVector[],
  ): Promise<{ created: number; reinforced: number; linked: number }> {
    let created = 0;
    let reinforced = 0;
    let linked = 0;

    for (const mem of formed) {
      if (mem.operation !== 'ADD') {
        // UPDATE / NOOP — reinforce the cited existing atom; UPDATE also refreshes its text.
        if (!mem.targetAtomId) continue;
        if (mem.operation === 'UPDATE') {
          this.episodes.update(input.workspaceId, mem.targetAtomId, { summary: mem.statement, title: mem.title });
        }
        const node = this.reinforceAtom(input.workspaceId, 'episode', mem.targetAtomId, {
          agentId: input.agentId ?? null,
          adapterType,
          runId: input.runId ?? null,
          scopeId: input.scopeId ?? null,
        });
        if (node) {
          reinforced += 1;
          this.publishAtom(input.workspaceId, REALTIME_EVENTS.BRAIN_ATOM_REINFORCED, node);
        }
        continue;
      }

      const scopeId = mem.scope === 'agent' ? (input.scopeId ?? null) : null;
      let vec: number[] | null = null;
      try {
        vec = await embedText(provider, mem.statement);
      } catch { /* embedding optional */ }

      // Deterministic backstop against a repeatedly re-extracted fact compounding
      // into N duplicate atoms. §B5.5 — this only collapses a PROVABLE duplicate
      // (identical after segmentation). The Judge already compared this statement
      // against a fresh neighbour set and chose ADD; when the backstop is merely
      // "contested" the Judge's decision stands and the atom is written, because
      // no cosine score can distinguish a refinement from a contradiction.
      const verdict = resolveDuplicate({ text: mem.statement, vec, existing });
      if (verdict.kind === 'duplicate') {
        const node = this.reinforceAtom(input.workspaceId, 'episode', verdict.entry.id, {
          agentId: input.agentId ?? null,
          adapterType,
          runId: input.runId ?? null,
          scopeId: input.scopeId ?? null,
        });
        if (node) {
          reinforced += 1;
          this.publishAtom(input.workspaceId, REALTIME_EVENTS.BRAIN_ATOM_REINFORCED, node);
        }
        continue;
      }
      const contestedNeighbor = verdict.kind === 'contested' ? verdict : null;

      // PACER (Phase 1+2): classify the formed memory using the judge's type as
      // a prior plus the source surface and the (un-stripped) statement text.
      const pacer = classifyPacer({
        text: mem.statement,
        surface: input.originSurface ?? 'run_completion',
        episodeType: mem.type,
        agentRole: null,
      });
      const routing = pacerRouting(pacer.pacerClass);

      const episode = this.episodes.write({
        workspaceId: input.workspaceId,
        scopeId,
        workflowId: input.workflowId ?? null,
        runId: input.runId ?? null,
        agentId: input.agentId ?? null,
        type: mem.type,
        title: mem.title,
        summary: mem.statement,
        source: 'run_promotion',
        confidence: mem.confidence,
        importance: Math.max(0.62, routing.importanceFloor),
        trust: 0.6,
        tags: ['collective_brain', 'consolidated', `pacer:${pacer.pacerClass}`, ...(adapterType ? [adapterType] : [])],
        entities: input.nodeId ? [input.nodeId] : [],
        outcomeStatus: outcomeFor(mem.type),
        metadata: {
          adapterType,
          nodeId: input.nodeId ?? null,
          origin: 'formation_judge',
          formationReason: mem.reason ?? null,
          // PACER metadata — read by maintenance, compression, and the UI.
          pacerClass: pacer.pacerClass,
          pacerConfidence: pacer.confidence,
          pacerReason: pacer.reason,
          originSurface: input.originSurface ?? 'run_completion',
          formationMode: 'formation_judge',
          embeddingProvider: provider.dimension,
        },
      });
      created += 1;
      if (vec) this.#applyEmbedding(episode.id, vec, provider);
      this.publishAtom(input.workspaceId, REALTIME_EVENTS.BRAIN_ATOM_CREATED, episodeToGraphNode(episode, 1));
      existing.push({ id: episode.id, vec, text: `${episode.title}\n${episode.summary}` });
      // Preserved-but-conflicting: surface the pair for resolution instead of
      // letting two near-identical atoms sit in the graph unreconciled.
      if (contestedNeighbor) {
        this.flagDispute({
          workspaceId: input.workspaceId,
          atomIdA: episode.id,
          atomIdB: contestedNeighbor.entry.id,
          reason: `Formation judge added a statement ${contestedNeighbor.score.toFixed(3)} similar to an existing atom (${contestedNeighbor.reason}).`,
          scopeId: input.scopeId ?? null,
        });
      }
    }
    return { created, reinforced, linked };
  }

  /**
   * Episodic staging (no Formation Judge model). Writes a survivor as a
   * low-confidence `observation` tagged `unconsolidated` with a TTL, or
   * reinforces a near-duplicate. These never render as patterns and decay.
   */
  async #stageOrReinforce(
    input: CollectiveCognitivePromotionInput,
    cand: { text: string; score: number },
    provider: EmbeddingProvider,
    adapterType: string | null,
    existing: EpisodeVector[],
  ): Promise<{ created: number; reinforced: number; linked: number }> {
    let vec: number[] | null = null;
    try {
      vec = await embedText(provider, cand.text);
    } catch { /* embedding optional */ }

    // §B5.5 — reinforce only a PROVABLE duplicate. Anything merely similar is
    // preserved and flagged after the write below; with no Formation Judge in
    // this path there is nothing here able to tell a refinement from a
    // contradiction, and guessing loses the operator's newer statement.
    const verdict = resolveDuplicate({ text: cand.text, vec, existing });
    if (verdict.kind === 'duplicate') {
      const node = this.reinforceAtom(input.workspaceId, 'episode', verdict.entry.id, {
        agentId: input.agentId ?? null,
        adapterType,
        runId: input.runId ?? null,
        scopeId: input.scopeId ?? null,
      });
      if (node) {
        this.publishAtom(input.workspaceId, REALTIME_EVENTS.BRAIN_ATOM_REINFORCED, node);
        return { created: 0, reinforced: 1, linked: 0 };
      }
    }

    // PACER (Phase 2): classify the raw candidate (NOT the stripped survivor —
    // procedural/reference signals live in code refs/paths the strip removes).
    // Routing then decides how long this staged trace lives: a procedural rule
    // gets ~60 days to prove itself; bulk evidence decays in ~14.
    const pacer = classifyPacer({
      text: cand.text,
      surface: input.originSurface ?? 'run_completion',
      episodeType: 'observation',
    });
    const routing = pacerRouting(pacer.pacerClass);

    const episode = this.episodes.write({
      workspaceId: input.workspaceId,
      scopeId: input.scopeId ?? null,
      workflowId: input.workflowId ?? null,
      runId: input.runId ?? null,
      agentId: input.agentId ?? null,
      type: 'observation',
      title: titleFromFact(cand.text),
      summary: cand.text,
      source: 'run_promotion',
      confidence: clamp01(0.25 + 0.15 * cand.score),
      importance: Math.max(0.45, routing.importanceFloor * 0.75),
      trust: 0.45,
      tags: ['collective_brain', 'unconsolidated', `pacer:${pacer.pacerClass}`, ...(adapterType ? [adapterType] : [])],
      entities: input.nodeId ? [input.nodeId] : [],
      outcomeStatus: 'mixed',
      metadata: {
        adapterType,
        nodeId: input.nodeId ?? null,
        origin: 'agent_task_output',
        pacerClass: pacer.pacerClass,
        pacerConfidence: pacer.confidence,
        pacerReason: pacer.reason,
        originSurface: input.originSurface ?? 'run_completion',
        formationMode: 'staged',
        ttlExpiresAt: ttlIso(routing.stagedTtlDays),
        taskInputPreview: compactValue(input.taskInput),
        embeddingProvider: provider.dimension,
      },
    });
    if (vec) this.#applyEmbedding(episode.id, vec, provider);
    this.publishAtom(input.workspaceId, REALTIME_EVENTS.BRAIN_ATOM_CREATED, episodeToGraphNode(episode, 1));
    existing.push({ id: episode.id, vec, text: `${episode.title}\n${episode.summary}` });
    if (verdict.kind === 'contested') {
      this.flagDispute({
        workspaceId: input.workspaceId,
        atomIdA: episode.id,
        atomIdB: verdict.entry.id,
        reason: `Staged a statement ${verdict.score.toFixed(3)} similar to an existing atom (${verdict.reason}); no judge available to reconcile.`,
        scopeId: input.scopeId ?? null,
      });
    }
    return { created: 1, reinforced: 0, linked: 0 };
  }

  /**
   * Durable commit for authoritative OPERATOR memory when no Formation Judge is
   * available (no model). Unlike `#stageOrReinforce` (ephemeral, decaying), the
   * operator is the source of truth, so we write a CONSOLIDATED, non-expiring
   * `operator`-sourced atom — preserving the pre-existing "operator chat is
   * durable" behavior — while still reinforcing a near-duplicate instead of
   * writing a second copy (the dedup the regex path lacked).
   */
  async #commitOperatorMemory(
    input: CollectiveCognitivePromotionInput,
    cand: { text: string; score: number },
    provider: EmbeddingProvider,
    adapterType: string | null,
    existing: EpisodeVector[],
  ): Promise<{ created: number; reinforced: number; linked: number }> {
    let vec: number[] | null = null;
    try { vec = await embedText(provider, cand.text); } catch { /* embedding optional */ }
    // §B5.5 — the operator is the source of truth, so this path is the most
    // damaging place to guess. Embeddings place "always X" and "never X" at the
    // TOP of the similarity range (measured 0.9763, above every true duplicate),
    // so polarity is checked before any merge and anything not provably
    // identical is preserved rather than folded into the older statement.
    const verdict = resolveDuplicate({ text: cand.text, vec, existing });
    if (verdict.kind === 'duplicate') {
      const node = this.reinforceAtom(input.workspaceId, 'episode', verdict.entry.id, {
        agentId: input.agentId ?? null, adapterType, runId: input.runId ?? null, scopeId: input.scopeId ?? null,
      });
      if (node) {
        this.publishAtom(input.workspaceId, REALTIME_EVENTS.BRAIN_ATOM_REINFORCED, node);
        return { created: 0, reinforced: 1, linked: 0 };
      }
    }
    const pacer = classifyPacer({ text: cand.text, surface: 'operator_chat', episodeType: 'decision' });
    const episode = this.episodes.write({
      workspaceId: input.workspaceId,
      scopeId: input.scopeId ?? null,
      agentId: input.agentId ?? null,
      type: 'decision',
      title: titleFromFact(cand.text),
      summary: cand.text,
      source: 'operator_write',
      confidence: 0.85,
      importance: 0.8,
      trust: 0.9,
      tags: ['operator_signal', 'consolidated', `pacer:${pacer.pacerClass}`],
      outcomeStatus: 'mixed',
      metadata: {
        origin: 'operator_chat',
        pacerClass: pacer.pacerClass,
        originSurface: 'operator_chat',
        formationMode: 'operator_durable',
        embeddingProvider: provider.dimension,
      },
    });
    if (vec) this.#applyEmbedding(episode.id, vec, provider);
    this.publishAtom(input.workspaceId, REALTIME_EVENTS.BRAIN_ATOM_CREATED, episodeToGraphNode(episode, 1));
    existing.push({ id: episode.id, vec, text: `${episode.title}\n${episode.summary}` });
    // §Mem0-teardown-followup — an operator correction is exactly the
    // highest-stakes contradiction case (two opposing "always X"/"never X"
    // rules both active) and this write is constitutional-tier (importance
    // 0.8) the moment it lands. Don't wait for the weekly reflection sweep to
    // (maybe) notice — check it against this scope's existing high-importance
    // atoms immediately, using the SAME polarity/similarity logic the sweep
    // uses, just narrowed to one new atom instead of a 150-atom batch.
    this.#checkGoverningContradiction(input.workspaceId, input.scopeId ?? null, episode.id, `${episode.title} ${episode.summary}`);
    return { created: 1, reinforced: 0, linked: 0 };
  }

  /**
   * Narrow, immediate contradiction check for one newly-written constitutional-
   * tier atom against others already active in the same scope. Best-effort and
   * cheap (a handful of rows, no embedding call) — the full periodic sweep in
   * `MemoryReflectionService` remains the broad safety net for everything else.
   */
  #checkGoverningContradiction(workspaceId: string, scopeId: string | null, newAtomId: string, newText: string): void {
    try {
      const polarity = directivePolarity(newText);
      if (polarity === 0) return;
      const conds = [
        eq(schema.memoryEpisodes.workspaceId, workspaceId),
        isNull(schema.memoryEpisodes.archivedAt),
        isNull(schema.memoryEpisodes.supersededBy),
        eq(schema.memoryEpisodes.isDisputed, false),
      ];
      if (scopeId) conds.push(eq(schema.memoryEpisodes.scopeId, scopeId));
      const candidates = this.db.select().from(schema.memoryEpisodes).where(and(...conds))
        .orderBy(desc(schema.memoryEpisodes.updatedAt)).limit(40).all()
        .filter((r) => r.id !== newAtomId && ((Number(r.importance) || 0) >= 0.8 || Boolean(r.governing)));
      const newSig = directiveTopicSignature(newText);
      for (const row of candidates) {
        const rowText = `${row.title} ${row.summary}`;
        if (directivePolarity(rowText) === -polarity && jaccard(newSig, directiveTopicSignature(rowText)) >= 0.4) {
          this.flagDispute({
            workspaceId,
            atomIdA: newAtomId,
            atomIdB: row.id,
            reason: 'Immediate check: a newly written rule opposes an existing constitutional-tier atom in the same scope.',
            scopeId,
          });
          break; // one flagged dispute is enough to surface the conflict for review
        }
      }
    } catch { /* best effort — the weekly sweep still covers this */ }
  }

  /**
   * Attach an inline-awaited vector to a just-written episode.
   *
   * §B5.11 — must stamp the FULL embedding identity and clear `needsReembed`.
   * It used to write only the `embedding` column: the local provider is async,
   * so `episodes.write` had already set `needsReembed=true` with null
   * model/dims — which meant (a) the 15s sweep re-embedded every atom a second
   * time (double cost on every addAtom/commitMemory), and (b) worse, the inline
   * vector was DEAD until then, because `vectorIsComparable` rejects a vector
   * with no stamped model.
   */
  #applyEmbedding(episodeId: string, vec: number[], provider: EmbeddingProvider): void {
    const identity = providerIdentity(provider);
    this.db.update(schema.memoryEpisodes)
      .set({
        embedding: vec as unknown as null,
        embeddingModel: identity.model,
        embeddingDims: identity.dims,
        needsReembed: false,
      })
      .where(eq(schema.memoryEpisodes.id, episodeId))
      .run();
  }

  /**
   * One-shot cleanup of pre-formation pollution (§P4). Re-runs the deterministic
   * gate over existing run-promoted episodes and archives the ones that are
   * structural garbage (table rows, URLs, first-person narration, junk that
   * scores below the formation floor). Reversible: rows are archived with a
   * reason, never hard-deleted. `dryRun` returns counts without writing.
   */
  quarantineRunPromotionJunk(workspaceId: string, options: { dryRun?: boolean; limit?: number } = {}): { scanned: number; quarantined: number; dryRun: boolean } {
    const dryRun = options.dryRun ?? false;
    const limit = Math.min(Math.max(options.limit ?? 5000, 1), 20000);
    const rows = this.db.select({
      id: schema.memoryEpisodes.id,
      title: schema.memoryEpisodes.title,
      summary: schema.memoryEpisodes.summary,
      tags: schema.memoryEpisodes.tags,
      metadata: schema.memoryEpisodes.metadata,
    })
      .from(schema.memoryEpisodes)
      .where(and(
        eq(schema.memoryEpisodes.workspaceId, workspaceId),
        eq(schema.memoryEpisodes.source, 'run_promotion'),
        isNull(schema.memoryEpisodes.archivedAt),
      ))
      .limit(limit)
      .all();

    let quarantined = 0;
    const now = new Date().toISOString();
    for (const row of rows) {
      const tags = parseJsonArray<string>(row.tags);
      // 'consolidated' atoms were formed by the judge — trust them.
      if (tags.includes('consolidated')) continue;
      const text = `${row.summary}`.trim();
      const isJunk = isRejectable(text) || scoreStatement(text) < FORMATION_MIN_SCORE;
      if (!isJunk) continue;
      quarantined += 1;
      if (dryRun) continue;
      // Preserve provenance — only annotate the archive reason.
      const metadata = { ...parseJsonRecord(row.metadata), archivedReason: 'formation_backfill' };
      this.db.update(schema.memoryEpisodes)
        .set({ status: 'archived', archivedAt: now, updatedAt: now, metadata })
        .where(eq(schema.memoryEpisodes.id, row.id))
        .run();
    }
    if (!dryRun && quarantined > 0) {
      this.logger.info('brain.formation_backfill.quarantined', { workspaceId, scanned: rows.length, quarantined });
    }
    return { scanned: rows.length, quarantined, dryRun };
  }

  /**
   * Build the frozen brain context block injected at agent dispatch (B2 + B7).
   * Records an `atom_injected` quality event per atom so the evaluator
   * feedback loop (Gap14) can later find which atoms shaped the run.
   */
  async buildDispatchContext(args: {
    workspaceId: string;
    scopeId?: string | null;
    /** §C7 — recall the union of these brain scopes (e.g. [appId, agentId]) so an
     * App-owned run sees BOTH the App's brain and the operating agent's own
     * memory — neither scope is amnesic to the other. Falls back to [scopeId]
     * when omitted. Workspace-shared atoms are included by every pass + deduped. */
    scopeIds?: string[];
    agentId?: string | null;
    runId?: string | null;
    taskDescription: string;
    limit?: number;
    /** §C5 — surface hint for multi-scale budget allocation (chat leans working+
     * semantic; a workflow node leans episodic+semantic). Default 'dispatch'. */
    surface?: 'chat' | 'dispatch';
  }): Promise<{ block: string; atomIds: string[]; relevantCount: number }> {
    const limit = Math.min(Math.max(args.limit ?? 6, 1), 12);
    const scopeId = args.scopeId ?? null;
    const embeddingStatus = this.embeddingStatus(args.workspaceId);
    if (embeddingStatus.retrievalPaused) {
      return {
        block: `WORKSPACE BRAIN [embedding migration running | retrieval paused | capacity: ${this.#capacityStatus(args.workspaceId).percent}%]\nBrain retrieval is paused while atoms are re-embedded for the configured provider.`,
        atomIds: [],
        relevantCount: 0,
      };
    }
    // Tier 1 — constitutional: operator-authored binding context (the workspace
    // charter + hard rules). Always injected regardless of query relevance, but
    // bounded by a reserved slot budget and ranked inside it, so it can never
    // crowd out the prompt. A "never email before 9am" rule must be present even
    // when the task never mentions email.
    const constitutionalCap = Math.min(limit, CONSTITUTIONAL_MAX);
    // §C7 — a hard rule the operator (or orchestrator) pinned to ONE specialist's
    // mind (scopeId = agentId) must be honored on every dispatch of that agent,
    // exactly like a workspace charter rule — not left to query-relevance. Pass
    // the dispatched agent's own scopes so scoped governing atoms join the charter.
    const agentScopes = Array.from(new Set(
      [args.agentId ?? null, args.scopeId ?? null, ...(args.scopeIds ?? [])]
        .filter((s): s is string => Boolean(s)),
    ));
    const charter = this.#loadConstitutionalAtoms(args.workspaceId, constitutionalCap, agentScopes);
    const charterIds = new Set(charter.map((c) => c.id));

    // Tier 2 — relevance: everything else, retrieved semantically, filling the
    // budget the charter did not consume. Deduped against the charter.
    const remaining = Math.max(0, limit - charter.length);
    let relevant: BrainSearchResult[] = [];
    // §B2.3 — abstention: when candidates existed but none cleared the grounding
    // floor, we say so explicitly instead of injecting marginal lexical noise as
    // "relevant knowledge". A confident-looking but ungrounded memory is worse
    // than an honest "nothing matched".
    let relevanceAbstained = false;
    let backfillCount = 0;
    if (remaining > 0) {
      // §C7 — recall the union of every brain scope this run belongs to. Each
      // pass returns shared (workspace) + own-scope atoms under team RLS; merging
      // them lets an App-owned run see both the App's brain and the operating
      // agent's private memory. Shared atoms recur across passes and are deduped,
      // keeping the strongest score.
      const scopes = (args.scopeIds && args.scopeIds.length > 0 ? args.scopeIds : [scopeId])
        .filter((s, i, a) => a.indexOf(s) === i);
      const byId = new Map<string, BrainSearchResult>();
      for (const s of scopes) {
        const hits = await this.searchAtoms({
          workspaceId: args.workspaceId,
          scopeId: s,
          query: args.taskDescription,
          scope: s ? 'both' : 'workspace',
          limit: Math.max(remaining * 3, remaining),
          minConfidence: 0,
          // §C7 — the dispatched agent sees shared knowledge + its own private memory.
          requesterScopeId: s,
        });
        for (const hit of hits) {
          const prev = byId.get(hit.id);
          if (!prev || hit.score > prev.score) byId.set(hit.id, hit);
        }
      }
      const rawHits = Array.from(byId.values()).sort((a, b) => b.score - a.score);
      const candidates = rawHits.filter((hit) => !charterIds.has(hit.id));
      const relevanceFloor = dispatchRelevanceFloor(this.#resolveEmbeddingProvider(args.workspaceId).modelId);
      const cleared = candidates.filter((hit) => hit.score >= relevanceFloor || hit.confidence >= 0.74);
      // §C5 — fill the budget across temporal SCALES (working/episodic/semantic)
      // so recency never crowds out durable rules (or vice versa), per surface.
      relevant = selectAcrossScales(cleared, remaining, args.surface ?? 'dispatch');
      relevanceAbstained = candidates.length > 0 && relevant.length === 0;

      // §C2 — Tier-0: when live retrieval left spare budget, backfill with the
      // precomputed working set's query-relevant core atoms (a cheap single-row
      // read, no embedding round-trip). The scope's core knowledge is present
      // even when the live retriever was thin. These pass a much weaker bar
      // (similarity >= 0.08) than the relevance floor above, so they're
      // counted separately — "recalled N" should mean N atoms that actually
      // cleared relevance, not N padded up to the limit to look full.
      if (relevant.length < remaining) {
        const injected = new Set<string>([...charterIds, ...relevant.map((r) => r.id)]);
        for (const s of scopes) {
          if (relevant.length >= remaining) break;
          for (const a of this.getWorkingSet(args.workspaceId, s)) {
            if (relevant.length >= remaining) break;
            if (injected.has(a.id)) continue;
            if (similarity(args.taskDescription, `${a.title} ${a.content}`) < 0.08) continue;
            relevant.push({
              id: a.id,
              kind: (a.kind as KnowledgeAtomKind) ?? 'episode',
              title: a.title,
              content: a.content,
              confidence: clamp01(a.score),
              score: a.score,
              scopeId: s,
              tags: ['working_set'],
              status: null,
              managed: null,
              updatedAt: new Date().toISOString(),
            });
            injected.add(a.id);
            backfillCount += 1;
            relevanceAbstained = false;
          }
        }
      }
    }

    // With no classic atoms AND no Grounding layer there is nothing to compose.
    // When Grounding is wired, fall through — organizational claims can ground a
    // dispatch even before the workspace Brain has formed any atoms.
    if (charter.length === 0 && relevant.length === 0 && !(this.#groundingComposer && args.agentId)) {
      return { block: '', atomIds: [], relevantCount: 0 };
    }

    const atomIds: string[] = [];
    const recordInjected = (entry: BrainSearchResult, tier: 'constitutional' | 'relevance') => {
      atomIds.push(entry.id);
      this.recordQualityEvent({
        workspaceId: args.workspaceId,
        scopeId,
        agentId: args.agentId ?? null,
        runId: args.runId ?? null,
        eventType: 'atom_injected',
        atomId: entry.id,
        metadata: { atomKind: entry.kind, confidence: entry.confidence, retrievalScore: entry.score, tier },
      });
    };
    // §B2.4 — every injected atom carries a stable citation tag [mem:<id8>] so
    // the agent can attribute a claim to the memory it came from (foundation for
    // cited-answer recall, C4).
    const renderLine = (entry: BrainSearchResult) => `- [${entry.kind} · mem:${entry.id.slice(0, 8)}] ${entry.title}: ${entry.content.split('\n').join(' - ')}`;

    const scopeLabel = scopeId ? 'scope + workspace' : 'workspace';
    const capacity = this.#capacityStatus(args.workspaceId);
    const degradedPrefix = embeddingStatus.degraded ? 'degraded - embeddings unavailable | ' : '';
    const total = charter.length + relevant.length;
    const header = `WORKSPACE BRAIN [${degradedPrefix}${total} atoms | scope: ${scopeLabel} | retrieval: graph | capacity: ${capacity.percent}%${capacity.recommended ? ' - compression recommended' : ''}]`;

    const sections: string[] = [header];
    if (charter.length > 0) {
      for (const entry of charter) recordInjected(entry, 'constitutional');
      sections.push(`WORKSPACE RULES & CONTEXT (operator-authored — always honor these):\n${charter.map(renderLine).join('\n')}`);
    }
    if (relevant.length > 0) {
      for (const entry of relevant) recordInjected(entry, 'relevance');
      const synthesis = synthesizePreTaskContext(relevant.map((r) => `${r.title}\n${r.content}`));
      sections.push(`PRE-TASK SYNTHESIS\n${synthesis}\n\nRelevant knowledge from past runs — apply it, but verify against the current task (cite as [mem:id] when you rely on one):\n${relevant.map(renderLine).join('\n')}`);
    } else if (relevanceAbstained) {
      // §B2.3 — honest absence. Only emit when something else (charter/Grounding) is
      // present so the block isn't header-only; the agent is told the brain
      // looked and found nothing, so it won't treat silence as "no rules".
      sections.push('PRE-TASK MEMORY: no durable memory matched this task — proceed from first principles and the current inputs; do not assume prior context exists. If the task turns out to need something specific from memory, call agentis.brain.search with different or broader terms before concluding nothing exists — this upfront pass can miss things a targeted re-query finds.');
    }
    // Surfacing an episode into a live dispatch is the strongest possible signal
    // that it is still useful. Bump lastAccessedAt so adaptive forgetting
    // (BrainMaintenanceService) and compression don't stale-mark memory that the
    // engine actually relies on — the standalone graph view is not the only path
    // that should count as "accessed".
    this.#markEpisodesAccessed(relevant.filter((entry) => entry.kind === 'episode').map((entry) => entry.id));

    // Tier 3 — Grounding organizational layer (workspace claims, grant-gated +
    // influence-audited). Sits BELOW the constitutional and relevance tiers in
    // the §12.2 composition order: workspace policy > owner instruction >
    // organizational knowledge. Failure here never breaks dispatch.
    if (this.#groundingComposer && args.agentId) {
      try {
        const grounding = this.#groundingComposer.composeForDispatch({
          workspaceId: args.workspaceId,
          agentId: args.agentId,
          runId: args.runId ?? null,
          taskDescription: args.taskDescription,
        });
        if (grounding.block) sections.push(grounding.block);
      } catch (error) {
        this.logger.warn('brain.grounding_context_failed', {
          workspaceId: args.workspaceId,
          agentId: args.agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Header-only (no atoms, no Grounding content) composes to nothing.
    if (charter.length === 0 && relevant.length === 0 && sections.length <= 1) {
      return { block: '', atomIds: [], relevantCount: 0 };
    }
    return { block: sections.join('\n'), atomIds, relevantCount: atomIds.length - backfillCount };
  }

  /**
   * Bump `lastAccessedAt` for the given episodes. Centralized so every retrieval
   * path that surfaces an episode (dispatch context + the graph view) records
   * access consistently — the access signal adaptive forgetting depends on.
   */
  #markEpisodesAccessed(episodeIds: string[]): void {
    if (episodeIds.length === 0) return;
    this.db.update(schema.memoryEpisodes)
      .set({ lastAccessedAt: new Date().toISOString() })
      .where(inArray(schema.memoryEpisodes.id, episodeIds))
      .run();
  }

  /**
   * §B2.2 — structured model rerank. Reorders the cheap-ranked candidates by how
   * directly each helps the task. Robust to a bad/partial model response: any
   * candidate the model omits is appended in its original order, and any failure
   * returns the input unchanged. Only invoked when a rerank completer is wired.
   */
  async #modelRerank<T extends { atom: { node: { label: string } }; text: string }>(query: string, items: T[]): Promise<T[]> {
    const completer = this.#rerankCompleter;
    if (!completer) return items;
    const block = items.map((it, i) => `[${i}] ${it.atom.node.label}: ${it.text.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n');
    try {
      const parsed = await completer.completeStructured<{ order?: number[] }>({
        system: 'You rerank retrieved memory candidates by how DIRECTLY each helps the given task. Return JSON {"order":[indices]} — candidate indices best-first. Use only the indices provided.',
        user: `TASK: ${query}\n\nCANDIDATES:\n${block}\n\nReturn JSON only: {"order":[<indices best-first>]}`,
        maxTokens: 200,
        maxAttempts: 2,
      });
      const order = Array.isArray(parsed?.order) ? parsed!.order : null;
      if (!order) return items;
      const seen = new Set<number>();
      const reordered: T[] = [];
      for (const idx of order) {
        if (Number.isInteger(idx) && idx >= 0 && idx < items.length && !seen.has(idx)) {
          seen.add(idx);
          reordered.push(items[idx]!);
        }
      }
      for (let i = 0; i < items.length; i++) if (!seen.has(i)) reordered.push(items[i]!);
      return reordered;
    } catch {
      return items;
    }
  }

  /**
   * §B1.3 — flag episodes whose stored vector no longer matches the workspace
   * provider so the re-embed sweep (§B1.4) repairs them. Best-effort; never
   * throws into the retrieval path.
   */
  #flagNeedsReembed(workspaceId: string, episodeIds: string[]): void {
    if (episodeIds.length === 0) return;
    try {
      this.db.update(schema.memoryEpisodes)
        .set({ needsReembed: true })
        .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), inArray(schema.memoryEpisodes.id, episodeIds)))
        .run();
    } catch (err) {
      this.logger.warn('brain.flag_reembed_failed', { workspaceId, message: (err as Error).message });
    }
  }

  /**
   * §B1.4 — re-embed only the episodes flagged `needsReembed` (incremental sweep,
   * called by BrainMaintenanceService). Stamps the current provider identity and
   * clears the flag. Bounded per call so it never stalls maintenance.
   */
  async reembedPending(workspaceId: string, limit = 200): Promise<{ reembedded: number; failed: number }> {
    const existing = this.#reembedOperations.get(workspaceId);
    if (existing) return existing;
    const operation = this.#reembedPendingBatch(workspaceId, limit).finally(() => {
      if (this.#reembedOperations.get(workspaceId) === operation) this.#reembedOperations.delete(workspaceId);
    });
    this.#reembedOperations.set(workspaceId, operation);
    return operation;
  }

  async #reembedPendingBatch(workspaceId: string, limit: number): Promise<{ reembedded: number; failed: number }> {
    const provider = this.#resolveEmbeddingProvider(workspaceId);
    const rows = this.db.select().from(schema.memoryEpisodes)
      .where(and(
        eq(schema.memoryEpisodes.workspaceId, workspaceId),
        eq(schema.memoryEpisodes.needsReembed, true),
        isNull(schema.memoryEpisodes.archivedAt),
      ))
      .limit(limit)
      .all();
    let reembedded = 0;
    let failed = 0;
    // The model is known-unavailable and still cooling down — skip this cycle
    // SILENTLY. Attempting (and logging) every cycle is what floods the console.
    if (rows.length > 0 && isEmbeddingModelCoolingDown(provider)) return { reembedded, failed };
    for (const row of rows) {
      try {
        const embedding = await embedText(provider, `${row.title} ${row.summary}`);
        this.db.update(schema.memoryEpisodes)
          .set({
            embedding: embedding as unknown as null,
            embeddingModel: provider.modelId,
            embeddingDims: provider.dimension,
            needsReembed: false,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schema.memoryEpisodes.id, row.id))
          .run();
        reembedded += 1;
      } catch (err) {
        failed += 1;
        // The model being unavailable is a WHOLE-SWEEP condition, not a per-row
        // one: every remaining row would fail identically. Log once and stop —
        // logging per row is what flooded operators' consoles endlessly.
        if (isEmbeddingModelUnavailable(err)) {
          this.logger.warn('brain.reembed_paused', {
            workspaceId,
            pending: rows.length - reembedded,
            message: (err as Error).message,
          });
          break;
        }
        this.logger.warn('brain.reembed_pending_failed', { workspaceId, atomId: row.id, message: (err as Error).message });
      }
    }
    return { reembedded, failed };
  }

  /**
   * Constitutional atoms — operator-authored binding context that injects on
   * every dispatch. An atom qualifies when it is operator-sourced AND governing:
   * a hard `rule`, a high-importance statement (≥0.8), or tagged `charter`
   * (how authored workspace/decisions/workflow context is stored). Ranked by
   * importance × trust × recency and capped, so the most binding survive.
   */
  #loadConstitutionalAtoms(workspaceId: string, cap: number, scopeIds: string[] = []): BrainSearchResult[] {
    if (cap <= 0) return [];
    const now = Date.now();

    // §B4 — one substrate. Operator-authored / governing episodes (workspace
    // memory now lives here too) inject as constitutional, so a hard rule is
    // honored on every dispatch regardless of how it was authored.
    // §C7 — workspace-scoped charter (scopeId NULL) is always included; when a
    // dispatch names the operating agent's own scope(s), scoped governing rules
    // (a guardrail pinned to that specialist's mind) join it so they are honored
    // every turn for that agent, not only when query-relevant.
    const scopeFilter = scopeIds.length > 0
      ? or(isNull(schema.memoryEpisodes.scopeId), inArray(schema.memoryEpisodes.scopeId, scopeIds))
      : isNull(schema.memoryEpisodes.scopeId);
    const epRows = this.db.select().from(schema.memoryEpisodes)
      .where(and(
        eq(schema.memoryEpisodes.workspaceId, workspaceId),
        scopeFilter,
        isNull(schema.memoryEpisodes.archivedAt),
        inArray(schema.memoryEpisodes.source, ['operator_write', 'seed', 'system_write']),
      ))
      .orderBy(desc(schema.memoryEpisodes.updatedAt))
      .limit(300)
      .all();

    const seen = new Set<string>();
    const candidates = epRows
      .filter((r) => r.status !== 'archived')
      .filter((r) => {
        const tags = parseJsonArray<string>(r.tags);
        return Boolean(r.governing) || (Number(r.importance) || 0) >= 0.8 || tags.includes('charter') || tags.includes('rule');
      })
      .filter((r) => {
        const key = tokenize(r.summary).slice(0, 16).join(' ');
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    return candidates
      .map((r) => {
        const importance = Number(r.importance) || 0;
        const trust = Number(r.trust) || 0;
        const ageDays = (now - Date.parse(r.reinforcedAt ?? r.updatedAt)) / 86_400_000;
        const recency = Number.isFinite(ageDays) ? (ageDays <= 30 ? 1 : ageDays <= 120 ? 0.9 : 0.8) : 0.9;
        const score = (0.5 + 0.5 * importance) * (0.5 + 0.5 * trust) * recency;
        return { r, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, cap)
      .map(({ r }) => ({
        id: r.id,
        kind: 'memory' as const,
        title: r.title,
        content: r.summary,
        confidence: clamp01(Number(r.trust) || 0),
        score: 1,
        scopeId: r.scopeId ?? null,
        tags: parseJsonArray<string>(r.tags),
        status: null,
        managed: null,
        updatedAt: r.updatedAt,
      }));
  }

  /**
   * Evaluator ? brain feedback loop (Gap14). At verdict time, look up which
   * atoms were injected into the run and nudge their confidence. This is the
   * gradient that makes the brain self-regulating rather than write-only.
   */
  applyEvaluatorVerdict(args: {
    workspaceId: string;
    runId: string;
    scopeId?: string | null;
    agentId?: string | null;
    verdict: 'pass' | 'fail' | 'partial';
    evaluatorConfidence?: number | null;
    /** The text the evaluator actually judged. When present, an atom's delta
     * is weighted by whether the response cited it ([mem:id8]) — an atom that
     * was merely injected but never relied on shouldn't earn full credit or
     * blame. Omit to keep the old injection-order-only behavior. */
    responseText?: string | null;
  }): { adjusted: number; archived: number } {
    if (args.verdict === 'partial') return { adjusted: 0, archived: 0 };
    const injected = this.db
      .select({ atomId: schema.brainQualityEvents.atomId })
      .from(schema.brainQualityEvents)
      .where(and(
        eq(schema.brainQualityEvents.workspaceId, args.workspaceId),
        eq(schema.brainQualityEvents.runId, args.runId),
        eq(schema.brainQualityEvents.eventType, 'atom_injected'),
      ))
      .all();
    const atomIds = [...new Set(injected.map((r) => r.atomId).filter((id): id is string => !!id))];
    if (atomIds.length === 0) return { adjusted: 0, archived: 0 };

    const strongPass = args.verdict === 'pass' && (args.evaluatorConfidence ?? 0) > 0.85;
    const citedPrefixes = extractCitedMemPrefixes(args.responseText);
    const isCited = citedPrefixes
      ? (atomId: string) => citedPrefixes.some((prefix) => atomId.toLowerCase().startsWith(prefix))
      : null;
    let adjusted = 0;
    let archived = 0;

    atomIds.forEach((atomId, index) => {
      let delta = args.verdict === 'pass' ? EVAL_DELTA_PASS : EVAL_DELTA_FAIL;
      if (isCited) {
        // Usage-based weighting supersedes the old order-based "strong pass
        // top 3" bonus — that heuristic only existed as a proxy for relevance
        // when we had no real usage signal.
        if (!isCited(atomId)) delta *= EVAL_DELTA_UNCITED_FACTOR;
      } else if (strongPass && index < 3) {
        delta = EVAL_DELTA_PASS_TOP;
      }
      const now = new Date().toISOString();

      const episode = this.db.select().from(schema.memoryEpisodes)
        .where(and(eq(schema.memoryEpisodes.workspaceId, args.workspaceId), eq(schema.memoryEpisodes.id, atomId)))
        .get();
      if (episode) {
        const next = clamp01(Number(episode.confidence) + delta);
        const archiveIt = next < ARCHIVE_CONFIDENCE_FLOOR && episode.managed;
        this.db.update(schema.memoryEpisodes)
          .set({
            confidence: String(next),
            updatedAt: now,
            ...(archiveIt ? { status: 'archived', archivedAt: now } : {}),
          })
          .where(eq(schema.memoryEpisodes.id, atomId))
          .run();
        adjusted += 1;
        if (archiveIt) archived += 1;
        this.recordQualityEvent({
          workspaceId: args.workspaceId,
          scopeId: args.scopeId ?? null,
          agentId: args.agentId ?? null,
          runId: args.runId,
          eventType: 'atom_confidence_delta',
          atomId,
          delta,
          ...(isCited ? { metadata: { used: isCited(atomId) } } : {}),
        });
        return;
      }
      // §B4 — all atoms are episodes now; an unmatched id is simply gone.
    });

    this.recordQualityEvent({
      workspaceId: args.workspaceId,
      scopeId: args.scopeId ?? null,
      agentId: args.agentId ?? null,
      runId: args.runId,
      eventType: args.verdict === 'pass' ? 'evaluator_pass' : 'evaluator_fail',
    });

    if (adjusted || archived) {
      this.logger.info('collective_brain.evaluator_feedback.applied', {
        workspaceId: args.workspaceId,
        runId: args.runId,
        verdict: args.verdict,
        adjusted,
        archived,
      });
    }
    return { adjusted, archived };
  }

  /** Record a brain quality event (Appendix C). Never throws. */
  recordQualityEvent(event: {
    workspaceId: string;
    scopeId?: string | null;
    agentId?: string | null;
    runId?: string | null;
    eventType: string;
    atomId?: string | null;
    abilityId?: string | null;
    delta?: number | null;
    metadata?: Record<string, unknown> | null;
  }): void {
    try {
      this.db.insert(schema.brainQualityEvents).values({
        id: randomUUID(),
        workspaceId: event.workspaceId,
        scopeId: event.scopeId ?? null,
        agentId: event.agentId ?? null,
        eventType: event.eventType,
        atomId: event.atomId ?? null,
        abilityId: event.abilityId ?? null,
        runId: event.runId ?? null,
        delta: event.delta ?? null,
        metadata: event.metadata ?? {},
        createdAt: new Date().toISOString(),
      }).run();
    } catch (err) {
      this.logger.warn('collective_brain.quality_event.failed', { message: (err as Error).message });
    }
  }

  /**
   * §C2 — sleep-time precompute. Rebuild the per-scope working set: the top
   * durable atoms by importance×trust×recency (query-free), cached so the
   * injector can serve a scope's core knowledge cheaply. Called from the
   * reflection pass, off the hot path. Returns the cached count.
   */
  rebuildWorkingSet(workspaceId: string, scopeId: string | null, limit = 10): number {
    const conds = [
      eq(schema.memoryEpisodes.workspaceId, workspaceId),
      isNull(schema.memoryEpisodes.archivedAt),
      isNull(schema.memoryEpisodes.supersededBy),
      eq(schema.memoryEpisodes.status, 'active'),
      scopeId ? eq(schema.memoryEpisodes.scopeId, scopeId) : isNull(schema.memoryEpisodes.scopeId),
    ];
    const rows = this.db.select().from(schema.memoryEpisodes).where(and(...conds)).limit(400).all()
      .filter((r) => !parseJsonArray<string>(r.tags).includes('plane:workspace_memory'));
    const now = Date.now();
    const scored = rows.map((r) => {
      const trust = Number(r.trust) || 0;
      const importance = Number(r.importance) || 0;
      const ageDays = (now - Date.parse(r.reinforcedAt ?? r.updatedAt)) / 86_400_000;
      const freshness = Number.isFinite(ageDays) ? Math.max(0.3, Math.exp(-ageDays / 180)) : 0.9;
      return { r, score: trust * (0.5 + 0.5 * importance) * freshness };
    }).sort((a, b) => b.score - a.score).slice(0, limit);
    const atoms = scored.map(({ r, score }) => ({ id: r.id, title: r.title, content: r.summary, kind: 'episode', score: Number(score.toFixed(4)) }));
    const now2 = new Date().toISOString();
    const existing = this.db.select({ id: schema.brainWorkingSet.id }).from(schema.brainWorkingSet)
      .where(and(eq(schema.brainWorkingSet.workspaceId, workspaceId), scopeId ? eq(schema.brainWorkingSet.scopeId, scopeId) : isNull(schema.brainWorkingSet.scopeId)))
      .get();
    if (existing) {
      this.db.update(schema.brainWorkingSet).set({ atoms, atomCount: atoms.length, builtAt: now2 }).where(eq(schema.brainWorkingSet.id, existing.id)).run();
    } else {
      this.db.insert(schema.brainWorkingSet).values({ id: randomUUID(), workspaceId, scopeId, atoms, atomCount: atoms.length, builtAt: now2 }).run();
    }
    return atoms.length;
  }

  /** §C2 — read the cached working set for a scope (Tier-0 core knowledge). */
  getWorkingSet(workspaceId: string, scopeId: string | null): Array<{ id: string; title: string; content: string; kind: string; score: number }> {
    const row = this.db.select({ atoms: schema.brainWorkingSet.atoms }).from(schema.brainWorkingSet)
      .where(and(eq(schema.brainWorkingSet.workspaceId, workspaceId), scopeId ? eq(schema.brainWorkingSet.scopeId, scopeId) : isNull(schema.brainWorkingSet.scopeId)))
      .get();
    if (!row) return [];
    const atoms = row.atoms;
    return Array.isArray(atoms) ? atoms as Array<{ id: string; title: string; content: string; kind: string; score: number }> : [];
  }

  async searchAtoms(args: {
    workspaceId: string;
    scopeId?: string | null;
    query: string;
    scope?: 'workspace' | 'scoped' | 'both';
    limit?: number;
    minConfidence?: number;
    /** Restrict to these atom kinds. Passing an allowlist disables the default
     * skill-library exclusion (the caller has opted in explicitly). */
    kinds?: KnowledgeAtomKind[];
    /** Kinds to omit. Defaults to `['skill','example']` when no `kinds` allowlist
     * is given, so generic/auto-inject search never surfaces Skill-library atoms. */
    excludeKinds?: KnowledgeAtomKind[];
    /** §C7 — when set, retrieval enforces team RLS (shared + own-scope only). */
    requesterScopeId?: string | null;
  }): Promise<BrainSearchResult[]> {
    if (this.embeddingStatus(args.workspaceId).retrievalPaused) return [];
    const limit = Math.min(Math.max(args.limit ?? 5, 1), 25);
    const scopeId = args.scopeId ?? null;
    const graphScope: BrainGraphScope = args.scope === 'scoped' || (args.scope === 'both' && scopeId) ? 'scoped' : 'workspace';
    // Skill-library atoms are never surfaced by generic search unless the caller
    // opts in (via an explicit `kinds` allowlist or `excludeKinds`).
    const excludeKinds = args.excludeKinds ?? (args.kinds ? [] : SKILL_LIBRARY_KINDS);
    const atoms = this.loadAtoms(args.workspaceId, {
      scope: graphScope,
      scopeId,
      includeWorkspace: args.scope === 'both' || graphScope === 'workspace',
      limit: MAX_GRAPH_LIMIT,
      // §B5.7 — score against coverage, not against the most recent 125 rows.
      perKind: RETRIEVAL_CANDIDATE_CAP,
      minConfidence: args.minConfidence ?? 0,
      ...(args.kinds ? { kinds: args.kinds } : {}),
      excludeKinds,
      ...('requesterScopeId' in args ? { requesterScopeId: args.requesterScopeId } : {}),
    });
    if (atoms.length === 0) return [];

    const provider = this.#resolveEmbeddingProvider(args.workspaceId);
    const semantic = !provider.modelId.startsWith('hashing');
    let queryVec: number[] | null = null;
    try {
      queryVec = await embedText(provider, args.query);
    } catch {
      queryVec = null;
    }

    // §0.1/§3.4/§B1.2 — score EVERY loaded atom from the vector it already carries
    // (bounded to the ≤MAX_GRAPH_LIMIT atoms `loadAtoms` returned — no second
    // full-workspace embedding scan). A stored vector is only used when COMPARABLE
    // to the query provider: episodes carry model+dims provenance, so a
    // stale-embedded one is detected + flagged for re-embed; chunks (no provenance
    // columns) are written by the single workspace provider, so an equal dimension
    // is sufficient comparability.
    //
    // HYBRID recall: an atom with no comparable embedding (e.g. an operator-
    // inserted memory that hasn't been embedded yet, or a mixed-provider vector) is
    // rescued by lexical overlap instead of being silently invisible — recall must
    // never drop a stored fact just because its vector is missing. For embedded
    // atoms we take max(semantic, lexical) so a strong literal match ("what's my
    // name" ↔ "My name is Jordan Lee") is never buried below the relevance floor.
    const staleIds: string[] = [];
    const scored = atoms
      .map((atom) => {
        let vec: number[] | null = null;
        const stored = atom.embedding ?? null;
        if (queryVec && stored && stored.length === queryVec.length) {
          const hasProvenance = atom.embeddingModel != null || atom.embeddingDims != null;
          if (!hasProvenance || vectorIsComparable(atom.embeddingModel ?? null, atom.embeddingDims ?? null, provider)) {
            vec = stored;
          } else if (semantic && atom.kind === 'episode') {
            staleIds.push(atom.id);
          }
        } else if (queryVec && semantic && atom.kind === 'episode' && !stored) {
          // Episode never embedded (deferred async write) → nudge a re-embed.
          staleIds.push(atom.id);
        }
        const semScore = vec ? cosineSimilarity(queryVec!, vec) : 0;
        const lexScore = similarity(args.query, atom.text);
        const score = Math.max(semScore, lexScore >= LEXICAL_RECALL_FLOOR ? lexScore : 0);
        return { atom, score, text: atom.text, vec };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
    if (staleIds.length > 0) {
      this.#flagNeedsReembed(args.workspaceId, staleIds);
      this.recordQualityEvent({
        workspaceId: args.workspaceId,
        scopeId,
        eventType: 'retrieval_degraded',
        metadata: { reason: 'mixed_dims', staleCount: staleIds.length, provider: provider.modelId },
      });
    }
    // §B2.2 — diversify the top-K so near-duplicate atoms don't eat the budget.
    let ranked = mmrSelect(scored, limit, MMR_LAMBDA);
    // §B2.2 — optional model rerank (off unless an operator wired a completer).
    if (this.#rerankCompleter && ranked.length > 2) {
      ranked = await this.#modelRerank(args.query, ranked);
    }

    this.#markEpisodesAccessed(ranked.filter(({ atom }) => atom.kind === 'episode').map(({ atom }) => atom.id));

    return ranked.map(({ atom, score }) => ({
      id: atom.id,
      kind: atom.kind,
      title: atom.node.label,
      content: atom.node.summary ?? atom.text,
      confidence: atom.node.confidence,
      score,
      scopeId: atom.node.scopeId ?? null,
      tags: parseJsonArray<string>(atom.node.metadata.tags),
      status: atom.node.status ?? null,
      managed: atom.node.managed ?? null,
      updatedAt: atom.node.updatedAt,
    }));
  }

  /**
   * Commit a CONSOLIDATED atom into a scope, reinforcing a near-duplicate in that
   * same scope instead of writing a second copy.
   *
   * This is the durable-write seam for callers that KNOW the fact is worth keeping
   * — an App/workflow's graded run outcome, a closed relationship's lesson — as
   * opposed to `promote()`, which mines untrusted agent prose and therefore stages
   * everything as `unconsolidated` (and `loadAtoms` hides those from the graph).
   * Without this, a scope fed only by `promote()` can never show a single node.
   *
   * Dedup is scope-STRICT: only atoms already owned by `scopeId` can absorb the
   * reinforcement, so a similar workspace-wide atom can't silently swallow it and
   * leave the scope empty. Repeated outcomes therefore converge onto one strong
   * node per lesson rather than one node per run.
   */
  async commitDurableAtom(args: {
    workspaceId: string;
    scopeId: string | null;
    agentId?: string | null;
    workflowId?: string | null;
    runId?: string | null;
    title: string;
    content: string;
    type?: RuntimeEpisodeType;
    source?: 'agent_write' | 'operator_write' | 'system_write' | 'run_promotion' | 'evaluator_write';
    tags?: string[];
    confidence?: number;
    importance?: number;
    outcomeStatus?: RuntimeEpisodeOutcome;
    metadata?: Record<string, unknown>;
  }): Promise<{ atomId: string; created: boolean; reinforced: boolean }> {
    // §Mem0-teardown-followup — this path (App Brain / operator-composed
    // lessons) previously had a dedup check but no garbage-rejection gate, the
    // one half of the Stage-1 filter `promote()` applies to chat-mined prose.
    // Callers here compose curated text via templates, not raw agent output,
    // so this rarely fires — it's a cheap backstop, not the primary defense.
    if (isRejectable(args.content)) {
      return { atomId: '', created: false, reinforced: false };
    }
    const provider = this.#resolveEmbeddingProvider(args.workspaceId);
    const text = `${args.title}\n${args.content}`;
    let vec: number[] | null = null;
    try { vec = await embedText(provider, args.content); } catch { /* embedding optional */ }

    const existing = this.#loadEpisodeVectors(args.workspaceId, args.scopeId, true);
    // §B5.5 — scope-strict resolution. Only a provably identical statement
    // collapses into a reinforcement; a merely-similar one is written and
    // flagged, because an App that changes a rule between runs must not have
    // the new rule absorbed into the old one.
    const verdict = resolveDuplicate({ text, vec, existing });
    if (verdict.kind === 'duplicate') {
      const node = this.reinforceAtom(args.workspaceId, 'episode', verdict.entry.id, {
        agentId: args.agentId ?? null,
        runId: args.runId ?? null,
        scopeId: args.scopeId,
      });
      if (node) {
        this.publishAtom(args.workspaceId, REALTIME_EVENTS.BRAIN_ATOM_REINFORCED, node);
        return { atomId: verdict.entry.id, created: false, reinforced: true };
      }
    }

    const pacer = classifyPacer({ text: args.content, surface: 'run_completion', episodeType: args.type ?? 'distilled_lesson' });
    const episode = this.episodes.write({
      workspaceId: args.workspaceId,
      scopeId: args.scopeId,
      workflowId: args.workflowId ?? null,
      runId: args.runId ?? null,
      agentId: args.agentId ?? null,
      type: args.type ?? 'distilled_lesson',
      title: args.title,
      summary: args.content,
      source: args.source ?? 'system_write',
      confidence: clamp01(args.confidence ?? 0.7),
      importance: clamp01(args.importance ?? 0.65),
      trust: clamp01(args.confidence ?? 0.7),
      // `consolidated` is what keeps this atom OUT of the unconsolidated filter
      // that hides staged traces from the graph — i.e. what makes it render.
      tags: ['consolidated', `pacer:${pacer.pacerClass}`, ...(args.tags ?? [])],
      outcomeStatus: args.outcomeStatus ?? 'mixed',
      metadata: {
        ...(args.metadata ?? {}),
        pacerClass: pacer.pacerClass,
        originSurface: 'run_completion',
        formationMode: 'durable_commit',
        embeddingProvider: provider.dimension,
      },
    });
    if (vec) this.#applyEmbedding(episode.id, vec, provider);
    this.publishAtom(args.workspaceId, REALTIME_EVENTS.BRAIN_ATOM_CREATED, episodeToGraphNode(episode, 1));
    return { atomId: episode.id, created: true, reinforced: false };
  }

  async addAtom(args: {
    workspaceId: string;
    scopeId?: string | null;
    workflowId?: string | null;
    runId?: string | null;
    agentId?: string | null;
    content: string;
    title?: string;
    tags?: string[];
    confidence?: number;
    source?: 'agent_write' | 'operator_write' | 'system_write' | 'run_promotion' | 'evaluator_write';
    managed?: boolean;
    metadata?: Record<string, unknown>;
    compressionTier?: number | null;
    compressedFrom?: string[] | null;
    /** §C7 — team visibility. Default shared; pass false for private memory. */
    shared?: boolean;
  }): Promise<BrainSearchResult> {
    const provider = this.#resolveEmbeddingProvider(args.workspaceId);
    let embedding: number[] | null = null;
    try {
      embedding = await embedText(provider, args.content);
    } catch {
      embedding = null;
    }

    const episode = this.episodes.write({
      workspaceId: args.workspaceId,
      scopeId: args.scopeId ?? null,
      workflowId: args.workflowId ?? null,
      runId: args.runId ?? null,
      agentId: args.agentId ?? null,
      type: 'distilled_lesson',
      title: args.title ?? titleFromFact(args.content),
      summary: args.content,
      source: args.source ?? 'agent_write',
      confidence: clamp01(args.confidence ?? 0.7),
      importance: 0.6,
      trust: 0.65,
      tags: args.tags ?? [],
      entities: [],
      outcomeStatus: 'mixed',
      metadata: args.metadata ?? {},
    });

    const update: Record<string, unknown> = {
      managed: args.managed ?? (args.source !== 'operator_write'),
      ...(embedding ? { embedding } : {}),
      ...(args.compressionTier ? { compressionTier: args.compressionTier } : {}),
      ...(args.compressedFrom ? { compressedFrom: args.compressedFrom } : {}),
      ...(args.shared === false ? { shared: false } : {}),
    };
    this.db.update(schema.memoryEpisodes)
      .set(update)
      .where(eq(schema.memoryEpisodes.id, episode.id))
      .run();

    const node = episodeToGraphNode({ ...episode, metadata: args.metadata ?? {} }, 1);
    this.publishAtom(args.workspaceId, REALTIME_EVENTS.BRAIN_ATOM_CREATED, node);
    return {
      id: episode.id,
      kind: 'episode',
      title: episode.title,
      content: episode.summary,
      confidence: episode.confidence,
      score: 1,
      scopeId: episode.scopeId ?? null,
      tags: episode.tags,
      status: 'active',
      managed: update.managed as boolean,
      updatedAt: episode.updatedAt,
    };
  }

  async reembedWorkspaceAtoms(workspaceId: string, requestId: string | null = null): Promise<{ atomsReembedded: number; failed: number }> {
    const startedAt = new Date().toISOString();
    this.#setEmbeddingMigration(workspaceId, {
      status: 'running',
      requestId,
      startedAt,
      atomsReembedded: 0,
      failed: 0,
    });
    this.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.BRAIN_EMBEDDING_MIGRATION_STARTED, {
      workspaceId,
      requestId,
      startedAt,
    });
    this.invalidateEmbeddingProvider(workspaceId);
    const provider = this.#resolveEmbeddingProvider(workspaceId);
    const rows = this.db.select().from(schema.memoryEpisodes)
      .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), isNull(schema.memoryEpisodes.archivedAt)))
      .all()
      .filter((row) => row.status !== 'archived');
    let atomsReembedded = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const embedding = await embedText(provider, `${row.title} ${row.summary}`);
        this.db.update(schema.memoryEpisodes)
          .set({
            embedding,
            embeddingModel: provider.modelId,
            embeddingDims: provider.dimension,
            needsReembed: false,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schema.memoryEpisodes.id, row.id))
          .run();
        atomsReembedded += 1;
      } catch (err) {
        failed += 1;
        this.logger.warn('collective_brain.reembed_atom_failed', { workspaceId, atomId: row.id, message: (err as Error).message });
      }
    }
    this.#setEmbeddingMigration(workspaceId, {
      status: failed > 0 ? 'completed_with_errors' : 'completed',
      requestId,
      startedAt,
      completedAt: new Date().toISOString(),
      atomsReembedded,
      failed,
    });
    this.recordQualityEvent({
      workspaceId,
      eventType: 'brain_embedding_migration_completed',
      metadata: { requestId, atomsReembedded, failed },
    });
    this.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.BRAIN_EMBEDDING_MIGRATION_COMPLETED, {
      workspaceId,
      requestId,
      atomsReembedded,
      failed,
    });
    return { atomsReembedded, failed };
  }

  summarize(args: { workspaceId: string; scopeId?: string | null; sessionId?: string | null }): BrainSummary {
    const rows = this.db.select().from(schema.memoryEpisodes)
      .where(and(eq(schema.memoryEpisodes.workspaceId, args.workspaceId), isNull(schema.memoryEpisodes.archivedAt)))
      .all()
      .filter((row) => row.status !== 'archived');
    const scopedRows = args.scopeId ? rows.filter((row) => row.scopeId === args.scopeId) : [];
    const workspaceRows = rows.filter((row) => !row.scopeId);
    const sessionRows = args.sessionId
      ? this.db.select().from(schema.sessionMoments)
          .where(and(eq(schema.sessionMoments.workspaceId, args.workspaceId), eq(schema.sessionMoments.sessionId, args.sessionId)))
          .all()
      : [];
    const maintenance = this.db.select().from(schema.brainQualityEvents)
      .where(and(
        eq(schema.brainQualityEvents.workspaceId, args.workspaceId),
        eq(schema.brainQualityEvents.eventType, 'brain_maintenance_completed'),
      ))
      .orderBy(desc(schema.brainQualityEvents.createdAt))
      .limit(1)
      .get();
    const maintenanceMeta = parseJsonRecord(maintenance?.metadata);
    return {
      workspaceIntelligence: summarizeRows(workspaceRows),
      scopedBrain: summarizeRows(scopedRows),
      SessionMoments: {
        count: sessionRows.length,
        capacityTokens: estimateTokens(sessionRows.map((row) => row.content).join('\n')),
      },
      compressionStatus: {
        lastRunAt: maintenance?.createdAt ?? null,
        atomsArchived: typeof maintenanceMeta.atomsArchived === 'number' ? maintenanceMeta.atomsArchived : 0,
        nextTriggerAt: typeof maintenanceMeta.nextTriggerAt === 'string' ? maintenanceMeta.nextTriggerAt : null,
      },
    };
  }

  flagDispute(args: {
    workspaceId: string;
    atomIdA: string;
    atomIdB: string;
    reason: string;
    scopeId?: string | null;
  }): { linkId: string | null } {
    const now = new Date().toISOString();
    const link = this.createLink({
      workspaceId: args.workspaceId,
      sourceId: args.atomIdA,
      sourceKind: 'episode',
      targetId: args.atomIdB,
      targetKind: 'episode',
      relation: 'contradicts',
      confidence: 0.78,
      scopeId: args.scopeId ?? null,
    });
    this.db.update(schema.memoryEpisodes)
      .set({ isDisputed: true, disputeReason: args.reason, updatedAt: now })
      .where(and(eq(schema.memoryEpisodes.workspaceId, args.workspaceId), or(eq(schema.memoryEpisodes.id, args.atomIdA), eq(schema.memoryEpisodes.id, args.atomIdB))!))
      .run();
    this.bus.publish(REALTIME_ROOMS.workspace(args.workspaceId), REALTIME_EVENTS.BRAIN_DISPUTE_FLAGGED, {
      workspaceId: args.workspaceId,
      scopeId: args.scopeId ?? null,
      atomIds: [args.atomIdA, args.atomIdB],
      reason: args.reason,
    });
    return { linkId: link?.id ?? null };
  }

  listDisputes(workspaceId: string, options: { scopeId?: string | null; includeSnoozed?: boolean } = {}) {
    const now = new Date().toISOString();
    const links = this.db.select().from(schema.knowledgeLinks)
      .where(and(
        eq(schema.knowledgeLinks.workspaceId, workspaceId),
        eq(schema.knowledgeLinks.relation, 'contradicts'),
        isNull(schema.knowledgeLinks.invalidAt),
      ))
      .orderBy(desc(schema.knowledgeLinks.updatedAt))
      .all()
      .filter((link) => !link.contextSplit && !link.resolvedAt)
      .filter((link) => !options.scopeId || !link.scopeId || link.scopeId === options.scopeId);
    const out = [];
    for (const link of links) {
      const a = this.db.select().from(schema.memoryEpisodes)
        .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), eq(schema.memoryEpisodes.id, link.sourceId)))
        .get();
      const b = this.db.select().from(schema.memoryEpisodes)
        .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), eq(schema.memoryEpisodes.id, link.targetId)))
        .get();
      if (!a || !b) continue;
      if (a.status === 'archived' || b.status === 'archived') continue;
      if (!options.includeSnoozed) {
        const snoozedA = a.disputeSnoozedUntil && a.disputeSnoozedUntil > now;
        const snoozedB = b.disputeSnoozedUntil && b.disputeSnoozedUntil > now;
        if (snoozedA || snoozedB) continue;
      }
      out.push({
        id: link.id,
        scopeId: link.scopeId,
        reason: a.disputeReason ?? b.disputeReason ?? 'Contradicting brain atoms need review.',
        createdAt: link.createdAt,
        updatedAt: link.updatedAt,
        atomA: disputeAtom(a),
        atomB: disputeAtom(b),
      });
    }
    return out;
  }

  async resolveDispute(args: {
    workspaceId: string;
    disputeId: string;
    action: 'keep_a' | 'keep_b' | 'merge' | 'context_split' | 'snooze';
    contextA?: string | null;
    contextB?: string | null;
    snoozeDays?: number;
  }): Promise<{ resolved: boolean; newAtomId?: string | null }> {
    const link = this.db.select().from(schema.knowledgeLinks)
      .where(and(eq(schema.knowledgeLinks.workspaceId, args.workspaceId), eq(schema.knowledgeLinks.id, args.disputeId)))
      .get();
    if (!link || link.relation !== 'contradicts') return { resolved: false };
    const now = new Date().toISOString();
    const atomA = this.db.select().from(schema.memoryEpisodes)
      .where(and(eq(schema.memoryEpisodes.workspaceId, args.workspaceId), eq(schema.memoryEpisodes.id, link.sourceId)))
      .get();
    const atomB = this.db.select().from(schema.memoryEpisodes)
      .where(and(eq(schema.memoryEpisodes.workspaceId, args.workspaceId), eq(schema.memoryEpisodes.id, link.targetId)))
      .get();
    if (!atomA || !atomB) return { resolved: false };

    const clearBoth = () => {
      this.db.update(schema.memoryEpisodes)
        .set({ isDisputed: false, disputeResolvedAt: now, disputeSnoozedUntil: null, updatedAt: now })
        .where(and(eq(schema.memoryEpisodes.workspaceId, args.workspaceId), or(eq(schema.memoryEpisodes.id, atomA.id), eq(schema.memoryEpisodes.id, atomB.id))!))
        .run();
    };

    let newAtomId: string | null = null;
    if (args.action === 'keep_a' || args.action === 'keep_b') {
      const loser = args.action === 'keep_a' ? atomB : atomA;
      this.db.update(schema.memoryEpisodes)
        .set({ status: 'archived', archivedAt: now, isDisputed: false, disputeResolvedAt: now, updatedAt: now })
        .where(eq(schema.memoryEpisodes.id, loser.id))
        .run();
      clearBoth();
      this.db.update(schema.knowledgeLinks)
        .set({ resolvedAt: now, invalidAt: now, updatedAt: now })
        .where(eq(schema.knowledgeLinks.id, link.id))
        .run();
      this.db.update(schema.knowledgeLinks)
        .set({ invalidAt: now, updatedAt: now })
        .where(and(
          eq(schema.knowledgeLinks.workspaceId, args.workspaceId),
          or(eq(schema.knowledgeLinks.sourceId, loser.id), eq(schema.knowledgeLinks.targetId, loser.id))!,
          isNull(schema.knowledgeLinks.invalidAt),
        ))
        .run();
    } else if (args.action === 'merge') {
      const merged = await this.addAtom({
        workspaceId: args.workspaceId,
        scopeId: link.scopeId ?? atomA.scopeId ?? atomB.scopeId ?? null,
        agentId: atomA.agentId ?? atomB.agentId ?? null,
        content: mergeDisputeContent(atomA.summary, atomB.summary),
        title: titleFromFact(atomA.title.length >= atomB.title.length ? atomA.title : atomB.title),
        tags: uniqueByNormalized([...parseJsonArray<string>(atomA.tags), ...parseJsonArray<string>(atomB.tags)]),
        confidence: Math.min(0.95, Math.max(Number(atomA.confidence), Number(atomB.confidence)) + 0.05),
        source: 'system_write',
        managed: true,
        metadata: { source: 'curator_distilled', disputeId: link.id },
        compressionTier: 3,
        compressedFrom: [atomA.id, atomB.id],
      });
      newAtomId = merged.id;
      this.db.update(schema.memoryEpisodes)
        .set({ status: 'archived', archivedAt: now, isDisputed: false, disputeResolvedAt: now, updatedAt: now })
        .where(and(eq(schema.memoryEpisodes.workspaceId, args.workspaceId), or(eq(schema.memoryEpisodes.id, atomA.id), eq(schema.memoryEpisodes.id, atomB.id))!))
        .run();
      this.db.update(schema.knowledgeLinks)
        .set({ resolvedAt: now, invalidAt: now, updatedAt: now })
        .where(eq(schema.knowledgeLinks.id, link.id))
        .run();
      this.db.update(schema.knowledgeLinks)
        .set({ invalidAt: now, updatedAt: now })
        .where(and(
          eq(schema.knowledgeLinks.workspaceId, args.workspaceId),
          or(
            eq(schema.knowledgeLinks.sourceId, atomA.id),
            eq(schema.knowledgeLinks.targetId, atomA.id),
            eq(schema.knowledgeLinks.sourceId, atomB.id),
            eq(schema.knowledgeLinks.targetId, atomB.id),
          )!,
          isNull(schema.knowledgeLinks.invalidAt),
        ))
        .run();
    } else if (args.action === 'context_split') {
      this.db.update(schema.memoryEpisodes)
        .set({ isDisputed: false, disputeResolvedAt: now, disputeSnoozedUntil: null, contextCondition: args.contextA ?? 'Context A', updatedAt: now })
        .where(eq(schema.memoryEpisodes.id, atomA.id))
        .run();
      this.db.update(schema.memoryEpisodes)
        .set({ isDisputed: false, disputeResolvedAt: now, disputeSnoozedUntil: null, contextCondition: args.contextB ?? 'Context B', updatedAt: now })
        .where(eq(schema.memoryEpisodes.id, atomB.id))
        .run();
      this.db.update(schema.knowledgeLinks)
        .set({ contextSplit: true, resolvedAt: now, updatedAt: now })
        .where(eq(schema.knowledgeLinks.id, link.id))
        .run();
    } else {
      const days = Math.min(Math.max(args.snoozeDays ?? 30, 1), 365);
      const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
      this.db.update(schema.memoryEpisodes)
        .set({ disputeSnoozedUntil: until, updatedAt: now })
        .where(and(eq(schema.memoryEpisodes.workspaceId, args.workspaceId), or(eq(schema.memoryEpisodes.id, atomA.id), eq(schema.memoryEpisodes.id, atomB.id))!))
        .run();
      this.bus.publish(REALTIME_ROOMS.workspace(args.workspaceId), REALTIME_EVENTS.BRAIN_DISPUTE_RESOLVED, {
        workspaceId: args.workspaceId,
        disputeId: args.disputeId,
        action: args.action,
        snoozedUntil: until,
      });
      return { resolved: true };
    }

    this.bus.publish(REALTIME_ROOMS.workspace(args.workspaceId), REALTIME_EVENTS.BRAIN_DISPUTE_RESOLVED, {
      workspaceId: args.workspaceId,
      disputeId: args.disputeId,
      action: args.action,
      newAtomId,
    });
    return { resolved: true, newAtomId };
  }

  #capacityStatus(workspaceId: string): { percent: number; recommended: boolean } {
    const settings = this.db.select({ brainSettings: schema.workspaces.brainSettings })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .get();
    const parsed = parseJsonRecord(settings?.brainSettings);
    const threshold = typeof parsed.compressionThreshold === 'number' ? parsed.compressionThreshold : 2000;
    // §0.1 — COUNT(*) in SQL, not load-all-then-count-in-JS (this runs on every
    // dispatch via the header). Active = not archived row + not archived status.
    const counted = this.db.select({ c: sql<number>`count(*)` }).from(schema.memoryEpisodes)
      .where(and(
        eq(schema.memoryEpisodes.workspaceId, workspaceId),
        isNull(schema.memoryEpisodes.archivedAt),
        sql`${schema.memoryEpisodes.status} != 'archived'`,
      ))
      .get();
    const count = counted?.c ?? 0;
    const percent = Math.max(0, Math.round((count / Math.max(1, threshold)) * 100));
    return { percent, recommended: percent >= 80 };
  }

  #setEmbeddingMigration(workspaceId: string, migration: Record<string, unknown>): void {
    const row = this.db.select({ brainSettings: schema.workspaces.brainSettings })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .get();
    const settings = parseJsonRecord(row?.brainSettings);
    this.db.update(schema.workspaces)
      .set({ brainSettings: { ...settings, embeddingMigration: migration } })
      .where(eq(schema.workspaces.id, workspaceId))
      .run();
  }

  /**
   * Load active episode atoms with parsed embedding vectors for a workspace,
   * scoped to a workspace when given. Archived/superseded rows are excluded.
   */
  #loadEpisodeVectors(
    workspaceId: string,
    scopeId: string | null,
    /**
     * Restrict the candidate set to atoms owned by `scopeId` ALONE. The default
     * (false) also considers workspace-shared atoms, which is right for recall
     * but wrong for a scoped commit: a near-duplicate in the workspace bucket
     * would absorb the reinforcement and the scope itself would stay empty.
     */
    strictScope = false,
  ): Array<{ id: string; vec: number[] | null; text: string }> {
    const rows = this.db.select().from(schema.memoryEpisodes)
      .where(and(
        eq(schema.memoryEpisodes.workspaceId, workspaceId),
        isNull(schema.memoryEpisodes.archivedAt),
        ...(scopeId
          ? [strictScope
              ? eq(schema.memoryEpisodes.scopeId, scopeId)
              : or(eq(schema.memoryEpisodes.scopeId, scopeId), isNull(schema.memoryEpisodes.scopeId))!]
          : []),
      ))
      .orderBy(desc(schema.memoryEpisodes.updatedAt))
      // §B5.7 — dedup candidates were capped at the 500 most recent atoms, so
      // past that size duplicate detection silently stopped working and copies
      // accumulated. Sized for coverage like retrieval; this runs once per
      // promote() call, not per candidate.
      .limit(RETRIEVAL_CANDIDATE_CAP)
      .all();
    return rows
      .filter((row) => row.status !== 'archived')
      .map((row) => ({
        id: row.id,
        vec: parseEmbedding(row.embedding),
        text: `${row.title}\n${row.summary}`,
      }));
  }

  extractAndPromote(input: CollectiveCognitivePromotionInput): { created: number; reinforced: number; linked: number } {
    const resolvedAgent = input.agentId ? this.resolveAgent(input.workspaceId, input.agentId) : null;
    const adapterType = input.adapterType ?? resolvedAgent?.adapterType ?? null;
    const candidates = extractPromotableFacts(input.taskOutput);
    if (candidates.length === 0) return { created: 0, reinforced: 0, linked: 0 };

    let created = 0;
    let reinforced = 0;
    let linked = 0;
    const existingAtoms = this.loadAtoms(input.workspaceId, {
      scope: input.scopeId ? 'scoped' : 'workspace',
      scopeId: input.scopeId ?? null,
      limit: MAX_GRAPH_LIMIT,
    });

    for (const fact of candidates) {
      const best = this.findBestSimilar(existingAtoms, fact);
      if (best && best.score >= HIGH_SIMILARITY) {
        const node = this.reinforceAtom(input.workspaceId, best.atom.kind, best.atom.id, {
          agentId: input.agentId ?? null,
          adapterType,
          runId: input.runId ?? null,
          scopeId: input.scopeId ?? null,
        });
        if (node) {
          reinforced += 1;
          this.publishAtom(input.workspaceId, REALTIME_EVENTS.BRAIN_ATOM_REINFORCED, node);
        }
        continue;
      }

      const episode = this.episodes.write({
        workspaceId: input.workspaceId,
        scopeId: input.scopeId ?? null,
        workflowId: input.workflowId ?? null,
        runId: input.runId ?? null,
        agentId: input.agentId ?? null,
        type: 'distilled_lesson',
        title: titleFromFact(fact),
        summary: fact,
        source: 'run_promotion',
        confidence: 0.58,
        importance: 0.62,
        trust: 0.55,
        tags: ['collective_brain', ...(adapterType ? [adapterType] : [])],
        entities: input.nodeId ? [input.nodeId] : [],
        outcomeStatus: 'mixed',
        metadata: {
          adapterType,
          nodeId: input.nodeId ?? null,
          origin: 'agent_task_output',
          taskInputPreview: compactValue(input.taskInput),
        },
      });
      created += 1;
      const createdNode = episodeToGraphNode(episode, 1);
      this.publishAtom(input.workspaceId, REALTIME_EVENTS.BRAIN_ATOM_CREATED, createdNode);

      const createdAtom: AtomCandidate = {
        id: episode.id,
        kind: 'episode',
        text: `${episode.title}\n${episode.summary}\n${episode.details ?? ''}`,
        node: createdNode,
      };
      existingAtoms.push(createdAtom);

      if (best && best.score >= RELATED_SIMILARITY) {
        const link = this.createLink({
          workspaceId: input.workspaceId,
          sourceId: episode.id,
          sourceKind: 'episode',
          targetId: best.atom.id,
          targetKind: best.atom.kind,
          relation: relationFor(fact, best.atom.text),
          confidence: Math.max(0.45, Math.min(0.85, best.score)),
          agentId: input.agentId ?? null,
          adapterType,
          runId: input.runId ?? null,
          scopeId: input.scopeId ?? null,
        });
        linked += link ? 1 : 0;
      }
    }

    if (created || reinforced || linked) {
      this.logger.info('collective_brain.promotion.applied', {
        workspaceId: input.workspaceId,
        runId: input.runId,
        agentId: input.agentId,
        created,
        reinforced,
        linked,
      });
    }
    return { created, reinforced, linked };
  }

  createLink(input: KnowledgeLinkInput): BrainGraphLink | null {
    if (input.sourceId === input.targetId && input.sourceKind === input.targetKind) return null;
    const sourceAtom = this.loadAtomById(input.workspaceId, input.sourceKind, input.sourceId);
    const targetAtom = this.loadAtomById(input.workspaceId, input.targetKind, input.targetId);
    if (!sourceAtom || !targetAtom) return null;
    if (input.scopeId && (!atomVisibleInScope(sourceAtom.node, input.scopeId) || !atomVisibleInScope(targetAtom.node, input.scopeId))) {
      return null;
    }

    const existing = this.db.select().from(schema.knowledgeLinks)
      .where(and(
        eq(schema.knowledgeLinks.workspaceId, input.workspaceId),
        eq(schema.knowledgeLinks.sourceId, input.sourceId),
        eq(schema.knowledgeLinks.sourceKind, input.sourceKind),
        eq(schema.knowledgeLinks.targetId, input.targetId),
        eq(schema.knowledgeLinks.targetKind, input.targetKind),
        eq(schema.knowledgeLinks.relation, input.relation),
        isNull(schema.knowledgeLinks.invalidAt),
      ))
      .get();

    if (existing) {
      const now = new Date().toISOString();
      const confidence = clamp01(Number(existing.confidence) + (1 - Number(existing.confidence)) * 0.12);
      const reinforceCount = (existing.reinforceCount ?? 1) + 1;
      this.db.update(schema.knowledgeLinks)
        .set({ confidence, reinforceCount, updatedAt: now })
        .where(eq(schema.knowledgeLinks.id, existing.id))
        .run();
      const link = linkRowToGraph({ ...existing, confidence, reinforceCount, updatedAt: now });
      this.publishLink(input.workspaceId, link);
      return link;
    }

    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      sourceKind: input.sourceKind,
      targetId: input.targetId,
      targetKind: input.targetKind,
      relation: input.relation,
      confidence: clamp01(input.confidence ?? 0.5),
      reinforceCount: 1,
      agentId: input.agentId ?? null,
      adapterType: input.adapterType ?? null,
      runId: input.runId ?? null,
      scopeId: input.scopeId ?? null,
      contextSplit: false,
      resolvedAt: null,
      validFrom: now,
      invalidAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(schema.knowledgeLinks).values(row).run();
    const link = linkRowToGraph(row);
    this.publishLink(input.workspaceId, link);
    return link;
  }

  /** Resolve scope ids to their owning App / Agent / Workflow (for provenance). */
  #resolveScopeOwners(workspaceId: string, scopeIds: string[]): Map<string, { kind: BrainScopeKind; name: string }> {
    const owners = new Map<string, { kind: BrainScopeKind; name: string }>();
    const ids = [...new Set(scopeIds)];
    if (ids.length === 0) return owners;
    for (const row of this.db.select({ id: schema.apps.id, name: schema.apps.name }).from(schema.apps)
      .where(and(eq(schema.apps.workspaceId, workspaceId), inArray(schema.apps.id, ids))).all()) {
      owners.set(row.id, { kind: 'app', name: row.name });
    }
    for (const row of this.db.select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), inArray(schema.agents.id, ids))).all()) {
      if (!owners.has(row.id)) owners.set(row.id, { kind: 'agent', name: row.name });
    }
    for (const row of this.db.select({ id: schema.workflows.id, title: schema.workflows.title }).from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, workspaceId), inArray(schema.workflows.id, ids))).all()) {
      if (!owners.has(row.id)) owners.set(row.id, { kind: 'workflow', name: row.title });
    }
    return owners;
  }

  /** Scope ids the operator has hidden from the Workspace Brain (default: none). */
  #hiddenScopeIds(workspaceId: string): Set<string> {
    const row = this.db.select({ brainSettings: schema.workspaces.brainSettings }).from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId)).get();
    const hidden = parseJsonRecord(row?.brainSettings).hiddenScopeIds;
    return new Set(Array.isArray(hidden) ? hidden.filter((x): x is string => typeof x === 'string') : []);
  }

  getGraph(workspaceId: string, options: BrainGraphOptions = {}): BrainGraph {
    const scope = options.scope ?? 'workspace';
    const scopeId = options.scopeId ?? null;
    const includeWorkspace = options.includeWorkspace ?? scope !== 'scoped';
    // No product cap: the graph shows every atom (up to the render sanity valve)
    // unless a caller explicitly asks for fewer.
    const limit = Math.min(Math.max(options.limit ?? GRAPH_RENDER_CAP, 1), GRAPH_RENDER_CAP);
    const minConfidence = clamp01(options.minConfidence ?? 0);
    const kindFilter = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : null;

    const atoms = this.loadAtoms(workspaceId, { scope, scopeId, includeWorkspace, limit, maxLimit: GRAPH_RENDER_CAP, kinds: options.kinds, minConfidence, includeStaged: true });
    const atomByKey = new Map(atoms.map((atom) => [atomKey(atom.kind, atom.id), atom] as const));

    const linkRows = this.db.select().from(schema.knowledgeLinks)
      .where(and(
        eq(schema.knowledgeLinks.workspaceId, workspaceId),
        isNull(schema.knowledgeLinks.invalidAt),
        ...(scope === 'scoped' && scopeId
          ? [includeWorkspace ? or(eq(schema.knowledgeLinks.scopeId, scopeId), isNull(schema.knowledgeLinks.scopeId))! : eq(schema.knowledgeLinks.scopeId, scopeId)]
          : []),
      ))
      .orderBy(desc(schema.knowledgeLinks.updatedAt))
      .limit(limit * 4)
      .all();

    for (const row of linkRows) {
      const sourceKind = row.sourceKind as KnowledgeAtomKind;
      const targetKind = row.targetKind as KnowledgeAtomKind;
      if (kindFilter && (!kindFilter.has(sourceKind) || !kindFilter.has(targetKind))) continue;
      const sourceKey = atomKey(sourceKind, row.sourceId);
      const targetKey = atomKey(targetKind, row.targetId);
      if (!atomByKey.has(sourceKey)) {
        const source = this.loadAtomById(workspaceId, sourceKind, row.sourceId);
        if (source && atomAllowedInGraph(source.node, scope, scopeId, includeWorkspace)) atomByKey.set(sourceKey, source);
      }
      if (!atomByKey.has(targetKey)) {
        const target = this.loadAtomById(workspaceId, targetKind, row.targetId);
        if (target && atomAllowedInGraph(target.node, scope, scopeId, includeWorkspace)) atomByKey.set(targetKey, target);
      }
    }

    const graphLinks = linkRows
      .map(linkRowToGraph)
      .filter((link) => atomByKey.has(atomKey(link.sourceKind, link.sourceAtomId)) && atomByKey.has(atomKey(link.targetKind, link.targetAtomId)))
      .filter((link) => link.confidence >= minConfidence)
      .slice(0, limit * 2);

    const reinforceByNode = new Map<string, number>();
    for (const link of graphLinks) {
      reinforceByNode.set(link.source, (reinforceByNode.get(link.source) ?? 0) + link.reinforceCount);
      reinforceByNode.set(link.target, (reinforceByNode.get(link.target) ?? 0) + link.reinforceCount);
    }

    // §scope-provenance — in the workspace view, exclude atoms whose owning scope
    // the operator has hidden from the Workspace Brain (default: nothing hidden).
    const hidden = scope === 'workspace' ? this.#hiddenScopeIds(workspaceId) : new Set<string>();
    const nodes = [coreNode(workspaceId, scope, scopeId)];
    const atomNodes = [...atomByKey.values()]
      .map((atom) => ({ ...atom.node, reinforceCount: Math.max(atom.node.reinforceCount, reinforceByNode.get(atom.node.id) ?? 1) }))
      .filter((node) => node.confidence >= minConfidence && !(node.scopeId && hidden.has(node.scopeId)))
      .sort((a, b) => scoreNode(b) - scoreNode(a))
      .slice(0, limit);
    nodes.push(...atomNodes);

    // §scope-provenance — every scoped atom is LABELED with its owner (App/Agent/
    // Workflow) and CONNECTED to a synthetic owner node, so the Workspace Brain
    // never shows orphaned scoped memory/knowledge. Owner nodes appear in the
    // workspace view only (a scoped view is already that one owner's brain).
    const ownerLinks: BrainGraphLink[] = [];
    if (scope === 'workspace') {
      const owners = this.#resolveScopeOwners(workspaceId, atomNodes.map((n) => n.scopeId ?? '').filter(Boolean));
      const nowIso = new Date().toISOString();
      const ownerNodes = new Map<string, BrainGraphNode>();
      for (const node of atomNodes) {
        const owner = node.scopeId ? owners.get(node.scopeId) : undefined;
        if (!node.scopeId || !owner) continue;
        node.scopeKind = owner.kind;
        node.scopeLabel = owner.name;
        const ownerId = `scope:${node.scopeId}`;
        if (!ownerNodes.has(ownerId)) {
          ownerNodes.set(ownerId, {
            id: ownerId, atomId: node.scopeId, atomKind: 'scope_owner', label: owner.name,
            confidence: 1, reinforceCount: 1, scopeId: node.scopeId, scopeKind: owner.kind,
            scopeLabel: owner.name, createdAt: nowIso, updatedAt: nowIso, metadata: { ownerKind: owner.kind },
          });
        }
        ownerLinks.push({
          id: `own:${node.id}`, source: node.id, target: ownerId,
          sourceAtomId: node.atomId, sourceKind: node.atomKind as KnowledgeAtomKind,
          targetAtomId: node.scopeId, targetKind: 'scope_owner', relation: 'owned_by',
          confidence: 1, reinforceCount: 1, scopeId: node.scopeId, createdAt: nowIso, updatedAt: nowIso,
        });
      }
      nodes.push(...ownerNodes.values());
    }

    const visible = new Set(nodes.map((node) => node.id));
    const visibleLinks = [
      ...graphLinks.filter((link) => visible.has(link.source) && visible.has(link.target)),
      ...ownerLinks.filter((link) => visible.has(link.source) && visible.has(link.target)),
    ];
    const lastActivityAt = latestActivity(nodes, visibleLinks);
    const adapterTypes = new Set<string>();
    for (const node of nodes) if (node.adapterType) adapterTypes.add(node.adapterType);
    for (const link of visibleLinks) if (link.adapterType) adapterTypes.add(link.adapterType);

    return {
      nodes,
      links: visibleLinks,
      meta: {
        workspaceId,
        scope,
        scopeId,
        atomCount: atomNodes.length,
        linkCount: visibleLinks.length,
        lastActivityAt,
        adapterTypes: [...adapterTypes].sort(),
      },
    };
  }

  getNode(workspaceId: string, graphNodeId: string, options: BrainGraphOptions = {}) {
    const graph = this.getGraph(workspaceId, { ...options, limit: MAX_GRAPH_LIMIT });
    const node = graph.nodes.find((candidate) => candidate.id === graphNodeId || candidate.atomId === graphNodeId);
    if (!node) return null;
    const links = graph.links.filter((link) => link.source === node.id || link.target === node.id);
    const relatedIds = new Set<string>();
    for (const link of links) {
      relatedIds.add(link.source === node.id ? link.target : link.source);
    }
    return {
      node,
      links,
      relatedNodes: graph.nodes.filter((candidate) => relatedIds.has(candidate.id)),
      content: this.getAtomDetail(workspaceId, node)?.content ?? node.summary ?? '',
      provenance: this.provenanceForAtom(workspaceId, node),
      usedBy: this.usedByForAtom(workspaceId, node),
    };
  }

  /**
   * Read-only iteration of every active atom for a workspace, returned as
   * lightweight tokenised candidates suitable for similarity scoring.
   *
   * Used by KnowledgeAutoLinker — exposed here (rather than re-querying
   * the tables in the linker) so all atom-kind ordering, scope filters,
   * and per-kind row mappers stay in one place.
   */
  listLinkCandidates(
    workspaceId: string,
    options: { scopeId?: string | null; includeWorkspace?: boolean; limit?: number } = {},
  ): Array<{ id: string; kind: KnowledgeAtomKind; label: string; text: string; tokens: Set<string>; embedding: number[] | null }> {
    const atoms = this.loadAtoms(workspaceId, {
      scope: options.scopeId ? 'scoped' : 'workspace',
      scopeId: options.scopeId ?? null,
      includeWorkspace: options.includeWorkspace ?? false,
      limit: options.limit ?? MAX_GRAPH_LIMIT,
    });
    return atoms.map((atom) => ({
      id: atom.id,
      kind: atom.kind,
      label: atom.node.label,
      text: atom.text,
      tokens: new Set(tokenize(atom.text)),
      // §perf — carry the STORED vector so semantic linking compares against it
      // instead of re-embedding every candidate's text on every call (that turned
      // a single document's linking into N×candidates embeds and froze the API).
      embedding: atom.embedding ?? null,
    }));
  }

  /**
   * Inline edit of an atom's primary text. Only `episode`, `memory`,
   * `pattern`, `knowledge_chunk`, and `kb_chunk` are editable. Returns the
   * updated graph node so the caller can echo it back to the UI.
   */
  updateAtomContent(
    workspaceId: string,
    kind: KnowledgeAtomKind,
    id: string,
    patch: { title?: string; content?: string },
  ): BrainGraphNode | null {
    if (patch.title === undefined && patch.content === undefined) return null;
    const now = new Date().toISOString();
    let changes = 0;
    switch (kind) {
      // §B4 — memory atoms are episodes now; skill/example ride the substrate too.
      case 'episode':
      case 'memory':
      case 'skill':
      case 'example': {
        const update: Record<string, unknown> = { updatedAt: now };
        if (patch.title !== undefined) update.title = patch.title;
        if (patch.content !== undefined) update.summary = patch.content;
        changes = this.db.update(schema.memoryEpisodes)
          .set(update)
          .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), eq(schema.memoryEpisodes.id, id)))
          .run().changes;
        break;
      }
      case 'pattern': {
        const update: Record<string, unknown> = { updatedAt: now };
        if (patch.title !== undefined) update.title = patch.title;
        if (patch.content !== undefined) update.summary = patch.content;
        changes = this.db.update(schema.promotedPatterns)
          .set(update)
          .where(and(eq(schema.promotedPatterns.workspaceId, workspaceId), eq(schema.promotedPatterns.id, id)))
          .run().changes;
        break;
      }
      case 'knowledge_chunk': {
        const update: Record<string, unknown> = { updatedAt: now };
        if (patch.title !== undefined) update.title = patch.title;
        if (patch.content !== undefined) update.content = patch.content;
        changes = this.db.update(schema.knowledgeChunks)
          .set(update)
          .where(and(eq(schema.knowledgeChunks.workspaceId, workspaceId), eq(schema.knowledgeChunks.id, id)))
          .run().changes;
        break;
      }
      case 'kb_chunk': {
        if (patch.content !== undefined) {
          changes = this.db.update(schema.kbChunks)
            .set({ content: patch.content })
            .where(and(eq(schema.kbChunks.workspaceId, workspaceId), eq(schema.kbChunks.id, id)))
            .run().changes;
        }
        break;
      }
    }
    if (changes === 0) return null;
    const atom = this.loadAtomById(workspaceId, kind, id);
    return atom?.node ?? null;
  }

  archiveAtom(
    workspaceId: string,
    kind: KnowledgeAtomKind,
    id: string,
    options: { scopeId?: string | null } = {},
  ): boolean {
    const atom = this.loadAtomById(workspaceId, kind, id);
    if (!atom) return false;
    if (options.scopeId && !atomVisibleInScope(atom.node, options.scopeId)) return false;

    const now = new Date().toISOString();
    let changes = 0;
    switch (kind) {
      // §B4 — memory atoms are episodes now; skill/example ride the substrate too.
      case 'episode':
      case 'memory':
      case 'skill':
      case 'example':
        changes = this.db.update(schema.memoryEpisodes)
          .set({ archivedAt: now, status: 'archived', updatedAt: now })
          .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), eq(schema.memoryEpisodes.id, id)))
          .run().changes;
        break;
      case 'pattern':
        changes = this.db.delete(schema.promotedPatterns)
          .where(and(eq(schema.promotedPatterns.workspaceId, workspaceId), eq(schema.promotedPatterns.id, id)))
          .run().changes;
        break;
      case 'knowledge_chunk':
        changes = this.db.delete(schema.knowledgeChunks)
          .where(and(eq(schema.knowledgeChunks.workspaceId, workspaceId), eq(schema.knowledgeChunks.id, id)))
          .run().changes;
        break;
      case 'kb_chunk':
        changes = this.db.delete(schema.kbChunks)
          .where(and(eq(schema.kbChunks.workspaceId, workspaceId), eq(schema.kbChunks.id, id)))
          .run().changes;
        break;
    }

    if (changes > 0) this.deleteLinksForAtom(workspaceId, kind, id);
    return changes > 0;
  }

  private getAtomDetail(workspaceId: string, node: BrainGraphNode): BrainAtomDetail | null {
    if (node.atomKind === 'core') {
      return {
        content: node.summary ?? '',
        source: 'Agentis',
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
      };
    }
    if (node.atomKind === 'warning' || node.atomKind === 'gap' || node.atomKind === 'scope_owner') return null;
    // Organizational overlay nodes resolve through /v1/grounding, not the atom store.
    if (node.atomKind === 'grounding_source' || node.atomKind === 'grounding_entity' || node.atomKind === 'grounding_claim') return null;

    switch (node.atomKind) {
      case 'episode': {
        const row = this.db.select().from(schema.memoryEpisodes)
          .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), eq(schema.memoryEpisodes.id, node.atomId)))
          .get();
        if (!row) return null;
        return {
          content: [row.summary, row.details].filter(Boolean).join('\n\n'),
          source: sourceLabel(row.source, 'Agent output'),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          agentId: row.agentId,
          workflowId: row.workflowId,
          runId: row.runId,
        };
      }
      case 'memory':
      case 'skill':
      case 'example': {
        // §B4 — memory atoms live in the episode substrate; skill/example too.
        const row = this.db.select().from(schema.memoryEpisodes)
          .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), eq(schema.memoryEpisodes.id, node.atomId)))
          .get();
        if (!row) return null;
        return {
          content: row.summary,
          source: sourceLabel(row.source, node.atomKind === 'skill' ? 'Skill' : node.atomKind === 'example' ? 'Example' : 'Scoped memory'),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      }
      case 'pattern': {
        const row = this.db.select().from(schema.promotedPatterns)
          .where(and(eq(schema.promotedPatterns.workspaceId, workspaceId), eq(schema.promotedPatterns.id, node.atomId)))
          .get();
        if (!row) return null;
        const payload = parseJsonRecord(row.payload);
        const payloadText = Object.keys(payload).length > 0 ? `\n\n${JSON.stringify(payload, null, 2)}` : '';
        return {
          content: `${row.summary}${payloadText}`,
          source: 'Promoted pattern',
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      }
      case 'knowledge_chunk': {
        const row = this.db.select().from(schema.knowledgeChunks)
          .where(and(eq(schema.knowledgeChunks.workspaceId, workspaceId), eq(schema.knowledgeChunks.id, node.atomId)))
          .get();
        if (!row) return null;
        return {
          content: row.content,
          source: sourceLabel(row.source, 'Knowledge import'),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      }
      case 'kb_chunk': {
        const row = this.db.select({ chunk: schema.kbChunks, scopeId: schema.knowledgeBases.scopeId })
          .from(schema.kbChunks)
          .innerJoin(schema.knowledgeBases, eq(schema.kbChunks.knowledgeBaseId, schema.knowledgeBases.id))
          .where(and(eq(schema.kbChunks.workspaceId, workspaceId), eq(schema.kbChunks.id, node.atomId)))
          .get();
        if (!row) return null;
        const metadata = parseJsonRecord(row.chunk.metadata);
        const document = this.db.select({ name: schema.kbDocuments.name, archivedAt: schema.kbDocuments.archivedAt }).from(schema.kbDocuments)
          .where(and(eq(schema.kbDocuments.workspaceId, workspaceId), eq(schema.kbDocuments.id, row.chunk.documentId)))
          .get();
        if (!document || document.archivedAt) return null;
        const metadataSource = typeof metadata.source === 'string' ? metadata.source : null;
        return {
          content: row.chunk.content,
          source: document?.name ?? metadataSource ?? 'Knowledge document',
          createdAt: row.chunk.createdAt,
          updatedAt: row.chunk.createdAt,
          workflowId: row.scopeId,
        };
      }
    }
  }

  private provenanceForAtom(workspaceId: string, node: BrainGraphNode) {
    const detail = this.getAtomDetail(workspaceId, node);
    const agentId = detail?.agentId ?? node.agentId ?? null;
    const agent = agentId ? this.resolveAgent(workspaceId, agentId) : null;
    const metadataProvenance = parseJsonRecord(node.metadata.provenance);
    const createdByFromProvenance = typeof metadataProvenance.userDisplayName === 'string' && metadataProvenance.userDisplayName.trim()
      ? metadataProvenance.userDisplayName.trim()
      : null;
    return {
      createdBy: agent?.name ?? createdByFromProvenance ?? creatorLabelFor(node.atomKind, detail?.source),
      agentId,
      adapterType: node.adapterType ?? agent?.adapterType ?? null,
      createdAt: detail?.createdAt ?? node.createdAt,
      updatedAt: detail?.updatedAt ?? node.updatedAt,
      source: detail?.source ?? sourceLabel(node.metadata.source, 'Agent output'),
      reinforced: node.reinforceCount,
    };
  }

  private usedByForAtom(workspaceId: string, node: BrainGraphNode): BrainUsageSummary[] {
    const detail = this.getAtomDetail(workspaceId, node);
    const out: BrainUsageSummary[] = [];
    const agentId = detail?.agentId ?? node.agentId ?? null;
    if (agentId) {
      const agent = this.resolveAgent(workspaceId, agentId);
      out.push({
        id: agentId,
        type: 'agent',
        name: agent?.name ?? `Agent ${agentId.slice(0, 8)}`,
        count: Math.max(1, node.reinforceCount),
      });
    }

    let workflowId = detail?.workflowId ?? null;
    const runId = detail?.runId ?? node.runId ?? null;
    if (!workflowId && runId) {
      const run = this.db.select({ workflowId: schema.workflowRuns.workflowId }).from(schema.workflowRuns)
        .where(and(eq(schema.workflowRuns.workspaceId, workspaceId), eq(schema.workflowRuns.id, runId)))
        .get();
      workflowId = run?.workflowId ?? null;
    }
    if (workflowId) {
      const workflow = this.db.select({ title: schema.workflows.title }).from(schema.workflows)
        .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.id, workflowId)))
        .get();
      out.push({
        id: workflowId,
        type: 'workflow',
        name: workflow?.title ?? `Workflow ${workflowId.slice(0, 8)}`,
        count: 1,
      });
    }
    return out;
  }

  private deleteLinksForAtom(workspaceId: string, kind: KnowledgeAtomKind, id: string): void {
    this.db.delete(schema.knowledgeLinks)
      .where(and(
        eq(schema.knowledgeLinks.workspaceId, workspaceId),
        or(
          and(eq(schema.knowledgeLinks.sourceKind, kind), eq(schema.knowledgeLinks.sourceId, id)),
          and(eq(schema.knowledgeLinks.targetKind, kind), eq(schema.knowledgeLinks.targetId, id)),
        )!,
      ))
      .run();
  }

  private reinforceAtom(
    workspaceId: string,
    kind: KnowledgeAtomKind,
    id: string,
    provenance: { agentId?: string | null; adapterType?: string | null; runId?: string | null; scopeId?: string | null },
  ): BrainGraphNode | null {
    if (kind === 'episode') {
      const updated = this.episodes.reinforce(workspaceId, id, { confidenceDelta: 0.06, trustDelta: 0.04 });
      if (!updated) return null;
      return episodeToGraphNode(updated, 2);
    }

    // §B4 — memory atoms are episodes; skill/example ride the substrate too.
    if (kind === 'memory' || kind === 'skill' || kind === 'example') {
      const updated = this.episodes.reinforce(workspaceId, id, { confidenceDelta: 0.06, trustDelta: 0.04 });
      if (!updated) return null;
      return episodeToGraphNode(updated, 2);
    }

    return this.loadAtomById(workspaceId, kind, id)?.node ?? null;
  }

  private findBestSimilar(atoms: AtomCandidate[], fact: string): SimilarAtom | null {
    let best: SimilarAtom | null = null;
    for (const atom of atoms) {
      const score = similarity(fact, atom.text);
      if (!best || score > best.score) best = { atom, score };
    }
    return best;
  }

  private loadAtoms(workspaceId: string, options: BrainGraphOptions): AtomCandidate[] {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_GRAPH_LIMIT, 1), options.maxLimit ?? MAX_GRAPH_LIMIT);
    const perKind = options.perKind ?? Math.max(12, Math.ceil(limit / 4));
    const scopeId = options.scopeId ?? null;
    const scope = options.scope ?? 'workspace';
    const includeWorkspace = options.includeWorkspace ?? scope !== 'scoped';
    const kindFilter = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : null;
    const excludeKinds = options.excludeKinds && options.excludeKinds.length > 0 ? new Set(options.excludeKinds) : null;
    const wants = (k: KnowledgeAtomKind): boolean => (!kindFilter || kindFilter.has(k)) && !excludeKinds?.has(k);
    const minConfidence = clamp01(options.minConfidence ?? 0);
    const out: AtomCandidate[] = [];

    if (wants('episode')) {
      const rows = this.db.select().from(schema.memoryEpisodes)
        .where(and(
          eq(schema.memoryEpisodes.workspaceId, workspaceId),
          isNull(schema.memoryEpisodes.archivedAt),
          // §B5.6 — staged traces are hidden from RECALL (they are low-confidence
          // and would dilute dispatch context) but shown on the GRAPH, which opts
          // in via `includeStaged`. See BrainGraphOptions.includeStaged.
          ...(options.includeStaged ? [] : [sql`${schema.memoryEpisodes.tags} NOT LIKE '%unconsolidated%'`]),
          // Skill-library atoms (skill/example) ride this table on a separate
          // plane; keep them OUT of the generic episode surface (and thus the
          // always-inject dispatch tier). They have dedicated branches below.
          sql`${schema.memoryEpisodes.tags} NOT LIKE ${SKILL_LIBRARY_PLANE_LIKE}`,
          ...(scope === 'scoped' && scopeId
            ? [includeWorkspace ? or(eq(schema.memoryEpisodes.scopeId, scopeId), isNull(schema.memoryEpisodes.scopeId))! : eq(schema.memoryEpisodes.scopeId, scopeId)]
            : []),
          // §C7 — row-level access: shared atoms + the requester's own private atoms only.
          ...(options.requesterScopeId !== undefined
            ? [typeof options.requesterScopeId === 'string'
                ? or(eq(schema.memoryEpisodes.shared, true), eq(schema.memoryEpisodes.scopeId, options.requesterScopeId))!
                : eq(schema.memoryEpisodes.shared, true)]
            : []),
        ))
        .orderBy(desc(schema.memoryEpisodes.updatedAt))
        .limit(perKind)
        .all();
      for (const row of rows) {
        const node = episodeRowToGraphNode(row, 1);
        if (node.confidence >= minConfidence) out.push({ id: row.id, kind: 'episode', text: `${row.title}\n${row.summary}\n${row.details ?? ''}`, node, embedding: row.embedding as number[] | null, embeddingModel: row.embeddingModel, embeddingDims: row.embeddingDims });
      }
    }

    // §B4 — typed workspace memory now lives in memory_episodes (plane-tagged),
    // already surfaced by the episode branch above. No separate 'memory' read.

    if (!kindFilter || kindFilter.has('pattern')) {
      const rows = this.db.select().from(schema.promotedPatterns)
        .where(and(
          eq(schema.promotedPatterns.workspaceId, workspaceId),
	          ...(scope === 'scoped' && scopeId
	            ? [includeWorkspace ? or(eq(schema.promotedPatterns.scopeId, scopeId), isNull(schema.promotedPatterns.scopeId))! : eq(schema.promotedPatterns.scopeId, scopeId)]
	            : []),
        ))
        .orderBy(desc(schema.promotedPatterns.updatedAt))
        .limit(perKind)
        .all();
      for (const row of rows) {
        const node = patternRowToGraphNode(row);
        if (node.confidence >= minConfidence) out.push({ id: row.id, kind: 'pattern', text: `${row.title}\n${row.summary}`, node });
      }
    }

    if (!kindFilter || kindFilter.has('knowledge_chunk')) {
      const rows = this.db.select().from(schema.knowledgeChunks)
        .where(and(
          eq(schema.knowledgeChunks.workspaceId, workspaceId),
	          ...(scope === 'scoped' && scopeId
	            ? [includeWorkspace ? or(eq(schema.knowledgeChunks.scopeId, scopeId), isNull(schema.knowledgeChunks.scopeId))! : eq(schema.knowledgeChunks.scopeId, scopeId)]
	            : []),
        ))
        .orderBy(desc(schema.knowledgeChunks.updatedAt))
        .limit(perKind)
        .all();
      for (const row of rows) {
        const node = knowledgeChunkRowToGraphNode(row);
        if (node.confidence >= minConfidence) out.push({ id: row.id, kind: 'knowledge_chunk', text: `${row.title}\n${row.content}`, node, embedding: row.embedding as number[] | null });
      }
    }

    if (!kindFilter || kindFilter.has('kb_chunk')) {
      const rows = this.db.select({ chunk: schema.kbChunks, scopeId: schema.knowledgeBases.scopeId })
        .from(schema.kbChunks)
        .innerJoin(schema.knowledgeBases, eq(schema.kbChunks.knowledgeBaseId, schema.knowledgeBases.id))
        .innerJoin(schema.kbDocuments, and(
          eq(schema.kbDocuments.id, schema.kbChunks.documentId),
          eq(schema.kbDocuments.workspaceId, workspaceId),
          isNull(schema.kbDocuments.archivedAt),
        ))
        .where(and(
          eq(schema.kbChunks.workspaceId, workspaceId),
          ...(scope === 'scoped' && scopeId
            ? [includeWorkspace
              ? or(eq(schema.knowledgeBases.scopeId, scopeId), isNull(schema.knowledgeBases.scopeId))!
              : eq(schema.knowledgeBases.scopeId, scopeId)]
            : []),
        ))
        .orderBy(desc(schema.kbChunks.createdAt))
        .limit(perKind)
        .all();
      for (const { chunk, scopeId: knowledgeBaseScopeId } of rows) {
        const node = kbChunkRowToGraphNode({ ...chunk, scopeId: knowledgeBaseScopeId });
        if (node.confidence >= minConfidence) out.push({ id: chunk.id, kind: 'kb_chunk', text: chunk.content, node, embedding: chunk.embedding as number[] | null });
      }
    }

    // Skill-library plane: skill (a procedure) + example (its demonstrations).
    // One read of the plane, split by the metadata.memoryKind discriminator, so
    // these never surface via the generic `episode` branch (kept out of the
    // always-inject tier) yet remain searchable + visible in the graph.
    if (wants('skill') || wants('example')) {
      const rows = this.db.select().from(schema.memoryEpisodes)
        .where(and(
          eq(schema.memoryEpisodes.workspaceId, workspaceId),
          isNull(schema.memoryEpisodes.archivedAt),
          sql`${schema.memoryEpisodes.tags} LIKE ${SKILL_LIBRARY_PLANE_LIKE}`,
          ...(scope === 'scoped' && scopeId
            ? [includeWorkspace ? or(eq(schema.memoryEpisodes.scopeId, scopeId), isNull(schema.memoryEpisodes.scopeId))! : eq(schema.memoryEpisodes.scopeId, scopeId)]
            : []),
          ...(options.requesterScopeId !== undefined
            ? [typeof options.requesterScopeId === 'string'
                ? or(eq(schema.memoryEpisodes.shared, true), eq(schema.memoryEpisodes.scopeId, options.requesterScopeId))!
                : eq(schema.memoryEpisodes.shared, true)]
            : []),
        ))
        .orderBy(desc(schema.memoryEpisodes.updatedAt))
        .limit(perKind * 2)
        .all();
      for (const row of rows) {
        const memoryKind = parseJsonRecord(row.metadata).memoryKind;
        const atomKind: KnowledgeAtomKind = memoryKind === 'example' ? 'example' : 'skill';
        if (!wants(atomKind)) continue;
        const node = episodeRowToGraphNode(row, 1, atomKind);
        if (node.confidence >= minConfidence) out.push({ id: row.id, kind: atomKind, text: `${row.title}\n${row.summary}\n${row.details ?? ''}`, node, embedding: row.embedding as number[] | null, embeddingModel: row.embeddingModel, embeddingDims: row.embeddingDims });
      }
    }

    return out;
  }

  private loadAtomById(workspaceId: string, kind: KnowledgeAtomKind, id: string): AtomCandidate | null {
    switch (kind) {
      case 'episode': {
        const row = this.db.select().from(schema.memoryEpisodes)
          .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), eq(schema.memoryEpisodes.id, id)))
          .get();
        if (!row) return null;
        const node = episodeRowToGraphNode(row, 1);
        return { id: row.id, kind, text: `${row.title}\n${row.summary}\n${row.details ?? ''}`, node };
      }
      case 'memory':
      case 'skill':
      case 'example': {
        // §B4 — memory atoms live in the episode substrate; skill/example ride
        // it too (on the skill-library plane).
        const row = this.db.select().from(schema.memoryEpisodes)
          .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), eq(schema.memoryEpisodes.id, id)))
          .get();
        if (!row) return null;
        const node = episodeRowToGraphNode(row, 1, kind === 'memory' ? 'episode' : kind);
        return { id: row.id, kind, text: `${row.title}\n${row.summary}\n${row.details ?? ''}`, node };
      }
      case 'pattern': {
        const row = this.db.select().from(schema.promotedPatterns)
          .where(and(eq(schema.promotedPatterns.workspaceId, workspaceId), eq(schema.promotedPatterns.id, id)))
          .get();
        if (!row) return null;
        const node = patternRowToGraphNode(row);
        return { id: row.id, kind, text: `${row.title}\n${row.summary}`, node };
      }
      case 'knowledge_chunk': {
        const row = this.db.select().from(schema.knowledgeChunks)
          .where(and(eq(schema.knowledgeChunks.workspaceId, workspaceId), eq(schema.knowledgeChunks.id, id)))
          .get();
        if (!row) return null;
        const node = knowledgeChunkRowToGraphNode(row);
        return { id: row.id, kind, text: `${row.title}\n${row.content}`, node };
      }
      case 'kb_chunk': {
        const row = this.db.select({ chunk: schema.kbChunks, scopeId: schema.knowledgeBases.scopeId })
          .from(schema.kbChunks)
          .innerJoin(schema.knowledgeBases, eq(schema.kbChunks.knowledgeBaseId, schema.knowledgeBases.id))
          .where(and(eq(schema.kbChunks.workspaceId, workspaceId), eq(schema.kbChunks.id, id)))
          .get();
        if (!row) return null;
        if (!this.isKbDocumentActive(workspaceId, row.chunk.documentId)) return null;
        const node = kbChunkRowToGraphNode({ ...row.chunk, scopeId: row.scopeId });
        return { id: row.chunk.id, kind, text: row.chunk.content, node };
      }
    }
  }

  private isKbDocumentActive(workspaceId: string, documentId: string): boolean {
    const document = this.db.select({ archivedAt: schema.kbDocuments.archivedAt })
      .from(schema.kbDocuments)
      .where(and(eq(schema.kbDocuments.workspaceId, workspaceId), eq(schema.kbDocuments.id, documentId)))
      .get();
    return Boolean(document && !document.archivedAt);
  }

  private resolveAgent(workspaceId: string, agentId: string): { id: string; name: string; adapterType: string } | null {
    const row = this.db.select({ id: schema.agents.id, name: schema.agents.name, adapterType: schema.agents.adapterType })
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.id, agentId)))
      .get();
    return row ?? null;
  }

  private publishAtom(workspaceId: string, event: typeof REALTIME_EVENTS.BRAIN_ATOM_CREATED | typeof REALTIME_EVENTS.BRAIN_ATOM_REINFORCED, node: BrainGraphNode): void {
    this.bus.publish(REALTIME_ROOMS.workspace(workspaceId), event, {
      workspaceId,
      scopeId: node.scopeId ?? null,
      node,
    });
  }

  private publishLink(workspaceId: string, link: BrainGraphLink): void {
    this.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.BRAIN_LINK_CREATED, {
      workspaceId,
      scopeId: link.scopeId ?? null,
      link,
    });
  }
}

function linkRowToGraph(row: typeof schema.knowledgeLinks.$inferSelect): BrainGraphLink {
  const sourceKind = row.sourceKind as KnowledgeAtomKind;
  const targetKind = row.targetKind as KnowledgeAtomKind;
  return {
    id: row.id,
    source: atomKey(sourceKind, row.sourceId),
    target: atomKey(targetKind, row.targetId),
    sourceAtomId: row.sourceId,
    sourceKind,
    targetAtomId: row.targetId,
    targetKind,
    relation: row.relation as KnowledgeLinkRelation,
    confidence: Number(row.confidence) || 0.5,
    reinforceCount: row.reinforceCount ?? 1,
    agentId: row.agentId,
    adapterType: row.adapterType,
    scopeId: row.scopeId,
    runId: row.runId,
    contextSplit: Boolean(row.contextSplit),
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function episodeToGraphNode(row: ReturnType<EpisodicMemoryStore['write']>, reinforceCount: number): BrainGraphNode {
  return {
    id: atomKey('episode', row.id),
    atomId: row.id,
    atomKind: 'episode',
    label: row.title,
    summary: row.summary,
    confidence: clamp01(row.confidence),
    trust: row.trust,
    reinforceCount,
    agentId: row.agentId ?? null,
    adapterType: typeof row.metadata.adapterType === 'string' ? row.metadata.adapterType : null,
    scopeId: row.scopeId ?? null,
    runId: row.runId ?? null,
    isDisputed: Boolean(row.metadata.disputed),
    status: 'active',
    managed: true,
    pinnedAt: null,
    lastAccessedAt: null,
    compressedFrom: null,
    compressionTier: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: {
      ...row.metadata,
      type: row.type,
      source: row.source,
      tags: row.tags,
      outcomeStatus: row.outcomeStatus ?? null,
      workflowId: row.workflowId ?? null,
    },
  };
}

function episodeRowToGraphNode(row: typeof schema.memoryEpisodes.$inferSelect, reinforceCount: number, atomKind: KnowledgeAtomKind = 'episode'): BrainGraphNode {
  const metadata = parseJsonRecord(row.metadata);
  return {
    id: atomKey(atomKind, row.id),
    atomId: row.id,
    atomKind,
    label: row.title,
    summary: row.summary,
    confidence: clamp01(Number(row.confidence)),
    trust: Number(row.trust),
    reinforceCount,
    agentId: row.agentId,
    adapterType: typeof metadata.adapterType === 'string' ? metadata.adapterType : null,
    scopeId: row.scopeId,
    runId: row.runId,
    isDisputed: Boolean(row.isDisputed),
    isStale: isStale(row.updatedAt),
    status: row.status,
    managed: Boolean(row.managed),
    pinnedAt: row.pinnedAt,
    lastAccessedAt: row.lastAccessedAt,
    disputeReason: row.disputeReason,
    disputeResolvedAt: row.disputeResolvedAt,
    disputeSnoozedUntil: row.disputeSnoozedUntil,
    contextCondition: row.contextCondition,
    compressedFrom: parseJsonArray<string>(row.compressedFrom),
    compressionTier: row.compressionTier,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: {
      ...metadata,
      type: row.type,
      source: row.source,
      tags: parseJsonArray<string>(row.tags),
      outcomeStatus: row.outcomeStatus ?? null,
      workflowId: row.workflowId ?? null,
    },
  };
}

// §B4 — memoryRowToGraphNode removed: workspace_memory collapsed into episodes,
// which project via episodeRowToGraphNode.

function patternRowToGraphNode(row: typeof schema.promotedPatterns.$inferSelect): BrainGraphNode {
  return {
    id: atomKey('pattern', row.id),
    atomId: row.id,
    atomKind: 'pattern',
    label: row.title,
    summary: row.summary,
    confidence: clamp01(Number(row.confidence)),
    trust: Number(row.trust),
    reinforceCount: row.evidenceCount,
    scopeId: row.scopeId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: {
      kind: row.kind,
      provenance: parseJsonRecord(row.provenance),
      evidenceCount: row.evidenceCount,
    },
  };
}

function knowledgeChunkRowToGraphNode(row: typeof schema.knowledgeChunks.$inferSelect): BrainGraphNode {
  return {
    id: atomKey('knowledge_chunk', row.id),
    atomId: row.id,
    atomKind: 'knowledge_chunk',
    label: row.title,
    summary: truncate(row.content, 180),
    confidence: clamp01(Number(row.trust)),
    trust: Number(row.trust),
    reinforceCount: 1,
    scopeId: row.scopeId,
    isStale: isStale(row.updatedAt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: {
      source: row.source,
      tags: parseJsonArray<string>(row.tags),
      provenance: parseJsonRecord(row.provenance),
    },
  };
}

function kbChunkRowToGraphNode(row: typeof schema.kbChunks.$inferSelect & { scopeId: string | null }): BrainGraphNode {
  const metadata = parseJsonRecord(row.metadata);
  const source = typeof metadata.source === 'string' ? metadata.source : 'Knowledge document';
  return {
    id: atomKey('kb_chunk', row.id),
    atomId: row.id,
    atomKind: 'kb_chunk',
    label: source,
    summary: truncate(row.content, 180),
    confidence: 0.82,
    trust: 0.82,
    reinforceCount: 1,
    scopeId: row.scopeId,
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
    metadata: {
      ...metadata,
      documentId: row.documentId,
      knowledgeBaseId: row.knowledgeBaseId,
      scopeId: row.scopeId,
      scopeKind: row.scopeId ? 'workflow' : 'workspace',
      workflowId: row.scopeId,
      chunkIndex: row.chunkIndex,
      tokenCount: row.tokenCount,
    },
  };
}

function coreNode(workspaceId: string, scope: BrainGraphScope, scopeId: string | null): BrainGraphNode {
  const now = new Date().toISOString();
  return {
    id: 'core',
    atomId: 'core',
    atomKind: 'core',
    label: scope === 'scoped' ? 'Scoped brain' : 'Workspace brain',
    summary: 'Collective intelligence shared by every agent adapter',
    confidence: 1,
    trust: 1,
    reinforceCount: 1,
    scopeId,
    createdAt: now,
    updatedAt: now,
    metadata: { workspaceId, scope },
  };
}

function atomVisibleInScope(node: BrainGraphNode, scopeId: string): boolean {
  return !node.scopeId || node.scopeId === scopeId;
}

function atomAllowedInGraph(node: BrainGraphNode, scope: BrainGraphScope, scopeId: string | null, includeWorkspace: boolean): boolean {
  if (scope !== 'scoped' || !scopeId) return true;
  if (node.scopeId === scopeId) return true;
  return includeWorkspace && !node.scopeId;
}

function creatorLabelFor(kind: BrainGraphNode['atomKind'], source?: string | null): string {
  if (kind === 'core') return 'Agentis';
  if (source) {
    if (/operator/i.test(source)) return 'Operator';
    if (/seed/i.test(source)) return 'Seeded knowledge';
    if (/promotion|agent output|agent|run/i.test(source)) return 'Agent output';
    if (/system/i.test(source)) return 'System';
    if (/document|import|knowledge/i.test(source)) return 'Knowledge import';
  }
  if (kind === 'kb_chunk' || kind === 'knowledge_chunk') return 'Knowledge import';
  return 'Agent output';
}

function sourceLabel(source: unknown, fallback: string): string {
  if (typeof source !== 'string' || source.trim().length === 0) return fallback;
  switch (source) {
    case 'kb_chunk': return 'Knowledge document';
    case 'knowledge_chunk': return 'Knowledge chunk';
    case 'seed': return 'Seeded knowledge';
    case 'import': return 'Knowledge import';
    case 'promotion': return 'Promotion';
    case 'operator':
    case 'operator_write': return 'Operator';
    case 'agent_write':
    case 'run_promotion': return 'Agent output';
    case 'evaluator_write': return 'Evaluator';
    case 'system_write': return 'System';
    case 'harness_ingest': return 'Harness import';
    default: return source.replace(/_/g, ' ');
  }
}

// Accepts the widened link-kind union; grounding_* kinds never resolve to atoms
// here (the organizational overlay is served by /v1/grounding/graph), so their
// keys simply never match and the links filter out.
function atomKey(kind: KnowledgeAtomKind | 'grounding_source' | 'grounding_entity' | 'grounding_claim' | 'scope_owner', id: string): string {
  return `${kind}:${id}`;
}

/**
 * Extract candidate facts from agent task output.
 *
 * BL11a interim fix: agent outputs are Markdown with code blocks, JSON
 * payloads, and reasoning traces. Splitting on `. ` inside JSON is
 * catastrophically wrong, so fenced code and JSON blocks are stripped before
 * sentence splitting. The max-6 cap is gone (it silently dropped facts), the
 * length window is widened (25–500 chars) so short high-value rules like
 * "Never use em dashes" survive.
 */
/**
 * Legacy synchronous extractor (used by `extractAndPromote`). Now delegates to
 * the hardened deterministic formation gate so the sync path benefits from the
 * same garbage rejection as `promote()`. Returns plain statement strings.
 */
function extractPromotableFacts(value: unknown): string[] {
  return extractCandidateStatements(value).map((c) => c.text);
}

/** One-line outcome marker for a transient (episodic_only) run. */
function episodicMarkerSummary(input: CollectiveCognitivePromotionInput): string | null {
  const flat = extractFlatText(input.taskOutput);
  const firstSentence = flat
    .split(/(?:\r?\n|(?<=[.!?])\s+)/)
    .map((s) => s.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+)/, '').trim().replace(/\s+/g, ' '))
    .find((s) => s.length >= 8 && s.length <= 180);
  const label = input.taskTitle?.trim() || 'Task';
  if (firstSentence) return truncate(`${label} ran — ${firstSentence}`, 200);
  return `${truncate(label, 160)} ran.`;
}

/** Flatten output to plain text (used only by the marker summarizer). */
function extractFlatText(value: unknown, depth = 0): string {
  if (depth > 4 || value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return '';
  if (Array.isArray(value)) return value.map((e) => extractFlatText(e, depth + 1)).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    const out: string[] = [];
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|password|authorization|cookie/i.test(key)) continue;
      const t = extractFlatText(entry, depth + 1);
      if (t) out.push(t);
    }
    return out.join('\n');
  }
  return '';
}

/** ISO timestamp `days` in the future — used for episodic-trace TTL. */
function ttlIso(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

/** Outcome polarity for a judged episode type. */
function outcomeFor(type: RuntimeEpisodeType): 'good' | 'bad' | 'mixed' {
  if (type === 'failure') return 'bad';
  if (type === 'success_pattern' || type === 'recovery') return 'good';
  return 'mixed';
}

function titleFromFact(fact: string): string {
  const clean = fact.replace(/^[-*\d.)\s]+/, '').trim();
  return truncate(clean, 92);
}

/**
 * Dedupe scored statements by normalized text, keeping the highest score.
 *
 * §B5.4 — this used to key on `[^a-z0-9]` and `continue` on an empty key, which
 * meant a statement written in Russian, Greek, Arabic, Hebrew, Thai, Chinese,
 * Japanese or Korean normalized to "" and was DELETED here — before the
 * Formation Judge, before any scoring gate, with no log. Shared Unicode
 * segmentation fixes the key; the empty-key case now falls back to the raw
 * trimmed text so a statement can never be dropped merely for being
 * unsegmentable. Only genuinely empty input is skipped.
 */
function dedupeCandidates(candidates: ScoredStatement[]): ScoredStatement[] {
  const byKey = new Map<string, ScoredStatement>();
  for (const candidate of candidates) {
    const segmented = segment(candidate.text).join(' ');
    const key = segmented || candidate.text.trim().toLowerCase();
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev || candidate.score > prev.score) byKey.set(key, candidate);
  }
  return [...byKey.values()];
}

function relationFor(fact: string, target: string): KnowledgeLinkRelation {
  const lower = `${fact}\n${target}`.toLowerCase();
  if (/contradict|instead|not true|actually|but actual|differs|mismatch/.test(lower)) return 'contradicts';
  if (/because|therefore|derived|from/.test(lower)) return 'derived_from';
  return 'refines';
}


/** Parse a stored embedding column (JSON array or already-parsed array). */
function parseEmbedding(raw: unknown): number[] | null {
  if (Array.isArray(raw)) return raw.every((n) => typeof n === 'number') ? (raw as number[]) : null;
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) && value.every((n) => typeof n === 'number') ? value : null;
  } catch {
    return null;
  }
}

/**
 * §B2.2 — Maximal Marginal Relevance selection. Greedily picks `limit` items that
 * are both relevant (high score) AND diverse (low similarity to already-picked),
 * so a dispatch never wastes its budget on five paraphrases of one atom. Pure +
 * model-free: uses the lexical `similarity` over atom text. Falls through to the
 * plain top-K when there is nothing to diversify.
 */
function mmrSelect<T extends { score: number; text: string; vec?: number[] | null }>(candidates: T[], limit: number, lambda: number): T[] {
  if (candidates.length <= limit) return candidates;
  const pool = candidates.slice(0, Math.max(limit * 3, limit));
  const maxScore = Math.max(...pool.map((c) => c.score), 1e-9);
  const selected: T[] = [];
  // §0.3a — diversity is measured by COSINE between candidate vectors, not lexical
  // text overlap. Every candidate here cleared the semantic score gate, so it
  // carries a comparable vector; the text path is a defensive fallback only.
  const diversity = (a: T, b: T): number => {
    if (a.vec && b.vec && a.vec.length === b.vec.length) return cosineSimilarity(a.vec, b.vec);
    return similarity(a.text, b.text);
  };
  while (selected.length < limit && pool.length > 0) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const rel = pool[i]!.score / maxScore;
      let maxSim = 0;
      for (const s of selected) {
        const sim = diversity(pool[i]!, s);
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = lambda * rel - (1 - lambda) * maxSim;
      if (mmr > bestVal) { bestVal = mmr; bestIdx = i; }
    }
    selected.push(pool.splice(bestIdx, 1)[0]!);
  }
  return selected;
}

// §C5 — multi-scale temporal memory. One freshness curve can't serve "what did
// we just say" and "the rule from 6 months ago", so the injector classifies each
// atom into a SCALE and fills the budget across scales by surface.
type MemoryScale = 'working' | 'episodic' | 'semantic';

function scaleOf(atom: BrainSearchResult): MemoryScale {
  const tags = atom.tags ?? [];
  if (
    atom.kind === 'memory'
    || tags.includes('generalization') || tags.includes('upward_generalized')
    || tags.includes('charter') || tags.includes('rule') || tags.includes('pacer:conceptual')
  ) return 'semantic';
  const ageDays = (Date.now() - Date.parse(atom.updatedAt)) / 86_400_000;
  if (Number.isFinite(ageDays) && ageDays <= 3) return 'working';
  return 'episodic';
}

/**
 * Select up to `limit` atoms balanced across temporal scales. Candidates arrive
 * sorted by score (best first). Each scale is filled to a surface-weighted target
 * by score; any unused budget backfills from the global best, so a scale never
 * starves the prompt.
 */
function selectAcrossScales(candidates: BrainSearchResult[], limit: number, surface: 'chat' | 'dispatch'): BrainSearchResult[] {
  if (candidates.length <= limit) return candidates;
  const buckets: Record<MemoryScale, BrainSearchResult[]> = { working: [], episodic: [], semantic: [] };
  for (const c of candidates) buckets[scaleOf(c)].push(c);
  const w = surface === 'chat'
    ? { working: 0.4, episodic: 0.2, semantic: 0.4 }
    : { working: 0.15, episodic: 0.45, semantic: 0.4 };
  const target: Record<MemoryScale, number> = {
    working: Math.round(limit * w.working),
    episodic: Math.round(limit * w.episodic),
    semantic: Math.round(limit * w.semantic),
  };
  const picked: BrainSearchResult[] = [];
  const used = new Set<string>();
  const countIn = (scale: MemoryScale) => picked.reduce((n, p) => n + (scaleOf(p) === scale ? 1 : 0), 0);
  for (const scale of ['semantic', 'episodic', 'working'] as MemoryScale[]) {
    for (const c of buckets[scale]) {
      if (countIn(scale) >= target[scale]) break;
      if (used.has(c.id)) continue;
      picked.push(c); used.add(c.id);
      if (picked.length >= limit) return picked;
    }
  }
  for (const c of candidates) {
    if (picked.length >= limit) break;
    if (!used.has(c.id)) { picked.push(c); used.add(c.id); }
  }
  return picked;
}

function latestActivity(nodes: BrainGraphNode[], links: BrainGraphLink[]): string | null {
  let latest = 0;
  for (const node of nodes) latest = Math.max(latest, Date.parse(node.updatedAt) || 0);
  for (const link of links) latest = Math.max(latest, Date.parse(link.updatedAt) || 0);
  return latest > 0 ? new Date(latest).toISOString() : null;
}

function scoreNode(node: BrainGraphNode): number {
  return node.confidence * 3 + Math.log1p(node.reinforceCount) + Date.parse(node.updatedAt) / 10_000_000_000_000;
}

function isStale(iso: string): boolean {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return false;
  return Date.now() - at > 1000 * 60 * 60 * 24 * 90;
}

function summarizeRows(rows: Array<typeof schema.memoryEpisodes.$inferSelect>) {
  const count = rows.length;
  const totalConfidence = rows.reduce((sum, row) => sum + clamp01(Number(row.confidence)), 0);
  const text = rows.map((row) => `${row.title} ${row.summary}`).join('\n');
  return {
    count,
    averageConfidence: count === 0 ? 0 : totalConfidence / count,
    capacityTokens: estimateTokens(text),
  };
}

function disputeAtom(row: typeof schema.memoryEpisodes.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    content: row.summary,
    confidence: clamp01(Number(row.confidence)),
    reinforceCount: 1,
    source: row.source,
    tags: parseJsonArray<string>(row.tags),
    contextCondition: row.contextCondition,
    disputeSnoozedUntil: row.disputeSnoozedUntil,
    updatedAt: row.updatedAt,
  };
}

function mergeDisputeContent(a: string, b: string): string {
  if (a.trim() === b.trim()) return a.trim();
  return `Context-aware synthesis: ${a.trim()} In a different context, ${b.trim()}`;
}
