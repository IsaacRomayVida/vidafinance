/**
 * The borrower's credit line, as the backend actually computes it.
 *
 * Mirrors `onEmployeeDocCreated` in functions/src/index.ts:
 *   creditLimit = Math.max(Math.min(salary * EMPLOYEE_CREDIT_SALARY_RATIO,
 *                                   EMPLOYEE_CREDIT_CEILING), 0)
 * with EMPLOYEE_CREDIT_SALARY_RATIO = 0.3 and EMPLOYEE_CREDIT_CEILING = 5000
 * (functions/src/index.ts:74-75), and re-checked on every loan by requestLoan
 * (`amount > Math.round(monthlySalary * EMPLOYEE_CREDIT_SALARY_RATIO)` and
 * `amount > availableCredit`).
 *
 * public-v2 and functions are separate TypeScript projects with no shared
 * package, so this cannot import those constants; creditLine.test.ts is what
 * keeps the two in agreement, the same arrangement payFrequencies.ts and
 * loanStatus.ts already use.
 *
 * This exists because the homepage calculator asked the visitor for their
 * monthly salary and then ignored it: the "how much can you access" slider ran
 * 500–5,000 for everybody. On the Mexican payroll-lending book that is most of
 * the market — anyone earning under 16,667 MXN/month was shown a line larger
 * than the one they would actually be granted, with an "estimated repayment"
 * to match, before they ever created an account.
 */

/** Share of monthly salary a borrower may draw. */
export const CREDIT_SALARY_RATIO = 0.3;

/** Hard ceiling on the credit line, in MXN, regardless of salary. */
export const CREDIT_CEILING = 5000;

/**
 * The smallest loan the product originates (MIN_LOAN_AMOUNT server-side,
 * MIN_AMOUNT in loanSlider.ts). A line below this cannot be drawn at all.
 */
export const MIN_CREDIT_LINE = 500;

/**
 * The credit line for a monthly salary, in MXN. Returns 0 for anything that is
 * not a positive finite number — an empty or half-typed salary field must read
 * as "we don't know yet", never as the ceiling.
 */
export function creditLineFor(monthlySalary: number): number {
  if (typeof monthlySalary !== 'number' || !Number.isFinite(monthlySalary) || monthlySalary <= 0) {
    return 0;
  }
  return Math.max(Math.min(monthlySalary * CREDIT_SALARY_RATIO, CREDIT_CEILING), 0);
}

/**
 * The credit line rounded down to the calculator's 100-peso step, so the
 * slider's maximum is a value the slider can actually land on. Returns 0 when
 * the line is below the minimum loan — the caller shows "not eligible yet"
 * rather than a slider whose range is empty.
 */
export function selectableCreditLine(monthlySalary: number): number {
  const line = creditLineFor(monthlySalary);
  if (line < MIN_CREDIT_LINE) return 0;
  return Math.floor(line / 100) * 100;
}
