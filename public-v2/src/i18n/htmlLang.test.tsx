/**
 * <html lang> must name the language actually on screen. English is a chunk
 * fetched on demand (lazyLanguage.test.ts); until it has loaded — and for
 * good if it stalls past the timeout or fails — the page renders the Spanish
 * fallback, so the attribute must say "es" all that time, not the language
 * that was asked for.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import es from './es.json';
import en from './en.json';

const htmlLang = () => document.documentElement.lang;

// The mocked chunk is requested through a real dynamic import, which takes
// real time even under fake timers: wait for it on the real clock.
const realSetTimeout = globalThis.setTimeout;
async function until(condition: () => boolean) {
  for (let i = 0; i < 2000 && !condition(); i++) await new Promise((r) => realSetTimeout(r, 1));
  expect(condition()).toBe(true);
}

/** Fresh i18n whose English chunk hangs until `arrive()` is called. */
async function loadWithStalledEnglish() {
  const chunk: { arrive?: () => void } = {};
  vi.doMock('./en.json', () => new Promise((r) => { chunk.arrive = () => r({ default: en }); }));
  vi.resetModules();
  const mod = await import('./index');
  return { ...mod, chunk };
}

beforeEach(() => {
  localStorage.clear();
  // index.html ships <html lang="es">.
  document.documentElement.lang = 'es';
});
afterEach(() => {
  vi.doUnmock('./en.json');
  vi.useRealTimers();
  localStorage.clear();
});

describe('<html lang> follows the rendered language', () => {
  it('a reader who saved English: "es" while the chunk is on its way and after the timeout, "en" once it renders', async () => {
    localStorage.setItem('vida_lang', 'en');
    vi.useFakeTimers();
    const { default: i18n, i18nReady, LANGUAGE_TIMEOUT_MS, chunk } = await loadWithStalledEnglish();

    expect(htmlLang()).toBe('es');
    let settled = false;
    void i18nReady.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(LANGUAGE_TIMEOUT_MS);
    expect(settled).toBe(true);

    // The first render goes ahead in the Spanish fallback.
    expect(i18n.language).toBe('en');
    expect(i18n.t('hero_cta_employer')).toBe(es.hero_cta_employer);
    expect(htmlLang()).toBe('es');

    await until(() => chunk.arrive !== undefined);
    chunk.arrive!();
    await vi.advanceTimersByTimeAsync(0);
    expect(i18n.t('hero_cta_employer')).toBe(en.hero_cta_employer);
    expect(htmlLang()).toBe('en');
  });

  it('a language chunk that fails leaves "es", the fallback that is on screen', async () => {
    vi.doMock('./en.json', () => Promise.reject(new Error('chunk failed')));
    vi.resetModules();
    const { default: i18n } = await import('./index');

    await i18n.changeLanguage('en');

    expect(i18n.t('hero_cta_employer')).toBe(es.hero_cta_employer);
    expect(htmlLang()).toBe('es');
    // The choice is still remembered for the next visit.
    expect(localStorage.getItem('vida_lang')).toBe('en');
  });

  it('an unknown saved language renders Spanish and says so', async () => {
    localStorage.setItem('vida_lang', 'fr');
    vi.resetModules();
    const { i18nReady } = await import('./index');
    await i18nReady;
    expect(htmlLang()).toBe('es');
  });

  it.each([
    ['Navbar', () => import('../components/layout/Navbar').then((m) => m.Navbar)],
    ['Footer', () => import('../components/layout/Footer').then((m) => m.Footer)],
  ])('the %s toggle changes the attribute when English is on screen, not when it is asked for', async (_name, load) => {
    const { default: i18n, chunk } = await loadWithStalledEnglish();
    const Toggle = await load();
    render(
      <MemoryRouter>
        <Toggle />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getAllByRole('button', { name: es.a11y_lang_toggle })[0]);
    await until(() => chunk.arrive !== undefined);
    // Asked for, not loaded: the page is still Spanish.
    expect(i18n.t('hero_cta_employer')).toBe(es.hero_cta_employer);
    expect(htmlLang()).toBe('es');

    await act(async () => {
      chunk.arrive!();
      await new Promise((r) => realSetTimeout(r, 0));
    });
    await until(() => i18n.t('hero_cta_employer') === en.hero_cta_employer);
    expect(htmlLang()).toBe('en');
  });

  it('only i18n/index.ts writes the attribute', () => {
    const srcDir = resolve(__dirname, '..');
    const sources = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return sources(full);
        return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
      });
    const writers = sources(srcDir).filter((file) => /documentElement\.lang\s*=/.test(readFileSync(file, 'utf8')));
    expect(writers.map((f) => f.slice(srcDir.length + 1))).toEqual([join('i18n', 'index.ts')]);
  });
});
