import { calculateNextPayrollDate } from '../calculateNextPayrollDate';
import { Timestamp } from 'firebase-admin/firestore';

describe('calculateNextPayrollDate', () => {
  const today = new Date(2026, 2, 16); // Monday March 16, 2026

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(today);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('weekly', () => {
    it('returns next Monday when today is Monday', () => {
      const result = calculateNextPayrollDate('weekly');
      expect(result).toBeInstanceOf(Timestamp);
      const date = result.toDate();
      expect(date.getDay()).toBe(1); // Monday
      expect(date > today).toBe(true);
    });

    it('returns next Monday when today is Wednesday', () => {
      jest.setSystemTime(new Date(2026, 2, 18)); // Wednesday
      const result = calculateNextPayrollDate('weekly');
      const date = result.toDate();
      expect(date.getDay()).toBe(1); // Monday
      expect(date.getDate()).toBe(23); // March 23
    });

    it('returns next Monday when today is Sunday', () => {
      jest.setSystemTime(new Date(2026, 2, 15)); // Sunday March 15
      const result = calculateNextPayrollDate('weekly');
      const date = result.toDate();
      expect(date.getDay()).toBe(1); // Monday
    });
  });

  describe('biweekly', () => {
    it('returns a Monday at least 14 days out', () => {
      const result = calculateNextPayrollDate('biweekly');
      const date = result.toDate();
      expect(date.getDay()).toBe(1); // Monday
      const diffDays = Math.floor((date.getTime() - today.getTime()) / 86400000);
      expect(diffDays).toBeGreaterThanOrEqual(14);
    });
  });

  describe('semimonthly', () => {
    it('returns the 15th when today is before the 15th', () => {
      jest.setSystemTime(new Date(2026, 2, 10)); // March 10
      const result = calculateNextPayrollDate('semimonthly');
      const date = result.toDate();
      expect(date.getDate()).toBe(15);
      expect(date.getMonth()).toBe(2); // March
    });

    it('returns end of month when today is after the 15th', () => {
      jest.setSystemTime(new Date(2026, 2, 16)); // March 16
      const result = calculateNextPayrollDate('semimonthly');
      const date = result.toDate();
      expect(date.getDate()).toBe(31); // March 31
    });

    it('returns next month 15th when today is last day of month', () => {
      jest.setSystemTime(new Date(2026, 2, 31)); // March 31
      const result = calculateNextPayrollDate('semimonthly');
      const date = result.toDate();
      expect(date.getDate()).toBe(15);
      expect(date.getMonth()).toBe(3); // April
    });
  });

  describe('monthly', () => {
    it('returns last day of current month when not yet passed', () => {
      jest.setSystemTime(new Date(2026, 2, 16)); // March 16
      const result = calculateNextPayrollDate('monthly');
      const date = result.toDate();
      expect(date.getDate()).toBe(31); // March 31
    });

    it('returns last day of next month when today is last day', () => {
      jest.setSystemTime(new Date(2026, 2, 31)); // March 31
      const result = calculateNextPayrollDate('monthly');
      const date = result.toDate();
      expect(date.getDate()).toBe(30); // April 30
    });
  });

  describe('default / unknown frequency', () => {
    it('falls back to monthly behavior', () => {
      const result = calculateNextPayrollDate('unknown_frequency');
      const monthly = calculateNextPayrollDate('monthly');
      expect(result.toDate().getTime()).toBe(monthly.toDate().getTime());
    });
  });

  // #437 — the optional anchor. requestLoan passes `now + termDays` so a loan's
  // due date is the first REAL payday that is not earlier than the term the
  // borrower was quoted, resolved once, at creation. Everything above pins the
  // no-anchor behaviour, which this must not disturb: markLoanDisbursed's
  // legacy path still depends on it.
  describe('anchored on a date (#437)', () => {
    const FREQUENCIES = ['weekly', 'biweekly', 'semimonthly', 'monthly', 'unknown'] as const;

    it.each(FREQUENCIES)('never returns a %s date earlier than the anchor', (frequency) => {
      // Every day of a full cycle, at mid-morning — the case that matters,
      // since a loan is requested at a time of day and payroll dates are
      // midnights.
      for (let dayOffset = 1; dayOffset <= 70; dayOffset++) {
        const anchor = new Date(2026, 2, 16 + dayOffset, 9, 30, 0);
        const result = calculateNextPayrollDate(frequency, anchor).toDate();
        expect(result.getTime()).toBeGreaterThanOrEqual(anchor.getTime());
      }
    });

    it.each([
      ['weekly', new Date(2026, 3, 20)],
      ['biweekly', new Date(2026, 3, 20)],
      ['semimonthly', new Date(2026, 3, 30)],
      ['monthly', new Date(2026, 3, 30)],
    ] as const)(
      'gives a %s borrower the first payday on or after the anchor',
      (frequency, expected) => {
        // 15 Apr 2026 10:00 — what `now + 30 days` is for a loan requested on
        // the pinned clock above.
        const anchor = new Date(2026, 3, 15, 10, 0, 0);
        expect(calculateNextPayrollDate(frequency, anchor).toDate()).toEqual(expected);
      }
    );

    it('accepts a payday that falls exactly on the anchor', () => {
      // On or after, not strictly after. A borrower whose payday lands exactly
      // on day 30 is collected then, not pushed a whole cycle out.
      const monday = new Date(2026, 3, 20);
      expect(calculateNextPayrollDate('weekly', monday).toDate()).toEqual(monday);

      const monthEnd = new Date(2026, 3, 30);
      expect(calculateNextPayrollDate('monthly', monthEnd).toDate()).toEqual(monthEnd);

      const fifteenth = new Date(2026, 3, 15);
      expect(calculateNextPayrollDate('semimonthly', fifteenth).toDate()).toEqual(fifteenth);
    });

    it('skips a payday whose midnight is earlier in the day than the anchor', () => {
      // Monday 20 April at 00:00 is ten hours SHORT of an anchor of Monday 20
      // April at 10:00. Ten hours off a 30-day term moves the CAT by tens of
      // percentage points, and only in the direction that understates it.
      const midMorningOnAPayday = new Date(2026, 3, 20, 10, 0, 0);
      expect(calculateNextPayrollDate('weekly', midMorningOnAPayday).toDate()).toEqual(
        new Date(2026, 3, 27)
      );
    });

    it('advances a biweekly borrower in whole 14-day cycles, not to the nearest Monday', () => {
      // A biweekly borrower is not paid every Monday. Their next payday under
      // the model this repo uses is Mon 6 Apr (the first Monday after today,
      // a fortnight on); every later one is 14 days apart from it.
      const nextPayday = calculateNextPayrollDate('biweekly').toDate();
      expect(nextPayday).toEqual(new Date(2026, 3, 6));

      for (let dayOffset = 1; dayOffset <= 70; dayOffset++) {
        const anchor = new Date(2026, 2, 16 + dayOffset, 9, 30, 0);
        const result = calculateNextPayrollDate('biweekly', anchor).toDate();
        const daysOn = Math.round((result.getTime() - nextPayday.getTime()) / 86400000);
        expect(daysOn % 14).toBe(0);
      }
    });

    it('crosses a year boundary', () => {
      expect(calculateNextPayrollDate('monthly', new Date(2026, 11, 20, 8, 0, 0)).toDate()).toEqual(
        new Date(2026, 11, 31)
      );
      expect(calculateNextPayrollDate('monthly', new Date(2027, 0, 1)).toDate()).toEqual(
        new Date(2027, 0, 31)
      );
      expect(
        calculateNextPayrollDate('semimonthly', new Date(2026, 11, 31, 8, 0, 0)).toDate()
      ).toEqual(new Date(2027, 0, 15));
    });

    it('lands on 29 February in a leap year, as the calendar does', () => {
      expect(calculateNextPayrollDate('monthly', new Date(2028, 1, 3, 8, 0, 0)).toDate()).toEqual(
        new Date(2028, 1, 29)
      );
    });
  });
});
