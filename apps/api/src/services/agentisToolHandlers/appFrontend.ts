import { z } from 'zod';
import { AgentisError } from '@agentis/core';
import type { AgentisToolContext } from '@agentis/core';
import { AppDefinitionStore } from '@agentis/app';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import { AppProjectService } from '../appProjectService.js';
import type { ToolHandlerDeps } from './deps.js';

const appIdProperty = {
  appId: {
    type: 'string',
    description: 'App id. Omit when operating inside a locked App viewport.',
  },
};

const designIntentSchema = z.object({
  direction: z.string().min(12).max(300),
  signature: z.string().min(12).max(300),
  layout: z.string().min(8).max(240),
  typography: z.string().min(8).max(240),
  color: z.string().min(8).max(240),
  interactions: z.array(z.string().min(4).max(180)).min(2).max(12),
  avoids: z.array(z.string().min(3).max(120)).min(2).max(12),
});

type FrontendIntent = 'create' | 'redesign' | 'iteration';
type DesignIntent = z.infer<typeof designIntentSchema>;

/** Agent-native source control for unrestricted React Agentic App interfaces. */
export function registerAppFrontendTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  if (!deps.dataDir) return;
  const projects = new AppProjectService({
    db: deps.db,
    dataDir: deps.dataDir,
    logger: deps.logger,
    bus: deps.bus,
  });
  const definitions = new AppDefinitionStore(deps.db);

  registry.registerMany([
    {
      definition: {
        id: 'agentis.app.frontend.inspect',
        family: 'app',
        mcpExposed: true,
        mutating: false,
        description:
          'Inspect the committed source, persisted design direction, and executable operation contract of an App managed React frontend. Use this before modifying an existing custom interface. The neutral bootstrap is not a design system: for create/redesign work replace it completely and choose a product-specific visual language. Runtime actions call window.agentis.operations.invoke(operationId, input).',
        inputSchema: {
          type: 'object',
          properties: {
            ...appIdProperty,
            paths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional exact source paths. Omit for the useful editable source set.',
            },
          },
        },
      },
      handler: async (args, ctx) => {
        const appId = resolveAppId(args, ctx);
        const source = await projects.inspectSource(
          ctx.workspaceId,
          appId,
          z.array(z.string()).max(80).optional().parse(args.paths),
        );
        const definition = definitions.get(ctx.workspaceId, appId);
        return {
          ...source,
          designIntent: readDesignIntent(source.files),
          runtimeSdk: {
            global: 'window.agentis',
            invoke: 'window.agentis.operations.invoke(operationId, input)',
            operations: definition?.contract?.operations ?? [],
          },
        };
      },
    },
    {
      definition: {
        id: 'agentis.app.frontend.apply',
        family: 'app',
        mcpExposed: true,
        mutating: true,
        autoExecute: true,
        approval: { riskLevel: 'low', reversible: true, externalSideEffects: false },
        description:
          'AUTHORITATIVE interface tool for substantial App creation or redesign. It accepts arbitrary React/TypeScript/Tailwind and package changes, verifies the real production build in isolation, commits the revision, and publishes an immutable artifact. For intent=create or redesign, designIntent is mandatory: choose a bold product-specific direction, a memorable signature, a layout/typography/color system, at least two real interaction states, and explicit patterns to avoid. Never inherit the neutral bootstrap or converge on the recurring Agentis dark + lime + serif + monospace + left-sidebar aesthetic. Implement interactions in code—not as inert buttons. Use window.agentis.operations.invoke for declared backend operations. Use this—not agentis.ui.*—for custom product interfaces.',
        inputSchema: {
          type: 'object',
          properties: {
            ...appIdProperty,
            reason: { type: 'string', description: 'Concise source-control commit message.' },
            intent: {
              type: 'string',
              enum: ['create', 'redesign', 'iteration'],
              description: 'create/redesign requires a fresh designIntent; iteration preserves the existing direction.',
            },
            designIntent: {
              type: 'object',
              description: 'Persisted experience contract. Required for create and redesign.',
              properties: {
                direction: { type: 'string', description: 'A decisive aesthetic concept grounded in this product and audience.' },
                signature: { type: 'string', description: 'The one visual or interactive idea people will remember.' },
                layout: { type: 'string', description: 'Spatial composition and responsive behavior.' },
                typography: { type: 'string', description: 'Specific display/body type strategy; do not default to the prior App style.' },
                color: { type: 'string', description: 'Dominant palette, contrast, atmosphere, and theme.' },
                interactions: { type: 'array', minItems: 2, items: { type: 'string' }, description: 'Real implemented behaviors and their state transitions.' },
                avoids: { type: 'array', minItems: 2, items: { type: 'string' }, description: 'Cliches and previous-App patterns this design deliberately avoids.' },
              },
              required: ['direction', 'signature', 'layout', 'typography', 'color', 'interactions', 'avoids'],
            },
            changes: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'Repository-relative source path.' },
                  content: { type: ['string', 'null'], description: 'Complete file content, or null to delete.' },
                },
                required: ['path', 'content'],
              },
            },
          },
          required: ['changes'],
        },
      },
      handler: async (args, ctx) => {
        const appId = resolveAppId(args, ctx);
        const intent = z.enum(['create', 'redesign', 'iteration']).default('iteration').parse(args.intent) as FrontendIntent;
        const designIntent = designIntentSchema.optional().parse(args.designIntent);
        const changes = z.array(z.object({ path: z.string().min(1), content: z.string().nullable() })).min(1).max(120).parse(args.changes);
        validateExperienceRevision(intent, designIntent, changes);
        const sourceChanges = designIntent
          ? upsertDesignIntent(changes, intent, designIntent)
          : changes;
        const applied = await projects.applySource(
          ctx.workspaceId,
          appId,
          sourceChanges,
          typeof args.reason === 'string' ? args.reason : undefined,
        );
        const build = await projects.build(ctx.workspaceId, appId);
        return {
          applied: !applied.unchanged,
          unchanged: applied.unchanged,
          appId,
          sourceCommit: applied.sourceCommit,
          buildId: build.id,
          buildStatus: build.status,
          artifactSha256: build.artifactSha256,
          published: build.status === 'completed',
          frontend: 'managed-react',
          intent,
          designIntent: designIntent ?? readDesignIntent((await projects.inspectSource(
            ctx.workspaceId,
            appId,
            ['agentis.design.json'],
          )).files),
        };
      },
    },
    {
      definition: {
        id: 'agentis.app.frontend.build',
        family: 'app',
        mcpExposed: true,
        mutating: true,
        autoExecute: true,
        approval: { riskLevel: 'low', reversible: true, externalSideEffects: false },
        description:
          'Build and publish the current committed managed React frontend without changing its source. Returns immutable artifact provenance.',
        inputSchema: { type: 'object', properties: { ...appIdProperty } },
      },
      handler: async (args, ctx) => {
        const appId = resolveAppId(args, ctx);
        const build = await projects.build(ctx.workspaceId, appId);
        return {
          appId,
          buildId: build.id,
          sourceCommit: build.sourceCommit,
          buildStatus: build.status,
          artifactSha256: build.artifactSha256,
          published: build.status === 'completed',
          frontend: 'managed-react',
        };
      },
    },
  ]);
}

function validateExperienceRevision(
  intent: FrontendIntent,
  designIntent: DesignIntent | undefined,
  changes: Array<{ path: string; content: string | null }>,
): void {
  if (intent === 'iteration') return;
  if (!designIntent) {
    throw new AgentisError(
      'VALIDATION_FAILED',
      `designIntent is required for frontend intent=${intent}; define a fresh visual direction and real interaction states before authoring source.`,
    );
  }
  const authored = changes
    .filter((change): change is { path: string; content: string } => change.content != null)
    .filter((change) => /\.(?:tsx?|jsx?|html)$/i.test(change.path));
  if (authored.length === 0) {
    throw new AgentisError(
      'VALIDATION_FAILED',
      `${intent} must replace or add at least one React/HTML experience source file.`,
    );
  }
  const source = authored.map((change) => change.content).join('\n');
  const interactionSignals = source.match(
    /(?:on(?:Click|Change|Submit|Input|KeyDown|PointerDown|PointerMove|DragStart|Drop)|addEventListener|useState|useReducer|useTransition|requestAnimationFrame)\b/g,
  ) ?? [];
  if (interactionSignals.length < 2) {
    throw new AgentisError(
      'VALIDATION_FAILED',
      `${intent} declares interactive behavior but the authored source does not implement enough state or event handling. Add real interaction states, not inert controls.`,
    );
  }
  if (source.includes('data-agentis-neutral-bootstrap')) {
    throw new AgentisError(
      'VALIDATION_FAILED',
      'The neutral bootstrap cannot be published as a finished experience. Replace it with the chosen design direction.',
    );
  }
}

function upsertDesignIntent(
  changes: Array<{ path: string; content: string | null }>,
  intent: FrontendIntent,
  designIntent: DesignIntent,
): Array<{ path: string; content: string | null }> {
  const record = {
    version: 1,
    intent,
    ...designIntent,
  };
  return [
    ...changes.filter((change) => change.path.replaceAll('\\', '/') !== 'agentis.design.json'),
    { path: 'agentis.design.json', content: `${JSON.stringify(record, null, 2)}\n` },
  ];
}

function readDesignIntent(files: Array<{ path: string; content: string }>): Record<string, unknown> | null {
  const file = files.find((candidate) => candidate.path === 'agentis.design.json');
  if (!file) return null;
  try {
    const parsed = JSON.parse(file.content) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function resolveAppId(args: Record<string, unknown>, ctx: AgentisToolContext): string {
  const explicit = typeof args.appId === 'string' ? args.appId.trim() : '';
  const viewed = ctx.viewport?.appView?.appId
    ?? (ctx.viewport?.resourceKind === 'app' ? ctx.viewport.resourceId : undefined);
  if (viewed && explicit && viewed !== explicit && ctx.viewport?.appView?.targetLocked !== false) {
    throw new AgentisError(
      'VALIDATION_FAILED',
      `Frontend target mismatch: the operator is viewing App ${viewed}, but this call targets ${explicit}. Re-observe the viewport before editing another App.`,
    );
  }
  const appId = viewed || explicit || ctx.appId?.trim();
  if (!appId) throw new AgentisError('VALIDATION_FAILED', 'appId is required outside an App viewport.');
  return appId;
}
