'use strict';

// Regression tests for the internal-auth fail-open.
//
// Before the fix, index.js defined the middleware inline as
//   if (req.headers['x-internal-secret'] !== process.env.INTERNAL_SECRET) -> 401
// and had no boot guard. With INTERNAL_SECRET unset, a request carrying no
// header at all compared `undefined !== undefined` — false — and every
// /internal/*, /bureau/query and /curp/validate route was open.

const path = require('path');
const { execFileSync } = require('child_process');

const { assertInternalSecret, secretMatches, requireInternal } = require('./internalAuth');

const SERVICE_DIR = path.resolve(__dirname, '..');
const SECRET = 'the-real-secret';

describe('assertInternalSecret', () => {
  test('throws when INTERNAL_SECRET is missing', () => {
    expect(() => assertInternalSecret({})).toThrow(
      /INTERNAL_SECRET is required to start vida-softcredito-adapter/,
    );
  });

  test('throws when INTERNAL_SECRET is empty', () => {
    expect(() => assertInternalSecret({ INTERNAL_SECRET: '' })).toThrow(
      /INTERNAL_SECRET is required/,
    );
  });

  test('passes when INTERNAL_SECRET is set', () => {
    expect(() => assertInternalSecret({ INTERNAL_SECRET: SECRET })).not.toThrow();
  });

  test('reads process.env by default', () => {
    const saved = process.env.INTERNAL_SECRET;
    try {
      delete process.env.INTERNAL_SECRET;
      expect(() => assertInternalSecret()).toThrow(/INTERNAL_SECRET is required/);
      process.env.INTERNAL_SECRET = SECRET;
      expect(() => assertInternalSecret()).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.INTERNAL_SECRET;
      else process.env.INTERNAL_SECRET = saved;
    }
  });
});

describe('secretMatches', () => {
  test('matches the correct secret', () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
  });

  test('rejects a wrong secret', () => {
    expect(secretMatches(SECRET, 'guess')).toBe(false);
  });

  test('rejects a missing header', () => {
    expect(secretMatches(SECRET, undefined)).toBe(false);
  });

  test('rejects an empty header', () => {
    expect(secretMatches(SECRET, '')).toBe(false);
  });

  test('an unset secret never authenticates — this is the fail-open', () => {
    expect(secretMatches(undefined, undefined)).toBe(false);
    expect(secretMatches('', '')).toBe(false);
    expect(secretMatches(undefined, 'anything')).toBe(false);
  });

  test('rejects a non-string header without throwing', () => {
    // timingSafeEqual throws on mismatched buffer lengths; a repeated header or
    // a crafted value must not turn a 401 into an unhandled 500.
    expect(() => secretMatches(SECRET, ['a', 'b'])).not.toThrow();
    expect(secretMatches(SECRET, ['a', 'b'])).toBe(false);
    expect(secretMatches(SECRET, { toString: () => SECRET })).toBe(false);
  });

  test('rejects values of a different length without throwing', () => {
    expect(secretMatches('short', 'a-considerably-longer-value')).toBe(false);
  });
});

describe('requireInternal middleware', () => {
  const savedSecret = process.env.INTERNAL_SECRET;

  function run(headers) {
    const req = { headers };
    const res = {
      statusCode: null,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    let nextCalled = false;
    requireInternal(req, res, () => { nextCalled = true; });
    return { res, nextCalled };
  }

  beforeEach(() => { process.env.INTERNAL_SECRET = SECRET; });
  afterAll(() => {
    if (savedSecret === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = savedSecret;
  });

  test('401s when the header is missing', () => {
    const { res, nextCalled } = run({});
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
    expect(nextCalled).toBe(false);
  });

  test('401s when the header is empty', () => {
    const { res, nextCalled } = run({ 'x-internal-secret': '' });
    expect(res.statusCode).toBe(401);
    expect(nextCalled).toBe(false);
  });

  test('401s when the header is wrong', () => {
    const { res, nextCalled } = run({ 'x-internal-secret': 'guess' });
    expect(res.statusCode).toBe(401);
    expect(nextCalled).toBe(false);
  });

  test('401s when INTERNAL_SECRET is unset, even with a matching empty header', () => {
    delete process.env.INTERNAL_SECRET;
    const { res, nextCalled } = run({ 'x-internal-secret': '' });
    expect(res.statusCode).toBe(401);
    expect(nextCalled).toBe(false);
  });

  test('401s when INTERNAL_SECRET is unset and no header is sent', () => {
    delete process.env.INTERNAL_SECRET;
    const { res, nextCalled } = run({});
    expect(res.statusCode).toBe(401);
    expect(nextCalled).toBe(false);
  });

  test('calls next() for the correct secret', () => {
    const { res, nextCalled } = run({ 'x-internal-secret': SECRET });
    expect(res.statusCode).toBeNull();
    expect(nextCalled).toBe(true);
  });
});

describe('index.js boot guard', () => {
  // Boot the real entrypoint in a child process — the guard has to abort
  // process start, not just log.
  function boot(secret) {
    const env = { ...process.env };
    delete env.INTERNAL_SECRET;
    delete env.FIREBASE_SERVICE_ACCOUNT;
    delete env.FIREBASE_SERVICE_ACCOUNT_B64;
    if (secret !== undefined) env.INTERNAL_SECRET = secret;
    try {
      execFileSync(process.execPath, ['-e', "require('./index.js')"], {
        cwd: SERVICE_DIR,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stderr: '' };
    } catch (err) {
      return { code: err.status, stderr: String(err.stderr || '') };
    }
  }

  test('refuses to start when INTERNAL_SECRET is unset', () => {
    const { code, stderr } = boot(undefined);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/INTERNAL_SECRET is required to start vida-softcredito-adapter/);
  });

  test('refuses to start when INTERNAL_SECRET is empty', () => {
    const { code, stderr } = boot('');
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/INTERNAL_SECRET is required to start vida-softcredito-adapter/);
  });

  test('gets past the guard when INTERNAL_SECRET is set', () => {
    // Boot still fails here — no Firebase credentials, and outside Docker the
    // shared modules can't resolve prom-client — but it must not fail on the
    // internal secret.
    const { stderr } = boot(SECRET);
    expect(stderr).not.toMatch(/INTERNAL_SECRET is required/);
  });
});
