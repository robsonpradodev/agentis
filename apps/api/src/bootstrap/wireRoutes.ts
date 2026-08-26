/**
 * HTTP route-surface wiring phase (extracted from bootstrap).
 *
 * Builds the Hono app and mounts every V1 route + middleware. A pure consumer
 * of the already-constructed service graph (foundation products + the mid-graph
 * deps it needs), so it runs near the end of the composition root.
 */
import path from 'node:path';
import { homedir } from 'node:os';
import { bootProfileSnapshot } from '../services/bootProfile.js';
import { embeddingRuntimeManager } from '../services/embedding/embeddingRuntimeManager.js';
import { buildAutostartTarget } from '../services/system/autostartService.js';
import { ClaimService } from '../grounding/claimService.js';
import { GroundingContextComposer } from '../grounding/contextComposer.js';
import { GroundingDiscoveryService } from '../grounding/discovery.js';
import { EvidenceLedgerService } from '../grounding/evidenceLedger.js';
import { GroundingExtractionService } from '../grounding/extractionService.js';
import { GroundingRuntime } from '../grounding/groundingRuntime.js';
import { IdentityService } from '../grounding/identityService.js';
import { GroundingInvestigationService } from '../grounding/investigationService.js';
import { GroundingMigrationService } from '../grounding/migrationService.js';
import { GroundingModelService } from '../grounding/modelService.js';
import { GroundingSourceFabric } from '../grounding/sourceFabric.js';
import { AgentisNativeSource } from '../grounding/sources/agentisNativeSource.js';
import { auditLog } from '../middleware/auditLog.js';
import { errorHandler } from '../middleware/error.js';
import { securityHeaders } from '../middleware/securityHeaders.js';
import { mountOpenApi } from '../openapi.js';
import { buildA2aRoutes } from '../routes/a2a.js';
import { buildActivityRoutes } from '../routes/activity.js';
import { buildAgentRoutes } from '../routes/agents.js';
import { buildAmbientRoutes } from '../routes/ambients.js';
import { buildAnalyticsRoutes } from '../routes/analytics.js';
import { buildApprovalRoutes } from '../routes/approvals.js';
import { buildAppRoutes } from '../routes/apps.js';
import { buildArtifactRoutes } from '../routes/artifacts.js';
import { buildAuditRoutes } from '../routes/audit.js';
import { buildAuthRoutes } from '../routes/auth.js';
import { buildBootstrapRoutes } from '../routes/bootstrap.js';
import { buildBrainRoutes } from '../routes/brain.js';
import { buildBudgetRoutes } from '../routes/budgets.js';
import { buildCapabilityRoutes } from '../routes/capabilities.js';
import { buildChannelRoutes } from '../routes/channels.js';
import { buildCommandRoutes } from '../routes/command.js';
import { buildCommandAutonomyRoutes } from '../routes/commandAutonomy.js';
import { buildBrowserControlRoutes } from '../routes/browserControl.js';
import { buildConversationRoutes } from '../routes/conversations.js';
import { buildCredentialRoutes } from '../routes/credentials.js';
import { buildDashboardRoutes } from '../routes/dashboard.js';
import { buildDomainRoutes } from '../routes/domains.js';
import { buildEphemeralRoutes } from '../routes/ephemeral.js';
import { buildEmbeddingRuntimeRoutes } from '../routes/embeddingRuntime.js';
import { buildExtensionRegistryRoutes } from '../routes/extensionRegistry.js';
import { buildExtensionRoutes } from '../routes/extensions.js';
import { buildGatewayMutationRoutes } from '../routes/gatewayMutations.js';
import { buildGatewayRoutes } from '../routes/gateways.js';
import { buildGovernanceRoutes } from '../routes/governance.js';
import { buildGroundingRoutes, buildGroundingWebhookRoutes } from '../routes/grounding.js';
import { buildHarnessRoutes } from '../routes/harness.js';
import { buildSystemRoutes } from '../routes/system.js';
import { buildHarnessImportRoutes } from '../routes/harnessImport.js';
import { buildHistoryRoutes } from '../routes/history.js';
import { buildIntegrationRoutes } from '../routes/integrations.js';
import { buildInteractionRoutes } from '../routes/interactions.js';
import { buildIssueRoutes } from '../routes/issues.js';
import { buildJwksRoutes } from '../routes/jwks.js';
import { buildKnowledgeBaseRoutes } from '../routes/knowledgeBases.js';
import { buildListenerRoutes } from '../routes/listeners.js';
import { buildMcpRoutes } from '../routes/mcp.js';
import { buildMcpOAuthRoutes } from '../routes/mcpOAuth.js';
import { buildMcpServerRoutes } from '../routes/mcpServers.js';
import { buildMemoryRoutes } from '../routes/memory.js';
import { buildOAuthRoutes } from '../routes/oauth.js';
import { buildCustomOAuthRoutes } from '../routes/customOAuth.js';
import { buildObservabilityRoutes } from '../routes/observability.js';
import { buildOrchestratorModelRoutes } from '../routes/orchestratorModels.js';
import { buildPackageRoutes } from '../routes/packages.js';
import { buildPersonalBrainRoutes } from '../routes/personalBrain.js';
import { buildReplayRoutes } from '../routes/replay.js';
import { buildRoomRoutes } from '../routes/rooms.js';
import { buildRunRoutes } from '../routes/runs.js';
import { buildSchedulerRoutes } from '../routes/scheduler.js';
import { buildSkillRoutes } from '../routes/skills.js';
import { buildSovereigntyRoutes } from '../routes/sovereignty.js';
import { buildSpecialistRoutes } from '../routes/specialists.js';
import { buildStorageRoutes } from '../routes/storage.js';
import { buildTaskRoutes } from '../routes/tasks.js';
import { buildBuildSessionRoutes } from '../routes/buildSessions.js';
import { buildTranscriptionRoutes } from '../routes/transcription.js';
import { ChatSessionExecutor } from '../services/chat/chatSessionExecutor.js';
import { buildTerminalRoutes } from '../routes/terminal.js';
import { buildTestHarnessRoutes } from '../routes/testHarness.js';
import { buildToolRoutes } from '../routes/tools.js';
import { buildTriggerRoutes } from '../routes/triggers.js';
import { buildWebhookRoutes } from '../routes/webhooks.js';
import { buildWorkflowIoRoutes } from '../routes/workflowIo.js';
import { buildWorkflowRoutes } from '../routes/workflows.js';
import { buildWorkspaceBundleRoutes } from '../routes/workspaceBundle.js';
import { buildWorkspaceContextRoutes } from '../routes/workspaceContext.js';
import { buildWorkspaceIntelligenceRoutes } from '../routes/workspaceIntelligence.js';
import { buildWorkspaceRoutes } from '../routes/workspaces.js';
import { buildHubPackageRoutes } from '../routes/hubPackages.js';
import { AppPresenceService } from '../services/app/appPresence.js';
import { AppStaffingService } from '../services/app/appStaffing.js';
import { BroadcastDispatcher } from '../services/broadcastDispatcher.js';
import { HarnessImportSyncService } from '../services/harness/harnessImportSync.js';
import { AgentOwnershipSyncService } from '../services/harness/agentOwnershipSync.js';
import { McpHarnessSessionService } from '../services/mcp/mcpHarnessSession.js';
import { ConversationTurnLeaseRegistry } from '../services/conversation/conversationTurnLease.js';
import { OrchestratorModelRouter } from '../services/orchestrator/orchestratorModelRouter.js';
import { PackagerService } from '../services/packager.js';
import { EpisodicBrainPort } from '../services/brain/brainExport.js';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { VoiceChannelAdapter } from '../adapters/channels/voice.js';
import type { TriggerRuntime } from '../engine/TriggerRuntime.js';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import type { AgentSessionService } from '../services/agent/agentSession.js';
import type { AgentisToolRegistry } from '../services/agentisToolRegistry.js';
import type { AppContactService } from '../services/app/appContacts.js';
import type { AppLearningService } from '../services/app/appLearning.js';
import type { AppOrchestratorService } from '../services/app/appOrchestrator.js';
import type { AppGoalService } from '../services/app/appGoal.js';
import type { StrategyService } from '../services/app/strategyService.js';
import type { StrategyEvolutionService } from '../services/app/strategyEvolution.js';
import type { ExperimentService } from '../services/experiments.js';
import type { RollingBaselineStore } from '../services/rollingBaselineStore.js';
import type { BrainAskService } from '../services/brain/brainAskService.js';
import type { BrainComposer } from '../services/brain/brainComposer.js';
import type { BrainHealthService } from '../services/brain/brainHealthService.js';
import type { BrainMaintenanceService } from '../services/brain/brainMaintenanceService.js';
import type { CapabilityRegistry } from '../services/capability/capabilityRegistry.js';
import type { ChatMemoryCaptureService } from '../services/chat/chatMemoryCapture.js';
import type { ChannelBridge } from '../services/conversation/channelBridge.js';
import type { ChannelConnectionSupervisor } from '../services/conversation/channelConnectionSupervisor.js';
import type { ChannelIdentityService } from '../services/conversation/channelIdentityService.js';
import type { ChannelInboxService } from '../services/conversation/channelInboxService.js';
import type { ChannelActionIntentService } from '../services/conversation/channelActionIntentService.js';
import type { ConnectionGrantService } from '../services/connectionGrants.js';
import type { ConversationParticipantService } from '../services/conversation/conversationParticipants.js';
import type { ConversationHandoffService } from '../services/conversation/conversationHandoffService.js';
import type { TurnChangeJournal } from '../services/conversation/turnChangeJournal.js';
import type { ConversationSimulatorService } from '../services/conversation/conversationSimulator.js';
import type { AgentConsultationService } from '../services/agent/agentConsultationService.js';
import type { EmbeddingBackfillService } from '../services/embedding/embeddingBackfill.js';
import type { EpisodicMemoryStore } from '../services/episodicMemoryStore.js';
import type { HarnessMemoryIngestionService } from '../services/harness/harnessMemoryIngestion.js';
import type { IssueService } from '../services/issues.js';
import type { KnowledgeAutoLinker } from '../services/knowledge/knowledgeAutoLinker.js';
import type { OutboundPolicyService } from '../services/outboundPolicy.js';
import type { PeerProfileService } from '../services/peerProfileService.js';
import type { PlanService } from '../services/planService.js';
import type { BuildSessionService } from '../services/buildSessionService.js';
import type { ReflectionService } from '../services/reflectionService.js';
import type { SchedulerService } from '../services/scheduler.js';
import type { SessionMomentService } from '../services/sessionMomentService.js';
import type { SharedIntelligenceService } from '../services/sharedIntelligence.js';
import type { SkillMaterializer } from '../services/skillMaterializer.js';
import type { SkillService } from '../services/skillService.js';
import type { SpecialistAgentService } from '../services/specialist/specialistAgents.js';
import type { SpecialistDemandRouter } from '../services/specialist/specialistDemandRouter.js';
import type { SpecialistEvalService } from '../services/specialist/specialistEvalService.js';
import type { SpecialistMindService } from '../services/specialist/specialistMindService.js';
import type { SpecialistRuntimeService } from '../services/specialist/specialistRuntimeService.js';
import type { SpecialistTemplateService } from '../services/specialist/specialistTemplateService.js';
import type { WorkflowRevisionService } from '../services/workflow/workflowRevisionService.js';
import type { WorkflowExperienceService } from '../services/workflow/workflowExperienceService.js';
import type { StructuredCompleter } from '../services/structuredCompleter.js';
import { TranscriptionService } from '../services/transcriptionService.js';
import type { DocumentExtractionService } from '../services/documentExtractionService.js';
import type { VisionService } from '../services/visionService.js';
import type { RuntimeProfileService } from '../services/runtime/runtimeProfileService.js';
import type { WorkspaceModelConfigService } from '../services/workspace/workspaceModelConfigService.js';
import type { WorkspaceMediaConfigService } from '../services/workspace/workspaceMediaConfigService.js';
import { buildMediaConfigRoutes } from '../routes/mediaConfig.js';
import type { wireFoundation } from './wireFoundation.js';

type WireRoutesDeps = Awaited<ReturnType<typeof wireFoundation>> & {
  PeerProfiles: PeerProfileService;
  Reflection: ReflectionService;
  SessionMoments: SessionMomentService;
  SharedIntelligence: SharedIntelligenceService;
  documentExtraction: DocumentExtractionService;
  vision: VisionService;
  transcription: TranscriptionService;
  runtimeProfiles: RuntimeProfileService;
  appContacts: AppContactService;
  appLearning: AppLearningService;
  appOrchestrator: AppOrchestratorService;
  appGoal: AppGoalService;
  strategies: StrategyService;
  strategyEvolution: StrategyEvolutionService;
  experiments: ExperimentService;
  rollingBaselineStore: RollingBaselineStore;
  brainAsk: BrainAskService;
  brainComposer: BrainComposer;
  brainHealth: BrainHealthService;
  brainMaintenance: BrainMaintenanceService;
  capabilityRegistry: CapabilityRegistry;
  channelBridge: ChannelBridge;
  channelIdentity: ChannelIdentityService;
  channelInbox: ChannelInboxService;
  channelActions: ChannelActionIntentService;
  channelSupervisor: ChannelConnectionSupervisor;
  chatMemoryCapture: ChatMemoryCaptureService;
  connectionGrants: ConnectionGrantService;
  commandAutonomyMaster: boolean;
  conversationParticipants: ConversationParticipantService;
  conversationHandoffs: ConversationHandoffService;
  conversationSimulator: ConversationSimulatorService;
  consultations: AgentConsultationService;
  defaultCognitiveCompleter: StructuredCompleter;
  embeddingBackfill: EmbeddingBackfillService;
  engine: WorkflowEngine;
  workflowRevisions: WorkflowRevisionService;
  workflowExperience: WorkflowExperienceService;
  episodicMemoryStore: EpisodicMemoryStore;
  harnessMemoryIngestion: HarnessMemoryIngestionService;
  issues: IssueService;
  knowledgeAutoLinker: KnowledgeAutoLinker;
  mcpHarness: ReturnType<typeof McpHarnessSessionService.fromEnv>;
  orchestratorModelRouter: ReturnType<typeof OrchestratorModelRouter.fromEnv>;
  outboundPolicy: OutboundPolicyService;
  planService: PlanService;
  buildSessionService: BuildSessionService;
  scheduler: SchedulerService;
  runCompaction: import('../services/run/runCompactionService.js').RunCompactionService;
  sessionStore: AgentSessionService;
  skillMaterializer: SkillMaterializer;
  skillService: SkillService;
  specialistAgents: SpecialistAgentService;
  specialistEvals: SpecialistEvalService;
  specialistMind: SpecialistMindService;
  specialistRouter: SpecialistDemandRouter;
  specialistRuntime: SpecialistRuntimeService;
  specialistTemplates: SpecialistTemplateService;
  toolRegistry: AgentisToolRegistry;
  turnChanges: TurnChangeJournal;
  triggerRuntime: TriggerRuntime;
  voiceChannelAdapter: VoiceChannelAdapter;
  workspaceModelConfig: WorkspaceModelConfigService;
  workspaceMediaConfigService: WorkspaceMediaConfigService;
  commissionSpecialist?: (workspaceId: string, agentId: string) => void | Promise<void>;
};

export function wireRoutes(deps: WireRoutesDeps) {
  // One capability registry is shared by chat issuance/Stop and the MCP dispatch
  // boundary. Keeping it in the composition root prevents transport-local views
  // of cancellation from drifting apart.
  const conversationTurnLeases = new ConversationTurnLeaseRegistry();
  ChatSessionExecutor.setTurnLeaseRegistry(conversationTurnLeases);
  const {
    PeerProfiles,
    Reflection,
    SessionMoments,
    SharedIntelligence,
    activity,
    adapters,
    agentLibrary,
    agentMemoryService,
    agentToolRuntime,
    allowedOrigins,
    appContacts,
    appLearning,
    appOrchestrator,
    appGoal,
    strategies,
    strategyEvolution,
    experiments,
    rollingBaselineStore,
    appStores,
    approvals,
    artifactService,
    assetStore,
    auditTrail,
    auth,
    brainAsk,
    brainComposer,
    brainHealth,
    brainMaintenance,
    budgetService,
    bus,
    capabilityRegistry,
    channelBridge,
    channelIdentity,
    channelInbox,
    channelActions,
    channelSupervisor,
    chatMemoryCapture,
    commandAutonomyMaster,
    commandIndex,
    connectionGrants,
    conversationParticipants,
    conversationHandoffs,
    conversationSimulator,
    conversations,
    consultations,
    credentialVault,
    db,
    defaultCognitiveCompleter,
    documentExtraction,
    vision,
    transcription,
    runtimeProfiles,
    embeddingBackfill,
    engine,
    env,
    episodicMemoryStore,
    extensionKv,
    extensionLibrary,
    extensionRegistry,
    extensions,
    harnessMemoryIngestion,
    issues,
    knowledgeAutoLinker,
    knowledgeBaseService,
    ledger,
    logger,
    mcpAllowPrivate,
    mcpHarness,
    mcpOAuthService,
    mcpToolBridge,
    memoryStore,
    oauthService,
    oauthAppCredentialStore,
    customOAuthProviders,
    customOAuthStates,
    observability,
    orchestratorModelRouter,
    outboundPolicy,
    personalBrain,
    planService,
    buildSessionService,
    registry,
    replay,
    scheduler,
    scratchpad,
    secrets,
    sessionStore,
    skillMaterializer,
    skillService,
    specialistAgents,
    specialistEvals,
    specialistMind,
    specialistProfiles,
    specialistRouter,
    specialistRuntime,
    specialistTemplates,
    sqlite,
    toolRegistry,
    triggerRuntime,
    viewportStore,
    voiceChannelAdapter,
    workspaceHarnesses,
    workspaceIntelligence,
    workspaceModelConfig,
    workspaceMediaConfigService,
  } = deps;
  const app = new Hono();
  app.onError(errorHandler(logger));
  app.use('*', securityHeaders({ productionMode: env.NODE_ENV === 'production' }));
  app.get('/healthz', (c) => {
    const boot = bootProfileSnapshot();
    const embedding = embeddingRuntimeManager.snapshot();
    return c.json({
    ok: true,
    status: boot.ready && embedding.status === 'ready' ? 'ready' : 'degraded',
    mode: db.mode,
    runtime: 'local-first',
    standardMode: 'unsupported-in-v1',
    // §PERF-BOOT — phase timings since process start + a ready flag, so "why is
    // boot slow?" and "is it warm yet?" are answerable with one curl. Additive:
    // the web app's reachability probe only reads `ok`.
    boot,
    components: { embedding },
    });
  });
  app.route('/.well-known', buildJwksRoutes({ auth }));
  mountOpenApi(app);

  // Universal audit middleware (D38) — records every successful state-changing
  // /v1/* call to activity_events.
  app.use('/v1/*', auditLog({ activity, logger }));

  // ── Route surface (V1) ──────────────────────────────────
  const sharedPackager = new PackagerService({ db: sqlite, bus, logger, skills: skillService, brain: new EpisodicBrainPort(episodicMemoryStore) });
  app.route('/v1/auth', buildAuthRoutes({ db: sqlite, auth, secrets }));
  app.route('/v1/bootstrap', buildBootstrapRoutes({
    db: sqlite,
    auth,
    bridge: channelBridge,
    vault: credentialVault,
    adapters,
    logger,
    bus,
  }));
  app.route('/v1/dashboard', buildDashboardRoutes({ db: sqlite, auth, approvals }));
  app.route('/v1/activity', buildActivityRoutes({ db: sqlite, auth, activity }));
  app.route('/v1/observability', buildObservabilityRoutes({ db: sqlite, auth, bus, observability }));
  app.route('/v1/storage', buildStorageRoutes({
    db: sqlite,
    sqliteRaw: db.sqliteRaw!,
    auth,
    dataDir: env.AGENTIS_DATA_DIR,
    archiveDir: env.AGENTIS_ARCHIVE_DIR,
    maintenance: deps.runCompaction,
    policy: {
      fullRunDays: env.AGENTIS_STORAGE_FULL_RUN_DAYS,
      ledgerDays: env.AGENTIS_STORAGE_LEDGER_DAYS,
      observabilityDays: env.AGENTIS_STORAGE_OBSERVABILITY_DAYS,
      maxHotDbBytes: env.AGENTIS_STORAGE_MAX_HOT_DB_MB * 1024 ** 2,
      minFreeBytes: env.AGENTIS_STORAGE_MIN_FREE_MB * 1024 ** 2,
    },
  }));
  app.route('/v1/approvals', buildApprovalRoutes({ db: sqlite, auth, approvals }));
  app.route('/v1/workflows', buildWorkflowRoutes({
    db: sqlite,
    auth,
    engine,
    bus,
    packager: sharedPackager,
    triggerRuntime,
    revisions: deps.workflowRevisions,
    experience: deps.workflowExperience,
  }));
  app.route('/v1/workflows', buildAnalyticsRoutes({ db: sqlite, auth }));
  app.route('/v1/workflows', buildWorkflowIoRoutes({ db: sqlite, auth }));
  app.route('/v1/mcp', buildMcpRoutes({ db: sqlite, auth, engine, toolRegistry, turnLeases: conversationTurnLeases }));
  app.route('/v1/mcp-servers', buildMcpServerRoutes({
    db: sqlite,
    auth,
    vault: credentialVault,
    mcpBridge: mcpToolBridge,
    allowPrivateNetwork: String(process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
  }));
  app.route('/v1/a2a', buildA2aRoutes({ db: sqlite, auth, adapters, engine, activity }));
  app.route('/v1/interactions', buildInteractionRoutes({ db: sqlite, auth }));
  app.route('/v1/governance', buildGovernanceRoutes({ db: sqlite, auth, adapters }));
  app.route('/v1/ephemeral', buildEphemeralRoutes({ db: sqlite, auth, engine, bus }));
  app.route('/v1/runs', buildRunRoutes({ db: sqlite, auth, engine, ledger, scratchpad, bus, archiveStore: deps.archiveStore }));
  app.route('/v1/runs', buildReplayRoutes({ db: sqlite, auth, engine, replay }));
  app.route('/v1/runs', buildAuditRoutes({ db: sqlite, auth, audit: auditTrail }));
  app.route('/v1/extensions', buildExtensionRoutes({ db: sqlite, auth, extensionLibrary, runtime: extensions, kv: extensionKv }));
  app.route('/v1/packages', buildPackageRoutes({ db: sqlite, auth, bus, logger, skills: skillService, episodes: episodicMemoryStore }));
  app.route('/v1/hub', buildHubPackageRoutes({
    db: sqlite,
    auth,
    vault: credentialVault,
    hubUrl: env.AGENTIS_HUB_URL,
    publicKeysJson: env.AGENTIS_HUB_PUBLIC_KEYS,
    bus,
    logger,
    skills: skillService,
    episodes: episodicMemoryStore,
  }));
  app.route('/v1/skills', buildSkillRoutes({ db: sqlite, auth, skills: skillService }));
  app.route('/v1/workspace/bundle', buildWorkspaceBundleRoutes({ db: sqlite, auth, bus, logger, dataDir: env.AGENTIS_DATA_DIR, signer: { privateKeyPem: secrets.jwtPrivateKeyPem, publicKeyPem: secrets.jwtPublicKeyPem }, episodes: episodicMemoryStore }));
  app.route('/v1/artifacts', buildArtifactRoutes({ db: sqlite, auth, bus, artifacts: artifactService, assets: assetStore }));
  app.route('/v1/transcription', buildTranscriptionRoutes({
    db: sqlite,
    auth,
    transcription: new TranscriptionService({
      profile: () => orchestratorModelRouter.profile('transcription'),
      logger,
    }),
  }));
  app.route('/v1/workspace-context', buildWorkspaceContextRoutes({ db: sqlite, auth, intelligence: workspaceIntelligence }));
  app.route('/v1/workspace/intelligence', buildWorkspaceIntelligenceRoutes({ db: sqlite, auth, intelligence: SharedIntelligence, backfill: embeddingBackfill, logger }));
  app.route('/v1/runtime/embedding', buildEmbeddingRuntimeRoutes({ db: sqlite, auth }));
  app.route('/v1/memory', buildMemoryRoutes({ db: sqlite, auth, memory: memoryStore, episodes: episodicMemoryStore, brainAsk }));
  // Grounding — evidence ledger, source fabric, claims, grants, migration. The
  // claim service hears about evidence invalidation; the dispatch composer is
  // wired into SharedIntelligence (extends buildDispatchContext, RFC §12.2).
  const groundingLedger = new EvidenceLedgerService({ db: sqlite, logger });
  const groundingClaims = new ClaimService({ db: sqlite, logger, ledger: groundingLedger });
  groundingLedger.setInvalidationHandler(groundingClaims.onEvidenceInvalidated);
  const groundingIdentity = new IdentityService({ db: sqlite, logger });
  const groundingFabric = new GroundingSourceFabric({
    db: sqlite,
    logger,
    ledger: groundingLedger,
    vault: credentialVault,
    identity: groundingIdentity,
  });
  groundingFabric.register(new AgentisNativeSource(sqlite));
  const groundingModel = new GroundingModelService({ db: sqlite, logger, claims: groundingClaims });
  const groundingComposer = new GroundingContextComposer({ db: sqlite, logger });
  const groundingMigration = new GroundingMigrationService({ db: sqlite, logger, claims: groundingClaims });
  const groundingDiscovery = new GroundingDiscoveryService({ db: sqlite, logger, fabric: groundingFabric, composer: groundingComposer });
  const groundingExtraction = new GroundingExtractionService({
    db: sqlite,
    logger,
    claims: groundingClaims,
    identity: groundingIdentity,
    migration: groundingMigration,
  });
  // Adaptive-mode extraction reuses the Formation Judge's model source: when an
  // evaluator runtime is configured, free-text evidence gets model extraction;
  // otherwise Adaptive is an honest no-op (Core mode still extracts native shapes).
  const groundingInvestigations = new GroundingInvestigationService({ db: sqlite, logger, claims: groundingClaims });
  groundingExtraction.setAdaptiveCompleter(defaultCognitiveCompleter);
  groundingInvestigations.setCompleter(defaultCognitiveCompleter);
  const groundingRuntime = new GroundingRuntime({
    db: sqlite,
    logger,
    fabric: groundingFabric,
    extraction: groundingExtraction,
    model: groundingModel,
    discovery: groundingDiscovery,
  });
  SharedIntelligence.setGroundingComposer(groundingComposer);
  app.route('/v1/workspaces', buildWorkspaceRoutes({
    db: sqlite,
    auth,
    bus,
    approvals,
    groundingDiscovery,
    groundingRuntime,
  }));
  app.route('/v1/grounding', buildGroundingRoutes({
    db: sqlite,
    auth,
    fabric: groundingFabric,
    ledger: groundingLedger,
    claims: groundingClaims,
    identity: groundingIdentity,
    model: groundingModel,
    composer: groundingComposer,
    migration: groundingMigration,
    discovery: groundingDiscovery,
    runtime: groundingRuntime,
    investigations: groundingInvestigations,
  }));
  // Separate prefix: /v1/grounding/* is auth-gated; webhook ingress must not nest under it.
  app.route('/v1/grounding-webhooks', buildGroundingWebhookRoutes({ fabric: groundingFabric }));
  app.route('/v1/brain', buildBrainRoutes({
    db: sqlite,
    auth,
    brain: brainComposer,
    SharedIntelligence,
    knowledgeAutoLinker,
    health: brainHealth,
    maintenance: brainMaintenance,
    Reflection,
    agentMemory: agentMemoryService,
    peerProfiles: PeerProfiles,
    sessionMoments: SessionMoments,
  }));
  app.route('/v1/specialists', buildSpecialistRoutes({
    db: sqlite,
    auth,
    specialists: specialistAgents,
    agentLibrary,
    profiles: specialistProfiles,
    mind: specialistMind,
    router: specialistRouter,
    runtime: specialistRuntime,
    evals: specialistEvals,
    templates: specialistTemplates,
  }));
  app.route('/v1/personal-brain', buildPersonalBrainRoutes({ db: sqlite, auth, brain: personalBrain }));
  app.route('/v1/sovereignty', buildSovereigntyRoutes({ db: sqlite, auth, episodes: episodicMemoryStore, dataDir: env.AGENTIS_DATA_DIR }));
  app.route('/v1/issues', buildIssueRoutes({ db: sqlite, auth, issues, replay, engine }));
  app.route('/v1/knowledge-bases', buildKnowledgeBaseRoutes({ db: sqlite, auth, knowledge: knowledgeBaseService }));
  app.route('/v1/tools', buildToolRoutes({ db: sqlite, auth, toolRegistry }));
  app.route('/v1/capabilities', buildCapabilityRoutes({ db: sqlite, auth, capabilities: capabilityRegistry }));
  app.route('/v1/agents', buildAgentRoutes({ db: sqlite, auth, vault: credentialVault, adapters, logger, conversations, harnessMemoryIngestion, mcpHarness, skillMaterializer, episodes: episodicMemoryStore }));
  app.route('/v1/tasks', buildTaskRoutes({ db: sqlite, auth, plans: planService, sessions: sessionStore }));
  app.route('/v1/build-sessions', buildBuildSessionRoutes({ db: sqlite, auth, sessions: buildSessionService }));
  app.route('/v1/domains', buildDomainRoutes({ db: sqlite, auth, logger, adapters, bus }));
  const appStaffing = new AppStaffingService({
    store: appStores.store,
    specialists: specialistAgents,
    logger,
    commissionSpecialist: deps.commissionSpecialist,
  });
  // Live co-presence (G9) — ephemeral operator presence roster over the realtime bus.
  const appPresence = new AppPresenceService({ bus, logger });
  appPresence.start();
  app.route('/v1/apps', buildAppRoutes({ db: sqlite, auth, bus, engine, toolRuntime: agentToolRuntime, completer: defaultCognitiveCompleter, staffing: appStaffing, conversations, handoffs: conversationHandoffs, channels: channelBridge, contacts: appContacts, participants: conversationParticipants, learning: appLearning, simulator: conversationSimulator, presence: appPresence, outboundPolicy, orchestrator: appOrchestrator, triggerRuntime, episodes: episodicMemoryStore, appGoal, strategies, evolution: strategyEvolution, experiments, baselines: rollingBaselineStore }));
  const autostartTarget = buildAutostartTarget({
    platform: process.platform,
    homeDir: homedir(),
    appDataDir: process.env.APPDATA,
    execPath: process.execPath,
    scriptPath: process.argv[1] ?? '',
    dataDir: env.AGENTIS_DATA_DIR,
    cliVersion: env.AGENTIS_CLI_VERSION,
  });
  app.route('/v1/system', buildSystemRoutes({ db: sqlite, auth, currentVersion: env.AGENTIS_CLI_VERSION, autostartTarget }));
  app.route('/v1/harness', buildHarnessRoutes({ db: sqlite, auth }));
  const ownershipSync = new AgentOwnershipSyncService(sqlite, harnessMemoryIngestion, skillService, logger);
  const harnessImportDeps = { db: sqlite, auth, vault: credentialVault, adapters, logger, bus, mcpHarness, ingestion: harnessMemoryIngestion, skills: skillService, skillMaterializer, ownershipSync };
  app.route('/v1/harness', buildHarnessImportRoutes(harnessImportDeps));
  const harnessImportSync = new HarnessImportSyncService(harnessImportDeps, bus, logger, undefined, ownershipSync);
  app.route('/v1/adapters', buildHarnessRoutes({ db: sqlite, auth }));
  app.route('/v1/agents', buildTerminalRoutes({ db: sqlite, auth, conversations }));
  app.route('/v1/gateways', buildGatewayRoutes({ db: sqlite, auth, vault: credentialVault }));
  app.route('/v1/gateways', buildGatewayMutationRoutes({ db: sqlite, auth, vault: credentialVault }));
  app.route('/v1/ambients', buildAmbientRoutes({ db: sqlite, auth }));
  app.route('/v1/budgets', buildBudgetRoutes({ db: sqlite, auth, budget: budgetService }));
  app.route('/v1/command', buildCommandRoutes({ db: sqlite, auth, commandIndex }));
  app.route('/v1/scheduler', buildSchedulerRoutes({ db: sqlite, auth }));
  app.route('/v1/command', buildCommandAutonomyRoutes({ db: sqlite, auth, master: commandAutonomyMaster }));
  app.route('/v1/browser', buildBrowserControlRoutes({ db: sqlite, auth }));
  app.route('/v1/triggers', buildTriggerRoutes({ db: sqlite, auth, runtime: triggerRuntime }));
  app.route('/v1/listeners', buildListenerRoutes({ db: sqlite, auth, runtime: triggerRuntime }));
  app.route('/v1/webhooks', buildWebhookRoutes({ runtime: triggerRuntime, bridge: channelBridge, voice: voiceChannelAdapter }));
  app.route('/v1/credentials', buildCredentialRoutes({ db: sqlite, auth, vault: credentialVault }));
  // Mounted BEFORE the built-in /v1/oauth/:provider routes so the static
  // "custom" segment can never be shadowed by the built-in dynamic :provider
  // param (asProvider() also rejects "custom" as an unknown built-in provider,
  // a backstop either way).
  app.route('/v1/oauth/custom', buildCustomOAuthRoutes({
    db: sqlite,
    auth,
    vault: credentialVault,
    providers: customOAuthProviders,
    states: customOAuthStates,
    allowedOrigins,
    baseUrl: env.AGENTIS_PUBLIC_URL ?? `http://${env.AGENTIS_HTTP_HOST}:${env.AGENTIS_HTTP_PORT}`,
  }));
  app.route('/v1/oauth', buildOAuthRoutes({ db: sqlite, auth, vault: credentialVault, oauth: oauthService, oauthAppCredentials: oauthAppCredentialStore, allowedOrigins }));
  app.route('/v1/mcp-oauth', buildMcpOAuthRoutes({
    db: sqlite,
    auth,
    vault: credentialVault,
    oauth: mcpOAuthService,
    publicUrl: env.AGENTIS_PUBLIC_URL ?? `http://${env.AGENTIS_HTTP_HOST}:${env.AGENTIS_HTTP_PORT}`,
    allowedOrigins,
    allowPrivateNetwork: mcpAllowPrivate,
  }));
  app.route('/v1/integrations', buildIntegrationRoutes({ db: sqlite, auth }));
  app.route('/v1/conversations', buildConversationRoutes({
    db: sqlite,
    auth,
    conversations,
    adapters,
    logger,
    viewportStore,
    bus,
    engine,
    plans: planService,
    turnLeases: conversationTurnLeases,
    memoryCapture: chatMemoryCapture,
    audit: auditTrail,
    artifacts: artifactService,
    documents: documentExtraction,
    vision,
    transcription,
    runtimeProfiles,
    handoffs: conversationHandoffs,
    consultations,
    turnChanges: deps.turnChanges,
  }));
  const broadcastDispatcher = new BroadcastDispatcher({ db: sqlite, adapters, conversations, bus, logger });
  app.route('/v1/rooms', buildRoomRoutes({ db: sqlite, auth, bus, broadcast: broadcastDispatcher }));
  app.route('/v1/history', buildHistoryRoutes({ db: sqlite, auth }));
  app.route('/v1/channels', buildChannelRoutes({ db: sqlite, auth, bridge: channelBridge, supervisor: channelSupervisor, identity: channelIdentity, inbox: channelInbox, actions: channelActions, connectionGrants }));
  app.route('/v1/orchestrator/models', buildOrchestratorModelRoutes({
    db: sqlite,
    auth,
    config: workspaceModelConfig,
    router: orchestratorModelRouter,
    harnesses: workspaceHarnesses,
  }));
  app.route('/v1/media/models', buildMediaConfigRoutes({
    db: sqlite,
    auth,
    config: workspaceMediaConfigService,
    envDefaults: {
      image: {
        baseUrl: env.AGENTIS_MEDIA_IMAGE_BASE_URL,
        model: env.AGENTIS_MEDIA_IMAGE_MODEL,
        hasApiKey: Boolean(env.AGENTIS_MEDIA_IMAGE_API_KEY),
      },
      speech: {
        baseUrl: env.AGENTIS_MEDIA_SPEECH_BASE_URL,
        model: env.AGENTIS_MEDIA_SPEECH_MODEL,
        hasApiKey: Boolean(env.AGENTIS_MEDIA_SPEECH_API_KEY),
      },
      audio: {
        baseUrl: env.AGENTIS_MEDIA_AUDIO_BASE_URL,
        model: env.AGENTIS_MEDIA_AUDIO_MODEL,
        hasApiKey: Boolean(env.AGENTIS_MEDIA_AUDIO_API_KEY),
      },
    },
  }));
  app.route('/v1/extensions/registry', buildExtensionRegistryRoutes({ db: sqlite, auth, registry: extensionRegistry, activity }));
  // Mounted ONLY when AGENTIS_TEST_MODE=true AND NODE_ENV !== 'production'.
  if (env.AGENTIS_TEST_MODE) {
    if (env.NODE_ENV === 'production') {
      logger.error('agentis.test_mode.refused', {
        reason: 'AGENTIS_TEST_MODE=true is forbidden when NODE_ENV=production',
        action: 'unset AGENTIS_TEST_MODE or change NODE_ENV',
      });
    } else {
      app.route(
        '/v1/_test',
        buildTestHarnessRoutes({ db: sqlite, auth, env, logger }),
      );
      logger.warn('agentis.test_mode.enabled', {
        reset: '/v1/_test/reset',
        seedPassword: env.AGENTIS_SEED_PASSWORD ? '<custom>' : 'test-password-1234',
        nodeEnv: env.NODE_ENV,
      });
    }
  }

  // ── Static dashboard (D21) ──────────────────────────────
  // Mount LAST so it doesn't shadow API routes. SPA fallback rewrites
  // unknown paths to index.html. Disabled when AGENTIS_DASHBOARD_DIST is unset.
  if (env.AGENTIS_DASHBOARD_DIST) {
    const distRoot = path.resolve(env.AGENTIS_DASHBOARD_DIST);
    app.use('/*', serveStatic({ root: distRoot }));
    app.get('*', serveStatic({ path: 'index.html', root: distRoot }));
    logger.info('agentis.dashboard.mounted', { dist: distRoot });
  }
  return {
    app,
    groundingRuntime,
    harnessImportSync,
  };
}
