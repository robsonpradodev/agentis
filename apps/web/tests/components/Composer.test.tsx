import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Composer, LARGE_PASTE_FILE_THRESHOLD } from '../../src/components/chat/Composer';

function stubComposerCatalogs() {
  vi.mocked(global.fetch).mockImplementation(async (input) => {
    const url = String(input);
    const body = url.includes('/v1/workflows')
      ? { workflows: [] }
      : { agents: [] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

describe('Composer', () => {
  it('updates the visible permission mode as soon as a slash-mode suggestion is selected', async () => {
    stubComposerCatalogs();
    const onPermissionModeChange = vi.fn();
    render(<Composer onSend={vi.fn()} onPermissionModeChange={onPermissionModeChange} draftKey="composer-plan-mode-test" />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '/pl', selectionStart: 3 } });
    fireEvent.click(await screen.findByText('/plan'));

    expect(onPermissionModeChange).toHaveBeenCalledWith('plan');
    expect(textarea).toHaveValue('/plan ');
  });

  it('turns the send button into the active stop control while a turn is running', () => {
    stubComposerCatalogs();
    const onSend = vi.fn();
    const onStop = vi.fn();

    render(
      <Composer
        onSend={onSend}
        isRunning
        onStop={onStop}
        draftKey="composer-stop-test"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Stop agent response' }));

    expect(onStop).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('converts a large paste into an uploaded text attachment before sending', async () => {
    vi.mocked(global.fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v1/artifacts/upload')) {
        return new Response(JSON.stringify({ artifact: { id: 'artifact-large-paste' } }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/v1/transcription/status')) {
        return new Response(JSON.stringify({ available: false }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(url.includes('/v1/workflows') ? { workflows: [] } : { agents: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const onSend = vi.fn();
    render(<Composer onSend={onSend} draftKey="composer-large-paste-test" />);
    const textarea = screen.getByRole('textbox');
    const pasted = `Complete specification\n${'x'.repeat(LARGE_PASTE_FILE_THRESHOLD)}`;

    fireEvent.paste(textarea, {
      clipboardData: { files: [], getData: (type: string) => type === 'text/plain' ? pasted : '' },
    });

    expect(textarea).toHaveValue('');
    expect(await screen.findByText('Paste secured as file')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend).toHaveBeenCalledWith('', expect.objectContaining({
      attachments: [expect.objectContaining({ id: 'artifact-large-paste', name: expect.stringMatching(/^Pasted text .*\.txt$/) })],
    }));
  });
});
