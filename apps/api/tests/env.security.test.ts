import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';

describe('production network guard', () => {
  it('rejects a public bind without a canonical HTTPS URL', () => {
    expect(() => loadEnv({
      NODE_ENV: 'production',
      AGENTIS_HTTP_HOST: '0.0.0.0',
    })).toThrow(/AGENTIS_PUBLIC_URL/);
  });

  it('rejects cleartext public URLs in production', () => {
    expect(() => loadEnv({
      NODE_ENV: 'production',
      AGENTIS_HTTP_HOST: '0.0.0.0',
      AGENTIS_PUBLIC_URL: 'http://agentis.example.com',
    })).toThrow(/https/);
  });

  it('accepts an explicit HTTPS origin behind a reverse proxy', () => {
    expect(loadEnv({
      NODE_ENV: 'production',
      AGENTIS_HTTP_HOST: '0.0.0.0',
      AGENTIS_PUBLIC_URL: 'https://agentis.example.com',
      AGENTIS_ALLOWED_ORIGINS: 'https://agentis.example.com',
    }).AGENTIS_PUBLIC_URL).toBe('https://agentis.example.com');
  });
});
