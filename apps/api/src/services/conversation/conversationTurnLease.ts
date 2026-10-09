import { randomUUID } from 'node:crypto';
import { AgentisError, type ChannelToolOrigin, type ProofReceipt } from '@agentis/core';

export interface ConversationTurnLeaseContext {
  channelOrigin?: ChannelToolOrigin;
  /** Exact catalog this turn may invoke, including through MCP-native harnesses. */
  allowedToolIds?: string[];
  /** Server-selected durable Mission; never accepted from a client header. */
  missionId?: string;
}

export interface TurnToolObservation {
  index: number;
  name: string;
  args: unknown;
  result: unknown;
  ok: boolean;
  mutating: boolean;
  repeats: number;
  durationMs: number;
}

export interface ConversationTurnExperience {
  toolCalls: number;
  observations: TurnToolObservation[];
  recalledAtomIds: string[];
  efficiency: {
    uniqueObservations: number;
    coalescedReads: number;
    mutatingCalls: number;
    argumentCharsObserved: number;
    resultCharsObserved: number;
    repeatedResultChars: number;
  };
}

export function proofReceiptsFromExperience(experience: ConversationTurnExperience): ProofReceipt[] {
  const receipts: ProofReceipt[] = [];
  let mutationFrontier = 0;
  let hasMutation = false;
  for (const observation of experience.observations) {
    if (!observation.ok) continue;
    const facts = proofFacts(observation.result);
    const verificationTool = /(?:revision[._ -]?verify|app[._ -]?verify|doctor|app[._ -]?test|browser|run[._ -]?await|test[._ -]?run|debug[._ -]?run|playwright|probe)/i.test(observation.name);
    const structuralObservation = /(?:inspect|validate|dry[._ -]?run|contract|schema|publish|promote)/i.test(observation.name);
    const executionOrApprovalOnly = /(?:^|[._ -])(?:run|verify|validate|inspect|doctor|test|probe|publish|promote|activate|approve|abandon|discard)(?:$|[._ -])/i.test(observation.name);
    const deliveryMutation = observation.mutating && !executionOrApprovalOnly;
    if (deliveryMutation) {
      mutationFrontier = observation.index;
      hasMutation = true;
    }
    if (deliveryMutation) {
      receipts.push({
        id: randomUUID(),
        kind: 'persisted_mutation',
        status: facts.blocked ? 'blocked' : facts.failed ? 'failed' : 'passed',
        tool: observation.name,
        ...facts.identity,
        evidence: facts.summary,
        observedAt: new Date().toISOString(),
      });
    }
    const explicitVerification = facts.outcome === 'accomplished'
      || (!structuralObservation && facts.verified && Boolean(facts.identity.resourceId) && Boolean(facts.identity.revisionId || facts.identity.semanticHash));
    if (hasMutation && observation.index >= mutationFrontier && (verificationTool || explicitVerification)) {
      receipts.push({
        id: randomUUID(),
        kind: 'functional_verification',
        status: facts.blocked ? 'blocked' : facts.failed ? 'failed' : 'passed',
        tool: observation.name,
        ...facts.identity,
        evidence: facts.summary,
        observedAt: new Date().toISOString(),
      });
    } else if (hasMutation && observation.index >= mutationFrontier && (structuralObservation || facts.published)) {
      receipts.push({
        id: randomUUID(),
        kind: 'observed_state',
        status: facts.blocked ? 'blocked' : facts.failed ? 'failed' : 'passed',
        tool: observation.name,
        ...facts.identity,
        evidence: facts.summary,
        observedAt: new Date().toISOString(),
      });
    }
  }
  return receipts;
}

interface ActiveTurnLease {
  workspaceId: string;
  token: string;
  controller: AbortController;
  toolCalls: number;
  stateVersion: number;
  observations: Array<TurnToolObservation & { argsKey: string; resultKey: string; stateVersion: number }>;
  recalledAtomIds: Set<string>;
  coalescedReads: number;
  mutatingCalls: number;
  argumentCharsObserved: number;
  resultCharsObserved: number;
  repeatedResultChars: number;
  context?: ConversationTurnLeaseContext;
}

/**
 * Server-side capability for one interactive conversation turn.
 *
 * A CLI harness may outlive the HTTP/SSE request that launched it. An AbortSignal
 * is therefore necessary but not sufficient: a late MCP request can arrive after
 * the operator pressed Stop. Every harness-owned MCP call carries this opaque
 * lease and is rejected before dispatch when the lease is no longer current.
 */
export class ConversationTurnLeaseRegistry {
  readonly #active = new Map<string, ActiveTurnLease>();

  issue(workspaceId: string, conversationId: string, context?: ConversationTurnLeaseContext): string {
    this.#active.get(conversationId)?.controller.abort(new Error('turn_superseded'));
    const token = randomUUID();
    this.#active.set(conversationId, {
      workspaceId,
      token,
      controller: new AbortController(),
      toolCalls: 0,
      stateVersion: 0,
      observations: [],
      recalledAtomIds: new Set(),
      coalescedReads: 0,
      mutatingCalls: 0,
      argumentCharsObserved: 0,
      resultCharsObserved: 0,
      repeatedResultChars: 0,
      ...(context ? { context } : {}),
    });
    return token;
  }

  complete(workspaceId: string, conversationId: string, token: string): void {
    const active = this.#active.get(conversationId);
    if (active?.workspaceId === workspaceId && active.token === token) {
      active.controller.abort(new Error('turn_completed'));
      this.#active.delete(conversationId);
    }
  }

  revoke(workspaceId: string, conversationId: string): boolean {
    const active = this.#active.get(conversationId);
    if (!active || active.workspaceId !== workspaceId) return false;
    active.controller.abort(new Error('operator_stop_all'));
    this.#active.delete(conversationId);
    return true;
  }

  assertActive(workspaceId: string, conversationId: string, token: string): AbortSignal {
    const active = this.#active.get(conversationId);
    if (active?.workspaceId === workspaceId && active.token === token && !active.controller.signal.aborted) {
      return active.controller.signal;
    }
    throw new AgentisError(
      'TURN_CANCELLED',
      'This conversation turn was stopped or superseded. The tool was not executed. Do not retry from this turn.',
      {
        remediation: 'Start a new operator turn if more work is required; never reuse the canceled turn lease.',
        details: { conversationId },
      },
    );
  }

  /** Return server-authored turn context after validating the opaque lease. */
  context(workspaceId: string, conversationId: string, token: string): ConversationTurnLeaseContext | undefined {
    this.assertActive(workspaceId, conversationId, token);
    return this.#active.get(conversationId)?.context;
  }

  /**
   * Enrich the server-owned capability after semantic planning has selected a
   * mission. Harnesses receive their lease before that planning round, so the
   * context must be safely updatable without issuing a new token mid-turn.
   */
  updateContext(
    workspaceId: string,
    conversationId: string,
    token: string,
    context: Partial<ConversationTurnLeaseContext>,
  ): ConversationTurnLeaseContext {
    this.assertActive(workspaceId, conversationId, token);
    const active = this.#active.get(conversationId)!;
    active.context = { ...(active.context ?? {}), ...context };
    return active.context;
  }

  /**
   * Record compact, evidence-bearing experience without limiting the harness.
   * Exact repeated reads at the same mutation frontier are coalesced so the
   * model can reuse the observation already in context instead of ingesting it
   * again. Calls still execute; intelligence and reach are never capped.
   */
  recordToolResult(args: {
    workspaceId: string;
    conversationId: string;
    token: string;
    name: string;
    toolArgs: unknown;
    result: unknown;
    ok: boolean;
    mutating: boolean;
    durationMs: number;
  }): { repeated: boolean; observationIndex: number; stateVersion: number } {
    this.assertActive(args.workspaceId, args.conversationId, args.token);
    const active = this.#active.get(args.conversationId)!;
    active.toolCalls += 1;
    const compactArgs = compactExperienceValue(args.toolArgs);
    const compactResult = compactExperienceValue(args.result);
    const argsKey = stableJson(compactArgs);
    const resultKey = stableJson(compactResult);
    active.argumentCharsObserved += argsKey.length;
    active.resultCharsObserved += resultKey.length;
    if (args.mutating) active.mutatingCalls += 1;
    const prior = [...active.observations].reverse().find((entry) =>
      !args.mutating
      && entry.stateVersion === active.stateVersion
      && entry.name === args.name
      && entry.argsKey === argsKey
      && entry.resultKey === resultKey,
    );
    if (prior) {
      prior.repeats += 1;
      prior.durationMs += Math.max(0, Math.round(args.durationMs));
      active.coalescedReads += 1;
      active.repeatedResultChars += resultKey.length;
      return { repeated: true, observationIndex: prior.index, stateVersion: active.stateVersion };
    }

    if (args.mutating && args.ok) active.stateVersion += 1;
    const observation = {
      index: active.toolCalls,
      name: args.name,
      args: compactArgs,
      result: compactResult,
      ok: args.ok,
      mutating: args.mutating,
      repeats: 1,
      durationMs: Math.max(0, Math.round(args.durationMs)),
      argsKey,
      resultKey,
      stateVersion: active.stateVersion,
    };
    // This is a learning/diagnostic working set, not a capability limit. Keep a
    // bounded representative tail while the actual harness may continue freely.
    active.observations.push(observation);
    if (active.observations.length > 160) active.observations.splice(0, active.observations.length - 160);
    return { repeated: false, observationIndex: observation.index, stateVersion: active.stateVersion };
  }

  experience(workspaceId: string, conversationId: string, token: string): ConversationTurnExperience {
    this.assertActive(workspaceId, conversationId, token);
    const active = this.#active.get(conversationId)!;
    return {
      toolCalls: active.toolCalls,
      observations: active.observations.map(({ argsKey: _args, resultKey: _result, stateVersion: _version, ...entry }) => entry),
      recalledAtomIds: [...active.recalledAtomIds],
      efficiency: {
        uniqueObservations: active.observations.length,
        coalescedReads: active.coalescedReads,
        mutatingCalls: active.mutatingCalls,
        argumentCharsObserved: active.argumentCharsObserved,
        resultCharsObserved: active.resultCharsObserved,
        repeatedResultChars: active.repeatedResultChars,
      },
    };
  }

  recordRecalledAtoms(workspaceId: string, conversationId: string, token: string, atomIds: string[]): void {
    this.assertActive(workspaceId, conversationId, token);
    const active = this.#active.get(conversationId)!;
    for (const atomId of atomIds) if (atomId) active.recalledAtomIds.add(atomId);
  }

}

function compactExperienceValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length <= 600 ? value : `${value.slice(0, 600)}…`;
  if (depth >= 4) return '[nested value omitted]';
  if (Array.isArray(value)) {
    const rows = value.slice(0, 16).map((entry) => compactExperienceValue(entry, depth + 1));
    return value.length > rows.length ? [...rows, `[+${value.length - rows.length} more]`] : rows;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 32);
    return Object.fromEntries(entries.map(([key, entry]) => [key, compactExperienceValue(entry, depth + 1)]));
  }
  return String(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function proofFacts(value: unknown): {
  identity: Pick<ProofReceipt, 'resourceKind' | 'resourceId' | 'revisionId' | 'semanticHash' | 'runId' | 'fixtureId'>;
  verified: boolean;
  published: boolean;
  blocked: boolean;
  failed: boolean;
  outcome?: string;
  summary: unknown;
} {
  const flat = flattenProofObject(value);
  const outcome = firstString(flat, ['outcome', 'verdict', 'status']);
  const reason = firstString(flat, ['reason', 'error', 'errorMessage']);
  const passed = firstBoolean(flat, ['passed', 'valid', 'ok', 'verified']);
  const published = firstBoolean(flat, ['published', 'promoted', 'activated']) === true;
  const blocked = outcome === 'blocked' || outcome === 'blocked_on_human' || /blocked|missing|required|not_configured/i.test(reason ?? '');
  const failed = passed === false || /failed|not_accomplished|error/i.test(outcome ?? '');
  return {
    identity: {
      ...(firstString(flat, ['resourceKind', 'kind', 'type']) ? { resourceKind: firstString(flat, ['resourceKind', 'kind', 'type']) } : {}),
      ...(firstString(flat, ['resourceId', 'workflowId', 'appId', 'agentId']) ? { resourceId: firstString(flat, ['resourceId', 'workflowId', 'appId', 'agentId']) } : {}),
      ...(firstString(flat, ['revisionId', 'candidateRevisionId', 'interfaceRevisionId']) ? { revisionId: firstString(flat, ['revisionId', 'candidateRevisionId', 'interfaceRevisionId']) } : {}),
      ...(firstString(flat, ['semanticHash', 'graphHash', 'contentHash']) ? { semanticHash: firstString(flat, ['semanticHash', 'graphHash', 'contentHash']) } : {}),
      ...(firstString(flat, ['runId']) ? { runId: firstString(flat, ['runId']) } : {}),
      ...(firstString(flat, ['fixtureId']) ? { fixtureId: firstString(flat, ['fixtureId']) } : {}),
    },
    verified: passed === true,
    published,
    blocked,
    failed,
    outcome,
    summary: compactExperienceValue(value),
  };
}

function flattenProofObject(value: unknown, depth = 0, target = new Map<string, unknown>()): Map<string, unknown> {
  if (!value || typeof value !== 'object' || depth > 4) return target;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!target.has(key)) target.set(key, entry);
    if (entry && typeof entry === 'object') flattenProofObject(entry, depth + 1, target);
  }
  return target;
}

function firstString(values: Map<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = values.get(key);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function firstBoolean(values: Map<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = values.get(key);
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}
