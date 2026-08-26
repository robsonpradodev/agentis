/**
 * WorkspaceBundleModal — export / import a whole workspace as a `.agentis` bundle.
 *
 * Export: pick a profile (share | sell) and download the signed-by-checksum
 * envelope, or take a full-fidelity local backup. Import: preview what a bundle
 * contains (and what is stripped) before installing it into THIS workspace.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowUpFromLine, Boxes, BrainCircuit, Download, HardDrive, Loader2, Plug, ShieldCheck, Sparkles, X } from 'lucide-react';
import type { BundleFidelity, WorkspaceBundleEnvelope, WorkspaceBundlePreview } from '@agentis/core';
import { apiErrorMessage } from '../../lib/api';
import { workspaceBundleApi } from '../../lib/workspaceBundle';
import { useToast } from '../shared/Toast';
import { Button } from '../shared/Button';

type Profile = 'share' | 'sell';

/** Facet-level pick of what learned state travels — the granular "send/receive whatever you want". */
interface Facets {
  includeAgentBrains: boolean;
  includeAppBrains: boolean;
  includeWorkspaceBrain: boolean;
  includeKnowledge: boolean;
  includeCollectionData: boolean;
}
const ALL_FACETS: Facets = {
  includeAgentBrains: true,
  includeAppBrains: true,
  includeWorkspaceBrain: true,
  includeKnowledge: true,
  includeCollectionData: true,
};
const FACET_LABELS: Array<{ key: keyof Facets; label: string }> = [
  { key: 'includeAgentBrains', label: 'Agent brains' },
  { key: 'includeAppBrains', label: 'App brains' },
  { key: 'includeWorkspaceBrain', label: 'Workspace memory' },
  { key: 'includeKnowledge', label: 'Knowledge' },
  { key: 'includeCollectionData', label: 'Collection data' },
];

export function WorkspaceBundleModal({
  importEnvelope,
  onClose,
  onImported,
}: {
  /** When provided, the modal opens straight into the import-confirm flow. */
  importEnvelope?: WorkspaceBundleEnvelope;
  onClose: () => void;
  onImported: () => void;
}) {
  const toast = useToast();
  const [mode] = useState<'export' | 'import'>(importEnvelope ? 'import' : 'export');
  const [profile, setProfile] = useState<Profile>('share');
  // Workspace Settings opens this as a machine-to-machine transfer. Default to
  // the complete portable shape; operators may still deliberately opt down.
  const [fidelity, setFidelity] = useState<BundleFidelity>('full');
  const [facets, setFacets] = useState<Facets>(ALL_FACETS);
  const [name, setName] = useState('');
  const [license, setLicense] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<WorkspaceBundlePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!importEnvelope) return;
    let cancelled = false;
    workspaceBundleApi.preview(importEnvelope)
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((err) => { if (!cancelled) setPreviewError(apiErrorMessage(err)); });
    return () => { cancelled = true; };
  }, [importEnvelope]);

  async function doExport() {
    setBusy(true);
    try {
      const envelope = await workspaceBundleApi.export({
        profile,
        fidelity,
        ...(fidelity === 'full' ? { selection: facets } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(profile === 'sell' && license.trim() ? { license: license.trim() } : {}),
      });
      downloadJson(envelope, `${slugify(envelope.name)}.agentis`);
      toast.success('Workspace exported', `${envelope.name} (${profile} · ${fidelity})`);
      onClose();
    } catch (err) {
      toast.error('Export failed', apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function doBackup() {
    setBusy(true);
    try {
      const res = await workspaceBundleApi.backup();
      toast.success('Backup created', res.outDir);
      onClose();
    } catch (err) {
      toast.error('Backup failed', apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function doImport(selection?: Facets) {
    if (!importEnvelope) return;
    setBusy(true);
    try {
      const result = await workspaceBundleApi.import(importEnvelope, selection);
      const extra = result.brainAtoms || result.collectionRows
        ? `, ${result.brainAtoms} memor${result.brainAtoms === 1 ? 'y' : 'ies'}, ${result.collectionRows} row(s)`
        : '';
      toast.success('Workspace imported', `${result.apps} app(s), ${result.agents} agent(s)${extra}`);
      onImported();
      onClose();
    } catch (err) {
      toast.error('Import failed', apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-canvas/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="flex max-h-[88vh] w-[min(560px,94vw)] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-modal" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 border-b border-line px-5 py-4">
          <Boxes size={16} className="text-accent" />
          <div className="flex-1">
            <div className="text-[10px] uppercase tracking-wider text-text-muted">Workspace bundle</div>
            <div className="text-[14px] font-semibold text-text-primary">{mode === 'import' ? 'Import workspace' : 'Export workspace'}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-5">
          {mode === 'export' ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <ProfileCard active={profile === 'share'} onClick={() => setProfile('share')} title="Share" desc="No secrets travel — only the list of which to reconnect." />
                <ProfileCard active={profile === 'sell'} onClick={() => setProfile('sell')} title="Sell" desc="Like share + signed + licence. Blocked if a secret/PII is detected." />
              </div>

              <Field label="What travels">
                <div className="grid grid-cols-2 gap-2">
                  <ProfileCard active={fidelity === 'shareable'} onClick={() => setFidelity('shareable')} title="Structure only" desc="Apps, agents, workflows, surfaces & schemas — no learned memory or data." />
                  <ProfileCard active={fidelity === 'full'} onClick={() => setFidelity('full')} title="Full — share intelligence" desc="Also carries Brain memory, knowledge & collection rows. Still no secret values." />
                </div>
              </Field>

              {fidelity === 'full' && (
                <div className="rounded-card border border-accent/30 bg-accent-soft/25 px-3 py-2.5">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent">
                    <Sparkles size={13} /> Include intelligence
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                    {FACET_LABELS.map((f) => (
                      <Toggle key={f.key} label={f.label} checked={facets[f.key]} onChange={(v) => setFacets((prev) => ({ ...prev, [f.key]: v }))} />
                    ))}
                  </div>
                </div>
              )}

              <Field label="Bundle name (optional)">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My workspace" className={INPUT} />
              </Field>
              {profile === 'sell' && (
                <Field label="Licence (optional)">
                  <textarea value={license} onChange={(e) => setLicense(e.target.value)} rows={3} placeholder="e.g. Single-workspace commercial licence…" className={`${INPUT} resize-y`} />
                </Field>
              )}

              <div className="flex items-start gap-2 rounded-card border border-line bg-canvas/45 px-3 py-2.5 text-[11.5px] text-text-muted">
                <ShieldCheck size={14} className="mt-0.5 shrink-0 text-text-secondary" />
                Secret values never travel — even a Full bundle carries only credential slots to reconnect. For an exact copy including secrets, use a local Backup.
              </div>

              <div className="flex items-center gap-2 border-t border-line pt-4">
                <Button variant="primary" size="md" iconLeft={busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowUpFromLine size={14} />} onClick={() => void doExport()} disabled={busy}>
                  Export .agentis
                </Button>
                <Button variant="ghost" size="md" iconLeft={<HardDrive size={14} />} onClick={() => void doBackup()} disabled={busy}>
                  Full backup (local)
                </Button>
              </div>
            </div>
          ) : (
            <ImportPreview envelope={importEnvelope!} preview={preview} error={previewError} busy={busy} onConfirm={(sel) => void doImport(sel)} />
          )}
        </div>
      </div>
    </div>
  );
}

function ImportPreview({
  envelope,
  preview,
  error,
  busy,
  onConfirm,
}: {
  envelope: WorkspaceBundleEnvelope;
  preview: WorkspaceBundlePreview | null;
  error: string | null;
  busy: boolean;
  onConfirm: (selection: Facets) => void;
}) {
  const [facets, setFacets] = useState<Facets>(ALL_FACETS);
  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-card border border-danger/30 bg-danger-soft px-3 py-2.5 text-[12px] text-danger">
        <AlertTriangle size={14} /> {error}
      </div>
    );
  }
  if (!preview) {
    return <div className="flex items-center gap-2 py-6 text-[12px] text-text-muted"><Loader2 size={14} className="animate-spin" /> Inspecting bundle…</div>;
  }
  const c = preview.counts;
  const isFull = preview.fidelity === 'full';
  const setup = preview.setup;
  const needsSetup = setup.credentials.length + setup.plugins.length + setup.connections.length;
  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <div className="text-[14px] font-semibold text-text-primary">{preview.name}</div>
          <span className={`rounded-pill px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${isFull ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-text-muted'}`}>
            {isFull ? 'Full · intelligence' : 'Structure only'}
          </span>
        </div>
        <div className="mt-0.5 text-[11px] text-text-muted">
          profile: {preview.profile}{preview.author?.displayName ? ` · by ${preview.author.displayName}` : ''}{envelope.signature ? ' · ✓ signed' : ''}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2">
        <Stat label="Apps" value={c.apps} />
        <Stat label="Agents" value={c.agents} />
        <Stat label="Workflows" value={c.workflows} />
        <Stat label="Extensions" value={c.extensions} />
        <Stat label="Knowledge" value={c.knowledgeSeeds} />
        <Stat label="Brain" value={c.brainAtoms} highlight={c.brainAtoms > 0} />
        <Stat label="Data rows" value={c.collectionRows} highlight={c.collectionRows > 0} />
        <Stat label="Creds" value={c.credentialSlots} />
      </div>

      {isFull && (
        <div className="rounded-card border border-accent/30 bg-accent-soft/25 px-3 py-2.5">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent">
            <BrainCircuit size={13} /> Receive intelligence
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {FACET_LABELS.map((f) => (
              <Toggle key={f.key} label={f.label} checked={facets[f.key]} onChange={(v) => setFacets((prev) => ({ ...prev, [f.key]: v }))} />
            ))}
          </div>
        </div>
      )}

      {preview.license && (
        <Field label="Licence"><div className="rounded-card border border-line bg-canvas/45 px-3 py-2 text-[12px] text-text-secondary whitespace-pre-wrap">{preview.license}</div></Field>
      )}

      {needsSetup > 0 && (
        <div className="rounded-card border border-warn/30 bg-warn-soft/30 px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-warn">
            <Plug size={13} /> Needs setup after import
          </div>
          {setup.credentials.length > 0 && (
            <SetupRow title="Credentials to reconnect">
              {setup.credentials.map((cred) => (
                <SetupChip key={cred.key}>{cred.label} · {cred.service}</SetupChip>
              ))}
            </SetupRow>
          )}
          {setup.connections.length > 0 && (
            <SetupRow title="Connections referenced by workflows">
              {setup.connections.map((conn) => (
                <SetupChip key={conn.service} title={conn.reason}>{conn.service}</SetupChip>
              ))}
            </SetupRow>
          )}
          {setup.plugins.length > 0 && (
            <SetupRow title="Plugins that must already be installed">
              {setup.plugins.map((p) => (
                <SetupChip key={p}>{p}</SetupChip>
              ))}
            </SetupRow>
          )}
        </div>
      )}

      {preview.warnings.map((w, i) => (
        <div key={i} className="flex items-start gap-2 rounded-card border border-line bg-canvas/45 px-3 py-2 text-[11.5px] text-text-muted">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warn" /> {w}
        </div>
      ))}

      <div className="flex items-center gap-2 border-t border-line pt-4">
        <Button variant="primary" size="md" iconLeft={busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} onClick={() => onConfirm(facets)} disabled={busy}>
          Install into this workspace
        </Button>
      </div>
    </div>
  );
}

function SetupRow({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-1.5 first:mt-0">
      <div className="mb-1 text-[10.5px] text-text-muted">{title}</div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function SetupChip({ children, title }: { children: React.ReactNode; title?: string }) {
  return <span title={title} className="rounded-pill border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-text-secondary">{children}</span>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[12px] text-text-secondary">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-3.5 w-3.5 rounded border-line accent-accent" />
      {label}
    </label>
  );
}

function ProfileCard({ active, onClick, title, desc }: { active: boolean; onClick: () => void; title: string; desc: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-card border p-3 text-left transition-colors ${active ? 'border-accent bg-accent-soft/40' : 'border-line bg-canvas/45 hover:bg-surface-2'}`}
    >
      <div className={`text-[13px] font-semibold ${active ? 'text-accent' : 'text-text-primary'}`}>{title}</div>
      <div className="mt-1 text-[11px] leading-4 text-text-muted">{desc}</div>
    </button>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`rounded-card border px-2.5 py-2 text-center ${highlight ? 'border-accent/40 bg-accent-soft/30' : 'border-line bg-canvas/45'}`}>
      <div className={`text-[15px] font-semibold ${highlight ? 'text-accent' : 'text-text-primary'}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-text-muted">{label}</span>
      {children}
    </label>
  );
}

function downloadJson(value: unknown, fileName: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'workspace';
}

const INPUT = 'w-full rounded-input border border-line bg-surface-2 px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted outline-none focus:border-accent';
