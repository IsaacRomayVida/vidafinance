// Mirrors the loan status vocabulary in functions/src/loans/loanStatus.ts —
// see that file for why 'repaid' (not 'paid') is canonical, why 'disbursed'
// and 'active' are both live "funds sent" spellings, and why 'overdue' is a
// separate live status. public-v2 and functions are separate TypeScript
// projects with no shared package (see payFrequencies.ts), so this can't
// import that module directly; this file mirrors only the subset the
// deduction report needs, and loanStatus.test.ts is what keeps the two in
// agreement.
export const LOAN_STATUS = {
  PENDING: 'pending',
  UNDER_REVIEW: 'under_review',
  APPROVED: 'approved',
  DISBURSEMENT_QUEUED: 'disbursement_queued',
  ACTIVE: 'active',
  DISBURSED: 'disbursed',
  OVERDUE: 'overdue',
  IN_COLLECTIONS: 'in_collections',
  REPAID: 'repaid',
} as const;

// Dead spellings no write path produces anymore, but which historical
// documents may still carry (functions/src/loans/loanStatus.ts:56-69).
export const LEGACY_REPAID_ALIASES = ['paid', 'complete', 'completed'] as const;

/** Both live "funds were actually sent" spellings. */
export const DISBURSED_STATUSES: readonly string[] = [LOAN_STATUS.ACTIVE, LOAN_STATUS.DISBURSED];

/** Every spelling a document may carry that means "fully repaid". */
export const REPAID_STATUSES: readonly string[] = [LOAN_STATUS.REPAID, ...LEGACY_REPAID_ALIASES];

/**
 * The full set of statuses that belong on the employer deduction report: a
 * loan only has a deduction once funds have gone out (DISBURSED_STATUSES),
 * for as long as it's still being collected (OVERDUE), through full
 * repayment (REPAID_STATUSES, including dead aliases so a hand-written
 * legacy document doesn't silently vanish from the report). Loans that
 * haven't disbursed yet have no deduction to show.
 */
export const DEDUCTION_REPORT_STATUSES: readonly string[] = [
  ...DISBURSED_STATUSES,
  LOAN_STATUS.OVERDUE,
  ...REPAID_STATUSES,
];

/**
 * A loan the borrower still owes on and that has not been repaid, written
 * off, or rejected. Mirrors OUTSTANDING_STATUSES in
 * functions/src/loans/loanStatus.ts — the dashboard's "Outstanding" total
 * used to hardcode a shorter list that omitted DISBURSEMENT_QUEUED and
 * IN_COLLECTIONS, so a loan mid-disbursement or already in collections read
 * as if it were not owed at all.
 */
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

/** Still being actively deducted: disbursed and not yet fully repaid. */
export function isActiveDeductionStatus(status: unknown): boolean {
  return typeof status === 'string' && (DISBURSED_STATUSES.includes(status) || status === LOAN_STATUS.OVERDUE);
}
