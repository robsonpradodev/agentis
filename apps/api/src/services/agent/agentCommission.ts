import { randomUUID } from 'node:crypto';
import { preserveInstructionProtection } from './agentInstructionProtection.js';
import { mkdirSync } from 'node:fs';
import { and, eq, ne } from 'drizzle-orm';
import { AgentisError, CONSTANTS, REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { CredentialVault } from '../credentialVault.js';
import type { AdapterManager } from '../../adapters/AdapterManager.js';
import type { Logger } from '../../logger.js';
import type { EventBus } from '../../event-bus.js';
import { OpenClawAdapter } from '../../adapters/OpenClawAdapter.js';
import { HttpAdapter } from '../../adapters/HttpAdapter.js';
import { OpenRouterAdapter } from '../../adapters/OpenRouterAdapter.js';
import { openRouterCredential, OPENROUTER_TIMEOUT_MS, validateOpenRouterConfig } from '../runtime/openRouter.js';
import { runProviderTask } from '../runtime/providerTaskRunner.js';
import { ClaudeCodeAdapter } from '../../adapters/ClaudeCodeAdapter.js';
import { CodexAdapter } from '../../adapters/CodexAdapter.js';
import { CursorAdapter } from '../../adapters/CursorAdapter.js';
import { HermesAgentAdapter } from '../../adapters/HermesAgentAdapter.js';
import { AntigravityAdapter } from '../../adapters/AntigravityAdapter.js';
import { normalizeAntigravityModel } from '../../adapters/antigravityModels.js';
import { assertSafeUrl } from '../safeUrl.js';
import { joinUrl, testHarnessConfig, type V1HarnessAdapterType } from '../harness/harnessProbe.js';
import type { McpHarnessServer, McpHarnessSessionService } from '../mcp/mcpHarnessSession.js';
import { repairCliHarnessConfig } from '../harness/harnessConfigRepair.js';
import { RuntimeSessionStore } from '../runtime/runtimeSessionStore.js';
import { harnessAgentHomeDir } from '../harness/harnessAgentHome.js';
import type { SkillMaterializer } from '../skillMaterializer.js';
import type { RuntimeCapabilityDeclaration, RuntimeCapabilityId, RuntimeProfile } from '@agentis/core';

/** The orchestrator's identity color — distinct from the random palette used for managers/specialists. */
export const ORCHESTRATOR_DEFAULT_COLOR = '#3b82f6';

export interface RegisterAdapterOptions {
  skipConfigRepair?: boolean;
  skipCliAvailabilityCheck?: boolean;
}

export interface AgentCommissionDeps {
  db: AgentisSqliteDb;
  vault: CredentialVault;
  adapters: AdapterManager;
  logger: Logger;
  bus?: EventBus;
  /**
   * Optional — when enabled, CLI harnesses (Codex / Claude Code) are registered
   * with the Agentis MCP server so they call platform tools natively (one
   * invocation, no marker re-spawn). (UNIVERSAL-HARNESS §5.)
   */
  mcpHarness?: McpHarnessSessionService;
  /**
   * Optional — when wired, an agent's Brain `skill` atoms are materialized to
   * `.claude/skills/` in its harness cwd so Claude Code loads them natively
   * (Living Skills). Without an explicit project cwd, the managed per-agent
   * home is used as the cwd.
   */
  skillMaterializer?: SkillMaterializer;
}

export interface CommissionAgentInput {
  workspaceId: string;
  userId: string;
  ambientId?: string | null;
  gatewayId?: string | null;
  name: string;
  description?: string | null;
  adapterType: V1HarnessAdapterType;
  capabilityTags?: string[];
  config?: Record<string, unknown>;
  instructions?: string | null;
  avatarGlyph?: string | null;
  avatarUrl?: string | null;
  runtimeModel?: string | null;
  role?: string | null;
  reportsTo?: string | null;
  isPaused?: boolean;
  monthlyBudgetCents?: number | null;
  canvasPosition?: { x: number; y: number } | null;
  colorHex?: string | null;
}

export interface CommissionAgentResult {
  id: string;
  name: string;
  adapterType: V1HarnessAdapterType;
  colorHex: string;
  agent: { id: string; name: string; adapterType: V1HarnessAdapterType; colorHex: string; role?: string | null; reportsTo?: string | null };
}

export async function commissionAgent(deps: AgentCommissionDeps, input: CommissionAgentInput): Promise<CommissionAgentResult> {
  ensureSingleOrchestrator(deps.db, input.workspaceId, input.role ?? null);
  if (input.reportsTo) ensureReportsToTarget(deps.db, input.workspaceId, input.reportsTo);

  const id = randomUUID();
  const colorHex = input.colorHex
    ?? (input.role === 'orchestrator'
      ? ORCHESTRATOR_DEFAULT_COLOR
      : CONSTANTS.AGENT_COLOR_PALETTE[Math.floor(Math.random() * CONSTANTS.AGENT_COLOR_PALETTE.length)])
    ?? '#6366f1';
  const repaired = await repairCliHarnessConfig(input.adapterType, input.config ?? {});
  const config = repaired.config;
  if (input.adapterType === 'openrouter') await validateOpenRouterConfig(deps.db, deps.vault, input.workspaceId, config);
  const isPaused = input.isPaused ?? false;
  const insertedStatus = isPaused ? 'paused' : 'offline';

  deps.db
    .insert(schema.agents)
    .values({
      id,
      workspaceId: input.workspaceId,
      ambientId: input.ambientId ?? null,
      userId: input.userId,
      gatewayId: input.gatewayId ?? null,
      packageId: null,
      name: input.name,
      description: input.description ?? null,
      adapterType: input.adapterType,
      capabilityTags: input.capabilityTags ?? [],
      config,
      status: insertedStatus,
      colorHex,
      instructions: input.instructions ?? null,
      avatarGlyph: input.avatarGlyph ?? null,
      avatarUrl: input.avatarUrl ?? null,
      runtimeModel: input.runtimeModel ?? runtimeModelFromConfig(input.adapterType, config),
      role: input.role ?? null,
      reportsTo: input.reportsTo ?? null,
      isPaused,
      monthlyBudgetCents: input.monthlyBudgetCents ?? null,
      canvasPosition: input.canvasPosition ?? null,
    })
    .run();

  if (!isPaused) {
    try {
      await registerAdapter(deps, input.workspaceId, id, input.adapterType, config);
      deps.db
        .update(schema.agents)
        .set({ status: 'online', updatedAt: new Date().toISOString() })
        .where(eq(schema.agents.id, id))
        .run();
    } catch (err) {
      deps.logger.warn('agents.register_failed', { id, err: (err as Error).message });
      deps.db
        .update(schema.agents)
        .set({ status: 'error', updatedAt: new Date().toISOString() })
        .where(eq(schema.agents.id, id))
        .run();
    }
  }

  const agentPayload = {
    id,
    name: input.name,
    adapterType: input.adapterType,
    colorHex,
    role: input.role ?? null,
    reportsTo: input.reportsTo ?? null,
  };

  deps.bus?.publish(REALTIME_ROOMS.workspace(input.workspaceId), REALTIME_EVENTS.AGENT_CREATED, { agent: agentPayload });
  deps.bus?.publish(REALTIME_ROOMS.workspace(input.workspaceId), REALTIME_EVENTS.CANVAS_NODE_PLACED, {
    agentId: id,
    nodeLabel: input.name,
    role: input.role ?? null,
    reportsTo: input.reportsTo ?? null,
  });

  return {
    id,
    name: input.name,
    adapterType: input.adapterType,
    colorHex,
    agent: agentPayload,
  };
}

export function ensureSingleOrchestrator(db: AgentisSqliteDb, workspaceId: string, role: string | null | undefined, currentAgentId?: string) {
  if (role !== 'orchestrator') return;
  const predicates = [
    eq(schema.agents.workspaceId, workspaceId),
    eq(schema.agents.role, 'orchestrator'),
  ];
  if (currentAgentId) predicates.push(ne(schema.agents.id, currentAgentId));
  const existing = db
    .select({ id: schema.agents.id, name: schema.agents.name })
    .from(schema.agents)
    .where(and(...predicates))
    .get();
  if (!existing) return;
  throw new AgentisError('WORKSPACE_ORCHESTRATOR_EXISTS', `Workspace already has an orchestrator: ${existing.name}`, {
    details: { id: existing.id, name: existing.name },
  });
}

export function ensureReportsToTarget(db: AgentisSqliteDb, workspaceId: string, reportsTo: string, currentAgentId?: string) {
  if (reportsTo === currentAgentId) {
    throw new AgentisError('VALIDATION_FAILED', 'agent cannot report to itself');
  }
  const target = db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(eq(schema.agents.id, reportsTo), eq(schema.agents.workspaceId, workspaceId)))
    .get();
  if (!target) throw new AgentisError('RESOURCE_NOT_FOUND', `reportsTo agent ${reportsTo} not found`);
}

export async function registerAdapter(
  deps: AgentCommissionDeps,
  workspaceId: string,
  agentId: string,
  adapterType: V1HarnessAdapterType,
  config: Record<string, unknown>,
  options: RegisterAdapterOptions = {},
) {
  config = options.skipConfigRepair ? config : (await repairCliHarnessConfig(adapterType, config)).config;
  const runtimeProfile = runtimeProfileOf(config);
  await deps.adapters.unregister(agentId);
  if (adapterType === 'openclaw') {
    // Resolve an explicit gatewayUrl first, else fall back to the provisioned
    // gateway row this agent points at. Without the fallback an agent correctly
    // linked to a gateway (`gatewayId`) still failed with "requires gatewayUrl",
    // because only the inline config field was ever read.
    const gatewayUrl = String(config.gatewayUrl ?? '') || resolveGatewayUrlById(deps.db, workspaceId, stringOf(config.gatewayId));
    const credentialId = stringOf(config.deviceTokenCredentialId) ?? stringOf(config.authCredentialId);
    if (!gatewayUrl) {
      throw new AgentisError(
        'VALIDATION_FAILED',
        'OpenClaw needs a Gateway URL before this agent can run. Add one in the agent\'s runtime settings (or set AGENTIS_OPENCLAW_GATEWAY_URL).',
      );
    }
    await assertSafeGatewayUrl(gatewayUrl);
    const deviceToken = credentialId ? deps.vault.decrypt(loadCredential(deps.db, workspaceId, credentialId).encryptedValue) : stringOf(config.authToken);
    const adapter = new OpenClawAdapter({
      agentId,
      gatewayUrl,
      binaryPath: cliCommandFromConfig(config) ?? undefined,
      cwd: stringOf(config.cwd) ?? undefined,
      env: recordStringOf(config.env),
      model: stringOf(config.model) ?? undefined,
      deviceToken: deviceToken ?? undefined,
      headers: recordStringOf(config.headers),
      password: stringOf(config.password) ?? undefined,
      agentName: stringOf(config.agentName) ?? undefined,
      sessionKeyStrategy: sessionKeyStrategyOf(config.sessionKeyStrategy),
      sessionKey: stringOf(config.sessionKey) ?? undefined,
      disableDeviceAuth: booleanOf(config.disableDeviceAuth),
      timeoutSec: numberOf(config.timeoutSec),
      payloadTemplate: recordObjectOf(config.payloadTemplate),
      defaultSessionId: stringOf(config.defaultSessionId) ?? undefined,
      logger: deps.logger,
    });
    await adapter.connect();
    deps.adapters.register(agentId, adapter);
    return;
  }
  if (adapterType === 'openrouter') {
    const model = stringOf(config.model);
    if (!model) throw new AgentisError('VALIDATION_FAILED', 'Select an OpenRouter model.');
    const apiKey = openRouterCredential(deps.db, deps.vault, workspaceId, config.authCredentialId);
    const adapter = new OpenRouterAdapter({ agentId, apiKey, model,
      timeoutMs: numberOf(config.timeoutMs) ?? OPENROUTER_TIMEOUT_MS,
      runTask: (runtime, task, signal, progress) => runProviderTask(deps.db, workspaceId, agentId, runtime, task, signal, progress),
    });
    await adapter.connect();
    deps.adapters.register(agentId, adapter);
    return;
  }
  if (adapterType === 'http') {
    const dispatchUrl = httpUrlFromConfig(config, 'dispatchPath', 'dispatchUrl');
    if (!dispatchUrl) {
      throw new AgentisError('VALIDATION_FAILED', 'http requires baseUrl + dispatchPath or dispatchUrl');
    }
    const sharedSecretCredentialId = stringOf(config.sharedSecretCredentialId);
    const authCredentialId = stringOf(config.authCredentialId);
    const adapter = new HttpAdapter({
      agentId,
      dispatchUrl,
      cancelUrl: httpUrlFromConfig(config, 'cancelPath', 'cancelUrl') ?? undefined,
      healthUrl: httpUrlFromConfig(config, 'healthPath', 'healthUrl') ?? undefined,
      chatUrl: httpUrlFromConfig(config, 'chatPath', 'chatUrl') ?? undefined,
      supportsTools: booleanOf(config.supportsTools) === true,
      chatProtocol: stringOf(config.chatProtocol) === 'openai' ? 'openai' : 'agentis',
      capabilityManifest: runtimeCapabilityDeclarationsOf(config.capabilityManifest),
      model: stringOf(config.model) ?? undefined,
      method: httpMethodOf(config.method),
      headers: recordStringOf(config.headers),
      payloadTemplate: recordObjectOf(config.payloadTemplate),
      dispatchTimeoutMs: numberOf(config.dispatchTimeoutMs),
      chatTimeoutMs: numberOf(config.chatTimeoutMs),
      sharedSecret: sharedSecretCredentialId ? deps.vault.decrypt(loadCredential(deps.db, workspaceId, sharedSecretCredentialId).encryptedValue) : undefined,
      authToken: authCredentialId ? deps.vault.decrypt(loadCredential(deps.db, workspaceId, authCredentialId).encryptedValue) : undefined,
      logger: deps.logger,
    });
    await adapter.connect();
    deps.adapters.register(agentId, adapter);
    return;
  }
  if (adapterType === 'codex') {
    if (!options.skipCliAvailabilityCheck) await ensureCliHarnessAvailable(adapterType, config);
    const adapter = new CodexAdapter({
      agentId,
      workspaceId,
      sessionStore: new RuntimeSessionStore(deps.db),
      binaryPath: cliCommandFromConfig(config) ?? undefined,
      cwd: managedAgentCwd(agentId, config, runtimeProfile),
      model: stringOf(config.model) ?? undefined,
      maxTurns: nativeTurnCap(),
      modelReasoningEffort: reasoningEffortOf(config.modelReasoningEffort),
      fastMode: booleanOf(config.fastMode),
      dangerouslyBypassApprovalsAndSandbox: config.dangerouslyBypassApprovalsAndSandbox === undefined ? undefined : booleanOf(config.dangerouslyBypassApprovalsAndSandbox),
      extraArgs: stringArrayOf(config.extraArgs),
      env: recordStringOf(config.env),
      timeoutSec: numberOf(config.timeoutSec),
      browser: booleanOf(config.browser),
      runtimeProfile,
      ...(() => { const m = mcpServersFor(deps, workspaceId, agentId); return m ? { mcpServers: m } : {}; })(),
      logger: deps.logger,
    });
    await adapter.connect();
    deps.adapters.register(agentId, adapter);
    return;
  }
  if (adapterType === 'cursor') {
    if (!options.skipCliAvailabilityCheck) await ensureCliHarnessAvailable(adapterType, config);
    // No `mcpServers` here (unlike codex/hermes/claude_code): `cursor-agent` has
    // no inline MCP spawn-arg — it reads a `.cursor/mcp.json` file — so there is
    // no `harnessMcpArgs('cursor', …)` emitter yet. This harness reaches Agentis
    // tools via the marker protocol until a verified file-based emitter exists.
    const adapter = new CursorAdapter({
      agentId,
      workspaceId,
      sessionStore: new RuntimeSessionStore(deps.db),
      binaryPath: cliCommandFromConfig(config) ?? undefined,
      cwd: managedAgentCwd(agentId, config),
      model: stringOf(config.model) ?? undefined,
      extraArgs: stringArrayOf(config.extraArgs),
      env: recordStringOf(config.env),
      timeoutSec: numberOf(config.timeoutSec),
      logger: deps.logger,
    });
    await adapter.connect();
    deps.adapters.register(agentId, adapter);
    return;
  }
  if (adapterType === 'hermes_agent') {
    if (!options.skipCliAvailabilityCheck) await ensureCliHarnessAvailable(adapterType, config);
    const adapter = new HermesAgentAdapter({
      agentId,
      workspaceId,
      sessionStore: new RuntimeSessionStore(deps.db),
      binaryPath: cliCommandFromConfig(config) ?? undefined,
      cwd: managedAgentCwd(agentId, config),
      model: stringOf(config.model) ?? undefined,
      chatTransport: hermesChatTransportOf(config.chatTransport, config.chatTransportVersion),
      maxTurns: nativeTurnCap(),
      extraArgs: stringArrayOf(config.extraArgs),
      env: recordStringOf(config.env),
      timeoutSec: numberOf(config.timeoutSec),
      graceSec: numberOf(config.graceSec),
      instructions: agentInstructions(deps.db, agentId),
      ...(() => { const m = mcpServersFor(deps, workspaceId, agentId); return m ? { mcpServers: m } : {}; })(),
      logger: deps.logger,
    });
    await adapter.connect();
    deps.adapters.register(agentId, adapter);
    return;
  }
  if (adapterType === 'antigravity') {
    if (!options.skipCliAvailabilityCheck) await ensureCliHarnessAvailable(adapterType, config);
    // No `mcpServers` here (unlike codex/hermes/claude_code): `agy` has no inline
    // MCP spawn-arg override, so there is no `harnessMcpArgs('antigravity', …)`
    // emitter yet. This harness reaches Agentis tools via the marker protocol
    // until a verified emitter exists.
    const adapter = new AntigravityAdapter({
      agentId,
      workspaceId,
      sessionStore: new RuntimeSessionStore(deps.db),
      binaryPath: cliCommandFromConfig(config) ?? undefined,
      cwd: managedAgentCwd(agentId, config),
      model: stringOf(config.model) ?? undefined,
      yolo: booleanOf(config.yolo),
      extraArgs: stringArrayOf(config.extraArgs),
      env: recordStringOf(config.env),
      timeoutSec: numberOf(config.timeoutSec),
      logger: deps.logger,
    });
    await adapter.connect();
    deps.adapters.register(agentId, adapter);
    return;
  }
  if (!options.skipCliAvailabilityCheck) await ensureCliHarnessAvailable(adapterType, config);
  // Living Skills: materialize the agent's Brain skill atoms to `.claude/skills/`
  // so Claude Code loads them natively. Resolves the cwd (managed home when no
  // explicit project cwd is set); best-effort, never blocks registration.
  const resolvedCwd = deps.skillMaterializer
    ? deps.skillMaterializer.materializeForAgent(workspaceId, agentId, runtimeProfile.projectRoot ?? stringOf(config.cwd) ?? null).cwd
    : managedAgentCwd(agentId, config, runtimeProfile);
  const adapter = new ClaudeCodeAdapter({
    agentId,
    workspaceId,
    sessionStore: new RuntimeSessionStore(deps.db),
    binaryPath: cliCommandFromConfig(config) ?? undefined,
    cwd: resolvedCwd,
    model: stringOf(config.model) ?? undefined,
    maxTurns: nativeTurnCap(),
    allowedTools: stringArrayOf(config.allowedTools),
    dangerouslySkipPermissions: booleanOf(config.dangerouslySkipPermissions),
    runtimeProfile,
    extraArgs: stringArrayOf(config.extraArgs),
    env: recordStringOf(config.env),
    timeoutSec: numberOf(config.timeoutSec),
    ...(() => { const m = mcpServersFor(deps, workspaceId, agentId); return m ? { mcpServers: m } : {}; })(),
    logger: deps.logger,
  });
  await adapter.connect();
  deps.adapters.register(agentId, adapter);
}

/**
 * Working directory for a CLI harness agent. An explicit project cwd wins;
 * otherwise the agent runs in its Agentis-managed home under AGENTIS_DATA_DIR —
 * NEVER `process.cwd()` (the repo), which is how agents used to scatter
 * generated media into the source tree.
 */
function managedAgentCwd(agentId: string, config: Record<string, unknown>, profile = runtimeProfileOf(config)): string {
  const cwd = profile.projectRoot || stringOf(config.cwd) || harnessAgentHomeDir(agentId);
  try { mkdirSync(cwd, { recursive: true }); } catch { /* best-effort */ }
  return cwd;
}

async function ensureCliHarnessAvailable(adapterType: Extract<V1HarnessAdapterType, 'claude_code' | 'codex' | 'cursor' | 'hermes_agent' | 'antigravity'>, config: Record<string, unknown>) {
  const result = await testHarnessConfig(adapterType, config);
  if (result.status !== 'fail') return;
  const firstError = result.checks.find((check) => check.level === 'error') ?? result.checks[0];
  throw new AgentisError('VALIDATION_FAILED', firstError?.detail ? `${firstError.message} - ${firstError.detail}` : firstError?.message ?? 'Harness binary not found');
}

export function runtimeModelFromConfig(adapterType: V1HarnessAdapterType, config: Record<string, unknown>): string | null {
  if (adapterType === 'openclaw' || adapterType === 'http') return null;
  return stringOf(config.model);
}

export interface SwitchRuntimeInput {
  adapterType: V1HarnessAdapterType;
  config?: Record<string, unknown>;
  runtimeModel?: string | null;
}

export interface SwitchRuntimeResult {
  id: string;
  adapterType: V1HarnessAdapterType;
  runtimeModel: string | null;
  status: 'online' | 'paused' | 'error';
}

/**
 * Rebind an existing agent to a different runtime — WITHOUT touching its
 * identity, Brain, abilities, role or hierarchy (AGENT-TRANSITION §2, Track R).
 *
 * An Agentis agent is the durable, runtime-agnostic entity; `(adapterType,
 * config, runtimeModel)` is a swappable *binding*. This tears down the old
 * adapter registration and stands up the new one, persisting only the binding
 * columns. The agent's `scopeId = agentId` memory is runtime-independent, so it
 * carries over untouched.
 */
export async function switchRuntime(
  deps: AgentCommissionDeps,
  workspaceId: string,
  agentId: string,
  input: SwitchRuntimeInput,
): Promise<SwitchRuntimeResult> {
  const existing = deps.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.workspaceId, workspaceId)))
    .get();
  if (!existing) throw new AgentisError('RESOURCE_NOT_FOUND', `agent ${agentId} not found`);

  // Carry forward the prior config so a rebind that only changes the runtime
  // model (or stays on the same adapter) keeps the operator's settings. The
  // discovered/new config takes precedence per-key.
  const priorConfig = (existing.config ?? {}) as Record<string, unknown>;
  const sameAdapter = existing.adapterType === input.adapterType;
  const mergedConfig = preserveInstructionProtection(priorConfig, sameAdapter ? { ...priorConfig, ...(input.config ?? {}) } : { ...(input.config ?? {}) });
  if (input.adapterType === 'openrouter') await validateOpenRouterConfig(deps.db, deps.vault, workspaceId, mergedConfig);
  const repaired = await repairCliHarnessConfig(input.adapterType, mergedConfig);
  const rawModel = input.runtimeModel ?? runtimeModelFromConfig(input.adapterType, repaired.config) ?? null;
  const runtimeModel = input.adapterType === 'antigravity' ? normalizeAntigravityModel(rawModel) : rawModel;
  const config = input.adapterType === 'antigravity'
    ? { ...repaired.config, ...(runtimeModel ? { model: runtimeModel } : {}) }
    : repaired.config;
  const isPaused = Boolean(existing.isPaused);

  let status: SwitchRuntimeResult['status'] = isPaused ? 'paused' : 'online';
  // Persist the new binding first so a failed register still records the intent.
  deps.db
    .update(schema.agents)
    .set({ adapterType: input.adapterType, config, runtimeModel, updatedAt: new Date().toISOString() })
    .where(eq(schema.agents.id, agentId))
    .run();

  if (!isPaused) {
    try {
      await registerAdapter(deps, workspaceId, agentId, input.adapterType, config);
      deps.db
        .update(schema.agents)
        .set({ status: 'online', lastHeartbeatAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        .where(eq(schema.agents.id, agentId))
        .run();
    } catch (err) {
      deps.logger.warn('agents.switch_runtime_failed', { id: agentId, adapterType: input.adapterType, err: (err as Error).message });
      status = 'error';
      deps.db
        .update(schema.agents)
        .set({ status: 'error', updatedAt: new Date().toISOString() })
        .where(eq(schema.agents.id, agentId))
        .run();
    }
  } else {
    await deps.adapters.unregister(agentId);
  }

  deps.bus?.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.AGENT_UPDATED, {
    agentId,
    adapterType: input.adapterType,
    runtimeModel,
  });

  return { id: agentId, adapterType: input.adapterType, runtimeModel, status };
}

function httpUrlFromConfig(config: Record<string, unknown>, pathKey: string, urlKey: string): string | null {
  const direct = stringOf(config[urlKey]);
  if (direct) return direct;
  const baseUrl = stringOf(config.baseUrl);
  const path = stringOf(config[pathKey]);
  if (!baseUrl || !path) return null;
  return joinUrl(baseUrl, path);
}

/** The Agentis MCP server(s) a harness in this workspace should mount, or undefined. */
/** The agent's stored operating instructions, synced into its native AGENTS.md. */
function agentInstructions(db: AgentisSqliteDb, agentId: string): string | null {
  try {
    return db.select({ instructions: schema.agents.instructions })
      .from(schema.agents).where(eq(schema.agents.id, agentId)).get()?.instructions ?? null;
  } catch {
    return null;
  }
}

function mcpServersFor(deps: AgentCommissionDeps, workspaceId: string, agentId: string): McpHarnessServer[] | undefined {
  if (!deps.mcpHarness?.enabled) return undefined;
  const agent = deps.db.select({ userId: schema.agents.userId }).from(schema.agents).where(eq(schema.agents.id, agentId)).get();
  const server = deps.mcpHarness.forWorkspace(workspaceId, null, agent?.userId, agentId);
  return server ? [server] : undefined;
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cliCommandFromConfig(config: Record<string, unknown>): string | null {
  return stringOf(config.command) ?? stringOf(config.binaryPath);
}

function numberOf(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Native CLI turn cap for harness agents — deliberately NOT derived from the
 * stored per-agent `config.maxTurns`.
 *
 * That field shipped as a baked default (`24`) on every agent and made Claude
 * Code / Hermes fail a long run mid-task with a fatal `error_max_turns` — while
 * Codex ignored the same value and ran to completion (which is why Codex "just
 * worked"). We now match Codex: by DEFAULT there is no native turn cap, so an
 * agent keeps going until the task is done. Runaways are bounded by `timeoutSec`;
 * a power user who genuinely wants a hard turn ceiling sets `AGENTIS_AGENT_MAX_TURNS`.
 */
function nativeTurnCap(): number | undefined {
  return numberOf(process.env.AGENTIS_AGENT_MAX_TURNS);
}

function stringArrayOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
  return entries.length > 0 ? entries : undefined;
}

function recordStringOf(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function recordObjectOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function runtimeCapabilityDeclarationsOf(value: unknown): RuntimeCapabilityDeclaration[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const declarations: RuntimeCapabilityDeclaration[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const id = stringOf(raw.id);
    if (!id?.includes('.') || typeof raw.available !== 'boolean') continue;
    const rawLimits = recordObjectOf(raw.limits);
    const limits: Record<string, string | number | boolean> | undefined = rawLimits
      ? Object.fromEntries(Object.entries(rawLimits).filter((entry): entry is [string, string | number | boolean] =>
        typeof entry[1] === 'string' || typeof entry[1] === 'number' || typeof entry[1] === 'boolean'))
      : undefined;
    const version = stringOf(raw.version);
    const description = stringOf(raw.description);
    declarations.push({
      id: id as RuntimeCapabilityId,
      available: raw.available,
      source: 'advertised',
      ...(version ? { version } : {}),
      ...(description ? { description } : {}),
      ...(limits && Object.keys(limits).length > 0 ? { limits } : {}),
    });
  }
  return declarations.length > 0 ? declarations : undefined;
}

function booleanOf(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return undefined;
}

function httpMethodOf(value: unknown): 'POST' | 'GET' | 'PUT' | 'PATCH' | undefined {
  const method = stringOf(value)?.toUpperCase();
  return method === 'POST' || method === 'GET' || method === 'PUT' || method === 'PATCH' ? method : undefined;
}

function reasoningEffortOf(value: unknown): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | undefined {
  const effort = stringOf(value);
  return effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max' || effort === 'ultra' ? effort : undefined;
}

/** Additive migration: old agents retain their prior authority but now expose it. */
function runtimeProfileOf(config: Record<string, unknown>): RuntimeProfile {
  const raw = recordObjectOf(config.runtimeProfile) ?? {};
  const mode = raw.mode === 'hermetic' || raw.mode === 'containerized' ? raw.mode : 'native';
  const permissionProfile = raw.permissionProfile === 'read_only'
    || raw.permissionProfile === 'workspace_write'
    || raw.permissionProfile === 'externally_sandboxed'
    ? raw.permissionProfile
    : 'trusted_local';
  const browser = raw.browser === 'enabled' || raw.browser === 'disabled' ? raw.browser : 'inherit';
  return {
    version: 2,
    mode,
    ...(stringOf(raw.projectRoot) || stringOf(config.cwd) ? { projectRoot: stringOf(raw.projectRoot) ?? stringOf(config.cwd)! } : {}),
    ...(stringOf(raw.profileName) || stringOf(config.profile) ? { profileName: stringOf(raw.profileName) ?? stringOf(config.profile)! } : {}),
    permissionProfile,
    inheritUserConfig: mode === 'native' && raw.inheritUserConfig !== false,
    inheritProjectInstructions: mode === 'native' && raw.inheritProjectInstructions !== false,
    inheritPlugins: mode === 'native' && raw.inheritPlugins !== false,
    inheritSkills: mode === 'native' && raw.inheritSkills !== false,
    browser,
    sessionPolicy: raw.sessionPolicy === 'ephemeral' ? 'ephemeral' : 'persistent',
  };
}

function hermesChatTransportOf(value: unknown, version: unknown): 'cli' | 'acp' | 'auto' | undefined {
  const transport = stringOf(value);
  // The original runtime form persisted `cli` as its default, so existing agents
  // cannot be distinguished from an operator who deliberately chose the buffered
  // compatibility path. Versioned configs solve that without a database rewrite:
  // old unversioned `cli` values migrate to ACP-first auto, while newly saved
  // explicit CLI selections carry version 2 and remain honored.
  if (transport === 'cli' && Number(version) !== 2) return 'auto';
  return transport === 'cli' || transport === 'acp' || transport === 'auto' ? transport : undefined;
}

function sessionKeyStrategyOf(value: unknown): 'issue' | 'fixed' | 'run' | undefined {
  const strategy = stringOf(value);
  return strategy === 'issue' || strategy === 'fixed' || strategy === 'run' ? strategy : undefined;
}

/**
 * The gateway URL of a provisioned OpenClaw gateway row, or '' when absent.
 * Lets an agent that stores only `gatewayId` resolve its URL instead of being
 * rejected for a missing `gatewayUrl`.
 */
function resolveGatewayUrlById(db: AgentisSqliteDb, workspaceId: string, gatewayId: string | null): string {
  if (!gatewayId) return '';
  const row = db
    .select({ gatewayUrl: schema.openclawGateways.gatewayUrl })
    .from(schema.openclawGateways)
    .where(and(eq(schema.openclawGateways.id, gatewayId), eq(schema.openclawGateways.workspaceId, workspaceId)))
    .get();
  return row?.gatewayUrl ?? '';
}

function loadCredential(db: AgentisSqliteDb, workspaceId: string, id: string) {
  const cred = db
    .select()
    .from(schema.credentials)
    .where(and(eq(schema.credentials.id, id), eq(schema.credentials.workspaceId, workspaceId)))
    .get();
  if (!cred) throw new AgentisError('RESOURCE_NOT_FOUND', `credential ${id} not found`);
  return cred;
}

async function assertSafeGatewayUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AgentisError('VALIDATION_FAILED', 'openclaw gatewayUrl must be a valid URL');
  }
  if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
    parsed.protocol = parsed.protocol === 'ws:' ? 'http:' : 'https:';
  }
  await assertSafeUrl(parsed.toString(), {
    allowPrivate: String(process.env.AGENTIS_GATEWAY_ALLOW_PRIVATE ?? process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
  });
}
