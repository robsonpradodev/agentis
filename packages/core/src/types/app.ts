

import { z } from 'zod';
import { CONSTANTS } from '../constants.js';
import { relationshipAutonomyPolicySchema } from './relationship.js';

// Local, single-operator lifecycle: an app either exists and is usable (`active`)
// or is retired (`archived`). Publishing ("draft"→"published") is a Hub concept
// and lives there, not in the local runtime. Legacy `draft`/`published` rows are
// coerced to `active` on read (see normalizeAppStatus).
export const appStatusSchema = z.enum(['active', 'archived']);
export type AppStatus = z.infer<typeof appStatusSchema>;

/** Map any stored/legacy status string to the current lifecycle. */
export function normalizeAppStatus(value: unknown): AppStatus {
  return value === 'archived' ? 'archived' : 'active';
}

export const appMemberRoleSchema = z.enum(['operator', 'worker']);
export type AppMemberRole = z.infer<typeof appMemberRoleSchema>;

export const appSourceSchema = z.object({
  kind: z.enum(['local', 'hub']),
  id: z.string().min(1),
  remoteId: z.string().min(1).optional(),
  author: z.record(z.unknown()).optional(),
});
export type AppSource = z.infer<typeof appSourceSchema>;

/** Slug shape shared with packages: lowercase, dash-separated, no leading/trailing dash. */
const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, 'slug must be lowercase alphanumeric with dashes');

/**
 * Identity/contract block of an App — the public-facing descriptor stored in
 * `apps.manifest_json`. This is the *identity* sub-part of the full portable
 * `AppManifest` IR (see `manifest.ts`, AGENTIC-SYSTEMS-ARCHITECTURE §2.1).
 */
/**
 * App **Goal** — the durable, cross-run north-star an App is trying to advance
 * (the reserved long-term "Goal" tier; run-scoped work stays "Objective", and a
 * Goal decomposes into Objectives pursued across runs). Optional `northStar`
 * names the metric the Evolution Loop optimizes toward so competing Strategies
 * can be compared. Rides in the App manifest — portable, no migration.
 */
export const appNorthStarSchema = z.object({
  /** The metric name the App optimizes (e.g. "conversion_rate", "resolution_time"). */
  metric: z.string().min(1).max(120),
  direction: z.enum(['maximize', 'minimize']).default('maximize'),
  /** Optional numeric target for the metric. */
  target: z.number().optional(),
});
export type AppNorthStar = z.infer<typeof appNorthStarSchema>;

export const appGoalSchema = z.object({
  /** One or two sentences stating what this App is trying to achieve over time. */
  statement: z.string().min(1).max(2000),
  northStar: appNorthStarSchema.nullable().optional(),
  /** Last time the goal was set/changed. */
  updatedAt: z.string().optional(),
});
export type AppGoal = z.infer<typeof appGoalSchema>;

export const appIdentitySchema = z.object({
  manifestVersion: z.literal(1).default(1),
  slug: slugSchema,
  name: z.string().min(1).max(160),
  version: z.string().min(1).max(64).default('0.1.0'),
  icon: z.string().nullable().optional(),
  /** Surface the runtime opens first. */
  entrySurfaceId: z.string().nullable().optional(),
  /** Structured, semantic capability descriptors (discovery). */
  capabilities: z.array(z.string()).default([]),
  /** Plugin/integration slugs the App needs the installing workspace to provide. */
  requiredPlugins: z.array(z.string()).default([]),
  /** The App's durable, cross-run Goal (Evolution Loop north-star). */
  goal: appGoalSchema.nullable().optional(),
});
export type AppIdentity = z.infer<typeof appIdentitySchema>;

/**
 * App policy — audience + auth + who-can-see/do-what. Enforced by the action
 * resolver (§4.4) and the custom-code bridge (§4.6). Intentionally permissive in
 * V1; the shape is stable so enforcement can tighten without a migration.
 */
/**
 * Outbound safety envelope (LIVING-APPS-10X §7 · G7). Gates an App's
 * *unsupervised* 24/7 outbound so a resident agent can't over-message a contact,
 * message in the dead of night, or promise something it must not. ALL fields are
 * optional and additive: an absent `outbound` block (or an absent field) means
 * today's unrestricted behavior. Enforced by `OutboundPolicyService.evaluate`.
 */
export const appOutboundPolicySchema = z.object({
  /** Cap on agent-initiated outbound messages per App per rolling hour. Absent = no cap. */
  maxPerHour: z.number().int().positive().optional(),
  /**
   * No unsupervised outbound during these local hours (24h clock). When
   * `start <= end` the window is `[start, end)`; when `start > end` it wraps past
   * midnight (e.g. `{start:22,end:7}` = 22:00–07:00). Inclusive of `start`,
   * exclusive of `end`.
   */
  quietHours: z
    .object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23) })
    .optional(),
  /** Substrings/patterns that must NEVER appear in outbound — a match denies the send outright. */
  blockedClaims: z.array(z.string().min(1)).default([]).optional(),
  
  requireApprovalFor: z.array(z.string().min(1)).default([]).optional(),
});
export type AppOutboundPolicy = z.infer<typeof appOutboundPolicySchema>;

export const appPolicySchema = z.object({
  /** CustomView/compiled-code escape hatch. Disabled by default for portable OSS apps. */
  customCode: z.enum(['disabled', 'allowed']).default('disabled'),
  
  grants: z.array(z.object({
    capability: z.string().min(1),
    source: z.enum(['native', 'app', 'plugin']).optional(),
    scopes: z.array(z.string()).default([]),
  })).default([]),
  /** Outbound safety envelope (G7) — rate/quiet-hours/claim limits on unsupervised sends. Absent = unrestricted. */
  outbound: appOutboundPolicySchema.optional(),
  /** Goal-directed authority envelope for replies, follow-ups, and external side effects. */
  autonomy: relationshipAutonomyPolicySchema.optional(),
});
export type AppPolicy = z.infer<typeof appPolicySchema>;

export interface AppRecord {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string;
  version: string;
  status: AppStatus;
  entrySurfaceId: string | null;
  icon: string | null;
  /** Domain (or Subdomain) this App is organized under. Its workflows inherit. */
  domainId: string | null;
  /** Specialist agent that owns this App; its workflows inherit at dispatch. */
  ownerAgentId: string | null;
  manifest: AppIdentity;
  policy: AppPolicy;
  source: AppSource | null;
  installedChecksum: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppMember {
  appId: string;
  agentId: string;
  role: AppMemberRole;
}

/** Create payload (route + AppStore). */
export const createAppSchema = z.object({
  slug: slugSchema.optional(),
  name: z.string().min(1).max(160),
  description: z.string().max(2000).default(''),
  icon: z.string().nullable().optional(),
  /** Domain (or Subdomain) to organize this App under. */
  domainId: z.string().nullable().optional(),
  /** Specialist agent that owns this App. */
  ownerAgentId: z.string().nullable().optional(),
  /** Adopt an existing workflow as the App's entry logic. */
  entryWorkflowId: z.string().optional(),
});
export type CreateAppInput = z.infer<typeof createAppSchema>;

/** Update payload — all fields optional, identity slug immutable post-create. */
export const updateAppSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  description: z.string().max(2000).optional(),
  icon: z.string().nullable().optional(),
  status: appStatusSchema.optional(),
  version: z.string().min(1).max(64).optional(),
  entrySurfaceId: z.string().nullable().optional(),
  domainId: z.string().nullable().optional(),
  ownerAgentId: z.string().nullable().optional(),
  manifest: appIdentitySchema.partial().optional(),
  policy: appPolicySchema.partial().optional(),
  source: appSourceSchema.nullable().optional(),
  installedChecksum: z.string().nullable().optional(),
});
export type UpdateAppInput = z.infer<typeof updateAppSchema>;


export const appWorkflowBindingSchema = z.object({
  order: z.number().int().min(0).optional(),
  purpose: z.string().max(400).optional(),
  enabled: z.boolean().optional(),
  /**
   * Whether the operator's Run Pipeline/Run All command may choose this
   * workflow as a root. Event-, channel-, webhook-, and schedule-driven roots
   * set this false while remaining enabled for their own persisted trigger.
   */
  operatorEntrypoint: z.boolean().optional(),
  dependsOn: z.array(z.string()).default([]),
  /**
   * App-level recurring schedule (APP-INTERFACE-10X §2.3) — a standard 5-field
   * cron expression the AppOrchestrator fires through the SAME run queue as every
   * other start (never a forked execution path). Graph-authored triggers stay
   * authoritative where present; this is the App's own layer for "run this at…".
   */
  schedule: z
    .object({
      cron: z.string().min(9).max(120),
      enabled: z.boolean().default(true),
    })
    .nullable()
    .optional(),
  /** `exclusive` = skip an orchestrated start while a run of this workflow is still active. */
  concurrency: z.enum(['parallel', 'exclusive']).optional(),
  /**
   * When dependents fire. `success` means clean completion for legacy unscoped
   * workflows and an ACCOMPLISHED world verdict whenever the upstream has a spec.
   * `failure` is the inverse — a true error branch that fires ONLY when the
   * upstream settled without succeeding. `always` fires after any terminal
   * settle (finally handling, cleanup, notification regardless of outcome).
   */
  chainOn: z.enum(['success', 'failure', 'always']).optional(),
  /**
   * Extra predicate on the upstream's result — the link fires only when this is
   * true. Evaluated against `{ upstream: { status, verdict, output }, app }` with
   * the same safe expression parser routers use (e.g.
   * `upstream.output.leadCount > 0`). Absent = no extra condition.
   *
   * This is what turns a chain from "B runs after A" into "B runs after A, if A
   * actually produced something worth running B for".
   */
  when: z.string().max(2000).nullable().optional(),
  /**
   * Wait before starting once every dependency is satisfied — a chain-link
   * `wait` without needing a node for it. `jitterMs` spreads dependents that
   * would otherwise all fire on the same instant (rate-limited downstreams,
   * shared APIs, staggered outreach); the delay itself covers settling time
   * for eventually-consistent upstream writes.
   */
  delay: z
    .object({
      ms: z.number().int().min(0).max(CONSTANTS.MAX_START_DELAY_MS).optional(),
      jitterMs: z.number().int().min(0).max(CONSTANTS.MAX_START_DELAY_MS).optional(),
    })
    .nullable()
    .optional(),
});
export type AppWorkflowBinding = z.infer<typeof appWorkflowBindingSchema>;

/** PATCH payload for an App→workflow binding. */
export const updateAppWorkflowBindingSchema = appWorkflowBindingSchema.partial();
export type UpdateAppWorkflowBindingInput = z.infer<typeof updateAppWorkflowBindingSchema>;

/** A workflow as seen from its owning App's control plane. */
export interface AppWorkflowSummary {
  id: string;
  title: string;
  /** Why this workflow exists in the App (binding.purpose, else the description). */
  purpose: string | null;
  order: number;
  enabled: boolean;
  operatorEntrypoint: boolean;
  dependsOn: string[];
  /** Derived from the trigger node: manual | cron | webhook | persistent_listener | … */
  triggerKind: string | null;
  /** Most recent run, if any. */
  lastRun: {
    id: string;
    status: string;
    at: string;
    /** World-verification result; absent for legacy unscoped runs. */
    outcome?: 'accomplished' | 'partial' | 'hollow' | 'failed_checks' | null;
    verified?: boolean;
    accomplished?: boolean;
  } | null;
  /** A run currently executing (running/waiting), if any — the live pulse. */
  activeRun: { id: string; status: string; startedAt: string } | null;
  /** App-level schedule rule (binding.schedule). */
  schedule: { cron: string; enabled: boolean } | null;
  /** Next App-level scheduled fire, when computable. */
  nextRunAt: string | null;
  /** Orchestrated-start concurrency policy. */
  concurrency: 'parallel' | 'exclusive';
  /** When dependents of this workflow fire. */
  chainOn: 'success' | 'failure' | 'always';
  /** Extra predicate gating this workflow's own start, when the link declares one. */
  when?: string | null;
  /** Link-level wait before this workflow starts once its dependencies are met. */
  delay?: { ms?: number; jitterMs?: number } | null;
  /**
   * Trigger activation (arming) state — distinct from a single run. `null` for a
   * manual-run workflow (nothing to arm; use Run). For an unattended trigger
   * (schedule / webhook / listener) this reports whether it is armed and live.
   */
  deployment: WorkflowTriggerDeploymentStatus | null;
}

/**
 * The activation state of a workflow's *entry trigger* — the always-on layer,
 * as opposed to a one-off run. `unarmed` = the graph authors an unattended
 * trigger that has never been activated; `manual` never appears here (a manual
 * workflow has `deployment: null`).
 */
export interface WorkflowTriggerDeploymentStatus {
  /** Runtime trigger type (error_trigger/rss_feed/email_imap collapse to persistent_listener). */
  triggerType: 'cron' | 'webhook' | 'persistent_listener';
  status: 'active' | 'paused' | 'error' | 'unarmed';
  /** Last time this trigger fired a run, if ever. */
  lastFiredAt: string | null;
  /** Live listener health (persistent_listener only): connected, event/fire counts, lastError. */
  health?: unknown;
}

/**
 * An App's composite activation state. An App is multi-workflow, so "going live"
 * means arming every workflow that authors an unattended trigger. This is the
 * always-on lifecycle the App control plane exposes on top of per-workflow
 * activation.
 */
export interface AppDeploymentSummary {
  appId: string;
  /**
   * - `none`    — no workflow authors an unattended trigger (nothing to arm)
   * - `paused`  — has armable triggers, none currently armed
   * - `partial` — some but not all armable triggers are armed
   * - `live`    — every armable trigger is armed
   */
  status: 'none' | 'paused' | 'partial' | 'live';
  /** Count of workflows whose graph authors an unattended (non-manual) trigger. */
  armable: number;
  /** Count of those currently active (armed). */
  armed: number;
  /** Aggregate live-source health across armed listeners. */
  listeners: { connected: number; events: number; runs: number; errors: number };
  workflows: AppWorkflowDeploymentRow[];
}

export interface AppWorkflowDeploymentRow {
  workflowId: string;
  title: string;
  /** Effective runtime trigger type, or `manual`. */
  triggerType: 'manual' | 'cron' | 'webhook' | 'persistent_listener';
  /** `manual` for run-on-demand workflows; otherwise the arming state. */
  status: 'manual' | 'active' | 'paused' | 'error' | 'unarmed';
  lastFiredAt: string | null;
  health?: unknown;
}

/**
 * A workspace-wide "always-on" workflow — one whose entry trigger is currently
 * armed (schedule / webhook / listener). Powers /home's Active section and any
 * platform-wide live indicator, distinct from a one-off run.
 */
export interface ActiveWorkflowSummary {
  workflowId: string;
  title: string;
  /** Owning App, when the workflow belongs to one. */
  appId: string | null;
  appName: string | null;
  triggerType: 'cron' | 'webhook' | 'persistent_listener';
  status: 'active' | 'paused' | 'error';
  /** Last time this trigger fired a run. */
  lastFiredAt: string | null;
  /** Next scheduled fire (cron + interval triggers), when computable. */
  nextRunAt: string | null;
  /** Fixed period between runs (ms) for cron/interval — lets the UI tick a live countdown. */
  intervalMs: number | null;
  /** Live listener health (persistent_listener only). */
  health?: unknown;
  /** Most recent run of this workflow. */
  lastRun: { id: string; status: string; at: string } | null;
  /** A run currently in flight, if any. */
  activeRun: { id: string; status: string; startedAt: string } | null;
  /** Recent run history, most-recent first — for a live sparkline/timeline. */
  recentRuns: ActiveWorkflowRun[];
  /** Total runs this trigger has fired (from listener health / run count). */
  totalRuns: number;
}

export interface ActiveWorkflowRun {
  id: string;
  status: string;
  at: string;
  /** Wall-clock run duration in ms, when finished. */
  durationMs: number | null;
}

/** Per-workflow outcome of an App-level arm/disarm sweep. */
export interface AppActivationResult {
  workflowId: string;
  title: string;
  outcome: 'armed' | 'disarmed' | 'skipped' | 'blocked' | 'error';
  /** Human-readable reason for `skipped` / `blocked` / `error`. */
  message?: string;
}



