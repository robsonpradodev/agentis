import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import { ChannelActionIntentService } from '../../src/services/conversation/channelActionIntentService.js';
import { AgentMissionService } from '../../src/services/agentMissions.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

describe('ChannelActionIntentService unresolved recipients', () => {
  it('retains an owner-authorized action until a later recipient slot is supplied', async () => {
    const agentId = randomUUID(); const connectionId = randomUUID(); const requesterId = randomUUID();
    ctx.db.insert(schema.agents).values({ id: agentId, workspaceId: ctx.workspace.id, userId: ctx.user.id, name: 'Ava', adapterType: 'http' }).run();
    ctx.db.insert(schema.channelConnections).values({ id: connectionId, workspaceId: ctx.workspace.id, userId: ctx.user.id, agentId, kind: 'whatsapp', name: 'Ava WhatsApp', tokenEncrypted: 'x', status: 'active' }).run();
    ctx.db.insert(schema.channelPeerIdentities).values({
      id: requesterId, workspaceId: ctx.workspace.id, connectionId, channelKind: 'whatsapp', handle: '+55000000000',
      authorityRole: 'owner', firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
    }).run();
    const peerId = randomUUID();
    ctx.db.insert(schema.channelPeerIdentities).values({
      id: peerId, workspaceId: ctx.workspace.id, connectionId, channelKind: 'whatsapp', handle: '+15551234567',
      firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
    }).run();
    const inbox = {
      resolve: vi.fn().mockReturnValue({ resolved: false, reason: 'not_found', candidates: [] }),
      ensurePeer: vi.fn().mockReturnValue({ peerIdentityId: peerId, recipientRef: `peer:${peerId}`, connectionId, channelKind: 'whatsapp', conversationId: null, subjectId: null }),
    };
    const service = new ChannelActionIntentService({
      db: ctx.db, logger: ctx.logger,
      channels: { get: () => ({ id: connectionId, agentId, kind: 'whatsapp' }) } as never,
      inbox: inbox as never, grants: { authorize: () => ({ ok: true }) } as never,
      policy: {} as never, approvals: {} as never,
    });
    const action = await service.create({
      workspaceId: ctx.workspace.id, agentId, requesterIdentityId: requesterId, connectionId,
      recipientQuery: 'example-store', goal: 'Explain how Acme can help', body: 'Acme can help your business…',
      authorizationBasis: 'verified_owner_command',
    });
    expect(action.status).toBe('planned');
    expect(action.peerIdentityId).toBeNull();
    expect(action.requiredSlots).toEqual(['recipient']);

    const execute = vi.spyOn(service, 'execute').mockResolvedValue({ sent: true } as never);
    const resumed = await service.resumeLatestMissingRecipient(ctx.workspace.id, requesterId, '+15551234567');
    expect(resumed?.peerIdentityId).toBe(peerId);
    expect(resumed?.requiredSlots).toEqual([]);
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe('ChannelActionIntentService ordered effects', () => {
  it('persists the first receipt and retries only the missing second burst item', async () => {
    const agentId = randomUUID(); const connectionId = randomUUID(); const peerId = randomUUID();
    ctx.db.insert(schema.agents).values({ id: agentId, workspaceId: ctx.workspace.id, userId: ctx.user.id, name: 'Ava', adapterType: 'http' }).run();
    ctx.db.insert(schema.channelConnections).values({
      id: connectionId, workspaceId: ctx.workspace.id, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'Ava WhatsApp', tokenEncrypted: 'x', status: 'active',
    }).run();
    ctx.db.insert(schema.channelPeerIdentities).values({
      id: peerId, workspaceId: ctx.workspace.id, connectionId, channelKind: 'whatsapp', handle: '+15551234567',
      firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
    }).run();
    const missions = new AgentMissionService(ctx.db, ctx.bus);
    const mission = missions.create({
      workspaceId: ctx.workspace.id, ownerAgentId: agentId, sourceKind: 'channel', sourceRef: 'owner-chat',
      objective: 'Send a sticker, then a PDF.',
      outcomeContract: { requiredEffects: [
        { id: 'requirement:sticker', kind: 'channel_delivery', planStepId: 'send-sticker' },
        { id: 'requirement:pdf', kind: 'channel_delivery', planStepId: 'send-pdf', dependsOn: ['send-sticker'] },
      ] },
    });
    const peer = {
      recipientRef: `peer:${peerId}`, peerIdentityId: peerId, connectionId, channelKind: 'whatsapp',
      displayName: 'Owner', conversationId: null, subjectId: null, aliases: [], handoffState: null,
      lastInboundAt: null, lastOutboundAt: null, lastMessageAt: null, lastMessagePreview: null,
      lastMessageDirection: null, stage: null, goal: null,
    };
    const connection = {
      id: connectionId, agentId, kind: 'whatsapp', name: 'Ava WhatsApp', status: 'active',
      defaultChatId: null, targetAliases: {}, isDefault: true, health: { status: 'healthy' },
    };
    const providerReceipts = new Map<string, { provider: 'whatsapp'; providerMessageId: string; status: 'accepted'; acceptedAt: string; recipient: string; providerAcknowledged: true }>();
    const providerAttempts = new Map<string, number>();
    let failPdfBeforeSubmit = true;
    const deliverToConnection = vi.fn(async (args: { idempotencyKey?: string; chatId: string }) => {
      const key = args.idempotencyKey!;
      const existing = providerReceipts.get(key);
      if (existing) return { ...existing, deduplicated: true };
      if (key.endsWith('send-pdf') && failPdfBeforeSubmit) {
        failPdfBeforeSubmit = false;
        throw Object.assign(new Error('transport was unavailable before provider submission'), { code: 'CHANNEL_HUMAN_TAKEOVER_ACTIVE' });
      }
      providerAttempts.set(key, (providerAttempts.get(key) ?? 0) + 1);
      const receipt = {
        provider: 'whatsapp' as const, providerMessageId: `wamid.${key.split('#').at(-1)}`,
        status: 'accepted' as const, acceptedAt: new Date().toISOString(), recipient: args.chatId,
        providerAcknowledged: true as const,
      };
      providerReceipts.set(key, receipt);
      return receipt;
    });
    const service = new ChannelActionIntentService({
      db: ctx.db, logger: ctx.logger, missions,
      channels: {
        get: () => connection, list: () => [connection], defaultConnectionFor: () => connectionId,
        resolveDestination: ({ to }: { to?: string | null }) => ({ chatId: to ?? null, source: 'explicit' }),
        deliverToConnection,
      } as never,
      inbox: {
        resolve: () => ({ resolved: true, peer, to: '+15551234567' }),
        get: () => peer, preferredAddress: () => '+15551234567',
      } as never,
      grants: { authorize: () => ({ ok: true }) } as never,
      policy: { evaluate: () => ({ allow: true }), record: vi.fn() } as never,
      approvals: {} as never,
    });
    const created = await service.createAndExecute({
      workspaceId: ctx.workspace.id, agentId, missionId: mission.id, connectionId,
      recipientRef: peer.recipientRef, goal: 'Send requested owner media',
      authorizationBasis: 'verified_owner_command', idempotencyKey: 'owner-media-burst',
      messages: [
        { id: 'send-sticker', requirementId: 'requirement:sticker', attachments: [{ artifactId: 'sticker-asset', kind: 'sticker' }] },
        { id: 'send-pdf', requirementId: 'requirement:pdf', attachments: [{ artifactId: 'pdf-asset', kind: 'file' }] },
      ],
    });

    expect(created.action.status).toBe('failed');
    expect(created.action.effectReceipts).toHaveLength(1);
    expect(missions.inspect(ctx.workspace.id, mission.id)).toMatchObject({ status: expect.not.stringMatching('accomplished') });

    await service.execute(ctx.workspace.id, created.action.id);
    const delivered = service.get(ctx.workspace.id, created.action.id)!;
    expect(delivered.status).toBe('delivered');
    expect(delivered.effectReceipts.map((receipt) => receipt.itemId)).toEqual(['send-sticker', 'send-pdf']);
    expect(providerAttempts.get('owner-media-burst#send-sticker')).toBe(1);
    expect(providerAttempts.get('owner-media-burst#send-pdf')).toBe(1);
    expect(missions.inspect(ctx.workspace.id, mission.id)).toMatchObject({ status: 'accomplished' });
  });
});
