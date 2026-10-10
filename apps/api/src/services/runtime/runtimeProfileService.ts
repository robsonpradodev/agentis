import { createHash, randomUUID } from 'node:crypto';
import { assertProtectedInstructions, instructionProtection } from '../agent/agentInstructionProtection.js';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { and, eq } from 'drizzle-orm';
import type {
  AdapterCapabilities,
  AdapterType,
  RuntimeDescriptor,
  RuntimeResourceContent,
  RuntimeResourceDescriptor,
  RuntimeResourceWriteResult,
  RuntimeValue,
  RuntimeValueSource,
  RuntimeProfile,
} from '@agentis/core';
import { AgentisError } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AdapterManager } from '../../adapters/AdapterManager.js';
import type { Logger } from '../../logger.js';

const MAX_RESOURCE_BYTES = 512 * 1024;
const MAX_DISCOVERED_FILES = 240;
const RESOURCE_CACHE_TTL_MS = 5_000;

type AgentRow = typeof schema.agents.$inferSelect;

export class RuntimeProfileService {
  readonly #resourceCache = new Map<string, {
    expiresAt: number;
    resources: RuntimeResourceDescriptor[];
  }>();

  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly adapters: AdapterManager,
    private readonly logger: Logger,
  ) {}

  async describe(agent: AgentRow): Promise<RuntimeDescriptor> {
    const registration = this.adapters.get(agent.id);
    const adapter = registration?.adapter;
    const observedAt = new Date().toISOString();
    const capabilities = adapter?.capabilities?.() ?? unavailableCapabilities();
    const health = adapter
      ? await this.adapters.healthCheck(agent.id) ?? unhealthy('Runtime health is unavailable.')
      : unhealthy('Runtime adapter is not connected.');
    const context = adapter?.getRuntimeContext
      ? await adapter.getRuntimeContext().catch((error) => {
        this.logger.warn('runtime.context_failed', { agentId: agent.id, err: (error as Error).message });
        return null;
      })
      : null;
    const resources = this.listResources(agent);
    const config = record(agent.config);
    const runtimeProfile = effectiveRuntimeProfile(config);
    const adapterType = agent.adapterType as AdapterType;
    const home = runtimeHome(adapterType, config);
    const configuredModel = firstString(agent.runtimeModel, config.model);
    const detectedModel = detectProfileModel(adapterType, home);
    const currentModel = configuredModel
      ? runtimeValue(configuredModel, 'agent_config', observedAt, true)
      : detectedModel
        ? runtimeValue(detectedModel, 'profile', observedAt, true)
        : context?.currentModel && context.currentModel !== 'unknown'
          ? runtimeValue(
            context.currentModel,
            context.currentModelSource ?? 'runtime',
            observedAt,
            context.currentModelVerified ?? false,
          )
          : null;
    const models = (context?.models ?? []).map((model) => ({
      ...model,
      source: model.source ?? ('runtime' as RuntimeValueSource),
      verified: model.verified ?? false,
    }));
    if (currentModel && !models.some((model) => model.id === currentModel.value)) {
      models.unshift({
        id: currentModel.value,
        label: currentModel.value,
        recommended: true,
        source: currentModel.source,
        verified: currentModel.verified,
      });
    }
    const driverState = adapter?.describeRuntime
      ? await adapter.describeRuntime().catch(() => null)
      : null;

    const binary = firstString(config.binaryPath, config.command) ?? defaultBinary(adapterType);
    const cwd = runtimeProfile.projectRoot
      ?? firstString(config.cwd, config.workingDirectory, config.repositoryPath)
      ?? home
      ?? process.cwd();
    const browserEnabled = runtimeProfile.browser === 'enabled'
      || (runtimeProfile.browser === 'inherit' && config.browser === true);
    const capabilityWarnings = [
      ...(!health.isHealthy ? [health.error ?? 'Runtime health check failed.'] : []),
      ...(runtimeProfile.mode === 'containerized' ? ['Containerized harness supervision is not configured for this adapter.'] : []),
      ...(browserEnabled && capabilities.affordances?.browser !== true ? ['Browser was requested but is not advertised by the connected runtime.'] : []),
    ];

    return {
      adapterType,
      displayName: runtimeDisplayName(adapterType),
      version: driverState?.version ?? null,
      binary: runtimeValue(
        firstString(config.binaryPath, config.command) ?? defaultBinary(adapterType),
        firstString(config.binaryPath, config.command) ? 'agent_config' : 'fallback',
        observedAt,
        Boolean(registration),
      ),
      home: home ? runtimeValue(home, 'profile', observedAt, existsSync(home)) : null,
      profile: runtimeValue(
        firstString(config.profile, config.profileName) ?? 'default',
        firstString(config.profile, config.profileName) ? 'agent_config' : 'profile',
        observedAt,
        true,
      ),
      provider: context?.provider
        ? runtimeValue(context.provider, 'runtime', observedAt, Boolean(registration))
        : null,
      currentModel,
      models,
      health,
      capabilities,
      process: driverState?.process ?? {
        warm: false,
        activeSessions: adapter?.listRuntimeSessions
          ? (await adapter.listRuntimeSessions().catch(() => [])).length
          : 0,
      },
      resourceCount: resources.length,
      probedAt: observedAt,
      limitations: capabilities.limitations,
      runtimeProfile,
      executionEnvelope: {
        envelopeVersion: 1,
        observedAt,
        agentId: agent.id,
        adapterType,
        runtimeProfile,
        binary,
        cliVersion: driverState?.version?.value ?? null,
        cwd,
        model: currentModel?.value ?? null,
        reasoningEffort: firstString(config.modelReasoningEffort),
        serviceTier: config.fastMode === true ? 'fast' : null,
        browserEnabled,
        permissionProfile: runtimeProfile.permissionProfile,
        loadedSources: [
          ...(runtimeProfile.inheritUserConfig ? ['user' as const] : []),
          ...(runtimeProfile.inheritProjectInstructions ? ['project' as const] : []),
          'agentis' as const,
        ],
        mcpServerCount: capabilities.affordances?.nativeMcp ? 1 : 0,
        capabilityWarnings,
      },
    };
  }

  /** Persist the immutable, non-secret launch facts used for a concrete turn. */
  async captureExecution(
    workspaceId: string,
    agentId: string,
    refs: { runId?: string | null; conversationId?: string | null } = {},
  ): Promise<RuntimeDescriptor> {
    const agent = this.loadAgent(workspaceId, agentId);
    const descriptor = await this.describe(agent);
    if (!descriptor.executionEnvelope) return descriptor;
    this.db.insert(schema.agentExecutionEnvelopes).values({
      id: randomUUID(),
      workspaceId,
      agentId,
      runId: refs.runId ?? null,
      conversationId: refs.conversationId ?? null,
      envelope: descriptor.executionEnvelope,
      observedAt: descriptor.executionEnvelope.observedAt,
    }).run();
    return descriptor;
  }

  listResources(agent: AgentRow, force = false): RuntimeResourceDescriptor[] {
    const config = record(agent.config);
    const adapterType = agent.adapterType as AdapterType;
    const home = runtimeHome(adapterType, config);
    const cwd = firstString(config.cwd, config.workingDirectory, config.repositoryPath);
    const cacheKey = resourceCacheKey(agent, home, cwd);
    const cached = this.#resourceCache.get(cacheKey);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.resources;

    const resources: RuntimeResourceDescriptor[] = [
      {
        id: 'agentis:overlay',
        name: 'agentis.md',
        description: 'Agentis identity, role, and organizational overlay.',
        kind: 'generated_overlay',
        scope: 'agent',
        origin: 'agentis',
        editable: true,
        sensitive: false,
        format: 'markdown',
        loadPolicy: 'turn',
        reloadPolicy: 'automatic',
        checksum: checksum(agent.instructions ?? ''),
        sizeBytes: Buffer.byteLength(agent.instructions ?? '', 'utf8'),
        updatedAt: agent.updatedAt,
        effective: Boolean(agent.instructions?.trim()),
      },
    ];
    const add = (descriptor: RuntimeResourceDescriptor) => {
      if (!resources.some((resource) => resource.id === descriptor.id)) resources.push(descriptor);
    };

    if (home) {
      for (const resource of discoverHomeResources(adapterType, home)) add(resource);
    }
    if (cwd) {
      for (const resource of discoverProjectResources(adapterType, cwd)) add(resource);
    }
    this.#resourceCache.set(cacheKey, {
      expiresAt: Date.now() + RESOURCE_CACHE_TTL_MS,
      resources,
    });
    return resources;
  }

  readResource(agent: AgentRow, id: string): RuntimeResourceContent {
    const descriptor = this.requireResource(agent, id);
    if (id === 'agentis:overlay') {
      return { resource: descriptor, content: agent.instructions ?? '' };
    }
    if (descriptor.sensitive) {
      return { resource: descriptor, content: '[redacted]' };
    }
    if (!descriptor.path || descriptor.format === 'directory' || descriptor.format === 'database') {
      return { resource: descriptor, content: '' };
    }
    if (!existsSync(descriptor.path)) return { resource: descriptor, content: '' };
    return { resource: descriptor, content: readFileSync(descriptor.path, 'utf8') };
  }

  writeResource(
    agent: AgentRow,
    id: string,
    content: string,
    expectedChecksum?: string,
  ): RuntimeResourceWriteResult {
    const descriptor = this.requireResource(agent, id, true);
    if (!descriptor.editable || descriptor.sensitive) {
      throw new AgentisError('VALIDATION_FAILED', 'This runtime resource is read-only.');
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_RESOURCE_BYTES) {
      throw new AgentisError('VALIDATION_FAILED', 'Runtime resource exceeds the 512KB editor limit.');
    }
    if (expectedChecksum && descriptor.checksum && expectedChecksum !== descriptor.checksum) {
      throw new AgentisError(
        'RESOURCE_CONFLICT',
        'This resource changed outside Agentis. Refresh before saving to avoid overwriting it.',
      );
    }
    const now = new Date().toISOString();
    if (id === 'agentis:overlay') {
      const latest = this.loadAgent(agent.workspaceId, agent.id);
      assertProtectedInstructions(latest, content);
      if (latest.instructions !== agent.instructions) throw new AgentisError('RESOURCE_CONFLICT', 'Instructions changed; reload the runtime resource before saving.');
      this.db
        .update(schema.agents)
        .set({ instructions: content, updatedAt: now })
        .where(and(eq(schema.agents.id, agent.id), eq(schema.agents.workspaceId, agent.workspaceId)))
        .run();
      this.invalidateResources(agent.id);
      const updated = { ...descriptor, checksum: checksum(content), sizeBytes: Buffer.byteLength(content), updatedAt: now };
      return { resource: updated, content };
    }
    if (descriptor.kind === 'instructions' && instructionProtection(agent.config)) throw new AgentisError('AUTH_FORBIDDEN', 'Edit protected platform instructions instead of a separate harness instruction file.');
    if (!descriptor.path) throw new AgentisError('VALIDATION_FAILED', 'Runtime resource has no writable path.');
    mkdirSync(path.dirname(descriptor.path), { recursive: true });
    const temporary = `${descriptor.path}.agentis-${process.pid}.tmp`;
    writeFileSync(temporary, content, 'utf8');
    renameSync(temporary, descriptor.path);
    this.invalidateResources(agent.id);
    const stats = statSync(descriptor.path);
    return {
      resource: {
        ...descriptor,
        checksum: checksum(content),
        sizeBytes: stats.size,
        updatedAt: stats.mtime.toISOString(),
        effective: true,
      },
      content,
    };
  }

  loadAgent(workspaceId: string, agentId: string): AgentRow {
    const agent = this.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.id, agentId), eq(schema.agents.workspaceId, workspaceId)))
      .get();
    if (!agent) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    return agent;
  }

  private requireResource(agent: AgentRow, id: string, force = false): RuntimeResourceDescriptor {
    const resource = this.listResources(agent, force).find((candidate) => candidate.id === id);
    if (!resource) throw new AgentisError('RESOURCE_NOT_FOUND', 'runtime resource not found');
    return resource;
  }

  private invalidateResources(agentId: string): void {
    for (const key of this.#resourceCache.keys()) {
      if (key.startsWith(`${agentId}:`)) this.#resourceCache.delete(key);
    }
  }
}

function effectiveRuntimeProfile(config: Record<string, unknown>): RuntimeProfile {
  const raw = record(config.runtimeProfile);
  const mode = raw.mode === 'hermetic' || raw.mode === 'containerized' ? raw.mode : 'native';
  const permissionProfile = raw.permissionProfile === 'read_only'
    || raw.permissionProfile === 'workspace_write'
    || raw.permissionProfile === 'externally_sandboxed'
    ? raw.permissionProfile
    : 'trusted_local';
  return {
    version: 2,
    mode,
    ...(firstString(raw.projectRoot, config.cwd) ? { projectRoot: firstString(raw.projectRoot, config.cwd)! } : {}),
    ...(firstString(raw.profileName, config.profile, config.profileName) ? { profileName: firstString(raw.profileName, config.profile, config.profileName)! } : {}),
    permissionProfile,
    inheritUserConfig: mode === 'native' && raw.inheritUserConfig !== false,
    inheritProjectInstructions: mode === 'native' && raw.inheritProjectInstructions !== false,
    inheritPlugins: mode === 'native' && raw.inheritPlugins !== false,
    inheritSkills: mode === 'native' && raw.inheritSkills !== false,
    browser: raw.browser === 'enabled' || raw.browser === 'disabled' ? raw.browser : 'inherit',
    sessionPolicy: raw.sessionPolicy === 'ephemeral' ? 'ephemeral' : 'persistent',
  };
}

function resourceCacheKey(agent: AgentRow, home: string | null, cwd: string | null): string {
  return [
    agent.id,
    agent.updatedAt,
    checksum(JSON.stringify(agent.config ?? {})),
    checksum(agent.instructions ?? ''),
    home ?? '',
    cwd ?? '',
  ].join(':');
}

function discoverHomeResources(adapterType: AdapterType, home: string): RuntimeResourceDescriptor[] {
  const resources: RuntimeResourceDescriptor[] = [];
  if (adapterType === 'hermes_agent') {
    addFile(resources, path.join(home, 'SOUL.md'), {
      kind: 'identity', scope: 'profile', description: 'Hermes personality and identity.', primary: true,
    });
    addFile(resources, path.join(home, 'config.yaml'), {
      kind: 'config', scope: 'profile', description: 'Hermes profile configuration.', editable: false,
      loadPolicy: 'startup', reloadPolicy: 'restart_required',
    });
    addSecretReference(resources, path.join(home, '.env'), 'Hermes environment credentials');
    addSecretReference(resources, path.join(home, 'auth.json'), 'Hermes authentication state');
    addFile(resources, path.join(home, 'context_length_cache.yaml'), {
      kind: 'config', scope: 'profile', description: 'Hermes observed model context limits.',
      editable: false, loadPolicy: 'startup',
    });
    addFile(resources, path.join(home, 'channel_directory.json'), {
      kind: 'tool_config', scope: 'profile', description: 'Hermes channel directory.',
      editable: false, loadPolicy: 'startup',
    });
    addFile(resources, path.join(home, 'gateway_state.json'), {
      kind: 'config', scope: 'profile', description: 'Hermes gateway runtime state.',
      editable: false, loadPolicy: 'on_demand',
    });
    addMarkdownTree(resources, path.join(home, 'memories'), 'memory', 'profile');
    addSkillTree(resources, path.join(home, 'skills'), 'profile');
    addDirectory(resources, path.join(home, 'plugins'), 'plugin', 'profile', 'Hermes plugins');
    addDirectory(resources, path.join(home, 'hooks'), 'plugin', 'profile', 'Hermes lifecycle hooks');
    addDirectory(resources, path.join(home, 'cron'), 'tool_config', 'profile', 'Hermes scheduled jobs');
    addDirectory(resources, path.join(home, 'shared'), 'memory', 'profile', 'Hermes shared runtime context');
    addDirectory(resources, path.join(home, 'sessions'), 'session', 'profile', 'Hermes persisted sessions');
    addDatabase(resources, path.join(home, 'state.db'), 'session', 'Hermes canonical session database');
    addDatabase(resources, path.join(home, 'kanban.db'), 'memory', 'Hermes kanban and task state');
  } else if (adapterType === 'codex') {
    addFile(resources, path.join(home, 'AGENTS.md'), {
      kind: 'instructions', scope: 'profile', description: 'Codex home instructions.', primary: true,
    });
    addFile(resources, path.join(home, 'config.toml'), {
      kind: 'config', scope: 'profile', description: 'Codex profile configuration.', editable: false,
      loadPolicy: 'startup', reloadPolicy: 'restart_required',
    });
    addSecretReference(resources, path.join(home, 'auth.json'), 'Codex authentication state');
    addFile(resources, path.join(home, 'models_cache.json'), {
      kind: 'config', scope: 'profile', description: 'Codex runtime-reported model catalog.',
      editable: false, loadPolicy: 'on_demand',
    });
    addFile(resources, path.join(home, 'browser', 'config.toml'), {
      kind: 'tool_config', scope: 'profile', description: 'Codex browser runtime configuration.',
      editable: false, loadPolicy: 'startup', reloadPolicy: 'restart_required',
    });
    addSkillTree(resources, path.join(home, 'skills'), 'profile');
    addMarkdownTree(resources, path.join(home, 'rules'), 'instructions', 'profile');
    addDirectory(resources, path.join(home, 'plugins'), 'plugin', 'profile', 'Installed Codex plugins');
    addDirectory(resources, path.join(home, 'memories'), 'memory', 'profile', 'Codex persisted memories');
    addDirectory(resources, path.join(home, 'sessions'), 'session', 'profile', 'Codex persisted sessions');
    addDirectory(resources, path.join(home, 'archived_sessions'), 'session', 'profile', 'Archived Codex sessions');
  } else if (adapterType === 'claude_code') {
    addFile(resources, path.join(home, 'CLAUDE.md'), {
      kind: 'instructions', scope: 'profile', description: 'Claude Code home instructions.', primary: true,
    });
    addFile(resources, path.join(home, 'settings.json'), {
      kind: 'config', scope: 'profile', description: 'Claude Code settings.', editable: false,
      loadPolicy: 'startup', reloadPolicy: 'restart_required',
    });
    addSecretReference(resources, path.join(home, '.credentials.json'), 'Claude Code authentication state');
    addFile(resources, path.join(home, '.mcp.json'), {
      kind: 'tool_config', scope: 'profile', description: 'Claude Code MCP server configuration.',
      loadPolicy: 'startup', reloadPolicy: 'restart_required',
    });
    addSkillTree(resources, path.join(home, 'skills'), 'profile');
    addMarkdownTree(resources, path.join(home, 'plans'), 'memory', 'profile');
    addDirectory(resources, path.join(home, 'plugins'), 'plugin', 'profile', 'Claude Code plugins');
    addDirectory(resources, path.join(home, 'projects'), 'session', 'profile', 'Claude Code project sessions');
    addDirectory(resources, path.join(home, 'tasks'), 'session', 'profile', 'Claude Code task state');
  } else if (adapterType === 'cursor') {
    addMarkdownTree(resources, path.join(home, 'rules'), 'instructions', 'profile');
  } else if (adapterType === 'antigravity') {
    addFile(resources, path.join(home, 'GEMINI.md'), {
      kind: 'instructions', scope: 'profile', description: 'Antigravity CLI home instructions.', primary: true,
    });
    addFile(resources, path.join(home, 'AGENTS.md'), {
      kind: 'instructions', scope: 'profile', description: 'Antigravity CLI shared agent instructions.',
    });
    addFile(resources, path.join(home, 'settings.json'), {
      kind: 'config', scope: 'profile', description: 'Antigravity CLI settings.', editable: false,
      loadPolicy: 'startup', reloadPolicy: 'restart_required',
    });
    addSecretReference(resources, path.join(home, 'oauth_creds.json'), 'Antigravity CLI Google sign-in state');
    addSkillTree(resources, path.join(home, 'skills'), 'profile');
  } else if (adapterType === 'openclaw') {
    addFile(resources, path.join(home, 'AGENTS.md'), {
      kind: 'instructions', scope: 'profile', description: 'OpenClaw profile instructions.', primary: true,
    });
    addFile(resources, path.join(home, 'config.json'), {
      kind: 'config', scope: 'profile', description: 'OpenClaw profile configuration.', editable: false,
      loadPolicy: 'startup', reloadPolicy: 'restart_required',
    });
    addMarkdownTree(resources, path.join(home, 'memory'), 'memory', 'profile');
    addSkillTree(resources, path.join(home, 'skills'), 'profile');
  }
  return nameResourcesRelativeTo(resources, home);
}

function discoverProjectResources(adapterType: AdapterType, cwd: string): RuntimeResourceDescriptor[] {
  const resources: RuntimeResourceDescriptor[] = [];
  if (adapterType === 'claude_code') {
    addFile(resources, path.join(cwd, 'CLAUDE.md'), {
      kind: 'instructions', scope: 'project', description: 'Project Claude instructions.',
    });
  }
  if (adapterType === 'codex' || adapterType === 'hermes_agent') {
    addFile(resources, path.join(cwd, 'AGENTS.md'), {
      kind: 'instructions', scope: 'project', description: 'Project agent instructions.',
    });
  }
  if (adapterType === 'antigravity') {
    addFile(resources, path.join(cwd, 'GEMINI.md'), {
      kind: 'instructions', scope: 'project', description: 'Project Antigravity instructions.',
    });
    addFile(resources, path.join(cwd, 'AGENTS.md'), {
      kind: 'instructions', scope: 'project', description: 'Project agent instructions.',
    });
  }
  if (adapterType === 'cursor') {
    addFile(resources, path.join(cwd, '.cursorrules'), {
      kind: 'instructions', scope: 'project', description: 'Legacy Cursor project rules.',
    });
    addMarkdownTree(resources, path.join(cwd, '.cursor', 'rules'), 'instructions', 'project');
  }
  return nameResourcesRelativeTo(resources, cwd);
}

function nameResourcesRelativeTo(
  resources: RuntimeResourceDescriptor[],
  root: string,
): RuntimeResourceDescriptor[] {
  const resolvedRoot = path.resolve(root);
  return resources.map((resource) => {
    if (!resource.path) return resource;
    const relative = path.relative(resolvedRoot, path.resolve(resource.path));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return resource;
    return { ...resource, name: relative.split(path.sep).join('/') };
  });
}

function addFile(
  resources: RuntimeResourceDescriptor[],
  filePath: string,
  options: {
    kind: RuntimeResourceDescriptor['kind'];
    scope: RuntimeResourceDescriptor['scope'];
    description: string;
    editable?: boolean;
    primary?: boolean;
    loadPolicy?: RuntimeResourceDescriptor['loadPolicy'];
    reloadPolicy?: RuntimeResourceDescriptor['reloadPolicy'];
  },
): void {
  const exists = existsSync(filePath);
  if (!exists && !options.primary) return;
  const stats = exists ? statSync(filePath) : null;
  if (stats && !stats.isFile()) return;
  const content = exists && (stats?.size ?? 0) <= MAX_RESOURCE_BYTES
    ? readFileSync(filePath, 'utf8')
    : '';
  resources.push({
    id: fileResourceId(filePath),
    name: displayPath(filePath),
    description: options.description,
    kind: options.kind,
    path: path.resolve(filePath),
    scope: options.scope,
    origin: 'user',
    editable: options.editable ?? true,
    sensitive: false,
    format: formatFor(filePath),
    loadPolicy: options.loadPolicy ?? 'turn',
    reloadPolicy: options.reloadPolicy ?? 'automatic',
    checksum: checksum(content),
    updatedAt: stats?.mtime.toISOString(),
    sizeBytes: stats?.size ?? 0,
    effective: exists,
  });
}

function addMarkdownTree(
  resources: RuntimeResourceDescriptor[],
  root: string,
  kind: RuntimeResourceDescriptor['kind'],
  scope: RuntimeResourceDescriptor['scope'],
): void {
  if (!existsSync(root)) return;
  for (const filePath of walkFiles(root, (name) => /\.(md|mdc|txt)$/i.test(name))) {
    addFile(resources, filePath, { kind, scope, description: `${runtimeKindLabel(kind)} resource.` });
  }
}

function addSkillTree(
  resources: RuntimeResourceDescriptor[],
  root: string,
  scope: RuntimeResourceDescriptor['scope'],
): void {
  if (!existsSync(root)) return;
  for (const filePath of walkFiles(root, (name) => /^SKILL\.md$/i.test(name))) {
    addFile(resources, filePath, {
      kind: 'skill',
      scope,
      description: 'Runtime-native skill instructions.',
      editable: true,
    });
  }
}

function addDirectory(
  resources: RuntimeResourceDescriptor[],
  directory: string,
  kind: RuntimeResourceDescriptor['kind'],
  scope: RuntimeResourceDescriptor['scope'],
  description: string,
): void {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return;
  resources.push({
    id: fileResourceId(directory),
    name: displayPath(directory),
    description,
    kind,
    path: path.resolve(directory),
    scope,
    origin: 'user',
    editable: false,
    sensitive: false,
    format: 'directory',
    loadPolicy: 'on_demand',
    reloadPolicy: 'automatic',
    updatedAt: statSync(directory).mtime.toISOString(),
    effective: true,
  });
}

function addDatabase(
  resources: RuntimeResourceDescriptor[],
  filePath: string,
  kind: RuntimeResourceDescriptor['kind'],
  description: string,
): void {
  if (!existsSync(filePath)) return;
  const stats = statSync(filePath);
  resources.push({
    id: fileResourceId(filePath),
    name: displayPath(filePath),
    description,
    kind,
    path: path.resolve(filePath),
    scope: 'profile',
    origin: 'runtime',
    editable: false,
    sensitive: true,
    format: 'database',
    loadPolicy: 'on_demand',
    reloadPolicy: 'automatic',
    updatedAt: stats.mtime.toISOString(),
    sizeBytes: stats.size,
    effective: true,
  });
}

function addSecretReference(
  resources: RuntimeResourceDescriptor[],
  filePath: string,
  description: string,
): void {
  if (!existsSync(filePath)) return;
  const stats = statSync(filePath);
  resources.push({
    id: fileResourceId(filePath),
    name: displayPath(filePath),
    description,
    kind: 'secret_reference',
    path: path.resolve(filePath),
    scope: 'profile',
    origin: 'user',
    editable: false,
    sensitive: true,
    format: 'opaque',
    loadPolicy: 'startup',
    reloadPolicy: 'restart_required',
    updatedAt: stats.mtime.toISOString(),
    sizeBytes: stats.size,
    effective: true,
  });
}

function walkFiles(root: string, include: (name: string) => boolean): string[] {
  const found: string[] = [];
  const visit = (directory: string, depth: number) => {
    if (depth > 5 || found.length >= MAX_DISCOVERED_FILES) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_DISCOVERED_FILES) break;
      if (entry.name.startsWith('.') && entry.name !== '.cursor') continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate, depth + 1);
      else if (entry.isFile() && include(entry.name)) found.push(candidate);
    }
  };
  visit(root, 0);
  return found.sort();
}

function runtimeHome(adapterType: AdapterType, config: Record<string, unknown>): string | null {
  const env = record(config.env);
  if (adapterType === 'hermes_agent') {
    return firstString(
      env.HERMES_HOME,
      process.env.HERMES_HOME,
      process.platform === 'win32' && process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'hermes')
        : null,
      path.join(os.homedir(), '.hermes'),
    );
  }
  if (adapterType === 'codex') {
    return firstString(env.CODEX_HOME, process.env.CODEX_HOME, path.join(os.homedir(), '.codex'));
  }
  if (adapterType === 'claude_code') {
    return firstString(
      env.CLAUDE_CONFIG_DIR,
      process.env.CLAUDE_CONFIG_DIR,
      path.join(os.homedir(), '.claude'),
    );
  }
  if (adapterType === 'cursor') return path.join(os.homedir(), '.cursor');
  if (adapterType === 'antigravity') {
    return firstString(env.ANTIGRAVITY_HOME, process.env.ANTIGRAVITY_HOME, path.join(os.homedir(), '.gemini', 'antigravity-cli'));
  }
  if (adapterType === 'openclaw') {
    return firstString(env.OPENCLAW_HOME, process.env.OPENCLAW_HOME, path.join(os.homedir(), '.openclaw'));
  }
  return null;
}

function detectProfileModel(adapterType: AdapterType, home: string | null): string | null {
  if (!home) return null;
  try {
    if (adapterType === 'hermes_agent') {
      const configPath = path.join(home, 'config.yaml');
      if (!existsSync(configPath)) return null;
      const parsed = parseYaml(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      const model = record(parsed.model);
      return firstString(model.default, parsed.default_model);
    }
    if (adapterType === 'claude_code') {
      const settingsPath = path.join(home, 'settings.json');
      if (!existsSync(settingsPath)) return null;
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      return firstString(parsed.model, parsed.defaultModel);
    }
    if (adapterType === 'codex') {
      const configPath = path.join(home, 'config.toml');
      if (!existsSync(configPath)) return null;
      const match = readFileSync(configPath, 'utf8').match(/^\s*model\s*=\s*["']([^"']+)["']/m);
      return match?.[1]?.trim() || null;
    }
    if (adapterType === 'antigravity') {
      for (const candidate of [path.join(home, 'config', 'config.json'), path.join(home, 'settings.json')]) {
        if (!existsSync(candidate)) continue;
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as Record<string, unknown>;
        const model = firstString(parsed.model, parsed.defaultModel);
        if (model) return model;
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

function runtimeValue<T>(
  value: T,
  source: RuntimeValueSource,
  observedAt: string,
  verified: boolean,
): RuntimeValue<T> {
  return { value, source, observedAt, verified };
}

function checksum(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function fileResourceId(filePath: string): string {
  return `file:${Buffer.from(path.resolve(filePath), 'utf8').toString('base64url')}`;
}

function displayPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const relative = path.relative(os.homedir(), resolved);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return path.join('~', relative);
  }
  return resolved;
}

function formatFor(filePath: string): RuntimeResourceDescriptor['format'] {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.md' || extension === '.mdc') return 'markdown';
  if (extension === '.yaml' || extension === '.yml') return 'yaml';
  if (extension === '.json') return 'json';
  if (extension === '.toml') return 'toml';
  return 'text';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function runtimeDisplayName(adapterType: AdapterType): string {
  if (adapterType === 'openrouter') return 'OpenRouter';
  if (adapterType === 'hermes_agent') return 'Hermes Agent';
  if (adapterType === 'claude_code') return 'Claude Code';
  if (adapterType === 'codex') return 'Codex';
  if (adapterType === 'cursor') return 'Cursor';
  if (adapterType === 'antigravity') return 'Antigravity CLI';
  if (adapterType === 'openclaw') return 'OpenClaw';
  if (adapterType === 'local_llm') return 'Local LLM';
  return 'HTTP Runtime';
}

function defaultBinary(adapterType: AdapterType): string {
  if (adapterType === 'hermes_agent') return 'hermes';
  if (adapterType === 'claude_code') return 'claude';
  if (adapterType === 'codex') return 'codex';
  if (adapterType === 'cursor') return 'agent';
  if (adapterType === 'antigravity') return 'agy';
  return adapterType;
}

function unavailableCapabilities(): AdapterCapabilities {
  return {
    interactiveChat: false,
    toolCalling: false,
    toolForwarding: 'none',
    limitations: ['The runtime adapter is not connected.'],
  };
}

function unhealthy(error: string) {
  return { isHealthy: false, error, checkedAt: new Date().toISOString() };
}

function runtimeKindLabel(kind: RuntimeResourceDescriptor['kind']): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1).replace(/_/g, ' ');
}
