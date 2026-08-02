// Regression test for the ACTUAL deployed `requestLoan` callable (inline in
// index.ts — NOT the unused src/loans/requestLoan.ts variant). It exercises
// the real payload shape LoanWizard.tsx sends: { amount, employerCode,
// bankAccountClabe, termsAccepted, termDays, loanPurpose? }. Before the P0
// fix, the handler destructured `term` (which the client never sends) and
// rejected every request with "Plazo inválido".
jest.mock('firebase-admin/app', () => ({ initializeApp: jest.fn() }));

jest.mock('firebase-functions/v2/https', () => ({
  onCall: jest.fn((_opts: unknown, handler: unknown) => handler),
  onRequest: jest.fn((...args: unknown[]) => (args.length === 1 ? args[0] : args[1])),
  HttpsError: class HttpsError extends Error {
    code: string;
    details: unknown;
    constructor(code: string, message: string, details?: unknown) {
      super(message);
      this.code = code;
      this.details = details;
      this.name = 'HttpsError';
    }
  },
}));

jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentCreated: jest.fn(() => jest.fn()),
  onDocumentUpdated: jest.fn(() => jest.fn()),
}));

jest.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: jest.fn(() => jest.fn()),
}));

const mockLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
jest.mock('firebase-functions', () => ({ logger: mockLogger }));
jest.mock('firebase-functions/v2', () => ({ logger: mockLogger }));

class MockTimestamp {
  constructor(public seconds: number, public nanoseconds = 0) {}
  static now() {
    return new MockTimestamp(Math.floor(Date.now() / 1000));
  }
  static fromDate(date: Date) {
    return new MockTimestamp(Math.floor(date.getTime() / 1000));
  }
  toDate() {
    return new Date(this.seconds * 1000);
  }
}

const mockFieldValue = {
  increment: jest.fn((n: number) => ({ _increment: n })),
  serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })),
};

let mockDb: ReturnType<typeof buildMockDb>;
jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockDb),
  FieldValue: mockFieldValue,
  Timestamp: MockTimestamp,
}));

jest.mock('node-fetch', () => ({
  __esModule: true,
  default: jest.fn(),
}));

const mockCheckRateLimit = jest.fn().mockResolvedValue(true);
jest.mock('../utils/rateLimiter', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

jest.mock('../utils/notify', () => ({ notifyLoanEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/slackAlert', () => ({ sendSlackAlert: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/sentry', () => ({ initSentry: jest.fn(), captureException: jest.fn() }));

function makeQuery(getResult: { empty: boolean; docs: Array<{ data: () => Record<string, unknown>; id: string }> }) {
  const query: { where: jest.Mock; limit: jest.Mock; get: jest.Mock } = {
    where: jest.fn(),
    limit: jest.fn(),
    get: jest.fn().mockResolvedValue(getResult),
  };
  query.where.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  return query;
}

const mockEmployee = {
  name: 'Juan García',
  email: 'juan@example.com',
  employerId: 'employer-abc',
  employerName: 'Test Co',
  availableCredit: 5000,
  monthlySalary: 20000,
};

const mockEmployer = {
  employerId: 'employer-abc',
  employerCode: 'TESTCO',
  companyName: 'Test Company SA de CV',
  status: 'active',
};

function buildMockDb({
  activeLoans = [] as Array<Record<string, unknown>>,
  employee = mockEmployee as Record<string, unknown> | null,
  employer = mockEmployer as Record<string, unknown> | null,
} = {}) {
  const loansQuery = makeQuery({
    empty: activeLoans.length === 0,
    docs: activeLoans.map((d) => ({ data: () => d, id: 'active-loan-id' })),
  });

  const transactionCalls: Array<{ op: string; data?: unknown }> = [];

  return {
    collection: jest.fn().mockImplementation((name: string) => {
      if (name === 'employees') {
        return {
          doc: jest.fn().mockReturnValue({
            get: jest.fn().mockResolvedValue({ exists: employee !== null, data: () => employee }),
          }),
        };
      }
      if (name === 'employers') {
        return {
          doc: jest.fn().mockReturnValue({
            get: jest.fn().mockResolvedValue({ exists: employer !== null, data: () => employer }),
          }),
        };
      }
      if (name === 'loans') {
        return { ...loansQuery, doc: jest.fn().mockReturnValue({ id: 'new-loan-id' }) };
      }
      if (name === 'audit_log') {
        return { add: jest.fn().mockResolvedValue({ id: 'audit-1' }) };
      }
      throw new Error(`Unexpected collection: ${name}`);
    }),
    runTransaction: jest.fn(async (fn: (txn: { update: jest.Mock; set: jest.Mock }) => Promise<void>) => {
      const txn = {
        update: jest.fn((_ref: unknown, data: unknown) => transactionCalls.push({ op: 'update', data })),
        set: jest.fn((_ref: unknown, data: unknown) => transactionCalls.push({ op: 'set', data })),
      };
      await fn(txn);
      return transactionCalls;
    }),
    _transactionCalls: transactionCalls,
  };
}

describe('requestLoan (deployed handler in index.ts)', () => {
  const auth = { uid: 'user-123', token: { role: 'employee' } };

  // The exact payload shape LoanWizard.tsx sends (public-v2/src/pages/LoanWizard.tsx).
  const realClientPayload = {
    amount: 1000,
    employerCode: 'TESTCO',
    bankAccountClabe: '032180000118359719',
    termsAccepted: true as const,
    termDays: 30,
  };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockDb = buildMockDb();
    mockCheckRateLimit.mockResolvedValue(true);
  });

  it('accepts the real client payload shape and does not reject with "Plazo inválido"', async () => {
    const { requestLoan } = await import('../index');
    const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<{
      loanId: string;
      status: string;
      total: number;
    }>;

    const result = await fn({ auth, data: realClientPayload });

    expect(result.loanId).toBeTruthy();
    expect(result.total).toBe(1000 + Math.round(1000 * 0.3));
  });

  it('charges the single-source-of-truth fee rate (30%), matching what the UI is quoted', async () => {
    const { requestLoan } = await import('../index');
    const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;

    await fn({ auth, data: realClientPayload });

    const loanWrite = mockDb._transactionCalls.find((c) => c.op === 'set') as
      | { data: Record<string, unknown> }
      | undefined;
    expect(loanWrite).toBeDefined();
    expect(loanWrite!.data['fee']).toBe(300); // 1000 * LOAN_FEE_RATE (0.3)
    expect(loanWrite!.data['term']).toBe(30);
  });

  it('rejects a term outside the server-defined allowed set', async () => {
    const { requestLoan } = await import('../index');
    const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;

    await expect(
      fn({ auth, data: { ...realClientPayload, termDays: 45 } })
    ).rejects.toMatchObject({ code: 'invalid-argument', message: 'Plazo inválido' });
  });

  it('getLoanConfig returns the same fee rate and terms requestLoan enforces', async () => {
    const { getLoanConfig } = await import('../index');
    const fn = getLoanConfig as unknown as (req: { auth?: unknown; data: unknown }) => Promise<{
      feeRate: number;
      allowedTermDays: number[];
    }>;

    const config = await fn({ auth, data: {} });

    expect(config.feeRate).toBe(0.3);
    expect(config.allowedTermDays).toEqual([30]);
  });
});
