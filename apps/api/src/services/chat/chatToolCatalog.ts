/**
 * CHAT_TOOL_CATALOG — CHAT-AGENT-LOOP.md §3.
 *
 * JSON schema descriptors passed to the LLM tool-calling protocol.
 * These schemas tell the model what each tool does, when to use it,
 * and what parameters it accepts. Every entry here should map to a
 * corresponding executor in BUILTIN_REGISTRY or ChatToolExecutor.
 */

import type { ToolDefinition } from '@agentis/core';

export const CHAT_TOOL_CATALOG: ToolDefinition[] = [
  // ─── Capability plane (reach) ────────────────────────────────────────────
  // The primary way to find and use anything in the workspace without holding it
  // all in context: search by meaning → load the contract → invoke, down to a
  // single node/phase, a specialist agent, or an MCP tool. See CAPABILITY MANIFEST.
  {
    name: 'agentis.capability.search',
    description:
      'Find the exact capability to use by MEANING — apps, workflows, individual nodes/phases, specialist agents, skills, and MCP tools — without holding the whole workspace in context. Returns ranked URNs. Use this FIRST whenever the operator refers to something you do not already have in hand.',
    parameters: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'What you are trying to find or do, in plain language.' },
        kind: { type: 'string', description: 'Optional filter.', enum: ['app', 'workflow', 'node', 'phase', 'agent', 'skill', 'mcp_tool', 'collection'] },
        limit: { type: 'number', description: 'Max results (default 8, max 25).' },
      },
      required: ['intent'],
    },
  },
  {
    name: 'agentis.capability.load',
    description:
      'Page in the FULL typed contract for capability URNs from agentis.capability.search (input fields, node/phase structure, agent identity) so you invoke them correctly. Load only what the step needs.',
    parameters: {
      type: 'object',
      properties: {
        urns: { type: 'array', items: { type: 'string' }, description: 'URNs from capability.search.' },
        urn: { type: 'string', description: 'A single URN (alternative to urns).' },
      },
    },
  },
  {
    name: 'agentis.capability.invoke',
    description:
      'Run a capability by URN — a whole workflow (wf:<id>), a single deep node (app:<id>/wf:<id>/node:<id>), an execution phase (.../phase:<id>), a specialist agent (agent:<id>, to hand off or converse), or an MCP tool (mcp:<slug>__<tool>). Pass input as the trigger/agent/tool payload; for a node/phase pass sourceRunId to pin the run to replay from. Returns the routed result or grounded guidance.',
    parameters: {
      type: 'object',
      properties: {
        urn: { type: 'string', description: 'Capability URN from capability.search.' },
        input: { type: 'object', description: 'Payload: workflow trigger inputs, agent { task }, or MCP tool arguments.' },
        sourceRunId: { type: 'string', description: 'For node/phase: the run to replay from (defaults to the workflow\'s latest run).' },
      },
      required: ['urn'],
    },
  },
  // ─── Command Model (comprehension) ───────────────────────────────────────
  // You MANAGE what you own — review it, act on it, and record what you learn.
  {
    name: 'agentis.command.review',
    description:
      'Review what YOU manage right now — your scoped inventory, live progress and what changed since you last looked, what needs you, and what your apps have learned. Call this at the start of a management turn or whenever you want a fresh picture, before acting.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'agentis.command.note',
    description:
      'Record a management decision, objective, progress note, or learning to YOUR mind so your future self and next session recall it — how comprehension compounds instead of resetting each turn.',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'The decision/objective/progress/learning, in your own words.' },
        kind: { type: 'string', enum: ['decision', 'objective', 'progress', 'learning'], description: 'Default decision.' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['note'],
    },
  },
  // ─── Platform Control ────────────────────────────────────────────────────
  {
    name: 'agentis.workflow.run',
    description:
      'Start a workflow by its ID with optional input data. Use this when the user asks to ' +
      'run, trigger, or execute a workflow. Returns the runId and initial status so you ' +
      'can follow up with agentis.workflow.status. Always pass a real workflowId, never a workflow title; use agentis.workflow.list or agentis.canvas.context first if needed. Example input: {"workflowId":"8f4c5c7b-1b6e-4f8e-9c9a-5b3b4e7f9a12","inputs":{"text":"hello"}}.',
    examples: [
      {
        description: 'Run a workflow by UUID with structured trigger input.',
        input: { workflowId: '8f4c5c7b-1b6e-4f8e-9c9a-5b3b4e7f9a12', inputs: { text: 'hello' } },
        expectedOutput: { runId: 'run_...', workflowId: '8f4c5c7b-1b6e-4f8e-9c9a-5b3b4e7f9a12', status: 'started' },
      },
      {
        description: 'Run a workflow with no inputs after resolving its ID from context.',
        input: { workflowId: '0b2b16f4-8c70-4e2d-9b4f-4dd6ebf7ec32' },
      },
    ],
    parameters: {
      type: 'object',
      properties: {
        workflowId: {
          type: 'string',
          description: 'The ID of the workflow to run.',
        },
        taskId: {
          type: 'string',
          description: 'Optional durable task/plan id to bind this run to.',
        },
        planId: {
          type: 'string',
          description: 'Optional durable task/plan id to bind this run to.',
        },
        input: {
          type: 'string',
          description: 'JSON-encoded input data to pass to the workflow trigger node.',
        },
      },
      required: ['workflowId'],
    },
  },
  {
    name: 'agentis.ephemeral.run',
    description:
      'Run a temporary workflow graph once without saving it to the workflow library. Use for exploratory one-off automations after the operator confirms the graph or intent. Returns the ephemeral runId and stream URL. The run can be promoted later if it proves useful.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short label for the temporary run.' },
        graph: { type: 'object', description: 'Agentis WorkflowGraph JSON to execute once. Trigger nodes are stripped before execution.' },
        inputs: { type: 'object', description: 'Initial input object for root nodes.' },
        maxDurationMs: { type: 'number', description: 'Execution cap in milliseconds, max 300000.' },
      },
      required: ['graph'],
    },
  },
  {
    name: 'agentis.workflow.status',
    description:
      'Get the current execution status of a workflow run. Use this when the user asks about ' +
      'a running workflow, wants to know if it finished, or asks for progress updates. ' +
      'Returns status (PENDING/RUNNING/COMPLETED/FAILED/CANCELLED), progress (0–1), ' +
      'currentNode name, and a summary of completed nodes.',
    parameters: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'The ID of the workflow run to check. Format: run_<uuid>.',
        },
      },
      required: ['runId'],
    },
  },
  {
    name: 'agentis.workflow.list',
    description:
      'List recent workflow runs for the workspace. Use this when the user asks what ' +
      'workflows have run recently, wants an overview of activity, or needs to find a runId. ' +
      'Returns up to 20 recent runs with status, workflow name, start time, and duration.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status. One of: RUNNING, COMPLETED, FAILED, PENDING, CANCELLED.',
          enum: ['RUNNING', 'COMPLETED', 'FAILED', 'PENDING', 'CANCELLED'],
        },
        limit: {
          type: 'string',
          description: 'Maximum number of runs to return. Default 20, max 50.',
        },
      },
    },
  },
  {
    name: 'agentis.run.cancel',
    description:
      'Cancel a running workflow run by runId. Use this when the user explicitly asks to stop, cancel, or abort a run. Returns the cancelled runId and status.',
    parameters: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'The workflow run ID to cancel.',
        },
      },
      required: ['runId'],
    },
  },
  {
    name: 'agentis.task.accept',
    description:
      'Accept a complex operator objective into the durable task spine. Use when a requested task will span multiple steps, tools, runs, sessions, or decisions, even if it is not a workflow.',
    parameters: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: 'The task objective.' },
        title: { type: 'string', description: 'Short operator-facing task title.' },
        acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: 'Criteria that must be verified before completion.' },
        assumptions: { type: 'array', items: { type: 'string' }, description: 'Known assumptions for the work.' },
      },
      required: ['objective'],
    },
  },
  {
    name: 'agentis.task.set_steps',
    description:
      'Publish the ordered checklist the operator watches live (the StepTrack shown in chat, the Live Workspace, and channels). Call this as soon as you begin multi-step work, before doing the steps. Creates the task spine automatically if needed.',
    parameters: {
      type: 'object',
      properties: {
        steps: { type: 'array', items: { type: 'string' }, description: 'Ordered, short imperative step labels.' },
        taskId: { type: 'string', description: 'Existing task spine id; omit to use this conversation.' },
        title: { type: 'string', description: 'Short operator-facing task title.' },
        objective: { type: 'string', description: 'Task objective if the spine must be created.' },
      },
      required: ['steps'],
    },
  },
  {
    name: 'agentis.task.advance_step',
    description:
      'Advance the live checklist. Call it each time you finish a step (defaults to marking the active step done and starting the next). Pass status:"failed" when a step fails.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Existing task spine id; omit to use this conversation.' },
        index: { type: 'number', description: '0-based step to update; omit to advance the active step.' },
        label: { type: 'string', description: 'Step label to update (alternative to index).' },
        status: { type: 'string', enum: ['running', 'done', 'failed'], description: 'Defaults to "done".' },
      },
    },
  },
  {
    name: 'agentis.task.inspect',
    description: 'Inspect the durable task spine row, including status, run/session bindings, decisions, deviations, and verification.',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'The durable task/plan id.' } },
      required: ['taskId'],
    },
  },
  {
    name: 'agentis.routing.preview',
    description:
      'Preview Agentis runtime/model routing for a task. Use before spawning or dispatching when deciding between specialist/extension/ability creation and model escalation.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task text or mission brief.' },
        purpose: { type: 'string', description: 'Purpose such as conversation, workflow_synthesis, evaluation, agent_task, or specialist.' },
        requiredAffordances: { type: 'array', items: { type: 'string' }, description: 'Hard requirements such as browser, web, integration, code, listener, or extension.' },
        agentId: { type: 'string', description: 'Optional agent whose explicit model pin should be respected.' },
        runtime: { type: 'string', description: 'Optional adapter/runtime type.' },
        model: { type: 'string', description: 'Optional explicit model pin to preview.' },
      },
      required: ['task'],
    },
  },
  {
    name: 'agentis.task.bind_run',
    description: 'Bind an existing workflow run to a durable task spine when the run is part of a larger accepted task.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The durable task/plan id.' },
        runId: { type: 'string', description: 'The workflow run id.' },
      },
      required: ['taskId', 'runId'],
    },
  },
  {
    name: 'agentis.task.record_decision',
    description: 'Record a durable task decision after making a meaningful scope, approach, or verification choice.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The durable task/plan id.' },
        summary: { type: 'string', description: 'Concise decision statement.' },
        rationale: { type: 'string', description: 'Grounded rationale for the decision.' },
      },
      required: ['taskId', 'summary'],
    },
  },
  {
    name: 'agentis.task.flag_deviation',
    description: 'Record a durable deviation when reality does not fit the accepted task contract.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The durable task/plan id.' },
        kind: { type: 'string', enum: ['reject_input', 'rescope', 'blocked'] },
        reason: { type: 'string', description: 'Grounded explanation of the deviation.' },
        proposed: { type: 'string', description: 'Optional proposed revised path.' },
      },
      required: ['taskId', 'kind', 'reason'],
    },
  },
  {
    name: 'agentis.workflow.patch',
    description:
      'DEPRECATED compatibility alias: workflowId + complete graph replaces a stored graph; runId + patch evolves a live run. ' +
      'Use agentis.workflow.graph.patch for field-level stored edits, agentis.workflow.graph.replace for explicit replacement, or agentis.run.graph.evolve for live execution.',
    parameters: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID for at-rest graph replacement.' },
        graph: { type: 'object', description: 'Complete replacement workflow graph.' },
        runId: { type: 'string', description: 'Run ID for live graph patching.' },
        patch: { type: 'object', description: 'WorkflowGraphPatch payload for a live run.' },
        baseHash: { type: 'string', description: 'Optional graph hash from the last inspection.' },
      },
    },
  },
  {
    name: 'agentis.workflow.graph.replace',
    description: 'Atomically replace a stored workflow with a complete graph. Supports optimistic concurrency and dry-run diff preview. Use graph.patch for scoped edits.',
    parameters: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' }, graph: { type: 'object' }, baseHash: { type: 'string' },
        baseUpdatedAt: { type: 'string' }, dryRun: { type: 'boolean' }, confirmIntentChange: { type: 'boolean' },
      },
      required: ['workflowId', 'graph'],
    },
  },
  {
    name: 'agentis.workflow.graph.patch',
    description:
      'Atomically patch selected fields or structure of a stored workflow. Operations are add_node, patch_node, remove_node, add_edge, patch_edge, remove_edge, and patch_viewport. ' +
      'Object patches merge recursively and preserve omitted fields. Supports optimistic concurrency and dry-run diff preview.',
    parameters: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' }, operations: { type: 'array', items: { type: 'object' } },
        baseHash: { type: 'string' }, baseUpdatedAt: { type: 'string' }, dryRun: { type: 'boolean' }, confirmIntentChange: { type: 'boolean' },
      },
      required: ['workflowId', 'operations'],
    },
  },
  {
    name: 'agentis.workflow.graph.revisions',
    description: 'List retained durable graph revisions for a stored workflow. Returns revision hashes and metadata without returning the stored graph snapshots.',
    parameters: {
      type: 'object', properties: { workflowId: { type: 'string' } }, required: ['workflowId'],
    },
  },
  {
    name: 'agentis.workflow.graph.rollback',
    description: 'Preview or commit an atomic rollback to a retained workflow graph revision. Requires the current baseHash; commit requires confirm:true and records the replaced graph so the rollback is reversible.',
    parameters: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' }, targetHash: { type: 'string' }, baseHash: { type: 'string' },
        dryRun: { type: 'boolean' }, confirm: { type: 'boolean' },
      },
      required: ['workflowId', 'targetHash', 'baseHash'],
    },
  },
  {
    name: 'agentis.run.graph.evolve',
    description: 'Evolve a live run graph through the contract transaction. This does not edit the stored workflow.',
    parameters: {
      type: 'object', properties: { runId: { type: 'string' }, patch: { type: 'object' } }, required: ['runId', 'patch'],
    },
  },
  {
    name: 'agentis.workflow.rule',
    description:
      'Create, inspect, update, or delete a persisted executable workflow event rule. Use run.accomplished for verified business progression; run.completed is execution completion only. Supports source/target workflow ids, filters, input mapping, coalescing, and App ownership validation.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'upsert', 'delete'] },
        id: { type: 'string' }, appId: { type: 'string' }, sourceWorkflowId: { type: 'string' }, targetWorkflowId: { type: 'string' },
        eventType: { type: 'string', enum: ['run.completed', 'run.accomplished', 'run.failed', 'node.completed', 'node.failed'] },
        sourceNodeId: { type: 'string' }, filterExpression: { type: 'string' }, inputMapping: { type: 'object' },
        coalescePolicy: { type: 'string', enum: ['always_enqueue', 'coalesce_pending', 'latest_only'] },
        catchupPolicy: { type: 'string' }, enabled: { type: 'boolean' },
      },
    },
  },
  {
    name: 'agentis.apps.status',
    description:
      'Check the health status of all connected agent gateways (apps). Use this when the user ' +
      'asks if agents are connected, asks about gateway health, or troubleshoots connectivity. ' +
      'Returns a list of gateways with their online/offline status and last seen time.',
    parameters: {
      type: 'object',
      properties: {
        gatewayId: {
          type: 'string',
          description: 'Check a specific gateway by ID. Omit to check all gateways.',
        },
      },
    },
  },
  {
    name: 'agentis.channel.list',
    description:
      'List native Agentis messaging channels for Telegram, WhatsApp, Slack, and Discord with health checks and saved default targets. Use this before sending a channel message or when diagnosing channel connectivity.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description: 'Optional channel kind filter.',
          enum: ['telegram', 'whatsapp', 'slack', 'discord'],
        },
        status: {
          type: 'string',
          description: 'Optional status filter such as active, needs_action, error, degraded, verifying, or paused.',
        },
      },
    },
  },
  {
    name: 'agentis.channel.send',
    description:
      'Send a message through a connected native Agentis channel. Use this for requests like "send this to me on WhatsApp" or "send it to Slack" after checking channels. If the user says "me" or "myself", omit to or pass "default" to use the saved default target.',
    parameters: {
      type: 'object',
      properties: {
        connectionId: {
          type: 'string',
          description: 'Specific channel connection id. Use when more than one active channel could match.',
        },
        kind: {
          type: 'string',
          description: 'Channel kind to use when connectionId is omitted.',
          enum: ['telegram', 'whatsapp', 'slack', 'discord'],
        },
        to: {
          type: 'string',
          description: 'Destination address. Use "default" or omit to use the saved default target.',
        },
        body: {
          type: 'string',
          description: 'Message body to send.',
        },
      },
      required: ['body'],
    },
  },
  {
    name: 'agentis.agents.list',
    description:
      'List all agents registered in the workspace. Use this when the user asks which agents ' +
      'are available, wants agent names or IDs, or needs to route a task to the right agent. ' +
      'Returns agent id, name, status, role, and adapter type.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by agent status. One of: idle, busy, offline, paused.',
          enum: ['idle', 'busy', 'offline', 'paused'],
        },
      },
    },
  },
  {
    name: 'agentis.agents.create',
    description:
      'Create a new configured agent. Use when the user asks to add an agent and has provided enough name/role/runtime detail. If no harness config is provided, the agent is created offline and must be configured before dispatch.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent name.' },
        instructions: { type: 'string', description: 'System instructions for the agent.' },
        role: { type: 'string', description: 'Role such as agent, orchestrator, reviewer, or critic.' },
        adapterType: { type: 'string', description: 'Harness adapter type.', enum: ['openclaw', 'hermes_agent', 'claude_code', 'codex', 'cursor', 'antigravity', 'openrouter', 'http'] },
        runtimeModel: { type: 'string', description: 'Optional runtime model label.' },
        capabilityTags: { type: 'array', description: 'Capability tags for matching work.', items: { type: 'string' } },
        config: { type: 'object', description: 'Adapter-specific harness config.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'agentis.agent.spawn',
    description:
      'Spawn a new specialist agent from a role brief. Prefer reusing existing agents when one already matches the task; use this only after the user confirms a new agent is wanted.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent name.' },
        instructions: { type: 'string', description: 'Instructions defining the specialist behavior.' },
        role: { type: 'string', description: 'Agent role.' },
        adapterType: { type: 'string', description: 'Harness adapter type.', enum: ['openclaw', 'hermes_agent', 'claude_code', 'codex', 'cursor', 'antigravity', 'openrouter', 'http'] },
        runtimeModel: { type: 'string', description: 'Optional runtime model label.' },
        capabilityTags: { type: 'array', description: 'Capability tags.', items: { type: 'string' } },
        config: { type: 'object', description: 'Adapter-specific harness config.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'agentis.specialist.create',
    description:
      'Author a NEW specialist (custom functional role like frontend_architect or tax_analyst) and materialize it so you can delegate to it immediately. ' +
      'Use this before delegating when no existing role fits the task — never delegate to a role that does not exist yet. ' +
      'Provide a role slug or name, a focused instructions/system prompt, and optional model/tools/tags. ' +
      'Returns the materialized agentId and role so the next step can delegate to it.',
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Stable role slug, e.g. frontend_architect. Derived from name when omitted.' },
        name: { type: 'string', description: 'Display name, e.g. "Frontend Architect".' },
        description: { type: 'string', description: 'One-line description of what this specialist is trusted to do.' },
        instructions: { type: 'string', description: 'System prompt defining identity, responsibilities, and boundaries.' },
        model: { type: 'string', description: 'Optional model hint, e.g. gpt-4o or claude-sonnet.' },
        tools: { type: 'array', items: { type: 'string' }, description: 'Optional role-scoped tool names.' },
        capabilityTags: { type: 'array', items: { type: 'string' }, description: 'Capability tags for routing.' },
      },
    },
  },
  {
    name: 'agentis.specialist.request',
    description:
      'Request the best specialist for a concrete task by capability need. Use this when the right role is unclear or when a manager/orchestrator needs an explainable routing decision. Returns selected role, materialized agentId, topology, explanation, context summary, and planned specialist run trace.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Concrete task or mission brief.' },
        modality: { type: 'string', description: 'Primary input modality: text, file, image, audio, or structured_data.' },
        desiredTopology: { type: 'string', enum: ['direct', 'supervisor', 'sequential', 'swarm', 'hierarchical', 'shadow'] },
        materialize: { type: 'boolean', description: 'Create/reuse the durable specialist agent instance. Default true.' },
      },
      required: ['task'],
    },
  },
  {
    name: 'agentis.agent.consult',
    description:
      'Privately ask another Agentis agent for expertise and wait for its answer. ' +
      'Use targetAgentId for a colleague named in your instructions, targetRole for a functional specialist, or omit both for capability routing. ' +
      'For a follow-up, pass consultationId from the previous result. The customer sees only your final synthesis.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Self-contained expert question.' },
        targetAgentId: { type: 'string', description: 'Exact workspace agent id.' },
        targetRole: { type: 'string', description: 'Specialist role used for routing.' },
        context: { type: 'string', description: 'Optional bounded context required by the specialist.' },
        consultationId: { type: 'string', description: 'Continue an existing consultation.' },
      },
      required: ['question'],
    },
  },
  {
    name: 'agentis.agent.dispatch',
    description:
      'Send a concrete task to an existing agent. Use after selecting a real agentId from agentis.agents.list. Never pass an agent name as agentId. Returns either a chat response or a dispatched task id. Example input: {"agentId":"agent_9d2...","task":"Inspect the failing onboarding workflow and summarize the blocker."}.',
    examples: [
      {
        description: 'Dispatch a bounded analysis task to a real agent ID.',
        input: { agentId: 'agent_9d25f3', task: 'Inspect the failing onboarding workflow and summarize the blocker.', input: { workflowId: 'wf_123' } },
      },
      {
        description: 'Ask an existing worker to produce a draft artifact.',
        input: { agentId: 'agent_researcher_1', task: 'Draft a concise competitor brief from the indexed market research documents.' },
      },
    ],
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Target agent ID.' },
        task: { type: 'string', description: 'Concrete task to perform.' },
        input: { type: 'object', description: 'Optional structured task input.' },
      },
      required: ['agentId', 'task'],
    },
  },

  // ─── Memory & Knowledge ──────────────────────────────────────────────────
  {
    name: 'agentis.memory.read',
    description:
      'Search the workspace persistent memory for notes, learnings, decisions, and facts ' +
      'recorded by agents or operators. Use this when the user references past work, asks ' +
      'what the team has learned, or wants context from previous sessions. ' +
      'Returns matching memory entries sorted by importance.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keyword or phrase to search for in memory titles, content, and tags.',
        },
        kind: {
          type: 'string',
          description: 'Filter by memory kind. Examples: note, decision, fact, task, learning.',
        },
        agentId: {
          type: 'string',
          description: 'Restrict to memories written by a specific agent.',
        },
        limit: {
          type: 'string',
          description: 'Maximum entries to return (1–100, default 20).',
        },
      },
    },
  },
  {
    name: 'agentis.memory.write',
    description:
      'Store a new memory entry in persistent memory. Use this when you ' +
      'want to remember something important for the future: decisions made, key facts, ' +
      'learnings from a task, or instructions to preserve. Memory persists across sessions. ' +
      'SCOPE: omit agentId for WORKSPACE-wide memory; pass agentId to write into ONE ' +
      "specialist's OWN mind. When you CORRECT or constrain a specialist, persist the " +
      'correction as an agent-scoped rule (kind:"rule", agentId set) so the agent LEARNS it ' +
      'and recalls it automatically — do not rely only on editing its instructions.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short, descriptive title for this memory entry.',
        },
        content: {
          type: 'string',
          description: 'The full content to store.',
        },
        kind: {
          type: 'string',
          description: 'Memory category. Examples: note, decision, fact, task, learning.',
        },
        importance: {
          type: 'string',
          description: 'Importance score from 1 (low) to 10 (critical). Default 5.',
        },
        tags: {
          type: 'string',
          description: 'JSON array of string tags for filtering. Example: ["workflow","sdr"].',
        },
        agentId: {
          type: 'string',
          description: "Target ONE specialist's own mind (agent-scoped). Omit for workspace-wide memory.",
        },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'agentis.memory.delete',
    description:
      'Delete a memory entry from the workspace persistent memory by its ID. Use this when the operator ' +
      'asks to remove, forget, or delete a memory entry, note, fact, or lesson. Make sure to find the ' +
      'memory entry ID using agentis.memory.read first if not already known.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The unique ID of the memory entry to delete.',
        },
        agentId: {
          type: 'string',
          description: 'Optional agent ID context.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'agentis.knowledge.search',
    description:
      'Full-text search across workspace documents, indexed URLs, and knowledge base entries. ' +
      'Use this when the user asks factual questions, wants to look up a document, or ' +
      'references a previously indexed resource. Returns matching excerpts with source metadata. Prefer short keyword-first queries over verbose paragraphs. Example input: {"query":"Agentis workflow node types","limit":"5"}.',
    examples: [
      {
        description: 'Search for architecture notes with a compact keyword query.',
        input: { query: 'Agentis workflow node types', limit: '5' },
      },
      {
        description: 'Find a decision record by a few distinctive terms.',
        input: { query: 'chat orchestrator confirmation policy', limit: '3' },
      },
    ],
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query. Use natural language or keywords.',
        },
        limit: {
          type: 'string',
          description: 'Maximum results to return (default 5, max 20).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'agentis.knowledge.write',
    description:
      'Index a document, URL, or text snippet into the workspace knowledge base so it can ' +
      'be found by future knowledge.search calls. Use this to preserve research, onboarding ' +
      'docs, or reference material that agents and operators need.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Title for this knowledge entry.',
        },
        content: {
          type: 'string',
          description: 'The document text or HTML content to index.',
        },
        url: {
          type: 'string',
          description: 'Source URL if the content was fetched from a URL.',
        },
        tags: {
          type: 'string',
          description: 'JSON array of string tags.',
        },
        agentId: {
          type: 'string',
          description: 'Target specialist private knowledge scope. Omit for workspace knowledge.',
        },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'agentis.knowledge.archive',
    description:
      'Archive a document in the knowledge base by documentId and knowledgeBaseId. Use this when the operator ' +
      'asks to remove, delete, or archive a document or resource from the knowledge base. Use agentis.knowledge.search ' +
      'first to resolve the documentId and knowledgeBaseId if not already known.',
    parameters: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          description: 'The unique ID of the document to archive.',
        },
        knowledgeBaseId: {
          type: 'string',
          description: 'The ID of the knowledge base containing the document.',
        },
      },
      required: ['documentId', 'knowledgeBaseId'],
    },
  },
  {
    name: 'agentis.knowledge.delete',
    description:
      'Permanently delete one or more knowledge documents and their indexed chunks. This cannot be undone. ' +
      'Use knowledge.archive instead unless the operator explicitly wants permanent deletion or cleanup.',
    parameters: {
      type: 'object',
      properties: {
        documentIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 500 },
        knowledgeBaseId: { type: 'string' },
      },
      required: ['documentIds', 'knowledgeBaseId'],
    },
  },
  {
    name: 'agentis.knowledge_base.delete',
    description:
      'Permanently delete an entire knowledge base and all documents and chunks inside it. This cannot be undone.',
    parameters: {
      type: 'object',
      properties: { knowledgeBaseId: { type: 'string' } },
      required: ['knowledgeBaseId'],
    },
  },
  {
    name: 'agentis.brain.search',
    description:
      'Search YOUR Brain by meaning, mid-task — durable memories, workspace knowledge, and (on request) your Skill library — instead of guessing when you need a fact, rule, or procedure you were not handed up front. Especially useful after a PRE-TASK MEMORY note says nothing matched: try again with different or broader terms before concluding it doesn\'t exist. Returns ranked atoms ({ id, kind, title, snippet, score }). Skills/examples are EXCLUDED by default; pass kind:"skill" (or "example"/"all") to include them, then read a skill\'s full procedure with agentis.skill.load. Prefer short keyword-first queries. Example: {"query":"deploy migrations safely","kind":"skill"}.',
    examples: [
      { description: 'Recall a durable rule or fact mid-task.', input: { query: 'customer refund policy over $500' } },
      { description: 'Find a relevant procedure in the skill library.', input: { query: 'triage stripe webhook failures', kind: 'skill' } },
    ],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are looking for (natural language or keywords).' },
        kind: { type: 'string', enum: ['memory', 'knowledge', 'skill', 'example', 'all'], description: 'Restrict the search. Omit to search durable memory + knowledge (skill library excluded). Use "skill"/"example" for the skill library, or "all" for everything.' },
        limit: { type: 'number', description: 'Max results (1–20, default 6).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'agentis.skill.load',
    description:
      "Load a Living Skill's full procedure (its SKILL.md body) by id or slug. The short description is discoverable via agentis.brain.search; call this to read the WHOLE procedure before applying it. (This is distinct from agentis.skill.inspect, which inspects an executable workflow extension.) Example: {\"skill\":\"deploy-migrations-safely\"}.",
    examples: [
      { description: 'Read the full procedure for a skill found via brain.search.', input: { skill: 'deploy-migrations-safely' } },
    ],
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Skill id or slug.' },
      },
      required: ['skill'],
    },
  },
  {
    name: 'agentis.skill.promote_example',
    description:
      "Save a worked input→output pair as an EXAMPLE of a skill done right — the skill's demonstration set grows from real wins and rides along the next time it is loaded. Use after a skill produced a genuinely good result worth teaching. Example: {\"skill\":\"deploy-migrations-safely\",\"input\":\"add a column\",\"output\":\"flagged, migrated, verified, flipped\"}.",
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Skill id or slug the example demonstrates.' },
        input: { type: 'string', description: 'The task/input the skill handled.' },
        output: { type: 'string', description: 'The good result the skill produced.' },
      },
      required: ['skill', 'input', 'output'],
    },
  },

  // ─── Decisions & Approvals ───────────────────────────────────────────────
  {
    name: 'agentis.skills.list',
    description:
      'List available workspace skills with real skillIds, runtime, entrypoint, capability tags, and input/output schemas. Use this before building a workflow with skill_task nodes or when the user asks what built-in/custom skills are available. Never invent a skillId; call this tool first. Example input: {"query":"http","limit":10}.',
    examples: [
      {
        description: 'Find built-in or installed skills that can fetch HTTP data.',
        input: { query: 'http', limit: 10 },
        expectedOutput: { skills: [{ id: '...', slug: 'http_fetch', runtime: 'builtin', entrypoint: 'http_fetch' }] },
      },
      {
        description: 'List deterministic in-process skills for cheap workflow steps.',
        input: { runtime: 'builtin', limit: 20 },
      },
    ],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional keyword filter across name, slug, entrypoint, runtime, and tags.' },
        runtime: {
          type: 'string',
          description: 'Filter by skill runtime.',
          enum: ['builtin', 'node_worker', 'docker_sandbox'],
        },
        capabilityTag: { type: 'string', description: 'Filter by a capability tag such as builtin, extraction, scoring, or formatting.' },
        limit: { type: 'number', description: 'Maximum skills to return. Default 50, max 200.' },
      },
    },
  },
  {
    name: 'agentis.skill.inspect',
    description:
      'Inspect a single skill by skillId, slug, or builtin entrypoint. Returns the manifest and whether it is usable in workflow skill_task nodes. Use this when you need exact schemas before wiring inputMapping/outputMapping. Example input: {"slug":"http_fetch"}.',
    examples: [
      {
        description: 'Inspect a skill by slug before wiring a skill_task node.',
        input: { slug: 'http_fetch' },
        expectedOutput: { found: true, usableInWorkflows: true, skill: { id: '...', inputSchema: { type: 'object' } } },
      },
      {
        description: 'Inspect by real skill ID returned from agentis.skills.list.',
        input: { skillId: 'skill_123' },
      },
    ],
    parameters: {
      type: 'object',
      properties: {
        skillId: { type: 'string', description: 'Workspace skill ID. Preferred when known.' },
        slug: { type: 'string', description: 'Workspace skill slug, for example http_fetch.' },
        entrypoint: { type: 'string', description: 'Builtin or package entrypoint, for example echo.' },
      },
    },
  },
  {
    name: 'agentis.approval.list',
    description:
      'List pending approvals waiting for operator decision in the workspace. Use this when ' +
      'the user asks what needs their attention, wants to see pending approvals, or asks ' +
      'what agents are waiting on. Returns approvals with title, summary, and requester.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'string',
          description: 'Maximum approvals to return (default 10, max 50).',
        },
      },
    },
  },
  {
    name: 'agentis.approval.resolve',
    description:
      'Approve or reject a pending approval by ID. Use this when the user says "approve" or ' +
      '"reject" in response to an approval request, or explicitly instructs you to resolve one. ' +
      'Always confirm the approval title and action with the user before calling this tool ' +
      'unless they have already provided explicit direction. Use agentis.approval.list first if the approvalId is not already known. Example input: {"approvalId":"apr_2f4...","decision":"approve","reason":"Operator approved in chat."}.',
    examples: [
      {
        description: 'Approve a known pending approval after explicit user direction.',
        input: { approvalId: 'apr_2f45c1', decision: 'approve', reason: 'Operator approved in chat.' },
      },
      {
        description: 'Reject a known approval with a short reason.',
        input: { approvalId: 'apr_7ab103', decision: 'reject', reason: 'Incorrect recipient list.' },
      },
    ],
    parameters: {
      type: 'object',
      properties: {
        approvalId: {
          type: 'string',
          description: 'The ID of the approval to resolve.',
        },
        decision: {
          type: 'string',
          description: 'The decision to apply.',
          enum: ['approve', 'reject'],
        },
        reason: {
          type: 'string',
          description: 'Optional reason or note for this decision.',
        },
      },
      required: ['approvalId', 'decision'],
    },
  },

  // ─── Observability ───────────────────────────────────────────────────────
  {
    name: 'agentis.audit_trail',
    description:
      'Read the ledger events for a specific workflow run. Use this when the user asks what ' +
      'happened during a run, wants to debug a workflow, or asks for a step-by-step trace. ' +
      'Returns ordered ledger events with node names, durations, inputs, and outputs.',
    parameters: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'The run ID to inspect. Format: run_<uuid>.',
        },
        limit: {
          type: 'string',
          description: 'Maximum events to return (default 100, max 500).',
        },
      },
    },
  },
  {
    name: 'agentis.run.query',
    description:
      'Query run history with filters. Use this to find runs by workflow, status, date range, ' +
      'or agent. Useful when the user wants historical data, metrics, or to find a specific ' +
      'past execution. Returns run summaries with status, duration, and workflow name.',
    parameters: {
      type: 'object',
      properties: {
        workflowId: {
          type: 'string',
          description: 'Filter by workflow ID.',
        },
        status: {
          type: 'string',
          description: 'Filter by status. One of: RUNNING, COMPLETED, FAILED, PENDING, CANCELLED.',
          enum: ['RUNNING', 'COMPLETED', 'FAILED', 'PENDING', 'CANCELLED'],
        },
        since: {
          type: 'string',
          description: 'ISO 8601 date string. Only return runs started after this time.',
        },
        limit: {
          type: 'string',
          description: 'Maximum runs to return (default 20, max 100).',
        },
      },
    },
  },
  {
    name: 'agentis.run.diagnose',
    description:
      'Diagnose why a run failed, stalled, or looks unhealthy. Use this before proposing a patch or retry. Returns failed nodes, recent failure ledger events, and suggested actions.',
    parameters: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'The run ID to diagnose.',
        },
      },
      required: ['runId'],
    },
  },
  {
    name: 'agentis.run.regrade',
    description:
      'Re-evaluate a completed run from persisted evidence after repairing its acceptance/spec contract. '
      + 'This does not execute workflow nodes or repeat external side effects; prefer it over another live run when the action succeeded but grading was wrong.',
    parameters: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'The completed run whose evidence should be regraded.',
        },
      },
      required: ['runId'],
    },
  },

  // ─── Builder & Planner ───────────────────────────────────────────────────
  {
    name: 'agentis.workflow.draft_contract',
    description: 'Inspect the complete public workflow build contract and a minimal valid graph draft. Call this before supplying graphDraft; description-only build requests are supported.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'agentis.build_workflow',
    description:
      'Validate, enrich, save, and stream an agent-authored workflow graph or patch. ' +
      'For a new workflow, pass a description alone and Agentis will create a validated, editable baseline when no synthesis runtime is configured; graphDraft is optional for precise authored graphs. ' +
      'When the operator asks for another/new/second/third workflow inside the open App, pass that App id as appId and newWorkflow:true; this creates an additional persisted workflow instead of modifying the workflow currently on screen. ' +
      'For a precise field-level edit use agentis.workflow.graph.patch; use workflowId plus patchDraft here when the edit should also pass through builder repair and enrichment. A configured fast synthesis runtime may accept description-only calls, but runtime-native agents should author the draft themselves. ' +
      'Every build belongs to an Agentic App: pass appId to add a new workflow to an existing App, or omit it for an App-of-one. The tool returns workflowId AND appId plus runId and emits live canvas build events.',
    examples: [
      {
        description: 'Build the minimal Hello World workflow from an agent-authored graph draft.',
        input: {
          title: 'Hello World',
          description: 'Create a manual workflow that returns the fixed object { text: "Workflow is working" }.',
          graphDraft: {
            version: 1,
            nodes: [
              {
                id: 'trigger',
                type: 'trigger',
                title: 'Manual Trigger',
                position: { x: 0, y: 0 },
                config: { kind: 'trigger', triggerType: 'manual' },
              },
              {
                id: 'output',
                type: 'return_output',
                title: 'Return Output',
                position: { x: 280, y: 0 },
                config: { kind: 'return_output', renderAs: 'text' },
              },
            ],
            edges: [{ id: 'trigger-output', source: 'trigger', target: 'output' }],
            viewport: { x: 0, y: 0, zoom: 1 },
          },
        },
        expectedOutput: { workflowId: '...', runId: 'build_...', nodeCount: 2, edgeCount: 1 },
      },
      {
        description: 'Update an existing workflow by ID from a natural-language change request.',
        input: {
          workflowId: '8f4c5c7b-1b6e-4f8e-9c9a-5b3b4e7f9a12',
          title: 'Weekly Research Digest',
          description: 'Add a human review checkpoint before the Slack notification step.',
        },
      },
    ],
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Natural-language description of what the workflow should do.',
        },
        title: {
          type: 'string',
          description: 'Desired workflow name.',
        },
        workflowId: {
          type: 'string',
          description: 'Existing workflow ID to update. Omit to create a new one.',
        },
        appId: {
          type: 'string',
          description: 'Existing App that should own a newly created workflow. Omit for an App-of-one.',
        },
        newWorkflow: {
          type: 'boolean',
          description: 'Set true when the operator explicitly asks for an additional/new/another workflow, especially while a different workflow is open. Prevents the conversation build latch from editing the previous workflow.',
        },
        graphDraft: {
          type: 'object',
          description: 'Complete agent-authored WorkflowGraph for a new workflow or intentional full replacement.',
        },
        patchDraft: {
          type: 'object',
          description: 'Legacy edit patch: addNodes, updateNodes, removeNodeIds, addEdges, and removeEdgeIds. updateNodes may contain only id plus changed fields; omitted fields are preserved.',
        },
      },
      required: ['description'],
    },
  },
  {
    name: 'agentis.workflow.restore_blueprint',
    description:
      'Restore a workflow to its BLESSED blueprint — the exact graph of its last ACCOMPLISHED production run. Use when a repair or edit broke a previously-working workflow ("it was perfect, now it fails"). Returns restored:false with the reason when nothing proven exists to restore.',
    parameters: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'The workflow to roll back.' },
      },
      required: ['workflowId'],
    },
  },
  {
    name: 'agentis.workflow.bless',
    description:
      'BLESS a workflow: mark a run\'s graph as the proven blueprint ("this works"), granting blueprint protection — self-heal will never autonomously restructure it, and restore_blueprint can always roll back to it. Defaults to the latest COMPLETED run; pass runId to pick one. Use after the operator confirms a workflow works, especially when no formal verdict ran.',
    parameters: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'The workflow to bless.' },
        runId: { type: 'string', description: 'Optional: bless the graph that ran in this run.' },
      },
      required: ['workflowId'],
    },
  },
  {
    name: 'agentis.workflow.patterns',
    description:
      'Retrieve robust workflow design patterns — proven control-flow shapes for the gates, fallbacks, loops, and rollback the happy path omits: ' +
      'qualify-or-reject-loop, fetch-with-fallback, approval-before-irreversible, validate-before-transition, bounded-parallel-batch, stateful-cursor-dedup. ' +
      'Call without id to list them with when-to-use; call with id to get the spliceable node+edge fragment to adapt into graphDraft. ' +
      'Use before building anything that qualifies candidates, takes an irreversible action, processes a batch, or runs on a schedule.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Pattern id to expand into a full fragment. Omit to list all patterns.' },
      },
    },
  },
  {
    name: 'agentis.workflow.learn',
    description:
      'Record a durable workflow lesson into the workspace playbook after diagnosing and fixing a novel run failure ' +
      '(a flaky source, a missing gate, an encoding gotcha, a rollback you had to add). Future builds recall these and design around them. ' +
      'Pass failureMode (what went wrong) and fix (what to do next time), plus an optional patternId.',
    parameters: {
      type: 'object',
      properties: {
        failureMode: { type: 'string', description: 'The situation or failure that occurred.' },
        fix: { type: 'string', description: 'What to do next time to avoid or handle it.' },
        patternId: { type: 'string', description: 'Optional robust pattern id that addresses it.' },
      },
      required: ['failureMode', 'fix'],
    },
  },
  {
    name: 'agentis.ability.create',
    description:
      'Create a reusable Agentis ability from a natural-language intent and queue it for compilation. Use when the operator asks the agent to learn, package, or create a reusable specialist capability.',
    parameters: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'The reusable specialist behavior to create.' },
        name: { type: 'string', description: 'Optional ability name.' },
        domainTag: { type: 'string', description: 'Optional routing domain.' },
      },
      required: ['intent'],
    },
  },
  {
    name: 'agentis.extension.resolve',
    description:
      'Resolve an extension requirement against installed workspace capabilities before creating anything. Returns ranked candidates and whether to reuse, update, or create.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Capability intent or extension name.' },
        requiresListenerSource: { type: 'boolean' },
        capabilityTags: { type: 'array', items: { type: 'string' } },
      },
      required: ['query'],
    },
  },
  {
    name: 'agentis.component.install',
    description:
      'Install or upgrade a portable Component bundle. Use this for deterministic component_task implementations; it verifies every bundle file, persists runtime component_oci and ComponentManifest, and preserves an existing extension ID during migration.',
    parameters: {
      type: 'object',
      properties: {
        extensionId: { type: 'string', description: 'Existing extension ID to upgrade in place.' },
        manifest: { type: 'object', description: 'Extension metadata plus the ComponentManifest under component.' },
        bundleFiles: { type: 'array', items: { type: 'object' }, description: 'Files with path, sha256, and dataBase64.' },
        permissionsAcknowledged: { type: 'array', items: { type: 'string' } },
      },
      required: ['manifest', 'bundleFiles', 'permissionsAcknowledged'],
    },
  },
  {
    name: 'agentis.team.spawn',
    description:
      'Create a temporary parallel team for two or more independent subproblems in THIS chat. Workers are temporary by default, inherit the current workspace and safety constraints, have no independent delegation, and stream safe progress inline. Use this instead of creating durable agents when the team is only needed for this task. At most 6 workers and 3 concurrent workers are allowed automatically; larger teams need operator approval.',
    parameters: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: 'One concise objective shared by the team.' },
        tasks: {
          type: 'array',
          minItems: 2,
          maxItems: 6,
          description: 'Independent work items. Do not split a sequential task into parallel workers.',
          items: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'Concrete, self-contained worker assignment.' },
              role: { type: 'string', description: 'Optional temporary role label.' },
              capabilityTags: { type: 'array', items: { type: 'string' }, description: 'Optional capability tags for reusing a compatible live agent.' },
            },
            required: ['task'],
          },
        },
        mergeStrategy: { type: 'string', enum: ['collect_all', 'compare', 'best_effort'], description: 'How the lead should use the returned worker evidence.' },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'agentis.extension.create',
    description:
      'Create or update a reusable workspace extension from JavaScript source and operation manifests. Resolve first and pass extensionId to update a matching capability instead of creating a duplicate. After creation, use the returned extensionId in agentis.build_workflow.',
    parameters: {
      type: 'object',
      properties: {
        extensionId: { type: 'string', description: 'Existing extension ID returned by agentis.extension.resolve.' },
        name: { type: 'string', description: 'Human-readable extension name.' },
        slug: { type: 'string', description: 'Optional stable slug.' },
        description: { type: 'string', description: 'What the extension does.' },
        source: {
          type: 'string',
          description: 'JavaScript source: declare a TOP-LEVEL async function per operation — `async function <operationName>(inputs, ctx) { ... }`. Do NOT use module.exports, exports, require, or import (all blocked by the sandbox); use `ctx.http.fetch(url, opts)` for network. Return the operation output object.',
        },
        operations: {
          type: 'array',
          description: 'Operation manifests including name and input/output schemas; listener operations may declare listener configuration.',
          items: { type: 'object' },
        },
        permissions: { type: 'array', items: { type: 'string' } },
        capabilityTags: { type: 'array', items: { type: 'string' } },
        allowedDomains: { type: 'array', items: { type: 'string' } },
        timeoutMs: { type: 'number' },
        listenerSourceOperation: { type: 'string', description: 'Operation that acts as a persistent listener source.' },
      },
      required: ['name', 'source', 'operations'],
    },
  },
  // ── Agentic Apps (AGENTIC-APPS-10X §4/§5) — chat-driven full-stack build. ──
  // Names match registry ids in agentisToolHandlers/appData.ts. data_*/ui_*
  // resolve the App from `appId` or the open App surface.
  {
    name: 'agentis.app.compile',
    description:
      '[APP PRE-EXECUTION GATE] Read-only compilation of the whole App before any costly/world-touching run. Defaults to compact blocker output. Apply compatible repairPlan.zeroCost items together and compile ONCE; never fix next[0] one model round at a time. Use target:"debug" before the first real debug run; target:"production" before live use; target:"unattended" before arming.',
    parameters: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'App id; omit when an App is open.' },
        target: { type: 'string', enum: ['debug', 'production', 'unattended'], description: 'Default debug.' },
        detail: { type: 'string', enum: ['summary', 'full'], description: 'Default summary; full includes passing checks.' },
      },
    },
  },
  {
    name: 'agentis.app.verify',
    description: 'Run free dry-runs and pinned suites for every enabled workflow in an App in ONE batched call, then compile once. Use instead of repeated workflow.dry_run/test calls.',
    parameters: { type: 'object', properties: { appId: { type: 'string' }, target: { type: 'string', enum: ['debug', 'production', 'unattended'] }, dryRun: { type: 'boolean' }, suites: { type: 'boolean' } } },
  },
  {
    name: 'agentis.app.doctor',
    description:
      'Read-only cross-layer conformance inspection for an App. Verifies executable dependencies, triggers, event subscriptions, outcome contracts, connection bindings, conversation state references, and whether orchestration shown in the UI is backed by persisted rules. Run before claiming an App works.',
    parameters: { type: 'object', properties: { appId: { type: 'string', description: 'App id; omit when an App is open.' } } },
  },
  {
    name: 'agentis.app.doctor.repair',
    description: 'Preview or apply only deterministic, intent-preserving Doctor repairs. Findings requiring business, workflow, credential, channel, or UI choices remain review_required. Omit confirm:true for preview.',
    parameters: {
      type: 'object',
      properties: { appId: { type: 'string' }, findingIds: { type: 'array', items: { type: 'string' } }, confirm: { type: 'boolean' } },
    },
  },
  {
    name: 'agentis.apps.conformance.migrate',
    description: 'Audit existing workspace Apps against current orchestration contracts and preview/apply deterministic safe migrations. Never invents missing business rules. Omit confirm:true for preview.',
    parameters: { type: 'object', properties: { appId: { type: 'string' }, confirm: { type: 'boolean' } } },
  },
  {
    name: 'agentis.app.create',
    description:
      'Create — or RESOLVE — an Agentic App, a full-stack product (UI + logic + memory + data) the agent operates for a human. ' +
      'Idempotent: if an App with this name already exists (or adoptWorkflowId is already owned by an App), it reuses that App instead of creating a duplicate — so to refine an existing App, edit it, do not make a renamed twin. ' +
      'Note build_workflow already creates the owning App, so a fresh build needs no app.create. Returns the appId (and reused:true when an existing App was resolved) to thread through the data and ui tools below.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human-facing app name.' },
        description: { type: 'string', description: 'One-line app description.' },
        adoptWorkflowId: { type: 'string', description: 'Existing workflow id to adopt as the App\'s logic. If it already has an owning App, that App is reused.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'agentis.app.scaffold',
    description:
      'Give an App its DATA + INTERFACE in one call — the fast path to a real product. Defines the datastore collections (the data format) AND authors a real, data-bound operator surface (ActivityStream + a board/table/form bound to those collections, create actions wired). ' +
      'Use this whenever the operator asks for an app with an interface — a CRM, dashboard, tracker, pipeline, board, portal, or console. An App with logic but no UI or data is incomplete. ' +
      'Surfaces render on the flagship Agentis design system (premium in light AND dark, TailAdmin-grade cards/tables/charts, auto-formatted values) — no styling work needed. ' +
      'Pass collections to define the data model and prompt to describe the interface (mention the vibe — e.g. "exec dashboard", "friendly CRM" — to steer the look). Best for standard data apps; for a bespoke, custom-designed surface, author a CodeSurface (real code, pixel-perfect) instead.',
    parameters: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'Target App id. Omit to use the App currently open.' },
        prompt: { type: 'string', description: 'What the interface should be, in plain language (e.g. "Lead CRM: pipeline board grouped by stage, an add-lead form, a total-pipeline-value metric").' },
        surface: { type: 'string', description: 'Surface name to author. Defaults to "home".' },
        collections: { type: 'array', description: 'Data format to define first: [{ name, schema: { fields: [{ key, type, required?, indexed? }] } }]. Omit to bind to the App\'s existing collections.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'agentis.data.define_collection',
    description:
      'Define (or update) a typed Datastore collection on an App. fields: [{ key, type: "string"|"number"|"boolean"|"date"|"json", required?, indexed? }].',
    parameters: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'Target App id (omit to use the open App).' },
        name: { type: 'string' },
        schema: { type: 'object', description: '{ fields: [...] }' },
      },
      required: ['name', 'schema'],
    },
  },
  {
    name: 'agentis.data.insert',
    description: 'Insert a record into an App collection (validated against its schema).',
    parameters: { type: 'object', properties: { appId: { type: 'string' }, collection: { type: 'string' }, record: { type: 'object' } }, required: ['collection', 'record'] },
  },
  {
    name: 'agentis.data.update',
    description: 'Patch an App collection record by id.',
    parameters: { type: 'object', properties: { appId: { type: 'string' }, collection: { type: 'string' }, id: { type: 'string' }, patch: { type: 'object' } }, required: ['collection', 'id', 'patch'] },
  },
  {
    name: 'agentis.data.upsert',
    description: 'Insert, or update the first record matching `match`.',
    parameters: { type: 'object', properties: { appId: { type: 'string' }, collection: { type: 'string' }, match: { type: 'object' }, record: { type: 'object' } }, required: ['collection', 'match', 'record'] },
  },
  {
    name: 'agentis.data.batch',
    description: 'Apply up to 200 datastore insert/update/upsert/delete operations in one ordered call. Use for migrations and multi-record repairs; never emit dozens of data.update calls.',
    parameters: { type: 'object', properties: { appId: { type: 'string' }, operations: { type: 'array', maxItems: 200, items: { type: 'object' } } }, required: ['operations'] },
  },
  {
    name: 'agentis.data.delete',
    description: 'Delete an App collection record by id.',
    parameters: { type: 'object', properties: { appId: { type: 'string' }, collection: { type: 'string' }, id: { type: 'string' } }, required: ['collection', 'id'] },
  },
  {
    name: 'agentis.data.query',
    description: 'Query App collection records. Filter ops: eq/ne/gt/gte/lt/lte/contains/in, or a bare value for equality.',
    parameters: { type: 'object', properties: { appId: { type: 'string' }, collection: { type: 'string' }, filter: { type: 'object' }, sort: { type: 'array' }, limit: { type: 'number' }, cursor: { type: 'string' } }, required: ['collection'] },
  },
  {
    name: 'agentis.data.promote_memory',
    description: 'Promote a Datastore record into the workspace Brain as a durable memory (one-way; data stays source of truth).',
    parameters: { type: 'object', properties: { appId: { type: 'string' }, collection: { type: 'string' }, id: { type: 'string' }, title: { type: 'string' } }, required: ['collection', 'id'] },
  },
  {
    name: 'agentis.ui.render',
    description:
      'Author an App surface as a typed ViewNode tree (Stack/Row/Grid/Split/Tabs/Hero/KPIStrip/Metric/Chart/Table/List/Kanban/RecordMaster/Roadmap/PipelineFlow/DataBoard/Funnel/Timeline/Form/Button/ActivityStream/OrchestrationPanel/RunMonitor/AgentFeed/ApprovalsInbox/ChatThread/Inbox/CodeSurface/CustomView…). '
      + 'TWO TIERS: typed nodes are the default for operable data apps (records, boards, live-ops, editable, data-bound); for a bespoke, pixel-perfect surface, emit a CodeSurface (real code in a sandbox, full-bleed, light+dark, custom-code policy required) instead of forcing the typed nodes. ' +
      'Start from a design brief: purpose, audience, information density, tone, and one memorable interaction or visual idea. Let the domain choose the composition; a Hero, KPI strip, operations panel, rail, or Form is optional rather than a universal recipe. Root style controls theme, density, appearance, accent, and design variant. Inspect the rendered desktop/mobile result and repair functional, console, network, accessibility, clipping, or binding failures before calling it ready. ' +
      'OPERABILITY CONTRACT (hard-gated: RENDERED ≠ OPERABLE): every action you declare MUST be reachable from a control — workflow actions on Hero.actions or a Button, "<col>.insert" behind a Form, "<col>.update" powering Kanban drag + the record drawer, "<col>.delete" as a Table rowAction. A Button/Form referencing an UNDECLARED action is stripped by the gate; a declared-but-unwired workflow action gets auto-wired into the header (and flagged) — author it operable the first time. Values format themselves (URLs→links, SCREAMING_SNAKE→humanized pills, ISO dates→relative): never hand-format. ' +
      'Pick the working composite for the data: Kanban (status/stage fields; give update:{action:"<declared col.update action>"} so drag writes back) · RecordMaster (CRM/ERP record workspaces w/ sections+related) · Roadmap (date fields → time lanes) · PipelineFlow (stage funnel + conversion) · Chart/Table (metrics/logs). ' +
      'The runtime wraps surfaces in an App Shell (sidebar pages + topbar + ops drawer): author page CONTENT, never navigation — each surface becomes a page, so real products = several focused surfaces (home, board, records, roadmap, inbox). ' +
      'Title/spacing/data-display rule: the App Shell already names the App/page, so never start content with a Hero or Heading that repeats the App name; name the job/state instead. Use the spacing rhythm only (8/12/16/20/24px), and never make whitespace with oversized gaps or blank spacer cards. Never show template expressions like "{{count:collection}}" in Metric/KPIStrip/Text; use real bound composites or a literal human-readable value. ' +
      'Table/List/Chart/Kanban/RecordMaster/Roadmap bind to a collection ({ bind: { collection, query?, sort?, limit? } }); Button/Form/Kanban-update reference an action declared with agentis.ui.action_schema.',
    parameters: { type: 'object', properties: { appId: { type: 'string' }, surface: { type: 'string' }, view: { type: 'object' } }, required: ['surface', 'view'] },
  },
  {
    name: 'agentis.ui.patch',
    description: 'Mutate part of an existing surface view. ops: [{ op: "set"|"insert"|"remove", path, value?|node? }].',
    parameters: { type: 'object', properties: { appId: { type: 'string' }, surface: { type: 'string' }, ops: { type: 'array' } }, required: ['surface', 'ops'] },
  },
  {
    name: 'agentis.ui.inspect',
    description: 'Inspect the persisted interface before editing. Compact by default: surfaces plus stable nodeId/type/path/collection outline and actions. Use includeTree:true only for exact property work; this avoids repeatedly loading giant surface trees.',
    parameters: { type: 'object', properties: { appId: { type: 'string' }, surface: { type: 'string' }, includeTree: { type: 'boolean' } } },
  },
  {
    name: 'agentis.ui.remove',
    description: 'Remove a component reliably by stable nodeId (from ui.inspect), or delete an entire surface with deleteSurface:true plus exact confirmSurfaceName. Re-validates and revisions component changes.',
    parameters: { type: 'object', properties: { appId: { type: 'string' }, surface: { type: 'string' }, nodeId: { type: 'string' }, deleteSurface: { type: 'boolean' }, confirmSurfaceName: { type: 'string' } }, required: ['surface'] },
  },
  {
    name: 'agentis.ui.action_schema',
    description: 'Declare a surface\'s actions. Each resolves to a workflow run, an agent tool, or a datastore op ("collection.insert"|"update"|"upsert"|"delete"). { name, kind, target, inputSchema? }. Declaring re-runs the operability gate: a declared workflow action that no control references gets auto-wired into the page header (RENDERED ≠ OPERABLE — an unreachable action cannot persist).',
    parameters: { type: 'object', properties: { appId: { type: 'string' }, surface: { type: 'string' }, actions: { type: 'array' } }, required: ['surface', 'actions'] },
  },
  {
    name: 'agentis.ui.lint',
    description: 'Lint a surface against the layout floor + operability gate WITHOUT persisting — the UI dry-run. Pass view (+ actions) to check a PROPOSED tree before ui.render, or just surface to audit the stored one. Returns operable + the exact fixes the gate would apply. Flow: author → lint → render.',
    parameters: { type: 'object', properties: { appId: { type: 'string' }, surface: { type: 'string' }, view: { type: 'object' }, actions: { type: 'array' } } },
  },
  {
    name: 'agentis.plan',
    description:
      'Break a complex goal into an ordered list of concrete, executable steps. Use this ' +
      'when the user presents a multi-part objective and you need to organize your approach ' +
      'before acting. Returns a numbered plan with each step described in plain language. ' +
      'Show the plan to the user and proceed step by step.',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'The goal or objective to plan for.',
        },
        context: {
          type: 'string',
          description: 'Any relevant context about current state, constraints, or available resources.',
        },
      },
      required: ['goal'],
    },
  },
  {
    name: 'agentis.evaluate',
    description:
      'Score an artifact, plan, or output against a set of criteria. Use this to assess ' +
      'quality, completeness, or correctness before presenting something to the user, or ' +
      'when the user asks you to review or rate something. Returns a score and reasoning.',
    parameters: {
      type: 'object',
      properties: {
        artifact: {
          type: 'string',
          description: 'The content to evaluate (text, JSON, plan, workflow description, etc.).',
        },
        criteria: {
          type: 'string',
          description: 'What to evaluate against. Examples: "correctness", "clarity", "completeness".',
        },
      },
      required: ['artifact', 'criteria'],
    },
  },
  {
    name: 'agentis.reflect',
    description:
      'Self-critique the current approach and suggest improvements or alternative strategies. ' +
      'Use this after completing a task that did not go as expected, when stuck in a loop, ' +
      'or when the user asks you to reconsider. Returns a critique and a recommended next action.',
    parameters: {
      type: 'object',
      properties: {
        situation: {
          type: 'string',
          description: 'What has happened so far and why you want to reflect.',
        },
        goal: {
          type: 'string',
          description: 'The original goal you were trying to accomplish.',
        },
      },
      required: ['situation', 'goal'],
    },
  },
  {
    name: 'agentis.canvas.context',
    description:
      'Read the operator\'s current Agentis viewport context and related resource state. Use this when the user asks about "this workflow", "this run", "the canvas", the selected agent, or anything visible on screen. Returns the active surface, resource id/kind, selected items, and relevant workflow/run/agent details when available.',
    parameters: {
      type: 'object',
      properties: {
        resourceId: {
          type: 'string',
          description: 'Optional explicit resource id to inspect. Defaults to the active viewport resource.',
        },
        resourceKind: {
          type: 'string',
          description: 'Optional resource kind. Examples: workflow, run, agent.',
          enum: ['workflow', 'run', 'agent', 'app', 'artifact', 'unknown'],
        },
      },
    },
  },

  // ─── Raw HTTP ────────────────────────────────────────────────────────────
  {
    name: 'http_fetch',
    description:
      'Make an HTTP request to an external URL. Use this when the user wants to fetch data ' +
      'from a website or API, check a URL, or retrieve content from the internet. ' +
      'Returns the response status, headers, and body. Respects workspace HTTP policy.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch. Must be http:// or https://.',
        },
        method: {
          type: 'string',
          description: 'HTTP method. Default GET.',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        },
        headers: {
          type: 'string',
          description: 'JSON object of request headers.',
        },
        body: {
          type: 'string',
          description: 'Request body (for POST/PUT/PATCH). Will be sent as JSON.',
        },
      },
      required: ['url'],
    },
  },
  // ─── Spaces ──────────────────────────────────────────────────────────────
  {
    name: 'agentis.space.summary',
    description:
      'Aggregate semantic outcomes (outputLabels) across all apps in a Space over a window. ' +
      'Use this when the user asks how a Space is performing, e.g. "how is sales doing this week?". ' +
      'Returns per-app counts of declared output labels (leads_qualified, meetings_booked, etc.), ' +
      'success rate, run totals, and pending approvals for the workspace.',
    parameters: {
      type: 'object',
      properties: {
        spaceId: {
          type: 'string',
          description: 'The ID of the Space to summarize.',
        },
        window: {
          type: 'string',
          description: 'Time window for the aggregate. Default "7d".',
          enum: ['24h', '7d', '30d'],
        },
      },
      required: ['spaceId'],
    },
  },

  // ─── Apps Output surface (APP-OUTPUT-REPLAN.md §10) ─────────────────────
  {
    name: 'agentis.apps.run_status',
    description:
      'Cross-app run status overview. Use at /chat when the operator asks "what are all my apps doing?" or wants a fleet view. Returns one row per installed app with current run status, last result summary, and 7-day run count. Different from agentis.apps.status (which checks gateway connectivity).',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'string',
          description: 'Maximum apps to return (default 50, max 200).',
        },
      },
    },
  },
  {
    name: 'agentis.app.thread.open',
    description:
      "Hand off the operator from /chat to a specific App Thread. Use when the operator's intent at /chat names or implies one specific app (e.g. 'reschedule the demo' → CRM app). The chat surface receives this tool result and navigates the operator to the App Thread, pre-filling the composer with the carried message. Does NOT mutate state — only signals navigation.",
    parameters: {
      type: 'object',
      properties: {
        appSlug: {
          type: 'string',
          description: 'Slug or id of the target installed app.',
        },
        carriedMessage: {
          type: 'string',
          description: "The operator's original message to pre-fill in the App Thread composer.",
        },
        reason: {
          type: 'string',
          description: 'Short explanation displayed at /chat before navigation.',
        },
      },
      required: ['appSlug'],
    },
  },
];

/** Quick lookup by tool name. */
export const CHAT_TOOL_CATALOG_MAP: Record<string, ToolDefinition> = Object.fromEntries(
  CHAT_TOOL_CATALOG.map((t) => [t.name, t]),
);

/**
 * Build the workspace-scoped tool catalog: the static base PLUS one discrete
 * tool per reusable workflow. Surfacing each reusable workflow as its own
 * named tool (`workflow.<id>`) lets the orchestrator invoke them directly with
 * typed parameters drawn from the workflow's inputContract — far more reliable
 * than asking the model to remember a workflowId and call agentis.workflow.run.
 *
 * The ChatToolExecutor rewrites `workflow.<id>` calls back to
 * agentis.workflow.run, so no new handler is needed.
 */
export interface ReusableWorkflowSummary {
  id: string;
  title: string;
  description?: string | null;
  inputContract?: {
    fields?: Array<{ key: string; type?: string; required?: boolean; description?: string }>;
  } | null;
}

export function buildWorkspaceToolCatalog(workflows: ReusableWorkflowSummary[]): ToolDefinition[] {
  const dynamic: ToolDefinition[] = [];
  for (const wf of workflows) {
    const fields = wf.inputContract?.fields ?? [];
    const properties: Record<string, { type: string; description?: string }> = {};
    const required: string[] = [];
    for (const f of fields) {
      const jsonType = f.type === 'number' ? 'number'
        : f.type === 'boolean' ? 'boolean'
        : f.type === 'array' ? 'array'
        : f.type === 'object' ? 'object'
        : 'string';
      properties[f.key] = { type: jsonType, ...(f.description ? { description: f.description } : {}) };
      if (f.required) required.push(f.key);
    }
    dynamic.push({
      name: `workflow.${wf.id}`,
      description:
        `Run the "${wf.title}" workflow.` +
        (wf.description ? ` ${wf.description}` : '') +
        ' Inputs map to the workflow trigger. Returns the runId so you can follow up with agentis.workflow.status.',
      parameters: {
        type: 'object',
        properties: fields.length > 0 ? properties : { inputs: { type: 'object', description: 'Free-form inputs for the workflow trigger.' } },
        ...(required.length > 0 ? { required } : {}),
      },
    });
  }
  return [...CHAT_TOOL_CATALOG, ...dynamic];
}
