/**
 * WorkspacePackager — the `.agentis` whole-workspace bundle (backup / share / sell).
 *
 * The workspace-scope superset of the single-app `.agentisapp` packager. It does
 * NOT invent a new install engine: export builds the portable manifest by reusing
 * the same per-entity shapes the library packager + app packager already speak,
 * and import orchestrates the two PROVEN install paths —
 *   - workspace-shared entities (agents / bare workflows / extensions / abilities
 *     / knowledge) → {@link PackagerService.usePackage} (`activateAgentisPackage`,
 *     which already rebinds graph refs + runs the security scan), and
 *   - each Agentic App → {@link AppPackager.fromManifest} (surfaces + collection
 *     schemas).
 *
 * The export **profile** is the safety dimension (package.ts): `share`/`sell`
 * NEVER carry credential values (only slots) and drop embeddings (recompiled on
 * install); `backup` is full fidelity and goes through `backup.ts`, NOT this
 * manifest path. `sell` additionally runs a scrub gate before it will serialize.
 */

import { createHash, createSign, createVerify } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  AgentisError,
  appManifestSchema,
  bundleSelectionSchema,
  workspaceBundleManifestSchema,
  workspaceBundleEnvelopeSchema,
  workspaceBundlePreviewSchema,
  type AgentisPackageContents,
  type AppManifest,
  type BundleFidelity,
  type BundleSelection,
  type ExportProfile,
  type WorkspaceBundleManifest,
  type WorkspaceBundleEnvelope,
  type WorkspaceBundlePreview,
  type BundleAuthor,
} from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import { AppStore, AppPackager } from '@agentis/app';
import type { EventBus } from '../../event-bus.js';
import type { Logger } from '../../logger.js';
import { PackagerService, type PackageScope } from '../packager.js';
import { scanArtifactBytes } from '../registryScanner.js';
import type { EpisodicMemoryStore } from '../episodicMemoryStore.js';
import { EpisodicBrainPort } from '../brain/brainExport.js';
import { computeSetupRequirements } from './setupRequirements.js';

export interface WorkspacePackagerDeps {
  db: AgentisSqliteDb;
  bus?: EventBus;
  logger?: Logger;
  /** RSA keypair (PEM) for signing `sell` bundles. Without it, sell exports are unsigned. */
  signer?: { privateKeyPem: string; publicKeyPem: string };
  /** Brain store — required to carry/rehydrate learned intelligence (`full` fidelity). */
  episodes?: EpisodicMemoryStore;
}

/** Options controlling a workspace export's fidelity + granular selection. */
export interface WorkspaceExportOptions extends ExportOptions {
  fidelity?: BundleFidelity;
  selection?: Partial<BundleSelection>;
}

export interface ExportOptions {
  name?: string;
  description?: string | null;
  author?: BundleAuthor | null;
  license?: string | null;
}

export interface InstallBundleResult {
  agents: number;
  apps: number;
  workflows: number;
  extensions: number;
  knowledgeSeeds: number;
  /** Learned Brain atoms rehydrated across all scopes (full fidelity only). */
  brainAtoms: number;
  /** Collection rows imported across all apps (full fidelity only). */
  collectionRows: number;
  /** Credential slots the operator must fill in before bundled work can run. */
  requiredCredentials: Array<{ key: string; service: string; label: string }>;
  warnings: string[];
}

export class WorkspacePackager {
  private readonly apps: AppStore;
  private readonly appPackager: AppPackager;
  private readonly packager: PackagerService;
  /** Brain bridge — present only when an episode store was injected. */
  private readonly brainPort?: EpisodicBrainPort;

  constructor(private readonly deps: WorkspacePackagerDeps) {
    this.apps = new AppStore(deps.db);
    this.appPackager = new AppPackager(deps.db);
    this.brainPort = deps.episodes ? new EpisodicBrainPort(deps.episodes) : undefined;
    this.packager = new PackagerService({
      db: deps.db,
      ...(deps.bus ? { bus: deps.bus } : {}),
      ...(deps.logger ? { logger: deps.logger } : {}),
      ...(this.brainPort ? { brain: this.brainPort } : {}),
    });
  }

  // ── Export ──────────────────────────────────────────────────

  /**
   * Build the portable manifest for a whole workspace.
   *
   * `profile` is the trust/secrets dimension; `opts.fidelity` is the orthogonal
   * structural dimension — `full` carries learned intelligence (Brain atoms +
   * collection rows), `shareable` (default) carries definitions/structure only.
   * `opts.selection` narrows WHICH entities and facets travel. Enforcement is
   * structural: `shareable` drops every brain/row even if the selection asks.
   *
   * Agent BRAINS ride the flat `agents` list (not the in-app agents) so a whole
   * workspace never imports the same agent's memory twice — the App carries agent
   * LINKAGE, the flat list carries the memory.
   */
  toManifest(workspaceId: string, profile: ExportProfile, opts: { fidelity?: BundleFidelity; selection?: Partial<BundleSelection>; warnings?: string[] } = {}): WorkspaceBundleManifest {
    const stripSecrets = profile !== 'backup'; // share/sell never carry secret values
    const fidelity: BundleFidelity = opts.fidelity ?? 'shareable';
    const full = fidelity === 'full' && !!this.brainPort;
    const sel = bundleSelectionSchema.parse(opts.selection ?? {});
    const agentAllowed = (id: string): boolean => sel.agentIds === null || sel.agentIds.includes(id);
    const appAllowed = (id: string): boolean => sel.appIds === null || sel.appIds.includes(id);
    const carryAgentBrains = full && sel.includeAgentBrains;

    const agents = this.deps.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, workspaceId))
      .all()
      .filter((a) => agentAllowed(a.id))
      .map((a) => ({
        name: a.name,
        adapterType: a.adapterType,
        capabilityTags: stringArray(a.capabilityTags),
        config: objectRecord(a.config),
        instructions: a.instructions ?? null,
        avatarGlyph: a.avatarGlyph ?? null,
        runtimeModel: a.runtimeModel ?? null,
        role: a.role ?? null,
        ...(carryAgentBrains ? { brain: { atoms: this.brainPort!.exportScope(workspaceId, a.id) } } : {}),
      }));

    const appManifests: AppManifest[] = this.apps
      .list(workspaceId)
      .filter((app) => appAllowed(app.id))
      .map((app) =>
        this.appPackager.toManifest(workspaceId, app.id, {
          fidelity,
          // A portable workspace must preserve what the operator currently sees
          // in the workflow editor. Newly imported/drafted workflows can have an
          // intentionally empty active baseline while their real graph is staged
          // as the candidate revision. AppPackager falls back to active when no
          // candidate exists.
          revisionTarget: 'candidate',
          ...(this.brainPort ? { brain: this.brainPort } : {}),
          includeAppBrain: sel.includeAppBrains,
          // Agent brains ride the workspace-level flat list, not the App, so a
          // whole-workspace bundle imports each agent's memory exactly once.
          includeAgentBrains: false,
          includeCollectionData: sel.includeCollectionData,
          ...(opts.warnings ? { warnings: opts.warnings } : {}),
        }),
      );

    // Bare workflows only — App workflows already travel inside their AppManifest.
    const workflows = this.deps.db
      .select({
        title: schema.workflows.title,
        description: schema.workflows.description,
        graph: schema.workflows.graph,
        settings: schema.workflows.settings,
        activeRevisionId: schema.workflows.activeRevisionId,
        candidateRevisionId: schema.workflows.candidateRevisionId,
      })
      .from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, workspaceId), isNull(schema.workflows.appId)))
      .all()
      .map((w) => {
        const revisionId = w.candidateRevisionId ?? w.activeRevisionId;
        const revision = revisionId
          ? this.deps.db.select({ graph: schema.workflowGraphRevisions.graphJson })
            .from(schema.workflowGraphRevisions).where(eq(schema.workflowGraphRevisions.id, revisionId)).get()
          : null;
        return { title: w.title, description: w.description ?? null, graph: revision?.graph ?? w.graph, settings: objectRecord(w.settings) };
      });

    const extensions = this.deps.db
      .select()
      .from(schema.extensions)
      .where(eq(schema.extensions.workspaceId, workspaceId))
      .all()
      .filter((e) => e.runtime !== 'builtin') // host-shipped; never travels
      .map((e) => ({
        name: e.name,
        slug: e.slug,
        version: e.version,
        runtime: e.runtime as 'node_worker' | 'docker_sandbox',
        manifest: objectRecord(e.manifest) as never,
      }));

    const knowledgeSeeds = sel.includeKnowledge ? this.exportKnowledgeSeeds(workspaceId) : [];

    // Credentials travel as SLOTS (requirements), never as encrypted values — even
    // for backup, since the encrypted DB itself carries values via backup.ts.
    const credentialSlots = stripSecrets
      ? this.deps.db
          .select({ name: schema.credentials.name, credentialType: schema.credentials.credentialType })
          .from(schema.credentials)
          .where(eq(schema.credentials.workspaceId, workspaceId))
          .all()
          .map((cred) => ({ key: cred.name, service: cred.credentialType, label: cred.name, required: true, oauthFlow: false }))
      : [];

    // Workspace-global Brain memory (scope_id = null).
    const workspaceBrain = full && sel.includeWorkspaceBrain ? { atoms: this.brainPort!.exportScope(workspaceId, null) } : undefined;

    return workspaceBundleManifestSchema.parse({
      agents,
      extensions,
      workflows,
      integrations: [],
      abilities: [],
      apps: appManifests,
      knowledgeSeeds,
      credentialSlots,
      ...(workspaceBrain ? { workspaceBrain } : {}),
      fidelity,
      ...(full ? { bundleContentVersion: 2 } : {}),
    });
  }

  /** Serialize a workspace to a signed-by-checksum `.agentis` envelope. */
  exportWorkspace(workspaceId: string, profile: ExportProfile, opts: WorkspaceExportOptions = {}): WorkspaceBundleEnvelope {
    const fidelity: BundleFidelity = opts.fidelity ?? 'shareable';
    const manifest = this.toManifest(workspaceId, profile, { fidelity, ...(opts.selection ? { selection: opts.selection } : {}) });
    if (profile === 'sell') this.assertSellable(manifest);
    const name = opts.name?.trim() || workspaceName(this.deps.db, workspaceId);
    // Sell bundles are signed (self-certifying: the verifying public key travels
    // with the bundle) so an importer can detect post-signing tampering.
    const sign = profile === 'sell' && this.deps.signer
      ? signManifest(manifest, this.deps.signer)
      : { signature: null, signerPublicKeyPem: null };
    return workspaceBundleEnvelopeSchema.parse({
      format: '.agentis',
      formatVersion: 1,
      agentisVersion: '1.0.0',
      profile,
      fidelity,
      name,
      description: opts.description ?? null,
      manifest,
      checksum: checksum(manifest),
      exportedAt: new Date().toISOString(),
      author: opts.author ?? null,
      license: opts.license ?? null,
      signature: sign.signature,
      signerPublicKeyPem: sign.signerPublicKeyPem,
    });
  }

  // ── Preview (non-mutating) ──────────────────────────────────

  preview(envelope: WorkspaceBundleEnvelope): WorkspaceBundlePreview {
    const manifest = this.deserialize(envelope);
    const warnings: string[] = [];
    if (manifest.credentialSlots.length > 0) {
      warnings.push(`${manifest.credentialSlots.length} credential(s) must be reconnected after install — no secrets travel in a ${envelope.profile} bundle.`);
    }
    if (manifest.apps.some((app) => app.policy.customCode === 'allowed')) {
      warnings.push('One or more apps enable CustomView code; review before installing into a shared workspace.');
    }
    // First-class "nodes needing setup": credentials, plugins, and the connections
    // the bundled workflows reach out to but carry no credential for.
    const setup = computeSetupRequirements(manifest);
    if (setup.connections.length > 0) {
      warnings.push(`${setup.connections.length} connection(s) referenced by workflows need setup: ${setup.connections.map((c) => c.service).join(', ')}.`);
    }
    const requiredPlugins = setup.plugins;

    const brainAtoms = countBrainAtoms(manifest);
    const collectionRows = countCollectionRows(manifest);
    if (brainAtoms > 0 || collectionRows > 0) {
      warnings.push(`This is a FULL bundle carrying learned intelligence: ${brainAtoms} Brain memor${brainAtoms === 1 ? 'y' : 'ies'} and ${collectionRows} data row(s).`);
    }

    return workspaceBundlePreviewSchema.parse({
      format: '.agentis',
      formatVersion: 1,
      profile: envelope.profile,
      fidelity: manifest.fidelity ?? envelope.fidelity ?? 'shareable',
      name: envelope.name,
      checksum: envelope.checksum,
      exportedAt: envelope.exportedAt,
      author: envelope.author ?? null,
      license: envelope.license ?? null,
      counts: {
        agents: manifest.agents.length,
        apps: manifest.apps.length,
        workflows: manifest.workflows.length,
        extensions: manifest.extensions.length,
        integrations: manifest.integrations.length,
        knowledgeSeeds: manifest.knowledgeSeeds.length,
        credentialSlots: manifest.credentialSlots.length,
        brainAtoms,
        collectionRows,
      },
      requiredCredentials: manifest.credentialSlots.map((slot) => ({ key: slot.key, service: slot.service, label: slot.label })),
      setup,
      permissions: requiredPlugins.map((plugin) => `plugin:${plugin}`),
      warnings,
    });
  }

  // ── Install ─────────────────────────────────────────────────

  installBundle(
    scope: PackageScope,
    envelope: WorkspaceBundleEnvelope,
    opts: { permissionsAcknowledged: boolean; selection?: Partial<BundleSelection> },
  ): InstallBundleResult {
    if (envelope.profile === 'backup') {
      throw new AgentisError('VALIDATION_FAILED', 'backup bundles restore via the backup/restore path, not manifest import');
    }
    if (!opts.permissionsAcknowledged) {
      throw new AgentisError('VALIDATION_FAILED', 'permissionsAcknowledged must be true to install a workspace bundle');
    }
    const manifest = this.deserialize(envelope);
    const sel = bundleSelectionSchema.parse(opts.selection ?? {});

    // Security gate (masterplan 0.4): a third-party bundle runs on the installer's
    // host. Block on any `block` finding before anything is written. The scan now
    // also covers brain summaries + collection rows (they are in the manifest).
    const scan = scanArtifactBytes(Buffer.from(stableJson(manifest), 'utf8'), envelope.name);
    const blockers = scan.findings.filter((f) => f.severity === 'block');
    if (blockers.length > 0) {
      throw new AgentisError('PACKAGE_IMPORT_INVALID', 'workspace bundle blocked by security scan', { details: { findings: blockers } });
    }
    const warnings = scan.findings.filter((f) => f.severity === 'warn').map((f) => f.detail);

    // 1) Workspace-shared entities through the proven agentis install engine.
    const contents: AgentisPackageContents = {
      kind: 'agentis',
      agents: manifest.agents,
      extensions: manifest.extensions,
      workflows: manifest.workflows.map((w) => ({ title: w.title, description: w.description ?? null, graph: w.graph, settings: w.settings })),
      integrations: manifest.integrations,
      credentialSlots: manifest.credentialSlots,
      knowledgeSeeds: sel.includeKnowledge ? manifest.knowledgeSeeds : [],
      surfaces: [],
      collections: [],
      screenshotUrls: [],
    };
    const row = this.packager.create(scope, { name: envelope.name, description: envelope.description ?? null }, 'agentis', contents);
    this.packager.usePackage(scope, row.id);

    // Name → id map of every workspace agent AFTER the shared-entity install, so app
    // owners relink to real ids and agent brains land on the right scope.
    const nameToId = new Map<string, string>();
    for (const a of this.deps.db.select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.workspaceId, scope.workspaceId)).all()) {
      nameToId.set(a.name, a.id);
    }

    // 1b) Rehydrate agent-private + workspace-global Brain memory (full fidelity).
    let brainAtoms = 0;
    if (this.brainPort && sel.includeAgentBrains) {
      for (const a of manifest.agents) {
        const id = nameToId.get(a.name);
        if (id && a.brain && a.brain.atoms.length > 0) brainAtoms += this.brainPort.importScope(scope.workspaceId, id, a.brain.atoms, 'agent');
      }
    }
    if (this.brainPort && sel.includeWorkspaceBrain && manifest.workspaceBrain && manifest.workspaceBrain.atoms.length > 0) {
      brainAtoms += this.brainPort.importScope(scope.workspaceId, null, manifest.workspaceBrain.atoms, 'workspace');
    }

    // 2) Each Agentic App through the proven app install path — with the owner
    // relinked via nameToId (never staffApp) and App brain + rows rehydrated.
    let installedApps = 0;
    let collectionRows = 0;
    for (const app of manifest.apps) {
      try {
        const appWarnings: string[] = [];
        this.appPackager.fromManifest(scope.workspaceId, scope.userId, appManifestSchema.parse(app), {
          ...(this.brainPort ? { brain: this.brainPort } : {}),
          includeAppBrain: sel.includeAppBrains,
          // Agent brains are rehydrated once at the workspace level (above).
          includeAgentBrains: false,
          includeCollectionData: sel.includeCollectionData,
          agentNameToId: nameToId,
          warnings: appWarnings,
        });
        installedApps += 1;
        warnings.push(...appWarnings);
        if (sel.includeAppBrains && app.brain) brainAtoms += app.brain.atoms.length;
        if (sel.includeCollectionData) for (const col of app.collections) collectionRows += col.seed?.length ?? 0;
      } catch (err) {
        this.deps.logger?.warn('workspace_bundle.app_install_failed', { app: app.identity.slug, err: (err as Error).message });
        warnings.push(`App "${app.identity.name}" failed to install: ${(err as Error).message}`);
      }
    }

    return {
      agents: manifest.agents.length,
      apps: installedApps,
      workflows: manifest.workflows.length,
      extensions: manifest.extensions.length,
      knowledgeSeeds: contents.knowledgeSeeds.length,
      brainAtoms,
      collectionRows,
      requiredCredentials: manifest.credentialSlots.map((slot) => ({ key: slot.key, service: slot.service, label: slot.label })),
      warnings,
    };
  }

  // ── Envelope integrity ──────────────────────────────────────

  deserialize(envelope: WorkspaceBundleEnvelope): WorkspaceBundleManifest {
    if (envelope.format !== '.agentis') throw new AgentisError('VALIDATION_FAILED', 'not a .agentis envelope');
    const manifest = workspaceBundleManifestSchema.parse(envelope.manifest);
    if (checksum(manifest) !== envelope.checksum) {
      throw new AgentisError('VALIDATION_FAILED', 'checksum mismatch — workspace bundle is corrupt or tampered');
    }
    // A signed (sell) bundle must verify against its embedded public key.
    if (envelope.signature) {
      if (!envelope.signerPublicKeyPem) {
        throw new AgentisError('VALIDATION_FAILED', 'signed bundle is missing its verifying public key');
      }
      const verify = createVerify('RSA-SHA256');
      verify.update(stableJson(manifest));
      verify.end();
      if (!verify.verify(envelope.signerPublicKeyPem, envelope.signature, 'base64')) {
        throw new AgentisError('VALIDATION_FAILED', 'signature verification failed — bundle was altered after signing');
      }
    }
    return manifest;
  }

  // ── Internals ───────────────────────────────────────────────

  /** A sellable bundle must carry no secret values and no obvious PII in its payload. */
  private assertSellable(manifest: WorkspaceBundleManifest): void {
    const scan = scanArtifactBytes(Buffer.from(stableJson(manifest), 'utf8'), 'workspace-bundle');
    const blockers = scan.findings.filter((f) => f.severity === 'block');
    if (blockers.length > 0) {
      throw new AgentisError('VALIDATION_FAILED', 'cannot sell: bundle contains secrets or sensitive data', { details: { findings: blockers } });
    }
  }

  private exportKnowledgeSeeds(workspaceId: string): WorkspaceBundleManifest['knowledgeSeeds'] {
    const bases = this.deps.db
      .select({ id: schema.knowledgeBases.id })
      .from(schema.knowledgeBases)
      .where(eq(schema.knowledgeBases.workspaceId, workspaceId))
      .all();
    if (bases.length === 0) return [];
    const seeds: WorkspaceBundleManifest['knowledgeSeeds'] = [];
    for (const base of bases) {
      const docs = this.deps.db
        .select({ id: schema.kbDocuments.id, name: schema.kbDocuments.name })
        .from(schema.kbDocuments)
        .where(and(eq(schema.kbDocuments.knowledgeBaseId, base.id), eq(schema.kbDocuments.workspaceId, workspaceId)))
        .all();
      for (const doc of docs) {
        const chunks = this.deps.db
          .select({ content: schema.kbChunks.content, chunkIndex: schema.kbChunks.chunkIndex })
          .from(schema.kbChunks)
          .where(eq(schema.kbChunks.documentId, doc.id))
          .all()
          .sort((a, b) => a.chunkIndex - b.chunkIndex);
        const content = chunks.map((c) => c.content).join('\n').trim();
        if (content) seeds.push({ title: doc.name, content, tags: [], metadata: {} });
      }
    }
    return seeds;
  }
}

function checksum(manifest: WorkspaceBundleManifest): string {
  return createHash('sha256').update(stableJson(manifest)).digest('hex');
}

function signManifest(
  manifest: WorkspaceBundleManifest,
  signer: { privateKeyPem: string; publicKeyPem: string },
): { signature: string; signerPublicKeyPem: string } {
  const sign = createSign('RSA-SHA256');
  sign.update(stableJson(manifest));
  sign.end();
  return { signature: sign.sign(signer.privateKeyPem, 'base64'), signerPublicKeyPem: signer.publicKeyPem };
}

function workspaceName(db: AgentisSqliteDb, workspaceId: string): string {
  const row = db.select({ name: schema.workspaces.name }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get();
  return row?.name?.trim() || 'Workspace';
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

/** Total learned Brain atoms carried across every scope in the manifest. */
function countBrainAtoms(manifest: WorkspaceBundleManifest): number {
  let n = manifest.workspaceBrain?.atoms.length ?? 0;
  for (const a of manifest.agents) n += a.brain?.atoms.length ?? 0;
  for (const app of manifest.apps) {
    n += app.brain?.atoms.length ?? 0;
    for (const agent of app.agents) n += agent.brain?.atoms.length ?? 0;
  }
  return n;
}

/** Total collection rows carried across every App in the manifest. */
function countCollectionRows(manifest: WorkspaceBundleManifest): number {
  let n = 0;
  for (const app of manifest.apps) for (const col of app.collections) n += col.seed?.length ?? 0;
  return n;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
