import { useMemo, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { WorkspaceApproval } from '../../lib/workspaceData';

interface HumanInputField {
  key: string;
  label?: string;
  type?: string;
  required?: boolean;
  options?: Array<{ value: string; label?: string }>;
}

export interface HumanInputFormSpec {
  targetId?: string;
  prompt?: string | null;
  fields: HumanInputField[];
  /** Present when the node re-parked because a prior approve missed a field. */
  blocked?: string;
}


export function humanInputFormOf(approval: WorkspaceApproval | null | undefined): HumanInputFormSpec | null {
  const form = approval?.payload && typeof approval.payload === 'object'
    ? (approval.payload as { humanInputForm?: unknown }).humanInputForm
    : undefined;
  if (!form || typeof form !== 'object') return null;
  const spec = form as HumanInputFormSpec;
  return Array.isArray(spec.fields) ? spec : null;
}

/**
 * Renders a human_input node's fields and resolves the approval with the
 * collected values. Required fields are enforced client-side (the engine
 * re-parks on a miss regardless, so this is guidance, not the gate).
 */
export function HumanInputApprovalForm({
  spec,
  busy,
  onResolve,
}: {
  spec: HumanInputFormSpec;
  busy?: boolean;
  onResolve: (decision: 'approve' | 'reject', data?: Record<string, unknown>) => void | Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, unknown>>({});

  const missing = useMemo(
    () => spec.fields.filter((f) => {
      if (!f.required) return false;
      const v = values[f.key];
      return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    }).map((f) => f.label?.trim() || f.key),
    [spec.fields, values],
  );

  const set = (key: string, value: unknown) => setValues((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="space-y-3">
      {spec.blocked && (
        <p className="rounded-[10px] border border-warn/40 bg-warn-soft px-3 py-2 text-[12px] text-warn">{spec.blocked}</p>
      )}
      {spec.fields.map((field) => {
        const label = field.label?.trim() || field.key;
        const id = `hi-${field.key}`;
        return (
          <div key={field.key} className="space-y-1">
            <label htmlFor={id} className="block text-[12px] font-medium text-text-secondary">
              {label}{field.required ? <span className="text-danger"> *</span> : null}
            </label>
            {field.type === 'boolean' ? (
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  id={id}
                  type="checkbox"
                  checked={values[field.key] === true}
                  onChange={(e) => set(field.key, e.target.checked)}
                  className="rounded border-line bg-surface-2 accent-accent"
                />
                <span className="text-[11px] text-text-primary">Yes</span>
              </label>
            ) : field.type === 'select' && Array.isArray(field.options) ? (
              <select
                id={id}
                value={typeof values[field.key] === 'string' ? (values[field.key] as string) : ''}
                onChange={(e) => set(field.key, e.target.value || undefined)}
                className="s-input"
              >
                <option value="">Choose…</option>
                {field.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label ?? opt.value}</option>
                ))}
              </select>
            ) : field.type === 'textarea' ? (
              <textarea
                id={id}
                rows={5}
                value={values[field.key] == null ? '' : String(values[field.key])}
                onChange={(e) => set(field.key, e.target.value || undefined)}
                className="s-input resize-y"
              />
            ) : (
              <input
                id={id}
                type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                value={values[field.key] == null ? '' : String(values[field.key])}
                onChange={(e) => {
                  const raw = e.target.value;
                  set(field.key, field.type === 'number' ? (raw === '' ? undefined : Number(raw)) : (raw || undefined));
                }}
                className="s-input"
              />
            )}
          </div>
        );
      })}
      <div className="flex items-center gap-2 pt-1.5">
        <button
          type="button"
          disabled={busy || missing.length > 0}
          title={missing.length > 0 ? `Missing: ${missing.join(', ')}` : undefined}
          onClick={() => void onResolve('approve', values)}
          className="s-btn s-btn-primary"
        >
          <Check size={13} /> Submit
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onResolve('reject')}
          className="s-btn s-btn-danger"
        >
          <X size={13} /> Reject
        </button>
      </div>
    </div>
  );
}


