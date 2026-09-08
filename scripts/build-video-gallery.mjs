/**
 * Assemble the /videos/ review gallery from generate-brand-motion artifacts.
 *
 * Every run is a generation attempt; the gallery shows them side by side so a
 * human can pick. Where a scene has a graded version that is the one shown —
 * graded is what would actually ship — and the raw is kept only when nothing
 * graded exists for that attempt.
 *
 * USAGE: node scripts/build-video-gallery.mjs <downloads-dir> <out-dir>
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error('usage: build-video-gallery.mjs <downloads-dir> <out-dir>');
  process.exit(1);
}

/** Run id → the label and the one-line note shown on each card. */
const BATCH = {
  '34222341323': ['B1', 'People + kite motif (first pass)'],
  '34225004427': ['B2', 'Mexico context added, kite ending'],
  '34229962668': ['B3', 'Photographic, kite dropped'],
  '34229965806': ['B3', 'Ambient loops'],
  '34231137156': ['B4', 'Mexico hardened (raw)'],
  '34233071446': ['B4', 'Mexico hardened, graded 0.85'],
  '34233074596': ['B3', 'Ambient loops, graded 0.85'],
  '34233313875': ['B5', 'Mexico hardened, graded 0.42'],
  '34236400263': ['B6', 'Image-to-video, first casting'],
  '34242150888': ['B7', 'IMAGE-TO-VIDEO, resort casting 25-45 — shipping'],
};

function walk(dir, hit = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, hit);
    else if (e.name.endsWith('.mp4')) hit.push(p);
  }
  return hit;
}

mkdirSync(join(out, 'files'), { recursive: true });
const seen = new Set();
const all = [];
for (const p of walk(src).sort()) {
  const rel = relative(src, p).split('\\').join('/');
  const run = Object.keys(BATCH).find((r) => rel.includes(r)) ?? '?';
  const [batch, note] = BATCH[run] ?? ['?', 'unlabelled run'];
  const graded = rel.includes('/graded/');
  const bytes = readFileSync(p);
  const hash = createHash('md5').update(bytes).digest('hex').slice(0, 8);
  if (seen.has(hash)) continue; // the same film downloaded from two runs
  seen.add(hash);
  const scene = p.split('/').pop().replace(/\.mp4$/, '');
  all.push({ src: p, scene, batch, note, graded, kb: Math.round(statSync(p).size / 1024), hash });
}

// One scene per attempt: graded wins, raw only when there is no graded.
const byKey = new Map();
for (const it of all) {
  const k = `${it.batch}/${it.scene}`;
  byKey.set(k, [...(byKey.get(k) ?? []), it]);
}
const items = [];
for (const group of byKey.values()) {
  const graded = group.filter((g) => g.graded);
  for (const it of graded.length ? graded : group) {
    const file = `${it.batch}-${it.scene}${it.graded ? '' : '-raw'}-${it.hash}.mp4`;
    copyFileSync(it.src, join(out, 'files', file));
    items.push({ file, scene: it.scene, batch: it.batch, note: it.note, graded: it.graded, kb: it.kb });
  }
}
items.sort((a, b) => a.batch.localeCompare(b.batch) || a.scene.localeCompare(b.scene) || a.kb - b.kb);
writeFileSync(join(out, 'index.json'), JSON.stringify(items, null, 1));
copyFileSync('mobile/web-portal/video-gallery.html', join(out, 'index.html'));
console.log(`gallery: ${items.length} films, ${Math.round(items.reduce((n, i) => n + i.kb, 0) / 1024)} MB`);
