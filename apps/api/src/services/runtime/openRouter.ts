import { and, eq } from 'drizzle-orm';
import { AgentisError } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { CredentialVault } from '../credentialVault.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_TIMEOUT_MS = 75_000;
export interface OpenRouterModel {
  id: string; label: string; contextLength: number; free: boolean;
  pricing: { prompt: string; completion: string }; supportsTools: boolean;
}
let catalog: { expiresAt: number; models: OpenRouterModel[] } | undefined;
export function clearOpenRouterCatalogCache(): void { catalog = undefined; }

export async function openRouterModels(signal?: AbortSignal): Promise<OpenRouterModel[]> {
  if (catalog && catalog.expiresAt > Date.now()) return catalog.models;
  const deadline = AbortSignal.timeout(10_000);
  const response = await fetch(`${OPENROUTER_BASE_URL}/models`, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  if (!response.ok) throw new AgentisError('ADAPTER_UNAVAILABLE', 'OpenRouter model catalog is unavailable. Try again.');
  const json = await response.json() as { data?: Array<Record<string, any>> };
  const models = (json.data ?? []).filter((row) => typeof row.id === 'string').map((row) => ({
    id: row.id as string, label: String(row.name ?? row.id), contextLength: Number(row.context_length ?? 0),
    pricing: { prompt: String(row.pricing?.prompt ?? ''), completion: String(row.pricing?.completion ?? '') },
    free: Number(row.pricing?.prompt) === 0 && Number(row.pricing?.completion) === 0,
    supportsTools: Array.isArray(row.supported_parameters) && row.supported_parameters.includes('tools'),
  }));
  catalog = { expiresAt: Date.now() + 600_000, models };
  return models;
}

export async function requireOpenRouterToolModel(id: string, signal?: AbortSignal): Promise<OpenRouterModel> {
  const model = (await openRouterModels(signal)).find((row) => row.id === id);
  if (!model?.supportsTools) throw new AgentisError('VALIDATION_FAILED', 'Choose an OpenRouter model with declared tool support.');
  return model;
}

export function openRouterCredential(db: AgentisSqliteDb, vault: CredentialVault, workspaceId: string, id: unknown): string {
  if (typeof id !== 'string' || !id.trim()) throw new AgentisError('VALIDATION_FAILED', 'Save an OpenRouter API key first.');
  const row = db.select().from(schema.credentials).where(and(eq(schema.credentials.id, id), eq(schema.credentials.workspaceId, workspaceId))).get();
  if (!row || row.credentialType !== 'openrouter_api_key') throw new AgentisError('VALIDATION_FAILED', 'OpenRouter credential is unavailable in this workspace.');
  return vault.decrypt(row.encryptedValue);
}

export async function validateOpenRouterConfig(db: AgentisSqliteDb, vault: CredentialVault, workspaceId: string, config: Record<string, unknown>): Promise<void> {
  if (['apiKey', 'key', 'headers', 'authorization', 'baseUrl', 'endpoint', 'url'].some((key) => key in config)) throw new AgentisError('VALIDATION_FAILED', 'OpenRouter accepts a saved credential reference, not raw keys or HTTP configuration.');
  openRouterCredential(db, vault, workspaceId, config.authCredentialId);
  if (config.timeoutMs !== undefined && (typeof config.timeoutMs !== 'number' || !Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0)) throw new AgentisError('VALIDATION_FAILED', 'OpenRouter timeout must be a positive number of milliseconds.');
  await requireOpenRouterToolModel(typeof config.model === 'string' ? config.model : '');
}

export function openRouterError(status: number): string {
  const reason: Record<number, string> = {
    401: 'API key is invalid or revoked.', 402: 'Insufficient credits for this model.',
    403: 'This key cannot access the requested model.', 404: 'The selected model has no available endpoint.',
    429: 'Rate limit reached. Try again later.', 502: 'The model provider is temporarily unavailable.',
    503: 'No compatible provider is currently available.',
  };
  return `OpenRouter (${status}): ${reason[status] ?? 'The provider could not complete this request.'}`;
}

export async function testOpenRouter(key: string, modelId: string) {
  const checks: Array<{ code: string; level: 'info' | 'error'; message: string }> = [];
  try {
    const response = await fetch(`${OPENROUTER_BASE_URL}/key`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(openRouterError(response.status));
    checks.push({ code: 'auth', level: 'info', message: 'OpenRouter API key accepted.' });
    if (!modelId) throw new Error('Select a model with tool support.');
    await requireOpenRouterToolModel(modelId);
    checks.push({ code: 'tools', level: 'info', message: 'Selected model supports tools. No generation was billed.' });
    return { status: 'pass' as const, checks };
  } catch (error) {
    checks.push({ code: 'connection', level: 'error', message: error instanceof Error && error.name === 'TimeoutError' ? 'OpenRouter connection timed out.' : String((error as Error).message).replaceAll(key, '[redacted]') });
    return { status: 'fail' as const, checks };
  }
}
