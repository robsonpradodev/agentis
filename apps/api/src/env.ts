import { join } from 'node:path';
import { z } from 'zod';
import { CONSTANTS } from '@agentis/core';
import { resolveDefaultDataDir } from './defaultDataDir.js';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  AGENTIS_MODE: z.enum(['embedded', 'standard']).optional(),
  AGENTIS_DATA_DIR: z.string().optional(),
  // Content-addressed asset store root. Holds all agent/app-generated media
  // (blobs). Defaults to `{AGENTIS_DATA_DIR}/assets` but can point anywhere —
  // an external drive, OneDrive, a NAS — so large media never bloats the system
  // disk or (critically) the source tree. Never inside the repo.
  AGENTIS_ASSETS_DIR: z.string().optional(),
  // Lossless cold storage + bounded hot-history policy. Archives can live on a
  // separate disk/NAS; defaults keep setup zero-config under the data dir.
  AGENTIS_ARCHIVE_DIR: z.string().optional(),
  AGENTIS_STORAGE_FULL_RUN_DAYS: z.coerce.number().int().nonnegative().default(7),
  AGENTIS_STORAGE_LEDGER_DAYS: z.coerce.number().int().nonnegative().default(30),
  AGENTIS_STORAGE_OBSERVABILITY_DAYS: z.coerce.number().int().nonnegative().default(14),
  AGENTIS_STORAGE_MAX_HOT_DB_MB: z.coerce.number().positive().default(2048),
  AGENTIS_STORAGE_MIN_FREE_MB: z.coerce.number().nonnegative().default(2048),
  AGENTIS_STORAGE_MAINTENANCE_INTERVAL_MS: z.coerce.number().int().positive().default(6 * 60 * 60 * 1000),
  AGENTIS_HTTP_PORT: z.coerce.number().int().positive().default(CONSTANTS.DEFAULT_HTTP_PORT),
  AGENTIS_HTTP_HOST: z.string().default('127.0.0.1'),
  // Comma-separated web UI origins permitted to connect to the realtime socket.
  AGENTIS_ALLOWED_ORIGINS: z.string().optional(),

  // Standard mode
  AGENTIS_DATABASE_URL: z.string().optional(),
  AGENTIS_REDIS_URL: z.string().optional(),

  // Auth seed (only used on first boot when no users exist)
  AGENTIS_SEED_USERNAME: z.string().default('operator'),
  AGENTIS_SEED_PASSWORD: z.string().optional(),
  AGENTIS_SEED_DISPLAY_NAME: z.string().default('Operator'),

  // Generated secrets are written to AGENTIS_DATA_DIR/secrets.json on first
  // boot and read from there on subsequent boots. Setting these env vars
  // overrides the file.
  AGENTIS_JWT_PRIVATE_KEY: z.string().optional(),
  AGENTIS_JWT_PUBLIC_KEY: z.string().optional(),
  AGENTIS_CREDENTIAL_KEY: z.string().optional(),

  // Extension runtime
  AGENTIS_EXTENSION_DOCKER: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  AGENTIS_EXTENSION_DOCKER_POOL_SIZE: z.coerce.number().int().positive().optional(),

  // Engine
  AGENTIS_WORKFLOW_PARALLELISM: z.string().default('auto'),

  // Extension registry client - offline until an operator selects an endpoint.
  AGENTIS_EXTENSION_REGISTRY_URL: z.string().url().optional(),
  AGENTIS_EXTENSION_REGISTRY_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // AgentisHub is an optional, explicit trust relationship. The open-source
  // runtime never ships or discovers a private key. Operators configure the
  // Hub URL plus a JSON key-id -> Ed25519 public-key map. When absent, Hub
  // import routes report "not configured" and no network request is made.
  AGENTIS_HUB_URL: z.string().url().optional(),
  AGENTIS_HUB_PUBLIC_KEYS: z.string().optional(),

  // Dashboard static asset serving (V1-SPEC §13). When set, the API server
  // serves the built dashboard from this directory at any non-/v1 path.
  AGENTIS_DASHBOARD_DIST: z.string().optional(),

  // The version of the installed `@agentis-labs/cli` npm package driving this
  // process. The CLI sets it from its own package.json at boot so the server
  // can compare it against the latest published release and surface an
  // "update available" prompt. Unset when running from source (dev) — the
  // update check simply reports no current version and stays silent.
  AGENTIS_CLI_VERSION: z.string().optional(),

  // E2E test harness. When `true`, the API mounts `/v1/_test/reset` (drops
  // every row + re-runs the seed) and forces a deterministic seed password
  // if one is not explicitly provided. Never enable in production — the
  // reset endpoint is unauthenticated by design so Playwright can use it
  // before logging in.
  AGENTIS_TEST_MODE: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),

  // OpenTelemetry — opt-in via OTLP/HTTP endpoint (e.g.
  // `http://localhost:4318/v1/traces`). When unset the engine + adapters
  // run with a no-op tracer. The OTel SDK packages are loaded dynamically
  // so an install that doesn't need tracing keeps the dep graph small.
  AGENTIS_OTEL_ENDPOINT: z.string().url().optional(),
  AGENTIS_OTEL_SERVICE_NAME: z.string().default('agentis-api'),

  // Evaluator runtime — opt-in. When unset, `evaluator` nodes fail at dispatch
  // with WORKFLOW_GRAPH_INVALID and `router` llm_route mode falls back to
  // first-match. Configure to enable LLM-as-judge for quality gates.
  AGENTIS_EVALUATOR_BASE_URL: z.string().url().optional(),
  AGENTIS_EVALUATOR_API_KEY: z.string().optional(),
  AGENTIS_EVALUATOR_MODEL: z.string().optional(),

  // Brain enrichment is deliberately opt-in because it incurs model cost.
  // It reuses the configured evaluator endpoint for structured generation.
  AGENTIS_BRAIN_ENRICHMENT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  AGENTIS_BRAIN_VISION_MODEL: z.string().optional(),
  AGENTIS_BRAIN_TRANSCRIPTION_MODEL: z.string().optional(),

  // Workflow synthesis runtime (§6). Dedicated model for `build_workflow` LLM
  // synthesis so it is NOT gated behind the evaluator config. When unset, falls
  // back to the evaluator runtime; when neither is set, build_workflow uses the
  // deterministic regex/template path.
  WORKFLOW_SYNTHESIS_BASE_URL: z.string().url().optional(),
  WORKFLOW_SYNTHESIS_API_KEY: z.string().optional(),
  WORKFLOW_SYNTHESIS_MODEL: z.string().default('gpt-4o-mini'),

  // Orchestrator chat runtime — opt-in fast path for the operator-facing chat.
  // When set, interactive chat turns for agents whose runtime is a slow
  // marker-protocol CLI (Codex / Claude Code) are answered by this native
  // function-calling endpoint instead — token-streamed tool calls, no per-turn
  // process re-spawn — while still attributed to the selected agent. Falls back
  // to the evaluator endpoint when these are unset; when neither is configured,
  // chat uses the agent's own adapter exactly as before.
  AGENTIS_ORCHESTRATOR_BASE_URL: z.string().url().optional(),
  AGENTIS_ORCHESTRATOR_API_KEY: z.string().optional(),
  AGENTIS_ORCHESTRATOR_MODEL: z.string().optional(),

  // Media generation (image today). Point BASE_URL at ANY OpenAI-compatible
  // /images endpoint — this is one pluggable provider, not a vendor commitment.
  // Absent API key ⇒ the media capability simply isn't offered (no error).
  AGENTIS_MEDIA_IMAGE_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  AGENTIS_MEDIA_IMAGE_API_KEY: z.string().optional(),
  AGENTIS_MEDIA_IMAGE_MODEL: z.string().default('gpt-image-1'),
  AGENTIS_MEDIA_SPEECH_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  AGENTIS_MEDIA_SPEECH_API_KEY: z.string().optional(),
  AGENTIS_MEDIA_SPEECH_MODEL: z.string().default('gpt-4o-mini-tts'),
  AGENTIS_MEDIA_AUDIO_BASE_URL: z.string().url().default('http://127.0.0.1:8188/v1'),
  AGENTIS_MEDIA_AUDIO_API_KEY: z.string().optional(),
  AGENTIS_MEDIA_AUDIO_MODEL: z.string().default('audio-generation'),

  // Idle watchdog for streaming chat turns (HermesAdapter/LocalLlmAdapter). If a
  // model endpoint sends no bytes for this many ms — while waiting for the first
  // token or mid-stream — the request is aborted and surfaced as an error rather
  // than hanging the turn forever. Resets on every chunk, so long live
  // generations are never cut. Defaults to CONVERSATION_AGENT_RESPONSE_TIMEOUT_MS.
  AGENTIS_CHAT_STREAM_TIMEOUT_MS: z.coerce.number().int().positive().optional(),

  // Wall-clock budget for a whole chat turn (all tool rounds). When exceeded the
  // executor stops and returns a graceful "ran out of time" message instead of
  // looping for minutes. Defaults to 180s.
  AGENTIS_CHAT_TURN_DEADLINE_MS: z.coerce.number().int().positive().optional(),

  // Per-role orchestrator model overrides (OMNICHANNEL-ORCHESTRATOR-10X §4.4).
  // The orchestrator does several kinds of cognition; each role can target a
  // different model/provider. Any role left unset falls back to the default
  // orchestrator profile above — so setting only AGENTIS_ORCHESTRATOR_MODEL
  // (e.g. claude-opus-4-8) makes one high model serve every role.
  AGENTIS_ORCHESTRATOR_PLANNING_BASE_URL: z.string().url().optional(),
  AGENTIS_ORCHESTRATOR_PLANNING_API_KEY: z.string().optional(),
  AGENTIS_ORCHESTRATOR_PLANNING_MODEL: z.string().optional(),

  // Inline OAuth (ORCHESTRATOR-CREATION §7). Public base URL the provider
  // redirects back to — must match the registered OAuth app redirect URI
  // (`<AGENTIS_PUBLIC_URL>/v1/oauth/<provider>/callback`). Defaults to the
  // local HTTP host:port.
  //
  // Agentis is BYOC (bring-your-own-credentials) by default: each self-hosted
  // instance registers its own OAuth app per provider and sets that provider's
  // OAUTH_<PROVIDER>_CLIENT_ID/_SECRET below — no shared/hosted relay, no
  // shared rate limits, no third party ever sees your tokens. AGENTIS_OAUTH_PROXY_URL
  // is an optional escape hatch for operators who want to run their own relay
  // (e.g. to avoid registering an OAuth app per instance); it is never defaulted.
  AGENTIS_PUBLIC_URL: z.string().url().optional(),
  AGENTIS_OAUTH_PROXY_URL: z.string().optional(),
  OAUTH_GOOGLE_CLIENT_ID: z.string().optional(),
  OAUTH_GOOGLE_CLIENT_SECRET: z.string().optional(),
  OAUTH_SLACK_CLIENT_ID: z.string().optional(),
  OAUTH_SLACK_CLIENT_SECRET: z.string().optional(),
  OAUTH_GITHUB_CLIENT_ID: z.string().optional(),
  OAUTH_GITHUB_CLIENT_SECRET: z.string().optional(),
  OAUTH_NOTION_CLIENT_ID: z.string().optional(),
  OAUTH_NOTION_CLIENT_SECRET: z.string().optional(),
  OAUTH_LINKEDIN_CLIENT_ID: z.string().optional(),
  OAUTH_LINKEDIN_CLIENT_SECRET: z.string().optional(),
  OAUTH_TWITTER_X_CLIENT_ID: z.string().optional(),
  OAUTH_TWITTER_X_CLIENT_SECRET: z.string().optional(),
});

// `loadEnv` always resolves AGENTIS_DATA_DIR / AGENTIS_ASSETS_DIR to concrete
// paths (defaults when unset), so consumers can treat them as required.
export type AgentisEnv = z.infer<typeof envSchema> & {
  AGENTIS_DATA_DIR: string;
  AGENTIS_ASSETS_DIR: string;
  AGENTIS_ARCHIVE_DIR: string;
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AgentisEnv {
  const parsed = envSchema.parse(source);
  const dataDir = parsed.AGENTIS_DATA_DIR ?? resolveDefaultDataDir();
  const assetsDir = parsed.AGENTIS_ASSETS_DIR ?? join(dataDir, 'assets');
  const archiveDir = parsed.AGENTIS_ARCHIVE_DIR ?? join(dataDir, 'archives');
  return {
    ...parsed,
    AGENTIS_DATA_DIR: dataDir,
    AGENTIS_ASSETS_DIR: assetsDir,
    AGENTIS_ARCHIVE_DIR: archiveDir,
  };
}
