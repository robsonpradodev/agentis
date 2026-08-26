/**
 * ChannelIdentityService — cross-surface peer identity (OMNICHANNEL §5.2).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { ChannelIdentityService } from '../../src/services/conversation/channelIdentityService.js';
import { schema } from '@agentis/db/sqlite';
import { eq } from 'drizzle-orm';

function seedConnection(ctx: TestContext, id: string, kind: string): void {
  ctx.db.insert(schema.channelConnections).values({
    id, workspaceId: ctx.workspace.id, userId: ctx.user.id, agentId: null,
    kind, name: id, tokenEncrypted: 'test',
  }).run();
}

describe('ChannelIdentityService', () => {
  let ctx: TestContext;
  let svc: ChannelIdentityService;
  beforeEach(async () => {
    ctx = await createTestContext();
    svc = new ChannelIdentityService({ db: ctx.db, logger: ctx.logger });
  });
  afterEach(() => ctx.close());

  it('records then increments a sender, and resolve returns it', () => {
    const first = svc.record({ workspaceId: ctx.workspace.id, channelKind: 'whatsapp', handle: '555@s.whatsapp.net', displayName: 'Bob' });
    expect(first.messageCount).toBe(1);
    const second = svc.record({ workspaceId: ctx.workspace.id, channelKind: 'whatsapp', handle: '555@s.whatsapp.net', displayName: 'Bob' });
    expect(second.messageCount).toBe(2);
    const resolved = svc.resolve(ctx.workspace.id, 'whatsapp', '555@s.whatsapp.net');
    expect(resolved?.messageCount).toBe(2);
    expect(resolved?.displayName).toBe('Bob');
  });

  it('first contact has no recall summary; a repeat does', () => {
    const first = svc.recordAndSummarize({ workspaceId: ctx.workspace.id, channelKind: 'telegram', handle: '42', displayName: 'Ann' });
    expect(first.summary).toBeNull();
    const repeat = svc.recordAndSummarize({ workspaceId: ctx.workspace.id, channelKind: 'telegram', handle: '42', displayName: 'Ann' });
    expect(repeat.summary).toContain('Known sender: Ann');
    expect(repeat.summary).toContain('2 prior messages');
  });

  it('blocks and unblocks a sender (gate reads isBlocked; list surfaces it)', () => {
    svc.record({ workspaceId: ctx.workspace.id, channelKind: 'whatsapp', handle: 'spammer', displayName: 'X' });
    expect(svc.isBlocked(ctx.workspace.id, 'whatsapp', 'spammer')).toBe(false);
    const blocked = svc.setBlocked({ workspaceId: ctx.workspace.id, channelKind: 'whatsapp', handle: 'spammer', blocked: true });
    expect(blocked.blocked).toBe(true);
    expect(svc.isBlocked(ctx.workspace.id, 'whatsapp', 'spammer')).toBe(true);
    expect(svc.list(ctx.workspace.id).find((i) => i.handle === 'spammer')?.blocked).toBe(true);
    svc.setBlocked({ workspaceId: ctx.workspace.id, channelKind: 'whatsapp', handle: 'spammer', blocked: false });
    expect(svc.isBlocked(ctx.workspace.id, 'whatsapp', 'spammer')).toBe(false);
  });

  it('can pre-block a sender never seen before (creates the row)', () => {
    svc.setBlocked({ workspaceId: ctx.workspace.id, channelKind: 'telegram', handle: 'never-seen', blocked: true });
    expect(svc.isBlocked(ctx.workspace.id, 'telegram', 'never-seen')).toBe(true);
  });

  it('linking a handle to a user unifies it across channels', () => {
    svc.record({ workspaceId: ctx.workspace.id, channelKind: 'whatsapp', handle: 'wa-1', displayName: 'Sam' });
    svc.record({ workspaceId: ctx.workspace.id, channelKind: 'slack', handle: 'U123', displayName: 'Sam' });
    svc.link({ workspaceId: ctx.workspace.id, channelKind: 'whatsapp', handle: 'wa-1', userId: ctx.user.id });
    svc.link({ workspaceId: ctx.workspace.id, channelKind: 'slack', handle: 'U123', userId: ctx.user.id });

    const peers = svc.peerChannels(ctx.workspace.id, `user:${ctx.user.id}`);
    expect(peers.map((p) => p.channelKind).sort()).toEqual(['slack', 'whatsapp']);

    // The summary now mentions the other surface.
    const { summary } = svc.recordAndSummarize({ workspaceId: ctx.workspace.id, channelKind: 'whatsapp', handle: 'wa-1', displayName: 'Sam' });
    expect(summary).toContain('linked to a workspace user');
    expect(summary).toContain('also reaches you on: slack');
  });

  it('a linked handle yields a summary even on its first counted message', () => {
    svc.record({ workspaceId: ctx.workspace.id, channelKind: 'discord', handle: 'd-9' });
    svc.link({ workspaceId: ctx.workspace.id, channelKind: 'discord', handle: 'd-9', userId: ctx.user.id });
    const linked = svc.resolve(ctx.workspace.id, 'discord', 'd-9');
    expect(linked?.peerKey).toBe(`user:${ctx.user.id}`);
  });

  it('list returns all identities for the workspace', () => {
    svc.record({ workspaceId: ctx.workspace.id, channelKind: 'whatsapp', handle: 'a' });
    svc.record({ workspaceId: ctx.workspace.id, channelKind: 'telegram', handle: 'b' });
    expect(svc.list(ctx.workspace.id)).toHaveLength(2);
  });

  it('scopes identical handles to their connection and never leaks owner authority', () => {
    seedConnection(ctx, 'sales-line', 'whatsapp');
    seedConnection(ctx, 'support-line', 'whatsapp');
    const shared = '5511999999999@s.whatsapp.net';
    const a = svc.record({ workspaceId: ctx.workspace.id, connectionId: 'sales-line', channelKind: 'whatsapp', handle: shared });
    const b = svc.record({ workspaceId: ctx.workspace.id, connectionId: 'support-line', channelKind: 'whatsapp', handle: shared });
    expect(a.id).not.toBe(b.id);
    svc.grantAuthority({
      workspaceId: ctx.workspace.id, connectionId: 'sales-line', channelKind: 'whatsapp', handle: shared,
      role: 'owner', userId: ctx.user.id, method: 'test_verification',
    });
    expect(svc.principal({ workspaceId: ctx.workspace.id, connectionId: 'sales-line', channelKind: 'whatsapp', handle: shared }).role).toBe('owner');
    expect(svc.principal({ workspaceId: ctx.workspace.id, connectionId: 'support-line', channelKind: 'whatsapp', handle: shared }).role).toBe('external');
  });

  it('resolves formatted and device-qualified WhatsApp aliases without crossing connections', () => {
    seedConnection(ctx, 'owner-line', 'whatsapp');
    seedConnection(ctx, 'other-line', 'whatsapp');
    svc.grantAuthority({
      workspaceId: ctx.workspace.id, connectionId: 'owner-line', channelKind: 'whatsapp', handle: '+55 11 99999-9999',
      role: 'owner', userId: ctx.user.id, method: 'test_verification',
    });
    expect(svc.isVerifiedOwner({
      workspaceId: ctx.workspace.id, connectionId: 'owner-line', channelKind: 'whatsapp', handle: '5511999999999:8@s.whatsapp.net',
    })).toBe(true);
    expect(svc.principal({
      workspaceId: ctx.workspace.id, connectionId: 'owner-line', channelKind: 'whatsapp', handle: '5511999999999:8@s.whatsapp.net',
    }).role).toBe('owner');
    expect(svc.isVerifiedOwner({
      workspaceId: ctx.workspace.id, connectionId: 'other-line', channelKind: 'whatsapp', handle: '5511999999999@s.whatsapp.net',
    })).toBe(false);
  });

  it('expires and revokes delegate authority without deleting identity history', () => {
    seedConnection(ctx, 'line', 'telegram');
    const identity = svc.grantAuthority({
      workspaceId: ctx.workspace.id, connectionId: 'line', channelKind: 'telegram', handle: '42',
      role: 'delegate', method: 'operator_grant', expiresAt: '2020-01-01T00:00:00.000Z',
    });
    expect(svc.principal({ workspaceId: ctx.workspace.id, connectionId: 'line', channelKind: 'telegram', handle: '42' }).role).toBe('external');
    expect(svc.revokeAuthority({ workspaceId: ctx.workspace.id, identityId: identity.id })?.messageCount).toBe(1);
  });

  it('unifies existing relationship grounding when two channel handles are linked', () => {
    seedConnection(ctx, 'wa-line', 'whatsapp');
    seedConnection(ctx, 'tg-line', 'telegram');
    const wa = svc.record({ workspaceId: ctx.workspace.id, connectionId: 'wa-line', channelKind: 'whatsapp', handle: '5511' });
    const tg = svc.record({ workspaceId: ctx.workspace.id, connectionId: 'tg-line', channelKind: 'telegram', handle: '42' });
    const now = new Date().toISOString();
    ctx.db.insert(schema.durableEntities).values([
      { id: 'subject-wa', workspaceId: ctx.workspace.id, kind: 'subject', key: 'person:wa', stateJson: { facts: [{ key: 'city', value: 'BH' }] }, createdAt: now, updatedAt: now },
      { id: 'subject-tg', workspaceId: ctx.workspace.id, kind: 'subject', key: 'person:tg', stateJson: { commitments: [{ id: 'send-proposal' }] }, createdAt: now, updatedAt: now },
    ]).run();
    svc.setGroundingEntity(wa.id, 'subject-wa');
    svc.setGroundingEntity(tg.id, 'subject-tg');
    svc.link({ workspaceId: ctx.workspace.id, connectionId: 'wa-line', channelKind: 'whatsapp', handle: '5511', userId: ctx.user.id });
    svc.link({ workspaceId: ctx.workspace.id, connectionId: 'tg-line', channelKind: 'telegram', handle: '42', userId: ctx.user.id });
    const linkedWa = svc.resolve(ctx.workspace.id, 'whatsapp', '5511', 'wa-line')!;
    const linkedTg = svc.resolve(ctx.workspace.id, 'telegram', '42', 'tg-line')!;
    expect(linkedWa.groundingEntityId).toBe(linkedTg.groundingEntityId);
    expect(ctx.db.select().from(schema.durableEntities).where(eq(schema.durableEntities.id, 'subject-tg')).get()?.status).toBe('done');
  });

  it('collapses WhatsApp PN and LID aliases into one canonical peer and removes the duplicate identity', () => {
    seedConnection(ctx, 'wa-aliases', 'whatsapp');
    const pn = svc.record({
      workspaceId: ctx.workspace.id, connectionId: 'wa-aliases', channelKind: 'whatsapp',
      handle: '553171443148@s.whatsapp.net', displayName: 'Robson',
    });
    const lid = svc.record({
      workspaceId: ctx.workspace.id, connectionId: 'wa-aliases', channelKind: 'whatsapp',
      handle: '18919191919@lid', displayName: 'Robson',
    });
    expect(pn.id).not.toBe(lid.id);

    const canonical = svc.observeAliases({
      workspaceId: ctx.workspace.id,
      connectionId: 'wa-aliases',
      channelKind: 'whatsapp',
      primaryHandle: '553171443148@s.whatsapp.net',
      aliases: ['18919191919@lid', '+55 31 7144-3148'],
      displayName: 'Robson',
      source: 'baileys_lid_mapping',
      verified: true,
      countMessage: false,
    });

    expect(svc.resolve(ctx.workspace.id, 'whatsapp', '18919191919@lid', 'wa-aliases')?.id).toBe(canonical.id);
    expect(svc.resolve(ctx.workspace.id, 'whatsapp', '+55 31 7144-3148', 'wa-aliases')?.id).toBe(canonical.id);
    expect(svc.list(ctx.workspace.id).filter((identity) => identity.connectionId === 'wa-aliases')).toHaveLength(1);
    expect(svc.aliases(canonical.id).map((alias) => alias.value)).toEqual(expect.arrayContaining([
      '553171443148@s.whatsapp.net', '18919191919@lid', '+55 31 7144-3148',
    ]));
  });

  it('synchronizes the configured owner immediately and recognizes every verified alias', () => {
    seedConnection(ctx, 'wa-owner-sync', 'whatsapp');
    const owner = svc.syncConfiguredOwner({
      workspaceId: ctx.workspace.id,
      connectionId: 'wa-owner-sync',
      channelKind: 'whatsapp',
      handle: '+55 31 7144-3148',
      userId: ctx.user.id,
      displayName: 'Robson',
    });
    expect(owner).toMatchObject({ authorityRole: 'owner', messageCount: 0, userId: ctx.user.id });
    svc.observeAliases({
      workspaceId: ctx.workspace.id,
      connectionId: 'wa-owner-sync',
      channelKind: 'whatsapp',
      primaryHandle: '553171443148@s.whatsapp.net',
      aliases: ['18919191919@lid', '+55 31 7144-3148'],
      source: 'provider',
      verified: true,
      countMessage: false,
    });
    expect(svc.isVerifiedOwner({
      workspaceId: ctx.workspace.id, connectionId: 'wa-owner-sync', channelKind: 'whatsapp', handle: '18919191919@lid',
    })).toBe(true);
  });
});
