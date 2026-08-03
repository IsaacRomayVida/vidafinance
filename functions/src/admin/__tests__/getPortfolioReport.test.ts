// Regression coverage for the loan-status vocabulary defect: write paths and
// read paths for `loans/{loanId}.status` had drifted onto different
// spellings, so this report's disbursed/repaid totals silently undercounted
// (or zeroed) live portfolio data. See functions/src/loans/loanStatus.ts.
jest.mock('firebase-functions/v2/https', () => ({
  onCall: jest.fn((_opts: unknown, handler: unknown) => handler),
  HttpsError: class HttpsError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = 'HttpsError';
    }
  },
}));

const mockLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
jest.mock('firebase-functions', () => ({ logger: mockLogger }));

const mockCheckRateLimit = jest.fn().mockResolvedValue(true);
jest.mock('../../utils/rateLimiter', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

interface FakeDoc {
  data: Record<string, unknown>;
}

let loanDocs: FakeDoc[] = [];

const mockDb = {
  collection: jest.fn((name: string) => {
    if (name !== 'loans') throw new Error(`Unexpected collection: ${name}`);
    return {
      where: jest.fn(() => ({
        get: jest.fn(async () => ({ docs: loanDocs.map((d) => ({ data: () => d.data })) })),
      })),
    };
  }),
};

jest.mock('firebase-admin/firestore', () => ({
  Timestamp: {
    fromMillis: (ms: number) => ({ toMillis: () => ms }),
    fromDate: (d: Date) => ({ toMillis: () => d.getTime() }),
  },
  getFirestore: () => mockDb,
}));

import { getPortfolioReport } from '../getPortfolioReport';

type Handler = (req: { auth?: unknown; data: unknown }) => Promise<Record<string, unknown>>;
const fn = getPortfolioReport as unknown as Handler;

const adminAuth = { uid: 'admin-uid', token: { role: 'admin', email: 'admin@test.com' } };

function seedLoan(overrides: Record<string, unknown> = {}) {
  loanDocs.push({
    data: {
      employerId: 'employer-1',
      principalAmount: 5000,
      totalRepaymentAmount: 6500,
      feeAmount: 1500,
      ...overrides,
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCheckRateLimit.mockResolvedValue(true);
  loanDocs = [];
});

describe('getPortfolioReport — loan status vocabulary', () => {
  // The automatic SoftCrédito disbursement path (onLoanApproved, index.ts)
  // marks a loan 'active' on success; the manual ops-confirmed path
  // (markLoanDisbursed) marks it 'disbursed'. Both are real, live "funds
  // sent" spellings. Before the fix, disbursedStatuses only listed
  // 'disbursed', so every automatically-disbursed loan contributed zero to
  // totalDisbursedMXN.
  it('counts an automatically-disbursed loan (status: active) in totalDisbursedMXN', async () => {
    seedLoan({ status: 'active', principalAmount: 5000 });
    const result = await fn({ auth: adminAuth, data: { period: 'all' } });
    const summary = result.summary as Record<string, unknown>;
    expect(summary.totalDisbursedMXN).toBe(5000);
  });

  it('counts a manually-disbursed loan (status: disbursed) in totalDisbursedMXN', async () => {
    seedLoan({ status: 'disbursed', principalAmount: 7000 });
    const result = await fn({ auth: adminAuth, data: { period: 'all' } });
    const summary = result.summary as Record<string, unknown>;
    expect(summary.totalDisbursedMXN).toBe(7000);
  });

  // processPayroll.ts is the only write path that ever completes a
  // repayment, and it writes status: 'repaid'. This must be counted as both
  // disbursed (the loan's principal did go out) and repaid.
  it('counts a repaid loan in totalDisbursedMXN, totalRepaidMXN, and totalRevenueMXN', async () => {
    seedLoan({
      status: 'repaid',
      principalAmount: 5000,
      totalRepaymentAmount: 6500,
      feeAmount: 1500,
    });
    const result = await fn({ auth: adminAuth, data: { period: 'all' } });
    const summary = result.summary as Record<string, unknown>;
    expect(summary.totalDisbursedMXN).toBe(5000);
    expect(summary.totalRepaidMXN).toBe(6500);
    expect(summary.totalRevenueMXN).toBe(1500);
  });

  // Historical documents may carry a legacy spelling from dead code or a
  // hand-written ops correction ('paid', 'complete', 'completed') that no
  // live write path produces today. Reads must not let those rows vanish.
  it.each(['paid', 'complete', 'completed'])(
    'still counts a legacy repaid spelling (%s) as repaid',
    async (legacyStatus) => {
      seedLoan({ status: legacyStatus, totalRepaymentAmount: 6500, feeAmount: 1500 });
      const result = await fn({ auth: adminAuth, data: { period: 'all' } });
      const summary = result.summary as Record<string, unknown>;
      expect(summary.totalRepaidMXN).toBe(6500);
      expect(summary.totalRevenueMXN).toBe(1500);
    }
  );

  it('does not count a pending loan as disbursed or repaid', async () => {
    seedLoan({ status: 'pending', principalAmount: 5000 });
    const result = await fn({ auth: adminAuth, data: { period: 'all' } });
    const summary = result.summary as Record<string, unknown>;
    expect(summary.totalDisbursedMXN).toBe(0);
    expect(summary.totalRepaidMXN).toBe(0);
  });

  it('sums active, disbursed, overdue and repaid loans together in totalDisbursedMXN', async () => {
    seedLoan({ status: 'active', principalAmount: 1000 });
    seedLoan({ status: 'disbursed', principalAmount: 2000 });
    seedLoan({ status: 'overdue', principalAmount: 3000 });
    seedLoan({ status: 'repaid', principalAmount: 4000 });
    seedLoan({ status: 'pending', principalAmount: 9999 });
    const result = await fn({ auth: adminAuth, data: { period: 'all' } });
    const summary = result.summary as Record<string, unknown>;
    expect(summary.totalDisbursedMXN).toBe(10000);
  });
});
