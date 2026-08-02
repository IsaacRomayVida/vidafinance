// ── Loan pricing & term configuration — SINGLE SOURCE OF TRUTH ────────────────
// requestLoan(), the borrower-facing quote (getLoanConfig, consumed by
// LoanWizard.tsx), and the contract PDF (services/pdf-generator) must all
// derive the fee rate and accepted terms from these values. Do not hardcode
// or re-declare them anywhere else — that is exactly how the fee-rate and
// term-list drifted between the UI, the backend, and the contract template.

// TODO(isaac): this rate is UNRATIFIED. It preserves the existing deployed
// backend behavior (30%) so wiring this single source of truth does not
// silently reprice loans out from under you. Before this ships, confirm the
// real commercial fee rate — the UI previously (incorrectly) quoted
// borrowers 8% while the backend charged 30%; that gap was a CONDUSEF
// consumer-protection exposure, not just a bug.
export const LOAN_FEE_RATE = 0.3;

// Only a 30-day term is supported end-to-end today: underwriting risk
// scoring, the repayment/deduction schedule, and the contract PDF's CAT
// calculation all assume 30 days. Do not add 15/45/60 (or any other value)
// here until those systems are verified to support it — the UI previously
// advertised 15/30/45/60 while the backend accepted only 30.
export const ALLOWED_LOAN_TERM_DAYS: readonly number[] = [30];
export const DEFAULT_LOAN_TERM_DAYS = 30;

export const MIN_LOAN_AMOUNT = 500;
export const MAX_LOAN_AMOUNT = 5000;

export interface LoanConfig {
  feeRate: number;
  allowedTermDays: number[];
  defaultTermDays: number;
  minAmount: number;
  maxAmount: number;
}

export function getLoanConfigValues(): LoanConfig {
  return {
    feeRate: LOAN_FEE_RATE,
    allowedTermDays: [...ALLOWED_LOAN_TERM_DAYS],
    defaultTermDays: DEFAULT_LOAN_TERM_DAYS,
    minAmount: MIN_LOAN_AMOUNT,
    maxAmount: MAX_LOAN_AMOUNT,
  };
}
