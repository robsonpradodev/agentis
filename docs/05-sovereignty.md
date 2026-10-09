# 05 · Sovereignty

Sovereignty is the property that you own the agents, the data, and the intelligence: Agentis
is local-first, model-neutral, self-hosted, and portable, and the supervision layer
(budgets, approvals, audit, autonomy) lives here too.

## Local-first data

- All runtime state lives under `AGENTIS_DATA_DIR` (default `./.agentis`, git-ignored): the
  SQLite database (`data.db`, WAL mode), `secrets.json` (`chmod 0600`), per-agent home
  directories, and backups (`apps/api/src/defaultDataDir.ts`).
- Keep the data directory outside OneDrive, Dropbox, network-synchronized folders, and the
  source checkout. SQLite WAL traffic, model artifacts, migration tests, and compiler reads can
  become several times slower under filesystem synchronization. `/healthz` reports degraded
  local-model state separately from API readiness.
- The **asset store** (`AGENTIS_ASSETS_DIR`, `services/assetStore.ts`) is content-addressed:
  every generated blob is stored once by SHA-256 and registered as an artifact. Point it at an
  external drive/NAS; it never needs to live on the system disk or in the repo.
- The **Brain** runs on a pinned local embedding model. Its q8 artifacts are downloaded and
  cryptographically verified once, then work offline with no external API, so institutional
  knowledge never leaves the host (see [The Brain](./01-the-brain.md)).
- Inbound channel audio has an optional pinned local transcription fallback with the same
  immutable-revision, artifact-size, SHA-256, atomic-activation, offline, and repair controls.
  It is acquired only for configured media channels or explicit channel setup, never merely
  because `agentis up` was run.

## Model & runtime neutrality

Models are renters, not owners. Agent runtimes sit behind the RAL contract
([The Agent Fabric](./04-agent-fabric.md)), so you can swap Claude Code for Codex, or one
OpenAI-compatible endpoint for another, and the agent's **identity, sessions, and Brain
persist** — they belong to Agentis, not to the vendor. Model endpoints are configured per
workspace (`workspace_model_config`) or via `AGENTIS_ORCHESTRATOR_*` env vars.

## Portability

- **Workspace bundle** (`services/packager.ts`, `/v1/workspace-bundle`) — export a portable,
  encrypted `.agentis` bundle with profiles: `share` (graph + settings), `sell` (signed), and
  `backup` (whole install). The profile defines the secrets boundary.
- **Backup / restore** (`services/backup.ts`, CLI `backup` / `restore`) — consistent
  single-file snapshots via SQLite's online-backup API, manifest-versioned; designed for a
  plain tarball or git.
- **Ambients** (`ambients` table, `services/residency.ts`, `/v1/ambients`) — one install runs
  `local / dev / staging / prod / fleet / custom`, each with its own encrypted credential
  vault.

- **App bundle v2** (`.agentisapp`, `/v1/apps/:id/export`) — exports the `active` revision by
  default or an explicitly requested `candidate`, embeds content-addressed components, strips
  host-local executable configuration, and rejects incompatible or unsafe imports before
  activation.

## Deployment

- **Docker** — a single container (`Dockerfile`, `docker-compose.yml`) bundles better-sqlite3,
  all packages, and the built SPA in one Node process.
- **Railway** — one-click template (`railway.toml`) with a stateful volume for SQLite.
- **CLI** (`@agentis-labs/cli`) — `npm install -g @agentis-labs/cli` then `agentis up`;
  also `warmup [--repair|--transcription]`, `setup [--channels]`, `doctor [--json]`, `bootstrap`, `backup`, `restore`, `create`,
  `app {pack,validate,install,test,export}`.
- **SDK** (`@agentis/sdk`) — programmatic validate/build/test in an isolated transaction.

A hosted Postgres dialect exists (`packages/db/src/pg/`) but is a stub; SQLite single-writer is
the supported target.

## Auth & secrets

- **Credential vault** (`services/credentialVault.ts`, `credentials` table) — AES-256-GCM with
  auth-tag verification; never returned decrypted; isolated per ambient.
- **API keys** (`api_keys`, `services/apiKeys.ts`) — hashed at rest, preview token,
  last-used tracking, revocable.
- **JWT / OAuth** — RS256 keypair auto-generated on first boot; `kind` claim rejects
  refresh-as-access replay. Routes: `/v1/auth`, `/v1/oauth`, `/v1/jwks`.
- **Isolation** — every authenticated request re-checks `(workspace, user)` ownership via
  `requireWorkspace`.

## Nested layer — Trust & Governance

Supervised autonomy: you own it *and* can supervise it.

- **Budgets** (`services/budget.ts`, `budget_events`, `/v1/budgets`) — workspace/day and
  agent/month ceilings; pre-spend assertion; limit-hit events raise approvals.
- **Approvals** (`services/approvalInbox.ts`, `approval_requests`, `/v1/approvals`) — human
  gates for budget overruns, outbound safety, and workflow decisions; in-thread resolution.
  Approvals that hold mission work must be visible, mission-linked, and automatically resumable;
  an invisible grant request is not a valid dependency.
- **Audit trail** (`services/auditTrail.ts`, `audit_entries`) — every action attributed with
  node-level token accounting; inspectable at `/v1/runs/:id/audit`.
- **Observability & analytics** (`services/observability.ts`, `observability_events`;
  `services/run/runAnalytics.ts`; `/v1/observability`, `/v1/analytics`, `/v1/dashboard`) —
  normalized realtime events; run counts, success rate, duration, real token/cost, per-node
  failure breakdown.
- **Governance summary** (`/v1/governance`, `/v1/sovereignty`) — fleet + adapter health, cost
  control, pending approvals, audit depth in one operator view.
- **Experiments** (`services/experiments.ts`, `experiments` / `experiment_assignments`) —
  deterministic sticky assignment + per-variant outcome aggregation.
- **Autonomy** — sticky Ask/Plan/Auto chat modes plus a dual-switch autonomy gate (deployment
  master + per-workspace toggle; both must be on).

---

**Next:** [06 · Omni-Reach →](./06-omni-reach.md)
