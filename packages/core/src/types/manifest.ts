/**
 * AppManifest — the canonical, versioned, serializable IR for an Agentic App
 * (AGENTIC-SYSTEMS-ARCHITECTURE §2.1). The single source of truth that:
 *   - the SDK emits (code authoring),
 *   - the agent/visual builders emit,
 *   - the runtime projects to/from DB rows (toManifest/fromManifest),
 *   - `.agentisapp` serializes for distribution.
 *
 * Every facet is a field; absence = that facet is unused (a logic-only app has
 * empty `surfaces`/`collections`). No facet carries runtime data — `collections`
 * ship SCHEMA only; rows never travel except as explicit scrubbed seed.
 */

import { z } from 'zod';
import { appIdentitySchema, appPolicySchema, appSourceSchema } from './app.js';
import { upsertSurfaceSchema, surfaceActionSchema } from './view.js';
import { collectionSchemaSchema } from './datastore.js';
import { capabilityDeclSchema } from './capability.js';

/**
 * A portable Brain atom — the serializable projection of one `memory_episodes`
 * row (learned intelligence). It carries only the CONTENT of an episode, never
 * its identity (`id`), its `scope_id`/`agent_id` (implied by which bucket the
 * atom travels in — agent brain, App brain, or workspace brain — and re-assigned
 * on install), its `embedding` (recomputed on install), or its lifecycle flags
 * (`archivedAt`/`supersededBy`/`reinforcedAt`). Maps 1:1 onto
 * `CreateRuntimeEpisodeInput` on import. Fields are loose (e.g. `type`/`source`
 * as strings) so an older/newer episode taxonomy still round-trips.
 *
 * This is what makes "share intelligence" real: an agent's or App's accumulated
 * memory travels with it. It lives here (not in package.ts) so both the App
 * manifest and the workspace bundle can reference it without an import cycle.
 */
export const portableBrainAtomSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  details: z.string().nullable().optional(),
  source: z.string().min(1),
  confidence: z.number().min(0).max(1).default(0.5),
  importance: z.number().min(0).max(1).default(0.5),
  trust: z.number().min(0).max(1).default(0.5),
  tags: z.array(z.string()).default([]),
  entities: z.array(z.string()).default([]),
  outcomeStatus: z.enum(['good', 'bad', 'mixed']).nullable().optional(),
  metadata: z.record(z.unknown()).default({}),
  /** Provenance only — the original creation time. Never used as an id. */
  createdAt: z.string().optional(),
});
export type PortableBrainAtom = z.infer<typeof portableBrainAtomSchema>;

/** A bundle of portable Brain atoms for one intelligence scope. */
export const portableBrainSchema = z.object({
  atoms: z.array(portableBrainAtomSchema).default([]),
});
export type PortableBrain = z.infer<typeof portableBrainSchema>;

/** A workflow (Logic facet) carried in the manifest. */
export const manifestWorkflowSchema = z.object({
  slug: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  graph: z.unknown(), // WorkflowGraph; kept unknown here to avoid a heavy import cycle
  /**
   * The workflow's id IN THE SOURCE workspace. Not an identity in the target —
   * purely a rebinding key: `subflow.workflowId` / `loop.bodyWorkflowId` inside
   * a sibling graph reference this value, and install rewrites them to the newly
   * minted ids. Without it a subflow node imports pointing at a workflow id that
   * exists only in the exporter's workspace, and the run fails at execution time.
   */
  exportId: z.string().min(1).optional(),
});
export type ManifestWorkflow = z.infer<typeof manifestWorkflowSchema>;

/** A surface (Interface facet) — reuses the AG-UI upsert shape + declared actions. */
export const manifestSurfaceSchema = upsertSurfaceSchema.extend({
  actions: z.array(surfaceActionSchema).default([]),
});
export type ManifestSurface = z.infer<typeof manifestSurfaceSchema>;

/** A collection (Data facet) — SCHEMA only; optional opt-in seed rows (§14.4). */
export const manifestCollectionSchema = z.object({
  name: z.string().min(1),
  schema: collectionSchemaSchema,
  seed: z.array(z.record(z.unknown())).default([]),
  /** Full-fidelity row envelopes. Preserve ids/version/audit timestamps so
   * foreign ids stored inside app data remain valid after machine transfer. */
  records: z.array(z.object({
    id: z.string().min(1),
    data: z.record(z.unknown()),
    version: z.number().int().positive(),
    createdBy: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })).optional(),
});
export type ManifestCollection = z.infer<typeof manifestCollectionSchema>;

/**
 * An agent (Team facet) — a full, linkable, brain-carrying definition so the
 * agent travels WITH its App and can be relinked as the App's owner on install.
 * `owner` marks the App's `ownerAgentId`; `memberRole` is its seat in the App
 * cast; `brain` is the agent's private learned memory (`scope_id = agentId`),
 * carried only in a `full`-fidelity export.
 */
export const manifestAgentSchema = z.object({
  name: z.string().min(1),
  role: z.enum(['operator', 'worker']).default('worker'),
  ref: z.object({ id: z.string(), version: z.string() }).optional(),
  adapterType: z.string().optional(),
  instructions: z.string().nullable().optional(),
  capabilityTags: z.array(z.string()).default([]),
  /** True for the agent that owns/operates this App (App.ownerAgentId). */
  owner: z.boolean().default(false),
  /** The agent's seat in the App cast, when it is a member. */
  memberRole: z.enum(['operator', 'worker']).optional(),
  /** Adapter config (never carries secret values). */
  config: z.record(z.unknown()).default({}),
  avatarGlyph: z.string().nullable().optional(),
  runtimeModel: z.string().nullable().optional(),
  /** Portable capability request; local binary paths never travel. */
  runtimeRequirement: z.object({
    adapterFamily: z.string().min(1),
    preferredModel: z.string().nullable().optional(),
    requiredAffordances: z.array(z.string()).default([]),
  }).optional(),
  /** Agent-private Brain memory (full fidelity only). */
  brain: portableBrainSchema.optional(),
  /**
   * The agent's id IN THE SOURCE workspace. Not an identity here — purely a
   * rebinding key, so `agent_task.agentId` (and the other agent-referencing node
   * kinds) can be rewritten to the newly created agent on install. Without it an
   * imported workflow points at an agent that exists only in the exporter's
   * workspace: a valid-looking UUID that resolves to nothing at run time.
   */
  exportId: z.string().min(1).optional(),
});
export type ManifestAgent = z.infer<typeof manifestAgentSchema>;

/**
 * A knowledge document carried with the App. Same seed shape the workspace bundle
 * uses: chunks are re-derived and re-embedded on install, so no embeddings travel.
 * Grouped by source base so an App with several bases installs them separately
 * rather than collapsing everything into one.
 */
export const manifestKnowledgeBaseSchema = z.object({
  /** Source-workspace id — the rebinding key for `knowledge.knowledgeBaseId`. */
  exportId: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  documents: z
    .array(
      z.object({
        title: z.string().min(1),
        content: z.string().min(1),
        tags: z.array(z.string()).default([]),
        metadata: z.record(z.unknown()).default({}),
      }),
    )
    .default([]),
});
export type ManifestKnowledgeBase = z.infer<typeof manifestKnowledgeBaseSchema>;

/** A non-builtin extension the App's `extension_task` steps invoke. */
export const manifestExtensionSchema = z.object({
  exportId: z.string().min(1).optional(),
  name: z.string().min(1),
  slug: z.string().min(1),
  version: z.string().min(1),
  runtime: z.enum(['node_worker', 'docker_sandbox', 'component_oci']),
  manifest: z.record(z.unknown()).default({}),
  /** Portable, hash-checked files for component_oci. Never contains host paths. */
  bundleFiles: z.array(z.object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    dataBase64: z.string(),
  })).default([]),
});
export type ManifestExtension = z.infer<typeof manifestExtensionSchema>;

/**
 * Something the installer must supply — NEVER a copied artifact. Credential
 * values and channel tokens must not travel, and connector slugs resolve against
 * the target's in-process registry (they are code, not rows).
 */
export const manifestRequirementSchema = z.object({
  kind: z.enum(['credential', 'connection', 'connector', 'plugin']),
  /** Stable key: credential name, channel kind, or connector slug. */
  key: z.string().min(1),
  label: z.string().min(1),
  detail: z.string().optional(),
});
export type ManifestRequirement = z.infer<typeof manifestRequirementSchema>;

/** An ordered, forward-only collection migration applied on upgrade (§9.2). */
export const collectionMigrationSchema = z.object({
  id: z.string().min(1),
  collection: z.string().min(1),
  op: z.enum(['add_field', 'drop_field', 'rename_field', 'retype_field', 'transform']),
  spec: z.record(z.unknown()).default({}),
});
export type CollectionMigration = z.infer<typeof collectionMigrationSchema>;

/** A reference to another shared component/app this manifest depends on. */
export const appDependencySchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  kind: z.enum(['app', 'agent', 'workflow', 'knowledge', 'plugin']),
});
export type AppDependency = z.infer<typeof appDependencySchema>;

/**
 * The full portable manifest. `identity` + `policy` reuse the runtime shapes so
 * the projection (rows ↔ manifest) is a straight map.
 */
export const appManifestSchema = z.object({
  // Missing means the legacy contract. New exporters set the current schema
  // revision explicitly; retaining the default keeps old packages importable.
  manifestVersion: z.union([z.literal(1), z.literal(2)]).default(1),
  agentisVersion: z.string().min(1).default('1.0.0'),
  /**
   * The App's id IN THE SOURCE workspace — the rebinding key for the App's own
   * `data_query.appId` / `data_mutate.appId` nodes. Those are self-references:
   * without remapping them to the newly minted app id, an imported App queries
   * the exporter's collections and silently reads nothing.
   */
  exportAppId: z.string().min(1).optional(),
  identity: appIdentitySchema,
  policy: appPolicySchema,
  // facets — present only when used
  workflows: z.array(manifestWorkflowSchema).default([]),
  surfaces: z.array(manifestSurfaceSchema).default([]),
  collections: z.array(manifestCollectionSchema).default([]),
  agents: z.array(manifestAgentSchema).default([]),
  /** DEPRECATED: a bare flag. Kept readable for back-compat; no longer emitted. */
  memory: z.object({ brainScope: z.boolean() }).optional(),
  /** App-scoped Brain memory (`scope_id = appId`) — carried in full fidelity only. */
  brain: portableBrainSchema.optional(),
  /** Knowledge the App reads — its own bases plus any a `knowledge` step reaches. */
  knowledge: z.array(manifestKnowledgeBaseSchema).default([]),
  /** Non-builtin extensions the App's steps invoke. */
  extensions: z.array(manifestExtensionSchema).default([]),
  /** Credentials / connections / connectors the installer must supply. */
  requirements: z.array(manifestRequirementSchema).default([]),
  // contracts & lifecycle
  capabilities: z.array(capabilityDeclSchema).default([]),
  requiredPlugins: z.array(z.string()).default([]),
  dependencies: z.array(appDependencySchema).default([]),
  migrations: z.array(collectionMigrationSchema).default([]),
  source: appSourceSchema.nullable().optional(),
});
export type AppManifest = z.infer<typeof appManifestSchema>;

/** The serialized `.agentisapp` envelope: a manifest + integrity + provenance. */
export const appManifestEnvelopeSchema = z.object({
  format: z.literal('.agentisapp'),
  formatVersion: z.union([z.literal(1), z.literal(2)]),
  manifest: appManifestSchema,
  checksum: z.string(), // sha256 over canonical(manifest)
  exportedAt: z.string(),
});
export type AppManifestEnvelope = z.infer<typeof appManifestEnvelopeSchema>;

/** Non-mutating install summary shown before a `.agentisapp` enters a workspace. */
export const appInstallPreviewSchema = z.object({
  format: z.literal('.agentisapp'),
  formatVersion: z.union([z.literal(1), z.literal(2)]),
  checksum: z.string(),
  exportedAt: z.string(),
  identity: appIdentitySchema,
  source: appSourceSchema.nullable(),
  counts: z.object({
    workflows: z.number().int().nonnegative(),
    surfaces: z.number().int().nonnegative(),
    collections: z.number().int().nonnegative(),
    agents: z.number().int().nonnegative(),
    capabilities: z.number().int().nonnegative(),
    dependencies: z.number().int().nonnegative(),
    migrations: z.number().int().nonnegative(),
    /** Learned intelligence + data carried (full fidelity only). */
    knowledgeDocs: z.number().int().nonnegative().default(0),
    brainAtoms: z.number().int().nonnegative().default(0),
    collectionRows: z.number().int().nonnegative().default(0),
    extensions: z.number().int().nonnegative().default(0),
  }),
  facets: z.object({
    workflows: z.array(z.string()),
    surfaces: z.array(z.string()),
    collections: z.array(z.string()),
    /** Named so the operator can see WHICH agents/knowledge arrive, not just how many. */
    agents: z.array(z.string()).default([]),
    knowledge: z.array(z.string()).default([]),
    extensions: z.array(z.string()).default([]),
  }),
  /**
   * Everything the package contains, itemised. The flat `facets` above answer
   * "how many"; this answers "what exactly, and why is it here" — which is what
   * an operator needs before letting a package into their workspace.
   */
  contents: z
    .array(
      z.object({
        kind: z.enum(['workflow', 'agent', 'knowledgeBase', 'extension', 'collection', 'credential', 'connection', 'connector']),
        label: z.string(),
        required: z.boolean().default(false),
        /** `create` = new here, `reuse` = matched an existing entity by name,
         *  `setup` = cannot be copied; the operator must supply it. */
        action: z.enum(['create', 'reuse', 'setup']).default('create'),
        detail: z.string().optional(),
      }),
    )
    .default([]),
  /** What must be configured before the imported App can run. */
  setup: z
    .object({
      credentials: z.array(z.object({ key: z.string(), label: z.string() })).default([]),
      connections: z.array(z.object({ key: z.string(), label: z.string() })).default([]),
      connectors: z.array(z.string()).default([]),
      plugins: z.array(z.string()).default([]),
    })
    .default({ credentials: [], connections: [], connectors: [], plugins: [] }),
  requiredPlugins: z.array(z.string()),
  permissions: z.array(z.string()),
  scanWarnings: z.array(z.string()).default([]),
  warnings: z.array(z.string()),
});
export type AppInstallPreview = z.infer<typeof appInstallPreviewSchema>;

/**
 * Canonical JSON serialization (sorted keys) so `checksum` is deterministic and
 * manifest diffs (for upgrade, §9.2) are meaningful. Pure, dependency-free.
 */
export function canonicalizeManifest(manifest: AppManifest): string {
  return JSON.stringify(sortKeysDeep(manifest));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}



