import type { ChannelAuthorityRole } from './relationship.js';

/** Opaque, stable reference to one canonical peer on one channel connection. */
export type ChannelRecipientRef = `peer:${string}`;

export type ChannelActionStatus =
  | 'planned'
  | 'awaiting_approval'
  | 'authorized'
  | 'executing'
  | 'delivered'
  | 'failed'
  | 'cancelled'
  | 'superseded';

export type ChannelActionAuthorizationBasis =
  | 'verified_owner_command'
  | 'standing_goal'
  | 'relationship_next_action'
  | 'operator_approval'
  | 'agent_connection_grant';

export interface ChannelInboxPeer {
  recipientRef: ChannelRecipientRef;
  peerIdentityId: string;
  connectionId: string;
  channelKind: string;
  displayName: string | null;
  conversationId: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageDirection: 'inbound' | 'outbound' | null;
  handoffState: string | null;
  subjectId: string | null;
  stage: string | null;
  goal: string | null;
  aliases: Array<{ value: string; kind: string; verified: boolean }>;
  /** Verified channel authority ('external' for an ordinary contact, 'owner'/'delegate' for granted staff). */
  authorityRole: ChannelAuthorityRole;
}

/** Serializable media reference retained by a durable channel action. */
export interface ChannelActionAttachment {
  url?: string;
  artifactId?: string;
  filename?: string;
  mimeType?: string;
  kind?: 'image' | 'video' | 'audio' | 'voice' | 'sticker' | 'file';
  text?: string;
  caption?: string;
  seconds?: number;
  gifPlayback?: boolean;
  viewOnce?: boolean;
}

/** Provider-native channel payload retained without flattening it into prose. */
export type ChannelActionNativeContent =
  | { kind: 'location'; latitude: number; longitude: number; name?: string; address?: string }
  | { kind: 'contact'; displayName: string; phone: string; vcard?: string }
  | { kind: 'poll'; question: string; options: string[]; selectableCount?: number };

export interface ChannelActionMessage {
  /** Stable identity within a burst. Generated once when omitted. */
  id?: string;
  /** Exact Mission commitment this item satisfies after provider acknowledgement. */
  requirementId?: string;
  body?: string;
  attachments?: ChannelActionAttachment[];
  native?: ChannelActionNativeContent;
}

export interface ChannelActionItemReceipt {
  itemId: string;
  requirementId: string | null;
  idempotencyKey: string;
  providerMessageId: string;
  providerStatus: string;
  acknowledged: boolean;
  observedAt: string;
  receipt: unknown;
}

export interface ChannelActionIntentRecord {
  id: string;
  workspaceId: string;
  appId: string | null;
  agentId: string | null;
  missionId: string | null;
  requesterIdentityId: string | null;
  connectionId: string;
  peerIdentityId: string | null;
  recipientQuery: string | null;
  requiredSlots: string[];
  conversationId: string | null;
  subjectId: string | null;
  goalRef: string | null;
  goal: string;
  body: string;
  messages: ChannelActionMessage[];
  authorizationBasis: ChannelActionAuthorizationBasis;
  riskCategory: string;
  status: ChannelActionStatus;
  approvalId: string | null;
  idempotencyKey: string;
  attempts: number;
  scheduledFor: string | null;
  providerReceipt: unknown;
  effectReceipts: ChannelActionItemReceipt[];
  postAckMutations: Array<{
    kind: 'app_data_update';
    appId: string;
    collection: string;
    recordId: string;
    patch: Record<string, unknown>;
    expectedVersion?: number;
    receiptKind?: 'data_mutation' | 'subject_update';
  }>;
  lastError: string | null;
  authorizedAt: string | null;
  executedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}
