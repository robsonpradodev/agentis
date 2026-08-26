import {
  constants,
  createCipheriv,
  createHash,
  generateKeyPairSync,
  publicEncrypt,
  randomBytes,
  randomUUID,
  sign,
} from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalHubJson, type HubArtifactEnvelope } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { HubArtifactService } from '../../src/services/hub/hubArtifactService.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

const signer = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const publicKeysJson = JSON.stringify({ 'test-v1': signer.publicKey });

function digest(value: Buffer) { return createHash('sha256').update(value).digest('hex'); }
function signedEnvelope(native: Record<string, unknown>, contentKey?: Buffer): HubArtifactEnvelope {
  const artifact = Buffer.from(JSON.stringify(native));
  let payload = artifact;
  let iv: Buffer | undefined;
  let authTag: Buffer | undefined;
  if (contentKey) {
    iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', contentKey, iv);
    payload = Buffer.concat([cipher.update(artifact), cipher.final()]);
    authTag = cipher.getAuthTag();
  }
  const unsigned = {
    format: '.agentishub' as const,
    formatVersion: 1 as const,
    listingId: 'app-01',
    versionId: randomUUID(),
    artifactKind: 'app' as const,
    artifactVersion: '1.0.0',
    artifactSha256: digest(artifact),
    payloadSha256: digest(payload),
    encryption: contentKey ? 'aes-256-gcm' as const : 'none' as const,
    payload: payload.toString('base64'),
    ...(iv && authTag ? { iv: iv.toString('base64'), authTag: authTag.toString('base64') } : {}),
    keyId: 'test-v1',
    exportedAt: new Date().toISOString(),
  };
  return { ...unsigned, signature: sign(null, Buffer.from(canonicalHubJson(unsigned)), signer.privateKey).toString('base64') };
}

describe('HubArtifactService trust boundary', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => { vi.restoreAllMocks(); ctx.close(); });

  it('fails closed without an explicit Hub origin and trust key', () => {
    const service = new HubArtifactService({ db: ctx.db, vault: ctx.vault });
    expect(service.configured()).toBe(false);
    expect(() => service.verifyEnvelope(signedEnvelope({ format: '.agentisapp' }))).toThrow(/disabled/i);
    expect(() => new HubArtifactService({ db: ctx.db, vault: ctx.vault, hubUrl: 'http://hub.example', publicKeysJson })).toThrow(/HTTPS/);
  });

  it('verifies signatures and checksums before decoding native JSON', () => {
    const service = new HubArtifactService({ db: ctx.db, vault: ctx.vault, hubUrl: 'https://hub.example', publicKeysJson });
    const envelope = signedEnvelope({ format: '.agentisapp', marker: 'trusted' });
    expect(service.nativeArtifact(ctx.workspace.id, envelope)).toMatchObject({ marker: 'trusted' });
    expect(() => service.nativeArtifact(ctx.workspace.id, { ...envelope, payload: Buffer.from('tampered').toString('base64') })).toThrow(/signature/i);
  });

  it('stores a vault-encrypted workspace key and reopens paid artifacts offline only in that workspace', async () => {
    const contentKey = randomBytes(32);
    const envelope = signedEnvelope({ format: '.agentisapp', marker: 'paid-and-portable' }, contentKey);
    let publicKey = '';
    let fingerprint = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      if ('workspacePublicKey' in body) {
        publicKey = body.workspacePublicKey;
        fingerprint = body.workspaceFingerprint;
        return new Response(JSON.stringify({ deviceCode: 'device-secret', userCode: 'ABCDE-12345', verificationUri: 'https://hub.example/activate' }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      const wrappedContentKey = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, contentKey).toString('base64');
      const unsignedReceipt = { format: 'agentishub-license', version: 1, entitlementId: randomUUID(), listingId: envelope.listingId, workspaceFingerprint: fingerprint, versionPolicy: 'all-future', issuedAt: new Date().toISOString(), keyId: 'test-v1' };
      const receipt = { ...unsignedReceipt, signature: sign(null, Buffer.from(canonicalHubJson(unsignedReceipt)), signer.privateKey).toString('base64') };
      return new Response(JSON.stringify({ status: 'approved', wrappedContentKey, receipt }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const service = new HubArtifactService({ db: ctx.db, vault: ctx.vault, hubUrl: 'https://hub.example', publicKeysJson });
    await service.beginActivation(ctx.workspace.id, envelope);
    const keyRow = ctx.db.select({ value: schema.workspaceKv.value }).from(schema.workspaceKv).all()[0];
    expect(JSON.stringify(keyRow?.value)).not.toContain('BEGIN PRIVATE KEY');
    const approved = await service.pollActivation(ctx.workspace.id, envelope, 'device-secret');
    expect(approved.artifact).toMatchObject({ marker: 'paid-and-portable' });

    const restarted = new HubArtifactService({ db: ctx.db, vault: ctx.vault, hubUrl: 'https://hub.example', publicKeysJson });
    expect(restarted.nativeArtifact(ctx.workspace.id, envelope)).toMatchObject({ marker: 'paid-and-portable' });
    expect(restarted.nativeArtifact(randomUUID(), envelope)).toBeNull();
  });
});
