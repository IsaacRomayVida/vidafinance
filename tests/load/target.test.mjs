// node --test tests/load/target.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveTarget,
  resolveProfile,
  preflight,
  productionIdentifiers,
  PRODUCTION_PROJECT_ID,
  PRODUCTION_PROJECT_NUMBER,
  PRODUCTION_RUN_HASH,
  PRODUCTION_SIGN_OFF,
  PRODUCTION_WEB_API_KEY,
} from './target.js';

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
  // Asserted against the EXPORTED constants: editing one of them (or the web
  // config) without the other fails here, which two literals in a test never did.
  const firebaseConfig = readFileSync(path.join(repoRoot, 'public-v2/src/lib/firebase.ts'), 'utf8');
  assert.ok(firebaseConfig.includes(`messagingSenderId: '${PRODUCTION_PROJECT_NUMBER}'`), 'PRODUCTION_PROJECT_NUMBER is not the web config messagingSenderId');
  assert.ok(firebaseConfig.includes(`appId: '1:${PRODUCTION_PROJECT_NUMBER}:web:`), 'PRODUCTION_PROJECT_NUMBER is not in the web config appId');
  assert.ok(firebaseConfig.includes(`projectId: '${PRODUCTION_PROJECT_ID}'`), 'PRODUCTION_PROJECT_ID is not the web config projectId');
  assert.ok(firebaseConfig.includes(`apiKey: '${PRODUCTION_WEB_API_KEY}'`), 'PRODUCTION_WEB_API_KEY is not the web config apiKey');
  assert.equal(JSON.parse(readFileSync(path.join(repoRoot, '.firebaserc'), 'utf8')).projects.default, PRODUCTION_PROJECT_ID);
  // the hash has one in-tree witness: the live API host the e2e script probes
  assert.ok(readFileSync(path.join(repoRoot, 'e2e-test-v18.mjs'), 'utf8').includes(`https://api-${PRODUCTION_RUN_HASH}-uc.a.run.app`));

  // …and the guard really is built from them
  assert.throws(() => resolveTarget({ TARGET_URL: `https://x-${PRODUCTION_RUN_HASH}-uc.a.run.app` }), /PRODUCTION/);
  assert.throws(() => resolveTarget({ TARGET_URL: `https://x-${PRODUCTION_PROJECT_NUMBER}.us-central1.run.app` }), /PRODUCTION/);
  assert.throws(() => resolveTarget({ TARGET_URL: `https://us-central1-${PRODUCTION_PROJECT_ID}.cloudfunctions.net` }), /PRODUCTION/);
});

test('a Cloud Run service that is merely NAMED …-vida-finance is not production (Cloud Run hosts never carry the project id)', () => {
  // The pattern that matched this was dead weight: production's hosts are
  // recognised by hash and project number, both tested above.
  const url = 'https://requestloan-vida-finance-abc123-uc.a.run.app';
  assert.throws(() => resolveTarget({ TARGET_URL: url }), /Unknown remote target .*Cloud Run host does not name its project/);
  assert.equal(resolveTarget({ TARGET_URL: url, LOAD_TEST_TARGET_ENV: 'staging' }).label, 'staging');
});

test('productionIdentifiers names each production value found in the Firebase variables', () => {
  assert.deepEqual(productionIdentifiers({}), []);
  assert.deepEqual(productionIdentifiers({ FIREBASE_PROJECT_ID: 'vida-staging', FIREBASE_APP_ID: '1:123:web:abc', FIREBASE_API_KEY: 'k' }), []);
  assert.equal(
    productionIdentifiers({
      FIREBASE_PROJECT_ID: PRODUCTION_PROJECT_ID,
      FIREBASE_APP_ID: `1:${PRODUCTION_PROJECT_NUMBER}:web:abc`,
      FIREBASE_API_KEY: PRODUCTION_WEB_API_KEY,
    }).length,
    3
  );
  // the project number only counts in its own field of the app id
  assert.deepEqual(productionIdentifiers({ FIREBASE_APP_ID: `1:9${PRODUCTION_PROJECT_NUMBER}:web:abc` }), []);
});

test('FIREBASE_PROJECT_ID set to the production project NUMBER is production (Google takes the number in place of the id)', () => {
  // /v1/projects/447766605132/apps/…:exchangeDebugToken is the production project
  const found = productionIdentifiers({ FIREBASE_PROJECT_ID: PRODUCTION_PROJECT_NUMBER, FIREBASE_APP_ID: '1:1:web:x', FIREBASE_API_KEY: 'k' });
  assert.equal(found.length, 1);
  assert.match(found[0], /^FIREBASE_PROJECT_ID=447766605132 is the PRODUCTION project/);
  // padded or quoted, it is refused before it is compared (see the shape test below)
  for (const value of [` ${PRODUCTION_PROJECT_NUMBER} `, `"${PRODUCTION_PROJECT_NUMBER}"`]) {
    const malformed = productionIdentifiers({ FIREBASE_PROJECT_ID: value, FIREBASE_APP_ID: '1:1:web:x', FIREBASE_API_KEY: 'k' });
    assert.equal(malformed.length, 1, value);
    assert.match(malformed[0], /is not a Firebase project id/);
  }
  // some other project's number is not
  assert.deepEqual(productionIdentifiers({ FIREBASE_PROJECT_ID: `9${PRODUCTION_PROJECT_NUMBER}` }), []);
  assert.deepEqual(productionIdentifiers({ FIREBASE_PROJECT_ID: '123456789012' }), []);
  // and an emulator started under the number is refused like one started under the id
  assert.throws(() => resolveTarget({ TARGET_URL: `http://127.0.0.1:5001/${PRODUCTION_PROJECT_NUMBER}/us-central1` }), /PRODUCTION/);
});

test('a quoted or padded copy of a production value is still that value', () => {
  assert.equal(productionIdentifiers({ FIREBASE_API_KEY: `"${PRODUCTION_WEB_API_KEY}"` }).length, 1);
  assert.equal(productionIdentifiers({ FIREBASE_API_KEY: ` '${PRODUCTION_WEB_API_KEY}' ` }).length, 1);
  assert.equal(productionIdentifiers({ FIREBASE_PROJECT_ID: `'${PRODUCTION_PROJECT_ID}'` }).length, 1);
  assert.equal(productionIdentifiers({ FIREBASE_APP_ID: `"1:${PRODUCTION_PROJECT_NUMBER}:web:abc"` }).length, 1);
  assert.deepEqual(productionIdentifiers({ FIREBASE_API_KEY: '"AIzaSyNotTheProductionKey"' }), []);
});

test('FIREBASE_PROJECT_ID is shape-checked (^[a-z0-9-]+$) before it is compared with production or used', () => {
  // the values a REST path or a careless shell would turn into production — or into somewhere else
  for (const value of [
    'vida%2Dfinance', // percent-decoded by the server: vida-finance
    '%76ida-finance',
    'vida-staging/../vida-finance',
    'vida-staging/../../projects/447766605132',
    'vida-staging?key=x',
    'vida-staging#',
    '"vida-staging"',
    ' vida-staging',
    'Vida-Staging',
    'vida_staging',
    'vida.staging',
    'vida-staging\n',
    'vida-ſtaging', // non-ASCII
  ]) {
    const found = productionIdentifiers({ FIREBASE_PROJECT_ID: value });
    assert.equal(found.length, 1, value);
    assert.match(found[0], /^FIREBASE_PROJECT_ID=".*" is not a Firebase project id \(lower-case letters, digits and hyphens only/, value);
  }
  // well-formed non-production ids and numbers pass; well-formed production ones are still production
  for (const value of ['vida-staging', 'demo-vida-load', 'funpay-load-1', '123456789012']) {
    assert.deepEqual(productionIdentifiers({ FIREBASE_PROJECT_ID: value }), [], value);
  }
  for (const value of [PRODUCTION_PROJECT_ID, PRODUCTION_PROJECT_NUMBER, 'vida-prod-eu']) {
    assert.match(productionIdentifiers({ FIREBASE_PROJECT_ID: value })[0], /is the PRODUCTION project/, value);
  }
});

test('PROFILE is smoke, full, or unset — nothing else runs', () => {
  assert.equal(resolveProfile({}), 'full');
  assert.equal(resolveProfile({ PROFILE: '' }), 'full');
  assert.equal(resolveProfile({ PROFILE: 'full' }), 'full');
  assert.equal(resolveProfile({ PROFILE: 'smoke' }), 'smoke');
  // these used to run the two-hour full ramp while the report called it something else
  for (const PROFILE of ['Full', 'Smoke', 'SMOKE', 'ramp', 'smoke ', 'quick']) {
    assert.throws(() => resolveProfile({ PROFILE }), /Unknown PROFILE=.*PROFILE=smoke .* or PROFILE=full/, PROFILE);
  }
});

test('an emulator URL that names the production project is refused (its functions would reach production data)', () => {
  for (const url of [
    'http://127.0.0.1:5001/vida-finance/us-central1',
    'http://localhost:5001/Vida-Finance/us-central1/',
    'http://[::1]:5001/vida-finance',
  ]) {
    assert.throws(() => resolveTarget({ TARGET_URL: url }), /emulator URL names the project .*PRODUCTION.*demo-\*/, url);
    assert.throws(() => resolveTarget({ TARGET_URL: url, LOAD_TEST_ALLOW_PRODUCTION: PRODUCTION_SIGN_OFF }), /PRODUCTION/, url);
  }
  assert.equal(resolveTarget({ TARGET_URL: 'http://127.0.0.1:5001/demo-vida-load/us-central1' }).label, 'emulator');
  assert.equal(resolveTarget({ TARGET_URL: 'http://127.0.0.1:5001' }).label, 'emulator');
});

test('the production project is found in an emulator URL however the path is written', () => {
  for (const url of [
    'http://127.0.0.1:5001//vida-finance/us-central1', // empty first segment
    'http://127.0.0.1:5001/x/../vida-finance/us-central1', // dot segments
    'http://127.0.0.1:5001/./vida-finance/us-central1',
    'http://127.0.0.1:5001/%76ida-finance/us-central1', // percent-encoded
    'http://127.0.0.1:5001/%56IDA-FINANCE/us-central1',
    'http://localhost:5001/demo-x/../funpay-prod/us-central1',
  ]) {
    assert.throws(() => resolveTarget({ TARGET_URL: url }), /emulator URL names the project .*PRODUCTION/, url);
  }
  // a malformed escape does not crash the guard, and an honest path still passes
  assert.equal(resolveTarget({ TARGET_URL: 'http://127.0.0.1:5001/demo-%zz/us-central1' }).label, 'emulator');
  assert.equal(resolveTarget({ TARGET_URL: 'http://127.0.0.1:5001//demo-vida-load/us-central1' }).label, 'emulator');
});

test('a raw address other than 127.0.0.1 / [::1] is refused: it may be this machine, without the emulator checks', () => {
  for (const url of [
    'http://0.0.0.0:5001/vida-finance/us-central1',
    'http://127.1:5001/vida-finance/us-central1',
    'http://127.0.0.2:5001/demo-vida-load/us-central1',
    'http://2130706433:5001/vida-finance/us-central1',
    'http://0x7f.0.0.1:5001/vida-finance/us-central1',
    'http://[::ffff:127.0.0.1]:5001/vida-finance/us-central1',
    'https://203.0.113.7/us-central1',
  ]) {
    assert.throws(() => resolveTarget({ TARGET_URL: url }), /is a raw address/, url);
    assert.throws(() => resolveTarget({ TARGET_URL: url, LOAD_TEST_TARGET_ENV: 'staging' }), /is a raw address/, url);
  }
  // host names made of hex-looking letters are host names
  assert.equal(resolveTarget({ TARGET_URL: 'https://abc.de/x', LOAD_TEST_TARGET_ENV: 'staging' }).label, 'staging');
  assert.equal(resolveTarget({ TARGET_URL: 'https://us-central1-123456.cloudfunctions.net', LOAD_TEST_TARGET_ENV: 'staging' }).label, 'staging');
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
  // `npm run load-test -- --env TARGET_URL=…` reaches k6 but not this check
  assert.match(r.message, /as a SHELL variable in front of the npm script/);
  assert.match(r.message, /`k6 run --env TARGET_URL=…` is read by k6 only; this check runs before k6 and does not see it/);
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

for (const url of [
  'https://localhost:x@us-central1-vida-finance.cloudfunctions.net',
  'http://127.0.0.1@us-central1-vida-finance.cloudfunctions.net/x',
]) {
  test(`a URL with userinfo is refused, never read as its fake local host: ${url}`, () => {
    assert.throws(() => resolveTarget({ TARGET_URL: url }));
    assert.throws(() => resolveTarget({ TARGET_URL: url, LOAD_TEST_TARGET_ENV: 'staging' }));
  });
}

for (const url of [
  'https://api-gd5fcu677q-uc.a.run.app.',
  'https://us-central1-vida-finance.cloudfunctions.net./x',
]) {
  test(`a trailing-dot production host is still production: ${url}`, () => {
    assert.throws(() => resolveTarget({ TARGET_URL: url, LOAD_TEST_TARGET_ENV: 'staging' }));
  });
}

test('ports and IPv6 loopback still resolve as the emulator', () => {
  assert.equal(resolveTarget({ TARGET_URL: 'http://127.0.0.1:5001/demo/us-central1' }).label, 'emulator');
  assert.equal(resolveTarget({ TARGET_URL: 'http://[::1]:5001/demo/us-central1' }).label, 'emulator');
});

/* ── the runbook says what the guard does ─────────────────────────────────── */

test('the runbook production row names the Gen-2 run.app forms and the npm preflight', () => {
  const runbook = readFileSync(path.join(repoRoot, 'docs/runbooks/scaling.md'), 'utf8');
  const row = runbook.split('\n').find((line) => line.startsWith('| production'));
  assert.ok(row, 'the load-test target table has a production row');
  assert.ok(row.includes(`<service>-${PRODUCTION_RUN_HASH}-<region code>.a.run.app`), 'hash form');
  assert.ok(row.includes(`<service>-${PRODUCTION_PROJECT_NUMBER}.<region>.run.app`), 'project-number form');
  assert.match(row, /`npm run load-test\*` refuse one step earlier: `tests\/load\/preflight\.mjs`/);
  // the examples in that row really are refused
  for (const [, host] of row.matchAll(/e\.g\. `([a-z0-9.-]+\.run\.app)`/g)) {
    assert.throws(() => resolveTarget({ TARGET_URL: `https://${host}` }), /PRODUCTION/, host);
  }
  assert.equal([...row.matchAll(/e\.g\. `([a-z0-9.-]+\.run\.app)`/g)].length, 2);
  // and the shell-variable caveat of the preflight is written down next to it
  assert.match(runbook, /The preflight sees `TARGET_URL`\s+only as a \*\*shell variable\*\*/);
});

test('the "no project id containing prod" rule is in step H1, where the project is created', () => {
  const runbook = readFileSync(path.join(repoRoot, 'docs/runbooks/scaling.md'), 'utf8');
  const h1 = runbook.slice(runbook.indexOf('**H1. A non-production target.**'), runbook.indexOf('**H2. An App Check debug token'));
  assert.ok(h1.length > 200, 'H1 not found');
  assert.match(h1, /whose project id does not contain `prod`\*\*/);
  assert.match(h1, /a\s+project id cannot be changed afterwards/);
  // the rule it describes is the one both guards apply
  for (const id of ['vida-prod-test', 'funpay-preprod']) {
    assert.ok(h1.includes(`\`${id}\``), id);
    assert.equal(productionIdentifiers({ FIREBASE_PROJECT_ID: id }).length, 1, id);
  }
});
