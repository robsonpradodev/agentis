/**
 * OpenClawAdapter — current-contract tests.
 *
 * The adapter was rewritten from an ad-hoc gateway WebSocket dialect to
 * OpenClaw's official ACP CLI bridge (`openclaw acp`, spawned lazily per turn).
 * The old tests here drove a FakeWebSocket the adapter no longer opens — they
 * asserted a deleted protocol. These tests pin the adapter's STABLE surface
 * (capabilities, lazy connect, clean dispose) without spawning the binary; a
 * full ACP stream test belongs with an AcpClient fake if/when one exists.
 */
import { describe, it, expect, vi } from 'vitest';
import { OpenClawAdapter, openClawCallerManagedDeltas } from '../../src/adapters/OpenClawAdapter.js';
import type { Logger } from '../../src/logger.js';

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

describe('OpenClawAdapter chat', () => {
  it('advertises interactive chat (not task-only)', () => {
    const adapter = new OpenClawAdapter({ agentId: 'agent-1', gatewayUrl: 'wss://gw.test', logger });
    expect(adapter.capabilities().interactiveChat).toBe(true);
  });

  it('keeps native gateway tools while exposing Agentis tools through caller-managed markers', () => {
    const adapter = new OpenClawAdapter({ agentId: 'agent-1', gatewayUrl: 'wss://gw.test', logger });
    const caps = adapter.capabilities();
    expect(caps.toolCalling).toBe(true);
    expect(caps.toolForwarding).toBe('marker_protocol');
    expect(caps.limitations?.[0]).toMatch(/native tools.*ACP.*Agentis platform tools.*marker/i);
  });

  it('converts a buffered ACP marker into an executable Agentis tool call without exposing the marker', () => {
    const deltas = openClawCallerManagedDeltas([
      'Checking the workspace now.',
      'AGENTIS_TOOL_CALL {"name":"agentis.data.query","arguments":{"table":"leads"}}',
    ].join('\n'));
    expect(deltas).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', delta: 'Checking the workspace now.' }),
      expect.objectContaining({ type: 'tool_call', name: 'agentis.data.query', args: { table: 'leads' } }),
    ]));
    expect(JSON.stringify(deltas)).not.toContain('AGENTIS_TOOL_CALL');
  });

  it('connects lazily (no bridge process, no socket) and disposes cleanly', async () => {
    const adapter = new OpenClawAdapter({ agentId: 'agent-1', gatewayUrl: 'wss://gw.test', logger, defaultSessionId: 'sess-1' });
    // The ACP child starts per turn — connect() must be a cheap no-op that
    // never throws and never requires the binary to be installed.
    await expect(adapter.connect()).resolves.toBeUndefined();
    await expect(adapter.disconnect()).resolves.toBeUndefined();
  });

  it('reports unhealthy with a clear error when gatewayUrl is missing', async () => {
    const adapter = new OpenClawAdapter({ agentId: 'agent-1', gatewayUrl: '', logger });
    const health = await adapter.healthCheck();
    expect(health.isHealthy).toBe(false);
    expect(health.error).toMatch(/gatewayUrl/i);
  });
});
