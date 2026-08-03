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
