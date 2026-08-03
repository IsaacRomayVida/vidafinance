'use strict';

const { setBaseEnv } = require('./testEnv');
setBaseEnv();
process.env.SOFTCREDITO_ADAPTER_URL = 'https://softcredito-adapter.internal';

const { disburseWorker } = require('../index');
const admin = require('firebase-admin');
const fetchMock = require('node-fetch');

beforeEach(() => {
  admin.__reset();
  fetchMock.mockReset();
});

describe('disbursement worker — job processor', () => {
  test('happy path: calls softcredito-adapter with the internal secret and returns its response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ transferId: 'tr_1', trackingCode: 'TRK1' }) });

    const job = { data: { loanId: 'loan_1', clabe: '012345678901234567', amount: 500, concept: 'Préstamo', employeeName: 'Ana', employeeId: 'emp_1' } };
    const result = await disburseWorker.processor(job);

    expect(result).toEqual({ transferId: 'tr_1', trackingCode: 'TRK1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://softcredito-adapter.internal/internal/disburse');
    expect(opts.headers['x-internal-secret']).toBe(process.env.INTERNAL_SECRET);
    expect(JSON.parse(opts.body)).toEqual({ loanId: 'loan_1', clabe: '012345678901234567', amount: 500, concept: 'Préstamo', employeeName: 'Ana', employeeId: 'emp_1' });
  });

  test('malformed job: no CLABE on file marks the loan disbursement_error and throws (no silent money loss)', async () => {
    admin.__seed('loans', 'loan_2', { status: 'active' });
    const job = { data: { loanId: 'loan_2', clabe: null, amount: 500 } };

    await expect(disburseWorker.processor(job)).rejects.toThrow('No CLABE for loan loan_2');
    const loan = admin.__get('loans', 'loan_2');
    expect(loan.status).toBe('disbursement_error');
    expect(loan.disbursementError).toBe('No CLABE registered');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('malformed job: softcredito-adapter rejecting the transfer throws with its error body', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, text: async () => 'insufficient adapter balance' });
    const job = { data: { loanId: 'loan_3', clabe: '012345678901234567', amount: 500 } };

    await expect(disburseWorker.processor(job)).rejects.toThrow(/SoftCrédito disburse failed: insufficient adapter balance/);
  });
});

describe('disbursement worker — failed handler (exhausted retries)', () => {
  test('after 5 attempts: marks the loan disbursement_error and logs an incident', async () => {
    admin.__seed('loans', 'loan_4', { status: 'active' });
    const job = { attemptsMade: 5, data: { loanId: 'loan_4' } };

    await disburseWorker.emit('failed', job, new Error('adapter down'));

    const loan = admin.__get('loans', 'loan_4');
    expect(loan.status).toBe('disbursement_error');
    expect(loan.disbursementError).toBe('adapter down');

    const incidents = admin.__all('incident_log');
    expect(incidents[0].data).toMatchObject({ source: 'disbursement-worker', loanId: 'loan_4', error: 'adapter down' });
  });

  test('before the final attempt: no Firestore write yet, still retrying', async () => {
    admin.__seed('loans', 'loan_5', { status: 'active' });
    const job = { attemptsMade: 2, data: { loanId: 'loan_5' } };

    await disburseWorker.emit('failed', job, new Error('transient'));

    expect(admin.__get('loans', 'loan_5').status).toBe('active');
    expect(admin.__all('incident_log')).toHaveLength(0);
  });
});
