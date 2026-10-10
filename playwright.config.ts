/**
 * Playwright config for end-to-end specs.
 *
 * - Spawns the full stack (`pnpm dev:full`) with `AGENTIS_TEST_MODE=1` and
 *   a deterministic seed so specs can sign in with known credentials and
 *   wipe state via `POST /v1/_test/reset`.
 * - Targets dedicated test ports by default, with Vite proxying /v1/* and
 *   /socket.io to the isolated API server.
 * - Always starts fresh servers so a normal local development process cannot
 *   be mistaken for a test-mode API with reset endpoints enabled.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PLAYWRIGHT_BASE_PORT ?? 5174);
const API_PORT = Number(process.env.PLAYWRIGHT_API_PORT ?? 3738);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false, // shared SQLite — sequential is the contract
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], ...(process.env.PLAYWRIGHT_BROWSER_CHANNEL ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL } : {}) },
    },
  ],
  // We spawn the API and the Vite dev server as two independent webServer
  // entries instead of going through `pnpm dev:full` (concurrently). On
  // Windows the concurrently wrapper buffered the API's stdout under
  // Playwright's spawn() and the API never made progress past compile —
  // splitting them sidesteps the issue and lets each one signal readiness
  // via its own URL probe.
  webServer: [
    {
      command: 'pnpm --filter @agentis/api dev:once',
      url: `http://127.0.0.1:${API_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        AGENTIS_TEST_MODE: '1',
        AGENTIS_SEED_USERNAME: 'operator',
        AGENTIS_SEED_PASSWORD: 'test-password-1234',
        AGENTIS_HTTP_PORT: String(API_PORT),
        AGENTIS_DATA_DIR: process.env.AGENTIS_DATA_DIR ?? '.agentis-e2e',
      },
    },
    {
      command: 'pnpm --filter @agentis/web dev',
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        AGENTIS_WEB_PORT: String(PORT),
        AGENTIS_API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}`,
      },
    },
  ],
});
