import {
  constants,
  createDecipheriv,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  randomUUID,
  verify,
} from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  AgentisError,
  canonicalHubJson,
  hubArtifactEnvelopeSchema,
  hubLicenseReceiptSchema,
  type HubArtifactEnvelope,
  type HubLicenseReceipt,
} from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { CredentialVault } from '../credentialVault.js';

const KEY_STORE = 'agentishub.workspace-key.v1';
const LICENSE_PREFIX = 'agentishub.license.';
const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;

type WorkspaceKey = { publicKeyPem: string; privateKeyEncrypted: string; fingerprint: string };
type LocalLicense = { receipt: HubLicenseReceipt; wrappedContentKey: string };

export class HubArtifactService {
  readonly #publicKeys: Map<string, string>;
  readonly #hubUrl: URL | null;

  constructor(private readonly deps: { db: AgentisSqliteDb; vault: CredentialVault; hubUrl?: string; publicKeysJson?: string }) {
    this.#hubUrl = deps.hubUrl ? trustedHubUrl(deps.hubUrl) : null;
    this.#publicKeys = parsePublicKeys(deps.publicKeysJson);
  }

  configured() { return Boolean(this.#hubUrl && this.#publicKeys.size > 0); }

  verifyEnvelope(input: unknown): HubArtifactEnvelope {
    this.assertConfigured();
    const envelope = hubArtifactEnvelopeSchema.parse(input);
    const publicPem = this.#publicKeys.get(envelope.keyId);
    if (!publicPem) throw new AgentisError('VALIDATION_FAILED', `AgentisHub signing key ${envelope.keyId} is not trusted by this installation`);
    const { signature, ...unsigned } = envelope;
    const ok = verify(null, Buffer.from(canonicalHubJson(unsigned)), createPublicKey(publicPem), Buffer.from(signature, 'base64'));
    if (!ok) throw new AgentisError('VALIDATION_FAILED', 'AgentisHub envelope signature verification failed');
    const payload = strictBase64(envelope.payload, 'payload');
    if (payload.length > MAX_PAYLOAD_BYTES + 16) throw new AgentisError('VALIDATION_FAILED', 'AgentisHub payload exceeds the 25 MB local import limit');
    if (sha256(payload) !== envelope.payloadSha256.toLowerCase()) throw new AgentisError('VALIDATION_FAILED', 'AgentisHub payload checksum mismatch');
    return envelope;
  }

  preview(workspaceId: string, input: unknown) {
    const envelope = this.verifyEnvelope(input);
    return {
      format: envelope.format,
      listingId: envelope.listingId,
      versionId: envelope.versionId,
      artifactKind: envelope.artifactKind,
      artifactVersion: envelope.artifactVersion,
      encrypted: envelope.encryption !== 'none',
      activationRequired: envelope.encryption !== 'none' && !this.readLicense(workspaceId, envelope.listingId, envelope.keyId),
      signerKeyId: envelope.keyId,
      artifactSha256: envelope.artifactSha256,
    };
  }

  async beginActivation(workspaceId: string, envelope: HubArtifactEnvelope) {
    this.assertConfigured();
    const key = this.workspaceKey(workspaceId);
    return this.hubRequest('/api/activation/start', {
      listingId: envelope.listingId,
      versionId: envelope.versionId,
      workspaceFingerprint: key.fingerprint,
      workspacePublicKey: key.publicKeyPem,
    });
  }

  async pollActivation(workspaceId: string, envelope: HubArtifactEnvelope, deviceCode: string): Promise<{ status: string; artifact?: Record<string, unknown> }> {
    const response = await this.hubRequest('/api/activation/poll', { deviceCode }, true);
    if (response.status !== 'approved') return { status: String(response.status ?? 'pending') };
    const receipt = hubLicenseReceiptSchema.parse(response.receipt);
    const wrappedContentKey = requiredResponseString(response, 'wrappedContentKey');
    this.verifyReceipt(receipt, workspaceId, envelope);
    this.writeLicense(workspaceId, envelope.listingId, { receipt, wrappedContentKey });
    const artifact = this.decryptNative(workspaceId, envelope);
    if (!artifact) throw new AgentisError('PACKAGE_IMPORT_INVALID', 'AgentisHub activation did not produce a decryptable artifact');
    return { status: 'approved', artifact };
  }

  nativeArtifact(workspaceId: string, input: unknown): Record<string, unknown> | null {
    const envelope = this.verifyEnvelope(input);
    if (envelope.encryption === 'none') return this.decodeNative(envelope, strictBase64(envelope.payload, 'payload'));
    return this.decryptNative(workspaceId, envelope);
  }

  private decryptNative(workspaceId: string, envelope: HubArtifactEnvelope): Record<string, unknown> | null {
    const license = this.readLicense(workspaceId, envelope.listingId, envelope.keyId);
    if (!license) return null;
    this.verifyReceipt(license.receipt, workspaceId, envelope);
    const key = this.workspaceKey(workspaceId);
    const privatePem = this.deps.vault.decrypt(key.privateKeyEncrypted);
    let contentKey: Buffer;
    try {
      contentKey = privateDecrypt({ key: privatePem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, strictBase64(license.wrappedContentKey, 'wrappedContentKey'));
    } catch {
      throw new AgentisError('VALIDATION_FAILED', 'AgentisHub content key cannot be opened by this workspace');
    }
    if (contentKey.length !== 32) throw new AgentisError('VALIDATION_FAILED', 'AgentisHub returned an invalid content key');
    const iv = strictBase64(envelope.iv!, 'iv');
    const tag = strictBase64(envelope.authTag!, 'authTag');
    if (iv.length !== 12 || tag.length !== 16) throw new AgentisError('VALIDATION_FAILED', 'AgentisHub encryption parameters are invalid');
    try {
      const decipher = createDecipheriv('aes-256-gcm', contentKey, iv);
      decipher.setAuthTag(tag);
      const native = Buffer.concat([decipher.update(strictBase64(envelope.payload, 'payload')), decipher.final()]);
      return this.decodeNative(envelope, native);
    } catch {
      throw new AgentisError('VALIDATION_FAILED', 'AgentisHub artifact decryption failed; the payload may have been tampered with');
    }
  }

  private decodeNative(envelope: HubArtifactEnvelope, bytes: Buffer): Record<string, unknown> {
    if (sha256(bytes) !== envelope.artifactSha256.toLowerCase()) throw new AgentisError('VALIDATION_FAILED', 'Decrypted Agentis package checksum mismatch');
    try {
      const value = JSON.parse(bytes.toString('utf8')) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      return value as Record<string, unknown>;
    } catch {
      throw new AgentisError('VALIDATION_FAILED', 'Decrypted AgentisHub payload is not a valid native package');
    }
  }

  private workspaceKey(workspaceId: string): WorkspaceKey {
    const existing = this.deps.db.select({ value: schema.workspaceKv.value }).from(schema.workspaceKv)
      .where(and(eq(schema.workspaceKv.workspaceId, workspaceId), eq(schema.workspaceKv.key, KEY_STORE))).get();
    if (isWorkspaceKey(existing?.value)) return existing.value;
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 3072,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const value: WorkspaceKey = {
      publicKeyPem: pair.publicKey,
      privateKeyEncrypted: this.deps.vault.encrypt(pair.privateKey),
      fingerprint: sha256(Buffer.from(pair.publicKey)),
    };
    const now = new Date().toISOString();
    this.deps.db.insert(schema.workspaceKv).values({ id: randomUUID(), workspaceId, key: KEY_STORE, value, version: 1, createdAt: now, updatedAt: now }).run();
    return value;
  }

  private readLicense(workspaceId: string, listingId: string, keyId: string): LocalLicense | null {
    const rows = this.deps.db.select({ value: schema.workspaceKv.value }).from(schema.workspaceKv)
      .where(and(eq(schema.workspaceKv.workspaceId, workspaceId), eq(schema.workspaceKv.key, `${LICENSE_PREFIX}${listingId}`))).all();
    for (const row of rows) {
      if (isLocalLicense(row.value) && row.value.receipt.keyId === keyId) return row.value;
    }
    return null;
  }

  private writeLicense(workspaceId: string, listingId: string, value: LocalLicense) {
    const key = `${LICENSE_PREFIX}${listingId}`;
    const now = new Date().toISOString();
    const existing = this.deps.db.select({ id: schema.workspaceKv.id }).from(schema.workspaceKv).where(and(eq(schema.workspaceKv.workspaceId, workspaceId), eq(schema.workspaceKv.key, key))).get();
    if (existing) this.deps.db.update(schema.workspaceKv).set({ value, updatedAt: now }).where(eq(schema.workspaceKv.id, existing.id)).run();
    else this.deps.db.insert(schema.workspaceKv).values({ id: randomUUID(), workspaceId, key, value, version: 1, createdAt: now, updatedAt: now }).run();
  }

  private verifyReceipt(receipt: HubLicenseReceipt, workspaceId: string, envelope: HubArtifactEnvelope) {
    const publicPem = this.#publicKeys.get(receipt.keyId);
    if (!publicPem) throw new AgentisError('VALIDATION_FAILED', `AgentisHub receipt key ${receipt.keyId} is not trusted`);
    const { signature, ...unsigned } = receipt;
    if (!verify(null, Buffer.from(canonicalHubJson(unsigned)), createPublicKey(publicPem), Buffer.from(signature, 'base64'))) throw new AgentisError('VALIDATION_FAILED', 'AgentisHub license receipt signature failed');
    const key = this.workspaceKey(workspaceId);
    if (receipt.listingId !== envelope.listingId || receipt.workspaceFingerprint !== key.fingerprint) throw new AgentisError('VALIDATION_FAILED', 'AgentisHub license receipt is not valid for this package and workspace');
  }

  private assertConfigured() {
    if (!this.configured()) throw new AgentisError('VALIDATION_FAILED', 'AgentisHub import is disabled. Configure AGENTIS_HUB_URL and AGENTIS_HUB_PUBLIC_KEYS to establish trust explicitly.');
  }

  private async hubRequest(path: string, body: Record<string, unknown>, allowNon200 = false): Promise<Record<string, unknown>> {
    this.assertConfigured();
    const url = new URL(path, this.#hubUrl!);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(url, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
      const json = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok && !(allowNon200 && [202, 403, 410].includes(response.status))) throw new AgentisError('VALIDATION_FAILED', typeof json.error === 'string' ? json.error : `AgentisHub returned HTTP ${response.status}`);
      return json;
    } finally { clearTimeout(timer); }
  }
}

function parsePublicKeys(value?: string): Map<string, string> {
  if (!value) return new Map();
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return new Map(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].includes('BEGIN PUBLIC KEY')).map(([id, pem]) => [id, pem.replace(/\\n/g, '\n')]));
  } catch { throw new Error('AGENTIS_HUB_PUBLIC_KEYS must be a JSON object mapping key ids to SPKI PEM public keys'); }
}

function trustedHubUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('AGENTIS_HUB_URL must be a clean origin URL');
  const local = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('AGENTIS_HUB_URL must use HTTPS (HTTP is allowed only for loopback development)');
  url.pathname = '/';
  return url;
}

function strictBase64(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new AgentisError('VALIDATION_FAILED', `AgentisHub ${label} is not canonical base64`);
  return Buffer.from(value, 'base64');
}
function sha256(value: Buffer) { return createHash('sha256').update(value).digest('hex'); }
function isWorkspaceKey(value: unknown): value is WorkspaceKey { return Boolean(value && typeof value === 'object' && typeof (value as WorkspaceKey).publicKeyPem === 'string' && typeof (value as WorkspaceKey).privateKeyEncrypted === 'string' && /^[a-f0-9]{64}$/.test((value as WorkspaceKey).fingerprint)); }
function isLocalLicense(value: unknown): value is LocalLicense { return Boolean(value && typeof value === 'object' && typeof (value as LocalLicense).wrappedContentKey === 'string' && (value as LocalLicense).receipt?.format === 'agentishub-license'); }
function requiredResponseString(value: Record<string, unknown>, key: string) { if (typeof value[key] !== 'string') throw new AgentisError('VALIDATION_FAILED', `AgentisHub response omitted ${key}`); return value[key] as string; }
