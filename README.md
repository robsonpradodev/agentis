# Agentis

## Every harness. One Brain. Zero lock-in.

Own your agents, don't rent them. Agentis is a self-hosted, open-source multi-harness
dashboard that runs on your machine today with Claude Code, Codex, Cursor, Antigravity,
Hermes, OpenClaw, or your own HTTP and local models underneath (a harness of our own is
coming next). Those tools forget everything the moment the process dies, and most of them
phone your work home to someone else's cloud while they run. Agentis doesn't. Import the
agents you already run into one dashboard, give them a permanent Brain of memory and
skills, swap the model underneath them anytime, and ship what they build as real agentic
apps powered by a workflow engine. No lock-in.

**Runs on your machine. Keeps every agent's memory. Never routes your work through our servers.**

Agents should not disappear when a vendor changes, a subscription ends, or a local process
restarts. Agentis gives them durable identity, memory, orchestration, tools, approvals,
and a live product surface they can operate with you.

[![npm version](https://img.shields.io/npm/v/@agentis-labs/cli.svg)](https://www.npmjs.com/package/@agentis-labs/cli)
[![npm downloads](https://img.shields.io/npm/dw/@agentis-labs/cli.svg)](https://www.npmjs.com/package/@agentis-labs/cli)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.10-brightgreen.svg)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-9.12-orange.svg)](https://pnpm.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](https://www.typescriptlang.org)
![Status](https://img.shields.io/badge/status-1.1.5%20stable-brightgreen.svg)

> **Status: 1.1.5 stable.** Agentis is now in public release, and the CLI,
> dashboard, and core runtime are ready for production use across 1.x updates.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https%3A%2F%2Fgithub.com%2Fagentis-labs%2Fagentis)

---

## See it running

![Agentis workspace dashboard](https://raw.githubusercontent.com/agentis-labs/agentis/main/docs/assets/agentis-workspace-print.png)

---

## Harnesses supported today

Agentis doesn't make you pick one. Import the agent you already run — no rewrite, no
migration — and it keeps its memory, tools, and workflows even if you switch harnesses later.

| Harness | What it is | Runs as |
|---------|-----------|---------|
| **Claude Code** | Anthropic's Claude Code CLI | local CLI process |
| **Codex** | OpenAI's Codex CLI | local CLI process |
| **Cursor** | Cursor's agent CLI | local CLI process |
| **Antigravity** | Google's `agy` — the Gemini-CLI successor, also runs Claude and GPT-OSS models | local CLI process |
| **Hermes** | Hermes agent runtime | local CLI process |
| **OpenClaw** | Bridged through OpenClaw's official ACP protocol | local ACP server |
| **HTTP (custom / remote)** | Any agent that speaks HTTP, with HMAC-signed callbacks | webhook |
| **Local / OpenAI-compatible** | Ollama, LM Studio, OpenRouter, and other OpenAI-compatible endpoints | local or remote API |

More harnesses land as adapters, not rewrites — and a harness of our own is next.

---

## Install

```bash
npm install -g @agentis-labs/cli
agentis up
```

Works on macOS, Linux, and Windows PowerShell with Node.js >= 20.10 installed. Agentis
boots at `http://127.0.0.1:3737` in under 60 seconds, creates local secrets, initializes
SQLite, seeds the first operator user, and serves the dashboard from the same process.

**No API keys required to see it boot.** Connect your first harness — Claude Code, Codex,
Cursor, or a local model — whenever you're ready.

On Windows, open a new PowerShell after the global install so npm's global command
shims are picked up on `PATH`.

Prefer Docker?

```bash
docker compose up
```

### CLI

The CLI stays deliberately small — everything else runs through the API and dashboard.

| Command | What it does |
|---------|---------------|
| `agentis up` | Boot Agentis on this machine (default when no command is given). |
| `agentis backup [--out <dir>]` | Snapshot the data dir — database, secrets, agent homes — into `<dir>`. |
| `agentis restore <dir> [--force]` | Restore a backup directory into the data dir. |
| `agentis create <dir> [--name <name>]` | Scaffold a code-authored Agentic App. |
| `agentis app validate\|pack\|test\|install\|export` | Validate, build, test, install, or export a `.agentisapp` package. |
| `agentis bootstrap --url <url> --api-key <key> --adapter <adapter>` | Commission an orchestrator, manager, or specialist agent through the API. |
| `agentis bootstrap generate-config --from <claude_code\|codex>` | Generate an `agentis-config.json` scaffold from local harness context. |
| `agentis help` | Print the full command and flag reference. |

Run `agentis help` for the complete flag list on every command.

---

## What You Can Build

- Agent-run internal tools with durable data, live ops, approvals, and memory.
- Self-healing workflows that replay, diagnose, and improve from real outcomes.
- Specialist fleets that use Claude Code, Codex, Cursor, local models, or custom HTTP agents.
- Agentic apps that package workflows, interfaces, collections, and tests into `.agentisapp`.
- Channel-native agents that respond across Slack, Telegram, WhatsApp, email, MCP, and A2A.

---

## Why Agentis: an anti-lock-in architecture

**One fabric for every runtime, not one more silo.** Claude Code, Codex, Cursor, Antigravity
(Gemini), Hermes, OpenClaw, OpenAI-compatible endpoints (Ollama, LM Studio, OpenRouter, and
more), and local models all sit behind one Runtime Abstraction Layer. Route by capability,
not vendor — and never rewrite your agents to switch one.

**A permanent Brain, not a chat transcript.** Durable memory lives locally with a pinned,
verified embedding model that is reusable offline, formation gates, grounded knowledge, living skills, and cited
answers — indexed through the Model Context Protocol so any harness you plug in reads and
writes the same memory instead of starting cold.

**Apps, not conversations that evaporate.** Agents define typed data, generate UI surfaces,
wire actions, and operate the product they created. No orchestration framework hands you
back a wall of text and calls it done.

**Self-healing orchestration, not brittle chains.** The workflow engine runs typed graphs
with 47 node kinds, durable snapshots, partial replay, checkpoints, subflows, objective
verdicts, and repair paths that recover honestly instead of fabricating success — no
prompt-chaining framework to debug by staring at stack traces of stack traces.

**Reach people and systems.** Slack, Telegram, WhatsApp, email, webhooks, MCP, A2A, and
90+ integration manifests all use the same connection registry, credential vault, and
policy layer.

**Agent-native by design.** A typed `agentis.*` surface with 132 tools for building, running,
observing, repairing, governing, and shipping. Agents operate Agentis as code instead of
juggling brittle one-off tool calls.

**Sovereign by default.** SQLite, secrets, assets, agent homes, memories, and audit logs
live under `AGENTIS_DATA_DIR` unless you choose otherwise. Models are swappable. Harnesses
are swappable. Data stays yours.

---

## First Boot

The first run is self-contained:

1. Generates an RSA-2048 JWT keypair and AES-256 credential-vault key in `.agentis/secrets.json`.
2. Initializes embedded SQLite at `.agentis/agentis.db` with WAL mode and foreign keys.
3. Seeds an `operator` user, a `Personal` workspace, and a `Local` ambient.
4. Starts the HTTP API, WebSocket bridge, workflow engine, and bundled dashboard.

The seeded operator credential is printed once. Everything runtime lives under
`AGENTIS_DATA_DIR` by default, and the source tree stays clean.

---

## Platform Map

Agentis is organized around seven core systems. The public technical guide lives at
[docs.useagentis.com](https://docs.useagentis.com). The source docs in this repository
mirror the same architecture:

| System | What it gives you |
|--------|-------------------|
| [Durable Spine & Six Primitives](./docs/00-foundation.md) | One restart-durable entity model for Agent, Subject, Connection, Orchestration, Experiment, and Interface. |
| [The Brain](./docs/01-the-brain.md) | Local semantic memory, grounding, knowledge bases, skills, citations, and learning from outcomes. |
| [Agentic Applications](./docs/02-agentic-applications.md) | Typed data, agent-authored UI, actions, orchestration, subjects, and app packaging. |
| [Self-Healing Orchestration](./docs/03-orchestration.md) | A 47-node workflow engine with replay, objectives, verdicts, and repair. |
| [The Agent Fabric](./docs/04-agent-fabric.md) | Runtime-neutral routing across Claude Code, Codex, Cursor, Antigravity, Hermes, OpenClaw, local, and HTTP agents. |
| [Sovereignty](./docs/05-sovereignty.md) | Local-first data, encrypted secrets, portable backups, budgets, approvals, and audit. |
| [Omni-Reach](./docs/06-omni-reach.md) | Channels, MCP, A2A, webhooks, email, integrations, and outbound policy. |
| [Agent-Native Core](./docs/07-agent-native-core.md) | The typed `agentis.*` tool surface agents use to build and operate the platform as code. |

---

## Architecture Snapshot

```text
apps/
  api/     Headless backend: Hono HTTP, socket.io realtime, workflow engine, Brain
  web/     React + Vite dashboard: canvas, brain, apps, chat, ledger, inbox
packages/
  core/          Shared types, schemas, errors, event names, RAL affordances
  db/            Drizzle schema for SQLite and Postgres dialects
  runtime/       Shared runtime primitives
  integrations/  Connector manifests and templated HTTP connectors
  app/           App package format
  app-client/    Client for embedding App surfaces
  sdk/           Programmatic build, validate, and test
  cli/           @agentis-labs/cli: up, bootstrap, backup, restore, app tooling
```

The API is the composition root. In production, the CLI serves the built web dashboard from
the same Node process that owns the API, WebSocket bridge, workflow engine, local database,
memory, apps, and agent runtime adapters.

---

## Configuration

All configuration is via environment variables, and every common value has a local default.
See [`.env.example`](./.env.example) for the complete set.

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENTIS_DATA_DIR` | `./.agentis` | SQLite DB, secrets, agent homes, backups. |
| `AGENTIS_ARCHIVE_DIR` | `$AGENTIS_DATA_DIR/archives` | Lossless gzip archives for aged run state and telemetry. |
| `AGENTIS_STORAGE_FULL_RUN_DAYS` | `7` | Days to retain full terminal run state in the hot database. |
| `AGENTIS_STORAGE_LEDGER_DAYS` | `30` | Days to retain terminal-run ledger events hot before archiving. |
| `AGENTIS_STORAGE_OBSERVABILITY_DAYS` | `14` | Days to retain observability events hot before archiving. |
| `AGENTIS_STORAGE_MAX_HOT_DB_MB` | `2048` | Hot SQLite budget; pressure mode shortens hot retention without deleting archives. |
| `AGENTIS_STORAGE_MIN_FREE_MB` | `2048` | Free-space reserve that activates pressure mode. |
| `AGENTIS_ASSETS_DIR` | `{DATA_DIR}/assets` | Content-addressed blob store, deduped by SHA-256. |
| `AGENTIS_TRANSCRIPTION_CACHE_DIR` | `{DATA_DIR}/models/transcription` | Verified local speech-to-text cache, prepared only for media channels or explicit warmup. |
| `AGENTIS_TRANSCRIPTION_MODEL_PATH` | unset | Pre-provisioned compatible local transcription model directory. |
| `AGENTIS_TRANSCRIPTION_OFFLINE` | unset | Disable transcription model network acquisition and require a verified/pre-provisioned cache. |
| `AGENTIS_TRANSCRIPTION_LANGUAGE` | host locale | Whisper language hint, such as `portuguese`, for multilingual or headless hosts. |
| `AGENTIS_HTTP_PORT` | `3737` | API and dashboard port. |
| `AGENTIS_HTTP_HOST` | `127.0.0.1` | Bind host. |
| `AGENTIS_EXTENSION_REQUIRE_ISOLATE` | unset | Fail closed instead of using `node:vm` for untrusted extension code. |
| `AGENTIS_EXTENSION_DOCKER` | unset | Enable the Docker extension sandbox. |
| `AGENTIS_BROWSER_CONCURRENCY` | `3` | Concurrent native Chromium operations shared by browser nodes, tools, and extensions (max 16). |
| `AGENTIS_BROWSER_SESSION_MAX` | `20` | Maximum live browser sessions on this host (max 128); encrypted checkpoints survive eviction/restart. |
| `AGENTIS_BROWSER_SESSION_TTL_MS` | `300000` | Idle lifetime for a live browser session before its page is reaped. |
| `AGENTIS_ORCHESTRATOR_BASE_URL` / `_API_KEY` / `_MODEL` | unset | Optional OpenAI-compatible model endpoint for the orchestrator. |

---

## Develop

```bash
pnpm install
pnpm -r typecheck
pnpm -r test
pnpm doctor
pnpm dev:full
```

Requires Node.js >= 20.10 and pnpm 9.12.

Useful contributor commands:

```bash
pnpm lint
pnpm build
pnpm test:e2e
pnpm db:generate
pnpm db:migrate
```

---

## Security

- Every authenticated request re-checks workspace and user ownership.
- Secrets are stored in an AES-256-GCM credential vault and never returned decrypted.
- Passwords use bcrypt; JWTs use RS256 with access/refresh kind separation.
- Workflow configs are validated through discriminated unions and safe parsers, not `eval`.
- Agent and extension HTTP is IP-pinned and blocks private ranges by default.
- Extension code defaults to `node:vm`; use `isolated-vm` or Docker for untrusted code.

Report vulnerabilities privately per [SECURITY.md](./SECURITY.md).

---

## Community

- **Docs:** [docs.useagentis.com](https://docs.useagentis.com) for the full technical guide.
- **Issues:** [GitHub Issues](https://github.com/agentis-labs/agentis/issues) for bugs and
  feature requests.
- **Discussions:** [GitHub Discussions](https://github.com/agentis-labs/agentis/discussions)
  is the current war room for early adopters — architecture questions, build logs, and
  what you're shipping with your Brain.

---

## Contributing

Issues and PRs are welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md), and keep security
reports private per [SECURITY.md](./SECURITY.md).

Before opening a PR:

```bash
pnpm -r typecheck && pnpm -r test && pnpm lint
```

---

## License

Apache-2.0. See [LICENSE](./LICENSE).
