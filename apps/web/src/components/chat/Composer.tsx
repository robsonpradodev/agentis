/**
 * Composer — UIUX-REFACTOR §4.2.7.
 *
 * Power-user textarea with:
 *   - `/` slash command palette (run, pause, wake, approve, history,
 *     status, help). Hitting Enter in slash mode dispatches a
 *     `agentis:slash-command` window event so the rest of the app can
 *     react (e.g. open the workflow picker, navigate to /history).
 *   - `@` agent mention popover.
 *   - `#` resource reference popover (workflows, runs).
 *   - Keyboard shortcuts: ↑ to recall last sent, Shift+Enter newline,
 *     Enter to send.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { ArrowUp, Mic, Plus, File as FileIcon, X, Eye, Loader2, Square } from 'lucide-react';
import clsx from 'clsx';
import { api, apiErrorMessage, workspace } from '../../lib/api';
import { ComposerStatusBar } from './ComposerStatusBar';

interface SpeechRecognitionEvent {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      [index: number]: {
        transcript: string;
      };
      isFinal: boolean;
    };
  };
}

interface SpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: (event: SpeechRecognitionEvent) => void;
  onend: () => void;
  onerror: (event: unknown) => void;
  start: () => void;
  stop: () => void;
}

// Module-level draft cache — survives component unmount (panel close/reopen)
const _draftCache = new Map<string, string>();
const DRAFT_STORAGE_PREFIX = 'agentis.chatDraft';
const LEGACY_DRAFT_STORAGE_PREFIX = 'agentis.chatDraft.v2';
export const LARGE_PASTE_FILE_THRESHOLD = 16_000;
export const MAX_INLINE_COMPOSER_CHARS = 28_000;
const MAX_COMPOSER_ATTACHMENTS = 10;

function persistedDraftKey(key: string): string {
  return `${DRAFT_STORAGE_PREFIX}:${workspace.get() ?? 'workspace'}:${key}`;
}

function legacyPersistedDraftKey(key: string): string {
  return `${LEGACY_DRAFT_STORAGE_PREFIX}:${workspace.get() ?? 'workspace'}:${key}`;
}

function readDraft(key: string): string | undefined {
  const cached = _draftCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const stored = localStorage.getItem(persistedDraftKey(key))
      ?? localStorage.getItem(legacyPersistedDraftKey(key));
    return stored ?? undefined;
  } catch {
    return undefined;
  }
}

function writeDraft(key: string, value: string): void {
  _draftCache.set(key, value);
  try {
    if (value) localStorage.setItem(persistedDraftKey(key), value);
    else localStorage.removeItem(persistedDraftKey(key));
    localStorage.removeItem(legacyPersistedDraftKey(key));
  } catch {  }
}

export function clearDraft(key: string): void {
  _draftCache.delete(key);
  try {
    localStorage.removeItem(persistedDraftKey(key));
    localStorage.removeItem(legacyPersistedDraftKey(key));
  } catch { /* ignore */ }
}

interface Props {
  onSend: (text: string, options?: { useViewportContext?: boolean; attachments?: SendAttachment[] }) => Promise<void> | void;
  onPermissionModeChange?: (mode: 'ask' | 'plan' | 'auto') => Promise<void> | void;
  awareness?: {
    label: string;
    active: boolean;
  };
  initialText?: string;
  placeholder?: string;
  footer?: React.ReactNode;
  draftKey?: string;
  agentId?: string;
  isRunning?: boolean;
  onStop?: () => void;
}

interface Suggestion {
  id: string;
  label: string;
  detail?: string;
  /** Token to insert when accepted (without the trigger char) */
  insert: string;
}

interface SlashCommand {
  cmd: string;
  blurb: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: 'plan', blurb: 'Build an editable plan canvas before creating anything' },
  { cmd: 'act', blurb: 'Leave Plan mode and return to normal chat tools' },
  { cmd: 'run', blurb: 'Run a workflow now (/run [workflow])' },
  { cmd: 'pause', blurb: 'Pause an agent (/pause @agent)' },
  { cmd: 'wake', blurb: 'Wake a paused agent (/wake @agent)' },
  { cmd: 'approve', blurb: 'Approve the most recent pending checkpoint' },
  { cmd: 'history', blurb: 'Open the unified history page' },
  { cmd: 'status', blurb: 'Show fleet status snapshot' },
  { cmd: 'help', blurb: 'List available commands' },
];

const TRIGGERS = ['/', '@', '#'] as const;
type Trigger = (typeof TRIGGERS)[number];

interface Attachment {
  id: string;
  name: string;
  type: string;
  url?: string;
  loading: boolean;
  /** Set once the upload to `/v1/artifacts/upload` succeeds — this is what gets sent with the message. */
  artifactId?: string;
  error?: boolean;
  errorMessage?: string;
  file?: File;
  generatedFromPaste?: boolean;
}

/** A file attachment that finished uploading and is ready to send with a message. */
export interface SendAttachment {
  id: string;
  name: string;
}

export function Composer({ onSend, onPermissionModeChange, awareness, initialText, placeholder, footer, draftKey, agentId, isRunning = false, onStop }: Props) {
  const [isFocused, setIsFocused] = useState(false);
  const [text, setText] = useState<string>(() => {
    if (draftKey) {
      const cached = readDraft(draftKey);
      if (cached !== undefined) return cached;
    }
    return initialText ?? '';
  });
  const [active, setActive] = useState<{ trigger: Trigger; query: string } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [useViewportContext, setUseViewportContext] = useState(true);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [modelTranscriptionAvailable, setModelTranscriptionAvailable] = useState(false);
  const lastSent = useRef<string>('');
  const speechBaseRef = useRef('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // File Attachment State
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [autoConverting, setAutoConverting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback((files: FileList | readonly File[], options: { generatedFromPaste?: boolean } = {}) => {
    const incoming = Array.from(files);
    const available = Math.max(0, MAX_COMPOSER_ATTACHMENTS - attachments.length);
    if (incoming.length > available) {
      setAttachmentNotice(`You can attach up to ${MAX_COMPOSER_ATTACHMENTS} files to one message.`);
    }
    const pairs = incoming.slice(0, available).map((file) => {
      const id = `att-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const isImage = file.type.startsWith('image/');
      const url = isImage ? URL.createObjectURL(file) : undefined;
      const attachment: Attachment = {
        id,
        name: file.name,
        type: file.type || 'application/octet-stream',
        url,
        loading: true,
        file,
        generatedFromPaste: options.generatedFromPaste,
      };
      return { file, attachment };
    });

    if (pairs.length === 0) return;

    setAttachments((prev) => [...prev, ...pairs.map((p) => p.attachment)]);
    if (options.generatedFromPaste) {
      const chars = pairs[0]?.file.size ?? 0;
      setAttachmentNotice(`Large paste preserved as a text file (${chars.toLocaleString()} bytes) so it can be uploaded and analyzed safely.`);
    }

    pairs.forEach(({ file, attachment }) => {
      uploadComposerFile(file)
        .then((artifactId) => {
          setAttachments((prev) =>
            prev.map((att) =>
              att.id === attachment.id ? { ...att, loading: false, artifactId, error: false, errorMessage: undefined } : att,
            ),
          );
        })
        .catch((error) => {
          setAttachments((prev) =>
            prev.map((att) => (att.id === attachment.id
              ? { ...att, loading: false, error: true, errorMessage: apiErrorMessage(error) }
              : att)),
          );
          setAttachmentNotice(`Could not upload ${file.name}. The content is still here—retry or remove it.`);
        });
    });
  }, [attachments.length]);

  const retryAttachment = useCallback((attachment: Attachment) => {
    if (!attachment.file) return;
    setAttachments((prev) => prev.map((item) => item.id === attachment.id
      ? { ...item, loading: true, error: false, errorMessage: undefined }
      : item));
    uploadComposerFile(attachment.file)
      .then((artifactId) => {
        setAttachments((prev) => prev.map((item) => item.id === attachment.id
          ? { ...item, loading: false, artifactId, error: false, errorMessage: undefined }
          : item));
        setAttachmentNotice(`${attachment.name} is ready for analysis.`);
      })
      .catch((error) => {
        setAttachments((prev) => prev.map((item) => item.id === attachment.id
          ? { ...item, loading: false, error: true, errorMessage: apiErrorMessage(error) }
          : item));
      });
  }, []);

  const convertPastedText = useCallback((pastedText: string) => {
    const file = new File([pastedText], pastedTextFileName(), { type: 'text/plain;charset=utf-8' });
    handleFiles([file], { generatedFromPaste: true });
  }, [handleFiles]);

  const triggerFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  }, [handleFiles]);

  const speechSupported =
    typeof window !== 'undefined' &&
    (
      'SpeechRecognition' in window
      || 'webkitSpeechRecognition' in window
      || (typeof MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia))
    );

  const hasComposedInput = text.trim().length > 0 || attachments.length > 0;
  const hasBlockingAttachment = attachments.some((attachment) => attachment.loading || attachment.error);

  useEffect(() => {
    void api<{ available: boolean }>('/v1/transcription/status')
      .then(({ available }) => setModelTranscriptionAvailable(available))
      .catch(() => setModelTranscriptionAvailable(false));
  }, []);

  const toggleRecording = useCallback(async () => {
    if (recording) {
      recognitionRef.current?.stop();
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      setRecording(false);
      return;
    }
    speechBaseRef.current = text;
    audioChunksRef.current = [];
    setRecording(true);

    if (!recognitionRef.current) {
      const SR =
        (window as any).SpeechRecognition ??
        (window as any).webkitSpeechRecognition;
      if (SR) {
        const recognition = new SR();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-US';
        recognition.onresult = (event: SpeechRecognitionEvent) => {
          const segments: Array<{ text: string; final: boolean }> = [];
          // Rebuild the whole recognition session instead of appending only the
          // changed range. Browsers can revise earlier chunks, and appending those
          // revisions is what produced repeated phrases in the composer.
          for (let i = 0; i < event.results.length; i++) {
            const item = event.results[i];
            if (item && item[0]) {
              segments.push({ text: item[0].transcript, final: item.isFinal });
            }
          }
          const transcript = formatRecognitionSegments(segments);
          if (!transcript) return;
          const base = speechBaseRef.current.trimEnd();
          const sep = base && !base.endsWith(' ') ? ' ' : '';
          setText(`${base}${sep}${transcript}`);
        };
        recognition.onend = () => {
          if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') setRecording(false);
        };
        recognitionRef.current = recognition;
      }
    }
    try {
      recognitionRef.current?.start();
    } catch {
      // Recognition can reject a second start while its prior session closes.
    }

    if (!modelTranscriptionAvailable || typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      const preferredType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
        .find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = preferredType ? new MediaRecorder(stream, { mimeType: preferredType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const mimeType = recorder.mimeType || 'audio/webm';
        const audio = new Blob(audioChunksRef.current, { type: mimeType });
        audioChunksRef.current = [];
        mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
        setRecording(false);
        if (audio.size === 0) return;

        setTranscribing(true);
        const form = new FormData();
        const extension = mimeType.includes('ogg') ? 'ogg' : 'webm';
        form.set('file', new File([audio], `dictation.${extension}`, { type: mimeType }));
        void api<{ transcript: string }>('/v1/transcription', { method: 'POST', body: form })
          .then(({ transcript }) => {
            const base = speechBaseRef.current.trimEnd();
            const sep = base && !base.endsWith(' ') ? ' ' : '';
            setText(`${base}${sep}${transcript.trim()}`);
          })
          .catch(() => {
            // Keep the immediate browser transcript if the provider rejects the audio.
          })
          .finally(() => setTranscribing(false));
      };
      recorder.start();
    } catch {
      // Permission denial or an unavailable recorder still leaves browser
      // recognition active as the fallback.
      if (!recognitionRef.current) setRecording(false);
    }
  }, [modelTranscriptionAvailable, recording, text]);

  useEffect(() => () => {
    recognitionRef.current?.stop();
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const adjustHeight = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [text, adjustHeight]);

  // Suggestion sources — agents for @, workflows/runs for #, slash for /.
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [workflows, setWorkflows] = useState<Array<{ id: string; title: string }>>([]);

  useEffect(() => {
    void api<{ agents: Array<{ id: string; name: string }> }>('/v1/agents')
      .then((r) => setAgents(r.agents))
      .catch(() => {});
    void api<{ workflows: Array<{ id: string; title: string }> }>('/v1/workflows')
      .then((r) => setWorkflows(r.workflows))
      .catch(() => {});
  }, []);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!active) return [];
    const q = active.query.toLowerCase();
    if (active.trigger === '/') {
      return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(q)).map((c) => ({
        id: c.cmd,
        label: `/${c.cmd}`,
        detail: c.blurb,
        insert: c.cmd,
      }));
    }
    if (active.trigger === '@') {
      return agents
        .filter((a) => a.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((a) => ({ id: a.id, label: `@${a.name}`, insert: a.name.replace(/\s+/g, '_') }));
    }
    if (active.trigger === '#') {
      return workflows
        .filter((w) => w.title.toLowerCase().includes(q))
        .slice(0, 8)
        .map((w) => ({
          id: w.id,
          label: `#${w.title}`,
          detail: 'workflow',
          insert: w.title.replace(/\s+/g, '_'),
        }));
    }
    return [];
  }, [active, agents, workflows]);

  useEffect(() => {
    setHighlight(0);
  }, [active?.query]);

  useEffect(() => {
    setText(initialText ?? '');
    setActive(null);
    setHighlight(0);
  }, [initialText]);

  function detectTrigger(value: string, caret: number): { trigger: Trigger; query: string } | null {
    // Walk backwards from caret to find the nearest trigger char that is
    // either at start-of-line or preceded by whitespace.
    for (let i = caret - 1; i >= 0; i--) {
      const ch = value[i];
      if (ch === undefined) return null;
      if (ch === ' ' || ch === '\n') return null;
      if ((TRIGGERS as readonly string[]).includes(ch)) {
        const before = i === 0 ? '' : value[i - 1] ?? '';
        if (i === 0 || before === ' ' || before === '\n') {
          return { trigger: ch as Trigger, query: value.slice(i + 1, caret) };
        }
        return null;
      }
    }
    return null;
  }

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    setText(v);
    if (draftKey) writeDraft(draftKey, v);
    const caret = e.target.selectionStart ?? v.length;
    setActive(detectTrigger(v, caret));
    adjustHeight();
  }

  function acceptSuggestion(s: Suggestion) {
    if (!active || !taRef.current) return;
    const ta = taRef.current;
    const caret = ta.selectionStart ?? text.length;
    // Find the trigger position again so we replace just that token.
    const before = text.slice(0, caret);
    const tokenStart = before.lastIndexOf(active.trigger);
    if (tokenStart < 0) return;
    const next = `${text.slice(0, tokenStart + 1)}${s.insert} ${text.slice(caret)}`;
    setText(next);
    if (draftKey) writeDraft(draftKey, next);
    setActive(null);
    if (active.trigger === '/' && onPermissionModeChange) {
      const mode = s.insert === 'plan'
        ? 'plan'
        : s.insert === 'auto'
          ? 'auto'
          : s.insert === 'act'
            ? 'ask'
            : null;
      if (mode) void onPermissionModeChange(mode);
    }
    requestAnimationFrame(() => {
      ta.focus();
      const pos = tokenStart + 1 + s.insert.length + 1;
      ta.setSelectionRange(pos, pos);
    });
  }

  async function dispatchSlash(cmd: string, raw: string) {
    window.dispatchEvent(
      new CustomEvent('agentis:slash-command', { detail: { cmd, raw } }),
    );
  }

  async function send() {
    // ChatGPT/Gemini-style queue-then-auto-continue: while a turn is running,
    // sending is NOT a no-op — the caller (ThreadView.handleSend) durably
    // queues the message and auto-dispatches it once the current turn ends.
    if (transcribing) return;
    const value = text.trim();
    if (!value && attachments.length === 0) return;
    if (hasBlockingAttachment) {
      setAttachmentNotice(attachments.some((attachment) => attachment.error)
        ? 'Retry or remove failed files before sending. Your content has not been discarded.'
        : 'Wait for the file upload to finish before sending.');
      return;
    }
    const uploaded = attachments.filter((att) => att.artifactId).map((attachment) => ({
      id: attachment.artifactId!,
      name: attachment.name,
    }));
    if (!value && uploaded.length === 0) return; // every upload failed and there's no text — nothing to send
    let outgoingText = value;
    if (value.length > MAX_INLINE_COMPOSER_CHARS) {
      if (uploaded.length >= MAX_COMPOSER_ATTACHMENTS) {
        setAttachmentNotice('This message is too large to send inline and all attachment slots are already used. Remove one file so Agentis can attach the text safely.');
        return;
      }
      setAutoConverting(true);
      const generatedName = pastedTextFileName();
      try {
        const artifactId = await uploadComposerFile(new File([value], generatedName, { type: 'text/plain;charset=utf-8' }));
        uploaded.push({ id: artifactId, name: generatedName });
        outgoingText = `Treat the attached file “${generatedName}” as the operator's request. It was preserved automatically because it was too large for an inline message.`;
      } catch (error) {
        setAttachmentNotice(`The large message could not be converted to a file: ${apiErrorMessage(error)}. The original text is still in the composer.`);
        setAutoConverting(false);
        return;
      }
      setAutoConverting(false);
    }
    if (value.startsWith('/')) {
      const m = value.match(/^\/(\w+)\s*(.*)$/);
      if (m && m[1]) {
        await dispatchSlash(m[1].toLowerCase(), m[2] ?? '');
      }
    }
    lastSent.current = value;
    const previousAttachments = attachments;
    setText('');
    setAttachments([]);
    setAttachmentNotice(null);
    if (draftKey) clearDraft(draftKey);
    try {
      await onSend(outgoingText, {
        useViewportContext,
        attachments: uploaded,
      });
      setUseViewportContext(true);
      for (const attachment of attachments) {
        if (attachment.url) URL.revokeObjectURL(attachment.url);
      }
    } catch (error) {
      setText(value);
      setAttachments(previousAttachments);
      if (draftKey) writeDraft(draftKey, value);
      throw error;
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && !text && lastSent.current) {
      e.preventDefault();
      setText(lastSent.current);
      if (draftKey) writeDraft(draftKey, lastSent.current);
      requestAnimationFrame(adjustHeight);
      return;
    }
    if (active && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, suggestions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const pick = suggestions[highlight];
        if (pick) acceptSuggestion(pick);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setActive(null);
        return;
      }
    }
    if (e.key === 'Escape' && !active) {
      e.preventDefault();
      taRef.current?.blur();
      return;
    }
    if (e.key === 'ArrowUp' && !text && lastSent.current) {
      e.preventDefault();
      setText(lastSent.current);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void send();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={clsx(
        "relative min-w-0 shrink-0 overflow-visible px-3 pb-3 pt-2",
        "bg-surface/98",
        dragOver && "border-accent/40 bg-accent/5 ring-1 ring-accent/20"
      )}
    >
      {active && suggestions.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 z-50 mx-auto mb-2 max-h-60 w-[calc(100%-1.5rem)] max-w-[920px] overflow-y-auto rounded-lg border border-line bg-canvas shadow-modal">
          <ul className="p-1.5 space-y-0.5">
            {suggestions.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => acceptSuggestion(s)}
                  className={clsx(
                    "flex w-full min-w-0 items-center justify-between gap-3 px-3 py-1.5 text-left text-xs rounded-lg transition-colors duration-150",
                    i === highlight
                      ? 'bg-accent/10 text-accent font-medium'
                      : 'text-text-secondary hover:bg-surface-3/50 hover:text-text-primary'
                  )}
                >
                  <span className="min-w-0 truncate font-mono">{s.label}</span>
                  <div className="flex min-w-0 items-center gap-2">
                    {s.detail && <span className="truncate text-[10px] text-text-muted font-normal">{s.detail}</span>}
                    {i === highlight && (
                      <kbd className="hidden sm:inline-flex min-h-[16px] items-center justify-center rounded bg-surface px-1 font-mono text-[9px] text-text-muted">
                        Enter
                      </kbd>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {awareness?.active && useViewportContext && (
        <div className="mx-auto mb-3 flex max-w-[920px] min-w-0 items-center gap-1.5 text-[11px] text-text-muted animate-in fade-in duration-200">
          <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 truncate rounded-full border border-glass-border bg-glass-panel px-3 py-1 text-text-secondary shadow-sm font-medium">
            <Eye size={12} className="text-accent" />
            Viewing: <span className="min-w-0 truncate text-text-primary font-semibold">{awareness.label}</span>
          </span>
          <button
            type="button"
            onClick={() => setUseViewportContext(false)}
            aria-label="Clear viewport context for next message"
            className="grid h-5 w-5 place-items-center rounded-full border border-line bg-surface-2 text-text-muted hover:text-danger hover:border-danger/30 transition-colors"
          >
            <X size={10} />
          </button>
        </div>
      )}
      
      {/* File Attachment Previews */}
      {attachments.length > 0 && (
        <div className="mx-auto mb-2 flex max-w-[920px] min-w-0 flex-wrap gap-2">
          {attachments.map((att) => {
            const isImage = att.type.startsWith('image/');
            return (
              <div
                key={att.id}
                className="group relative flex min-w-0 items-center gap-2 rounded-lg border border-line bg-canvas/40 p-1.5 pr-2.5 text-xs text-text-secondary shadow-sm transition hover:border-accent/40 animate-in fade-in zoom-in-95 duration-200"
              >
                {isImage && att.url ? (
                  <img
                    src={att.url}
                    alt={att.name}
                    className="h-8 w-8 rounded object-cover"
                  />
                ) : (
                  <div className="grid h-8 w-8 place-items-center rounded bg-surface text-text-muted">
                    <FileIcon size={14} />
                  </div>
                )}
                
                <div className="flex flex-col min-w-0 max-w-[120px]">
                  <span className="truncate font-medium text-[11px] text-text-primary">
                    {att.name}
                  </span>
                  {att.loading ? (
                    <span className="text-[9px] text-text-muted">Uploading…</span>
                  ) : att.error ? (
                    <button
                      type="button"
                      onClick={() => retryAttachment(att)}
                      title={att.errorMessage}
                      className="w-fit text-[9px] font-semibold text-danger underline decoration-danger/40 underline-offset-2 hover:text-danger/80"
                    >Retry upload</button>
                  ) : (
                    <span className="text-[9px] text-accent/80">{att.generatedFromPaste ? 'Paste secured as file' : 'Ready for analysis'}</span>
                  )}
                </div>
                
                <button
                  type="button"
                  onClick={() => {
                    if (att.url) URL.revokeObjectURL(att.url);
                    setAttachments((prev) => prev.filter((a) => a.id !== att.id));
                  }}
                  aria-label={`Remove ${att.name}`}
                  className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 place-items-center rounded-full bg-surface-3 text-text-muted shadow hover:text-danger hover:scale-105 group-hover:grid"
                >
                  <X size={10} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {attachmentNotice && (
        <div role="status" className="mx-auto mb-2 flex max-w-[920px] items-start gap-2 rounded-lg border border-accent/20 bg-accent/[0.055] px-3 py-2 text-[11px] leading-relaxed text-text-secondary">
          <FileIcon size={13} className="mt-0.5 shrink-0 text-accent" />
          <span className="min-w-0 flex-1">{attachmentNotice}</span>
          <button type="button" onClick={() => setAttachmentNotice(null)} aria-label="Dismiss attachment notice" className="shrink-0 text-text-muted hover:text-text-primary"><X size={12} /></button>
        </div>
      )}

      <div className={clsx(
        'mx-auto min-w-0 max-w-[920px] overflow-hidden rounded-2xl border bg-surface-2/65 shadow-[0_16px_38px_-28px_rgba(0,0,0,0.75)] transition-colors',
        isFocused ? 'border-text-muted/45' : 'border-line/75',
      )}>
        <textarea
          ref={taRef}
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (e.clipboardData.files && e.clipboardData.files.length > 0) {
              e.preventDefault();
              handleFiles(e.clipboardData.files);
              return;
            }
            const pastedText = e.clipboardData.getData('text/plain');
            const target = e.currentTarget;
            const selectionLength = Math.max(0, (target.selectionEnd ?? text.length) - (target.selectionStart ?? text.length));
            const projectedLength = text.length - selectionLength + pastedText.length;
            if (pastedText && (pastedText.length >= LARGE_PASTE_FILE_THRESHOLD || projectedLength > MAX_INLINE_COMPOSER_CHARS)) {
              if (attachments.length < MAX_COMPOSER_ATTACHMENTS) {
                e.preventDefault();
                convertPastedText(pastedText);
              } else {
                setAttachmentNotice('The large paste was kept in the composer because all attachment slots are used. Remove one file before sending.');
              }
            }
          }}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          rows={1}
          placeholder={placeholder ?? 'Ask anything…'}
          className="block w-full resize-none border-0 bg-transparent px-4 pt-3.5 text-sm leading-6 text-text-primary outline-none placeholder:text-text-muted/75"
          style={{ minHeight: '52px', maxHeight: '180px', overflowY: 'auto' }}
        />
        <div className="flex min-h-11 min-w-0 items-center justify-between gap-2 px-2.5 pb-2 pt-1">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,audio/*,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/*,.md,.mdx,.json,.yaml,.yml,.toml,.xml,.csv,.tsv,.docx,.xlsx"
              className="hidden"
              onChange={(e) => {
                if (e.target.files) handleFiles(e.target.files);
              }}
            />
            <button
              type="button"
              onClick={triggerFileSelect}
              aria-label="Attach files"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-text-muted transition hover:bg-surface-3 hover:text-text-primary active:scale-[0.97]"
            >
              <Plus size={17} />
            </button>
            {footer}
            {text.length > 500 && (
              <span className={clsx(
                'rounded border px-1.5 py-0.5 font-mono text-[10px]',
                text.length > MAX_INLINE_COMPOSER_CHARS ? 'border-accent/30 bg-accent/10 text-accent' : 'border-line bg-surface-3 text-text-muted',
              )}>
                {text.length.toLocaleString()}{text.length > MAX_INLINE_COMPOSER_CHARS ? ' · will attach' : ''}
              </span>
            )}
          </div>

          <div className="flex min-w-0 items-center gap-1">
            {agentId && <ComposerStatusBar agentId={agentId} />}
            {speechSupported && (
              <button
                type="button"
                onClick={toggleRecording}
                aria-label={recording ? 'Stop recording' : 'Start voice dictation'}
                className={clsx(
                  "relative grid h-8 w-8 shrink-0 place-items-center rounded-lg border-0 outline-none focus:outline-none focus-visible:outline-none focus-visible:ring-0",
                  recording
                    ? "text-blue-400 animate-pulse"
                    : "text-text-muted hover:text-text-primary hover:bg-surface-3/60",
                )}
              >
                <Mic size={14} />
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                // While running with nothing typed, the button stops the
                // Send button again — pressing it queues the message instead
                // of interrupting the in-flight turn (queue-then-auto-continue).
                if (isRunning && !hasComposedInput) {
                  onStop?.();
                  return;
                }
                void send();
              }}
              disabled={transcribing || autoConverting || (isRunning && !hasComposedInput ? !onStop : (!hasComposedInput || hasBlockingAttachment))}
              aria-label={autoConverting ? 'Converting large message to file' : isRunning && !hasComposedInput ? 'Stop agent response' : isRunning ? 'Queue message' : 'Send message'}
              title={isRunning && hasComposedInput ? 'Queue this message — it will send once the current reply finishes' : undefined}
              className={clsx(
                "grid h-8 w-8 shrink-0 place-items-center rounded-full",
                transcribing || autoConverting
                  ? "bg-surface-3 text-text-muted opacity-60 cursor-wait"
                  : isRunning && !hasComposedInput
                  ? "bg-danger/12 text-danger ring-1 ring-danger/25 hover:bg-danger/18 active:scale-[0.97]"
                  : !hasComposedInput || hasBlockingAttachment
                  ? "bg-surface-3 text-text-muted opacity-40 cursor-not-allowed"
                  : "bg-accent text-canvas active:scale-[0.97]"
              )}
            >
              {transcribing || autoConverting ? <Loader2 size={13} className="animate-spin" /> : isRunning && !hasComposedInput ? <Square size={12} fill="currentColor" /> : <ArrowUp size={14} className="font-bold" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

async function uploadComposerFile(file: File): Promise<string> {
  const form = new FormData();
  form.set('file', file);
  form.set('name', file.name);
  const result = await api<{ artifact: { id: string } }>('/v1/artifacts/upload', { method: 'POST', body: form });
  return result.artifact.id;
}

function pastedTextFileName(): string {
  const stamp = new Date().toISOString().replace('T', '-').replace(/:/g, '-').slice(0, 19);
  return `Pasted text ${stamp}.txt`;
}

/** Merge browser recognition chunks while removing repeated overlap. */
function formatRecognitionSegments(segments: Array<{ text: string; final: boolean }>): string {
  const merged: Array<{ words: string[]; final: boolean }> = [];
  for (const segment of segments) {
    const words = segment.text.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
    if (words.length === 0) continue;

    const flattened = merged.flatMap((entry) => entry.words);
    const withoutLeadingFiller = /^(i|uh|um)$/i.test(words[0] ?? '') ? words.slice(1) : words;
    if (
      withoutLeadingFiller.length >= 3
      && sameWords(flattened.slice(-withoutLeadingFiller.length), withoutLeadingFiller)
    ) {
      continue;
    }

    let overlap = Math.min(flattened.length, words.length);
    while (overlap > 0 && !sameWords(flattened.slice(-overlap), words.slice(0, overlap))) {
      overlap -= 1;
    }
    const uniqueWords = words.slice(overlap);
    if (uniqueWords.length > 0) merged.push({ words: uniqueWords, final: segment.final });
  }
  return merged
    .map(({ words, final }) => {
      const phrase = words.join(' ');
      return final ? punctuateFinalSpeechPhrase(phrase) : phrase;
    })
    .join(' ');
}

function punctuateFinalSpeechPhrase(value: string): string {
  let phrase = value.trim().replace(/\s+/g, ' ');
  if (!phrase) return '';
  phrase = phrase.charAt(0).toUpperCase() + phrase.slice(1);
  phrase = phrase.replace(/^(Hey|Hello|Hi)\s+/i, '$1, ');
  const question = /^(?:(?:Hey|Hello|Hi),\s+)?(?:who|what|when|where|why|how|can|could|would|will|should|is|are|do|does|did|have|has|may|might)\b/i.test(phrase);
  return phrase.replace(/[.!?]+$/, '') + (question ? '?' : '.');
}

function sameWords(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((word, index) => word.localeCompare(right[index] ?? '', undefined, { sensitivity: 'base' }) === 0);
}



