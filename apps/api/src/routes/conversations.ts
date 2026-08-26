/**
 * /v1/conversations — operator-agent threads.
 *
 *   GET  /                                 list of threads
 *   GET  /:agentId                         messages for a thread (creates thread on demand)
 *   POST /:agentId/send                    operator → agent
/**
 * /v1/conversations — operator-agent threads.
 *
 *   GET  /                                 list of threads
 *   GET  /:agentId                         messages for a thread (creates thread on demand)
 *   POST /:agentId/send                    operator → agent
 *   POST /:agentId/continue/:sessionId     bind thread to a mirrored session id
 *   POST /:agentId/read                    clear unread badge
 */

import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  AgentisError,
  CONSTANTS,
  initialTurnActivityLabel,
  normalizeAgentPlanText,
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  type ChatDelta,
  type ChatContextManifest,
  type ChatExecutionEnvelope,
  type ChatFinishReason,
  type ChatPermissionMode,
  type ApprovalSensitivity,
  type ChatTurnContext,
  type ChatTurnTrace,
  type ConversationExecutionMode,
  type EffectiveConversationExecutionMode,
  type ViewportContext,
  type WorkspaceContext,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { ConversationStore } from '../services/conversation/conversationStore.js';
import { parseModeCommand, MODE_SWITCH_ACK, defaultTaskForMode, PLAN_MODE_SYSTEM_ADDENDUM } from '../services/chat/chatPermissionMode.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import { OpenClawAdapter } from '../adapters/OpenClawAdapter.js';
import { ChatSessionExecutor } from '../services/chat/chatSessionExecutor.js';
import { publishAgentWorkStep, publishChatDeltaProgress } from '../services/agent/agentWorkProgress.js';
import type { ViewportStore } from '../services/viewportStore.js';
import type { Logger } from '../logger.js';
import type { AuditTrailService } from '../services/auditTrail.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import type { EventBus } from '../event-bus.js';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import { serializeConversationMessage, serializeQueueItem, delay, workflowIdFromViewport, serializeScopeAgent, isAdapterErrorDelta, createStreamedChatMetadata, finalizeTurnTrace, relevantTurnError, captureChatDeltaMetadata, buildPersistedChatMetadata, workflowBuildMetadataFromResult } from '../services/conversation/conversationTurnHelpers.js';
import type { AgentRow, StreamedChatMetadata } from '../services/conversation/conversationTurnHelpers.js';
import { collectAppDoctorSnapshot } from '../services/app/appDoctorSnapshot.js';
import { validateAppConformance, type AppDoctorReport } from '../services/app/appDoctor.js';
import { proofReceiptsFromExperience, type ConversationTurnExperience, type ConversationTurnLeaseRegistry } from '../services/conversation/conversationTurnLease.js';
import type { PlanService } from '../services/planService.js';
import { ArtifactService } from '../services/artifactService.js';
import { DocumentExtractionService } from '../services/documentExtractionService.js';
import type { VisionService } from '../services/visionService.js';
import type { TranscriptionService } from '../services/transcriptionService.js';
import type { RuntimeProfileService } from '../services/runtime/runtimeProfileService.js';
import type { ConversationHandoffService } from '../services/conversation/conversationHandoffService.js';
import type { TurnChangeJournal } from '../services/conversation/turnChangeJournal.js';
import type { AgentConsultationService } from '../services/agent/agentConsultationService.js';
import { channelModelRole } from '../services/conversation/channelConversationRole.js';
import { ConversationAttachmentContextService } from '../services/conversation/conversationAttachmentContext.js';
import {
  ConversationTurnService,
  classifyConversationExecutionMode,
  type ConversationTurnRow,
  type DurableTurnEventSink,
} from '../services/conversation/conversationTurnService.js';

const sendSchema = z.object({
  body: z.string().min(1).max(CONSTANTS.CONVERSATION_MESSAGE_MAX_LENGTH),
  clientTurnId: z.string().min(1).max(120).optional(),
  useViewportContext: z.boolean().optional().default(true),
  /** Composer file/photo uploads — artifact ids from `POST /v1/artifacts/upload`. */
  attachments: z.array(z.string().min(1)).max(10).optional(),
  /** Composer toggle: persist the sticky permission mode alongside this turn. */
  permissionMode: z.enum(['ask', 'plan', 'auto']).optional(),
  /** Optional programmatic control; normal users may also ask the agent in chat. */
  approvalSensitivity: z.enum(['cautious', 'balanced', 'autonomous']).optional(),
  /** Adaptive quality/durability mode. */
  executionMode: z.enum(['auto', 'quick', 'deep', 'mission']).optional().default('auto'),
  viewportOverride: z.object({
    surface: z.string().min(1),
    route: z.string().optional(),
    title: z.string().optional(),
    workspaceId: z.string().optional(),
    ambientId: z.string().nullable().optional(),
    resourceId: z.string().optional(),
    resourceKind: z.string().optional(),
    spaceId: z.string().nullable().optional(),
    spaceName: z.string().nullable().optional(),
    selection: z.object({
      ids: z.array(z.string()).optional(),
      label: z.string().optional(),
      kind: z.string().optional(),
    }).nullable().optional(),
    activeRunId: z.string().nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
  }).nullable().optional(),
});
const confirmSchema = z.object({
  turnId: z.string().uuid(),
  confirmed: z.boolean(),
  clientTurnId: z.string().min(1).max(120).optional(),
});
const editSchema = z.object({ text: z.string().min(1).max(CONSTANTS.CONVERSATION_MESSAGE_MAX_LENGTH) });
const rewriteSchema = sendSchema.omit({ body: true }).extend({
  text: z.string().min(1).max(CONSTANTS.CONVERSATION_MESSAGE_MAX_LENGTH),
});
const swarmSteerSchema = z.object({ instruction: z.string().min(1).max(2_000) });
const turnChangeActionSchema = z.object({
  expectedVersion: z.number().int().positive(),
  confirmSensitive: z.boolean().optional().default(false),
});
type ConversationRouteDeps = {
  db: AgentisSqliteDb;
  auth: AuthService;
  conversations: ConversationStore;
  adapters: AdapterManager;
  logger: Logger;
  viewportStore?: ViewportStore;
  bus: EventBus;
  /** Required in production so "stop all" also terminates runs born from chat. */
  engine?: Pick<WorkflowEngine, 'cancelRun'>;
  /** Shared with MCP routes so Stop revokes late harness tool calls. */
  turnLeases?: ConversationTurnLeaseRegistry;
  /** Durable, runtime-neutral efficiency evidence for interactive turns. */
  audit?: Pick<AuditTrailService, 'record'>;
  plans?: PlanService;
  artifacts?: ArtifactService;
  documents?: DocumentExtractionService;
  vision?: VisionService;
  transcription?: TranscriptionService;
  runtimeProfiles?: RuntimeProfileService;
  handoffs?: ConversationHandoffService;
  consultations?: AgentConsultationService;
  turnChanges?: TurnChangeJournal;
  memoryCapture?: {
    captureImmediateCorrection?(args: {
      workspaceId: string;
      conversationId: string;
      userId: string;
      agentId: string;
      userDisplayName?: string | null;
      userMessage: string;
      activeWorkflowId?: string | null;
      activeNodeId?: string | null;
    }): string | null;
    captureTurn(args: {
      workspaceId: string;
      conversationId: string;
      userId: string;
      agentId: string;
      userDisplayName?: string | null;
      userMessage: string;
      assistantMessage?: string | null;
      finishReason?: string | null;
      activeWorkflowId?: string | null;
      activeNodeId?: string | null;
      experience?: ConversationTurnExperience | null;
    }): Promise<{
      peerUpdateJobIds: string[];
      promotedSessionMoments: number;
      workspaceMemoryIds: string[];
      experienceJobIds: string[];
      sessionMomentId: string | null;
      /** Learnings queued through the PRIMARY formation path (judge dedupes). */
      signals: number;
    }>;
  };
};

type ConversationRow = typeof schema.conversations.$inferSelect;






/**
 * Queue-then-auto-continue mid-turn composer — module-level guard tracking
 * which conversations currently have a turn actively streaming
 * (ChatSessionExecutor.turn in flight via `streamConversationTurnReply`). A
 * `sendConversationMessage` call that lands while its conversationId is in
 * this set is durably queued (conversation_message_queue) instead of racing
 * a second live turn; `streamConversationTurnReply` releases the guard and
 * auto-dispatches the oldest queued message once its own stream ends. Mirrors
 * the in-repo shape of `ChatSessionExecutor#pendingConfirmations` (a static
 * Map keyed by an id, cleared explicitly on completion).
 */
const activeConversationTurns = new Map<string, AbortController>();
const hardStoppedConversations = new Set<string>();

export function buildConversationRoutes(deps: ConversationRouteDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));
  const documents = deps.documents ?? new DocumentExtractionService({ logger: deps.logger });
  const artifacts = deps.artifacts ?? new ArtifactService(deps.db, deps.logger, deps.bus);
  const attachmentContext = new ConversationAttachmentContextService({
    artifacts,
    documents,
    logger: deps.logger,
    ...(deps.vision ? { vision: deps.vision } : {}),
    ...(deps.transcription ? { transcription: deps.transcription } : {}),
  });
  const durableTurns = new ConversationTurnService({
    db: deps.db,
    logger: deps.logger,
    bus: deps.bus,
    execute: (turn, sink, signal) => executeDurableConversationTurn(deps, turn, sink, signal),
    onCancel: async (turn) => {
      // The durable worker owns this controller, not the SSE reader. Abort it
      // explicitly as well as the service-owned controller so a Stop always
      // reaches the active model loop even after the browser has disconnected.
      activeConversationTurns.get(turn.conversationId)?.abort(new Error('operator_cancel'));
      deps.consultations?.cancelByParentTurn(turn.workspaceId, turn.id);
      await ChatSessionExecutor.chatSwarms()?.stopForConversation(turn.workspaceId, turn.conversationId);
      deps.turnLeases?.revoke(turn.workspaceId, turn.conversationId);
      if (!deps.engine) return;
      const runs = deps.db.select({ id: schema.workflowRuns.id }).from(schema.workflowRuns).where(and(
        eq(schema.workflowRuns.workspaceId, turn.workspaceId),
        eq(schema.workflowRuns.conversationId, turn.conversationId),
        inArray(schema.workflowRuns.status, ['CREATED', 'PLANNING', 'RUNNING', 'WAITING', 'PAUSED']),
      )).all();
      await Promise.allSettled(runs.map((run) => deps.engine!.cancelRun(run.id)));
    },
    onSettled: (turn) => { deps.turnChanges?.seal(turn.workspaceId, turn.id); },
  });
  deps.consultations?.bindParentTurnResume((turnId) => durableTurns.resumeAfterApproval(turnId));

  // Chat-native temporary-team recovery and controls. The state comes from the
  // same durable records that stream into the turn ledger, so refresh does not
  // turn a live team into an unreadable orphan.
  app.get('/:agentId/swarms/:swarmId', async (c) => {
    const ws = getWorkspace(c);
    const swarm = await ChatSessionExecutor.chatSwarms()?.get(ws.workspaceId, c.req.param('swarmId'));
    if (!swarm) return c.json({ error: 'Chat swarm service is unavailable.' }, 503);
    return c.json(swarm);
  });
  app.post('/:agentId/swarms/:swarmId/pause', async (c) => swarmControl(c, 'pause'));
  app.post('/:agentId/swarms/:swarmId/resume', async (c) => swarmControl(c, 'resume'));
  app.post('/:agentId/swarms/:swarmId/stop', async (c) => swarmControl(c, 'stop'));
  app.post('/:agentId/swarms/:swarmId/workers/:workerId/stop', async (c) => {
    const ws = getWorkspace(c);
    const service = ChatSessionExecutor.chatSwarms();
    if (!service) return c.json({ error: 'Chat swarm service is unavailable.' }, 503);
    try { return c.json(await service.stopWorker(ws.workspaceId, c.req.param('swarmId'), c.req.param('workerId'))); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Unable to stop worker.' }, 400); }
  });
  app.post('/:agentId/swarms/:swarmId/workers/:workerId/retry', async (c) => {
    const ws = getWorkspace(c);
    const service = ChatSessionExecutor.chatSwarms();
    if (!service) return c.json({ error: 'Chat swarm service is unavailable.' }, 503);
    try { return c.json(await service.retryWorker(ws.workspaceId, c.req.param('swarmId'), c.req.param('workerId'))); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Unable to retry worker.' }, 400); }
  });
  app.post('/:agentId/swarms/:swarmId/steer', async (c) => {
    const ws = getWorkspace(c);
    const parsed = swarmSteerSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'A short lead instruction is required.' }, 400);
    const service = ChatSessionExecutor.chatSwarms();
    if (!service) return c.json({ error: 'Chat swarm service is unavailable.' }, 503);
    try { return c.json(await service.steer(ws.workspaceId, c.req.param('swarmId'), parsed.data.instruction)); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Unable to steer lead.' }, 400); }
  });
  queueMicrotask(() => durableTurns.recover());

  app.get('/orchestrator', (c) => {
    const ws = getWorkspace(c);
    const orchestrator = findWorkspaceOrchestrator(deps.db, ws.workspaceId);
    if (!orchestrator) {
      throw new AgentisError('RESOURCE_NOT_FOUND', 'workspace orchestrator not found');
    }

    const conversationId = c.req.query('conversationId') || null;
    const conversation = conversationId
      ? deps.conversations.getById(ws.workspaceId, conversationId)
      : deps.conversations.getOrCreateByAgent({
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          agentId: orchestrator.id,
        });
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? CONSTANTS.CONVERSATION_HISTORY_PAGE_SIZE), 1), 200);
    const before = c.req.query('before') ?? null;
    const beforeId = c.req.query('beforeId') ?? null;
    return c.json({
      agent: serializeScopeAgent(orchestrator),
      conversation,
      messages: serializeConversationMessagesWithChanges(
        deps,
        ws.workspaceId,
        conversation.id,
        deps.conversations.messages(conversation.id, limit, before, beforeId),
      ),
    });
  });

  app.post('/orchestrator/send', async (c) => {
    const ws = getWorkspace(c);
    const orchestrator = findWorkspaceOrchestrator(deps.db, ws.workspaceId);
    if (!orchestrator) {
      throw new AgentisError('RESOURCE_NOT_FOUND', 'workspace orchestrator not found');
    }
    return sendConversationMessage(c, deps, ws, orchestrator.id, attachmentContext);
  });

  app.post('/orchestrator/confirm', async (c) => {
    const ws = getWorkspace(c);
    const orchestrator = findWorkspaceOrchestrator(deps.db, ws.workspaceId);
    if (!orchestrator) {
      throw new AgentisError('RESOURCE_NOT_FOUND', 'workspace orchestrator not found');
    }
    return confirmConversationAction(c, deps, ws, orchestrator.id, durableTurns);
  });

  app.post('/orchestrator/read', (c) => {
    const ws = getWorkspace(c);
    const orchestrator = findWorkspaceOrchestrator(deps.db, ws.workspaceId);
    if (!orchestrator) {
      throw new AgentisError('RESOURCE_NOT_FOUND', 'workspace orchestrator not found');
    }
    const conversationId = c.req.query('conversationId') || null;
    const conversation = conversationId
      ? deps.conversations.getById(ws.workspaceId, conversationId)
      : deps.conversations.getOrCreateByAgent({
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          agentId: orchestrator.id,
        });
    deps.conversations.markRead(ws.workspaceId, conversation.id);
    return c.json({ ok: true, agent: serializeScopeAgent(orchestrator) });
  });

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.conversations.list(ws.workspaceId, { includeArchived: true });
    const agentRows = deps.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, ws.workspaceId))
      .all();
    const byId = new Map(agentRows.map((a) => [a.id, a]));
    const channelRows = deps.db
      .select({
        id: schema.channelConnections.id,
        kind: schema.channelConnections.kind,
        name: schema.channelConnections.name,
      })
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.workspaceId, ws.workspaceId))
      .all();
    const channelsById = new Map(channelRows.map((channel) => [channel.id, channel]));
    const enriched = rows.map((r) => {
      const a = byId.get(r.agentId);
      const channel = r.channelConnectionId ? channelsById.get(r.channelConnectionId) : null;
      const last = deps.conversations.messages(r.id, 1).at(-1);
      return {
        id: r.id,
        agentId: r.agentId,
        agentName: a?.name ?? r.agentId.slice(0, 8),
        agentColor: a?.colorHex ?? '#7a8390',
        agentStatus: a?.status ?? 'offline',
        unread: r.unreadCount,
        title: r.title,
        archivedAt: r.archivedAt,
        lastMessageAt: r.lastMessageAt,
        lastMessagePreview: last ? last.body.slice(0, 80) : null,
        mirroredSessionId: r.mirroredSessionId,
        channelConnectionId: r.channelConnectionId,
        channelChatId: r.channelChatId,
        channelKind: channel?.kind ?? null,
        channelName: channel?.name ?? null,
        handoffState: r.handoffState === 'human' ? 'human' : 'agent',
        handoffSource: r.handoffSource ?? null,
        handoffClaimedAt: r.handoffClaimedAt ?? null,
        automationEpoch: r.automationEpoch ?? 0,
        createdAt: r.createdAt,
      };
    });
    return c.json({ conversations: enriched });
  });

  app.patch('/:conversationId/handoff', async (c) => {
    const ws = getWorkspace(c);
    if (!deps.handoffs) throw new AgentisError('INTERNAL_ERROR', 'conversation handoff service is unavailable');
    const input = z.object({ state: z.enum(['human', 'agent']) }).parse(await c.req.json());
    const conversationId = c.req.param('conversationId');
    const snapshot = input.state === 'human'
      ? deps.handoffs.claimHuman({ workspaceId: ws.workspaceId, conversationId, source: 'explicit' })
      : deps.handoffs.releaseToAgent(ws.workspaceId, conversationId);
    return c.json({
      conversationId: snapshot.conversationId,
      state: snapshot.state,
      source: snapshot.source,
      claimedAt: snapshot.claimedAt,
      automationEpoch: snapshot.automationEpoch,
    });
  });

  app.get('/:agentId', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const conversationId = c.req.query('conversationId') ?? null;
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversation = conversationId
      ? deps.conversations.getById(ws.workspaceId, conversationId)
      : deps.conversations.getOrCreateByAgent({
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          agentId,
        });
    if (conversation.agentId !== agentId) throw new AgentisError('RESOURCE_NOT_FOUND', 'conversation not found for agent');
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? CONSTANTS.CONVERSATION_HISTORY_PAGE_SIZE), 1), 200);
    const before = c.req.query('before') ?? null;
    const beforeId = c.req.query('beforeId') ?? null;
    return c.json({
      conversation,
      messages: serializeConversationMessagesWithChanges(
        deps,
        ws.workspaceId,
        conversation.id,
        deps.conversations.messages(conversation.id, limit, before, beforeId),
      ),
    });
  });

  app.post('/:agentId/send', async (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    return sendConversationMessage(c, deps, ws, agentId, attachmentContext);
  });

  /** Chat V2: persist first, execute independently, subscribe by replay cursor. */
  app.post('/:agentId/turns', async (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const agent = deps.db.select().from(schema.agents).where(and(
      eq(schema.agents.id, agentId),
      eq(schema.agents.workspaceId, ws.workspaceId),
    )).get();
    if (!agent) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const body = sendSchema.parse(await c.req.json());
    const clientTurnId = body.clientTurnId ?? randomUUID();
    const requestedMode = body.executionMode as ConversationExecutionMode;
    const conversationId = c.req.query('conversationId') || null;
    const conversation = conversationId
      ? deps.conversations.getById(ws.workspaceId, conversationId)
      : deps.conversations.getOrCreateByAgent({
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          agentId,
        });
    if (conversation.agentId !== agentId) throw new AgentisError('RESOURCE_NOT_FOUND', 'conversation not found for agent');

    // Resolve slash mode before compiling or classifying the turn. Previously
    // `/plan` was parsed only inside the runtime, after a Full Access build
    // request had already created a Mission plan and acceptance gate.
    const modeCommand = parseModeCommand(body.body);
    const runtimeBody = modeCommand?.rest || (modeCommand ? defaultTaskForMode(modeCommand.mode) : body.body);
    const permissionMode = modeCommand?.mode
      ?? body.permissionMode
      ?? (conversation.permissionMode as ChatPermissionMode | null)
      ?? 'ask';
    const approvalSensitivity = body.approvalSensitivity
      ?? (conversation.approvalSensitivity as ApprovalSensitivity | null)
      ?? 'balanced';
    if (permissionMode !== conversation.permissionMode || approvalSensitivity !== conversation.approvalSensitivity) {
      deps.db.update(schema.conversations).set({
        permissionMode,
        approvalSensitivity,
        executionMode: permissionMode === 'plan' ? 'plan' : 'chat',
        updatedAt: new Date().toISOString(),
      }).where(eq(schema.conversations.id, conversation.id)).run();
    }
    captureImmediateConversationCorrection(deps, ws, {
      agentId,
      conversationId: conversation.id,
      userMessage: body.body,
      useViewportContext: body.useViewportContext,
      viewportOverride: body.viewportOverride as ViewportContext | null | undefined,
    });

    const message = deps.conversations.appendOutbound({
      workspaceId: ws.workspaceId,
      conversationId: conversation.id,
      operatorId: ws.user.id,
      body: body.body,
      metadata: body.attachments?.length
        ? { clientTurnId, artifactIds: body.attachments, executionMode: requestedMode }
        : { clientTurnId, executionMode: requestedMode },
    });
    const compiled = await attachmentContext.compile({
      workspaceId: ws.workspaceId,
      body: runtimeBody,
      attachmentIds: body.attachments,
      historyMessages: conversationHistoryForTurn(deps, conversation.id, message.id).length,
    });
    const previousTurn = deps.db.select({ effectiveMode: schema.conversationTurns.effectiveMode })
      .from(schema.conversationTurns)
      .where(and(
        eq(schema.conversationTurns.workspaceId, ws.workspaceId),
        eq(schema.conversationTurns.conversationId, conversation.id),
      ))
      .orderBy(desc(schema.conversationTurns.createdAt))
      .get();
    const activeBuildSession = deps.db.select({ status: schema.buildSessions.status })
      .from(schema.buildSessions)
      .where(and(
        eq(schema.buildSessions.workspaceId, ws.workspaceId),
        eq(schema.buildSessions.conversationId, conversation.id),
      ))
      .orderBy(desc(schema.buildSessions.updatedAt))
      .get();
    const classified = classifyConversationExecutionMode(requestedMode, {
      body: runtimeBody,
      attachmentCount: body.attachments?.length ?? 0,
      permissionMode,
      previousMode: previousTurn?.effectiveMode as EffectiveConversationExecutionMode | undefined,
      hasActiveBuildSession: Boolean(activeBuildSession && !['completed', 'failed'].includes(activeBuildSession.status)),
    });
    const envelope = await buildChatExecutionEnvelope(deps, agent, requestedMode, classified.mode, classified.reason);
    const activeViewport = body.useViewportContext
      ? (body.viewportOverride as ViewportContext | null | undefined) ?? deps.viewportStore?.get(ws.user.id) ?? null
      : (body.viewportOverride as ViewportContext | null | undefined) ?? null;
    const plan = classified.mode === 'mission' && deps.plans
      ? deps.plans.createTask({
          workspaceId: ws.workspaceId,
          userId: ws.user.id,
          objective: runtimeBody,
          conversationId: conversation.id,
          ownerAgentId: agentId,
          title: missionTitle(runtimeBody),
          acceptanceCriteria: ['All requested deliverables are persisted.', 'Verification passes before completion.', 'The final response cites concrete evidence.'],
        })
      : null;
    if (plan) deps.plans?.setStatus(ws.workspaceId, ws.user.id, plan.id, 'executing');

    const turn = durableTurns.enqueue({
      workspaceId: ws.workspaceId,
      conversationId: conversation.id,
      agentId,
      userId: ws.user.id,
      messageId: message.id,
      clientTurnId,
      prompt: compiled.prompt,
      requestedMode,
      effectiveMode: classified.mode,
      permissionMode,
      attachmentIds: body.attachments ?? [],
      viewport: activeViewport,
      contextManifest: compiled.manifest,
      executionEnvelope: envelope,
      planId: plan?.id ?? null,
    });
    const queuePosition = durableTurns.queuePosition(ws.workspaceId, turn.id);
    return c.json({
      turn: serializeDurableTurn(turn, deps.turnChanges),
      conversationId: conversation.id,
      message,
      queuePosition,
      queued: queuePosition > 0,
    }, 202);
  });

  app.get('/:agentId/turns/active', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const conversationId = c.req.query('conversationId');
    if (!conversationId) throw new AgentisError('VALIDATION_FAILED', 'conversationId is required');
    const conversation = deps.conversations.getById(ws.workspaceId, conversationId);
    if (conversation.agentId !== agentId) throw new AgentisError('RESOURCE_NOT_FOUND', 'conversation not found for agent');
    return c.json({ turns: durableTurns.listActive(ws.workspaceId, conversationId).map((turn) => serializeDurableTurn(turn, deps.turnChanges)) });
  });

  app.get('/:agentId/turns', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const conversationId = c.req.query('conversationId');
    if (!conversationId) throw new AgentisError('VALIDATION_FAILED', 'conversationId is required');
    const conversation = deps.conversations.getById(ws.workspaceId, conversationId);
    if (conversation.agentId !== agentId) throw new AgentisError('RESOURCE_NOT_FOUND', 'conversation not found for agent');
    const requestedLimit = Number(c.req.query('limit') ?? 50);
    const limit = Number.isFinite(requestedLimit) ? requestedLimit : 50;
    return c.json({
      history: durableTurns.history(ws.workspaceId, conversationId, limit).map(({ turn, events }) => ({
        turn: serializeDurableTurn(turn, deps.turnChanges),
        events,
      })),
    });
  });

  app.get('/:agentId/turns/:turnId', (c) => {
    const ws = getWorkspace(c);
    const turn = durableTurns.require(ws.workspaceId, c.req.param('turnId'));
    if (turn.agentId !== c.req.param('agentId')) throw new AgentisError('RESOURCE_NOT_FOUND', 'conversation turn not found');
    return c.json({ turn: serializeDurableTurn(turn, deps.turnChanges) });
  });

  app.get('/:agentId/turns/:turnId/changes', (c) => {
    const ws = getWorkspace(c);
    const turn = durableTurns.require(ws.workspaceId, c.req.param('turnId'));
    if (turn.agentId !== c.req.param('agentId')) throw new AgentisError('RESOURCE_NOT_FOUND', 'conversation turn not found');
    return c.json({ changeSet: deps.turnChanges?.summary(ws.workspaceId, turn.id) ?? null });
  });

  app.post('/:agentId/turns/:turnId/undo', async (c) => {
    const ws = getWorkspace(c);
    const turn = durableTurns.require(ws.workspaceId, c.req.param('turnId'));
    if (turn.agentId !== c.req.param('agentId')) throw new AgentisError('RESOURCE_NOT_FOUND', 'conversation turn not found');
    if (!deps.turnChanges) throw new AgentisError('RESOURCE_NOT_FOUND', 'Turn restoration is unavailable.');
    const body = turnChangeActionSchema.parse(await c.req.json().catch(() => ({})));
    const result = deps.turnChanges.undo({
      workspaceId: ws.workspaceId,
      turnId: turn.id,
      expectedVersion: body.expectedVersion,
      confirmSensitive: body.confirmSensitive,
    });
    if (result.conflicts?.length) {
      return c.json({ error: { code: 'TURN_CHANGE_CONFLICT', message: 'Later edits overlap these changes.', details: result } }, 409);
    }
    if (result.requiresSensitiveConfirmation) {
      return c.json({ error: { code: 'TURN_CHANGE_CONFIRMATION_REQUIRED', message: 'Confirm restoration of sensitive local state.', details: result } }, 409);
    }
    return c.json(result);
  });

  app.post('/:agentId/turns/:turnId/redo', async (c) => {
    const ws = getWorkspace(c);
    const turn = durableTurns.require(ws.workspaceId, c.req.param('turnId'));
    if (turn.agentId !== c.req.param('agentId')) throw new AgentisError('RESOURCE_NOT_FOUND', 'conversation turn not found');
    if (!deps.turnChanges) throw new AgentisError('RESOURCE_NOT_FOUND', 'Turn restoration is unavailable.');
    const body = turnChangeActionSchema.parse(await c.req.json().catch(() => ({})));
    const result = deps.turnChanges.redo({
      workspaceId: ws.workspaceId,
      turnId: turn.id,
      expectedVersion: body.expectedVersion,
      confirmSensitive: body.confirmSensitive,
    });
    if (result.conflicts?.length) {
      return c.json({ error: { code: 'TURN_CHANGE_CONFLICT', message: 'Later edits overlap these changes.', details: result } }, 409);
    }
    if (result.requiresSensitiveConfirmation) {
      return c.json({ error: { code: 'TURN_CHANGE_CONFIRMATION_REQUIRED', message: 'Confirm restoration of sensitive local state.', details: result } }, 409);
    }
    return c.json(result);
  });

  app.get('/:agentId/turns/:turnId/events', (c) => {
    const ws = getWorkspace(c);
    const turnId = c.req.param('turnId');
    const turn = durableTurns.require(ws.workspaceId, turnId);
    if (turn.agentId !== c.req.param('agentId')) throw new AgentisError('RESOURCE_NOT_FOUND', 'conversation turn not found');
    const headerCursor = Number(c.req.header('last-event-id') ?? 0);
    const queryCursor = Number(c.req.query('after') ?? 0);
    return streamSSE(c, async (stream) => {
      let cursor = Math.max(Number.isFinite(headerCursor) ? headerCursor : 0, Number.isFinite(queryCursor) ? queryCursor : 0);
      while (!c.req.raw.signal.aborted) {
        const events = durableTurns.events(ws.workspaceId, turnId, cursor);
        for (const event of events) {
          cursor = event.seq;
          await stream.writeSSE({ id: String(event.seq), event: event.event, data: JSON.stringify(event.data) });
        }
        const latest = durableTurns.require(ws.workspaceId, turnId);
        if (['completed', 'failed', 'cancelled', 'paused', 'blocked', 'awaiting_approval', 'interrupted'].includes(latest.status) && cursor >= latest.lastEventSeq) break;
        await delay(350);
      }
    });
  });

  app.post('/:agentId/turns/:turnId/pause', (c) => {
    const ws = getWorkspace(c);
    const before = durableTurns.require(ws.workspaceId, c.req.param('turnId'));
    if (before.agentId !== c.req.param('agentId')) throw new AgentisError('RESOURCE_NOT_FOUND', 'conversation turn not found');
    const turn = durableTurns.pause(ws.workspaceId, before.id);
    return c.json({ turn: serializeDurableTurn(turn, deps.turnChanges) });
  });

  app.post('/:agentId/turns/:turnId/resume', (c) => {
    const ws = getWorkspace(c);
    const before = durableTurns.require(ws.workspaceId, c.req.param('turnId'));
    if (before.agentId !== c.req.param('agentId')) throw new AgentisError('RESOURCE_NOT_FOUND', 'conversation turn not found');
    const turn = durableTurns.resume(ws.workspaceId, before.id);
    return c.json({ turn: serializeDurableTurn(turn, deps.turnChanges) });
  });

  app.post('/:agentId/turns/:turnId/cancel', async (c) => {
    const ws = getWorkspace(c);
    const before = durableTurns.require(ws.workspaceId, c.req.param('turnId'));
    if (before.agentId !== c.req.param('agentId')) throw new AgentisError('RESOURCE_NOT_FOUND', 'conversation turn not found');
    const turn = await durableTurns.cancel(ws.workspaceId, before.id);
    return c.json({ turn: serializeDurableTurn(turn, deps.turnChanges) });
  });

  // Stop may arrive before the POST /turns response gives the browser a durable
  // turn id. Client turn ids are generated before that POST, so they provide a
  // stable cancellation handle across the create → event-stream handoff.
  app.post('/:agentId/turns/by-client/:clientTurnId/cancel', async (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const turn = durableTurns.findByClientTurnId(ws.workspaceId, agentId, c.req.param('clientTurnId'));
    if (!turn) return c.json({ turn: null });
    const cancelled = await durableTurns.cancel(ws.workspaceId, turn.id);
    return c.json({ turn: serializeDurableTurn(cancelled, deps.turnChanges) });
  });

  // Queue-then-auto-continue composer: still-pending messages queued while a
  // turn was streaming. Fetched on load so a page reload never silently drops
  // them (they keep dispatching once the in-flight turn ends).
  app.get('/:agentId/queue', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversationId = c.req.query('conversationId') || null;
    const conversation = conversationId
      ? deps.conversations.getById(ws.workspaceId, conversationId)
      : deps.conversations.getOrCreateByAgent({
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          agentId,
        });
    const items = deps.conversations.listQueue(ws.workspaceId, conversation.id).map(serializeQueueItem);
    return c.json({ items, conversationId: conversation.id });
  });

  // Cancel a still-pending queued message before it dispatches.
  app.delete('/:agentId/queue/:queueId', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const queueId = c.req.param('queueId');
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversationId = c.req.query('conversationId') || null;
    const conversation = conversationId
      ? deps.conversations.getById(ws.workspaceId, conversationId)
      : deps.conversations.getOrCreateByAgent({
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          agentId,
        });
    const item = deps.conversations.discardQueuedMessage({
      workspaceId: ws.workspaceId,
      conversationId: conversation.id,
      queueId,
    });
    return c.json({ ok: true, item: serializeQueueItem(item) });
  });

  /**
   * Hard stop is conversation-scoped: abort the server-side model turn, discard
   * its queued follow-ups, and cancel only workflow runs created by this chat.
   * It deliberately does not touch unrelated scheduled/app automation runs.
   */
  app.post('/:agentId/stop', async (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversationId = c.req.query('conversationId') || null;
    const conversation = conversationId
      ? deps.conversations.getById(ws.workspaceId, conversationId)
      : deps.conversations.getOrCreateByAgent({
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          agentId,
        });
    if (conversation.agentId !== agentId) throw new AgentisError('RESOURCE_NOT_FOUND', 'conversation not found for agent');

    const durableActive = durableTurns.listActive(ws.workspaceId, conversation.id);
    await Promise.allSettled(durableActive.map((turn) => durableTurns.cancel(ws.workspaceId, turn.id)));
    const activeTurn = activeConversationTurns.get(conversation.id);
    const leaseRevoked = deps.turnLeases?.revoke(ws.workspaceId, conversation.id) ?? false;
    if (activeTurn) {
      hardStoppedConversations.add(conversation.id);
      if (!activeTurn.signal.aborted) activeTurn.abort(new Error('operator_stop_all'));
    }
    const discarded = deps.conversations.discardPendingQueue({
      workspaceId: ws.workspaceId,
      conversationId: conversation.id,
    });

    const activeRuns = deps.db.select({ id: schema.workflowRuns.id })
      .from(schema.workflowRuns)
      .where(and(
        eq(schema.workflowRuns.workspaceId, ws.workspaceId),
        eq(schema.workflowRuns.conversationId, conversation.id),
        inArray(schema.workflowRuns.status, ['CREATED', 'PLANNING', 'RUNNING', 'WAITING', 'PAUSED']),
      ))
      .all();
    const cancellations = deps.engine
      ? await Promise.allSettled(activeRuns.map((run) => deps.engine!.cancelRun(run.id)))
      : null;
    const cancelledRunIds = activeRuns
      .filter((_run, index) => cancellations?.[index]?.status === 'fulfilled')
      .map((run) => run.id);
    const failedRunIds = activeRuns
      .filter((_run, index) => !cancellations || cancellations[index]?.status === 'rejected')
      .map((run) => run.id);
    deps.logger.info('conversations.hard_stopped', {
      workspaceId: ws.workspaceId,
      conversationId: conversation.id,
      agentId,
      durableTurnIds: durableActive.map((turn) => turn.id),
      turnAborted: Boolean(activeTurn),
      leaseRevoked,
      discardedMessages: discarded.length,
      cancelledRunIds,
      failedRunIds,
    });
    return c.json({
      ok: failedRunIds.length === 0,
      conversationId: conversation.id,
      turnAborted: Boolean(activeTurn || durableActive.length),
      cancelledTurnIds: durableActive.map((turn) => turn.id),
      leaseRevoked,
      discardedMessages: discarded.length,
      cancelledRunIds,
      failedRunIds,
    });
  });

  // Reload recovery: a tab that (re)loaded mid-queue has no way to know a
  // turn ended while it was gone (the in-flight guard is in-memory and the
  // "turn ended" dispatch only fires for tabs that were connected at the
  // time). If no turn is currently active for this conversation, atomically
  // claim the oldest pending message so the client can continue it as a
  // fresh turn — a reload must never silently strand a queued send. Returns
  // { item: null } when a turn is already active (nothing to claim) or the
  // queue is empty.
  app.post('/:agentId/queue/resume', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversationId = c.req.query('conversationId') || null;
    const conversation = conversationId
      ? deps.conversations.getById(ws.workspaceId, conversationId)
      : deps.conversations.getOrCreateByAgent({
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          agentId,
        });
    if (activeConversationTurns.has(conversation.id)) {
      return c.json({ item: null });
    }
    const item = deps.conversations.dispatchNextQueued({
      workspaceId: ws.workspaceId,
      conversationId: conversation.id,
    });
    return c.json({ item: item ? serializeQueueItem(item) : null });
  });

  app.post('/:agentId/confirm', async (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    return confirmConversationAction(c, deps, ws, agentId, durableTurns);
  });

  app.post('/:agentId/continue/:sessionId', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const sessionId = c.req.param('sessionId');
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversation = deps.conversations.getOrCreateByAgent({
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      userId: ws.user.id,
      agentId,
      mirroredSessionId: sessionId,
    });
    return c.json({ conversation });
  });

  app.post('/:agentId/read', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const conversationId = c.req.query('conversationId') || null;
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversation = conversationId
      ? deps.conversations.getById(ws.workspaceId, conversationId)
      : deps.conversations.getOrCreateByAgent({
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          agentId,
        });
    deps.conversations.markRead(ws.workspaceId, conversation.id);
    return c.json({ ok: true });
  });

  app.post('/:agentId/new', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversation = deps.conversations.startNewConversation({
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      userId: ws.user.id,
      agentId,
    });
    return c.json({ ok: true, conversationId: conversation.id });
  });

  app.patch('/session/:conversationId', async (c) => {
    const ws = getWorkspace(c);
    const conversationId = c.req.param('conversationId');
    const body = await c.req.json();
    const parsed = z.object({
      title: z.string().nullable().optional(),
      archived: z.boolean().optional(),
    }).parse(body);

    const conversation = deps.conversations.updateSession(ws.workspaceId, conversationId, parsed);
    return c.json({ ok: true, conversation });
  });

  // Composer toggle: set the conversation's sticky permission mode (ask | plan |
  // auto) without sending a message. Channels do the same via slash commands.
  app.post('/session/:conversationId/mode', async (c) => {
    const ws = getWorkspace(c);
    const conversationId = c.req.param('conversationId');
    const { mode } = z.object({ mode: z.enum(['ask', 'plan', 'auto']) }).parse(await c.req.json());
    // Reuse the existing executionMode='plan' enforcement (registry-level mutation
    // block) so Plan mode behaves identically whether set here or via /plan.
    deps.db.update(schema.conversations)
      .set({
        permissionMode: mode,
        executionMode: mode === 'plan' ? 'plan' : 'chat',
        updatedAt: new Date().toISOString(),
      })
      .where(and(
        eq(schema.conversations.id, conversationId),
        eq(schema.conversations.workspaceId, ws.workspaceId),
      ))
      .run();
    return c.json({ ok: true, permissionMode: mode });
  });

  app.post('/session/:conversationId/approval-sensitivity', async (c) => {
    const ws = getWorkspace(c);
    const conversationId = c.req.param('conversationId');
    const { sensitivity } = z.object({
      sensitivity: z.enum(['cautious', 'balanced', 'autonomous']),
    }).parse(await c.req.json());
    const result = deps.db.update(schema.conversations)
      .set({ approvalSensitivity: sensitivity, updatedAt: new Date().toISOString() })
      .where(and(
        eq(schema.conversations.id, conversationId),
        eq(schema.conversations.workspaceId, ws.workspaceId),
      ))
      .run();
    if (result.changes === 0) throw new AgentisError('RESOURCE_NOT_FOUND', 'conversation not found');
    return c.json({ ok: true, approvalSensitivity: sensitivity });
  });

  app.delete('/session/:conversationId', (c) => {
    const ws = getWorkspace(c);
    const conversationId = c.req.param('conversationId');
    deps.conversations.deleteConversation(ws.workspaceId, conversationId);
    return c.json({ ok: true });
  });

  app.post('/:agentId/:messageId/rewrite', async (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const messageId = c.req.param('messageId');
    const body = rewriteSchema.parse(await c.req.json());
    const clientTurnId = body.clientTurnId ?? randomUUID();
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversationId = c.req.query('conversationId') || null;
    const conversation = conversationId
      ? deps.conversations.getById(ws.workspaceId, conversationId)
      : deps.conversations.getOrCreateByAgent({
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          agentId,
        });
    // A rewrite is a new execution branch. Retire every preserved state from
    // the old branch before editing history, otherwise a blocked Mission can
    // reattach its old clock and recovery state to the fresh task.
    const supersededTurns = durableTurns.listActive(ws.workspaceId, conversation.id);
    await Promise.allSettled(supersededTurns.map((turn) => durableTurns.cancel(ws.workspaceId, turn.id)));
    const supersededRuntime = activeConversationTurns.get(conversation.id);
    if (supersededRuntime && !supersededRuntime.signal.aborted) {
      hardStoppedConversations.add(conversation.id);
      supersededRuntime.abort(new Error('conversation_rewrite'));
    }
    deps.conversations.discardPendingQueue({ workspaceId: ws.workspaceId, conversationId: conversation.id });
    const activeRuns = deps.db.select({ id: schema.workflowRuns.id })
      .from(schema.workflowRuns)
      .where(and(
        eq(schema.workflowRuns.workspaceId, ws.workspaceId),
        eq(schema.workflowRuns.conversationId, conversation.id),
        inArray(schema.workflowRuns.status, ['CREATED', 'PLANNING', 'RUNNING', 'WAITING', 'PAUSED']),
      ))
      .all();
    if (deps.engine) await Promise.allSettled(activeRuns.map((run) => deps.engine!.cancelRun(run.id)));
    const result = deps.conversations.rewriteFromMessage({
      workspaceId: ws.workspaceId,
      conversationId: conversation.id,
      messageId,
      body: body.text,
      metadata: { clientTurnId },
    });
    captureImmediateConversationCorrection(deps, ws, {
      agentId,
      conversationId: conversation.id,
      userMessage: body.text,
      useViewportContext: body.useViewportContext,
      viewportOverride: body.viewportOverride as ViewportContext | null | undefined,
    });
    if (c.req.header('accept')?.includes('text/event-stream')) {
      return streamConversationTurnReply(c, deps, ws, {
        agentId,
        conversation,
        clientTurnId,
        currentMessageId: result.message.id,
        userMessage: body.text,
        useViewportContext: body.useViewportContext,
        viewportOverride: body.viewportOverride as ViewportContext | null | undefined,
      });
    }
    return c.json(result);
  });

  app.patch('/:agentId/:messageId', async (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const messageId = c.req.param('messageId');
    const body = editSchema.parse(await c.req.json());
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversation = deps.conversations.getOrCreateByAgent({
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      userId: ws.user.id,
      agentId,
    });
    const message = deps.conversations.updateMessage({
      workspaceId: ws.workspaceId,
      conversationId: conversation.id,
      messageId,
      body: body.text,
    });
    return c.json({ message });
  });

  app.delete('/:agentId/:messageId', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const messageId = c.req.param('messageId');
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversation = deps.conversations.getOrCreateByAgent({
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      userId: ws.user.id,
      agentId,
    });
    deps.conversations.deleteMessage({
      workspaceId: ws.workspaceId,
      conversationId: conversation.id,
      messageId,
    });
    return c.json({ ok: true, id: messageId });
  });

  return app;
}

async function relayOpenClaw(
  deps: { logger: Logger },
  adapter: OpenClawAdapter,
  sessionId: string | undefined,
  body: string,
  agentId: string,
): Promise<void> {
  try {
    await adapter.sendSessionMessage({ sessionId, body });
  } catch (err) {
    deps.logger.warn('conversations.send_failed', { agentId, err: (err as Error).message });
  }
}

type ChatSseStream = {
  writeSSE(args: { event?: string; data: string }): Promise<void>;
};

function createChatActivity(args: {
  clientTurnId?: string;
  agentId?: string;
  workflowId?: string;
  phase: Extract<ChatDelta, { type: 'activity' }>['phase'];
  status?: Extract<ChatDelta, { type: 'activity' }>['status'];
  label: string;
  detail?: string;
  suffix?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}): Extract<ChatDelta, { type: 'activity' }> {
  const stable = args.suffix ?? `${args.phase}-${Date.now()}`;
  return {
    type: 'activity',
    id: `activity-${args.clientTurnId ?? 'turn'}-${stable}`,
    phase: args.phase,
    status: args.status ?? 'running',
    label: args.label,
    ...(args.detail ? { detail: args.detail } : {}),
    startedAt: args.startedAt ?? new Date().toISOString(),
    ...(args.completedAt ? { completedAt: args.completedAt } : {}),
    ...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
    ...(args.workflowId ? { workflowId: args.workflowId } : {}),
    ...(args.agentId ? { agentId: args.agentId } : {}),
    ...(args.clientTurnId ? { clientTurnId: args.clientTurnId } : {}),
  };
}

async function writeChatDelta(
  stream: ChatSseStream,
  deps: ConversationRouteDeps,
  ws: ReturnType<typeof getWorkspace>,
  agentId: string,
  conversationId: string,
  clientTurnId: string,
  delta: ChatDelta,
  streamedMetadata: StreamedChatMetadata,
): Promise<void> {
  captureChatDeltaMetadata(streamedMetadata, delta);
  await stream.writeSSE({ event: 'delta', data: JSON.stringify(delta) });
  publishChatDelta(deps, ws, agentId, conversationId, clientTurnId, delta);
}

function publishChatDelta(
  deps: ConversationRouteDeps,
  ws: ReturnType<typeof getWorkspace>,
  agentId: string,
  conversationId: string,
  clientTurnId: string,
  delta: ChatDelta,
): void {
  publishChatDeltaProgress(deps.bus, {
    workspaceId: ws.workspaceId,
    ambientId: ws.ambientId,
    agentId,
    conversationId,
    clientTurnId,
  }, delta);
}

async function* withChatHeartbeats(
  source: AsyncIterable<ChatDelta>,
  args: { clientTurnId: string; agentId: string; workflowId?: string },
): AsyncIterable<ChatDelta> {
  const iterator = source[Symbol.asyncIterator]();
  const startedAt = Date.now();
  let nextHeartbeatAt = 8_000;
  let next = iterator.next();
  let lastActivity: Extract<ChatDelta, { type: 'activity' }> | undefined;

  while (true) {
    const waitMs = Math.max(0, startedAt + nextHeartbeatAt - Date.now());
    const raced = await Promise.race([
      next.then((result) => ({ kind: 'delta' as const, result })),
      delay(waitMs).then(() => ({ kind: 'heartbeat' as const, threshold: nextHeartbeatAt })),
    ]);

    if (raced.kind === 'heartbeat') {
      yield createChatActivity({
        clientTurnId: args.clientTurnId,
        agentId: args.agentId,
        workflowId: args.workflowId,
        phase: 'waiting',
        label: lastActivity && !/waiting for (?:model|runtime) output|invoking agent runtime/i.test(lastActivity.label)
          ? lastActivity.label
          : 'Waiting for the agent\'s first progress update',
        detail: `No operator-visible update has arrived after ${Math.round(raced.threshold / 1000)}s; the turn remains connected and can be stopped.`,
        suffix: 'waiting',
      });
      nextHeartbeatAt = raced.threshold < 30_000
        ? 30_000
        : raced.threshold < 60_000
          ? 60_000
        : raced.threshold < 120_000
          ? 120_000
          : raced.threshold + 60_000;
      continue;
    }

    if (raced.result.done) return;
    if (raced.result.value.type === 'activity') lastActivity = raced.result.value;
    yield raced.result.value;
    while (Date.now() - startedAt >= nextHeartbeatAt) {
      nextHeartbeatAt = nextHeartbeatAt < 60_000
        ? 60_000
        : nextHeartbeatAt < 120_000
          ? 120_000
          : nextHeartbeatAt + 60_000;
    }
    next = iterator.next();
  }
}



function findWorkspaceOrchestrator(db: AgentisSqliteDb, workspaceId: string): AgentRow | null {
  return db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.role, 'orchestrator')))
    .get() ?? null;
}


function conversationHistoryForTurn(
  deps: ConversationRouteDeps,
  conversationId: string,
  currentMessageId: string | null,
) {
  const conversation = deps.db.select({ channelConnectionId: schema.conversations.channelConnectionId })
    .from(schema.conversations).where(eq(schema.conversations.id, conversationId)).get();
  const channelScoped = Boolean(conversation?.channelConnectionId);
  return deps.conversations
    .messages(conversationId, 20)
    .filter((row) => row.id !== currentMessageId)
    .map((row) => ({
      role: channelModelRole(row, channelScoped) === 'user' ? 'user' as const : 'assistant' as const,
      content: row.body,
    }));
}

const MISSION_MODE_SYSTEM_ADDENDUM = `
MISSION EXECUTION CONTRACT
- This is a durable, high-quality mission, not a one-shot answer.
- Maintain the task spine as the authoritative objective, steps, decisions, deviations, and acceptance criteria.
- Use at most three concurrently active specialist agents for independent work when that improves quality; keep ownership and integration with the primary agent.
- Persist real artifacts and state as you work. Do not substitute prose for implementation.
- Verify the result against every acceptance criterion. Never claim completion without concrete evidence.
- If blocked by an approval or unavailable capability, state the exact blocker and the smallest operator decision required.
`.trim();

async function executeDurableConversationTurn(
  deps: ConversationRouteDeps,
  turn: ConversationTurnRow,
  sink: DurableTurnEventSink,
  signal: AbortSignal,
) {
  const conversation = deps.conversations.getById(turn.workspaceId, turn.conversationId);
  const user = deps.db.select().from(schema.users).where(eq(schema.users.id, turn.userId)).get();
  const workspace = deps.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, turn.workspaceId)).get();
  if (!user || !workspace) throw new AgentisError('RESOURCE_NOT_FOUND', 'turn workspace or operator no longer exists');
  const ws: WorkspaceContext = {
    workspaceId: turn.workspaceId,
    ambientId: workspace.defaultAmbientId ?? null,
    user,
  };
  const reg = deps.adapters.get(turn.agentId);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason ?? new Error('durable_turn_cancelled'));
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  activeConversationTurns.set(turn.conversationId, controller);
  hardStoppedConversations.delete(turn.conversationId);
  const turnLease = deps.turnLeases?.issue(turn.workspaceId, turn.conversationId);
  let finishReason: ChatFinishReason = 'stop';
  let awaitingApproval = false;
  let sawError = false;
  let runtimeError = '';
  let finalMessageId: string | null = null;
  let finalMessageText = '';
  let durableExperience: ConversationTurnExperience | null = null;
  const trackingSink: ChatSseStream = {
    writeSSE: async (event) => {
      if (event.event === 'delta') {
        try {
          const delta = JSON.parse(event.data) as ChatDelta;
          if (delta.type === 'confirmation_required') awaitingApproval = true;
          if (delta.type === 'agent_consultation' && delta.phase === 'awaiting_approval') awaitingApproval = true;
          if (delta.type === 'done') finishReason = delta.finishReason;
        } catch { /* persisted transport still receives the original event */ }
      } else if (event.event === 'done') {
        try { finishReason = (JSON.parse(event.data) as { finishReason?: ChatFinishReason }).finishReason ?? finishReason; } catch { /* noop */ }
      } else if (event.event === 'message') {
        try {
          const message = JSON.parse(event.data) as { id?: string; body?: string };
          finalMessageId = message.id ?? finalMessageId;
          finalMessageText = message.body ?? finalMessageText;
        } catch { /* noop */ }
      } else if (event.event === 'error') {
        sawError = true;
        try { runtimeError = (JSON.parse(event.data) as { message?: string }).message ?? runtimeError; } catch { /* noop */ }
      }
      await sink.writeSSE(event);
    },
  };
  try {
    await runConversationTurn(trackingSink, deps, ws, {
      agentId: turn.agentId,
      conversation,
      clientTurnId: turn.clientTurnId,
      durableTurnId: turn.id,
      currentMessageId: turn.messageId,
      userMessage: turn.prompt,
      useViewportContext: false,
      viewportOverride: (turn.viewport as ViewportContext | null) ?? null,
      turnSignal: controller.signal,
      ...(turnLease ? { turnLease } : {}),
      qualityMode: turn.effectiveMode as EffectiveConversationExecutionMode,
      executionEnvelope: (turn.executionEnvelope as ChatExecutionEnvelope | null) ?? null,
      contextManifest: (turn.contextManifest as ChatContextManifest | null) ?? null,
    }, reg);
  } finally {
    signal.removeEventListener('abort', abort);
    if (turnLease) {
      try {
        durableExperience = deps.turnLeases?.experience(turn.workspaceId, turn.conversationId, turnLease) ?? null;
      } catch (error) {
        if (!(error instanceof AgentisError) || error.code !== 'TURN_CANCELLED') throw error;
      }
      deps.turnLeases?.complete(turn.workspaceId, turn.conversationId, turnLease);
    }
    if (activeConversationTurns.get(turn.conversationId) === controller) activeConversationTurns.delete(turn.conversationId);
    if (!controller.signal.aborted && !hardStoppedConversations.delete(turn.conversationId)) {
      deps.conversations.dispatchNextQueued({ workspaceId: turn.workspaceId, conversationId: turn.conversationId });
    }
  }
  if (awaitingApproval) {
    if (turn.planId && deps.plans) deps.plans.setStatus(turn.workspaceId, turn.userId, turn.planId, 'blocked');
    return { status: 'awaiting_approval' as const };
  }
  const terminalReason = finishReason as ChatFinishReason;
  if (controller.signal.aborted || terminalReason === 'interrupted') return { status: 'interrupted' as const };
  if (sawError || terminalReason === 'error') {
    const blocked = /\b(?:capacity|overloaded|rate.?limit|quota|credits?|billing|payment required|temporarily unavailable|try again|no healthy runtime)\b/i.test(runtimeError || finalMessageText);
    if (turn.planId && deps.plans) deps.plans.setStatus(turn.workspaceId, turn.userId, turn.planId, blocked ? 'blocked' : 'failed');
    return {
      status: blocked ? 'blocked' as const : 'failed' as const,
      error: runtimeError || (blocked ? 'The selected runtime is temporarily unavailable. Resume this turn or change model.' : 'The agent runtime failed during this turn.'),
    };
  }
  if (turn.planId && deps.plans) {
    if (/verification blocked|cannot truthfully mark|\bnot (?:done|complete|ready)\b/i.test(finalMessageText)) {
      deps.plans.setStatus(turn.workspaceId, turn.userId, turn.planId, 'blocked');
      return { status: 'blocked' as const, error: 'Mission completion was blocked by verification.' };
    }
    const receipts = durableExperience ? proofReceiptsFromExperience(durableExperience) : [];
    const verification = await deps.plans.verifyCompletion(turn.workspaceId, turn.userId, turn.planId, {
      output: { messageId: finalMessageId, text: finalMessageText },
      evidence: receipts.map((receipt) => ({
        label: `${receipt.kind}: ${receipt.tool}`,
        ...(receipt.runId ? { runId: receipt.runId } : {}),
        payload: receipt,
      })),
      receipts,
    });
    if (!verification.passed) {
      return {
        status: 'blocked' as const,
        error: 'Completion verification is incomplete. The result was produced, but not every acceptance check has concrete evidence yet.',
      };
    }
  }
  return { status: 'completed' as const };
}

async function buildChatExecutionEnvelope(
  deps: ConversationRouteDeps,
  agent: AgentRow,
  requestedMode: ConversationExecutionMode,
  effectiveMode: EffectiveConversationExecutionMode,
  classificationReason: string,
): Promise<ChatExecutionEnvelope> {
  const descriptor = deps.runtimeProfiles
    ? await deps.runtimeProfiles.captureExecution(agent.workspaceId, agent.id).catch(() => null)
    : null;
  const native = descriptor?.executionEnvelope;
  const configured = native?.reasoningEffort ?? null;
  const effectiveReasoningEffort = effectiveMode === 'quick'
    ? 'low'
    : effectiveMode === 'mission'
      ? reasoningEffortFloor(configured, 'high')
      : configured;
  const forwarding = deps.adapters.get(agent.id)?.adapter.capabilities?.().toolForwarding;
  return {
    version: 1,
    requestedMode,
    effectiveMode,
    classificationReason,
    adapterType: agent.adapterType,
    model: native?.model ?? agent.runtimeModel ?? null,
    configuredReasoningEffort: configured,
    effectiveReasoningEffort,
    fastMode: effectiveMode === 'quick' && agent.adapterType === 'codex',
    runtimeProfile: native?.runtimeProfile.mode ?? null,
    cwd: native?.cwd ?? null,
    loadedSources: native?.loadedSources ?? ['agentis'],
    toolMode: forwarding === 'mcp_native' ? 'adapter_native' : forwarding === 'marker_protocol' ? 'caller_loop' : 'none',
    durable: effectiveMode === 'mission',
    createdAt: new Date().toISOString(),
    warnings: native?.capabilityWarnings ?? (descriptor ? [] : ['Runtime envelope could not be inspected before launch.']),
  };
}

function serializeDurableTurn(turn: ConversationTurnRow, turnChanges?: TurnChangeJournal) {
  return {
    id: turn.id,
    conversationId: turn.conversationId,
    agentId: turn.agentId,
    clientTurnId: turn.clientTurnId,
    messageId: turn.messageId,
    planId: turn.planId,
    requestedMode: turn.requestedMode,
    effectiveMode: turn.effectiveMode,
    permissionMode: turn.permissionMode,
    status: turn.status,
    executionEnvelope: turn.executionEnvelope,
    contextManifest: turn.contextManifest,
    lastEventSeq: turn.lastEventSeq,
    error: turn.error,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    changeSet: turnChanges?.summary(turn.workspaceId, turn.id) ?? null,
  };
}

function serializeConversationMessagesWithChanges(
  deps: ConversationRouteDeps,
  workspaceId: string,
  conversationId: string,
  messages: ReturnType<ConversationStore['messages']>,
) {
  const byClientTurn = new Map(
    deps.db.select().from(schema.conversationTurns).where(and(
      eq(schema.conversationTurns.workspaceId, workspaceId),
      eq(schema.conversationTurns.conversationId, conversationId),
    )).all().map((turn) => [turn.clientTurnId, turn]),
  );
  return messages.map((message) => {
    const serialized = serializeConversationMessage(message);
    const metadata = serialized.metadata && typeof serialized.metadata === 'object'
      ? serialized.metadata as Record<string, unknown>
      : {};
    const trace = metadata.turn && typeof metadata.turn === 'object'
      ? metadata.turn as Record<string, unknown>
      : null;
    const clientTurnId = typeof metadata.clientTurnId === 'string'
      ? metadata.clientTurnId
      : typeof trace?.clientTurnId === 'string'
        ? trace.clientTurnId
        : null;
    const turn = clientTurnId ? byClientTurn.get(clientTurnId) : null;
    if (!turn) return serialized;
    return {
      ...serialized,
      metadata: {
        ...metadata,
        durableTurnId: turn.id,
        changeSet: deps.turnChanges?.summary(workspaceId, turn.id) ?? null,
      },
    };
  });
}

function missionTitle(body: string): string {
  const first = body.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? 'Mission';
  return first.replace(/^#+\s*/, '').slice(0, 96);
}

async function swarmControl(c: Context, action: 'pause' | 'resume' | 'stop') {
  const ws = getWorkspace(c);
  const service = ChatSessionExecutor.chatSwarms();
  if (!service) return c.json({ error: 'Chat swarm service is unavailable.' }, 503);
  try {
    const swarmId = c.req.param('swarmId');
    if (!swarmId) return c.json({ error: 'Chat swarm id is required.' }, 400);
    const swarm = action === 'pause'
      ? await service.pause(ws.workspaceId, swarmId)
      : action === 'resume'
        ? await service.resume(ws.workspaceId, swarmId)
        : await service.stop(ws.workspaceId, swarmId);
    return c.json(swarm);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : `Unable to ${action} team.` }, 400);
  }
}

const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
function reasoningEffortFloor(current: string | null, floor: string): string {
  const currentIndex = current ? REASONING_EFFORTS.indexOf(current) : -1;
  const floorIndex = REASONING_EFFORTS.indexOf(floor);
  return currentIndex >= floorIndex ? current! : floor;
}

function streamConversationTurnReply(
  c: Context,
  deps: ConversationRouteDeps,
  ws: ReturnType<typeof getWorkspace>,
  args: {
    agentId: string;
    conversation: ConversationRow;
    clientTurnId: string;
    currentMessageId: string | null;
    userMessage: string;
    useViewportContext: boolean;
    viewportOverride?: ViewportContext | null;
    contextManifest?: ChatContextManifest | null;
    durableTurnId?: string;
  },
) {
  const reg = deps.adapters.get(args.agentId);
  return streamSSE(c, async (stream) => {
    const turnController = new AbortController();
    const turnLease = deps.turnLeases?.issue(ws.workspaceId, args.conversation.id);
    const abortFromClient = () => turnController.abort(c.req.raw.signal.reason);
    if (c.req.raw.signal.aborted) abortFromClient();
    else c.req.raw.signal.addEventListener('abort', abortFromClient, { once: true });
    activeConversationTurns.set(args.conversation.id, turnController);
    hardStoppedConversations.delete(args.conversation.id);
    try {
      await runConversationTurn(stream, deps, ws, {
        ...args,
        turnSignal: turnController.signal,
        ...(turnLease ? { turnLease } : {}),
      }, reg);
    } finally {
      if (turnLease) deps.turnLeases?.complete(ws.workspaceId, args.conversation.id, turnLease);
      c.req.raw.signal.removeEventListener('abort', abortFromClient);
      if (activeConversationTurns.get(args.conversation.id) === turnController) {
        activeConversationTurns.delete(args.conversation.id);
      }
      // Queue-then-auto-continue: this turn just ended — if a message was
      // queued while it streamed, pop the oldest and announce it on the
      // realtime bus so the client auto-continues with a fresh turn.
      try {
        const hardStopped = hardStoppedConversations.delete(args.conversation.id);
        if (!turnController.signal.aborted && !hardStopped) {
          deps.conversations.dispatchNextQueued({
            workspaceId: ws.workspaceId,
            conversationId: args.conversation.id,
          });
        }
      } catch (err) {
        deps.logger.warn('conversations.queue_dispatch_failed', {
          conversationId: args.conversation.id,
          err: (err as Error).message,
        });
      }
    }
  });
}

async function runConversationTurn(
  stream: ChatSseStream,
  deps: ConversationRouteDeps,
  ws: WorkspaceContext,
  args: {
    agentId: string;
    conversation: ConversationRow;
    clientTurnId: string;
    currentMessageId: string | null;
    userMessage: string;
    useViewportContext: boolean;
    viewportOverride?: ViewportContext | null;
    turnSignal: AbortSignal;
    turnLease?: string;
    qualityMode?: EffectiveConversationExecutionMode;
    executionEnvelope?: ChatExecutionEnvelope | null;
    contextManifest?: ChatContextManifest | null;
    durableTurnId?: string;
  },
  reg: ReturnType<AdapterManager['get']>,
) {
  {
    const turnStartedAtMs = Date.now();
    const turnStartedAt = new Date(turnStartedAtMs).toISOString();
    let finalText = '';
    let consultationAwaitingApproval = false;
    let finishReason: Extract<ChatDelta, { type: 'done' }>['finishReason'] = 'stop';
    let adapterError: string | null = null;
    let operatorStopped = false;
    const streamedMetadata = createStreamedChatMetadata(args.clientTurnId, turnStartedAt);
    streamedMetadata.executionEnvelope = args.executionEnvelope ?? null;
    streamedMetadata.contextManifest = args.contextManifest ?? null;
    const activeViewport = args.useViewportContext
      ? args.viewportOverride ?? deps.viewportStore?.get(ws.user.id) ?? null
      : args.viewportOverride ?? null;
    const viewportWorkflowId = workflowIdFromViewport(activeViewport);
    // Resolve the sticky permission mode for this turn. A leading slash command
    // (/ask /plan /auto) overrides AND persists the conversation mode; otherwise
    // the conversation's stored mode applies (default ask).
    const modeCommand = parseModeCommand(args.userMessage);
    const storedMode = ((args.conversation.permissionMode as ChatPermissionMode | null) ?? 'ask');
    const permissionMode: ChatPermissionMode = modeCommand?.mode ?? storedMode;
    if (modeCommand) {
      deps.db.update(schema.conversations)
        .set({
          permissionMode: modeCommand.mode,
          executionMode: modeCommand.mode === 'plan' ? 'plan' : 'chat',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.conversations.id, args.conversation.id))
        .run();
    }
    // A bare mode command (no task) just switches mode and acknowledges — no model
    // turn. With a task ("/plan build X") it switches AND runs the remaining text.
    const bareModeSwitch = Boolean(modeCommand) && !modeCommand!.rest;
    const runtimeUserMessage = modeCommand
      ? (modeCommand.rest || defaultTaskForMode(permissionMode))
      : args.userMessage;

    await writeChatDelta(stream, deps, ws, args.agentId, args.conversation.id, args.clientTurnId, createChatActivity({
      clientTurnId: args.clientTurnId,
      agentId: args.agentId,
      workflowId: viewportWorkflowId,
      phase: 'received',
      label: initialTurnActivityLabel(runtimeUserMessage),
      suffix: 'received',
      startedAt: turnStartedAt,
    }), streamedMetadata);

    if (bareModeSwitch) {
      finalText = MODE_SWITCH_ACK[permissionMode];
      await writeChatDelta(stream, deps, ws, args.agentId, args.conversation.id, args.clientTurnId, {
        type: 'text',
        delta: finalText,
      }, streamedMetadata);
    } else if (reg?.adapter?.chat) {
      const history = conversationHistoryForTurn(deps, args.conversation.id, args.currentMessageId);
      const turnContext: ChatTurnContext = {
        workspaceId: ws.workspaceId,
        ambientId: ws.ambientId,
        agentId: args.agentId,
        userId: ws.user.id,
        conversationId: args.conversation.id,
        clientTurnId: args.clientTurnId,
        ...(args.durableTurnId ? { durableTurnId: args.durableTurnId } : {}),
        executionMode: permissionMode === 'plan' ? 'plan' : 'chat',
        permissionMode,
        approvalSensitivity: (args.conversation.approvalSensitivity as ApprovalSensitivity | null) ?? 'balanced',
        qualityMode: args.qualityMode ?? 'deep',
        maxTurns: 8,
        viewport: activeViewport,
        signal: args.turnSignal,
        ...(args.turnLease ? { turnLease: args.turnLease } : {}),
      };
      const releaseLease = deps.adapters.tryAcquireInteractiveLease(args.agentId, {
        ownerId: `conversation:${args.conversation.id}:${args.clientTurnId}`,
        kind: 'operator_chat',
        priority: 100,
      });
      if (!releaseLease) {
        finishReason = 'error';
        finalText = 'This agent is already handling another interactive turn. Stop that work or wait for it to finish, then retry.';
        await writeChatDelta(stream, deps, ws, args.agentId, args.conversation.id, args.clientTurnId, {
          type: 'text',
          delta: finalText,
        }, streamedMetadata);
      } else try {
        for await (const delta of withChatHeartbeats(
          ChatSessionExecutor.turn(reg.adapter, history, runtimeUserMessage, turnContext, {
            qualityMode: args.qualityMode ?? 'deep',
            ...(permissionMode === 'plan'
              ? { systemAddendum: PLAN_MODE_SYSTEM_ADDENDUM }
              : args.qualityMode === 'mission'
                ? { systemAddendum: MISSION_MODE_SYSTEM_ADDENDUM }
                : {}),
          }),
          { clientTurnId: args.clientTurnId, agentId: args.agentId, workflowId: viewportWorkflowId },
        )) {
          if (isAdapterErrorDelta(delta)) {
            if (delta.error.startsWith('canceled:')) {
              operatorStopped = true;
              finishReason = 'max_turns';
              break;
            }
            adapterError = delta.error;
            continue;
          }
          if (delta.type === 'done') {
            finishReason = delta.finishReason;
            break;
          }
          if (delta.type === 'agent_consultation' && delta.phase === 'awaiting_approval') {
            consultationAwaitingApproval = true;
          }
          await writeChatDelta(stream, deps, ws, args.agentId, args.conversation.id, args.clientTurnId, delta, streamedMetadata);
          if (delta.type === 'text') finalText += delta.delta;
        }
      } finally {
        releaseLease();
      }
    } else {
      const limitation = reg?.adapter?.capabilities?.().limitations?.[0];
      finalText = limitation
        ?? 'This agent is not connected to an interactive chat harness yet. Configure a V1 harness, then try again.';
      finishReason = 'error';
      adapterError = finalText;
      await writeChatDelta(stream, deps, ws, args.agentId, args.conversation.id, args.clientTurnId, {
        type: 'activity',
        id: `activity-${args.clientTurnId}-no-chat`,
        phase: 'error',
        status: 'error',
        label: 'Interactive chat unavailable',
        detail: finalText,
        clientTurnId: args.clientTurnId,
        agentId: args.agentId,
      }, streamedMetadata);
      await writeChatDelta(stream, deps, ws, args.agentId, args.conversation.id, args.clientTurnId, { type: 'text', delta: finalText }, streamedMetadata);
    }

    const turnPlan = deps.plans?.latest(ws.workspaceId, args.conversation.id) ?? null;
    if (turnPlan && Date.parse(turnPlan.updatedAt) >= turnStartedAtMs) {
      streamedMetadata.plan = turnPlan;
      if (!finalText.trim() && !streamedMetadata.confirmation) {
        finalText = `Plan saved: ${turnPlan.title}. It has ${turnPlan.nodes.filter((node) => node.stage === 'build').length} work steps and is ${turnPlan.status}.`;
        await writeChatDelta(stream, deps, ws, args.agentId, args.conversation.id, args.clientTurnId, {
          type: 'text',
          delta: finalText,
        }, streamedMetadata);
      }
    }

    // A stop endpoint and a disconnected client share the same lease/signal.
    // Do not let a late adapter error turn that intentional interruption into a
    // failed answer while the request is unwinding.
    operatorStopped ||= args.turnSignal.aborted || hardStoppedConversations.has(args.conversation.id);
    if (operatorStopped) finishReason = 'max_turns';

    if (!finalText.trim() && !streamedMetadata.confirmation && !consultationAwaitingApproval) {
      if (finishReason === 'interrupted' || operatorStopped) {
        finalText = 'Stopped by operator.';
      } else if (finishReason === 'error') {
        finalText = relevantTurnError(streamedMetadata, adapterError);
      } else {
        finishReason = 'error';
        finalText = 'The runtime completed without returning an answer. The turn was stopped so you can retry without wondering whether it is still running.';
      }
    }

    // Never persist internal plan transport markup. The prompt now requests
    // clean Markdown, while this remains a backstop for cached/older adapters.
    finalText = normalizeAgentPlanText(finalText);

    // A model's prose is not the release gate. When it claims that the App in
    // the active viewport is done/ready, reconcile that claim against the live
    // persisted control plane before the response is saved. This backstop is
    // deliberately domain-neutral: every App uses the same Doctor contract.
    // It prevents a polished final answer from hiding unresolved critical/error
    // findings such as missing event rules, stale outcome specs, or unbound
    // channels. The extra text delta also corrects already-streamed prose.
    const completionGuard = finishReason === 'interrupted'
      ? null
      : appCompletionGuard(deps.db, ws.workspaceId, activeViewport, finalText);
    if (completionGuard) {
      finalText = `${finalText.trimEnd()}\n\n${completionGuard}`;
      await writeChatDelta(stream, deps, ws, args.agentId, args.conversation.id, args.clientTurnId, {
        type: 'text',
        delta: `\n\n${completionGuard}`,
      }, streamedMetadata);
    }

    const turnCompletedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.now() - turnStartedAtMs);
    finalizeTurnTrace(streamedMetadata, finishReason, turnCompletedAt, durationMs);
    const failed = streamedMetadata.turn.status === 'failed';
    const stopped = streamedMetadata.turn.status === 'stopped';
    const interrupted = streamedMetadata.turn.status === 'interrupted';
    await writeChatDelta(stream, deps, ws, args.agentId, args.conversation.id, args.clientTurnId, createChatActivity({
      clientTurnId: args.clientTurnId,
      agentId: args.agentId,
      workflowId: streamedMetadata.workflowId ?? viewportWorkflowId,
      phase: failed ? 'error' : 'complete',
      status: failed ? 'error' : 'success',
      label: failed ? 'Response failed' : interrupted ? 'Response interrupted' : stopped ? 'Stopped before completion' : 'Response ready',
      detail: failed ? finalText : interrupted ? 'Stopped by operator. Late runtime output was ignored.' : stopped ? 'The turn reached a runtime limit.' : 'The agent finished this turn.',
      suffix: 'terminal',
      startedAt: turnCompletedAt,
      completedAt: turnCompletedAt,
      durationMs,
    }), streamedMetadata);

    if (failed) {
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({
          code: 'ADAPTER_CHAT_FAILED',
          message: finalText,
        }),
      });
    }

    const hasContentToSave = !consultationAwaitingApproval && (finalText.trim() || streamedMetadata.confirmation || failed);
    if (hasContentToSave) {
      const bodyToSave = finalText.trim() || streamedMetadata.confirmation?.title || 'Confirmation required';
      const persisted = deps.conversations.appendMirrored({
        workspaceId: ws.workspaceId,
        conversationId: args.conversation.id,
        sessionMessageId: `chat_${randomUUID()}`,
        authorType: 'agent',
        body: bodyToSave,
        deliveryStatus: failed ? 'failed' : 'delivered',
        metadata: buildPersistedChatMetadata('chat_loop', streamedMetadata, args.clientTurnId),
      });
      if (streamedMetadata.plan && deps.plans) {
        streamedMetadata.plan = deps.plans.attachMessage(ws.workspaceId, streamedMetadata.plan, persisted.id);
      }
      await stream.writeSSE({
        event: 'message',
        data: JSON.stringify({
          id: persisted.id,
          role: 'agent',
          body: persisted.body,
          createdAt: persisted.createdAt,
          metadata: buildPersistedChatMetadata('chat_loop', streamedMetadata, args.clientTurnId),
          deliveryStatus: persisted.deliveryStatus,
        }),
      });
    }

    let turnExperience: ConversationTurnExperience | null = null;
    if (args.turnLease) {
      try {
        turnExperience = deps.turnLeases?.experience(ws.workspaceId, args.conversation.id, args.turnLease) ?? null;
      } catch (err) {
        // Stop/revoke deliberately invalidates the lease before the streaming
        // loop unwinds. A cancelled turn has no trustworthy completed outcome
        // to learn from, and cancellation must not turn into a second error.
        if (!(err instanceof AgentisError) || err.code !== 'TURN_CANCELLED') throw err;
      }
    }
    if (turnExperience) {
      const efficiency = turnExperience.efficiency;
      deps.audit?.record({
        workspaceId: ws.workspaceId,
        runId: `chat:${args.conversation.id}:${args.clientTurnId}`,
        agentId: args.agentId,
        action: 'chat.tool.efficiency',
        actorType: 'agent',
        actorId: args.agentId,
        inputSummary: `calls=${turnExperience.toolCalls}; unique=${efficiency.uniqueObservations}; mutations=${efficiency.mutatingCalls}`,
        outputSummary: `coalesced_reads=${efficiency.coalescedReads}; args_chars=${efficiency.argumentCharsObserved}; result_chars=${efficiency.resultCharsObserved}; repeated_result_chars=${efficiency.repeatedResultChars}`,
      });
    }
    const capture = interrupted ? null : await deps.memoryCapture?.captureTurn({
      workspaceId: ws.workspaceId,
      conversationId: args.conversation.id,
      userId: ws.user.id,
      agentId: args.agentId,
      userDisplayName: ws.user.displayName,
      userMessage: args.userMessage,
      assistantMessage: finalText.trim() || null,
      finishReason,
      activeWorkflowId: viewportWorkflowId,
      activeNodeId: activeViewport?.selection?.ids?.[0] ?? null,
      experience: turnExperience,
    });
    // BRAIN-BLUEPRINT-10X §visibility — the STORE half of the legible mind (the
    // recall half is the executor's "Recalled N memories"). `signals` counts the
    // learnings queued through the PRIMARY formation path (judge dedupes/rejects);
    // the old condition ignored it, so exactly the turns that learned showed
    // nothing — why the mind felt dead. The stream is still open here (`done` is
    // written below), so the operator sees it in the turn itself.
    if (
      capture &&
      (capture.signals > 0 || capture.experienceJobIds.length > 0 || capture.peerUpdateJobIds.length > 0 || capture.promotedSessionMoments > 0 || capture.workspaceMemoryIds.length > 0)
    ) {
      const stored = Math.max(capture.signals, capture.workspaceMemoryIds.length) + capture.experienceJobIds.length;
      if (stored > 0) {
        const storedAt = new Date().toISOString();
        await writeChatDelta(stream, deps, ws, args.agentId, args.conversation.id, args.clientTurnId, createChatActivity({
          clientTurnId: args.clientTurnId,
          agentId: args.agentId,
          phase: 'complete',
          status: 'success',
          // §B7 — honest tense: `stored` counts candidates ENQUEUED, measured
          // before the judge runs — and the judge is prompted to drop most.
          // "Storing N memories" promised a result nothing ever confirmed.
          label: `Reviewing ${stored} ${stored === 1 ? 'memory candidate' : 'memory candidates'}`,
          detail: 'Queued into the Brain’s formation pipeline — the judge keeps what is durable, reconciles duplicates, and drops the rest. Kept atoms appear on the Brain canvas.',
          suffix: 'memory-store',
          startedAt: storedAt,
          completedAt: storedAt,
        }), streamedMetadata);
      }
      publishAgentWorkStep(deps.bus, {
        workspaceId: ws.workspaceId,
        ambientId: ws.ambientId,
        agentId: args.agentId,
        conversationId: args.conversation.id,
        clientTurnId: args.clientTurnId,
        phase: 'complete',
        description: 'Learning from this conversation (updating memory in the background)',
        at: new Date().toISOString(),
      });
    }

    await writeChatDelta(
      stream,
      deps,
      ws,
      args.agentId,
      args.conversation.id,
      args.clientTurnId,
      { type: 'done', finishReason },
      streamedMetadata,
    );
    await stream.writeSSE({ event: 'done', data: JSON.stringify({ finishReason }) });
  }
}

/**
 * The chat bubble stores the operator's literal text; the agent's prompt gets
 * a short filename note appended so it isn't blind to an attachment it can't
 * yet see the bytes of (no multimodal ingestion wired up here — this is just
 * enough context for the agent to acknowledge and ask about it if relevant).
 */
async function sendConversationMessage(
  c: Context,
  deps: ConversationRouteDeps,
  ws: ReturnType<typeof getWorkspace>,
  agentId: string,
  attachmentContext: ConversationAttachmentContextService,
) {
  const body = sendSchema.parse(await c.req.json());
  const clientTurnId = body.clientTurnId ?? randomUUID();
  const conversationId = c.req.query('conversationId') || null;
  const conversation = conversationId
    ? deps.conversations.getById(ws.workspaceId, conversationId)
    : deps.conversations.getOrCreateByAgent({
        workspaceId: ws.workspaceId,
        ambientId: ws.ambientId,
        userId: ws.user.id,
        agentId,
      });
  // Composer toggle: persist the sticky permission mode with this turn so the
  // executor (and the next turn) honor it. The conversation row is read again in
  // streamConversationTurnReply, so update the in-memory copy too.
  if (body.permissionMode && body.permissionMode !== conversation.permissionMode) {
    deps.db.update(schema.conversations)
      .set({
        permissionMode: body.permissionMode,
        executionMode: body.permissionMode === 'plan' ? 'plan' : 'chat',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.conversations.id, conversation.id))
      .run();
    conversation.permissionMode = body.permissionMode;
  }
  if (body.approvalSensitivity && body.approvalSensitivity !== conversation.approvalSensitivity) {
    deps.db.update(schema.conversations)
      .set({ approvalSensitivity: body.approvalSensitivity, updatedAt: new Date().toISOString() })
      .where(eq(schema.conversations.id, conversation.id))
      .run();
    conversation.approvalSensitivity = body.approvalSensitivity;
  }

  // Explicit corrections are durable before the agent begins work (and even
  // when this message must wait behind another active turn).
  captureImmediateConversationCorrection(deps, ws, {
    agentId,
    conversationId: conversation.id,
    userMessage: body.body,
    useViewportContext: body.useViewportContext,
    viewportOverride: body.viewportOverride as ViewportContext | null | undefined,
  });

  // Queue-then-auto-continue: a turn is already streaming for this
  // conversation (chat, channel dispatcher, or another tab). Rather than race
  // a second live turn, durably queue this send — `streamConversationTurnReply`
  // auto-dispatches it, oldest first, the moment the in-flight turn ends. This
  // check is independent of the request's Accept header: the frontend calls
  // this same endpoint without opening an SSE stream while a turn is active.
  if (activeConversationTurns.has(conversation.id)) {
    const item = deps.conversations.enqueueMessage({
      workspaceId: ws.workspaceId,
      conversationId: conversation.id,
      text: body.body,
      attachments: body.attachments,
    });
    return c.json({ queued: true, item: serializeQueueItem(item), conversationId: conversation.id, agentId }, 202);
  }

  const message = deps.conversations.appendOutbound({
    workspaceId: ws.workspaceId,
    conversationId: conversation.id,
    operatorId: ws.user.id,
    body: body.body,
    metadata: body.attachments?.length ? { clientTurnId, artifactIds: body.attachments } : { clientTurnId },
  });
  if (c.req.header('accept')?.includes('text/event-stream')) {
    const compiled = await attachmentContext.compile({
      workspaceId: ws.workspaceId,
      body: body.body,
      attachmentIds: body.attachments,
      historyMessages: conversationHistoryForTurn(deps, conversation.id, message.id).length,
    });
    return streamConversationTurnReply(c, deps, ws, {
      agentId,
      conversation,
      clientTurnId,
      currentMessageId: message.id,
      userMessage: compiled.prompt,
      useViewportContext: body.useViewportContext,
      viewportOverride: body.viewportOverride as ViewportContext | null | undefined,
      contextManifest: compiled.manifest,
    });
  }
  const reg = deps.adapters.get(agentId);

  if (reg?.adapter instanceof OpenClawAdapter) {
    await relayOpenClaw(deps, reg.adapter, conversation.mirroredSessionId ?? undefined, body.body, agentId);
  }
  return c.json({ message, conversationId: conversation.id, agentId });
}

/**
 * Return an operator-visible correction when an agent declares an App complete
 * while its live conformance report still contains blockers.
 */
export function appCompletionGuard(
  db: AgentisSqliteDb,
  workspaceId: string,
  viewport: ViewportContext | null,
  finalText: string,
): string | null {
  if (viewport?.resourceKind !== 'app' || !viewport.resourceId || !claimsCompletion(finalText)) return null;
  let report: AppDoctorReport;
  try {
    report = validateAppConformance(collectAppDoctorSnapshot(db, workspaceId, viewport.resourceId));
  } catch {
    return null;
  }
  const blockers = report.summary.critical + report.summary.error;
  if (blockers === 0) return null;
  const samples = report.findings
    .filter((finding) => finding.severity === 'critical' || finding.severity === 'error')
    .slice(0, 3)
    .map((finding) => `${finding.code}: ${finding.summary}`)
    .join(' | ');
  return `Verification blocked — I cannot truthfully mark this App ready. App Doctor still reports ${blockers} blocker${blockers === 1 ? '' : 's'} (${report.summary.critical} critical, ${report.summary.error} error).${samples ? ` ${samples}` : ''}`;
}

function claimsCompletion(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  // Do not rewrite an honest negative/blocked hand-off.
  if (/\b(?:not|isn['’]?t|cannot|can['’]?t|unable to)\s+(?:done|complete(?:d)?|fixed|ready)\b/i.test(normalized)) return false;
  return /(?:^|\n)\s*(?:#{1,3}\s*)?(?:done|completed|fixed|ready)\b/i.test(normalized)
    || /\b(?:i(?:'ve| have)?\s+(?:fixed|completed|finished|delivered)|the app is (?:now )?ready|ready for (?:an? )?(?:live|production|approved))\b/i.test(normalized);
}

function captureImmediateConversationCorrection(
  deps: ConversationRouteDeps,
  ws: ReturnType<typeof getWorkspace>,
  args: {
    agentId: string;
    conversationId: string;
    userMessage: string;
    useViewportContext: boolean;
    viewportOverride?: ViewportContext | null;
  },
): void {
  const activeViewport = args.useViewportContext
    ? args.viewportOverride ?? deps.viewportStore?.get(ws.user.id) ?? null
    : args.viewportOverride ?? null;
  deps.memoryCapture?.captureImmediateCorrection?.({
    workspaceId: ws.workspaceId,
    conversationId: args.conversationId,
    userId: ws.user.id,
    agentId: args.agentId,
    userDisplayName: ws.user.displayName,
    userMessage: args.userMessage,
    activeWorkflowId: workflowIdFromViewport(activeViewport),
    activeNodeId: activeViewport?.selection?.ids?.[0] ?? null,
  });
}

async function confirmConversationAction(
  c: Context,
  deps: ConversationRouteDeps,
  ws: ReturnType<typeof getWorkspace>,
  agentId: string,
  durableTurns?: ConversationTurnService,
) {
  const body = confirmSchema.parse(await c.req.json());
  const conversationId = c.req.query('conversationId') || null;
  const conversation = conversationId
    ? deps.conversations.getById(ws.workspaceId, conversationId)
    : deps.conversations.getOrCreateByAgent({
        workspaceId: ws.workspaceId,
        ambientId: ws.ambientId,
        userId: ws.user.id,
        agentId,
      });
  const reg = deps.adapters.get(agentId);
  if (!reg?.adapter?.chat || reg.adapter.capabilities?.().interactiveChat === false) {
    throw new AgentisError('ADAPTER_UNAVAILABLE', 'agent does not support interactive chat confirmations');
  }

  const targetMsg = deps.db
    .select()
    .from(schema.conversationMessages)
    .where(and(
      eq(schema.conversationMessages.conversationId, conversation.id),
      sql`json_extract(${schema.conversationMessages.metadata}, '$.confirmation.turnId') = ${body.turnId}`
    ))
    .get();

  if (targetMsg) {
    const metadata = (typeof targetMsg.metadata === 'string' ? JSON.parse(targetMsg.metadata) : targetMsg.metadata) as Record<string, any>;
    if (metadata && metadata.confirmation) {
      metadata.confirmation.status = body.confirmed ? 'approved' : 'cancelled';
      deps.db
        .update(schema.conversationMessages)
        .set({ metadata })
        .where(eq(schema.conversationMessages.id, targetMsg.id))
        .run();

      const updatedMsg = deps.db
        .select()
        .from(schema.conversationMessages)
        .where(eq(schema.conversationMessages.id, targetMsg.id))
        .get();

      if (updatedMsg) {
        deps.bus.publish(
          REALTIME_ROOMS.conversation(conversation.agentId),
          REALTIME_EVENTS.CONVERSATION_MESSAGE_UPDATED,
          {
            message: serializeConversationMessage(updatedMsg),
            conversationId: conversation.id,
            agentId: conversation.agentId,
          }
        );
      }
    }
  }

  const acceptsSSE = c.req.header('accept')?.includes('text/event-stream');
  if (acceptsSSE) {
    return streamSSE(c, async (stream) => {
      const clientTurnId = body.clientTurnId ?? randomUUID();
      const turnStartedAtMs = Date.now();
      const turnStartedAt = new Date(turnStartedAtMs).toISOString();
      let finalText = '';
      let finishReason: Extract<ChatDelta, { type: 'done' }>['finishReason'] = 'stop';
      let adapterError: string | null = null;
      const streamedMetadata = createStreamedChatMetadata(clientTurnId, turnStartedAt);
      await writeChatDelta(stream, deps, ws, agentId, conversation.id, clientTurnId, createChatActivity({
        clientTurnId,
        agentId,
        phase: 'received',
        label: body.confirmed ? 'Approval received' : 'Cancellation received',
        detail: body.confirmed ? 'Resuming the paused action.' : 'Stopping the paused action.',
        suffix: 'received',
        startedAt: turnStartedAt,
      }), streamedMetadata);
      for await (const delta of ChatSessionExecutor.confirm(reg.adapter, body.turnId, body.confirmed, {
        workspaceId: ws.workspaceId,
        userId: ws.user.id,
        conversationId: conversation.id,
        signal: c.req.raw.signal,
      })) {
        if (isAdapterErrorDelta(delta)) {
          adapterError = delta.error;
          continue;
        }
        if (delta.type === 'done') {
          finishReason = delta.finishReason;
          break;
        }
        await writeChatDelta(stream, deps, ws, agentId, conversation.id, clientTurnId, delta, streamedMetadata);
        if (delta.type === 'text') finalText += delta.delta;
      }

      if (c.req.raw.signal.aborted) finishReason = 'interrupted';

      const turnPlan = deps.plans?.latest(ws.workspaceId, conversation.id) ?? null;
      if (turnPlan && Date.parse(turnPlan.updatedAt) >= turnStartedAtMs) {
        streamedMetadata.plan = turnPlan;
        if (!finalText.trim() && !streamedMetadata.confirmation) {
          finalText = `Plan saved: ${turnPlan.title}. It has ${turnPlan.nodes.filter((node) => node.stage === 'build').length} work steps and is ${turnPlan.status}.`;
          await writeChatDelta(stream, deps, ws, agentId, conversation.id, clientTurnId, {
            type: 'text',
            delta: finalText,
          }, streamedMetadata);
        }
      }

      if (!finalText.trim() && !streamedMetadata.confirmation) {
        if (finishReason === 'interrupted') {
          finalText = 'Stopped by operator.';
        } else if (finishReason === 'error') {
          finalText = relevantTurnError(streamedMetadata, adapterError);
        } else {
          finishReason = 'error';
          finalText = 'The runtime completed the confirmation without returning an answer.';
        }
      }

      const turnCompletedAt = new Date().toISOString();
      const durationMs = Math.max(0, Date.now() - turnStartedAtMs);
      finalizeTurnTrace(streamedMetadata, finishReason, turnCompletedAt, durationMs);
      const failed = streamedMetadata.turn.status === 'failed';
      const interrupted = streamedMetadata.turn.status === 'interrupted';
      await writeChatDelta(stream, deps, ws, agentId, conversation.id, clientTurnId, createChatActivity({
        clientTurnId,
        agentId,
        phase: failed ? 'error' : 'complete',
        status: failed ? 'error' : 'success',
        label: failed ? 'Action failed' : interrupted ? 'Response interrupted' : 'Action complete',
        detail: failed ? finalText : interrupted ? 'Stopped by the operator.' : 'The confirmation turn finished.',
        suffix: 'terminal',
        startedAt: turnCompletedAt,
        completedAt: turnCompletedAt,
        durationMs,
      }), streamedMetadata);

      if (failed) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            code: 'ADAPTER_CHAT_FAILED',
            message: finalText,
          }),
        });
      }
      const hasContentToSave = finalText.trim() || streamedMetadata.confirmation || failed;
      if (hasContentToSave) {
        const bodyToSave = finalText.trim() || streamedMetadata.confirmation?.title || 'Confirmation required';

        const persisted = deps.conversations.appendMirrored({
          workspaceId: ws.workspaceId,
          conversationId: conversation.id,
          sessionMessageId: `chat_${randomUUID()}`,
          authorType: 'agent',
          body: bodyToSave,
          deliveryStatus: failed ? 'failed' : 'delivered',
          metadata: buildPersistedChatMetadata('chat_confirmation', streamedMetadata, clientTurnId),
        });
        if (streamedMetadata.plan && deps.plans) {
          streamedMetadata.plan = deps.plans.attachMessage(ws.workspaceId, streamedMetadata.plan, persisted.id);
        }
        await stream.writeSSE({
          event: 'message',
          data: JSON.stringify({
            id: persisted.id,
            role: 'agent',
            body: persisted.body,
            createdAt: persisted.createdAt,
            metadata: buildPersistedChatMetadata('chat_confirmation', streamedMetadata, clientTurnId),
            deliveryStatus: persisted.deliveryStatus,
          }),
        });
      }
      await writeChatDelta(
        stream,
        deps,
        ws,
        agentId,
        conversation.id,
        clientTurnId,
        { type: 'done', finishReason },
        streamedMetadata,
      );
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ finishReason }) });
      durableTurns?.resolveAwaiting(
        ws.workspaceId,
        conversation.id,
        finishReason === 'error' ? 'failed' : body.confirmed ? 'completed' : 'cancelled',
        finishReason === 'error' ? finalText : null,
      );
    });
  }

  const deltas: unknown[] = [];
  let finalText = '';
  let finishReason: Extract<ChatDelta, { type: 'done' }>['finishReason'] = 'stop';
  for await (const delta of ChatSessionExecutor.confirm(reg.adapter, body.turnId, body.confirmed, {
    workspaceId: ws.workspaceId,
    userId: ws.user.id,
    conversationId: conversation.id,
    signal: c.req.raw.signal,
  })) {
    deltas.push(delta);
    if (delta.type === 'text') finalText += delta.delta;
    if (delta.type === 'done') finishReason = delta.finishReason;
  }
  if (finishReason !== 'error' && finalText.trim()) {
    deps.conversations.appendMirrored({
      workspaceId: ws.workspaceId,
      conversationId: conversation.id,
      sessionMessageId: `chat_${randomUUID()}`,
      authorType: 'agent',
      body: finalText,
    });
  }
  durableTurns?.resolveAwaiting(
    ws.workspaceId,
    conversation.id,
    finishReason === 'error' ? 'failed' : body.confirmed ? 'completed' : 'cancelled',
    finishReason === 'error' ? finalText : null,
  );
  return c.json({ deltas, conversationId: conversation.id, agentId });
}







