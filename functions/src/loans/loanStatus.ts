/**
 * The single source of truth for the `loans/{loanId}.status` vocabulary.
 *
 * This module exists because the write paths (onLoanApproved, markLoanDisbursed,
 * processPayroll, dailyLoanCheck, updateLoanStatus) and the read paths
 * (getPortfolioReport, getAdminDashboard, getEmployerDashboard,
 * weeklyPortfolioSnapshot) drifted onto different spellings for the same
 * lifecycle states — most importantly, every write path that completes a
 * repayment writes `'repaid'`, but several reports filtered for `'paid'` or
 * `'completed'`, which nothing has ever written to a loan document. Those
 * reports were structurally reading zero repayments, zero revenue, and an
 * undercounted disbursed portfolio.
 *
 * CANONICAL SPELLING CHOICE: this module codifies whatever the live write
 * paths already produce (see the transition comments below), not the
 * prettier or more consistent-looking alternative. Existing Firestore
 * documents already carry these values; renaming what gets WRITTEN would
 * orphan every historical loan document, which is worse than keeping an
 * inconsistent-looking set of literals. Only the READ side is taught to
 * also recognize legacy/dead spellings (see LEGACY_REPAID_ALIASES).
 */

export const LOAN_STATUS = {
  PENDING: 'pending',
  UNDER_REVIEW: 'under_review',
  REJECTED: 'rejected',
  REJECTED_ML: 'rejected_ml',
  APPROVED: 'approved',
  DISBURSEMENT_QUEUED: 'disbursement_queued',
  DISBURSEMENT_FAILED: 'disbursement_failed',
  // Two live spellings for "funds actually sent", from two different
  // pipelines that both write directly to loans/{loanId}.status:
  //  - ACTIVE: the automatic path (onLoanApproved calls the SoftCrédito
  //    adapter itself and marks the loan active on success).
  //  - DISBURSED: the manual ops-confirmed path (markLoanDisbursed, called
  //    after an out-of-band STP transfer is confirmed).
  // Both are real, both are live, and reports must treat them as one class.
  ACTIVE: 'active',
  DISBURSED: 'disbursed',
  OVERDUE: 'overdue',
  // The only status any write path ever sets on full repayment
  // (processPayroll.ts, when a deduction brings remainingBalance to 0).
  REPAID: 'repaid',
  CANCELLED: 'cancelled',
  IN_COLLECTIONS: 'in_collections',
  WRITTEN_OFF: 'written_off',
} as const;

export type LoanStatus = (typeof LOAN_STATUS)[keyof typeof LOAN_STATUS];

export const ALL_LOAN_STATUSES: readonly LoanStatus[] = Object.values(LOAN_STATUS);

/**
 * Spellings that no current write path produces, but which historical
 * documents, dead code, or ops tooling may still have written:
 *  - 'paid': the target status two separate dead-code repayment listeners
 *    (index.ts's onLoanStatusChange, loans/onLoanStatusChange.ts) have always
 *    watched for on an approved->paid transition. No write path has ever
 *    produced it — those listeners have never fired in production — but a
 *    document could still carry it if ops ever wrote it by hand through the
 *    (unvalidated, prior to this change) updateLoanStatus callable.
 *  - 'complete' / 'completed': seen only on OTHER collections
 *    (disbursement_queue.status, payrollBatches.status, scheduler_runs.status)
 *    in every write site audited — never on loans.status — but frontend
 *    (public-v2) reads treat them as loan-repaid spellings too, so a
 *    hand-written or future-imported document using them must not silently
 *    vanish from reports either.
 */
export const LEGACY_REPAID_ALIASES = ['paid', 'complete', 'completed'] as const;

/** Every spelling a document may carry that means "fully repaid". */
export const REPAID_STATUSES: readonly string[] = [
  LOAN_STATUS.REPAID,
  ...LEGACY_REPAID_ALIASES,
];

/** Both live "funds were actually sent" spellings. */
export const DISBURSED_STATUSES: readonly string[] = [LOAN_STATUS.ACTIVE, LOAN_STATUS.DISBURSED];

/**
 * The statuses a payroll deduction may legitimately land against: funds have
 * gone out and the debt is still owed, however badly it is going.
 *
 * This is the SINGLE definition the two sides of the payroll channel derive
 * from. They used to be written out by hand and drifted: the employer's
 * deduction report listed `overdue` loans with an amount owed, while
 * `processPayroll`'s loan lookup hardcoded `['active', 'disbursed']`. The
 * employer withheld the money from the paycheck and the server recorded
 * nothing — the money is gone from the employee's wages and never credited
 * against their debt. `in_collections` was excluded on both sides, so those
 * loans were merely uncollectable rather than dangerous; it belongs here for
 * the same reason `overdue` does.
 *
 * The public-v2 mirror is `public-v2/src/lib/loanStatus.ts`
 * (DEDUCTIBLE_STATUSES) — separate TypeScript projects with no shared
 * package, kept in agreement by `loanStatus.test.ts` on both sides.
 */
export const DEDUCTIBLE_STATUSES: readonly string[] = [
  ...DISBURSED_STATUSES,
  LOAN_STATUS.OVERDUE,
  LOAN_STATUS.IN_COLLECTIONS,
];

/**
 * Everything the employer's deduction report shows: every loan a deduction can
 * still land against, plus the ones already paid off so the period history
 * doesn't lose them (legacy repaid aliases included — a hand-written document
 * must not silently vanish from the report).
 *
 * Firestore's `in` operator caps at 30 values; this is well under.
 */
export const DEDUCTION_REPORT_STATUSES: readonly string[] = [
  ...DEDUCTIBLE_STATUSES,
  ...REPAID_STATUSES,
];

/** Everything from "funds sent" onward, regardless of what happened since. */
export const POST_DISBURSEMENT_STATUSES: readonly string[] = [
  ...DISBURSED_STATUSES,
  LOAN_STATUS.OVERDUE,
  LOAN_STATUS.IN_COLLECTIONS,
  LOAN_STATUS.WRITTEN_OFF,
  ...REPAID_STATUSES,
];

/** Statuses that count as "in default" for portfolio risk reporting. */
export const DEFAULT_STATUSES: readonly string[] = [
  LOAN_STATUS.OVERDUE,
  LOAN_STATUS.IN_COLLECTIONS,
  LOAN_STATUS.WRITTEN_OFF,
];

/** Statuses a loan sits in before any disbursement attempt has started. */
export const PRE_DISBURSEMENT_STATUSES: readonly string[] = [
  LOAN_STATUS.PENDING,
  LOAN_STATUS.UNDER_REVIEW,
  LOAN_STATUS.APPROVED,
];

/** Statuses reached once a disbursement attempt has actually started. */
export const DISBURSEMENT_INITIATED_STATUSES: readonly string[] = [
  LOAN_STATUS.DISBURSEMENT_QUEUED,
  LOAN_STATUS.DISBURSEMENT_FAILED,
  ...DISBURSED_STATUSES,
  LOAN_STATUS.OVERDUE,
  LOAN_STATUS.IN_COLLECTIONS,
  LOAN_STATUS.WRITTEN_OFF,
  ...REPAID_STATUSES,
];

/** A loan the borrower still owes on and that has not been repaid, written off, or rejected. */
export const OUTSTANDING_STATUSES: readonly string[] = [
  LOAN_STATUS.PENDING,
  LOAN_STATUS.UNDER_REVIEW,
  LOAN_STATUS.APPROVED,
  LOAN_STATUS.DISBURSEMENT_QUEUED,
  ...DISBURSED_STATUSES,
  LOAN_STATUS.OVERDUE,
  LOAN_STATUS.IN_COLLECTIONS,
];

export function isRepaidStatus(status: unknown): boolean {
  return typeof status === 'string' && REPAID_STATUSES.includes(status);
}

export function isDisbursedStatus(status: unknown): boolean {
  return typeof status === 'string' && DISBURSED_STATUSES.includes(status);
}

export function isPostDisbursementStatus(status: unknown): boolean {
  return typeof status === 'string' && POST_DISBURSEMENT_STATUSES.includes(status);
}

export function isDefaultStatus(status: unknown): boolean {
  return typeof status === 'string' && DEFAULT_STATUSES.includes(status);
}

export function isKnownLoanStatus(status: unknown): status is LoanStatus {
  return typeof status === 'string' && (ALL_LOAN_STATUSES as readonly string[]).includes(status);
}

/**
 * The subset of repayment transitions whose counter side effects are NOT
 * already applied by the writer itself.
 *
 * `services/payment-server` writes `status: 'paid'` and, in the same
 * transaction, increments the employee's `availableCredit` by the loan amount
 * (`order.paid` and `POST /internal/repayment`). A trigger that also restored
 * credit on the `'paid'` spelling would restore it twice, letting the borrower
 * re-borrow against money they never repaid. So the trigger owns only the
 * canonical `'repaid'` transition — the payroll path (processPayroll.ts),
 * which restores nothing itself.
 *
 * Known residual, pre-existing and unchanged by this split: a card or
 * payroll-sync repayment settles as `'paid'`, so the employer's active-loan
 * slot is still not released on those paths. The real fix is to make this
 * trigger the single owner of both counters and strip the increments out of
 * payment-server — one behaviour change per PR, and that one moves money.
 */
export function isCreditRestoringRepayment(beforeStatus: unknown, afterStatus: unknown): boolean {
  return beforeStatus !== LOAN_STATUS.REPAID && afterStatus === LOAN_STATUS.REPAID;
}

/** A peso figure off a loan document, or `null` if the field is not one. */
function asMoney(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * How much `availableCredit` is still owed back to the borrower at the moment
 * a loan reaches `repaid` — the principal that was held at origination, LESS
 * whatever has already been handed back on this loan.
 *
 * The two repayment channels share one loan document but only one of them
 * used to keep a restoration ledger on it:
 *
 *  - `services/payment-server/applyRepayment.js` restores credit
 *    INCREMENTALLY, on every partial payment, and records the running total
 *    on `loans.creditRestored` (its rule 3: a delta toward
 *    `min(principal, totalPaid)`). A short SoftCrédito deduction through
 *    `POST /internal/repayment`, or the first of two Conekta charges on one
 *    order, leaves the loan `active` with `creditRestored > 0`.
 *  - the employer-CSV channel (`functions/src/payroll/processPayroll.ts`)
 *    restores nothing per deduction; the whole hold comes back here, once,
 *    when a deduction takes the balance to zero and flips the loan to
 *    `repaid`.
 *
 * Those two are individually correct and catastrophic together. This trigger
 * incremented `availableCredit` by the loan's full `amount` unconditionally,
 * so a loan that was partly repaid through payment-server and then FINISHED by
 * a payroll CSV had the already-restored slice handed back a second time. On a
 * $5,000 principal / $6,500 obligation: SoftCrédito reports a short deduction
 * of $1,500 (credit +1,500, `creditRestored` = 1,500, loan still `active`),
 * the employer's next CSV deducts the remaining $5,000 and the loan goes
 * `repaid`, and this trigger added another $5,000 — $6,500 of borrowing power
 * restored against a $5,000 hold. The overshoot is the size of the other
 * channel's contribution, so a borrower who paid $4,900 by card and $1,600 by
 * payroll walked away with $9,900 of credit against that same $5,000 hold:
 * nearly double the line, minted out of a fee they had merely paid.
 *
 * Netting `creditRestored` off makes this the same delta-toward-the-principal
 * rule payment-server already applies, which is what makes the two channels
 * commutative: whichever one settles the loan, exactly the principal comes
 * back, once.
 *
 * Returns 0 — no write at all — for a loan carrying no usable principal,
 * rather than letting a corrupt `amount` throw the trigger and strand the
 * employer counter the caller has already decremented.
 */
export function creditToRestoreOnRepayment(loan: Record<string, unknown>): number {
  // `typeof`, not `Number()`: a numeric STRING on a money field is a corrupt
  // document, not a quantity, and coercing it would push a value into
  // `FieldValue.increment` that the caller's own `as number` cast has always
  // pretended could not be there.
  const principal = asMoney(loan['amount']);
  if (principal === null || principal <= 0) return 0;

  const alreadyRestored = asMoney(loan['creditRestored']);
  if (alreadyRestored === null || alreadyRestored <= 0) return principal;

  // Pesos-and-centavos, like every other balance in the ledger.
  return Math.max(0, Math.round((principal - alreadyRestored) * 100) / 100);
}
