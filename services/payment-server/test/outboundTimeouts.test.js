'use strict';

// The two outbound calls on the money path that had no deadline at all.
//
// ── The defect these tests pin ───────────────────────────────────────────────
// `/create-checkout` (index.js) and the `vida-disbursements` worker both call
// out with node-fetch v2 (package.json pins ^2.7.0; node_modules resolves
// 2.7.0). v2's `timeout` option defaults to 0 — disabled — and neither call
// site passed `timeout` or `signal`. An upstream that accepts the TCP
// connection and then never answers therefore stalls the caller forever, and
// nothing outside index.js bounds it:
//
//   * `app.listen()` (index.js:~438) sets no server timeout. Node's
//     `server.timeout` has defaulted to 0 since v13, and `requestTimeout`
//     bounds RECEIVING a request, not producing a response.
//   * BullMQ v5 has no per-job timeout, and `getQueue`'s defaultJobOptions
//     (index.js:~78) set only attempts/backoff/removal. The worker renews an
//     active job's lock on a timer regardless of whether the processor is
//     making progress, so a stalled processor is never marked stalled — it
//     pins one of `concurrency: 3` slots permanently.
//
// This is an outage that reads as latency, which is what makes it expensive:
// the 5xx alert interceptor (index.js:~60) hangs off `res.json`, so a request
// that never responds never alerts, and `disburseWorker.on('failed')` needs a
// throw, which a hang never produces. Same family as #524/#526/#556.
//
// ── Why these tests are discriminating ──────────────────────────────────────
// The node-fetch mock below settles ONLY when the caller's own AbortSignal
// fires — which is exactly what the real library does. Remove the signal from
// index.js and the mock never settles, so the route hangs (supertest's
// explicit `.timeout(2000)` turns that into a fast ECONNABORTED rather than a
// slow assertion mismatch) and the worker's processor never rejects (the
// `bounded()` helper turns that into a fast, named failure).
//
// Real jest fake timers are deliberately NOT used: `AbortSignal.timeout()` is
// backed by Node's internal timers, which @sinonjs/fake-timers does not patch,
// so advancing fake time would not fire it. Instead both deadlines are driven
// to 25ms through their env overrides. No real network, no meaningful sleep.

const { setBaseEnv } = require('./testEnv');
setBaseEnv();
process.env.SOFTCREDITO_ADAPTER_URL = 'https://softcredito-adapter.internal';

jest.mock('../../shared/alerting', () => ({
  alert5xx: jest.fn(),
  alertDisbursementFailed: jest.fn(),
  alertQueueDepth: jest.fn(),
  alertRedisLost: jest.fn(),
}));

const request = require('supertest');
const { app, disburseWorker } = require('../index');
const admin = require('firebase-admin');
const fetchMock = require('node-fetch');
const { UnrecoverableError } = require('bullmq');
const { alertDisbursementFailed } = require('../../shared/alerting');

const SECRET = process.env.INTERNAL_SECRET;

// node-fetch v2 rejects with this exact shape when the signal fires:
// `name: 'AbortError'`, `type: 'aborted'` (see its AbortError class).
function abortError() {
  const err = new Error('The user aborted a request.');
  err.name = 'AbortError';
  err.type = 'aborted';
  return err;
}

/**
 * An upstream that accepts the connection and then goes silent. Settles only
 * if the caller supplied a signal that eventually aborts — with no signal it
 * never settles, which IS the pre-fix production behaviour.
 */
function stall() {
  return (_url, opts) =>
    new Promise((_resolve, reject) => {
      const signal = opts && opts.signal;
      if (!signal) return;
      if (signal.aborted) return reject(abortError());
      signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
}

/** Fail fast and by name when a promise that must be bounded is not. */
function bounded(promise, ms = 2000) {
  let timer;
  const tripwire = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('TEST-HANG: the outbound call is unbounded — it never settled')),
      ms
    );
    timer.unref();
  });
  return Promise.race([promise, tripwire]).finally(() => clearTimeout(timer));
}

beforeEach(() => {
  admin.__reset();
  fetchMock.mockReset();
  alertDisbursementFailed.mockReset();
  process.env.CONEKTA_API_KEY = 'sk_test_123';
  process.env.CONEKTA_HTTP_TIMEOUT_MS = '25';
  process.env.DISBURSE_HTTP_TIMEOUT_MS = '25';
});

afterAll(() => {
  delete process.env.CONEKTA_HTTP_TIMEOUT_MS;
  delete process.env.DISBURSE_HTTP_TIMEOUT_MS;
});

function postCheckout(body) {
  return request(app)
    .post('/create-checkout')
    .set('x-internal-secret', SECRET)
    .send(body)
    .timeout(2000);
}

// ── POST /create-checkout → api.conekta.io ──────────────────────────────────
describe('POST /create-checkout — Conekta accepts the connection and never answers', () => {
  test('answers 504 instead of hanging the borrower’s repayment screen', async () => {
    fetchMock.mockImplementationOnce(stall());

    const res = await postCheckout({ loanId: 'loan_1', amount: 500, employeeId: 'emp_1' });

    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({ reason: 'conekta_timeout', timeoutMs: 25 });
  });

  test('passes an abort signal to Conekta, honouring CONEKTA_HTTP_TIMEOUT_MS', async () => {
    fetchMock.mockImplementationOnce(stall());

    await postCheckout({ loanId: 'loan_2', amount: 500, employeeId: 'emp_2' });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.conekta.io/orders');
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.signal.aborted).toBe(true);
  });

  test('records the timeout as a POSSIBLY-CREATED order, not as a failed one', async () => {
    // A client-side abort does not cancel the server side. Conekta may have
    // created the order after we stopped listening, and we will never learn
    // its id — so the incident row has to carry the loanId and say the order
    // may be orphaned, or reconciliation has nothing to work from.
    fetchMock.mockImplementationOnce(stall());

    await postCheckout({ loanId: 'loan_3', amount: 500, employeeId: 'emp_3' });

    const incidents = admin.__all('incident_log');
    expect(incidents).toHaveLength(1);
    expect(incidents[0].data).toMatchObject({ source: 'create-checkout', loanId: 'loan_3' });
    expect(incidents[0].data.error).toMatch(/timeout/i);
    expect(incidents[0].data.error).toMatch(/may have been created/i);
  });

  test('still answers 504 when its own incident logging is also down', async () => {
    admin.__failAdds('incident_log', 'FIRESTORE UNAVAILABLE');
    fetchMock.mockImplementationOnce(stall());

    const res = await postCheckout({ loanId: 'loan_4', amount: 500, employeeId: 'emp_4' });

    expect(res.status).toBe(504);
  });
});

// ── vida-disbursements worker → softcredito-adapter /internal/disburse ──────
describe('disbursement worker — the adapter accepts the job and never answers', () => {
  const JOB = {
    loanId: 'loan_d1',
    clabe: '012345678901234567',
    amount: 5000,
    concept: 'Préstamo',
    employeeName: 'Ana',
    employeeId: 'emp_1',
  };

  test('the job settles instead of pinning one of the three worker slots forever', async () => {
    fetchMock.mockImplementationOnce(stall());

    await expect(bounded(disburseWorker.processor({ data: JOB }))).rejects.toThrow(/timed out/i);
  });

  test('fails UNRETRYABLY, because a retry is a second real SPEI transfer', async () => {
    // `/internal/disburse` has no idempotency guard of any kind — no key, no
    // status check, no (loanId, amount, clabe) dedup — and SPEI has none
    // either. softcredito-adapter/index.js:95-109 says so in as many words,
    // and test/disburse.test.js pins it: replaying the identical request
    // sends a SECOND real transfer. With `attempts: 5` (index.js:~78), a
    // plain Error here would pay the borrower up to five times. An
    // UnrecoverableError is how BullMQ is told not to try again.
    fetchMock.mockImplementationOnce(stall());

    await expect(bounded(disburseWorker.processor({ data: JOB }))).rejects.toBeInstanceOf(
      UnrecoverableError
    );
  });

  test('marks the loan INDETERMINATE — the transfer may already have gone out', async () => {
    admin.__seed('loans', JOB.loanId, { status: 'disbursement_queued' });
    fetchMock.mockImplementationOnce(stall());

    await expect(bounded(disburseWorker.processor({ data: JOB }))).rejects.toThrow();

    const loan = admin.__get('loans', JOB.loanId);
    // Not plain `disbursement_error`: that reads as "no money moved" and
    // invites ops to re-fire the transfer, which is the duplicate payout.
    expect(loan.disbursementIndeterminate).toBe(true);
    expect(loan.disbursementError).toMatch(/may/i);
  });

  test('alerts and logs an incident immediately, not after five silent retries', async () => {
    // `disburseWorker.on('failed')` only records at `attemptsMade >= 5`, and
    // an unrecoverable failure never reaches five. Without this the borrower's
    // disbursement stops with no alert at all.
    fetchMock.mockImplementationOnce(stall());

    await expect(bounded(disburseWorker.processor({ data: JOB }))).rejects.toThrow();

    expect(alertDisbursementFailed).toHaveBeenCalledTimes(1);
    const incidents = admin.__all('incident_log');
    expect(incidents).toHaveLength(1);
    expect(incidents[0].data).toMatchObject({ source: 'disbursement-worker', loanId: JOB.loanId });
  });

  test('a Firestore outage during that bookkeeping must not turn it back into a retry', async () => {
    // If the incident write threw, the rejection escaping the processor would
    // be Firestore's retryable error instead of UnrecoverableError — and the
    // duplicate transfer we just refused would fire anyway.
    admin.__failAdds('incident_log', 'FIRESTORE UNAVAILABLE');
    fetchMock.mockImplementationOnce(stall());

    await expect(bounded(disburseWorker.processor({ data: JOB }))).rejects.toBeInstanceOf(
      UnrecoverableError
    );
  });
});

// ── Controls ────────────────────────────────────────────────────────────────
// These pass in BOTH the before and after states. They are what makes the
// tests above evidence of a real defect rather than of a broken harness.
describe('controls — unchanged by the fix', () => {
  test('a healthy Conekta order still returns the checkout URL', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'ord_1', checkout: { url: 'https://pay.conekta/ord_1' } }),
    });

    const res = await postCheckout({ loanId: 'loan_ok', amount: 500, employeeId: 'emp_ok' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ paymentUrl: 'https://pay.conekta/ord_1', orderId: 'ord_1' });
  });

  test('Conekta rejecting the order is still a 502, not a 504', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, text: async () => 'invalid card token' });

    const res = await postCheckout({ loanId: 'loan_502', amount: 500, employeeId: 'emp_502' });

    expect(res.status).toBe(502);
  });

  test('a genuine transient adapter failure still fails RETRYABLY', async () => {
    // The whole point of refusing the retry on a timeout is that a timeout is
    // ambiguous. A connection refused is not — nothing was ever delivered —
    // so it must keep its retries.
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));

    const err = await disburseWorker.processor({ data: { ...JOB_CONTROL } }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });

  test('the adapter rejecting the transfer (non-2xx) still fails RETRYABLY', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, text: async () => 'insufficient adapter balance' });

    const err = await disburseWorker.processor({ data: { ...JOB_CONTROL } }).catch((e) => e);

    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(err.message).toMatch(/insufficient adapter balance/);
  });
});

const JOB_CONTROL = {
  loanId: 'loan_ctl',
  clabe: '012345678901234567',
  amount: 5000,
  concept: 'Préstamo',
  employeeName: 'Ana',
  employeeId: 'emp_1',
};
