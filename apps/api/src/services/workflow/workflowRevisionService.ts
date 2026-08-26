import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  AgentisError,
  summarizeGraphCapabilities,
  type WorkflowGraph,
  type WorkflowRunState,
} from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import { validateWorkflowGraph } from '../../engine/validateGraph.js';
import { hashWorkflowGraph } from '../graphHash.js';
import { readWorkflowSpec } from './workflowSpec.js';
import { diffWorkflowGraphs } from './workflowGraphMutation.js';

export type WorkflowRevisionStatus =
  | 'candidate'
  | 'verifying'
  | 'verified'
  | 'active'
  | 'rejected'
  | 'superseded';

export type WorkflowRevisionSource =
  | 'create'
  | 'user_edit'
  | 'agent_build'
  | 'self_heal'
  | 'agent_evolve'
  | 'normalization'
  | 'trigger_deployment'
  | 'instinct'
  | 'blueprint_restore'
  | 'migration'
  | 'rollback'
  | 'import';

export type WorkflowProofGate =
  | 'static'
  | 'capability'
  | 'dry_run'
  | 'regression'
  | 'clean_debug'
  | 'outcome'
  | 'operator_approval';

export interface WorkflowRevisionActor {
  type: 'user' | 'agent' | 'system';
  id?: string | null;
}

export interface CreateCandidateInput {
  workspaceId: string;
  workflowId: string;
  graph: WorkflowGraph;
  baseRevisionId?: string | null;
  source: WorkflowRevisionSource;
  actor: WorkflowRevisionActor;
  reason: string;
  allowBranch?: boolean;
  /** Branch revisions remain discoverable without displacing an operator draft. */
  setAsHead?: boolean;
}

export interface RecordProofInput {
  workspaceId: string;
  workflowId: string;
  revisionId: string;
  gate: WorkflowProofGate;
  status: 'passed' | 'failed' | 'blocked';
  fixtureKey?: string;
  runId?: string | null;
  capabilityCatalogVersion?: string | null;
  evidence?: Record<string, unknown>;
}

export interface PromotionResult {
  revisionId: string;
  activeRevisionId: string;
  trustState: 'proven' | 'break_glass';
  overriddenGates: WorkflowProofGate[];
}

export interface PromoteWorkflowRevisionInput {
  workspaceId: string;
  workflowId: string;
  revisionId: string;
  expectedActiveRevisionId: string;
  actor: WorkflowRevisionActor;
  operatorApproval?: boolean;
  overrideReason?: string;
}

const STANDARD_GATES: readonly WorkflowProofGate[] = [
  'static',
  'capability',
  'dry_run',
  'regression',
  'clean_debug',
  'outcome',
];

/**
 * The only authority allowed to change the production graph mirror.
 *
 * All edits are immutable candidates. A promotion transaction performs an
 * active-revision compare-and-swap and updates `workflows.graph` only after the
 * exact candidate hash has the required proof.
 */
export class WorkflowRevisionService {
  constructor(private readonly db: AgentisSqliteDb) {}

  ensureWorkflow(workspaceId: string, workflowId: string) {
    const workflow = this.workflow(workspaceId, workflowId);
    if (workflow.activeRevisionId) {
      const existing = this.revision(workspaceId, workflowId, workflow.activeRevisionId);
      if (existing) {
        const actualHash = this.currentHash(existing);
        if (workflow.trustState === 'legacy_unverified' && existing.semanticHash !== actualHash) {
          this.db.update(schema.workflowGraphRevisions).set({
            semanticHash: actualHash,
            presentationHash: presentationHash(existing.graphJson as WorkflowGraph),
            updatedAt: new Date().toISOString(),
          }).where(eq(schema.workflowGraphRevisions.id, existing.id)).run();
          return { workflow, active: this.revision(workspaceId, workflowId, existing.id)! };
        }
        return { workflow, active: existing };
      }
    }

    const graph = workflow.graph as WorkflowGraph;
    const semanticHash = hashWorkflowGraph(graph);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.insert(schema.workflowGraphRevisions).values({
        id,
        workspaceId,
        workflowId,
        graphJson: graph,
        semanticHash,
        presentationHash: presentationHash(graph),
        source: 'migration',
        actorType: 'system',
        reason: 'Compatibility revision created for a workflow without revision metadata',
        changeSummaryJson: {},
        specJson: readWorkflowSpec(workflow.settings),
        capabilityManifestJson: summarizeGraphCapabilities(graph),
        proofProfile: 'legacy',
        status: 'active',
        trustState: 'legacy_unverified',
        promotedAt: now,
        createdAt: now,
        updatedAt: now,
      }).run();
      this.db.update(schema.workflows).set({
        activeRevisionId: id,
        trustState: 'legacy_unverified',
        contentHash: semanticHash,
        updatedAt: now,
      }).where(and(
        eq(schema.workflows.id, workflowId),
        eq(schema.workflows.workspaceId, workspaceId),
      )).run();
    });
    return {
      workflow: { ...workflow, activeRevisionId: id, trustState: 'legacy_unverified' },
      active: this.revision(workspaceId, workflowId, id)!,
    };
  }

  /**
   * New package imports historically arrive with their graph already installed
   * as a legacy active revision. Demote that unexecuted graph to a candidate and
   * replace production with an inert baseline without losing either snapshot.
   */
  stageImportedLegacyAsCandidate(workspaceId: string, workflowId: string) {
    const { workflow, active } = this.ensureWorkflow(workspaceId, workflowId);
    if (workflow.candidateRevisionId) {
      return { active: this.active(workspaceId, workflowId).revision, candidate: this.candidate(workspaceId, workflowId)!.revision };
    }
    if (workflow.trustState !== 'legacy_unverified') {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'Only a newly imported legacy workflow may be staged as an initial candidate');
    }
    const graph = active.graphJson as WorkflowGraph;
    validateWorkflowGraph(graph, { currentWorkflowId: workflowId, strict: false });
    const capabilities = summarizeGraphCapabilities(graph);
    const unknownKinds = capabilities.unknownNodeKinds ?? [];
    const emptyGraph: WorkflowGraph = {
      version: 1,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    const emptyId = randomUUID();
    const now = new Date().toISOString();
    const proofProfile = capabilities.sendsDataExternally || capabilities.runsCode
      ? 'outward'
      : 'standard';
    this.db.transaction(() => {
      this.db.insert(schema.workflowGraphRevisions).values({
        id: emptyId,
        workspaceId,
        workflowId,
        graphJson: emptyGraph,
        semanticHash: hashWorkflowGraph(emptyGraph),
        presentationHash: presentationHash(emptyGraph),
        source: 'migration',
        actorType: 'system',
        reason: 'Inert production baseline for a newly imported workflow',
        changeSummaryJson: diffWorkflowGraphs(graph, emptyGraph),
        specJson: active.specJson,
        capabilityManifestJson: summarizeGraphCapabilities(emptyGraph),
        proofProfile: 'legacy',
        status: 'active',
        trustState: 'legacy_unverified',
        createdAt: now,
        updatedAt: now,
      }).run();
      this.db.update(schema.workflowGraphRevisions).set({
        status: 'candidate',
        proofProfile,
        trustState: 'unverified',
        reason: active.reason ?? 'Imported workflow awaiting verification',
        updatedAt: now,
      }).where(eq(schema.workflowGraphRevisions.id, active.id)).run();
      this.db.update(schema.workflows).set({
        graph: emptyGraph,
        contentHash: hashWorkflowGraph(emptyGraph),
        activeRevisionId: emptyId,
        candidateRevisionId: active.id,
        trustState: 'candidate',
        updatedAt: now,
      }).where(and(
        eq(schema.workflows.id, workflowId),
        eq(schema.workflows.workspaceId, workspaceId),
      )).run();
    });
    this.recordProof({
      workspaceId,
      workflowId,
      revisionId: active.id,
      gate: 'static',
      status: 'passed',
      evidence: { imported: true, validated: true },
    });
    this.recordProof({
      workspaceId,
      workflowId,
      revisionId: active.id,
      gate: 'capability',
      status: unknownKinds.length === 0 ? 'passed' : 'failed',
      evidence: { manifest: capabilities, unknownNodeKinds: unknownKinds },
    });
    return {
      active: this.revision(workspaceId, workflowId, emptyId)!,
      candidate: this.revision(workspaceId, workflowId, active.id)!,
    };
  }

  createCandidate(input: CreateCandidateInput) {
    validateWorkflowGraph(input.graph, { currentWorkflowId: input.workflowId, strict: false });
    const { workflow, active } = this.ensureWorkflow(input.workspaceId, input.workflowId);
    const headId = workflow.candidateRevisionId ?? active.id;
    const requestedBase = input.baseRevisionId ?? headId;
    if (!input.allowBranch && requestedBase !== headId) {
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        'This workflow changed after the editor loaded it. Refresh and re-apply the edit to the latest candidate.',
        {
          httpStatus: 409,
          details: {
            code: 'WORKFLOW_REVISION_CONFLICT',
            expectedBaseRevisionId: headId,
            receivedBaseRevisionId: requestedBase,
          },
        },
      );
    }
    const base = this.revision(input.workspaceId, input.workflowId, requestedBase);
    if (!base) {
      throw new AgentisError('RESOURCE_NOT_FOUND', 'Base workflow revision not found');
    }

    const semanticHash = hashWorkflowGraph(input.graph);
    const nextPresentationHash = presentationHash(input.graph);
    const specJson = readWorkflowSpec(workflow.settings);
    const sameGraphSemantics = semanticHash === base.semanticHash;
    const sameSpec = stableStringify(specJson) === stableStringify(base.specJson);
    const sameSemantics = sameGraphSemantics && sameSpec;
    if (sameSemantics && nextPresentationHash === base.presentationHash) {
      return {
        revision: base,
        presentationOnly: false,
        promotion: null,
        unchanged: true,
      };
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const capabilities = summarizeGraphCapabilities(input.graph);
    const unknownKinds = capabilities.unknownNodeKinds ?? [];
    const proofProfile = sameSemantics
      ? 'presentation'
      : capabilities.sendsDataExternally || capabilities.runsCode
        ? 'outward'
        : 'standard';
    const diff = diffWorkflowGraphs(base.graphJson as WorkflowGraph, input.graph);

    const setAsHead = input.setAsHead !== false;
    this.db.transaction(() => {
      if (setAsHead && workflow.candidateRevisionId) {
        this.db.update(schema.workflowGraphRevisions).set({
          status: 'superseded',
          updatedAt: now,
        }).where(and(
          eq(schema.workflowGraphRevisions.id, workflow.candidateRevisionId),
          eq(schema.workflowGraphRevisions.status, 'candidate'),
        )).run();
      }
      this.db.insert(schema.workflowGraphRevisions).values({
        id,
        workspaceId: input.workspaceId,
        workflowId: input.workflowId,
        parentRevisionId: requestedBase,
        graphJson: input.graph,
        semanticHash,
        presentationHash: nextPresentationHash,
        source: input.source,
        actorType: input.actor.type,
        actorId: input.actor.id ?? null,
        reason: input.reason,
        changeSummaryJson: diff,
        specJson,
        capabilityManifestJson: capabilities,
        proofProfile,
        status: sameSemantics ? 'verified' : 'candidate',
        trustState: sameSemantics ? 'proven_equivalent' : 'unverified',
        verifiedAt: sameSemantics ? now : null,
        createdAt: now,
        updatedAt: now,
      }).run();
      if (setAsHead) {
        this.db.update(schema.workflows).set({
          candidateRevisionId: id,
          trustState: 'candidate',
          updatedAt: now,
        }).where(and(
          eq(schema.workflows.id, input.workflowId),
          eq(schema.workflows.workspaceId, input.workspaceId),
        )).run();
      }
    });

    this.recordProof({
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      revisionId: id,
      gate: 'static',
      status: 'passed',
      evidence: { validated: true },
    });
    this.recordProof({
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      revisionId: id,
      gate: 'capability',
      status: unknownKinds.length === 0 ? 'passed' : 'failed',
      evidence: { manifest: capabilities, unknownNodeKinds: unknownKinds },
    });

    if (sameSemantics) {
      return {
        revision: this.revision(input.workspaceId, input.workflowId, id)!,
        presentationOnly: true,
        promotion: this.promote({
          workspaceId: input.workspaceId,
          workflowId: input.workflowId,
          revisionId: id,
          expectedActiveRevisionId: active.id,
          actor: input.actor,
        }),
      };
    }
    this.compactObsoleteAutosaves(input.workspaceId, input.workflowId);
    return {
      revision: this.revision(input.workspaceId, input.workflowId, id)!,
      presentationOnly: false,
      promotion: null,
    };
  }

  /**
   * Bound invisible editor checkpoints without touching published history or
   * any revision referenced by execution/repair/experience evidence.
   */
  private compactObsoleteAutosaves(workspaceId: string, workflowId: string, retain = 20) {
    const obsolete = this.revisions(workspaceId, workflowId)
      .filter((revision) => revision.source === 'user_edit'
        && revision.status === 'superseded'
        && !revision.promotedAt)
      .slice(retain);
    for (const revision of obsolete) {
      const hasRun = this.db.select({ id: schema.workflowRuns.id }).from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.workflowRevisionId, revision.id)).get();
      const hasExperience = this.db.select({ id: schema.workflowExperiences.id }).from(schema.workflowExperiences)
        .where(eq(schema.workflowExperiences.revisionId, revision.id)).get();
      const hasRepair = this.db.select({ id: schema.workflowRepairAttempts.id }).from(schema.workflowRepairAttempts)
        .where(eq(schema.workflowRepairAttempts.candidateRevisionId, revision.id)).get();
      if (hasRun || hasExperience || hasRepair) continue;
      this.db.transaction(() => {
        this.db.update(schema.workflowGraphRevisions)
          .set({ parentRevisionId: revision.parentRevisionId })
          .where(eq(schema.workflowGraphRevisions.parentRevisionId, revision.id))
          .run();
        this.db.delete(schema.workflowGraphRevisions)
          .where(eq(schema.workflowGraphRevisions.id, revision.id))
          .run();
      });
    }
  }

  recordProof(input: RecordProofInput) {
    const revision = this.requireRevision(input.workspaceId, input.workflowId, input.revisionId);
    if (revision.semanticHash !== this.currentHash(revision)) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'Proof does not match the immutable candidate graph');
    }
    const fixtureKey = input.fixtureKey ?? 'default';
    const now = new Date().toISOString();
    const existing = this.db.select({ id: schema.workflowRevisionProofs.id })
      .from(schema.workflowRevisionProofs)
      .where(and(
        eq(schema.workflowRevisionProofs.revisionId, input.revisionId),
        eq(schema.workflowRevisionProofs.gate, input.gate),
        eq(schema.workflowRevisionProofs.fixtureKey, fixtureKey),
      )).get();
    if (existing) {
      this.db.update(schema.workflowRevisionProofs).set({
        status: input.status,
        semanticHash: revision.semanticHash,
        runId: input.runId ?? null,
        capabilityCatalogVersion: input.capabilityCatalogVersion ?? null,
        evidenceJson: input.evidence ?? {},
        updatedAt: now,
      }).where(eq(schema.workflowRevisionProofs.id, existing.id)).run();
    } else {
      this.db.insert(schema.workflowRevisionProofs).values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        workflowId: input.workflowId,
        revisionId: input.revisionId,
        gate: input.gate,
        status: input.status,
        semanticHash: revision.semanticHash,
        fixtureKey,
        runId: input.runId ?? null,
        capabilityCatalogVersion: input.capabilityCatalogVersion ?? null,
        evidenceJson: input.evidence ?? {},
        createdAt: now,
        updatedAt: now,
      }).run();
    }
    return this.proofState(input.workspaceId, input.workflowId, input.revisionId);
  }

  proofState(workspaceId: string, workflowId: string, revisionId: string) {
    const revision = this.requireRevision(workspaceId, workflowId, revisionId);
    const proofs = this.db.select().from(schema.workflowRevisionProofs)
      .where(eq(schema.workflowRevisionProofs.revisionId, revisionId))
      .all()
      .filter((proof) => proof.semanticHash === revision.semanticHash);
    const gates = new Map<string, typeof proofs>();
    for (const proof of proofs) {
      gates.set(proof.gate, [...(gates.get(proof.gate) ?? []), proof]);
    }
    const passed = new Set(
      [...gates.entries()]
        .filter(([, gateProofs]) => gateProofs.length > 0 && gateProofs.every((proof) => proof.status === 'passed'))
        .map(([gate]) => gate),
    );
    const required = requiredGates(revision.proofProfile);
    const missing = required.filter((gate) => !passed.has(gate));
    const failed = proofs.filter((proof) => proof.status === 'failed').map((proof) => proof.gate);
    const approvalRequired = revision.proofProfile === 'outward';
    const workflow = this.workflow(workspaceId, workflowId);
    const specMatchesCurrent = stableStringify(revision.specJson)
      === stableStringify(readWorkflowSpec(workflow.settings));
    return {
      revisionId,
      semanticHash: revision.semanticHash,
      required,
      passed: [...passed],
      missing,
      failed,
      approvalRequired,
      specMatchesCurrent,
      readyForPromotion: missing.length === 0 && specMatchesCurrent,
      proofs,
    };
  }

  /**
   * Promote an independently proven workflow revision. App membership is an
   * ownership/grouping boundary, not a release train: an unrelated sibling's
   * channel or trigger health must never block this candidate's publication.
   */
  promote(input: PromoteWorkflowRevisionInput): PromotionResult {
    return this.promoteWithAuthority(input, null);
  }

  /** Stronger App-delivery path when a caller is releasing the whole App. */
  promoteFromAppDelivery(input: PromoteWorkflowRevisionInput & { deliveryRunId: string }): PromotionResult {
    const run = this.db.select({
      status: schema.workflowRuns.status,
      workflowRevisionId: schema.workflowRuns.workflowRevisionId,
      runState: schema.workflowRuns.runState,
    }).from(schema.workflowRuns).where(and(
      eq(schema.workflowRuns.id, input.deliveryRunId),
      eq(schema.workflowRuns.workspaceId, input.workspaceId),
      eq(schema.workflowRuns.workflowId, input.workflowId),
    )).get();
    const verdict = (run?.runState as WorkflowRunState & { verdict?: { outcome?: string } } | null)?.verdict;
    if (!run
      || run.status !== 'COMPLETED'
      || run.workflowRevisionId !== input.revisionId
      || verdict?.outcome !== 'accomplished') {
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        'App publication requires an accomplished, clean delivery run of the exact candidate revision.',
        { httpStatus: 409, details: { code: 'APP_DELIVERY_PROOF_REQUIRED', deliveryRunId: input.deliveryRunId } },
      );
    }
    const deliveryProofs = this.db.select().from(schema.workflowRevisionProofs).where(and(
      eq(schema.workflowRevisionProofs.revisionId, input.revisionId),
      eq(schema.workflowRevisionProofs.runId, input.deliveryRunId),
    )).all();
    const delivered = (gate: 'clean_debug' | 'outcome') => deliveryProofs.some((proof) => {
      const evidence = proof.evidenceJson && typeof proof.evidenceJson === 'object'
        ? proof.evidenceJson as Record<string, unknown>
        : {};
      return proof.gate === gate && proof.status === 'passed' && evidence.delivery === true;
    });
    if (!delivered('clean_debug') || !delivered('outcome')) {
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        'App publication requires delivery-bound clean_debug and outcome proofs.',
        { httpStatus: 409, details: { code: 'APP_DELIVERY_GATE_REQUIRED', deliveryRunId: input.deliveryRunId } },
      );
    }
    return this.promoteWithAuthority(input, { kind: 'app_delivery', runId: input.deliveryRunId });
  }

  private promoteWithAuthority(
    input: PromoteWorkflowRevisionInput,
    _authority: { kind: 'app_delivery'; runId: string } | null,
  ): PromotionResult {
    const revision = this.requireRevision(input.workspaceId, input.workflowId, input.revisionId);
    if (input.operatorApproval) {
      this.recordProof({
        workspaceId: input.workspaceId,
        workflowId: input.workflowId,
        revisionId: input.revisionId,
        gate: 'operator_approval',
        status: 'passed',
        evidence: { actor: input.actor, approvedAt: new Date().toISOString() },
      });
    }
    const proof = this.proofState(input.workspaceId, input.workflowId, input.revisionId);
    if (!proof.specMatchesCurrent) {
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        'The workflow acceptance spec changed after this revision was created. Create and verify a candidate containing the current spec.',
        {
          httpStatus: 409,
          details: { code: 'WORKFLOW_REVISION_SPEC_DRIFT', proof },
        },
      );
    }
    const overriddenGates = proof.missing as WorkflowProofGate[];
    const override = Boolean(input.overrideReason?.trim());
    if (overriddenGates.length > 0 && !override) {
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        `Candidate is not proven. Missing gates: ${overriddenGates.join(', ')}`,
        {
          httpStatus: 409,
          details: { code: 'WORKFLOW_REVISION_UNPROVEN', proof },
        },
      );
    }
    if (revision.proofProfile === 'outward' && !input.operatorApproval && !override) {
      throw new AgentisError(
        'AUTH_FORBIDDEN',
        'This candidate can send data externally or run code and requires operator approval.',
        { details: { code: 'WORKFLOW_REVISION_APPROVAL_REQUIRED' } },
      );
    }
    if (override && input.actor.type !== 'user') {
      throw new AgentisError('AUTH_FORBIDDEN', 'Only an operator may use break-glass activation');
    }

    const now = new Date().toISOString();
    const trustState = override ? 'break_glass' as const : 'proven' as const;
    this.db.transaction(() => {
      const workflow = this.workflow(input.workspaceId, input.workflowId);
      if (workflow.activeRevisionId !== input.expectedActiveRevisionId) {
        throw new AgentisError(
          'WORKFLOW_GRAPH_INVALID',
          'The active workflow changed while this candidate was being verified.',
          {
            httpStatus: 409,
            details: {
              code: 'WORKFLOW_PROMOTION_CONFLICT',
              expectedActiveRevisionId: input.expectedActiveRevisionId,
              actualActiveRevisionId: workflow.activeRevisionId,
            },
          },
        );
      }
      if (workflow.activeRevisionId) {
        this.db.update(schema.workflowGraphRevisions).set({
          status: 'superseded',
          updatedAt: now,
        }).where(eq(schema.workflowGraphRevisions.id, workflow.activeRevisionId)).run();
      }
      this.db.update(schema.workflowGraphRevisions).set({
        status: 'active',
        trustState,
        verifiedAt: override ? revision.verifiedAt : revision.verifiedAt ?? now,
        promotedAt: now,
        updatedAt: now,
      }).where(eq(schema.workflowGraphRevisions.id, input.revisionId)).run();
      this.db.update(schema.workflows).set({
        graph: revision.graphJson,
        contentHash: revision.semanticHash,
        activeRevisionId: input.revisionId,
        candidateRevisionId: null,
        trustState,
        updatedAt: now,
      }).where(and(
        eq(schema.workflows.id, input.workflowId),
        eq(schema.workflows.workspaceId, input.workspaceId),
      )).run();
      if (override) {
        this.db.insert(schema.workflowRevisionProofs).values({
          id: randomUUID(),
          workspaceId: input.workspaceId,
          workflowId: input.workflowId,
          revisionId: input.revisionId,
          gate: 'operator_approval',
          status: 'passed',
          semanticHash: revision.semanticHash,
          fixtureKey: 'break_glass',
          evidenceJson: {
            override: true,
            reason: input.overrideReason!.trim(),
            actor: input.actor,
            overriddenGates,
          },
          createdAt: now,
          updatedAt: now,
        }).run();
      }
    });
    return {
      revisionId: input.revisionId,
      activeRevisionId: input.revisionId,
      trustState,
      overriddenGates,
    };
  }

  abandon(input: {
    workspaceId: string;
    workflowId: string;
    revisionId: string;
    actor: WorkflowRevisionActor;
    reason: string;
  }) {
    const workflow = this.workflow(input.workspaceId, input.workflowId);
    const revision = this.requireRevision(input.workspaceId, input.workflowId, input.revisionId);
    if (revision.status === 'active') {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'The active revision cannot be abandoned');
    }
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.update(schema.workflowGraphRevisions).set({
        status: 'rejected',
        trustState: 'rejected',
        reason: `${revision.reason}\nAbandoned: ${input.reason}`.trim(),
        rejectedAt: now,
        updatedAt: now,
      }).where(eq(schema.workflowGraphRevisions.id, input.revisionId)).run();
      if (workflow.candidateRevisionId === input.revisionId) {
        this.db.update(schema.workflows).set({
          candidateRevisionId: null,
          trustState: workflow.activeRevisionId ? workflow.trustState : 'legacy_unverified',
          updatedAt: now,
        }).where(eq(schema.workflows.id, input.workflowId)).run();
      }
    });
  }

  revisions(workspaceId: string, workflowId: string) {
    this.ensureWorkflow(workspaceId, workflowId);
    return this.db.select().from(schema.workflowGraphRevisions)
      .where(and(
        eq(schema.workflowGraphRevisions.workspaceId, workspaceId),
        eq(schema.workflowGraphRevisions.workflowId, workflowId),
      ))
      .orderBy(desc(schema.workflowGraphRevisions.createdAt))
      .all();
  }

  revision(workspaceId: string, workflowId: string, revisionId: string) {
    return this.db.select().from(schema.workflowGraphRevisions).where(and(
      eq(schema.workflowGraphRevisions.id, revisionId),
      eq(schema.workflowGraphRevisions.workflowId, workflowId),
      eq(schema.workflowGraphRevisions.workspaceId, workspaceId),
    )).get();
  }

  active(workspaceId: string, workflowId: string) {
    const { workflow, active } = this.ensureWorkflow(workspaceId, workflowId);
    return { workflow, revision: active, graph: active.graphJson as WorkflowGraph };
  }

  candidate(workspaceId: string, workflowId: string) {
    const workflow = this.workflow(workspaceId, workflowId);
    if (!workflow.candidateRevisionId) return null;
    const revision = this.requireRevision(workspaceId, workflowId, workflow.candidateRevisionId);
    return { workflow, revision, graph: revision.graphJson as WorkflowGraph };
  }

  /**
   * Upgrade legacy current-graph revisions to the latest known accomplished
   * snapshot. A divergent current graph is retained as a candidate.
   */
  reconcileLegacyWorkflow(workspaceId: string, workflowId: string) {
    const { workflow, active } = this.ensureWorkflow(workspaceId, workflowId);
    if (workflow.trustState !== 'legacy_unverified') return { changed: false, activeRevisionId: active.id };
    const runs = this.db.select({
      id: schema.workflowRuns.id,
      status: schema.workflowRuns.status,
      runState: schema.workflowRuns.runState,
      graphSnapshot: schema.workflowRuns.graphSnapshot,
      createdAt: schema.workflowRuns.createdAt,
    }).from(schema.workflowRuns).where(and(
      eq(schema.workflowRuns.workspaceId, workspaceId),
      eq(schema.workflowRuns.workflowId, workflowId),
    )).orderBy(desc(schema.workflowRuns.createdAt)).all();
    const accomplished = runs.find((run) => {
      const verdict = (run.runState as WorkflowRunState & { verdict?: { outcome?: string } }).verdict;
      return Boolean(run.graphSnapshot)
        && run.status === 'COMPLETED'
        && verdict?.outcome === 'accomplished';
    });
    if (!accomplished?.graphSnapshot) return { changed: false, activeRevisionId: active.id };
    // App production bytes are governed exclusively by app.deliver. Legacy
    // reconciliation may classify their evidence, but it must never replace an
    // App-owned active graph behind the delivery gate.
    if (workflow.appId) {
      return { changed: false, activeRevisionId: active.id, appDeliveryRequired: true as const };
    }
    const provenGraph = accomplished.graphSnapshot as WorkflowGraph;
    const provenHash = hashWorkflowGraph(provenGraph);
    if (provenHash === this.currentHash(active)) {
      const now = new Date().toISOString();
      this.db.transaction(() => {
        this.db.update(schema.workflowGraphRevisions).set({
          semanticHash: provenHash,
          presentationHash: presentationHash(provenGraph),
          trustState: 'proven',
          proofProfile: 'legacy_proven',
          verifiedAt: now,
          updatedAt: now,
        }).where(eq(schema.workflowGraphRevisions.id, active.id)).run();
        this.db.update(schema.workflows).set({
          trustState: 'proven',
          updatedAt: now,
        }).where(eq(schema.workflows.id, workflowId)).run();
      });
      return { changed: true, activeRevisionId: active.id };
    }

    const divergentCurrentGraph = workflow.graph as WorkflowGraph;
    const provenId = randomUUID();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.insert(schema.workflowGraphRevisions).values({
        id: provenId,
        workspaceId,
        workflowId,
        parentRevisionId: active.parentRevisionId,
        graphJson: provenGraph,
        semanticHash: provenHash,
        presentationHash: presentationHash(provenGraph),
        source: 'migration',
        actorType: 'system',
        reason: `Recovered from accomplished run ${accomplished.id}`,
        changeSummaryJson: diffWorkflowGraphs(active.graphJson as WorkflowGraph, provenGraph),
        specJson: readWorkflowSpec(workflow.settings),
        capabilityManifestJson: summarizeGraphCapabilities(provenGraph),
        proofProfile: 'legacy_proven',
        status: 'active',
        trustState: 'proven',
        verifiedAt: now,
        promotedAt: now,
        createdAt: accomplished.createdAt,
        updatedAt: now,
      }).run();
      this.db.update(schema.workflowGraphRevisions).set({
        status: 'superseded',
        updatedAt: now,
      }).where(eq(schema.workflowGraphRevisions.id, active.id)).run();
      this.db.update(schema.workflows).set({
        graph: provenGraph,
        contentHash: provenHash,
        activeRevisionId: provenId,
        candidateRevisionId: null,
        trustState: 'proven',
        updatedAt: now,
      }).where(eq(schema.workflows.id, workflowId)).run();
      this.db.update(schema.workflowRuns).set({
        workflowRevisionId: provenId,
      }).where(eq(schema.workflowRuns.id, accomplished.id)).run();
    });
    const candidate = this.createCandidate({
      workspaceId,
      workflowId,
      graph: divergentCurrentGraph,
      baseRevisionId: provenId,
      source: 'migration',
      actor: { type: 'system' },
      reason: 'Current graph diverged from the latest accomplished historical graph',
    }).revision;
    return { changed: true, activeRevisionId: provenId, candidateRevisionId: candidate.id };
  }

  private requireRevision(workspaceId: string, workflowId: string, revisionId: string) {
    const revision = this.revision(workspaceId, workflowId, revisionId);
    if (!revision) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workflow revision not found');
    return revision;
  }

  private workflow(workspaceId: string, workflowId: string) {
    const workflow = this.db.select().from(schema.workflows).where(and(
      eq(schema.workflows.id, workflowId),
      eq(schema.workflows.workspaceId, workspaceId),
    )).get();
    if (!workflow) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workflow not found');
    return workflow;
  }

  private currentHash(revision: typeof schema.workflowGraphRevisions.$inferSelect) {
    return hashWorkflowGraph(revision.graphJson as WorkflowGraph);
  }
}

function requiredGates(profile: string): readonly WorkflowProofGate[] {
  if (profile === 'presentation' || profile === 'legacy' || profile === 'legacy_proven') return [];
  return profile === 'outward' ? [...STANDARD_GATES, 'operator_approval'] : STANDARD_GATES;
}

function presentationHash(graph: WorkflowGraph): string {
  return createHash('sha256').update(stableStringify(graph)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
