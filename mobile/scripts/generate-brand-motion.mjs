/**
 * generate-brand-motion.mjs — brand ambient loop via fal.ai Seedance.
 *
 * Generates a slow, abstract aqua-glass motion clip in the FunPay palette,
 * for use dimmed behind the Login glass card. Reads the fal.ai key from
 * ~/.fal/key (never from argv or the repo) and writes
 * mobile/assets/brand-loop.mp4.
 *
 * USAGE:  node scripts/generate-brand-motion.mjs [--prompt "..."]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY = readFileSync(join(homedir(), '.fal', 'key'), 'utf8').trim();
if (!KEY || KEY.includes('PASTE_YOUR')) {
  console.error('No real fal.ai key in ~/.fal/key');
  process.exit(1);
}

const MODEL = 'fal-ai/bytedance/seedance/v1/lite/text-to-video';
const argPrompt = process.argv.indexOf('--prompt');
const prompt =
  argPrompt > -1
    ? process.argv[argPrompt + 1]
    : 'Extreme slow motion abstract macro: translucent aquamarine glass and soft deep-teal fluid, ' +
      'gentle light caustics drifting through frosted glass, pale mint-white background, faint warm ' +
      'gold glints, elegant calm premium private-banking mood, soft focus, no text, no people, ' +
      'seamless gentle continuous motion';

const headers = { Authorization: `Key ${KEY}`, 'Content-Type': 'application/json' };

async function main() {
  console.log('Submitting to', MODEL);
  const submit = await fetch(`https://queue.fal.run/${MODEL}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt, aspect_ratio: '9:16', resolution: '720p', duration: '5' }),
  });
  if (!submit.ok) throw new Error(`submit ${submit.status}: ${await submit.text()}`);
  const { status_url, response_url } = await submit.json();

  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const status = await (await fetch(status_url, { headers })).json();
    process.stdout.write(`\r${status.status}    `);
    if (status.status === 'COMPLETED') break;
    if (status.status === 'FAILED') throw new Error('generation failed');
  }
  console.log();

  const result = await (await fetch(response_url, { headers })).json();
  const videoUrl = result?.video?.url;
  if (!videoUrl) throw new Error(`no video url in result: ${JSON.stringify(result).slice(0, 300)}`);

  const bytes = Buffer.from(await (await fetch(videoUrl)).arrayBuffer());
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'brand-loop.mp4');
  writeFileSync(out, bytes);
  console.log(`Saved ${out} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
  console.log('Review it, then wire it into LoginScreen (see PR notes).');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
