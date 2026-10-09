import type { AgentisToolContext, SuspensionAudience, SuspensionCondition, SuspensionOrigin } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

export function registerSuspensionTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.suspend',
        mcpExposed: true,
        family: 'run',
        description:
          'Durably suspend the current execution until a typed condition is resolved, then continue from the stored resolution. ' +
          'Conditions and audiences are extensible. Two built-in conditions: ' +
          '(1) {type:"human_response",payload:{prompt,fields}} with audience {type:"workspace_role",target:"operator"} — surfaces in the Agentis operator inbox. ' +
          '(2) {type:"channel_ask",payload:{recipientRef,prompt,title?,connectionId?}} with audience {type:"channel_thread"} — sends the question as a real message through a channel thread (resolve recipientRef with agentis.channel.inbox first, e.g. the team\'s WhatsApp) and resumes when anyone replies there. ' +
          'This is how you say "let me check with the team and get back to you": send that as your reply or publicReceipt, call agentis.suspend with channel_ask, and you continue automatically once they answer — you do not have to end the conversation to wait for someone else. ' +
          'Use only when execution genuinely cannot continue now. publicReceipt is safe to send to the current recipient while the execution waits.',
        inputSchema: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: 'Why execution cannot continue without this condition.' },
            condition: {
              type: 'object',
              description: 'Typed wait condition. Types are supplied by registered suspension presenters.',
              properties: { type: { type: 'string' }, payload: { type: 'object' } },
              required: ['type', 'payload'],
            },
            audience: {
              type: 'object',
              description: 'Who or what may resolve the condition.',
              properties: { type: { type: 'string' }, target: { type: 'string' }, metadata: { type: 'object' } },
              required: ['type'],
            },
            publicReceipt: { type: 'string', description: 'Safe acknowledgement shown to the current recipient before parking.' },
            correlationKey: { type: 'string', description: 'Optional stable idempotency key within this origin.' },
            expiresAt: { type: 'string', description: 'Optional ISO expiry.' },
            originKey: { type: 'string', description: 'Required only for callers without a durable chat, channel, or run origin.' },
          },
          required: ['reason', 'condition', 'audience'],
        },
        mutating: false,
        autoExecute: true,
        approval: { riskLevel: 'low', reversible: true, externalSideEffects: false },
      },
      handler: async (args: Record<string, unknown>, ctx: AgentisToolContext) => {
        if (!deps.suspensions) return { ok: false, error: 'durable suspension runtime is not available' };
        const condition = record(args.condition) as SuspensionCondition | null;
        const audience = record(args.audience) as SuspensionAudience | null;
        if (!condition || !audience) throw new Error('condition and audience are required');
        const origin = originOf(ctx, args.originKey);
        // A host-provided origin key is an explicit polling contract: that host
        // replays the call to consume the resolution. Managed executions must
        // have a registered wake adapter or parking them would be a dead end.
        const externallyResumed = typeof args.originKey === 'string' && args.originKey.trim().length > 0;
        if (!externallyResumed && !deps.suspensions.canResumeOrigin(origin.type)) {
          throw new Error(`execution origin '${origin.type}' cannot be suspended because no resumer is registered`);
        }
        return deps.suspensions.suspend({
          workspaceId: ctx.workspaceId,
          ownerAgentId: ctx.agentId ?? null,
          requesterUserId: ctx.userId,
          origin,
          condition,
          audience,
          reason: String(args.reason ?? ''),
          ...(typeof args.publicReceipt === 'string' ? { publicReceipt: args.publicReceipt } : {}),
          ...(typeof args.correlationKey === 'string' ? { correlationKey: args.correlationKey } : {}),
          ...(typeof args.expiresAt === 'string' ? { expiresAt: args.expiresAt } : {}),
          continuation: ctx.channelContinuation ?? null,
        });
      },
    },
  ], { defaultMcpExposed: true });
}

function originOf(ctx: AgentisToolContext, originKey: unknown): SuspensionOrigin {
  if (ctx.channelOrigin && ctx.durableTurnId) return { type: 'channel_turn', id: ctx.durableTurnId };
  if (ctx.durableTurnId) return { type: 'conversation_turn', id: ctx.durableTurnId };
  if (ctx.runId) return { type: 'workflow_run', id: ctx.runId };
  if (typeof originKey === 'string' && originKey.trim()) return { type: `${ctx.caller}_call`, id: originKey.trim() };
  throw new Error('this caller needs originKey because it has no durable execution identity');
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
