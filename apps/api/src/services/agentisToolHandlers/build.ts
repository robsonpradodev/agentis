/**
 * Build tools — agent creates and patches workflows.
 *
 * Mutating; gated by the runtime policy engine in production deployments.
 */

import { createHash, randomUUID } from 'node:crypto';
import { and, eq, or, sql } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import {
  AgentisError,
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  agentSatisfiesRequirements,
  createAppSchema,
  isAgentRole,
  isSpecialistRole,
  layoutWorkflowGraph,
  layoutWorkflowGraphByPhases,
  normalizeAgentRequirements,
  repairWorkflowGraphIdentity,
  requiredAffordanceKeys,
  suggestWorkflowPhases,
} from '@agentis/core';
import type { AgentAdapter, AgentRequirements, ExtensionManifest, RealtimeEventName, WorkflowGraph, WorkflowGraphPatch, WorkflowNode } from '@agentis/core';
import { AppStore } from '@agentis/app';
import { AppStaffingService } from '../app/appStaffing.js';
import { WORKFLOW_DESIGN_DOCTRINE } from '../workflow/workflowDesignDoctrine.js';
import { auditWorkflowRobustness } from '../workflow/workflowRobustnessAudit.js';
import { WORKFLOW_PATTERNS, getWorkflowPattern } from '../workflow/workflowPatterns.js';
import { recordWorkflowLesson, recallWorkflowLessons, renderPlaybookLessons } from '../workflow/workflowPlaybook.js';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { validateWorkflowGraph } from '../../engine/validateGraph.js';
import { evalCondition } from '../../engine/SafeConditionParser.js';
import { repairGraphExpressions, dryRunGraphExpressions, analyzeInputReachability, analyzeEdgeCouplings } from '../../engine/validateExpressions.js';
import { deriveIntentManifest, checkIntentIntegrity, type IntentManifest } from '../intentContract.js';
import { PackagerService } from '../packager.js';
import { assembleCreationBrief, preflightAndEnrich, buildTeamRoster, planWorkflow, type CreationBrief, type WorkflowPlan, type PreflightWarning } from '../creationPipeline.js';
import { AdapterStructuredCompleter, type StructuredCompleter } from '../structuredCompleter.js';
import { analyzeWorkflowReadiness } from '../workflow/workflowReadiness.js';
import { preflightWorkflow } from '../workflow/workflowPreflight.js';
import { listIntegrationManifests } from '../integrationRegistry.js';
import { repairIntegrationOperations } from '../integrationOperationRepair.js';
import { scheduleFromNaturalLanguage } from '../scheduleFromNaturalLanguage.js';
import {
  LOOP_STAGE_LABEL,
  compassForRun,
  compassForWorkflow,
  deriveLoopStage,
  graphContentHash,
  readBuildLoop,
  stampBuildLoop,
} from '../workflow/workflowCompass.js';
import { deriveSpecDraft, readWorkflowSpec, validateWorkflowSpec, type WorkflowSpec } from '../workflow/workflowSpec.js';
import { unwrapReturnEnvelope } from '../workflow/workflowVerdict.js';
import { deliverWorkflow } from '../workflow/workflowDeliveryOrchestrator.js';
import { generateEdgeCases, readWorkflowTests, type WorkflowTestCase } from '../workflow/workflowTestGenerator.js';
import { connectorCatalog } from '@agentis/integrations';
import { stringify as yamlStringify } from 'yaml';
import { WORKFLOW_FILE_API_VERSION, type WorkflowFile } from '@agentis/core';
import { hashWorkflowGraph } from '../graphHash.js';
import {
  applyLegacyWorkflowPatchDraft,
  applyWorkflowGraphOperations,
  diffWorkflowGraphs,
  WorkflowGraphMutationError,
  type WorkflowGraphMutationDiff,
} from '../workflow/workflowGraphMutation.js';
import { WorkflowRevisionService } from '../workflow/workflowRevisionService.js';

/**
 * Conversation → last-built workflow id. A build conversation is bound to ONE
 * workflow: when the operator asks to refine it ("make it run hourly"), the
 * revision must UPDATE that graph, not spawn a twin. The orchestrator doesn't
 * always thread the id back, so we latch it server-side per conversation and
 * reuse it unless the caller explicitly asks for a new workflow. Bounded LRU so
 * a long-lived process doesn't grow unbounded.
 */
const lastWorkflowByConversation = new Map<string, string>();
const CONVERSATION_LATCH_LIMIT = 500;
function rememberConversationWorkflow(key: string, workflowId: string): void {
  lastWorkflowByConversation.delete(key);
  lastWorkflowByConversation.set(key, workflowId);
  if (lastWorkflowByConversation.size > CONVERSATION_LATCH_LIMIT) {
    const oldest = lastWorkflowByConversation.keys().next().value;
    if (oldest !== undefined) lastWorkflowByConversation.delete(oldest);
  }
}

/** Services a spec's data_probe / allowedServices may reference: runnable
 *  connectors + mounted MCP server slugs (both plain and `mcp:` forms). */
async function runnableServicesForSpec(deps: ToolHandlerDeps, workspaceId: string): Promise<string[]> {
  const services = connectorCatalog().filter((c) => c.readiness === 'runnable').map((c) => c.service);
  try {
    const bridged = await deps.mcpBridge?.listTools(workspaceId) ?? [];
    const slugs = new Set<string>();
    for (const tool of bridged) {
      const slug = tool.id.match(/^mcp__(.+?)__/u)?.[1];
      if (slug) { slugs.add(slug); slugs.add(`mcp:${slug}`); }
    }
    return [...new Set([...services, ...slugs])];
  } catch {
    return services;
  }
}

/**
 * SWIFT-I — run one suite case through the free dry-run engine and judge it:
 * preflight not blocked + case assertions + (when a spec exists) its expr
 * checks and sufficiency floors against the terminal trace output. World
 * probes/judge are deliberately deferred to the debug run — a suite run must
 * stay free and side-effect-less.
 */
function runSuiteCase(
  deps: ToolHandlerDeps,
  workspaceId: string,
  workflowId: string,
  graph: WorkflowGraph,
  testCase: WorkflowTestCase,
  spec: WorkflowSpec | null,
): { id: string; name: string; kind: string; gating: boolean; passed: boolean; detail: string } {
  const base = { id: testCase.id, name: testCase.name, kind: testCase.kind, gating: testCase.origin !== 'generated' };
  try {
    const report = preflightWorkflow({ db: deps.db, workspaceId, workflowId, graph, inputs: testCase.inputs, mode: 'canvas' });
    const failures: string[] = [];
    const blocking = report.issues.filter((i) => i.severity === 'error');

    // Terminal output = the declared output surface of the dry trace.
    const outputNodes = graph.nodes.filter((n) => {
      const cfg = n.config as { kind?: string; isOutput?: boolean };
      return cfg.kind === 'return_output' || cfg.isOutput === true;
    });
    const terminal: Record<string, unknown> = {};
    const surface = outputNodes.length > 0 ? outputNodes : graph.nodes.slice(-1);
    for (const n of surface) {
      const out = report.nodes[n.id]?.output;
      // return_output wraps data in a viewer envelope — checks target the payload.
      if (out && typeof out === 'object' && !Array.isArray(out)) Object.assign(terminal, unwrapReturnEnvelope(out as Record<string, unknown>));
    }
    const nodesMap = Object.fromEntries(graph.nodes.map((n) => [n.id, report.nodes[n.id]?.output ?? {}]));

    for (const a of testCase.assertions) {
      const entry = report.nodes[a.nodeId];
      if (!entry) { failures.push(`assertion node "${a.nodeId}" not in trace`); continue; }
      try {
        const passed = evalCondition(a.expr, { input: entry.input ?? {}, inputs: entry.input ?? {}, output: entry.output ?? {}, nodes: nodesMap, trigger: report.scenario.input });
        if (!passed) failures.push(a.message ?? `assertion failed: ${a.expr}`);
      } catch (err) {
        failures.push(`assertion error (${a.expr}): ${(err as Error).message}`);
      }
    }

    let dryVerdict: 'accomplished' | 'failed_checks' | 'hollow' = 'accomplished';
    if (spec) {
      for (const check of spec.acceptance) {
        if (check.verify !== 'expr') continue; // probes/judge deferred to the debug run
        try {
          if (!evalCondition(check.expr, { output: terminal, trigger: report.scenario.input, nodes: nodesMap, probe: {} })) {
            dryVerdict = 'failed_checks';
            failures.push(`acceptance "${check.claim}" failed dry (${check.expr})`);
          }
        } catch { /* expr over mocked shapes may legitimately not resolve dry */ }
      }
      for (const floor of spec.sufficiency ?? []) {
        const value = terminal[floor.key];
        const empty = value === undefined || value === null
          || (typeof value === 'string' && value.trim() === '')
          || (Array.isArray(value) && value.length === 0);
        // A hollow floor is a real, fixable defect — emit the EVIDENCE (which key,
        // what was required, what the terminal actually produced) instead of the
        // bare enum "dry verdict hollow" the agent could do nothing with (§F6).
        if (floor.nonEmpty && empty && dryVerdict === 'accomplished') {
          dryVerdict = 'hollow';
          const got = value === undefined ? 'undefined' : value === null ? 'null' : Array.isArray(value) ? 'an empty array' : 'an empty string';
          failures.push(`sufficiency floor '${floor.key}' must be non-empty but the terminal output produced ${got} — make the node that fills '${floor.key}' return real content.`);
        }
        if (floor.minItems !== undefined && Array.isArray(value) && value.length < floor.minItems && dryVerdict === 'accomplished') {
          dryVerdict = 'hollow';
          failures.push(`sufficiency floor '${floor.key}' has ${value.length} item(s) but needs at least ${floor.minItems} — the producing node returned too few.`);
        }
      }
    }

    // Expected-outcome comparison: adversarial cases EXPECT graceful failure.
    if (testCase.expectOutcome?.verdict) {
      const expectation = testCase.expectOutcome.verdict;
      const matched = expectation === dryVerdict
        || (expectation === 'failed_checks' && blocking.length > 0)
        || (expectation === 'partial'); // not derivable dry — never gate on it
      if (!matched) {
        return { ...base, passed: false, detail: `expected ${expectation}, dry outcome was ${blocking.length > 0 ? 'blocked' : dryVerdict}` };
      }
      // An expected failure that failed as expected PASSES the case.
      return { ...base, passed: true, detail: `behaved as expected (${expectation})` };
    }

    if (blocking.length > 0) return { ...base, passed: false, detail: `blocked: ${blocking[0]!.message}` };
    if (failures.length > 0) return { ...base, passed: false, detail: failures.slice(0, 3).join('; ') };
    if (dryVerdict !== 'accomplished') return { ...base, passed: false, detail: `dry verdict ${dryVerdict} — the workflow ran but did not produce sufficient output (see the workflow's sufficiency floors).` };
    return { ...base, passed: true, detail: 'ok' };
  } catch (err) {
    return { ...base, passed: false, detail: `case crashed: ${(err as Error).message}` };
  }
}

function buildWorkflowLatchKey(ctx: { workspaceId: string; userId: string; agentId?: string; conversationId?: string | null }): string | null {
  if (ctx.conversationId) return `${ctx.workspaceId}:conversation:${ctx.conversationId}`;
  if (ctx.agentId) return `${ctx.workspaceId}:user:${ctx.userId}:agent:${ctx.agentId}`;
  return `${ctx.workspaceId}:user:${ctx.userId}:mcp`;
}

/**
 * Cross-caller duplicate-build guard. The per-conversation latch above stops a
 * twin within ONE conversation, but the SAME request can reach the build core
 * twice through DIFFERENT latch keys it can't span — a retried/duplicated chat
 * turn, or a chat build racing an mcp_native harness building over MCP. This
 * workspace-level, content-addressed window catches those: a repeat of the same
 * request within {@link RECENT_BUILD_WINDOW_MS} reuses the workflow it just made
 * (update in place) instead of inserting a near-identical twin. Keyed on the
 * normalized description, so genuinely different requests never collapse.
 */
const RECENT_BUILD_WINDOW_MS = 45_000;
const RECENT_BUILD_LIMIT = 500;
const recentBuildByRequest = new Map<string, { workflowId: string; at: number }>();

function recentBuildKey(workspaceId: string, description: string): string {
  return `${workspaceId}::${description.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 240)}`;
}

/** The id of a workflow built for the SAME request moments ago and still present,
 *  or null. Prunes the stale/missing entry so it can't resurrect a deleted id. */
function recentDuplicateWorkflowId(deps: ToolHandlerDeps, workspaceId: string, description: string): string | null {
  const key = recentBuildKey(workspaceId, description);
  const hit = recentBuildByRequest.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at >= RECENT_BUILD_WINDOW_MS) {
    recentBuildByRequest.delete(key);
    return null;
  }
  const exists = deps.db
    .select({ id: schema.workflows.id })
    .from(schema.workflows)
    .where(and(eq(schema.workflows.id, hit.workflowId), eq(schema.workflows.workspaceId, workspaceId)))
    .get();
  if (!exists) {
    recentBuildByRequest.delete(key);
    return null;
  }
  return hit.workflowId;
}

function rememberRecentBuild(workspaceId: string, description: string, workflowId: string): void {
  const key = recentBuildKey(workspaceId, description);
  recentBuildByRequest.delete(key);
  recentBuildByRequest.set(key, { workflowId, at: Date.now() });
  if (recentBuildByRequest.size > RECENT_BUILD_LIMIT) {
    const oldest = recentBuildByRequest.keys().next().value;
    if (oldest !== undefined) recentBuildByRequest.delete(oldest);
  }
}

/**
 * Build cost circuit breaker. Each `build_workflow` call fans out to several
 * model calls (synthesis ≤2 + reviewer 2 rounds), so an unbounded caller — a
 * client retry storm, the model double-calling the tool, or an mcp_native
 * orchestrator whose tool calls bypass the chat loop's per-turn cap — can drain
 * an account's model credits in seconds. This bounds spend at the tool boundary,
 * where EVERY caller (chat loop, MCP, direct fast-path) converges:
 *   • at most ONE build in flight per conversation — kills the duplicate
 *     concurrent rebuilds that retries cause (the most common runaway), and
 *   • at most N builds per workspace per rolling minute — a hard spend ceiling.
 * Tripping it throws FAST, before a single model call is made. Process-local
 * (same scope as the conversation latch above); a clustered deploy must front
 * builds with a shared limiter.
 */
const BUILD_WINDOW_MS = 60_000;
function buildBudgetPerWindow(): number {
  const max = Number(process.env.AGENTIS_BUILD_MAX_PER_MINUTE);
  return Number.isFinite(max) && max > 0 ? Math.floor(max) : 8;
}
const buildsInFlightByKey = new Map<string, number>();
const buildStartsByWorkspace = new Map<string, number[]>();

function acquireBuildSlot(workspaceId: string, latchKey: string | null): () => void {
  const key = latchKey ?? `${workspaceId}:anon`;
  // 1) One concurrent build per conversation — blocks duplicate rebuilds.
  if ((buildsInFlightByKey.get(key) ?? 0) >= 1) {
    throw new AgentisError(
      'OPERATION_RATE_LIMITED',
      'A workflow build for this conversation is already running. I won’t start a duplicate build — that would spend model credits twice. Wait for the current one to finish, then refine it.',
      { details: { reason: 'build_in_flight' }, remediation: 'Wait for the in-flight build to complete, then ask again.' },
    );
  }
  // 2) Rolling per-workspace ceiling — a hard cap on build spend.
  const now = Date.now();
  const recent = (buildStartsByWorkspace.get(workspaceId) ?? []).filter((t) => now - t < BUILD_WINDOW_MS);
  const limit = buildBudgetPerWindow();
  if (recent.length >= limit) {
    throw new AgentisError(
      'OPERATION_RATE_LIMITED',
      `Too many workflow builds in a short time (${recent.length} in the last minute). Pausing to protect your model credits — try again in a moment.`,
      { details: { reason: 'build_rate_limited', limit, windowMs: BUILD_WINDOW_MS }, remediation: `Wait up to a minute, then build again. Raise AGENTIS_BUILD_MAX_PER_MINUTE (currently ${limit}) for legitimate batches.` },
    );
  }
  // Reserve synchronously — no await between check and reserve — so two parallel
  // tool calls in a single batch can't both pass the concurrency gate.
  recent.push(now);
  buildStartsByWorkspace.set(workspaceId, recent);
  buildsInFlightByKey.set(key, (buildsInFlightByKey.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (buildsInFlightByKey.get(key) ?? 1) - 1;
    if (remaining <= 0) buildsInFlightByKey.delete(key);
    else buildsInFlightByKey.set(key, remaining);
  };
}

export function registerBuildTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  deps = { ...deps, revisions: deps.revisions ?? new WorkflowRevisionService(deps.db) };
  type StoredWorkflow = typeof schema.workflows.$inferSelect;
  type StoredGraphRevision = {
    hash: string;
    replacedByHash: string;
    graph: WorkflowGraph;
    createdAt: string;
    operation: 'replace' | 'patch' | 'rollback';
    actorId?: string;
  };
  const GRAPH_REVISION_HISTORY_KEY = 'workflowGraphRevisionHistory';
  const GRAPH_REVISION_HISTORY_LIMIT = 20;

  const readGraphRevisionHistory = (settings: unknown): StoredGraphRevision[] => {
    if (!settings || typeof settings !== 'object') return [];
    const value = (settings as Record<string, unknown>)[GRAPH_REVISION_HISTORY_KEY];
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is StoredGraphRevision => {
      if (!entry || typeof entry !== 'object') return false;
      const row = entry as Partial<StoredGraphRevision>;
      return typeof row.hash === 'string'
        && typeof row.replacedByHash === 'string'
        && typeof row.createdAt === 'string'
        && (row.operation === 'replace' || row.operation === 'patch' || row.operation === 'rollback')
        && Boolean(row.graph && typeof row.graph === 'object');
    });
  };

  const loadStoredWorkflow = (workflowId: unknown, workspaceId: string): StoredWorkflow => {
    const wf = deps.db.select().from(schema.workflows).where(eq(schema.workflows.id, String(workflowId))).get();
    if (!wf || wf.workspaceId !== workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow ${String(workflowId)} not found`);
    const candidate = deps.revisions?.candidate(workspaceId, wf.id);
    return candidate
      ? { ...wf, graph: candidate.graph, contentHash: candidate.revision.semanticHash }
      : wf;
  };

  const editableGraph = (wf: Pick<StoredWorkflow, 'id' | 'graph'>, workspaceId: string): WorkflowGraph =>
    deps.revisions?.candidate(workspaceId, wf.id)?.graph ?? (wf.graph as WorkflowGraph);

  const validateStoredMutation = (
    wf: StoredWorkflow,
    candidate: WorkflowGraph,
    confirmIntentChange: boolean,
  ): void => {
    validateWorkflowGraph(candidate);
    const priorGraph = wf.graph as WorkflowGraph;
    const priorIntent = (wf.settings as { intentManifest?: IntentManifest } | null)?.intentManifest ?? null;
    const violations = checkIntentIntegrity(candidate, priorIntent);
    const approvalBypass = violations.filter((v) => v.code === 'AUTO_APPROVAL_BYPASS');
    if (approvalBypass.length > 0) {
      throw new AgentisError('WORKFLOW_DRAFT_INVALID',
        `Rejected (approval integrity): ${approvalBypass.map((v) => v.message).slice(0, 2).join(' | ')}`);
    }
    const capabilityRemoved = violations.filter((v) => v.code === 'CAPABILITY_REMOVED');
    if (capabilityRemoved.length > 0 && !confirmIntentChange) {
      throw new AgentisError('WORKFLOW_DRAFT_INVALID',
        `Rejected (this mutation hollows out the workflow): ${capabilityRemoved.map((v) => v.message).slice(0, 2).join(' | ')} `
        + 'If this intent change is deliberate, retry with confirmIntentChange: true.');
    }
    const introduced = introducedRegressions(priorGraph, candidate);
    if (introduced.length > 0) {
      throw new AgentisError('WORKFLOW_DRAFT_INVALID',
        `This mutation would REGRESS the workflow (green ratchet): it introduces ${introduced.length} critical issue(s) the prior graph did not have — `
        + `${introduced.slice(0, 3).join(' | ')}. The workflow was NOT changed; fix the mutation and retry.`);
    }
  };

  const commitStoredMutation = (input: {
    wf: StoredWorkflow;
    graph: WorkflowGraph;
    diff: WorkflowGraphMutationDiff;
    baseHash?: unknown;
    baseUpdatedAt?: unknown;
    dryRun?: boolean;
    operation: 'replace' | 'patch' | 'rollback';
    deprecatedAlias?: boolean;
    actorId?: string;
  }) => {
    const beforeHash = hashWorkflowGraph(input.wf.graph as WorkflowGraph);
    if (input.baseHash !== undefined && String(input.baseHash) !== beforeHash) {
      throw new AgentisError('GRAPH_REVISION_CONFLICT',
        `Workflow changed since inspection: expected graph hash ${String(input.baseHash)}, current hash is ${beforeHash}. Inspect the workflow and rebase the mutation; do not retry the stale payload.`);
    }
    if (input.baseUpdatedAt !== undefined && String(input.baseUpdatedAt) !== input.wf.updatedAt) {
      throw new AgentisError('GRAPH_REVISION_CONFLICT',
        `Workflow changed since inspection: expected updatedAt ${String(input.baseUpdatedAt)}, current value is ${input.wf.updatedAt}. Inspect and rebase the mutation.`);
    }
    const afterHash = hashWorkflowGraph(input.graph);
    const revision = { beforeHash, afterHash, basedOnUpdatedAt: input.wf.updatedAt };
    if (input.dryRun) {
      return { workflowId: input.wf.id, operation: input.operation, committed: false, preview: true, revision, diff: input.diff };
    }

    const now = new Date().toISOString();
    if (!deps.revisions) {
      throw new AgentisError('WORKFLOW_DRAFT_INVALID', 'Immutable workflow revision service is unavailable.');
    }
    const revisionHead = deps.revisions.candidate(input.wf.workspaceId, input.wf.id)?.revision
      ?? deps.revisions.active(input.wf.workspaceId, input.wf.id).revision;
    const created = deps.revisions.createCandidate({
      workspaceId: input.wf.workspaceId,
      workflowId: input.wf.id,
      graph: input.graph,
      baseRevisionId: revisionHead.id,
      source: input.operation === 'rollback' ? 'rollback' : 'agent_build',
      actor: { type: input.actorId ? 'agent' : 'system', id: input.actorId ?? null },
      reason: `${input.operation} proposed through workflow graph tools`,
    });
    const buildLoop = stampBuildLoop(deps.db, input.wf.id, {
      graphHash: graphContentHash(input.graph),
      validatedAt: new Date().toISOString(),
    });
    const saved = deps.db.select({ updatedAt: schema.workflows.updatedAt }).from(schema.workflows).where(eq(schema.workflows.id, input.wf.id)).get();
    return {
      workflowId: input.wf.id,
      operation: input.operation,
      committed: true,
      patched: false,
      candidate: true,
      candidateRevisionId: created.revision.id,
      activeRevisionId: deps.revisions.active(input.wf.workspaceId, input.wf.id).revision.id,
      revision: { ...revision, updatedAt: saved?.updatedAt ?? now },
      diff: input.diff,
      ...(input.deprecatedAlias ? {
        deprecation: {
          tool: 'agentis.workflow.patch',
          replacement: input.operation === 'replace' ? 'agentis.workflow.graph.replace' : 'agentis.workflow.graph.patch',
        },
      } : {}),
      selfHealInFlight: deps.engine.isSelfHealInFlight(input.wf.id),
      compass: compassForWorkflow({ workflowId: input.wf.id, graph: input.graph, settings: { buildLoop } }),
      next: {
        tool: 'agentis.workflow.deliver',
        args: { workflowId: input.wf.id },
        why: 'Required continuation: finish, verify, repair, and publish this workflow before replying to the user.',
      },
    };
  };

  registry.registerMany([
    {
      definition: {
        id: 'agentis.workflow.draft_contract',
        family: 'inspect',
        description: 'Return the public WorkflowBuildRequest contract, a minimal valid draft, and deterministic graph-repair rules. Use before authoring graphDraft; description-only build requests are also supported.',
        inputSchema: { type: 'object', properties: {} },
        mutating: false,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: async () => ({
        contract: {
          required: ['description'],
          optional: ['title', 'workflowId', 'appId', 'trigger', 'graphDraft', 'patchDraft'],
          graphDraft: '{ version: 1, nodes: WorkflowNode[], edges: WorkflowEdge[], viewport: { x, y, zoom } }',
          edgeRepair: 'Missing or duplicate edge ids are assigned stable ids. Endpoint and node-contract errors are returned as WORKFLOW_DRAFT_INVALID.',
        },
        minimalDraft: {
          version: 1,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [
            { id: 'trigger', type: 'trigger', title: 'Manual trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
            { id: 'output', type: 'return_output', title: 'Return output', position: { x: 280, y: 0 }, config: { kind: 'return_output', renderAs: 'text' } },
          ],
          edges: [{ id: 'trigger-output', source: 'trigger', target: 'output' }],
        },
      }),
    },
    {
      definition: {
        id: 'agentis.workflow.create',
        family: 'build',
        description:
          'AUTHORING STEP ONLY — never present its result as a completed user request. Create a new workflow from a complete graph payload, then immediately call agentis.workflow.deliver with the returned workflowId. Alias of agentis.build_workflow with graphDraft: '
          + 'the graph passes the SAME gates (structural validation, expression lint, edge couplings, intent manifest, '
          + 'robustness audit + deterministic repairs) — there is no ungated door. Prefer agentis.build_workflow directly.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            graph: { type: 'object' },
          },
          required: ['name', 'graph'],
        },
        mutating: true,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        // PAVED-ROAD P0 (one door): this used to insert the graph RAW — no
        // strict validation, no coupling analysis, no intent manifest — a
        // contract-bypass sitting beside build_workflow with a plausibler name.
        // It now delegates to the same gated pipeline; same result contract.
        const result = await createWorkflowFromDescription(deps, {
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId ?? null,
          userId: ctx.userId,
          agentId: ctx.agentId,
          runId: ctx.runId,
          description: args.description ? String(args.description) : String(args.name),
          title: String(args.name),
          workflowId: null,
          graphDraft: args.graph,
          stream: false,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        // Preserve this tool's historical contract: the App is born staffed.
        if (deps.specialists && result.appId) {
          try {
            const store = new AppStore(deps.db);
            const staffing = new AppStaffingService({
              store,
              specialists: deps.specialists,
              logger: deps.logger,
              commissionSpecialist: (workspaceId, agentId) => connectSpecialistRuntime(deps, workspaceId, agentId),
            });
            await staffing.staffApp({
              workspaceId: ctx.workspaceId,
              userId: ctx.userId,
              appId: result.appId,
              name: result.title,
              description: args.description ? String(args.description) : '',
            });
          } catch {
            /* staffing is best-effort — never fail the build over it */
          }
        }
        return {
          workflowId: result.workflowId,
          appId: result.appId,
          title: result.title,
          warnings: 'warnings' in result ? result.warnings : [],
          // SWIFT: surface the auto-derived acceptance so the agent SEES the
          // workflow is verified-by-default, not merely "built".
          ...('acceptance' in result && result.acceptance ? { acceptance: result.acceptance } : {}),
          compass: result.compass,
          message: result.message,
        };
      },
    },
    {
      definition: {
        id: 'agentis.workflow.patch',
        family: 'build',
        description:
          'DEPRECATED compatibility alias. Stored workflowId + complete graph routes to agentis.workflow.graph.replace; runId + patch routes to agentis.run.graph.evolve. ' +
          'For a true field-level stored edit use agentis.workflow.graph.patch. New callers should use the explicit tools so replacement, stored patching, and live evolution cannot be confused.',
        inputSchema: {
          type: 'object',
          properties: {
            workflowId: { type: 'string' },
            runId: { type: 'string' },
            patch: { type: 'object' },
            graph: { type: 'object' },
            baseHash: { type: 'string', description: 'Optional SHA-256 graph hash from the last inspection.' },
            baseUpdatedAt: { type: 'string', description: 'Optional updatedAt token from the last inspection.' },
            confirmIntentChange: {
              type: 'boolean',
              description: 'Acknowledge a DELIBERATE capability change — required when the replacement graph drops load-bearing work (agent workers / fetch steps / integrations / persistence).',
            },
          },
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        if (args.runId && args.patch) {
          const run = deps.db
            .select()
            .from(schema.workflowRuns)
            .where(eq(schema.workflowRuns.id, String(args.runId)))
            .get();
          if (!run || run.workspaceId !== ctx.workspaceId) throw new Error(`run ${args.runId} not found`);
          // AGENT-PRIMARY M2 — a live-run patch from an agent (in-process or an MCP
          // harness) goes through the contract transaction, not raw applyGraphPatch.
          const result = await deps.engine.evolveGraph({
            runId: run.id,
            patch: args.patch as WorkflowGraphPatch,
            actorId: (ctx as { agentId?: string }).agentId,
          });
          return { runId: run.id, ...result, deprecation: { tool: 'agentis.workflow.patch', replacement: 'agentis.run.graph.evolve' } };
        }

        if (!args.workflowId || !args.graph) {
          throw new AgentisError(
            'VALIDATION_FAILED',
            'workflow.patch is deprecated. Use agentis.workflow.graph.replace with workflowId + complete graph, ' +
            'agentis.workflow.graph.patch with workflowId + field-level operations, or agentis.run.graph.evolve with runId + patch for a live run.',
          );
        }
        const wf = loadStoredWorkflow(args.workflowId, ctx.workspaceId);
        const graph = layoutBuiltWorkflowGraph(args.graph as WorkflowGraph, { existingWorkflow: false });
        validateStoredMutation(wf, graph, args.confirmIntentChange === true);
        return commitStoredMutation({
          wf, graph,
          diff: diffWorkflowGraphs(wf.graph as WorkflowGraph, graph),
          baseHash: args.baseHash,
          baseUpdatedAt: args.baseUpdatedAt,
          operation: 'replace',
          deprecatedAlias: true,
          actorId: ctx.agentId ?? ctx.userId,
        });
      },
    },
    {
      definition: {
        id: 'agentis.workflow.graph.replace',
        family: 'build',
        description:
          'AUTHORING STEP ONLY: after committing, immediately call agentis.workflow.deliver and do not reply to the user with an intermediate revision state. Atomically replace a STORED workflow with a complete graph. This is intentionally whole-graph; use agentis.workflow.graph.patch for field-level edits. ' +
          'Pass baseHash or baseUpdatedAt from inspection to reject stale writes. Returns a structured graph diff and before/after revision hashes.',
        inputSchema: {
          type: 'object',
          properties: {
            workflowId: { type: 'string' }, graph: { type: 'object', description: 'Complete replacement WorkflowGraph.' },
            baseHash: { type: 'string' }, baseUpdatedAt: { type: 'string' }, dryRun: { type: 'boolean' }, confirmIntentChange: { type: 'boolean' },
          },
          required: ['workflowId', 'graph'],
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const wf = loadStoredWorkflow(args.workflowId, ctx.workspaceId);
        const graph = layoutBuiltWorkflowGraph(args.graph as WorkflowGraph, { existingWorkflow: false });
        validateStoredMutation(wf, graph, args.confirmIntentChange === true);
        return commitStoredMutation({
          wf, graph,
          diff: diffWorkflowGraphs(wf.graph as WorkflowGraph, graph),
          baseHash: args.baseHash, baseUpdatedAt: args.baseUpdatedAt,
          dryRun: args.dryRun === true, operation: 'replace',
          actorId: ctx.agentId ?? ctx.userId,
        });
      },
    },
    {
      definition: {
        id: 'agentis.workflow.graph.patch',
        family: 'build',
        description:
          'AUTHORING STEP ONLY: after committing, immediately call agentis.workflow.deliver and do not reply to the user with an intermediate revision state. Atomically patch selected fields or structure of a STORED workflow without restating complete nodes or the graph. ' +
          'Supported operations: add_node, patch_node, remove_node, add_edge, patch_edge, remove_edge, patch_viewport. Object patches merge recursively; omitted fields are preserved. ' +
          'Pass baseHash or baseUpdatedAt from inspection to reject stale writes. Returns exact changed paths and before/after revision hashes.',
        inputSchema: {
          type: 'object',
          properties: {
            workflowId: { type: 'string' }, operations: { type: 'array', items: { type: 'object' } },
            baseHash: { type: 'string' }, baseUpdatedAt: { type: 'string' }, dryRun: { type: 'boolean' }, confirmIntentChange: { type: 'boolean' },
          },
          required: ['workflowId', 'operations'],
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const wf = loadStoredWorkflow(args.workflowId, ctx.workspaceId);
        let mutation: ReturnType<typeof applyWorkflowGraphOperations>;
        try {
          mutation = applyWorkflowGraphOperations(wf.graph as WorkflowGraph, args.operations);
        } catch (error) {
          if (error instanceof WorkflowGraphMutationError) throw new AgentisError('WORKFLOW_DRAFT_INVALID', error.message);
          throw error;
        }
        validateStoredMutation(wf, mutation.graph, args.confirmIntentChange === true);
        return commitStoredMutation({
          wf, graph: mutation.graph, diff: mutation.diff,
          baseHash: args.baseHash, baseUpdatedAt: args.baseUpdatedAt,
          dryRun: args.dryRun === true, operation: 'patch',
          actorId: ctx.agentId ?? ctx.userId,
        });
      },
    },
    {
      definition: {
        id: 'agentis.workflow.graph.revisions',
        family: 'inspect',
        description:
          'List the bounded durable revision history for a stored workflow. Graph snapshots are retained server-side; the response exposes hashes and metadata so callers can choose an explicit rollback target.',
        inputSchema: {
          type: 'object', properties: { workflowId: { type: 'string' } }, required: ['workflowId'],
        },
        mutating: false,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const wf = loadStoredWorkflow(args.workflowId, ctx.workspaceId);
        if (!deps.revisions) throw new AgentisError('WORKFLOW_DRAFT_INVALID', 'Immutable workflow revision service is unavailable.');
        const active = deps.revisions.active(ctx.workspaceId, wf.id);
        const candidate = deps.revisions.candidate(ctx.workspaceId, wf.id);
        return {
          workflowId: wf.id,
          current: {
            activeRevisionId: active.revision.id,
            activeHash: active.revision.semanticHash,
            candidateRevisionId: candidate?.revision.id ?? null,
            candidateHash: candidate?.revision.semanticHash ?? null,
            updatedAt: wf.updatedAt,
          },
          revisions: deps.revisions.revisions(ctx.workspaceId, wf.id).map((revision) => ({
            id: revision.id,
            hash: revision.semanticHash,
            source: revision.source,
            reason: revision.reason,
            status: revision.status,
            trustState: revision.trustState,
            createdAt: revision.createdAt,
          })),
        };
      },
    },
    {
      definition: {
        id: 'agentis.workflow.graph.rollback',
        family: 'build',
        description:
          'Restore a stored workflow to a previously recorded graph revision. Requires the current baseHash and confirm:true for commit, validates the restored graph, writes atomically, and records the graph being replaced so rollback is itself reversible.',
        inputSchema: {
          type: 'object',
          properties: {
            workflowId: { type: 'string' },
            targetHash: { type: 'string' },
            baseHash: { type: 'string', description: 'Required current graph hash; stale rollback requests are rejected.' },
            dryRun: { type: 'boolean' },
            confirm: { type: 'boolean', description: 'Must be true to commit. Omit for a validated preview.' },
          },
          required: ['workflowId', 'targetHash', 'baseHash'],
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const wf = loadStoredWorkflow(args.workflowId, ctx.workspaceId);
        const targetHash = String(args.targetHash ?? '');
        const currentHash = hashWorkflowGraph(wf.graph as WorkflowGraph);
        if (String(args.baseHash ?? '') !== currentHash) {
          throw new AgentisError('GRAPH_REVISION_CONFLICT',
            `Workflow changed since rollback inspection: expected ${String(args.baseHash ?? '')}, current hash is ${currentHash}. Inspect revisions again.`);
        }
        if (!deps.revisions) throw new AgentisError('WORKFLOW_DRAFT_INVALID', 'Immutable workflow revision service is unavailable.');
        const target = deps.revisions.revisions(ctx.workspaceId, wf.id)
          .find((revision) => revision.semanticHash === targetHash || revision.id === targetHash);
        if (!target) {
          throw new AgentisError('RESOURCE_NOT_FOUND',
            `Workflow revision ${targetHash} is not available in the bounded history. List revisions and choose a retained hash.`);
        }
        const targetGraph = target.graphJson as WorkflowGraph;
        validateWorkflowGraph(targetGraph);
        const diff = diffWorkflowGraphs(wf.graph as WorkflowGraph, targetGraph);
        const dryRun = args.dryRun === true || args.confirm !== true;
        return commitStoredMutation({
          wf,
          graph: targetGraph,
          diff,
          baseHash: currentHash,
          dryRun,
          operation: 'rollback',
          actorId: ctx.agentId ?? ctx.userId,
        });
      },
    },
    {
      definition: {
        id: 'agentis.workflow.revision.inspect',
        family: 'inspect',
        description: 'Inspect the active and candidate revision heads, exact graph hashes, proof gates, and optionally immutable graph bytes.',
        inputSchema: {
          type: 'object',
          properties: { workflowId: { type: 'string' }, revisionId: { type: 'string' }, includeGraph: { type: 'boolean' } },
          required: ['workflowId'],
        },
        mutating: false,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        if (!deps.revisions) throw new AgentisError('WORKFLOW_DRAFT_INVALID', 'Immutable workflow revision service is unavailable.');
        const active = deps.revisions.active(ctx.workspaceId, String(args.workflowId));
        const candidate = deps.revisions.candidate(ctx.workspaceId, String(args.workflowId));
        const requested = args.revisionId
          ? deps.revisions.revision(ctx.workspaceId, String(args.workflowId), String(args.revisionId))
          : candidate?.revision ?? active.revision;
        if (!requested) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workflow revision not found');
        const present = (revision: typeof requested | null) => revision ? {
          revisionId: revision.id,
          semanticHash: revision.semanticHash,
          status: revision.status,
          trustState: revision.trustState,
          proof: deps.revisions!.proofState(ctx.workspaceId, String(args.workflowId), revision.id),
          ...(args.includeGraph === true ? { graph: revision.graphJson } : {}),
        } : null;
        return {
          workflowId: String(args.workflowId),
          active: present(active.revision),
          candidate: present(candidate?.revision ?? null),
          selected: present(requested),
          editableTarget: candidate ? 'candidate' : 'active',
        };
      },
    },
    {
      definition: {
        id: 'agentis.workflow.revision.verify',
        family: 'build',
        description: 'Start a clean debug execution of the exact candidate revision. Deterministic gates must already be green; self-healing is disabled and proof is attached to the immutable revision hash.',
        inputSchema: { type: 'object', properties: { workflowId: { type: 'string' }, inputs: { type: 'object' }, waitMode: { type: 'string', enum: ['background', 'inline', 'auto'] } }, required: ['workflowId'] },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        if (!deps.revisions) throw new AgentisError('WORKFLOW_DRAFT_INVALID', 'Immutable workflow revision service is unavailable.');
        const candidate = deps.revisions.candidate(ctx.workspaceId, String(args.workflowId));
        if (!candidate) throw new AgentisError('RESOURCE_NOT_FOUND', 'No candidate revision is available to verify.');
        const proof = deps.revisions.proofState(ctx.workspaceId, String(args.workflowId), candidate.revision.id);
        const preExecutionMissing = proof.missing.filter((gate) => !['clean_debug', 'outcome', 'operator_approval'].includes(gate));
        if (preExecutionMissing.length > 0) {
          throw new AgentisError('WORKFLOW_GRAPH_INVALID', `Candidate is not ready for a clean execution. Missing gates: ${preExecutionMissing.join(', ')}`);
        }
        const result = await registry.execute({
          id: randomUUID(),
          toolId: 'agentis.workflow.run',
          arguments: {
            workflowId: String(args.workflowId),
            debugRun: true,
            restartMode: 'fresh',
            ...(args.inputs && typeof args.inputs === 'object' ? { inputs: args.inputs } : {}),
            ...(typeof args.waitMode === 'string' ? { waitMode: args.waitMode } : {}),
          },
        }, ctx);
        if (!result.ok) throw new AgentisError('WORKFLOW_GRAPH_INVALID', result.errorMessage ?? 'Candidate verification could not start', { details: result.details });
        const refreshed = deps.revisions.proofState(ctx.workspaceId, String(args.workflowId), candidate.revision.id);
        const active = deps.revisions.active(ctx.workspaceId, String(args.workflowId));
        const alreadyActive = active.revision.id === candidate.revision.id;
        const autoPromotion = refreshed.readyForPromotion && !refreshed.approvalRequired && !alreadyActive
          ? deps.revisions.promote({
              workspaceId: ctx.workspaceId,
              workflowId: String(args.workflowId),
              revisionId: candidate.revision.id,
              expectedActiveRevisionId: active.revision.id,
              actor: { type: 'agent', id: ctx.agentId ?? null },
            })
          : null;
        return {
          candidateRevisionId: candidate.revision.id,
          semanticHash: candidate.revision.semanticHash,
          run: result.output,
          revisionState: autoPromotion || alreadyActive
            ? 'active'
            : refreshed.approvalRequired && refreshed.missing.every((gate) => gate === 'operator_approval')
              ? 'awaiting_approval'
              : refreshed.failed.length > 0 ? 'needs_attention' : 'verifying',
          ...(autoPromotion || alreadyActive ? { autoPromoted: true, ...(autoPromotion ? { promotion: autoPromotion } : {}) } : {}),
          ...(active.workflow.appId ? {
            appId: active.workflow.appId,
            appReadiness: {
              independent: true,
              note: 'This workflow publication is independent. App-wide health may still report advisory issues in sibling workflows.',
            },
          } : {}),
          proof: refreshed,
        };
      },
    },
    {
      definition: {
        id: 'agentis.workflow.revision.promote',
        family: 'build',
        description: 'Promote the exact proven candidate with compare-and-swap protection. Works independently for standalone and App-owned workflows; sibling App issues are not publication blockers.',
        inputSchema: { type: 'object', properties: { workflowId: { type: 'string' }, revisionId: { type: 'string' } }, required: ['workflowId'] },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        if (!deps.revisions) throw new AgentisError('WORKFLOW_DRAFT_INVALID', 'Immutable workflow revision service is unavailable.');
        const workflowId = String(args.workflowId);
        const active = deps.revisions.active(ctx.workspaceId, workflowId);
        const candidate = deps.revisions.candidate(ctx.workspaceId, workflowId);
        if (!candidate) throw new AgentisError('RESOURCE_NOT_FOUND', 'No candidate revision is available to promote.');
        if (args.revisionId && String(args.revisionId) !== candidate.revision.id) {
          throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'The requested candidate is no longer the editable head. Inspect revisions and rebase.');
        }
        const proof = deps.revisions.proofState(ctx.workspaceId, workflowId, candidate.revision.id);
        const nonApprovalMissing = proof.missing.filter((gate) => gate !== 'operator_approval');
        if (nonApprovalMissing.length > 0 || !proof.specMatchesCurrent) {
          throw new AgentisError('WORKFLOW_GRAPH_INVALID', `Candidate is not proven. Missing gates: ${nonApprovalMissing.join(', ') || 'spec reconciliation'}`, { details: { proof } });
        }
        if (!proof.approvalRequired) {
          return {
            outcome: 'promoted',
            promotion: deps.revisions.promote({
              workspaceId: ctx.workspaceId,
              workflowId,
              revisionId: candidate.revision.id,
              expectedActiveRevisionId: active.revision.id,
              actor: { type: 'agent', id: ctx.agentId ?? null },
            }),
          };
        }
        const existing = deps.approvals.list(ctx.workspaceId, 'pending').find((approval) =>
          approval.source === 'workflow_revision'
          && approval.payload.revisionId === candidate.revision.id
          && approval.payload.semanticHash === candidate.revision.semanticHash);
        const approval = existing ?? await deps.approvals.create({
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId ?? null,
          userId: ctx.userId,
          runId: null,
          taskId: null,
          targetId: candidate.revision.id,
          gatewayId: null,
          source: 'workflow_revision',
          title: `Approve workflow revision: ${active.workflow.title}`,
          summary: `Promote candidate ${candidate.revision.id} (${candidate.revision.semanticHash.slice(0, 12)}) after all non-human proof gates passed. It can run code or send data outward.`,
          confidence: null,
          payload: {
            workspaceId: ctx.workspaceId,
            workflowId,
            revisionId: candidate.revision.id,
            semanticHash: candidate.revision.semanticHash,
            expectedActiveRevisionId: active.revision.id,
          },
        });
        return { outcome: 'blocked_on_human', approvalId: approval.id, candidateRevisionId: candidate.revision.id, semanticHash: candidate.revision.semanticHash };
      },
    },
    {
      definition: {
        id: 'agentis.workflow.revision.abandon',
        family: 'build',
        description: 'Abandon the exact candidate revision without changing the active production graph.',
        inputSchema: { type: 'object', properties: { workflowId: { type: 'string' }, revisionId: { type: 'string' }, reason: { type: 'string' } }, required: ['workflowId', 'revisionId'] },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        if (!deps.revisions) throw new AgentisError('WORKFLOW_DRAFT_INVALID', 'Immutable workflow revision service is unavailable.');
        deps.revisions.abandon({
          workspaceId: ctx.workspaceId,
          workflowId: String(args.workflowId),
          revisionId: String(args.revisionId),
          actor: { type: 'agent', id: ctx.agentId ?? null },
          reason: typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : 'Abandoned through agent revision controls',
        });
        return { outcome: 'abandoned', revisionId: String(args.revisionId) };
      },
    },
    {
      definition: {
        id: 'agentis.run.graph.evolve',
        family: 'run',
        description:
          'Evolve the graph of a LIVE workflow run through the runtime contract transaction. This never edits the stored workflow. ' +
          'The evolution either commits under green-ratchet and authority checks, or returns named regressions.',
        inputSchema: {
          type: 'object', properties: { runId: { type: 'string' }, patch: { type: 'object' } }, required: ['runId', 'patch'],
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const run = deps.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, String(args.runId))).get();
        if (!run || run.workspaceId !== ctx.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', `run ${String(args.runId)} not found`);
        const result = await deps.engine.evolveGraph({
          runId: run.id, patch: args.patch as WorkflowGraphPatch, actorId: (ctx as { agentId?: string }).agentId,
        });
        return { runId: run.id, ...result };
      },
    },
    {
      definition: {
        id: 'agentis.workflow.cancel',
        family: 'run',
        mcpExposed: true,
        description: 'Cancel a running workflow run.',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const run = deps.db
          .select()
          .from(schema.workflowRuns)
          .where(eq(schema.workflowRuns.id, String(args.runId)))
          .get();
        if (!run || run.workspaceId !== ctx.workspaceId) throw new Error(`run ${args.runId} not found`);
        await deps.engine.cancelRun(run.id);
        return { runId: run.id, status: 'cancelled' };
      },
    },
    {
      definition: {
        id: 'agentis.workflow.delete',
        family: 'build',
        description:
          'PERMANENTLY delete a workflow and its entire run history (runs, snapshots, triggers cascade). Destructive and irreversible. Called WITHOUT confirm:true it returns a preview of exactly what will be removed — review it, then call again with confirm:true. To STOP a workflow without losing it, disable it instead via agentis.workflow.chain { workflows:[{ workflowId, enabled:false }] }. If the workflow is the sole logic of an App you want gone, use agentis.app.delete.',
        inputSchema: {
          type: 'object',
          properties: {
            workflowId: { type: 'string' },
            confirm: { type: 'boolean', description: 'Must be true to actually delete. Omit/false to get a preview first.' },
          },
          required: ['workflowId'],
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const workflowId = String(args.workflowId ?? '').trim();
        if (!workflowId) throw new Error('workflow.delete requires workflowId');
        const wf = deps.db
          .select({ id: schema.workflows.id, title: schema.workflows.title, appId: schema.workflows.appId })
          .from(schema.workflows)
          .where(and(eq(schema.workflows.id, workflowId), eq(schema.workflows.workspaceId, ctx.workspaceId)))
          .get();
        if (!wf) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow ${workflowId} not found`);
        const runCount = deps.db
          .select({ c: sql<number>`count(*)` })
          .from(schema.workflowRuns)
          .where(eq(schema.workflowRuns.workflowId, workflowId))
          .get()?.c ?? 0;

        if (args.confirm !== true) {
          return {
            deleted: false,
            preview: true,
            workflow: { workflowId, title: wf.title, appId: wf.appId ?? null },
            willRemove: `this workflow and its ${runCount} run(s), plus their snapshots and triggers (cascade)`,
            next: `Call agentis.workflow.delete again with { workflowId: "${workflowId}", confirm: true } to proceed. To keep the history and just stop it, use agentis.workflow.chain { workflows: [{ workflowId: "${workflowId}", enabled: false }] } instead.`,
          };
        }

        // Cancel any in-flight run first — the FK cascade would otherwise delete a
        // run row out from under a live execution. Terminal runs are left alone.
        const active = deps.db
          .select({ id: schema.workflowRuns.id })
          .from(schema.workflowRuns)
          .where(and(
            eq(schema.workflowRuns.workflowId, workflowId),
            sql`${schema.workflowRuns.status} NOT IN ('COMPLETED','FAILED','CANCELLED','COMPLETED_WITH_CONTRACT_VIOLATION')`,
          ))
          .all();
        for (const run of active) {
          try { await deps.engine.cancelRun(run.id); } catch { /* best-effort; the cascade removes it anyway */ }
        }

        deps.db.delete(schema.workflows).where(eq(schema.workflows.id, workflowId)).run();

        // Realtime: the canvas/app control-plane/home refetch and drop the workflow.
        try {
          const payload = { workflowId, appId: wf.appId ?? null };
          deps.bus.publish(REALTIME_ROOMS.workflow(workflowId), REALTIME_EVENTS.WORKFLOW_DELETED, payload);
          deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), REALTIME_EVENTS.WORKFLOW_DELETED, payload);
          if (wf.appId) deps.bus.publish(REALTIME_ROOMS.app(wf.appId), REALTIME_EVENTS.APP_UPDATED, { appId: wf.appId, op: 'updated' });
        } catch { /* realtime must never fail the delete */ }

        return { deleted: true, workflowId, title: wf.title, runsRemoved: runCount };
      },
    },
    {
      definition: {
        id: 'agentis.build_workflow',
        family: 'build',
        description:
          '[PAVED ROAD — INTERNAL AUTHORING, NEVER A FINAL USER DELIVERABLE] Validate, enrich, save, and stream an agent-authored workflow, or synthesize with a configured fast model. '
          + 'For every user-requested create or edit, immediately follow this call with agentis.workflow.deliver using the returned workflowId. Do not stop or reply between these calls. '
          + 'To refine the workflow you just built in this conversation, call again WITHOUT a workflowId — '
          + 'it updates that same workflow in place. Pass workflowId to target a specific one, or set '
          + 'newWorkflow=true to deliberately create a separate workflow. '
          + 'The result includes `readiness`: if `readiness.ready` is false, tell the operator in plain, '
          + 'natural language what to connect/configure (from `readiness.requirements`) before it can run — '
          + 'never ask them for rigid formats; ask like a helpful assistant. '
          + 'DECLARE THE TRIGGER: pass `trigger` whenever the work is not started by hand. Without it the trigger is '
          + 'GUESSED from keywords in `description` and defaults to manual — so a recurring job phrased without the '
          + 'word "every"/"daily"/"schedule" silently becomes a workflow nobody ever starts. '
          + 'MULTIPLE JOBS: if the request names more than one job ("find leads AND message them AND build their store"), '
          + 'do NOT collapse it into one workflow — use agentis.app.plan, then agentis.workflow.chain to wire the order.',
        inputSchema: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            title: { type: 'string' },
            workflowId: { type: 'string' },
            appId: { type: 'string', description: 'Existing App that should own a newly created workflow. Omit to create the historical App-of-one wrapper.' },
            newWorkflow: { type: 'boolean' },
            graphDraft: {
              type: 'object',
              description: 'Agent-authored WorkflowGraph for a new workflow or full replacement.',
            },
            patchDraft: {
              type: 'object',
              description: 'Legacy agent-authored patch object for editing the target workflow. updateNodes entries may contain only id plus changed fields; omitted node/config fields are preserved. Prefer agentis.workflow.graph.patch for explicit operations and revision checks.',
            },
            confirmIntentChange: {
              type: 'boolean',
              description: 'Acknowledge a DELIBERATE capability change. Required to save an edit that removes load-bearing work (agent workers / fetch steps / integrations / persistence) — otherwise the edit is rejected as green-washing.',
            },
            trigger: {
              type: 'object',
              description:
                'DECLARE how this workflow starts, instead of leaving it to keyword inference (which defaults to manual). '
                + 'Set this whenever the work is unattended.',
              properties: {
                type: {
                  type: 'string',
                  enum: ['manual', 'cron', 'webhook', 'persistent_listener'],
                  description: 'manual = a person starts it; cron = recurring; webhook = an inbound HTTP call; persistent_listener = a continuously watched source.',
                },
                cron: {
                  type: 'string',
                  description: '5-field UTC cron for type "cron" (e.g. "0 9 * * *" daily 09:00, "*/5 * * * *" every 5 minutes). Implies type cron when given alone.',
                },
              },
            },
          },
          required: ['description'],
        },
        mutating: true,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const description = String(args.description ?? '').trim();
        if (!description) throw new Error('build_workflow requires description');
        // Resolve the target workflow: explicit id › conversation latch (revise
        // in place) › new. A latched id that no longer exists falls back to new.
        const latchKey = buildWorkflowLatchKey(ctx);
        // Cost circuit breaker — reserve a build slot BEFORE any model spend.
        // Throws fast (no LLM call) on a duplicate concurrent build or a workspace
        // that has blown past its per-minute build budget.
        const releaseBuildSlot = acquireBuildSlot(ctx.workspaceId, latchKey);
        try {
          let targetWorkflowId: string | null = args.workflowId ? String(args.workflowId) : null;
          if (!targetWorkflowId && args.newWorkflow !== true && latchKey) {
            const latched = lastWorkflowByConversation.get(latchKey);
            if (latched) {
              const exists = deps.db
                .select({ id: schema.workflows.id })
                .from(schema.workflows)
                .where(and(eq(schema.workflows.id, latched), eq(schema.workflows.workspaceId, ctx.workspaceId)))
                .get();
              if (exists) targetWorkflowId = latched;
              else lastWorkflowByConversation.delete(latchKey);
            }
          }
          const result = await createWorkflowFromDescription(deps, {
            workspaceId: ctx.workspaceId,
            ambientId: ctx.ambientId ?? null,
            userId: ctx.userId,
            agentId: ctx.agentId,
            runId: ctx.runId,
            description,
            title: args.title ? String(args.title) : undefined,
            workflowId: targetWorkflowId,
            appId: args.appId ? String(args.appId) : undefined,
            graphDraft: args.graphDraft,
            patchDraft: args.patchDraft,
            confirmIntentChange: args.confirmIntentChange === true,
            ...(args.trigger && typeof args.trigger === 'object'
              ? { trigger: args.trigger as ExplicitTriggerSpec }
              : {}),
            stream: true,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          if (latchKey && result?.workflowId) rememberConversationWorkflow(latchKey, result.workflowId);
          // Surface, in plain language, any setup the workflow still needs before
          // it can actually run (connect an account, etc.) — connector-agnostic and
          // advisory, so the orchestrator can ask the operator intelligently rather
          // than letting a run dead-end. Never fail the build over this.
          try {
            const builtGraph = (result as { graph?: WorkflowGraph }).graph;
            if (builtGraph) {
              const readiness = analyzeWorkflowReadiness(deps.db, ctx.workspaceId, builtGraph);
              return { ...result, readiness };
            }
          } catch {
            /* readiness is advisory */
          }
          return result;
        } finally {
          releaseBuildSlot();
        }
      },
    },
    {
      definition: {
        id: 'agentis.plan_workflow',
        family: 'inspect',
        description: 'Decompose a workflow request into named, cost-estimated phases (Phase Cards) before building. Use for complex/enterprise requests so the operator can approve the plan first.',
        inputSchema: { type: 'object', properties: { description: { type: 'string' } }, required: ['description'] },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const description = String(args.description ?? '').trim();
        if (!description) throw new Error('plan_workflow requires description');
        const brief = await assembleCreationBrief(deps, ctx.workspaceId, ctx.agentId, description);
        const plan = planWorkflow(description, brief.classification);
        // SWIFT-S: the scope question is asked FIRST — "how will we KNOW it
        // worked?" The draft derives worldly acceptance checks (deploy → URL
        // probe, persist → data probe) so the workflow is verifiable from birth.
        const services = await runnableServicesForSpec(deps, ctx.workspaceId);
        const specDraft = deriveSpecDraft({ description, services });
        return {
          archetype: plan.archetype,
          phases: plan.phases,
          totalEstimatedCostCents: plan.totalEstimatedCostCents,
          missingDependencies: plan.missingDependencies,
          requiresConfirmation: plan.requiresConfirmation,
          question: plan.question,
          specDraft: specDraft.spec,
          ...(specDraft.question ? { specQuestion: specDraft.question } : {}),
          next: [{
            tool: 'agentis.build_workflow',
            args: { description },
            why: 'Author the graph for the approved plan (add graphDraft or let synthesis run). The result carries the compass for the rest of the loop: dry_run → suite → debug-run → harden.',
          }, {
            tool: 'agentis.workflow.scope',
            args: { workflowId: '<the built workflow id>', spec: specDraft.spec },
            why: 'After building: persist the acceptance spec so every run is VERIFIED against the world, not just completed.',
          }],
          message: `Plan: ${plan.phases.length} phase(s), est. ${plan.totalEstimatedCostCents[0]}-${plan.totalEstimatedCostCents[1]}¢/run. Spec draft: ${specDraft.spec.acceptance.length} acceptance check(s)${specDraft.question ? ' — NEEDS INPUT on verification' : ''}.`,
        };
      },
    },
    {
      definition: {
        id: 'agentis.plan',
        family: 'inspect',
        description: 'Break a complex objective into executable steps.',
        inputSchema: { type: 'object', properties: { goal: { type: 'string' }, context: { type: 'string' } }, required: ['goal'] },
        mutating: false,
      },
      handler: async (args) => {
        const goal = String(args.goal ?? '').trim();
        return { goal, steps: buildPlan(goal, String(args.context ?? '')) };
      },
    },
    {
      definition: {
        id: 'agentis.evaluate',
        family: 'inspect',
        description: 'Evaluate an artifact against criteria.',
        inputSchema: { type: 'object', properties: { artifact: { type: 'string' }, criteria: { type: 'string' } }, required: ['artifact', 'criteria'] },
        mutating: false,
      },
      handler: async (args) => {
        const artifact = String(args.artifact ?? '');
        const criteria = String(args.criteria ?? '');
        const missing = ['correctness', 'completeness', 'clarity'].filter((term) => criteria.toLowerCase().includes(term) && !artifact.toLowerCase().includes(term));
        const score = Math.max(0.35, Math.min(0.95, artifact.length > 120 ? 0.78 : 0.62));
        return { score, criteria, reasoning: missing.length ? `Review ${missing.join(', ')} before shipping.` : 'No obvious structural gaps detected.', recommendations: missing };
      },
    },
    {
      definition: {
        id: 'agentis.reflect',
        family: 'inspect',
        description: 'Self-critique the current approach and recommend the next action.',
        inputSchema: { type: 'object', properties: { situation: { type: 'string' }, goal: { type: 'string' } }, required: ['situation', 'goal'] },
        mutating: false,
      },
      handler: async (args) => ({
        goal: String(args.goal ?? ''),
        critique: `Current situation: ${String(args.situation ?? '').slice(0, 500)}`,
        nextAction: 'Use platform tools for real state, reduce assumptions, and proceed with the smallest reversible action.',
      }),
    },
    {
      definition: {
        id: 'agentis.workflow.validate',
        family: 'build',
        description: 'Validate a graph against the engine’s static checks (cycles, dangling refs).',
        inputSchema: { type: 'object', properties: { graph: { type: 'object' } }, required: ['graph'] },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, _ctx) => {
        // Delegate to the existing validator. Imported lazily to keep the handler
        // file independent of engine wiring.
        const { validateWorkflowGraph } = await import('../../engine/validateGraph.js');
        try {
          validateWorkflowGraph(args.graph as WorkflowGraph);
          return {
            valid: true,
            next: [{
              tool: 'agentis.workflow.dry_run',
              args: { graph: '<this graph>' },
              why: 'Static validity is not data-flow proof — the dry-run threads real I/O node-to-node and catches empty/lost payloads before any spend.',
            }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : 'invalid graph';
          return { valid: false, errorMessage: message };
        }
      },
    },
    {
      definition: {
        id: 'agentis.workflow.dry_run',
        family: 'build',
        description:
          '[PAVED ROAD 2/5 — DRY-RUN] Deterministically DRY-RUN a workflow WITHOUT calling any AI, integration, or agent node: '
          + 'execute the pure/deterministic nodes for real, MOCK the side-effecting ones, and thread real '
          + 'sample I/O through the whole graph so you can SEE what each node receives and produces before a '
          + 'real run. Pass a `graph` draft OR a `workflowId`, plus optional sample `inputs` (omitted → '
          + 'synthesized from the input contract). Returns a per-node I/O trace (input, output, '
          + 'status: passed|mocked|failed) + blocking issues. Use this to catch a lost/empty payload '
          + '(e.g. a scorer receiving zero candidates) at BUILD time — no cost, no external calls.',
        inputSchema: {
          type: 'object',
          properties: {
            workflowId: { type: 'string', description: 'Dry-run a saved workflow by id.' },
            graph: { type: 'object', description: 'Or dry-run an unsaved WorkflowGraph draft directly.' },
            inputs: { type: 'object', description: 'Optional sample trigger inputs.' },
            assertions: { type: 'array', description: 'TDD contracts checked against the trace: [{ nodeId, expr, message }] where expr is a safe condition over that node\'s output/input (e.g. "output.candidates.length > 0"), plus nodes["id"].field for any node. Any failing assertion makes ok:false.', items: { type: 'object' } },
            pin: { type: 'boolean', description: 'Persist these inputs+assertions as the workflow\'s pinned test — reused when dry_run is later called with just the workflowId.' },
          },
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        let graph: WorkflowGraph;
        let workflowId = 'dry-run';
        let wf: { id: string; workspaceId: string; graph: unknown; settings: unknown } | null = null;
        if (args.graph !== undefined) {
          graph = parseAgentGraphDraft(args.graph);
        } else if (args.workflowId) {
          wf = deps.db
            .select()
            .from(schema.workflows)
            .where(eq(schema.workflows.id, String(args.workflowId)))
            .get() ?? null;
          if (!wf || wf.workspaceId !== ctx.workspaceId) throw new Error(`workflow ${args.workflowId} not found`);
          graph = editableGraph(wf, ctx.workspaceId);
          workflowId = wf.id;
        } else {
          throw new AgentisError('VALIDATION_FAILED', 'agentis.workflow.dry_run requires a graph draft or a workflowId.');
        }
        let inputs = args.inputs && typeof args.inputs === 'object' ? (args.inputs as Record<string, unknown>) : undefined;
        let assertionSpecs = Array.isArray(args.assertions) ? (args.assertions as Array<Record<string, unknown>>) : undefined;
        // P3.1 — pinned fixtures: reuse a saved { inputs, assertions } when the caller
        // passes neither, so `dry_run(workflowId)` is a reproducible regression test.
        const pinnedTest = wf ? (wf.settings as { workflowTest?: { inputs?: Record<string, unknown>; assertions?: Array<Record<string, unknown>> } } | null)?.workflowTest : undefined;
        if (!inputs && !assertionSpecs && pinnedTest) {
          inputs = pinnedTest.inputs;
          assertionSpecs = pinnedTest.assertions;
        }
        if (args.pin === true && wf) {
          deps.db.update(schema.workflows)
            .set({ settings: { ...((wf.settings as Record<string, unknown>) ?? {}), workflowTest: { inputs: inputs ?? {}, assertions: assertionSpecs ?? [] } }, updatedAt: new Date().toISOString() })
            .where(eq(schema.workflows.id, wf.id))
            .run();
        }
        const report = preflightWorkflow({ db: deps.db, workspaceId: ctx.workspaceId, workflowId, graph, inputs, mode: 'canvas' });
        // Fold in the build-time expression + input-reachability gates so a dry-run
        // is a COMPLETE pre-run check, not just a node simulation.
        const exprIssues = [...dryRunGraphExpressions(graph), ...analyzeInputReachability(graph), ...analyzeEdgeCouplings(graph)].map((i) => ({
          code: i.code, severity: i.severity, nodeId: i.nodeId, nodeTitle: i.nodeTitle, message: `${i.field}: ${i.message}`, autoRepairable: true,
        }));
        const trace = graph.nodes
          .map((n) => report.nodes[n.id])
          .filter((r): r is NonNullable<typeof r> => Boolean(r))
          .map((r) => ({ nodeId: r.nodeId, title: r.title, kind: r.kind, status: r.status, input: r.input, output: r.output, error: r.error }));
        const executed = trace.filter((t) => t.status === 'passed').length;
        const mocked = trace.filter((t) => t.status === 'mocked').length;
        const failed = trace.filter((t) => t.status === 'failed').length;
        const issues = [...report.issues, ...exprIssues];
        const blocking = issues.filter((i) => i.severity === 'error');
        // P3.2 — TDD contract assertions: evaluate each declared expectation against
        // the trace (deterministic, over the real/mocked I/O). This is the red/green
        // the operator asked for — "revise the whole I/O through the process".
        const nodesMap = Object.fromEntries(trace.map((t) => [t.nodeId, t.output ?? {}]));
        const assertions = (assertionSpecs ?? []).map((a) => {
          const nodeId = String(a?.nodeId ?? '');
          const expr = String(a?.expr ?? '');
          const message = a?.message ? String(a.message) : undefined;
          const entry = trace.find((t) => t.nodeId === nodeId);
          if (!entry) return { nodeId, expr, message, passed: false, detail: `node "${nodeId}" is not in the dry-run trace` };
          if (entry.status === 'failed') return { nodeId, expr, message, passed: false, detail: `node "${nodeId}" failed: ${entry.error ?? 'error'}` };
          try {
            const passed = evalCondition(expr, { input: entry.input ?? {}, inputs: entry.input ?? {}, output: entry.output ?? {}, nodes: nodesMap, trigger: report.scenario.input });
            return { nodeId, expr, message, passed };
          } catch (err) {
            return { nodeId, expr, message, passed: false, detail: `assertion expression error: ${(err as Error).message}` };
          }
        });
        const failedAssertions = assertions.filter((a) => !a.passed);
        const dryOk = report.status !== 'blocked' && blocking.length === 0 && failedAssertions.length === 0;
        // PAVED-ROAD P1 — durable evidence: stamp the dry-run outcome at this
        // graph hash on the workflow row (a later graph change stales it), and
        // hand back the compass so the agent's next move is explicit.
        let compass;
        if (wf) {
          const candidateRevision = deps.revisions?.candidate(ctx.workspaceId, wf.id);
          if (candidateRevision && candidateRevision.revision.semanticHash === graphContentHash(graph)) {
            deps.revisions!.recordProof({
              workspaceId: ctx.workspaceId,
              workflowId: wf.id,
              revisionId: candidateRevision.revision.id,
              gate: 'dry_run',
              status: dryOk ? 'passed' : 'failed',
              evidence: {
                blockingIssues: blocking,
                assertions,
                traceSummary: { executed, mocked, failed },
              },
            });
          }
          const buildLoop = stampBuildLoop(deps.db, wf.id, {
            dryRun: {
              at: new Date().toISOString(),
              ok: dryOk,
              issueCount: blocking.length + failedAssertions.length,
              graphHash: graphContentHash(graph),
            },
          });
          compass = compassForWorkflow({ workflowId: wf.id, graph, settings: { buildLoop } });
        } else {
          compass = {
            stage: dryOk ? ('dry_run_green' as const) : ('dry_run_red' as const),
            summary: dryOk
              ? 'The draft dry-ran green. Save it through the gates, then debug-run it for real.'
              : 'The draft has blocking issues — fix the named nodes and dry-run again before saving.',
            next: [
              dryOk
                ? {
                    tool: 'agentis.build_workflow',
                    args: { description: '<what this workflow does>', graphDraft: '<this graph>' },
                    why: 'Persist the draft through the same gates; the result returns workflowId + the next step (a debug run).',
                  }
                : {
                    tool: 'agentis.workflow.dry_run',
                    args: { graph: '<the fixed graph>' },
                    why: 'Iterate on the draft until ok:true — the issues name the exact node and field to fix.',
                  },
            ],
          };
        }
        return {
          ok: dryOk,
          status: report.status,
          scenario: report.scenario,
          trace,
          issues,
          ...(assertions.length > 0 ? { assertions } : {}),
          compass,
          summary:
            `Dry-ran ${trace.length} node(s): ${executed} executed for real, ${mocked} mocked (ai/integration/agent), `
            + `${failed} failed. ${blocking.length} blocking issue(s).`
            + (assertions.length > 0 ? (failedAssertions.length > 0 ? ` ${failedAssertions.length}/${assertions.length} assertion(s) FAILED.` : ` All ${assertions.length} assertion(s) passed.`) : '')
            + ' No AI, integration, or external call was made.'
            + ` NEXT: ${compass.next[0]?.tool ?? ''} — ${compass.next[0]?.why ?? ''}`,
        };
      },
    },
    {
      definition: {
        id: 'agentis.workflow.loop_status',
        family: 'inspect',
        description:
          '[PAVED ROAD — ORIENT] WHERE AM I with this workflow? Returns its Paved Road loop state — authored → dry-run → debug-run → '
          + 'production — with the durable evidence behind it (what was proven at the CURRENT graph and what went '
          + 'stale when the graph changed), plus readiness requirements and the exact next call to make. '
          + 'Call this FIRST when resuming work on any workflow, or whenever you are unsure what to do next.',
        inputSchema: { type: 'object', properties: { workflowId: { type: 'string' } }, required: ['workflowId'] },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const wf = deps.db
          .select()
          .from(schema.workflows)
          .where(eq(schema.workflows.id, String(args.workflowId)))
          .get();
        if (!wf || wf.workspaceId !== ctx.workspaceId) throw new Error(`workflow ${args.workflowId} not found`);
        const graph = editableGraph(wf, ctx.workspaceId);
        const state = readBuildLoop(wf.settings);
        const hash = graphContentHash(graph);
        const stage = deriveLoopStage(state, hash);
        const compass = compassForWorkflow({
          workflowId: wf.id,
          appId: new AppStore(deps.db).appIdForWorkflow(ctx.workspaceId, wf.id),
          graph,
          settings: wf.settings,
        });
        let readiness;
        try {
          readiness = analyzeWorkflowReadiness(deps.db, ctx.workspaceId, graph);
        } catch {
          readiness = undefined;
        }
        return {
          workflowId: wf.id,
          title: wf.title,
          nodeCount: graph.nodes.length,
          edgeCount: graph.edges.length,
          stage,
          stageLabel: LOOP_STAGE_LABEL[stage],
          graphHash: hash,
          evidence: {
            validatedAt: state.validatedAt ?? null,
            dryRun: state.dryRun ? { ...state.dryRun, stale: state.dryRun.graphHash !== hash } : null,
            debugRun: state.debugRun ? { ...state.debugRun, stale: state.debugRun.graphHash !== hash } : null,
            productionRun: state.productionRun ? { ...state.productionRun, stale: state.productionRun.graphHash !== hash } : null,
          },
          ...(readiness ? { readiness } : {}),
          compass,
          summary: `${LOOP_STAGE_LABEL[stage]}. NEXT: ${compass.next[0]?.tool ?? ''} — ${compass.next[0]?.why ?? ''}`,
        };
      },
    },
    {
      definition: {
        id: 'agentis.workflow.scope',
        family: 'build',
        description:
          '[SWIFT — SCOPE] Define HOW SUCCESS IS VERIFIED for a workflow: persist its spec — objective, acceptance checks '
          + '(http_probe / browser_probe / data_probe / expr / judge, each executed against the WORLD at run end, never the '
          + 'run\'s self-report), sufficiency floors (anti-hollow: nonEmpty/minItems/minLength), and constraints '
          + '(allowedServices, maxMutatingCalls). Without a spec a run can only ever be "completed", never verified '
          + 'ACCOMPLISHED — and it can never harden or arm an unattended trigger. Call with just a workflowId to DERIVE a '
          + 'draft from the workflow\'s description; pass `spec` to set it explicitly.',
        inputSchema: {
          type: 'object',
          properties: {
            workflowId: { type: 'string' },
            spec: { type: 'object', description: 'Explicit WorkflowSpec { objective, acceptance[], sufficiency?, constraints?, reworkBudget? }. Omit to derive a draft.' },
          },
          required: ['workflowId'],
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const wf = deps.db.select().from(schema.workflows)
          .where(eq(schema.workflows.id, String(args.workflowId))).get();
        if (!wf || wf.workspaceId !== ctx.workspaceId) throw new Error(`workflow ${args.workflowId} not found`);
        const graph = editableGraph(wf, ctx.workspaceId);
        const hash = graphContentHash(graph);
        const services = await runnableServicesForSpec(deps, ctx.workspaceId);

        let spec: WorkflowSpec;
        let question: string | undefined;
        if (args.spec && typeof args.spec === 'object') {
          const provided = args.spec as Partial<WorkflowSpec>;
          spec = {
            version: 1,
            objective: String(provided.objective ?? wf.title),
            acceptance: Array.isArray(provided.acceptance) ? provided.acceptance : [],
            ...(provided.sufficiency ? { sufficiency: provided.sufficiency } : {}),
            ...(provided.constraints ? { constraints: provided.constraints } : {}),
            reworkBudget: provided.reworkBudget ?? 1,
            ...(provided.verification ? { verification: provided.verification } : {}),
            createdAt: readWorkflowSpec(wf.settings)?.createdAt ?? new Date().toISOString(),
            reconciledHash: hash,
          };
        } else {
          const derived = deriveSpecDraft({
            description: [wf.title, wf.description ?? ''].filter(Boolean).join('. '),
            services,
            graph,
          });
          spec = { ...derived.spec, reconciledHash: hash };
          question = derived.question;
        }
        const errors = validateWorkflowSpec(spec, { knownServices: services, graph });
        if (errors.length > 0) {
          return {
            ok: false,
            errors,
            summary: `Spec rejected: ${errors[0]}`,
            hint: 'Fix the named checks and call agentis.workflow.scope again. Every expr must parse; every data_probe service must be runnable; probe url templates must reference declared output keys.',
          };
        }
        deps.db.update(schema.workflows)
          .set({ settings: { ...((wf.settings as Record<string, unknown>) ?? {}), spec }, updatedAt: new Date().toISOString() })
          .where(eq(schema.workflows.id, wf.id)).run();
        const revisionBase = deps.revisions?.candidate(ctx.workspaceId, wf.id)?.revision
          ?? deps.revisions?.ensureWorkflow(ctx.workspaceId, wf.id).active;
        const specCandidate = revisionBase && deps.revisions
          ? deps.revisions.createCandidate({
              workspaceId: ctx.workspaceId,
              workflowId: wf.id,
              graph,
              baseRevisionId: revisionBase.id,
              source: 'user_edit',
              actor: { type: ctx.agentId ? 'agent' : 'user', id: ctx.agentId ?? ctx.userId },
              reason: 'Updated workflow acceptance specification',
            }).revision
          : null;
        const worldly = spec.acceptance.filter((c) => c.verify !== 'judge').length;
        return {
          ok: true,
          workflowId: wf.id,
          ...(specCandidate ? { candidateRevisionId: specCandidate.id } : {}),
          spec,
          worldlyChecks: worldly,
          ...(question ? { question } : {}),
          ...(worldly === 0 ? { warning: 'All acceptance checks are judge-only. Hardening requires at least ONE worldly (non-judge) check — add an http_probe, data_probe, or expr check.' } : {}),
          compass: compassForWorkflow({ workflowId: wf.id, graph, settings: { ...((wf.settings as Record<string, unknown>) ?? {}), spec } }),
          summary: `Scoped: "${spec.objective}" — ${spec.acceptance.length} acceptance check(s) (${worldly} worldly)${question ? '. NEEDS INPUT: ' + question : ''}`,
        };
      },
    },
    {
      definition: {
        id: 'agentis.workflow.test',
        family: 'build',
        description:
          '[SWIFT — ITERATE] The workflow test SUITE. action:"run" executes every pinned case through the free dry-run '
          + 'engine (pure nodes real, side effects mocked) and evaluates case assertions + the spec\'s expr checks and '
          + 'sufficiency floors against the terminal trace (world probes/judge run later, on the debug run). '
          + 'action:"generate" derives edge/adversarial cases mechanically from the input contract (missing/empty/zero '
          + 'variants) — generated cases report but never gate until you keep them. action:"add"/"remove"/"keep" manage '
          + 'cases. Suite green (at the current graph) is required to HARDEN.',
        inputSchema: {
          type: 'object',
          properties: {
            workflowId: { type: 'string' },
            action: { type: 'string', description: 'run | generate | add | remove | keep | list. Default: run.' },
            case: { type: 'object', description: 'For add: { name, kind: happy|edge|adversarial|regression, inputs, assertions?, expectOutcome? }.' },
            caseId: { type: 'string', description: 'For remove/keep.' },
          },
          required: ['workflowId'],
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const wf = deps.db.select().from(schema.workflows)
          .where(eq(schema.workflows.id, String(args.workflowId))).get();
        if (!wf || wf.workspaceId !== ctx.workspaceId) throw new Error(`workflow ${args.workflowId} not found`);
        const graph = editableGraph(wf, ctx.workspaceId);
        const settings = (wf.settings as Record<string, unknown>) ?? {};
        const action = typeof args.action === 'string' && args.action.trim() ? args.action.trim() : 'run';
        let suite = readWorkflowTests(settings);
        const persistSuite = (next: WorkflowTestCase[]) => {
          deps.db.update(schema.workflows)
            .set({ settings: { ...settings, workflowTests: next }, updatedAt: new Date().toISOString() })
            .where(eq(schema.workflows.id, wf.id)).run();
        };

        if (action === 'list') {
          return { workflowId: wf.id, cases: suite, summary: `${suite.length} case(s).` };
        }
        if (action === 'generate') {
          const generated = generateEdgeCases(graph);
          if (generated.length === 0) {
            return { ok: false, summary: 'No input contract on this graph — nothing to derive. Author cases with action:"add" instead.' };
          }
          const existingNames = new Set(suite.map((c) => c.name));
          const fresh = generated.filter((c) => !existingNames.has(c.name));
          persistSuite([...suite, ...fresh]);
          return {
            ok: true,
            added: fresh.length,
            cases: fresh.map((c) => ({ id: c.id, name: c.name, kind: c.kind, origin: c.origin })),
            summary: `${fresh.length} generated case(s) added (non-gating until kept). Review them, keep the valid ones (action:"keep"), then action:"run".`,
          };
        }
        if (action === 'add') {
          const raw = (args.case ?? {}) as Record<string, unknown>;
          const testCase: WorkflowTestCase = {
            id: randomUUID(),
            name: String(raw.name ?? `case ${suite.length + 1}`),
            kind: ['happy', 'edge', 'adversarial', 'regression'].includes(String(raw.kind)) ? String(raw.kind) as WorkflowTestCase['kind'] : 'happy',
            inputs: raw.inputs && typeof raw.inputs === 'object' ? raw.inputs as Record<string, unknown> : {},
            assertions: Array.isArray(raw.assertions) ? raw.assertions as WorkflowTestCase['assertions'] : [],
            ...(raw.expectOutcome && typeof raw.expectOutcome === 'object' ? { expectOutcome: raw.expectOutcome as WorkflowTestCase['expectOutcome'] } : {}),
            origin: 'authored',
          };
          for (const a of testCase.assertions) {
            try { evalCondition(String(a.expr), { output: {}, input: {}, inputs: {}, nodes: {}, trigger: {} }); }
            catch { return { ok: false, summary: `assertion "${a.expr}" does not parse — fix it and re-add.` }; }
          }
          persistSuite([...suite, testCase]);
          return { ok: true, caseId: testCase.id, summary: `Case "${testCase.name}" added. Run the suite: action:"run".` };
        }
        if (action === 'remove' || action === 'keep') {
          const caseId = String(args.caseId ?? '');
          const target = suite.find((c) => c.id === caseId);
          if (!target) return { ok: false, summary: `case ${caseId} not found.` };
          const next = action === 'remove'
            ? suite.filter((c) => c.id !== caseId)
            : suite.map((c) => (c.id === caseId ? { ...c, origin: 'authored' as const } : c));
          persistSuite(next);
          return { ok: true, summary: action === 'remove' ? `Case "${target.name}" removed.` : `Case "${target.name}" kept — it now gates the suite.` };
        }

        // action:"run" — the suite, through the dry-run engine.
        suite = readWorkflowTests(settings);
        if (suite.length === 0) {
          return {
            ok: false,
            summary: 'No test cases pinned. Generate the mechanical battery first (action:"generate") or add a case (action:"add").',
          };
        }
        const spec = readWorkflowSpec(settings);
        const results = suite.map((testCase) => runSuiteCase(deps, ctx.workspaceId, wf.id, graph, testCase, spec));
        const gating = results.filter((r) => r.gating);
        const passedGating = gating.filter((r) => r.passed);
        const ok = gating.length > 0 && passedGating.length === gating.length;
        const hash = graphContentHash(graph);
        const buildLoop = stampBuildLoop(deps.db, wf.id, {
          suite: { at: new Date().toISOString(), graphHash: hash, total: gating.length, passed: passedGating.length, ok },
        });
        const candidateRevision = deps.revisions?.candidate(ctx.workspaceId, wf.id);
        if (candidateRevision && candidateRevision.revision.semanticHash === hash) {
          deps.revisions!.recordProof({
            workspaceId: ctx.workspaceId,
            workflowId: wf.id,
            revisionId: candidateRevision.revision.id,
            gate: 'regression',
            status: ok ? 'passed' : 'failed',
            evidence: {
              total: results.length,
              gating: gating.length,
              passed: passedGating.length,
              cases: results.map((result) => ({
                id: result.id,
                kind: result.kind,
                gating: result.gating,
                passed: result.passed,
              })),
            },
          });
        }
        return {
          ok,
          workflowId: wf.id,
          total: results.length,
          gating: gating.length,
          passed: passedGating.length,
          results: results.map((r) => ({ id: r.id, name: r.name, kind: r.kind, gating: r.gating, passed: r.passed, detail: r.detail })),
          compass: compassForWorkflow({ workflowId: wf.id, graph, settings: { ...settings, buildLoop } }),
          summary: ok
            ? `Suite GREEN: ${passedGating.length}/${gating.length} gating case(s) passed${results.length > gating.length ? ` (+${results.length - gating.length} generated, non-gating)` : ''}. Next: a debug run.`
            : `Suite RED: ${passedGating.length}/${gating.length} gating case(s) passed. Fix the failures before any real run.`,
        };
      },
    },
    {
      definition: {
        id: 'agentis.workflow.harden',
        family: 'build',
        description:
          '[SWIFT — FORMALIZE] The hardening gate. Checks every SWIFT predicate at the CURRENT graph hash — spec present + '
          + 'reconciled with ≥1 worldly (non-judge) acceptance check, dry-run green, suite green (≥1 happy + ≥1 non-happy '
          + 'case), latest debug run verdict ACCOMPLISHED (world-verified, not just COMPLETED), readiness clean — then '
          + 'freezes a YAML export of the graph as an artifact, and stamps the workflow HARDENED. Hardened is what unlocks '
          + 'unattended triggers (cron/webhook/listener). Any graph edit honestly demotes it. On failure, returns each '
          + 'unmet predicate with the exact call that clears it.',
        inputSchema: { type: 'object', properties: { workflowId: { type: 'string' } }, required: ['workflowId'] },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const wf = deps.db.select().from(schema.workflows)
          .where(eq(schema.workflows.id, String(args.workflowId))).get();
        if (!wf || wf.workspaceId !== ctx.workspaceId) throw new Error(`workflow ${args.workflowId} not found`);
        const graph = editableGraph(wf, ctx.workspaceId);
        const settings = (wf.settings as Record<string, unknown>) ?? {};
        const hash = graphContentHash(graph);
        const loop = readBuildLoop(settings);
        const spec = readWorkflowSpec(settings);
        const suiteCases = readWorkflowTests(settings).filter((c) => c.origin !== 'generated');

        const unmet: Array<{ predicate: string; clearWith: { tool: string; args: Record<string, unknown> } }> = [];
        if (!spec) {
          unmet.push({ predicate: 'No spec — success is undefined, so accomplishment cannot be verified.', clearWith: { tool: 'agentis.workflow.scope', args: { workflowId: wf.id } } });
        } else {
          if (spec.reconciledHash !== hash) unmet.push({ predicate: 'Spec is STALE — the graph changed since it was scoped.', clearWith: { tool: 'agentis.workflow.scope', args: { workflowId: wf.id, spec } } });
          if (!spec.acceptance.some((c) => c.verify !== 'judge')) unmet.push({ predicate: 'All acceptance checks are judge-only — at least one WORLDLY check (http_probe/data_probe/expr) is required to trust a workflow unattended.', clearWith: { tool: 'agentis.workflow.scope', args: { workflowId: wf.id } } });
        }
        if (!(loop.dryRun && loop.dryRun.graphHash === hash && loop.dryRun.ok)) {
          unmet.push({ predicate: 'Dry-run is not green at this graph.', clearWith: { tool: 'agentis.workflow.dry_run', args: { workflowId: wf.id } } });
        }
        if (!(loop.suite && loop.suite.graphHash === hash && loop.suite.ok)) {
          unmet.push({ predicate: 'Test suite is not green at this graph.', clearWith: { tool: 'agentis.workflow.test', args: { workflowId: wf.id, action: 'run' } } });
        }
        if (!suiteCases.some((c) => c.kind === 'happy') || !suiteCases.some((c) => c.kind !== 'happy')) {
          unmet.push({ predicate: 'Suite must include ≥1 happy AND ≥1 non-happy (edge/adversarial/regression) kept case.', clearWith: { tool: 'agentis.workflow.test', args: { workflowId: wf.id, action: 'generate' } } });
        }
        const debug = loop.debugRun && loop.debugRun.graphHash === hash ? loop.debugRun : undefined;
        if (!debug || debug.status !== 'COMPLETED') {
          unmet.push({ predicate: 'No clean completed debug run at this graph.', clearWith: { tool: 'agentis.workflow.run', args: { workflowId: wf.id, debugRun: true } } });
        } else if (debug.verdict !== 'accomplished') {
          unmet.push({
            predicate: debug.verdict
              ? `Debug run verdict is ${debug.verdict.toUpperCase()} — completion is not accomplishment. Fix the deficiencies and re-run.`
              : 'Debug run was never VERIFIED (it ran before the spec existed). Re-run it so the verdict engine can prove the outcome.',
            clearWith: { tool: 'agentis.workflow.run', args: { workflowId: wf.id, debugRun: true } },
          });
        }
        let readiness;
        try { readiness = analyzeWorkflowReadiness(deps.db, ctx.workspaceId, graph); } catch { readiness = undefined; }
        if (readiness && !readiness.ready) {
          unmet.push({ predicate: `Readiness: ${readiness.summary}`, clearWith: { tool: 'agentis.workflow.loop_status', args: { workflowId: wf.id } } });
        }

        if (unmet.length > 0) {
          return {
            ok: false,
            hardened: false,
            unmet,
            summary: `NOT hardened — ${unmet.length} unmet predicate(s). Clear them in order; each entry names the exact call.`,
          };
        }

        // All gates pass: freeze the proof.
        const specHash = createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16);
        const doc: WorkflowFile = {
          apiVersion: WORKFLOW_FILE_API_VERSION,
          kind: 'Workflow',
          metadata: { name: wf.title, description: wf.description ?? null },
          spec: { graph },
        };
        const yaml = yamlStringify(doc, { lineWidth: 0 });
        let exportRef: string | undefined;
        try {
          exportRef = randomUUID();
          const now = new Date().toISOString();
          deps.db.insert(schema.artifacts).values({
            id: exportRef,
            workspaceId: ctx.workspaceId,
            userId: ctx.userId,
            type: 'file',
            title: `${wf.title} — hardened@${hash} (frozen YAML)`,
            content: yaml,
            thumbnailUrl: null,
            runId: null,
            workflowId: wf.id,
            agentId: null,
            origin: 'workflow',
            conversationId: null,
            nodeId: null,
            metadata: { name: `${wf.title}.workflow.yaml`, savedBy: 'harden-gate', graphHash: hash, specHash },
            createdAt: now,
            updatedAt: now,
          }).run();
        } catch { exportRef = undefined; }
        const buildLoop = stampBuildLoop(deps.db, wf.id, {
          hardened: { at: new Date().toISOString(), graphHash: hash, specHash, ...(exportRef ? { exportRef } : {}) },
        });
        const candidateRevision = deps.revisions?.candidate(ctx.workspaceId, wf.id);
        let promotion;
        let proofState;
        if (candidateRevision && candidateRevision.revision.semanticHash === hash) {
          // The legacy SWIFT gates above are stricter than the immutable proof
          // gates. Mirror their exact evidence onto the candidate before the
          // single promotion authority performs its compare-and-swap.
          deps.revisions!.recordProof({
            workspaceId: ctx.workspaceId,
            workflowId: wf.id,
            revisionId: candidateRevision.revision.id,
            gate: 'dry_run',
            status: 'passed',
            evidence: { graphHash: hash, legacyBuildLoop: loop.dryRun },
          });
          deps.revisions!.recordProof({
            workspaceId: ctx.workspaceId,
            workflowId: wf.id,
            revisionId: candidateRevision.revision.id,
            gate: 'regression',
            status: 'passed',
            evidence: { graphHash: hash, suite: loop.suite },
          });
          proofState = deps.revisions!.proofState(ctx.workspaceId, wf.id, candidateRevision.revision.id);
          // Publication is scoped to this exact proven revision. App membership
          // must not turn unrelated sibling health into a release blocker.
          if (proofState.readyForPromotion && !proofState.approvalRequired) {
            promotion = deps.revisions!.promote({
              workspaceId: ctx.workspaceId,
              workflowId: wf.id,
              revisionId: candidateRevision.revision.id,
              expectedActiveRevisionId: deps.revisions!.active(ctx.workspaceId, wf.id).revision.id,
              actor: { type: ctx.agentId ? 'agent' : 'system', id: ctx.agentId ?? null },
            });
          }
        }
        recordWorkflowLesson(deps.memory, ctx.workspaceId, {
          failureMode: `Hardening record: "${wf.title}" (${wf.id})`,
          fix: `HARDENED at graph ${hash} on ${new Date().toISOString().slice(0, 10)}: objective "${spec!.objective}"; ${spec!.acceptance.length} acceptance check(s); suite ${loop.suite?.passed}/${loop.suite?.total}; frozen export ${exportRef ?? 'n/a'}. Any edit demotes — re-earn through dry-run → suite → accomplished debug run.`,
        }, ctx.agentId ?? null);
        return {
          ok: true,
          hardened: true,
          outcome: promotion ? 'promoted' : proofState?.approvalRequired ? 'blocked_on_human' : 'hardened',
          activated: Boolean(promotion),
          graphHash: hash,
          specHash,
          ...(candidateRevision ? { candidateRevisionId: candidateRevision.revision.id } : {}),
          ...(promotion ? { promotion } : {}),
          ...(proofState && !proofState.readyForPromotion
            ? {
                verifiedCandidate: true,
                missingPromotionGates: proofState.missing,
                promotionBlocked: proofState.required.includes('operator_approval')
                  ? 'This workflow can send data outward or run code. An administrator must explicitly approve promotion.'
                  : 'The candidate still lacks immutable proof gates.',
              }
            : {}),
          ...(proofState?.approvalRequired && !promotion ? {
            next: {
              tool: 'agentis.workflow.revision.promote',
              args: { workflowId: wf.id, revisionId: candidateRevision?.revision.id },
              why: 'Create an administrator approval request for this exact proven outward/code candidate.',
            },
          } : {}),
          ...(wf.appId && candidateRevision && !promotion ? {
            next: {
              tool: 'agentis.app.deliver',
              args: { appId: wf.appId },
              why: 'App-owned revisions publish only through the authoritative App delivery gate.',
            },
          } : {}),
          ...(exportRef ? { exportRef } : {}),
          compass: compassForWorkflow({ workflowId: wf.id, graph, settings: { ...settings, buildLoop } }),
          summary: promotion
            ? `HARDENED and PROMOTED revision ${promotion.revisionId} at ${hash}. Frozen YAML export saved${exportRef ? ` (artifact ${exportRef})` : ''}.`
            : `HARDENED candidate at ${hash}${proofState?.missing.length ? `; promotion awaits ${proofState.missing.join(', ')}` : ''}. Frozen YAML export saved${exportRef ? ` (artifact ${exportRef})` : ''}.`,
        };
      },
    },
    {
      definition: {
        id: 'agentis.workflow.deliver',
        family: 'build',
        description:
          '[SWIFT — REQUIRED FINALIZATION FOR EVERY USER-REQUESTED WORKFLOW CREATE OR EDIT] Autonomously drive the ENTIRE quality loop and return one honest result. '
          + 'Given a `goal` it BUILDS an App-of-one (or pass `workflowId` to deliver an existing one), then loops: '
          + 'dry-run → run it for REAL (self-heal off) → VERIFY the outcome against the world (probes + judge) → '
          + 'repair the deficient nodes → repeat, bounded. Returns exactly one of: `accomplished` (built + ran + '
          + 'VERIFIED — real result, not just "completed"), `blocked_on_human` (stopped at an approval / missing '
          + 'credential / rate-limit only you can clear — with the exact action), `unverifiable` (ran but has no '
          + 'worldly way to prove success — say how), or `failed` (with the exact deficiencies + the run to diagnose). '
          + 'Use THIS instead of orchestrating scope→build→dry_run→run→harden by hand — it cannot skip a step, '
          + 'misread COMPLETED as success, or loop forever.',
        inputSchema: {
          type: 'object',
          properties: {
            goal: { type: 'string', description: 'What the workflow/app must accomplish. Builds a new App-of-one. Omit if passing workflowId.' },
            workflowId: { type: 'string', description: 'Deliver an EXISTING workflow instead of building a new one.' },
            inputs: { type: 'object', description: 'Sample trigger inputs threaded through the verification run.' },
            maxIterations: { type: 'number', description: 'Build→verify→repair attempts before an honest failure (default 3, max 5).' },
            maxWallMs: { type: 'number', description: 'Total wall-clock budget in ms (default 480000, max 1200000).' },
          },
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        return deliverWorkflow(
          deps,
          {
            workspaceId: ctx.workspaceId,
            userId: ctx.userId,
            ambientId: ctx.ambientId ?? null,
            ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
            ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
          },
          {
            ...(typeof args.goal === 'string' ? { goal: args.goal } : {}),
            ...(typeof args.workflowId === 'string' ? { workflowId: args.workflowId } : {}),
            ...(args.inputs && typeof args.inputs === 'object' && !Array.isArray(args.inputs) ? { inputs: args.inputs as Record<string, unknown> } : {}),
            ...(typeof args.maxIterations === 'number' ? { maxIterations: args.maxIterations } : {}),
            ...(typeof args.maxWallMs === 'number' ? { maxWallMs: args.maxWallMs } : {}),
          },
        );
      },
    },
    {
      definition: {
        id: 'agentis.workflow.patterns',
        family: 'inspect',
        description:
          'Retrieve robust workflow design patterns (WORKFLOW-DESIGN-10X) — proven control-flow shapes for the gates, '
          + 'fallbacks, loops, and rollback the happy path omits: qualify-or-reject-loop, fetch-with-fallback, '
          + 'approval-before-irreversible, validate-before-transition, bounded-parallel-batch, stateful-cursor-dedup. '
          + 'Call WITHOUT id to list them with when-to-use; call with id to get the spliceable node+edge fragment '
          + '(including the reject/fallback/rollback branches) to adapt into your graphDraft. Use these before building '
          + 'anything that qualifies candidates, makes an irreversible action, processes a batch, or runs on a schedule.',
        inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Pattern id to expand into a full fragment. Omit to list all patterns.' } } },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args) => {
        const id = typeof args.id === 'string' && args.id.trim() ? args.id.trim() : null;
        if (id) {
          const pattern = getWorkflowPattern(id);
          if (!pattern) {
            return { error: `unknown pattern: ${id}`, available: WORKFLOW_PATTERNS.map((p) => p.id) };
          }
          return { pattern };
        }
        return {
          patterns: WORKFLOW_PATTERNS.map((p) => ({ id: p.id, title: p.title, doctrine: p.doctrine, when: p.when })),
        };
      },
    },
    {
      definition: {
        id: 'agentis.workflow.learn',
        family: 'build',
        description:
          'Record a durable WORKFLOW LESSON into the workspace playbook after you diagnose and fix a novel run failure '
          + '(a flaky source, a missing gate, an encoding gotcha, a rollback you had to add). Future workflow builds '
          + 'recall these lessons automatically and design around them — this is how the workspace gets smarter over time. '
          + 'Pass failureMode (what went wrong / the situation) and fix (what to do next time), plus an optional patternId.',
        inputSchema: {
          type: 'object',
          properties: {
            failureMode: { type: 'string', description: 'The situation or failure that occurred.' },
            fix: { type: 'string', description: 'What to do next time to avoid or handle it.' },
            patternId: { type: 'string', description: 'Optional robust pattern id that addresses it (see agentis.workflow.patterns).' },
          },
          required: ['failureMode', 'fix'],
        },
        mutating: true,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const failureMode = String(args.failureMode ?? '').trim();
        const fix = String(args.fix ?? '').trim();
        if (!failureMode || !fix) throw new AgentisError('VALIDATION_FAILED', 'failureMode and fix are required');
        const memoryId = recordWorkflowLesson(
          deps.memory,
          ctx.workspaceId,
          { failureMode, fix, ...(typeof args.patternId === 'string' && args.patternId.trim() ? { patternId: args.patternId.trim() } : {}) },
          ctx.agentId,
        );
        if (!memoryId) throw new AgentisError('VALIDATION_FAILED', 'workspace memory is not available to store the lesson');
        const lessonTitle = failureMode.slice(0, 120);
        return {
          recorded: true,
          memoryId,
          title: lessonTitle,
          message: `Lesson saved as "${lessonTitle}" — cite it by its TITLE (searchable in the Brain), never by the raw id. Re-learning the same failure mode updates this lesson in place.`,
        };
      },
    },
  ]);
}

export interface CreateWorkflowArgs {
  workspaceId: string;
  ambientId: string | null;
  userId: string;
  agentId?: string;
  runId?: string;
  description: string;
  title?: string;
  workflowId?: string | null;
  /** Existing App that should own a newly created workflow. Omit for App-of-one. */
  appId?: string;
  /** Agent-authored graph draft. Agentis validates, repairs, enriches, and saves it. */
  graphDraft?: unknown;
  /** Agent-authored edit patch for the target workflow. */
  patchDraft?: unknown;
  /** Acknowledge a deliberate capability change (Organ 2): allows an edit that
   *  removes load-bearing work to save instead of being rejected as green-washing. */
  confirmIntentChange?: boolean;
  /** When true, animate the build (per-node canvas events + small delays). */
  stream?: boolean;
  /**
   * An approved (possibly operator-edited) plan. When present the graph is
   * assembled deterministically from its phases — one node per Phase Card —
   * instead of LLM/regex synthesis. This is what makes inline per-phase edits
   * round-trip: edit a card → rebuild from the plan.
   */
  plan?: WorkflowPlan;
  /**
   * Caller-DECLARED trigger. Wins over keyword inference, which defaults to
   * manual and therefore turns any unattended intent phrased outside its keyword
   * list into a workflow nobody ever starts.
   */
  trigger?: ExplicitTriggerSpec | null;
  /** Cancellation signal from the calling chat turn. Aborts model spend mid-build
   *  when the operator disconnects or the turn deadline fires. */
  signal?: AbortSignal;
}

/**
 * Shared workflow-creation core (ORCHESTRATOR-CREATION-10X). Used by the
 * `build_workflow` chat tool AND the `POST /v1/workflows/build` Builder Session
 * route: assemble the brief, accept an agent-authored draft/patch or synthesize
 * with a configured fast model, then pre-flight, enrich, persist, and stream.
 */
/**
 * Organ-3 green ratchet, shared by build_workflow and workflow.patch (PAVED-ROAD
 * P0 — one door): the set of CRITICAL defects (shape-mismatch edge couplings,
 * approval bypasses) keyed for diffing. An edit may not INTRODUCE one the prior
 * graph lacked; pre-existing red is not a regression.
 */
function criticalDefectKeys(g: WorkflowGraph): Map<string, string> {
  const m = new Map<string, string>();
  for (const i of analyzeEdgeCouplings(g)) m.set(`couple:${i.nodeId}:${i.identifier ?? i.message}`, `${i.nodeTitle ?? i.nodeId}: ${i.message}`);
  for (const v of checkIntentIntegrity(g)) if (v.code === 'AUTO_APPROVAL_BYPASS') m.set(`approval:${v.nodeId ?? ''}`, v.message);
  return m;
}

function introducedRegressions(prior: WorkflowGraph, next: WorkflowGraph): string[] {
  const before = criticalDefectKeys(prior);
  const introduced: string[] = [];
  for (const [k, msg] of criticalDefectKeys(next)) if (!before.has(k)) introduced.push(msg);
  return introduced;
}

export async function createWorkflowFromDescription(deps: ToolHandlerDeps, args: CreateWorkflowArgs) {
  deps = { ...deps, revisions: deps.revisions ?? new WorkflowRevisionService(deps.db) };
  const description = args.description.trim();
  const appStore = new AppStore(deps.db);
  if (args.appId) appStore.get(args.workspaceId, args.appId); // ownership validation before model spend
  // Resolve the target workflow. An explicit id (or the conversation latch, which
  // the chat handler resolves before calling us) wins. Otherwise, GUARD against
  // duplicate creation: the SAME request can reach this core twice via different
  // latch keys the per-conversation latch can't span — a retried/duplicated chat
  // turn, or a chat build racing an mcp_native harness building over MCP. A
  // workspace-level, content-addressed window catches all of them, so one request
  // can't yield two near-identical workflows. (Distinct requests have distinct
  // text → distinct key → never wrongly merged.)
  let existingWorkflowId = args.workflowId ?? null;
  let deduplicatedRequest = false;
  const recentCandidateId = recentDuplicateWorkflowId(deps, args.workspaceId, description);
  const recentSameRequestId = recentCandidateId && args.appId
    ? (appStore.appIdForWorkflow(args.workspaceId, recentCandidateId) === args.appId ? recentCandidateId : null)
    : recentCandidateId;
  if (!existingWorkflowId) {
    if (recentSameRequestId) {
      existingWorkflowId = recentSameRequestId;
      deduplicatedRequest = true;
      deps.logger.info('createWorkflow.dedup_reuse', { workspaceId: args.workspaceId, workflowId: recentSameRequestId, agentId: args.agentId ?? null });
    }
  } else if (recentSameRequestId === existingWorkflowId) {
    // The target (from an explicit id or the conversation latch) is a workflow we
    // JUST built from this EXACT request — a byte-identical repeat, not a
    // refinement. Dedup it (return the current graph) so a re-issue of the same
    // request never demands a synthesis model merely to reproduce itself. A
    // genuinely different description has a different content key, so real
    // refinements still take the revise path below.
    deduplicatedRequest = true;
    deps.logger.info('createWorkflow.dedup_reuse', { workspaceId: args.workspaceId, workflowId: existingWorkflowId, agentId: args.agentId ?? null, viaLatch: true });
  }
  const storedExistingWorkflow = existingWorkflowId
    ? deps.db.select().from(schema.workflows).where(eq(schema.workflows.id, existingWorkflowId)).get()
    : null;
  const existingCandidate = storedExistingWorkflow && deps.revisions
    ? deps.revisions.candidate(args.workspaceId, storedExistingWorkflow.id)
    : null;
  const existingWorkflow = storedExistingWorkflow && existingCandidate
    ? { ...storedExistingWorkflow, graph: existingCandidate.graph, contentHash: existingCandidate.revision.semanticHash }
    : storedExistingWorkflow;
  if (existingWorkflowId && (!existingWorkflow || existingWorkflow.workspaceId !== args.workspaceId)) {
    throw new Error(`workflow ${existingWorkflowId} not found`);
  }
  if (existingWorkflow && args.appId && existingWorkflow.appId && existingWorkflow.appId !== args.appId) {
    throw new AgentisError('RESOURCE_CONFLICT',
      `workflow ${existingWorkflow.id} already belongs to App ${existingWorkflow.appId}; refusing to move it implicitly to App ${args.appId}`);
  }
  const title = String(args.title ?? existingWorkflow?.title ?? titleFromDescription(description));
  const persistedDescription = existingWorkflow?.description ?? description;
  const workflowId = existingWorkflowId ?? randomUUID();
  if (deduplicatedRequest && existingWorkflow) {
    const graph = existingWorkflow.graph as WorkflowGraph;
    const dedupAppId = new AppStore(deps.db).appIdForWorkflow(args.workspaceId, workflowId);
    return {
      workflowId,
      appId: dedupAppId,
      runId: args.runId ?? `build_${workflowId}`,
      title,
      description: persistedDescription,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      graph,
      deduplicated: true,
      warnings: [] as PreflightWarning[],
      compass: compassForWorkflow({ workflowId, appId: dedupAppId, graph, settings: existingWorkflow.settings }),
      message: `Workflow "${title}" already reflects this request.`,
    };
  }
  const streamRunId = args.runId ?? `build_${workflowId}`;
  const pubCtx = { workspaceId: args.workspaceId, agentId: args.agentId, runId: streamRunId };
  // Inspectable phase narration — every stage is broadcast so the chat can show
  // a live, fully-inspectable build timeline (no silent steps). (§6.)
  const phase = (name: string, detail?: string) =>
    publishCanvas(deps, pubCtx, REALTIME_EVENTS.WORKFLOW_BUILD_PHASE, {
      workflowId, runId: streamRunId, agentId: args.agentId ?? null, phase: name, ...(detail ? { detail } : {}),
    });

  // Cancellation: when the chat turn that started this build is aborted (operator
  // disconnected / turn deadline), stop BEFORE each model-spending stage instead
  // of running the full ~6-call pipeline into the void. Cheap stage-boundary checks
  // here + in-flight HTTP abort in the runtimes together stop abandoned spend.
  const throwIfCanceled = () => {
    if (args.signal?.aborted) {
      throw new AgentisError('OPERATION_CANCELED', 'Build canceled — the chat turn ended before it finished.');
    }
  };

  phase('analyzing', 'Reading your request and workspace inventory');
  const briefInput = existingWorkflow
    ? `${existingWorkflow.description ?? existingWorkflow.title}\nRequested change: ${description}`
    : description;
  const brief = await assembleCreationBrief(deps, args.workspaceId, args.agentId, briefInput);
  throwIfCanceled();
  // ── Stage 1: accept an agent draft/plan, or synthesize with a fast model ──
  phase('drafting');
  const synthCompleter = resolveSynthesisCompleter(deps, args.workspaceId, args.agentId, description);
  const synthModelAvailable = Boolean(synthCompleter);
  let rawGraphBase: WorkflowGraph;
  let synthesis: 'plan' | 'llm' | 'agent_draft' | 'agent_patch';
  if (args.plan && args.plan.phases.length > 0) {
    rawGraphBase = assembleGraphFromPlan(args.plan, description, args.trigger);
    synthesis = 'plan';
  } else if (args.patchDraft !== undefined) {
    if (!existingWorkflow) {
      phase('blocked', 'A workflowId is required before a patch draft can be applied');
      throw new AgentisError(
        'WORKFLOW_DRAFT_INVALID',
        'patchDraft can only update an existing workflow. Pass workflowId, or pass a complete graphDraft for a new workflow.',
      );
    }
    rawGraphBase = applyWorkflowMutationPatch(existingWorkflow.graph as WorkflowGraph, args.patchDraft);
    assertMutationPreservesGraph(existingWorkflow.graph as WorkflowGraph, rawGraphBase, description);
    validateWorkflowGraph(rawGraphBase);
    synthesis = 'agent_patch';
    phase('drafting', 'Accepted the agent-authored workflow patch');
  } else if (args.graphDraft !== undefined) {
    rawGraphBase = parseAgentGraphDraft(args.graphDraft);
    validateWorkflowGraph(rawGraphBase);
    if (existingWorkflow) {
      assertMutationPreservesGraph(existingWorkflow.graph as WorkflowGraph, rawGraphBase, description);
    }
    synthesis = 'agent_draft';
    phase('drafting', 'Accepted the agent-authored workflow graph');
  } else if (!synthCompleter) {
    // A runtime-native caller must never be forced to reverse-engineer an
    // internal graph shape. When no independent synthesis runtime is available,
    // produce the same safe, editable baseline the planner uses. The normal
    // enrich/validation/publish gates still run below.
    const deterministicPlan = planWorkflow(description, brief.classification);
    rawGraphBase = assembleGraphFromPlan(deterministicPlan, description, args.trigger);
    synthesis = 'plan';
    phase('drafting', 'Created a deterministic editable draft (no synthesis runtime was available)');
  } else {
    const outcome = await synthesizeWithLlm(
      description,
      deps,
      args.workspaceId,
      synthCompleter,
      brief,
      args.signal,
      existingWorkflow
        ? { id: existingWorkflow.id, title: existingWorkflow.title, graph: existingWorkflow.graph as WorkflowGraph }
        : undefined,
    );
    if (!outcome.graph) {
      // Surface the backend or validation error so the operator can act on the
      // real failure instead of receiving a fabricated fallback graph.
      const runtimeFailure = isSynthesisRuntimeFailure(outcome.error);
      const detail = runtimeFailure
        ? `Workflow synthesis runtime failed${outcome.error ? `: ${outcome.error}` : ''}`
        : outcome.error
          ? `The workflow draft failed validation: ${outcome.error}`
          : 'The model did not produce a workflow graph';
      phase('blocked', detail);
      throw new AgentisError(
        'WORKFLOW_SYNTHESIS_UNAVAILABLE',
        runtimeFailure
          ? `Workflow synthesis could not reach a healthy model runtime${outcome.error ? ` (${outcome.error})` : ''}. The selected model was not rejected for capability; Agentis exhausted the transient runtime retry. Check the runtime connection and retry.`
          : `The model returned a workflow that Agentis could not validate${outcome.error ? ` (${outcome.error})` : ''}. Retry the request or inspect the validation detail.`,
      );
    } else {
      rawGraphBase = outcome.graph;
      synthesis = 'llm';
    }
  }
  const draftDetail = synthesis === 'llm'
    ? 'Synthesized with the orchestrator model'
    : synthesis === 'agent_draft'
      ? 'Validated an agent-authored graph draft'
      : synthesis === 'agent_patch'
        ? 'Applied an agent-authored workflow patch'
        : 'Assembled from your approved plan';
  phase('drafting', draftDetail);

  // ── Stage 2: deterministic structural repair (Iron Rules) ──
  const repaired = repairGraph(rawGraphBase, brief.classification, brief.inventory);
  let workingGraph = repaired.graph;
  const repairs: RepairAction[] = [...repaired.repairs];
  if (repaired.repairs.length > 0) {
    phase('repairing', `${repaired.repairs.length} structural fix(es)`);
    for (const r of repaired.repairs) {
      publishCanvas(deps, pubCtx, REALTIME_EVENTS.WORKFLOW_BUILD_REPAIR, { workflowId, runId: streamRunId, repair: r });
    }
  }

  // ── Stage 3: LLM reviewer/critic loop (audits vs the Iron Rules, repairs) ──
  // Skipped when the ONLY available model is a slow per-call CLI harness: the
  // reviewer is a second set of round-trips, and the deterministic repairGraph
  // above already enforces the Iron Rules structurally. This keeps a CLI-only
  // setup fast (seconds) instead of doubling an already-slow build.
  const critiques: BuildCritique[] = [];
  let reviewRounds = 0;
  const reviewer = synthesis === 'llm' && !buildOnlyHasSlowPath(deps, args.workspaceId, args.agentId, description)
    ? resolveReviewerCompleter(deps, args.workspaceId, args.agentId, description)
    : undefined;
  if (reviewer) {
    phase('reviewing', 'Auditing the graph against the workflow grammar');
    for (let round = 0; round < 2; round += 1) {
      throwIfCanceled();
      let review;
      try {
        review = await reviewWorkflowGraph(reviewer, { graph: workingGraph, description, brief }, args.signal);
      } catch (err) {
        deps.logger.warn('reviewWorkflowGraph.failed', { err: (err as Error).message });
        break;
      }
      reviewRounds += 1;
      for (const c of review.critiques) {
        critiques.push(c);
        publishCanvas(deps, pubCtx, REALTIME_EVENTS.WORKFLOW_BUILD_CRITIQUE, { workflowId, runId: streamRunId, critique: c });
      }
      if (!review.repairedGraph) break;
      // Re-apply deterministic repair to the reviewer's graph + adopt if valid.
      const reRepaired = repairGraph(review.repairedGraph, brief.classification, brief.inventory);
      try {
        validateWorkflowGraph(reRepaired.graph);
        if (existingWorkflow) {
          assertMutationPreservesGraph(
            existingWorkflow.graph as WorkflowGraph,
            reRepaired.graph,
            description,
          );
        }
        workingGraph = reRepaired.graph;
        repairs.push(...reRepaired.repairs);
      } catch {
        break; // reviewer produced an invalid graph — keep the prior one
      }
      if (review.critiques.every((c) => c.severity !== 'error')) break;
    }
  }

  throwIfCanceled();
  // F7 — materialize the cast: commission a real specialist agent per role and
  // pin it to its node, so the team is real and visible right after the build.
  if (!existingWorkflow) {
    workingGraph = normalizeGeneratedRalRequirements(workingGraph);
  }
  const casting = materializeCast(workingGraph, deps, args.workspaceId, args.userId);
  workingGraph = casting.graph;
  if (casting.cast.length > 0) {
    const created = casting.cast.filter((c) => c.created).length;
    phase('building', created > 0
      ? `Commissioned ${created} specialist${created === 1 ? '' : 's'} for the cast`
      : `Cast ${casting.cast.length} specialist${casting.cast.length === 1 ? '' : 's'}`);
  }

  // F5 — "email me" should need zero setup: fill the operator's own address into
  // a self-directed email delivery node that has no recipient.
  const selfDelivery = fillSelfDeliveryRecipient(workingGraph, deps, args.userId, description);
  workingGraph = selfDelivery.graph;
  if (selfDelivery.filled) phase('repairing', 'Set the email recipient to your account');

  const emailDelivery = ensureEmailDeliveryInputs(workingGraph, description);
  workingGraph = emailDelivery.graph;
  if (emailDelivery.completed) {
    phase(
      'repairing',
      emailDelivery.recipientFromRequest
        ? 'Completed the email delivery details from your request'
        : 'Completed the email delivery subject and content',
    );
  }

  const preflight = preflightAndEnrich(workingGraph, brief.inventory);
  // Normalize integration operation names to each connector's REAL catalog so
  // synthesized nodes actually run (e.g. agentmail `send_email` → `send_message`)
  // — for EVERY integration, never one connector at a time. Otherwise the run
  // dies at execute() with "operation 'X' is not supported by Y".
  const operationCatalog = Object.fromEntries(
    listIntegrationManifests(deps.db, args.workspaceId).map((m) => [m.service.toLowerCase(), m.operations]),
  );
  const opFix = repairIntegrationOperations(preflight.graph, operationCatalog);
  for (const r of opFix.repairs) {
    repairs.push({ rule: 14, kind: 'integration_operation_normalized', nodeId: r.nodeId, message: `Corrected ${r.integration} operation "${r.from}" → "${r.to}".` });
    if (args.stream) phase('repairing', `Corrected ${r.integration} operation → ${r.to}`);
  }
  // Expression-contract gate (WORKFLOW-RELIABILITY Phase 1/2) — catch broken JS
  // expressions BEFORE they ship. Deterministically repair near-miss references
  // (`noeds`→`nodes`); surface anything still off-contract (`payload.x`, a syntax
  // error) as a build warning on the same surface the operator already sees, so a
  // transform that would die at run time with "X is not defined" never escapes.
  const exprFix = repairGraphExpressions(opFix.graph);
  for (const r of exprFix.repairs) {
    repairs.push({ rule: 15, kind: 'expression_reference_repaired', nodeId: r.nodeId, message: `Fixed expression reference "${r.from}" → "${r.to}" in ${r.field}.` });
    if (args.stream) phase('repairing', `Fixed expression reference ${r.from} → ${r.to}`);
  }
  // Sample-data dry run (P4.1): thread a representative sample from the
  // inputContract + declared output keys through the graph and evaluate every
  // expression against realistic upstream data — catches references the empty
  // static probe masks behind a data access.
  for (const issue of dryRunGraphExpressions(exprFix.graph)) {
    preflight.warnings.push({ code: 'INVALID_EXPRESSION', nodeId: issue.nodeId, message: `${issue.field}: ${issue.message}` });
  }
  // P0.5 — input-reachability: a node that narrows its input (inputKeys /
  // inputMapping) but references a field it just dropped gets undefined at run
  // time (the silent "empty payload" class). Catch it before save.
  for (const issue of analyzeInputReachability(exprFix.graph)) {
    preflight.warnings.push({ code: 'INVALID_EXPRESSION', nodeId: issue.nodeId, message: `${issue.field}: ${issue.message}` });
  }
  // Organ 1 — typed edge couplings: a node reads a key its upstream provably does
  // not produce (the silent shape-mismatch behind the Fashion Store bug). Named at
  // build time instead of an undefined at run time.
  for (const issue of analyzeEdgeCouplings(exprFix.graph)) {
    preflight.warnings.push({ code: 'INVALID_EXPRESSION', nodeId: issue.nodeId, message: `${issue.field}: ${issue.message}` });
  }
  // Robustness audit (WORKFLOW-DESIGN-10X Phase 2) — enforce the design doctrine
  // deterministically: flag missing gates/state/reject-branches/failure-handling
  // and auto-repair the safe ones (bound an unbounded batch). Warnings ride the
  // same surface the operator already sees; repairs are narrated like any other.
  const robustness = auditWorkflowRobustness(exprFix.graph, brief.classification);
  for (const w of robustness.warnings) preflight.warnings.push(w);
  for (const r of robustness.repairs) {
    repairs.push({ rule: 6, kind: 'robustness_bound', message: r });
    if (args.stream) phase('repairing', r);
  }
  const missingDeliverySink = robustness.warnings.find((warning) => warning.code === 'MISSING_DELIVERY_SINK');
  if (missingDeliverySink) {
    phase('blocked', 'External delivery is not backed by a native executable node');
    throw new AgentisError(
      'WORKFLOW_DRAFT_INVALID',
      `Workflow preflight failed before save: ${missingDeliverySink.message}`,
    );
  }
  // Tidy the graph with the shared layered layout so it's readable and framable
  // the instant it lands on the canvas — AI models place nodes arbitrarily.
  const laidOutGraph = layoutBuiltWorkflowGraph(robustness.graph, {
    existingWorkflow: Boolean(existingWorkflow),
    replacePhases: synthesis === 'plan' || wantsPhaseOrganization(description),
  });
  const graph = ensureNodeDisplayFields(laidOutGraph);
  const teamRoster = buildTeamRoster(graph, brief.inventory);
  const deliveryPreview = buildDeliveryPreview(graph);
  const approvalRequired = hasManualApprovalBeforeDelivery(graph);
  validateWorkflowGraph(graph, { strict: false });

  // Organ 2 — Intent Contract (anti-green-washing): flag the `|| true` approval
  // bypass, and — vs the capability manifest stored at the last build — any edit
  // that hollows out the workflow's load-bearing work (removed agent workers /
  // fetch steps / integrations / persistence). Then record the current signature.
  const priorIntent = (existingWorkflow?.settings as { intentManifest?: IntentManifest } | null)?.intentManifest ?? null;
  const intentViolations = checkIntentIntegrity(graph, priorIntent);
  // Approval integrity is UNAMBIGUOUS — a `|| true` (or constant) before an
  // irreversible action is always wrong. Hard-block the save (new or edit).
  const approvalBypass = intentViolations.filter((v) => v.code === 'AUTO_APPROVAL_BYPASS');
  if (approvalBypass.length > 0) {
    phase('blocked', 'Approval bypass — an irreversible action can self-approve');
    throw new AgentisError('WORKFLOW_DRAFT_INVALID',
      `Rejected (Organ 2 — approval integrity): ${approvalBypass.map((v) => v.message).slice(0, 2).join(' | ')}`);
  }
  // Capability removal (edit only, vs the stored manifest) is the green-washing
  // signal — hard-block UNLESS the caller explicitly acknowledges the intent change.
  const capabilityRemoved = intentViolations.filter((v) => v.code === 'CAPABILITY_REMOVED');
  if (capabilityRemoved.length > 0 && !args.confirmIntentChange) {
    phase('blocked', 'Capability removed — would hollow out the workflow');
    throw new AgentisError('WORKFLOW_DRAFT_INVALID',
      `Rejected (Organ 2 — this edit hollows out the workflow): ${capabilityRemoved.map((v) => v.message).slice(0, 2).join(' | ')} `
      + 'If this intent change is deliberate, retry with confirmIntentChange: true.');
  }
  for (const v of capabilityRemoved) preflight.warnings.push({ code: v.code, ...(v.nodeId ? { nodeId: v.nodeId } : {}), message: v.message });
  const intentManifest = deriveIntentManifest(graph, description);

  // Organ 3 — Atomic Evolution (green ratchet): reject an EDIT that INTRODUCES a
  // critical regression the prior graph did not have (a new shape-mismatch coupling
  // error, or an approval bypass). The workflow never persists a regression — this
  // kills the whack-a-mole where "fix A" silently breaks B. New workflows are exempt.
  if (existingWorkflow) {
    const introduced = introducedRegressions(existingWorkflow.graph as WorkflowGraph, graph);
    if (introduced.length > 0) {
      phase('blocked', `Edit rejected — introduced ${introduced.length} regression(s)`);
      throw new AgentisError(
        'WORKFLOW_DRAFT_INVALID',
        `This edit would REGRESS the workflow (Organ 3 keeps it green): it introduces ${introduced.length} critical issue(s) the prior graph did not have — `
        + `${introduced.slice(0, 3).join(' | ')}. The workflow was NOT changed; fix the edit and retry.`,
      );
    }
  }

  // Translate a natural-language schedule ("every day at 15:05 Brasília") into a
  // correct UTC cron on a REAL, linked trigger row — instead of leaving the cron
  // wrong and the trigger an inert visual. Created paused (no silent autonomous
  // spend); surfaced as a one-click "activate the schedule" readiness item.
  const scheduled = applyScheduleTrigger(deps, args, graph, workflowId);
  if (scheduled) {
    preflight.warnings.push({
      code: 'SCHEDULE_INACTIVE',
      nodeId: scheduled.nodeId,
      message: `Runs on a schedule (${scheduled.detail}). Activate the trigger to start automatic runs.`,
    });
    if (args.stream) phase('building', `Scheduled — ${scheduled.detail}`);
  }

  const health = relaxBuildOnlyEmailRecipientIssue(preflightWorkflow({
    db: deps.db,
    workspaceId: args.workspaceId,
    workflowId,
    graph,
  }), graph, description);
  if (health.status === 'blocked') {
    const first = health.issues.find((issue) => issue.severity === 'error');
    // Surface the precise issue AND its remediation so the building agent gets a
    // machine-actionable fix (e.g. "extension uses require(...) — use ctx.http.fetch")
    // instead of a vague "simulation failed" it can only retry blindly.
    const detail = first
      ? `${first.nodeTitle ? `${first.nodeTitle}: ` : ''}${first.message}${first.remediation ? ` — ${first.remediation}` : ''}`
      : 'The deterministic workflow simulation failed.';
    phase('blocked', detail);
    throw new AgentisError('WORKFLOW_DRAFT_INVALID', `Workflow preflight failed before save: ${detail}`);
  }

  const trace = {
    synthesis,
    synthModelAvailable,
    reviewed: reviewRounds > 0,
    reviewRounds,
    repairs,
    critiques,
    archetype: brief.classification.archetype,
    warnings: preflight.warnings,
    health,
  };

  const now = new Date().toISOString();
  const emptyGraph: WorkflowGraph = { ...graph, nodes: [], edges: [] };
  // When streaming, persist an empty graph first so nodes animate in; otherwise
  // persist the full graph in one shot.
  const initialGraph = emptyGraph;
  if (!existingWorkflow) {
    deps.db.insert(schema.workflows).values({
      id: workflowId,
      workspaceId: args.workspaceId,
      ambientId: args.ambientId,
      userId: args.userId,
      title,
      description: persistedDescription,
      graph: initialGraph,
      contentHash: hashWorkflowGraph(initialGraph),
      settings: { intentManifest },
      concurrencyOverflow: 'queue',
      createdAt: now,
      updatedAt: now,
    }).run();
  }

  // Agentis ships Agentic Apps, not bare workflows. A workflow is the *logic*
  // layer of an App — so every newly built workflow is anchored to an App-of-one
  // immediately, and a naked, ownerless workflow can't exist. An existing
  // workflow keeps its current owner (which may be null for legacy rows). The
  // resolved `appId` rides the build result + CANVAS_BUILD_COMPLETE event so the
  // chat opens the App, never the raw workflow canvas.
  let appId: string | null = null;
  if (existingWorkflow) {
    appId = appStore.appIdForWorkflow(args.workspaceId, workflowId);
    if (!appId && args.appId) {
      appStore.adoptWorkflow(args.workspaceId, args.appId, workflowId);
      appId = args.appId;
    }
  } else if (args.appId) {
    appStore.adoptWorkflow(args.workspaceId, args.appId, workflowId);
    appId = args.appId;
  } else {
    const wrap = appStore.create(
      args.workspaceId,
      args.userId,
      createAppSchema.parse({ name: title, description: persistedDescription, entryWorkflowId: workflowId }),
    );
    appId = wrap.id;
    if (args.stream) phase('building', `Wrapped in app "${title}"`);
  }

  // Persist the linked cron trigger row now that the workflow row exists (FK).
  // Idempotent on rebuild: update the existing row in place. Stored UTC, so the
  // trigger config timezone stays UTC (TriggerRuntime's default) — sourceTimezone
  // is informational only.
  if (scheduled) {
    const cronConfig = { expression: scheduled.cron, ...(scheduled.timezone ? { sourceTimezone: scheduled.timezone } : {}) };
    const existingTrigger = deps.db.select().from(schema.triggers).where(eq(schema.triggers.id, scheduled.triggerId)).get();
    if (existingTrigger) {
      deps.db.update(schema.triggers)
        .set({ triggerType: 'cron', config: cronConfig, updatedAt: now })
        .where(eq(schema.triggers.id, scheduled.triggerId))
        .run();
    } else {
      deps.db.insert(schema.triggers).values({
        id: scheduled.triggerId,
        workspaceId: args.workspaceId,
        ambientId: args.ambientId ?? null,
        workflowId,
        userId: args.userId,
        triggerType: 'cron',
        config: cronConfig,
        status: 'paused',
      }).run();
    }
  }

  // Remember this build so an immediate repeat of the SAME request (any caller,
  // any conversation) updates this workflow instead of spawning a twin.
  rememberRecentBuild(args.workspaceId, description, workflowId);

  phase('building', `Placing ${graph.nodes.length} node(s)`);
  publishCanvas(deps, pubCtx, REALTIME_EVENTS.AGENT_WORK_STEP, {
    workflowId, runId: streamRunId, agentId: args.agentId ?? null,
    description: `Building "${title}"`, step: 'build_start',
  });
  // §3/§9 — announce the cast specialist team before any node appears, so the
  // operator sees who's building (and who's offline) before the graph streams.
  if (teamRoster.length > 0) {
    publishCanvas(deps, pubCtx, REALTIME_EVENTS.WORKFLOW_TEAM_ROSTER, {
      workflowId, runId: streamRunId, agentId: args.agentId ?? null, roster: teamRoster,
    });
  }

  for (const node of graph.nodes) {
    if (args.stream) await sleep(120);
    // Phase metadata must travel with the node, not only in the final saved
    // graph.  The canvas receives these events while the build is in progress;
    // without it it can place nodes live but cannot render their phase bands
    // until a refresh fetches the finished workflow.
    const nodePhase = graph.phases?.find((phase) => phase.nodeIds.includes(node.id));
    publishCanvas(deps, pubCtx, REALTIME_EVENTS.CANVAS_NODE_PLACED, {
      workflowId, appId, runId: streamRunId, agentId: args.agentId ?? null,
      node: { id: node.id, type: 'default', position: node.position, data: { label: node.title, kind: node.config.kind } },
      ...(nodePhase ? {
        phase: {
          id: nodePhase.id,
          name: nodePhase.name,
          color: nodePhase.color,
          nodeIds: [node.id],
        },
      } : {}),
      nodeLabel: node.title, reason: nodeReason(node),
    });
    publishCanvas(deps, pubCtx, REALTIME_EVENTS.AGENT_WORK_STEP, {
      workflowId, runId: streamRunId, agentId: args.agentId ?? null,
      description: `Added ${node.title}`, step: 'node_placed',
    });
  }

  for (const edge of graph.edges) {
    if (args.stream) await sleep(60);
    publishCanvas(deps, pubCtx, REALTIME_EVENTS.CANVAS_EDGE_CONNECTED, {
      workflowId, runId: streamRunId, agentId: args.agentId ?? null,
      edge: { id: edge.id, source: edge.source, target: edge.target },
      from: graph.nodes.find((n) => n.id === edge.source)?.title ?? edge.source,
      to: graph.nodes.find((n) => n.id === edge.target)?.title ?? edge.target,
    });
  }

  if (args.stream || existingWorkflow) {
    deps.db.update(schema.workflows)
      .set({
        title,
        description: persistedDescription,
        settings: { ...((existingWorkflow?.settings as Record<string, unknown>) ?? {}), intentManifest },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workflows.id, workflowId))
      .run();
  }
  if (!deps.revisions) {
    throw new AgentisError('WORKFLOW_DRAFT_INVALID', 'Immutable workflow revision service is unavailable.');
  }
  phase('complete', `${graph.nodes.length} node(s), ${repairs.length} repair(s), ${critiques.length} critique(s)`);
  publishCanvas(deps, pubCtx, REALTIME_EVENTS.CANVAS_BUILD_COMPLETE, {
    workflowId, runId: streamRunId, appId, agentId: args.agentId ?? null,
    nodeCount: graph.nodes.length, edgeCount: graph.edges.length,
    warnings: preflight.warnings, estimatedCostCents: preflight.estimatedCostCents,
    archetype: brief.classification.archetype, trace,
  });
  const warnSummary = preflight.warnings.length > 0
    ? ` ${preflight.warnings.length} item(s) need attention: ${preflight.warnings.slice(0, 3).map((w) => w.message).join(' ')}`
    : '';
  // SWIFT — AUTO-SCOPE (enforcement): every workflow is born with acceptance
  // criteria so it is VERIFIED by default, not just "completed". Without this
  // the verdict engine only runs when an agent separately calls
  // agentis.workflow.scope — which the common build→run→"done" path skips, so a
  // run reports COMPLETED while the world holds nothing. We derive a spec here
  // (deploy→URL probe, "N products"→floor, persist→data probe, else judge +
  // the elicitation question) unless the caller already scoped one. Debug runs
  // get the full verdict (judge included) so the building agent gets an honest
  // signal while iterating; production defaults to probes_only to bound cost.
  let autoScoped: WorkflowSpec | undefined;
  let scopeQuestion: string | undefined;
  try {
    const currentRow = deps.db.select({ settings: schema.workflows.settings }).from(schema.workflows).where(eq(schema.workflows.id, workflowId)).get();
    const currentSettings = (currentRow?.settings as Record<string, unknown> | null) ?? {};
    if (!readWorkflowSpec(currentSettings)) {
      const services = await runnableServicesForSpec(deps, args.workspaceId);
      const derived = deriveSpecDraft({ description, services, graph });
      const spec: WorkflowSpec = { ...derived.spec, verification: 'probes_only', reconciledHash: graphContentHash(graph) };
      if (validateWorkflowSpec(spec, { knownServices: services, graph }).length === 0) {
        deps.db.update(schema.workflows)
          .set({ settings: { ...currentSettings, spec }, updatedAt: new Date().toISOString() })
          .where(eq(schema.workflows.id, workflowId))
          .run();
        autoScoped = spec;
        scopeQuestion = derived.question;
      }
    }
  } catch (err) {
    deps.logger.warn('createWorkflow.autoscope_failed', { workflowId, error: (err as Error).message });
  }
  const revisionBase = deps.revisions.candidate(args.workspaceId, workflowId)?.revision
    ?? deps.revisions.ensureWorkflow(args.workspaceId, workflowId).active;
  const candidateRevision = deps.revisions.createCandidate({
    workspaceId: args.workspaceId,
    workflowId,
    graph,
    baseRevisionId: revisionBase.id,
    source: 'agent_build',
    actor: { type: args.agentId ? 'agent' : 'user', id: args.agentId ?? args.userId },
    reason: existingWorkflow ? `Agent refinement: ${description}` : `Initial agent build: ${description}`,
  }).revision;

  // PAVED-ROAD P1 — stamp durable loop-state (authored + gated at this graph
  // hash; prior dry-run/debug evidence goes stale by hash) and hand back the
  // compass: the exact next call on the Paved Road. Stamped AFTER the final
  // settings write above so it is never clobbered.
  const buildLoop = stampBuildLoop(deps.db, workflowId, {
    graphHash: graphContentHash(graph),
    validatedAt: new Date().toISOString(),
  });
  const compass = compassForWorkflow({
    workflowId,
    appId,
    graph,
    settings: { buildLoop },
    openIssueCount: preflight.warnings.length,
  });
  return {
    workflowId,
    appId,
    runId: streamRunId,
    title,
    description: persistedDescription,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    archetype: brief.classification.archetype,
    warnings: preflight.warnings,
    estimatedCostCents: preflight.estimatedCostCents,
    // F8 — pre-run trust signals: how long it'll take and what it will deliver.
    estimatedDurationMs: estimateDurationMs(graph),
    deliveryPreview,
    approvalRequired,
    cast: casting.cast,
    teamRoster,
    plan: brief.classification.archetype === 'enterprise' ? planWorkflow(description, brief.classification) : undefined,
    graph,
    health,
    trace,
    compass,
    ...(autoScoped ? { acceptance: { objective: autoScoped.objective, checks: autoScoped.acceptance.map((c) => ({ id: c.id, claim: c.claim, verify: c.verify })), ...(scopeQuestion ? { needsVerificationInput: scopeQuestion } : {}) } } : {}),
    message: `Workflow "${title}" built with ${graph.nodes.length} nodes (${brief.classification.archetype}).`
      + ` Est. ~${Math.max(1, Math.round(estimateDurationMs(graph) / 1000))}s/run`
      + (preflight.estimatedCostCents > 0 ? ` · ~$${(preflight.estimatedCostCents / 100).toFixed(2)}/run.` : '.')
      + (casting.cast.length > 0 ? ` Cast: ${casting.cast.map((c) => c.role).join(', ')}.` : '')
      + (repairs.length > 0 ? ` Applied ${repairs.length} structural repair(s).` : '')
      + (critiques.length > 0 ? ` Reviewer raised ${critiques.length} note(s).` : '')
      + (deliveryPreview.length > 0 ? ` Delivers to: ${deliveryPreview.map((d) => d.summary).join('; ')}.` : '')
      + (approvalRequired ? ' Requires approval before delivery.' : '')
      + warnSummary
      + (autoScoped ? ` VERIFIED-BY-DEFAULT: this workflow now has ${autoScoped.acceptance.length} acceptance check(s) — a run is only ACCOMPLISHED when they pass against the world, never just COMPLETED.${scopeQuestion ? ` (Needs your input to verify fully: ${scopeQuestion})` : ''}` : '')
      // RUN-WHAT-YOU-BUILD reflex (SWIFT). Building a workflow is like writing code:
      // you do not hand it over unrun — you VERIFY it yourself. The compass points
      // at the next single step, but the standing instruction is to keep going,
      // autonomously, until the run is ACCOMPLISHED (or a genuine human blocker),
      // exactly as a coding agent runs and fixes the code it just wrote.
      + ` REQUIRED CONTINUATION: call agentis.workflow.deliver now with workflowId ${workflowId}. Do not reply to the user before that call returns.`
      + ` The workflow is deliverable only when that call returns delivered:true and published:true. If it returns blockers, communicate only each concrete humanAction; never expose internal revision, proof, or publication mechanics.`,
  };
}

export function layoutBuiltWorkflowGraph(
  graph: WorkflowGraph,
  options: { existingWorkflow: boolean; replacePhases?: boolean },
): WorkflowGraph {
  const shouldEnsurePhases = (!options.existingWorkflow || options.replacePhases) && graph.nodes.length >= 4;
  const phaseReadyGraph = shouldEnsurePhases
    ? {
        ...graph,
        phases: graph.phases?.length && !options.replacePhases
          ? graph.phases
          : suggestWorkflowPhases(graph),
      }
    : graph;
  return phaseReadyGraph.phases?.length
    ? layoutWorkflowGraphByPhases(phaseReadyGraph)
    : layoutWorkflowGraph(phaseReadyGraph);
}

function wantsPhaseOrganization(description: string): boolean {
  return /\b(phase|phases|lane|lanes|group|grouped|organize|organise|structure)\b/i.test(description);
}

/**
 * Assemble a graph deterministically from an approved plan (ORCH §9 plan-driven
 * build). Each Phase Card becomes one node, grouped into a graph phase, wired
 * linearly: trigger → phase nodes → return_output. Credential binding + the
 * terminal-output guarantee are handled downstream by `preflightAndEnrich`.
 */
export function assembleGraphFromPlan(
  plan: WorkflowPlan,
  description: string,
  explicitTrigger?: ExplicitTriggerSpec | null,
): WorkflowGraph {
  const lower = description.toLowerCase();
  const trigger = resolveTriggerConfig(lower, explicitTrigger);
  const nodes: WorkflowNode[] = [
    { id: 'trigger', type: 'trigger', title: triggerTitle(trigger), position: { x: 0, y: 80 }, config: trigger },
  ];
  const edges: WorkflowGraph['edges'] = [];
  const phases: NonNullable<WorkflowGraph['phases']> = [];
  // Gate/validate phases whose forward edge becomes a PASS branch and that gain a
  // reject/rollback branch after the linear spine is wired (Phase 3 finish).
  const branchNodes: Array<{ id: string; kind: 'gate' | 'validate'; name: string }> = [];
  let prev = 'trigger';
  let x = 280;

  plan.phases.forEach((phase, i) => {
    const id = `phase_${i + 1}`;
    const prompt = phase.description?.trim() || description;
    let node: WorkflowNode;
    if (phase.kind === 'approval') {
      // D2 — a real human approval gate before the irreversible step.
      node = {
        id, type: 'checkpoint', title: phase.name, position: { x, y: 80 },
        config: { kind: 'checkpoint', approvalMode: 'manual' },
      };
    } else if (phase.kind === 'gate' || phase.kind === 'validate') {
      // D1/D6 — an evaluator gate that screens (qualify) or verifies (validate)
      // before the chain continues. The reject/rollback branch is the operator's
      // to wire on the canvas; the gate node makes the decision point explicit.
      node = {
        id, type: 'evaluator', title: phase.name, position: { x, y: 80 },
        config: { kind: 'evaluator', targetPath: 'result', criteria: prompt, passThreshold: 0.6 },
      };
    } else if (phase.agentRole) {
      node = {
        id, type: 'agent_task', title: phase.name, position: { x, y: 80 },
        config: {
          kind: 'agent_task', agentRole: phase.agentRole, capabilityTags: [],
          prompt, inputKeys: [prev], outputKeys: ['result'],
          castingReason: `Plan phase "${phase.name}" cast the ${phase.agentRole} specialist.`,
          ...(phase.model ? { modelOverride: phase.model } : {}),
        },
      };
    } else if (phase.requiredCredential) {
      const slug = phase.requiredCredential;
      node = {
        id, type: 'integration', title: phase.name, position: { x, y: 80 },
        // `integrationId` is the connector slug; preflight binds credentialId.
        // A sensible default operation keeps the node graph-valid and meaningful;
        // the operator refines it (and wires the credential) on the canvas.
        config: { kind: 'integration', integrationId: slug, operationId: defaultOperationForSlug(slug), inputs: {} },
      };
    } else {
      // Deterministic passthrough — preserves the phase as a real, editable node.
      node = {
        id, type: 'transform', title: phase.name, position: { x, y: 80 },
        config: { kind: 'transform', expression: '({ ...input })' },
      };
    }
    nodes.push(node);
    edges.push({ id: `edge_${prev}_${id}`, source: prev, target: id });
    phases.push({ id: `grp_${i + 1}`, name: phase.name, color: PHASE_COLORS[i % PHASE_COLORS.length]!, nodeIds: [id] });
    if (phase.kind === 'gate' || phase.kind === 'validate') branchNodes.push({ id, kind: phase.kind, name: phase.name });
    prev = id;
    x += 280;
  });

  nodes.push({ id: 'return_output', type: 'return_output', title: 'Return Output', position: { x, y: 80 }, config: { kind: 'return_output', renderAs: 'markdown' } });
  edges.push({ id: `edge_${prev}_return_output`, source: prev, target: 'return_output' });

  // Wire the real control flow (Phase 3 finish): a gate/validate node's forward
  // edge becomes the PASS branch (auto-traversed on the evaluator's `passed`), and
  // it gains a FAIL branch — a clean "rejected" terminal for a gate, or a
  // rollback→terminal for a validate. All forward + acyclic, so it validates.
  let bx = x + 280;
  for (const b of branchNodes) {
    const forward = edges.find((e) => e.source === b.id);
    if (forward) forward.type = 'condition'; // PASS: traverses when output.passed is truthy
    if (b.kind === 'gate') {
      const rejectId = `reject_${b.id}`;
      nodes.push({ id: rejectId, type: 'return_output', title: `Rejected — ${b.name}`, position: { x: bx, y: 320 }, config: { kind: 'return_output', renderAs: 'markdown' } });
      edges.push({ id: `edge_${b.id}_${rejectId}`, source: b.id, target: rejectId, type: 'condition', condition: 'output.passed == false' });
      bx += 280;
    } else {
      const rollbackId = `rollback_${b.id}`;
      const rolledId = `rolled_back_${b.id}`;
      nodes.push({
        id: rollbackId,
        type: 'transform',
        title: 'Rollback / cleanup',
        position: { x: bx, y: 320 },
        config: { kind: 'transform', expression: '({ ...input, rollbackRequested: true })' },
      });
      nodes.push({ id: rolledId, type: 'return_output', title: 'Rolled back', position: { x: bx + 280, y: 320 }, config: { kind: 'return_output', renderAs: 'markdown' } });
      edges.push({ id: `edge_${b.id}_${rollbackId}`, source: b.id, target: rollbackId, type: 'condition', condition: 'output.passed == false' });
      edges.push({ id: `edge_${rollbackId}_${rolledId}`, source: rollbackId, target: rolledId });
      bx += 560;
    }
  }

  return { version: 1, nodes, edges, viewport: { x: 0, y: 0, zoom: 1 }, phases };
}

const PHASE_COLORS = ['#8b5cf6', '#0ea5e9', '#22c55e', '#f59e0b', '#ec4899', '#14b8a6'] as const;

const DELIVERY_SLUGS = new Set([
  'agentmail', 'gmail', 'slack', 'discord', 'telegram', 'google_sheets', 'sheets', 'notion', 'airtable', 'github', 'jira', 'linear',
]);

/** One inspectable structural repair the pipeline applied (10X-CREATION §7 M1). */
export interface RepairAction {
  rule: number;
  kind: 'delivery_node_added' | 'recurring_state_added' | 'terminal_added' | 'cycle_broken' | 'dangling_edge_removed' | 'integration_operation_normalized' | 'cron_schedule_defaulted' | 'robustness_bound' | 'expression_reference_repaired';
  nodeId?: string;
  message: string;
}

const isTerminalNode = (n: WorkflowNode) => {
  const c = n.config as { kind?: string; isOutput?: boolean };
  return c.kind === 'return_output' || c.kind === 'artifact_save' || c.isOutput === true;
};
const nodeKind = (n: WorkflowNode) => (n.config as { kind?: string }).kind;

/**
 * Deterministic structural repair (10X-CREATION-SWARM-PLAN Milestone 1) — turns
 * the most common Iron-Rule violations from warnings into actual graph fixes,
 * each returned as an inspectable RepairAction (never silent). Conservative:
 * skips when the graph shape is ambiguous and leaves the warning in place.
 */
export function repairGraph(
  graph: WorkflowGraph,
  classification: { requiredIntegrations: string[]; triggerType?: string },
  inventory: { configuredCredentials: Array<{ id: string; integrationSlug: string }> },
): { graph: WorkflowGraph; repairs: RepairAction[] } {
  const repairs: RepairAction[] = [];
  let g = graph;

  // Structural integrity FIRST — the later repairs (delivery/state) assume a
  // clean DAG. Weak models routinely emit edges to non-existent nodes or a
  // back-edge that closes a loop; both make `validateWorkflowGraph` throw. We
  // prune/break them deterministically so a small model's draft still ships.
  const pruned = pruneDanglingEdges(g);
  if (pruned.removed.length > 0) {
    g = pruned.graph;
    for (const r of pruned.removed) {
      repairs.push({
        rule: 0,
        kind: 'dangling_edge_removed',
        message: `Removed edge ${r.edgeId} (${r.from}→${r.to}) — it referenced a node that does not exist.`,
      });
    }
  }
  const decycled = breakCycles(g);
  if (decycled.removed.length > 0) {
    g = decycled.graph;
    for (const r of decycled.removed) {
      repairs.push({
        rule: 0,
        kind: 'cycle_broken',
        message: `Removed edge ${r.edgeId} (${r.from}→${r.to}) — it closed a cycle; workflows must be acyclic.`,
      });
    }
  }

  // Rule 3 + Rule 10 — delivery node.
  const delivery = ensureDeliveryNode(g, classification, inventory);
  if (delivery.addedSlug) {
    g = delivery.graph;
    repairs.push({
      rule: 3,
      kind: 'delivery_node_added',
      nodeId: `deliver_${delivery.addedSlug}`,
      message: `Added a ${delivery.addedSlug} delivery node — the request asks to deliver results but the graph had no integration node for it (Rule 3/10).`,
    });
  }

  // Rule 13 — recurring workflows remember (dedup / cursor state).
  if (classification.triggerType === 'cron' || classification.triggerType === 'persistent_listener') {
    const state = ensureRecurringState(g);
    if (state.added.length > 0) {
      g = state.graph;
      for (const a of state.added) repairs.push({ rule: 13, kind: 'recurring_state_added', nodeId: a.id, message: a.message });
    }
  }

  // Rule 14 — a cron trigger with no schedule fails strict validation and can
  // never run. Weak models routinely emit `triggerType: 'cron'` while omitting
  // the cron expression. Default it to a sensible daily run (09:00 UTC) so the
  // workflow is immediately valid/runnable; the schedule stays one click to edit.
  const cronDefault = ensureCronSchedule(g);
  if (cronDefault.changed) {
    g = cronDefault.graph;
    repairs.push({
      rule: 14,
      kind: 'cron_schedule_defaulted',
      nodeId: cronDefault.nodeId,
      message: 'Added a default daily schedule (09:00 UTC) to the cron trigger — it had none, which would block the workflow from running (Rule 14).',
    });
  }

  return { graph: g, repairs };
}

/**
 * Rule 14 — give a cron trigger a runnable default schedule when it has none.
 * Returns the (possibly) patched graph; `changed` is false when no cron trigger
 * needs a default, so the caller records a repair only on a real fix.
 */
function ensureCronSchedule(graph: WorkflowGraph): { graph: WorkflowGraph; changed: boolean; nodeId?: string } {
  const DEFAULT_CRON = '0 9 * * *';
  const idx = graph.nodes.findIndex((n) => {
    const c = n.config as { kind?: string; triggerType?: string; schedule?: string };
    return c.kind === 'trigger' && c.triggerType === 'cron' && !c.schedule?.trim();
  });
  if (idx === -1) return { graph, changed: false };
  const target = graph.nodes[idx]!;
  const patched: WorkflowNode = {
    ...target,
    config: { ...(target.config as object), schedule: DEFAULT_CRON } as WorkflowNode['config'],
  };
  const nodes = [...graph.nodes];
  nodes[idx] = patched;
  return { graph: { ...graph, nodes }, changed: true, nodeId: target.id };
}

/** Node kinds that run on a specialist agent and can therefore be cast. */
const AGENT_NODE_KINDS = new Set(['agent_task', 'agent_session', 'agent_swarm', 'dynamic_swarm', 'planner']);

export interface CastMember { role: string; agentId: string; created: boolean }

/**
 * Materialize the cast (F7): for every distinct `agentRole` referenced by the
 * graph, commission a REAL specialist agent (idempotent per workspace+role) and
 * pin its id onto the node. The team becomes real and visible in the workspace
 * the instant a workflow is built — no more "the orchestrator runs everything
 * itself". Reuses {@link SpecialistAgentService}, so specialists are shared and
 * reusable across workflows. No-ops when the service isn't wired or a node is
 * already pinned to a specific agent.
 */
export function materializeCast(
  graph: WorkflowGraph,
  deps: ToolHandlerDeps,
  workspaceId: string,
  userId: string | undefined,
): { graph: WorkflowGraph; cast: CastMember[] } {
  if (!deps.specialists || !userId) return { graph, cast: [] };
  // The orchestrator/manager tier are BUILDERS, never task workers. A node that
  // pinned (or was authored as) one is the "orchestrator casts itself" bug — collect
  // those ids so they get re-cast to a real specialist, and keep the worker roster
  // so we can REUSE a fit specialist instead of minting a new role each time.
  const allAgents = deps.db
    .select({ id: schema.agents.id, role: schema.agents.role, capabilityTags: schema.agents.capabilityTags })
    .from(schema.agents)
    .where(eq(schema.agents.workspaceId, workspaceId))
    .all();
  const nonExecutorIds = new Set(allAgents.filter((a) => !isSpecialistRole(a.role)).map((a) => a.id));
  const specialists = allAgents.filter((a) => isSpecialistRole(a.role));

  const cast: CastMember[] = [];
  const byRole = new Map<string, string>();
  const nodes = graph.nodes.map((n) => {
    const cfg = n.config as { kind?: string; agentRole?: string; agentId?: string; requires?: unknown; capabilityTags?: string[] };
    if (!AGENT_NODE_KINDS.has(cfg.kind ?? '')) return n;
    // Respect a pin ONLY when it targets a real specialist — never the orchestrator.
    if (cfg.agentId && !nonExecutorIds.has(cfg.agentId)) return n;

    // Hard RAL requirements → a CONNECTED capable WORKER (a freshly-seeded role is an
    // offline placeholder that can't satisfy them). Never the orchestrator/manager.
    const requires = normalizeAgentRequirements(cfg.requires);
    if (requiredAffordanceKeys(requires).length > 0) {
      const capable = findConnectedCapableAgent(deps, workspaceId, requires, cfg.agentRole);
      if (capable && !nonExecutorIds.has(capable.id)) {
        const capRole = cfg.agentRole ?? capable.role ?? 'specialist';
        if (!cast.some((c) => c.agentId === capable.id)) cast.push({ role: capRole, agentId: capable.id, created: false });
        return { ...n, config: { ...cfg, agentId: capable.id, agentRole: capRole } } as WorkflowNode;
      }
      // else fall through to a specialist role; readiness surfaces the runtime gap.
    }

    // Derive a real WORKER role: the declared role if it's a specialist role, else
    // one inferred from the node's capability tags / title, else generic specialist.
    const declaredRole = cfg.agentRole && isAgentRole(cfg.agentRole) && isSpecialistRole(cfg.agentRole)
      ? cfg.agentRole
      : undefined;
    const role = declaredRole ?? deriveSpecialistRole(cfg, n.title);

    let agentId = byRole.get(role);
    if (!agentId) {
      // Choose between agents: reuse the best-matching existing specialist (exact
      // role, else strongest capability-tag overlap) before minting a new role.
      const reuse = pickExistingSpecialist(specialists, role, cfg.capabilityTags);
      const existed = reuse !== null || deps.specialists!.resolveRole(workspaceId, role) !== null;
      agentId = reuse ?? deps.specialists!.ensureRole(workspaceId, userId, role);
      byRole.set(role, agentId);
      // A freshly cast specialist is an offline `http` placeholder. Connect it to
      // the workspace's default runtime NOW so it isn't "offline / fails on first
      // run", and so model routing sees real candidates (not just the lone default).
      if (!existed) connectSpecialistRuntime(deps, workspaceId, agentId);
      cast.push({ role, agentId, created: !existed });
    }
    return { ...n, config: { ...cfg, agentId, agentRole: role } } as WorkflowNode;
  });
  return { graph: { ...graph, nodes }, cast };
}

/**
 * Bind a freshly cast specialist to the workspace's default runtime at build time,
 * so it shows CONNECTED (not an offline `http` placeholder that "fails on first
 * run") and model routing has real candidates. Best-effort: when model-assisted
 * runtime is disabled (resolver returns nothing) the specialist stays offline and
 * the engine's lazy dispatch-time bind remains the fallback; a failure here never
 * blocks the build.
 */
function connectSpecialistRuntime(deps: ToolHandlerDeps, workspaceId: string, agentId: string): void {
  if (!deps.adapters || !deps.resolveAgentRuntime) return; // no runtime resolver wired
  if (deps.adapters.get(agentId)) return; // already connected
  try {
    const runtime = deps.resolveAgentRuntime(workspaceId, agentId, null, null) as AgentAdapter | undefined;
    if (!runtime) return;
    deps.adapters.register(agentId, runtime);
    deps.db
      .update(schema.agents)
      .set({ adapterType: runtime.adapterType, status: 'online', updatedAt: new Date().toISOString() })
      .where(eq(schema.agents.id, agentId))
      .run();
  } catch (err) {
    deps.logger?.warn?.('materialize_cast.connect_runtime_failed', { agentId, error: (err as Error).message });
  }
}

/** Infer a specialist role slug from a node's capability tags or title. */
function deriveSpecialistRole(cfg: { capabilityTags?: string[] }, title?: string): string {
  const tag = (cfg.capabilityTags ?? []).find((t) => typeof t === 'string' && t.trim());
  return roleSlug(tag ?? title ?? 'specialist');
}

function roleSlug(value: string): string {
  const slug = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || 'specialist';
}

/** Best existing specialist for a role/capability set: exact role match, else the
 *  strongest capability-tag overlap. Null when nothing reasonable matches. */
function pickExistingSpecialist(
  specialists: Array<{ id: string; role: string | null; capabilityTags: unknown }>,
  role: string,
  capabilityTags?: string[],
): string | null {
  const target = roleSlug(role);
  const exact = specialists.find((s) => roleSlug(s.role ?? '') === target);
  if (exact) return exact.id;
  const want = new Set((capabilityTags ?? []).map((t) => String(t).toLowerCase()));
  if (want.size === 0) return null;
  let best: { id: string; score: number } | null = null;
  for (const s of specialists) {
    const tags = Array.isArray(s.capabilityTags) ? (s.capabilityTags as string[]) : [];
    const overlap = tags.filter((t) => want.has(String(t).toLowerCase())).length;
    if (overlap > 0 && (!best || overlap > best.score)) best = { id: s.id, score: overlap };
  }
  return best?.id ?? null;
}

/**
 * The first CONNECTED workspace agent whose live runtime satisfies `requires`,
 * preferring one whose role matches `preferRole`. Used by the cast so a node with
 * hard RAL requirements routes to a runtime that can actually do the work instead
 * of an offline role placeholder.
 */
function findConnectedCapableAgent(
  deps: ToolHandlerDeps,
  workspaceId: string,
  requires: AgentRequirements,
  preferRole?: string,
): { id: string; role: string | null } | null {
  const rows = deps.db
    .select({ id: schema.agents.id, role: schema.agents.role })
    .from(schema.agents)
    .where(eq(schema.agents.workspaceId, workspaceId))
    .all();
  const capable = rows.filter(
    (row) => Boolean(deps.adapters.get(row.id)) && agentSatisfiesRequirements(deps.adapters.capabilities(row.id), requires),
  );
  if (capable.length === 0) return null;
  const chosen = (preferRole && capable.find((r) => r.role === preferRole)) || capable[0]!;
  return { id: chosen.id, role: chosen.role };
}

/**
 * Guarantee every node carries the DISPLAY fields the edit-time API schema and
 * the canvas expect: a non-empty `title` (≤255), a `type`, and a numeric
 * `position`. The engine never requires these, so a model/repair can persist a
 * node without them — which then makes the canvas autosave fail with
 * VALIDATION_FAILED on a graph the build just produced. Backfilled from the kind.
 */
const RAL_REQUIREMENT_NODE_KINDS = new Set(['agent_task', 'agent_session', 'agent_swarm', 'dynamic_swarm']);

export function normalizeGeneratedRalRequirements(graph: WorkflowGraph): WorkflowGraph {
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    const cfg = node.config as unknown as Record<string, unknown>;
    const kind = typeof cfg.kind === 'string' ? cfg.kind : '';
    if (!RAL_REQUIREMENT_NODE_KINDS.has(kind)) return node;

    const original = cfg.requires;
    const normalized = normalizeAgentRequirements(original);
    const next: AgentRequirements = { ...normalized };
    const text = ralRequirementIntentText(node, cfg);

    if (next.browser === true && !mentionsNativeBrowserControl(text)) {
      delete next.browser;
    }
    if (next.computerUse === true && !mentionsComputerUseControl(text) && !mentionsNativeBrowserControl(text)) {
      delete next.computerUse;
    }

    const hasNext = Object.values(next).some((value) => value === true);
    const normalizedOriginal = normalizeAgentRequirements(original);
    const same = JSON.stringify(normalizedOriginal) === JSON.stringify(next)
      && JSON.stringify(normalizedOriginal) === JSON.stringify(original ?? {});
    if (same && (hasNext || original === undefined)) return node;

    changed = true;
    const config = { ...cfg };
    if (hasNext) config.requires = next;
    else delete config.requires;
    return { ...node, config: config as unknown as WorkflowNode['config'] };
  });
  return changed ? { ...graph, nodes } : graph;
}

function ralRequirementIntentText(node: WorkflowNode, cfg: Record<string, unknown>): string {
  return [
    node.title,
    cfg.prompt,
    cfg.goal,
    cfg.persona,
    cfg.castingReason,
  ]
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
    .toLowerCase();
}

function mentionsNativeBrowserControl(text: string): boolean {
  // Reserve a RAL native-browser REQUIREMENT for EXPLICIT agent-owned, stateful
  // browser control. Ordinary web automation — login, fill a form, scrape a page,
  // screenshot, PDF — is the platform `browser` node's job and must NOT mint a
  // requires.browser (those would route to a scarce native runtime that usually
  // isn't connected). So the old click/login/"page" proximity heuristics are gone
  // on purpose: only direct "drive/control a live browser" phrasing qualifies.
  return /\b(native browser|browser runtime|live browser|interactive browser|browser session|headful|control(?:s|ling)? (?:a |the )?browser|operate(?:s|ing)? (?:a |the )?browser|drive(?:s|ing)? (?:a |the )?browser|browser automation|chromium|playwright)\b/.test(text);
}

function mentionsComputerUseControl(text: string): boolean {
  return /\b(computer use|computer-use|desktop control|desktop automation|host computer|gui|mouse|keyboard|screen control|control(?:s|ling)? (?:the )?desktop|operate(?:s|ing)? (?:the )?desktop)\b/.test(text);
}

function ensureNodeDisplayFields(graph: WorkflowGraph): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const kind = (n.config as { kind?: string }).kind ?? n.type ?? 'task';
      const title = (typeof n.title === 'string' && n.title.trim() ? n.title.trim() : humanizeNodeKind(kind)).slice(0, 255);
      const type = typeof n.type === 'string' && n.type.trim() ? n.type : kind;
      const position = n.position && typeof n.position.x === 'number' && typeof n.position.y === 'number'
        ? n.position
        : { x: 0, y: 0 };
      return { ...n, title, type, position } as WorkflowNode;
    }),
  };
}

function humanizeNodeKind(kind: string): string {
  return kind.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Rough per-kind runtime estimate (ms). Conservative, for a pre-run "~Ns" hint. */
const NODE_DURATION_MS: Record<string, number> = {
  agent_task: 9000, agent_session: 12000, agent_swarm: 12000, dynamic_swarm: 14000,
  planner: 6000, evaluator: 4000, guardrails: 3000, knowledge: 1500, http_request: 1500,
  browser: 4000, integration: 1500, extension_task: 3000, transform: 200, filter: 200,
  merge: 200, router: 300, wait: 0, workflow_store: 100, workspace_store: 100,
};
/** F8 — estimated wall-clock for one run (sum of node estimates; conservative). */
function estimateDurationMs(graph: WorkflowGraph): number {
  return graph.nodes.reduce((sum, n) => sum + (NODE_DURATION_MS[(n.config as { kind?: string }).kind ?? ''] ?? 300), 0);
}

export interface DeliveryPreview { service: string; to?: string; summary: string }

/**
 * F8 — what a run will actually send, so the operator sees "this emails
 * you@acme.com" BEFORE the first live run instead of after. Derived from the
 * graph's delivery (integration) nodes.
 */
function buildDeliveryPreview(graph: WorkflowGraph): DeliveryPreview[] {
  const out: DeliveryPreview[] = [];
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const n of graph.nodes) {
    const cfg = n.config as { kind?: string; integrationId?: string; inputs?: Record<string, unknown> };
    if (cfg.kind !== 'integration' || !cfg.integrationId) continue;
    if (!DELIVERY_SLUGS.has(cfg.integrationId)) continue;
    const to = resolvePreviewInput(cfg.inputs?.to, nodeById);
    const service = capitalize(cfg.integrationId.replace(/_/g, ' '));
    out.push({ service: cfg.integrationId, ...(to ? { to } : {}), summary: to ? `${service} → ${to}` : `${service} (recipient not set)` });
  }
  return out;
}

function hasManualApprovalBeforeDelivery(graph: WorkflowGraph): boolean {
  const manualCheckpointIds = new Set(
    graph.nodes
      .filter((node) => {
        const cfg = node.config as { kind?: string; approvalMode?: string };
        return cfg.kind === 'checkpoint' && cfg.approvalMode === 'manual';
      })
      .map((node) => node.id),
  );
  if (manualCheckpointIds.size === 0) return false;
  const deliveryNodeIds = new Set(
    graph.nodes
      .filter((node) => {
        const cfg = node.config as { kind?: string; integrationId?: string };
        return cfg.kind === 'integration' && !!cfg.integrationId && DELIVERY_SLUGS.has(cfg.integrationId);
      })
      .map((node) => node.id),
  );
  return graph.edges.some((edge) => manualCheckpointIds.has(edge.source) && deliveryNodeIds.has(edge.target));
}

function resolvePreviewInput(value: unknown, nodeById: Map<string, WorkflowNode>): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const template = value.match(/^\{\{\s*nodes\.([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\s*\}\}$/);
  if (!template) return value;
  const source = nodeById.get(template[1]!);
  if (!source || (source.config as { kind?: string }).kind !== 'transform') return value;
  const expression = (source.config as { expression?: unknown }).expression;
  if (typeof expression !== 'string') return value;
  try {
    const parsed = JSON.parse(expression) as Record<string, unknown>;
    const resolved = parsed[template[2]!];
    return typeof resolved === 'string' && resolved.trim() ? resolved : value;
  } catch {
    return value;
  }
}

const SELF_DELIVERY_EMAIL_SLUGS = new Set(['agentmail', 'gmail', 'email', 'smtp', 'outlook', 'sendgrid', 'mailgun', 'ses', 'notify']);

/**
 * True when the operator asked to be the recipient ("email me", "notify me")
 * and named no other address. We must NOT treat "email john@acme.com" as
 * self-directed, so an explicit address anywhere in the request disqualifies it.
 */
function isSelfDirectedDelivery(description: string): boolean {
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(description)) return false;
  const d = description.toLowerCase();
  return /\b(me|myself|my)\b/.test(d)
    && /\b(email|e-?mail|mail|notify|send|dm|message|digest|alert|report)\b/.test(d);
}

/**
 * Zero-config self delivery (F5): when the request is self-directed, fill the
 * operator's own verified email into an email delivery node that has no
 * recipient — so "email me" Just Works instead of asking "which address?".
 * Only fills an EMPTY recipient; never overrides an explicit one.
 */
function fillSelfDeliveryRecipient(
  graph: WorkflowGraph,
  deps: ToolHandlerDeps,
  userId: string | undefined,
  description: string,
): { graph: WorkflowGraph; filled: boolean } {
  if (!userId || !isSelfDirectedDelivery(description)) return { graph, filled: false };
  const user = deps.db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).get();
  const email = user?.email?.trim();
  if (!email) return { graph, filled: false };
  let filled = false;
  const nodes = graph.nodes.map((n) => {
    const cfg = n.config as { kind?: string; integrationId?: string; inputs?: Record<string, unknown> };
    if (cfg.kind !== 'integration') return n;
    if (!SELF_DELIVERY_EMAIL_SLUGS.has(String(cfg.integrationId ?? '').toLowerCase())) return n;
    const inputs = { ...(cfg.inputs ?? {}) };
    const to = typeof inputs.to === 'string' ? inputs.to.trim() : '';
    if (to) return n;
    inputs.to = email;
    filled = true;
    return { ...n, config: { ...cfg, inputs } } as WorkflowNode;
  });
  return filled ? { graph: { ...graph, nodes }, filled: true } : { graph, filled: false };
}

function ensureEmailDeliveryInputs(
  graph: WorkflowGraph,
  description: string,
): {
  graph: WorkflowGraph;
  completed: boolean;
  recipientFromRequest: boolean;
} {
  const explicitRecipient = firstExplicitEmailAddress(description);
  const subject = defaultEmailDeliverySubject(description);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.type === 'error') continue;
    const sources = incoming.get(edge.target) ?? [];
    sources.push(edge.source);
    incoming.set(edge.target, sources);
  }

  let completed = false;
  let recipientFromRequest = false;
  const nodes = graph.nodes.map((node) => {
    const cfg = node.config as { kind?: string; integrationId?: string; inputs?: Record<string, unknown> };
    if (cfg.kind !== 'integration') return node;
    if (!SELF_DELIVERY_EMAIL_SLUGS.has(String(cfg.integrationId ?? '').toLowerCase())) return node;

    const inputs = { ...(cfg.inputs ?? {}) };
    let changed = false;
    if (!nonEmptyString(inputs.to) && explicitRecipient) {
      inputs.to = explicitRecipient;
      changed = true;
      recipientFromRequest = true;
    }
    if (!nonEmptyString(inputs.subject)) {
      inputs.subject = subject;
      changed = true;
    }
    if (!hasEmailBodyInput(inputs)) {
      inputs.markdown = inferEmailDeliveryBodyTemplate(node.id, nodeById, incoming)
        ?? defaultEmailDeliveryBody(description);
      changed = true;
    }
    if (!changed) return node;
    completed = true;
    return { ...node, config: { ...cfg, inputs } } as WorkflowNode;
  });

  return completed ? { graph: { ...graph, nodes }, completed: true, recipientFromRequest } : { graph, completed: false, recipientFromRequest: false };
}

function relaxBuildOnlyEmailRecipientIssue(
  health: ReturnType<typeof preflightWorkflow>,
  graph: WorkflowGraph,
  description: string,
): ReturnType<typeof preflightWorkflow> {
  if (!isSelfDirectedDelivery(description)) return health;
  const missingRecipientNodeIds = new Set(
    graph.nodes
      .filter((node) => {
        const cfg = node.config as { kind?: string; integrationId?: string; inputs?: Record<string, unknown> };
        return cfg.kind === 'integration'
          && SELF_DELIVERY_EMAIL_SLUGS.has(String(cfg.integrationId ?? '').toLowerCase())
          && !nonEmptyString(cfg.inputs?.to);
      })
      .map((node) => node.id),
  );
  if (missingRecipientNodeIds.size === 0) return health;

  let changed = false;
  const issues = health.issues.map((issue) => {
    if (
      issue.severity === 'error'
      && issue.code === 'INTEGRATION_CONFIG_INCOMPLETE'
      && issue.nodeId
      && missingRecipientNodeIds.has(issue.nodeId)
      && /\bunmapped:.*\bto\b/i.test(issue.message)
    ) {
      changed = true;
      return {
        ...issue,
        severity: 'warning' as const,
        message: `${issue.message} The workflow asked to email you, but your operator profile does not yet have a recipient address.`,
        remediation: 'Add an email address to your account profile or set the delivery recipient on this step before running.',
        autoRepairable: false,
      };
    }
    return issue;
  });
  if (!changed) return health;

  const nodes = { ...health.nodes };
  for (const nodeId of missingRecipientNodeIds) {
    const node = nodes[nodeId];
    if (node?.status === 'failed') {
      nodes[nodeId] = { ...node, status: 'unverified', error: undefined };
    }
  }
  const hasErrors = issues.some((issue) => issue.severity === 'error');
  const hasUnverified = Object.values(nodes).some((node) => node.status === 'unverified' || node.status === 'mocked')
    || issues.some((issue) => issue.severity === 'warning');
  return {
    ...health,
    status: hasErrors ? 'blocked' : hasUnverified ? 'unverified' : 'healthy',
    issues,
    nodes,
  };
}

function firstExplicitEmailAddress(text: string): string | undefined {
  return text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0];
}

function defaultEmailDeliverySubject(description: string): string {
  return `Workflow result: ${titleFromDescription(description)}`.slice(0, 140);
}

function defaultEmailDeliveryBody(description: string): string {
  return `A workflow run completed for "${titleFromDescription(description)}". Review the full result in Agentis for details.`;
}

function hasEmailBodyInput(inputs: Record<string, unknown>): boolean {
  return ['text', 'html', 'markdown', 'body', 'content', 'message', 'digest', 'markdownBody', 'htmlBody']
    .some((key) => nonEmptyString(inputs[key]));
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function inferEmailDeliveryBodyTemplate(
  nodeId: string,
  nodeById: Map<string, WorkflowNode>,
  incoming: Map<string, string[]>,
): string | null {
  for (const upstreamId of incoming.get(nodeId) ?? []) {
    const upstream = nodeById.get(upstreamId);
    if (!upstream) continue;
    const key = preferredEmailOutputKey(upstream);
    if (key) return `{{nodes.${upstream.id}.${key}}}`;
    return `{{nodes.${upstream.id}}}`;
  }
  return null;
}

function preferredEmailOutputKey(node: WorkflowNode): string | null {
  const cfg = node.config as { outputKeys?: unknown };
  const outputKeys = Array.isArray(cfg.outputKeys)
    ? cfg.outputKeys.filter((key): key is string => typeof key === 'string' && key.trim().length > 0)
    : [];
  if (outputKeys.length === 0) return null;
  const preferred = ['result', 'summary', 'digest', 'output', 'content', 'message', 'body', 'text'];
  return outputKeys.find((key) => preferred.includes(key.toLowerCase())) ?? outputKeys[0] ?? null;
}

/**
 * Drop edges whose source or target is not a real node. A common weak-model
 * mistake (hallucinated ids, leftover edges after renaming a node) that would
 * otherwise fail validation with "references missing node".
 */
function pruneDanglingEdges(graph: WorkflowGraph): {
  graph: WorkflowGraph;
  removed: Array<{ edgeId: string; from: string; to: string }>;
} {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const removed: Array<{ edgeId: string; from: string; to: string }> = [];
  const kept = graph.edges.filter((e) => {
    if (ids.has(e.source) && ids.has(e.target)) return true;
    removed.push({ edgeId: e.id, from: e.source, to: e.target });
    return false;
  });
  return removed.length > 0 ? { graph: { ...graph, edges: kept }, removed } : { graph, removed: [] };
}

/**
 * Break any cycles by removing the back-edges that close them (DFS gray-edge
 * detection — the same algorithm `validateWorkflowGraph` uses to *detect* a
 * cycle, here used to *fix* one). Removing back-edges preserves the forward
 * topology, so the workflow's main path survives. Only the looping edge is cut.
 */
function breakCycles(graph: WorkflowGraph): {
  graph: WorkflowGraph;
  removed: Array<{ edgeId: string; from: string; to: string }>;
} {
  const adj = new Map<string, Array<{ target: string; edgeId: string }>>();
  for (const e of graph.edges) {
    const list = adj.get(e.source) ?? [];
    list.push({ target: e.target, edgeId: e.id });
    adj.set(e.source, list);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const n of graph.nodes) color.set(n.id, WHITE);
  const removedIds = new Set<string>();

  const visit = (id: string): void => {
    color.set(id, GRAY);
    for (const { target, edgeId } of adj.get(id) ?? []) {
      if (removedIds.has(edgeId)) continue;
      const c = color.get(target) ?? WHITE;
      if (c === GRAY) {
        removedIds.add(edgeId); // back-edge → cut it
        continue;
      }
      if (c === WHITE) visit(target);
    }
    color.set(id, BLACK);
  };
  for (const n of graph.nodes) {
    if ((color.get(n.id) ?? WHITE) === WHITE) visit(n.id);
  }
  if (removedIds.size === 0) return { graph, removed: [] };
  const removed = graph.edges
    .filter((e) => removedIds.has(e.id))
    .map((e) => ({ edgeId: e.id, from: e.source, to: e.target }));
  return { graph: { ...graph, edges: graph.edges.filter((e) => !removedIds.has(e.id)) }, removed };
}

/**
 * Rule 3 + Rule 10 safety net. Splice a pending-config integration node before
 * the terminal when the request asks to deliver but no integration node exists.
 */
function ensureDeliveryNode(
  graph: WorkflowGraph,
  classification: { requiredIntegrations: string[] },
  inventory: { configuredCredentials: Array<{ id: string; integrationSlug: string }> },
): { graph: WorkflowGraph; addedSlug: string | null } {
  const deliverySlugs = classification.requiredIntegrations.filter((s) => DELIVERY_SLUGS.has(s));
  if (deliverySlugs.length === 0) return { graph, addedSlug: null };
  const has = (slug: string) =>
    graph.nodes.some((n) => nodeKind(n) === 'integration' && (n.config as { integrationId?: string }).integrationId === slug);
  const missing = deliverySlugs.filter((s) => !has(s));
  if (missing.length === 0) return { graph, addedSlug: null };
  const slug = missing[0]!;

  const nodes = graph.nodes.map((n) => ({ ...n, config: { ...(n.config as object) } })) as WorkflowNode[];
  const edges = graph.edges.map((e) => ({ ...e }));
  const terminal = nodes.find(isTerminalNode);
  let anchor: WorkflowNode | undefined;
  if (terminal) {
    const feeder = edges.find((e) => e.target === terminal.id);
    anchor = feeder ? nodes.find((n) => n.id === feeder.source) : undefined;
  }
  anchor ??= [...nodes].reverse().find((n) => !isTerminalNode(n)) ?? nodes[nodes.length - 1];
  if (!anchor) return { graph, addedSlug: null };

  const credId = inventory.configuredCredentials.find((c) => c.integrationSlug === slug)?.id;
  const intId = `deliver_${slug}`;
  nodes.push({
    id: intId,
    type: 'integration',
    title: `Send via ${capitalize(slug.replace(/_/g, ' '))}`,
    position: { x: anchor.position.x + 240, y: anchor.position.y },
    config: {
      kind: 'integration',
      integrationId: slug,
      operationId: defaultOperationForSlug(slug),
      inputs: {},
      ...(credId ? { credentialId: credId } : {}),
    },
  } as unknown as WorkflowNode);

  if (terminal) {
    const direct = edges.find((e) => e.source === anchor!.id && e.target === terminal.id);
    if (direct) direct.target = intId;
    else edges.push({ id: `edge_${anchor.id}_${intId}`, source: anchor.id, target: intId });
    edges.push({ id: `edge_${intId}_${terminal.id}`, source: intId, target: terminal.id });
    terminal.position = { x: anchor.position.x + 480, y: terminal.position.y };
  } else {
    edges.push({ id: `edge_${anchor.id}_${intId}`, source: anchor.id, target: intId });
  }
  return { graph: { ...graph, nodes, edges }, addedSlug: slug };
}

/**
 * Rule 13 — recurring workflows must read/write state so each run builds on the
 * last (dedup, cursor). Inserts a `workflow_store` read right after the trigger
 * and a `workflow_store` write right before the terminal, as passthroughs.
 * Conservative: requires exactly one trigger and one terminal, and no existing
 * workflow_store node; otherwise it no-ops.
 */
function ensureRecurringState(graph: WorkflowGraph): { graph: WorkflowGraph; added: Array<{ id: string; message: string }> } {
  if (graph.nodes.some((n) => nodeKind(n) === 'workflow_store')) return { graph, added: [] };
  const triggers = graph.nodes.filter((n) => nodeKind(n) === 'trigger');
  const terminals = graph.nodes.filter(isTerminalNode);
  if (triggers.length !== 1 || terminals.length !== 1) return { graph, added: [] };
  const trigger = triggers[0]!;
  const terminal = terminals[0]!;

  const nodes = graph.nodes.map((n) => ({ ...n, config: { ...(n.config as object) } })) as WorkflowNode[];
  const edges = graph.edges.map((e) => ({ ...e }));
  const added: Array<{ id: string; message: string }> = [];

  // Read node, spliced after the trigger.
  const triggerOut = edges.find((e) => e.source === trigger.id);
  if (triggerOut) {
    const readId = 'state_read';
    nodes.push({
      id: readId,
      type: 'workflow_store',
      title: 'Load Seen State',
      position: { x: trigger.position.x + 200, y: trigger.position.y + 120 },
      config: { kind: 'workflow_store', operations: [{ op: 'get', key: 'seen', outputKey: 'seen' }] },
    } as unknown as WorkflowNode);
    const target = triggerOut.target;
    triggerOut.target = readId;
    edges.push({ id: `edge_${readId}_${target}`, source: readId, target });
    added.push({ id: readId, message: 'Added a workflow_store read after the trigger so recurring runs remember prior state (Rule 13).' });
  }

  // Write node, spliced before the terminal.
  const terminalIn = edges.find((e) => e.target === terminal.id);
  if (terminalIn) {
    const writeId = 'state_write';
    nodes.push({
      id: writeId,
      type: 'workflow_store',
      title: 'Persist Seen State',
      position: { x: terminal.position.x - 200, y: terminal.position.y + 120 },
      // `set` persists the accumulated `seen` state for the next run. `{{seen}}`
      // is the conventional handle the dedup step downstream of the read should
      // produce; the operator wires the real value on the canvas. (Was `write`,
      // which is NOT a valid workflow_store op — the engine rejects it at run
      // time with "unknown op write", taking the whole recurring workflow down.)
      config: { kind: 'workflow_store', operations: [{ op: 'set', key: 'seen', value: '{{seen}}' }] },
    } as unknown as WorkflowNode);
    const source = terminalIn.source;
    terminalIn.source = writeId;
    edges.push({ id: `edge_${source}_${writeId}`, source, target: writeId });
    added.push({ id: writeId, message: 'Added a workflow_store write before the terminal so each run persists what it has seen (Rule 13).' });
  }

  return added.length > 0 ? { graph: { ...graph, nodes, edges }, added } : { graph, added: [] };
}

/** One reviewer critique against the workflow grammar (inspectable). */
export interface BuildCritique {
  rule: number;
  severity: 'info' | 'warn' | 'error';
  nodeId?: string;
  message: string;
}

/**
 * LLM reviewer/critic (10X-CREATION-SWARM-PLAN Milestone 2). Audits the
 * candidate graph against the Iron Rules and returns inspectable critiques plus
 * an optionally repaired graph. This is the "Reviewer specialist" that catches
 * what a small architect model misses (lazy agent chains, missing fetch/guard
 * nodes). Failure-tolerant: returns no critiques on any parse/transport error.
 */
async function reviewWorkflowGraph(
  runtime: StructuredCompleter,
  args: { graph: WorkflowGraph; description: string; brief?: CreationBrief },
  signal?: AbortSignal,
): Promise<{ critiques: BuildCritique[]; repairedGraph: WorkflowGraph | null }> {
  const system = [
    SYNTHESIS_ARCHITECT_PREAMBLE,
    'You are the REVIEWER. Audit the candidate WorkflowGraph against BOTH the IRON RULES and the',
    'WORKFLOW DESIGN DOCTRINE (D1–D7) above. Beyond structure, hunt for missing robustness:',
    'an irreversible/external action (deploy/send/publish/delete) with NO approval checkpoint or',
    'evaluator gate before it (D2); an external fetch/scrape with no fallback or result check (D3);',
    'a cron/listener workflow that accumulates state but has no workflow_store dedup (D4); a batch',
    'with unbounded fan-out (D5); a qualification/decision step with no reject/fallback branch (D1);',
    'an irreversible action with no validate-then-rollback after it (D6); an open-ended iterate-until-done',
    'goal hand-wired as a fixed-N evaluator retry instead of a `converge` node (D7).',
    'Return ONLY a JSON object of shape:',
    '{ "critiques": [{ "rule": <1-14 or "D1".."D6">, "severity": "info"|"warn"|"error", "nodeId"?: "<id>", "message": "<what is wrong and the fix>" }],',
    '  "repairedGraph"?: { "version": 1, "nodes": [...], "edges": [...], "viewport": { "x":0,"y":0,"zoom":1 } } }',
    'Rules: If the graph already obeys every rule and the doctrine, return "critiques": [] and OMIT repairedGraph.',
    'If you find violations you can fix (lazy agent_task doing fetch/delivery, missing http_request/integration/',
    'evaluator/terminal, serial work that should be parallel, a missing gate/fallback/state/rollback), return the',
    'FULL corrected graph in repairedGraph, preserving valid nodes and ids where possible. Never collapse the',
    'workflow into a single agent_task.',
  ].join('\n');
  const user = [
    args.brief ? renderCreationBrief(args.brief) : '',
    `DESCRIPTION:\n${args.description}`,
    `CANDIDATE GRAPH:\n${JSON.stringify(args.graph)}`,
  ].filter(Boolean).join('\n\n');

  const result = await runtime.completeStructured<{ critiques?: unknown; repairedGraph?: unknown }>({
    system,
    user,
    maxTokens: 3000,
    maxAttempts: 2,
    ...(signal ? { signal } : {}),
  });
  if (!result) return { critiques: [], repairedGraph: null };

  const critiques: BuildCritique[] = Array.isArray(result.critiques)
    ? result.critiques
        .map((c): BuildCritique | null => {
          if (!c || typeof c !== 'object') return null;
          const o = c as Record<string, unknown>;
          const rule = typeof o.rule === 'number' ? o.rule : Number(o.rule) || 0;
          const sev = o.severity === 'error' || o.severity === 'warn' || o.severity === 'info' ? o.severity : 'warn';
          const message = typeof o.message === 'string' ? o.message : '';
          if (!message) return null;
          return { rule, severity: sev, message, ...(typeof o.nodeId === 'string' ? { nodeId: o.nodeId } : {}) };
        })
        .filter((c): c is BuildCritique => c !== null)
        .slice(0, 12)
    : [];

  // Accept either { repairedGraph: { nodes,... } } or { repairedGraph: { graph: {...} } }.
  let repairedGraph: WorkflowGraph | null = null;
  const rg = result.repairedGraph as { graph?: unknown; nodes?: unknown } | undefined;
  const candidate = (rg && typeof rg === 'object' && 'graph' in rg ? (rg as { graph?: unknown }).graph : rg) as
    | { nodes?: unknown; edges?: unknown; viewport?: unknown }
    | undefined;
  if (candidate && Array.isArray(candidate.nodes) && candidate.nodes.length > 0) {
    const normalized: WorkflowGraph = {
      version: 1,
      nodes: candidate.nodes as WorkflowGraph['nodes'],
      edges: Array.isArray(candidate.edges) ? (candidate.edges as WorkflowGraph['edges']) : [],
      viewport: (candidate.viewport as WorkflowGraph['viewport']) ?? { x: 0, y: 0, zoom: 1 },
    };
    try {
      validateWorkflowGraph(normalized);
      repairedGraph = normalized;
    } catch {
      repairedGraph = null;
    }
  }
  return { critiques, repairedGraph };
}

/** A reasonable default connector operation per slug, so a plan-built integration node is graph-valid. */
function defaultOperationForSlug(slug: string): string {
  const map: Record<string, string> = {
    agentmail: 'send_message', gmail: 'send_email', slack: 'send_message', discord: 'send_message', telegram: 'send_message',
    google_sheets: 'append_row', sheets: 'append_row', notion: 'create_page', airtable: 'create_record',
    github: 'create_issue', jira: 'create_issue', linear: 'create_issue',
  };
  return map[slug] ?? 'send_message';
}

function titleFromDescription(description: string): string {
  const cleaned = description
    .replace(/^build\s+(me\s+)?(a|an|the)?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const base = cleaned.length > 0 ? cleaned : 'Generated Workflow';
  return base.length > 80 ? `${base.slice(0, 77)}...` : capitalize(base);
}

function appNameFromGoal(goal: string): string {
  const title = titleFromDescription(goal)
    .replace(/\s+workflow$/i, '')
    .replace(/\s+app$/i, '')
    .trim();
  return `${title || 'Agentis'} app`;
}

function createRequestedAgents(
  value: unknown,
  deps: ToolHandlerDeps,
  ctx: { workspaceId: string; ambientId?: string | null; userId: string },
  appId: string,
): string[] {
  if (!Array.isArray(value)) return [];
  const created: string[] = [];
  const now = new Date().toISOString();
  for (const item of value) {
    const record = recordFromUnknown(item);
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) continue;
    const id = randomUUID();
    const capabilityTags = Array.isArray(record.capabilityTags)
      ? record.capabilityTags.filter((tag): tag is string => typeof tag === 'string')
      : [];
    deps.db.insert(schema.agents).values({
      id,
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId ?? null,
      userId: ctx.userId,
      packageId: null,
      name,
      description: typeof record.description === 'string' ? record.description : null,
      adapterType: typeof record.adapterType === 'string' ? record.adapterType : 'http',
      capabilityTags,
      config: { ...recordFromUnknown(record.config), appId },
      status: 'offline',
      colorHex: typeof record.colorHex === 'string' ? record.colorHex : '#34d399',
      instructions: typeof record.instructions === 'string' ? record.instructions : null,
      avatarGlyph: typeof record.avatarGlyph === 'string' ? record.avatarGlyph : initials(name),
      role: typeof record.role === 'string' ? record.role : 'worker',
      createdAt: now,
      updatedAt: now,
    }).run();
    created.push(id);
    deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), REALTIME_EVENTS.AGENT_CREATED, {
      agent: { id, name, role: typeof record.role === 'string' ? record.role : 'worker', status: 'offline' },
      source: 'app.compose',
      appId,
    });
  }
  return created;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return (parts.map((part) => part[0]?.toUpperCase() ?? '').join('') || 'A').slice(0, 2);
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

/** A trigger the CALLER declared, rather than one inferred from prose. */
export interface ExplicitTriggerSpec {
  type?: 'manual' | 'cron' | 'webhook' | 'persistent_listener';
  cron?: string;
}

/**
 * Declared trigger wins over inference. Inference reads keywords out of a
 * description, so an intent phrased any other way ("produce the digest each
 * morning" — no `every`/`daily`) silently fell through to `manual`, and the
 * workflow was built unattended-by-accident. A caller that KNOWS the trigger
 * should never have to phrase its way past a regex.
 */
function resolveTriggerConfig(
  lower: string,
  explicit?: ExplicitTriggerSpec | null,
): ReturnType<typeof inferTriggerConfig> {
  if (!explicit?.type) {
    // No declared type, but a declared cron still means "this recurs".
    if (explicit?.cron) return { kind: 'trigger', triggerType: 'cron', schedule: explicit.cron };
    return inferTriggerConfig(lower);
  }
  if (explicit.type === 'cron') {
    return {
      kind: 'trigger',
      triggerType: 'cron',
      // Fall back to the inferred cadence when the type is declared but the
      // expression is not, rather than inventing a schedule.
      schedule: explicit.cron ?? inferTriggerConfig(lower).schedule ?? '0 9 * * *',
    };
  }
  return { kind: 'trigger', triggerType: explicit.type };
}

/** Deterministic trigger inference from the prompt (Step 2 — intent extraction). */
function inferTriggerConfig(lower: string): {
  kind: 'trigger';
  triggerType: 'manual' | 'cron' | 'webhook' | 'persistent_listener';
  schedule?: string;
} {
  if (/\bwebhook\b|\bincoming (request|http|post)\b/.test(lower)) {
    return { kind: 'trigger', triggerType: 'webhook' };
  }
  const persistentListenerIntent =
    /\b(24\/7|constantly|continuously|always[- ]on|in real time|immediately|as soon as)\b/.test(lower)
    || /\b(watch|monitor|listen)\b[\s\S]{0,80}\b(new|changes?|updates?|posts?|events?|items?)\b/.test(lower)
    || /\bwhen(?:ever)?\b[\s\S]{0,80}\b(new|changes?|updates?|posts?|events?|items?)\b/.test(lower);
  const scheduledIntent = /\b(every|daily|weekly|hourly|monthly|schedule|cron)\b/.test(lower);
  if (persistentListenerIntent && !scheduledIntent) {
    return { kind: 'trigger', triggerType: 'persistent_listener' };
  }
  if (/\bevery (day|morning)\b|\bdaily\b/.test(lower)) return { kind: 'trigger', triggerType: 'cron', schedule: '0 9 * * *' };
  if (/\bevery week\b|\bweekly\b|\bevery monday\b/.test(lower)) return { kind: 'trigger', triggerType: 'cron', schedule: '0 9 * * MON' };
  if (/\bevery hour\b|\bhourly\b/.test(lower)) return { kind: 'trigger', triggerType: 'cron', schedule: '0 * * * *' };
  if (/\bevery (\d+) ?min/.test(lower)) return { kind: 'trigger', triggerType: 'cron', schedule: '*/15 * * * *' };
  if (/\bschedule\b|\bcron\b|\bon a schedule\b/.test(lower)) return { kind: 'trigger', triggerType: 'cron', schedule: '0 9 * * *' };
  return { kind: 'trigger', triggerType: 'manual' };
}

function triggerTitle(t: { triggerType: string }): string {
  return t.triggerType === 'cron'
    ? 'Schedule Trigger'
    : t.triggerType === 'webhook'
      ? 'Webhook Trigger'
      : t.triggerType === 'persistent_listener'
        ? 'Persistent Listener'
        : 'Manual Trigger';
}

/**
 * When the request states a recurring schedule, turn the workflow's trigger node
 * into a REAL cron trigger: mutate the node to `triggerType:'cron'` + a linked
 * `triggerId`, and return the parsed UTC cron so the caller can upsert the
 * (paused) trigger row. Idempotent on rebuild — reuses an existing cron row for
 * this workflow. Returns null when there's no schedule or no trigger node.
 */
function applyScheduleTrigger(
  deps: ToolHandlerDeps,
  args: CreateWorkflowArgs,
  graph: WorkflowGraph,
  workflowId: string,
): { nodeId: string; cron: string; timezone: string | null; triggerId: string; detail: string } | null {
  const parsed = scheduleFromNaturalLanguage(args.description);
  if (!parsed) return null;
  const triggerNode = graph.nodes.find((n) => nodeKind(n) === 'trigger');
  if (!triggerNode) return null;
  const cfg = triggerNode.config as { kind: 'trigger'; triggerType?: string; triggerId?: string };
  const existing = deps.db
    .select({ id: schema.triggers.id })
    .from(schema.triggers)
    .where(and(eq(schema.triggers.workflowId, workflowId), eq(schema.triggers.triggerType, 'cron')))
    .get();
  const triggerId = existing?.id ?? cfg.triggerId ?? randomUUID();
  cfg.triggerType = 'cron';
  cfg.triggerId = triggerId;
  triggerNode.title = 'Schedule Trigger';
  return { nodeId: triggerNode.id, cron: parsed.cron, timezone: parsed.timezone, triggerId, detail: parsed.detail };
}

function nodeReason(node: WorkflowNode): string {
  const reasons: Record<string, string> = {
    trigger: 'Entry point: this starts the workflow.',
    knowledge: 'Retrieves relevant workspace knowledge before acting.',
    agent_task: 'Delegates the main work to a configured agent.',
    checkpoint: 'Adds a human decision gate before continuing.',
    scratchpad: 'Stores the final output for later steps or inspection.',
    router: 'Branches execution based on conditions.',
    merge: 'Collects branch results before continuing.',
    subflow: 'Calls another workflow as a reusable subflow.',
    transform: 'Shapes data deterministically — no LLM tokens.',
    return_output: 'Declares the rendered result the operator sees.',
    artifact_save: 'Saves a file artifact to the workspace.',
    browser: 'Renders HTML / captures a screenshot in real Chromium.',
  };
  return reasons[node.config.kind] ?? `${node.config.kind} node`;
}

function publishCanvas(
  deps: ToolHandlerDeps,
  ctx: { workspaceId: string; agentId?: string; runId?: string },
  event: RealtimeEventName,
  payload: Record<string, unknown>,
): void {
  const workflowId = typeof payload.workflowId === 'string' ? payload.workflowId : null;
  const runId = typeof payload.runId === 'string' ? payload.runId : null;
  deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), event, payload);
  if (workflowId) deps.bus.publish(REALTIME_ROOMS.workflow(workflowId), event, payload);
  if (runId) deps.bus.publish(REALTIME_ROOMS.run(runId), event, payload);
  if (ctx.agentId) deps.bus.publish(REALTIME_ROOMS.conversation(ctx.agentId), event, payload);
}

function buildPlan(goal: string, context: string): Array<{ step: number; action: string }> {
  const prefix = context.trim() ? `Considering ${context.trim().slice(0, 120)}, ` : '';
  return [
    { step: 1, action: `${prefix}identify the concrete target state and required IDs.` },
    { step: 2, action: 'Inspect current Agentis state with read-only tools.' },
    { step: 3, action: `Apply the smallest action that advances: ${goal}.` },
    { step: 4, action: 'Verify the result and report the platform state back to the operator.' },
  ];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A {@link StructuredCompleter} backed by the building agent's OWN live adapter,
 * or undefined when that agent isn't connected / can't chat. This is the
 * agentic default: with no dedicated synthesis model configured, the agent the
 * operator is talking to builds the workflow with its own model — the same one
 * already answering their chat. (Model-agnostic: any chat-capable runtime works.)
 */
function agentChatAdapter(deps: ToolHandlerDeps, agentId?: string): AgentAdapter | undefined {
  if (!agentId) return undefined;
  // Defensive: `adapters` may be a partial/mock in some call sites — only call
  // `.get` when it's actually a function (a truthy `{}` would throw otherwise).
  const reg = typeof deps.adapters?.get === 'function' ? deps.adapters.get(agentId) : undefined;
  if (!reg?.adapter?.chat) return undefined;
  if (reg.adapter.capabilities?.().interactiveChat === false) return undefined;
  return reg.adapter;
}

/** True when an adapter answers chat by RE-SPAWNING a CLI process per round
 *  (Codex / Claude Code). Fine for one chat reply, but murderous for the ~6
 *  sequential model calls a build makes — the cause of multi-minute builds. */
function isSlowPerCallHarness(adapter: AgentAdapter | undefined): boolean {
  const fwd = adapter?.capabilities?.().toolForwarding;
  return fwd === 'marker_protocol' || fwd === 'mcp_native';
}

/**
 * The "own model" completer for a build role. ZERO-CONFIG by design: the model the
 * operator already attached to their agent IS the synthesis model — there is no
 * separate "set a synthesis model" step. The only nuance is SPEED — if the agent
 * answers chat through a slow per-call CLI harness, use a configured streaming
 * runtime instead. Never recursively spawn the calling harness from inside its
 * own tool execution; that runtime must author graphDraft or patchDraft.
 */
function ownModelCompleter(
  deps: ToolHandlerDeps,
  workspaceId: string,
  agentId: string | undefined,
  routerRole: 'synthesis' | 'evaluation',
  task: string,
): StructuredCompleter | undefined {
  const agent = agentChatAdapter(deps, agentId);
  if (agent && !isSlowPerCallHarness(agent)) return new AdapterStructuredCompleter(agent);
  if (deps.modelAssistedRuntimeEnabled?.(workspaceId) === false) return undefined;
  const streaming = deps.modelRouter?.resolveRouted({ role: routerRole, workspaceId, task, purpose: routerRole })
    ?? deps.modelRouter?.resolveRouted({ role: 'conversation', workspaceId, task, purpose: routerRole });
  if (streaming) return new AdapterStructuredCompleter(streaming);
  return undefined;
}

/**
 * The structured completer for the synthesis role, in precedence order:
 * per-workspace synthesis runtime → dedicated synthesis runtime → evaluator
 * runtime → the agent's own model (streaming fast-path preferred). Undefined only
 * when nothing at all can build (no configured model AND no chat-capable agent).
 */
export function resolveSynthesisCompleter(deps: ToolHandlerDeps, workspaceId: string, agentId: string | undefined, task: string): StructuredCompleter | undefined {
  if (deps.modelAssistedRuntimeEnabled?.(workspaceId) === false) {
    return ownModelCompleter(deps, workspaceId, agentId, 'synthesis', task);
  }
  return deps.resolveEvaluatorRuntime?.(workspaceId, 'synthesis', { task, purpose: 'workflow_synthesis' })
    ?? deps.synthesisRuntime
    ?? deps.evaluatorRuntime
    ?? ownModelCompleter(deps, workspaceId, agentId, 'synthesis', task);
}

/** The completer for the reviewer/critic role — prefers an evaluation model. */
function resolveReviewerCompleter(deps: ToolHandlerDeps, workspaceId: string, agentId: string | undefined, task: string): StructuredCompleter | undefined {
  if (deps.modelAssistedRuntimeEnabled?.(workspaceId) === false) {
    return ownModelCompleter(deps, workspaceId, agentId, 'evaluation', task);
  }
  return deps.resolveEvaluatorRuntime?.(workspaceId, 'evaluation', { task, purpose: 'workflow_evaluation' })
    ?? deps.resolveEvaluatorRuntime?.(workspaceId, 'synthesis', { task, purpose: 'workflow_synthesis' })
    ?? deps.synthesisRuntime
    ?? deps.evaluatorRuntime
    ?? ownModelCompleter(deps, workspaceId, agentId, 'evaluation', task);
}

/**
 * Whether this build can ONLY run through a slow per-call CLI harness — no
 * configured runtime, no streaming orchestrator model, and the agent re-spawns
 * per call. When true we skip the optional reviewer audit (a second set of model
 * round-trips) so a slow setup still returns a workflow quickly; the
 * deterministic `repairGraph` still enforces the Iron Rules structurally.
 */
function buildOnlyHasSlowPath(deps: ToolHandlerDeps, workspaceId: string, agentId: string | undefined, task: string): boolean {
  if (deps.modelAssistedRuntimeEnabled?.(workspaceId) === false) {
    return isSlowPerCallHarness(agentChatAdapter(deps, agentId));
  }
  const hasFastRuntime = Boolean(
    deps.resolveEvaluatorRuntime?.(workspaceId, 'synthesis', { task, purpose: 'workflow_synthesis' })
    ?? deps.resolveEvaluatorRuntime?.(workspaceId, 'evaluation', { task, purpose: 'workflow_evaluation' })
    ?? deps.synthesisRuntime
    ?? deps.evaluatorRuntime
    ?? deps.modelRouter?.resolveRouted({ role: 'synthesis', workspaceId, task, purpose: 'workflow_synthesis' })
    ?? deps.modelRouter?.resolveRouted({ role: 'conversation', workspaceId, task, purpose: 'workflow_synthesis' }),
  );
  if (hasFastRuntime) return false;
  return isSlowPerCallHarness(agentChatAdapter(deps, agentId));
}

/** Why synthesis produced no graph — drives the inspectable `blocked` phase. */
export type SynthesisOutcome =
  | { graph: WorkflowGraph; reason: 'ok' }
  | { graph: null; reason: 'model_error' | 'invalid_graph'; error: string | null };

function parseAgentGraphDraft(value: unknown): WorkflowGraph {
  const candidate = value && typeof value === 'object' && !Array.isArray(value) && 'graph' in value
    ? (value as { graph?: unknown }).graph
    : value;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new AgentisError(
      'WORKFLOW_DRAFT_INVALID',
      'Workflow draft is not a graph object.',
      {
        remediation: 'Pass graphDraft with nodes, edges, and viewport, or omit graphDraft and provide a description so Agentis can create an editable draft.',
        details: {
          field: 'graphDraft',
          acceptedShape: '{ version: 1, nodes: WorkflowNode[], edges: WorkflowEdge[], viewport: { x, y, zoom } }',
          repair: 'Call agentis.workflow.draft_contract for node templates and the complete public schema.',
        },
      },
    );
  }
  const draft = candidate as Partial<WorkflowGraph>;
  if (!Array.isArray(draft.nodes) || draft.nodes.length === 0) {
    throw new AgentisError('WORKFLOW_DRAFT_INVALID', 'Workflow draft needs at least one node.', {
      remediation: 'Add a trigger node and a terminal return_output node, or omit graphDraft to let Agentis create the initial draft.',
      details: { field: 'graphDraft.nodes', acceptedShape: 'WorkflowNode[] (minimum one trigger or executable node)', repair: 'Use agentis.workflow.draft_contract for a minimal working example.' },
    });
  }
  if (!Array.isArray(draft.edges)) {
    throw new AgentisError('WORKFLOW_DRAFT_INVALID', 'Workflow draft edges must be an array.', {
      remediation: 'Set graphDraft.edges to [] for a one-node draft or provide source/target edges.',
      details: { field: 'graphDraft.edges', acceptedShape: 'WorkflowEdge[]', repair: 'Missing and duplicate edge ids are repaired automatically; endpoints still must name real nodes.' },
    });
  }
  return repairWorkflowGraphIdentity({
    version: draft.version ?? 1,
    nodes: draft.nodes as WorkflowGraph['nodes'],
    edges: draft.edges as unknown as Array<Record<string, unknown>>,
    viewport: draft.viewport ?? { x: 0, y: 0, zoom: 1 },
    ...(draft.phases ? { phases: draft.phases } : {}),
  }).graph;
}

function applyWorkflowMutationPatch(base: WorkflowGraph, value: unknown): WorkflowGraph {
  return applyLegacyWorkflowPatchDraft(base, value);
}

function assertMutationPreservesGraph(
  base: WorkflowGraph,
  candidate: WorkflowGraph,
  instruction: string,
): void {
  if (allowsWholeWorkflowReplacement(instruction)) return;
  const candidateNodeIds = new Set(candidate.nodes.map((node) => node.id));
  const candidateEdgeIds = new Set(candidate.edges.map((edge) => edge.id));
  const retainedNodes = base.nodes.filter((node) => candidateNodeIds.has(node.id)).length;
  const retainedEdges = base.edges.filter((edge) => candidateEdgeIds.has(edge.id)).length;
  const minimumNodes = base.nodes.length < 4 ? 1 : Math.ceil(base.nodes.length * 0.6);
  const minimumEdges = base.edges.length < 3 ? 0 : Math.ceil(base.edges.length * 0.5);
  if (retainedNodes < minimumNodes || retainedEdges < minimumEdges) {
    throw new Error(
      `the proposed edit is destructive (${retainedNodes}/${base.nodes.length} nodes and `
      + `${retainedEdges}/${base.edges.length} edges retained)`,
    );
  }
}

function allowsWholeWorkflowReplacement(instruction: string): boolean {
  return /\b(?:replace|rebuild|redesign|start\s+over|from\s+scratch|rewrite\s+the\s+(?:entire|whole)|completely\s+rewrite)\b/i
    .test(instruction);
}

/**
 * LLM-based workflow synthesis.
 *
 * Asks the resolved completer (a configured model endpoint, or the building
 * agent's own model) to design a `WorkflowGraph` from a natural-language
 * description, then validates the result against the same `validateWorkflowGraph`
 * contract operators see in the canvas.
 *
 * Returns an inspectable outcome rather than a bare null so the caller can tell
 * the operator the REAL reason a build failed (e.g. the backend's own error
 * message) instead of a generic "couldn't build".
 */
async function synthesizeWithLlm(
  description: string,
  deps: ToolHandlerDeps,
  workspaceId: string,
  completer: StructuredCompleter,
  brief?: CreationBrief,
  signal?: AbortSignal,
  mutation?: { id: string; title: string; graph: WorkflowGraph },
): Promise<SynthesisOutcome> {
  const runtime = completer;
  const inv = brief?.inventory;
  // Surface the user's existing agents + extensions + knowledge bases so the model
  // can reference real IDs instead of placeholders.
  const agents = deps.db
    .select({
      id: schema.agents.id,
      name: schema.agents.name,
      capabilityTags: schema.agents.capabilityTags,
      adapterType: schema.agents.adapterType,
      status: schema.agents.status,
    })
    .from(schema.agents)
    .where(eq(schema.agents.workspaceId, workspaceId))
    .all();
  const knowledgeBases = deps.knowledgeBases
    ? deps.knowledgeBases.listKnowledgeBases(workspaceId).map((kb) => ({ id: kb.id, name: kb.name }))
    : [];
  const extensions = deps.db
    .select()
    .from(schema.extensions)
    .where(eq(schema.extensions.workspaceId, workspaceId))
    .all()
    .map((extension) => {
      const manifest = extension.manifest as Partial<ExtensionManifest>;
      return {
        id: extension.id,
        name: extension.name,
        slug: extension.slug,
        runtime: extension.runtime,
        entrypoint: typeof manifest.entrypoint === 'string' ? manifest.entrypoint : extension.slug,
        capabilityTags: Array.isArray(manifest.capabilityTags) ? manifest.capabilityTags.filter((tag): tag is string => typeof tag === 'string') : [],
        operations: Array.isArray(manifest.operations) ? manifest.operations : [],
      };
    });

  const workspaceContext = inv?.workspaceContext ?? '';
  let experienceDossier = '';
  if (deps.workflowExperience) {
    try {
      const workflow = mutation
        ? deps.db.select({
            appId: schema.workflows.appId,
            activeRevisionId: schema.workflows.activeRevisionId,
            candidateRevisionId: schema.workflows.candidateRevisionId,
          }).from(schema.workflows).where(eq(schema.workflows.id, mutation.id)).get()
        : null;
      experienceDossier = deps.workflowExperience.renderDossier({
        workspaceId,
        workflowId: mutation?.id ?? '__new_workflow__',
        appId: workflow?.appId ?? null,
        activeRevisionId: workflow?.activeRevisionId ?? null,
        candidateRevisionId: workflow?.candidateRevisionId ?? null,
      });
    } catch (error) {
      deps.logger.warn('workflow.synthesis_experience_failed', { workspaceId, error: (error as Error).message });
    }
  }
  // The architecture protocol (12 iron rules) prevents one-node collapse + phantom
  // wiring; the creation brief tells the model what this workspace can actually wire.
  const systemPrompt = `${SYNTHESIS_ARCHITECT_PREAMBLE}\n\n${SYNTHESIS_SYSTEM_PROMPT}`;
  const userPrompt = [
    workspaceContext ? `${workspaceContext}\n` : '',
    brief ? renderCreationBrief(brief) : '',
    experienceDossier,
    // Phase 5 — feed the workspace's learned failure-mode lessons back into the
    // build so each new workflow is designed around mistakes past runs already hit.
    renderPlaybookLessons(recallWorkflowLessons(deps.memory, workspaceId)),
    `DESCRIPTION:\n${description}`,
    inv && inv.wireableIntegrations.length > 0
      ? `\nWIREABLE INTEGRATIONS (a credential exists — use an integration node with integrationId set to one of these): ${inv.wireableIntegrations.join(', ')}`
      : '\nNO INTEGRATION CREDENTIALS ARE CONFIGURED. For any email/Slack/GitHub/etc. step, still emit the integration node (it will show as pending-config) — do NOT bury "send an email" inside an agent_task prompt.',
    inv && inv.specialistRoles.length > 0
      ? `\nSPECIALIST ROLES (set agent_task.agentRole to the minimum-sufficient role by tool need):\n${inv.specialistRoles.map((r) => `- ${r.role} [${r.tools.join(', ')}] model=${r.defaultModel}`).join('\n')}`
      : '',
    agents.length > 0
      ? `\nBOUND AGENTS (pin only when you truly need a specific connected runtime; otherwise prefer agentRole):\n${agents.slice(0, 12).map((a) => `- ${a.id}: ${a.name} status=${a.status} adapter=${a.adapterType} tags=${(a.capabilityTags as string[] | undefined)?.join(', ') ?? 'none'}`).join('\n')}`
      : '',
    knowledgeBases.length > 0
      ? `\nAVAILABLE KNOWLEDGE BASES:\n${knowledgeBases.slice(0, 8).map((kb) => `- ${kb.id}: ${kb.name}`).join('\n')}`
      : '',
    inv && inv.knowledgeExcerpts.length > 0
      ? `\nBRAIN CONTEXT FOR THIS REQUEST (actual passages retrieved from the workspace Brain — use these to decide whether a knowledge node is warranted, which base to target, and a static query that will return content):\n${inv.knowledgeExcerpts.slice(0, 5).map((e) => `- [kb:${e.knowledgeBaseId}] ${e.content.replace(/\s+/g, ' ').trim().slice(0, 280)}`).join('\n')}`
      : '',
    extensions.length > 0
      ? `\nAVAILABLE EXTENSIONS (use real IDs; operations marked [listener-source] may power a persistent_listener trigger):\n${extensions.slice(0, 16).map((extension) => `- ${extension.id}: ${extension.name} slug=${extension.slug} runtime=${extension.runtime} operations=${extension.operations.map((op) => `${op.name}${op.isListenerSource ? '[listener-source]' : ''}`).join(', ') || 'execute'} tags=${extension.capabilityTags.join(', ') || 'none'}`).join('\n')}`
      : '',
    mutation
      ? `\nTHIS IS AN IN-PLACE EDIT OF "${mutation.title}", NOT A NEW WORKFLOW.\n`
        + 'Return {"patch":{"addNodes":[],"updateNodes":[],"removeNodeIds":[],"addEdges":[],"removeEdgeIds":[]}}. '
        + 'Each updateNodes entry needs the existing id plus ONLY the fields that change; omitted fields and nested config values are preserved. Preserve every unrelated node, edge, trigger, credential reference, schedule, state step, and output. '
        + 'Use removals only when the request requires them. Never replace the workflow with a smaller generic example.\n'
        + `CURRENT WORKFLOW GRAPH:\n${JSON.stringify(mutation.graph)}`
      : '',
  ].filter(Boolean).join('\n');

  // Self-correcting synthesis loop. A weak model often gets the graph *almost*
  // right (a stray cycle, a dangling edge). We deterministically repair the
  // common structural mistakes and, if the draft is still invalid, feed the
  // EXACT validation error back so the model can fix it on the next pass —
  // model-agnostic, no per-family tuning. Bounded so a failing model can't loop.
  let attemptPrompt = userPrompt;
  let lastError: string | null = null;
  // Three correction passes (was two): a weak model often needs the validation
  // error fed back more than once to converge on a valid graph; bounded so a
  // hopeless model still can't loop.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (signal?.aborted) return { graph: null, reason: 'model_error', error: 'canceled' };
    const result = await runtime.completeStructured<{ graph?: unknown; patch?: unknown }>({
      system: systemPrompt,
      user: attemptPrompt,
      maxTokens: 2500,
      timeoutMs: 30_000,
      // The outer self-correction loop already retries with validation feedback,
      // so keep inner JSON-parse retries low to bound worst-case latency.
      maxAttempts: 2,
      ...(signal ? { signal } : {}),
    });
    if (!result || (!result.graph && !result.patch)) {
      // A transport/parse failure (or no model) won't improve by re-asking for a
      // different graph — surface the real backend error and stop.
      lastError = runtime.lastError ?? 'the model did not return a workflow graph';
      deps.logger.warn('synthesizeWithLlm.no_graph', { workspaceId, error: lastError, attempt });
      return { graph: null, reason: 'model_error', error: lastError };
    }
    let graph: WorkflowGraph;
    try {
      graph = mutation && result.patch
        ? applyWorkflowMutationPatch(mutation.graph, result.patch)
        : result.graph as WorkflowGraph;
      if (mutation) assertMutationPreservesGraph(mutation.graph, graph, description);
    } catch (err) {
      lastError = (err as Error).message;
      deps.logger.warn('synthesizeWithLlm.invalid_mutation', { err: lastError, attempt });
      attemptPrompt = `${userPrompt}\n\nYOUR PREVIOUS PATCH WAS REJECTED: ${lastError}\n`
        + 'Return a minimal patch that preserves all unrelated nodes and edges.';
      continue;
    }
    // Defensive normalization — the model can omit version/viewport.
    const normalized: WorkflowGraph = {
      version: 1,
      nodes: Array.isArray(graph.nodes) ? graph.nodes : [],
      edges: Array.isArray(graph.edges) ? graph.edges : [],
      viewport: graph.viewport ?? { x: 0, y: 0, zoom: 1 },
    };
    // Probe validity against a deterministically-repaired copy (cycles, dangling
    // edges, delivery/state). We return the UNREPAIRED graph on success so the
    // main pipeline's repairGraph performs — and records in the trace — the
    // actual fixes; here repair is only the "is this salvageable?" oracle.
    const probe = brief ? repairGraph(normalized, brief.classification, brief.inventory).graph : normalized;
    try {
      validateWorkflowGraph(probe);
      return { graph: normalized, reason: 'ok' };
    } catch (err) {
      lastError = (err as Error).message;
      deps.logger.warn('synthesizeWithLlm.invalid_graph', { err: lastError, attempt });
      attemptPrompt = `${userPrompt}\n\nYOUR PREVIOUS GRAPH WAS REJECTED: ${lastError}\n`
        + 'Return a corrected graph. The graph MUST be acyclic (no edge may point back to an earlier node), '
        + 'every edge must connect two real node ids, and the workflow must end in a return_output or artifact_save node.';
    }
  }
  return { graph: null, reason: 'invalid_graph', error: lastError };
}

function isSynthesisRuntimeFailure(error: string | null | undefined): boolean {
  return Boolean(error && /\b(timeout|timed out|aborted|canceled|transport|channel closed|request failed|connection|network|unavailable|process error)\b/i.test(error));
}

/** ORCHESTRATOR-CREATION-10X §5 — the 13 Iron Rules that produce architecturally
 *  correct workflows regardless of domain. Prepended to the node catalog. */
const SYNTHESIS_ARCHITECT_PREAMBLE = [
  'WORKFLOW ARCHITECTURE PROTOCOL',
  'You are a workflow architect. Translate the user intent into a perfectly structured',
  'Agentis graph using the workspace inventory provided. Obey these IRON RULES:',
  '1. Single Responsibility — each agent_task does ONE thing. "Fetch AND summarize AND send"',
  '   must become http_request → agent_task → integration. Never one giant agent_task.',
  '2. Determinism First — if output is fully determined by input, use transform/filter, not an agent.',
  '3. Native Integration — email/Slack/GitHub/Sheets actions use an `integration` node, never',
  '   an agent_task prompt that says "send an email".',
  '4. Source Fetching — fetching a URL uses an `http_request` (or `browser`) node, never an agent prompt.',
  '5. Knowledge Before Agent — wire a `knowledge` node (Knowledge-Base/RAG search) before an agent_task that needs facts from UPLOADED DOCS. Do NOT add a node to write memory — the Brain learns automatically and agents write it via tools.',
  '6. Guard Expensive/External Steps — put an `evaluator` or `checkpoint` before any delivery action.',
  '7. Scheduled = Autonomous — a cron trigger runs unattended; do NOT add a checkpoint unless the',
  '   user explicitly asked for human approval.',
  '8. Parallel When Independent — independent fetches go under a `parallel` node, joined by `merge`.',
  '9. Name nodes for their OUTPUT ("Fetch Hacker News Top Stories"), never "Agent Task 2".',
  '10. Terminal node is ALWAYS return_output or artifact_save. A workflow ending in an agent_task is incomplete.',
  '11. Scheduling is a trigger property (cron), never a leading wait node.',
  '12. Credentials drive integrations — only set credentialId when a credential exists; otherwise',
  '    emit the integration node WITHOUT credentialId (it renders as pending-config for the operator to wire).',
  '13. Recurring Workflows Remember — for `cron` or `persistent_listener` triggers that accumulate state',
  '    (deduplication, tracking a last-run cursor, appending to a running log), add a `workflow_store` read',
  '    node near the start and a `workflow_store` write node near the end so each run builds on the last.',
  '14. RAL Requirements Are Hard Routing - `requires` on an agent node is ONLY for native runtime',
  '    powers advertised by AgentAdapter.capabilities(). Web search and URL reading are specialist tools;',
  '    screenshots/rendering/live page work belongs in a `browser` workflow node unless the agent itself',
  '    must control a native browser or computer-use runtime.',
  'Set agent_task.agentRole to the minimum-sufficient specialist by tool need (see SPECIALIST ROLES).',
  'Add a one-sentence `castingReason` to each agent_task config explaining the role choice.',
  '',
  WORKFLOW_DESIGN_DOCTRINE,
].join('\n');

/** Render the creation brief (caller domain + classification) for the user prompt. */
function renderCreationBrief(brief: CreationBrief): string {
  const lines: string[] = [];
  if (brief.callerName || brief.callerRole) {
    lines.push(`BUILT BY: ${brief.callerName ?? 'an agent'}${brief.callerRole ? ` (role: ${brief.callerRole})` : ''}`);
  }
  if (brief.callerDomain) lines.push(`CALLER DOMAIN BRIEF (authoritative for this domain):\n${brief.callerDomain}`);
  const c = brief.classification;
  lines.push(`CLASSIFICATION: archetype=${c.archetype}, trigger=${c.triggerType}, est_nodes=${c.estimatedNodeCount}`);
  if (c.requiredIntegrations.length) lines.push(`MENTIONED INTEGRATIONS: ${c.requiredIntegrations.join(', ')}`);
  if (c.missingCredentials.length) lines.push(`MISSING CREDENTIALS (emit pending-config integration nodes, no credentialId): ${c.missingCredentials.join(', ')}`);
  // ROBUSTNESS REQUIREMENTS (Phase 3) — translate the doctrine into THIS request's
  // mandatory gates/state, so the model designs for failure, not just the happy path.
  const rb = c.robustness;
  const recurring = c.triggerType === 'cron' || c.triggerType === 'persistent_listener';
  const needs = [
    rb.qualifies ? 'a qualification gate (router/evaluator) with a REJECT branch that loops back to the source instead of proceeding (D1)' : '',
    rb.approval ? 'a human approval checkpoint immediately before the irreversible action (D2)' : '',
    rb.validates && rb.irreversible ? 'a validation step AFTER the irreversible action (evaluator/router) with a rollback branch on failure (D6)' : '',
    rb.batch ? 'bounded fan-out for the per-item work (loop/parallel with a maxConcurrency cap, joined by merge) (D5)' : '',
    recurring ? 'workflow_store dedup state (a get near the start, a set near the end) so each run only handles what is new (D4)' : '',
    rb.iterative ? 'a `pursue` node for the open-ended iterate-until-done goal: it re-runs a COHORT sub-workflow each pass, carries state on the blackboard, measures progress, reflects when stuck, and stops on done/stall/budget — do NOT hand-wire a fixed-N evaluator retry edge. Set doneWhen (deterministic | judge | signal); for code-fixing cooperation set isolation:"worktree" + preserve:"pr" (D7)' : '',
  ].filter(Boolean);
  if (needs.length) {
    lines.push(`ROBUSTNESS REQUIREMENTS (this request needs these — encode each as real nodes, do not ship the happy path only):\n${needs.map((n) => `- ${n}`).join('\n')}`);
  }
  return lines.join('\n');
}

export const SYNTHESIS_SYSTEM_PROMPT = [
  'You are the Agentis workflow architect. Convert the user\'s description into a valid',
  '`WorkflowGraph` JSON object. Return ONLY a JSON object of shape',
  '{ "graph": { version: 1, nodes: [...], edges: [...], viewport: { x: 0, y: 0, zoom: 1 } } }',
  '— no prose, no markdown, no code fences.',
  '',
  'Node kinds. PREFER the PRIMARY set — it expresses the vast majority of workflows. Reach for an',
  'ADVANCED kind only when a primary one genuinely cannot do the job:',
  '  PRIMARY:',
  '    trigger        — entry point (manual | cron | webhook | persistent_listener)',
  '    agent_task     — a REAL tool-using agent (set useSession:true for a long, multi-step / delegating mission)',
  '    transform      — ALL deterministic data shaping: projection, array filter/dedupe/rank, object construction',
  '    filter         — boolean gate (pass / skip) — never returns data',
  '    http_request   — fetch a URL / call a JSON API',
  '    integration    — a connector action (Slack / Gmail / GitHub / Sheets / …)',
  '    component_task — a revision-pinned deterministic Component operation; prefer it over an agent when code can express the work exactly',
  '    knowledge      — Knowledge-Base (RAG) search over UPLOADED DOCS (not the Brain memory)',
  '    router         — branch by condition',
  '    merge          — join parallel branches',
  '    evaluator      — LLM-judge gate: score an output, route pass/fail, retry on fail',
  '    workflow_store — persistent state ACROSS RUNS of this workflow (dedup cursors, running logs)',
  '    return_output  — REQUIRED terminal node that renders the operator-facing result',
  '  ADVANCED (only when warranted): loop, parallel, converge (loop-until-a-goal), dynamic_swarm (parallelize an',
  '    unknown number of similar items), agent_swarm, planner, subflow, wait, checkpoint (human approval),',
  '    guardrails, browser (headless web automation), artifact_save, artifact_collect, scratchpad',
  '    (ephemeral state within ONE run).',
  '',
  'Choosing an intelligence node (smallest sufficient): agent_task (one focused mission; +useSession for long,',
  'stateful, delegating work)  <  dynamic_swarm (parallelize an unknown number of similar items)  <  converge',
  '(iterate a cohort until a goal or quality bar is met). A single agent_task already searches the web + KB,',
  'recalls/records memory, persists state, and runs sandboxed code — so prefer ONE capable agent_task over a',
  'pipeline of tiny ones.',
  '',
  'Required config fields per kind (anything else is optional):',
  '  trigger:        { kind: "trigger", triggerType: "manual" | "cron" | "webhook" | "persistent_listener" }',
  '                  cron also requires schedule (five-field cron) and optional timezone.',
  '                  persistent_listener also requires listenerConfig: { source, predicate?, firePolicy? }.',
  '                  When the operator asks to watch/listen continuously, 24/7, or react immediately to new items, use',
  '                  persistent_listener, not cron. If they requested a new extension, bind its real listener-source',
  '                  operation as listenerConfig.source = { kind:"extension", extensionId, operationName, config, pollIntervalMs }.',
  '  agent_task:     { kind: "agent_task", prompt, capabilityTags, inputKeys, outputKeys, agentId?, agentRole?, requires? }',
  '                  A REAL tool-using agent (not a single completion): it runs a bounded reason→act→observe loop and can',
  '                  search the web + knowledge base, recall/record memory, persist workflow state, run sandboxed compute,',
  '                  and call other workflows — so give it an ambitious mission, not a one-line instruction. agentRole picks',
  '                  a specialist: a built-in (planner|researcher|coder|reviewer|analyst|writer|monitor|architect|debugger|deployer)',
  '                  OR a custom slug (e.g. "frontend_architect", "tax_analyst") which is auto-created as an on-demand specialist.',
  '                  Prefer agentRole over a blank agentId so the task is runnable without manual binding. Set useRoleTools:false',
  '                  ONLY for a pure one-shot rewrite/format with no reasoning. `requires` is hard RAL runtime routing,',
  '                  not normal tool intent. Do not set requires.browser for research, web search, URL reading, scraping,',
  '                  qualification, curation, analysis, or writing. For ordinary web automation — open a page, log in, fill a',
  '                  form, scrape, screenshot, or render a PDF — use a `browser` node (platform headless Chromium), NOT',
  '                  requires.browser. Set requires.browser/computerUse only when this agent task itself must drive a native,',
  '                  stateful browser/desktop/GUI/computer-use runtime that the operator has actually connected.',
  '                  PERSISTENCE: for a long, multi-step mission that must DELEGATE to sub-agents, await events, or',
  '                  pause for approval (sleeping at zero cost while it waits), set `useSession: true` on the',
  '                  agent_task. Do NOT emit a separate node kind for this — one agent node, with a flag. Prefer a',
  '                  plain agent_task (no useSession) for a single focused reasoning task.',
  '  dynamic_swarm:  { kind: "dynamic_swarm", goal, agentRole, maxTasks, maxParallel, mergeStrategy: "collect_all"|"first_success"|"majority_vote", outputKey, capabilityTags }',
  '                  A planner agent decides the task LIST at runtime from `goal`, then maxParallel workers (role=agentRole) run',
  '                  in parallel. Use for broad, parallelizable work whose item count is unknown up front (e.g. "research each',
  '                  competitor we discover"). The engine hard-caps maxTasks.',
  '  planner:        { kind: "planner", goal, agentRole?, workerRole?, inputKeys, outputKeys, maxNodes? }',
  '                  A planner agent decomposes `goal` and SPLICES the sub-steps into the live run as real agent nodes (they',
  '                  appear on the canvas and run through the engine). Use when the sub-structure is unknown until runtime.',
  '  knowledge:      { kind: "knowledge", queryMode: "static" | "dynamic", topK, retrievalMode }',
  '                  Searches the Knowledge Base (uploaded docs / RAG). NOT the Brain (the',
  '                  agents\' learned memory) — that fills automatically from chat + runs, and',
  '                  agents write it via tools; never author a node to "save to the Brain".',
  '  router:         { kind: "router", routingMode: "first_match" | "all_matching" | "llm_route", branches: [] }',
  '  merge:          { kind: "merge", requiredInputs: "all" | "any" }',
  '  checkpoint:     { kind: "checkpoint", approvalMode: "manual" | "auto_after_timeout" }',
  '  scratchpad:     { kind: "scratchpad", operation: "read"|"write"|"append"|"delete", key }',
  '  wait:           { kind: "wait", delayMs }',
  '  transform:      { kind: "transform", expression }',
  '                  Use this for ALL data shaping, projection, array filtering, dedupe, ranking, and object construction.',
  '                  Example: `({ articles: (nodes.fetch.results || []).filter(a => a.keep) })` belongs in transform.',
  '  filter:         { kind: "filter", condition }',
  '                  BOOLEAN ONLY. `condition` must evaluate to true/false. It is a gate, not a mapper. Do NOT return objects or arrays here.',
  '  integration:    { kind: "integration", integrationId, operationId, inputs }',
  '  http_request:   { kind: "http_request", method, url, headers?, body?, auth?, responseMapping? }',
  '                  responseMapping shape is EXACTLY `{ outputKey, bodyPath? }`. Example whole-body alias: `{ outputKey: "raw" }`.',
  '                  Example JSON extraction: `{ outputKey: "items", bodyPath: "data.items" }`. Never use `{ raw: "body" }` or `{ json: "body" }`.',
  '  workflow_store: { kind: "workflow_store", operations: [{ op, key, value?, outputKey? }] }',
  '                  op MUST be one of: get | set | delete | increment | append | get_all (NOT read/write).',
  '                  Persistent KV SCOPE: `workflow_store` persists across runs of THIS workflow (the common case —',
  '                  dedup cursors, running logs). For state shared across ALL workflows use `workspace_store`',
  '                  (same operations shape); for throwaway state within ONE run use `scratchpad`.',
  '  component_task: { kind: "component_task", componentId? | componentSlug?, operationName, version, inputMapping, outputMapping, stateBindings?, idempotencyKeyPath? }',
  '                  stateBindings maps a state name to { key, mode:"read"|"read_write"|"set", writeFrom? }. State is loaded from workflow-scoped durable storage, passed as input.state, and committed atomically only after success.',
  '                  idempotencyKeyPath identifies a stable input item so retries return the prior receipt without repeating the operation.',
  '  evaluator:      { kind: "evaluator", targetPath, criteria, passThreshold? }',
  '  guardrails:     { kind: "guardrails", rules: [], onViolation: "block"|"flag" }',
  '  loop:           { kind: "loop", itemsExpression, maxConcurrency, bodyWorkflowId, outputArrayKey, onIterationError }',
  '  pursue:         { kind: "pursue", bodyWorkflowId, doneWhen, maxIterations?, budget?, stopWhenStalled?, isolation?, preserve?, assess?, maxPivots? }',
  '                  The cognitive LOOP-UNTIL-DONE primitive (the intelligent loop). `bodyWorkflowId` is a cohort sub-workflow',
  '                  (e.g. research→fix→verify) re-run each iteration until `doneWhen` says stop. doneWhen is ONE of:',
  '                  { type: "deterministic", expr: "body.openBugCount > 0" } — keep going while true;',
  '                  { type: "judge", targetPath, criteria, passThreshold? } — keep going while the judge FAILS;',
  '                  { type: "signal", channel? } — agents post a done-signal when finished. State carries across iterations on the',
  '                  blackboard. It MEASURES progress each pass (assess, default on) and, when stuck, REFLECTS — feeds a self-critique',
  '                  forward and changes tack up to `maxPivots` (default 2) instead of quitting; stops on done / stall / budget.',
  '                  isolation: "auto"|"worktree"|"shared"; preserve: "discard"|"branch"|"pr" turns a coding loop into a reviewable PR.',
  '                  Use for open-ended goals, not fixed-N work. (Legacy alias: kind "converge" with `continuation`/`stallPolicy`.)',
  '  parallel:       { kind: "parallel", waitFor, onBranchError, mergeStrategy }',
  '  agent_swarm:    { kind: "agent_swarm", prompt, inputArrayPath, maxParallel, mergeStrategy, capabilityTags, outputKey }',
  '  artifact_collect: { kind: "artifact_collect", collectionName }',
  '  return_output:  { kind: "return_output", renderAs: "html"|"markdown"|"table"|"json"|"text", title?, valuePath? }',
  '  artifact_save:  { kind: "artifact_save", name, artifactType?, contentPath?, titlePath? }',
  '  browser:        { kind: "browser", operation: "serve_html"|"screenshot"|"pdf"|"navigate"|"extract_text", url?, html?, htmlPath?, selector? }',
  '',
  'Variable templates: any string field accepts `{{trigger.foo}}`, `{{nodes.<id>.path}}`,',
  '`{{scratchpad.key}}`, `{{store.key}}`, and inside loops `{{loop.item}}` / `{{loop.index}}`.',
  'Router branch conditions are NOT template strings. Write safe conditions such as',
  '`inputs["fetch-feed"].count > 0` or `trigger.status == "ready"`.',
  'Never use `{{...}}`, `===`, or `!==` inside router branch conditions.',
  'For persistent_listener triggers, a single event arrives at the trigger/input root and also as',
  '`item`, with `events` and `count` convenience aliases. Do not assume a batched `posts[]` payload',
  'unless your listener fire policy or payloadTransform creates one explicitly.',
  '',
  'Edges: { id, source, target, type?: "default"|"error"|"condition" }. Wire an error edge',
  'when a node has a meaningful recovery path. Otherwise stick with default edges.',
  '',
  'Principles:',
  '- Every workflow starts with exactly one trigger node.',
  '- Prefer deterministic primitives (transform/filter/http_request/integration) over agent_task',
  '  whenever the step does NOT require reasoning. Saves cost and is more reliable.',
  '- If you need to FILTER an array and keep the filtered array for downstream nodes, that is still a `transform`, not a `filter` node.',
  '- Every workflow ends in a `return_output` node — it declares the rendered result the operator sees.',
  '  Pick renderAs by the result type: html page → "html", report/prose → "markdown", row data → "table",',
  '  structured object → "json", short message → "text".',
  '- For fixed responses such as "Hello World", use trigger -> transform (produces the value) -> return_output.',
  '- For HTML page / landing page / browser-preview requests, use trigger -> transform that returns',
  '  { type: "html", title, content: "<h1>...</h1>" } -> return_output with renderAs: "html".',
  '- Use `artifact_save` to persist a file (report.html, data.csv) the operator can download.',
  '- For "open a browser" / "screenshot" / live page rendering, use a `browser` node:',
  '  produce HTML in a transform, then browser serve_html with htmlPath:"content", then return_output renderAs:"html".',
  '- RAL runtime requirements (`requires`) are rare. Web search uses specialist tools; URL fetch/scrape uses',
  '  http_request/browser nodes; only native browser/computer-control agent tasks need requires.browser/computerUse.',
  '- Choosing the intelligence node: default to `agent_task` (a capable tool-using agent) for a focused reasoning task.',
  '  Set `useSession: true` on the agent_task when the work must delegate to sub-specialists, run many steps, or keep',
  '  memory across steps; use `dynamic_swarm` to fan out an unknown number of parallel sub-tasks. Do NOT chain many',
  '  tiny agent_tasks when one capable agent_task (with useSession if needed) would be cleaner.',
  '- Use `evaluator` after an `agent_task` whenever output quality matters; route its FAIL handle',
  '  back to the agent_task with the critique embedded via `{{nodes.<EVALID>.critique}}`.',
  '- Use `checkpoint` only when human review is genuinely needed (irreversible action, high spend).',
  '- Always give each node a stable string `id` (kebab-case) and a human-readable `title`.',
  '- Place nodes left-to-right: trigger at x ≈ 0, each downstream step at x += 260.',
  '',
  'WORKED EXAMPLES (study the SHAPE — node kinds, how edges connect, the terminal return_output — then',
  'adapt to the request; do not copy them literally):',
  '',
  'A) Scheduled digest — "every morning email me a summary of new HN AI posts":',
  '{"version":1,"viewport":{"x":0,"y":0,"zoom":1},"nodes":[',
  '  {"id":"trigger","type":"trigger","title":"Every morning 9am","position":{"x":0,"y":0},"config":{"kind":"trigger","triggerType":"cron","schedule":"0 9 * * *"}},',
  '  {"id":"seen","type":"workflow_store","title":"Load seen IDs","position":{"x":260,"y":0},"config":{"kind":"workflow_store","operations":[{"op":"get","key":"seenIds","outputKey":"seen"}]}},',
  '  {"id":"fetch","type":"http_request","title":"Fetch HN AI posts","position":{"x":520,"y":0},"config":{"kind":"http_request","method":"GET","url":"https://hn.algolia.com/api/v1/search?query=AI&tags=story","responseMapping":{"outputKey":"hits","bodyPath":"hits"}}},',
  '  {"id":"new","type":"transform","title":"Keep only new posts","position":{"x":780,"y":0},"config":{"kind":"transform","expression":"({ posts: (nodes.fetch.hits||[]).filter(p => !(nodes.seen.seen||[]).includes(p.objectID)) })"}},',
  '  {"id":"write","type":"agent_task","title":"Write the digest","position":{"x":1040,"y":0},"config":{"kind":"agent_task","agentRole":"writer","prompt":"Write a concise morning digest of these AI posts.","inputKeys":["posts"],"outputKeys":["subject","body"]}},',
  '  {"id":"send","type":"integration","title":"Email the digest","position":{"x":1300,"y":0},"config":{"kind":"integration","integrationId":"agentmail","operationId":"send_message","inputs":{"subject":"{{nodes.write.subject}}","body":"{{nodes.write.body}}"}}},',
  '  {"id":"save","type":"workflow_store","title":"Remember sent IDs","position":{"x":1560,"y":0},"config":{"kind":"workflow_store","operations":[{"op":"set","key":"seenIds","value":"{{nodes.fetch.hits}}"}]}},',
  '  {"id":"out","type":"return_output","title":"Done","position":{"x":1820,"y":0},"config":{"kind":"return_output","renderAs":"markdown","valuePath":"nodes.write.body"}}',
  '],"edges":[{"id":"e1","source":"trigger","target":"seen"},{"id":"e2","source":"seen","target":"fetch"},{"id":"e3","source":"fetch","target":"new"},{"id":"e4","source":"new","target":"write"},{"id":"e5","source":"write","target":"send"},{"id":"e6","source":"send","target":"save"},{"id":"e7","source":"save","target":"out"}]}',
  '',
  'B) Watch → qualify → act — "when a new lead arrives, score it and Slack me only the good ones":',
  '{"version":1,"viewport":{"x":0,"y":0,"zoom":1},"nodes":[',
  '  {"id":"trigger","type":"trigger","title":"New lead webhook","position":{"x":0,"y":0},"config":{"kind":"trigger","triggerType":"webhook"}},',
  '  {"id":"score","type":"agent_task","title":"Score the lead","position":{"x":260,"y":0},"config":{"kind":"agent_task","agentRole":"analyst","prompt":"Score this lead 0-10 for fit and explain why.","inputKeys":["lead"],"outputKeys":["score","reason"]}},',
  '  {"id":"gate","type":"router","title":"Good lead?","position":{"x":520,"y":0},"config":{"kind":"router","routingMode":"first_match","branches":[{"label":"good","condition":"nodes.score.score >= 7"}]}},',
  '  {"id":"notify","type":"integration","title":"Slack me","position":{"x":780,"y":0},"config":{"kind":"integration","integrationId":"slack","operationId":"send_message","inputs":{"text":"Hot lead ({{nodes.score.score}}): {{nodes.score.reason}}"}}},',
  '  {"id":"out","type":"return_output","title":"Done","position":{"x":1040,"y":0},"config":{"kind":"return_output","renderAs":"json","valuePath":"nodes.score"}}',
  '],"edges":[{"id":"e1","source":"trigger","target":"score"},{"id":"e2","source":"score","target":"gate"},{"id":"e3","source":"gate","target":"notify","type":"condition","condition":"nodes.score.score >= 7"},{"id":"e4","source":"notify","target":"out"},{"id":"e5","source":"gate","target":"out"}]}',
].join('\n');
