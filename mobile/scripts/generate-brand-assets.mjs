/**
 * Brand assets in the funpay-ui direction (.claude/skills/funpay-ui/references/imagery.md).
 *
 * Subject (Isaac, 2026-09-08): PEOPLE ACHIEVING FREEDOM — the moment someone
 * can pay for the last-minute thing. Never plants as subject. Faces are never
 * legible (turned away, motion-blurred, out of focus); the grade stays the
 * skill's muted olive-clay-and-cream film look, and every intro ends on the
 * cream-and-sage paper kite, the brand's freedom motif.
 *
 * Stills  — OpenAI Images (env OPENAI_API_KEY): Home backgrounds, four
 *           "moments", the figure in green, the dark abstract, and transparent
 *           cutouts (kite, hands with kite, pharmacy paper bag).
 * Films   — fal.ai Seedance (env FAL_KEY): five intro scenes and two kite
 *           loops (9:16 for the app's Home board, 16:9 for the website hero).
 *
 * Keys come from the environment only (GitHub secrets in CI). Nothing is
 * committed by this script; it writes to --out (default ./brand-assets) and the
 * workflow uploads that folder as an artifact for review.
 *
 * USAGE: node scripts/generate-brand-assets.mjs --set imagery|icons|stages|intros|loops|all [--out dir] [--pro]
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
  // Home backgrounds — 9:16, a clear lighter upper third for the numeral,
  // a darker mass in the lower third for the chips. A person, never legible.
  {
    file: 'home-doorway.png', size: '1024x1536',
    prompt: `Setting: Quintana Roo, Mexico — a Mexican family, Caribbean morning light, tropical shadows, humble and dignified. A hotel housekeeper in a pale sage uniform stepping out of a service door into early morning light, seen from behind, walking away, long-exposure motion blur, face never visible, olive and clay tones, a pale cream sky filling the upper third of the frame, darker doorway shadow in the lower third, muted desaturated analog film grade, fine grain, editorial, vertical. ${NEG}`,
  },
  {
    file: 'home-kite.png', size: '1024x1536',
    prompt: `Two Mexican hands releasing a small cream paper kite with a sage green cross into a pale Caribbean sky, seen from below, slight motion blur on the hands, no face, olive-clay skin tones desaturated toward clay, the sky filling the upper two thirds, muted desaturated analog film grade, fine grain, vertical. ${NEG}`,
  },
  // Moments — 4:3, for the credit-line / statement boards and the website.
  {
    file: 'moment-pharmacy.png', size: '1536x1024',
    prompt: `Setting: Quintana Roo, Mexico — a Mexican family, Caribbean morning light, tropical shadows, humble and dignified. Close-up of hands at a pharmacy counter receiving a small cream paper bag of medicine, soft focus, no faces in frame, warm olive and clay tones with cream highlights, quiet relief, muted desaturated analog film grade, fine grain, editorial. ${NEG}`,
  },
  {
    file: 'moment-backpack.png', size: '1536x1024',
    prompt: `Setting: Quintana Roo, Mexico — a Mexican family, Caribbean morning light, tropical shadows, humble and dignified. A parent kneeling in a doorway handing a child a school backpack, backlit by morning light, both faces turned away and softly blurred, olive-clay and cream tones, muted desaturated analog film grade, fine grain, editorial, tender and unposed. ${NEG}`,
  },
  {
    file: 'moment-kitchen.png', size: '1536x1024',
    prompt: `Setting: Quintana Roo, Mexico — a Mexican family, Caribbean morning light, tropical shadows, humble and dignified. A person sitting at a simple kitchen table at dawn, seen from the side and slightly behind, exhaling with relief, a phone face-down on the table, window light, face out of focus, olive-clay and cream tones, muted desaturated analog film grade, fine grain, editorial. ${NEG}`,
  },
  {
    file: 'figure-green.png', size: '1024x1024',
    prompt: `Soft-focus portrait from the shoulders up, a person in a pale sage green ribbed knit top, green-grey background, heavily diffused, face turned away and out of focus, muted pastel, colour study, minimal. ${NEG}`,
  },
  {
    file: 'dark-abstract.png', size: '1024x1024',
    prompt: `Near-black photograph, the shadowed shoulder of a figure against black, faint cool grey-green gradient, almost no detail, grainy, moody, minimal. ${NEG}`,
  },
  // Transparent cutouts — floats for the statement boards and the app.
  {
    file: 'cutout-kite.png', size: '1024x1536', transparent: true,
    prompt: `A small paper kite, diamond shaped, cream paper with a sage green cross and a short cream tail, photographed in soft diffused light, isolated on a transparent background, muted desaturated film grade, slight paper texture, photographic. ${NEG}`,
  },
  {
    file: 'cutout-hands-kite.png', size: '1024x1536', transparent: true,
    prompt: `Two hands holding the string of a small cream paper kite that floats just above them, isolated on a transparent background, olive-clay skin tones desaturated, soft diffused light, muted film grade, photographic, no face. ${NEG}`,
  },
  {
    file: 'cutout-paperbag.png', size: '1024x1024', transparent: true,
    prompt: `A small folded cream paper bag, the kind a pharmacy hands over the counter, isolated on a transparent background, soft diffused light, muted desaturated film grade, slight paper texture, photographic. ${NEG}`,
  },
];

// High-quality symbols to replace the folder glyphs: matte clay objects in
// cream and sage, one per real thing in the operation, on transparent ground.
const ICON_STYLE = 'Matte clay 3D icon, cream paper and pale sage green, soft studio light from the upper left, slight tilt, isolated on a transparent background, muted desaturated grade, no text, no shadow on the ground, centred, product-render quality.';
const ICONS = [
  { file: 'icon-nomina.png', size: '1024x1024', transparent: true, prompt: `${ICON_STYLE} Subject: a cream pay envelope with a sage band, slightly open.` },
  { file: 'icon-quincena.png', size: '1024x1024', transparent: true, prompt: `${ICON_STYLE} Subject: a small tear-off calendar block showing a single highlighted day in sage.` },
  { file: 'icon-empleador.png', size: '1024x1024', transparent: true, prompt: `${ICON_STYLE} Subject: a low modern hotel building, three storeys, cream with sage window bands.` },
  { file: 'icon-condusef.png', size: '1024x1024', transparent: true, prompt: `${ICON_STYLE} Subject: a rounded shield with a small sage check mark.` },
  { file: 'icon-sat.png', size: '1024x1024', transparent: true, prompt: `${ICON_STYLE} Subject: a folded cream receipt with a sage stamp.` },
  { file: 'icon-cobranza.png', size: '1024x1024', transparent: true, prompt: `${ICON_STYLE} Subject: three cream coins stacked with one sage coin on top.` },
  { file: 'icon-contrato.png', size: '1024x1024', transparent: true, prompt: `${ICON_STYLE} Subject: a single cream document with a sage signature line and a small seal.` },
  { file: 'icon-adelanto.png', size: '1024x1024', transparent: true, prompt: `${ICON_STYLE} Subject: a cream card with an upward sage arrow.` },
  { file: 'icon-kyc.png', size: '1024x1024', transparent: true, prompt: `${ICON_STYLE} Subject: an identity card silhouette with a sage circle where the photo would be.` },
  { file: 'icon-hotel-key.png', size: '1024x1024', transparent: true, prompt: `${ICON_STYLE} Subject: a hotel key card with a sage stripe on a small ring.` },
];
// Stage backgrounds — generated surfaces the crisp cards sit on.
const STAGES = [
  { file: 'stage-ops.png', size: '1536x1024', prompt: `Abstract photograph of a dark blue-charcoal surface fading into deep forest green, a soft green glow rising from the bottom edge, very fine film grain, faint depth like a dark studio backdrop, no subject, no text, no highlights blown out. ${NEG}` },
  { file: 'stage-employer.png', size: '1536x1024', prompt: `Wide photograph of a hotel service corridor at dawn, empty, seen from low, soft cream light entering from the far end, deep forest and charcoal shadows, muted desaturated analog film grade, fine grain, no people, no text. ${NEG}` },
];

const KITE_END = 'In the last second a small cream paper kite with a sage green cross rises across the top of the frame and holds against a pale cream sky.';
const GRADE = 'Muted desaturated analog film grade, olive and clay tones through moss to cream highlights, fine grain, soft diffused light, faces never legible, no saturated colour, no bright white, no text.';

const FILMS = [
  { file: 'intro-doorway.mp4', aspect: '9:16', prompt: `Setting: Quintana Roo, Mexico — a Mexican family, Caribbean morning light, tropical shadows, humble and dignified. A hotel housekeeper in a pale sage uniform steps out of a service door into early morning light, seen from behind, walking away with light motion blur, a pale cream sky above. ${GRADE} ${KITE_END}` },
  { file: 'intro-pharmacy.mp4', aspect: '9:16', prompt: `Setting: Quintana Roo, Mexico — a Mexican family, Caribbean morning light, tropical shadows, humble and dignified. Close-up of hands at a pharmacy counter receiving a small cream paper bag, soft focus, no faces, a quiet moment of relief, slow. ${GRADE} ${KITE_END}` },
  { file: 'intro-backpack.mp4', aspect: '9:16', prompt: `Setting: Quintana Roo, Mexico — a Mexican family, Caribbean morning light, tropical shadows, humble and dignified. A parent kneels in a backlit doorway and hands a child a school backpack, both faces turned away and softly blurred, tender and unposed, slow. ${GRADE} ${KITE_END}` },
  { file: 'intro-kitchen.mp4', aspect: '9:16', prompt: `Setting: Quintana Roo, Mexico — a Mexican family, Caribbean morning light, tropical shadows, humble and dignified. A person at a simple kitchen table at dawn, seen from the side, exhales with relief and sets a phone face-down, window light, face out of focus, slow. ${GRADE} ${KITE_END}` },
  { file: 'intro-release.mp4', aspect: '9:16', prompt: `Two Mexican hands, on a Quintana Roo beach at dawn, let go of the string of a small cream paper kite with a sage green cross; the kite climbs slowly into a pale cream sky, seen from below, slight motion blur on the hands. ${GRADE}` },
];

const LOOPS = [
  { file: 'kite-loop.mp4', aspect: '9:16', prompt: `A small cream paper kite with a sage green cross drifting very slowly in a pale cream sky, gentle ambient motion, no camera movement, seamless and calm, vertical. ${GRADE}` },
  { file: 'kite-loop-wide.mp4', aspect: '16:9', prompt: `A small cream paper kite with a sage green cross drifting very slowly in a pale cream sky, gentle ambient motion, no camera movement, seamless and calm, wide. ${GRADE}` },
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
if (SET === 'icons' || SET === 'all') await runAll(ICONS, generateImage);
if (SET === 'stages' || SET === 'all') await runAll(STAGES, generateImage);
if (SET === 'intros' || SET === 'all') await runAll(FILMS, generateFilm);
if (SET === 'loops' || SET === 'all') await runAll(LOOPS, generateFilm);
if (failures.length) { console.error(`\n${failures.length} asset(s) failed:\n- ${failures.join('\n- ')}`); process.exitCode = 1; }
