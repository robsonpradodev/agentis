import type { DurableSuspension } from '@agentis/core';
import type { ApprovalInboxService, DurableSuspensionApprovalHandler } from '../approvalInbox.js';
import type { DurableSuspensionService, SuspensionPresenter } from './durableSuspensionService.js';

/**
 * First-party presenter for the generic `human_response` condition.
 *
 * It targets Agentis's existing workspace attention inbox. Other deployments
 * can register a different presenter for this condition (or a new condition)
 * without changing the suspension broker.
 */
export class HumanResponseSuspensionPresenter implements SuspensionPresenter {
  constructor(private readonly deps: {
    approvals: ApprovalInboxService;
    suspensions: DurableSuspensionService;
  }) {
    deps.approvals.bindDurableSuspensionHandler((args) => this.#resolved(args));
  }

  async present(suspension: DurableSuspension): Promise<{ ref: string }> {
    assertSupportedAudience(suspension);
    const prompt = stringValue(suspension.condition.payload.prompt) || suspension.reason;
    const fields = normalizeFields(suspension.condition.payload.fields);
    const userId = suspension.audience.type === 'user'
      ? suspension.audience.target!
      : suspension.requesterUserId!;
    const approval = await this.deps.approvals.create({
      workspaceId: suspension.workspaceId,
      ambientId: null,
      userId,
      runId: null,
      taskId: null,
      targetId: suspension.id,
      gatewayId: null,
      source: 'durable_suspension',
      title: stringValue(suspension.condition.payload.title) || 'Input requested',
      summary: prompt,
      confidence: null,
      payload: {
        suspension: {
          id: suspension.id,
          conditionType: suspension.condition.type,
          audience: suspension.audience,
          originType: suspension.origin.type,
        },
        humanInputForm: { prompt, fields },
      },
    });
    return { ref: approval.id };
  }

  async cancel(suspension: DurableSuspension, reason: string): Promise<void> {
    if (suspension.presentationRef) {
      this.deps.approvals.cancelPending(suspension.workspaceId, suspension.presentationRef, reason);
    }
  }

  async #resolved(args: Parameters<DurableSuspensionApprovalHandler>[0]): Promise<void> {
    const suspensionId = stringValue(record(args.payload.suspension)?.id);
    if (!suspensionId) throw new Error('suspension approval payload is missing its suspension id');
    await this.deps.suspensions.resolve({
      workspaceId: args.workspaceId,
      suspensionId,
      resolution: {
        kind: args.decision === 'approve' ? 'human_response' : 'declined',
        data: args.decision === 'approve' ? (args.data ?? {}) : { reason: args.reason ?? 'declined' },
        principal: { type: 'user', id: args.userId },
      },
    });
  }
}

function assertSupportedAudience(suspension: DurableSuspension): void {
  const audience = suspension.audience;
  const workspaceOperator = audience.type === 'workspace_role' && (audience.target ?? 'operator') === 'operator';
  const exactUser = audience.type === 'user' && Boolean(audience.target);
  if (!workspaceOperator && !exactUser) {
    throw new Error(`Agentis inbox cannot present human_response to audience '${audience.type}:${audience.target ?? ''}'`);
  }
  if (workspaceOperator && !suspension.requesterUserId) throw new Error('workspace operator presentation requires the requesting user');
}

function normalizeFields(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    const fields = value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) as Array<Record<string, unknown>>;
    if (fields.length) return fields.slice(0, 20).map((field, index) => ({
      key: stringValue(field.key) || `field_${index + 1}`,
      label: stringValue(field.label) || stringValue(field.key) || `Field ${index + 1}`,
      type: stringValue(field.type) || 'text',
      required: field.required !== false,
      ...(Array.isArray(field.options) ? { options: field.options } : {}),
    }));
  }
  return [{ key: 'answer', label: 'Your response', type: 'textarea', required: true }];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
