import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { initI18n } from './i18n';
import './styles.css';

// The service worker caches only the versioned dashboard bundle. API calls are
// deliberately never cached: an installed console must not show stale runs,
// approvals, credentials, or workspace state when it comes back online.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' });
  });
}

const root = createRoot(document.getElementById('root')!);
void initI18n.finally(() => {
  root.render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
});
