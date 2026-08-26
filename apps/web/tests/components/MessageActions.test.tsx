import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TurnChangeSummary } from '@agentis/core';
import { MessageActions } from '../../src/components/chat/ThreadView';

function summary(overrides: Partial<TurnChangeSummary> = {}): TurnChangeSummary {
  return {
    turnId: 'turn-1',
    state: 'undoable',
    version: 1,
    reversibleCount: 2,
    sensitiveCount: 0,
    externalEffectCount: 0,
    affectedResources: [],
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('MessageActions turn changes', () => {
  it('shows the compact Undo/Redo action only for reversible change sets', () => {
    const onTurnChange = vi.fn();
    const { rerender } = render(
      <div className="group">
        <MessageActions onCopy={vi.fn()} changeSet={summary()} onTurnChange={onTurnChange} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Undo 2 changes' }));
    expect(onTurnChange).toHaveBeenCalledOnce();

    rerender(
      <div className="group">
        <MessageActions onCopy={vi.fn()} changeSet={summary({ state: 'undone', version: 2 })} onTurnChange={onTurnChange} />
      </div>,
    );
    expect(screen.getByRole('button', { name: 'Redo 2 changes' })).toBeInTheDocument();

    rerender(<div className="group"><MessageActions onCopy={vi.fn()} changeSet={summary({ reversibleCount: 0 })} onTurnChange={onTurnChange} /></div>);
    expect(screen.queryByRole('button', { name: /Undo|Redo/ })).not.toBeInTheDocument();
  });

  it('keeps sensitive and external warnings inside a small anchored confirmation', () => {
    const confirm = vi.fn();
    render(
      <div className="group">
        <MessageActions
          onCopy={vi.fn()}
          changeSet={summary({ sensitiveCount: 1, externalEffectCount: 1 })}
          onTurnChange={vi.fn()}
          changePrompt={{ turnId: 'turn-1', direction: 'undo', kind: 'confirm', summary: summary({ sensitiveCount: 1, externalEffectCount: 1 }) }}
          onConfirmTurnChange={confirm}
          onDismissTurnChange={vi.fn()}
        />
      </div>,
    );
    expect(screen.getByRole('dialog', { name: 'Confirm restoration' })).toBeInTheDocument();
    expect(screen.getByText(/security-sensitive/i)).toBeInTheDocument();
    expect(screen.getByText(/External messages/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo', exact: true }));
    expect(confirm).toHaveBeenCalledWith('undo');
  });

  it('renders conflicts without offering a destructive override', () => {
    render(
      <div className="group">
        <MessageActions
          onCopy={vi.fn()}
          changeSet={summary()}
          onTurnChange={vi.fn()}
          changePrompt={{
            turnId: 'turn-1',
            direction: 'undo',
            kind: 'conflict',
            summary: summary(),
            conflicts: [{ resourceKind: 'agents', resourceId: 'agent-1', label: 'Agent · Bia', fields: ['instructions'], reason: 'overlapping_change' }],
          }}
          onDismissTurnChange={vi.fn()}
        />
      </div>,
    );
    expect(screen.getByRole('alert', { name: 'Undo conflict' })).toBeInTheDocument();
    expect(screen.getByText(/Agent · Bia/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Force' })).not.toBeInTheDocument();
  });
});
