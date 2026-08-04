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

function postSyncRepayments() {
  return request(app).post('/internal/sync-repayments').set('x-internal-secret', SECRET).send({});
}

beforeEach(() => {
  admin.__reset();
  fetchMock.mockReset();
});

describe('POST /internal/sync-repayments — happy path', () => {
  test('forwards each completed deduction to payment-server and counts it as synced', async () => {
    admin.__seed('loans', 'loan_1', { softcreditoDeductionId: 'ded_1', status: 'active', employeeId: 'emp_1' });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { deductions: [{ deductionId: 'ded_1', amount: 800, reference: 'REF1' }] }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true }));

    const res = await postSyncRepayments();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, synced: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toBe('https://payment-server.test/internal/repayment');
    expect(opts.headers['x-internal-secret']).toBe(SECRET);
    expect(JSON.parse(opts.body)).toEqual({
      loanId: 'loan_1',
      employeeId: 'emp_1',
      amount: 800,
      ref: 'REF1',
      method: 'payroll_deduction',
    });
  });

  test('a deduction for a loan already marked paid locally is skipped, others in the same batch still process', async () => {
    admin.__seed('loans', 'loan_paid', { softcreditoDeductionId: 'ded_paid', status: 'paid', employeeId: 'emp_x' });
    admin.__seed('loans', 'loan_2', { softcreditoDeductionId: 'ded_2', status: 'active', employeeId: 'emp_2' });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, {
        deductions: [
          { deductionId: 'ded_paid', amount: 100, reference: 'REF-PAID' },
          { deductionId: 'ded_2', amount: 500, reference: 'REF2' },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true }));

    const res = await postSyncRepayments();

    expect(res.body).toEqual({ success: true, synced: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 SC call + 1 forward (not 2 forwards)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ loanId: 'loan_2' });
  });

  test('a deduction with no matching loan is skipped and nothing is forwarded', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      deductions: [{ deductionId: 'ded_unknown', amount: 100, reference: 'REF' }],
    }));

    const res = await postSyncRepayments();

    expect(res.body).toEqual({ success: true, synced: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the SC GET, no forward
  });

  test('a response with no deductions field at all synces zero without crashing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));

    const res = await postSyncRepayments();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, synced: 0 });
  });
});

describe('POST /internal/sync-repayments — upstream failure', () => {
  test('SoftCrédito rejecting the completed-deductions query is a 500', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: 'upstream down' }));

    const res = await postSyncRepayments();

    expect(res.status).toBe(500);
    // No `code`: the body's only field is `error: 'upstream down'`, and free
    // text is never promoted to a machine code -- that would reopen the leak
    // one field over. See lib/upstreamError.js.
    expect(res.body).toEqual({
      error: 'upstream_error',
      reason: 'upstream_error_code',
      upstreamStatus: 503,
    });
  });

  test('a malformed (non-JSON) SoftCrédito response is a 500', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } });

    const res = await postSyncRepayments();

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'upstream_error', reason: 'network_error' });
  });

  // The deduction has already been taken out of the borrower's paycheck by the
  // time this route sees it; the forward to payment-server is what turns it
  // into a balance reduction. Pre-fix the forward's status was never read --
  // `await fetch(...)` with no `if (!resp.ok)` branch -- so a rejected forward
  // was counted as `synced` and rolled into `{ success: true }`. Nothing
  // retries it (the next run queries a different date), so that repayment is
  // lost, and dailyLoanCheck's overdue sweep -- which gates on this route's
  // status exactly so it never acts on stale collection data -- runs anyway and
  // marks the borrower who paid overdue.
  test('a forward payment-server rejects is not counted as synced and is not reported as success', async () => {
    admin.__seed('loans', 'loan_3', { softcreditoDeductionId: 'ded_3', status: 'active', employeeId: 'emp_3' });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { deductions: [{ deductionId: 'ded_3', amount: 300, reference: 'REF3' }] }))
      .mockResolvedValueOnce(jsonResponse(500, { error: 'payment-server internal error' }));

    const res = await postSyncRepayments();

    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: 'repayment_forward_failed',
      reason: 'deductions_collected_but_not_booked',
      synced: 0,
      failed: 1,
    });
  });

  test('a forward that throws (payment-server unreachable) does not strand the rest of the batch', async () => {
    admin.__seed('loans', 'loan_a', { softcreditoDeductionId: 'ded_a', status: 'active', employeeId: 'emp_a' });
    admin.__seed('loans', 'loan_b', { softcreditoDeductionId: 'ded_b', status: 'active', employeeId: 'emp_b' });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, {
        deductions: [
          { deductionId: 'ded_a', amount: 100, reference: 'REFA' },
          { deductionId: 'ded_b', amount: 200, reference: 'REFB' },
        ],
      }))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(jsonResponse(200, { success: true }));

    const res = await postSyncRepayments();

    // The second deduction was still attempted and still booked...
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({ loanId: 'loan_b' });
    // ...but the run is reported as failed, because one deduction is collected
    // and unbooked and the caller must not sweep on that.
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ synced: 1, failed: 1 });
  });

  test('a partial batch does not report success even when most forwards land', async () => {
    admin.__seed('loans', 'loan_ok', { softcreditoDeductionId: 'ded_ok', status: 'active', employeeId: 'emp_ok' });
    admin.__seed('loans', 'loan_bad', { softcreditoDeductionId: 'ded_bad', status: 'active', employeeId: 'emp_bad' });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, {
        deductions: [
          { deductionId: 'ded_ok', amount: 100, reference: 'REFOK' },
          { deductionId: 'ded_bad', amount: 200, reference: 'REFBAD' },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true }))
      .mockResolvedValueOnce(jsonResponse(404, { error: 'Loan not found' }));

    const res = await postSyncRepayments();

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ synced: 1, failed: 1 });
  });
});

describe('POST /internal/sync-repayments — replay', () => {
  // DEFECT: the only guard against double-forwarding is checking this
  // service's own (possibly stale) Firestore snapshot for status === 'paid'.
  // payment-server sets that status asynchronously, so two sync-repayments
  // runs close together -- an overlapping cron, a manual ops retry -- see the
  // same "not yet paid" loan both times and forward the SAME deduction to
  // payment-server twice. Combined with payment-server's own known
  // charge-replay defect (see services/payment-server, PR #490/#491's
  // triage), a double-forward here is not purely theoretical.
  test('two overlapping runs both forward the same not-yet-paid deduction', async () => {
    admin.__seed('loans', 'loan_4', { softcreditoDeductionId: 'ded_4', status: 'active', employeeId: 'emp_4' });
    const deductionResponse = jsonResponse(200, { deductions: [{ deductionId: 'ded_4', amount: 900, reference: 'REF4' }] });
    fetchMock
      .mockResolvedValueOnce(deductionResponse)
      .mockResolvedValueOnce(jsonResponse(200, { success: true }))
      .mockResolvedValueOnce(deductionResponse)
      .mockResolvedValueOnce(jsonResponse(200, { success: true }));

    const first = await postSyncRepayments();
    const second = await postSyncRepayments();

    expect(first.body).toEqual({ success: true, synced: 1 });
    expect(second.body).toEqual({ success: true, synced: 1 }); // no memory that this was already forwarded
    expect(fetchMock).toHaveBeenCalledTimes(4); // 2 SC calls + 2 identical forwards
  });
});
