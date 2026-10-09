import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { AppDefinitionStore } from '@agentis/app';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';

export interface AppProjectRecord {
  appId: string;
  workspaceId: string;
  repoPath: string;
  defaultBranch: string;
  headCommit: string | null;
  framework: string;
  packageManager: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppProjectSourceFile {
  path: string;
  content: string;
}

/** Managed bare Git repositories and reproducible local source builds. */
export class AppProjectService {
  readonly #projectsRoot: string;
  readonly #worktreesRoot: string;
  readonly #artifactsRoot: string;
  readonly #definitions: AppDefinitionStore;

  constructor(private readonly deps: {
    db: AgentisSqliteDb;
    dataDir: string;
    logger: Logger;
    bus?: EventBus;
  }) {
    const dataRoot = path.resolve(deps.dataDir);
    this.#projectsRoot = path.join(dataRoot, 'app-projects');
    this.#worktreesRoot = path.join(dataRoot, 'app-worktrees');
    this.#artifactsRoot = path.join(dataRoot, 'app-artifacts');
    this.#definitions = new AppDefinitionStore(deps.db);
  }

  get(workspaceId: string, appId: string): AppProjectRecord | null {
    const row = this.deps.db
      .select()
      .from(schema.appProjects)
      .where(
        and(eq(schema.appProjects.workspaceId, workspaceId), eq(schema.appProjects.appId, appId)),
      )
      .get();
    return row ? { ...row, repoPath: this.#storedManagedPath(this.#projectsRoot, row.repoPath) } : null;
  }

  async initialize(workspaceId: string, appId: string): Promise<AppProjectRecord> {
    const current = this.get(workspaceId, appId);
    if (current) return current;
    const app = this.deps.db
      .select({ id: schema.apps.id, name: schema.apps.name, slug: schema.apps.slug })
      .from(schema.apps)
      .where(and(eq(schema.apps.workspaceId, workspaceId), eq(schema.apps.id, appId)))
      .get();
    if (!app) throw new AgentisError('RESOURCE_NOT_FOUND', `app ${appId} not found`);

    const repoPath = this.#inside(
      this.#projectsRoot,
      path.join(this.#projectsRoot, safeId(appId), 'repo.git'),
    );
    const bootstrapPath = this.#inside(
      this.#worktreesRoot,
      path.join(this.#worktreesRoot, `bootstrap-${safeId(appId)}-${randomUUID()}`),
    );
    await mkdir(path.dirname(repoPath), { recursive: true });
    await mkdir(bootstrapPath, { recursive: true });
    try {
      await run('git', ['init', '--bare', '--initial-branch=main', repoPath], this.#projectsRoot);
      await run('git', ['init', '--initial-branch=main'], bootstrapPath);
      await writeStarter(bootstrapPath, app.name, app.slug);
      // A real lockfile is part of the source contract. Lifecycle scripts stay
      // disabled while resolving it; execution begins only in the build phase.
      await run(
        'pnpm',
        ['install', '--ignore-workspace', '--lockfile-only', '--ignore-scripts'],
        bootstrapPath,
        120_000,
      );
      await run('git', ['add', '-A'], bootstrapPath);
      await run(
        'git',
        [
          '-c',
          'user.name=Agentis',
          '-c',
          'user.email=agentis@users.noreply.github.com',
          'commit',
          '--no-gpg-sign',
          '-m',
          'Initialize Agentic App project',
        ],
        bootstrapPath,
      );
      await run('git', ['remote', 'add', 'origin', repoPath], bootstrapPath);
      await run('git', ['push', '-u', 'origin', 'main'], bootstrapPath);
      const headCommit = (await run('git', ['rev-parse', 'HEAD'], bootstrapPath)).stdout.trim();
      const now = new Date().toISOString();
      this.deps.db
        .insert(schema.appProjects)
        .values({
          appId,
          workspaceId,
          repoPath,
          defaultBranch: 'main',
          headCommit,
          framework: 'react',
          packageManager: 'pnpm',
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return this.get(workspaceId, appId)!;
    } catch (error) {
      await rm(repoPath, { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally {
      await rm(bootstrapPath, { recursive: true, force: true }).catch(() => {});
    }
  }

  async build(workspaceId: string, appId: string): Promise<typeof schema.appBuilds.$inferSelect> {
    const project = this.get(workspaceId, appId) ?? (await this.initialize(workspaceId, appId));
    const sourceCommit = (
      await run(
        'git',
        ['--git-dir', project.repoPath, 'rev-parse', `refs/heads/${project.defaultBranch}`],
        this.#projectsRoot,
      )
    ).stdout.trim();
    this.deps.db
      .update(schema.appProjects)
      .set({ headCommit: sourceCommit, updatedAt: new Date().toISOString() })
      .where(
        and(eq(schema.appProjects.workspaceId, workspaceId), eq(schema.appProjects.appId, appId)),
      )
      .run();
    const buildId = randomUUID();
    const worktreePath = this.#inside(this.#worktreesRoot, path.join(this.#worktreesRoot, buildId));
    const artifactPath = this.#inside(
      this.#artifactsRoot,
      path.join(this.#artifactsRoot, appId, buildId),
    );
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await mkdir(artifactPath, { recursive: true });
    const now = new Date().toISOString();
    this.deps.db
      .insert(schema.appBuilds)
      .values({
        id: buildId,
        appId,
        workspaceId,
        sourceCommit,
        status: 'running',
        worktreePath,
        artifactPath: null,
        log: '',
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const logs: string[] = [];
    try {
      logs.push(
        (
          await run(
            'git',
            [
              '--git-dir',
              project.repoPath,
              'worktree',
              'add',
              '--detach',
              worktreePath,
              sourceCommit,
            ],
            this.#worktreesRoot,
          )
        ).combined,
      );
      logs.push(
        (
          await run(
            'pnpm',
            ['install', '--ignore-workspace', '--frozen-lockfile', '--ignore-scripts'],
            worktreePath,
            180_000,
          )
        ).combined,
      );
      logs.push(
        (await run('pnpm', ['run', '--ignore-workspace', 'build'], worktreePath, 180_000)).combined,
      );
      const outputDir = this.#definitions.get(workspaceId, appId)?.frontend?.outputDir ?? 'dist';
      const output = this.#inside(worktreePath, path.join(worktreePath, outputDir));
      if (!existsSync(output))
        throw new AgentisError(
          'VALIDATION_FAILED',
          `Declared frontend output directory '${outputDir}' was not produced by the build.`,
        );
      await cp(output, path.join(artifactPath, 'frontend'), { recursive: true, force: false });
      const sha256 = await hashTree(path.join(artifactPath, 'frontend'));
      const packageJson = JSON.parse(
        await readFile(path.join(worktreePath, 'package.json'), 'utf8'),
      ) as { dependencies?: unknown; devDependencies?: unknown };
      const sbomPath = path.join(artifactPath, 'sbom.json');
      await writeFile(
        sbomPath,
        JSON.stringify(
          {
            format: 'agentis-sbom-v1',
            appId,
            buildId,
            sourceCommit,
            dependencies: packageJson.dependencies ?? {},
            devDependencies: packageJson.devDependencies ?? {},
            generatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        'utf8',
      );
      await writeFile(
        path.join(artifactPath, 'provenance.json'),
        JSON.stringify(
          {
            format: 'agentis-build-provenance-v1',
            appId,
            workspaceId,
            buildId,
            sourceCommit,
            artifactSha256: sha256,
            builder: 'agentis-managed-project',
            packageManager: project.packageManager,
            lockfileRequired: true,
            lifecycleScriptsDuringInstall: false,
            generatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        'utf8',
      );
      this.deps.db
        .update(schema.appBuilds)
        .set({
          status: 'completed',
          artifactPath,
          artifactSha256: sha256,
          sbomPath,
          log: bounded(logs.join('\n')),
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.appBuilds.id, buildId))
        .run();
      this.#emitFrontendChanged(workspaceId, appId, buildId, 'completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.db
        .update(schema.appBuilds)
        .set({
          status: 'failed',
          log: bounded([...logs, message].join('\n')),
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.appBuilds.id, buildId))
        .run();
      this.#emitFrontendChanged(workspaceId, appId, buildId, 'failed');
      throw new AgentisError('INTERNAL_ERROR', `App build failed: ${message}`);
    } finally {
      await run(
        'git',
        ['--git-dir', project.repoPath, 'worktree', 'remove', '--force', worktreePath],
        this.#worktreesRoot,
      ).catch(() => {});
      await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
    }
    return this.deps.db
      .select()
      .from(schema.appBuilds)
      .where(eq(schema.appBuilds.id, buildId))
      .get()!;
  }

  /** Read the committed source tree without exposing the managed repository path. */
  async inspectSource(
    workspaceId: string,
    appId: string,
    requestedPaths: string[] = [],
  ): Promise<{ project: AppProjectRecord; files: AppProjectSourceFile[]; truncated: boolean }> {
    const project = this.get(workspaceId, appId) ?? (await this.initialize(workspaceId, appId));
    const ref = `refs/heads/${project.defaultBranch}`;
    const listed = (await run('git', ['--git-dir', project.repoPath, 'ls-tree', '-r', '--name-only', ref], this.#projectsRoot))
      .stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    const requested = requestedPaths.length > 0
      ? requestedPaths.map((item) => safeSourceRelativePath(item))
      : listed.filter((item) => isUsefulSourceFile(item));
    const selected = [...new Set(requested)].filter((item) => listed.includes(item)).slice(0, 80);
    const files: AppProjectSourceFile[] = [];
    let totalChars = 0;
    for (const relative of selected) {
      const content = (await run('git', ['--git-dir', project.repoPath, 'show', `${ref}:${relative}`], this.#projectsRoot)).stdout;
      if (totalChars + content.length > 240_000) break;
      totalChars += content.length;
      files.push({ path: relative, content });
    }
    return { project, files, truncated: files.length < selected.length || selected.length < requested.length };
  }

  /**
   * Apply an agent-authored source revision through an isolated worktree. The
   * candidate must install and build before its commit may advance the App's
   * branch, so a malformed React edit never replaces the last good frontend.
   */
  async applySource(
    workspaceId: string,
    appId: string,
    changes: Array<{ path: string; content: string | null }>,
    message = 'Update Agentic App frontend',
  ): Promise<{ project: AppProjectRecord; sourceCommit: string; unchanged: boolean }> {
    if (changes.length === 0) throw new AgentisError('VALIDATION_FAILED', 'At least one source change is required.');
    if (changes.length > 120) throw new AgentisError('VALIDATION_FAILED', 'A source revision may change at most 120 files.');
    const totalChars = changes.reduce((sum, item) => sum + (item.content?.length ?? 0), 0);
    if (totalChars > 1_500_000) throw new AgentisError('VALIDATION_FAILED', 'Source revision exceeds the 1.5 MB limit.');
    const project = this.get(workspaceId, appId) ?? (await this.initialize(workspaceId, appId));
    const sourceCommit = (await run(
      'git', ['--git-dir', project.repoPath, 'rev-parse', `refs/heads/${project.defaultBranch}`], this.#projectsRoot,
    )).stdout.trim();
    const worktreePath = this.#inside(this.#worktreesRoot, path.join(this.#worktreesRoot, `author-${randomUUID()}`));
    await mkdir(path.dirname(worktreePath), { recursive: true });
    try {
      await run('git', ['--git-dir', project.repoPath, 'worktree', 'add', '--detach', worktreePath, sourceCommit], this.#worktreesRoot);
      let packageChanged = false;
      for (const change of changes) {
        const relative = safeSourceRelativePath(change.path);
        const target = this.#inside(worktreePath, path.join(worktreePath, ...relative.split('/')));
        if (change.content == null) {
          await rm(target, { force: true });
        } else {
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, change.content, 'utf8');
        }
        if (relative === 'package.json') packageChanged = true;
      }
      if (packageChanged) {
        await run('pnpm', ['install', '--ignore-workspace', '--lockfile-only', '--ignore-scripts'], worktreePath, 180_000);
      }
      await run('pnpm', ['install', '--ignore-workspace', '--frozen-lockfile', '--ignore-scripts'], worktreePath, 180_000);
      await run('pnpm', ['run', '--ignore-workspace', 'build'], worktreePath, 180_000);
      await run('git', ['add', '-A'], worktreePath);
      const status = (await run('git', ['status', '--porcelain'], worktreePath)).stdout.trim();
      if (!status) return { project, sourceCommit, unchanged: true };
      await run('git', [
        '-c', 'user.name=Agentis',
        '-c', 'user.email=agentis@users.noreply.github.com',
        'commit', '--no-gpg-sign', '-m', cleanCommitMessage(message),
      ], worktreePath);
      const nextCommit = (await run('git', ['rev-parse', 'HEAD'], worktreePath)).stdout.trim();
      await run('git', ['push', project.repoPath, `HEAD:refs/heads/${project.defaultBranch}`], worktreePath, 60_000);
      this.deps.db.update(schema.appProjects).set({
        headCommit: nextCommit,
        updatedAt: new Date().toISOString(),
      }).where(and(
        eq(schema.appProjects.workspaceId, workspaceId),
        eq(schema.appProjects.appId, appId),
      )).run();
      return { project: this.get(workspaceId, appId)!, sourceCommit: nextCommit, unchanged: false };
    } catch (error) {
      if (error instanceof AgentisError) throw error;
      throw new AgentisError('VALIDATION_FAILED', `Frontend source was not published: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await run('git', ['--git-dir', project.repoPath, 'worktree', 'remove', '--force', worktreePath], this.#worktreesRoot).catch(() => {});
      await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
    }
  }

  listBuilds(workspaceId: string, appId: string, limit = 20) {
    return this.deps.db
      .select()
      .from(schema.appBuilds)
      .where(and(eq(schema.appBuilds.workspaceId, workspaceId), eq(schema.appBuilds.appId, appId)))
      .orderBy(desc(schema.appBuilds.createdAt))
      .limit(Math.max(1, Math.min(100, limit)))
      .all();
  }

  /** Read one file from the newest completed frontend build.
   *
   * The caller never receives a filesystem path. Both the persisted artifact
   * root and requested relative path are confined beneath the managed artifact
   * directory before any read, so this is safe to expose through an authenticated
   * HTTP route.
   */
  async readLatestFrontendAsset(
    workspaceId: string,
    appId: string,
    requestedPath: string,
  ): Promise<{ bytes: Uint8Array; buildId: string; artifactSha256: string | null }> {
    const build = this.deps.db
      .select()
      .from(schema.appBuilds)
      .where(
        and(
          eq(schema.appBuilds.workspaceId, workspaceId),
          eq(schema.appBuilds.appId, appId),
          eq(schema.appBuilds.status, 'completed'),
        ),
      )
      .orderBy(desc(schema.appBuilds.completedAt))
      .get();
    if (!build?.artifactPath) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `app ${appId} has no completed frontend build`);
    }

    // App data may survive a repository rename or move. Persisted absolute paths
    // then point at the old checkout, even though the managed artifact remains
    // under the current data directory. Rebase only the managed-root suffix;
    // the final path is still confined by #inside.
    const artifactRoot = this.#storedManagedPath(this.#artifactsRoot, build.artifactPath);
    const frontendRoot = this.#inside(artifactRoot, path.join(artifactRoot, 'frontend'));
    const relative = decodeURIComponent(requestedPath).replace(/^[/\\]+/, '') || 'index.html';
    const filePath = this.#inside(frontendRoot, path.join(frontendRoot, relative));
    try {
      return {
        bytes: await readFile(filePath),
        buildId: build.id,
        artifactSha256: build.artifactSha256,
      };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      if (code === 'ENOENT' || code === 'EISDIR') {
        throw new AgentisError('RESOURCE_NOT_FOUND', `frontend asset not found: ${relative}`);
      }
      throw error;
    }
  }

  #inside(root: string, candidate: string): string {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(candidate);
    if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`))
      throw new AgentisError(
        'VALIDATION_FAILED',
        'Resolved App project path escapes its managed root.',
      );
    return resolved;
  }

  #storedManagedPath(root: string, candidate: string): string {
    const resolvedRoot = path.resolve(root);
    const resolvedCandidate = path.resolve(candidate);
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      return resolvedCandidate;
    }

    const marker = `${path.sep}${path.basename(resolvedRoot)}${path.sep}`;
    const markerAt = resolvedCandidate.lastIndexOf(marker);
    if (markerAt < 0) {
      return this.#inside(root, resolvedCandidate);
    }
    const managedSuffix = resolvedCandidate.slice(markerAt + marker.length);
    return this.#inside(root, path.join(resolvedRoot, managedSuffix));
  }

  #emitFrontendChanged(
    workspaceId: string,
    appId: string,
    buildId: string,
    status: 'completed' | 'failed',
  ): void {
    const payload = { appId, buildId, status, op: 'frontend_build' };
    this.deps.bus?.publish(REALTIME_ROOMS.app(appId), REALTIME_EVENTS.APP_UPDATED, payload);
    this.deps.bus?.publish(
      REALTIME_ROOMS.workspace(workspaceId),
      REALTIME_EVENTS.APP_UPDATED,
      payload,
    );
  }
}

async function writeStarter(root: string, name: string, slug: string): Promise<void> {
  const files: Record<string, string> = {
    'package.json': JSON.stringify(
      {
        name: `agentis-app-${slug}`,
        version: '0.1.0',
        private: true,
        type: 'module',
        scripts: { build: 'vite build', dev: 'vite' },
        dependencies: {
          '@vitejs/plugin-react': '^4.3.4',
          vite: '^6.0.7',
          typescript: '^5.7.2',
          react: '^19.0.0',
          'react-dom': '^19.0.0',
          tailwindcss: '^4.0.0',
          '@tailwindcss/vite': '^4.0.0',
        },
        devDependencies: {},
      },
      null,
      2,
    ),
    'index.html':
      '<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>' +
      escapeHtml(name) +
      '</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          useDefineForClassFields: true,
          lib: ['ES2022', 'DOM'],
          module: 'ESNext',
          skipLibCheck: true,
          moduleResolution: 'Bundler',
          allowImportingTsExtensions: true,
          isolatedModules: true,
          moduleDetection: 'force',
          noEmit: true,
          jsx: 'react-jsx',
          strict: true,
        },
        include: ['src'],
      },
      null,
      2,
    ),
    'vite.config.ts':
      "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nimport tailwindcss from '@tailwindcss/vite';\nexport default defineConfig({ base: './', plugins: [react(), tailwindcss()], build: { sourcemap: true } });\n",
    'src/main.tsx':
      "import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport { App } from './App';\nimport './styles.css';\ncreateRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);\n",
    'src/App.tsx': starterApp(name),
    'src/styles.css': starterStyles(),
    'agentis.app.json': JSON.stringify(
      {
        manifestVersion: 3,
        identity: { slug, name, version: '0.1.0' },
        contract: { operations: [] },
        frontend: {
          framework: 'react',
          entry: 'src/main.tsx',
          outputDir: 'dist',
          styling: 'tailwind',
        },
      },
      null,
      2,
    ),
    '.gitignore': 'node_modules\ndist\n.env*\n!.env.example\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

function starterApp(name: string): string {
  return `/**
 * Neutral bootstrap only — this is deliberately not a design system.
 * Replace the complete component and stylesheet with a product-specific visual
 * language, information architecture, and interaction model before publishing.
 */
export function App() {
  return <main data-agentis-neutral-bootstrap>
    <h1>${escapeJsx(name)}</h1>
    <p>This neutral canvas is ready for its own design direction and interactions.</p>
  </main>;
}
`;
}

function starterStyles(): string {
  return `@import "tailwindcss";
*{box-sizing:border-box}html,body,#root{min-height:100%}body{margin:0}button,input,select,textarea{font:inherit}[data-agentis-neutral-bootstrap]{min-height:100vh;display:grid;place-content:center;gap:12px;padding:32px;font-family:system-ui,sans-serif;text-align:center}[data-agentis-neutral-bootstrap] h1,[data-agentis-neutral-bootstrap] p{margin:0}[data-agentis-neutral-bootstrap] p{max-width:44ch;color:#666}`;
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; combined: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const windowsPnpm =
      process.platform === 'win32' && command === 'pnpm' && process.env.APPDATA
        ? path.join(process.env.APPDATA, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
        : null;
    const executable = windowsPnpm && existsSync(windowsPnpm) ? process.execPath : command;
    const spawnArgs = windowsPnpm && existsSync(windowsPnpm) ? [windowsPnpm, ...args] : args;
    const child = spawn(executable, spawnArgs, { cwd, windowsHide: true, shell: false });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr, combined: `${stdout}\n${stderr}`.trim() });
      else
        reject(
          new Error(`${command} ${args.join(' ')} failed (${code}): ${bounded(stderr || stdout)}`),
        );
    });
  });
}

async function hashTree(root: string): Promise<string> {
  const { readdir, stat } = await import('node:fs/promises');
  const hash = createHash('sha256');
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory);
    for (const entry of entries.sort()) {
      const target = path.join(directory, entry);
      const info = await stat(target);
      if (info.isDirectory()) await visit(target);
      else {
        hash.update(path.relative(root, target).replaceAll('\\', '/'));
        hash.update(await readFile(target));
      }
    }
  }
  await visit(root);
  return hash.digest('hex');
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

function safeSourceRelativePath(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new AgentisError('VALIDATION_FAILED', `Invalid frontend source path: ${value}`);
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')
    || ['.git', 'node_modules', 'dist'].includes(segments[0]!)) {
    throw new AgentisError('VALIDATION_FAILED', `Frontend source path is outside the editable source tree: ${value}`);
  }
  return segments.join('/');
}

function isUsefulSourceFile(relative: string): boolean {
  return !relative.startsWith('pnpm-lock.yaml')
    && /(?:^|\/)(?:[^/]+\.(?:tsx?|jsx?|css|html|json|md)|vite\.config\.ts)$/.test(relative);
}

function cleanCommitMessage(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim().slice(0, 160) || 'Update Agentic App frontend';
}
function bounded(value: string): string {
  return value.length > 40_000 ? `${value.slice(0, 40_000)}\n…truncated` : value;
}
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
}
function escapeJsx(value: string): string {
  return value
    .replace(/[{}<>]/g, '')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');
}
