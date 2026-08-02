// ── Loan pricing & term configuration — SINGLE SOURCE OF TRUTH ────────────────
// requestLoan(), the borrower-facing quote (getLoanConfig, consumed by
// LoanWizard.tsx), and the contract PDF (services/pdf-generator) must all
// derive the fee rate and accepted terms from these values. Do not hardcode
// or re-declare them anywhere else — that is exactly how the fee-rate and
// term-list drifted between the UI, the backend, and the contract template.

// RATIFIED 2026-08-02 (Isaac): the flat fee is 30%. This matches the deployed
// backend and the executed contract PDFs. The UI previously (incorrectly)
// quoted borrowers 8% while the backend charged 30% — a CONDUSEF
// consumer-protection exposure, not just a bug. That 8% is now deleted, not
// kept as a fallback: a second constant is how the drift started.
//
// This constant is the SEED value. Issue #389 replaces the body of
// getLoanConfigValues() with a read from an admin-editable config document
// (two-person approval, effective-from semantics, server-enforced bounds,
// append-only audit). Callers must keep reading through getLoanConfigValues()
// so that swap stays a one-line change. The rate in force at loan creation is
// persisted ON the loan document — a later change must never reprice a loan a
// borrower has already signed.
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
