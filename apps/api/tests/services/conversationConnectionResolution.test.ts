import { describe, expect, it } from 'vitest';
import type { AgentisToolContext } from '@agentis/core';
import { resolveConversationConnectionId } from '../../src/services/agentisToolHandlers/conversation.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';

function context(overrides: Partial<AgentisToolContext> = {}): AgentisToolContext {
  return {
    workspaceId: 'workspace-1',
    userId: 'user-1',
    caller: 'workflow',
    ...overrides,
  };
}

function depsWithConnections(connections: Array<Record<string, unknown>>): ToolHandlerDeps {
  return {
    channels: { list: () => connections },
  } as unknown as ToolHandlerDeps;
}

describe('conversation connection resolution', () => {
  const outreacher = {
    id: 'outreacher-whatsapp',
    status: 'active',
    kind: 'whatsapp',
    agentId: 'sample-outreacher',
    appId: null,
    isDefault: false,
  };
  const attendant = {
    id: 'attendant-whatsapp',
    status: 'active',
    kind: 'whatsapp',
    agentId: 'sample-attendant',
    appId: null,
    isDefault: false,
  };

  it('selects the executing agent own channel when the workspace has multiple active WhatsApp accounts', () => {
    const resolved = resolveConversationConnectionId(
      { kind: 'whatsapp' },
      depsWithConnections([outreacher, attendant]),
      context({ agentId: 'sample-outreacher', appId: 'sample-outbound' }),
    );

    expect(resolved).toBe('outreacher-whatsapp');
  });

  it('keeps an inbound conversation on its exact originating connection', () => {
    const resolved = resolveConversationConnectionId(
      {},
      depsWithConnections([outreacher, attendant]),
      context({
        agentId: 'sample-outreacher',
        channelOrigin: {
          kind: 'whatsapp',
          connectionId: 'attendant-whatsapp',
          chatId: 'contact',
          ownerVerified: false,
        },
      }),
    );

    expect(resolved).toBe('attendant-whatsapp');
  });
});
