import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type {
  ExtensionManifest,
  ExtensionTaskNodeConfig,
  HttpRequestNodeConfig,
  IntegrationNodeConfig,
  WorkflowContract,
  WorkflowGraph,
  WorkflowNode,
} from '@agentis/core';
import { defaultConnectorRegistry, manifestHttpConnector, missingContractFields } from '@agentis/integrations';
import type { ConnectorOperationContract } from '@agentis/integrations';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { validateExtensionSource } from '../../extensions/validateSource.js';
import { getCustomIntegrationManifest } from '../integrationRegistry.js';
import { validateWorkflowGraph } from '../../engine/validateGraph.js';
import { validateGraphReferences } from '../../engine/validateGraphReferences.js';
import { buildTemplateContext, resolveTemplateDeep } from '../../engine/templateResolver.js';
import { NodeHandlerRegistry } from '../../engine/handlers/NodeHandler.js';
import { registerPureNodeHandlers } from '../../engine/handlers/pureHandlers.js';
import { registerUtilityNodeHandlers } from '../../engine/handlers/utilityHandlers.js';
import { analyzeWorkflowReadiness } from './workflowReadiness.js';
import { hashWorkflowGraph } from '../graphHash.js';

export type WorkflowHealthStatus = 'healthy' | 'unverified' | 'blocked';
export type WorkflowHealthConfidence = 'static' | 'simulated';
/**
 * `canvas` — design-time "is this graph shaped right?" preview. Fabricates a
 * representative sample from the input contract so the operator sees structure
 * health before they have real input.
 * `run-gate` — pre-run / pre-activation gate. Uses the EXACT input the engine will
 * use (empty stays empty) so a missing required input is blocked here instead of
 * dead-ending the live run. Preflight and the engine must agree on input.
 */
export type WorkflowHealthMode = 'canvas' | 'run-gate';

export interface WorkflowHealthIssue {
  code: string;
  severity: 'error' | 'warning';
  nodeId?: string;
  nodeTitle?: string;
  message: string;
  remediation?: string;
  autoRepairable: boolean;
}

export interface NodeHealthResult {
  nodeId: string;
  title: string;
  kind: string;
  status: 'passed' | 'mocked' | 'unverified' | 'failed';
  durationMs: number;
  /** P2.3: the resolved input this node received (compacted). The I/O trace pairs
   *  it with `output` so a lost/empty payload is visible node-by-node. */
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
}

export interface WorkflowHealthReport {
  workflowId: string;
  graphHash: string;
  status: WorkflowHealthStatus;
  confidence: WorkflowHealthConfidence;
  checkedAt: string;
  durationMs: number;
  cacheHit: boolean;
  scenario: { name: string; source: 'provided' | 'contract' | 'empty'; input: Record<string, unknown> };
  nodes: Record<string, NodeHealthResult>;
  issues: WorkflowHealthIssue[];
}

const handlers = new NodeHandlerRegistry();
registerPureNodeHandlers(handlers);
// P2.2 (WORKFLOW-BUILD-LOOP): also execute the DETERMINISTIC utility kinds for
// real in the dry-run (datetime/crypto/xml/markdown/json-schema/html/sticky) —
// they were silently mocked before, masking real shape errors. Pure handlers
// ((config, {inputData, tctx})) only, so they stay side-effect-free here too.
registerUtilityNodeHandlers(handlers);

const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 500;
const cache = new Map<string, { expiresAt: number; report: WorkflowHealthReport }>();

export function preflightWorkflow(args: {
  db: AgentisSqliteDb;
  workspaceId: string;
  workflowId: string;
  graph: WorkflowGraph;
  inputs?: Record<string, unknown>;
  /** Defaults to `canvas`. Use `run-gate` for the `/run` + activate + build gates. */
  mode?: WorkflowHealthMode;
}): WorkflowHealthReport {
  const startedAt = performance.now();
  const mode: WorkflowHealthMode = args.mode ?? 'canvas';
  const graphHash = hashWorkflowGraph(args.graph);
  const scenario = selectScenario(args.graph.inputContract, args.inputs, mode);
  const dependencyHash = preflightDependencyHash(args.db, args.workspaceId, args.graph);
  const cacheKey = `${args.workspaceId}:${args.workflowId}:${graphHash}:${dependencyHash}:${mode}:${stableHash(scenario.input)}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.report, cacheHit: true, durationMs: roundMs(performance.now() - startedAt) };
  }

  const issues: WorkflowHealthIssue[] = [];
  const nodes: Record<string, NodeHealthResult> = {};
  try {
    validateWorkflowGraph(args.graph);
  } catch (error) {
    issues.push({
      code: 'GRAPH_INVALID',
      severity: 'error',
      message: (error as Error).message,
      remediation: 'Fix the graph configuration before running or activating.',
      autoRepairable: true,
    });
  }
  for (const issue of validateGraphReferences(args.graph)) {
    issues.push({
      code: issue.code.toUpperCase(),
      severity: issue.severity,
      nodeId: issue.nodeId,
      nodeTitle: issue.nodeTitle,
      message: issue.message,
      remediation: 'Connect the referenced node upstream or correct the reference.',
      autoRepairable: true,
    });
  }
  if (needsReadinessLookup(args.graph)) {
    for (const requirement of analyzeWorkflowReadiness(args.db, args.workspaceId, args.graph).requirements) {
      issues.push({
        code: requirement.kind === 'credential' ? 'CREDENTIAL_REQUIRED' : 'CONFIG_REQUIRED',
        severity: 'warning',
        nodeId: requirement.nodeId,
        nodeTitle: requirement.nodeTitle,
        message: requirement.message,
        autoRepairable: false,
      });
    }
  }
  validateContractInput(args.graph.inputContract, scenario.input, issues);
  checkAgentBindings(args.graph, { db: args.db, workspaceId: args.workspaceId }, issues);
  checkAgentActionContracts(args.graph, issues);

  if (!issues.some((issue) => issue.severity === 'error')) {
    simulateGraph(args.graph, scenario.input, nodes, issues, { db: args.db, workspaceId: args.workspaceId });
  }

  const hasErrors = issues.some((issue) => issue.severity === 'error');
  const hasUnverified = Object.values(nodes).some((node) => node.status === 'unverified' || node.status === 'mocked')
    || issues.some((issue) => issue.severity === 'warning');
  const report: WorkflowHealthReport = {
    workflowId: args.workflowId,
    graphHash,
    status: hasErrors ? 'blocked' : hasUnverified ? 'unverified' : 'healthy',
    confidence: Object.keys(nodes).length > 0 ? 'simulated' : 'static',
    checkedAt: new Date().toISOString(),
    durationMs: roundMs(performance.now() - startedAt),
    cacheHit: false,
    scenario,
    nodes,
    issues,
  };
  cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, report });
  trimCache();
  return report;
}

function simulateGraph(
  graph: WorkflowGraph,
  triggerInput: Record<string, unknown>,
  results: Record<string, NodeHealthResult>,
  issues: WorkflowHealthIssue[],
  deps: { db: AgentisSqliteDb; workspaceId: string },
): void {
  const outputs: Record<string, Record<string, unknown>> = {};
  const incoming = new Map<string, string[]>();
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges.filter((edge) => edge.type !== 'error')) {
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }
  const queue = graph.nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0);
  while (queue.length > 0) {
    const node = queue.shift()!;
    const nodeStarted = performance.now();
    const input = mergeInputs(
      (incoming.get(node.id) ?? [])
        .map((id) => outputs[id])
        .filter((output): output is Record<string, unknown> => output !== undefined),
    );
    const effectiveInput = node.config.kind === 'trigger' ? triggerInput : input;
    const tctx = buildTemplateContext({
      inputData: effectiveInput,
      triggerInputs: triggerInput,
      nodeOutputs: outputs,
      scratchpad: {},
      store: {},
    });
    try {
      const handler = handlers.get(node.config.kind);
      let output: Record<string, unknown>;
      let status: NodeHealthResult['status'] = 'passed';
      if (handler) {
        output = handler.execute(node.config, { inputData: effectiveInput, tctx });
      } else if (isPassthrough(node)) {
        output = effectiveInput;
      } else if (node.config.kind === 'extension_task') {
        // Truthful extension check: resolve the bound extension's REAL source and
        // statically verify it against the sandbox runtime contract (no module
        // system, valid syntax, an entrypoint). This is the class that was
        // invisible when extensions were blind-mocked — `require is not defined`,
        // a syntax error, or a missing entrypoint are now caught here in µs.
        resolveTemplateDeep(node.config, tctx);
        const check = verifyExtensionSource(deps, node.config as ExtensionTaskNodeConfig);
        if (!check.ok) throw new PreflightNodeError(check.message, check.code, check.remediation);
        output = mockOutput(node, effectiveInput, check.outputSchema);
        status = 'mocked';
      } else if (node.config.kind === 'integration') {
        // Truthful integration check: resolve the node config against real
        // upstream output, then probe the resolved inputs against the connector's
        // operationContract — the SAME contract the runtime enforces in
        // ConnectorRegistry. A required field that no template/alias maps is the
        // class that was invisible when integrations were blind-mocked (the run
        // dead-ends with "X is required"); it is now blocked here.
        const resolved = resolveTemplateDeep(node.config, tctx) as IntegrationNodeConfig;
        const check = verifyIntegrationContract(deps, resolved, effectiveInput);
        if (!check.ok) throw new PreflightNodeError(check.message, check.code, check.remediation);
        output = mockOutput(node, effectiveInput);
        status = 'mocked';
      } else if (node.config.kind === 'http_request') {
        // Same contract probe for raw HTTP: an unresolved `{{...}}` url (which
        // passes the static graph check as a non-empty template, but resolves to
        // empty against real upstream output) is blocked instead of mocked away.
        const resolved = resolveTemplateDeep(node.config, tctx) as HttpRequestNodeConfig;
        const check = verifyHttpRequestContract(resolved, effectiveInput);
        if (!check.ok) throw new PreflightNodeError(check.message, check.code, check.remediation);
        output = mockOutput(node, effectiveInput);
        status = 'mocked';
      } else {
        const resolved = resolveTemplateDeep(node.config, tctx);
        output = mockOutput(node, effectiveInput, undefined, resolved);
        status = isDeterministicMock(node) ? 'mocked' : 'unverified';
      }
      outputs[node.id] = output;
      results[node.id] = {
        nodeId: node.id,
        title: node.title,
        kind: node.config.kind,
        status,
        durationMs: roundMs(performance.now() - nodeStarted),
        input: compactOutput(effectiveInput),
        output: compactOutput(output),
      };
    } catch (error) {
      const message = (error as Error).message;
      const typed = error instanceof PreflightNodeError ? error : null;
      results[node.id] = {
        nodeId: node.id,
        title: node.title,
        kind: node.config.kind,
        status: 'failed',
        durationMs: roundMs(performance.now() - nodeStarted),
        input: compactOutput(effectiveInput),
        error: message,
      };
      issues.push({
        code: typed?.code ?? 'NODE_SIMULATION_FAILED',
        severity: 'error',
        nodeId: node.id,
        nodeTitle: node.title,
        message,
        remediation: typed?.remediation
          ?? 'Provide representative workflow input or update the node expression to handle missing values.',
        // Graph-level repair can fix structural/expression issues, but not broken
        // extension source — that needs the extension to be regenerated/fixed.
        autoRepairable: typed === null,
      });
      outputs[node.id] = {};
    }
    for (const edge of graph.edges.filter((candidate) => candidate.source === node.id && candidate.type !== 'error')) {
      indegree.set(edge.target, (indegree.get(edge.target) ?? 1) - 1);
      if (indegree.get(edge.target) === 0) {
        const target = graph.nodes.find((candidate) => candidate.id === edge.target);
        if (target) queue.push(target);
      }
    }
  }
}

/**
 * Error carrying a precise preflight code + remediation out of node simulation,
 * so the catch can surface the real issue (e.g. broken extension source) instead
 * of a generic NODE_SIMULATION_FAILED.
 */
class PreflightNodeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly remediation: string,
  ) {
    super(message);
    this.name = 'PreflightNodeError';
  }
}

function selectScenario(
  contract: WorkflowContract | undefined,
  provided: Record<string, unknown> | undefined,
  mode: WorkflowHealthMode,
) {
  if (provided && Object.keys(provided).length > 0) return { name: 'Provided input', source: 'provided' as const, input: provided };
  // run-gate must mirror the engine: empty stays empty so a missing required
  // input is caught HERE, not on the live run. Never fabricate a sample.
  if (mode === 'run-gate') return { name: 'Run input', source: 'empty' as const, input: provided ?? {} };
  const input = contractInput(contract);
  return Object.keys(input).length > 0
    ? { name: 'Contract sample', source: 'contract' as const, input }
    : { name: 'Empty input', source: 'empty' as const, input: {} };
}

/**
 * Resolve the bound extension's stored source and statically validate it against
 * the sandbox runtime contract. Reuses {@link validateExtensionSource} — the same
 * gate the creation path uses — so preflight and creation agree on what is valid.
 */
function verifyExtensionSource(
  deps: { db: AgentisSqliteDb; workspaceId: string },
  config: ExtensionTaskNodeConfig,
): { ok: true; outputSchema?: unknown } | { ok: false; code: string; message: string; remediation: string } {
  const row = config.extensionId
    ? deps.db.select().from(schema.extensions).where(eq(schema.extensions.id, config.extensionId)).get()
    : config.extensionSlug
      ? deps.db.select().from(schema.extensions).where(eq(schema.extensions.slug, config.extensionSlug)).get()
      : undefined;
  if (!row || row.workspaceId !== deps.workspaceId) {
    const ref = config.extensionId ?? config.extensionSlug ?? '(unspecified)';
    return {
      ok: false,
      code: 'EXTENSION_NOT_FOUND',
      message: `This step references extension "${ref}", which does not exist in this workspace.`,
      remediation: 'Re-create or re-bind the extension before the workflow can run.',
    };
  }
  const manifest = row.manifest as ExtensionManifest | null;
  const operationNames = (manifest?.operations ?? []).map((operation) => operation.name);
  if (!operationNames.includes(config.operationName)) {
    return {
      ok: false,
      code: 'EXTENSION_OPERATION_NOT_FOUND',
      message: `Extension "${manifest?.slug ?? row.slug}" does not declare operation "${config.operationName}".`,
      remediation: `Choose one of the declared operations: ${operationNames.join(', ') || '(none)'}.`,
    };
  }
  // Only node_worker extensions carry inline source we can statically check.
  const operation = manifest?.operations.find((candidate) => candidate.name === config.operationName);
  if (!manifest || manifest.runtime !== 'node_worker') return { ok: true, outputSchema: operation?.outputSchema };
  const source = typeof manifest.source === 'string' ? manifest.source : '';
  if (!source) {
    return {
      ok: false,
      code: 'EXTENSION_SOURCE_INVALID',
      message: `Extension "${manifest.slug}" has no source code.`,
      remediation: 'Re-create the extension with valid source.',
    };
  }
  const result = validateExtensionSource(source, operationNames);
  if (result.ok) return { ok: true, outputSchema: operation?.outputSchema };
  return { ok: false, code: result.issue.code, message: result.issue.message, remediation: result.issue.remediation };
}

type ContractCheck = { ok: true } | { ok: false; code: string; message: string; remediation: string };

/**
 * Resolve the operation contract the runtime would enforce for an integration
 * node, mirroring {@link WorkflowEngine}'s dispatch order: a registered builtin
 * connector first, then the workspace's custom HTTP manifest. Returns undefined
 * when no contract is declared (generic HTTP connectors) — the node then stays
 * mocked because there is nothing to probe.
 */
function resolveOperationContract(
  deps: { db: AgentisSqliteDb; workspaceId: string },
  integrationId: string,
  operationId: string,
): ConnectorOperationContract | undefined {
  if (!integrationId || !operationId) return undefined;
  if (defaultConnectorRegistry.has(integrationId)) {
    return defaultConnectorRegistry.get(integrationId).operationContracts?.[operationId];
  }
  try {
    const manifest = getCustomIntegrationManifest(deps.db, deps.workspaceId, integrationId);
    return manifestHttpConnector(manifest).operationContracts?.[operationId];
  } catch {
    return undefined;
  }
}

/**
 * Contract probe for an `integration` node. After templates have been resolved
 * against real upstream output, verify the node's inputs satisfy every REQUIRED
 * operation field (reusing {@link missingContractFields}, the same gate
 * ConnectorRegistry runs at dispatch). A field nothing maps becomes a blocked
 * `INTEGRATION_CONFIG_INCOMPLETE` that names it — instead of a silent mocked pass
 * that dead-ends the live run.
 */
function verifyIntegrationContract(
  deps: { db: AgentisSqliteDb; workspaceId: string },
  config: IntegrationNodeConfig,
  inputData: Record<string, unknown>,
): ContractCheck {
  const integrationId = String(config.integrationId ?? '');
  const operationId = String(config.operationId ?? '');
  // Missing connector/operation ids are a different class, surfaced by graph
  // validation; nothing to probe against here.
  if (!integrationId || !operationId) return { ok: true };
  if (defaultConnectorRegistry.has(integrationId)
    && !defaultConnectorRegistry.get(integrationId).operations.includes(operationId)) {
    return {
      ok: false,
      code: 'INTEGRATION_OPERATION_NOT_FOUND',
      message: `Integration "${integrationId}" does not provide operation "${operationId}".`,
      remediation: `Choose one of: ${defaultConnectorRegistry.get(integrationId).operations.join(', ')}.`,
    };
  }
  const contract = resolveOperationContract(deps, integrationId, operationId);
  if (!contract) return { ok: true };
  const params = isRecord(config.inputs) ? config.inputs : {};
  const missing = missingContractFields(params, inputData, contract);
  if (missing.length === 0) return { ok: true };
  const fields = missing.join(', ');
  return {
    ok: false,
    code: 'INTEGRATION_CONFIG_INCOMPLETE',
    message: `Step maps to ${integrationId}.${operationId} but required field(s) are unmapped: ${fields}.`,
    remediation: `Map ${fields} from an upstream step's output, or set ${missing.length === 1 ? 'it' : 'them'} on this step.`,
  };
}

/**
 * Contract probe for an `http_request` node against the `http_request`
 * connector's contract (`url` required). The static graph check only sees the
 * raw template string; once resolved against upstream output, an unmappable url
 * collapses to empty and is blocked here.
 */
function verifyHttpRequestContract(
  config: HttpRequestNodeConfig,
  inputData: Record<string, unknown>,
): ContractCheck {
  const contract = defaultConnectorRegistry.has('http_request')
    ? defaultConnectorRegistry.get('http_request').operationContracts?.request
    : undefined;
  if (!contract) return { ok: true };
  const missing = missingContractFields({ url: config.url }, inputData, contract);
  if (missing.length === 0) return { ok: true };
  const fields = missing.join(', ');
  return {
    ok: false,
    code: 'INTEGRATION_CONFIG_INCOMPLETE',
    message: `HTTP request step is missing required field(s): ${fields}.`,
    remediation: `Set the request ${fields} — an unresolved {{template}} reference can leave it empty.`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contractInput(contract?: WorkflowContract): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of contract?.fields ?? []) {
    if (!field.required) continue;
    out[field.key] = field.type === 'string' ? `sample_${field.key}`
      : field.type === 'number' ? 1
        : field.type === 'boolean' ? true
          : field.type === 'array' ? []
            : {};
  }
  return out;
}

function validateContractInput(
  contract: WorkflowContract | undefined,
  input: Record<string, unknown>,
  issues: WorkflowHealthIssue[],
): void {
  for (const field of contract?.fields ?? []) {
    if (field.required && (input[field.key] === undefined || input[field.key] === null || input[field.key] === '')) {
      issues.push({
        code: 'REQUIRED_INPUT_MISSING',
        severity: 'error',
        message: `Workflow input "${field.key}" is required but the preflight scenario does not provide it.`,
        remediation: `Add "${field.key}" to the test input or make it optional.`,
        autoRepairable: false,
      });
    }
  }
}

/**
 * Surface fragile agent bindings BEFORE a run. A node explicitly pinned to an
 * agent that no longer exists, or to a non-functional placeholder (an `http` stub
 * with no model/runtime), would have produced empty output at run time — the most
 * common real-world failure. The engine now falls back to the workspace model, but
 * the operator should still see the misconfig and fix it. Warning, not error:
 * role-resolved nodes (no explicit agentId) and agents with a model are left alone.
 */
function checkAgentBindings(
  graph: WorkflowGraph,
  deps: { db: AgentisSqliteDb; workspaceId: string },
  issues: WorkflowHealthIssue[],
): void {
  for (const node of graph.nodes) {
    if (node.config.kind !== 'agent_task' && node.config.kind !== 'agent_session') continue;
    const agentId = (node.config as { agentId?: unknown }).agentId;
    if (typeof agentId !== 'string' || !agentId.trim()) continue; // role-resolved → engine picks a runtime
    const agent = deps.db
      .select({ name: schema.agents.name, adapterType: schema.agents.adapterType, runtimeModel: schema.agents.runtimeModel, config: schema.agents.config, isPaused: schema.agents.isPaused })
      .from(schema.agents)
      .where(and(eq(schema.agents.id, agentId), eq(schema.agents.workspaceId, deps.workspaceId)))
      .get();
    if (!agent) {
      issues.push({
        code: 'AGENT_NOT_FOUND',
        severity: 'error',
        nodeId: node.id,
        nodeTitle: node.title,
        message: 'This step is pinned to an agent that no longer exists in this workspace.',
        remediation: 'Re-bind the step to an existing agent, or set a role so the engine resolves one.',
        autoRepairable: false,
      });
      continue;
    }
    if (agent.isPaused) {
      issues.push({
        code: 'AGENT_PAUSED',
        severity: 'error',
        nodeId: node.id,
        nodeTitle: node.title,
        message: `Agent "${agent.name}" is paused and cannot execute this step.`,
        remediation: 'Resume the existing specialist or re-bind the step to another online agent.',
        autoRepairable: false,
      });
      continue;
    }
    const hasModel = Boolean(stringValueOf(agent.runtimeModel) || configuredModelOf(agent.config));
    if (!hasModel && agent.adapterType === 'http') {
      issues.push({
        code: 'AGENT_NO_RUNTIME',
        severity: 'warning',
        nodeId: node.id,
        nodeTitle: node.title,
        message: `Agent "${agent.name}" has no connected runtime or model; this step would produce no output and will fall back to the workspace model at run time.`,
        remediation: 'Connect a model/runtime to this agent so the step runs as intended.',
        autoRepairable: false,
      });
    }
  }
}

function stringValueOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function configuredModelOf(raw: unknown): string | null {
  try {
    const config = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return isRecord(config) ? stringValueOf((config as { model?: unknown }).model) : null;
  } catch {
    return null;
  }
}

function isPassthrough(node: WorkflowNode): boolean {
  return ['trigger', 'merge', 'parallel', 'wait', 'return_output'].includes(node.config.kind);
}

function isDeterministicMock(node: WorkflowNode): boolean {
  return ['integration', 'http_request', 'extension_task', 'browser', 'artifact_save', 'knowledge'].includes(node.config.kind);
}

function needsReadinessLookup(graph: WorkflowGraph): boolean {
  return graph.nodes.some((node) => (
    node.config.kind === 'integration'
    || node.config.kind === 'http_request'
    || (node.config.kind === 'trigger' && node.config.triggerType !== 'manual')
  ));
}

/** P2.4: synthesize a TYPED mock value from an output-key name so a mocked
 *  side-effecting node hands downstream DETERMINISTIC nodes realistic shapes
 *  (arrays/numbers/booleans) instead of `sample_<key>` strings — otherwise a
 *  downstream .map()/.length/numeric op silently mis-behaves in the dry-run. */
function mockValueForKey(key: string): unknown {
  const k = key.toLowerCase();
  if (/^(is|has|should|can|did|are|was|allow)/.test(k) || /(pass|passed|ok|approved|valid|found|done|enabled|success|active|selected)$/.test(k)) return true;
  if (/(count|total|score|num|amount|qty|quantity|size|length|index|rank|priority|threshold|min|max|sum|avg|age|price|rate)$/.test(k) || /^(count|total|score|num)/.test(k)) return 1;
  if (/(candidates|items|results|records|entries|matches|rows|leads|posts|stores|messages|events|files|urls|links|ids|list|array|batch|queue|hits|documents|docs|contacts|orders|tickets|tasks)$/.test(k)) return [{}];
  return `sample_${key}`;
}

function mockOutput(
  node: WorkflowNode,
  input: Record<string, unknown>,
  outputSchema?: unknown,
  resolvedConfig?: unknown,
): Record<string, unknown> {
  const config = node.config as unknown as Record<string, unknown>;
  if (node.config.kind === 'data_mutate') {
    const resolved = isRecord(resolvedConfig) ? resolvedConfig : config;
    const records = Array.isArray(resolved.records) ? resolved.records : null;
    const attempted = records ? records.length : 1;
    const outputKey = typeof resolved.outputKey === 'string'
      ? resolved.outputKey
      : records ? 'records' : resolved.operation === 'delete' ? 'deleted' : 'record';
    const value = records ?? (isRecord(resolved.record) ? resolved.record : input);
    return {
      [outputKey]: value,
      mutationReceipt: {
        attempted,
        succeeded: attempted,
        failed: 0,
        skipped: 0,
        idempotencyKey: `preflight:${node.id}`,
        items: Array.from({ length: attempted }, (_, index) => ({ id: `preflight:${node.id}:${index}`, status: 'succeeded' })),
        verification: { performed: false, passed: true, detail: 'Dry-run receipt; no datastore mutation was executed.' },
        evidence: { source: 'preflight', collection: resolved.collection },
      },
      _preflight: { nodeId: node.id, kind: node.config.kind, mocked: true },
    };
  }
  const schemaSample = sampleFromJsonSchema(outputSchema);
  if (isRecord(schemaSample)) {
    return {
      ...schemaSample,
      _preflight: { nodeId: node.id, kind: node.config.kind, mocked: true, source: 'output_schema' },
    };
  }
  const outputKeys = Array.isArray(config.outputKeys) ? config.outputKeys.filter((key): key is string => typeof key === 'string') : [];
  if (outputKeys.length > 0) {
    return {
      ...Object.fromEntries(outputKeys.map((key) => [key, mockValueForKey(key)])),
      _preflight: {
        nodeId: node.id,
        kind: node.config.kind,
        mocked: true,
        declaredOutputKeys: outputKeys,
      },
    };
  }
  return { ...input, _preflight: { nodeId: node.id, kind: node.config.kind, mocked: true } };
}

function checkAgentActionContracts(graph: WorkflowGraph, issues: WorkflowHealthIssue[]): void {
  const agentTasks = graph.nodes.filter((node) => node.config.kind === 'agent_task');
  const hasNativeChannel = graph.nodes.some((node) => node.config.kind === 'channel');
  for (const node of agentTasks) {
    if (node.config.kind !== 'agent_task') continue;
    const actionLanguage = /\b(send|message|whats\s*app|contact|outreach|update|move|schedule|follow[ -]?up|envi|mensagem|contat|mova|atualiz)\b/i.test(node.config.prompt);
    if (actionLanguage && !node.config.taskMode) {
      issues.push({ code: 'AGENT_ACTION_MODE_AMBIGUOUS', severity: 'warning', nodeId: node.id, nodeTitle: node.title,
        message: 'This Agent Task appears to perform external actions but has no taskMode/effect contract.',
        remediation: 'Set taskMode="act" and declare the native effects that must be verified.', autoRepairable: true });
    }
    if (node.config.taskMode === 'act' && !node.config.completionContract?.requiredEffects?.length) {
      issues.push({ code: 'ACTION_COMPLETION_CONTRACT_MISSING', severity: 'error', nodeId: node.id, nodeTitle: node.title,
        message: 'Action Agent Tasks must declare at least one required platform effect.',
        remediation: 'Add completionContract.requiredEffects, such as channel_delivery and data_mutation.', autoRepairable: true });
    }
    if (graph.nodes.length > 2 && node.config.taskMode === 'act'
      && node.config.completionContract?.requiredEffects.includes('channel_delivery') && !hasNativeChannel) {
      issues.push({ code: 'AGENT_SELF_REPORTED_DELIVERY', severity: 'error', nodeId: node.id, nodeTitle: node.title,
        message: 'A multi-node workflow cannot delegate delivery to an Agent Task.',
        remediation: 'Have the Agent compose/select upstream, then use a native channel node and gate state updates on its receipt.', autoRepairable: true });
    }
  }
}

function sampleFromJsonSchema(schema: unknown, key = 'value'): unknown {
  if (!isRecord(schema)) return undefined;
  if ('example' in schema) return schema.example;
  if ('default' in schema) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const type = typeof schema.type === 'string' ? schema.type : undefined;
  if (type === 'object' || isRecord(schema.properties)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    return Object.fromEntries(Object.entries(properties).map(([childKey, childSchema]) => [childKey, sampleFromJsonSchema(childSchema, childKey)]));
  }
  if (type === 'array') return [sampleFromJsonSchema(schema.items, key.replace(/s$/u, '') || 'item') ?? {}];
  if (type === 'number' || type === 'integer') return 1;
  if (type === 'boolean') return true;
  if (type === 'null') return null;
  return `sample_${key}`;
}

function mergeInputs(inputs: Record<string, unknown>[]): Record<string, unknown> {
  return Object.assign({}, ...inputs);
}

function compactOutput(output: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(output).slice(0, 20));
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function preflightDependencyHash(db: AgentisSqliteDb, workspaceId: string, graph: WorkflowGraph): string {
  const dependencies = graph.nodes.flatMap((node) => {
    if (node.config.kind !== 'extension_task') return [];
    const config = node.config as ExtensionTaskNodeConfig;
    const row = config.extensionId
      ? db.select({ id: schema.extensions.id, updatedAt: schema.extensions.updatedAt })
          .from(schema.extensions).where(and(eq(schema.extensions.workspaceId, workspaceId), eq(schema.extensions.id, config.extensionId))).get()
      : config.extensionSlug
        ? db.select({ id: schema.extensions.id, updatedAt: schema.extensions.updatedAt })
            .from(schema.extensions).where(and(eq(schema.extensions.workspaceId, workspaceId), eq(schema.extensions.slug, config.extensionSlug))).get()
        : undefined;
    return [{ nodeId: node.id, extensionId: row?.id ?? config.extensionId ?? config.extensionSlug ?? null, updatedAt: row?.updatedAt ?? null }];
  });
  return stableHash(dependencies);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function trimCache(): void {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  const first = cache.keys().next().value as string | undefined;
  if (first) cache.delete(first);
}
