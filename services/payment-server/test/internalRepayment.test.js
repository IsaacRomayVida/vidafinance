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

test('happy path: a deduction covering the whole obligation marks the loan paid, records the repayment, credits the employee', async () => {
  // 2500 principal + 750 fee = 3250 owed. The credit line was reduced by the
  // PRINCIPAL at origination, so only the principal may come back.
  admin.__seed('loans', 'loan_1', { status: 'active', amount: 2500, total: 3250, employeeId: 'emp_1' });
  admin.__seed('employees', 'emp_1', { availableCredit: 500 });

  const res = await postRepayment({ loanId: 'loan_1', employeeId: 'emp_1', amount: 3250, ref: 'SC-REF-1' });

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ success: true, status: 'applied' });

  const loan = admin.__get('loans', 'loan_1');
  expect(loan.status).toBe('paid');
  expect(loan.paidAmount).toBe(3250);
  expect(loan.remainingBalance).toBe(0);
  expect(loan.repaymentRef).toBe('SC-REF-1');

  expect(admin.__get('employees', 'emp_1').availableCredit).toBe(500 + 2500);

  const repayments = admin.__all('repayments');
  expect(repayments).toHaveLength(1);
  // Keyed by the deduction reference, so a replayed sync cannot apply it twice.
  expect(repayments[0].id).toBe('payroll_SC-REF-1');
  expect(repayments[0].data).toMatchObject({
    loanId: 'loan_1',
    employeeId: 'emp_1',
    amount: 3250,
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
  admin.__seed('loans', 'loan_x', { status: 'active', amount: 100, total: 130 });
  const res = await postRepayment({ loanId: 'loan_x', employeeId: 'emp_x', amount: 130, ref: 'SC-REF-X' });
  expect(res.status).toBe(200);
  expect(admin.__all('repayments')[0].data.method).toBe('payroll_deduction');
});

test('idempotent: replaying against an already-paid loan does not double-credit or re-notify', async () => {
  admin.__seed('loans', 'loan_2', { status: 'paid', amount: 1000, total: 1300, employeeId: 'emp_2' });
  admin.__seed('employees', 'emp_2', { availableCredit: 300 });

  const res = await postRepayment({ loanId: 'loan_2', employeeId: 'emp_2', amount: 1300, ref: 'replay' });

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ success: true, status: 'already_paid' });
  expect(admin.__get('employees', 'emp_2').availableCredit).toBe(300);
  expect(admin.__get('loans', 'loan_2').status).toBe('paid');
  // The row IS written -- keyed by the deduction reference, marked unapplied.
  // It is money that came out of a paycheck and could not be applied, which is
  // a reconciliation question for a human; dropping it silently would erase the
  // only trace of it. Same stance as the card path's already-settled branch.
  const repayments = admin.__all('repayments');
  expect(repayments).toHaveLength(1);
  expect(repayments[0].data).toMatchObject({ status: 'unapplied', unappliedReason: 'loan_already_settled' });
  // The borrower was already told once. A replay must not tell them again.
  expect(Queue.allAdded).toHaveLength(0);
});

test('an unknown loanId is a 404, writes nothing, and queues no notification', async () => {
  const res = await postRepayment({ loanId: 'does-not-exist', employeeId: 'emp_9', amount: 100, ref: 'SC-REF-9' });

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
  admin.__seed('loans', 'loan_3', { status: 'repaid', amount: 2500, total: 3250, employeeId: 'emp_3' });
  admin.__seed('employees', 'emp_3', { availableCredit: 2800 }); // already restored once by the repaid trigger

  const res = await postRepayment({ loanId: 'loan_3', employeeId: 'emp_3', amount: 3250, ref: 'SC-REF-3' });

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ success: true, status: 'already_paid' });
  expect(admin.__get('employees', 'emp_3').availableCredit).toBe(2800);
  expect(admin.__get('loans', 'loan_3').status).toBe('repaid');
  expect(admin.__all('repayments')[0].data).toMatchObject({ status: 'unapplied', unappliedReason: 'loan_already_settled' });
  expect(Queue.allAdded).toHaveLength(0);
});

// ── The payroll channel settling for less than it collected ──────────────
//
// This route never compared `amount` to what the loan owed. It wrote
// `status: 'paid'`, `paidAmount: amount` and incremented the employee's
// availableCredit by the whole principal, for ANY truthy amount.
//
// `amount` is not ours. It is `item.amount` from SoftCrédito's
// GET /deductions/completed, forwarded verbatim by the adapter's
// /internal/sync-repayments (softcredito-adapter/index.js:388-404). A payroll
// run that could only withhold part of the installment -- unpaid leave, a
// short paycheck, a partial run -- reports exactly that, and this route read
// it as "the debt is gone".
describe('a deduction smaller than the obligation', () => {
  const seedLoan = () => {
    admin.__seed('loans', 'loan_partial', {
      status: 'active', amount: 5000, total: 6500, remainingBalance: 6500,
      employeeId: 'emp_partial', employerId: 'empr_partial',
    });
    admin.__seed('employees', 'emp_partial', { availableCredit: 0 });
    admin.__seed('employers', 'empr_partial', { activeLoans: 4 });
  };

  test('leaves the loan active with the rest of the debt still owed', async () => {
    seedLoan();

    const res = await postRepayment({
      loanId: 'loan_partial', employeeId: 'emp_partial', amount: 500, ref: 'SC-SHORT-1',
    });

    expect(res.status).toBe(200);
    const loan = admin.__get('loans', 'loan_partial');
    // Before: status 'paid', 6,000 of real debt forgiven.
    expect(loan.status).toBe('active');
    expect(loan.remainingBalance).toBe(6000);
    expect(loan.paidAmount).toBe(500);
  });

  test('restores only what was actually repaid, not the whole credit line', async () => {
    seedLoan();

    await postRepayment({ loanId: 'loan_partial', employeeId: 'emp_partial', amount: 500, ref: 'SC-SHORT-2' });

    // Before: +5000, the full principal, for a 500 payment -- so the borrower
    // could immediately re-borrow money they still owed.
    expect(admin.__get('employees', 'emp_partial').availableCredit).toBe(500);
    expect(admin.__get('loans', 'loan_partial').creditRestored).toBe(500);
  });

  test('does not tell the borrower their loan is paid, and does not free the employer slot', async () => {
    seedLoan();

    await postRepayment({ loanId: 'loan_partial', employeeId: 'emp_partial', amount: 500, ref: 'SC-SHORT-3' });

    expect(Queue.allAdded).toHaveLength(0);
    expect(admin.__get('employers', 'empr_partial').activeLoans).toBe(4);
  });

  test('successive deductions accumulate and the last one settles the loan', async () => {
    seedLoan();

    await postRepayment({ loanId: 'loan_partial', employeeId: 'emp_partial', amount: 3250, ref: 'SC-INST-1' });
    let loan = admin.__get('loans', 'loan_partial');
    expect(loan.status).toBe('active');
    expect(loan.remainingBalance).toBe(3250);
    // Restoration is a delta toward min(principal, repaid), never the fee.
    expect(admin.__get('employees', 'emp_partial').availableCredit).toBe(3250);

    await postRepayment({ loanId: 'loan_partial', employeeId: 'emp_partial', amount: 3250, ref: 'SC-INST-2' });
    loan = admin.__get('loans', 'loan_partial');
    expect(loan.status).toBe('paid');
    expect(loan.remainingBalance).toBe(0);
    expect(loan.paidAmount).toBe(6500);
    // 5,000 principal is the ceiling: the 1,500 fee is not new borrowing power.
    expect(admin.__get('employees', 'emp_partial').availableCredit).toBe(5000);
    // G4: the origination slot comes back when the loan actually closes.
    expect(admin.__get('employers', 'empr_partial').activeLoans).toBe(3);
    expect(Queue.allAdded).toHaveLength(1);
  });

  // Once a partial deduction leaves the loan `active`, the settled-status
  // guard can no longer catch a replayed sync -- the repayment row keyed by
  // the deduction reference is the only thing that does.
  test('replaying the same deduction reference applies the money once', async () => {
    seedLoan();
    const body = { loanId: 'loan_partial', employeeId: 'emp_partial', amount: 3250, ref: 'SC-DUP' };

    expect((await postRepayment(body)).status).toBe(200);
    const second = await postRepayment(body);

    expect(second.status).toBe(200);
    expect(second.body).toEqual({ success: true, status: 'duplicate' });
    expect(admin.__get('loans', 'loan_partial').remainingBalance).toBe(3250);
    expect(admin.__get('employees', 'emp_partial').availableCredit).toBe(3250);
    expect(admin.__all('repayments')).toHaveLength(1);
  });
});

// The loan document is authoritative for whose debt this is. This route read
// `employees/{req.body.employeeId}` and incremented it by the loan's full
// principal without ever looking at `loans/{loanId}.employeeId`, so the
// employee named in the payload was credited whether or not the loan was
// theirs.
test('credit is restored to the loan\'s own employee, not the one named in the payload', async () => {
  admin.__seed('loans', 'loan_owner', {
    status: 'active', amount: 5000, total: 6500, remainingBalance: 6500, employeeId: 'emp_owner',
  });
  admin.__seed('employees', 'emp_owner', { availableCredit: 0 });
  admin.__seed('employees', 'emp_other', { availableCredit: 0 });

  const res = await postRepayment({
    loanId: 'loan_owner', employeeId: 'emp_other', amount: 6500, ref: 'SC-WRONG-EMP',
  });

  expect(res.status).toBe(200);
  // Before: emp_other walked away with 5,000 of borrowing power for somebody
  // else's repayment.
  expect(admin.__get('employees', 'emp_other').availableCredit).toBe(0);
  expect(admin.__get('employees', 'emp_owner').availableCredit).toBe(5000);
  // ...and the repayment is filed against the borrower who actually owes it.
  expect(admin.__all('repayments')[0].data.employeeId).toBe('emp_owner');
});

// `!amount` rejects 0 and '' and nothing else.
describe('amounts that are not money', () => {
  beforeEach(() => {
    admin.__seed('loans', 'loan_amt', {
      status: 'active', amount: 5000, total: 6500, remainingBalance: 6500, employeeId: 'emp_amt',
    });
    admin.__seed('employees', 'emp_amt', { availableCredit: 0 });
  });

  test.each([
    ['a negative amount', -500],
    ['a numeric string', '6500'],
    ['an array', []],
    ['an object', { amount: 6500 }],
  ])('%s is refused and moves nothing', async (_label, amount) => {
    const res = await postRepayment({ loanId: 'loan_amt', employeeId: 'emp_amt', amount, ref: 'SC-BAD-AMT' });

    expect(res.status).toBe(400);
    expect(admin.__get('loans', 'loan_amt').status).toBe('active');
    expect(admin.__get('loans', 'loan_amt').paidAmount).toBeUndefined();
    expect(admin.__get('employees', 'emp_amt').availableCredit).toBe(0);
    expect(admin.__all('repayments')).toHaveLength(0);
    expect(Queue.allAdded).toHaveLength(0);
  });
});

// Without a usable reference there is no idempotency key, and a payroll
// deduction that can be applied twice is worse than one held for
// reconciliation. `/` matters on its own: concatenated into the row id it
// addresses a different document entirely, so the caller would be choosing
// what the replay guard collides with.
describe('deduction references that cannot key a payment', () => {
  beforeEach(() => {
    admin.__seed('loans', 'loan_ref', {
      status: 'active', amount: 5000, total: 6500, remainingBalance: 6500, employeeId: 'emp_ref',
    });
    admin.__seed('employees', 'emp_ref', { availableCredit: 0 });
  });

  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['a path fragment', 'a/b/c'],
    ['not a string', 12345],
  ])('%s is refused, recorded, and moves nothing', async (_label, ref) => {
    const res = await postRepayment({ loanId: 'loan_ref', employeeId: 'emp_ref', amount: 6500, ref });

    expect(res.status).toBe(400);
    expect(admin.__get('loans', 'loan_ref').status).toBe('active');
    expect(admin.__get('employees', 'emp_ref').availableCredit).toBe(0);
    expect(admin.__all('repayments')).toHaveLength(0);
    expect(Queue.allAdded).toHaveLength(0);
    // A rejection nobody can see is how the payroll channel goes quiet.
    expect(admin.__all('incident_log').some((i) => i.data.source === 'internal-repayment')).toBe(true);
  });
});
