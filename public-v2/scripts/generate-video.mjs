/**
 * Build-time hero/splash video generation for Funpay using fal.ai Seedance 2.0.
 *
 * Produces one cinematic, loop-friendly 16:9 clip used both as the one-time splash
 * intro and the looping homepage hero background. Downloads the MP4 into
 * public/video/ and (if ffmpeg is available) extracts a poster frame so the hero
 * has an instant, non-janky first paint.
 *
 * FAL_KEY is read at runtime from public-v2/.env.local (gitignored) and never printed.
 *
 * Usage:
 *   node scripts/generate-video.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fal } from '@fal-ai/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VIDEO_DIR = path.join(ROOT, 'public', 'video');

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

const KEY = process.env.FAL_KEY || process.env.FAL_AI;
if (!KEY) {
  console.error('\n[generate-video] FAL_KEY missing.');
  console.error('Add it to public-v2/.env.local (gitignored):  FAL_KEY=...\n');
  process.exit(1);
}
fal.config({ credentials: KEY });

const PRESETS = {
  hero: {
    name: 'hero',
    prompt: [
      'Cinematic slow dolly shot gliding through a bright, modern Mexican workplace at golden hour —',
      'a blend of light manufacturing, logistics and a clean open-plan office.',
      'Diverse employees in their 20s-40s work with quiet confidence and share genuine, subtle smiles;',
      'one glances at a smartphone with relief and optimism.',
      'Soft volumetric sunlight streams through large windows, dust motes in the air, shallow depth of field.',
      'Refined teal-and-gold cinematic color grade (deep teal and warm muted gold), premium fintech brand film.',
      'Smooth, gentle, continuous camera motion suitable for a seamless background loop.',
      'No text, no logos, no on-screen graphics.',
    ].join(' '),
  },
  showcase: {
    name: 'showcase',
    prompt: [
      'Intimate cinematic medium shot of a Mexican worker in their early 30s pausing during the workday to check',
      'their smartphone, then breaking into a quiet, relieved, grateful smile as emergency funds arrive.',
      'Warm soft natural light, shallow depth of field, coworkers gently blurred in the background of a modern workplace.',
      'Emotional, hopeful and reassuring mood. Refined teal-and-gold cinematic color grade.',
      'Slow, smooth camera push-in suitable for a seamless background loop.',
      'No text, no logos, no on-screen graphics.',
    ].join(' '),
  },
};

function makePoster(mp4, poster) {
  // Prefer ffmpeg; fall back to macOS Quick Look (qlmanage).
  try {
    execFileSync('ffmpeg', ['-y', '-i', mp4, '-vframes', '1', '-q:v', '3', poster], { stdio: 'ignore' });
    return true;
  } catch {
    /* try qlmanage */
  }
  try {
    const dir = path.dirname(mp4);
    execFileSync('qlmanage', ['-t', '-s', '1280', '-o', dir, mp4], { stdio: 'ignore' });
    const ql = `${mp4}.png`;
    if (fs.existsSync(ql)) {
      execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', ql, '--out', poster], { stdio: 'ignore' });
      fs.unlinkSync(ql);
      return true;
    }
  } catch {
    /* give up */
  }
  return false;
}

async function run() {
  const which = process.argv[2] || 'hero';
  const preset = PRESETS[which];
  if (!preset) {
    console.error(`Unknown preset "${which}". Options: ${Object.keys(PRESETS).join(', ')}`);
    process.exit(1);
  }

  fs.mkdirSync(VIDEO_DIR, { recursive: true });
  console.log(`\nGenerating "${preset.name}" video with Seedance 2.0 (this can take a few minutes) …\n`);

  const result = await fal.subscribe('bytedance/seedance-2.0/text-to-video', {
    input: {
      prompt: preset.prompt,
      resolution: '720p',
      duration: '6',
      aspect_ratio: '16:9',
      generate_audio: false,
    },
    logs: true,
    onQueueUpdate: (update) => {
      if (update.status === 'IN_PROGRESS') {
        (update.logs || []).forEach((l) => l.message && console.log('  ' + l.message));
      } else {
        console.log('  status:', update.status);
      }
    },
  });

  const url = result?.data?.video?.url;
  if (!url) throw new Error('no video url returned: ' + JSON.stringify(result?.data));

  console.log('\nDownloading clip …');
  const res = await fetch(url);
  if (!res.ok) throw new Error('download failed: ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const mp4 = path.join(VIDEO_DIR, `${preset.name}.mp4`);
  fs.writeFileSync(mp4, buf);
  console.log(`Saved ${mp4} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);

  const poster = path.join(VIDEO_DIR, `${preset.name}-poster.jpg`);
  if (makePoster(mp4, poster)) {
    console.log(`Saved poster ${poster}`);
  } else {
    console.log('(no ffmpeg/qlmanage — skipping poster extraction)');
  }

  console.log('\nDone.\n');
}

run().catch((e) => {
  console.error('\nFAILED:', e.message);
  process.exit(1);
});
