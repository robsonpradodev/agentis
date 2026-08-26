import type {
  ChatContextManifest,
  ChatExecutionEnvelope,
  ConversationExecutionMode,
  ConversationTurnStatus,
  EffectiveConversationExecutionMode,
  TurnEventV2,
  TurnChangeSummary,
} from '@agentis/core';

export interface DurableConversationTurn {
  id: string;
  conversationId: string;
  agentId: string;
  clientTurnId: string;
  messageId?: string | null;
  planId?: string | null;
  requestedMode: ConversationExecutionMode;
  effectiveMode: EffectiveConversationExecutionMode;
  permissionMode: string;
  status: ConversationTurnStatus;
  executionEnvelope?: ChatExecutionEnvelope | null;
  contextManifest?: ChatContextManifest | null;
  lastEventSeq: number;
  error?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  changeSet?: TurnChangeSummary | null;
}

export interface DurableConversationTurnHistory {
  turn: DurableConversationTurn;
  events: TurnEventV2[];
}
