/**
 * OutboundPolicyService — the per-App outbound safety envelope (LIVING-APPS-10X §7 · G7).
 *
 * Verifies the four gates over apps.policyJson.outbound: rate limit (per rolling
 * hour), quiet hours (incl. midnight wrap), a blocked-claim deny, and a
 * require-approval hold — plus the additive defaults (absent policy = allow) and
 * the operator-send exemption.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { AppStore } from '@agentis/app';
import { OutboundPolicyService, type OutboundDecision } from '../../src/services/outboundPolicy.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function makeApp(outbound?: Record<string, unknown>): string {
  const app = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Acme Sales' });
  if (outbound) {
    ctx.db
      .update(schema.apps)
      .set({ policyJson: { audience: [], shareable: false, customCode: 'disabled', grants: [], outbound } })
      .where(eq(schema.apps.id, app.id))
      .run();
  }
  return app.id;
}

describe('OutboundPolicyService.evaluate', () => {
  it('allows when no App / no policy (additive default — today\'s behavior)', () => {
    const svc = new OutboundPolicyService({ db: ctx.db });
    expect(svc.evaluate(null, { body: 'hi', source: 'agent' })).toMatchObject({ allow: true, needsApproval: false });
    const appId = makeApp(); // app with empty policy
    expect(svc.evaluate(appId, { body: 'hi', source: 'agent' })).toMatchObject({ allow: true });
  });

  it('exempts operator sends from every limit', () => {
    const svc = new OutboundPolicyService({ db: ctx.db });
    const appId = makeApp({ maxPerHour: 1, quietHours: { start: 0, end: 23 }, blockedClaims: ['discount'] });
    svc.record(appId, 'agent'); // at the cap
    // An operator's manual send is a human action — always allowed.
    expect(svc.evaluate(appId, { body: 'here is your discount', source: 'operator' })).toMatchObject({ allow: true });
  });

  it('denies over the per-hour rate limit', () => {
    const svc = new OutboundPolicyService({ db: ctx.db });
    const appId = makeApp({ maxPerHour: 2 });
    const now = new Date('2026-06-26T12:00:00.000Z');
    expect(svc.evaluate(appId, { body: 'm', source: 'agent', now }).allow).toBe(true);
    svc.record(appId, 'agent', now);
    svc.record(appId, 'agent', now);
    const decision = svc.evaluate(appId, { body: 'm', source: 'agent', now });
    expect(decision.allow).toBe(false);
    expect(decision.needsApproval).toBe(false);
    expect(decision.reason).toMatch(/rate limit/i);
  });

  it('rolls the rate window — sends older than an hour do not count', () => {
    const svc = new OutboundPolicyService({ db: ctx.db });
    const appId = makeApp({ maxPerHour: 1 });
    const old = new Date('2026-06-26T10:00:00.000Z');
    const now = new Date('2026-06-26T12:00:00.000Z'); // 2h later
    svc.record(appId, 'agent', old);
    expect(svc.evaluate(appId, { body: 'm', source: 'agent', now }).allow).toBe(true);
  });

  it('does not count operator sends against the agent rate limit', () => {
    const svc = new OutboundPolicyService({ db: ctx.db });
    const appId = makeApp({ maxPerHour: 1 });
    const now = new Date('2026-06-26T12:00:00.000Z');
    svc.record(appId, 'operator', now);
    svc.record(appId, 'operator', now);
    expect(svc.evaluate(appId, { body: 'm', source: 'agent', now }).allow).toBe(true);
  });

  it('denies during quiet hours (and allows outside)', () => {
    const svc = new OutboundPolicyService({ db: ctx.db });
    const appId = makeApp({ quietHours: { start: 22, end: 7 } }); // wraps midnight
    const night = new Date('2026-06-26T23:00:00.000'); // local 23:00 → quiet
    const day = new Date('2026-06-26T12:00:00.000'); // local 12:00 → fine
    expect(svc.evaluate(appId, { body: 'm', source: 'agent', now: night })).toMatchObject({ allow: false });
    expect(svc.evaluate(appId, { body: 'm', source: 'agent', now: day }).allow).toBe(true);
  });

  it('denies a blocked claim outright (no approval)', () => {
    const svc = new OutboundPolicyService({ db: ctx.db });
    const appId = makeApp({ blockedClaims: ['guaranteed refund', 'lifetime warranty'] });
    const d: OutboundDecision = svc.evaluate(appId, { body: 'We offer a GUARANTEED REFUND on this', source: 'agent' });
    expect(d.allow).toBe(false);
    expect(d.needsApproval).toBe(false);
    expect(d.reason).toMatch(/blocked claim/i);
  });

  it('holds a require-approval claim for the operator', () => {
    const svc = new OutboundPolicyService({ db: ctx.db });
    const appId = makeApp({ requireApprovalFor: ['discount', 'price'] });
    const d = svc.evaluate(appId, { body: 'I can give you a special discount', source: 'agent' });
    expect(d.allow).toBe(false);
    expect(d.needsApproval).toBe(true);
    expect(d.reason).toMatch(/approval/i);
  });

  it('blocked claim wins over approval (priority order)', () => {
    const svc = new OutboundPolicyService({ db: ctx.db });
    // The same term is both blocked and approval-gated — the hard block wins.
    const appId = makeApp({ blockedClaims: ['refund'], requireApprovalFor: ['refund'] });
    const d = svc.evaluate(appId, { body: 'a full refund', source: 'agent' });
    expect(d).toMatchObject({ allow: false, needsApproval: false });
    expect(d.reason).toMatch(/blocked claim/i);
  });

  it('applies autonomy modes and a per-Subject override', () => {
    const appId = makeApp();
    ctx.db.update(schema.apps).set({
      policyJson: {
        customCode: 'disabled', grants: [],
        autonomy: {
          mode: 'reply_only', actions: {},
          subjectOverrides: { 'subject-vip': { mode: 'broad', actions: { cross_recipient: 'deny' } } },
        },
      },
    }).where(eq(schema.apps.id, appId)).run();
    const svc = new OutboundPolicyService({ db: ctx.db });
    expect(svc.evaluateAutonomy(appId, 'proactive_followup', 'ordinary').decision).toBe('deny');
    expect(svc.evaluateAutonomy(appId, 'proactive_followup', 'subject-vip').decision).toBe('allow');
    expect(svc.evaluateAutonomy(appId, 'cross_recipient', 'subject-vip').decision).toBe('deny');
  });
});
