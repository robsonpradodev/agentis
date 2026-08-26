# @agentis-labs/cli

[![npm](https://img.shields.io/npm/v/@agentis-labs/cli.svg)](https://www.npmjs.com/package/@agentis-labs/cli)
[![npm downloads](https://img.shields.io/npm/dw/@agentis-labs/cli.svg)](https://www.npmjs.com/package/@agentis-labs/cli)
[![license](https://img.shields.io/npm/l/@agentis-labs/cli.svg)](https://github.com/agentis-labs/agentis/blob/main/LICENSE)

## Every harness. One Brain. Zero lock-in.

Own your agents, don't rent them. Agentis is a self-hosted, open-source multi-harness
dashboard that runs on your machine today with Claude Code, Codex, Cursor, Antigravity,
Hermes, OpenClaw, or your own HTTP and local models underneath (a harness of our own is
coming next). Those tools forget everything the moment the process dies, and most of them
phone your work home to someone else's cloud while they run. Agentis doesn't. Import the
agents you already run into one dashboard, give them a permanent Brain of memory and
skills, swap the model underneath them anytime, and ship what they build as real agentic
apps powered by a workflow engine. No lock-in.

**No token tax. No data extraction. No forgetting.**

> **Status: 1.1.5 stable.** Agentis is now in public release, and the CLI,
> dashboard, and core runtime are ready for production use across 1.x updates.

This package launches the whole local runtime: API, WebSocket bridge, workflow engine,
embedded SQLite, credential vault, and bundled React dashboard.

## See it running

![Agentis workspace dashboard](https://raw.githubusercontent.com/agentis-labs/agentis/main/docs/assets/agentis-workspace-print.png)

## Harnesses supported today

Import the agent you already run — no rewrite, no migration — and it keeps its memory,
tools, and workflows even if you switch harnesses later.

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

## Install

```sh
npm install -g @agentis-labs/cli
agentis up
```

Works on macOS, Linux, and Windows PowerShell with Node.js >= 20.10 installed.
Agentis boots at `http://127.0.0.1:3737` in under 60 seconds, creates local secrets,
initializes SQLite, seeds the first operator user, and serves the dashboard from the
same process.

**No API keys required to see it boot.** Connect your first harness whenever you're ready.

On Windows, open a new PowerShell after the global install so npm's global command
shims are picked up on `PATH`.

## Why Agentis

- **One fabric for every runtime.** Route by capability, not vendor — never rewrite
  your agents to switch one.
- **A permanent Brain, not a chat transcript.** Local semantic memory, knowledge bases,
  living skills, and cited answers that every harness reads and writes into.
- **Apps, not conversations that evaporate.** Typed data, generated interfaces, actions,
  run monitors, approvals.
- **Self-healing workflows.** Durable graphs, replay, checkpoints, verdicts, honest repair.
- **Omni-Reach.** Slack, Telegram, WhatsApp, email, webhooks, MCP, A2A, and integrations.
- **Sovereignty.** SQLite, secrets, assets, logs, and memories stay under your data directory.

## What You Can Build

- Agent-run internal tools with durable data, live ops, approvals, and memory.
- Self-healing workflows that replay, diagnose, and improve from real outcomes.
- Specialist fleets that use Claude Code, Codex, Cursor, local models, or custom HTTP agents.
- Agentic apps that package workflows, interfaces, collections, and tests into `.agentisapp`.
- Channel-native agents that respond across Slack, Telegram, WhatsApp, email, MCP, and A2A.

## First Boot

1. An RSA-2048 keypair for JWTs and an AES-256 key for the credential vault.
2. An embedded SQLite database at `.agentis/agentis.db`.
3. A seeded `operator` user, `Personal` workspace, and `Local` ambient.
4. The dashboard served from `http://127.0.0.1:3737`.

Everything runtime lives under `AGENTIS_DATA_DIR` by default.

## Commands

```text
agentis up                         Start Agentis (default if no command is given).
agentis warmup [--repair]          Download, verify, or recover the local q8 embedding runtime.
agentis warmup --transcription     Prepare the optional local speech-to-text runtime.
agentis setup --channels           Prepare embedding, browser, and channel media runtimes.
agentis doctor [--json]            Verify Node/ABI, data access, SQLite/database, and model runtime health.
agentis bootstrap ...              Commission an orchestrator, manager, or specialist.
agentis create <dir>               Scaffold a code-authored Agentic App.
agentis app <pack|validate|install|test|export> ...   Work with .agentisapp packages.
agentis backup [--out <dir>]       Snapshot the data dir.
agentis restore <dir> [--force]    Restore a backup directory into the data dir.
agentis help                       Show the full command reference.
```

`agentis up` does not globally download the transcription model. The pinned q8
Whisper fallback is prepared when a WhatsApp/Telegram connection needs inbound audio,
or explicitly with `setup --channels`/`warmup --transcription`. Set
`AGENTIS_TRANSCRIPTION_OFFLINE=true` to prohibit network acquisition, or
`AGENTIS_TRANSCRIPTION_MODEL_PATH` to use a pre-provisioned compatible model directory.
Set `AGENTIS_TRANSCRIPTION_LANGUAGE=portuguese` when a headless or multilingual host needs a
deterministic Whisper language hint; otherwise Agentis uses the host locale.

## Requirements

- Node.js >= 20.10.0
- A modern browser

## Learn more

- Project: <https://github.com/agentis-labs/agentis>
- Website: <https://useagentis.com>
- Technical guide: <https://docs.useagentis.com>
- Issues: <https://github.com/agentis-labs/agentis/issues>

## License

Apache-2.0
