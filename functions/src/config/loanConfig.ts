import { getFirestore } from 'firebase-admin/firestore';

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
// This constant is the SEED value (#389): it is what getLoanConfigValues()
// returns until an admin has proposed AND a second admin has approved a change
// (see config/loanConfigAdmin.ts). It is NOT a fallback — once the config
// document exists, an unreadable or out-of-bounds value throws rather than
// silently reverting here. The rate in force at loan creation is persisted ON
// the loan document — a later change must never reprice a loan a borrower has
// already signed.
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

// ── The admin-editable slice (#389) ───────────────────────────────────────────
// Exactly ONE field is editable: feeRate. Terms, min and max stay code-owned —
// changing the allowed term list is not a config change, it is a change to what
// underwriting, the deduction schedule and the contract PDF's CAT calculation
// are verified to support (see ALLOWED_LOAN_TERM_DAYS above).
export const LOAN_CONFIG_COLLECTION = 'config';
export const LOAN_CONFIG_DOC_ID = 'loan';
export const LOAN_CONFIG_DOC_PATH = `${LOAN_CONFIG_COLLECTION}/${LOAN_CONFIG_DOC_ID}`;

// Hard server-side bounds on the fee rate. These are COMPILE-TIME constants and
// are deliberately not represented anywhere in Firestore: no API, no callable
// and no admin can widen them, so a fat-fingered `3.0` (300%) is impossible
// rather than merely unlikely. Raising the ceiling is a code change that goes
// through review. Enforced on write (proposeLoanConfigChange /
// approveLoanConfigChange) AND again on read, because a value that reached the
// document by any other route — a console edit, a restore from a backup taken
// under older bounds, a compromised service account — must still not be able to
// price a loan.
export const MIN_ALLOWED_FEE_RATE = 0;
export const MAX_ALLOWED_FEE_RATE = 0.35;

/** Thrown by the read path when the stored config cannot be trusted. */
export class LoanConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoanConfigError';
  }
}

/**
 * The compile-time seed. Returned verbatim when the config document does not
 * exist yet, and used by the propose/approve callables as the "before" value in
 * that same case.
 */
export function getSeedLoanConfigValues(): LoanConfig {
  return {
    feeRate: LOAN_FEE_RATE,
    allowedTermDays: [...ALLOWED_LOAN_TERM_DAYS],
    defaultTermDays: DEFAULT_LOAN_TERM_DAYS,
    minAmount: MIN_LOAN_AMOUNT,
    maxAmount: MAX_LOAN_AMOUNT,
  };
}

/**
 * Bounds check shared by the read and write paths. Returns the rate so it can
 * be used inline; throws LoanConfigError on anything that is not a finite
 * number inside [MIN_ALLOWED_FEE_RATE, MAX_ALLOWED_FEE_RATE].
 *
 * NaN and Infinity are rejected explicitly: `NaN >= 0` is false so they would
 * fall out of the range comparison anyway, but relying on that is the kind of
 * accident that stops being true when someone "simplifies" the condition.
 */
export function assertValidFeeRate(rate: unknown, context: string): number {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    throw new LoanConfigError(
      `${context}: feeRate must be a finite number, got ${JSON.stringify(rate)}`
    );
  }
  if (rate < MIN_ALLOWED_FEE_RATE || rate > MAX_ALLOWED_FEE_RATE) {
    throw new LoanConfigError(
      `${context}: feeRate ${rate} is outside the permitted range ` +
        `[${MIN_ALLOWED_FEE_RATE}, ${MAX_ALLOWED_FEE_RATE}]`
    );
  }
  return rate;
}

/**
 * The single read path for loan pricing. Every quote and every priced loan goes
 * through here.
 *
 * FAILS CLOSED, deliberately (same failure class as P1-4). There are exactly
 * three outcomes:
 *
 *   1. The document does not exist       -> return the compile-time seed.
 *   2. The document exists and is valid  -> return the stored feeRate.
 *   3. Anything else — the read threw, the document is malformed, the stored
 *      rate is out of bounds             -> THROW.
 *
 * There is no fourth branch that returns a default. A borrower must never be
 * quoted, and a loan must never be priced at, a rate nobody chose: silently
 * substituting 30% when the stored value is unreadable would print a number on
 * a CONDUSEF-regulated contract that no admin ever approved. A hard failure is
 * a visible outage; a silent fallback is a mispriced loan book.
 *
 * Async as of #389 — callers must await. Firestore's client caches this read,
 * so the per-request cost is a local lookup in the warm case.
 */
export async function getLoanConfigValues(): Promise<LoanConfig> {
  const seed = getSeedLoanConfigValues();

  let snapshot: FirebaseFirestore.DocumentSnapshot;
  try {
    snapshot = await getFirestore()
      .collection(LOAN_CONFIG_COLLECTION)
      .doc(LOAN_CONFIG_DOC_ID)
      .get();
  } catch (err) {
    // Unreadable != unset. We cannot tell whether an admin-approved rate is
    // sitting behind this error, so we refuse to price anything.
    throw new LoanConfigError(
      `Loan config at ${LOAN_CONFIG_DOC_PATH} could not be read: ` +
        (err instanceof Error ? err.message : String(err))
    );
  }

  if (!snapshot.exists) {
    // Never been configured. The seed IS the chosen value (ADR-002), not a guess.
    return seed;
  }

  const data = snapshot.data();
  if (!data || typeof data !== 'object') {
    throw new LoanConfigError(`Loan config at ${LOAN_CONFIG_DOC_PATH} exists but has no data`);
  }

  return {
    ...seed,
    feeRate: assertValidFeeRate(data['feeRate'], `Loan config at ${LOAN_CONFIG_DOC_PATH}`),
  };
}
