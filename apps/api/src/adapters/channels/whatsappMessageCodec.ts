import type { OutboundAttachment, OutboundNativeContent } from './types.js';

export interface WhatsAppMediaContext {
  kind: 'image' | 'video' | 'audio' | 'voice' | 'sticker' | 'file';
  originalArtifactRef: string | null;
  mimeType: string;
  caption?: string;
  transcription?: {text: string | null; status: 'complete' | 'failed' | 'unavailable'};
  interpretation?: {text: string | null; status: 'complete' | 'failed' | 'unavailable'};
}

export interface InboundChannelMedia {
  kind: 'image' | 'video' | 'audio' | 'voice' | 'sticker' | 'file';
  bytes: Buffer;
  mimeType: string;
  filename: string;
  caption?: string;
  gifPlayback?: boolean;
}

export interface WhatsAppQuotedContext { providerMessageId: string; body: string }

/** Read the provider's quoted message without conflating it with the new text. */
export function extractWhatsAppQuotedContext(message: unknown): WhatsAppQuotedContext | undefined {
  let value = message && typeof message === 'object' && 'message' in message
    ? (message as {message?: unknown}).message : message;
  for (let depth = 0; depth < 5 && value && typeof value === 'object'; depth++) {
    const record = value as Record<string, unknown>;
    for (const key of ['extendedTextMessage', 'imageMessage', 'videoMessage', 'documentMessage', 'buttonsResponseMessage', 'templateButtonReplyMessage']) {
      const part = record[key];
      if (!part || typeof part !== 'object') continue;
      const context = (part as Record<string, unknown>).contextInfo;
      if (!context || typeof context !== 'object') continue;
      const c = context as Record<string, unknown>;
      const providerMessageId = typeof c.stanzaId === 'string' ? c.stanzaId.trim() : '';
      const quoted = c.quotedMessage && typeof c.quotedMessage === 'object' ? c.quotedMessage as Record<string, unknown> : {};
      const body = typeof quoted.conversation === 'string' ? quoted.conversation
        : typeof (quoted.extendedTextMessage as {text?: unknown} | undefined)?.text === 'string' ? (quoted.extendedTextMessage as {text: string}).text
          : typeof (quoted.imageMessage as {caption?: unknown} | undefined)?.caption === 'string' ? (quoted.imageMessage as {caption: string}).caption
            : typeof (quoted.videoMessage as {caption?: unknown} | undefined)?.caption === 'string' ? (quoted.videoMessage as {caption: string}).caption
              : '[quoted media]';
      if (providerMessageId) return {providerMessageId, body: body.slice(0, 2_000)};
    }
    value = record.ephemeralMessage && typeof record.ephemeralMessage === 'object' ? (record.ephemeralMessage as {message?: unknown}).message
      : record.viewOnceMessage && typeof record.viewOnceMessage === 'object' ? (record.viewOnceMessage as {message?: unknown}).message
        : record.viewOnceMessageV2 && typeof record.viewOnceMessageV2 === 'object' ? (record.viewOnceMessageV2 as {message?: unknown}).message : undefined;
  }
  return undefined;
}

/** Normalize supported text, binary media and provider-native events into truthful model context. */
export async function resolveWhatsAppInboundBody(
  message: unknown,
  options: {
    downloadMedia?: (message: unknown) => Promise<Buffer>;
    transcribeAudio?: (bytes: Buffer, mimeType: string) => Promise<string | null>;
    describeImage?: (bytes: Buffer, mimeType: string, caption?: string) => Promise<string | null>;
    extractDocument?: (bytes: Buffer, mimeType: string, fileName?: string) => Promise<string | null>;
    persistMedia?: (media: InboundChannelMedia) => Promise<string | null>;
    onMediaContext?: (context: WhatsAppMediaContext) => void;
    onFailure?: (kind: 'download_media' | 'persist_media' | 'transcribe' | 'describe_image' | 'extract_document', error: Error) => void;
  } = {},
): Promise<string | undefined> {
  const content = message && typeof message === 'object' && 'message' in message
    ? (message as { message?: unknown }).message
    : message;
  let bytesPromise: Promise<Buffer | null> | undefined;
  const mediaBytes = async (): Promise<Buffer | null> => {
    if (!bytesPromise) {
      bytesPromise = options.downloadMedia
        ? options.downloadMedia(message).catch((error) => {
          options.onFailure?.('download_media', error instanceof Error ? error : new Error(String(error)));
          return null;
        })
        : Promise.resolve(null);
    }
    return bytesPromise;
  };
  const persist = async (media: Omit<InboundChannelMedia, 'bytes'>): Promise<string | null> => {
    if (!options.persistMedia) return null;
    const bytes = await mediaBytes();
    if (!bytes) return null;
    try {
      return await options.persistMedia({ ...media, bytes });
    } catch (error) {
      options.onFailure?.('persist_media', error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  };
  const attachmentLine = (ref: string | null) => ref ? `Attachment: ${ref}` : null;

  const audio = unwrapAudioMessage(content);
  if (audio) {
    const mimeType = String(audio.mimetype ?? 'audio/ogg');
    const ref = await persist({ kind: 'voice', mimeType, filename: mediaFilename('voice-note', mimeType) });
    let transcript: string | null = null;
    let transcriptionStatus: 'complete' | 'failed' | 'unavailable' = 'unavailable';
    if (options.downloadMedia && options.transcribeAudio) {
      try {
        const bytes = await mediaBytes();
        const rawTranscript = bytes ? await options.transcribeAudio(bytes, mimeType) : null;
        transcript = rawTranscript?.trim() || null;
        if (transcript) transcriptionStatus = 'complete';
        else transcriptionStatus = bytes ? 'failed' : 'unavailable';
      } catch (error) {
        transcriptionStatus = 'failed';
        options.onFailure?.('transcribe', error instanceof Error ? error : new Error(String(error)));
      }
    }
    options.onMediaContext?.({kind: 'voice', originalArtifactRef: ref, mimeType,
      transcription: {text: transcript, status: transcriptionStatus}});
    return transcript
      ? ['[Voice note transcript]', transcript, attachmentLine(ref)].filter(Boolean).join('\n')
      : ['[Voice note received. Transcription is unavailable.]', attachmentLine(ref)].filter(Boolean).join('\n');
  }

  const image = unwrapImageMessage(content);
  if (image) {
    const caption = cleanText(image.caption);
    const mimeType = String(image.mimetype ?? 'image/jpeg');
    const ref = await persist({ kind: 'image', mimeType, filename: mediaFilename('image', mimeType), ...(caption ? { caption } : {}) });
    let description: string | null = null;
    if (options.downloadMedia && options.describeImage) {
      try {
        const bytes = await mediaBytes();
        description = bytes ? await options.describeImage(bytes, mimeType, caption ?? undefined) : null;
      } catch (error) {
        options.onFailure?.('describe_image', error instanceof Error ? error : new Error(String(error)));
      }
    }
    options.onMediaContext?.({kind: 'image', originalArtifactRef: ref, mimeType, ...(caption ? {caption} : {}),
      interpretation: {text: description?.trim() || null, status: description?.trim() ? 'complete' : options.describeImage ? 'failed' : 'unavailable'}});
    return [
      '[Image received]',
      ...(caption ? [`Caption: ${caption}`] : []),
      attachmentLine(ref),
      description?.trim() ? `Visual analysis: ${description.trim()}` : 'Visual analysis is unavailable. Do not claim to know what is in the image.',
    ].join('\n');
  }

  const video = unwrapWhatsAppMediaMessage(content, 'videoMessage') as { mimetype?: string; caption?: string; gifPlayback?: boolean; jpegThumbnail?: Uint8Array } | undefined;
  if (video) {
    const caption = cleanText(video.caption);
    const mimeType = String(video.mimetype ?? 'video/mp4');
    const gifPlayback = Boolean(video.gifPlayback);
    const ref = await persist({
      kind: 'video', mimeType, filename: mediaFilename(gifPlayback ? 'animation' : 'video', mimeType), gifPlayback,
      ...(caption ? { caption } : {}),
    });
    let previewDescription: string | null = null;
    if (options.describeImage && video.jpegThumbnail?.byteLength) {
      try {
        previewDescription = await options.describeImage(Buffer.from(video.jpegThumbnail), 'image/jpeg', caption ?? 'Preview frame from a received video');
      } catch (error) {
        options.onFailure?.('describe_image', error instanceof Error ? error : new Error(String(error)));
      }
    }
    options.onMediaContext?.({kind: 'video', originalArtifactRef: ref, mimeType, ...(caption ? {caption} : {}),
      interpretation: {text: previewDescription?.trim() || null, status: previewDescription?.trim() ? 'complete' : options.describeImage ? 'failed' : 'unavailable'}});
    return [
      gifPlayback ? '[Animated GIF received]' : '[Video received]',
      ...(caption ? [`Caption: ${caption}`] : []),
      attachmentLine(ref),
      ...(previewDescription?.trim() ? [`Preview-frame analysis: ${previewDescription.trim()}`] : []),
    ].filter(Boolean).join('\n');
  }

  const sticker = unwrapWhatsAppMediaMessage(content, 'stickerMessage') as { mimetype?: string } | undefined;
  if (sticker) {
    const mimeType = String(sticker.mimetype ?? 'image/webp');
    const ref = await persist({ kind: 'sticker', mimeType, filename: mediaFilename('sticker', mimeType) });
    let description: string | null = null;
    if (options.describeImage) {
      try {
        const bytes = await mediaBytes();
        description = bytes ? await options.describeImage(bytes, mimeType, 'Sticker sent in the conversation') : null;
      } catch (error) {
        options.onFailure?.('describe_image', error instanceof Error ? error : new Error(String(error)));
      }
    }
    options.onMediaContext?.({kind: 'sticker', originalArtifactRef: ref, mimeType, interpretation: {text: description?.trim() || null, status: description?.trim() ? 'complete' : options.describeImage ? 'failed' : 'unavailable'}});
    return ['[Sticker received]', attachmentLine(ref), ...(description?.trim() ? [`Visual analysis: ${description.trim()}`] : [])].filter(Boolean).join('\n');
  }

  const doc = unwrapDocumentMessage(content);
  if (doc) {
    const fileName = cleanText(doc.fileName);
    const caption = cleanText(doc.caption);
    const mimeType = String(doc.mimetype ?? 'application/octet-stream');
    const ref = await persist({ kind: 'file', mimeType, filename: fileName ?? mediaFilename('document', mimeType), ...(caption ? { caption } : {}) });
    let text: string | null = null;
    if (options.downloadMedia && options.extractDocument) {
      try {
        text = await options.extractDocument(await options.downloadMedia(message), mimeType, fileName ?? undefined);
      } catch (error) {
        options.onFailure?.('extract_document', error instanceof Error ? error : new Error(String(error)));
      }
    }
    options.onMediaContext?.({kind: 'file', originalArtifactRef: ref, mimeType, ...(caption ? {caption} : {}),
      interpretation: {text: text?.trim() || null, status: text?.trim() ? 'complete' : options.extractDocument ? 'failed' : 'unavailable'}});
    return [
      `[Document received${fileName ? `: ${fileName}` : ''}]`,
      ...(caption ? [`Caption: ${caption}`] : []),
      attachmentLine(ref),
      text?.trim() ? text.trim() : 'Text extraction is unavailable. Do not claim to have read the document.',
    ].join('\n');
  }

  return resolveWhatsAppNativeBody(content) ?? extractWhatsAppText(content);
}

function cleanText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function artifactIdFromRef(ref: string | null): string | null {
  if (!ref?.startsWith('artifact:')) return null;
  const id = ref.slice('artifact:'.length).trim();
  return id || null;
}

function mediaFilename(stem: string, mimeType: string): string {
  const mime = mimeType.split(';', 1)[0]!.toLowerCase();
  const ext = mime === 'image/jpeg' ? 'jpg'
    : mime === 'image/svg+xml' ? 'svg'
      : mime === 'audio/ogg' ? 'ogg'
        : mime === 'audio/mpeg' ? 'mp3'
          : mime === 'video/mp4' ? 'mp4'
            : mime.split('/')[1]?.replace(/[^a-z0-9]+/g, '') || 'bin';
  return `${stem}.${ext}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrapWhatsAppMediaMessage(message: any, key: string): unknown {
  let m = message;
  for (let i = 0; i < 5 && m && typeof m === 'object'; i += 1) {
    if (m[key]) return m[key];
    const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message
      ?? m.viewOnceMessageV2Extension?.message ?? m.documentWithCaptionMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveWhatsAppNativeBody(message: any): string | undefined {
  let m = message;
  for (let i = 0; i < 5 && m && typeof m === 'object'; i += 1) {
    const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message
      ?? m.viewOnceMessageV2Extension?.message;
    if (!inner) break;
    m = inner;
  }
  if (!m || typeof m !== 'object') return undefined;
  const location = m.locationMessage ?? m.liveLocationMessage;
  if (location && Number.isFinite(location.degreesLatitude) && Number.isFinite(location.degreesLongitude)) {
    return [
      m.liveLocationMessage ? '[Live location received]' : '[Location received]',
      `Coordinates: ${location.degreesLatitude}, ${location.degreesLongitude}`,
      ...(cleanText(location.name) ? [`Name: ${cleanText(location.name)}`] : []),
      ...(cleanText(location.address) ? [`Address: ${cleanText(location.address)}`] : []),
      `Map: https://maps.google.com/?q=${location.degreesLatitude},${location.degreesLongitude}`,
    ].join('\n');
  }
  const contacts = m.contactsArrayMessage?.contacts ?? (m.contactMessage ? [m.contactMessage] : null);
  if (Array.isArray(contacts) && contacts.length > 0) {
    return ['[Contact card received]', ...contacts.flatMap((contact: any) => [
      ...(cleanText(contact.displayName) ? [`Name: ${cleanText(contact.displayName)}`] : []),
      ...(cleanText(contact.vcard) ? [`vCard:\n${cleanText(contact.vcard)}`] : []),
    ])].join('\n');
  }
  const poll = m.pollCreationMessage ?? m.pollCreationMessageV2 ?? m.pollCreationMessageV3;
  if (poll) {
    const options = Array.isArray(poll.options) ? poll.options.map((option: any) => cleanText(option.optionName)).filter(Boolean) : [];
    return ['[Poll received]', ...(cleanText(poll.name) ? [`Question: ${cleanText(poll.name)}`] : []), ...options.map((option: string, index: number) => `${index + 1}. ${option}`)].join('\n');
  }
  const reaction = m.reactionMessage;
  if (reaction && cleanText(reaction.text)) return `[Reaction received: ${cleanText(reaction.text)}${reaction.key?.id ? ` to message ${reaction.key.id}` : ''}]`;
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function whatsappMediaContent(att: OutboundAttachment, caption?: string): any {
  const text = caption ?? att.caption;
  const cap = typeof text === 'string' && text.trim() ? text : undefined;
  switch (att.kind) {
    case 'image': return { image: att.data, ...(cap ? { caption: cap } : {}), ...(att.viewOnce ? { viewOnce: true } : {}) };
    case 'video': return { video: att.data, ...(cap ? { caption: cap } : {}), ...(att.gifPlayback ? { gifPlayback: true } : {}), ...(att.seconds ? { seconds: att.seconds } : {}), ...(att.viewOnce ? { viewOnce: true } : {}) };
    case 'audio': return { audio: att.data, mimetype: att.mimeType || 'audio/mp4', ...(att.seconds ? { seconds: att.seconds } : {}) };
    case 'voice': return { audio: att.data, ptt: true, mimetype: att.mimeType || 'audio/ogg; codecs=opus', ...(att.seconds ? { seconds: att.seconds } : {}) };
    case 'sticker': return { sticker: att.data };
    case 'file':
    default: return { document: att.data, mimetype: att.mimeType || 'application/octet-stream', fileName: att.filename, ...(cap ? { caption: cap } : {}) };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function whatsappNativeContent(native: OutboundNativeContent): any {
  if (native.kind !== 'location' && native.kind !== 'contact') {
    if (native.kind !== 'poll') throw new Error('This transport does not support Cloud interactive content or templates');
    return { poll: { name: native.question, values: native.options, selectableCount: native.selectableCount ?? 1 } };
  }
  if (native.kind === 'location') {
    return { location: { degreesLatitude: native.latitude, degreesLongitude: native.longitude, ...(native.name ? { name: native.name } : {}), ...(native.address ? { address: native.address } : {}) } };
  }
  if (native.kind === 'contact') {
    const digits = native.phone.replace(/[^+\d]/g, '');
    const vcard = native.vcard ?? ['BEGIN:VCARD', 'VERSION:3.0', `FN:${native.displayName}`, `TEL;TYPE=CELL:${digits}`, 'END:VCARD'].join('\n');
    return { contacts: { displayName: native.displayName, contacts: [{ displayName: native.displayName, vcard }] } };
  }
  throw new Error('Unsupported native WhatsApp content');
}

export function observedWhatsAppChatJids(key: { remoteJid?: unknown; remoteJidAlt?: unknown }): string[] {
  const remoteJid = typeof key.remoteJid === 'string' ? key.remoteJid : '';
  if (!remoteJid) return [];
  const remoteJidAlt = typeof key.remoteJidAlt === 'string' ? key.remoteJidAlt : '';
  const cleanAlt = remoteJidAlt.replace(/:\d+@/u, '@');
  // Prefer the real phone-number address when Baileys supplies it for a LID,
  // but retain every provider alias for connection-scoped ownership policy.
  return [...new Set(remoteJid.endsWith('@lid') && cleanAlt.includes('@s.whatsapp.net')
    ? [cleanAlt, remoteJid]
    : [remoteJid, ...(cleanAlt ? [cleanAlt] : [])])];
}

export function observedWhatsAppChatJid(key: { remoteJid?: unknown; remoteJidAlt?: unknown }): string | null {
  return observedWhatsAppChatJids(key)[0] ?? null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractWhatsAppText(message: any): string | undefined {
  let m = message;
  for (let i = 0; i < 4 && m && typeof m === 'object'; i += 1) {
    const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message
      ?? m.viewOnceMessageV2Extension?.message ?? m.documentWithCaptionMessage?.message;
    if (!inner) break;
    m = inner;
  }
  if (!m || typeof m !== 'object') return undefined;
  const conversation = typeof m.conversation === 'string' ? m.conversation.trim() : '';
  if (conversation) return conversation;
  const extended = m.extendedTextMessage?.text;
  if (typeof extended === 'string' && extended.trim()) return extended.trim();
  const caption = m.imageMessage?.caption ?? m.videoMessage?.caption ?? m.documentMessage?.caption;
  return typeof caption === 'string' && caption.trim() ? caption.trim() : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrapAudioMessage(message: any): { mimetype?: string } | undefined {
  let m = message;
  for (let i = 0; i < 4 && m && typeof m === 'object'; i += 1) {
    if (m.audioMessage) return m.audioMessage as { mimetype?: string };
    const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message ?? m.viewOnceMessageV2Extension?.message;
    if (!inner) break;
    m = inner;
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrapImageMessage(message: any): { mimetype?: string; caption?: string } | undefined {
  let m = message;
  for (let i = 0; i < 4 && m && typeof m === 'object'; i += 1) {
    if (m.imageMessage) return m.imageMessage as { mimetype?: string; caption?: string };
    const doc = m.documentMessage;
    if (doc && typeof doc.mimetype === 'string' && doc.mimetype.startsWith('image/')) return doc as { mimetype?: string; caption?: string };
    const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message
      ?? m.viewOnceMessageV2Extension?.message ?? m.documentWithCaptionMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrapDocumentMessage(message: any): { mimetype?: string; fileName?: string; caption?: string } | undefined {
  let m = message;
  for (let i = 0; i < 4 && m && typeof m === 'object'; i += 1) {
    const doc = m.documentMessage;
    if (doc && !(typeof doc.mimetype === 'string' && doc.mimetype.startsWith('image/'))) return doc as { mimetype?: string; fileName?: string; caption?: string };
    const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message ?? m.documentWithCaptionMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return undefined;
}
