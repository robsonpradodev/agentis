import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Native install affordance where the browser provides one. */
export function PwaInstallButton() {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setPrompt(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!prompt) return null;
  return (
    <button
      type="button"
      onClick={() => {
        void prompt.prompt().then(() => prompt.userChoice).then(() => setPrompt(null));
      }}
      className="hidden h-9 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-2.5 text-[12px] text-text-secondary transition-colors hover:bg-surface-3 hover:text-text-primary sm:inline-flex"
      aria-label="Install Agentis"
      title="Install Agentis"
    >
      <Download size={14} />
      <span>Install</span>
    </button>
  );
}
