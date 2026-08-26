import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  AgentisError,
  schemas,
  type ActiveWorkflowSummary,
  type AppActivationResult,
  type AppDeploymentSummary,
  type AppWorkflowDeploymentRow,
  type ListenerConfig,
  type TriggerNodeConfig,
  type WorkflowGraph,
  type WorkflowNode,
} from '@agentis/core';
import { nextCronFire, nextCronFireInTimezone } from '../cronNextFire.js';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { TriggerRuntime } from '../../engine/TriggerRuntime.js';
import type { ActiveTrigger } from '../../engine/ActiveWorkflowRegistry.js';
import { normalizeExtensionManifest } from '../extensionRuntime.js';
import { preflightWorkflow } from './workflowPreflight.js';
import { deriveLoopStage, graphContentHash, readBuildLoop } from './workflowCompass.js';

type TriggerType = TriggerNodeConfig['triggerType'];

export interface WorkflowTriggerDeployment {
  triggerId: string;
  workflowId: string;
  triggerType: TriggerType;
  /** Canvas-facing type before runtime normalization. */
  authoredTriggerType: TriggerType;
  status: 'active' | 'paused' | 'error';
  updatedAt: string;
  lastFiredAt: string | null;
  nextRunAt: string | null;
  webhookUrl?: string;
  webhookSecret?: string;
  config: Record<string, unknown>;
  health?: unknown;
}

export class WorkflowTriggerDeploymentService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly runtime: TriggerRuntime,
  ) {}

  get(workspaceId: string, workflowId: string): WorkflowTriggerDeployment | null {
    const workflow = this.#loadWorkflow(workspaceId, workflowId);
    const graph = this.#deploymentGraph(workflow);
    const triggerNode = findTriggerNode(graph, false);
    const triggerId = triggerNode?.config.kind === 'trigger' ? triggerNode.config.triggerId : undefined;
    const rows = this.#workflowTriggers(workspaceId, workflowId);
    const row = (triggerId ? rows.find((candidate) => candidate.id === triggerId) : undefined)
      ?? pickCanonicalTrigger(rows);
    return row ? this.#present(row) : null;
  }

  async activate(args: {
    workspaceId: string;
    workflowId: string;
    ambientId: string | null;
    userId: string;
    /** SWIFT arming-gate override — explicit + audited, never silent. */
    override?: { ack: string };
  }): Promise<WorkflowTriggerDeployment> {
    const workflow = this.#loadWorkflow(args.workspaceId, args.workflowId);
    // Activation is an explicit request to apply what the operator currently
    // sees in the editor. Trigger settings live on the candidate head while
    // ordinary autosave/revision policy remains isolated, so reading only the
    // published graph can silently arm the previous trigger type (often manual).
    const graph = this.#deploymentGraph(workflow);
    const health = preflightWorkflow({
      db: this.db,
      workspaceId: args.workspaceId,
      workflowId: args.workflowId,
      graph,
    });
    if (health.status === 'blocked') {
      const first = health.issues.find((issue) => issue.severity === 'error');
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        `Workflow cannot be activated until preflight passes${first ? `: ${first.message}` : ''}`,
      );
    }
    const triggerNode = findTriggerNode(graph, true)!;
    const authored = triggerNode.config as TriggerNodeConfig;

    const runtimeConfig = runtimeConfigFromNode(authored);
    const effectiveType = effectiveTriggerType(authored.triggerType);
    if (effectiveType !== 'manual') {
      this.#assertRuntimeDependencies(args.workspaceId, effectiveType, runtimeConfig);
      // ── SWIFT arming gate (§2-T1): an UNATTENDED trigger (cron / webhook /
      // listener) only arms on a workflow whose CURRENT graph earned hardened
      // (or already proved itself with a completed production run). Operational
      // preflight above proves it CAN run; this gate proves it ACCOMPLISHES.
      // Override is explicit + audited — never silent.
      const stage = deriveLoopStage(readBuildLoop(workflow.settings), graphContentHash(graph));
      const revisionProven = workflow.trustState === 'proven' || workflow.trustState === 'break_glass';
      if (!revisionProven || (stage !== 'hardened' && stage !== 'production')) {
        const operator = this.db.select({ isAdmin: schema.users.isAdmin })
          .from(schema.users)
          .where(eq(schema.users.id, args.userId))
          .get();

        const ackReason = args.override?.ack?.trim() || (operator?.isAdmin ? 'Administrator direct activation' : null);

        if (ackReason) {
          this.db.insert(schema.auditEntries).values({
            id: randomUUID(),
            workspaceId: args.workspaceId,
            runId: `trigger:${args.workflowId}`,
            phaseId: null,
            nodeId: null,
            agentId: null,
            action: 'trigger.armed_unhardened',
            actorType: 'user',
            actorId: args.userId,
            inputSummary: `stage=${stage}; revisionTrust=${workflow.trustState}`,
            outputSummary: `override ack: ${ackReason.slice(0, 300)}`,
            at: new Date().toISOString(),
          }).run();
        } else {
          // Human-first message: the OPERATOR sees this in the UI, and telling
          // them to run `agentis.workflow.*` tools they cannot invoke is a dead
          // end. State the situation and the choice; keep the agent's tool hints
          // in `details.agentHint` where a harness can still read them. The
          // `BLOCKED_LIFECYCLE_NOT_HARDENED:` prefix is load-bearing — activateApp
          // classifies a blocked workflow by matching it (see activateApp below).
          throw new AgentisError(
            'WORKFLOW_GRAPH_INVALID',
            `BLOCKED_LIFECYCLE_NOT_HARDENED: This workflow hasn't been proven at its current version yet (stage "${stage}"), so Agentis won't arm an unattended ${effectiveType} trigger on it automatically. You can activate it anyway — you'll be asked to give a reason, which is recorded in the audit log.`,
            {
              details: {
                blocked: 'not_hardened',
                stage,
                triggerType: effectiveType,
                /** The UI uses this to offer the audited override instead of a dead end. */
                overridable: true,
                agentHint:
                  'spec scoped → dry-run green → suite green → debug run ACCOMPLISHED → agentis.workflow.harden. Run agentis.workflow.loop_status for the exact next call, or pass override:{ack:"<reason>"} to arm anyway (audited).',
              },
            },
          );
        }
      }
    }
    const persistedConfig = {
      ...runtimeConfig,
      __authoredTriggerType: authored.triggerType,
    };
    const existingRows = this.#workflowTriggers(args.workspaceId, args.workflowId);
    const existing = (authored.triggerId
      ? existingRows.find((candidate) => candidate.id === authored.triggerId)
      : undefined) ?? pickCanonicalTrigger(existingRows);

    // A graph has one entry trigger, so only one runtime resource may remain live.
    for (const row of existingRows) {
      if (row.status === 'active') await this.runtime.deactivate(row.id);
    }

    const triggerId = existing?.id ?? authored.triggerId ?? randomUUID();
    const triggerType = effectiveType;
    const now = new Date().toISOString();
    const needsWebhookSecret = triggerType === 'webhook'
      && (!existing?.webhookSecret || existing.triggerType !== 'webhook');
    const webhookSecret = triggerType === 'webhook'
      ? existing?.triggerType === 'webhook' && existing.webhookSecret
        ? existing.webhookSecret
        : randomBytes(32).toString('base64url')
      : null;

    if (existing) {
      this.db
        .update(schema.triggers)
        .set({
          ambientId: args.ambientId,
          userId: args.userId,
          triggerType,
          config: persistedConfig,
          status: 'paused',
          webhookSecret,
          updatedAt: now,
        })
        .where(eq(schema.triggers.id, triggerId))
        .run();
    } else {
      this.db
        .insert(schema.triggers)
        .values({
          id: triggerId,
          workspaceId: args.workspaceId,
          ambientId: args.ambientId,
          workflowId: args.workflowId,
          userId: args.userId,
          triggerType,
          config: persistedConfig,
          status: 'paused',
          webhookSecret,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    // The trigger row is the deployment record. Never write its generated id or
    // runtime-normalized config back into the active graph: doing so used to
    // mutate proven production bytes as a side effect of arming a trigger.

    if (triggerType === 'manual') {
      this.db
        .update(schema.triggers)
        .set({ status: 'active', updatedAt: new Date().toISOString() })
        .where(eq(schema.triggers.id, triggerId))
        .run();
    } else {
      const active = toActiveTrigger({
        triggerId,
        workflowId: args.workflowId,
        workspaceId: args.workspaceId,
        ambientId: args.ambientId,
        userId: args.userId,
        triggerType,
        config: persistedConfig,
      });
      try {
        await this.runtime.activate(active);
      } catch (error) {
        this.db
          .update(schema.triggers)
          .set({ status: 'error', updatedAt: new Date().toISOString() })
          .where(eq(schema.triggers.id, triggerId))
          .run();
        throw error;
      }
    }

    const row = this.db.select().from(schema.triggers).where(eq(schema.triggers.id, triggerId)).get()!;
    return this.#present(row, needsWebhookSecret ? webhookSecret ?? undefined : undefined);
  }

  async setStatus(
    workspaceId: string,
    workflowId: string,
    status: 'active' | 'paused',
  ): Promise<WorkflowTriggerDeployment> {
    this.#loadWorkflow(workspaceId, workflowId);
    const row = pickCanonicalTrigger(this.#workflowTriggers(workspaceId, workflowId));
    if (!row) {
      throw new AgentisError('RESOURCE_NOT_FOUND', 'This workflow has not been activated yet.');
    }
    if (row.triggerType === 'manual') {
      this.db.update(schema.triggers).set({ status, updatedAt: new Date().toISOString() }).where(eq(schema.triggers.id, row.id)).run();
    } else if (status === 'active') {
      await this.runtime.activate(toActiveTrigger({
        triggerId: row.id,
        workflowId: row.workflowId,
        workspaceId: row.workspaceId,
        ambientId: row.ambientId,
        userId: row.userId,
        triggerType: row.triggerType as ActiveTrigger['triggerType'],
        config: objectRecord(row.config),
      }));
    } else {
      await this.runtime.deactivate(row.id);
    }
    const fresh = this.db.select().from(schema.triggers).where(eq(schema.triggers.id, row.id)).get()!;
    return this.#present(fresh);
  }

  // ─────────────────────────────────────────────
  // App-level always-on lifecycle
  // ─────────────────────────────────────────────
  //
  // An App is multi-workflow, so "going live" means arming every workflow that
  // authors an unattended trigger. These methods COMPOSE the per-workflow
  // `activate` / `setStatus` above (never a forked activation path) so the App
  // lifecycle stays consistent with the canvas one, SWIFT arming gate included.

  /** Composite activation state of an App across all its bound workflows. */
  getForApp(workspaceId: string, appId: string): AppDeploymentSummary {
    const workflows = this.#appWorkflows(workspaceId, appId);
    const rows: AppWorkflowDeploymentRow[] = [];
    const listeners = { connected: 0, events: 0, runs: 0, errors: 0 };
    let armable = 0;
    let armed = 0;
    for (const wf of workflows) {
      const authored = authoredTriggerType(wf.graph as WorkflowGraph);
      const effective = authored ? effectiveTriggerType(authored) : null;
      const dep = this.get(workspaceId, wf.id);
      if (!effective || effective === 'manual') {
        rows.push({ workflowId: wf.id, title: wf.title, triggerType: 'manual', status: 'manual', lastFiredAt: dep?.lastFiredAt ?? null });
        continue;
      }
      armable += 1;
      const status = dep && dep.triggerType !== 'manual' ? dep.status : 'unarmed';
      if (status === 'active') {
        armed += 1;
        const health = dep?.health as { connected?: boolean; eventCount?: number; fireCount?: number; status?: string } | null | undefined;
        if (health) {
          if (health.connected) listeners.connected += 1;
          listeners.events += Number(health.eventCount ?? 0);
          listeners.runs += Number(health.fireCount ?? 0);
          if (health.status === 'error') listeners.errors += 1;
        }
      }
      rows.push({
        workflowId: wf.id,
        title: wf.title,
        triggerType: effective,
        status,
        lastFiredAt: dep?.lastFiredAt ?? null,
        ...(effective === 'persistent_listener' ? { health: dep?.health } : {}),
      });
    }
    const status: AppDeploymentSummary['status'] =
      armable === 0 ? 'none' : armed === 0 ? 'paused' : armed === armable ? 'live' : 'partial';
    return { appId, status, armable, armed, listeners, workflows: rows };
  }

  /**
   * Every "always-on" workflow across the workspace — one whose entry trigger is
   * currently ARMED (active, non-manual). The workspace-wide source for /home's
   * Active section and any platform-wide live indicator.
   */
  listActive(workspaceId: string): ActiveWorkflowSummary[] {
    const armed = this.db
      .select()
      .from(schema.triggers)
      .where(and(eq(schema.triggers.workspaceId, workspaceId), eq(schema.triggers.status, 'active')))
      .all()
      .filter((t) => t.triggerType !== 'manual');

    const out: ActiveWorkflowSummary[] = [];
    for (const t of armed) {
      const wf = this.db
        .select({ id: schema.workflows.id, title: schema.workflows.title, appId: schema.workflows.appId })
        .from(schema.workflows)
        .where(eq(schema.workflows.id, t.workflowId))
        .get();
      if (!wf) continue;
      const app = wf.appId
        ? this.db.select({ name: schema.apps.name }).from(schema.apps).where(eq(schema.apps.id, wf.appId)).get()
        : null;
      // Recent history in one read — the newest doubles as `lastRun`.
      const recentRows = this.db
        .select({ id: schema.workflowRuns.id, status: schema.workflowRuns.status, startedAt: schema.workflowRuns.startedAt, completedAt: schema.workflowRuns.completedAt, createdAt: schema.workflowRuns.createdAt })
        .from(schema.workflowRuns)
        .where(and(eq(schema.workflowRuns.workspaceId, workspaceId), eq(schema.workflowRuns.workflowId, wf.id)))
        .orderBy(desc(schema.workflowRuns.createdAt))
        .limit(8)
        .all();
      const recentRuns = recentRows.map((r) => ({
        id: r.id,
        status: r.status,
        at: r.startedAt ?? r.createdAt,
        durationMs: r.startedAt && r.completedAt ? Math.max(0, Date.parse(r.completedAt) - Date.parse(r.startedAt)) : null,
      }));
      const lastRun = recentRuns[0] ?? null;
      // An active run can be older than the recent window (parked WAITING/PAUSED).
      const activeRun = this.db
        .select({ id: schema.workflowRuns.id, status: schema.workflowRuns.status, startedAt: schema.workflowRuns.startedAt, createdAt: schema.workflowRuns.createdAt })
        .from(schema.workflowRuns)
        .where(and(
          eq(schema.workflowRuns.workspaceId, workspaceId),
          eq(schema.workflowRuns.workflowId, wf.id),
          inArray(schema.workflowRuns.status, ['RUNNING', 'WAITING', 'PAUSED']),
        ))
        .orderBy(desc(schema.workflowRuns.createdAt))
        .limit(1)
        .get();
      const totalRuns = this.db
        .select({ n: sql<number>`count(*)` })
        .from(schema.workflowRuns)
        .where(and(eq(schema.workflowRuns.workspaceId, workspaceId), eq(schema.workflowRuns.workflowId, wf.id)))
        .get()?.n ?? 0;

      const config = objectRecord(t.config);
      const triggerType = t.triggerType as 'cron' | 'webhook' | 'persistent_listener';
      const source = objectRecord(config.source);
      const intervalMs = source.kind === 'interval' && typeof source.intervalMs === 'number' ? source.intervalMs : null;
      const nextRunAt = triggerType === 'cron' && typeof config.expression === 'string'
        ? nextCronFire(config.expression)?.toISOString() ?? null
        : intervalMs && t.lastFiredAt
          ? new Date(Date.parse(t.lastFiredAt) + intervalMs).toISOString()
          : null;
      out.push({
        workflowId: wf.id,
        title: wf.title,
        appId: wf.appId ?? null,
        appName: app?.name ?? null,
        triggerType,
        status: normalizeStatus(t.status),
        lastFiredAt: t.lastFiredAt,
        nextRunAt,
        intervalMs,
        ...(triggerType === 'persistent_listener' ? { health: this.runtime.listeners?.health(t.id) ?? null } : {}),
        lastRun: lastRun ? { id: lastRun.id, status: lastRun.status, at: lastRun.at } : null,
        activeRun: activeRun ? { id: activeRun.id, status: activeRun.status, startedAt: activeRun.startedAt ?? activeRun.createdAt } : null,
        recentRuns,
        totalRuns,
      });
    }
    // Live first, then most-recently-fired.
    return out.sort((a, b) => {
      if (!!a.activeRun !== !!b.activeRun) return a.activeRun ? -1 : 1;
      return (b.lastFiredAt ?? '').localeCompare(a.lastFiredAt ?? '');
    });
  }

  /** Arm every armable workflow in an App. Per-workflow failures are reported, not fatal. */
  async activateApp(args: {
    workspaceId: string;
    appId: string;
    userId: string;
    /** SWIFT arming-gate override — applied per workflow, audited. */
    override?: { ack: string };
  }): Promise<{ deployment: AppDeploymentSummary; results: AppActivationResult[] }> {
    const workflows = this.#appWorkflows(args.workspaceId, args.appId);
    const results: AppActivationResult[] = [];
    for (const wf of workflows) {
      const authored = authoredTriggerType(wf.graph as WorkflowGraph);
      const effective = authored ? effectiveTriggerType(authored) : null;
      if (!effective || effective === 'manual') {
        results.push({ workflowId: wf.id, title: wf.title, outcome: 'skipped', message: 'Manual trigger — run on demand.' });
        continue;
      }
      try {
        await this.activate({
          workspaceId: args.workspaceId,
          workflowId: wf.id,
          ambientId: wf.ambientId,
          userId: args.userId,
          override: args.override,
        });
        results.push({ workflowId: wf.id, title: wf.title, outcome: 'armed' });
      } catch (error) {
        const err = error as AgentisError & { message: string };
        const blocked = typeof err.message === 'string' && /BLOCKED_LIFECYCLE_NOT_HARDENED/.test(err.message);
        results.push({
          workflowId: wf.id,
          title: wf.title,
          outcome: blocked ? 'blocked' : 'error',
          message: err.message,
        });
      }
    }
    return { deployment: this.getForApp(args.workspaceId, args.appId), results };
  }

  /** Disarm (pause) every armed workflow in an App. */
  async deactivateApp(args: {
    workspaceId: string;
    appId: string;
  }): Promise<{ deployment: AppDeploymentSummary; results: AppActivationResult[] }> {
    const workflows = this.#appWorkflows(args.workspaceId, args.appId);
    const results: AppActivationResult[] = [];
    for (const wf of workflows) {
      const dep = this.get(args.workspaceId, wf.id);
      if (!dep || dep.triggerType === 'manual' || dep.status !== 'active') {
        continue;
      }
      try {
        await this.setStatus(args.workspaceId, wf.id, 'paused');
        results.push({ workflowId: wf.id, title: wf.title, outcome: 'disarmed' });
      } catch (error) {
        results.push({ workflowId: wf.id, title: wf.title, outcome: 'error', message: (error as Error).message });
      }
    }
    return { deployment: this.getForApp(args.workspaceId, args.appId), results };
  }

  #appWorkflows(workspaceId: string, appId: string) {
    return this.db
      .select({
        id: schema.workflows.id,
        title: schema.workflows.title,
        ambientId: schema.workflows.ambientId,
        graph: schema.workflows.graph,
      })
      .from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.appId, appId)))
      .all();
  }

  #loadWorkflow(workspaceId: string, workflowId: string) {
    const workflow = this.db
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.id, workflowId), eq(schema.workflows.workspaceId, workspaceId)))
      .get();
    if (!workflow) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow ${workflowId} not found`);
    return workflow;
  }

  #workflowTriggers(workspaceId: string, workflowId: string) {
    return this.db
      .select()
      .from(schema.triggers)
      .where(and(eq(schema.triggers.workspaceId, workspaceId), eq(schema.triggers.workflowId, workflowId)))
      .all();
  }

  #deploymentGraph(workflow: typeof schema.workflows.$inferSelect): WorkflowGraph {
    if (workflow.candidateRevisionId) {
      const candidate = this.db.select({ graphJson: schema.workflowGraphRevisions.graphJson })
        .from(schema.workflowGraphRevisions)
        .where(and(
          eq(schema.workflowGraphRevisions.id, workflow.candidateRevisionId),
          eq(schema.workflowGraphRevisions.workflowId, workflow.id),
          eq(schema.workflowGraphRevisions.workspaceId, workflow.workspaceId),
        ))
        .get();
      if (candidate?.graphJson) return candidate.graphJson as WorkflowGraph;
    }
    return workflow.graph as WorkflowGraph;
  }

  #present(
    row: typeof schema.triggers.$inferSelect,
    webhookSecret?: string,
  ): WorkflowTriggerDeployment {
    const triggerType = row.triggerType as TriggerType;
    const storedConfig = objectRecord(row.config);
    const authoredType = deployedAuthoredTriggerType(triggerType, storedConfig);
    const { __authoredTriggerType: _authoredType, ...config } = storedConfig;
    return {
      triggerId: row.id,
      workflowId: row.workflowId,
      triggerType,
      authoredTriggerType: authoredType,
      status: normalizeStatus(row.status),
      updatedAt: row.updatedAt,
      lastFiredAt: row.lastFiredAt,
      nextRunAt: nextDeploymentFire(triggerType, config),
      config,
      ...(triggerType === 'webhook' ? { webhookUrl: `/v1/webhooks/trigger/${row.id}` } : {}),
      ...(webhookSecret ? { webhookSecret } : {}),
      ...(triggerType === 'persistent_listener'
        ? { health: this.runtime.listeners?.health(row.id) ?? null }
        : {}),
    };
  }

  #assertRuntimeDependencies(
    workspaceId: string,
    triggerType: Exclude<TriggerType, 'manual'>,
    config: Record<string, unknown>,
  ): void {
    if (triggerType !== 'persistent_listener') return;
    const listener = config as unknown as ListenerConfig;
    if (listener.source.kind === 'extension') {
      const source = listener.source;
      const extension = source.extensionId
        ? this.db.select().from(schema.extensions).where(eq(schema.extensions.id, source.extensionId)).get()
        : this.db
            .select()
            .from(schema.extensions)
            .where(and(
              eq(schema.extensions.workspaceId, workspaceId),
              eq(schema.extensions.slug, source.extensionSlug ?? ''),
            ))
            .get();
      if (!extension || extension.workspaceId !== workspaceId) {
        throw new AgentisError('EXTENSION_NOT_FOUND', 'Choose an installed listener-source extension.');
      }
      const manifest = normalizeExtensionManifest(extension.manifest, extension);
      const operation = manifest.operations.find((candidate) => candidate.name === source.operationName);
      if (
        manifest.runtime !== 'node_worker'
        || !(manifest.permissions ?? []).includes('listener')
        || !(manifest.permissions ?? []).includes('listener.emit')
        || !operation
        || !(operation.isListenerSource || (manifest.listenerOperations ?? []).includes(operation.name))
      ) {
        throw new AgentisError(
          'EXTENSION_PERMISSION_INVALID',
          `${extension.name} does not expose "${source.operationName}" as a listener source.`,
        );
      }
    }
    if (listener.source.kind === 'agent_event') {
      const agent = this.db.select().from(schema.agents).where(eq(schema.agents.id, listener.source.agentId)).get();
      if (!agent || agent.workspaceId !== workspaceId) {
        throw new AgentisError('RESOURCE_NOT_FOUND', 'Choose an agent from this workspace for the listener source.');
      }
    }
    if (listener.source.kind === 'workflow_event' && listener.source.workflowId !== '*') {
      // `'*'` is the error_trigger "any workflow in this workspace" scope — no
      // specific target to verify.
      const workflow = this.db.select().from(schema.workflows).where(eq(schema.workflows.id, listener.source.workflowId)).get();
      if (!workflow || workflow.workspaceId !== workspaceId) {
        throw new AgentisError('RESOURCE_NOT_FOUND', 'Choose a workflow from this workspace for the listener source.');
      }
    }
  }
}

function deployedAuthoredTriggerType(
  triggerType: TriggerType,
  config: Record<string, unknown>,
): TriggerType {
  const stored = config.__authoredTriggerType;
  if (typeof stored === 'string' && [
    'manual', 'cron', 'webhook', 'persistent_listener', 'error_trigger', 'email_imap', 'rss_feed',
  ].includes(stored)) return stored as TriggerType;
  if (triggerType !== 'persistent_listener') return triggerType;
  const source = objectRecord(config.source);
  if (source.kind === 'rss') return 'rss_feed';
  if (source.kind === 'email_imap') return 'email_imap';
  return 'persistent_listener';
}

function findTriggerNode(graph: WorkflowGraph, required: boolean): WorkflowNode | null {
  const triggers = graph.nodes.filter((node) => node.config.kind === 'trigger');
  if (triggers.length === 1) return triggers[0]!;
  if (!required && triggers.length === 0) return null;
  throw new AgentisError(
    'TRIGGER_INVALID_CONFIG',
    triggers.length === 0
      ? 'Add a trigger node before activating this workflow.'
      : 'A workflow can only activate one trigger node.',
  );
}

/**
 * The 3 canvas trigger types added by WORKFLOW-UPDATE (error_trigger, rss_feed,
 * email_imap) are runtime-equivalent to `persistent_listener` — they each
 * synthesize a ListenerConfig and run through the ListenerRuntime. Everything
 * else maps to itself. This keeps the DB trigger taxonomy + ActiveTrigger union
 * unchanged while exposing the new types first-class on the canvas.
 */
export function effectiveTriggerType(
  t: TriggerNodeConfig['triggerType'],
): 'manual' | 'cron' | 'webhook' | 'persistent_listener' {
  if (t === 'error_trigger' || t === 'rss_feed' || t === 'email_imap') return 'persistent_listener';
  return t;
}

/** The authored trigger type of a graph's single entry trigger node, or null. */
function authoredTriggerType(graph: WorkflowGraph | null | undefined): TriggerNodeConfig['triggerType'] | null {
  const node = graph?.nodes?.find((n) => n.config?.kind === 'trigger');
  if (!node || node.config.kind !== 'trigger') return null;
  return (node.config as TriggerNodeConfig).triggerType ?? null;
}

function nextDeploymentFire(
  triggerType: TriggerType,
  config: Record<string, unknown>,
): string | null {
  if (triggerType !== 'cron') return null;
  const fallbackTimezone = typeof config.timezone === 'string' ? config.timezone : 'UTC';
  const rules = Array.isArray(config.scheduleRules)
    ? config.scheduleRules as Array<{ expression?: unknown; timezone?: unknown }>
    : [{ expression: config.expression, timezone: fallbackTimezone }];
  const next = rules
    .map((rule) => {
      if (typeof rule.expression !== 'string' || !rule.expression.trim()) return null;
      const timezone = typeof rule.timezone === 'string' && rule.timezone.trim()
        ? rule.timezone
        : fallbackTimezone;
      return nextCronFireInTimezone(rule.expression, timezone);
    })
    .filter((value): value is Date => Boolean(value))
    .sort((left, right) => left.getTime() - right.getTime())[0];
  return next?.toISOString() ?? null;
}

function runtimeConfigFromNode(config: TriggerNodeConfig): Record<string, unknown> {
  switch (config.triggerType) {
    case 'cron': {
      // Prefer the first non-empty scheduleRule, else the single `schedule`.
      const expression = config.scheduleRules?.find((r) => r.expression?.trim())?.expression?.trim()
        ?? config.schedule?.trim();
      if (!expression) {
        throw new AgentisError('TRIGGER_INVALID_CONFIG', 'Schedule triggers require a cron expression.');
      }
      const out: Record<string, unknown> = { expression, timezone: config.timezone?.trim() || 'UTC' };
      if (config.scheduleRules && config.scheduleRules.length > 0) {
        out.scheduleRules = config.scheduleRules
          .filter((r) => r.expression?.trim())
          .map((r) => ({ expression: r.expression.trim(), timezone: (r.timezone ?? config.timezone)?.trim() || 'UTC', label: r.label }));
      }
      return out;
    }
    case 'webhook':
      return {};
    case 'persistent_listener': {
      const parsed = schemas.listenerConfigSchema.safeParse(config.listenerConfig);
      if (!parsed.success) {
        throw new AgentisError('LISTENER_INVALID_CONFIG', 'Complete the listener source configuration before activating.', {
          details: { issues: parsed.error.issues },
        });
      }
      return parsed.data as ListenerConfig as unknown as Record<string, unknown>;
    }
    case 'error_trigger': {
      const et = config.errorTrigger;
      const onStatus = et?.onStatus && et.onStatus.length > 0 ? et.onStatus : (['FAILED'] as const);
      const listener: ListenerConfig = {
        source: { kind: 'workflow_event', workflowId: et?.targetWorkflowId ?? '*', onStatus: [...onStatus] },
        firePolicy: { mode: 'immediate' },
      };
      return validateSynthesizedListener(listener);
    }
    case 'rss_feed': {
      const rss = config.rssFeed;
      if (!rss?.feedUrl?.trim()) {
        throw new AgentisError('TRIGGER_INVALID_CONFIG', 'RSS triggers require a feed URL.');
      }
      const listener: ListenerConfig = {
        source: { kind: 'rss', feedUrl: rss.feedUrl.trim(), intervalMs: Math.max(5_000, rss.pollIntervalMs ?? 300_000) },
        firePolicy: { mode: 'immediate' },
      };
      return validateSynthesizedListener(listener);
    }
    case 'email_imap': {
      const im = config.emailImap;
      if (!im?.host?.trim()) {
        throw new AgentisError('TRIGGER_INVALID_CONFIG', 'IMAP triggers require a host.');
      }
      const listener: ListenerConfig = {
        source: {
          kind: 'email_imap',
          host: im.host.trim(),
          port: im.port,
          secure: im.secure,
          credentialId: im.credentialId,
          mailbox: im.mailbox,
          search: im.search,
          pollIntervalMs: Math.max(5_000, im.pollIntervalMs ?? 60_000),
        },
        firePolicy: { mode: 'immediate' },
      };
      return validateSynthesizedListener(listener);
    }
    case 'manual':
      return {};
  }
}

function validateSynthesizedListener(listener: ListenerConfig): Record<string, unknown> {
  const parsed = schemas.listenerConfigSchema.safeParse(listener);
  if (!parsed.success) {
    throw new AgentisError('LISTENER_INVALID_CONFIG', 'Synthesized listener config is invalid.', {
      details: { issues: parsed.error.issues },
    });
  }
  return parsed.data as ListenerConfig as unknown as Record<string, unknown>;
}

function pickCanonicalTrigger(
  rows: Array<typeof schema.triggers.$inferSelect>,
): typeof schema.triggers.$inferSelect | undefined {
  return [...rows].sort((left, right) => {
    if (left.status === 'active' && right.status !== 'active') return -1;
    if (right.status === 'active' && left.status !== 'active') return 1;
    return right.updatedAt.localeCompare(left.updatedAt);
  })[0];
}

function toActiveTrigger(args: {
  triggerId: string;
  workflowId: string;
  workspaceId: string;
  ambientId: string | null;
  userId: string;
  triggerType: ActiveTrigger['triggerType'];
  config: Record<string, unknown>;
}): ActiveTrigger {
  return args;
}

function normalizeStatus(value: string): 'active' | 'paused' | 'error' {
  return value === 'active' || value === 'error' ? value : 'paused';
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
