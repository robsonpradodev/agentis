# 01 · The Brain

The Brain is Agentis's durable memory and intelligence subsystem. It runs locally with a
verified on-device embedding model, gates what gets stored, classifies and reconciles memories, learns
from run outcomes, and answers queries with citations or explicit abstention. Grounding,
knowledge bases, and skills are sub-systems inside it.

## Storage model

Memory is one substrate — `memory_episodes` — discriminated by **plane**, **scope**, and
**type**, with a typed facade (`services/memory/memoryStore.ts`) restoring an ergonomic API.

- **Planes**: `workspace_memory` (durable, dispatch-injected) and `skill_library` (reached
  via search/materialization, never force-injected).
- **Scope**: workspace-global or bound to an agent / workflow / app.
- **Type** (`RuntimeEpisodeType`): `observation`, `success_pattern`, `distilled_lesson`,
  `decision`, `failure_chronicle`, etc., with outcome and superseded/archived tracking.

Related tables: `memory_promotion_events`, `promoted_patterns`, `brain_quality_events`,
`brain_working_set`, `session_moments`, `peer_profiles`, `peer_profile_conclusions`.

## Embeddings

`services/embedding/` provides a pluggable embedding provider. The default is a **local ONNX
`multilingual-e5-small` q8 model** (384-dim, multilingual, deterministic). Its pinned artifacts
are downloaded once (about 129 MB), verified by size and SHA-256, inference-probed, and then
reused offline; model weights are not bundled in the NPM tarball. An OpenAI-compatible provider
is opt-in. Every vector is stamped with its `modelId` + dimensions so mismatched vectors can
never be silently compared.

`EmbeddingRuntimeManager` is the sole owner of download, verification, load, retry, and
backfill readiness. State is persisted under the model cache and exposed through
`GET /v1/runtime/embedding`, `POST /v1/runtime/embedding/retry`, `/healthz`, the Brain settings
UI, and `agentis doctor --json`. `agentis warmup --repair` preserves the previous cache before
building and promoting a verified generation. Memory writes remain durable while the runtime
warms, but semantic indexing and recall are explicitly reported as pending until readiness.

## Formation pipeline

Before anything is stored, candidates pass a gate (`services/brain/brainFormation.ts`):

1. **Deterministic extraction** — `extractCandidateStatements()` strips URLs, tables, and
   boilerplate framing, then scores survivors.
2. **Output-shape classification** — `empty | document | list_rows | prose`; blocks transient
   work products masquerading as knowledge.
3. **Formation Judge** — a two-phase (Mem0-style) LLM step reconciles each candidate against
   its nearest neighbors and returns **ADD / UPDATE / NOOP**, so new knowledge corrects an
   existing memory instead of duplicating it.

A **write policy** (`form | episodic_only | none`) is resolved per candidate at enqueue time
(`services/memory/memoryPolicyResolver.ts`).

### PACER classification

Each memory is routed into one of five classes — **P**rocedural, **A**nalogical,
**C**onceptual, **E**vidence, **R**eference (`services/brain/brainPacer.ts`). The class sets
TTL, decay resistance, and per-class merge thresholds; there are no hand-tuned per-type rules.

## Recall

Hybrid retrieval (`services/episodicMemoryStore.ts`, `searchEpisodes`): TF-IDF over
title+summary+details combined with cosine over L2-normalized embeddings, plus freshness
decay and trust weighting. `SharedIntelligenceService.searchAtoms()` adds optional
model-assisted reranking and **MMR** diversity (λ≈0.72) with per-provider relevance floors.
Dispatch context is composed from a constitutional tier (operator rules) + a relevance tier
(`buildDispatchContext()`).

## Cited answers

`services/brain/brainAskService.ts` (`POST /v1/brain/ask`) returns a written answer with
`[mem:id]` citations, or **abstains** below a grounding floor (≈0.34) rather than
hallucinating. With no synthesis model available it degrades to a deterministic, fully-cited
list.

## Learning from outcomes

- **Intelligence promotion** (`services/intelligencePromotion.ts`) — run outcomes, approvals,
  evaluator verdicts, and operator annotations bootstrap durable patterns; confidence starts
  ~0.5 and grows with reinforcement (capped ~0.97). High-confidence patterns mirror into
  `workspace_memory`.
- **App strategies** (`services/app/strategyService.ts`) — a proven App **Strategy** (App
  Goal / Evolution Loop, see [Applications](./02-agentic-applications.md)) mirrors into the
  App's Brain scope as a recallable `success_pattern` atom whose confidence is the
  **outcome-weighted** win rate `(wins+1)/(trials+2)` — measured, not recurrence-driven — so a
  winning approach is what future runs recall.
- **Feynman repair** (`services/feynmanReflection.ts`) — after repeated failure, an
  explanation pass followed by a falsification pass produces a durable lesson **only if it
  survives**; weak explanations produce nothing.
- **Reflection** — `services/failureReflection.ts` (per-failure lessons) and
  `services/reflectionService.ts` (periodic deductive/inductive "dream" pass over runs and
  peers).

## Sub-systems inside the Brain

### Grounding — organizational truth with evidence
`apps/api/src/grounding/`, tables `grounding_*`:
- `grounding_claims` + `grounding_claim_evidence` — atomic claims whose confidence is computed
  from inspectable evidence; lifecycle `candidate → active → demoted` (activation ≈0.55;
  single-source consequential claims stay candidate).
- `grounding_evidence_versions` — append-only, versioned evidence (unique on
  object_id+content_hash); secrets redacted and prompt-injection labeled, never dropped from
  the audit trail.
- `grounding_identity_links` / `grounding_entities` — cross-source identity resolution;
  deterministic methods auto-merge, probabilistic matches queue for review.
- `grounding_investigations` — a bounded Feynman pass for the org that cites sources or
  publishes an explicit inconclusive result.
- `grounding_agent_grants` — per-agent retrieval scope (mode, allowed sources, confidentiality
  ceilings); retrieval is never action authority. Behavior is logged
  (`grounding_behavior_influences`) so the owner can trace what shaped an agent.

### Knowledge bases / RAG
`services/knowledge/knowledgeBase.ts`, tables `knowledge_bases`, `kb_documents`, `kb_chunks`,
`knowledge_chunks`, `knowledge_links`. Create workspace- or workflow-scoped bases; documents
are chunked, embedded, auto-linked into the Brain graph, and enriched via vision/OCR. Search
modes: contextual / strict / exploratory. Routes: `/v1/knowledge-bases`.

### Living skills
`services/skillService.ts`, `services/skillMaterializer.ts`. A skill is a `SKILL.md` body
(loaded on demand by CLI harnesses) plus a searchable, confidence-ranked atom in the
`skill_library` plane, with linked example atoms. Scope-affine (agent/workflow/app/workspace).
Routes: `/v1/skills`.

### Private Agent Brain maintenance

`agentis.agent.brain.inspect` returns the active private Memory, runtime Episode, Knowledge, Skill, and Example
inventory for one Agent with canonical ids and safe previews. `agentis.agent.brain.prune` then
performs a two-call, concurrency-safe selective reset: the first call previews every archive
candidate and returns a hash token; the second applies only if both the keep selection and Brain
inventory remain unchanged. Content is archived rather than destroyed, and managed skill files
are refreshed. The Agent record, runtime, Apps, and Connections are never part of this operation.

Operator clients use that same implementation through `GET /v1/agents/:agentId/brain` and the
two-phase `POST /v1/agents/:agentId/brain/prune`. The administrative API and Agent/MCP tools
therefore expose identical cleanup powers and confirmation semantics.

## API surface

- HTTP: `/v1/brain` (graph, health, ask, rebuild-memory), `/v1/agents/:agentId/brain`,
  `/v1/agents/:agentId/brain/prune`, `/v1/memory`, `/v1/knowledge-bases`,
  `/v1/skills`, `/v1/grounding`, `/v1/personal-brain`, `/v1/runtime/embedding`.
- Tools: `agentis.brain.search`, `agentis.memory.{write,read,delete}`,
  `agentis.knowledge.{write,search,archive}`, `agentis.skill.{load,promote_example}`,
  `agentis.agent.brain.{configure,inspect,prune}`.

---

**Next:** [02 · Agentic Applications →](./02-agentic-applications.md)
