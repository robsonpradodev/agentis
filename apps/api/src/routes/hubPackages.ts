/**
 * Optional AgentisHub import boundary.
 *
 * Security properties:
 * - disabled unless the operator explicitly configures a Hub URL and trust keys;
 * - verifies the Ed25519 outer signature before any activation/network work;
 * - keeps workspace private keys vault-encrypted and never transmits them;
 * - checks ciphertext and plaintext SHA-256 values;
 * - routes recovered native payloads through the existing scanners/importers.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  AgentisError,
  hubArtifactEnvelopeSchema,
  packageExportEnvelopeSchema,
  packageManifestSchema,
  workspaceBundleEnvelopeSchema,
} from '@agentis/core';
import type { AppManifestEnvelope } from '@agentis/core';
import { AppPackager } from '@agentis/app';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { CredentialVault } from '../services/credentialVault.js';
import type { EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';
import type { SkillService } from '../services/skillService.js';
import type { EpisodicMemoryStore } from '../services/episodicMemoryStore.js';
import { EpisodicBrainPort } from '../services/brain/brainExport.js';
import { PackagerService } from '../services/packager.js';
import { WorkspacePackager } from '../services/workspace/workspacePackager.js';
import { HubArtifactService } from '../services/hub/hubArtifactService.js';
import { scanArtifactBytes } from '../services/registryScanner.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

const importSchema = z.object({
  envelope: hubArtifactEnvelopeSchema,
  permissionsAcknowledged: z.literal(true),
  deviceCode: z.string().min(16).max(256).optional(),
});

export function buildHubPackageRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  vault: CredentialVault;
  hubUrl?: string;
  publicKeysJson?: string;
  bus?: EventBus;
  logger?: Logger;
  skills?: SkillService;
  episodes?: EpisodicMemoryStore;
}) {
  const app = new Hono();
  const hub = new HubArtifactService({ db: deps.db, vault: deps.vault, hubUrl: deps.hubUrl, publicKeysJson: deps.publicKeysJson });
  const brain = deps.episodes ? new EpisodicBrainPort(deps.episodes) : undefined;
  const packages = new PackagerService({ db: deps.db, ...(deps.bus ? { bus: deps.bus } : {}), ...(deps.logger ? { logger: deps.logger } : {}), ...(deps.skills ? { skills: deps.skills } : {}), ...(brain ? { brain } : {}) });
  const workspaces = new WorkspacePackager({ db: deps.db, ...(deps.bus ? { bus: deps.bus } : {}), ...(deps.logger ? { logger: deps.logger } : {}), ...(deps.episodes ? { episodes: deps.episodes } : {}) });
  const apps = new AppPackager(deps.db);
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/status', (c) => c.json({ configured: hub.configured(), trust: 'explicit-public-key' }));

  app.post('/preview', async (c) => {
    const ws = getWorkspace(c);
    const body = z.object({ envelope: hubArtifactEnvelopeSchema }).parse(await c.req.json());
    return c.json(hub.preview(ws.workspaceId, body.envelope));
  });

  app.post('/import', async (c) => {
    const ws = getWorkspace(c);
    const body = importSchema.parse(await c.req.json());
    const envelope = hub.verifyEnvelope(body.envelope);
    let native = hub.nativeArtifact(ws.workspaceId, envelope);
    if (!native) {
      if (!body.deviceCode) {
        const activation = await hub.beginActivation(ws.workspaceId, envelope);
        return c.json({ status: 'activation_required', activation }, 202);
      }
      const polled = await hub.pollActivation(ws.workspaceId, envelope, body.deviceCode);
      if (polled.status !== 'approved' || !polled.artifact) return c.json({ status: polled.status }, 202);
      native = polled.artifact;
    }

    const scan = scanArtifactBytes(Buffer.from(JSON.stringify(native), 'utf8'), `agentishub:${envelope.listingId}`);
    const blockers = scan.findings.filter((finding) => finding.severity === 'block');
    if (blockers.length) throw new AgentisError('PACKAGE_IMPORT_INVALID', 'AgentisHub native package was blocked by the local security scan', { details: { findings: blockers } });
    const scope = { workspaceId: ws.workspaceId, ambientId: ws.ambientId, userId: ws.user.id };

    if (envelope.artifactKind === 'app') {
      // Preserve the exact signed native envelope. Re-parsing with a schema here
      // can apply defaults or strip unknown keys before the native checksum is checked.
      const appEnvelope = native as unknown as AppManifestEnvelope;
      const preview = apps.preview(appEnvelope, ws.workspaceId);
      const imported = apps.import(ws.workspaceId, ws.user.id, appEnvelope, { ...(brain ? { brain } : {}) });
      return c.json({ status: 'installed', kind: 'app', ...imported, preview, scanWarnings: scan.findings }, 201);
    }
    if (envelope.artifactKind === 'specialist') {
      const exportEnvelope = packageExportEnvelopeSchema.safeParse(native);
      const manifest = packageManifestSchema.parse(exportEnvelope.success ? exportEnvelope.data.packageManifest : ('packageManifest' in native ? native.packageManifest : native));
      if (manifest.kind !== 'agent') throw new AgentisError('VALIDATION_FAILED', 'AgentisHub specialist payload is not an agent package');
      const imported = packages.importManifest(scope, manifest);
      const installed = packages.usePackage(scope, imported.packageId);
      return c.json({ ...installed, status: 'installed', kind: 'specialist', scanWarnings: scan.findings }, 201);
    }
    const workspaceEnvelope = workspaceBundleEnvelopeSchema.parse(native);
    const preview = workspaces.preview(workspaceEnvelope);
    const installed = workspaces.installBundle(scope, workspaceEnvelope, { permissionsAcknowledged: true });
    return c.json({ status: 'installed', kind: 'workspace', ...installed, preview, scanWarnings: scan.findings }, 201);
  });

  return app;
}
