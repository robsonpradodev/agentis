import { z } from 'zod';

export const hubArtifactEnvelopeSchema = z.object({
  format: z.literal('.agentishub'),
  formatVersion: z.literal(1),
  listingId: z.string().min(1).max(160),
  versionId: z.string().min(1).max(160),
  artifactKind: z.enum(['app', 'specialist', 'workspace']),
  artifactVersion: z.string().min(1).max(64),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  encryption: z.enum(['none', 'aes-256-gcm']),
  payload: z.string().min(1),
  iv: z.string().optional(),
  authTag: z.string().optional(),
  keyId: z.string().min(1).max(100),
  exportedAt: z.string().datetime(),
  signature: z.string().min(1),
}).superRefine((value, ctx) => {
  if (value.encryption === 'aes-256-gcm' && (!value.iv || !value.authTag)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'encrypted Hub envelopes require iv and authTag' });
  }
});
export type HubArtifactEnvelope = z.infer<typeof hubArtifactEnvelopeSchema>;

export const hubLicenseReceiptSchema = z.object({
  format: z.literal('agentishub-license'),
  version: z.literal(1),
  entitlementId: z.string().min(1),
  listingId: z.string().min(1),
  workspaceFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
  versionPolicy: z.literal('all-future'),
  issuedAt: z.string().datetime(),
  keyId: z.string().min(1),
  signature: z.string().min(1),
});
export type HubLicenseReceipt = z.infer<typeof hubLicenseReceiptSchema>;

/** Canonical JSON shared by the Hub signing and open-source verification sides. */
export function canonicalHubJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalHubJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalHubJson(record[key])}`).join(',')}}`;
}
