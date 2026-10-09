/**
 * Realtime event names — V1-SPEC §12.
 *
 * The room set + event family are a closed enumeration. The dashboard's
 * `useRealtime()` hook uses these names directly; do not introduce magic
 * strings elsewhere.
 */

export const REALTIME_EVENTS = {
  // Workspace
  WORKSPACE_SELECTED: 'workspace.selected',
  AMBIENT_SELECTED: 'ambient.selected',
  CONVERSATION_TURN_CHANGES_UPDATED: 'conversation.turn_changes.updated',

  // Fleet overview
  FLEET_SNAPSHOT_UPDATED: 'fleet.snapshot.updated',

  // Gateway
  GATEWAY_CONNECTED: 'gateway.connected',
  GATEWAY_DEGRADED: 'gateway.degraded',
  GATEWAY_DISCONNECTED: 'gateway.disconnected',
  GATEWAY_EVENT: 'gateway.event',

  // Agents
  AGENT_CREATED: 'agent.created',
  AGENT_UPDATED: 'agent.updated',
  AGENT_DELETED: 'agent.deleted',
  AGENT_STATUS_CHANGED: 'agent.status.changed',
  AGENT_HEARTBEAT: 'agent.heartbeat',
  AGENT_WORK_STEP: 'agent.work.step',
  AGENT_WAKE_REQUESTED: 'agent.wake.requested',
  AGENT_PROACTIVE_PUSH: 'agent.proactive.push',

  // Durable Agent Missions
  MISSION_CREATED: 'mission.created',
  MISSION_UPDATED: 'mission.updated',
  MISSION_PROGRESS: 'mission.progress',
  MISSION_SETTLED: 'mission.settled',
  
  HARNESS_IMPORT_UPDATES: 'harness.import.updates',

  // Management layer
  GOAL_CREATED: 'goal.created',
  GOAL_UPDATED: 'goal.updated',
  ISSUE_CREATED: 'issue.created',
  ISSUE_UPDATED: 'issue.updated',
  ISSUE_DELETED: 'issue.deleted',
  ROUTINE_CREATED: 'routine.created',
  ROUTINE_UPDATED: 'routine.updated',
  BUDGET_EVENT_CREATED: 'budget.event.created',
  INBOX_UPDATED: 'inbox.updated',

  // Workflows
  WORKFLOW_CREATED: 'workflow.created',
  WORKFLOW_UPDATED: 'workflow.updated',
  WORKFLOW_DELETED: 'workflow.deleted',
  WORKFLOW_GRAPH_PATCHED: 'workflow.graph_patched',

  // Durable task spine
  TASK_SPINE_ACCEPTED: 'task.spine.accepted',
  TASK_SPINE_UPDATED: 'task.spine.updated',
  TASK_SPINE_BOUND: 'task.spine.bound',
  TASK_SPINE_VERIFYING: 'task.spine.verifying',
  TASK_SPINE_VERIFIED: 'task.spine.verified',
  TASK_SPINE_COMPLETED: 'task.spine.completed',
  TASK_SPINE_BLOCKED: 'task.spine.blocked',
  TASK_SPINE_FAILED: 'task.spine.failed',
  TASK_SPINE_DECISION_RECORDED: 'task.spine.decision_recorded',
  TASK_SPINE_DEVIATION_RECORDED: 'task.spine.deviation_recorded',
  TASK_SPINE_REDIRECTED: 'task.spine.redirected',

  // Runs
  RUN_CREATED: 'run.created',
  RUN_RUNNING: 'run.running',
  RUN_PAUSED: 'run.paused',
  RUN_CANCELLED: 'run.cancelled',
  RUN_COMPLETED: 'run.completed',
  /** Canonical dual-axis terminal signal. Consumers should prefer this. */
  RUN_SETTLED: 'run.settled',
  /** Definition-of-done checks passed against the world (stronger than completion). */
  RUN_ACCOMPLISHED: 'run.accomplished',
  RUN_FAILED: 'run.failed',
  RUN_RECOVERED: 'run.recovered',
  RUN_QUEUED: 'run.queued',
  RUN_DEQUEUED: 'run.dequeued',

  // Nodes
  NODE_STARTED: 'node.started',
  NODE_COMPLETED: 'node.completed',
  NODE_FAILED: 'node.failed',
  NODE_WAITING_FOR_INPUT: 'node.waiting_for_input',
  NODE_RETRY_SCHEDULED: 'node.retry_scheduled',
  NODE_CACHE_HIT: 'node.cache_hit',
  NODE_COMPRESS_STATS: 'node.compress_stats',
  NODE_SURGICAL_RETRY: 'node.surgical_retry',
  NODE_TEST_COMPLETED: 'node.test_completed',

  // Loop / phase progress
  LOOP_PROGRESS: 'loop.progress',
  PHASE_STARTED: 'phase.started',
  PHASE_COMPLETED: 'phase.completed',
  PHASE_FAILED: 'phase.failed',
  PHASE_SLA_BREACHED: 'phase.sla_breached',
  BUDGET_PHASE_EXCEEDED: 'budget.phase_exceeded',
  BUDGET_RUN_EXCEEDED: 'budget.run_exceeded',
  BUDGET_WORKSPACE_EXCEEDED: 'budget.workspace_exceeded',
  /** Builder Session §3/§9 — the cast specialist team, emitted before the graph streams. */
  WORKFLOW_TEAM_ROSTER: 'workflow.team_roster',

  // Contracts
  CONTRACT_VIOLATION: 'contract.violation',

  // Self-improvement
  INSTINCT_PROPOSED: 'instinct.proposed',

  // Persistent listener runtime
  LISTENER_CONNECTED: 'listener.connected',
  LISTENER_DISCONNECTED: 'listener.disconnected',
  LISTENER_EVENT_RECEIVED: 'listener.event.received',
  LISTENER_PREDICATE_PASS: 'listener.predicate.pass',
  LISTENER_PREDICATE_FAIL: 'listener.predicate.fail',
  LISTENER_FIRE_SUPPRESSED: 'listener.fire.suppressed',
  LISTENER_FIRED: 'listener.fired',
  LISTENER_ERROR: 'listener.error',

  // Scheduler / event chains
  SCHEDULE_FIRED: 'schedule.fired',
  EVENT_CHAIN_FIRED: 'event_chain.fired',
  WATCHDOG_TIMEOUT: 'watchdog.timeout',

  // Presence (ephemeral, never persisted)
  AGENT_PRESENCE_FOCUS: 'agent.presence.focus',
  AGENT_PRESENCE_BLUR: 'agent.presence.blur',
  AGENT_PRESENCE_THINKING: 'agent.presence.thinking',
  AGENT_TERMINAL_MESSAGE: 'agent.terminal.message',
  AGENT_TERMINAL_TOOL_CALL: 'agent.terminal.tool_call',
  AGENT_TASK_COMPLETED: 'agent.task.completed',
  /** Durable operator-private consultation lifecycle/message update. */
  AGENT_CONSULTATION_UPDATED: 'agent.consultation.updated',

  // Activity / approvals
  ACTIVITY_CREATED: 'activity.created',
  OBSERVABILITY_EVENT: 'observability.event',
  APPROVAL_REQUESTED: 'approval.requested',
  APPROVAL_RESOLVED: 'approval.resolved',

  // Artifacts
  ARTIFACT_CREATED: 'artifact.created',
  ARTIFACT_UPDATED: 'artifact.updated',
  ARTIFACT_DELETED: 'artifact.deleted',

  // AG-UI — Agentic App surfaces (AGENTIC-APPS-10X-MASTERPLAN §4)
  // SURFACE_RENDER: full ViewNode tree replaced. SURFACE_PATCH: fine-grained ops.
  SURFACE_RENDER: 'app.surface_render',
  SURFACE_PATCH: 'app.surface_patch',
  SURFACE_DELETED: 'app.surface_deleted',
  INTERFACE_CANDIDATE: 'app.interface_candidate',
  INTERFACE_VERIFIED: 'app.interface_verified',
  INTERFACE_PUBLISHED: 'app.interface_published',
  INTERFACE_ABANDONED: 'app.interface_abandoned',
  // App Datastore (§5) — a record changed; bound views refetch. { appId, collection, op, id }.
  DATA_CHANGED: 'app.data_changed',
  // App lifecycle — the App ENTITY or its workflow membership/binding changed
  // (created, renamed, archived, deleted, workflow adopted/reordered). Bound App
  // views + the workspace app list refetch. { appId, op }. Distinct from
  // DATA_CHANGED (which is a datastore RECORD change), so a view can react to
  // structural changes without conflating them with row edits.
  APP_CREATED: 'app.created',
  APP_UPDATED: 'app.updated',
  APP_DELETED: 'app.deleted',
  APP_BLUEPRINT_UPDATED: 'app.blueprint.updated',
  BUILD_SESSION_UPDATED: 'build.session.updated',

  // Live co-presence (LIVING-APPS-10X §6/G9) — EPHEMERAL, never persisted.
  //   broadcast on heartbeat + on join/leave. Payload: AppPresenceUpdate.
  // APP_AGENT_ACTIVITY: the resident agent's live thinking/typing on a thread
  //   while a turn runs, surfaced in the App console. Payload: AppAgentActivity.
  APP_PRESENCE_UPDATED: 'app.presence.updated',
  APP_AGENT_ACTIVITY: 'app.agent.activity',

  // Spaces
  SPACE_CREATED: 'space.created',
  SPACE_UPDATED: 'space.updated',
  SPACE_DELETED: 'space.deleted',

  // Teams

  // State surfaces
  SCRATCHPAD_WRITTEN: 'scratchpad.written',
  LEDGER_EVENT: 'ledger.event',
  COMMAND_INDEX_UPDATED: 'command.index.updated',

  // panel streams facts, channel messages, and claims live.
  // Payload: { runId, entry: BlackboardEntry }.
  BLACKBOARD_ENTRY: 'blackboard.entry',

  // Convergence loop (`converge` node) — one event per iteration so the
  // { runId, nodeId, iteration, verdict, continue, spend, stalled }.
  CONVERGE_ITERATION: 'converge.iteration',
  CONVERGE_SETTLED: 'converge.settled',

  // Skill registry
  SKILL_REGISTRY_INSTALLED: 'skill_registry.installed',

  // Conversation continuity
  CONVERSATION_MESSAGE_RECEIVED: 'conversation.message.received',
  CONVERSATION_MESSAGE_SENT: 'conversation.message.sent',
  CONVERSATION_MESSAGE_UPDATED: 'conversation.message.updated',
  CONVERSATION_MESSAGE_DELETED: 'conversation.message.deleted',
  CONVERSATION_AGENT_TYPING: 'conversation.agent.typing',
  CONVERSATION_SESSION_DISCOVERED: 'conversation.session.discovered',
  CONVERSATION_SESSION_SYNCED: 'conversation.session.synced',
  CONVERSATION_SESSION_STALE: 'conversation.session.stale',
  /** Conversation ownership moved between resident automation and a human operator. */
  CONVERSATION_HANDOFF_CHANGED: 'conversation.handoff.changed',
  // Queue-then-auto-continue composer: a message queued/discarded while a turn
  // was streaming, or dispatched into a fresh turn once the prior one ended.
  // Payload: { conversationId, agentId, item, action: 'added'|'dispatched'|'discarded' }.
  CONVERSATION_QUEUE_UPDATED: 'conversation.queue.updated',
  /** Sanitized, durable projection of one ordered conversation turn event. */
  CONVERSATION_TURN_EVENT: 'conversation.turn.event',

  // Channel bridge (Batch 4 / V1-SPEC §0.3 #24, §11)
  CHANNEL_MESSAGE_RECEIVED: 'channel.message.received',
  CHANNEL_MESSAGE_SENT: 'channel.message.sent',
  /** Provider delivery evidence changed (queued -> accepted -> delivered -> read). */
  CHANNEL_MESSAGE_STATUS: 'channel.message.status',
  CHANNEL_CONNECTION_STATUS: 'channel.connection.status',

  // Package library
  PACKAGE_INSTALLED: 'package.installed',

  // Rooms
  ROOM_CREATED: 'room.created',
  ROOM_UPDATED: 'room.updated',
  ROOM_DELETED: 'room.deleted',
  ROOM_MESSAGE_SENT: 'room.message.sent',
  ROOM_MESSAGE_RECEIVED: 'room.message.received',
  ROOM_MESSAGE_UPDATED: 'room.message.updated',
  ROOM_MESSAGE_DELETED: 'room.message.deleted',
  ROOM_AGENT_JOINED: 'room.agent.joined',
  ROOM_AGENT_LEFT: 'room.agent.left',

  // Canvas narration
  CANVAS_NODE_PLACED: 'canvas.node.placed',
  CANVAS_EDGE_CONNECTED: 'canvas.edge.connected',
  CANVAS_BUILD_COMPLETE: 'canvas.build.complete',

  // Workflow creation pipeline — inspectable phase narration (analyzing →
  // planning → drafting → repairing → reviewing → building → complete) plus
  // each repair action and reviewer critique, so the chat can show a live,
  // fully-inspectable build timeline. (10X-CREATION-SWARM-PLAN §6.)
  WORKFLOW_BUILD_PHASE: 'workflow.build.phase',
  WORKFLOW_BUILD_REPAIR: 'workflow.build.repair',
  WORKFLOW_BUILD_CRITIQUE: 'workflow.build.critique',

  // Brain
  BRAIN_ATOM_CREATED: 'brain.atom.created',
  BRAIN_ATOM_REINFORCED: 'brain.atom.reinforced',
  BRAIN_DISPUTE_FLAGGED: 'brain.dispute.flagged',
  BRAIN_DISPUTE_RESOLVED: 'brain.dispute.resolved',
  BRAIN_DISPUTE_AUTO_RESOLVED: 'brain.dispute.auto_resolved',
  BRAIN_MAINTENANCE_COMPLETED: 'brain.maintenance.completed',
  BRAIN_CONFIG_DEGRADED: 'brain.config.degraded',
  BRAIN_EMBEDDING_MIGRATION_STARTED: 'brain.embedding.migration_started',
  BRAIN_EMBEDDING_MIGRATION_COMPLETED: 'brain.embedding.migration_completed',
  BRAIN_LINK_CREATED: 'brain.link.created',
  BRAIN_CONTEXT_INJECTED: 'brain.context.injected',
  BRAIN_DISCOURSE_SYNTHESIZED: 'brain.discourse.synthesized',
  BRAIN_PEER_UPDATED: 'brain.peer.updated',
  BRAIN_DREAM_PASS_COMPLETED: 'brain.dream_pass.completed',
  BRAIN_BELIEF_CONTRADICTION: 'brain.belief.contradiction',
  BRAIN_REFRESH_TRIGGERED: 'brain.refresh.triggered',
} as const;

export type RealtimeEventName = (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS];

export const REALTIME_ROOMS = {
  user: (userId: string) => `user:${userId}`,
  workspace: (workspaceId: string) => `workspace:${workspaceId}`,
  workflow: (workflowId: string) => `workflow:${workflowId}`,
  /** Agentic App room — surface renders/patches + datastore changes. */
  app: (appId: string) => `app:${appId}`,
  run: (runId: string) => `run:${runId}`,
  gateway: (gatewayId: string) => `gateway:${gatewayId}`,
  agent: (agentId: string) => `agent:${agentId}`,
  mission: (missionId: string) => `mission:${missionId}`,
  conversation: (agentId: string) => `conversation:${agentId}`,
  room: (roomId: string) => `room:${roomId}`,
} as const;

export interface RealtimeEnvelope<TName extends RealtimeEventName = RealtimeEventName> {
  event: TName;
  payload: unknown;
  /** ISO-8601 server timestamp the event was emitted at. */
  emittedAt: string;
  /** Optional correlation id for tracing client → server → adapter chains. */
  correlationId?: string;
}

// ── Live co-presence payloads (LIVING-APPS-10X §6/G9 · ephemeral) ──────────────


export interface AppPresenceViewer {
  
  userId: string;
  /** Human-readable label for the presence row. */
  name: string;
  /** The thread the viewer currently has open, if any. */
  conversationId?: string | null;
  /** ISO-8601 of the last heartbeat — the client can dim stale rows. */
  at: string;
}

/** The full live roster for an App, re-broadcast on every change. Ephemeral. */
export interface AppPresenceUpdate {
  appId: string;
  viewers: AppPresenceViewer[];
}

/**
 * The resident agent's live activity on a thread while a turn runs, surfaced in
 * the App console (G9 — "agent is thinking…"). Ephemeral; `state:'idle'` clears.
 */
export interface AppAgentActivity {
  appId: string;
  conversationId: string;
  agentId?: string;
  /** thinking → the agent is reasoning; typing → composing a reply; idle → done. */
  state: 'thinking' | 'typing' | 'idle';
  /** A short, calm label for the indicator line (e.g. a clipped reasoning snippet). */
  label?: string;
  at: string;
}



