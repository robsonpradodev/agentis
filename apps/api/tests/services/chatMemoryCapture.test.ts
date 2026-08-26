import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { ChatMemoryCaptureService } from '../../src/services/chat/chatMemoryCapture.js';
import { CognitivePromotionQueueWorker } from '../../src/services/cognitivePromotionQueueWorker.js';
import { ConversationStore } from '../../src/services/conversation/conversationStore.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { StubEmbeddingProvider } from '../_helpers/stubEmbeddingProvider.js';
import { MemoryStore } from '../../src/services/memory/memoryStore.js';
import { memoryEligiblePeerMessages, PeerProfileService } from '../../src/services/peerProfileService.js';
import { SessionMomentService } from '../../src/services/sessionMomentService.js';
import { SharedIntelligenceService } from '../../src/services/sharedIntelligence.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => ctx.close());

function seedAgent(): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    name: 'Memory Agent',
    adapterType: 'http',
    capabilityTags: [],
    config: {},
    status: 'online',
  }).run();
  return id;
}

function buildCaptureStack() {
  const embedding = new StubEmbeddingProvider();
  const episodes = new EpisodicMemoryStore(ctx.db, ctx.logger, embedding);
  const shared = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
  const queue = new CognitivePromotionQueueWorker(ctx.db, shared, ctx.logger);
  const peers = new PeerProfileService(ctx.db, ctx.bus, ctx.logger);
  const sessionMoments = new SessionMomentService(ctx.db, ctx.bus, ctx.logger);
  const memory = new MemoryStore(ctx.db, ctx.logger);

  peers.queue = queue;
  queue.PeerProfiles = peers;

  return {
    queue,
    peers,
    service: new ChatMemoryCaptureService({
      db: ctx.db,
      logger: ctx.logger,
      peerProfiles: peers,
      sessionMoments,
      brainQueue: queue,
      memory,
    }),
  };
}

describe('ChatMemoryCaptureService', () => {
  it('never promotes reconciled provider history or business-side channel messages into customer memory', async () => {
    const eligible = memoryEligiblePeerMessages([
      {
        authorType: 'system', participantSide: 'customer', body: 'I prefer COBOL.',
        metadata: { channelHistoryReconciled: true, channelInbound: true },
      },
      { authorType: 'operator', participantSide: 'business', body: 'I prefer React.' },
      { authorType: 'system', participantSide: 'customer', body: 'I prefer Rust.', metadata: { channelInbound: true } },
    ], true);

    expect(eligible).toEqual([
      { role: 'assistant', text: 'I prefer React.' },
      { role: 'user', text: 'I prefer Rust.' },
    ]);
    expect(eligible.some((message) => message.text.includes('COBOL'))).toBe(false);
  });

  it('captures stable instructions once into workspace memory, session moments, and peer updates', async () => {
    const agentId = seedAgent();
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const conversation = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
    });
    const userMessage = [
      'Always respond in English.',
      'I prefer TypeScript for code examples.',
      'I am the founder of Nexseed.',
    ].join(' ');
    conversations.appendOutbound({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      operatorId: ctx.user.id,
      body: userMessage,
    });
    conversations.appendMirrored({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      sessionMessageId: `chat_${randomUUID()}`,
      authorType: 'agent',
      body: 'Got it. I will keep those preferences in mind.',
    });

    const { queue, service } = buildCaptureStack();
    const result = await service.captureTurn({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      userId: ctx.user.id,
      agentId,
      userDisplayName: ctx.user.displayName,
      userMessage,
      assistantMessage: 'Got it. I will keep those preferences in mind.',
      finishReason: 'stop',
    });

    expect(result.signals).toBe(3);
    expect(result.peerUpdateJobIds).toHaveLength(2);
    expect(result.sessionMomentId).toBeTruthy();
    // Durable memory now forms ASYNC through the SAME formation pipeline runs use
    // (cognitive promotion queue → FormationJudge / durable operator fallback), so
    // it is enqueued — not written inline.
    expect(result.workspaceMemoryIds).toHaveLength(0);

    const queued = ctx.db.select().from(schema.cognitivePromotionQueue).where(eq(schema.cognitivePromotionQueue.workspaceId, ctx.workspace.id)).all();
    expect(queued.filter((row) => row.itemType === 'peer_update')).toHaveLength(2);
    expect(queued.filter((row) => row.itemType === 'atom_promotion')).toHaveLength(1);

    // Drain the queue (1 atom_promotion + 2 peer_update).
    for (let i = 0; i < 5; i += 1) await queue.poll();

    // The operator's three statements are durably captured in the WORKSPACE mind.
    // No model is wired here, so the durable operator fallback writes them as
    // `operator_write` atoms (scopeId null) — reconciled, not duplicated.
    const formed = ctx.db.select().from(schema.memoryEpisodes).where(eq(schema.memoryEpisodes.workspaceId, ctx.workspace.id)).all()
      .filter((row) => row.source === 'operator_write');
    const formedText = formed.map((row) => row.summary).join('\n');
    expect(formedText).toContain('TypeScript');
    expect(formedText).toContain('English');
    expect(formedText).toContain('founder');

    // Operator statements live in the workspace mind, not copied into the agent's
    // private brain (memory_episodes scoped to the agent).
    const agentScoped = ctx.db.select().from(schema.memoryEpisodes).where(eq(schema.memoryEpisodes.scopeId, agentId)).all();
    expect(agentScoped).toHaveLength(0);

    const peerProfiles = ctx.db.select().from(schema.peerProfiles).where(eq(schema.peerProfiles.peerId, ctx.user.id)).all();
    expect(peerProfiles).toHaveLength(1);

    const directionalCards = ctx.db.select().from(schema.agentPeerCards).where(eq(schema.agentPeerCards.observerPeerId, agentId)).all();
    expect(directionalCards).toHaveLength(1);

    const conclusions = ctx.db.select().from(schema.peerProfileConclusions).where(eq(schema.peerProfileConclusions.subjectPeerId, ctx.user.id)).all();
    expect(conclusions.map((row) => row.content).join('\n')).toContain('Always respond in English');
  });

  it('reconciles a restated rule instead of duplicating it (the "asked twice" fix)', async () => {
    const agentId = seedAgent();
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const conversation = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
    });
    const { queue, service } = buildCaptureStack();
    const turn = (userMessage: string, assistantMessage: string) => service.captureTurn({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      userId: ctx.user.id,
      agentId,
      userDisplayName: ctx.user.displayName,
      userMessage,
      assistantMessage,
      finishReason: 'stop',
    });
    const drain = async () => { for (let i = 0; i < 4; i += 1) await queue.poll(); };
    const operatorMemories = () => ctx.db.select().from(schema.memoryEpisodes)
      .where(eq(schema.memoryEpisodes.workspaceId, ctx.workspace.id)).all()
      .filter((row) => row.source === 'operator_write');

    await turn('Always use HTTPS for API endpoints.', 'Understood.');
    await drain();
    expect(operatorMemories()).toHaveLength(1);

    // Restating the SAME rule must NOT create a second row — it reconciles.
    await turn('Always use HTTPS for API endpoints.', 'Got it.');
    await drain();
    expect(operatorMemories()).toHaveLength(1);

    // A genuinely different rule is a new memory (not over-collapsed).
    await turn('Never log customer PII.', 'Acknowledged.');
    await drain();
    expect(operatorMemories()).toHaveLength(2);
  });

  it('persists an explicit specialist correction immediately as an agent-scoped governing rule', async () => {
    const agentId = seedAgent();
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const conversation = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
    });
    const { service } = buildCaptureStack();
    const userMessage = "please one more time, DO NOT CHANGE THE CHAIN CONFIG THAT YOU HAVE DONE, you simply removed it, and now pipeline doesn't run at a time";

    const turnArgs = {
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      userId: ctx.user.id,
      agentId,
      userDisplayName: ctx.user.displayName,
      userMessage,
    };

    // This is the inbound-route call: the rule exists before an assistant turn.
    const immediateId = service.captureImmediateCorrection(turnArgs);
    expect(immediateId).toBeTruthy();
    const immediate = ctx.db.select().from(schema.memoryEpisodes)
      .where(eq(schema.memoryEpisodes.id, immediateId!)).get();
    expect(immediate?.governing).toBe(true);

    const result = await service.captureTurn({
      ...turnArgs,
      assistantMessage: 'I restored the chain configuration.',
      finishReason: 'stop',
    });

    expect(result.workspaceMemoryIds).toHaveLength(1);
    expect(result.workspaceMemoryIds[0]).toBe(immediateId);
    const correction = ctx.db.select().from(schema.memoryEpisodes)
      .where(eq(schema.memoryEpisodes.id, result.workspaceMemoryIds[0]!)).get();
    expect(correction).toMatchObject({
      workspaceId: ctx.workspace.id,
      scopeId: agentId,
      source: 'operator_write',
      governing: true,
      status: 'active',
    });
    expect(correction?.summary).toContain('DO NOT CHANGE THE CHAIN CONFIG');
    expect(correction?.tags).toEqual(expect.arrayContaining(['operator_correction', 'immediate']));
    expect(ctx.db.select().from(schema.memoryEpisodes)
      .where(eq(schema.memoryEpisodes.workspaceId, ctx.workspace.id)).all()
      .filter((row) => (row.tags as string[]).includes('operator_correction'))).toHaveLength(1);

    const promotion = ctx.db.select().from(schema.cognitivePromotionQueue)
      .where(eq(schema.cognitivePromotionQueue.itemType, 'atom_promotion')).get();
    expect(promotion?.payload).toMatchObject({ scopeId: agentId, originSurface: 'operator_chat' });
  });

  it('recognizes an explicit Portuguese owner correction before the reply starts', () => {
    const agentId = seedAgent();
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const conversation = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
    });
    const { service } = buildCaptureStack();

    const id = service.captureImmediateCorrection({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      userId: ctx.user.id,
      agentId,
      userDisplayName: 'Robson',
      userMessage: 'Isso está errado; a partir de agora não confunda exemplos de clientes com fatos sobre mim.',
      senderTrust: 'owner',
    });

    expect(id).toBeTruthy();
    const memory = ctx.db.select().from(schema.memoryEpisodes).where(eq(schema.memoryEpisodes.id, id!)).get();
    expect(memory).toMatchObject({ scopeId: agentId, governing: true, source: 'operator_write' });
  });

  it('does not capture a question as a preference', async () => {
    const agentId = seedAgent();
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const conversation = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
    });

    const { service } = buildCaptureStack();
    // "how do I like responses?" embeds "I like" but is a question, not a
    // stated preference — it must not become a workspace memory atom.
    const result = await service.captureTurn({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      userId: ctx.user.id,
      agentId,
      userDisplayName: ctx.user.displayName,
      userMessage: 'how do I like responses?',
      assistantMessage: 'You tend to prefer concise, direct answers.',
      finishReason: 'stop',
    });

    expect(result.signals).toBe(0);
    expect(result.workspaceMemoryIds).toHaveLength(0);
    const workspaceMemory = ctx.db.select().from(schema.memoryEpisodes).where(eq(schema.memoryEpisodes.workspaceId, ctx.workspace.id)).all()
      .filter((row) => (row.tags as string[]).includes('plane:workspace_memory'));
    expect(workspaceMemory).toHaveLength(0);
  });

  it('learns a verified repair from tool evidence even when final prose has no learning keywords', async () => {
    const agentId = seedAgent();
    const { queue, service } = buildCaptureStack();
    const result = await service.captureTurn({
      workspaceId: ctx.workspace.id,
      conversationId: randomUUID(),
      userId: ctx.user.id,
      agentId,
      userMessage: 'repair the current application',
      assistantMessage: 'Done.',
      finishReason: 'stop',
      experience: {
        toolCalls: 3,
        recalledAtomIds: ['recalled-memory-1'],
        efficiency: {
          uniqueObservations: 3,
          coalescedReads: 0,
          mutatingCalls: 1,
          argumentCharsObserved: 120,
          resultCharsObserved: 180,
          repeatedResultChars: 0,
        },
        observations: [
          { index: 1, name: 'agentis.app.compile', args: { appId: 'app-1' }, result: { counts: { block: 4 } }, ok: true, mutating: false, repeats: 1, durationMs: 4 },
          { index: 2, name: 'agentis.data.batch', args: { operations: [{ operation: 'update' }] }, result: { ok: true }, ok: true, mutating: true, repeats: 1, durationMs: 3 },
          { index: 3, name: 'agentis.app.verify', args: { appId: 'app-1' }, result: { compile: { counts: { block: 0 }, readyForExecution: true } }, ok: true, mutating: false, repeats: 1, durationMs: 8 },
        ],
      },
    });

    // App + operating agent each receive the same evidence-backed experience;
    // exact-scope dedup/reinforcement prevents raw-log growth.
    expect(result.experienceJobIds).toHaveLength(2);
    for (let i = 0; i < 4; i += 1) await queue.poll();
    const experiences = ctx.db.select().from(schema.memoryEpisodes)
      .where(eq(schema.memoryEpisodes.workspaceId, ctx.workspace.id)).all()
      .filter((row) => (row.tags as string[]).includes('turn_experience'));
    expect(experiences).toHaveLength(2);
    expect(experiences.map((row) => row.scopeId)).toEqual(expect.arrayContaining(['app-1', agentId]));
    expect(experiences.map((row) => row.summary).join('\n')).toContain('4 → 0');
    expect(experiences.every((row) => row.type === 'success_pattern')).toBe(true);
    const positiveRecallEvents = ctx.db.select().from(schema.brainQualityEvents)
      .where(eq(schema.brainQualityEvents.atomId, 'recalled-memory-1')).all()
      .filter((row) => row.eventType === 'atom_injected');
    expect(positiveRecallEvents).toHaveLength(1);
    expect(positiveRecallEvents[0]?.scopeId).toBe(agentId);
  });
});
