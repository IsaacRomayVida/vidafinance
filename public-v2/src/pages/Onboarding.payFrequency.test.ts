import { describe, expect, it } from 'vitest';
import { PAY_FREQUENCIES } from '../lib/payFrequencies';

// Mirrors the PayFrequency union in
// functions/src/loans/calculateNextPayrollDate.ts — the set of cadences that
// calculateNextPayrollDate has a real branch for. Anything outside this list
// falls through to its `default` case and is silently priced as 'monthly'.
//
// This is the regression guard for #435: 'semimonthly' was a value
// calculateNextPayrollDate already understood, but no onboarding tile could
// ever produce it, so the branch sat unreachable while borrowers were quoted
// dates from the wrong cadence instead. If PAY_FREQUENCIES ever grows a value
// this list doesn't contain, that same class of bug is back.
const FREQUENCIES_CALCULATE_NEXT_PAYROLL_DATE_HANDLES = ['weekly', 'biweekly', 'semimonthly', 'monthly'];

describe('onboarding pay frequency options', () => {
  it('offers only cadences calculateNextPayrollDate can compute a real date for', () => {
    for (const freq of PAY_FREQUENCIES) {
      expect(FREQUENCIES_CALCULATE_NEXT_PAYROLL_DATE_HANDLES).toContain(freq);
    }
  });

  it('includes semimonthly, so the "Quincenal" tile stores the correct cadence', () => {
    expect(PAY_FREQUENCIES).toContain('semimonthly');
  });
});
