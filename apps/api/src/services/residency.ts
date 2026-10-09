/**
 * Residency — an agent that wakes on its own clock (Agent-Native Platform Plan §3.1).
 *
 * Pure helpers only; the wake is driven by the EXISTING CommandHeartbeat sweep
 * (no new scheduler — Part 7 "no ninth subsystem"). Residency is opt-in per agent
 * via `agents.config.residency`, so a plain worker/specialist — the kind the
 * manager-only heartbeat could never wake — becomes a persistent agent that
 * discovers, follows up, and drains a queue on a cadence, carrying working memory
 * (task/plan/observations blocks of its resident session) from one wake to the next.
 *
 * ORCHESTRATOR-SUSPEND-10X Phase 0 (warm revival) — a resident wake is no longer a
 * cold turn seeded with a two-paragraph summary. It carries the agent's standing
 * GOAL (task block) plus its recent conversation reconstructed from the resident
 * session, so the same agent resumes where it left off instead of waking amnesiac.
 */

import type { ChatMessage } from '@agentis/core';

export interface ResidencyConfig {
  enabled: boolean;
  /** How often to wake, in minutes. Floored to 1 (a 60s sweep is the finest cadence). */
  intervalMinutes: number;
  /** The standing instruction handed to the agent on each wake. */
  wake: string;
  /** Activated durable standing goals; the driver resolves their current versions on every wake. */
  activeGoalIds: string[];
}

const DEFAULT_INTERVAL_MINUTES = 15;
const MIN_INTERVAL_MINUTES = 1;
const DEFAULT_WAKE =
  'Standing wake: review your queue and standing objective, do the next useful thing through your tools, '
  + 'then call agentis.residency.remember to record where you left off. If nothing needs doing, remember that and stop.';

/** Parse an agent's residency config from its freeform `config` JSON. Returns null when off. */
export function readResidency(config: unknown): ResidencyConfig | null {
  if (!config || typeof config !== 'object') return null;
  const r = (config as Record<string, unknown>).residency;
  if (!r || typeof r !== 'object') return null;
  const obj = r as Record<string, unknown>;
  if (obj.enabled !== true) return null;
  const rawInterval = typeof obj.intervalMinutes === 'number' && Number.isFinite(obj.intervalMinutes)
    ? obj.intervalMinutes
    : DEFAULT_INTERVAL_MINUTES;
  return {
    enabled: true,
    intervalMinutes: Math.max(MIN_INTERVAL_MINUTES, Math.floor(rawInterval)),
    wake: typeof obj.wake === 'string' && obj.wake.trim() ? obj.wake.trim() : DEFAULT_WAKE,
    activeGoalIds: Array.isArray(obj.activeGoalIds) ? obj.activeGoalIds.filter((id): id is string => typeof id === 'string') : [],
  };
}

/** Has enough time elapsed since the last wake to wake again? Never-woken ⇒ due now. */
export function residencyDue(lastWokeAtIso: string | null, cfg: ResidencyConfig, nowMs: number): boolean {
  if (!lastWokeAtIso) return true;
  const last = Date.parse(lastWokeAtIso);
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= cfg.intervalMinutes * 60_000;
}

/** Compose the wake turn: the standing instruction + the working state carried from the prior wake. */
export function buildResidencyWake(cfg: ResidencyConfig, carried: { task?: string; plan?: string; observations?: string }, goals: Array<{ id: string; objective: string }> = []): string {
  const parts = [`[Scheduled residency wake] ${cfg.wake}`];
  if (goals.length) parts.push(`Your active standing goals:\n${goals.map((goal) => `- [${goal.id}] ${goal.objective}`).join('\n')}`);
  const task = carried.task?.trim();
  const plan = carried.plan?.trim();
  const obs = carried.observations?.trim();
  // The GOAL leads — a warm wake means resuming toward the standing objective the
  // agent already holds, not re-deriving it from a summary.
  if (task) parts.push(`Your standing objective: ${task}`);
  if (plan) parts.push(`Your current plan: ${plan}`);
  if (obs) parts.push(`Where you left off last time: ${obs}`);
  return parts.join('\n');
}

/**
 * Reconstruct the conversation history for a warm resident wake from the resident
 * session's recent episodic messages. Keeps only clean user/assistant text turns
 * (tool-call/tool-result pairs are dropped so a partial slice never leaves a
 * dangling tool call the chat adapter would reject), so the woken agent resumes
 * with its actual prior exchange as context instead of an empty slate.
 */
export function buildResidentWakeHistory(messages: Array<{ role: string; content: string }>): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const content = m.content?.trim();
    if (!content) continue;
    out.push({ role: m.role, content });
  }
  return out;
}
