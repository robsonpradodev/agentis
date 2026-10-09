/**
 * Autostart service — "launch Agentis automatically when this machine turns
 * on" (optional, off by default). Mirrors the DI shape of `services/backup.ts`:
 * every OS path is passed in explicitly (never resolved via `os.homedir()` /
 * `process.env` inside this module), so the whole thing is unit-testable
 * against temp directories with no real filesystem locations touched.
 *
 * The source of truth for "enabled" is the presence of the OS-level
 * registration file itself (Startup-folder command / LaunchAgent plist / XDG
 * autostart entry) — there is no separate DB flag to drift out of sync with
 * what the OS will actually do at next login.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

export interface AutostartWrite {
  path: string;
  contents: string;
}

export interface AutostartTarget {
  platform: NodeJS.Platform;
  supported: boolean;
  /** Set when `supported` is false — human-readable reason to surface in UI/CLI. */
  reason?: string;
  /** The file whose existence means "autostart is enabled". */
  markerPath: string;
  /** Absolute data directory used by the unattended process. */
  dataDir: string;
  /** All files written on enable (marker plus any helper scripts), in write order. */
  writes: AutostartWrite[];
}

export interface BuildAutostartTargetOptions {
  platform: NodeJS.Platform;
  /** os.homedir() */
  homeDir: string;
  /** process.env.APPDATA — Windows only. */
  appDataDir?: string;
  /** process.execPath */
  execPath: string;
  /** process.argv[1] — the actual entry file this process was launched with. */
  scriptPath: string;
  /** AGENTIS_DATA_DIR */
  dataDir: string;
  /**
   * env.AGENTIS_CLI_VERSION — only set when launched via the installed
   * `@agentis-labs/cli` package. Unset means running from source (`pnpm dev` /
   * tsx), where there is no stable entry point to relaunch at login.
   */
  cliVersion?: string;
}

const SUPPORTED_PLATFORMS: NodeJS.Platform[] = ['win32', 'darwin', 'linux'];

/** Wrap a path in double quotes for embedding in .cmd/.vbs/shell command lines. */
function q(value: string): string {
  return `"${value}"`;
}

function logPath(dataDir: string): string {
  return join(dataDir, 'autostart.log');
}

function buildWindowsTarget(opts: BuildAutostartTargetOptions): Omit<AutostartTarget, 'supported' | 'reason'> {
  const startupDir = join(opts.appDataDir ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  // The Startup folder runs .cmd files directly. Avoid a VBS launcher entirely:
  // it adds a second file reference that can become orphaned and produces WSH
  // error 80070002 at login.
  const markerPath = join(startupDir, 'Agentis.cmd');

  const runCmd = [
    '@echo off',
    `set "AGENTIS_DATA_DIR=${opts.dataDir}"`,
    `${q(opts.execPath)} ${q(opts.scriptPath)} up --background >> ${q(logPath(opts.dataDir))} 2>&1`,
    '',
  ].join('\r\n');

  return {
    platform: 'win32',
    markerPath,
    dataDir: opts.dataDir,
    writes: [{ path: markerPath, contents: runCmd }],
  };
}

function buildMacTarget(opts: BuildAutostartTargetOptions): Omit<AutostartTarget, 'supported' | 'reason'> {
  const markerPath = join(opts.homeDir, 'Library', 'LaunchAgents', 'com.useagentis.agentis.plist');
  const log = logPath(opts.dataDir);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.useagentis.agentis</string>
  <key>ProgramArguments</key>
  <array>
    <string>${opts.execPath}</string>
    <string>${opts.scriptPath}</string>
    <string>up</string>
    <string>--background</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENTIS_DATA_DIR</key>
    <string>${opts.dataDir}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;

  return {
    platform: 'darwin',
    markerPath,
    dataDir: opts.dataDir,
    writes: [{ path: markerPath, contents: plist }],
  };
}

function buildLinuxTarget(opts: BuildAutostartTargetOptions): Omit<AutostartTarget, 'supported' | 'reason'> {
  const markerPath = join(opts.homeDir, '.config', 'autostart', 'agentis.desktop');

  const desktopEntry = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Agentis',
    'Comment=Start Agentis on login',
    `Exec=env ${q(`AGENTIS_DATA_DIR=${opts.dataDir}`)} ${q(opts.execPath)} ${q(opts.scriptPath)} up --background`,
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');

  return {
    platform: 'linux',
    markerPath,
    dataDir: opts.dataDir,
    writes: [{ path: markerPath, contents: desktopEntry }],
  };
}

/** Build the (unwritten) set of OS files that represent "Agentis starts at login" for the current host. */
export function buildAutostartTarget(opts: BuildAutostartTargetOptions): AutostartTarget {
  if (!opts.cliVersion) {
    return {
      platform: opts.platform,
      supported: false,
      reason: 'Only available when running the installed Agentis CLI, not from source.',
      markerPath: '',
      dataDir: resolve(opts.dataDir),
      writes: [],
    };
  }
  if (!SUPPORTED_PLATFORMS.includes(opts.platform)) {
    return {
      platform: opts.platform,
      supported: false,
      reason: `Autostart is not supported on ${opts.platform}.`,
      markerPath: '',
      dataDir: resolve(opts.dataDir),
      writes: [],
    };
  }

  if (opts.platform === 'win32' && !opts.appDataDir) {
    return {
      platform: opts.platform,
      supported: false,
      reason: 'Windows APPDATA is unavailable, so the Startup folder cannot be located.',
      markerPath: '',
      dataDir: resolve(opts.dataDir),
      writes: [],
    };
  }

  if (!opts.scriptPath) {
    return {
      platform: opts.platform,
      supported: false,
      reason: 'The installed Agentis CLI entry point could not be located.',
      markerPath: '',
      dataDir: resolve(opts.dataDir),
      writes: [],
    };
  }

  // Login items never inherit the terminal's working directory. Persist only
  // absolute paths so a default `.agentis` store still resolves to the same
  // database after a reboot/login.
  const normalized = {
    ...opts,
    dataDir: resolve(opts.dataDir),
  };

  const base =
    opts.platform === 'win32' ? buildWindowsTarget(normalized) :
    opts.platform === 'darwin' ? buildMacTarget(normalized) :
    buildLinuxTarget(normalized);

  return { ...base, supported: true };
}

/** Whether autostart is currently registered on this host (marker file exists). */
export function getAutostartStatus(target: AutostartTarget): boolean {
  if (!target.supported) return false;
  return existsSync(target.markerPath);
}

/**
 * Best-effort — refreshing a mac LaunchAgent registration is a nicety, not
 * required for correctness. `spawn` failures (e.g. ENOENT when `launchctl`
 * isn't on PATH, or simply not running on macOS) surface asynchronously via
 * the 'error' event rather than a thrown exception, so they must be handled
 * there too or Node treats them as an unhandled exception.
 */
function tryLaunchctl(args: string[]): void {
  try {
    const child = spawn('launchctl', args, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* ignore — the plist file is the source of truth for the next login. */ });
    child.unref();
  } catch {
    // ignore
  }
}

export async function enableAutostart(target: AutostartTarget): Promise<void> {
  if (!target.supported) throw new Error(target.reason ?? 'Autostart is not supported on this host.');
  // Redirection opens the log before Node starts; ensure its parent exists even
  // when autostart is enabled before the first successful boot.
  mkdirSync(target.dataDir, { recursive: true });
  // Remove registrations made by earlier releases before writing the direct
  // command entry. Otherwise Windows keeps executing the stale VBS file too.
  if (target.platform === 'win32') rmSync(join(dirname(target.markerPath), 'Agentis.vbs'), { force: true });
  for (const write of target.writes) {
    mkdirSync(dirname(write.path), { recursive: true });
    writeFileSync(write.path, write.contents, 'utf8');
  }
  if (target.platform === 'darwin') tryLaunchctl(['load', '-w', target.markerPath]);
}

export async function disableAutostart(target: AutostartTarget): Promise<void> {
  if (!target.supported) return;
  if (target.platform === 'darwin') tryLaunchctl(['unload', '-w', target.markerPath]);
  for (const write of target.writes) {
    rmSync(write.path, { force: true });
  }
  if (target.platform === 'win32') rmSync(join(dirname(target.markerPath), 'Agentis.vbs'), { force: true });
}
