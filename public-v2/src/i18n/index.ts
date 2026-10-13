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
 * How long the first render (or the toggle) waits for a language chunk
 * before going ahead in Spanish. The page is blank while the first render
 * waits, so this is short: a reader on a stalled connection gets Spanish
 * after a second and English the moment the chunk lands. On a working
 * connection the chunk is there well inside it — index.html starts fetching
 * it alongside the app bundle for a reader who saved that language
 * (languagePreload.ts), so the wait is normally zero and the first render
 * is never in the wrong language.
 */
export const LANGUAGE_TIMEOUT_MS = 1000;

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
      // main.tsx holds the first render until the saved language is ready,
      // so a request that stalls (rather than fails) must not leave a blank
      // page: after LANGUAGE_TIMEOUT_MS give up and render the Spanish
      // fallback. If the chunk does arrive later, it is applied then.
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        done(new Error(`language "${lng}" timed out`), null);
      }, LANGUAGE_TIMEOUT_MS);
      load().then(
        (m) => {
          clearTimeout(timer);
          if (!timedOut) return done(null, m.default);
          i18n.addResourceBundle(lng, 'translation', m.default, true, true);
          if (i18n.language === lng) void i18n.changeLanguage(lng);
        },
        (err) => {
          clearTimeout(timer);
          if (!timedOut) done(err, null);
        },
      );
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
