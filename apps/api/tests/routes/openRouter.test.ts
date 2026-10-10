import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import { buildHarnessRoutes } from '../../src/routes/harness.js';
import { buildCredentialRoutes } from '../../src/routes/credentials.js';
import { clearOpenRouterCatalogCache, openRouterCredential } from '../../src/services/runtime/openRouter.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
describe('workspace-scoped OpenRouter credentials', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); clearOpenRouterCatalogCache(); });
  afterEach(() => { ctx.close(); vi.unstubAllGlobals(); clearOpenRouterCatalogCache(); });
  it('encrypts the key and authenticates without paid completions', async () => {
    const app = ctx.buildApp([{ path: '/v1/credentials', app: buildCredentialRoutes({ db: ctx.db, auth: ctx.auth, vault: ctx.vault }) }, { path: '/v1/harness', app: buildHarnessRoutes({ db: ctx.db, auth: ctx.auth, vault: ctx.vault }) }]);
    const saved = await app.request('/v1/credentials', { method: 'POST', headers: { ...ctx.authHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Clinic', credentialType: 'openrouter_api_key', value: 'secret-test' }) });
    expect(saved.status).toBe(201); const { id } = await saved.json();
    expect(ctx.db.select().from(schema.credentials).all()[0]!.encryptedValue).not.toContain('secret-test');
    expect(() => openRouterCredential(ctx.db, ctx.vault, 'another-workspace', id)).toThrow(/unavailable/);
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/key') ? { data: {} } : { data: [{ id: 'model', supported_parameters: ['tools'] }] }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const test = await app.request('/v1/harness/test', { method: 'POST', headers: { ...ctx.authHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ adapterType: 'openrouter', config: { authCredentialId: id, model: 'model' } }) });
    expect(await test.json()).toMatchObject({ status: 'pass' });
    expect(fetch.mock.calls.every(([url]) => !url.includes('completions'))).toBe(true);
    const listed = await app.request('/v1/credentials', { headers: ctx.authHeaders });
    expect(await listed.text()).not.toContain('secret-test');
  });
});
