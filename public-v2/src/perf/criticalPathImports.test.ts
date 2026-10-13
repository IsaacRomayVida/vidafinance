/**
 * What the entry bundle may pull in. Everything reachable from main.tsx
 * through *static* imports is downloaded and parsed before a marketing page
 * can paint; `import()` and React.lazy boundaries are where that stops.
 *
 * This walks the static import graph from the entry and fails if a heavy
 * library the landing pages do not need is on it again — the way Firebase
 * (via a global AuthProvider), the animation library (via PageTransition),
 * react-helmet-async (via a root HelmetProvider) and the English copy (via
 * i18n/index.ts) all once were.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '..');

const STATIC_IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

function resolveLocal(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? join(SRC, spec.slice(2)) : resolve(dirname(from), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

/** Bare package specifiers and local files statically reachable from `entry`. */
function staticGraph(entry: string) {
  const files = new Set<string>();
  const packages = new Map<string, string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    if (!/\.tsx?$/.test(file)) continue;
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) {
      if (spec.startsWith('.') || spec.startsWith('@/')) {
        const target = resolveLocal(file, spec);
        if (!target) throw new Error(`cannot resolve '${spec}' from ${file}`);
        queue.push(target);
      } else if (!packages.has(spec)) {
        packages.set(spec, file.slice(SRC.length + 1));
      }
    }
  }
  return { files: [...files].map((f) => f.slice(SRC.length + 1)), packages };
}

const graph = staticGraph(join(SRC, 'main.tsx'));

describe('entry bundle — static import graph from main.tsx', () => {
  it('reaches the four landing pages (they are not lazy) and stops before the portals', () => {
    for (const page of ['pages/HomePage.tsx', 'pages/EmployerPage.tsx', 'pages/EmployeePage.tsx', 'pages/AboutPage.tsx']) {
      expect(graph.files).toContain(page);
    }
    for (const lazy of ['hooks/useAuth.ts', 'lib/firebase.ts', 'components/RouteGuard.tsx', 'pages/Login.tsx', 'pages/ComingSoon.tsx']) {
      expect(graph.files).not.toContain(lazy);
    }
  });

  it.each([
    ['Firebase', /^(firebase|@firebase)(\/|$)/],
    ['the animation library', /^(motion|framer-motion)(\/|$)/],
    ['react-helmet-async', /^react-helmet-async$/],
    ['papaparse', /^papaparse$/],
  ])('does not include %s', (_name, pattern) => {
    const offenders = [...graph.packages].filter(([spec]) => pattern.test(spec)).map(([spec, file]) => `${spec} (via ${file})`);
    expect(offenders).toEqual([]);
  });

  it('bundles Spanish only: other languages are separate chunks', () => {
    expect(graph.files).toContain('i18n/es.json');
    expect(graph.files.filter((f) => /^i18n\/.+\.json$/.test(f))).toEqual(['i18n/es.json']);
  });

  it('waits for the saved language before the first render', () => {
    const main = readFileSync(join(SRC, 'main.tsx'), 'utf8');
    expect(main).toMatch(/i18nReady\s*\.then\(\s*\(\)\s*=>\s*\{\s*createRoot\(/);
  });
});
