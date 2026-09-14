export interface Repayment {
  id: string;
  loanId: string;
  amount: number;
  paidAt?: { seconds: number };
  createdAt?: { seconds: number };
  method?: string;
  status?: string;
  [key: string]: unknown;
}

export interface EmployeeData {
  name?: string;
  email?: string;
  employerName?: string;
  employerId?: string;
  bankClabe?: string;
  creditLimit: number;
  availableCredit: number;
  kycStatus?: string;
  employerCode?: string;
}

/** One scheduled payroll deduction, as requestLoan persists it on the loan. */
export interface ScheduledDeduction {
  number: number;
  amount: number;
  dueDate?: { seconds: number };
}

export interface Loan {
  id: string;
  amount: number;
  termDays?: number;
  term?: number;
  repaymentAmount?: number;
  total?: number;
  status: string;
  createdAt?: { seconds: number };
  dueDate?: { seconds: number };
  // Cost fields written once at requestLoan time (functions/src/index.ts).
  // They are read here for the disclosure line and never recomputed: a CAT
  // the client derived would be a second opinion on a regulated figure.
  fee?: number;
  catPercent?: number;
  repaymentSchedule?: ScheduledDeduction[];
  employerName?: string;
  borrowerSnapshot?: { payFrequency?: string };
  [key: string]: unknown;
}

export const LOAN_PURPOSES = [
  'emergency',
  'medical',
  'education',
  'home_repair',
  'transportation',
  'debt_consolidation',
  'other',
] as const;

export function fmt(n: number): string {
  return n.toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/** `15 sep` — the short date the design uses beside every peso figure. */
export function fmtShortDate(ts: { seconds: number } | undefined, lang: string): string | null {
  if (!ts) return null;
  const d = new Date(ts.seconds * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return d
    .toLocaleDateString(lang.startsWith('en') ? 'en-US' : 'es-MX', { day: 'numeric', month: 'short' })
    .replace('.', '');
}

/** Two-letter initials for the avatar circle; never a stock face. */
export function initials(name?: string | null, fallback = 'FP'): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : '';
  return (first + last).toUpperCase() || fallback;
}

/**
 * The first scheduled deduction not yet covered by what has been paid, or
 * null when the schedule is missing or fully covered. A step counts as covered
 * once the cumulative schedule up to it is within the money already paid.
 */
export function nextScheduledDeduction(
  schedule: ScheduledDeduction[] | undefined,
  paid: number,
): ScheduledDeduction | null {
  if (!schedule || schedule.length === 0) return null;
  let cumulative = 0;
  for (const step of schedule) {
    cumulative += step.amount || 0;
    if (paid < cumulative - 0.005) return step;
  }
  return null;
}

/** Whether a loan's deductions are quincenas (semimonthly payroll) or another cadence. */
export function isQuincenal(loan: Loan): boolean {
  return loan.borrowerSnapshot?.payFrequency === 'semimonthly';
}

/**
 * The lines every screen showing a request/offer/active credit must carry,
 * without a tap: total to repay, the per-deduction amount, the CAT labelled
 * informational. `null` in any slot renders as missing, never as a number.
 */
export function costLine(
  t: (key: string, opts?: Record<string, unknown>) => string,
  parts: { total: number | null; deduction: number | null; cat: number | string | null; quincenal?: boolean },
): string {
  const total = parts.total === null ? t('cost_pending') : t('cost_total', { total: fmt(parts.total) });
  const per =
    parts.deduction === null
      ? t('cost_pending')
      : t(parts.quincenal ? 'cost_per_quincena' : 'cost_per_deduction', { amount: fmt(parts.deduction) });
  const cat = parts.cat === null ? t('cost_cat_pending') : t('cost_cat', { cat: String(parts.cat) });
  return `${total} · ${per} · ${cat}`;
}
