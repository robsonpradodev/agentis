/**
 * Approval inbox.
 *
 * Sources (V1-SPEC §11.10): checkpoint nodes, OpenClaw exec proposals,
 * package install requests, credential access prompts. The dashboard subscribes
 * to `approval.requested` / `approval.resolved` and shows an inbox row per
 * pending item.
 *
 * Resolution callback hook: when a checkpoint approval is approved, we call
 * back into the engine via the supplied `onCheckpointResolved` so the run
 * resumes deterministically.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';

type ApprovalRow = typeof schema.approvalRequests.$inferSelect;

export type PresentedApproval = ApprovalRow & {
  payload: Record<string, unknown>;
  workflowId: string | null;
  workflowName: string | null;
  agentName: string | null;
  nodeTitle: string | null;
  nodeType: string | null;
};

export interface ApprovalCreateArgs {
  workspaceId: string;
  ambientId: string | null;
  userId: string;
  runId: string | null;
  taskId: string | null;
  targetId?: string | null;
  gatewayId: string | null;
  source: 'checkpoint' | 'phase_gate' | 'self_heal' | 'openclaw_exec' | 'package_install' | 'credential_access' | 'budget_limit' | 'outbound' | 'workflow_revision' | 'agent_consultation';
  title: string;
  summary: string;
  confidence: number | null;
  payload?: Record<string, unknown> | null;
}

/**
 * Invoked when a run-resuming approval (`checkpoint` or `phase_gate`) is resolved.
 * `targetId` carries the gated entity id — the checkpoint node id, or the phase id.
 */
export type CheckpointResumeHandler = (args: {
  runId: string;
  approvalId: string;
  source: string;
  targetId: string | null;
  decision: 'approve' | 'reject' | 'revise';
  /** Submitted form values for a `human_input` node (becomes the node output). */
  data?: Record<string, unknown>;
  /**
   * Operator's free-text instruction for a `revise` decision — delivered to the
   * waiting agent (orchestrator/manager) so it can adjust course WITHOUT the run
   * being torn down. Ignored for approve/reject.
   */
  feedback?: string;
}) => Promise<void>;

/**
 * Invoked when an `outbound` approval (an App's held outbound message — G7) is
 * resolved. On approve the held message is delivered; on reject it is dropped.
 * The payload carries the App/conversation/channel context needed to deliver.
 */
export type OutboundApprovalHandler = (args: {
  approvalId: string;
  decision: 'approve' | 'reject';
  payload: Record<string, unknown>;
}) => Promise<void>;

export type WorkflowRevisionApprovalHandler = (args: {
  approvalId: string;
  decision: 'approve' | 'reject';
  payload: Record<string, unknown>;
  resolvedByUserId: string | null;
}) => Promise<void>;

export type AgentConsultationApprovalHandler = (args: {
  approvalId: string;
  workspaceId: string;
  userId: string;
  decision: 'approve' | 'reject';
  payload: Record<string, unknown>;
}) => Promise<void>;

export class ApprovalInboxService {
  #onCheckpointResolved: CheckpointResumeHandler | null = null;
  #onOutboundResolved: OutboundApprovalHandler | null = null;
  #onWorkflowRevisionResolved: WorkflowRevisionApprovalHandler | null = null;
  #onAgentConsultationResolved: AgentConsultationApprovalHandler | null = null;

  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly bus: EventBus,
  ) {}

  bindCheckpointHandler(handler: CheckpointResumeHandler): void {
    this.#onCheckpointResolved = handler;
  }

  /** Bind the deliver-on-approve hook for App outbound approvals (G7). */
  bindOutboundHandler(handler: OutboundApprovalHandler): void {
    this.#onOutboundResolved = handler;
  }

  bindWorkflowRevisionHandler(handler: WorkflowRevisionApprovalHandler): void {
    this.#onWorkflowRevisionResolved = handler;
  }

  bindAgentConsultationHandler(handler: AgentConsultationApprovalHandler): void {
    this.#onAgentConsultationResolved = handler;
  }

  async create(args: ApprovalCreateArgs) {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .insert(schema.approvalRequests)
      .values({
        id,
        workspaceId: args.workspaceId,
        ambientId: args.ambientId,
        userId: args.userId,
        runId: args.runId,
        taskId: args.taskId,
        targetId: args.targetId ?? null,
        gatewayId: args.gatewayId,
        source: args.source,
        title: args.title,
        summary: args.summary,
        confidence: args.confidence,
        payload: args.payload ?? {},
        status: 'pending',
        createdAt,
      })
      .run();
    this.bus.publish(REALTIME_ROOMS.workspace(args.workspaceId), REALTIME_EVENTS.APPROVAL_REQUESTED, {
      id,
      ...args,
      status: 'pending',
      createdAt,
    });
    return { id, ...args, status: 'pending' as const, createdAt };
  }

  list(workspaceId: string, status: 'pending' | 'all' = 'pending'): PresentedApproval[] {
    this.#expireNonActionableApprovals(workspaceId);
    const rows = this.db
      .select()
      .from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.workspaceId, workspaceId))
      .all();
    
    const filteredRows = status === 'all' ? rows : rows.filter((r) => r.status === 'pending');
    
    return filteredRows.map((row) => this.#present(row));
  }

  get(workspaceId: string, approvalId: string): PresentedApproval | null {
    this.#expireNonActionableApprovals(workspaceId);
    const row = this.db
      .select()
      .from(schema.approvalRequests)
      .where(and(eq(schema.approvalRequests.id, approvalId), eq(schema.approvalRequests.workspaceId, workspaceId)))
      .get();
    return row ? this.#present(row) : null;
  }

  countActionable(workspaceId: string): number {
    return this.list(workspaceId, 'pending').length;
  }

  /**
   * An approval is only useful while the resource it authorizes is still the
   * current decision point. Most approvals are attached to a run, but revision
   * promotion approvals deliberately are not: their delivery run may finish
   * while the operator decides. Reconcile both kinds before every inbox read
   * so an abandoned/superseded candidate can never remain actionable.
   */
  #expireNonActionableApprovals(workspaceId: string): void {
    this.#expireTerminalRunApprovals(workspaceId);
    this.#expireStaleWorkflowRevisionApprovals(workspaceId);
  }

  #expireTerminalRunApprovals(workspaceId: string): void {
    const pending = this.db.select().from(schema.approvalRequests).where(and(
      eq(schema.approvalRequests.workspaceId, workspaceId),
      eq(schema.approvalRequests.status, 'pending'),
    )).all();
    const runIds = [...new Set(pending.map((row) => row.runId).filter((id): id is string => Boolean(id)))];
    if (runIds.length === 0) return;
    const runs = this.db.select({ id: schema.workflowRuns.id, status: schema.workflowRuns.status })
      .from(schema.workflowRuns).where(inArray(schema.workflowRuns.id, runIds)).all();
    const statusByRun = new Map(runs.map((run) => [run.id, run.status]));
    const expiredAt = new Date().toISOString();
    for (const approval of pending) {
      const runStatus = approval.runId ? statusByRun.get(approval.runId) : undefined;
      if (isActionableApproval(approval, runStatus)) continue;
      this.db.update(schema.approvalRequests).set({
        status: 'expired',
        resolvedAt: expiredAt,
        resolutionReason: `Run ended with status ${runStatus}.`,
      }).where(eq(schema.approvalRequests.id, approval.id)).run();
      this.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.APPROVAL_RESOLVED, {
        id: approval.id,
        status: 'expired',
        resolvedAt: expiredAt,
      });
    }
  }

  #expireStaleWorkflowRevisionApprovals(workspaceId: string): void {
    const pending = this.db.select().from(schema.approvalRequests).where(and(
      eq(schema.approvalRequests.workspaceId, workspaceId),
      eq(schema.approvalRequests.status, 'pending'),
      eq(schema.approvalRequests.source, 'workflow_revision'),
    )).all();

    for (const approval of pending) {
      const payload = asRecord(approval.payload);
      const payloadWorkspaceId = stringValue(payload.workspaceId);
      const workflowId = stringValue(payload.workflowId);
      const revisionId = stringValue(payload.revisionId);
      const semanticHash = stringValue(payload.semanticHash);
      const expectedActiveRevisionId = stringValue(payload.expectedActiveRevisionId);
      const workflow = workflowId
        ? this.db.select({
          activeRevisionId: schema.workflows.activeRevisionId,
          candidateRevisionId: schema.workflows.candidateRevisionId,
        }).from(schema.workflows).where(and(
          eq(schema.workflows.id, workflowId),
          eq(schema.workflows.workspaceId, workspaceId),
        )).get()
        : null;
      const revision = workflow && workflowId && revisionId
        ? this.db.select({ status: schema.workflowGraphRevisions.status, semanticHash: schema.workflowGraphRevisions.semanticHash })
          .from(schema.workflowGraphRevisions).where(and(
            eq(schema.workflowGraphRevisions.id, revisionId),
            eq(schema.workflowGraphRevisions.workflowId, workflowId),
            eq(schema.workflowGraphRevisions.workspaceId, workspaceId),
          )).get()
        : null;

      const reason = !payloadWorkspaceId || payloadWorkspaceId !== workspaceId || !workflowId || !revisionId || !semanticHash || !expectedActiveRevisionId
        ? 'Workflow revision approval payload is incomplete.'
        : !workflow
          ? 'Workflow no longer exists.'
          : !revision
            ? 'Workflow revision no longer exists.'
            : workflow.candidateRevisionId !== revisionId
              ? 'Workflow revision is no longer the current candidate.'
              : workflow.activeRevisionId !== expectedActiveRevisionId
                ? 'The workflow active revision changed before approval.'
                : revision.status !== 'candidate'
                  ? `Workflow revision is no longer a candidate (status ${revision.status}).`
                  : revision.semanticHash !== semanticHash
                    ? 'Workflow revision no longer matches the reviewed hash.'
                    : null;
      if (reason) this.#expireApproval(approval, reason);
    }
  }

  #expireApproval(approval: ApprovalRow, resolutionReason: string): void {
    const resolvedAt = new Date().toISOString();
    this.db.update(schema.approvalRequests).set({
      status: 'expired',
      resolvedAt,
      resolutionReason,
    }).where(eq(schema.approvalRequests.id, approval.id)).run();
    this.bus.publish(REALTIME_ROOMS.workspace(approval.workspaceId), REALTIME_EVENTS.APPROVAL_RESOLVED, {
      id: approval.id,
      status: 'expired',
      resolvedAt,
    });
  }

  async resolve(args: {
    workspaceId: string;
    approvalId: string;
    decision: 'approve' | 'reject' | 'revise';
    reason?: string;
    /** Submitted form values for a `human_input` node. */
    data?: Record<string, unknown>;
    /** Operator instruction for a `revise` decision (see CheckpointResumeHandler). */
    feedback?: string;
    resolvedByUserId?: string | null;
  }) {
    // The operator may have opened a review just before a workflow candidate
    // was discarded. Reconcile again at the write boundary, not only on list,
    // so that click turns into a clean expired state instead of a handler error.
    this.#expireNonActionableApprovals(args.workspaceId);
    const row = this.db
      .select()
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.id, args.approvalId),
          eq(schema.approvalRequests.workspaceId, args.workspaceId),
        ),
      )
      .get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', 'Approval not found');
    if (row.status !== 'pending') {
      throw new AgentisError('RESOURCE_CONFLICT', `Approval already ${row.status}`);
    }
    if (row.source === 'workflow_revision' && args.decision === 'approve') {
      const operator = args.resolvedByUserId
        ? this.db.select({ isAdmin: schema.users.isAdmin }).from(schema.users)
            .where(eq(schema.users.id, args.resolvedByUserId)).get()
        : null;
      if (!operator?.isAdmin) {
        throw new AgentisError('AUTH_FORBIDDEN', 'Workflow revision activation requires an administrator.');
      }
    }
    const workflowRevisionHandled = row.source === 'workflow_revision'
      && Boolean(this.#onWorkflowRevisionResolved)
      && args.decision !== 'revise';
    if (workflowRevisionHandled) {
      await this.#onWorkflowRevisionResolved!({
        approvalId: row.id,
        decision: args.decision as 'approve' | 'reject',
        payload: (row.payload ?? {}) as Record<string, unknown>,
        resolvedByUserId: args.resolvedByUserId ?? null,
      });
    }
    // `revise` is a non-destructive third decision: the operator sends a new
    // instruction back to the waiting agent instead of approving or cancelling
    // (which would tear down the run). The original request is retired as
    // `revised`; the agent decides what to do next and may re-request approval.
    const next = args.decision === 'approve' ? 'approved' : args.decision === 'revise' ? 'revised' : 'rejected';
    // The instruction rides in `feedback` for revise, or `reason` for approve/reject.
    const resolutionReason = args.decision === 'revise' ? (args.feedback ?? args.reason ?? null) : (args.reason ?? null);
    const resolvedAt = new Date().toISOString();
    this.db
      .update(schema.approvalRequests)
      .set({
        status: next,
        resolutionReason,
        resolvedAt,
      })
      .where(eq(schema.approvalRequests.id, row.id))
      .run();
    this.bus.publish(REALTIME_ROOMS.workspace(row.workspaceId), REALTIME_EVENTS.APPROVAL_RESOLVED, {
      id: row.id,
      status: next,
      resolvedAt,
    });
    if (row.runId && isRunResumingApproval(row.source) && this.#onCheckpointResolved) {
      await this.#onCheckpointResolved({
        runId: row.runId,
        approvalId: row.id,
        source: row.source,
        targetId: row.targetId ?? row.taskId ?? null,
        decision: args.decision,
        ...(args.data ? { data: args.data } : {}),
        ...(args.decision === 'revise' && resolutionReason ? { feedback: resolutionReason } : {}),
      });
    } else if (row.source === 'outbound' && this.#onOutboundResolved && args.decision !== 'revise') {
      // App outbound approval (G7): deliver the held message on approve, drop on reject.
      // `revise` has no meaning for a held one-shot outbound message, so it is a no-op here.
      await this.#onOutboundResolved({
        approvalId: row.id,
        decision: args.decision,
        payload: (row.payload ?? {}) as Record<string, unknown>,
      });
    } else if (row.source === 'agent_consultation' && this.#onAgentConsultationResolved && args.decision !== 'revise') {
      await this.#onAgentConsultationResolved({
        approvalId: row.id,
        workspaceId: row.workspaceId,
        userId: row.userId,
        decision: args.decision,
        payload: (row.payload ?? {}) as Record<string, unknown>,
      });
    }
    return { ...row, status: next, resolvedAt, resolutionReason };
  }

  #present(row: ApprovalRow): PresentedApproval {
    const context = this.#approvalContext(row);
    return {
      ...row,
      payload: redactForApprovalReview(asRecord(row.payload)) as Record<string, unknown>,
      workflowId: context.workflowId,
      workflowName: context.workflowName,
      agentName: context.agentName,
      nodeTitle: context.nodeTitle,
      nodeType: context.nodeType,
    };
  }

  #approvalContext(row: ApprovalRow): {
    workflowId: string | null;
    workflowName: string | null;
    agentName: string | null;
    nodeTitle: string | null;
    nodeType: string | null;
  } {
    let workflowId: string | null = null;
    let workflowName: string | null = null;
    let graph: unknown = null;
    let taskNodeId: string | null = null;
    let taskExecutorRef: string | null = null;
    let taskExecutorType: string | null = null;

    if (row.runId) {
      const run = this.db
        .select({
          workflowId: schema.workflowRuns.workflowId,
          graphSnapshot: schema.workflowRuns.graphSnapshot,
        })
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.id, row.runId))
        .get();
      workflowId = run?.workflowId ?? null;
      graph = run?.graphSnapshot ?? null;
    }

    if (row.taskId) {
      const task = this.db
        .select({
          workflowId: schema.tasks.workflowId,
          nodeId: schema.tasks.nodeId,
          executorType: schema.tasks.executorType,
          executorRef: schema.tasks.executorRef,
          title: schema.tasks.title,
        })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, row.taskId))
        .get();
      workflowId = workflowId ?? task?.workflowId ?? null;
      taskNodeId = task?.nodeId ?? null;
      taskExecutorRef = task?.executorRef ?? null;
      taskExecutorType = task?.executorType ?? null;
    }

    if (workflowId) {
      const workflow = this.db
        .select({ title: schema.workflows.title, graph: schema.workflows.graph, ownerAgentId: schema.workflows.ownerAgentId })
        .from(schema.workflows)
        .where(eq(schema.workflows.id, workflowId))
        .get();
      workflowName = workflow?.title ?? null;
      graph = graph ?? workflow?.graph ?? null;
      if (!taskExecutorRef && workflow?.ownerAgentId) {
        taskExecutorType = 'agent';
        taskExecutorRef = workflow.ownerAgentId;
      }
    }

    const nodeId = row.targetId ?? taskNodeId;
    const node = nodeId ? findWorkflowGraphNode(graph, nodeId) : null;
    const agentId = taskExecutorType === 'agent'
      ? taskExecutorRef
      : node ? agentRefFromNode(node) : null;
    const agent = agentId
      ? this.db
        .select({ name: schema.agents.name })
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId))
        .get()
      : null;

    return {
      workflowId,
      workflowName,
      agentName: agent?.name ?? null,
      nodeTitle: node ? String((node as Record<string, unknown>).title ?? nodeId) : null,
      nodeType: node ? String((node as Record<string, unknown>).type ?? ((node as Record<string, unknown>).config as { kind?: unknown } | undefined)?.kind ?? '') || null : null,
    };
  }
}

const ACTIVE_APPROVAL_RUN_STATUSES = new Set(['CREATED', 'PLANNING', 'RUNNING', 'WAITING', 'PAUSED']);

/** One predicate used by inboxes, badges, Home, and notification derivation. */
export function isActionableApproval(
  approval: Pick<ApprovalRow, 'status' | 'runId'>,
  runStatus?: string,
): boolean {
  if (approval.status !== 'pending') return false;
  if (!approval.runId || runStatus === undefined) return true;
  return ACTIVE_APPROVAL_RUN_STATUSES.has(runStatus);
}

function isRunResumingApproval(source: string): boolean {
  return source === 'checkpoint' || source === 'phase_gate' || source === 'self_heal';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function findWorkflowGraphNode(graph: unknown, nodeId: string): Record<string, unknown> | null {
  const nodes = graph && typeof graph === 'object' ? (graph as { nodes?: unknown }).nodes : undefined;
  if (!Array.isArray(nodes)) return null;
  return (nodes.find((node) => (
    node && typeof node === 'object' && String((node as { id?: unknown }).id ?? '') === nodeId
  )) as Record<string, unknown> | undefined) ?? null;
}

function agentRefFromNode(node: Record<string, unknown>): string | null {
  const config = node.config && typeof node.config === 'object' ? node.config as Record<string, unknown> : {};
  const candidate = config.agentId ?? config.agent_id ?? config.assigneeAgentId ?? config.executorRef;
  return typeof candidate === 'string' && candidate.trim() ? candidate : null;
}

const SECRET_KEY = /(password|secret|token|api[-_ ]?key|service[-_ ]?role|credential|authorization|bearer|private[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret)/i;

function redactForApprovalReview(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[Truncated]';
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactForApprovalReview(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? '[Redacted]' : redactForApprovalReview(nested, depth + 1);
  }
  return out;
}
