// node --test tests/load/seed/guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  EMULATOR_DEFAULT_PROJECT,
  EMULATOR_PASSWORD,
  PRODUCTION_PROJECT_IDS,
  PRODUCTION_PROJECT_NUMBER,
  SeedRefusal,
  functionsProviderLeaks,
  isFunctionsEnvFile,
  isProductionProjectId,
  parseArgs,
  resolvePassword,
  resolveSeedTarget,
} from './guard.mjs';

const EMULATOR = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' };
const CLI = fileURLToPath(new URL('./seed-load-pool.mjs', import.meta.url));
const repo = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const target = (project, env = {}, credentials = null) => resolveSeedTarget({ project }, env, credentials);

test('the hard-coded production id is the one the repo deploys to', () => {
  const firebaserc = JSON.parse(repo('.firebaserc'));
  assert.ok(PRODUCTION_PROJECT_IDS.includes(firebaserc.projects.default));
  const environment = repo('functions/src/utils/environment.ts');
  assert.ok(PRODUCTION_PROJECT_IDS.includes(/PRODUCTION_PROJECT_ID = '([^']+)'/.exec(environment)[1]));
  assert.ok(Object.isFrozen(PRODUCTION_PROJECT_IDS));
});

test('isProductionProjectId', () => {
  for (const id of ['vida-finance', ' Vida-Finance ', 'VIDA-FINANCE', 'vida-finance-prod', 'funpay-production']) {
    assert.equal(isProductionProjectId(id), true, id);
  }
  for (const id of ['vida-finance-staging', 'demo-vida-load', 'funpay-stg', '', null, undefined]) {
    assert.equal(isProductionProjectId(id), false, String(id));
  }
  // the project number names the same project to Google, and is the one in the web config
  assert.ok(repo('public-v2/src/lib/firebase.ts').includes(`messagingSenderId: '${PRODUCTION_PROJECT_NUMBER}'`));
  assert.equal(isProductionProjectId(PRODUCTION_PROJECT_NUMBER), true);
  assert.equal(isProductionProjectId(` ${PRODUCTION_PROJECT_NUMBER} `), true);
  assert.equal(isProductionProjectId(`9${PRODUCTION_PROJECT_NUMBER}`), false);
  assert.throws(() => target(PRODUCTION_PROJECT_NUMBER, EMULATOR), /Refusing/);
});

test('default is the emulator, with a demo-* project', () => {
  assert.deepEqual(target(null, EMULATOR), { mode: 'emulator', projectId: EMULATOR_DEFAULT_PROJECT });
  assert.deepEqual(target('demo-other', EMULATOR), { mode: 'emulator', projectId: 'demo-other' });
  assert.deepEqual(target(null, { ...EMULATOR, GCLOUD_PROJECT: 'demo-from-env' }), {
    mode: 'emulator',
    projectId: 'demo-from-env',
  });
});

test('production is refused everywhere it can be named — flag, env, credentials, emulator or not', () => {
  for (const env of [{}, EMULATOR]) {
    assert.throws(() => target('vida-finance', env), /PRODUCTION/);
    assert.throws(() => target(' VIDA-FINANCE ', env), /PRODUCTION/);
    assert.throws(() => target(null, { ...env, GCLOUD_PROJECT: 'vida-finance' }), /PRODUCTION/);
    assert.throws(() => target('vida-staging', { ...env, GOOGLE_CLOUD_PROJECT: 'vida-finance' }), /PRODUCTION/);
    assert.throws(() => target('vida-staging', env, 'vida-finance'), /PRODUCTION/);
  }
  assert.throws(() => target('vida-finance'), SeedRefusal);
});

test('there is no flag that lets production through', () => {
  for (const flag of ['--force', '--allow-production', '--yes', '--i-have-ops-sign-off', '--prod']) {
    assert.throws(() => parseArgs(['--project', 'vida-finance', flag]), /Unknown argument/);
  }
  // …and the sign-off phrase the k6 target guard honours means nothing here
  assert.throws(
    () => target('vida-finance', { LOAD_TEST_ALLOW_PRODUCTION: 'I-HAVE-OPS-SIGN-OFF', LOAD_TEST_TARGET_ENV: 'staging' }),
    /PRODUCTION/
  );
});

test('without an emulator, an explicit --project is mandatory', () => {
  assert.throws(() => target(null), /no --project was given/);
  // GCLOUD_PROJECT alone is not "explicit"
  assert.throws(() => target(null, { GCLOUD_PROJECT: 'vida-staging' }), /no --project was given/);
  assert.deepEqual(target('vida-staging'), { mode: 'project', projectId: 'vida-staging' });
  assert.deepEqual(target('vida-staging', {}, 'vida-staging'), { mode: 'project', projectId: 'vida-staging' });
});

test('a real run with credentials for a different project is refused', () => {
  assert.throws(() => target('vida-staging', {}, 'some-other-project'), /belongs to "some-other-project"/);
});

test('half-configured or non-loopback emulators are refused', () => {
  assert.throws(() => target(null, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }), /only one of/);
  assert.throws(() => target('vida-staging', { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }), /only one of/);
  assert.throws(
    () => target(null, { FIRESTORE_EMULATOR_HOST: 'db.example.com:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }),
    /not a loopback/
  );
  assert.throws(() => target('vida-staging', EMULATOR), /demo-\* project id/);
  assert.throws(() => target('demo-vida-load'), /emulator-only project id/);
});

test('parseArgs: defaults and validation', () => {
  assert.deepEqual(parseArgs([]), {
    count: 12500,
    employers: 250,
    project: null,
    dryRun: false,
    teardown: false,
    concurrency: 20,
    help: false,
  });
  const opts = parseArgs(['--count', '2800', '--project', 'vida-staging', '--dry-run', '--teardown']);
  assert.equal(opts.count, 2800);
  assert.equal(opts.employers, 100); // 2 blocks of 50; see pool.js employerIndexFor
  assert.equal(opts.project, 'vida-staging');
  assert.ok(opts.dryRun && opts.teardown);
  assert.equal(parseArgs(['--count', '10']).employers, 10);
  for (const bad of [['--count', '0'], ['--count', 'x'], ['--count'], ['--concurrency', '500']]) {
    assert.throws(() => parseArgs(bad), SeedRefusal, bad.join(' '));
  }
});

test('parseArgs: --employers is gone, and says why (a chosen employer count reshuffles the pool)', () => {
  for (const args of [['--employers', '5'], ['--count', '200', '--employers', '4']]) {
    assert.throws(() => parseArgs(args), (err) => err instanceof SeedRefusal && /--employers was removed/.test(err.message) && /without moving/.test(err.message));
  }
  // and no other spelling sets it
  assert.equal(parseArgs(['--count', '200']).employers, 50);
});

test('resolvePassword: emulator has a default, a real project never does', () => {
  assert.equal(resolvePassword('emulator', {}), EMULATOR_PASSWORD);
  assert.equal(resolvePassword('emulator', { LOAD_TEST_PASSWORD: 'x' }), 'x');
  assert.throws(() => resolvePassword('project', {}), /LOAD_TEST_PASSWORD/);
  assert.throws(() => resolvePassword('project', { LOAD_TEST_PASSWORD: 'short' }), /at least 16/);
  assert.throws(() => resolvePassword('project', { LOAD_TEST_PASSWORD: EMULATOR_PASSWORD }), /emulator default/);
  assert.equal(resolvePassword('project', { LOAD_TEST_PASSWORD: 'a-long-generated-secret' }), 'a-long-generated-secret');
});

// ── The CLI itself, end to end, with no emulator and no credentials ─────────

const bareEnv = { PATH: process.env.PATH, NODE_NO_WARNINGS: '1' };

test('CLI refuses production with exit 2 and never loads the Admin SDK', () => {
  for (const args of [['--project', 'vida-finance'], ['--project', 'vida-finance', '--dry-run'], ['--project', 'vida-finance', '--teardown']]) {
    const run = spawnSync(process.execPath, [CLI, ...args], { env: bareEnv, encoding: 'utf8' });
    assert.equal(run.status, 2, args.join(' '));
    assert.match(run.stderr, /PRODUCTION/);
    assert.doesNotMatch(run.stdout, /SEED DONE|TEARDOWN DONE/);
  }
});

test('CLI with no emulator and no --project refuses', () => {
  const run = spawnSync(process.execPath, [CLI], { env: bareEnv, encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /no --project was given/);
});

test('CLI --dry-run prints the plan and touches nothing (works with no credentials at all)', () => {
  const out = execFileSync(process.execPath, [CLI, '--project', 'vida-staging', '--count', '120', '--dry-run'], {
    env: bareEnv,
    encoding: 'utf8',
  });
  assert.match(out, /DRY RUN/);
  assert.match(out, /project: {3}vida-staging/);
  assert.match(out, /employees: 120 {2}\(loadtest-emp-000000 … loadtest-emp-000119\)/);
  assert.match(out, /employers: 50 /);
  assert.match(out, /--env POOL_SIZE=120/);
  assert.doesNotMatch(out, /SEED DONE/);

  const teardown = execFileSync(process.execPath, [CLI, '--project', 'vida-staging', '--teardown', '--dry-run'], {
    env: bareEnv,
    encoding: 'utf8',
  });
  assert.match(teardown, /would delete, and only these/);
  assert.doesNotMatch(teardown, /TEARDOWN DONE/);
});

test('CLI: a real project without LOAD_TEST_PASSWORD stops before any write', () => {
  const run = spawnSync(process.execPath, [CLI, '--project', 'vida-staging', '--count', '1'], { env: bareEnv, encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /LOAD_TEST_PASSWORD/);
});

test('functionsProviderLeaks: an emulated requestLoan must not inherit a real underwriting or ML service', async () => {
  const { FUNCTIONS_PROVIDER_VARS, functionsProviderLeaks } = await import('./guard.mjs');
  assert.deepEqual([...FUNCTIONS_PROVIDER_VARS], ['UNDERWRITING_SERVICE_URL', 'ML_SERVICE_URL']);

  // clean shell, no env files, or env files that do not set them
  assert.deepEqual(functionsProviderLeaks({}), []);
  assert.deepEqual(functionsProviderLeaks({ REDIS_URL: 'redis://127.0.0.1:6390', INTERNAL_SECRET: 'x', ML_SERVICE_URL: '' }), []);
  assert.deepEqual(
    functionsProviderLeaks({}, [
      { name: 'functions/.env', text: '# UNDERWRITING_SERVICE_URL=https://uw.example\nML_SERVICE_URL=\nOTHER_ML_SERVICE_URL_X=1\n' },
    ]),
    []
  );

  // exported in the shell — what `firebase emulators:exec` passes straight through
  assert.deepEqual(functionsProviderLeaks({ UNDERWRITING_SERVICE_URL: 'https://uw.example' }), [
    'UNDERWRITING_SERVICE_URL is set in the environment',
  ]);
  assert.deepEqual(functionsProviderLeaks({ ML_SERVICE_URL: 'https://ml.example' }), ['ML_SERVICE_URL is set in the environment']);

  // set in a functions/.env* file — which the emulator loads whatever the shell holds
  assert.deepEqual(
    functionsProviderLeaks({}, [
      { name: 'functions/.env', text: 'FOO=1\nUNDERWRITING_SERVICE_URL="https://uw.example"\n' },
      { name: 'functions/.env.local', text: '  export ML_SERVICE_URL=https://ml.example\n' },
    ]),
    ['UNDERWRITING_SERVICE_URL is set in functions/.env', 'ML_SERVICE_URL is set in functions/.env.local']
  );
});

test('functions/.secret.local counts as a file the emulated functions read', async () => {
  for (const name of ['.env', '.env.local', '.env.demo-vida-load', '.env.vida-finance', '.secret.local']) {
    assert.equal(isFunctionsEnvFile(name), true, name);
  }
  for (const name of ['.env.example', '.secret.local.example', '.envrc', '.eslintrc.js', 'package.json', '.secret', 'secret.local']) {
    assert.equal(isFunctionsEnvFile(name), false, name);
  }
  assert.deepEqual(
    functionsProviderLeaks({}, [{ name: 'functions/.secret.local', text: 'INTERNAL_SECRET=x\nML_SERVICE_URL=https://ml.example\n' }]),
    ['ML_SERVICE_URL is set in functions/.secret.local']
  );
  // the check script picks its files with that predicate, not with its own `.env` prefix test
  const { readFileSync } = await import('node:fs');
  const script = readFileSync(new URL('./emulator-requestloan-check.mjs', import.meta.url), 'utf8');
  assert.match(script, /readdirSync\(FUNCTIONS_DIR\)\s*\.filter\(isFunctionsEnvFile\)/);
  assert.doesNotMatch(script, /startsWith\('\.env'\)/);
});

test('the emulator requestLoan check refuses before seeding when a provider URL is set', async () => {
  const { readFileSync } = await import('node:fs');
  const script = readFileSync(new URL('./emulator-requestloan-check.mjs', import.meta.url), 'utf8');
  const refusal = script.indexOf('functionsProviderLeaks(process.env, envFiles)');
  assert.ok(refusal > 0, 'the check must call functionsProviderLeaks');
  assert.ok(refusal < script.indexOf('cli();'), 'and must do so before the first seed');
  assert.match(script.slice(refusal, script.indexOf('cli();')), /process\.exit\(2\)/);
});
