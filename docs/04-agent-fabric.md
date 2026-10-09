# 04 · The Agent Fabric (RAL)

Agentis drives many agent runtimes through one normalized contract, and matches work to
runtimes by **capability** rather than by hardcoded name. The capability layer is the
**Runtime Abstraction Layer (RAL)**.

> Naming note: this was formerly "HAL"; it is a *runtime* abstraction, not a hardware one, so
> the codebase and docs use **RAL** (`packages/core/src/ralAffordances.ts`,
> `RAL_AFFORDANCES`, `RalMatchState`, …).

## Adapters — one contract, many runtimes

Each runtime is an adapter (`apps/api/src/adapters/`) normalized behind `AdapterManager` and
protected by a per-runtime `CircuitBreaker`. Every task is a `NormalizedTask`.

| Adapter | Runtime | Notes |
|---------|---------|-------|
| `ClaudeCodeAdapter` | Claude Code CLI | native or hermetic profile; native MCP when a server is mounted |
| `CodexAdapter` | OpenAI Codex CLI | native profile preserves user/project config, skills, plugins, browser, and named permissions |
| `CursorAdapter` | Cursor | semantic code index |
| `AntigravityAdapter` | Google Antigravity (agy) | structured `stream-json` stdout; canonical CLI model ids |
| `HermesAgentAdapter` | Hermes Agent (ACP) | dual-transport ACP client |
| `HermesAdapter` / `LocalLlmAdapter` | OpenAI-compatible streaming | Nous / LM Studio / llama.cpp |
| `OpenClawAdapter` | OpenClaw gateway | unified LLM gateway, session persistence |
| `HttpAdapter` | Custom HTTP callback | any endpoint, HMAC auth |

All six CLI/streaming harnesses share a common chat runtime (`adapters/cliChatRuntime.ts`).

## Runtime Profile and the execution envelope

An adapter name is not enough to explain what a turn could actually do. Each commissioned
agent therefore carries a `RuntimeProfile` (`packages/core/src/types/adapter.ts`) with an
explicit execution mode (`native | hermetic | containerized`), project root, optional native
profile name, named permission profile (`read_only | workspace_write | trusted_local |
externally_sandboxed`), inheritance switches for user config/project instructions/plugins/skills,
browser posture, and persistent-or-ephemeral session policy.

`native` is the parity path: Agentis preserves the selected CLI harness's useful environment
instead of silently stripping the configuration that makes the same model capable in its desktop
app. `hermetic` is the repeatable isolated path. Permission profiles are enforced by adapter
arguments and MCP execution mode; they are not prompt-only suggestions and are never silently
widened.

Before every concrete chat turn, `RuntimeProfileService.captureExecution()` writes a non-secret
`AgentExecutionEnvelope` to `agent_execution_envelopes`. The envelope records the adapter,
effective profile, binary and CLI version, cwd, model/reasoning/tier, browser state, loaded source
classes (`user | project | agentis`), MCP server count, and capability warnings. The Runtime panel
shows this same record, so a weak answer can be diagnosed against the launch that produced it
rather than against an assumed configuration.

Session identity is conversation-scoped. Codex resume ids and equivalent native state are reused
only for the same Agentis conversation; unrelated conversations never share one global native
thread.

## Affordances — what a runtime can do

An affordance is a native power a runtime advertises (`packages/core/src/types/adapter.ts`,
`AGENT_AFFORDANCES`). Metadata lives in `RAL_AFFORDANCE_METADATA`:

| Affordance | Category | Meaning |
|-----------|----------|---------|
| `browser` | runtime | controls a live Chromium/browser runtime |
| `computerUse` | runtime | controls desktop apps on the host |
| `fileSystem` | workspace | reads/writes workspace files |
| `codebaseIndex` | workspace | uses a harness semantic code index |
| `terminal` | control | runs shell commands |
| `nativeMcp` | protocol | uses Agentis MCP tools directly from the harness |

A runtime's **supply** is computed two ways (`ralAffordances.ts`):
- `configuredAffordances(adapterType, config)` — what it provides right now, given its stored
  config (e.g. `claude_code` always provides filesystem/terminal access and provides native MCP
  only when an MCP server is mounted).
- `potentialAffordances(adapterType)` — the ceiling it *could* provide with a config change.
  Codex has latent browser/computer-use; Codex, Claude Code, and Hermes Agent can gain native MCP
  by mounting an Agentis MCP server.

## Requirement matching

A workflow agent node declares a **requirement** via `requires` (an `AgentRequirements`
subset). The fabric matches every workspace agent against it and returns a `RalMatchState`:

- `ready` — connected and its live runtime advertises everything required;
- `offline_capable` — configured to satisfy it, but not currently connected;
- `enablable` — a config change could satisfy it (e.g. enable Codex native browser);
- `incapable` — this runtime can never provide a required affordance.

`agentRequirementMatches()` ranks all agents `ready → offline_capable → enablable → incapable`,
so the canvas shows a concrete path to a satisfiable node instead of a dead end. Node readiness
uses this in `services/workflow/workflowReadiness.ts`; `requires` is treated as **hard
routing** (`agentis.build_workflow` normalizes generated requirements via
`normalizeGeneratedRalRequirements`). For ordinary web automation, prefer a `browser` node over
requiring native browser control on an agent.

MCP servers can also *grant* an affordance when tagged (e.g. a desktop server granting
`computerUse`), bridged in `services/mcp/mcpToolBridge.ts`.

### Dispatch-bound capability contract

Affordances are projected into a versioned `RuntimeCapabilityManifest`
(`packages/core/src/runtimeCapabilities.ts`). Tasks may declare `allOf` and `anyOf`
requirements, including namespaced third-party capabilities. `AdapterManager` evaluates the
manifest immediately before dispatch, before acquiring execution capacity. An incompatible
task fails with `ADAPTER_CAPABILITY_MISMATCH`, structured missing-capability evidence, and a
repair instruction; it is never sent to a runtime and allowed to fabricate work it cannot do.

The agent HTTP surface exposes the effective manifest, and workflow agent/swarm nodes propagate
their requirements to this final boundary. Tasks without explicit requirements retain backward
compatibility.

Every built-in adapter publishes a complete adapter-authored manifest: unavailable built-ins are
declared explicitly instead of guessed from the transport. Browser/computer-use and native MCP
claims therefore follow the live adapter configuration. Custom HTTP runtimes can persist a
validated `capabilityManifest`, including namespaced capabilities such as `vendor.video-render`;
anything they omit remains unavailable. Legacy projection remains only as the compatibility path
for third-party adapters that have not adopted native declarations yet.

## Model routing

`services/modelRoutingPolicy.ts` classifies a task and selects the **minimum-sufficient** tier
(fast / balanced / flagship). Per-agent hard pins and per-turn overrides take precedence.
`agentis.routing.preview` explains which runtime + model a task would select.

The paired black-box gate in `scripts/runtime-parity-eval.ts` runs one fixture corpus through the
native CLI and the Agentis conversation surface, scores both outputs, and fails when Agentis
regresses by more than the configured tolerance. Configure the two surfaces with
`AGENTIS_PARITY_NATIVE_JSON` and `AGENTIS_PARITY_{URL,API_KEY,WORKSPACE_ID,AGENT_ID}`, then run
`pnpm eval:runtime-parity`. An unpaired run is rejected unless `--allow-unpaired` is supplied
explicitly for harness smoke testing.

## Sessions, specialists, chat

- **Sessions** (`agent_sessions`, `agent_session_messages`) persist across LLM calls;
  memory blocks (persona/task/plan/observations) are reconstructed per call so tool loops
  spend no tokens re-sending context. Streaming + abort are supported where the runtime allows.
- **Specialists** (`services/specialist/`, `/v1/specialists`) — an open role registry
  (platform/custom/generated/community) with demand routing + scoring; a specialist runs a full
  agent session by default.
- **Chat** exposes sticky **Ask / Plan / Full access** permission modes shared across web and
  every channel (`auto` remains the API and slash-command identifier for Full access). The web
  always requests automatic task routing; explicit Quick/Deep/Mission overrides remain API
  compatibility inputs rather than permanent composer controls. Model, reasoning effort, and
  speed live in one runtime menu. Plan mode returns clean Markdown directly in the conversation;
  it does not emit `<proposed_plan>`, `<architecture_canvas>`, private `file://` links, or a
  second local plan document. `normalizeAgentPlanText()` strips that legacy protocol from cached
  adapters, streaming presentation, persistence, and external-channel delivery. Permission slash
  commands are recognized either before the task or as a final standalone line. The web selector
  updates immediately, and the API resolves the directive before execution classification: Plan
  turns can never be promoted into Mission acceptance, even when the task contains build language.

Substantive Full access turns enter the shared `AgentExecutionController`. The configured Agent
model classifies them as `reply`, `clarify`, `act`, `wait`, or receipt-backed `complete` and authors
the dependency-aware execution plan. Action decisions compile into durable Agent Missions;
answer-only requests stay ordinary turns. This is semantic model behavior across languages, not a
phrase or keyword router. A runtime turn may emit a natural progress message while its mission
continues; future-tense text is never evidence of terminal work.

### Execution truth and operator progress

Every turn terminates as `completed`, `failed`, `interrupted`, or `blocked`. A provider-capacity
or rate-limit failure is `blocked` and recoverable: the same durable turn can be resumed or run
with another model, rather than being presented as a completed answer. An operator Stop
revokes its execution lease, aborts the adapter and child runs, and fences late results; it is
recorded as **Response interrupted**, never as a provider failure. CLI adapters share this rule,
including non-zero child-process exits produced while their process tree is being cancelled.
The browser addresses Stop by durable turn ID whenever it has one. During the short create-turn
handoff before that ID reaches the browser, it also cancels by the client turn ID. This means a
closed SSE reader cannot orphan the server-owned worker: its abort controller is signalled and the
interactive lease is released by the turn's finalizer.

`conversation_turn_events` is the canonical ordered ledger for Chat, Home, and the technical
panel. Each versioned event is scoped to workspace, conversation, turn, agent, and optional run,
with a durable cursor and a visibility level (`chat`, `technical`, or `both`). SSE and historical
reads use this same contract, so reconnecting, reopening Chat, or moving away from Home replays
one coherent timeline without leaks or duplicates.

### Ordered follow-up turns

Conversation turns are serialized by the server, not by a browser-local queue. A newly accepted
turn is persisted as `queued`, emits its durable queue event, and receives an exact zero-based
position among the conversation's runnable turns. The turn endpoint returns that position so the
composer can render a quiet **Queued · N ahead** receipt instead of an assistant trace. When the
preceding turn releases its lease, the worker atomically claims the next turn, persists a
`queued → running` transition, and only then does the browser attach its SSE transcript. A second
submission therefore never aborts or visually replaces the first stream. Realtime delivery makes
that hand-off immediate; a short state read is only a reconnect fallback, never a client-side
attempt to start work.

The conversation renders safe commentary and a small factual activity set in chronological order.
It never presents generic lifecycle narration as thoughts. A substantive request immediately receives
a neutral **Starting** spinner; the host receipt is deliberately not rendered as agent-authored text.
If no safe provider update follows after eight seconds, one honest waiting row says that the
turn is still connected and can be stopped; the row disappears as soon as real progress arrives. Provider-designated summaries and the agent's
own operator-facing preambles are persisted beside real tool/command activity; raw chain-of-thought,
prompts, secrets, and sensitive tool arguments remain private. CLI assistant-message events preserve
their provider IDs, so each concrete "found / doing next" update appears immediately and stays in the
timeline. Streaming chunks for one message update that same row in place. If the latest message is the
final answer, only its provisional row is atomically promoted into the assistant body without
duplication; earlier progress remains. Tool start/completion events enter the same stream immediately
and update one row in place. The live transcript consumes the pre-execution tool event, so the row is
visible while the call is running rather than appearing only with its result. A recoverable failure is
shown as a soft **Retrying** state and removed when the agent moves on; red is reserved for an unresolved
terminal failure. Confirmation resumes emit the approved operation's running state before execution.
All harnesses are asked for one short progress sentence before their first substantive action
and another only when a concrete finding changes the next step. The transport keeps these updates to one
sentence and 220 characters, so progress cannot become a second answer or a token-heavy log. The technical panel can additionally show the sanitized operation,
affected resource, duration, and result. Stable event ids update an existing row in place, internal
discovery calls are suppressed, and recovered retries remain attached to the same turn.

Workflow `agent_task` uses this same executor and safe activity vocabulary. A Hermes task in
automatic caller-managed mode goes directly through the script-oriented, model-only one-shot CLI
path with the valid zero-tool `context_engine` profile. Agentis remains the only owner of platform
tools and supplies the complete catalog through marker calls, avoiding ACP startup and a hidden
Hermes-native loop. Explicit ACP remains pinned and retains its 20-second first-meaningful-event
watchdog; it never changes transport silently. Inspect the run activity for `transport`, `attempt`,
`phase`, `durationMs`, and any fallback reason when troubleshooting.

This is not a Hermes-only execution path. Codex, Claude Code, Cursor, Antigravity, OpenClaw, native
function-calling HTTP adapters, and text-only HTTP-compatible models all enter the shared executor
when they advertise chat. The executor is the sole owner of Agentis platform calls: a runtime either
forwards a structured call or emits a marker for that executor, but never executes the same platform
catalog in a second hidden loop. Node turn limits are enforced, and only a clean `stop` with a
contract-valid result completes an answer task. For action work, a clean model `stop` is still
nonterminal while commitments lack receipts: the executor returns the missing requirement ids and
tool observations to the same execution. External waits are event-driven and budget exhaustion
parks the Mission for recovery rather than fabricating completion.

The marker boundary normalizes canonical Agentis JSON, Hermes `<tool_call>` JSON, Hermes native
special-token blocks, nested named-tool XML, and legacy `REQUESTED TOOLS` transcripts. A bare
arguments object binds only when exactly one currently offered tool schema matches. Recognized
protocol is executed and stripped before any channel reply; ambiguous or malformed protocol enters
one immediate schema-repair round and must never be delivered to WhatsApp as human-facing prose.

Chat, channel turns, workflow Agent Tasks, standing goals, and mission wakes use one effective
capability resolver. Resident Agents receive the complete Agentis workspace API surface, while
relevance narrows what is presented to the model for the current objective. Required native
effects are checked before model spend. `GET /v1/agents/:agentId/effective-capabilities` exposes
the resolved tools, owned connections, active persistent grants, and authority basis without
exposing host secrets.

Antigravity's headless runtime writes its model turn to the current conversation transcript while
it runs. Agentis tails only that new turn and streams the model's operator-facing `content` as
commentary after stripping tool markers; the transcript's private `thinking` field is never read
into the chat ledger. Provider failures are preserved beside any partial work rather than hidden by
a generic failed state. Credit, quota, billing, and HTTP 402 errors explicitly tell the operator to
add credits or choose another model.

Editing an earlier operator message creates a new execution branch. Before the replacement runs,
Agentis cancels non-terminal durable turns, queued follow-ups, and active conversation-scoped workflow
runs from the superseded branch. The edited operator message keeps its historical position, while the
replacement assistant turn receives a fresh client identity and start timestamp. Old elapsed time and
blocked Mission recovery state therefore cannot reattach to the new task. Blocked-turn controls use
operator language (**Verification incomplete**, **Runtime unavailable**, or **Work paused**) and state
explicitly when no work remains active; internal Mission-acceptance jargon is not shown.

Codex model-catalogue parse failures (including a missing `base_instructions` field) are treated
as recoverable runtime state. Agentis only quarantines an identified `models-cache.json` or
`models_cache.json` file, then retries once; it never deletes Codex credentials or configuration.

## Workflow authoring contract

`agentis.build_workflow` accepts a natural-language `description` with an optional authored
`graphDraft`. When a synthesis runtime is unavailable, Agentis creates a deterministic,
editable baseline through the same validation and enrichment gates rather than asking a runtime
to guess a private graph format. `agentis.workflow.draft_contract` exposes the public request
shape, a minimal valid graph, and graph identity repair rules. Draft validation returns
`WORKFLOW_DRAFT_INVALID` with the affected field, accepted shape, and repair action.

Agent positions are durable workspace data. `/v1/agents/reconcile-layout` backfills only
missing or invalid legacy coordinates, preserves manual layouts, and emits an agent update so
Home and Agents canvases converge immediately. The Home resolver then lays out agents, managers,
workers, Apps, and sources in one deterministic collision pass. Manual coordinates are soft
anchors; event activity never recalculates topology or animates a stable layout.

## API surface

- Missions: `POST /v1/agents/:id/missions`, `GET /v1/agents/:id/missions`,
  `GET /v1/missions/:id`, mission SSE, resume, and cancel.
- Capability inspection: `GET /v1/agents/:id/effective-capabilities`.
- Standing goals: list, inspect, compile, revise/version, review diff, activate, and pause under
  `/v1/agents/:id/standing-goals`. The Agent detail Autonomy tab exposes the same scope, wake,
  pacing, safety, and mission-control operations without raw resource IDs.

## Chat-native temporary teams

Interactive chat can create a bounded temporary team with `agentis.team.spawn` when a request has
two or more genuinely independent subproblems. A chat swarm is durable (`conversation_swarms` and
`conversation_swarm_workers`) and linked to its `conversation_turns` record, but its workers are
not workspace agents unless the operator later promotes work into a durable specialist.

- Automatic fan-out is capped at **6 workers**, with **3 active concurrently**. Larger work is a
  normal approval decision, not a silent unbounded fan-out.
- A compatible live workspace agent may be selected, otherwise the coordinator's runtime is used
  with a temporary worker identity. Every worker inherits workspace and conversation scope but is
  given an empty tool catalogue and cannot delegate again.
- Only safe commentary and factual tool lifecycle are emitted. Private reasoning is neither shown
  nor stored. Worker evidence is returned to the lead for synthesis; a failed or credit-blocked
  worker is isolated instead of failing the whole team.
- The chat transcript stores swarm snapshots in the normal turn-event ledger. Reconnect and
  history replay therefore reconstruct the same compact team row and expanded worker state.
- Inline controls support pause, resume, stop, worker stop, and lead steering. A chat-wide Stop
  cascades through active and queued workers before releasing the conversation lease.

- HTTP: `/v1/agents`, `/v1/specialists`, `/v1/adapters`, `/v1/harness`, `/v1/command`,
  `/v1/conversations`, `/v1/terminal`.
- Tools: `agentis.agents.{list,create}`, `agentis.agent.{spawn,dispatch}`,
  `agentis.specialist.{create,request}`, `agentis.team.spawn`, `agentis.routing.preview`.

---

**Next:** [05 · Sovereignty →](./05-sovereignty.md)
