'use strict';

// Regression tests for the boot-time INTERNAL_SECRET guard (security defect
// P1-4). Before the fix, requireInternal compared the request header against
// process.env.INTERNAL_SECRET; with the variable unset both sides were
// `undefined`, the strict-inequality check was false, and every internal
// route -- including POST /internal/repayment, a real-money route -- became
// publicly callable with no header at all. index.js now refuses to boot
// instead of serving the money path unauthenticated. This suite locks that
// guard in.

const savedEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
}

afterEach(() => {
  restoreEnv();
});

test('refuses to start when INTERNAL_SECRET is unset', () => {
  delete process.env.INTERNAL_SECRET;
  expect(() => {
    jest.isolateModules(() => {
      require('../index');
    });
  }).toThrow(/INTERNAL_SECRET is required to start vida-payment-server/);
});

test('refuses to start when INTERNAL_SECRET is an empty string', () => {
  process.env.INTERNAL_SECRET = '';
  expect(() => {
    jest.isolateModules(() => {
      require('../index');
    });
  }).toThrow(/INTERNAL_SECRET is required to start vida-payment-server/);
});

test('boots past the guard when INTERNAL_SECRET is set', () => {
  process.env.INTERNAL_SECRET = 'a-real-secret';
  process.env.FIREBASE_SERVICE_ACCOUNT = '{}';
  process.env.REDIS_URL = 'redis://127.0.0.1:6379';

  let mod;
  expect(() => {
    jest.isolateModules(() => {
      mod = require('../index');
    });
  }).not.toThrow();
  expect(mod.app).toBeDefined();
});
