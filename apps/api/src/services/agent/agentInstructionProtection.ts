import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { AgentisError, type AgentisToolContext } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';

export interface InstructionProtection {
  version: 1;
  administratorAgentId: string;
  profile?: 'clinic_reception' | 'clinic_administration';
  lockedSections: Record<string, string>;
  maxLength: number;
}

export interface InstructionAgent {
  id: string;
  instructions: string | null;
  config: unknown;
}

export interface InstructionReplacement { before: string; after: string }

export function instructionRevision(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function instructionProtection(config: unknown): InstructionProtection | null {
  const value = (config as Record<string, unknown> | null)?.instructionProtection;
  if (!value) return null;
  const policy = value as InstructionProtection;
  if (policy.version !== 1 || !policy.administratorAgentId || !policy.lockedSections
    || !Object.keys(policy.lockedSections).length || !Number.isInteger(policy.maxLength)) {
    throw new AgentisError('AUTH_FORBIDDEN', 'Invalid instruction protection: repair it administratively; do not bypass it.');
  }
  return policy;
}

/** Only level-two sections are editable units. Nested headings stay in their parent. */
export function instructionSections(text: string): Map<string, string> {
  const headings = [...text.matchAll(/^## (.+)\r?$/gm)];
  const sections = new Map<string, string>();
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i]![1]!.trim();
    if (sections.has(heading)) throw new AgentisError('VALIDATION_FAILED', `Duplicate instruction section: ${heading}`);
    sections.set(heading, text.slice(headings[i]!.index, headings[i + 1]?.index ?? text.length).trim());
  }
  return sections;
}

export function protectInstructionSections(text: string, administratorAgentId: string, headings: string[], profile?: InstructionProtection['profile']): InstructionProtection {
  const sections = instructionSections(text);
  const lockedSections: Record<string, string> = {};
  for (const heading of headings) {
    const section = sections.get(heading);
    if (!section) throw new AgentisError('VALIDATION_FAILED', `Missing protected section: ${heading}`);
    lockedSections[heading] = instructionRevision(section);
  }
  return { version: 1, administratorAgentId, ...(profile ? { profile } : {}), lockedSections, maxLength: 7_500 };
}

export function assertProtectedInstructions(agent: InstructionAgent, next: string | null): void {
  const policy = instructionProtection(agent.config);
  if (!policy) return;
  if (!next || next.length > policy.maxLength) {
    throw new AgentisError('VALIDATION_FAILED', `Protected instructions must be present and at most ${policy.maxLength} characters; keep edits focused.`);
  }
  const sections = instructionSections(next);
  for (const [heading, hash] of Object.entries(policy.lockedSections)) {
    const section = sections.get(heading);
    if (!section || instructionRevision(section) !== hash) {
      throw new AgentisError('AUTH_FORBIDDEN', `Protected instruction section cannot be changed: ${heading}. Edit communication examples or clinic data instead.`);
    }
  }
}

/** Runtime-setting forms often send a fresh config: they must not erase protection. */
export function preserveInstructionProtection(existing: unknown, next: Record<string, unknown>): Record<string, unknown> {
  const policy = instructionProtection(existing);
  if (!policy) return next;
  if ('instructionProtection' in next && JSON.stringify(next.instructionProtection) !== JSON.stringify(policy)) {
    throw new AgentisError('AUTH_FORBIDDEN', 'Instruction protection cannot be removed or changed through ordinary agent settings.');
  }
  const old = existing as Record<string, unknown>;
  return { ...next, instructionProtection: policy, ...(old.clinicProfile ? { clinicProfile: old.clinicProfile } : {}), ...(old.instructionEditHistory ? { instructionEditHistory: old.instructionEditHistory } : {}), ...(old.clinicAdministration ? { clinicAdministration: old.clinicAdministration } : {}), ...(old.clinicEditHistory ? { clinicEditHistory: old.clinicEditHistory } : {}) };
}

export function assertInstructionToolReplacement(agent: InstructionAgent, proposed: unknown): void {
  if (proposed !== undefined && instructionProtection(agent.config) && proposed !== agent.instructions) {
    throw new AgentisError('AUTH_FORBIDDEN', 'This agent requires surgical instruction edits. Use agentis.agents.instructions.inspect, then agentis.agents.instructions.patch; never replace its entire prompt.');
  }
}

/** Account ownership alone is insufficient: channel ingress uses the connection owner's userId even for patients. */
export function assertVerifiedClinicOperator(db: AgentisSqliteDb, ctx: AgentisToolContext, administratorAgentId?: string): void {
  const workspace = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ctx.workspaceId)).get();
  if (!workspace || workspace.userId !== ctx.userId) throw new AgentisError('AUTH_FORBIDDEN', 'Only the workspace operator can administer clinic configuration.');
  if (administratorAgentId && ctx.agentId && ctx.agentId !== administratorAgentId) {
    throw new AgentisError('AUTH_FORBIDDEN', 'Send persistent configuration changes to the clinic orchestrator, not the patient agent.');
  }
  if (!ctx.channelOrigin) return;
  const origin = ctx.channelOrigin;
  if (origin.kind !== 'telegram' || origin.ownerVerified !== true || !ctx.agentId) {
    throw new AgentisError('AUTH_FORBIDDEN', 'Clinic channel administration requires a verified operator on its dedicated Telegram connection.');
  }
  const connection = db.select().from(schema.channelConnections).where(and(
    eq(schema.channelConnections.id, origin.connectionId), eq(schema.channelConnections.workspaceId, ctx.workspaceId),
  )).get();
  const settings = connection?.settings as { access?: { answerAnyone?: boolean } } | undefined;
  if (!connection || connection.kind !== 'telegram' || connection.userId !== ctx.userId
    || connection.agentId !== ctx.agentId || settings?.access?.answerAnyone !== false) {
    throw new AgentisError('AUTH_FORBIDDEN', 'Use a closed administrative Telegram connection bound to the orchestrator.');
  }
  const peers = db.select().from(schema.channelPeerIdentities).where(and(
    eq(schema.channelPeerIdentities.workspaceId, ctx.workspaceId), eq(schema.channelPeerIdentities.connectionId, origin.connectionId),
  )).all();
  const owner = peers.find((peer) => peer.handle === origin.chatId && peer.userId === ctx.userId
    && peer.authorityRole === 'owner' && !!peer.verifiedAt && !peer.blocked
    && (!peer.grantExpiresAt || new Date(peer.grantExpiresAt).getTime() > Date.now()));
  if (!owner) throw new AgentisError('AUTH_FORBIDDEN', 'The Telegram sender has no current verified owner grant.');
}

export function patchAgentInstructions(
  db: AgentisSqliteDb, ctx: AgentisToolContext,
  input: { agentId: string; expectedRevision: string; replacements: InstructionReplacement[]; dryRun?: boolean },
) {
  return db.transaction(() => {
    const agent = db.select().from(schema.agents).where(and(
      eq(schema.agents.id, input.agentId), eq(schema.agents.workspaceId, ctx.workspaceId),
    )).get();
    if (!agent) throw new AgentisError('RESOURCE_NOT_FOUND', 'Agent not found in this workspace.');
    const policy = instructionProtection(agent.config);
    assertVerifiedClinicOperator(db, ctx, policy?.administratorAgentId);
    const original = agent.instructions ?? '';
    if (instructionRevision(original) !== input.expectedRevision) {
      throw new AgentisError('RESOURCE_CONFLICT', 'Instructions changed since inspection. Read the current revision before retrying.');
    }
    if (!Array.isArray(input.replacements) || !input.replacements.length || input.replacements.length > 4) {
      throw new AgentisError('VALIDATION_FAILED', 'Supply one to four exact, focused replacements.');
    }
    let next = original;
    let changeSize = 0;
    for (const replacement of input.replacements) {
      if (typeof replacement.before !== 'string' || typeof replacement.after !== 'string' || !replacement.before) {
        throw new AgentisError('VALIDATION_FAILED', 'Each replacement needs a nonempty exact before string and an after string.');
      }
      const index = next.indexOf(replacement.before);
      if (index < 0 || next.indexOf(replacement.before, index + 1) >= 0) {
        throw new AgentisError('RESOURCE_CONFLICT', 'The before text must match exactly once. Inspect and use a unique local excerpt.');
      }
      changeSize += replacement.before.length + replacement.after.length;
      if (changeSize > 2_400) throw new AgentisError('VALIDATION_FAILED', 'This is a broad rewrite, not a local edit. Review it through the authenticated instruction editor without changing protected sections.');
      next = next.slice(0, index) + replacement.after + next.slice(index + replacement.before.length);
    }
    assertProtectedInstructions(agent, next);
    const revision = instructionRevision(next);
    const preview = { agentId: agent.id, applied: false, verified: false, previousRevision: input.expectedRevision, revision, replacements: input.replacements, protectedSections: Object.keys(policy?.lockedSections ?? {}) };
    if (input.dryRun !== false || next === original) return preview;
    const config = agent.config as Record<string, unknown>;
    const history = Array.isArray(config.instructionEditHistory) ? config.instructionEditHistory : [];
    db.update(schema.agents).set({ instructions: next, updatedAt: new Date().toISOString(), config: {
      ...config, instructionEditHistory: [...history, {
        at: new Date().toISOString(), userId: ctx.userId, actorAgentId: ctx.agentId ?? null,
        connectionId: ctx.channelOrigin?.connectionId ?? null, previousRevision: input.expectedRevision,
        revision, replacements: input.replacements,
      }].slice(-20),
    } }).where(eq(schema.agents.id, agent.id)).run();
    return { ...preview, applied: true, verified: true };
  });
}
