/**
 * chatMetrics — in-memory tool call metrics for /v1/admin/metrics.
 *
 * Tracks per-tool call counts, error counts, and cumulative duration.
 * No DB writes — ephemeral per-process, reset on restart. This satisfies
 * CHAT-AGENT-LOOP.md §9 "structured logs" requirement with an HTTP surface.
 *
 * Deliberately simple: no reservoir sampling, no ring buffers. Average latency
 * (totalMs / calls) gives the p50 proxy for typical single-model deployments.
 */

interface ToolStat {
  calls: number;
  errors: number;
  totalMs: number;
  /** Rolling last-N latencies for approximate p95 (capped at 200 samples). */
  latencies: number[];
}

const LATENCY_WINDOW = 200;
const stats = new Map<string, ToolStat>();

export function recordToolCall(tool: string, durationMs: number, ok: boolean): void {
  let s = stats.get(tool);
  if (!s) {
    s = { calls: 0, errors: 0, totalMs: 0, latencies: [] };
    stats.set(tool, s);
  }
  s.calls += 1;
  if (!ok) s.errors += 1;
  s.totalMs += durationMs;
  s.latencies.push(durationMs);
  if (s.latencies.length > LATENCY_WINDOW) s.latencies.shift();
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

export interface ToolMetricRow {
  tool: string;
  calls: number;
  errors: number;
  errorRate: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
}

export function getToolMetrics(): ToolMetricRow[] {
  return Array.from(stats.entries())
    .map(([tool, s]) => {
      const sorted = [...s.latencies].sort((a, b) => a - b);
      return {
        tool,
        calls: s.calls,
        errors: s.errors,
        errorRate: s.calls > 0 ? s.errors / s.calls : 0,
        avgMs: s.calls > 0 ? Math.round(s.totalMs / s.calls) : 0,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
      };
    })
    .sort((a, b) => b.calls - a.calls);
}

export function resetToolMetrics(): void {
  stats.clear();
  turnSamples.length = 0;
}

// --- Per-turn stage timing (NATIVE-ADVANCEMENT Phase A / CLB instrumentation) --
//
// The diagnose-first layer: where does a chat turn actually spend its wall-clock?
// Each completed turn contributes one sample with the stage breakdown so an
// operator can SEE whether the cost is context build, the first model token, the
// model stream, or tool execution — before anyone "optimizes" a guess.

export interface TurnSample {
  /** Whole turn, start → terminal. */
  totalMs: number;
  /** Time spent building context before the first model call. null on resume. */
  contextMs: number | null;
  /** Time to the first streamed token/tool-call (perceived latency). */
  firstTokenMs: number | null;
  /** Cumulative wall-clock inside model streaming across all rounds. */
  modelMs: number;
  /** Cumulative wall-clock executing tools across all rounds. */
  toolMs: number;
  toolCalls: number;
  rounds: number;
  finishReason: string;
  /** True when the turn was answered through the orchestrator fast-path. */
  fastPath: boolean;
  adapterType: string;
  /** Sum of the prompt tokens estimated immediately before each model round. */
  promptInputTokens?: number;
  /** Number of rounds where the preflight removed oversized context. */
  promptCompactions?: number;
}

const TURN_WINDOW = 500;
const turnSamples: TurnSample[] = [];

export function recordTurn(sample: TurnSample): void {
  turnSamples.push(sample);
  if (turnSamples.length > TURN_WINDOW) turnSamples.shift();
}

interface StageSummary {
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  /** How many samples had a value (context/firstToken are absent on some turns). */
  samples: number;
}

interface QuantitySummary {
  avg: number;
  p50: number;
  p95: number;
  samples: number;
}

function summarize(values: number[]): StageSummary {
  if (values.length === 0) return { avgMs: 0, p50Ms: 0, p95Ms: 0, samples: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, n) => acc + n, 0);
  return {
    avgMs: Math.round(sum / sorted.length),
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    samples: sorted.length,
  };
}

function summarizeQuantity(values: number[]): QuantitySummary {
  if (values.length === 0) return { avg: 0, p50: 0, p95: 0, samples: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    avg: Math.round(sorted.reduce((total, value) => total + value, 0) / sorted.length),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    samples: sorted.length,
  };
}

export interface TurnMetrics {
  turns: number;
  fastPathRate: number;
  total: StageSummary;
  context: StageSummary;
  firstToken: StageSummary;
  model: StageSummary;
  tools: StageSummary;
  promptInputTokens: QuantitySummary;
  promptCompactions: number;
  byFinishReason: Record<string, number>;
}

export function getTurnMetrics(): TurnMetrics {
  const notNull = (n: number | null): n is number => n !== null;
  const byFinishReason: Record<string, number> = {};
  let fastPathCount = 0;
  for (const s of turnSamples) {
    byFinishReason[s.finishReason] = (byFinishReason[s.finishReason] ?? 0) + 1;
    if (s.fastPath) fastPathCount += 1;
  }
  return {
    turns: turnSamples.length,
    fastPathRate: turnSamples.length > 0 ? fastPathCount / turnSamples.length : 0,
    total: summarize(turnSamples.map((s) => s.totalMs)),
    context: summarize(turnSamples.map((s) => s.contextMs).filter(notNull)),
    firstToken: summarize(turnSamples.map((s) => s.firstTokenMs).filter(notNull)),
    model: summarize(turnSamples.map((s) => s.modelMs)),
    tools: summarize(turnSamples.map((s) => s.toolMs)),
    promptInputTokens: summarizeQuantity(turnSamples.map((s) => s.promptInputTokens ?? 0)),
    promptCompactions: turnSamples.reduce((total, sample) => total + (sample.promptCompactions ?? 0), 0),
    byFinishReason,
  };
}
