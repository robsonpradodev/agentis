/**
 * CommandScope — "given this agent, what does it manage?" (COMMAND-MODEL Layer B).
 *
 * The inverse of resolveResponsibleSpecialist. The orchestrator manages the whole
 * workspace; a domain manager manages its domain(s) and everything under them
 * (subdomains, apps, workflows, the specialists that staff them). This resolves an
 * agent to that scope so the Command Model can build a briefing about exactly what
 * the agent is responsible for — the basis of a manager's progressive comprehension.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

export type CommandScopeKind = 'workspace' | 'domain' | 'worker';

export interface CommandScope {
  kind: CommandScopeKind;
  agentId: string;
  agentName: string;
  agentRole: string | null;
  /** Managed domains (+ their subdomains). Empty at workspace scope (means "all"). */
  domainIds: string[];
  domainNames: string[];
  /** Apps in scope. Empty at workspace scope (means "all"). */
  appIds: string[];
  /** Workflows in scope. Empty at workspace scope (means "all"). */
  workflowIds: string[];
  /** Specialist agents that staff the managed domains/apps (the team). */
  specialistIds: string[];
}

/** True when the agent's role marks it as the workspace-wide orchestrator. */
export function isOrchestratorRole(role: string | null | undefined): boolean {
  return typeof role === 'string' && /orchestrat/i.test(role);
}

/**
 * Resolve an agent's command scope. Never throws — returns a minimal worker scope
 * when the agent is unknown so callers can always render something safe.
 */
export function resolveCommandScope(db: AgentisSqliteDb, workspaceId: string, agentId: string): CommandScope {
  const agent = db
    .select({ id: schema.agents.id, name: schema.agents.name, role: schema.agents.role })
    .from(schema.agents)
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.workspaceId, workspaceId)))
    .get();

  const base: CommandScope = {
    kind: 'worker',
    agentId,
    agentName: agent?.name ?? agentId,
    agentRole: agent?.role ?? null,
    domainIds: [],
    domainNames: [],
    appIds: [],
    workflowIds: [],
    specialistIds: [],
  };
  if (!agent) return base;

  const allDomains = db
    .select({ id: schema.domains.id, name: schema.domains.name, managerId: schema.domains.managerId, parentDomainId: schema.domains.parentDomainId })
    .from(schema.domains)
    .where(eq(schema.domains.workspaceId, workspaceId))
    .all();

  // Only an explicit orchestrator role owns the whole workspace. A workspace
  // without domains does not promote every worker into a control plane; those
  // agents remain scoped to the Apps/workflows they directly own.
  if (isOrchestratorRole(agent.role)) {
    return { ...base, kind: 'workspace' };
  }

  // Domains this agent directly manages, plus their subdomains.
  const managed = allDomains.filter((d) => d.managerId === agentId);
  if (managed.length === 0) {
    // A worker/specialist that manages no domain: scope to what it directly owns.
    return ownedScope(db, workspaceId, base);
  }
  const managedIds = new Set(managed.map((d) => d.id));
  for (const d of allDomains) {
    if (d.parentDomainId && managedIds.has(d.parentDomainId)) managedIds.add(d.id);
  }
  const domainIds = [...managedIds];
  const domainNames = allDomains.filter((d) => managedIds.has(d.id)).map((d) => d.name);

  const apps = db
    .select({ id: schema.apps.id, ownerAgentId: schema.apps.ownerAgentId, spaceId: schema.apps.spaceId })
    .from(schema.apps)
    .where(eq(schema.apps.workspaceId, workspaceId))
    .all()
    .filter((a) => a.ownerAgentId === agentId || (a.spaceId != null && managedIds.has(a.spaceId)));
  const appIds = apps.map((a) => a.id);
  const appIdSet = new Set(appIds);

  const workflows = db
    .select({ id: schema.workflows.id, ownerAgentId: schema.workflows.ownerAgentId, spaceId: schema.workflows.spaceId, appId: schema.workflows.appId })
    .from(schema.workflows)
    .where(eq(schema.workflows.workspaceId, workspaceId))
    .all()
    .filter((w) => w.ownerAgentId === agentId || (w.spaceId != null && managedIds.has(w.spaceId)) || (w.appId != null && appIdSet.has(w.appId)));
  const workflowIds = workflows.map((w) => w.id);

  // The team: subdomain managers + app/workflow owners under this scope (minus self).
  const specialistIds = new Set<string>();
  for (const d of allDomains) if (managedIds.has(d.id) && d.managerId && d.managerId !== agentId) specialistIds.add(d.managerId);
  for (const a of apps) if (a.ownerAgentId && a.ownerAgentId !== agentId) specialistIds.add(a.ownerAgentId);
  for (const w of workflows) if (w.ownerAgentId && w.ownerAgentId !== agentId) specialistIds.add(w.ownerAgentId);

  return {
    ...base,
    kind: 'domain',
    domainIds,
    domainNames,
    appIds,
    workflowIds,
    specialistIds: [...specialistIds],
  };
}

/** Worker scope: only what the agent directly owns (no managed domain). */
function ownedScope(db: AgentisSqliteDb, workspaceId: string, base: CommandScope): CommandScope {
  const apps = db
    .select({ id: schema.apps.id })
    .from(schema.apps)
    .where(and(eq(schema.apps.workspaceId, workspaceId), eq(schema.apps.ownerAgentId, base.agentId)))
    .all();
  const appIds = apps.map((a) => a.id);
  const ownedWorkflows = db
    .select({ id: schema.workflows.id })
    .from(schema.workflows)
    .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.ownerAgentId, base.agentId)))
    .all()
    .map((w) => w.id);
  const appWorkflows = appIds.length > 0
    ? db.select({ id: schema.workflows.id }).from(schema.workflows)
        .where(and(eq(schema.workflows.workspaceId, workspaceId), inArray(schema.workflows.appId, appIds))).all().map((w) => w.id)
    : [];
  return { ...base, kind: 'worker', appIds, workflowIds: [...new Set([...ownedWorkflows, ...appWorkflows])] };
}
