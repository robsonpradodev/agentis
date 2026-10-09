import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { DurableSuspensionService } from '../../src/services/suspension/durableSuspensionService.js';
import { ChannelAskSuspensionPresenter } from '../../src/services/suspension/channelAskPresenter.js';
import { channelCorrelationId } from '../../src/services/subjectRuntime.js';

let ctx: TestContext;
const AGENT_ID = 'agent-otto';
const CONNECTION_ID = 'connection-team-whatsapp';
const TEAM_ADDRESS = '5531988887777';

beforeEach(async () => {
  ctx = await createTestContext();
  ctx.db.insert(schema.agents).values({ id: AGENT_ID, workspaceId: ctx.workspace.id, userId: ctx.user.id, name: 'Otto', adapterType: 'http' }).run();
});
afterEach(() => ctx.close());

/** Build the presenter with the send pipeline and inbox stubbed — the unit under test is the presenter's own contract, not channel delivery. */
function build() {
  const suspensions = new DurableSuspensionService({ db: ctx.db, logger: ctx.logger });
  const createAndExecute = vi.fn(async () => ({ action: { id: 'action-1' } }) as never);
  const inboxGet = vi.fn().mockReturnValue({ peerIdentityId: 'peer-team', connectionId: CONNECTION_ID, channelKind: 'whatsapp' });
  const preferredAddress = vi.fn().mockReturnValue(TEAM_ADDRESS);
  const presenter = new ChannelAskSuspensionPresenter({
    channelActions: { createAndExecute } as never,
    inbox: { get: inboxGet, preferredAddress } as never,
    suspensions,
    logger: ctx.logger,
  });
  suspensions.registerPresenter('channel_ask', presenter);
  return { suspensions, presenter, createAndExecute, inboxGet, preferredAddress };
}

describe('ChannelAskSuspensionPresenter', () => {
  it('delivers the question through the resolved channel thread and awaits that exact correlation', async () => {
    const { suspensions, createAndExecute } = build();
    const resume = vi.fn(async () => undefined);
    suspensions.registerResumer('channel_turn', { resume });

    const result = await suspensions.suspend({
      workspaceId: ctx.workspace.id,
      ownerAgentId: AGENT_ID,
      requesterUserId: ctx.user.id,
      origin: { type: 'channel_turn', id: 'turn-1' },
      condition: { type: 'channel_ask', payload: { recipientRef: 'peer:team', prompt: 'Posso liberar 20% de desconto para o lead da Acme?' } },
      audience: { type: 'channel_thread' },
      reason: 'Precisa da aprovação do time comercial antes de confirmar o desconto.',
      publicReceipt: 'Deixa eu confirmar com o time e já te retorno.',
      continuation: { conversationId: 'conv-customer-1' },
    });

    expect(result.state).toBe('waiting');
    expect(result.publicReceipt).toBe('Deixa eu confirmar com o time e já te retorno.');
    // The message actually went out through the durable channel action pipeline,
    // as the operating agent, addressed to the resolved team recipient.
    expect(createAndExecute).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: ctx.workspace.id,
      agentId: AGENT_ID,
      connectionId: CONNECTION_ID,
      recipientRef: 'peer:team',
      body: 'Posso liberar 20% de desconto para o lead da Acme?',
    }));
    const stored = suspensions.get(ctx.workspace.id, result.suspensionId)!;
    expect(stored.presentationRef).toBe(channelCorrelationId(CONNECTION_ID, TEAM_ADDRESS));
  });

  it('resumes the original conversation the moment the team replies in that exact thread', async () => {
    const { suspensions, presenter } = build();
    const resume = vi.fn(async () => undefined);
    suspensions.registerResumer('channel_turn', { resume });

    const result = await suspensions.suspend({
      workspaceId: ctx.workspace.id,
      ownerAgentId: AGENT_ID,
      origin: { type: 'channel_turn', id: 'turn-2' },
      condition: { type: 'channel_ask', payload: { recipientRef: 'peer:team', prompt: 'Pode confirmar o prazo de entrega de 5 dias?' } },
      audience: { type: 'channel_thread' },
      reason: 'Precisa confirmar prazo com o time de logística.',
      continuation: { conversationId: 'conv-customer-2' },
    });
    expect(resume).not.toHaveBeenCalled();

    // A reply on a DIFFERENT thread must not resolve anything.
    expect(await presenter.resolveInbound({ workspaceId: ctx.workspace.id, connectionId: CONNECTION_ID, chatId: 'someone-else', text: 'oi' })).toBe(false);
    expect(resume).not.toHaveBeenCalled();

    // The team's reply, in the thread the question actually went to, resolves it —
    // a plain human answering a WhatsApp message, nothing more.
    const matched = await presenter.resolveInbound({ workspaceId: ctx.workspace.id, connectionId: CONNECTION_ID, chatId: TEAM_ADDRESS, text: 'pode confirmar sim, 5 dias está ok', from: 'Marina' });
    expect(matched).toBe(true);

    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]![1]).toEqual({ conversationId: 'conv-customer-2' });
    const resolved = suspensions.get(ctx.workspace.id, result.suspensionId)!;
    expect(resolved.resolution).toMatchObject({ kind: 'channel_reply', data: { text: 'pode confirmar sim, 5 dias está ok', from: 'Marina' } });

    // Idempotent: a second inbound message on an already-resolved thread does not match again.
    expect(await presenter.resolveInbound({ workspaceId: ctx.workspace.id, connectionId: CONNECTION_ID, chatId: TEAM_ADDRESS, text: 'mais uma coisa' })).toBe(false);
  });

  it('ignores an empty inbound and never throws — best-effort by contract', async () => {
    const { presenter } = build();
    await expect(presenter.resolveInbound({ workspaceId: ctx.workspace.id, connectionId: CONNECTION_ID, chatId: TEAM_ADDRESS, text: '' })).resolves.toBe(false);
  });

  it('refuses an audience other than channel_thread', async () => {
    const { suspensions } = build();
    await expect(suspensions.suspend({
      workspaceId: ctx.workspace.id,
      ownerAgentId: AGENT_ID,
      origin: { type: 'channel_turn', id: 'turn-3' },
      condition: { type: 'channel_ask', payload: { recipientRef: 'peer:team', prompt: 'oi' } },
      audience: { type: 'workspace_role', target: 'operator' },
      reason: 'test',
    })).rejects.toThrow(/channel_thread/);
  });
});
