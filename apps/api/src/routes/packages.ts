/**
 * /v1/packages — workflow package CRUD + install-from-local-manifest.
 *
 * The public packages surface now stays focused on workflows. Abilities have
 * their own dedicated library at /v1/abilities.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AgentisError, CONSTANTS } from '@agentis/core';
import type { AgentisPackageContents, PackageContents, PackageManifest } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { SkillService } from '../services/skillService.js';
import type { Logger } from '../logger.js';
import type { EventBus } from '../event-bus.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { PackagerService } from '../services/packager.js';
import type { EpisodicMemoryStore } from '../services/episodicMemoryStore.js';
import { EpisodicBrainPort } from '../services/brain/brainExport.js';

const templateDefSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().default(''),
  summary: z.string().optional(),
  graph: z.object({
    version: z.literal(1),
    nodes: z.array(z.unknown()),
    edges: z.array(z.unknown()),
    viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).optional(),
  }),
  variables: z.array(z.unknown()).default([]),
});

const extensionDefSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  version: z.string().min(1),
  runtime: z.enum(['builtin', 'node_worker', 'docker_sandbox']),
  entrypoint: z.string().optional(),
  capabilityTags: z.array(z.string()).default([]),
  operations: z.array(z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    inputSchema: z.record(z.unknown()).default({}),
    outputSchema: z.record(z.unknown()).default({}),
  })).min(1).optional(),
  inputSchema: z.record(z.unknown()).optional(),
  outputSchema: z.record(z.unknown()).optional(),
  timeoutMs: z.number().int().positive().max(CONSTANTS.EXTENSION_EXECUTION_MAX_TIMEOUT_MS).optional(),
});

const agentDefSchema = z.object({
  name: z.string().min(1),
  adapterType: z.enum(['openclaw', 'hermes_agent', 'claude_code', 'codex', 'cursor', 'antigravity', 'openrouter', 'http']),
  capabilityTags: z.array(z.string()).default([]),
  defaultConfig: z.record(z.unknown()).default({}),
});

const knowledgeSeedSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}),
});

const manifestSchema = z.object({
  manifestVersion: z.literal(1),
  name: z.string().min(1),
  version: z.string().min(1),
  summary: z.string().default(''),
  agents: z.array(agentDefSchema).default([]),
  extensions: z.array(extensionDefSchema).default([]),
  workflowTemplates: z.array(templateDefSchema).default([]),
  credentials: z.array(z.unknown()).default([]),
  knowledgeSeeds: z.array(knowledgeSeedSchema).default([]),
}).passthrough();

const installLocalSchema = z.object({
  manifest: manifestSchema,
  permissionsAcknowledged: z.literal(true, {
    errorMap: () => ({ message: 'permissionsAcknowledged must be true' }),
  }),
});

const createPackageSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
  version: z.string().min(1).default('1.0.0'),
  kind: z.literal('workflow').default('workflow'),
  description: z.string().default(''),
  workflowIds: z.array(z.string()).default([]),
});

const packMetaSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const packageImportOverridesSchema = z.object({
  agent: z.object({
    name: z.string().min(1).max(120).optional(),
    role: z.string().max(120).nullish(),
    reportsTo: z.string().nullish(),
  }).optional(),
}).optional();

export function buildPackageRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  bus?: EventBus;
  logger?: Logger;
  skills?: SkillService;
  /** Brain store — lets an `agent` package carry/rehydrate that agent's memory. */
  episodes?: EpisodicMemoryStore;
}) {
  const app = new Hono();
  const packager = new PackagerService({
    db: deps.db,
    bus: deps.bus,
    logger: deps.logger,
    skills: deps.skills,
    ...(deps.episodes ? { brain: new EpisodicBrainPort(deps.episodes) } : {}),
  });
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  function scope(c: Context) {
    const ws = getWorkspace(c);
    return { workspaceId: ws.workspaceId, ambientId: ws.ambientId, userId: ws.user.id };
  }

  function toPackageDto(row: typeof schema.libraryPackages.$inferSelect) {
    const isAgent = row.kind === 'agent';
    const role = isAgent ? (row.contents as any).agent?.role : undefined;
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      kind: row.kind as any,
      version: row.version,
      description: row.description ?? '',
      isTemplate: false,
      ...(isAgent ? { role } : {}),
    };
  }

  function isSupportedPackageRow(row: typeof schema.libraryPackages.$inferSelect) {
    return row.kind === 'workflow' || row.kind === 'agent';
  }

  // ── List ───────────────────────────────────────────────────────────────────
  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const rows = packager.list({ workspaceId: ws.workspaceId });
    return c.json({ packages: rows.filter(isSupportedPackageRow).map(toPackageDto) });
  });

  // ── Compatibility pack shortcuts ──────────────────────────────────────────
  app.post('/pack/workflow/:workflowId', async (c) => {
    const row = packager.packFromWorkflow(
      scope(c),
      c.req.param('workflowId'),
      packMetaSchema.parse(await c.req.json().catch(() => ({}))),
    );
    return c.json({ package: { ...toPackageDto(row), checksum: row.checksum } }, 201);
  });

  app.post('/pack/agent/:agentId', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    // `includeBrain` carries the agent's learned memory with it (opt-in).
    const includeBrain = z.object({ includeBrain: z.boolean().default(false) }).parse(body).includeBrain;
    const row = packager.packFromAgent(
      scope(c),
      c.req.param('agentId'),
      packMetaSchema.parse(body),
      { includeBrain },
    );
    return c.json({ package: { ...toPackageDto(row), checksum: row.checksum } }, 201);
  });

  app.get('/:id/export', (c) => {
    const ws = getWorkspace(c);
    const row = packager.get(c.req.param('id'), ws.workspaceId);
    if (!isSupportedPackageRow(row)) {
      throw new AgentisError('VALIDATION_FAILED', 'only workflow and agent packages are exposed here');
    }
    return c.json(packager.exportEnvelope(c.req.param('id'), ws.workspaceId));
  });

  app.post('/:id/use', (c) => {
    const ws = getWorkspace(c);
    const row = packager.get(c.req.param('id'), ws.workspaceId);
    if (!isSupportedPackageRow(row)) {
      throw new AgentisError('VALIDATION_FAILED', 'only workflow and agent packages are exposed here');
    }
    const result = packager.usePackage(scope(c), c.req.param('id'));
    return c.json(result, 201);
  });

  // ── Get one ────────────────────────────────────────────────────────────────
  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');

    const libRow = packager.get(id, ws.workspaceId);
    if (!isSupportedPackageRow(libRow)) {
      throw new AgentisError('VALIDATION_FAILED', 'only workflow and agent packages are exposed here');
    }
    const contents = libRow.contents as PackageContents;
    const manifest = packager.manifestFromRow(libRow);
    const pkgDto = toPackageDto(libRow);

    const workflows = contents.kind === 'workflow'
      ? [{ id: libRow.sourceId ?? '', title: contents.workflow.title }]
      : [];

    const agents = contents.kind === 'agent'
      ? [{ id: libRow.sourceId ?? '', name: contents.agent.name, role: contents.agent.role }]
      : [];

    return c.json({ package: { ...pkgDto, installedAt: libRow.createdAt, manifest }, workflows, agents });
  });

  // ── Create ─────────────────────────────────────────────────────────────────
  app.post('/', async (c) => {
    const s = scope(c);
    const body = createPackageSchema.parse(await c.req.json());
    const meta = { name: body.name, slug: body.slug, version: body.version, description: body.description };

    if (body.workflowIds.length !== 1) {
      throw new AgentisError('VALIDATION_FAILED', 'workflowIds must contain exactly one workflow');
    }
    const workflow = deps.db.select().from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, getWorkspace(c).workspaceId), eq(schema.workflows.id, body.workflowIds[0]!)))
      .get();
    if (!workflow) throw new AgentisError('RESOURCE_NOT_FOUND', 'workflow not found');

    const row = packager.packFromWorkflow(s, workflow.id, meta);
    return c.json(toPackageDto(row), 201);
  });

  // ── Import a PackageManifest (exported via exportEnvelope / drawerExport) ──
  // Accepts: raw PackageManifest, { manifest: ... }, or { packageManifest: ... }
  // (the last shape is what exportEnvelope produces as PackageExportEnvelope).
  // Validates checksum + security scan, stores the package, then instantiates it
  // via usePackage() so the caller gets a ready-to-navigate workflowId + path.
  app.post('/import', async (c) => {
    const s = scope(c);
    const rawBody = (await c.req.json()) as unknown;
    const body = isRecord(rawBody) ? rawBody : {};
    const manifest = 'manifest' in body && body.manifest
      ? body.manifest
      : 'packageManifest' in body && body.packageManifest
        ? body.packageManifest
        : rawBody;
    if (!manifest || typeof manifest !== 'object' || !('contents' in manifest)) {
      throw new AgentisError('VALIDATION_FAILED', 'manifest is required');
    }
    const overrides = packageImportOverridesSchema.parse(body.overrides) ?? {};
    const imported = packager.importManifest(s, manifest as PackageManifest);
    const agentOverrides = overrides.agent ? compactAgentOverrides(overrides.agent) : undefined;
    const used = packager.usePackage(s, imported.packageId, { agent: agentOverrides });
    return c.json({
      packageId: imported.packageId,
      ...(used.kind === 'workflow' ? { workflowId: used.resourceId } : { agentId: used.resourceId }),
      resourceId: used.resourceId,
      path: used.path,
      warnings: imported.warnings,
    }, 201);
  });

  // ── Duplicate a package by ID ───────────────────────────────────────────────
  app.post('/:id/duplicate', (c) => {
    const ws = getWorkspace(c);
    const s = scope(c);
    const id = c.req.param('id');
    const src = packager.get(id, ws.workspaceId);
    const contents = src.contents as PackageContents;
    const row = packager.create(
      s,
      { name: `Copy of ${src.name}`, version: src.version, description: src.description ?? undefined },
      src.kind as Parameters<typeof packager.create>[2],
      contents,
    );
    return c.json(toPackageDto(row), 201);
  });

  app.post('/install-local', async (c) => {
    const s = scope(c);
    const body = installLocalSchema.parse(await c.req.json());
    const m = body.manifest;

    // V1 trust rule (§9.2): local install cannot ship `builtin`.
    for (const s of m.extensions) {
      if (s.runtime === 'builtin') {
        throw new AgentisError(
          'VALIDATION_FAILED',
          `extension ${s.slug}: builtin runtime is reserved for Nexseed-shipped extensions`,
        );
      }
    }

    const contents: AgentisPackageContents = {
      kind: 'agentis',
      agents: m.agents.map((agent) => ({
        name: agent.name,
        adapterType: agent.adapterType,
        capabilityTags: agent.capabilityTags,
        config: agent.defaultConfig,
        role: 'agent',
      })),
      extensions: m.extensions.map((extension) => ({
        name: extension.name,
        slug: extension.slug,
        version: extension.version,
        runtime: extension.runtime,
        manifest: {
          name: extension.name,
          slug: extension.slug,
          version: extension.version,
          runtime: extension.runtime,
          entrypoint: extension.entrypoint,
          capabilityTags: extension.capabilityTags,
          operations: extension.operations ?? [{
            name: 'execute',
            inputSchema: extension.inputSchema ?? {},
            outputSchema: extension.outputSchema ?? {},
          }],
          timeoutMs: extension.timeoutMs,
        },
      })),
      workflows: m.workflowTemplates.map((tpl) => ({
        slug: tpl.slug,
        title: tpl.name,
        description: tpl.description || tpl.summary || null,
        graph: tpl.graph,
        settings: { variables: tpl.variables },
      })),
      integrations: [],
      credentialSlots: [],
      knowledgeSeeds: m.knowledgeSeeds,
      surfaces: [],
      collections: [],
      screenshotUrls: [],
    };

    const row = packager.create(
      s,
      { name: m.name, version: m.version, description: m.summary },
      'agentis',
      contents,
    );
    const installed = packager.usePackage(s, row.id);

    return c.json(
      {
        packageId: row.id,
        resourceId: installed.resourceId,
        path: installed.path,
        name: m.name,
        version: m.version,
        extensions: contents.extensions.map((extension) => ({ slug: extension.slug })),
        agents: contents.agents.map((agent) => ({ name: agent.name })),
        workflows: contents.workflows.map((workflow) => ({ slug: workflow.slug, title: workflow.title })),
      },
      201,
    );
  });

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    packager.deletePackage(id, ws.workspaceId);
    return c.json({ ok: true });
  });

  return app;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function compactAgentOverrides(input: { name?: string; role?: string | null; reportsTo?: string | null }) {
  const out: { name?: string; role?: string | null; reportsTo?: string | null } = {};
  if (input.name !== undefined) out.name = input.name;
  if (input.role !== undefined) out.role = input.role;
  if (input.reportsTo !== undefined) out.reportsTo = input.reportsTo;
  return out;
}
