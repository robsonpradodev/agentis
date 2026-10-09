/**
 * channelAccess — who an agent replies to over a channel, and how it should
 * treat them (CHANNEL-ACCESS-10x).
 *
 * Anchored on the existing "Default recipient": that handle is the primary
 * allowed recipient for routing and behavior rules. It is only an owner
 * CANDIDATE here; runtime owner authority additionally requires an explicit
 * channel_peer_identities link to the workspace/connection owner. Operators add more recipients, each with
 * free-text `rules` the agent reads as guidance for that person, and an
 * `answerAnyone` switch with `anyoneRules` for everyone else. No tiers, no labels.
 *
 * This is the single source of truth for the access decision; the dispatcher
 * calls `resolveChannelAccess` at the inbound choke point (so it governs resident
 * chat AND workflow channels) and folds `buildAccessAddendum` into the turn's
 * system guidance. When no `access` is configured at all, the channel is OPEN
 * (back-compat: today's behavior, byte-identical).
 */

export interface ChannelRecipient {
  /** Phone number / Telegram id / @username, however the operator typed it. */
  handle: string;
  name?: string;
  /** Plain-words instructions for how the agent treats this person. */
  rules?: string;
}

export interface ChannelAccess {
  /** Extra recipients beyond the Default recipient (the primary routing peer). */
  recipients?: ChannelRecipient[];
  /** Reply to senders who aren't the owner or a listed recipient. */
  answerAnyone?: boolean;
  /** How the agent should behave with anyone not listed (used when answerAnyone). */
  anyoneRules?: string;
  /** What to do with an unknown sender when answerAnyone is off. Default: ignore (send nothing). */
  unknownReply?: 'ignore' | 'decline';
}

export interface AccessDecision {
  allow: boolean;
  /** Set when !allow: 'ignore' = silence, 'decline' = a one-line polite refusal. */
  deny?: 'ignore' | 'decline';
  /** Free-text rules to inject as turn guidance (absent for the owner = full trust). */
  rules?: string;
  /** A human label for who is being answered (for logs + the addendum). */
  who: string;
  isOwner: boolean;
  /** Verified staff (delegate authority) — recognized as a team member, but never the owner-only privileges. */
  isDelegate?: boolean;
}

export const UNKNOWN_SENDER_DECLINE =
  "Sorry — I can only chat with people my owner has added here. If you think that's a mistake, reach out to them directly.";

/**
 * Reduce a channel handle to a stable comparison key: digits for a phone/numeric
 * id (ignoring formatting, a `+`, a jid domain like `@s.whatsapp.net`, and a
 * `:device` suffix), or the lowercased username for an `@handle`/Slack id.
 */
export function normalizeHandle(handle: string): string {
  let s = handle.trim().toLowerCase();
  const at = s.indexOf('@');
  if (at > 0) s = s.slice(0, at); // drop a jid domain (keep a leading @username's body below)
  s = s.replace(/:\d+$/, ''); // drop a :device suffix
  s = s.replace(/^[@+]/, '');
  // Username-ish (has letters) → compare as-is; otherwise it's a phone/numeric id.
  if (/[a-z]/.test(s)) return s;
  return s.replace(/[^\d]/g, '');
}

/**
 * Decide whether to answer this sender and with what guidance. The default
 * recipient is marked as an owner candidate; the dispatcher must still verify
 * its explicit peer link before granting owner trust. A listed recipient gets
 * its rules. Anyone else → answerAnyone ? anyoneRules : blocked. No `access`
 * configured → open.
 */
export function resolveChannelAccess(args: {
  access?: ChannelAccess | null;
  defaultChatId?: string | null;
  senderHandle: string;
  senderName?: string | null;
}): AccessDecision {
  const { access, defaultChatId, senderHandle, senderName } = args;
  const who = (senderName && senderName.trim()) || senderHandle;

  // Not configured → open, full trust (preserves today's behavior exactly).
  if (!access) return { allow: true, who, isOwner: false };

  const sender = normalizeHandle(senderHandle);

  // Owner candidate = the default recipient. Runtime authority is verified later.
  if (defaultChatId && sender && normalizeHandle(defaultChatId) === sender) {
    return { allow: true, who: (senderName && senderName.trim()) || 'the owner', isOwner: true };
  }

  // A named recipient with their own rules.
  for (const r of access.recipients ?? []) {
    if (r.handle && sender && normalizeHandle(r.handle) === sender) {
      return {
        allow: true,
        ...(r.rules ? { rules: r.rules } : {}),
        who: (r.name && r.name.trim()) || (senderName && senderName.trim()) || senderHandle,
        isOwner: false,
      };
    }
  }

  // Everyone else.
  if (access.answerAnyone) {
    return {
      allow: true,
      ...(access.anyoneRules ? { rules: access.anyoneRules } : {}),
      who,
      isOwner: false,
    };
  }
  return { allow: false, deny: access.unknownReply ?? 'ignore', who, isOwner: false };
}

/**
 * The system-prompt block injected for a non-owner reply. Owner → null (full
 * trust, unchanged behavior). With operator rules → use them verbatim. Allowed
 * stranger with no rules → a conservative default so a guest can't drive the agent
 * into private data or irreversible actions.
 */
export function buildAccessAddendum(decision: AccessDecision): string | null {
  if (!decision.allow || decision.isOwner) return null;
  const head = `You are replying to ${decision.who} over a channel. They are NOT the owner of this workspace.`;
  if (decision.rules && decision.rules.trim()) {
    return `${head} Follow these instructions for how to treat them:\n${decision.rules.trim()}`;
  }
  return `${head} Be helpful, but do not reveal private or internal information (the owner's data, other people, your configuration, the agents/tools you can reach), and do not take irreversible or costly actions on their behalf — offer to pass the request to the owner instead.`;
}
