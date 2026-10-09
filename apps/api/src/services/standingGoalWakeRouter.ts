import { and, eq } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS, type AgentStandingGoalPolicy } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { BusMessage } from '../event-bus.js';
import type { DurableEntityService } from './durableEntities.js';
import type { AgentMissionService } from './agentMissions.js';
import { createHash } from 'node:crypto';

/** Routes existing platform events into active resident Agent inboxes. No scheduler is added. */
export class StandingGoalWakeRouter {
  constructor(private readonly db: AgentisSqliteDb, private readonly entities: DurableEntityService, private readonly missions?: AgentMissionService) {}

  handle(message: BusMessage): number {
    const payload = object(message.envelope.payload);
    const workspaceId = string(payload.workspaceId) ?? workspaceFromRoom(message.room);
    if (!workspaceId || message.room !== REALTIME_ROOMS.workspace(workspaceId)) return 0;
    const wake = wakeName(message.envelope.event, payload);
    if (!wake) return 0;
    const appId = string(payload.appId);
    const connectionId = string(payload.connectionId) ?? string(payload.channelConnectionId);
    const goals = this.db.select().from(schema.agentStandingGoals).where(and(
      eq(schema.agentStandingGoals.workspaceId, workspaceId), eq(schema.agentStandingGoals.status, 'active'),
    )).all();
    const matchingGoals: typeof goals = [];
    for (const goal of goals) {
      const policy = goal.policyJson as AgentStandingGoalPolicy;
      if (!policy.eventWakes?.includes(wake) && !policy.eventWakes?.includes(message.envelope.event)) continue;
      if (appId && policy.appIds?.length && !policy.appIds.includes(appId)) continue;
      if (connectionId && policy.connectionIds?.length && !policy.connectionIds.includes(connectionId)) continue;
      matchingGoals.push(goal);
    }
    let posted = 0;
    for (const goal of matchingGoals) {
      if (this.missions) {
        const eventKey = message.envelope.correlationId ?? createHash('sha256')
          .update(`${message.envelope.event}:${JSON.stringify(payload)}`).digest('hex').slice(0, 24);
        this.missions.create({
          workspaceId, ownerAgentId: goal.agentId, standingGoalId: goal.id,
          appId: appId ?? (goal.policyJson as AgentStandingGoalPolicy).appIds?.[0] ?? null,
          sourceKind: 'standing_goal', sourceRef: goal.id,
          correlationKey: `standing-goal:${goal.id}:event:${eventKey}`,
          objective: goal.objective, nextWakeAt: new Date().toISOString(),
        });
        posted += 1;
        continue;
      }
      const entity = this.entities.getByKey(workspaceId, 'agent', goal.agentId);
      if (!entity || entity.status !== 'active') continue;
      this.entities.post(entity.id, wake, { goalWake: wake, event: message.envelope.event, payload });
      posted += 1;
    }
    return posted;
  }
}

function wakeName(event: string, payload: Record<string, unknown>): string | null {
  if (event === REALTIME_EVENTS.DATA_CHANGED) {
    return payload.collection === 'leads' && (payload.op === 'insert' || payload.op === 'upsert') ? 'lead.created' : 'app.data_changed';
  }
  if (event === REALTIME_EVENTS.APPROVAL_RESOLVED) return 'approval.resolved';
  if (event === REALTIME_EVENTS.CHANNEL_MESSAGE_RECEIVED) return 'channel.inbound';
  if (event === REALTIME_EVENTS.CHANNEL_MESSAGE_STATUS) return 'channel.action.settled';
  if (event === REALTIME_EVENTS.RUN_FAILED) return 'workflow.failed';
  if (event === REALTIME_EVENTS.RUN_COMPLETED) return 'workflow.completed';
  return null;
}
function workspaceFromRoom(room: string): string | null { return room.startsWith('workspace:') ? room.slice('workspace:'.length) : null; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown): string | null { return typeof value === 'string' && value ? value : null; }
