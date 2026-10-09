import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppStore } from '@agentis/app';
import { schema } from '@agentis/db/sqlite';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { DurableEntityService } from '../../src/services/durableEntities.js';
import { ChannelIdentityService } from '../../src/services/conversation/channelIdentityService.js';
import { RelationshipStateService } from '../../src/services/relationshipStateService.js';
import { AppContactService } from '../../src/services/app/appContacts.js';
import { ChannelUtteranceBatchStore } from '../../src/services/conversation/channelUtteranceBatchStore.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(() => ctx.close());

describe('relationship runtime E2E', () => {
  it('assembles split bubbles, grounds an external principal, and restores one durable relationship', () => {
    const agentId = randomUUID();
    ctx.db
      .insert(schema.agents)
      .values({
        id: agentId,
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        name: 'Ava',
        adapterType: 'http',
      })
      .run();
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Sales' }).id;
    const connectionId = randomUUID();
    ctx.db
      .insert(schema.channelConnections)
      .values({
        id: connectionId,
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        agentId,
        appId,
        kind: 'whatsapp',
        name: 'Sales line',
        tokenEncrypted: 'test',
      })
      .run();
    const conversationId = randomUUID();
    ctx.db
      .insert(schema.conversations)
      .values({
        id: conversationId,
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        agentId,
        appId,
        channelConnectionId: connectionId,
        channelChatId: '55110001',
      })
      .run();

    const batches = new ChannelUtteranceBatchStore(ctx.db);
    const base = {
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      appId,
      conversationId,
      connectionId,
      kind: 'whatsapp',
      chatId: '55110001',
    };
    batches.append({ ...base, text: 'I need a plan', inboundMessageId: 'm1' }, 0);
    const combined = batches.append({ ...base, text: 'for September', inboundMessageId: 'm2' }, 0);
    const due = batches.claimDue(new Date(Date.now() + 1_000).toISOString());
    expect(due).toHaveLength(1);
    expect(due[0]?.input.text).toBe('I need a plan\nfor September');
    expect(due[0]?.messageIds).toEqual(['m1', 'm2']);

    const contacts = new AppContactService(ctx.db);
    const contactId = contacts.touch({
      workspaceId: ctx.workspace.id,
      appId,
      channelKind: 'whatsapp',
      handle: '55110001',
    });
    const identities = new ChannelIdentityService({ db: ctx.db, logger: ctx.logger });
    const relationships = new RelationshipStateService({
      db: ctx.db,
      entities: new DurableEntityService(ctx.db),
      identities,
    });
    const first = relationships.touch({
      workspaceId: ctx.workspace.id,
      appId,
      connectionId,
      channelKind: 'whatsapp',
      handle: '55110001',
      conversationId,
      contactId,
      inboundText: combined.input.text,
    });
    const restored = relationships.touch({
      workspaceId: ctx.workspace.id,
      appId,
      connectionId,
      channelKind: 'whatsapp',
      handle: '55110001',
      conversationId,
      contactId,
    });
    expect(restored.subject.id).toBe(first.subject.id);
    expect(contacts.get(ctx.workspace.id, contactId)?.subjectId).toBe(first.subject.id);
    expect(restored.state.engagements[0]).toMatchObject({ id: `app:${appId}`, status: 'active' });
    expect(relationships.contextBlock(first.subject.id)).toContain('DURABLE RELATIONSHIP STATE');
    const now = new Date().toISOString();
    const yesterday = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const tomorrow = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    new DurableEntityService(ctx.db).upsert({
      workspaceId: ctx.workspace.id,
      kind: 'subject',
      key: first.subject.key,
      state: {
        facts: [
          {
            key: 'preferred_period',
            value: 'à tarde',
            confidence: 0.95,
            source: 'contact',
            observedAt: now,
            lastConfirmedAt: now,
          },
          {
            key: 'old_availability',
            value: 'terça de manhã',
            confidence: 0.8,
            source: 'agent',
            observedAt: yesterday,
            lastConfirmedAt: yesterday,
            expiresAt: yesterday,
          },
        ],
        commitments: [
          {
            id: 'quote-1',
            text: 'enviar o orçamento revisado',
            owner: 'agent',
            status: 'open',
            dueAt: tomorrow,
            createdAt: now,
          },
        ],
        blockers: ['Aguardando preço atualizado.'],
        decisionHistory: [
          {
            id: 'decision-1',
            evaluatedAt: now,
            trigger: 'inbound',
            outcome: 'no_action',
            relatedEventIds: ['event-1'],
            reason: 'A pessoa pediu para receber o orçamento amanhã.',
          },
        ],
      },
    });
    const continuityBlock = relationships.contextBlock(first.subject.id)!;
    expect(continuityBlock).toContain('preferred_period: à tarde');
    expect(continuityBlock).toContain('origem contact');
    expect(continuityBlock).not.toContain('old_availability');
    expect(continuityBlock).toContain('enviar o orçamento revisado');
    expect(continuityBlock).toContain('Aguardando preço atualizado.');
    expect(continuityBlock).toContain('A pessoa pediu para receber o orçamento amanhã.');
    const dueAt = '2099-09-01T12:00:00.000Z';
    contacts.update(ctx.workspace.id, contactId, {
      stage: 'qualified',
      goal: 'close the September plan',
      nextTouchAt: dueAt,
    });
    const armed = new DurableEntityService(ctx.db).get(first.subject.id)!;
    expect(armed.nextWakeAt).toBe(dueAt);
    expect(
      (armed.stateJson as { nextAction?: { kind: string; goal: string } }).nextAction,
    ).toMatchObject({ kind: 'follow_up', goal: 'close the September plan' });
  });
});
