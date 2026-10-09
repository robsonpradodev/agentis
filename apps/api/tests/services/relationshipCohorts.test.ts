import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { DurableEntityService } from '../../src/services/durableEntities.js';
import { ChannelIdentityService } from '../../src/services/conversation/channelIdentityService.js';
import { RelationshipStateService } from '../../src/services/relationshipStateService.js';
import { RelationshipCohortService } from '../../src/services/relationshipCohorts.js';
import { FollowUpService } from '../../src/services/followUpService.js';

let ctx: TestContext;
let entities: DurableEntityService;
let identities: ChannelIdentityService;
let relationships: RelationshipStateService;
let cohorts: RelationshipCohortService;
let agentId: string;
let connectionId: string;

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

beforeEach(async () => {
  ctx = await createTestContext();
  entities = new DurableEntityService(ctx.db);
  identities = new ChannelIdentityService({ db: ctx.db, logger: ctx.logger });
  relationships = new RelationshipStateService({ db: ctx.db, entities, identities });
  cohorts = new RelationshipCohortService({ db: ctx.db });
  agentId = randomUUID();
  ctx.db.insert(schema.agents).values({ id: agentId, workspaceId: ctx.workspace.id, userId: ctx.user.id, name: 'Otto', adapterType: 'http' }).run();
  connectionId = randomUUID();
  ctx.db.insert(schema.channelConnections).values({
    id: connectionId, workspaceId: ctx.workspace.id, userId: ctx.user.id, agentId,
    kind: 'whatsapp', name: 'Sales line', tokenEncrypted: 'test',
  }).run();
});
afterEach(() => ctx.close());

/**
 * Build one relationship with a real message history. `messages` are
 * [side, hoursAgo] pairs — the ledger is what the cohort query actually reads.
 */
function conversationWith(
  handle: string,
  messages: Array<['customer' | 'business', number]>,
  options: { handoffState?: string; authorityRole?: string; blocked?: boolean } = {},
): { subjectId: string | null; conversationId: string; peerIdentityId: string } {
  const touched = relationships.touch({
    workspaceId: ctx.workspace.id, connectionId, channelKind: 'whatsapp', handle,
    displayName: `Lead ${handle}`,
  });
  const identity = identities.resolve(ctx.workspace.id, 'whatsapp', handle, connectionId)!;
  if (options.authorityRole || options.blocked) {
    ctx.db.update(schema.channelPeerIdentities).set({
      ...(options.authorityRole ? { authorityRole: options.authorityRole } : {}),
      ...(options.blocked ? { blocked: true } : {}),
    }).where(eq(schema.channelPeerIdentities.id, identity.id)).run();
  }
  const conversationId = randomUUID();
  ctx.db.insert(schema.conversations).values({
    id: conversationId, workspaceId: ctx.workspace.id, userId: ctx.user.id, agentId,
    channelConnectionId: connectionId, channelChatId: handle, channelPeerIdentityId: identity.id,
    ...(options.handoffState ? { handoffState: options.handoffState } : {}),
    lastMessageAt: ago(Math.min(...messages.map(([, h]) => h))),
  }).run();
  for (const [side, hoursAgo] of messages) {
    ctx.db.insert(schema.conversationMessages).values({
      id: randomUUID(), conversationId, workspaceId: ctx.workspace.id,
      authorType: side === 'customer' ? 'user' : 'agent', participantSide: side,
      body: side === 'customer' ? 'quero saber mais' : 'te mando o link do pagamento',
      createdAt: ago(hoursAgo),
    }).run();
  }
  return { subjectId: touched.subject.id, conversationId, peerIdentityId: identity.id };
}

describe('RelationshipCohortService', () => {
  it('finds the lead who went silent after the agent spoke, and nobody else', () => {
    // The lead the sweep is actually for: they asked, the agent answered, silence.
    const stalled = conversationWith('5531900001', [['customer', 50], ['business', 48]]);
    // Answered ten minutes ago — mid-conversation, not stalled.
    conversationWith('5531900002', [['customer', 0.2], ['business', 0.1]]);
    // The one every naive sweep messages: an address-book row with no inbound ever.
    conversationWith('5531900003', [['business', 72]]);
    // They wrote last and are waiting on the agent — that is an unanswered
    // message, a different problem, and must not be treated as a cold lead.
    conversationWith('5531900004', [['business', 60], ['customer', 40]]);

    const result = cohorts.query({ workspaceId: ctx.workspace.id, silentForHours: 24, lastMessageFrom: 'agent' });

    expect(result.members.map((member) => member.subjectId)).toEqual([stalled.subjectId]);
    expect(result.members[0]).toMatchObject({ inboundCount: 1, outboundCount: 1, lastMessageDirection: 'outbound' });
    expect(result.members[0]?.hoursSinceInbound).toBeGreaterThanOrEqual(49);
    expect(result.excluded.still_recent).toBe(1);
    expect(result.excluded.they_spoke_last).toBe(1);
  });

  it('never counts a contact who never wrote — the address-book trap', () => {
    conversationWith('5531900010', [['business', 100]]);

    expect(cohorts.query({ workspaceId: ctx.workspace.id, silentForHours: 1 }).members).toHaveLength(0);
    // Only an explicit minInboundMessages: 0 can widen it, and the tool tells the agent not to.
    expect(cohorts.query({ workspaceId: ctx.workspace.id, silentForHours: 1, minInboundMessages: 0 }).members).toHaveLength(1);
  });

  it('leaves threads a human took over alone', () => {
    conversationWith('5531900020', [['customer', 50], ['business', 48]], { handoffState: 'human' });

    expect(cohorts.query({ workspaceId: ctx.workspace.id, silentForHours: 24 }).members).toHaveLength(0);
    expect(cohorts.query({ workspaceId: ctx.workspace.id, silentForHours: 24, includeHumanHandoff: true }).members).toHaveLength(1);
  });

  it('skips the operator and blocked contacts', () => {
    const owner = conversationWith('5531900030', [['customer', 50], ['business', 48]]);
    const blocked = conversationWith('5531900031', [['customer', 50], ['business', 48]]);
    ctx.db.update(schema.channelPeerIdentities).set({ authorityRole: 'owner' })
      .where(eq(schema.channelPeerIdentities.id, owner.peerIdentityId)).run();
    ctx.db.update(schema.channelPeerIdentities).set({ blocked: true })
      .where(eq(schema.channelPeerIdentities.id, blocked.peerIdentityId)).run();

    const result = cohorts.query({ workspaceId: ctx.workspace.id, silentForHours: 24 });
    expect(result.members).toHaveLength(0);
    expect(result.excluded.owner_or_delegate).toBe(1);
    expect(result.excluded.blocked).toBe(1);
  });

  it('excludes anyone already armed, so a re-run does not double-book them', () => {
    const first = conversationWith('5531900040', [['customer', 50], ['business', 48]]);
    conversationWith('5531900041', [['customer', 50], ['business', 48]]);
    const followUps = new FollowUpService({ db: ctx.db, entities });
    followUps.schedule({ workspaceId: ctx.workspace.id, subjectId: first.subjectId!, goal: 'reopen', delayMs: HOUR });

    const result = cohorts.query({ workspaceId: ctx.workspace.id, silentForHours: 24 });
    expect(result.members).toHaveLength(1);
    expect(result.members[0]?.subjectId).not.toBe(first.subjectId);
    expect(result.excluded.already_planned).toBe(1);
  });

  it('honours the outbound cooldown so a lead is not approached twice in a day', () => {
    conversationWith('5531900050', [['customer', 50], ['business', 2]]);

    expect(cohorts.query({ workspaceId: ctx.workspace.id, silentForHours: 24 }).members).toHaveLength(1);
    const cooled = cohorts.query({ workspaceId: ctx.workspace.id, silentForHours: 24, quietSinceOutboundHours: 24 });
    expect(cooled.members).toHaveLength(0);
    expect(cooled.excluded.contacted_too_recently).toBe(1);
  });

  it('returns the longest-silent first and reports truncation', () => {
    conversationWith('5531900060', [['customer', 30], ['business', 29]]);
    conversationWith('5531900061', [['customer', 200], ['business', 199]]);
    conversationWith('5531900062', [['customer', 100], ['business', 99]]);

    const result = cohorts.query({ workspaceId: ctx.workspace.id, silentForHours: 24, limit: 2 });
    expect(result.members.map((member) => member.displayName)).toEqual(['Lead 5531900061', 'Lead 5531900062']);
    expect(result.truncated).toBe(true);
    expect(result.considered).toBe(3);
  });

  it('hands the cohort straight to the follow-up verb as one paced batch', () => {
    for (const handle of ['5531900070', '5531900071', '5531900072']) {
      conversationWith(handle, [['customer', 50], ['business', 48]]);
    }
    const cohort = cohorts.query({ workspaceId: ctx.workspace.id, silentForHours: 24, lastMessageFrom: 'agent' });
    const followUps = new FollowUpService({ db: ctx.db, entities });

    const armed = followUps.scheduleMany({
      workspaceId: ctx.workspace.id,
      subjects: cohort.members.map((member) => ({ subjectId: member.subjectId })),
      goal: 'they went quiet after the price — reopen with something specific to them',
      everyMs: 300_000,
      sourceRef: 'standing-goal:stalled-leads',
    });

    expect(armed.armed).toBe(3);
    // Every member now carries its own wake: fifty leads would be fifty
    // independent turns, not one turn expected to carry fifty.
    for (const member of cohort.members) {
      expect(entities.get(member.subjectId!)!.nextWakeAt).toBeTruthy();
    }
    // And the same sweep run again finds nobody, because they are all armed.
    expect(cohorts.query({ workspaceId: ctx.workspace.id, silentForHours: 24, lastMessageFrom: 'agent' }).members).toHaveLength(0);
  });
});
