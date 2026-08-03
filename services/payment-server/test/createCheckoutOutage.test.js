'use strict';

// POST /create-checkout when the handler's OWN incident logging fails.
//
// ── The defect these tests pin ───────────────────────────────────────────────
// createCheckout.test.js exercises a HEALTHY Firestore. These exercise the
// paths where Firestore is unreachable while the handler is already mid-
// failure -- the borrower's checkout request, the one that creates the
// Conekta order they pay through.
//
// Express 4 does not catch a rejected promise from an async route handler, so
// any `await` that escapes the handler's try/catch sends NO response at all.
// Two such awaits existed on `/create-checkout`:
//
//   1. The `!conektaRes.ok` branch awaits `incident_log.add()` BEFORE
//      `return res.status(502)`.
//   2. The route's catch block awaits `incident_log.add()` before
//      `res.status(500)` -- the one path that exists to report a failure is
//      itself the thing that fails silently.
//
// On each, the caller receives nothing and hangs until its own timeout
// instead of the status the handler had already decided to send. Same defect
// class as the webhook fix in #526, here on the route that starts the money
// moving the other direction.
//
// The explicit `.timeout()` below is what makes these discriminating: a hang
// fails them as ECONNABORTED in 2s rather than as an assertion mismatch on
// jest's default timeout.

const { setBaseEnv } = require('./testEnv');
setBaseEnv();

const request = require('supertest');
const { app } = require('../index');
const admin = require('firebase-admin');
const fetchMock = require('node-fetch');

const SECRET = process.env.INTERNAL_SECRET;

beforeEach(() => {
  admin.__reset();
  fetchMock.mockReset();
  process.env.CONEKTA_API_KEY = 'sk_test_123';
});

function postCheckout(body) {
  return request(app).post('/create-checkout').set('x-internal-secret', SECRET).send(body).timeout(2000);
}

describe('the handler still answers when its own incident logging fails', () => {
  test('still 502s when Conekta rejects the order and incident_log is unwritable', async () => {
    admin.__failAdds('incident_log', 'FIRESTORE UNAVAILABLE');
    fetchMock.mockResolvedValueOnce({ ok: false, text: async () => 'invalid card token' });

    const res = await postCheckout({ loanId: 'loan_1', amount: 500, employeeId: 'emp_1' });

    // The rejection decision does not depend on the audit write succeeding.
    // Failing to RECORD the failure must not also fail to REPORT it.
    expect(res.status).toBe(502);
    expect(res.body.details).toBe('invalid card token');
  });

  test('still 500s when the Conekta call throws and incident_log is unwritable', async () => {
    admin.__failAdds('incident_log', 'FIRESTORE UNAVAILABLE');
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));

    const res = await postCheckout({ loanId: 'loan_2', amount: 500, employeeId: 'emp_2' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('ECONNRESET');
  });
});

// ── Controls ────────────────────────────────────────────────────────────────
// These pass in BOTH the before and after states. They are what makes the red
// tests above evidence of a real defect rather than of a broken harness: the
// healthy paths are untouched by the fix.
describe('controls — unchanged by the fix', () => {
  test('502s and logs an incident when Conekta rejects the order (Firestore healthy)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, text: async () => 'invalid card token' });

    const res = await postCheckout({ loanId: 'loan_3', amount: 500, employeeId: 'emp_3' });

    expect(res.status).toBe(502);
    const incidents = admin.__all('incident_log');
    expect(incidents).toHaveLength(1);
    expect(incidents[0].data).toMatchObject({ source: 'create-checkout', loanId: 'loan_3', error: 'invalid card token' });
  });

  test('500s and logs an incident when the Conekta call throws (Firestore healthy)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));

    const res = await postCheckout({ loanId: 'loan_4', amount: 500, employeeId: 'emp_4' });

    expect(res.status).toBe(500);
    expect(admin.__all('incident_log')[0].data.error).toBe('ECONNRESET');
  });
});
