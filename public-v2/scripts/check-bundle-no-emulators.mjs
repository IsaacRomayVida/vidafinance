#!/usr/bin/env node
/**
 * Fails when a built bundle contains the local-emulator wiring.
 *
 * src/lib/firebaseEmulators.ts must never ship: it is reachable only behind
 * `import.meta.env.DEV`, which a production build turns into dead code. This
 * script is the proof, run at the end of every `npm run build` (and so by CI
 * and by the deploy): it reads every text file under dist/ and exits 1 if any
 * of the strings that only that module contains is present.
 *
 *   node scripts/check-bundle-no-emulators.mjs [dist-dir]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Strings that exist in the app only because of the emulator wiring. Each one
 * is written out in src/lib/firebaseEmulators.ts; firebaseEmulators.test.ts
 * fails if a marker here stops matching that source, so the list cannot go
 * stale and pass by checking for nothing.
 */
export const EMULATOR_MARKERS = Object.freeze([
  'demo-funpay-local',
  'demo-api-key-emulator-only',
  'demo-app-id-emulator-only',
  'emulator-only-app-check',
  'EMULATOR MODE',
  'VITE_USE_FIREBASE_EMULATORS',
  'VITE_FIREBASE_EMULATOR_PROJECT',
  '127.0.0.1',
]);

const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.html', '.css', '.json', '.map', '.txt', '.xml', '.webmanifest']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

/**
 * @param {string} distDir
 * @returns {{ filesScanned: number, hits: { file: string, marker: string }[] }}
 */
export function findEmulatorMarkers(distDir) {
  const hits = [];
  let filesScanned = 0;
  for (const file of walk(distDir)) {
    if (!TEXT_EXTENSIONS.has(extname(file))) continue;
    filesScanned += 1;
    const text = readFileSync(file, 'utf8');
    for (const marker of EMULATOR_MARKERS) {
      if (text.includes(marker)) hits.push({ file: relative(distDir, file), marker });
    }
  }
  return { filesScanned, hits };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const distDir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
  let result;
  try {
    result = findEmulatorMarkers(distDir);
  } catch (err) {
    console.error(`check-bundle-no-emulators: cannot read ${distDir}: ${err.message}`);
    process.exit(1);
  }
  if (result.filesScanned === 0) {
    console.error(`check-bundle-no-emulators: no bundle files under ${distDir} — nothing was checked.`);
    process.exit(1);
  }
  if (result.hits.length > 0) {
    console.error('check-bundle-no-emulators: the bundle contains local-emulator wiring. It must not ship.');
    for (const hit of result.hits) console.error(`  ${hit.file}: "${hit.marker}"`);
    console.error('Every use of src/lib/firebaseEmulators.ts must sit behind a literal `import.meta.env.DEV`.');
    process.exit(1);
  }
  console.log(`check-bundle-no-emulators: OK — ${result.filesScanned} files, no emulator wiring in the bundle.`);
}
