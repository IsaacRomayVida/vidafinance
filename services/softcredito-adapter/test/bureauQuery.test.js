'use strict';

// POST /bureau/query — the surface that supplies the credit-bureau data
// underwriting decides on. Until now it had no behavioural test at all: the
// only coverage was test/auth.test.js proving it 401s without the internal
// secret, and lib/bureauFallback.test.js proving the *non-live* BUREAU_MODE
// synthesizers work. Nothing exercised the default (`live`) mode, which is
// what production runs, and nothing exercised what the caller receives when
// the bureau misbehaves.
//
// The caller is services/underwriting-service/src/stages/stage2-bureau.js
// (`fetchBureauScore`). It detects a failed bureau read in exactly one way:
//
//     if (!res.ok) throw new Error(`Bureau query ${res.status}`);
//
// ...whose catch sets `{ score: 500, hasBureauRecord: false, skipped: true }`.
// It does NOT read the `error` field this route puts in its 200 body, and the
// `hasBureauRecord` key it reads from a 2xx body is `has_bureau_record`
// (snake_case), which this route never emits — so on a 2xx it falls through to
// `?? true`. A 200 is therefore taken as a real, successfully-read bureau
// record no matter what is in the body.

const { setBaseEnv } = require('./testEnv');
setBaseEnv();

jest.mock('../lib/scToken', () => ({
  scTokenRaw: jest.fn().mockResolvedValue({ token: 'sc-access-token', expires_in: 900 }),
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
const VALID_BODY = {
  curp: CURP,
  fullName: 'Ana García Gómez',
  dateOfBirth: '1990-01-01',
  rfc: 'GOMA900101AB1',
};

function postBureauQuery(body = VALID_BODY) {
  return request(app).post('/bureau/query').set('x-internal-secret', SECRET).send(body);
}

beforeEach(() => {
  admin.__reset();
  fetchMock.mockReset();
});

// ── Controls ────────────────────────────────────────────────────────────────
// These pin behaviour that is correct today and must stay correct. They pass
// both before and after the fix; they are what makes the red tests below
// evidence of a real defect rather than of a broken harness.

describe('POST /bureau/query — controls', () => {
  test('a successful bureau read is passed through to the caller verbatim', async () => {
    const real = {
      hasBureauRecord: true,
      score: 712,
      activeDefaults: 0,
      competitorLoans: 1,
      cuentas: [{ otorgante: 'BANCO X' }],
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, real));

    const res = await postBureauQuery();

    expect(res.status).toBe(200);
    expect(res.body).toEqual(real);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://sc.test/api/bureau/query');
    expect(JSON.parse(opts.body)).toEqual({
      curp: CURP,
      fullName: VALID_BODY.fullName,
      dateOfBirth: VALID_BODY.dateOfBirth,
      rfc: VALID_BODY.rfc,
    });
  });

  test('a genuine thin-file bureau answer (no record on file) is passed through as a 200', async () => {
    // A real applicant with no credit history. The bureau WAS reached and DID
    // answer; "no record" is a fact about the applicant, not about our
    // connectivity, and must stay a 200.
    const thinFile = { hasBureauRecord: false, score: null, activeDefaults: 0, competitorLoans: 0 };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, thinFile));

    const res = await postBureauQuery();

    expect(res.status).toBe(200);
    expect(res.body).toEqual(thinFile);
  });

  test.each([
    ['curp', { ...VALID_BODY, curp: undefined }],
    ['fullName', { ...VALID_BODY, fullName: undefined }],
    ['dateOfBirth', { ...VALID_BODY, dateOfBirth: undefined }],
  ])('400s when %s is missing, and never queries the bureau', async (_field, body) => {
    const res = await postBureauQuery(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing required fields: curp, fullName, dateOfBirth' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── A failed bureau read must not look like a successful one ────────────────

describe('POST /bureau/query — the bureau misbehaves', () => {
  test.each([
    ['unreachable (ECONNREFUSED)', () => fetchMock.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' }))],
    ['DNS failure (ENOTFOUND)', () => fetchMock.mockRejectedValueOnce(Object.assign(new Error('getaddrinfo ENOTFOUND sc.test'), { code: 'ENOTFOUND' }))],
    ['500 from the bureau', () => fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: 'internal' }))],
    ['503 from the bureau', () => fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: 'maintenance' }))],
    ['429 rate limit', () => fetchMock.mockResolvedValueOnce(jsonResponse(429, { error: 'slow down' }))],
    ['401 (our credentials rejected)', () => fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'unauthorized' }))],
    ['malformed JSON body', () => fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); } })],
    ['empty body', () => fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } })],
  ])('%s is reported to the caller as a failure, not as a 2xx bureau record', async (_label, arrange) => {
    arrange();

    const res = await postBureauQuery();

    // `res.ok` false is the ONLY failure signal stage2-bureau.js looks at.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test('an unreachable bureau is distinguishable from a real "no record on file" answer', async () => {
    // This is the defect in its sharpest form. Left: the bureau was never
    // reached. Right: the bureau answered and said the applicant is a thin
    // file. Underwriting must be able to tell these apart -- the first means
    // "we do not know", the second means "we know, and there is nothing".
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const unreachable = await postBureauQuery();

    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      hasBureauRecord: false, score: 500, activeDefaults: 0, competitorLoans: 0,
    }));
    const thinFile = await postBureauQuery();

    expect(thinFile.status).toBe(200);
    expect(unreachable.status).not.toBe(thinFile.status);
  });

  test('an unreachable bureau does not hand underwriting a score at all', async () => {
    // A number in the `score` field is a claim about the applicant. When the
    // bureau was never reached we have no such claim to make, and inventing
    // one that reads as mid-range is worse than sending nothing.
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));

    const res = await postBureauQuery();

    expect(res.body.score).toBeUndefined();
  });
});

// ── Applicant PII must not leak out of the failure path ─────────────────────

describe('POST /bureau/query — PII on the failure path', () => {
  test("an upstream error that echoes the applicant's CURP does not put it in our response", async () => {
    // Bureau validation errors routinely echo the queried subject back. That
    // body is currently spliced into an Error message by scCall() and handed
    // straight to the caller (and to log.warn) verbatim.
    fetchMock.mockResolvedValueOnce(jsonResponse(422, {
      error_code: 'INVALID_SUBJECT',
      curp: CURP,
      nombre: 'ANA GARCIA GOMEZ',
      message: 'CURP no encontrada',
    }));

    const res = await postBureauQuery();

    expect(JSON.stringify(res.body)).not.toContain(CURP);
    expect(JSON.stringify(res.body)).not.toContain('ANA GARCIA GOMEZ');
  });
});

// ── Timeouts ────────────────────────────────────────────────────────────────

describe('POST /bureau/query — a hung bureau', () => {
  // scToken.js gives its own outbound call a 15s timeout. scCall() -- every
  // other outbound call this service makes -- passes no timeout and no abort
  // signal at all, and node-fetch v3 has no default timeout. A bureau that
  // accepts the connection and then never answers holds this request open
  // forever, and holds the underwriting request behind it open too.
  test('a bureau that accepts the connection and never answers does not hang us forever', async () => {
    process.env.SC_HTTP_TIMEOUT_MS = '250';
    fetchMock.mockImplementationOnce((_url, opts) => new Promise((_resolve, reject) => {
      if (opts && opts.signal) {
        opts.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError', type: 'aborted' }));
        });
      }
      // No signal => nothing ever settles this promise, which is exactly what
      // production does today.
    }));

    try {
      const outcome = await Promise.race([
        postBureauQuery().then((r) => ({ responded: true, status: r.status })),
        new Promise((resolve) => setTimeout(() => resolve({ responded: false }), 3000)),
      ]);

      expect(outcome.responded).toBe(true);
      expect(outcome.status).toBeGreaterThanOrEqual(400);
    } finally {
      delete process.env.SC_HTTP_TIMEOUT_MS;
    }
  });
});
