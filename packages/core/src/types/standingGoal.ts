export type AgentStandingGoalStatus = 'draft' | 'active' | 'paused';

export interface AgentStandingGoalPolicy {
  appIds: string[];
  connectionIds: string[];
  capabilities: string[];
  actionCategories: string[];
  eventWakes: string[];
  reconciliationIntervalMinutes: number;
  quietHours?: { start: number; end: number; timezone?: string } | null;
  maxActionsPerHour?: number | null;
  suppressionEnabled: boolean;
  respectHumanHandoff: boolean;
  ownerNotifications: 'material_and_blockers' | 'blockers_only' | 'all';
}

export interface AgentStandingGoal {
  id: string;
  workspaceId: string;
  agentId: string;
  title: string;
  objective: string;
  sourceInstructions: string;
  status: AgentStandingGoalStatus;
  version: number;
  policy: AgentStandingGoalPolicy;
  activatedAt: string | null;
  pausedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
