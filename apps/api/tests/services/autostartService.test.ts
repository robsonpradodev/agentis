/**
 * Autostart service tests — pure target-building plus file round-trips
 * against temp directories (never a real Startup folder / LaunchAgents /
 * autostart location), matching the DI pattern in backup.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildAutostartTarget,
  disableAutostart,
  enableAutostart,
  getAutostartStatus,
  type BuildAutostartTargetOptions,
} from '../../src/services/system/autostartService.js';

function baseOpts(platform: NodeJS.Platform, dirs: { home: string; appData: string; data: string }): BuildAutostartTargetOptions {
  return {
    platform,
    homeDir: dirs.home,
    appDataDir: dirs.appData,
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    scriptPath: join(dirs.home, 'a space dir', 'cli', 'dist', 'index.cjs'),
    dataDir: dirs.data,
    cliVersion: '0.3.1',
  };
}

describe('autostartService', () => {
  let home: string;
  let appData: string;
  let dataDir: string;

  beforeEach(() => {
    // Deliberately include a space in one segment to exercise quoting.
    home = mkdtempSync(join(tmpdir(), 'agentis-autostart-home '));
    appData = join(home, 'AppData', 'Roaming');
    dataDir = mkdtempSync(join(tmpdir(), 'agentis-autostart-data '));
  });

  afterEach(() => {
    for (const d of [home, dataDir]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('is unsupported when no cliVersion is set (running from source)', () => {
    const target = buildAutostartTarget({ ...baseOpts('win32', { home, appData, data: dataDir }), cliVersion: undefined });
    expect(target.supported).toBe(false);
    expect(target.reason).toMatch(/installed Agentis CLI/i);
    expect(getAutostartStatus(target)).toBe(false);
  });

  it('is unsupported on an unknown platform', () => {
    const target = buildAutostartTarget(baseOpts('aix' as NodeJS.Platform, { home, appData, data: dataDir }));
    expect(target.supported).toBe(false);
    expect(target.reason).toMatch(/not supported/i);
  });

  describe('windows', () => {
    it('writes a direct .cmd marker in the Startup folder, quoting space-containing paths', async () => {
      const target = buildAutostartTarget(baseOpts('win32', { home, appData, data: dataDir }));
      expect(target.supported).toBe(true);
      expect(target.markerPath).toBe(join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Agentis.cmd'));
      expect(getAutostartStatus(target)).toBe(false);

      await enableAutostart(target);
      expect(getAutostartStatus(target)).toBe(true);

      expect(existsSync(target.markerPath)).toBe(true);
      const runCmd = readFileSync(target.markerPath, 'utf8');
      expect(runCmd).toContain('"C:\\Program Files\\nodejs\\node.exe"');
      expect(runCmd).toContain(`"${join(home, 'a space dir', 'cli', 'dist', 'index.cjs')}"`);
      expect(runCmd).toContain('up');
      expect(runCmd).toContain('--background');
      expect(runCmd).toContain(`set "AGENTIS_DATA_DIR=${dataDir}"`);

      await disableAutostart(target);
      expect(getAutostartStatus(target)).toBe(false);
      expect(existsSync(target.markerPath)).toBe(false);
    });

    it('removes the legacy VBS launcher when enabling or disabling autostart', async () => {
      const target = buildAutostartTarget(baseOpts('win32', { home, appData, data: dataDir }));
      const legacyVbs = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Agentis.vbs');
      mkdirSync(dirname(legacyVbs), { recursive: true });
      writeFileSync(legacyVbs, 'broken launcher', 'utf8');

      await enableAutostart(target);
      expect(existsSync(legacyVbs)).toBe(false);

      writeFileSync(legacyVbs, 'broken launcher', 'utf8');
      await disableAutostart(target);
      expect(existsSync(legacyVbs)).toBe(false);
    });
  });

  describe('macos', () => {
    it('writes a LaunchAgent plist marker with RunAtLoad', async () => {
      const target = buildAutostartTarget(baseOpts('darwin', { home, appData, data: dataDir }));
      expect(target.markerPath).toBe(join(home, 'Library', 'LaunchAgents', 'com.useagentis.agentis.plist'));

      await enableAutostart(target);
      expect(getAutostartStatus(target)).toBe(true);
      const plist = readFileSync(target.markerPath, 'utf8');
      expect(plist).toContain('<key>RunAtLoad</key>');
      expect(plist).toContain('<true/>');
      expect(plist).toContain('<string>--background</string>');
      expect(plist).toContain('C:\\Program Files\\nodejs\\node.exe');
      expect(plist).toContain('AGENTIS_DATA_DIR');

      await disableAutostart(target);
      expect(getAutostartStatus(target)).toBe(false);
    });
  });

  describe('linux', () => {
    it('writes an XDG autostart .desktop marker', async () => {
      const target = buildAutostartTarget(baseOpts('linux', { home, appData, data: dataDir }));
      expect(target.markerPath).toBe(join(home, '.config', 'autostart', 'agentis.desktop'));

      await enableAutostart(target);
      expect(getAutostartStatus(target)).toBe(true);
      const desktop = readFileSync(target.markerPath, 'utf8');
      expect(desktop).toContain('[Desktop Entry]');
      expect(desktop).toContain('X-GNOME-Autostart-enabled=true');
      expect(desktop).toContain('"C:\\Program Files\\nodejs\\node.exe"');
      expect(desktop).toContain(`"AGENTIS_DATA_DIR=${dataDir}"`);
      expect(desktop).toContain('--background');

      await disableAutostart(target);
      expect(getAutostartStatus(target)).toBe(false);
    });
  });

  it('resolves a relative data directory before writing an unattended launcher', () => {
    const target = buildAutostartTarget({
      ...baseOpts('win32', { home, appData, data: '.agentis' }),
      scriptPath: join(home, 'cli', 'dist', 'index.cjs'),
    });

    expect(target.dataDir).toBe(resolve('.agentis'));
    expect(target.writes[0]?.contents).toContain(`set "AGENTIS_DATA_DIR=${resolve('.agentis')}"`);
  });

  it('reports Windows autostart as unsupported when APPDATA is unavailable', () => {
    const target = buildAutostartTarget({
      ...baseOpts('win32', { home, appData, data: dataDir }),
      appDataDir: undefined,
    });

    expect(target.supported).toBe(false);
    expect(target.reason).toMatch(/APPDATA/i);
  });

  it('enableAutostart throws with the reason when unsupported', async () => {
    const target = buildAutostartTarget({ ...baseOpts('win32', { home, appData, data: dataDir }), cliVersion: undefined });
    await expect(enableAutostart(target)).rejects.toThrow(/installed Agentis CLI/i);
  });

  it('disableAutostart is a no-op when unsupported', async () => {
    const target = buildAutostartTarget({ ...baseOpts('win32', { home, appData, data: dataDir }), cliVersion: undefined });
    await expect(disableAutostart(target)).resolves.toBeUndefined();
  });
});
