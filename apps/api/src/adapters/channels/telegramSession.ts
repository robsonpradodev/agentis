/**
 * TelegramSession — one long-polling Telegram bot connection (grammy).
 *
 * The webhook TelegramChannelAdapter needs a public URL; long polling does not,
 * so self-hosted / local installs can run Telegram too (OMNICHANNEL §3.4). A
 * connection opts into this by storing `settings.transport = 'polling'`; the
 * ChannelConnectionSupervisor then owns a live bot here instead of the webhook
 * path. grammy is lazy-loaded so an install without it still boots.
 */

import type { Logger } from '../../logger.js';
import type { ChannelDeliveryReceipt, OutboundAttachment, OutboundNativeContent } from './types.js';
import type { InboundChannelMedia } from './whatsappSession.js';

export type TelegramSessionStatus = 'idle' | 'starting' | 'open' | 'closed' | 'error';

// Auto-recovery for a transient start failure (409 conflict, network blip). A
// 24/7 attendant must heal itself rather than wait for a manual relink, so we
// re-attempt with exponential backoff (capped) until it opens or is stopped.
const RETRY_BASE_MS = 3_000;
const RETRY_MAX_MS = 60_000;
/** A 409 conflict means another poller is active; back off harder so two instances don't thrash. */
const CONFLICT_BASE_MS = 15_000;
/** The poll loop must stay open this long before we treat it as stable and reset the backoff. */
const STABLE_OPEN_MS = 60_000;
/** After this many back-to-back conflicts with no stable open, stand down — another instance owns the bot. */
const CONFLICT_STANDDOWN = 5;
/** Standing-down poke, escalating. The first standdown retry is quick (~45s) so a
 *  *reload ghost* (the previous process's long-poll lingers ~50s after a restart,
 *  then clears) recovers within a minute. But if conflicts PERSIST — another app
 *  genuinely owns this bot token (e.g. a second gateway polling the same bot) —
 *  the delay doubles up to a cap, so we stop spamming 409 retries every 45s and
 *  settle into an occasional poke until the operator stops the other poller. */
const STANDDOWN_BASE_MS = 45_000;
const STANDDOWN_MAX_MS = 600_000;

/** A start failure we should NOT retry — the token/bot is wrong, a relink is required. */
function isPermanentTelegramError(message: string): boolean {
  return /\b401\b|\b403\b|unauthorized|forbidden|invalid token|bot was deleted|not found/i.test(message);
}

export interface TelegramInbound {
  externalId: string;
  chatId: string;
  body: string;
  from?: string;
  /** Durable artifacts created from provider media. Kept typed through the turn. */
  attachmentIds?: string[];
  /** Forum-topic subject boundary, when the message is in a topic. */
  threadId?: string;
}

export interface TelegramSessionOptions {
  connectionId: string;
  token: string;
  logger: Logger;
  onInbound: (msg: TelegramInbound) => void;
  onStateChange?: (state: { status: TelegramSessionStatus }) => void;
  transcribeAudio?: (bytes: Buffer, mimeType: string) => Promise<string | null>;
  describeImage?: (bytes: Buffer, mimeType: string, caption?: string) => Promise<string | null>;
  extractDocument?: (bytes: Buffer, mimeType: string, fileName?: string) => Promise<string | null>;
  persistMedia?: (media: InboundChannelMedia) => Promise<string | null>;
}

type GrammyModule = typeof import('grammy');
let cachedGrammy: { ok: true; mod: GrammyModule } | { ok: false; reason: string } | undefined;
async function loadGrammy() {
  if (cachedGrammy) return cachedGrammy;
  try {
    const mod = (await import('grammy' as string)) as GrammyModule;
    cachedGrammy = { ok: true, mod };
  } catch (err) {
    cachedGrammy = { ok: false, reason: (err as Error).message };
  }
  return cachedGrammy;
}

export class TelegramSession {
  #status: TelegramSessionStatus = 'idle';
  #bot: InstanceType<GrammyModule['Bot']> | undefined;
  #startPromise: Promise<void> | undefined;
  /** Set by stop() so an in-flight retry cancels and a closed session stays closed. */
  #stopped = false;
  /** Consecutive failed attempts since the last SUSTAINED open (drives the backoff). */
  #attempt = 0;
  /** Consecutive 409 conflicts with no sustained open — means another instance owns the bot. */
  #conflictStreak = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Fires after the poll loop has been open a while; only THEN is the backoff reset. */
  #stableTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: TelegramSessionOptions) {}

  get status(): TelegramSessionStatus { return this.#status; }

  async start(): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    this.#stopped = false;
    this.#attempt = 0;
    this.#startPromise = this.#attemptStart();
    return this.#startPromise;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#retryTimer) { clearTimeout(this.#retryTimer); this.#retryTimer = undefined; }
    this.#clearStableTimer();
    try { await this.#bot?.stop(); } catch { /* best-effort */ }
    this.#bot = undefined;
    this.#startPromise = undefined;
    this.#setStatus('closed');
  }

  async sendText(chatId: string, text: string): Promise<ChannelDeliveryReceipt> {
    if (!this.#bot) throw new Error(`telegram session ${this.opts.connectionId} is not started`);
    const sent = await this.#bot.api.sendMessage(chatId, text);
    const providerMessageId = sent?.message_id == null ? '' : String(sent.message_id);
    if (!providerMessageId) throw new Error('telegram provider accepted no message id; outbound delivery is unverified');
    return { provider: 'telegram', providerMessageId, status: 'accepted', acceptedAt: new Date().toISOString(), recipient: chatId };
  }

  /**
   * Send a single media attachment via the Bot API. grammy's InputFile wraps the
   * resolved Buffer; each kind maps to its dedicated sendX method so Telegram
   * renders it natively (photo/video/audio/voice/sticker/document).
   */
  async sendMedia(chatId: string, attachment: OutboundAttachment, caption?: string): Promise<ChannelDeliveryReceipt> {
    if (!this.#bot) throw new Error(`telegram session ${this.opts.connectionId} is not started`);
    const loaded = await loadGrammy();
    if (!loaded.ok) throw new Error(`telegram media send unavailable: ${loaded.reason}`);
    const file = new loaded.mod.InputFile(attachment.data, attachment.filename);
    const cap = (caption ?? attachment.caption)?.trim();
    const opts = cap ? { caption: cap } : {};
    const api = this.#bot.api;
    let sent: { message_id?: number } | undefined;
    switch (attachment.kind) {
      case 'image': sent = await api.sendPhoto(chatId, file, opts); break;
      case 'video': sent = await api.sendVideo(chatId, file, opts); break;
      case 'audio': sent = await api.sendAudio(chatId, file, opts); break;
      case 'voice': sent = await api.sendVoice(chatId, file, opts); break;
      case 'sticker': sent = await api.sendSticker(chatId, file); break;
      case 'file':
      default: sent = await api.sendDocument(chatId, file, opts); break;
    }
    const providerMessageId = sent?.message_id == null ? '' : String(sent.message_id);
    if (!providerMessageId) throw new Error('telegram provider accepted no message id for media; outbound delivery is unverified');
    return { provider: 'telegram', providerMessageId, status: 'accepted', acceptedAt: new Date().toISOString(), recipient: chatId };
  }

  /** Show the "typing…" chat action (auto-expires ~5s; best-effort). */
  async setTyping(chatId: string, on: boolean): Promise<void> {
    if (!this.#bot || !on) return; // Telegram has no explicit "stop typing"
    try {
      await this.#bot.api.sendChatAction(chatId, 'typing');
    } catch {
      /* best-effort */
    }
  }


  async #attemptStart(): Promise<void> {
    if (this.#stopped) return;
    const loaded = await loadGrammy();
    if (!loaded.ok) {
      // grammy missing is a deploy issue, not transient — do not retry.
      this.opts.logger.warn('telegram.grammy_unavailable', { reason: loaded.reason });
      this.#setStatus('error');
      return;
    }
    this.#setStatus('starting');
    const bot = new loaded.mod.Bot(this.opts.token);
    this.#bot = bot;

    // Register for every message, not just `message:text`: Telegram users treat
    // voice, photos, files, locations, contacts and stickers as normal turns.
    bot.on('message', (ctx) => {
      void this.#handleInbound(ctx).catch((err) => {
        this.opts.logger.warn('telegram.inbound_handler_threw', { err: (err as Error).message });
      });
    });

    bot.catch((err) => {
      this.opts.logger.warn('telegram.bot_error', { connectionId: this.opts.connectionId, err: String(err.error ?? err) });
    });

    // A webhook registered on the bot makes getUpdates polling fail with
    // 409 Conflict ("terminated by other getUpdates request") — outbound sends
    // fine but the live INBOUND transport never opens. grammy does not clear it,
    // so delete any webhook (and drop the stale backlog so we don't replay old
    // messages on recovery) before starting the long-poll loop.
    try {
      await bot.api.deleteWebhook({ drop_pending_updates: true });
    } catch (err) {
      this.opts.logger.warn('telegram.delete_webhook_failed', { connectionId: this.opts.connectionId, err: (err as Error).message });
    }

    // bot.start() resolves only when the bot stops — run it detached and flip to
    // 'open' once the long-poll loop is running.
    void bot.start({
      drop_pending_updates: true,
      onStart: () => this.#onPollOpen(),
    }).catch((err) => {
      const message = (err as Error).message;
      const conflict = /\b409\b|terminated by other getUpdates|conflict/i.test(message);
      this.#clearStableTimer();
      this.#setStatus('error');
      if (isPermanentTelegramError(message)) {
        this.opts.logger.warn('telegram.start_permanent_failure', { connectionId: this.opts.connectionId, err: message });
        return; // wrong token / forbidden — a relink is required, retrying won't help.
      }
      if (conflict) {
        this.#conflictStreak += 1;
        // Persistent conflict = ANOTHER Agentis instance owns this bot. Stop
        // fighting (the flap) — stand down to a slow poke so the other instance
        // holds the connection; we recover only if it dies. Fix: run ONE instance.
        const standDown = this.#conflictStreak >= CONFLICT_STANDDOWN;
        this.opts.logger.warn(standDown ? 'telegram.conflict_standdown' : 'telegram.start_failed', {
          connectionId: this.opts.connectionId,
          err: message,
          conflictStreak: this.#conflictStreak,
          hint: standDown
            ? 'Another Agentis instance is polling this bot — standing down. Stop the duplicate/orphaned process so this one can own the connection.'
            : 'Another process is polling this bot (or a webhook is set). Ensure only ONE Agentis instance runs this connection.',
        });
        this.#scheduleRetry(standDown
          ? Math.min(STANDDOWN_BASE_MS * 2 ** (this.#conflictStreak - CONFLICT_STANDDOWN), STANDDOWN_MAX_MS)
          : Math.min(CONFLICT_BASE_MS * 2 ** (this.#conflictStreak - 1), RETRY_MAX_MS));
        return;
      }
      // A non-conflict transient error (network blip) — reset the conflict streak.
      this.#conflictStreak = 0;
      this.opts.logger.warn('telegram.start_failed', { connectionId: this.opts.connectionId, err: message });
      this.#scheduleRetry(Math.min(RETRY_BASE_MS * 2 ** this.#attempt, RETRY_MAX_MS));
    });
  }

  async sendNative(chatId: string, native: OutboundNativeContent): Promise<ChannelDeliveryReceipt> {
    if (!this.#bot) throw new Error(`telegram session ${this.opts.connectionId} is not started`);
    if (native.kind !== 'location' && native.kind !== 'contact' && native.kind !== 'poll') throw new Error('This transport does not support Cloud interactive content or templates');
    let sent: { message_id?: number };
    if (native.kind === 'location') {
      sent = await this.#bot.api.sendLocation(chatId, native.latitude, native.longitude);
    } else if (native.kind === 'contact') {
      const names = native.displayName.trim().split(/\s+/);
      sent = await this.#bot.api.sendContact(chatId, native.phone, names[0] || native.displayName, {
        ...(names.length > 1 ? { last_name: names.slice(1).join(' ') } : {}),
        ...(native.vcard ? { vcard: native.vcard } : {}),
      });
    } else {
      sent = await this.#bot.api.sendPoll(chatId, native.question, native.options, {
        allows_multiple_answers: (native.selectableCount ?? 1) > 1,
      });
    }
    const providerMessageId = sent?.message_id == null ? '' : String(sent.message_id);
    if (!providerMessageId) throw new Error('telegram provider accepted no message id for native content');
    return { provider: 'telegram', providerMessageId, status: 'accepted', acceptedAt: new Date().toISOString(), recipient: chatId };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async #handleInbound(ctx: any): Promise<void> {
    const message = ctx.message;
    if (!message || !ctx.chat?.id) return;
    const attachmentIds: string[] = [];
    const body = await resolveTelegramInboundBody(message, {
      downloadFile: (fileId) => this.#downloadFile(fileId),
      transcribeAudio: this.opts.transcribeAudio,
      describeImage: this.opts.describeImage,
      extractDocument: this.opts.extractDocument,
      persistMedia: this.opts.persistMedia
        ? async (media) => {
            const ref = await this.opts.persistMedia!(media);
            const artifactId = artifactIdFromRef(ref);
            if (artifactId) attachmentIds.push(artifactId);
            return ref;
          }
        : undefined,
      onFailure: (kind, error) => this.opts.logger.warn(`telegram.${kind}_failed`, {
        connectionId: this.opts.connectionId,
        err: error.message,
      }),
    });
    if (!body) return;
    const chatId = String(ctx.chat.id);
    const topicId = message.message_thread_id;
    const from = ctx.from
      ? [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || ctx.from.username
      : undefined;
    this.opts.onInbound({
      externalId: `telegram:${ctx.update.update_id}`,
      chatId,
      body,
      ...(from ? { from } : {}),
      ...(attachmentIds.length ? { attachmentIds: [...new Set(attachmentIds)] } : {}),
      ...(topicId ? { threadId: `${chatId}:${topicId}` } : {}),
    });
  }

  async #downloadFile(fileId: string): Promise<Buffer> {
    if (!this.#bot) throw new Error('telegram session is not started');
    const file = await this.#bot.api.getFile(fileId);
    if (!file.file_path) throw new Error('telegram file has no downloadable path');
    const response = await fetch(`https://api.telegram.org/file/bot${this.opts.token}/${file.file_path}`);
    if (!response.ok) throw new Error(`telegram file download failed (${response.status})`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > 20 * 1024 * 1024) throw new Error('telegram inbound media exceeds the 20 MB safety limit');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('telegram inbound media exceeds the 20 MB safety limit');
    return bytes;
  }

  /** The long-poll loop is running. Only a SUSTAINED open resets the backoff — a
   *  brief open that's immediately kicked by a competing poller must not, or the
   *  backoff never grows and two instances flap forever. */
  #onPollOpen(): void {
    this.#setStatus('open');
    this.#clearStableTimer();
    this.#stableTimer = setTimeout(() => {
      this.#stableTimer = undefined;
      this.#attempt = 0;
      this.#conflictStreak = 0;
    }, STABLE_OPEN_MS);
    this.#stableTimer.unref?.();
  }

  #clearStableTimer(): void {
    if (this.#stableTimer) { clearTimeout(this.#stableTimer); this.#stableTimer = undefined; }
  }

  /**
   * Re-attempt start after `delayMs`. Each retry re-runs the deleteWebhook + poll
   * path, so a 409 from a lingering webhook clears itself. Cancelled by stop().
   */
  #scheduleRetry(delayMs: number): void {
    if (this.#stopped || this.#retryTimer) return;
    this.#attempt += 1;
    this.opts.logger.info('telegram.retry_scheduled', { connectionId: this.opts.connectionId, attempt: this.#attempt, delayMs });
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      if (this.#stopped) return;
      // Discard the failed bot before re-attempting (avoids a stuck poll loop).
      void this.#bot?.stop().catch(() => {});
      this.#bot = undefined;
      void this.#attemptStart();
    }, delayMs);
    this.#retryTimer.unref?.();
  }

  #setStatus(status: TelegramSessionStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.opts.onStateChange?.({ status });
  }
}

function artifactIdFromRef(ref: string | null): string | null {
  if (!ref?.startsWith('artifact:')) return null;
  const id = ref.slice('artifact:'.length).trim();
  return id || null;
}

type TelegramMediaDescriptor = Omit<InboundChannelMedia, 'bytes'> & { fileId: string };

export interface TelegramInboundResolvers {
  downloadFile?: (fileId: string) => Promise<Buffer>;
  transcribeAudio?: (bytes: Buffer, mimeType: string) => Promise<string | null>;
  describeImage?: (bytes: Buffer, mimeType: string, caption?: string) => Promise<string | null>;
  extractDocument?: (bytes: Buffer, mimeType: string, fileName?: string) => Promise<string | null>;
  persistMedia?: (media: InboundChannelMedia) => Promise<string | null>;
  onFailure?: (kind: 'download_media' | 'persist_media' | 'transcribe' | 'describe_image' | 'extract_document', error: Error) => void;
}

/** Convert every Telegram message shape into useful agent context. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resolveTelegramInboundBody(message: any, options: TelegramInboundResolvers = {}): Promise<string | undefined> {
  const text = telegramCleanText(message?.text);
  const caption = telegramCleanText(message?.caption);
  const media = telegramMediaDescriptor(message, caption);
  if (media) {
    let bytesPromise: Promise<Buffer | null> | undefined;
    const bytes = async (): Promise<Buffer | null> => {
      if (!bytesPromise) {
        bytesPromise = options.downloadFile
          ? options.downloadFile(media.fileId).catch((error) => {
            options.onFailure?.('download_media', asError(error));
            return null;
          })
          : Promise.resolve(null);
      }
      return bytesPromise;
    };
    let ref: string | null = null;
    if (options.persistMedia) {
      const data = await bytes();
      if (data) {
        try { ref = await options.persistMedia({ ...media, bytes: data }); }
        catch (error) { options.onFailure?.('persist_media', asError(error)); }
      }
    }
    const attachment = ref ? `Attachment: ${ref}` : null;
    if (media.kind === 'voice' || media.kind === 'audio') {
      let transcript: string | null = null;
      if (options.transcribeAudio) {
        try {
          const data = await bytes();
          transcript = data ? await options.transcribeAudio(data, media.mimeType) : null;
        } catch (error) { options.onFailure?.('transcribe', asError(error)); }
      }
      return [
        media.kind === 'voice' ? '[Voice note received]' : '[Audio received]',
        ...(caption ? [`Caption: ${caption}`] : []),
        ...(transcript?.trim() ? [`Transcript:\n${transcript.trim()}`] : ['Transcription is unavailable.']),
        attachment,
      ].filter(Boolean).join('\n');
    }
    if (media.kind === 'image' || media.kind === 'sticker') {
      let description: string | null = null;
      if (options.describeImage && !media.mimeType.includes('tgsticker')) {
        try {
          const data = await bytes();
          description = data ? await options.describeImage(data, media.mimeType, caption ?? undefined) : null;
        } catch (error) { options.onFailure?.('describe_image', asError(error)); }
      }
      return [
        media.kind === 'sticker' ? '[Sticker received]' : '[Image received]',
        ...(caption ? [`Caption: ${caption}`] : []),
        attachment,
        ...(description?.trim() ? [`Visual analysis: ${description.trim()}`] : ['Visual analysis is unavailable.']),
      ].filter(Boolean).join('\n');
    }
    if (media.kind === 'file') {
      let extracted: string | null = null;
      if (options.extractDocument) {
        try {
          const data = await bytes();
          extracted = data ? await options.extractDocument(data, media.mimeType, media.filename) : null;
        } catch (error) { options.onFailure?.('extract_document', asError(error)); }
      }
      return [
        `[Document received: ${media.filename}]`,
        ...(caption ? [`Caption: ${caption}`] : []),
        attachment,
        extracted?.trim() || 'Text extraction is unavailable. Do not claim to have read the document.',
      ].filter(Boolean).join('\n');
    }
    return [
      media.gifPlayback ? '[Animated GIF received]' : '[Video received]',
      ...(caption ? [`Caption: ${caption}`] : []),
      attachment,
    ].filter(Boolean).join('\n');
  }

  const location = message?.location ?? message?.venue?.location;
  if (location && Number.isFinite(location.latitude) && Number.isFinite(location.longitude)) {
    return [
      message.venue ? '[Venue received]' : '[Location received]',
      ...(telegramCleanText(message.venue?.title) ? [`Name: ${telegramCleanText(message.venue.title)}`] : []),
      ...(telegramCleanText(message.venue?.address) ? [`Address: ${telegramCleanText(message.venue.address)}`] : []),
      `Coordinates: ${location.latitude}, ${location.longitude}`,
      `Map: https://maps.google.com/?q=${location.latitude},${location.longitude}`,
    ].join('\n');
  }
  if (message?.contact) {
    const contact = message.contact;
    return [
      '[Contact card received]',
      `Name: ${[contact.first_name, contact.last_name].filter(Boolean).join(' ')}`,
      `Phone: ${contact.phone_number}`,
      ...(telegramCleanText(contact.vcard) ? [`vCard:\n${telegramCleanText(contact.vcard)}`] : []),
    ].join('\n');
  }
  if (message?.poll) {
    return [
      '[Poll received]',
      `Question: ${message.poll.question}`,
      ...(Array.isArray(message.poll.options)
        ? message.poll.options.map((option: { text?: string }, index: number) => `${index + 1}. ${option.text ?? ''}`)
        : []),
    ].join('\n');
  }
  return text ?? caption ?? undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function telegramMediaDescriptor(message: any, caption: string | null): TelegramMediaDescriptor | null {
  const common = caption ? { caption } : {};
  const photos = Array.isArray(message?.photo) ? message.photo : [];
  const photo = photos.at(-1);
  if (photo?.file_id) return { fileId: photo.file_id, kind: 'image', mimeType: 'image/jpeg', filename: 'photo.jpg', ...common };
  if (message?.voice?.file_id) return {
    fileId: message.voice.file_id, kind: 'voice', mimeType: message.voice.mime_type ?? 'audio/ogg', filename: 'voice-note.ogg', ...common,
  };
  if (message?.audio?.file_id) return {
    fileId: message.audio.file_id, kind: 'audio', mimeType: message.audio.mime_type ?? 'audio/mpeg',
    filename: message.audio.file_name ?? 'audio.mp3', ...common,
  };
  const video = message?.animation ?? message?.video ?? message?.video_note;
  if (video?.file_id) return {
    fileId: video.file_id, kind: 'video', mimeType: video.mime_type ?? 'video/mp4',
    filename: video.file_name ?? (message.animation ? 'animation.mp4' : 'video.mp4'),
    ...(message.animation ? { gifPlayback: true } : {}), ...common,
  };
  if (message?.sticker?.file_id) return {
    fileId: message.sticker.file_id, kind: 'sticker',
    mimeType: message.sticker.is_animated ? 'application/x-tgsticker' : message.sticker.is_video ? 'video/webm' : 'image/webp',
    filename: message.sticker.is_animated ? 'sticker.tgs' : message.sticker.is_video ? 'sticker.webm' : 'sticker.webp',
  };
  const document = message?.document;
  if (document?.file_id) {
    const mimeType = document.mime_type ?? 'application/octet-stream';
    const filename = document.file_name ?? 'document.bin';
    return {
      fileId: document.file_id,
      kind: mimeType.startsWith('image/') ? 'image' : 'file',
      mimeType,
      filename,
      ...common,
    };
  }
  return null;
}

function telegramCleanText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
