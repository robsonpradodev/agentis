import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  Braces,
  Check,
  CircleStop,
  GitBranch,
  Loader2,
  Play,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  Wrench,
} from 'lucide-react';
import clsx from 'clsx';
import type { AgentMission, AppOperation, EffectPlan } from '@agentis/core';
import {
  appsApi,
  type AgenticAppBuild,
  type AgenticAppDefinition,
  type AgenticAppProject,
} from '../../lib/appsApi';
import { apiErrorMessage } from '../../lib/api';

interface Snapshot {
  definition: AgenticAppDefinition | null;
  operations: AppOperation[];
  tasks: AgentMission[];
  effects: EffectPlan[];
  project: AgenticAppProject | null;
  builds: AgenticAppBuild[];
}

const EMPTY: Snapshot = {
  definition: null,
  operations: [],
  tasks: [],
  effects: [],
  project: null,
  builds: [],
};

export function AgenticAppControlPlane({ appId, appName }: { appId: string; appName: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [definitionDraft, setDefinitionDraft] = useState('');
  const [selectedOperation, setSelectedOperation] = useState<string | null>(null);
  const [inputDraft, setInputDraft] = useState('{}');
  const [responses, setResponses] = useState<Record<string, string>>({});

  const refresh = useCallback(
    async (options: { preserveMessage?: boolean } = {}) => {
      try {
        const [definition, operations, tasks, effects, projectState] = await Promise.all([
          appsApi.getAgenticDefinition(appId),
          appsApi.listOperations(appId),
          appsApi.listTasks(appId),
          appsApi.listEffects(appId),
          appsApi.getProject(appId),
        ]);
        const next = {
          definition,
          operations,
          tasks,
          effects,
          project: projectState.project,
          builds: projectState.builds,
        };
        setSnapshot(next);
        setDefinitionDraft(
          JSON.stringify(definition ? definitionPayload(definition) : starterDefinition(), null, 2),
        );
        setSelectedOperation((current) =>
          current && operations.some((operation) => operation.id === current)
            ? current
            : (operations[0]?.id ?? null),
        );
        if (!options.preserveMessage) setMessage(null);
        return true;
      } catch (error) {
        setMessage(apiErrorMessage(error));
        return false;
      } finally {
        setLoading(false);
      }
    },
    [appId],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const operation =
    snapshot.operations.find((candidate) => candidate.id === selectedOperation) ?? null;
  const activeTasks = snapshot.tasks.filter(
    (task) => !['accomplished', 'failed', 'cancelled', 'rejected'].includes(task.status),
  );
  const pendingEffects = snapshot.effects.filter(
    (effect) => effect.status === 'awaiting_authorization',
  );
  const health = useMemo(
    () => ({
      operations: snapshot.operations.length,
      activeTasks: activeTasks.length,
      gates: snapshot.definition?.quality?.releaseGates.length ?? 0,
      p95: snapshot.definition?.quality?.slos.p95LatencyMs ?? null,
    }),
    [activeTasks.length, snapshot.definition, snapshot.operations.length],
  );

  async function act(key: string, action: () => Promise<unknown>, success: string) {
    setBusy(key);
    setMessage(null);
    try {
      await action();
      const refreshed = await refresh({ preserveMessage: true });
      if (refreshed) setMessage(success);
    } catch (error) {
      setMessage(apiErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function saveDefinition() {
    let value: unknown;
    try {
      value = JSON.parse(definitionDraft);
    } catch {
      setMessage('Definition must be valid JSON.');
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      setMessage('Definition must be a JSON object.');
      return;
    }
    await act(
      'definition',
      () => appsApi.updateAgenticDefinition(appId, value as Partial<AgenticAppDefinition>),
      'Manifest v3 definition saved.',
    );
  }

  async function invoke() {
    if (!operation) return;
    let input: unknown;
    try {
      input = JSON.parse(inputDraft);
    } catch {
      setMessage('Operation input must be valid JSON.');
      return;
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      setMessage('Operation input must be a JSON object.');
      return;
    }
    await act(
      `invoke:${operation.id}`,
      () => appsApi.invokeOperation(appId, operation.id, input as Record<string, unknown>),
      `${operation.title} invoked.`,
    );
  }

  if (loading)
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="animate-spin text-accent" size={22} />
      </div>
    );

  return (
    <div className="h-full overflow-y-auto bg-canvas px-5 py-5 text-text-primary">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-4">
        <header className="relative overflow-hidden rounded-xl border border-line bg-surface px-5 py-5">
          <div className="absolute inset-y-0 right-0 w-56 bg-[radial-gradient(circle_at_center,rgba(184,255,88,.12),transparent_68%)]" />
          <div className="relative flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-[10px] font-semibold tracking-[.2em] text-accent">AGENTIC APP · SEMANTIC CONTROL PLANE</p>
              <h2 className="mt-2 text-[23px] font-semibold tracking-tight">{appName}</h2>
              <p className="mt-1 max-w-2xl text-[12px] leading-5 text-text-muted">
                One contract for humans, agents, workflows, MCP and A2A. Every durable action retains authority, cost and evidence.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              className="inline-flex h-8 items-center gap-1.5 rounded-btn border border-line px-3 text-[11px] text-text-secondary hover:bg-canvas"
            >
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
          <div className="relative mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-4">
            <Metric label="OPERATIONS" value={health.operations} />
            <Metric
              label="ACTIVE TASKS"
              value={health.activeTasks}
              accent={health.activeTasks > 0}
            />
            <Metric label="RELEASE GATES" value={health.gates} />
            <Metric label="P95 BUDGET" value={health.p95 == null ? '—' : `${health.p95}ms`} />
          </div>
        </header>

        {message ? (
          <div className="rounded-lg border border-line bg-surface px-4 py-2.5 text-[11px] text-text-secondary">
            {message}
          </div>
        ) : null}

        <div className="grid items-start gap-4 xl:grid-cols-[1.15fr_.85fr]">
          <section className="overflow-hidden rounded-xl border border-line bg-surface">
            <SectionHead
              icon={<Play size={14} />}
              title="Semantic operations"
              meta={`${snapshot.operations.length} declared`}
            />
            {snapshot.operations.length ? (
              <div className="grid min-h-[310px] md:grid-cols-[220px_1fr]">
                <div className="border-b border-line p-2 md:border-b-0 md:border-r">
                  {snapshot.operations.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSelectedOperation(item.id)}
                      className={clsx(
                        'mb-1 w-full rounded-lg px-3 py-2.5 text-left transition-colors',
                        selectedOperation === item.id
                          ? 'bg-accent-soft text-accent'
                          : 'text-text-secondary hover:bg-canvas',
                      )}
                    >
                      <span className="block truncate text-[12px] font-medium">{item.title}</span>
                      <span className="mt-1 block text-[9px] tracking-[.12em] text-text-muted">
                        {item.mode.toUpperCase()} · {item.effects.length} EFFECTS
                      </span>
                    </button>
                  ))}
                </div>
                <div className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-[14px] font-semibold">{operation?.title}</h3>
                      <p className="mt-1 text-[11px] text-text-muted">
                        {operation?.description || operation?.id}
                      </p>
                    </div>
                    <span className="rounded-full border border-line px-2 py-1 text-[9px] tracking-wider text-text-muted">
                      {operation?.handler.kind}
                    </span>
                  </div>
                  <label className="mt-5 block text-[9px] font-semibold tracking-[.15em] text-text-muted">
                    JSON INPUT
                  </label>
                  <textarea
                    value={inputDraft}
                    onChange={(event) => setInputDraft(event.target.value)}
                    spellCheck={false}
                    className="mt-2 h-36 w-full resize-y rounded-lg border border-line bg-[#0d0f0d] p-3 font-mono text-[11px] leading-5 text-[#d9e2ce] outline-none focus:border-accent"
                  />
                  <button
                    type="button"
                    onClick={() => void invoke()}
                    disabled={!operation || busy !== null}
                    className="mt-3 inline-flex h-9 items-center gap-2 rounded-btn bg-accent px-4 text-[11px] font-semibold text-accent-contrast disabled:opacity-40"
                  >
                    {busy?.startsWith('invoke:') ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Play size={13} />
                    )}{' '}
                    Invoke operation
                  </button>
                </div>
              </div>
            ) : (
              <Empty
                icon={<Sparkles size={21} />}
                title="No operations declared"
                body="Define the App's semantic contract in Manifest v3. The UI, agents and protocols will all discover the same operations."
              />
            )}
          </section>

          <section className="overflow-hidden rounded-xl border border-line bg-surface">
            <SectionHead
              icon={<GitBranch size={14} />}
              title="Managed source"
              meta={
                snapshot.project
                  ? (snapshot.project.headCommit?.slice(0, 8) ?? 'initialized')
                  : 'not initialized'
              }
            />
            <div className="p-4">
              {snapshot.project ? (
                <>
                  <div className="rounded-lg border border-line bg-canvas p-3 font-mono text-[10px] leading-5 text-text-secondary">
                    <div>REPO&nbsp;&nbsp;&nbsp;&nbsp; {snapshot.project.repoPath}</div>
                    <div>BRANCH&nbsp; {snapshot.project.defaultBranch}</div>
                    <div>
                      STACK&nbsp;&nbsp;&nbsp; {snapshot.project.framework} /{' '}
                      {snapshot.project.packageManager}
                    </div>
                    <div>REVISION {snapshot.project.headCommit?.slice(0, 12) ?? 'not committed'}</div>
                  </div>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(
                        'build',
                        () => appsApi.buildProject(appId),
                        'Immutable frontend artifact built.',
                      )
                    }
                    className="mt-3 inline-flex h-9 items-center gap-2 rounded-btn border border-accent px-4 text-[11px] font-semibold text-accent hover:bg-accent-soft disabled:opacity-40"
                  >
                    {busy === 'build' ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Wrench size={13} />
                    )}{' '}
                    Build locked revision
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(
                      'project',
                      () => appsApi.initializeProject(appId),
                      'React/Tailwind Git project initialized.',
                    )
                  }
                  className="inline-flex h-9 items-center gap-2 rounded-btn bg-accent px-4 text-[11px] font-semibold text-accent-contrast disabled:opacity-40"
                >
                  {busy === 'project' ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <GitBranch size={13} />
                  )}{' '}
                  Initialize React project
                </button>
              )}
              <div className="mt-4 space-y-2">
                {snapshot.builds.slice(0, 4).map((build) => (
                  <div
                    key={build.id}
                    className="flex items-center gap-3 border-t border-line pt-2 text-[10px]"
                  >
                    <StatusDot status={build.status} />
                    <span className="font-mono text-text-secondary">
                      {build.sourceCommit.slice(0, 8)}
                    </span>
                    <span className="ml-auto uppercase tracking-wider text-text-muted">
                      {build.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>

        <div className="grid items-start gap-4 xl:grid-cols-[1.15fr_.85fr]">
          <section className="overflow-hidden rounded-xl border border-line bg-surface">
            <SectionHead
              icon={<RefreshCw size={14} />}
              title="Durable Tasks"
              meta={`${activeTasks.length} active · ${snapshot.tasks.length} total`}
            />
            <div className="divide-y divide-line">
              {snapshot.tasks.slice(0, 12).map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  effects={snapshot.effects}
                  busy={busy}
                  response={responses}
                  setResponse={setResponses}
                  onAct={act}
                />
              ))}
              {snapshot.tasks.length === 0 ? (
                <Empty
                  icon={<RefreshCw size={20} />}
                  title="No Tasks yet"
                  body="Task-mode operations and effectful commands will appear here and survive disconnects."
                />
              ) : null}
            </div>
          </section>

          <section className="overflow-hidden rounded-xl border border-line bg-surface">
            <SectionHead
              icon={<ShieldCheck size={14} />}
              title="Authority & quality"
              meta={`${pendingEffects.length} approvals pending`}
            />
            <div className="p-4">
              <div className="grid grid-cols-2 gap-2">
                <Policy
                  label="MAX EFFECT"
                  value={snapshot.definition?.permissionsV3?.maxEffectLevel ?? 'read'}
                />
                <Policy
                  label="TASK SPEND"
                  value={
                    snapshot.definition?.permissionsV3?.maxSpendCentsPerTask == null
                      ? 'unbounded'
                      : `${snapshot.definition.permissionsV3.maxSpendCentsPerTask}¢`
                  }
                />
                <Policy
                  label="EVAL SUITES"
                  value={String(snapshot.definition?.quality?.suites.length ?? 0)}
                />
                <Policy
                  label="MCP / A2A"
                  value={`${snapshot.definition?.projections?.mcp.enabled === false ? 'off' : 'on'} / ${snapshot.definition?.projections?.a2a.enabled === false ? 'off' : 'on'}`}
                />
              </div>
              <div className="mt-4 space-y-2">
                {pendingEffects.map((effect) => {
                  const task = snapshot.tasks.find(
                    (candidate) => candidate.id === effect.missionId,
                  );
                  return (
                    <div
                      key={effect.id}
                      className="rounded-lg border border-[#564d29] bg-[#211f14] p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium text-[#eadb8b]">
                          {effect.operationId}
                        </span>
                        <span className="text-[9px] uppercase tracking-wider text-[#a99c61]">
                          {effect.reversibility}
                        </span>
                      </div>
                      <p className="mt-1 text-[10px] text-[#a99c61]">
                        {effect.consequences.join(' · ')}
                      </p>
                      <button
                        type="button"
                        disabled={!task?.authorityContext || busy !== null}
                        onClick={() =>
                          task?.authorityContext &&
                          void act(
                            `effect:${effect.id}`,
                            () => appsApi.authorizeEffect(effect.id, task.authorityContext!),
                            'Effect plan authorized.',
                          )
                        }
                        className="mt-3 inline-flex items-center gap-1.5 rounded-btn border border-[#7b6e34] px-3 py-1.5 text-[10px] text-[#eadb8b] disabled:opacity-40"
                      >
                        {busy === `effect:${effect.id}` ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : (
                          <Check size={11} />
                        )}{' '}
                        Authorize exact plan
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        </div>

        <section className="overflow-hidden rounded-xl border border-line bg-surface">
          <SectionHead
            icon={<Braces size={14} />}
            title="Raw definition"
            meta={`revision ${snapshot.definition?.revision ?? 0}`}
          />
          <div className="border-t border-line p-4">
            <textarea
              value={definitionDraft}
              onChange={(event) => setDefinitionDraft(event.target.value)}
              spellCheck={false}
              className="h-[360px] w-full resize-y rounded-lg border border-line bg-[#0d0f0d] p-4 font-mono text-[11px] leading-5 text-[#d9e2ce] outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={() => void saveDefinition()}
              disabled={busy !== null}
              className="mt-3 inline-flex h-9 items-center gap-2 rounded-btn bg-accent px-4 text-[11px] font-semibold text-accent-contrast disabled:opacity-40"
            >
              {busy === 'definition' ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Save size={13} />
              )}{' '}
              Save definition
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function TaskRow({
  task,
  effects,
  busy,
  response,
  setResponse,
  onAct,
}: {
  task: AgentMission;
  effects: EffectPlan[];
  busy: string | null;
  response: Record<string, string>;
  setResponse: Dispatch<SetStateAction<Record<string, string>>>;
  onAct: (key: string, action: () => Promise<unknown>, success: string) => Promise<void>;
}) {
  const pendingInput = task.inputRequests.find((item) => item.status === 'pending');
  const effect = effects.find(
    (item) => item.missionId === task.id && item.status === 'awaiting_authorization',
  );
  return (
    <div className="p-4">
      <div className="flex items-start gap-3">
        <StatusDot status={task.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="truncate text-[12px]">{task.objective}</strong>
            <span className="rounded-full border border-line px-2 py-0.5 text-[8px] uppercase tracking-wider text-text-muted">
              {task.status}
            </span>
          </div>
          <p className="mt-1 text-[10px] text-text-muted">
            {task.lastProgress || task.id} · {task.childMissionIds?.length ?? 0} children ·{' '}
            {task.receipts?.length ?? 0} receipts
          </p>
          {pendingInput ? (
            <div className="mt-3 flex gap-2">
              <input
                value={response[pendingInput.id] ?? ''}
                onChange={(event) =>
                  setResponse((current) => ({ ...current, [pendingInput.id]: event.target.value }))
                }
                placeholder={pendingInput.description ?? pendingInput.title}
                className="h-8 min-w-0 flex-1 rounded-btn border border-line bg-canvas px-3 text-[11px] outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={() =>
                  void onAct(
                    `input:${task.id}`,
                    () =>
                      appsApi.respondTaskInput(
                        task.id,
                        pendingInput.id,
                        response[pendingInput.id] ?? '',
                      ),
                    'Task input submitted.',
                  )
                }
                className="rounded-btn border border-line px-3 text-[10px] text-text-secondary"
              >
                Submit
              </button>
            </div>
          ) : null}
          {effect ? (
            <p className="mt-2 text-[10px] text-[#c9b765]">
              Waiting for authorization: {effect.operationId}
            </p>
          ) : null}
        </div>
        {!['accomplished', 'failed', 'cancelled', 'rejected'].includes(task.status) ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void onAct(`cancel:${task.id}`, () => appsApi.cancelTask(task.id), 'Task cancelled.')
            }
            className="text-text-muted hover:text-danger"
            title="Cancel Task"
          >
            <CircleStop size={14} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
}) {
  return (
    <div className="bg-canvas px-4 py-3">
      <span className="text-[9px] tracking-[.15em] text-text-muted">{label}</span>
      <strong
        className={clsx(
          'mt-1 block font-mono text-[18px]',
          accent ? 'text-accent' : 'text-text-primary',
        )}
      >
        {value}
      </strong>
    </div>
  );
}
function Policy({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-canvas p-3">
      <span className="text-[8px] tracking-[.14em] text-text-muted">{label}</span>
      <strong className="mt-1 block text-[11px] uppercase text-text-secondary">{value}</strong>
    </div>
  );
}
function SectionHead({ icon, title, meta }: { icon: ReactNode; title: string; meta: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-line px-4 py-3">
      <span className="text-accent">{icon}</span>
      <h3 className="text-[11px] font-semibold uppercase tracking-[.12em]">{title}</h3>
      <span className="ml-auto text-[9px] uppercase tracking-wider text-text-muted">{meta}</span>
    </div>
  );
}
function Empty({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="flex min-h-44 flex-col items-center justify-center px-8 text-center text-text-muted">
      <span className="mb-3 text-accent">{icon}</span>
      <strong className="text-[12px] text-text-secondary">{title}</strong>
      <p className="mt-1 max-w-md text-[10px] leading-4">{body}</p>
    </div>
  );
}
function StatusDot({ status }: { status: string }) {
  const active = ['queued', 'running', 'working', 'replanning', 'waiting'].includes(status);
  const warning = ['input_required', 'approval_required', 'awaiting_authorization'].includes(
    status,
  );
  const success = ['accomplished', 'completed'].includes(status);
  return (
    <span
      className={clsx(
        'mt-1.5 h-2 w-2 shrink-0 rounded-full',
        active && 'bg-accent shadow-[0_0_8px_rgba(184,255,88,.5)]',
        warning && 'bg-[#d7bd55]',
        success && 'bg-[#6ed5a1]',
        !active && !warning && !success && 'bg-text-muted',
      )}
    />
  );
}

function starterDefinition(): Partial<AgenticAppDefinition> {
  return {
    contract: { operations: [], resources: [], events: [] },
    permissionsV3: {
      scopes: [],
      egress: [],
      maxEffectLevel: 'read',
      maxSpendCentsPerTask: null,
      guardrails: [],
    },
    quality: { suites: [], budgets: {}, slos: {}, releaseGates: [] },
    projections: {
      rest: true,
      mcp: { enabled: true, tasks: true },
      a2a: { enabled: true, exposeOperations: [] },
    },
  };
}
function definitionPayload(definition: AgenticAppDefinition): Partial<AgenticAppDefinition> {
  const {
    appId: _a,
    workspaceId: _w,
    revision: _r,
    createdAt: _c,
    updatedAt: _u,
    ...payload
  } = definition;
  return payload;
}
