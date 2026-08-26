import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Code2, ExternalLink, HelpCircle, LayoutTemplate, Search, Settings2 } from 'lucide-react';
import clsx from 'clsx';
import * as Collapsible from '@radix-ui/react-collapsible';
import { api } from '../../lib/api';
import { ExtensionCombobox } from './ExtensionCombobox';
import { SchemaDrivenFields } from './genericSchemaForm';
import { schemas } from '@agentis/core';
import { ModelChooser } from '../agents/ModelChooser';
import { SelectedAgentModelControl } from '../agents/SelectedAgentModelControl';
import type { InstalledExtensionOption } from './ExtensionCombobox';
import { describeCron, nextFires, CRON_PRESETS } from '../../lib/cronPreview';
import { NodeTestRunner } from './NodeTestRunner';
import { NodeRuntimePanel } from './NodeRuntimePanel';
import { explainNode } from './nodeExplainer';
import { ListenerHealthPanel } from './ListenerHealthPanel';
import { ListenerInspector } from './ListenerInspector';
import { connectorLogoUrl, connectorAccent } from './connectorLogo';
import { CustomIntegrationDialog } from '../integrations/CustomIntegrationDialog';
import { TemplatedTextField } from './TemplatedTextField';
import { FieldPicker } from './FieldPicker';
import type { UpstreamNode } from './VariablePicker';
import type { AdapterType } from '../agents/RuntimePicker';
import {
  AGENT_AFFORDANCES,
  agentRequirementMatches,
  hasAgentRequirements,
  normalizeAgentRequirements,
  withRequirement,
  type AdapterCapabilitiesLite,
  type AgentAffordanceKey,
} from '../../lib/agentCapabilities';
import {
  evaluateNodeReadiness,
  humanizeIdentifier,
  integrationNeedsCredential,
  nodeConfigMeta,
  type IntegrationManifestLite,
} from './nodeConfigRegistry';
import { useAgentisStore } from '../../store/agentisStore';
import { StatusBadge } from '../shared/StatusBadge';

/** A brand logo for a connector slug, falling back to a colored initial chip. */
function ConnectorLogo({ slug, name, size = 22 }: { slug: string; name: string; size?: number }) {
  const url = connectorLogoUrl(slug);
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className="shrink-0 rounded-[4px] object-contain"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[4px] text-[10px] font-bold text-white"
      style={{ width: size, height: size, backgroundColor: connectorAccent(slug) }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

export interface InspectorSelection {
  kind: 'node' | 'edge' | null;
  nodeType?: string;
  nodeId?: string;
  data?: Record<string, unknown>;
  /** The node's display title (the canvas label) — edited separately from config. */
  title?: string;
}

interface AgentRow { id: string; name: string; adapterType?: string; status?: string; role?: string | null; config?: Record<string, unknown> | null; adapterCapabilities?: AdapterCapabilitiesLite | null; configuredAffordances?: Partial<Record<AgentAffordanceKey, boolean>> | null; potentialAffordances?: Partial<Record<AgentAffordanceKey, boolean>> | null; }
interface SkillRow { id: string; slug: string; name: string; runtime?: string; }
interface WorkflowRow { id: string; title?: string; name?: string; isReusable?: boolean; }
interface KnowledgeBaseRow { id: string; name: string; description?: string | null; }
interface CredentialRow { id: string; name: string; credentialType: string; }
interface OAuthProvider { id: string; label: string; slugs: string[]; configured?: boolean; mode?: string; }
interface ChannelConnectionRow { id: string; kind: string; name: string; status?: string; isDefault?: boolean; agentId?: string | null; }

function credentialMatchesIntegration(credential: CredentialRow, slug: string): boolean {
  const normalized = slug.toLowerCase();
  const haystack = `${credential.credentialType} ${credential.name}`.toLowerCase();
  return haystack.includes(normalized)
    || credential.credentialType.toLowerCase() === `integration_${normalized}`
    || credential.credentialType.toLowerCase() === `oauth_${normalized}`;
}

const KIND_LABEL: Record<string, string> = {
  trigger: 'Trigger',
  agent_task: 'Agent task',
  skill_task: 'Skill',
  skill: 'Skill',
  approval: 'Approval',
  checkpoint: 'Approval',
  router: 'Branch',
  branch: 'Branch',
  merge: 'Merge',
  subflow: 'Subflow',
  knowledge: 'Brain',
  webhook: 'Webhook',
  wait: 'Wait / Timer',
  variables: 'Variables',
  scratchpad: 'Scratchpad',
  return_output: 'Return Output',
  artifact_save: 'Save Artifact',
  browser: 'Browser',
  channel: 'Channel',
};

// "Why this node?" rationale per kind (mirrors the engine's nodeReason()).
const NODE_REASON: Record<string, string> = {
  trigger: 'Starts the workflow — manual, scheduled, or on an incoming event.',
  agent_task: 'A specialist reasons over the input and produces the work product.',
  agent_swarm: 'Fans the task out across parallel agents and merges the results.',
  skill_task: 'Runs a typed, deterministic skill — no LLM tokens spent.',
  router: 'Branches the flow based on the data or an LLM routing decision.',
  branch: 'Branches the flow based on the data or an LLM routing decision.',
  merge: 'Joins parallel branches back into one path.',
  integration: 'Calls an external service (Slack, Gmail, …) with a bound credential.',
  http_request: 'Fetches or posts to an HTTP endpoint with retry/backoff.',
  transform: 'Shapes data deterministically — no LLM tokens spent.',
  filter: 'Drops items that don’t match the condition.',
  wait: 'Pauses the run (crash-recoverable) until a delay or time elapses.',
  knowledge: 'Fetches the most relevant passages from the workspace Brain before the next node runs.',
  checkpoint: 'Pauses for human approval before continuing.',
  approval: 'Pauses for human approval before continuing.',
  return_output: 'Declares the rendered result the operator sees.',
  artifact_save: 'Persists a file artifact to the workspace.',
  browser: 'Renders HTML or captures a screenshot in real Chromium.',
  subflow: 'Runs a reusable sub-workflow as one step.',
  workflow_store: 'Reads/writes shared state across runs of this workflow.',
  scratchpad: 'Holds working variables for the run.',
  channel: 'Delivers on a connected channel (WhatsApp/Telegram/Discord/Slack) — deterministic, no LLM tokens spent.',
};

export function ContextInspector({
  selection,
  workflowId,
  upstream,
  onClose,
  onSave,
  onTitleChange,
  activeRunId,
  onOpenRun,
  className,
}: {
  selection: InspectorSelection;
  /** Required for the per-node Test tab. Omit (null) on canvases that don't yet have a saved workflow id. */
  workflowId?: string | null;
  /** Other nodes in the same workflow, for the variable picker. */
  upstream?: UpstreamNode[];
  onClose: () => void;
  onSave?: (data: Record<string, unknown>) => void;
  /** Rename the node (its canvas label). Separate from config save. */
  onTitleChange?: (title: string) => void;
  /** The run currently watched on the canvas — powers the node's live runtime card. */
  activeRunId?: string | null;
  /** Open a run in the canvas run drawer (stays on the canvas). */
  onOpenRun?: (runId: string) => void;
  className?: string;
}) {
  const [pane, setPane] = useState<'form' | 'json' | 'test'>('form');
  // The raw-JSON editor is an advanced escape hatch, not a co-equal view
  // (masterplan 5.3): hidden behind an "Advanced" toggle so the form is primary.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [titleDraft, setTitleDraft] = useState(selection.title ?? '');
  useEffect(() => { setTitleDraft(selection.title ?? ''); }, [selection.nodeId, selection.title]);
  const [editData, setEditData] = useState<Record<string, unknown>>(selection.data ?? {});
  const [jsonText, setJsonText] = useState(JSON.stringify(selection.data ?? {}, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);
  // Backward-compat alias for sites in the file that still reference `jsonMode`.
  const jsonMode = pane === 'json';
  const setJsonMode = (v: boolean) => setPane(v ? 'json' : 'form');

  // Lazy-load reference data (agents/skills/workflows) when the form needs it.
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowRow[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseRow[]>([]);
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationManifestLite[]>([]);
  const [channelConnections, setChannelConnections] = useState<ChannelConnectionRow[]>([]);

  const kind = ((editData.kind as string | undefined) ?? selection.nodeType ?? '').toLowerCase();
  const needsAgents = kind === 'agent_task' || kind === 'agent_session' || kind === 'agenttask' || kind === 'channel';
  const needsSkills = kind === 'skill_task' || kind === 'skill' || kind === 'extension_task';
  const needsWorkflows = kind === 'subflow' || kind === 'loop';
  const needsKnowledge = kind === 'knowledge';
  const needsCredentials = kind === 'integration' || kind === 'http_request';
  const needsChannels = kind === 'channel';

  useEffect(() => {
    const d = selection.data ?? {};
    setEditData(d);
    setJsonText(JSON.stringify(d, null, 2));
    setJsonError(null);
    setPane('form');
  }, [selection.nodeId, selection.kind]);

  useEffect(() => {
    if (needsAgents && agents.length === 0) {
      void api<{ agents: AgentRow[] }>('/v1/agents').then((d) => setAgents(d.agents ?? [])).catch(() => {});
    }
    if (needsSkills && skills.length === 0) {
      void api<{ skills: SkillRow[] }>('/v1/skills').then((d) => setSkills(d.skills ?? [])).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    if (needsWorkflows && workflows.length === 0) {
      void api<{ workflows: WorkflowRow[] }>('/v1/workflows?isReusable=true').then((d) => setWorkflows(d.workflows ?? [])).catch(() => {});
    }
    if (needsKnowledge && knowledgeBases.length === 0) {
      void api<{ knowledgeBases: KnowledgeBaseRow[] }>('/v1/knowledge-bases').then((d) => setKnowledgeBases(d.knowledgeBases ?? [])).catch(() => {});
    }
    if (needsCredentials && credentials.length === 0) {
      void api<{ credentials: CredentialRow[] }>('/v1/credentials').then((d) => setCredentials(d.credentials ?? [])).catch(() => {});
    }
    if (needsCredentials && oauthProviders.length === 0) {
      void api<{ providers: OAuthProvider[] }>('/v1/oauth/providers').then((d) => setOauthProviders(d.providers ?? [])).catch(() => {});
    }
    if (needsCredentials && integrations.length === 0) {
      void api<{ integrations: IntegrationManifestLite[] }>('/v1/integrations').then((d) => setIntegrations(d.integrations ?? [])).catch(() => {});
    }
    if (needsChannels && channelConnections.length === 0) {
      void api<{ connections: ChannelConnectionRow[] }>('/v1/channels').then((d) => setChannelConnections(d.connections ?? [])).catch(() => {});
    }
  }, [needsAgents, needsSkills, needsWorkflows, needsKnowledge, needsCredentials, needsChannels, agents.length, skills.length, workflows.length, knowledgeBases.length, credentials.length, oauthProviders.length, integrations.length, channelConnections.length]);

  // Resource-name registry — lets the node explainer resolve an extension id to
  // its real name instead of showing a raw identifier.
  const resourceNames = useAgentisStore((s) => s.resourceNames);

  const refreshIntegrations = () => {
    void api<{ integrations: IntegrationManifestLite[] }>('/v1/integrations').then((d) => setIntegrations(d.integrations ?? [])).catch(() => {});
  };

  // Refresh credentials after an inline OAuth connect so the new credential is selectable/bound.
  function refreshCredentials() {
    void api<{ credentials: CredentialRow[] }>('/v1/credentials').then((d) => setCredentials(d.credentials ?? [])).catch(() => {});
  }

  if (!selection.kind) return null;

  function update(patch: Record<string, unknown>) {
    setEditData((prev) => {
      const next = { ...prev, ...patch };
      setJsonText(JSON.stringify(next, null, 2));
      onSave?.(next);
      return next;
    });
  }

  function handleJsonChange(val: string) {
    setJsonText(val);
    try {
      const parsed = JSON.parse(val) as Record<string, unknown>;
      setEditData(parsed);
      setJsonError(null);
      onSave?.(parsed);
    } catch {
      setJsonError('Invalid JSON');
    }
  }

  function handleSave() {
    if (jsonError) return;
    onSave?.(editData);
  }

  const hasChanges = JSON.stringify(editData) !== JSON.stringify(selection.data ?? {});
  const meta = nodeConfigMeta(kind);
  const headingLabel = meta.label ?? selection.nodeType ?? 'Node';
  // Prefer a config-specific explanation ("Emails the digest to you, 0 9 * * *")
  // over the generic per-kind blurb so the node explains itself in context.
  const resolveExtensionName = (idOrSlug: string): string | undefined => {
    if (!idOrSlug) return undefined;
    const bySkill = skills.find((s) => s.id === idOrSlug || s.slug === idOrSlug);
    return bySkill?.name ?? resourceNames[`extension:${idOrSlug}`];
  };
  const nodeReason = selection.kind === 'node'
    ? (explainNode(kind, editData, { resolveExtensionName }) || meta.reason)
    : null;
  const configReadiness = selection.kind === 'node'
    ? evaluateNodeReadiness(editData, { integrations, credentialTypes: credentials.map((credential) => credential.credentialType) })
    : null;
  const readiness = (() => {
    if (!configReadiness || !configReadiness.ready || kind !== 'agent_task') return configReadiness;
    const agentId = typeof editData.agentId === 'string' ? editData.agentId.trim() : '';
    const requirements = normalizeAgentRequirements(editData.requires);
    const liveStatuses = new Set(['online', 'busy', 'active', 'running']);
    if (agentId) {
      const bound = agents.find((agent) => agent.id === agentId);
      if (!bound) return { ready: false, message: 'The assigned agent no longer exists. Choose another agent.' };
      if (!liveStatuses.has(String(bound.status ?? '').toLowerCase())) {
        return { ready: false, message: `${bound.name} has no connected runtime. Reconnect it or choose an online agent.` };
      }
      if (hasAgentRequirements(requirements)) {
        const match = agentRequirementMatches(agents, requirements).find((candidate) => candidate.id === agentId);
        if (match?.state !== 'ready') {
          return { ready: false, message: `${bound.name}'s runtime does not provide every capability required by this step.` };
        }
      }
      return configReadiness;
    }
    if (hasAgentRequirements(requirements)
      && !agentRequirementMatches(agents, requirements).some((candidate) => candidate.state === 'ready')) {
      return { ready: false, message: 'No connected agent provides every capability required by this step.' };
    }
    return configReadiness;
  })();

  return (
    <aside className={clsx('flex w-[360px] shrink-0 flex-col border-l border-line bg-surface text-xs', className)}>
      <header className="flex items-center justify-between border-b border-line px-3 py-2.5">
        <div className="min-w-0">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">
            {selection.kind === 'node' ? 'Node' : 'Edge'}
          </span>
          <div className="text-subheading text-text-primary">{headingLabel}</div>
          {nodeReason && <div className="mt-0.5 text-[11px] leading-snug text-text-secondary" title="What this node does in your workflow">{nodeReason}</div>}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => { setPane('form'); setJsonError(null); }}
            title="Form view"
            className={clsx('rounded p-1 transition-colors', pane === 'form' ? 'text-accent' : 'text-text-muted hover:text-text-primary')}
          >
            <LayoutTemplate size={12} />
          </button>
          {(showAdvanced || pane === 'json') && (
            <button
              type="button"
              onClick={() => { setPane('json'); }}
              title="Advanced — edit raw JSON config"
              className={clsx('rounded p-1 transition-colors', pane === 'json' ? 'text-accent' : 'text-text-muted hover:text-text-primary')}
            >
              <Code2 size={12} />
            </button>
          )}
          <button
            type="button"
            onClick={() => { setShowAdvanced((v) => !v); if (showAdvanced && pane === 'json') setPane('form'); }}
            title="Advanced options"
            className={clsx('rounded p-1 transition-colors', showAdvanced ? 'text-accent' : 'text-text-muted/70 hover:text-text-primary')}
          >
            <Settings2 size={12} />
          </button>
          {selection.kind === 'node' && workflowId && selection.nodeId && (
            <button
              type="button"
              onClick={() => setPane('test')}
              title="Test this node in isolation"
              className={clsx('rounded p-1 transition-colors', pane === 'test' ? 'text-accent' : 'text-text-muted hover:text-text-primary')}
            >
              ▶
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close inspector"
            className="rounded p-1 text-text-muted hover:text-accent"
          >
            ×
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-auto px-3 py-3">
        {pane === 'form' && selection.kind === 'node' && workflowId && selection.nodeId && (
          <NodeRuntimePanel
            workflowId={workflowId}
            nodeId={selection.nodeId}
            activeRunId={activeRunId}
            onOpenRun={onOpenRun}
          />
        )}
        {pane === 'form' && selection.kind === 'node' && onTitleChange && (
          <Field label="Node name" hint="Shown as the node's label on the canvas.">
            <input
              type="text"
              className={inputCls}
              value={titleDraft}
              maxLength={255}
              placeholder={headingLabel}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => {
                const next = titleDraft.trim();
                if (next !== (selection.title ?? '')) onTitleChange(next);
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            />
          </Field>
        )}
        {pane === 'form' && readiness && (
          <div className={clsx(
            'mb-3 rounded-input border px-2.5 py-2 text-[11px]',
            readiness.ready
              ? 'border-success/35 bg-success-soft text-success'
              : 'border-warn/50 bg-warn/10 text-warn',
          )}>
            <div className="font-semibold">{readiness.ready ? 'Ready to run' : 'Setup required'}</div>
            {!readiness.ready && <div className="mt-0.5 text-[10px] text-text-secondary">{readiness.message}</div>}
          </div>
        )}
        {pane === 'test' && workflowId && selection.nodeId ? (
          <NodeTestRunner
            workflowId={workflowId}
            nodeId={selection.nodeId}
            seedInputs={(editData.lastInputData as Record<string, unknown> | undefined) ?? {}}
          />
        ) : pane === 'json' ? (
          <div>
            <textarea
              value={jsonText}
              onChange={(e) => handleJsonChange(e.target.value)}
              rows={20}
              spellCheck={false}
              className={clsx(
                'w-full resize-none rounded-md border bg-surface-2 p-2 font-mono text-[11px] text-text-primary focus:outline-none focus:border-accent',
                jsonError ? 'border-danger' : 'border-line',
              )}
            />
            {jsonError && <div className="mt-1 text-[11px] text-danger">{jsonError}</div>}
          </div>
        ) : (
          <>
            <NodeForm
              kind={kind}
              data={editData}
              update={update}
              agents={agents}
              skills={skills}
              workflows={workflows}
              knowledgeBases={knowledgeBases}
              credentials={credentials}
              oauthProviders={oauthProviders}
              integrations={integrations}
              channelConnections={channelConnections}
              refreshCredentials={refreshCredentials}
              refreshIntegrations={refreshIntegrations}
              upstream={upstream}
              onSkillsChange={() => {
                void api<{ skills: SkillRow[] }>('/v1/skills')
                  .then((d) => setSkills(d.skills ?? []))
                  .catch(() => {});
              }}
              onAgentsChange={() => {
                void api<{ agents: AgentRow[] }>('/v1/agents')
                  .then((d) => setAgents(d.agents ?? []))
                  .catch(() => {});
              }}
            />
            {selection.nodeId && (
              <div className="mb-4 rounded-input border border-line bg-surface-2 p-3">
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    checked={editData.isOutput === true}
                    onChange={(e) => update({ isOutput: e.target.checked ? true : undefined })}
                    className="mt-0.5 rounded border-line bg-surface accent-accent"
                  />
                  <span>
                    <span className="block text-[12px] font-medium text-text-primary">
                      Use as workflow output
                    </span>
                    <span className="mt-0.5 block text-[10px] leading-relaxed text-text-muted">
                      When any node is marked, the Output tab shows only marked nodes from the latest completed run.
                    </span>
                  </span>
                </label>
              </div>
            )}
          </>
        )}

        {selection.nodeId && !jsonMode && (
          <div className="mt-4 border-t border-line/60 pt-3">
            <div className="text-[10px] uppercase tracking-wider text-text-muted">Node ID</div>
            <div className="mt-0.5 break-all font-mono text-[10px] text-text-secondary">{selection.nodeId}</div>
          </div>
        )}
      </div>

      {onSave && (
        <footer className="flex items-center justify-end gap-2 border-t border-line px-3 py-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={!hasChanges || !!jsonError}
            className="inline-flex h-7 items-center rounded-btn bg-accent px-3 text-[12px] font-semibold text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save
          </button>
        </footer>
      )}
    </aside>
  );
}

// ─── Per-kind form renderer ────────────────────────────────────────────────

interface NodeFormProps {
  kind: string;
  data: Record<string, unknown>;
  update: (patch: Record<string, unknown>) => void;
  agents: AgentRow[];
  skills: SkillRow[];
  workflows: WorkflowRow[];
  knowledgeBases: KnowledgeBaseRow[];
  credentials: CredentialRow[];
  oauthProviders: OAuthProvider[];
  integrations: IntegrationManifestLite[];
  channelConnections: ChannelConnectionRow[];
  refreshCredentials: () => void;
  refreshIntegrations: () => void;
  /** Other nodes in the same workflow — populates the variable picker. */
  upstream?: UpstreamNode[];
  onSkillsChange?: () => void;
  onAgentsChange?: () => void;
}

function NodeForm({ kind, data, update, agents, skills, workflows, knowledgeBases, credentials, oauthProviders, integrations, channelConnections, refreshCredentials, refreshIntegrations, upstream, onSkillsChange, onAgentsChange }: NodeFormProps) {
  switch (kind) {
    case 'trigger':
      return <TriggerForm data={data} update={update} />;
    case 'agent_task':
      return <AgentTaskForm data={data} update={update} agents={agents} upstream={upstream} onAgentsChange={onAgentsChange} />;
    case 'agent_session':
      return <AgentTaskForm data={data} update={update} agents={agents} upstream={upstream} session onAgentsChange={onAgentsChange} />;
    case 'agent_swarm':
      return <AgentSwarmForm data={data} update={update} />;
    case 'skill':
    case 'skill_task':
      return <SkillForm data={data} update={update} skills={skills} onSkillsChange={onSkillsChange} />;
    case 'extension_task':
      return <ExtensionTaskForm data={data} update={update} skills={skills} onSkillsChange={onSkillsChange} />;
    case 'component_task':
      return <ComponentTaskForm data={data} update={update} />;
    case 'approval':
    case 'checkpoint':
      return <ApprovalForm data={data} update={update} />;
    case 'router':
    case 'branch':
      return <BranchForm data={data} update={update} />;
    case 'merge':
      return <MergeForm data={data} update={update} />;
    case 'subflow':
      return <SubflowForm data={data} update={update} workflows={workflows} />;
    case 'knowledge':
      return <KnowledgeNodeForm data={data} update={update} knowledgeBases={knowledgeBases} />;
    case 'knowledge_ingest':
      return <KnowledgeIngestForm data={data} update={update} knowledgeBases={knowledgeBases} upstream={upstream} />;
    case 'webhook':
      return <WebhookForm data={data} update={update} />;
    case 'wait':
      return <WaitForm data={data} update={update} />;
    case 'variables':
    case 'scratchpad':
      return <VariablesForm data={data} update={update} />;
    case 'transform':
      return <TransformForm data={data} update={update} upstream={upstream} />;
    case 'filter':
      return <FilterForm data={data} update={update} upstream={upstream} />;
    case 'integration':
      return <IntegrationForm data={data} update={update} upstream={upstream} credentials={credentials} oauthProviders={oauthProviders} integrations={integrations} refreshCredentials={refreshCredentials} refreshIntegrations={refreshIntegrations} />;
    case 'mcp':
      return <McpForm data={data} update={update} />;
    case 'channel':
      return <ChannelForm data={data} update={update} upstream={upstream} connections={channelConnections} agents={agents} />;
    case 'http_request':
      return <HttpRequestForm data={data} update={update} upstream={upstream} credentials={credentials} />;
    case 'workflow_store':
      return <WorkflowStoreForm data={data} update={update} />;
    case 'workspace_store':
      return <WorkflowStoreForm data={data} update={update} workspace />;
    case 'evaluator':
      return <EvaluatorForm data={data} update={update} />;
    case 'guardrails':
      return <GuardrailsForm data={data} update={update} />;
    case 'loop':
      return <LoopForm data={data} update={update} workflows={workflows} />;
    case 'converge':
      return <ConvergeForm data={data} update={update} workflows={workflows} upstream={upstream} />;
    case 'pursue':
      return <PursueForm data={data} update={update} workflows={workflows} upstream={upstream} />;
    case 'parallel':
      return <ParallelForm data={data} update={update} />;
    case 'dynamic_swarm':
      return <DynamicSwarmForm data={data} update={update} />;
    case 'planner':
      return <PlannerForm data={data} update={update} />;
    case 'artifact_collect':
      return <ArtifactCollectForm data={data} update={update} />;
    case 'return_output':
      return <ReturnOutputForm data={data} update={update} upstream={upstream} />;
    case 'artifact_save':
      return <ArtifactSaveForm data={data} update={update} />;
    case 'browser':
      return <BrowserForm data={data} update={update} upstream={upstream} />;
    default:
      // Fallback: schema-driven for the n8n-style utility/data-primitive kinds
      // that have no bespoke form (see genericFormNodeConfigSchemas); raw
      // key/value editor for anything with neither a form nor a schema.
      return <GenericForm kind={kind} data={data} update={update} />;
  }
}

// ─── Reusable atoms ────────────────────────────────────────────────────────

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <label className="mb-1 block text-[11px] font-medium text-text-secondary">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[10px] text-text-muted">{hint}</p>}
    </div>
  );
}

function Accordion({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div className="mb-3 rounded-md border border-line bg-surface-2">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between px-3 py-2 text-[11px] font-medium text-text-secondary hover:text-text-primary"
      >
        <span>{title}</span>
        <span className="text-text-muted">{isOpen ? '−' : '+'}</span>
      </button>
      {isOpen && <div className="border-t border-line/60 px-3 pb-3 pt-2">{children}</div>}
    </div>
  );
}

const inputCls =
  'h-8 w-full rounded-input border border-line bg-surface-2 px-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none';
const selectCls = inputCls;
const textareaCls =
  'w-full resize-none rounded-input border border-line bg-surface-2 px-2 py-1.5 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none';

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function hasAnySecretValue(values: Record<string, string>): boolean {
  return Object.values(values).some((value) => value.trim().length > 0);
}

function isSecretField(field: string): boolean {
  return /token|secret|password|key|credential/i.test(field);
}

function credentialFieldPlaceholder(serviceName: string, field: string): string {
  const label = field
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (char) => char.toUpperCase());
  return `${serviceName ? `${serviceName} ` : ''}${label}`.trim();
}

/** Fallback for the rare manifest without an authored `authHint`. */
function authHintFor(manifest: { name: string; authHint?: string }): string {
  return manifest.authHint ?? `Check ${manifest.name}'s account or developer settings for an API key or access token.`;
}

// ─── Per-kind forms ────────────────────────────────────────────────────────

function TriggerForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  const triggerType = asStr(data.triggerType) || 'manual';
  const schedule = asStr(data.schedule);
  const timezone = asStr(data.timezone) || 'UTC';
  const triggerId = asStr(data.triggerId);
  const cronDescription = useMemo(() => triggerType === 'cron' && schedule ? describeCron(schedule) : null, [triggerType, schedule]);
  const cronNextFires = useMemo(() => triggerType === 'cron' && schedule ? nextFires(schedule, 5) : [], [triggerType, schedule]);
  return (
    <>
      <Field label="Trigger type" hint="How should this workflow start?">
        <select
          className={selectCls}
          value={triggerType}
          onChange={(e) => update({ triggerType: e.target.value })}
        >
          <option value="manual">Manual — run on demand</option>
          <option value="cron">Schedule — recurring (cron)</option>
          <option value="webhook">Webhook — inbound POST</option>
          <option value="persistent_listener">Persistent listener — always-on event source</option>
        </select>
      </Field>
      {triggerType === 'manual' && (
        <div className="mb-3 rounded-md border border-line bg-surface-2 px-2.5 py-2 text-[11px] leading-4 text-text-secondary">
          This workflow only runs when you press <span className="text-text-primary">Run</span>. For something that
          should run on its own — 24/7 monitoring, a schedule, an inbound webhook, or a live source (HTTP poll,
          websocket, another workflow) — pick a trigger type above, then <span className="text-text-primary">Activate</span> it
          from the header (or <span className="text-text-primary">Go&nbsp;Live</span> on the app).
        </div>
      )}
      {triggerType === 'cron' && (
        <>
          <Field label="Cron expression" hint="Five fields: minute hour day-of-month month day-of-week.">
            <input
              type="text"
              className={inputCls + ' font-mono'}
              placeholder="0 9 * * 1"
              value={schedule}
              onChange={(e) => update({ schedule: e.target.value })}
            />
          </Field>
          <Field label="Timezone" hint="IANA timezone used to interpret the cron expression.">
            <input
              type="text"
              className={inputCls}
              placeholder="UTC"
              value={timezone}
              onChange={(e) => update({ timezone: e.target.value })}
            />
          </Field>
          <Field label="Presets">
            <div className="flex flex-wrap gap-1">
              {CRON_PRESETS.map((preset) => (
                <button
                  key={preset.expression}
                  type="button"
                  onClick={() => update({ schedule: preset.expression })}
                  className="rounded-pill border border-line bg-canvas px-2 py-0.5 text-[10px] text-text-secondary hover:border-accent/50 hover:text-text-primary"
                  title={preset.description}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </Field>
          {schedule && (
            <div className="mb-3 rounded-md border border-line bg-surface-2 px-2 py-2 text-[11px]">
              {cronDescription
                ? <div className="text-text-primary">{cronDescription}</div>
                : <div className="text-warn">Could not parse expression — saving anyway, server may still accept it.</div>}
              {cronNextFires.length > 0 && (
                <div className="mt-1.5 border-t border-line/60 pt-1.5">
                  <div className="mb-0.5 text-[10px] uppercase tracking-wider text-text-muted">Next 5 fires (UTC)</div>
                  <ul className="space-y-0.5 font-mono text-[10px] text-text-secondary">
                    {cronNextFires.map((iso) => <li key={iso}>{iso.replace('T', ' ').replace('.000Z', 'Z')}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
        </>
      )}
      {triggerType === 'webhook' && (
        <div className="mb-3 rounded-md border border-line bg-surface-2 px-2 py-2 text-[11px] text-text-secondary">
          Webhook URL is generated when this trigger is registered. The endpoint accepts <code className="rounded bg-canvas px-1">POST</code> with HMAC verification — see the Triggers list for the secret.
        </div>
      )}
      {triggerType === 'persistent_listener' && (
        <>
          <div className="mb-3 rounded-md border border-accent/25 bg-accent-soft px-2.5 py-2 text-[11px] leading-4 text-text-secondary">
            Persistent listeners run 24/7 while Agentis is online. Choose a source, decide which events matter, then control how matching events become workflow runs.
          </div>
          <ListenerInspector data={data} update={update} />
          {triggerId && <ListenerHealthPanel triggerId={triggerId} />}
        </>
      )}
    </>
  );
}

function AgentTaskForm({ data, update, agents, upstream, session = false, onAgentsChange }: { data: Record<string, unknown>; update: NodeFormProps['update']; agents: AgentRow[]; upstream?: UpstreamNode[]; session?: boolean; onAgentsChange?: () => void }) {
  const agentId = asStr(data.agentId);
  const agentRole = asStr(data.agentRole);
  const boundAgent = agents.find((a) => a.id === agentId);
  const adapterType = boundAgent?.adapterType;
  return (
    <>
      {/* Legacy role-cast nodes (authored by the orchestrator, no explicit agentId)
          still show the role so it isn't silently hidden — but binding a specific
          Agent below is the primary path, so nothing here offers to pick a NEW role. */}
      {agentRole && !agentId && (
        <Field label="Specialist role" hint="This task casts to a workspace specialist at run time. Bind a specific agent below to pin it directly.">
          <div className="rounded-input border border-line bg-surface-2 px-2.5 py-1.5 text-[12px] text-text-secondary">{agentRole}</div>
        </Field>
      )}
      <Field label="Agent" hint="Bind the agent that runs this task.">
        <select className={selectCls} value={agentId} onChange={(e) => update({ agentId: e.target.value || undefined })}>
          <option value="">{agentRole ? `— Auto (${agentRole} specialist) —` : '— Pick an agent —'}</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name}{a.status && a.status !== 'online' ? ` (${a.status})` : ''}</option>
          ))}
        </select>
        {boundAgent && boundAgent.status && boundAgent.status !== 'online' && (
          <p className="mt-1 flex items-center gap-1 text-[10px] text-warn">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-warn" /> {boundAgent.status} — connect a runtime or this node fails on first run.
          </p>
        )}
      </Field>
      <CapabilityRequirements data={data} update={update} agents={agents} onAgentsChange={onAgentsChange} />
      {/* This node's OWN model override — the engine honours it FIRST, before the
          agent's global model, and it drives the fallback runtime router when the
          bound agent's adapter isn't live. Previously a bound node (every imported
          one) had no way to set it: the only control shown edited the shared agent,
          so "pick a model on the node" did nothing. Now it always shows. */}
      <ModelPolicyField data={data} update={update} adapterType={adapterType} agentId={agentId} />
      {agentId && (
        <section className="mt-3 rounded-lg border border-line bg-surface-2/45 p-3">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">Agent execution binding</div>
              <p className="mt-1 text-[10.5px] leading-relaxed text-text-muted">
                Runtime and model are resolved together. This binding affects every workflow and chat using the agent; the node override above takes precedence only for this node.
              </p>
            </div>
            <span className="shrink-0 rounded-full border border-line bg-canvas px-2 py-1 font-mono text-[9px] text-text-muted">node → agent → workspace</span>
          </div>
          <SelectedAgentModelControl agentId={agentId} adapterType={adapterType} onUpdated={onAgentsChange} variant="rail" />
        </section>
      )}
      {session && (
        <Field label="Session behavior" hint="Persistent sessions can pause for input and resume without losing context.">
          <label className="flex items-center gap-2 text-[11px] text-text-secondary">
            <input
              type="checkbox"
              checked={data.allowPause !== false}
              onChange={(e) => update({ allowPause: e.target.checked })}
            />
            Allow pause and resume
          </label>
        </Field>
      )}
      <Field label="Prompt" hint="Type `{{` to insert a variable from the trigger or any upstream node.">
        <TemplatedTextField
          multiline
          rows={5}
          placeholder="Describe the task in plain English…"
          value={asStr(data.prompt)}
          onChange={(next) => update({ prompt: next })}
          upstream={upstream}
        />
        <div className="mt-1.5">
          <FieldPicker
            upstream={upstream ?? []}
            dialect="template"
            onInsert={(expr) => {
              const cur = asStr(data.prompt);
              update({ prompt: cur.trim() ? `${cur} ${expr}` : expr });
            }}
          />
        </div>
      </Field>
      <OutputKeysField data={data} update={update} />
    </>
  );
}

/**
 * Typed outputs (reference-builder parity): the agent's declared output keys as
 * pills with "+ Add output". These are the node's OUTPUT CONTRACT — downstream
 * nodes read them by name, the dry-run mocks them, and the runtime reshapes /
 * typed-empty-fills against them.
 */
function OutputKeysField({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  const [draft, setDraft] = useState('');
  const keys = Array.isArray(data.outputKeys) ? (data.outputKeys as unknown[]).map(String).filter(Boolean) : [];
  const commit = () => {
    const key = draft.trim().replace(/\s+/g, '_');
    if (!key || keys.includes(key)) { setDraft(''); return; }
    update({ outputKeys: [...keys, key] });
    setDraft('');
  };
  return (
    <Field label="Outputs" hint="The keys this agent MUST return — its output contract. Downstream nodes read them by name (e.g. nodes['this-node'].caption).">
      <div className="flex flex-wrap items-center gap-1.5">
        {keys.map((key) => (
          <span key={key} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-text-primary">
            {key}
            <button
              type="button"
              aria-label={`Remove output ${key}`}
              className="text-text-muted hover:text-danger"
              onClick={() => update({ outputKeys: keys.filter((k) => k !== key) })}
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          value={draft}
          placeholder={keys.length === 0 ? 'caption' : 'another_key'}
          className="w-28 rounded-full border border-dashed border-line bg-transparent px-2 py-0.5 font-mono text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); } }}
          onBlur={commit}
        />
        <button
          type="button"
          onClick={commit}
          className="text-[11px] font-medium text-accent hover:underline"
        >
          + Add output
        </button>
      </div>
    </Field>
  );
}

function CapabilityRequirements({ data, update, agents, onAgentsChange }: { data: Record<string, unknown>; update: NodeFormProps['update']; agents: AgentRow[]; onAgentsChange?: () => void }) {
  const [enabling, setEnabling] = useState<string | null>(null);
  const requirements = normalizeAgentRequirements(data.requires);
  const matches = agentRequirementMatches(agents, requirements);
  // Agents that can actually help (now, when connected, or after a config change).
  const helpful = matches.filter((m) => m.state !== 'incapable');
  const hasReadyOrCapable = matches.some((m) => m.state === 'ready' || m.state === 'offline_capable');
  const browserRequired = requirements.browser === true || requirements.computerUse === true;
  const showBrowserNodeSteer = browserRequired && !hasReadyOrCapable;

  // Enable a runtime's latent native-browser power (Codex `browser`). This
  // re-registers (reconnects) the agent, so it is gated behind an explicit
  // confirm rather than hot-applied. Preserves the rest of the agent's config.
  async function enableBrowser(agent: AgentRow) {
    const ok = window.confirm(
      `Enable Native browser on “${agent.name}??\n\nThis updates the agent's runtime config (browser = on) and reconnects it so it can take native-browser tasks.`,
    );
    if (!ok) return;
    setEnabling(agent.id);
    try {
      const nextConfig = { ...(agent.config ?? {}), browser: true };
      await api(`/v1/agents/${agent.id}`, { method: 'PATCH', body: JSON.stringify({ config: nextConfig }) });
      onAgentsChange?.();
    } catch {
      /* surfaced by the unchanged match row staying amber */
    } finally {
      setEnabling(null);
    }
  }

  return (
    <Accordion title="What this agent can do" defaultOpen>
      <p className="mb-2 text-[10px] leading-relaxed text-text-muted">
        Hard routing: only runtimes that advertise these native powers can take this task. For ordinary web
        automation (open a page, log in, scrape, screenshot) prefer a <strong>Browser node</strong> instead.
      </p>
      <div className="grid grid-cols-2 gap-1.5">
        {AGENT_AFFORDANCES.map((affordance) => (
          <label
            key={affordance.key}
            className="flex items-center gap-1.5 rounded-md border border-line bg-canvas px-2 py-1.5 text-[11px] text-text-secondary"
            title={affordance.description}
          >
            <input
              type="checkbox"
              aria-label={affordance.label}
              checked={requirements[affordance.key] === true}
              onChange={(event) => update({ requires: withRequirement(requirements, affordance.key, event.target.checked) })}
            />
            {affordance.label}
          </label>
        ))}
      </div>
      {hasAgentRequirements(requirements) && (
        <div className="mt-2 space-y-1 border-t border-line/70 pt-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Agent match</div>
          {helpful.length === 0 && (
            <p className="text-[10px] text-warn">No runtime in this workspace can provide these powers.</p>
          )}
          {helpful.map((match) => (
            <div key={match.id} className="flex items-center justify-between gap-2 rounded-md border border-line bg-canvas px-2 py-1.5 text-[10px]">
              <span className="truncate text-text-primary">{match.name}</span>
              {match.state === 'ready' ? (
                <span className="text-success">ready</span>
              ) : match.state === 'offline_capable' ? (
                <span className="text-text-muted" title="Configured for these powers — connect the runtime to use it.">configured · offline</span>
              ) : (
                <button
                  type="button"
                  disabled={enabling === match.id}
                  onClick={() => void enableBrowser(agents.find((a) => a.id === match.id)!)}
                  className="shrink-0 rounded-btn border border-accent/40 bg-accent/10 px-2 py-0.5 text-accent hover:bg-accent/20 disabled:opacity-50"
                  title={`Turn on ${match.enablable.join(', ')} for this runtime`}
                >
                  {enabling === match.id ? 'Enabling…' : `Enable ${match.enablable.join(', ')}`}
                </button>
              )}
            </div>
          ))}
          {showBrowserNodeSteer && (
            <div className="rounded-md border border-warn/35 bg-warn/10 px-2 py-1.5 text-[10px] leading-relaxed text-warn">
              No runtime advertises {requirements.browser ? 'Native browser' : 'Computer use'} yet. The simplest fix:
              uncheck it here and add a <strong>Browser node</strong> (platform headless Chromium — no runtime setup).
              For genuine agent-driven browser control, enable it on a Codex agent above or connect OpenClaw.
            </div>
          )}
        </div>
      )}
    </Accordion>
  );
}

function ModelPolicyField({ data, update, adapterType, agentId }: { data: Record<string, unknown>; update: NodeFormProps['update']; adapterType?: string; agentId?: string }) {
  const preferredAdapter = asStr(data.preferredAdapter);
  const [catalogAdapter, setCatalogAdapter] = useState<AdapterType>(
    (adapterType as AdapterType | undefined) ?? (preferredAdapter as AdapterType | undefined) ?? 'http',
  );
  useEffect(() => {
    if (adapterType) setCatalogAdapter(adapterType as AdapterType);
  }, [adapterType]);
  return (
    <Accordion title="LLM model policy" defaultOpen>
      {!adapterType && (
        <Field
          label="Runtime"
          hint="Which runtime this task should run on. Only takes effect the first time this role's specialist is created — an already-connected specialist keeps its runtime."
        >
          <select
            className={selectCls}
            value={catalogAdapter}
            onChange={(event) => {
              const next = event.target.value as AdapterType;
              setCatalogAdapter(next);
              update({ preferredAdapter: next === 'http' ? undefined : next });
            }}
          >
            <option value="http">Provider catalog (auto)</option>
            <option value="openclaw">OpenClaw</option>
            <option value="claude_code">Claude Code</option>
            <option value="codex">Codex</option>
            <option value="cursor">Cursor</option>
            <option value="hermes_agent">Hermes</option>
          </select>
        </Field>
      )}
      <Field label="Model override" hint="Keep runtime default for automatic routing, or pin a model for this node.">
        <ModelChooser
          adapterType={catalogAdapter}
          agentId={agentId || undefined}
          value={asStr(data.modelOverride)}
          onChange={(model) => update({ modelOverride: model || undefined })}
        />
      </Field>
    </Accordion>
  );
}

function SkillForm({ data, update, skills, onSkillsChange }: { data: Record<string, unknown>; update: NodeFormProps['update']; skills: SkillRow[]; onSkillsChange?: () => void }) {
  const installed: InstalledExtensionOption[] = skills.map((s) => ({
    id: s.id,
    name: s.name,
    runtime: s.runtime,
  }));
  return (
    <Field label="Skill / Extension" hint="Pick a typed deterministic skill/extension.">
      <ExtensionCombobox
        value={asStr(data.extensionId) || asStr(data.skillId) || ''}
        installed={installed}
        onChange={(id: string) => update({ extensionId: id, skillId: id })}
        onInstalledChange={onSkillsChange}
      />
    </Field>
  );
}

function ExtensionTaskForm({ data, update, skills, onSkillsChange }: { data: Record<string, unknown>; update: NodeFormProps['update']; skills: SkillRow[]; onSkillsChange?: () => void }) {
  return (
    <>
      <SkillForm data={data} update={update} skills={skills} onSkillsChange={onSkillsChange} />
      <Field label="Operation" hint="Typed operation exported by the extension manifest.">
        <input
          className={inputCls + ' font-mono'}
          value={asStr(data.operationName) || 'execute'}
          onChange={(event) => update({ operationName: event.target.value })}
          placeholder="execute"
        />
      </Field>
      <Field label="Input mapping" hint="Map operation inputs to trigger or upstream values. Empty = the whole upstream input passes through.">
        <RawMappingEditor
          mapping={(data.inputMapping as Record<string, string>) || {}}
          onChange={(inputMapping) => update({ inputMapping })}
        />
      </Field>
      <Field label="Output mapping" hint="Copy operation output keys onto the run scratchpad: output key → scratchpad key. Empty = output flows downstream only.">
        <RawMappingEditor
          mapping={(data.outputMapping as Record<string, string>) || {}}
          onChange={(outputMapping) => update({ outputMapping })}
        />
      </Field>
    </>
  );
}

function ComponentTaskForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  return (
    <>
      <Field label="Component ID or slug" hint="The installed Component bundle. Installation verifies its content hash and manifest.">
        <input className={inputCls + ' font-mono'} value={asStr(data.componentSlug) || asStr(data.componentId)} onChange={(event) => update({ componentSlug: event.target.value, componentId: undefined })} placeholder="my-python-component" />
      </Field>
      <Field label="Pinned version" hint="Required by the editor so production runs remain reproducible.">
        <input className={inputCls + ' font-mono'} value={asStr(data.version)} onChange={(event) => update({ version: event.target.value })} placeholder="1.0.0" />
      </Field>
      <Field label="Operation">
        <input className={inputCls + ' font-mono'} value={asStr(data.operationName) || 'execute'} onChange={(event) => update({ operationName: event.target.value })} placeholder="execute" />
      </Field>
      <Field label="Input mapping" hint="Empty passes the whole upstream input to the component.">
        <RawMappingEditor mapping={(data.inputMapping as Record<string, string>) || {}} onChange={(inputMapping) => update({ inputMapping })} />
      </Field>
      <Field label="Output mapping" hint="Copy component outputs onto the run scratchpad.">
        <RawMappingEditor mapping={(data.outputMapping as Record<string, string>) || {}} onChange={(outputMapping) => update({ outputMapping })} />
      </Field>
    </>
  );
}

function ApprovalForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  const mode = asStr(data.approvalMode) || 'manual';
  return (
    <>
      <Field label="Mode" hint="Manual review, or auto-approve after a timeout?">
        <select
          className={selectCls}
          value={mode}
          onChange={(e) => update({ approvalMode: e.target.value })}
        >
          <option value="manual">Wait for human review</option>
          <option value="auto_after_timeout">Auto-approve after timeout</option>
        </select>
      </Field>
      {mode === 'auto_after_timeout' && (
        <Field label="Timeout (ms)">
          <input
            type="number"
            className={inputCls}
            value={typeof data.timeoutMs === 'number' ? data.timeoutMs : ''}
            onChange={(e) => update({ timeoutMs: e.target.value === '' ? undefined : Number(e.target.value) })}
          />
        </Field>
      )}
    </>
  );
}

function BranchForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  const mode = asStr(data.routingMode) || 'first_match';
  const branches = Array.isArray(data.branches)
    ? data.branches as Array<{ label?: string; condition?: string }>
    : [];
  return (
    <>
      <Field label="Routing" hint="Choose how branches are picked.">
        <select className={selectCls} value={mode} onChange={(e) => update({ routingMode: e.target.value })}>
          <option value="first_match">First branch that matches</option>
          <option value="all_matching">All branches that match (fan-out)</option>
          <option value="llm_route">Let an LLM decide</option>
        </select>
      </Field>
      <Field label="Branches" hint="Branches are evaluated from top to bottom.">
        <div className="space-y-1.5">
          {branches.map((branch, index) => (
            <div key={index} className="rounded-md border border-line bg-surface-2 p-2">
              <div className="flex gap-1.5">
                <input className={inputCls} value={branch.label ?? ''} placeholder="Label" onChange={(event) => {
                  const next = [...branches];
                  next[index] = { ...branch, label: event.target.value };
                  update({ branches: next });
                }} />
                <button type="button" aria-label="Remove branch" className="px-1.5 text-text-muted hover:text-danger" onClick={() => update({ branches: branches.filter((_, branchIndex) => branchIndex !== index) })}>×</button>
              </div>
              <input className={inputCls + ' mt-1.5 font-mono'} value={branch.condition ?? ''} placeholder="input.score > 0.8" onChange={(event) => {
                const next = [...branches];
                next[index] = { ...branch, condition: event.target.value };
                update({ branches: next });
              }} />
            </div>
          ))}
          <button type="button" className="inline-flex h-7 items-center rounded-btn border border-line px-2 text-[11px] text-text-secondary hover:border-accent/60 hover:text-text-primary" onClick={() => update({ branches: [...branches, { label: `Branch ${branches.length + 1}`, condition: '' }] })}>
            + Add branch
          </button>
        </div>
      </Field>
      {mode === 'llm_route' && <ModelPolicyField data={data} update={update} />}
    </>
  );
}

function MergeForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  return (
    <>
      <Field label="Wait for" hint="Choose whether all incoming branches or the first available result should continue.">
        <select className={selectCls} value={asStr(data.requiredInputs) || 'all'} onChange={(event) => update({ requiredInputs: event.target.value })}>
          <option value="all">All incoming branches</option>
          <option value="first">First completed branch</option>
        </select>
      </Field>
      <Field label="Merge strategy">
        <select className={selectCls} value={asStr(data.mergeStrategy) || 'merge_keys'} onChange={(event) => update({ mergeStrategy: event.target.value })}>
          <option value="merge_keys">Merge object keys</option>
          <option value="collect_all">Collect into an array</option>
          <option value="first_non_null">Use first non-null result</option>
        </select>
      </Field>
    </>
  );
}

function SubflowForm({ data, update, workflows }: { data: Record<string, unknown>; update: NodeFormProps['update']; workflows: WorkflowRow[] }) {
  return (
    <Field label="Embedded workflow" hint="Pick a reusable workflow to run as a step here.">
      <select
        className={selectCls}
        value={asStr(data.workflowId)}
        onChange={(e) => update({ workflowId: e.target.value })}
      >
        <option value="">— Pick a workflow —</option>
        {workflows.map((w) => (
          <option key={w.id} value={w.id}>{w.title ?? w.name ?? 'Untitled'}</option>
        ))}
      </select>
    </Field>
  );
}

function KnowledgeNodeForm({ data, update, knowledgeBases }: { data: Record<string, unknown>; update: NodeFormProps['update']; knowledgeBases: KnowledgeBaseRow[] }) {
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<Array<{ id: string; content: string; score: number }>>([]);
  const queryMode = asStr(data.queryMode) || 'static';
  const knowledgeBaseId = asStr(data.knowledgeBaseId);
  const query = asStr(data.query);
  const topK = typeof data.topK === 'number' ? data.topK : 5;

  async function testRetrieval() {
    if (!knowledgeBaseId || !query.trim()) return;
    setTesting(true);
    try {
      const response = await api<{ results: Array<{ id: string; content: string; score: number }> }>(`/v1/knowledge-bases/${knowledgeBaseId}/search`, {
        method: 'POST',
        body: JSON.stringify({ query: query.trim(), topK }),
      });
      setResults(response.results ?? []);
    } finally {
      setTesting(false);
    }
  }

  return (
    <>
      <Field label="Knowledge base">
        <select className={selectCls} value={knowledgeBaseId} onChange={(e) => update({ knowledgeBaseId: e.target.value })}>
          <option value="">All workspace knowledge</option>
          {knowledgeBases.map((base) => <option key={base.id} value={base.id}>{base.name}</option>)}
        </select>
      </Field>
      <Field label="Query source">
        <select className={selectCls} value={queryMode} onChange={(e) => update({ queryMode: e.target.value })}>
          <option value="static">Static query</option>
          <option value="dynamic">From previous node output</option>
        </select>
      </Field>
      {queryMode === 'static' ? (
        <Field label="Query">
          <textarea className={textareaCls} rows={4} value={query} onChange={(e) => update({ query: e.target.value })} placeholder="What should this workflow retrieve?" />
        </Field>
      ) : (
        <>
          <Field label="Source node ID">
            <input className={inputCls} value={asStr(data.queryNodeId)} onChange={(e) => update({ queryNodeId: e.target.value })} placeholder="node-id" />
          </Field>
          <Field label="Output path">
            <input className={inputCls} value={asStr(data.queryPath)} onChange={(e) => update({ queryPath: e.target.value })} placeholder="$.company.description" />
          </Field>
        </>
      )}
      <Field label="Retrieval mode">
        <select className={selectCls} value={asStr(data.retrievalMode) || 'contextual'} onChange={(e) => update({ retrievalMode: e.target.value })}>
          <option value="contextual">Contextual</option>
          <option value="strict">Strict</option>
          <option value="exploratory">Exploratory</option>
        </select>
      </Field>
      <Field label="Top results">
        <input className={inputCls} type="number" min={1} max={20} value={topK} onChange={(e) => update({ topK: Number(e.target.value) })} />
      </Field>
      <button
        type="button"
        disabled={!knowledgeBaseId || !query.trim() || testing || queryMode !== 'static'}
        onClick={() => void testRetrieval()}
        className="mb-3 inline-flex h-8 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-2.5 text-[12px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Search size={12} /> {testing ? 'Testing...' : 'Test retrieval'}
      </button>
      {results.length > 0 && (
        <div className="space-y-2">
          {results.map((result) => (
            <div key={result.id} className="rounded-md border border-line bg-surface-2 p-2">
              <div className="mb-1 text-[10px] text-text-muted">score {Math.round(result.score * 100)}%</div>
              <p className="line-clamp-3 text-[11px] leading-relaxed text-text-secondary">{result.content}</p>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// knowledge_ingest — write-side twin of `knowledge` (WorkflowEngine.ts
// #executeKnowledgeIngest). `contentPath`/`documentNamePath` win over their
// static `content`/`documentName` siblings when both are set; an unset
// `knowledgeBaseId` creates (or reuses) a base named `knowledgeBaseName`.
function KnowledgeIngestForm({ data, update, knowledgeBases, upstream }: { data: Record<string, unknown>; update: NodeFormProps['update']; knowledgeBases: KnowledgeBaseRow[]; upstream?: UpstreamNode[] }) {
  const knowledgeBaseId = asStr(data.knowledgeBaseId);
  const contentSource = asStr(data.contentPath) ? 'dynamic' : 'static';
  const nameSource = asStr(data.documentNamePath) ? 'dynamic' : 'static';
  return (
    <>
      <Field label="Knowledge base" hint="Leave unset to create (or reuse) a base named below.">
        <select
          className={selectCls}
          value={knowledgeBaseId}
          onChange={(e) => update({ knowledgeBaseId: e.target.value || undefined })}
        >
          <option value="">— Create new —</option>
          {knowledgeBases.map((base) => <option key={base.id} value={base.id}>{base.name}</option>)}
        </select>
      </Field>
      {!knowledgeBaseId && (
        <Field label="New knowledge base name" hint="Defaults to the workflow's title when left blank.">
          <input
            type="text"
            className={inputCls}
            placeholder="Workflow Knowledge"
            value={asStr(data.knowledgeBaseName)}
            onChange={(e) => update({ knowledgeBaseName: e.target.value || undefined })}
          />
        </Field>
      )}
      <Field label="Content source">
        <select
          className={selectCls}
          value={contentSource}
          onChange={(e) => {
            if (e.target.value === 'static') update({ contentPath: undefined });
            else update({ content: undefined });
          }}
        >
          <option value="static">Static text</option>
          <option value="dynamic">From previous node output (path)</option>
        </select>
      </Field>
      {contentSource === 'static' ? (
        <Field label="Content" hint="The document text to ingest. Empty uses the whole node input.">
          <TemplatedTextField
            value={asStr(data.content)}
            onChange={(next) => update({ content: next || undefined })}
            multiline
            rows={5}
            upstream={upstream}
            placeholder="Paste or template the document content…"
          />
        </Field>
      ) : (
        <Field label="Content path" hint="Dot path into the node input resolving to the document text.">
          <input
            type="text"
            className={inputCls}
            placeholder="$.report.body"
            value={asStr(data.contentPath)}
            onChange={(e) => update({ contentPath: e.target.value || undefined })}
          />
        </Field>
      )}
      <Field label="Document name source">
        <select
          className={selectCls}
          value={nameSource}
          onChange={(e) => {
            if (e.target.value === 'static') update({ documentNamePath: undefined });
            else update({ documentName: undefined });
          }}
        >
          <option value="static">Static text</option>
          <option value="dynamic">From previous node output (path)</option>
        </select>
      </Field>
      {nameSource === 'static' ? (
        <Field label="Document name" hint="Defaults to a timestamped name when left blank.">
          <TemplatedTextField
            value={asStr(data.documentName)}
            onChange={(next) => update({ documentName: next || undefined })}
            upstream={upstream}
            placeholder="Weekly report — {{trigger.date}}"
          />
        </Field>
      ) : (
        <Field label="Document name path">
          <input
            type="text"
            className={inputCls}
            placeholder="$.report.title"
            value={asStr(data.documentNamePath)}
            onChange={(e) => update({ documentNamePath: e.target.value || undefined })}
          />
        </Field>
      )}
      <Field label="MIME type (optional)">
        <input
          type="text"
          className={inputCls}
          placeholder="text/plain"
          value={asStr(data.mimeType)}
          onChange={(e) => update({ mimeType: e.target.value || undefined })}
        />
      </Field>
    </>
  );
}

function WebhookForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  return (
    <>
      <Field label="URL" hint="Destination endpoint that will receive the POST.">
        <input
          type="url"
          className={inputCls}
          placeholder="https://example.com/hook"
          value={asStr(data.url)}
          onChange={(e) => update({ url: e.target.value })}
        />
      </Field>
      <Field label="HTTP method">
        <select className={selectCls} value={asStr(data.method) || 'POST'} onChange={(e) => update({ method: e.target.value })}>
          <option value="POST">POST</option>
          <option value="PUT">PUT</option>
          <option value="PATCH">PATCH</option>
          <option value="GET">GET</option>
          <option value="DELETE">DELETE</option>
        </select>
      </Field>
    </>
  );
}

function WaitForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  // Engine config is `delayMs` (number). Migrate older nodes that still carry
  // `durationSeconds` by converting on first edit.
  const ms = typeof data.delayMs === 'number'
    ? data.delayMs
    : typeof data.durationSeconds === 'number'
      ? data.durationSeconds * 1000
      : 0;
  const seconds = Math.floor(ms / 1000);
  return (
    <Field label="Wait (seconds)" hint="The run pauses on this node for this duration before continuing.">
      <input
        type="number"
        className={inputCls}
        min={0}
        value={seconds}
        onChange={(e) => {
          const s = e.target.value === '' ? 0 : Math.max(0, Number(e.target.value));
          update({ delayMs: s * 1000, durationSeconds: undefined });
        }}
      />
    </Field>
  );
}

// ─── Transform & Filter ─────────────────────────────────────────────────────

function TransformForm({ data, update, upstream }: { data: Record<string, unknown>; update: NodeFormProps['update']; upstream?: UpstreamNode[] }) {
  return (
    <>
      <Field
        label="Expression"
        hint="A JS expression. Use `input`, `ctx`, or aliases like `nodes` and `trigger`. Type `{{` to insert template references."
      >
        <TemplatedTextField
          multiline
          mono
          rows={6}
          placeholder="({ name: input.user.fullName, domain: input.user.email.split('@')[1] })"
          value={asStr(data.expression)}
          onChange={(next) => update({ expression: next })}
          upstream={upstream}
        />
        <div className="mt-1.5">
          <FieldPicker
            upstream={upstream ?? []}
            dialect="js"
            onInsert={(expr) => {
              const cur = asStr(data.expression);
              update({ expression: cur.trim() ? `${cur} ${expr}` : expr });
            }}
          />
        </div>
      </Field>
      <Field label="Output key (optional)" hint="Wraps the expression result under this key. Leave blank to use the result directly.">
        <input
          type="text"
          className={inputCls}
          placeholder="extracted"
          value={asStr(data.outputKey)}
          onChange={(e) => update({ outputKey: e.target.value || undefined })}
        />
      </Field>
      <Field label="Timeout (ms, optional)" hint="Leave blank for the engine's workload-aware deadline. Maximum 30000 ms.">
        <input
          type="number"
          min={1}
          max={30000}
          className={inputCls}
          placeholder="Automatic"
          value={typeof data.timeoutMs === 'number' ? data.timeoutMs : ''}
          onChange={(e) => update({ timeoutMs: e.target.value === '' ? undefined : Number(e.target.value) })}
        />
      </Field>
    </>
  );
}

function FilterForm({ data, update, upstream }: { data: Record<string, unknown>; update: NodeFormProps['update']; upstream?: UpstreamNode[] }) {
  return (
    <>
      <Field label="Condition" hint="Boolean JS expression — truthy passes the input through; falsy stops this branch.">
        <TemplatedTextField
          multiline
          mono
          rows={3}
          placeholder="input.score > 0.7"
          value={asStr(data.condition)}
          onChange={(next) => update({ condition: next })}
          upstream={upstream}
        />
        <div className="mt-1.5">
          <FieldPicker
            upstream={upstream ?? []}
            dialect="js"
            onInsert={(expr) => {
              const cur = asStr(data.condition);
              update({ condition: cur.trim() ? `${cur} ${expr}` : expr });
            }}
          />
        </div>
      </Field>
      <Field label="Timeout (ms, optional)" hint="Leave blank for the engine's workload-aware deadline. Maximum 30000 ms.">
        <input
          type="number"
          min={1}
          max={30000}
          className={inputCls}
          placeholder="Automatic"
          value={typeof data.timeoutMs === 'number' ? data.timeoutMs : ''}
          onChange={(e) => update({ timeoutMs: e.target.value === '' ? undefined : Number(e.target.value) })}
        />
      </Field>
    </>
  );
}

// ─── Integration & HTTP ─────────────────────────────────────────────────────

function schemaProps(schema: unknown): Array<{ key: string; type: string; description?: string; required: boolean }> {
  if (!schema || typeof schema !== 'object') return [];
  const s = schema as { properties?: Record<string, unknown>; required?: string[] };
  if (!s.properties || typeof s.properties !== 'object') return [];
  const required = new Set(Array.isArray(s.required) ? s.required : []);
  return Object.entries(s.properties).map(([key, raw]) => {
    const spec = (raw && typeof raw === 'object' ? raw : {}) as { type?: string; description?: string };
    return { key, type: typeof spec.type === 'string' ? spec.type : 'any', description: spec.description, required: required.has(key) };
  });
}

function RawMappingEditor({ mapping, onChange }: { mapping: Record<string, string>; onChange: (m: Record<string, string>) => void }) {
  const entries = Object.entries(mapping);
  const [newKey, setNewKey] = useState('');
  return (
    <div className="mb-3 space-y-1.5">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-center gap-1.5">
          <input className={inputCls + ' font-mono'} value={key} readOnly />
          <input
            className={inputCls}
            value={value}
            placeholder="{{ ... }}"
            onChange={(e) => onChange({ ...mapping, [key]: e.target.value })}
          />
          <button
            type="button"
            className="shrink-0 rounded-md px-1.5 text-text-muted hover:text-danger"
            onClick={() => { const next = { ...mapping }; delete next[key]; onChange(next); }}
          >
            ×
          </button>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <input
          className={inputCls + ' font-mono'}
          value={newKey}
          placeholder="input key"
          onChange={(e) => setNewKey(e.target.value)}
        />
        <button
          type="button"
          className="shrink-0 rounded-md border border-line px-2 py-1 text-[11px] text-text-secondary hover:border-accent/50 hover:text-text-primary"
          onClick={() => { if (newKey.trim()) { onChange({ ...mapping, [newKey.trim()]: '' }); setNewKey(''); } }}
        >
          + Add
        </button>
      </div>
    </div>
  );
}

function IntegrationForm({ data, update, upstream: _upstream, credentials, oauthProviders, integrations, refreshCredentials, refreshIntegrations }: { data: Record<string, unknown>; update: NodeFormProps['update']; upstream?: UpstreamNode[]; credentials: CredentialRow[]; oauthProviders: OAuthProvider[]; integrations: IntegrationManifestLite[]; refreshCredentials: () => void; refreshIntegrations: () => void }) {
  const { setSettingsOpen } = useAgentisStore();
  const slug = asStr(data.integrationId);
  const credentialId = asStr(data.credentialId);
  const manifest = integrations.find((item) => item.service === slug || item.id === slug);
  const operationId = asStr(data.operationId) || manifest?.operations[0] || '';
  const matching = slug
    ? credentials.filter((credential) => credentialMatchesIntegration(credential, slug))
    : [];
  const bound = credentials.find((credential) => credential.id === credentialId);
  const provider = slug ? oauthProviders.find((item) => item.slugs.includes(slug.toLowerCase())) : undefined;
  const needsCredential = integrationNeedsCredential(manifest);
  // OAuth-only services (e.g. Gmail) must show a "Sign in with X" button — never
  // an API-key field, which can't authenticate them.
  const isOAuth = (manifest?.auth?.type ?? manifest?.credentialSchema?.type) === 'oauth2';
  const credentialFields = useMemo(
    () => {
      const fields = manifest?.credentialSchema?.fields;
      return Array.isArray(fields) && fields.length > 0
        ? fields.map((field) => String(field))
        : ['token'];
    },
    [manifest],
  );
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [connecting, setConnecting] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [savingCredential, setSavingCredential] = useState(false);
  const [integrationQuery, setIntegrationQuery] = useState('');
  const [showCreateIntegration, setShowCreateIntegration] = useState(false);
  const visibleIntegrations = useMemo(() => {
    const query = integrationQuery.trim().toLowerCase();
    return integrations
      .filter((item) => !query || `${item.name} ${item.service} ${item.category ?? ''}`.toLowerCase().includes(query))
      .sort((left, right) => Number(right.service === slug) - Number(left.service === slug) || left.name.localeCompare(right.name));
  }, [integrationQuery, integrations, slug]);

  function chooseIntegration(next: IntegrationManifestLite) {
    const savedCredential = credentials.find((credential) => credentialMatchesIntegration(credential, next.service));
    update({
      integrationId: next.service,
      operationId: next.operations[0] ?? undefined,
      credentialId: savedCredential?.id,
    });
    setSecretValues({});
  }

  function connectOAuth() {
    if (!provider) return;
    setOauthError(null);
    if (provider.configured === false) {
      setOauthError(`${provider.label} sign-in isn't set up on this server yet — open Settings → Integrations to paste your own OAuth app's Client ID/Secret.`);
      return;
    }
    setConnecting(true);
    void api<{ url: string }>(`/v1/oauth/${provider.id}/authorize`, {
      method: 'POST',
      body: JSON.stringify({ integrationSlug: slug, origin: window.location.origin }),
    }).then(({ url }) => {
      const popup = window.open(url, 'agentis-oauth', 'popup,width=520,height=680');
      const onMessage = (event: MessageEvent) => {
        const message = event.data as { type?: string; ok?: boolean; credentialId?: string };
        if (message?.type !== 'agentis-oauth') return;
        window.removeEventListener('message', onMessage);
        setConnecting(false);
        if (message.ok && message.credentialId) {
          update({ credentialId: message.credentialId });
          refreshCredentials();
        }
      };
      window.addEventListener('message', onMessage);
      const poll = setInterval(() => {
        if (popup?.closed) {
          clearInterval(poll);
          window.removeEventListener('message', onMessage);
          setConnecting(false);
        }
      }, 800);
    }).catch(() => setConnecting(false));
  }

  async function saveCredential() {
    if (!manifest) return;
    const value = Object.fromEntries(
      credentialFields
        .map((field) => [field, (secretValues[field] ?? '').trim()] as const)
        .filter(([, fieldValue]) => fieldValue),
    );
    if (Object.keys(value).length === 0) return;
    setSavingCredential(true);
    try {
      const credential = await api<CredentialRow>('/v1/credentials', {
        method: 'POST',
        body: JSON.stringify({
          credentialType: `integration_${manifest.service}`,
          name: `${manifest.name} (${manifest.service})`,
          value: JSON.stringify(value),
        }),
      });
      update({ credentialId: credential.id });
      setSecretValues({});
      refreshCredentials();
    } finally {
      setSavingCredential(false);
    }
  }

  return (
    <>
      {manifest && (
        <div className="mb-3 rounded-input border border-line bg-surface-2 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <ConnectorLogo slug={manifest.service} name={manifest.name} size={26} />
              <div className="truncate text-[12px] font-semibold text-text-primary">{manifest.name}</div>
            </div>
            <span className="shrink-0 rounded-pill border border-line bg-canvas px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-text-muted">{manifest.category ?? 'Connector'}</span>
          </div>
          {manifest.description && <p className="mt-1 text-[10px] leading-relaxed text-text-muted">{manifest.description}</p>}
        </div>
      )}
      <Field label="Operation" hint="Choose an operation exposed by this connector.">
        <select className={selectCls} value={operationId} onChange={(event) => update({ operationId: event.target.value })}>
          {(manifest?.operations ?? []).map((operation) => <option key={operation} value={operation}>{humanizeIdentifier(operation)}</option>)}
        </select>
      </Field>
      {manifest && !needsCredential && (
        <div className="mb-3 flex items-center gap-2 rounded-input border border-success/35 bg-success-soft px-2.5 py-2 text-[11px] text-success">
          <Check size={12} /> No credential required
        </div>
      )}
      {manifest && needsCredential && (credentialId ? (
        <div className="mb-3 rounded-input border border-success/35 bg-success-soft p-2.5">
          <div className="flex items-center gap-2 text-[11px] font-semibold text-success"><Check size={12} /> Credential bound</div>
          <p className="mt-1 text-[10px] text-text-muted">{bound?.name ?? credentialId}</p>
          <button type="button" className="mt-2 text-[10px] text-accent hover:underline" onClick={() => update({ credentialId: undefined })}>Change credential</button>
        </div>
      ) : (
        <div className="mb-3 rounded-input border border-warn/50 bg-warn/10 p-2.5">
          <div className="text-[11px] font-semibold text-warn">Connect {manifest?.name ?? 'this service'}</div>
          {isOAuth && provider?.configured !== false ? (
            // OAuth-only service, already set up on this instance: offer the sign-in button directly.
            <>
              <p className="mt-1 text-[10px] leading-relaxed text-text-muted">
                Sign in to connect your account — Agentis handles the rest. Nothing is stored on the node.
              </p>
              <button type="button" onClick={connectOAuth} disabled={connecting} className="mt-2 inline-flex h-9 w-full items-center justify-center gap-2 rounded-btn border border-accent/40 bg-accent-soft text-[12px] font-semibold text-accent hover:bg-accent/20 disabled:opacity-50">
                {connecting ? 'Connecting…' : `Sign in with ${provider?.label ?? manifest?.name ?? 'OAuth'}`}
              </button>
              {oauthError && <p className="mt-2 text-[10px] leading-relaxed text-danger">{oauthError}</p>}
            </>
          ) : isOAuth ? (
            // Provider not set up on this instance yet — BYOC: paste your own OAuth
            // app's client id/secret in Settings → Integrations, no restart needed.
            <p className="mt-1 text-[10px] leading-relaxed text-text-muted">
              {provider ? `${provider.label} sign-in needs your own OAuth app set up first.` : 'This service needs OAuth set up first.'} Open Settings → Integrations to paste your Client ID/Secret.
            </p>
          ) : (
            <p className="mt-1 text-[10px] leading-relaxed text-text-muted">
              Connect this service once in Settings. Saved workspace credentials are encrypted and reused by every workflow.
            </p>
          )}
          {(!isOAuth || provider?.configured === false) && (
            <button
              onClick={() => setSettingsOpen(true, 'integrations')}
              className="mt-2 inline-flex h-8 w-full items-center justify-center rounded-btn border border-line bg-surface px-2 text-[11px] font-semibold text-text-secondary hover:border-accent/50 hover:text-text-primary"
            >
              Open integration settings
            </button>
          )}
          {matching.length > 0 && (
            <div className="mt-2 space-y-1">
              <div className="text-[9px] uppercase tracking-wider text-text-muted">Use an existing connection</div>
              {matching.map((credential) => (
                <button key={credential.id} type="button" className="flex w-full items-center justify-between rounded border border-line bg-surface px-2 py-1.5 text-left text-[10px] hover:border-accent" onClick={() => update({ credentialId: credential.id })}>
                  <span className="truncate text-text-primary">{credential.name}</span>
                  <span className="ml-2 shrink-0 text-text-muted">{credential.credentialType}</span>
                </button>
              ))}
            </div>
          )}
          {!isOAuth && manifest && (
            <Collapsible.Root className="mt-2 overflow-hidden rounded-input border border-line bg-surface">
              <Collapsible.Trigger asChild>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-1.5 px-2 py-1.5 text-left text-[10px] font-medium text-text-secondary hover:text-text-primary"
                >
                  <span className="inline-flex items-center gap-1"><HelpCircle size={11} /> How do I get this?</span>
                  <ChevronDown size={11} className="transition-transform data-[state=open]:rotate-180" />
                </button>
              </Collapsible.Trigger>
              <Collapsible.Content className="border-t border-line px-2 py-1.5 text-[10px] leading-relaxed text-text-muted">
                <p>{authHintFor(manifest)}</p>
                {manifest.docsUrl && (
                  <a href={manifest.docsUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-accent hover:underline">
                    Full docs <ExternalLink size={9} />
                  </a>
                )}
              </Collapsible.Content>
            </Collapsible.Root>
          )}
          {!isOAuth && (
            <div className="mt-2 border-t border-line/70 pt-2">
              <div className="text-[9px] uppercase tracking-wider text-text-muted">Credential fields</div>
              <div className="mt-1.5 space-y-1.5">
                {credentialFields.map((field) => (
                  <input
                    key={field}
                    type={isSecretField(field) ? 'password' : 'text'}
                    className={inputCls}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder={credentialFieldPlaceholder(manifest?.name ?? '', field)}
                    value={secretValues[field] ?? ''}
                    onChange={(event) => setSecretValues((prev) => ({ ...prev, [field]: event.target.value }))}
                  />
                ))}
              </div>
              <button type="button" onClick={() => void saveCredential()} disabled={!hasAnySecretValue(secretValues) || savingCredential} className="mt-1.5 inline-flex h-8 w-full items-center justify-center rounded-btn bg-accent px-2 text-[11px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-50">
                {savingCredential ? 'Saving…' : 'Save and connect'}
              </button>
            </div>
          )}
        </div>
      ))}
      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            {integrations.length > 0 ? 'Integration library' : 'Loading integration library...'}
          </span>
          <button
            type="button"
            onClick={() => setShowCreateIntegration(true)}
            className="rounded-md border border-line px-2 py-0.5 text-[10px] font-medium text-text-secondary hover:border-accent/50 hover:text-text-primary"
          >
            + New integration
          </button>
        </div>
        {integrations.length > 0 && (
          <input
            className={inputCls + ' mb-1.5'}
            placeholder="Search connectors"
            value={integrationQuery}
            onChange={(event) => setIntegrationQuery(event.target.value)}
          />
        )}
        <div className="grid max-h-48 grid-cols-2 gap-1.5 overflow-y-auto pr-1">
          {visibleIntegrations.map((item) => {
            const selected = item.service === slug;
            return (
              <button
                key={item.service}
                type="button"
                onClick={() => chooseIntegration(item)}
                className={clsx(
                  'flex items-center gap-2 rounded-input border px-2 py-2 text-left transition-colors',
                  selected ? 'border-accent bg-accent-soft' : 'border-line bg-surface-2 hover:border-line-strong',
                )}
              >
                <ConnectorLogo slug={item.icon || item.service} name={item.name} />
                <span className="min-w-0">
                  <span className="block truncate text-[11px] font-semibold text-text-primary">{item.name}</span>
                  <span className="block truncate text-[10px] text-text-muted">{item.builtin === false ? 'Custom' : item.category ?? 'Connector'}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <CustomIntegrationDialog
        open={showCreateIntegration}
        onClose={() => setShowCreateIntegration(false)}
        onCreated={(createdService) => {
          refreshIntegrations();
          update({ integrationId: createdService, operationId: undefined, credentialId: undefined });
        }}
      />
      <div className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Inputs</div>
      <RawMappingEditor mapping={(data.inputs as Record<string, string>) || {}} onChange={(inputs) => update({ inputs })} />
    </>
  );
}

/** One bridged MCP tool as served by GET /v1/mcp-servers/bridge/tools. */
interface BridgedMcpTool {
  id: string;
  serverId: string;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema?: { properties?: Record<string, { description?: string; type?: string }>; required?: string[] } | null;
}

/**
 * MCP node — pick a tool from the workspace's MOUNTED MCP servers and map its
 * arguments. The picker uses the bridge's NAMESPACED ids (mcp__<slug>__<tool>),
 * the exact ids the engine executes — never hand-assembled.
 */
function McpForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  const { setSettingsOpen } = useAgentisStore();
  const [tools, setTools] = useState<BridgedMcpTool[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    void api<{ tools: BridgedMcpTool[] }>('/v1/mcp-servers/bridge/tools')
      .then((d) => setTools(d.tools ?? []))
      .catch((err) => { setTools([]); setLoadError((err as Error).message); });
  }, []);

  const toolId = asStr(data.toolId);
  const selected = tools?.find((t) => t.id === toolId) ?? null;
  const byServer = new Map<string, BridgedMcpTool[]>();
  for (const t of tools ?? []) {
    const group = byServer.get(t.serverName) ?? [];
    group.push(t);
    byServer.set(t.serverName, group);
  }
  const schemaProps = selected?.inputSchema?.properties ?? {};
  const requiredArgs = new Set(selected?.inputSchema?.required ?? []);

  return (
    <>
      <Field label="Tool" hint="Tools from the workspace's mounted MCP servers. Secrets stay on the mount (vault) — never in this node.">
        {tools === null ? (
          <div className="text-[11px] text-text-muted">Loading mounted servers…</div>
        ) : tools.length === 0 ? (
          <div className="rounded-md border border-line bg-surface-2 px-2 py-2 text-[11px] leading-4 text-text-secondary">
            No MCP servers are mounted yet. Mount one (Supabase, GitHub, …) — its tools then appear here AND in every agent&apos;s own toolset. Secrets stay in the vault.
            <button
              type="button"
              onClick={() => setSettingsOpen(true, 'mcp')}
              className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-on-accent hover:bg-accent/90"
            >
              Mount an MCP server →
            </button>
            {loadError ? <div className="mt-1 text-danger">({loadError})</div> : null}
          </div>
        ) : (
          <select
            className={selectCls + ' font-mono'}
            value={toolId}
            onChange={(e) => update({ toolId: e.target.value || undefined })}
          >
            <option value="">Choose a tool…</option>
            {[...byServer.entries()].map(([server, group]) => (
              <optgroup key={server} label={server}>
                {group.map((t) => (
                  <option key={t.id} value={t.id}>{t.toolName}</option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
      </Field>
      {selected && (
        <p className="-mt-1 text-[11px] leading-4 text-text-muted">{selected.description}</p>
      )}
      {selected && Object.keys(schemaProps).length > 0 && (
        <Field label="Tool inputs" hint="What this tool accepts — map them in Arguments below.">
          <div className="space-y-0.5">
            {Object.entries(schemaProps).map(([key, prop]) => (
              <div key={key} className="text-[11px] leading-4">
                <span className="font-mono text-text-primary">{key}</span>
                {requiredArgs.has(key) ? <span className="text-danger"> *</span> : null}
                {prop.type ? <span className="text-text-muted"> ({prop.type})</span> : null}
                {prop.description ? <span className="text-text-muted"> — {prop.description}</span> : null}
              </div>
            ))}
          </div>
        </Field>
      )}
      <Field label="Arguments (JSON)" hint="Values support {{templates}} — e.g. {'table': 'leads', 'row': '{{nodes.normalize.record}}'}.">
        <textarea
          rows={5}
          spellCheck={false}
          className={textareaCls + ' font-mono text-[11px]'}
          value={JSON.stringify(typeof data.arguments === 'object' && data.arguments ? data.arguments : {}, null, 2)}
          onChange={(e) => {
            try { update({ arguments: JSON.parse(e.target.value) as unknown }); }
            catch { /* keep prior until valid */ }
          }}
        />
      </Field>
      <Field label="Output key" hint="Store the tool result under this key (default: result).">
        <input
          type="text"
          className={inputCls + ' font-mono'}
          value={asStr(data.outputKey)}
          placeholder="result"
          onChange={(e) => update({ outputKey: e.target.value || undefined })}
        />
      </Field>
    </>
  );
}

const CHANNEL_KIND_LABEL: Record<string, string> = { whatsapp: 'WhatsApp', telegram: 'Telegram', discord: 'Discord', slack: 'Slack' };
const CHANNEL_KIND_ORDER = ['whatsapp', 'telegram', 'discord', 'slack'];

/**
 * Channel node — sends on a native connection (WhatsApp/Telegram/Discord/Slack).
 * "Send via" picks either an exact connection or "Automatic" for a kind, which
 * resolves to the workspace-designated default at run time. Zero-token, deterministic.
 */
function ChannelForm({ data, update, upstream, connections, agents }: { data: Record<string, unknown>; update: NodeFormProps['update']; upstream?: UpstreamNode[]; connections: ChannelConnectionRow[]; agents: AgentRow[] }) {
  const { setSettingsOpen } = useAgentisStore();
  const channelKind = asStr(data.channelKind);
  const connectionId = asStr(data.connectionId);
  const attachments = Array.isArray(data.attachments) ? data.attachments : [];
  const agentName = new Map(agents.map((a) => [a.id, a.name]));

  const byKind = new Map<string, ChannelConnectionRow[]>();
  for (const c of connections) {
    const group = byKind.get(c.kind) ?? [];
    group.push(c);
    byKind.set(c.kind, group);
  }
  const kindsPresent = CHANNEL_KIND_ORDER.filter((k) => byKind.has(k));
  const selectedConnection = connectionId ? connections.find((c) => c.id === connectionId) : undefined;

  // Encodes both fields into one dropdown value: "" = unset, "auto:<kind>" =
  // resolve the workspace default at run time, "<connectionId>" = pin an exact one.
  const selectValue = connectionId ? connectionId : channelKind ? `auto:${channelKind}` : '';

  function handleSelect(value: string) {
    if (!value) { update({ channelKind: undefined, connectionId: undefined }); return; }
    if (value.startsWith('auto:')) { update({ channelKind: value.slice(5), connectionId: undefined }); return; }
    const conn = connections.find((c) => c.id === value);
    update({ connectionId: value, channelKind: conn?.kind ?? channelKind });
  }

  return (
    <>
      <Field label="Send via" hint="Pin an exact connection, or send Automatically — the workspace's default connection for that kind is resolved at run time.">
        {connections.length === 0 ? (
          <div className="rounded-md border border-line bg-surface-2 px-2 py-2 text-[11px] leading-4 text-text-secondary">
            No channel connections yet. Connect WhatsApp, Telegram, Discord, or Slack — once connected, agents and workflows can send on it.
            <button
              type="button"
              onClick={() => setSettingsOpen(true, 'channels')}
              className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-on-accent hover:bg-accent/90"
            >
              Connect a channel →
            </button>
          </div>
        ) : (
          <select className={selectCls} value={selectValue} onChange={(e) => handleSelect(e.target.value)}>
            <option value="">Choose how to send…</option>
            {kindsPresent.map((k) => (
              <optgroup key={k} label={CHANNEL_KIND_LABEL[k] ?? k}>
                <option value={`auto:${k}`}>Automatic — workspace default {CHANNEL_KIND_LABEL[k] ?? k}</option>
                {(byKind.get(k) ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}{c.isDefault ? ' (default)' : ''} — {c.agentId ? (agentName.get(c.agentId) ?? 'agent-owned') : 'workspace-shared'}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
      </Field>
      {selectedConnection && (
        <div className="-mt-1.5 mb-3 flex items-center justify-between text-[11px] text-text-muted">
          <span>
            {selectedConnection.status && <StatusBadge status={selectedConnection.status} size="sm" />}
            <span className="ml-1.5">{selectedConnection.agentId ? `Owned by ${agentName.get(selectedConnection.agentId) ?? 'an agent'}` : 'Shared workspace connection — open to every agent unless restricted.'}</span>
          </span>
          <button type="button" onClick={() => setSettingsOpen(true, 'channels')} className="text-accent hover:underline">
            Manage in Settings →
          </button>
        </div>
      )}
      <Field label="To" hint="Phone/JID/username, or leave blank / 'default' to use the connection's saved default target. Type `{{` to insert a variable.">
        <TemplatedTextField
          placeholder="default"
          value={asStr(data.to)}
          onChange={(next) => update({ to: next || undefined })}
          upstream={upstream}
        />
      </Field>
      <Field label="Message" hint="Type `{{` to insert a variable.">
        <TemplatedTextField
          multiline
          rows={4}
          placeholder="Hi {{nodes.lookup.name}}, …"
          value={asStr(data.body)}
          onChange={(next) => update({ body: next })}
          upstream={upstream}
        />
        <div className="mt-1.5">
          <FieldPicker
            upstream={upstream ?? []}
            dialect="template"
            onInsert={(expr) => {
              const cur = asStr(data.body);
              update({ body: cur.trim() ? `${cur}${expr}` : expr });
            }}
          />
        </div>
      </Field>
      <Accordion title="Attachments" defaultOpen={attachments.length > 0}>
        <Field label="Attachments (JSON array)" hint='Each item: { "url": "https://…" } or { "artifactId": "…" }. Values support templates.'>
          <textarea
            rows={4}
            spellCheck={false}
            className={textareaCls + ' font-mono text-[11px]'}
            value={JSON.stringify(attachments, null, 2)}
            onChange={(e) => {
              try {
                const parsed = JSON.parse(e.target.value) as unknown;
                update({ attachments: Array.isArray(parsed) ? parsed : undefined });
              } catch { /* keep prior until valid */ }
            }}
          />
        </Field>
      </Accordion>
      <Accordion title="Advanced">
        <Field label="Output key" hint="Store the delivery receipt under this key (default: delivery).">
          <input
            type="text"
            className={inputCls + ' font-mono'}
            value={asStr(data.outputKey)}
            placeholder="delivery"
            onChange={(e) => update({ outputKey: e.target.value || undefined })}
          />
        </Field>
      </Accordion>
    </>
  );
}

function HttpRequestForm({ data, update, upstream, credentials = [] }: { data: Record<string, unknown>; update: NodeFormProps['update']; upstream?: UpstreamNode[]; credentials?: CredentialRow[] }) {
  const method = asStr(data.method) || 'GET';
  const auth = (typeof data.auth === 'object' && data.auth ? data.auth : {}) as { type?: string; credentialId?: string; header?: string };
  const authType = auth.type ?? 'none';
  const responseMapping = (typeof data.responseMapping === 'object' && data.responseMapping ? data.responseMapping : {}) as { outputKey?: string; bodyPath?: string };
  const setAuth = (next: { type: string; credentialId?: string; header?: string }) => {
    // `none` clears the field entirely — the runtime treats absent and
    // {type:'none'} identically, and absent keeps configs minimal.
    if (next.type === 'none') { update({ auth: undefined }); return; }
    update({ auth: next });
  };
  return (
    <>
      <Field label="Method">
        <select className={selectCls} value={method} onChange={(e) => update({ method: e.target.value })}>
          <option>GET</option>
          <option>POST</option>
          <option>PUT</option>
          <option>PATCH</option>
          <option>DELETE</option>
        </select>
      </Field>
      <Field label="URL" hint="Type `{{` to insert a variable.">
        <TemplatedTextField
          placeholder="https://api.example.com/{{trigger.path}}"
          value={asStr(data.url)}
          onChange={(next) => update({ url: next })}
          upstream={upstream}
        />
        <div className="mt-1.5">
          <FieldPicker
            upstream={upstream ?? []}
            dialect="template"
            onInsert={(expr) => {
              const cur = asStr(data.url);
              update({ url: cur.trim() ? `${cur}${expr}` : expr });
            }}
          />
        </div>
      </Field>
      <Field label="Headers (JSON)" hint="Object of header strings. Values support templates.">
        <textarea
          rows={3}
          spellCheck={false}
          className={textareaCls + ' font-mono text-[11px]'}
          value={JSON.stringify(typeof data.headers === 'object' && data.headers ? data.headers : {}, null, 2)}
          onChange={(e) => {
            try { update({ headers: JSON.parse(e.target.value) as unknown }); }
            catch { /* keep prior */ }
          }}
        />
      </Field>
      {method !== 'GET' && method !== 'DELETE' && (
        <Field label="Body" hint="Raw request body. Type `{{` to insert a variable.">
          <TemplatedTextField
            multiline
            mono
            rows={4}
            placeholder='{"message": "{{nodes.draft.text}}"}'
            value={asStr(data.body)}
            onChange={(next) => update({ body: next })}
            upstream={upstream}
          />
          <div className="mt-1.5">
            <FieldPicker
              upstream={upstream ?? []}
              dialect="template"
              onInsert={(expr) => {
                const cur = asStr(data.body);
                update({ body: cur.trim() ? `${cur}${expr}` : expr });
              }}
            />
          </div>
        </Field>
      )}
      <Accordion title="Authentication">
        <Field label="Auth type" hint="Credentials are stored in the encrypted vault; the secret is injected at run time, never saved on the node.">
          <select
            className={selectCls}
            value={authType}
            onChange={(e) => {
              const type = e.target.value;
              if (type === 'none') setAuth({ type: 'none' });
              else setAuth({ type, credentialId: auth.credentialId ?? '', ...(type === 'api_key' ? { header: auth.header ?? 'x-api-key' } : {}) });
            }}
          >
            <option value="none">None</option>
            <option value="bearer">Bearer token (Authorization: Bearer …)</option>
            <option value="api_key">API key header</option>
            <option value="basic">Basic (username:password)</option>
          </select>
        </Field>
        {authType !== 'none' && (
          <>
            <Field label="Credential" hint="Pick the vault credential holding the secret.">
              <select
                className={selectCls}
                value={auth.credentialId ?? ''}
                onChange={(e) => setAuth({ type: authType, credentialId: e.target.value, ...(authType === 'api_key' ? { header: auth.header ?? 'x-api-key' } : {}) })}
              >
                <option value="">Choose a credential…</option>
                {credentials.map((credential) => (
                  <option key={credential.id} value={credential.id}>{credential.name} ({credential.credentialType})</option>
                ))}
              </select>
            </Field>
            {authType === 'api_key' && (
              <Field label="Header name" hint="The header that carries the key.">
                <input
                  type="text"
                  className={inputCls + ' font-mono'}
                  value={auth.header ?? 'x-api-key'}
                  onChange={(e) => setAuth({ type: 'api_key', credentialId: auth.credentialId ?? '', header: e.target.value })}
                />
              </Field>
            )}
          </>
        )}
      </Accordion>
      <Accordion title="Response Extraction">
        <Field label="Output key" hint="Store the (extracted) response under this key. Leave empty to pass the raw response through.">
          <input
            type="text"
            className={inputCls + ' font-mono'}
            value={responseMapping.outputKey ?? ''}
            placeholder="items"
            onChange={(e) => {
              const outputKey = e.target.value.trim();
              update({ responseMapping: outputKey ? { outputKey, ...(responseMapping.bodyPath ? { bodyPath: responseMapping.bodyPath } : {}) } : undefined });
            }}
          />
        </Field>
        {responseMapping.outputKey ? (
          <Field label="Body path" hint="Dot path into the response body, e.g. data.items — empty = whole body.">
            <input
              type="text"
              className={inputCls + ' font-mono'}
              value={responseMapping.bodyPath ?? ''}
              placeholder="data.items"
              onChange={(e) => {
                const bodyPath = e.target.value.trim();
                update({ responseMapping: { outputKey: responseMapping.outputKey!, ...(bodyPath ? { bodyPath } : {}) } });
              }}
            />
          </Field>
        ) : null}
      </Accordion>
      <Accordion title="Advanced Settings">
        <Field label="Timeout (ms)" hint="Max 120000 (2 minutes).">
          <input
            type="number"
            className={inputCls}
            min={1}
            max={120000}
            value={typeof data.timeoutMs === 'number' ? data.timeoutMs : ''}
            placeholder="30000"
            onChange={(e) => update({ timeoutMs: e.target.value === '' ? undefined : Number(e.target.value) })}
          />
        </Field>
        <Field label="Max retries" hint="Retry attempts after the first dispatch (default 0).">
          <input
            type="number"
            className={inputCls}
            min={0}
            max={10}
            value={typeof data.maxRetries === 'number' ? data.maxRetries : ''}
            placeholder="0"
            onChange={(e) => update({ maxRetries: e.target.value === '' ? undefined : Number(e.target.value) })}
          />
        </Field>
        <Field label="Retry on status codes" hint="Comma-separated list, e.g. 429, 503.">
          <input
            type="text"
            className={inputCls}
            value={Array.isArray(data.retryOn) ? (data.retryOn as number[]).join(', ') : ''}
            placeholder="429, 503"
            onChange={(e) => {
              const parsed = e.target.value
                .split(/[,\s]+/)
                .map((s) => Number(s.trim()))
                .filter((n) => Number.isInteger(n) && n > 0);
              update({ retryOn: parsed.length > 0 ? parsed : undefined });
            }}
          />
        </Field>
      </Accordion>
    </>
  );
}

// ─── Workflow Store ─────────────────────────────────────────────────────────

function WorkflowStoreForm({ data, update, workspace = false }: { data: Record<string, unknown>; update: NodeFormProps['update']; workspace?: boolean }) {
  const operations = Array.isArray(data.operations)
    ? data.operations as Array<{ op?: string; key?: string; value?: string; outputKey?: string; incrementBy?: number }>
    : [];
  return (
    <Field label={`${workspace ? 'Workspace' : 'Workflow'} store operations`} hint={`These values persist ${workspace ? 'across workflows in this workspace' : 'across runs of this workflow'}.`}>
      <div className="space-y-1.5">
        {operations.map((operation, index) => (
          <div key={index} className="rounded-input border border-line bg-surface-2 p-2">
            <div className="flex gap-1.5">
              <select className={selectCls} value={operation.op ?? 'set'} onChange={(event) => {
                const next = [...operations];
                next[index] = { ...operation, op: event.target.value };
                update({ operations: next });
              }}>
                <option value="set">Set value</option>
                <option value="get">Read value</option>
                <option value="delete">Delete value</option>
                <option value="increment">Increment number</option>
                <option value="append">Append value</option>
              </select>
              <button type="button" aria-label="Remove store operation" className="px-1.5 text-text-muted hover:text-danger" onClick={() => update({ operations: operations.filter((_, operationIndex) => operationIndex !== index) })}>x</button>
            </div>
            <input className={inputCls + ' mt-1.5 font-mono'} value={operation.key ?? ''} placeholder="key" onChange={(event) => {
              const next = [...operations];
              next[index] = { ...operation, key: event.target.value };
              update({ operations: next });
            }} />
            {operation.op !== 'get' && operation.op !== 'delete' && (
              <input className={inputCls + ' mt-1.5'} value={operation.op === 'increment' ? operation.incrementBy ?? '' : operation.value ?? ''} placeholder={operation.op === 'increment' ? 'Increment by, e.g. 1' : 'Value or {{variable}}'} onChange={(event) => {
                const next = [...operations];
                next[index] = operation.op === 'increment'
                  ? { ...operation, incrementBy: Number(event.target.value || 0), value: undefined }
                  : { ...operation, value: event.target.value };
                update({ operations: next });
              }} />
            )}
            {(operation.op === 'get' || operation.op === 'increment') && (
              <input className={inputCls + ' mt-1.5 font-mono'} value={operation.outputKey ?? ''} placeholder="Output key" onChange={(event) => {
                const next = [...operations];
                next[index] = { ...operation, outputKey: event.target.value };
                update({ operations: next });
              }} />
            )}
          </div>
        ))}
        <button type="button" className="inline-flex h-7 items-center rounded-btn border border-line px-2 text-[11px] text-text-secondary hover:border-accent/60 hover:text-text-primary" onClick={() => update({ operations: [...operations, { op: 'set', key: '', value: '' }] })}>
          + Add operation
        </button>
      </div>
    </Field>
  );
}

// ─── Evaluator & Guardrails ─────────────────────────────────────────────────

function EvaluatorForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  return (
    <>
      <Field label="Target path" hint="Dot notation into the input. E.g. `nodes.draft.text`.">
        <input
          type="text"
          className={inputCls}
          placeholder="nodes.draft.text"
          value={asStr(data.targetPath)}
          onChange={(e) => update({ targetPath: e.target.value })}
        />
      </Field>
      <Field label="Criteria" hint="Natural-language pass criteria for the LLM judge.">
        <textarea
          rows={4}
          spellCheck={false}
          className={textareaCls}
          placeholder="The output should be a complete paragraph under 200 words, with no list formatting."
          value={asStr(data.criteria)}
          onChange={(e) => update({ criteria: e.target.value })}
        />
      </Field>
      <Field label="Pass threshold (0–10)">
        <input
          type="number"
          className={inputCls}
          min={0}
          max={10}
          value={typeof data.passThreshold === 'number' ? data.passThreshold : 7}
          onChange={(e) => update({ passThreshold: e.target.value === '' ? undefined : Number(e.target.value) })}
        />
      </Field>
      <Field label="Max retries" hint="How many fail→retry cycles before the run is terminated. Default 3.">
        <input
          type="number"
          className={inputCls}
          min={0}
          max={10}
          value={typeof data.maxRetries === 'number' ? data.maxRetries : 3}
          onChange={(e) => update({ maxRetries: e.target.value === '' ? undefined : Number(e.target.value) })}
        />
      </Field>
      <ModelPolicyField data={data} update={update} />
    </>
  );
}

function GuardrailsForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  const rules = Array.isArray(data.rules)
    ? data.rules as Array<{ type?: string; target?: string; value?: string; limit?: number; message?: string }>
    : [];
  return (
    <>
      <Field label="Violation policy">
        <select
          className={selectCls}
          value={asStr(data.onViolation) || 'block'}
          onChange={(e) => update({ onViolation: e.target.value })}
        >
          <option value="block">Block — route to error edge</option>
          <option value="flag">Flag — annotate output and continue</option>
        </select>
      </Field>
      <Field label="Rules" hint="Add deterministic checks in the order they should run.">
        <div className="space-y-1.5">
          {rules.map((rule, index) => (
            <div key={index} className="rounded-input border border-line bg-surface-2 p-2">
              <div className="flex gap-1.5">
                <select className={selectCls} value={rule.type ?? 'not_empty'} onChange={(event) => {
                  const next = [...rules];
                  next[index] = { ...rule, type: event.target.value };
                  update({ rules: next });
                }}>
                  <option value="not_empty">Not empty</option>
                  <option value="max_length">Maximum length</option>
                  <option value="min_length">Minimum length</option>
                  <option value="contains">Contains value</option>
                  <option value="regex">Matches pattern</option>
                </select>
                <button type="button" aria-label="Remove guardrail rule" className="px-1.5 text-text-muted hover:text-danger" onClick={() => update({ rules: rules.filter((_, ruleIndex) => ruleIndex !== index) })}>x</button>
              </div>
              <input className={inputCls + ' mt-1.5 font-mono'} value={rule.target ?? ''} placeholder="nodes.draft.text" onChange={(event) => {
                const next = [...rules];
                next[index] = { ...rule, target: event.target.value };
                update({ rules: next });
              }} />
              {(rule.type === 'max_length' || rule.type === 'min_length') ? (
                <input className={inputCls + ' mt-1.5'} type="number" min={0} value={rule.limit ?? ''} placeholder="Limit" onChange={(event) => {
                  const next = [...rules];
                  next[index] = { ...rule, limit: Number(event.target.value || 0) };
                  update({ rules: next });
                }} />
              ) : rule.type !== 'not_empty' ? (
                <input className={inputCls + ' mt-1.5'} value={rule.value ?? ''} placeholder={rule.type === 'regex' ? 'Pattern' : 'Required value'} onChange={(event) => {
                  const next = [...rules];
                  next[index] = { ...rule, value: event.target.value };
                  update({ rules: next });
                }} />
              ) : null}
              <input className={inputCls + ' mt-1.5'} value={rule.message ?? ''} placeholder="Operator-facing violation message" onChange={(event) => {
                const next = [...rules];
                next[index] = { ...rule, message: event.target.value };
                update({ rules: next });
              }} />
            </div>
          ))}
          <button type="button" className="inline-flex h-7 items-center rounded-btn border border-line px-2 text-[11px] text-text-secondary hover:border-accent/60 hover:text-text-primary" onClick={() => update({ rules: [...rules, { type: 'not_empty', target: '', message: '' }] })}>
            + Add rule
          </button>
        </div>
      </Field>
    </>
  );
}

// ─── Loop & Parallel ────────────────────────────────────────────────────────

function LoopForm({ data, update, workflows }: { data: Record<string, unknown>; update: NodeFormProps['update']; workflows: WorkflowRow[] }) {
  return (
    <>
      <Field label="Items expression" hint="Path resolving to the array, e.g. `{{nodes.fetch.items}}` or `trigger.leads`.">
        <input
          type="text"
          className={inputCls}
          placeholder="{{nodes.fetch.items}}"
          value={asStr(data.itemsExpression)}
          onChange={(e) => update({ itemsExpression: e.target.value })}
        />
      </Field>
      <Field label="Body workflow" hint="The workflow invoked once per item. Inputs include `{{loop.item}}` and `{{loop.index}}`.">
        <select
          className={selectCls}
          value={asStr(data.bodyWorkflowId)}
          onChange={(e) => update({ bodyWorkflowId: e.target.value })}
        >
          <option value="">— Select workflow —</option>
          {workflows.map((wf) => (
            <option key={wf.id} value={wf.id}>{wf.title ?? wf.name ?? wf.id}</option>
          ))}
        </select>
      </Field>
      <Field label="Max concurrency">
        <input
          type="number"
          className={inputCls}
          min={1}
          max={32}
          value={typeof data.maxConcurrency === 'number' ? data.maxConcurrency : 1}
          onChange={(e) => update({ maxConcurrency: Math.max(1, Number(e.target.value || 1)) })}
        />
      </Field>
      <Field label="Chunk size (optional)" hint="For very large arrays — process this many at a time. Emits LOOP_PROGRESS per chunk.">
        <input
          type="number"
          className={inputCls}
          min={1}
          value={typeof data.chunkSize === 'number' ? data.chunkSize : ''}
          placeholder="100"
          onChange={(e) => update({ chunkSize: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value)) })}
        />
      </Field>
      <Field label="On iteration error">
        <select
          className={selectCls}
          value={asStr(data.onIterationError) || 'stop_all'}
          onChange={(e) => update({ onIterationError: e.target.value })}
        >
          <option value="stop_all">Stop all — fail the loop</option>
          <option value="continue">Continue — skip failed items</option>
          <option value="collect_errors">Collect errors — emit alongside results</option>
        </select>
      </Field>
      <Field label="Output array key">
        <input
          type="text"
          className={inputCls}
          placeholder="results"
          value={asStr(data.outputArrayKey)}
          onChange={(e) => update({ outputArrayKey: e.target.value })}
        />
      </Field>
    </>
  );
}

function ParallelForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  return (
    <>
      <Field label="Wait for">
        <select className={selectCls} value={asStr(data.waitFor) || 'all'} onChange={(e) => update({ waitFor: e.target.value })}>
          <option value="all">All branches</option>
          <option value="first">First to complete</option>
        </select>
      </Field>
      <Field label="On branch error">
        <select className={selectCls} value={asStr(data.onBranchError) || 'fail_all'} onChange={(e) => update({ onBranchError: e.target.value })}>
          <option value="fail_all">Fail the run</option>
          <option value="continue_with_results">Continue with successful branches</option>
        </select>
      </Field>
      <Field label="Merge strategy">
        <select className={selectCls} value={asStr(data.mergeStrategy) || 'merge_keys'} onChange={(e) => update({ mergeStrategy: e.target.value })}>
          <option value="merge_keys">Merge keys</option>
          <option value="collect_all">Collect all</option>
          <option value="first_non_null">First non-null</option>
        </select>
      </Field>
    </>
  );
}

// ─── Convergence loop (converge / pursue) — COGNITIVE-LOOPING-RFC ──────────
// `pursue` is a forward-reading rename of `converge` ("pursue an Objective
// until done"); the engine normalizes a `pursue` config into the `converge`
// shape at dispatch (pursueConfigToConverge in WorkflowEngine.ts) so both
// share one loop/worktree/resume machine. Field names differ only cosmetically
// (continuation↔doneWhen, stallPolicy↔stopWhenStalled, carryStrategy↔carry).

type ContinuationType = 'deterministic' | 'judge' | 'signal' | 'objective';

/** Shared editor for the `continuation` (converge) / `doneWhen` (pursue) union. */
function DoneConditionField({
  label,
  value,
  onChange,
  upstream,
}: {
  label: string;
  value: Record<string, unknown> | undefined;
  onChange: (next: Record<string, unknown>) => void;
  upstream?: UpstreamNode[];
}) {
  const type = (asStr(value?.type) || 'deterministic') as ContinuationType;
  return (
    <>
      <Field label={label} hint="How the loop knows it is finished.">
        <select className={selectCls} value={type} onChange={(e) => onChange({ type: e.target.value })}>
          <option value="deterministic">Deterministic — a JS expression over the body output</option>
          <option value="judge">LLM judge — score the body output against criteria</option>
          <option value="signal">Signal — an agent posts a done-signal to the blackboard</option>
          <option value="objective">Objective — the workflow's own acceptance checks (SWIFT verdict)</option>
        </select>
      </Field>
      {type === 'deterministic' && (
        <Field label="Continue-while expression" hint="Safe expression, e.g. `body.openBugCount > 0`. Loop continues while true.">
          <TemplatedTextField
            value={asStr(value?.expr)}
            onChange={(next) => onChange({ type, expr: next })}
            upstream={upstream}
            placeholder="body.openBugCount > 0"
          />
        </Field>
      )}
      {type === 'judge' && (
        <>
          <Field label="Target path" hint="Dot path into the body output to evaluate.">
            <input
              type="text"
              className={inputCls}
              placeholder="body.draft"
              value={asStr(value?.targetPath)}
              onChange={(e) => onChange({ ...value, type, targetPath: e.target.value })}
            />
          </Field>
          <Field label="Criteria">
            <textarea
              rows={3}
              className={textareaCls}
              placeholder="The draft is publication-ready: accurate, concise, no TODOs."
              value={asStr(value?.criteria)}
              onChange={(e) => onChange({ ...value, type, criteria: e.target.value })}
            />
          </Field>
          <Field label="Pass threshold" hint="Minimum score (0–10) that counts as converged. Default 7.">
            <input
              type="number"
              min={0}
              max={10}
              className={inputCls}
              value={typeof value?.passThreshold === 'number' ? value.passThreshold : ''}
              placeholder="7"
              onChange={(e) => onChange({ ...value, type, passThreshold: e.target.value === '' ? undefined : Number(e.target.value) })}
            />
          </Field>
        </>
      )}
      {type === 'signal' && (
        <Field label="Blackboard channel" hint="Defaults to 'converge'.">
          <input
            type="text"
            className={inputCls}
            placeholder="converge"
            value={asStr(value?.channel)}
            onChange={(e) => onChange({ type, channel: e.target.value || undefined })}
          />
        </Field>
      )}
      {type === 'objective' && (
        <div className="mb-3 rounded-md border border-line bg-surface-2 px-2 py-2 text-[11px] leading-relaxed text-text-secondary">
          Done when this workflow's own <code className="rounded bg-canvas px-1">WorkflowSpec</code> acceptance checks all pass — run against the world (http/data/file/expr/judge) by the SWIFT verdict engine. Progress is the fraction of checks passing, so distance-to-goal is real.
        </div>
      )}
    </>
  );
}

function ConvergeForm({ data, update, workflows, upstream }: { data: Record<string, unknown>; update: NodeFormProps['update']; workflows: WorkflowRow[]; upstream?: UpstreamNode[] }) {
  const continuation = data.continuation as Record<string, unknown> | undefined;
  const stallPolicy = (data.stallPolicy as Record<string, unknown> | undefined) ?? {};
  return (
    <>
      <Field label="Body workflow" hint="The cohort sub-graph, invoked once per iteration.">
        <select className={selectCls} value={asStr(data.bodyWorkflowId)} onChange={(e) => update({ bodyWorkflowId: e.target.value })}>
          <option value="">— Select workflow —</option>
          {workflows.map((wf) => <option key={wf.id} value={wf.id}>{wf.title ?? wf.name ?? wf.id}</option>)}
        </select>
      </Field>
      <DoneConditionField label="Continuation" value={continuation} onChange={(next) => update({ continuation: next })} upstream={upstream} />
      <div className="grid grid-cols-2 gap-2">
        <Field label="Max iterations" hint="Hard ceiling. Default 8.">
          <input type="number" min={1} className={inputCls} placeholder="8" value={typeof data.maxIterations === 'number' ? data.maxIterations : ''} onChange={(e) => update({ maxIterations: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value)) })} />
        </Field>
        <Field label="Max pivots" hint="Reflective pivots before settling stalled. 0 = stop-on-stall.">
          <input type="number" min={0} className={inputCls} placeholder="0" value={typeof data.maxPivots === 'number' ? data.maxPivots : ''} onChange={(e) => update({ maxPivots: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })} />
        </Field>
      </div>
      <Field label="Assess progress" hint="Measure distance-to-goal each iteration so a stall is a plateau, not just a repeat.">
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={Boolean(data.assess)} onChange={(e) => update({ assess: e.target.checked || undefined })} className="rounded border-line bg-surface-2 accent-accent" />
          <span className="text-[12px] text-text-primary">{data.assess ? 'on' : 'off'}</span>
        </label>
      </Field>
      <Field label="Stall window" hint="Consecutive no-change iterations that trip a stall. Default 2.">
        <input type="number" min={1} className={inputCls} placeholder="2" value={typeof stallPolicy.window === 'number' ? stallPolicy.window : ''} onChange={(e) => update({ stallPolicy: { ...stallPolicy, window: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value)) } })} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Isolation">
          <select className={selectCls} value={asStr(data.isolation) || 'auto'} onChange={(e) => update({ isolation: e.target.value })}>
            <option value="auto">Auto</option>
            <option value="shared">Shared</option>
            <option value="worktree">Worktree</option>
            <option value="tempdir">Tempdir</option>
          </select>
        </Field>
        <Field label="Preserve" hint="What to do with an isolated worktree when the loop settles.">
          <select className={selectCls} value={asStr(data.preserve) || 'discard'} onChange={(e) => update({ preserve: e.target.value })}>
            <option value="discard">Discard</option>
            <option value="branch">Branch</option>
            <option value="pr">Pull request</option>
          </select>
        </Field>
      </div>
      <Field label="State key" hint="Blackboard namespace carried across iterations. Defaults to the node id.">
        <input type="text" className={inputCls} value={asStr(data.stateKey)} onChange={(e) => update({ stateKey: e.target.value || undefined })} />
      </Field>
    </>
  );
}

function PursueForm({ data, update, workflows, upstream }: { data: Record<string, unknown>; update: NodeFormProps['update']; workflows: WorkflowRow[]; upstream?: UpstreamNode[] }) {
  const doneWhen = data.doneWhen as Record<string, unknown> | undefined;
  const stopWhenStalled = (data.stopWhenStalled as Record<string, unknown> | undefined) ?? {};
  return (
    <>
      <div className="mb-3 rounded-md border border-accent/25 bg-accent-soft px-2.5 py-2 text-[11px] leading-4 text-text-secondary">
        Pursue an Objective: run the body workflow repeatedly, ASSESS progress each iteration, and REFLECT (pivot) on a stall instead of giving up — until <code className="rounded bg-canvas px-1">doneWhen</code> is met or the iteration ceiling is hit.
      </div>
      <Field label="Body workflow" hint="The cohort sub-graph, invoked once per iteration.">
        <select className={selectCls} value={asStr(data.bodyWorkflowId)} onChange={(e) => update({ bodyWorkflowId: e.target.value })}>
          <option value="">— Select workflow —</option>
          {workflows.map((wf) => <option key={wf.id} value={wf.id}>{wf.title ?? wf.name ?? wf.id}</option>)}
        </select>
      </Field>
      <DoneConditionField label="Done when" value={doneWhen} onChange={(next) => update({ doneWhen: next })} upstream={upstream} />
      <div className="grid grid-cols-2 gap-2">
        <Field label="Max iterations" hint="Hard ceiling. Default 8.">
          <input type="number" min={1} className={inputCls} placeholder="8" value={typeof data.maxIterations === 'number' ? data.maxIterations : ''} onChange={(e) => update({ maxIterations: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value)) })} />
        </Field>
        <Field label="Max pivots" hint="Reflective pivots before settling stalled. Default 2.">
          <input type="number" min={0} className={inputCls} placeholder="2" value={typeof data.maxPivots === 'number' ? data.maxPivots : ''} onChange={(e) => update({ maxPivots: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })} />
        </Field>
      </div>
      <Field label="Assess progress" hint="Default on for a Pursuit — measures distance-to-goal each iteration.">
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={data.assess !== false} onChange={(e) => update({ assess: e.target.checked })} className="rounded border-line bg-surface-2 accent-accent" />
          <span className="text-[12px] text-text-primary">{data.assess !== false ? 'on' : 'off'}</span>
        </label>
      </Field>
      <Field label="Stop-when-stalled after" hint="Consecutive no-change iterations that trip a stall. Default 2.">
        <input type="number" min={1} className={inputCls} placeholder="2" value={typeof stopWhenStalled.after === 'number' ? stopWhenStalled.after : ''} onChange={(e) => update({ stopWhenStalled: { ...stopWhenStalled, after: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value)) } })} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Isolation">
          <select className={selectCls} value={asStr(data.isolation) || 'auto'} onChange={(e) => update({ isolation: e.target.value })}>
            <option value="auto">Auto</option>
            <option value="shared">Shared</option>
            <option value="worktree">Worktree</option>
            <option value="tempdir">Tempdir</option>
          </select>
        </Field>
        <Field label="Preserve" hint="What to do with an isolated worktree when the Pursuit settles.">
          <select className={selectCls} value={asStr(data.preserve) || 'discard'} onChange={(e) => update({ preserve: e.target.value })}>
            <option value="discard">Discard</option>
            <option value="branch">Branch</option>
            <option value="pr">Pull request</option>
          </select>
        </Field>
      </div>
      <Field label="Carry" hint="How iteration N sees N-1's output. Default 'keep'.">
        <select className={selectCls} value={asStr(data.carry) || 'keep'} onChange={(e) => update({ carry: e.target.value })}>
          <option value="keep">Keep</option>
          <option value="latest">Latest</option>
          <option value="delta">Delta</option>
        </select>
      </Field>
      <Field label="State key" hint="Blackboard namespace carried across iterations. Defaults to the node id.">
        <input type="text" className={inputCls} value={asStr(data.stateKey)} onChange={(e) => update({ stateKey: e.target.value || undefined })} />
      </Field>
    </>
  );
}

// ─── Agent Swarm & Artifact Collect (engine handlers already shipped) ───────

function AgentSwarmForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  const tags = Array.isArray(data.capabilityTags) ? (data.capabilityTags as string[]).join(', ') : '';
  return (
    <>
      <Field label="Input array path" hint="Path into the input data that resolves to the array. Each item dispatches one task.">
        <input
          type="text"
          className={inputCls}
          placeholder="leads"
          value={asStr(data.inputArrayPath)}
          onChange={(e) => update({ inputArrayPath: e.target.value })}
        />
      </Field>
      <Field label="Prompt template" hint="Applied to each input element. Supports `{{item}}` plus the usual template namespaces.">
        <textarea
          rows={4}
          spellCheck={false}
          className={textareaCls}
          value={asStr(data.prompt)}
          onChange={(e) => update({ prompt: e.target.value })}
        />
      </Field>
      <Field label="Max parallel">
        <input
          type="number"
          className={inputCls}
          min={1}
          max={32}
          value={typeof data.maxParallel === 'number' ? data.maxParallel : 3}
          onChange={(e) => update({ maxParallel: Math.max(1, Number(e.target.value || 1)) })}
        />
      </Field>
      <Field label="Merge strategy">
        <select className={selectCls} value={asStr(data.mergeStrategy) || 'collect_all'} onChange={(e) => update({ mergeStrategy: e.target.value })}>
          <option value="collect_all">Collect all results</option>
          <option value="first_success">First success wins</option>
          <option value="majority_vote">Majority vote</option>
        </select>
      </Field>
      <Field label="Capability tags" hint="Comma-separated. Used to route to a capable agent when no explicit agent is bound.">
        <input
          type="text"
          className={inputCls}
          value={tags}
          placeholder="research, summarize"
          onChange={(e) => {
            const list = e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            update({ capabilityTags: list });
          }}
        />
      </Field>
      <Field label="Output key">
        <input
          type="text"
          className={inputCls}
          value={asStr(data.outputKey)}
          placeholder="results"
          onChange={(e) => update({ outputKey: e.target.value })}
        />
      </Field>
    </>
  );
}

function DynamicSwarmForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  return (
    <>
      <Field label="Goal" hint="Describe the outcome. The planner decomposes this into bounded specialist tasks.">
        <textarea className={textareaCls} rows={5} value={asStr(data.goal)} onChange={(event) => update({ goal: event.target.value })} placeholder="Research the market and produce a concise opportunity brief." />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Max tasks">
          <input className={inputCls} type="number" min={1} max={32} value={typeof data.maxTasks === 'number' ? data.maxTasks : 5} onChange={(event) => update({ maxTasks: Math.max(1, Number(event.target.value || 1)) })} />
        </Field>
        <Field label="Max parallel">
          <input className={inputCls} type="number" min={1} max={16} value={typeof data.maxParallel === 'number' ? data.maxParallel : 3} onChange={(event) => update({ maxParallel: Math.max(1, Number(event.target.value || 1)) })} />
        </Field>
      </div>
      <Field label="Output key">
        <input className={inputCls} value={asStr(data.outputKey)} placeholder="results" onChange={(event) => update({ outputKey: event.target.value })} />
      </Field>
      <ModelPolicyField data={data} update={update} />
    </>
  );
}

function PlannerForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  return (
    <>
      <Field label="Goal" hint="The planner turns this objective into an ordered execution plan.">
        <textarea className={textareaCls} rows={5} value={asStr(data.goal)} onChange={(event) => update({ goal: event.target.value })} placeholder="Prepare, review, and publish the weekly product update." />
      </Field>
      <Field label="Maximum steps">
        <input className={inputCls} type="number" min={1} max={24} value={typeof data.maxNodes === 'number' ? data.maxNodes : 8} onChange={(event) => update({ maxNodes: Math.max(1, Number(event.target.value || 1)) })} />
      </Field>
      <ModelPolicyField data={data} update={update} />
    </>
  );
}

function ArtifactCollectForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  return (
    <>
      <Field label="Collection name">
        <input
          type="text"
          className={inputCls}
          value={asStr(data.collectionName)}
          placeholder="Campaign Pack Q3"
          onChange={(e) => update({ collectionName: e.target.value })}
        />
      </Field>
      <Field label="Artifact path (optional)" hint="Path into the input where artifact refs live. Defaults to the whole input.">
        <input
          type="text"
          className={inputCls}
          value={asStr(data.artifactPath)}
          placeholder="artifacts"
          onChange={(e) => update({ artifactPath: e.target.value || undefined })}
        />
      </Field>
      <Field label="Versioned">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={data.versioned !== false}
            onChange={(e) => update({ versioned: e.target.checked })}
            className="rounded border-line bg-surface-2 accent-accent"
          />
          <span className="text-[12px] text-text-primary">Increment version on each run</span>
        </label>
      </Field>
      <Field label="Require approval">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={data.requireApproval === true}
            onChange={(e) => update({ requireApproval: e.target.checked })}
            className="rounded border-line bg-surface-2 accent-accent"
          />
          <span className="text-[12px] text-text-primary">Hold for operator review</span>
        </label>
      </Field>
    </>
  );
}

// ─── Output surface & native browser ────────────────────────────────────────

function ReturnOutputForm({ data, update, upstream }: { data: Record<string, unknown>; update: NodeFormProps['update']; upstream?: UpstreamNode[] }) {
  return (
    <>
      <Field label="Render as" hint="How the Output tab renders this result.">
        <select className={selectCls} value={asStr(data.renderAs) || 'json'} onChange={(e) => update({ renderAs: e.target.value })}>
          <option value="html">HTML — live sandboxed preview</option>
          <option value="markdown">Markdown — rendered</option>
          <option value="table">Table — rows</option>
          <option value="json">JSON — collapsible</option>
          <option value="text">Text — plain</option>
        </select>
      </Field>
      <Field label="Title (optional)" hint="Heading shown above the rendered output.">
        <input type="text" className={inputCls} value={asStr(data.title)} placeholder="Weekly digest" onChange={(e) => update({ title: e.target.value || undefined })} />
      </Field>
      <Field label="Value path (optional)" hint="Dot path into the input to render. Blank = whole input. Type `{{` to pick.">
        <TemplatedTextField
          placeholder="nodes.summary.text"
          value={asStr(data.valuePath)}
          onChange={(next) => update({ valuePath: next || undefined })}
          upstream={upstream}
        />
      </Field>
    </>
  );
}

function ArtifactSaveForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  return (
    <>
      <Field label="File name" hint="e.g. report.html, leads.csv — extension drives the artifact type.">
        <input type="text" className={inputCls} value={asStr(data.name)} placeholder="report.html" onChange={(e) => update({ name: e.target.value })} />
      </Field>
      <Field label="Artifact type (optional)" hint="Override the type inferred from the file name.">
        <select className={selectCls} value={asStr(data.artifactType) || ''} onChange={(e) => update({ artifactType: e.target.value || undefined })}>
          <option value="">Auto-detect</option>
          <option value="html">HTML</option>
          <option value="image">Image</option>
          <option value="document">Document</option>
          <option value="code">Code</option>
          <option value="data">Data</option>
        </select>
      </Field>
      <Field label="Content path (optional)" hint="Dot path into the input for the content to save. Blank = whole input as JSON.">
        <input type="text" className={inputCls} value={asStr(data.contentPath)} placeholder="nodes.render.content" onChange={(e) => update({ contentPath: e.target.value || undefined })} />
      </Field>
      <Field label="Title path (optional)" hint="Dot path into the input for an artifact title.">
        <input type="text" className={inputCls} value={asStr(data.titlePath)} placeholder="nodes.meta.title" onChange={(e) => update({ titlePath: e.target.value || undefined })} />
      </Field>
    </>
  );
}

function BrowserForm({ data, update, upstream }: { data: Record<string, unknown>; update: NodeFormProps['update']; upstream?: UpstreamNode[] }) {
  const op = asStr(data.operation) || 'serve_html';
  const usesHtml = op === 'serve_html' || op === 'screenshot' || op === 'pdf';
  const usesUrl = op === 'screenshot' || op === 'pdf' || op === 'navigate' || op === 'extract_text' || op === 'fill_form' || op === 'extract_table';
  return (
    <>
      <Field label="Operation" hint="Native Chromium runs headless; Chromium auto-installs on first use.">
        <select className={selectCls} value={op} onChange={(e) => update({ operation: e.target.value })}>
          <option value="serve_html">serve_html — render HTML + screenshot</option>
          <option value="screenshot">screenshot — capture a URL/HTML → PNG</option>
          <option value="pdf">pdf — print a URL/HTML → PDF</option>
          <option value="navigate">navigate — load URL, return title/text</option>
          <option value="extract_text">extract_text — text under a selector</option>
          <option value="fill_form">fill_form — fill fields + submit</option>
          <option value="extract_table">extract_table — table → rows</option>
        </select>
      </Field>
      {op === 'fill_form' && (
        <>
          <Field label="Form data (JSON)" hint='Map of CSS selector → value, e.g. {"#email": "a@b.com"}.'>
            <textarea
              rows={4}
              spellCheck={false}
              className={textareaCls + ' font-mono text-[11px]'}
              value={JSON.stringify(typeof data.formData === 'object' && data.formData ? data.formData : {}, null, 2)}
              onChange={(e) => { try { update({ formData: JSON.parse(e.target.value) as unknown }); } catch { /* keep */ } }}
            />
          </Field>
          <Field label="Submit selector (optional)" hint="Element to click after filling.">
            <input type="text" className={inputCls} value={asStr(data.submitSelector)} placeholder="button[type=submit]" onChange={(e) => update({ submitSelector: e.target.value || undefined })} />
          </Field>
        </>
      )}
      {usesUrl && (
        <Field label="URL" hint="Type `{{` to insert a variable.">
          <TemplatedTextField placeholder="https://example.com" value={asStr(data.url)} onChange={(next) => update({ url: next })} upstream={upstream} />
          <div className="mt-1.5">
            <FieldPicker
              upstream={upstream ?? []}
              dialect="template"
              onInsert={(expr) => {
                const cur = asStr(data.url);
                update({ url: cur.trim() ? `${cur}${expr}` : expr });
              }}
            />
          </div>
        </Field>
      )}
      {usesHtml && (
        <>
          <Field label="HTML path (optional)" hint="Dot path into the input for the HTML string (chains after a transform).">
            <input type="text" className={inputCls} value={asStr(data.htmlPath)} placeholder="content" onChange={(e) => update({ htmlPath: e.target.value || undefined })} />
          </Field>
          <Field label="Inline HTML (optional)" hint="Used when no HTML path is set.">
            <TemplatedTextField multiline mono rows={4} placeholder="<h1>Hello World</h1>" value={asStr(data.html)} onChange={(next) => update({ html: next || undefined })} upstream={upstream} />
          </Field>
        </>
      )}
      {(op === 'extract_text' || op === 'extract_table') && (
        <Field label="Selector" hint={op === 'extract_table' ? 'Table selector (defaults to first <table>).' : 'CSS selector to extract (defaults to body).'}>
          <input type="text" className={inputCls} value={asStr(data.selector)} placeholder={op === 'extract_table' ? 'table.results' : 'main article'} onChange={(e) => update({ selector: e.target.value || undefined })} />
        </Field>
      )}
      <Field label="Open visible window">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={data.headless === false}
            onChange={(e) => update({ headless: e.target.checked ? false : undefined })}
            className="rounded border-line bg-surface-2 accent-accent"
          />
          <span className="text-[12px] text-text-primary">Show a real browser window on the host (else headless)</span>
        </label>
      </Field>
      <Accordion title="Advanced Settings">
        {(op === 'serve_html' || op === 'screenshot') && (
          <Field label="Full page">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={data.fullPage === true}
                onChange={(e) => update({ fullPage: e.target.checked ? true : undefined })}
                className="rounded border-line bg-surface-2 accent-accent"
              />
              <span className="text-[12px] text-text-primary">Capture the full scrollable page (else the viewport)</span>
            </label>
          </Field>
        )}
        <Field label="Viewport (px)" hint="Browser window size; empty = default.">
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              className={inputCls}
              min={100}
              placeholder="1280"
              value={typeof (data.viewport as { width?: number } | undefined)?.width === 'number' ? (data.viewport as { width: number }).width : ''}
              onChange={(e) => {
                const width = e.target.value === '' ? undefined : Number(e.target.value);
                const height = (data.viewport as { height?: number } | undefined)?.height;
                update({ viewport: width && height ? { width, height } : width ? { width, height: 800 } : undefined });
              }}
            />
            <span className="text-[11px] text-text-muted">×</span>
            <input
              type="number"
              className={inputCls}
              min={100}
              placeholder="800"
              value={typeof (data.viewport as { height?: number } | undefined)?.height === 'number' ? (data.viewport as { height: number }).height : ''}
              onChange={(e) => {
                const height = e.target.value === '' ? undefined : Number(e.target.value);
                const width = (data.viewport as { width?: number } | undefined)?.width;
                update({ viewport: width && height ? { width, height } : height ? { width: 1280, height } : undefined });
              }}
            />
          </div>
        </Field>
        <Field label="Timeout (ms)" hint="Bounded by the engine to 120000 (2 minutes); default 30000.">
          <input
            type="number"
            className={inputCls}
            min={1}
            max={120000}
            placeholder="30000"
            value={typeof data.timeout === 'number' ? data.timeout : ''}
            onChange={(e) => update({ timeout: e.target.value === '' ? undefined : Number(e.target.value) })}
          />
        </Field>
        {(op === 'serve_html' || op === 'screenshot' || op === 'pdf') && (
          <Field label="Artifact name" hint="Filename for the saved screenshot/PDF asset.">
            <input
              type="text"
              className={inputCls + ' font-mono'}
              placeholder={op === 'pdf' ? 'page.pdf' : 'screenshot.png'}
              value={asStr(data.artifactName)}
              onChange={(e) => update({ artifactName: e.target.value || undefined })}
            />
          </Field>
        )}
      </Accordion>
    </>
  );
}

function VariablesForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  return (
    <>
      <Field label="Operation">
        <select className={selectCls} value={asStr(data.operation) || 'read'} onChange={(e) => update({ operation: e.target.value })}>
          <option value="read">Read</option>
          <option value="write">Write</option>
          <option value="append">Append</option>
          <option value="delete">Delete</option>
        </select>
      </Field>
      <Field label="Key">
        <input
          type="text"
          className={inputCls}
          placeholder="my.variable"
          value={asStr(data.key)}
          onChange={(e) => update({ key: e.target.value })}
        />
      </Field>
      <Field label="Value path (optional)">
        <input
          type="text"
          className={inputCls}
          placeholder="$.input.foo"
          value={asStr(data.valuePath)}
          onChange={(e) => update({ valuePath: e.target.value })}
        />
      </Field>
    </>
  );
}

// Kinds with a real zod schema (packages/core) but no bespoke `XxxForm` —
// n8n-style utility/data primitives. `SchemaDrivenFields` introspects the
// schema's shape so every supported field renders as a typed input from the
// moment the node is dropped on the canvas, not only once it already has data.
const GENERIC_SCHEMA_KINDS = new Set(Object.keys(schemas.genericFormNodeConfigSchemas));

function GenericForm({ kind, data, update }: { kind: string; data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  if (GENERIC_SCHEMA_KINDS.has(kind)) {
    const schema = schemas.genericFormNodeConfigSchemas[kind as keyof typeof schemas.genericFormNodeConfigSchemas];
    return <SchemaDrivenFields schema={schema} data={data} update={update} />;
  }
  return <RawGenericForm data={data} update={update} />;
}

/** Last-resort fallback for kinds with no dedicated form AND no known schema:
 *  raw key/value editors over whatever config keys the node already carries. */
function RawGenericForm({ data, update }: { data: Record<string, unknown>; update: NodeFormProps['update'] }) {
  const entries = useMemo(() => Object.entries(data).filter(([k]) => k !== 'kind' && k !== 'isOutput'), [data]);
  if (entries.length === 0) {
    return (
      <p className="text-[12px] text-text-muted">
        This node has no form-configurable fields yet. Open Advanced (the gear in the header) to edit raw config.
      </p>
    );
  }
  return (
    <>
      {entries.map(([key, value]) => {
        const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
        const isBool = typeof value === 'boolean';
        const isNum = typeof value === 'number';
        const isObj = value !== null && typeof value === 'object';
        return (
          <Field key={key} label={label}>
            {isBool ? (
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={value as boolean}
                  onChange={(e) => update({ [key]: e.target.checked })}
                  className="rounded border-line bg-surface-2 accent-accent"
                />
                <span className="text-[12px] text-text-primary">{(value as boolean) ? 'true' : 'false'}</span>
              </label>
            ) : isNum ? (
              <input
                type="number"
                className={inputCls}
                value={String(value)}
                onChange={(e) => update({ [key]: Number(e.target.value) })}
              />
            ) : isObj ? (
              <textarea
                rows={3}
                spellCheck={false}
                className={textareaCls + ' font-mono text-[11px]'}
                value={JSON.stringify(value, null, 2)}
                onChange={(e) => {
                  try { update({ [key]: JSON.parse(e.target.value) as unknown }); }
                  catch { /* keep parent */ }
                }}
              />
            ) : (
              <input
                type="text"
                className={inputCls}
                value={asStr(value)}
                onChange={(e) => update({ [key]: e.target.value })}
              />
            )}
          </Field>
        );
      })}
    </>
  );
}
