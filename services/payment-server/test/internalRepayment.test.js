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
