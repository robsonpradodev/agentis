/**
 * AgentChannelsTab - manage native messaging channels for an agent.
 *
 * The UI mirrors the backend health contract: a channel is only "active" when
 * credentials, transport, outbound, inbound, and runtime checks pass.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, CircleHelp, Clock3, Loader2, MessageCircle, Plug, Plus, RefreshCcw, Send, ShieldCheck, Trash2, UserRound, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { Button } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';
import { useToast } from '../shared/Toast';
import { TeamMembersPanel } from './TeamMembersPanel';

type ChannelStatus = 'needs_action' | 'verifying' | 'active' | 'degraded' | 'error' | 'paused' | string;
type ChannelKind = 'telegram' | 'discord' | 'slack' | 'whatsapp';
type WhatsAppMode = 'qr_local' | 'cloud';

interface HealthCheck {
  name: 'credential' | 'transport' | 'outbound' | 'inbound' | 'runtime';
  ok: boolean;
  code: string;
  message: string;
  remediation?: string;
  checkedAt: string;
}

interface ChannelHealth {
  status: ChannelStatus;
  checks: HealthCheck[];
  lastTestAt?: string;
}

interface ChannelRecipient {
  handle: string;
  name?: string;
  rules?: string;
}
interface ChannelAccess {
  recipients?: ChannelRecipient[];
  answerAnyone?: boolean;
  anyoneRules?: string;
  unknownReply?: 'ignore' | 'decline';
}

export type ChannelPersona = 'instant' | 'human' | 'warm';

export interface ChannelCapabilities {
  mediaKinds: string[];
  supportsReactions: boolean;
  supportsPresence: boolean;
  supportsReadReceipts: boolean;
  supportsLocation: boolean;
  supportsContacts: boolean;
  supportsPoll: boolean;
  supportsReplyQuote: boolean;
  supportsMentions: boolean;
  supportsBurst: boolean;
  supportsHumanize: boolean;
}

interface ChannelConnection {
  id: string;
  agentId: string | null;
  kind: ChannelKind;
  name: string;
  status: ChannelStatus;
  defaultChatId: string | null;
  ownerChatId: string | null;
  ownerName: string | null;
  access?: ChannelAccess | null;
  targetAliases?: Record<string, string>;
  transport?: string | null;
  mode?: string | null;
  transportStatus?: string | null;
  persona?: ChannelPersona;
  rateLimit?: { perMinute?: number; perDay?: number } | null;
  requireOptIn?: boolean;
  warmupStartedAt?: string | null;
  whatsappProfile?: {
    version: 4;
    ownerReasoningVisibility: 'off' | 'indicator';
    manualOutboundTakeover: 'until_handback' | 'off';
    ownerManualOutboundTakeover: 'off';
    historyReconciliation: 'recent' | 'off';
  } | null;
  capabilities?: ChannelCapabilities;
  health: ChannelHealth;
  lastError?: string | null;
}

interface ChannelInboxPeer {
  recipientRef: string;
  peerIdentityId: string;
  connectionId: string;
  channelKind: string;
  displayName: string | null;
  conversationId: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageDirection: 'inbound' | 'outbound' | null;
  handoffState: string | null;
  subjectId: string | null;
  stage: string | null;
  goal: string | null;
  aliases: Array<{ value: string; kind: string; verified: boolean }>;
}

type ChannelActionStatus = 'planned' | 'awaiting_approval' | 'authorized' | 'executing' | 'delivered' | 'failed' | 'cancelled' | 'superseded';

interface ChannelActionIntent {
  id: string;
  agentId: string | null;
  connectionId: string;
  peerIdentityId: string;
  goal: string;
  body: string;
  authorizationBasis: string;
  status: ChannelActionStatus;
  attempts: number;
  scheduledFor: string | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

interface Provider {
  kind: ChannelKind;
  label: string;
  hint: string;
  persistent?: { value: 'polling' | 'gateway'; label: string };
}

const PROVIDERS: Provider[] = [
  { kind: 'telegram', label: 'Telegram', hint: 'Bot token from @BotFather', persistent: { value: 'polling', label: 'Use long polling' } },
  { kind: 'whatsapp', label: 'WhatsApp', hint: 'QR local is the easiest setup. Cloud API is available for production/webhook deployments.' },
  { kind: 'slack', label: 'Slack', hint: 'Bot token and signing secret from your Slack app' },
  { kind: 'discord', label: 'Discord', hint: 'Bot token from the Discord Developer Portal', persistent: { value: 'gateway', label: 'Two-way gateway' } },
];

const EMPTY_HEALTH: ChannelHealth = {
  status: 'verifying',
  checks: [],
};

export function AgentChannelsTab({ agentId, agentName }: { agentId: string; agentName: string }) {
  const toast = useToast();
  const [connections, setConnections] = useState<ChannelConnection[] | null>(null);
  // Workspace-owned (agentless) connections — shared, so THIS agent can send on
  // them too without connecting its own. Shown read-only so the operator sees the
  // "global instance" is already usable here instead of creating a duplicate.
  const [workspaceConnections, setWorkspaceConnections] = useState<ChannelConnection[]>([]);
  // §3.3 — a shared connection CAN be restricted to specific agents (Settings →
  // Channels → Permissions). null = still checking; true = open or this agent is
  // granted; false = restricted and this agent is not on the list.
  const [access, setAccess] = useState<Record<string, boolean | null>>({});

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ connections: ChannelConnection[] }>('/v1/channels');
      const all = data.connections ?? [];
      setConnections(all.filter((conn) => conn.agentId === agentId));
      const shared = all.filter((conn) => conn.agentId == null);
      setWorkspaceConnections(shared);
      const results = await Promise.allSettled(
        shared.map((conn) => api<{ grants: Array<{ agentId: string; status: string }> }>(`/v1/channels/${conn.id}/grants`)),
      );
      const next: Record<string, boolean | null> = {};
      shared.forEach((conn, i) => {
        const r = results[i];
        if (r?.status !== 'fulfilled') { next[conn.id] = null; return; }
        const activeGrants = r.value.grants.filter((g) => g.status === 'active');
        next[conn.id] = activeGrants.length === 0 || activeGrants.some((g) => g.agentId === agentId);
      });
      setAccess(next);
    } catch {
      // Keep the last known cards on a transient API/network failure. Clearing
      // them makes a healthy channel appear to disappear and can leave a newly
      // saved connection looking permanently stuck at `verifying`.
      setConnections((current) => current ?? []);
    }
  }, [agentId]);

  useEffect(() => {
    void refresh();
    // Provider startup and initial diagnostics can complete after the create
    // request returns. Keep the cards in sync so a transient `verifying` state
    // naturally settles to active/error without requiring a manual click.
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  if (connections === null) return <Skeleton height={360} />;

  return (
    <div className="max-w-4xl space-y-3">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">Channels</div>
        <p className="mt-1 text-[13px] text-text-secondary">
          Give {agentName} its OWN channel (its identity, its inbox), or use a shared workspace channel below.
          Saved channels are verified before they are marked active.
        </p>
      </div>

      {workspaceConnections.length > 0 && (
        <div className="rounded-card border border-line bg-surface-2/40 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Shared workspace channels</div>
          <p className="mt-1 text-[12px] text-text-secondary">
            Connected globally in Settings → Channels — no separate connection needed unless it&apos;s been restricted below.
          </p>
          <div className="mt-2 space-y-1.5">
            {workspaceConnections.map((conn) => {
              const ok = access[conn.id];
              return (
                <div key={conn.id} className="flex items-center gap-2 text-[13px] text-text-primary">
                  <span className="capitalize">{conn.kind}</span>
                  <span className="text-text-muted">·</span>
                  <span className="text-text-secondary">{conn.name}</span>
                  <span className={clsx(
                    'ml-auto rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
                    ok == null ? 'bg-surface-3 text-text-muted'
                      : ok ? 'bg-success-soft text-success'
                      : 'bg-warn-soft text-warn',
                  )}>
                    {ok == null ? 'checking…' : ok ? `${agentName} can send` : 'restricted — no access'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {(connections.length > 0 || workspaceConnections.length > 0) && (
        <ChannelOperationsPanel
          agentId={agentId}
          connections={[
            ...connections,
            ...workspaceConnections.filter((connection) => access[connection.id] !== false),
          ]}
        />
      )}

      {PROVIDERS.map((provider) => (
        <ProviderCard
          key={provider.kind}
          provider={provider}
          agentId={agentId}
          agentName={agentName}
          connection={connections.find((conn) => conn.kind === provider.kind) ?? null}
          onChanged={refresh}
          toast={toast}
        />
      ))}
    </div>
  );
}

function ChannelOperationsPanel({ agentId, connections }: { agentId: string; connections: ChannelConnection[] }) {
  const toast = useToast();
  const [open, setOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [peers, setPeers] = useState<ChannelInboxPeer[]>([]);
  const [actions, setActions] = useState<ChannelActionIntent[]>([]);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const connectionIds = [...new Set(connections.map((connection) => connection.id))];
  const connectionKey = connectionIds.sort().join(',');

  const load = useCallback(async (quiet = false) => {
    if (!connectionIds.length) return;
    if (!quiet) setLoading(true);
    try {
      const batches = await Promise.all(connectionIds.map(async (connectionId) => {
        const [inbox, ledger] = await Promise.all([
          api<{ peers?: ChannelInboxPeer[] }>(`/v1/channels/inbox?connectionId=${encodeURIComponent(connectionId)}&limit=12`),
          api<{ actions?: ChannelActionIntent[] }>(`/v1/channels/actions?connectionId=${encodeURIComponent(connectionId)}&limit=20`),
        ]);
        return { peers: inbox.peers ?? [], actions: ledger.actions ?? [] };
      }));
      setPeers(dedupeBy(batches.flatMap((batch) => batch.peers), (peer) => peer.peerIdentityId)
        .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '')).slice(0, 12));
      setActions(dedupeBy(batches.flatMap((batch) => batch.actions), (action) => action.id)
        .filter((action) => action.agentId === agentId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20));
    } catch {
      if (!quiet) {
        setPeers([]);
        setActions([]);
      }
    } finally {
      if (!quiet) setLoading(false);
    }
  // connectionKey is the intentionally stable dependency for the connection set.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, connectionKey]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function cancelAction(actionId: string) {
    setCancelling(actionId);
    try {
      await api(`/v1/channels/actions/${actionId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'cancelled from channel operations' }),
      });
      toast.success('Outbound action cancelled');
      await load(true);
    } catch (err) {
      toast.error('Could not cancel outbound action', String(err));
    } finally {
      setCancelling(null);
    }
  }

  const activeActions = actions.filter((action) => ['planned', 'awaiting_approval', 'authorized', 'executing'].includes(action.status));
  const peerById = new Map(peers.map((peer) => [peer.peerIdentityId, peer]));

  return (
    <section className="overflow-hidden rounded-card border border-line bg-surface">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-input border border-accent/25 bg-accent/10 text-accent">
          <MessageCircle size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13px] font-medium text-text-primary">
            Channel context &amp; actions
            {activeActions.length > 0 && <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400">{activeActions.length} active</span>}
          </div>
          <p className="mt-0.5 text-[11px] text-text-muted">Canonical contacts, relationship context, authority, and durable outbound work.</p>
        </div>
        <span className="text-[11px] text-text-muted">{peers.length} contacts · {actions.length} actions</span>
      </button>

      {open && (
        <div className="grid border-t border-line lg:grid-cols-2">
          <div className="min-w-0 border-b border-line lg:border-b-0 lg:border-r">
            <PanelLabel icon={<UserRound size={12} />} label="Recent contacts" />
            {loading ? (
              <div className="p-3"><Skeleton height={96} /></div>
            ) : peers.length === 0 ? (
              <EmptyLedger text="Contacts appear here after inbound or outbound channel activity." />
            ) : (
              <div className="divide-y divide-line">
                {peers.slice(0, 6).map((peer) => (
                  <div key={peer.peerIdentityId} className="px-3.5 py-2.5">
                    <div className="flex items-start gap-2">
                      <span className={clsx('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', peer.lastMessageDirection === 'inbound' ? 'bg-accent' : 'bg-text-muted')} />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-[12px] font-medium text-text-primary">{peer.displayName || primaryAlias(peer)}</span>
                          <span className="shrink-0 text-[10px] uppercase tracking-wide text-text-muted">{peer.channelKind}</span>
                          <span className="ml-auto shrink-0 text-[10px] text-text-muted">{relativeTime(peer.lastMessageAt)}</span>
                        </div>
                        <p className="mt-0.5 truncate text-[11px] text-text-secondary">{peer.lastMessagePreview || 'No message preview'}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-text-muted">
                          {peer.stage && <LedgerChip>{peer.stage}</LedgerChip>}
                          {peer.handoffState === 'human' && <LedgerChip tone="warn">Human control</LedgerChip>}
                          {peer.goal && <span className="max-w-[220px] truncate">Goal: {peer.goal}</span>}
                          {peer.aliases.length > 1 && <span>{peer.aliases.length} linked identities</span>}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="min-w-0">
            <PanelLabel icon={<Send size={12} />} label="Outbound action ledger" />
            {loading ? (
              <div className="p-3"><Skeleton height={96} /></div>
            ) : actions.length === 0 ? (
              <EmptyLedger text="Goal-driven sends and follow-ups will be recorded here before delivery." />
            ) : (
              <div className="divide-y divide-line">
                {actions.slice(0, 6).map((action) => {
                  const peer = peerById.get(action.peerIdentityId);
                  const cancellable = ['planned', 'awaiting_approval', 'authorized'].includes(action.status);
                  return (
                    <div key={action.id} className="px-3.5 py-2.5">
                      <div className="flex items-start gap-2">
                        <ActionStatusIcon status={action.status} />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-[12px] font-medium text-text-primary">{peer?.displayName || (peer ? primaryAlias(peer) : 'Channel contact')}</span>
                            <ActionStatusBadge status={action.status} />
                            <span className="ml-auto shrink-0 text-[10px] text-text-muted">{relativeTime(action.createdAt)}</span>
                          </div>
                          <p className="mt-0.5 truncate text-[11px] text-text-secondary">{action.body || action.goal}</p>
                          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-text-muted">
                            <ShieldCheck size={10} />
                            <span>{authorizationLabel(action.authorizationBasis)}</span>
                            {action.attempts > 0 && <span>· attempt {action.attempts}</span>}
                            {action.scheduledFor && action.status === 'planned' && <span>· due {relativeTime(action.scheduledFor)}</span>}
                            {cancellable && (
                              <button
                                type="button"
                                className="ml-auto text-text-muted hover:text-danger"
                                disabled={cancelling === action.id}
                                onClick={() => void cancelAction(action.id)}
                              >
                                {cancelling === action.id ? 'Cancelling…' : 'Cancel'}
                              </button>
                            )}
                          </div>
                          {action.lastError && <p className="mt-1 truncate text-[10px] text-danger">{action.lastError}</p>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function PanelLabel({ icon, label }: { icon: ReactNode; label: string }) {
  return <div className="flex items-center gap-1.5 bg-surface-2/60 px-3.5 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">{icon}{label}</div>;
}

function EmptyLedger({ text }: { text: string }) {
  return <p className="px-4 py-6 text-center text-[11px] leading-relaxed text-text-muted">{text}</p>;
}

function LedgerChip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'warn' }) {
  return <span className={clsx('rounded-full px-1.5 py-0.5', tone === 'warn' ? 'bg-amber-500/10 text-amber-400' : 'bg-surface-3 text-text-secondary')}>{children}</span>;
}

function ActionStatusIcon({ status }: { status: ChannelActionStatus }) {
  if (status === 'delivered') return <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-success" />;
  if (status === 'failed') return <XCircle size={13} className="mt-0.5 shrink-0 text-danger" />;
  if (status === 'executing') return <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-accent" />;
  return <Clock3 size={13} className="mt-0.5 shrink-0 text-amber-400" />;
}

function ActionStatusBadge({ status }: { status: ChannelActionStatus }) {
  const tone = status === 'delivered' ? 'bg-success-soft text-success'
    : status === 'failed' ? 'bg-danger-soft text-danger'
      : status === 'cancelled' || status === 'superseded' ? 'bg-surface-3 text-text-muted'
        : 'bg-amber-500/10 text-amber-400';
  return <span className={clsx('shrink-0 rounded-full px-1.5 py-0.5 text-[9px] uppercase tracking-wide', tone)}>{status.replace('_', ' ')}</span>;
}

function primaryAlias(peer: ChannelInboxPeer): string {
  return peer.aliases.find((alias) => alias.kind === 'phone')?.value ?? peer.aliases[0]?.value ?? 'Unknown contact';
}

function authorizationLabel(value: string): string {
  if (value === 'verified_owner_command') return 'Owner command';
  if (value === 'operator_approval') return 'Operator approved';
  if (value === 'relationship_next_action') return 'Relationship plan';
  if (value === 'standing_goal') return 'Standing goal';
  return 'Connection grant';
}

function relativeTime(value: string | null): string {
  if (!value) return '—';
  const delta = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(delta)) return '—';
  const absolute = Math.abs(delta);
  const suffix = delta >= 0 ? 'from now' : 'ago';
  if (absolute < 60_000) return delta >= 0 ? 'now' : 'just now';
  if (absolute < 3_600_000) return `${Math.round(absolute / 60_000)}m ${suffix}`;
  if (absolute < 86_400_000) return `${Math.round(absolute / 3_600_000)}h ${suffix}`;
  return `${Math.round(absolute / 86_400_000)}d ${suffix}`;
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

interface QrState {
  connectionId: string;
  dataUrl?: string;
  status: string;
  recovery?: {
    reason: string;
    attempt: number;
    nextRetryAt?: string;
  };
}

function ProviderCard({
  provider,
  agentId,
  agentName,
  connection,
  onChanged,
  toast,
}: {
  provider: Provider;
  agentId: string;
  agentName: string;
  connection: ChannelConnection | null;
  onChanged: () => Promise<void>;
  toast: ReturnType<typeof useToast>;
}) {
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState<'health' | 'disconnect' | 'save' | 'link' | 'target' | null>(null);
  const [name, setName] = useState(`${agentName} ${provider.label}`);
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [defaultIsOwner, setDefaultIsOwner] = useState(false);
  const [ownerName, setOwnerName] = useState('');
  const [usePersistent, setUsePersistent] = useState(provider.kind === 'telegram');
  const [whatsappMode, setWhatsappMode] = useState<WhatsAppMode>('qr_local');
  const [signingSecret, setSigningSecret] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [qr, setQr] = useState<QrState | null>(null);
  const [lastHealth, setLastHealth] = useState<ChannelHealth | null>(null);
  const [access, setAccess] = useState<ChannelAccess>({ recipients: [], answerAnyone: false });

  const health = lastHealth ?? connection?.health ?? EMPTY_HEALTH;
  const qrConnId = qr?.connectionId;
  const linked = qr?.status === 'open';
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Edge-triggered toast guard: a failed link can sit at logged_out/error for a
  // while before the operator clicks Relink, and the poll ticks every second —
  // without this, that one failure re-toasts every tick ("3 stacked toasts").
  const lastQrStatusRef = useRef<string | null>(null);

  useEffect(() => {
    setLastHealth(null);
    setChatId(connection?.defaultChatId ?? '');
    setDefaultIsOwner(Boolean(connection?.ownerChatId && connection.ownerChatId === connection.defaultChatId));
    setOwnerName(connection?.ownerName ?? '');
    setAccess(connection?.access ?? { recipients: [], answerAnyone: false });
  }, [connection?.id, connection?.status, connection?.defaultChatId, connection?.ownerChatId, connection?.ownerName]);

  useEffect(() => {
    if (!qrConnId || linked) {
      if (pollRef.current) clearInterval(pollRef.current);
      lastQrStatusRef.current = null;
      return;
    }
    pollRef.current = setInterval(() => {
      void (async () => {
        try {
          const state = await api<{ status: string; qrDataUrl?: string; recovery?: QrState['recovery'] }>(`/v1/channels/${qrConnId}/login`);
          setQr((prev) => (prev && prev.connectionId === qrConnId
            ? { ...prev, status: state.status, dataUrl: state.qrDataUrl, recovery: state.recovery }
            : prev));
          if (state.status === 'open') {
            toast.success(`${provider.label} transport open`);
            setQr(null);
            setConnecting(false);
            lastQrStatusRef.current = null;
            await onChanged();
          } else if (state.status === 'logged_out' || state.status === 'error') {
            // Edge-triggered — only the tick that TRANSITIONS into the failure
            // toasts, not every tick the poll happens to observe it.
            if (lastQrStatusRef.current !== state.status) {
              toast.error(`${provider.label} login failed`, 'Generate a new QR and relink the device.');
            }
          }
          lastQrStatusRef.current = state.status;
        } catch {
          /* transient polling failure */
        }
      })();
    }, 1000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [qrConnId, linked, provider.label, toast, onChanged]);

  async function saveConnection() {
    const isWhatsAppCloud = provider.kind === 'whatsapp' && whatsappMode === 'cloud';
    const needsToken = provider.kind !== 'whatsapp' || isWhatsAppCloud;
    if (needsToken && token.trim().length < 8) {
      toast.error('Token too short', 'Paste the full provider token.');
      return;
    }
    if (isWhatsAppCloud && (!phoneNumberId.trim() || !appSecret.trim() || !verifyToken.trim())) {
      toast.error('Cloud setup incomplete', 'Add phone number ID, app secret, and verify token.');
      return;
    }
    setBusy('save');
    try {
      const created = await api<{ connection: ChannelConnection; health: ChannelHealth }>('/v1/channels', {
        method: 'POST',
        body: JSON.stringify({
          kind: provider.kind,
          name: name.trim() || `${agentName} ${provider.label}`,
          agentId,
          ...(needsToken ? { token: token.trim() } : {}),
          defaultChatId: chatId.trim() || undefined,
          ...(provider.kind === 'whatsapp' && defaultIsOwner && chatId.trim() ? { ownerChatId: chatId.trim() } : {}),
          ...(provider.kind === 'whatsapp' && defaultIsOwner && ownerName.trim() ? { ownerName: ownerName.trim() } : {}),
          ...(provider.kind === 'whatsapp' ? { mode: whatsappMode } : {}),
          ...(provider.kind === 'slack' && signingSecret.trim() ? { signingSecret: signingSecret.trim() } : {}),
          ...(isWhatsAppCloud
            ? {
                phoneNumberId: phoneNumberId.trim(),
                appSecret: appSecret.trim(),
                verifyToken: verifyToken.trim(),
                defaultRecipient: chatId.trim() || undefined,
              }
            : {}),
          ...(provider.persistent && usePersistent ? { transport: provider.persistent.value } : {}),
        }),
      });
      setLastHealth(created.health);
      if (created.health.status === 'active') {
        toast.success(`${provider.label} active`);
      } else {
        toast.error(`${provider.label} needs action`, firstProblem(created.health) ?? 'Open the check details.');
      }
      setConnecting(false);
      setToken('');
      setSigningSecret('');
      setAppSecret('');
      setVerifyToken('');
      await onChanged();
    } catch (err) {
      toast.error(`Could not save ${provider.label}`, String(err));
    } finally {
      setBusy(null);
    }
  }

  async function startQrLogin(existingId?: string) {
    setBusy('save');
    try {
      let connId = existingId;
      if (!connId) {
        const created = await api<{ connection: ChannelConnection; health: ChannelHealth }>('/v1/channels', {
          method: 'POST',
          body: JSON.stringify({
            kind: provider.kind,
            mode: 'qr_local',
            name: name.trim() || `${agentName} ${provider.label}`,
            agentId,
            defaultChatId: chatId.trim() || undefined,
            ...(defaultIsOwner && chatId.trim() ? { ownerChatId: chatId.trim() } : {}),
            ...(defaultIsOwner && ownerName.trim() ? { ownerName: ownerName.trim() } : {}),
          }),
        });
        connId = created.connection.id;
        setLastHealth(created.health);
      }
      const login = await api<{ status: string; qrDataUrl?: string; recovery?: QrState['recovery'] }>(`/v1/channels/${connId}/login`, { method: 'POST' });
      setQr({ connectionId: connId, status: login.status, dataUrl: login.qrDataUrl, recovery: login.recovery });
      setConnecting(true);
    } catch (err) {
      toast.error(`Could not start ${provider.label} login`, String(err));
    } finally {
      setBusy(null);
    }
  }

  async function checkHealth() {
    if (!connection) return;
    setBusy('health');
    try {
      // Health checks are strictly read-only. A UI diagnostic must never send a
      // real message or convert a provider correlation id into delivery proof.
      const result = await api<{ connection: ChannelConnection; health: ChannelHealth }>(`/v1/channels/${connection.id}/health`);
      setLastHealth(result.health);
      if (result.health.status === 'active') toast.success('Channel health check passed');
      else toast.error('Channel needs action', firstProblem(result.health) ?? 'Open the check details.');
      await onChanged();
    } catch (err) {
      toast.error('Health check failed', String(err));
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    if (!connection) return;
    setBusy('disconnect');
    try {
      await api(`/v1/channels/${connection.id}`, { method: 'DELETE' });
      toast.success(`${provider.label} disconnected`);
      setQr(null);
      await onChanged();
    } catch (err) {
      toast.error('Could not disconnect', String(err));
    } finally {
      setBusy(null);
    }
  }

  async function saveTargets() {
    if (!connection) return;
    setBusy('target');
    try {
      const result = await api<{ connection: ChannelConnection; health: ChannelHealth }>(`/v1/channels/${connection.id}/targets`, {
        method: 'PATCH',
        body: JSON.stringify({
          defaultChatId: chatId.trim() || null,
          ...(provider.kind === 'whatsapp' ? { ownerChatId: defaultIsOwner && chatId.trim() ? chatId.trim() : null } : {}),
          ...(provider.kind === 'whatsapp' ? { ownerName: defaultIsOwner && ownerName.trim() ? ownerName.trim() : null } : {}),
          access: {
            recipients: (access.recipients ?? [])
              .map((r) => ({ handle: r.handle.trim(), name: r.name?.trim() || undefined, rules: r.rules?.trim() || undefined }))
              .filter((r) => r.handle.length > 0),
            answerAnyone: Boolean(access.answerAnyone),
            anyoneRules: access.anyoneRules?.trim() || undefined,
          },
        }),
      });
      setLastHealth(result.health);
      toast.success('Default recipient saved');
      await onChanged();
    } catch (err) {
      toast.error('Could not save recipient', String(err));
    } finally {
      setBusy(null);
    }
  }

  const isWhatsApp = provider.kind === 'whatsapp';
  const isQrConnection = isWhatsApp && connection?.mode !== 'cloud';
  const status = connection?.status ?? health.status;
  const active = status === 'active';
  const needsLink = Boolean(connection && isQrConnection && connection.status !== 'active');

  return (
    <div className="rounded-card border border-line bg-surface px-4 py-3.5">
      <div className="flex items-center gap-2">
        <span className="text-[14px] font-medium text-text-primary">{provider.label}</span>
        <StatusBadge status={status} />
        {isQrConnection && connection?.transportStatus ? (
          <span className="text-[11px] text-text-muted">transport: {connection.transportStatus}</span>
        ) : null}
      </div>

      {qr ? (
        <QrPanel
          provider={provider}
          qr={qr}
          onCancel={() => { setQr(null); setConnecting(false); }}
          onRetry={() => void startQrLogin(qr.connectionId)}
        />
      ) : connection ? (
        <>
          <div className="mt-1 text-[12px] text-text-muted">
            {connection.name}
            {connection.mode ? ` · ${connection.mode === 'cloud' ? 'Cloud API' : 'QR local'}` : ''}
            {connection.defaultChatId ? ` · target: ${connection.defaultChatId}` : ''}
          </div>
          {connection.lastError && <div className="mt-1 text-[12px] text-danger">{connection.lastError}</div>}
          <TargetEditor
            provider={provider}
            value={chatId}
            busy={busy === 'target'}
            onChange={setChatId}
            onSave={() => void saveTargets()}
            ownerTarget={defaultIsOwner}
            onOwnerTargetChange={setDefaultIsOwner}
            ownerName={ownerName}
            onOwnerNameChange={setOwnerName}
            access={access}
            onAccessChange={setAccess}
          />
          <TeamMembersPanel connectionId={connection.id} channelKind={provider.kind} />
          <HealthDetails health={health} />
          <ChannelBehaviorControls connection={connection} onChanged={onChanged} toast={toast} />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void checkHealth()}>
              {busy === 'health' ? <Loader2 size={12} className="animate-spin" /> : 'Check health'}
            </Button>
            {needsLink ? (
              <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void startQrLogin(connection.id)}>
                {busy === 'save' ? 'Starting...' : 'Relink QR'}
              </Button>
            ) : isQrConnection ? (
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void startQrLogin(connection.id)}>
                <RefreshCcw size={12} /> Restart link
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void disconnect()}>
              {busy === 'disconnect' ? 'Disconnecting...' : 'Disconnect'}
            </Button>
          </div>
          {!active && <ProblemHint health={health} />}
        </>
      ) : connecting ? (
        <div className="mt-3 space-y-2">
          <ConnectField label="Connection name">
            <input value={name} onChange={(event) => setName(event.target.value)} className={INPUT_CLS} />
          </ConnectField>

          {isWhatsApp && (
            <div className="grid grid-cols-2 gap-2">
              <ModeButton active={whatsappMode === 'qr_local'} onClick={() => setWhatsappMode('qr_local')} title="QR local" detail="Easy setup" />
              <ModeButton active={whatsappMode === 'cloud'} onClick={() => setWhatsappMode('cloud')} title="Cloud API" detail="Production" />
            </div>
          )}

          {(!isWhatsApp || whatsappMode === 'cloud') && (
            <ConnectField label={isWhatsApp ? 'Cloud access token' : 'Bot token'} hint={provider.hint}>
              <input
                value={token}
                onChange={(event) => setToken(event.target.value)}
                type="password"
                placeholder="Paste token"
                className={INPUT_CLS}
              />
            </ConnectField>
          )}

          {provider.kind === 'slack' && (
            <ConnectField label="Signing secret" hint="Required for Events API URL verification and signed callbacks">
              <input
                value={signingSecret}
                onChange={(event) => setSigningSecret(event.target.value)}
                type="password"
                placeholder="Slack signing secret"
                className={INPUT_CLS}
              />
            </ConnectField>
          )}

          {isWhatsApp && whatsappMode === 'cloud' && (
            <div className="grid gap-2 sm:grid-cols-2">
              <ConnectField label="Phone number ID">
                <input value={phoneNumberId} onChange={(event) => setPhoneNumberId(event.target.value)} className={INPUT_CLS} />
              </ConnectField>
              <ConnectField label="Verify token">
                <input value={verifyToken} onChange={(event) => setVerifyToken(event.target.value)} type="password" className={INPUT_CLS} />
              </ConnectField>
              <div className="sm:col-span-2">
                <ConnectField label="App secret">
                  <input value={appSecret} onChange={(event) => setAppSecret(event.target.value)} type="password" className={INPUT_CLS} />
                </ConnectField>
              </div>
            </div>
          )}

          <ConnectField label={isWhatsApp ? 'Default recipient' : 'Default chat ID'} hint={targetHint(provider.kind)}>
            <input
              value={chatId}
              onChange={(event) => setChatId(event.target.value)}
              placeholder={targetPlaceholder(provider.kind)}
              className={INPUT_CLS}
            />
          </ConnectField>
          {isWhatsApp && (
            <div className="space-y-2">
              <label className="flex items-start gap-2 text-[12px] text-text-secondary">
                <input
                  type="checkbox"
                  checked={defaultIsOwner}
                  onChange={(event) => setDefaultIsOwner(event.target.checked)}
                />
                <span>
                  This is my owner/operator chat
                  <span className="mt-0.5 block text-[11px] text-text-muted">The agent will recognize you here as the verified workspace owner — full tool access, direct commands, and durable corrections you give it are saved.</span>
                </span>
              </label>
              {defaultIsOwner && (
                <ConnectField label="Owner/operator name (optional)" hint="Lets the agent recognize who it is speaking with.">
                  <input value={ownerName} onChange={(event) => setOwnerName(event.target.value)} placeholder="e.g. Jordan" className={INPUT_CLS} />
                </ConnectField>
              )}
            </div>
          )}

          {provider.persistent && (
            <label className="flex items-center gap-2 text-[12px] text-text-secondary">
              <input type="checkbox" checked={usePersistent} onChange={(event) => setUsePersistent(event.target.checked)} />
              {provider.persistent.label}
            </label>
          )}
          {provider.kind === 'discord' && usePersistent && (
            <div className="rounded-input border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-text-secondary">
              Gateway mode requires the Discord Message Content intent.
            </div>
          )}

          <div className="flex gap-2 pt-1">
            {isWhatsApp && whatsappMode === 'qr_local' ? (
              <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void startQrLogin()}>
                {busy === 'save' ? 'Starting...' : 'Show QR'}
              </Button>
            ) : (
              <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void saveConnection()}>
                {busy === 'save' ? 'Verifying...' : `Save ${provider.label}`}
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConnecting(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <Button
            size="sm"
            variant="secondary"
            iconLeft={<Plug size={12} />}
            disabled={busy !== null}
            aria-label={`Connect ${provider.label} to ${agentName}`}
            onClick={() => setConnecting(true)}
          >
            Connect {provider.label}
          </Button>
        </div>
      )}
    </div>
  );
}

function QrPanel({ provider, qr, onCancel, onRetry }: { provider: Provider; qr: QrState; onCancel: () => void; onRetry: () => void }) {
  const failed = qr.status === 'closed' || qr.status === 'error' || qr.status === 'logged_out';
  const retryAt = qr.recovery?.nextRetryAt ? new Date(qr.recovery.nextRetryAt).toLocaleTimeString() : null;
  return (
    <div className="mt-3 flex flex-col items-center gap-2 rounded-input border border-line bg-surface-2 p-4">
      {qr.status === 'qr' && qr.dataUrl ? (
        <img src={qr.dataUrl} alt={`${provider.label} login QR`} className="h-44 w-44 rounded bg-white p-1" />
      ) : !failed ? (
        <Loader2 size={28} className="animate-spin text-text-muted" />
      ) : (
        <AlertTriangle size={28} className="text-danger" />
      )}
      <p className="text-center text-[12px] text-text-secondary">
        {qr.status === 'qr'
          ? 'Open WhatsApp Linked Devices and scan this code.'
          : failed
            ? 'WhatsApp closed the pairing transport before it generated a QR code.'
            : 'Starting the WhatsApp pairing transport…'}
      </p>
      <p className="text-[11px] text-text-muted">Transport status: {qr.status}</p>
      {failed && (
        <p className="text-center text-[11px] text-text-muted">
          {qr.recovery?.reason === 'exhausted'
            ? 'Automatic retries are exhausted.'
            : retryAt
              ? `Automatic retry scheduled for ${retryAt}.`
              : 'You can retry immediately.'}
        </p>
      )}
      <div className="flex gap-2">
        {failed && <Button size="sm" variant="secondary" onClick={onRetry}>Retry now</Button>}
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ChannelStatus }) {
  const tone =
    status === 'active' ? 'text-success' :
    status === 'needs_action' || status === 'verifying' ? 'text-amber-500' :
    status === 'degraded' ? 'text-cyan-400' :
    status === 'error' ? 'text-danger' :
    'text-text-muted';
  const dot =
    status === 'active' ? 'bg-success' :
    status === 'needs_action' || status === 'verifying' ? 'bg-amber-500' :
    status === 'degraded' ? 'bg-cyan-400' :
    status === 'error' ? 'bg-danger' :
    'bg-text-muted';
  const label =
    status === 'active' ? 'active' :
    status === 'needs_action' ? 'needs action' :
    status === 'verifying' ? 'verifying' :
    status === 'degraded' ? 'degraded' :
    status === 'error' ? 'error' :
    status || 'not connected';
  return (
    <span className={clsx('flex items-center gap-1 text-[12px]', tone)}>
      <span className={clsx('h-1.5 w-1.5 rounded-full', dot)} /> {label}
    </span>
  );
}

const PERSONA_OPTIONS: { value: ChannelPersona; label: string; detail: string }[] = [
  { value: 'instant', label: 'Instant', detail: 'Reply immediately (default)' },
  { value: 'human', label: 'Human', detail: 'Types, splits long replies, natural pace' },
  { value: 'warm', label: 'Warm', detail: 'Slower, concierge-style cadence' },
];

/**
 * Per-connection human-like pacing (§6) + anti-ban rails (§7). Sends land on the
 * new PATCH /v1/channels/:id/behavior endpoint. All controls are opt-in — the
 * defaults (instant persona, no caps, opt-in off) preserve existing behaviour.
 */
function ChannelBehaviorControls({
  connection,
  onChanged,
  toast,
}: {
  connection: ChannelConnection;
  onChanged: () => Promise<void>;
  toast: ReturnType<typeof useToast>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const caps = connection.capabilities;
  const supportsPacing = caps ? caps.supportsHumanize : true;

  async function patch(body: Record<string, unknown>, note: string) {
    setSaving(true);
    try {
      await api(`/v1/channels/${connection.id}/behavior`, { method: 'PATCH', body: JSON.stringify(body) });
      toast.success(note);
      await onChanged();
    } catch (err) {
      toast.error('Could not update channel behavior', String(err));
    } finally {
      setSaving(false);
    }
  }

  const persona = connection.persona ?? 'instant';
  const perMinute = connection.rateLimit?.perMinute ?? '';
  const perDay = connection.rateLimit?.perDay ?? '';
  const warming = Boolean(connection.warmupStartedAt);

  return (
    <div className="mt-3 rounded-card border border-line bg-surface-2/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-[12px] font-medium text-text-secondary"
      >
        <span>Behavior &amp; safety</span>
        <span className="text-text-muted">
          {persona !== 'instant' ? persona : 'instant'}
          {connection.rateLimit ? ' · rate-limited' : ''}
          {connection.requireOptIn ? ' · opt-in' : ''}
          {warming ? ' · warmup' : ''}
        </span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-line px-3 py-3">
          {/* Persona */}
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wide text-text-muted">Human-like pacing</div>
            {supportsPacing ? (
              <div className="grid grid-cols-3 gap-1.5">
                {PERSONA_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    disabled={saving}
                    onClick={() => void patch({ persona: opt.value }, `Persona set to ${opt.label}`)}
                    className={clsx(
                      'rounded-input border px-2 py-1.5 text-left text-[11px] transition',
                      persona === opt.value ? 'border-accent bg-accent-soft text-text-primary' : 'border-line text-text-secondary hover:border-accent/40',
                    )}
                    title={opt.detail}
                  >
                    <div className="font-medium">{opt.label}</div>
                    <div className="text-[10px] text-text-muted">{opt.detail}</div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-text-muted">This channel has no typing indicator, so pacing is not applied.</div>
            )}
          </div>

          {/* Rate limits */}
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wide text-text-muted">Rate limits (anti-ban)</div>
            <div className="flex items-end gap-2">
              <label className="flex-1 text-[11px] text-text-secondary">
                Per minute
                <input
                  type="number" min={0} defaultValue={perMinute} disabled={saving}
                  id={`rl-min-${connection.id}`}
                  className={clsx(INPUT_CLS, 'mt-0.5')}
                  placeholder="∞"
                />
              </label>
              <label className="flex-1 text-[11px] text-text-secondary">
                Per day
                <input
                  type="number" min={0} defaultValue={perDay} disabled={saving}
                  id={`rl-day-${connection.id}`}
                  className={clsx(INPUT_CLS, 'mt-0.5')}
                  placeholder="∞"
                />
              </label>
              <Button
                size="sm" variant="secondary" disabled={saving}
                onClick={() => {
                  const minEl = document.getElementById(`rl-min-${connection.id}`) as HTMLInputElement | null;
                  const dayEl = document.getElementById(`rl-day-${connection.id}`) as HTMLInputElement | null;
                  const m = Number(minEl?.value); const d = Number(dayEl?.value);
                  const rateLimit = (m > 0 || d > 0)
                    ? { perMinute: m > 0 ? m : null, perDay: d > 0 ? d : null }
                    : null;
                  void patch({ rateLimit }, rateLimit ? 'Rate limits saved' : 'Rate limits cleared');
                }}
              >
                Save
              </Button>
            </div>
          </div>

          {/* Opt-in + warmup */}
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11px] text-text-secondary">
              <input
                type="checkbox" checked={Boolean(connection.requireOptIn)} disabled={saving}
                onChange={(e) => void patch({ requireOptIn: e.target.checked }, e.target.checked ? 'Opt-in gate enabled' : 'Opt-in gate disabled')}
              />
              Require opt-in (block cold outreach to new contacts)
            </label>
            <Button
              size="sm" variant={warming ? 'ghost' : 'secondary'} disabled={saving}
              onClick={() => void patch({ startWarmup: !warming }, warming ? 'Warmup cleared' : 'Warmup started')}
            >
              {warming ? 'Stop warmup' : 'Start warmup'}
            </Button>
          </div>

          {connection.kind === 'whatsapp' && (
            <div className="space-y-2 rounded-input border border-line bg-surface-1 px-2.5 py-2 text-[11px] text-text-secondary">
              <div className="font-medium text-text-primary">Manual-message handoff</div>
              <label className="flex items-start gap-1.5">
                <input
                  type="checkbox"
                  checked={connection.whatsappProfile?.manualOutboundTakeover !== 'off'}
                  disabled={saving}
                  onChange={(e) => void patch(
                    { manualOutboundTakeover: e.target.checked ? 'until_handback' : 'off' },
                    e.target.checked ? 'Manual-message handoff enabled' : 'Manual-message handoff disabled',
                  )}
                />
                <span>Pause automation in a conversation after an operator sends from WhatsApp, until Hand back.</span>
              </label>
              <p className="text-text-muted">The owner/operator conversation always remains active. Manual handoff applies only to customer conversations.</p>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={connection.whatsappProfile?.ownerReasoningVisibility === 'indicator'}
                  disabled={saving}
                  onChange={(e) => void patch(
                    { ownerReasoningVisibility: e.target.checked ? 'indicator' : 'off' },
                    e.target.checked ? 'Owner reasoning indicator enabled' : 'Owner reasoning indicator disabled',
                  )}
                />
                Owner-only reasoning indicator
              </label>
            </div>
          )}

          {caps && (
            <div className="text-[10px] text-text-muted">
              Can send: {caps.mediaKinds.join(', ') || 'text only'}
              {caps.supportsReactions ? ' · reactions' : ''}
              {caps.supportsPresence ? ' · typing' : ''}
              {caps.supportsLocation ? ' · location' : ''}
              {caps.supportsPoll ? ' · polls' : ''}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HealthDetails({ health }: { health: ChannelHealth }) {
  if (!health.checks.length) return null;
  return (
    <div className="mt-3 grid gap-1.5">
      {health.checks.map((check) => (
        <div key={check.name} className="rounded-input border border-line bg-surface-2 px-3 py-2">
          <div className="flex items-start gap-2">
            {check.ok ? <CheckCircle2 size={13} className="mt-0.5 text-accent" /> : check.code === 'not_checked' ? <CircleHelp size={13} className="mt-0.5 text-text-muted" /> : <XCircle size={13} className="mt-0.5 text-danger" />}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12px] font-medium capitalize text-text-primary">{check.name}</span>
                <span className="font-mono text-[10px] text-text-muted">{check.code}</span>
              </div>
              <div className="mt-0.5 text-[12px] leading-relaxed text-text-secondary">{check.message}</div>
              {check.remediation ? <div className="mt-1 text-[11px] leading-relaxed text-text-muted">{check.remediation}</div> : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ProblemHint({ health }: { health: ChannelHealth }) {
  const problem = health.checks.find((check) => !check.ok);
  if (!problem) return null;
  return (
    <div className="mt-3 flex gap-2 rounded-input border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-text-secondary">
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" />
      <span>{problem.remediation ?? problem.message}</span>
    </div>
  );
}

function TargetEditor({
  provider,
  value,
  busy,
  onChange,
  onSave,
  ownerTarget,
  onOwnerTargetChange,
  ownerName,
  onOwnerNameChange,
  access,
  onAccessChange,
}: {
  provider: Provider;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  ownerTarget: boolean;
  onOwnerTargetChange: (value: boolean) => void;
  ownerName: string;
  onOwnerNameChange: (value: string) => void;
  access: ChannelAccess;
  onAccessChange: (access: ChannelAccess) => void;
}) {
  const recipients = access.recipients ?? [];
  const setRecipient = (i: number, patch: Partial<ChannelRecipient>) =>
    onAccessChange({ ...access, recipients: recipients.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) });
  const addRecipient = () => onAccessChange({ ...access, recipients: [...recipients, { handle: '' }] });
  const removeRecipient = (i: number) => onAccessChange({ ...access, recipients: recipients.filter((_, idx) => idx !== i) });

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-input border border-line bg-surface-2 px-3 py-3">
      <ConnectField
        label={provider.kind === 'whatsapp' ? 'Owner/operator chat' : 'Default target (you)'}
        hint={provider.kind === 'whatsapp' ? 'The person who directs this agent in WhatsApp.' : 'You — full access, no rules needed.'}
      >
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={targetPlaceholder(provider.kind)}
          className={INPUT_CLS}
        />
      </ConnectField>
      {provider.kind === 'whatsapp' && (
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-[12px] text-text-secondary">
            <input
              type="checkbox"
              checked={ownerTarget}
              disabled={!value.trim() || busy}
              onChange={(event) => onOwnerTargetChange(event.target.checked)}
            />
            <span>
              This is my owner/operator chat
              <span className="mt-0.5 block text-[11px] text-text-muted">The agent will recognize you here as the verified workspace owner — full tool access, direct commands, and durable corrections you give it are saved.</span>
            </span>
          </label>
          {ownerTarget && (
            <ConnectField label="Owner/operator name (optional)" hint="Lets the agent recognize who it is speaking with.">
              <input value={ownerName} onChange={(event) => onOwnerNameChange(event.target.value)} placeholder="e.g. Jordan" className={INPUT_CLS} />
            </ConnectField>
          )}
        </div>
      )}

      <div>
        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-text-muted">
          People with rules
        </span>
        <div className="flex flex-col gap-2">
          {recipients.map((r, i) => (
            <div key={i} className="rounded-input border border-line bg-surface-1 p-2">
              <div className="flex items-center gap-2">
                <input
                  value={r.handle}
                  onChange={(event) => setRecipient(i, { handle: event.target.value })}
                  placeholder={targetPlaceholder(provider.kind)}
                  className={INPUT_CLS}
                />
                <input
                  value={r.name ?? ''}
                  onChange={(event) => setRecipient(i, { name: event.target.value })}
                  placeholder="Name"
                  className={INPUT_CLS}
                  style={{ maxWidth: '140px' }}
                />
                <button
                  type="button"
                  aria-label="Remove person"
                  onClick={() => removeRecipient(i)}
                  className="shrink-0 px-1 text-text-muted hover:text-danger"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <textarea
                value={r.rules ?? ''}
                onChange={(event) => setRecipient(i, { rules: event.target.value })}
                placeholder="Rules in plain words — e.g. My assistant. Can check my calendar and answer questions, but don't send money or delete anything."
                rows={2}
                className={`${INPUT_CLS} mt-2`}
              />
            </div>
          ))}
        </div>
        <Button size="sm" variant="ghost" iconLeft={<Plus size={12} />} onClick={addRecipient} className="mt-2">
          Add person
        </Button>
      </div>

      <label className="flex items-center gap-2 text-[12px] text-text-secondary">
        <input
          type="checkbox"
          checked={Boolean(access.answerAnyone)}
          onChange={(event) => onAccessChange({ ...access, answerAnyone: event.target.checked })}
        />
        Reply to anyone else
      </label>
      {access.answerAnyone && (
        <ConnectField label="Rules for anyone not listed" hint="How should the agent behave with people you haven't listed?">
          <textarea
            value={access.anyoneRules ?? ''}
            onChange={(event) => onAccessChange({ ...access, anyoneRules: event.target.value })}
            rows={3}
            placeholder="You're answering on my behalf. Be friendly and helpful, never share my personal details, and don't take any actions — take a message and let me know."
            className={INPUT_CLS}
          />
        </ConnectField>
      )}

      <div className="flex justify-end">
        <Button size="sm" variant="secondary" disabled={busy} onClick={onSave}>
          {busy ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

function ModeButton({ active, onClick, title, detail }: { active: boolean; onClick: () => void; title: string; detail: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'rounded-input border px-3 py-2 text-left transition-colors',
        active ? 'border-accent bg-accent/10 text-text-primary' : 'border-line bg-surface-2 text-text-secondary hover:text-text-primary',
      )}
    >
      <span className="block text-[12px] font-medium">{title}</span>
      <span className="text-[11px] text-text-muted">{detail}</span>
    </button>
  );
}

const INPUT_CLS =
  'w-full rounded-input border border-line bg-surface-2 px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none';

function ConnectField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-text-muted">{hint}</span>}
    </label>
  );
}

function targetPlaceholder(kind: ChannelKind): string {
  if (kind === 'whatsapp') return '+12345678901 or 12345678901@s.whatsapp.net';
  if (kind === 'slack') return 'Slack channel ID';
  if (kind === 'discord') return 'Discord channel ID';
  if (kind === 'telegram') return 'Human Telegram chat ID';
  return 'Target ID';
}

function targetHint(kind: ChannelKind): string {
  if (kind === 'whatsapp') return 'Optional. Explicit phone numbers still work without this.';
  if (kind === 'telegram') return 'Use the human chat ID after that account sends /start to the bot.';
  return "Used for Test and default recipient.";
}

function firstProblem(health: ChannelHealth): string | null {
  const problem = health.checks.find((check) => !check.ok);
  return problem?.remediation ?? problem?.message ?? null;
}
