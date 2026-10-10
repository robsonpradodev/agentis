import { basename, dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

type AdapterType = 'openclaw' | 'hermes_agent' | 'claude_code' | 'codex' | 'cursor' | 'openrouter' | 'http';
type ConfigSource = 'claude_code' | 'codex';
type AgentRole = 'orchestrator' | 'manager' | 'worker';
type ChannelKind = 'telegram' | 'discord';

interface Flags {
  [key: string]: string | true;
}

interface ParsedArgs {
  positionals: string[];
  flags: Flags;
}

interface WorkspaceSummary {
  id: string;
  name: string;
  defaultAmbientId?: string | null;
}

interface ExistingAgent {
  id: string;
  name: string;
  role?: AgentRole | null;
  adapterType?: AdapterType | null;
}

interface BootstrapResponse {
  existed: boolean;
  agentId: string;
  workspaceId: string;
  channelIds?: string[];
  name?: string;
}

interface ImportResponse {
  created: { agents: number; channels: number };
  skipped: string[];
  errors: Array<{ item: string; message: string }>;
}

interface ImportConfigAgent {
  name: string;
  role: AgentRole;
  adapterType: AdapterType;
  description?: string | null;
  instructions?: string | null;
  capabilityTags?: string[];
  runtimeModel?: string | null;
  reportsTo?: string | null;
  monthlyBudgetCents?: number | null;
  colorHex?: string | null;
  avatarGlyph?: string | null;
  config?: Record<string, unknown>;
}

interface ImportConfigChannel {
  kind: ChannelKind;
  agentName: string;
  name?: string;
  token: string;
  defaultChatId?: string;
}

interface ImportConfig {
  version: string;
  workspace?: { name?: string };
  agents: ImportConfigAgent[];
  channels: ImportConfigChannel[];
}

const ROLE_COLOR: Record<AgentRole, string> = {
  orchestrator: '#8b5cf6',
  manager: '#06b6d4',
  worker: '#60a5fa',
};

const DEFAULT_DESCRIPTION: Record<AgentRole, string> = {
  orchestrator: 'Workspace orchestrator. Routes goals, coordinates managers, keeps the system aligned.',
  manager: 'Domain manager. Turns strategy into scoped execution for specialists.',
  worker: 'Specialist. Executes tasks within a focused operating lane.',
};

const DEFAULT_INSTRUCTIONS: Record<AgentRole, string> = {
  orchestrator: 'You are the workspace orchestrator. Route goals, delegate clearly, and keep the operator updated with concise status and blockers.',
  manager: 'You own one domain. Translate goals into executable work, coordinate specialists, and keep priorities explicit.',
  worker: 'You are a specialist operator. Execute assigned work precisely, surface blockers early, and return reusable results.',
};

export async function runBootstrapCmd(argv: string[]): Promise<number> {
  const { positionals, flags } = parseFlags(argv);
  if (positionals[0] === 'generate-config') {
    return runGenerateConfigCmd(argv.slice(1));
  }

  try {
    const baseUrl = requireFlag(flags, 'url');
    const apiKey = requireFlag(flags, 'api-key');
    await ensureHealthy(baseUrl);

    const workspaceId = await resolveWorkspaceId(baseUrl, apiKey, flagString(flags, 'workspace-id') ?? flagString(flags, 'workspace'));
    const ambientId = flagString(flags, 'ambient-id');
    const importPath = flagString(flags, 'import');

    if (importPath) {
      const imported = await runImportFlow({
        baseUrl,
        apiKey,
        workspaceId,
        ambientId,
        importPath,
      });
      writeJson(imported);
      return 0;
    }

    const role = parseRole(flagString(flags, 'role') ?? 'orchestrator');
    const adapterType = parseAdapter(flagString(flags, 'adapter'));
    const name = flagString(flags, 'name') ?? defaultNameForRole(role);
    const existingOrchestrator = await fetchExistingOrchestrator(baseUrl, apiKey, workspaceId, ambientId);

    if (role === 'orchestrator' && existingOrchestrator) {
      if (existingOrchestrator.name === name && existingOrchestrator.adapterType === adapterType) {
        writeJson({
          ok: true,
          alreadyExists: true,
          agentId: existingOrchestrator.id,
          role,
          workspaceId,
          channels: [],
          imported: { agents: 0, channels: 0 },
        });
        return 0;
      }
      writeJson({ ok: false, error: `Workspace orchestrator already exists: ${existingOrchestrator.name}` }, true);
      return 1;
    }

    let reportsTo = flagString(flags, 'reports-to');
    if (!reportsTo && role !== 'orchestrator' && existingOrchestrator) {
      reportsTo = existingOrchestrator.id;
    }
    if (role !== 'orchestrator' && !reportsTo) {
      writeJson({ ok: false, error: 'Managers and specialists require an existing orchestrator or an explicit --reports-to id.' }, true);
      return 1;
    }

    const channels = collectChannels(flags);
    const payload = {
      agent: {
        name,
        role,
        description: flagString(flags, 'description') ?? DEFAULT_DESCRIPTION[role],
        adapterType,
        runtimeModel: flagString(flags, 'model') ?? detectModelHint(adapterType),
        reportsTo: role === 'orchestrator' ? null : reportsTo,
        capabilityTags: splitCsv(flagString(flags, 'capability-tags')),
        instructions: readInstructions(flags, role),
        monthlyBudgetCents: budgetToCents(flagString(flags, 'monthly-budget')),
        colorHex: flagString(flags, 'color') ?? ROLE_COLOR[role],
        avatarGlyph: initials(name),
        config: buildRuntimeConfig(adapterType, flags),
      },
      channels,
    };

    const result = await requestJson<BootstrapResponse>(baseUrl, '/v1/bootstrap', {
      method: 'POST',
      apiKey,
      workspaceId,
      ambientId,
      body: payload,
    });

    writeJson({
      ok: true,
      alreadyExists: result.existed,
      agentId: result.agentId,
      role,
      workspaceId: result.workspaceId,
      channels: channels.map((channel) => channel.kind),
      imported: { agents: 0, channels: 0 },
    });
    return 0;
  } catch (error) {
    writeJson({ ok: false, error: error instanceof Error ? error.message : String(error) }, true);
    return 1;
  }
}

export async function runGenerateConfigCmd(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv);
  try {
    const source = parseConfigSource(flagString(flags, 'from'));
    const output = resolveFromInvocation(flagString(flags, 'output') ?? './agentis-config.json');
    const role = parseRole(flagString(flags, 'role') ?? 'orchestrator');
    const name = flagString(flags, 'name') ?? defaultNameForRole(role);
    const workspaceName = flagString(flags, 'workspace-name') ?? basename(invocationCwd());
    const model = flagString(flags, 'model') ?? detectModelHint(source);
    const instructions = readFirstExisting([
      resolve(invocationCwd(), 'CLAUDE.md'),
      resolve(invocationCwd(), 'AGENTS.md'),
      resolve(invocationCwd(), 'README.md'),
    ]) ?? DEFAULT_INSTRUCTIONS[role];

    const config: ImportConfig = {
      version: '1',
      workspace: { name: workspaceName },
      agents: [
        {
          name,
          role,
          adapterType: source,
          description: flagString(flags, 'description') ?? DEFAULT_DESCRIPTION[role],
          instructions,
          runtimeModel: model,
          capabilityTags: splitCsv(flagString(flags, 'capability-tags')),
          colorHex: flagString(flags, 'color') ?? ROLE_COLOR[role],
          avatarGlyph: initials(name),
          config: buildRuntimeConfig(source, flags),
        },
      ],
      channels: [],
    };

    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    writeJson({ ok: true, output, agents: config.agents.length, source });
    return 0;
  } catch (error) {
    writeJson({ ok: false, error: error instanceof Error ? error.message : String(error) }, true);
    return 1;
  }
}

function parseFlags(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

function flagString(flags: Flags, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

function requireFlag(flags: Flags, key: string): string {
  const value = flagString(flags, key);
  if (!value) throw new Error(`Missing required flag --${key}`);
  return value;
}

function parseRole(value: string): AgentRole {
  if (value === 'specialist') return 'worker';
  if (value === 'orchestrator' || value === 'manager' || value === 'worker') return value;
  throw new Error(`Unsupported role: ${value}`);
}

function parseAdapter(value?: string): AdapterType {
  if (!value) throw new Error('Missing required flag --adapter');
  if (value === 'openrouter' || value === 'openclaw' || value === 'hermes_agent' || value === 'claude_code' || value === 'codex' || value === 'cursor' || value === 'http') {
    return value;
  }
  throw new Error(`Unsupported adapter: ${value}`);
}

function parseConfigSource(value?: string): ConfigSource {
  if (!value) throw new Error('Missing required flag --from');
  if (value === 'claude_code' || value === 'codex') return value;
  throw new Error(`Unsupported config source: ${value}`);
}

function defaultNameForRole(role: AgentRole): string {
  if (role === 'orchestrator') return 'The Brain';
  if (role === 'manager') return 'Department Manager';
  return 'Specialist';
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}`.toUpperCase();
}

function splitCsv(value?: string): string[] {
  if (!value) return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function budgetToCents(value?: string): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

function buildRuntimeConfig(adapterType: AdapterType, flags: Flags): Record<string, unknown> {
  const cwd = flagString(flags, 'cwd') ?? invocationCwd();
  const binaryPath = flagString(flags, 'binary-path');
  if (adapterType === 'openrouter') {
    return { authCredentialId: requireFlag(flags, 'auth-credential-id'), model: requireFlag(flags, 'model'), timeoutMs: 75_000 };
  }
  if (adapterType === 'openclaw') {
    return {
      openclawGatewayUrl: flagString(flags, 'openclaw-gateway-url') ?? undefined,
      openclawGatewayId: flagString(flags, 'openclaw-gateway-id') ?? undefined,
      cwd,
    };
  }
  if (adapterType === 'http') {
    return {
      endpoint: flagString(flags, 'http-url') ?? undefined,
    };
  }
  return {
    binaryPath: binaryPath ?? defaultBinaryForAdapter(adapterType),
    cwd,
  };
}

function defaultBinaryForAdapter(adapterType: AdapterType): string {
  if (adapterType === 'claude_code') return 'claude';
  if (adapterType === 'codex') return 'codex';
  if (adapterType === 'cursor') return 'cursor-agent';
  if (adapterType === 'hermes_agent') return 'hermes';
  return adapterType;
}

function detectModelHint(source: AdapterType | ConfigSource): string | undefined {
  if (source === 'claude_code') {
    return readModelSetting([
      resolve(invocationCwd(), '.claude', 'settings.json'),
      join(process.env.USERPROFILE ?? '', '.claude', 'settings.json'),
    ]) ?? process.env.ANTHROPIC_MODEL;
  }
  if (source === 'codex') {
    return readModelSetting([
      resolve(invocationCwd(), '.codex', 'settings.json'),
      join(process.env.USERPROFILE ?? '', '.codex', 'settings.json'),
    ]) ?? process.env.OPENAI_MODEL;
  }
  return undefined;
}

function readModelSetting(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      const raw = JSON.parse(readFileSync(candidate, 'utf8')) as Record<string, unknown>;
      const model = raw.model ?? raw.defaultModel ?? raw.modelName;
      if (typeof model === 'string' && model.trim()) return model.trim();
    } catch {
      // Ignore malformed local settings.
    }
  }
  return undefined;
}

function readInstructions(flags: Flags, role: AgentRole): string {
  const inline = flagString(flags, 'instructions');
  if (inline) return inline;
  const instructionsFile = flagString(flags, 'instructions-file');
  if (instructionsFile) {
    return readFileSync(resolveFromInvocation(instructionsFile), 'utf8');
  }
  return readFirstExisting([
    resolve(invocationCwd(), 'CLAUDE.md'),
    resolve(invocationCwd(), 'AGENTS.md'),
  ]) ?? DEFAULT_INSTRUCTIONS[role];
}

function readFirstExisting(paths: string[]): string | undefined {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, 'utf8').trim();
      if (text) return text;
    } catch {
      // Ignore unreadable optional files.
    }
  }
  return undefined;
}

function collectChannels(flags: Flags): Array<{ kind: ChannelKind; token: string; defaultChatId?: string }> {
  const channels: Array<{ kind: ChannelKind; token: string; defaultChatId?: string }> = [];
  const telegramToken = flagString(flags, 'channel-telegram-token');
  if (telegramToken) {
    channels.push({
      kind: 'telegram',
      token: telegramToken,
      defaultChatId: flagString(flags, 'channel-telegram-chat-id'),
    });
  }
  const discordToken = flagString(flags, 'channel-discord-token');
  if (discordToken) {
    channels.push({
      kind: 'discord',
      token: discordToken,
      defaultChatId: flagString(flags, 'channel-discord-chat-id'),
    });
  }
  return channels;
}

async function runImportFlow(options: {
  baseUrl: string;
  apiKey: string;
  workspaceId: string;
  ambientId?: string;
  importPath: string;
}) {
  const importConfig = normalizeImportConfig(readJsonFile(resolveFromInvocation(options.importPath)));
  const result = await requestJson<ImportResponse>(options.baseUrl, '/v1/bootstrap/import', {
    method: 'POST',
    apiKey: options.apiKey,
    workspaceId: options.workspaceId,
    ambientId: options.ambientId,
    body: importConfig,
  });

  return {
    ok: true,
    workspaceId: options.workspaceId,
    imported: result.created,
    skipped: result.skipped,
    errors: result.errors,
  };
}

function normalizeImportConfig(raw: unknown): ImportConfig {
  if (!raw || typeof raw !== 'object') throw new Error('Import config must be a JSON object.');
  const record = raw as Record<string, unknown>;
  const agentsRaw = Array.isArray(record.agents) ? record.agents : [];
  const channelsRaw = Array.isArray(record.channels) ? record.channels : [];

  const agents = agentsRaw.map((agent, index) => normalizeImportAgent(agent, index));
  const channels = channelsRaw.map((channel, index) => normalizeImportChannel(channel, index));

  return {
    version: typeof record.version === 'string' ? record.version : '1',
    workspace: typeof record.workspace === 'object' && record.workspace !== null ? record.workspace as { name?: string } : undefined,
    agents,
    channels,
  };
}

function normalizeImportAgent(raw: unknown, index: number): ImportConfigAgent {
  if (!raw || typeof raw !== 'object') throw new Error(`Import agent at index ${index} must be an object.`);
  const record = raw as Record<string, unknown>;
  const name = stringField(record, 'name');
  const role = parseRole(stringField(record, 'role'));
  const adapterType = parseAdapter(stringField(record, 'adapterType'));
  return {
    name,
    role,
    adapterType,
    description: optionalStringField(record, 'description'),
    instructions: optionalStringField(record, 'instructions'),
    capabilityTags: Array.isArray(record.capabilityTags) ? record.capabilityTags.filter((value): value is string => typeof value === 'string') : [],
    runtimeModel: optionalStringField(record, 'runtimeModel'),
    reportsTo: optionalStringField(record, 'reportsTo'),
    monthlyBudgetCents: typeof record.monthlyBudgetCents === 'number' ? record.monthlyBudgetCents : null,
    colorHex: optionalStringField(record, 'colorHex'),
    avatarGlyph: optionalStringField(record, 'avatarGlyph'),
    config: typeof record.config === 'object' && record.config !== null ? record.config as Record<string, unknown> : {},
  };
}

function normalizeImportChannel(raw: unknown, index: number): ImportConfigChannel {
  if (!raw || typeof raw !== 'object') throw new Error(`Import channel at index ${index} must be an object.`);
  const record = raw as Record<string, unknown>;
  const kindValue = optionalStringField(record, 'kind') ?? optionalStringField(record, 'type');
  const kind = kindValue === 'telegram' || kindValue === 'discord' ? kindValue : null;
  if (!kind) throw new Error(`Import channel at index ${index} must declare kind or type as telegram or discord.`);

  return {
    kind,
    agentName: stringField(record, 'agentName'),
    name: optionalStringField(record, 'name') ?? undefined,
    token: stringField(record, 'token'),
    defaultChatId: optionalStringField(record, 'defaultChatId') ?? optionalStringField(record, 'chatId') ?? undefined,
  };
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(`Missing required string field ${key}.`);
}

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

async function ensureHealthy(baseUrl: string): Promise<void> {
  const response = await fetch(buildUrl(baseUrl, '/healthz'));
  if (!response.ok) throw new Error(`Agentis health check failed with status ${response.status}.`);
}

async function resolveWorkspaceId(baseUrl: string, apiKey: string, explicitWorkspaceId?: string): Promise<string> {
  if (explicitWorkspaceId) return explicitWorkspaceId;
  const response = await requestJson<{ workspaces: WorkspaceSummary[] }>(baseUrl, '/v1/workspaces', { apiKey });
  const workspace = response.workspaces[0];
  if (!workspace) throw new Error('No workspace available for this token. Create one in the dashboard first or pass --workspace-id.');
  return workspace.id;
}

async function fetchExistingOrchestrator(baseUrl: string, apiKey: string, workspaceId: string, ambientId?: string): Promise<ExistingAgent | null> {
  const response = await requestJson<{ agents: ExistingAgent[] }>(baseUrl, '/v1/agents?role=orchestrator', {
    apiKey,
    workspaceId,
    ambientId,
  });
  return response.agents[0] ?? null;
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  options: {
    method?: 'GET' | 'POST';
    apiKey?: string;
    workspaceId?: string;
    ambientId?: string;
    body?: unknown;
  },
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
  if (options.workspaceId) headers['x-agentis-workspace'] = options.workspaceId;
  if (options.ambientId) headers['x-agentis-ambient'] = options.ambientId;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(buildUrl(baseUrl, path), {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const data = text ? tryParseJson(text) : undefined;
  if (!response.ok) {
    throw new Error(errorMessageFromResponse(data, text, response.status));
  }
  return data as T;
}

function buildUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

function invocationCwd(): string {
  return process.env.INIT_CWD ? resolve(process.env.INIT_CWD) : process.cwd();
}

function resolveFromInvocation(path: string): string {
  return resolve(invocationCwd(), path);
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function errorMessageFromResponse(data: unknown, fallbackText: string, status: number): string {
  if (data && typeof data === 'object') {
    const errorRecord = (data as { error?: { message?: string } }).error;
    if (errorRecord?.message) return errorRecord.message;
  }
  return fallbackText.trim() || `Request failed with status ${status}.`;
}

function writeJson(value: unknown, stderr = false): void {
  const stream = stderr ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}
