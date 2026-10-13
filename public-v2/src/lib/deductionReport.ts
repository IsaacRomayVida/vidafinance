// Pure logic behind the employer deduction report. It lives here rather than
// in DeductionReports.tsx so it can be unit-tested directly: a .tsx file that
// exports non-components trips react-refresh/only-export-components, and the
// rule is right — this is shared logic, not a component.

import { isRepaidStatus } from './loanStatus';

export interface Loan {
  id: string;
  employeeName?: string;
  amount: number;
  fee?: number;
  total?: number;
  remainingBalance?: number;
  // The contractual amortisation the borrower was quoted and signed, written
  // by requestLoan / markLoanDisbursed via buildLoanInstallments
  // (functions/src/config/loanConfig.ts). Entries are `{ number, amount,
  // dueDate }`, `dueDate` a Firestore Timestamp.
  repaymentSchedule?: unknown;
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

/**
 * One line of the report: one scheduled installment of one loan.
 *
 * `deduction` is what is still to be withheld for that installment, or null
 * when the loan carries no readable schedule (loans created before #424) — in
 * which case there is no per-period figure to give the employer, and inventing
 * one is exactly the defect this report used to have.
 */
export interface ReportRow {
  loan: Loan;
  dueDate: Date | null;
  deduction: number | null;
}

export interface PeriodGroup {
  key: string;
  label: string;
  rows: ReportRow[];
  total: number;
}

export function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export function fmtCurrency(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function roundToCents(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * What the borrower still owes on this loan in total — the loan's balance,
 * NOT this period's deduction (see installmentRows for that).
 *
 * `loan.remainingBalance` is the live outstanding figure once processPayroll
 * has run at least once; before that it doesn't exist on the document yet,
 * and the full obligation is `loan.total` (= amount + fee,
 * functions/src/index.ts:838) — never bare `loan.amount`, which is principal
 * only and always understates it. If neither field is present the true
 * obligation is unknown; returning null (rather than silently falling back to
 * `amount`) is deliberate.
 *
 * A repaid loan owes nothing whatever its document carries: the card channel
 * settles a loan without necessarily zeroing `remainingBalance`, and a legacy
 * repaid document with only `total` would otherwise read as fully owed.
 */
export function getOutstandingBalance(loan: Pick<Loan, 'remainingBalance' | 'total'> & { status?: string }): number | null {
  if (isRepaidStatus(loan.status)) return 0;
  if (typeof loan.remainingBalance === 'number' && Number.isFinite(loan.remainingBalance)) {
    return loan.remainingBalance;
  }
  if (typeof loan.total === 'number' && Number.isFinite(loan.total)) {
    return loan.total;
  }
  return null;
}

export function formatOutstandingBalance(loan: Loan): string {
  const amount = getOutstandingBalance(loan);
  return amount === null ? '—' : fmtCurrency(amount);
}

/** A persisted installment due date, in any shape it may arrive in. */
function toDueDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value !== null && typeof value === 'object') {
    const v = value as { toDate?: unknown; seconds?: unknown };
    if (typeof v.toDate === 'function') {
      const d = (v.toDate as () => unknown).call(value);
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
    }
    if (typeof v.seconds === 'number' && Number.isFinite(v.seconds)) return new Date(v.seconds * 1000);
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * `loan.repaymentSchedule` as installments sorted by due date, or null if the
 * loan does not carry a usable one. All-or-nothing, as processPayroll's
 * parseRepaymentSchedule is: one unreadable entry makes "how much has already
 * been collected" unknowable, so the whole schedule is untrusted.
 */
function parseSchedule(raw: unknown): { amount: number; dueDate: Date }[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: { amount: number; dueDate: Date }[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') return null;
    const amount = Number((entry as Record<string, unknown>)['amount']);
    const dueDate = toDueDate((entry as Record<string, unknown>)['dueDate']);
    if (!Number.isFinite(amount) || amount < 0 || dueDate === null) return null;
    out.push({ amount, dueDate });
  }
  return out.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
}

/**
 * The report lines for one loan: what is still to be withheld for each of its
 * scheduled installments.
 *
 * The "Deducción" column used to be the loan's WHOLE outstanding balance, so an
 * employer reconciling payroll against this sheet withheld the entire debt from
 * one paycheck — $6,500 on a $5,000 loan — instead of the installment the
 * borrower signed for (E10, AUDIT_EMPLOYER_PATH.md). The figure here is the
 * one processPayroll itself collects when a CSV row carries no amount
 * (scheduledDeductionForPeriod in functions/src/payroll/processPayroll.ts):
 * the contractual installments, net of everything already collected —
 * derived from the balance, so card repayments count too — applied oldest
 * installment first. Summed over the installments due by a period's end, the
 * two agree exactly.
 */
export function installmentRows(loan: Loan): ReportRow[] {
  const schedule = parseSchedule(loan.repaymentSchedule);
  const outstanding = getOutstandingBalance(loan);
  if (schedule === null || outstanding === null) {
    return [{ loan, dueDate: null, deduction: null }];
  }

  const scheduledTotal = schedule.reduce((s, i) => s + i.amount, 0);
  let collectedLeft = Math.max(0, scheduledTotal - outstanding);
  return schedule.map((installment) => {
    const covered = Math.min(installment.amount, collectedLeft);
    collectedLeft -= covered;
    return {
      loan,
      dueDate: installment.dueDate,
      deduction: roundToCents(Math.max(0, installment.amount - covered)),
    };
  });
}

/**
 * The pay period an installment belongs to, as `YYYY-MM`.
 *
 * Keyed on the installment's due date — when the deduction is actually owed —
 * not on `loan.createdAt`. Rows used to be filed under the month the loan was
 * ORIGINATED and presented as if that were the deduction period (E10). Local
 * getters on purpose: installment dates are local midnights
 * (calculateNextPayrollDate), and reading them in UTC can move one across a
 * month boundary.
 */
function getPeriodKey(dueDate: Date | null): string {
  if (!dueDate) return '0000-00';
  return `${dueDate.getFullYear()}-${String(dueDate.getMonth() + 1).padStart(2, '0')}`;
}

function getPeriodLabel(key: string): string {
  if (key === '0000-00') return 'Sin calendario de pagos';
  const [y, m] = key.split('-');
  const months = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
  ];
  return `${months[Number(m) - 1]} ${y}`;
}

/** An installment's due date as `YYYY-MM-DD`, local calendar day. */
export function formatDueDate(dueDate: Date | null): string {
  if (!dueDate) return '';
  const m = String(dueDate.getMonth() + 1).padStart(2, '0');
  const d = String(dueDate.getDate()).padStart(2, '0');
  return `${dueDate.getFullYear()}-${m}-${d}`;
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

export function groupByPeriod(loans: Loan[]): PeriodGroup[] {
  const map = new Map<string, ReportRow[]>();
  for (const loan of loans) {
    for (const row of installmentRows(loan)) {
      const key = getPeriodKey(row.dueDate);
      const arr = map.get(key) ?? [];
      arr.push(row);
      map.set(key, arr);
    }
  }

  return Array.from(map.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, rows]) => ({
      key,
      label: getPeriodLabel(key),
      rows: rows.sort((a, b) => (a.dueDate?.getTime() ?? 0) - (b.dueDate?.getTime() ?? 0)),
      total: roundToCents(rows.reduce((s, r) => s + (r.deduction ?? 0), 0)),
    }));
}

export const CSV_HEADERS = [
  'Period', 'Employee', 'Due Date', 'Deduction Amount', 'Outstanding Balance', 'Frequency', 'Status', 'Deduction ID',
];

export function buildCsvRows(groups: PeriodGroup[]): string[][] {
  const rows: string[][] = [];

  for (const group of groups) {
    for (const row of group.rows) {
      rows.push([
        group.label,
        row.loan.employeeName ?? '',
        formatDueDate(row.dueDate),
        row.deduction === null ? '—' : fmtCurrency(row.deduction),
        formatOutstandingBalance(row.loan),
        getPayFrequency(row.loan) ?? '',
        row.loan.status,
        row.loan.softcreditoDeductionId ?? '',
      ]);
    }
    rows.push([group.label, 'TOTAL', '', fmtCurrency(group.total), '', '', '', '']);
  }

  return rows;
}

export function buildCsv(groups: PeriodGroup[]): string {
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return [CSV_HEADERS, ...buildCsvRows(groups)].map((r) => r.map(escape).join(',')).join('\n');
}
