/**
 * generate-brand-splash.mjs — native splash artwork via fal.ai FLUX.
 *
 * The splash is the first frame of the brand: the papalote's dawn sky,
 * vast and calm, before the app even wakes. Reads the fal.ai key from
 * FAL_KEY env (CI: the FAL_AI repo secret) or ~/.fal/key, writes
 * mobile/assets/splash-generated.png (portrait 1080x2340).
 *
 * USAGE:  node scripts/generate-brand-splash.mjs [--prompt "..."]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let KEY = (process.env.FAL_KEY || '').trim();
if (!KEY) {
  try {
    KEY = readFileSync(join(homedir(), '.fal', 'key'), 'utf8').trim();
  } catch {
    KEY = '';
  }
}
if (!KEY || KEY.includes('PASTE_YOUR')) {
  console.error('No fal.ai key: set FAL_KEY or put the key in ~/.fal/key');
  process.exit(1);
}

const MODEL = 'fal-ai/flux/dev';
const argPrompt = process.argv.indexOf('--prompt');
const prompt =
  argPrompt > -1
    ? process.argv[argPrompt + 1]
    : 'Minimal vertical phone wallpaper artwork: serene dawn sky, smooth gradient from pale ' +
      'mint-aqua at the top to soft warm golden light at the horizon below, one small elegant ' +
      'kite in deep teal and gold soaring very high with a long graceful curving string, vast ' +
      'negative space, sense of freedom and a new day, premium fintech brand aesthetic, soft ' +
      'diffused light, no text, no logo, no people, no birds';

const headers = { Authorization: `Key ${KEY}`, 'Content-Type': 'application/json' };

async function main() {
  console.log('Submitting to', MODEL);
  const submit = await fetch(`https://queue.fal.run/${MODEL}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt,
      image_size: { width: 1080, height: 2340 },
      num_images: 1,
      enable_safety_checker: true,
    }),
  });
  if (!submit.ok) throw new Error(`submit ${submit.status}: ${await submit.text()}`);
  const { status_url, response_url } = await submit.json();

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const status = await (await fetch(status_url, { headers })).json();
    process.stdout.write(`\r${status.status}    `);
    if (status.status === 'COMPLETED') break;
    if (status.status === 'FAILED') throw new Error('generation failed');
  }
  console.log();

  const result = await (await fetch(response_url, { headers })).json();
  const imageUrl = result?.images?.[0]?.url;
  if (!imageUrl) throw new Error(`no image url in result: ${JSON.stringify(result).slice(0, 300)}`);

  const bytes = Buffer.from(await (await fetch(imageUrl)).arrayBuffer());
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'splash-generated.png');
  writeFileSync(out, bytes);
  console.log(`Saved ${out} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
