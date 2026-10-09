import { describe, expect, it } from 'vitest';
import { extractMarkerToolCalls } from '../../src/adapters/markerToolProtocol.js';

describe('markerToolProtocol compatibility', () => {
  it('normalizes the canonical marker', () => {
    const result = extractMarkerToolCalls('Working now.\nAGENTIS_TOOL_CALL {"name":"agentis.data.query","arguments":{"limit":1}}');
    expect(result.calls).toEqual([{ name: 'agentis.data.query', args: { limit: 1 } }]);
    expect(result.cleaned).toBe('Working now.');
  });

  it('normalizes Hermes tool_call XML', () => {
    const result = extractMarkerToolCalls('<tool_call>{"name":"agentis.channel.inbox","arguments":{"selector":"last_inbound"}}</tool_call>');
    expect(result.calls[0]).toEqual({ name: 'agentis.channel.inbox', args: { selector: 'last_inbound' } });
    expect(result.cleaned).toBe('');
  });

  it('normalizes REQUESTED TOOLS transcripts', () => {
    const result = extractMarkerToolCalls('REQUESTED TOOLS: [{"id":"x","name":"agentis.capability.search","arguments":{"intent":"send whatsapp"}}]');
    expect(result.calls[0]).toEqual({ name: 'agentis.capability.search', args: { intent: 'send whatsapp' } });
    expect(result.cleaned).toBe('');
  });

  it('normalizes Hermes native special-token tool blocks', () => {
    const result = extractMarkerToolCalls([
      'Found the saved script. Sending now.',
      '<tool_call>',
      '</｜tool▁calls_begin｜>',
      'agentis.brain.search {"query":"Acme script","kind":"all","limit":10}',
      'agentis.channel.send {"kind":"whatsapp","to":"+15551234567","body":"Olá!"}',
      '<｜tool▁calls_end｜>',
      '</｜tool_calls｜>',
    ].join('\n'));

    expect(result.cleaned).toBe('Found the saved script. Sending now.');
    expect(result.calls).toEqual([
      { name: 'agentis.brain.search', args: { query: 'Acme script', kind: 'all', limit: 10 } },
      { name: 'agentis.channel.send', args: { kind: 'whatsapp', to: '+15551234567', body: 'Olá!' } },
    ]);
  });

  it('normalizes Hermes nested XML calls even when the outer wrapper is unclosed', () => {
    const result = extractMarkerToolCalls([
      'Vou buscar esse contato no inbox e enviar a mensagem agora.',
      '<tool_call>',
      '<agentis.channel.inbox>',
      '<args>',
      '<connectionId>7d49671e-c831-496e-9ad8-7f897646c991</connectionId>',
      '<kind>whatsapp</kind>',
      '<query>+15551234567</query>',
      '</args>',
      '</agentis.channel.inbox>',
      '<agentis.channel.send>',
      '<args>',
      '<connectionId>7d49671e-c831-496e-9ad8-7f897646c991</connectionId>',
      '<kind>whatsapp</kind>',
      '<to>+15551234567</to>',
      '<body>Oi! Tudo bem? A Acme pode ajudar &amp; vender mais.</body>',
      '<deliveryRole>final</deliveryRole>',
      '</args>',
      '</agentis.channel.send>',
    ].join('\n'));

    expect(result.cleaned).toBe('Vou buscar esse contato no inbox e enviar a mensagem agora.');
    expect(result.calls).toEqual([
      { name: 'agentis.channel.inbox', args: { connectionId: '7d49671e-c831-496e-9ad8-7f897646c991', kind: 'whatsapp', query: '+15551234567' } },
      { name: 'agentis.channel.send', args: { connectionId: '7d49671e-c831-496e-9ad8-7f897646c991', kind: 'whatsapp', to: '+15551234567', body: 'Oi! Tudo bem? A Acme pode ajudar & vender mais.', deliveryRole: 'final' } },
    ]);
  });

  it('normalizes a bare fallback function envelope and a common image alias', () => {
    const result = extractMarkerToolCalls('{"name":"image.generate","arguments":{"prompt":"Acme","size":"1024x1024","n":1}}');
    expect(result.cleaned).toBe('');
    expect(result.calls).toEqual([{
      name: 'agentis.media.generate',
      args: { modality: 'image', prompt: 'Acme', size: '1024x1024', n: 1 },
    }]);
  });

  it('binds bare arguments only when exactly one offered tool schema matches', () => {
    const tools = [{
      name: 'agentis.channel.send',
      description: 'send',
      parameters: {
        type: 'object' as const,
        properties: {
          connectionId: { type: 'string' as const }, kind: { type: 'string' as const },
          to: { type: 'string' as const }, body: { type: 'string' as const },
          deliveryRole: { type: 'string' as const },
        },
        required: ['body'],
      },
    }];
    const result = extractMarkerToolCalls(
      '{"connectionId":"wa-1","kind":"whatsapp","to":"+15551234567","body":"Oi","deliveryRole":"final"}',
      tools,
    );
    expect(result.cleaned).toBe('');
    expect(result.calls).toEqual([{ name: 'agentis.channel.send', args: {
      connectionId: 'wa-1', kind: 'whatsapp', to: '+15551234567', body: 'Oi', deliveryRole: 'final',
    } }]);
  });

  it('leaves an ambiguous bare argument object for protocol repair', () => {
    const tools = ['one', 'two'].map((name) => ({
      name, description: name,
      parameters: { type: 'object' as const, properties: { body: { type: 'string' as const } }, required: ['body'] },
    }));
    const input = '{"body":"Oi"}';
    expect(extractMarkerToolCalls(input, tools)).toEqual({ calls: [], cleaned: input });
  });

  it('leaves malformed calls visible instead of fabricating execution', () => {
    const input = '<tool_call>{not json}</tool_call>';
    expect(extractMarkerToolCalls(input)).toEqual({ calls: [], cleaned: input });
  });
});
