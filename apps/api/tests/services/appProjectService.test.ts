import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { AppProjectService } from '../../src/services/appProjectService.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let dataDir: string;
beforeEach(async () => {
  ctx = await createTestContext();
  dataDir = mkdtempSync(path.join(tmpdir(), 'agentis-app-project-'));
});
afterEach(() => {
  ctx.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('AppProjectService', () => {
  it('initializes a managed React Git project and produces a verified frontend artifact', async () => {
    ctx.db
      .insert(schema.apps)
      .values({
        id: 'project-app',
        workspaceId: ctx.workspace.id,
        slug: 'project-app',
        name: 'Project App',
        createdBy: ctx.user.id,
      })
      .run();
    const captured = ctx.captureBus();
    const projects = new AppProjectService({
      db: ctx.db,
      dataDir,
      logger: ctx.logger,
      bus: ctx.bus,
    });
    const project = await projects.initialize(ctx.workspace.id, 'project-app');
    expect(project.repoPath).toContain(path.join('app-projects', 'project-app', 'repo.git'));
    expect(project.headCommit).toMatch(/^[a-f0-9]{40}$/);

    const source = await projects.inspectSource(ctx.workspace.id, 'project-app', ['src/App.tsx', 'src/styles.css']);
    expect(source.files[0]).toMatchObject({ path: 'src/App.tsx' });
    expect(source.files[0]?.content).toContain('export function App');
    const starter = source.files.map((file) => file.content).join('\n');
    expect(starter).toContain('Neutral bootstrap only');
    expect(starter).not.toContain('#d9ff57');
    expect(starter).not.toContain('Georgia');
    expect(starter).not.toContain('className="rail"');

    const applied = await projects.applySource(ctx.workspace.id, 'project-app', [{
      path: 'src/App.tsx',
      content: 'export function App() { return <main data-testid="real-react-ui">Managed React interface</main>; }\n',
    }], 'Replace the product interface');
    expect(applied.unchanged).toBe(false);
    expect(applied.sourceCommit).not.toBe(project.headCommit);

    const build = await projects.build(ctx.workspace.id, 'project-app');
    expect(build.status).toBe('completed');
    expect(build.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(readFileSync(build.sbomPath!, 'utf8'))).toMatchObject({
      format: 'agentis-sbom-v1',
      appId: 'project-app',
    });
    expect(projects.listBuilds(ctx.workspace.id, 'project-app')).toHaveLength(1);
    const staleRepoPath = path.join(
      path.dirname(dataDir),
      'old-checkout',
      'apps',
      'api',
      '.agentis',
      'app-projects',
      'project-app',
      'repo.git',
    );
    const staleArtifactPath = path.join(
      path.dirname(dataDir),
      'old-checkout',
      'apps',
      'api',
      '.agentis',
      'app-artifacts',
      'project-app',
      build.id,
    );
    ctx.db.update(schema.appProjects).set({ repoPath: staleRepoPath }).run();
    ctx.db.update(schema.appBuilds).set({ artifactPath: staleArtifactPath }).run();
    const reopenedProject = projects.get(ctx.workspace.id, 'project-app');
    expect(reopenedProject?.repoPath).toBe(project.repoPath);
    const sourceAfterMove = await projects.inspectSource(ctx.workspace.id, 'project-app', ['src/App.tsx']);
    expect(sourceAfterMove.files[0]?.content).toContain('Managed React interface');
    const frontend = await projects.readLatestFrontendAsset(
      ctx.workspace.id,
      'project-app',
      'index.html',
    );
    expect(new TextDecoder().decode(frontend.bytes)).toContain('<div id="root"></div>');
    const script = await projects.readLatestFrontendAsset(
      ctx.workspace.id,
      'project-app',
      (new TextDecoder().decode(frontend.bytes).match(/src="\.\/(assets\/[^\"]+\.js)"/) ?? [])[1]!,
    );
    expect(new TextDecoder().decode(script.bytes)).toContain('Managed React interface');
    expect(frontend.buildId).toBe(build.id);
    expect(
      captured.events
        .filter((event) => event.envelope.event === REALTIME_EVENTS.APP_UPDATED)
        .map((event) => event.room),
    ).toEqual([
      REALTIME_ROOMS.app('project-app'),
      REALTIME_ROOMS.workspace(ctx.workspace.id),
    ]);
    captured.stop();
    await expect(
      projects.readLatestFrontendAsset(ctx.workspace.id, 'project-app', '../../package.json'),
    ).rejects.toThrow(/escapes its managed root/);
    await expect(projects.applySource(ctx.workspace.id, 'project-app', [{
      path: '../outside.tsx', content: 'nope',
    }])).rejects.toThrow(/outside the editable source tree/);
  }, 240_000);
});
