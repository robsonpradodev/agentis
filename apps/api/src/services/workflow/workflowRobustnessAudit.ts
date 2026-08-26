/**
 * Workflow Robustness Audit (WORKFLOW-DESIGN-10X Phase 2).
 *
 * The Workflow Design Doctrine (Phase 1) TEACHES the synthesis model to design
 * for failure (gates, fallbacks, state, bounds, rollback). This module ENFORCES
 * it deterministically: it inspects the assembled graph and flags the robustness
 * gaps the doctrine warns about — and auto-repairs the safe ones — so even a
 * naive happy-path draft comes out more robust. It complements preflightAndEnrich
 * (which checks operational validity: credentials, agent binding, terminal node).
 *
 * Checks are intentionally conservative (low false-positive): each maps to a
 * doctrine clause (D1–D6) and only fires on a clear structural omission.
 */

import type { WorkflowGraph, WorkflowNode } from '@agentis/core';
import type { IntentClassification, PreflightWarning } from '../creationPipeline.js';

export interface RobustnessAuditOptions {
  /** Runnable connector/MCP services — powers the deterministic-first check (D8). */
  knownServices?: string[];
}

export interface RobustnessAuditResult {
  graph: WorkflowGraph;
  warnings: PreflightWarning[];
  /** Human-readable descriptions of the safe auto-repairs applied to the graph. */
  repairs: string[];
}

/** Default fan-out bound applied to an unbounded batch node (D5). */
const DEFAULT_BATCH_CONCURRENCY = 5;

// A `channel` node is the native "reach the world" delivery for messaging
// (WhatsApp/Telegram/…) — the same delivery class as an integration, so the
// robustness audit counts it: an outreach workflow that only COMPUTES a message
// but has no channel/integration delivery node is the exact hollow-send gap.
const DELIVERY_KINDS = new Set(['integration', 'channel']);
const FETCH_KINDS = new Set(['http_request', 'browser']);
const GUARD_KINDS = new Set(['evaluator', 'checkpoint', 'guardrails']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function kindOf(node: WorkflowNode): string {
  return String((node.config as { kind?: unknown } | undefined)?.kind ?? node.type ?? '');
}

/** An externally-visible / irreversible action node: an integration, or an HTTP write. */
function isDeliveryNode(node: WorkflowNode): boolean {
  const cfg = node.config as { kind?: string; method?: unknown } | undefined;
  if (DELIVERY_KINDS.has(kindOf(node))) return true;
  if (kindOf(node) === 'http_request' && typeof cfg?.method === 'string' && WRITE_METHODS.has(cfg.method.toUpperCase())) {
    return true;
  }
  return false;
}

function looksLikeAgentOwnedDelivery(node: WorkflowNode): boolean {
  if (kindOf(node) !== 'agent_task' && kindOf(node) !== 'agent_session') return false;
  const cfg = node.config as unknown as Record<string, unknown>;
  const outputKeys = Array.isArray(cfg.outputKeys) ? cfg.outputKeys.map((key) => String(key).toLowerCase()) : [];
  const hasReceiptContract = outputKeys.some((key) => /provider.?ack|delivery|message.?id|sent.?count/.test(key));
  const instruction = `${node.title}\n${String(cfg.prompt ?? '')}`;
  const namesDelivery = /\b(?:send|deliver|dispatch|publish|post|outreach|whatsapp|telegram|slack|discord|email|enviar|envie|mensagem|mensaje|correo)\b/i.test(instruction);
  return hasReceiptContract && namesDelivery;
}

/** Backward reachability: the set of node ids that can reach `targetId` (its ancestors). */
function ancestorsOf(targetId: string, edges: WorkflowGraph['edges']): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const e of edges) {
    (incoming.get(e.target) ?? incoming.set(e.target, []).get(e.target)!).push(e.source);
  }
  const seen = new Set<string>();
  const stack = [...(incoming.get(targetId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const prev of incoming.get(id) ?? []) stack.push(prev);
  }
  return seen;
}

/**
 * Audit the graph for the doctrine's robustness gaps. Returns warnings (surfaced
 * to the operator and fed to the reviewer) plus a graph with safe auto-repairs
 * applied (currently: bounding an unbounded batch — D5).
 */
export function auditWorkflowRobustness(
  graph: WorkflowGraph,
  classification: Pick<IntentClassification, 'triggerType' | 'archetype'> & Partial<Pick<IntentClassification, 'robustness'>>,
  options: RobustnessAuditOptions = {},
): RobustnessAuditResult {
  const warnings: PreflightWarning[] = [];
  const repairs: string[] = [];
  const nodes = graph.nodes.map((n) => ({ ...n, config: { ...(n.config as unknown as Record<string, unknown>) } })) as unknown as WorkflowNode[];
  const kinds = nodes.map(kindOf);

  const has = (kind: string) => kinds.includes(kind);
  const recurring = classification.triggerType === 'cron' || classification.triggerType === 'persistent_listener';

  // ── D0: real-world delivery must be represented by a native executable node.
  // An agent may choose/compose WHAT to send, but an agent_task claiming its own
  // provider acknowledgement is neither deterministic nor independently
  // observable. This exact shape caused a successful WhatsApp delivery to spend
  // 30 minutes in a coding harness and then be reported as unaccomplished.
  if (!nodes.some(isDeliveryNode)) {
    const disguisedDelivery = nodes.find(looksLikeAgentOwnedDelivery);
    if (disguisedDelivery) {
      warnings.push({
        code: 'MISSING_DELIVERY_SINK',
        nodeId: disguisedDelivery.id,
        message:
          `${disguisedDelivery.title}: this agent step is responsible for an external delivery and its receipt, but the graph has no native channel/integration delivery node. `
          + 'Keep agent judgment in an upstream agent_task, then execute the send with a channel or integration node and verify that node\'s durable receipt.',
      });
    }
  }

  // ── D4: recurring workflow that accumulates work but keeps no state → no dedup,
  //        re-processes everything every run. Iron Rule 13, now enforced. ──
  if (recurring && !has('workflow_store') && nodes.length > 1) {
    warnings.push({
      code: 'MISSING_STATE',
      message:
        'This runs on a schedule/listener but has no workflow_store node — it will re-process the same items every run. '
        + 'Add a workflow_store "get" near the start (a seen-set / last cursor) and a "set" near the end so each run only handles what is new.',
    });
  }

  // ── D7: the request reads as open-ended ("iterate until done", refine/critique,
  //        multi-agent convergence) but the graph has no `pursue` node (nor the
  //        legacy `converge`) — it will run once or rely on a brittle fixed-N
  //        evaluator retry that carries no state between tries. Fires only on the
  //        explicit iterative signal. ──
  if (classification.robustness?.iterative && !has('pursue') && !has('converge') && nodes.length > 1) {
    warnings.push({
      code: 'MISSING_CONVERGENCE',
      message:
        'This goal is open-ended (iterate until done / refine / multi-agent convergence) but has no pursue node. '
        + 'A pursue node re-runs a cohort sub-workflow each iteration, carries state across iterations on the blackboard, '
        + 'and stops on goal/stall/budget with an honest verdict — far more robust than a fixed-N evaluator retry. '
        + 'Retrieve the convergence-loop pattern with agentis.workflow.patterns.',
    });
  }

  // ── D8: a hard-stop guard that DEAD-ENDS the run on a correctable precondition,
  //        with no corrective loop anywhere. Fail-forward doctrine: a guard should
  //        CORRECT (re-run the producer with feedback / a pursue), not kill the run.
  //        Conservative: only a truly terminal stop (a stop_error, or a
  //        guardrails-block with NO outgoing edge) + no pursue/converge + no back-
  //        edge (no correction loop at all). ──
  const outgoing = new Set(graph.edges.map((e) => e.source));
  const deadEndGuard = nodes.find((n) => {
    const k = kindOf(n);
    const isHardStop = k === 'stop_error' || (k === 'guardrails' && (n.config as { onViolation?: string }).onViolation === 'block');
    return isHardStop && !outgoing.has(n.id);
  });
  const hasCorrectionLoop = graph.edges.some((e) => ancestorsOf(e.source, graph.edges).has(e.target));
  if (deadEndGuard && !has('pursue') && !has('converge') && !hasCorrectionLoop && nodes.length > 1) {
    warnings.push({
      code: 'DEAD_END',
      message:
        `The "${deadEndGuard.title}" guard hard-stops the run with no corrective loop. Per the fail-forward doctrine (D8), a `
        + 'correctable precondition ("must be resolved before X", a missing field, a validation reject) should FAIL FORWARD: '
        + 'wrap the producer→guard as a `pursue` (doneWhen = the guard/objective), or add a correction edge that re-runs the '
        + 'producing step with the block reason injected as feedback so the second try satisfies it. Only hard-stop for a '
        + 'genuinely out-of-scope input — then filter/route it earlier so the run never reaches a dead-end.',
    });
  }

  // ── D5: a batch node with no concurrency bound fans out unbounded. Safe to
  //        repair by setting a sensible default cap. ──
  for (const node of nodes) {
    const cfg = node.config as unknown as Record<string, unknown>;
    const kind = kindOf(node);
    if (kind === 'loop') {
      const bound = Number(cfg.maxConcurrency);
      if (!Number.isFinite(bound) || bound <= 0) {
        cfg.maxConcurrency = DEFAULT_BATCH_CONCURRENCY;
        repairs.push(`Bounded "${node.title}" loop to maxConcurrency=${DEFAULT_BATCH_CONCURRENCY} (was unbounded).`);
      }
    } else if (kind === 'agent_swarm' || kind === 'dynamic_swarm') {
      const bound = Number(cfg.maxParallel);
      if (!Number.isFinite(bound) || bound <= 0) {
        cfg.maxParallel = DEFAULT_BATCH_CONCURRENCY;
        repairs.push(`Bounded "${node.title}" swarm to maxParallel=${DEFAULT_BATCH_CONCURRENCY} (was unbounded).`);
      }
    }
  }

  // ── D1: a router that has fewer than two outgoing edges is a decision with no
  //        alternative branch — usually the missing reject/fallback path. ──
  const outDegree = new Map<string, number>();
  for (const e of graph.edges) outDegree.set(e.source, (outDegree.get(e.source) ?? 0) + 1);
  for (const node of nodes) {
    if (kindOf(node) === 'router' && (outDegree.get(node.id) ?? 0) < 2) {
      warnings.push({
        code: 'SINGLE_BRANCH_ROUTER',
        nodeId: node.id,
        message: `${node.title}: a router with one branch is a decision with no alternative — add the reject/fallback branch (e.g. loop back or stop) so a failed condition has somewhere to go.`,
      });
    }
  }

  // ── D2: an irreversible/external action with no gate (evaluator/checkpoint/
  //        guardrails) anywhere upstream. Gated to non-trivial graphs to avoid
  //        nagging on a simple "email me" automation. ──
  if (classification.archetype === 'orchestrated' || classification.archetype === 'enterprise' || nodes.length >= 6) {
    const guardIds = new Set(nodes.filter((n) => GUARD_KINDS.has(kindOf(n))).map((n) => n.id));
    if (guardIds.size === 0) {
      const delivery = nodes.find(isDeliveryNode);
      if (delivery) {
        warnings.push({
          code: 'MISSING_DELIVERY_GUARD',
          nodeId: delivery.id,
          message: `${delivery.title}: an external/irreversible action runs with no evaluator or approval checkpoint before it. Add a gate (evaluator for unattended runs, checkpoint for human approval) so a bad result isn't published/sent.`,
        });
      } else {
        // No guard nodes at all in a non-trivial graph is itself worth flagging.
        const anyDelivery = nodes.some(isDeliveryNode);
        if (anyDelivery) {
          warnings.push({ code: 'MISSING_DELIVERY_GUARD', message: 'No evaluator/checkpoint guards any delivery step — add one before external actions.' });
        }
      }
    }
  }

  // ── D3: multiple external fetches and zero failure handling (no evaluator/
  //        guardrails verifying results). A single coarse advisory, not per-node. ──
  const fetchCount = nodes.filter((n) => FETCH_KINDS.has(kindOf(n))).length;
  const hasFailureHandling = nodes.some((n) => GUARD_KINDS.has(kindOf(n)));
  if (fetchCount >= 2 && !hasFailureHandling) {
    warnings.push({
      code: 'NO_FAILURE_HANDLING',
      message:
        `${fetchCount} external fetch/scrape steps have no failure handling. Flaky sources (rate limits, empty responses, bad encodings) will silently become empty input. `
        + 'Add an evaluator to verify each fetched artifact is usable before the workflow depends on it, and a fallback path for the common failure.',
    });
  }

  // ── D8 (SWIFT-W): deterministic-first. An agent_task whose prompt names a
  //        SINGLE known service operation is a known step wearing an agent
  //        costume — an integration/mcp node is deterministic, contract-checked,
  //        and cheap. Keep agent_task for judgment. Advisory, never blocking. ──
  const knownServices = (options.knownServices ?? []).filter((s) => s.length >= 3);
  if (knownServices.length > 0) {
    const opVerb = /\b(insert|upload|deploy|publish|create|send|post|update|delete|query|select|fetch|list)\b/i;
    for (const node of nodes) {
      if (kindOf(node) !== 'agent_task') continue;
      const prompt = String((node.config as unknown as Record<string, unknown>).prompt ?? '');
      if (!prompt || prompt.length > 400) continue; // long prompts imply real judgment
      const mentioned = knownServices.filter((s) => new RegExp(`\\b${s.replace(/[^a-z0-9_]/gi, '')}\\b`, 'i').test(prompt));
      if (mentioned.length === 1 && opVerb.test(prompt)) {
        warnings.push({
          code: 'AGENT_FOR_KNOWN_OPERATION',
          nodeId: node.id,
          message: `${node.title}: this agent step reads as a single known ${mentioned[0]} operation. Use a deterministic integration/mcp node for it (contract-checked, cheap, verifiable) — keep agent_task for steps that need judgment.`,
        });
      }
    }
  }

  // ── D9 (SWIFT-W): anti-fabrication. An agent_task whose prompt instructs
  //        RUNNING a named script or shell command is the single most common
  //        cause of "the run passed but nothing happened": an agent_task has NO
  //        shell, so the model returns plausible JSON WITHOUT executing anything
  //        (the harvest that reports 15 products while the directory is empty).
  //        The real execution seam is a `code` (python) node, which shells out
  //        via subprocess. This is the strongest steer — a workflow must never
  //        ask an LLM to "run a script". ──
  const runScript = /\b(run|execute|invoke|call)\b[^.\n]{0,40}\b(script|command|\.py|\.mjs|\.js|\.sh|python|node|npm|npx|bash|subprocess|child_process|shell)\b/i;
  const scriptPath = /(?:^|\s)(?:\.\/|scripts\/|\/)[\w./-]+\.(?:py|mjs|js|sh|ts)\b/i;
  for (const node of nodes) {
    if (kindOf(node) !== 'agent_task') continue;
    const prompt = String((node.config as unknown as Record<string, unknown>).prompt ?? '');
    if (prompt && (runScript.test(prompt) || scriptPath.test(prompt))) {
      warnings.push({
        code: 'AGENT_ASKED_TO_RUN_SCRIPT',
        nodeId: node.id,
        message: `${node.title}: this agent step is told to RUN a script/command, but an agent_task has no shell — the model will FABRICATE the output instead of executing it (a "harvest" that reports files it never wrote). Replace it with a deterministic \`code\` (python) node that shells out via subprocess.run(...), and add a file_probe/data_probe acceptance check so the real output is verified.`,
      });
    }
  }

  // ── E1 (SWIFT-F): efficiency. An agent_task whose prompt is pure reshaping
  //        (no judgment verbs) burns tokens on deterministic work — suggest a
  //        transform/code node. Advisory. ──
  const reshapeVerb = /\b(reformat|convert|map(?: the)? fields?|rename|restructure|to json|as json|parse)\b/i;
  const judgmentVerb = /\b(write|decide|evaluate|research|judge|compose|design|analy[sz]e|summari[sz]e|review|choose|recommend)\b/i;
  for (const node of nodes) {
    if (kindOf(node) !== 'agent_task') continue;
    const prompt = String((node.config as unknown as Record<string, unknown>).prompt ?? '');
    if (prompt && reshapeVerb.test(prompt) && !judgmentVerb.test(prompt)) {
      warnings.push({
        code: 'AGENT_FOR_PURE_RESHAPE',
        nodeId: node.id,
        message: `${node.title}: this agent step reads as a pure data reshape — a transform/code node does it deterministically at zero token cost, and the output cannot hallucinate.`,
      });
    }
  }

  return { graph: { ...graph, nodes }, warnings, repairs };
}
