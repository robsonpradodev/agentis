/**
 * Self-heal controller (extracted from WorkflowEngine - Phase A cont.).
 *
 * Owns the workflow self-healing subsystem: runtime rebind, orchestrator replan,
 * repair-plan lifecycle, approval gating, and honest escalation. The engine
 * delegates node-failure recovery here; the controller reaches back into engine
 * state only through the typed SelfHealHost facade.
 */
import { AgentToolLoop, type StructuredLlm } from '../../services/agent/agentToolLoop.js';
import { ChatSessionExecutor } from '../../services/chat/chatSessionExecutor.js';
import { parseGeneric } from '../../services/evaluatorRuntime.js';
import { REPEAT_FAILURE_THRESHOLD, type FeynmanTrigger } from '../../services/feynmanReflection.js';
import { getSelfHealConfig, type SelfHealConfig } from '../../services/selfHealSettings.js';
import { AdapterStructuredCompleter, FallbackStructuredCompleter, type StructuredCompleter } from '../../services/structuredCompleter.js';
import { selfHealGuardDecision } from '../../services/workflow/workflowBlueprint.js';
import { graphContentHash, readBuildLoop } from '../../services/workflow/workflowCompass.js';
import { decideRecoveryPolicy, recoveryFailureFingerprint, recoveryTierForPlan, repairPlanFingerprint } from '../../services/workflow/workflowRecoveryPolicy.js';
import { type DeepPlanArgs, type DeepPlanResult, type IntentAnchor, type RepairResourceContext } from '../../services/workflow/workflowSelfHeal.js';
import { classifyWorkflowFailure, workflowFailureFingerprint } from '../../services/workflow/workflowFailureClassification.js';
import { agentSatisfiesRequirements, REALTIME_EVENTS, REALTIME_ROOMS, type AgentRequirements, type AgentRole, type AgentTaskNodeConfig, type AgentTool, type ChatDelta, type ReadyQueueItem, type ToolDefinition, type WorkflowGraph, type WorkflowGraphPatch, type WorkflowNode, type WorkflowRecoveryMode, type WorkflowSelfHealIncident } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { RunningContext, PendingApproval, EngineDeps, SelfHealEngineResult } from '../WorkflowEngine.js';
import { selfHealAttemptCount, recordSelfHealAttempt, isSelfHealableNode, isRuntimeBindingFailure, capabilityGapReason, configGapReason, declaredOutputKeys, graphDiffPatch, stringValue, toolInputSchemaToChatParameters } from './selfHealHelpers.js';

// A live-run repair returns a candidate graph to the engine. Letting the repair
// agent also mutate, execute, test, harden, or replay workflows creates a second
// competing control loop that repeats paid work and can race the engine's own
// validate -> apply -> resume -> verify ladder.
const SELF_HEAL_REDUNDANT_CONTROL_TOOLS = new Set([
  'agentis.workflow.patch',
  'agentis.workflow.graph.replace',
  'agentis.workflow.graph.patch',
  'agentis.workflow.graph.rollback',
  'agentis.run.graph.evolve',
  'agentis.workflow.cancel',
  'agentis.workflow.delete',
  'agentis.workflow.dry_run',
  'agentis.workflow.test',
  'agentis.workflow.harden',
  'agentis.workflow.deliver',
  'agentis.workflow.run',
  'agentis.ephemeral.run',
  'agentis.run.cancel',
  'agentis.run.await',
  'agentis.run.replay',
  'agentis.approval.resolve',
  'agentis.channel.send',
]);

export function isSelfHealControlToolAllowed(toolId: string): boolean {
  return !SELF_HEAL_REDUNDANT_CONTROL_TOOLS.has(toolId);
}

function selfHealMaxToolCalls(): number {
  const configured = Number(process.env.AGENTIS_SELF_HEAL_MAX_TOOL_CALLS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 48;
}

function selfHealTracePhase(
  status: WorkflowSelfHealIncident['status'],
): NonNullable<WorkflowSelfHealIncident['trace']>[number]['phase'] {
  switch (status) {
    case 'DIAGNOSING':
      return 'diagnose';
    case 'PLANNING':
      return 'inspect';
    case 'RETRYING':
    case 'APPLYING':
    case 'AWAITING_APPROVAL':
      return 'repair';
    case 'APPLIED':
      return 'verify';
    case 'ROLLED_BACK':
      return 'resume';
    case 'BLOCKED':
    case 'EXHAUSTED':
      return 'blocked';
  }
}

function selfHealTraceSummary(
  status: WorkflowSelfHealIncident['status'],
  outcome?: WorkflowSelfHealIncident['outcome'],
): string {
  if (outcome) {
    const labels: Record<NonNullable<WorkflowSelfHealIncident['outcome']>, string> = {
      output_fixed: 'Invalid output was repaired and verified',
      graph_patch_applied: 'Workflow repair was applied and verified',
      graph_patch_awaiting_approval: 'A workflow patch is ready for operator approval',
      retrying: 'Execution is retrying with the repaired context',
      retry_awaiting_approval: 'A repaired retry is ready for operator approval',
      runtime_rebound: 'The assigned runtime was reconnected',
      runtime_rerouted: 'Execution was safely routed to another compatible runtime',
      blocked: 'Repair stopped at an operator-safe boundary',
      exhausted: 'Available repair strategies were exhausted',
      rolled_back: 'Unsafe or ineffective repair was rolled back',
    };
    return labels[outcome];
  }
  const labels: Record<WorkflowSelfHealIncident['status'], string> = {
    DIAGNOSING: 'Diagnosing the failure and collecting runtime evidence',
    PLANNING: 'Selecting the smallest safe repair',
    RETRYING: 'Retrying with the repaired execution context',
    AWAITING_APPROVAL: 'Repair requires operator approval',
    APPLYING: 'Applying the selected repair',
    APPLIED: 'Repair applied; verification is running',
    BLOCKED: 'Repair is blocked and needs operator action',
    EXHAUSTED: 'No safe automated repair remains',
    ROLLED_BACK: 'Repair was rolled back to the last checkpoint',
  };
  return labels[status];
}

export interface SelfHealHost {
  readonly deps: EngineDeps;
  readonly debugRuns: Set<string>;
  agentConfiguredModel(agentId: string): string | null;
  agentHasConnectedRuntime(agentId: string): boolean;
  agentRole(agentId: string | null | undefined): string | undefined;
  audit(ctx: RunningContext, entry: {
    nodeId?: string;
    action: string;
    actorType: 'agent' | 'user' | 'system' | 'scheduler';
    actorId: string;
    inputSummary?: string | null;
    outputSummary?: string | null;
    costCents?: number | null;
    tokensIn?: number | null;
    tokensOut?: number | null;
  }): void;
  dispatchAgentTask(
    ctx: RunningContext,
    node: WorkflowNode,
    config: AgentTaskNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<void>;
  dispatchNode(
    ctx: RunningContext,
    node: WorkflowNode,
    item: ReadyQueueItem,
  ): Promise<void>;
  emitWorkStep(
    ctx: RunningContext,
    node: WorkflowNode,
    phase: 'start' | 'complete' | 'fail' | 'thinking',
    detail?: string,
  ): void;
  failNode(ctx: RunningContext, nodeId: string, error: string): Promise<void>;
  findAgentByRole(workspaceId: string, role: string): string | null;
  pendingApprovals(ctx: RunningContext): Map<string, PendingApproval>;
  persistRun(ctx: RunningContext): Promise<void>;
  resolveConnectedFallbackAgent(
    workspaceId: string,
    capabilityTags: string[],
    requires?: AgentRequirements,
    preferredRole?: AgentRole,
  ): string | null;
  tick(ctx: RunningContext): Promise<void>;
  applyGraphPatch(args: {
    runId: string;
    patch: WorkflowGraphPatch;
  }): Promise<{ newRevision: number }>;
  notifyAgentActivity(args: {
    runId: string;
    agentId?: string;
    taskId?: string;
    kind: 'thinking' | 'text' | 'tool_call' | 'tool_result';
    text?: string;
    tool?: string;
    toolInput?: unknown;
    toolResult?: unknown;
    activityId?: string;
    activityPhase?: string;
    activityStatus?: 'running' | 'success' | 'error';
    activityTitle?: string;
    transport?: string;
    attempt?: number;
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
  }): void;
}

export class SelfHealController {
  constructor(private readonly host: SelfHealHost) {}

  /**
   * W5.0 / W7 — autonomous, intent-preserving self-healing for a failed agent
   * node. Tries to recover the declared output from the agent's OWN output
   * (W5.0); otherwise diagnoses and (when certified + validated) applies a
   * STRUCTURAL graph repair — autonomously or via operator approval per the
   * workspace setting. Never fabricates; escalates on uncertainty.
   *
   *   output_fixed       → caller completes the node with `output`.
   *   structural_applied → patch applied + node re-dispatched; caller returns.
   *   awaiting_approval  → approval created + node WAITING; caller returns.
   *   none               → no safe heal; caller fails the node honestly.
   */
  async runSelfHeal(
    ctx: RunningContext,
    node: WorkflowNode,
    rawOutput: Record<string, unknown>,
    error: string,
  ): Promise<SelfHealEngineResult> {
    // P1.2: a debug/test run never self-heals — surface the raw failure.
    if (this.host.debugRuns.has(ctx.runId)) return { kind: 'none' };
    if (!this.host.deps.selfHeal) return { kind: 'none' };
    if (!isSelfHealableNode(node)) return { kind: 'none' };
    let cfg;
    try { cfg = getSelfHealConfig(this.host.deps.db, ctx.workspaceId); } catch { return { kind: 'none' }; }
    if (!cfg.enabled) return { kind: 'none' };
    const classification = classifyWorkflowFailure(error);
    const revisionKey = ctx.workflowRevisionId ?? graphContentHash(ctx.graph);
    const failureFingerprint = workflowFailureFingerprint({
      classification,
      revisionKey,
      node,
      error,
    });
    const runtimeRebindCandidate = node.config.kind === 'agent_task' && isRuntimeBindingFailure(error);
    if (!classification.graphRepairEligible && !runtimeRebindCandidate) {
      this.host.deps.logger.info('engine.self_heal.ineligible_failure', {
        runId: ctx.runId,
        nodeId: node.id,
        category: classification.category,
        code: classification.canonicalCode,
      });
      return {
        kind: 'none',
        reason: `${classification.reason}${classification.operatorAction ? ` ${classification.operatorAction}` : ''}`,
        diagnosis: `${classification.category}:${classification.canonicalCode}`,
      };
    }
    const attempts = selfHealAttemptCount(ctx, node.id);
    if (attempts >= cfg.maxRepairPlans) {
      return this.#blockSelfHeal(ctx, node, {
        mode: cfg.mode,
        attempt: attempts,
        maxAttempts: cfg.maxRepairPlans,
        error,
        reason: `Self-healing stopped after ${attempts}/${cfg.maxRepairPlans} distinct repair plans for this failure lineage.`,
        diagnosis: 'Attempt limit reached before a certified repair could be applied.',
        exhausted: true,
      });
    }
    this.recordSelfHealIncident(ctx, node, {
      status: 'DIAGNOSING',
      mode: cfg.mode,
      attempt: attempts + 1,
      maxAttempts: cfg.maxRepairPlans,
      error,
      failureFingerprint,
      failureClass: classification.category,
      repairScope: 'run_local',
      baseRevisionId: ctx.workflowRevisionId ?? undefined,
    });
    this.host.emitWorkStep(ctx, node, 'thinking', 'Checking deterministic recovery options');
    await this.host.persistRun(ctx).catch(() => {});

    // ── STRATEGY 1 (deterministic, zero-token): runtime repair. The most common
    //    long-run failure is an agent whose runtime dropped or was never bound.
    //    Rebind it, or reroute the step to the configured healer (default: the
    //    orchestrator). Only when neither is possible do we spend tokens on LLM
    //    diagnosis / a structural patch.
    if (node.config.kind === 'agent_task' && isRuntimeBindingFailure(error)) {
      const runtimeRepair = await this.#repairNodeRuntime(ctx, node, error, cfg);
      if (runtimeRepair.kind !== 'none') return runtimeRepair;
      if (!classification.graphRepairEligible) {
        return {
          kind: 'none',
          reason: `${classification.reason}${classification.operatorAction ? ` ${classification.operatorAction}` : ''}`,
          diagnosis: `${classification.category}:${classification.canonicalCode}`,
        };
      }
    }

    // ── CAPABILITY-AWARE (E4): a missing capability/provider/tool/binary is not a
    //    structural fault — swapping the agent or rewriting the graph cannot add it.
    //    Escalate honestly with the capability to enable instead of burning LLM
    //    replans that pointlessly reroute the agent (the sonnet→hermes loop).
    const capGap = capabilityGapReason(error);
    if (capGap) {
      this.host.emitWorkStep(ctx, node, 'fail', `Missing capability — ${capGap}. Enable it rather than swapping the agent.`);
      this.host.audit(ctx, { nodeId: node.id, action: 'self_heal.capability_gap', actorType: 'system', actorId: 'engine', outputSummary: capGap });
      this.host.deps.logger.info('engine.self_heal.capability_gap', { runId: ctx.runId, nodeId: node.id, reason: capGap });
      return {
        kind: 'none',
        reason: `This step needs a capability that isn't available — ${capGap}. Enable it (or bind a runtime/agent that provides it); rewriting or swapping the agent cannot add a missing capability`,
        diagnosis: capGap,
      };
    }

    // ── CONFIG-AWARE: a missing env var / working directory / credential is a
    //    configuration gap, not a graph fault — no graph rewrite can set it. The
    //    We escalate with the exact remedy the failing step already named.
    const cfgGap = configGapReason(error);
    if (cfgGap) {
      this.host.emitWorkStep(ctx, node, 'fail', `Configuration gap — ${cfgGap}`);
      this.host.audit(ctx, { nodeId: node.id, action: 'self_heal.config_gap', actorType: 'system', actorId: 'engine', outputSummary: cfgGap });
      this.host.deps.logger.info('engine.self_heal.config_gap', { runId: ctx.runId, nodeId: node.id, reason: cfgGap });
      return {
        kind: 'none',
        reason:
          `This step failed on missing CONFIGURATION, not a broken graph — ${cfgGap}. `
          + `No graph edit or agent swap can supply it: set the required environment/config on the server, `
          + `or add it to this node's config (e.g. workingDir on an extension_task), then re-run. `
          + `Self-healing left the workflow untouched — restructuring it would only break a working graph over a config gap.`,
        diagnosis: `config gap: ${cfgGap}`,
      };
    }

    // ── BRAIN-BLUEPRINT-10X — the guard law, consulted BEFORE any model-driven
    //    planning. (1) A runtime-class failure (bad model, quota, auth, spawn,
    //    timeout) never gets graph surgery — no graph edit can fix it. (2) A graph
    //    whose current hash is BLESSED (blueprint/hardened stamp) is never
    //    autonomously restructured: one bad run must not vandalize a
    //    production-proven workflow. Deterministic runtime REBINDING (strategy 1
    //    above) already ran — this only blocks the structural path.
    try {
      let blueprintHash: string | null = null;
      let hardenedHash: string | null = null;
      if (ctx.workflowId) {
        const wfRow = this.host.deps.db
          .select({ settings: schema.workflows.settings })
          .from(schema.workflows)
          .where(eq(schema.workflows.id, ctx.workflowId))
          .get();
        const loop = readBuildLoop(wfRow?.settings);
        blueprintHash = loop.blueprint?.graphHash ?? null;
        hardenedHash = loop.hardened?.graphHash ?? null;
      }
      const guard = selfHealGuardDecision({
        error,
        currentGraphHash: graphContentHash(ctx.graph),
        blueprintHash,
        hardenedHash,
      });
      if (!guard.allow) {
        this.host.emitWorkStep(ctx, node, 'fail', guard.reason);
        this.host.audit(ctx, { nodeId: node.id, action: `self_heal.guard.${guard.class}`, actorType: 'system', actorId: 'engine', outputSummary: guard.reason.slice(0, 300) });
        this.host.deps.logger.info('engine.self_heal.guard_blocked', { runId: ctx.runId, nodeId: node.id, class: guard.class });
        return {
          kind: 'none',
          reason: guard.reason,
          diagnosis: guard.class === 'runtime' ? 'runtime-class failure — the graph was not changed' : 'blueprint-protected graph — autonomous restructure blocked',
        };
      }
    } catch { /* the guard is best-effort — a read failure must never block healing */ }

    if (this.host.deps.workflowExperience && ctx.workflowRevisionId) {
      const reservation = this.host.deps.workflowExperience.reserveRepairAttempt({
        workspaceId: ctx.workspaceId,
        workflowId: ctx.workflowId,
        baseRevisionId: ctx.workflowRevisionId,
        failureFingerprint,
        runId: ctx.runId,
        nodeId: node.id,
        error,
      });
      if (!reservation.allowed) {
        this.recordSelfHealIncident(ctx, node, {
          status: 'BLOCKED',
          mode: cfg.mode,
          attempt: attempts,
          maxAttempts: cfg.maxRepairPlans,
          error,
          failureFingerprint,
          failureClass: classification.category,
          repairScope: 'run_local',
          baseRevisionId: ctx.workflowRevisionId,
          recurrent: true,
          outcome: 'blocked',
          reason: 'A prior repair attempt already owns this failure fingerprint and base revision.',
        });
        return {
          kind: 'none',
          reason:
            'This exact failure fingerprint already has a repair attempt for the same active revision. '
            + 'Agentis stopped before repeating the mutation; inspect the prior candidate and its proof result.',
          diagnosis: `recurrent:${classification.category}:${classification.canonicalCode}`,
        };
      }
    }

    const prompt = (node.config as { prompt?: string }).prompt ?? '';
    const completer = this.#resolveSelfHealCompleter(ctx, node, prompt, error, cfg);
    const intent: IntentAnchor = {
      goal: node.title || prompt || 'workflow node',
      nodeObjective: prompt || node.title || '',
      declaredOutputKeys: declaredOutputKeys(node),
      inputContract: ctx.graph.inputContract,
    };
    this.recordSelfHealIncident(ctx, node, {
      status: 'PLANNING',
      mode: cfg.mode,
      attempt: attempts + 1,
      maxAttempts: cfg.maxRepairPlans,
      error,
      failureFingerprint,
      failureClass: classification.category,
      repairScope: 'run_local',
      baseRevisionId: ctx.workflowRevisionId ?? undefined,
      diagnosis: 'Orchestrator is repairing the workflow with the chat tool loop.',
    });
    await this.host.persistRun(ctx).catch(() => {});
    const repairAbort = new AbortController();
    const abortFromRun = () => repairAbort.abort(ctx.abortController?.signal.reason);
    if (ctx.abortController?.signal.aborted) abortFromRun();
    else ctx.abortController?.signal.addEventListener('abort', abortFromRun, { once: true });
    try {
      const res = await this.host.deps.selfHeal.heal({
        workspaceId: ctx.workspaceId,
        graph: ctx.graph,
        node,
        error,
        rawOutput,
        upstreamOutputs: this.#upstreamOutputs(ctx, node.id),
        intent,
        completer,
        tier: recoveryTierForPlan(this.#repairPlansFor(ctx, node.id).length),
        immutableNodeIds: this.#immutableRecoveryNodeIds(ctx, node.id),
        resources: this.#availableRepairResources(ctx),
        // FULL POWER: the orchestrator runs through the chat executor first and
        // returns a candidate graph that still passes finalize/validate/certify.
        deepPlan: (args) => this.#orchestratorReplan(ctx, node, args, repairAbort.signal, (reason) => repairAbort.abort(reason)),
        signal: repairAbort.signal,
        onProgress: (progress) => {
          const detail = progress.phase === 'stalled'
            ? 'Repair runtime stalled; falling back only to the configured route.'
            : progress.phase === 'started'
              ? 'Asking the selected repair runtime for a grounded plan'
              : progress.phase === 'thinking'
                ? 'Repair runtime is reasoning'
                : 'Repair runtime is responding';
          this.host.emitWorkStep(ctx, node, 'thinking', detail);
        },
      });
      const attempt = recordSelfHealAttempt(ctx, node.id);
      await this.host.persistRun(ctx).catch((persistErr) => {
        this.host.deps.logger.warn('engine.self_heal.attempt_persist_failed', {
          runId: ctx.runId,
          nodeId: node.id,
          error: (persistErr as Error).message,
        });
      });

      if (res.outcome === 'output_fixed') {
        this.recordSelfHealIncident(ctx, node, {
          status: 'APPLIED',
          mode: cfg.mode,
          attempt,
          maxAttempts: cfg.maxRepairPlans,
          diagnosis: res.diagnosis,
          outcome: 'output_fixed',
        });
        this.host.deps.logger.info('engine.self_heal.output_fixed', { runId: ctx.runId, nodeId: node.id, attempt });
        this.host.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_RETRY_SCHEDULED, {
          runId: ctx.runId,
          nodeId: node.id,
          reason: 'self_heal_output_recovered',
          detail: res.diagnosis,
          attempt,
        });
        await this.host.deps.ledger.append({
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId,
          runId: ctx.runId,
          eventType: 'self_heal.output_fixed',
          nodeId: node.id,
          payload: { diagnosis: res.diagnosis, attempt },
        }).catch(() => {});
        this.host.audit(ctx, { nodeId: node.id, action: 'self_heal.output_fixed', actorType: 'system', actorId: 'engine', outputSummary: res.diagnosis });
        return { kind: 'output_fixed', output: res.output };
      }

      // Structural repair flows for ANY re-dispatchable node (agent_task,
      // evaluator, transform, integration, …): #applyHealAndRedispatch /
      // #proposeHealForApproval reset the node and re-run it through #dispatchNode,
      // which handles every node kind uniformly.
      if (res.outcome === 'graph_repair') {
        const patch = this.#buildHealPatch(ctx, res.patchedGraph, res.diagnosis);
        // Patch ids and graph revisions change on every apply; they must not
        // defeat duplicate detection for the same semantic repair.
        const fingerprint = repairPlanFingerprint({
          tier: res.tier,
          resumeNodeId: res.resumeNodeId,
          addNodes: patch.addNodes,
          updateNodes: patch.updateNodes,
          removeNodeIds: patch.removeNodeIds,
          addEdges: patch.addEdges,
          removeEdgeIds: patch.removeEdgeIds,
        });
        const priorPlans = this.#repairPlansFor(ctx, node.id);
        if (priorPlans.some((plan) => plan.fingerprint === fingerprint)) {
          return this.#blockSelfHeal(ctx, node, {
            mode: cfg.mode,
            attempt,
            maxAttempts: cfg.maxRepairPlans,
            error,
            reason: 'Self-healing rejected a duplicate repair plan instead of retrying the same change.',
            diagnosis: res.diagnosis,
          });
        }
        const runPlanCount = Object.values(ctx.state.selfHealIncidents ?? {}).reduce((total, incident) => total + (incident.plans?.length ?? 0), 0);
        if (runPlanCount >= Math.max(1, cfg.maxRepairPlans) * 2) {
          return this.#blockSelfHeal(ctx, node, {
            mode: cfg.mode,
            attempt,
            maxAttempts: cfg.maxRepairPlans,
            error,
            reason: 'Run-level self-healing circuit breaker reached; Agentis stopped instead of cycling between failures.',
            diagnosis: res.diagnosis,
          });
        }
        const policy = decideRecoveryPolicy(cfg.mode, ctx.graph, res.patchedGraph);
        const plan = this.#appendRepairPlan(ctx, node, {
          tier: res.tier,
          fingerprint,
          requiresApproval: policy.requiresApproval,
          patchId: patch.patchId,
          resumeNodeId: res.resumeNodeId,
          riskReason: policy.impact.reason,
          status: policy.requiresApproval ? 'awaiting_approval' : 'planned',
        });
        if (policy.requiresApproval) {
          const queued = await this.#proposeHealForApproval(ctx, node, patch, res.resumeNodeId, res.diagnosis, res.grounding, attempt, cfg.maxRepairPlans, policy.impact.reason, plan.id);
          return queued
            ? { kind: 'awaiting_approval' }
            : await this.#blockSelfHeal(ctx, node, {
                mode: cfg.mode,
                attempt,
                maxAttempts: cfg.maxRepairPlans,
                error,
                reason: 'Self-healing produced a guarded repair but could not create its confirmation request.',
                diagnosis: res.diagnosis,
              });
        }
        const applied = await this.applyHealAndRedispatch(ctx, res.resumeNodeId, patch, plan.id);
        if (!applied) {
          return this.#blockSelfHeal(ctx, node, {
            mode: cfg.mode,
            attempt,
            maxAttempts: cfg.maxRepairPlans,
            error,
            reason: 'Self-healing certified a graph repair, but the repair could not be applied.',
            diagnosis: res.diagnosis,
          });
        }
        this.completeRepairPlan(ctx, node, plan.id, 'applied');
        this.recordSelfHealIncident(ctx, node, {
          status: 'APPLIED', mode: cfg.mode, attempt, maxAttempts: cfg.maxRepairPlans,
          tier: res.tier, diagnosis: res.diagnosis, reason: res.grounding,
          riskReason: policy.impact.reason, resumeNodeId: res.resumeNodeId, outcome: 'graph_patch_applied',
        });
        await this.host.deps.ledger.append({
          workspaceId: ctx.workspaceId, ambientId: ctx.ambientId, runId: ctx.runId,
          eventType: 'self_heal.graph_patched', nodeId: node.id,
          payload: { diagnosis: res.diagnosis, grounding: res.grounding, tier: res.tier, fingerprint, impact: policy.impact.impact },
        }).catch(() => {});
        this.host.audit(ctx, { nodeId: node.id, action: 'self_heal.graph_patched', actorType: 'system', actorId: 'engine', outputSummary: res.diagnosis });
        return { kind: 'structural_applied' };
      }

      if (res.outcome === 'escalate') {
        this.host.deps.logger.info('engine.self_heal.escalate', { runId: ctx.runId, nodeId: node.id, reason: res.reason, attempt });
        await this.host.deps.ledger.append({
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId,
          runId: ctx.runId,
          eventType: 'self_heal.escalated',
          nodeId: node.id,
          payload: { reason: res.reason, diagnosis: res.diagnosis, attempt },
        }).catch(() => {});
        this.host.audit(ctx, { nodeId: node.id, action: 'self_heal.escalated', actorType: 'system', actorId: 'engine', outputSummary: `${res.reason}: ${res.diagnosis}` });
        // The orchestrator (the primary repair, inside heal()) already had its full
        // tool-loop turn. If it couldn't ground a safe fix, blindly re-running the
        // same step just burns minutes (the real failure log showed exactly that).
        // Stop honestly and offer the operator the "send to Agentis team" path.
        return this.#blockSelfHeal(ctx, node, {
          mode: cfg.mode,
          attempt,
          maxAttempts: cfg.maxRepairPlans,
          error,
          reason: res.reason,
          diagnosis: res.diagnosis,
        });
      }
      return { kind: 'none' };
    } catch (err) {
      if (repairAbort.signal.aborted) {
        this.host.deps.logger.info('engine.self_heal.aborted', { runId: ctx.runId, nodeId: node.id });
        return { kind: 'none' };
      }
      const message = (err as Error).message;
      this.host.deps.logger.warn('engine.self_heal.failed', { runId: ctx.runId, nodeId: node.id, error: message });
      await this.host.deps.ledger.append({
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId,
        runId: ctx.runId,
        eventType: 'self_heal.failed',
        nodeId: node.id,
        payload: { error: message },
      }).catch(() => {});
      return this.#blockSelfHeal(ctx, node, {
        mode: cfg.mode,
        attempt: selfHealAttemptCount(ctx, node.id),
        maxAttempts: cfg.maxRepairPlans,
        error,
        reason: `Self-healing failed before it could produce a certified repair: ${message}`,
      });
    } finally {
      ctx.abortController?.signal.removeEventListener('abort', abortFromRun);
    }
  }

  /**
   * STRATEGY 1 — deterministic runtime repair (zero LLM tokens). Handles the most
   * common long-run failure: a step whose agent has no connected runtime. First
   * rebind the step's own agent (no intent change at all, always safe → applied
   * regardless of mode). If that can't be done, reroute the step to the healer
   * (configured agent, else the orchestrator) — an intent-preserving change of
   * executor that honours the structural mode (autonomous applies, approve asks).
   * Returns `{ kind: 'none' }` when no runtime repair is possible, so the caller
   * falls through to LLM diagnosis / honest escalation.
   */
  async #repairNodeRuntime(
    ctx: RunningContext,
    node: WorkflowNode,
    error: string,
    cfg: SelfHealConfig,
  ): Promise<SelfHealEngineResult> {
    if (node.config.kind !== 'agent_task') return { kind: 'none' };
    const config = node.config;
    const pinnedId = config.agentId ?? null;

    // 1) Rebind the step's own agent runtime — the least invasive repair.
    if (pinnedId && this.#tryBindAgentRuntime(ctx, pinnedId, config.prompt, stringValue(config.modelOverride) ?? this.host.agentConfiguredModel(pinnedId))) {
      const attempt = recordSelfHealAttempt(ctx, node.id);
      await this.host.persistRun(ctx).catch(() => {});
      const diagnosis = `Reconnected the runtime for "${this.#agentDisplayName(pinnedId)}" and re-ran the step.`;
      const ok = await this.#redispatchNodeFresh(ctx, node.id, 'self_heal_runtime_rebound');
      if (ok) {
        this.recordSelfHealIncident(ctx, node, {
          status: 'APPLIED', mode: cfg.mode, attempt, maxAttempts: cfg.maxRepairPlans,
          diagnosis, outcome: 'runtime_rebound',
        });
        await this.host.persistRun(ctx).catch(() => {});
        await this.host.deps.ledger.append({
          workspaceId: ctx.workspaceId, ambientId: ctx.ambientId, runId: ctx.runId,
          eventType: 'self_heal.runtime_rebound', nodeId: node.id, payload: { agentId: pinnedId, attempt },
        }).catch(() => {});
        this.host.audit(ctx, { nodeId: node.id, action: 'self_heal.runtime_rebound', actorType: 'system', actorId: 'engine', outputSummary: diagnosis });
        return { kind: 'structural_applied' };
      }
    }

    // 2) Reroute the step to the healer (configured agent, else orchestrator).
    const healerId = this.#resolveHealerExecutor(ctx, cfg, config.prompt, config.requires);
    if (healerId && healerId !== pinnedId) {
      const attempt = recordSelfHealAttempt(ctx, node.id);
      await this.host.persistRun(ctx).catch(() => {});
      const healerName = this.#agentDisplayName(healerId);
      const reroutedGraph: WorkflowGraph = {
        ...ctx.graph,
        nodes: ctx.graph.nodes.map((n) => (n.id === node.id ? { ...n, config: { ...config, agentId: healerId } } : n)),
      };
      const patch = this.#buildHealPatch(ctx, reroutedGraph, 'runtime_reroute');
      const diagnosis = `${pinnedId ? `Agent "${this.#agentDisplayName(pinnedId)}"` : 'This step\'s agent'} has no connected runtime. Re-routed the step to ${healerName} (online), preserving the task and its declared output contract.`;
      const grounding = `runtime reroute: ${pinnedId ?? 'unbound'} → ${healerId}`;
      const policy = decideRecoveryPolicy(cfg.mode, ctx.graph, reroutedGraph);
      const fingerprint = repairPlanFingerprint({
        tier: 'deterministic',
        addNodes: patch.addNodes,
        updateNodes: patch.updateNodes,
        removeNodeIds: patch.removeNodeIds,
        addEdges: patch.addEdges,
        removeEdgeIds: patch.removeEdgeIds,
      });
      if (this.#repairPlansFor(ctx, node.id).some((plan) => plan.fingerprint === fingerprint)) {
        return this.#blockSelfHeal(ctx, node, {
          mode: cfg.mode, attempt, maxAttempts: cfg.maxRepairPlans, error,
          reason: 'Self-healing rejected a duplicate runtime reroute instead of cycling executors.', diagnosis,
        });
      }
      const plan = this.#appendRepairPlan(ctx, node, {
        tier: 'deterministic',
        fingerprint,
        requiresApproval: policy.requiresApproval,
        patchId: patch.patchId,
        resumeNodeId: node.id,
        riskReason: policy.impact.reason,
        status: policy.requiresApproval ? 'awaiting_approval' : 'planned',
      });
      if (!policy.requiresApproval) {
        const applied = await this.applyHealAndRedispatch(ctx, node.id, patch, plan.id);
        if (applied) {
          this.recordSelfHealIncident(ctx, node, {
            status: 'APPLIED', mode: cfg.mode, attempt, maxAttempts: cfg.maxRepairPlans,
            diagnosis, reason: grounding, outcome: 'runtime_rerouted',
          });
          await this.host.persistRun(ctx).catch(() => {});
          await this.host.deps.ledger.append({
            workspaceId: ctx.workspaceId, ambientId: ctx.ambientId, runId: ctx.runId,
            eventType: 'self_heal.runtime_rerouted', nodeId: node.id, payload: { from: pinnedId, to: healerId, attempt },
          }).catch(() => {});
          this.host.audit(ctx, { nodeId: node.id, action: 'self_heal.runtime_rerouted', actorType: 'system', actorId: 'engine', outputSummary: diagnosis });
          return { kind: 'structural_applied' };
        }
      } else {
        const queued = await this.#proposeHealForApproval(ctx, node, patch, node.id, diagnosis, grounding, attempt, cfg.maxRepairPlans, policy.impact.reason, plan.id);
        if (queued) return { kind: 'awaiting_approval' };
      }
    }

    return { kind: 'none' };
  }

  /** Bind an agent's runtime if it isn't already connected. Returns true if it ends up connected. */
  #tryBindAgentRuntime(ctx: RunningContext, agentId: string, task?: string | null, model?: string | null): boolean {
    if (this.host.agentHasConnectedRuntime(agentId)) return true;
    try {
      const runtime = this.host.deps.resolveAgentRuntime?.(ctx.workspaceId, agentId, task ?? null, model ?? null);
      if (runtime) {
        this.host.deps.adapters.register(agentId, runtime);
        this.host.deps.logger.info('engine.self_heal.runtime_bound', { runId: ctx.runId, agentId, adapterType: runtime.adapterType });
      }
    } catch (err) {
      this.host.deps.logger.warn('engine.self_heal.runtime_bind_failed', { runId: ctx.runId, agentId, error: (err as Error).message });
    }
    return this.host.agentHasConnectedRuntime(agentId);
  }

  /** The agent that backs self-healing: configured healer → orchestrator → any connected agent. Ensures a runtime. */
  #resolveHealerExecutor(
    ctx: RunningContext,
    cfg: SelfHealConfig,
    task?: string | null,
    requires?: AgentRequirements,
  ): string | null {
    const ready = (id: string | null | undefined): string | null => {
      if (!id || !this.#tryBindAgentRuntime(ctx, id, task, this.host.agentConfiguredModel(id))) return null;
      return agentSatisfiesRequirements(this.host.deps.adapters.capabilities(id), requires) ? id : null;
    };
    return ready(cfg.healerAgentId)
      ?? ready(this.host.findAgentByRole(ctx.workspaceId, 'orchestrator'))
      ?? this.host.resolveConnectedFallbackAgent(ctx.workspaceId, [], requires);
  }

  /** Human-readable name for an agent id (falls back to role, then id). */
  #agentDisplayName(agentId: string): string {
    try {
      const row = this.host.deps.db
        .select({ name: schema.agents.name, role: schema.agents.role })
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId))
        .get();
      return row?.name?.trim() || row?.role?.trim() || agentId;
    } catch {
      return agentId;
    }
  }

  /** The REAL agents a repair may use, so the planner routes to something that exists. */
  #availableRepairResources(ctx: RunningContext): RepairResourceContext {
    try {
      const agents = this.host.deps.db
        .select({ id: schema.agents.id, role: schema.agents.role, status: schema.agents.status, capabilityTags: schema.agents.capabilityTags, isPaused: schema.agents.isPaused })
        .from(schema.agents)
        .where(eq(schema.agents.workspaceId, ctx.workspaceId))
        .all()
        .filter((a) => !a.isPaused)
        .map((a) => ({
          id: a.id,
          ...(a.role ? { role: a.role } : {}),
          status: this.host.agentHasConnectedRuntime(a.id) ? 'connected' : (a.status ?? 'offline'),
          ...(Array.isArray(a.capabilityTags) && a.capabilityTags.length > 0 ? { capabilities: a.capabilityTags as string[] } : {}),
        }));
      return { agents };
    } catch {
      return {};
    }
  }

  /**
   * FULL POWER (the top rung): run the orchestrator as a real agent — the SAME
   * tool surface chat has — to replan a failed run. With the registry wired it can
   * CREATE what's missing (new agents, extensions, abilities, workflows) and then
   * resume; without it, it falls back to a read-only discovery loop. Either way it
   * only RETURNS a repaired graph: the service's finalize/validate/certify gates
   * and the engine's immutable-node/resume/policy/attempt-cap all apply unchanged,
   * so agency never bypasses safety and it can't loop (one plan per bounded
   * attempt; on failure it falls through to honest escalation).
   */
  async #orchestratorReplan(
    ctx: RunningContext,
    node: WorkflowNode,
    args: DeepPlanArgs,
    signal: AbortSignal,
    abortRepair: (reason?: unknown) => void,
  ): Promise<DeepPlanResult | null> {
    signal.throwIfAborted();
    let cfg: SelfHealConfig;
    try { cfg = getSelfHealConfig(this.host.deps.db, ctx.workspaceId); } catch { return null; }
    const prompt = (node.config as { prompt?: string }).prompt ?? '';
    const healerId = this.#resolveHealerExecutor(ctx, cfg, prompt);
    const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
    const resourceLines = (args.resources?.agents ?? [])
      .map((a) => `- ${a.id}${a.role ? ` (${a.role})` : ''} [${a.status ?? 'unknown'}]${a.capabilities?.length ? ` caps: ${a.capabilities.join(',')}` : ''}`)
      .join('\n');
    // BYPASS = full autonomy. The healer is a real coding harness that ALREADY has
    // total desktop control (shell, files, scripts — its native tools run with
    // --dangerously-skip-permissions). In bypass mode we STOP restricting it to a
    // "return a graph" straitjacket and let it fix the WORLD like a human engineer:
    // set config/env, create dirs, run setup, fix credentials, repair extension
    // source — whatever the failure needs — then resume. Guarded keeps the safe
    // "propose a graph for approval" path.
    const autonomous = cfg.mode === 'bypass';
    const powerLine = autonomous
      ? 'YOU HAVE FULL CONTROL of this machine and workspace — the same power as your own coding sessions: shell, filesystem, running scripts, editing files, installing dependencies, setting configuration and credentials — PLUS every Agentis tool (create agents/extensions/abilities/workflows, patch graphs). Fix this failed run BY ANY MEANS a human engineer would use at a terminal. Do NOT hand config/setup work back to the human and do NOT give up because "no graph edit can fix it" — if the fix lives outside the graph (a missing directory, an unset env var, a bad credential, an unbuilt project), DO IT YOURSELF, then resume.'
      : 'Prefer the real available agents below. If a needed capability is genuinely missing, you MAY create it (a new agent, extension, ability, or workflow) with your tools. Never reference a resource you have not verified exists or created.';
    const closingLine = autonomous
      ? 'When the run can now succeed, resume it. If the failure was ENVIRONMENTAL (missing config/dir/credential/setup/build) and the graph LOGIC is already correct, fix the environment with your tools, then return the SAME nodes/edges UNCHANGED with resumeNodeId set to the failed node — the engine re-runs it and it now passes. If the graph LOGIC is wrong, return the corrected nodes/edges. Do not rerun or cancel the live run yourself — the engine resumes after you finish; everything else on this machine is yours to fix.'
      : 'Do not directly patch or rerun this live run with a tool. Create missing internal resources if needed, then RETURN the candidate repaired graph. The engine will validate, certify, checkpoint, apply, and resume.';
    const brief = [
      autonomous
        ? 'You are an AUTONOMOUS ENGINEER repairing a FAILED workflow run so it still achieves its goal. You have root-level power over this machine and workspace.'
        : 'You are the orchestrator repairing a FAILED workflow run so it still achieves its goal.',
      'Rules: change HOW, never WHAT (preserve the goal, input contract, and the meaning of declared outputs).',
      'NEVER alter the immutable (completed/active) nodes — their work is done; reusing it is mandatory and saves tokens.',
      'Resume from the minimal failed frontier; do not rebuild completed steps.',
      powerLine,
      '',
      `GOAL: ${clip(args.intent.goal, 500)}`,
      `DECLARED OUTPUTS (meaning immutable): ${args.intent.declaredOutputKeys.join(', ')}`,
      `FAILING NODE: ${args.node.id}`,
      `ERROR: ${clip(args.error, 600)}`,
      `DIAGNOSIS: ${clip(args.diagnosis, 500)}`,
      `IMMUTABLE NODE IDS: ${args.immutableNodeIds.join(', ') || '(none)'}`,
      resourceLines ? `AVAILABLE AGENTS:\n${clip(resourceLines, 2000)}` : 'AVAILABLE AGENTS: (none connected)',
      `COMPLETED UPSTREAM OUTPUTS (read-only evidence):\n${clip(JSON.stringify(args.upstreamOutputs ?? {}), 6000)}`,
      `CURRENT NODES:\n${clip(JSON.stringify(args.graph.nodes), 9000)}`,
      `CURRENT EDGES:\n${clip(JSON.stringify(args.graph.edges), 4000)}`,
      '',
      closingLine,
      'When the workflow can succeed, finish with EXACTLY one JSON object between <agentis_self_heal_repair> tags:',
      '<agentis_self_heal_repair>',
      '{"nodes":[...full nodes...],"edges":[...full edges...],"resumeNodeId":"<node id to resume from>","grounding":"<one line: what you did / the evidence>","preservesIntent":true,"grounded":true,"cannotRepair":false}',
      '</agentis_self_heal_repair>',
      'If you genuinely cannot make it succeed, output <agentis_self_heal_repair>{"cannotRepair":true}</agentis_self_heal_repair>.',
    ].join('\n');
    this.host.emitWorkStep(ctx, node, 'thinking', 'Orchestrator is replanning the workflow with full power');

    const chatPlan = await this.#chatReplanLoop(ctx, node, healerId, brief, clip, autonomous, signal, abortRepair);
    if (chatPlan) return chatPlan;
    signal.throwIfAborted();

    // Fallback: read-only discovery loop when no chat-capable repair agent exists.
    const llm = (this.host.deps.resolveEvaluatorRuntime?.(ctx.workspaceId, 'evaluation', { task: args.error, purpose: 'self_heal_replan' })
      ?? this.host.deps.evaluatorRuntime
      ?? this.#resolveSelfHealCompleter(ctx, node, prompt, args.error, cfg)) as StructuredLlm | null;
    if (!llm) return null;
    if (!this.host.deps.agentTools) return null;
    const role = ((healerId ? this.host.agentRole(healerId) : null) ?? 'orchestrator') as AgentRole;
    const discoveryTools: AgentTool[] = ['web_search', 'read_url', 'knowledge_search', 'agent_memory_search', 'workflow_memory_read', 'run_code'];
    try {
      const result = await new AgentToolLoop({ runtime: this.host.deps.agentTools, llm, logger: this.host.deps.logger }).run({
        workspaceId: ctx.workspaceId, role, task: brief, tools: discoveryTools, maxSteps: 6, workflowId: ctx.workflowId,
        ...(healerId ? { agentId: healerId } : {}),
        onStep: (step) => { if (step.phase === 'thinking' && step.thought) this.host.emitWorkStep(ctx, node, 'thinking', clip(step.thought, 200)); },
        signal,
      });
      return this.#parseReplanOutput(result.output);
    } catch (err) {
      if (signal.aborted) throw signal.reason ?? err;
      this.host.deps.logger.warn('engine.self_heal.replan_failed', { runId: ctx.runId, nodeId: node.id, error: (err as Error).message });
      return null;
    }
  }

  /** The full-power ReAct loop over the complete agent tool registry (creation included). */
  async #chatReplanLoop(
    ctx: RunningContext,
    node: WorkflowNode,
    healerId: string | null,
    brief: string,
    clip: (s: string, n: number) => string,
    autonomous: boolean,
    signal: AbortSignal,
    abortRepair: (reason?: unknown) => void,
  ): Promise<DeepPlanResult | null> {
    if (!healerId) return null;
    const adapter = this.host.deps.adapters.get(healerId)?.adapter;
    if (!adapter?.chat || adapter.capabilities?.().interactiveChat === false) return null;
    const releaseLease = this.host.deps.adapters.tryAcquireInteractiveLease(healerId, {
      ownerId: `self-heal:${ctx.runId}:${node.id}`,
      kind: 'self_heal',
      priority: 10,
      onPreempt: () => abortRepair(new Error('self-heal preempted by operator chat')),
    });
    if (!releaseLease) {
      this.host.emitWorkStep(ctx, node, 'thinking', 'Self-healing deferred because this agent is already handling an interactive turn.');
      abortRepair(new Error('self-heal deferred: interactive agent is busy'));
      signal.throwIfAborted();
      return null;
    }
    const systemAddendum = (autonomous
      ? [
          'SELF-HEALING MODE (BYPASS / FULL AUTONOMY): you are an autonomous engineer fixing a live workflow run with root-level power.',
          'Use ANY tool — your OWN shell/filesystem/desktop tools AND every Agentis tool — to make the run succeed. Create directories, run setup scripts, install dependencies, set environment/config, fix credentials, repair an extension\'s source, create agents/extensions/abilities/workflows, or change the graph. Do whatever a human engineer would do at a terminal.',
          'You will NOT be asked to confirm — act. Only the final answer must be the tagged repair JSON.',
          'Hard boundary (safety, not capability): do NOT call agentis.workflow.run, agentis.ephemeral.run, agentis.run.cancel, agentis.approval.resolve, or outbound channel-send tools — the engine resumes the run after you finish. Everything else on this machine and workspace is yours to fix.',
          'Final response contract: reply with only <agentis_self_heal_repair>{...}</agentis_self_heal_repair>. If you fixed the ENVIRONMENT and the graph logic is correct, return the current nodes/edges UNCHANGED with resumeNodeId = the failed node.',
        ]
      : [
          'SELF-HEALING MODE: you are repairing a live workflow run.',
          'You may use ANY tool below — including creating new agents, skills, extensions, or workflows — to make the run succeed.',
          'Use normal chat tool calls while working; only the final answer must be the tagged repair JSON.',
          '  {"thought":"...","action":"tool","toolId":"<id>","arguments":{...}}  — to use/create with a tool',
          '  {"thought":"...","action":"final","output":{...repair graph...}}      — when the workflow can now succeed',
          'Hard boundary: do not call agentis.workflow.patch, agentis.workflow.run, agentis.ephemeral.run, agentis.run.cancel, agentis.approval.resolve, or outbound channel-send tools for this repair. The engine applies and observes the repair after your final graph.',
          'Final response contract: reply with only <agentis_self_heal_repair>{...}</agentis_self_heal_repair>. No prose outside the tags.',
        ]).join('\n');
    let text = '';
    let sawConfirmation = false;
    try {
      for await (const delta of ChatSessionExecutor.turn(adapter, [], brief, {
        workspaceId: ctx.workspaceId,
        agentId: healerId,
        userId: ctx.userId,
        conversationId: `self-heal:${ctx.runId}:${node.id}`,
        clientTurnId: `self-heal:${ctx.runId}:${node.id}`,
        executionMode: 'chat',
        // BYPASS = act without asking. In auto mode a mutating tool never raises a
        // confirmation, so the repair agent can create/set/fix freely instead of
        // aborting the heal at the first approval prompt. Guarded stays 'ask'.
        ...(autonomous ? { permissionMode: 'auto' as const } : {}),
        runId: ctx.runId,
        ambientId: ctx.ambientId,
        viewport: {
          surface: 'run_detail',
          route: `/runs/${ctx.runId}`,
          resourceId: ctx.runId,
          resourceKind: 'run',
          activeRunId: ctx.runId,
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId,
        },
        signal,
      }, {
        tools: this.#selfHealChatTools(),
        maxTurns: 8,
        // High backstop, not the governor — a real repair (diagnose → author fix →
        // dry-run → verify) can take many tool steps; the old 24 clipped a
        // legitimate heal mid-way. ChatProgressMonitor still stops true loops fast.
        // A repair is narrower than an open-ended coding chat. The engine owns
        // validation/resume/verification, so this still leaves ample room for
        // grounded inspection + one repair while bounding worst-case spend.
        maxToolCalls: selfHealMaxToolCalls(),
        systemAddendum,
      })) {
        if (delta.type === 'text') text += delta.delta;
        if (delta.type === 'confirmation_required') sawConfirmation = true;
        this.relayChatDelta(ctx, node, healerId, delta, clip);
      }
    } catch (err) {
      if (signal.aborted) throw signal.reason ?? err;
      this.host.deps.logger.warn('engine.self_heal.replan_failed', { runId: ctx.runId, nodeId: node.id, error: (err as Error).message });
      return null;
    } finally {
      releaseLease();
    }
    if (sawConfirmation) {
      this.host.emitWorkStep(ctx, node, 'thinking', 'The repair agent reached a tool confirmation; self-heal will stop instead of applying an unreviewed tool action.');
      return null;
    }
    const out = this.#parseReplanOutput(text);
    if (out) this.host.deps.logger.info('engine.self_heal.replan_planned', { runId: ctx.runId, nodeId: node.id, source: 'chat' });
    return out;
      // a chat turn — the monitor/console/canvas all read these events, so the
  }

  relayChatDelta(
    ctx: RunningContext,
    node: WorkflowNode,
    healerId: string,
    delta: ChatDelta,
    clip: (s: string, n: number) => string,
  ): void {
    if (delta.type === 'activity') {
      // `status` carries the real outcome ('running'|'success'|'error') of a
      // per-tool activity; `phase` is only 'error' for a terminal turn-level
      // failure (e.g. no chat adapter). Checking `phase` alone let a REAL
      // failed tool call (phase:'tool', status:'error') during the repair
      // loop fall through to 'thinking' — never surfaced as a failure.
      const detail = [delta.label, delta.detail].filter(Boolean).join(' - ');
      // One typed projection is enough. The former `emitWorkStep` call created a
      // second, lossy activity without delta.id/transport/attempt/start time, so
      // every 15-second heartbeat became a permanent duplicate row. The
      // run-scoped notification below is durable and retains the stable identity.
      if (detail) {
        const activityKind = delta.phase === 'tool'
          ? 'tool_call'
          : 'thinking';
        this.host.notifyAgentActivity({
          runId: ctx.runId,
          agentId: healerId,
          taskId: node.id,
          kind: activityKind,
          text: clip(detail, 4000),
          ...(delta.phase === 'tool' ? { tool: delta.tool ?? delta.label } : {}),
          activityId: delta.id,
          activityPhase: delta.phase,
          activityStatus: delta.status,
          activityTitle: delta.label,
          transport: delta.transport,
          attempt: delta.attempt,
          startedAt: delta.startedAt,
          completedAt: delta.completedAt,
          durationMs: delta.durationMs,
        });
      }
      return;
    }
    if (delta.type === 'thinking') {
      this.host.notifyAgentActivity({ runId: ctx.runId, agentId: healerId, taskId: node.id, kind: 'thinking', text: clip(delta.delta, 1000) });
      return;
    }
    if (delta.type === 'text' && delta.delta.trim()) {
      this.host.notifyAgentActivity({ runId: ctx.runId, agentId: healerId, taskId: node.id, kind: 'text', text: clip(delta.delta, 1000) });
      return;
    }
    if (delta.type === 'tool_call') {
      this.host.notifyAgentActivity({ runId: ctx.runId, agentId: healerId, taskId: node.id, kind: 'tool_call', tool: delta.name, toolInput: delta.args });
      return;
    }
    if (delta.type === 'tool_result') {
      this.host.notifyAgentActivity({ runId: ctx.runId, agentId: healerId, taskId: node.id, kind: 'tool_result', tool: delta.name, toolResult: delta.error ? { error: delta.error } : delta.result });
      return;
    }
    if (delta.type === 'confirmation_required') {
      this.host.emitWorkStep(ctx, node, 'thinking', `Repair tool "${delta.toolCall.name}" needs confirmation`);
    }
  }

  #selfHealChatTools(): ToolDefinition[] | undefined {
    const registry = this.host.deps.toolRegistry;
    if (!registry) return undefined;
    return registry.catalog().tools
      .filter((tool) => isSelfHealControlToolAllowed(tool.id))
      .map((tool) => ({
        name: tool.id,
        description: tool.longDescription ?? tool.description,
        parameters: toolInputSchemaToChatParameters(tool.inputSchema),
      }));
  }

  #parseReplanOutput(out: unknown): DeepPlanResult | null {
    type ReplanShape = {
      nodes?: WorkflowNode[];
      edges?: WorkflowGraph['edges'];
      resumeNodeId?: string;
      grounding?: string;
      preservesIntent?: boolean;
      grounded?: boolean;
      cannotRepair?: boolean;
    };
    let parsed: ReplanShape | null = null;
    if (out && typeof out === 'object') parsed = out as ReplanShape;
    else if (typeof out === 'string') {
      const tagged = out.match(/<agentis_self_heal_repair>\s*([\s\S]*?)\s*<\/agentis_self_heal_repair>/i)?.[1] ?? out;
      parsed = parseGeneric(tagged) as ReplanShape | null;
    }
    if (!parsed || parsed.cannotRepair || !Array.isArray(parsed.nodes) || parsed.nodes.length === 0) return null;
    return {
      nodes: parsed.nodes,
      ...(parsed.edges ? { edges: parsed.edges } : {}),
      ...(parsed.resumeNodeId ? { resumeNodeId: parsed.resumeNodeId } : {}),
      ...(parsed.grounding ? { grounding: parsed.grounding } : {}),
      ...(parsed.preservesIntent === true ? { preservesIntent: true } : {}),
      ...(parsed.grounded === true ? { grounded: true } : {}),
    };
  }

  /** Reset a node to PENDING and re-dispatch it through the normal path (no graph change). */
  async #redispatchNodeFresh(ctx: RunningContext, nodeId: string, reason: string): Promise<boolean> {
    const node = ctx.graph.nodes.find((n) => n.id === nodeId);
    if (!node) return false;
    const inputData = ctx.state.nodeStates[nodeId]?.inputData ?? {};
    const ns = ctx.state.nodeStates[nodeId];
    if (ns) ns.status = 'PENDING';
    delete ctx.state.activeExecutions[nodeId];
    this.host.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_RETRY_SCHEDULED, { runId: ctx.runId, nodeId, reason });
    try {
      await this.host.dispatchNode(ctx, node, { nodeId, priority: 0, insertedAt: new Date().toISOString(), inputData });
      void this.host.tick(ctx);
      return true;
    } catch (err) {
      this.host.deps.logger.warn('engine.self_heal.redispatch_failed', { runId: ctx.runId, nodeId, error: (err as Error).message });
      return false;
    }
  }

  /**
   * Resolve the brain that grounds self-healing. A dedicated evaluator is best,
   * but Agentis must not block repairs just because no evaluator model is
   * configured: the connected orchestrator/specialists are already valid
   * reasoning runtimes.
   */
  #resolveSelfHealCompleter(
    ctx: RunningContext,
    node: WorkflowNode,
    prompt: string,
    error: string,
    cfg: SelfHealConfig,
  ): StructuredCompleter | null {
    const task = prompt || error || node.title;
    const dedicated = this.host.deps.resolveEvaluatorRuntime?.(ctx.workspaceId, 'evaluation', {
      task,
      purpose: 'self_heal',
    }) ?? this.host.deps.evaluatorRuntime;
    if (dedicated && typeof (dedicated as { completeStructured?: unknown }).completeStructured === 'function') {
      return dedicated as unknown as StructuredCompleter;
    }

    const fallbacks: StructuredCompleter[] = [];
    for (const candidate of this.#selfHealAgentCandidates(ctx, node, cfg)) {
      const completer = this.#adapterCompleterForSelfHealAgent(ctx, candidate.agentId, {
        nodeId: node.id,
        task,
        preferredModel: candidate.preferredModel,
        label: candidate.label,
      });
      if (completer) fallbacks.push(completer);
    }
    return fallbacks.length === 0 ? null : fallbacks.length === 1 ? (fallbacks.at(0) ?? null) : new FallbackStructuredCompleter(fallbacks);
  }

  #selfHealAgentCandidates(
    ctx: RunningContext,
    node: WorkflowNode,
    cfg: SelfHealConfig,
  ): Array<{ agentId: string; preferredModel?: string; label: string }> {
    const candidates: Array<{ agentId: string; preferredModel?: string; label: string }> = [];
    const seen = new Set<string>();
    const add = (agentId: unknown, label: string, preferredModel?: string | null) => {
      if (typeof agentId !== 'string' || !agentId.trim() || seen.has(agentId)) return;
      seen.add(agentId);
      candidates.push({
        agentId,
        label,
        ...(preferredModel ? { preferredModel } : {}),
      });
    };

    const workspaceAgents = this.host.deps.db
      .select({
        id: schema.agents.id,
        role: schema.agents.role,
        status: schema.agents.status,
        isPaused: schema.agents.isPaused,
      })
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, ctx.workspaceId))
      .all();
    // Strict and inspectable: configured healer, then orchestrator. A failed
    // repair must never silently commandeer an unrelated workspace agent.
    if (cfg.healerAgentId) add(cfg.healerAgentId, 'self-heal configured healer');
    const orchestrator = workspaceAgents.find((agent) => agent.role === 'orchestrator' && !agent.isPaused)
      ?? workspaceAgents.find((agent) => agent.role === 'orchestrator');
    if (orchestrator) add(orchestrator.id, 'self-heal orchestrator runtime');

    return candidates;
  }

  #adapterCompleterForSelfHealAgent(
    ctx: RunningContext,
    agentId: string,
    args: { nodeId: string; task: string; preferredModel?: string; label: string },
  ): StructuredCompleter | null {
    const preferredModel = args.preferredModel ?? this.host.agentConfiguredModel(agentId) ?? undefined;
    let adapter = this.host.deps.adapters.get(agentId)?.adapter;
    if (!adapter) {
      const resolved = this.host.deps.resolveAgentRuntime?.(ctx.workspaceId, agentId, args.task, preferredModel ?? null);
      if (resolved) {
        this.host.deps.adapters.register(agentId, resolved);
        adapter = resolved;
        this.host.deps.logger.info('engine.self_heal.runtime_bound', {
          runId: ctx.runId,
          nodeId: args.nodeId,
          agentId,
          adapterType: resolved.adapterType,
        });
      }
    }
    if (!adapter?.chat || adapter.capabilities?.().interactiveChat === false) return null;
    this.host.deps.logger.info('engine.self_heal.agent_runtime', {
      runId: ctx.runId,
      nodeId: args.nodeId,
      agentId,
      adapterType: adapter.adapterType,
      source: args.label,
    });
    return new AdapterStructuredCompleter(adapter, `${args.label}:${agentId}`, preferredModel);
  }

  /** Collect the outputs of nodes feeding into `nodeId` (read-only diagnosis context). */
  #upstreamOutputs(ctx: RunningContext, nodeId: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const edge of ctx.graph.edges) {
      if (edge.target !== nodeId) continue;
      const data = ctx.state.nodeStates[edge.source]?.outputData;
      if (data) out[edge.source] = data;
    }
    return out;
  }

  #repairPlansFor(ctx: RunningContext, nodeId: string) {
    return ctx.state.selfHealIncidents?.[nodeId]?.plans ?? [];
  }

  #immutableRecoveryNodeIds(ctx: RunningContext, failedNodeId: string): string[] {
    return Object.values(ctx.state.nodeStates)
      .filter((state) => state.nodeId !== failedNodeId && (state.status === 'COMPLETED' || state.status === 'RUNNING'))
      .map((state) => state.nodeId);
  }

  #appendRepairPlan(
    ctx: RunningContext,
    node: WorkflowNode,
    plan: Omit<NonNullable<WorkflowSelfHealIncident['plans']>[number], 'id' | 'createdAt'>,
  ): NonNullable<WorkflowSelfHealIncident['plans']>[number] {
    const now = new Date().toISOString();
    const next = { ...plan, id: randomUUID(), createdAt: now };
    const current = ctx.state.selfHealIncidents?.[node.id];
    this.recordSelfHealIncident(ctx, node, {
      incidentId: current?.incidentId ?? node.id,
      failureFingerprint: current?.failureFingerprint ?? recoveryFailureFingerprint(node.id, current?.error ?? ''),
      plans: [...(current?.plans ?? []), next],
      tier: next.tier,
      status: 'PLANNING',
    });
    return next;
  }

  completeRepairPlan(
    ctx: RunningContext,
    node: WorkflowNode,
    planId: string,
    status: Extract<NonNullable<WorkflowSelfHealIncident['plans']>[number]['status'], 'applied' | 'rejected' | 'blocked' | 'rolled_back'>,
    checkpointId?: string,
  ): void {
    const current = ctx.state.selfHealIncidents?.[node.id];
    if (!current?.plans) return;
    const now = new Date().toISOString();
    this.recordSelfHealIncident(ctx, node, {
      plans: current.plans.map((plan) => plan.id === planId ? { ...plan, status, checkpointId: checkpointId ?? plan.checkpointId, completedAt: now } : plan),
      checkpointId: checkpointId ?? current.checkpointId,
    });
  }

  recordSelfHealIncident(
    ctx: RunningContext,
    node: WorkflowNode,
    update: Partial<WorkflowSelfHealIncident>,
  ): WorkflowSelfHealIncident {
    const now = new Date().toISOString();
    const current = ctx.state.selfHealIncidents?.[node.id];
    const status = update.status ?? current?.status ?? 'DIAGNOSING';
    const terminal = status === 'APPLIED' || status === 'BLOCKED' || status === 'EXHAUSTED';
    const traceChanged = !current
      || status !== current.status
      || (update.diagnosis !== undefined && update.diagnosis !== current.diagnosis)
      || (update.reason !== undefined && update.reason !== current.reason)
      || (update.outcome !== undefined && update.outcome !== current.outcome);
    const detail = update.diagnosis ?? update.reason ?? update.error ?? current?.diagnosis ?? current?.reason ?? current?.error;
    const tier = update.tier ?? current?.tier;
    const trace = traceChanged
      ? [...(current?.trace ?? []), {
          id: randomUUID(),
          phase: selfHealTracePhase(status),
          status,
          summary: selfHealTraceSummary(status, update.outcome ?? current?.outcome),
          attempt: update.attempt ?? current?.attempt ?? 0,
          ...(detail ? { detail } : {}),
          ...(tier ? { tier } : {}),
          createdAt: now,
        }].slice(-50)
      : current?.trace;
    const incident: WorkflowSelfHealIncident = {
      ...current,
      incidentId: update.incidentId ?? current?.incidentId ?? node.id,
      nodeId: node.id,
      nodeTitle: node.title,
      status,
      mode: update.mode ?? current?.mode ?? 'guarded',
      attempt: update.attempt ?? current?.attempt ?? 0,
      maxAttempts: update.maxAttempts ?? current?.maxAttempts ?? 0,
      error: update.error ?? current?.error,
      diagnosis: update.diagnosis ?? current?.diagnosis,
      reason: update.reason ?? current?.reason,
      tier: update.tier ?? current?.tier,
      failureFingerprint: update.failureFingerprint ?? current?.failureFingerprint ?? recoveryFailureFingerprint(node.id, update.error ?? current?.error ?? ''),
      failureClass: update.failureClass ?? current?.failureClass,
      repairScope: update.repairScope ?? current?.repairScope,
      baseRevisionId: update.baseRevisionId ?? current?.baseRevisionId,
      candidateRevisionId: update.candidateRevisionId ?? current?.candidateRevisionId,
      recurrent: update.recurrent ?? current?.recurrent,
      plans: update.plans ?? current?.plans,
      trace,
      riskReason: update.riskReason ?? current?.riskReason,
      approvalId: update.approvalId ?? current?.approvalId,
      checkpointId: update.checkpointId ?? current?.checkpointId,
      resumeNodeId: update.resumeNodeId ?? current?.resumeNodeId,
      outcome: update.outcome ?? current?.outcome,
      startedAt: current?.startedAt ?? now,
      updatedAt: now,
      ...(terminal ? { completedAt: update.completedAt ?? current?.completedAt ?? now } : {}),
    };
    ctx.state.selfHealIncidents = { ...(ctx.state.selfHealIncidents ?? {}), [node.id]: incident };
    return incident;
  }

  async #blockSelfHeal(
    ctx: RunningContext,
    node: WorkflowNode,
    args: {
      mode: WorkflowRecoveryMode;
      attempt: number;
      maxAttempts: number;
      error: string;
      reason: string;
      diagnosis?: string;
      exhausted?: boolean;
    },
  ): Promise<SelfHealEngineResult> {
    const status = args.exhausted ? 'EXHAUSTED' : 'BLOCKED';
    this.recordSelfHealIncident(ctx, node, {
      status,
      mode: args.mode,
      attempt: args.attempt,
      maxAttempts: args.maxAttempts,
      error: args.error,
      reason: args.reason,
      diagnosis: args.diagnosis,
      outcome: args.exhausted ? 'exhausted' : 'blocked',
    });
    await this.host.deps.ledger.append({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      runId: ctx.runId,
      eventType: args.exhausted ? 'self_heal.exhausted' : 'self_heal.blocked',
      nodeId: node.id,
      payload: {
        reason: args.reason,
        diagnosis: args.diagnosis,
        attempt: args.attempt,
        maxAttempts: args.maxAttempts,
      },
    }).catch(() => {});
    this.host.audit(ctx, {
      nodeId: node.id,
      action: args.exhausted ? 'self_heal.exhausted' : 'self_heal.blocked',
      actorType: 'system',
      actorId: 'engine',
      outputSummary: args.diagnosis ? `${args.reason}: ${args.diagnosis}` : args.reason,
    });
    await this.host.persistRun(ctx).catch(() => {});
    return { kind: 'none', reason: args.reason, diagnosis: args.diagnosis };
  }

  /** Turn a certified full graph into the one shared graph-patch representation. */
  #buildHealPatch(ctx: RunningContext, patchedGraph: WorkflowGraph, reason: string): WorkflowGraphPatch {
    void reason;
    return graphDiffPatch(ctx.graph, patchedGraph, ctx.state.graphRevision ?? 0);
  }

  /** Apply a certified heal patch (reuses applyGraphPatch: validate+persist+revision+audit), then re-run the node. */
  async applyHealAndRedispatch(ctx: RunningContext, nodeId: string, patch: WorkflowGraphPatch, repairPlanId?: string): Promise<boolean> {
    const graphBefore = ctx.graph;
    const revisionBefore = ctx.state.graphRevision ?? 0;
    try {
      await this.host.applyGraphPatch({ runId: ctx.runId, patch });
    } catch (err) {
      this.host.deps.logger.warn('engine.self_heal.apply_failed', { runId: ctx.runId, nodeId, error: (err as Error).message });
      return false;
    }
    let checkpointId: string | undefined;
    if (repairPlanId) {
      const incident = Object.values(ctx.state.selfHealIncidents ?? {}).find((item) => item.plans?.some((plan) => plan.id === repairPlanId));
      if (incident) {
        checkpointId = randomUUID();
        try {
          await this.host.deps.db.insert(schema.workflowRepairCheckpoints).values({
            id: checkpointId,
            workspaceId: ctx.workspaceId,
            runId: ctx.runId,
            workflowId: ctx.workflowId || null,
            incidentId: incident.incidentId ?? incident.nodeId,
            planId: repairPlanId,
            revisionBefore,
            revisionAfter: ctx.state.graphRevision ?? revisionBefore + 1,
            graphBefore: graphBefore as unknown as object,
            graphAfter: ctx.graph as unknown as object,
            patch: patch as unknown as object,
          });
          const incidentNode = ctx.graph.nodes.find((node) => node.id === incident.nodeId) ?? {
            id: incident.nodeId,
            title: incident.nodeTitle ?? incident.nodeId,
          } as WorkflowNode;
          this.completeRepairPlan(ctx, incidentNode, repairPlanId, 'applied', checkpointId);
        } catch (err) {
          this.host.deps.logger.warn('engine.self_heal.checkpoint_failed', { runId: ctx.runId, repairPlanId, error: (err as Error).message });
          return false;
        }
      }
    }
    // Reconciliation belongs beside the only repair executor. New topology gets
    // fresh pending state, while completed/in-flight nodes were rejected by the
    // planner before this point.
    for (const removedNodeId of patch.removeNodeIds) {
      const state = ctx.state.nodeStates[removedNodeId];
      // The failed node may still be marked RUNNING while #failNode invokes
      // recovery. Completed work is immutable; the failing execution is not.
      if (state?.status === 'COMPLETED') return false;
      delete ctx.state.nodeStates[removedNodeId];
      delete ctx.state.activeExecutions[removedNodeId];
      ctx.state.readyQueue = ctx.state.readyQueue.filter((item) => item.nodeId !== removedNodeId);
    }
    for (const added of patch.addNodes) {
      ctx.state.nodeStates[added.id] ??= { nodeId: added.id, status: 'PENDING' };
    }
    const patched = ctx.graph.nodes.find((n) => n.id === nodeId);
    if (!patched) return false;
    const inputData = ctx.state.nodeStates[nodeId]?.inputData ?? {};
    // Reset the node so it re-runs through the ORIGINAL dispatch path
    // (#dispatchNode handles useRoleTools / session / adapter uniformly — calling
    // #dispatchAgentTask directly would skip routing + the tool-loop branch).
    const ns = ctx.state.nodeStates[nodeId];
    if (ns) ns.status = 'PENDING';
    else ctx.state.nodeStates[nodeId] = { nodeId, status: 'PENDING', inputData };
    delete ctx.state.activeExecutions[nodeId];
    this.host.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_RETRY_SCHEDULED, { runId: ctx.runId, nodeId, reason: 'self_heal_structural' });
    await this.host.dispatchNode(ctx, patched, { nodeId, priority: 0, insertedAt: new Date().toISOString(), inputData });
    if (repairPlanId) this.completeRepairPlan(ctx, patched, repairPlanId, 'applied', checkpointId);
    // Drive the settle pass — re-dispatch may originate outside the tick loop
    // (e.g. resolveApproval), where nothing else would transition the run.
    void this.host.tick(ctx);
    return true;
  }

  /** Queue a structural heal patch for operator approval; pause the node (W7 approve mode). */
  async #proposeHealForApproval(
    ctx: RunningContext,
    node: WorkflowNode,
    patch: WorkflowGraphPatch,
    resumeNodeId: string,
    diagnosis: string,
    grounding: string,
    attempt: number,
    maxAttempts: number,
    riskReason?: string,
    repairPlanId?: string,
  ): Promise<boolean> {
    try {
      const approval = await this.host.deps.approvals.create({
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId,
        userId: ctx.userId,
        runId: ctx.runId,
        taskId: null,
        targetId: node.id,
        gatewayId: null,
        source: 'self_heal',
        title: `Confirm outward self-healing change for "${node.title}"`,
        summary: `${diagnosis}\n\nGrounding: ${grounding}\n\nWhy confirmation is needed: ${riskReason ?? 'The repair changes an outward or irreversible action.'}\n\nApprove to apply and resume.`,
        confidence: null,
        payload: {
          kind: 'graph_patch',
          workflowId: ctx.workflowId,
          runId: ctx.runId,
          nodeId: node.id,
          nodeTitle: node.title,
          diagnosis,
          grounding,
          attempt,
          maxAttempts,
          patch,
          resumeNodeId,
          riskReason,
          repairPlanId,
        },
      });
      this.host.pendingApprovals(ctx).set(approval.id, {
        kind: 'self_heal', targetId: node.id, healAction: 'graph_patch', healPatch: patch,
        healResumeNodeId: resumeNodeId, repairPlanId,
      });
      const ns = ctx.state.nodeStates[node.id];
      if (ns) ns.status = 'WAITING';
      delete ctx.state.activeExecutions[node.id];
      this.recordSelfHealIncident(ctx, node, {
        status: 'AWAITING_APPROVAL',
        mode: 'guarded',
        attempt,
        maxAttempts,
        diagnosis,
        reason: grounding,
        riskReason,
        resumeNodeId,
        approvalId: approval.id,
        outcome: 'graph_patch_awaiting_approval',
      });
      await this.host.persistRun(ctx);
      this.host.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_WAITING_FOR_INPUT, {
        runId: ctx.runId,
        nodeId: node.id,
        reason: 'self_heal_approval',
        detail: diagnosis,
        approvalId: approval.id,
      });
      await this.host.deps.ledger.append({
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId,
        runId: ctx.runId,
        eventType: 'self_heal.approval_requested',
        nodeId: node.id,
        payload: { approvalId: approval.id, diagnosis, grounding, attempt, maxAttempts },
      }).catch(() => {});
      this.host.audit(ctx, { nodeId: node.id, action: 'self_heal.approval_requested', actorType: 'system', actorId: 'engine', outputSummary: diagnosis });
      return true;
    } catch (err) {
      this.host.deps.logger.warn('engine.self_heal.approval_failed', { runId: ctx.runId, nodeId: node.id, error: (err as Error).message });
      return false;
    }
  }

  async retryWithRepairContext(
    ctx: RunningContext,
    node: WorkflowNode,
    error: string,
    diagnosis: string,
    attempt: number,
    maxAttempts: number,
    mode: WorkflowRecoveryMode = 'bypass',
  ): Promise<boolean> {
    if (node.config.kind !== 'agent_task') return false;
    const inputData = ctx.state.nodeStates[node.id]?.inputData ?? {};
    const retryConfig: AgentTaskNodeConfig = {
      ...node.config,
      prompt:
        `${node.config.prompt}\n\n---\nSELF-HEALING RETRY (attempt ${attempt}/${maxAttempts}).\n` +
        `Failure: ${error}\nDiagnosis: ${diagnosis}\n` +
        'Repair the step while preserving the workflow intent. Do not fabricate missing source data.',
    };
    const retryNode: WorkflowNode = { ...node, config: retryConfig };
    const ns = ctx.state.nodeStates[node.id];
    if (ns) ns.status = 'PENDING';
    delete ctx.state.activeExecutions[node.id];
    this.recordSelfHealIncident(ctx, node, {
      status: 'RETRYING',
      mode,
      attempt,
      maxAttempts,
      error,
      diagnosis,
      outcome: 'retrying',
    });
    await this.host.persistRun(ctx).catch(() => {});
    this.host.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_RETRY_SCHEDULED, {
      runId: ctx.runId,
      nodeId: node.id,
      attempt,
      reason: 'self_heal_retry_with_repair_context',
    });
    try {
      await this.host.dispatchNode(ctx, retryNode, {
        nodeId: node.id,
        priority: 0,
        insertedAt: new Date().toISOString(),
        inputData,
      });
      void this.host.tick(ctx);
      return true;
    } catch (err) {
      await this.host.failNode(ctx, node.id, (err as Error).message);
      return false;
    }
  }

  async #proposeRetryForApproval(
    ctx: RunningContext,
    node: WorkflowNode,
    error: string,
    diagnosis: string,
    attempt: number,
    maxAttempts: number,
  ): Promise<boolean> {
    if (node.config.kind !== 'agent_task') return false;
    try {
      const approval = await this.host.deps.approvals.create({
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId,
        userId: ctx.userId,
        runId: ctx.runId,
        taskId: null,
        targetId: node.id,
        gatewayId: null,
        source: 'self_heal',
        title: `Approve self-healing retry for "${node.title}"`,
        summary: `${diagnosis}\n\nThe agent can retry this step with the failure context attached. Approve to retry and resume.`,
        confidence: null,
        payload: {
          kind: 'retry_with_repair_context',
          workflowId: ctx.workflowId,
          runId: ctx.runId,
          nodeId: node.id,
          nodeTitle: node.title,
          error,
          diagnosis,
          attempt,
          maxAttempts,
        },
      });
      this.host.pendingApprovals(ctx).set(approval.id, {
        kind: 'self_heal',
        targetId: node.id,
        healAction: 'retry_with_repair_context',
        retryError: error,
        retryDiagnosis: diagnosis,
        retryAttempt: attempt,
        retryMaxAttempts: maxAttempts,
      });
      const ns = ctx.state.nodeStates[node.id];
      if (ns) ns.status = 'WAITING';
      delete ctx.state.activeExecutions[node.id];
      this.recordSelfHealIncident(ctx, node, {
        status: 'AWAITING_APPROVAL',
        mode: 'guarded',
        attempt,
        maxAttempts,
        error,
        diagnosis,
        approvalId: approval.id,
        outcome: 'retry_awaiting_approval',
      });
      await this.host.persistRun(ctx);
      this.host.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_WAITING_FOR_INPUT, {
        runId: ctx.runId,
        nodeId: node.id,
        reason: 'self_heal_retry_approval',
        detail: diagnosis,
        approvalId: approval.id,
      });
      await this.host.deps.ledger.append({
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId,
        runId: ctx.runId,
        eventType: 'self_heal.retry_approval_requested',
        nodeId: node.id,
        payload: { approvalId: approval.id, diagnosis, attempt, maxAttempts },
      }).catch(() => {});
      this.host.audit(ctx, { nodeId: node.id, action: 'self_heal.retry_approval_requested', actorType: 'system', actorId: 'engine', outputSummary: diagnosis });
      return true;
    } catch (err) {
      this.host.deps.logger.warn('engine.self_heal.retry_approval_failed', { runId: ctx.runId, nodeId: node.id, error: (err as Error).message });
      return false;
    }
  }

  async tryLegacyAgentTaskSelfHealRetry(ctx: RunningContext, node: WorkflowNode, error: string): Promise<boolean> {
    if (node.config.kind !== 'agent_task' || !node.config.retryPolicy?.selfHeal) return false;
    const max = node.config.retryPolicy.maxSelfHealAttempts ?? 2;
    const attempts = selfHealAttemptCount(ctx, node.id);
    if (attempts >= max) return false;
    const nextAttempt = recordSelfHealAttempt(ctx, node.id);
    await this.host.persistRun(ctx).catch(() => {});
    this.host.deps.logger.info('engine.self_heal.retry', {
      runId: ctx.runId,
      nodeId: node.id,
      attempt: nextAttempt,
      max,
    });
    this.host.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_RETRY_SCHEDULED, {
      runId: ctx.runId,
      nodeId: node.id,
      attempt: nextAttempt,
      reason: 'self_heal',
    });
    const inputData = ctx.state.nodeStates[node.id]?.inputData ?? {};
    const healConfig: AgentTaskNodeConfig = {
      ...node.config,
      prompt:
        `${node.config.prompt}\n\n---\nPREVIOUS ATTEMPT FAILED (attempt ${nextAttempt}/${max}).\n` +
        `Error: ${error}\nAnalyse the error and correct your output.`,
    };
    await this.host.dispatchAgentTask(ctx, node, healConfig, inputData);
    return true;
  }

  reflectHardNodeFailure(ctx: RunningContext, node: WorkflowNode, error: string): void {
    if (node.config.kind !== 'agent_task') return;
    if (this.host.deps.failureReflection) {
      const agentId = ctx.state.activeExecutions[node.id]?.executorRef ?? node.config.agentId;
      if (agentId) {
        this.host.deps.failureReflection.reflect({
          workspaceId: ctx.workspaceId,
          agentId,
          runId: ctx.runId,
          nodeTitle: node.title,
          prompt: node.config.prompt,
          error,
        });
      }
    }

    // Phase 4 - Feynman repair loop. We reach here when an agent_task has hard-
    // failed (self-heal disabled or exhausted). Record the failure for cross-run
    // counting, and enqueue a grounded reflection only when self-heal exhausted
    // or the same node keeps failing.
    if (this.host.deps.feynmanReflection && this.host.deps.brainQueue) {
      try {
        const fr = this.host.deps.feynmanReflection;
        const max = node.config.retryPolicy?.maxSelfHealAttempts ?? 2;
        const selfHealExhausted = Boolean(node.config.retryPolicy?.selfHeal)
          && selfHealAttemptCount(ctx, node.id) >= max;
        const agentId = ctx.state.activeExecutions[node.id]?.executorRef ?? node.config.agentId ?? null;
        const failureCount = fr.recordFailure({
          workspaceId: ctx.workspaceId,
          workflowId: ctx.workflowId,
          nodeId: node.id,
          runId: ctx.runId,
          agentId,
        });
        const trigger: FeynmanTrigger | null = selfHealExhausted
          ? 'self_heal_exhausted'
          : failureCount >= REPEAT_FAILURE_THRESHOLD
            ? 'repeated_failure'
            : null;
        if (trigger) {
          const inputData = ctx.state.nodeStates[node.id]?.inputData ?? null;
          this.host.deps.brainQueue.enqueue({
            workspaceId: ctx.workspaceId,
            itemType: 'feynman_reflection',
            priority: 'normal',
            payload: {
              workspaceId: ctx.workspaceId,
              runId: ctx.runId,
              workflowId: ctx.workflowId,
              nodeId: node.id,
              nodeTitle: node.title,
              agentId,
              scopeId: agentId,
              prompt: node.config.prompt,
              error,
              observations: inputData ? JSON.stringify(inputData).slice(0, 800) : null,
              trigger,
            },
          });
          this.host.deps.logger.info('engine.feynman.enqueued', { runId: ctx.runId, nodeId: node.id, trigger, failureCount });
        }
      } catch (err) {
        this.host.deps.logger.warn('engine.feynman.enqueue_failed', { runId: ctx.runId, nodeId: node.id, err: (err as Error).message });
      }
    }
  }
}
