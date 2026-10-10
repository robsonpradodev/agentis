import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { AgentisError, CONSTANTS, REALTIME_EVENTS, REALTIME_ROOMS, configuredAffordances, potentialAffordances, type AdapterType, type AgentAdapter, type AgentisToolContext, type ChatMessage, type NormalizedTask, type RealtimeEventName } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import { publishAgentWorkStep, publishChatDeltaProgress } from '../agent/agentWorkProgress.js';
import type { ToolHandlerDeps } from './deps.js';
import { listRuntimeModels, modelConfiguredOnAgent } from '../runtime/runtimeModels.js';
import { renderRuntimeRoutingIntelligence, routeModelForTask } from '../modelRoutingPolicy.js';
import { switchRuntime } from '../agent/agentCommission.js';
import { detectHarnesses, invalidateHarnessProbeCache, type HarnessDetectionResult, type V1HarnessAdapterType } from '../harness/harnessProbe.js';

const V1_ADAPTERS = new Set<AdapterType>(['openclaw', 'hermes_agent', 'claude_code', 'codex', 'cursor', 'antigravity', 'openrouter', 'http']);

function inlineAgentDispatchTimeoutMs(): number {
  const configured = Number(process.env.AGENTIS_INLINE_AGENT_DISPATCH_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1_000, Math.min(Math.floor(configured), CONSTANTS.AGENT_TASK_RESPONSE_TIMEOUT_MS));
  }
  // Inline delegation holds a chat tool round open. Keep it substantially below
  // the background-task budget; work that needs longer must use async dispatch.
  return Math.min(120_000, CONSTANTS.AGENT_TASK_RESPONSE_TIMEOUT_MS);
}

export function registerAgentTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.agents.list',
        mcpExposed: true,
        family: 'inspect',
        description: 'List agents available in the workspace.',
        inputSchema: {
          type: 'object',
          properties: { status: { type: 'string' } },
        },
        mutating: false,
      },
      handler: async (args: Record<string, unknown>, ctx: AgentisToolContext) => {
        const status = args.status ? normalizeStatus(String(args.status)) : null;
        const agents = deps.db
          .select()
          .from(schema.agents)
          .where(eq(schema.agents.workspaceId, ctx.workspaceId))
          .all()
          .filter((agent) => !status || normalizeStatus(agent.status) === status)
          .map((agent) => ({
            id: agent.id,
            name: agent.name,
            status: agent.status,
            adapterType: agent.adapterType,
            runtimeModel: agent.runtimeModel,
            role: agent.role,
            capabilityTags: agent.capabilityTags,
            registered: Boolean(deps.adapters.get(agent.id)),
          }));
        return { count: agents.length, agents };
      },
    },
    {
      definition: {
        id: 'agentis.agents.update',
        mcpExposed: true,
        family: 'environment',
        description:
          "Update an agent's profile and behavior: name, description, instructions (its operating prompt / agentis.md), runtimeModel, role (manager|worker|specialist), reportsTo (manager agentId), domain/space tag, budget, or PAUSE/resume it (isPaused). Pausing takes the agent offline immediately. Does NOT change the harness adapter/credentials (operator territory via agent settings). Changing role to \"orchestrator\" is not allowed here — do that in agent settings.",
        inputSchema: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'Agent to update. Omit to use the current agent.' },
            name: { type: 'string' },
            description: { type: 'string' },
            instructions: { type: 'string', description: 'The agent\'s operating prompt (its agentis.md identity/config).' },
            runtimeModel: { type: 'string', description: 'Model id the agent runs on, e.g. gpt-5.6-sol / claude-opus-4-8.' },
            role: { type: 'string', enum: ['manager', 'worker', 'specialist'] },
            reportsTo: { type: 'string', description: 'Manager agentId this agent reports to. null to clear.' },
            spaceTag: { type: 'string', description: 'Domain/team label, e.g. "marketing".' },
            monthlyBudgetCents: { type: 'number' },
            isPaused: { type: 'boolean', description: 'true = take offline; false = resume.' },
          },
        },
        mutating: true,
        autoExecute: true,
      },
      handler: async (args, ctx) => {
        const agentId = resolveAgentId(args, ctx);
        const existing = loadWorkspaceAgent(deps, ctx.workspaceId, agentId);
        if (args.role === 'orchestrator') {
          throw new AgentisError('VALIDATION_FAILED', 'Promoting an agent to "orchestrator" must be done in agent settings (it re-points the whole team). Use manager/worker/specialist here.');
        }
        if (typeof args.reportsTo === 'string' && args.reportsTo) {
          if (args.reportsTo === agentId) throw new AgentisError('VALIDATION_FAILED', 'an agent cannot report to itself.');
          loadWorkspaceAgent(deps, ctx.workspaceId, args.reportsTo); // validate target in workspace
        }
        const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
        if (typeof args.name === 'string' && args.name.trim()) set.name = args.name.trim();
        if (typeof args.description === 'string') set.description = args.description;
        if (typeof args.instructions === 'string') set.instructions = args.instructions;
        if (typeof args.runtimeModel === 'string') set.runtimeModel = args.runtimeModel.trim() || null;
        if (typeof args.role === 'string') set.role = args.role;
        if ('reportsTo' in args) set.reportsTo = args.reportsTo === null ? null : String(args.reportsTo);
        if (typeof args.spaceTag === 'string') set.spaceTag = args.spaceTag;
        if (typeof args.monthlyBudgetCents === 'number') set.monthlyBudgetCents = Math.max(0, Math.round(args.monthlyBudgetCents));
        let pausedNow = false;
        if (typeof args.isPaused === 'boolean' && args.isPaused !== Boolean(existing.isPaused)) {
          set.isPaused = args.isPaused;
          set.status = args.isPaused ? 'paused' : 'online';
          pausedNow = args.isPaused;
        }
        deps.db.update(schema.agents).set(set).where(eq(schema.agents.id, agentId)).run();
        // Pausing takes it offline immediately; resuming lets the next dispatch
        // re-register. (Full harness/config re-registration stays with the route.)
        if (pausedNow) { try { await deps.adapters.unregister(agentId); } catch { /* best-effort */ } }
        publishAgentChange(deps, ctx.workspaceId, agentId, REALTIME_EVENTS.AGENT_UPDATED);
        const row = loadWorkspaceAgent(deps, ctx.workspaceId, agentId);
        return { agentId, name: row.name, role: row.role, runtimeModel: row.runtimeModel, isPaused: Boolean(row.isPaused), status: row.status };
      },
    },
    {
      definition: {
        id: 'agentis.agents.runtime.switch',
        mcpExposed: true,
        family: 'environment',
        description:
          'Rebind an EXISTING agent to a healthy native runtime without changing its identity, Brain, App membership, workflows, or hierarchy. Waits briefly for a requested runtime to appear; when allowed, selects a compatible healthy fallback. Never creates a replacement agent or an unconfigured HTTP placeholder.',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: { type: 'string' },
            adapterType: { type: 'string', enum: ['openclaw', 'hermes_agent', 'claude_code', 'codex', 'cursor', 'antigravity', 'openrouter', 'http'] },
            runtimeModel: { type: 'string' },
            config: { type: 'object' },
            requiredCapabilities: { type: 'array', items: { type: 'string' } },
            allowFallback: { type: 'boolean', description: 'Default true.' },
            waitMs: { type: 'number', description: 'Detection window, default/max 20000ms.' },
          },
          required: ['agentId'],
        },
        mutating: true,
        autoExecute: true,
      },
      handler: async (args, ctx) => {
        if (!deps.vault) throw new AgentisError('VALIDATION_FAILED', 'runtime commissioning is not available in this deployment');
        const agentId = String(args.agentId ?? '').trim();
        const existing = loadWorkspaceAgent(deps, ctx.workspaceId, agentId);
        const requested = args.adapterType ? normalizeAdapterType(args.adapterType) as V1HarnessAdapterType : null;
        const required = parseStringArray(args.requiredCapabilities);
        const waitMs = Math.max(0, Math.min(20_000, Number(args.waitMs ?? 20_000)));
        const allowFallback = args.allowFallback !== false;
        const detections = await waitForRuntime(requested, waitMs);
        const selected = selectHealthyRuntime(detections, requested, required, allowFallback);
        if (!selected) {
          return {
            switched: false,
            agentId,
            unchanged: true,
            requestedRuntime: requested,
            warning: 'No compatible healthy runtime is currently available.',
            probes: detections.map(presentDetection),
          };
        }
        const supplied = args.config && typeof args.config === 'object' && !Array.isArray(args.config)
          ? args.config as Record<string, unknown>
          : {};
        const config = {
          ...(selected.config ?? {}),
          ...(selected.adapterType === 'codex' && (required.includes('browser') || required.includes('computerUse')) ? { browser: true } : {}),
          ...supplied,
        };
        const result = await switchRuntime({
          db: deps.db,
          vault: deps.vault,
          adapters: deps.adapters,
          logger: deps.logger,
          bus: deps.bus,
          skillMaterializer: deps.skillMaterializer,
        }, ctx.workspaceId, agentId, {
          adapterType: selected.adapterType,
          config,
          runtimeModel: typeof args.runtimeModel === 'string' ? args.runtimeModel : null,
        });
        return {
          switched: result.status === 'online',
          agentId,
          identityPreserved: existing.id === result.id,
          requestedRuntime: requested,
          selectedRuntime: result.adapterType,
          runtimeModel: result.runtimeModel,
          status: result.status,
          fallbackUsed: Boolean(requested && requested !== result.adapterType),
          capabilities: configuredAffordances(result.adapterType, config),
        };
      },
    },
    {
      definition: {
        id: 'agentis.agents.delete',
        mcpExposed: true,
        family: 'environment',
        description:
          'PERMANENTLY delete an agent. Destructive and irreversible. Called WITHOUT confirm:true it returns a preview; call again with confirm:true to proceed. By default the agent\'s memory is PROMOTED to the workspace Brain (not lost); pass memoryDisposition:"delete" to erase it or "transfer"+targetAgentId to move it. Prefer pausing (agentis.agents.update { isPaused:true }) if you only want it to stop.',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: { type: 'string' },
            confirm: { type: 'boolean', description: 'Must be true to actually delete. Omit/false for a preview.' },
            memoryDisposition: { type: 'string', enum: ['promote', 'delete', 'transfer'], description: 'What to do with the agent\'s memory. Default promote.' },
            targetAgentId: { type: 'string', description: 'Required when memoryDisposition="transfer".' },
          },
          required: ['agentId'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const agentId = String(args.agentId ?? '').trim();
        if (!agentId) throw new AgentisError('VALIDATION_FAILED', 'agents.delete requires agentId');
        const existing = loadWorkspaceAgent(deps, ctx.workspaceId, agentId);
        const disposition = (typeof args.memoryDisposition === 'string' ? args.memoryDisposition : 'promote') as 'promote' | 'delete' | 'transfer';
        if (args.confirm !== true) {
          return {
            deleted: false,
            preview: true,
            agent: { agentId, name: existing.name, role: existing.role },
            willRemove: 'this agent and its registration; its memory will be ' + (disposition === 'delete' ? 'ERASED' : disposition === 'transfer' ? 'transferred' : 'promoted to the workspace Brain'),
            next: `Call agentis.agents.delete again with { agentId: "${agentId}", confirm: true } to proceed. To just stop it, use agentis.agents.update { agentId: "${agentId}", isPaused: true }.`,
          };
        }
        // Decide the fate of the agent's scoped memory BEFORE the row is gone.
        let memoryMoved = 0, memoryDeleted = 0;
        if (deps.episodes) {
          if (disposition === 'delete') memoryDeleted = deps.episodes.deleteScope(ctx.workspaceId, agentId);
          else if (disposition === 'transfer') {
            const target = String(args.targetAgentId ?? '').trim();
            if (!target) throw new AgentisError('VALIDATION_FAILED', 'memoryDisposition "transfer" requires targetAgentId.');
            loadWorkspaceAgent(deps, ctx.workspaceId, target);
            memoryMoved = deps.episodes.reassignScope(ctx.workspaceId, agentId, target);
          } else memoryMoved = deps.episodes.reassignScope(ctx.workspaceId, agentId, null); // promote to workspace
        }
        try { await deps.adapters.unregister(agentId); } catch { /* best-effort */ }
        deps.db.delete(schema.agents).where(eq(schema.agents.id, agentId)).run();
        publishAgentChange(deps, ctx.workspaceId, agentId, REALTIME_EVENTS.AGENT_DELETED);
        return { deleted: true, agentId, name: existing.name, memoryDisposition: disposition, memoryMoved, memoryDeleted };
      },
    },
    {
      definition: {
        id: 'agentis.routing.preview',
        mcpExposed: true,
        family: 'inspect',
        description:
          'Explain which runtime and model Agentis would choose for a task. Use before spawning, dispatching, or escalating model power when routing is unclear.',
        inputSchema: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Task text or mission brief.' },
            purpose: { type: 'string', description: 'Optional purpose such as conversation, workflow_synthesis, evaluation, agent_task, or specialist.' },
            requiredAffordances: { type: 'array', items: { type: 'string' }, description: 'Hard affordances such as browser, web, integration, code, listener, or extension.' },
            agentId: { type: 'string', description: 'Optional agent whose explicit runtime model should be considered a pin.' },
            runtime: { type: 'string', description: 'Optional runtime/adapter type such as claude_code, codex, cursor, hermes_agent, or http.' },
            model: { type: 'string', description: 'Optional explicit model pin to preview.' },
          },
          required: ['task'],
        },
        mutating: false,
      },
      handler: async (args: Record<string, unknown>, ctx: AgentisToolContext) => {
        const task = String(args.task ?? '');
        const purpose = args.purpose ? String(args.purpose) : 'conversation';
        const agentId = args.agentId ? String(args.agentId) : null;
        const agent = agentId
          ? deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get()
          : null;
        if (agentId && (!agent || agent.workspaceId !== ctx.workspaceId)) throw new Error(`agent ${agentId} not found`);
        const registration = agentId ? deps.adapters.get(agentId) : null;
        const explicitModel = args.model
          ? String(args.model)
          : agent
            ? modelConfiguredOnAgent(agent)
            : null;
        const runtime = args.runtime
          ? String(args.runtime)
          : registration?.adapter.adapterType ?? agent?.adapterType ?? null;
        const requiredAffordances = parseStringArray(args.requiredAffordances);
        const runtimeType = runtime && V1_ADAPTERS.has(runtime as AdapterType)
          ? runtime as V1HarnessAdapterType
          : null;
        const catalog = runtimeType
          ? await listRuntimeModels(runtimeType, agentId, deps.db)
          : null;
        const decision = deps.modelRouter && !agentId && !runtime
          ? deps.modelRouter.route({
              role: purpose.includes('synthesis') || purpose.includes('workflow') ? 'synthesis' : purpose.includes('evaluation') ? 'evaluation' : 'conversation',
              workspaceId: ctx.workspaceId,
              task,
              purpose,
              explicitModel,
              requiredAffordances,
            })
          : routeModelForTask({
              task,
              purpose,
              runtime,
              explicitModel,
              currentModel: explicitModel,
              candidateModels: catalog?.models.map((model) => ({
                model: model.id,
                runtime,
                tier: model.tier,
                source: model.source === 'runtime' || model.source === 'profile' ? 'runtime_detected' : model.source,
                verified: model.verified,
                costRank: model.costRank,
                latencyRank: model.latencyRank,
                capabilityHints: model.capabilityHints,
                reason: model.description,
              })),
              requiredAffordances,
            });
        const detections = await detectHarnesses();
        const healthyRuntimes = detections.filter((item) => item.status === 'found' && !item.needsConfig);
        return {
          ok: true,
          decision,
          runtimeProfiles: healthyRuntimes.map((item) => ({
            runtime: item.adapterType,
            status: item.status,
            affordances: potentialAffordances(item.adapterType),
            selected: item.adapterType === runtime,
          })),
          intelligence: renderRuntimeRoutingIntelligence({
            decision,
            requiredAffordances,
            availableRuntimes: healthyRuntimes.map((item) => ({
              runtime: item.adapterType,
              models: item.adapterType === runtime ? catalog?.models.map((model) => model.id) ?? [] : [],
              affordances: Object.entries(potentialAffordances(item.adapterType))
                .filter(([, enabled]) => enabled)
                .map(([key]) => key),
            })),
          }),
        };
      },
    },
    createAgentTool('agentis.agents.create'),
    createAgentTool('agentis.agent.spawn'),
    {
      definition: {
        id: 'agentis.specialist.create',
        mcpExposed: true,
        family: 'build' as const,
        description:
          'Author a NEW specialist (custom functional role) and materialize it so you can delegate to it immediately. ' +
          'Use this when a task needs an expert role that does not exist yet — never delegate to a role that has not been created. ' +
          'Provide a role slug or name (e.g. "frontend_architect"), a focused instructions/system prompt, and optional model/tools/tags. ' +
          'Returns the materialized agentId and role; on the next step you can call delegate_task or agentis.agent.dispatch with that role.',
        inputSchema: {
          type: 'object',
          properties: {
            role: { type: 'string', description: 'Stable role slug, e.g. frontend_architect. Derived from name when omitted.' },
            name: { type: 'string', description: 'Display name, e.g. "Frontend Architect".' },
            description: { type: 'string', description: 'One-line description of what this specialist is trusted to do.' },
            instructions: { type: 'string', description: 'System prompt defining the specialist identity, responsibilities, and boundaries.' },
            model: { type: 'string', description: 'Optional model hint, e.g. gpt-4o or claude-sonnet.' },
            tools: { type: 'array', items: { type: 'string' }, description: 'Optional role-scoped tool names.' },
            capabilityTags: { type: 'array', items: { type: 'string' }, description: 'Capability tags for routing.' },
            adapterType: { type: 'string', description: 'Optional runtime to bind (openclaw|claude_code|codex|cursor|hermes_agent|http). Use for roles that need a native runtime power, e.g. codex for a native browser.' },
            runtimeConfig: { type: 'object', description: 'Optional adapter config paired with adapterType, e.g. { "browser": true } to enable Codex native browser.' },
          },
          required: [],
        },
        mutating: true,
        autoExecute: true,
      },
      handler: async (args: Record<string, unknown>, ctx: AgentisToolContext) => {
        if (!deps.specialists) {
          return { ok: false, error: 'specialist library not available in this deployment' };
        }
        const runtimeConfig = args.runtimeConfig && typeof args.runtimeConfig === 'object' && !Array.isArray(args.runtimeConfig)
          ? args.runtimeConfig as Record<string, unknown>
          : undefined;
        const requestedRuntime = args.adapterType ? normalizeAdapterType(args.adapterType) as V1HarnessAdapterType : null;
        const runtimeDetections = deps.vault
          ? await waitForRuntime(requestedRuntime, requestedRuntime ? 20_000 : 0)
          : [];
        const runtimeSelection = deps.vault
          ? selectHealthyRuntime(runtimeDetections, requestedRuntime, [], true)
          : null;
        if (deps.vault && !runtimeSelection) {
          return {
            ok: false,
            created: false,
            warning: 'No healthy runtime is currently available, so no offline specialist placeholder was created.',
            requestedRuntime,
            probes: runtimeDetections.map(presentDetection),
          };
        }
        const result = await deps.specialists.authorSpecialist(ctx.workspaceId, ctx.userId, {
          role: args.role ? String(args.role) : undefined,
          name: args.name ? String(args.name) : undefined,
          description: args.description ? String(args.description) : undefined,
          instructions: args.instructions ? String(args.instructions) : undefined,
          model: args.model ? String(args.model) : undefined,
          tools: parseStringArray(args.tools),
          capabilityTags: parseStringArray(args.capabilityTags),
          source: 'generated',
          ...((runtimeSelection?.adapterType ?? args.adapterType) ? { adapterType: String(runtimeSelection?.adapterType ?? args.adapterType) } : {}),
          ...((runtimeSelection?.config || runtimeConfig) ? { runtimeConfig: { ...(runtimeSelection?.config ?? {}), ...(runtimeConfig ?? {}) } } : {}),
        });
        const runtimeResult = deps.vault
          ? await switchRuntime({
              db: deps.db,
              vault: deps.vault,
              adapters: deps.adapters,
              logger: deps.logger,
              bus: deps.bus,
              skillMaterializer: deps.skillMaterializer,
            }, ctx.workspaceId, result.agentId, {
              adapterType: runtimeSelection!.adapterType,
              config: { ...(runtimeSelection!.config ?? {}), ...(runtimeConfig ?? {}) },
              runtimeModel: typeof args.model === 'string' ? args.model : null,
            })
          : null;
        const profile = deps.specialistProfiles?.ensureFromDef(ctx.workspaceId, result.def, ctx.userId);
        const instanceId = deps.specialistRuntime?.ensureInstance({
          workspaceId: ctx.workspaceId,
          role: result.role,
          agentId: result.agentId,
          profileId: profile?.id ?? null,
          mode: 'durable',
          parentAgentId: ctx.agentId ?? null,
          reportsTo: ctx.agentId ?? null,
        });
        // CONVERSATION THEATER: the orchestrator commissioning a specialist (and the
        // instructions it gave) is a first-class collaboration moment — record it as
        // an agent-actor activity so the interaction feed shows it live.
        try {
          deps.activity.record({
            workspaceId: ctx.workspaceId,
            ambientId: ctx.ambientId ?? null,
            userId: ctx.userId,
            eventType: result.created ? 'agent.commissioned' : 'agent.recommissioned',
            actorType: 'agent',
            actorId: ctx.agentId ?? null,
            entityType: 'agent',
            entityId: result.agentId,
            summary: `Commissioned ${result.def.name} as “${result.role}”${args.instructions ? ' with instructions' : ''}`,
            metadata: {
              role: result.role,
              created: result.created,
              ...(instanceId ? { specialistInstanceId: instanceId } : {}),
              ...(args.instructions ? { instructions: String(args.instructions).slice(0, 400) } : {}),
            },
          });
        } catch { /* theater event is best-effort */ }
        return {
          ok: true,
          agentId: result.agentId,
          role: result.role,
          created: result.created,
          updated: !result.created,
          ...(runtimeResult ? { runtime: runtimeResult } : {}),
          ...(instanceId ? { specialistInstanceId: instanceId } : {}),
          name: result.def.name,
          delegateHint: `You can now delegate to this specialist by role "${result.role}".`,
        };
      },
    },
    {
      definition: {
        id: 'agentis.specialist.request',
        mcpExposed: true,
        family: 'run' as const,
        description:
          'Request the best existing or materialized specialist for a concrete task. ' +
          'Use this before delegating when the needed role is unclear. Returns selected role, agentId, topology, explanation, and a planned specialistRun trace.',
        inputSchema: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Concrete task or mission brief.' },
            modality: { type: 'string', description: 'Primary input modality: text, file, image, audio, structured_data.' },
            desiredTopology: { type: 'string', enum: ['direct', 'supervisor', 'sequential', 'swarm', 'hierarchical', 'shadow'] },
            materialize: { type: 'boolean', description: 'Whether to create/reuse the durable agent instance. Default true.' },
          },
          required: ['task'],
        },
        mutating: true,
        autoExecute: true,
      },
      handler: async (args: Record<string, unknown>, ctx: AgentisToolContext) => {
        if (!deps.specialistRouter) {
          return { ok: false, error: 'specialist demand router not available in this deployment' };
        }
        const wantsMaterialize = args.materialize !== false;
        const detections = wantsMaterialize && deps.vault ? await waitForRuntime(null, 0) : [];
        const selectedRuntime = wantsMaterialize && deps.vault
          ? selectHealthyRuntime(detections, null, [], true)
          : null;
        const route = await deps.specialistRouter.request(ctx.workspaceId, ctx.userId, {
          task: String(args.task ?? ''),
          modality: args.modality ? String(args.modality) : undefined,
          desiredTopology: typeof args.desiredTopology === 'string' ? args.desiredTopology as never : undefined,
          materialize: wantsMaterialize && (!deps.vault || Boolean(selectedRuntime)),
          callerAgentId: ctx.agentId ?? null,
        });
        let runtime: Awaited<ReturnType<typeof switchRuntime>> | null = null;
        if (route.selectedAgentId && selectedRuntime && deps.vault && !deps.adapters.get(route.selectedAgentId)) {
          runtime = await switchRuntime({
            db: deps.db,
            vault: deps.vault,
            adapters: deps.adapters,
            logger: deps.logger,
            bus: deps.bus,
            skillMaterializer: deps.skillMaterializer,
          }, ctx.workspaceId, route.selectedAgentId, {
            adapterType: selectedRuntime.adapterType,
            config: selectedRuntime.config,
          });
        }
        return {
          ok: true,
          ...route,
          ...(runtime ? { runtime } : {}),
          ...(wantsMaterialize && deps.vault && !selectedRuntime
            ? {
                warning: 'No healthy runtime is available. The role was selected without creating an offline placeholder.',
                probes: detections.map(presentDetection),
              }
            : {}),
          delegateHint: route.selectedAgentId
            ? `Delegate to agentId "${route.selectedAgentId}" or role "${route.selectedRole}".`
            : `Delegate by role "${route.selectedRole}".`,
        };
      },
    },
    {
      definition: {
        id: 'agentis.agent.consult',
        mcpExposed: true,
        family: 'run',
        description:
          'Privately consult another workspace agent for expertise, wait for its grounded answer, and continue the current task. ' +
          'Use targetAgentId when your instructions name a specific colleague; use targetRole or omit the target for capability routing. ' +
          'Pass consultationId with a follow-up question to continue the same bounded dialogue. The customer never sees this internal transcript.',
        inputSchema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'A self-contained expert question.' },
            targetAgentId: { type: 'string', description: 'Preferred exact workspace agent id.' },
            targetRole: { type: 'string', description: 'Preferred specialist role when no exact agent is required.' },
            context: { type: 'string', description: 'Optional bounded context needed to answer; do not include unnecessary secrets.' },
            consultationId: { type: 'string', description: 'Existing consultation id for a follow-up question.' },
            parentSessionId: { type: 'string', description: 'Owning persistent agent session, when invoked inside a workflow.' },
          },
          required: ['question'],
        },
        mutating: false,
        autoExecute: true,
        approval: { riskLevel: 'low', reversible: true, externalSideEffects: false },
      },
      handler: async (args: Record<string, unknown>, ctx: AgentisToolContext) => {
        if (!deps.consultations) return { ok: false, error: 'agent consultation runtime is not available' };
        return deps.consultations.consult({
          question: String(args.question ?? ''),
          ...(typeof args.targetAgentId === 'string' ? { targetAgentId: args.targetAgentId } : {}),
          ...(typeof args.targetRole === 'string' ? { targetRole: args.targetRole } : {}),
          ...(typeof args.context === 'string' ? { context: args.context } : {}),
          ...(typeof args.consultationId === 'string' ? { consultationId: args.consultationId } : {}),
          ...(typeof args.parentSessionId === 'string' ? { parentSessionId: args.parentSessionId } : {}),
        }, ctx);
      },
    },
    {
      definition: {
        id: 'agentis.agent.dispatch',
        mcpExposed: true,
        family: 'run',
        description: 'Dispatch a task to an existing agent. Uses chat when the adapter supports it, otherwise dispatches a normalized task.',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: { type: 'string' },
            task: { type: 'string' },
            input: { type: 'object' },
          },
          required: ['agentId', 'task'],
        },
        mutating: true,
      },
      handler: async (args: Record<string, unknown>, ctx: AgentisToolContext) => {
        const agentId = String(args.agentId);
        const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
        if (!agent || agent.workspaceId !== ctx.workspaceId) throw new Error(`agent ${agentId} not found`);
        if (agent.isPaused || agent.status === 'paused') {
          return { dispatched: false, agentId, reason: 'agent_paused', message: 'This agent is in standby mode. Disable standby before dispatching tasks.' };
        }
        let registration = deps.adapters.get(agentId);
        if (!registration && deps.resolveAgentRuntime) {
          const inherited = deps.resolveAgentRuntime(
            ctx.workspaceId,
            agentId,
            String(args.task),
            modelConfiguredOnAgent(agent),
          );
          if (inherited) {
            deps.adapters.register(agentId, inherited as AgentAdapter);
            registration = deps.adapters.get(agentId);
          }
        }
        if (!registration) {
          return { dispatched: false, agentId, reason: 'adapter_unavailable', message: 'The agent exists but its harness is not connected.' };
        }

        const task = String(args.task);
        const adapterType = registration.adapter.adapterType as V1HarnessAdapterType;
        const catalog = V1_ADAPTERS.has(adapterType)
          ? await listRuntimeModels(adapterType, agentId, deps.db)
          : null;
        const routing = routeModelForTask({
          task,
          purpose: 'agent_dispatch',
          runtime: registration.adapter.adapterType ?? agent.adapterType ?? null,
          explicitModel: modelConfiguredOnAgent(agent),
          candidateModels: catalog?.models.map((model) => ({
            model: model.id,
            runtime: adapterType,
            tier: model.tier,
            source: model.source === 'runtime' || model.source === 'profile' ? 'runtime_detected' : model.source,
            verified: model.verified,
            costRank: model.costRank,
            latencyRank: model.latencyRank,
            capabilityHints: model.capabilityHints,
            reason: model.description,
          })),
          requiredAffordances: Array.isArray(agent.capabilityTags) ? agent.capabilityTags.map(String) : [],
        });
        const preferredModel = routing.selectedModel;
        const taskId = randomUUID();
        const workContext = {
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId ?? null,
          agentId,
          agentName: agent.name,
          conversationId: ctx.conversationId,
          taskId,
          runId: ctx.runId,
        };
        const capabilities = registration.adapter.capabilities?.();
        if (registration.adapter.chat && capabilities?.interactiveChat !== false) {
          const messages: ChatMessage[] = [
            { role: 'system', content: agent.instructions ?? `You are ${agent.name}, an Agentis agent.` },
            { role: 'user', content: task },
          ];
          let response = '';
          let finishReason: 'stop' | 'tool_calls' | 'length' | 'error' | 'max_turns' | 'interrupted' = 'stop';
          let runtimeError = '';
          const controller = new AbortController();
          const abortFromCaller = () => controller.abort(ctx.signal?.reason ?? new Error('agent_dispatch_canceled'));
          if (ctx.signal?.aborted) abortFromCaller();
          else ctx.signal?.addEventListener('abort', abortFromCaller, { once: true });
          const timeoutMs = inlineAgentDispatchTimeoutMs();
          let timedOut = false;
          const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort(new Error('agent_dispatch_timeout'));
          }, timeoutMs);
          timeout.unref?.();
          publishAgentWorkStep(deps.bus, {
            ...workContext,
            phase: 'start',
            description: 'Agent task started',
          });
          try {
            for await (const delta of registration.adapter.chat(messages, [], {
              ...(preferredModel ? { preferredModel } : {}),
              timeoutMs,
              signal: controller.signal,
              sessionKey: ctx.conversationId ? `dispatch:${ctx.conversationId}:${taskId}` : `dispatch:${taskId}`,
            })) {
              publishChatDeltaProgress(deps.bus, workContext, delta);
              if (delta.type === 'text') response += delta.delta;
              if (delta.type === 'tool_result' && delta.error) runtimeError = delta.error;
              if (delta.type === 'done') {
                finishReason = delta.finishReason;
                break;
              }
            }
            if (timedOut) {
              throw new AgentisError('ADAPTER_TIMEOUT', `Agent ${agent.name} exceeded the bounded ${Math.round(timeoutMs / 1000)} second dispatch window.`);
            }
            if (ctx.signal?.aborted || finishReason === 'interrupted') {
              throw new AgentisError('TURN_CANCELLED', `Dispatch to agent ${agent.name} was canceled.`);
            }
            if (finishReason === 'error') {
              throw new AgentisError('ADAPTER_REJECTED', runtimeError || `Agent ${agent.name} failed without returning a usable result.`);
            }
            if (finishReason === 'length' || finishReason === 'max_turns' || finishReason === 'tool_calls') {
              throw new AgentisError('ADAPTER_TIMEOUT', `Agent ${agent.name} stopped before producing a final result (${finishReason}).`);
            }
            if (!response.trim()) {
              throw new AgentisError('ADAPTER_REJECTED', `Agent ${agent.name} completed without returning a result.`);
            }
            publishAgentWorkStep(deps.bus, {
              ...workContext,
              phase: 'complete',
              description: 'Agent task completed',
            });
          } catch (err) {
            publishAgentWorkStep(deps.bus, {
              ...workContext,
              phase: 'fail',
              description: `Agent task failed: ${(err as Error).message}`,
            });
            throw err;
          } finally {
            clearTimeout(timeout);
            ctx.signal?.removeEventListener('abort', abortFromCaller);
          }
          return { dispatched: true, mode: 'chat', agentId, taskId, response, routing };
        }

        const normalized: NormalizedTask = {
          taskId,
          runId: ctx.runId ?? `chat_${ctx.conversationId ?? randomUUID()}`,
          workflowId: 'agent_dispatch',
          nodeId: taskId,
          title: task.slice(0, 120) || 'Agent task',
          description: task,
          inputData: args.input && typeof args.input === 'object' && !Array.isArray(args.input)
            ? args.input as Record<string, unknown>
            : { task },
          scratchpadSnapshot: {},
          capabilityTags: Array.isArray(agent.capabilityTags) ? agent.capabilityTags.map(String) : [],
          timeoutMs: 120_000,
          ...(preferredModel ? { preferredModel } : {}),
        };
        await deps.adapters.dispatchTask(normalized, agentId);
        return { dispatched: true, mode: 'task', agentId, taskId, runId: normalized.runId, routing };
      },
    },
  ]);

  function createAgentTool(id: 'agentis.agents.create' | 'agentis.agent.spawn') {
    return {
      definition: {
        id,
        mcpExposed: true,
        family: 'build' as const,
        description: id === 'agentis.agent.spawn' ? 'Create a new agent from a role brief.' : 'Create a new agent.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            instructions: { type: 'string' },
            role: { type: 'string' },
            adapterType: { type: 'string' },
            runtimeModel: { type: 'string' },
            capabilityTags: { type: 'array', items: { type: 'string' } },
            config: { type: 'object' },
          },
          required: ['name'],
        },
        mutating: true,
        autoExecute: true,
      },
      handler: async (args: Record<string, unknown>, ctx: AgentisToolContext) => {
        const requestedName = String(args.name).trim();
        const requestedRole = args.role ? String(args.role).trim() : null;
        const roleIsStableIdentity = requestedRole ? !GENERIC_AGENT_ROLES.has(requestedRole.toLowerCase()) : false;
        const existing = deps.db.select().from(schema.agents)
          .where(eq(schema.agents.workspaceId, ctx.workspaceId))
          .all()
          .find((agent) =>
            (roleIsStableIdentity && agent.role === requestedRole)
            || agent.name.trim().toLowerCase() === requestedName.toLowerCase());
        if (existing) {
          const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
          if (args.instructions !== undefined) set.instructions = String(args.instructions);
          if (requestedRole) set.role = requestedRole;
          if (args.runtimeModel !== undefined) set.runtimeModel = String(args.runtimeModel);
          if (args.capabilityTags !== undefined) set.capabilityTags = parseStringArray(args.capabilityTags);
          deps.db.update(schema.agents).set(set).where(eq(schema.agents.id, existing.id)).run();
          let runtime: unknown = null;
          if (deps.vault && (args.adapterType || !deps.adapters.get(existing.id))) {
            runtime = await commissionAgentRuntime(deps, ctx.workspaceId, existing.id, {
              requested: args.adapterType ? normalizeAdapterType(args.adapterType) as V1HarnessAdapterType : null,
              config: args.config && typeof args.config === 'object' && !Array.isArray(args.config) ? args.config as Record<string, unknown> : undefined,
              runtimeModel: typeof args.runtimeModel === 'string' ? args.runtimeModel : null,
              waitMs: args.adapterType ? 20_000 : 0,
            });
          }
          return { agent: loadWorkspaceAgent(deps, ctx.workspaceId, existing.id), created: false, updated: true, reused: true, runtime };
        }
        const requestedAdapter = args.adapterType ? normalizeAdapterType(args.adapterType) as V1HarnessAdapterType : null;
        const detected = deps.vault
          ? selectHealthyRuntime(await waitForRuntime(requestedAdapter, requestedAdapter ? 20_000 : 0), requestedAdapter, [], true)
          : null;
        if (deps.vault && !detected) {
          return {
            created: false,
            warning: 'No healthy runtime is currently available, so no offline placeholder was created.',
            requestedRuntime: requestedAdapter,
          };
        }
        const now = new Date().toISOString();
        const adapterType = detected?.adapterType ?? normalizeAdapterType(args.adapterType);
        const config = args.config && typeof args.config === 'object' && !Array.isArray(args.config)
          ? args.config as Record<string, unknown>
          : detected?.config ?? defaultConfig(adapterType);
        const agent = {
          id: randomUUID(),
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId ?? null,
          userId: ctx.userId,
          gatewayId: null,
          packageId: null,
          name: requestedName,
          adapterType,
          capabilityTags: parseStringArray(args.capabilityTags),
          config,
          status: 'offline',
          lastHeartbeatAt: null,
          currentTaskId: null,
          colorHex: null,
          instructions: args.instructions ? String(args.instructions) : null,
          avatarGlyph: null,
          runtimeModel: args.runtimeModel ? String(args.runtimeModel) : null,
          role: args.role ? String(args.role) : 'agent',
          createdAt: now,
          updatedAt: now,
        };
        deps.db.insert(schema.agents).values(agent).run();
        const runtime = deps.vault
          ? await switchRuntime({
              db: deps.db,
              vault: deps.vault,
              adapters: deps.adapters,
              logger: deps.logger,
              bus: deps.bus,
              skillMaterializer: deps.skillMaterializer,
            }, ctx.workspaceId, agent.id, {
              adapterType: adapterType as V1HarnessAdapterType,
              config,
              runtimeModel: typeof args.runtimeModel === 'string' ? args.runtimeModel : null,
            })
          : null;
        return {
          agent: loadWorkspaceAgent(deps, ctx.workspaceId, agent.id),
          created: true,
          harnessConfigured: Boolean(detected || args.config),
          runtime,
        };
      },
    };
  }
}

const GENERIC_AGENT_ROLES = new Set(['agent', 'worker', 'specialist', 'manager', 'orchestrator']);
function normalizeStatus(status: string): string {
  const value = status.toLowerCase();
  if (value === 'idle') return 'online';
  if (value === 'paused') return 'offline';
  return value;
}

/** Resolve the target agent: explicit arg → the current turn's agent. */
function resolveAgentId(args: Record<string, unknown>, ctx: AgentisToolContext): string {
  if (typeof args.agentId === 'string' && args.agentId.trim()) return args.agentId.trim();
  if (ctx.agentId) return ctx.agentId;
  throw new AgentisError('VALIDATION_FAILED', 'no agent in context — pass "agentId".');
}

/** Load an agent row scoped to the workspace, or throw NOT_FOUND. */
function loadWorkspaceAgent(deps: ToolHandlerDeps, workspaceId: string, agentId: string): typeof schema.agents.$inferSelect {
  const row = deps.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.workspaceId, workspaceId)))
    .get();
  if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `agent ${agentId} not found in this workspace`);
  return row;
}

/** Publish an agent lifecycle change to the agent + workspace rooms so the fleet
 *  canvas / team strips / home refetch live. */
function publishAgentChange(deps: ToolHandlerDeps, workspaceId: string, agentId: string, event: RealtimeEventName): void {
  try {
    const payload = { agentId, workspaceId };
    deps.bus.publish(REALTIME_ROOMS.agent(agentId), event, payload);
    deps.bus.publish(REALTIME_ROOMS.workspace(workspaceId), event, payload);
  } catch {
    /* realtime must never fail a write */
  }
}
function normalizeAdapterType(value: unknown): AdapterType {
  const adapterType = String(value ?? 'http') as AdapterType;
  return V1_ADAPTERS.has(adapterType) ? adapterType : 'http';
}

function defaultConfig(adapterType: AdapterType): Record<string, unknown> {
  if (adapterType === 'http') {
    return { adapterType, baseUrl: '', dispatchPath: '/task' };
  }
  return { adapterType };
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
}

async function waitForRuntime(requested: V1HarnessAdapterType | null, waitMs: number): Promise<HarnessDetectionResult[]> {
  const deadline = Date.now() + waitMs;
  let detections: HarnessDetectionResult[] = [];
  do {
    invalidateHarnessProbeCache();
    detections = await detectHarnesses();
    const found = requested && detections.find((item) => item.adapterType === requested && item.status === 'found' && !item.needsConfig);
    if (found || !requested) return detections;
    if (Date.now() >= deadline) return detections;
    await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, Math.max(1, deadline - Date.now()))));
  } while (Date.now() <= deadline);
  return detections;
}

function selectHealthyRuntime(
  detections: HarnessDetectionResult[],
  requested: V1HarnessAdapterType | null,
  required: string[],
  allowFallback: boolean,
): HarnessDetectionResult | null {
  const healthy = detections.filter((item) => item.status === 'found' && !item.needsConfig);
  const supports = (item: HarnessDetectionResult) => {
    const affordances = potentialAffordances(item.adapterType);
    return required.every((key) => Boolean((affordances as Record<string, unknown>)[key]));
  };
  const exact = requested ? healthy.find((item) => item.adapterType === requested && supports(item)) : null;
  if (exact) return exact;
  if (requested && !allowFallback) return null;
  const preference: V1HarnessAdapterType[] = ['codex', 'claude_code', 'hermes_agent', 'antigravity', 'cursor', 'openclaw', 'openrouter', 'http'];
  return healthy.filter(supports).sort((a, b) => preference.indexOf(a.adapterType) - preference.indexOf(b.adapterType))[0] ?? null;
}

function presentDetection(item: HarnessDetectionResult) {
  return { adapterType: item.adapterType, status: item.status, needsConfig: Boolean(item.needsConfig), detail: item.detail ?? null };
}

async function commissionAgentRuntime(
  deps: ToolHandlerDeps,
  workspaceId: string,
  agentId: string,
  input: {
    requested: V1HarnessAdapterType | null;
    config?: Record<string, unknown>;
    runtimeModel?: string | null;
    waitMs: number;
  },
): Promise<Awaited<ReturnType<typeof switchRuntime>> | {
  status: 'unavailable';
  requestedRuntime: V1HarnessAdapterType | null;
  warning: string;
  probes: ReturnType<typeof presentDetection>[];
}> {
  if (!deps.vault) throw new AgentisError('VALIDATION_FAILED', 'runtime commissioning is not available in this deployment');
  const detections = await waitForRuntime(input.requested, input.waitMs);
  const selected = selectHealthyRuntime(detections, input.requested, [], true);
  if (!selected) {
    return {
      status: 'unavailable',
      requestedRuntime: input.requested,
      warning: 'No healthy runtime is currently available. The existing agent was preserved unchanged.',
      probes: detections.map(presentDetection),
    };
  }
  return switchRuntime({
    db: deps.db,
    vault: deps.vault,
    adapters: deps.adapters,
    logger: deps.logger,
    bus: deps.bus,
    skillMaterializer: deps.skillMaterializer,
  }, workspaceId, agentId, {
    adapterType: selected.adapterType,
    config: { ...(selected.config ?? {}), ...(input.config ?? {}) },
    runtimeModel: input.runtimeModel ?? null,
  });
}
