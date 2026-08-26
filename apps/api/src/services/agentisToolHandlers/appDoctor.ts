/** Read-only agent tool for cross-layer App conformance inspection. */

import { AgentisError, appWorkflowBindingSchema } from '@agentis/core';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { collectAppDoctorSnapshot } from '../app/appDoctorSnapshot.js';
import { validateAppConformance } from '../app/appDoctor.js';
import { migrateWorkspaceAppConformance, repairAppConformance } from '../app/appDoctorRepair.js';
import { compileAppReadiness, type AppCompileTarget } from '../app/appCompiler.js';
import { migrateWorkspaceAppReliability } from '../app/appReliabilityMigration.js';

export function registerAppDoctorTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  const resolveAppId = (args: Record<string, unknown>, ctx: { viewport?: { resourceKind?: string; resourceId?: string } | null; appId?: string | null }): string => {
    const explicit = typeof args.appId === 'string' ? args.appId.trim() : '';
    return explicit || (ctx.viewport?.resourceKind === 'app' ? ctx.viewport.resourceId : '') || ctx.appId || '';
  };
  registry.registerMany([
    {
      definition: {
        id: 'agentis.app.compile',
        family: 'inspect',
        description:
          '[APP PRE-EXECUTION GATE] Compile an entire App into a deterministic readiness verdict BEFORE any costly or external run. '
          + 'Domain-neutral: validates strict workflow topology, executable activation/rules, definitions of done, current-graph dry-runs and test suites, runtime credentials/capabilities, channel resolution, closed-loop conversation enrollment/reachability, and surface operability. Separates structuralReady from executableReady. '
          + 'target:"debug" proves the zero-cost prerequisites for the first real debug run; "production" additionally reports current-graph accomplished debug evidence; "unattended" additionally reports hardening. Missing evidence keeps target readiness incomplete but never blocks the intentional manual run that creates it. '
          + 'Read-only. Defaults to compact blocker output. Apply compatible repairPlan.zeroCost steps as one batch, then compile once; never repair one blocker per model round.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'App id. Omit when an App is currently open.' },
            target: { type: 'string', enum: ['debug', 'production', 'unattended'], description: 'Proof level. Default: debug.' },
            detail: { type: 'string', enum: ['summary', 'full'], description: 'Default summary returns blockers/warnings only. full includes every passing check.' },
          },
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        const appId = resolveAppId(args, ctx);
        if (!appId) throw new AgentisError('VALIDATION_FAILED', 'appId is required (or open the App first)');
        const target = typeof args.target === 'string' && ['debug', 'production', 'unattended'].includes(args.target)
          ? args.target as AppCompileTarget
          : 'debug';
        const report = compileAppReadiness(deps.db, ctx.workspaceId, appId, target);
        if (args.detail === 'full') return report;
        return {
          ...report,
          checks: report.checks.filter((check) => check.status === 'block' || check.status === 'warn'),
          compact: true,
          omittedPassingChecks: report.counts.pass,
        };
      },
    },
    {
      definition: {
        id: 'agentis.app.verify',
        family: 'build',
        description: 'Run the free current-graph dry-run and pinned suite for every enabled workflow in an App as ONE batched tool call, then compile once. Use instead of calling workflow.dry_run/test repeatedly per workflow. Makes no external calls.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'App id. Omit when an App is currently open.' },
            target: { type: 'string', enum: ['debug', 'production', 'unattended'], description: 'Compile target after verification. Default debug.' },
            dryRun: { type: 'boolean', description: 'Default true.' },
            suites: { type: 'boolean', description: 'Default true.' },
          },
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const appId = resolveAppId(args, ctx);
        if (!appId) throw new AgentisError('VALIDATION_FAILED', 'appId is required (or open the App first)');
        const rows = deps.db.select({ id: schema.workflows.id, title: schema.workflows.title, settings: schema.workflows.settings })
          .from(schema.workflows)
          .where(and(eq(schema.workflows.workspaceId, ctx.workspaceId), eq(schema.workflows.appId, appId))).all()
          .filter((workflow) => {
            const settings = workflow.settings && typeof workflow.settings === 'object' ? workflow.settings as Record<string, unknown> : {};
            const binding = appWorkflowBindingSchema.safeParse(settings.appBinding ?? {});
            return !binding.success || binding.data.enabled !== false;
          });
        const runDry = args.dryRun !== false;
        const runSuites = args.suites !== false;
        const results = await Promise.all(rows.map(async (workflow) => {
          const dry = runDry ? await registry.execute({ id: '', toolId: 'agentis.workflow.dry_run', arguments: { workflowId: workflow.id } }, ctx) : null;
          const suite = runSuites ? await registry.execute({ id: '', toolId: 'agentis.workflow.test', arguments: { workflowId: workflow.id, action: 'run' } }, ctx) : null;
          return {
            workflowId: workflow.id,
            title: workflow.title,
            dryRun: dry ? compactNestedResult(dry) : null,
            suite: suite ? compactNestedResult(suite) : null,
          };
        }));
        const target = typeof args.target === 'string' && ['debug', 'production', 'unattended'].includes(args.target)
          ? args.target as AppCompileTarget
          : 'debug';
        let compile = compileAppReadiness(deps.db, ctx.workspaceId, appId, target);
        const activeBuild = deps.buildSessions?.latestForApp(ctx.workspaceId, appId) ?? null;
        let deterministicRepair: ReturnType<typeof repairAppConformance> | null = null;
        if (!compile.readyForExecution && activeBuild && activeBuild.status !== 'completed' && activeBuild.repairAttempts < 1) {
          deterministicRepair = repairAppConformance(deps.db, ctx.workspaceId, appId, { dryRun: false });
          compile = compileAppReadiness(deps.db, ctx.workspaceId, appId, target);
        }
        const buildSession = deps.buildSessions?.settleAppVerification({
          workspaceId: ctx.workspaceId,
          appId,
          passed: compile.readyForExecution,
          summary: compile.readyForExecution
            ? `App verification passed for ${target}.`
            : `App verification is blocked by ${compile.executionBlockerCount} execution issue(s) and ${compile.evidencePendingCount} pending evidence gate(s).`,
          payload: {
            target,
            structuralReady: compile.structuralReady,
            executableReady: compile.executableReady,
            readyForExecution: compile.readyForExecution,
            executionBlockerCount: compile.executionBlockerCount,
            evidencePendingCount: compile.evidencePendingCount,
            checks: compile.checks.map((check) => ({ id: check.id, status: check.status, summary: check.summary })),
            deterministicRepair: deterministicRepair ? {
              applied: deterministicRepair.applied,
              skipped: deterministicRepair.skipped,
              before: deterministicRepair.before,
              after: deterministicRepair.after,
            } : null,
          },
          repairAttempted: deterministicRepair !== null,
          complete: target !== 'debug',
        }) ?? null;
        return {
          appId,
          buildSession: compactBuildSession(buildSession),
          verifiedWorkflows: results.length,
          results,
          deterministicRepair: deterministicRepair ? {
            attempted: true,
            applied: deterministicRepair.applied,
            skipped: deterministicRepair.skipped,
            before: deterministicRepair.before,
            after: deterministicRepair.after,
          } : { attempted: false },
          compile: {
            target,
            structuralReady: compile.structuralReady,
            executableReady: compile.executableReady,
            readyForExecution: compile.readyForExecution,
            executionBlockerCount: compile.executionBlockerCount,
            evidencePendingCount: compile.evidencePendingCount,
            counts: compile.counts,
            blockers: compile.checks.filter((check) => check.status === 'block' && check.blocksExecution !== false).map((check) => ({ id: check.id, summary: check.summary })),
            evidencePending: compile.checks.filter((check) => check.status === 'block' && check.blocksExecution === false).map((check) => ({ id: check.id, summary: check.summary })),
            repairPlan: compile.repairPlan,
          },
          summary: `Verified ${results.length} workflow(s) in one zero-external-call batch; compile has ${compile.executionBlockerCount} execution blocker(s) and ${compile.evidencePendingCount} pending evidence gate(s).`,
        };
      },
    },
    {
      definition: {
        id: 'agentis.app.deliver',
        family: 'build',
        description:
          '[APP-WIDE DELIVERY] Resume or create one persisted App build session, run the batched zero-cost preflight, '
          + 'deliver every enabled workflow through real debug/world verification with bounded repair, compile production readiness, '
          + 'and complete the session only when every layer agrees. This reports whole-App readiness; it does not block an independently proven workflow from being published.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'Existing App id. Omit only when intent should create an App-of-one.' },
            intent: { type: 'string', description: 'Objective used when creating an App-of-one or documenting a resumed delivery.' },
            acceptance: { type: 'array', items: { type: 'string' }, description: 'App-level acceptance statements recorded on a new delivery session.' },
            inputs: { type: 'object', description: 'Sample inputs passed to each live workflow proof.' },
            maxRepairAttempts: { type: 'number', description: 'Bounded repair attempts per workflow; default 3, max 5.' },
            maxWallMs: { type: 'number', description: 'Total live delivery wall budget; default 900000ms.' },
          },
          anyOf: [{ required: ['appId'] }, { required: ['intent'] }],
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        let appId = resolveAppId(args, ctx);
        const intent = typeof args.intent === 'string' && args.intent.trim() ? args.intent.trim() : 'Deliver the existing App end to end.';
        const inputs = args.inputs && typeof args.inputs === 'object' && !Array.isArray(args.inputs)
          ? args.inputs as Record<string, unknown>
          : {};
        const maxIterations = typeof args.maxRepairAttempts === 'number'
          ? Math.min(Math.max(Math.trunc(args.maxRepairAttempts), 1), 5)
          : 3;
        const maxWallMs = typeof args.maxWallMs === 'number'
          ? Math.min(Math.max(Math.trunc(args.maxWallMs), 60_000), 1_200_000)
          : 900_000;
        const deliveries: Array<Record<string, unknown>> = [];

        if (!appId) {
          const created = await registry.execute({
            id: '',
            toolId: 'agentis.workflow.deliver',
            arguments: { goal: intent, inputs, maxIterations, maxWallMs },
          }, ctx);
          if (!created.ok) {
            return { ready: false, stage: 'materializing', blocker: { code: created.errorCode, message: created.errorMessage }, deliveries };
          }
          const output = created.output && typeof created.output === 'object' ? created.output as Record<string, unknown> : {};
          appId = typeof output.appId === 'string' ? output.appId : '';
          deliveries.push(compactDeliveryOutcome(output));
          if (!appId) return { ready: false, stage: 'materializing', blocker: { code: 'APP_ID_MISSING', message: 'Workflow delivery did not return an owning App id.' }, deliveries };
        }

        const workflows = deps.db.select({ id: schema.workflows.id, title: schema.workflows.title, settings: schema.workflows.settings })
          .from(schema.workflows)
          .where(and(eq(schema.workflows.workspaceId, ctx.workspaceId), eq(schema.workflows.appId, appId))).all()
          .filter((workflow) => {
            const settings = workflow.settings && typeof workflow.settings === 'object' ? workflow.settings as Record<string, unknown> : {};
            const binding = appWorkflowBindingSchema.safeParse(settings.appBinding ?? {});
            return !binding.success || binding.data.enabled !== false;
          });
        if (workflows.length === 0) throw new AgentisError('VALIDATION_FAILED', `App ${appId} has no enabled workflows to deliver.`);

        const latestBuild = deps.buildSessions?.latestForApp(ctx.workspaceId, appId) ?? null;
        if (deps.buildSessions && (!latestBuild || latestBuild.status === 'completed')) {
          const app = deps.db.select({ name: schema.apps.name }).from(schema.apps)
            .where(and(eq(schema.apps.workspaceId, ctx.workspaceId), eq(schema.apps.id, appId))).get();
          const acceptance = Array.isArray(args.acceptance)
            ? args.acceptance.map(String).map((value) => value.trim()).filter(Boolean)
            : [`Every enabled workflow in ${app?.name ?? appId} is world-verified and production-compilable.`];
          const created = deps.buildSessions.create({
            workspaceId: ctx.workspaceId,
            userId: ctx.userId,
            ownerAgentId: ctx.agentId ?? null,
            conversationId: ctx.conversationId ?? null,
            appId,
            name: app?.name ?? `App ${appId}`,
            intent,
            topology: {
              roles: [],
              swarms: [],
              workflows: workflows.map((workflow) => ({
                key: workflow.id,
                title: workflow.title,
                purpose: `Deliver ${workflow.title}`,
                dependsOn: [],
                activation: 'operator' as const,
                inputs: [],
                outputs: [],
                acceptanceCriteria: [`${workflow.title} is accomplished against authoritative evidence.`],
              })),
              collections: [],
              interfaces: [],
            },
            acceptanceCriteria: acceptance.length > 0 ? acceptance : ['The App is world-verified and production-compilable.'],
            capabilityCatalogHash: registry.catalog().hash,
          });
          deps.buildSessions.bindApp(ctx.workspaceId, created.session.id, appId);
        }

        const preflightCall = await registry.execute({
          id: '',
          toolId: 'agentis.app.verify',
          arguments: { appId, target: 'debug', dryRun: true, suites: true },
        }, ctx);
        const preflight = preflightCall.ok && preflightCall.output && typeof preflightCall.output === 'object'
          ? preflightCall.output as Record<string, unknown>
          : { ok: false, error: preflightCall.errorMessage };
        const preflightCompile = preflight.compile && typeof preflight.compile === 'object'
          ? preflight.compile as Record<string, unknown>
          : {};
        if (preflightCall.ok === false || preflightCompile.readyForExecution !== true) {
          return {
            appId,
            buildSession: compactBuildSession(deps.buildSessions?.latestForApp(ctx.workspaceId, appId) ?? null),
            ready: false,
            stage: 'statically_valid',
            preflight,
            deliveries,
            blocker: { code: 'APP_PREFLIGHT_BLOCKED', message: 'Zero-cost App preflight has unresolved execution blockers.' },
          };
        }

        const liveBudgetPerWorkflow = Math.max(60_000, Math.trunc(maxWallMs / workflows.length));
        for (const workflow of workflows) {
          if (deliveries.some((delivery) => delivery.workflowId === workflow.id && delivery.outcome === 'accomplished' && delivery.delivered === true && delivery.published === true)) continue;
          const nested = await registry.execute({
            id: '',
            toolId: 'agentis.workflow.deliver',
            arguments: { workflowId: workflow.id, inputs, maxIterations, maxWallMs: liveBudgetPerWorkflow },
          }, ctx);
          const output = nested.ok && nested.output && typeof nested.output === 'object'
            ? nested.output as Record<string, unknown>
            : { workflowId: workflow.id, outcome: 'failed', error: nested.errorMessage, code: nested.errorCode };
          deliveries.push(compactDeliveryOutcome(output));
          if (output.outcome !== 'accomplished') break;
        }

        const compile = compileAppReadiness(deps.db, ctx.workspaceId, appId, 'production');
        const allAccomplished = workflows.every((workflow) => deliveries.some((delivery) => (
          delivery.workflowId === workflow.id
          && delivery.outcome === 'accomplished'
          && delivery.delivered === true
          && delivery.published === true
        )));
        const ready = allAccomplished && compile.ready;
        const buildSession = deps.buildSessions?.settleAppVerification({
          workspaceId: ctx.workspaceId,
          appId,
          passed: ready,
          complete: ready,
          summary: ready
            ? 'Every enabled workflow is world-verified and the App compiles for production.'
            : 'App delivery stopped because live accomplishment or production compilation is incomplete.',
          payload: {
            allAccomplished,
            compile: { ready: compile.ready, counts: compile.counts, blockers: compile.checks.filter((check) => check.status === 'block').map((check) => ({ id: check.id, summary: check.summary })) },
            deliveries: deliveries.map((delivery) => ({ workflowId: delivery.workflowId, runId: delivery.runId, outcome: delivery.outcome })),
          },
        }) ?? null;
        return {
          appId,
          buildSession: compactBuildSession(buildSession),
          ready,
          stage: ready ? 'ready' : 'live_proof_blocked',
          preflight,
          deliveries,
          compile: {
            target: 'production',
            ready: compile.ready,
            structuralReady: compile.structuralReady,
            executableReady: compile.executableReady,
            counts: compile.counts,
            blockers: compile.checks.filter((check) => check.status === 'block').map((check) => ({ id: check.id, summary: check.summary, blocksExecution: check.blocksExecution !== false })),
          },
          ...(!ready ? { blocker: { code: 'APP_DELIVERY_NOT_READY', message: 'The App remains non-ready; inspect the returned workflow outcomes and compile blockers.' } } : {}),
        };
      },
    },
    {
      definition: {
        id: 'agentis.app.doctor',
        family: 'inspect',
        description: 'Inspect an App as one executable system. Checks workflow dependencies, triggers and subscriptions, outcome contracts, connection/App bindings, conversation state references, and whether orchestration shown in the UI is backed by persisted rules. Read-only: returns structured findings and remediation operations; never claims to repair them.',
        inputSchema: {
          type: 'object',
          properties: { appId: { type: 'string', description: 'App id. Omit when an App is currently open.' } },
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        const appId = resolveAppId(args, ctx);
        if (!appId) throw new AgentisError('VALIDATION_FAILED', 'appId is required (or open the App first)');
        return validateAppConformance(collectAppDoctorSnapshot(deps.db, ctx.workspaceId, appId));
      },
    },
    {
      definition: {
        id: 'agentis.app.doctor.repair',
        family: 'build',
        description: 'Preview or apply deterministic App Doctor repairs. Only intent-preserving repairs are automated; findings requiring workflow, credential, channel, or UI choices remain explicit review_required items. Omit confirm:true for preview.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string' },
            findingIds: { type: 'array', items: { type: 'string' } },
            confirm: { type: 'boolean' },
          },
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        const appId = resolveAppId(args, ctx);
        if (!appId) throw new AgentisError('VALIDATION_FAILED', 'appId is required (or open the App first)');
        return repairAppConformance(deps.db, ctx.workspaceId, appId, {
          dryRun: args.confirm !== true,
          findingIds: Array.isArray(args.findingIds) ? args.findingIds.map(String) : undefined,
        });
      },
    },
    {
      definition: {
        id: 'agentis.apps.reliability.migrate',
        family: 'build',
        description:
          '[FLEET RELIABILITY GATE] Audit every existing App and optionally apply all intent-preserving reliability migrations: '
          + 'invalidate historic false clean proofs, reconcile only clean accomplished legacy revisions, normalize legacy datastore mutations, '
          + 'generate non-gating mechanical test batteries, and run deterministic App conformance repairs. Missing output contracts, worldly proofs, '
          + 'datastore probes, and extension schemas remain explicit review items for agentis.app.deliver. Omit confirm:true for a read-only preview.',
        inputSchema: {
          type: 'object',
          properties: { appId: { type: 'string' }, confirm: { type: 'boolean' } },
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        if (!deps.revisions) throw new AgentisError('WORKFLOW_DRAFT_INVALID', 'Immutable workflow revision service is unavailable.');
        return migrateWorkspaceAppReliability(deps.db, deps.revisions, ctx.workspaceId, {
          dryRun: args.confirm !== true,
          appId: typeof args.appId === 'string' && args.appId.trim() ? args.appId.trim() : undefined,
        });
      },
    },
    {
      definition: {
        id: 'agentis.apps.conformance.migrate',
        family: 'build',
        description: 'Audit every existing App in the workspace against current orchestration contracts and preview/apply only deterministic safe migrations. Returns remaining blockers honestly; never invents missing business rules. Omit confirm:true for preview.',
        inputSchema: {
          type: 'object',
          properties: { appId: { type: 'string' }, confirm: { type: 'boolean' } },
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: (args, ctx) => migrateWorkspaceAppConformance(deps.db, ctx.workspaceId, {
        dryRun: args.confirm !== true,
        appId: typeof args.appId === 'string' && args.appId.trim() ? args.appId.trim() : undefined,
      }),
    },
  ]);
}

function compactNestedResult(result: Awaited<ReturnType<AgentisToolRegistry['execute']>>): Record<string, unknown> {
  if (!result.ok) return { ok: false, code: result.errorCode, error: result.errorMessage };
  const output = result.output && typeof result.output === 'object' ? result.output as Record<string, unknown> : {};
  const issues = Array.isArray(output.issues) ? output.issues.slice(0, 20) : [];
  const failedAssertions = Array.isArray(output.assertions)
    ? output.assertions.filter((assertion) => assertion && typeof assertion === 'object' && (assertion as Record<string, unknown>).passed === false).slice(0, 20)
    : [];
  const failedTrace = Array.isArray(output.trace)
    ? output.trace.filter((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).status === 'failed').slice(0, 20)
    : [];
  const failedCases = Array.isArray(output.results)
    ? output.results.filter((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).passed === false).slice(0, 20)
    : [];
  return {
    ok: output.ok !== false,
    ...(typeof output.status === 'string' ? { status: output.status } : {}),
    ...(typeof output.total === 'number' ? { total: output.total } : {}),
    ...(typeof output.gating === 'number' ? { gating: output.gating } : {}),
    ...(typeof output.passed === 'number' ? { passed: output.passed } : {}),
    ...(typeof output.summary === 'string' ? { summary: output.summary } : {}),
    ...(issues.length > 0 ? { issues } : {}),
    ...(failedAssertions.length > 0 ? { failedAssertions } : {}),
    ...(failedTrace.length > 0 ? { failedTrace } : {}),
    ...(failedCases.length > 0 ? { failedCases } : {}),
  };
}

function compactBuildSession(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const session = value as Record<string, unknown>;
  return {
    id: session.id,
    status: session.status,
    stage: session.stage,
    repairAttempts: session.repairAttempts,
    diagnostic: session.diagnostic,
    completedAt: session.completedAt,
    updatedAt: session.updatedAt,
  };
}

function compactDeliveryOutcome(output: Record<string, unknown>): Record<string, unknown> {
  return {
    workflowId: output.workflowId,
    appId: output.appId,
    runId: output.runId,
    delivered: output.delivered,
    published: output.published,
    outcome: output.outcome,
    executionStatus: output.executionStatus,
    candidateRevisionId: output.candidateRevisionId,
    activeRevisionId: output.activeRevisionId,
    blocker: output.blocker,
    deficiencies: output.deficiencies,
    summary: output.summary,
  };
}
