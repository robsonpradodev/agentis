/**
 * ChannelIdentitiesPanel — cross-surface peer identity (OMNICHANNEL §5.2).
 *
 * Lists every human who has reached the workspace's agents over a channel, with
 * a message count per (channel, handle). Linking a handle to the current user
 * assigns a stable peer key so the same person is recognized across WhatsApp,
 * Telegram, and Slack — the orchestrator then greets them with that continuity.
 */

import { useCallback, useEffect, useState } from 'react';
import { Ban, Crown, Link2, Loader2, ShieldCheck, UserCheck } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';
import { useToast } from '../shared/Toast';

interface PeerIdentity {
  id: string;
  channelKind: string;
  connectionId: string | null;
  handle: string;
  displayName: string | null;
  userId: string | null;
  peerKey: string | null;
  authorityRole?: 'external' | 'owner' | 'delegate';
  verifiedAt?: string | null;
  grantExpiresAt?: string | null;
  blocked?: boolean;
  messageCount: number;
  lastSeenAt: string;
}

export function ChannelIdentitiesPanel() {
  const toast = useToast();
  const [identities, setIdentities] = useState<PeerIdentity[] | null>(null);
  const [me, setMe] = useState<{ id: string; displayName?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, meRes] = await Promise.allSettled([
        api<{ identities: PeerIdentity[] }>('/v1/channels/identities'),
        api<{ user: { id: string; displayName?: string } }>('/v1/auth/me'),
      ]);
      setIdentities(list.status === 'fulfilled' ? list.value.identities ?? [] : []);
      if (meRes.status === 'fulfilled') setMe(meRes.value.user);
    } catch {
      setIdentities([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function link(identity: PeerIdentity, userId: string | null) {
    setBusy(identity.id);
    try {
      await api('/v1/channels/identities/link', {
        method: 'POST',
        body: JSON.stringify({ connectionId: identity.connectionId, channelKind: identity.channelKind, handle: identity.handle, userId }),
      });
      toast.success(userId ? 'Identity linked' : 'Identity unlinked');
      await refresh();
    } catch (err) {
      toast.error('Could not update identity', String(err));
    } finally {
      setBusy(null);
    }
  }

  async function block(identity: PeerIdentity, blocked: boolean) {
    setBusy(identity.id);
    try {
      await api('/v1/channels/identities/block', {
        method: 'POST',
        body: JSON.stringify({ connectionId: identity.connectionId, channelKind: identity.channelKind, handle: identity.handle, blocked }),
      });
      toast.success(blocked ? 'Sender blocked' : 'Sender unblocked', blocked ? 'Their messages are now ignored.' : undefined);
      await refresh();
    } catch (err) {
      toast.error('Could not update sender', String(err));
    } finally {
      setBusy(null);
    }
  }

  async function setAuthority(identity: PeerIdentity, role: 'owner' | 'delegate' | 'external') {
    if (!identity.connectionId) return;
    setBusy(identity.id);
    try {
      if (role === 'external') {
        await api(`/v1/channels/identities/${identity.id}/authority`, { method: 'DELETE' });
      } else {
        await api('/v1/channels/identities/authority', {
          method: 'POST',
          body: JSON.stringify({ connectionId: identity.connectionId, channelKind: identity.channelKind, handle: identity.handle, role }),
        });
      }
      toast.success(role === 'external' ? 'Authority revoked' : role === 'owner' ? 'Primary owner verified' : 'Delegate verified');
      await refresh();
    } catch (err) {
      toast.error('Could not update authority', String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Channel identities</h2>
      <p className="mb-3 text-[13px] text-text-secondary">
        Connection-scoped principals reaching your agents. Linking joins the same person across channels;
        authority explicitly marks the primary owner or a revocable delegate. A default recipient never grants control.
      </p>

      {identities === null ? (
        <Skeleton height={120} />
      ) : identities.length === 0 ? (
        <div className="rounded-card border border-line bg-surface px-4 py-6 text-center text-[13px] text-text-muted">
          No channel senders yet. They appear here after the first inbound message.
        </div>
      ) : (
        <div className="overflow-hidden rounded-card border border-line">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-surface-2 text-[11px] uppercase tracking-wider text-text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Channel</th>
                <th className="px-3 py-2 font-medium">Sender</th>
                <th className="px-3 py-2 font-medium">Authority</th>
                <th className="px-3 py-2 font-medium">Messages</th>
                <th className="px-3 py-2 font-medium">Linked</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {identities.map((identity) => (
                <tr key={identity.id} className={`border-t border-line ${identity.blocked ? 'opacity-60' : ''}`}>
                  <td className="px-3 py-2 capitalize text-text-secondary">{identity.channelKind}</td>
                  <td className="px-3 py-2 text-text-primary">
                    {identity.displayName ?? identity.handle}
                    {identity.displayName && (
                      <span className="ml-1 text-[11px] text-text-muted">({truncate(identity.handle)})</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {identity.authorityRole === 'owner' ? (
                      <span className="inline-flex items-center gap-1 text-[12px] text-accent"><Crown size={12} /> owner</span>
                    ) : identity.authorityRole === 'delegate' ? (
                      <span className="inline-flex items-center gap-1 text-[12px] text-text-primary"><UserCheck size={12} /> delegate</span>
                    ) : <span className="text-[12px] text-text-muted">external</span>}
                  </td>
                  <td className="px-3 py-2 text-text-secondary">{identity.messageCount}</td>
                  <td className="px-3 py-2">
                    {identity.blocked ? (
                      <span className="inline-flex items-center gap-1 text-[12px] text-danger"><Ban size={12} /> blocked</span>
                    ) : identity.peerKey ? (
                      <span className="inline-flex items-center gap-1 text-[12px] text-accent"><Link2 size={12} /> linked</span>
                    ) : (
                      <span className="text-[12px] text-text-muted">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1.5">
                      {identity.blocked ? (
                        <Button size="sm" variant="secondary" disabled={busy === identity.id} onClick={() => void block(identity, false)}>
                          {busy === identity.id ? <Loader2 size={12} className="animate-spin" /> : <><ShieldCheck size={12} className="mr-1" />Unblock</>}
                        </Button>
                      ) : (
                        <>
                          {identity.peerKey ? (
                            <Button size="sm" variant="ghost" disabled={busy === identity.id} onClick={() => void link(identity, null)}>
                              {busy === identity.id ? <Loader2 size={12} className="animate-spin" /> : 'Unlink'}
                            </Button>
                          ) : (
                            <Button size="sm" variant="secondary" disabled={busy === identity.id || !me} onClick={() => me && void link(identity, me.id)}>
                              {busy === identity.id ? <Loader2 size={12} className="animate-spin" /> : 'Link to me'}
                            </Button>
                          )}
                          {identity.connectionId && identity.authorityRole === 'external' && (
                            <>
                              <Button size="sm" variant="ghost" disabled={busy === identity.id} onClick={() => void setAuthority(identity, 'delegate')}>Delegate</Button>
                              <Button size="sm" variant="ghost" disabled={busy === identity.id} onClick={() => void setAuthority(identity, 'owner')}>Owner</Button>
                            </>
                          )}
                          {identity.connectionId && identity.authorityRole !== 'external' && (
                            <Button size="sm" variant="ghost" disabled={busy === identity.id} onClick={() => void setAuthority(identity, 'external')}>Revoke</Button>
                          )}
                          <Button size="sm" variant="ghost" disabled={busy === identity.id} title="Block this sender" onClick={() => void block(identity, true)}>
                            <Ban size={12} />
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function truncate(value: string): string {
  return value.length > 24 ? `${value.slice(0, 21)}…` : value;
}



