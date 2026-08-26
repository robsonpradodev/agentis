/**
 * Subject tools (Agent-Native §3.2) — drive per-subject durable actors on the spine.
 *
 * An agent enrolls a subject (a lead, ticket, order…) with a declarative lifecycle
 * script; the Durable Entity dispatcher runs it — deterministic sends, agent steps,
 * and waits that park for a reply days later, out of order. `post` delivers an
 * external event (a reply) into a subject's inbox, waking it to advance.
 */

import { AgentisError } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { normalizeRelationshipState } from '../relationshipStateService.js';

export function registerSubjectTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  const svc = () => {
    if (!deps.durableEntities) throw new AgentisError('VALIDATION_FAILED', 'durable entity spine not configured');
    return deps.durableEntities;
  };
  registry.registerMany([
    {
      definition: {
        id: 'agentis.subject.update_relationship',
        family: 'run',
        mcpExposed: true,
        autoExecute: true,
        description: 'Update the compact durable state for one relationship Subject: its active goal/stage, verified facts with provenance, commitments, blockers, and exactly one next action. Use this after a material relationship change; do not copy the transcript. Setting nextAction.dueAt arms a restart-durable wake. Set obsolete actions/commitments to cancelled or done.',
        inputSchema: {
          type: 'object',
          properties: {
            subjectId: { type: 'string' },
            key: { type: 'string' },
            facts: { type: 'array', description: 'Full bounded fact list. Each fact includes key,value,confidence,source,observedAt,lastConfirmedAt and optional expiresAt.' },
            engagements: { type: 'array' },
            commitments: { type: 'array' },
            openQuestions: { type: 'array', items: { type: 'string' } },
            blockers: { type: 'array', items: { type: 'string' } },
            nextAction: { description: 'Next action object, or null to clear.' },
          },
        },
        mutating: true,
      },
      handler: (args, ctx) => {
        const s = svc();
        const entity = typeof args.subjectId === 'string'
          ? s.get(args.subjectId)
          : typeof args.key === 'string' ? s.getByKey(ctx.workspaceId, 'subject', args.key) : null;
        if (!entity || entity.workspaceId !== ctx.workspaceId || entity.kind !== 'subject') {
          throw new AgentisError('RESOURCE_NOT_FOUND', 'relationship subject not found');
        }
        const state = normalizeRelationshipState(entity.key, entity.stateJson);
        const now = new Date().toISOString();
        if (Array.isArray(args.facts)) state.facts = args.facts.slice(0, 100) as typeof state.facts;
        if (Array.isArray(args.engagements)) state.engagements = args.engagements.slice(0, 20) as typeof state.engagements;
        if (Array.isArray(args.commitments)) state.commitments = args.commitments.slice(0, 50) as typeof state.commitments;
        if (Array.isArray(args.openQuestions)) state.openQuestions = args.openQuestions.filter((v): v is string => typeof v === 'string').slice(0, 30);
        if (Array.isArray(args.blockers)) state.blockers = args.blockers.filter((v): v is string => typeof v === 'string').slice(0, 30);
        if ('nextAction' in args) state.nextAction = args.nextAction && typeof args.nextAction === 'object' ? args.nextAction as typeof state.nextAction : null;
        state.updatedAt = now;
        const dueAt = state.nextAction && ['planned', 'ready'].includes(state.nextAction.status)
          ? state.nextAction.dueAt ?? now
          : null;
        s.upsert({ workspaceId: ctx.workspaceId, kind: 'subject', key: entity.key, appId: entity.appId, state: state as unknown as Record<string, unknown>, nextWakeAt: dueAt });
        return { subjectId: entity.id, updatedAt: now, nextWakeAt: dueAt, state };
      },
    },
    {
      definition: {
        id: 'agentis.subject.enroll',
        family: 'run',
        mcpExposed: true,
        autoExecute: true,
        description: 'Enroll a subject (lead/ticket/order/…) as a durable actor on the spine, with a declarative lifecycle. Idempotent by key. The dispatcher runs it: `send` steps are deterministic/token-free, `agent` steps hand off to a model, `wait` steps park until agentis.subject.post delivers a reply (which may arrive days later, out of order). Script shape: { start, stages: { <name>: { action: "send"|"agent"|"wait"|"done", text?, instruction?, next? } } }. Use {{fact}} in text/instruction to interpolate the subject\'s facts.',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Stable subject identity (e.g. a phone/handle/contact id).' },
            script: { type: 'object', description: 'The lifecycle: { start, stages }.' },
            facts: { type: 'object', description: 'Known facts about the subject (e.g. { connectionId, to, name }). Used by sends + interpolation.' },
            appId: { type: 'string' },
          },
          required: ['key', 'script'],
        },
        mutating: true,
      },
      handler: (args, ctx) => {
        const key = typeof args.key === 'string' ? args.key.trim() : '';
        const script = args.script as { start?: string; stages?: Record<string, unknown> } | undefined;
        if (!key) throw new AgentisError('VALIDATION_FAILED', 'key is required');
        if (!script || typeof script.start !== 'string' || !script.stages || typeof script.stages !== 'object') {
          throw new AgentisError('VALIDATION_FAILED', 'script must be { start: string, stages: { ... } }');
        }
        if (!(script.start in script.stages)) throw new AgentisError('VALIDATION_FAILED', `script.start "${script.start}" is not a stage`);
        const facts = (args.facts && typeof args.facts === 'object' ? args.facts : {}) as Record<string, unknown>;
        const entity = svc().upsert({
          workspaceId: ctx.workspaceId,
          kind: 'subject',
          key,
          appId: typeof args.appId === 'string' ? args.appId : (ctx.appId ?? null),
          state: { script, stage: script.start, facts },
          nextWakeAt: new Date().toISOString(), // run the first stage on the next sweep
        });
        return { subjectId: entity.id, key, stage: script.start };
      },
    },
    {
      definition: {
        id: 'agentis.subject.post',
        family: 'run',
        mcpExposed: true,
        autoExecute: true,
        description: 'Deliver an external event (typically a reply) to a subject\'s inbox, waking it to advance past a `wait`. Route by subject key, or by the correlation token the subject is awaiting.',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Subject key to deliver to.' },
            correlation: { type: 'object', description: 'Alternatively, route by { kind, id } to whichever subject awaits it.' },
            event: { type: 'string', description: 'Event type, e.g. "reply". Defaults to "reply".' },
            payload: { description: 'Event payload (e.g. the reply text/object).' },
          },
        },
        mutating: true,
      },
      handler: (args, ctx) => {
        const event = typeof args.event === 'string' && args.event.trim() ? args.event.trim() : 'reply';
        const s = svc();
        if (args.correlation && typeof args.correlation === 'object') {
          const c = args.correlation as { kind?: string; id?: string };
          if (c.kind && c.id) {
            const hit = s.postByCorrelation(ctx.workspaceId, { kind: c.kind, id: c.id }, event, args.payload);
            return { delivered: hit != null, subjectId: hit };
          }
        }
        const key = typeof args.key === 'string' ? args.key.trim() : '';
        if (!key) throw new AgentisError('VALIDATION_FAILED', 'provide key or correlation {kind,id}');
        const entity = s.getByKey(ctx.workspaceId, 'subject', key);
        if (!entity) throw new AgentisError('RESOURCE_NOT_FOUND', `no subject "${key}"`);
        s.post(entity.id, event, args.payload);
        return { delivered: true, subjectId: entity.id };
      },
    },
    {
      definition: {
        id: 'agentis.subject.get',
        family: 'inspect',
        mcpExposed: true,
        description: 'Read a subject\'s current stage, facts, and pending inbox.',
        inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
        mutating: false,
      },
      handler: (args, ctx) => {
        const key = typeof args.key === 'string' ? args.key.trim() : '';
        const s = svc();
        const entity = s.getByKey(ctx.workspaceId, 'subject', key);
        if (!entity) throw new AgentisError('RESOURCE_NOT_FOUND', `no subject "${key}"`);
        const state = entity.stateJson as { version?: number; stage?: string; facts?: unknown; engagements?: Array<{ stage?: string }> };
        return { subjectId: entity.id, key, status: entity.status, stage: state?.stage ?? state.engagements?.[0]?.stage, state, pendingInbox: s.pendingInbox(entity.id).length };
      },
    },
    {
      definition: {
        id: 'agentis.subject.list',
        family: 'inspect',
        mcpExposed: true,
        description: 'List the subjects in this workspace with their current stage + status (the pipeline).',
        inputSchema: { type: 'object', properties: {} },
        mutating: false,
      },
      handler: (_args, ctx) => ({
        subjects: svc().listByKind(ctx.workspaceId, 'subject').map((e) => {
          const state = e.stateJson as { version?: number; stage?: string; engagements?: Array<{ stage?: string; goal?: string; status?: string }>; nextAction?: unknown };
          return { subjectId: e.id, key: e.key, status: e.status, stage: state?.stage ?? state.engagements?.[0]?.stage ?? null, goal: state.engagements?.[0]?.goal ?? null, engagementStatus: state.engagements?.[0]?.status ?? null, nextAction: state.nextAction ?? null };
        }),
      }),
    },
  ]);
}
