'use strict';

const { setBaseEnv } = require('./testEnv');
setBaseEnv();

const { worker } = require('../index');
const admin = require('firebase-admin');

beforeEach(() => {
  admin.__reset();
});

describe('vida-pdfs worker — loan_contract job', () => {
  test('happy path: renders the contract, uploads it, and writes loan + employee document records', async () => {
    admin.__seed('loans', 'loan_1', {
      employeeName: 'Ana Torres',
      employerName: 'Acme SA de CV',
      amount: 1000,
      fee: 300,
      total: 1300,
      feeRate: 0.3,
      term: 30,
      dueDate: { toDate: () => new Date('2026-09-01T00:00:00Z') },
    });

    const job = { data: { type: 'loan_contract', loanId: 'loan_1', employeeId: 'emp_1' } };
    await worker.processor(job);

    const loan = admin.__get('loans', 'loan_1');
    expect(loan.contractUrl).toMatch(/^https:\/\/storage\.googleapis\.com\/test-bucket\/loans\/loan_1\/contrato_\d+\.pdf$/);
    expect(loan.contractGeneratedAt).toBe('__mock_timestamp__');

    const docs = admin.__all('employees/emp_1/documents');
    expect(docs).toHaveLength(1);
    expect(docs[0].data).toMatchObject({ type: 'loan_contract', loanId: 'loan_1' });
  });

  // DEFECT: a malformed job (loan not found in Firestore) throws a raw
  // TypeError reading `.dueDate` off `undefined` instead of a clear
  // "loan not found" error -- the worker has no existence check before use,
  // unlike the HTTP route which does check.
  test('DEFECT: malformed job — unknown loanId throws a raw TypeError instead of a clear error', async () => {
    const job = { data: { type: 'loan_contract', loanId: 'does_not_exist', employeeId: 'emp_1' } };
    await expect(worker.processor(job)).rejects.toThrow();
  });
});

describe('vida-pdfs worker — repayment_receipt job', () => {
  test('happy path: renders the receipt and writes receiptUrl on the loan', async () => {
    admin.__seed('loans', 'loan_2', { employeeName: 'Ana Torres', repaymentRef: 'ref-1' });

    const job = { data: { type: 'repayment_receipt', loanId: 'loan_2', amount: 500, chargeId: 'chg_1' } };
    await worker.processor(job);

    const loan = admin.__get('loans', 'loan_2');
    expect(loan.receiptUrl).toMatch(/^https:\/\/storage\.googleapis\.com\/test-bucket\/loans\/loan_2\/recibo_\d+\.pdf$/);
    expect(loan.receiptGeneratedAt).toBe('__mock_timestamp__');
  });
});

describe('vida-pdfs worker — unknown job type', () => {
  test('an unrecognized type is a silent no-op: no error, no Firestore write', async () => {
    const job = { data: { type: 'not_a_real_type', loanId: 'loan_3' } };
    await expect(worker.processor(job)).resolves.toBeUndefined();
    expect(admin.__get('loans', 'loan_3')).toBeUndefined();
  });
});

describe('vida-pdfs worker — failed handler', () => {
  test('logs an incident to Firestore when a job exhausts and fails', async () => {
    const job = { data: { loanId: 'loan_4' } };
    await worker.emit('failed', job, new Error('render crashed'));

    const incidents = admin.__all('incident_log');
    expect(incidents).toHaveLength(1);
    expect(incidents[0].data).toMatchObject({
      source: 'pdf-worker',
      loanId: 'loan_4',
      error: 'render crashed',
    });
  });
});
