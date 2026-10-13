// node --test tests/load/target.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveTarget, PRODUCTION_SIGN_OFF } from './target.js';

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
