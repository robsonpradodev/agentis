/**
 * Follow-up tools — how an agent says "come back to this later".
 *
 * Before these, a turn had no way to outlive itself. The agent could send a
 * message and nothing more; the intention behind "I'll check back tomorrow" had
 * nowhere to live, so the conversation simply stopped there. These two verbs put
 * that intention on the Durable Entity spine, where it survives restarts and
 * wakes the agent with the relationship's own state as context.
 *
 * Deliberately small: an agent mid-conversation holds a `recipientRef` and a
 * sentence about what it promised. That is all it should need to arm a wake.
 */

import { AgentisError } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import type { SubjectSelector } from '../followUpService.js';

const SUBJECT_SELECTOR_PROPERTIES = {
  recipientRef: { type: 'string', description: 'peer:<id> from agentis.channel.inbox — the usual way to name someone mid-conversation.' },
  conversationId: { type: 'string', description: 'Name the person by the conversation you are in. Omit both to mean the current channel conversation.' },
  subjectId: { type: 'string', description: 'Relationship Subject id, when you already hold one.' },
  subjectKey: { type: 'string', description: 'Stable subject key (person:<peerKey>).' },
} as const;

export function registerFollowUpTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  const svc = () => {
    if (!deps.followUps) throw new AgentisError('VALIDATION_FAILED', 'follow-up runtime not configured');
    return deps.followUps;
  };

  registry.registerMany([
    {
      definition: {
        id: 'agentis.followup.schedule',
        family: 'run',
        mcpExposed: true,
        autoExecute: true,
        description:
          'Arm a durable future action on a relationship, so this turn does not have to be the last thing you do. '
          + 'Call it whenever you commit to something you cannot finish now — "I\'ll confirm tomorrow", "I\'ll check back if they go quiet", '
          + '"send the link after the payment window". You wake later with this relationship\'s state and act then; the wake survives restarts. '
          + 'One-shot by default: set `cadenceMs` with `maxAttempts` for a bounded sequence of nudges. '
          + 'Arming is cancelled automatically if the person replies first, unless you set `cancelOnReply: false` (use that for something you owe them regardless). '
          + 'Pass `subjects` instead of a single selector to arm a cohort, paced with `everyMs` — never loop this tool over a list. '
          + 'Default timing is 24h out when you give neither `dueAt` nor `delayMs`.',
        inputSchema: {
          type: 'object',
          properties: {
            ...SUBJECT_SELECTOR_PROPERTIES,
            subjects: {
              type: 'array',
              description: 'Cohort form: [{ recipientRef } | { subjectId } | { subjectKey }, …]. Typically the output of agentis.relationship.query.',
              items: { type: 'object', properties: SUBJECT_SELECTOR_PROPERTIES },
            },
            goal: { type: 'string', description: 'What you must accomplish when you wake. Write it as an instruction to your future self, with enough detail to act without re-reading the transcript.' },
            kind: { type: 'string', enum: ['follow_up', 'reply', 'escalate', 'close', 'custom'], description: 'Default follow_up.' },
            dueAt: { type: 'string', description: 'ISO-8601 instant to wake at.' },
            delayMs: { type: 'number', description: 'Wake this long from now. Adds to dueAt when both are given. Omit both for 24h.' },
            everyMs: { type: 'number', description: 'Cohort only: spacing between consecutive wakes (e.g. 120000 for one every 2 minutes).' },
            jitterMs: { type: 'number', description: 'Random extra wait per subject in [0, jitterMs). Keeps a paced cohort off an exact grid.' },
            cadenceMs: { type: 'number', description: 'Spacing to the NEXT attempt after one is performed. Omit for one-shot.' },
            maxAttempts: { type: 'number', description: 'Ceiling on attempts (1-10, default 1). Required in spirit whenever you set a cadence.' },
            cancelOnReply: { type: 'boolean', description: 'Withdraw the action if they write back first. Default true.' },
            preconditions: { type: 'array', items: { type: 'string' }, description: 'Check these before acting on the wake; skip the action if they do not hold.' },
            stopConditions: { type: 'array', items: { type: 'string' }, description: 'Conditions under which the wake should close the action instead of acting.' },
            sourceRef: { type: 'string', description: 'What armed this (standing goal id, mission id). For audit and cohort de-duplication.' },
            replace: { type: 'boolean', description: 'Overwrite an action already planned for this person. Default false — a commitment made inside a live conversation outranks a sweep.' },
          },
          required: ['goal'],
        },
        mutating: true,
      },
      handler: (args, ctx) => {
        const service = svc();
        const shared = {
          workspaceId: ctx.workspaceId,
          goal: String(args.goal ?? ''),
          ...(typeof args.kind === 'string' ? { kind: args.kind as 'follow_up' } : {}),
          ...(typeof args.dueAt === 'string' ? { dueAt: args.dueAt } : {}),
          ...(typeof args.delayMs === 'number' ? { delayMs: args.delayMs } : {}),
          ...(typeof args.jitterMs === 'number' ? { jitterMs: args.jitterMs } : {}),
          ...(typeof args.cadenceMs === 'number' ? { cadenceMs: args.cadenceMs } : {}),
          ...(typeof args.maxAttempts === 'number' ? { maxAttempts: args.maxAttempts } : {}),
          ...(typeof args.cancelOnReply === 'boolean' ? { cancelOnReply: args.cancelOnReply } : {}),
          ...(Array.isArray(args.preconditions) ? { preconditions: stringList(args.preconditions) } : {}),
          ...(Array.isArray(args.stopConditions) ? { stopConditions: stringList(args.stopConditions) } : {}),
          ...(typeof args.sourceRef === 'string' ? { sourceRef: args.sourceRef } : {}),
          ...(typeof args.replace === 'boolean' ? { replace: args.replace } : {}),
        };

        if (Array.isArray(args.subjects)) {
          const subjects = args.subjects.map((entry) => readSelector(entry, ctx.conversationId ?? null));
          const result = service.scheduleMany({
            ...shared,
            subjects,
            ...(typeof args.everyMs === 'number' ? { everyMs: args.everyMs } : {}),
          });
          return {
            ...result,
            next: result.armed > 0
              ? `${result.armed} follow-up(s) armed. Each wakes independently when due — nothing further to call, and do not loop this tool.`
              : 'Nothing was armed. Check `followUps[].reason`: already_planned means a more specific action is already pending for that person.',
          };
        }

        return service.schedule({ ...shared, ...readSelector(args, ctx.conversationId ?? null) });
      },
    },
    {
      definition: {
        id: 'agentis.followup.cancel',
        family: 'run',
        mcpExposed: true,
        autoExecute: true,
        description:
          'Withdraw the action planned for a relationship. Use it when the reason for the follow-up is gone — they bought, they '
          + 'asked to be left alone, or you just did the thing you were going to wake up for. Idempotent: cancelling nothing is not an error.',
        inputSchema: {
          type: 'object',
          properties: {
            ...SUBJECT_SELECTOR_PROPERTIES,
            reason: { type: 'string', description: 'Why it is no longer needed. Recorded on the action for audit.' },
          },
        },
        mutating: true,
      },
      handler: (args, ctx) => svc().cancel(
        ctx.workspaceId,
        readSelector(args, ctx.conversationId ?? null),
        typeof args.reason === 'string' ? args.reason : undefined,
      ),
    },
  ]);
}

/**
 * Read a subject selector, falling back to the conversation the agent is already
 * in. Mid-conversation, "follow up with them" means the person in front of it —
 * forcing an explicit id there would be the kind of friction that stops the model
 * from arming a follow-up at all.
 */
function readSelector(value: unknown, currentConversationId: string | null): SubjectSelector {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const selector: SubjectSelector = {
    ...(typeof record.subjectId === 'string' ? { subjectId: record.subjectId } : {}),
    ...(typeof record.subjectKey === 'string' ? { subjectKey: record.subjectKey } : {}),
    ...(typeof record.recipientRef === 'string' ? { recipientRef: record.recipientRef } : {}),
    ...(typeof record.conversationId === 'string' ? { conversationId: record.conversationId } : {}),
  };
  if (Object.keys(selector).length > 0) return selector;
  if (currentConversationId) return { conversationId: currentConversationId };
  throw new AgentisError('VALIDATION_FAILED', 'name the person: recipientRef, conversationId, subjectId, or subjectKey');
}

function stringList(value: unknown[]): string[] {
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).slice(0, 10);
}
