/**
 * /v1/harness — runtime detection + in-app install.
 *
 *   GET  /detect              → detect installed harnesses on this machine
 *   GET  /harness-status      → detection in adapter-status shape
 *   GET  /install-options     → which harnesses support automated install
 *   POST /install             → run an automated install, streamed over SSE
 *
 * The install endpoint is the backbone of the "no runtime? install it right
 * here" experience (AGENT-ONBOARDING-REPLAN.md §2.4). Security is
 * non-negotiable: only whitelisted adapter types auto-install, the install
 * command is a fixed constant per type, and attempts are rate-limited per
 * workspace.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { AgentisError } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { detectHarnesses, testHarnessConfig, type V1HarnessAdapterType } from '../services/harness/harnessProbe.js';
import {
  installHarness,
  isAutoInstallableAdapter,
  listHarnessInstallOptions,
} from '../services/harness/harnessInstall.js';
import { listRuntimeModels } from '../services/runtime/runtimeModels.js';
import type { CredentialVault } from '../services/credentialVault.js';
import { openRouterCredential, testOpenRouter } from '../services/runtime/openRouter.js';

export interface HarnessRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  vault?: CredentialVault;
}

const HARNESS_ADAPTER_TYPES = new Set<string>([
  'openclaw', 'hermes_agent', 'claude_code', 'codex', 'cursor', 'antigravity', 'openrouter', 'http',
]);

// In-memory rate limiter — 2 install attempts per workspace per minute.
const INSTALL_WINDOW_MS = 60_000;
const INSTALL_MAX_PER_WINDOW = 2;
const installAttempts = new Map<string, number[]>();

function allowInstall(workspaceId: string): boolean {
  const now = Date.now();
  const recent = (installAttempts.get(workspaceId) ?? []).filter((ts) => now - ts < INSTALL_WINDOW_MS);
  if (recent.length >= INSTALL_MAX_PER_WINDOW) {
    installAttempts.set(workspaceId, recent);
    return false;
  }
  recent.push(now);
  installAttempts.set(workspaceId, recent);
  return true;
}

export function buildHarnessRoutes(deps: HarnessRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/detect', async (c) => {
    const harnesses = await detectHarnesses();
    return c.json({ harnesses });
  });

  app.get('/harness-status', async (c) => {
    const harnesses = await detectHarnesses();
    return c.json({
      adapters: harnesses.map((harness) => ({
        type: harness.adapterType,
        adapterType: harness.adapterType,
        label: harness.harness,
        installed: harness.status === 'found',
        status: harness.status,
        detail: harness.detail,
        installCommand: harness.installCommand,
      })),
    });
  });

  app.get('/models/:adapterType', async (c) => {
    const adapterType = c.req.param('adapterType');
    if (!HARNESS_ADAPTER_TYPES.has(adapterType)) {
      throw new AgentisError('VALIDATION_FAILED', `'${adapterType}' is not a supported runtime.`);
    }
    const agentId = c.req.query('agentId') || null;
    const catalog = await listRuntimeModels(adapterType as V1HarnessAdapterType, agentId, deps.db);
    return c.json(catalog);
  });

  /**
   * Deep runtime test for the agent-creation flow. Unlike `/detect` (which
   * only probes for binary presence), this actually exercises CLI harnesses:
   * it runs the binary against a one-word prompt, checks auth, and returns a
   * structured diagnostic with actionable hints. User-triggered only.
   */
  app.post('/test', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      adapterType?: string;
      config?: Record<string, unknown>;
    };
    const adapterType = body.adapterType;
    if (!adapterType || !HARNESS_ADAPTER_TYPES.has(adapterType)) {
      throw new AgentisError('VALIDATION_FAILED', `'${adapterType ?? 'unknown'}' is not a runtime that can be tested.`);
    }
    const config = body.config && typeof body.config === 'object' ? body.config : {};
    if (adapterType === 'openrouter') {
      if (!deps.vault) throw new AgentisError('ADAPTER_UNAVAILABLE', 'Credential vault is unavailable.');
      const ws = getWorkspace(c);
      const key = openRouterCredential(deps.db, deps.vault, ws.workspaceId, config.authCredentialId);
      return c.json(await testOpenRouter(key, typeof config.model === 'string' ? config.model : ''));
    }
    const result = await testHarnessConfig(adapterType as V1HarnessAdapterType, config, { deep: true });
    return c.json(result);
  });

  /** Which harnesses can be auto-installed vs. need manual setup. */
  app.get('/install-options', (c) => {
    return c.json({ adapters: listHarnessInstallOptions() });
  });

  /**
   * Run an automated install. Streams `step` / `log` / `complete` / `error`
   * events as Server-Sent Events. Whitelisted adapter types only.
   */
  app.post('/install', async (c) => {
    const ws = getWorkspace(c);
    const body = (await c.req.json().catch(() => ({}))) as { adapterType?: string };
    const adapterType = body.adapterType;

    if (!adapterType || !isAutoInstallableAdapter(adapterType as never)) {
      throw new AgentisError('VALIDATION_FAILED', `'${adapterType ?? 'unknown'}' cannot be installed automatically.`);
    }

    const existing = (await detectHarnesses()).find((harness) => harness.adapterType === adapterType);
    if (existing?.status === 'found') {
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({
          event: 'step',
          data: JSON.stringify({ index: 0, label: `${existing.harness} already detected`, status: 'done', detail: existing.binaryPath ?? existing.detail }),
        });
        await stream.writeSSE({
          event: 'complete',
          data: JSON.stringify({
            ok: true,
            binaryPath: existing.binaryPath,
            detectedVersion: existing.detectedVersion,
            detectedModel: existing.detectedModel,
          }),
        });
      });
    }

    if (!allowInstall(ws.workspaceId)) {
      throw new AgentisError('VALIDATION_FAILED', 'Too many install attempts. Wait a minute and try again.');
    }

    return streamSSE(c, async (stream) => {
      try {
        const result = await installHarness({
          adapterType: adapterType as 'claude_code' | 'codex',
          onStep: async (step) => {
            await stream.writeSSE({ event: 'step', data: JSON.stringify(step) });
          },
          onLog: async (line) => {
            await stream.writeSSE({ event: 'log', data: JSON.stringify({ line }) });
          },
        });
        await stream.writeSSE({ event: 'complete', data: JSON.stringify(result) });
      } catch (err) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ message: err instanceof Error ? err.message : 'Install failed.' }),
        });
      }
    });
  });

  return app;
}
