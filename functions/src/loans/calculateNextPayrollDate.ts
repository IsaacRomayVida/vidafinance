import { Timestamp } from 'firebase-admin/firestore';

export type PayFrequency = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';

/**
 * Builds a `PayFrequency[]` that TypeScript checks for completeness, not just
 * validity. A plain array typed `readonly PayFrequency[]` rejects a value
 * outside the union but not a union member missing from the array — dropping
 * 'monthly' from such a list compiles clean, which is exactly the asymmetry
 * #435 identified in the old `VALID_FREQUENCIES` declaration. The `[PayFrequency]
 * extends [U[number]]` constraint below fails the call at compile time unless
 * every member of the union is present in `values`.
 */
function completePayFrequencyList<U extends readonly PayFrequency[]>(
  ...values: U & ([PayFrequency] extends [U[number]] ? unknown : never)
): U {
  return values;
}

/**
 * The canonical, compile-time-complete set of pay frequencies (#435). This is
 * the single declaration `resolvePayFrequency.ts` and `approveEmployer.ts`
 * derive from rather than restate. `public-v2` is a separate TypeScript
 * project with no shared package between it and `functions`, so its own
 * `PAY_FREQUENCIES` (public-v2/src/lib/payFrequencies.ts) stays a second,
 * independent declaration — kept in agreement with this one by
 * Onboarding.payFrequency.test.ts rather than by import.
 */
export const PAY_FREQUENCY_VALUES = completePayFrequencyList(
  'weekly',
  'biweekly',
  'semimonthly',
  'monthly'
);

/**
 * Midnight at the start of the calendar day `d` falls on.
 *
 * Exported because every due date in the product is one of these (see the
 * candidates below — all of them are local midnights), so anything that has to
 * ask "has that due DAY passed yet?" must build its cutoff the same way, from
 * the same clock. dailyLoanCheck's arrears sweep is the one that matters: it
 * derives its cutoff here rather than restating the expression, because a
 * cutoff that disagrees with how the due date was written by even a few hours
 * is a borrower marked delinquent on a day they are current.
 *
 * Local getters, as everywhere else that reads these dates back
 * (processPayroll.ts `calendarDay`): the frame the value was written in is the
 * only frame it means anything in.
 */
export const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());

const addDays = (d: Date, days: number): Date => {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
};

/**
 * The first local midnight at or after `instant`.
 *
 * Payroll dates are midnights. An anchor that carries a time of day — "now +
 * 30 days" is 30×24h after a request made at 14:07, so it lands at 14:07 —
 * cannot be satisfied by that same day's midnight, which is hours EARLIER than
 * the anchor. Rounding up rather than down is the difference between a real
 * interval of 30.0 days and one of 29.4, and a 0.6-day shortfall moves the CAT
 * of a 30-day loan by roughly 160 percentage points. It is rounded in the only
 * direction that cannot shorten the interval (#437).
 */
const midnightAtOrAfter = (instant: Date): Date => {
  const floor = startOfDay(instant);
  return floor.getTime() === instant.getTime() ? floor : addDays(floor, 1);
};

/** `day` itself when it is already a Monday, else the Monday after it. */
const firstMondayOnOrAfter = (day: Date): Date => addDays(day, (8 - day.getDay()) % 7);

/**
 * The first payroll date, for the given cadence, that falls on or after
 * `onOrAfter`.
 *
 * - weekly:      Mondays.
 * - biweekly:    every 14 days, phase-anchored on the borrower's next payday.
 * - semimonthly: the 15th and the last day of each month.
 * - monthly:     the last day of each month.
 *
 * `onOrAfter` was added for #437 and is ADDITIVE. Omitted, it defaults to the
 * start of tomorrow which — because every candidate above is a local midnight —
 * is exactly the "next payroll date strictly after today" this function has
 * always returned. The borrower quote and markLoanDisbursed's legacy path both
 * depend on that default being unchanged, and calculateNextPayrollDate.test.ts
 * pins it.
 *
 * Passing an anchor is what lets a loan's due date be resolved ONCE, at
 * creation, instead of at request time and again at disbursement from two
 * different rules (#437). requestLoan passes `now + termDays`; what comes back
 * is a real payday that can never fall earlier than the term the borrower was
 * quoted and disclosed a CAT against.
 */
export function calculateNextPayrollDate(
  frequency: PayFrequency | string,
  onOrAfter?: Date
): Timestamp {
  const today = startOfDay(new Date());
  const tomorrow = addDays(today, 1);
  const earliest = onOrAfter ? midnightAtOrAfter(onOrAfter) : tomorrow;

  switch (frequency) {
    case 'weekly':
      return Timestamp.fromDate(firstMondayOnOrAfter(earliest));

    case 'biweekly': {
      // A biweekly borrower is NOT paid every Monday, so a later anchor has to
      // advance in whole 14-day cycles rather than jump to the nearest Monday.
      // The phase comes from the borrower's next payday under the model this
      // repo has always used — the first Monday after today, a fortnight out —
      // which is also what keeps the no-anchor return value identical.
      let payday = addDays(firstMondayOnOrAfter(tomorrow), 14);
      while (payday < earliest) payday = addDays(payday, 14);
      return Timestamp.fromDate(payday);
    }

    case 'semimonthly': {
      // The 15th of the month `earliest` falls in, else that month's last day.
      // No loop is needed: the last day of a month is by definition on or after
      // every date within it, so the second candidate always resolves.
      const fifteenth = new Date(earliest.getFullYear(), earliest.getMonth(), 15);
      if (fifteenth >= earliest) return Timestamp.fromDate(fifteenth);
      return Timestamp.fromDate(new Date(earliest.getFullYear(), earliest.getMonth() + 1, 0));
    }

    case 'monthly':
    default:
      return Timestamp.fromDate(new Date(earliest.getFullYear(), earliest.getMonth() + 1, 0));
  }
}
