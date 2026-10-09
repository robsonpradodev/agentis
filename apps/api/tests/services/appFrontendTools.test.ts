import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentisToolContext } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerAppFrontendTools } from '../../src/services/agentisToolHandlers/appFrontend.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let dataDir: string;

beforeEach(async () => {
  ctx = await createTestContext();
  dataDir = mkdtempSync(path.join(tmpdir(), 'agentis-frontend-tools-'));
});

afterEach(() => {
  ctx.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('managed frontend tools', () => {
  it('cannot redirect a locked App redesign to a different App id', async () => {
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerAppFrontendTools(registry, {
      db: ctx.db,
      bus: ctx.bus,
      logger: ctx.logger,
      dataDir,
    } as ToolHandlerDeps);
    const toolContext: AgentisToolContext = {
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      caller: 'chat',
      viewport: {
        surface: 'app_detail',
        resourceKind: 'app',
        resourceId: 'visible-app',
        appView: { appId: 'visible-app', page: 'home', mode: 'edit', targetLocked: true },
      },
    };

    const result = await registry.execute({
      id: 'frontend-call',
      toolId: 'agentis.app.frontend.apply',
      arguments: {
        appId: 'duplicate-app',
        changes: [{ path: 'src/App.tsx', content: 'export function App() { return null; }' }],
      },
    }, toolContext);

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('VALIDATION_FAILED');
    expect(result.errorMessage).toContain('Frontend target mismatch');
  });

  it('requires a fresh experience contract for redesigns', async () => {
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerAppFrontendTools(registry, {
      db: ctx.db,
      bus: ctx.bus,
      logger: ctx.logger,
      dataDir,
    } as ToolHandlerDeps);
    const result = await registry.execute({
      id: 'frontend-call',
      toolId: 'agentis.app.frontend.apply',
      arguments: {
        appId: 'app-1',
        intent: 'redesign',
        changes: [{
          path: 'src/App.tsx',
          content: 'export function App() { return <button onClick={() => {}}>Open</button>; }',
        }],
      },
    }, {
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      caller: 'chat',
    });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('VALIDATION_FAILED');
    expect(result.errorMessage).toContain('designIntent is required');
  });

  it('persists a distinctive design contract and publishes implemented interactions', async () => {
    ctx.db.insert(schema.apps).values({
      id: 'experience-app',
      workspaceId: ctx.workspace.id,
      slug: 'experience-app',
      name: 'Experience App',
      createdBy: ctx.user.id,
    }).run();
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerAppFrontendTools(registry, {
      db: ctx.db,
      bus: ctx.bus,
      logger: ctx.logger,
      dataDir,
    } as ToolHandlerDeps);
    const toolContext: AgentisToolContext = {
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      caller: 'chat',
      viewport: {
        surface: 'app_detail',
        resourceKind: 'app',
        resourceId: 'experience-app',
        appView: { appId: 'experience-app', mode: 'edit', targetLocked: true },
      },
    };
    const designIntent = {
      direction: 'Playful paper-craft learning studio with tactile layers',
      signature: 'Cards physically fan open as the learner explores a topic',
      layout: 'Asymmetric desktop canvas that becomes a vertical story on mobile',
      typography: 'Rounded display lettering paired with a quiet humanist reading face',
      color: 'Warm parchment, tomato red, ultramarine, and pencil graphite',
      interactions: ['Fan and focus a lesson card', 'Filter the lesson constellation'],
      avoids: ['dark dashboard chrome', 'lime accent and monospace labels'],
    };
    const applied = await registry.execute({
      id: 'frontend-call',
      toolId: 'agentis.app.frontend.apply',
      arguments: {
        intent: 'create',
        designIntent,
        reason: 'Create tactile learning experience',
        changes: [{
          path: 'src/App.tsx',
          content: `import { useState } from 'react';
export function App() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  return <main><button onClick={() => setOpen(value => !value)}>{open ? 'Fold' : 'Explore'}</button><input value={query} onChange={event => setQuery(event.target.value)} aria-label="Filter lessons" /><p>{query}</p></main>;
}`,
        }, {
          path: 'src/styles.css',
          content: '@import "tailwindcss"; body { margin: 0; background: #f4ead7; color: #25211f; }',
        }],
      },
    }, toolContext);

    expect(applied.ok).toBe(true);
    expect(applied.output).toMatchObject({ published: true, intent: 'create', designIntent });

    const inspected = await registry.execute({
      id: 'inspect-call',
      toolId: 'agentis.app.frontend.inspect',
      arguments: { paths: ['agentis.design.json'] },
    }, toolContext);
    expect(inspected.ok).toBe(true);
    expect(inspected.output).toMatchObject({
      designIntent: { version: 1, intent: 'create', ...designIntent },
      runtimeSdk: { global: 'window.agentis' },
    });
  }, 240_000);
});
