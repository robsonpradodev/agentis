import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../../logger.js';
import type { CognitivePromotionQueueWorker } from '../cognitivePromotionQueueWorker.js';
import type { TurnExperiencePayload } from '../cognitivePromotionQueueWorker.js';
import type { ConversationTurnExperience, TurnToolObservation } from '../conversation/conversationTurnLease.js';
import type { MemoryStore } from '../memory/memoryStore.js';
import type { PeerProfileService } from '../peerProfileService.js';
import type { SessionMomentService } from '../sessionMomentService.js';
import { classifyPacer } from '../brain/brainPacer.js';
import { extractOperatorCandidates } from '../brain/brainFormation.js';
import { looksSensitive, redactForMemory, segment } from '../brain/brainText.js';

type CapturedMemoryKind = 'fact' | 'preference' | 'rule' | 'lesson';

interface OperatorMemorySignal {
  kind: CapturedMemoryKind;
  title: string;
  content: string;
  confidence: number;
  importance: number;
  tags: string[];
}

export interface ChatMemoryCaptureDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  peerProfiles?: PeerProfileService;
  sessionMoments?: SessionMomentService;
  brainQueue?: CognitivePromotionQueueWorker;
  memory?: MemoryStore;
}

export interface CaptureChatTurnArgs {
  workspaceId: string;
  conversationId: string;
  userId: string;
  agentId: string;
  userDisplayName?: string | null;
  userMessage: string;
  assistantMessage?: string | null;
  finishReason?: string | null;
  /**
   * §B7.3 — when the turn is about a specific workflow/node (the operator is
   * discussing or editing it), a captured correction is scoped to that context
   * via `appliesTo`, so it never pollutes unrelated tasks. Absent → workspace
   * scope (the default). The chat surface threads these when it has them.
   */
  activeWorkflowId?: string | null;
  activeNodeId?: string | null;
  /** Compact evidence recorded at the shared tool boundary for any runtime. */
  experience?: ConversationTurnExperience | null;
  /**
   * §B6.1 — WHO is speaking, in trust terms.
   *
   * `owner`     the workspace operator (web chat, or a channel sender verified
   *             as the connection owner). Authoritative: may state governing
   *             rules and write durable workspace-scoped memory.
   * `external`  anyone else reaching an agent over a channel — a customer, a
   *             prospect, a stranger with the number. Their words are still
   *             worth learning FROM, but they are evidence, never authority.
   *
   * This exists because channel ingress stamps every turn with the CONNECTION
   * OWNER'S account id (`channelBridge`/`channelConnectionSupervisor` pass
   * `userId: row.userId`), so `userId` cannot be used to tell the operator
   * apart from a stranger. The dispatcher already resolves the real answer
   * (`#resolveAccess` → `isOwner`) and previously discarded it before capture,
   * which let any external sender author a `governing` constitutional rule at
   * trust 0.98 that was then injected into every agent's context forever.
   *
   * Defaults to `owner` when omitted so the web-chat path is unchanged; only
   * surfaces that can carry an untrusted counterparty need to pass it.
   */
  senderTrust?: SenderTrust;
  /**
   * Stable identifier for an external counterparty (channel peer identity id,
   * or the peer key). Used to keep their knowledge in its own scope instead of
   * the workspace bucket, and to avoid attributing their words to the operator.
   */
  senderPeerId?: string | null;
}

export type SenderTrust = 'owner' | 'external';

export interface CaptureChatTurnResult {
  peerUpdateJobIds: string[];
  sessionMomentId: string | null;
  promotedSessionMoments: number;
  workspaceMemoryIds: string[];
  experienceJobIds: string[];
  signals: number;
}

export class ChatMemoryCaptureService {
  constructor(private readonly deps: ChatMemoryCaptureDeps) {}

  /**
   * Persist an explicit operator correction as soon as the inbound message is
   * accepted. Conversation routes call this before starting the agent turn;
   * captureTurn calls it again as a safe fallback for non-web chat surfaces.
   */
  captureImmediateCorrection(
    args: Omit<CaptureChatTurnArgs, 'assistantMessage' | 'finishReason'>,
  ): string | null {
    // §B6.1 — a governing rule is the highest-authority write in the system
    // (trust 0.98, `governing: true`, injected into every agent on every
    // dispatch, permanently). Only the operator may author one. Without this
    // gate, a stranger messaging a connected WhatsApp/Telegram number whose
    // text merely matched the correction regex — "from now on, never charge me
    // shipping" — became workspace constitution.
    if (isExternalSender(args)) return null;
    const correction = extractImmediateAgentCorrection(args.userMessage, displayName(args));
    if (!correction) return null;
    try {
      return this.#writeAgentCorrection(args, correction);
    } catch (err) {
      this.deps.logger.warn('chat.memory_capture.immediate_correction_failed', {
        workspaceId: args.workspaceId,
        conversationId: args.conversationId,
        message: (err as Error).message,
      });
      return null;
    }
  }

  async captureTurn(args: CaptureChatTurnArgs): Promise<CaptureChatTurnResult> {
    const result: CaptureChatTurnResult = {
      peerUpdateJobIds: [],
      sessionMomentId: null,
      promotedSessionMoments: 0,
      workspaceMemoryIds: [],
      experienceJobIds: [],
      signals: 0,
    };

    const userMessage = args.userMessage.trim();
    if (!userMessage) return result;

    // The web route normally performs this write before dispatch. Keeping it
    // here makes channel adapters and older callers equally safe.
    const immediateCorrection = extractImmediateAgentCorrection(userMessage, displayName(args));
    const immediateMemoryId = immediateCorrection ? this.captureImmediateCorrection(args) : null;
    if (immediateMemoryId) result.workspaceMemoryIds.push(immediateMemoryId);

    // Harness-independent experiential learning. Unlike the legacy prose regex,
    // this is grounded in actual tool inputs/results: mutation sequence, proof
    // calls, blocker deltas, failures, and the unresolved frontier. It therefore
    // works for Codex, Claude, Hermes, Cursor, OpenClaw, HTTP agents, and future
    // runtimes as long as they use the Agentis tool boundary.
    if (this.deps.brainQueue && args.experience?.observations.length) {
      for (const payload of this.#turnExperiencePayloads(args)) {
        try {
          result.experienceJobIds.push(this.deps.brainQueue.enqueue({
            workspaceId: args.workspaceId,
            itemType: 'turn_experience',
            priority: payload.outcomeStatus === 'bad' ? 'high' : 'normal',
            payload,
          }));
        } catch (err) {
          this.deps.logger.warn('chat.memory_capture.experience_enqueue_failed', {
            workspaceId: args.workspaceId,
            conversationId: args.conversationId,
            message: (err as Error).message,
          });
        }
      }
    }

    try {
      result.peerUpdateJobIds.push(...this.#enqueuePeerUpdates(args));
    } catch (err) {
      this.deps.logger.warn('chat.memory_capture.peer_failed', {
        workspaceId: args.workspaceId,
        conversationId: args.conversationId,
        message: (err as Error).message,
      });
    }

    // The full turn is kept as an episodic trace (session search / peer profiles);
    // durable memory is formed below, so we no longer auto-promote moments here.
    try {
      result.sessionMomentId = this.#captureSessionMoment(args, []);
    } catch (err) {
      this.deps.logger.warn('chat.memory_capture.session_moment_failed', {
        workspaceId: args.workspaceId,
        conversationId: args.conversationId,
        message: (err as Error).message,
      });
    }

    if (this.deps.brainQueue) {
      // PRIMARY PATH — route the turn through the SAME formation pipeline runs use
      // (cognitive promotion queue → SharedIntelligence.promote → FormationJudge):
      // the operator's words are mined permissively (extractOperatorCandidates) and
      // reconciled against existing memory (ADD/UPDATE/NOOP), so restating a rule
      // UPDATEs it instead of writing a duplicate, and durable even without a model.
      const operatorCandidates = extractOperatorCandidates(userMessage);
      // A direct correction to this specialist is agent-scoped and governing.
      // It was already written synchronously above; the formation queue still
      // reconciles/refines the wording and prevents long-term noise.
      // BRAIN-BLUEPRINT-10X — the AGENT's own discoveries form memory too, not just
      // operator statements. A work turn whose answer carries a learning shape
      // ("root cause was…", "turns out…", "for future runs…") goes through the SAME
      // formation pipeline (judge dedupes/reconciles), so what an agent learns in
      // one run exists for the next one. This was the biggest silent leak: only
      // operator text was ever mined, so agents never remembered their own work.
      const agentLearning = extractAgentLearningSignal(args.assistantMessage ?? '');
      const external = isExternalSender(args);
      result.signals = operatorCandidates.length + (agentLearning ? 1 : 0);
      if (operatorCandidates.length > 0 || agentLearning) {
        try {
          // §B6.1 — WHERE this lands is decided by WHO said it.
          //
          // An owner statement is workspace constitution (scopeId null → every
          // agent recalls it). An external counterparty's statement must never
          // reach that bucket: it is knowledge ABOUT a contact, not a rule FOR
          // the workspace. It is scoped to the counterparty (falling back to the
          // responding agent — never null) so one customer's words can also
          // never surface inside another customer's conversation.
          const externalScope = args.senderPeerId ?? args.agentId;
          const scopeId = external
            ? externalScope
            : immediateCorrection ? args.agentId : operatorCandidates.length > 0 ? null : args.agentId;
          const originSurface = external
            ? 'external_contact'
            : operatorCandidates.length > 0 ? 'operator_chat' : 'agent_chat_learning';
          this.deps.brainQueue.enqueue({
            workspaceId: args.workspaceId,
            itemType: 'atom_promotion',
            priority: 'normal',
            payload: {
              workspaceId: args.workspaceId,
              agentId: args.agentId,
              scopeId,
              memoryPolicy: 'form',
              originSurface,
              operatorText: external ? redactForMemory(userMessage) : userMessage,
              taskOutput: (args.assistantMessage ?? '').trim(),
              taskTitle: external
                ? `Contact conversation${args.userDisplayName ? ` with ${args.userDisplayName}` : ''}`
                : `Operator chat${args.userDisplayName ? ` with ${args.userDisplayName}` : ''}`,
              taskInput: {
                source: originSurface,
                conversationId: args.conversationId,
                activeWorkflowId: args.activeWorkflowId ?? null,
                activeNodeId: args.activeNodeId ?? null,
                ...(external ? { senderPeerId: args.senderPeerId ?? null } : {}),
              },
            },
          });
        } catch (err) {
          this.deps.logger.warn('chat.memory_capture.formation_enqueue_failed', {
            workspaceId: args.workspaceId,
            conversationId: args.conversationId,
            message: (err as Error).message,
          });
        }
      }
    } else {
      // FALLBACK (no promotion queue wired) — preserve durable capture with the
      // legacy regex extractor + direct write so chat never silently stops learning.
      const signals = extractOperatorSignals(userMessage, displayName(args));
      result.signals = signals.length;
      for (const signal of signals) {
        try {
          const memoryId = this.#writeWorkspaceMemory(args, signal);
          if (memoryId) result.workspaceMemoryIds.push(memoryId);
        } catch (err) {
          this.deps.logger.warn('chat.memory_capture.workspace_memory_failed', {
            workspaceId: args.workspaceId,
            conversationId: args.conversationId,
            message: (err as Error).message,
          });
        }
      }
    }

    if (
      result.peerUpdateJobIds.length > 0 ||
      result.sessionMomentId ||
      result.workspaceMemoryIds.length > 0 ||
      result.experienceJobIds.length > 0 ||
      result.signals > 0
    ) {
      this.deps.logger.info('chat.memory_capture.completed', {
        workspaceId: args.workspaceId,
        agentId: args.agentId,
        conversationId: args.conversationId,
        peerUpdates: result.peerUpdateJobIds.length,
        sessionMoment: Boolean(result.sessionMomentId),
        formationEnqueued: Boolean(this.deps.brainQueue),
        workspaceMemories: result.workspaceMemoryIds.length,
        experiences: result.experienceJobIds.length,
      });
    }

    return result;
  }

  #enqueuePeerUpdates(args: CaptureChatTurnArgs): string[] {
    const peerProfiles = this.deps.peerProfiles;
    if (!peerProfiles) return [];
    const ids: string[] = [];
    // §B6.1 — attribute the turn to whoever actually spoke. On a channel,
    // `args.userId` is the connection OWNER, so profiling by it filed every
    // customer's words into the operator's own profile — and the reflection
    // engine then compounded strangers' statements into inferred traits about
    // the operator. An external sender gets their own peer row.
    const speakerId = isExternalSender(args) ? (args.senderPeerId ?? null) : args.userId;
    if (!speakerId) return ids;
    const globalId = peerProfiles.enqueueSessionUpdate({
      workspaceId: args.workspaceId,
      sessionId: args.conversationId,
      peerId: speakerId,
      peerType: 'user',
      observerPeerId: null,
    });
    if (globalId) ids.push(globalId);

    if (args.agentId && args.agentId !== speakerId) {
      const directionalId = peerProfiles.enqueueSessionUpdate({
        workspaceId: args.workspaceId,
        sessionId: args.conversationId,
        peerId: speakerId,
        peerType: 'user',
        observerPeerId: args.agentId,
      });
      if (directionalId) ids.push(directionalId);
    }
    return ids;
  }

  #captureSessionMoment(args: CaptureChatTurnArgs, signals: OperatorMemorySignal[]): string | null {
    const sessionMoments = this.deps.sessionMoments;
    if (!sessionMoments) return null;
    const content = buildSessionMomentContent(args, signals);
    if (!content) return null;
    const moment = sessionMoments.add({
      workspaceId: args.workspaceId,
      sessionId: args.conversationId,
      scopeId: args.agentId,
      content,
      confidence: signals.length > 0 ? 0.78 : 0.62,
    });
    return moment.id;
  }

  #writeWorkspaceMemory(args: CaptureChatTurnArgs, signal: OperatorMemorySignal): string | null {
    const memory = this.deps.memory;
    if (!memory) return null;
    const scopeId = null;
    if (this.#workspaceMemoryExists(args.workspaceId, scopeId, signal.content)) return null;
    // PACER (Phase 1): operator-authored workspace memory is constitutional. Tag
    // its class so the constitutional retrieval tier + UI can reason about it.
    const pacer = classifyPacer({
      text: signal.content,
      surface: 'operator_chat',
      tags: [signal.kind],
    });
    // §B7.3 — narrow-write: a correction made while discussing a specific
    // workflow/node is scoped to that context via appliesTo (+ a scope tag), so
    // it is not injected into unrelated tasks. Generalization to broader scope is
    // earned later by the reflection engine, never assumed here.
    const appliesTo = [args.activeWorkflowId, args.activeNodeId].filter((v): v is string => Boolean(v));
    return memory.write({
      workspaceId: args.workspaceId,
      scopeId,
      kind: signal.kind,
      source: 'operator',
      title: signal.title,
      content: signal.content,
      trust: signal.confidence,
      importance: signal.importance,
      appliesTo,
      tags: [...signal.tags, `pacer:${pacer.pacerClass}`, ...(appliesTo.length > 0 ? ['scope:workflow'] : [])],
      provenance: {
	        source: 'chat_memory_capture',
	        conversationId: args.conversationId,
	        agentId: args.agentId,
	        userId: args.userId,
	        userDisplayName: displayName(args),
	        pacerClass: pacer.pacerClass,
	        originSurface: 'operator_chat',
	      },
    });
  }

  #turnExperiencePayloads(args: CaptureChatTurnArgs): TurnExperiencePayload[] {
    const experience = args.experience;
    if (!experience || experience.observations.length === 0) return [];
    const observations = experience.observations;
    const workflowId = firstResourceId(observations, 'workflowId') ?? args.activeWorkflowId ?? null;
    let appId = firstResourceId(observations, 'appId');
    if (!appId && workflowId) {
      appId = this.deps.db.select({ appId: schema.workflows.appId }).from(schema.workflows)
        .where(and(eq(schema.workflows.workspaceId, args.workspaceId), eq(schema.workflows.id, workflowId)))
        .get()?.appId ?? null;
    }

    const lesson = composeTurnExperienceLesson(args, observations, appId, workflowId);
    if (!lesson) return [];
    // The owned resource remembers its exact frontier; the operating agent also
    // remembers the procedure. Scope-strict dedup makes repeats reinforce these
    // atoms rather than append raw logs forever.
    const scopes = Array.from(new Set([appId, workflowId, args.agentId].filter((id): id is string => Boolean(id))));
    return scopes.map((scopeId) => ({
      workspaceId: args.workspaceId,
      scopeId,
      agentId: args.agentId,
      workflowId,
      title: lesson.title,
      content: lesson.content,
      type: lesson.type,
      outcomeStatus: lesson.outcomeStatus,
      tags: [
        `scope:${scopeId === args.agentId ? 'agent' : appId && scopeId === appId ? 'app' : 'workflow'}`,
        ...(appId ? [`app:${appId}`] : []),
        ...(workflowId ? [`workflow:${workflowId}`] : []),
      ],
      metadata: {
        appId,
        workflowId,
        conversationId: args.conversationId,
        toolCalls: experience.toolCalls,
        blockerCounts: lesson.blockerCounts,
        operationSequence: lesson.operationSequence,
        remainingBlockers: lesson.remainingBlockers,
        finishReason: args.finishReason ?? null,
        efficiency: experience.efficiency,
      },
      // Recall feedback is a turn-level event. Carry it on the agent-scoped
      // payload only so app/workflow copies of the same lesson cannot reinforce
      // the recalled atoms two or three times.
      recalledAtomIds: lesson.outcomeStatus === 'good' && scopeId === args.agentId
        ? experience.recalledAtomIds
        : [],
    }));
  }

  #writeAgentCorrection(args: CaptureChatTurnArgs, signal: OperatorMemorySignal): string | null {
    const memory = this.deps.memory;
    if (!memory) return null;
    const existing = memory.list({ workspaceId: args.workspaceId, scopeId: args.agentId, limit: 200 })
      .find((row) => row.tags.includes('operator_correction') && memoriesOverlap(row.content, signal.content));
    if (existing) return existing.id;
    const appliesTo = [args.activeWorkflowId, args.activeNodeId].filter((v): v is string => Boolean(v));
    return memory.write({
      workspaceId: args.workspaceId,
      scopeId: args.agentId,
      kind: 'rule',
      source: 'operator',
      title: signal.title,
      content: signal.content,
      trust: 0.98,
      importance: 0.98,
      appliesTo,
      tags: ['chat', 'operator_correction', 'immediate', 'pacer:procedural', ...(appliesTo.length > 0 ? ['scope:workflow'] : [])],
      provenance: {
        source: 'chat_memory_capture',
        conversationId: args.conversationId,
        agentId: args.agentId,
        userId: args.userId,
        userDisplayName: displayName(args),
        originSurface: 'operator_chat',
        captureMode: 'immediate_governing_correction',
      },
    });
  }

  #workspaceMemoryExists(workspaceId: string, scopeId: string | null, content: string): boolean {
    // §B4 — read through the unified MemoryStore facade (one substrate).
    const memory = this.deps.memory;
    if (!memory) return false;
    const key = normalizeKey(content);
    const rows = memory.list({ workspaceId, scopeId, limit: 200 });
    return rows.some((row) => normalizeKey(row.content) === key || normalizeKey(row.title) === key);
  }

}

/**
 * §B6.1 — is this turn from someone other than the workspace operator?
 *
 * Defaults to trusted when unset: the web-chat surface is authenticated as the
 * operator by construction, and every existing caller predates this field. Only
 * surfaces that can carry a stranger (channel adapters) pass `senderTrust`.
 */
function isExternalSender(args: { senderTrust?: SenderTrust }): boolean {
  return args.senderTrust === 'external';
}

function extractImmediateAgentCorrection(message: string, actorLabel: string): OperatorMemorySignal | null {
  const text = cleanSignal(message);
  if (!text || looksSensitive(text) || isQuestion(text)) return null;
  const binding = /\b(do not|don'?t|never|must not|stop|keep|preserve|leave|não|nao|nunca|pare|mantenha|preserve|deixe)\b/i.test(text);
  const correction = /\b(again|one more time|next time|correction|you (?:changed|removed|deleted|replaced|overwrote|broke)|simply (?:changed|removed|deleted)|from now on|going forward|a partir de agora|de agora em diante|está errado|esta errado|entendeu errado|não confunda|nao confunda|você confundiu|voce confundiu|corrija)\b/i.test(text);
  if (!binding || !correction) return null;
  return {
    kind: 'rule',
    title: `${actorLabel} correction: ${truncate(text, 80)}`,
    content: text.slice(0, 500),
    confidence: 0.98,
    importance: 0.98,
    tags: ['chat', 'operator_correction', 'rule'],
  };
}

function memoriesOverlap(left: string, right: string): boolean {
  const leftTokens = new Set(normalizeKey(left).split(' ').filter((token) => token.length > 2));
  const rightTokens = new Set(normalizeKey(right).split(' ').filter((token) => token.length > 2));
  if (leftTokens.size === 0 || rightTokens.size === 0) return false;
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  return shared / Math.min(leftTokens.size, rightTokens.size) >= 0.72;
}

function extractOperatorSignals(message: string, actorLabel: string): OperatorMemorySignal[] {
  const signals: OperatorMemorySignal[] = [];
  const parts = splitStableSignalCandidates(message);
  for (const raw of parts) {
    const text = cleanSignal(raw);
    if (!text || looksSensitive(text) || isQuestion(text)) continue;

    const kind = classifySignal(text);
    if (!kind) continue;
    // §B7.1/§B7.3 — narrow-write principle: a one-shot task command ("create a
    // workflow that watches AI posts", "remember to email the report") is
    // orchestrator work to be DONE, not durable memory to be remembered. Drop it
    // so it never pollutes the workspace brain as a standing rule. A standing
    // policy ("always create a backup before deploy") carries modality and is
    // kept.
    if (looksLikeTaskCommand(text)) continue;

    signals.push({
      kind,
      title: titleForSignal(kind, text, actorLabel),
      content: text.slice(0, 500),
      confidence: kind === 'rule' ? 0.86 : kind === 'preference' ? 0.8 : 0.74,
      importance: kind === 'rule' ? 0.82 : kind === 'preference' ? 0.72 : 0.64,
      tags: ['chat', 'operator_signal', kind],
    });
  }

  const seen = new Set<string>();
  const unique: OperatorMemorySignal[] = [];
  for (const signal of signals) {
    const key = `${signal.kind}:${normalizeKey(signal.content)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(signal);
  }
  return unique.slice(0, 5);
}

function splitStableSignalCandidates(message: string): string[] {
  return message
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 8 && part.length <= 700);
}

/**
 * BRAIN-BLUEPRINT-10X — does the AGENT's answer carry a durable learning?
 * Deterministic and conservative: the text must be substantive (≥120 chars — a
 * real work summary, not chatter) AND contain an explicit learning shape. The
 * FormationJudge downstream still reconciles/dedupes/rejects, so this gate only
 * decides whether the turn is WORTH judging — false negatives lose a lesson,
 * false positives cost one queue item.
 */
export function extractAgentLearningSignal(assistantText: string): boolean {
  const text = (assistantText ?? '').trim();
  if (text.length < 120) return false;
  // English learning shapes + their PT/ES equivalents (§B5.13 — the product's
  // real operator base). Still a cheap deterministic pre-gate: the Formation
  // Judge downstream is the actual quality bar, so a false positive costs one
  // queue item while a false negative loses the lesson entirely.
  return /\b(root cause|the (real|actual) (problem|issue|cause) (was|is)|the fix (was|is)|turns out|discovered that|learned that|lesson[:\s]|note for (the )?future|for future runs|next time (we|i) should|going forward (we|i) (should|will|must))\b/i.test(text)
    || /(causa raiz|causa real|o problema (real|verdadeiro) (era|é)|a correção foi|descobri que|aprendi que|lição[:\s]|para (as )?próximas (vezes|execuções)|da próxima vez|daqui pra frente)/i.test(text)
    || /(la causa raíz|el problema (real|verdadero) (era|es)|la solución fue|descubrí que|aprendí que|lección[:\s]|para la próxima|de ahora en adelante)/i.test(text);
}

/**
 * §B7.1 — distinguish a transient TASK COMMAND from a durable STANDING POLICY.
 * An imperative verb targeting a deliverable ("create a workflow", "send the
 * report", "remember to scrape X") is work the orchestrator performs now, not
 * knowledge the brain should remember. It is a command EVEN when phrased
 * "remember to …". A command that also carries standing modality
 * ("always create a backup before deploy") is a recurring rule and is kept.
 */
export function looksLikeTaskCommand(text: string): boolean {
  const t = text.trim().toLowerCase()
    .replace(/^(please|kindly|can you|could you|would you|now|go ahead and|i need you to|i want you to|remember to|remind me to|don'?t forget to)\s+/i, '');
  const TASK_VERB = /^(create|build|make|set ?up|add|generate|watch|monitor|schedule|draft|write|design|deploy|run|fetch|scrape|email|send|post|publish|find|search|look up|check|update|delete|remove|configure|connect|integrate|summari[sz]e|analy[sz]e|review|compile|export|import|download|upload|set)\b/;
  if (!TASK_VERB.test(t)) return false;
  const STANDING = /\b(always|never|every time|whenever|each time|by default|going forward|from now on|any time)\b/;
  return !STANDING.test(t);
}

function classifySignal(text: string): CapturedMemoryKind | null {
  const lower = text.toLowerCase();
  if (/\b(correction|actually|not what i meant|instead of|next time)\b/.test(lower)) return 'lesson';
  if (/\b(always|never|must|do not|don't|dont|from now on|going forward|remember to|make sure to)\b/.test(lower)) return 'rule';
  if (/\b(i|we)\s+(prefer|like|dislike|hate|usually|tend to)\b/.test(lower)) return 'preference';
  if (/\b(my|our)\s+(preference|preferred default)\b/.test(lower)) return 'preference';
  if (/\b(i am|i'm|my role is|my title is|our company|my company|i work as|founder of)\b/.test(lower)) return 'fact';
  if (/^remember\b/i.test(text)) return 'rule';
  return null;
}

function cleanSignal(text: string): string {
  return text
    .replace(/^[-*>\d.)\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleForSignal(kind: CapturedMemoryKind, content: string, actorLabel: string): string {
  const prefix: Record<CapturedMemoryKind, string> = {
    fact: `${actorLabel} fact`,
    preference: `${actorLabel} preference`,
    rule: `${actorLabel} rule`,
    lesson: `${actorLabel} correction`,
  };
  return `${prefix[kind]}: ${truncate(content, 80)}`;
}

function buildSessionMomentContent(args: CaptureChatTurnArgs, signals: OperatorMemorySignal[]): string | null {
  const operator = args.userMessage.trim().replace(/\s+/g, ' ');
  const assistant = (args.assistantMessage ?? '').trim().replace(/\s+/g, ' ');
  const actorLabel = displayName(args);
  if (!operator) return null;
  if (signals.length === 0 && operator.length < 24 && assistant.length < 40) return null;

  const signalText = signals.length > 0
    ? `Memory signals: ${signals.map((signal) => `${signal.kind}: ${signal.content}`).join(' | ')}`
    : null;
  const parts = [
    signalText,
    `${actorLabel}: ${truncate(operator, 360)}`,
    assistant ? `Assistant: ${truncate(assistant, 360)}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join('\n');
}

function displayName(args: CaptureChatTurnArgs): string {
  const trimmed = args.userDisplayName?.trim();
  return trimmed || 'Operator';
}

interface TurnExperienceLesson {
  title: string;
  content: string;
  type: TurnExperiencePayload['type'];
  outcomeStatus: TurnExperiencePayload['outcomeStatus'];
  blockerCounts: number[];
  operationSequence: string[];
  remainingBlockers: string[];
}

function composeTurnExperienceLesson(
  args: CaptureChatTurnArgs,
  observations: TurnToolObservation[],
  appId: string | null,
  workflowId: string | null,
): TurnExperienceLesson | null {
  const mutations = observations.filter((entry) => entry.mutating && entry.ok);
  const failures = observations.filter((entry) => !entry.ok);
  const proofs = observations.filter((entry) => /(?:verify|compile|test|dry_run|lint|doctor|inspect)/i.test(entry.name));
  const blockerCounts = observations.flatMap((entry) => blockerCountsIn(entry.result));
  const firstBlockers = blockerCounts[0];
  const finalBlockers = blockerCounts.at(-1);
  const recoveredTool = observations.some((entry, index) =>
    !entry.ok && observations.slice(index + 1).some((later) => later.name === entry.name && later.ok),
  );
  const improved = firstBlockers !== undefined && finalBlockers !== undefined && finalBlockers < firstBlockers;
  const verifiedClean = finalBlockers === 0 || proofs.some((entry) => resultLooksGreen(entry.result));

  // Reading around without changing, proving, failing, or moving a frontier is
  // ordinary working context—not a durable lesson.
  if (mutations.length === 0 && failures.length === 0 && !improved && !verifiedClean && !recoveredTool) return null;

  const operationSequence = observations.map((entry) => `${entry.name}${entry.repeats > 1 ? `×${entry.repeats}` : ''}`);
  const remainingBlockers = finalBlockers && finalBlockers > 0
    ? blockerLabelsIn(observations.at(-1)?.result).slice(0, 8)
    : [];
  const resource = appId ? `App ${appId}` : workflowId ? `Workflow ${workflowId}` : `Agent ${args.agentId}`;
  const objective = compactSentence(args.userMessage, 220);
  const successfulMutations = unique(mutations.map((entry) => entry.name));
  const proofCalls = unique(proofs.filter((entry) => entry.ok).map((entry) => entry.name));
  const failedCalls = unique(failures.map((entry) => entry.name));

  let type: TurnExperiencePayload['type'] = 'decision';
  let outcomeStatus: TurnExperiencePayload['outcomeStatus'] = 'mixed';
  let title = `Worked frontier: ${resource}`;
  let guidance = 'Continue from the latest verified frontier and preserve already-proven behavior.';
  if (verifiedClean && (mutations.length > 0 || recoveredTool)) {
    type = 'success_pattern';
    outcomeStatus = 'good';
    title = `Verified successful procedure: ${resource}`;
    guidance = 'Reuse this verified operation/proof sequence as the baseline; change only the failing frontier when the context remains compatible.';
  } else if (improved || recoveredTool) {
    type = 'recovery';
    outcomeStatus = finalBlockers === 0 ? 'good' : 'mixed';
    title = firstBlockers !== undefined && finalBlockers !== undefined
      ? `Recovered ${resource}: ${firstBlockers} → ${finalBlockers} blockers`
      : `Recovered a failed operation: ${resource}`;
    guidance = 'Resume at the remaining frontier; do not restart upstream work whose proof remains current.';
  } else if (failures.length > 0 || (finalBlockers ?? 0) > 0) {
    type = 'failure';
    outcomeStatus = 'bad';
    title = `Unresolved frontier: ${resource}`;
    guidance = 'Do not report this resource as fixed. Start from the recorded remaining frontier and verify after the next repair batch.';
  }

  const frontier = firstBlockers !== undefined && finalBlockers !== undefined
    ? `Compiler blockers moved ${firstBlockers} → ${finalBlockers}.`
    : finalBlockers !== undefined ? `Latest compiler count: ${finalBlockers} blockers.` : '';
  const content = [
    `Grounded experience for ${resource}. Objective: ${objective}`,
    frontier,
    `Observed operation sequence: ${operationSequence.join(' → ')}.`,
    successfulMutations.length ? `Successful state changes: ${successfulMutations.join(', ')}.` : '',
    proofCalls.length ? `Proof operations completed: ${proofCalls.join(', ')}.` : '',
    failedCalls.length ? `Failed operations encountered: ${failedCalls.join(', ')}.` : '',
    remainingBlockers.length ? `Remaining blocker frontier: ${remainingBlockers.join(', ')}.` : '',
    guidance,
  ].filter(Boolean).join(' ');

  return {
    title: compactSentence(title, 100),
    content: compactSentence(content, 1_400),
    type,
    outcomeStatus,
    blockerCounts,
    operationSequence,
    remainingBlockers,
  };
}

function firstResourceId(observations: TurnToolObservation[], key: 'appId' | 'workflowId'): string | null {
  for (const observation of observations) {
    const found = findStringKey(observation.args, key);
    if (found) return found;
  }
  return null;
}

function findStringKey(value: unknown, key: string, depth = 0): string | null {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  if (!Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    if (typeof row[key] === 'string' && row[key].trim()) return row[key].trim();
    for (const child of Object.values(row)) {
      const found = findStringKey(child, key, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const child of value) {
    const found = findStringKey(child, key, depth + 1);
    if (found) return found;
  }
  return null;
}

function blockerCountsIn(value: unknown, depth = 0): number[] {
  if (!value || typeof value !== 'object' || depth > 5) return [];
  if (Array.isArray(value)) return value.flatMap((entry) => blockerCountsIn(entry, depth + 1));
  const row = value as Record<string, unknown>;
  const counts = row.counts && typeof row.counts === 'object' && !Array.isArray(row.counts)
    ? row.counts as Record<string, unknown>
    : null;
  const own = typeof counts?.block === 'number' ? [counts.block] : [];
  return [...own, ...Object.values(row).flatMap((entry) => blockerCountsIn(entry, depth + 1))];
}

function blockerLabelsIn(value: unknown, depth = 0): string[] {
  if (!value || typeof value !== 'object' || depth > 5) return [];
  if (Array.isArray(value)) return unique(value.flatMap((entry) => blockerLabelsIn(entry, depth + 1)));
  const row = value as Record<string, unknown>;
  const own = row.status === 'block'
    ? [String(row.code ?? row.id ?? row.summary ?? 'blocking check')]
    : [];
  return unique([...own, ...Object.values(row).flatMap((entry) => blockerLabelsIn(entry, depth + 1))]);
}

function resultLooksGreen(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 4) return false;
  if (Array.isArray(value)) return value.some((entry) => resultLooksGreen(entry, depth + 1));
  const row = value as Record<string, unknown>;
  if (row.readyForExecution === true || row.operable === true || row.passed === true) return true;
  if (row.ok === true && !('error' in row)) return true;
  return Object.values(row).some((entry) => resultLooksGreen(entry, depth + 1));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function compactSentence(value: string, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * A question is not a stated preference/rule/fact, even when it contains
 * trigger words ("how do I like responses?" embeds "I like"). We treat a
 * candidate as a question when it ends with `?` or opens with an
 * interrogative — but never when it opens with an imperative ("do not …",
 * "don't …"), which is a rule, not a question.
 */
function isQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (/\?\s*$/.test(trimmed)) return true;
  if (/^(do not|don'?t)\b/i.test(trimmed)) return false;
  return /^(how|what|why|when|where|who|which|whose|whom|do|does|did|is|are|was|were|can|could|would|should|will|shall|may|might|am)\b/i.test(trimmed);
}

function normalizeKey(value: string): string {
  // §B5.4 — shared Unicode segmentation. The previous ASCII strip collapsed
  // every non-Latin statement to the empty string, so two unrelated Russian or
  // CJK memories compared equal and the second was discarded as a duplicate.
  return segment(value).join(' ');
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trim()}...`;
}
