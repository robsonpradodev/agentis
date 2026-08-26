/**
 * extractWhatsAppText — the text extractor ported from OpenClaw's baileys
 * `extract.ts`. Pure function: no socket, no baileys runtime needed.
 */

import { describe, expect, it, vi } from 'vitest';
import { classifyWhatsAppReconnect, extractWhatsAppText, resolveWhatsAppInboundBody, resolveWhatsAppNativeBody, shouldProcessWhatsAppUpsert, unwrapAudioMessage, unwrapImageMessage, unwrapDocumentMessage, whatsappMediaContent, whatsappNativeContent, WhatsAppSession } from '../../src/adapters/channels/whatsappSession.js';
import type { OutboundAttachment } from '../../src/adapters/channels/types.js';
import { createLogger } from '../../src/logger.js';

describe('whatsappMediaContent', () => {
  const base = (kind: OutboundAttachment['kind'], over: Partial<OutboundAttachment> = {}): OutboundAttachment => ({
    kind, filename: `f.${kind}`, mimeType: over.mimeType ?? '', data: Buffer.from('x'), ...over,
  });

  it('builds an image with caption + viewOnce', () => {
    const c = whatsappMediaContent(base('image', { viewOnce: true }), 'hi');
    expect(c.image).toBeInstanceOf(Buffer);
    expect(c.caption).toBe('hi');
    expect(c.viewOnce).toBe(true);
  });

  it('builds a video with gifPlayback', () => {
    const c = whatsappMediaContent(base('video', { gifPlayback: true, seconds: 3 }), 'clip');
    expect(c.video).toBeInstanceOf(Buffer);
    expect(c.gifPlayback).toBe(true);
    expect(c.seconds).toBe(3);
    expect(c.caption).toBe('clip');
  });

  it('builds a voice note as ptt audio with an opus default mimetype', () => {
    const c = whatsappMediaContent(base('voice'));
    expect(c.audio).toBeInstanceOf(Buffer);
    expect(c.ptt).toBe(true);
    expect(c.mimetype).toContain('opus');
  });

  it('builds an audio track (not ptt)', () => {
    const c = whatsappMediaContent(base('audio', { mimeType: 'audio/mpeg' }));
    expect(c.audio).toBeInstanceOf(Buffer);
    expect(c.ptt).toBeUndefined();
    expect(c.mimetype).toBe('audio/mpeg');
  });

  it('builds a sticker (no caption)', () => {
    const c = whatsappMediaContent(base('sticker'), 'ignored');
    expect(c.sticker).toBeInstanceOf(Buffer);
    expect(c.caption).toBeUndefined();
  });

  it('builds a document with filename + caption, falling back to per-attachment caption', () => {
    const c = whatsappMediaContent(base('file', { filename: 'report.pdf', mimeType: 'application/pdf', caption: 'q3' }));
    expect(c.document).toBeInstanceOf(Buffer);
    expect(c.fileName).toBe('report.pdf');
    expect(c.caption).toBe('q3');
  });
});

describe('whatsappNativeContent', () => {
  it('builds provider-native location, contact, and poll messages', () => {
    expect(whatsappNativeContent({ kind: 'location', latitude: -19.9, longitude: -43.9, name: 'Talki' }))
      .toMatchObject({ location: { degreesLatitude: -19.9, degreesLongitude: -43.9, name: 'Talki' } });
    expect(whatsappNativeContent({ kind: 'contact', displayName: 'Bia', phone: '+5531999999999' }).contacts.contacts[0].vcard)
      .toContain('TEL;TYPE=CELL:+5531999999999');
    expect(whatsappNativeContent({ kind: 'poll', question: 'Choose', options: ['A', 'B'] }))
      .toEqual({ poll: { name: 'Choose', values: ['A', 'B'], selectableCount: 1 } });
  });
});

describe('resolveWhatsAppInboundBody', () => {
  it('describes an image even when it already has a caption', async () => {
    const body = await resolveWhatsAppInboundBody(
      { message: { imageMessage: { mimetype: 'image/jpeg', caption: 'Sabe o que e isto?' } } },
      {
        downloadMedia: async () => Buffer.from('image'),
        describeImage: async (_bytes, _mime, caption) => `A workflow canvas. Sender asks: ${caption}`,
      },
    );
    expect(body).toContain('Caption: Sabe o que e isto?');
    expect(body).toContain('Visual analysis: A workflow canvas.');
  });

  it('keeps a voice note actionable when transcription is unavailable', async () => {
    const body = await resolveWhatsAppInboundBody({ message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus' } } });
    expect(body).toContain('Voice note received');
    expect(body).toContain('Transcription is unavailable');
  });

  it('passes a downloaded voice note to transcription', async () => {
    const body = await resolveWhatsAppInboundBody(
      { message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus' } } },
      {
        downloadMedia: async () => Buffer.from('voice'),
        transcribeAudio: async (bytes, mime) => `${bytes.toString()}:${mime}`,
      },
    );
    expect(body).toBe('[Voice note transcript]\nvoice:audio/ogg; codecs=opus');
  });

  it('downloads media once, persists the original, and analyzes the same image', async () => {
    let downloads = 0;
    const body = await resolveWhatsAppInboundBody(
      { message: { imageMessage: { mimetype: 'image/png', caption: 'inspect' } } },
      {
        downloadMedia: async () => { downloads += 1; return Buffer.from('pixels'); },
        persistMedia: async (media) => `artifact:${media.bytes.toString()}-${media.filename}`,
        describeImage: async (bytes) => `saw ${bytes.toString()}`,
      },
    );
    expect(downloads).toBe(1);
    expect(body).toContain('Attachment: artifact:pixels-image.png');
    expect(body).toContain('Visual analysis: saw pixels');
  });

  it('preserves videos, GIF playback and stickers as reusable attachments', async () => {
    const persistMedia = async (media: { kind: string }) => `artifact:${media.kind}`;
    await expect(resolveWhatsAppInboundBody(
      { message: { videoMessage: { mimetype: 'video/mp4', gifPlayback: true } } },
      { downloadMedia: async () => Buffer.from('gif'), persistMedia },
    )).resolves.toContain('[Animated GIF received]');
    await expect(resolveWhatsAppInboundBody(
      { message: { stickerMessage: { mimetype: 'image/webp' } } },
      { downloadMedia: async () => Buffer.from('sticker'), persistMedia },
    )).resolves.toContain('Attachment: artifact:sticker');
  });

  it('understands a received video through its provider thumbnail while preserving the full clip', async () => {
    const body = await resolveWhatsAppInboundBody(
      { message: { videoMessage: { mimetype: 'video/mp4', jpegThumbnail: Buffer.from('frame') } } },
      {
        downloadMedia: async () => Buffer.from('full-video'),
        persistMedia: async () => 'artifact:video',
        describeImage: async (bytes) => `preview ${bytes.toString()}`,
      },
    );
    expect(body).toContain('Attachment: artifact:video');
    expect(body).toContain('Preview-frame analysis: preview frame');
  });
});

describe('resolveWhatsAppNativeBody', () => {
  it('normalizes location, contact, poll, and reaction payloads', () => {
    expect(resolveWhatsAppNativeBody({ locationMessage: { degreesLatitude: -19.9, degreesLongitude: -43.9, name: 'Talki' } }))
      .toContain('https://maps.google.com/?q=-19.9,-43.9');
    expect(resolveWhatsAppNativeBody({ contactMessage: { displayName: 'Bia', vcard: 'TEL:+5531999999999' } }))
      .toContain('TEL:+5531999999999');
    expect(resolveWhatsAppNativeBody({ pollCreationMessage: { name: 'Choose', options: [{ optionName: 'A' }, { optionName: 'B' }] } }))
      .toContain('2. B');
    expect(resolveWhatsAppNativeBody({ reactionMessage: { text: '👍', key: { id: 'm1' } } }))
      .toContain('message m1');
  });
});

describe('classifyWhatsAppReconnect', () => {
  it('uses stable, reason-specific recovery classes without exposing provider details to chat', () => {
    expect(classifyWhatsAppReconnect(408)).toBe('connection_lost');
    expect(classifyWhatsAppReconnect(440)).toBe('session_conflict');
    expect(classifyWhatsAppReconnect(503)).toBe('service_unavailable');
    expect(classifyWhatsAppReconnect(515)).toBe('restart_required');
    expect(classifyWhatsAppReconnect(undefined)).toBe('connection_closed');
  });
});

describe('WhatsAppSession startup state', () => {
  it('reports connecting before a slow WhatsApp Web version lookup completes', () => {
    let resolveVersion!: (value: { version: [number, number, number] }) => void;
    const versionLookup = new Promise<{ version: [number, number, number] }>((resolve) => { resolveVersion = resolve; });
    const session = new WhatsAppSession({
      connectionId: 'wa-slow-start', authDir: '.', logger: createLogger({ level: 'error' }),
      onInbound: () => {},
      baileysModule: { fetchLatestBaileysVersion: () => versionLookup },
    });

    void session.start();

    expect(session.status).toBe('connecting');
    resolveVersion({ version: [2, 3000, 1] });
  });
});

describe('shouldProcessWhatsAppUpsert', () => {
  it('keeps append events in silent history reconciliation rather than the live turn path', () => {
    expect(shouldProcessWhatsAppUpsert('notify', false)).toBe(true);
    expect(shouldProcessWhatsAppUpsert('append', true)).toBe(false);
    expect(shouldProcessWhatsAppUpsert('append', false)).toBe(false);
  });
});

describe('WhatsAppSession bounded history events', () => {
  it('reconciles a mocked reverse bootstrap chunk silently and oldest-to-newest', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const socket = {
      ev: { on: (name: string, listener: (event: unknown) => void) => { listeners.set(name, listener); } },
      user: { id: 'self@s.whatsapp.net' },
      end: () => {},
      updateMediaMessage: async () => {},
      sendMessage: async () => ({ key: { id: 'local' } }),
      sendPresenceUpdate: async () => {},
    };
    const history: Array<{ externalId: string; body: string; participantSide: string; occurredAt: string }> = [];
    const inbound = vi.fn();
    const outbound = vi.fn();
    const session = new WhatsAppSession({
      connectionId: 'wa-test', authDir: '.', logger: createLogger({ level: 'error' }),
      onInbound: inbound,
      onOutboundObserved: outbound,
      onHistoryReconciled: (messages) => { history.push(...messages); },
      persistMedia: async () => 'artifact:manual-media',
      loadAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
      baileysModule: {
        makeWASocket: () => socket,
        useMultiFileAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
        fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
        makeCacheableSignalKeyStore: (keys: unknown) => keys,
        DisconnectReason: { loggedOut: 401 },
        Browsers: { appropriate: () => ['Agentis', 'Chrome', '1.0.0'] },
        downloadMediaMessage: async () => Buffer.from('image'),
      },
    });
    await session.start();
    listeners.get('messaging-history.set')?.({
      isLatest: true,
      messages: [
        { key: { id: 'm3', remoteJid: '5511@s.whatsapp.net', fromMe: false }, messageTimestamp: 3, message: { conversation: 'customer reply' } },
        { key: { id: 'm2', remoteJid: '5511@s.whatsapp.net', fromMe: true }, messageTimestamp: 2, message: { conversation: 'business promise' } },
        { key: { id: 'm1', remoteJid: '5511@s.whatsapp.net', fromMe: false }, messageTimestamp: 1, message: { conversation: 'customer opener' } },
      ],
    });
    await vi.waitFor(() => expect(history).toHaveLength(3));
    expect(history.map((item) => [item.externalId, item.participantSide, item.body])).toEqual([
      ['m1', 'customer', 'customer opener'],
      ['m2', 'business', 'business promise'],
      ['m3', 'customer', 'customer reply'],
    ]);
    expect(inbound).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();

    listeners.get('messages.upsert')?.({
      type: 'append',
      messages: [{
        key: { id: 'manual-image', remoteJid: '187654321098765@lid', remoteJidAlt: '5511:7@s.whatsapp.net', fromMe: true },
        messageTimestamp: Math.floor(Date.now() / 1_000),
        message: { imageMessage: { caption: 'manual photo', mimetype: 'image/jpeg' } },
      }],
    });
    await vi.waitFor(() => expect(outbound).toHaveBeenCalledTimes(1));
    expect(outbound).toHaveBeenCalledWith(expect.objectContaining({
      externalId: 'manual-image',
      chatId: '5511@s.whatsapp.net',
      alternateChatIds: ['187654321098765@lid'],
      attachmentIds: ['manual-media'],
    }));
    expect(outbound.mock.calls[0]?.[0]?.body).toContain('manual photo');
    await session.stop();
  });

  it('correlates an Agentis echo even when Baileys emits it before sendMessage resolves', async () => {
    const listeners = new Map<string, (event: any) => void>();
    let resolveSend!: (value: unknown) => void;
    const socket = {
      ev: { on: (name: string, listener: (event: any) => void) => { listeners.set(name, listener); } },
      user: { id: 'self@s.whatsapp.net' },
      end: () => {},
      updateMediaMessage: async () => {},
      sendMessage: () => new Promise((resolve) => { resolveSend = resolve; }),
      sendPresenceUpdate: async () => {},
    };
    const outbound = vi.fn();
    const session = new WhatsAppSession({
      connectionId: 'wa-echo-race', authDir: '.', logger: createLogger({ level: 'error' }),
      onInbound: vi.fn(),
      onOutboundObserved: outbound,
      loadAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
      baileysModule: {
        makeWASocket: () => socket,
        useMultiFileAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
        fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
        makeCacheableSignalKeyStore: (keys: unknown) => keys,
        DisconnectReason: { loggedOut: 401 },
        Browsers: { appropriate: () => ['Agentis', 'Chrome', '1.0.0'] },
        downloadMediaMessage: async () => Buffer.from(''),
      },
    });
    await session.start();
    listeners.get('connection.update')?.({ connection: 'open' });

    const send = session.sendText('5511@s.whatsapp.net', 'Agentis reply');
    listeners.get('messages.upsert')?.({
      type: 'append',
      messages: [{
        key: { id: 'agentis-provider-id', remoteJid: '5511@s.whatsapp.net', fromMe: true },
        messageTimestamp: Math.floor(Date.now() / 1_000),
        message: { conversation: 'Agentis reply' },
      }],
    });
    resolveSend({ key: { id: 'agentis-provider-id', remoteJid: '5511@s.whatsapp.net' }, status: 2 });
    await send;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(outbound).not.toHaveBeenCalled();
    await session.stop();
  });
});

describe('extractWhatsAppText', () => {
  it('reads a plain conversation message', () => {
    expect(extractWhatsAppText({ conversation: 'hello there' })).toBe('hello there');
  });

  it('reads extendedTextMessage text', () => {
    expect(extractWhatsAppText({ extendedTextMessage: { text: 'with link https://x.com' } }))
      .toBe('with link https://x.com');
  });

  it('reads an image caption', () => {
    expect(extractWhatsAppText({ imageMessage: { caption: 'look at this' } })).toBe('look at this');
  });

  it('unwraps ephemeral wrappers', () => {
    expect(extractWhatsAppText({ ephemeralMessage: { message: { conversation: 'secret' } } })).toBe('secret');
  });

  it('unwraps viewOnce wrappers', () => {
    expect(extractWhatsAppText({ viewOnceMessageV2: { message: { extendedTextMessage: { text: 'once' } } } })).toBe('once');
  });

  it('returns undefined for non-text / empty messages', () => {
    expect(extractWhatsAppText(undefined)).toBeUndefined();
    expect(extractWhatsAppText({})).toBeUndefined();
    expect(extractWhatsAppText({ audioMessage: { seconds: 3 } })).toBeUndefined();
    expect(extractWhatsAppText({ conversation: '   ' })).toBeUndefined();
  });
});

describe('unwrapAudioMessage', () => {
  it('finds an audio message directly and through wrappers', () => {
    expect(unwrapAudioMessage({ audioMessage: { mimetype: 'audio/ogg' } })?.mimetype).toBe('audio/ogg');
    expect(unwrapAudioMessage({ ephemeralMessage: { message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus' } } } })?.mimetype)
      .toBe('audio/ogg; codecs=opus');
  });

  it('returns undefined when there is no audio', () => {
    expect(unwrapAudioMessage({ conversation: 'hi' })).toBeUndefined();
    expect(unwrapAudioMessage(undefined)).toBeUndefined();
  });
});

describe('unwrapImageMessage', () => {
  it('finds an image directly, through wrappers, and image-mime documents', () => {
    expect(unwrapImageMessage({ imageMessage: { mimetype: 'image/jpeg', caption: 'hi' } })?.caption).toBe('hi');
    expect(unwrapImageMessage({ ephemeralMessage: { message: { imageMessage: { mimetype: 'image/png' } } } })?.mimetype).toBe('image/png');
    expect(unwrapImageMessage({ documentMessage: { mimetype: 'image/webp' } })?.mimetype).toBe('image/webp');
  });

  it('ignores non-image documents and text', () => {
    expect(unwrapImageMessage({ documentMessage: { mimetype: 'application/pdf' } })).toBeUndefined();
    expect(unwrapImageMessage({ conversation: 'hi' })).toBeUndefined();
  });
});

describe('unwrapDocumentMessage', () => {
  it('finds non-image documents (incl. through wrappers) and ignores images', () => {
    expect(unwrapDocumentMessage({ documentMessage: { mimetype: 'application/pdf', fileName: 'r.pdf' } })?.fileName).toBe('r.pdf');
    expect(unwrapDocumentMessage({ ephemeralMessage: { message: { documentMessage: { mimetype: 'text/plain' } } } })?.mimetype).toBe('text/plain');
    // An image-mime document is handled by the image path, not here.
    expect(unwrapDocumentMessage({ documentMessage: { mimetype: 'image/png' } })).toBeUndefined();
    expect(unwrapDocumentMessage({ conversation: 'hi' })).toBeUndefined();
  });
});
