'use strict';

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

function postDisburse(body) {
  return request(app).post('/internal/disburse').set('x-internal-secret', SECRET).send(body);
}

beforeEach(() => {
  admin.__reset();
  fetchMock.mockReset();
});

const VALID_BODY = {
  loanId: 'loan_1',
  clabe: '012180012345678901',
  amount: 5000,
  concept: 'Préstamo VIDA',
  employeeName: 'Ana García',
  employeeId: 'emp_1',
};

function seedLoanAndQueue(loanId) {
  admin.__seed('loans', loanId, { status: 'approved', amount: VALID_BODY.amount, employeeId: VALID_BODY.employeeId });
  admin.__seed('disbursement_queue', loanId, { status: 'pending', loanId });
}

describe('POST /internal/disburse — missing fields', () => {
  test.each([
    ['loanId', { ...VALID_BODY, loanId: undefined }],
    ['clabe', { ...VALID_BODY, clabe: undefined }],
    ['amount', { ...VALID_BODY, amount: undefined }],
  ])('400s when %s is missing, and never calls SoftCrédito', async (_field, body) => {
    const res = await postDisburse(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing fields' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /internal/disburse — happy path', () => {
  test('dispatches the SPEI transfer and records it in loans, disbursement_queue and spei_log', async () => {
    seedLoanAndQueue('loan_1');
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { trackingCode: 'TRK-001', transferId: 'tr_abc' }));

    const res = await postDisburse(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, ref: 'TRK-001', transferId: 'tr_abc' });

    // The actual outbound call to SoftCrédito -- exactly what a real SPEI transfer is.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://sc.test/api/spei/transfer');
    const sentBody = JSON.parse(opts.body);
    expect(sentBody).toMatchObject({
      destinationClabe: VALID_BODY.clabe,
      amount: VALID_BODY.amount,
      concept: VALID_BODY.concept,
      recipientName: VALID_BODY.employeeName,
      reference: 'LOAN_1', // loanId.slice(0, 7).toUpperCase()
      metadata: { loanId: 'loan_1', employeeId: 'emp_1' },
    });

    const loan = admin.__get('loans', 'loan_1');
    expect(loan.status).toBe('active');
    expect(loan.disbursementRef).toBe('TRK-001');
    expect(loan.softcreditoTransferId).toBe('tr_abc');

    const queue = admin.__get('disbursement_queue', 'loan_1');
    expect(queue.status).toBe('completed');
    expect(queue.speiRef).toBe('TRK-001');

    const speiLog = admin.__all('spei_log');
    expect(speiLog).toHaveLength(1);
    expect(speiLog[0].data).toMatchObject({
      loanId: 'loan_1',
      employeeId: 'emp_1',
      amount: 5000,
      clabe: VALID_BODY.clabe,
      speiRef: 'TRK-001',
      status: 'sent',
    });
  });
});

describe('POST /internal/disburse — upstream failure', () => {
  // These used to assert on the upstream response body echoed back verbatim
  // (`SC API /spei/transfer: {...}`). That body quotes the fields we sent --
  // recipientName and destinationClabe -- and payment-server persists this
  // string to loans.disbursementError and incident_log and Slack-alerts it, so
  // the free text is gone. The status code is unchanged; what replaces the
  // message is a stable machine-readable shape. See test/upstreamPiiLeak.test.js.
  test('SoftCrédito rejecting the transfer (non-2xx) is a 500, and no Firestore write happens', async () => {
    seedLoanAndQueue('loan_2');
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error_code: 'INVALID_CLABE', message: 'bad clabe' }));

    const res = await postDisburse({ ...VALID_BODY, loanId: 'loan_2' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: 'upstream_error',
      reason: 'upstream_error_code',
      code: 'INVALID_CLABE', // the vendor's code survives; its free text does not
      upstreamStatus: 400,
    });
    expect(admin.__get('loans', 'loan_2').status).toBe('approved'); // unchanged
    expect(admin.__all('spei_log')).toHaveLength(0);
  });

  test('a malformed (non-JSON) SoftCrédito response body is a 500', async () => {
    seedLoanAndQueue('loan_3');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token in JSON'); },
    });

    const res = await postDisburse({ ...VALID_BODY, loanId: 'loan_3' });

    expect(res.status).toBe(500);
    // No upstream status and no code: the response never parsed, so there was
    // no body to lift one from. The parse error's own message is withheld --
    // Node embeds a slice of the offending input in it.
    expect(res.body).toEqual({ error: 'upstream_error', reason: 'network_error' });
    expect(admin.__all('spei_log')).toHaveLength(0);
  });

  test('a network-level failure (e.g. timeout) talking to SoftCrédito is a 500', async () => {
    seedLoanAndQueue('loan_4');
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }));

    const res = await postDisburse({ ...VALID_BODY, loanId: 'loan_4' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'upstream_error', reason: 'timeout' });
    expect(admin.__all('spei_log')).toHaveLength(0);
  });
});

describe('POST /internal/disburse — replay / idempotency', () => {
  // This block used to PIN the defect: replaying the identical request
  // dispatched TWO real SPEI transfers to the same CLABE, because
  // /internal/disburse had no idempotency guard of any kind -- no key, no
  // check of loans.status or disbursement_queue.status, no dedup on
  // (loanId, amount, clabe) -- and SPEI has no idempotency key of its own
  // (functions/src/loans/loanStatusTransitions.ts:89).
  //
  // The unit of idempotency is the LOAN's disbursement, claimed server-side
  // in disbursement_claims/{loanId}. See lib/disbursementClaim.js.

  test('replaying the identical request does NOT send a second SPEI transfer', async () => {
    seedLoanAndQueue('loan_5');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { trackingCode: 'TRK-FIRST', transferId: 'tr_first' }))
      // Armed on purpose: if the guard regresses, the replay gets a usable
      // second transfer back and the assertions below fail loudly rather than
      // erroring out on an exhausted mock.
      .mockResolvedValueOnce(jsonResponse(200, { trackingCode: 'TRK-SECOND', transferId: 'tr_second' }));

    const body = { ...VALID_BODY, loanId: 'loan_5' };
    const first = await postDisburse(body);
    const second = await postDisburse(body);

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ success: true, ref: 'TRK-FIRST', transferId: 'tr_first' });

    // 200, not a 4xx: the caller is payment-server's disburseWorker
    // (services/payment-server/index.js:410), which treats any !resp.ok as a
    // job failure and retries up to 5 times before marking the loan
    // disbursement_error and paging ops. Answering a replay of an
    // already-funded loan with an error would page ops about a loan that was
    // in fact paid correctly. The original receipt is returned instead.
    expect(second.status).toBe(200);
    expect(second.body).toEqual({
      success: true,
      ref: 'TRK-FIRST',
      transferId: 'tr_first',
      idempotentReplay: true,
    });

    // The whole point: exactly ONE outbound transfer for one loan.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const loan = admin.__get('loans', 'loan_5');
    expect(loan.softcreditoTransferId).toBe('tr_first');

    const speiLog = admin.__all('spei_log');
    expect(speiLog).toHaveLength(1);
    expect(speiLog.map((e) => e.data.speiRef)).toEqual(['TRK-FIRST']);
  });

  test('a duplicate arriving while the first transfer is still in flight refuses, and never dispatches', async () => {
    // A plain Promise.all of two supertest calls does not reliably overlap --
    // the mocked transfer resolves on a microtask, so the first request can
    // finish end-to-end before the second is even dispatched, and the test
    // would then be exercising the replay path while claiming to test the
    // race. Hold the first transfer open instead, so the second request is
    // provably inside the window where a claim exists with no outcome yet.
    seedLoanAndQueue('loan_6');
    let releaseFirstTransfer;
    const firstTransferInFlight = new Promise((resolve) => {
      fetchMock.mockImplementationOnce(() => {
        resolve();
        return new Promise((r) => { releaseFirstTransfer = () => r(jsonResponse(200, { trackingCode: 'TRK-ONLY', transferId: 'tr_only' })); });
      });
    });
    // Armed so a regression dispatches a real second transfer and fails the
    // call-count assertion, rather than hanging on an unmocked call.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { trackingCode: 'TRK-DUPE', transferId: 'tr_dupe' }));

    const body = { ...VALID_BODY, loanId: 'loan_6' };
    // .then() is not decoration -- it is what puts this request on the wire.
    // A supertest Test is a lazy superagent Request: it dispatches nothing
    // until something subscribes to it (.then/.end/await). `const p =
    // postDisburse(body)` on its own sends NO request, so the wait below would
    // block until the jest timeout and the test would never reach the assertion
    // it exists to make.
    const firstPending = postDisburse(body).then((r) => r);
    await firstTransferInFlight;

    // The claim is taken transactionally before dispatch, so this second
    // request sees a claim with no recorded outcome. That is the indeterminate
    // state: refuse, do not wait for the first and do not re-send.
    const second = await postDisburse(body);
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      error: 'disbursement_indeterminate',
      reason: 'previous_attempt_unconfirmed',
      loanId: 'loan_6',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseFirstTransfer();
    const first = await firstPending;
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ success: true, ref: 'TRK-ONLY', transferId: 'tr_only' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(admin.__all('spei_log')).toHaveLength(1);
  });

  test('a retry after an unconfirmed attempt (network timeout) REFUSES and never re-sends', async () => {
    seedLoanAndQueue('loan_7');
    fetchMock
      .mockRejectedValueOnce(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce(jsonResponse(200, { trackingCode: 'TRK-RETRY', transferId: 'tr_retry' }));

    const body = { ...VALID_BODY, loanId: 'loan_7' };
    const first = await postDisburse(body);
    expect(first.status).toBe(500);
    expect(first.body).toEqual({ error: 'upstream_error', reason: 'timeout' });

    // The transfer may or may not have reached SPEI -- we never got an answer.
    // Re-sending is how a borrower gets paid twice; refusing costs a
    // reconciliation ticket. Refuse.
    const second = await postDisburse(body);
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      error: 'disbursement_indeterminate',
      reason: 'previous_attempt_unconfirmed',
      loanId: 'loan_7',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(admin.__all('spei_log')).toHaveLength(0);
    expect(admin.__get('loans', 'loan_7').status).toBe('approved');
  });

  test('a retry after SoftCrédito definitively REJECTED the transfer is allowed through', async () => {
    seedLoanAndQueue('loan_8');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(400, { error_code: 'INSUFFICIENT_FUNDS', message: 'no' }))
      .mockResolvedValueOnce(jsonResponse(200, { trackingCode: 'TRK-OK', transferId: 'tr_ok' }));

    const body = { ...VALID_BODY, loanId: 'loan_8' };
    const first = await postDisburse(body);
    expect(first.status).toBe(500);

    // SoftCrédito answered, and its answer was "I did not do this". That is a
    // known outcome, not an unknown one: no money moved, so the claim is
    // released and a legitimate retry can still fund the borrower. Collapsing
    // this into the indeterminate state would strand every transient vendor
    // rejection behind a manual reconciliation.
    const second = await postDisburse(body);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ success: true, ref: 'TRK-OK', transferId: 'tr_ok' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(admin.__all('spei_log')).toHaveLength(1);
  });

  test('a loan already disbursed before this guard existed is not re-sent', async () => {
    // Loans funded before disbursement_claims existed carry no claim doc. The
    // evidence the old code wrote -- loans.disbursedAt/disbursementRef and
    // disbursement_queue.status=completed -- is what stands in for one.
    admin.__seed('loans', 'loan_9', {
      status: 'active',
      amount: VALID_BODY.amount,
      employeeId: VALID_BODY.employeeId,
      disbursedAt: '__mock_timestamp__',
      disbursementRef: 'TRK-LEGACY',
      softcreditoTransferId: 'tr_legacy',
    });
    admin.__seed('disbursement_queue', 'loan_9', { status: 'completed', loanId: 'loan_9' });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { trackingCode: 'TRK-AGAIN', transferId: 'tr_again' }));

    const res = await postDisburse({ ...VALID_BODY, loanId: 'loan_9' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      ref: 'TRK-LEGACY',
      transferId: 'tr_legacy',
      idempotentReplay: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a second disbursement for the same loan with a different amount or CLABE is refused', async () => {
    seedLoanAndQueue('loan_10');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { trackingCode: 'TRK-A', transferId: 'tr_a' }))
      .mockResolvedValueOnce(jsonResponse(200, { trackingCode: 'TRK-B', transferId: 'tr_b' }));

    const first = await postDisburse({ ...VALID_BODY, loanId: 'loan_10' });
    expect(first.status).toBe(200);

    // Not a replay -- a DIFFERENT payout riding the same loanId. Returning the
    // first receipt would report this one as done; dispatching it would pay the
    // loan out twice. Neither is acceptable, so it is refused outright.
    const second = await postDisburse({ ...VALID_BODY, loanId: 'loan_10', amount: 9999 });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      error: 'disbursement_conflict',
      reason: 'loan_already_disbursed_with_different_terms',
      loanId: 'loan_10',
    });

    const third = await postDisburse({ ...VALID_BODY, loanId: 'loan_10', clabe: '012180099999999999' });
    expect(third.status).toBe(409);
    expect(third.body).toMatchObject({ error: 'disbursement_conflict' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(admin.__all('spei_log')).toHaveLength(1);
  });

  test('after a definitive rejection, a corrected CLABE funds the loan instead of conflicting forever', async () => {
    seedLoanAndQueue('loan_11');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(400, { error_code: 'INVALID_CLABE', message: 'bad clabe' }))
      .mockResolvedValueOnce(jsonResponse(200, { trackingCode: 'TRK-FIXED', transferId: 'tr_fixed' }))
      // Armed: a regression that re-sends below fails on the call count rather
      // than erroring out on an exhausted mock.
      .mockResolvedValue(jsonResponse(200, { trackingCode: 'TRK-EXTRA', transferId: 'tr_extra' }));

    const BAD_CLABE = '012180000000000000';
    const first = await postDisburse({ ...VALID_BODY, loanId: 'loan_11', clabe: BAD_CLABE });
    expect(first.status).toBe(500);

    // The rejected attempt's fingerprint is still on the claim doc --
    // releaseClaim() merges. Checking it against a 'released' claim would make
    // the ONLY request that can ever fund this loan the one already known to
    // fail: ops corrects the CLABE, gets 409 conflict, and the borrower is
    // stranded permanently with no override anywhere in the system. Nothing is
    // being protected here, because 'released' is precisely SoftCrédito saying
    // it did not move the money.
    const second = await postDisburse({ ...VALID_BODY, loanId: 'loan_11' });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ success: true, ref: 'TRK-FIXED', transferId: 'tr_fixed' });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The corrected terms REPLACED the old fingerprint rather than joining it:
    // they now replay, and the abandoned CLABE is the mismatch. Re-claiming a
    // released doc must not leave the dead attempt's terms behind to be matched
    // against later.
    const third = await postDisburse({ ...VALID_BODY, loanId: 'loan_11' });
    expect(third.status).toBe(200);
    expect(third.body).toMatchObject({ ref: 'TRK-FIXED', idempotentReplay: true });

    const fourth = await postDisburse({ ...VALID_BODY, loanId: 'loan_11', clabe: BAD_CLABE });
    expect(fourth.status).toBe(409);
    expect(fourth.body).toMatchObject({ error: 'disbursement_conflict' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(admin.__all('spei_log')).toHaveLength(1);
  });

  test('adopting a pre-guard disbursement does not invent a fingerprint from whichever request arrived first', async () => {
    admin.__seed('loans', 'loan_12', {
      status: 'active',
      amount: VALID_BODY.amount,
      employeeId: VALID_BODY.employeeId,
      disbursedAt: '__mock_timestamp__',
      disbursementRef: 'TRK-OLD',
      softcreditoTransferId: 'tr_old',
    });
    admin.__seed('disbursement_queue', 'loan_12', { status: 'completed', loanId: 'loan_12' });
    fetchMock.mockResolvedValue(jsonResponse(200, { trackingCode: 'TRK-NEVER', transferId: 'tr_never' }));

    // A legacy loan's destination CLABE was only ever written to spei_log, so
    // the adoption below cannot know the terms it was actually disbursed on.
    // The first request to arrive after deploy is just whichever one arrived
    // first -- here one carrying the wrong amount. Fingerprinting the claim
    // from it would make 9999 this loan's permanent definition of "the same
    // disbursement".
    const wrong = await postDisburse({ ...VALID_BODY, loanId: 'loan_12', amount: 9999 });
    expect(wrong.status).toBe(200);
    expect(wrong.body).toMatchObject({ ref: 'TRK-OLD', transferId: 'tr_old', idempotentReplay: true });

    // ...and this one -- the genuine retried job, carrying the loan's real
    // terms -- would then be answered 409 conflict and page ops about a
    // borrower who was funded correctly, once, before any of this shipped.
    const real = await postDisburse({ ...VALID_BODY, loanId: 'loan_12' });
    expect(real.status).toBe(200);
    expect(real.body).toMatchObject({ ref: 'TRK-OLD', transferId: 'tr_old', idempotentReplay: true });

    expect(admin.__get('disbursement_claims', 'loan_12').fingerprint).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
