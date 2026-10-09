import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import { AgentMissionService } from '../../src/services/agentMissions.js';
import { AgentMissionDriver, missionSettlementMessage } from '../../src/services/agentMissionDriver.js';
import { ChannelActionIntentService } from '../../src/services/conversation/channelActionIntentService.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function seedAgent(name = 'Ava') {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id, workspaceId: ctx.workspace.id, userId: ctx.user.id, name, adapterType: 'http', config: {},
  }).run();
  return id;
}

describe('AgentMissionService', () => {
  it('exposes a durable task tree with input, approval, artifacts, authority, and timeline', () => {
    const agentId = seedAgent();
    const missions = new AgentMissionService(ctx.db, ctx.bus);
    const authority = {
      workspaceId: ctx.workspace.id, ownerPrincipalId: ctx.user.id, initiatorPrincipalId: ctx.user.id,
      actorPrincipalId: agentId, delegationChain: [], scopes: ['crm:write'], maxEffectLevel: 'reversible' as const,
    };
    const root = missions.create({
      workspaceId: ctx.workspace.id, ownerAgentId: agentId, sourceKind: 'api', objective: 'Import accounts',
      operationId: 'accounts.import', authorityContext: authority, costBudgetCents: 100, latencyBudgetMs: 60_000,
    });
    const child = missions.create({
      workspaceId: ctx.workspace.id, ownerAgentId: agentId, sourceKind: 'api', objective: 'Validate account 1',
      parentMissionId: root.id, authorityContext: authority,
    });
    expect(child.rootMissionId).toBe(root.id);
    expect(missions.inspect(ctx.workspace.id, root.id).childMissionIds).toContain(child.id);

    let task = missions.requestInput(ctx.workspace.id, child.id, {
      id: 'mapping', title: 'Choose field mapping', schema: { type: 'object' },
    });
    expect(task.status).toBe('input_required');
    task = missions.submitInput(ctx.workspace.id, child.id, 'mapping', { name: 'company_name' }, ctx.user.id);
    expect(task.status).toBe('queued');
    task = missions.requestApproval(ctx.workspace.id, child.id, { id: 'commit', title: 'Commit import' });
    expect(task.status).toBe('approval_required');
    task = missions.resolveApproval(ctx.workspace.id, child.id, 'commit', 'approved', ctx.user.id);
    expect(task.status).toBe('queued');
    task = missions.attachArtifact(ctx.workspace.id, child.id, {
      id: 'report', name: 'Validation report', kind: 'report', createdAt: new Date().toISOString(), securityLabels: [],
    });
    expect(task.artifacts).toHaveLength(1);
    expect(task.timeline?.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      'task.created', 'task.input_required', 'task.input_submitted', 'task.approval_required', 'task.approval_approved', 'task.artifact_attached',
    ]));
  });

  it('cannot accomplish an action mission from prose or a partial receipt', () => {
    const agentId = seedAgent();
    const missions = new AgentMissionService(ctx.db, ctx.bus);
    const mission = missions.create({
      workspaceId: ctx.workspace.id, ownerAgentId: agentId, sourceKind: 'api',
      objective: 'Send the Acme introduction and move the lead to contacted.',
      correlationKey: 'false-completion-regression',
      outcomeContract: { requiredEffects: [{ kind: 'channel_delivery' }, { kind: 'subject_update' }] },
    });

    missions.start(ctx.workspace.id, mission.id);
    missions.progress(ctx.workspace.id, mission.id, 'I will send the message now.');
    expect(missions.inspect(ctx.workspace.id, mission.id).status).not.toBe('accomplished');

    missions.recordReceipt({
      workspaceId: ctx.workspace.id, missionId: mission.id, kind: 'channel_delivery',
      providerMessageId: 'wamid.1', providerStatus: 'accepted', acknowledged: true,
      idempotencyKey: 'delivery:1', evidence: { provider: 'whatsapp' },
    });
    expect(missions.inspect(ctx.workspace.id, mission.id).status).not.toBe('accomplished');

    missions.recordReceipt({
      workspaceId: ctx.workspace.id, missionId: mission.id, kind: 'subject_update',
      resourceType: 'app_data:leads', resourceId: 'lead-1', resourceVersion: 2,
      acknowledged: true, idempotencyKey: 'lead-update:1', evidence: { stage: 'contacted' },
    });
    const accomplished = missions.inspect(ctx.workspace.id, mission.id);
    expect(accomplished.status).toBe('accomplished');
    expect(accomplished.receipts).toHaveLength(2);

    missions.recordReceipt({
      workspaceId: ctx.workspace.id, missionId: mission.id, kind: 'subject_update',
      resourceType: 'app_data:leads', resourceId: 'lead-1', resourceVersion: 2,
      acknowledged: true, idempotencyKey: 'lead-update:1', evidence: { replay: true },
    });
    expect(missions.inspect(ctx.workspace.id, mission.id).receipts).toHaveLength(2);
  });

  it('keeps same-kind commitments distinct and links provider proof to its originating tool call', () => {
    const agentId = seedAgent();
    const missions = new AgentMissionService(ctx.db, ctx.bus);
    const mission = missions.create({
      workspaceId: ctx.workspace.id, ownerAgentId: agentId, sourceKind: 'channel', sourceRef: 'owner-chat',
      objective: 'Send a sticker and then a PDF.',
      outcomeContract: { requiredEffects: [
        { id: 'sticker', kind: 'channel_delivery', planStepId: 'send-sticker' },
        { id: 'pdf', kind: 'channel_delivery', planStepId: 'send-pdf', dependsOn: ['send-sticker'] },
      ] },
      executionPlan: { version: 1, steps: [
        { id: 'find-assets', kind: 'observe', title: 'Find Assets', toolName: 'agentis.assets.search' },
        { id: 'send-sticker', kind: 'effect', title: 'Send sticker', toolName: 'agentis.channel.send', dependsOn: ['find-assets'], effectRequirementIds: ['sticker'] },
        { id: 'send-pdf', kind: 'effect', title: 'Send PDF', toolName: 'agentis.channel.send', dependsOn: ['send-sticker'], effectRequirementIds: ['pdf'] },
      ] },
    });
    missions.recordReceipt({
      workspaceId: ctx.workspace.id, missionId: mission.id, kind: 'channel_delivery',
      actionId: 'action-burst', requirementId: 'sticker', providerMessageId: 'wamid.sticker',
      providerStatus: 'accepted', acknowledged: true, idempotencyKey: 'burst#sticker',
    });

    let partial = missions.inspect(ctx.workspace.id, mission.id);
    expect(partial.status).not.toBe('accomplished');
    expect(partial.currentStepId).toBe('send-pdf');
    expect(partial.executionPlan?.steps.map((step) => step.status)).toEqual(['verified', 'verified', 'ready']);

    missions.recordReceipt({
      workspaceId: ctx.workspace.id, missionId: mission.id, kind: 'channel_delivery',
      actionId: 'action-burst', requirementId: 'pdf', providerMessageId: 'wamid.pdf',
      providerStatus: 'accepted', acknowledged: true, idempotencyKey: 'burst#pdf',
    });
    missions.linkToolCall(ctx.workspace.id, mission.id, 'model-tool-burst', 'action-burst');

    partial = missions.inspect(ctx.workspace.id, mission.id);
    expect(partial.status).toBe('accomplished');
    expect(partial.currentStepId).toBeNull();
    expect(partial.executionPlan?.steps.every((step) => step.status === 'verified')).toBe(true);
    expect(partial.receipts?.map((receipt) => receipt.toolCallId)).toEqual(['model-tool-burst', 'model-tool-burst']);
  });

  it('never treats a downstream effect receipt as proof of its ordered effect dependency', () => {
    const agentId = seedAgent();
    const missions = new AgentMissionService(ctx.db, ctx.bus);
    const mission = missions.create({
      workspaceId: ctx.workspace.id, ownerAgentId: agentId, sourceKind: 'channel',
      objective: 'Send a sticker, then a PDF.',
      outcomeContract: { requiredEffects: [
        { id: 'sticker', kind: 'channel_delivery', planStepId: 'send-sticker' },
        { id: 'pdf', kind: 'channel_delivery', planStepId: 'send-pdf', dependsOn: ['send-sticker'] },
      ] },
      executionPlan: { version: 1, steps: [
        { id: 'send-sticker', kind: 'effect', title: 'Send sticker', toolName: 'agentis.channel.send', effectRequirementIds: ['sticker'] },
        { id: 'send-pdf', kind: 'effect', title: 'Send PDF', toolName: 'agentis.channel.send', dependsOn: ['send-sticker'], effectRequirementIds: ['pdf'] },
      ] },
    });
    missions.recordReceipt({
      workspaceId: ctx.workspace.id, missionId: mission.id, kind: 'channel_delivery',
      requirementId: 'pdf', providerMessageId: 'wamid.pdf-out-of-order', providerStatus: 'accepted',
      acknowledged: true, idempotencyKey: 'pdf-out-of-order',
    });

    const pending = missions.inspect(ctx.workspace.id, mission.id);
    expect(pending.status).not.toBe('accomplished');
    expect(pending.currentStepId).toBe('send-sticker');
    expect(pending.executionPlan?.steps.map((step) => step.status)).toEqual(['ready', 'verified']);
  });

  it('sends once, records provider ack, then mutates the exact lead and settles', async () => {
    const agentId = seedAgent();
    ctx.db.insert(schema.apps).values({
      id: 'sample-app', workspaceId: ctx.workspace.id, slug: 'sample-outbound', name: 'Sample Outbound',
      ownerAgentId: agentId, createdBy: ctx.user.id,
    }).run();
    const connectionId = randomUUID();
    const peerId = randomUUID();
    ctx.db.insert(schema.channelConnections).values({
      id: connectionId, workspaceId: ctx.workspace.id, userId: ctx.user.id, agentId,
      kind: 'whatsapp', name: 'Ava WhatsApp', tokenEncrypted: 'x', status: 'active',
    }).run();
    ctx.db.insert(schema.channelPeerIdentities).values({
      id: peerId, workspaceId: ctx.workspace.id, connectionId, channelKind: 'whatsapp', handle: '+5531999999999',
      firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
    }).run();

    const missions = new AgentMissionService(ctx.db, ctx.bus);
    const mission = missions.create({
      workspaceId: ctx.workspace.id, ownerAgentId: agentId, appId: 'sample-app', sourceKind: 'workflow',
      sourceRef: 'run-sample', correlationKey: 'sample-first-touch-1',
      objective: 'Send one WhatsApp introduction and move Example Pet Spa to contacted.',
      outcomeContract: { requiredEffects: [{ kind: 'channel_delivery' }, { kind: 'subject_update' }] },
    });
    let lead = { id: 'lead-spa-pets', version: 1, data: { name: 'Example Pet Spa', stage: 'new', first_touch_sent: false } };
    const appData = {
      getRecord: vi.fn(() => lead),
      update: vi.fn((_workspaceId: string, _appId: string, _collection: string, id: string, patch: Record<string, unknown>) => {
        lead = { id, version: lead.version + 1, data: { ...lead.data, ...patch } };
        return lead;
      }),
    };
    const deliver = vi.fn().mockResolvedValue({
      provider: 'whatsapp', providerMessageId: '3EB0CC627C18AA0E096F0E', status: 'accepted',
      acceptedAt: new Date().toISOString(), recipient: '+5531999999999', providerAcknowledged: true,
    });
    const peer = {
      recipientRef: `peer:${peerId}`, peerIdentityId: peerId, connectionId, channelKind: 'whatsapp',
      displayName: 'Example Pet Spa', conversationId: null, subjectId: null, aliases: [],
      lastInboundAt: null, lastOutboundAt: null, lastMessageAt: null, lastMessagePreview: null,
      lastMessageDirection: null, handoffState: null, stage: 'new', goal: null,
    };
    const channel = {
      id: connectionId, workspaceId: ctx.workspace.id, userId: ctx.user.id, agentId, kind: 'whatsapp',
      name: 'Ava WhatsApp', status: 'active', defaultChatId: null, targetAliases: {}, isDefault: true,
      health: { status: 'healthy' },
    };
    const service = new ChannelActionIntentService({
      db: ctx.db, logger: ctx.logger, missions, appData,
      channels: {
        get: () => channel, list: () => [channel], defaultConnectionFor: () => connectionId,
        resolveDestination: ({ to }: { to?: string | null }) => ({ chatId: to ?? null, source: 'explicit' }),
        deliverToConnection: deliver,
      } as never,
      inbox: {
        resolve: () => ({ resolved: true, peer, to: '+5531999999999' }),
        get: () => peer, preferredAddress: () => '+5531999999999',
      } as never,
      grants: { authorize: () => ({ ok: true }) } as never,
      policy: { evaluateAutonomy: () => ({ decision: 'allow' }), evaluate: () => ({ allow: true }), record: vi.fn() } as never,
      approvals: {} as never,
    });
    const input = {
      workspaceId: ctx.workspace.id, appId: 'sample-app', agentId, missionId: mission.id,
      connectionId, recipientRef: peer.recipientRef,
      goal: 'Introduce Acme to Example Pet Spa', body: 'Olá! A Acme pode ajudar seu negócio…',
      authorizationBasis: 'verified_owner_command' as const, idempotencyKey: 'sample:first-touch:lead-spa-pets',
      postAckMutations: [{
        kind: 'app_data_update' as const, appId: 'sample-app', collection: 'leads', recordId: 'lead-spa-pets',
        expectedVersion: 1, patch: { stage: 'contacted', first_touch_sent: true, provider_ack: true },
        receiptKind: 'subject_update' as const,
      }],
    };

    const first = await service.createAndExecute(input);
    expect(first.action.status).toBe('delivered');
    expect(deliver).toHaveBeenCalledOnce();
    expect(appData.update).toHaveBeenCalledOnce();
    expect(lead.data.stage).toBe('contacted');
    expect(missions.inspect(ctx.workspace.id, mission.id).status).toBe('accomplished');

    const replay = await service.createAndExecute(input);
    expect(replay.action.id).toBe(first.action.id);
    expect(deliver).toHaveBeenCalledOnce();
    expect(appData.update).toHaveBeenCalledOnce();
    expect(missions.inspect(ctx.workspace.id, mission.id).receipts).toHaveLength(2);
  });

  it('notifies the source channel when a durable mission settles', async () => {
    const agentId = seedAgent();
    const missions = new AgentMissionService(ctx.db, ctx.bus);
    const mission = missions.create({
      workspaceId: ctx.workspace.id, ownerAgentId: agentId, sourceKind: 'channel', sourceRef: 'owner-conversation',
      objective: 'Envie uma mensagem para este número dizendo oi.',
      outcomeContract: { requiredEffects: [{ kind: 'channel_delivery' }] },
    });
    missions.recordReceipt({
      workspaceId: ctx.workspace.id, missionId: mission.id, kind: 'channel_delivery',
      providerMessageId: 'wamid.owner-action', providerStatus: 'accepted', acknowledged: true,
      idempotencyKey: 'owner-action:1',
    });
    const notifySettlement = vi.fn().mockResolvedValue(undefined);
    const driver = new AgentMissionDriver({} as never, {
      db: ctx.db, missions, logger: ctx.logger, notifySettlement,
      wakeAgent: vi.fn().mockResolvedValue({ reply: '' }),
    });

    await driver.handler({ entity: { workspaceId: ctx.workspace.id, key: mission.id }, inbox: [] } as never);

    expect(notifySettlement).toHaveBeenCalledOnce();
    const settled = notifySettlement.mock.calls[0]![0];
    expect(settled.status).toBe('accomplished');
    expect(missionSettlementMessage(settled)).toContain('Concluído e verificado');
    expect(missionSettlementMessage(settled)).toContain('wamid.owner-action');
  });

  it('opens a fresh configured execution budget when an operator resumes a blocked mission', () => {
    const agentId = seedAgent();
    const missions = new AgentMissionService(ctx.db, ctx.bus);
    const mission = missions.create({
      workspaceId: ctx.workspace.id, ownerAgentId: agentId, sourceKind: 'channel', sourceRef: 'owner-conversation',
      objective: 'Envie uma mensagem.', outcomeContract: { requiredEffects: [{ kind: 'channel_delivery' }] }, maxAttempts: 2,
    });
    missions.start(ctx.workspace.id, mission.id);
    missions.start(ctx.workspace.id, mission.id);
    const blocked = missions.block(ctx.workspace.id, mission.id, { code: 'NO_VERIFIED_EFFECT_PATH', detail: '2/2 exhausted', recoverable: true });
    expect(blocked.attemptCount).toBe(2);
    expect(missionSettlementMessage(blocked)).toContain('sem nenhuma confirmação verificável');
    expect(missionSettlementMessage(blocked)).not.toContain('NO_VERIFIED_EFFECT_PATH');

    const resumed = missions.resume(ctx.workspace.id, mission.id, 'Tente novamente');
    expect(resumed).toMatchObject({ status: 'queued', attemptCount: 0, lastProgress: 'Tente novamente' });
    expect(resumed.planVersion).toBe(blocked.planVersion + 1);
  });
});
