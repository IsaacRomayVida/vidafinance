import { describe, expect, it } from 'vitest';

import { installmentAmounts, isActiveLoan, numeral, paidOf, termsFor } from './loanView';

describe('loanView', () => {
  it('formats numerals without a currency sign', () => {
    expect(numeral(4500)).toBe('4,500');
    expect(numeral(undefined)).toBe('—');
  });
  it('only reports paid amounts the document records', () => {
    expect(paidOf({ id: 'a' })).toBeUndefined();
    expect(paidOf({ id: 'a', amountPaid: 120 })).toBe(120);
  });
  it('classifies active loans', () => {
    expect(isActiveLoan({ id: 'a', status: 'active' })).toBe(true);
    expect(isActiveLoan({ id: 'a', status: 'repaid' })).toBe(false);
  });
  it('splits a total by the published shares, never inventing a schedule', () => {
    const terms = { termDays: 30, installments: [{ number: 1, dueInDays: 30, shareOfTotal: 1 }], catPercent: 42 };
    expect(installmentAmounts(1300, terms)).toEqual([1300]);
    expect(installmentAmounts(1300, undefined)).toEqual([1300]);
    expect(termsFor({ feeRate: 0.3, repayment: [terms] }, 30)).toBe(terms);
  });
});
