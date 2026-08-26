/**
 * OpenAPI surface — V1 review feedback.
 *
 * The V1 routes were authored against `Hono` directly (not OpenAPIHono),
 * so to avoid a workspace-wide rewrite we expose OpenAPI in two layers:
 *
 *   - `openApiDocument` — a hand-curated OpenAPI 3.1 doc that names every
 *     V1 route by path/method and references shared Zod schemas converted
 *     to JSON Schema via `zod-openapi-helper`. The doc is the source of
 *     truth for clients today; new routes added via `createRoute()` will
 *     be merged here when the migration completes.
 *
 *   - `mountOpenApi(app)` — registers `/v1/openapi.json` + `/v1/docs`
 *     (Scalar reference renderer) on a parent Hono app.
 *
 * This is intentionally small. The point is to give downstream SDK
 * generators and Postman a stable contract right now, not to bikeshed
 * description prose.
 */

import { Hono } from 'hono';
import { apiReference } from '@scalar/hono-api-reference';

const VERSION = '0.1.0';

/**
 * Minimal hand-curated OpenAPI 3.1 document covering V1 routes. Schemas
 * live as `$ref`s into `components.schemas` so they can be reused.
 */
export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Agentis API',
    version: VERSION,
    description:
      'V1 surface for the self-hosted Agentis backend. Authentication uses RS256 JWTs ' +
      'in the `Authorization: Bearer <token>` header. Workspace + ambient context is ' +
      'resolved from the `x-agentis-workspace-id` and `x-agentis-ambient-id` headers.',
  },
  servers: [{ url: 'http://127.0.0.1:3737', description: 'Local dev' }],
  components: {
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      AgentisError: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string', description: 'AgentisErrorCode (see packages/core/src/errors.ts)' },
          message: { type: 'string' },
          remediation: { type: 'string' },
          details: { type: 'object', additionalProperties: true },
        },
      },
      LoginRequest: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string' },
          password: { type: 'string', format: 'password' },
        },
      },
      TokenPair: {
        type: 'object',
        required: ['accessToken', 'refreshToken'],
        properties: {
          accessToken: { type: 'string' },
          refreshToken: { type: 'string' },
          expiresIn: { type: 'integer' },
        },
      },
      EmbeddingRuntime: {
        type: 'object',
        required: ['status', 'model', 'dtype', 'progress', 'artifacts'],
        properties: {
          status: { type: 'string', enum: ['uninitialized', 'downloading', 'verifying', 'loading', 'ready', 'degraded'] },
          model: { type: 'string' },
          revision: { type: ['string', 'null'] },
          dtype: { type: 'string' },
          progress: { type: 'integer', minimum: 0, maximum: 100 },
          errorCode: { type: ['string', 'null'] },
          error: { type: ['string', 'null'] },
          retryAt: { type: ['string', 'null'], format: 'date-time' },
          artifacts: { type: 'array', items: { type: 'object', additionalProperties: true } },
          pending: { type: 'object', additionalProperties: true },
        },
      },
    },
  },
  security: [{ bearer: [] }],
  paths: {
    '/healthz': {
      get: {
        tags: ['health'],
        security: [],
        summary: 'Liveness probe',
        responses: {
          '200': {
            description: 'Process liveness. `ok` stays true while top-level readiness may be degraded.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    status: { type: 'string', enum: ['ready', 'degraded'] },
                    mode: { type: 'string' },
                    components: { type: 'object', additionalProperties: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/v1/runtime/embedding': {
      get: {
        tags: ['runtime'],
        summary: 'Inspect local embedding runtime, artifacts, failure, and deferred backlog',
        responses: { '200': { description: 'Runtime state', content: { 'application/json': { schema: { $ref: '#/components/schemas/EmbeddingRuntime' } } } } },
      },
    },
    '/v1/runtime/embedding/retry': {
      post: {
        tags: ['runtime'],
        summary: 'Retry loading or preserve and repair the embedding cache',
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { repair: { type: 'boolean', default: false } } } } },
        },
        responses: { '200': { description: 'Verified runtime ready' } },
      },
    },
    '/v1/auth/login': {
      post: {
        tags: ['auth'],
        security: [],
        summary: 'Exchange username + password for a JWT pair',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } },
        },
        responses: {
          '200': {
            description: 'Issued',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/TokenPair' } } },
          },
          '401': {
            description: 'Invalid credentials',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AgentisError' } } },
          },
        },
      },
    },
    '/v1/auth/refresh': {
      post: {
        tags: ['auth'],
        security: [],
        summary: 'Mint a new access token from a refresh token',
        responses: {
          '200': { description: 'New token pair', content: { 'application/json': { schema: { $ref: '#/components/schemas/TokenPair' } } } },
        },
      },
    },
    '/v1/workspaces': {
      get: { tags: ['workspaces'], summary: 'List workspaces visible to the caller', responses: { '200': { description: 'OK' } } },
    },
    '/v1/workspaces/{id}/select': {
      post: {
        tags: ['workspaces'],
        summary: 'Mark a workspace as the active one for the current session',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/v1/workflows': {
      get: { tags: ['workflows'], summary: 'List workflows in the active workspace', responses: { '200': { description: 'OK' } } },
      post: { tags: ['workflows'], summary: 'Create a workflow', responses: { '201': { description: 'Created' } } },
    },
    '/v1/workflows/{id}': {
      get: { tags: ['workflows'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
      patch: { tags: ['workflows'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
      delete: { tags: ['workflows'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'Deleted' } } },
    },
    '/v1/workflows/{id}/run': {
      post: {
        tags: ['workflows'],
        summary: 'Start a workflow run; emits run.created on the realtime bus',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '202': { description: 'Run accepted' } },
      },
    },
    '/v1/runs/{id}': {
      get: {
        tags: ['runs'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/v1/runs/{id}/replay': {
      post: {
        tags: ['runs'],
        summary: 'Partial replay from a node id (V1-SPEC §6.7)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '202': { description: 'Replay accepted' } },
      },
    },
    '/v1/agents': {
      get: { tags: ['agents'], summary: 'List agents', responses: { '200': { description: 'OK' } } },
      post: { tags: ['agents'], summary: 'Register an agent', responses: { '201': { description: 'Created' } } },
    },
    '/v1/gateways': {
      get: { tags: ['gateways'], summary: 'List gateways (OpenClaw + others)', responses: { '200': { description: 'OK' } } },
    },
    '/v1/conversations/{agentId}/messages': {
      get: {
        tags: ['conversations'],
        parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
      post: {
        tags: ['conversations'],
        parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '201': { description: 'Sent' } },
      },
    },
    '/v1/conversations/{agentId}/turns': {
      post: {
        tags: ['conversations'],
        summary: 'Persist and enqueue a durable conversation turn',
        parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object', required: ['body'], properties: {
              body: { type: 'string' },
              executionMode: { type: 'string', enum: ['auto', 'quick', 'deep', 'mission'], default: 'auto' },
              permissionMode: { type: 'string', enum: ['ask', 'plan', 'auto'] },
              attachments: { type: 'array', items: { type: 'string' }, maxItems: 10 },
            },
          } } },
        },
        responses: { '202': { description: 'Turn persisted and queued' } },
      },
    },
    '/v1/conversations/{agentId}/turns/{turnId}': {
      get: {
        tags: ['conversations'], summary: 'Read the current durable turn snapshot',
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'turnId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Durable turn snapshot' } },
      },
    },
    '/v1/conversations/{agentId}/turns/{turnId}/events': {
      get: {
        tags: ['conversations'], summary: 'Replay and follow ordered durable turn events over SSE',
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'turnId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'after', in: 'query', schema: { type: 'integer', minimum: 0 } },
        ],
        responses: { '200': { description: 'Replayable text/event-stream' } },
      },
    },
    '/v1/conversations/{agentId}/turns/{turnId}/changes': {
      get: {
        tags: ['conversations'], summary: 'Read the redacted Undo/Redo summary for a durable turn',
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'turnId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Turn change-set summary, or null for pre-journal turns' } },
      },
    },
    '/v1/conversations/{agentId}/turns/{turnId}/undo': {
      post: {
        tags: ['conversations'], summary: 'Atomically undo the local changes owned by a durable turn',
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'turnId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object', required: ['expectedVersion'], properties: {
            expectedVersion: { type: 'integer', minimum: 1 },
            confirmSensitive: { type: 'boolean', default: false },
          },
        } } } },
        responses: { '200': { description: 'Changes undone' }, '409': { description: 'Conflict preview or sensitive confirmation required' } },
      },
    },
    '/v1/conversations/{agentId}/turns/{turnId}/redo': {
      post: {
        tags: ['conversations'], summary: 'Atomically reapply a previously undone durable turn',
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'turnId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object', required: ['expectedVersion'], properties: {
            expectedVersion: { type: 'integer', minimum: 1 },
            confirmSensitive: { type: 'boolean', default: false },
          },
        } } } },
        responses: { '200': { description: 'Changes reapplied' }, '409': { description: 'Conflict preview or sensitive confirmation required' } },
      },
    },
    '/v1/conversations/{agentId}/turns/active': {
      get: {
        tags: ['conversations'], summary: 'List resumable turns for a conversation',
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'conversationId', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Queued, running, paused, interrupted, or approval-waiting turns' } },
      },
    },
    '/v1/conversations/{agentId}/turns/{turnId}/pause': {
      post: {
        tags: ['conversations'], summary: 'Pause a durable conversation turn',
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'turnId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Paused turn snapshot' } },
      },
    },
    '/v1/conversations/{agentId}/turns/{turnId}/resume': {
      post: {
        tags: ['conversations'], summary: 'Resume a paused or interrupted durable turn',
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'turnId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Queued turn snapshot' } },
      },
    },
    '/v1/conversations/{agentId}/turns/{turnId}/cancel': {
      post: {
        tags: ['conversations'], summary: 'Cancel a durable turn and its conversation-owned runs',
        parameters: [
          { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'turnId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Cancelled turn snapshot' } },
      },
    },
    '/v1/approvals': {
      get: { tags: ['approvals'], responses: { '200': { description: 'OK' } } },
    },
    '/v1/approvals/{id}/approve': {
      post: { tags: ['approvals'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    },
    '/v1/approvals/{id}/reject': {
      post: { tags: ['approvals'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    },
    '/v1/extensions/registry/status': {
      get: { tags: ['extension-registry'], summary: 'extension registry client configuration + breaker state', responses: { '200': { description: 'OK' } } },
    },
    '/v1/extensions/registry': {
      get: { tags: ['extension-registry'], summary: 'Browse extension registry entries', responses: { '200': { description: 'OK' } } },
    },
    '/v1/extensions/registry/install/{slug}': {
      post: {
        tags: ['extension-registry'],
        summary: 'Install a registry entry; verifies SHA-256 + runs the security scanner',
        parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['permissionsAcknowledged'],
                properties: { permissionsAcknowledged: { type: 'boolean', enum: [true] } },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Installed' },
          '422': {
            description: 'Hash mismatch or scanner block',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AgentisError' } } },
          },
        },
      },
    },
  },
} as const;

export function mountOpenApi(app: Hono): void {
  app.get('/v1/openapi.json', (c) => c.json(openApiDocument));
  app.get(
    '/v1/docs',
    apiReference({
      spec: { url: '/v1/openapi.json' },
      pageTitle: 'Agentis API',
      theme: 'default',
    }),
  );
}
