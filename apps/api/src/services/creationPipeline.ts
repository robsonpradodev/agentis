/**
 * Creation Pipeline — ORCHESTRATOR-CREATION-10X §2 (Stages 1-5).
 *
 * The intelligence that makes `build_workflow` produce operationally-valid graphs
 * instead of one-node collapses. Pure, composable functions over a small deps
 * surface so each stage is independently testable:
 *
 *   buildWorkspaceInventory  — "what can we actually build here?" (Stage 2)
 *   classifyIntent           — archetype + required/missing integrations (Stage 3)
 *   assembleCreationBrief    — caller domain + inventory + classification (Stages 1+4)
 *   preflightAndEnrich       — bind credentials, ensure terminal output, warn (Stage 5)
 */

import { and, eq } from 'drizzle-orm';
import {
  effectiveSpecialistTools,
  type AgentRole,
  type AgentTool,
  type WorkflowGraph,
  type WorkflowNode,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { KnowledgeBaseService } from './knowledge/knowledgeBase.js';
import type { WorkspaceIntelligenceService } from './workspace/workspaceIntelligence.js';
import type { AgentLibraryService } from './agent/agentLibrary.js';
import type { ExtensionLibraryService } from './extensionLibrary.js';

/** Minimal deps surface — `ToolHandlerDeps` satisfies this. */
export interface CreationDeps {
  db: AgentisSqliteDb;
  knowledgeBases?: KnowledgeBaseService;
  workspaceIntelligence?: WorkspaceIntelligenceService;
  agentLibrary?: AgentLibraryService;
  extensionLibrary?: ExtensionLibraryService;
}

// Known native connector slugs (ConnectorRegistry) + high-demand roadmap ones.
const CONNECTOR_SLUGS = [
  'slack',
  'agentmail',
  'gmail',
  'github',
  'google_sheets',
  'http',
  'webhook',
  'notion',
  'airtable',
  'jira',
  'linear',
  'discord',
  'telegram',
] as const;

// Natural-language → connector slug, for intent extraction.
const INTEGRATION_HINTS: Array<[RegExp, string]> = [
  // Explicit "gmail" still routes to Gmail; generic email/mail defaults to
  // AgentMail — agent-native email that needs only an API key, no user OAuth.
  [/\bgmail\b/, 'gmail'],
  [/\b(e-?mail|inbox|mail|newsletter|digest)\b/, 'agentmail'],
  [/\bslack\b/, 'slack'],
  [/\bgithub|pull request|\bpr\b|commit|repo\b/, 'github'],
  [/\bsheet|spreadsheet|google sheets\b/, 'google_sheets'],
  [/\bnotion\b/, 'notion'],
  [/\bairtable\b/, 'airtable'],
  [/\bjira\b/, 'jira'],
  [/\blinear\b/, 'linear'],
  [/\bdiscord\b/, 'discord'],
  [/\btelegram\b/, 'telegram'],
];

export interface WorkspaceInventory {
  availableAgents: Array<{
    id: string;
    name: string;
    role: string | null;
    adapterType: string;
    status: string;
    capabilityTags: string[];
  }>;
  configuredCredentials: Array<{ id: string; name: string; integrationSlug: string }>;
  availableExtensions: string[];
  knowledgeBases: Array<{ id: string; name: string }>;
  /**
   * §G6 — top Brain passages relevant to the creation request, so the synthesis
   * LLM can verify a `knowledge` node is warranted, pick the right base, and
   * choose a static query that actually returns content. Empty when no request
   * was supplied or no Brain content matched.
   */
  knowledgeExcerpts: Array<{ knowledgeBaseId: string; content: string; score: number }>;
  wireableIntegrations: string[];
  specialistRoles: Array<{
    role: AgentRole | string;
    tools: string[];
    defaultModel: string;
    custom?: boolean;
  }>;
  workspaceContext: string;
}

/**
 * Stage 2 — assemble the concrete "what can we build" inventory for a workspace.
 * Pass `request` (the user's creation description) to additionally retrieve
 * relevant Brain passages (§G6).
 */
export async function buildWorkspaceInventory(
  deps: CreationDeps,
  workspaceId: string,
  request?: string,
): Promise<WorkspaceInventory> {
  const agents = deps.db
    .select({
      id: schema.agents.id,
      name: schema.agents.name,
      role: schema.agents.role,
      adapterType: schema.agents.adapterType,
      status: schema.agents.status,
      capabilityTags: schema.agents.capabilityTags,
    })
    .from(schema.agents)
    .where(eq(schema.agents.workspaceId, workspaceId))
    .all();

  const creds = deps.db
    .select({
      id: schema.credentials.id,
      name: schema.credentials.name,
      credentialType: schema.credentials.credentialType,
    })
    .from(schema.credentials)
    .where(eq(schema.credentials.workspaceId, workspaceId))
    .all();
  const configuredCredentials = creds.map((c) => ({
    id: c.id,
    name: c.name,
    integrationSlug: inferSlug(c.credentialType, c.name),
  }));

  const dbExtensions = deps.db
    .select({ slug: schema.extensions.slug })
    .from(schema.extensions)
    .where(eq(schema.extensions.workspaceId, workspaceId))
    .all()
    .map((s) => s.slug);
  const volumeExtensionsPromise = (async (): Promise<string[]> => {
    try {
      return (await deps.extensionLibrary?.listSourceFiles(workspaceId) ?? []).map((extension) => extension.name);
    } catch {
      return [];
    }
  })();

  const knowledgeBases = (deps.knowledgeBases?.listKnowledgeBases(workspaceId) ?? []).map((k) => ({
    id: k.id,
    name: k.name,
  }));

  // §G6 — retrieve Brain passages relevant to the request so synthesis can wire
  // knowledge nodes against real content. Best-effort; never blocks creation.
  const probe = request?.trim();
  const knowledgeExcerptsPromise = (async (): Promise<WorkspaceInventory['knowledgeExcerpts']> => {
    if (!probe || !deps.knowledgeBases || knowledgeBases.length === 0) return [];
    try {
      const query = probe.slice(0, 128);
      return (await Promise.all(knowledgeBases
        .map(async (kb) => (await deps
            .knowledgeBases!.search({ workspaceId, knowledgeBaseId: kb.id, query, topK: 5 }))
            .map((h) => ({ knowledgeBaseId: kb.id, content: h.content, score: h.score }))),
        ))
        .flat()
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
    } catch {
      return [];
    }
  })();

  const wireableIntegrations = [
    ...new Set(
      configuredCredentials
        .map((c) => c.integrationSlug)
        .filter((s) => (CONNECTOR_SLUGS as readonly string[]).includes(s)),
    ),
  ];

  const workspaceContextPromise = (async (): Promise<string> => {
    try {
      return (await deps.workspaceIntelligence?.buildContextBlock(workspaceId)) ?? '';
    } catch {
      return '';
    }
  })();

  // Custom roles from agents/custom/*.md expand the casting vocabulary (Principle #11).
  const specialistRolesPromise = (async (): Promise<WorkspaceInventory['specialistRoles']> => {
    const roles: WorkspaceInventory['specialistRoles'] = [];
    try {
      for (const cr of (await deps.agentLibrary?.listCustomRoles(workspaceId)) ?? []) {
        if (!roles.some((role) => role.role === cr.role)) {
          roles.push({ role: cr.role, tools: cr.tools, defaultModel: cr.defaultModel, custom: true });
        }
      }
    } catch {
      /* best effort */
    }
    return roles;
  })();

  const [volumeExtensions, knowledgeExcerpts, workspaceContext, specialistRoles] = await Promise.all([
    volumeExtensionsPromise,
    knowledgeExcerptsPromise,
    workspaceContextPromise,
    specialistRolesPromise,
  ]);

  return {
    availableAgents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      adapterType: a.adapterType,
      status: a.status,
      capabilityTags: Array.isArray(a.capabilityTags) ? (a.capabilityTags as string[]) : [],
    })),
    configuredCredentials,
    availableExtensions: [
      ...new Set([
        ...dbExtensions,
        ...volumeExtensions,
      ]),
    ],
    knowledgeBases,
    knowledgeExcerpts,
    wireableIntegrations,
    specialistRoles,
    workspaceContext: workspaceContext.slice(0, 3000),
  };
}

export type WorkflowArchetype = 'atomic' | 'pipeline' | 'orchestrated' | 'enterprise';

/**
 * Robustness signals (WORKFLOW-DESIGN-10X Phase 3) — the design-doctrine variables
 * the happy-path classifier was blind to. Drive both the synthesis brief (so the
 * model is told what gates/state the request needs) and the planner (so Phase
 * Cards materialize real gate/approval/validate nodes).
 */
export interface RobustnessSignals {
  /** Screening/qualification work → needs a reject branch (D1). */
  qualifies: boolean;
  /** Human approval expected before an irreversible action (D2). */
  approval: boolean;
  /** The result must be verified after the fact (D6). */
  validates: boolean;
  /** An irreversible / externally-visible action is present (deploy/publish/send/delete). */
  irreversible: boolean;
  /** Processes many items → bounded fan-out + per-item handling (D5). */
  batch: boolean;
  /** Open-ended "iterate until done" goal → a converge loop, not fixed retries (D7). */
  iterative: boolean;
}

export interface IntentClassification {
  archetype: WorkflowArchetype;
  triggerType: 'manual' | 'cron' | 'webhook' | 'persistent_listener';
  requiredIntegrations: string[];
  missingCredentials: string[];
  estimatedNodeCount: number;
  requiresPlanConfirmation: boolean;
  robustness: RobustnessSignals;
}

/** Stage 3 — classify the request + flag missing dependencies. Deterministic, no LLM. */
export function classifyIntent(
  description: string,
  inventory: WorkspaceInventory,
): IntentClassification {
  const lower = description.toLowerCase();
  const connectorText = lower.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, ' ');

  const requiredIntegrations = [
    ...new Set(INTEGRATION_HINTS.filter(([re]) => re.test(connectorText)).map(([, slug]) => slug)),
  ];
  const missingCredentials = requiredIntegrations.filter(
    (slug) => !inventory.wireableIntegrations.includes(slug),
  );

  const persistentListenerIntent =
    /\b(24\/7|constantly|continuously|always[- ]on|in real time|immediately|as soon as)\b/.test(lower)
    || /\b(watch|monitor|listen)\b[\s\S]{0,80}\b(new|changes?|updates?|posts?|events?|items?)\b/.test(lower)
    || /\bwhen(?:ever)?\b[\s\S]{0,80}\b(new|changes?|updates?|posts?|events?|items?)\b/.test(lower);
  const scheduledIntent =
    /\b(every|daily|weekly|hourly|monthly|each (morning|day|week|month)|schedule|cron)\b/.test(lower);
  const triggerType: IntentClassification['triggerType'] =
    /\bwebhook\b|\bincoming (request|http|post)\b/.test(lower)
      ? 'webhook'
      : persistentListenerIntent && !scheduledIntent
        ? 'persistent_listener'
        : scheduledIntent
          ? 'cron'
          : 'manual';

  // Signal counting → complexity. Leading \b only — these are prefixes
  // ("summari" must match "summarize"), so no trailing boundary.
  const sourceSignals = (
    lower.match(
      /\b(scrape|fetch|gather|collect|monitor|listen|pull|source|feed|registr|board|thread|api)/g,
    ) ?? []
  ).length;
  const processingSignals = (
    lower.match(
      /\b(summari|analy|score|rank|classif|transform|extract|distil|map|reverse|deduplicat|filter|generat|draft|compile)/g,
    ) ?? []
  ).length;
  const deliverySignals = (
    lower.match(
      /\b(send|email|post|notify|alert|publish|deliver|signal|dashboard|queue|calendar|inbox)/g,
    ) ?? []
  ).length;
  const ensembleSignals = (
    lower.match(/\b(ensemble|multiple (models|llms|agents)|specialized|swarm|parallel|several)/g) ??
    []
  ).length;

  const estimatedNodeCount = Math.max(
    2,
    sourceSignals + processingSignals + deliverySignals + requiredIntegrations.length + 1,
  );
  const score =
    sourceSignals +
    processingSignals * 1.2 +
    deliverySignals +
    ensembleSignals * 2 +
    requiredIntegrations.length;

  let archetype: WorkflowArchetype;
  if (ensembleSignals >= 2 || score >= 12 || requiredIntegrations.length >= 3)
    archetype = 'enterprise';
  else if (score >= 6 || (sourceSignals >= 1 && processingSignals >= 1 && deliverySignals >= 1))
    archetype = 'orchestrated';
  else if (processingSignals >= 1 || sourceSignals >= 1) archetype = 'pipeline';
  else archetype = 'atomic';

  // Robustness signals (Phase 3) — what gates/state/bounds this request implies.
  // Leading \b only — these are PREFIX matchers ("validat" must match "validate",
  // "qualif" → "qualify", "approv" → "approve"); a trailing \b would reject them.
  const robustness: RobustnessSignals = {
    qualifies: /\b(qualif|screen|vet|shortlist|eligib|reject|disqualif|candidate|prospect|filter out|approve or reject|triage)/.test(lower),
    approval: /\b(approv|confirm|sign[- ]?off|review before|only after|human[- ]in[- ]the[- ]loop|ask me before|wait for (me|confirmation)|require.{0,12}confirmation)/.test(lower),
    validates: /\b(validat|verif|health[- ]?check|smoke test|typecheck|build (passes|succeeds|ok)|confirm.{0,20}(live|deployed|200|success)|sanity check|qa\b)/.test(lower),
    irreversible: /\b(deploy|publish|release|go live|ship|send|e-?mail|post|charge|pay|delete|remove|drop|overwrite|seed)/.test(connectorText) || requiredIntegrations.length > 0,
    batch: /\b(each|every|all (the |of )?|per[ -]|batch|bulk|multiple|several|many|list of|for every|in parallel)/.test(lower),
    iterative: /\b(until (no|zero|all|it|the|every|there)|iterat|keep (going|trying|refining|fixing|improving)|refine|revise|critique|loop until|over and over|repeat(edly)? until|converge|back and forth|debate|until (done|passing|green|resolved|fixed|complete)|fix.{0,20}until|round[- ]?trip)/.test(lower),
  };

  return {
    archetype,
    triggerType,
    requiredIntegrations,
    missingCredentials,
    estimatedNodeCount,
    requiresPlanConfirmation: archetype === 'enterprise',
    robustness,
  };
}

// ── Enterprise Planner (ORCH §4.3 / §9) ──────────────────────────────────────

/** The control-flow role of a Phase Card (Phase 3) — drives which node kind it materializes to. */
export type PlanPhaseKind = 'work' | 'gate' | 'approval' | 'validate';

export interface PlanPhase {
  name: string;
  description: string;
  nodeKinds: string[];
  agentRole?: AgentRole;
  requiredCredential?: string;
  estimatedCostCents: [number, number];
  /** Per-phase model override (set when the operator edits a Phase Card). */
  model?: string;
  /** Control-flow role; defaults to 'work'. Gate/approval/validate become real guard nodes. */
  kind?: PlanPhaseKind;
}

export interface WorkflowPlan {
  archetype: WorkflowArchetype;
  phases: PlanPhase[];
  totalEstimatedCostCents: [number, number];
  missingDependencies: string[];
  requiresConfirmation: boolean;
  question?: string;
}

/**
 * Decompose a request into named phases (Phase Cards) before any node is built.
 * Deterministic HTN-lite: maps the classified signals to gather → analyze → draft
 * → deliver phases, casting the minimum-sufficient specialist per phase.
 */
export function planWorkflow(
  description: string,
  classification: IntentClassification,
): WorkflowPlan {
  const lower = description.toLowerCase();
  const phases: PlanPhase[] = [];
  const has = (re: RegExp) => re.test(lower);
  const r = classification.robustness;

  const fetches = has(
    /scrape|fetch|gather|collect|monitor|listen|source|feed|crawl|read (from|the)/,
  );
  const analyzes = has(
    /analy|score|rank|classif|deduplicat|filter|extract|distil|map|assess|evaluate/,
  );
  const drafts = has(/draft|write|summari|compose|generat|report|digest|post|content/);
  const delivers =
    classification.requiredIntegrations.length > 0 ||
    has(/send|email|post|notify|alert|publish|deliver|queue|dashboard|calendar/);

  if (fetches)
    phases.push({
      name: 'Gather Sources',
      description: 'Fetch + normalize the source material in parallel.',
      nodeKinds: ['parallel', 'http_request', 'merge'],
      agentRole: 'researcher',
      estimatedCostCents: [0, 1],
      kind: 'work',
    });
  // D1 — qualification gate: screen candidates and reject the weak ones before
  // spending downstream, with a reject branch back to the source.
  if (r.qualifies)
    phases.push({
      name: 'Qualify & Gate',
      description: 'Screen each candidate against the bar; a fail rejects it and re-tries the source instead of proceeding.',
      nodeKinds: ['evaluator', 'router'],
      estimatedCostCents: [0, 1],
      kind: 'gate',
    });
  if (analyzes)
    phases.push({
      name: 'Analyze & Score',
      description: 'Deduplicate, score, and filter to the items that matter.',
      nodeKinds: ['transform', 'agent_task'],
      agentRole: 'analyst',
      estimatedCostCents: [1, 3],
      kind: 'work',
    });
  if (drafts)
    phases.push({
      name: 'Draft Output',
      description: 'Produce the brand-aligned, formatted result.',
      nodeKinds: ['agent_task'],
      agentRole: 'writer',
      estimatedCostCents: [1, 3],
      kind: 'work',
    });
  if (delivers || r.irreversible) {
    const slug = classification.requiredIntegrations[0];
    // D2 — approval before the irreversible action, when the request implies it.
    if (r.approval)
      phases.push({
        name: 'Human Approval',
        description: 'Pause for explicit operator approval before the irreversible action.',
        nodeKinds: ['checkpoint'],
        estimatedCostCents: [0, 0],
        kind: 'approval',
      });
    phases.push({
      name: slug ? 'Deliver' : 'Execute Action',
      description: slug
        ? `Route the result to its destination via ${slug}.`
        : 'Perform the irreversible/external action (deploy, publish, send, etc.).',
      nodeKinds: ['integration'],
      requiredCredential: slug,
      estimatedCostCents: [0, 0],
      kind: 'work',
    });
    // D6 — validate the irreversible action actually worked; rollback on failure.
    if (r.validates && r.irreversible)
      phases.push({
        name: 'Validate & Rollback',
        description: 'Verify the action succeeded (live/health check); on failure, run the compensating rollback before finishing.',
        nodeKinds: ['evaluator', 'router'],
        estimatedCostCents: [0, 1],
        kind: 'validate',
      });
  }
  if (phases.length === 0) {
    phases.push({
      name: 'Execute',
      description: 'Run the requested task and return a result.',
      nodeKinds: ['agent_task', 'return_output'],
      agentRole: 'writer',
      estimatedCostCents: [1, 3],
      kind: 'work',
    });
  }

  const totalMin = phases.reduce((s, p) => s + p.estimatedCostCents[0], 0);
  const totalMax = phases.reduce((s, p) => s + p.estimatedCostCents[1], 0);
  return {
    archetype: classification.archetype,
    phases,
    totalEstimatedCostCents: [totalMin, totalMax],
    missingDependencies: classification.missingCredentials,
    requiresConfirmation: classification.requiresPlanConfirmation,
    question:
      classification.missingCredentials.length > 0
        ? `This plan needs ${classification.missingCredentials.join(', ')}. Configure the credential(s), or I'll add a pending-config integration node you can wire after.`
        : undefined,
  };
}

export interface CreationBrief {
  userRequest: string;
  callerName: string | null;
  callerRole: string | null;
  callerDomain: string; // condensed instructions + keywords
  inventory: WorkspaceInventory;
  classification: IntentClassification;
}

/** Stages 1+4 — assemble the full brief, including the calling agent's domain identity. */
export async function assembleCreationBrief(
  deps: CreationDeps,
  workspaceId: string,
  agentId: string | null | undefined,
  description: string,
): Promise<CreationBrief> {
  const inventory = await buildWorkspaceInventory(deps, workspaceId, description);
  const classification = classifyIntent(description, inventory);

  let callerName: string | null = null;
  let callerRole: string | null = null;
  let callerDomain = '';
  if (agentId) {
    const agent = deps.db
      .select({
        name: schema.agents.name,
        role: schema.agents.role,
        instructions: schema.agents.instructions,
      })
      .from(schema.agents)
      .where(and(eq(schema.agents.id, agentId), eq(schema.agents.workspaceId, workspaceId)))
      .get();
    if (agent) {
      callerName = agent.name;
      callerRole = agent.role;
      // P7: domain authority belongs to the manager — only inject for non-orchestrators.
      if (agent.role !== 'orchestrator' && agent.instructions) {
        callerDomain = String(agent.instructions).slice(0, 800);
      }
    }
  }

  return {
    userRequest: description,
    callerName,
    callerRole,
    callerDomain,
    inventory,
    classification,
  };
}

export interface PreflightWarning {
  code:
    | 'CREDENTIAL_REQUIRED'
    | 'AGENT_UNBOUND'
    | 'AGENT_OFFLINE'
    | 'MISSING_OUTPUT'
    | 'DEAD_END'
    | 'BODY_REQUIRED'
    | 'CAPABILITY_MISMATCH'
    | 'GRAMMAR_VIOLATION'
    | 'INVALID_EXPRESSION'
    | 'SCHEDULE_INACTIVE'
    // ── Robustness audit (WORKFLOW-DESIGN-10X Phase 2, doctrine D1–D7) ──
    | 'MISSING_STATE'
    | 'UNBOUNDED_BATCH'
    | 'MISSING_DELIVERY_GUARD'
    | 'MISSING_DELIVERY_SINK'
    | 'SINGLE_BRANCH_ROUTER'
    | 'NO_FAILURE_HANDLING'
    | 'MISSING_CONVERGENCE'
    | 'AGENT_FOR_KNOWN_OPERATION'
    | 'AGENT_FOR_PURE_RESHAPE'
    | 'AGENT_ASKED_TO_RUN_SCRIPT'
    // ── Intent Contract (Organ 2, anti-green-washing) ──
    | 'AUTO_APPROVAL_BYPASS'
    | 'CAPABILITY_REMOVED';
  nodeId?: string;
  message: string;
}

/** Specialist fallback chains (§8): preferred role offline → next role with overlapping tools. */
export const SPECIALIST_FALLBACK: Partial<Record<AgentRole, AgentRole>> = {
  researcher: 'writer',
  analyst: 'coder',
  reviewer: 'architect',
  writer: 'researcher',
  coder: 'analyst',
  architect: 'reviewer',
  debugger: 'coder',
};

/** Infer the tools a node's task actually needs from its prompt/title (§8 casting). */
export function inferToolNeeds(text: string): AgentTool[] {
  const t = text.toLowerCase();
  const needs = new Set<AgentTool>();
  if (/\bhttp|url|fetch|scrape|website|web page|link\b/.test(t)) needs.add('read_url');
  if (/\bsearch the web|web search|google|look up online|research\b/.test(t))
    needs.add('web_search');
  if (/\brun code|execute|compute|calculate|score|statistic|aggregate\b/.test(t))
    needs.add('run_code');
  if (/\bread (the )?file|open file|load file\b/.test(t)) needs.add('read_file');
  if (/\bwrite (a |the )?file|save file|generate (a )?file|create (a )?(file|project)\b/.test(t))
    needs.add('write_file');
  if (/\bdiff|review (the )?(pr|pull request|change)\b/.test(t)) needs.add('git_diff');
  if (/\bknowledge base|retrieve|recall|our docs|internal docs\b/.test(t))
    needs.add('knowledge_search');
  return [...needs];
}

function inferAgentTaskGrammarWarnings(node: WorkflowNode): string[] {
  const cfg = node.config as unknown as Record<string, unknown>;
  const text = `${node.title}\n${String(cfg.prompt ?? '')}`
    .split(/\n+/)
    .filter((line) => !/^\s*original operator request:/i.test(line))
    .filter((line) => !/\bdo not\b/i.test(line))
    .join('\n')
    .toLowerCase();
  const warnings: string[] = [];
  const sourceWork = /\b(fetch|scrape|crawl|visit|download|open\s+(the\s+)?url|read\s+(the\s+)?url|website|web page|rss|hacker news)\b/.test(text);
  const languageWork = /\b(summarize|summarise|digest|analy[sz]e|rank|score|classify|extract|write|draft|compose)\b/.test(text);
  if (sourceWork && languageWork) {
    warnings.push(`${node.title}: Rule 1 violation - split source collection from language work (http_request/browser -> transform/agent_task).`);
  } else if (sourceWork) {
    warnings.push(`${node.title}: Rule 4 violation - source fetching belongs in an http_request or browser node before the agent step.`);
  }

  const deliveryWork =
    /\b(send|post|publish|notify|deliver)\b.*\b(slack|email|gmail|discord|telegram|notion|sheet|github|jira|linear)\b/.test(text)
    || /\b(slack|email|gmail|discord|telegram|notion|sheet|github|jira|linear)\b.*\b(send|post|publish|notify|deliver)\b/.test(text);
  if (deliveryWork) {
    warnings.push(`${node.title}: Rule 3 violation - delivery must use a native integration node, not an agent prompt.`);
  }

  const deterministicOnly = /\b(format|parse|normalize|dedupe|de-dupe|filter|sort|slice|top\s+\d+|map)\b/.test(text)
    && !/\b(summarize|summarise|digest|analy[sz]e|write|draft|compose)\b/.test(text);
  if (deterministicOnly) {
    warnings.push(`${node.title}: Rule 2 violation - deterministic reshaping should use transform/filter instead of agent_task.`);
  }
  return warnings;
}

export interface TeamMember {
  role: AgentRole;
  tools: AgentTool[];
  status: 'online' | 'offline' | 'unknown';
  fallback?: AgentRole;
}

/** Build the team roster (§8) — the specialists this graph casts, with status + fallbacks. */
export function buildTeamRoster(graph: WorkflowGraph, inventory: WorkspaceInventory): TeamMember[] {
  const onlineRoles = new Set(
    inventory.availableAgents.filter((a) => a.status === 'online' && a.role).map((a) => a.role!),
  );
  const roles = new Set<AgentRole>();
  for (const n of graph.nodes) {
    const c = n.config as { kind?: string; agentRole?: AgentRole };
    if ((c.kind === 'agent_task' || c.kind === 'agent_swarm') && c.agentRole)
      roles.add(c.agentRole);
  }
  return [...roles].map((role) => {
    const status: TeamMember['status'] = onlineRoles.has(role) ? 'online' : 'offline';
    const member: TeamMember = { role, tools: effectiveSpecialistTools({ role }), status };
    if (status !== 'online' && SPECIALIST_FALLBACK[role])
      member.fallback = SPECIALIST_FALLBACK[role];
    return member;
  });
}

export interface PreflightResult {
  graph: WorkflowGraph;
  warnings: PreflightWarning[];
  estimatedCostCents: number;
}

/**
 * Stage 5 — operational validity, not just schema validity. Enriches the graph
 * (binds credentials from the inventory, guarantees a terminal output node) and
 * returns warnings the build narrates to the operator instead of failing on first run.
 */
export function preflightAndEnrich(
  graph: WorkflowGraph,
  inventory: WorkspaceInventory,
): PreflightResult {
  const warnings: PreflightWarning[] = [];
  const nodes = graph.nodes.map(
    (n) =>
      ({
        ...n,
        config: { ...(n.config as unknown as Record<string, unknown>) },
      }) as unknown as WorkflowNode,
  );
  const credBySlug = new Map<string, string>();
  for (const c of inventory.configuredCredentials)
    if (!credBySlug.has(c.integrationSlug)) credBySlug.set(c.integrationSlug, c.id);
  const onlineAgent = new Map(inventory.availableAgents.map((a) => [a.id, a.status]));

  let estimatedCostCents = 0;
  for (const node of nodes) {
    const cfg = node.config as unknown as Record<string, unknown>;
    switch (cfg.kind) {
      case 'integration': {
        const slug = String(cfg.integrationId ?? '');
        if (!cfg.credentialId) {
          const credId = credBySlug.get(slug);
          if (credId)
            cfg.credentialId = credId; // CHECK 2 enrichment: bind from inventory
          else
            warnings.push({
              code: 'CREDENTIAL_REQUIRED',
              nodeId: node.id,
              message: `${node.title}: no ${slug || 'integration'} credential configured — set one up to activate this step.`,
            });
        }
        break;
      }
      case 'agent_task': {
        estimatedCostCents += 2; // rough per-agent-task estimate
        if (inventory.availableAgents.length === 0) {
          warnings.push({
            code: 'AGENT_UNBOUND',
            nodeId: node.id,
            message: `${node.title}: No agents available — agent tasks will be unbound.`,
          });
        } else if (
          !cfg.agentId &&
          !cfg.agentRole &&
          (!Array.isArray(cfg.capabilityTags) || cfg.capabilityTags.length === 0)
        ) {
          warnings.push({
            code: 'AGENT_UNBOUND',
            nodeId: node.id,
            message: `${node.title}: no agent, role, or capability tags — assign one before running.`,
          });
        } else if (
          cfg.agentId &&
          onlineAgent.get(String(cfg.agentId)) &&
          onlineAgent.get(String(cfg.agentId)) !== 'online'
        ) {
          warnings.push({
            code: 'AGENT_OFFLINE',
            nodeId: node.id,
            message: `${node.title}: bound agent is offline — connect a runtime or it will fail on first run.`,
          });
        }
        // §8 CAPABILITY_MISMATCH: the cast role must be able to do what the task needs.
        if (cfg.agentRole) {
          const role = cfg.agentRole as AgentRole;
          const manifest = effectiveSpecialistTools({ role });
          const needs = inferToolNeeds(`${node.title} ${String(cfg.prompt ?? '')}`);
          const unmet = needs.filter((tool) => !manifest.includes(tool));
          if (needs.length > 0 && unmet.length === needs.length) {
            // Built-in specialists were retired, so there is no canned role to
            // suggest — the task needs a capability outside the universal floor.
            warnings.push({
              code: 'CAPABILITY_MISMATCH',
              nodeId: node.id,
              message: `${node.title}: role '${role}' lacks ${unmet.join(', ')} — grant ${unmet.length === 1 ? 'it' : 'them'} explicitly on this node or pick a role whose manifest includes ${unmet.length === 1 ? 'it' : 'them'}.`,
            });
          }
        }
        for (const message of inferAgentTaskGrammarWarnings(node)) {
          warnings.push({
            code: 'GRAMMAR_VIOLATION',
            nodeId: node.id,
            message,
          });
        }
        break;
      }
      case 'agent_swarm':
        estimatedCostCents += 5;
        break;
      case 'loop':
        if (!cfg.bodyWorkflowId)
          warnings.push({
            code: 'BODY_REQUIRED',
            nodeId: node.id,
            message: `${node.title}: loop has no body workflow.`,
          });
        break;
      default:
        break;
    }
  }

  // CHECK / RULE 10 — guarantee a terminal output node.
  const hasOutput = nodes.some((n) => {
    const c = n.config as { kind?: string; isOutput?: boolean };
    return c.kind === 'return_output' || c.kind === 'artifact_save' || c.isOutput === true;
  });
  let edges = [...graph.edges];
  if (!hasOutput && nodes.length > 0) {
    const sources = new Set(edges.map((e) => e.source));
    const sinks = nodes.filter((n) => !sources.has(n.id));
    const last = sinks[sinks.length - 1] ?? nodes[nodes.length - 1]!;
    const outId = 'return_output';
    if (!nodes.some((n) => n.id === outId)) {
      nodes.push({
        id: outId,
        type: 'return_output',
        title: 'Return Output',
        position: { x: last.position.x + 240, y: last.position.y },
        config: { kind: 'return_output', renderAs: 'json' },
      });
      edges.push({ id: `edge_${last.id}_${outId}`, source: last.id, target: outId });
      warnings.push({
        code: 'MISSING_OUTPUT',
        message: 'No output node found — added a Return Output so the run produces a result.',
      });
    }
  }

  // CHECK 4 — dead ends (advisory).
  const withOutgoing = new Set(edges.map((e) => e.source));
  for (const n of nodes) {
    const c = n.config as { kind?: string; isOutput?: boolean };
    const terminal =
      c.kind === 'return_output' || c.kind === 'artifact_save' || c.isOutput === true;
    if (!terminal && !withOutgoing.has(n.id) && nodes.length > 1) {
      warnings.push({
        code: 'DEAD_END',
        nodeId: n.id,
        message: `${n.title}: no outgoing edge — its output is never used.`,
      });
    }
  }

  return { graph: { ...graph, nodes, edges }, warnings, estimatedCostCents };
}

/** credentialType / name → connector slug. */
function inferSlug(credentialType: string, name: string): string {
  const hay = `${credentialType} ${name}`.toLowerCase();
  for (const slug of CONNECTOR_SLUGS) if (hay.includes(slug)) return slug;
  if (/mail/.test(hay)) return 'agentmail';
  return credentialType.toLowerCase();
}
