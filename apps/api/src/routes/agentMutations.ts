/**
 * /v1/agents — full CRUD plus terminal RPC.
 *
 * V1 ships six harness adapter types. Creating an
 * agent registers the corresponding adapter in AdapterManager. The route
 * decrypts credential references only when constructing the adapter instance.
 */

import { randomUUID } from 'node:crypto';
import { assertProtectedInstructions, preserveInstructionProtection } from '../services/agent/agentInstructionProtection.js';
import { Hono } from 'hono';
import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { AgentisError, CONSTANTS, REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { CredentialVault } from '../services/credentialVault.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import type { Logger } from '../logger.js';
import type { EventBus } from '../event-bus.js';
import type { ConversationStore } from '../services/conversation/conversationStore.js';
import type { EpisodicMemoryStore } from '../services/episodicMemoryStore.js';
import { OpenClawAdapter } from '../adapters/OpenClawAdapter.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { defaultInstructionsForRole, isDefaultRoleInstructions } from '../data/playbook-library.js';
import { testHarnessConfig, type V1HarnessAdapterType } from '../services/harness/harnessProbe.js';
import { repairCliHarnessConfig } from '../services/harness/harnessConfigRepair.js';
import type { McpHarnessSessionService } from '../services/mcp/mcpHarnessSession.js';
import { ORCHESTRATOR_DEFAULT_COLOR, registerAdapter, runtimeModelFromConfig, switchRuntime } from '../services/agent/agentCommission.js';
import { normalizeAntigravityModel } from '../adapters/antigravityModels.js';

const adapterTypeSchema = z.enum(['openclaw', 'hermes_agent', 'claude_code', 'codex', 'cursor', 'antigravity', 'http']);
const agentStatusSchema = z.enum(['online', 'busy', 'offline', 'error', 'paused', 'setting_up']);

const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(240).nullish(),
  adapterType: adapterTypeSchema,
  ambientId: z.string().nullish(),
  gatewayId: z.string().nullish(),
  capabilityTags: z.array(z.string()).default([]),
  config: z.record(z.unknown()).default({}),
  instructions: z.string().nullish(),
  avatarGlyph: z.string().max(8).nullish(),
  avatarUrl: z.string().max(2_000_000).nullish(),
  runtimeModel: z.string().nullish(),
  role: z.string().max(120).nullish(),
  reportsTo: z.string().nullish(),
  spaceTag: z.string().max(80).nullish(),
  spaceId: z.string().nullish(),
  isPaused: z.boolean().optional(),
  monthlyBudgetCents: z.number().int().nonnegative().nullish(),
  canvasPosition: z.object({ x: z.number(), y: z.number() }).nullish(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  status: agentStatusSchema.optional(),
  replaceExistingOrchestrator: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(240).nullish().optional(),
  capabilityTags: z.array(z.string()).optional(),
  config: z.record(z.unknown()).optional(),
  instructions: z.string().nullish().optional(),
  avatarGlyph: z.string().max(8).nullish().optional(),
  avatarUrl: z.string().max(2_000_000).nullish().optional(),
  runtimeModel: z.string().nullish().optional(),
  role: z.string().max(120).nullish().optional(),
  reportsTo: z.string().nullish().optional(),
  spaceTag: z.string().max(80).nullish().optional(),
  spaceId: z.string().nullish().optional(),
  isPaused: z.boolean().optional(),
  monthlyBudgetCents: z.number().int().nonnegative().nullish().optional(),
  canvasPosition: z.object({ x: z.number(), y: z.number() }).nullish().optional(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  status: agentStatusSchema.optional(),
  replaceExistingOrchestrator: z.boolean().optional(),
});

const terminalSendSchema = z.object({
  body: z.string().min(1).max(CONSTANTS.CONVERSATION_MESSAGE_MAX_LENGTH),
});

function isValidCanvasPosition(value: unknown): value is { x: number; y: number } {
  return Boolean(value && typeof value === 'object'
    && typeof (value as { x?: unknown }).x === 'number'
    && typeof (value as { y?: unknown }).y === 'number'
    && Number.isFinite((value as { x: number }).x)
    && Number.isFinite((value as { y: number }).y)
    && Math.abs((value as { x: number }).x) <= 3000
    && (value as { y: number }).y >= -120
    && (value as { y: number }).y <= 1800);
}

function canonicalCanvasPosition(role: 'orchestrator' | 'manager' | 'worker', index: number, count: number): { x: number; y: number } {
  if (role === 'orchestrator') return { x: 0, y: 120 };
  const columns = role === 'manager' ? Math.min(6, Math.max(1, count)) : Math.min(5, Math.max(1, count));
  const row = Math.floor(index / columns);
  const col = index % columns;
  const inRow = Math.min(columns, count - row * columns);
  return {
    x: (col - (inRow - 1) / 2) * (role === 'manager' ? 300 : 220),
    y: (role === 'manager' ? 300 : 480) + row * (role === 'manager' ? 150 : 132),
  };
}

/**
 * Rebind an agent to a different runtime (AGENT-TRANSITION §2, Track R). The
 * agent's identity, Brain, abilities and hierarchy are untouched — only the
 * `(adapterType, config, runtimeModel)` binding changes.
 */
const switchRuntimeSchema = z.object({
  adapterType: adapterTypeSchema,
  config: z.record(z.unknown()).optional(),
  runtimeModel: z.string().nullish(),
});

export interface AgentRouteDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  vault: CredentialVault;
  adapters: AdapterManager;
  logger: Logger;
  bus?: EventBus;
  conversations: ConversationStore;
  mcpHarness?: McpHarnessSessionService;
  /** Optional: lets agent deletion decide the fate of the agent's memory (B11). */
  episodes?: EpisodicMemoryStore;
}

export function buildAgentMutationRoutes(deps: AgentRouteDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = createSchema.parse(await c.req.json());
    if (body.reportsTo) ensureReportsToTarget(deps.db, ws.workspaceId, body.reportsTo);
    const id = randomUUID();
    ensureOrEstablishSingleOrchestrator(deps.db, ws.workspaceId, body.role ?? null, id, body.replaceExistingOrchestrator === true);
    const domain = resolveAgentDomain(deps.db, ws.workspaceId, {
      role: body.role ?? null,
      requestedSpaceId: body.spaceId ?? null,
      reportsTo: body.reportsTo ?? null,
      fallbackSpaceTag: body.spaceTag ?? null,
    });
    const colorHex = body.colorHex
      ?? (body.role === 'orchestrator'
        ? ORCHESTRATOR_DEFAULT_COLOR
        : CONSTANTS.AGENT_COLOR_PALETTE[Math.floor(Math.random() * CONSTANTS.AGENT_COLOR_PALETTE.length)]);
    const repaired = await repairCliHarnessConfig(body.adapterType, body.config);
    const config = body.adapterType === 'antigravity'
      ? { ...repaired.config, ...(normalizeAntigravityModel(String(repaired.config.model ?? body.runtimeModel ?? '')) ? { model: normalizeAntigravityModel(String(repaired.config.model ?? body.runtimeModel ?? '')) } : {}) }
      : repaired.config;
    const runtimeModel = body.adapterType === 'antigravity'
      ? normalizeAntigravityModel(body.runtimeModel ?? runtimeModelFromConfig(body.adapterType, config))
      : (body.runtimeModel ?? runtimeModelFromConfig(body.adapterType, config));
    const isPaused = body.isPaused ?? false;
    let status = body.status === 'setting_up' ? 'setting_up' : isPaused ? 'paused' : 'offline';
    deps.db.transaction(() => {
      deps.db
        .insert(schema.agents)
        .values({
          id,
          workspaceId: ws.workspaceId,
          ambientId: body.ambientId ?? null,
          userId: ws.user.id,
          gatewayId: body.gatewayId ?? null,
          packageId: null,
          name: body.name,
          description: body.description ?? null,
          adapterType: body.adapterType,
          capabilityTags: body.capabilityTags,
          config,
          status,
          colorHex,
          instructions: body.instructions ?? null,
          avatarGlyph: body.avatarGlyph ?? null,
          avatarUrl: body.avatarUrl ?? null,
          runtimeModel,
          role: body.role ?? null,
          reportsTo: body.reportsTo ?? null,
          spaceTag: domain.spaceTag,
          spaceId: domain.spaceId,
          isPaused,
          monthlyBudgetCents: body.monthlyBudgetCents ?? null,
          canvasPosition: body.canvasPosition ?? null,
        })
        .run();
      if (body.role === 'orchestrator' && body.replaceExistingOrchestrator === true) {
        pointManagersAtOrchestrator(deps.db, ws.workspaceId, id);
      }
    });

    // Register adapter immediately if we have enough config.
    if (status !== 'setting_up' && !isPaused) {
      try {
        await registerAdapter(deps, ws.workspaceId, id, body.adapterType, config);
        status = 'online';
        deps.db
          .update(schema.agents)
          .set({ status, lastHeartbeatAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
          .where(eq(schema.agents.id, id))
          .run();
      } catch (err) {
        deps.logger.warn('agents.register_failed', { id, err: (err as Error).message });
        status = 'error';
        deps.db
          .update(schema.agents)
          .set({ status, updatedAt: new Date().toISOString() })
          .where(eq(schema.agents.id, id))
          .run();
      }
    }
    deps.bus?.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.AGENT_CREATED, {
      agentId: id,
      canvasPosition: body.canvasPosition ?? null,
      reportsTo: body.reportsTo ?? null,
    });
    return c.json({
      id,
      name: body.name,
      adapterType: body.adapterType,
      colorHex,
      status,
      spaceId: domain.spaceId,
      spaceTag: domain.spaceTag,
      spaceName: domain.spaceName,
      agent: { id, name: body.name, adapterType: body.adapterType, colorHex, status, spaceId: domain.spaceId, spaceTag: domain.spaceTag, spaceName: domain.spaceName },
    }, 201);
  });

  /**
   * Backfill only absent/invalid legacy positions. Valid manual positions are
   * immutable to this repair and every update is published to every canvas.
   */
  app.post('/reconcile-layout', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.db.select().from(schema.agents)
      .where(eq(schema.agents.workspaceId, ws.workspaceId)).all();
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const role = row.role === 'orchestrator' || row.role === 'manager' ? row.role : 'worker';
      const list = groups.get(role) ?? [];
      list.push(row);
      groups.set(role, list);
    }
    const changed: Array<{ id: string; canvasPosition: { x: number; y: number } }> = [];
    for (const [role, group] of groups) {
      const sorted = [...group].sort((a, b) => a.name.localeCompare(b.name));
      sorted.forEach((row, index) => {
        if (isValidCanvasPosition(row.canvasPosition)) return;
        const position = canonicalCanvasPosition(role as 'orchestrator' | 'manager' | 'worker', index, sorted.length);
        deps.db.update(schema.agents).set({ canvasPosition: position, updatedAt: new Date().toISOString() })
          .where(eq(schema.agents.id, row.id)).run();
        changed.push({ id: row.id, canvasPosition: position });
      });
    }
    if (changed.length) {
      deps.bus?.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.AGENT_UPDATED, {
        reason: 'legacy_layout_reconciled', changed,
      });
    }
    return c.json({ reconciled: changed.length, changed });
  });

  app.patch('/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const body = updateSchema.parse(await c.req.json());
    const existing = loadAgent(deps.db, ws.workspaceId, id);
    const existingIsPaused = Boolean(existing.isPaused);
    const nextIsPaused = body.isPaused === undefined ? existingIsPaused : body.isPaused;
    const pauseChanged = body.isPaused !== undefined && body.isPaused !== existingIsPaused;
    const configChanged = body.config !== undefined;
    const nextStatus = body.status === undefined
      ? nextIsPaused ? 'paused' : existing.status
      : body.status;
    const nextRole = body.role === undefined ? existing.role : body.role;
    const nextName = body.name ?? existing.name;
    // Regenerate the platform `agentis.md` when the role changes — but only when
    // the operator hasn't customized it (current text is an unedited playbook
    // default). Works for every role; never clobbers hand-written instructions.
    let nextInstructions = body.instructions === undefined ? existing.instructions : body.instructions;
    if (
      body.instructions === undefined &&
      nextRole !== existing.role &&
      isDefaultRoleInstructions(existing.instructions, existing.name)
    ) {
      const regenerated = defaultInstructionsForRole(nextRole, nextName);
      if (regenerated) nextInstructions = regenerated;
    }
    if (body.reportsTo) ensureReportsToTarget(deps.db, ws.workspaceId, body.reportsTo, id);
    const nextReportsTo = body.reportsTo === undefined ? existing.reportsTo : body.reportsTo ?? null;
    const nextDomain = resolveAgentDomain(deps.db, ws.workspaceId, {
      role: nextRole ?? null,
      requestedSpaceId: body.spaceId === undefined ? existing.spaceId ?? null : body.spaceId ?? null,
      reportsTo: nextReportsTo,
      fallbackSpaceTag: body.spaceTag === undefined ? existing.spaceTag ?? null : body.spaceTag ?? null,
    });
    assertProtectedInstructions(existing, nextInstructions ?? null);
    const rawNextConfig = preserveInstructionProtection(existing.config, body.config ?? (existing.config as Record<string, unknown>));
    const repairedConfig = await repairCliHarnessConfig(existing.adapterType as V1HarnessAdapterType, rawNextConfig);
    const nextConfig = existing.adapterType === 'antigravity'
      ? { ...repairedConfig.config, ...(normalizeAntigravityModel(String(repairedConfig.config.model ?? body.runtimeModel ?? '')) ? { model: normalizeAntigravityModel(String(repairedConfig.config.model ?? body.runtimeModel ?? '')) } : {}) }
      : repairedConfig.config;
    const nextRuntimeModel = body.runtimeModel === undefined
      ? existing.runtimeModel
      : existing.adapterType === 'antigravity'
        ? normalizeAntigravityModel(body.runtimeModel)
        : body.runtimeModel;
    ensureOrEstablishSingleOrchestrator(deps.db, ws.workspaceId, nextRole, id, body.replaceExistingOrchestrator === true);
    const latest = loadAgent(deps.db, ws.workspaceId, id);
    if (JSON.stringify(latest.config) !== JSON.stringify(existing.config) || latest.instructions !== existing.instructions) {
      throw new AgentisError('RESOURCE_CONFLICT', 'Agent configuration changed while preparing this update. Reload before saving.');
    }
    deps.db.transaction(() => {
      deps.db
        .update(schema.agents)
        .set({
          name: body.name ?? existing.name,
          description: body.description === undefined ? existing.description : body.description,
          capabilityTags: body.capabilityTags ?? (existing.capabilityTags as string[]),
          config: nextConfig,
          instructions: nextInstructions,
          avatarGlyph: body.avatarGlyph === undefined ? existing.avatarGlyph : body.avatarGlyph,
          runtimeModel: nextRuntimeModel,
          role: nextRole,
          reportsTo: nextReportsTo,
          spaceTag: nextDomain.spaceTag,
          spaceId: nextDomain.spaceId,
          isPaused: nextIsPaused,
          monthlyBudgetCents: body.monthlyBudgetCents === undefined ? existing.monthlyBudgetCents : body.monthlyBudgetCents,
          canvasPosition: body.canvasPosition === undefined ? existing.canvasPosition : body.canvasPosition,
          colorHex: body.colorHex ?? existing.colorHex,
          avatarUrl: body.avatarUrl === undefined ? existing.avatarUrl : body.avatarUrl,
          status: nextStatus,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.agents.id, id))
        .run();
      if (nextRole === 'orchestrator' && body.replaceExistingOrchestrator === true) {
        pointManagersAtOrchestrator(deps.db, ws.workspaceId, id);
      }
    });
    if (body.status !== 'setting_up') {
      if (nextIsPaused) {
        await deps.adapters.unregister(id);
        deps.db
          .update(schema.agents)
          .set({ status: 'paused', updatedAt: new Date().toISOString() })
          .where(eq(schema.agents.id, id))
          .run();
      } else if (configChanged || pauseChanged) {
        try {
          await registerAdapter(deps, ws.workspaceId, id, existing.adapterType as V1HarnessAdapterType, nextConfig);
          deps.db
            .update(schema.agents)
            .set({ status: 'online', lastHeartbeatAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
            .where(eq(schema.agents.id, id))
            .run();
        } catch (err) {
          deps.logger.warn('agents.reregister_failed', { id, err: (err as Error).message });
          deps.db
            .update(schema.agents)
            .set({ status: 'error', updatedAt: new Date().toISOString() })
            .where(eq(schema.agents.id, id))
            .run();
        }
      }
    }
    deps.bus?.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.AGENT_UPDATED, {
      agentId: id,
      changed: Object.keys(body),
      canvasPosition: body.canvasPosition,
      reportsTo: nextReportsTo,
    });
    return c.json({ ok: true });
  });

  app.delete('/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const existing = loadAgent(deps.db, ws.workspaceId, id);

    // B11 — decide the fate of the agent's memory before the row is gone.
    // promote (default) keeps it in the workspace Brain; transfer moves it to
    // another agent; delete removes it. Per Brain B7: promote, don't lose.
    const disposition = (c.req.query('memoryDisposition') ?? 'promote') as 'promote' | 'delete' | 'transfer';
    let memoryMoved = 0;
    let memoryDeleted = 0;
    if (deps.episodes) {
      if (disposition === 'delete') {
        memoryDeleted = deps.episodes.deleteScope(ws.workspaceId, id);
      } else if (disposition === 'transfer') {
        const target = c.req.query('targetAgentId');
        if (!target) throw new AgentisError('VALIDATION_FAILED', 'targetAgentId is required to transfer memory');
        loadAgent(deps.db, ws.workspaceId, target); // validate target in this workspace
        memoryMoved = deps.episodes.reassignScope(ws.workspaceId, id, target);
      } else {
        memoryMoved = deps.episodes.reassignScope(ws.workspaceId, id, null); // promote to workspace
      }
    }

    await deps.adapters.unregister(existing.id);
    deps.db.delete(schema.agents).where(eq(schema.agents.id, id)).run();
    return c.json({ ok: true, memoryDisposition: disposition, memoryMoved, memoryDeleted });
  });

  // POST /v1/agents/:id/terminal/send — direct operator → agent message.
  app.post('/:id/terminal/send', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const agent = loadAgent(deps.db, ws.workspaceId, id);
    const body = terminalSendSchema.parse(await c.req.json());

    const conversation = deps.conversations.getOrCreateByAgent({
      workspaceId: agent.workspaceId,
      ambientId: agent.ambientId,
      userId: ws.user.id,
      agentId: agent.id,
      mirroredSessionId: null,
    });
    const message = deps.conversations.appendOutbound({
      workspaceId: agent.workspaceId,
      conversationId: conversation.id,
      operatorId: ws.user.id,
      body: body.body,
      deliveryStatus: 'sent',
    });
    // Best-effort dispatch through the adapter.
    const reg = deps.adapters.get(agent.id);
    if (reg && reg.adapter instanceof OpenClawAdapter) {
      try {
        await reg.adapter.sendSessionMessage({
          sessionId: conversation.mirroredSessionId ?? undefined,
          body: body.body,
        });
      } catch (err) {
        deps.logger.warn('agents.terminal_send_failed', { id, err: (err as Error).message });
      }
    }
    return c.json({ message });
  });

  // POST /v1/agents/:id/cancel-task/:taskId
  app.post('/:id/cancel-task/:taskId', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const taskId = c.req.param('taskId');
    loadAgent(deps.db, ws.workspaceId, id);
    await deps.adapters.cancelTask(id, taskId);
    return c.json({ ok: true });
  });

  app.post('/:id/test-harness', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const agent = loadAgent(deps.db, ws.workspaceId, id);
    const parsed = adapterTypeSchema.safeParse(agent.adapterType);
    if (!parsed.success) {
      throw new AgentisError('VALIDATION_FAILED', `agent ${id} uses unsupported adapter ${agent.adapterType}`);
    }
    const repaired = await repairCliHarnessConfig(parsed.data, (agent.config ?? {}) as Record<string, unknown>);
    if (repaired.changed) {
      deps.db.update(schema.agents).set({ config: repaired.config, updatedAt: new Date().toISOString() }).where(eq(schema.agents.id, id)).run();
    }
    const result = await testHarnessConfig(parsed.data, repaired.config, { deep: true });
    return c.json(result);
  });

  // POST /v1/agents/:id/runtime — rebind to a different runtime without losing
  // identity or memory (Track R). The agent is Agentis-owned; the runtime is a
  // swappable binding.
  app.post('/:id/runtime', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    loadAgent(deps.db, ws.workspaceId, id);
    const body = switchRuntimeSchema.parse(await c.req.json());
    const result = await switchRuntime(deps, ws.workspaceId, id, {
      adapterType: body.adapterType,
      config: body.config,
      runtimeModel: body.runtimeModel ?? undefined,
    });
    return c.json(result);
  });

  return app;
}

function loadAgent(db: AgentisSqliteDb, workspaceId: string, id: string) {
  const a = db.select().from(schema.agents).where(and(eq(schema.agents.id, id), eq(schema.agents.workspaceId, workspaceId))).get();
  if (!a) throw new AgentisError('RESOURCE_NOT_FOUND', `agent ${id} not found`);
  return a;
}

function resolveAgentDomain(
  db: AgentisSqliteDb,
  workspaceId: string,
  input: {
    role: string | null;
    requestedSpaceId: string | null;
    reportsTo: string | null;
    fallbackSpaceTag: string | null;
  },
): { spaceId: string | null; spaceName: string | null; spaceTag: string | null } {
  if ((input.role ?? '').toLowerCase() === 'orchestrator') {
    return { spaceId: null, spaceName: null, spaceTag: null };
  }

  let spaceId = input.requestedSpaceId;
  if (!spaceId && input.reportsTo) {
    const supervisor = db
      .select({ spaceId: schema.agents.spaceId })
      .from(schema.agents)
      .where(and(eq(schema.agents.id, input.reportsTo), eq(schema.agents.workspaceId, workspaceId)))
      .get();
    spaceId = supervisor?.spaceId ?? null;
  }

  if (!spaceId) {
    const fallback = input.fallbackSpaceTag?.trim();
    return { spaceId: null, spaceName: null, spaceTag: fallback ? fallback.slice(0, 80) : null };
  }

  const space = db
    .select({ id: schema.spaces.id, name: schema.spaces.name })
    .from(schema.spaces)
    .where(and(eq(schema.spaces.id, spaceId), eq(schema.spaces.workspaceId, workspaceId)))
    .get();
  if (!space) throw new AgentisError('RESOURCE_NOT_FOUND', `space ${spaceId} not found`);
  return { spaceId: space.id, spaceName: space.name, spaceTag: space.name.trim().slice(0, 80) };
}

function ensureOrEstablishSingleOrchestrator(db: AgentisSqliteDb, workspaceId: string, role: string | null | undefined, currentAgentId: string, replaceExisting: boolean) {
  if (role !== 'orchestrator') return;
  const predicates = [
    eq(schema.agents.workspaceId, workspaceId),
    eq(schema.agents.role, 'orchestrator'),
  ];
  predicates.push(ne(schema.agents.id, currentAgentId));
  const existing = db
    .select({ id: schema.agents.id, name: schema.agents.name })
    .from(schema.agents)
    .where(and(...predicates))
    .get();
  if (!existing) return;
  if (!replaceExisting) {
    throw new AgentisError('WORKSPACE_ORCHESTRATOR_EXISTS', `Workspace already has an orchestrator: ${existing.name}`, {
      details: { id: existing.id, name: existing.name },
    });
  }
  db
    .update(schema.agents)
    .set({ role: 'manager', reportsTo: currentAgentId, updatedAt: new Date().toISOString() })
    .where(and(...predicates))
    .run();
}

function pointManagersAtOrchestrator(db: AgentisSqliteDb, workspaceId: string, orchestratorId: string) {
  db
    .update(schema.agents)
    .set({ reportsTo: orchestratorId, updatedAt: new Date().toISOString() })
    .where(and(
      eq(schema.agents.workspaceId, workspaceId),
      eq(schema.agents.role, 'manager'),
      ne(schema.agents.id, orchestratorId),
    ))
    .run();
}

function ensureReportsToTarget(db: AgentisSqliteDb, workspaceId: string, reportsTo: string, currentAgentId?: string) {
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
