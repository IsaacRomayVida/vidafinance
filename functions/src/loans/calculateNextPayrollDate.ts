import { Timestamp } from 'firebase-admin/firestore';

export type PayFrequency = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';

/**
 * Calculates the next payroll date after today based on the employer's pay frequency.
 * - weekly:      next Monday (or same day if today is Monday and it's early)
 * - biweekly:    every 14 days from next Monday
 * - semimonthly: 15th and last day of the month
 * - monthly:     last day of the current month (or next month if already past)
 */
export function calculateNextPayrollDate(frequency: PayFrequency | string): Timestamp {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (frequency) {
    case 'weekly': {
      // Next Monday
      const daysUntilMonday = ((8 - today.getDay()) % 7) || 7;
      const nextMonday = new Date(today);
      nextMonday.setDate(today.getDate() + daysUntilMonday);
      return Timestamp.fromDate(nextMonday);
    }

    case 'biweekly': {
      // Next Monday that is 14 days out
      const daysUntilMonday = ((8 - today.getDay()) % 7) || 7;
      const firstMonday = new Date(today);
      firstMonday.setDate(today.getDate() + daysUntilMonday);
      // Ensure at least 14 days from today
      if (firstMonday.getTime() - today.getTime() < 14 * 86400000) {
        firstMonday.setDate(firstMonday.getDate() + 14);
      }
      return Timestamp.fromDate(firstMonday);
    }

    case 'semimonthly': {
      // Next 15th or last day of month
      const fifteenth = new Date(today.getFullYear(), today.getMonth(), 15);
      if (fifteenth > today) {
        return Timestamp.fromDate(fifteenth);
      }
      const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      if (lastDay > today) {
        return Timestamp.fromDate(lastDay);
      }
      // Next month's 15th
      return Timestamp.fromDate(new Date(today.getFullYear(), today.getMonth() + 1, 15));
    }

    case 'monthly':
    default: {
      // Last day of current month, or next month if already past
      const lastDayThisMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      if (lastDayThisMonth > today) {
        return Timestamp.fromDate(lastDayThisMonth);
      }
      return Timestamp.fromDate(new Date(today.getFullYear(), today.getMonth() + 2, 0));
    }
  }
}
