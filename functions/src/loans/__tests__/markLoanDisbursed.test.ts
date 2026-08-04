jest.mock('../../utils/rateLimiter', () => {
  const mod = { checkRateLimit: jest.fn().mockResolvedValue(true) };
  return {
    ...mod,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    enforceRateLimit: require('../../__mocks__/utils/rateLimiter').makeEnforceRateLimit(
      (...a: unknown[]) => (mod as { checkRateLimit: (...a: unknown[]) => Promise<boolean> }).checkRateLimit(...a)
    ),
  };
});

import { markLoanDisbursed } from '../markLoanDisbursed';
import { _mockStore, mockDb, Timestamp } from '../../__mocks__/firebase-admin/firestore';
import { mockRedis } from '../../__mocks__/utils/redis';
import { checkRateLimit } from '../../utils/rateLimiter';
import fetch from 'node-fetch';

const mockFetch = fetch as unknown as jest.Mock;

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

// A loan created AFTER #437: requestLoan resolved the due date once, against
// the borrower's payroll cadence, and froze that cadence onto the loan. The
// date is already payroll-aligned, so disbursement has nothing to correct.
const resolvedDueDate = Timestamp.fromDate(new Date('2026-04-30T00:00:00.000Z'));
const approvedLoanResolvedAtRequest = {
  exists: true,
  data: {
    ...approvedLoan.data, // carries borrowerSnapshot: { payFrequency: 'monthly' }
    total: 1300,
    term: 30,
    dueDate: resolvedDueDate,
    payFrequencySource: 'employee_record',
    repaymentSchedule: [{ number: 1, amount: 1300, dueDate: resolvedDueDate }],
  },
};

// A loan created BEFORE #437: a flat request+30d due date and no persisted
// cadence. These are in flight — approved, disclosed, deduction registered —
// and keep the old realigning behaviour rather than having their collection
// date changed under them by a deploy.
const requestedDueDate = Timestamp.fromDate(new Date('2026-03-01T00:00:00.000Z'));
const legacyApprovedLoanWithSchedule = {
  exists: true,
  data: {
    ...approvedLoan.data,
    borrowerSnapshot: undefined,
    total: 1300,
    term: 30,
    dueDate: requestedDueDate,
    repaymentSchedule: [{ number: 1, amount: 1300, dueDate: requestedDueDate }],
  },
};

async function lastLoanTransactionUpdate(): Promise<Record<string, unknown>> {
  const results = mockDb.runTransaction.mock.results;
  const txn = await results[results.length - 1]!.value;
  return txn.update.mock.calls[0][1] as Record<string, unknown>;
}

beforeEach(() => {
  jest.clearAllMocks();
  _mockStore.loans = {};
  _mockStore.employers = {};
  _mockStore.employees = {};
  _mockStore.auditLog = [];
  _mockStore.transactionCalls = [];
  _mockStore.docUpdates = [];
  mockRedis.lpush.mockResolvedValue(1);
  delete process.env['SOFTCREDITO_ADAPTER_URL'];
  delete process.env['INTERNAL_SECRET'];
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

  // #437: the due date used to be decided twice — request+30d at creation, the
  // borrower's next payroll date again here — from two different rules. The
  // second could land EARLIER than the first, understating the CAT the borrower
  // had already signed against. It is now resolved once, at creation, and this
  // function must not touch it.
  describe('due date / schedule / deduction consistency (#437)', () => {
    it('returns the due date the loan already carries, byte-identical', async () => {
      _mockStore.loans['loan-abc'] = approvedLoanResolvedAtRequest;

      const result = (await fn({ auth: opsAuth, data: validInput })) as Record<string, unknown>;

      expect(result['dueDate']).toBe(resolvedDueDate.toDate().toISOString());
    });

    it('does not write dueDate or repaymentSchedule at all', async () => {
      _mockStore.loans['loan-abc'] = approvedLoanResolvedAtRequest;

      await fn({ auth: opsAuth, data: validInput });
      const update = await lastLoanTransactionUpdate();

      // Not "writes the same value back" — writes nothing. A re-derivation that
      // happens to agree today is still a second rule that can drift tomorrow.
      expect(update).not.toHaveProperty('dueDate');
      expect(update).not.toHaveProperty('repaymentSchedule');
      expect(update['status']).toBe('disbursed');
    });

    it('records no due-date realignment in the audit log, because none happened', async () => {
      _mockStore.loans['loan-abc'] = approvedLoanResolvedAtRequest;

      await fn({ auth: opsAuth, data: validInput });

      const entry = _mockStore.auditLog.find((e) => e['action'] === 'loan.disbursed') as
        | { targetId: string; meta: Record<string, unknown> }
        | undefined;
      expect(entry).toBeDefined();
      expect(entry!.targetId).toBe('loan-abc');
      // A from === to entry would read as a move that did not occur.
      expect(entry!.meta).not.toHaveProperty('dueDateRealigned');
      expect(entry!.meta['stpTransactionId']).toBe('STP-001');
    });

    it('notifies the borrower of the date they were quoted, not a new one', async () => {
      _mockStore.loans['loan-abc'] = approvedLoanResolvedAtRequest;

      await fn({ auth: opsAuth, data: validInput });

      expect(mockRedis.lpush).toHaveBeenCalledWith(
        'jobs:notifications',
        expect.stringContaining(`"dueDate":"${resolvedDueDate.toDate().toISOString()}"`)
      );
    });

    it('never logs CURP, RFC or CLABE in the audit entry', async () => {
      _mockStore.loans['loan-abc'] = {
        exists: true,
        data: {
          ...approvedLoanResolvedAtRequest.data,
          curp: 'AAAA000101HDFRRR01',
          rfc: 'AAAA000101AAA',
          clabe: '012180001234567895',
        },
      };

      await fn({ auth: opsAuth, data: validInput });

      const serialized = JSON.stringify(_mockStore.auditLog);
      expect(serialized).not.toContain('AAAA000101HDFRRR01');
      expect(serialized).not.toContain('AAAA000101AAA');
      expect(serialized).not.toContain('012180001234567895');
    });

    // Loans approved before #437 landed have no persisted cadence. Their
    // collection date must not change because of a deploy, so they finish on
    // the path they started on — realignment and all, schedule rebuilt with it
    // (361b09c) so the document does not disagree with itself.
    describe('loans created before the due date was resolved at request time', () => {
      it('moves repaymentSchedule[0].dueDate to the same date as the new loan.dueDate', async () => {
        _mockStore.loans['loan-abc'] = legacyApprovedLoanWithSchedule;

        const result = (await fn({ auth: opsAuth, data: validInput })) as Record<string, unknown>;
        const update = await lastLoanTransactionUpdate();

        const schedule = update['repaymentSchedule'] as Array<{ dueDate: { toMillis(): number } }>;
        expect(schedule).toHaveLength(1);
        expect(schedule[0]!.dueDate.toMillis()).toBe(new Date(result['dueDate'] as string).getTime());
        // And it must actually have moved off the request-time date, not just be present.
        expect(schedule[0]!.dueDate.toMillis()).not.toBe(requestedDueDate.toMillis());
      });

      it('sums the rebuilt schedule to the loan total, same as requestLoan would quote', async () => {
        _mockStore.loans['loan-abc'] = legacyApprovedLoanWithSchedule;

        await fn({ auth: opsAuth, data: validInput });
        const update = await lastLoanTransactionUpdate();

        const schedule = update['repaymentSchedule'] as Array<{ amount: number }>;
        const sum = schedule.reduce((s, i) => s + i.amount, 0);
        expect(sum).toBe(legacyApprovedLoanWithSchedule.data.total);
      });

      it('records the due-date move (loan id, old date, new date, payFrequency) in the audit log', async () => {
        _mockStore.loans['loan-abc'] = legacyApprovedLoanWithSchedule;

        const result = (await fn({ auth: opsAuth, data: validInput })) as Record<string, unknown>;

        const entry = _mockStore.auditLog.find((e) => e['action'] === 'loan.disbursed') as
          | { targetId: string; meta: Record<string, unknown> }
          | undefined;
        expect(entry).toBeDefined();
        expect(entry!.targetId).toBe('loan-abc');
        const realign = entry!.meta['dueDateRealigned'] as { from: string; to: string; payFrequency: string };
        expect(realign.from).toBe(requestedDueDate.toDate().toISOString());
        expect(realign.to).toBe(result['dueDate']);
        expect(realign.payFrequency).toBe('monthly');
      });
    });

    // Guard, not an omission. `onLoanApproved` already registered a deduction,
    // and the adapter only offers POST /deductions/register — a create, with no
    // cancel or replace. A second call would leave two live deductions at
    // SoftCrédito and overwrite the id of the first, so the borrower would be
    // collected twice. This test fails the moment someone "finishes" #437 by
    // adding that call back without a vendor-side replace path.
    it('never re-registers the deduction, even with the adapter configured (would double-collect)', async () => {
      process.env['SOFTCREDITO_ADAPTER_URL'] = 'http://softcredito-adapter.railway.internal:3002';
      process.env['INTERNAL_SECRET'] = 'secret';
      _mockStore.loans['loan-abc'] = approvedLoanResolvedAtRequest;

      const result = (await fn({ auth: opsAuth, data: validInput })) as Record<string, unknown>;

      expect(result['success']).toBe(true);
      const registerCalls = mockFetch.mock.calls.filter(([url]) =>
        String(url).endsWith('/internal/register-deduction')
      );
      expect(registerCalls).toHaveLength(0);
    });
  });
});
