/**
 * channelCapabilities — the machine-readable matrix of what each channel can
 * deliver (OMNICHANNEL-RICH-MESSAGING §4). Agents query it before composing so
 * they don't attempt an unsupported primitive, and the cockpit uses it to enable
 * the right composer affordances. Provider policy and transport capability are
 * explicit so Cloud-only affordances are never offered to linked-device sessions.
 */

import type { ChannelKind, OutboundMediaKind } from './types.js';

export interface ChannelCapabilities {
  kind: ChannelKind;
  /** Graph API version pinned to a WhatsApp Cloud connection. */
  providerApiVersion?: string;
  /** Media kinds the channel delivers natively. */
  mediaKinds: OutboundMediaKind[];
  supportsReactions: boolean;
  /** A "typing…"/"recording…" presence indicator. */
  supportsPresence: boolean;
  supportsReadReceipts: boolean;
  supportsTemplates: boolean;
  supportsInteractiveButtons: boolean;
  supportsInteractiveLists: boolean;
  supportsLocation: boolean;
  supportsContacts: boolean;
  supportsPoll: boolean;
  supportsReplyQuote: boolean;
  supportsMentions: boolean;
  /** Ordered multi-message bursts. */
  supportsBurst: boolean;
  /** Human-like pacing (needs a presence indicator to be meaningful). */
  supportsHumanize: boolean;
  /** Inbound read acknowledgement behavior of this connection. */
  readReceiptPolicy?: 'automatic' | 'manual' | 'unsupported';
  /** Presence primitives the complete adapter path supports. */
  presenceModes?: Array<'typing' | 'recording'>;
  /** The conversation turn owns presence and clears it on completion/cancel. */
  presenceManagedByTurn?: boolean;
  presenceStopsOnCancel?: boolean;
}

const ALL_MEDIA: OutboundMediaKind[] = ['image', 'video', 'audio', 'voice', 'sticker', 'file'];

/** Resolve the capability descriptor for a channel (and WhatsApp transport mode). */
export function channelCapabilities(
  kind: ChannelKind,
  opts?: { whatsappMode?: 'qr_local' | 'cloud'; whatsappGraphVersion?: string; readReceiptPolicy?: 'automatic' | 'manual' | 'unsupported' },
): ChannelCapabilities {
  switch (kind) {
    case 'whatsapp': {
      const cloud = opts?.whatsappMode === 'cloud';
      return {
        kind,
        ...(cloud && opts?.whatsappGraphVersion
          ? { providerApiVersion: opts.whatsappGraphVersion }
          : {}),
        mediaKinds: ALL_MEDIA,
        supportsReactions: true,
        supportsPresence: !cloud || (opts?.readReceiptPolicy ?? 'manual') === 'automatic',
        supportsReadReceipts: opts?.readReceiptPolicy !== 'unsupported',
        supportsTemplates: cloud,
        supportsInteractiveButtons: cloud,
        supportsInteractiveLists: cloud,
        supportsLocation: true,
        supportsContacts: true,
        supportsPoll: !cloud, // polls ride the baileys socket, not the Cloud message API
        supportsReplyQuote: !cloud,
        supportsMentions: !cloud,
        supportsBurst: true,
        supportsHumanize: !cloud,
        readReceiptPolicy: opts?.readReceiptPolicy ?? (cloud ? 'manual' : 'automatic'),
        presenceModes: !cloud || (opts?.readReceiptPolicy ?? 'manual') === 'automatic' ? ['typing'] : [],
        presenceManagedByTurn: true,
        presenceStopsOnCancel: true,
      };
    }
    case 'telegram':
      return {
        kind,
        mediaKinds: ALL_MEDIA,
        supportsReactions: true,
        supportsPresence: true,
        supportsReadReceipts: false,
        supportsTemplates: false,
        supportsInteractiveButtons: false,
        supportsInteractiveLists: false,
        supportsLocation: true,
        supportsContacts: true,
        supportsPoll: true,
        supportsReplyQuote: false,
        supportsMentions: true,
        supportsBurst: true,
        supportsHumanize: true,
        readReceiptPolicy: 'unsupported',
        presenceModes: ['typing'],
        presenceManagedByTurn: true,
        presenceStopsOnCancel: true,
      };
    case 'slack':
      return {
        kind,
        mediaKinds: ['image', 'video', 'audio', 'file'],
        supportsReactions: true,
        supportsPresence: false,
        supportsReadReceipts: false,
        supportsTemplates: false,
        supportsInteractiveButtons: false,
        supportsInteractiveLists: false,
        supportsLocation: false,
        supportsContacts: false,
        supportsPoll: false,
        supportsReplyQuote: false,
        supportsMentions: true,
        supportsBurst: true,
        supportsHumanize: false,
        readReceiptPolicy: 'unsupported',
      };
    case 'discord':
      return {
        kind,
        mediaKinds: ['image', 'video', 'audio', 'file'],
        supportsReactions: true,
        supportsPresence: false,
        supportsReadReceipts: false,
        supportsTemplates: false,
        supportsInteractiveButtons: false,
        supportsInteractiveLists: false,
        supportsLocation: false,
        supportsContacts: false,
        supportsPoll: false,
        supportsReplyQuote: false,
        supportsMentions: true,
        supportsBurst: true,
        supportsHumanize: false,
        readReceiptPolicy: 'unsupported',
      };
    case 'voice':
    default:
      return {
        kind,
        mediaKinds: [],
        supportsReactions: false,
        supportsPresence: false,
        supportsReadReceipts: false,
        supportsTemplates: false,
        supportsInteractiveButtons: false,
        supportsInteractiveLists: false,
        supportsLocation: false,
        supportsContacts: false,
        supportsPoll: false,
        supportsReplyQuote: false,
        supportsMentions: false,
        supportsBurst: false,
        supportsHumanize: false,
        readReceiptPolicy: 'unsupported',
      };
  }
}
