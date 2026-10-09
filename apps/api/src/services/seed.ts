/**
 * First-boot seed.
 *
 * Creates the operator user, a Personal workspace, a Local ambient, and
 * registers the builtin `echo` and `http_fetch` extensions. Idempotent — re-runs
 * skip rows that already exist (matched by username/slug).
 *
 * The seed password comes from `AGENTIS_SEED_PASSWORD`. If unset, we generate
 * a random one and log it ONCE on first boot. This is the single point in the
 * lifecycle where Agentis ever prints a credential to stdout — by design,
 * because there is no other way for the operator to bootstrap themselves.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { ExtensionManifest } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { AuthService } from './auth.js';
import type { AgentisEnv } from '../env.js';
import { BUILTIN_EXTENSION_ENTRYPOINTS } from './builtinExtensions.js';

export interface SeedResult {
  user: { id: string; username: string };
  workspace: { id: string; slug: string };
  ambient: { id: string };
  generatedPassword?: string;
}

export async function seedIfEmpty(args: {
  db: AgentisSqliteDb;
  env: AgentisEnv;
  auth: AuthService;
  logger: Logger;
}): Promise<SeedResult | null> {
  const { db, env, auth, logger } = args;
  const existing = db.select().from(schema.users).all();
  if (existing.length > 0) {
    return null;
  }

  const username = env.AGENTIS_SEED_USERNAME;
  if (env.NODE_ENV === 'production' && !env.AGENTIS_SEED_PASSWORD) {
    throw new Error(
      'AGENTIS_SEED_PASSWORD is required for the first production boot. Set a unique long password in your secret manager before starting Agentis.',
    );
  }
  // Test mode: deterministic password if none was provided, so Playwright
  // specs can sign in without scraping stdout.
  const testDefault = env.AGENTIS_TEST_MODE ? 'test-password-1234' : undefined;
  const explicit = env.AGENTIS_SEED_PASSWORD ?? testDefault;
  const generatedPassword = explicit ? undefined : randomBytes(18).toString('base64url');
  const password = explicit ?? generatedPassword!;

  const userId = randomUUID();
  const passwordHash = await auth.hashPassword(password);

  db.insert(schema.users)
    .values({
      id: userId,
      username,
      displayName: env.AGENTIS_SEED_DISPLAY_NAME,
      passwordHash,
      isAdmin: true,
    })
    .run();

  const workspaceId = randomUUID();
  db.insert(schema.workspaces)
    .values({
      id: workspaceId,
      userId,
      name: 'Personal',
      slug: 'personal',
    })
    .run();

  const ambientId = randomUUID();
  db.insert(schema.ambients)
    .values({
      id: ambientId,
      workspaceId,
      userId,
      name: 'Local',
      kind: 'local',
      settings: {},
    })
    .run();

  db.update(schema.workspaces)
    .set({ defaultAmbientId: ambientId })
    .where(eq(schema.workspaces.id, workspaceId))
    .run();

  // Register builtin extensions.
  for (const entrypoint of BUILTIN_EXTENSION_ENTRYPOINTS) {
    const manifest: ExtensionManifest = {
      name: entrypoint,
      slug: entrypoint,
      version: '1.0.0',
      runtime: 'builtin',
      entrypoint,
      operations: [{
        name: 'execute',
        description: `Run the built-in ${entrypoint} operation.`,
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      }],
      capabilityTags: ['builtin'],
    };
    db.insert(schema.extensions)
      .values({
        id: randomUUID(),
        workspaceId,
        ambientId,
        userId,
        name: entrypoint,
        slug: entrypoint,
        version: '1.0.0',
        runtime: 'builtin',
        manifest,
      })
      .run();
  }

  if (generatedPassword) {
    // Password still exists as a fallback for server deployments or direct
    // API access. Local CLI users are auto-logged in via the launch token
    // (.agentis/token) — they never need to type this.
    logger.info('seed.completed', { username, hint: 'Local CLI users are auto-logged in. For server deployments, set AGENTIS_SEED_PASSWORD before first boot.' });
  } else {
    logger.info('seed.completed', { username });
  }

  return {
    user: { id: userId, username },
    workspace: { id: workspaceId, slug: 'personal' },
    ambient: { id: ambientId },
    ...(generatedPassword ? { generatedPassword } : {}),
  };
}
