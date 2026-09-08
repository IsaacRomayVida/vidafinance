/**
 * Brand assets in the funpay-ui direction (.claude/skills/funpay-ui/references/imagery.md).
 *
 * Stills  — OpenAI Images (env OPENAI_API_KEY): macro botanical, motion-blurred
 *           portrait, figure in soft green, dark abstract, and transparent
 *           cutouts (leaf, frond, the cream-and-sage paper kite).
 * Films   — fal.ai Seedance (env FAL_KEY): five intro scenes in the botanical
 *           grade that each end on the kite, and two leaf loops (9:16 for the
 *           app's Home board, 16:9 for the website hero).
 *
 * Keys come from the environment only (GitHub secrets in CI). Nothing is
 * committed by this script; it writes to --out (default ./brand-assets) and the
 * workflow uploads that folder as an artifact for review.
 *
 * USAGE: node scripts/generate-brand-assets.mjs --set imagery|intros|loops|all [--out dir] [--pro]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const SET = flag('--set', 'all');
const OUT = flag('--out', 'brand-assets');
const PRO = args.includes('--pro');
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- prompts
// Every image prompt ends with the skill's negative list. Grade words are the
// skill's: olive, moss, chartreuse, cream; muted, desaturated, grainy.
const NEG =
  'No text, no watermark, no logo, no saturated colours, no neon, no bright white, no sharp face, no eye contact, no bouquet, no multiple subjects, no stock photo lighting, no HDR.';

const IMAGES = [
  {
    file: 'leaf-home-calla.png', size: '1024x1536',
    prompt: `Macro photograph of a single backlit calla lily spathe, translucent, veins visible, olive and chartreuse green fading to cream at the top, extremely shallow depth of field, soft diffused light, muted desaturated film look, fine grain, no background, the form rises from the bottom and leans to one side leaving a clean lighter area in the upper third and a darker mass in the lower third, vertical. ${NEG}`,
  },
  {
    file: 'leaf-home-fern.png', size: '1024x1536',
    prompt: `Macro photograph of a single backlit fern frond unrolling, translucent, veins visible, olive and chartreuse green fading to cream at the top, extremely shallow depth of field, soft diffused light, muted desaturated film look, fine grain, no background, form rising from the bottom leaning to one side, clean lighter area in the upper third, vertical. ${NEG}`,
  },
  {
    file: 'portrait-clay.png', size: '1536x1024',
    prompt: `Long exposure portrait, a person holding a pale flower over their face, motion blur, face not visible, olive green and clay tones, muted, soft cream flower petals as the only sharp detail, grainy analog film, dark green shadows, editorial, figure centred, flower upper-centre. ${NEG}`,
  },
  {
    file: 'figure-green.png', size: '1024x1024',
    prompt: `Soft-focus portrait from the shoulders up, a person in a pale sage green ribbed knit top, green-grey background, heavily diffused, face turned away and out of focus, muted pastel, colour study, minimal. ${NEG}`,
  },
  {
    file: 'dark-abstract.png', size: '1024x1024',
    prompt: `Near-black photograph, the shadowed shoulder of a figure against black, faint cool grey-green gradient, almost no detail, grainy, moody, minimal. ${NEG}`,
  },
  // Transparent cutouts — floats for the website statement boards and the app.
  {
    file: 'cutout-leaf.png', size: '1024x1536', transparent: true,
    prompt: `A single backlit leaf, isolated on a transparent background, olive and chartreuse green with cream highlights along the veins, translucent, soft diffused light, muted desaturated film grade, photographic, no shadow on the ground. ${NEG}`,
  },
  {
    file: 'cutout-frond.png', size: '1024x1536', transparent: true,
    prompt: `A single fern frond unrolling, isolated on a transparent background, olive to cream, translucent, backlit, muted desaturated film grade, photographic, no ground shadow. ${NEG}`,
  },
  {
    file: 'cutout-kite.png', size: '1024x1536', transparent: true,
    prompt: `A small paper kite, diamond shaped, cream paper with a sage green cross and a short cream tail, photographed in soft diffused light, isolated on a transparent background, muted desaturated film grade, slight paper texture, photographic. ${NEG}`,
  },
];

const KITE_END = 'In the last second a small cream paper kite with a sage green cross drifts up across the top of the frame and holds against a pale cream sky.';
const GRADE = 'Muted desaturated analog film grade, olive and moss greens through chartreuse to cream highlights, fine grain, soft diffused light, no saturated colour, no bright white, no text.';

const FILMS = [
  { file: 'intro-calla.mp4', aspect: '9:16', prompt: `Macro of a single backlit calla lily spathe, light slowly drifting through its translucent veins, extremely shallow focus, the form leaning to one side. ${GRADE} ${KITE_END}` },
  { file: 'intro-portrait.mp4', aspect: '9:16', prompt: `Long exposure portrait of a person holding a pale flower over their face, slow motion blur, face never visible, olive-clay tones, the flower the only crisp detail. ${GRADE} ${KITE_END}` },
  { file: 'intro-figure.mp4', aspect: '9:16', prompt: `Soft-focus figure from the shoulders up in a pale sage green knit top, turning slowly away, green-grey field, heavily diffused. ${GRADE} ${KITE_END}` },
  { file: 'intro-fern.mp4', aspect: '9:16', prompt: `A backlit fern frond unrolling slowly with dew on it, olive to cream, shallow focus, gentle breeze. ${GRADE} ${KITE_END}` },
  { file: 'intro-grass.mp4', aspect: '9:16', prompt: `Grass blades with dew moving in a slow breeze, backlit olive light, extremely shallow focus, cream sky above. ${GRADE} ${KITE_END}` },
];

const LOOPS = [
  { file: 'leaf-loop.mp4', aspect: '9:16', prompt: `Macro of a single backlit leaf swaying very slowly in a breeze, translucent veins, olive and chartreuse to cream at the top, extremely shallow focus, seamless slow ambient motion, no camera movement. ${GRADE}` },
  { file: 'leaf-loop-wide.mp4', aspect: '16:9', prompt: `Macro of a single backlit leaf swaying very slowly in a breeze, translucent veins, olive and chartreuse to cream toward one side, extremely shallow focus, seamless slow ambient motion, no camera movement, wide. ${GRADE}` },
];

// ---------------------------------------------------------------- stills
const IMAGE_MODELS = ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1'];

async function generateImage(spec) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY missing');
  let lastErr;
  for (const model of IMAGE_MODELS) {
    const body = { model, prompt: spec.prompt, size: spec.size, n: 1, quality: 'high', output_format: 'png' };
    if (spec.transparent) body.background = 'transparent';
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 404 || res.status === 400) {
      const text = await res.text();
      // Unknown model → try the next one; anything else is a real error.
      if (/model|not found|does not exist|invalid_request/i.test(text) && /model/i.test(text)) { lastErr = `${model}: ${text.slice(0, 200)}`; continue; }
      throw new Error(`${model} ${res.status}: ${text.slice(0, 300)}`);
    }
    if (!res.ok) throw new Error(`${model} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error(`${model}: no image in response`);
    writeFileSync(join(OUT, spec.file), Buffer.from(b64, 'base64'));
    console.log(`still  ${spec.file}  (${model}, ${spec.size}${spec.transparent ? ', transparent' : ''})`);
    return;
  }
  throw new Error(`no image model accepted the request: ${lastErr}`);
}

// ---------------------------------------------------------------- films
const VIDEO_MODEL = PRO ? 'fal-ai/bytedance/seedance/v1/pro/text-to-video' : 'fal-ai/bytedance/seedance/v1/lite/text-to-video';

async function generateFilm(spec) {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error('FAL_KEY missing');
  const headers = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };
  const submit = await fetch(`https://queue.fal.run/${VIDEO_MODEL}`, {
    method: 'POST', headers,
    body: JSON.stringify({ prompt: spec.prompt, aspect_ratio: spec.aspect, resolution: PRO ? '1080p' : '720p', duration: '5' }),
  });
  if (!submit.ok) throw new Error(`fal submit ${submit.status}: ${(await submit.text()).slice(0, 300)}`);
  const { request_id, status_url, response_url } = await submit.json();
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 6000));
    const st = await fetch(status_url, { headers });
    const s = await st.json();
    if (s.status === 'COMPLETED') break;
    if (s.status === 'FAILED') throw new Error(`fal ${request_id} failed: ${JSON.stringify(s).slice(0, 300)}`);
    if (Date.now() - started > 12 * 60 * 1000) throw new Error(`fal ${request_id} timed out`);
  }
  const result = await (await fetch(response_url, { headers })).json();
  const url = result.video?.url;
  if (!url) throw new Error(`fal ${request_id}: no video url`);
  const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
  writeFileSync(join(OUT, spec.file), bytes);
  console.log(`film   ${spec.file}  (${VIDEO_MODEL.split('/').slice(-3, -1).join('/')}, ${spec.aspect}, ${(bytes.length / 1e6).toFixed(1)} MB)`);
}

// ---------------------------------------------------------------- run
const failures = [];
async function runAll(list, fn) {
  for (const spec of list) {
    try { await fn(spec); } catch (e) { failures.push(`${spec.file}: ${e.message}`); console.error(`FAILED ${spec.file}: ${e.message}`); }
  }
}
if (SET === 'imagery' || SET === 'all') await runAll(IMAGES, generateImage);
if (SET === 'intros' || SET === 'all') await runAll(FILMS, generateFilm);
if (SET === 'loops' || SET === 'all') await runAll(LOOPS, generateFilm);
if (failures.length) { console.error(`\n${failures.length} asset(s) failed:\n- ${failures.join('\n- ')}`); process.exitCode = 1; }
