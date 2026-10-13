// node --test tests/load/target.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveTarget, preflight, PRODUCTION_SIGN_OFF } from './target.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/* ── Gen-2 (Cloud Run) production hosts ───────────────────────────────────── */
// A Cloud Run host never contains the project id, so these are recognised by
// vida-finance's Cloud Run hash and project number instead.

for (const url of [
  'https://api-gd5fcu677q-uc.a.run.app', // the live API host (e2e-test-v18.mjs)
  'https://api-gd5fcu677q-uc.a.run.app/health',
  'https://requestloan-gd5fcu677q-uc.a.run.app',
  'https://ondisbursementqueued-gd5fcu677q-uc.a.run.app/',
  'https://REQUESTLOAN-GD5FCU677Q-UC.A.RUN.APP',
  'https://requestloan-gd5fcu677q-ue.a.run.app', // another region
  'https://requestloan-447766605132.us-central1.run.app', // deterministic URL form
  'https://api-447766605132.us-central1.run.app/health',
]) {
  test(`Gen-2 production host refused: ${url}`, () => {
    assert.throws(() => resolveTarget({ TARGET_URL: url }), /PRODUCTION/);
    // Declaring it "staging" must not talk the guard out of it.
    assert.throws(() => resolveTarget({ TARGET_URL: url, LOAD_TEST_TARGET_ENV: 'staging' }), /PRODUCTION/);
  });
}

test('a Gen-2 production host is allowed only with the exact sign-off phrase', () => {
  const url = 'https://requestloan-gd5fcu677q-uc.a.run.app';
  assert.equal(
    resolveTarget({ TARGET_URL: url, LOAD_TEST_ALLOW_PRODUCTION: PRODUCTION_SIGN_OFF }).label,
    'production'
  );
});

test('the production .run.app patterns are sourced from the real project identifiers', () => {
  // If the project number in the web config ever changed, the guard would be
  // matching a project that is no longer production.
  const firebaseConfig = readFileSync(path.join(repoRoot, 'public-v2/src/lib/firebase.ts'), 'utf8');
  assert.match(firebaseConfig, /messagingSenderId: '447766605132'/);
  assert.match(firebaseConfig, /projectId: 'vida-finance'/);
});

test('a Cloud Run host of another project is unknown, not production — and says why to be careful', () => {
  for (const url of [
    'https://requestloan-ab12cd34ef-uc.a.run.app',
    'https://requestloan-123456789012.us-central1.run.app',
    // the production tokens only count as a whole `-token` segment
    'https://requestloan-xgd5fcu677q-uc.a.run.app',
    'https://requestloan-9447766605132.us-central1.run.app',
  ]) {
    assert.throws(() => resolveTarget({ TARGET_URL: url }), /Unknown remote target .*Cloud Run host does not name its project/);
    assert.equal(resolveTarget({ TARGET_URL: url, LOAD_TEST_TARGET_ENV: 'staging' }).label, 'staging');
  }
});

/* ── the operator-facing preflight the npm scripts run before k6 ──────────── */

test('preflight with no TARGET_URL says what to set, and why production is refused', () => {
  const r = preflight({});
  assert.equal(r.ok, false);
  assert.match(r.message, /TARGET_URL is not set/);
  assert.match(r.message, /Set TARGET_URL to a non-production target/);
  assert.match(r.message, /Why production is refused: every iteration POSTs a real loan request/);
  assert.match(r.message, /docs\/runbooks\/scaling\.md/);
});

test('preflight never suggests a production URL as an example', () => {
  for (const env of [{}, { TARGET_URL: 'https://example.invalid' }, { TARGET_URL: 'nonsense' }]) {
    const { message } = preflight(env);
    for (const line of message.split('\n').filter((l) => /^\s+TARGET_URL=/.test(l))) {
      const example = /TARGET_URL=(\S+)/.exec(line)[1];
      if (example.includes('<')) continue; // a placeholder, not a runnable URL
      assert.equal(resolveTarget({ TARGET_URL: example }).label, 'emulator', line);
    }
    assert.doesNotMatch(message, /vida-finance\.|gd5fcu677q|447766605132/);
  }
});

test('preflight refuses production and passes an emulator target', () => {
  const prod = preflight({ TARGET_URL: 'https://requestloan-gd5fcu677q-uc.a.run.app' });
  assert.equal(prod.ok, false);
  assert.match(prod.message, /is PRODUCTION/);

  const emu = preflight({ TARGET_URL: 'http://127.0.0.1:5011/demo-vida-load/us-central1' });
  assert.equal(emu.ok, true);
  assert.deepEqual(emu.target, { url: 'http://127.0.0.1:5011/demo-vida-load/us-central1', label: 'emulator' });
  assert.match(emu.message, /EMULATOR/);
});

function runPreflight(extraEnv) {
  // A minimal env: nothing from the developer's shell may supply a target.
  const env = { PATH: process.env.PATH, ...extraEnv };
  return spawnSync(process.execPath, [path.join(here, 'preflight.mjs')], { env, encoding: 'utf8' });
}

test('preflight.mjs exits 1 with the friendly message when TARGET_URL is unset', () => {
  const r = runPreflight({});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Load test not started\./);
  assert.match(r.stderr, /Set TARGET_URL to a non-production target/);
  assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace');
});

test('preflight.mjs exits 1 for production and 0 for the emulator', () => {
  assert.equal(runPreflight({ TARGET_URL: 'https://us-central1-vida-finance.cloudfunctions.net' }).status, 1);
  const ok = runPreflight({ TARGET_URL: 'http://localhost:5011/demo/us-central1' });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /EMULATOR/);
});

test('every k6 npm script runs the preflight first and carries no target of its own', () => {
  const { scripts } = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const k6Scripts = Object.entries(scripts).filter(([, cmd]) => /\bk6 run\b/.test(cmd));
  assert.deepEqual(k6Scripts.map(([name]) => name).sort(), ['load-test', 'load-test:full', 'load-test:smoke']);
  for (const [name, cmd] of k6Scripts) {
    assert.ok(cmd.startsWith('node --no-warnings tests/load/preflight.mjs && k6 run '), `${name} runs preflight before k6`);
    assert.doesNotMatch(cmd, /TARGET_URL|STAGING_URL|https?:\/\//, `${name} must not hard-code a target`);
  }
});

test('config.js no longer shows a production URL as the example target', () => {
  const config = readFileSync(path.join(here, 'config.js'), 'utf8');
  for (const m of config.matchAll(/https?:\/\/[^\s)]+/g)) {
    if (m[0].includes('<')) continue; // placeholder
    assert.equal(resolveTarget({ TARGET_URL: m[0] }).label, 'emulator', m[0]);
  }
});

test('no target → refuses (there is no default any more)', () => {
  assert.throws(() => resolveTarget({}), /TARGET_URL is not set/);
});

test('the old default URL is production and is refused without sign-off', () => {
  assert.throws(
    () => resolveTarget({ STAGING_URL: 'https://us-central1-vida-finance.cloudfunctions.net' }),
    /PRODUCTION/
  );
});

for (const url of [
  'https://vida-finance.web.app',
  'https://vida-finance.firebaseapp.com/api/health',
  'https://requestloan-vida-finance-abc123-uc.a.run.app',
  'https://payment-server-production-b9b8.up.railway.app',
  'https://underwriting-service-production.up.railway.app',
]) {
  test(`production host refused: ${url}`, () => {
    assert.throws(() => resolveTarget({ TARGET_URL: url }), /PRODUCTION/);
  });
}

test('production allowed only with the exact sign-off phrase', () => {
  const url = 'https://us-central1-vida-finance.cloudfunctions.net';
  assert.throws(() => resolveTarget({ TARGET_URL: url, LOAD_TEST_ALLOW_PRODUCTION: 'true' }), /PRODUCTION/);
  assert.deepEqual(resolveTarget({ TARGET_URL: url, LOAD_TEST_ALLOW_PRODUCTION: PRODUCTION_SIGN_OFF }), {
    url,
    label: 'production',
  });
});

test('local emulator is labelled emulator and trailing slashes are trimmed', () => {
  assert.deepEqual(resolveTarget({ TARGET_URL: 'http://127.0.0.1:5011/demo-load/us-central1/' }), {
    url: 'http://127.0.0.1:5011/demo-load/us-central1',
    label: 'emulator',
  });
  assert.equal(resolveTarget({ TARGET_URL: 'http://localhost:5001/x' }).label, 'emulator');
});

test('unknown remote host needs an explicit staging declaration', () => {
  const url = 'https://us-central1-vida-finance-staging.cloudfunctions.net';
  assert.throws(() => resolveTarget({ TARGET_URL: url }), /Unknown remote target/);
  assert.equal(resolveTarget({ TARGET_URL: url, LOAD_TEST_TARGET_ENV: 'staging' }).label, 'staging');
});

test('non-http target is rejected', () => {
  assert.throws(() => resolveTarget({ TARGET_URL: 'vida-finance' }), /not an http/);
});
