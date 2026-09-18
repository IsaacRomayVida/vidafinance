'use strict';

// What this file is defending: a rotation of INTERNAL_SECRET that takes 401s
// with it. The accepted set has to widen to two values while the change rolls
// across the services, then narrow back — and at no point may it widen to
// "anything", which is what an unset secret used to mean before the boot
// guards.

const {
  acceptedSecrets,
  assertInternalSecret,
  presentedSecretAccepted,
  requireInternal,
  secretMatches,
} = require('./internal-secret');

const OLD = 'old-internal-secret-value';
const NEW = 'new-internal-secret-value';

describe('acceptedSecrets', () => {
  it('is just INTERNAL_SECRET when no rotation is in flight', () => {
    expect(acceptedSecrets({ INTERNAL_SECRET: OLD })).toEqual([OLD]);
  });

  it('is both values while a rotation is in flight', () => {
    expect(acceptedSecrets({ INTERNAL_SECRET: OLD, INTERNAL_SECRET_ALT: NEW })).toEqual([OLD, NEW]);
  });

  it('drops empty and non-string values rather than accepting them', () => {
    expect(acceptedSecrets({ INTERNAL_SECRET: '', INTERNAL_SECRET_ALT: undefined })).toEqual([]);
    expect(acceptedSecrets({ INTERNAL_SECRET: OLD, INTERNAL_SECRET_ALT: '' })).toEqual([OLD]);
  });
});

describe('presentedSecretAccepted', () => {
  it('accepts the current secret', () => {
    expect(presentedSecretAccepted(OLD, { INTERNAL_SECRET: OLD })).toBe(true);
  });

  it('rejects the new secret before the rotation starts', () => {
    expect(presentedSecretAccepted(NEW, { INTERNAL_SECRET: OLD })).toBe(false);
  });

  // The whole point: mid-rotation, callers on either value get through.
  it('accepts both values mid-rotation, whichever way round they are', () => {
    const widened = { INTERNAL_SECRET: OLD, INTERNAL_SECRET_ALT: NEW };
    expect(presentedSecretAccepted(OLD, widened)).toBe(true);
    expect(presentedSecretAccepted(NEW, widened)).toBe(true);

    const flipped = { INTERNAL_SECRET: NEW, INTERNAL_SECRET_ALT: OLD };
    expect(presentedSecretAccepted(OLD, flipped)).toBe(true);
    expect(presentedSecretAccepted(NEW, flipped)).toBe(true);
  });

  it('rejects the old secret once the rotation is finished', () => {
    expect(presentedSecretAccepted(OLD, { INTERNAL_SECRET: NEW })).toBe(false);
  });

  // Fail closed. With nothing configured the accepted set is empty, so every
  // presented value — including none at all — is rejected.
  it('rejects everything when no secret is configured', () => {
    expect(presentedSecretAccepted(OLD, {})).toBe(false);
    expect(presentedSecretAccepted('', {})).toBe(false);
    expect(presentedSecretAccepted(undefined, {})).toBe(false);
  });

  it('rejects a header that is not a string', () => {
    const env = { INTERNAL_SECRET: OLD };
    expect(presentedSecretAccepted(['a', 'b'], env)).toBe(false);
    expect(presentedSecretAccepted({ toString: () => OLD }, env)).toBe(false);
    expect(presentedSecretAccepted(undefined, env)).toBe(false);
  });

  it('does not throw when the presented value differs in length', () => {
    expect(() => presentedSecretAccepted('short', { INTERNAL_SECRET: OLD })).not.toThrow();
    expect(presentedSecretAccepted('short', { INTERNAL_SECRET: OLD })).toBe(false);
  });
});

describe('secretMatches', () => {
  it('matches only the exact value', () => {
    expect(secretMatches(OLD, OLD)).toBe(true);
    expect(secretMatches(OLD, `${OLD}x`)).toBe(false);
    expect(secretMatches(OLD, OLD.slice(0, -1))).toBe(false);
  });

  it('never matches on empty or missing values', () => {
    expect(secretMatches('', '')).toBe(false);
    expect(secretMatches(OLD, '')).toBe(false);
    expect(secretMatches(undefined, undefined)).toBe(false);
  });
});

describe('assertInternalSecret', () => {
  it('lets a configured service boot', () => {
    expect(() => assertInternalSecret('vida-test-service', { INTERNAL_SECRET: OLD })).not.toThrow();
  });

  it('refuses to boot without a secret, naming the service', () => {
    expect(() => assertInternalSecret('vida-test-service', {})).toThrow(
      'INTERNAL_SECRET is required to start vida-test-service',
    );
  });

  // ALT alone is not a configuration: nothing would be sending it.
  it('refuses to boot on INTERNAL_SECRET_ALT alone', () => {
    expect(() => assertInternalSecret('vida-test-service', { INTERNAL_SECRET_ALT: NEW })).toThrow();
  });
});

describe('requireInternal', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  function run(headers) {
    const res = {
      statusCode: null,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    let nextCalled = false;
    requireInternal({ headers }, res, () => { nextCalled = true; });
    return { res, nextCalled };
  }

  it('calls next() on either accepted value', () => {
    process.env.INTERNAL_SECRET = OLD;
    process.env.INTERNAL_SECRET_ALT = NEW;
    expect(run({ 'x-internal-secret': OLD }).nextCalled).toBe(true);
    expect(run({ 'x-internal-secret': NEW }).nextCalled).toBe(true);
  });

  it('401s on a wrong value, a missing header and an empty one', () => {
    process.env.INTERNAL_SECRET = OLD;
    delete process.env.INTERNAL_SECRET_ALT;
    for (const headers of [{ 'x-internal-secret': 'guess' }, {}, { 'x-internal-secret': '' }]) {
      const { res, nextCalled } = run(headers);
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: 'Unauthorized' });
    }
  });
});
