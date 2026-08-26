/**
 * TriggerRuntime — V1-SPEC §7.
 *
 * Three trigger types are wired here:
 *  - cron: node-cron schedule. Rehydrated on boot from active triggers.
 *  - webhook: WebhookRouter consults this to look up the configured trigger
 *    + secret + idempotency window. The runtime exposes `fireWebhook()`.
 *  - persistent_listener: `AgentAdapter.createPersistentListener` is invoked
 *    once per active trigger and the returned handle is stashed for cleanup.
 *
 * `manual` is not handled here — that's a UI-side dispatch through
 * `/v1/workflows/:id/run`.
 *
 * `fire()` is the single entrypoint that creates a WorkflowRun row and asks
 * the engine to start it. Every fire path (cron, webhook, listener) goes
 * through it so observability is uniform.
 */

import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { CONSTANTS, AgentisError, type WorkflowGraph, REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { EventBus } from '../event-bus.js';
import type { ActiveWorkflowRegistry, ActiveTrigger } from './ActiveWorkflowRegistry.js';
import type { WorkflowEngine } from './WorkflowEngine.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import { type JobQueueBackend, shouldQueueWorkflowRun } from '../services/jobQueue.js';
import { buildInitialRunState } from './initialRunState.js';
import { ListenerRuntime } from './ListenerRuntime.js';
import { normalizeWorkflowGraph } from '../services/workflow/workflowGraphNormalization.js';
import type { WorkflowRevisionService } from '../services/workflow/workflowRevisionService.js';
import { connectorFromConfig, verifyConnectorWebhook } from './triggerConnectors.js';

interface CronLib {
  schedule(expression: string, callback: () => void, options?: { scheduled?: boolean; timezone?: string }): {
    start(): void;
    stop(): void;
  };
  validate(expression: string): boolean;
}

let cachedCron:
  | { kind: 'available'; cron: CronLib }
  | { kind: 'unavailable'; reason: string }
  | undefined;

async function loadCron() {
  if (cachedCron) return cachedCron;
  try {
    const mod = (await import('node-cron' as string)) as { default?: CronLib } & CronLib;
    cachedCron = { kind: 'available', cron: (mod.default ?? mod) as CronLib };
  } catch (err) {
    cachedCron = { kind: 'unavailable', reason: (err as Error).message };
  }
  return cachedCron;
}

export interface TriggerRuntimeDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  registry: ActiveWorkflowRegistry;
  engine: WorkflowEngine;
  adapters: AdapterManager;
  bus: EventBus;
  /**
   * Durable job queue. When wired, long-running / human-gated workflow runs
   * are enqueued (and survive a server restart) instead of dispatched inline.
   */
  jobQueue?: JobQueueBackend;
  /**
   * Persistent listener runtime. When wired, triggers whose
   * config is a ListenerConfig (source/predicate/firePolicy) are routed here
   * instead of the legacy adapter `createPersistentListener` path.
   */
  listenerRuntime?: ListenerRuntime;
  revisions?: WorkflowRevisionService;
}

export class TriggerRuntime {
  constructor(private readonly deps: TriggerRuntimeDeps) {}

  /** Rehydrate every active trigger from DB on boot. */
  async hydrate(): Promise<void> {
    const active = this.deps.registry.loadActiveFromDb();
    for (const t of active) {
      try {
        await this.activate(t);
      } catch (err) {
        this.deps.logger.error('trigger.hydrate_failed', { triggerId: t.triggerId, err: (err as Error).message });
      }
    }
  }

  /** Activate a trigger row. Idempotent — re-activating replaces the cleanup. */
  async activate(t: ActiveTrigger): Promise<void> {
    await this.deps.registry.deactivate(t.triggerId).catch(() => {});
    switch (t.triggerType) {
      case 'cron':
        await this.#activateCron(t);
        return;
      case 'webhook':
        // Webhooks are stateless — they just need the row to be marked active
        // and the secret to be present. WebhookRouter handles dispatch.
        this.deps.registry.activate(t, async () => {});
        return;
      case 'persistent_listener':
        await this.#activatePersistentListener(t);
        return;
      case 'manual':
        return; // no runtime resources
    }
  }

  async deactivate(triggerId: string): Promise<void> {
    await this.deps.registry.deactivate(triggerId);
  }

  async #activateCron(t: ActiveTrigger): Promise<void> {
    const cfg = t.config as {
      expression?: string;
      timezone?: string;
      scheduleRules?: Array<{ expression?: string; timezone?: string; label?: string }>;
    };
    const defaultTz = cfg.timezone && cfg.timezone.trim() ? cfg.timezone.trim() : 'UTC';
    // n8n-inspired multi-rule scheduling: each rule becomes its own cron job. The
    // single-expression form remains supported as the one-rule case.
    const rules = cfg.scheduleRules && cfg.scheduleRules.length > 0
      ? cfg.scheduleRules
          .filter((r) => r?.expression?.trim())
          .map((r) => ({ expression: r.expression!.trim(), timezone: (r.timezone?.trim() || defaultTz), label: r.label }))
      : cfg.expression
        ? [{ expression: String(cfg.expression).trim(), timezone: defaultTz, label: undefined as string | undefined }]
        : [];
    if (rules.length === 0) throw new AgentisError('TRIGGER_INVALID_CONFIG', 'cron trigger requires `expression` or `scheduleRules`');
    const loaded = await loadCron();
    if (loaded.kind === 'unavailable') {
      this.deps.logger.warn('trigger.cron_unavailable', { reason: loaded.reason });
      throw new AgentisError('TRIGGER_INVALID_CONFIG', `node-cron not installed: ${loaded.reason}`);
    }
    const { cron } = loaded;
    for (const rule of rules) {
      if (!cron.validate(rule.expression)) {
        throw new AgentisError('TRIGGER_INVALID_CONFIG', `invalid cron expression: ${rule.expression}`);
      }
    }
    // The cron expression is authored in a fixed zone (UTC by convention, or the
    // explicit `config.timezone`). Pass it to node-cron so the schedule fires at
    // the intended wall-clock time regardless of the SERVER's local timezone —
    // otherwise a `5 18 * * *` ("18:05 UTC") would fire at 18:05 server-local.
    const jobs = rules.map((rule) =>
      cron.schedule(rule.expression, () => {
        void this.fire({ trigger: t, payload: { firedAt: new Date().toISOString(), rule: rule.label ?? rule.expression } }).catch((err) =>
          this.deps.logger.error('trigger.cron_fire_failed', { triggerId: t.triggerId, err: (err as Error).message }),
        );
      }, { timezone: rule.timezone }),
    );
    for (const job of jobs) job.start();
    this.deps.registry.activate(t, async () => { for (const job of jobs) job.stop(); });
  }

  /** Expose the listener runtime so /v1/listeners routes can read health, pause, fire-now. */
  get listeners(): ListenerRuntime | undefined {
    return this.deps.listenerRuntime;
  }

  async #activatePersistentListener(t: ActiveTrigger): Promise<void> {
    // New path: a ListenerConfig (declares a `source`) routes to ListenerRuntime.
    if (this.deps.listenerRuntime && ListenerRuntime.handles(t.config)) {
      const lr = this.deps.listenerRuntime;
      await lr.activate(t);
      this.deps.registry.activate(t, async () => {
        await lr.deactivate(t.triggerId);
      });
      return;
    }
    // Legacy path: adapter-coupled listener ({ agentId }).
    const agentId = String((t.config as { agentId?: string }).agentId ?? '');
    if (!agentId) throw new AgentisError('TRIGGER_INVALID_CONFIG', 'persistent_listener requires agentId');
    const reg = this.deps.adapters.get(agentId);
    if (!reg || !reg.adapter.createPersistentListener) {
      this.deps.logger.warn('trigger.listener_unavailable', { triggerId: t.triggerId, agentId });
      this.deps.registry.activate(t, async () => {});
      return;
    }
    const handle = await reg.adapter.createPersistentListener({
      triggerId: t.triggerId,
      workflowId: t.workflowId,
      triggerType: 'persistent_listener',
      config: t.config,
    });
    this.deps.registry.activate(t, async () => {
      try {
        await handle.close();
      } catch {
        // ignore
      }
    });
  }

  /** Common fire path → create run + start engine. */
  async fire(args: { trigger: ActiveTrigger; payload: Record<string, unknown> }): Promise<{ runId: string }> {
    const result = await this.startWorkflowRun({
      workflowId: args.trigger.workflowId,
      workspaceId: args.trigger.workspaceId,
      ambientId: args.trigger.ambientId,
      userId: args.trigger.userId,
      triggerId: args.trigger.triggerId,
      inputs: args.payload,
    });
    this.deps.db
      .update(schema.triggers)
      .set({ lastFiredAt: new Date().toISOString() })
      .where(eq(schema.triggers.id, args.trigger.triggerId))
      .run();
    this.deps.bus.publish(
      REALTIME_ROOMS.workspace(args.trigger.workspaceId),
      REALTIME_EVENTS.WORKFLOW_UPDATED,
      { workflowId: args.trigger.workflowId, reason: 'deployment' },
    );
    return result;
  }

  /**
   * Start a workflow run directly. Used by triggers, API callers, and
   * the webhook receiver — every entry point converges here so run creation
   * stays uniform.
   */
  async startWorkflowRun(args: {
    workflowId: string;
    workspaceId: string;
    ambientId: string | null;
    userId: string;
    triggerId?: string | null;
    inputs: Record<string, unknown>;
    /**
     * Dispatch mode. `auto` (default) queues the run when the graph has
     * long-running / human-gated nodes; `async` always queues; `inline`
     * never queues.
     */
    dispatchMode?: 'auto' | 'inline' | 'async';
  }): Promise<{ runId: string; queued: boolean }> {
    const workflow = this.deps.db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.id, args.workflowId))
      .get();
    if (!workflow) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow ${args.workflowId} missing`);
    const activeRevision = this.deps.revisions?.active(args.workspaceId, workflow.id);
    const activeGraph = (activeRevision?.graph ?? workflow.graph) as WorkflowGraph;
    const workflowRevisionId = activeRevision?.revision.id ?? workflow.activeRevisionId ?? null;
    const normalized = normalizeWorkflowGraph(this.deps.db, args.workspaceId, activeGraph);
    const graph = normalized.graph;
    if (normalized.repairs.length > 0) {
      const existingCandidate = this.deps.revisions?.candidate(args.workspaceId, workflow.id);
      const candidate = this.deps.revisions?.createCandidate({
        workspaceId: args.workspaceId,
        workflowId: workflow.id,
        graph,
        baseRevisionId: workflowRevisionId,
        source: 'normalization',
        actor: { type: 'system', id: 'trigger-runtime' },
        reason: `Unattended trigger detected ${normalized.repairs.length} runtime normalization repair(s)`,
        allowBranch: true,
        setAsHead: !existingCandidate,
      });
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        'The active workflow requires normalization. The trigger was not fired; verify and promote the generated candidate first.',
        {
          httpStatus: 409,
          details: {
            code: 'TRIGGER_BLOCKED_ON_NORMALIZATION',
            candidateRevisionId: candidate?.revision.id ?? null,
            repairs: normalized.repairs,
          },
        },
      );
    }
    const runId = randomUUID();
    const initialState = buildInitialRunState({
      runId,
      workflowId: workflow.id,
      graph,
      inputs: args.inputs,
    });
    this.deps.db
      .insert(schema.workflowRuns)
      .values({
        id: runId,
        workspaceId: args.workspaceId,
        ambientId: args.ambientId,
        workflowId: workflow.id,
        userId: args.userId,
        status: 'CREATED',
        runState: initialState as unknown as object,
        graphSnapshot: graph,
        workflowRevisionId,
        replanCount: 0,
        triggerId: args.triggerId ?? null,
        parentRunId: null,
      })
      .run();
    const payload = {
      workspaceId: args.workspaceId,
      ambientId: args.ambientId,
      workflowId: workflow.id,
      userId: args.userId,
      triggerId: args.triggerId ?? null,
      inputs: args.inputs,
      initialState,
      graph,
      workflowRevisionId,
    };
    // Durable dispatch: long-running / human-gated graphs go through the
    // queue so they survive a server restart. Everything else runs inline.
    if (this.deps.jobQueue && shouldQueueWorkflowRun(graph, args.dispatchMode ?? 'auto')) {
      await this.deps.jobQueue.enqueueWorkflowRun(payload);
      return { runId, queued: true };
    }
    await this.deps.engine.startRun(payload);
    return { runId, queued: false };
  }

  // ─────────────────────────────────────────────
  // Webhook helpers
  // ─────────────────────────────────────────────

  /**
   * Verify HMAC + timestamp + idempotency key for a webhook payload, then fire.
   * Throws AgentisError on validation failure (route handler converts to HTTP).
   */
  async fireWebhook(args: {
    triggerId: string;
    rawBody: string;
    signature: string;
    timestampHeader: string;
    deliveryId: string;
  }): Promise<{ runId: string; idempotent: boolean }> {
    const trigger = this.deps.db.select().from(schema.triggers).where(eq(schema.triggers.id, args.triggerId)).get();
    if (!trigger) throw new AgentisError('RESOURCE_NOT_FOUND', `trigger ${args.triggerId} not found`);
    if (trigger.triggerType !== 'webhook') throw new AgentisError('TRIGGER_INVALID_CONFIG', 'not a webhook trigger');
    if (trigger.status !== 'active') throw new AgentisError('TRIGGER_NOT_ACTIVE', 'trigger is not active');
    if (!trigger.webhookSecret) throw new AgentisError('TRIGGER_INVALID_CONFIG', 'trigger missing webhookSecret');

    const ts = Number(args.timestampHeader);
    if (!ts) throw new AgentisError('WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE', 'missing/invalid timestamp header');
    const skew = Math.abs(Date.now() - ts);
    if (skew > CONSTANTS.WEBHOOK_TIMESTAMP_TOLERANCE_MS) {
      throw new AgentisError('WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE', `timestamp skew ${skew}ms exceeds tolerance`);
    }
    const expected = createHmac('sha256', trigger.webhookSecret).update(`${ts}.${args.rawBody}`).digest('hex');
    if (expected.length !== args.signature.length) {
      throw new AgentisError('WEBHOOK_SIGNATURE_INVALID', 'signature length mismatch');
    }
    let ok = false;
    try {
      ok = timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(args.signature, 'hex'));
    } catch {
      ok = false;
    }
    if (!ok) throw new AgentisError('WEBHOOK_SIGNATURE_INVALID', 'invalid HMAC');

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(args.rawBody) as Record<string, unknown>;
    } catch {
      payload = { raw: args.rawBody };
    }
    return this.#deliverWebhook(trigger, args.deliveryId, payload);
  }

  /**
   * Native SaaS webhook ingress (GitHub / Stripe / Slack / Linear / …). Unlike
   * {@link fireWebhook} (Agentis HMAC), this verifies the PROVIDER's own
   * signature scheme using the trigger's stored `webhookSecret`, then fires the
   * workflow through the same idempotency + dispatch path. The provider is named
   * by the trigger config (`connector`/`provider`). The full set of verifiers
   * (github/slack/linear/stripe/typeform/gmail/shopify/hubspot/intercom/zendesk/
   * twilio/discord/pagerduty/sendgrid) lived behind this seam, unreachable, until
   * now — this is the poll-only → real-webhook-receiver switch.
   */
  async fireConnectorWebhook(args: {
    triggerId: string;
    rawBody: string;
    headers: Record<string, string | undefined>;
  }): Promise<{ runId: string; idempotent: boolean; eventType: string }> {
    const trigger = this.deps.db.select().from(schema.triggers).where(eq(schema.triggers.id, args.triggerId)).get();
    if (!trigger) throw new AgentisError('RESOURCE_NOT_FOUND', `trigger ${args.triggerId} not found`);
    if (trigger.triggerType !== 'webhook') throw new AgentisError('TRIGGER_INVALID_CONFIG', 'not a webhook trigger');
    if (trigger.status !== 'active') throw new AgentisError('TRIGGER_NOT_ACTIVE', 'trigger is not active');
    if (!trigger.webhookSecret) throw new AgentisError('TRIGGER_INVALID_CONFIG', 'trigger missing webhookSecret');
    const connector = connectorFromConfig((trigger.config ?? {}) as Record<string, unknown>);
    if (connector === 'generic') {
      throw new AgentisError('TRIGGER_INVALID_CONFIG', 'no SaaS connector configured on this trigger; use the Agentis HMAC endpoint instead');
    }
    // Throws WEBHOOK_SIGNATURE_INVALID / VALIDATION_FAILED on a bad/forged delivery.
    const verified = verifyConnectorWebhook({ connector, rawBody: args.rawBody, headers: args.headers, secret: trigger.webhookSecret });
    const out = await this.#deliverWebhook(trigger, verified.deliveryId, { ...verified.payload, eventType: verified.eventType });
    return { ...out, eventType: verified.eventType };
  }

  /**
   * Shared idempotency-reserve → fire → finalize for both webhook ingress paths.
   * A duplicate (triggerId, deliveryId) is a no-op returning the prior run.
   */
  async #deliverWebhook(
    trigger: typeof schema.triggers.$inferSelect,
    deliveryId: string,
    payload: Record<string, unknown>,
  ): Promise<{ runId: string; idempotent: boolean }> {
    const findDelivery = () => this.deps.db
      .select()
      .from(schema.webhookDeliveries)
      .where(and(
        eq(schema.webhookDeliveries.triggerId, trigger.id),
        eq(schema.webhookDeliveries.deliveryId, deliveryId),
      ))
      .get();
    const existing = findDelivery();
    if (existing) {
      return { runId: existing.responseRunId ?? '', idempotent: true };
    }

    const reservationId = randomUUID();
    try {
      this.deps.db
        .insert(schema.webhookDeliveries)
        .values({
          id: reservationId,
          triggerId: trigger.id,
          workspaceId: trigger.workspaceId,
          deliveryId,
          status: 'processing',
          responseRunId: null,
        })
        .run();
    } catch (err) {
      const raced = findDelivery();
      if (raced) return { runId: raced.responseRunId ?? '', idempotent: true };
      throw err;
    }

    const t: ActiveTrigger = {
      triggerId: trigger.id,
      workflowId: trigger.workflowId,
      workspaceId: trigger.workspaceId,
      ambientId: trigger.ambientId,
      userId: trigger.userId,
      triggerType: 'webhook',
      config: (trigger.config ?? {}) as Record<string, unknown>,
    };
    try {
      const result = await this.fire({ trigger: t, payload });
      this.deps.db
        .update(schema.webhookDeliveries)
        .set({ status: 'accepted', responseRunId: result.runId })
        .where(eq(schema.webhookDeliveries.id, reservationId))
        .run();
      return { runId: result.runId, idempotent: false };
    } catch (err) {
      this.deps.db.delete(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, reservationId)).run();
      throw err;
    }
  }
}
