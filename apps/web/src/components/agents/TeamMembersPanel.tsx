/**
 * TeamMembersPanel — grant owner/delegate authority directly from Channels.
 *
 * Before this, the only way to promote a phone/handle to verified staff was
 * Settings → Channel Identities — a different tab, and one that only lists a
 * sender AFTER they have messaged in at least once. An operator configuring a
 * channel here had no way to add a team member up front, so "operators"
 * (plural — a whole team, not just the single owner checkbox above) had no
 * home in the surface they were actually looking at.
 *
 * Scoped to one connection. Uses the same identity-authority API as
 * ChannelIdentitiesPanel; `grantAuthority` creates the identity row if the
 * handle has never messaged in, so a team member can be added before their
 * first message — the same "type a number, it just works" pattern the
 * owner/operator checkbox above already uses.
 */

import { useCallback, useEffect, useState } from 'react';
import { Crown, Loader2, Plus, Trash2, UserCheck, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../shared/Button';
import { useToast } from '../shared/Toast';

interface TeamIdentity {
  id: string;
  connectionId: string | null;
  channelKind: string;
  handle: string;
  displayName: string | null;
  authorityRole?: 'external' | 'owner' | 'delegate';
  grantExpiresAt?: string | null;
}

export function TeamMembersPanel({ connectionId, channelKind }: { connectionId: string; channelKind: string }) {
  const toast = useToast();
  const [members, setMembers] = useState<TeamIdentity[] | null>(null);
  const [handle, setHandle] = useState('');
  const [role, setRole] = useState<'owner' | 'delegate'>('delegate');
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api<{ identities: TeamIdentity[] }>('/v1/channels/identities');
      const scoped = (res.identities ?? [])
        .filter((identity) => identity.connectionId === connectionId)
        .filter((identity) => identity.authorityRole && identity.authorityRole !== 'external')
        .filter((identity) => !identity.grantExpiresAt || Date.parse(identity.grantExpiresAt) > Date.now());
      setMembers(scoped);
    } catch {
      setMembers([]);
    }
  }, [connectionId]);

  useEffect(() => {
    if (expanded) void refresh();
  }, [expanded, refresh]);

  async function add() {
    const trimmed = handle.trim();
    if (!trimmed) return;
    setBusy('add');
    try {
      await api('/v1/channels/identities/authority', {
        method: 'POST',
        body: JSON.stringify({ connectionId, channelKind, handle: trimmed, role }),
      });
      toast.success(role === 'owner' ? 'Owner verified' : 'Team member added', 'The agent will recognize them from their next message.');
      setHandle('');
      await refresh();
    } catch (err) {
      toast.error('Could not add team member', String(err));
    } finally {
      setBusy(null);
    }
  }

  async function revoke(member: TeamIdentity) {
    setBusy(member.id);
    try {
      await api(`/v1/channels/identities/${member.id}/authority`, { method: 'DELETE' });
      toast.success('Authority revoked');
      await refresh();
    } catch (err) {
      toast.error('Could not revoke authority', String(err));
    } finally {
      setBusy(null);
    }
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="mt-3 flex items-center gap-1.5 text-[12px] text-text-secondary hover:text-text-primary"
      >
        <Users size={12} /> Team members{members && members.length > 0 ? ` (${members.length})` : ''}
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-input border border-line bg-surface-2 px-3 py-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-text-primary"><Users size={12} /> Team members</span>
        <button type="button" onClick={() => setExpanded(false)} className="text-[11px] text-text-muted hover:text-text-secondary">Hide</button>
      </div>
      <p className="mb-2 text-[11px] text-text-muted">
        Anyone added here is recognized as staff — direct commands, not customer service — never enrolled as a lead.
        A delegate is trusted less than the owner: it cannot change durable agent memory or workspace settings.
      </p>

      {members === null ? (
        <div className="py-2 text-[12px] text-text-muted">Loading…</div>
      ) : members.length > 0 ? (
        <ul className="mb-2 space-y-1">
          {members.map((member) => (
            <li key={member.id} className="flex items-center justify-between rounded-input bg-surface px-2 py-1.5 text-[12px]">
              <span className="flex items-center gap-1.5 text-text-primary">
                {member.authorityRole === 'owner' ? <Crown size={12} className="text-accent" /> : <UserCheck size={12} />}
                {member.displayName ?? member.handle}
                <span className="text-[11px] text-text-muted">{member.authorityRole}</span>
              </span>
              <Button size="sm" variant="ghost" disabled={busy === member.id} title="Revoke authority" onClick={() => void revoke(member)}>
                {busy === member.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mb-2 text-[12px] text-text-muted">No team members added yet.</div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <input
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
          placeholder={channelKind === 'whatsapp' ? '+1 555 000 0000' : 'handle or chat id'}
          className="min-w-0 flex-1 rounded-input border border-line bg-surface px-2 py-1 text-[12px] text-text-primary outline-none focus:border-accent"
        />
        <select
          value={role}
          onChange={(event) => setRole(event.target.value as 'owner' | 'delegate')}
          className="rounded-input border border-line bg-surface px-2 py-1 text-[12px] text-text-primary outline-none focus:border-accent"
        >
          <option value="delegate">Delegate</option>
          <option value="owner">Owner</option>
        </select>
        <Button size="sm" variant="secondary" disabled={busy === 'add' || !handle.trim()} onClick={() => void add()}>
          {busy === 'add' ? <Loader2 size={12} className="animate-spin" /> : <><Plus size={12} className="mr-1" />Add</>}
        </Button>
      </div>
    </div>
  );
}
