/**
 * Pure helpers that turn loan documents and the published repayment terms
 * into what the borrower screens show. Nothing here invents a figure: every
 * peso and every percent comes from the server document or config.
 */
import type { LoanConfig, RepaymentTerms } from '../api/callables';

export interface ScheduleEntry {
  number: number;
  amount: number;
  dueDate?: { seconds: number } | null;
}

export interface LoanDoc {
  id: string;
  status?: string;
  amount?: number;
  principalAmount?: number;
  totalRepaymentAmount?: number;
  total?: number;
  amountPaid?: number;
  paidAmount?: number;
  createdAt?: { seconds: number };
  dueDate?: { seconds: number };
  loanRef?: string;
  employerName?: string;
  repaymentSchedule?: ScheduleEntry[];
}

export const ACTIVE_STATUSES = ['active', 'disbursed', 'overdue', 'in_collections'] as const;
export const PAID_STATUSES = ['repaid'] as const;

export function isActiveLoan(loan: LoanDoc): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(loan.status ?? '');
}
export function isPaidLoan(loan: LoanDoc): boolean {
  return (PAID_STATUSES as readonly string[]).includes(loan.status ?? '');
}

export function principalOf(loan: LoanDoc): number | undefined {
  return typeof loan.principalAmount === 'number' ? loan.principalAmount : loan.amount;
}
export function totalOf(loan: LoanDoc): number | undefined {
  return typeof loan.totalRepaymentAmount === 'number' ? loan.totalRepaymentAmount : loan.total;
}
/** Repaid so far, only when the document actually records it. */
export function paidOf(loan: LoanDoc): number | undefined {
  if (typeof loan.amountPaid === 'number') return loan.amountPaid;
  if (typeof loan.paidAmount === 'number') return loan.paidAmount;
  return undefined;
}

/** The published terms for the term the request will use. */
export function termsFor(config: LoanConfig, termDays: number): RepaymentTerms | undefined {
  return config.repayment.find((r) => r.termDays === termDays) ?? config.repayment[0];
}

/** Whole-peso installment amounts for a total, from the published shares. */
export function installmentAmounts(total: number, terms: RepaymentTerms | undefined): number[] {
  if (!terms || !Array.isArray(terms.installments) || terms.installments.length === 0) return [total];
  return terms.installments.map((i) => Math.round(total * i.shareOfTotal));
}

/** Plain "8,000" — the numeral hero carries its own MXN suffix. */
export function numeral(amount: number | undefined): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—';
  return Math.round(amount).toLocaleString('es-MX');
}

/** `15 sep` — dates as the skill formats them. */
export function shortDate(ts?: { seconds: number } | null): string {
  if (!ts || typeof ts.seconds !== 'number') return '—';
  const d = new Date(ts.seconds * 1000);
  const month = d.toLocaleDateString('es-MX', { month: 'short' }).replace('.', '');
  return `${d.getDate()} ${month}`;
}
