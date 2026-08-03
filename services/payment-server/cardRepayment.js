'use strict';

/**
 * The single balance-aware settlement routine for the card repayment path.
 *
 * Both Conekta webhook handlers (`order.paid` and `charge.paid`) call this.
 * They used to carry two near-identical, silently divergent transaction
 * bodies, and that divergence WAS the bug: `charge.paid` decremented a
 * balance, while `order.paid` unconditionally wrote `status: 'paid'` and
 * handed back the full principal as credit no matter how little had actually
 * been paid. A 1,000 payment against a 6,500 obligation closed the loan and
 * restored the borrower's credit line. One routine, one set of rules.
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
 *  2. IDEMPOTENCY IS JOINT, NOT PER-HANDLER. A paid Conekta order contains
 *     its charge, so one card payment can deliver BOTH `order.paid` and
 *     `charge.paid`. Keyed on anything order-scoped, that applies the money
 *     twice. So every repayment row -- from either handler -- is keyed
 *     `conekta_<chargeId>`, and the charge id is the one identifier both
 *     events agree on (`order.paid` carries it at charges.data[i].id,
 *     `charge.paid` at object.id). Whichever event lands first applies the
 *     money; the other becomes a no-op. This is also why `order.paid` applies
 *     per charge rather than applying the order total as one lump: an order
 *     with two charges must reconcile against two `charge.paid` events.
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
 *  4. EVERY PRECONDITION IS A `tx.get`. Two concurrent webhook deliveries
 *     that both read before the transaction would both pass their checks and
 *     both commit. Nothing here reads outside the transaction.
 *
 * On the employer slot (G4): settling writes `status: 'paid'`, and the
 * loan-status trigger deliberately fires only on the canonical `'repaid'`
 * spelling so it does not double-restore credit that this file already
 * restored (see isCreditRestoringRepayment in functions/src/loans/
 * loanStatus.ts). That split is intentional and is left alone. Its documented
 * residual -- nobody frees the employer's `activeLoans` slot on the card path,
 * which permanently consumes origination capacity now that slot caps are
 * enforced (ADR-007) -- is closed here instead, by the settling transaction
 * that already owns the other counter. The trigger still never sees 'paid',
 * so there is still no double-count.
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
 * Apply one or more card charges against a loan, inside a single transaction.
 *
 * @param {object} deps            - { db, admin }
 * @param {object} input
 * @param {string} input.loanId
 * @param {string} input.employeeId - from webhook metadata; the loan document wins if they disagree
 * @param {string} [input.orderId]
 * @param {Array<{chargeId: string, amount: number}>} input.payments - amounts in PESOS
 * @returns {Promise<{outcome: string, settled: boolean, appliedAmount: number, ...}>}
 */
async function applyCardRepayment({ db, admin }, { loanId, employeeId, orderId, payments }) {
  const FieldValue = admin.firestore.FieldValue;

  if (!Array.isArray(payments) || payments.length === 0) {
    throw new Error('applyCardRepayment called with no payments');
  }
  for (const p of payments) {
    if (!p || !p.chargeId) throw new Error('Card repayment is missing a charge id');
    if (asFiniteNumber(p.amount) === null || p.amount <= 0) {
      throw new Error(`Card repayment ${p.chargeId} has a non-positive or non-numeric amount`);
    }
  }

  return db.runTransaction(async (tx) => {
    const loanRef = db.collection('loans').doc(loanId);
    const rows = payments.map((p) => ({
      payment: p,
      ref: db.collection('repayments').doc(`conekta_${p.chargeId}`),
    }));

    // ── read phase: every precondition below is a transactional read ──────
    const loanDoc = await tx.get(loanRef);
    const seen = await Promise.all(rows.map((r) => tx.get(r.ref)));

    // A payment against a loan we do not have is a reconciliation failure, not
    // a success. Same stance as POST /internal/repayment's 404.
    if (!loanDoc.exists) return { outcome: 'loan_not_found', settled: false, appliedAmount: 0 };
    const loan = loanDoc.data();

    const fresh = rows.filter((_, i) => !seen[i].exists);
    if (fresh.length === 0) {
      // Every charge in this event already has a repayment row: a Conekta
      // retry, the sibling event for the same payment, or a replay attempt.
      return { outcome: 'duplicate', settled: false, appliedAmount: 0 };
    }

    const baseRow = (payment, extra) => ({
      loanId,
      employeeId: loan.employeeId ?? employeeId ?? null,
      amount: payment.amount,
      method: 'card',
      conektaChargeId: payment.chargeId,
      conektaOrderId: orderId ?? null,
      createdAt: FieldValue.serverTimestamp(),
      ...extra,
    });

    // A fresh charge against a loan that is ALREADY settled is money we cannot
    // apply -- an overpayment, a duplicate checkout, or a charge for the wrong
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
      updates.repaymentRef = fresh[fresh.length - 1].payment.chargeId;
    }

    // Rule 3: credit restoration is a delta toward min(principal, repaid).
    const principalCents = Math.max(0, toCents(asFiniteNumber(loan.amount) ?? 0));
    const restoredCents = Math.max(0, toCents(asFiniteNumber(loan.creditRestored) ?? 0));
    const targetRestoredCents = Math.min(principalCents, totalPaidCents);
    const restoreDeltaCents = Math.max(0, targetRestoredCents - restoredCents);

    // The loan document is authoritative for WHO gets the credit back; the
    // webhook metadata only says which loan to look up.
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

module.exports = { applyCardRepayment, REPAID_STATUSES };
