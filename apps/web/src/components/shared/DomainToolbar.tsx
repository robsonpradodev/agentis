import { useState } from 'react';
import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { Check, ChevronDown, Plus, Settings as SettingsIcon } from 'lucide-react';

export type DomainToolbarSelection = 'all' | 'unassigned' | string;

/**
 * Order domains so each Subdomain follows its parent, and label subdomains
 * "Parent › Sub". Shared by the domain `<select>`s (workflows, agent detail) so
 * subdomains read consistently everywhere.
 */
export function nestedDomainOptions<T extends { id: string; name: string; parentDomainId?: string | null }>(
  domains: T[],
): Array<{ id: string; label: string; depth: number }> {
  const byParent = new Map<string, T[]>();
  for (const d of domains) {
    if (!d.parentDomainId) continue;
    (byParent.get(d.parentDomainId) ?? byParent.set(d.parentDomainId, []).get(d.parentDomainId)!).push(d);
  }
  const out: Array<{ id: string; label: string; depth: number }> = [];
  for (const top of domains.filter((d) => !d.parentDomainId)) {
    out.push({ id: top.id, label: top.name, depth: 0 });
    for (const sub of byParent.get(top.id) ?? []) out.push({ id: sub.id, label: `${top.name} › ${sub.name}`, depth: 1 });
  }
  return out;
}

export interface DomainToolbarDomain {
  id: string;
  name: string;
  colorHex?: string | null;
  /** When set, this is a Subdomain nested under the referenced Domain. */
  parentDomainId?: string | null;
}

interface DomainToolbarProps<TDomain extends DomainToolbarDomain> {
  domains: TDomain[];
  selected: DomainToolbarSelection;
  onSelect: (value: DomainToolbarSelection) => void;
  totalCount: number;
  countForDomain: (domainId: string | null) => number;
  onCreate?: () => void;
  onEdit?: (domain: TDomain) => void;
  /** When provided, an indented "+ Subdomain" row appears under each domain. */
  onAddSubdomain?: (parentDomainId: string) => void;
  allLabel?: string;
  unassignedLabel?: string;
  newLabel?: string;
  /** Drops the pill's own border/background so it blends into a parent toolbar. */
  embedded?: boolean;
}

type DomainRow =
  | { kind: 'select'; key: string; indent: number; value: DomainToolbarSelection; label: string; count: number; colorHex?: string | null }
  | { kind: 'add-sub'; key: string; indent: number; parentDomainId: string };

export function DomainToolbar<TDomain extends DomainToolbarDomain>({
  domains,
  selected,
  onSelect,
  totalCount,
  countForDomain,
  onCreate,
  onEdit,
  onAddSubdomain,
  allLabel = 'All domains',
  unassignedLabel = 'Unassigned',
  newLabel = 'New domain',
  embedded = false,
}: DomainToolbarProps<TDomain>) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  // Nested rows: each top-level Domain followed by its indented Subdomains.
  const rows: DomainRow[] = [
    { kind: 'select', key: 'all', indent: 0, value: 'all', label: allLabel, count: totalCount },
    { kind: 'select', key: 'unassigned', indent: 0, value: 'unassigned', label: unassignedLabel, count: countForDomain(null) },
  ];
  for (const domain of domains.filter((d) => !d.parentDomainId)) {
    rows.push({ kind: 'select', key: domain.id, indent: 0, value: domain.id, label: domain.name, count: countForDomain(domain.id), colorHex: domain.colorHex });
    for (const sub of domains.filter((d) => d.parentDomainId === domain.id)) {
      rows.push({ kind: 'select', key: sub.id, indent: 1, value: sub.id, label: sub.name, count: countForDomain(sub.id), colorHex: sub.colorHex });
    }
    if (onAddSubdomain) rows.push({ kind: 'add-sub', key: `add-${domain.id}`, indent: 1, parentDomainId: domain.id });
  }
  const selectedDomain = domains.find((domain) => domain.id === selected);
  const current = {
    label: selected === 'all' ? allLabel : selected === 'unassigned' ? unassignedLabel : selectedDomain?.name ?? allLabel,
    count: selected === 'all' ? totalCount : selected === 'unassigned' ? countForDomain(null) : countForDomain(selected),
    colorHex: selectedDomain?.colorHex ?? null,
  };
  const isActive = selected !== 'all';

  useLayoutEffect(() => {
    if (!open) {
      setMenuPosition(null);
      return undefined;
    }

    const updateMenuPosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = 256;
      setMenuPosition({
        top: rect.bottom + 6,
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      });
    };

    updateMenuPosition();
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [open]);

  return (
    <div className={clsx('flex items-center', !embedded && 'gap-1.5')}>
      <div className="relative inline-block">
        <button
          type="button"
          ref={triggerRef}
          onClick={() => setOpen((value) => !value)}
          className={clsx(
            'inline-flex items-center gap-1.5 text-[12px] font-medium transition-colors select-none',
            embedded
              ? clsx('h-7 rounded-md px-2', isActive ? 'text-accent' : 'text-text-primary hover:bg-surface-3')
              : clsx('h-8 rounded-full border px-3', isActive ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary'),
          )}
        >
          {current.colorHex && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: current.colorHex }} />}
          {!embedded && <span className="text-text-muted">Domain:</span>}
          <span className={clsx('font-semibold', isActive ? 'text-accent' : 'text-text-primary')}>{current.label}</span>
          <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[9px] font-medium text-text-muted">{current.count}</span>
          <ChevronDown size={11} className={clsx('transition-transform text-text-muted', open && 'rotate-180')} />
        </button>
        {open && menuPosition && createPortal(
          <>
            <div className="fixed inset-0 z-[1000]" onClick={() => setOpen(false)} />
            <div
              className="fixed z-[1001] w-64 origin-top-left rounded-card border border-line bg-surface shadow-modal animate-in fade-in slide-in-from-top-1 duration-150"
              style={{ top: menuPosition.top, left: menuPosition.left }}
            >
              <div className="max-h-[280px] overflow-y-auto py-1">
                {rows.map((row) => {
                  if (row.kind === 'add-sub') {
                    return (
                      <button
                        key={row.key}
                        type="button"
                        onClick={() => { onAddSubdomain?.(row.parentDomainId); setOpen(false); }}
                        className="flex w-full items-center gap-2 py-1.5 pr-3 text-left text-[11px] text-text-muted hover:bg-surface-2 hover:text-text-secondary"
                        style={{ paddingLeft: 12 + row.indent * 18 }}
                      >
                        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center"><Plus size={11} /></span>
                        <span className="flex-1 truncate">Subdomain</span>
                      </button>
                    );
                  }
                  const isSelected = row.value === selected;
                  return (
                    <button
                      key={row.key}
                      type="button"
                      onClick={() => { onSelect(row.value); setOpen(false); }}
                      className={clsx(
                        'flex w-full items-center gap-2 py-2 pr-3 text-left text-[12px] transition-colors',
                        isSelected ? 'bg-surface-2 text-text-primary font-medium' : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary',
                        row.indent > 0 && 'text-[11px]',
                      )}
                      style={{ paddingLeft: 12 + row.indent * 18 }}
                    >
                      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">{isSelected && <Check size={12} className="text-accent" />}</span>
                      {row.colorHex && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: row.colorHex }} />}
                      <span className="flex-1 truncate">{row.label}</span>
                      <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[9px] font-medium text-text-muted">{row.count}</span>
                    </button>
                  );
                })}
              </div>
              {onCreate && (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onCreate();
                  }}
                  className="flex w-full items-center gap-2 border-t border-line px-3 py-2.5 text-left text-[12px] text-text-secondary hover:bg-surface-2 hover:text-text-primary"
                >
                  <Plus size={13} className="text-text-muted" /> {newLabel}
                </button>
              )}
            </div>
          </>,
          document.body,
        )}
      </div>
      {selectedDomain && onEdit && (
        <button
          type="button"
          onClick={() => onEdit(selectedDomain)}
          aria-label={`Edit ${selectedDomain.name}`}
          title="Edit domain"
          className={clsx(
            'inline-flex items-center justify-center text-text-muted transition-colors hover:text-text-primary',
            embedded
              ? 'h-7 w-7 rounded-md hover:bg-surface-3'
              : 'h-8 w-8 rounded-full border border-line bg-surface-2 hover:border-accent/45',
          )}
        >
          <SettingsIcon size={13} />
        </button>
      )}
    </div>
  );
}



