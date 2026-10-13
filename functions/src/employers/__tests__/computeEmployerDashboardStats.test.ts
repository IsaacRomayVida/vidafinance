import type { Firestore } from 'firebase-admin/firestore';
import {
  computeEmployerDashboardStats,
  fetchEmployerStatsLoans,
  EMPLOYER_STATS_LOAN_FIELDS,
} from '../computeEmployerDashboardStats';

function loan(overrides: Record<string, unknown> = {}) {
  return {
    status: 'active',
    employeeId: 'emp-1',
    total: 1000,
    ...overrides,
  };
}

describe('computeEmployerDashboardStats', () => {
  it('reports totalEmployees from the server-derived count, not a client fallback', () => {
    const result = computeEmployerDashboardStats([], 7);
    expect(result.totalEmployees).toBe(7);
  });

  describe('activeLoans', () => {
    // The bug this whole ticket exists to kill: the client's dead fallback
    // counted 'approved' loans as active even though no money had moved yet.
    it('does not count an approved-but-undisbursed loan as active', () => {
      const result = computeEmployerDashboardStats([loan({ status: 'approved' })], 1);
      expect(result.activeLoans).toBe(0);
    });

    it('counts a disbursed loan as active', () => {
      const result = computeEmployerDashboardStats([loan({ status: 'disbursed' })], 1);
      expect(result.activeLoans).toBe(1);
    });

    it('counts the automatic-path "active" status as active', () => {
      const result = computeEmployerDashboardStats([loan({ status: 'active' })], 1);
      expect(result.activeLoans).toBe(1);
    });

    it('counts an overdue loan as active — the old fallback omitted it entirely', () => {
      const result = computeEmployerDashboardStats([loan({ status: 'overdue' })], 1);
      expect(result.activeLoans).toBe(1);
    });

    it('counts an in_collections loan as active', () => {
      const result = computeEmployerDashboardStats([loan({ status: 'in_collections' })], 1);
      expect(result.activeLoans).toBe(1);
    });

    it('does not count a repaid loan as active', () => {
      const result = computeEmployerDashboardStats([loan({ status: 'repaid' })], 1);
      expect(result.activeLoans).toBe(0);
    });
  });

  describe('overdueCount', () => {
    it('counts only overdue loans', () => {
      const loans = [loan({ status: 'overdue' }), loan({ status: 'active' }), loan({ status: 'overdue' })];
      const result = computeEmployerDashboardStats(loans, 3);
      expect(result.overdueCount).toBe(2);
    });
  });

  describe('totalDisbursed', () => {
    // The other half of the bug this ticket exists to kill: the old fallback
    // summed the bare principal (`amount`), understating every loan by the
    // full fee.
    it('sums `total` (principal + fee), not `amount` (bare principal)', () => {
      const loans = [loan({ status: 'active', amount: 1000, total: 1300 })];
      const result = computeEmployerDashboardStats(loans, 1);
      expect(result.totalDisbursed).toBe(1300);
    });

    it('excludes loans where funds never left the building', () => {
      const loans = [
        loan({ status: 'approved', total: 1300 }),
        loan({ status: 'disbursement_queued', total: 1300 }),
        loan({ status: 'disbursement_failed', total: 1300 }),
        loan({ status: 'pending', total: 1300 }),
        loan({ status: 'under_review', total: 1300 }),
        loan({ status: 'rejected', total: 1300 }),
        loan({ status: 'rejected_ml', total: 1300 }),
      ];
      const result = computeEmployerDashboardStats(loans, loans.length);
      expect(result.totalDisbursed).toBe(0);
    });

    it('includes a disbursed loan even after it is later written off — the money still left the building', () => {
      const loans = [loan({ status: 'written_off', total: 1300 })];
      const result = computeEmployerDashboardStats(loans, 1);
      expect(result.totalDisbursed).toBe(1300);
    });

    it('includes a repaid loan in cumulative disbursed money', () => {
      const loans = [loan({ status: 'repaid', total: 1300 })];
      const result = computeEmployerDashboardStats(loans, 1);
      expect(result.totalDisbursed).toBe(1300);
    });

    it('treats a missing or non-numeric total as 0 rather than emitting NaN', () => {
      const loans = [loan({ status: 'active', total: undefined }), loan({ status: 'disbursed', total: 'bad' })];
      const result = computeEmployerDashboardStats(loans, 2);
      expect(result.totalDisbursed).toBe(0);
      expect(Number.isNaN(result.totalDisbursed)).toBe(false);
    });
  });

  describe('outstandingBalance', () => {
    it('sums remainingBalance for outstanding loans', () => {
      const loans = [loan({ status: 'active', total: 1300, remainingBalance: 800 })];
      const result = computeEmployerDashboardStats(loans, 1);
      expect(result.outstandingBalance).toBe(800);
    });

    it('falls back to total when remainingBalance has not been touched by payroll yet', () => {
      const loans = [loan({ status: 'approved', total: 1300 })];
      const result = computeEmployerDashboardStats(loans, 1);
      expect(result.outstandingBalance).toBe(1300);
    });

    it('excludes a repaid loan from outstanding balance', () => {
      const loans = [loan({ status: 'repaid', total: 1300, remainingBalance: 0 })];
      const result = computeEmployerDashboardStats(loans, 1);
      expect(result.outstandingBalance).toBe(0);
    });

    it('excludes a written_off loan from outstanding balance', () => {
      const loans = [loan({ status: 'written_off', total: 1300 })];
      const result = computeEmployerDashboardStats(loans, 1);
      expect(result.outstandingBalance).toBe(0);
    });
  });

  describe('adoptionRate', () => {
    it('is the percentage of employees with at least one loan', () => {
      const loans = [
        loan({ employeeId: 'e1' }),
        loan({ employeeId: 'e1' }), // same employee, second loan — not double counted
        loan({ employeeId: 'e2' }),
      ];
      const result = computeEmployerDashboardStats(loans, 4);
      expect(result.adoptionRate).toBe('50%');
    });

    it('is 0% with no employees to avoid a division by zero', () => {
      const result = computeEmployerDashboardStats([], 0);
      expect(result.adoptionRate).toBe('0%');
    });
  });

  describe('response shape', () => {
    it('always returns every field, never a partial object', () => {
      const result = computeEmployerDashboardStats([], 0);
      expect(Object.keys(result).sort()).toEqual(
        ['activeLoans', 'adoptionRate', 'outstandingBalance', 'overdueCount', 'totalDisbursed', 'totalEmployees'].sort()
      );
    });
  });
});

describe('fetchEmployerStatsLoans', () => {
  // A query chain that records every call, so the test can assert on the
  // query's SHAPE — the bug was a limit(50), not a wrong value.
  function fakeDb(docs: Record<string, unknown>[]) {
    const calls: Array<[string, unknown[]]> = [];
    const query: Record<string, unknown> = {};
    for (const method of ['where', 'select', 'orderBy', 'limit']) {
      query[method] = (...args: unknown[]) => {
        calls.push([method, args]);
        return query;
      };
    }
    query.get = async () => ({ docs: docs.map((d) => ({ data: () => d })) });
    const db = {
      collection: (name: string) => {
        calls.push(['collection', [name]]);
        return query;
      },
    } as unknown as Firestore;
    return { db, calls };
  }

  it("reads the employer's whole book, not the dashboard's 50-loan display page", async () => {
    // 51 loans, the oldest overdue: under the old limit(50) page it was the
    // one to fall out of every headline number.
    const docs = Array.from({ length: 51 }, (_, i) =>
      loan({ status: i === 50 ? 'overdue' : 'active', employeeId: `emp-${i}`, total: 100 })
    );
    const { db, calls } = fakeDb(docs);

    const loans = await fetchEmployerStatsLoans(db, 'employer-1');
    const stats = computeEmployerDashboardStats(loans, 51);

    expect(calls).toContainEqual(['collection', ['loans']]);
    expect(calls).toContainEqual(['where', ['employerId', '==', 'employer-1']]);
    expect(calls.map(([m]) => m)).not.toContain('limit');
    expect(stats.activeLoans).toBe(51);
    expect(stats.overdueCount).toBe(1);
    expect(stats.totalDisbursed).toBe(5100);
    expect(stats.adoptionRate).toBe('100%');
  });

  it('projects down to exactly the fields the stats read', async () => {
    const { db, calls } = fakeDb([]);
    await fetchEmployerStatsLoans(db, 'employer-1');
    expect(calls).toContainEqual(['select', [...EMPLOYER_STATS_LOAN_FIELDS]]);
  });
});
