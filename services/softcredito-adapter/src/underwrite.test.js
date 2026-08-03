'use strict';

// src/underwrite.js is the module services/underwriting-service's
// stage2-bureau.js cites as the reference for the SoftCrédito bureau payload
// shape ("see ../../softcredito-adapter/src/underwrite.js's header"). It had
// no test of any kind.
//
// parseBureauDecision() returns `pass: true` for anything that does not trip a
// rule. The rules are all written as "score < N", and a score that is absent,
// zero, or unreadable trips none of them -- so the absence of bureau data is
// scored the same as a clean bureau record with a good score.

jest.mock('../lib/fetchClient', () => ({ getFetch: jest.fn() }));

const { callUnderwrite, parseBureauDecision, parsePLD } = require('./underwrite');
const { getFetch } = require('../lib/fetchClient');

describe('parseBureauDecision — controls', () => {
  test('a clean record with a good score passes the auto-approve gate', () => {
    const d = parseBureauDecision({ cdc: { score: 720, diasAtraso: 0, carteraVencida: false, cuentasActivas: 3 } });
    expect(d).toMatchObject({ score: 720, escalateToStage: 3, reason: null, pass: true });
  });

  test('cartera vencida escalates to stage 5', () => {
    const d = parseBureauDecision({ cdc: { score: 720, carteraVencida: true } });
    expect(d).toMatchObject({ escalateToStage: 5, reason: 'active_default', pass: false });
  });

  test('31+ days late escalates to stage 5', () => {
    const d = parseBureauDecision({ cdc: { score: 720, diasAtraso: 45 } });
    expect(d).toMatchObject({ escalateToStage: 5, reason: 'days_late_31_plus', pass: false });
  });

  test('1-30 days late escalates to stage 4', () => {
    const d = parseBureauDecision({ cdc: { score: 720, diasAtraso: 12 } });
    expect(d).toMatchObject({ escalateToStage: 4, reason: 'days_late_1_30', pass: false });
  });

  test('a score below 400 escalates to stage 5', () => {
    const d = parseBureauDecision({ cdc: { score: 380 } });
    expect(d).toMatchObject({ score: 380, escalateToStage: 5, reason: 'score_below_400', pass: false });
  });

  test('a score of 400-599 escalates to stage 4', () => {
    const d = parseBureauDecision({ cdc: { score: 450 } });
    expect(d).toMatchObject({ score: 450, escalateToStage: 4, reason: 'score_400_599', pass: false });
  });

  test('BDC is used when CDC has no score', () => {
    const d = parseBureauDecision({ cdc: {}, bdc: { score: 380 } });
    expect(d).toMatchObject({ score: 380, escalateToStage: 5, pass: false });
  });

  test('the worse diasAtraso of the two bureaux wins', () => {
    const d = parseBureauDecision({ cdc: { score: 700, diasAtraso: 3 }, bdc: { score: 700, diasAtraso: 40 } });
    expect(d).toMatchObject({ diasAtraso: 40, escalateToStage: 5 });
  });
});

describe('parseBureauDecision — absent or unreadable data must not read as clean', () => {
  test('a score of exactly 0 is not discarded as "no score"', () => {
    // `cdc.score || bdc.score || null` treats 0 -- the worst score there is --
    // as absent.
    const d = parseBureauDecision({ cdc: { score: 0 } });
    expect(d.score).toBe(0);
  });

  test('a score of exactly 0 escalates to stage 5, like every other sub-400 score', () => {
    const d = parseBureauDecision({ cdc: { score: 0 } });
    expect(d).toMatchObject({ escalateToStage: 5, reason: 'score_below_400', pass: false });
  });

  test('a 0 in CDC is not silently replaced by a good score from BDC', () => {
    const d = parseBureauDecision({ cdc: { score: 0 }, bdc: { score: 800 } });
    expect(d.score).toBe(0);
    expect(d.pass).toBe(false);
  });

  test('an empty bureau response does not pass the auto-approve gate', () => {
    // The bureau returned a body with no cdc and no bdc block. We know nothing
    // about this applicant; the documented tree only passes on "score >= 600 +
    // clean", which this is not.
    const d = parseBureauDecision({});
    expect(d.pass).toBe(false);
  });

  test('a null/undefined response does not pass the auto-approve gate', () => {
    expect(parseBureauDecision(null).pass).toBe(false);
    expect(parseBureauDecision(undefined).pass).toBe(false);
  });

  test('a response with cdc and bdc blocks but no score in either does not pass', () => {
    const d = parseBureauDecision({ cdc: { cuentasActivas: 2 }, bdc: {} });
    expect(d.pass).toBe(false);
  });

  test('a non-numeric score does not pass the auto-approve gate', () => {
    // Every rule is a `<` comparison; "N/A" compares false against both 400
    // and 600, so an unparseable score sails through as a pass.
    expect(parseBureauDecision({ cdc: { score: 'N/A' } }).pass).toBe(false);
    expect(parseBureauDecision({ cdc: { score: 'sin historial' } }).pass).toBe(false);
  });

  test('a NaN score does not pass the auto-approve gate', () => {
    expect(parseBureauDecision({ cdc: { score: NaN } }).pass).toBe(false);
  });

  test('a non-numeric score is not reported downstream as if it were a number', () => {
    const d = parseBureauDecision({ cdc: { score: 'N/A' } });
    expect(d.score === null || typeof d.score === 'number').toBe(true);
  });

  test('a NaN diasAtraso does not read as "0 days late"', () => {
    // Math.max(NaN, 0) is NaN, and NaN >= 31 and NaN >= 1 are both false, so a
    // delinquency field we could not read is scored as no delinquency.
    const d = parseBureauDecision({ cdc: { score: 700, diasAtraso: NaN } });
    expect(d.pass).toBe(false);
  });

  test('an unreadable diasAtraso does not read as "0 days late"', () => {
    const d = parseBureauDecision({ cdc: { score: 700, diasAtraso: 'treinta y uno' } });
    expect(d.pass).toBe(false);
  });

  test('a numeric string score is still read as that number', () => {
    // Some upstream payloads quote their numbers. "380" must still be < 400.
    const d = parseBureauDecision({ cdc: { score: '380' } });
    expect(d).toMatchObject({ score: 380, escalateToStage: 5, pass: false });
  });
});

describe('callUnderwrite', () => {
  test('can actually issue a request', async () => {
    // `const fetch = require("node-fetch")` at the top of underwrite.js. Under
    // node-fetch v3 (this package's dependency, ESM-only) that require returns
    // the module NAMESPACE, not the fetch function, so every call throws
    // "fetch is not a function" before a single byte leaves the process.
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ cdc: { score: 700 } }),
    });
    getFetch.mockResolvedValue(fetchMock);

    await expect(callUnderwrite({ curp: 'GOMA900101HDFXXX01' })).resolves.toEqual({ cdc: { score: 700 } });
  });

  test('gives the request a timeout that can actually fire', async () => {
    // `timeout: 30000` in the fetch options is a node-fetch v2 option. v3
    // ignores it silently -- there is no timeout at all.
    const fetchMock = jest.fn().mockImplementation((_url, opts) => new Promise((_resolve, reject) => {
      if (opts && opts.signal) {
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }
    }));
    getFetch.mockResolvedValue(fetchMock);
    process.env.SC_HTTP_TIMEOUT_MS = '250';

    try {
      const outcome = await Promise.race([
        callUnderwrite({ curp: 'GOMA900101HDFXXX01' }).then(() => 'resolved', () => 'rejected'),
        new Promise((resolve) => setTimeout(() => resolve('HUNG'), 3000)),
      ]);
      expect(outcome).toBe('rejected');
    } finally {
      delete process.env.SC_HTTP_TIMEOUT_MS;
    }
  });
});

describe('parsePLD — controls', () => {
  test('a SAT blacklist hit is a hard reject', () => {
    expect(parsePLD({ pld: { bloqueo_lista_sat: true } })).toMatchObject({ pass: false, hardReject: true, reason: 'pld_sat_blacklist' });
  });

  test('a clean PLD block passes', () => {
    expect(parsePLD({ pld: { bloqueo_lista_sat: false, bloqueado: false } })).toMatchObject({ pass: true, hardReject: false, reason: null });
  });
});
