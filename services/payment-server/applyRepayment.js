'use strict';

/**
 * The single balance-aware settlement routine for EVERY repayment channel this
 * service accepts money on.
 *
 * It started as the card-only routine, and it started that way for a reason:
 * `order.paid` and `charge.paid` used to carry two near-identical, silently
 * divergent transaction bodies, and that divergence WAS the bug. `charge.paid`
 * decremented a balance, while `order.paid` unconditionally wrote
 * `status: 'paid'` and handed back the full principal as credit no matter how
 * little had actually been paid. A 1,000 payment against a 6,500 obligation
 * closed the loan and restored the borrower's credit line.
 *
 * POST /internal/repayment -- the SoftCrédito payroll-deduction channel -- was
 * left out of that unification and kept doing exactly the thing that was fixed
 * here: it took `amount` from the request body, wrote `status: 'paid'` and
 * `paidAmount: amount` without ever comparing that number to what the loan
 * owed, and incremented the employee's `availableCredit` by the whole
 * principal. `amount` on that route is whatever SoftCrédito reported as
 * collected, so a payroll cycle that withheld 500 of a 6,500 installment --
 * an employee on unpaid leave, a short paycheck, a partial run -- forgave the
 * other 6,000 and handed the borrower their credit line back to spend again.
 * The third channel, the employer-CSV path (functions/src/payroll/
 * processPayroll.ts), has always been balance-aware and even refuses a
 * deduction larger than the balance. Two of three channels agreed; the third
 * was the one an outside system supplied the number for.
 *
 * So: one routine, one set of rules, for all of them.
 *
 * The rules, in the order they matter:
 *
 *  1. THE OBLIGATION IS `total`, NEVER `amount`. `loans.amount` is bare
 *     principal; `loans.total` (= amount + fee, written once at requestLoan
 *     time, functions/src/index.ts:~838) is what the borrower actually owes.
 *     `remainingBalance` is NOT initialised at loan creation, so the fallback
 *     chain is `remainingBalance ?? total` -- the same chain processPayroll.ts
 *     (~line 125) already uses. There is deliberately no further fallback to
 *     `amount` or to 0: both are smaller than the truth, and a silent fallback
 *     to a smaller number is exactly how a payment channel starts forgiving
 *     debt. A loan with no usable obligation basis throws, which surfaces as
 *     an incident_log row and a 500, rather than settling for less.
 *
 *  2. IDEMPOTENCY IS JOINT, NOT PER-HANDLER, AND THE CALLER MUST NAME THE
 *     PAYMENT. Every repayment row is a document whose id the caller supplies
 *     (`payment.docId`), and a payment whose row already exists moves nothing.
 *     On the card side that id is `conekta_<chargeId>`, because a paid Conekta
 *     order contains its charge and one card payment can therefore deliver
 *     BOTH `order.paid` and `charge.paid`; keyed on anything order-scoped,
 *     that applies the money twice, and the charge id is the one identifier
 *     both events agree on (`order.paid` carries it at charges.data[i].id,
 *     `charge.paid` at object.id). This is also why `order.paid` applies per
 *     charge rather than applying the order total as one lump: an order with
 *     two charges must reconcile against two `charge.paid` events. On the
 *     payroll side it is `payroll_<ref>`, the SoftCrédito deduction reference.
 *     That row is load-bearing on BOTH channels now: once a partial payment
 *     leaves the loan `active`, the settled-status guard below can no longer
 *     catch a replay, so the row is the only thing that does.
 *
 *  3. CREDIT COMES BACK AT MOST ONCE, AND AT MOST THE PRINCIPAL.
 *     `availableCredit` was reduced by the PRINCIPAL at origination
 *     (requestLoan's `holdCredit`), so the principal is the ceiling on what
 *     may ever be restored -- restoring `total` would hand back the fee as
 *     new borrowing power. Restoration is tracked cumulatively on the loan
 *     (`creditRestored`) and computed as a delta toward
 *     `min(principal, totalRepaid)`, so it is monotonic, never exceeds what
 *     was actually repaid, and cannot double-apply across partial payments.
 *
 *  4. THE LOAN DOCUMENT SAYS WHOSE DEBT THIS IS, THE CALLER DOES NOT. A
 *     caller-supplied `employeeId` is a fallback for a loan document that does
 *     not carry one, and nothing more. Trusting it is how a repayment's
 *     restored credit line ends up on somebody else's employee document:
 *     /internal/repayment used to read `employees/{req.body.employeeId}` and
 *     increment it by the loan's full principal without ever comparing it to
 *     `loans/{loanId}.employeeId`.
 *
 *  5. EVERY PRECONDITION IS A `tx.get`. Two concurrent webhook deliveries
 *     that both read before the transaction would both pass their checks and
 *     both commit. Nothing here reads outside the transaction.
 *
 * On the employer slot (G4): settling writes `status: 'paid'`, and the
 * loan-status trigger deliberately fires only on the canonical `'repaid'`
 * spelling so it does not double-restore credit that this file already
 * restored (see isCreditRestoringRepayment in functions/src/loans/
 * loanStatus.ts). That split is intentional and is left alone. Its documented
 * residual -- nobody frees the employer's `activeLoans` slot, which
 * permanently consumes origination capacity now that slot caps are enforced
 * (ADR-007) -- is closed here instead, by the settling transaction that
 * already owns the other counter. The trigger still never sees 'paid', so
 * there is still no double-count. Routing the payroll channel through this
 * routine closes that leak on the payroll channel too, which never had it.
 */

// Mirrors REPAID_STATUSES in functions/src/loans/loanStatus.ts. That module is
// TypeScript inside functions/ and cannot be imported from this service, so it
// is duplicated deliberately and must be fixed in lockstep -- the same
// convention functions/src/loans/onLoanStatusChange.ts already documents for
// its own duplicate. Read-side only: this service writes 'paid' and nothing
// else, but must RECOGNISE every spelling a settled loan may already carry, or
// it would re-settle a loan the payroll path already closed as 'repaid'.
const REPAID_STATUSES = ['repaid', 'paid', 'complete', 'completed'];

// Money is compared in integer centavos throughout. Conekta reports centavos;
// loan documents store pesos. Comparing pesos as floats makes
// `6500 - 1300 - 5200 <= 0` a coin flip, and that comparison decides whether a
// loan is forgiven.
const toCents = (pesos) => Math.round(pesos * 100);
const toPesos = (cents) => cents / 100;

const asFiniteNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Apply one or more payments against a loan, inside a single transaction.
 *
 * @param {object} deps            - { db, admin }
 * @param {object} input
 * @param {string} input.loanId
 * @param {string} input.employeeId - fallback only; the loan document wins (rule 4)
 * @param {string} input.method     - stamped on every repayment row: 'card' | 'payroll_deduction'
 * @param {Array<{id: string, docId: string, amount: number, extra?: object}>} input.payments
 *        `amount` is in PESOS; `docId` is the idempotency key (rule 2).
 * @returns {Promise<{outcome: string, settled: boolean, appliedAmount: number, ...}>}
 */
async function applyRepayment({ db, admin }, { loanId, employeeId, method, payments }) {
  const FieldValue = admin.firestore.FieldValue;

  if (!Array.isArray(payments) || payments.length === 0) {
    throw new Error('applyRepayment called with no payments');
  }
  for (const p of payments) {
    if (!p || !p.id || !p.docId) throw new Error(`A ${method} repayment is missing its payment id`);
    if (asFiniteNumber(p.amount) === null || p.amount <= 0) {
      throw new Error(`${method} repayment ${p.id} has a non-positive or non-numeric amount`);
    }
  }

  return db.runTransaction(async (tx) => {
    const loanRef = db.collection('loans').doc(loanId);
    const rows = payments.map((p) => ({
      payment: p,
      ref: db.collection('repayments').doc(p.docId),
    }));

    // ── read phase: every precondition below is a transactional read ──────
    const loanDoc = await tx.get(loanRef);
    const seen = await Promise.all(rows.map((r) => tx.get(r.ref)));

    // A payment against a loan we do not have is a reconciliation failure, not
    // a success.
    if (!loanDoc.exists) return { outcome: 'loan_not_found', settled: false, appliedAmount: 0 };
    const loan = loanDoc.data();

    const fresh = rows.filter((_, i) => !seen[i].exists);
    if (fresh.length === 0) {
      // Every payment in this event already has a repayment row: an upstream
      // retry, the sibling event for the same payment, or a replay attempt.
      return { outcome: 'duplicate', settled: false, appliedAmount: 0 };
    }

    const baseRow = (payment, extra) => ({
      loanId,
      employeeId: loan.employeeId ?? employeeId ?? null,
      amount: payment.amount,
      method,
      createdAt: FieldValue.serverTimestamp(),
      ...(payment.extra || {}),
      ...extra,
    });

    // A fresh payment against a loan that is ALREADY settled is money we cannot
    // apply -- an overpayment, a duplicate checkout, or a payment for the wrong
    // loan. Record it (so the row exists and replays stay no-ops) but move
    // nothing: re-settling would restore credit a second time.
    if (REPAID_STATUSES.includes(loan.status)) {
      for (const r of fresh) {
        tx.set(r.ref, baseRow(r.payment, { status: 'unapplied', unappliedReason: 'loan_already_settled' }));
      }
      return { outcome: 'already_settled', settled: false, appliedAmount: 0 };
    }

    // Rule 1: the obligation, never bare principal, and never a smaller
    // fallback. `remainingBalance` may legitimately be 0 only on a settled
    // loan, which the status guard above has already returned on.
    const basis = asFiniteNumber(loan.remainingBalance ?? loan.total);
    if (basis === null || basis <= 0) {
      throw new Error(
        `Loan ${loanId} has no valid outstanding obligation to settle against ` +
          `(remainingBalance=${JSON.stringify(loan.remainingBalance)}, total=${JSON.stringify(loan.total)})`
      );
    }

    const appliedCents = fresh.reduce((sum, r) => sum + toCents(r.payment.amount), 0);
    const newBalanceCents = toCents(basis) - appliedCents;
    const settled = newBalanceCents <= 0;

    const priorPaidCents = toCents(asFiniteNumber(loan.paidAmount) ?? 0);
    const totalPaidCents = priorPaidCents + appliedCents;

    const updates = {
      remainingBalance: toPesos(Math.max(0, newBalanceCents)),
      paidAmount: toPesos(totalPaidCents),
    };
    if (settled) {
      updates.status = 'paid';
      updates.paidAt = FieldValue.serverTimestamp();
      updates.repaymentRef = fresh[fresh.length - 1].payment.id;
    }

    // Rule 3: credit restoration is a delta toward min(principal, repaid).
    const principalCents = Math.max(0, toCents(asFiniteNumber(loan.amount) ?? 0));
    const restoredCents = Math.max(0, toCents(asFiniteNumber(loan.creditRestored) ?? 0));
    const targetRestoredCents = Math.min(principalCents, totalPaidCents);
    const restoreDeltaCents = Math.max(0, targetRestoredCents - restoredCents);

    // Rule 4: the loan document is authoritative for WHO gets the credit back;
    // the caller's employeeId only says which loan to look up.
    const creditEmployeeId = loan.employeeId ?? employeeId ?? null;
    let employeeDoc = null;
    if (restoreDeltaCents > 0 && creditEmployeeId) {
      employeeDoc = await tx.get(db.collection('employees').doc(creditEmployeeId));
    }

    // G4: free the employer's origination slot on full repayment. Read first
    // so a missing employer document cannot abort the whole settlement, and so
    // the counter cannot be driven negative by a loan that was never counted.
    let employerDoc = null;
    if (settled && loan.employerId) {
      employerDoc = await tx.get(db.collection('employers').doc(loan.employerId));
    }

    // ── write phase ───────────────────────────────────────────────────────
    if (restoreDeltaCents > 0) updates.creditRestored = toPesos(targetRestoredCents);
    tx.update(loanRef, updates);

    for (const r of fresh) {
      tx.set(r.ref, baseRow(r.payment, { status: 'completed', paidAt: FieldValue.serverTimestamp() }));
    }

    if (employeeDoc && employeeDoc.exists) {
      tx.update(db.collection('employees').doc(creditEmployeeId), {
        availableCredit: FieldValue.increment(toPesos(restoreDeltaCents)),
      });
    }

    if (employerDoc && employerDoc.exists && (asFiniteNumber(employerDoc.data().activeLoans) ?? 0) > 0) {
      tx.update(db.collection('employers').doc(loan.employerId), {
        activeLoans: FieldValue.increment(-1),
      });
    }

    return {
      outcome: 'applied',
      settled,
      appliedAmount: toPesos(appliedCents),
      remainingBalance: updates.remainingBalance,
      creditRestored: toPesos(restoreDeltaCents),
      employeeId: creditEmployeeId,
    };
  });
}

/** Conekta card charges. Idempotency key: `conekta_<chargeId>` (rule 2). */
function applyCardRepayment({ db, admin }, { loanId, employeeId, orderId, payments }) {
  if (!Array.isArray(payments) || payments.length === 0) {
    throw new Error('applyCardRepayment called with no payments');
  }
  for (const p of payments) {
    if (!p || !p.chargeId) throw new Error('Card repayment is missing a charge id');
  }
  return applyRepayment(
    { db, admin },
    {
      loanId,
      employeeId,
      method: 'card',
      payments: payments.map((p) => ({
        id: p.chargeId,
        docId: `conekta_${p.chargeId}`,
        amount: p.amount,
        extra: { conektaChargeId: p.chargeId, conektaOrderId: orderId ?? null },
      })),
    }
  );
}

/**
 * One SoftCrédito payroll deduction. Idempotency key: `payroll_<ref>` -- the
 * deduction reference the adapter registered and SoftCrédito echoes back on
 * `/deductions/completed`. The caller is responsible for having validated
 * `ref` as a safe Firestore document-id fragment before this point; see
 * REPAYMENT_REF_PATTERN in index.js.
 */
function applyPayrollRepayment({ db, admin }, { loanId, employeeId, amount, ref, method }) {
  return applyRepayment(
    { db, admin },
    {
      loanId,
      employeeId,
      method: method || 'payroll_deduction',
      payments: [{ id: ref, docId: `payroll_${ref}`, amount, extra: { externalRef: ref } }],
    }
  );
}

module.exports = { applyRepayment, applyCardRepayment, applyPayrollRepayment, REPAID_STATUSES };
