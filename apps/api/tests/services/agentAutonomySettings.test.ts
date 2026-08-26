/**
 * W2 operating manual composition + W7 self-heal settings round-trip.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  composeOperatingManual,
  DEFAULT_CAPABILITIES_MANUAL,
  ROLE_TIER_MANUAL,
  getWorkspaceManual,
  setWorkspaceManual,
} from '../../src/services/agent/agentOperatingManual.js';
import { getSelfHealConfig, setSelfHealConfig, DEFAULT_SELF_HEAL } from '../../src/services/selfHealSettings.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

describe('agentOperatingManual (W2)', () => {
  it('always briefs capabilities + the hard anti-hallucination rules', () => {
    const m = composeOperatingManual({});
    expect(m).toContain('operating manual');
    expect(m).toMatch(/never fabricate/i);
    expect(m).toMatch(/preserve intent/i);
    expect(m).toMatch(/delegate|spawn/i);
  });

  it('layers the role-tier manual when a role is given (D1)', () => {
    const orch = composeOperatingManual({ role: 'orchestrator' });
    expect(orch).toContain(ROLE_TIER_MANUAL.orchestrator);
    const worker = composeOperatingManual({ role: 'worker' });
    expect(worker).toContain(ROLE_TIER_MANUAL.worker);
    // Unknown role → no role tier; the base manual (+ the always-on routing
    // intelligence block the composer appends) and nothing role-specific.
    const unknown = composeOperatingManual({ role: 'wizard' });
    expect(unknown.startsWith(DEFAULT_CAPABILITIES_MANUAL)).toBe(true);
    expect(unknown).toContain('Runtime Routing Intelligence');
    expect(unknown).not.toContain('### Your role');
  });

  it('a workspace override replaces the capabilities base (persona stays separate)', () => {
    const m = composeOperatingManual({ role: 'worker', workspaceManual: 'House rules: ship small.' });
    expect(m).toContain('House rules: ship small.');
    expect(m).toContain(ROLE_TIER_MANUAL.worker);
    expect(m).toContain('Workflow delivery is atomic');
    expect(m).toContain('agentis.workflow.deliver');
    expect(m).toContain('A medium-state workflow is not a deliverable');
  });
});

describe('self-heal settings + workspace manual store (W7/W2)', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => ctx.close());

  it('defaults to guarded autonomy with a three-plan ceiling', () => {
    expect(getSelfHealConfig(ctx.db, ctx.workspace.id)).toEqual(DEFAULT_SELF_HEAL);
  });

  it('round-trips the self-heal config', () => {
    const next = setSelfHealConfig(ctx.db, ctx.workspace.id, { mode: 'bypass', maxRepairPlans: 3 });
    expect(next.mode).toBe('bypass');
    expect(next.maxRepairPlans).toBe(3);
    expect(getSelfHealConfig(ctx.db, ctx.workspace.id).mode).toBe('bypass');
    // clamps out-of-range plan ceilings.
    expect(setSelfHealConfig(ctx.db, ctx.workspace.id, { maxRepairPlans: 99 }).maxRepairPlans).toBe(5);
  });

  it('round-trips a workspace operating-manual override', () => {
    expect(getWorkspaceManual(ctx.db, ctx.workspace.id)).toBeNull();
    setWorkspaceManual(ctx.db, ctx.workspace.id, 'Our agents always cite sources.');
    expect(getWorkspaceManual(ctx.db, ctx.workspace.id)).toBe('Our agents always cite sources.');
    setWorkspaceManual(ctx.db, ctx.workspace.id, '');
    expect(getWorkspaceManual(ctx.db, ctx.workspace.id)).toBeNull();
  });
});
