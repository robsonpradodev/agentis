import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { ChannelBridge } from '../services/conversation/channelBridge.js';
import type { CredentialVault } from '../services/credentialVault.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import type { Logger } from '../logger.js';
import type { EventBus } from '../event-bus.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';
import { commissionAgent, type CommissionAgentInput } from '../services/agent/agentCommission.js';

const adapterTypeSchema = z.enum(['openclaw', 'hermes_agent', 'claude_code', 'codex', 'cursor', 'antigravity', 'openrouter', 'http']);
const roleSchema = z.enum(['orchestrator', 'manager', 'worker']);

const bootstrapAgentSchema = z.object({
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
  role: roleSchema.default('orchestrator'),
  reportsTo: z.string().nullish(),
  monthlyBudgetCents: z.number().int().nonnegative().nullish(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
});

const bootstrapChannelSchema = z.object({
  kind: z.enum(['telegram', 'discord']),
  name: z.string().min(1).max(120).optional(),
  token: z.string().min(8).max(4096),
  defaultChatId: z.string().min(1).max(120).optional(),
  ambientId: z.string().nullish(),
});

const bootstrapBodySchema = z.object({
  agent: bootstrapAgentSchema,
  channels: z.array(bootstrapChannelSchema).default([]),
});

const importAgentSchema = z.object({
  name: z.string().min(1).max(120),
  role: roleSchema,
  adapterType: adapterTypeSchema.default('claude_code'),
  description: z.string().max(240).nullish(),
  instructions: z.string().nullish(),
  capabilityTags: z.array(z.string()).default([]),
  runtimeModel: z.string().nullish(),
  reportsTo: z.string().nullish(),
  monthlyBudgetCents: z.number().int().nonnegative().nullish(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  avatarGlyph: z.string().max(8).nullish(),
  avatarUrl: z.string().max(2_000_000).nullish(),
  config: z.record(z.unknown()).default({}),
});

const importChannelSchema = z.object({
  kind: z.enum(['telegram', 'discord']),
  agentName: z.string().min(1).max(120),
  name: z.string().min(1).max(120).optional(),
  token: z.string().min(8).max(4096),
  defaultChatId: z.string().min(1).max(120).optional(),
});

const importBodySchema = z.object({
  version: z.string().default('1'),
  workspace: z.object({ name: z.string().optional() }).optional(),
  agents: z.array(importAgentSchema).default([]),
  channels: z.array(importChannelSchema).default([]),
});

export interface BootstrapRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  bridge: ChannelBridge;
  vault: CredentialVault;
  adapters: AdapterManager;
  logger: Logger;
  bus: EventBus;
}

export function buildBootstrapRoutes(deps: BootstrapRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = bootstrapBodySchema.parse(await c.req.json());

    if (body.agent.role === 'orchestrator') {
      const existing = findOrchestrator(deps.db, ws.workspaceId);
      if (existing) {
        return c.json({ existed: true, agentId: existing.id, name: existing.name }, 200);
      }
    }

    const created = await commissionAgent(deps, {
      workspaceId: ws.workspaceId,
      userId: ws.user.id,
      ...body.agent,
    });

    const channelIds: string[] = [];
    for (const channel of body.channels) {
      const result = deps.bridge.create({
        workspaceId: ws.workspaceId,
        ambientId: channel.ambientId ?? null,
        userId: ws.user.id,
        agentId: created.id,
        kind: channel.kind,
        name: channel.name ?? `${created.name} ${channel.kind}`,
        token: channel.token,
        defaultChatId: channel.defaultChatId,
      });
      channelIds.push(result.connection.id);
    }

    return c.json({ existed: false, agentId: created.id, workspaceId: ws.workspaceId, channelIds }, 201);
  });

  app.post('/import', async (c) => {
    const ws = getWorkspace(c);
    const body = importBodySchema.parse(await c.req.json());
    const createdAgentIds: string[] = [];
    const createdChannelIds: string[] = [];
    const skipped: string[] = [];
    const errors: Array<{ item: string; message: string }> = [];
    const nameToId = new Map<string, string>();

    const existingAgents = deps.db
      .select({ id: schema.agents.id, name: schema.agents.name, role: schema.agents.role })
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, ws.workspaceId))
      .all();
    for (const agent of existingAgents) nameToId.set(agent.name, agent.id);

    const orderedAgents = [...body.agents].sort((left, right) => rankRole(left.role) - rankRole(right.role));
    for (const agent of orderedAgents) {
      const existingId = nameToId.get(agent.name);
      if (existingId) {
        skipped.push(agent.name);
        continue;
      }
      try {
        const reportsTo = agent.reportsTo ? nameToId.get(agent.reportsTo) ?? null : null;
        const created = await commissionAgent(deps, {
          workspaceId: ws.workspaceId,
          userId: ws.user.id,
          ...agent,
          reportsTo,
        });
        createdAgentIds.push(created.id);
        nameToId.set(agent.name, created.id);
      } catch (error) {
        errors.push({ item: agent.name, message: error instanceof Error ? error.message : String(error) });
      }
    }

    for (const channel of body.channels) {
      const agentId = nameToId.get(channel.agentName);
      if (!agentId) {
        errors.push({ item: channel.agentName, message: 'Referenced agent for channel was not created or found.' });
        continue;
      }
      try {
        const result = deps.bridge.create({
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          agentId,
          kind: channel.kind,
          name: channel.name ?? `${channel.agentName} ${channel.kind}`,
          token: channel.token,
          defaultChatId: channel.defaultChatId,
        });
        createdChannelIds.push(result.connection.id);
      } catch (error) {
        errors.push({ item: `${channel.agentName}:${channel.kind}`, message: error instanceof Error ? error.message : String(error) });
      }
    }

    return c.json({
      created: { agents: createdAgentIds.length, channels: createdChannelIds.length },
      skipped,
      errors,
    });
  });

  return app;
}

function findOrchestrator(db: AgentisSqliteDb, workspaceId: string) {
  return db
    .select({ id: schema.agents.id, name: schema.agents.name })
    .from(schema.agents)
    .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.role, 'orchestrator')))
    .get();
}

function rankRole(role: z.infer<typeof roleSchema>): number {
  return role === 'orchestrator' ? 0 : role === 'manager' ? 1 : 2;
}
