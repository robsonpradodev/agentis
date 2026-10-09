import type { ChannelDeliveryReceipt } from './types.js';

export type WhatsAppReconnectClass =
  | 'connection_lost'
  | 'restart_required'
  | 'service_unavailable'
  | 'session_conflict'
  | 'connection_closed'
  | 'reachout_paused'
  | 'exhausted';

export interface WhatsAppDeliverySignal {
  status: number;
  errorCode?: string;
  error?: string;
}

export interface WhatsAppMessageUpdate {
  status?: unknown;
  messageStubParameters?: unknown;
}

/** Parse both success statuses and Baileys' status=0 provider rejection. */
export function whatsappDeliverySignal(update: WhatsAppMessageUpdate | null | undefined): WhatsAppDeliverySignal | null {
  if (!update) return null;
  const numeric = typeof update.status === 'number' ? update.status : Number(update.status);
  if (!Number.isFinite(numeric)) return null;
  if (numeric > 0) return { status: numeric };
  const params = Array.isArray(update.messageStubParameters) ? update.messageStubParameters : [];
  const errorCode = params[0] == null ? '' : String(params[0]).trim();
  if (!errorCode) return null;
  return { status: 0, errorCode, error: whatsappProviderRejectionMessage(errorCode) };
}

export function whatsappProviderRejectionMessage(errorCode: string): string {
  if (errorCode === '463') {
    return 'WhatsApp rejected this linked-device send because a provider reach-out restriction is active (error 463).';
  }
  if (errorCode === '479') {
    return 'WhatsApp rejected the message because the recipient addressing or device session is stale or invalid.';
  }
  return `WhatsApp rejected the message (provider error ${errorCode}).`;
}

export type WhatsAppReachoutRestrictionScope = 'companion' | 'account_or_business' | 'unknown';

/** Interpret provider scope without pretending a companion restriction also blocks the primary phone. */
export function whatsappReachoutRestrictionScope(enforcementType: unknown): WhatsAppReachoutRestrictionScope {
  const value = typeof enforcementType === 'string' ? enforcementType.trim().toUpperCase() : '';
  if (value.includes('COMPANION') || value === 'WEB_COMPANION_ONLY') return 'companion';
  if (value.startsWith('BIZ_')) return 'account_or_business';
  return 'unknown';
}

/** Baileys WebMessageInfo.Status: 2 server, 3 delivered, 4+ read/played. */
export function whatsappDeliveryStatus(status: unknown): ChannelDeliveryReceipt['status'] {
  const numeric = typeof status === 'number' ? status : Number(status);
  if (!Number.isFinite(numeric) || numeric < 2) return 'queued';
  if (numeric >= 4) return 'read';
  if (numeric >= 3) return 'delivered';
  return 'accepted';
}

export function normalizeWhatsAppJid(jid: string): string {
  return jid.trim().toLowerCase().replace(/:\d+@/u, '@');
}

export function messageTimestampMs(message: unknown): number {
  const raw = (message as { messageTimestamp?: unknown } | null)?.messageTimestamp;
  let seconds: number;
  if (raw && typeof raw === 'object' && 'toNumber' in raw && typeof (raw as { toNumber?: unknown }).toNumber === 'function') {
    seconds = (raw as { toNumber(): number }).toNumber();
  } else {
    seconds = Number(raw);
  }
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : Date.now();
}

/**
 * Decide which Baileys upserts may enter live conversation state.
 *
 * Baileys occasionally labels a genuinely new message as `append` while a
 * companion is catching up. Treating every append as inert history orphaned
 * those messages until the customer wrote again. A recent provider timestamp remains
 * safe to process live: downstream provider-id deduplication prevents a later
 * `notify` copy from running twice. Older appends remain silent reconciliation.
 */
export function shouldProcessWhatsAppUpsert(
  type: string,
  _fromMe: boolean,
  occurredAt = 0,
  now = Date.now(),
): boolean {
  if (type === 'notify') return true;
  return type === 'append' && occurredAt > 0 && occurredAt >= now - 30_000 && occurredAt <= now + 5_000;
}

/** Stable recovery classes persisted as diagnostics; provider codes stay in logs. */
export function classifyWhatsAppReconnect(statusCode: number | undefined): WhatsAppReconnectClass {
  switch (statusCode) {
    case 408: return 'connection_lost';
    case 440: return 'session_conflict';
    case 503: return 'service_unavailable';
    case 515: return 'restart_required';
    default: return 'connection_closed';
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readDisconnectStatus(error: any): number | undefined {
  const status = error?.output?.statusCode ?? error?.statusCode;
  return typeof status === 'number' ? status : undefined;
}
