/**
 * Unit tests for the payroll reconciliation matching logic.
 */

process.env.REDIS_URL = 'redis://localhost:6379';
process.env.INTERNAL_API_SECRET = 'test-secret';

import crypto from 'crypto';
import { __resetMockStore, __setMockData } from './__mocks__/firebase';
import { __resetPushed, __getPushed } from './__mocks__/redis';

// ── Reconciliation logic (mirror of /internal/reconcile handler) ─────────────

function hashCurp(curp: string): string {
  return crypto.createHash('sha256').update(curp.toUpperCase().trim()).digest('hex');
}

interface Deduction {
  employeeId: string;
  curp: string;
  amount: number;
}

interface LoanDoc {
  id: string;
  employerId: string;
  userId: string;
  status: string;
  borrowerSnapshot: { curpHash: string; fullName: string };
}

interface ReconcileResult {
  curp: string;
  status: 'repaid' | 'no_active_loan';
  loanId?: string;
}

/**
 * Pure reconciliation matching logic for unit testing.
 * Returns what the endpoint would return without HTTP layer.
 */
async function reconcileDeductions(
  employerId: string,
  _payrollDate: string,
  deductions: Deduction[],
  getActiveLoans: (employerId: string, curpHash: string) => Promise<LoanDoc[]>,
  updateLoan: (loanId: string, amount: number) => Promise<void>,
  pushNotification: (payload: unknown) => Promise<void>,
): Promise<ReconcileResult[]> {
  return Promise.all(
    deductions.map(async (d) => {
      const curpHash = hashCurp(d.curp);
      const loans = await getActiveLoans(employerId, curpHash);

      if (!loans.length) {
        return { curp: d.curp, status: 'no_active_loan' as const };
      }

      const loan = loans[0];
      await updateLoan(loan.id, d.amount);
      await pushNotification({
        type: 'loan_repaid',
        userId: loan.userId,
        loanId: loan.id,
        amount: d.amount,
      });

      return { curp: d.curp, loanId: loan.id, status: 'repaid' as const };
    }),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('reconcileDeductions', () => {
  const mockUpdateLoan = jest.fn().mockResolvedValue(undefined);
  const mockPushNotification = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    __resetMockStore();
    __resetPushed();
    jest.clearAllMocks();
  });

  it('should mark active loans as repaid for matched CURP', async () => {
    const curp = 'PEGA900101HDFRZN01';
    const curpHash = hashCurp(curp);

    const mockGetLoans = jest.fn().mockResolvedValue([
      {
        id: 'loan001',
        employerId: 'emp001',
        userId: 'user001',
        status: 'disbursed',
        borrowerSnapshot: { curpHash, fullName: 'Pedro García' },
      },
    ]);

    const results = await reconcileDeductions(
      'emp001',
      '2026-03-15',
      [{ employeeId: 'e001', curp, amount: 1500 }],
      mockGetLoans,
      mockUpdateLoan,
      mockPushNotification,
    );

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('repaid');
    expect(results[0].loanId).toBe('loan001');
    expect(results[0].curp).toBe(curp);
    expect(mockUpdateLoan).toHaveBeenCalledWith('loan001', 1500);
    expect(mockPushNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'loan_repaid', loanId: 'loan001', userId: 'user001' }),
    );
  });

  it('should return no_active_loan for unmatched CURP', async () => {
    const mockGetLoans = jest.fn().mockResolvedValue([]);

    const results = await reconcileDeductions(
      'emp001',
      '2026-03-15',
      [{ employeeId: 'e002', curp: 'UNKN900101HDFRZN00', amount: 500 }],
      mockGetLoans,
      mockUpdateLoan,
      mockPushNotification,
    );

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('no_active_loan');
    expect(mockUpdateLoan).not.toHaveBeenCalled();
    expect(mockPushNotification).not.toHaveBeenCalled();
  });

  it('should process multiple deductions in parallel', async () => {
    const curp1 = 'PEGA900101HDFRZN01';
    const curp2 = 'MAMG851201MDFRNR09';
    const curp3 = 'NOMA123456HDFABC01';

    const mockGetLoans = jest
      .fn()
      .mockResolvedValueOnce([
        { id: 'loanA', employerId: 'emp002', userId: 'uA', status: 'disbursed', borrowerSnapshot: { curpHash: hashCurp(curp1), fullName: 'A' } },
      ])
      .mockResolvedValueOnce([]) // curp2 has no active loan
      .mockResolvedValueOnce([
        { id: 'loanC', employerId: 'emp002', userId: 'uC', status: 'overdue', borrowerSnapshot: { curpHash: hashCurp(curp3), fullName: 'C' } },
      ]);

    const deductions: Deduction[] = [
      { employeeId: 'e1', curp: curp1, amount: 2000 },
      { employeeId: 'e2', curp: curp2, amount: 1000 },
      { employeeId: 'e3', curp: curp3, amount: 1500 },
    ];

    const results = await reconcileDeductions(
      'emp002',
      '2026-03-15',
      deductions,
      mockGetLoans,
      mockUpdateLoan,
      mockPushNotification,
    );

    expect(results).toHaveLength(3);
    const repaid = results.filter((r) => r.status === 'repaid');
    const noLoan = results.filter((r) => r.status === 'no_active_loan');
    expect(repaid).toHaveLength(2);
    expect(noLoan).toHaveLength(1);
    expect(mockUpdateLoan).toHaveBeenCalledTimes(2);
    expect(mockPushNotification).toHaveBeenCalledTimes(2);
  });

  it('should use consistent CURP hashing regardless of case', () => {
    const lower = hashCurp('pega900101hdfrzn01');
    const upper = hashCurp('PEGA900101HDFRZN01');
    const mixed = hashCurp('Pega900101Hdfrzn01');
    expect(lower).toBe(upper);
    expect(upper).toBe(mixed);
  });

  it('should include all deductions in result even if some fail lookup', async () => {
    const deductions: Deduction[] = [
      { employeeId: 'e1', curp: 'AAA000000AAAAAAA0', amount: 100 },
      { employeeId: 'e2', curp: 'BBB000000BBBBBBB0', amount: 200 },
    ];

    const mockGetLoans = jest.fn().mockResolvedValue([]);

    const results = await reconcileDeductions(
      'emp003',
      '2026-03-15',
      deductions,
      mockGetLoans,
      mockUpdateLoan,
      mockPushNotification,
    );

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'no_active_loan')).toBe(true);
  });
});
