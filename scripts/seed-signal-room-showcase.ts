import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { AppDefinitionStore, AppStore } from '../packages/app/src/index.js';
import { openSqlite, schema } from '../packages/db/src/sqlite/index.js';
import type { WorkflowEngine } from '../apps/api/src/engine/WorkflowEngine.js';
import { createLogger } from '../apps/api/src/logger.js';
import { AgentMissionService } from '../apps/api/src/services/agentMissions.js';
import { AppOperationRuntime } from '../apps/api/src/services/appOperationRuntime.js';
import { AppProjectService } from '../apps/api/src/services/appProjectService.js';
import { ExtensionRuntime } from '../apps/api/src/services/extensionRuntime.js';

async function main(): Promise<void> {
  const workspaceName = 'Project 3gT7';
  const appSlug = 'signal-room';
  const extensionSlug = 'signal-room-runtime';
  const dataDir = path.resolve('apps/api/.agentis');
  const { db, sqlite } = openSqlite({ path: path.join(dataDir, 'data.db') });
  const logger = createLogger({ level: 'warn', pretty: true });

  try {
    const workspace = db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.name, workspaceName))
      .get();
    if (!workspace) throw new Error(`Workspace '${workspaceName}' was not found.`);

    const agents = db
      .select({ id: schema.agents.id, name: schema.agents.name })
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, workspace.id))
      .all();
    const agentId = (name: string) => {
      const agent = agents.find((candidate) => candidate.name === name);
      if (!agent) throw new Error(`Required showcase agent '${name}' was not found.`);
      return agent.id;
    };
    const contentAgentId = agentId('Content Specialist');
    const platformAgentId = agentId('Platform Specialist');
    const orchestrationAgentId = agentId('Orchy');

    const apps = new AppStore(db);
    const existing = apps.getBySlug(workspace.id, appSlug);
    const app =
      existing ??
      apps.create(workspace.id, workspace.userId, {
        name: 'Signal Room',
        slug: appSlug,
        description:
          'An agent-native production room for turning a product truth into a launch-ready demo film.',
        icon: 'aperture',
        ownerAgentId: contentAgentId,
      });
    apps.update(workspace.id, app.id, {
      name: 'Signal Room',
      description:
        'An agent-native production room for turning a product truth into a launch-ready demo film.',
      ownerAgentId: contentAgentId,
    });
    apps.addMember(workspace.id, app.id, contentAgentId, 'operator');
    apps.addMember(workspace.id, app.id, platformAgentId, 'worker');
    apps.addMember(workspace.id, app.id, orchestrationAgentId, 'worker');

    const extensionSource = `
function words(value) {
  return String(value || '').trim().split(/\\s+/).filter(Boolean);
}

export async function analyzeBrief(input) {
  const product = String(input.product || 'Agentis');
  const audience = String(input.audience || 'agent builders');
  const tension = String(input.tension || 'powerful agents are trapped inside human-first software');
  return {
    northStar: product + ' should feel like a new category, not another dashboard.',
    audience,
    tension,
    proofPoints: [
      'one semantic operation contract across UI, REST, MCP and A2A',
      'durable tasks that survive disconnects and request human input',
      'authority-bound effects with receipts and compensation',
    ],
    creativeAngles: ['The app is a toolbelt', 'Work continues after the tab closes', 'Authority travels with the task'],
    confidence: Math.min(0.97, 0.72 + words(product + ' ' + audience + ' ' + tension).length / 200),
  };
}

export async function planCut(input) {
  const runtimeSeconds = Math.max(30, Math.min(180, Number(input.runtimeSeconds || 75)));
  const product = String(input.product || 'Agentis');
  const beat = Math.round(runtimeSeconds / 5);
  return {
    cutId: 'cut-' + product.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    runtimeSeconds,
    format: String(input.format || '16:9'),
    pacing: runtimeSeconds <= 60 ? 'kinetic' : 'editorial',
    scenes: [
      { order: 1, seconds: beat, title: 'The constraint', visual: 'Human-first apps fragment the agent loop', owner: 'Content Specialist' },
      { order: 2, seconds: beat, title: 'The contract', visual: 'One operation appears across UI, MCP and A2A', owner: 'Platform Specialist' },
      { order: 3, seconds: beat, title: 'The handoff', visual: 'A task pauses for authority and resumes safely', owner: 'Orchy' },
      { order: 4, seconds: beat, title: 'The proof', visual: 'Receipt, artifact and cost settle together', owner: 'Platform Specialist' },
      { order: 5, seconds: Math.max(4, runtimeSeconds - beat * 4), title: 'The invitation', visual: 'Build software for agents and humans together', owner: 'Content Specialist' },
    ],
  };
}

export async function scheduleRelease(input) {
  return {
    releaseId: 'release-' + String(input.channel || 'youtube').toLowerCase(),
    status: 'scheduled',
    channel: String(input.channel || 'youtube'),
    scheduledFor: String(input.scheduledFor),
    asset: String(input.asset || 'signal-room-master-v1'),
    approvalReceipt: 'human-authority-bound',
  };
}

export async function cancelRelease(input) {
  return { releaseId: String(input.releaseId), status: 'cancelled', compensated: true };
}
`;
    const operationSchemas = {
      analyzeBrief: {
        inputSchema: { type: 'object', required: ['product', 'audience'] },
        outputSchema: { type: 'object', required: ['northStar', 'proofPoints', 'confidence'] },
      },
      planCut: {
        inputSchema: { type: 'object', required: ['product', 'runtimeSeconds'] },
        outputSchema: { type: 'object', required: ['cutId', 'scenes', 'runtimeSeconds'] },
      },
      scheduleRelease: {
        inputSchema: { type: 'object', required: ['channel', 'scheduledFor'] },
        outputSchema: { type: 'object', required: ['releaseId', 'status', 'approvalReceipt'] },
      },
      cancelRelease: {
        inputSchema: { type: 'object', required: ['releaseId'] },
        outputSchema: { type: 'object', required: ['releaseId', 'status', 'compensated'] },
      },
    };
    const extensionManifest = {
      name: 'Signal Room Runtime',
      slug: extensionSlug,
      version: '1.0.0',
      runtime: 'node_worker',
      source: extensionSource,
      timeoutMs: 5_000,
      operations: Object.entries(operationSchemas).map(([name, schemas]) => ({ name, ...schemas })),
      capabilityTags: ['creative-production', 'release-planning'],
      permissions: [],
      allowedDomains: [],
    };
    const installedExtension = db
      .select({ id: schema.extensions.id })
      .from(schema.extensions)
      .where(
        and(
          eq(schema.extensions.workspaceId, workspace.id),
          eq(schema.extensions.slug, extensionSlug),
        ),
      )
      .get();
    if (installedExtension) {
      db.update(schema.extensions)
        .set({
          name: extensionManifest.name,
          version: extensionManifest.version,
          runtime: extensionManifest.runtime,
          manifest: extensionManifest,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.extensions.id, installedExtension.id))
        .run();
    } else {
      db.insert(schema.extensions)
        .values({
          id: randomUUID(),
          workspaceId: workspace.id,
          ambientId: null,
          userId: workspace.userId,
          packageId: null,
          name: extensionManifest.name,
          slug: extensionSlug,
          version: extensionManifest.version,
          runtime: extensionManifest.runtime,
          manifest: extensionManifest,
        })
        .run();
    }

    const definitions = new AppDefinitionStore(db);
    definitions.upsert(workspace.id, app.id, {
      contract: {
        operations: [
          {
            id: 'brief.analyze',
            title: 'Analyze creative brief',
            description: 'Turn product truth and audience tension into a filmable creative spine.',
            mode: 'query',
            inputSchema: {
              type: 'object',
              required: ['product', 'audience'],
              properties: {
                product: { type: 'string' },
                audience: { type: 'string' },
                tension: { type: 'string' },
              },
            },
            outputSchema: {
              type: 'object',
              required: ['northStar', 'proofPoints', 'confidence'],
              properties: {
                northStar: { type: 'string' },
                proofPoints: { type: 'array' },
                confidence: { type: 'number' },
              },
            },
            scopes: ['brief:read'],
            effects: [],
            economics: { latencyClass: 'realtime', targetLatencyMs: 800, maxLatencyMs: 2_000 },
            handler: { kind: 'component', component: 'signal-runtime', export: 'analyzeBrief' },
          },
          {
            id: 'cut.plan',
            title: 'Generate production cut',
            description:
              'Create a timed, owner-assigned scene plan and preserve it as a durable receipt.',
            mode: 'command',
            inputSchema: {
              type: 'object',
              required: ['product', 'runtimeSeconds'],
              properties: {
                product: { type: 'string' },
                runtimeSeconds: { type: 'number', minimum: 30, maximum: 180 },
                format: { type: 'string' },
              },
            },
            outputSchema: {
              type: 'object',
              required: ['cutId', 'scenes', 'runtimeSeconds'],
              properties: {
                cutId: { type: 'string' },
                scenes: { type: 'array' },
                runtimeSeconds: { type: 'number' },
              },
            },
            scopes: ['production:write'],
            effects: [
              {
                kind: 'production.cut.write',
                level: 'reversible',
                targetResourceType: 'production_cut',
                approval: 'never',
              },
            ],
            economics: {
              latencyClass: 'interactive',
              targetLatencyMs: 1_200,
              maxLatencyMs: 4_000,
              estimatedCostCents: { min: 1, max: 4 },
            },
            idempotency: { required: true, ttlSeconds: 86_400 },
            handler: { kind: 'component', component: 'signal-runtime', export: 'planCut' },
          },
          {
            id: 'publish.schedule',
            title: 'Schedule approved release',
            description:
              'Prepare a channel release, pause for authority, then execute with a bound receipt.',
            mode: 'command',
            inputSchema: {
              type: 'object',
              required: ['channel', 'scheduledFor'],
              properties: {
                channel: { type: 'string' },
                scheduledFor: { type: 'string' },
                asset: { type: 'string' },
              },
            },
            outputSchema: {
              type: 'object',
              required: ['releaseId', 'status', 'approvalReceipt'],
              properties: {
                releaseId: { type: 'string' },
                status: { const: 'scheduled' },
                approvalReceipt: { type: 'string' },
              },
            },
            scopes: ['publish:write'],
            effects: [
              {
                kind: 'channel.release.schedule',
                level: 'compensatable',
                targetResourceType: 'channel_release',
                compensationOperationId: 'publish.cancel',
                approval: 'always',
              },
            ],
            economics: {
              latencyClass: 'interactive',
              targetLatencyMs: 1_500,
              maxLatencyMs: 5_000,
              estimatedCostCents: { min: 2, max: 8 },
            },
            idempotency: { required: true, ttlSeconds: 86_400 },
            handler: {
              kind: 'component',
              component: 'signal-runtime',
              export: 'scheduleRelease',
            },
          },
          {
            id: 'publish.cancel',
            title: 'Cancel scheduled release',
            description: 'Compensate an approved release before it goes live.',
            mode: 'command',
            inputSchema: {
              type: 'object',
              required: ['releaseId'],
              properties: { releaseId: { type: 'string' } },
            },
            outputSchema: {
              type: 'object',
              required: ['releaseId', 'status', 'compensated'],
            },
            scopes: ['publish:write'],
            effects: [],
            handler: { kind: 'component', component: 'signal-runtime', export: 'cancelRelease' },
          },
          {
            id: 'production.direct',
            title: 'Direct the production team',
            description:
              'Delegate an open-ended production objective to the Content Specialist as a durable task.',
            mode: 'task',
            inputSchema: {
              type: 'object',
              required: ['objective'],
              properties: { objective: { type: 'string' }, constraints: { type: 'string' } },
            },
            outputSchema: { type: 'object' },
            scopes: ['production:delegate'],
            effects: [],
            economics: { latencyClass: 'background', maxLatencyMs: 900_000 },
            handler: {
              kind: 'mission',
              ownerAgent: 'Content Specialist',
              objectiveTemplate:
                'Direct the Signal Room production: {{objective}}. Constraints: {{constraints}}',
            },
          },
        ],
        resources: [
          {
            id: 'production-cut',
            title: 'Production cut',
            uriTemplate: 'agentis://apps/signal-room/cuts/{cutId}',
            scopes: ['brief:read'],
          },
        ],
        events: [
          { id: 'cut.approved', schema: { type: 'object', required: ['cutId'] } },
          { id: 'release.scheduled', schema: { type: 'object', required: ['releaseId'] } },
        ],
      },
      frontend: {
        framework: 'react',
        entry: 'src/main.tsx',
        outputDir: 'dist',
        styling: 'tailwind',
      },
      components: {
        components: [
          {
            id: 'signal-runtime',
            runtime: 'node',
            entry: extensionSlug,
            exports: ['analyzeBrief', 'planCut', 'scheduleRelease', 'cancelRelease'],
            network: 'none',
          },
        ],
      },
      storage: {
        engine: 'portable_relational',
        migrationsDir: 'migrations',
        postgresRequirements: [],
      },
      orchestration: {
        missionTemplates: [
          {
            id: 'launch-film-squad',
            ownerAgent: 'Orchy',
            objectiveTemplate: 'Coordinate specialists to deliver {{objective}}',
            maxChildren: 6,
            cancellation: 'tree',
            aggregation: 'all',
          },
        ],
        triggers: [{ event: 'cut.approved', operationId: 'publish.schedule' }],
        maxParallelTasks: 4,
      },
      brainPolicy: {
        retrievalScopes: ['app:signal-room', 'project:product-video-demo'],
        workingSet: { maxItems: 32, maxTokens: 18_000 },
        formation: { enabled: true, minimumConfidence: 0.72 },
        retention: { defaultDays: 120, decay: true },
        minimumTrust: 0.65,
        shareTaskContext: true,
      },
      permissionsV3: {
        scopes: ['brief:read', 'production:write', 'production:delegate', 'publish:write'],
        egress: [],
        maxEffectLevel: 'compensatable',
        maxSpendCentsPerTask: 50,
        guardrails: [
          {
            id: 'bounded-effect-authority',
            phase: 'prepare',
            expression: 'authority.maxEffectLevel <= "compensatable"',
            onViolation: 'deny',
          },
          {
            id: 'bounded-task-spend',
            phase: 'prepare',
            expression: 'authority.maxSpendCents <= 50',
            onViolation: 'deny',
          },
        ],
        escalation: { agentId: orchestrationAgentId, approvalQueue: 'signal-room-release-desk' },
      },
      quality: {
        suites: [
          {
            id: 'launch-readiness',
            title: 'Launch readiness',
            kind: 'correctness',
            datasetArtifactId: 'signal-room-benchmark',
            rubric: [
              'Every claim maps to a visible proof point',
              'The cut stays within declared runtime',
              'External publication always carries human authority',
            ],
            minimumScore: 0.9,
          },
        ],
        budgets: {
          maxCostCents: 50,
          maxTokens: 24_000,
          maxDurationMs: 900_000,
          maxExternalEffects: 1,
        },
        slos: {
          successRate: 0.98,
          p50LatencyMs: 900,
          p95LatencyMs: 3_500,
          maxCostPerSuccessfulTaskCents: 20,
        },
        releaseGates: [{ suiteId: 'launch-readiness', required: true }],
      },
      artifacts: {
        sourceIncluded: true,
        sbom: 'sbom.json',
        provenance: 'provenance.json',
        datasets: [
          {
            id: 'signal-room-benchmark',
            name: 'Signal Room launch examples',
            kind: 'benchmark_dataset',
            mimeType: 'application/json',
            uri: 'agentis://apps/signal-room/datasets/launch-readiness',
            securityLabels: ['internal'],
            createdAt: new Date().toISOString(),
          },
        ],
      },
      projections: {
        rest: true,
        mcp: { enabled: true, tasks: true },
        a2a: {
          enabled: true,
          exposeOperations: [
            'brief.analyze',
            'cut.plan',
            'publish.schedule',
            'publish.cancel',
            'production.direct',
          ],
        },
      },
    });

    const projectService = new AppProjectService({ db, dataDir, logger });
    const project = await projectService.initialize(workspace.id, app.id);
    const missions = new AgentMissionService(db);
    const extensions = new ExtensionRuntime(db, logger, { dockerEnabled: false });
    const operations = new AppOperationRuntime({
      db,
      engine: {} as WorkflowEngine,
      missions,
      extensions,
    });
    const common = {
      workspaceId: workspace.id,
      ambientId: null,
      userId: workspace.userId,
      appId: app.id,
    };
    const brief = await operations.invoke({
      ...common,
      operationId: 'brief.analyze',
      input: {
        product: 'Agentis Agentic Apps',
        audience: 'teams building serious AI-native software',
        tension: 'agents are still forced through interfaces and APIs designed only for humans',
      },
      idempotencyKey: 'signal-room:showcase:brief:v1',
    });
    const cut = await operations.invoke({
      ...common,
      operationId: 'cut.plan',
      input: { product: 'Agentis Agentic Apps', runtimeSeconds: 75, format: '16:9' },
      idempotencyKey: 'signal-room:showcase:cut:v1',
    });
    const release = await operations.invoke({
      ...common,
      operationId: 'publish.schedule',
      input: {
        channel: 'youtube',
        scheduledFor: '2026-09-03T16:00:00.000Z',
        asset: 'agentis-agentic-apps-master-v1',
      },
      idempotencyKey: 'signal-room:showcase:release:v1',
    });
    const direction = await operations.invoke({
      ...common,
      operationId: 'production.direct',
      input: {
        objective: 'Turn the approved 75-second cut into a launch-ready production package',
        constraints: 'Use verified claims only; preserve the cinematic editorial tone.',
      },
      idempotencyKey: 'signal-room:showcase:direction:v1',
    });
    const build = process.argv.includes('--build')
      ? await projectService.build(workspace.id, app.id)
      : null;

    console.log(
      JSON.stringify(
        {
          workspace: { id: workspace.id, name: workspace.name },
          app: { id: app.id, slug: appSlug, name: 'Signal Room' },
          project,
          build,
          sampleInvocations: { brief, cut, release, direction },
        },
        null,
        2,
      ),
    );
  } finally {
    sqlite.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
