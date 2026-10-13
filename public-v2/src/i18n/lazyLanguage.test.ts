/**
 * Spanish (default + fallback) ships in the main bundle; English is a chunk
 * fetched on demand, so the default first load does not download it before
 * first paint. A reader who saved English still gets English on the first
 * render: main.tsx waits for `i18nReady`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import es from './es.json';
import en from './en.json';

async function loadI18n() {
  vi.resetModules();
  return import('./index');
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
});

describe('i18n — lazy languages', () => {
  it('has Spanish ready synchronously and does not bundle English up front', async () => {
    const { default: i18n, lazyLanguages } = await loadI18n();

    // No await on i18nReady: Spanish must already be usable.
    expect(i18n.language).toBe('es');
    expect(i18n.t('hero_cta_employer')).toBe(es.hero_cta_employer);
    expect(i18n.hasResourceBundle('es', 'translation')).toBe(true);
    expect(i18n.hasResourceBundle('en', 'translation')).toBe(false);
    expect(Object.keys(lazyLanguages)).toEqual(['en']);
  });

  it('the language toggle loads English, then switches in one step', async () => {
    const { default: i18n } = await loadI18n();

    await i18n.changeLanguage('en');

    expect(i18n.language).toBe('en');
    expect(i18n.hasResourceBundle('en', 'translation')).toBe(true);
    expect(i18n.t('hero_cta_employer')).toBe(en.hero_cta_employer);
    expect(en.hero_cta_employer).not.toBe(es.hero_cta_employer);
    expect(document.documentElement.lang).toBe('en');
    expect(localStorage.getItem('vida_lang')).toBe('en');
  });

  it('i18nReady resolves with the saved language loaded, so the first render is not Spanish', async () => {
    localStorage.setItem('vida_lang', 'en');
    const { default: i18n, i18nReady } = await loadI18n();

    await i18nReady;

    expect(i18n.language).toBe('en');
    expect(i18n.t('hero_cta_employer')).toBe(en.hero_cta_employer);
  });

  it('an unknown saved language falls back to Spanish without failing', async () => {
    localStorage.setItem('vida_lang', 'fr');
    const { default: i18n, i18nReady } = await loadI18n();

    await i18nReady;

    expect(i18n.t('hero_cta_employer')).toBe(es.hero_cta_employer);
  });

  it('a stalled language chunk does not hold the first render: Spanish after the timeout, English when it arrives', async () => {
    localStorage.setItem('vida_lang', 'en');
    vi.useFakeTimers();
    try {
      // The English chunk request hangs: neither resolves nor rejects.
      let arrive!: () => void;
      vi.doMock('./en.json', () => new Promise((r) => { arrive = () => r({ default: en }); }));
      const { default: i18n, i18nReady, LANGUAGE_TIMEOUT_MS } = await loadI18n();

      let settled = false;
      void i18nReady.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(LANGUAGE_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(settled).toBe(true);
      expect(i18n.t('hero_cta_employer')).toBe(es.hero_cta_employer);

      arrive();
      await vi.advanceTimersByTimeAsync(0);
      expect(i18n.t('hero_cta_employer')).toBe(en.hero_cta_employer);
    } finally {
      vi.doUnmock('./en.json');
      vi.useRealTimers();
    }
  });
});
