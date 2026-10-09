# Deployment

Agentis V1 deploys as a single Node process that serves the API, WebSocket bridge, workflow engine, and built web dashboard. The production path is embedded SQLite plus file-backed secrets in `AGENTIS_DATA_DIR`.

## Secure VPS baseline

Treat Agentis as an operator console: it can hold credentials, browser sessions, automation tools, and agent output. Do not publish its application port to the internet. Bind port `3737` to loopback, put a TLS reverse proxy on ports 80/443, and allow only the operator accounts you intend to use. Agentis rejects a public production bind without `AGENTIS_PUBLIC_URL`, and that URL must be HTTPS (other than loopback development).

Before the first production boot, store a unique long `AGENTIS_SEED_PASSWORD` in your secret manager and make `/data` readable only by the service account. It contains the database, encrypted credential-vault key, and JWT keypair. Never put it in a synced folder or source checkout.

Example Caddy configuration (replace the domain):

```caddyfile
agentis.example.com {
  reverse_proxy 127.0.0.1:3737
}
```

Use this accompanying production environment (in an untracked `.env` file):

```bash
NODE_ENV=production
AGENTIS_PUBLIC_URL=https://agentis.example.com
AGENTIS_ALLOWED_ORIGINS=https://agentis.example.com
AGENTIS_TRUST_PROXY=true
AGENTIS_SEED_USERNAME=operator
AGENTIS_SEED_PASSWORD=<long-unique-secret>
```

`AGENTIS_TRUST_PROXY=true` is safe only when the Agentis port is loopback-only and the reverse proxy is under your control. It lets login throttling use the real client address. Do not set it on a directly exposed port.

## Installable web app

The built dashboard is an installable PWA. Once it is served from the HTTPS URL above, Chromium-based browsers show an **Install** button in the console header when the browser considers the app installable; mobile browsers can use their normal “Add to Home Screen” command. The PWA caches versioned interface files only. It never caches `/v1` responses, tokens, credentials, or realtime traffic.

## Supported Runtime

- Node.js 20.10 or newer.
- A persistent writable data directory for `data.db`, `secrets.json`, backups, and local runtime files.
- SQLite is the supported V1 database. Postgres standard mode has schema/driver scaffolding, but the API and engine still use the SQLite handle internally and will reject standard mode at boot.

## Local CLI

```bash
npx @agentis-labs/cli@latest up
```

Or install it globally if you prefer a persistent binary:

```bash
npm install -g @agentis-labs/cli
agentis up
```

The CLI opens the dashboard and prints the first operator credential once. For a predictable data location, set:

```bash
AGENTIS_DATA_DIR=/var/lib/agentis agentis up
```

## Docker Compose

```bash
docker compose up --build
```

The compose file maps the app to `http://127.0.0.1:3737` only and stores data in the `agentis_data` Docker volume. It requires `AGENTIS_PUBLIC_URL`, `AGENTIS_ALLOWED_ORIGINS`, and `AGENTIS_SEED_PASSWORD` in an untracked `.env` file, so it cannot silently boot as an insecure public deployment. For server use, keep that volume persistent and back it up; use the HTTPS reverse-proxy setup above for remote access.

## Single Container

```bash
docker build -t agentis .
docker run --rm -p 127.0.0.1:3737:3737 -v agentis_data:/data \
  -e AGENTIS_PUBLIC_URL=https://agentis.example.com \
  -e AGENTIS_ALLOWED_ORIGINS=https://agentis.example.com \
  -e AGENTIS_TRUST_PROXY=true \
  -e AGENTIS_SEED_PASSWORD=<long-unique-secret> agentis
```

The image sets:

```bash
AGENTIS_DATA_DIR=/data
AGENTIS_HTTP_HOST=0.0.0.0
AGENTIS_HTTP_PORT=3737
```

## Railway

The repository includes `railway.toml` and a README deploy button that build from the Dockerfile. Attach persistent storage for `/data` before relying on it for real work. Without a persistent volume, the SQLite database and generated secrets can be lost when the container is replaced.

Recommended variables:

```bash
AGENTIS_DATA_DIR=/data
AGENTIS_HTTP_HOST=0.0.0.0
AGENTIS_HTTP_PORT=${PORT}
AGENTIS_PUBLIC_URL=https://agentis.example.com
AGENTIS_ALLOWED_ORIGINS=https://agentis.example.com
AGENTIS_TRUST_PROXY=true
AGENTIS_SEED_USERNAME=operator
AGENTIS_SEED_PASSWORD=<set once for first boot>
```

If the platform injects `PORT`, map it to `AGENTIS_HTTP_PORT`. Do not set `AGENTIS_TEST_MODE` outside automated tests.

## Environment Variables

| Variable | Default | Notes |
|---|---:|---|
| `AGENTIS_DATA_DIR` | `.agentis` | Persistent data and generated secrets. |
| `AGENTIS_HTTP_HOST` | `127.0.0.1` | Use `0.0.0.0` in containers. |
| `AGENTIS_HTTP_PORT` | `3737` | HTTP and WebSocket server port. |
| `AGENTIS_SEED_USERNAME` | `operator` | Used only when the first user is seeded. |
| `AGENTIS_SEED_PASSWORD` | random | Printed once when omitted. Set explicitly for non-interactive server boot. |
| `AGENTIS_JWT_PRIVATE_KEY` / `AGENTIS_JWT_PUBLIC_KEY` | generated | Optional env overrides for file-backed JWT keys. |
| `AGENTIS_CREDENTIAL_KEY` | generated | Optional env override for the AES-256-GCM vault key. |
| `AGENTIS_SKILL_DOCKER` | `false` | Enables docker-sandbox skill execution. |
| `AGENTIS_WORKFLOW_PARALLELISM` | `auto` | Engine parallelism setting. |
| `AGENTIS_DATABASE_URL` | unset | Reserved for future Postgres standard mode; not supported by the V1 runtime path. |

Do not place `AGENTIS_DATA_DIR` inside OneDrive, Dropbox, or another synchronized source folder.
SQLite WAL writes, migrations, local model activation, and TypeScript tooling can become several
times slower and synchronization may leave large model caches incomplete. On Windows, prefer a
local path such as `C:\ProgramData\Agentis` or `%LOCALAPPDATA%\Agentis`.

## Backups

Use the CLI backup command when running from a local install:

```bash
agentis backup --out ./agentis-backup
```

For containers, also back up the whole `AGENTIS_DATA_DIR` volume while the process is stopped or after taking an application-level backup. The important files are `data.db`, SQLite WAL/SHM files if present, and `secrets.json`.

## Health Check

The API exposes:

```text
GET /healthz
```

Use it for container or platform readiness checks.

`ok: true` means the API is serving traffic. `status: "degraded"` means an optional component,
such as the local embedding runtime, needs attention; inspect `components` rather than treating it
as an API startup failure.

## Upgrade notes: durable missions and effect receipts

SQLite migrations 139–141 install standing goals, resumable channel intents, Agent Missions,
normalized effect receipts, workflow/action linkage, and post-ack mutations. They run
automatically on boot and do not execute channel actions or activate standing goals.

Migration 141 is a recovery migration for installations where migration 140 was recorded after
only part of its additive schema was applied. It safely rechecks the missing columns and indexes.
After upgrade, verify API readiness and, with authenticated workspace headers, the mission route:

```text
GET /healthz
GET /v1/missions?limit=1
```

Existing provider receipts remain historical evidence and are not replayed. Existing workflows
continue through the compatibility API; action-oriented starts expose `missionId`, and run detail
includes the authoritative mission and its receipts.
