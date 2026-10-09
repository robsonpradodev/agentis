# 08 · Durable Agent Missions

An **Agent Mission** is Agentis's durable record of requested work. Chat turns, channel
commands, workflow runs, standing-goal wakes, follow-ups, and direct API requests can all
create or resume a mission owned by one resident Agent. A runtime turn may end while the
mission keeps waiting, reconciling, or replanning; only mission settlement is terminal for
the requested outcome.

This keeps intent, execution, and proof on one plane. A message such as “I’ll send it” is a
progress update. It is not evidence that a message was sent, that a record changed, or that
the requested work finished.

Channel progress and execution have separate lifetimes. The Agent may immediately answer like a
person—“I’ll try the send again”—but the execution controller continues directly into the planned
tools. Ending a model turn never ends the requested action. Corrections such as “it didn’t send,
try again” are resolved semantically against incomplete work in the same conversation; Agentis
does not maintain a list of magic retry phrases.

## One intelligent execution controller

Chat, connected channels, Missions, standing-goal wakes, and workflow Agent Tasks all enter the
same `AgentExecutionController`. The assigned Agent model returns a normalized decision:

- `reply` for answer-only work;
- `clarify` only when information is genuinely unavailable;
- `act` with one or more atomic commitments, dependencies, targets, tools, and evidence;
- `wait` while an external result is pending;
- `complete` only after all commitments are verified.

The model owns language understanding, decomposition, asset selection, and strategy. Deterministic
services enforce schemas, authority, safety, idempotency, provider reconciliation, and receipt
truth. They do not replace the Agent with keyword routes or canned conversational responses.

## Lifecycle

`AgentMission.status` is one of:

| Status         | Meaning                                                                          |
| -------------- | -------------------------------------------------------------------------------- |
| `queued`       | Accepted durably and waiting for execution.                                      |
| `running`      | The owning Agent is executing the current step.                                  |
| `waiting`      | Parked on a recoverable dependency or future wake; no model polling is required. |
| `replanning`   | A different executable strategy is being prepared after a concrete failure.      |
| `accomplished` | Every required effect has verified receipts.                                     |
| `blocked`      | One concrete dependency prevents further executable recovery.                    |
| `failed`       | An unrecoverable error or configured execution budget ended the work.             |
| `cancelled`    | Explicitly cancelled by an operator or superseding action.                       |

Missions persist the objective, owner Agent, optional App and Subject, source and correlation
identity, outcome contract, typed plan, current step, blocker, next wake, attempts, token use,
progress, timestamps, and receipts. A stable `correlationKey` prevents a continuation,
provider callback, or replay from creating duplicate work.

Follow-up messages—including a retry request, a supplied phone number, a changed instruction, an
approval decision, or a delivery-state update—can resume the newest uniquely correlated incomplete
mission. Correlation is semantic and conversation-scoped rather than phrase-driven. An explicit
operator resume opens a fresh configured budget window; it must not immediately re-block on a stale
attempt counter. If correlation is ambiguous, the Agent clarifies rather than guessing.
Short social-looking replies such as “ok” use the inexpensive chat path only when the
conversation has no incomplete Mission. With pending work, the complete relevant capability
surface remains available and the model decides whether the reply resumes, changes, or merely
acknowledges that work.

## Outcome contracts and effect receipts

`MissionOutcomeContract.requiredEffects` declares what must be true before accomplishment.
Every commitment has a stable requirement id, effect kind, target, evidence policy, and optional
dependencies. This makes two deliveries two different obligations instead of a coarse
`channel_delivery x2` counter. Supported effect kinds are `channel_delivery`, `data_mutation`,
`schedule`, and `subject_update`. The success policy is `all_required_effects`.

An `EffectReceipt` records:

- mission, plan-step, requirement, and effect-intent identity;
- action and tool-call identity;
- provider message id, status, and acknowledgement;
- mutated resource identity and version;
- idempotency key, evidence, and observation time.

Empty output, prose claims, raw tool syntax, dry-run success, and `outputKeys: []` are not
effect evidence. A mission settles as `accomplished` only when the normalized ledger contains
the required acknowledged receipts.

## Typed execution plans

An `ExecutionPlan` declares versioned `observe`, `decide`, `effect`, `verify`, and `wait` steps.
Each step has a durable lifecycle of `pending`, `ready`, `executing`, `waiting`, `verified`,
`failed`, or `cancelled`; dependencies and requirement ids make partial completion resumable.
Workflows compile onto this model: `workflow_runs.mission_id` links the compatibility run to its
authoritative mission.

For example, “send a sticker and then a PDF” becomes two ordered effect steps and two distinct
requirements. If WhatsApp acknowledges the sticker and the PDF fails before submission, replay
starts at the PDF. It never duplicates the acknowledged sticker.

An `agent_task` explicitly chooses:

- `taskMode: "answer"` for a result that requires no external effect;
- `taskMode: "act"` plus `completionContract.requiredEffects` for world-changing work.

Preflight flags action language without an effect contract. In a multi-node workflow, native
channel nodes own delivery and provider receipts gate downstream mutations. A minimal
Trigger → Agent Task workflow may act end to end, but it still uses native tools and the same
receipt ledger internally. Agent prose cannot self-report delivery.

## Capability and authority

Every execution surface uses the same effective-capability resolver. Resident Agents can use
the complete Agentis workspace API surface; relevance controls the tools shown to a model, not
whether a mission-required native capability exists. Inspect the resolved view with:

```text
GET /v1/agents/:agentId/effective-capabilities
```

Connection authority is deterministic:

- the connection-owning Agent receives its configured scope with basis `connection_owner`;
- a verified owner command authorizes that exact action;
- delegated work retains the verified command's action-scoped authority;
- an activated standing goal uses its compiled policy envelope;
- genuine cross-Agent access requires an active persistent grant.

Full workspace power means Agentis resources and configured connections. It never exposes host
secrets or globally disables suppression, opt-out, quiet hours, rate limits, human handoff,
approval policy, or provider restrictions. Human handoff suppresses unsolicited automation; a
verified owner command may cross it only as one persisted, idempotent effect and does not release
the handoff or authorize later autonomous sends. A real approval is a durable, visible inbox item
linked to the held work; invisible approval requests are invalid.

## Standing goals

An `AgentStandingGoal` is a compiled, versioned mission producer—not a pending-work queue in the
Brain. It retains its source instructions and structured policy envelope: allowed Apps,
Connections, capabilities and action categories; event wakes; reconciliation cadence; quiet
hours; hourly limits; suppression and handoff behavior; and owner-notification policy.

Compilation creates a `draft`. Review its structured diff, then activate it explicitly. An
active wake creates or resumes a correlated mission through the resident Agent dispatcher.
Pausing the goal prevents new autonomous work without deleting its history. Draft and paused
goals can be edited; each save increments the version and returns the goal to `draft`. Active
goals must be paused before editing so a live authority envelope can never change silently.
The Agent detail **Autonomy** tab exposes this lifecycle as an operator control deck with named
App and Connection scope, wake conditions, recovery cadence, quiet hours, rate limits,
suppression/handoff controls, owner notifications, and mission Resume/Cancel actions.
Compilation, migration, review, and editing never send messages.

```text
GET  /v1/agents/:agentId/standing-goals
POST /v1/agents/:agentId/standing-goals/compile
GET  /v1/agents/:agentId/standing-goals/:goalId
PATCH /v1/agents/:agentId/standing-goals/:goalId
GET  /v1/agents/:agentId/standing-goals/:goalId/review-diff
POST /v1/agents/:agentId/standing-goals/:goalId/activate
POST /v1/agents/:agentId/standing-goals/:goalId/pause
GET  /v1/agents/:agentId/autonomy-status
```

## Channel effect transaction

Outbound actions use `channel_action_intents`, including direct Agent sends and workflow
channel nodes. An intent stores its mission, Subject, resolved or unresolved recipient, message,
authorization basis, stable idempotency key, acknowledgement requirement, and optional
post-ack mutations.

A first-touch send follows one saga:

1. reserve the eligible Subject/lead;
2. compose the message;
3. create or reconcile the channel intent;
4. send once with the stable idempotency key;
5. persist provider acknowledgement;
6. apply compare-and-swap post-ack mutations;
7. record delivery and mutation receipts;
8. settle the mission.

Pending or uncertain acknowledgement leaves business state unchanged and schedules
reconciliation. Replay checks the existing intent and receipt before sending, so restart or
retry cannot duplicate delivery.

Recipients may remain unresolved. The original query, required slots, requester conversation,
verified owner, body, connection, and mission are persisted before Agentis asks for missing
information. Supplying a phone number later resolves the unique intent and resumes the original
authorized mission without another model interpretation or approval.

On continuation, the model sees the persisted plan, observations, completed effects, missing
effects, and next executable step. The effect service reuses the stored recipient, payload,
authorization basis, mission link, per-item idempotency keys, and receipts. It reconciles uncertain
provider evidence before any resend. If a customer conversation is human-owned, the one stored
`verified_owner_command` effect may cross that handoff without releasing it; ordinary automation
remains fenced.

The effect payload is media-complete and serializable. Every burst item has a stable item and
requirement id and can retain text,
artifact-backed attachments, generated media, voice/audio/video/file delivery, or provider-native
location/contact/poll content. The Agent may choose existing workspace assets or generate media
when the request requires it. Tool envelopes from native function calling, Hermes markers, CLI
fallback, and legacy names such as `image.generate` are normalized into the same executor and can
never settle a mission as prose.

## Progress and observability

Mission progress is factual and safe for operators: selected record, drafted content, channel
send started, provider acknowledgement, and committed mutation. Stable event ids update the
current activity instead of appending heartbeat noise. Runtime, model, CLI, MCP, schema, and
fallback diagnostics belong in the technical trace; private chain-of-thought is neither stored
nor shown.

When a mission originated from a channel owner command, settlement is reported back to that
same owner conversation. The notification is deterministic and idempotent: accomplishment
includes available provider evidence, while blocked or failed settlement names the concrete
dependency. A progress sentence such as “I’ll check the inbox” may end one model turn, but it
cannot become the last lifecycle update for the requested work.

Mission events are available over SSE:

```text
GET /v1/missions/:id/stream
```

The stream starts with `mission.snapshot`, publishes mission lifecycle events, and emits a
ten-second connection heartbeat.

## HTTP API

All routes require authentication and workspace scope.

```text
POST /v1/agents/:agentId/missions
GET  /v1/agents/:agentId/missions
GET  /v1/agents/:agentId/effective-capabilities
GET  /v1/agents/:agentId/brain
POST /v1/agents/:agentId/brain/prune

GET  /v1/missions?agentId=&appId=&subjectId=&sourceRef=&status=&limit=
GET  /v1/missions/:id
GET  /v1/missions/:id/stream
POST /v1/missions/:id/resume
POST /v1/missions/:id/cancel
```

Example creation body:

```json
{
  "objective": "Send the product introduction and move the selected lead to contacted",
  "sourceKind": "api",
  "appId": "app-id",
  "subjectId": "subject-id",
  "correlationKey": "first-touch:subject-id:v1",
  "outcomeContract": {
    "requiredEffects": [
      { "id": "deliver-introduction", "kind": "channel_delivery", "evidence": "provider_acknowledgement" },
      { "id": "mark-contacted", "kind": "data_mutation", "dependsOn": ["deliver-introduction"], "evidence": "mutation_receipt" }
    ],
    "successPolicy": "all_required_effects"
  }
}
```

Workflow-run detail responses include the linked `mission`; workflow start responses expose
`missionId`. Mission status and receipts are authoritative when a run's lifecycle status and
the requested business outcome differ.

## Storage and upgrade behavior

SQLite migrations 139–142 add standing goals, resumable channel targets, missions, normalized
effect receipts, workflow/action linkage, and post-ack mutations. Migration 141 repairs installs
where an older runner recorded migration 140 after applying only part of its additive schema.
Migration 142 adds stable requirement and plan-step linkage to receipts. The repairs are idempotent
and send no channel messages.

Existing workflow and conversation records migrate lazily when they next create actionable
work. Existing provider receipts remain historical evidence and are never replayed as new sends.
Standing goals remain inactive until explicitly activated.

---

Back to the [Agentis README](../README.md) · start over at [00 · Foundation](./00-foundation.md).
