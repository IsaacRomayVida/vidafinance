/**
 * A reader who saved English waits for the English chunk before the first
 * render (src/i18n/index.ts). The built index.html starts that download
 * itself, next to the app bundle, so the wait is normally zero — and a
 * Spanish reader, the default, is not charged a request for it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LANGUAGE_STORAGE_KEY, languageChunks, languagePreload, languagePreloadScript } from '../../languagePreload';
import { lazyLanguages } from '../i18n';

const ROOT = resolve(__dirname, '..', '..');

/** Runs the inline script against a fake page; returns the links it added. */
function run(script: string, saved: string | null | Error) {
  const appended: Array<Record<string, unknown>> = [];
  const localStorage = {
    getItem: (key: string) => {
      if (saved instanceof Error) throw saved;
      return key === LANGUAGE_STORAGE_KEY ? saved : null;
    },
  };
  const document = {
    createElement: (tag: string) => ({ tag }),
    head: { appendChild: (el: Record<string, unknown>) => appended.push(el) },
  };
  new Function('localStorage', 'document', script)(localStorage, document);
  return appended;
}

const bundle = {
  'assets/index-aaa.js': { type: 'chunk', fileName: 'assets/index-aaa.js', facadeModuleId: '/repo/public-v2/index.html' },
  'assets/en-bbb.js': { type: 'chunk', fileName: 'assets/en-bbb.js', facadeModuleId: '/repo/public-v2/src/i18n/en.json' },
  'assets/About-ccc.js': { type: 'chunk', fileName: 'assets/About-ccc.js', facadeModuleId: '/repo/public-v2/src/pages/About.tsx' },
  'assets/index-ddd.css': { type: 'asset', fileName: 'assets/index-ddd.css' },
  'assets/shared-eee.js': { type: 'chunk', fileName: 'assets/shared-eee.js', facadeModuleId: null },
};

describe('language chunk preload', () => {
  it('finds the chunk of every lazy language, under the build base path', () => {
    expect(languageChunks(bundle, '/')).toEqual({ en: '/assets/en-bbb.js' });
    expect(languageChunks(bundle, '/funpay/web/')).toEqual({ en: '/funpay/web/assets/en-bbb.js' });
    // The languages the build is expected to find are the lazy ones.
    expect(Object.keys(languageChunks(bundle, '/'))).toEqual(Object.keys(lazyLanguages));
  });

  it('preloads the saved language as a module, so the app import reuses it', () => {
    const script = languagePreloadScript({ en: '/assets/en-bbb.js' });
    expect(run(script, 'en')).toEqual([{ tag: 'link', rel: 'modulepreload', href: '/assets/en-bbb.js' }]);
  });

  it('requests nothing for the default language, an unknown one, or a first visit', () => {
    const script = languagePreloadScript({ en: '/assets/en-bbb.js' });
    for (const saved of ['es', 'fr', '', null, 'constructor', 'toString']) {
      expect(run(script, saved), String(saved)).toEqual([]);
    }
  });

  it('survives a browser that refuses storage access', () => {
    const script = languagePreloadScript({ en: '/assets/en-bbb.js' });
    expect(() => run(script, new Error('SecurityError'))).not.toThrow();
    expect(run(script, new Error('SecurityError'))).toEqual([]);
  });

  it('reads the key the app writes the language to', () => {
    const i18nSource = readFileSync(resolve(ROOT, 'src/i18n/index.ts'), 'utf8');
    expect(i18nSource).toContain(`safeGetItem('${LANGUAGE_STORAGE_KEY}')`);
    expect(i18nSource).toContain(`safeSetItem('${LANGUAGE_STORAGE_KEY}'`);
  });

  it('is a build plugin that writes the script into the head of index.html', () => {
    expect(readFileSync(resolve(ROOT, 'vite.config.ts'), 'utf8')).toMatch(/plugins:\s*\[[^\]]*languagePreload\(\)/);

    const plugin = languagePreload();
    expect(plugin.apply).toBe('build');
    (plugin.configResolved as (config: { base: string }) => void)({ base: '/funpay/web/' });
    const hook = plugin.transformIndexHtml as {
      order: string;
      handler: (html: string, ctx: { bundle?: unknown }) => Array<{ tag: string; children: string; injectTo: string }>;
    };
    expect(hook.order).toBe('post');

    const tags = hook.handler('<html></html>', { bundle });
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ tag: 'script', injectTo: 'head' });
    expect(run(tags[0].children, 'en')).toEqual([
      { tag: 'link', rel: 'modulepreload', href: '/funpay/web/assets/en-bbb.js' },
    ]);

    // No lazy language in the bundle (or the dev server, which has none): nothing is written.
    expect(hook.handler('<html></html>', { bundle: { 'a.js': bundle['assets/index-aaa.js'] } })).toEqual([]);
    expect(hook.handler('<html></html>', {})).toEqual([]);
  });
});
