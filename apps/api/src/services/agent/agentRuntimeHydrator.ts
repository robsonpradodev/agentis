import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AdapterManager } from '../../adapters/AdapterManager.js';
import type { Logger } from '../../logger.js';
import type { EventBus } from '../../event-bus.js';
import type { CredentialVault } from '../credentialVault.js';
import { registerAdapter } from './agentCommission.js';
import type { McpHarnessSessionService } from '../mcp/mcpHarnessSession.js';
import type { SkillMaterializer } from '../skillMaterializer.js';
import { cliCommandFromConfig, isCliHarnessAdapter, repairCliHarnessConfig } from '../harness/harnessConfigRepair.js';
import { detectHarnesses, type HarnessDetectionResult, type V1HarnessAdapterType } from '../harness/harnessProbe.js';

const ADAPTER_TYPES = new Set<V1HarnessAdapterType>(['openclaw', 'hermes_agent', 'claude_code', 'codex', 'cursor', 'antigravity', 'openrouter', 'http']);

export interface AgentRuntimeHydratorDeps {
  db: AgentisSqliteDb;
  vault: CredentialVault;
  adapters: AdapterManager;
  logger: Logger;
  bus?: EventBus;
  /** Optional — mounts the Agentis MCP server on CLI harnesses (UNIVERSAL-HARNESS §5). */
  mcpHarness?: McpHarnessSessionService;
  /** Optional — materializes each agent's Brain skills to `.claude/skills/` (Living Skills). */
  skillMaterializer?: SkillMaterializer;
}

export async function hydrateAgentRuntimes(deps: AgentRuntimeHydratorDeps): Promise<void> {
  const agents = deps.db
    .select({
      id: schema.agents.id,
      workspaceId: schema.agents.workspaceId,
      adapterType: schema.agents.adapterType,
      config: schema.agents.config,
      status: schema.agents.status,
      isPaused: schema.agents.isPaused,
    })
    .from(schema.agents)
    .all();

  if (agents.length === 0) return;

  const eligibleAgents = agents
    .map((agent) => ({
      ...agent,
      adapterType: ADAPTER_TYPES.has(agent.adapterType as V1HarnessAdapterType)
        ? agent.adapterType as V1HarnessAdapterType
        : null,
    }))
    .filter((agent) => agent.adapterType && !agent.isPaused && agent.status !== 'paused');

  const detections = await detectHarnesses().catch((err) => {
    deps.logger.warn('agent_runtime_hydrator.detect_failed', { err: (err as Error).message });
    return [];
  });

  let connected = 0;
  let skipped = 0;
  let failed = 0;
  let needsConfig = 0;
  const needsConfigByAdapter: Record<string, number> = {};

  skipped = agents.length - eligibleAgents.length;

  await runWithConcurrency(eligibleAgents, 6, async (agent) => {
    const adapterType = agent.adapterType!;
    const config = recordOf(agent.config);
    const repaired = await repairCliHarnessConfig(adapterType, config, detections);
    const detection = repaired.detection ?? detections.find((entry) => entry.adapterType === adapterType);
    if (repaired.changed) {
      deps.db.update(schema.agents)
        .set({ config: repaired.config, updatedAt: new Date().toISOString() })
        .where(eq(schema.agents.id, agent.id))
        .run();
    }

    try {
      await registerAdapter(deps, agent.workspaceId, agent.id, adapterType, repaired.config, {
        skipConfigRepair: true,
        skipCliAvailabilityCheck: isCliHarnessAdapter(adapterType) && canTrustDetectionForConfig(repaired.config, detection),
      });
      setAgentStatus(deps, agent.workspaceId, agent.id, 'online');
      connected += 1;
    } catch (err) {
      const message = (err as Error).message;
      // A missing gateway URL / baseUrl is INCOMPLETE CONFIGURATION, not a runtime
      // error. Treating it as `error` (with a per-agent WARN) made an imported App
      // whose openclaw/http agents lack their connection details look catastrophically
      // broken — dozens of scary lines and red agents on the org chart. It is a
      // "needs setup" state: park it offline, say so once, and let the operator's
      // next visit to that agent surface the exact fix via the runtime probe.
      if (isNeedsConfigError(err)) {
        needsConfig += 1;
        needsConfigByAdapter[adapterType] = (needsConfigByAdapter[adapterType] ?? 0) + 1;
        setAgentStatus(deps, agent.workspaceId, agent.id, 'offline');
        return;
      }
      failed += 1;
      deps.logger.warn('agent_runtime_hydrator.agent_failed', { agentId: agent.id, adapterType, err: message });
      setAgentStatus(deps, agent.workspaceId, agent.id, 'error');
    }
  });

  deps.logger.info('agent_runtime_hydrator.complete', {
    connected,
    skipped,
    failed,
    needsConfig,
    ...(needsConfig > 0 ? { needsConfigByAdapter } : {}),
  });
}

/**
 * True when registration failed because the adapter is missing REQUIRED CONNECTION
 * CONFIG the operator must supply (a gateway URL, an http baseUrl/dispatch), rather
 * than because something went wrong at runtime. These are expected on a fresh or
 * imported install — secrets and gateway rows never travel — so they must read as
 * "needs setup", not "error".
 */
function isNeedsConfigError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const message = (err as Error | null)?.message ?? '';
  return code === 'VALIDATION_FAILED'
    && /gateway url|requires baseUrl|dispatchPath|dispatchUrl|needs a Gateway URL/i.test(message);
}

function canTrustDetectionForConfig(
  config: Record<string, unknown>,
  detection: HarnessDetectionResult | undefined,
): boolean {
  if (detection?.status !== 'found') return false;
  const command = cliCommandFromConfig(config);
  if (!command) return true;
  const detectedCommand = stringOf(detection.config?.command)
    ?? stringOf(detection.config?.binaryPath);
  const detectedBinary = stringOf(detection.binaryPath)
    ?? stringOf(detection.config?.detectedBinaryPath);
  return sameCommand(command, detectedCommand) || sameCommand(command, detectedBinary);
}

function sameCommand(left: string, right: string | null): boolean {
  if (!right) return false;
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function setAgentStatus(
  deps: AgentRuntimeHydratorDeps,
  workspaceId: string,
  agentId: string,
  status: 'online' | 'offline' | 'error',
): void {
  const now = new Date().toISOString();
  deps.db.update(schema.agents)
    .set(status === 'online'
      ? { status, lastHeartbeatAt: now, updatedAt: now }
      : { status, updatedAt: now })
    .where(eq(schema.agents.id, agentId))
    .run();
  deps.bus?.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.AGENT_STATUS_CHANGED, {
    id: agentId,
    agentId,
    status,
  });
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (index < items.length) {
      const item = items[index]!;
      index += 1;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
