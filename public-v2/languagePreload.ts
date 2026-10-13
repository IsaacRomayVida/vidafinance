/**
 * Starts fetching a saved non-default language from index.html (used by
 * vite.config.ts; its own file so a test can call it).
 *
 * English is a lazy chunk (src/i18n/index.ts) and the first render waits for
 * it when the reader saved English. Left to the app, that request only
 * starts once the entry bundle has downloaded and run. This plugin writes a
 * small inline script into the built index.html that looks at the saved
 * language and, if it is a lazy one, adds a `modulepreload` for its chunk —
 * so it downloads next to the app bundle and is already there when i18n
 * asks for it. A Spanish reader (the default) gets no extra request.
 */
import type { Plugin } from 'vite';

/** Where src/i18n/index.ts keeps the reader's language. */
export const LANGUAGE_STORAGE_KEY = 'vida_lang';

/** The inline script: `chunks` maps a language to its built chunk URL. */
export function languagePreloadScript(chunks: Record<string, string>): string {
  return (
    '(function(){try{' +
    `var c=${JSON.stringify(chunks)},l=localStorage.getItem(${JSON.stringify(LANGUAGE_STORAGE_KEY)});` +
    'if(!l||!Object.prototype.hasOwnProperty.call(c,l))return;' +
    "var k=document.createElement('link');k.rel='modulepreload';k.href=c[l];document.head.appendChild(k);" +
    '}catch(e){}})();'
  );
}

interface BundleEntry {
  type: string;
  fileName: string;
  facadeModuleId?: string | null;
}

/** language -> chunk URL, for every `src/i18n/<lang>.json` that became its own chunk. */
export function languageChunks(bundle: Record<string, BundleEntry>, base: string): Record<string, string> {
  const chunks: Record<string, string> = {};
  for (const entry of Object.values(bundle)) {
    if (entry.type !== 'chunk') continue;
    const lang = entry.facadeModuleId?.match(/\/src\/i18n\/([a-z]{2}(?:-[A-Za-z]+)?)\.json$/)?.[1];
    if (lang) chunks[lang] = base + entry.fileName;
  }
  return chunks;
}

export function languagePreload(): Plugin {
  let base = '/';
  return {
    name: 'funpay-language-preload',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const chunks = languageChunks((ctx.bundle ?? {}) as Record<string, BundleEntry>, base);
        if (Object.keys(chunks).length === 0) return [];
        return [{ tag: 'script', children: languagePreloadScript(chunks), injectTo: 'head' }];
      },
    },
  };
}
