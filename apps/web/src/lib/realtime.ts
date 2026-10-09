/**
 * Realtime hook over socket.io.
 *
 * Single connection per session; subscribes to whatever rooms the caller
 * declares. The bridge enforces ownership server-side, so we don't repeat
 * those checks here.
 */

import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
// §PERF-BOOT — subpath import. The core barrel re-exports `schemas`, whose zod
// schema construction runs at import time, so importing one constant through it
// dragged zod (~55 KB) + core (~51 KB) into the entry chunk. Applies to every
// EAGER shell file; lazy route chunks may keep the barrel.
import { REALTIME_EVENTS } from '@agentis/core/events';
import { streamSse, tokens, workspace as workspaceStore } from './api';

let sharedSocket: Socket | null = null;
let sharedSocketToken: string | null = null;
let socketConnected = false;
let socketConnecting = true;
let fallbackOpenCount = 0;

type RealtimeRoomKind = 'workspace' | 'app' | 'run' | 'mission' | 'workflow' | 'gateway' | 'agent' | 'conversation' | 'room';

interface ActiveSubscription {
  kind: RealtimeRoomKind;
  args: Record<string, string>;
  count: number;
}

function realtimeUrl(): string | undefined {
  const configured =
    (import.meta.env.VITE_AGENTIS_REALTIME_URL as string | undefined)
    ?? (import.meta.env.VITE_AGENTIS_API_URL as string | undefined);
  if (configured?.trim()) return configured.trim().replace(/\/+$/, '');
  if (typeof window === 'undefined') return undefined;
  // Dev/preview: the front-end server (Vite, or any static host) is NOT the API.
  // socket.io defaults to the page origin, so without this it connects back to the
  // front-end and receives ZERO events — the canvas/chat go silent. Connect
  // straight to the API on the SAME host whenever the page is served from a
  // DIFFERENT port than the API (5173, 4173, a Vite autoPort fallback, a LAN IP,
  // …). The socket CORS reflects local origins in dev so any port works. In
  // production the web is served BY the API (same origin / standard 80·443 with
  // an empty port), so the page origin is correct and we return undefined.
  const { protocol, hostname, port } = window.location;
  const apiPort = (import.meta.env.VITE_AGENTIS_API_PORT as string | undefined)?.trim() || '3737';
  if (port && port !== apiPort) {
    return `${protocol}//${hostname}:${apiPort}`;
  }
  return undefined;
}

// ── Connection status: the realtime socket is a separate channel from the chat
// SSE stream. When it is down, the canvas stops animating and proactive pushes
// stop arriving. Surfacing the status (instead of failing silently) is the
// difference between "Agentis is broken" and "the live link dropped". ──────────
export type RealtimeStatus = 'connecting' | 'connected' | 'fallback' | 'disconnected';
let realtimeStatus: RealtimeStatus = 'connecting';
const statusListeners = new Set<(s: RealtimeStatus) => void>();
const localListeners = new Map<string, Set<(env: RealtimeEnvelope) => void>>();
const workspaceStreams = new Map<string, WorkspaceStreamRecord>();
const runStreams = new Map<string, WorkspaceStreamRecord>();
const missionStreams = new Map<string, WorkspaceStreamRecord>();
// Socket.IO rooms belong to one physical socket, not to the logical client.
// A reconnect therefore drops every room even though the React subscriptions
// are still mounted. Keep the desired room set client-side and replay it for
// each new connection.
const activeSubscriptions = new Map<string, ActiveSubscription>();

interface WorkspaceStreamRecord {
  count: number;
  controller: AbortController;
}

export function getRealtimeStatus(): RealtimeStatus {
  return realtimeStatus;
}

function setRealtimeStatus(next: RealtimeStatus): void {
  if (realtimeStatus === next) return;
  realtimeStatus = next;
  for (const listener of statusListeners) listener(next);
}

function refreshRealtimeStatus(): void {
  if (socketConnected) setRealtimeStatus('connected');
  else if (fallbackOpenCount > 0) setRealtimeStatus('fallback');
  else setRealtimeStatus(socketConnecting ? 'connecting' : 'disconnected');
}

/** Subscribe to live realtime connection status (for an offline indicator). */
export function useRealtimeStatus(): RealtimeStatus {
  const [status, setStatus] = useState<RealtimeStatus>(() => getRealtimeStatus());
  useEffect(() => {
    // Ensure the shared socket exists so its status events drive this hook.
    getSocket();
    setStatus(getRealtimeStatus());
    statusListeners.add(setStatus);
    return () => {
      statusListeners.delete(setStatus);
      disconnectTransportWhenIdle();
    };
  }, []);
  return status;
}

function getSocket(): Socket {
  const token = tokens.access();
  if (sharedSocket && sharedSocketToken === token) return sharedSocket;
  if (sharedSocket) {
    sharedSocket.disconnect();
    sharedSocket = null;
  }
  sharedSocketToken = token;
  socketConnected = false;
  socketConnecting = true;
  setRealtimeStatus('connecting');
  const socket = io(realtimeUrl(), {
    auth: { token },
    path: '/socket.io',
    // Polling FIRST, then upgrade to websocket. The API runs behind Hono's node
    // adapter, whose HTTP server does not always forward the WS `upgrade` — a
    // websocket-first client then errors out instead of falling back, silently
    // killing live updates on every page. Polling always connects (it's plain
    // HTTP through the same origin/CORS as the REST API); socket.io upgrades to
    // websocket transparently when the upgrade succeeds.
    transports: ['polling', 'websocket'],
    reconnection: true,
  });
  socket.on('connect', () => {
    replayActiveSubscriptions(socket);
    socketConnected = true;
    socketConnecting = false;
    refreshRealtimeStatus();
  });
  socket.on('disconnect', () => {
    socketConnected = false;
    socketConnecting = false;
    refreshRealtimeStatus();
  });
  socket.io.on('reconnect_attempt', () => {
    socketConnected = false;
    socketConnecting = true;
    refreshRealtimeStatus();
  });
  socket.on('connect_error', (err: Error) => {
    socketConnected = false;
    socketConnecting = false;
    refreshRealtimeStatus();
    // Loud, actionable hint for the most common deploy misconfig: the socket
    // pointing at the front-end origin instead of the API. Never a silent dead link.
    console.warn(
      `[agentis] realtime socket could not connect (${err.message}). ` +
      'Live canvas/proactive updates are paused. If the front-end is served from a ' +
      'different origin than the API, set VITE_AGENTIS_REALTIME_URL to the API URL.',
    );
  });
  // Rebind every mounted useRealtime listener when auth rotation creates a new
  // socket. Previously those listeners stayed on the disconnected instance
  // until the entire page was refreshed.
  for (const event of localListeners.keys()) socket.on(event, forwardSocketEnvelope);
  sharedSocket = socket;
  restoreFallbackStreams();
  return sharedSocket;
}

export function disconnectRealtime() {
  sharedSocket?.disconnect();
  sharedSocket = null;
  sharedSocketToken = null;
  socketConnected = false;
  socketConnecting = true;
  fallbackOpenCount = 0;
  for (const record of workspaceStreams.values()) record.controller.abort();
  workspaceStreams.clear();
  for (const record of runStreams.values()) record.controller.abort();
  runStreams.clear();
  for (const record of missionStreams.values()) record.controller.abort();
  missionStreams.clear();
  setRealtimeStatus('connecting');
}

/**
 * A workspace transport is shared, but it must not outlive its final consumer.
 * This prevents hidden reconnect loops after navigation and guarantees unit/E2E
 * runners can terminate without leaked Socket.IO or SSE handles.
 */
function disconnectTransportWhenIdle(): void {
  if (localListeners.size > 0 || activeSubscriptions.size > 0 || statusListeners.size > 0) return;
  for (const record of workspaceStreams.values()) record.controller.abort();
  workspaceStreams.clear();
  for (const record of runStreams.values()) record.controller.abort();
  runStreams.clear();
  for (const record of missionStreams.values()) record.controller.abort();
  missionStreams.clear();
  sharedSocket?.disconnect();
  sharedSocket = null;
  sharedSocketToken = null;
  socketConnected = false;
  socketConnecting = false;
  fallbackOpenCount = 0;
  setRealtimeStatus('disconnected');
}

if (typeof window !== 'undefined') {
  window.addEventListener('agentis:auth-changed', () => {
    disconnectRealtime();
    // Silent access-token refresh happens without remounting the application.
    // Recreate the transport immediately when live consumers still exist; a
    // logout has no access token and intentionally remains disconnected.
    if (tokens.access() && (localListeners.size > 0 || activeSubscriptions.size > 0)) {
      getSocket();
    }
  });
}

export interface RealtimeEnvelope<TPayload = unknown> {
  event: string;
  payload: TPayload;
  emittedAt: string;
}

function addLocalListener(event: string, handler: (env: RealtimeEnvelope) => void): () => void {
  let listeners = localListeners.get(event);
  if (!listeners) {
    listeners = new Set();
    localListeners.set(event, listeners);
    sharedSocket?.on(event, forwardSocketEnvelope);
  }
  listeners.add(handler);
  return () => {
    listeners?.delete(handler);
    if (listeners?.size === 0) {
      localListeners.delete(event);
      sharedSocket?.off(event, forwardSocketEnvelope);
    }
  };
}

function forwardSocketEnvelope(env: RealtimeEnvelope): void {
  emitLocalRealtime(env);
}

function emitLocalRealtime(env: RealtimeEnvelope): void {
  const listeners = localListeners.get(env.event);
  if (!listeners) return;
  for (const listener of [...listeners]) listener(env);
}

export function useRealtime(events: string[], handler: (env: RealtimeEnvelope) => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const wrapped = (env: RealtimeEnvelope) => handlerRef.current(env);
    const unsubs = events.map((ev) => addLocalListener(ev, wrapped));
    getSocket();
    return () => {
      unsubs.forEach((unsubscribe) => unsubscribe());
      disconnectTransportWhenIdle();
    };
  }, [events.join('|')]);
}

/**
 * Non-hook realtime subscription — the imperative twin of {@link useRealtime}.
 * Lets non-React code (the in-process App client's `realtime.subscribe`, so an
 * authored view / CodeSurface can follow live events) attach a listener for one
 * or more event names. Returns an unsubscribe. Ensures the shared socket exists.
 */
export function subscribeRealtimeEvents(
  events: string[],
  handler: (env: RealtimeEnvelope) => void,
): () => void {
  getSocket();
  const unsubs = events.map((ev) => addLocalListener(ev, handler));
  return () => {
    unsubs.forEach((unsubscribe) => unsubscribe());
    disconnectTransportWhenIdle();
  };
}

export function rtSubscribe(
  kind: RealtimeRoomKind,
  args: Record<string, string>,
): () => void {
  const workspaceId = args.workspaceId ?? workspaceStore.get() ?? '';
  const nextArgs = { ...args, workspaceId };
  const key = subscriptionKey(kind, nextArgs);
  const existing = activeSubscriptions.get(key);
  if (existing) existing.count += 1;
  else {
    activeSubscriptions.set(key, { kind, args: nextArgs, count: 1 });
    if (kind === 'workspace' && workspaceId) acquireWorkspaceStream(workspaceId);
    // Run-scoped SSE fallback streams events directly from the API so node/run
    // status and reasoning continue even while the socket is reconnecting.
    if (kind === 'run' && args.runId) acquireRunStream(args.runId);
    if (kind === 'mission' && args.missionId) acquireMissionStream(args.missionId);
  }
  const sock = getSocket();
  // A disconnected Socket.IO client buffers emits, but replay-on-connect is the
  // canonical path. Only send immediately when this physical socket is joined.
  if (!existing && sock.connected) emitRoomSubscription(sock, kind, nextArgs, true);

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    const active = activeSubscriptions.get(key);
    if (!active) return;
    active.count -= 1;
    if (active.count > 0) return;
    activeSubscriptions.delete(key);
    if (kind === 'workspace' && workspaceId) releaseWorkspaceStream(workspaceId);
    if (kind === 'run' && args.runId) releaseRunStream(args.runId);
    if (kind === 'mission' && args.missionId) releaseMissionStream(args.missionId);
    if (sharedSocket?.connected) emitRoomSubscription(sharedSocket, kind, nextArgs, false);
    disconnectTransportWhenIdle();
  };
}

function subscriptionKey(kind: RealtimeRoomKind, args: Record<string, string>): string {
  const fields = Object.entries(args).sort(([left], [right]) => left.localeCompare(right));
  return `${kind}:${JSON.stringify(fields)}`;
}

function emitRoomSubscription(
  socket: Socket,
  kind: RealtimeRoomKind,
  args: Record<string, string>,
  subscribe: boolean,
): void {
  const action = subscribe ? 'subscribe' : 'unsubscribe';
  if (kind === 'workspace') socket.emit(`${action}:workspace`, args.workspaceId);
  else socket.emit(`${action}:${kind}`, args);
}

function replayActiveSubscriptions(socket: Socket): void {
  for (const subscription of activeSubscriptions.values()) {
    emitRoomSubscription(socket, subscription.kind, subscription.args, true);
  }
}

function restoreFallbackStreams(): void {
  for (const subscription of activeSubscriptions.values()) {
    if (subscription.kind === 'workspace' && subscription.args.workspaceId) {
      acquireWorkspaceStream(subscription.args.workspaceId);
    }
    if (subscription.kind === 'run' && subscription.args.runId) {
      acquireRunStream(subscription.args.runId);
    }
    if (subscription.kind === 'mission' && subscription.args.missionId) {
      acquireMissionStream(subscription.args.missionId);
    }
  }
}

function acquireRunStream(runId: string): void {
  const existing = runStreams.get(runId);
  if (existing) {
    return;
  }
  const record: WorkspaceStreamRecord = { count: 1, controller: new AbortController() };
  runStreams.set(runId, record);
  void runRunStream(runId, record);
}

function releaseRunStream(runId: string): void {
  const record = runStreams.get(runId);
  if (!record) return;
  record.count -= 1;
  if (record.count > 0) return;
  record.controller.abort();
  runStreams.delete(runId);
}

function acquireMissionStream(missionId: string): void {
  if (missionStreams.has(missionId)) return;
  const record: WorkspaceStreamRecord = { count: 1, controller: new AbortController() };
  missionStreams.set(missionId, record);
  void runScopedStream('mission', missionId, record);
}

function releaseMissionStream(missionId: string): void {
  const record = missionStreams.get(missionId);
  if (!record) return;
  record.count -= 1;
  if (record.count > 0) return;
  record.controller.abort();
  missionStreams.delete(missionId);
}

/**
 * Stream one run's events from `/v1/runs/:id/stream`. The server relays raw
 * run-room envelopes with their original event names, so we emit them straight
 * through — `useRealtime` consumers handle them identically to socket events.
 * Only emits when the socket is NOT connected (avoids duplicates); reconnects
 * with backoff until released.
 */
async function runRunStream(runId: string, record: WorkspaceStreamRecord): Promise<void> {
  return runScopedStream('run', runId, record);
}

async function runScopedStream(kind: 'run' | 'mission', id: string, record: WorkspaceStreamRecord): Promise<void> {
  const markOpen = () => {
    fallbackOpenCount += 1;
    refreshRealtimeStatus();
  };
  const markClosed = (wasOpen: boolean) => {
    if (!wasOpen) return;
    fallbackOpenCount = Math.max(0, fallbackOpenCount - 1);
    refreshRealtimeStatus();
  };

  while (!record.controller.signal.aborted) {
    let opened = false;
    try {
      await streamSse(
        `/v1/${kind}s/${encodeURIComponent(id)}/stream`,
        { signal: record.controller.signal },
        {
          onEvent: (event, data) => {
            if (!opened) { opened = true; markOpen(); }
            if (event === 'heartbeat' || socketConnected) return;
            const payload = isRecord(data) ? data : {};
            emitLocalRealtime({
              event,
              payload,
              emittedAt: stringField(payload, 'at') ?? stringField(payload, 'timestamp') ?? new Date().toISOString(),
            });
          },
        },
      );
    } catch (err) {
      if (!record.controller.signal.aborted) {
        console.warn(`[agentis] ${kind} SSE stream disconnected`, err);
      }
    } finally {
      markClosed(opened);
    }
    if (!record.controller.signal.aborted) await sleep(1_500, record.controller.signal);
  }
}

export function emitRealtime(event: string, payload: unknown) {
  getSocket().emit(event, payload);
}

function acquireWorkspaceStream(workspaceId: string): void {
  const existing = workspaceStreams.get(workspaceId);
  if (existing) {
    return;
  }
  const record: WorkspaceStreamRecord = { count: 1, controller: new AbortController() };
  workspaceStreams.set(workspaceId, record);
  void runWorkspaceStream(workspaceId, record);
}

function releaseWorkspaceStream(workspaceId: string): void {
  const record = workspaceStreams.get(workspaceId);
  if (!record) return;
  record.count -= 1;
  if (record.count > 0) return;
  record.controller.abort();
  workspaceStreams.delete(workspaceId);
}

async function runWorkspaceStream(workspaceId: string, record: WorkspaceStreamRecord): Promise<void> {
  let opened = false;
  const markOpen = () => {
    if (opened) return;
    opened = true;
    fallbackOpenCount += 1;
    refreshRealtimeStatus();
  };
  const markClosed = () => {
    if (!opened) return;
    opened = false;
    fallbackOpenCount = Math.max(0, fallbackOpenCount - 1);
    refreshRealtimeStatus();
  };

  while (!record.controller.signal.aborted) {
    try {
      await streamSse(
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/canvas/stream`,
        { signal: record.controller.signal },
        {
          onEvent: (event, data) => {
            markOpen();
            if (event === 'heartbeat' || socketConnected) return;
            for (const env of mapCanvasStreamEvent(event, data)) emitLocalRealtime(env);
          },
        },
      );
    } catch (err) {
      if (!record.controller.signal.aborted) {
        console.warn('[agentis] realtime SSE fallback disconnected', err);
      }
    } finally {
      markClosed();
    }
    if (!record.controller.signal.aborted) await sleep(1_500, record.controller.signal);
  }
}

function mapCanvasStreamEvent(event: string, data: unknown): RealtimeEnvelope[] {
  const payload = isRecord(data) ? data : {};
  const emittedAt = stringField(payload, 'at') ?? new Date().toISOString();
  const env = (name: string, nextPayload: Record<string, unknown> = payload): RealtimeEnvelope => ({
    event: name,
    payload: nextPayload,
    emittedAt,
  });

  if (event === 'snapshot') {
    const runs = Array.isArray(payload.runs) ? payload.runs.filter(isRecord) : [];
    const approvals = Array.isArray(payload.approvals) ? payload.approvals.filter(isRecord) : [];
    return [
      ...runs.map((run) => env(REALTIME_EVENTS.RUN_RUNNING, {
        runId: stringField(run, 'id'),
        workflowId: stringField(run, 'workflowId'),
        status: stringField(run, 'status'),
        workspaceId: stringField(payload, 'workspaceId'),
        at: stringField(run, 'startedAt') ?? stringField(run, 'createdAt') ?? emittedAt,
      })),
      ...approvals.map((approval) => env(REALTIME_EVENTS.APPROVAL_REQUESTED, {
        id: stringField(approval, 'id'),
        approvalId: stringField(approval, 'id'),
        runId: stringField(approval, 'runId'),
        summary: stringField(approval, 'summary'),
        title: stringField(approval, 'title'),
        workspaceId: stringField(payload, 'workspaceId'),
        at: stringField(approval, 'createdAt') ?? emittedAt,
      })),
    ];
  }

  if (event === 'workflow_progress') {
    switch (stringField(payload, 'type')) {
      case 'RUN_START':
        return [env(REALTIME_EVENTS.RUN_RUNNING, {
          ...payload,
          status: stringField(payload, 'status') ?? 'RUNNING',
        })];
      case 'RUN_COMPLETE':
        return [env(REALTIME_EVENTS.RUN_COMPLETED, payload)];
      case 'RUN_FAILED':
        return [env(REALTIME_EVENTS.RUN_FAILED, payload)];
      case 'BUILD_COMPLETE':
        return [env(REALTIME_EVENTS.CANVAS_BUILD_COMPLETE, payload)];
      case 'NODE_ENTER':
        return [env(REALTIME_EVENTS.NODE_STARTED, payload)];
      case 'NODE_EXIT':
        return [env(stringField(payload, 'status') === 'error' ? REALTIME_EVENTS.NODE_FAILED : REALTIME_EVENTS.NODE_COMPLETED, payload)];
      default:
        return [];
    }
  }

  // The workspace SSE stream mirrors these build events verbatim.  Keeping
  // their original names means every existing useRealtime consumer receives
  // the same progressive updates whether it is connected by Socket.IO or the
  // fallback stream.
  if (
    event === REALTIME_EVENTS.WORKFLOW_BUILD_PHASE
    || event === REALTIME_EVENTS.CANVAS_NODE_PLACED
    || event === REALTIME_EVENTS.CANVAS_EDGE_CONNECTED
  ) {
    return [env(event, payload)];
  }

  if (event === 'agent_state') {
    switch (stringField(payload, 'type')) {
      case 'TOOL_CALL':
        return [env(REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL, payload)];
      case 'OUTPUT_TOKEN':
        return [env(REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE, {
          ...payload,
          message: stringField(payload, 'token') ?? stringField(payload, 'message') ?? '',
        })];
      case 'TASK_START':
        return [env(REALTIME_EVENTS.AGENT_WORK_STEP, { ...payload, phase: 'start' })];
      case 'TASK_COMPLETE':
        return [env(REALTIME_EVENTS.AGENT_WORK_STEP, { ...payload, phase: 'complete' })];
      case 'TASK_ERROR':
        return [env(REALTIME_EVENTS.AGENT_WORK_STEP, {
          ...payload,
          phase: 'fail',
          detail: stringField(payload, 'error'),
        })];
      case 'STATUS_CHANGED':
        return [env(REALTIME_EVENTS.AGENT_STATUS_CHANGED, payload)];
      default:
        return [];
    }
  }

  if (event === 'attention_event') {
    const type = stringField(payload, 'type');
    if (type === 'APPROVAL_REQUIRED') return [env(REALTIME_EVENTS.APPROVAL_REQUESTED, payload)];
    if (type === 'RESOLVED') return [env(REALTIME_EVENTS.APPROVAL_RESOLVED, payload)];
    if (type === 'EXECUTION_FAILED') return [env(REALTIME_EVENTS.RUN_FAILED, payload)];
  }

  return [];
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}



