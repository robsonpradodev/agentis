import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { buildSuspensionRoutes } from '../../src/routes/suspensions.js';
import { DurableSuspensionService } from '../../src/services/suspension/durableSuspensionService.js';

let ctx: TestContext;

beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

describe('suspension routes', () => {
  it('lets an OSS integration inspect capabilities and resolve a plugin-defined wait', async () => {
    const service = new DurableSuspensionService({ db: ctx.db, logger: ctx.logger });
    service.registerPresenter('external_signal', { present: async () => ({ ref: 'connector-item-1' }) });
    const resume = vi.fn(async () => undefined);
    service.registerResumer('connector_job', { resume });
    const waiting = await service.suspend({
      workspaceId: ctx.workspace.id,
      origin: { type: 'connector_job', id: 'job-1' },
      condition: { type: 'external_signal', payload: { signal: 'verified' } },
      audience: { type: 'connector', target: 'custom-portal' },
      reason: 'Wait for verification.',
    });
    const app = ctx.buildApp([{ path: '/v1/suspensions', app: buildSuspensionRoutes({ db: ctx.db, auth: ctx.auth, suspensions: service }) }]);

    const capabilities = await app.request('/v1/suspensions/capabilities', { headers: ctx.authHeaders });
    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toEqual({
      conditionTypes: ['external_signal'],
      resumableOriginTypes: ['connector_job'],
    });

    const resolved = await app.request(`/v1/suspensions/${waiting.suspensionId}/resolve`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ kind: 'verified', data: { reference: 'verification-9' } }),
    });
    expect(resolved.status).toBe(200);
    expect((await resolved.json()).suspension).toEqual(expect.objectContaining({ state: 'ready' }));
    expect(resume).toHaveBeenCalledTimes(1);
  });
});
