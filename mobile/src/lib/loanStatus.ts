// Mirrors the loan status vocabulary in functions/src/loans/loanStatus.ts,
// via the same arrangement public-v2/src/lib/loanStatus.ts uses: mobile,
// public-v2 and functions are separate TypeScript projects with no shared
// package, so this file carries only the subset these screens need and
// loanStatus.test.ts is what keeps it in agreement with the server's
// vocabulary. If a status is added server-side, add it here AND in the test.
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
  REJECTED: 'rejected',
  DISBURSEMENT_FAILED: 'disbursement_failed',
} as const;

export type LoanStatus = (typeof LOAN_STATUS)[keyof typeof LOAN_STATUS];

// Dead spellings no write path produces anymore, but which historical
// documents may still carry (functions/src/loans/loanStatus.ts).
export const LEGACY_REPAID_ALIASES = ['paid', 'complete', 'completed'] as const;

/** Both live "funds were actually sent" spellings. */
export const DISBURSED_STATUSES: readonly string[] = [LOAN_STATUS.ACTIVE, LOAN_STATUS.DISBURSED];

/** Every spelling a document may carry that means "fully repaid". */
export const REPAID_STATUSES: readonly string[] = [LOAN_STATUS.REPAID, ...LEGACY_REPAID_ALIASES];

/** Funds are out and the debt is still owed — the borrower can pay these. */
export const PAYABLE_STATUSES: readonly string[] = [
  ...DISBURSED_STATUSES,
  LOAN_STATUS.OVERDUE,
  LOAN_STATUS.IN_COLLECTIONS,
];

export function isRepaidStatus(status: unknown): boolean {
  return typeof status === 'string' && REPAID_STATUSES.includes(status);
}

export function isPayableStatus(status: unknown): boolean {
  return typeof status === 'string' && PAYABLE_STATUSES.includes(status);
}

/**
 * i18n key for a status chip. Legacy repaid aliases collapse onto `repaid`
 * so a historical document renders as paid off instead of leaking its raw
 * spelling; anything unrecognized renders the `unknown` key rather than raw
 * server vocabulary.
 */
export function statusLabelKey(status: unknown): string {
  if (isRepaidStatus(status)) return 'loanStatus.repaid';
  if (typeof status === 'string' && (Object.values(LOAN_STATUS) as string[]).includes(status)) {
    return `loanStatus.${status}`;
  }
  return 'loanStatus.unknown';
}


/**
 * Whole days until a loan's due date (negative = overdue). Ceil so "due in
 * 20 hours" reads as 1 day, matching how borrowers count.
 */
export function daysUntilDue(
  dueDate: { seconds: number } | undefined,
  now: number = Date.now()
): number | null {
  if (!dueDate || typeof dueDate.seconds !== 'number') return null;
  return Math.ceil((dueDate.seconds * 1000 - now) / 86400000);
}
