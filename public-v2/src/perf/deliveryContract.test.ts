/**
 * Delivery contract for the marketing pages (Lighthouse performance >= 0.9,
 * enforced in CI by lighthouserc.json). These are the build-independent
 * parts of it: what index.html asks the browser to fetch first, and that
 * every file it or the landing pages point at really exists in public/.
 *
 * Reads the sources from disk on purpose: index.html is not a module, and
 * the hero stills are plain string constants in the page components.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const PUBLIC = join(ROOT, 'public');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const html = read('index.html');

/** The inline hero-preload script, with Vite's %ENV% placeholders filled in. */
function runHeroPreload(pathname: string, phone: boolean, mode = 'live', base = '/') {
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .find((code) => code.includes('hero-dawn'));
  if (!script) throw new Error('index.html has no hero preload script');
  const code = script.split('%VITE_LAUNCH_MODE%').join(mode).split('%BASE_URL%').join(base);
  const appended: Array<Record<string, unknown>> = [];
  const fakeDocument = {
    createElement: () => ({}),
    head: { appendChild: (el: Record<string, unknown>) => appended.push(el) },
  };
  const matchMedia = (q: string) => ({ matches: q === '(max-width: 860px)' ? phone : false });
  new Function('location', 'matchMedia', 'document', code)({ pathname }, matchMedia, fakeDocument);
  return appended;
}

/** `still: '/images/…'` constants of a component, in source order (wide, tall). */
function stills(rel: string): string[] {
  return [...read(rel).matchAll(/still:\s*'([^']+)'/g)].map((m) => m[1]);
}

const HERO_PAGES: Array<[path: string, source: string]> = [
  ['/', 'src/components/marketing/HeroSection.tsx'],
  ['/employers', 'src/pages/EmployerPage.tsx'],
  ['/employees', 'src/pages/EmployeePage.tsx'],
];

describe('index.html — hero poster preload', () => {
  it.each(HERO_PAGES)('%s preloads the exact still its hero renders, per screen shape', (path, source) => {
    const [wide, tall] = stills(source);
    expect(wide).toMatch(/-16x9\.webp$/);
    expect(tall).toMatch(/-9x16\.webp$/);

    for (const [phone, still] of [[false, wide], [true, tall]] as const) {
      const [link, ...rest] = runHeroPreload(path, phone);
      expect(rest).toEqual([]);
      expect(link).toMatchObject({ rel: 'preload', as: 'image', fetchPriority: 'high', href: still });
      expect(existsSync(join(PUBLIC, still))).toBe(true);
    }
  });

  it('follows the build base path and tolerates a trailing slash', () => {
    const [, tall] = stills('src/pages/EmployerPage.tsx');
    expect(runHeroPreload('/funpay/web/employers/', true, 'live', '/funpay/web/')[0].href).toBe(`/funpay/web${tall}`);
  });

  it('preloads nothing on pages without a photo hero', () => {
    for (const path of ['/about', '/login', '/employee', '/constructor', '/toString']) {
      expect(runHeroPreload(path, true)).toEqual([]);
    }
  });

  it('preloads nothing in the coming-soon build, whose landing has no such hero', () => {
    expect(runHeroPreload('/', true, 'coming-soon')).toEqual([]);
    // Vite leaves the placeholder untouched when the variable is unset.
    expect(runHeroPreload('/', true, '%VITE_LAUNCH_MODE%')).toEqual([]);
  });

  it('uses the same 860px breakpoint as PhotoHero', () => {
    expect(read('src/components/marketing/PhotoHero.tsx')).toContain("useMediaQuery('(max-width: 860px)')");
    expect(html).toContain("matchMedia('(max-width: 860px)')");
  });
});

describe('index.html — fonts', () => {
  it('requests nothing from Google Fonts', () => {
    expect(html).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });

  it('declares Urbanist and Doto from files that exist in public/fonts', () => {
    const faces = [...html.matchAll(/@font-face\{([^}]*)\}/g)].map((m) => m[1]);
    const families = new Set(faces.map((f) => /font-family:'([^']+)'/.exec(f)?.[1]));
    expect(families).toEqual(new Set(['Urbanist', 'Doto']));
    for (const face of faces) {
      expect(face).toContain('font-display:swap');
      const url = /src:url\(([^)]+)\)/.exec(face)?.[1];
      expect(url).toMatch(/^\/fonts\/.+\.woff2$/);
      expect(existsSync(join(PUBLIC, url as string))).toBe(true);
    }
  });

  it('preloads the latin file of both families, as CORS font requests', () => {
    const preloads = [...html.matchAll(/<link rel="preload" as="font"[^>]*>/g)].map((m) => m[0]);
    expect(preloads.map((l) => /href="([^"]+)"/.exec(l)?.[1]).sort()).toEqual([
      '/fonts/doto-latin-wght-normal.woff2',
      '/fonts/urbanist-latin-wght-normal.woff2',
    ]);
    for (const link of preloads) {
      // Without crossorigin the preload is fetched twice (fonts are always CORS).
      expect(link).toContain('crossorigin');
      expect(link).toContain('type="font/woff2"');
    }
  });
});

describe('landing-page photographs', () => {
  const SOURCES = [
    'src/components/marketing/HeroSection.tsx',
    'src/components/marketing/TrustSection.tsx',
    'src/pages/EmployerPage.tsx',
    'src/pages/EmployeePage.tsx',
  ];

  it('are WebP files that exist and stay under 200 KB each', () => {
    const refs = SOURCES.flatMap((rel) => [...read(rel).matchAll(/['"](\/images\/brand\/[^'"]+)['"]/g)].map((m) => m[1]));
    const stage = /url\('(\/images\/brand\/stage-employer\.[a-z]+)'\)/.exec(read('src/styles/marketing.css'))?.[1];
    expect(refs.length).toBeGreaterThanOrEqual(8);
    for (const ref of [...refs, stage as string]) {
      expect(ref).toMatch(/\.webp$/);
      expect(existsSync(join(PUBLIC, ref))).toBe(true);
      expect(statSync(join(PUBLIC, ref)).size).toBeLessThan(200_000);
    }
  });
});
