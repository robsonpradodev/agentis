import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@agentis/core';
import { messagesForRuntimeSession } from '../../src/adapters/cliChatRuntime.js';

describe('messagesForRuntimeSession', () => {
  it('forwards the newest caller-loop tool results instead of replaying the user request', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are Ava.' },
      { role: 'user', content: 'Send the proposal over WhatsApp.' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'agentis.channel.send', arguments: { to: '+15551234567', body: 'Olá' } }] },
      { role: 'tool', toolCallId: 'call-1', content: '{"sent":false,"errorCode":"CHANNEL_PROVIDER_REJECTED","error":"connection offline"}' },
    ];

    expect(messagesForRuntimeSession(messages, true)).toEqual([
      messages[0],
      messages[3],
    ]);
  });

  it('sends the latest user message when a resumed session starts a new turn', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are Ava.' },
      { role: 'user', content: 'Earlier request.' },
      { role: 'assistant', content: 'Earlier answer.' },
      { role: 'user', content: 'New request.' },
    ];
    expect(messagesForRuntimeSession(messages, true)).toEqual([messages[0], messages[3]]);
  });
});
