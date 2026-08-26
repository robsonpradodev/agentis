import { createHash } from 'node:crypto';
import type { WorkflowNode } from '@agentis/core';

export type WorkflowFailureClass =
  | 'expected_business'
  | 'human_policy'
  | 'configuration_capability'
  | 'transient_resource'
  | 'data_contract'
  | 'graph_design'
  | 'platform'
  | 'cancellation_propagated'
  | 'unknown';

export type WorkflowFailureDisposition =
  | 'business_outcome'
  | 'waiting'
  | 'blocked_setup'
  | 'retry'
  | 'failed'
  | 'quarantine'
  | 'cancelled';

export interface WorkflowFailureClassification {
  category: WorkflowFailureClass;
  canonicalCode: string;
  graphRepairEligible: boolean;
  retryable: boolean;
  learnerEligible: boolean;
  disposition: WorkflowFailureDisposition;
  operatorAction: string | null;
  reason: string;
}

export interface WorkflowFailureFingerprintInput {
  classification: WorkflowFailureClassification;
  revisionKey: string;
  node: Pick<WorkflowNode, 'id' | 'type' | 'config'>;
  error: string;
  contractPath?: string | null;
}

const POLICY_CODE = /\b(BLOCKED_[A-Z0-9_]+|APPROVAL_[A-Z0-9_]+|POLICY_[A-Z0-9_]+)\b/;
const SETUP_CODE = /\b(CONFIG_[A-Z0-9_]+|CAPABILITY_[A-Z0-9_]+|CREDENTIAL_[A-Z0-9_]+|AGENT_(?:NOT_FOUND|PAUSED|OFFLINE|RUNTIME_UNAVAILABLE))\b/;
const CONTRACT_CODE = /\b(CONTRACT_[A-Z0-9_]+|OUTPUT_[A-Z0-9_]+|INPUT_[A-Z0-9_]+|VALIDATION_[A-Z0-9_]+)\b/;
const GRAPH_CODE = /\b(WORKFLOW_GRAPH_[A-Z0-9_]+|GRAPH_[A-Z0-9_]+|NODE_[A-Z0-9_]+)\b/;

/** One deterministic policy for every consumer. */
export function classifyWorkflowFailure(
  error: unknown,
  metadata: Record<string, unknown> = {},
): WorkflowFailureClassification {
  const message = failureMessage(error);
  const explicitClass = stringValue(metadata.failureClass);
  const explicitCode = stringValue(metadata.code) || codeFromError(error) || canonicalCode(message);

  if (explicitClass && isFailureClass(explicitClass)) {
    return policyFor(explicitClass, explicitCode, `Typed failure metadata classified this as ${explicitClass}.`);
  }
  if (
    booleanValue(metadata.propagated)
    || booleanValue(metadata.cancelled)
    || /\b(cancel(?:led|ed|lation)|aborted|parent run|child (?:run|workflow).*(?:failed|cancelled)|propagated)\b/i.test(message)
  ) {
    return policyFor('cancellation_propagated', explicitCode, 'Cancellation and child propagation are execution state, not graph defects.');
  }
  if (
    booleanValue(metadata.expectedBusinessOutcome)
    || /\b(expected (?:rejection|business outcome)|not eligible|declined|duplicate lead|already processed|no matching records?|nothing to (?:send|process))\b/i.test(message)
  ) {
    return policyFor('expected_business', explicitCode, 'The workflow reached an expected business outcome.');
  }
  if (
    /\bBLOCKED_[A-Z0-9_]+\b/i.test(message)
    && !/\bBLOCKED_(?:LIFECYCLE|POLICY|APPROVAL)_[A-Z0-9_]+\b/i.test(message)
  ) {
    return policyFor('data_contract', explicitCode, 'A workflow guard rejected the expression result and should be designed as a corrective path.');
  }
  if (
    POLICY_CODE.test(message)
    || /\b(awaiting approval|approval (?:required|denied|pending)|policy (?:blocked|denied)|human (?:input|review|required)|manual checkpoint)\b/i.test(message)
  ) {
    return policyFor('human_policy', explicitCode, 'A deliberate human or policy boundary stopped execution.');
  }
  if (/\b(?:pinned|assigned)?\s*agent\b.{0,120}\b(?:has )?no (?:connected|executable) runtime\b/i.test(message)
    || /\bruntime\b.{0,80}\b(?:not connected|offline|disconnected|unavailable)\b/i.test(message)
    || /\bagent\b.{0,120}\b(?:is )?(?:offline|disconnected|unavailable)\b/i.test(message)) {
    return policyFor(
      'configuration_capability',
      explicitCode === 'UNCLASSIFIED_FAILURE' ? 'AGENT_RUNTIME_UNAVAILABLE' : explicitCode,
      'The selected agent runtime is disconnected; this is an execution binding problem, not a workflow graph defect.',
    );
  }
  if (
    SETUP_CODE.test(message)
    || /\b(missing|unknown|unavailable|not configured|not installed|no executable runtime|no provider|no adapter)\b.{0,80}\b(credential|configuration|config|capability|operation|extension|tool|binary|runtime|agent|working directory|environment variable)\b/i.test(message)
    || /\b(credential|api key|environment variable|working directory)\b.{0,80}\b(missing|required|not found|unavailable)\b/i.test(message)
  ) {
    return policyFor('configuration_capability', explicitCode, 'The environment cannot execute the requested operation as configured.');
  }
  if (/\b(rate.?limit|429|quota|credits?|billing|out of memory|oom|econnreset|econnrefused|enotfound|etimedout|timed out|timeout|appears stuck|went quiet|socket hang|network error|fetch failed|temporar(?:y|ily)|service unavailable|502|503|504|resource exhausted|provider busy)\b/i.test(message)) {
    return policyFor('transient_resource', explicitCode, 'A resource or provider failed transiently; graph surgery cannot restore that resource.');
  }
  if (/\b(internal invariant|assertion failed|not implemented|unexpected engine|database corrupt|sqlite|cannot read properties|is not a function|platform defect|engine defect)\b/i.test(message)) {
    return policyFor('platform', explicitCode, 'The failure originated in Agentis/runtime infrastructure.');
  }
  if (
    CONTRACT_CODE.test(message)
    || /\b(contract|schema|declared output|required (?:field|key)|type mismatch|invalid output|malformed (?:input|output)|validation failed)\b/i.test(message)
  ) {
    return policyFor('data_contract', explicitCode, 'The workflow violated a declared data boundary.');
  }
  if (
    GRAPH_CODE.test(message)
    || /\b(dangling|forward reference|unknown node|cycle detected|unreachable node|invalid graph|mapping expression|template reference|edge target|edge source)\b/i.test(message)
  ) {
    return policyFor('graph_design', explicitCode, 'The workflow graph or its data-flow wiring is invalid.');
  }
  return policyFor('unknown', explicitCode, 'The failure is not classified strongly enough to authorize structural mutation.');
}

export function workflowFailureFingerprint(input: WorkflowFailureFingerprintInput): string {
  const cfg = input.node.config as unknown as Record<string, unknown>;
  const operation = [
    stringValue(cfg.kind) || input.node.type,
    stringValue(cfg.operation),
    stringValue(cfg.extensionSlug),
    stringValue(cfg.integrationId),
  ].filter(Boolean).join(':');
  const normalizedError = failureMessage(input.error)
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<uuid>')
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?\b/gi, '<time>')
    .replace(/\b(?:run|task|request|trace|delivery)[-_ ]?id\s*[:=]\s*\S+/gi, 'id=<id>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  const canonical = [
    input.classification.category,
    input.classification.canonicalCode,
    input.revisionKey,
    input.node.id,
    operation,
    input.contractPath ?? '',
    normalizedError,
  ].join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

export function isStructuralRepairEligible(error: unknown, metadata?: Record<string, unknown>): boolean {
  return classifyWorkflowFailure(error, metadata).graphRepairEligible;
}

function policyFor(category: WorkflowFailureClass, canonicalCodeValue: string, reason: string): WorkflowFailureClassification {
  switch (category) {
    case 'expected_business':
      return { category, canonicalCode: canonicalCodeValue, graphRepairEligible: false, retryable: false, learnerEligible: false, disposition: 'business_outcome', operatorAction: null, reason };
    case 'human_policy':
      return { category, canonicalCode: canonicalCodeValue, graphRepairEligible: false, retryable: false, learnerEligible: false, disposition: 'waiting', operatorAction: 'Complete or reject the pending human/policy decision.', reason };
    case 'configuration_capability':
      return { category, canonicalCode: canonicalCodeValue, graphRepairEligible: false, retryable: false, learnerEligible: false, disposition: 'blocked_setup', operatorAction: 'Provide the named capability, credential, runtime, or configuration and resume.', reason };
    case 'transient_resource':
      return { category, canonicalCode: canonicalCodeValue, graphRepairEligible: false, retryable: true, learnerEligible: false, disposition: 'retry', operatorAction: 'Retry after the provider/resource recovers or change the bound resource.', reason };
    case 'data_contract':
      return { category, canonicalCode: canonicalCodeValue, graphRepairEligible: true, retryable: false, learnerEligible: true, disposition: 'failed', operatorAction: null, reason };
    case 'graph_design':
      return { category, canonicalCode: canonicalCodeValue, graphRepairEligible: true, retryable: false, learnerEligible: true, disposition: 'failed', operatorAction: null, reason };
    case 'platform':
      return { category, canonicalCode: canonicalCodeValue, graphRepairEligible: false, retryable: false, learnerEligible: false, disposition: 'quarantine', operatorAction: 'Inspect the Agentis platform/runtime defect; do not rewrite the workflow.', reason };
    case 'cancellation_propagated':
      return { category, canonicalCode: canonicalCodeValue, graphRepairEligible: false, retryable: false, learnerEligible: false, disposition: 'cancelled', operatorAction: null, reason };
    default:
      return { category, canonicalCode: canonicalCodeValue, graphRepairEligible: false, retryable: false, learnerEligible: false, disposition: 'failed', operatorAction: 'Diagnose and classify this failure before authorizing a graph repair.', reason };
  }
}

function failureMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error ?? '');
}

function codeFromError(error: unknown): string | null {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return null;
}

function canonicalCode(message: string): string {
  return message.match(/\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+\b/)?.[0] ?? 'UNCLASSIFIED_FAILURE';
}

function isFailureClass(value: string): value is WorkflowFailureClass {
  return [
    'expected_business', 'human_policy', 'configuration_capability', 'transient_resource',
    'data_contract', 'graph_design', 'platform', 'cancellation_propagated', 'unknown',
  ].includes(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function booleanValue(value: unknown): boolean {
  return value === true;
}
