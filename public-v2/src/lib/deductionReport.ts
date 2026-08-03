// Pure logic behind the employer deduction report. It lives here rather than
// in DeductionReports.tsx so it can be unit-tested directly: a .tsx file that
// exports non-components trips react-refresh/only-export-components, and the
// rule is right — this is shared logic, not a component.

export interface Loan {
  id: string;
  employeeName?: string;
  amount: number;
  fee?: number;
  total?: number;
  remainingBalance?: number;
  // The persisted fields are `borrowerSnapshot.payFrequency` and
  // `payFrequencySource` (functions/src/index.ts:850-851); `frequency` is
  // never written to the document — see getPayFrequency below.
  borrowerSnapshot?: { payFrequency?: string };
  payFrequencySource?: string;
  termDays?: number;
  status: string;
  softcreditoDeductionId?: string;
  createdAt?: { seconds: number };
  [key: string]: unknown;
}

export interface PeriodGroup {
  key: string;
  label: string;
  loans: Loan[];
  total: number;
}

export function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export function fmtCurrency(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * What the employer still owes on this loan via payroll deduction.
 *
 * `loan.remainingBalance` is the live outstanding figure once processPayroll
 * has run at least once (functions/src/payroll/processPayroll.ts:125); before
 * that it doesn't exist on the document yet, and the full obligation is
 * `loan.total` (= amount + fee, functions/src/index.ts:838) — never bare
 * `loan.amount`, which is principal only and always understates it. If
 * neither field is present the true obligation is unknown; returning null
 * (rather than silently falling back to `amount`) is what this fixes.
 */
export function getDeductionAmount(loan: Loan): number | null {
  if (typeof loan.remainingBalance === 'number' && Number.isFinite(loan.remainingBalance)) {
    return loan.remainingBalance;
  }
  if (typeof loan.total === 'number' && Number.isFinite(loan.total)) {
    return loan.total;
  }
  return null;
}

export function formatDeductionAmount(loan: Loan): string {
  const amount = getDeductionAmount(loan);
  return amount === null ? '—' : fmtCurrency(amount);
}

/**
 * The pay frequency this report should show the employer for a loan, or
 * null if it isn't known with confidence.
 *
 * `loan.frequency` is never written to the document — requestLoan persists
 * `borrowerSnapshot.payFrequency` (functions/src/index.ts:850), so reading
 * `loan.frequency ?? 'monthly'` always fell through to the default and every
 * row silently showed "monthly" regardless of the truth. That default is
 * exactly the failure mode to avoid here: this report is what the employer
 * runs payroll against, so a wrong-but-plausible cadence is worse than an
 * honest gap.
 *
 * `payFrequencySource === 'default_monthly'` (see resolvePayFrequency.ts)
 * means the backend itself could not read the borrower's real cadence and
 * priced the loan against an assumption — it logs a warning for exactly
 * this reason. An assumption should not be handed to the employer with the
 * same confidence as a known fact, so it is treated as unknown here too.
 */
export function getPayFrequency(loan: Loan): string | null {
  if (loan.payFrequencySource === 'default_monthly') return null;
  const value = loan.borrowerSnapshot?.payFrequency;
  return typeof value === 'string' && value ? value : null;
}

function getPeriodKey(loan: Loan): string {
  if (!loan.createdAt) return '0000-00';
  const d = new Date(loan.createdAt.seconds * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function getPeriodLabel(key: string): string {
  if (key === '0000-00') return 'Unknown';
  const [y, m] = key.split('-');
  const months = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
  ];
  return `${months[Number(m) - 1]} ${y}`;
}

export function groupByPeriod(loans: Loan[]): PeriodGroup[] {
  const map = new Map<string, Loan[]>();
  for (const loan of loans) {
    const key = getPeriodKey(loan);
    const arr = map.get(key) ?? [];
    arr.push(loan);
    map.set(key, arr);
  }

  return Array.from(map.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, groupLoans]) => ({
      key,
      label: getPeriodLabel(key),
      loans: groupLoans,
      total: groupLoans.reduce((s, l) => s + (getDeductionAmount(l) ?? 0), 0),
    }));
}

export const CSV_HEADERS = ['Period', 'Employee', 'Deduction Amount', 'Frequency', 'Status', 'Deduction ID'];

export function buildCsvRows(groups: PeriodGroup[]): string[][] {
  const rows: string[][] = [];

  for (const group of groups) {
    for (const loan of group.loans) {
      rows.push([
        group.label,
        loan.employeeName ?? '',
        formatDeductionAmount(loan),
        getPayFrequency(loan) ?? '',
        loan.status,
        loan.softcreditoDeductionId ?? '',
      ]);
    }
    rows.push([group.label, 'TOTAL', fmtCurrency(group.total), '', '', '']);
  }

  return rows;
}

export function buildCsv(groups: PeriodGroup[]): string {
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return [CSV_HEADERS, ...buildCsvRows(groups)].map((r) => r.map(escape).join(',')).join('\n');
}
