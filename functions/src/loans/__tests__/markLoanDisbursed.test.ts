jest.mock('../../utils/rateLimiter', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(true),
}));

import { markLoanDisbursed } from '../markLoanDisbursed';
import { _mockStore, mockDb } from '../../__mocks__/firebase-admin/firestore';
import { mockRedis } from '../../__mocks__/utils/redis';
import { checkRateLimit } from '../../utils/rateLimiter';

type Handler = (req: { auth?: unknown; data: unknown }) => Promise<unknown>;

const fn = markLoanDisbursed as unknown as Handler;

const opsAuth = {
  uid: 'ops-uid',
  token: { role: 'ops', email: 'ops@test.com' },
};

const adminAuth = {
  uid: 'admin-uid',
  token: { role: 'admin', email: 'admin@test.com' },
};

const validInput = {
  loanId: 'loan-abc',
  stpTransactionId: 'STP-001',
  stpClaveRastreo: 'CLAVE-001',
  disbursedAmount: 1000,
  disbursedAt: '2026-03-16T10:00:00.000Z',
};

const approvedLoan = {
  exists: true,
  data: {
    status: 'approved',
    employerId: 'employer-123',
    employeeId: 'emp-456',
    amount: 1000,
    principalAmount: 1000,
    borrowerSnapshot: { payFrequency: 'monthly', fullName: 'Test User' },
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  _mockStore.loans = {};
  _mockStore.employers = {};
  _mockStore.employees = {};
  _mockStore.auditLog = [];
  _mockStore.transactionCalls = [];
  mockRedis.lpush.mockResolvedValue(1);
});

describe('markLoanDisbursed', () => {
  describe('authentication & authorization', () => {
    it('throws unauthenticated when no auth', async () => {
      await expect(fn({ data: validInput })).rejects.toMatchObject({
        code: 'unauthenticated',
      });
    });

    it('throws permission-denied for employee role', async () => {
      await expect(
        fn({
          auth: { uid: 'emp', token: { role: 'employee', email: 'e@test.com' } },
          data: validInput,
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });

    it('throws permission-denied for employer_admin role', async () => {
      await expect(
        fn({
          auth: { uid: 'emp', token: { role: 'employer_admin', email: 'e@test.com' } },
          data: validInput,
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });

    it('allows ops role', async () => {
      _mockStore.loans['loan-abc'] = approvedLoan;
      const result = await fn({ auth: opsAuth, data: validInput });
      expect(result).toMatchObject({ success: true });
    });

    it('allows admin role', async () => {
      _mockStore.loans['loan-abc'] = approvedLoan;
      const result = await fn({ auth: adminAuth, data: validInput });
      expect(result).toMatchObject({ success: true });
    });

    it('allows super_admin role', async () => {
      _mockStore.loans['loan-abc'] = approvedLoan;
      const result = await fn({
        auth: { uid: 'sa', token: { role: 'super_admin', email: 'sa@test.com' } },
        data: validInput,
      });
      expect(result).toMatchObject({ success: true });
    });
  });

  describe('input validation', () => {
    it('throws invalid-argument when loanId is missing', async () => {
      const { loanId: _l, ...rest } = validInput;
      await expect(fn({ auth: opsAuth, data: rest })).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    });

    it('throws invalid-argument when stpTransactionId is missing', async () => {
      const { stpTransactionId: _s, ...rest } = validInput;
      await expect(fn({ auth: opsAuth, data: rest })).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    });

    it('throws invalid-argument when disbursedAmount is negative', async () => {
      await expect(
        fn({ auth: opsAuth, data: { ...validInput, disbursedAmount: -100 } })
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    it('throws invalid-argument when disbursedAt is not datetime', async () => {
      await expect(
        fn({ auth: opsAuth, data: { ...validInput, disbursedAt: 'not-a-date' } })
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });
  });

  describe('business logic', () => {
    it('throws not-found when loan does not exist', async () => {
      _mockStore.loans['loan-abc'] = { exists: false };
      await expect(fn({ auth: opsAuth, data: validInput })).rejects.toMatchObject({
        code: 'not-found',
      });
    });

    it('throws failed-precondition when loan is pending (not approved)', async () => {
      _mockStore.loans['loan-abc'] = {
        exists: true,
        data: { ...approvedLoan.data, status: 'pending' },
      };
      await expect(fn({ auth: opsAuth, data: validInput })).rejects.toMatchObject({
        code: 'failed-precondition',
      });
    });

    it('throws failed-precondition when loan is already disbursed', async () => {
      _mockStore.loans['loan-abc'] = {
        exists: true,
        data: { ...approvedLoan.data, status: 'disbursed' },
      };
      await expect(fn({ auth: opsAuth, data: validInput })).rejects.toMatchObject({
        code: 'failed-precondition',
      });
    });

    it('runs Firestore transaction with update and audit log', async () => {
      _mockStore.loans['loan-abc'] = approvedLoan;
      await fn({ auth: opsAuth, data: validInput });
      expect(mockDb.runTransaction).toHaveBeenCalledTimes(1);
      expect(_mockStore.transactionCalls).toContain('update');
      expect(_mockStore.transactionCalls).toContain('set');
    });

    it('returns success with loanId, status=disbursed, and dueDate', async () => {
      _mockStore.loans['loan-abc'] = approvedLoan;
      const result = await fn({ auth: opsAuth, data: validInput }) as Record<string, unknown>;
      expect(result.success).toBe(true);
      expect(result.loanId).toBe('loan-abc');
      expect(result.status).toBe('disbursed');
      expect(typeof result.dueDate).toBe('string');
      expect(() => new Date(result.dueDate as string)).not.toThrow();
    });

    it('pushes notification to Redis', async () => {
      _mockStore.loans['loan-abc'] = approvedLoan;
      await fn({ auth: opsAuth, data: validInput });
      expect(mockRedis.lpush).toHaveBeenCalledWith(
        'jobs:notifications',
        expect.stringContaining('loan_disbursed')
      );
    });

    it('continues without throwing if Redis push fails', async () => {
      _mockStore.loans['loan-abc'] = approvedLoan;
      mockRedis.lpush.mockRejectedValue(new Error('Redis down'));
      const result = await fn({ auth: opsAuth, data: validInput }) as Record<string, unknown>;
      expect(result.success).toBe(true);
    });

    it('handles loan with userId instead of employeeId', async () => {
      _mockStore.loans['loan-abc'] = {
        exists: true,
        data: { ...approvedLoan.data, userId: 'user-789', employeeId: undefined },
      };
      const result = await fn({ auth: opsAuth, data: validInput }) as Record<string, unknown>;
      expect(result.success).toBe(true);
    });

    it('falls back to amount when principalAmount is not set', async () => {
      _mockStore.loans['loan-abc'] = {
        exists: true,
        data: { ...approvedLoan.data, principalAmount: undefined, amount: 1500 },
      };
      await expect(fn({ auth: opsAuth, data: validInput })).resolves.toMatchObject({
        success: true,
      });
    });

    // The block below pins #431: the due date has to come from the borrower's
    // real payroll cadence. Nothing writes borrowerSnapshot onto a loan, so the
    // first case is the one every production disbursement hits — it used to
    // silently schedule month-end for everybody.
    //
    // The clock is pinned deliberately. Written against the real clock these
    // tests passed under the OLD behaviour too, because the month-end they were
    // supposed to reject (31 Aug 2026) happens to fall on a Monday, which is
    // exactly what the weekly assertion looks for. 15 Sep 2026 is a Tuesday and
    // its month-end (30 Sep) is a Wednesday, so weekly and monthly cannot
    // coincide and the assertions distinguish them.
    describe('payroll cadence (#431)', () => {
      const PINNED_NOW = new Date('2026-09-15T10:00:00.000Z');

      beforeEach(() => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        jest.setSystemTime(PINNED_NOW);
      });

      afterEach(() => {
        jest.useRealTimers();
      });

      const dueDateOf = async () => {
        const result = (await fn({ auth: opsAuth, data: validInput })) as Record<string, unknown>;
        return new Date(result.dueDate as string);
      };

      const isMonthEnd = (d: Date) => {
        const dayAfter = new Date(d);
        dayAfter.setDate(d.getDate() + 1);
        return dayAfter.getDate() === 1;
      };

      it('reads the borrower record for the cadence when the loan carries no snapshot', async () => {
        _mockStore.loans['loan-abc'] = {
          exists: true,
          data: { ...approvedLoan.data, borrowerSnapshot: undefined },
        };
        _mockStore.employees['emp-456'] = { exists: true, data: { payFrequency: 'weekly' } };

        const due = await dueDateOf();

        expect(due.getDay()).toBe(1); // next Monday
        expect(isMonthEnd(due)).toBe(false); // NOT the old month-end default
      });

      it('assumes month-end only when the borrower record has no cadence either', async () => {
        _mockStore.loans['loan-abc'] = {
          exists: true,
          data: { ...approvedLoan.data, borrowerSnapshot: undefined },
        };

        const due = await dueDateOf();

        expect(isMonthEnd(due)).toBe(true);
      });

      it('still honours a loan snapshot cadence over the borrower record', async () => {
        _mockStore.loans['loan-abc'] = approvedLoan; // snapshot says monthly
        _mockStore.employees['emp-456'] = { exists: true, data: { payFrequency: 'weekly' } };

        const due = await dueDateOf();

        expect(isMonthEnd(due)).toBe(true);
        expect(due.getDay()).not.toBe(1);
      });
    });
  });

  describe('rate limiting', () => {
    it('throws resource-exhausted when rate limit is exceeded', async () => {
      _mockStore.loans['loan-abc'] = approvedLoan;
      (checkRateLimit as jest.Mock).mockResolvedValueOnce(false);

      await expect(fn({ auth: opsAuth, data: validInput })).rejects.toMatchObject({
        code: 'resource-exhausted',
      });
    });
  });
});
