'use strict';

// Money-correctness tests for the card repayment path.
//
// Every case here is a regression test for a way the two Conekta handlers
// used to forgive debt. They are kept separate from webhooksConekta.test.js
// (which covers transport: signatures, malformed payloads, routing) because
// these assert on balances, credit, and slots -- what the money actually did.

const { setBaseEnv, hmacSign } = require('./testEnv');
setBaseEnv();

const request = require('supertest');
const { app } = require('../index');
const admin = require('firebase-admin');
const { Queue } = require('bullmq');

const SECRET = process.env.CONEKTA_WEBHOOK_SECRET;

beforeEach(() => {
  admin.__reset();
  Queue.__reset();
});

function post(rawBody) {
  return request(app)
    .post('/webhooks/conekta')
    .set('Content-Type', 'application/json')
    .set('digest', hmacSign(SECRET, rawBody))
    .send(rawBody);
}

const event = (type, object) => JSON.stringify({ type, data: { object } });

// The canonical loan this file reasons about: 6,000 principal + 500 fee.
// The borrower owes 6,500; their credit line was reduced by 6,000.
const PRINCIPAL = 6000;
const TOTAL = 6500;

function seedLoan(id, overrides = {}) {
  admin.__seed('loans', id, {
    status: 'active',
    amount: PRINCIPAL,
    fee: 500,
    total: TOTAL,
    employeeId: 'emp_1',
    employerId: 'empr_1',
    ...overrides,
  });
  admin.__seed('employees', 'emp_1', { availableCredit: 0 });
  admin.__seed('employers', 'empr_1', { activeLoans: 2 });
}

const orderPaid = (loanId, chargeId, pesos, orderId = 'ord_x') =>
  event('order.paid', {
    id: orderId,
    amount: Math.round(pesos * 100),
    metadata: { loanId, employeeId: 'emp_1' },
    charges: { data: [{ id: chargeId, amount: Math.round(pesos * 100) }] },
  });

const chargePaid = (loanId, chargeId, pesos) =>
  event('charge.paid', {
    id: chargeId,
    amount: Math.round(pesos * 100),
    order_id: 'ord_x',
    metadata: { loanId, employeeId: 'emp_1' },
  });

// ── G1: order.paid used to settle with no balance check whatsoever ────────
describe('G1 — order.paid is balance-aware', () => {
  test('a partial payment does NOT settle the loan', async () => {
    seedLoan('loan_partial');

    // The original defect, exactly: 1,000 against a 6,500 obligation.
    const res = await post(orderPaid('loan_partial', 'ch_p1', 1000));
    expect(res.status).toBe(200);

    const loan = admin.__get('loans', 'loan_partial');
    expect(loan.status).toBe('active');           // NOT 'paid'
    expect(loan.remainingBalance).toBe(5500);     // 5,500 of real debt survives
    expect(loan.paidAmount).toBe(1000);

    // Credit comes back only for what was actually repaid...
    expect(admin.__get('employees', 'emp_1').availableCredit).toBe(1000);
    // ...and the employer's slot is still consumed, because the loan is open.
    expect(admin.__get('employers', 'empr_1').activeLoans).toBe(2);
    // Nobody is told their loan is paid off.
    expect(Queue.allAdded).toHaveLength(0);
  });

  test('a payment equal to the full obligation DOES settle the loan', async () => {
    seedLoan('loan_full');

    const res = await post(orderPaid('loan_full', 'ch_f1', TOTAL));
    expect(res.status).toBe(200);

    const loan = admin.__get('loans', 'loan_full');
    expect(loan.status).toBe('paid');
    expect(loan.remainingBalance).toBe(0);
    expect(loan.paidAmount).toBe(TOTAL);

    // Repaid 6,500 but only 6,000 of credit was ever held -- the fee must not
    // become new borrowing power.
    expect(admin.__get('employees', 'emp_1').availableCredit).toBe(PRINCIPAL);
    expect(admin.__get('employers', 'empr_1').activeLoans).toBe(1);
    expect(Queue.allAdded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ queue: 'vida-notifications', name: 'loan_paid' }),
        expect.objectContaining({ queue: 'vida-pdfs', name: 'repayment_receipt' }),
      ]),
    );
  });

  test('an overpayment settles once and still restores only the principal', async () => {
    seedLoan('loan_over');

    await post(orderPaid('loan_over', 'ch_o1', 7000));

    const loan = admin.__get('loans', 'loan_over');
    expect(loan.status).toBe('paid');
    expect(loan.remainingBalance).toBe(0); // never negative
    expect(admin.__get('employees', 'emp_1').availableCredit).toBe(PRINCIPAL);
  });
});

// ── G2: the obligation basis is `total`, never bare principal ─────────────
describe('G2 — the obligation basis is total, not principal', () => {
  test('order.paid: paying exactly the principal leaves the fee outstanding', async () => {
    seedLoan('loan_princ_order');

    await post(orderPaid('loan_princ_order', 'ch_pp1', PRINCIPAL));

    const loan = admin.__get('loans', 'loan_princ_order');
    expect(loan.status).toBe('active');
    expect(loan.remainingBalance).toBe(500); // the fee is still owed
  });

  test('charge.paid: paying exactly the principal leaves the fee outstanding', async () => {
    // The G2 defect verbatim: the fallback was `remainingBalance ?? amount`,
    // so a card-first repayment of the principal drove the balance to 0 and
    // the entire fee went uncollected. No remainingBalance is seeded here --
    // it is never initialised at loan creation, which is what made the
    // fallback the live code path rather than a corner case.
    seedLoan('loan_princ_charge');

    await post(chargePaid('loan_princ_charge', 'ch_pp2', PRINCIPAL));

    const loan = admin.__get('loans', 'loan_princ_charge');
    expect(loan.status).toBe('active');
    expect(loan.remainingBalance).toBe(500);
    expect(admin.__get('employers', 'empr_1').activeLoans).toBe(2);
  });

  test('a loan with neither remainingBalance nor total fails closed', async () => {
    // Falling back to `amount` (or to 0) would settle this loan for less than
    // it is owed. Refusing loudly is the only safe direction.
    seedLoan('loan_corrupt', { total: undefined, remainingBalance: undefined });

    const res = await post(orderPaid('loan_corrupt', 'ch_c1', 100));
    expect(res.status).toBe(500);

    expect(admin.__get('loans', 'loan_corrupt').status).toBe('active');
    expect(admin.__all('incident_log').some((i) => /no valid outstanding obligation/.test(i.data.error))).toBe(true);
  });
});

// ── G3: the two handlers are jointly idempotent ───────────────────────────
describe('G3 — order.paid and charge.paid dedupe against each other', () => {
  test('both events for the SAME payment apply the money exactly once', async () => {
    seedLoan('loan_both');

    // A paid Conekta order contains its charge, so both events can arrive for
    // one card payment. Before this fix, order.paid wrote an unkeyed repayment
    // row and checked nothing, so the pair settled the loan AND decremented
    // the balance -- two rows, one payment.
    const first = await post(orderPaid('loan_both', 'ch_both', 1000));
    const second = await post(chargePaid('loan_both', 'ch_both', 1000));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const loan = admin.__get('loans', 'loan_both');
    expect(loan.remainingBalance).toBe(5500); // decremented once, not twice
    expect(loan.paidAmount).toBe(1000);
    expect(loan.status).toBe('active');
    expect(admin.__get('employees', 'emp_1').availableCredit).toBe(1000);
    expect(admin.__all('repayments')).toHaveLength(1);
  });

  test('the same pair in the opposite order behaves identically', async () => {
    seedLoan('loan_both_rev');

    await post(chargePaid('loan_both_rev', 'ch_rev', 1000));
    await post(orderPaid('loan_both_rev', 'ch_rev', 1000));

    expect(admin.__get('loans', 'loan_both_rev').remainingBalance).toBe(5500);
    expect(admin.__all('repayments')).toHaveLength(1);
  });

  test('a settling payment delivered as both events settles once and frees one slot', async () => {
    seedLoan('loan_both_full');

    await post(orderPaid('loan_both_full', 'ch_bf', TOTAL));
    await post(chargePaid('loan_both_full', 'ch_bf', TOTAL));

    expect(admin.__get('loans', 'loan_both_full').status).toBe('paid');
    expect(admin.__get('employees', 'emp_1').availableCredit).toBe(PRINCIPAL);
    expect(admin.__get('employers', 'empr_1').activeLoans).toBe(1); // not 0
    expect(admin.__all('repayments')).toHaveLength(1);
    // And exactly one receipt, not two.
    expect(Queue.allAdded.filter((j) => j.name === 'repayment_receipt')).toHaveLength(1);
  });

  test('a replayed order.paid is a no-op', async () => {
    seedLoan('loan_replay');

    await post(orderPaid('loan_replay', 'ch_r1', 1000));
    await post(orderPaid('loan_replay', 'ch_r1', 1000));
    await post(orderPaid('loan_replay', 'ch_r1', 1000));

    const loan = admin.__get('loans', 'loan_replay');
    expect(loan.remainingBalance).toBe(5500);
    expect(loan.paidAmount).toBe(1000);
    expect(admin.__get('employees', 'emp_1').availableCredit).toBe(1000);
    expect(admin.__all('repayments')).toHaveLength(1);
  });

  test('successive DISTINCT charges accumulate and settle on the last one', async () => {
    seedLoan('loan_instalments');

    await post(chargePaid('loan_instalments', 'ch_i1', 2000));
    await post(chargePaid('loan_instalments', 'ch_i2', 2000));
    expect(admin.__get('loans', 'loan_instalments').status).toBe('active');
    expect(admin.__get('employees', 'emp_1').availableCredit).toBe(4000);

    await post(chargePaid('loan_instalments', 'ch_i3', 2500));

    const loan = admin.__get('loans', 'loan_instalments');
    expect(loan.status).toBe('paid');
    expect(loan.remainingBalance).toBe(0);
    expect(loan.paidAmount).toBe(TOTAL);
    // Cumulative restoration is capped at the principal even though 6,500 was
    // repaid across three charges.
    expect(admin.__get('employees', 'emp_1').availableCredit).toBe(PRINCIPAL);
    expect(admin.__get('employers', 'empr_1').activeLoans).toBe(1);
  });
});

// ── G4: the employer slot ─────────────────────────────────────────────────
describe('G4 — employer activeLoans slot', () => {
  test('is never driven below zero by a loan that was never counted', async () => {
    seedLoan('loan_zero_slot');
    admin.__seed('employers', 'empr_1', { activeLoans: 0 });

    await post(orderPaid('loan_zero_slot', 'ch_z1', TOTAL));

    expect(admin.__get('loans', 'loan_zero_slot').status).toBe('paid');
    expect(admin.__get('employers', 'empr_1').activeLoans).toBe(0);
  });

  test('a missing employer document does not abort the settlement', async () => {
    seedLoan('loan_no_employer', { employerId: 'empr_missing' });

    const res = await post(orderPaid('loan_no_employer', 'ch_ne1', TOTAL));

    expect(res.status).toBe(200);
    expect(admin.__get('loans', 'loan_no_employer').status).toBe('paid');
    expect(admin.__get('employees', 'emp_1').availableCredit).toBe(PRINCIPAL);
  });
});

// ── Attribution and rounding ──────────────────────────────────────────────
describe('attribution and rounding', () => {
  test('credit is restored to the loan document’s employee, not the webhook metadata’s', async () => {
    // The signature is verified, so metadata is not attacker-controlled -- but
    // a mis-tagged Conekta order would otherwise credit a stranger's line.
    seedLoan('loan_attr', { employeeId: 'emp_real' });
    admin.__seed('employees', 'emp_real', { availableCredit: 0 });

    await post(orderPaid('loan_attr', 'ch_a1', TOTAL));

    expect(admin.__get('employees', 'emp_real').availableCredit).toBe(PRINCIPAL);
    expect(admin.__get('employees', 'emp_1').availableCredit).toBe(0);
  });

  test('centavo-level payments settle exactly, without float drift', async () => {
    seedLoan('loan_cents', { amount: 100.1, total: 100.3, remainingBalance: undefined });

    await post(chargePaid('loan_cents', 'ch_cent1', 0.1));
    await post(chargePaid('loan_cents', 'ch_cent2', 0.2));
    expect(admin.__get('loans', 'loan_cents').remainingBalance).toBe(100);
    expect(admin.__get('loans', 'loan_cents').status).toBe('active');

    await post(chargePaid('loan_cents', 'ch_cent3', 100));
    expect(admin.__get('loans', 'loan_cents').status).toBe('paid');
    expect(admin.__get('loans', 'loan_cents').remainingBalance).toBe(0);
  });

  test('an order.paid carrying no attributable charge applies nothing and is logged', async () => {
    seedLoan('loan_nocharge');

    const body = event('order.paid', {
      id: 'ord_nc',
      amount: 650000,
      metadata: { loanId: 'loan_nocharge', employeeId: 'emp_1' },
      charges: { data: [] },
    });
    const res = await post(body);

    // 200 -- Conekta should not retry, because retrying cannot help. But no
    // money moves under an order-scoped key that a later charge.paid would
    // then double-apply.
    expect(res.status).toBe(200);
    expect(admin.__get('loans', 'loan_nocharge').status).toBe('active');
    expect(admin.__all('repayments')).toHaveLength(0);
    expect(admin.__all('incident_log').some((i) => /no attributable charge/.test(i.data.error))).toBe(true);
  });

  test('an order with two charges applies each one, keyed separately', async () => {
    seedLoan('loan_multi');

    const body = event('order.paid', {
      id: 'ord_m',
      amount: 400000,
      metadata: { loanId: 'loan_multi', employeeId: 'emp_1' },
      charges: { data: [{ id: 'ch_m1', amount: 150000 }, { id: 'ch_m2', amount: 250000 }] },
    });
    expect((await post(body)).status).toBe(200);

    const loan = admin.__get('loans', 'loan_multi');
    expect(loan.remainingBalance).toBe(2500); // 6500 - 1500 - 2500
    expect(admin.__all('repayments')).toHaveLength(2);

    // Each charge's own charge.paid must now be a no-op.
    await post(chargePaid('loan_multi', 'ch_m1', 1500));
    await post(chargePaid('loan_multi', 'ch_m2', 2500));
    expect(admin.__get('loans', 'loan_multi').remainingBalance).toBe(2500);
    expect(admin.__all('repayments')).toHaveLength(2);
  });

  test('a payment against a loan that does not exist moves nothing', async () => {
    const res = await post(orderPaid('loan_ghost', 'ch_g1', 1000));
    expect(res.status).toBe(200);
    expect(admin.__all('repayments')).toHaveLength(0);
    expect(Queue.allAdded).toHaveLength(0);
  });
});
