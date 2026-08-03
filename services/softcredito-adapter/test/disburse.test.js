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
  test('SoftCrédito rejecting the transfer (non-2xx) is a 500, and no Firestore write happens', async () => {
    seedLoanAndQueue('loan_2');
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error_code: 'INVALID_CLABE', message: 'bad clabe' }));

    const res = await postDisburse({ ...VALID_BODY, loanId: 'loan_2' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/^SC API \/spei\/transfer: /);
    expect(res.body.error).toMatch(/INVALID_CLABE/);
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
    expect(res.body.error).toMatch(/Unexpected token/);
    expect(admin.__all('spei_log')).toHaveLength(0);
  });

  test('a network-level failure (e.g. timeout) talking to SoftCrédito is a 500', async () => {
    seedLoanAndQueue('loan_4');
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }));

    const res = await postDisburse({ ...VALID_BODY, loanId: 'loan_4' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('request timed out');
    expect(admin.__all('spei_log')).toHaveLength(0);
  });
});

describe('POST /internal/disburse — replay / idempotency', () => {
  // DEFECT: /internal/disburse has NO idempotency guard of any kind -- no
  // idempotency key accepted from the caller, no check of loans.status or
  // disbursement_queue.status before calling SoftCrédito, and no dedup on
  // (loanId, amount, clabe). SPEI itself has no idempotency key either. This
  // test pins the current (dangerous) behavior: replaying the exact same
  // disbursement request twice dispatches TWO real SPEI transfers to the
  // same CLABE. See services/softcredito-adapter/index.js:132-160
  // (app.post('/internal/disburse', ...)).
  test('replaying the identical request sends a SECOND real SPEI transfer, not a no-op', async () => {
    seedLoanAndQueue('loan_5');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { trackingCode: 'TRK-FIRST', transferId: 'tr_first' }))
      .mockResolvedValueOnce(jsonResponse(200, { trackingCode: 'TRK-SECOND', transferId: 'tr_second' }));

    const body = { ...VALID_BODY, loanId: 'loan_5' };
    const first = await postDisburse(body);
    const second = await postDisburse(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200); // no rejection, no "already disbursed" signal of any kind

    // Two real outbound transfer calls to SoftCrédito for the identical loan/clabe/amount.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Nothing in local state distinguishes this from a single legitimate disbursement --
    // the loan doc just reflects whichever transfer completed last.
    const loan = admin.__get('loans', 'loan_5');
    expect(loan.softcreditoTransferId).toBe('tr_second');

    // Both real transfers are logged, which is the only local trace that two money
    // movements happened -- nothing blocks or flags the second one before it fires.
    const speiLog = admin.__all('spei_log');
    expect(speiLog).toHaveLength(2);
    expect(speiLog.map((e) => e.data.speiRef)).toEqual(['TRK-FIRST', 'TRK-SECOND']);
  });
});
