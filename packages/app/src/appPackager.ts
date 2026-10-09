/**
 * AppManifestService / AppPackager — the projection between the three isomorphic
 * representations of an Agentic App (AGENTIC-SYSTEMS-ARCHITECTURE §2, §17):
 *
 *   DB rows  ──toManifest──►  AppManifest (IR)  ──serialize──►  .agentisapp
 *   DB rows  ◄─fromManifest─  AppManifest (IR)  ◄─deserialize─  .agentisapp
 *
 * `toManifest`/`fromManifest` are the canonical projection (DoD gate 1). They
 * must round-trip: `rows → manifest → rows → manifest` is identity modulo
 * server-assigned ids/slug. `serialize`/`deserialize` add the integrity envelope
 * (sha256 over the canonical manifest); deserialize rejects tampering.
 *
 * Collections project SCHEMA only; rows never travel (empty-with-schema install,
 * §14.4). `export`/`import` are thin wrappers kept for the existing routes.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import {
  AgentisError,
  appManifestSchema,
  appIdentitySchema,
  appInstallPreviewSchema,
  canonicalizeManifest,
  collectionSchemaSchema,
  upsertSurfaceSchema,
  surfaceActionSchema,
  type AppManifest,
  type AppManifestEnvelope,
  type AppInstallPreview,
  type ManifestAgent,
  type BundleFidelity,
  type ViewNode,
  type WorkflowGraph,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { AppStore } from './appStore.js';
import { AppDatastore } from './appDatastore.js';
import { AppSurfaceStore } from './appSurfaceStore.js';
import { AppDefinitionStore } from './appDefinitionStore.js';
import { chunkDocument, definitionFacets, hasAgenticDefinition } from './appPackagingUtils.js';
import type { BrainReader, BrainWriter } from './brainPort.js';
import { rewriteNodeRefs, rewriteScriptRefs, type RefIdMap } from './appRefs.js';
import { computeAppClosure, CONVERSATION_SCRIPT_COLLECTION, CONVERSATION_SCRIPT_KEY, type AppClosure, type AppRevisionTarget } from './appClosure.js';

/** Options controlling how much learned intelligence an App export carries. */
export interface AppExportOptions {
  /** Immutable graph line to export. Defaults to the production-active line. */
  revisionTarget?: AppRevisionTarget;
  /** `full` carries brains + collection rows; `shareable` (default) carries neither. */
  fidelity?: BundleFidelity;
  /** Brain reader (api-supplied). Absent ⇒ no brains travel regardless of fidelity. */
  brain?: BrainReader;
  includeAppBrain?: boolean;
  includeAgentBrains?: boolean;
  includeCollectionData?: boolean;
  /** Per-collection row cap. */
  collectionRowCap?: number;
  /**
   * Closure items the operator chose to leave out, as `"<kind>:<id>"` (e.g.
   * `"agent:abc"`). Unticking a required dependency is ALLOWED — the operator
   * owns this call — and surfaces as a warning here and in the import preview
   * rather than being silently blocked.
   */
  exclude?: string[];
  /** Collected non-fatal notes (e.g. truncated collections) appended here. */
  warnings?: string[];
}

/** Options controlling how an App install rehydrates intelligence + team. */
export interface AppImportOptions {
  brain?: BrainWriter;
  includeAppBrain?: boolean;
  includeAgentBrains?: boolean;
  includeCollectionData?: boolean;
  /** Existing workspace agents by name → id, so app agents relink instead of duplicating. */
  agentNameToId?: Map<string, string>;
  warnings?: string[];
}

// Hash the manifest AS GIVEN (raw object), never a schema-parsed projection.
// canonicalizeManifest is a pure deep key-sort, so it is well-defined on the
// raw manifest — and hashing raw is what makes the checksum survive schema
// evolution (see deserialize).
function checksum(manifest: unknown): string {
  return createHash('sha256').update(canonicalizeManifest(manifest as AppManifest)).digest('hex');
}

/**
 * The transported envelope with the manifest kept RAW (unknown). Import paths
 * must not schema-parse the manifest before verifying the checksum — parsing
 * strips/defaults fields and changes the canonical form, so an authentic but
 * older export would fail verification. Callers pass this shape (or a fully
 * typed AppManifestEnvelope, which is assignable) into deserialize.
 */
export interface RawAppEnvelope {
  format?: unknown;
  formatVersion?: unknown;
  manifest: unknown;
  checksum?: unknown;
  exportedAt?: unknown;
}

function permissionSummary(manifest: AppManifest): string[] {
  const permissions = new Set<string>();
  for (const collection of manifest.collections) permissions.add(`data:${collection.name}`);
  for (const plugin of new Set([...manifest.requiredPlugins, ...manifest.identity.requiredPlugins])) {
    permissions.add(`plugin:${plugin}`);
  }
  if (manifest.policy.customCode === 'allowed' || manifest.surfaces.some((surface) => hasCustomView(surface.view ?? null))) {
    permissions.add('custom-code');
  }
  if (manifest.surfaces.some((surface) => surface.shareable || surface.kind === 'public')) {
    permissions.add('public-share');
  }
  for (const grant of manifest.policy.grants) {
    const scopes = grant.scopes.length > 0 ? `:${grant.scopes.join(',')}` : '';
    permissions.add(`grant:${grant.source ?? 'native'}:${grant.capability}${scopes}`);
  }
  for (const capability of manifest.capabilities) {
    permissions.add(`declares-capability:${capability.name}:${capability.target}`);
  }
  for (const surface of manifest.surfaces) {
    for (const action of surface.actions) {
      if (action.kind === 'data') permissions.add(`data-action:${action.target}`);
      if (action.kind === 'workflow') permissions.add(`workflow:${action.target}`);
      if (action.kind === 'tool') permissions.add(`tool:${action.target}`);
      if (action.kind === 'capability') permissions.add(`capability:${action.target}`);
    }
  }
  // Provenance gate (masterplan 0.4): an imported bundle whose workflows carry
  // executable payloads runs that code on the INSTALLER's host on first run. The
  // through install, so this only gates third-party bundles.
  for (const permission of executablePayloadPermissions(manifest)) permissions.add(permission);
  return [...permissions].sort((a, b) => a.localeCompare(b));
}

/** Permissions for workflow nodes that execute code / drive a browser on the host. */
function executablePayloadPermissions(manifest: AppManifest): string[] {
  const out = new Set<string>();
  for (const workflow of manifest.workflows) {
    const graph = workflow.graph as { nodes?: unknown } | null | undefined;
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    for (const node of nodes) {
      const config = (node as { config?: { kind?: string; language?: string } } | null)?.config;
      if (!config) continue;
      if (config.kind === 'code') out.add(`executes-code:${config.language ?? 'javascript'}`);
      else if (config.kind === 'browser') out.add('controls-browser');
      else if (config.kind === 'component_task') out.add('executes-component');
    }
  }
  for (const extension of manifest.extensions) {
    if (extension.runtime === 'node_worker') out.add('executes-code:javascript');
    if (extension.runtime === 'docker_sandbox') out.add('executes-container');
    if (extension.runtime === 'component_oci') {
      const component = objectRecord(objectRecord(extension.manifest).component);
      const runtime = objectRecord(component.runtime);
      out.add(`executes-component:${typeof runtime.language === 'string' ? runtime.language : 'unknown'}`);
      for (const permission of stringArray(component.permissions)) out.add(`component-permission:${permission}`);
    }
  }
  return [...out];
}

function hasCustomView(node: ViewNode | null): boolean {
  if (!node) return false;
  if (node.type === 'CustomView') return true;
  if ('children' in node) return node.children.some(hasCustomView);
  if (node.type === 'List') return hasCustomView(node.item);
  return false;
}

export class AppPackager {
  private readonly apps: AppStore;
  private readonly data: AppDatastore;
  private readonly surfaces: AppSurfaceStore;
  constructor(private readonly db: AgentisSqliteDb) {
    this.apps = new AppStore(db);
    this.data = new AppDatastore(db);
    this.surfaces = new AppSurfaceStore({ db });
  }

  /** rows → canonical AppManifest IR. `opts.fidelity==='full'` carries brains + rows. */
  toManifest(workspaceId: string, appId: string, opts: AppExportOptions = {}): AppManifest {
    const app = this.apps.get(workspaceId, appId);
    const definition = new AppDefinitionStore(this.db).get(workspaceId, appId);
    const full = opts.fidelity === 'full';
    const withData = full && (opts.includeCollectionData ?? true);
    const withAppBrain = full && (opts.includeAppBrain ?? true) && !!opts.brain;
    const withAgentBrains = full && (opts.includeAgentBrains ?? true) && !!opts.brain;
    const cap = opts.collectionRowCap ?? 5000;

    const surfaces = this.surfaces.list(workspaceId, appId).map((s) => ({
      name: s.name,
      kind: s.kind,
      view: s.view,
      actions: s.actions.map((a) => surfaceActionSchema.parse(a)),
      shareable: s.shareable,
    }));
    const collections = this.data.listCollections(workspaceId, appId).map((col) => {
      let seed: Record<string, unknown>[] = [];
      let records: ReturnType<AppDatastore['exportRecords']>['records'] | undefined;
      if (withData) {
        const dump = this.data.exportRows(workspaceId, appId, col.name, cap);
        seed = dump.rows;
        const fullDump = this.data.exportRecords(workspaceId, appId, col.name, cap);
        records = fullDump.records;
        if (dump.truncated) opts.warnings?.push(`Collection "${col.name}" exceeded ${cap} rows; only the first ${cap} were exported.`);
      }
      return { name: col.name, schema: col.schema, seed, ...(records ? { records } : {}) };
    });
    // The App's full dependency CLOSURE — what it needs to run, not merely what
    // it owns. An `agent_task` agent seated elsewhere, a bare sub-workflow, a
    // workspace-scoped knowledge base: all previously dropped, producing a package
    // that installed cleanly and failed at run time.
    const revisionTarget = opts.revisionTarget ?? 'active';
    const closure = computeAppClosure(this.db, workspaceId, appId, revisionTarget);
    if (opts.warnings) opts.warnings.push(...closure.warnings);
    const excluded = new Set(opts.exclude ?? []);
    const keep = (kind: string, id: string) => !excluded.has(`${kind}:${id}`);

    const workflows = this.#exportWorkflows(
      workspaceId,
      closure.workflowIds.filter((id) => keep('workflow', id)),
      revisionTarget,
      opts.warnings,
    );
    const agents = this.#exportAgents(
      workspaceId,
      appId,
      closure.agentIds.filter((id) => keep('agent', id)),
      app.ownerAgentId,
      withAgentBrains ? opts.brain : undefined,
    );
    const knowledge = this.#exportKnowledge(workspaceId, closure.knowledgeBaseIds.filter((id) => keep('knowledgeBase', id)));
    const extensions = this.#exportExtensions(workspaceId, closure.extensionIds.filter((id) => keep('extension', id)));
    // Secrets and code-resident connectors are DECLARED, never copied.
    const requirements = closure.items
      .filter((item) => !item.transportable)
      .map((item) => ({
        kind: item.kind === 'credential' ? ('credential' as const)
          : item.kind === 'connection' ? ('connection' as const)
          : item.kind === 'connector' ? ('connector' as const)
          : ('plugin' as const),
        key: item.id,
        label: item.label,
        detail: item.reason,
      }));

    return appManifestSchema.parse({
      manifestVersion: definition ? 3 : 2,
      // Rebinding keys for the App's own data_query/data_mutate self-references.
      exportAppId: appId,
      identity: appIdentitySchema.parse({
        ...app.manifest,
        slug: app.slug,
        name: app.name,
        version: app.version,
        icon: app.icon,
        entrySurfaceId: app.entrySurfaceId,
      }),
      policy: app.policy,
      workflows,
      surfaces,
      collections,
      agents,
      knowledge,
      extensions,
      requirements,
      ...(withAppBrain ? { brain: { atoms: opts.brain!.exportScope(workspaceId, appId) } } : {}),
      source: app.source,
      ...definitionFacets(definition ?? {}),
    });
  }

  /**
   * Knowledge as portable seed documents: chunks are re-joined into their source
   * document text and re-chunked/re-embedded on install, so no embeddings travel
   * (mirrors the workspace bundle's knowledge handling).
   */
  #exportKnowledge(workspaceId: string, knowledgeBaseIds: string[]): AppManifest['knowledge'] {
    if (knowledgeBaseIds.length === 0) return [];
    const bases = this.db
      .select({ id: schema.knowledgeBases.id, name: schema.knowledgeBases.name, description: schema.knowledgeBases.description })
      .from(schema.knowledgeBases)
      .where(and(eq(schema.knowledgeBases.workspaceId, workspaceId), inArray(schema.knowledgeBases.id, knowledgeBaseIds)))
      .all();
    return bases.map((base) => {
      const docs = this.db
        .select({ id: schema.kbDocuments.id, name: schema.kbDocuments.name })
        .from(schema.kbDocuments)
        .where(and(eq(schema.kbDocuments.knowledgeBaseId, base.id), eq(schema.kbDocuments.workspaceId, workspaceId)))
        .all();
      const documents = docs.flatMap((doc) => {
        const content = this.db
          .select({ content: schema.kbChunks.content, chunkIndex: schema.kbChunks.chunkIndex })
          .from(schema.kbChunks)
          .where(eq(schema.kbChunks.documentId, doc.id))
          .all()
          .sort((a, b) => a.chunkIndex - b.chunkIndex)
          .map((c) => c.content)
          .join('\n')
          .trim();
        return content ? [{ title: doc.name, content, tags: [], metadata: {} }] : [];
      });
      return { exportId: base.id, name: base.name, description: base.description ?? null, documents };
    });
  }

  /** Non-builtin extensions the App's steps invoke (builtins ship with the host). */
  #exportExtensions(workspaceId: string, extensionIds: string[]): AppManifest['extensions'] {
    if (extensionIds.length === 0) return [];
    return this.db
      .select()
      .from(schema.extensions)
      .where(and(eq(schema.extensions.workspaceId, workspaceId), inArray(schema.extensions.id, extensionIds)))
      .all()
      .filter((row) => row.runtime !== 'builtin')
      .map((row) => {
        const manifest = objectRecord(row.manifest);
        const bundleDir = typeof manifest.bundleDir === 'string' ? manifest.bundleDir : null;
        const bundleFiles = row.runtime === 'component_oci' && bundleDir ? readPortableBundle(bundleDir) : [];
        const portableManifest = { ...manifest };
        delete portableManifest.bundleDir;
        return {
          exportId: row.id,
          name: row.name,
          slug: row.slug,
          version: row.version,
          runtime: row.runtime as 'node_worker' | 'docker_sandbox' | 'component_oci',
          manifest: portableManifest,
          bundleFiles,
        };
      });
  }

  /**
   * The App's workflows PLUS every workflow they reach through a `subflow` /
   * `loop` node, followed transitively.
   *
   * App-owned selection alone is not enough: a subflow child is frequently a BARE
   * workflow (`appId` null, created independently and never adopted), so the old
   * `WHERE appId = :appId` projection silently dropped it and the imported App
   * referenced a workflow that did not exist in the target workspace. Each entry
   * carries `exportId` (its source id) so install can rebind the references.
   */
  #exportWorkflows(workspaceId: string, workflowIds: string[], revisionTarget: AppRevisionTarget, warnings?: string[]): AppManifest['workflows'] {
    if (workflowIds.length === 0) return [];
    const rows = this.db
      .select({
        id: schema.workflows.id,
        title: schema.workflows.title,
        description: schema.workflows.description,
        graph: schema.workflows.graph,
        activeRevisionId: schema.workflows.activeRevisionId,
        candidateRevisionId: schema.workflows.candidateRevisionId,
      })
      .from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, workspaceId), inArray(schema.workflows.id, workflowIds)))
      .all();
    return rows.map((w) => {
      const revisionId = revisionTarget === 'candidate' ? w.candidateRevisionId ?? w.activeRevisionId : w.activeRevisionId;
      const revision = revisionId
        ? this.db.select({ graph: schema.workflowGraphRevisions.graphJson })
          .from(schema.workflowGraphRevisions).where(eq(schema.workflowGraphRevisions.id, revisionId)).get()
        : null;
      if (revisionTarget === 'candidate' && !w.candidateRevisionId) warnings?.push(`Workflow "${w.title}" has no candidate; its active revision was exported.`);
      if (!revision) warnings?.push(`Workflow "${w.title}" has no ${revisionTarget} revision row; its compatibility graph mirror was exported.`);
      return { title: w.title, description: w.description ?? null, graph: revision?.graph ?? w.graph, exportId: w.id };
    });
  }

  /**
   * The App's cast as portable manifest agents, name-sorted.
   *
   * Sourced from the CLOSURE, not just `listMembers` + owner: an agent invoked by
   * an `agent_task` step may not be seated on the App at all, and dropping it was
   * the reason an exported App arrived with none of its agents.
   */
  #exportAgents(
    workspaceId: string,
    appId: string,
    agentIds: string[],
    ownerAgentId: string | null,
    brain: BrainReader | undefined,
  ): ManifestAgent[] {
    const ids = new Set<string>(agentIds);
    if (ids.size === 0) return [];
    const roleByAgent = new Map(this.apps.listMembers(workspaceId, appId).map((m) => [m.agentId, m.role]));
    const rows = this.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), inArray(schema.agents.id, [...ids])))
      .all();
    return rows
      .map((a) => {
        const memberRole = roleByAgent.get(a.id);
        const agent: ManifestAgent = {
          name: a.name,
          exportId: a.id,
          role: memberRole === 'operator' ? 'operator' : 'worker',
          adapterType: a.adapterType,
          instructions: a.instructions ?? null,
          capabilityTags: stringArray(a.capabilityTags),
          owner: a.id === ownerAgentId,
          ...(memberRole ? { memberRole } : {}),
          config: portableAgentConfig(a.config),
          avatarGlyph: a.avatarGlyph ?? null,
          runtimeModel: a.runtimeModel ?? null,
          runtimeRequirement: {
            adapterFamily: a.adapterType,
            preferredModel: a.runtimeModel ?? null,
            requiredAffordances: stringArray(a.capabilityTags),
          },
          ...(brain ? { brain: { atoms: brain.exportScope(workspaceId, a.id) } } : {}),
        };
        return agent;
      })
      .sort((x, y) => x.name.localeCompare(y.name));
  }

  /** canonical AppManifest IR → rows (creates a fresh App). Collections come back EMPTY. */
  /**
   * Non-mutating install summary. `workspaceId` enables reuse detection — with it,
   * an agent that already exists here is reported as `reuse` rather than `create`,
   * which is the difference between "this will add 5 agents" and the truth.
   */
  preview(envelope: RawAppEnvelope, workspaceId?: string): AppInstallPreview {
    const manifest = this.deserialize(envelope);
    const warnings: string[] = [];
    if (manifest.migrations.length > 0) warnings.push('Migrations are declared but fresh installs do not apply upgrade migrations.');
    if (manifest.policy.customCode === 'allowed') warnings.push('This app enables CustomView code; review before installing into shared workspaces.');

    const seedRows = manifest.collections.reduce((count, collection) => count + (collection.seed?.length ?? 0), 0);
    const brainAtoms = (manifest.brain?.atoms.length ?? 0)
      + manifest.agents.reduce((n, a) => n + (a.brain?.atoms.length ?? 0), 0);
    const knowledgeDocs = manifest.knowledge.reduce((n, k) => n + k.documents.length, 0);
    if (brainAtoms > 0 || seedRows > 0) {
      warnings.push(`This package carries learned state: ${brainAtoms} memor${brainAtoms === 1 ? 'y' : 'ies'} and ${seedRows} data row(s).`);
    }

    // Itemise EVERYTHING, with what will happen to it. "How many" is not enough
    // for an operator deciding whether to let a package into their workspace —
    // they need to see which agents arrive, which are reused, and what they will
    // have to reconnect themselves.
    const contents: AppInstallPreview['contents'] = [
      ...manifest.workflows.map((w) => ({ kind: 'workflow' as const, label: w.title, required: true, action: 'create' as const })),
      ...manifest.agents.map((a) => {
        // Agents match by NAME on install: an existing one is reused (and keeps
        // its own memory) rather than duplicated.
        const existing = workspaceId ? this.#findAgentByName(this.db, workspaceId, a.name) : null;
        return {
          kind: 'agent' as const,
          label: a.name,
          required: true,
          action: existing ? ('reuse' as const) : ('create' as const),
          detail: existing
            ? 'Already exists here — will be reused and seated on this App'
            : a.brain && a.brain.atoms.length > 0
              ? `Arrives with ${a.brain.atoms.length} learned memor${a.brain.atoms.length === 1 ? 'y' : 'ies'}`
              : undefined,
        };
      }),
      ...manifest.knowledge.map((k) => ({
        kind: 'knowledgeBase' as const,
        label: k.name,
        required: false,
        action: 'create' as const,
        detail: `${k.documents.length} document(s)`,
      })),
      ...manifest.extensions.map((e) => ({
        kind: 'extension' as const,
        label: e.name,
        required: true,
        action: 'create' as const,
        detail: `${e.slug} · ${e.runtime}`,
      })),
      ...manifest.collections.map((c) => ({
        kind: 'collection' as const,
        label: c.name,
        required: true,
        action: 'create' as const,
        detail: c.seed && c.seed.length > 0 ? `${c.seed.length} row(s)` : 'schema only',
      })),
      // Requirements can never be copied — they are always the operator's to supply.
      ...manifest.requirements.map((r) => ({
        kind: r.kind === 'plugin' ? ('extension' as const) : (r.kind as 'credential' | 'connection' | 'connector'),
        label: r.label,
        required: true,
        action: 'setup' as const,
        detail: r.detail,
      })),
    ];

    const requirementsOf = (kind: string) => manifest.requirements.filter((r) => r.kind === kind);
    const setup = {
      credentials: requirementsOf('credential').map((r) => ({ key: r.key, label: r.label })),
      connections: requirementsOf('connection').map((r) => ({ key: r.key, label: r.label })),
      connectors: requirementsOf('connector').map((r) => r.label),
      plugins: [...new Set([...manifest.requiredPlugins, ...requirementsOf('plugin').map((r) => r.label)])],
    };
    if (setup.plugins.length > 0) warnings.push('Required plugins must already be available in this Agentis instance.');
    if (setup.credentials.length + setup.connections.length + setup.connectors.length > 0) {
      warnings.push('Some connections must be reconnected after install — no secrets travel in a package.');
    }

    return appInstallPreviewSchema.parse({
      format: envelope.format,
      formatVersion: envelope.formatVersion,
      checksum: envelope.checksum,
      exportedAt: envelope.exportedAt,
      identity: manifest.identity,
      source: manifest.source ?? null,
      counts: {
        workflows: manifest.workflows.length,
        surfaces: manifest.surfaces.length,
        collections: manifest.collections.length,
        agents: manifest.agents.length,
        capabilities: manifest.capabilities.length,
        dependencies: manifest.dependencies.length,
        migrations: manifest.migrations.length,
        knowledgeDocs,
        brainAtoms,
        collectionRows: seedRows,
        extensions: manifest.extensions.length,
      },
      facets: {
        workflows: manifest.workflows.map((workflow) => workflow.title),
        surfaces: manifest.surfaces.map((surface) => surface.name),
        collections: manifest.collections.map((collection) => collection.name),
        agents: manifest.agents.map((agent) => agent.name),
        knowledge: manifest.knowledge.map((k) => k.name),
        extensions: manifest.extensions.map((e) => e.name),
      },
      contents,
      setup,
      requiredPlugins: manifest.requiredPlugins,
      permissions: permissionSummary(manifest),
      scanWarnings: [],
      warnings,
    });
  }

  fromManifest(workspaceId: string, userId: string, manifest: AppManifest, opts: AppImportOptions = {}): { appId: string } {
    const parsed = appManifestSchema.parse(manifest);
    return this.db.transaction((tx) => this.createFromManifestRows(tx as AgentisSqliteDb, workspaceId, userId, parsed, opts));
  }

  private createFromManifestRows(db: AgentisSqliteDb, workspaceId: string, userId: string, parsed: AppManifest, opts: AppImportOptions): { appId: string } {
    const apps = new AppStore(db);
    const data = new AppDatastore(db);
    const surfaces = new AppSurfaceStore({ db });
    const withData = opts.includeCollectionData ?? true;
    const withAgentBrains = (opts.includeAgentBrains ?? true) && !!opts.brain;
    const withAppBrain = (opts.includeAppBrain ?? true) && !!opts.brain;
    const app = apps.create(workspaceId, userId, {
      name: parsed.identity.name,
      description: '',
      ...(parsed.identity.icon ? { icon: parsed.identity.icon } : {}),
    });
    // Carry version + policy onto the new app.
    apps.update(workspaceId, app.id, {
      version: parsed.identity.version,
      policy: parsed.policy,
      source: parsed.source ?? null,
      installedChecksum: checksum(parsed),
    });

    // ── Team FIRST, then workflows. ──────────────────────────────────────────
    // Ordering is load-bearing: workflows used to be inserted before agents
    // existed, which made rebinding `agent_task.agentId` impossible — every
    // imported workflow pointed at an agent id from the EXPORTER's workspace.
    // Resolve each agent by name against already-installed workspace agents
    // (nameMap) so a whole-workspace bundle does not duplicate them; create a
    // minimal agent only for a standalone App import. Owner relink touches ONLY
    // apps.ownerAgentId — it must never clear the agent's reportsTo/spaceId
    // (that org-chart detach is the staffApp side effect, which install never runs).
    const agentIdByExportId = new Map<string, string>();
    for (const magent of parsed.agents) {
      let agentId = opts.agentNameToId?.get(magent.name) ?? this.#findAgentByName(db, workspaceId, magent.name);
      if (!agentId) {
        agentId = this.#createAgent(db, workspaceId, userId, magent);
        opts.agentNameToId?.set(magent.name, agentId);
      }
      if (magent.exportId) agentIdByExportId.set(magent.exportId, agentId);
      apps.addMember(workspaceId, app.id, agentId, magent.memberRole ?? (magent.owner ? 'operator' : 'worker'));
      if (magent.owner) apps.update(workspaceId, app.id, { ownerAgentId: agentId });
      if (withAgentBrains && magent.brain && magent.brain.atoms.length > 0) {
        opts.brain!.importScope(workspaceId, agentId, magent.brain.atoms, 'agent');
      }
    }

    // Mint every workflow id BEFORE inserting, so sibling sub-workflow references
    // resolve, then rewrite ALL entity refs in one pass through the shared table
    // (see appRefs.ts) — workflows, agents, and the App's own data_query/
    // data_mutate self-references. An unrewritten ref is a syntactically valid
    // UUID pointing at another workspace: the App imports "fine" and fails at run.
    const workflowIdByExportId = new Map<string, string>();
    const minted = parsed.workflows.map((wf) => {
      const id = randomUUID();
      if (wf.exportId) workflowIdByExportId.set(wf.exportId, id);
      return { id, wf };
    });
    // Knowledge + extensions must exist before workflows too, for the same reason
    // agents do: their ids appear inside node configs.
    const knowledgeIdByExportId = this.#installKnowledge(db, workspaceId, app.id, parsed.knowledge ?? []);
    const extensionIdByExportId = this.#installExtensions(db, workspaceId, userId, parsed.extensions ?? []);

    const refIdMap: RefIdMap = {
      workflow: workflowIdByExportId,
      agent: agentIdByExportId,
      knowledgeBase: knowledgeIdByExportId,
      extension: extensionIdByExportId,
      ...(parsed.exportAppId ? { app: new Map([[parsed.exportAppId, app.id]]) } : {}),
    };
    for (const { id, wf } of minted) {
      const now = new Date().toISOString();
      db
        .insert(schema.workflows)
        .values({
          id,
          workspaceId,
          userId,
          appId: app.id,
          title: wf.title,
          description: wf.description ?? null,
          graph: rewriteNodeRefs(wf.graph, refIdMap) as WorkflowGraph,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    for (const col of parsed.collections) {
      data.defineCollection(workspaceId, app.id, { name: col.name, schema: collectionSchemaSchema.parse(col.schema) });
      if (withData && col.records && col.records.length > 0) {
        const records = col.name === CONVERSATION_SCRIPT_COLLECTION
          ? col.records.map((record) => ({ ...record, data: rewriteConversationScriptRow(record.data, refIdMap) }))
          : col.records;
        const res = data.importRecords(workspaceId, app.id, col.name, records);
        if (res.failed.length > 0) {
          opts.warnings?.push(`Collection "${col.name}": ${res.failed.length} of ${records.length} full-fidelity row(s) failed to import.`);
        }
      } else if (withData && col.seed && col.seed.length > 0) {
        // The conversation-script collection carries workflow/agent ids INSIDE its
        // rows (a script is a datastore row, not a graph), so it needs the same
        // rebind as workflow node configs — otherwise a stage keeps pointing at
        // the exporter's workflow and imports as "a workflow outside this App".
        const seed = col.name === CONVERSATION_SCRIPT_COLLECTION
          ? col.seed.map((row) => rewriteConversationScriptRow(row, refIdMap))
          : col.seed;
        const res = data.insertMany(workspaceId, app.id, col.name, seed, userId);
        if (res.failed.length > 0) {
          opts.warnings?.push(`Collection "${col.name}": ${res.failed.length} of ${col.seed.length} row(s) failed to import.`);
        }
      }
    }
    for (const s of parsed.surfaces) {
      surfaces.upsert(workspaceId, app.id, upsertSurfaceSchema.parse({ name: s.name, kind: s.kind, view: s.view, actions: s.actions, shareable: s.shareable }));
    }
    if (parsed.surfaces[0]) {
      apps.update(workspaceId, app.id, { entrySurfaceId: parsed.surfaces[0].name });
    }

    // App-scoped Brain memory (scope_id = appId).
    if (withAppBrain && parsed.brain && parsed.brain.atoms.length > 0) {
      opts.brain!.importScope(workspaceId, app.id, parsed.brain.atoms, 'app');
    }

    if (hasAgenticDefinition(parsed)) {
      new AppDefinitionStore(db).upsert(workspaceId, app.id, definitionFacets(parsed));
    }

    return { appId: app.id };
  }

  /**
   * Recreate the App's knowledge, scoped to the NEW app, returning old→new ids so
   * `knowledge.knowledgeBaseId` can be rebound.
   *
   * Documents are re-chunked here rather than shipping chunk boundaries, and no
   * embeddings travel — the re-embed sweep vectorises them with the target
   * workspace's own provider, so vectors are always comparable by construction.
   */
  #installKnowledge(
    db: AgentisSqliteDb,
    workspaceId: string,
    appId: string,
    bases: AppManifest['knowledge'],
  ): Map<string, string> {
    const idMap = new Map<string, string>();
    for (const base of bases) {
      const kbId = randomUUID();
      const now = new Date().toISOString();
      db.insert(schema.knowledgeBases).values({
        id: kbId,
        workspaceId,
        // Scope to the importing App so its knowledge travels WITH it and is not
        // silently shared back into the workspace.
        scopeId: appId,
        name: base.name,
        description: base.description ?? null,
        embeddingModel: 'lexical-v1',
        embeddingDimension: 0,
        chunkingConfig: { maxTokens: 240, overlapTokens: 40 },
        createdAt: now,
        updatedAt: now,
      }).run();
      for (const doc of base.documents) {
        const docId = randomUUID();
        db.insert(schema.kbDocuments).values({
          id: docId,
          knowledgeBaseId: kbId,
          workspaceId,
          name: doc.title,
          mimeType: 'text/plain',
          status: 'ready',
          tokenCount: 0,
          createdAt: now,
          updatedAt: now,
        }).run();
        chunkDocument(doc.content).forEach((content, index) => {
          db.insert(schema.kbChunks).values({
            id: randomUUID(),
            documentId: docId,
            knowledgeBaseId: kbId,
            workspaceId,
            chunkIndex: index,
            content,
            metadata: { kind: 'agentis_seed' },
            tokenCount: 0,
            createdAt: now,
          }).run();
        });
      }
      if (base.exportId) idMap.set(base.exportId, kbId);
    }
    return idMap;
  }

  /**
   * Resolve extensions against the target workspace by slug, creating one only
   * when absent. Extensions are shared infrastructure — duplicating a slug the
   * workspace already runs would fork behaviour rather than reuse it.
   */
  #installExtensions(
    db: AgentisSqliteDb,
    workspaceId: string,
    userId: string,
    extensions: AppManifest['extensions'],
  ): Map<string, string> {
    const idMap = new Map<string, string>();
    for (const ext of extensions) {
      const existing = db
        .select({ id: schema.extensions.id, version: schema.extensions.version, runtime: schema.extensions.runtime })
        .from(schema.extensions)
        .where(and(eq(schema.extensions.workspaceId, workspaceId), eq(schema.extensions.slug, ext.slug)))
        .get();
      let id = existing?.id;
      if (existing && (existing.version !== ext.version || existing.runtime !== ext.runtime)) {
        throw new AgentisError(
          'RESOURCE_CONFLICT',
          `Extension ${ext.slug}@${existing.version} (${existing.runtime}) conflicts with packaged ${ext.version} (${ext.runtime}).`,
        );
      }
      if (!id) {
        id = randomUUID();
        const now = new Date().toISOString();
        const installedManifest = ext.runtime === 'component_oci'
          ? { ...ext.manifest, bundleDir: materializePortableBundle(ext) }
          : ext.manifest;
        db.insert(schema.extensions).values({
          id,
          workspaceId,
          userId,
          name: ext.name,
          slug: ext.slug,
          version: ext.version,
          runtime: ext.runtime,
          manifest: installedManifest as never,
          createdAt: now,
          updatedAt: now,
        }).run();
      }
      if (ext.exportId) idMap.set(ext.exportId, id);
    }
    return idMap;
  }

  #findAgentByName(db: AgentisSqliteDb, workspaceId: string, name: string): string | null {
    const row = db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.name, name)))
      .get();
    return row?.id ?? null;
  }

  /** Create a minimal agent row for a standalone App import (no org-chart wiring). */
  #createAgent(db: AgentisSqliteDb, workspaceId: string, userId: string, magent: ManifestAgent): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    db
      .insert(schema.agents)
      .values({
        id,
        workspaceId,
        userId,
        name: magent.name,
        adapterType: magent.adapterType ?? 'http',
        capabilityTags: magent.capabilityTags,
        config: magent.config,
        instructions: magent.instructions ?? null,
        avatarGlyph: magent.avatarGlyph ?? null,
        runtimeModel: magent.runtimeModel ?? null,
        role: magent.memberRole ?? magent.role,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return id;
  }

  // ── Serialization envelope (.agentisapp) ────────────────────

  serialize(manifest: AppManifest): AppManifestEnvelope {
    const parsed = appManifestSchema.parse(manifest);
    const formatVersion = parsed.manifestVersion === 3 ? 3 : parsed.manifestVersion === 2 ? 2 : 1;
    return { format: '.agentisapp', formatVersion, manifest: parsed, checksum: checksum(parsed), exportedAt: new Date().toISOString() };
  }

  deserialize(envelope: RawAppEnvelope): AppManifest {
    if (envelope.format !== '.agentisapp') throw new AgentisError('VALIDATION_FAILED', 'not an .agentisapp envelope');
    // Verify the checksum against the RAW transported manifest — the same bytes
    // `serialize` hashed. Parsing first and hashing the parsed projection makes
    // the checksum brittle to schema evolution: when a later build drops or
    // defaults a manifest field (e.g. policy.audience/shareable), re-parsing an
    // OLD but authentic export changes its canonical form and the checksum
    // "mismatches" even though nothing was tampered with. Hash raw, then parse.
    if (checksum(envelope.manifest) !== envelope.checksum) {
      throw new AgentisError('VALIDATION_FAILED', 'checksum mismatch — package is corrupt or tampered');
    }
    return appManifestSchema.parse(envelope.manifest);
  }

  // ── Route-facing wrappers ───────────────────────────────────

  export(workspaceId: string, appId: string, opts: AppExportOptions = {}): AppManifestEnvelope {
    return this.serialize(this.toManifest(workspaceId, appId, opts));
  }

  import(workspaceId: string, userId: string, envelope: RawAppEnvelope, opts: AppImportOptions = {}): { appId: string } {
    return this.fromManifest(workspaceId, userId, this.deserialize(envelope), opts);
  }
}

/** Rebind the workflow/agent ids inside one conversation-script datastore row. */
function rewriteConversationScriptRow(row: Record<string, unknown>, idMap: RefIdMap): Record<string, unknown> {
  if (row.key !== CONVERSATION_SCRIPT_KEY || !row.script) return row;
  return { ...row, script: rewriteScriptRefs(row.script, idMap) };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function portableAgentConfig(value: unknown): Record<string, unknown> {
  const config = { ...objectRecord(value) };
  for (const localKey of ['binaryPath', 'command', 'cwd', 'repositoryPath', 'workingDirectory', 'env']) delete config[localKey];
  const runtimeProfile = objectRecord(config.runtimeProfile);
  if (Object.keys(runtimeProfile).length > 0) {
    const portableProfile = { ...runtimeProfile };
    delete portableProfile.projectRoot;
    config.runtimeProfile = portableProfile;
  }
  return config;
}

function readPortableBundle(bundleDir: string) {
  const root = path.resolve(bundleDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new AgentisError('VALIDATION_FAILED', `component bundle is missing at export: ${bundleDir}`);
  }
  const files: Array<{ path: string; sha256: string; dataBase64: string }> = [];
  let total = 0;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink()) {
        throw new AgentisError('VALIDATION_FAILED', `component bundle cannot contain symlink ${path.relative(root, absolute)}`);
      }
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const data = readFileSync(absolute);
        total += data.length;
        if (total > 100 * 1024 * 1024 || files.length >= 5_000) throw new AgentisError('VALIDATION_FAILED', 'component bundle exceeds portable package limits');
        files.push({
          path: path.relative(root, absolute).split(path.sep).join('/'),
          sha256: createHash('sha256').update(data).digest('hex'),
          dataBase64: data.toString('base64'),
        });
      }
    }
  };
  visit(root);
  return files;
}

function materializePortableBundle(ext: AppManifest['extensions'][number]): string {
  if (ext.bundleFiles.length === 0) throw new AgentisError('VALIDATION_FAILED', `component ${ext.slug} has no portable bundle files`);
  const component = objectRecord(objectRecord(ext.manifest).component);
  validatePortableComponent(component, ext.slug, new Set(ext.bundleFiles.map((file) => file.path)));
  const expectedHash = typeof component.bundleHash === 'string' ? component.bundleHash : '';
  const aggregate = createHash('sha256');
  let total = 0;
  const decoded = ext.bundleFiles.slice().sort((a, b) => a.path.localeCompare(b.path)).map((file) => {
    if (path.isAbsolute(file.path) || file.path.split(/[\\/]+/).includes('..')) throw new AgentisError('VALIDATION_FAILED', `unsafe component bundle path ${file.path}`);
    const data = Buffer.from(file.dataBase64, 'base64');
    total += data.length;
    if (total > 100 * 1024 * 1024) throw new AgentisError('VALIDATION_FAILED', 'component bundle exceeds 100MB');
    const digest = createHash('sha256').update(data).digest('hex');
    if (digest !== file.sha256) throw new AgentisError('VALIDATION_FAILED', `component file checksum mismatch: ${file.path}`);
    aggregate.update(file.path).update('\0').update(data).update('\0');
    return { ...file, data };
  });
  const actualHash = aggregate.digest('hex');
  if (expectedHash && actualHash !== expectedHash) throw new AgentisError('VALIDATION_FAILED', `component bundle checksum mismatch for ${ext.slug}`);
  const root = path.resolve(process.env.AGENTIS_DATA_DIR?.trim() || '.agentis', 'components');
  mkdirSync(root, { recursive: true });
  const target = path.join(root, actualHash);
  if (existsSync(target)) return target;
  const temporary = `${target}.tmp-${process.pid}`;
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true });
  try {
    for (const file of decoded) {
      const destination = path.resolve(temporary, file.path);
      if (!destination.startsWith(`${path.resolve(temporary)}${path.sep}`)) throw new AgentisError('VALIDATION_FAILED', `unsafe component destination ${file.path}`);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, file.data);
    }
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return target;
}

function validatePortableComponent(component: Record<string, unknown>, slug: string, files: Set<string>): void {
  if (component.manifestVersion !== 2) throw new AgentisError('VALIDATION_FAILED', `component ${slug} requires manifestVersion 2`);
  const runtime = objectRecord(component.runtime);
  const validRuntime = (runtime.language === 'python' && runtime.version === '3.12')
    || (runtime.language === 'node' && runtime.version === '20');
  if (!validRuntime) throw new AgentisError('VALIDATION_FAILED', `component ${slug} must use Python 3.12 or Node 20`);
  const entrypoint = typeof component.entrypoint === 'string' ? component.entrypoint : '';
  const dependencyLock = typeof component.dependencyLock === 'string' ? component.dependencyLock : '';
  for (const [field, value] of [['entrypoint', entrypoint], ['dependencyLock', dependencyLock]] as const) {
    if (!value || path.isAbsolute(value) || value.split(/[\\/]+/).includes('..') || !files.has(value)) {
      throw new AgentisError('VALIDATION_FAILED', `component ${slug} has an invalid or missing ${field}`);
    }
  }
  if (!Array.isArray(component.operations) || component.operations.length === 0) {
    throw new AgentisError('VALIDATION_FAILED', `component ${slug} declares no operations`);
  }
}



