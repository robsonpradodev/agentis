/**
 * Agentic Apps client (AGENTIC-APPS-10X §3/§4/§5). Thin typed wrappers over the
 * `/v1/apps` routes used by the Apps pages and the AppRuntime renderer.
 */
import type {
  AppPresenceViewer,
  AppEnvironment,
  AppManifest,
  AppRecord,
  AppSurface,
  CollectionRecord,
  CollectionInfo,
  AppManifestEnvelope,
  AppInstallPreview,
  AppWorkflowSummary,
  AppWorkflowBinding,
  AppDeploymentSummary,
  AppActivationResult,
  WorkflowTriggerDeploymentStatus,
  UpdateAppWorkflowBindingInput,
  SurfaceAction,
  ViewNode,
  AgentMission,
  AppOperation,
  AuthorityContext,
  EffectPlan,
} from '@agentis/core';
import { api, apiCached } from './api';

/** Result of agent-assisted surface generation (`POST /:id/surfaces/generate`). */
export interface GeneratedSurface {
  view: ViewNode;
  actions: SurfaceAction[];
  /** `model` when the agent authored it; `fallback` for the deterministic scaffold. */
  source: 'model' | 'fallback';
}

/** One seat in an App's cast (the Team strip — Phase R birth-staff). */
export interface AppTeamMember {
  agentId: string;
  memberRole: 'operator' | 'worker' | string;
  name: string;
  functionalRole: string | null;
  colorHex: string | null;
  avatarGlyph: string | null;
  status: string;
  isOwner: boolean;
}

export interface AppTeam {
  ownerAgentId: string | null;
  members: AppTeamMember[];
}

export interface AppDoctorFinding {
  id: string;
  code: string;
  severity: 'critical' | 'error' | 'warning' | 'info';
  layer: 'binding' | 'activation' | 'outcome' | 'event' | 'state' | 'connection' | 'surface';
  summary: string;
  evidence: Record<string, unknown>;
  remediation: { operation: string; description: string; args?: Record<string, unknown> };
}

export interface AppDoctorReport {
  appId: string;
  generatedAt: string;
  health: 'healthy' | 'degraded' | 'broken';
  readyForUnattended: boolean;
  summary: { critical: number; error: number; warning: number; info: number; workflows: number; executableRules: number };
  topology: { roots: string[]; dependencyEdges: number; activeEventSubscriptions: number; activeTriggers: number; conversationTransitions: number };
  findings: AppDoctorFinding[];
}

export interface AppCompileCheck {
  id: string;
  layer: 'topology' | 'activation' | 'outcome' | 'runtime' | 'channel' | 'surface' | 'test';
  status: 'pass' | 'block' | 'warn' | 'not_applicable';
  summary: string;
  workflowId?: string;
  evidence?: Record<string, unknown>;
  clearWith?: { tool: string; args: Record<string, unknown>; why: string };
  /** False for evidence/release gates that do not deny a manual proof run. */
  blocksExecution?: boolean;
}

export interface AppCompileReport {
  appId: string;
  target: 'debug' | 'production' | 'unattended';
  generatedAt: string;
  structuralReady: boolean;
  executableReady: boolean;
  ready: boolean;
  readyForExecution: boolean;
  executionBlockerCount: number;
  evidencePendingCount: number;
  readinessFacets: {
    structural: { ready: boolean; blockers: number };
    executable: { ready: boolean; blockers: number };
    verified: { ready: boolean; pending: number };
    deliverable: { ready: boolean; blockers: number };
  };
  counts: { pass: number; block: number; warn: number; not_applicable: number };
  checks: AppCompileCheck[];
  summary: string;
}

export interface AppOrchestrationRule {
  id: string;
  sourceWorkflowId: string;
  targetWorkflowId: string;
  eventType: string;
  sourceNodeId: string | null;
  filterExpression: string | null;
  inputMapping: Record<string, string>;
  coalescePolicy: string;
  catchupPolicy: string;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface AppOrchestrationRuleInput {
  sourceWorkflowId: string;
  targetWorkflowId: string;
  eventType: 'run.completed' | 'run.accomplished' | 'run.failed' | 'node.completed' | 'node.failed';
  sourceNodeId?: string | null;
  filterExpression?: string | null;
  inputMapping?: Record<string, string>;
  coalescePolicy?: 'always_enqueue' | 'coalesce_pending' | 'latest_only';
  catchupPolicy?: string;
  enabled?: boolean;
}

export interface AgenticAppDefinition {
  appId: string;
  workspaceId: string;
  revision: number;
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
  createdAt: string;
  updatedAt: string;
}

export interface AgenticAppProject {
  appId: string;
  workspaceId: string;
  repoPath: string;
  defaultBranch: string;
  headCommit: string | null;
  framework: string;
  packageManager: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgenticAppBuild {
  id: string;
  status: string;
  sourceCommit: string;
  artifactPath: string | null;
  artifactSha256: string | null;
  sbomPath: string | null;
  log: string;
  createdAt: string;
  completedAt: string | null;
}

/** A live App conversation (Phase 1 — the real channel thread, not a datastore row). */
export interface AppConversation {
  id: string;
  title: string;
  channel: string | null;
  lastMessageAt: string | null;
  unread: number;
  
  handoffState: 'human' | null;
  
  needsAttention?: boolean;
  /** Why a human is needed ("wants a discount I can't approve"). */
  needsAttentionReason?: string | null;
}

export interface AppConversationMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  at: string;
}

interface Wrapped<T> {
  data: T;
}

export type AppUpdatePayload = Partial<{
  name: AppRecord['name'];
  description: AppRecord['description'];
  icon: AppRecord['icon'];
  status: AppRecord['status'];
  version: AppRecord['version'];
  entrySurfaceId: AppRecord['entrySurfaceId'];
  domainId: AppRecord['domainId'];
  ownerAgentId: AppRecord['ownerAgentId'];
  manifest: Partial<AppRecord['manifest']>;
  policy: Partial<AppRecord['policy']>;
  source: AppRecord['source'];
  installedChecksum: AppRecord['installedChecksum'];
}>;

export const appsApi = {
  list: () => apiCached<Wrapped<AppRecord[]>>('/v1/apps').then((r) => r.data),
  get: (id: string) => api<Wrapped<AppRecord>>(`/v1/apps/${id}`).then((r) => r.data),
  create: (body: {
    name: string;
    description?: string;
    domainId?: string | null;
    ownerAgentId?: string | null;
    entryWorkflowId?: string;
    createEntryWorkflow?: boolean;
    entryWorkflowTitle?: string;
    entryWorkflowGraph?: Record<string, unknown>;
  }) =>
    api<Wrapped<AppRecord>>('/v1/apps', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.data),
  promoteWorkflow: (workflowId: string) =>
    api<Wrapped<AppRecord>>(`/v1/apps/from-workflow/${encodeURIComponent(workflowId)}`, { method: 'POST' }).then((r) => r.data),
  update: (id: string, body: AppUpdatePayload) =>
    api<Wrapped<AppRecord>>(`/v1/apps/${id}`, { method: 'PATCH', body: JSON.stringify(body) }).then((r) => r.data),
  remove: (id: string) => api(`/v1/apps/${id}`, { method: 'DELETE' }),
  getAgenticDefinition: (id: string) => api<{ definition: AgenticAppDefinition | null }>(`/v1/apps/${id}/definition`).then((r) => r.definition),
  updateAgenticDefinition: (id: string, definition: Partial<AgenticAppDefinition>) =>
    api<{ definition: AgenticAppDefinition }>(`/v1/apps/${id}/definition`, { method: 'PUT', body: JSON.stringify(definition) }).then((r) => r.definition),
  listOperations: (id: string) => api<{ operations: AppOperation[] }>(`/v1/apps/${id}/operations`).then((r) => r.operations),
  invokeOperation: (id: string, operationId: string, input: Record<string, unknown>) =>
    api<unknown>(`/v1/apps/${id}/operations/${encodeURIComponent(operationId)}/invoke`, { method: 'POST', body: JSON.stringify({ input }) }),
  listTasks: (id: string) => api<{ tasks: AgentMission[] }>(`/v1/apps/${id}/tasks`).then((r) => r.tasks),
  cancelTask: (taskId: string) => api<{ mission: AgentMission }>(`/v1/missions/${taskId}/cancel`, { method: 'POST' }).then((r) => r.mission),
  respondTaskInput: (taskId: string, requestId: string, response: unknown) =>
    api<{ mission: AgentMission }>(`/v1/missions/${taskId}/input-requests/${requestId}/respond`, { method: 'POST', body: JSON.stringify({ response }) }).then((r) => r.mission),
  listEffects: (id: string) => api<{ effects: EffectPlan[] }>(`/v1/effects?appId=${encodeURIComponent(id)}`).then((r) => r.effects),
  authorizeEffect: (effectId: string, authorityContext: AuthorityContext) =>
    api<{ plan: EffectPlan }>(`/v1/effects/${effectId}/authorize`, { method: 'POST', body: JSON.stringify({ authorityContext }) }).then((r) => r.plan),
  getProject: (id: string) => api<{ project: AgenticAppProject | null; builds: AgenticAppBuild[] }>(`/v1/apps/${id}/project`),
  initializeProject: (id: string) => api<{ project: AgenticAppProject }>(`/v1/apps/${id}/project/initialize`, { method: 'POST' }).then((r) => r.project),
  buildProject: (id: string) => api<{ build: AgenticAppBuild }>(`/v1/apps/${id}/builds`, { method: 'POST' }).then((r) => r.build),

  // Surfaces
  listSurfaces: (id: string) => api<Wrapped<AppSurface[]>>(`/v1/apps/${id}/surfaces`).then((r) => r.data),
  getSurface: (id: string, name: string) =>
    api<Wrapped<AppSurface>>(`/v1/apps/${id}/surfaces/${encodeURIComponent(name)}`).then((r) => r.data),
  renameSurface: (id: string, name: string, nextName: string) =>
    api<Wrapped<AppSurface>>(`/v1/apps/${id}/surfaces/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: nextName }),
    }).then((r) => r.data),
  removeSurface: (id: string, name: string) =>
    api<Wrapped<{ ok: true }>>(`/v1/apps/${id}/surfaces/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) => r.data),
  upsertSurface: (id: string, body: { name: string; kind?: string; view?: unknown; actions?: unknown[]; shareable?: boolean }) =>
    api<Wrapped<AppSurface>>(`/v1/apps/${id}/surfaces`, { method: 'PUT', body: JSON.stringify(body) }).then((r) => r.data),
  generateSurface: (id: string, body: { prompt: string; surface?: string }) =>
    api<Wrapped<GeneratedSurface>>(`/v1/apps/${id}/surfaces/generate`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.data),
  performRegion: (id: string, surface: string, body: { region: string; pin?: boolean; clear?: boolean; reason?: string }) =>
    api<Wrapped<AppSurface>>(`/v1/apps/${id}/surfaces/${encodeURIComponent(surface)}/perform-region`, {
      method: 'POST', body: JSON.stringify(body),
    }).then((r) => r.data),

  // Team and conversations
  team: (id: string) => api<Wrapped<AppTeam>>(`/v1/apps/${id}/team`).then((r) => r.data),
  conversations: (id: string) => api<Wrapped<AppConversation[]>>(`/v1/apps/${id}/conversations`).then((r) => r.data),
  conversationMessages: (id: string, conversationId: string) =>
    api<Wrapped<AppConversationMessage[]>>(`/v1/apps/${id}/conversations/${conversationId}/messages`).then((r) => r.data),
  takeoverConversation: (id: string, conversationId: string, active: boolean) =>
    api<Wrapped<{ conversationId: string; handoffState: 'human' | null }>>(`/v1/apps/${id}/conversations/${conversationId}/takeover`, {
      method: 'POST', body: JSON.stringify({ active }),
    }).then((r) => r.data),
  sendToConversation: (id: string, conversationId: string, body: string) =>
    api<Wrapped<{ conversationId: string; delivered: boolean }>>(`/v1/apps/${id}/conversations/${conversationId}/send`, {
      method: 'POST', body: JSON.stringify({ body }),
    }).then((r) => r.data),
  flagNeedsAttention: (id: string, conversationId: string, active: boolean, reason?: string | null) =>
    api<Wrapped<{ conversationId: string; needsAttention: boolean; needsAttentionReason: string | null }>>(
      `/v1/apps/${id}/conversations/${conversationId}/needs-attention`,
      { method: 'POST', body: JSON.stringify({ active, reason: reason ?? null }) },
    ).then((r) => r.data),

  // Live co-presence (G9) — heartbeat while viewing; leave on unmount. Ephemeral.
  presence: (id: string, conversationId?: string | null) =>
    api<Wrapped<{ viewers: AppPresenceViewer[] }>>(`/v1/apps/${id}/presence`, {
      method: 'POST', body: JSON.stringify({ conversationId: conversationId ?? null }),
    }).then((r) => r.data.viewers),
  leavePresence: (id: string) =>
    api<Wrapped<{ viewers: AppPresenceViewer[] }>>(`/v1/apps/${id}/presence`, { method: 'DELETE' }).then((r) => r.data.viewers),
  runOperatorCommand: (id: string, command: string) =>
    api<Wrapped<unknown>>(`/v1/apps/${id}/operator/command`, { method: 'POST', body: JSON.stringify({ command }) }).then((r) => r.data),
  exportApp: (id: string) => api<Wrapped<AppManifestEnvelope>>(`/v1/apps/${id}/export?revisionTarget=candidate`).then((r) => r.data),
  previewImport: (envelope: AppManifestEnvelope) =>
    api<Wrapped<AppInstallPreview>>('/v1/apps/import/preview', { method: 'POST', body: JSON.stringify(envelope) }).then((r) => r.data),
  importApp: (envelope: AppManifestEnvelope, permissionsAcknowledged: string[]) =>
    api<Wrapped<{ appId: string }>>('/v1/apps/import', {
      method: 'POST',
      body: JSON.stringify({ envelope, permissionsAcknowledged }),
    }).then((r) => r.data),
  listEnvironments: (id: string) =>
    api<Wrapped<AppEnvironment[]>>(`/v1/apps/${id}/environments`).then((r) => r.data),
  snapshotEnvironment: (id: string, name: string, kind: 'dev' | 'staging' | 'production') =>
    api<Wrapped<AppEnvironment>>(`/v1/apps/${id}/environments/${encodeURIComponent(name)}/snapshot`, {
      method: 'POST',
      body: JSON.stringify({ kind }),
    }).then((r) => r.data),
  upsertEnvironment: (id: string, name: string, body: { kind: 'dev' | 'staging' | 'production'; manifest: AppManifest }) =>
    api<Wrapped<AppEnvironment>>(`/v1/apps/${id}/environments/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }).then((r) => r.data),
  promoteEnvironment: (
    id: string,
    name: string,
    body: { targetName: string; targetKind: 'dev' | 'staging' | 'production'; applyToRuntime: boolean },
  ) =>
    api<Wrapped<{ environment: AppEnvironment; runtimeUpgrade?: unknown }>>(`/v1/apps/${id}/environments/${encodeURIComponent(name)}/promote`, {
      method: 'POST',
      body: JSON.stringify(body),
    }).then((r) => r.data),
  /** Workflow control plane (E0): the App's workflows with purpose/order/trigger/last-run. */
  listWorkflows: (id: string) => api<Wrapped<AppWorkflowSummary[]>>(`/v1/apps/${id}/workflows`).then((r) => r.data),
  doctor: (id: string) => api<Wrapped<AppDoctorReport>>(`/v1/apps/${id}/doctor`).then((r) => r.data),
  compile: (id: string, target: AppCompileReport['target'] = 'production') =>
    api<Wrapped<AppCompileReport>>(`/v1/apps/${id}/compile?target=${encodeURIComponent(target)}`).then((r) => r.data),
  orchestrationRules: (id: string) => api<Wrapped<AppOrchestrationRule[]>>(`/v1/apps/${id}/orchestration-rules`).then((r) => r.data),
  createOrchestrationRule: (id: string, body: AppOrchestrationRuleInput) =>
    api<Wrapped<AppOrchestrationRule>>(`/v1/apps/${id}/orchestration-rules`, {
      method: 'POST', body: JSON.stringify(body),
    }).then((r) => r.data),
  updateOrchestrationRule: (id: string, ruleId: string, body: Partial<AppOrchestrationRuleInput>) =>
    api<Wrapped<AppOrchestrationRule>>(`/v1/apps/${id}/orchestration-rules/${encodeURIComponent(ruleId)}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }).then((r) => r.data),
  deleteOrchestrationRule: (id: string, ruleId: string) =>
    api<Wrapped<{ ok: true }>>(`/v1/apps/${id}/orchestration-rules/${encodeURIComponent(ruleId)}`, {
      method: 'DELETE',
    }).then((r) => r.data),
  /** Start one of the App's workflows; returns the new run id (202). */
  runAppWorkflow: (id: string, workflowId: string) =>
    api<Wrapped<{ runId: string }>>(`/v1/apps/${id}/workflows/${encodeURIComponent(workflowId)}/run`, { method: 'POST' }).then((r) => r.data),
  /** Continue from the first unresolved frontier; pass fresh only for an intentional root replay. */
  runAllAppWorkflows: (id: string, mode: 'continue' | 'fresh' = 'continue', overrideAck?: string) =>
    api<Wrapped<{ mode: 'continue' | 'fresh'; results: Array<{ workflowId: string; runId: string | null; skipped?: string; reusedRunId?: string }> }>>(
      `/v1/apps/${id}/workflows/run-all`,
      { method: 'POST', body: JSON.stringify({ mode, ...(overrideAck ? { override: { ack: overrideAck } } : {}) }) },
    ).then((r) => r.data.results),
  /** Update an App→workflow binding (purpose/order/enabled/dependsOn). */
  updateWorkflowBinding: (id: string, workflowId: string, binding: UpdateAppWorkflowBindingInput) =>
    api<Wrapped<AppWorkflowBinding>>(`/v1/apps/${id}/workflows/${encodeURIComponent(workflowId)}/binding`, {
      method: 'PATCH',
      body: JSON.stringify(binding),
    }).then((r) => r.data),
  /** App-level always-on state: which workflows author unattended triggers and whether they're armed. */
  getDeployment: (id: string) =>
    api<Wrapped<AppDeploymentSummary>>(`/v1/apps/${id}/deployment`).then((r) => r.data),
  /** Go Live: arm every workflow in the App that authors an unattended trigger. */
  activate: (id: string, override?: { ack: string }) =>
    api<Wrapped<{ deployment: AppDeploymentSummary; results: AppActivationResult[] }>>(`/v1/apps/${id}/activate`, {
      method: 'POST',
      body: JSON.stringify(override ? { override } : {}),
    }).then((r) => r.data),
  /** Disarm every armed trigger in the App. */
  deactivate: (id: string) =>
    api<Wrapped<{ deployment: AppDeploymentSummary; results: AppActivationResult[] }>>(`/v1/apps/${id}/deactivate`, {
      method: 'POST',
    }).then((r) => r.data),
  /** Arm a single workflow's trigger from the control deck. */
  armWorkflow: (id: string, workflowId: string, override?: { ack: string }) =>
    api<Wrapped<WorkflowTriggerDeploymentStatus>>(`/v1/apps/${id}/workflows/${encodeURIComponent(workflowId)}/arm`, {
      method: 'POST',
      body: JSON.stringify(override ? { override } : {}),
    }).then((r) => r.data),
  /** Disarm (pause) a single workflow's trigger. */
  disarmWorkflow: (id: string, workflowId: string) =>
    api<Wrapped<WorkflowTriggerDeploymentStatus>>(`/v1/apps/${id}/workflows/${encodeURIComponent(workflowId)}/disarm`, {
      method: 'POST',
    }).then((r) => r.data),
  adoptWorkflow: (id: string, workflowId: string) =>
    api<Wrapped<string[]>>(`/v1/apps/${id}/workflows`, {
      method: 'POST',
      body: JSON.stringify({ workflowId }),
    }).then((r) => r.data),
  dispatchAction: (id: string, surface: string, action: string, args: Record<string, unknown>) =>
    api<Wrapped<unknown>>(`/v1/apps/${id}/surfaces/${encodeURIComponent(surface)}/actions/${encodeURIComponent(action)}`, {
      method: 'POST',
      body: JSON.stringify({ args }),
    }),

  // Datastore
  listCollections: (id: string) => api<Wrapped<CollectionInfo[]>>(`/v1/apps/${id}/collections`).then((r) => r.data),
  query: (
    id: string,
    collection: string,
    q: { filter?: Record<string, unknown>; sort?: Array<{ field: string; dir: 'asc' | 'desc' }>; limit?: number; cursor?: string },
  ) =>
    api<{ rows: CollectionRecord[]; nextCursor?: string }>(
      `/v1/apps/${id}/collections/${encodeURIComponent(collection)}/query`,
      { method: 'POST', body: JSON.stringify(q) },
    ),
  insertRecord: (id: string, collection: string, record: Record<string, unknown>) =>
    api<Wrapped<CollectionRecord>>(`/v1/apps/${id}/collections/${encodeURIComponent(collection)}/records`, {
      method: 'POST',
      body: JSON.stringify({ record }),
    }).then((r) => r.data),
  insertMany: (id: string, collection: string, records: Array<Record<string, unknown>>) =>
    api<Wrapped<{ inserted: number; failed: Array<{ index: number; error: string }> }>>(
      `/v1/apps/${id}/collections/${encodeURIComponent(collection)}/records/batch`,
      { method: 'POST', body: JSON.stringify({ records }) },
    ).then((r) => r.data),
  updateRecord: (id: string, collection: string, recordId: string, patch: Record<string, unknown>) =>
    api<Wrapped<CollectionRecord>>(`/v1/apps/${id}/collections/${encodeURIComponent(collection)}/records/${encodeURIComponent(recordId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ patch }),
    }).then((r) => r.data),
  deleteRecord: (id: string, collection: string, recordId: string) =>
    api<Wrapped<{ ok: boolean }>>(`/v1/apps/${id}/collections/${encodeURIComponent(collection)}/records/${encodeURIComponent(recordId)}`, {
      method: 'DELETE',
    }).then((r) => r.data),

  // Public, unauthed share (AGENTIC-APPS-10X §4.7)
  publicSurface: (token: string) =>
    api<Wrapped<{ app: { name: string; icon: string | null }; surface: AppSurface }>>(`/v1/apps/public/surfaces/${encodeURIComponent(token)}`).then((r) => r.data),
  publicQuery: (token: string, collection: string, q: Record<string, unknown>) =>
    api<{ rows: CollectionRecord[]; nextCursor?: string }>(
      `/v1/apps/public/surfaces/${encodeURIComponent(token)}/query`,
      { method: 'POST', body: JSON.stringify({ collection, ...q }) },
    ),
};
