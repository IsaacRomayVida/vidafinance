'use strict';

// Conekta webhook behaviour when the handler's OWN bookkeeping fails, and when
// a signature-valid body is not parseable.
//
// ── The defect these tests pin ───────────────────────────────────────────────
// Every test in webhooksConekta.test.js exercises a HEALTHY Firestore. These
// exercise the paths where Firestore is unreachable, or the body is malformed.
//
// Express 4 does not catch a rejected promise from an async route handler, so
// any `await` that escapes the handler's try/catch sends NO response at all.
// Three such awaits existed on `/webhooks/conekta`:
//
//   1. The 401 path awaits `incident_log.add()` BEFORE `return res.status(401)`.
//   2. `JSON.parse(req.body.toString())` sat OUTSIDE the try entirely.
//   3. The catch block itself awaits `incident_log.add()` before `res.status(500)`.
//
// On each, the caller receives nothing and hangs until its own timeout. That is
// strictly worse than an error status here: Conekta retries a webhook on any
// non-2xx AND on timeout, so a hang converts a fast, clearly-logged failure
// into a slow one that occupies a connection per retry for as long as the
// outage lasts. It is the same shape as the registry-service defect fixed in
// #524, in the service that moves money.
//
// The explicit `.timeout()` below is what makes these discriminating: a hang
// fails them as ECONNABORTED in 2s rather than as an assertion mismatch on
// jest's default timeout.

const { setBaseEnv, hmacSign } = require('./testEnv');
setBaseEnv();

const request = require('supertest');
const { app } = require('../index');
const admin = require('firebase-admin');
const { Queue } = require('bullmq');

const SECRET = process.env.CONEKTA_WEBHOOK_SECRET;

beforeEach(() => {
  admin.__reset();
  Queue.__reset();
});

function post(rawBody, headers = {}) {
  const req = request(app).post('/webhooks/conekta').set('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  return req.send(rawBody).timeout(2000);
}

function conektaEvent(type, object) {
  return JSON.stringify({ type, data: { object } });
}

describe('the handler still answers when its own incident logging fails', () => {
  test('a bad signature still gets 401 when incident_log is unwritable', async () => {
    admin.__failAdds('incident_log', 'FIRESTORE UNAVAILABLE');
    const body = conektaEvent('order.paid', { id: 'ord_1', amount: 10000, metadata: {}, charges: { data: [] } });

    const res = await post(body, { digest: 'not-the-right-signature' });

    // The rejection decision does not depend on the audit write succeeding.
    // Failing to RECORD the rejection must not also fail to PERFORM it.
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid signature' });
  });

  test('an internal failure still gets 500 when incident_log is unwritable', async () => {
    admin.__failAdds('incident_log', 'FIRESTORE UNAVAILABLE');
    // `order.paid` with no metadata throws 'Missing metadata' inside the try,
    // sending the handler into its catch -- where the incident write also fails.
    const body = conektaEvent('order.paid', { id: 'ord_2', amount: 10000, metadata: {}, charges: { data: [{ id: 'ch_1', amount: 10000 }] } });
    const sig = hmacSign(SECRET, body);

    const res = await post(body, { digest: sig });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal error' });
  });
});

describe('a signature-valid body that is not parseable JSON', () => {
  test('gets 400 rather than hanging the caller', async () => {
    // Correctly signed -- so this is past authentication -- but not JSON.
    // JSON.parse threw outside the try, so nothing answered the request.
    const body = 'this is not json';
    const sig = hmacSign(SECRET, body);

    const res = await post(body, { digest: sig });

    // 400, not 500: the body is the caller's to get right, and a 4xx tells
    // Conekta the retry is pointless. Retrying an unparseable body forever
    // cannot succeed.
    expect(res.status).toBe(400);
  });

  test('records the unparseable body for reconciliation', async () => {
    const body = '{"type":"order.paid","data":';
    const sig = hmacSign(SECRET, body);

    const res = await post(body, { digest: sig });

    expect(res.status).toBe(400);
    // A signature-valid body we could not read means Conekta believes it told
    // us something. Silently dropping it loses a real event.
    const incidents = admin.__all('incident_log');
    expect(incidents).toHaveLength(1);
    expect(incidents[0].data.error).toMatch(/unparseable|parse/i);
  });

  test('still answers 400 when the incident write ALSO fails', async () => {
    admin.__failAdds('incident_log', 'FIRESTORE UNAVAILABLE');
    const body = 'not json either';
    const sig = hmacSign(SECRET, body);

    const res = await post(body, { digest: sig });

    expect(res.status).toBe(400);
  });
});

// ── Controls ────────────────────────────────────────────────────────────────
// These pass in BOTH the before and after states. They are what makes the red
// tests above evidence of a real defect rather than of a broken harness: the
// healthy paths are untouched by the fix.
describe('controls — unchanged by the fix', () => {
  test('a wrong signature is still rejected when Firestore is healthy', async () => {
    const body = conektaEvent('order.paid', { id: 'ord_c1', amount: 10000, metadata: {}, charges: { data: [] } });
    const res = await post(body, { digest: 'wrong' });
    expect(res.status).toBe(401);
    const incidents = admin.__all('incident_log');
    expect(incidents).toHaveLength(1);
    expect(incidents[0].data.error).toBe('invalid_signature');
  });

  test('a correctly signed, parseable event is still accepted', async () => {
    const body = conektaEvent('order.payment_failed', { id: 'ord_c2', metadata: { loanId: 'loan_1' }, payment_status: 'declined' });
    const sig = hmacSign(SECRET, body);
    const res = await post(body, { digest: sig });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  test('a missing signature header is still rejected', async () => {
    const body = conektaEvent('order.payment_failed', { id: 'ord_c3', metadata: { loanId: 'loan_1' }, payment_status: 'declined' });
    const res = await post(body);
    expect(res.status).toBe(401);
  });
});
