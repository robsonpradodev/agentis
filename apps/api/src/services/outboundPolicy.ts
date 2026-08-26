/**
 * OutboundPolicyService — the per-App outbound safety envelope (LIVING-APPS-10X §7 · G7).
 *
 * A resident agent runs unsupervised, 24/7. Without a gate it can over-message a
 * contact, message in the dead of night, or promise something it must not. This
 * service reads the App's `policyJson.outbound` block (extended in @agentis/core)
 * and enforces, for *agent-initiated* outbound:
 *
 *   - a per-App rolling-hour RATE LIMIT (durable, via the `app_outbound_log`
 *     counter table — survives restart, unlike an in-memory window),
 *   - QUIET HOURS (no unsupervised outbound during a local-time window), and
 *   - a CLAIM GUARD: a `blockedClaims` pattern in the body DENIES the send; a
 *     `requireApprovalFor` pattern requires operator approval first.
 *
 * Additive + non-throwing + model-agnostic. An absent policy (or absent field)
 * means today's unrestricted behavior — `evaluate` returns `{ allow:true }`. A
 * read failure fails OPEN (allow) so the gate never silently drops a turn.
 *
 * The operator's manual send is a human action: exempt from rate/quiet/claim
 * limits, but still `record`ed against the counter so the window stays honest.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, gte, lt } from 'drizzle-orm';
import { appPolicySchema, type AppOutboundPolicy, type AutonomyActionCategory, type AutonomyDecision, type AutonomyMode, type RelationshipAutonomyPolicy } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';

export type OutboundSource = 'agent' | 'operator';

export interface OutboundEvaluateInput {
  /** The message text about to be sent. */
  body: string;
  /** Who is sending — 'operator' is a human action, exempt from rate/quiet/claim limits. */
  source: OutboundSource;
  /** Evaluation clock (tests). Defaults to now. */
  now?: Date;
}

export interface OutboundDecision {
  allow: boolean;
  needsApproval: boolean;
  reason?: string;
}

export interface AutonomyPolicyDecision {
  decision: AutonomyDecision;
  mode: AutonomyMode;
  reason: string;
}

const HOUR_MS = 60 * 60 * 1000;

export class OutboundPolicyService {
  constructor(private readonly deps: { db: AgentisSqliteDb; logger?: Logger }) {}

  /**
   * Decide whether an outbound message may go out as-is, must be held for
   * operator approval, or must be denied. Never throws; an unresolvable App or a
   * read error fails open (`allow:true`).
   */
  evaluate(appId: string | null | undefined, input: OutboundEvaluateInput): OutboundDecision {
    if (!appId) return ALLOW;
    // Operator sends are a human action — exempt from the unsupervised envelope.
    if (input.source === 'operator') return ALLOW;
    let policy: AppOutboundPolicy | undefined;
    try {
      policy = this.#policy(appId);
    } catch (err) {
      this.deps.logger?.warn('outbound.policy.read_failed', { appId, err: (err as Error).message });
      return ALLOW; // fail open
    }
    if (!policy) return ALLOW;
    const now = input.now ?? new Date();

    // 1) Claim guard — a hard-blocked claim denies outright (highest priority).
    const blocked = matchPattern(input.body, policy.blockedClaims);
    if (blocked) {
      return { allow: false, needsApproval: false, reason: `blocked claim: "${blocked}"` };
    }

    // 2) Approval guard — a require-approval pattern holds the send for the operator.
    const needsApprovalPattern = matchPattern(input.body, policy.requireApprovalFor);
    if (needsApprovalPattern) {
      return { allow: false, needsApproval: true, reason: `requires approval (matched "${needsApprovalPattern}")` };
    }

    // 3) Quiet hours — no unsupervised outbound during the configured window.
    if (policy.quietHours && inQuietHours(now.getHours(), policy.quietHours)) {
      return {
        allow: false,
        needsApproval: false,
        reason: `quiet hours (${pad(policy.quietHours.start)}:00–${pad(policy.quietHours.end)}:00)`,
      };
    }

    // 4) Rate limit — per-App rolling-hour cap on agent-initiated outbound.
    if (typeof policy.maxPerHour === 'number') {
      const sentLastHour = this.#countSince(appId, new Date(now.getTime() - HOUR_MS).toISOString());
      if (sentLastHour >= policy.maxPerHour) {
        return {
          allow: false,
          needsApproval: false,
          reason: `rate limit (${sentLastHour}/${policy.maxPerHour} per hour)`,
        };
      }
    }

    return { allow: true, needsApproval: false };
  }

  /** Category gate shared by relationship replies, follow-ups and external side effects. */
  evaluateAutonomy(appId: string | null | undefined, category: AutonomyActionCategory, subjectId?: string | null): AutonomyPolicyDecision {
    if (!appId) return { decision: 'allow', mode: 'broad', reason: 'workspace agent without App policy' };
    const policy = this.#fullPolicy(appId)?.autonomy;
    if (!policy) return { decision: 'allow', mode: 'broad', reason: 'no autonomy policy configured' };
    const override = subjectId ? policy.subjectOverrides[subjectId] : undefined;
    const mode = override?.mode ?? policy.mode;
    const explicit = override?.actions?.[category] ?? policy.actions[category];
    const decision = explicit ?? defaultAutonomyDecision(mode, category);
    return { decision, mode, reason: explicit ? `explicit ${category} policy` : `${mode} default for ${category}` };
  }

  /**
   * Record one outbound send against the App's rolling counter. Call AFTER a send
   * actually goes out (agent reply, proactive follow-up, or operator manual send).
   * Non-throwing — a counter failure must never break delivery. Opportunistically
   * prunes rows older than the window so the table stays small.
   */
  record(appId: string | null | undefined, source: OutboundSource = 'agent', now: Date = new Date()): void {
    if (!appId) return;
    try {
      this.deps.db.insert(schema.appOutboundLog).values({
        id: randomUUID(),
        appId,
        source,
        sentAt: now.toISOString(),
      }).run();
      // Prune anything older than the rolling window (best-effort housekeeping).
      this.deps.db
        .delete(schema.appOutboundLog)
        .where(and(eq(schema.appOutboundLog.appId, appId), lt(schema.appOutboundLog.sentAt, new Date(now.getTime() - HOUR_MS).toISOString())))
        .run();
    } catch (err) {
      this.deps.logger?.warn('outbound.policy.record_failed', { appId, err: (err as Error).message });
    }
  }

  /** Count agent-initiated outbound for an App since the given ISO timestamp. */
  #countSince(appId: string, sinceIso: string): number {
    const rows = this.deps.db
      .select({ id: schema.appOutboundLog.id })
      .from(schema.appOutboundLog)
      .where(and(
        eq(schema.appOutboundLog.appId, appId),
        eq(schema.appOutboundLog.source, 'agent'),
        gte(schema.appOutboundLog.sentAt, sinceIso),
      ))
      .all();
    return rows.length;
  }

  /** Resolve the App's outbound policy block, or undefined when none is set. */
  #policy(appId: string): AppOutboundPolicy | undefined {
    return this.#fullPolicy(appId)?.outbound;
  }

  #fullPolicy(appId: string): { outbound?: AppOutboundPolicy; autonomy?: RelationshipAutonomyPolicy } | undefined {
    const row = this.deps.db
      .select({ policyJson: schema.apps.policyJson })
      .from(schema.apps)
      .where(eq(schema.apps.id, appId))
      .get();
    if (!row) return undefined;
    const parsed = appPolicySchema.safeParse(row.policyJson ?? {});
    if (!parsed.success) return undefined;
    return parsed.data;
  }
}

function defaultAutonomyDecision(mode: AutonomyMode, category: AutonomyActionCategory): AutonomyDecision {
  if (category === 'inbound_reply' || category === 'escalation') return 'allow';
  if (mode === 'reply_only') return 'deny';
  if (mode === 'policy') return category === 'external_read' ? 'allow' : 'require_approval';
  if (category === 'financial_contractual' || category === 'destructive' || category === 'cross_recipient') return 'require_approval';
  return 'allow';
}

const ALLOW: OutboundDecision = { allow: true, needsApproval: false };

/** Case-insensitive substring match — returns the first matching pattern, else null. */
function matchPattern(body: string, patterns: string[] | undefined): string | null {
  if (!patterns || patterns.length === 0) return null;
  const haystack = body.toLowerCase();
  for (const p of patterns) {
    const needle = p.trim().toLowerCase();
    if (needle && haystack.includes(needle)) return p;
  }
  return null;
}

/**
 * Is `hour` (0–23) inside the quiet window? `[start, end)` when start <= end;
 * wraps past midnight when start > end (e.g. 22→7 covers 22,23,0..6).
 */
function inQuietHours(hour: number, window: { start: number; end: number }): boolean {
  const { start, end } = window;
  if (start === end) return false; // empty window
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end; // wraps midnight
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
