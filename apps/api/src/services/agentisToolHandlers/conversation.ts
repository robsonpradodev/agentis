/**
 * Conversation-script tool family (GAP B1/B3) — a GENERAL primitive: lets an agent
 * install and start a per-contact conversation state machine on ANY App (support,
 * booking, onboarding, surveys, reminders, sales, moderation, any channel), instead
 * of improvising the whole thing with datastore bookkeeping and a full agent turn
 * per message. Nothing here is tied to a use case.
 *
 *   agentis.conversation.define  — install the App's script (stages + transitions).
 *   agentis.conversation.enroll  — start one contact (the first outbound touch).
 *
 * The dispatcher then advances each enrolled contact automatically on every inbound
 * reply; deterministic stages (e.g. the timed greeting) cost ZERO tokens.
 */

import { AgentisError } from '@agentis/core';
import type { AgentisToolContext } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import { staggeredStarts } from '../workflow/deferredStart.js';
import type { ToolHandlerDeps } from './deps.js';

function resolveAppId(args: Record<string, unknown>, ctx: AgentisToolContext): string {
  const appId = (typeof args.appId === 'string' && args.appId.trim()) || ctx.appId;
  if (!appId) throw new AgentisError('VALIDATION_FAILED', 'appId is required (pass appId, or call from an App surface)');
  return appId;
}

export function registerConversationTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.conversation.define',
        family: 'build',
        mcpExposed: true,
        description:
          'Install a per-contact CONVERSATION SCRIPT on an App — a declarative state machine the channel '
          + 'dispatcher advances automatically on each inbound reply (the platform primitive for "send → await '
          + 'their reply → branch → run a workflow → stop"). Prefer this over hand-writing stage bookkeeping. '
          + 'Each stage has an `entry` (send_deterministic = templated, ZERO tokens, supports {greeting} + '
          + '{facts.x}; send_agent = a small model composes one message; run_workflow = trigger a workflow and '
          + 'rest until it completes; none) and a transition (`onReply`: goto | classify→branches; `onComplete`: '
          + 'goto for run_workflow). Mark the final stage `terminal:true` to STOP. Contacts persist to the '
          + '`contactCollection` (a DataBoard can render the pipeline).',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'Target App (optional when on an App surface).' },
            script: {
              type: 'object',
              description:
                'ConversationScript: { initialStage, contactCollection?, stages: [{ id, label?, entry?, onReply?, onComplete?, terminal? }] }. '
                + 'entry.kind ∈ send_deterministic{template} | send_agent{brief,attachFrom?} | run_workflow{workflowId,inputsFrom?} | none. '
                + 'onReply.kind ∈ goto{stage} | classify{brief,labels[],branches{label:stage}}.',
            },
          },
          required: ['script'],
        },
        mutating: true,
        autoExecute: true,
      },
      handler: (args, ctx) => {
        if (!deps.conversation) throw new AgentisError('VALIDATION_FAILED', 'conversation runtime not configured');
        const appId = resolveAppId(args, ctx);
        const result = deps.conversation.define({ workspaceId: ctx.workspaceId, appId }, args.script);
        return {
          ...result,
          message:
            `Script installed on the App (${result.stages} stage(s)). Contacts persist to "${result.contactCollection}". `
            + 'Next: enroll a contact with agentis.conversation.enroll to start the outbound flow; inbound replies then advance the script automatically.',
        };
      },
    },
    {
      definition: {
        id: 'agentis.conversation.enroll',
        family: 'run',
        mcpExposed: true,
        description:
          'Start contacts through the App\'s conversation script — the outbound first touch (e.g. the deterministic '
          + 'greeting). Each contact then advances INDEPENDENTLY as they reply, at their own pace, for as long as it '
          + 'takes (a reply hours or days later resumes exactly where they left off; a waiting contact is a row, not a '
          + 'process, and costs nothing). Pass `address` for one contact, or `contacts` for many. '
          + 'To pace a batch instead of firing it all at once, set `everyMs` (spacing) — strongly preferred over '
          + 'enrolling in a loop — plus `jitterMs` so the sends do not land on an exact grid. `startAt` defers the '
          + 'whole batch to a chosen time. Deferred contacts wait as `scheduled` rows and are picked up when due, '
          + 'surviving restarts.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'Target App (optional when on an App surface).' },
            address: { type: 'string', description: 'Contact channel address — WhatsApp phone (+55…) or JID, Telegram chat id, etc. Use `contacts` for a batch.' },
            contacts: {
              type: 'array',
              description: 'Batch form: [{ address, facts? }, …]. Enrolled in order, paced by everyMs when set.',
              items: {
                type: 'object',
                properties: {
                  address: { type: 'string' },
                  facts: { type: 'object' },
                },
                required: ['address'],
              },
            },
            connectionId: { type: 'string', description: 'Channel connection to reach the contact on. Optional when exactly one channel is active.' },
            kind: { type: 'string', description: 'Channel kind to auto-resolve the connection (e.g. "whatsapp") when connectionId is omitted.' },
            facts: { type: 'object', description: 'Personalization facts for the contact (e.g. { instagram, brand, mockup }). Used by send_agent stages + inputsFrom.' },
            startAt: { type: 'string', description: 'ISO-8601 instant to begin the first touch (whole batch shifts with it). Omit to start now.' },
            delayMs: { type: 'number', description: 'Wait this long before the first touch. Adds to startAt when both are given.' },
            everyMs: { type: 'number', description: 'Spacing between consecutive contacts in a batch — e.g. 300000 for one every 5 minutes.' },
            jitterMs: { type: 'number', description: 'Random extra wait per contact in [0, jitterMs). Keeps a paced batch off an exact grid.' },
          },
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        if (!deps.conversation) throw new AgentisError('VALIDATION_FAILED', 'conversation runtime not configured');
        const appId = resolveAppId(args, ctx);
        const connectionId = resolveConversationConnectionId(args, deps, ctx);
        const sharedFacts = asFacts(args.facts);
        const roster = readRoster(args, sharedFacts);
        const enrollCtx = { workspaceId: ctx.workspaceId, appId, userId: ctx.userId, ambientId: ctx.ambientId ?? null };

        // One resolver for the whole batch, so spacing is computed from a single
        // clock rather than drifting with each await.
        const starts = staggeredStarts(roster.length, {
          startAt: typeof args.startAt === 'string' ? args.startAt : null,
          delayMs: typeof args.delayMs === 'number' ? args.delayMs : null,
          everyMs: typeof args.everyMs === 'number' ? args.everyMs : null,
          jitterMs: typeof args.jitterMs === 'number' ? args.jitterMs : null,
        });

        const results: Array<AdvanceLike & { address: string; startAt?: string; error?: string }> = [];
        for (const [index, contact] of roster.entries()) {
          const startAt = starts[index] ?? null;
          try {
            const result = await deps.conversation.enroll(
              enrollCtx,
              contact.address,
              connectionId,
              contact.facts,
              { startAt },
            );
            results.push({ ...result, address: contact.address, ...(startAt ? { startAt } : {}) });
          } catch (err) {
            // One bad address must not abort the rest of a paced batch.
            results.push({ handled: false, address: contact.address, reason: 'error', error: (err as Error).message });
          }
        }

        const scheduled = results.filter((r) => r.reason === 'scheduled');
        const failed = results.filter((r) => r.reason === 'error');
        // Single-contact calls keep their original flat shape.
        if (roster.length === 1 && args.contacts === undefined) {
          return { ...results[0], connectionId };
        }
        return {
          connectionId,
          enrolled: results.length - failed.length,
          scheduled: scheduled.length,
          failed: failed.length,
          ...(scheduled.length
            ? { firstTouchAt: scheduled[0]?.startAt, lastTouchAt: scheduled[scheduled.length - 1]?.startAt }
            : {}),
          contacts: results,
          next:
            scheduled.length > 0
              ? `${scheduled.length} contact(s) are scheduled and will be touched automatically as each becomes due — `
                + 'nothing further to call. Each then advances on its own replies, independently.'
              : 'Contacts are enrolled and advance automatically on each inbound reply.',
        };
      },
    },
  ]);
}

/** Shape of a runtime AdvanceResult as the tool re-exposes it, per contact. */
interface AdvanceLike {
  handled: boolean;
  stage?: string;
  action?: string;
  sent?: boolean;
  stopped?: boolean;
  reason?: string;
}

function asFacts(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Normalize the single-contact and batch forms into one roster. Per-contact
 * facts win over the shared `facts` block, which acts as the batch default.
 */
function readRoster(
  args: Record<string, unknown>,
  sharedFacts: Record<string, unknown> | undefined,
): Array<{ address: string; facts: Record<string, unknown> | undefined }> {
  const raw = Array.isArray(args.contacts)
    ? args.contacts
    : [{ address: args.address, facts: undefined }];
  const roster = raw.map((entry) => {
    const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const address = String(record.address ?? '').trim();
    const own = asFacts(record.facts);
    return {
      address,
      facts: own || sharedFacts ? { ...(sharedFacts ?? {}), ...(own ?? {}) } : undefined,
    };
  });
  const missing = roster.findIndex((entry) => !entry.address);
  if (missing >= 0) {
    throw new AgentisError(
      'VALIDATION_FAILED',
      Array.isArray(args.contacts)
        ? `contacts[${missing}].address is required`
        : 'address is required (or pass contacts: [{ address }, …])',
    );
  }
  const seen = new Set<string>();
  for (const entry of roster) {
    // A duplicate address would enrol once and silently no-op the rest — better
    // to say so than to report a batch size the App never actually contacted.
    if (seen.has(entry.address)) {
      throw new AgentisError('VALIDATION_FAILED', `duplicate address in contacts: ${entry.address}`);
    }
    seen.add(entry.address);
  }
  return roster;
}

/** Explicit connectionId, else the single active channel (optionally filtered by kind). */
export function resolveConversationConnectionId(
  args: Record<string, unknown>,
  deps: ToolHandlerDeps,
  ctx: AgentisToolContext,
): string {
  const explicit = typeof args.connectionId === 'string' ? args.connectionId.trim() : '';
  if (explicit) return explicit;
  if (!deps.channels) throw new AgentisError('VALIDATION_FAILED', 'no channel bridge configured; pass connectionId');
  const kind = typeof args.kind === 'string' ? args.kind.trim() : '';
  const active = deps.channels
    .list(ctx.workspaceId)
    .filter((c) => c.status === 'active' && (!kind || c.kind === kind));

  // A channel-originated turn must continue on that exact connection. For an
  // outbound workflow/tool turn, prefer the channel explicitly bound to the App
  // and then the executing agent's own channel. Talki legitimately has two live
  // WhatsApp accounts; treating that as global ambiguity prevented Bia
  // Outreacher from enrolling contacts even though her own connection is active.
  const originId = ctx.channelOrigin?.connectionId;
  if (originId && active.some((connection) => connection.id === originId)) return originId;
  if (ctx.appId) {
    const appMatches = active.filter((connection) => connection.appId === ctx.appId);
    if (appMatches.length === 1) return appMatches[0]!.id;
  }
  if (ctx.agentId) {
    const agentMatches = active.filter((connection) => connection.agentId === ctx.agentId);
    if (agentMatches.length === 1) return agentMatches[0]!.id;
  }
  const defaults = active.filter((connection) => connection.isDefault);
  if (defaults.length === 1) return defaults[0]!.id;
  if (active.length === 1) return active[0]!.id;
  throw new AgentisError(
    'VALIDATION_FAILED',
    active.length === 0 ? 'no active channel to enroll on; connect one or pass connectionId' : 'multiple active channels; pass connectionId (or kind) to disambiguate',
  );
}
