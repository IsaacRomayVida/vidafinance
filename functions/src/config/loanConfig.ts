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

// ── Repayment structure — SINGLE SOURCE OF TRUTH (#424) ──────────────────────
// The borrower-facing quote (LoanWizard.tsx), the CAT on the contract PDF, and
// the payroll deduction we actually register with SoftCrédito must all describe
// the SAME repayment. Until #424 they did not: the wizard computed
// `Math.ceil(termDays / 15)` client-side and quoted the borrower TWO biweekly
// payments of half the total, while functions/src/index.ts registered exactly
// ONE deduction for the full total on the due date. There was no installment
// model anywhere in the backend to quote against.
//
// That is the same defect class as the 8%/30% fee split (ADR-002): a
// pre-contractual disclosure that disagrees with what the product does. Under
// the CONDUSEF regime that is consumer-protection exposure, not a cosmetic bug.
// The fix is the same shape — the server publishes the truth and the client is
// left with nothing to compute.
//
// This array IS the repayment product. It is deliberately code-owned and NOT
// admin-editable: adding a second installment is not a config change, it is a
// change to what can actually be collected. The SoftCrédito adapter registers
// exactly one {amount, deductionDate} per loan
// (services/softcredito-adapter/src/routes/internal.ts), so toPayrollDeduction()
// below refuses to run against a schedule this repo cannot execute — the guard
// that stops a quote from getting ahead of the backend a second time.
export interface RepaymentInstallmentSpec {
  /** 1-based ordinal, in collection order. */
  readonly number: number;
  /**
   * When this installment is collected, as a fraction of the loan term.
   * 1 = on the due date. Expressed as a fraction so the structure does not have
   * to be restated per term if ALLOWED_LOAN_TERM_DAYS ever grows.
   */
  readonly atTermFraction: number;
  /** This installment's share of the loan total. The shares sum to exactly 1. */
  readonly shareOfTotal: number;
}

export const REPAYMENT_STRUCTURE: readonly RepaymentInstallmentSpec[] = [
  { number: 1, atTermFraction: 1, shareOfTotal: 1 },
];

/** One installment as published to the client: timing and share, no pesos. */
export interface RepaymentInstallmentTerms {
  number: number;
  /** Days after disbursement on which this installment is collected. */
  dueInDays: number;
  shareOfTotal: number;
}

/** The repayment terms for one allowed term length, published with the quote. */
export interface RepaymentTerms {
  termDays: number;
  installments: RepaymentInstallmentTerms[];
  /**
   * CAT (Costo Anual Total) as a whole percent, derived from THIS schedule and
   * the fee rate in force. Published rather than computed on the client: the CAT
   * is a regulated disclosure and the client has no business deriving one.
   */
  catPercent: number;
}

export interface LoanConfig {
  feeRate: number;
  allowedTermDays: number[];
  defaultTermDays: number;
  minAmount: number;
  maxAmount: number;
  /** One entry per allowed term, in the same order as `allowedTermDays`. */
  repayment: RepaymentTerms[];
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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * CAT (Costo Anual Total) as a whole percent, DERIVED FROM REPAYMENT_STRUCTURE.
 *
 * The CAT is the annual rate at which the scheduled repayments discount back to
 * the amount disbursed — so it is a statement about *when* money is collected,
 * not only how much. Deriving it from the same array the deduction schedule is
 * built from is the point: if the structure ever gains a real second
 * installment, the disclosed cost follows automatically instead of silently
 * staying on a formula that assumes a single bullet payment.
 *
 * Solved by bisection on the present value of one peso disbursed. For today's
 * single-installment structure this reduces exactly to the closed form
 * `(1 + feeRate) ^ (365 / termDays) - 1` that the contract PDF has always used,
 * which is pinned by a test — the regulated disclosure does not move.
 */
export function computeCatPercent(feeRate: number, termDays: number): number {
  if (typeof feeRate !== 'number' || !Number.isFinite(feeRate) || feeRate < 0) {
    throw new LoanConfigError(`CAT: feeRate must be a finite non-negative number, got ${JSON.stringify(feeRate)}`);
  }
  if (typeof termDays !== 'number' || !Number.isFinite(termDays) || termDays <= 0) {
    throw new LoanConfigError(`CAT: termDays must be a positive finite number, got ${JSON.stringify(termDays)}`);
  }

  // Cash flows per 1.00 peso disbursed.
  const flows = REPAYMENT_STRUCTURE.map((spec) => ({
    years: (termDays * spec.atTermFraction) / 365,
    amount: (1 + feeRate) * spec.shareOfTotal,
  }));
  const presentValue = (rate: number): number =>
    flows.reduce((sum, f) => sum + f.amount / Math.pow(1 + rate, f.years), 0);

  // Bracket, then bisect. presentValue is strictly decreasing in `rate`, and
  // presentValue(0) = 1 + feeRate >= 1, so a root exists at or above 0.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200 && presentValue(hi) > 1; i++) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (presentValue(mid) > 1) lo = mid;
    else hi = mid;
  }

  // Rounded here, once. Every consumer renders the published integer rather than
  // rounding its own copy — two roundings of two slightly different inputs is
  // how a disclosure ends up one percent apart from itself.
  return Math.round(((lo + hi) / 2) * 100);
}

/** The repayment terms published with a quote for one allowed term length. */
export function getRepaymentTerms(feeRate: number, termDays: number): RepaymentTerms {
  return {
    termDays,
    installments: REPAYMENT_STRUCTURE.map((spec) => ({
      number: spec.number,
      dueInDays: Math.round(termDays * spec.atTermFraction),
      shareOfTotal: spec.shareOfTotal,
    })),
    catPercent: computeCatPercent(feeRate, termDays),
  };
}

/** One installment of a specific loan, in pesos, on a specific date. */
export interface LoanInstallment {
  number: number;
  /** Pesos. The installment amounts sum to exactly the loan total. */
  amount: number;
  dueDate: Date;
}

/**
 * The repayment schedule of a specific loan: REPAYMENT_STRUCTURE applied to a
 * total and a due date. This is what requestLoan persists on the loan document
 * AND what the payroll-deduction registration sends, so the schedule a borrower
 * was quoted and the deduction the system registers cannot be different things.
 */
export function buildLoanInstallments(total: number, dueDate: Date, termDays: number): LoanInstallment[] {
  if (typeof total !== 'number' || !Number.isFinite(total)) {
    throw new LoanConfigError(`Repayment schedule: total must be a finite number, got ${JSON.stringify(total)}`);
  }
  if (!(dueDate instanceof Date) || Number.isNaN(dueDate.getTime())) {
    throw new LoanConfigError('Repayment schedule: dueDate must be a valid Date');
  }
  if (typeof termDays !== 'number' || !Number.isFinite(termDays) || termDays <= 0) {
    throw new LoanConfigError(`Repayment schedule: termDays must be positive, got ${JSON.stringify(termDays)}`);
  }

  let allocated = 0;
  return REPAYMENT_STRUCTURE.map((spec, index) => {
    const isLast = index === REPAYMENT_STRUCTURE.length - 1;
    // The final installment absorbs the rounding remainder, so the schedule sums
    // to `total` exactly. A borrower must never be shown installments that add
    // up to a different number than the total they agreed to.
    const amount = isLast ? total - allocated : Math.round(total * spec.shareOfTotal);
    allocated += amount;
    return {
      number: spec.number,
      amount,
      // Measured BACK from the loan's own due date, so the final installment
      // lands exactly on the date the loan document carries. Re-deriving it
      // forward from createdAt would drift by the request latency and put the
      // contract and the deduction on different days.
      dueDate: new Date(dueDate.getTime() - Math.round((1 - spec.atTermFraction) * termDays) * MS_PER_DAY),
    };
  });
}

/**
 * The single payroll deduction sent to `/internal/register-deduction`.
 *
 * The SoftCrédito adapter takes ONE amount and ONE date per loan. Rather than
 * quietly registering the first installment of a longer schedule — which is
 * exactly the under-collection this issue is the mirror image of — this throws.
 * Whoever adds a second installment to REPAYMENT_STRUCTURE has to make the
 * adapter able to register it first.
 */
export function toPayrollDeduction(installments: LoanInstallment[]): { amount: number; dueDate: string } {
  const only = installments[0];
  if (installments.length !== 1 || !only) {
    throw new LoanConfigError(
      `Payroll deduction: the SoftCrédito adapter registers exactly one deduction per loan, ` +
        `but the repayment schedule has ${installments.length} installment(s). Registering a ` +
        `subset would collect less than the borrower was quoted.`
    );
  }
  return { amount: only.amount, dueDate: only.dueDate.toISOString() };
}

/**
 * The compile-time seed. Returned verbatim when the config document does not
 * exist yet, and used by the propose/approve callables as the "before" value in
 * that same case.
 */
export function getSeedLoanConfigValues(): LoanConfig {
  return buildLoanConfig(LOAN_FEE_RATE);
}

/** Assembles the published config for a fee rate — the one place `repayment` is derived. */
function buildLoanConfig(feeRate: number): LoanConfig {
  return {
    feeRate,
    allowedTermDays: [...ALLOWED_LOAN_TERM_DAYS],
    defaultTermDays: DEFAULT_LOAN_TERM_DAYS,
    minAmount: MIN_LOAN_AMOUNT,
    maxAmount: MAX_LOAN_AMOUNT,
    repayment: ALLOWED_LOAN_TERM_DAYS.map((days) => getRepaymentTerms(feeRate, days)),
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

  // Rebuilt from the stored rate rather than spread over the seed: `repayment`
  // carries the CAT, which is a function of the rate. Spreading would have
  // published the SEED's CAT next to the STORED rate — a disclosure that
  // disagrees with the price beside it, which is the whole class of bug #424 is.
  return buildLoanConfig(
    assertValidFeeRate(data['feeRate'], `Loan config at ${LOAN_CONFIG_DOC_PATH}`)
  );
}
