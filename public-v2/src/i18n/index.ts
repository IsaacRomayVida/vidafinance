import i18n from 'i18next';
import type { ResourceKey } from 'i18next';
import { initReactI18next } from 'react-i18next';
import es from './es.json';
import { safeGetItem, safeSetItem } from '../lib/safeStorage';

const savedLang = safeGetItem('vida_lang') || 'es';

/**
 * Spanish is the default and the fallback, so it ships in the main bundle.
 * Every other language is its own chunk, fetched the first time it is needed
 * (a returning reader who saved it, or the language toggle): the Spanish
 * first load no longer downloads ~20 KB gzip of English copy before it can
 * paint. `changeLanguage()` waits for the chunk, so the toggle still switches
 * in one step.
 */
export const lazyLanguages: Record<string, () => Promise<{ default: ResourceKey }>> = {
  en: () => import('./en.json'),
};

/**
 * Resolves once the saved language is ready to render. main.tsx waits for it
 * before the first render, so a reader who chose English never sees a flash
 * of Spanish. For Spanish it is already settled when this module has loaded.
 */
export const i18nReady: Promise<unknown> = i18n
  .use({
    type: 'backend' as const,
    init() {},
    read(lng: string, _ns: string, done: (err: unknown, data: ResourceKey | null) => void) {
      const load = lazyLanguages[lng];
      if (!load) return done(null, {});
      load().then((m) => done(null, m.default), (err) => done(err, null));
    },
  })
  .use(initReactI18next)
  .init({
    resources: {
      es: { translation: es },
    },
    partialBundledLanguages: true,
    lng: savedLang,
    fallbackLng: 'es',
    interpolation: { escapeValue: false },
  })
  // A language chunk that fails to load must not blank the site: the
  // Spanish fallback is already in memory.
  .catch(() => undefined);

// Keep <html lang=""> in sync with the active language
document.documentElement.lang = savedLang;
i18n.on('languageChanged', (lang) => {
  document.documentElement.lang = lang;
  safeSetItem('vida_lang', lang);
});

export default i18n;
