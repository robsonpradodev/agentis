/**
 * ChatProgressMonitor — intelligent, time-free stop for the chat agent loop.
 *
 * The chat loop used to stop on a wall-clock deadline and a tiny `maxTurns`
 * bound. That guillotined long, legitimate work (a multi-step build) while doing
 * nothing to catch a model genuinely stuck in a loop — the exact opposite of what
 * we want. This monitor replaces the timer with *progress detection*: the loop
 * runs as long as it keeps making progress and stops the instant it detects a
 * pathology.
 *
 * Why this is safe with no timer: "progress" is defined strictly (a genuinely new
 * action, a new result, or new operator-visible text). A stuck agent cannot
 * manufacture novelty forever, so the no-progress streak is a *complete* backstop
 * — it always eventually fires for any loop the faster detectors miss. A
 * long task that keeps taking distinct, productive steps never trips.
 *
 * Detectors, in priority order:
 *  1. identical_repetition — the same (tool, args) issued in ≥ K rounds.
 *  2. oscillation          — a short cycle of rounds repeating (A,B,A,B…).
 *  3. error_storm          — ≥ E consecutive rounds where every tool errored.
 *  4. no_progress          — ≥ N consecutive rounds with zero progress signal.
 */

/** One tool call reduced to the two fields that define "the same action". */
export interface ToolCallSignature {
  name: string;
  /** Stable hash of the call arguments (see {@link hashValue}). */
  argsHash: string;
}

/** What the loop observed in a single tool round, fed to {@link ChatProgressMonitor.record}. */
export interface RoundObservation {
  /** Tool calls issued this round. Empty for a text-only round (loop terminates anyway). */
  toolCalls: ToolCallSignature[];
  /** Stable hash of each tool result this round (success payload or error string). */
  resultHashes: string[];
  /** True when there was ≥1 tool call and every one of them errored. */
  allToolsErrored: boolean;
  /** True when the model emitted new assistant text to the operator this round. */
  producedText: boolean;
}

export type StopReason =
  | { kind: 'identical_repetition'; detail: string }
  | { kind: 'oscillation'; detail: string }
  | { kind: 'error_storm'; detail: string }
  | { kind: 'no_progress'; detail: string };

/** Read a positive-integer threshold from env, falling back to the default. */
function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export interface ProgressThresholds {
  /** Stop after the same (tool, args) appears in this many rounds. */
  maxIdenticalCalls: number;
  /** Stop after this many consecutive all-errored rounds. */
  maxErrorStreak: number;
  /** Stop after this many consecutive zero-progress rounds. */
  maxNoProgressRounds: number;
  /** Longest cycle period to scan for when detecting oscillation. */
  maxOscillationPeriod: number;
  /** How many times a cycle must repeat to count as oscillation. */
  oscillationRepeats: number;
}

export function defaultThresholds(): ProgressThresholds {
  return {
    maxIdenticalCalls: envInt('AGENTIS_CHAT_MAX_IDENTICAL_CALLS', 3),
    maxErrorStreak: envInt('AGENTIS_CHAT_MAX_ERROR_STREAK', 4),
    maxNoProgressRounds: envInt('AGENTIS_CHAT_MAX_NO_PROGRESS_ROUNDS', 3),
    maxOscillationPeriod: envInt('AGENTIS_CHAT_MAX_OSCILLATION_PERIOD', 3),
    // Seeing the SAME cycle twice (A,B,A,B) is already a strong loop signal, and
    // signatures include args so a legitimate write-different-file→test loop never
    // repeats an identical cycle. Catching it at 2 also beats identical_repetition
    // (which needs the 3rd round) to the punch, so true cycles get the right label.
    oscillationRepeats: envInt('AGENTIS_CHAT_OSCILLATION_REPEATS', 2),
  };
}

/** Stable, order-independent hash of an arbitrary JSON-ish value (djb2 over canonical JSON). */
export function hashValue(value: unknown): string {
  let str: string;
  try {
    str = canonicalJson(value);
  } catch {
    str = String(value);
  }
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** JSON with object keys sorted, so `{a,b}` and `{b,a}` hash identically. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export class ChatProgressMonitor {
  readonly #t: ProgressThresholds;
  /** Every (tool|argsHash) ever issued — novelty = forward progress. */
  readonly #seenCalls = new Set<string>();
  /** Every result hash ever seen — a new result = forward progress. */
  readonly #seenResults = new Set<string>();
  /** Per-round call signature, in order, for oscillation scanning. */
  readonly #roundSigs: string[] = [];
  /** Count of rounds each individual (tool|argsHash) has appeared in. */
  readonly #callRoundCounts = new Map<string, number>();
  #noProgressStreak = 0;
  #errorStreak = 0;

  constructor(thresholds: ProgressThresholds = defaultThresholds()) {
    this.#t = thresholds;
  }

  /**
   * Record one completed tool round. Returns a {@link StopReason} when the loop
   * should stop, or `null` to keep going. Call once per tool round, after the
   * results are known.
   */
  record(obs: RoundObservation): StopReason | null {
    const callKeys = obs.toolCalls.map((c) => `${c.name}|${c.argsHash}`);

    // (1) identical repetition — the same exact call across ≥ K rounds. Count
    // distinct calls once per round so two identical calls in ONE round (a
    // legitimate parallel fan-out) don't inflate the counter.
    for (const key of new Set(callKeys)) {
      const next = (this.#callRoundCounts.get(key) ?? 0) + 1;
      this.#callRoundCounts.set(key, next);
      if (next >= this.#t.maxIdenticalCalls) {
        const [name] = key.split('|');
        return {
          kind: 'identical_repetition',
          detail: `called ${name} ${next} times with identical arguments`,
        };
      }
    }

    // (2) oscillation — a cycle of rounds repeating (e.g. edit↔revert). Record
    // this round's signature first, then scan the tail for a repeating period.
    const roundSig = callKeys.length > 0 ? [...callKeys].sort().join('+') : 'text-only';
    this.#roundSigs.push(roundSig);
    const oscillation = this.#detectOscillation();
    if (oscillation) return oscillation;

    // (3) error storm — consecutive rounds where every tool errored. Any
    // success or operator-visible text breaks the streak.
    if (obs.allToolsErrored && !obs.producedText) {
      this.#errorStreak += 1;
      if (this.#errorStreak >= this.#t.maxErrorStreak) {
        return {
          kind: 'error_storm',
          detail: `${this.#errorStreak} consecutive rounds where every tool call failed`,
        };
      }
    } else {
      this.#errorStreak = 0;
    }

    // (4) no-progress backstop — a round makes progress if it produced new text,
    // a never-before-seen call, or a never-before-seen result. This is the
    // complete guard: a stuck loop cannot stay novel forever.
    const novelCall = callKeys.some((k) => !this.#seenCalls.has(k));
    const novelResult = obs.resultHashes.some((h) => !this.#seenResults.has(h));
    const madeProgress = obs.producedText || novelCall || novelResult;
    for (const k of callKeys) this.#seenCalls.add(k);
    for (const h of obs.resultHashes) this.#seenResults.add(h);

    if (madeProgress) {
      this.#noProgressStreak = 0;
    } else {
      this.#noProgressStreak += 1;
      if (this.#noProgressStreak >= this.#t.maxNoProgressRounds) {
        return {
          kind: 'no_progress',
          detail: `${this.#noProgressStreak} consecutive rounds without new progress`,
        };
      }
    }

    return null;
  }

  /** Scan the tail of round signatures for a period-p cycle repeated R times. */
  #detectOscillation(): StopReason | null {
    const sigs = this.#roundSigs;
    const repeats = this.#t.oscillationRepeats;
    for (let period = 2; period <= this.#t.maxOscillationPeriod; period += 1) {
      const needed = period * repeats;
      if (sigs.length < needed) continue;
      const window = sigs.slice(sigs.length - needed);
      const cycle = window.slice(0, period);
      // Every text-only cycle is ignored — those are caught by no-progress, and a
      // distinct multi-step cycle is the real "edit↔revert" pathology we want.
      if (cycle.every((s) => s === 'text-only')) continue;
      let matches = true;
      for (let i = 0; i < window.length; i += 1) {
        if (window[i] !== cycle[i % period]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        return {
          kind: 'oscillation',
          detail: `repeated the same ${period}-step cycle ${repeats} times without resolving it`,
        };
      }
    }
    return null;
  }
}

/** Operator-facing, honest explanation of why the loop stopped. */
export function stopReasonMessage(reason: StopReason): string {
  switch (reason.kind) {
    case 'identical_repetition':
      return `I stopped because I was repeating myself: ${reason.detail}. The action was not marked complete; the last tool result is the blocker and can be retried safely without duplicating a successful external effect.`;
    case 'oscillation':
      return `I stopped because the tool loop was going in circles: ${reason.detail}. No unverified action was marked complete; inspect the last tool result for the concrete dependency.`;
    case 'error_storm':
      return `Agentis stopped after ${reason.detail}. The action remains incomplete and the final tool error identifies the dependency that must recover.`;
    case 'no_progress':
      return `I stopped because execution was not moving forward after ${reason.detail}. No result was accepted without evidence; the action can resume from its last durable state.`;
  }
}
