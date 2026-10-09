# 03 · Self-Healing Orchestration

The workflow engine executes directed graphs of typed nodes, recovers from failures without
fabricating results, and judges runs against declared outcomes. Workflows are typed execution
plans inside the broader [Agent Mission](./08-agent-missions.md) model: the mission owns the
requested outcome, while a workflow run is one compatible execution mechanism. Source:
`apps/api/src/engine/`.

## Execution model

`WorkflowEngine` (`engine/WorkflowEngine.ts`) holds, per active run, a `ReadyQueue` and a
`WaitingInputBuffer`. Each tick:

1. drains the ready queue up to a configured parallelism;
2. dispatches each node by `config.kind` (a discriminated union — the dispatch switch is
   exhaustive at the type level);
3. completes deterministic nodes synchronously, or registers an async execution record for
   agent tasks, checkpoints, and subflows;
4. appends a monotonic `ledger_events` row and publishes a realtime envelope per transition;
5. snapshots run state to `workflow_run_snapshots` periodically for partial replay.

State stores: `RunStateStore.ts`, `ReadyQueue.ts`, `WaitingInputBuffer.ts`,
`ActiveWorkflowRegistry.ts`. Crash recovery re-hydrates interrupted runs on boot.

Action-oriented workflow starts create or reuse a mission and persist its id on
`workflow_runs.mission_id`. Run lifecycle completion is never authoritative over an unfinished
mission. The mission's outcome contract and normalized effect receipts decide whether the
requested work is accomplished, blocked, failed, or still waiting.

## Node kinds (50)

`WorkflowNodeType` (`packages/core/src/types/workflow.ts`):

- **Control flow** — `trigger`, `router`, `merge`, `parallel`, `loop`, `wait`, `subflow`,
  `checkpoint`, `stop_error`, `error_trigger`, `return_output`, `converge`, `pursue`.
- **Deterministic data & logic (zero LLM tokens)** — `transform`, `filter`, `code`,
  `data_query`, `data_mutate`, `aggregate_window`, `http_request`, `graphql`,
  `workflow_store`, `workspace_store`, `scratchpad`.
- **Intelligence** — `agent_task`, `agent_session`, `agent_swarm`, `dynamic_swarm`, `planner`,
  `evaluator`, `guardrails`, `extension_task`, `component_task`.
- **Knowledge** — `knowledge` (semantic search), `knowledge_ingest`.
- **Utility** — `datetime`, `crypto_util`, `xml_parse`, `markdown`, `spreadsheet` (csv/xlsx),
  `html_extract`, `json_schema_validate`.
- **I/O, integrations & artifacts** — `browser` (headless render / screenshot / PDF / form-fill),
  `channel`, `integration`, `mcp`, `artifact_collect`, `artifact_save`.
- **Human / annotation** — `human_input`, `sticky_note`.

Executors live in `engine/executors/` and `engine/handlers/` (deterministic/IO controller,
pure-expression handlers, and unit-testable utility converters).

## Objectives & cognitive looping

- **Objectives + SWIFT** — `agentis.workflow.scope` declares the acceptance outcome; the SWIFT
  verdict engine judges a run **accomplished** vs merely **completed**
  (`services/workflow/workflowDeliveryOrchestrator.ts`).
- **converge / pursue** (`engine/convergeLoop.ts`, `engine/pursuitControl.ts`) — iterative
  refinement with multi-signal stagnation detection (structural repeat, oscillation, plateau,
  regression), ASSESS/REFLECT triggers, and budget breakers (iterations / tokens / wall-clock).
  Loop state persists to the durable **blackboard** (queryable at `/v1/runs/:id/blackboard`).

## `agent_task` runtime semantics

Chat-capable workflow agents execute through `ChatSessionExecutor`, the same identity-, instruction-,
permission-, attachment-, cancellation-, tool-loop-, and output-parsing boundary used by Chat.
`dispatchTask()` remains a compatibility path only for adapters without the chat/tool-loop contract.
Every native task session is isolated as
`agent-task:<runId>:<nodeId>:attempt:<n>`; a retry after a stale runtime failure increments the
attempt instead of loading an ACP session from a previous run. The final value must still satisfy
the node's declared `outputKeys`; runtime lifecycle text is never accepted as output.

Substantive Agent Tasks also use the shared `AgentExecutionController`. The assigned model decides
whether work is an answer, clarification, action plan, external wait, or verified completion. An
action plan can contain ordered, parallel, observational, conditional, and verification steps.
Natural progress prose is streamed immediately but cannot terminate an unresolved plan.

The rule is runtime-agnostic: exactly one layer owns each Agentis platform tool call. Native
function-calling adapters forward calls into the shared executor; text-only adapters use the marker
protocol; Claude Code does not also mount the Agentis MCP server when the caller-managed loop is
active; OpenClaw keeps its gateway-native tools while bridging Agentis calls through markers; and
Hermes caller-managed tasks use script-oriented turns with the valid zero-tool
`context_engine` toolset. Agentis owns the visible platform tool loop; Hermes cannot enter a hidden
native-tool loop or contend with a second ACP process.
Interactive/direct runtime use keeps its normal native tool behavior.
The configured `maxTurns` is a per-run execution budget, not proof that the Mission ended. `error`, `max_turns`, `length`, an
unfinished `tool_calls` boundary, an absent terminal event, or an empty result pauses the node with
runtime, stage, elapsed time, attempt, session key, and retry guidance; none can be promoted into a
successful business result merely because the runtime emitted explanatory prose.

Every Agent Task can declare `taskMode: "answer" | "act"`. An `act` task must also declare
`completionContract.requiredEffects`. Preflight flags action-like legacy tasks without an
explicit contract. A task requiring channel delivery, data mutation, scheduling, or Subject
updates cannot complete from empty output, prose, or tool syntax; the shared effect ledger must
contain the required receipts. Multi-node workflows use native channel nodes for delivery and
gate downstream mutations on provider acknowledgement. Minimal one-Agent plans use the same
native services and evidence contract internally.

Each requirement has a stable id and each plan step has a lifecycle state. Two ordered channel
items therefore create two commitments and two receipts. A retry resumes only missing steps;
provider-acknowledged effects are never replayed. Schema repair and receipt reconciliation are
deterministic and do not spend model turns.

For Hermes `agent_task` calls with `chatTransport: auto`, the capability-preserving caller-managed
path goes directly to Hermes's model-only one-shot CLI. This is the same fast execution shape used by
interactive CLI chat: no ACP probe, no competing prewarm, no invalid synthetic toolset, and no second
provider loop. The complete Agentis catalog is described through the marker protocol, marker fragments
are reconstructed in stdout order, and runtime warnings cannot become business output. Each emitted
marker is executed by the shared executor before the next model turn.

Explicit `chatTransport: acp` remains authoritative and keeps ACP's public reasoning and native tool
lifecycle. Its first-meaningful-event watchdog is 20 seconds; handshake, usage, and command-catalog
messages do not satisfy it. A stalled session is cancelled and invalidated and the 15-minute ACP
circuit breaker is recorded, but an explicit pin is never silently changed. Only explicitly ACP-owned
runtimes are prepared early. Non-caller-managed automatic turns may use the existing ACP-to-CLI
recovery path when the fallback is capability-equivalent.

Operator-visible task cognition is stored in `run_activity_events`. Stable activity IDs update the
same row for cumulative reasoning and tool status. Runtime, waiting, safe reasoning summary,
commentary, tool, fallback, retry, and terminal phases retain transport, attempt, and timing metadata.
Private chain-of-thought, prompts, secrets, raw arguments, and sensitive results are not stored.
Heartbeat labels and IDs remain stable; elapsed time is computed by the UI from `startedAt`, so a
quiet runtime updates one durable row rather than adding a new row on every heartbeat.
`GET /v1/runs/:id/activity?limit=<1..400>&cursor=<ISO timestamp>` returns durable, workspace-scoped
replay with `nextCursor`; run SSE replays this history before attaching to live events. Activity is
retained and deleted with its workflow run through the existing cascade policy.

## Self-healing

`engine/selfHeal/` + `services/workflow/workflowSelfHeal.ts`. Recovery layers, in order:

1. **Output-contract recovery** — re-extract declared fields from the agent's own output.
2. **Runtime rebind** — swap the failed agent/adapter for a capable fallback specialist.
3. **Graph surgery** — intent-preserving structural repair (`WorkflowGraphPatch`), gated by an
   anti-hallucination certification (the patch must preserve intent and be grounded).
4. **Honest escalation** — if it can't recover, fail loudly rather than fabricate.

Guardrails: the **Blueprint law** — a graph proven to work is *blessed*
(`agentis.workflow.harden`) and never silently restructured; `restore_blueprint` rolls back;
a proven-divergence detector warns when a blessed graph was edited. Repair snapshots persist to
`workflow_repair_checkpoints`.

## Triggers, listeners, scheduling

- Direct triggers (`triggers` table, `engine/TriggerRuntime.ts`, `/v1/triggers`): **manual**,
  **cron** (timezone-aware), **webhook** (HMAC-SHA256, idempotency window).
- **Persistent listeners** v2 (`engine/ListenerRuntime.ts`, `/v1/listeners`): file / cursor /
  poll sources, JSONPath + JMESPath predicates, first-match / threshold / window fire policies,
  health tracking.
- Natural-language scheduling → UTC cron (`services/scheduleFromNaturalLanguage.ts`).
  Schedule bookkeeping in `schedule_runs`.

## Replay, subflows, ephemeral runs

- **Partial replay** (`services/partialReplay.ts`, `/v1/runs/:id/replay`): `from-node`,
  `failed-branch`, `with-edited-node`, `from-checkpoint`; each creates a new run linked by
  `parentRunId`.
- **Subflows** (`services/subflowExecutor.ts`) — parent awaits child terminal status; child
  scratchpad is namespaced to avoid collisions.
- **Ephemeral runs** (`services/ephemeralWorkflowService.ts`, `/v1/ephemeral`) — ad-hoc
  execution with no persisted workflow row; a debug mode suppresses self-heal/fallbacks to
  expose raw failures.
- **Idempotency** (`engine/idempotency.ts`) — deterministic per-node keys for safe retries.

## Validation

`engine/validateGraph.ts`, `validateGraphReferences.ts`, `validateExpressions.ts`,
`SafeConditionParser.ts` (hand-written recursive-descent grammar — never `eval`), plus graph
normalization that infers missing fields.

## API surface

- HTTP: `/v1/workflows`, `/v1/runs` (status, stream, activity, ledger, scratchpad,
  blackboard, replay), `/v1/missions`, `/v1/triggers`, `/v1/listeners`, `/v1/scheduler`,
  `/v1/ephemeral`.
- Tools: `agentis.build_workflow`, `agentis.workflow.{create,validate,dry_run,scope,test,harden,restore_blueprint,bless,deliver}`,
  `agentis.run.{await,status,diagnose,cancel,replay,inspect}`, `agentis.plan_workflow`.

## Completion, accomplishment, and executable App rules

`run.completed` is an execution lifecycle event. It says the graph stopped cleanly; it does
not prove that the requested result exists. A scoped workflow emits `run.accomplished` only
after its persisted definition-of-done passes. Success-gated App dependencies, event rules,
conversation continuations, and operator status surfaces all use the same outcome interpreter
(`services/workflow/runOutcome.ts`).

Every terminal run persists a **RunSettlement** that keeps execution truth separate from outcome
truth: `executionStatus` records lifecycle state, while the operator-facing `outcomeStatus` is
`accomplished`, `blocked`, or `not_accomplished` (`unverified` remains a compatibility state for
legacy and in-flight records). The settlement pins the workflow revision and semantic hash and
carries evidence references, deficiencies, and `settledAt`. Published MCP workflow calls report
success only when both dimensions are `completed` and `accomplished`.

Before a run is admitted, preflight reconciles declared inputs, persisted configuration, output
contract, terminal return, acceptance-check references, and named fixtures. A missing source,
credential, or service produces `blocked` with an actionable requirement before an empty run is
created. A mechanical or observable receipt is required for functional promotion; an unavailable
LLM judge is never created as a gate and an available judge remains complementary evidence.

Proof is revision-specific. `ProofReceipt` records the resource, revision, semantic hash, fixture,
check, observed evidence, and artifacts used to validate a change. Synthetic happy-path, empty
input, missing-dependency, and invalid-input fixtures are explicitly distinguished from production
proof. A final model message, a schema check, or a dry-run cannot by itself settle a workflow as
accomplished.

World-changing operations also persist **mutation receipts**. A receipt records attempted,
succeeded, failed, and skipped counts plus per-item terminal status and whether authoritative
verification was performed and passed. Batch success therefore describes the final observed
state, not merely an accepted request. If later production evidence contradicts a trusted result,
the workflow and revision are demoted to `regressed` rather than leaving stale proof in force.

Executable cross-workflow rules are persisted in `workflow_event_subscriptions` and authored
with `agentis.workflow.rule`. App-level `dependsOn` remains the simple dependency primitive;
event subscriptions add typed events, filters, input mapping, and coalescing. `agentis.app.doctor`
inspects the whole App across bindings, triggers, subscriptions, outcome contracts, state
machines, connections, and UI claims. The App interface exposes the same rules as first-class,
editable automation: operators can create, edit, enable, disable, and delete rules, configure
filters/mappings/coalescing/catch-up, and see Doctor blockers without inventing a second “run
pipeline” action.

Rule delivery is a durable state machine, not an in-memory event callback. Every source event is
journaled in `workflow_event_deliveries` with a stable event/delivery identity, payload snapshot,
status, retry count, lease, target queue/run evidence, and terminal error. CAS claims, expiring
leases, bounded backoff, queue idempotency, and restart reconciliation close the duplicate-run and
enqueue-before-ack crash windows. New rules only perform bounded catch-up for eligible runs created
after the subscription. Operators can inspect and retry failed deliveries through
`/v1/scheduler/deliveries`; delivered/skipped transitions are immutable and cannot be replayed into
a duplicate business action.

Doctor remediation is deliberately bounded. `agentis.app.doctor.repair` and
`POST /v1/apps/:id/doctor/repair` preview by default and can apply only deterministic safe repairs
(for example invalid dependencies or a stale source-node filter). Ambiguous findings remain
`review_required`. `agentis.apps.conformance.migrate` applies the same policy workspace-wide; it
does not make app-specific guesses.

## Safe graph mutation

Stored replacement, stored editing, and live-run evolution are separate contracts:

- `agentis.workflow.graph.replace` — complete at-rest replacement;
- `agentis.workflow.graph.patch` — recursive field/structural operations that preserve omitted
  fields;
- `agentis.run.graph.evolve` — live execution evolution only.

Stored mutations support graph hashes / `updatedAt` optimistic concurrency, dry-run diffs,
atomic validation, intent and approval guards, and the green ratchet. The old
`agentis.workflow.patch` remains a deprecated compatibility alias.

`workflow.patch` is therefore still a whole-graph replacement contract for compatibility. Agents
must not “retry it with more complete fields” to simulate a scoped edit. They use
`agentis.workflow.graph.patch` for field/structural operations; omitted node fields are preserved.
Every committed mutation records a bounded graph revision snapshot. Operators and agents can list
revision metadata with `agentis.workflow.graph.revisions` and preview/commit a rollback with
`agentis.workflow.graph.rollback`. Rollback requires the current `baseHash`, revalidates the graph,
and records the pre-rollback graph so the rollback itself is reversible.

## P0–P4 platform acceptance

| Phase | Platform invariant | Acceptance evidence |
|---|---|---|
| P0 — truth | Lifecycle completion never impersonates business accomplishment; channel delivery requires provider evidence. | Shared outcome interpreter, accomplishment events, provider receipts, no-false-success regressions. |
| P1 — durability | Rules, schedules, and queue transitions survive replay, concurrency, crashes, and restarts without duplicate target runs. | Delivery journal, CAS leases, stable idempotency keys, recovery and retry tests. |
| P2 — mutation safety | Scoped edits preserve omitted graph fields and every committed graph can be inspected and rolled back safely. | Preview/confirm, base-hash concurrency, validation/approval guards, revisions and reversible rollback tests. |
| P3 — app operability | Automation rules are persisted and editable in the product; Doctor distinguishes safe repair from human review. | Rule CRUD API/editor, guarded actions, Doctor repair/migration, truthful UI failure states. |
| P4 — agent power | Runtime powers are native, versioned, configuration-sensitive contracts enforced before dispatch. | Built-in adapter manifests, reusable conformance suite, structured mismatch evidence, third-party compatibility path. |

These are domain-neutral invariants. No phase contains Fashion-specific states, WhatsApp-specific
conversation logic, or assumptions about a particular app archetype.

---

**Next:** [04 · The Agent Fabric (RAL) →](./04-agent-fabric.md)
