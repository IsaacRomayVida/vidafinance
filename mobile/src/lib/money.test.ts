import { describe, expect, it } from 'vitest';

import { formatDate, formatMxn, previewTotal } from './money';

describe('formatMxn', () => {
  it('renders whole pesos', () => {
    expect(formatMxn(5000)).toMatch(/^\$5[,.]?000$/);
  });

  it('renders a dash for anything that is not a finite number — an unknown must never read as $0', () => {
    expect(formatMxn(undefined)).toBe('—');
    expect(formatMxn(NaN)).toBe('—');
    expect(formatMxn('5000')).toBe('—');
  });
});

describe('previewTotal', () => {
  it('matches the server rounding: round(amount * (1 + feeRate))', () => {
    expect(previewTotal(1000, 0.3)).toBe(1300);
    expect(previewTotal(1500, 0.08)).toBe(1620);
  });

  it('refuses to quote from garbage inputs — no rate means no number, never a wrong one', () => {
    expect(previewTotal(0, 0.3)).toBeNull();
    expect(previewTotal(1000, NaN)).toBeNull();
    expect(previewTotal(1000, -0.1)).toBeNull();
  });
});

describe('formatDate', () => {
  it('renders a dash for a missing timestamp', () => {
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate(null)).toBe('—');
  });

  it('renders a date for a Firestore seconds timestamp', () => {
    expect(formatDate({ seconds: 1725580800 })).not.toBe('—');
  });
});
