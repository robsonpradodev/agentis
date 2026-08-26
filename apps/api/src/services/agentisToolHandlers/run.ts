/**
 * Run tools — agent triggers, cancels, replays, resumes work.
 *
 * Mutating tools always require explicit ids; the registry's argument
 * validation refuses calls missing required keys before reaching here.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS, type WorkflowGraph, type WorkflowRunState } from '@agentis/core';
import { buildInitialRunState } from '../../engine/initialRunState.js';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import { collectFailedNodeIds, failedNodeCount } from '../run/runStateFailures.js';
import { workflowDurationStats } from '../run/runAnalytics.js';
import { waitForRunSettle, waitForAllRunsSettle } from '../run/runSettle.js';
import { analyzeRunFailure } from '../run/runFailureAnalysis.js';
import { recordWorkflowLesson, recallWorkflowLessons } from '../workflow/workflowPlaybook.js';
import { compassForRun, detectProvenDivergence, graphContentHash, readBuildLoop, type CompassStep } from '../workflow/workflowCompass.js';
import { collectReplayFrontierNodeIds } from '../partialReplay.js';
import { compileAppReadiness } from '../app/appCompiler.js';
import { resolveStartAt } from '../workflow/deferredStart.js';
import { resolveWorkflowExecutionTarget } from '../workflow/workflowExecutionTarget.js';
import { queueWorkflowRun } from '../scheduler.js';
import type { ToolHandlerDeps } from './deps.js';
import { normalizeRunOutcomeStatus } from '../workflow/runOutcome.js';

export function registerRunTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.workflow.run',
        family: 'run',
        mcpExposed: true,
        description:
          '[PAVED ROAD 3–4/5 — DEBUG-RUN / RUN] Start a workflow run with optional inputs. Set debugRun:true for a TEST run that '
          + 'disables self-healing and fallback recovery so you observe the RAW per-node failure '
          + 'and, by default, resumes the latest same-graph failed/deficient frontier without repeating proven upstream work. '
          + 'Use restartMode:"fresh" only when root inputs or upstream behavior must be exercised again. '
          + '(step 3 — do this once after a green dry_run; use a normal run in production, step 4). '
          + 'The result includes compass.next (agentis.run.await to block until it settles — event-driven, zero-token; diagnose on failure).',
        inputSchema: {
          type: 'object',
          properties: {
            workflowId: { type: 'string' },
            taskId: { type: 'string' },
            planId: { type: 'string' },
            inputs: { type: 'object' },
            input: { type: 'string' },
            debugRun: { type: 'boolean', description: 'Test run: disable self-heal + fallback so raw per-node failures surface.' },
            restartMode: {
              type: 'string',
              enum: ['auto', 'fresh', 'failed_frontier'],
              description: 'Debug-run restart policy. auto (default) resumes the latest same-graph failed/deficient frontier; fresh explicitly starts at the root.',
            },
            startAt: {
              type: 'string',
              description:
                'DEFER the start to this ISO-8601 instant instead of now. The run becomes a queue row and begins when due — '
                + 'it holds no process and spends no tokens while it waits.',
            },
            delayMs: {
              type: 'number',
              description:
                'Defer the start by this many milliseconds (adds to startAt when both are given). Use for staggered fan-out '
                + '(call once per item with an increasing delay), backoff, and rate-limited downstreams.',
            },
            jitterMs: {
              type: 'number',
              description:
                'Random extra wait in [0, jitterMs). Spreads starts that would otherwise land on the same instant — '
                + 'prefer this over exact spacing when many runs share a downstream.',
            },
            waitMode: {
              type: 'string',
              enum: ['background', 'inline', 'auto'],
              description:
                'background (default) returns immediately and durably parks the resident orchestrator until a completion/judgment event; '
                + 'inline starts+awaits in this call (max 15m); auto uses observed duration (inline at <=2m, otherwise background).',
            },
            timeoutMs: {
              type: 'number',
              description: 'For waitMode:inline/auto-inline: max wait in ms (default 300000, max 900000).',
            },
          },
          required: ['workflowId'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const wf = deps.db
          .select()
          .from(schema.workflows)
          .where(eq(schema.workflows.id, String(args.workflowId)))
          .get();
        if (!wf || wf.workspaceId !== ctx.workspaceId) {
          throw new Error(`workflow ${args.workflowId} not found in workspace`);
        }
        const debugRun = args.debugRun === true;
        const target = deps.revisions
          ? resolveWorkflowExecutionTarget({
              db: deps.db,
              revisions: deps.revisions,
              workspaceId: ctx.workspaceId,
              workflowId: wf.id,
              mode: debugRun ? 'candidate_or_active' : 'active',
            })
          : null;
        const graph = (target?.graph ?? wf.graph) as WorkflowGraph;
        const workflowRevisionId = target?.revisionId ?? wf.activeRevisionId ?? null;
        const requestedWaitMode = typeof args.waitMode === 'string' ? args.waitMode : 'background';
        if (!['background', 'inline', 'auto'].includes(requestedWaitMode)) {
          throw new AgentisError('VALIDATION_FAILED', `unknown waitMode '${requestedWaitMode}'`);
        }
        const planId = args.planId ? String(args.planId) : args.taskId ? String(args.taskId) : null;
        if (wf.appId) {
          const compile = compileAppReadiness(
            deps.db,
            ctx.workspaceId,
            wf.appId,
            debugRun ? 'debug' : 'production',
            new Date(),
            target ? { workflowId: wf.id, revisionId: target.revisionId, graph: target.graph } : undefined,
          );
          if (!compile.readyForExecution) {
            throw new AgentisError(
              'VALIDATION_FAILED',
              `APP_COMPILE_BLOCKED: workflow belongs to App ${wf.appId}, which is not ready for ${debugRun ? 'debug' : 'production'} execution (${compile.executionBlockerCount} execution blocker(s)). Clear the zero-cost repair batch before spending on a run.`,
              {
                httpStatus: 409,
                remediation: compile.repairPlan.zeroCost[0]
                  ? `Apply all compatible compile.repairPlan.zeroCost actions, run agentis.app.verify once, then compile once. First action: ${compile.repairPlan.zeroCost[0].tool} ${JSON.stringify(compile.repairPlan.zeroCost[0].args)}`
                  : 'Run agentis.app.compile and clear the blocking checks as one compatible batch.',
                details: { appId: wf.appId, structuralReady: compile.structuralReady, executableReady: compile.executableReady, executionBlockerCount: compile.executionBlockerCount, evidencePendingCount: compile.evidencePendingCount, blockers: compile.checks.filter((check) => check.status === 'block' && check.blocksExecution !== false), repairPlan: compile.repairPlan },
              },
            );
          }
        }
        const requestedRestartMode = typeof args.restartMode === 'string' ? args.restartMode : undefined;
        if (requestedRestartMode && !['auto', 'fresh', 'failed_frontier'].includes(requestedRestartMode)) {
          throw new AgentisError('VALIDATION_FAILED', `unknown restartMode '${requestedRestartMode}'`);
        }
        if (!debugRun && requestedRestartMode && requestedRestartMode !== 'fresh') {
          throw new AgentisError('VALIDATION_FAILED', 'restartMode auto/failed_frontier is available only when debugRun:true');
        }
        const restartMode = debugRun ? requestedRestartMode ?? 'auto' : 'fresh';
        const hasExplicitInputs = args.inputs !== undefined || args.input !== undefined;
        if (restartMode === 'failed_frontier' && hasExplicitInputs) {
          throw new AgentisError(
            'VALIDATION_FAILED',
            'failed_frontier preserves upstream outputs and cannot accept replacement inputs; use restartMode:"fresh"',
          );
        }
        const inputs = parseInputs(args.inputs ?? args.input);
        // DEFERRED START — the run queue already gates on `scheduledAt`; this is
        // the agent's way to set it. Route through the queue rather than
        // startRun: a deferred run must be a row until it is due, not a timer
        // held in this process (which a restart would lose).
        const scheduledAt = resolveStartAt({
          startAt: typeof args.startAt === 'string' ? args.startAt : null,
          delayMs: typeof args.delayMs === 'number' ? args.delayMs : null,
          jitterMs: typeof args.jitterMs === 'number' ? args.jitterMs : null,
        });
        if (scheduledAt) {
          if (debugRun) {
            throw new AgentisError(
              'VALIDATION_FAILED',
              'a debug run is an interactive verification step and cannot be deferred — drop startAt/delayMs/jitterMs, or drop debugRun',
            );
          }
          const queued = await queueWorkflowRun(
            { db: deps.db, bus: deps.bus, engine: deps.engine, logger: deps.logger },
            {
              workflowId: wf.id,
              workspaceId: ctx.workspaceId,
              ambientId: ctx.ambientId ?? null,
              userId: ctx.userId,
              triggerId: null,
              inputs,
              reason: 'agent_scheduled',
              scheduledAt,
            },
          );
          return {
            runId: queued.runId,
            workflowId: wf.id,
            status: 'scheduled',
            scheduledAt,
            // Deliberately NOT compass→run.await: blocking on a run that starts
            // hours from now is the wrong next move. Check back, or chain off it.
            next:
              `Queued to start at ${scheduledAt}. Until then it is a queue row — no process, no tokens. `
              + 'Use agentis.run.status to check it, or agentis.workflow.chain to make downstream work depend on it.',
          };
        }
        const activeDebugRun = debugRun && restartMode !== 'fresh' && !hasExplicitInputs
          ? latestSameGraphActiveRun(deps, ctx.workspaceId, wf.id, graph)
          : null;
        if (activeDebugRun) {
          return {
            runId: activeDebugRun.id,
            workflowId: wf.id,
            status: 'already_running',
            restartMode: 'in_progress',
            note: 'A same-graph debug run is already active; await or inspect it instead of starting a duplicate.',
            compass: compassForRun({ runId: activeDebugRun.id, workflowId: wf.id, status: 'started', debugRun: true }),
          };
        }
        const candidate = debugRun && restartMode !== 'fresh' && !hasExplicitInputs
          ? latestSameGraphReplayCandidate(deps, ctx.workspaceId, wf.id, graph)
          : null;
        if (restartMode === 'failed_frontier' && !candidate) {
          throw new AgentisError(
            'REPLAY_TARGET_INVALID',
            'no latest same-graph failed or verdict-deficient frontier exists; use restartMode:"fresh"',
          );
        }
        const prepared = candidate
          ? deps.replay.prepare({
              workspaceId: ctx.workspaceId,
              sourceRunId: candidate.id,
              mode: 'replay-failed-branch',
              userId: ctx.userId,
            })
          : null;
        const runId = prepared?.runId ?? randomUUID();
        const initialState: WorkflowRunState = prepared?.initialState ?? buildInitialRunState({
          runId,
          workflowId: wf.id,
          graph,
          inputs,
        });
        if (prepared && candidate) initialState.replanCount = candidate.replanCount + 1;
        deps.db.insert(schema.workflowRuns).values({
          id: runId,
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId ?? null,
          workflowId: wf.id,
          conversationId: ctx.conversationId ?? null,
          userId: ctx.userId,
          status: 'CREATED',
          runState: initialState,
          graphSnapshot: graph,
          workflowRevisionId,
          triggerId: null,
          ...(candidate ? {
            isReplay: true,
            parentRunId: candidate.id,
            replanCount: candidate.replanCount + 1,
          } : {}),
        }).run();
        deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), REALTIME_EVENTS.RUN_CREATED, {
          runId,
          workflowId: wf.id,
          ambientId: ctx.ambientId ?? null,
        });
        // Decide before dispatch so a background resident can be durably parked
        // before a very fast run has any chance to emit its terminal wake.
        const timing = workflowDurationStats(deps.db, ctx.workspaceId, wf.id);
        const effectiveWaitMode =
          requestedWaitMode === 'auto'
            ? timing && timing.p50Ms <= 120_000 ? 'inline' : 'background'
            : requestedWaitMode;
        const residentParked = effectiveWaitMode === 'background' && ctx.agentId && deps.parkResidentRuns
          ? deps.parkResidentRuns({
              workspaceId: ctx.workspaceId,
              agentId: ctx.agentId,
              runIds: [runId],
              conversationId: ctx.conversationId,
            })
          : false;
        let handle;
        try {
          handle = await deps.engine.startRun({
            workspaceId: ctx.workspaceId,
            ambientId: ctx.ambientId ?? null,
            conversationId: ctx.conversationId ?? null,
            workflowId: wf.id,
            ...(planId ? { planId } : {}),
            userId: ctx.userId,
            triggerId: null,
            inputs: prepared?.inputs ?? inputs,
            initialState,
            debugRun,
            graph,
            workflowRevisionId,
          });
        } catch (err) {
          if (residentParked && ctx.agentId) {
            deps.wakeResident?.({ workspaceId: ctx.workspaceId, agentId: ctx.agentId });
          }
          throw err;
        }
        // SWIFT "warn previously": a PRODUCTION run (not a debug run — that IS the
        // verification) of a graph that diverges from its PROVEN blueprint/hardened
        // version is proceeding UNVERIFIED. Warn the agent at the run, before a
        // failure it would then have to self-heal.
        const divergence =
          debugRun
            ? null
            : detectProvenDivergence(readBuildLoop(wf.settings), graphContentHash(graph), wf.id);
        // TEMPORAL SELF-MODEL — tell the agent HOW LONG this workflow usually
        // takes, from its own run history, so it can decide to await inline (short)
        // vs. move on and await later (long) instead of guessing a sleep window.
        if (effectiveWaitMode === 'inline') {
          const timeoutMs = clampNumber(args.timeoutMs, 300_000, 1_000, 900_000);
          const settled = await waitForRunSettle(deps, ctx.workspaceId, handle.runId, { timeoutMs });
          const snapshot = runStatus(deps, ctx.workspaceId, handle.runId);
          const suspendedAfterTimeout =
            settled.resolved === 'timeout' && ctx.agentId && deps.parkResidentRuns
              ? deps.parkResidentRuns({
                  workspaceId: ctx.workspaceId,
                  agentId: ctx.agentId,
                  runIds: [handle.runId],
                  conversationId: ctx.conversationId,
                })
              : false;
          return {
            ...snapshot,
            runId: handle.runId,
            workflowId: handle.workflowId,
            workflowRevisionId,
            started: true,
            waitMode: 'inline',
            awaited: settled.resolved,
            ...(settled.resolved === 'timeout'
              ? {
                  timedOut: true,
                  residentSuspended: suspendedAfterTimeout,
                  note: 'Still running after the inline wait cap; the resident orchestrator is now parked and will be selectively woken.',
                }
              : {}),
            ...(timing ? { timing } : {}),
          };
        }
        // PAVED-ROAD P1 — every result is a signpost: hand the agent the exact
        // next call (poll → diagnose-on-fail) instead of a terminal "started".
        return {
          runId: handle.runId,
          workflowId: handle.workflowId,
          workflowRevisionId,
          status: 'started',
          waitMode: 'background',
          residentSuspended: residentParked,
          restartMode: candidate ? 'failed_frontier' : 'fresh',
          ...(candidate ? {
            resumedFromRunId: candidate.id,
            reusedNodeIds: initialState.completedNodeIds,
          } : {}),
          ...(divergence ? { divergence } : {}),
          ...(timing ? {
            timing: {
              typicalMs: timing.p50Ms,
              p95Ms: timing.p95Ms,
              samples: timing.sampleCount,
              summary: timing.summary,
              guidance: timing.p50Ms <= 120_000
                ? 'Short run — agentis.run.await now is fine (event-driven, zero-token).'
                : 'Longer run — do NOT busy-wait. Do other useful work now and agentis.run.await when convenient (zero tokens while blocked), await several together with agentis.run.await_all, or chain downstream work off it with agentis.workflow.chain.',
            },
          } : {}),
          compass: compassForRun({
            runId: handle.runId,
            workflowId: handle.workflowId,
            status: 'started',
            debugRun,
          }),
        };
      },
    },
    {
      definition: {
        id: 'agentis.run.cancel',
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
        if (!run || run.workspaceId !== ctx.workspaceId) {
          throw new Error(`run ${args.runId} not found`);
        }
        await deps.engine.cancelRun(run.id);
        return { runId: run.id, status: 'cancelled' };
      },
    },
    {
      definition: {
        id: 'agentis.run.regrade',
        family: 'run',
        mcpExposed: true,
        description:
          'Re-evaluate a COMPLETED run against the workflow current graph-reconciled definition of done using persisted node outputs and world probes. '
          + 'This NEVER replays workflow nodes or repeats outward side effects. Use it after repairing only the acceptance spec/output contract; do not launch another live run just to refresh a verdict.',
        inputSchema: {
          type: 'object',
          properties: { runId: { type: 'string' } },
          required: ['runId'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const result = await deps.engine.regradeCompletedRun({ workspaceId: ctx.workspaceId, runId: String(args.runId) });
        return {
          ...result,
          accomplished: result.verdict.outcome === 'accomplished',
          executionReplayed: false,
          outwardSideEffectsRepeated: false,
          next:
            result.verdict.outcome === 'accomplished'
              ? 'Persisted evidence now satisfies the definition of done. Continue from the next business event/frontier; do not rerun this workflow.'
              : 'Repair the definition of done using terminalOutputPaths when the evidence path is wrong; repair producing nodes only when the evidence itself is deficient. Then regrade again without replay.',
        };
      },
    },
    {
      definition: {
        id: 'agentis.run.status',
        family: 'run',
        mcpExposed: true,
        description: '[PAVED ROAD 5/5 — OBSERVE] One-off status snapshot of a run (lighter than agentis.run.inspect). To WAIT for a run to finish, use agentis.run.await (event-driven, zero-token) instead of polling this in a sleep loop. On FAILED the compass points to agentis.run.diagnose.',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
        mutating: false,
      },
      handler: async (args, ctx) => {
        return runStatus(deps, ctx.workspaceId, String(args.runId));
      },
    },
    {
      definition: {
        id: 'agentis.run.await',
        family: 'run',
        mcpExposed: true,
        description:
          '[EFFICIENT WAIT] BLOCK until a run settles — COMPLETED / FAILED / CANCELLED, or PAUSED/WAITING (e.g. on an approval) — '
          + 'or until an optional specific node completes, then return its full status in ONE call. Use this INSTEAD of sleeping '
          + '(Start-Sleep / setTimeout) and polling agentis.run.status in a loop: it is event-driven and wakes you the instant the '
          + 'run finishes, so you spend ZERO tokens while waiting (no re-reading state, no guessing sleep durations). Returns '
          + 'immediately if the run is already settled. Bounded by timeoutMs; on timeout it returns the current status with '
          + 'timedOut:true — just call it again to keep waiting.',
        inputSchema: {
          type: 'object',
          properties: {
            runId: { type: 'string' },
            nodeId: { type: 'string', description: 'Optional: wake as soon as THIS node completes/fails, instead of waiting for the whole run.' },
            timeoutMs: { type: 'number', description: 'Max block in ms (default 300000 = 5m, max 900000 = 15m). On timeout, returns timedOut:true; await again if still running.' },
          },
          required: ['runId'],
        },
        mutating: false,
      },
      handler: async (args, ctx) => {
        const runId = String(args.runId);
        const nodeId = typeof args.nodeId === 'string' && args.nodeId.trim() ? args.nodeId.trim() : undefined;
        const timeoutMs = clampNumber(args.timeoutMs, 300_000, 1_000, 900_000);
        const result = await waitForRunSettle(deps, ctx.workspaceId, runId, { ...(nodeId ? { nodeId } : {}), timeoutMs });
        if (result.resolved === 'not_found') return { found: false, runId, awaited: 'not_found' };
        const snapshot = runStatus(deps, ctx.workspaceId, runId);
        return {
          ...snapshot,
          awaited: result.resolved,
          ...(nodeId ? { nodeId } : {}),
          ...(result.nodeEvent ? { nodeEvent: result.nodeEvent } : {}),
          ...(result.resolved === 'timeout'
            ? { timedOut: true, note: 'Still running after the timeout — call agentis.run.await again to keep waiting (no tokens spent while blocked).' }
            : {}),
        };
      },
    },
    {
      definition: {
        id: 'agentis.run.await_all',
        family: 'run',
        mcpExposed: true,
        description:
          '[EFFICIENT FAN-IN WAIT] BLOCK until EVERY run in `runIds` settles (each COMPLETED / FAILED / CANCELLED, or PAUSED/WAITING), '
          + 'then return all their statuses in ONE call. This is the conjunction join for when you kicked off SEVERAL apps/workflows '
          + 'and want to wake ONCE, when the LAST finishes — instead of awaiting them one-by-one. Event-driven and zero-token while '
          + 'blocked (no polling, no per-run sleeping). Runs already settled count immediately; an unknown runId is treated as settled '
          + '(found:false) so a bad id never hangs the wait. Bounded by timeoutMs; on timeout returns timedOut:true with the still-pending '
          + 'ids — call again with those to keep waiting.',
        inputSchema: {
          type: 'object',
          properties: {
            runIds: { type: 'array', items: { type: 'string' }, description: 'The run ids to wait on (1–25). Wakes when ALL have settled.' },
            timeoutMs: { type: 'number', description: 'Max block in ms (default 300000 = 5m, max 900000 = 15m). On timeout, returns timedOut:true; await again if any remain.' },
          },
          required: ['runIds'],
        },
        mutating: false,
      },
      handler: async (args, ctx) => {
        const raw = Array.isArray(args.runIds) ? args.runIds : [];
        const runIds = [...new Set(
          raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim()),
        )].slice(0, 25);
        if (runIds.length === 0) {
          throw new AgentisError('VALIDATION_FAILED', 'runIds must be a non-empty array of run ids');
        }
        const timeoutMs = clampNumber(args.timeoutMs, 300_000, 1_000, 900_000);
        const result = await waitForAllRunsSettle(deps, ctx.workspaceId, runIds, { timeoutMs });
        const runs = runIds.map((runId) => {
          const s = result.settled.get(runId);
          if (!s || !s.found) return { runId, found: false, settled: Boolean(s) };
          return { ...runStatus(deps, ctx.workspaceId, runId), settled: true };
        });
        const pending = runIds.filter((runId) => !result.settled.has(runId));
        return {
          awaited: result.resolved,
          requested: runIds.length,
          settledCount: result.settled.size,
          runs,
          ...(result.resolved === 'timeout'
            ? {
                timedOut: true,
                pending,
                note: 'Some runs are still going after the timeout — call agentis.run.await_all again with the pending ids to keep waiting (no tokens spent while blocked).',
              }
            : {}),
        };
      },
    },
    {
      definition: {
        id: 'agentis.workflow.status',
        family: 'run',
        mcpExposed: true,
        description: 'Get run status, progress, active node, and failed-node summary.',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
        mutating: false,
      },
      handler: async (args, ctx) => runStatus(deps, ctx.workspaceId, String(args.runId)),
    },
    {
      definition: {
        id: 'agentis.workflow.list',
        family: 'inspect',
        mcpExposed: true,
        description: 'List recent workflow runs in the workspace.',
        inputSchema: {
          type: 'object',
          properties: { status: { type: 'string' }, limit: { type: 'number' } },
        },
        mutating: false,
      },
      handler: async (args, ctx) => listRuns(deps, ctx.workspaceId, {
        status: args.status ? String(args.status) : undefined,
        limit: clampNumber(args.limit, 20, 1, 50),
      }),
    },
    {
      definition: {
        id: 'agentis.run.query',
        family: 'inspect',
        mcpExposed: true,
        description: 'Query run history by workflow, status, date, and limit.',
        inputSchema: {
          type: 'object',
          properties: {
            workflowId: { type: 'string' },
            status: { type: 'string' },
            since: { type: 'string' },
            limit: { type: 'number' },
          },
        },
        mutating: false,
      },
      handler: async (args, ctx) => listRuns(deps, ctx.workspaceId, {
        workflowId: args.workflowId ? String(args.workflowId) : undefined,
        status: args.status ? String(args.status) : undefined,
        since: args.since ? String(args.since) : undefined,
        limit: clampNumber(args.limit, 20, 1, 100),
      }),
    },
    {
      definition: {
        id: 'agentis.run.diagnose',
        family: 'inspect',
        mcpExposed: true,
        description: '[PAVED ROAD 5/5 — OBSERVE] Diagnose a failed or stalled run: grounded root cause from real state + ledger, concrete fixes, and nextCalls (machine-actionable follow-ups with real ids). Always diagnose BEFORE patching.',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
        mutating: false,
      },
      handler: async (args, ctx) => {
        const runId = String(args.runId);
        const status = runStatus(deps, ctx.workspaceId, runId);
        if (!status.found) return status;
        const events = await deps.ledger.listForRun({ runId, limit: 50 });
        const failures = events.filter((event) => /failed|error/i.test(event.eventType) || JSON.stringify(event.payload).toLowerCase().includes('error'));
        // Grounded, rule-mapped diagnosis (real error → concrete fixes).
        const analysis = analyzeRunFailure(deps.db, ctx.workspaceId, runId);

        // Phase 5 (self-improving playbook) — when the cause is RECOGNIZED, append
        // the failure-mode → fix to the workspace playbook so future builds design
        // around it. Deduped on the lesson title; best-effort, never throws.
        let learned: { recorded: boolean; memoryId?: string } = { recorded: false };
        if (analysis?.recognized && analysis.error) {
          try {
            const failureMode = `${analysis.failedNodeTitle ?? analysis.nodeKind ?? 'node'} failed: ${analysis.error.replace(/\s+/g, ' ').trim().slice(0, 160)}`;
            const fix = analysis.fixes[0] ?? analysis.explanation;
            const exists = recallWorkflowLessons(deps.memory, ctx.workspaceId, 50)
              .some((lesson) => lesson.title.toLowerCase() === failureMode.slice(0, 120).toLowerCase());
            if (!exists && fix) {
              const memoryId = recordWorkflowLesson(deps.memory, ctx.workspaceId, { failureMode, fix }, ctx.agentId);
              if (memoryId) learned = { recorded: true, memoryId };
            }
          } catch {
            /* learning is best-effort — never fail a diagnosis over it */
          }
        }

        // PAVED-ROAD P1 — machine-actionable next calls with REAL ids, so the
        // agent's next step is a tool call, not an interpretation of prose.
        const wfId = 'workflowId' in status ? (status as { workflowId?: string | null }).workflowId : null;
        const nextCalls: CompassStep[] = [
          ...(analysis?.failedNodeId
            ? [{
                tool: 'agentis.run.replay',
                args: { sourceRunId: runId, mode: 'replay-with-edited-node', targetNodeId: analysis.failedNodeId, nodeConfigPatch: {} },
                why: 'Fix the failed node config and re-run FROM that node — no need to repeat the healthy upstream work.',
              }]
            : []),
          ...(wfId
            ? [
                {
                  tool: 'agentis.build_workflow',
                  args: { workflowId: wfId, description: 'apply the diagnosed fix', patchDraft: { updateNodes: [] } },
                  why: 'Patch the workflow itself (scoped patchDraft) when the cause is in the graph, then dry-run before re-running.',
                },
                {
                  tool: 'agentis.workflow.dry_run',
                  args: { workflowId: wfId },
                  why: 'Zero-cost re-proof of the whole data flow after any patch.',
                },
              ]
            : []),
        ];
        return {
          ...status,
          failureEvents: failures,
          ...(analysis ? { analysis } : {}),
          diagnosis: analysis?.recognized
            ? analysis.explanation
            : failures.length > 0
              ? `Found ${failures.length} failure-related ledger events. Start with the latest node/task error.`
              : 'No explicit failure events found in the recent ledger slice. Check active nodes and adapter health.',
          suggestedActions: analysis?.recognized && analysis.fixes.length > 0
            ? analysis.fixes
            : [
                'Inspect the failed node payload.',
                'Check the assigned agent or extension configuration.',
                'Patch timeout or routing settings before retrying if the cause is configuration-related.',
              ],
          ...(nextCalls.length > 0 ? { nextCalls } : {}),
          learned,
        };
      },
    },
    {
      definition: {
        id: 'agentis.run.replay',
        family: 'run',
        mcpExposed: true,
        description: 'Create a child run that replays from a chosen point.',
        inputSchema: {
          type: 'object',
          properties: {
            sourceRunId: { type: 'string' },
            mode: {
              type: 'string',
              enum: ['replay-from-node', 'replay-failed-branch', 'replay-with-edited-node', 'replay-from-checkpoint'],
            },
            targetNodeId: { type: 'string' },
            nodeConfigPatch: { type: 'object' },
          },
          required: ['sourceRunId', 'mode'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const prepared = deps.replay.prepare({
          workspaceId: ctx.workspaceId,
          sourceRunId: String(args.sourceRunId),
          mode: args.mode as 'replay-from-node' | 'replay-failed-branch' | 'replay-with-edited-node' | 'replay-from-checkpoint',
          targetNodeId: args.targetNodeId ? String(args.targetNodeId) : undefined,
          nodeConfigPatch: args.nodeConfigPatch as Record<string, unknown> | undefined,
          userId: ctx.userId,
        });
        // PERSIST THE CHILD RUN ROW BEFORE STARTING. `engine.startRun` only
        // UPDATES an existing row — every other caller (workflow.run, the
        // issues replay route) inserts first. Without this insert the replay
        // ran as a GHOST: run.status/run.inspect returned found:false, run
        // history never listed it, and every state persist updated zero rows.
        deps.db.insert(schema.workflowRuns).values({
          id: prepared.runId,
          workspaceId: prepared.workspaceId,
          ambientId: prepared.ambientId,
          workflowId: prepared.workflowId,
          userId: prepared.userId,
          status: 'CREATED',
          runState: prepared.initialState,
          triggerId: null,
          parentRunId: String(args.sourceRunId),
        }).run();
        const handle = await deps.engine.startRun({
          workspaceId: prepared.workspaceId,
          ambientId: prepared.ambientId,
          workflowId: prepared.workflowId,
          userId: prepared.userId,
          triggerId: null,
          inputs: prepared.inputs,
          initialState: prepared.initialState,
          graph: prepared.graph,
        });
        return {
          runId: handle.runId,
          parentRunId: String(args.sourceRunId),
          status: 'started',
          compass: compassForRun({ runId: handle.runId, workflowId: prepared.workflowId, status: 'started' }),
        };
      },
    },
    {
      definition: {
        id: 'agentis.memory.write',
        family: 'run',
        description:
          'Store a memory entry in persistent memory. Write only DURABLE, REUSABLE lessons — a rule, '
          + 'a root cause, a standing preference — never transient work product, run ids, or status notes (those are '
          + 'rejected). Give it a SPECIFIC, searchable title (that is how it is found later — cite memories by TITLE, '
          + 'never by id). Writing the same title again UPDATES the existing memory instead of duplicating it. '
          + 'SCOPE: omit agentId to write WORKSPACE-wide memory (every agent recalls it). Pass agentId to write into '
          + "ONE specialist's OWN mind — a durable behavioral rule/lesson that agent (and its future sessions) recalls "
          + 'automatically. Use agent-scoped writes when you CORRECT or constrain a specialist: persist the correction '
          + 'as a rule in its Brain (kind:"rule") so it is learned, not just pasted into its instructions. For '
          + 'App-scoped, gated learnings prefer agentis.data.promote_memory instead.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            content: { type: 'string' },
            kind: { type: 'string', description: 'fact | preference | pattern | rule | lesson. Use "rule" for a standing behavioral constraint.' },
            importance: { type: 'string' },
            tags: { type: 'string' },
            agentId: { type: 'string', description: "Target ONE specialist's own mind (agent-scoped). Omit for workspace-wide memory." },
          },
          required: ['title', 'content'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const title = String(args.title);
        const content = String(args.content);
        const kind = String(args.kind ?? 'fact');
        let scopeId = String(args.agentId ?? '');

        // A non-control-plane agent speaking through a channel may remember for
        // itself, but it may not write workspace constitution or alter another
        // agent's mind. If it omits agentId, safely narrow the write to itself;
        // an explicit cross-agent target is rejected. Orchestrators/managers keep
        // their existing supervisory behavior.
        if (ctx.channelOrigin && ctx.agentId) {
          const caller = deps.db.select({ role: schema.agents.role }).from(schema.agents).where(and(
            eq(schema.agents.workspaceId, ctx.workspaceId),
            eq(schema.agents.id, ctx.agentId),
          )).get();
          const controlPlane = caller?.role === 'orchestrator' || caller?.role === 'manager';
          if (!controlPlane) {
            if (scopeId && scopeId !== ctx.agentId) {
              throw new AgentisError('AUTH_FORBIDDEN', 'A bounded channel agent may write only to its own Brain.');
            }
            scopeId = ctx.agentId;
          }
        }

        let importanceVal = 0.5;
        if (args.importance !== undefined && args.importance !== null) {
          const num = Number(args.importance);
          if (Number.isFinite(num)) {
            importanceVal = num > 1 ? Math.min(num / 10, 1) : Math.max(0, num);
          }
        }

        let parsedTags: string[] = [];
        if (args.tags) {
          if (Array.isArray(args.tags)) {
            parsedTags = args.tags.map(String);
          } else if (typeof args.tags === 'string') {
            try {
              const parsed = JSON.parse(args.tags);
              parsedTags = Array.isArray(parsed) ? parsed.map(String) : [String(args.tags)];
            } catch {
              parsedTags = args.tags.split(',').map((t) => t.trim()).filter(Boolean);
            }
          }
        }

        // §B4 — write typed memory through the unified MemoryStore facade.
        if (!deps.memory) throw new Error('workspace memory service not available');

        // QUALITY GATE (deterministic): the Brain is for durable lessons, not a
        // scratch log. Reject junk with an instructive error so the agent's
        // retry is a better memory, not a duplicate of a bad one.
        const junk = memoryWriteRejection(title, content);
        if (junk) throw new AgentisError('VALIDATION_FAILED', junk);

        // DEDUP BY TITLE: memories are found by TITLE, so a same-titled write is
        // an update (freshness), never a second row the operator must diff.
        const normalized = normalizeMemoryTitle(title);
        const existing = deps.memory
          .list({ workspaceId: ctx.workspaceId, scopeId: scopeId || null, limit: 200 })
          .find((episode) => normalizeMemoryTitle(episode.title) === normalized);
        if (existing) {
          deps.memory.update(ctx.workspaceId, scopeId || null, existing.id, { content, importance: importanceVal, ...(parsedTags.length ? { tags: parsedTags } : {}) });
          return {
            id: existing.id,
            title: existing.title,
            kind: existing.kind,
            status: 'updated',
            deduplicated: true,
            message: `Updated the existing memory "${existing.title}" (same title). Cite it by its TITLE.`,
          };
        }

        const id = deps.memory.write({
          workspaceId: ctx.workspaceId,
          scopeId: scopeId || null,
          kind: kind as Parameters<NonNullable<typeof deps.memory>['write']>[0]['kind'],
          source: 'operator',
          title,
          content,
          trust: 0.7,
          importance: importanceVal,
          tags: parsedTags,
        });

        return {
          id,
          title,
          kind,
          importance: importanceVal,
          tags: parsedTags,
          status: 'created',
          message: `Saved memory "${title}". Cite it by its TITLE (searchable in the Brain), never by the raw id.`,
        };
      },
    },
    {
      definition: {
        id: 'agentis.memory.delete',
        family: 'run',
        description: 'Delete a memory entry from the workspace persistent memory.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            agentId: { type: 'string' },
          },
          required: ['id'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const id = String(args.id);
        const scopeId = args.agentId ? String(args.agentId) : null;
        // §B4 — delete through the unified MemoryStore facade (scoped, then global).
        if (!deps.memory) throw new Error('workspace memory service not available');
        const deleted = (scopeId !== null && deps.memory.delete(ctx.workspaceId, scopeId, id))
          || deps.memory.delete(ctx.workspaceId, null, id);
        if (!deleted) {
          throw new Error(`Memory entry ${id} not found in workspace`);
        }
        return { id, deleted: true };
      },
    },
    {
      definition: {
        id: 'agentis.knowledge.write',
        family: 'run',
        description: 'Index a document into the workspace knowledge base.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            content: { type: 'string' },
            url: { type: 'string' },
            tags: { type: 'string' },
            knowledgeBaseId: { type: 'string' },
            agentId: { type: 'string', description: 'Target specialist private knowledge scope.' },
          },
          required: ['title', 'content'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        if (!deps.knowledgeBases) {
          throw new Error('Knowledge base service not available');
        }

        const agentId = args.agentId ? String(args.agentId) : '';
        if (agentId) {
          const target = deps.db.select({ id: schema.agents.id }).from(schema.agents)
            .where(and(eq(schema.agents.id, agentId), eq(schema.agents.workspaceId, ctx.workspaceId))).get();
          if (!target) throw new AgentisError('RESOURCE_NOT_FOUND', `agent ${agentId} not found in this workspace`);
        }
        let kbId = args.knowledgeBaseId ? String(args.knowledgeBaseId) : '';
        if (!kbId) {
          const bases = deps.knowledgeBases.listKnowledgeBases(ctx.workspaceId, agentId ? { scopeId: agentId } : undefined);
          if (bases.length > 0) {
            kbId = bases[0]!.id;
          } else {
            const defaultKb = deps.knowledgeBases.createKnowledgeBase({
              workspaceId: ctx.workspaceId,
              ...(agentId ? { scopeId: agentId } : {}),
              name: agentId ? 'Private specialist knowledge' : 'Default Knowledge Base',
              description: agentId ? 'Private knowledge administered by the workspace orchestrator' : 'Automatically created for agent inputs',
            });
            kbId = defaultKb.id;
          }
        }

        const title = String(args.title);
        const content = String(args.content);

        const doc = await deps.knowledgeBases.addDocument({
          workspaceId: ctx.workspaceId,
          knowledgeBaseId: kbId,
          name: title,
          content,
        });

        return {
          id: doc.id,
          name: title,
          knowledgeBaseId: kbId,
          status: 'ready',
          chunks: doc.chunks,
          scope: agentId ? 'agent' : 'workspace',
          ...(agentId ? { agentId } : {}),
        };
      },
    },
    {
      definition: {
        id: 'agentis.knowledge.archive',
        family: 'run',
        description: 'Archive a document in the knowledge base by documentId and knowledgeBaseId.',
        inputSchema: {
          type: 'object',
          properties: {
            documentId: { type: 'string' },
            knowledgeBaseId: { type: 'string' },
          },
          required: ['documentId', 'knowledgeBaseId'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        if (!deps.knowledgeBases) {
          throw new Error('Knowledge base service not available');
        }
        const documentId = String(args.documentId);
        const knowledgeBaseId = String(args.knowledgeBaseId);
        const result = deps.knowledgeBases.archiveDocument(ctx.workspaceId, knowledgeBaseId, documentId);
        return result;
      },
    },
    {
      definition: {
        id: 'agentis.knowledge.delete',
        family: 'run',
        description: 'Permanently delete one or more documents and all of their indexed chunks from a knowledge base. This is irreversible; use archive when recoverability is desired.',
        inputSchema: {
          type: 'object',
          properties: {
            documentIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 500 },
            knowledgeBaseId: { type: 'string' },
          },
          required: ['documentIds', 'knowledgeBaseId'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        if (!deps.knowledgeBases) throw new Error('Knowledge base service not available');
        const knowledgeBaseId = String(args.knowledgeBaseId);
        const documentIds = Array.isArray(args.documentIds)
          ? [...new Set(args.documentIds.map(String).filter(Boolean))]
          : [];
        if (documentIds.length === 0) throw new AgentisError('VALIDATION_FAILED', 'documentIds must contain at least one id');
        const deleted = documentIds.map((documentId) =>
          deps.knowledgeBases!.deleteDocument(ctx.workspaceId, knowledgeBaseId, documentId));
        return { knowledgeBaseId, deleted, count: deleted.length };
      },
    },
    {
      definition: {
        id: 'agentis.knowledge_base.delete',
        family: 'run',
        description: 'Permanently delete an entire knowledge base, including every document and indexed chunk in it. This is irreversible.',
        inputSchema: {
          type: 'object',
          properties: { knowledgeBaseId: { type: 'string' } },
          required: ['knowledgeBaseId'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        if (!deps.knowledgeBases) throw new Error('Knowledge base service not available');
        return deps.knowledgeBases.deleteKnowledgeBase(ctx.workspaceId, String(args.knowledgeBaseId));
      },
    },
  ]);
}

/** Case/whitespace-insensitive title key for memory dedup. */
function normalizeMemoryTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Deterministic Brain write-policy: reject entries that cannot possibly be a
 * durable, findable lesson. Returns the instructive rejection message, or null
 * when the write is acceptable. (The Brain is recalled by TITLE + semantics —
 * a one-word title or an id-dump is unfindable noise.)
 */
function memoryWriteRejection(title: string, content: string): string | null {
  const t = title.trim();
  const c = content.trim();
  if (t.length < 8 || t.split(/\s+/).length < 2) {
    return 'Memory rejected: the title must be a specific, searchable phrase (≥ 2 words) — it is how this memory is found later. Example: "Replay runs need a persisted parent row" not "replay bug".';
  }
  if (c.length < 30) {
    return 'Memory rejected: the content is too thin to be a durable lesson. State WHEN it applies and WHAT to do (≥ 30 chars).';
  }
  // An entry that is mostly ids is transient work product, not a lesson.
  const uuids = c.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
  const withoutIds = c.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '').trim();
  if (uuids.length > 0 && withoutIds.length < 40) {
    return 'Memory rejected: this is mostly run/entity ids — transient work product, not a durable lesson. Record the LESSON (when → do), not the ids; ids live in run history already.';
  }
  return null;
}

function parseInputs(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : { input: parsed };
    } catch {
      return { input: trimmed };
    }
  }
  return { input: value };
}

/**
 * Return the latest terminal execution of this exact graph when it has a
 * concrete failed/deficient producer frontier. We intentionally do not scan
 * past the latest same-graph terminal run: a newer accomplished execution
 * supersedes an older failure and must not resurrect it.
 */
function latestSameGraphReplayCandidate(
  deps: Pick<ToolHandlerDeps, 'db'>,
  workspaceId: string,
  workflowId: string,
  graph: WorkflowGraph,
) {
  const currentHash = graphContentHash(graph);
  const rows = deps.db
    .select()
    .from(schema.workflowRuns)
    .where(and(
      eq(schema.workflowRuns.workspaceId, workspaceId),
      eq(schema.workflowRuns.workflowId, workflowId),
    ))
    .orderBy(desc(schema.workflowRuns.createdAt))
    .limit(50)
    .all();

  for (const row of rows) {
    if (!['FAILED', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'COMPLETED_WITH_CONTRACT_VIOLATION'].includes(row.status)) {
      continue;
    }
    const state = row.runState as WorkflowRunState & { verdict?: { graphHash?: unknown } };
    const snapshot = row.graphSnapshot as WorkflowGraph | null;
    let sourceHash: string | null = null;
    if (snapshot?.nodes && snapshot?.edges) {
      try {
        sourceHash = graphContentHash(snapshot);
      } catch {
        sourceHash = null;
      }
    }
    if (!sourceHash && typeof state.verdict?.graphHash === 'string') sourceHash = state.verdict.graphHash;
    if (sourceHash !== currentHash) continue;

    return collectReplayFrontierNodeIds(state, graph).size > 0 ? row : null;
  }
  return null;
}

function latestSameGraphActiveRun(
  deps: Pick<ToolHandlerDeps, 'db'>,
  workspaceId: string,
  workflowId: string,
  graph: WorkflowGraph,
) {
  const currentHash = graphContentHash(graph);
  const rows = deps.db
    .select()
    .from(schema.workflowRuns)
    .where(and(eq(schema.workflowRuns.workspaceId, workspaceId), eq(schema.workflowRuns.workflowId, workflowId)))
    .orderBy(desc(schema.workflowRuns.createdAt))
    .limit(25)
    .all();
  return rows.find((row) => {
    if (!['CREATED', 'PLANNING', 'RUNNING', 'WAITING', 'PAUSED'].includes(row.status)) return false;
    const snapshot = row.graphSnapshot as WorkflowGraph | null;
    if (!snapshot?.nodes || !snapshot?.edges) return false;
    try {
      return graphContentHash(snapshot) === currentHash;
    } catch {
      return false;
    }
  }) ?? null;
}

// The run-settle waits (event-driven, zero-token) now live in ../run/runSettle.js
// so the engine's in-session `await_runs` yield can share them without importing
// the tool layer. Re-exported so existing importers of run.js (incl. tests) resolve.
export { waitForRunSettle, waitForAllRunsSettle };

function runStatus(deps: ToolHandlerDeps, workspaceId: string, runId: string) {
  const run = deps.db
    .select()
    .from(schema.workflowRuns)
    .where(and(eq(schema.workflowRuns.id, runId), eq(schema.workflowRuns.workspaceId, workspaceId)))
    .get();
  if (!run) return { found: false, runId };
  const state = run.runState as WorkflowRunState;
  const workflow = run.workflowId
    ? deps.db.select().from(schema.workflows).where(eq(schema.workflows.id, run.workflowId)).get()
    : null;
  const graph = (workflow?.graph ?? run.graphSnapshot ?? undefined) as WorkflowGraph | undefined;
  const total = Math.max(Object.keys(state.nodeStates ?? {}).length, graph?.nodes.length ?? 0, 1);
  const completed = state.completedNodeIds?.length ?? 0;
  const failed = failedNodeCount(state);
  const failedNodeIds = collectFailedNodeIds(state);
  const activeNodeId = Object.keys(state.activeExecutions ?? {})[0] ?? state.readyQueue?.[0]?.nodeId ?? null;
  const activeNode = activeNodeId ? graph?.nodes.find((node) => node.id === activeNodeId) : null;
  // Distinguish EXECUTING (an active execution with a start time) from QUEUED
  // (still in readyQueue): an agent node legitimately executes for minutes, and
  // conflating the two is how an observer misreads a healthy run as a stalled
  // dispatcher and cancels it.
  const activeExec = activeNodeId ? (state.activeExecutions ?? {})[activeNodeId] : undefined;
  const startedMs = activeExec?.startedAt ? Date.parse(activeExec.startedAt) : NaN;
  // Was this a debug run? The engine stamps `settings.buildLoop.debugRun` with
  // the runId at the terminal transition, so the compass can distinguish
  // "debug passed → run production" from "production completed".
  const wasDebugRun = workflow ? readBuildLoop(workflow.settings).debugRun?.runId === run.id : false;
  // SWIFT layer 3 — the ANSWER, hoisted so it HEADLINES the result. A weak agent
  // reads the top of the payload and stops; if that top says COMPLETED, it
  // declares victory over an empty world. So a terminal run leads with
  // `accomplished` + `outcome`, not just the mechanical status.
  const verdict = (state as unknown as { verdict?: { outcome: 'accomplished' | 'partial' | 'hollow' | 'failed_checks'; checks?: unknown[]; deficiencies?: Array<{ claim: string; detail: string }> } }).verdict;
  const isTerminal = ['COMPLETED', 'COMPLETED_WITH_CONTRACT_VIOLATION', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED'].includes(run.status);
  const accomplished = verdict ? verdict.outcome === 'accomplished' : undefined;
  return {
    found: true,
    runId: run.id,
    workflowId: run.workflowId,
    workflowTitle: workflow?.title ?? run.ephemeralTitle ?? null,
    isEphemeral: run.isEphemeral,
    status: run.status,
    executionStatus: run.executionStatus,
    outcomeStatus: normalizeRunOutcomeStatus(run.outcomeStatus),
    settlement: run.settlement,
    // The honest headline. `accomplished:false` on a COMPLETED run is the whole
    // point of SWIFT — do NOT report success to the operator on that basis.
    ...(verdict ? { accomplished, outcome: verdict.outcome } : {}),
    ...(isTerminal && verdict && !accomplished
      ? { headline: `NOT ACCOMPLISHED (${verdict.outcome}) — the run finished but the world-check failed. Do not report success. ${(verdict.deficiencies ?? []).slice(0, 3).map((d) => d.detail || d.claim).join(' | ')}`.slice(0, 400) }
      : isTerminal && accomplished ? { headline: 'ACCOMPLISHED — verified against the world.' }
        : isTerminal && !verdict ? { headline: `${run.status} — but UNVERIFIED (no acceptance spec ran). Completion is not proof; scope it (agentis.workflow.scope) to verify the outcome.` }
          : {}),
    progress: Math.min(1, (completed + failed) / total),
    currentNode: activeNode
      ? {
          id: activeNode.id,
          title: activeNode.title,
          type: activeNode.type,
          // executing = dispatched with a live execution; queued = still in
          // readyQueue awaiting a dispatch slot. Agent/subflow/swarm nodes
          // legitimately EXECUTE for minutes — judge by inFlightMs, not vibes.
          phase: activeExec ? ('executing' as const) : ('queued' as const),
          ...(activeExec?.startedAt ? { startedAt: activeExec.startedAt } : {}),
          ...(Number.isFinite(startedMs) ? { inFlightMs: Math.max(0, Date.now() - startedMs) } : {}),
        }
      : null,
    completedNodeCount: completed,
    failedNodeCount: failed,
    failedNodes: failedNodeIds.map((nodeId) => ({
      nodeId,
      title: graph?.nodes.find((node) => node.id === nodeId)?.title ?? nodeId,
      error: state.nodeStates[nodeId]?.error ?? null,
    })),
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    // The full verdict object (checks + evidence + deficiencies) for an agent
    // that wants the detail behind the headline.
    ...(verdict ? { verdict } : {}),
    ...(run.workflowId
      ? {
          compass: compassForRun({
            runId: run.id,
            workflowId: run.workflowId,
            status: run.status,
            debugRun: wasDebugRun,
            ...(verdict ? { verdict: verdict.outcome } : {}),
          }),
        }
      : {}),
  };
}

function listRuns(
  deps: ToolHandlerDeps,
  workspaceId: string,
  opts: { workflowId?: string; status?: string; since?: string; limit: number },
) {
  const rows = deps.db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.workspaceId, workspaceId))
    .orderBy(desc(schema.workflowRuns.createdAt))
    .limit(Math.max(opts.limit * 3, opts.limit))
    .all()
    .filter((run) => {
      if (opts.workflowId && run.workflowId !== opts.workflowId) return false;
      if (opts.status && normalizeStatus(run.status) !== normalizeStatus(opts.status)) return false;
      if (opts.since && run.createdAt < opts.since) return false;
      return true;
    })
    .slice(0, opts.limit);
  const workflows = new Map(
    deps.db.select().from(schema.workflows).where(eq(schema.workflows.workspaceId, workspaceId)).all()
      .map((workflow) => [workflow.id, workflow]),
  );
  return {
    count: rows.length,
    runs: rows.map((run) => ({
      id: run.id,
      workflowId: run.workflowId,
      workflowTitle: run.workflowId ? workflows.get(run.workflowId)?.title ?? null : run.ephemeralTitle ?? null,
      isEphemeral: run.isEphemeral,
      status: run.status,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    })),
  };
}

function normalizeStatus(status: string): string {
  const upper = status.toUpperCase();
  if (upper === 'PENDING') return 'CREATED';
  if (upper === 'COMPLETED_WITH_ERRORS') return 'FAILED';
  return upper;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}
