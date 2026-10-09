# App delivery reliability

Agentis considers an App delivered only when one exact workflow revision passes every layer below and, when required, the verified revision is explicitly approved and promoted.

For action-oriented execution, the associated Agent Mission and effect ledger are authoritative.
A workflow run cannot supply clean delivery proof if the mission lacks its required acknowledged
delivery, mutation, scheduling, or Subject receipts.

## One revision, one truth

- `workflow_graph_revisions` is the source of truth. During authoring, App Doctor and the debug compiler inspect the candidate head. After promotion, production uses the active revision.
- `workflows.graph` is only an active-revision compatibility mirror. It must not override a candidate during debug verification.
- A focused run carries its immutable `workflowRevisionId`; graph validation, dry-run evidence, live evidence, and promotion gates must all name that revision.
- `NODE_DEFINITIONS` is the authoritative node catalog. Runtime support, strict graph admission, and capability proof derive supported node kinds from it.

## Delivery gate

`agentis.app.deliver` is the normal end-to-end entry point:

1. Create or resume a durable build session. A new delivery after a completed session creates a new auditable session.
2. Run App-wide dry-runs and the happy plus non-happy regression suite.
3. Compile debug readiness against candidate heads.
4. Run every enabled workflow for real with self-heal disabled.
5. Evaluate its definition of done against authoritative world probes.
6. Require both `status: COMPLETED` and `verdict: accomplished`.
7. Promote the proven candidate, or return the precise pending approval.
8. Compile production readiness and complete the build session only if every workflow is delivered and published.

A probe pass cannot hide a contract violation. `COMPLETED_WITH_CONTRACT_VIOLATION` and `COMPLETED_WITH_ERRORS` are never clean delivery proof.

## Deterministic persistence

`data_mutate` supports atomic batch `insert` and `upsert` through `records`. Batch upsert requires `matchFields`. Legacy `insert_many`, `upsert_many`, and `matchKey` are normalized at the boundary.

Every mutation returns `mutationReceipt` with attempted/succeeded/failed counts, affected record ids, read-after-write verification, and App/workspace/run evidence. User-facing persisted counts must derive from this receipt rather than from an upstream array length.

Use the native `agentis_app.query` data probe to verify App datastore state. Probe parameters support nested `{output.path}` templates. Native query limits are validated at scope time and must be from 1 to 500.

## Extension contracts and dry-runs

An extension operation should declare a complete JSON output schema, including array item properties. The dry-run synthesizes representative mock output from that schema and invalidates its cache when the extension changes.

Side-effect mocks must match production output contracts. In particular, dry-run `data_mutate` emits the same `mutationReceipt` shape downstream nodes read at runtime.

## Required regression cases

The reliability suite must keep coverage for:

- every supported node kind appearing in the authoritative capability catalog;
- modern and legacy batch mutation syntax, atomicity, idempotency, and receipt cardinality;
- a stale empty workflow mirror beside a valid candidate head;
- extension-schema mock synthesis and extension-aware cache invalidation;
- nested data-probe parameter templates and invalid native limits;
- optional empty outputs such as `warnings: []` not becoming hollow;
- `return_output` envelope unwrapping before output-contract validation;
- a world-accomplished but contract-violating run not being delivered;
- App readiness requiring `delivered: true` and `published: true` for every enabled workflow;
- semantic continuation prompts inheriting the uniquely correlated unfinished mission/build session;
- action Agent Tasks rejecting empty/prose-only completion without required effect receipts;
- crash/replay reconciliation reusing an existing channel intent without duplicate delivery;
- provider acknowledgement gating the exact downstream lead/Subject mutation.
- ordered multi-item delivery retaining the first receipt and retrying only an unacknowledged item;
- verified owner-command authority reaching the live transport without disabling unrelated handoff.

## Operator evidence

For an end-to-end claim, retain these identifiers together:

- App id and build-session id;
- workflow id plus active revision id;
- clean proof run id and settlement;
- dry-run and regression proofs for the same graph hash;
- world-probe evidence and mutation receipts;
- approval id when promotion required operator authorization.

Large workspace snapshots are intentionally omitted from delivery responses. Responses return compact blockers, failed nodes/assertions/cases, run ids, revision ids, and publication state so the next action remains visible.
# Fleet rollout

App-owned semantic workflow revisions have one production authority: `agentis.app.deliver`. Direct revision promotion, automatic verification promotion, legacy hardening, approval resolution, and legacy reconciliation cannot bypass its exact-revision clean-run and accomplished-outcome proof.

Existing workspaces are upgraded with a preview-first fleet command:

```bash
pnpm --filter @agentis/api migrate:app-reliability -- --db apps/api/.agentis/data.db
pnpm --filter @agentis/api migrate:app-reliability -- --confirm --db apps/api/.agentis/data.db
```

Confirmed execution creates an online SQLite backup in `.agentis/archives` before mutation. The migrator invalidates false historic clean proofs, normalizes legacy datastore mutation syntax, generates non-gating mechanical fixtures, and applies intent-preserving App Doctor repairs. It never invents output contracts, definitions of done, worldly probes, datastore expectations, or extension output schemas; those remain explicit review items to resolve through `agentis.app.deliver`.
