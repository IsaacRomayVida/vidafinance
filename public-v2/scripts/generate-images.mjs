/**
 * Build-time image generation for the Funpay marketing site.
 *
 * Regenerates every photographic asset with OpenAI gpt-image-1 in a consistent
 * editorial / cinematic teal-gold brand style, then downsizes each result to a
 * web-friendly resolution that matches the original aspect ratio (no layout shift).
 *
 * The OpenAI key is read at runtime from public-v2/.env.local (gitignored) and is
 * never printed. Generation happens here at build time so the key never ships to
 * the browser — only the resulting static PNGs are committed.
 *
 * Usage:
 *   node scripts/generate-images.mjs            # generate all
 *   node scripts/generate-images.mjs worker ana # only the named assets
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import OpenAI from 'openai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const IMG_DIR = path.join(ROOT, 'public', 'images');

function loadEnv() {
  for (const file of ['.env', '.env.local']) {
    const p = path.join(ROOT, file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
  }
}
loadEnv();

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) {
  console.error('\n[generate-images] OPENAI_API_KEY missing.');
  console.error('Add it to public-v2/.env.local (gitignored):  OPENAI_API_KEY=sk-...\n');
  process.exit(1);
}

const STYLE = [
  'Editorial cinematic photography for a premium Mexican fintech brand.',
  'Soft natural directional light, shallow depth of field, gentle film grain.',
  'Warm authentic skin tones with a refined teal-and-gold color grade',
  '(deep teal #194445 and muted gold #a28657 accents in wardrobe, light and environment).',
  'Aspirational, calm, trustworthy mood. Realistic, not stocky or cheesy.',
  'Absolutely no text, no logos, no watermarks, no UI overlays.',
].join(' ');

/** maxEdge keeps files small while staying crisp on retina at displayed sizes. */
const TARGETS = {
  worker: {
    file: 'worker.png',
    size: '1024x1536',
    background: 'transparent',
    maxEdge: 900,
    prompt:
      'Full-length portrait of a confident young Mexican blue-collar/light-manufacturing worker in their late 20s, ' +
      'wearing a clean modern uniform polo, standing relaxed and smiling warmly while holding a smartphone in one hand. ' +
      'The subject is fully isolated as a clean studio cutout on a transparent background, sharp edges, no shadow on ground.',
  },
  'worker-group': {
    file: 'worker-group.png',
    size: '1536x1024',
    background: 'opaque',
    maxEdge: 1200,
    prompt:
      'Three diverse Mexican coworkers (mixed gender, 20s-40s) in a bright modern light-industrial workplace, ' +
      'gathered casually looking at one phone together and smiling, a genuine candid moment of trust and teamwork. ' +
      'Clean uncluttered background with soft bokeh.',
  },
  workerfemale: {
    file: 'workerfemale.png',
    size: '1024x1536',
    background: 'opaque',
    maxEdge: 820,
    prompt:
      'Portrait of a Mexican woman employee in her early 30s wearing smart-casual workwear, in a bright airy modern office, ' +
      'holding a smartphone and looking toward the camera with a calm, confident, reassured expression.',
  },
  'calculator-person': {
    file: 'calculator-person.png',
    size: '1024x1536',
    background: 'opaque',
    maxEdge: 820,
    prompt:
      'A Mexican woman in her late 20s seated at a clean minimalist desk, reviewing her finances on a smartphone, ' +
      'a hopeful and thoughtful expression as she plans ahead. Bright, warm, optimistic setting with soft natural light.',
  },
  'hr-director': {
    file: 'hr-director.png',
    size: '1536x1024',
    background: 'opaque',
    maxEdge: 1200,
    prompt:
      'A professional Mexican HR director in their early 40s, business-casual blazer, standing in a modern corporate office, ' +
      'arms relaxed, warm confident approachable smile, soft out-of-focus office and greenery in the background.',
  },
  carlosheadshot: {
    file: 'carlosheadshot.png',
    size: '1024x1024',
    background: 'opaque',
    maxEdge: 500,
    prompt:
      'Professional corporate headshot of a Mexican man in his 40s, HR / operations director, short neat hair, ' +
      'collared business-casual shirt, warm friendly confident expression, soft neutral studio background, head and shoulders framing.',
  },
  ana: {
    file: 'ana.png',
    size: '1024x1024',
    background: 'opaque',
    maxEdge: 500,
    prompt:
      'Professional headshot of a Mexican woman in her early 30s, a factory operator, natural warm genuine smile, ' +
      'simple clean softly-lit neutral background, head and shoulders framing.',
  },
  roberto: {
    file: 'roberto.png',
    size: '1024x1024',
    background: 'opaque',
    maxEdge: 500,
    prompt:
      'Professional headshot of a Mexican man in his late 30s, an operations / logistics manager, friendly and confident, ' +
      'clean neutral softly-lit background, head and shoulders framing.',
  },
};

const client = new OpenAI({ apiKey: KEY });

function resize(filePath, maxEdge) {
  try {
    execFileSync('sips', ['--resampleHeightWidthMax', String(maxEdge), filePath, '--out', filePath], {
      stdio: 'ignore',
    });
  } catch {
    console.warn(`  (sips resize skipped for ${path.basename(filePath)})`);
  }
}

async function generate(key) {
  const t = TARGETS[key];
  if (!t) {
    console.warn(`  unknown target "${key}" — skipping`);
    return;
  }
  process.stdout.write(`• ${t.file} … `);
  const resp = await client.images.generate({
    model: 'gpt-image-1',
    prompt: `${t.prompt}\n\n${STYLE}`,
    size: t.size,
    quality: 'high',
    background: t.background,
    output_format: 'png',
    n: 1,
  });
  const b64 = resp.data?.[0]?.b64_json;
  if (!b64) throw new Error('no image data returned');
  const out = path.join(IMG_DIR, t.file);
  fs.writeFileSync(out, Buffer.from(b64, 'base64'));
  resize(out, t.maxEdge);
  const kb = (fs.statSync(out).size / 1024).toFixed(0);
  console.log(`done (${kb} KB)`);
}

const argv = process.argv.slice(2);
const keys = argv.length ? argv : Object.keys(TARGETS);

console.log(`\nGenerating ${keys.length} image(s) with gpt-image-1 …\n`);
for (const k of keys) {
  try {
    await generate(k);
  } catch (e) {
    console.error(`  FAILED ${k}: ${e.message}`);
  }
}
console.log('\nDone.\n');
