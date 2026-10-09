/**
 * Socket.io bridge.
 *
 * Subscribes to the in-process `EventBus` and re-emits each envelope to the
 * matching room. Clients authenticate with the same JWT as the REST API by
 * passing it as `auth.token` in the socket handshake.
 *
 * Room policy:
 *  - clients only ever join rooms that match resources their workspace
 *    context covers. Cross-workspace subscriptions are refused.
 *  - presence events (focus/blur/typing/thinking) are ephemeral; the bridge
 *    forwards them but does not persist them anywhere (V1-SPEC §12.2).
 */

import { Server as IOServer, type ServerOptions } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import { eq } from 'drizzle-orm';
import { REALTIME_ROOMS, AgentisError, type ViewportContext } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { EventBus } from '../event-bus.js';
import type { AuthService } from '../services/auth.js';
import type { ViewportStore } from '../services/viewportStore.js';

export interface RealtimeServer {
  attach(server: HttpServer): void;
  close(): Promise<void>;
}

export function createRealtimeServer(deps: {
  bus: EventBus;
  auth: AuthService;
  db: AgentisSqliteDb;
  logger: Logger;
  viewportStore?: ViewportStore;
  allowedOrigins: readonly string[];
  /**
   * Non-production single-tenant host. When true the socket CORS reflects any
   * loopback/LAN origin so the realtime link connects regardless of the web
   * dev-server port (5173, an autoPort fallback, a LAN IP, …) — no manual
   * AGENTIS_ALLOWED_ORIGINS needed. Strict allowlist still applies in production.
   */
  dev?: boolean;
  options?: Partial<ServerOptions>;
}): RealtimeServer {
  let io: IOServer | null = null;

  return {
    attach(server) {
      io = new IOServer(server, {
        ...deps.options,
        cors: { origin: makeCorsOrigin(deps.allowedOrigins, deps.dev ?? false), credentials: true },
      });

      io.use(async (socket, next) => {
        try {
          const token =
            (socket.handshake.auth?.token as string | undefined) ??
            socket.handshake.headers.authorization?.replace(/^Bearer /i, '');
          if (!token) throw new AgentisError('AUTH_TOKEN_INVALID', 'Missing token');
          const claims = await deps.auth.verify(token, 'access');
          socket.data.userId = claims.sub;
          next();
        } catch (err) {
          next(err instanceof Error ? err : new Error('Auth failed'));
        }
      });

      io.on('connection', (socket) => {
        const userId = socket.data.userId as string;
        socket.join(REALTIME_ROOMS.user(userId));

        socket.on('subscribe:workspace', (workspaceId: string) => {
          if (!ownsWorkspace(deps.db, userId, workspaceId)) return;
          socket.join(REALTIME_ROOMS.workspace(workspaceId));
        });
        socket.on('unsubscribe:workspace', (workspaceId: string) => {
          socket.leave(REALTIME_ROOMS.workspace(workspaceId));
        });
        // Agentic App room — surface renders/patches + datastore changes for one
        // app. First-class so an open App view follows its OWN live stream directly
        // (surface renders, data changes, region pushes) instead of riding the
        // noisy workspace room by side-effect. (LIVING-INTERFACES-COCKPIT-10X §4.1.)
        socket.on('subscribe:app', (args: { workspaceId: string; appId: string }) => {
          if (!args?.appId || !ownsWorkspace(deps.db, userId, args.workspaceId)) return;
          const app = deps.db
            .select({ workspaceId: schema.apps.workspaceId })
            .from(schema.apps)
            .where(eq(schema.apps.id, args.appId))
            .get();
          if (!app || app.workspaceId !== args.workspaceId) return;
          socket.join(REALTIME_ROOMS.app(args.appId));
        });
        socket.on('unsubscribe:app', (args: { appId: string }) => {
          if (args?.appId) socket.leave(REALTIME_ROOMS.app(args.appId));
        });
        socket.on('subscribe:run', (args: { workspaceId: string; runId: string }) => {
          if (!ownsWorkspace(deps.db, userId, args.workspaceId)) return;
          // Cross-check: run belongs to workspace.
          const run = deps.db
            .select()
            .from(schema.workflowRuns)
            .where(eq(schema.workflowRuns.id, args.runId))
            .get();
          if (!run || run.workspaceId !== args.workspaceId) return;
          socket.join(REALTIME_ROOMS.run(args.runId));
        });
        socket.on('unsubscribe:run', (args: { runId: string }) => {
          if (args?.runId) socket.leave(REALTIME_ROOMS.run(args.runId));
        });
        socket.on('subscribe:mission', (args: { workspaceId: string; missionId: string }) => {
          if (!ownsWorkspace(deps.db, userId, args.workspaceId)) return;
          const mission = deps.db
            .select({ workspaceId: schema.agentMissions.workspaceId })
            .from(schema.agentMissions)
            .where(eq(schema.agentMissions.id, args.missionId))
            .get();
          if (!mission || mission.workspaceId !== args.workspaceId) return;
          socket.join(REALTIME_ROOMS.mission(args.missionId));
        });
        socket.on('unsubscribe:mission', (args: { missionId: string }) => {
          if (args?.missionId) socket.leave(REALTIME_ROOMS.mission(args.missionId));
        });
        socket.on('subscribe:workflow', (args: { workspaceId: string; workflowId: string }) => {
          if (!ownsWorkspace(deps.db, userId, args.workspaceId)) return;
          if (!resourceInWorkspace(deps.db, 'workflow', args.workflowId, args.workspaceId)) return;
          socket.join(REALTIME_ROOMS.workflow(args.workflowId));
        });
        socket.on('unsubscribe:workflow', (args: { workflowId: string }) => {
          if (args?.workflowId) socket.leave(REALTIME_ROOMS.workflow(args.workflowId));
        });
        socket.on('subscribe:gateway', (args: { workspaceId: string; gatewayId: string }) => {
          if (!ownsWorkspace(deps.db, userId, args.workspaceId)) return;
          if (!resourceInWorkspace(deps.db, 'gateway', args.gatewayId, args.workspaceId)) return;
          socket.join(REALTIME_ROOMS.gateway(args.gatewayId));
        });
        socket.on('unsubscribe:gateway', (args: { gatewayId: string }) => {
          if (args?.gatewayId) socket.leave(REALTIME_ROOMS.gateway(args.gatewayId));
        });
        socket.on('subscribe:agent', (args: { workspaceId: string; agentId: string }) => {
          if (!ownsWorkspace(deps.db, userId, args.workspaceId)) return;
          if (!resourceInWorkspace(deps.db, 'agent', args.agentId, args.workspaceId)) return;
          socket.join(REALTIME_ROOMS.agent(args.agentId));
        });
        socket.on('unsubscribe:agent', (args: { agentId: string }) => {
          if (args?.agentId) socket.leave(REALTIME_ROOMS.agent(args.agentId));
        });
        socket.on('subscribe:conversation', (args: { workspaceId: string; agentId: string }) => {
          if (!ownsWorkspace(deps.db, userId, args.workspaceId)) return;
          if (!resourceInWorkspace(deps.db, 'agent', args.agentId, args.workspaceId)) return;
          socket.join(REALTIME_ROOMS.conversation(args.agentId));
        });
        socket.on('unsubscribe:conversation', (args: { agentId: string }) => {
          if (args?.agentId) socket.leave(REALTIME_ROOMS.conversation(args.agentId));
        });
        socket.on('subscribe:room', (args: { workspaceId: string; roomId: string }) => {
          if (!ownsWorkspace(deps.db, userId, args.workspaceId)) return;
          const room = deps.db
            .select({ id: schema.rooms.id, workspaceId: schema.rooms.workspaceId })
            .from(schema.rooms)
            .where(eq(schema.rooms.id, args.roomId))
            .get();
          if (!room || room.workspaceId !== args.workspaceId) return;
          socket.join(REALTIME_ROOMS.room(args.roomId));
        });
        socket.on('unsubscribe:room', (args: { roomId: string }) => {
          if (args?.roomId) socket.leave(REALTIME_ROOMS.room(args.roomId));
        });
        socket.on('viewport_context', (context: ViewportContext) => {
          if (!context || typeof context !== 'object') return;
          const workspaceId = context.workspaceId;
          if (!workspaceId || !ownsWorkspace(deps.db, userId, workspaceId)) return;
          deps.viewportStore?.set(userId, socket.id, context);
        });
        socket.on('disconnect', () => {
          deps.viewportStore?.clear(userId, socket.id);
        });
      });

      // Single subscription bridges every published envelope to its room.
      deps.bus.subscribe(({ room, envelope }) => {
        io?.to(room).emit(envelope.event, envelope);
      });

      deps.logger.info('realtime.attached');
    },
    async close() {
      await io?.close();
    },
  };
}

type CorsOriginFn = (
  origin: string | undefined,
  cb: (err: Error | null, allow?: boolean) => void,
) => void;

/**
 * CORS origin decision for the realtime socket. Always allows the configured
 * origins (and non-browser clients with no Origin). In dev, also reflects any
 * loopback/private-LAN origin so the socket connects from whatever port the web
 * dev server landed on — without hand-editing AGENTIS_ALLOWED_ORIGINS.
 */
function makeCorsOrigin(allowed: readonly string[], dev: boolean): CorsOriginFn {
  const allowSet = new Set(allowed);
  return (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowSet.has(origin)) return cb(null, true);
    if (dev && isLocalOrigin(origin)) return cb(null, true);
    cb(null, false);
  };
}

function isLocalOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === 'localhost'
      || hostname === '127.0.0.1'
      || hostname === '::1'
      || /^10\./.test(hostname)
      || /^192\.168\./.test(hostname)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    );
  } catch {
    return false;
  }
}

function ownsWorkspace(db: AgentisSqliteDb, userId: string, workspaceId: string): boolean {
  const ws = db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .get();
  return !!ws && ws.userId === userId;
}

function resourceInWorkspace(
  db: AgentisSqliteDb,
  type: 'workflow' | 'gateway' | 'agent',
  id: string,
  workspaceId: string,
): boolean {
  if (type === 'workflow') {
    const row = db
      .select({ workspaceId: schema.workflows.workspaceId })
      .from(schema.workflows)
      .where(eq(schema.workflows.id, id))
      .get();
    return row?.workspaceId === workspaceId;
  }
  if (type === 'gateway') {
    const row = db
      .select({ workspaceId: schema.openclawGateways.workspaceId })
      .from(schema.openclawGateways)
      .where(eq(schema.openclawGateways.id, id))
      .get();
    return row?.workspaceId === workspaceId;
  }
  const row = db
    .select({ workspaceId: schema.agents.workspaceId })
    .from(schema.agents)
    .where(eq(schema.agents.id, id))
    .get();
  return row?.workspaceId === workspaceId;
}
