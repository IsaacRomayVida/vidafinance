import { resolvePayFrequency } from '../resolvePayFrequency';
import { calculateNextPayrollDate } from '../calculateNextPayrollDate';
import { _mockStore } from '../../__mocks__/firebase-admin/firestore';

// A borrower whose onboarding tile reads "Quincenal" must, end to end, get a
// deduction date computed from the semimonthly branch (15th / last day of
// month) — not the biweekly branch's "next Monday 14 days out" (#435).
describe('a borrower onboarded as semimonthly (Quincenal)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _mockStore.employees = {};
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves to the semimonthly branch, not a Monday 14 days out', async () => {
    jest.setSystemTime(new Date(2026, 2, 10)); // March 10, 2026 — before the 15th
    _mockStore.employees['borrower-1'] = {
      exists: true,
      data: { payFrequency: 'semimonthly' },
    };

    const resolved = await resolvePayFrequency('borrower-1');
    expect(resolved).toEqual({ frequency: 'semimonthly', source: 'employee_record' });

    const dueDate = calculateNextPayrollDate(resolved.frequency).toDate();

    // The semimonthly branch: next 15th.
    expect(dueDate.getDate()).toBe(15);
    expect(dueDate.getMonth()).toBe(2); // March

    // Guard against the historical bug: the biweekly branch always lands on a
    // Monday. The 15th of March 2026 is a Sunday, so this also proves we did
    // not fall into the wrong branch.
    expect(dueDate.getDay()).not.toBe(1);
  });

  it('does NOT match what the biweekly branch would have returned for the same borrower', async () => {
    jest.setSystemTime(new Date(2026, 2, 10)); // March 10, 2026
    _mockStore.employees['borrower-2'] = {
      exists: true,
      data: { payFrequency: 'semimonthly' },
    };

    const resolved = await resolvePayFrequency('borrower-2');
    const actualDueDate = calculateNextPayrollDate(resolved.frequency).toDate();
    const biweeklyDueDate = calculateNextPayrollDate('biweekly').toDate();

    expect(actualDueDate.getTime()).not.toBe(biweeklyDueDate.getTime());
  });
});
