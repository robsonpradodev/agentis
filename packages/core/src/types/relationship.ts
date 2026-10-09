import { z } from 'zod';

/** Authority is attached to a verified channel principal, never inferred from a reply address. */
export const channelAuthorityRoleSchema = z.enum(['external', 'owner', 'delegate']);
export type ChannelAuthorityRole = z.infer<typeof channelAuthorityRoleSchema>;

export interface PrincipalContext {
  identityId: string | null;
  connectionId: string;
  channelKind: string;
  handle: string;
  peerKey: string;
  groundingEntityId: string | null;
  role: ChannelAuthorityRole;
  verified: boolean;
  authorityMethod: string | null;
  grantExpiresAt: string | null;
  displayName: string | null;
}

export interface RelationshipFact {
  key: string;
  value: unknown;
  confidence: number;
  source: 'contact' | 'operator' | 'agent' | 'system' | 'import';
  observedAt: string;
  lastConfirmedAt: string;
  expiresAt?: string | null;
  archivedAt?: string | null;
}

export interface RelationshipCommitment {
  id: string;
  text: string;
  owner: 'agent' | 'contact' | 'operator';
  status: 'open' | 'done' | 'cancelled' | 'expired';
  dueAt?: string | null;
  createdAt: string;
  resolvedAt?: string | null;
}

/** Compact, durable explanation of what the relationship runtime decided at a wake. */
export interface RelationshipDecision {
  id: string;
  evaluatedAt: string;
  trigger: 'inbound' | 'scheduled_action';
  outcome: 'no_action' | 'cancelled' | 'performed' | 'held' | 'blocked';
  reason: string;
  actionId?: string | null;
  relatedEventIds?: string[];
  receiptId?: string | null;
}

export interface RelationshipNextAction {
  kind: 'reply' | 'follow_up' | 'wait' | 'escalate' | 'close' | 'custom';
  goal: string;
  dueAt?: string | null;
  preconditions?: string[];
  stopConditions?: string[];
  status: 'planned' | 'ready' | 'blocked' | 'done' | 'cancelled';
  attempts?: number;
  lastAttemptAt?: string | null;
  /**
   * How many times this action may fire before it gives up. A follow-up without
   * a ceiling is how an agent turns into a nuisance: the same person gets nudged
   * on every cadence forever because nothing counts the attempts. Absent ⇒ 1.
   */
  maxAttempts?: number | null;
  /**
   * Spacing to the NEXT attempt once one is performed. Absent ⇒ the action is
   * one-shot and settles after its first attempt.
   */
  cadenceMs?: number | null;
  /**
   * Withdraw this action the moment the person writes back. Defaults to true for
   * `follow_up`: a nudge that lands after the reply it was waiting for reads as a
   * bot that was not listening.
   */
  cancelOnReply?: boolean;
  /** When the action was armed — distinct from `dueAt`, for cadence and audit. */
  armedAt?: string | null;
  /** What armed it (a standing goal id, a mission id, an operator). Free-form, for audit and cohort de-dup. */
  sourceRef?: string | null;
}

export interface EngagementState {
  id: string;
  kind: string;
  goal: string;
  stage: string;
  status: 'active' | 'won' | 'lost' | 'paused' | 'closed';
  openedAt: string;
  updatedAt: string;
  outcome?: string | null;
}

/** Compact durable working state for one person/account/case. The transcript stays outside this block. */
export interface RelationshipState {
  version: 2;
  subjectKey: string;
  identity: {
    displayName?: string | null;
    peerKey?: string | null;
    handles: Array<{ connectionId: string; channelKind: string; handle: string }>;
  };
  facts: RelationshipFact[];
  engagements: EngagementState[];
  commitments: RelationshipCommitment[];
  openQuestions: string[];
  blockers: string[];
  nextAction: RelationshipNextAction | null;
  memoryRefs: string[];
  /** Append-only bounded decision trace; absent in older Subject rows. */
  decisionHistory?: RelationshipDecision[];
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
  updatedAt: string;
}

export const autonomyModeSchema = z.enum(['reply_only', 'policy', 'broad']);
export type AutonomyMode = z.infer<typeof autonomyModeSchema>;
export const autonomyDecisionSchema = z.enum(['allow', 'require_approval', 'deny']);
export type AutonomyDecision = z.infer<typeof autonomyDecisionSchema>;
export const autonomyActionCategorySchema = z.enum([
  'inbound_reply',
  'proactive_followup',
  'external_read',
  'external_mutation',
  'financial_contractual',
  'destructive',
  'cross_recipient',
  'escalation',
]);
export type AutonomyActionCategory = z.infer<typeof autonomyActionCategorySchema>;

export const relationshipAutonomyPolicySchema = z.object({
  mode: autonomyModeSchema.default('policy'),
  actions: z.record(autonomyActionCategorySchema, autonomyDecisionSchema).default({}),
  /** Optional per-Subject override: the operator can widen or narrow one case without changing the App. */
  subjectOverrides: z
    .record(
      z.string(),
      z.object({
        mode: autonomyModeSchema.optional(),
        actions: z.record(autonomyActionCategorySchema, autonomyDecisionSchema).optional(),
      }),
    )
    .default({}),
});
export type RelationshipAutonomyPolicy = z.infer<typeof relationshipAutonomyPolicySchema>;

export interface AgentContinuityContext {
  subjectId: string;
  subjectKey: string;
  engagementId: string | null;
  goal: string | null;
  stage: string | null;
  nextAction: RelationshipNextAction | null;
  commitments: RelationshipCommitment[];
  openQuestions: string[];
  blockers: string[];
  contextVersion: number;
  contextWatermark: string;
}
