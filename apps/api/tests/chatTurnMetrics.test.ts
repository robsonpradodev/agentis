/**
 * Per-turn CLB stage metrics (NATIVE-ADVANCEMENT Phase A instrumentation).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { recordTurn, getTurnMetrics, resetToolMetrics, type TurnSample } from '../src/services/chat/chatMetrics.js';

function sample(overrides: Partial<TurnSample> = {}): TurnSample {
  return {
    totalMs: 1000,
    contextMs: 200,
    firstTokenMs: 400,
    modelMs: 700,
    toolMs: 100,
    toolCalls: 1,
    rounds: 1,
    finishReason: 'stop',
    fastPath: false,
    adapterType: 'hermes',
    ...overrides,
  };
}

describe('turn metrics', () => {
  beforeEach(() => resetToolMetrics());

  it('returns an empty summary before any turns', () => {
    const m = getTurnMetrics();
    expect(m.turns).toBe(0);
    expect(m.total.avgMs).toBe(0);
    expect(m.fastPathRate).toBe(0);
  });

  it('aggregates total / context / first-token / model / tool stages', () => {
    recordTurn(sample({ totalMs: 1000, contextMs: 200, firstTokenMs: 400, modelMs: 700, toolMs: 100 }));
    recordTurn(sample({ totalMs: 3000, contextMs: 400, firstTokenMs: 800, modelMs: 2400, toolMs: 600 }));
    const m = getTurnMetrics();
    expect(m.turns).toBe(2);
    expect(m.total.avgMs).toBe(2000);
    expect(m.context.avgMs).toBe(300);
    expect(m.firstToken.avgMs).toBe(600);
    expect(m.model.avgMs).toBe(1550);
    expect(m.tools.avgMs).toBe(350);
  });

  it('ignores null context/first-token samples (e.g. confirmation resume)', () => {
    recordTurn(sample({ contextMs: null, firstTokenMs: null }));
    recordTurn(sample({ contextMs: 300, firstTokenMs: 500 }));
    const m = getTurnMetrics();
    expect(m.context.samples).toBe(1);
    expect(m.context.avgMs).toBe(300);
    expect(m.firstToken.samples).toBe(1);
    // total is always present
    expect(m.total.samples).toBe(2);
  });

  it('tracks fast-path rate and finish-reason breakdown', () => {
    recordTurn(sample({ fastPath: true, finishReason: 'stop' }));
    recordTurn(sample({ fastPath: false, finishReason: 'tool_calls' }));
    recordTurn(sample({ fastPath: true, finishReason: 'stop' }));
    const m = getTurnMetrics();
    expect(m.fastPathRate).toBeCloseTo(2 / 3, 5);
    expect(m.byFinishReason).toEqual({ stop: 2, tool_calls: 1 });
  });

  it('surfaces prompt volume and compaction frequency', () => {
    recordTurn(sample({ promptInputTokens: 2_400, promptCompactions: 1 }));
    recordTurn(sample({ promptInputTokens: 1_200, promptCompactions: 0 }));
    const m = getTurnMetrics();
    expect(m.promptInputTokens.avg).toBe(1_800);
    expect(m.promptCompactions).toBe(1);
  });

  it('resets with resetToolMetrics', () => {
    recordTurn(sample());
    resetToolMetrics();
    expect(getTurnMetrics().turns).toBe(0);
  });
});
