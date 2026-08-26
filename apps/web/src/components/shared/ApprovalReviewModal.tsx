/**
 * Approvals — the human decision surface (INTERFACE-OVERHAUL-10X §P3).
 *
 * An approval is a DECISION DOCUMENT, not a JSON dump: the header says who is
 * asking and from where, the body says exactly what will happen (summary →
 * structured action/records/assets, every value through the kit formatter),
 * and the footer carries the three decisions — Approve / Reject / Instruct
 * differently (revise keeps the run alive with new direction). The raw payload
 * stays available, collapsed, for forensics — never the primary rendering.
 *
 * Rendered inside an App (`.s-surface`) it rides the app palette; opened from
 * platform chrome it rides the platform tokens — same component, both looks.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Database,
  FileJson,
  GitCompareArrows,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  MessageSquarePlus,
  MoveRight,
  SendHorizonal,
  ShieldCheck,
  ShieldQuestion,
  Workflow,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { refreshWorkspaceSnapshot, type WorkspaceApproval } from '../../lib/workspaceData';
import { refreshWorkspaceChromeSnapshot } from '../../lib/workspaceChromeData';
import { formatDisplay, humanizeToken } from '../apps/format';
import { HumanInputApprovalForm, humanInputFormOf } from './HumanInputApprovalForm';
import { openRunModal } from '../../lib/runModal';

export type ApprovalReview = WorkspaceApproval & {
  payload?: Record<string, unknown> | null;
};

type ApprovalDecision = 'approve' | 'reject' | 'revise';

interface ApprovalReviewModalProps {
  approval: ApprovalReview | null;
  open: boolean;
  onClose: () => void;
  onResolved?: (approval: ApprovalReview, decision: ApprovalDecision) => void | Promise<void>;
}

/** Agent-backed approvals (a session parked on `request_approval`) can be told to
 * do something different; deterministic self-heal patches only approve/reject. */
function canInstructDifferently(approval: ApprovalReview | null | undefined): boolean {
  return Boolean(approval) && approval!.source !== 'self_heal' && approval!.source !== 'outbound';
}

interface ApprovalPreviewCardProps {
  approval: ApprovalReview;
  busy?: boolean;
  compact?: boolean;
  onReview: (approval: ApprovalReview) => void;
  onApprove?: (approval: ApprovalReview) => void | Promise<void>;
  onReject?: (approval: ApprovalReview) => void | Promise<void>;
}

type AssetPreview = {
  artifactId?: string;
  ref?: string;
  title?: string;
  type?: string;
  mimeType?: string;
  url?: string;
};

export function approvalHasStructuredPayload(approval: ApprovalReview | null | undefined): boolean {
  const payload = approval?.payload;
  if (!payload || typeof payload !== 'object') return false;
  return Object.keys(payload).length > 0;
}

/** Inbox card — enough context to decide whether to open the full review. */
export function ApprovalPreviewCard({
  approval,
  busy,
  compact,
  onReview,
  onApprove,
  onReject,
}: ApprovalPreviewCardProps) {
  const selfHeal = approval.source === 'self_heal';
  const structured = approvalHasStructuredPayload(approval);
  const canInlineResolve = !structured && !humanInputFormOf(approval) && onApprove && onReject;
  const title = selfHeal ? 'Self-healing fix ready' : approval.title ?? approval.workflowName ?? 'Approval needed';
  // Don't repeat the workflow name when it IS the title (noise, and double-matches).
  const workflowLabel = approval.workflowName && approval.workflowName !== title ? approval.workflowName : null;
  // Enrich the inline card with a compact "what will happen" — action + how many
  // modal, and still has Review for the full document.
  const cardPayload = approval.payload && typeof approval.payload === 'object' ? (approval.payload as Record<string, unknown>) : {};
  const cardPreview = cardPayload.approvalPreview && typeof cardPayload.approvalPreview === 'object' ? (cardPayload.approvalPreview as Record<string, unknown>) : null;
  const actionLabel = (typeof cardPreview?.action === 'string' && cardPreview.action) || (typeof cardPayload.action === 'string' && cardPayload.action) || null;
  const recordCount = Object.keys(collectRecords(cardPayload, cardPreview)).length;
  const assetCount = collectAssets(cardPayload, cardPreview).length;
  const changeCount = Object.keys(collectDiffs(cardPayload, cardPreview)).length;
  const chips = [
    actionLabel ? humanizeToken(String(actionLabel)) : null,
    recordCount ? `${recordCount} field${recordCount === 1 ? '' : 's'}` : null,
    assetCount ? `${assetCount} asset${assetCount === 1 ? '' : 's'}` : null,
    changeCount ? `${changeCount} change${changeCount === 1 ? '' : 's'}` : null,
  ].filter((v): v is string => Boolean(v));
  return (
    <div className={clsx(
      'rounded-[14px] border bg-surface',
      selfHeal ? 'border-accent-muted' : 'border-warn/30',
      compact ? 'px-3 py-2.5' : 'px-3.5 py-3',
    )}>
      <div className="flex min-w-0 items-start gap-3">
        <span className={clsx(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]',
          selfHeal ? 'bg-accent-soft text-accent' : 'bg-warn-soft text-warn',
        )}>
          {selfHeal ? <ShieldCheck size={16} /> : <ShieldQuestion size={16} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13.5px] font-semibold text-text-primary">{title}</span>
            <span className="s-chip ml-auto shrink-0 bg-surface-2 text-[10px] uppercase tracking-wide text-text-muted">
              {approval.source?.replace(/_/g, ' ') ?? 'approval'}
            </span>
          </div>
          {workflowLabel || approval.agentName ? (
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] text-text-muted">
              {workflowLabel ? <span className="truncate">{workflowLabel}</span> : null}
              {workflowLabel && approval.agentName ? <span aria-hidden>·</span> : null}
              {approval.agentName ? <span className="truncate">{approval.agentName}</span> : null}
            </div>
          ) : null}
          {approval.summary ? (
            <p className="mt-1.5 line-clamp-2 whitespace-pre-line text-[12.5px] leading-relaxed text-text-secondary">
              {approval.summary}
            </p>
          ) : null}
          {chips.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {chips.map((chip) => (
                <span key={chip} className="s-chip bg-surface-2 text-[10.5px] text-text-secondary">{chip}</span>
              ))}
            </div>
          ) : null}
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <button type="button" disabled={busy} onClick={() => onReview(approval)} className="s-btn s-btn-secondary s-btn-sm">
              <Maximize2 size={11} /> Review
            </button>
            {canInlineResolve ? (
              <>
                <button type="button" disabled={busy} onClick={() => void onApprove?.(approval)} className="s-btn s-btn-primary s-btn-sm">
                  <Check size={11} /> Approve
                </button>
                <button type="button" disabled={busy} onClick={() => void onReject?.(approval)} className="s-btn s-btn-ghost s-btn-sm !text-danger">
                  <X size={11} /> Reject
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ApprovalReviewModal({ approval, open, onClose, onResolved }: ApprovalReviewModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instructOpen, setInstructOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const payload = approval?.payload && typeof approval.payload === 'object' ? approval.payload : {};
  const preview = payload.approvalPreview && typeof payload.approvalPreview === 'object'
    ? payload.approvalPreview as Record<string, unknown>
    : null;
  const humanInputForm = humanInputFormOf(approval);
  const assets = useMemo(() => collectAssets(payload, preview), [payload, preview]);
  const records = useMemo(() => collectRecords(payload, preview), [payload, preview]);
  const diffs = useMemo(() => collectDiffs(payload, preview), [payload, preview]);
  const hasPayload = approvalHasStructuredPayload(approval);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, open]);

  // Reset the "instruct differently" composer whenever a different approval opens.
  useEffect(() => {
    setInstructOpen(false);
    setInstruction('');
    setError(null);
  }, [approval?.id, open]);

  if (!open || !approval) return null;

  async function resolve(decision: ApprovalDecision, opts?: { data?: Record<string, unknown>; feedback?: string }) {
    if (!approval) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/approvals/${approval.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({
          decision,
          ...(opts?.data ? { data: opts.data } : {}),
          ...(opts?.feedback ? { feedback: opts.feedback } : {}),
        }),
      });
      await Promise.all([
        refreshWorkspaceSnapshot(),
        refreshWorkspaceChromeSnapshot(),
      ]);
      await onResolved?.(approval, decision);
      onClose();
    } catch (err) {
      // A candidate can be discarded between opening this dialog and clicking
      // a decision. The API retires that approval as expired; refresh and
      // close rather than leaving the operator with a misleading error.
      if (isExpiredApprovalConflict(err)) {
        await Promise.all([
          refreshWorkspaceSnapshot(),
          refreshWorkspaceChromeSnapshot(),
        ]);
        onClose();
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not resolve approval.');
    } finally {
      setBusy(false);
    }
  }

  const selfHeal = approval.source === 'self_heal';
  const sourceLabel = approval.source?.replace(/_/g, ' ') ?? 'approval';
  const title = approval.title ?? approval.workflowName ?? 'Approval needed';
  const actionable = !approval.status || approval.status === 'pending';
  return (
    <div className="pointer-events-auto fixed inset-0 z-[10100] flex items-center justify-center bg-overlay p-4 backdrop-blur-[3px]" role="dialog" aria-modal="true">
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-canvas"
        style={{ boxShadow: 'var(--app-modal-shadow, var(--shadow-modal))' }}
      >
        {/* Header — who is asking, from where */}
        <header className="border-b border-line bg-surface px-6 pb-4 pt-5">
          <div className="flex items-start gap-3.5">
            <span className={clsx(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
              selfHeal ? 'bg-accent-soft text-accent' : 'bg-warn-soft text-warn',
            )}>
              {selfHeal ? <ShieldCheck size={19} /> : <ShieldQuestion size={19} />}
            </span>
            <div className="min-w-0 flex-1">
              <div className={clsx('s-label', selfHeal ? '!text-accent' : '!text-warn')}>
                {selfHeal ? 'Self-healing fix ready' : 'Needs your decision'}
              </div>
              <h2 className="mt-0.5 truncate text-[17px] font-semibold tracking-[-0.01em] text-text-primary">{title}</h2>
            </div>
            <button type="button" onClick={onClose} aria-label="Close approval review" title="Close" className="s-icon-btn shrink-0">
              <X size={15} />
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <MetaChip icon={<ShieldCheck size={11} />} label={sourceLabel} />
            {approval.workflowName ? <MetaChip icon={<Workflow size={11} />} label={approval.workflowName} /> : null}
            {approval.agentName ? <MetaChip icon={<Bot size={11} />} label={approval.agentName} /> : null}
            {approval.nodeTitle ? <MetaChip icon={<CircleDot size={11} />} label={approval.nodeTitle} /> : null}
            {approval.runId ? (
              <button
                type="button"
                onClick={() => openRunModal({ runId: approval.runId!, workflowId: approval.workflowId ?? undefined, source: 'approval-review' })}
                className="s-chip bg-accent-soft font-medium text-accent transition-opacity hover:opacity-85"
                title={`Open run ${approval.runId}`}
              >
                <Workflow size={11} /> Open run <span className="font-mono text-[10px]">{shortId(approval.runId)}</span>
              </button>
            ) : null}
          </div>
        </header>

        {/* Body — what exactly will happen */}
        <main className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
          {!actionable && (
            <section className="rounded-xl border border-warn/30 bg-warn-soft px-4 py-3">
              <div className="text-[12px] font-semibold text-warn">This approval is no longer actionable</div>
              <p className="mt-1 text-[12px] text-text-secondary">Its status is {approval.status}. The record remains available for history, but no decision can be submitted.</p>
            </section>
          )}
          {approval.summary ? (
            <section className="rounded-xl border border-line bg-surface p-4">
              <div className="s-label mb-1.5">The agent asks</div>
              <p className="whitespace-pre-line text-[14px] leading-relaxed text-text-primary">{approval.summary}</p>
            </section>
          ) : null}

          {humanInputForm && actionable ? (
            <Section icon={<ShieldCheck size={13} />} title="Your input">
              <HumanInputApprovalForm spec={humanInputForm} busy={busy} onResolve={(decision, data) => void resolve(decision, { data })} />
            </Section>
          ) : null}

          {preview?.action && typeof preview.action === 'object' ? (
            <ActionPreview action={preview.action as Record<string, unknown>} />
          ) : null}

          {assets.length > 0 ? (
            <Section icon={<ImageIcon size={13} />} title="Assets">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {assets.map((asset, index) => <AssetTile key={`${asset.artifactId ?? asset.ref ?? asset.url ?? index}`} asset={asset} />)}
              </div>
            </Section>
          ) : null}

          {Object.keys(records).length > 0 ? (
            <Section icon={<Database size={13} />} title="Records">
              <RecordSections records={records} />
            </Section>
          ) : null}

          {Object.keys(diffs).length > 0 ? (
            <Section icon={<GitCompareArrows size={13} />} title="What changes">
              <RecordSections records={diffs} />
            </Section>
          ) : null}

          {hasPayload ? (
            <RawPayload payload={redactValue(payload)} />
          ) : !approval.summary && !humanInputForm ? (
            <section className="rounded-xl border border-dashed border-line bg-surface/50 px-4 py-8 text-center">
              <div className="text-[13px] font-medium text-text-secondary">No structured review data</div>
              <div className="mt-1 text-[12px] text-text-muted">Use the run context above before deciding.</div>
            </section>
          ) : null}
        </main>

        {/* Footer — the decision bar */}
        {!humanInputForm && actionable && (
          <footer className="border-t border-line bg-surface px-6 py-4">
            {instructOpen ? (
              /* Third option — send a new instruction back to the waiting agent
                 WITHOUT cancelling, so the run continues with your direction. */
              <div className="flex flex-col gap-2.5">
                <label className="s-label">Instruct the agent differently</label>
                <textarea
                  autoFocus
                  value={instruction}
                  disabled={busy}
                  onChange={(event) => setInstruction(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && instruction.trim()) {
                      void resolve('revise', { feedback: instruction.trim() });
                    }
                  }}
                  rows={3}
                  placeholder="Tell the agent what to do instead — it keeps working with your new direction, nothing is lost."
                  className="s-input"
                />
                <div className="flex items-center gap-2">
                  {error
                    ? <span className="min-w-0 flex-1 truncate text-[12.5px] text-danger">{error}</span>
                    : <span className="min-w-0 flex-1 text-[12px] text-text-muted">The run stays alive — the agent adjusts and continues.</span>}
                  <button type="button" disabled={busy} onClick={() => { setInstructOpen(false); setInstruction(''); }} className="s-btn s-btn-ghost">
                    Back
                  </button>
                  <button type="button" disabled={busy || !instruction.trim()} onClick={() => void resolve('revise', { feedback: instruction.trim() })} className="s-btn s-btn-primary">
                    {busy ? <Loader2 size={13} className="animate-spin" /> : <SendHorizonal size={13} />} Send instruction
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                {error
                  ? <span className="min-w-0 flex-1 truncate text-[12.5px] text-danger">{error}</span>
                  : <span className="min-w-0 flex-1 text-[12px] text-text-muted">Your decision applies to this approval only.</span>}
                {canInstructDifferently(approval) ? (
                  <button type="button" disabled={busy} onClick={() => { setError(null); setInstructOpen(true); }} className="s-btn s-btn-ghost">
                    <MessageSquarePlus size={13} /> Instruct differently
                  </button>
                ) : null}
                <button type="button" disabled={busy} onClick={() => void resolve('reject')} className="s-btn s-btn-danger">
                  <X size={13} /> Reject
                </button>
                <button type="button" disabled={busy} onClick={() => void resolve('approve')} className="s-btn s-btn-primary">
                  {busy ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />} Approve
                </button>
              </div>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}

function MetaChip({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span className="s-chip max-w-[220px] bg-surface-2 text-text-secondary">
      <span className="shrink-0 text-text-muted">{icon}</span>
      <span className="truncate">{label}</span>
    </span>
  );
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="text-text-muted">{icon}</span>
        <span className="s-label">{title}</span>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function ActionPreview({ action }: { action: Record<string, unknown> }) {
  const fields = Array.isArray(action.fields) ? action.fields as Array<{ key?: unknown; value?: unknown }> : [];
  const kindBits = [action.kind, action.type].filter(Boolean).map(String);
  return (
    <Section icon={<ShieldCheck size={13} />} title="The action">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-semibold text-text-primary">{String(action.label ?? action.title ?? 'Approval action')}</span>
        {kindBits.map((bit) => <span key={bit} className="s-chip bg-surface-2 text-text-muted">{humanizeToken(bit)}</span>)}
      </div>
      {fields.length > 0 ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {fields.map((field, index) => (
            <div key={`${String(field.key ?? index)}-${index}`} className="min-w-0 rounded-[10px] bg-surface-2/70 px-3 py-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.07em] text-text-muted">{humanizeToken(String(field.key ?? 'field'))}</div>
              <div className="mt-1 break-words text-[12.5px] text-text-primary">{formatDisplay(field.value, { key: String(field.key ?? '') })}</div>
            </div>
          ))}
        </div>
      ) : null}
    </Section>
  );
}

function AssetTile({ asset }: { asset: AssetPreview }) {
  const label = asset.title ?? asset.artifactId ?? asset.ref ?? 'Asset';
  const imageUrl = isImageAsset(asset) && asset.url ? asset.url : null;
  const link = asset.artifactId ? `/assets?artifactId=${encodeURIComponent(asset.artifactId)}` : asset.url;
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex aspect-video items-center justify-center bg-surface-2/60">
        {imageUrl ? (
          <img src={imageUrl} alt={label} className="h-full w-full object-contain" />
        ) : (
          <ImageIcon size={22} className="text-text-muted" />
        )}
      </div>
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text-primary">{label}</span>
        {link ? (
          <a href={link} className="shrink-0 text-[11.5px] font-medium text-accent hover:underline">
            Open
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** `{from,to}` / `{before,after}` shapes render as a real change, not raw JSON. */
function diffPair(value: unknown): { from: unknown; to: unknown } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length > 3) return null;
  if ('from' in o && 'to' in o) return { from: o.from, to: o.to };
  if ('before' in o && 'after' in o) return { from: o.before, to: o.after };
  return null;
}

function RecordSections({ records }: { records: Record<string, unknown> }) {
  return (
    <div className="space-y-3">
      {Object.entries(records).map(([key, value]) => (
        <div key={key} className="overflow-hidden rounded-[10px] border border-line/70">
          <div className="border-b border-line/70 bg-surface-2/50 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.07em] text-text-muted">{humanizeToken(key)}</div>
          <div className="p-3">
            {isPlainRecord(value) ? <KeyValueGrid value={value} /> : <JsonBlock value={redactValue(value)} />}
          </div>
        </div>
      ))}
    </div>
  );
}

function KeyValueGrid({ value }: { value: Record<string, unknown> }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {Object.entries(value).map(([key, item]) => {
        const pair = diffPair(item);
        return (
          <div key={key} className="min-w-0 rounded-[10px] bg-surface-2/60 px-3 py-2">
            <div className="truncate text-[10px] font-semibold uppercase tracking-[0.07em] text-text-muted">{humanizeToken(key)}</div>
            <div className="mt-1 break-words text-[12.5px] text-text-primary">
              {pair ? (
                <span className="inline-flex max-w-full flex-wrap items-center gap-1.5">
                  <span className="rounded bg-danger-soft px-1.5 py-0.5 text-danger line-through decoration-danger/50">{scalarText(pair.from)}</span>
                  <MoveRight size={12} className="shrink-0 text-text-muted" />
                  <span className="rounded bg-success-soft px-1.5 py-0.5 font-medium text-success">{scalarText(pair.to)}</span>
                </span>
              ) : (
                formatDisplay(redactValue(item), { key })
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Raw payload — collapsed by default; forensics, never the primary rendering. */
function RawPayload({ payload }: { payload: unknown }) {
  const [openRaw, setOpenRaw] = useState(false);
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface">
      <button
        type="button"
        onClick={() => setOpenRaw((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-surface-2/50"
        aria-expanded={openRaw}
      >
        <FileJson size={13} className="text-text-muted" />
        <span className="s-label">Raw payload</span>
        <span className="ml-auto text-text-muted">{openRaw ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
      </button>
      {openRaw ? (
        <div className="border-t border-line p-3">
          <JsonBlock value={payload} />
        </div>
      ) : null}
    </section>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[10px] border border-line/60 bg-surface-2/50 p-3 font-mono text-[11px] leading-relaxed text-text-secondary">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function collectAssets(payload: Record<string, unknown>, preview: Record<string, unknown> | null): AssetPreview[] {
  const all = [...toAssetList(payload.assets), ...toAssetList(preview?.assets)];
  const seen = new Set<string>();
  return all.filter((asset) => {
    const key = asset.artifactId ?? asset.ref ?? asset.url;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toAssetList(value: unknown): AssetPreview[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is AssetPreview => item != null && typeof item === 'object');
}

function collectRecords(payload: Record<string, unknown>, preview: Record<string, unknown> | null): Record<string, unknown> {
  return {
    ...objectOf(payload.records),
    ...objectOf(preview?.records),
  };
}

function collectDiffs(payload: Record<string, unknown>, preview: Record<string, unknown> | null): Record<string, unknown> {
  return {
    ...objectOf(payload.diff),
    ...objectOf(preview?.diff),
  };
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isImageAsset(asset: AssetPreview): boolean {
  return asset.mimeType?.startsWith('image/') || asset.type === 'image' || /\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i.test(asset.url ?? '');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((item) =>
    item == null
    || ['string', 'number', 'boolean'].includes(typeof item)
    || diffPair(item) != null);
}

const SECRET_KEY = /(password|secret|token|api[-_ ]?key|service[-_ ]?role|credential|authorization|bearer|private[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret)/i;

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[Truncated]';
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? '[Redacted]' : redactValue(nested, depth + 1);
  }
  return out;
}

function scalarText(value: unknown): string {
  if (value == null || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

function shortId(value: string): string {
  return value.length > 13 ? `${value.slice(0, 8)}…` : value;
}

function isExpiredApprovalConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; message?: unknown };
  return value.code === 'RESOURCE_CONFLICT'
    && typeof value.message === 'string'
    && value.message === 'Approval already expired';
}


