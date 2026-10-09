import { describe, expect, it } from 'vitest';
import { channelCapabilities } from '../../src/adapters/channels/channelCapabilities.js';

describe('channel capability contract', () => {
  it('advertises only WhatsApp actions available on the selected transport', () => {
    const qr = channelCapabilities('whatsapp', { whatsappMode: 'qr_local' });
    expect(qr).toMatchObject({
      supportsReplyQuote: true,
      supportsPoll: true,
      supportsPresence: true,
      supportsReadReceipts: true,
      readReceiptPolicy: 'automatic',
      presenceManagedByTurn: true,
      presenceStopsOnCancel: true,
    });
    expect(qr.mediaKinds).toEqual(expect.arrayContaining(['image', 'video', 'voice', 'sticker', 'file']));

    const cloudManual = channelCapabilities('whatsapp', {
      whatsappMode: 'cloud', whatsappGraphVersion: 'v23.0', readReceiptPolicy: 'manual',
    });
    expect(cloudManual).toMatchObject({
      providerApiVersion: 'v23.0',
      supportsTemplates: true,
      supportsInteractiveButtons: true,
      supportsInteractiveLists: true,
      supportsReplyQuote: false,
      supportsPoll: false,
      supportsPresence: false,
      presenceModes: [],
      readReceiptPolicy: 'manual',
    });

    const cloudAutomatic = channelCapabilities('whatsapp', {
      whatsappMode: 'cloud', readReceiptPolicy: 'automatic',
    });
    expect(cloudAutomatic).toMatchObject({ supportsPresence: true, presenceModes: ['typing'] });
    expect(channelCapabilities('telegram').supportsReplyQuote).toBe(false);
  });
});
