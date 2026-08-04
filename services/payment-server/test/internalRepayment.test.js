'use strict';

const { setBaseEnv } = require('./testEnv');
setBaseEnv();

const request = require('supertest');
const { app } = require('../index');
const admin = require('firebase-admin');
const { Queue } = require('bullmq');

const SECRET = process.env.INTERNAL_SECRET;

beforeEach(() => {
  admin.__reset();
  Queue.__reset();
});

function postRepayment(body) {
  return request(app).post('/internal/repayment').set('x-internal-secret', SECRET).send(body);
}

test('400s when loanId, employeeId, or amount is missing', async () => {
  const res = await postRepayment({ loanId: 'loan_1', employeeId: 'emp_1' });
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: 'Missing fields' });
});

test('happy path: marks the loan paid, records the repayment, credits the employee', async () => {
  admin.__seed('loans', 'loan_1', { status: 'active', amount: 2500 });
  admin.__seed('employees', 'emp_1', { availableCredit: 500 });

  const res = await postRepayment({ loanId: 'loan_1', employeeId: 'emp_1', amount: 2500, ref: 'SC-REF-1' });

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ success: true, status: 'applied' });

  const loan = admin.__get('loans', 'loan_1');
  expect(loan.status).toBe('paid');
  expect(loan.paidAmount).toBe(2500);
  expect(loan.repaymentRef).toBe('SC-REF-1');

  expect(admin.__get('employees', 'emp_1').availableCredit).toBe(500 + 2500);

  const repayments = admin.__all('repayments');
  expect(repayments).toHaveLength(1);
  expect(repayments[0].data).toMatchObject({
    loanId: 'loan_1',
    employeeId: 'emp_1',
    amount: 2500,
    method: 'payroll_deduction',
    externalRef: 'SC-REF-1',
  });

  expect(Queue.allAdded).toContainEqual(
    expect.objectContaining({ queue: 'vida-notifications', name: 'loan_paid' }),
  );
});

// The regression that made every test above green while the route could not
// settle a single real payroll deduction.
//
// The transaction read the employee document AFTER updating the loan and
// setting the repayment row. Real Firestore rejects that outright --
// `Transaction.get()` throws "Firestore transactions require all reads to be
// executed before all writes." as soon as the write batch is non-empty -- so
// the transaction never committed and the route answered 500 for every call
// that had money to apply. The only calls that succeeded were the two that
// write nothing: the 404 and the already-settled replay.
//
// The in-memory Firestore stand-in now enforces that rule (see
// __mocks__/firebase-admin.js), so this asserts it end to end: the loan
// settles, the repayment row lands, and the credit line comes back, all from
// one transaction. Revert the read to below the writes and this fails 500,
// as do the two happy-path tests above.
test('settles from a single transaction that reads before it writes (real Firestore rejects the reverse)', async () => {
  admin.__seed('loans', 'loan_ro', { status: 'active', amount: 5000, total: 6500 });
  admin.__seed('employees', 'emp_ro', { availableCredit: 0 });

  const res = await postRepayment({ loanId: 'loan_ro', employeeId: 'emp_ro', amount: 6500, ref: 'SC-REF-RO' });

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ success: true, status: 'applied' });

  // The borrower's payroll deduction is recorded against the debt...
  expect(admin.__get('loans', 'loan_ro').status).toBe('paid');
  expect(admin.__all('repayments')).toHaveLength(1);
  // ...and their credit line is restored by the principal, not the total: the
  // fee was never held against it at origination.
  expect(admin.__get('employees', 'emp_ro').availableCredit).toBe(5000);
});

test('defaults method to payroll_deduction when not supplied', async () => {
  admin.__seed('loans', 'loan_x', { status: 'active', amount: 100 });
  const res = await postRepayment({ loanId: 'loan_x', employeeId: 'emp_x', amount: 100 });
  expect(res.status).toBe(200);
  expect(admin.__all('repayments')[0].data.method).toBe('payroll_deduction');
});

test('idempotent: replaying against an already-paid loan does not double-credit or re-notify', async () => {
  admin.__seed('loans', 'loan_2', { status: 'paid', amount: 1000 });
  admin.__seed('employees', 'emp_2', { availableCredit: 300 });

  const res = await postRepayment({ loanId: 'loan_2', employeeId: 'emp_2', amount: 1000, ref: 'replay' });

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ success: true, status: 'already_paid' });
  expect(admin.__get('employees', 'emp_2').availableCredit).toBe(300);
  expect(admin.__all('repayments')).toHaveLength(0);
  // The borrower was already told once. A replay must not tell them again.
  expect(Queue.allAdded).toHaveLength(0);
});

test('an unknown loanId is a 404, writes nothing, and queues no notification', async () => {
  const res = await postRepayment({ loanId: 'does-not-exist', employeeId: 'emp_9', amount: 100, ref: 'r' });

  expect(res.status).toBe(404);
  expect(res.body).toMatchObject({ error: 'Loan not found', loanId: 'does-not-exist' });
  expect(admin.__all('repayments')).toHaveLength(0);
  expect(Queue.allAdded).toHaveLength(0);
});

// A loan already closed by the OTHER repayment channel -- processPayroll.ts's
// employer-CSV path, which writes the canonical 'repaid' spelling and whose
// onLoanStatusChange trigger already restored the employee's availableCredit
// once for that closure -- must be recognised as settled here too. The
// SoftCrédito daily sync (dailyLoanCheck -> softcredito-adapter's
// /internal/sync-repayments) can observe its own registered deduction as
// "completed" for a loan the payroll-CSV path already closed first (the two
// channels race for the same underlying payroll cycle), and this route is the
// one that decides whether that second signal moves any more money.
test('replaying against a loan already closed as `repaid` by the payroll-CSV path does not double-credit', async () => {
  admin.__seed('loans', 'loan_3', { status: 'repaid', amount: 2500 });
  admin.__seed('employees', 'emp_3', { availableCredit: 2800 }); // already restored once by the repaid trigger

  const res = await postRepayment({ loanId: 'loan_3', employeeId: 'emp_3', amount: 2500, ref: 'SC-REF-3' });

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ success: true, status: 'already_paid' });
  expect(admin.__get('employees', 'emp_3').availableCredit).toBe(2800);
  expect(admin.__all('repayments')).toHaveLength(0);
  expect(Queue.allAdded).toHaveLength(0);
});
