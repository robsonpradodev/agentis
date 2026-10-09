import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { DurableEntityService } from '../../src/services/durableEntities.js';
import { ChannelIdentityService } from '../../src/services/conversation/channelIdentityService.js';
import { RelationshipStateService } from '../../src/services/relationshipStateService.js';
import { FollowUpService } from '../../src/services/followUpService.js';
import { SubjectRuntime } from '../../src/services/subjectRuntime.js';

let ctx: TestContext;
let entities: DurableEntityService;
let identities: ChannelIdentityService;
let relationships: RelationshipStateService;
let followUps: FollowUpService;
let connectionId: string;

beforeEach(async () => {
  ctx = await createTestContext();
  entities = new DurableEntityService(ctx.db);
  identities = new ChannelIdentityService({ db: ctx.db, logger: ctx.logger });
  relationships = new RelationshipStateService({ db: ctx.db, entities, identities });
  followUps = new FollowUpService({ db: ctx.db, entities });
  const agentId = randomUUID();
  ctx.db.insert(schema.agents).values({ id: agentId, workspaceId: ctx.workspace.id, userId: ctx.user.id, name: 'Otto', adapterType: 'http' }).run();
  connectionId = randomUUID();
  ctx.db.insert(schema.channelConnections).values({
    id: connectionId, workspaceId: ctx.workspace.id, userId: ctx.user.id, agentId,
    kind: 'whatsapp', name: 'Sales line', tokenEncrypted: 'test',
  }).run();
});
afterEach(() => ctx.close());

/** Establish the relationship the inbound path would have created for one lead. */
function lead(handle: string, inboundText = 'quero saber mais') {
  return relationships.touch({
    workspaceId: ctx.workspace.id, connectionId, channelKind: 'whatsapp', handle,
    displayName: `Lead ${handle}`, inboundText,
  });
}

describe('FollowUpService', () => {
  it('arms a durable wake on the relationship and defaults to 24h out', () => {
    const subject = lead('5531900001').subject;
    const armed = followUps.schedule({
      workspaceId: ctx.workspace.id,
      subjectId: subject.id,
      goal: 'send the payment link we promised',
    });

    expect(armed.armed).toBe(true);
    const stored = entities.get(subject.id)!;
    // The wake clock is what actually brings the agent back; a nextAction the
    // dispatcher never sees is just a note to nobody.
    expect(stored.nextWakeAt).toBe(armed.dueAt);
    const delayMs = Date.parse(armed.dueAt) - Date.now();
    expect(delayMs).toBeGreaterThan(23 * 60 * 60_000);
    expect(delayMs).toBeLessThanOrEqual(24 * 60 * 60_000 + 5_000);
    expect((stored.stateJson as { nextAction: { goal: string; cancelOnReply: boolean } }).nextAction)
      .toMatchObject({ goal: 'send the payment link we promised', status: 'planned', cancelOnReply: true });
  });

  it('resolves a subject from the recipientRef an agent holds mid-conversation', () => {
    const created = lead('5531900002');
    const identity = identities.resolve(ctx.workspace.id, 'whatsapp', '5531900002', connectionId)!;

    const armed = followUps.schedule({
      workspaceId: ctx.workspace.id,
      recipientRef: `peer:${identity.id}`,
      goal: 'check whether they finished the signup',
      delayMs: 60_000,
    });

    expect(armed.subjectId).toBe(created.subject.id);
  });

  it('refuses to overwrite a commitment already planned unless asked to replace it', () => {
    const subject = lead('5531900003').subject;
    followUps.schedule({ workspaceId: ctx.workspace.id, subjectId: subject.id, goal: 'send the contract', delayMs: 60_000 });

    const second = followUps.schedule({ workspaceId: ctx.workspace.id, subjectId: subject.id, goal: 'generic re-engagement nudge', delayMs: 60_000 });
    expect(second.armed).toBe(false);
    expect(second.reason).toBe('already_planned');
    expect(second.nextAction.goal).toBe('send the contract');

    const replaced = followUps.schedule({
      workspaceId: ctx.workspace.id, subjectId: subject.id, goal: 'send the revised contract', delayMs: 60_000, replace: true,
    });
    expect(replaced.armed).toBe(true);
    expect(replaced.nextAction.goal).toBe('send the revised contract');
  });

  it('paces a cohort instead of firing every wake at the same instant', () => {
    const subjects = ['5531900010', '5531900011', '5531900012'].map((handle) => ({ subjectId: lead(handle).subject.id }));

    const result = followUps.scheduleMany({
      workspaceId: ctx.workspace.id,
      subjects,
      goal: 'they went quiet after the price — reopen with something useful',
      everyMs: 300_000,
      sourceRef: 'standing-goal:stalled-leads',
    });

    expect(result.armed).toBe(3);
    const dueAts = result.followUps.map((item) => Date.parse(item.dueAt));
    expect(dueAts[1]! - dueAts[0]!).toBeGreaterThanOrEqual(300_000);
    expect(dueAts[2]! - dueAts[1]!).toBeGreaterThanOrEqual(300_000);
  });

  it('reports an unresolvable member without abandoning the rest of the cohort', () => {
    const result = followUps.scheduleMany({
      workspaceId: ctx.workspace.id,
      subjects: [{ subjectId: lead('5531900020').subject.id }, { subjectId: randomUUID() }],
      goal: 'reopen the conversation',
    });

    expect(result.armed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.followUps[1]?.error).toMatch(/no relationship subject/);
  });

  it('cancel clears the timer so the entity stops being woken', () => {
    const subject = lead('5531900030').subject;
    followUps.schedule({ workspaceId: ctx.workspace.id, subjectId: subject.id, goal: 'nudge about the plan', delayMs: 60_000 });

    const cancelled = followUps.cancel(ctx.workspace.id, { subjectId: subject.id }, 'they bought');
    expect(cancelled.cancelled).toBe(true);
    const stored = entities.get(subject.id)!;
    expect(stored.nextWakeAt).toBeNull();
    expect((stored.stateJson as { nextAction: { status: string } }).nextAction.status).toBe('cancelled');

    expect(followUps.cancel(ctx.workspace.id, { subjectId: subject.id }).cancelled).toBe(false);
  });
});

describe('SubjectRuntime honours the follow-up contract', () => {
  it('withdraws a nudge when the person replies first, and keeps one marked cancelOnReply:false', async () => {
    const chatty = lead('5531900040').subject;
    const owed = lead('5531900041').subject;
    followUps.schedule({ workspaceId: ctx.workspace.id, subjectId: chatty.id, goal: 'nudge them', delayMs: 3_600_000 });
    followUps.schedule({ workspaceId: ctx.workspace.id, subjectId: owed.id, goal: 'deliver the quote we promised', delayMs: 3_600_000, cancelOnReply: false });

    const runtime = new SubjectRuntime({ send: () => {}, runAgent: () => ({ outcome: 'performed' }) });
    for (const subject of [chatty, owed]) {
      entities.post(subject.id, 'channel.inbound', { text: 'oi, ainda estou pensando' });
      const entity = entities.get(subject.id)!;
      const result = await runtime.handle({ entity, inbox: entities.pendingInbox(subject.id) });
      entities.release(subject.id, { state: result.state, nextWakeAt: result.nextWakeAt, consumeInboxIds: result.consumeInboxIds });
    }

    expect((entities.get(chatty.id)!.stateJson as { nextAction: { status: string } }).nextAction.status).toBe('cancelled');
    expect((entities.get(owed.id)!.stateJson as { nextAction: { status: string } }).nextAction.status).toBe('planned');
  });

  it('re-arms a cadenced follow-up until its attempt ceiling, then settles', async () => {
    const subject = lead('5531900050').subject;
    followUps.schedule({
      workspaceId: ctx.workspace.id, subjectId: subject.id,
      goal: 'reopen the conversation', delayMs: 1, cadenceMs: 172_800_000, maxAttempts: 2,
    });

    let performed = 0;
    const runtime = new SubjectRuntime({ send: () => {}, runAgent: () => { performed += 1; return { outcome: 'performed' }; } });
    const drive = async () => {
      const entity = entities.get(subject.id)!;
      // Act as the dispatcher would once the clock has elapsed.
      const result = await runtime.handle({ entity: { ...entity, stateJson: withDueNow(entity.stateJson) }, inbox: [] });
      entities.release(subject.id, { state: result.state, nextWakeAt: result.nextWakeAt, consumeInboxIds: result.consumeInboxIds });
    };

    await drive();
    expect(performed).toBe(1);
    expect((entities.get(subject.id)!.stateJson as { nextAction: { status: string; attempts: number } }).nextAction)
      .toMatchObject({ status: 'planned', attempts: 1 });

    await drive();
    expect(performed).toBe(2);
    // The ceiling, not the cadence, is what stops it: a cadenced nudge with no
    // attempt cap would keep waking on the same lead forever.
    expect((entities.get(subject.id)!.stateJson as { nextAction: { status: string; attempts: number } }).nextAction)
      .toMatchObject({ status: 'done', attempts: 2 });
    expect(entities.get(subject.id)!.nextWakeAt).toBeNull();

    await drive();
    expect(performed).toBe(2);
  });
});

describe('outbound clock', () => {
  it('records lastOutboundAt so an answered lead is distinguishable from an abandoned one', () => {
    const created = lead('5531900060');
    expect(created.state.lastOutboundAt ?? null).toBeNull();

    relationships.recordOutbound({ workspaceId: ctx.workspace.id, connectionId, channelKind: 'whatsapp', handle: '5531900060' });

    const after = relationships.get(created.subject.id)!;
    expect(after.lastOutboundAt).toBeTruthy();
    expect(Date.parse(after.lastOutboundAt!)).toBeGreaterThanOrEqual(Date.parse(after.lastInboundAt!));
  });

  it('never mints a relationship for a handle the inbound path never established', () => {
    const before = entities.listByKind(ctx.workspace.id, 'subject').length;
    relationships.recordOutbound({ workspaceId: ctx.workspace.id, connectionId, channelKind: 'whatsapp', handle: '5531999999' });
    expect(entities.listByKind(ctx.workspace.id, 'subject')).toHaveLength(before);
  });
});

/** Pull a planned action's dueAt back to now, standing in for elapsed time. */
function withDueNow(state: unknown): Record<string, unknown> {
  const value = state as { nextAction?: { dueAt?: string | null } };
  return {
    ...(value as Record<string, unknown>),
    nextAction: { ...value.nextAction, dueAt: new Date(Date.now() - 1_000).toISOString() },
  };
}
