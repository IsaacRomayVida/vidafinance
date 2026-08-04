'use strict';

const crypto = require('crypto');
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

function post(rawBody, headers = {}) {
  const req = request(app).post('/webhooks/conekta').set('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  return req.send(rawBody);
}

function conektaEvent(type, object) {
  return JSON.stringify({ type, data: { object } });
}

// ── Signature verification (HMAC branch) ────────────────────────────────
describe('signature verification — HMAC secret', () => {
  test('rejects a request with no signature header at all', async () => {
    const body = conektaEvent('order.paid', { id: 'ord_1', amount: 10000, metadata: {}, charges: { data: [] } });
    const res = await post(body);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid signature' });
  });

  test('rejects a request with a wrong signature', async () => {
    const body = conektaEvent('order.paid', { id: 'ord_1', amount: 10000, metadata: {}, charges: { data: [] } });
    const res = await post(body, { digest: 'not-the-right-signature' });
    expect(res.status).toBe(401);
    // Rejected webhooks are recorded, not silently dropped.
    const incidents = admin.__all('incident_log');
    expect(incidents).toHaveLength(1);
    expect(incidents[0].data.error).toBe('invalid_signature');
  });

  test('accepts a request with a correctly computed signature', async () => {
    const body = conektaEvent('order.payment_failed', { id: 'ord_2', metadata: { loanId: 'loan_1' }, payment_status: 'declined' });
    const sig = hmacSign(SECRET, body);
    const res = await post(body, { digest: sig });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  test('also accepts the signature via the x-conekta-signature header', async () => {
    const body = conektaEvent('order.payment_failed', { id: 'ord_3', metadata: { loanId: 'loan_1' }, payment_status: 'declined' });
    const sig = hmacSign(SECRET, body);
    const res = await post(body, { 'x-conekta-signature': sig });
    expect(res.status).toBe(200);
  });
});

// ── Signature verification under a misconfigured secret ─────────────────
// The verifier reads CONEKTA_WEBHOOK_SECRET and branches on
// `pubKey.startsWith('-----BEGIN PUBLIC KEY')`. An UNSET secret makes that
// throw, and the catch fails closed — that case is a control below. An EMPTY
// secret does not throw: it falls through to the HMAC branch and derives the
// expected digest from a zero-length key, which any caller can also derive.
// That made every event on this route forgeable — including `charge.paid`,
// which runs applyCardRepayment and can settle a loan and mint a receipt for
// money that was never received.
describe('signature verification — misconfigured secret', () => {
  const REAL_SECRET = process.env.CONEKTA_WEBHOOK_SECRET;

  afterEach(() => {
    process.env.CONEKTA_WEBHOOK_SECRET = REAL_SECRET;
  });

  const forgeable = () =>
    conektaEvent('charge.paid', {
      id: 'chg_forged',
      order_id: 'ord_forged',
      amount: 500000,
      metadata: { loanId: 'loan_1', employeeId: 'emp_1' },
    });

  // CONTROL — passes before and after: startsWith() throws on undefined and
  // the catch already fails closed.
  test('rejects a forged event when CONEKTA_WEBHOOK_SECRET is unset', async () => {
    delete process.env.CONEKTA_WEBHOOK_SECRET;
    const body = forgeable();
    const res = await post(body, { digest: hmacSign('', body) });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid signature' });
  });

  // RED before the fix: answered 200 and applied the forged repayment.
  test('rejects a forged event when CONEKTA_WEBHOOK_SECRET is set but empty', async () => {
    process.env.CONEKTA_WEBHOOK_SECRET = '';
    const body = forgeable();
    const res = await post(body, { digest: hmacSign('', body) });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid signature' });
    const incidents = admin.__all('incident_log');
    expect(incidents).toHaveLength(1);
    expect(incidents[0].data.error).toBe('invalid_signature');
  });

  // CONTROL — passes before and after: a properly configured secret still
  // accepts a correctly signed event.
  test('still accepts a correctly signed event with the secret configured', async () => {
    const body = conektaEvent('order.payment_failed', {
      id: 'ord_cfg',
      metadata: { loanId: 'loan_1' },
      payment_status: 'declined',
    });
    const res = await post(body, { digest: hmacSign(REAL_SECRET, body) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });
});

describe('signature verification — RSA public-key secret', () => {
  let publicKeyPem, privateKey;

  beforeAll(() => {
    const { publicKey, privateKey: priv } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    privateKey = priv;
  });

  beforeEach(() => {
    process.env.CONEKTA_WEBHOOK_SECRET = publicKeyPem;
  });

  afterAll(() => {
    // Restore, so later describe blocks in this file still sign with the
    // plain HMAC secret they were written against.
    process.env.CONEKTA_WEBHOOK_SECRET = SECRET;
  });

  test('accepts a request signed with the matching private key', async () => {
    const body = conektaEvent('order.payment_failed', { id: 'ord_4', metadata: { loanId: 'loan_1' }, payment_status: 'declined' });
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(body);
    const sig = signer.sign(privateKey, 'base64');

    const res = await post(body, { digest: sig });
    expect(res.status).toBe(200);
  });

  test('rejects a request signed with a different (unrelated) private key', async () => {
    const { privateKey: otherKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const body = conektaEvent('order.payment_failed', { id: 'ord_5', metadata: { loanId: 'loan_1' }, payment_status: 'declined' });
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(body);
    const sig = signer.sign(otherKey, 'base64');

    const res = await post(body, { digest: sig });
    expect(res.status).toBe(401);
  });
});

// ── order.paid ───────────────────────────────────────────────────────────
describe('order.paid', () => {
  test('happy path: paying the full obligation marks the loan paid, records the repayment, credits the employee', async () => {
    // A realistic loan: 5000 principal + 500 fee = 5500 owed. The borrower's
    // credit line was reduced by the PRINCIPAL at origination, so only the
    // principal may come back -- not the 5500 they handed over.
    admin.__seed('loans', 'loan_1', { status: 'active', amount: 5000, fee: 500, total: 5500, employeeId: 'emp_1', employerId: 'empr_1' });
    admin.__seed('employees', 'emp_1', { availableCredit: 1000 });
    admin.__seed('employers', 'empr_1', { activeLoans: 3 });

    const body = conektaEvent('order.paid', {
      id: 'ord_10',
      amount: 550000, // centavos
      metadata: { loanId: 'loan_1', employeeId: 'emp_1' },
      charges: { data: [{ id: 'ch_1', amount: 550000 }] },
    });
    const res = await post(body, { digest: hmacSign(SECRET, body) });

    expect(res.status).toBe(200);
    const loan = admin.__get('loans', 'loan_1');
    expect(loan.status).toBe('paid');
    expect(loan.paidAmount).toBe(5500);
    expect(loan.remainingBalance).toBe(0);
    expect(loan.repaymentRef).toBe('ch_1');

    const employee = admin.__get('employees', 'emp_1');
    expect(employee.availableCredit).toBe(1000 + 5000);

    // G4: the employer's origination slot is released on full card repayment.
    expect(admin.__get('employers', 'empr_1').activeLoans).toBe(2);

    const repayments = admin.__all('repayments');
    expect(repayments).toHaveLength(1);
    // Keyed by charge id, so the sibling charge.paid for this same payment
    // cannot apply the money a second time.
    expect(repayments[0].id).toBe('conekta_ch_1');
    expect(repayments[0].data).toMatchObject({ loanId: 'loan_1', employeeId: 'emp_1', amount: 5500, method: 'card' });

    expect(Queue.allAdded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ queue: 'vida-notifications', name: 'loan_paid' }),
        expect.objectContaining({ queue: 'vida-pdfs', name: 'repayment_receipt' }),
      ]),
    );
  });

  test('malformed payload: missing loanId/employeeId metadata is a 500, and is recorded', async () => {
    const body = conektaEvent('order.paid', {
      id: 'ord_11',
      amount: 500000,
      metadata: {},
      charges: { data: [{ id: 'ch_2' }] },
    });
    const res = await post(body, { digest: hmacSign(SECRET, body) });

    expect(res.status).toBe(500);
    const incidents = admin.__all('incident_log');
    expect(incidents.some((i) => i.data.error === 'Missing metadata')).toBe(true);
  });

  test('a charge landing on an already-settled loan moves no money and is recorded as unapplied', async () => {
    admin.__seed('loans', 'loan_2', { status: 'paid', amount: 5000, total: 5500, employeeId: 'emp_2', employerId: 'empr_2' });
    admin.__seed('employees', 'emp_2', { availableCredit: 1000 });
    admin.__seed('employers', 'empr_2', { activeLoans: 3 });

    const body = conektaEvent('order.paid', {
      id: 'ord_12',
      amount: 500000,
      metadata: { loanId: 'loan_2', employeeId: 'emp_2' },
      charges: { data: [{ id: 'ch_3', amount: 500000 }] },
    });
    const res = await post(body, { digest: hmacSign(SECRET, body) });

    expect(res.status).toBe(200);
    // No credit restored a second time, and the slot is not released twice.
    expect(admin.__get('employees', 'emp_2').availableCredit).toBe(1000);
    expect(admin.__get('employers', 'empr_2').activeLoans).toBe(3);

    // The row IS written -- keyed by charge id, marked unapplied. It is money
    // that arrived and could not be applied (overpayment, duplicate checkout,
    // wrong loan), which is a reconciliation question for a human; dropping it
    // silently would erase the only trace of it.
    const repayments = admin.__all('repayments');
    expect(repayments).toHaveLength(1);
    expect(repayments[0].data).toMatchObject({ status: 'unapplied', unappliedReason: 'loan_already_settled' });
  });
});

// ── charge.paid ──────────────────────────────────────────────────────────
describe('charge.paid', () => {
  test('happy path: decrements remainingBalance and records a repayment', async () => {
    admin.__seed('loans', 'loan_3', { status: 'active', amount: 3000, remainingBalance: 3000 });

    const body = conektaEvent('charge.paid', {
      id: 'ch_10',
      amount: 100000, // 1000.00 MXN in centavos
      metadata: { loanId: 'loan_3', employeeId: 'emp_3' },
    });
    const res = await post(body, { digest: hmacSign(SECRET, body) });

    expect(res.status).toBe(200);
    const loan = admin.__get('loans', 'loan_3');
    expect(loan.remainingBalance).toBe(2000);
    // Partial payment: `updates` only touches remainingBalance, so the
    // loan's existing status is left as-is (it is not reset or cleared).
    expect(loan.status).toBe('active');
    expect(admin.__all('repayments')).toHaveLength(1);
  });

  test('malformed payload: missing metadata is a 500 and is recorded', async () => {
    const body = conektaEvent('charge.paid', { id: 'ch_11', amount: 100000, metadata: {} });
    const res = await post(body, { digest: hmacSign(SECRET, body) });

    expect(res.status).toBe(500);
    expect(admin.__all('incident_log').some((i) => i.data.error === 'Missing metadata on charge.paid')).toBe(true);
  });

  test('a fully-paid balance flips status to paid', async () => {
    admin.__seed('loans', 'loan_4', { status: 'active', amount: 1000, remainingBalance: 1000 });
    const body = conektaEvent('charge.paid', {
      id: 'ch_12',
      amount: 100000,
      metadata: { loanId: 'loan_4', employeeId: 'emp_4' },
    });
    const res = await post(body, { digest: hmacSign(SECRET, body) });
    expect(res.status).toBe(200);
    const loan = admin.__get('loans', 'loan_4');
    expect(loan.remainingBalance).toBe(0);
    expect(loan.status).toBe('paid');
  });

  test('replaying the same charge.paid webhook on a partially-repaid loan is a no-op', async () => {
    admin.__seed('loans', 'loan_5', { status: 'active', amount: 5000, remainingBalance: 5000 });
    const body = conektaEvent('charge.paid', {
      id: 'ch_13',
      amount: 100000, // 1000.00 MXN
      metadata: { loanId: 'loan_5', employeeId: 'emp_5' },
    });

    const first = await post(body, { digest: hmacSign(SECRET, body) });
    expect(first.status).toBe(200);
    expect(admin.__get('loans', 'loan_5').remainingBalance).toBe(4000);

    // Same webhook, replayed verbatim -- a Conekta retry, or a replay attack.
    // The loan is still `active`, so the status guard cannot catch it; the
    // repayment row keyed by chargeId does.
    const second = await post(body, { digest: hmacSign(SECRET, body) });
    expect(second.status).toBe(200);
    expect(admin.__get('loans', 'loan_5').remainingBalance).toBe(4000);
    expect(admin.__all('repayments')).toHaveLength(1);
  });

  test('two distinct charges against the same loan both apply', async () => {
    admin.__seed('loans', 'loan_5b', { status: 'active', amount: 5000, remainingBalance: 5000 });
    const mk = (id) => conektaEvent('charge.paid', {
      id,
      amount: 100000,
      metadata: { loanId: 'loan_5b', employeeId: 'emp_5b' },
    });

    const a = mk('ch_14a');
    const b = mk('ch_14b');
    expect((await post(a, { digest: hmacSign(SECRET, a) })).status).toBe(200);
    expect((await post(b, { digest: hmacSign(SECRET, b) })).status).toBe(200);

    expect(admin.__get('loans', 'loan_5b').remainingBalance).toBe(3000);
    expect(admin.__all('repayments')).toHaveLength(2);
  });

  test('missing charge id is a 500 and is recorded', async () => {
    const body = conektaEvent('charge.paid', {
      amount: 100000,
      metadata: { loanId: 'loan_5c', employeeId: 'emp_5c' },
    });
    const res = await post(body, { digest: hmacSign(SECRET, body) });
    expect(res.status).toBe(500);
    expect(admin.__all('incident_log').some((i) => i.data.error === 'Missing charge id on charge.paid')).toBe(true);
  });
});

// ── payment_failed / charge.payment_failure ─────────────────────────────
describe('order.payment_failed', () => {
  test('happy path: records a payment_failures row', async () => {
    const body = conektaEvent('order.payment_failed', { id: 'ord_20', metadata: { loanId: 'loan_6' }, payment_status: 'declined' });
    const res = await post(body, { digest: hmacSign(SECRET, body) });
    expect(res.status).toBe(200);
    const failures = admin.__all('payment_failures');
    expect(failures).toHaveLength(1);
    expect(failures[0].data).toMatchObject({ loanId: 'loan_6', reason: 'declined' });
  });

  test('missing loanId in metadata: no row written, still 200 (received)', async () => {
    const body = conektaEvent('order.payment_failed', { id: 'ord_21', metadata: {}, payment_status: 'declined' });
    const res = await post(body, { digest: hmacSign(SECRET, body) });
    expect(res.status).toBe(200);
    expect(admin.__all('payment_failures')).toHaveLength(0);
  });
});

describe('charge.payment_failure', () => {
  test('happy path: records a payment_failures row keyed by chargeId', async () => {
    const body = conektaEvent('charge.payment_failure', {
      id: 'ch_30',
      metadata: { loanId: 'loan_7', employeeId: 'emp_7' },
      failure_message: 'insufficient_funds',
    });
    const res = await post(body, { digest: hmacSign(SECRET, body) });
    expect(res.status).toBe(200);
    const failures = admin.__all('payment_failures');
    expect(failures[0].data).toMatchObject({ loanId: 'loan_7', employeeId: 'emp_7', conektaChargeId: 'ch_30', reason: 'insufficient_funds' });
  });

  test('malformed: missing metadata entirely still records with null loanId/employeeId', async () => {
    const body = conektaEvent('charge.payment_failure', { id: 'ch_31', failure_message: 'card_declined' });
    const res = await post(body, { digest: hmacSign(SECRET, body) });
    expect(res.status).toBe(200);
    const failures = admin.__all('payment_failures');
    expect(failures[0].data).toMatchObject({ loanId: null, employeeId: null, conektaChargeId: 'ch_31' });
  });
});
