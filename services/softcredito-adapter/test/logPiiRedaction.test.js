'use strict';

// Server-side logs are allowed to carry more detail than an HTTP response —
// that is the whole point of having them — but "more detail" is not "the raw
// upstream body". scCall() puts the upstream response body into err.message,
// and the bureau/CURP bodies quote the CURP and full name they were queried
// with, so any `log.warn({ error: err.message })` on those paths writes a
// national ID and a name into the log stream in clear.
//
// The rule this file pins: identifiers reaching the logger are hashed, not
// printed and not silently dropped — an operator can still correlate two
// occurrences of the same CURP without being able to read it.

jest.mock('../../shared/metrics', () => {
  const registry = {
    _metrics: new Map(),
    getSingleMetric(name) { return this._metrics.get(name); },
    registerMetric(metric) { this._metrics.set(metric.name, metric); },
    getMetricsAsArray() { return Array.from(this._metrics.values()); },
  };
  return { register: registry };
});

const { withBureauFallback } = require('../lib/bureauFallback');
const { redactPii, hashForLog } = require('../lib/piiRedact');

const CURP      = 'GAHA850315MDFRRN08';
const FULL_NAME = 'Ana Gabriela García Hernández';
const CLABE     = '012180012345678901';
const RFC       = 'TVI010101AB1';
const EMAIL     = 'ana.garcia@ejemplo.mx';

// Exactly what scCall() throws on a bureau validation rejection.
function scCallError() {
  const body = {
    error_code: 'BUREAU_VALIDATION',
    message: `curp ${CURP} / fullName ${FULL_NAME} rejected`,
    curp: CURP,
    fullName: FULL_NAME,
  };
  const err = new Error('SC API /bureau/query: ' + JSON.stringify(body));
  err.status = 400;
  return err;
}

function fakeLog() {
  const calls = [];
  return { calls, warn: (obj, msg) => calls.push({ obj, msg }) };
}

describe('withBureauFallback — the failure log must not carry the upstream body', () => {
  test.each(['optimistic', 'pessimistic'])(
    'LEAK: in %s mode the warn log contains no CURP and no full name',
    async (mode) => {
      const log = fakeLog();

      const result = await withBureauFallback({
        mode,
        log,
        liveFn: async () => { throw scCallError(); },
      });

      expect(log.calls).toHaveLength(1);
      const serialised = JSON.stringify(log.calls[0].obj);
      expect(serialised).not.toContain(CURP);
      expect(serialised).not.toContain(FULL_NAME);

      // CONTROL: the fallback still happened and is still marked as synthetic.
      expect(result._fallback.mode).toBe(mode);
      expect(result.manualReviewRequired).toBe(true);
    },
  );

  test('CONTROL: the classified reason is still logged, so the failure is still diagnosable', async () => {
    const log = fakeLog();

    await withBureauFallback({
      mode: 'optimistic',
      log,
      liveFn: async () => { throw scCallError(); },
    });

    expect(log.calls[0].obj.reason).toBe('upstream_error_code');
    expect(log.calls[0].obj.mode).toBe('optimistic');
  });

  test('CONTROL: live mode still propagates the error untouched to the caller', async () => {
    // The route handler needs err.status to classify; nothing here may swallow it.
    await expect(withBureauFallback({
      mode: 'live',
      log: fakeLog(),
      liveFn: async () => { throw scCallError(); },
    })).rejects.toMatchObject({ status: 400 });
  });
});

describe('redactPii', () => {
  test('hashes values under PII-named keys instead of dropping them', () => {
    const out = redactPii({ curp: CURP, fullName: FULL_NAME, rfc: RFC, contactEmail: EMAIL });

    expect(out.curp).toBe(hashForLog(CURP));
    expect(out.fullName).toBe(hashForLog(FULL_NAME));
    expect(out.rfc).toBe(hashForLog(RFC));
    expect(out.contactEmail).toBe(hashForLog(EMAIL));

    // Hashed, not dropped: the key survives so the shape stays readable, and
    // the same input hashes the same way so occurrences can be correlated.
    expect(out.curp).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(redactPii({ curp: CURP }).curp).toBe(out.curp);
    expect(redactPii({ curp: 'DIFFERENT8503150MDFRR' }).curp).not.toBe(out.curp);
  });

  test('scrubs identifier patterns out of free text under any key', () => {
    const out = redactPii({ message: `curp ${CURP} clabe ${CLABE} rfc ${RFC} mail ${EMAIL}` });

    expect(out.message).not.toContain(CURP);
    expect(out.message).not.toContain(CLABE);
    expect(out.message).not.toContain(EMAIL);
    // CONTROL: the surrounding prose survives, so the message stays useful.
    expect(out.message).toContain('curp');
    expect(out.message).toContain('clabe');
  });

  test('walks nested objects and arrays', () => {
    const out = redactPii({ upstream: { body: { applicants: [{ curp: CURP, name: FULL_NAME }] } } });

    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain(CURP);
    expect(serialised).not.toContain(FULL_NAME);
  });

  test('CONTROL: leaves non-PII fields untouched', () => {
    const out = redactPii({
      reason: 'upstream_error_code',
      upstreamStatus: 502,
      route: '/internal/disburse',
      loanId: 'loan_1',
      amount: 5000,
      ok: false,
      nothing: null,
    });

    expect(out).toEqual({
      reason: 'upstream_error_code',
      upstreamStatus: 502,
      route: '/internal/disburse',
      loanId: 'loan_1',
      amount: 5000,
      ok: false,
      nothing: null,
    });
  });

  test('CONTROL: tolerates cycles and does not recurse without bound', () => {
    const cyclic = { reason: 'x' };
    cyclic.self = cyclic;

    expect(() => redactPii(cyclic)).not.toThrow();
    expect(redactPii(cyclic).reason).toBe('x');
  });
});
