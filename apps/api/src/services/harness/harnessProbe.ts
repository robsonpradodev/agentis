import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AdapterType } from '@agentis/core';
import { resolveCommandPath, resolveSpawnTarget, withExpandedPath } from '../pathExpander.js';

const execFileAsync = promisify(execFile);

export type V1HarnessAdapterType = Extract<AdapterType, 'openclaw' | 'hermes_agent' | 'claude_code' | 'codex' | 'cursor' | 'antigravity' | 'openrouter' | 'http'>;

export interface HarnessDetectionResult {
  adapterType: V1HarnessAdapterType;
  harness: string;
  status: 'found' | 'not_found' | 'error';
  detail?: string;
  binaryPath?: string;
  detectedModel?: string;
  detectedVersion?: string;
  authStatus?: 'authenticated' | 'unknown';
  authDetail?: string;
  config?: Record<string, unknown>;
  installCommand?: string;
  /**
   * The harness is installed but NOT yet usable — required config is missing, so
   * registering an agent on it would fail validation. Callers must not
   * auto-select a `needsConfig` harness (openclaw is `found` whenever its binary
   * is on PATH, but the adapter contract makes `gatewayUrl` mandatory; picking it
   * blind produced "Runtime probe failed: openclaw requires gatewayUrl").
   */
  needsConfig?: boolean;
}

interface ProbeResult {
  ok: boolean;
  detail?: string;
  error?: boolean;
  command?: string;
  binaryPath?: string;
  version?: string;
}

interface AuthDetection {
  status: 'authenticated' | 'unknown';
  detail: string;
  source?: string;
}

export interface HarnessCheck {
  /** Stable machine code for the check, e.g. `binary`, `auth`, `live_probe`. */
  code?: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  detail?: string;
  /** Actionable, human-readable next step when the check is not a clean pass. */
  hint?: string;
}

export interface HarnessTestResult {
  status: 'pass' | 'warn' | 'fail';
  checks: HarnessCheck[];
}

export interface HarnessTestOptions {
  /**
   * When true, CLI harnesses are exercised live (the binary is actually run
   * against a tiny prompt) instead of only being probed for presence. Deep
   * tests are slow (tens of seconds) and must only run on explicit user
   * action — never on the agent-registration hot path.
   */
  deep?: boolean;
  env?: NodeJS.ProcessEnv;
}

const CLI_HARNESSES: Array<{
  adapterType: Extract<V1HarnessAdapterType, 'claude_code' | 'codex' | 'cursor' | 'hermes_agent' | 'antigravity'>;
  harness: string;
  binaries: string[];
  installCommand: string;
}> = [
  { adapterType: 'claude_code', harness: 'Claude Code', binaries: ['claude'], installCommand: 'npm install -g @anthropic-ai/claude-code' },
  { adapterType: 'codex', harness: 'Codex', binaries: ['codex'], installCommand: 'npm install -g @openai/codex' },
  { adapterType: 'cursor', harness: 'Cursor', binaries: ['agent', 'cursor-agent', 'cursor'], installCommand: 'Install Cursor and enable the Cursor Agent CLI' },
  { adapterType: 'hermes_agent', harness: 'Hermes Agent', binaries: ['hermes', 'hermes-agent'], installCommand: 'Install the Hermes Agent CLI' },
  // Google's Gemini CLI (the runtime Google is rebranding to "Antigravity"); the
  // `antigravity`/`agy` binaries are accepted as forward-looking fallbacks.
  // Google's Antigravity CLI — the terminal harness Google is migrating
  // Gemini-CLI users to (OAuth / Google Cloud project auth that still works on
  // paid accounts). Installed via the antigravity.google script, binary `agy`.
  { adapterType: 'antigravity', harness: 'Antigravity CLI', binaries: ['agy', 'antigravity'], installCommand: 'irm https://antigravity.google/cli/install.ps1 | iex   (macOS/Linux: curl -fsSL https://antigravity.google/cli/install.sh | bash)' },
];

let _defaultProbeCache: { at: number; result: HarnessDetectionResult[] } | null = null;
const HARNESS_PROBE_TTL_MS = 60_000;

/** Commissioning is an operator-visible transition and must not be held hostage
 * by the background probe cache after a CLI has just started or appeared on PATH. */
export function invalidateHarnessProbeCache(): void {
  _defaultProbeCache = null;
}

/**
 * Detect installed CLI harnesses. The default-environment probe is cached for a
 * short TTL: repeated callers (e.g. one call per agent create) must not re-spawn
 * every harness's `--version` check each time — that stacked into multi-second
 * latency (and flaky test timeouts) under load. A caller passing a custom `env`
 * (sandboxed tests) bypasses the cache and always probes fresh; the TTL keeps
 * production detection fresh enough to notice a newly-installed harness.
 */
export async function detectHarnesses(env: NodeJS.ProcessEnv = process.env): Promise<HarnessDetectionResult[]> {
  // Escape hatch for test/CI environments that must not spawn real CLI `--version`
  // probes (deterministic + fast). Prod never sets this.
  if (env.AGENTIS_SKIP_HARNESS_PROBE === 'true') return [];
  if (env === process.env && _defaultProbeCache && Date.now() - _defaultProbeCache.at < HARNESS_PROBE_TTL_MS) {
    return _defaultProbeCache.result;
  }
  const result = await detectHarnessesUncached(env);
  if (env === process.env) _defaultProbeCache = { at: Date.now(), result };
  return result;
}

async function detectHarnessesUncached(env: NodeJS.ProcessEnv = process.env): Promise<HarnessDetectionResult[]> {
  const envWithPath = runtimeProbeEnv(env);
  const cli = await Promise.all(
    CLI_HARNESSES.map(async (item) => {
      const candidates = item.adapterType === 'claude_code'
        ? claudeBinaryCandidates(envWithPath, item.binaries)
        : item.adapterType === 'antigravity'
          ? agyBinaryCandidates(envWithPath, item.binaries)
          : item.binaries;
      const probe = await probeBinaryCandidates(candidates, envWithPath);
      const detectedModel = detectModel(item.adapterType, probe.detail);
      const auth = authDetectionFor(item.adapterType, envWithPath);
      const command = probe.command ?? item.binaries[0];
      return {
        adapterType: item.adapterType,
        harness: item.harness,
        status: probe.ok ? 'found' as const : probe.error ? 'error' as const : 'not_found' as const,
        detail: probe.detail,
        binaryPath: probe.binaryPath,
        detectedVersion: probe.version,
        detectedModel,
        authStatus: auth?.status,
        authDetail: auth?.detail,
        config: probe.ok ? compactRecord({ binaryPath: command, command, detectedBinaryPath: probe.binaryPath, model: detectedModel }) : undefined,
        installCommand: item.installCommand,
      };
    }),
  );
  const gatewayUrl = normalizeOpenClawGatewayUrl(firstNonEmpty(
    env.AGENTIS_OPENCLAW_GATEWAY_URL,
    env.OPENCLAW_GATEWAY_URL,
    env.OPENCLAW_GATEWAY,
  ));
  // The gateway URL is one signal, but OpenClaw also ships a local binary (like
  // Claude/Codex/Cursor/Hermes) — probe PATH for it too, so a locally running
  // OpenClaw shows up as "found" even before a gateway URL is configured.
  const openClawBinary = await probeBinaryCandidates(['openclaw'], envWithPath);
  const openClawFound = Boolean(gatewayUrl) || openClawBinary.ok;
  const httpBaseUrl = firstNonEmpty(
    env.AGENTIS_HTTP_AGENT_BASE_URL,
    env.AGENTIS_HTTP_BASE_URL,
    env.HTTP_AGENT_BASE_URL,
  );
  const httpDispatchPath = firstNonEmpty(
    env.AGENTIS_HTTP_AGENT_DISPATCH_PATH,
    env.AGENTIS_HTTP_DISPATCH_PATH,
  );
  return [
    ...cli,
    {
      adapterType: 'openclaw',
      harness: 'OpenClaw',
      status: openClawFound ? 'found' : 'not_found',
      detail: gatewayUrl
        ? `Gateway URL configured: ${gatewayUrl}`
        : openClawBinary.ok
          ? 'openclaw binary found on PATH — set a Gateway URL to use it'
          : undefined,
      binaryPath: openClawBinary.ok ? openClawBinary.binaryPath : undefined,
      config: gatewayUrl ? { gatewayUrl } : undefined,
      // Installed but unusable without a gateway URL — the adapter requires it.
      needsConfig: openClawFound && !gatewayUrl,
      installCommand: 'Install OpenClaw, then set its Gateway URL below (or export AGENTIS_OPENCLAW_GATEWAY_URL).',
    },
    {
      adapterType: 'http',
      harness: 'HTTP endpoint',
      status: httpBaseUrl ? 'found' : 'not_found',
      detail: httpBaseUrl ? `Base URL configured: ${httpBaseUrl}` : undefined,
      config: httpBaseUrl ? compactRecord({ baseUrl: httpBaseUrl, dispatchPath: httpDispatchPath }) : undefined,
    },
  ];
}

export async function testHarnessConfig(
  adapterType: V1HarnessAdapterType,
  config: Record<string, unknown>,
  options: HarnessTestOptions = {},
): Promise<HarnessTestResult> {
  const checks: HarnessCheck[] = [];
  if (adapterType === 'openrouter') {
    const configured = typeof config.authCredentialId === 'string' && typeof config.model === 'string' && Boolean(config.model.trim());
    return { status: configured ? 'pass' : 'fail', checks: [{ code: 'config', level: configured ? 'info' : 'error', message: configured ? 'OpenRouter configuration present. Use Test connection to verify the key and model.' : 'Save an OpenRouter credential and select a model.' }] };
  }
  const env = runtimeProbeEnv(options.env ?? process.env);

  if (adapterType === 'claude_code') {
    const command = cliCommandFromConfig(config, 'claude');
    const binary = await binaryCheck(command, 'Claude Code binary', 'binary', env);
    checks.push(binary);
    checks.push(claudeAuthCheck(env));
    if (binary.level !== 'error' && options.deep) {
      checks.push(await liveProbe('claude_code', command, env));
    }
    return resultFromChecks(checks);
  }
  if (adapterType === 'codex') {
    const command = cliCommandFromConfig(config, 'codex');
    const binary = await binaryCheck(command, 'Codex binary', 'binary', env);
    checks.push(binary);
    checks.push(codexAuthCheck(env));
    if (binary.level !== 'error' && options.deep) {
      checks.push(await liveProbe('codex', command, env));
    }
    return resultFromChecks(checks);
  }
  if (adapterType === 'antigravity') {
    checks.push(await binaryCheck(cliCommandFromConfig(config, 'agy'), 'Antigravity CLI binary', 'binary', env));
    checks.push(antigravityAuthCheck(env));
    return resultFromChecks(checks);
  }
  if (adapterType === 'cursor') {
    checks.push(await binaryCheck(cliCommandFromConfig(config, 'agent'), 'Cursor binary', 'binary', env));
    return resultFromChecks(checks);
  }
  if (adapterType === 'hermes_agent') {
    checks.push(await binaryCheck(cliCommandFromConfig(config, 'hermes'), 'Hermes Agent binary', 'binary', env));
    return resultFromChecks(checks);
  }
  if (adapterType === 'openclaw') {
    const gatewayUrl = normalizeOpenClawGatewayUrl(stringOf(config.gatewayUrl) ?? '') ?? '';
    const command = cliCommandFromConfig(config, 'openclaw');
    checks.push(await binaryCheck(command, 'OpenClaw binary', 'binary', env));
    if (!gatewayUrl) {
      checks.push({ level: 'error', message: 'OpenClaw gateway URL is required' });
      return resultFromChecks(checks);
    }
    const parsed = parseUrl(gatewayUrl);
    if (!parsed || (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:')) {
      checks.push({ level: 'error', message: 'OpenClaw gateway URL must use ws:// or wss://', detail: gatewayUrl });
      return resultFromChecks(checks);
    }
    checks.push({
      level: 'info',
      message: 'OpenClaw gateway URL is valid',
      detail: gatewayUrl,
    });
    const hasAuth = Boolean(
      firstNonEmpty(
        stringOf(config.authToken) ?? undefined,
        stringOf(config.password) ?? undefined,
        env.OPENCLAW_GATEWAY_TOKEN,
        env.OPENCLAW_GATEWAY_PASSWORD,
      ),
    );
    checks.push(hasAuth
      ? { level: 'info', message: 'OpenClaw gateway auth is configured' }
      : {
        level: 'warn',
        message: 'OpenClaw gateway auth was not detected',
        hint: 'Set OPENCLAW_GATEWAY_TOKEN / OPENCLAW_GATEWAY_PASSWORD or configure a gateway credential.',
      });
    return resultFromChecks(checks);
  }
  const url = httpHealthUrl(config);
  if (!url) {
    checks.push({ level: 'error', message: 'HTTP base URL is required' });
    return resultFromChecks(checks);
  }
  checks.push(await httpCheck(url));
  return resultFromChecks(checks);
}

async function binaryCheck(binary: string, label: string, code = 'binary', env: NodeJS.ProcessEnv = runtimeProbeEnv()): Promise<HarnessCheck> {
  const probe = await probeBinary(binary, env);
  if (probe.ok) {
    return {
      code,
      level: 'info',
      message: probe.version ? `${label} found (v${probe.version})` : `${label} found`,
      detail: probe.detail,
    };
  }
  return {
    code,
    level: 'error',
    message: `${label} not found`,
    detail: probe.detail,
    hint: `Install the runtime, or set an explicit binary path in connection settings. (\`${binary}\` was not on PATH.)`,
  };
}

/**
 * Inspect the environment for Claude Code credentials. This is a fast,
 * env-only check — it never blocks commissioning, only surfaces *why* a live
 * run might fail. Mirrors the auth modes Claude Code supports: Bedrock,
 * Vertex, a raw API key, or an interactive `claude login` subscription.
 */
function claudeAuthCheck(env: NodeJS.ProcessEnv): HarnessCheck {
  const auth = detectClaudeAuth(env);
  if (auth.status === 'authenticated') {
    return { code: 'auth', level: 'info', message: `Auth: ${auth.source ?? 'Claude login'}`, detail: auth.detail };
  }
  return {
    code: 'auth',
    level: 'warn',
    message: 'Claude auth was not detected',
    detail: auth.detail,
    hint: 'Run `claude login`, set ANTHROPIC_API_KEY, or configure Bedrock/Vertex env vars in this environment.',
  };
}

function codexAuthCheck(env: NodeJS.ProcessEnv): HarnessCheck {
  const auth = detectCodexAuth(env);
  if (auth.status === 'authenticated') {
    return { code: 'auth', level: 'info', message: `Auth: ${auth.source ?? 'Codex login'}`, detail: auth.detail };
  }
  return {
    code: 'auth',
    level: 'warn',
    message: 'Codex auth was not detected',
    detail: auth.detail,
    hint: 'Run `codex login`, `codex auth`, or set OPENAI_API_KEY in this environment.',
  };
}

function antigravityAuthCheck(env: NodeJS.ProcessEnv): HarnessCheck {
  const auth = detectAntigravityAuth(env);
  if (auth.status === 'authenticated') {
    return { code: 'auth', level: 'info', message: `Auth: ${auth.source ?? 'Antigravity sign-in'}`, detail: auth.detail };
  }
  return {
    code: 'auth',
    level: 'warn',
    message: 'Antigravity sign-in was not detected',
    detail: auth.detail,
    hint: 'Run `agy` once and complete the Google sign-in (use a Google Cloud project for paid accounts). The session is cached in the system keyring.',
  };
}

function runtimeProbeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION', 'CLAUDE_CODE_PARENT_SESSION']) {
    delete next[key];
  }
  return withExpandedPath(next);
}

function authDetectionFor(adapterType: V1HarnessAdapterType, env: NodeJS.ProcessEnv): AuthDetection | undefined {
  if (adapterType === 'claude_code') return detectClaudeAuth(env);
  if (adapterType === 'codex') return detectCodexAuth(env);
  if (adapterType === 'antigravity') return detectAntigravityAuth(env);
  return undefined;
}

function claudeBinaryCandidates(env: NodeJS.ProcessEnv, fallbacks: string[]): string[] {
  const candidates: string[] = [];
  const appData = firstNonEmpty(env.APPDATA, path.join(homeDirFromEnv(env), 'AppData', 'Roaming'));
  if (appData) {
    const root = path.join(appData, 'Claude', 'claude-code');
    if (existsSync(root)) {
      const versions = safeReadDir(root)
        .filter((name) => existsSync(path.join(root, name, process.platform === 'win32' ? 'claude.exe' : 'claude')))
        .sort(compareVersionDesc);
      for (const version of versions) {
        candidates.push(path.join(root, version, process.platform === 'win32' ? 'claude.exe' : 'claude'));
      }
    }
  }
  candidates.push(...fallbacks);
  return [...new Set(candidates)];
}

/**
 * The Antigravity CLI installer drops `agy` at `%LOCALAPPDATA%\agy\bin\agy.exe`
 * (Windows) / `~/.local/bin/agy` (Unix) and adds that dir to the USER PATH — but
 * a server process started before the install won't have the refreshed PATH, so
 * `agy` is "installed but not detected". Probe the known install locations
 * directly (highest priority), then fall back to PATH lookups. Mirrors
 * {@link claudeBinaryCandidates}.
 */
function agyBinaryCandidates(env: NodeJS.ProcessEnv, fallbacks: string[]): string[] {
  const candidates: string[] = [];
  const win = process.platform === 'win32';
  const exe = win ? 'agy.exe' : 'agy';
  const home = homeDirFromEnv(env);
  const localAppData = firstNonEmpty(env.LOCALAPPDATA, win ? path.join(home, 'AppData', 'Local') : undefined);
  for (const dir of [
    localAppData ? path.join(localAppData, 'agy', 'bin') : undefined,
    localAppData ? path.join(localAppData, 'Antigravity') : undefined,
    path.join(home, '.local', 'bin'),
    path.join(home, '.agy', 'bin'),
  ]) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    if (existsSync(candidate)) candidates.push(candidate);
  }
  candidates.push(...fallbacks);
  return [...new Set(candidates)];
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function compareVersionDesc(left: string, right: string): number {
  const a = left.split('.').map((part) => Number(part));
  const b = right.split('.').map((part) => Number(part));
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return right.localeCompare(left);
}

function detectClaudeAuth(env: NodeJS.ProcessEnv): AuthDetection {
  if (isTruthyEnv(env.CLAUDE_CODE_USE_BEDROCK)) {
    return { status: 'authenticated', source: 'Amazon Bedrock', detail: 'CLAUDE_CODE_USE_BEDROCK is set.' };
  }
  if (isTruthyEnv(env.CLAUDE_CODE_USE_VERTEX)) {
    return { status: 'authenticated', source: 'Google Vertex AI', detail: 'CLAUDE_CODE_USE_VERTEX is set.' };
  }
  if (firstNonEmpty(env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN)) {
    return { status: 'authenticated', source: 'Anthropic API key', detail: 'ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is set.' };
  }

  const home = homeDirFromEnv(env);
  const claudeConfig = readJsonObject(path.join(home, '.claude.json'));
  const claudeEmail = claudeConfig
    ? firstNonEmpty(
      nestedString(claudeConfig, ['oauthAccount', 'emailAddress']),
      nestedString(claudeConfig, ['oauthAccount', 'email']),
    )
    : undefined;
  if (claudeEmail) {
    return { status: 'authenticated', source: 'Claude subscription login', detail: `Logged in as ${claudeEmail}.` };
  }

  const credentialsPath = path.join(home, '.claude', '.credentials.json');
  const credentials = readJsonObject(credentialsPath);
  if (credentials) {
    const accessToken = firstNonEmpty(
      nestedString(credentials, ['claudeAiOauth', 'accessToken']),
      nestedString(credentials, ['oauth', 'accessToken']),
    );
    const apiKey = firstNonEmpty(nestedString(credentials, ['apiKey']), nestedString(credentials, ['ANTHROPIC_API_KEY']));
    if (accessToken) return { status: 'authenticated', source: 'Claude subscription login', detail: `Credentials found in ${credentialsPath}.` };
    if (apiKey) return { status: 'authenticated', source: 'Anthropic API key', detail: `API key found in ${credentialsPath}.` };
  }

  return {
    status: 'unknown',
    detail: `No Claude auth env vars or local login files were found under ${home}.`,
  };
}

function detectCodexAuth(env: NodeJS.ProcessEnv): AuthDetection {
  if (firstNonEmpty(env.OPENAI_API_KEY, env.CODEX_API_KEY)) {
    return { status: 'authenticated', source: 'OpenAI API key', detail: 'OPENAI_API_KEY or CODEX_API_KEY is set.' };
  }

  const home = homeDirFromEnv(env);
  const codexHome = firstNonEmpty(env.CODEX_HOME) ?? path.join(home, '.codex');
  const authPath = path.join(codexHome, 'auth.json');
  const auth = readJsonObject(authPath);
  if (auth) {
    const accessToken = firstNonEmpty(
      nestedString(auth, ['accessToken']),
      nestedString(auth, ['tokens', 'access_token']),
    );
    const apiKey = nestedString(auth, ['OPENAI_API_KEY']);
    if (apiKey) return { status: 'authenticated', source: 'OpenAI API key', detail: `API key found in ${authPath}.` };
    if (accessToken) {
      const email = emailFromJwt(nestedString(auth, ['tokens', 'id_token'])) ?? emailFromJwt(accessToken);
      return {
        status: 'authenticated',
        source: 'Codex login',
        detail: email ? `Logged in as ${email}.` : `Credentials found in ${authPath}.`,
      };
    }
  }

  return {
    status: 'unknown',
    detail: `No OpenAI env key or Codex login file was found under ${codexHome}.`,
  };
}

/**
 * Inspect the environment for Gemini CLI credentials. An API key
 * (GEMINI_API_KEY / GOOGLE_API_KEY) is the headless-friendly path. A Google
 * OAuth login is recorded in `~/.gemini/google_accounts.json` — but the free
 * "Code Assist for individuals" tier is now refused at runtime, so a login alone
 * is reported as `unknown` with a pointer to set an API key.
 */
/**
 * Inspect for an Antigravity CLI (`agy`) sign-in. `agy` authenticates via Google
 * OAuth / a Google Cloud project, caching the session in the system keyring with
 * config under `~/.gemini/antigravity-cli/`. We can't read the keyring, so a
 * populated antigravity-cli home (settings/credentials) is treated as "signed in";
 * otherwise we report `unknown` with a pointer to the one-time `agy` sign-in.
 */
function detectAntigravityAuth(env: NodeJS.ProcessEnv): AuthDetection {
  const home = homeDirFromEnv(env);
  const agyHome = firstNonEmpty(env.ANTIGRAVITY_HOME) ?? path.join(home, '.gemini', 'antigravity-cli');
  for (const file of ['oauth_creds.json', 'credentials.json', 'auth.json', 'settings.json']) {
    if (existsSync(path.join(agyHome, file))) {
      return { status: 'authenticated', source: 'Antigravity sign-in', detail: `Antigravity session found under ${agyHome}.` };
    }
  }
  return {
    status: 'unknown',
    detail: `No Antigravity sign-in was found under ${agyHome}. Run \`agy\` once and sign in (use a Google Cloud project for paid accounts).`,
  };
}

function homeDirFromEnv(env: NodeJS.ProcessEnv): string {
  return firstNonEmpty(env.USERPROFILE, env.HOME) ?? os.homedir();
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function nestedString(record: Record<string, unknown>, segments: string[]): string | undefined {
  let current: unknown = record;
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'string' && current.trim().length > 0 ? current.trim() : undefined;
}

function emailFromJwt(token: string | undefined): string | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;
  const profile = objectOf(payload['https://api.openai.com/profile']);
  const auth = objectOf(payload['https://api.openai.com/auth']);
  return firstNonEmpty(
    stringOf(payload.email) ?? undefined,
    stringOf(profile?.email) ?? undefined,
    stringOf(auth?.chatgpt_user_email) ?? undefined,
  );
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const encoded = token.split('.')[1];
  if (!encoded) return null;
  try {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Best-in-class deep probe: actually run the CLI against a one-word prompt and
 * interpret the outcome. Distinguishes a clean pass, a login/auth failure, a
 * timeout, and unexpected output — each with an actionable hint.
 */
async function liveProbe(
  adapterType: 'claude_code' | 'codex',
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<HarnessCheck> {
  const label = adapterType === 'claude_code' ? 'Claude Code' : 'Codex';
  const args = adapterType === 'claude_code'
    ? ['--print', '--output-format=stream-json', '--verbose', '--include-partial-messages', '--max-turns=4']
    : ['exec', '--skip-git-repo-check', 'Respond with the single word: hello.'];
  const prompt = 'Respond with the single word: hello.';
  const cwd = process.cwd();

  try {
    const target = resolveSpawnTarget(command, args, cwd, env);
    const outcome = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
      const child = spawn(target.command, target.args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 45_000);
      timer.unref?.();
      child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
      if (adapterType === 'claude_code') child.stdin?.end(prompt);
      else child.stdin?.end();
    });

    if (outcome.timedOut) {
      return {
        code: 'live_probe',
        level: 'warn',
        message: `${label} probe timed out`,
        detail: 'No response within 45s.',
        hint: 'The runtime is installed but slow or stuck. Try a model override or check network access.',
      };
    }

    const combined = `${outcome.stdout}\n${outcome.stderr}`.toLowerCase();
    if (/log ?in|not authenticated|unauthorized|api key|credit balance|invalid_request_error|authentication/.test(combined)) {
      return {
        code: 'live_probe',
        level: 'error',
        message: `${label} is installed but not authenticated`,
        detail: firstLine(outcome.stderr || outcome.stdout),
        hint: adapterType === 'claude_code'
          ? 'Run `claude login`, or set ANTHROPIC_API_KEY in this environment.'
          : 'Run `codex login`, or set OPENAI_API_KEY in this environment.',
      };
    }

    if (outcome.code === 0 && /hello/i.test(combined)) {
      return { code: 'live_probe', level: 'info', message: `${label} responded — runtime is live`, detail: 'Completed a one-word round-trip.' };
    }

    if (outcome.code === 0) {
      return {
        code: 'live_probe',
        level: 'warn',
        message: `${label} ran but the response was unexpected`,
        detail: firstLine(outcome.stdout || outcome.stderr),
        hint: 'The CLI works but did not echo the probe word. It should still be usable.',
      };
    }

    return {
      code: 'live_probe',
      level: 'error',
      message: `${label} exited with code ${outcome.code ?? 'unknown'}`,
      detail: firstLine(outcome.stderr || outcome.stdout),
      hint: 'Inspect the runtime CLI directly — it failed a minimal prompt.',
    };
  } catch (err) {
    return {
      code: 'live_probe',
      level: 'error',
      message: `${label} could not be launched`,
      detail: (err as Error).message,
      hint: 'Verify the binary path in connection settings.',
    };
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

async function probeBinary(binary: string, env: NodeJS.ProcessEnv): Promise<ProbeResult> {
  const cwd = process.cwd();
  const binaryPath = resolveCommandPath(binary, cwd, env);
  const version = await runProbe(binary, ['--version'], env, cwd);

  if (version.ok || binaryPath) {
    return {
      ok: true,
      detail: version.ok ? firstNonEmpty(version.detail, binaryPath ?? undefined) : binaryPath ?? version.detail,
      binaryPath: binaryPath ?? undefined,
      version: version.ok ? parseVersion(version.detail) : undefined,
    };
  }

  return {
    ok: false,
    detail: version.detail,
    error: version.error,
  };
}

async function probeBinaryCandidates(binaries: string[], env: NodeJS.ProcessEnv): Promise<ProbeResult> {
  let best: ProbeResult | undefined;
  for (const binary of binaries) {
    const probe = await probeBinary(binary, env);
    if (probe.ok) {
      return { ...probe, command: binary, binaryPath: probe.binaryPath ?? binary };
    }
    if (!best || probe.error) best = probe;
  }
  return best ?? { ok: false };
}

async function runProbe(command: string, args: string[], env: NodeJS.ProcessEnv, cwd = process.cwd()): Promise<ProbeResult> {
  try {
    const target = resolveSpawnTarget(command, args, cwd, env);
    const { stdout, stderr } = await execFileAsync(target.command, target.args, { cwd, env, timeout: 2000, windowsHide: true });
    return { ok: true, detail: firstLine(stdout || stderr) };
  } catch (err) {
    const error = err as { code?: string | number; signal?: string; stdout?: string; stderr?: string; message?: string };
    const detail = error.code === 'ENOENT'
      ? `Command not found in PATH: "${command}"`
      : firstLine(error.stdout || error.stderr || error.message);
    const missing = error.code === 'ENOENT'
      || /not recognized as (an|a) (internal|external) command|command not found|not found in path/i.test(detail ?? '');
    return {
      ok: false,
      error: !missing,
      detail,
    };
  }
}

async function httpCheck(url: string): Promise<HarnessCheck> {
  const parsed = parseUrl(url);
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return { level: 'error', message: 'HTTP URL must use http:// or https://', detail: url };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  timeout.unref?.();
  try {
    let response = await fetch(parsed, { method: 'HEAD', signal: controller.signal });
    if (response.status === 405) response = await fetch(parsed, { method: 'GET', signal: controller.signal });
    const level = response.ok || response.status === 401 ? 'info' : 'warn';
    return { level, message: 'HTTP endpoint reachable', detail: `${response.status} ${response.statusText}` };
  } catch (err) {
    return { level: 'error', message: 'HTTP endpoint unreachable', detail: (err as Error).message };
  } finally {
    clearTimeout(timeout);
  }
}

async function websocketCheck(url: string, headers?: Record<string, string>): Promise<HarnessCheck> {
  const WebSocketCtor = await resolveWebSocketCtor();
  if (!WebSocketCtor) {
    return { level: 'warn', message: 'WebSocket runtime unavailable for live handshake' };
  }
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      cleanup();
      resolve({ level: 'error', message: 'OpenClaw gateway connection timed out' });
    }, 3000);
    timeout.unref?.();
    let socket: WebSocketLike;
    try {
      socket = new WebSocketCtor(url, undefined, headers && Object.keys(headers).length > 0 ? { headers } : undefined);
    } catch (err) {
      clearTimeout(timeout);
      resolve({ level: 'error', message: 'OpenClaw gateway connection failed', detail: (err as Error).message });
      return;
    }
    const cleanup = () => {
      clearTimeout(timeout);
      try { socket.close(); } catch {}
    };
    bindWebSocket(socket, 'open', () => {
      setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ level: 'info', message: 'OpenClaw gateway reachable' });
      }, 250).unref?.();
    });
    bindWebSocket(socket, 'message', (raw) => {
      const message = parseSocketMessage(raw);
      if (message?.kind !== 'connect.challenge') return;
      try {
        socket.send(JSON.stringify({ kind: 'req.connect', clientId: 'agentis-probe', role: 'operator', scopes: ['agent:request'], challenge: message.challenge }));
      } catch {}
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ level: 'info', message: 'OpenClaw gateway challenge received' });
    });
    bindWebSocket(socket, 'error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ level: 'error', message: 'OpenClaw gateway connection failed', detail: err instanceof Error ? err.message : String(err) });
    });
  });
}

type WebSocketLike = {
  send(data: string): void;
  close(): void;
  addEventListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
};

type WebSocketCtor = new (url: string, protocols?: string | string[], options?: { headers?: Record<string, string> }) => WebSocketLike;

async function resolveWebSocketCtor(): Promise<WebSocketCtor | null> {
  const globalCtor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (globalCtor) return globalCtor;
  try {
    const mod = (await import('ws' as string)) as { WebSocket?: WebSocketCtor; default?: WebSocketCtor };
    return mod.WebSocket ?? mod.default ?? null;
  } catch {
    return null;
  }
}

function bindWebSocket(socket: WebSocketLike, event: string, handler: (...args: unknown[]) => void) {
  if (socket.addEventListener) socket.addEventListener(event, (...args) => handler(...args));
  else socket.on?.(event, (...args) => handler(...args));
}

function httpHealthUrl(config: Record<string, unknown>): string | null {
  const dispatchUrl = stringOf(config.dispatchUrl);
  if (dispatchUrl) return dispatchUrl;
  const baseUrl = stringOf(config.baseUrl);
  if (!baseUrl) return null;
  const healthPath = stringOf(config.healthPath);
  if (healthPath) return joinUrl(baseUrl, healthPath);
  return baseUrl;
}

function openClawHeaders(config: Record<string, unknown>): Record<string, string> | undefined {
  const headers = recordStringOf(config.headers) ?? {};
  const authToken = stringOf(config.authToken);
  const password = stringOf(config.password);
  if (authToken) {
    headers.authorization = `Bearer ${authToken}`;
    headers['x-openclaw-token'] = authToken;
  }
  if (password) headers['x-openclaw-password'] = password;
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function joinUrl(baseUrl: string, path: string): string {
  if (!path) return baseUrl;
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function resultFromChecks(checks: HarnessCheck[]): HarnessTestResult {
  const status = checks.some((check) => check.level === 'error')
    ? 'fail'
    : checks.some((check) => check.level === 'warn')
      ? 'warn'
      : 'pass';
  return { status, checks };
}

function firstLine(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 240);
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function parseVersion(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/(\d+\.\d+(?:\.\d+)?)/);
  return match?.[1];
}

function detectModel(adapterType: V1HarnessAdapterType, detail: string | undefined): string | undefined {
  if (!detail || adapterType === 'openclaw' || adapterType === 'http') return undefined;
  const explicit = detail.match(/default:\s*([^\)]+)/i)?.[1]?.trim();
  if (explicit) return explicit;
  return undefined;
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cliCommandFromConfig(config: Record<string, unknown>, fallback: string): string {
  return stringOf(config.command) ?? stringOf(config.binaryPath) ?? fallback;
}

function recordStringOf(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function compactRecord(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(obj).filter(([, value]) => value !== undefined && value !== null && value !== '');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function normalizeOpenClawGatewayUrl(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
    if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
    return parsed.toString();
  } catch {
    return raw;
  }
}

function parseSocketMessage(raw: unknown): Record<string, unknown> | null {
  const text = typeof raw === 'string'
    ? raw
    : raw instanceof Buffer
      ? raw.toString('utf8')
      : typeof MessageEvent !== 'undefined' && raw instanceof MessageEvent && typeof raw.data === 'string'
        ? raw.data
        : null;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
