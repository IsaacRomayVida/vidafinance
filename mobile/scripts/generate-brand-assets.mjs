/**
 * Brand assets in the funpay-ui direction (.claude/skills/funpay-ui/references/imagery.md).
 *
 * Subject (Isaac, 2026-09-08): PEOPLE ACHIEVING FREEDOM — the moment someone
 * can pay for the last-minute thing. Never plants as subject. Faces are never
 * legible (turned away, motion-blurred, out of focus); the grade stays the
 * skill's muted olive-clay-and-cream film look, and every intro ends on the
 * photographic — documentary, never illustrated.
 *
 * Stills  — OpenAI Images (env OPENAI_API_KEY): Home backgrounds, four
 *           "moments", the figure in green, the dark abstract, and transparent
 *           cutouts (the pharmacy paper bag).
 * Films   — fal.ai Seedance (env FAL_KEY): five intro scenes and two ambient
 *           loops (9:16 for the app's Home board, 16:9 for the website hero).
 *
 * Keys come from the environment only (GitHub secrets in CI). Nothing is
 * committed by this script; it writes to --out (default ./brand-assets) and the
 * workflow uploads that folder as an artifact for review.
 *
 * USAGE: node scripts/generate-brand-assets.mjs --set imagery|icons|stages|animate|intros|loops|all [--out dir] [--pro]
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

/** Where every human scene is set, and who is in it. Declared here because
 *  both the stills and the films reference it. */
const MX = 'MEXICO, Riviera Maya, Quintana Roo. CASTING: Mexican adults between 25 and 45 years old, healthy and fit, well groomed, neat hair, clean pressed clothing. Resort and five-star hotel staff in crisp tailored uniforms, and off duty in simple modern clothes. SETTING: a mix — some scenes inside a well-kept upscale resort (clean stucco, polished concrete, coquina stone, good architecture, designed landscaping) and some in a modest but tidy, dignified Mexican home. Warm Caribbean morning light, coconut palms, bougainvillea. NOT Europe, NOT Mediterranean, NOT Asia. No elderly or frail people, no run-down or dilapidated buildings, no rubbish, no poverty cues.';

const IMAGES = [
  // Home backgrounds — 9:16, a clear lighter upper third for the numeral,
  // a darker mass in the lower third for the chips. A person, never legible.
  {
    file: 'home-doorway.png', size: '1024x1536',
    prompt: `${MX} A hotel housekeeper in a pale sage uniform stepping out of a service door into early morning light, seen from behind, walking away, long-exposure motion blur, face never visible, olive and clay tones, a pale cream sky filling the upper third of the frame, darker doorway shadow in the lower third, muted desaturated analog film grade, fine grain, editorial, vertical. ${NEG}`,
  },
  {
    file: 'home-stall.png', size: '1024x1536',
    prompt: `${MX} A woman in a pale sage apron raising the shutter of her small street food stall at dawn, seen from behind, warm cream morning light filling the upper third, the darker stall interior in the lower third, shot on 35mm film, documentary photography, muted desaturated grade, olive and clay tones, fine grain, shallow depth of field, face never visible, vertical. ${NEG}`,
  },
  // Moments — 4:3, for the credit-line / statement boards and the website.
  {
    file: 'moment-pharmacy.png', size: '1536x1024',
    prompt: `${MX} Close-up of hands at a pharmacy counter receiving a small cream paper bag of medicine, soft focus, no faces in frame, warm olive and clay tones with cream highlights, quiet relief, muted desaturated analog film grade, fine grain, editorial. ${NEG}`,
  },
  {
    file: 'moment-backpack.png', size: '1536x1024',
    prompt: `${MX} A mother in her early thirties, in a neat blouse, kneels in the doorway of a tidy modern Mexican home and helps her child shoulder a school backpack; the child wears a clean school uniform and proper school shoes. Polished concrete or tiled floor, painted walls, a potted plant, a paved path outside. Both faces turned away and softly blurred, backlit morning light, tender and unposed. Comfortable working-family home — no dirt floor, no bare feet, no bamboo or makeshift fencing, nothing run-down. Muted desaturated analog film grade, fine grain, editorial. ${NEG}`,
  },
  {
    file: 'moment-kitchen.png', size: '1536x1024',
    prompt: `${MX} A person sitting at a simple kitchen table at dawn, seen from the side and slightly behind, exhaling with relief, a phone face-down on the table, window light, face out of focus, olive-clay and cream tones, muted desaturated analog film grade, fine grain, editorial. ${NEG}`,
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


/**
 * IMAGE-TO-VIDEO (Isaac, 2026-09-08): "the videos don't look like the images
 * at all — do image to video so we have exactly the same look and feel."
 *
 * Text-to-video kept inventing its own world: different country, different
 * palette, cartoon props. These start FROM the photographs already published
 * on the site, so the first frame IS the picture and the grade cannot drift.
 * Motion is deliberately small — a background has to hold type.
 */
const SITE = process.env.BRAND_IMAGE_BASE || 'https://alfa.funpay.mx/images/brand';
const MOTION = 'Subtle natural motion only. The camera does not move, does not zoom and does not pan. No new objects enter the frame, nothing morphs, nobody turns toward the camera. Photographic, documentary, film grain preserved.';

const ANIMATED = [
  {
    file: 'live-doorway.mp4', image: `${SITE}/home-doorway.jpg`, aspect: '9:16',
    prompt: `She keeps walking slowly away down the path; her dress and the palm fronds move gently in the breeze; the light stays soft and even. ${MOTION}`,
  },
  {
    file: 'live-stall.mp4', image: `${SITE}/home-stall.jpg`, aspect: '9:16',
    prompt: `She finishes raising the shutter and settles her hands; steam drifts; palm fronds sway slightly against the dawn light. ${MOTION}`,
  },
  {
    file: 'live-pharmacy.mp4', image: `${SITE}/moment-pharmacy.jpg`, aspect: '16:9',
    prompt: `The hands complete the exchange of the paper bag and draw it in; a small settling of the fingers. ${MOTION}`,
  },
  {
    file: 'live-backpack.mp4', image: `${SITE}/moment-backpack.jpg`, aspect: '16:9',
    prompt: `The child steps forward through the doorway into the light while the parent stays kneeling; a soft shift of weight. ${MOTION}`,
  },
  {
    file: 'live-kitchen.mp4', image: `${SITE}/moment-kitchen.jpg`, aspect: '16:9',
    prompt: `She breathes out and her shoulders lower a little; the window light shifts almost imperceptibly. ${MOTION}`,
  },
];

/**
 * PHOTOGRAPHIC ONLY (Isaac, 2026-09-08). The handmade-kite motif is out of
 * the films: every generator rendered it as a cartoon pasted over the plate.
 * The films are documentary photography of the moment credit buys — the
 * housekeeper stepping out at dawn is the reference for all of them.
 */
const GRADE = 'Shot on 35mm film, documentary photography, muted desaturated grade, olive and clay tones through moss to cream highlights, fine natural grain, soft diffused natural light, shallow depth of field, faces never legible, low saturation, no bright or saturated colour, no neon, no pink, no bright white, no text, no illustration, no cartoon, no graphic overlay, no CGI.';

const FILMS = [
  { file: 'intro-doorway.mp4', aspect: '9:16', prompt: `${MX} A hotel housekeeper in a pale sage uniform steps through a service doorway into early morning light, seen from behind, carrying a linen basket, walking slowly away down a path; misty hills and soft cream sky beyond; the camera holds still. ${GRADE}` },
  { file: 'intro-backpack.mp4', aspect: '9:16', prompt: `${MX} A mother kneels in the doorway of a modest home and helps her small child shoulder a school backpack; the child steps out into the morning light; both faces turned away and softly blurred; unposed and tender; the camera holds still. ${GRADE}` },
  { file: 'intro-pharmacy.mp4', aspect: '9:16', prompt: `${MX} Close-up of hands at a small pharmacy counter receiving a cream paper bag of medicine; the hands close around it and draw it in; no faces in frame; a quiet moment of relief; slow, the camera holds still. ${GRADE}` },
  { file: 'intro-kitchen.mp4', aspect: '9:16', prompt: `${MX} INTERIOR of a small kitchen at dawn: a woman sits at the table by the window, seen from behind and to the side, lowers her shoulders in relief and sets a phone face-down on the table. Soft window light on a tiled wall, kettle and cups on the counter. Indoors only — no street, no murals, no outdoor furniture. Face never visible. Slow, the camera holds still. ${GRADE}` },
  { file: 'intro-market.mp4', aspect: '9:16', prompt: `${MX} A woman in a pale sage apron raises the shutter of her small street food stall at dawn and turns to arrange the counter, seen from behind; steam and warm morning light; face never visible; the camera holds still. ${GRADE}` },
];

/** Ambient loops that sit BEHIND content — they must be calm and empty
 *  enough for type to sit on, so they are light and atmosphere, not events. */
const LOOPS = [
  { file: 'ambient-loop.mp4', aspect: '9:16', prompt: `${MX} A hotel service doorway at dawn seen from inside: soft cream light falling through the open door onto a tiled floor, palm shadows moving very gently in the breeze, nobody in frame, almost still, seamless ambient motion, the camera does not move. ${GRADE}` },
  { file: 'ambient-loop-wide.mp4', aspect: '16:9', prompt: `${MX} Early morning light moving very gently across a quiet hotel service corridor, palm shadows drifting on a cream wall, nobody in frame, almost still, seamless ambient motion, the camera does not move, wide. ${GRADE}` },
];

// Every human scene must reference MX rather than repeat the setting inline:
// pasted copies went stale silently and a casting change reached nothing.
for (const spec of [...IMAGES, ...ANIMATED, ...FILMS]) {
  if (/Quintana Roo/.test(spec.prompt) && !spec.prompt.startsWith(MX)) {
    throw new Error(`${spec.file}: hardcodes the setting — use \${MX} instead`);
  }
}

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
const I2V_MODEL = PRO ? 'fal-ai/bytedance/seedance/v1/pro/image-to-video' : 'fal-ai/bytedance/seedance/v1/lite/image-to-video';

async function generateFilm(spec) {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error('FAL_KEY missing');
  const headers = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };
  // With an `image`, the film starts from that exact photograph.
  const model = spec.image ? I2V_MODEL : VIDEO_MODEL;
  const body = spec.image
    ? { prompt: spec.prompt, image_url: spec.image, resolution: PRO ? '1080p' : '720p', duration: '5' }
    : { prompt: spec.prompt, aspect_ratio: spec.aspect, resolution: PRO ? '1080p' : '720p', duration: '5' };
  const submit = await fetch(`https://queue.fal.run/${model}`, {
    method: 'POST', headers, body: JSON.stringify(body),
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
  console.log(`film   ${spec.file}  (${spec.image ? 'image-to-video' : 'text-to-video'}, ${(bytes.length / 1e6).toFixed(1)} MB)`);
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
if (SET === 'animate' || SET === 'all') await runAll(ANIMATED, generateFilm);
if (SET === 'intros') await runAll(FILMS, generateFilm);
if (SET === 'loops' || SET === 'all') await runAll(LOOPS, generateFilm);
if (failures.length) { console.error(`\n${failures.length} asset(s) failed:\n- ${failures.join('\n- ')}`); process.exitCode = 1; }
