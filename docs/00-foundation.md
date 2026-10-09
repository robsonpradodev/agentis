# 00 · The Durable Spine & Six Primitives

Agentis persists all long-lived state on one model — the **Durable Entity** — and exposes
exactly six primitives built on it. This page documents that substrate.

## The Durable Entity

A Durable Entity is a restart-durable, single-writer record with a typed inbox and a wake
clock. It is the atom every long-lived object in the system is built from.

**Tables** (`packages/db/src/sqlite/schema.ts`):
- `durable_entities` — the entity rows: `kind`, `key` (unique per workspace), serialized
  state, lease fields, and `wake_at`.
- `entity_inbox` — inbound messages addressed to an entity, processed in order and tolerant
  of out-of-order arrival (a correlated reply can land long after the request).

**Guarantees** (`apps/api/src/services/durableEntities.ts`):
- **Single-writer-per-key** — a lease serializes writes to one entity; concurrent workers
  never race the same key.
- **Durable state** — state is persisted on every transition, not held only in memory; a
  process restart resumes rather than loses.
- **Inbox-driven** — you send an entity a message; it processes on its own schedule.
- **Wake clock** — an entity can park itself and be woken later by a timer or an inbound
  message, holding no thread and spending no tokens while parked.

This is the same design lineage as Cloudflare Durable Objects, Temporal, and Restate.

## The realtime + ledger spine

Two cross-cutting systems make the spine observable:

- **Ledger** (`ledger_events`, `apps/api/src/services/ledger.ts`) — an append-only,
  strictly monotonic-per-run event log. It is the source of truth for run history, replay,
  and crash recovery.
- **EventBus** (`apps/api/src/event-bus.ts`) — an in-process `publish(room, event, payload)`
  bus wrapped by a socket.io bridge (`apps/api/src/websocket/`). Clients subscribe to
  `workspace`, `run`, `workflow`, or `mission` rooms after JWT validation; ownership is re-checked
  server-side.

## The six primitives

Every feature is one of these six or composes from them. There is deliberately no seventh.

| Primitive | Backing tables / services | Documented in |
|-----------|---------------------------|---------------|
| **Agent** | `agents`, `agent_sessions`, `agent_session_messages`; `services/residency.ts` | [Fabric](./04-agent-fabric.md), [Brain](./01-the-brain.md) |
| **Subject** | `durable_entities` (kind=subject); `services/subjectRuntime.ts` | [Applications](./02-agentic-applications.md) |
| **Connection** | `channel_connections`, `channel_peer_identities`; adapters + integrations | [Omni-Reach](./06-omni-reach.md) |
| **Orchestration** | `agent_missions`, `effect_receipts`, `workflows`, `workflow_runs`, `workflow_run_snapshots`, `plans` | [Missions](./08-agent-missions.md), [Orchestration](./03-orchestration.md) |
| **Experiment** | `experiments`, `experiment_assignments`; `services/experiments.ts` | [Sovereignty → Trust](./05-sovereignty.md) |
| **Interface** | `apps`, `app_collections`, `app_records`, `app_surfaces`, `app_contacts` | [Applications](./02-agentic-applications.md) |

App Goals and the Evolution Loop compose Agent, Orchestration, Experiment, and Interface. They
are an application capability, not a seventh primitive. Agent Missions likewise belong to
Orchestration and do not introduce another primitive.

A **Subject** is worth calling out: it is a per-entity actor (a person, lead, or device)
whose lifecycle is declarative — `send` (token-free), `agent` (a model step), `wait` (park
until inbound), `done` (terminal) — and it is reachable out of order via correlation tokens,
because it is a Durable Entity.

## Why one spine matters

Because every unit of work is a Durable Entity on one database:
- a server restart mid-run resumes from the last snapshot rather than losing the run;
- an Agent Mission remains authoritative while chat turns, workflow runs, or provider waits come and go;
- a conversation parked for three days wakes when the reply lands;
- there is one ledger and one event stream for the whole system, so agents and workflows can
  see and reach each other rather than living in disconnected silos.

---

**Next:** [01 · The Brain →](./01-the-brain.md)
