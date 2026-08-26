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
}

export interface ChannelActionIntentRecord {
  id: string;
  workspaceId: string;
  appId: string | null;
  agentId: string | null;
  requesterIdentityId: string | null;
  connectionId: string;
  peerIdentityId: string;
  conversationId: string | null;
  subjectId: string | null;
  goalRef: string | null;
  goal: string;
  body: string;
  messages: Array<{ body?: string }>;
  authorizationBasis: ChannelActionAuthorizationBasis;
  riskCategory: string;
  status: ChannelActionStatus;
  approvalId: string | null;
  idempotencyKey: string;
  attempts: number;
  scheduledFor: string | null;
  providerReceipt: unknown;
  lastError: string | null;
  authorizedAt: string | null;
  executedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}
