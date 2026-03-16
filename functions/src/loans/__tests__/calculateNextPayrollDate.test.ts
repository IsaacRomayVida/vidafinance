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
});
