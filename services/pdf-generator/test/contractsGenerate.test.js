'use strict';

const { setBaseEnv } = require('./testEnv');
setBaseEnv();

const request = require('supertest');
const { app } = require('../index');
const admin = require('firebase-admin');

const SECRET = process.env.INTERNAL_SECRET;

function seedLoan(loanId, overrides = {}) {
  admin.__seed('loans', loanId, {
    employeeName: 'Ana Torres',
    employerName: 'Acme SA de CV',
    employeeEmail: 'ana@example.com',
    amount: 1000,
    fee: 300,
    total: 1300,
    feeRate: 0.3,
    term: 30,
    dueDate: { toDate: () => new Date('2026-09-01T00:00:00Z') },
    ...overrides,
  });
}

beforeEach(() => {
  admin.__reset();
});

describe('POST /contracts/generate — malformed payloads', () => {
  test('400s when loanId is missing', async () => {
    const res = await request(app)
      .post('/contracts/generate')
      .set('x-internal-secret', SECRET)
      .send({ employeeId: 'emp_1' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'loanId and employeeId are required' });
  });

  test('400s when employeeId is missing', async () => {
    const res = await request(app)
      .post('/contracts/generate')
      .set('x-internal-secret', SECRET)
      .send({ loanId: 'loan_1' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'loanId and employeeId are required' });
  });

  test('404s when the loan does not exist', async () => {
    const res = await request(app)
      .post('/contracts/generate')
      .set('x-internal-secret', SECRET)
      .send({ loanId: 'does_not_exist', employeeId: 'emp_1' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Loan not found' });
  });

  // FIXED: a loan document missing dueDate (e.g. corrupted or partially
  // written) now returns a clear 422 validation error identifying the bad
  // field, instead of a generic 500 from loan.dueDate.toDate() throwing on
  // undefined -- ops can now tell a bad loan record from a service outage.
  test('422s with a clear validation error when the loan is missing dueDate', async () => {
    admin.__seed('loans', 'loan_bad', {
      employeeName: 'Ana Torres',
      employerName: 'Acme SA de CV',
      amount: 1000,
      fee: 300,
      total: 1300,
      feeRate: 0.3,
      term: 30,
      // dueDate intentionally omitted
    });
    const res = await request(app)
      .post('/contracts/generate')
      .set('x-internal-secret', SECRET)
      .send({ loanId: 'loan_bad', employeeId: 'emp_1' });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'Loan loan_bad is missing required field: dueDate' });
  });
});

describe('POST /contracts/generate — happy path (MetaMap signing disabled)', () => {
  test('generates a contract PDF, uploads it, and writes loan + employee document records', async () => {
    seedLoan('loan_1');

    const res = await request(app)
      .post('/contracts/generate')
      .set('x-internal-secret', SECRET)
      .send({ loanId: 'loan_1', employeeId: 'emp_1' });

    expect(res.status).toBe(200);
    expect(res.body.contractUrl).toMatch(
      /^https:\/\/storage\.googleapis\.com\/test-bucket\/loans\/loan_1\/contrato_\d+\.pdf$/,
    );

    const loan = admin.__get('loans', 'loan_1');
    expect(loan.contractUrl).toBe(res.body.contractUrl);
    expect(loan.contractStatus).toBe('generated');
    expect(loan.metamapDocumentId).toBeNull();
    expect(loan.metamapVerificationId).toBeNull();
    expect(loan.contractGeneratedAt).toBe('__mock_timestamp__');
    // Never-attempted signing must stay distinguishable from a failed
    // signing attempt (see 'signature_request_failed' below).
    expect(loan.signatureError).toBeUndefined();

    const docs = admin.__all('employees/emp_1/documents');
    expect(docs).toHaveLength(1);
    expect(docs[0].data).toMatchObject({
      type: 'loan_contract',
      loanId: 'loan_1',
      url: res.body.contractUrl,
    });
  });

  test('falls back to deriving feeRate from fee/amount when the loan predates that field', async () => {
    seedLoan('loan_3', { feeRate: undefined });

    const res = await request(app)
      .post('/contracts/generate')
      .set('x-internal-secret', SECRET)
      .send({ loanId: 'loan_3', employeeId: 'emp_3' });

    expect(res.status).toBe(200);
  });
});

describe('POST /contracts/generate — MetaMap signing enabled', () => {
  // index.js does `require('./src/metamap-signing-client')` lazily, inside
  // the route handler, on every request. That resolves to the same cached
  // module instance this test file gets from requiring it directly, so
  // spying on its exports here also intercepts index.js's calls.
  const signing = require('../src/metamap-signing-client');

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('happy path: signing succeeds and the contract is marked awaiting_signature', async () => {
    jest.spyOn(signing, 'isEnabled').mockReturnValue(true);
    jest.spyOn(signing, 'createSignedDocument').mockResolvedValue({ documentId: 'doc_123', status: 'pending' });
    seedLoan('loan_4');

    const res = await request(app)
      .post('/contracts/generate')
      .set('x-internal-secret', SECRET)
      .send({ loanId: 'loan_4', employeeId: 'emp_4', metamapVerificationId: 'verif_1' });

    expect(res.status).toBe(200);
    const loan = admin.__get('loans', 'loan_4');
    expect(loan.contractStatus).toBe('awaiting_signature');
    expect(loan.metamapDocumentId).toBe('doc_123');
    expect(loan.metamapVerificationId).toBe('verif_1');
  });

  // FIXED: when MetaMap signing throws (e.g. provider outage), the failure is
  // now observable -- a distinct terminal contractStatus that a
  // never-attempted signing can never reach, plus the error persisted on the
  // loan so ops can see what happened. The contract PDF itself still
  // generated fine, so the HTTP response stays 200; the fix lives entirely
  // in the loan document's shape, not the route's status semantics.
  test('signing failure is observable: contractStatus is signature_request_failed and the error is persisted', async () => {
    jest.spyOn(signing, 'isEnabled').mockReturnValue(true);
    jest.spyOn(signing, 'createSignedDocument').mockRejectedValue(new Error('MetaMap outage'));
    seedLoan('loan_5');

    const res = await request(app)
      .post('/contracts/generate')
      .set('x-internal-secret', SECRET)
      .send({ loanId: 'loan_5', employeeId: 'emp_5', metamapVerificationId: 'verif_2' });

    expect(res.status).toBe(200);
    const loan = admin.__get('loans', 'loan_5');
    expect(loan.contractStatus).toBe('signature_request_failed');
    expect(loan.metamapDocumentId).toBeNull();
    expect(loan.signatureError).toBe('MetaMap outage');
    expect(loan.signatureFailedAt).toBe('__mock_timestamp__');
  });
});
