jest.mock('../../utils/rateLimiter', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(true),
}));

import { generatePaymentLink } from '../generatePaymentLink';
import { _mockStore } from '../../__mocks__/firebase-admin/firestore';
import { checkRateLimit } from '../../utils/rateLimiter';
import fetch from '../../__mocks__/node-fetch';

type Handler = (req: { auth?: unknown; data: unknown }) => Promise<unknown>;

const fn = generatePaymentLink as unknown as Handler;

const employeeAuth = {
  uid: 'employee-uid',
  token: { role: 'employee', email: 'employee@test.com' },
};

const validInput = { loanId: 'loan-xyz' };

// A repayable loan: funds have been sent ('active'), no payroll deduction has
// landed yet, so there is no `remainingBalance` field on the document.
const approvedLoan = {
  exists: true,
  data: {
    status: 'active',
    userId: 'employee-uid',
    employeeId: 'employee-uid',
    employerId: 'employer-001',
    // Real loan documents (index.ts:~761-769) never write `principalAmount` —
    // only `amount`, `fee`, and `total` (= amount + fee).
    amount: 2000,
    fee: 600,
    total: 2600,
    employeeName: 'Test Employee',
    borrowerSnapshot: { fullName: 'Test Employee', payFrequency: 'monthly' },
  },
};

const mockFetchResponse = (ok: boolean, body: unknown) => ({
  ok,
  json: jest.fn().mockResolvedValue(body),
});

beforeEach(() => {
  jest.clearAllMocks();
  _mockStore.loans = {};
  _mockStore.auditLog = [];
  process.env['PAYMENT_SERVER_URL'] = 'https://payment-server.internal';
  process.env['INTERNAL_SECRET'] = 'test-secret';
});

describe('generatePaymentLink', () => {
  describe('authentication & authorization', () => {
    it('throws unauthenticated when no auth', async () => {
      await expect(fn({ data: validInput })).rejects.toMatchObject({
        code: 'unauthenticated',
      });
    });

    it('throws permission-denied for ops role', async () => {
      await expect(
        fn({
          auth: { uid: 'ops', token: { role: 'ops', email: 'ops@test.com' } },
          data: validInput,
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });

    it('throws permission-denied for admin role', async () => {
      await expect(
        fn({
          auth: { uid: 'admin', token: { role: 'admin', email: 'admin@test.com' } },
          data: validInput,
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });

    it('allows employee role', async () => {
      _mockStore.loans['loan-xyz'] = approvedLoan;
      (fetch as jest.Mock).mockResolvedValue(
        mockFetchResponse(true, { paymentUrl: 'https://oxxo.link', orderId: 'ord-001' })
      );
      const result = await fn({ auth: employeeAuth, data: validInput });
      expect(result).toMatchObject({ paymentUrl: 'https://oxxo.link' });
    });
  });

  describe('input validation', () => {
    it('throws invalid-argument when loanId is missing', async () => {
      await expect(fn({ auth: employeeAuth, data: {} })).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    });

    it('throws invalid-argument when loanId is empty string', async () => {
      await expect(
        fn({ auth: employeeAuth, data: { loanId: '' } })
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });
  });

  describe('business logic', () => {
    it('throws not-found when loan does not exist', async () => {
      _mockStore.loans['loan-xyz'] = { exists: false };
      await expect(fn({ auth: employeeAuth, data: validInput })).rejects.toMatchObject({
        code: 'not-found',
      });
    });

    it('throws permission-denied when loan belongs to different user', async () => {
      _mockStore.loans['loan-xyz'] = {
        exists: true,
        data: { ...approvedLoan.data, userId: 'other-user', employeeId: 'other-user' },
      };
      await expect(fn({ auth: employeeAuth, data: validInput })).rejects.toMatchObject({
        code: 'permission-denied',
      });
    });

    it('throws failed-precondition when loan is pending', async () => {
      _mockStore.loans['loan-xyz'] = {
        exists: true,
        data: { ...approvedLoan.data, status: 'pending' },
      };
      await expect(fn({ auth: employeeAuth, data: validInput })).rejects.toMatchObject({
        code: 'failed-precondition',
      });
    });

    it('throws failed-precondition when loan is approved (pre-disbursement — nothing to repay yet)', async () => {
      _mockStore.loans['loan-xyz'] = {
        exists: true,
        data: { ...approvedLoan.data, status: 'approved' },
      };
      await expect(fn({ auth: employeeAuth, data: validInput })).rejects.toMatchObject({
        code: 'failed-precondition',
      });
    });

    it('throws failed-precondition when loan is already repaid', async () => {
      _mockStore.loans['loan-xyz'] = {
        exists: true,
        data: { ...approvedLoan.data, status: 'repaid' },
      };
      await expect(fn({ auth: employeeAuth, data: validInput })).rejects.toMatchObject({
        code: 'failed-precondition',
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('throws failed-precondition when loan is written off', async () => {
      _mockStore.loans['loan-xyz'] = {
        exists: true,
        data: { ...approvedLoan.data, status: 'written_off' },
      };
      await expect(fn({ auth: employeeAuth, data: validInput })).rejects.toMatchObject({
        code: 'failed-precondition',
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('succeeds when loan is disbursed (manual ops disbursement path)', async () => {
      _mockStore.loans['loan-xyz'] = {
        exists: true,
        data: { ...approvedLoan.data, status: 'disbursed' },
      };
      (fetch as jest.Mock).mockResolvedValue(
        mockFetchResponse(true, { paymentUrl: 'https://oxxo.link', orderId: 'ord-001' })
      );
      const result = await fn({ auth: employeeAuth, data: validInput }) as Record<string, unknown>;
      expect(result.paymentUrl).toBe('https://oxxo.link');
    });

    it('succeeds when loan is overdue', async () => {
      _mockStore.loans['loan-xyz'] = {
        exists: true,
        data: { ...approvedLoan.data, status: 'overdue' },
      };
      (fetch as jest.Mock).mockResolvedValue(
        mockFetchResponse(true, { paymentUrl: 'https://oxxo.link', orderId: 'ord-001' })
      );
      const result = await fn({ auth: employeeAuth, data: validInput }) as Record<string, unknown>;
      expect(result.paymentUrl).toBe('https://oxxo.link');
    });

    it('throws internal when PAYMENT_SERVER_URL is not configured', async () => {
      _mockStore.loans['loan-xyz'] = approvedLoan;
      delete process.env['PAYMENT_SERVER_URL'];
      await expect(fn({ auth: employeeAuth, data: validInput })).rejects.toMatchObject({
        code: 'internal',
      });
    });

    it('throws internal when payment server returns error', async () => {
      _mockStore.loans['loan-xyz'] = approvedLoan;
      (fetch as jest.Mock).mockResolvedValue(
        mockFetchResponse(false, { message: 'OXXO service unavailable' })
      );
      await expect(fn({ auth: employeeAuth, data: validInput })).rejects.toMatchObject({
        code: 'internal',
      });
    });

    it('throws internal when payment server returns invalid response', async () => {
      _mockStore.loans['loan-xyz'] = approvedLoan;
      (fetch as jest.Mock).mockResolvedValue(
        mockFetchResponse(true, { paymentUrl: null, orderId: null })
      );
      await expect(fn({ auth: employeeAuth, data: validInput })).rejects.toMatchObject({
        code: 'internal',
      });
    });

    it('returns paymentUrl, orderId, expiresIn on success', async () => {
      _mockStore.loans['loan-xyz'] = approvedLoan;
      (fetch as jest.Mock).mockResolvedValue(
        mockFetchResponse(true, { paymentUrl: 'https://oxxo.link/pay', orderId: 'ord-123' })
      );
      const result = (await fn({ auth: employeeAuth, data: validInput })) as Record<string, unknown>;
      expect(result.paymentUrl).toBe('https://oxxo.link/pay');
      expect(result.orderId).toBe('ord-123');
      expect(result.expiresIn).toBe('24 hours');
    });

    it('calls payment server with correct payload', async () => {
      _mockStore.loans['loan-xyz'] = approvedLoan;
      (fetch as jest.Mock).mockResolvedValue(
        mockFetchResponse(true, { paymentUrl: 'https://oxxo.link', orderId: 'ord-001' })
      );
      await fn({ auth: employeeAuth, data: validInput });

      expect(fetch).toHaveBeenCalledWith(
        'https://payment-server.internal/create-checkout',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-internal-secret': 'test-secret',
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('charges loan.total (principal + fee), not the bare principal, when no payroll deduction has landed', async () => {
      _mockStore.loans['loan-xyz'] = approvedLoan;
      (fetch as jest.Mock).mockResolvedValue(
        mockFetchResponse(true, { paymentUrl: 'https://oxxo.link', orderId: 'ord-001' })
      );
      await fn({ auth: employeeAuth, data: validInput });

      const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body as string);
      expect(body.amount).toBe(2600);
    });

    it('charges loan.remainingBalance, not loan.total, once a partial payroll deduction has landed', async () => {
      _mockStore.loans['loan-xyz'] = {
        exists: true,
        data: { ...approvedLoan.data, remainingBalance: 1800 },
      };
      (fetch as jest.Mock).mockResolvedValue(
        mockFetchResponse(true, { paymentUrl: 'https://oxxo.link', orderId: 'ord-001' })
      );
      await fn({ auth: employeeAuth, data: validInput });

      const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body as string);
      expect(body.amount).toBe(1800);
    });

    it('throws internal when remainingBalance is present but zero, without falling back to total', async () => {
      _mockStore.loans['loan-xyz'] = {
        exists: true,
        data: { ...approvedLoan.data, remainingBalance: 0 },
      };
      await expect(fn({ auth: employeeAuth, data: validInput })).rejects.toMatchObject({
        code: 'internal',
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('throws internal when remainingBalance is present but negative, without falling back to total', async () => {
      _mockStore.loans['loan-xyz'] = {
        exists: true,
        data: { ...approvedLoan.data, remainingBalance: -100 },
      };
      await expect(fn({ auth: employeeAuth, data: validInput })).rejects.toMatchObject({
        code: 'internal',
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('throws internal when remainingBalance is present but NaN, without falling back to total', async () => {
      _mockStore.loans['loan-xyz'] = {
        exists: true,
        data: { ...approvedLoan.data, remainingBalance: NaN },
      };
      await expect(fn({ auth: employeeAuth, data: validInput })).rejects.toMatchObject({
        code: 'internal',
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('throws internal when loan.total is missing', async () => {
      _mockStore.loans['loan-xyz'] = {
        exists: true,
        data: { ...approvedLoan.data, total: undefined },
      };
      await expect(fn({ auth: employeeAuth, data: validInput })).rejects.toMatchObject({
        code: 'internal',
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('throws internal when loan.total is NaN', async () => {
      _mockStore.loans['loan-xyz'] = {
        exists: true,
        data: { ...approvedLoan.data, total: NaN },
      };
      await expect(fn({ auth: employeeAuth, data: validInput })).rejects.toMatchObject({
        code: 'internal',
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('throws internal when loan.total is zero', async () => {
      _mockStore.loans['loan-xyz'] = {
        exists: true,
        data: { ...approvedLoan.data, total: 0 },
      };
      await expect(fn({ auth: employeeAuth, data: validInput })).rejects.toMatchObject({
        code: 'internal',
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('throws internal when loan.total is negative', async () => {
      _mockStore.loans['loan-xyz'] = {
        exists: true,
        data: { ...approvedLoan.data, total: -100 },
      };
      await expect(fn({ auth: employeeAuth, data: validInput })).rejects.toMatchObject({
        code: 'internal',
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('uses borrowerSnapshot.fullName when available', async () => {
      _mockStore.loans['loan-xyz'] = approvedLoan;
      (fetch as jest.Mock).mockResolvedValue(
        mockFetchResponse(true, { paymentUrl: 'https://oxxo.link', orderId: 'ord-001' })
      );
      await fn({ auth: employeeAuth, data: validInput });

      const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body as string);
      expect(body.employeeName).toBe('Test Employee');
    });

    it('falls back to employeeId when userId is not set', async () => {
      _mockStore.loans['loan-xyz'] = {
        exists: true,
        data: { ...approvedLoan.data, userId: undefined, employeeId: 'employee-uid' },
      };
      (fetch as jest.Mock).mockResolvedValue(
        mockFetchResponse(true, { paymentUrl: 'https://oxxo.link', orderId: 'ord-001' })
      );
      const result = await fn({ auth: employeeAuth, data: validInput }) as Record<string, unknown>;
      expect(result.paymentUrl).toBe('https://oxxo.link');
    });

    it('uses INTERNAL_API_SECRET as fallback for secret header', async () => {
      _mockStore.loans['loan-xyz'] = approvedLoan;
      delete process.env['INTERNAL_SECRET'];
      process.env['INTERNAL_API_SECRET'] = 'api-secret-alt';
      (fetch as jest.Mock).mockResolvedValue(
        mockFetchResponse(true, { paymentUrl: 'https://oxxo.link', orderId: 'ord-001' })
      );
      await fn({ auth: employeeAuth, data: validInput });

      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-internal-secret': 'api-secret-alt' }),
        })
      );
      delete process.env['INTERNAL_API_SECRET'];
    });
  });

  describe('rate limiting', () => {
    it('throws resource-exhausted when rate limit is exceeded', async () => {
      _mockStore.loans['loan-xyz'] = approvedLoan;
      (checkRateLimit as jest.Mock).mockResolvedValueOnce(false);

      await expect(fn({ auth: employeeAuth, data: validInput })).rejects.toMatchObject({
        code: 'resource-exhausted',
      });
    });
  });
});
