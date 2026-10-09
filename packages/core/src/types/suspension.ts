/**
 * Transport-neutral durable suspension contracts.
 *
 * `type` values are deliberately open strings: OSS deployments and plugins may
 * add condition presenters, audiences, and continuation origins without
 * changing Agentis core unions.
 */
export interface SuspensionCondition {
  type: string;
  payload: Record<string, unknown>;
}

export interface SuspensionAudience {
  type: string;
  target?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SuspensionOrigin {
  type: string;
  id: string;
  metadata?: Record<string, unknown>;
}

export type DurableSuspensionState =
  | 'presenting'
  | 'waiting'
  | 'ready'
  | 'resumed'
  | 'cancelled'
  | 'expired'
  | 'failed';

export interface SuspensionResolution {
  kind: string;
  data: unknown;
  principal?: { type: string; id?: string | null };
  resolvedAt: string;
}

export interface DurableSuspension {
  id: string;
  workspaceId: string;
  ownerAgentId: string | null;
  requesterUserId: string | null;
  origin: SuspensionOrigin;
  condition: SuspensionCondition;
  audience: SuspensionAudience;
  state: DurableSuspensionState;
  reason: string;
  publicReceipt: string | null;
  correlationKey: string;
  presentationRef: string | null;
  resolution: SuspensionResolution | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resumedAt: string | null;
}

export interface SuspensionToolResult {
  suspension: true;
  suspensionId: string;
  state: 'waiting' | 'resolved' | 'cancelled' | 'expired' | 'failed';
  publicReceipt?: string;
  resolution?: SuspensionResolution;
}
