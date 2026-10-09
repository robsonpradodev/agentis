# 02 · Agentic Applications

An **App** is a durable entity that bundles typed data, agent-authored interfaces, and
attached automation into a product an agent both builds and operates. Apps are the top-level
unit users create; a standalone workflow is auto-wrapped into an "App-of-one" (`build_workflow`
returns an `appId`).

## Data model

Tables (`packages/db/src/sqlite/schema.ts`):

- `apps` — slug, name, version, icon, owning domain/agent, status (`draft | published | archived`),
  policy (audience, custom-view gating, unsupervised-outbound safety).
- `app_collections` — typed collections: fields of `string | number | boolean | date | json`,
  optional strict-schema mode.
- `app_records` — rows in a collection.
- `app_surfaces` — named pages: a `ViewNode` tree + `SurfaceAction[]` + entry point.
- `app_contacts` — people the app tracks and reaches (ties into Subjects).

## Agentic App Contract v3

The visual surface is now one client of an App, not the App's architectural boundary. A v3
definition is revisioned in `app_definitions` and adds independently validated facets for:

- `contract` — semantic operations, resources, events, JSON input/output contracts, scopes,
  effects, economics, idempotency, and workflow/mission/component handlers;
- `frontend` and `components` — an unrestricted React/Tailwind source project plus sandboxed
  Node, Python/Docker, or OCI component exports;
- `storage` — portable relational intent and migration requirements;
- `orchestration` and `brainPolicy` — task templates, triggers, concurrency, working memory,
  retrieval, formation, retention, trust, and task-context sharing;
- `permissionsV3` — delegated scopes, egress, spend/effect ceilings, deterministic guardrail
  assertions, approvals, throttling, and escalation;
- `quality`, `artifacts`, and `projections` — eval suites, regression/release gates, cost and
  latency SLOs, datasets/SBOM/provenance, and REST/MCP/A2A exposure.

Cross-facet references are validated atomically: duplicate operation/resource/component IDs,
missing component exports or compensation operations, undeclared scopes, broken release gates,
and invalid A2A projections cannot be persisted. `.agentisapp` import/export round-trips these
facets without maintaining a second integration contract.

### One invocation runtime

Human UI actions, REST, MCP tools, A2A skills, workflows, and the TypeScript SDK all project into
`AppOperationRuntime`. It validates the input contract and delegated authority, enforces budgets
and guardrails, then dispatches the declared workflow, durable Mission, or sandboxed component.
Successful results retain raw `data` for compatibility and include a provenance envelope whose
`instructionAuthority` is always `none`; returned application content therefore cannot silently
become agent instruction.

Operations use `query | command | task | stream`. A runtime job remains an internal execution
primitive. A Task is the durable business objective exposed through `AgentMission`: it has a
root/parent/child tree, authority context, input and approval requests, cost/latency budgets,
artifacts, receipts, progress, and an append-only timeline. Parent cancellation cascades to active
children. MCP implements the Tasks extension projection, while A2A exposes task discovery,
inspection, cancellation, state history, and SSE subscription.

### Effect lifecycle and delegated authority

Every non-read operation follows one durable lifecycle:

```text
prepare immutable EffectPlan
  → authorize a hash-bound AuthorizationGrant when policy requires it
  → execute once under an idempotency key
  → reconcile evidence into a completed effect
  → optionally compensate a settled compensatable effect
```

Authority records the owner, initiator, current actor, delegation chain, scopes, expiry, maximum
effect level, and spend ceiling. Delegation cannot amplify any parent constraint. Approval resumes
the exact suspended operation automatically; retries with its idempotency key observe the existing
running/completed effect instead of repeating it. Rejecting approval cancels the effect plan and
settles the Task as rejected.

### Managed source and immutable builds

Each App can initialize a managed bare Git repository under the Agentis data directory. The
starter is a real Vite/React/Tailwind project, not a constrained ViewNode template. Builds resolve
the latest default-branch commit, create an isolated detached worktree, install the frozen lockfile
with lifecycle scripts disabled, run the source build, honor the declared output directory, and
publish an immutable content-hashed artifact with an SBOM and build provenance. Exact path
containment checks prevent project or output paths from escaping their managed roots.

Runtime lives inside the App engine rather than competing with the App's primary facets. Its
technical view exposes operations, Tasks, effects, managed builds, release gates, and the raw v3
definition when an operator needs it.

## Datastore

`services/app/` exposes a query DSL over collections: filter / sort / limit / cursor, with
optional strict schema validation. The web app renders collections in an editable
`AppDataGrid`; mutations emit `DATA_CHANGED` on the `workspace` realtime room so open surfaces
refresh live. The **data loop closes**: terminal run outcomes feed back into records and
subjects.

- Tools: `agentis.data.{define_collection,insert,update,upsert,delete,query,promote_memory}`.

## Interfaces — human projections of the App contract

Alongside portable ViewNode surfaces, an App can publish an unrestricted managed React/Tailwind
interface from its source-controlled project. Agent-authored revisions build into immutable
artifacts and retain rollback history. Every interaction can bind to the same semantic operations
used by agents, workflows, MCP, A2A, and the SDK.

The Interface facet can enter a focused full-screen mode without changing route or runtime state;
**Return to App** (or Escape) restores the complete App workspace.

### Legacy AG-UI compatibility

Existing surfaces may still be authored as a typed **ViewNode** tree
(`packages/core/src/types/view.ts`). This builder is a compatibility path, not the creation
default. Its ~40 node kinds span:

- **Layout** — Stack, Grid, Split, Tabs, Accordion, Card, Section.
- **Content** — Text, Heading, Metric, KPIStrip, Image, Avatar, ProgressBar, Sparkline.
- **Data-bound** — Table, List, Chart (line/bar/pie/area/donut), Timeline, DataBoard.
- **Interactive** — Form (typed fields), Button, Badge.
- **Agent-native** — ActivityStream, RunMonitor, AgentFeed, ApprovalGate, Orchestration,
  AgentRegion, CodeViewer, MediaGallery, DocumentViewer, MapView.

Styling is design-system-bounded (`packages/core/src/genui.ts`): semantic tones, named
palettes, per-surface design languages/themes, and shell modes (`full | minimal | none` for
embeds) — no raw CSS escape hatch by default.

- Tools: `agentis.ui.{render,patch,compose,perform_region,action_schema,lint}`.

## Surface generation — the taste engine

`packages/core/src/genui.ts` + `services/surfaceGenerator.ts` classify a collection's shape
into an **archetype** (`analytics | pipeline | crm | roadmap | operations`) and scaffold a
**mission-control product** — the fitting composite (Kanban / RecordMaster / Roadmap / Chart)
beside a live operations rail (RunMonitor + AgentFeed) under the App's OrchestrationPanel,
wrapped by the App Shell. The same module backs both the API generator and the web
"create interface" default, so starter surfaces look consistent everywhere. Agents can also
generate/patch a surface from natural language; the web editor is a WYSIWYG canvas with live
binding preview.

## App Shell & live-ops

The runtime chrome (`apps/web/src/components/apps/`) wraps every surface: a sidebar (surface
list), a topbar (live status, approvals, refresh), and an ops drawer (Runs / Activity /
Approvals / Rules). URL routing is `?page=<surface>` in search params. Public surfaces are
token-gated, read-only, CSP-safe, and embeddable (`PublicAppSurfacePage`).

## Orchestration & proactivity

- **Agent Missions** (`services/agentMissions.ts`, `services/agentMissionDriver.ts`) — durable
  requested outcomes owned by an Agent. App triggers, workflows, Subjects, and follow-ups create
  or resume correlated missions; only verified effect receipts settle actionable work.
- **Agent execution** (`services/agentExecutionController.ts`) — the configured Agent model turns
  natural requests into answer, clarification, action, wait, or verified-complete decisions. Action
  plans may contain ordered or parallel effects; deterministic App services enforce contracts,
  authority, safety, idempotency, and receipts without replacing model reasoning with keywords.
- **App orchestration** (`services/app/appOrchestrator.ts`) — multi-workflow rules:
  chain-on-completion, cron scheduling, concurrency (exclusive), run-all; cycle-safe via a
  per-lineage depth cap.
- **Subjects** (`services/subjectRuntime.ts`) — per-contact actors with a declarative
  lifecycle (`send → agent → wait → done`) that survive restarts and resume out of order.
- **Conversation scripts** — declarative per-contact state machines that advance on each
  inbound message (`agentis.conversation.{define,enroll,flag_needs_attention}`).
- **Proactive followups** (`services/proactiveFollowups.ts`) — a sweep over due
  `nextTouchAt` clocks dispatches turns so apps reach out first (subject to outbound policy).

## Readiness and portable App revisions

The App compiler reports four separate readiness facets: **Structure**, **Execute**, **Verify**,
and **Deliver**. Structural and executable blockers determine whether an operator can start a proof
run; verification and delivery evidence determine whether the result is ready to trust or release.
Runtime, channel, surface, and test checks feed those facets, so a polished interface cannot hide
an unavailable binary, component runtime, permission mismatch, or unverified business outcome.

New App construction is gated by a durable `BuildSession` and validated `AppBlueprint`. The
blueprint captures durable roles, runtime/capability requirements, Brain and skill bindings,
workflow ports, typed contracts, acceptance criteria, and bounded swarm templates. Agentis takes a
tool-backed `WorkspaceSnapshot` before materialization; a model cannot create an App by merely
claiming that it did so.

Portable `.agentisapp` bundles carry the App's transitive workflows, surfaces, data contracts,
runtime requirements, and content-addressed portable component files. The operator-facing export
terms are **Live version** (the verified graph used by production) and **Change needs attention**
when a verified-safe change cannot be promoted. Candidate revisions remain an internal isolation
and rollback mechanism rather than a user-facing drafts product: safe changes verify and publish
automatically; cron, external sends, credentials, and other irreversible effects remain awaiting
approval for the exact verified hash. Historical revision fields remain available for lineage and
compatibility. Local executable paths, commands, working directories, environment values,
repository paths, and runtime project roots are removed from the bundle. Import verifies
manifest/runtime compatibility, file hashes, dependency locks, and component entrypoints before
activating anything; unsafe or conflicting bundles fail closed.

`GET /v1/build-sessions/latest?conversationId=...` and `...?appId=...` recover the latest build
evidence. `agentis.app.verify` settles the session from compiler, dry-run, suite, runtime, and
delivery evidence. Every materialized resource contributes a revision-specific `ProofReceipt`; the
agent's final prose is a summary and cannot promote or complete the build. A failed verification
gets one bounded deterministic repair attempt; otherwise the session is blocked with an actionable
diagnostic and controls to continue fixing, compare with the live version, or discard the change.

## App Goals & the Evolution Loop

An App can hold a durable **Goal** (the reserved north-star tier — distinct from a run-scoped
**Objective**; a Goal decomposes into the objectives runs chase) and get measurably better at
it over time. The loop closes three arcs that previously existed but never touched:

- **Goal** (`services/app/appGoal.ts`, `AppIdentity.goal` in the manifest) — a statement +
  optional north-star metric, set via `agentis.app.goal`. Portable (rides the manifest) and
  mirrored into the App's Brain scope as a governing atom, so every run recalls it.
- **Strategy** (`strategies` table, `services/app/strategyService.ts`) — a competing approach
  mapped to an experiment arm. Confidence is the **outcome-weighted** Laplace win rate
  `(wins+1)/(trials+2)`, _not_ recurrence; proven strategies mirror into the App Brain as
  recallable atoms. Tools: `agentis.strategy.{propose,list}`.
- **Measure → learn bridge** — `ExperimentService.record` fires an `onOutcome` hook →
  `StrategyService.recordExperimentOutcome`, so an A/B outcome updates the arm's strategy.
  `RollingBaselineStore` (now wired into `AppLearningService.onRunSettled`) captures 7/30/90d
  performance baselines.
- **Evolution controller** (`services/app/strategyEvolution.ts`) — winner selection gated by a
  min-sample floor + a two-proportion z-test (no promotion on noise); promotes the winner,
  retires significant losers, recommends the next generation. A 6h scheduler sweep runs it;
  **ACT** (auto promote/retire) is operator-gated (`AGENTIS_EVOLUTION_AUTONOMY`, off by
  default — otherwise SURFACE-only). Tool: `agentis.evolution.review`.
- **Goal dashboard** — `GET /v1/apps/:id/goal` (goal + strategies + decisions +
  experiments + baselines, computed live) → the App engine's **Goal** tab
  (`AppGoalPanel`).

The decision core is deterministic and tested; next-generation variant _authoring_ is left to
the owner agent (via `strategy.propose`), keeping the LLM out of the promote/retire logic.

## API surface

- HTTP: `/v1/apps`, `/v1/apps/:id/definition`, `/v1/apps/:id/operations`,
  `/v1/apps/:id/tasks`, `/v1/apps/:id/project`, `/v1/apps/:id/builds`, `/v1/effects`,
  `/v1/missions`, `/v1/mcp`, `/v1/a2a`, `/v1/artifacts`, `/v1/rooms`,
  `/v1/interactions`, `/v1/workspace-context`, `/v1/apps/:id/goal`, and
  `/v1/apps/:id/export`.
- Tools: `agentis.app.{create,list,archive,delete,adopt_workflow,scaffold,plan,goal}`,
  `agentis.strategy.{propose,list}`, `agentis.evolution.review`, plus the `data.*` and `ui.*`
  families above.
- Web pages: `AppsPage`, `AppEditorPage` (Interface / Workflow / Data / Brain facets, with Runtime in App engine),
  `PublicAppSurfacePage`, `GenUIShowcasePage`. App engine modal → **Goal** tab (Goal dashboard).

---

**Next:** [03 · Self-Healing Orchestration →](./03-orchestration.md)
