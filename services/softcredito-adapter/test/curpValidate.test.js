'use strict';

// POST /curp/validate — RENAPO identity validation, proxied through
// SoftCrédito. Like /bureau/query this had no behavioural test; auth.test.js
// only proved it 401s without the internal secret.
//
// The caller is functions/src/index.ts (`validateCURP`), which reads
// `result['valid'] === true` from a 2xx body. That caller has its OWN
// deliberate accept-by-format fallback for a non-2xx response, so failing
// closed here does not change the loan outcome -- it changes what this
// service *claims*. Today it claims RENAPO validated the CURP, and echoes the
// applicant's self-reported name back as `fullName`, when neither happened.

const { setBaseEnv } = require('./testEnv');
setBaseEnv();

jest.mock('../lib/scToken', () => ({
  scTokenRaw: jest.fn().mockResolvedValue({ token: 'sc-access-token', expires_in: 900 }),
  scTokenProbe: jest.fn(),
}));
jest.mock('../lib/fetchClient', () => ({
  getFetch: jest.fn(),
}));

const request = require('supertest');
const { app } = require('../index');
const admin = require('firebase-admin');
const { getFetch } = require('../lib/fetchClient');

const SECRET = process.env.INTERNAL_SECRET;
const fetchMock = jest.fn();
getFetch.mockResolvedValue(fetchMock);

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const CURP = 'GOMA900101HDFXXX01';

function postCurpValidate(body = { curp: CURP, expectedName: 'Ana García Gómez' }) {
  return request(app).post('/curp/validate').set('x-internal-secret', SECRET).send(body);
}

beforeEach(() => {
  admin.__reset();
  fetchMock.mockReset();
});

describe('POST /curp/validate — controls', () => {
  test('a successful RENAPO validation is passed through verbatim', async () => {
    const real = { valid: true, fullName: 'ANA GARCIA GOMEZ', dateOfBirth: '1990-01-01', gender: 'F', matchesExpectedName: true };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, real));

    const res = await postCurpValidate();

    expect(res.status).toBe(200);
    expect(res.body).toEqual(real);
  });

  test('a RENAPO answer of "this CURP is not valid" is passed through as a 200', async () => {
    // RENAPO was reached and answered. "Not valid" is a fact about the CURP,
    // not about our connectivity, and must stay a 200 with valid:false.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { valid: false, reason: 'not_found' }));

    const res = await postCurpValidate();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false, reason: 'not_found' });
  });

  test('400s when curp is missing, and never calls upstream', async () => {
    const res = await postCurpValidate({ expectedName: 'Ana' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'CURP required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /curp/validate — upstream misbehaves', () => {
  test.each([
    ['unreachable', () => fetchMock.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))],
    ['503', () => fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: 'maintenance' }))],
    ['500', () => fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: 'internal' }))],
    ['malformed JSON', () => fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } })],
  ])('%s does not come back as a successful validation', async (_label, arrange) => {
    arrange();

    const res = await postCurpValidate();

    expect(res.body.valid).not.toBe(true);
  });

  test('an unreachable RENAPO does not echo the self-reported name back as a confirmed one', async () => {
    // `fullName` on this response means "the name RENAPO holds for this CURP".
    // Returning the applicant's own claimed name in that field turns an
    // unverified claim into an apparently-verified one.
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));

    const res = await postCurpValidate({ curp: CURP, expectedName: 'Ana García Gómez' });

    expect(res.body.fullName).not.toBe('Ana García Gómez');
  });

  test("an upstream error echoing the applicant's CURP does not put it in our response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(422, { error_code: 'BAD_SUBJECT', curp: CURP, nombre: 'ANA GARCIA GOMEZ' }));

    const res = await postCurpValidate();

    expect(JSON.stringify(res.body)).not.toContain(CURP);
    expect(JSON.stringify(res.body)).not.toContain('ANA GARCIA GOMEZ');
  });
});
