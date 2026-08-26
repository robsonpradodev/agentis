/**
 * Global process semaphore — AdapterManager bounds concurrent task dispatches
 * across all runs/swarms, releasing each slot on the task's terminal event.
 */
import { describe, it, expect } from 'vitest';
import type {
  AgentAdapter,
  AdapterCapabilities,
  AdapterHealthStatus,
  NormalizedAgentEvent,
  NormalizedTask,
} from '@agentis/core';
import { Semaphore } from '../../src/adapters/semaphore.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { createLogger } from '../../src/logger.js';

const logger = createLogger({ level: 'error' });
const flush = () => new Promise((r) => setTimeout(r, 0));

function task(id: string): NormalizedTask {
  return {
    taskId: id,
    runId: 'r1',
    workflowId: 'w1',
    nodeId: id,
    title: id,
    description: 'x',
    inputData: {},
    scratchpadSnapshot: {},
    capabilityTags: [],
    timeoutMs: 60_000,
  };
}

/** Records dispatched task ids; never auto-completes; can emit terminal events on demand. */
class MockAdapter implements AgentAdapter {
  readonly adapterType = 'http' as const;
  readonly dispatched: string[] = [];
  readonly cancelled: string[] = [];
  #handler: ((e: NormalizedAgentEvent) => void) | null = null;
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck(): Promise<AdapterHealthStatus> {
    return { isHealthy: true, checkedAt: new Date().toISOString() };
  }
  capabilities(): AdapterCapabilities {
    return { interactiveChat: false, toolCalling: false, toolForwarding: 'none' };
  }
  async dispatchTask(t: NormalizedTask): Promise<void> {
    this.dispatched.push(t.taskId);
  }
  async cancelTask(taskId: string): Promise<void> { this.cancelled.push(taskId); }
  onEvent(handler: (e: NormalizedAgentEvent) => void): void {
    this.#handler = handler;
  }
  complete(taskId: string): void {
    this.#handler?.({
      eventType: 'task.completed',
      agentId: 'a',
      taskId,
      runId: 'r1',
      workflowId: 'w1',
      output: {},
      timestamp: new Date().toISOString(),
    });
  }
}

describe('Semaphore', () => {
  it('admits up to max immediately and queues the rest', async () => {
    const s = new Semaphore(2);
    await s.acquire();
    await s.acquire();
    expect(s.active).toBe(2);
    let third = false;
    const p = s.acquire().then(() => { third = true; });
    await flush();
    expect(third).toBe(false); // queued
    expect(s.waiting).toBe(1);
    s.release(); // hands the slot to the waiter
    await p;
    expect(third).toBe(true);
    expect(s.active).toBe(2);
  });

  it('drops active when nobody is waiting', () => {
    const s = new Semaphore(1);
    void s.acquire();
    expect(s.active).toBe(1);
    s.release();
    expect(s.active).toBe(0);
  });

  it('treats max < 1 as 1', () => {
    expect(new Semaphore(0).max).toBe(1);
  });
});

describe('AdapterManager — global process semaphore', () => {
  it('caps concurrent dispatches and resumes a queued one when a slot frees', async () => {
    const am = new AdapterManager(logger, undefined, 2);
    const adapter = new MockAdapter();
    am.register('agent', adapter);

    const p1 = am.dispatchTask(task('t1'), 'agent');
    const p2 = am.dispatchTask(task('t2'), 'agent');
    const p3 = am.dispatchTask(task('t3'), 'agent');
    await Promise.all([p1, p2]);
    await flush();

    // Only two reach the adapter; the third is parked on the semaphore.
    expect(adapter.dispatched).toEqual(['t1', 't2']);
    expect(am.processConcurrency.active).toBe(2);
    expect(am.processConcurrency.waiting).toBe(1);

    // A terminal event for t1 frees its slot → t3 proceeds.
    adapter.complete('t1');
    await p3;
    await flush();
    expect(adapter.dispatched).toEqual(['t1', 't2', 't3']);
    expect(am.processConcurrency.active).toBe(2); // t2 + t3 still in flight
  });

  it('releases the slot immediately when dispatch throws', async () => {
    const am = new AdapterManager(logger, undefined, 1);
    const throwing: AgentAdapter = {
      adapterType: 'http',
      connect: async () => {},
      disconnect: async () => {},
      healthCheck: async () => ({ isHealthy: true, checkedAt: '' }),
      dispatchTask: async () => { throw new Error('boom'); },
      cancelTask: async () => {},
      onEvent: () => {},
    };
    am.register('agent', throwing);
    await expect(am.dispatchTask(task('t1'), 'agent')).rejects.toThrow('boom');
    // Slot was reclaimed so the next dispatch isn't blocked forever.
    expect(am.processConcurrency.active).toBe(0);
  });

  it('releases the slot immediately when a task is cancelled without a terminal adapter event', async () => {
    const am = new AdapterManager(logger, undefined, 1);
    const adapter = new MockAdapter();
    am.register('agent', adapter);

    await am.dispatchTask(task('t1'), 'agent');
    const queued = am.dispatchTask(task('t2'), 'agent');
    await flush();
    expect(adapter.dispatched).toEqual(['t1']);

    await am.cancelTask('agent', 't1');
    await queued;
    expect(adapter.cancelled).toEqual(['t1']);
    expect(adapter.dispatched).toEqual(['t1', 't2']);
  });
});
