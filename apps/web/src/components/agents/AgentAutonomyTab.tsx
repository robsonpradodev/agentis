import { useEffect, useState, type ReactNode } from 'react';
import {
  AlertTriangle, AppWindow, Ban, Bell, Check, Clock3, Gauge, Link2, PauseCircle,
  PlayCircle, Plus, Radio, RotateCcw, Save, ShieldCheck, Zap,
} from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { rtSubscribe, useRealtime } from '../../lib/realtime';
import { useToast } from '../shared/Toast';
import { Button } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';
import { StatusBadge } from '../shared/StatusBadge';

interface StandingGoal {
  id: string;
  title: string;
  objective: string;
  status: 'draft' | 'active' | 'paused';
  sourceInstructions: string;
  version: number;
  policy: {
    appIds: string[];
    connectionIds: string[];
    capabilities: string[];
    actionCategories: string[];
    reconciliationIntervalMinutes: number;
    eventWakes: string[];
    maxActionsPerHour?: number | null;
    quietHours?: { start: number; end: number; timezone?: string } | null;
    suppressionEnabled: boolean;
    respectHumanHandoff: boolean;
    ownerNotifications: 'material_and_blockers' | 'blockers_only' | 'all';
  };
  activatedAt?: string | null;
  updatedAt: string;
}

interface AgentMission {
  id: string;
  objective: string;
  status: 'queued' | 'running' | 'waiting' | 'replanning' | 'accomplished' | 'blocked' | 'failed' | 'cancelled';
  currentStepId: string | null;
  lastProgress: string | null;
  blocker: { code: string; detail: string; recoverable: boolean } | null;
  nextWakeAt: string | null;
  updatedAt: string;
  tokensUsed: number;
  outcomeContract: { requiredEffects: Array<{ id?: string; kind: string; targetRef?: string; minimum?: number }> };
  executionPlan?: {
    version: number;
    steps: Array<{
      id: string;
      kind: string;
      title: string;
      status?: 'pending' | 'ready' | 'executing' | 'waiting' | 'verified' | 'failed' | 'cancelled';
      dependsOn?: string[];
      effectRequirementIds?: string[];
      lastError?: string | null;
    }>;
  } | null;
  receipts?: Array<{
    id: string;
    kind: string;
    requirementId?: string | null;
    planStepId?: string | null;
    providerMessageId: string | null;
    resourceId: string | null;
    acknowledged: boolean;
  }>;
}

interface AutonomyStatus {
  status: string;
  lastWakeAt: string | null;
  nextWakeAt: string | null;
  pendingActions: number;
  blocker: string | null;
  activeMissions: number;
  missions: AgentMission[];
  recentOutcomes: Array<{ id: string; status: string; goal: string; at: string }>;
}

interface AutonomyApp { id: string; name: string; ownerAgentId?: string | null; status?: string }
interface AutonomyConnection { id: string; kind: string; name?: string | null; status: string; scope: string; authorityBasis: string }
interface GoalEditorState {
  title: string;
  instructions: string;
  appIds: string[];
  connectionIds: string[];
  actionCategories: string[];
  eventWakes: string[];
  interval: number;
  maxActions: string;
  quietHoursEnabled: boolean;
  quietStart: number;
  quietEnd: number;
  suppressionEnabled: boolean;
  respectHumanHandoff: boolean;
  ownerNotifications: StandingGoal['policy']['ownerNotifications'];
}

const WAKE_OPTIONS = [
  { id: 'lead.created', label: 'New eligible lead' },
  { id: 'channel.inbound', label: 'Inbound message' },
  { id: 'subject.action.due', label: 'Follow-up due' },
  { id: 'approval.resolved', label: 'Approval resolved' },
  { id: 'channel.action.settled', label: 'Delivery status changed' },
  { id: 'workflow.failed', label: 'Execution needs recovery' },
];
const ACTION_OPTIONS = [
  { id: 'external_read', label: 'Read workspace data' },
  { id: 'external_mutation', label: 'Act and update records' },
  { id: 'proactive_followup', label: 'Start follow-ups' },
];

const emptyGoalDraft = (): GoalEditorState => ({
  title: '', instructions: '', appIds: [], connectionIds: [],
  actionCategories: ['external_read', 'external_mutation'],
  eventWakes: ['lead.created', 'channel.inbound', 'subject.action.due', 'approval.resolved', 'channel.action.settled'],
  interval: 15, maxActions: '', quietHoursEnabled: false, quietStart: 22, quietEnd: 7,
  suppressionEnabled: true, respectHumanHandoff: true, ownerNotifications: 'material_and_blockers',
});

function goalDraft(goal: StandingGoal): GoalEditorState {
  return {
    title: goal.title,
    instructions: goal.sourceInstructions,
    appIds: goal.policy.appIds,
    connectionIds: goal.policy.connectionIds,
    actionCategories: goal.policy.actionCategories,
    eventWakes: goal.policy.eventWakes,
    interval: goal.policy.reconciliationIntervalMinutes,
    maxActions: goal.policy.maxActionsPerHour?.toString() ?? '',
    quietHoursEnabled: Boolean(goal.policy.quietHours),
    quietStart: goal.policy.quietHours?.start ?? 22,
    quietEnd: goal.policy.quietHours?.end ?? 7,
    suppressionEnabled: goal.policy.suppressionEnabled,
    respectHumanHandoff: goal.policy.respectHumanHandoff,
    ownerNotifications: goal.policy.ownerNotifications ?? 'material_and_blockers',
  };
}

function relativeTime(iso: string): string {
  try {
    const elapsed = Date.now() - new Date(iso).getTime();
    if (elapsed < 60_000) return 'just now';
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
    if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
    return `${Math.floor(elapsed / 86_400_000)}d ago`;
  } catch { return ''; }
}

export function AgentAutonomyTab({ agent }: { agent: { id: string; name: string } }) {
  const toast = useToast();
  const [goals, setGoals] = useState<StandingGoal[]>([]);
  const [runtime, setRuntime] = useState<AutonomyStatus | null>(null);
  const [apps, setApps] = useState<AutonomyApp[]>([]);
  const [connections, setConnections] = useState<AutonomyConnection[]>([]);
  const [selectedGoalId, setSelectedGoalId] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<GoalEditorState>(emptyGoalDraft);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const selectedGoal = goals.find((goal) => goal.id === selectedGoalId) ?? null;
  const editingLocked = selectedGoal?.status === 'active';

  async function load() {
    try {
      const [data, status, appData, capabilityData] = await Promise.all([
        api<{ goals: StandingGoal[] }>(`/v1/agents/${agent.id}/standing-goals`),
        api<AutonomyStatus>(`/v1/agents/${agent.id}/autonomy-status`),
        api<{ data: AutonomyApp[] }>('/v1/apps'),
        api<{ connections: AutonomyConnection[] }>(`/v1/agents/${agent.id}/effective-capabilities`),
      ]);
      const availableGoals = data.goals ?? [];
      setGoals(availableGoals);
      setRuntime(status);
      setApps(appData.data ?? []);
      setConnections(capabilityData.connections ?? []);
      if (selectedGoalId === null) {
        const initialGoal = availableGoals.find((goal) => goal.status === 'active') ?? availableGoals[0];
        if (initialGoal) { setSelectedGoalId(initialGoal.id); setDraft(goalDraft(initialGoal)); }
        else setSelectedGoalId('new');
      } else if (selectedGoalId !== 'new' && !availableGoals.some((goal) => goal.id === selectedGoalId)) {
        setSelectedGoalId('new');
        setDraft(emptyGoalDraft());
      }
    } catch (error) {
      toast.error('Could not load autonomy controls', apiErrorMessage(error));
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [agent.id]);
  useEffect(() => rtSubscribe('agent', { agentId: agent.id }), [agent.id]);
  useRealtime(['mission.created', 'mission.updated', 'mission.progress', 'mission.settled'], () => { void load(); });

  function selectGoal(goal: StandingGoal) { setSelectedGoalId(goal.id); setDraft(goalDraft(goal)); }
  function newGoal() { setSelectedGoalId('new'); setDraft(emptyGoalDraft()); }
  function toggleList(field: 'appIds' | 'connectionIds' | 'eventWakes' | 'actionCategories', id: string) {
    setDraft((current) => ({
      ...current,
      [field]: current[field].includes(id) ? current[field].filter((value) => value !== id) : [...current[field], id],
    }));
  }
  function payload() {
    return {
      title: draft.title,
      instructions: draft.instructions,
      policy: {
        appIds: draft.appIds,
        connectionIds: draft.connectionIds,
        capabilities: [],
        actionCategories: draft.actionCategories,
        eventWakes: draft.eventWakes,
        reconciliationIntervalMinutes: draft.interval,
        maxActionsPerHour: draft.maxActions.trim() ? Number(draft.maxActions) : null,
        quietHours: draft.quietHoursEnabled
          ? { start: draft.quietStart, end: draft.quietEnd, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
          : null,
        suppressionEnabled: draft.suppressionEnabled,
        respectHumanHandoff: draft.respectHumanHandoff,
        ownerNotifications: draft.ownerNotifications,
      },
    };
  }
  async function saveDraft() {
    if (!draft.title.trim() || !draft.instructions.trim() || editingLocked) return;
    setSaving(true);
    try {
      const result = selectedGoal
        ? await api<{ goal: StandingGoal }>(`/v1/agents/${agent.id}/standing-goals/${selectedGoal.id}`, { method: 'PATCH', body: JSON.stringify(payload()) })
        : await api<{ goal: StandingGoal }>(`/v1/agents/${agent.id}/standing-goals/compile`, { method: 'POST', body: JSON.stringify(payload()) });
      setSelectedGoalId(result.goal.id);
      setDraft(goalDraft(result.goal));
      toast.success(selectedGoal ? `Saved version ${result.goal.version}` : 'Standing goal saved as a draft');
      await load();
    } catch (error) { toast.error('Could not save standing goal', apiErrorMessage(error)); }
    finally { setSaving(false); }
  }
  async function changeStatus(goal: StandingGoal, action: 'activate' | 'pause') {
    try {
      const result = await api<{ goal: StandingGoal }>(`/v1/agents/${agent.id}/standing-goals/${goal.id}/${action}`, { method: 'POST' });
      setDraft(goalDraft(result.goal));
      toast.success(action === 'activate' ? 'Autonomy activated' : 'Goal paused and unlocked for editing');
      await load();
    } catch (error) { toast.error(`Could not ${action} standing goal`, apiErrorMessage(error)); }
  }
  async function missionAction(mission: AgentMission, action: 'resume' | 'cancel') {
    try {
      await api(`/v1/missions/${mission.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify({ reason: `${action === 'resume' ? 'Resumed' : 'Cancelled'} from Agent autonomy control` }),
      });
      toast.success(action === 'resume' ? 'Mission queued to continue' : 'Mission cancelled');
      await load();
    } catch (error) { toast.error(`Could not ${action} mission`, apiErrorMessage(error)); }
  }

  return <div className="mx-auto max-w-6xl space-y-5">
    <section className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line bg-surface-2/40 px-5 py-4">
        <div>
          <div className="flex items-center gap-2"><Zap size={16} className="text-accent" /><h2 className="text-heading text-text-primary">Autonomy control</h2><StatusBadge status={goals.some((goal) => goal.status === 'active') ? 'active' : 'inactive'} size="sm" /></div>
          <p className="mt-1 max-w-2xl text-[12px] leading-5 text-text-secondary">Decide what {agent.name} owns between conversations, where it may act, what wakes it, and which limits always apply.</p>
        </div>
        <Button size="sm" variant="secondary" iconLeft={<Plus size={14} />} onClick={newGoal}>New goal</Button>
      </div>
      <div className="grid divide-y divide-line lg:grid-cols-[300px_minmax(0,1fr)] lg:divide-x lg:divide-y-0">
        <aside className="bg-canvas/25 p-3">
          <div className="grid grid-cols-2 gap-2 p-1">
            <RuntimeStat label="Live missions" value={runtime?.activeMissions ?? 0} />
            <RuntimeStat label="Pending effects" value={runtime?.pendingActions ?? 0} />
            <RuntimeStat label="Last wake" value={runtime?.lastWakeAt ? relativeTime(runtime.lastWakeAt) : 'Never'} />
            <RuntimeStat label="Next wake" value={runtime?.nextWakeAt ? relativeTime(runtime.nextWakeAt) : 'Event driven'} />
          </div>
          {runtime?.blocker && <div className="mx-1 mt-2 rounded-md border border-danger/25 bg-danger/5 p-3 text-[11px] leading-4 text-danger"><AlertTriangle size={13} className="mb-1" />{runtime.blocker}</div>}
          <div className="mb-2 mt-5 px-2 font-mono text-[9px] uppercase tracking-[0.16em] text-text-muted">Standing goals</div>
          <div className="space-y-1">
            {loading ? <Skeleton height={100} /> : goals.length === 0
              ? <div className="rounded-md border border-dashed border-line px-3 py-5 text-center text-[11px] text-text-muted">No saved goals yet.</div>
              : goals.map((goal) => <button key={goal.id} type="button" onClick={() => selectGoal(goal)} className={`w-full rounded-md border px-3 py-3 text-left transition-colors ${selectedGoalId === goal.id ? 'border-accent/50 bg-accent/10' : 'border-transparent hover:border-line hover:bg-surface-2'}`}>
                <div className="flex items-center justify-between gap-2"><span className="truncate text-[12px] font-medium text-text-primary">{goal.title}</span><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${goal.status === 'active' ? 'bg-success' : goal.status === 'paused' ? 'bg-warning' : 'bg-text-muted'}`} /></div>
                <div className="mt-1 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.1em] text-text-muted"><span>{goal.status}</span><span>v{goal.version}</span><span>{goal.policy.reconciliationIntervalMinutes}m</span></div>
              </button>)}
          </div>
        </aside>

        <div className="min-w-0 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
            <div>
              <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-accent">{selectedGoal ? `Goal version ${selectedGoal.version}` : 'New standing goal'}</div>
              <h3 className="mt-1 text-[15px] font-semibold text-text-primary">{selectedGoal ? selectedGoal.title : `Give ${agent.name} an outcome to own`}</h3>
              {editingLocked && <p className="mt-1 text-[11px] text-warning">This goal is live. Pause it before changing its policy.</p>}
            </div>
            <div className="flex gap-2">
              {selectedGoal?.status === 'active'
                ? <Button size="sm" variant="secondary" iconLeft={<PauseCircle size={14} />} onClick={() => void changeStatus(selectedGoal, 'pause')}>Pause to edit</Button>
                : selectedGoal ? <Button size="sm" iconLeft={<PlayCircle size={14} />} onClick={() => void changeStatus(selectedGoal, 'activate')}>Activate</Button> : null}
              <Button size="sm" variant="secondary" iconLeft={<Save size={14} />} loading={saving} disabled={editingLocked || !draft.title.trim() || !draft.instructions.trim()} onClick={() => void saveDraft()}>{selectedGoal ? 'Save new version' : 'Save draft'}</Button>
            </div>
          </div>

          <fieldset disabled={editingLocked} className="mt-5 space-y-6 disabled:opacity-60">
            <EditorSection number="01" title="Outcome" description="The durable result this agent keeps working toward until it is verified or concretely blocked.">
              <label className="block"><span className="text-[11px] font-medium text-text-secondary">Goal name</span><input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} className="mt-1.5 h-9 w-full rounded-md border border-line bg-surface-2 px-3 text-[12px] text-text-primary outline-none focus:border-accent" placeholder="First contact for new leads" /></label>
              <label className="mt-3 block"><span className="text-[11px] font-medium text-text-secondary">Operating instructions</span><textarea value={draft.instructions} onChange={(event) => setDraft((current) => ({ ...current, instructions: event.target.value }))} rows={5} className="mt-1.5 w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-[12px] leading-5 text-text-primary outline-none focus:border-accent" placeholder="Select an eligible lead, send the approved introduction through WhatsApp, verify acknowledgment, then move that exact lead to Contacted." /></label>
            </EditorSection>

            <EditorSection number="02" title="Workspace scope" description="Named resources this goal may use. The agent already owns its connections; selecting one does not create a grant request.">
              <PickerGroup icon={<AppWindow size={13} />} label="Apps" empty="No Apps are available in this workspace.">
                {apps.map((app) => <Picker key={app.id} label={app.name} meta={app.ownerAgentId === agent.id ? 'owned' : app.status} selected={draft.appIds.includes(app.id)} onClick={() => toggleList('appIds', app.id)} />)}
              </PickerGroup>
              <div className="mt-4"><PickerGroup icon={<Link2 size={13} />} label="Connections" empty="This agent has no owned or granted connections.">
                {connections.map((connection) => <Picker key={connection.id} label={connection.name || connection.kind} meta={connection.authorityBasis === 'connection_owner' ? `owned · ${connection.status}` : `granted · ${connection.status}`} selected={draft.connectionIds.includes(connection.id)} onClick={() => toggleList('connectionIds', connection.id)} />)}
              </PickerGroup></div>
              <div className="mt-4"><PickerGroup icon={<ShieldCheck size={13} />} label="Allowed action types" empty="">
                {ACTION_OPTIONS.map((option) => <Picker key={option.id} label={option.label} selected={draft.actionCategories.includes(option.id)} onClick={() => toggleList('actionCategories', option.id)} />)}
              </PickerGroup></div>
            </EditorSection>

            <EditorSection number="03" title="Wake conditions" description="Events resume the same durable mission. Reconciliation is a safety net, not model-powered polling.">
              <div className="grid gap-2 sm:grid-cols-2">{WAKE_OPTIONS.map((option) => <Picker key={option.id} label={option.label} selected={draft.eventWakes.includes(option.id)} onClick={() => toggleList('eventWakes', option.id)} />)}</div>
              <label className="mt-4 flex max-w-sm items-center justify-between gap-4 rounded-md border border-line bg-surface-2 px-3 py-2"><span><span className="block text-[11px] font-medium text-text-secondary">Recovery reconciliation</span><span className="text-[10px] text-text-muted">Check only when events may have been missed</span></span><select value={draft.interval} onChange={(event) => setDraft((current) => ({ ...current, interval: Number(event.target.value) }))} className="h-8 rounded-md border border-line bg-surface px-2 text-[11px] text-text-primary"><option value={5}>5 min</option><option value={15}>15 min</option><option value={30}>30 min</option><option value={60}>1 hour</option></select></label>
            </EditorSection>

            <EditorSection number="04" title="Safety and pace" description="Hard operating constraints remain enforced even when the agent has complete workspace capability.">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="rounded-md border border-line bg-surface-2 p-3"><span className="flex items-center gap-2 text-[11px] font-medium text-text-secondary"><Gauge size={13} /> Maximum actions per hour</span><input type="number" min={1} value={draft.maxActions} onChange={(event) => setDraft((current) => ({ ...current, maxActions: event.target.value }))} className="mt-2 h-8 w-full rounded-md border border-line bg-surface px-2 text-[12px] text-text-primary" placeholder="Use workspace policy" /></label>
                <div className="rounded-md border border-line bg-surface-2 p-3"><div className="flex items-center justify-between"><span className="flex items-center gap-2 text-[11px] font-medium text-text-secondary"><Clock3 size={13} /> Quiet hours</span><MiniSwitch checked={draft.quietHoursEnabled} onChange={(value) => setDraft((current) => ({ ...current, quietHoursEnabled: value }))} /></div>{draft.quietHoursEnabled && <div className="mt-2 flex items-center gap-2"><HourSelect value={draft.quietStart} onChange={(value) => setDraft((current) => ({ ...current, quietStart: value }))} /><span className="text-[10px] text-text-muted">to</span><HourSelect value={draft.quietEnd} onChange={(value) => setDraft((current) => ({ ...current, quietEnd: value }))} /></div>}</div>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2"><PolicyToggle title="Respect suppression and opt-outs" detail="Never contact suppressed Subjects." checked={draft.suppressionEnabled} onChange={(value) => setDraft((current) => ({ ...current, suppressionEnabled: value }))} /><PolicyToggle title="Respect human handoff" detail="Stop automation when a person takes over." checked={draft.respectHumanHandoff} onChange={(value) => setDraft((current) => ({ ...current, respectHumanHandoff: value }))} /></div>
              <label className="mt-3 flex max-w-md items-center justify-between gap-4 rounded-md border border-line bg-surface-2 px-3 py-2"><span className="flex items-center gap-2 text-[11px] font-medium text-text-secondary"><Bell size={13} /> Notify the owner</span><select value={draft.ownerNotifications} onChange={(event) => setDraft((current) => ({ ...current, ownerNotifications: event.target.value as GoalEditorState['ownerNotifications'] }))} className="h-8 rounded-md border border-line bg-surface px-2 text-[11px] text-text-primary"><option value="material_and_blockers">Outcomes and blockers</option><option value="blockers_only">Blockers only</option><option value="all">Every material step</option></select></label>
            </EditorSection>
          </fieldset>
        </div>
      </div>
    </section>
    <MissionRail missions={runtime?.missions ?? []} loading={loading} onAction={missionAction} />
  </div>;
}

function RuntimeStat({ label, value }: { label: string; value: string | number }) {
  return <div className="rounded-md border border-line bg-surface p-3"><div className="font-mono text-[8px] uppercase tracking-[0.14em] text-text-muted">{label}</div><div className="mt-1 truncate text-[12px] font-medium text-text-primary">{value}</div></div>;
}
function EditorSection({ number, title, description, children }: { number: string; title: string; description: string; children: ReactNode }) {
  return <section className="grid gap-4 border-b border-line pb-6 last:border-0 lg:grid-cols-[170px_minmax(0,1fr)]"><div><div className="font-mono text-[9px] uppercase tracking-[0.16em] text-accent">{number}</div><h4 className="mt-1 text-[12px] font-semibold text-text-primary">{title}</h4><p className="mt-1 text-[10.5px] leading-4 text-text-muted">{description}</p></div><div>{children}</div></section>;
}
function PickerGroup({ icon, label, empty, children }: { icon: ReactNode; label: string; empty: string; children: ReactNode }) {
  const items = Array.isArray(children) ? children : [children];
  return <div><div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">{icon}{label}</div><div className="grid gap-2 sm:grid-cols-2">{items.length ? children : <div className="text-[11px] text-text-muted">{empty}</div>}</div></div>;
}
function Picker({ label, meta, selected, onClick }: { label: string; meta?: string | null; selected: boolean; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={`flex min-h-10 items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors ${selected ? 'border-accent/50 bg-accent/10 text-text-primary' : 'border-line bg-surface-2 text-text-secondary hover:border-line-strong'}`}><span className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${selected ? 'border-accent bg-accent text-canvas' : 'border-line-strong'}`}>{selected && <Check size={11} strokeWidth={3} />}</span><span className="min-w-0 flex-1 truncate text-[11px] font-medium">{label}</span>{meta && <span className="font-mono text-[8px] uppercase text-text-muted">{meta}</span>}</button>;
}
function MiniSwitch({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={`relative h-5 w-9 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-surface-3'}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${checked ? 'left-[18px]' : 'left-0.5'}`} /></button>;
}
function PolicyToggle({ title, detail, checked, onChange }: { title: string; detail: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface-2 p-3"><div><div className="text-[11px] font-medium text-text-secondary">{title}</div><div className="mt-0.5 text-[10px] text-text-muted">{detail}</div></div><MiniSwitch checked={checked} onChange={onChange} /></div>;
}
function HourSelect({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return <select value={value} onChange={(event) => onChange(Number(event.target.value))} className="h-8 flex-1 rounded-md border border-line bg-surface px-2 text-[11px] text-text-primary">{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{hour.toString().padStart(2, '0')}:00</option>)}</select>;
}

function MissionRail({ missions, loading, onAction }: { missions: AgentMission[]; loading: boolean; onAction: (mission: AgentMission, action: 'resume' | 'cancel') => Promise<void> }) {
  return <section className="overflow-hidden rounded-xl border border-line bg-surface">
    <div className="flex items-center justify-between border-b border-line px-5 py-4">
      <div>
        <div className="flex items-center gap-2 text-[13px] font-semibold text-text-primary"><Radio size={14} className="text-accent" /> Mission control</div>
        <p className="mt-1 text-[11px] text-text-muted">Business outcomes continue independently of individual model turns.</p>
      </div>
      <span className="rounded-full border border-line bg-surface-2 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">receipt gated</span>
    </div>
    {loading ? <div className="p-5"><Skeleton height={100} /></div> : missions.length === 0
      ? <div className="p-5 text-[12px] text-text-muted">No missions yet. Action requests and workflow runs will appear here.</div>
      : <div className="divide-y divide-line">{missions.map((mission) => {
        const active = ['queued', 'running', 'waiting', 'replanning'].includes(mission.status);
        const receipts = mission.receipts ?? [];
        const receiptRequirementIds = new Set(receipts.map((receipt) => receipt.requirementId).filter(Boolean));
        const receiptKinds = new Set(receipts.map((receipt) => receipt.kind));
        const currentStep = mission.executionPlan?.steps.find((step) => step.id === mission.currentStepId);
        const verifiedSteps = mission.executionPlan?.steps.filter((step) => step.status === 'verified').length ?? 0;
        const totalSteps = mission.executionPlan?.steps.length ?? 0;
        return <details key={mission.id} className="group px-5 py-4" open={active}>
          <summary className="flex cursor-pointer list-none items-start gap-3">
            <div className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md border ${mission.status === 'accomplished' ? 'border-success/30 bg-success/10 text-success' : mission.status === 'blocked' || mission.status === 'failed' ? 'border-danger/30 bg-danger/10 text-danger' : 'border-accent/30 bg-accent/10 text-accent'}`}>
              {mission.status === 'accomplished' ? <ShieldCheck size={14} /> : mission.status === 'blocked' || mission.status === 'failed' ? <AlertTriangle size={14} /> : <Clock3 size={14} />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2"><StatusBadge status={mission.status} size="sm" /><span className="font-mono text-[9px] uppercase tracking-[0.12em] text-text-muted">{mission.id.slice(0, 8)}</span></div>
              <p className="mt-1.5 text-[12.5px] leading-5 text-text-primary">{mission.objective}</p>
              <p className="mt-1 text-[11px] text-text-muted">{currentStep ? `Now: ${currentStep.title}` : mission.lastProgress ?? 'Mission accepted'} · {relativeTime(mission.updatedAt)}</p>
            </div>
          </summary>
          <div className="ml-10 mt-4 grid gap-4 border-l border-line pl-4 sm:grid-cols-[1.2fr_0.8fr]">
            {totalSteps > 0 && <div className="sm:col-span-2">
              <div className="mb-2 flex items-center justify-between gap-3"><div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-text-muted">Execution plan</div><div className="font-mono text-[9px] text-text-muted">{verifiedSteps}/{totalSteps} verified</div></div>
              <div className="overflow-hidden rounded-md border border-line bg-canvas/25">
                {mission.executionPlan!.steps.map((step, index) => {
                  const state = step.status ?? (step.id === mission.currentStepId ? 'executing' : 'pending');
                  const isVerified = state === 'verified';
                  const isFailed = state === 'failed';
                  const isCurrent = step.id === mission.currentStepId && !isVerified;
                  return <div key={step.id} className={`flex items-start gap-3 border-b border-line px-3 py-2.5 last:border-0 ${isCurrent ? 'bg-accent/[0.07]' : ''}`}>
                    <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border font-mono text-[8px] ${isVerified ? 'border-success/35 bg-success/10 text-success' : isFailed ? 'border-danger/35 bg-danger/10 text-danger' : isCurrent ? 'border-accent/40 bg-accent/10 text-accent' : 'border-line bg-surface text-text-muted'}`}>{isVerified ? '✓' : index + 1}</span>
                    <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="text-[11px] font-medium text-text-primary">{step.title}</span><span className="font-mono text-[8px] uppercase tracking-[0.1em] text-text-muted">{state}</span></div>{step.lastError && <p className="mt-1 text-[10px] leading-4 text-danger">{step.lastError}</p>}</div>
                  </div>;
                })}
              </div>
            </div>}
            <div>
              <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-text-muted">Required evidence</div>
              <div className="mt-2 flex flex-wrap gap-1.5">{mission.outcomeContract.requiredEffects.map((effect, index) => {
                const verified = effect.id ? receiptRequirementIds.has(effect.id) : receiptKinds.has(effect.kind);
                return <span key={effect.id ?? `${effect.kind}:${index}`} title={effect.targetRef} className={`rounded border px-2 py-1 font-mono text-[9px] ${verified ? 'border-success/30 bg-success/5 text-success' : 'border-line bg-surface-2 text-text-secondary'}`}>{verified ? '✓ ' : '○ '}{effect.kind}{effect.targetRef ? ` · ${effect.targetRef}` : ''}</span>;
              })}</div>
            </div>
            <div>
              <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-text-muted">Verified receipts</div>
              <div className="mt-2 space-y-1">{receipts.length === 0 ? <span className="text-[10px] text-text-muted">Waiting for evidence</span> : receipts.slice(0, 6).map((receipt) => <div key={receipt.id} className="truncate font-mono text-[9.5px] text-text-secondary">{receipt.kind} · {receipt.providerMessageId ?? receipt.resourceId ?? receipt.id.slice(0, 8)}</div>)}</div>
            </div>
            {mission.blocker && <div className="sm:col-span-2 rounded-md border border-danger/20 bg-danger/5 px-3 py-2 text-[10.5px] text-danger"><span className="font-mono">{mission.blocker.code}</span> · {mission.blocker.detail}</div>}
            <div className="flex gap-2 sm:col-span-2">
              {['blocked', 'failed', 'waiting'].includes(mission.status) && <Button size="sm" variant="secondary" iconLeft={<RotateCcw size={13} />} onClick={() => void onAction(mission, 'resume')}>Resume</Button>}
              {!['accomplished', 'cancelled'].includes(mission.status) && <Button size="sm" variant="ghost" iconLeft={<Ban size={13} />} onClick={() => void onAction(mission, 'cancel')}>Cancel</Button>}
            </div>
          </div>
        </details>;
      })}</div>}
  </section>;
}
