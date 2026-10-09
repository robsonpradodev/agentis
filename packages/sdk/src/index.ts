import {
  agentisPackageContentsSchema,
  appIdentitySchema,
  appManifestEnvelopeSchema,
  appManifestSchema,
  appPolicySchema,
  canonicalizeManifest,
  collectionSchemaSchema,
  capabilityDeclSchema,
  manifestAgentSchema,
  manifestCollectionSchema,
  manifestSurfaceSchema,
  manifestWorkflowSchema,
  packageManifestSchema,
  type AgentisPackageContents,
  type AppInstallPreview,
  type AppManifest,
  type AppManifestEnvelope,
  type AppOperation,
  type AgentMission,
  type AuthorityContext,
  type EffectPlan,
  type AppPolicy,
  type CapabilityDecl,
  type CollectionMigration,
  type CollectionSchema,
  type ManifestAgent,
  type ManifestCollection,
  type ManifestSurface,
  type ManifestWorkflow,
  type PackageExportEnvelope,
  type PackageManifest,
  type SurfaceAction,
  type SurfaceKind,
  type ViewNode,
  type WorkflowGraph,
} from '@agentis/core';
import { createHash } from 'node:crypto';

export type {
  AppInstallPreview,
  AppManifest,
  AppManifestEnvelope,
  AppOperation,
  AgentMission,
  AuthorityContext,
  EffectPlan,
  AppPolicy,
  CapabilityDecl,
  CollectionMigration,
  CollectionSchema,
  ManifestAgent,
  ManifestCollection,
  ManifestSurface,
  ManifestWorkflow,
  SurfaceAction,
  SurfaceKind,
  ViewNode,
  WorkflowGraph,
} from '@agentis/core';

export type AgentisPackageDefinition = Omit<AgentisPackageContents, 'kind'> & { kind?: 'agentis' };

export interface BuildManifestOptions {
  slug: string;
  name: string;
  version?: string;
  description?: string | null;
  tags?: string[];
  agentisVersion?: string;
  author?: PackageManifest['author'];
}

export interface DefineAppInput {
  slug?: string;
  name: string;
  version?: string;
  icon?: string | null;
  entrySurfaceId?: string | null;
  agentisVersion?: string;
  policy?: Partial<AppPolicy>;
  workflows?: ManifestWorkflow[];
  surfaces?: ManifestSurface[];
  collections?: ManifestCollection[];
  agents?: ManifestAgent[];
  memory?: AppManifest['memory'];
  capabilities?: CapabilityDecl[];
  requiredPlugins?: string[];
  dependencies?: AppManifest['dependencies'];
  migrations?: CollectionMigration[];
  source?: AppManifest['source'];
  contract?: AppManifest['contract'];
  frontend?: AppManifest['frontend'];
  components?: AppManifest['components'];
  storage?: AppManifest['storage'];
  orchestration?: AppManifest['orchestration'];
  brainPolicy?: AppManifest['brainPolicy'];
  permissionsV3?: AppManifest['permissionsV3'];
  quality?: AppManifest['quality'];
  artifacts?: AppManifest['artifacts'];
  projections?: AppManifest['projections'];
}

export function defineApp(input: DefineAppInput): AppManifest {
  const slug = input.slug ?? slugify(input.name);
  return appManifestSchema.parse({
    manifestVersion: hasV3Facets(input) ? 3 : 1,
    agentisVersion: input.agentisVersion ?? '1.0.0',
    identity: appIdentitySchema.parse({
      manifestVersion: 1,
      slug,
      name: input.name,
      version: input.version ?? '0.1.0',
      icon: input.icon ?? null,
      entrySurfaceId: input.entrySurfaceId ?? input.surfaces?.[0]?.name ?? null,
      requiredPlugins: input.requiredPlugins ?? [],
    }),
    policy: appPolicySchema.parse(input.policy ?? {}),
    workflows: input.workflows ?? [],
    surfaces: input.surfaces ?? [],
    collections: input.collections ?? [],
    agents: input.agents ?? [],
    ...(input.memory ? { memory: input.memory } : {}),
    capabilities: input.capabilities ?? [],
    requiredPlugins: input.requiredPlugins ?? [],
    dependencies: input.dependencies ?? [],
    migrations: input.migrations ?? [],
    source: input.source ?? null,
    ...(input.contract ? { contract: input.contract } : {}),
    ...(input.frontend ? { frontend: input.frontend } : {}),
    ...(input.components ? { components: input.components } : {}),
    ...(input.storage ? { storage: input.storage } : {}),
    ...(input.orchestration ? { orchestration: input.orchestration } : {}),
    ...(input.brainPolicy ? { brainPolicy: input.brainPolicy } : {}),
    ...(input.permissionsV3 ? { permissionsV3: input.permissionsV3 } : {}),
    ...(input.quality ? { quality: input.quality } : {}),
    ...(input.artifacts ? { artifacts: input.artifacts } : {}),
    ...(input.projections ? { projections: input.projections } : {}),
  });
}

export const buildAppManifest = defineApp;

export function createStarterApp(name = 'My Agentic App'): AppManifest {
  return defineApp({
    name,
    version: '0.1.0',
    collections: [
      defineCollection({
        name: 'tasks',
        schema: {
          fields: [
            field('title', 'string', { required: true, indexed: true }),
            field('status', 'string', { required: true, indexed: true }),
          ],
        },
      }),
    ],
    surfaces: [
      defineSurface({
        name: 'home',
        view: {
          type: 'Stack',
          gap: 16,
          children: [
            { type: 'Heading', value: name },
            {
              type: 'Form',
              fields: [
                { key: 'title', label: 'Task', type: 'text', required: true },
                {
                  key: 'status',
                  label: 'Status',
                  type: 'select',
                  required: true,
                  options: [
                    { value: 'todo', label: 'To do' },
                    { value: 'done', label: 'Done' },
                  ],
                },
              ],
              submit: { action: 'createTask' },
              submitLabel: 'Add task',
            },
            {
              type: 'Table',
              bind: { collection: 'tasks', live: true, sort: [{ field: 'title', dir: 'asc' }] },
              columns: [
                { key: 'title', label: 'Task' },
                { key: 'status', label: 'Status', format: 'badge' },
              ],
            },
          ],
        },
        actions: [{ name: 'createTask', kind: 'data', target: 'tasks.insert' }],
      }),
    ],
  });
}

export function defineWorkflow(args: {
  title: string;
  slug?: string;
  description?: string | null;
  graph: WorkflowGraph | unknown;
}): ManifestWorkflow {
  return manifestWorkflowSchema.parse(args);
}

export function defineSurface(args: {
  name: string;
  kind?: SurfaceKind;
  view?: ViewNode | null;
  actions?: SurfaceAction[];
  shareable?: boolean;
}): ManifestSurface {
  return manifestSurfaceSchema.parse(args);
}

export function defineCollection(args: {
  name: string;
  schema: CollectionSchema;
  seed?: Record<string, unknown>[];
}): ManifestCollection {
  return manifestCollectionSchema.parse(args);
}

export function field(key: string, type: CollectionSchema['fields'][number]['type'], options: Partial<CollectionSchema['fields'][number]> = {}) {
  return collectionSchemaSchema.shape.fields.element.parse({ key, type, ...options });
}

export function defineAgent(args: Partial<ManifestAgent> & { name: string }): ManifestAgent {
  return manifestAgentSchema.parse(args);
}

export function defineCapability(args: CapabilityDecl): CapabilityDecl {
  return capabilityDeclSchema.parse(args);
}

export function buildAgentisApp(manifestOrInput: AppManifest | DefineAppInput): AppManifestEnvelope {
  const manifest = isAppManifest(manifestOrInput) ? appManifestSchema.parse(manifestOrInput) : defineApp(manifestOrInput);
  return appManifestEnvelopeSchema.parse({
    format: '.agentisapp',
    formatVersion: manifest.manifestVersion,
    manifest,
    checksum: sha256(canonicalizeManifest(manifest)),
    exportedAt: new Date().toISOString(),
  });
}

export function validateAppManifest(value: unknown): AppManifest {
  return appManifestSchema.parse(value);
}

export function validateAgentisApp(value: unknown): AppManifestEnvelope {
  return appManifestEnvelopeSchema.parse(value);
}

export function defineAgentisPackage(definition: AgentisPackageDefinition): AgentisPackageContents {
  return agentisPackageContentsSchema.parse({ kind: 'agentis', ...definition });
}

export function buildPackageManifest(contents: AgentisPackageContents, options: BuildManifestOptions): PackageManifest {
  const checksum = sha256(stableJson(contents));
  return packageManifestSchema.parse({
    manifestVersion: 1,
    agentisVersion: options.agentisVersion ?? '1.0.0',
    slug: options.slug,
    name: options.name,
    version: options.version ?? '1.0.0',
    kind: 'agentis',
    description: options.description ?? null,
    tags: options.tags ?? [],
    contents,
    checksum,
    source: null,
    remoteId: null,
    author: options.author ?? null,
  });
}

export function buildExportEnvelope(contents: AgentisPackageContents, options: BuildManifestOptions): PackageExportEnvelope {
  const manifest = buildPackageManifest(contents, options);
  return {
    packageManifest: manifest,
    agentisVersion: manifest.agentisVersion,
    exportedAt: new Date().toISOString(),
  };
}

export interface AgentisClientOptions {
  baseUrl?: string;
  token?: string;
  workspaceId?: string;
  ambientId?: string;
  fetchImpl?: typeof fetch;
}

export interface ImportAppOptions {
  permissionsAcknowledged?: string[];
}

export interface AppTestOptions {
  actions?: Array<{ surface: string; name: string; args?: Record<string, unknown> }>;
  assertions?: Array<{
    collection: string;
    query?: { filter?: Record<string, unknown>; sort?: Array<{ field: string; dir: 'asc' | 'desc' }>; limit?: number; cursor?: string };
    count?: number;
    includes?: Record<string, unknown>;
  }>;
}

export function createAgentisClient(options: AgentisClientOptions = {}) {
  const baseUrl = (options.baseUrl ?? 'http://127.0.0.1:3737').replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers ?? {});
    if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json');
    if (options.token) headers.set('authorization', `Bearer ${options.token}`);
    if (options.workspaceId) headers.set('x-agentis-workspace', options.workspaceId);
    if (options.ambientId) headers.set('x-agentis-ambient', options.ambientId);
    const res = await fetchImpl(`${baseUrl}${path}`, { ...init, headers });
    if (!res.ok) throw new Error(`Agentis API ${res.status}: ${await res.text()}`);
    if (res.status === 204) return undefined as T;
    return await res.json() as T;
  }
  return {
    listPackages: () => request('/v1/packages'),
    importPackage: (manifest: PackageManifest | PackageExportEnvelope) => request('/v1/packages/import', {
      method: 'POST',
      body: JSON.stringify(manifest),
    }),
    exportApp: (appId: string) => request<{ data: AppManifestEnvelope }>(`/v1/apps/${encodeURIComponent(appId)}/export`),
    previewAppImport: (app: AppManifestEnvelope) => request<{ data: AppInstallPreview }>('/v1/apps/import/preview', {
      method: 'POST',
      body: JSON.stringify(app),
    }),
    importApp: (app: AppManifestEnvelope, importOptions: ImportAppOptions = {}) => request<{ data: { appId: string } }>('/v1/apps/import', {
      method: 'POST',
      body: JSON.stringify({
        envelope: app,
        permissionsAcknowledged: importOptions.permissionsAcknowledged ?? [],
      }),
    }),
    testApp: (app: AppManifestEnvelope, test: AppTestOptions = {}) => request<{
      data: { appId: string; surfaces: string[]; assertions: Array<{ collection: string; count: number }> };
    }>('/v1/apps/test', {
      method: 'POST',
      body: JSON.stringify({ envelope: app, actions: test.actions ?? [], assertions: test.assertions ?? [] }),
    }),
    getAppDefinition: (appId: string) => request<{ definition: unknown | null }>(`/v1/apps/${encodeURIComponent(appId)}/definition`),
    updateAppDefinition: (appId: string, definition: Partial<AppManifest>) => request<{ definition: unknown }>(`/v1/apps/${encodeURIComponent(appId)}/definition`, {
      method: 'PUT', body: JSON.stringify(definition),
    }),
    listAppOperations: (appId: string) => request<{ operations: AppOperation[] }>(`/v1/apps/${encodeURIComponent(appId)}/operations`),
    invokeAppOperation: (appId: string, operationId: string, input: Record<string, unknown>, invokeOptions: {
      authorityContext?: AuthorityContext; idempotencyKey?: string;
    } = {}) => request<unknown>(`/v1/apps/${encodeURIComponent(appId)}/operations/${encodeURIComponent(operationId)}/invoke`, {
      method: 'POST', body: JSON.stringify({ input, ...invokeOptions }),
    }),
    listAppTasks: (appId: string) => request<{ tasks: AgentMission[] }>(`/v1/apps/${encodeURIComponent(appId)}/tasks`),
    getTask: (taskId: string) => request<{ mission: AgentMission }>(`/v1/missions/${encodeURIComponent(taskId)}`),
    cancelTask: (taskId: string, reason?: string) => request<{ mission: AgentMission }>(`/v1/missions/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST', body: JSON.stringify({ reason }),
    }),
    respondToTaskInput: (taskId: string, requestId: string, response: unknown) => request<{ mission: AgentMission }>(`/v1/missions/${encodeURIComponent(taskId)}/input-requests/${encodeURIComponent(requestId)}/respond`, {
      method: 'POST', body: JSON.stringify({ response }),
    }),
    authorizeEffect: (effectPlanId: string, authorityContext: AuthorityContext) => request<{ plan: EffectPlan; grant: unknown; invocation: unknown }>(`/v1/effects/${encodeURIComponent(effectPlanId)}/authorize`, {
      method: 'POST', body: JSON.stringify({ authorityContext }),
    }),
  };
}

function isAppManifest(value: AppManifest | DefineAppInput): value is AppManifest {
  return typeof value === 'object' && value !== null && 'identity' in value && 'policy' in value;
}

function hasV3Facets(value: DefineAppInput): boolean {
  return Boolean(value.contract || value.frontend || value.components || value.storage || value.orchestration
    || value.brainPolicy || value.permissionsV3 || value.quality || value.artifacts || value.projections);
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'app';
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}



