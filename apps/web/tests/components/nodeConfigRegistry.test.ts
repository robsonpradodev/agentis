import { describe, expect, it } from 'vitest';
import { PALETTE_NODES } from '../../src/components/canvas/NodePalette';
import {
  NODE_CONFIG_META,
  evaluateNodeReadiness,
  type IntegrationManifestLite,
} from '../../src/components/canvas/nodeConfigRegistry';

const integrations: IntegrationManifestLite[] = [
  {
    service: 'slack',
    name: 'Slack',
    operations: ['send_message'],
    credentialSchema: { type: 'bearer_token', fields: ['token'] },
  },
  {
    service: 'rss_feed',
    name: 'RSS feed',
    operations: ['fetch_feed'],
    credentialSchema: { type: 'none', fields: [] },
  },
];

describe('node config registry', () => {
  it('covers every node exposed in the palette', () => {
    expect(PALETTE_NODES.filter((node) => !NODE_CONFIG_META[node.type])).toEqual([]);
  });

  it('requires vault credentials only for integrations whose manifest needs auth', () => {
    expect(evaluateNodeReadiness({
      kind: 'integration',
      integrationId: 'rss_feed',
      operationId: 'fetch_feed',
    }, { integrations })).toEqual({ ready: true, message: null });

    expect(evaluateNodeReadiness({
      kind: 'integration',
      integrationId: 'slack',
      operationId: 'send_message',
    }, { integrations })).toEqual({
      ready: false,
      message: 'Bind a Slack credential.',
    });

    expect(evaluateNodeReadiness({
      kind: 'integration',
      integrationId: 'slack',
      operationId: 'send_message',
    }, { integrations, credentialTypes: ['integration_slack'] })).toEqual({ ready: true, message: null });
  });

  it('blocks incomplete cron and persistent-listener triggers', () => {
    expect(evaluateNodeReadiness({
      kind: 'trigger',
      triggerType: 'cron',
    })).toEqual({
      ready: false,
      message: 'Enter a cron schedule.',
    });

    expect(evaluateNodeReadiness({
      kind: 'trigger',
      triggerType: 'cron',
      schedule: '*/3***',
    })).toEqual({
      ready: false,
      message: 'Enter a valid five-field cron expression, for example: */5 * * * *',
    });

    expect(evaluateNodeReadiness({
      kind: 'trigger',
      triggerType: 'cron',
      schedule: '*/3 * * * *',
    })).toEqual({ ready: true, message: null });

    expect(evaluateNodeReadiness({
      kind: 'trigger',
      triggerType: 'cron',
      scheduleRules: [{ expression: '0 9 * * *' }, { expression: '0 18 * * 1-5' }],
    })).toEqual({ ready: true, message: null });

    expect(evaluateNodeReadiness({ kind: 'trigger', triggerType: 'rss_feed', rssFeed: {} }))
      .toEqual({ ready: false, message: 'Enter an RSS feed URL.' });
    expect(evaluateNodeReadiness({ kind: 'trigger', triggerType: 'email_imap', emailImap: {} }))
      .toEqual({ ready: false, message: 'Enter the IMAP host.' });

    expect(evaluateNodeReadiness({
      kind: 'trigger',
      triggerType: 'persistent_listener',
      listenerConfig: {
        source: { kind: 'extension', operationName: 'watch' },
      },
    })).toEqual({
      ready: false,
      message: 'Choose a listener-source extension.',
    });

    expect(evaluateNodeReadiness({
      kind: 'trigger',
      triggerType: 'persistent_listener',
      listenerConfig: {
        source: {
          kind: 'extension',
          extensionId: 'website-watcher',
          operationName: 'watch',
          pollIntervalMs: 60_000,
        },
      },
    })).toEqual({ ready: true, message: null });
  });
});
