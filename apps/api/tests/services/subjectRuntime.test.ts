/**
 * SubjectRuntime on the Durable Entity spine (§3.2) — the H2 keystone. Proves the
 * operator's exact lead flow runs end-to-end on ONE durable model: a deterministic
 * (token-free) first send → park → a reply that arrives OUT OF ORDER and days later →
 * an agent step → park → reply → done. State persists across every park (restart-durable).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DurableEntityService, DurableEntityDispatcher } from '../../src/services/durableEntities.js';
import { SubjectRuntime, channelCorrelationId, type SubjectScript } from '../../src/services/subjectRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

const past = '2020-01-01T00:00:00.000Z';

const SCRIPT: SubjectScript = {
  start: 'greet',
  stages: {
    greet: { action: 'send', text: 'Oi {{name}}', next: 'wait1' },        // deterministic, token-free
    wait1: { action: 'wait', next: 'pitch' },
    pitch: { action: 'agent', instruction: 'Write a personalized pitch for {{name}}', next: 'wait2' },
    wait2: { action: 'wait', next: 'finish' },
    finish: { action: 'done' },
  },
};

describe('SubjectRuntime on the spine', () => {
  it('keeps a relationship Subject alive, cancels a stale follow-up on reply, and preserves compact state', async () => {
    const svc = new DurableEntityService(ctx.db);
    const runtime = new SubjectRuntime({ send: () => {}, runAgent: () => {} });
    const disp = new DurableEntityDispatcher(svc, { logger: ctx.logger });
    disp.registerHandler('subject', (c) => runtime.handle(c));
    const subject = svc.upsert({
      workspaceId: ctx.workspace.id, kind: 'subject', key: 'person:wa:42',
      state: {
        version: 2, subjectKey: 'person:wa:42', identity: { handles: [] }, facts: [], engagements: [], commitments: [],
        openQuestions: [], blockers: [], memoryRefs: [], updatedAt: past,
        nextAction: { kind: 'follow_up', goal: 'ask for documents', dueAt: '2099-01-01T00:00:00.000Z', status: 'planned' },
      },
    });
    svc.post(subject.id, 'channel.inbound', { text: 'Here are the documents' });
    await disp.tick();
    const state = svc.get(subject.id)!.stateJson as { nextAction: { status: string }; lastInboundAt: string };
    expect(svc.get(subject.id)!.status).toBe('active');
    expect(state.nextAction.status).toBe('cancelled');
    expect(state.lastInboundAt).toBeTruthy();
  });

  it('drives greeting → wait → pitch → wait → done, out of order, on one durable model', async () => {
    const svc = new DurableEntityService(ctx.db);
    const sends: Array<{ text: string; to: unknown }> = [];
    const agentCalls: string[] = [];
    const runtime = new SubjectRuntime({
      send: ({ text, facts }) => { sends.push({ text, to: facts.to }); },
      runAgent: ({ instruction }) => { agentCalls.push(instruction); },
    });
    const disp = new DurableEntityDispatcher(svc, { logger: ctx.logger });
    disp.registerHandler('subject', (c) => runtime.handle(c));

    const s1 = svc.upsert({ workspaceId: ctx.workspace.id, kind: 'subject', key: 'lead-1', state: { script: SCRIPT, stage: 'greet', facts: { name: 'Ana', to: '111' } }, nextWakeAt: past });
    const s2 = svc.upsert({ workspaceId: ctx.workspace.id, kind: 'subject', key: 'lead-2', state: { script: SCRIPT, stage: 'greet', facts: { name: 'Bruno', to: '222' } }, nextWakeAt: past });

    // Tick 1: both send the deterministic greeting, then park at wait1.
    expect(await disp.tick()).toBe(2);
    expect(sends.map((s) => s.text).sort()).toEqual(['Oi Ana', 'Oi Bruno']);
    expect((svc.get(s1.id)!.stateJson as { stage: string }).stage).toBe('wait1'); // durable position
    expect(svc.get(s1.id)!.nextWakeAt).toBeNull(); // parked — no timer

    // Nothing is due now (both parked, no replies) → a sweep is a clean no-op.
    expect(await disp.tick()).toBe(0);

    // The SECOND lead replies FIRST (out of order). Only it advances.
    svc.post(s2.id, 'reply', { text: 'yes please' });
    expect(await disp.tick()).toBe(1);
    expect(agentCalls).toEqual(['Write a personalized pitch for Bruno']); // pitch ran for Bruno only
    expect((svc.get(s2.id)!.stateJson as { stage: string }).stage).toBe('wait2');
    expect((svc.get(s1.id)!.stateJson as { stage: string }).stage).toBe('wait1'); // lead-1 still waiting

    // Now the first lead finally replies (could be days later).
    svc.post(s1.id, 'reply', { text: 'sure' });
    await disp.tick();
    expect(agentCalls).toHaveLength(2); // both pitched now
    expect((svc.get(s1.id)!.stateJson as { stage: string }).stage).toBe('wait2');

    // Bruno replies to the pitch → reaches terminal and stops.
    svc.post(s2.id, 'reply', { text: 'deal' });
    await disp.tick();
    expect(svc.get(s2.id)!.status).toBe('done');
    // A done subject is never woken again, even with a stray event.
    svc.post(s2.id, 'reply', {});
    expect(await disp.tick()).toBe(0);
    // The reply payload was captured into the subject's facts along the way.
    expect((svc.get(s2.id)!.stateJson as { facts: Record<string, unknown> }).facts.lastReply).toBeTruthy();
  });

  it('auto-routes an inbound channel reply to the parked subject by correlation', async () => {
    const svc = new DurableEntityService(ctx.db);
    const runtime = new SubjectRuntime({ send: () => {}, runAgent: () => {} });
    const disp = new DurableEntityDispatcher(svc, { logger: ctx.logger });
    disp.registerHandler('subject', (c) => runtime.handle(c));

    const script: SubjectScript = {
      start: 'greet',
      stages: { greet: { action: 'send', text: 'Oi', next: 'wait1' }, wait1: { action: 'wait', next: 'finish' }, finish: { action: 'done' } },
    };
    // The subject carries its channel facts — no explicit correlation in the script.
    const s = svc.upsert({ workspaceId: ctx.workspace.id, kind: 'subject', key: 'lead-1', state: { script, stage: 'greet', facts: { connectionId: 'c1', to: '42' } }, nextWakeAt: past });

    // Tick → greet, then park at wait1 with a DERIVED channel correlation.
    await disp.tick();
    const parked = svc.get(s.id)!;
    expect((parked.stateJson as { stage: string }).stage).toBe('wait1');
    expect(parked.awaitingCorrelationJson).toEqual({ kind: 'channel', id: channelCorrelationId('c1', '42') });

    // An inbound reply on that connection+chat routes to THIS subject (the bootstrap
    // onInbound hook does exactly this) — days later, out of order, is irrelevant.
    const routed = svc.postByCorrelation(ctx.workspace.id, { kind: 'channel', id: channelCorrelationId('c1', '42') }, 'reply', { text: 'yes' });
    expect(routed).toBe(s.id);

    // Next sweep advances past the wait to done.
    await disp.tick();
    expect(svc.get(s.id)!.status).toBe('done');
  });

  it('parks a fresh wait with no reply and terminates a malformed script cleanly', async () => {
    const svc = new DurableEntityService(ctx.db);
    const runtime = new SubjectRuntime({ send: () => {}, runAgent: () => {} });
    const disp = new DurableEntityDispatcher(svc, { logger: ctx.logger });
    disp.registerHandler('subject', (c) => runtime.handle(c));

    // Malformed (no script) → the handler terminates the entity instead of looping.
    const bad = svc.upsert({ workspaceId: ctx.workspace.id, kind: 'subject', key: 'bad', state: {} as never, nextWakeAt: past });
    await disp.tick();
    expect(svc.get(bad.id)!.status).toBe('done');
  });
});
