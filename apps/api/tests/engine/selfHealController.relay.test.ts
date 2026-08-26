/**
 * Focused unit test for `relayChatDelta` — the relay that turns an agent's OWN
 * chat activity into what the operator sees during a run. Two behaviours are
 * locked in here:
 *
 *  1. Phase mapping. It used to check `delta.phase === 'error'`, which is only
 *     ever true for a terminal turn-level failure (e.g. no chat adapter); a real
 *     failed TOOL call mid-run (phase:'tool', status:'error') fell through to
 *     'thinking' and was never surfaced as a failure. `status` decides.
 *  2. Run-scoped mirroring. `emitWorkStep` publishes to the WORKSPACE room only,
 *     but the run SSE/socket stream filters strictly on the RUN room — so
 *     activity deltas (which ARE the harness thought stream) never reached the
 *     workflow live modal live, only via the /activity back-fill. Every activity
 *     delta must ALSO go out as run-scoped agent activity.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChatDelta } from '@agentis/core';
import { SelfHealController, isSelfHealControlToolAllowed, type SelfHealHost } from '../../src/engine/selfHeal/selfHealController.js';

function makeController(
  emitWorkStep: ReturnType<typeof vi.fn>,
  notifyAgentActivity: ReturnType<typeof vi.fn> = vi.fn(),
): SelfHealController {
  const host = { emitWorkStep, notifyAgentActivity } as unknown as SelfHealHost;
  return new SelfHealController(host);
}

const ctx = { runId: 'run-1' } as Parameters<SelfHealController['relayChatDelta']>[0];
const node = { id: 'node-1' } as Parameters<SelfHealController['relayChatDelta']>[1];
const clip = (s: string, n: number) => s.slice(0, n);

describe('relayChatDelta — single typed activity projection', () => {
  it('retains a failed tool status without creating a lossy work-step duplicate', () => {
    const emitWorkStep = vi.fn();
    const notifyAgentActivity = vi.fn();
    const controller = makeController(emitWorkStep, notifyAgentActivity);
    const delta: ChatDelta = {
      type: 'activity', id: 'a1', phase: 'tool', status: 'error',
      label: 'Failed agentis.build_workflow', detail: 'schema expects node "kind"',
    };
    controller.relayChatDelta(ctx, node, 'agent-1', delta, clip);
    expect(emitWorkStep).not.toHaveBeenCalled();
    expect(notifyAgentActivity).toHaveBeenCalledWith(expect.objectContaining({
      activityId: 'a1', activityPhase: 'tool', activityStatus: 'error', kind: 'tool_call',
    }));
  });

  it('does not flag a successful tool call as fail', () => {
    const emitWorkStep = vi.fn();
    const controller = makeController(emitWorkStep);
    const delta: ChatDelta = {
      type: 'activity', id: 'a2', phase: 'tool', status: 'success',
      label: 'Used agentis.workflow.patch',
    };
    controller.relayChatDelta(ctx, node, 'agent-1', delta, clip);
    expect(emitWorkStep).not.toHaveBeenCalled();
  });

  it('still flags a terminal turn-level error (phase:error) as fail', () => {
    const emitWorkStep = vi.fn();
    const controller = makeController(emitWorkStep);
    const delta: ChatDelta = {
      type: 'activity', id: 'a3', phase: 'error', status: 'error',
      label: 'Interactive chat unavailable',
    };
    controller.relayChatDelta(ctx, node, 'agent-1', delta, clip);
    expect(emitWorkStep).not.toHaveBeenCalled();
  });

  it('maps a terminal complete phase to complete', () => {
    const emitWorkStep = vi.fn();
    const controller = makeController(emitWorkStep);
    const delta: ChatDelta = {
      type: 'activity', id: 'a4', phase: 'complete', status: 'success',
      label: 'Repair finished',
    };
    controller.relayChatDelta(ctx, node, 'agent-1', delta, clip);
    expect(emitWorkStep).not.toHaveBeenCalled();
  });
});

describe('relayChatDelta — run-scoped reasoning mirror', () => {
  it('mirrors a runtime-phase reasoning activity into run-scoped agent activity', () => {
    const emitWorkStep = vi.fn();
    const notifyAgentActivity = vi.fn();
    const controller = makeController(emitWorkStep, notifyAgentActivity);
    const delta: ChatDelta = {
      type: 'activity', id: 'runtime-progress-claude', phase: 'runtime', status: 'running',
      label: 'Claude Code', detail: 'Checking whether the packager already hashes raw bytes',
    };
    controller.relayChatDelta(ctx, node, 'agent-1', delta, clip);
    expect(notifyAgentActivity).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      agentId: 'agent-1',
      taskId: 'node-1',
      kind: 'thinking',
      text: expect.stringContaining('Checking whether the packager already hashes raw bytes'),
      activityId: 'runtime-progress-claude',
      activityPhase: 'runtime',
      activityStatus: 'running',
    }));
  });

  it('mirrors tool-phase activity too, so the run terminal shows the full stream', () => {
    const emitWorkStep = vi.fn();
    const notifyAgentActivity = vi.fn();
    const controller = makeController(emitWorkStep, notifyAgentActivity);
    const delta: ChatDelta = {
      type: 'activity', id: 'a5', phase: 'tool', status: 'success',
      label: 'Used agentis.workflow.patch',
    };
    controller.relayChatDelta(ctx, node, 'agent-1', delta, clip);
    expect(notifyAgentActivity).toHaveBeenCalledTimes(1);
  });

  it('skips the mirror when the activity carries no text', () => {
    const emitWorkStep = vi.fn();
    const notifyAgentActivity = vi.fn();
    const controller = makeController(emitWorkStep, notifyAgentActivity);
    const delta: ChatDelta = { type: 'activity', id: 'a6', phase: 'runtime', status: 'running' };
    controller.relayChatDelta(ctx, node, 'agent-1', delta, clip);
    expect(notifyAgentActivity).not.toHaveBeenCalled();
  });
});

describe('self-heal tool budget surface', () => {
  it('keeps universal inspection/environment tools but excludes competing run loops', () => {
    expect(isSelfHealControlToolAllowed('agentis.workflow.inspect')).toBe(true);
    expect(isSelfHealControlToolAllowed('agentis.extension.create')).toBe(true);
    expect(isSelfHealControlToolAllowed('agentis.code.execute')).toBe(true);
    expect(isSelfHealControlToolAllowed('agentis.workflow.graph.patch')).toBe(false);
    expect(isSelfHealControlToolAllowed('agentis.workflow.dry_run')).toBe(false);
    expect(isSelfHealControlToolAllowed('agentis.workflow.test')).toBe(false);
    expect(isSelfHealControlToolAllowed('agentis.workflow.deliver')).toBe(false);
    expect(isSelfHealControlToolAllowed('agentis.run.replay')).toBe(false);
  });
});
