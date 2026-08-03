import {
  LOAN_STATUS,
  DEDUCTIBLE_STATUSES,
  OUTSTANDING_STATUSES,
  POST_DISBURSEMENT_STATUSES,
} from '../loans/loanStatus';

/**
 * The shape getEmployerDashboard's own loan query returns: a raw Firestore
 * document spread plus `id`. This function only reads status/employeeId/
 * total/remainingBalance off it; everything else on a loan document is
 * irrelevant here. Kept as an index signature (not a narrow interface)
 * because the caller spreads `DocumentSnapshot.data()` results out of a
 * `Promise.all` of heterogeneous queries, which TypeScript widens in a way
 * a narrower object type can't be assigned from directly.
 */
type DashboardLoan = Record<string, unknown>;

export interface EmployerDashboardStats {
  totalEmployees: number;
  activeLoans: number;
  overdueCount: number;
  totalDisbursed: number;
  outstandingBalance: number;
  adoptionRate: string;
}

function toFiniteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Builds the employer dashboard's headline numbers from the canonical status
 * sets in loanStatus.ts, so this stays the fifth reader to agree with the
 * write paths rather than a fifth private opinion (E11 in
 * AUDIT_EMPLOYER_PATH.md tracks the other four surfaces that disagree).
 *
 * `loans` is whatever getEmployerDashboard already fetched (currently capped
 * at the 50 most recent) — this function does no fetching of its own.
 */
export function computeEmployerDashboardStats(
  loans: DashboardLoan[],
  employeeCount: number
): EmployerDashboardStats {
  let activeLoans = 0;
  let overdueCount = 0;
  let totalDisbursed = 0;
  let outstandingBalance = 0;
  const borrowers = new Set<string>();

  for (const loan of loans) {
    const status = typeof loan.status === 'string' ? loan.status : '';
    if (typeof loan.employeeId === 'string') borrowers.add(loan.employeeId);

    // Funds are out and the debt is still owed — the same definition the
    // payroll deduction channel itself lends against (processPayroll.ts).
    if (DEDUCTIBLE_STATUSES.includes(status)) activeLoans++;

    if (status === LOAN_STATUS.OVERDUE) overdueCount++;

    // `total` (principal + fee), never `amount` (bare principal) — and only
    // for loans where funds actually left the building at some point,
    // regardless of what happened to the loan since.
    if (POST_DISBURSEMENT_STATUSES.includes(status)) {
      totalDisbursed += toFiniteNumber(loan.total);
    }

    // What's still owed today across the outstanding book. `remainingBalance`
    // is only written once a payroll deduction has landed against the loan
    // (processPayroll.ts); before that the full `total` is owed.
    if (OUTSTANDING_STATUSES.includes(status)) {
      outstandingBalance += toFiniteNumber(loan.remainingBalance ?? loan.total);
    }
  }

  const adoptionRate =
    employeeCount > 0 ? `${Math.round((borrowers.size / employeeCount) * 100)}%` : '0%';

  return {
    totalEmployees: employeeCount,
    activeLoans,
    overdueCount,
    totalDisbursed,
    outstandingBalance,
    adoptionRate,
  };
}
