import { generatePaymentLink } from '../generatePaymentLink';
import { _mockStore } from '../../__mocks__/firebase-admin/firestore';
import fetch from '../../__mocks__/node-fetch';

type Handler = (req: { auth?: unknown; data: unknown }) => Promise<unknown>;

const fn = generatePaymentLink as unknown as Handler;

const employeeAuth = {
  uid: 'employee-uid',
  token: { role: 'employee', email: 'employee@test.com' },
};

const validInput = { loanId: 'loan-xyz' };

const approvedLoan = {
  exists: true,
  data: {
    status: 'approved',
    userId: 'employee-uid',
    employeeId: 'employee-uid',
    employerId: 'employer-001',
    amount: 2000,
    principalAmount: 2000,
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
  _mockStore.auditLogs = [];
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

    it('throws failed-precondition when loan is not approved', async () => {
      _mockStore.loans['loan-xyz'] = {
        exists: true,
        data: { ...approvedLoan.data, status: 'pending' },
      };
      await expect(fn({ auth: employeeAuth, data: validInput })).rejects.toMatchObject({
        code: 'failed-precondition',
      });
    });

    it('throws failed-precondition when loan is disbursed', async () => {
      _mockStore.loans['loan-xyz'] = {
        exists: true,
        data: { ...approvedLoan.data, status: 'disbursed' },
      };
      await expect(fn({ auth: employeeAuth, data: validInput })).rejects.toMatchObject({
        code: 'failed-precondition',
      });
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
        'https://payment-server.internal/payment-links/oxxo',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-internal-secret': 'test-secret',
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('uses borrowerSnapshot.fullName when available', async () => {
      _mockStore.loans['loan-xyz'] = approvedLoan;
      (fetch as jest.Mock).mockResolvedValue(
        mockFetchResponse(true, { paymentUrl: 'https://oxxo.link', orderId: 'ord-001' })
      );
      await fn({ auth: employeeAuth, data: validInput });

      const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body as string);
      expect(body.borrowerName).toBe('Test Employee');
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
});
