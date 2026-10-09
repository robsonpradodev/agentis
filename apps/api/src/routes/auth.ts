/**
 * /v1/auth — login, refresh, /me.
 */

import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { AgentisError, schemas, type AuthenticatedUser } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { AgentisSecrets } from '../secrets.js';
import { requireAuth, getUser } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { createRateLimiter, clientIp } from '../middleware/rateLimit.js';
import { createApiKeySecret, hashApiKey } from '../services/apiKeys.js';

export function buildAuthRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  secrets?: AgentisSecrets;
  /** The URL-token convenience flow is intentionally unavailable on a VPS. */
  allowLocalBypass?: boolean;
}) {
  const app = new Hono();
  const productionMode = process.env.NODE_ENV === 'production';
  let fallbackLaunchToken = deps.secrets?.launchToken;

  async function issueLaunchTokens() {
    const user = deps.db.select().from(schema.users).get();
    if (!user) throw new AgentisError('AUTH_INVALID_CREDENTIALS', 'No operator user found');
    const tokens = await deps.auth.issueTokens(user.id, user.username);
    return {
      user: toUser(user),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresInSeconds: tokens.expiresInSeconds,
    };
  }

  function consumeLaunchToken(candidate: string): boolean {
    if (deps.secrets?.consumeLaunchToken) return deps.secrets.consumeLaunchToken(candidate);
    if (!fallbackLaunchToken || candidate !== fallbackLaunchToken) return false;
    fallbackLaunchToken = undefined;
    return true;
  }

  // OWASP A07: throttle credential-stuffing. 5 attempts per minute per
  // (IP, username) — and a separate 20-per-minute IP-only ceiling so user
  // enumeration can't dodge the per-pair limit. In-memory: process-local.
  //
  // E2E bypass (AGENTIS_TEST_MODE=1): the Playwright suite drives the live
  // login flow hundreds of times across the spec matrix. The contract is
  // pinned by the vitest suite (`tests/routes/authRateLimit.test.ts` +
  // `tests/middleware/rateLimit.test.ts`) which runs without TEST_MODE.
  const testModeBypass = !productionMode && process.env.AGENTIS_TEST_MODE === '1';
  const loginPerPair = createRateLimiter({
    limit: 5,
    windowMs: 60_000,
    keyFn: async (c) => {
      if (testModeBypass) return null;
      let username = '';
      try {
        const cloned = c.req.raw.clone();
        const body = (await cloned.json().catch(() => null)) as { username?: unknown } | null;
        if (body && typeof body.username === 'string') username = body.username.toLowerCase();
      } catch {
        /* unparseable body — let zod handle the 422 */
      }
      return `pair:${clientIp(c)}:${username}`;
    },
  });
  const loginPerIp = createRateLimiter({
    limit: 20,
    windowMs: 60_000,
    keyFn: (c) => (testModeBypass ? null : `ip:${clientIp(c)}`),
  });
  const refreshPerIp = createRateLimiter({
    limit: 30,
    windowMs: 60_000,
    keyFn: (c) => (testModeBypass ? null : `refresh:${clientIp(c)}`),
  });
  const launchPerIp = createRateLimiter({
    limit: 5,
    windowMs: 60_000,
    keyFn: (c) => (testModeBypass ? null : `launch:${clientIp(c)}`),
  });

  app.post('/login', loginPerIp, loginPerPair, async (c) => {
    const body = schemas.loginRequestSchema.parse(await c.req.json());
    const user = deps.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, body.username))
      .get();
    if (!user) throw new AgentisError('AUTH_INVALID_CREDENTIALS', 'Invalid credentials');
    const ok = await deps.auth.verifyPassword(body.password, user.passwordHash);
    if (!ok) throw new AgentisError('AUTH_INVALID_CREDENTIALS', 'Invalid credentials');
    const tokens = await deps.auth.issueTokens(user.id, user.username);
    return c.json({
      user: toUser(user),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresInSeconds: tokens.expiresInSeconds,
    });
  });

  app.post('/refresh', refreshPerIp, async (c) => {
    const body = schemas.refreshRequestSchema.parse(await c.req.json());
    const claims = await deps.auth.verify(body.refreshToken, 'refresh');
    const user = deps.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, claims.sub))
      .get();
    if (!user) throw new AgentisError('AUTH_TOKEN_INVALID', 'User no longer exists');
    const tokens = await deps.auth.issueTokens(user.id, user.username);
    return c.json(tokens);
  });

  app.get('/me', requireAuth(deps), (c) => c.json({ user: getUser(c) }));

  app.patch('/me', requireAuth(deps), async (c) => {
    const user = getUser(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      email?: string;
    };
    const updates: Partial<typeof schema.users.$inferSelect> = {
      updatedAt: new Date().toISOString(),
    };
    if (typeof body.name === 'string' && body.name.trim()) {
      updates.displayName = body.name.trim();
    }
    if (typeof body.email === 'string') {
      updates.email = body.email.trim() || null;
    }

    deps.db
      .update(schema.users)
      .set(updates)
      .where(eq(schema.users.id, user.id))
      .run();

    return c.json({ ok: true });
  });

  app.get('/api-keys', requireAuth(deps), requireWorkspace(deps), (c) => {
    const ws = getWorkspace(c);
    const keys = deps.db
      .select()
      .from(schema.apiKeys)
      .where(and(
        eq(schema.apiKeys.workspaceId, ws.workspaceId),
        eq(schema.apiKeys.userId, ws.user.id),
        isNull(schema.apiKeys.revokedAt),
      ))
      .all()
      .map((key) => ({
        id: key.id,
        name: key.name,
        preview: key.preview,
        createdAt: key.createdAt,
        lastUsedAt: key.lastUsedAt,
        expiresAt: key.expiresAt,
      }));
    return c.json({ keys });
  });

  // Keys never live longer than a year without being re-issued — a bound on
  // how long a leaked/forgotten key stays usable. `null` = no expiry.
  const MAX_API_KEY_TTL_DAYS = 365;

  app.post('/api-keys', requireAuth(deps), requireWorkspace(deps), async (c) => {
    const ws = getWorkspace(c);
    const body = z.object({
      name: z.string().trim().min(1).max(120),
      expiresInDays: z.number().int().min(1).max(MAX_API_KEY_TTL_DAYS).nullable().optional(),
    }).parse(await c.req.json());
    const id = randomUUID();
    const secret = createApiKeySecret();
    const preview = `${secret.slice(0, 8)}...${secret.slice(-4)}`;
    const expiresAt = body.expiresInDays
      ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null;
    deps.db.insert(schema.apiKeys).values({
      id,
      workspaceId: ws.workspaceId,
      userId: ws.user.id,
      name: body.name,
      keyHash: hashApiKey(secret),
      preview,
      expiresAt,
    }).run();
    return c.json({ key: { id, name: body.name, secret, preview, createdAt: new Date().toISOString(), expiresAt } }, 201);
  });

  app.delete('/api-keys/:id', requireAuth(deps), requireWorkspace(deps), (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const key = deps.db
      .select()
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.workspaceId, ws.workspaceId), eq(schema.apiKeys.userId, ws.user.id)))
      .get();
    if (!key) throw new AgentisError('RESOURCE_NOT_FOUND', 'API key not found');
    deps.db.update(schema.apiKeys).set({ revokedAt: new Date().toISOString() }).where(eq(schema.apiKeys.id, id)).run();
    return c.json({ ok: true });
  });

  /**
   * POST /v1/auth/launch — token-file auto-login for the local CLI launch flow.
   *
   * The CLI writes a random token to .agentis/token on boot, then opens the
   * browser at the dashboard URL with ?token=<value>. The frontend POSTs it
   * here; we validate it and return a normal JWT pair. No password required
   * for local installs.
   *
   * Not rate-limited — the token is 32 random bytes and the route only works
   * while the server has a launchToken (i.e. local/file-backed installs).
   * Server deployments (env-var secrets) have no launchToken and always get 404.
   */
  app.post('/launch', launchPerIp, async (c) => {
    if (!fallbackLaunchToken && !deps.secrets?.consumeLaunchToken) {
      throw new AgentisError('RESOURCE_NOT_FOUND', 'Launch auth is not available on this deployment');
    }
    const body = (await c.req.json().catch(() => ({}))) as { token?: unknown };
    if (typeof body.token !== 'string') {
      throw new AgentisError('AUTH_INVALID_CREDENTIALS', 'Invalid launch token');
    }

    if (deps.allowLocalBypass && body.token === 'local-bypass') {
      const ip = clientIp(c);
      const host = c.req.header('host') || '';
      const isLocalIp = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
      const isLocalHost = host.startsWith('localhost:') || host === 'localhost' || host.startsWith('127.0.0.1:') || host === '127.0.0.1';
      if (isLocalIp && isLocalHost) {
        return c.json(await issueLaunchTokens());
      }
    }

    if (!consumeLaunchToken(body.token)) {
      throw new AgentisError('AUTH_INVALID_CREDENTIALS', 'Invalid launch token');
    }
    return c.json(await issueLaunchTokens());
  });

  return app;
}

function toUser(row: typeof schema.users.$inferSelect): AuthenticatedUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    email: row.email ?? null,
  };
}
