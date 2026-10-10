import { expect, test } from '../fixtures';
import { uiAuth } from './_helpers';

test('OpenRouter configuration is explicit, vault-backed and preserves blank keys', async ({ page, request }) => {
  test.setTimeout(90000);
  const auth = await uiAuth(page, request);
  const created = await request.post('/v1/agents', { headers: auth.h, data: { name: 'OpenRouter Configuration Test', adapterType: 'http', role: 'worker', isPaused: true, config: { dispatchUrl: 'https://example.com' } } });
  expect(created.status()).toBe(201); const { id } = await created.json();
  const catalogResponse = await request.get('/v1/harness/models/openrouter', { headers: auth.h });
  expect(catalogResponse.ok()).toBeTruthy(); const catalog = await catalogResponse.json();
  expect(catalog.defaultModel).toBeNull(); const model = catalog.models[0]; expect(model).toBeTruthy();
  // Inference credentials are intentionally fake; this test never bills or connects a model.
  await page.route('**/v1/harness/test', async (route) => {
    const body = route.request().postDataJSON();
    expect(body.config.authCredentialId).toBeTruthy(); expect(body.config.model).toBe(model.id); expect(body.config.apiKey).toBeUndefined();
    await route.fulfill({ json: { status: 'pass', checks: [{ code: 'simulated', level: 'info', message: 'Simulated authentication: no generation billed' }] } });
  });
  await page.goto(`/agents/${id}?tab=runtime`);
  await page.getByRole('tab', { name: 'Runtime', exact: true }).click();
  await page.getByText('OpenRouter', { exact: true }).click();
  const unchanged = await request.get(`/v1/agents/${id}`, { headers: auth.h });
  expect((await unchanged.json()).agent.adapterType).toBe('http');
  await page.getByRole('button', { name: /Choose a model/ }).click();
  await page.getByText(model.label, { exact: true }).click();
  await page.getByLabel('API key', { exact: true }).fill('test-only-not-a-real-key');
  const credentialSaved = page.waitForResponse((response) => response.url().endsWith('/v1/credentials') && response.request().method() === 'POST');
  await page.getByRole('group', { name: 'OpenRouter connection' }).getByRole('button', { name: 'Test connection', exact: true }).click();
  expect((await credentialSaved).status()).toBe(201);
  await expect(page.getByText('Simulated authentication: no generation billed')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'Save runtime', exact: true }).click();
  await expect.poll(async () => (await (await request.get(`/v1/agents/${id}`, { headers: auth.h })).json()).agent.adapterType).toBe('openrouter');
  const { agent: saved } = await (await request.get(`/v1/agents/${id}`, { headers: auth.h })).json();
  expect(saved.config.authCredentialId).toBeTruthy(); expect(saved.config.model).toBe(model.id); expect(JSON.stringify(saved)).not.toContain('test-only-not-a-real-key');
  await page.reload();
  await expect(page.getByLabel('Replace API key (optional)')).toHaveValue('');
  await page.getByRole('button', { name: 'Save runtime', exact: true }).click();
  expect((await (await request.get(`/v1/agents/${id}`, { headers: auth.h })).json()).agent.config.authCredentialId).toBe(saved.config.authCredentialId);
});
