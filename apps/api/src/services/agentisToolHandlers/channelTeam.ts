/**
 * agentis.channel.team — "who is my team?" (split out of channel.ts, §file budget).
 *
 * The missing piece behind "let me check with the team": an agent needs a stable
 * recipientRef for its verified staff before it can escalate (agentis.suspend,
 * condition channel_ask) or report status (agentis.channel.send). Without this,
 * the model had no discoverable way to know who counts as staff versus a
 * customer it happens to be mid-conversation with.
 */

import { AgentisError } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

export function registerChannelTeamTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.channel.team',
        family: 'inspect',
        description:
          'Who your verified team is — the workspace owner plus anyone granted delegate authority (Settings → Channel Identities, '
          + 'or the Channels tab). Use this to find a recipientRef for escalating or reporting to a human colleague: "let me check with the '
          + 'team" (feed the recipientRef into agentis.suspend with condition channel_ask), or a proactive status update (agentis.channel.send). '
          + 'An empty result means no one has been granted authority yet — say so plainly rather than guessing a destination or asking the '
          + 'current customer who their team is.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'Restrict to one channel connection. Omit to see everyone verified across every connection.' },
          },
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        if (!deps.channelInbox) throw new AgentisError('CHANNEL_BRIDGE_UNAVAILABLE', 'channel inbox is not configured');
        const connectionId = typeof args.connectionId === 'string' ? args.connectionId : null;
        const team = deps.channelInbox.team(ctx.workspaceId, connectionId);
        return {
          team: team.map((peer) => ({
            recipientRef: peer.recipientRef,
            displayName: peer.displayName,
            role: peer.authorityRole,
            connectionId: peer.connectionId,
            channelKind: peer.channelKind,
          })),
          next: team.length === 0
            ? 'No one is verified as owner or delegate yet. Tell the person you cannot reach a team destination right now, rather than guessing one.'
            : 'Use recipientRef with agentis.suspend (condition channel_ask) to ask a team member and wait for their reply, or agentis.channel.send to report without waiting.',
        };
      },
    },
  ]);
}
