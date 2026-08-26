/**
 * Bootstrap composition root.
 *
 * Glue, not logic. The order is significant: env → secrets → db → services →
 * engine → http+ws → start. Reverse on shutdown.
 *
 * Returns a `{ start, stop }` handle so embedders (the CLI, tests, the desktop
 * shell later) drive the lifecycle without re-implementing the wiring.
 */

import { type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Hono } from 'hono';
import { createAdaptorServer } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS, type NormalizedAgentEvent, type AgentAdapter, type RuntimeInputAttachment, type WorkflowGraph, type WorkflowGraphPatch } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AgentisRuntimeHandle, AgentisRuntimeStartResult } from '@agentis/runtime';
import { loadEnv, type AgentisEnv } from './env.js';
import { createLogger, type Logger } from './logger.js';
import { loadOrCreateSecrets, type AgentisSecrets } from './secrets.js';
import { openDatabase, type DbHandle } from './db.js';
import { createInProcessEventBus, type EventBus } from './event-bus.js';
import { CredentialVault } from './services/credentialVault.js';
import { OAuthService } from './services/oauthService.js';
import { buildOAuthRoutes } from './routes/oauth.js';
import { buildMcpOAuthRoutes } from './routes/mcpOAuth.js';
import { McpOAuthService } from './services/mcp/mcpOAuthService.js';
import { AuthService } from './services/auth.js';
import { LedgerService } from './services/ledger.js';
import { ScratchpadService } from './services/scratchpad.js';
import { ActivityFeedService } from './services/activityFeed.js';
import { ObservabilityService } from './services/observability.js';
import { ApprovalInboxService } from './services/approvalInbox.js';
import { ExtensionRuntime } from './services/extensionRuntime.js';
import { SubflowExecutor } from './services/subflowExecutor.js';
import { ConversationStore } from './services/conversation/conversationStore.js';
import { TurnChangeJournal } from './services/conversation/turnChangeJournal.js';
import { ConversationSummaryService } from './services/conversation/conversationSummaryService.js';
import { ConversationHandoffService } from './services/conversation/conversationHandoffService.js';
import { channelModelRole } from './services/conversation/channelConversationRole.js';
import { SessionMirror } from './services/sessionMirror.js';
import { RegistryClient } from './services/registryClient.js';
import { ChannelBridge } from './services/conversation/channelBridge.js';
import { createChannelSendPort } from './services/conversation/channelSend.js';
import { TelegramChannelAdapter } from './adapters/channels/telegram.js';
import { DiscordChannelAdapter } from './adapters/channels/discord.js';
import { SlackChannelAdapter } from './adapters/channels/slack.js';
import { VoiceChannelAdapter } from './adapters/channels/voice.js';
import { isAcknowledgedChannelDelivery, type ChannelDeliveryReceipt } from './adapters/channels/types.js';
import { PartialReplayService } from './services/partialReplay.js';
import { CommandIndex } from './services/command/commandIndex.js';
import { KnowledgeBaseService } from './services/knowledge/knowledgeBase.js';
import { DurableJobQueue } from './services/jobQueue.js';
import { AgentisToolRegistry } from './services/agentisToolRegistry.js';
import { CapabilityRegistry } from './services/capability/capabilityRegistry.js';
import { registerAllTools } from './services/agentisToolHandlers/index.js';
import { ChatToolExecutor } from './services/chat/chatToolExecutor.js';
import { ChatSessionExecutor } from './services/chat/chatSessionExecutor.js';
import { ChatSwarmService } from './services/chat/chatSwarmService.js';
import { RuntimeProfileService } from './services/runtime/runtimeProfileService.js';
import { OrchestratorEventBridge } from './services/orchestrator/orchestratorEventBridge.js';
import { SelectiveWakeSupervisor } from './services/orchestrator/selectiveWakeSupervisor.js';
import { ViewportStore } from './services/viewportStore.js';
import { seedIfEmpty, type SeedResult } from './services/seed.js';
import { mountOpenApi } from './openapi.js';
import { AdapterManager } from './adapters/AdapterManager.js';
import { WorktreeManager } from './services/worktreeManager.js';
import { OrchestratorModelRouter, type ModelProfile } from './services/orchestrator/orchestratorModelRouter.js';
import { WorkspaceHarnessRuntimeResolver, WorkspaceHarnessStructuredCompleter } from './services/workspace/workspaceHarnessRuntime.js';
import { ChannelTurnDispatcher, type ChannelTurnInput } from './services/conversation/channelTurnDispatcher.js';
import { ConversationService } from './services/conversation/conversationService.js';
import { MediaService, compatibleAudioGenerationProvider, openAiImageProvider, openAiSpeechProvider } from './services/mediaService.js';
import { resolveSynthesisCompleter } from './services/agentisToolHandlers/build.js';
import { ChannelTurnQueue } from './services/conversation/channelTurnQueue.js';
import { ChannelUtteranceBatchStore } from './services/conversation/channelUtteranceBatchStore.js';
import { ChannelConnectionSupervisor } from './services/conversation/channelConnectionSupervisor.js';
import { WorkspaceAwarenessService } from './services/workspace/workspaceAwarenessService.js';
import { CapabilityIndex } from './services/capability/capabilityIndex.js';
import { CommandModelService } from './services/command/commandModel.js';
import { CommandHeartbeat, isWorkspaceAutonomyEnabled } from './services/command/commandHeartbeat.js';
import { TranscriptionService } from './services/transcriptionService.js';
import { LocalTranscriptionService } from './services/localTranscriptionService.js';
import { SpeechService } from './services/speechService.js';
import { VisionService } from './services/visionService.js';
import { DocumentExtractionService } from './services/documentExtractionService.js';
import { ConversationAttachmentContextService } from './services/conversation/conversationAttachmentContext.js';
import { RuntimeInputAttachmentStore } from './services/conversation/runtimeInputAttachmentStore.js';
import { ChannelIdentityService } from './services/conversation/channelIdentityService.js';
import { ChannelInboxService } from './services/conversation/channelInboxService.js';
import { ChannelActionIntentService } from './services/conversation/channelActionIntentService.js';
import { WorkspaceModelConfigService } from './services/workspace/workspaceModelConfigService.js';
import { WorkspaceMediaConfigService } from './services/workspace/workspaceMediaConfigService.js';
import { WorkspaceEvaluatorRuntimeFactory } from './services/workspace/workspaceEvaluatorRuntimeFactory.js';
import { buildOrchestratorModelRoutes } from './routes/orchestratorModels.js';
import { WorkflowEngine, type EngineDeps } from './engine/WorkflowEngine.js';
import { ActiveWorkflowRegistry } from './engine/ActiveWorkflowRegistry.js';
import { TriggerRuntime } from './engine/TriggerRuntime.js';
import { ListenerRuntime } from './engine/ListenerRuntime.js';
import { ListenerHealthStore } from './engine/listener/health.js';
import { ExtensionKvStore } from './extensions/kv.js';
import { buildListenerRoutes } from './routes/listeners.js';
import { buildAgentJudge } from './engine/listener/agentJudge.js';
import { errorHandler } from './middleware/error.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { auditLog } from './middleware/auditLog.js';
import { loadTelemetry, type Telemetry } from './telemetry/index.js';
import { buildAuthRoutes } from './routes/auth.js';
import { buildBootstrapRoutes } from './routes/bootstrap.js';
import { buildJwksRoutes } from './routes/jwks.js';
import { buildWorkspaceRoutes } from './routes/workspaces.js';
import { buildWorkflowRoutes } from './routes/workflows.js';
import { buildEphemeralRoutes } from './routes/ephemeral.js';
import { buildRunRoutes } from './routes/runs.js';
import { buildExtensionRoutes } from './routes/extensions.js';
import { buildActivityRoutes } from './routes/activity.js';
import { buildObservabilityRoutes } from './routes/observability.js';
import { buildApprovalRoutes } from './routes/approvals.js';
import { buildDashboardRoutes } from './routes/dashboard.js';
import { buildAgentRoutes } from './routes/agents.js';
import { buildHarnessRoutes } from './routes/harness.js';
import { buildHarnessImportRoutes } from './routes/harnessImport.js';
import { HarnessImportSyncService } from './services/harness/harnessImportSync.js';
import { buildGatewayRoutes } from './routes/gateways.js';
import { buildGatewayMutationRoutes } from './routes/gatewayMutations.js';
import { buildAmbientRoutes } from './routes/ambients.js';
import { buildDomainRoutes } from './routes/domains.js';
import { buildAppRoutes } from './routes/apps.js';
import { buildCapabilityRoutes } from './routes/capabilities.js';
import { buildAppStores } from '@agentis/app';
import { AppStaffingService } from './services/app/appStaffing.js';
import { AppPresenceService } from './services/app/appPresence.js';
import { AppContactService } from './services/app/appContacts.js';
import { RelationshipStateService } from './services/relationshipStateService.js';
import { ConnectionGrantService } from './services/connectionGrants.js';
import { DurableEntityService, DurableEntityDispatcher } from './services/durableEntities.js';
import { SubjectRuntime, channelCorrelationId } from './services/subjectRuntime.js';
import { ResidentAgentDriver } from './services/residentAgentDriver.js';
import { buildResidentWakeHistory } from './services/residency.js';
import { ExperimentService } from './services/experiments.js';
import { ProactiveFollowupService } from './services/proactiveFollowups.js';
import { AppLearningService } from './services/app/appLearning.js';
import { AppGoalService } from './services/app/appGoal.js';
import { StrategyService } from './services/app/strategyService.js';
import { StrategyEvolutionService } from './services/app/strategyEvolution.js';
import { ConversationParticipantService } from './services/conversation/conversationParticipants.js';
import { OutboundPolicyService } from './services/outboundPolicy.js';
import { buildTaskRoutes } from './routes/tasks.js';
import { buildBudgetRoutes } from './routes/budgets.js';
import { BudgetService } from './services/budget.js';
import { defaultConnectorRegistry, connectorCatalog } from '@agentis/integrations';
import { WorkflowStoreService } from './services/workflow/workflowStore.js';
import { WorkspaceStoreService } from './services/workspace/workspaceStore.js';
import { WorkspaceVolumeService } from './services/workspace/workspaceVolume.js';
import { WorkspaceIntelligenceService } from './services/workspace/workspaceIntelligence.js';
import { ExtensionLibraryService } from './services/extensionLibrary.js';
import { AgentLibraryService } from './services/agent/agentLibrary.js';
import { AgentToolRuntime, type AgentToolRuntimeDeps, type PlatformToolBridge } from './services/agent/agentToolRuntime.js';
import { AgentSessionService } from './services/agent/agentSession.js';
import { AgentSessionRuntime } from './services/agent/agentSessionRuntime.js';
import { AgentConsultationService } from './services/agent/agentConsultationService.js';
import { PlanService } from './services/planService.js';
import { BuildSessionService } from './services/buildSessionService.js';
import { LlmSessionAdapter } from './services/llmSessionAdapter.js';
import { PlatformModelService } from './services/platformModelService.js';
import { AgentMemoryService } from './services/agent/agentMemory.js';
import { PersonalBrainService } from './services/personalBrain.js';
import { FailureReflectionService } from './services/failureReflection.js';
import { FeynmanReflectionService } from './services/feynmanReflection.js';
import { WorkflowSelfHealService } from './services/workflow/workflowSelfHeal.js';
import { MemoryReflectionService } from './services/memory/memoryReflectionService.js';
import { BrainAskService } from './services/brain/brainAskService.js';
import { clipRealtimeText, publishAgentWorkStep, workCorrelationId } from './services/agent/agentWorkProgress.js';
import { SpecialistProfileService } from './services/specialist/specialistProfileService.js';
import { SpecialistMindService } from './services/specialist/specialistMindService.js';
import { SpecialistRuntimeService } from './services/specialist/specialistRuntimeService.js';
import { SpecialistEvalService } from './services/specialist/specialistEvalService.js';
import { SpecialistDemandRouter } from './services/specialist/specialistDemandRouter.js';
import { SpecialistTemplateService } from './services/specialist/specialistTemplateService.js';
import { buildSpecialistRoutes } from './routes/specialists.js';
import { buildBrainRoutes } from './routes/brain.js';
// Grounding — the Workspace Brain's organizational reasoning engine.
import { buildGroundingRoutes, buildGroundingWebhookRoutes } from './routes/grounding.js';
import { EvidenceLedgerService } from './grounding/evidenceLedger.js';
import { GroundingSourceFabric } from './grounding/sourceFabric.js';
import { AgentisNativeSource } from './grounding/sources/agentisNativeSource.js';
import { GroundingInvestigationService } from './grounding/investigationService.js';
import { ClaimService } from './grounding/claimService.js';
import { IdentityService } from './grounding/identityService.js';
import { GroundingModelService } from './grounding/modelService.js';
import { GroundingContextComposer } from './grounding/contextComposer.js';
import { GroundingMigrationService } from './grounding/migrationService.js';
import { GroundingDiscoveryService } from './grounding/discovery.js';
import { GroundingExtractionService } from './grounding/extractionService.js';
import { GroundingRuntime } from './grounding/groundingRuntime.js';
// Brain — knowledge graph + memory subsystem.
import {
  LocalEmbeddingProvider,
  ensureDtypeDefault,
  setEmbeddingProgressSink,
  warmLocalEmbeddingModel,
} from './services/embedding/embeddingProvider.js';
import { embeddingRuntimeManager } from './services/embedding/embeddingRuntimeManager.js';
import { EmbeddingProviderRegistry } from './services/embedding/embeddingProviderRegistry.js';
import { KnowledgeStore } from './services/knowledge/knowledgeStore.js';
import { MemoryStore } from './services/memory/memoryStore.js';
import { recordWorkflowLesson, distillFailureLesson, isInstructiveFailure } from './services/workflow/workflowPlaybook.js';
import { WorkflowRevisionService } from './services/workflow/workflowRevisionService.js';
import { bindWorkflowRevisionApproval } from './services/workflow/workflowRevisionApproval.js';
import { WorkflowExperienceService } from './services/workflow/workflowExperienceService.js';
import { SkillService } from './services/skillService.js';
import { SkillMaterializer } from './services/skillMaterializer.js';
import { EvaluatorExampleStore } from './services/evaluatorExampleStore.js';
import { WorkflowBaselineStore } from './services/workflow/workflowBaselineStore.js';
import { RollingBaselineStore } from './services/rollingBaselineStore.js';
import { DatasetIngestion } from './services/datasetIngestion.js';
import { IntelligencePromotion } from './services/intelligencePromotion.js';
import { EpisodicMemoryStore } from './services/episodicMemoryStore.js';
import { HarnessMemoryIngestionService } from './services/harness/harnessMemoryIngestion.js';
import { BrainComposer } from './services/brain/brainComposer.js';
import { SharedIntelligenceService } from './services/sharedIntelligence.js';
import { CognitivePromotionQueueWorker } from './services/cognitivePromotionQueueWorker.js';
import { SessionMomentService } from './services/sessionMomentService.js';
import { PeerProfileService } from './services/peerProfileService.js';
import { ReflectionService } from './services/reflectionService.js';
import { BrainDiscourseService } from './services/brain/brainDiscourseService.js';
import { BrainCompressionService } from './services/brain/brainCompressionService.js';
import { BrainMaintenanceService } from './services/brain/brainMaintenanceService.js';
import { BrainHealthService } from './services/brain/brainHealthService.js';
import { MemoryDropLog } from './services/brain/memoryDropLog.js';
import { bootProfileSnapshot, markBootPhase, markBootReady } from './services/bootProfile.js';
import { KnowledgeAutoLinker } from './services/knowledge/knowledgeAutoLinker.js';
import { EmbeddingBackfillService } from './services/embedding/embeddingBackfill.js';
import { ConfiguredBrainEnrichmentProvider, EnrichedKnowledgeGraphWriter } from './services/brain/brainEnrichment.js';
import { ChatMemoryCaptureService } from './services/chat/chatMemoryCapture.js';
import { BrowserPool } from './services/browserPool.js';
import { createWebSearchProvider } from './services/webSearch.js';
import { ArtifactService } from './services/artifactService.js';
import { AssetStore } from './services/assetStore.js';
import { McpToolBridge, computerUseServerFromEnv } from './services/mcp/mcpToolBridge.js';
import { SpecialistAgentService } from './services/specialist/specialistAgents.js';
import { McpHarnessSessionService } from './services/mcp/mcpHarnessSession.js';
import { AuditTrailService } from './services/auditTrail.js';
import { InstinctEngine } from './services/instinctEngine.js';
import { buildAuditRoutes } from './routes/audit.js';
import { buildAnalyticsRoutes } from './routes/analytics.js';
import { buildMcpRoutes } from './routes/mcp.js';
import { buildMcpServerRoutes } from './routes/mcpServers.js';
import { buildA2aRoutes } from './routes/a2a.js';
import { buildInteractionRoutes } from './routes/interactions.js';
import { buildGovernanceRoutes } from './routes/governance.js';
import { buildWorkflowIoRoutes } from './routes/workflowIo.js';
import { EvaluatorRuntime } from './services/evaluatorRuntime.js';
import type { StructuredCompleter } from './services/structuredCompleter.js';
import { AdapterStructuredCompleter } from './services/structuredCompleter.js';
import { ConversationSimulatorService } from './services/conversation/conversationSimulator.js';
import { buildTerminalRoutes } from './routes/terminal.js';
import { buildCredentialRoutes } from './routes/credentials.js';
import { buildIntegrationRoutes } from './routes/integrations.js';
import { buildTriggerRoutes } from './routes/triggers.js';
import { buildWebhookRoutes } from './routes/webhooks.js';
import { buildSchedulerRoutes } from './routes/scheduler.js';
import { buildCommandAutonomyRoutes } from './routes/commandAutonomy.js';
import { buildConversationRoutes } from './routes/conversations.js';
import { buildRoomRoutes } from './routes/rooms.js';
import { BroadcastDispatcher } from './services/broadcastDispatcher.js';
import { buildHistoryRoutes } from './routes/history.js';
import { buildExtensionRegistryRoutes } from './routes/extensionRegistry.js';
import { buildChannelRoutes } from './routes/channels.js';
import { buildCommandRoutes } from './routes/command.js';
import { buildReplayRoutes } from './routes/replay.js';
import { buildPackageRoutes } from './routes/packages.js';
import { buildSkillRoutes } from './routes/skills.js';
import { buildWorkspaceBundleRoutes } from './routes/workspaceBundle.js';
import { buildSovereigntyRoutes } from './routes/sovereignty.js';
import { PackagerService } from './services/packager.js';
import { hydrateAgentRuntimes } from './services/agent/agentRuntimeHydrator.js';
import { buildArtifactRoutes } from './routes/artifacts.js';
import { buildWorkspaceContextRoutes } from './routes/workspaceContext.js';
import { buildWorkspaceIntelligenceRoutes } from './routes/workspaceIntelligence.js';
import { buildMemoryRoutes } from './routes/memory.js';
import { buildIssueRoutes } from './routes/issues.js';
import { buildKnowledgeBaseRoutes } from './routes/knowledgeBases.js';
import { buildPersonalBrainRoutes } from './routes/personalBrain.js';
import { buildToolRoutes } from './routes/tools.js';
import { runPublishedWorkflow } from './engine/runPublishedWorkflow.js';
import { buildTestHarnessRoutes } from './routes/testHarness.js';
import { listenHttpServer } from './httpServer.js';
import { createRealtimeServer, type RealtimeServer } from './websocket/rooms.js';
import { IssueService } from './services/issues.js';
import { EventChainService, SchedulerService } from './services/scheduler.js';
import { AppOrchestratorService } from './services/app/appOrchestrator.js';
import { RunCompactionService } from './services/run/runCompactionService.js';

export interface BootstrapResult extends AgentisRuntimeHandle<AgentisRuntimeStartResult<HttpServer>> {
  env: AgentisEnv;
  secrets: AgentisSecrets;
  logger: Logger;
  db: DbHandle;
  bus: EventBus;
  seed: SeedResult | null;
}




function publishAdapterRealtime(
  event: NormalizedAgentEvent,
  deps: { db: AgentisSqliteDb; bus: EventBus; logger: Logger },
): void {
  const runId = 'runId' in event ? event.runId : undefined;
  const workflowId = 'workflowId' in event ? event.workflowId : undefined;
  if (!runId || !workflowId) return;

  const agent = deps.db
    .select({ name: schema.agents.name, workspaceId: schema.agents.workspaceId })
    .from(schema.agents)
    .where(eq(schema.agents.id, event.agentId))
    .get();
  const run = agent?.workspaceId
    ? null
    : deps.db
      .select({ workspaceId: schema.workflowRuns.workspaceId })
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .get();
  const workspaceId = agent?.workspaceId ?? run?.workspaceId;
  if (!workspaceId) {
    deps.logger.debug?.('adapter.realtime.no_workspace', { eventType: event.eventType, runId, agentId: event.agentId });
    return;
  }

  const nodeId = 'taskId' in event ? event.taskId : undefined;
  const base = {
    workspaceId,
    runId,
    workflowId,
    nodeId,
    taskId: nodeId,
    agentId: event.agentId,
    agentName: agent?.name,
    at: event.timestamp,
  };

  switch (event.eventType) {
    case 'task.started':
      publishAgentWorkStep(deps.bus, {
        ...base,
        phase: 'start',
        step: 'agent_task',
        description: 'Agent task started',
      });
      break;
    case 'task.progress':
      publishAgentWorkStep(deps.bus, {
        ...base,
        phase: event.phase ?? 'progress',
        step: 'agent_task',
        description: event.message,
        activityId: event.activityId,
        activityKind: event.kind,
        activityStatus: event.status,
        transport: event.transport,
        attempt: event.attempt,
        startedAt: event.startedAt,
        completedAt: event.completedAt,
        durationMs: event.durationMs,
      });
      deps.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE, {
        ...base,
        message: clipRealtimeText(event.message),
        activityId: event.activityId,
        activityKind: event.kind,
        activityPhase: event.phase,
        activityStatus: event.status,
        transport: event.transport,
        attempt: event.attempt,
        startedAt: event.startedAt,
        completedAt: event.completedAt,
        durationMs: event.durationMs,
      }, workCorrelationId(base));
      break;
    case 'task.completed':
      publishAgentWorkStep(deps.bus, {
        ...base,
        phase: 'complete',
        step: 'agent_task',
        description: 'Agent task completed',
      });
      break;
    case 'task.failed':
      publishAgentWorkStep(deps.bus, {
        ...base,
        phase: 'fail',
        step: 'agent_task',
        description: `Agent task failed: ${event.error}`,
      });
      break;
    case 'agent.thinking': {
      const text = clipRealtimeText(event.text ?? '');
      if (!text) return;
      publishAgentWorkStep(deps.bus, {
        ...base,
        phase: 'thinking',
        step: 'reasoning',
        description: text,
      });
      deps.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE, {
        ...base,
        message: text,
      }, workCorrelationId(base));
      break;
    }
    case 'agent.tool_call':
      publishAgentWorkStep(deps.bus, {
        ...base,
        phase: 'tool',
        step: event.tool,
        description: `Tool call: ${event.tool}`,
      });
      deps.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL, {
        ...base,
        tool: event.tool,
        input: event.input,
        result: event.result,
      }, workCorrelationId(base));
      break;
    default:
      break;
  }
}

import { wireFoundation } from './bootstrap/wireFoundation.js';
import { wireRoutes } from './bootstrap/wireRoutes.js';

export async function bootstrap(envSource: NodeJS.ProcessEnv = process.env): Promise<BootstrapResult> {
  // performance.now() origin = process start, so this first mark's atMs IS the
  // module-graph load cost (measured 7–10s under tsx — invisible to log diffs).
  markBootPhase('modules_loaded');
  const foundation = await wireFoundation(envSource);
  markBootPhase('foundation_wired');

  // §PERF-BOOT — identical code measured 2.5–8× slower with the data dir inside
  // a sync client's folder (OneDrive rewrites/locks the SQLite WAL under us).
  // Warn once with the remedy; never block.
  if (/OneDrive|Dropbox|Google Drive|iCloudDrive/i.test(foundation.env.AGENTIS_DATA_DIR)) {
    foundation.logger.warn('agentis.data_dir_in_sync_folder', {
      dataDir: foundation.env.AGENTIS_DATA_DIR,
      remedy: 'Move AGENTIS_DATA_DIR outside synced folders (or exclude it from sync) — measured 2.5-8x faster on every DB and model operation.',
    });
  }

  // §PERF-BOOT — decide the embedding weight precision once, before any
  // pipeline load: fresh installs (no vectors, no downloaded fp32 weights) pin
  // to q8 (~115 MB first run instead of ~449 MB); existing installs pin to
  // their current behavior. Persisted so the choice survives restarts.
  try {
    const hasVectors = Boolean(
      foundation.sqlite.select({ id: schema.memoryEpisodes.id }).from(schema.memoryEpisodes)
        .where(sql`${schema.memoryEpisodes.embedding} IS NOT NULL`).limit(1).get()
      ?? foundation.sqlite.select({ id: schema.knowledgeChunks.id }).from(schema.knowledgeChunks)
        .where(sql`${schema.knowledgeChunks.embedding} IS NOT NULL`).limit(1).get(),
    );
    ensureDtypeDefault(hasVectors);
  } catch (err) {
    foundation.logger.warn('embedding.dtype_default_failed', { message: (err as Error).message });
  }
  // Model download progress goes through the structured logger (throttled to
  // 25% steps inside the provider — never per-chunk).
  setEmbeddingProgressSink((message) => foundation.logger.info('embedding.model_download', { message }));
  const {
    env,
    logger,
    secrets,
    db,
    sqlite,
    bus,
    credentialVault,
    allowedOrigins,
    oauthService,
    mcpOAuthService,
    auth,
    archiveStore,
    ledger,
    scratchpad,
    activity,
    observability,
    approvals,
    extensionKv,
    extensions,
    telemetry,
    adapters,
    worktreeManager,
    workspaceHarnesses,
    workspaceHarnessCompleter,
    subflows,
    conversations,
    sessionMirror,
    extensionRegistry,
    replay,
    commandIndex,
    registry,
    viewportStore,
    knowledgeBaseService,
    auditTrail,
    budgetService,
    workflowStoreService,
    workspaceStoreService,
    workspaceVolume,
    memoryStore,
    workspaceIntelligence,
    extensionLibrary,
    agentLibrary,
    embeddingRegistry,
    embeddingResolver,
    agentMemoryService,
    personalBrain,
    failureReflection,
    specialistProfiles,
    appStores,
    browserPool,
    browserSessionManager,
    artifactService,
    assetStore,
    mcpAllowPrivate,
    computerUseServer,
    mcpToolBridge,
    webSearchProvider,
    agentToolRuntimeDeps,
    agentToolRuntime,
  } = foundation;
  let instinctEngine: InstinctEngine | undefined;
  // Layer 2 — specialist agent library: resolves agent_task.agentRole → a
  // workspace agent (seeding the built-in specialists on first use).
  const specialistAgents = new SpecialistAgentService(sqlite, agentLibrary);

  // Zero-config model derivation from the first connected agent runtime.
  const platformModel = new PlatformModelService({ db: sqlite, vault: credentialVault, logger });
  const orchestratorModelRouter = OrchestratorModelRouter.fromEnv(env, logger);
  // Per-workspace model-role overrides (§4.4) — wired into the router so the
  // conversation runtime (and any workspace-aware consumer) honors them.
  const workspaceModelConfig = new WorkspaceModelConfigService({ db: sqlite, vault: credentialVault, logger });
  orchestratorModelRouter.setConfigProvider(workspaceModelConfig.asConfigProvider());
  // Same "bring your own model" treatment for MEDIA generation (INTEGRATION-CEILING-10X §1).
  const workspaceMediaConfigService = new WorkspaceMediaConfigService({ db: sqlite, vault: credentialVault, logger });
  // Zero-config fallback: when neither Settings nor env name a model for a
  // workspace, derive one from its first connected agent runtime — so connecting
  // any HTTP/LLM agent lights up the whole autonomy stack (sessions, evaluation,
  // tool loop) without touching `.env`. Sits BELOW Settings + env in precedence.
  orchestratorModelRouter.setFallbackProvider((workspaceId) => platformModel.deriveProfile(workspaceId));
  const evaluatorRuntimeFactory = new WorkspaceEvaluatorRuntimeFactory({ router: orchestratorModelRouter, logger });
  const modelAssistedRuntimeEnabled = (workspaceId: string): boolean => {
    const row = sqlite.select({ brainSettings: schema.workspaces.brainSettings })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .get();
    const value = row?.brainSettings;
    let settings: Record<string, unknown> = {};
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      settings = value as Record<string, unknown>;
    } else if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
      } catch {
        settings = {};
      }
    }
    return settings.modelAssistedRuntimeEnabled !== false;
  };
  const evaluatorRuntimeForProfile = (profile: ModelProfile | null): EvaluatorRuntime | undefined => profile
    ? new EvaluatorRuntime({
        baseUrl: profile.baseUrl,
        model: profile.model,
        ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
        logger,
      })
    : undefined;

  // EvaluatorRuntime — the legacy/global path now follows the orchestrator model
  // router too: Settings/env evaluator → orchestrator default → first HTTP agent.
  const evaluatorRuntimeProfile = orchestratorModelRouter.profile('evaluation') ?? orchestratorModelRouter.profile('conversation');
  const evaluatorRuntime = evaluatorRuntimeForProfile(evaluatorRuntimeProfile);
  const defaultCognitiveCompleter: StructuredCompleter = evaluatorRuntime ?? workspaceHarnessCompleter;
  if (!evaluatorRuntime) {
    logger.info('engine.evaluator.endpoint_unconfigured', {
      fallback: 'workspace orchestrator harness after agent runtime hydration',
    });
  } else {
    logger.info('engine.evaluator.enabled', { model: evaluatorRuntimeProfile?.model });
  }

  // Dedicated workflow-synthesis runtime (§6) — decouples `build_workflow` LLM
  // synthesis from the evaluator gate. Prefers its own endpoint; falls back to
  // the evaluator runtime; regex path when neither is configured.
  const synthesisRuntime = env.WORKFLOW_SYNTHESIS_BASE_URL
    ? new EvaluatorRuntime({
        baseUrl: env.WORKFLOW_SYNTHESIS_BASE_URL,
        apiKey: env.WORKFLOW_SYNTHESIS_API_KEY,
        model: env.WORKFLOW_SYNTHESIS_MODEL,
        logger,
      })
    : evaluatorRuntime;

  // Channel bridge (Batch 4 + OMNICHANNEL-ORCHESTRATOR-10X §3): Telegram,
  // Discord, and Slack. Inbound messages run a real orchestrator turn via the
  // ChannelTurnDispatcher wired below (after the chat executor is configured).
  // Voice channel (Living Apps G6 foundation): a webhook-transcription voice line.
  // A provider POSTs a transcribed utterance; it flows through the SAME dispatcher
  // as a text channel, and the agent's reply is buffered for the provider to
  // vocalize (default no-op TTS — the provider speaks the text). Held as a named
  // ref so the voice reply-retrieval route can read its pending-reply buffer.
  const voiceChannelAdapter = new VoiceChannelAdapter();
  const conversationHandoffs = new ConversationHandoffService({ db: sqlite, bus });
  const conversationSummaries = new ConversationSummaryService({ db: sqlite, logger });
  const channelIdentity = new ChannelIdentityService({ db: sqlite, logger });
  const channelInbox = new ChannelInboxService({ db: sqlite, identities: channelIdentity });
  const channelBridge = new ChannelBridge({
    db: sqlite,
    vault: credentialVault,
    conversations,
    bus,
    logger,
    adapters: {
      telegram: new TelegramChannelAdapter(),
      discord: new DiscordChannelAdapter(),
      slack: new SlackChannelAdapter(),
      voice: voiceChannelAdapter,
    },
    artifacts: artifactService,
    handoffs: conversationHandoffs,
    identity: channelIdentity,
  });
  const seed = await seedIfEmpty({ db: sqlite, env, auth, logger });

  // Workspace embedding-provider resolver, forward-declared so consumers can call
  // it lazily after SharedIntelligence is wired below (used by specialist mind,
  // the capability index, etc.). Falls back to a local semantic embedder pre-wire.
  let resolveAbilityEmbeddingProvider: ((workspaceId: string) => import('./services/embedding/embeddingProvider.js').EmbeddingProvider) | undefined;
  const abilityEmbeddings = (workspaceId: string) => {
    if (!resolveAbilityEmbeddingProvider) return new LocalEmbeddingProvider();
    return resolveAbilityEmbeddingProvider(workspaceId);
  };


  const specialistTemplates = new SpecialistTemplateService(sqlite);
  const seededSpecialistTemplates = specialistTemplates.seedPlatformTemplates();
  if (seededSpecialistTemplates > 0) logger.info('specialists.templates.seeded', { count: seededSpecialistTemplates });
  let specialistVision: VisionService | undefined;
  const specialistMind = new SpecialistMindService({
    db: sqlite,
    logger,
    embeddings: abilityEmbeddings,
    vision: () => specialistVision,
  });
  const workflowRevisions = new WorkflowRevisionService(sqlite);
  const workflowExperience = new WorkflowExperienceService(sqlite, specialistMind);
  for (const workflow of sqlite.select({
    id: schema.workflows.id,
    workspaceId: schema.workflows.workspaceId,
  }).from(schema.workflows).all()) {
    try {
      workflowRevisions.reconcileLegacyWorkflow(workflow.workspaceId, workflow.id);
    } catch (error) {
      logger.warn('workflow.revision.legacy_reconcile_failed', {
        workspaceId: workflow.workspaceId,
        workflowId: workflow.id,
        error: (error as Error).message,
      });
    }
  }
  const specialistRuntime = new SpecialistRuntimeService(sqlite);
  const specialistEvals = new SpecialistEvalService(sqlite, specialistMind);
  const specialistRouter = new SpecialistDemandRouter({
    db: sqlite,
    logger,
    specialists: specialistAgents,
    profiles: specialistProfiles,
    mind: specialistMind,
    runtime: specialistRuntime,
  });

  // Persistent agent sessions (SMARTER-AGENTS-10X). The cognitive loop needs a
  // function-calling LLM — but we NEVER force `.env`. The runtime is always
  // constructed and resolves its model per-workspace at dispatch time through
  // the orchestrator model router (Settings → env → first connected agent
  // runtime). When a workspace has no model anywhere, the engine's
  // `canRun(workspaceId)` gate degrades that workspace's `agent_task`s to the
  // tool loop / single-shot dispatch instead of failing.
  const sessionStore = new AgentSessionService(sqlite, logger);
  const planService = new PlanService(sqlite, bus);
  const buildSessionService = new BuildSessionService(sqlite, bus);
  // Late-bound (assigned once the model router exists, below) per-workspace
  // session-adapter resolver + cache so the hot path reuses one adapter instance.
  let resolveSessionAdapter: ((workspaceId: string) => LlmSessionAdapter | undefined) | undefined;
  const sessionAdapterCache = new Map<string, LlmSessionAdapter>();
  // Legacy env adapter retained as an ultimate fallback for env-only deployments.
  const envSessionAdapter = (env.AGENTIS_EVALUATOR_BASE_URL && env.AGENTIS_EVALUATOR_MODEL)
    ? new LlmSessionAdapter({
        baseUrl: env.AGENTIS_EVALUATOR_BASE_URL,
        apiKey: env.AGENTIS_EVALUATOR_API_KEY,
        model: env.AGENTIS_EVALUATOR_MODEL,
        logger,
      })
    : undefined;
  // AGENT-PRIMARY M2 — late-bound so the session runtime can evolve the live run
  // through the engine's contract transaction (engine is constructed just below).
  let evolveGraphFn: ((args: { runId: string; patch: WorkflowGraphPatch }) => ReturnType<WorkflowEngine['evolveGraph']>) | undefined;
  // PAVED-ROAD P3 — late-bound registry bridge so in-run sessions can walk the
  // same build loop (dry_run_workflow / check_run) the chat/MCP surfaces get.
  let platformToolFn:
    | ((toolId: string, args: Record<string, unknown>, ctx: { workspaceId: string; userId?: string; agentId?: string; runId?: string; appId?: string | null; artifactPolicy?: { mode?: 'intentional' | 'all' | 'none'; saveScreenshots?: boolean; saveGeneratedAssets?: boolean } | null; allowedToolIds?: string[] }) => Promise<{ ok: boolean; output?: unknown; error?: string }>)
    | undefined;
  // Late-bound so in-run session steps stream through the engine's activity
  // spine (run room + replayable tail) instead of a live-only bus publish.
  let notifyActivityFn: WorkflowEngine['notifyAgentActivity'] | undefined;
  const sessionRuntime = new AgentSessionRuntime({
    sessions: sessionStore,
    ...(envSessionAdapter ? { adapter: envSessionAdapter } : {}),
    resolveAdapter: (workspaceId: string) => resolveSessionAdapter?.(workspaceId),
    scratchpad,
    plans: planService,
    bus,
    logger,
    agentTools: agentToolRuntime,
    evolvePlan: (args) => {
      if (!evolveGraphFn) return Promise.resolve({ committed: false as const, rejected: 'invalid' as const, regressions: [{ code: 'STRUCTURAL' as const, message: 'evolution engine not ready' }] });
      return evolveGraphFn(args);
    },
    platformTool: (toolId, args, ctx) => {
      if (!platformToolFn) return Promise.resolve({ ok: false, error: 'platform tools are not ready yet.' });
      return platformToolFn(toolId, args, ctx);
    },
    notifyActivity: (args) => notifyActivityFn?.(args),
    // Cross-runtime identity for blackboard entries — resolved from the live
    // adapter registry (in-memory, no DB). (AGENT-COOPERATION-10X §Pillar 2.)
    resolveRuntimeLabel: (agentId: string) => {
      const adapter = adapters.get(agentId)?.adapter;
      return adapter ? { runtime: adapter.adapterType, label: agentId } : undefined;
    },
  });

  // LAYER 0: mints/caches a real model-backed runtime per agent (bound to its id)
  // using the workspace default model — so agent_task always has a working brain.
  let agentRuntimeResolver: ((workspaceId: string, agentId: string, task?: string | null, explicitModel?: string | null) => AgentAdapter | undefined) | undefined;

  const engineDeps: EngineDeps = {
    db: sqlite,
    bus,
    logger,
    ledger,
    scratchpad,
    activity,
    approvals,
    revisions: workflowRevisions,
    workflowExperience,
    extensions,
    adapters,
    subflows,
    knowledgeBases: knowledgeBaseService,
    conversations,
    connectors: defaultConnectorRegistry,
    mcpBridge: mcpToolBridge,
    // Deterministic `channel` node — send on a native connection (WhatsApp/…)
    // from a workflow. Runs as a system caller (no per-agent grant gate).
    channelSend: createChannelSendPort({ channels: channelBridge }),
    appData: appStores.data,
    resolveAppIdForWorkflow: (workspaceId, workflowId) => {
      const row = sqlite
        .select({ appId: schema.workflows.appId })
        .from(schema.workflows)
        .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.id, workflowId)))
        .get();
      return row?.appId ?? undefined;
    },
    // Real accumulated spend for a run + its descendant cohort runs — drives the
    // `converge` budget breaker (cost from the audit trail, tokens from sessions).
    resolveRunSpend: (rootRunId: string) => {
      const runIds = new Set<string>([rootRunId]);
      let frontier = [rootRunId];
      // Walk the subflow run tree (bounded depth — a converge body nests shallowly).
      for (let depth = 0; depth < 12 && frontier.length > 0; depth += 1) {
        const children = sqlite
          .select({ id: schema.workflowRuns.id })
          .from(schema.workflowRuns)
          .where(inArray(schema.workflowRuns.parentRunId, frontier))
          .all()
          .map((r) => r.id)
          .filter((id) => !runIds.has(id));
        for (const id of children) runIds.add(id);
        frontier = children;
      }
      const ids = [...runIds];
      let costCents = 0;
      let tokens = 0;
      try {
        for (const row of sqlite.select({ c: schema.auditEntries.costCents }).from(schema.auditEntries).where(inArray(schema.auditEntries.runId, ids)).all()) {
          costCents += Number(row.c ?? 0);
        }
        for (const row of sqlite.select({ i: schema.agentSessions.totalTokensIn, o: schema.agentSessions.totalTokensOut }).from(schema.agentSessions).where(inArray(schema.agentSessions.runId, ids)).all()) {
          tokens += Number(row.i ?? 0) + Number(row.o ?? 0);
        }
      } catch (err) {
        logger.warn('converge.spend.resolve_failed', { rootRunId, err: (err as Error).message });
      }
      return { costCents, tokens };
    },
    // "Fail-forward, don't dead-end" (COGNITIVE-LOOPING): learn from an instructive
    // node failure so the NEXT build designs the corrective loop. Records a
    // workspace playbook lesson (dedup'd) that build_workflow already recalls.
    recordFailureLesson: (a) => {
      if (!isInstructiveFailure(a.error)) return;
      const wf = sqlite.select({ title: schema.workflows.title }).from(schema.workflows).where(eq(schema.workflows.id, a.workflowId)).get();
      const lesson = distillFailureLesson({ workflowTitle: wf?.title ?? null, nodeTitle: a.nodeTitle, error: a.error });
      recordWorkflowLesson(memoryStore, a.workspaceId, lesson, a.agentId);
    },
    workflowStore: workflowStoreService,
    workspaceStore: workspaceStoreService,
    // Per-workspace evaluation model overrides (§4.4); late-bound factory.
    resolveEvaluatorRuntime: (workspaceId: string, role: 'synthesis' | 'evaluation', hint?: { task?: string | null; purpose?: string | null; explicitModel?: string | null }) =>
      !modelAssistedRuntimeEnabled(workspaceId)
        ? undefined
        : hint?.task
        ? evaluatorRuntimeFactory?.forTask(workspaceId, role, hint.task, hint.purpose ?? role, hint.explicitModel)
        : evaluatorRuntimeFactory?.for(workspaceId, role),
    resolveAgentRuntime: (workspaceId: string, agentId: string, task?: string | null, explicitModel?: string | null) =>
      modelAssistedRuntimeEnabled(workspaceId) ? agentRuntimeResolver?.(workspaceId, agentId, task, explicitModel) : undefined,
    modelAssistedRuntimeEnabled,
    vault: credentialVault,
    workspaceIntelligence,
    browserPool,
    browserSessions: browserSessionManager,
    specialists: specialistAgents,
    specialistProfiles,
    specialistRuntime,
    audit: auditTrail,
    instincts: instinctEngine,
    agentTools: agentToolRuntime,
    agentMemory: agentMemoryService,
    personalBrain,
    failureReflection,
    specialistMind,
    sessions: sessionStore,
    sessionRuntime,
    plans: planService,
    specialistRouter,
    worktrees: worktreeManager,
    telemetry,
  };
  const engine = new WorkflowEngine(engineDeps);
  // Bind the session runtime's evolve callback now that the engine exists (M2).
  evolveGraphFn = (args) => engine.evolveGraph(args);
  notifyActivityFn = (args) => engine.notifyAgentActivity(args);
  // Brain — knowledge graph + memory subsystem (workspace-scoped).
  // §B1.1 — KnowledgeStore keeps a default instance for its synchronous lexical
  // path; the KnowledgeBase service already resolves the per-workspace provider
  // for semantic writes/queries via the registry resolver (wired below).
  const embeddingProvider = new LocalEmbeddingProvider();
  const knowledgeStore = new KnowledgeStore(sqlite, logger, embeddingProvider);
  // memoryStore is constructed earlier (backs authored workspace context too).
  const evaluatorExampleStore = new EvaluatorExampleStore(sqlite, logger);
  const workflowBaselineStore = new WorkflowBaselineStore(sqlite);
  const datasetIngestion = new DatasetIngestion(sqlite, knowledgeStore, memoryStore, evaluatorExampleStore, logger);
  const intelligencePromotion = new IntelligencePromotion(sqlite, memoryStore, logger);
  const episodicMemoryStore = new EpisodicMemoryStore(sqlite, logger, embeddingResolver);
  // §B4 — typed workspace memory now lives in the canonical episode store; wire
  // the facade so MemoryStore writes/reads flow through the unified substrate.
  memoryStore.setEpisodicStore(episodicMemoryStore);
  const harnessMemoryIngestion = new HarnessMemoryIngestionService(episodicMemoryStore, logger);
  const brainComposer = new BrainComposer(
    sqlite,
    knowledgeStore,
    memoryStore,
    evaluatorExampleStore,
    workflowBaselineStore,
    intelligencePromotion,
    datasetIngestion,
    episodicMemoryStore,
    logger,
  );
  const rollingBaselineStore = new RollingBaselineStore(sqlite);
  const SharedIntelligence = new SharedIntelligenceService(sqlite, bus, episodicMemoryStore, logger, embeddingRegistry);
  SharedIntelligence.setModelAssistedRuntimeEnabled(modelAssistedRuntimeEnabled);
  // §B7 — record candidates that did NOT become memory, with the reason, so
  // "why isn't this in my brain?" is answerable from stored data instead of
  // being the invisible default it was at ~40 drop sites.
  const memoryDropLog = new MemoryDropLog(sqlite, logger);
  SharedIntelligence.setDropLog(memoryDropLog);
  // A configured endpoint wins, otherwise each call resolves its workspace's
  // connected orchestrator harness. This keeps brain features available on a
  // zero-config Codex/Claude workspace as well as HTTP model deployments.
  SharedIntelligence.setFormationCompleter(defaultCognitiveCompleter);
  // §P2 — activate the already-built model reranker (was dormant): re-rank the
  // top semantic hits with the cognitive completer before they enter a dispatch
  // context, so the most decision-relevant atoms win the budget.
  SharedIntelligence.setRerankCompleter(defaultCognitiveCompleter);
  harnessMemoryIngestion.setFormationPromoter(SharedIntelligence);
  logger.info('brain.formation_judge.enabled', {
    source: evaluatorRuntime ? 'configured_model' : 'workspace_orchestrator_harness',
    model: evaluatorRuntimeProfile?.model ?? null,
  });
  resolveAbilityEmbeddingProvider = (workspaceId: string) => SharedIntelligence.embeddingProvider(workspaceId);
  knowledgeBaseService.setEmbeddingProviderResolver((workspaceId) => SharedIntelligence.embeddingProvider(workspaceId));
  const brainEnrichment = new ConfiguredBrainEnrichmentProvider(sqlite, logger, {
    enabled: env.AGENTIS_BRAIN_ENRICHMENT_ENABLED,
    baseUrl: env.AGENTIS_EVALUATOR_BASE_URL,
    apiKey: env.AGENTIS_EVALUATOR_API_KEY,
    model: env.AGENTIS_EVALUATOR_MODEL,
    visionModel: env.AGENTIS_BRAIN_VISION_MODEL,
    transcriptionModel: env.AGENTIS_BRAIN_TRANSCRIPTION_MODEL,
  });
  const enrichedGraph = new EnrichedKnowledgeGraphWriter(sqlite, SharedIntelligence, logger, (workspaceId) => SharedIntelligence.embeddingProvider(workspaceId));
  knowledgeBaseService.setEnrichmentProvider(brainEnrichment, enrichedGraph);
  const embeddingBackfill = new EmbeddingBackfillService(knowledgeBaseService, logger);
  const brainQueue = new CognitivePromotionQueueWorker(sqlite, SharedIntelligence, logger);
  const SessionMoments = new SessionMomentService(sqlite, bus, logger, embeddingResolver);
  const PeerProfiles = new PeerProfileService(sqlite, bus, logger);
  agentToolRuntimeDeps.memory = memoryStore;
  instinctEngine = new InstinctEngine(sqlite, bus, memoryStore, logger);
  instinctEngine.bindWorkflowRevisionService(workflowRevisions);
  engineDeps.instincts = instinctEngine;
  engineDeps.sharedIntelligence = SharedIntelligence;
  const skillService = new SkillService(sqlite, memoryStore, SharedIntelligence, logger);
  instinctEngine.bindSkillService(skillService);
  const skillMaterializer = new SkillMaterializer(skillService, logger);
  engineDeps.brainQueue = brainQueue;
  engineDeps.peerProfiles = PeerProfiles;
  PeerProfiles.queue = brainQueue;
  brainQueue.PeerProfiles = PeerProfiles;
  const Reflection = new ReflectionService(sqlite, bus, logger, PeerProfiles, SharedIntelligence);
  brainQueue.Reflection = Reflection;
  // Phase 4 — Feynman repair loop. It inherits the workspace orchestrator
  // harness when no endpoint model has been configured.
  const feynmanReflection = new FeynmanReflectionService(sqlite, SharedIntelligence, logger);
  feynmanReflection.setModelAssistedRuntimeEnabled(modelAssistedRuntimeEnabled);
  feynmanReflection.setCompleter(defaultCognitiveCompleter);
  logger.info('brain.feynman_reflection.enabled', {
    source: evaluatorRuntime ? 'configured_model' : 'workspace_orchestrator_harness',
    model: evaluatorRuntimeProfile?.model ?? null,
  });
  brainQueue.Feynman = feynmanReflection;
  engineDeps.feynmanReflection = feynmanReflection;
  engineDeps.selfHeal = new WorkflowSelfHealService(logger);
  // §C1 — cross-session memory Reflection Engine. Reuses the
  // evaluator runtime for grounded deduction; deterministic-only (no fabricated
  // rules) without one.
  const memoryReflection = new MemoryReflectionService(sqlite, SharedIntelligence, logger);
  memoryReflection.setModelAssistedRuntimeEnabled(modelAssistedRuntimeEnabled);
  memoryReflection.setCompleter(defaultCognitiveCompleter);
  logger.info('brain.memory_reflection.enabled', {
    source: evaluatorRuntime ? 'configured_model' : 'workspace_orchestrator_harness',
    model: evaluatorRuntimeProfile?.model ?? null,
  });
  brainQueue.MemoryReflection = memoryReflection;
  // §C4 — cited-answer recall ("interrogate the brain"). Reuses the evaluator
  // runtime for grounded synthesis; deterministic cited list without one.
  const brainAsk = new BrainAskService(SharedIntelligence, logger);
  brainAsk.setModelAssistedRuntimeEnabled(modelAssistedRuntimeEnabled);
  brainAsk.setCompleter(defaultCognitiveCompleter);
  const brainDiscourse = new BrainDiscourseService(sqlite, SharedIntelligence, PeerProfiles, SessionMoments, bus, logger);
  const chatMemoryCapture = new ChatMemoryCaptureService({
    db: sqlite,
    logger,
    peerProfiles: PeerProfiles,
	    sessionMoments: SessionMoments,
	    brainQueue,
	    memory: memoryStore,
	  });
  const brainCompression = new BrainCompressionService(sqlite, logger, brainQueue);
  const brainMaintenance = new BrainMaintenanceService(sqlite, bus, logger, brainCompression, SessionMoments, (ws) => SharedIntelligence.reembedPending(ws), (ws) => {
    brainQueue.enqueue({ workspaceId: ws, itemType: 'memory_reflection', priority: 'low', payload: { workspaceId: ws, trigger: 'scheduled' } });
  });
  const brainHealth = new BrainHealthService(sqlite, memoryDropLog);
  const knowledgeAutoLinker = new KnowledgeAutoLinker(
    SharedIntelligence,
    logger,
    (workspaceId) => SharedIntelligence.embeddingProvider(workspaceId),
    (args) => brainEnrichment.classifyRelation(args),
  );
  // §PERF-BOOT (GAP A) — repairExisting stays FALSE here. Passing true ran
  // repairOrphanedDocumentLinks synchronously inside bootstrap(): a full scan
  // of every kb_document + chunk + link table, measured 3.2s (NVMe) to ~8s
  // (real 732 MB workspace) on EVERY boot, before the port could bind. It is
  // idempotent housekeeping, not a first-request dependency — start() schedules
  // it after hydration instead.
  knowledgeBaseService.setAutoLinker(knowledgeAutoLinker, false);

  void brainDiscourse; void brainQueue;
  const issues = new IssueService({ db: sqlite, bus, engine, ledger, conversations, adapters, logger });
  // PAVED-ROAD P4 — the Sentinel: failed production runs file deduped,
  // actionable Issues (diagnosis + exact next calls) instead of dying silently.
  instinctEngine.bindIssueService(issues);

  // Durable job queue (polling-based, survives restarts). Started after the
  // engine is constructed; stopped on shutdown.
  const jobQueue = new DurableJobQueue({ db: sqlite, engine, logger });

  // Persistent listener runtime. Its fire() is bound to the
  // TriggerRuntime constructed just below; we use a late ref to break the cycle
  // (fire is only ever invoked at runtime, after assignment).
  const listenerHealth = new ListenerHealthStore();
  let triggerRuntimeRef: TriggerRuntime;
  const listenerRuntime = new ListenerRuntime({
    db: sqlite,
    logger,
    bus,
    workflowStore: workflowStoreService,
    health: listenerHealth,
    extensionRuntime: extensions,
    agentJudge: buildAgentJudge(adapters, logger),
    fire: (args) => triggerRuntimeRef.fire(args),
    allowPrivateNetwork: String(process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
  });

  // Trigger runtime needs the engine; wire after engine construction.
  const triggerRuntime = new TriggerRuntime({
    db: sqlite,
    logger,
    registry,
    engine,
    adapters,
    bus,
    jobQueue,
    listenerRuntime,
    revisions: workflowRevisions,
  });
  triggerRuntimeRef = triggerRuntime;

  // SWIFT-T (§2-T4): a hardened workflow that REGRESSES in production (verdict
  // not accomplished) pauses its unattended triggers — a deficient workflow
  // must not keep firing on a schedule. The engine already demoted the
  // hardened stamp and the Sentinel filed the Issue; this closes the loop.
  engineDeps.onWorkflowDemoted = ({ workspaceId, workflowId, runId, verdict }) => {
    void (async () => {
      try {
        const rows = sqlite
          .select()
          .from(schema.triggers)
          .where(and(eq(schema.triggers.workspaceId, workspaceId), eq(schema.triggers.workflowId, workflowId)))
          .all()
          .filter((row) => row.status === 'active' && row.triggerType !== 'manual');
        for (const row of rows) {
          await triggerRuntime.deactivate(row.id).catch(() => {});
          sqlite.update(schema.triggers)
            .set({ status: 'paused', updatedAt: new Date().toISOString() })
            .where(eq(schema.triggers.id, row.id))
            .run();
        }
        if (rows.length > 0) {
          logger.warn('swift.triggers_paused_on_demotion', {
            workflowId, runId, verdict: verdict.outcome, paused: rows.length,
          });
        }
      } catch (err) {
        logger.warn('swift.demotion_pause_failed', { workflowId, error: (err as Error).message });
      }
    })();
  };

  const scheduler = new SchedulerService({ db: sqlite, bus, engine, logger, issues });
  const eventChain = new EventChainService({ db: sqlite, bus, engine, logger });
  // Multi-workflow rules executor for Agentic Apps (APP-INTERFACE-10X §2.3):
  // dependsOn chains + App-level binding schedules + run-all — every start goes
  // through queueWorkflowRun (the same path as schedules/event-chains).
  const appOrchestrator = new AppOrchestratorService({ db: sqlite, bus, engine, logger });
  scheduler.registerSweep('app_binding_schedules', 15_000, (now) => appOrchestrator.sweepSchedules(now));
  const runCompaction = new RunCompactionService({
    db: sqlite,
    logger,
    archiveStore,
    dataDir: env.AGENTIS_DATA_DIR,
    keepFullStateDays: env.AGENTIS_STORAGE_FULL_RUN_DAYS,
    keepLedgerDays: env.AGENTIS_STORAGE_LEDGER_DAYS,
    keepObservabilityDays: env.AGENTIS_STORAGE_OBSERVABILITY_DAYS,
    intervalMs: env.AGENTIS_STORAGE_MAINTENANCE_INTERVAL_MS,
    maxHotDbBytes: env.AGENTIS_STORAGE_MAX_HOT_DB_MB * 1024 ** 2,
    minFreeBytes: env.AGENTIS_STORAGE_MIN_FREE_MB * 1024 ** 2,
    // Production installations self-maintain after boot. Development/test
    // workspaces only run on the normal cadence, avoiding surprise fixture churn.
    runOnStart: env.NODE_ENV === 'production',
    reclaimStorage: () => {
      db.sqliteRaw?.pragma('wal_checkpoint(PASSIVE)');
      if (Number(db.sqliteRaw?.pragma('auto_vacuum', { simple: true })) === 2) {
        db.sqliteRaw?.pragma('incremental_vacuum(2048)');
      }
    },
  });

  const turnChanges = new TurnChangeJournal({ sqlite: db.sqliteRaw!, logger, bus });
  const toolRegistry = new AgentisToolRegistry({ logger, turnChanges });
  // The compressed, searchable map of the whole workspace (apps/workflows/nodes/
  // phases/agents/extensions/mounted MCP tools) — backs the agentis.capability.*
  // reach tools and the Command Model briefing. Reuses the per-workspace embedding
  // provider the Brain and abilities already use, so search is real-semantic with no
  // extra config; the MCP bridge makes mounted third-party tools reachable by URN.
  const capabilityIndex = new CapabilityIndex({
    db: sqlite,
    logger,
    embeddingProvider: abilityEmbeddings,
    mcpTools: (ws) => mcpToolBridge.listTools(ws),
    // Partition the runnable connector catalog by real vault state so the agent's
    // resident "mounted connections" block names what is credentialed vs. merely
    // supported — the same existence check agentis.integration.list uses, so the
    // prompt and the tool never disagree. Existence only; no secret is read.
    configuredIntegrations: (ws) => {
      const configured: string[] = [];
      const available: string[] = [];
      for (const c of connectorCatalog()) {
        if (c.readiness !== 'runnable') continue;
        let hasCred = false;
        try {
          hasCred = engine.hasIntegrationCredential(ws, c.service);
        } catch {
          hasCred = false;
        }
        (hasCred ? configured : available).push(c.name);
      }
      return { configured, available };
    },
  });
  // The capability index doubles as the agent-facing "what is mounted" plane, so
  // the workflow dispatch prompt injects the SAME live connections block that chat
  // does. engineDeps is read live by the engine, so setting it post-construction is
  // enough (see appBrain below).
  engineDeps.capabilityIndex = capabilityIndex;
  // App-mind loop (G10) — constructed here (deps ready since §Brain) so the Command
  // Model can fuse each App's graded lessons into a manager's briefing. Referenced
  // later by the app routes + scheduler sweep.
  const appLearning = new AppLearningService({ db: sqlite, shared: SharedIntelligence, logger, reflection: memoryReflection, baselines: rollingBaselineStore });
  // Every terminal run deposits its graded outcome into the scope that owns it (the
  // App, else the workflow) — the writer that makes an App's Brain map fill.
  engineDeps.appBrain = appLearning;
  // The fractal Command Model — an orchestrator/manager's progressive comprehension
  // of what it manages: scoped inventory + progress/deltas + App minds.
  const commandModel = new CommandModelService({ db: sqlite, logger, appLearning });
  engineDeps.commandModel = commandModel;
  // §3.0/§3.3/§3.5 — spine + connection grants + experiments, shared by the tool
  // handlers, the dispatcher, AND the Mission Control read routes (§3.6).
  const durableEntities = new DurableEntityService(sqlite);
  const connectionGrants = new ConnectionGrantService(sqlite, process.env.AGENTIS_ENFORCE_CONNECTION_GRANTS === 'true');
  const appGoal = new AppGoalService({ db: sqlite, bus, shared: SharedIntelligence, logger });
  const strategies = new StrategyService({ db: sqlite, shared: SharedIntelligence, logger });
  const strategyEvolution = new StrategyEvolutionService({ strategies, logger, db: sqlite });
  // Evolution Loop MEASURE→LEARN bridge — a recorded A/B outcome counts against
  // the strategy for that arm (outcome-weighted, not recurrence-weighted).
  const experiments = new ExperimentService(sqlite, (evt) => {
    void strategies.recordExperimentOutcome(evt);
  });
  const consultations = new AgentConsultationService({
    db: sqlite,
    adapters,
    bus,
    logger,
    activity,
    approvals,
    specialistRouter,
    resolveAgentRuntime: (workspaceId, agentId, task, explicitModel) =>
      modelAssistedRuntimeEnabled(workspaceId) ? agentRuntimeResolver?.(workspaceId, agentId, task, explicitModel) : undefined,
    runTurn: (adapter, history, userMessage, context, options) =>
      ChatSessionExecutor.turn(adapter, history, userMessage, context, options),
    confirmTurn: (adapter, turnId, confirmed, guard) =>
      ChatSessionExecutor.confirm(adapter, turnId, confirmed, guard),
  });
  const consultationTerminalRunEvents = new Set<string>([REALTIME_EVENTS.RUN_CANCELLED, REALTIME_EVENTS.RUN_FAILED, REALTIME_EVENTS.RUN_COMPLETED]);
  bus.subscribe((message) => {
    if (!consultationTerminalRunEvents.has(message.envelope.event)) return;
    const payload = message.envelope.payload as { workspaceId?: string; runId?: string };
    if (!payload.workspaceId || !payload.runId || message.room !== REALTIME_ROOMS.workspace(payload.workspaceId)) return;
    consultations.cancelByRun(payload.workspaceId, payload.runId, `parent run ${message.envelope.event.replace('run.', '')}`);
  });
  const toolHandlerDeps = {
    db: sqlite,
    logger,
    bus,
    engine,
    revisions: workflowRevisions,
    workflowExperience,
    adapters,
    vault: credentialVault,
    skillMaterializer,
    capabilityIndex,
    commandModel,
    // Same resolver the engine uses at dispatch — lets the build connect a freshly
    // cast specialist to the workspace's default runtime so it isn't an offline
    // placeholder (and model routing gets real candidates).
    resolveAgentRuntime: (workspaceId: string, agentId: string, task?: string | null, explicitModel?: string | null) =>
      modelAssistedRuntimeEnabled(workspaceId) ? agentRuntimeResolver?.(workspaceId, agentId, task, explicitModel) : undefined,
    ledger,
    scratchpad,
    approvals,
    activity,
    consultations,
    replay,
    knowledgeBases: knowledgeBaseService,
    memory: memoryStore,
    episodes: episodicMemoryStore,
    sharedIntelligence: SharedIntelligence,
    skills: skillService,
    // Late-bound: the model router is constructed below. The closure is only
    // invoked at build_workflow time, by which point the factory is assigned.
    resolveEvaluatorRuntime: (workspaceId: string, role: 'synthesis' | 'evaluation', hint?: { task?: string | null; purpose?: string | null; explicitModel?: string | null }) =>
      !modelAssistedRuntimeEnabled(workspaceId)
        ? undefined
        : hint?.task
        ? evaluatorRuntimeFactory?.forTask(workspaceId, role, hint.task, hint.purpose ?? role, hint.explicitModel)
        : evaluatorRuntimeFactory?.for(workspaceId, role),
    workspaceIntelligence,
    agentLibrary,
    extensionLibrary,
    extensionRuntime: extensions,
    specialists: specialistAgents,
    specialistProfiles,
    specialistRuntime,
    specialistRouter,
    plans: planService,
    buildSessions: buildSessionService,
    channels: channelBridge,
    channelIdentity,
    channelInbox,
    channelActions: undefined as ChannelActionIntentService | undefined,
    browserPool,
    browserSessions: browserSessionManager,
    artifacts: artifactService,
    assetStore,
    mcpBridge: mcpToolBridge,
    // Assigned once the model router is constructed below. Build handlers close
    // over this object by reference, so the late assignment is visible to them.
    modelRouter: undefined as OrchestratorModelRouter | undefined,
    // Assigned below once the model router exists (conversation compose/classify
    // need a completer). Handlers close over this object, so the late set is seen.
    conversation: undefined as ConversationService | undefined,
    media: undefined as MediaService | undefined,
    // §3.3 — per-agent scoped authority over connections. Enforced at the send door;
    // ungoverned (open) until the first grant exists, unless globally hardened.
    connectionGrants,
    // §3.1 — resident session store, backs agentis.residency.remember (cross-wake continuity).
    sessionStore,
    parkResidentRuns: ({
      workspaceId,
      agentId,
      runIds,
      conversationId,
    }: {
      workspaceId: string;
      agentId: string;
      runIds: string[];
      conversationId?: string | null;
    }) => {
      if (!autonomyGate(workspaceId)) return false;
      const session = sessionStore.getOrCreateResident({ workspaceId, agentId });
      if (conversationId) {
        const marker = `[Durable origin conversation:${conversationId}]`;
        const alreadyCarried = sessionStore.getRecentMessages(session.id, 30)
          .some((message) => message.content.includes(marker));
        if (!alreadyCarried) {
          const origin = sqlite.select({
            channelConnectionId: schema.conversations.channelConnectionId,
            channelChatId: schema.conversations.channelChatId,
          }).from(schema.conversations).where(and(
            eq(schema.conversations.id, conversationId),
            eq(schema.conversations.workspaceId, workspaceId),
          )).get();
          const recent = sqlite.select({
            authorType: schema.conversationMessages.authorType,
            participantSide: schema.conversationMessages.participantSide,
            body: schema.conversationMessages.body,
            metadata: schema.conversationMessages.metadata,
          }).from(schema.conversationMessages).where(and(
            eq(schema.conversationMessages.conversationId, conversationId),
            eq(schema.conversationMessages.workspaceId, workspaceId),
          )).orderBy(desc(schema.conversationMessages.createdAt)).limit(6).all().reverse();
          const originHeader = [
            marker,
            origin?.channelConnectionId ? `channelConnectionId: ${origin.channelConnectionId}` : '',
            origin?.channelChatId ? `channelChatId: ${origin.channelChatId}` : '',
            'When this work settles, continue/reply in this originating conversation.',
          ].filter(Boolean).join('\n');
          sessionStore.appendMessages(session.id, [
            { role: 'user', content: originHeader },
            ...recent.map((message) => ({
              role: channelModelRole(message, Boolean(origin?.channelConnectionId)) === 'user'
                ? 'user' as const
                : 'assistant' as const,
              content: message.body,
            })),
          ], session.totalSteps);
        }
      }
      const existingRunIds = session.status === 'waiting' && Array.isArray(session.suspendPayload?.runIds)
        ? session.suspendPayload.runIds.filter((value): value is string => typeof value === 'string')
        : [];
      const awaitedRunIds = [...new Set([...existingRunIds, ...runIds])];
      sessionStore.suspend(session.id, 'await_event', `runs:${awaitedRunIds.join(',')}`, { runIds: awaitedRunIds });
      // Close the settle-between-check-and-suspend race. A terminal run needs no
      // future event, so do not leave the resident parked waiting for one.
      const allSettled = awaitedRunIds.every((runId) => {
        const row = sqlite.select({ status: schema.workflowRuns.status })
          .from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
        return !row || ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'COMPLETED_WITH_CONTRACT_VIOLATION', 'FAILED', 'CANCELLED', 'PAUSED', 'WAITING'].includes(row.status);
      });
      if (allSettled) {
        sessionStore.wake(session.id);
        return false;
      }
      return true;
    },
    wakeResident: ({ workspaceId, agentId }: { workspaceId: string; agentId: string }) => {
      const session = sessionStore.getOrCreateResident({ workspaceId, agentId });
      if (session.status === 'waiting') sessionStore.wake(session.id);
    },
    // §3.5 — experiment/variant substrate (A/B of any decision + per-variant success rate).
    experiments,
    // Evolution Loop — the App's durable Goal (north-star), backs agentis.app.goal.
    appGoal,
    // Evolution Loop — competing strategies (outcome-weighted), backs agentis.strategy.*.
    strategies,
    // Evolution Loop — the controller (winner selection + promote/retire), backs agentis.evolution.review.
    evolution: strategyEvolution,
    // §3.0/§3.2 — the Durable Entity spine, backs agentis.subject.* (per-subject durable actors).
    durableEntities,
    modelAssistedRuntimeEnabled,
  };
  registerAllTools(toolRegistry, toolHandlerDeps);
  ChatToolExecutor.configure({ registry: toolRegistry, logger });
  // E2 (AGENT-WORKFLOW-CAPABILITY-10X) — give in-engine workflow agents the
  // `agentis.*` integration catalog (channels, cooperation, app/data management, …)
  // as platform tools alongside their native + MCP-bridged tools, so a workflow
  // agent is a full Agentis citizen. Wired lazily here (the runtime holds its deps
  // by reference) now that the registry is populated.
  agentToolRuntimeDeps.platformTools = makeWorkflowPlatformToolBridge(toolRegistry);
  const capabilityRegistry = new CapabilityRegistry({
    db: sqlite,
    logger,
    nativeTools: toolRegistry,
    toolRuntime: agentToolRuntime,
    ledger,
    recordInvocation: (record) => logger.info('capability.invoke', { ...record }),
    callWorkflow: async (args) => {
      const workflow = sqlite
        .select({ id: schema.workflows.id, ambientId: schema.workflows.ambientId, graph: schema.workflows.graph })
        .from(schema.workflows)
        .where(and(eq(schema.workflows.workspaceId, args.workspaceId), eq(schema.workflows.id, args.workflowId)))
        .get();
      if (!workflow) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow not found: ${args.workflowId}`);
      return runPublishedWorkflow({
        db: sqlite,
        engine,
        workspaceId: args.workspaceId,
        ambientId: args.ambientId ?? workflow.ambientId ?? null,
        userId: args.actingSeatId,
        workflowId: workflow.id,
        graph: workflow.graph as WorkflowGraph,
        inputs: args.inputs,
      });
    },
  });
  // Give the self-heal deep replan the SAME full tool surface chat has, so the
  // orchestrator can CREATE what a failed run needs (agents, extensions, abilities).
  engineDeps.toolRegistry = toolRegistry;
  // PAVED-ROAD P3 — bind the session runtime's loop-tool bridge now that the
  // registry is live: in-run agents can dry_run/check the workflows they build
  // through the exact same handlers chat and MCP use (one door, no duplicates).
  platformToolFn = async (toolId, args, ctx) => {
    const res = await toolRegistry.execute(
      { id: '', toolId, arguments: args },
      {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId ?? ctx.agentId ?? 'agent-session',
        ambientId: null,
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
        ...(ctx.runId ? { runId: ctx.runId } : {}),
        ...(ctx.appId ? { appId: ctx.appId } : {}),
        ...(ctx.artifactPolicy ? { artifactPolicy: ctx.artifactPolicy } : {}),
        ...(ctx.allowedToolIds ? { allowedToolIds: ctx.allowedToolIds } : {}),
        caller: 'workflow',
      },
    );
    return res.ok
      ? { ok: true, output: res.output }
      : { ok: false, error: `${res.errorCode}: ${res.errorMessage}` };
  };

  // Workflow-dispatched agents get a concise awareness manifest of the
  // platform tools (mcp-exposed subset) so CLI agents running a node know the
  // Agentis surface exists (CHAT-10X-VISION §4.4.2). Awareness only — workflow
  // dispatch is fire-and-forget; interactive execution stays on the chat path.
  adapters.setToolManifestProvider(() =>
    toolRegistry.catalog({ mcpOnly: true }).tools.map((tool) => ({ name: tool.id, description: tool.description })),
  );

  // Workspace situational model — the orchestrator's channel-independent
  // awareness (roster, in-motion runs, approvals, channels). OMNICHANNEL §4.1.
  const workspaceAwareness = new WorkspaceAwarenessService({ db: sqlite, logger });

  // The session runtime resolves its per-workspace cognitive model through the
  // orchestrator router (Settings → env → first connected agent).
  resolveSessionAdapter = (workspaceId: string): LlmSessionAdapter | undefined => {
    if (!modelAssistedRuntimeEnabled(workspaceId)) return undefined;
    const profile = orchestratorModelRouter.profile('evaluation', workspaceId)
      ?? orchestratorModelRouter.profile('conversation', workspaceId);
    if (!profile) return undefined;
    const key = `${profile.baseUrl}|${profile.model}|${profile.apiKey ?? ''}`;
    let adapter = sessionAdapterCache.get(key);
    if (!adapter) {
      adapter = new LlmSessionAdapter({
        baseUrl: profile.baseUrl,
        ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
        model: profile.model,
        logger,
      });
      sessionAdapterCache.set(key, adapter);
    }
    return adapter;
  };
  logger.info('engine.sessions.enabled', { resolution: 'per-workspace (settings → env → first agent)' });
  // Wire the router into build_workflow so synthesis can route around a slow
  // per-call CLI harness through the configured streaming model — zero extra setup.
  toolHandlerDeps.modelRouter = orchestratorModelRouter;
  // GAP B1/B3 — the per-contact Conversation State Machine. Bound after the model
  // router exists (compose/classify stages need a completer). It reuses the App
  // datastore (script + contacts), the channel bridge (deterministic sends), and
  // the engine (run_workflow stages). The dispatcher offers each inbound to it
  // first; the bus RUN_COMPLETED hook below wakes a contact when its build finishes.
  const conversationService = new ConversationService({
    db: sqlite,
    bus,
    engine,
    channels: channelBridge,
    resolveCompleter: (workspaceId: string, task: string) => resolveSynthesisCompleter(toolHandlerDeps, workspaceId, undefined, task),
    learning: appLearning,
    sharedIntelligence: SharedIntelligence,
    logger,
  });
  toolHandlerDeps.conversation = conversationService;
  // Resume-on-completion: a run_workflow stage rests until its run finishes. The
  // engine emits RUN_COMPLETED/RUN_FAILED to the run room AND the workspace room —
  // handle only the workspace-room copy so each run advances the contact ONCE.
  bus.subscribe((msg) => {
    const ev = msg.envelope.event;
    if (ev !== REALTIME_EVENTS.RUN_COMPLETED && ev !== REALTIME_EVENTS.RUN_FAILED) return;
    const p = msg.envelope.payload as { runId?: string; status?: string; workflowId?: string; workspaceId?: string };
    if (!p?.runId || !p.workspaceId || msg.room !== REALTIME_ROOMS.workspace(p.workspaceId)) return;
    void conversationService.onRunComplete({ runId: p.runId, status: p.status ?? 'COMPLETED', workflowId: p.workflowId, workspaceId: p.workspaceId });
  });
  // Generic multimodal generation (image today). One env-configured OpenAI-compatible
  // provider is registered behind the pluggable MediaProvider seam — swap it or add
  // audio/video / a home-grown harness with mediaService.register(...). No API key ⇒
  // the capability simply isn't offered (agentis.media.generate errors cleanly).
  // registerConfigurable (not a plain register) means a workspace can override
  // {baseUrl, model, apiKey} from Settings → Media — point at OpenRouter, a
  // self-hosted endpoint, or just a different model — with no restart, the same
  // "bring your own model" treatment chat models already had (INTEGRATION-CEILING-10X §1).
  const mediaService = new MediaService({ assetStore, logger, workspaceMediaConfig: workspaceMediaConfigService });
  mediaService.registerConfigurable({
    modality: 'image',
    envDefaults: {
      baseUrl: env.AGENTIS_MEDIA_IMAGE_BASE_URL,
      model: env.AGENTIS_MEDIA_IMAGE_MODEL,
      ...(env.AGENTIS_MEDIA_IMAGE_API_KEY ? { apiKey: env.AGENTIS_MEDIA_IMAGE_API_KEY } : {}),
    },
    build: openAiImageProvider,
  });
  mediaService.registerConfigurable({
    modality: 'speech',
    envDefaults: {
      baseUrl: env.AGENTIS_MEDIA_SPEECH_BASE_URL,
      model: env.AGENTIS_MEDIA_SPEECH_MODEL,
      ...(env.AGENTIS_MEDIA_SPEECH_API_KEY ? { apiKey: env.AGENTIS_MEDIA_SPEECH_API_KEY } : {}),
    },
    build: openAiSpeechProvider,
  });
  mediaService.registerConfigurable({
    modality: 'audio',
    envDefaults: {
      baseUrl: env.AGENTIS_MEDIA_AUDIO_BASE_URL,
      model: env.AGENTIS_MEDIA_AUDIO_MODEL,
      ...(env.AGENTIS_MEDIA_AUDIO_API_KEY ? { apiKey: env.AGENTIS_MEDIA_AUDIO_API_KEY } : {}),
    },
    build: compatibleAudioGenerationProvider,
  });
  toolHandlerDeps.media = mediaService;
  // LAYER 0: agent_task runtime inheritance — bind the workspace default model to
  // any agent that has no explicit adapter, so specialists actually run.
  agentRuntimeResolver = (workspaceId: string, agentId: string, task?: string | null, explicitModel?: string | null) =>
    modelAssistedRuntimeEnabled(workspaceId) ? orchestratorModelRouter.resolveForAgent(agentId, workspaceId, task, explicitModel) : undefined;
  const orchestratorRuntime = orchestratorModelRouter.resolve('conversation');
  logger.info('chat.orchestrator_runtime', {
    enabled: Boolean(orchestratorRuntime),
    models: orchestratorModelRouter.describe(),
  });
  const runtimeProfiles = new RuntimeProfileService(sqlite, adapters, logger);
  const chatSwarms = new ChatSwarmService({ db: sqlite, adapters, logger });
  ChatSessionExecutor.configure({
    db: sqlite,
    logger,
    bus,
    adapters,
    orchestratorRuntime,
    modelRouter: orchestratorModelRouter,
    workspaceHarnesses,
    agentMemory: agentMemoryService,
    sharedIntelligence: SharedIntelligence,
    personalBrain,
    workspaceIntelligence,
    knowledgeBases: knowledgeBaseService,
    brainDiscourse,
    awareness: workspaceAwareness,
    browserSessions: browserSessionManager,
    capabilityIndex,
    commandModel,
    runtimeProfiles,
    audit: auditTrail,
    budget: budgetService,
    chatSwarms,
  });
  const mcpHarness = McpHarnessSessionService.fromEnv(env as unknown as NodeJS.ProcessEnv, sqlite, logger);

  // Cross-surface peer identity — recognizes the same human across channels.
  const appContacts = new AppContactService(sqlite);
  const relationships = new RelationshipStateService({ db: sqlite, entities: durableEntities, identities: channelIdentity });
  const channelUtterances = new ChannelUtteranceBatchStore(sqlite);
  // Outbound safety envelope (G7): per-App rate limit + quiet hours + claim guard
  // over apps.policyJson.outbound. Gates the *unsupervised* outbound paths.
  const outboundPolicy = new OutboundPolicyService({ db: sqlite, logger });
  const channelActions = new ChannelActionIntentService({
    db: sqlite,
    logger,
    channels: channelBridge,
    inbox: channelInbox,
    grants: connectionGrants,
    policy: outboundPolicy,
    approvals,
  });
  toolHandlerDeps.channelActions = channelActions;
  // Multi-party threads (G1): customer + resident agent + escalation specialist +
  // human operator in one thread, with warm handoff via active 'specialist' routing.
  const conversationParticipants = new ConversationParticipantService(sqlite, logger);
  // (appLearning constructed earlier, at the tool-wiring site, so the Command Model
  // can fuse App minds into a manager briefing.)

  // Conversation rehearsal (Phase 5 · G8) — drive a synthetic customer through a
  // scenario against the REAL resident-agent path (ChatSessionExecutor.turn) in a
  // sandboxed conversation (no channel send), then score the transcript. The
  // synthetic customer + holistic judge use the agent's own adapter when it can
  // chat, else the orchestrator runtime — the same fallback the dispatcher uses.
  const conversationSimulator = new ConversationSimulatorService({
    db: sqlite,
    adapters,
    logger,
    completer: (workspaceId, agentId) => {
      const own = adapters.get(agentId)?.adapter;
      const adapter = (own?.chat && own.capabilities?.().interactiveChat !== false)
        ? own
        : ChatSessionExecutor.orchestratorAdapter(workspaceId);
      return adapter?.chat ? new AdapterStructuredCompleter(adapter, `simulator:${agentId}`) : undefined;
    },
  });

  // In-thread outbound approval (G7 / Phase 2): when an App-bound outbound crosses
  // the policy's `requireApprovalFor` line, surface a one-line approval to the
  // operator (the existing approval inbox, source 'outbound') with the held message
  // + channel context in the payload — delivered on approve (handler bound below).
  const requestOutboundApproval = async (args: {
    workspaceId: string;
    appId: string;
    conversationId: string;
    connectionId?: string | null;
    chatId?: string | null;
    threadId?: string | null;
    body?: string;
    contactName?: string;
    reason: string;
  }): Promise<boolean> => {
    try {
      const conv = sqlite
        .select({ userId: schema.conversations.userId, connectionId: schema.conversations.channelConnectionId, chatId: schema.conversations.channelChatId })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, args.conversationId))
        .get();
      const who = args.contactName ?? 'a contact';
      await approvals.create({
        workspaceId: args.workspaceId,
        ambientId: null,
        userId: conv?.userId ?? 'system',
        runId: null,
        taskId: null,
        gatewayId: null,
        source: 'outbound',
        title: `Approve outbound to ${who}`,
        summary: args.body
          ? `The resident agent wants to send: "${args.body.slice(0, 280)}". Reason: ${args.reason}.`
          : `The resident agent wants to follow up with ${who}. Reason: ${args.reason}.`,
        confidence: null,
        payload: {
          workspaceId: args.workspaceId,
          appId: args.appId,
          conversationId: args.conversationId,
          connectionId: args.connectionId ?? conv?.connectionId ?? null,
          chatId: args.chatId ?? conv?.chatId ?? null,
          threadId: args.threadId ?? null,
          ...(args.body ? { body: args.body } : {}),
        },
      });
      return true;
    } catch (err) {
      logger.warn('outbound.approval.create_failed', { appId: args.appId, err: (err as Error).message });
      return false;
    }
  };

  // Deliver a held outbound message once the operator approves (drop on reject).
  approvals.bindOutboundHandler(async ({ approvalId, decision, payload }) => {
    if (typeof payload.channelActionIntentId === 'string') {
      await channelActions.resolveApproval(approvalId, decision, payload);
      return;
    }
    if (decision !== 'approve') return;
    const appId = typeof payload.appId === 'string' ? payload.appId : null;
    const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : null;
    const connectionId = typeof payload.connectionId === 'string' ? payload.connectionId : null;
    const chatId = typeof payload.chatId === 'string' ? payload.chatId : null;
    const body = typeof payload.body === 'string' ? payload.body : null;
    if (!body || !connectionId || !chatId || !conversationId) return;
    const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId : '';
    const sessionMessageId = `outbound_approval:${approvalId}`;
    const message = conversations.appendOutbound({
      workspaceId,
      conversationId,
      operatorId: 'system',
      participantSide: 'business',
      sessionMessageId,
      body,
      deliveryStatus: 'sending',
      metadata: { channelReply: true, outboundApproved: true, channelChatId: chatId },
    });
    let receipt: ChannelDeliveryReceipt | undefined;
    try {
      receipt = await channelBridge.deliverToConnection({ connectionId, chatId, body, idempotencyKey: sessionMessageId, conversationId });
      if (!isAcknowledgedChannelDelivery(receipt)) {
        conversations.updateDeliveryStatus({
          workspaceId,
          conversationId,
          messageId: message.id,
          deliveryStatus: 'sending',
          metadata: { channelDeliveryReceipt: receipt },
        });
        throw new AgentisError('CHANNEL_SEND_FAILED', 'Approved outbound message is pending provider acknowledgement; it was not marked delivered.');
      }
      conversations.updateDeliveryStatus({
        workspaceId,
        conversationId,
        messageId: message.id,
        deliveryStatus: receipt.status === 'delivered' || receipt.status === 'read' ? 'delivered' : 'sent',
        metadata: { channelReply: true, outboundApproved: true, channelChatId: chatId, channelDeliveryReceipt: receipt },
      });
      if (appId) outboundPolicy.record(appId, 'agent');
    } catch (err) {
      if (!receipt) {
        conversations.updateDeliveryStatus({
          workspaceId,
          conversationId,
          messageId: message.id,
          deliveryStatus: 'failed',
          metadata: { channelDeliveryError: (err as Error).message },
        });
      }
      logger.warn('outbound.approval.deliver_failed', { appId, err: (err as Error).message });
    }
  });

  let compileChannelAttachments: ((args: {
    workspaceId: string;
    body: string;
    attachmentIds: string[];
  }) => Promise<{ prompt: string; runtimeInputAttachments?: RuntimeInputAttachment[] }>) | undefined;

  // Close the channel loop: inbound channel messages now run a real orchestrator
  // turn and the reply is delivered back to the origin chat.
  const channelTurnDispatcher = new ChannelTurnDispatcher({
    db: sqlite,
    adapters,
    conversations,
    logger,
    bus,
    deliver: (args) => channelBridge.deliverToConnection(args),
    // §3.2 — route an inbound reply to any Subject on the spine awaiting this channel
    // correlation (out-of-order, days-late replies land in the right subject's inbox).
    onInbound: ({ workspaceId, connectionId, chatId, from, text }) => {
      durableEntities.postByCorrelation(
        workspaceId,
        { kind: 'channel', id: channelCorrelationId(connectionId, chatId) },
        'reply',
        { text, from },
      );
    },
    setTyping: (connectionId, chatId, on) => channelBridge.setTyping(connectionId, chatId, on),
    identity: channelIdentity,
    inbox: channelInbox,
    channelActions,
    contacts: appContacts,
    relationships,
    utterances: channelUtterances,
    summaries: conversationSummaries,
    handoffs: conversationHandoffs,
    participants: conversationParticipants,
    outboundPolicy,
    requestOutboundApproval: (a) => requestOutboundApproval(a),
    // GAP B1/B3 — offer each inbound to the App's conversation script first.
    conversation: conversationService,
    // BRAIN-BLUEPRINT-10X — channel turns form memory like web chat does.
    memoryCapture: chatMemoryCapture,
    // Coalesce consecutive WhatsApp-style bubbles without making a real person
    // wait a full second before the agent may begin thinking.
    debounceMs: 1_200,
    compileAttachments: (args) => compileChannelAttachments
      ? compileChannelAttachments(args)
      : Promise.resolve({ prompt: args.body }),
  });
  consultations.bindChannelTurnResume(async (payload) => {
    await channelTurnDispatcher.runQueued(payload as unknown as ChannelTurnInput);
  });
  channelBridge.setTurnDispatcher(channelTurnDispatcher);
  scheduler.registerSweep('channel_utterance_batches', 1_000, (now) => channelTurnDispatcher.flushDurableUtterances(now.toISOString()));
  scheduler.registerSweep('channel_action_intents', 15_000, (now) => channelActions.sweep(now.toISOString()));

  // Living Apps proactivity (Phase 3 §4.5 + M2) — fire due follow-ups and sweep
  // abandoned relationships on the existing scheduler tick (throttled, isolated).
  // The G7 outbound envelope gates the unsupervised follow-up (rate/quiet/claim).
  const proactiveFollowups = new ProactiveFollowupService({
    db: sqlite,
    contacts: appContacts,
    dispatcher: channelTurnDispatcher,
    logger,
    policy: outboundPolicy,
    requestApproval: (a) => requestOutboundApproval(a),
  });
  scheduler.registerSweep('proactive_followup', 60_000, async (now) => (await proactiveFollowups.sweep(now.toISOString())).fired);
  // Deferred conversation enrolments (a staggered batch's first touches). The
  // contact rests as a `scheduled` datastore row until due, so this survives a
  // restart with no timer to rehydrate — the sweep simply finds it next tick.
  scheduler.registerSweep('scheduled_conversation_touches', 30_000, (now) => conversationService.sweepScheduled(now));
  scheduler.registerSweep('abandoned_contacts', 3_600_000, async (now) => (await appLearning.sweepAbandoned(now.toISOString())).swept);
  // Evolution Loop cadence — periodically review each App's strategies. ACT (auto
  // promote winners + retire losers) is operator-gated via AGENTIS_EVOLUTION_AUTONOMY;
  // otherwise it only evaluates (proposals are read live via the Goal dashboard).
  scheduler.registerSweep('evolution_loop', 6 * 3_600_000, async () => {
    const mode = process.env.AGENTIS_EVOLUTION_AUTONOMY === 'true' ? 'act' : 'surface';
    return (await strategyEvolution.sweep(mode)).applied;
  });
  // COMMAND-MODEL Layer C — proactive heartbeat. SURFACE-only by default (logs the
  // attention signal + de-dupes; the manager's next chat turn already leads with the
  // same attention in its Command Briefing). Set AGENTIS_COMMAND_AUTONOMY=true to let
  // orchestrators/managers ACT unbidden through the reach layer on a bounded,
  // auto-permission review turn.
  // Two switches gate autonomous action: the global env master AND a per-workspace
  // opt-in (workspace_kv). Both must be ON — enabling the deployment master never
  // silently arms every workspace. Toggle a workspace with setWorkspaceAutonomy().
  const commandAutonomyMaster = String(process.env.AGENTIS_COMMAND_AUTONOMY ?? '').toLowerCase() === 'true';
  const autonomyGate = (workspaceId: string) => commandAutonomyMaster && isWorkspaceAutonomyEnabled(sqlite, workspaceId);
  // Shared bounded turn-runner — run a turn AS an agent (it acts through its own tools).
  // Used by both the manager heartbeat and the resident-agent spine driver.
  const runAgentTurn = async ({ workspaceId, agentId, message, thread }: { workspaceId: string; agentId: string; message: string; thread: string }) => {
    const reg = adapters.get(agentId);
    const adapter = reg?.adapter?.chat ? reg.adapter : orchestratorRuntime;
    if (!adapter?.chat) return;
    const owner = sqlite.select({ userId: schema.workspaces.userId }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get();
    if (!owner?.userId) return;
    try {
      for await (const _delta of ChatSessionExecutor.turn(
        adapter, [], message,
        { workspaceId, agentId, userId: owner.userId, conversationId: `${thread}:${agentId}`, permissionMode: 'auto' },
        { maxTurns: 4, maxToolCalls: 8 },
      )) { /* drain — the agent acts through its own tools */ }
    } catch (err) {
      logger.warn('agent_turn.failed', { agentId, thread, err: (err as Error).message });
    }
  };
  // ORCHESTRATOR-SUSPEND-10X Phase 0 — WARM resident revival. The generic
  // runAgentTurn wakes with an empty history, so a resident agent restarted cold
  // every tick, its only continuity a two-paragraph summary baked into `message`.
  // This runner instead reconstructs the agent's recent conversation from its
  // persisted resident AgentSession and feeds it as the turn's history, then
  // persists the wake exchange back — so the SAME agent resumes where it left off
  // (goal + plan + observations + prior conversation), not amnesiac.
  const runResidentWake = async ({ workspaceId, agentId, message }: { workspaceId: string; agentId: string; message: string }) => {
    const reg = adapters.get(agentId);
    const adapter = reg?.adapter?.chat ? reg.adapter : orchestratorRuntime;
    if (!adapter?.chat) return;
    const owner = sqlite.select({ userId: schema.workspaces.userId }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get();
    if (!owner?.userId) return;
    const session = sessionStore.getOrCreateResident({ workspaceId, agentId });
    // Clear a durable background-run suspension before reconstructing context.
    // The wake message below is persisted into the same session, so the resumed
    // turn sees both its prior working history and the exact reason it woke.
    if (session.status === 'waiting') sessionStore.wake(session.id);
    // Follow-up C — once the resident agent holds a standing goal, anchor it in a
    // durable ChatPlan bound to its session so the objective + decisions +
    // verification survive suspensions (idempotent; skipped until a goal exists).
    const objective = session.taskBlock?.trim();
    if (objective) {
      try { planService.ensureForSession(workspaceId, owner.userId, session.id, objective); }
      catch (err) { logger.warn('resident_wake.bind_plan.failed', { agentId, err: (err as Error).message }); }
    }
    const history = buildResidentWakeHistory(sessionStore.getRecentMessages(session.id, 20));
    const step = session.totalSteps + 1;
    sessionStore.appendMessages(session.id, [{ role: 'user', content: message }], step);
    let reply = '';
    try {
      for await (const delta of ChatSessionExecutor.turn(
        adapter, history, message,
        { workspaceId, agentId, userId: owner.userId, conversationId: `resident:${agentId}`, permissionMode: 'auto' },
        { maxTurns: 4, maxToolCalls: 8 },
      )) {
        if (delta.type === 'text' && typeof delta.delta === 'string') reply += delta.delta;
      }
    } catch (err) {
      logger.warn('resident_wake.failed', { agentId, err: (err as Error).message });
    }
    // Persist the assistant turn back into the resident session so the NEXT wake
    // reconstructs a conversation that includes this one (continuity compounds).
    if (reply.trim()) sessionStore.appendMessages(session.id, [{ role: 'assistant', content: reply.trim() }], step);
    sessionStore.incrementStats(session.id, { steps: 1 });
  };
  const commandHeartbeat = new CommandHeartbeat({
    db: sqlite,
    logger,
    commandModel,
    autonomyEnabled: autonomyGate,
    runManagerTurn: ({ workspaceId, agentId, message }) => runAgentTurn({ workspaceId, agentId, message, thread: 'command-heartbeat' }),
  });
  scheduler.registerSweep('command_heartbeat', 30 * 60_000, () => commandHeartbeat.tick());
  // §3.1 — residency was a fourth scheduler (CommandHeartbeat.tickResidency on its own
  // sweep). It now runs on the ONE Durable Entity dispatcher as the `agent` kind (the
  // ResidentAgentDriver wired below): a resident agent IS a durable entity the
  // dispatcher reconciles + wakes, exactly like a Subject. No separate sweep, no double-drive.

  // §3.0/§3.2 — the Durable Entity spine dispatcher (the ONE loop) + the Subject
  // handler. A subject's lifecycle runs here: deterministic sends go straight through
  // the channel bridge (token-free — the "deterministic sender"), agent steps run a
  // bounded turn as the subject's agent (which acts through its own tools).
  const durableEntityDispatcher = new DurableEntityDispatcher(durableEntities, { logger });
  const subjectRuntime = new SubjectRuntime({
    send: async ({ entityId, stage, facts, text }) => {
      const connectionId = typeof facts.connectionId === 'string' ? facts.connectionId : null;
      const to = typeof facts.to === 'string' ? facts.to : (typeof facts.chatId === 'string' ? facts.chatId : null);
      if (!connectionId || !to) { logger.warn('subject.send.no_destination', { hasConn: Boolean(connectionId) }); return; }
      const receipt = await channelBridge.deliverToConnection({
        connectionId,
        chatId: to,
        body: text,
        idempotencyKey: `subject:${entityId}:${stage}`,
      });
      if (!isAcknowledgedChannelDelivery(receipt)) {
        throw new AgentisError('CHANNEL_SEND_FAILED', 'Subject send is pending provider acknowledgement; state must not advance.');
      }
    },
    runAgent: async ({ entityId, workspaceId, appId, facts, instruction }) => {
      let agentId = typeof facts.agentId === 'string' ? facts.agentId : null;
      if (!agentId && appId) {
        agentId = sqlite.select({ ownerAgentId: schema.apps.ownerAgentId }).from(schema.apps).where(eq(schema.apps.id, appId)).get()?.ownerAgentId ?? null;
      }
      if (!agentId) { logger.warn('subject.runAgent.no_agent', { entityId }); return; }
      // Relationship next actions reuse the exact channel turn engine: compose,
      // autonomy/approval gate, persist, deliver, and retain harness continuity.
      // Scripted Subject agent steps without a live relationship keep the lower
      // level runtime path below.
      const connectionId = typeof facts.connectionId === 'string' ? facts.connectionId : null;
      const to = typeof facts.to === 'string' ? facts.to : null;
      if (facts.relationship && appId && connectionId && to) {
        const conv = sqlite.select({
          id: schema.conversations.id, userId: schema.conversations.userId,
          agentId: schema.conversations.agentId,
        }).from(schema.conversations).where(and(
          eq(schema.conversations.workspaceId, workspaceId),
          eq(schema.conversations.appId, appId),
          eq(schema.conversations.channelConnectionId, connectionId),
          eq(schema.conversations.channelChatId, to),
        )).get();
        const channelKind = typeof facts.channelKind === 'string' ? facts.channelKind : null;
        if (conv && channelKind) {
          const result = await channelTurnDispatcher.dispatch({
            workspaceId, ambientId: null, userId: conv.userId, agentId: conv.agentId,
            appId, conversationId: conv.id, connectionId, kind: channelKind, chatId: to,
            text: instruction, initiatedBy: 'proactive', subjectId: entityId,
          });
          return {
            outcome: result.replied
              ? 'performed' as const
              : result.reason === 'held_for_approval' ? 'held' as const : 'blocked' as const,
          };
        }
      }
      const reg = adapters.get(agentId);
      const adapter = reg?.adapter?.chat ? reg.adapter : orchestratorRuntime;
      if (!adapter?.chat) return;
      const owner = sqlite.select({ userId: schema.workspaces.userId }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get();
      if (!owner?.userId) return;
      try {
        for await (const _delta of ChatSessionExecutor.turn(
          adapter, [], instruction,
          { workspaceId, agentId, userId: owner.userId, conversationId: `subject:${entityId}`, ...(appId ? { appId } : {}), permissionMode: 'auto' },
          { maxTurns: 4, maxToolCalls: 8 },
        )) { /* drain — the agent acts through its own tools */ }
      } catch (err) {
        logger.warn('subject.runAgent.failed', { entityId, err: (err as Error).message });
      }
    },
  });
  durableEntityDispatcher.registerHandler('subject', (wakeCtx) => subjectRuntime.handle(wakeCtx));
  // §3.1 — resident agents fold onto the SAME dispatcher as the `agent` kind. The
  // reconciler keeps one entity per resident+autonomy agent; the handler wakes it,
  // carrying its resident working state, and reschedules — replacing the residency sweep.
  const residentAgentDriver = new ResidentAgentDriver(durableEntities, {
    db: sqlite,
    wakeAgent: ({ workspaceId, agentId, message }) => runResidentWake({ workspaceId, agentId, message }),
    residentState: (workspaceId, agentId) => sessionStore.residentState(workspaceId, agentId),
    autonomyEnabled: autonomyGate,
  });
  durableEntityDispatcher.registerHandler('agent', residentAgentDriver.handler);
  durableEntityDispatcher.registerReconciler(() => residentAgentDriver.reconcile());
  scheduler.registerSweep('durable_entities', 60_000, () => durableEntityDispatcher.tick());

  // Durable channel turns (Living Apps Phase 5 / G2). When enabled, an inbound
  // turn is enqueued (durable, at-least-once, resumable on restart) and drained
  // by this worker instead of running fire-and-forget in-process. Off by default
  // → today's in-process path, byte-identical. Opt-in via AGENTIS_DURABLE_CHANNEL_TURNS.
  const durableChannelTurns = String(process.env.AGENTIS_DURABLE_CHANNEL_TURNS ?? '').toLowerCase() === 'true';
  const channelTurnQueue = new ChannelTurnQueue({
    db: sqlite,
    logger,
    runner: channelTurnDispatcher,
  });
  if (durableChannelTurns) {
    // Wire both directions: dispatch() enqueues; the worker calls runQueued().
    channelTurnDispatcher.setQueue(channelTurnQueue);
  }
  conversationHandoffs.subscribe((snapshot) => channelTurnDispatcher.handleHandoffChanged(snapshot));

  // Inbound voice understanding is available by default through managed local
  // Whisper. A workspace transcription profile is only an optional accelerator.
  const localTranscription = new LocalTranscriptionService({
    dataDir: env.AGENTIS_DATA_DIR,
    logger,
  });
  const transcription = new TranscriptionService({
    profile: () => orchestratorModelRouter.profile('transcription'),
    localFallback: localTranscription,
    logger,
  });
  // Image understanding for inbound channel images — uses the vision role.
  const vision = new VisionService({
    profile: () => orchestratorModelRouter.profile('vision'),
    logger,
  });
  // Text-to-speech (voice notes) — uses the model router's `speech` role. The
  // voice model emits Opus directly, so an agent can send a spoken reply by
  // passing `{ kind:"voice", text }` with no encoding. No-op when unconfigured.
  const speech = new SpeechService({
    profile: () => orchestratorModelRouter.profile('speech'),
    logger,
  });
  channelBridge.setSpeech(speech);
  specialistVision = vision;
  // Document (PDF / text) extraction for inbound channel attachments.
  const documentExtraction = new DocumentExtractionService({ logger });
  const runtimeInputAttachments = new RuntimeInputAttachmentStore(
    path.join(env.AGENTIS_DATA_DIR, 'runtime-inputs'),
  );
  compileChannelAttachments = async (args) => new ConversationAttachmentContextService({
    artifacts: artifactService,
    documents: documentExtraction,
    logger,
    vision: new VisionService({
      profile: () => orchestratorModelRouter.profile('vision', args.workspaceId),
      logger,
    }),
    transcription: new TranscriptionService({
      profile: () => orchestratorModelRouter.profile('transcription', args.workspaceId),
      localFallback: localTranscription,
      logger,
    }),
    materialize: (input) => runtimeInputAttachments.materialize(input),
    materializeVideoFrames: (input) => runtimeInputAttachments.materializeVideoFrames(input),
  }).compile({
    ...args,
    strict: false,
  });
  channelBridge.setInboundMediaResolvers({
    transcribeAudio: (bytes, mime, workspaceId) => new TranscriptionService({
      profile: () => orchestratorModelRouter.profile('transcription', workspaceId), logger,
      localFallback: localTranscription,
    }).transcribe({ bytes, mimeType: mime }),
    describeImage: (bytes, mime, workspaceId, caption) => new VisionService({
      profile: () => orchestratorModelRouter.profile('vision', workspaceId), logger,
    }).describe({ bytes, mimeType: mime, ...(caption ? { caption } : {}) }),
    extractDocument: (bytes, mime, _workspaceId, fileName) => documentExtraction.extract({
      bytes, mimeType: mime, ...(fileName ? { fileName } : {}),
    }),
  });

  // Persistent-transport supervisor: live WhatsApp (baileys) sockets. Routes
  // inbound through the same dispatcher and outbound back over the live socket.
  const channelSupervisor = new ChannelConnectionSupervisor({
    db: sqlite,
    bus,
    logger,
    vault: credentialVault,
    conversations,
    dataDir: env.AGENTIS_DATA_DIR,
    hasPublicWebhookUrl: () => Boolean(env.AGENTIS_PUBLIC_URL),
    dispatcher: channelTurnDispatcher,
    artifacts: artifactService,
    prepareInboundAudio: (workspaceId) => workspaceId && orchestratorModelRouter.profile('transcription', workspaceId)
      ? Promise.resolve()
      : localTranscription.prepare(),
    // Always wired. Audio uses managed local Whisper; image/video artifacts are
    // persisted and forwarded natively by the shared attachment compiler.
    // Provider profiles remain optional accelerators, not input prerequisites.
    transcribeAudio: (bytes, mime, workspaceId) => new TranscriptionService({
      profile: () => orchestratorModelRouter.profile('transcription', workspaceId),
      localFallback: localTranscription,
      logger,
    }).transcribe({ bytes, mimeType: mime }),
    describeImage: (bytes, mime, workspaceId, caption) => new VisionService({
      profile: () => orchestratorModelRouter.profile('vision', workspaceId),
      logger,
    }).describe({ bytes, mimeType: mime, ...(caption ? { caption } : {}) }),
    extractDocument: (bytes, mime, _workspaceId, fileName) => documentExtraction.extract({ bytes, mimeType: mime, ...(fileName ? { fileName } : {}) }),
    handoffs: conversationHandoffs,
    summaries: conversationSummaries,
    identity: channelIdentity,
  });
  channelBridge.setPersistentTransport(channelSupervisor);
  // §PERF-BOOT (GAP B) — startAll() is NOT called here any more. Despite the
  // old `void`, its prelude ran inline in bootstrap(): a full channel_connections
  // scan plus the first session's `await import('baileys')`, which under tsx
  // compiles the whole baileys graph synchronously on the main thread (~7.7s of
  // the measured pre-bind window). start() launches it after agent hydration —
  // channel re-link is explicitly best-effort, so arriving a few seconds later
  // costs nothing, and it no longer competes with the hydrator for the loop.

  const orchestratorBridge = new OrchestratorEventBridge({ db: sqlite, bus, logger });
  orchestratorBridge.start();
  // ORCHESTRATOR-SUSPEND-10X Phase 3 — selective-wake supervisor. Where the bridge
  // above pushes proactive CARDS to the operator, this REVIVES the owning agent
  // (warm, via runResidentWake) when an app it owns concludes or hits a judgment
  // point (accomplished/completed/failed/approval) — and only then. Autonomy-gated,
  // debounced so a fan-in of many runs settling at once wakes the owner once.
  const selectiveWakeSupervisor = new SelectiveWakeSupervisor({
    db: sqlite,
    bus,
    logger,
    autonomyEnabled: autonomyGate,
    wakeOwner: ({ workspaceId, agentId, message }) => runResidentWake({ workspaceId, agentId, message }),
  });
  selectiveWakeSupervisor.start();

  // Recover runs left mid-flight by a process restart: re-arms `wait` node
  // timers, sleep_until/await_event/approval-parked agent sessions, and
  // re-dispatches other in-flight work from persisted state. Without this the
  // in-memory run map starts empty and every WAITING run hangs forever
  // (best-effort — a failure here must not block boot).
  void engine.recoverInterruptedRuns().then((summary) => {
    logger.info('engine.boot_recovery', summary);
    // After recovery re-hydrates every legitimately-parked run, reap the ones
    // whose owning workflow no longer exists — orphaned zombies that can never
    // resume or be controlled and would otherwise inflate the run monitor forever.
    try {
      const { reaped } = engine.reapOrphanedRuns();
      if (reaped > 0) logger.info('engine.boot_orphan_reap', { reaped });
    } catch (err) {
      logger.warn('engine.boot_orphan_reap_failed', { err: (err as Error).message });
    }
  }).catch((err) => {
    logger.warn('engine.boot_recovery_failed', { err: (err as Error).message });
  });

  // ── Adapter event glue ──────────────────────────────────
  // 1) Engine needs task.completed/failed for node settlement.
  adapters.onEvent((event, agentId) => {
    publishAdapterRealtime(event, { db: sqlite, bus, logger });
    if (event.eventType === 'task.completed') {
      void engine.notifyTaskCompleted({
        runId: event.runId,
        nodeId: event.taskId, // taskId carries node binding in V1
        output: event.output,
      });
    } else if (event.eventType === 'task.failed') {
      void engine.notifyTaskFailed({
        runId: event.runId,
        nodeId: event.taskId,
        error: event.error,
      });
    } else if (event.eventType === 'agent.thinking') {
      // LAYER 1: stream the agent's live reasoning into the run room + replay tail
      // (the workspace-room copy is handled by publishAdapterRealtime above).
      if (event.runId && event.text) {
        engine.notifyAgentActivity({ runId: event.runId, agentId, taskId: event.taskId, kind: 'thinking', text: event.text });
      }
    } else if (event.eventType === 'task.progress') {
      if (event.runId && event.message) {
        engine.notifyAgentActivity({
          runId: event.runId,
          agentId,
          taskId: event.taskId,
          kind: event.kind === 'reasoning' ? 'thinking' : event.kind === 'tool' ? 'tool_call' : 'text',
          text: event.message,
          activityId: event.activityId,
          activityPhase: event.phase,
          activityStatus: event.status,
          transport: event.transport,
          attempt: event.attempt,
          startedAt: event.startedAt,
          completedAt: event.completedAt,
          durationMs: event.durationMs,
        });
      }
    } else if (event.eventType === 'agent.tool_call') {
      if (event.runId) {
        engine.notifyAgentActivity({
          runId: event.runId, agentId, taskId: event.taskId,
          kind: event.result !== undefined ? 'tool_result' : 'tool_call',
          tool: event.tool, toolInput: event.input, toolResult: event.result,
        });
      }
    }
  });

  // 2) SessionMirror handles all the side-channel events
  //    (session_message, approval_requested, status, heartbeat).
  sessionMirror.bind((handler) => adapters.onEvent(handler));

  // 3) Approval resume → engine. Checkpoints complete their node; phase gates
  //    release (approve) or fail (reject) the gated phase. `targetId` carries the
  //    checkpoint node id / phase id.
  approvals.bindCheckpointHandler(async ({ runId, approvalId, decision, data, feedback }) => {
    await engine.resolveApproval({ runId, approvalId, decision, data, feedback });
  });
  bindWorkflowRevisionApproval({ approvals, revisions: workflowRevisions });

  const {
    app,
    groundingRuntime,
    harnessImportSync,
  } = wireRoutes({
    ...foundation,
    runCompaction,
    PeerProfiles,
    Reflection,
    SessionMoments,
    SharedIntelligence,
    documentExtraction,
    vision,
    transcription,
    runtimeProfiles,
    appContacts,
    appLearning,
    appOrchestrator,
    appGoal,
    strategies,
    strategyEvolution,
    experiments,
    rollingBaselineStore,
    brainAsk,
    brainComposer,
    brainHealth,
    brainMaintenance,
    capabilityRegistry,
    channelBridge,
    channelIdentity,
    channelInbox,
    channelActions,
    channelSupervisor,
    chatMemoryCapture,
    commandAutonomyMaster,
    connectionGrants,
    conversationHandoffs,
    conversationParticipants,
    conversationSimulator,
    consultations,
    defaultCognitiveCompleter,
    embeddingBackfill,
    engine,
    workflowRevisions,
    workflowExperience,
    episodicMemoryStore,
    harnessMemoryIngestion,
    issues,
    knowledgeAutoLinker,
    mcpHarness,
    orchestratorModelRouter,
    outboundPolicy,
    planService,
    buildSessionService,
    scheduler,
    sessionStore,
    skillMaterializer,
    skillService,
    specialistAgents,
    specialistEvals,
    specialistMind,
    specialistRouter,
    specialistRuntime,
    specialistTemplates,
    toolRegistry,
    turnChanges,
    triggerRuntime,
    voiceChannelAdapter,
    workspaceModelConfig,
    workspaceMediaConfigService,
    commissionSpecialist: (workspaceId: string, agentId: string) => {
      if (adapters.get(agentId)) return;
      const runtime = agentRuntimeResolver?.(workspaceId, agentId, null, null);
      if (!runtime) {
        logger.warn('app.staffing.runtime_unavailable', { workspaceId, agentId });
        return;
      }
      adapters.register(agentId, runtime);
      sqlite.update(schema.agents).set({
        adapterType: runtime.adapterType,
        status: 'online',
        lastHeartbeatAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).where(eq(schema.agents.id, agentId)).run();
    },
  });

  let httpServer: HttpServer | undefined;
  let realtime: RealtimeServer | undefined;

  markBootPhase('services_wired');

  return {
    env,
    secrets,
    logger,
    db,
    bus,
    seed,
    async start() {
      const node = createAdaptorServer({
        fetch: app.fetch,
      });
      httpServer = node as unknown as HttpServer;
      realtime = createRealtimeServer({ bus, auth, db: sqlite, logger, viewportStore, allowedOrigins, dev: env.NODE_ENV !== 'production' });
      realtime.attach(httpServer);
      await listenHttpServer(httpServer, {
        port: env.AGENTIS_HTTP_PORT,
        hostname: env.AGENTIS_HTTP_HOST,
      });
      // §PERF-BOOT — logged AT THE BIND, where it is true. This line used to
      // fire at the very end of start(), ~31s after the socket began accepting,
      // so every boot diagnosis started from a false timeline.
      markBootPhase('port_bound');
      logger.info('agentis.listening', { url: `http://${env.AGENTIS_HTTP_HOST}:${env.AGENTIS_HTTP_PORT}` });
      // Harness-native MCP: CLI harnesses mount Agentis's own MCP server and run
      // their own tool loop in ONE invocation (no marker re-spawn). Zero-config —
      // URL auto-derived (loopback) + token auto-minted. ON by default; opt out
      // with AGENTIS_HARNESS_MCP=false.
      if (mcpHarness.enabled) logger.info('agentis.harness_mcp.enabled', { url: '(loopback)' });
      try {
        await hydrateAgentRuntimes({ db: sqlite, vault: credentialVault, adapters, logger, bus, mcpHarness, skillMaterializer });
      } catch (err) {
        logger.error('agentis.agent_runtime_hydrate_failed', { err: (err as Error).message });
      }
      markBootPhase('agents_hydrated');
      // §PERF-BOOT (GAP B, deferred) — channel re-link runs AFTER hydration so
      // the baileys module graph and WhatsApp handshakes never race the
      // hydrator (the measured pile-up: ~23s of the old 28.5s window was this
      // contention, not hydrator work).
      void channelSupervisor.startAll().catch((err) => {
        logger.warn('channel.supervisor.start_all_failed', { err: (err as Error).message });
      });
      // §PERF-BOOT (GAP A, deferred) — orphan-link repair is sync CPU work
      // (3–8s); stagger it well past the contention window. Unref'd: never
      // holds the process open.
      const repairTimer = setTimeout(() => {
        try {
          const repaired = knowledgeBaseService.repairOrphanedLinks();
          if (repaired > 0) logger.info('knowledge.document_links_backfilled', { repaired });
        } catch (err) {
          logger.warn('knowledge.orphan_link_repair_failed', { message: (err as Error).message });
        }
      }, 15_000);
      repairTimer.unref();
      const harnessDefaults = [...new Set(
        sqlite.select({ workspaceId: schema.agents.workspaceId }).from(schema.agents).all().map((agent) => agent.workspaceId),
      )].flatMap((workspaceId) => {
        const runtime = workspaceHarnesses.resolve(workspaceId);
        return runtime ? [{ agentId: runtime.agentId, adapterType: runtime.adapterType, model: runtime.model }] : [];
      });
      logger.info('cognitive_runtime.defaults_ready', {
        configuredEndpoint: Boolean(evaluatorRuntime),
        harnessDefaults,
      });
      // Hydrate active triggers so cron schedules + persistent listeners come back online.
      try {
        await triggerRuntime.hydrate();
      } catch (err) {
        logger.error('agentis.trigger_hydrate_failed', { err: (err as Error).message });
      }
      eventChain.start();
      appOrchestrator.start(); // dependsOn chains + App binding schedules
      scheduler.start();
      jobQueue.start();
      // G2 — drain durable channel turns + resume any left in-flight by a crash.
      if (durableChannelTurns) channelTurnQueue.start();
      groundingRuntime.start();
      runCompaction.start();
      brainQueue.start(); // ability compile pipeline + brain promotions
      brainMaintenance.start(); // §0.2 — immediate-if-due + daily lifecycle, hygiene, compression, reflection, and reclamation
      harnessImportSync.start(); // P4: notify when imported agents accrue new memory

      // Warm the verified on-device embedding model in the BACKGROUND (after the
      // server is already serving) so the first knowledge upload / brain write
      // doesn't pay the cold start — q8 artifact download (~129 MB, once) + load (tens
      // of seconds) — INSIDE the request, which previously stalled the whole API
      // (uploads appeared to hang for minutes). Fire-and-forget; never blocks boot.
      logger.info('brain.embedding.warming', {
        model: embeddingProvider.modelId,
        cacheDir: path.join(env.AGENTIS_DATA_DIR, 'models'),
        note: 'the default q8 generation is about 129 MB and is verified before use',
      });
      // Resume any knowledge document left mid-index by a previous restart, so it
      // never stays stuck at `indexing` without embeddings (§perf background ingest).
      try { knowledgeBaseService.resumeStalledIndexing(); } catch (err) { logger.warn('knowledge.resume_indexing_failed', { message: (err as Error).message }); }

      // Brain — fill deferred embeddings. The default local (ONNX) embedder is
      // async, so a memory write stores a null vector + needs_reembed=1; this
      // light sweep embeds those shortly after, so a just-formed memory is
      // retrievable on the next run (closes the fresh-write recall gap). Unref'd
      // so it never holds the process open.
      let reembedDrain: Promise<void> | null = null;
      const drainDeferredEmbeddings = (): Promise<void> => {
        if (reembedDrain) return reembedDrain;
        if (embeddingRuntimeManager.snapshot().status !== 'ready') return Promise.resolve();
        reembedDrain = (async () => {
          const workspaceIds = new Set<string>();
          for (const row of sqlite
            .selectDistinct({ workspaceId: schema.memoryEpisodes.workspaceId })
            .from(schema.memoryEpisodes)
            .where(eq(schema.memoryEpisodes.needsReembed, true))
            .all()) workspaceIds.add(row.workspaceId);
          for (const row of sqlite
            .selectDistinct({ workspaceId: schema.sessionMoments.workspaceId })
            .from(schema.sessionMoments)
            .where(eq(schema.sessionMoments.needsReembed, true))
            .all()) workspaceIds.add(row.workspaceId);

          for (const workspaceId of workspaceIds) {
            while (embeddingRuntimeManager.snapshot().status === 'ready') {
              const brain = await SharedIntelligence.reembedPending(workspaceId, 200);
              const sessions = await SessionMoments.reembedPending(workspaceId, 50);
              if ((brain.reembedded === 0 && sessions === 0) || brain.failed > 0) break;
            }
          }
        })().catch((err) => {
          logger.warn('brain.reembed_drain_failed', { message: (err as Error).message });
        }).finally(() => {
          reembedDrain = null;
        });
        return reembedDrain;
      };
      embeddingRuntimeManager.subscribe((snapshot) => {
        if (snapshot.status === 'ready') void drainDeferredEmbeddings();
      });
      void warmLocalEmbeddingModel().then(
        () => {
          logger.info('brain.embedding.warmed', { model: embeddingProvider.modelId });
          return drainDeferredEmbeddings();
        },
        (err) => logger.warn('brain.embedding.warm_failed', {
          phase: embeddingRuntimeManager.snapshot().status,
          code: embeddingRuntimeManager.snapshot().errorCode,
          message: (err as Error).message,
        }),
      );
      const reembedSweep = setInterval(() => void drainDeferredEmbeddings(), 5 * 60_000);
      reembedSweep.unref();

      // Reclaim asset blobs no artifact row references (freed when an artifact is
      // deleted or a run's transient artifacts are reaped). Low-frequency, with a
      // grace window in gc() so an in-flight put is never collected. Best-effort.
      const assetGcSweep = setInterval(() => {
        void assetStore.gc().catch((err) => logger.warn('asset_store.gc_failed', { message: (err as Error).message }));
      }, 6 * 60 * 60 * 1000);
      assetGcSweep.unref();

      // Interrupted workflow runs are now operator-controlled. Active triggers
      // still hydrate above, but RUNNING/WAITING runs remain visible through
      // /v1/runs/interrupted until the operator resumes or cancels them.
      const url = `http://${env.AGENTIS_HTTP_HOST}:${env.AGENTIS_HTTP_PORT}`;
      // `agentis.listening` fired at the actual bind above; this is the full
      // warm-up milestone, with the phase profile (also served on /healthz).
      markBootReady();
      logger.info('agentis.ready', { url, boot: bootProfileSnapshot().phases });
      return { url, httpServer };
    },
    async stop() {
      logger.info('agentis.shutdown');
      runCompaction.stop();
      jobQueue.stop();
      channelTurnQueue.stop();
      harnessImportSync.stop();
      groundingRuntime.stop();
      brainQueue.stop();
      scheduler.shutdown();
      eventChain.shutdown();
      appOrchestrator.shutdown();
      observability.stop();
      orchestratorBridge.stop();
      channelBridge.shutdown();
      await channelSupervisor.shutdown().catch((err) => logger.warn('agentis.shutdown.channel_supervisor', { err: (err as Error).message }));
      await extensions.shutdownBrowser().catch((err) => logger.warn('agentis.shutdown.extension_browser', { err: (err as Error).message }));
      await browserSessionManager.shutdown().catch((err) => logger.warn('agentis.shutdown.browser_sessions', { err: (err as Error).message }));
      await browserPool.shutdown().catch((err) => logger.warn('agentis.shutdown.browser', { err: (err as Error).message }));
      await registry.shutdown().catch((err) => logger.warn('agentis.shutdown.registry', { err: (err as Error).message }));
      for (const reg of adapters.list()) {
        await adapters.unregister(reg.agentId).catch(() => {});
      }
      await realtime?.close();
      await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
      await db.close();
      await telemetry.shutdown().catch((err) => logger.warn('agentis.shutdown.telemetry', { err: (err as Error).message }));
    },
  };
}

/** Platform tools a workflow agent must NOT call — recursion / run-control / spawn. */
const WORKFLOW_AGENT_TOOL_BLOCKLIST = new Set<string>([
  'agentis.build_workflow',
  'agentis.workflow.patch',
  'agentis.workflow.graph.replace',
  'agentis.workflow.graph.patch',
  'agentis.workflow.graph.rollback',
  'agentis.run.graph.evolve',
  'agentis.workflow.run',
  'agentis.workflow.deliver',
  'agentis.ephemeral.run',
  'agentis.run.cancel',
  'agentis.approval.resolve',
]);

/**
 * The platform-tool bridge offered to in-engine workflow agents (E2). The safe set
 * is the MCP-exposed catalog — already vetted for autonomous harness agents — minus
 * the recursion/run-control blocklist, so an `agent_task` gains the `agentis.*`
 * integration surface (channels, cooperation, app/data management) with the same
 * trust boundary an mcp_native harness already gets.
 */
function makeWorkflowPlatformToolBridge(registry: AgentisToolRegistry): PlatformToolBridge {
  const safeTools = () =>
    registry.catalog({ mcpOnly: true }).tools.filter((t) => !WORKFLOW_AGENT_TOOL_BLOCKLIST.has(t.id));
  const ids = new Set(safeTools().map((t) => t.id));
  const describe = (t: { description: string; inputSchema: unknown }): string => {
    const props = (t.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
    const keys = props ? Object.keys(props) : [];
    return keys.length ? `${t.description} (args: ${keys.slice(0, 8).join(', ')})` : t.description;
  };
  return {
    list: () => safeTools().map((t) => ({ id: t.id, description: describe(t) })),
    has: (id) => ids.has(id),
    execute: async (toolId, args, c) => {
      const res = await registry.execute(
        { id: randomUUID(), toolId, arguments: args },
        {
          workspaceId: c.workspaceId,
          userId: c.userId ?? '',
          agentId: c.agentId,
          runId: c.runId,
          appId: c.appId ?? null,
          artifactPolicy: c.artifactPolicy ?? null,
          ...(c.allowedToolIds ? { allowedToolIds: c.allowedToolIds } : {}),
          caller: 'workflow',
          executionMode: 'chat',
        },
      );
      return res.ok ? { ok: true, result: res.output } : { ok: false, error: res.errorMessage ?? `tool '${toolId}' failed` };
    },
  };
}
