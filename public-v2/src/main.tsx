import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initSentry } from './lib/sentry';
import { i18nReady } from './i18n';
import './styles/legacy.css';
import './styles/index.css';

initSentry();

// Spanish is bundled, so this is already settled for the default language;
// a saved non-default language is fetched first (see i18n/index.ts).
i18nReady.then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
});
