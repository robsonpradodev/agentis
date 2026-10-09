/**
 * Relationship cohort tool — how an agent answers "who actually went quiet?".
 *
 * A standing goal like "re-engage leads who stopped replying" used to be
 * unactionable: nothing exposed the message ledger, so the model listed whatever
 * contacts it could reach and messaged all of them, including people who had
 * never held a conversation. This tool makes the cohort a query with real
 * predicates, and reports what each filter dropped so an empty or surprising
 * result is diagnosable rather than mysterious.
 */

import { AgentisError } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

export function registerRelationshipQueryTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.relationship.query',
        family: 'inspect',
        mcpExposed: true,
        description:
          'Select a cohort of relationships by their real conversation history — the tool to use before any outreach to more than one person. '
          + 'Answers "who stopped replying", "who did we promise something to", "who is stuck at this stage". '
          + 'It reads the message ledger, so it distinguishes a lead who went silent from an address-book contact who never spoke to you, '
          + 'from a thread a human took over, from someone you are already mid-answer with. '
          + 'Defaults are deliberately conservative: at least one inbound message ever, active engagements only, no one who already has an action planned, no human-handled threads, no owner chats. '
          + 'Feed `members` straight into agentis.followup.schedule as `subjects` — do not message them from here, and do not loop. '
          + 'Read `excluded` to understand why the cohort is the size it is before widening any filter.',
        inputSchema: {
          type: 'object',
          properties: {
            silentForHours: { type: 'number', description: 'They have not written for at least this many hours. The core stall predicate — e.g. 24.' },
            lastMessageFrom: { type: 'string', enum: ['agent', 'contact', 'any'], description: '"agent" means you spoke last and they never came back — the honest reading of "stopped responding". Default any.' },
            minInboundMessages: { type: 'number', description: 'Minimum messages they ever sent you. Default 1. Lowering it to 0 includes contacts who never spoke to you at all; do not.' },
            quietSinceOutboundHours: { type: 'number', description: 'Cooldown: skip anyone you contacted more recently than this.' },
            stages: { type: 'array', items: { type: 'string' }, description: 'Only these pipeline stages.' },
            excludeStages: { type: 'array', items: { type: 'string' }, description: 'Never these stages (e.g. already closed or opted out).' },
            engagementStatus: { type: 'array', items: { type: 'string' }, description: 'Engagement statuses to include. Default ["active"].' },
            includePlanned: { type: 'boolean', description: 'Include people who already have an action planned. Default false — including them double-books the same person.' },
            maxFollowUpAttempts: { type: 'number', description: 'Skip anyone already followed up this many times or more.' },
            includeHumanHandoff: { type: 'boolean', description: 'Include threads a human took over. Default false.' },
            includeOwner: { type: 'boolean', description: 'Include the operator\'s own control chats. Default false.' },
            connectionId: { type: 'string', description: 'Restrict to one channel connection.' },
            channelKind: { type: 'string', description: 'Restrict to one channel kind (e.g. whatsapp).' },
            appId: { type: 'string', description: 'Restrict to one App\'s conversations.' },
            limit: { type: 'number', description: 'Max members returned, 1-200 (default 50). Longest-silent first.' },
          },
        },
        mutating: false,
      },
      handler: (args, ctx) => {
        if (!deps.relationshipCohorts) throw new AgentisError('VALIDATION_FAILED', 'relationship cohort runtime not configured');
        const result = deps.relationshipCohorts.query({
          workspaceId: ctx.workspaceId,
          ...(typeof args.silentForHours === 'number' ? { silentForHours: args.silentForHours } : {}),
          ...(args.lastMessageFrom === 'agent' || args.lastMessageFrom === 'contact' || args.lastMessageFrom === 'any'
            ? { lastMessageFrom: args.lastMessageFrom } : {}),
          ...(typeof args.minInboundMessages === 'number' ? { minInboundMessages: args.minInboundMessages } : {}),
          ...(typeof args.quietSinceOutboundHours === 'number' ? { quietSinceOutboundHours: args.quietSinceOutboundHours } : {}),
          ...(Array.isArray(args.stages) ? { stages: stringList(args.stages) } : {}),
          ...(Array.isArray(args.excludeStages) ? { excludeStages: stringList(args.excludeStages) } : {}),
          ...(Array.isArray(args.engagementStatus) ? { engagementStatus: stringList(args.engagementStatus) } : {}),
          ...(typeof args.includePlanned === 'boolean' ? { includePlanned: args.includePlanned } : {}),
          ...(typeof args.maxFollowUpAttempts === 'number' ? { maxFollowUpAttempts: args.maxFollowUpAttempts } : {}),
          ...(typeof args.includeHumanHandoff === 'boolean' ? { includeHumanHandoff: args.includeHumanHandoff } : {}),
          ...(typeof args.includeOwner === 'boolean' ? { includeOwner: args.includeOwner } : {}),
          ...(typeof args.connectionId === 'string' ? { connectionId: args.connectionId } : {}),
          ...(typeof args.channelKind === 'string' ? { channelKind: args.channelKind } : {}),
          ...(typeof args.appId === 'string' ? { appId: args.appId } : { ...(ctx.appId ? { appId: ctx.appId } : {}) }),
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        });
        return {
          ...result,
          next: result.members.length === 0
            ? 'No one matches. `excluded` says which filter removed each candidate — read it before widening anything, and never widen minInboundMessages to 0.'
            : `${result.members.length} relationship(s) match, longest-silent first. Arm them in one call: agentis.followup.schedule with subjects: [{ subjectId }, …] and everyMs to pace the batch.`,
        };
      },
    },
  ]);
}

function stringList(value: unknown[]): string[] {
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).slice(0, 30);
}
