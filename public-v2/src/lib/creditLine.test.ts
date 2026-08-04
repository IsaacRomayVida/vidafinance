import { describe, expect, it } from 'vitest';
import {
  CREDIT_CEILING,
  CREDIT_SALARY_RATIO,
  MIN_CREDIT_LINE,
  creditLineFor,
  selectableCreditLine,
} from './creditLine';

/**
 * Mirrors functions/src/index.ts:74-75 and the formula at :3161 —
 *
 *   const EMPLOYEE_CREDIT_SALARY_RATIO = 0.3;
 *   const EMPLOYEE_CREDIT_CEILING = 5000;
 *   const creditLimit = Math.max(
 *     Math.min(salary * EMPLOYEE_CREDIT_SALARY_RATIO, EMPLOYEE_CREDIT_CEILING), 0);
 *
 * public-v2 and functions are separate TypeScript projects with no shared
 * package, so these values can't be imported; this test is what keeps them in
 * agreement, the same arrangement Onboarding.payFrequency.test.ts uses for the
 * pay-frequency union.
 */
const BACKEND_EMPLOYEE_CREDIT_SALARY_RATIO = 0.3;
const BACKEND_EMPLOYEE_CREDIT_CEILING = 5000;
/** MIN_LOAN_AMOUNT, functions/src/config/loanConfig.ts:33. */
const BACKEND_MIN_LOAN_AMOUNT = 500;

describe('credit-line constants track the backend', () => {
  it('uses the same salary ratio the backend grants and requestLoan re-checks', () => {
    expect(CREDIT_SALARY_RATIO).toBe(BACKEND_EMPLOYEE_CREDIT_SALARY_RATIO);
  });

  it('uses the same ceiling', () => {
    expect(CREDIT_CEILING).toBe(BACKEND_EMPLOYEE_CREDIT_CEILING);
  });

  it('uses the same minimum loan amount', () => {
    expect(MIN_CREDIT_LINE).toBe(BACKEND_MIN_LOAN_AMOUNT);
  });
});

describe('creditLineFor', () => {
  it('grants 30% of salary below the ceiling', () => {
    expect(creditLineFor(10_000)).toBe(3_000);
    expect(creditLineFor(8_400)).toBe(2_520);
  });

  it('caps at the ceiling once salary passes the crossover', () => {
    // 5000 / 0.3 = 16,666.67 — the salary at which the ratio stops binding.
    expect(creditLineFor(16_666)).toBeCloseTo(4_999.8, 5);
    expect(creditLineFor(20_000)).toBe(CREDIT_CEILING);
    expect(creditLineFor(1_000_000)).toBe(CREDIT_CEILING);
  });

  it('reads an unknown or nonsensical salary as zero, never as the ceiling', () => {
    expect(creditLineFor(NaN)).toBe(0);
    expect(creditLineFor(0)).toBe(0);
    expect(creditLineFor(-5_000)).toBe(0);
    expect(creditLineFor(Infinity)).toBe(0);
    expect(creditLineFor(undefined as unknown as number)).toBe(0);
  });
});

describe('selectableCreditLine', () => {
  it('rounds down to the 100-peso slider step', () => {
    // 8,400 MXN/mo (roughly the 2026 general minimum wage) -> 2,520 -> 2,500.
    expect(selectableCreditLine(8_400)).toBe(2_500);
    expect(selectableCreditLine(10_000)).toBe(3_000);
  });

  it('returns 0 below the minimum loan, so the caller can say "not yet"', () => {
    // 0.3 * 1,600 = 480, under the $500 minimum.
    expect(selectableCreditLine(1_600)).toBe(0);
    // 0.3 * 1,666.67 = 500 exactly — the first eligible salary.
    expect(selectableCreditLine(1_666.67)).toBe(500);
  });

  it('never exceeds the ceiling', () => {
    expect(selectableCreditLine(1_000_000)).toBe(CREDIT_CEILING);
  });
});
