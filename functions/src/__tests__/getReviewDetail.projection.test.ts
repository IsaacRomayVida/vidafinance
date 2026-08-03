// getReviewDetail used to return `{ id, ...snap.data() }` for the employee and
// employer documents, so every ops page view shipped the whole stored record to
// the browser — including the employer's `apiKeyHash` (the payroll-integration
// credential), `bankClabe`, `mlScore` and `llmAnalysis`. The console renders
// three employer fields and five employee fields.
//
// These tests assert on the KEY SET, not on a snapshot: a snapshot would happily
// go green again the day someone spreads the document back in and re-blesses the
// output. The exclusions must fail loudly.

// This file has no top-level `import`, so without an explicit export TypeScript
// treats it as a global script and every `const` here collides with the identically
// named `const` in the sibling suites. Keep this.
export {};

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

jest.mock('node-fetch', () => ({ __esModule: true, default: jest.fn() }));

const mockCheckRateLimit = jest.fn().mockResolvedValue(true);
jest.mock('../utils/rateLimiter', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

jest.mock('../utils/notify', () => ({ notifyLoanEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/slackAlert', () => ({ sendSlackAlert: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/sentry', () => ({ initSentry: jest.fn(), captureException: jest.fn() }));

// A realistic employer record: the three fields the console renders, sitting in
// the same document as the credential material firestore.rules calls out.
const EMPLOYER_DOC = {
  companyName: 'Grupo Textil del Bajío',
  industry: 'manufacturing',
  riskTier: 2,
  apiKeyHash: '$2b$12$KzVQ9dTLm0wQ3lY7pN1ceOJmXbA6sR8fH2gU4vW1xY0zB5cD7eF9G',
  bankClabe: '012180001234567895',
  rfc: 'GTB950101ABC',
  email: 'nomina@grupotextil.mx',
  mlScore: 0.72,
  llmAnalysis: { verdict: 'elevated risk', rationale: 'late payroll files in Q2' },
  currentOutstandingBalance: 184000,
  maxActiveSlots: 40,
};

// Likewise for the employee: five rendered fields, plus bank and identity data
// the detail screen never asks for.
const EMPLOYEE_DOC = {
  rfc: 'MAGJ900215HDF',
  curp: 'MAGJ900215HDFRRN08',
  email: 'juan.garcia@grupotextil.mx',
  phone: '+525512345678',
  monthlySalary: 18500,
  bankClabe: '012180009876543210',
  bankAccount: '9876543210',
  creditLimit: 5550,
  metamapVerificationId: 'mm-verif-8812',
};

function buildMockDb() {
  const review = { status: 'pending_review', loanId: 'loan-1', applicantName: 'Juan García' };
  const loan = { employeeId: 'emp-1', employerId: 'empr-1', amount: 3000, status: 'under_review' };

  // The ml_decisions and audit_log lookups are chained queries; they are not what
  // these tests are about, so they resolve empty.
  interface Query {
    where: jest.Mock;
    orderBy: jest.Mock;
    limit: jest.Mock;
    get: jest.Mock;
  }
  const emptyQuery: Query = {
    where: jest.fn(() => emptyQuery),
    orderBy: jest.fn(() => emptyQuery),
    limit: jest.fn(() => emptyQuery),
    get: jest.fn().mockResolvedValue({ empty: true, docs: [] }),
  };

  const dataFor: Record<string, Record<string, unknown> | null> = {
    review_queue: review,
    loans: loan,
    employees: EMPLOYEE_DOC,
    employers: EMPLOYER_DOC,
  };

  return {
    collection: jest.fn((name: string) => ({
      ...emptyQuery,
      where: jest.fn(() => emptyQuery),
      doc: jest.fn((id: string) => ({
        id,
        get: jest.fn().mockResolvedValue({
          exists: dataFor[name] !== undefined,
          id,
          data: () => dataFor[name],
        }),
      })),
    })),
  };
}

type Handler = (req: { auth?: unknown; data: unknown }) => Promise<{
  employee: Record<string, unknown> | null;
  employer: Record<string, unknown> | null;
  review: Record<string, unknown>;
}>;

const opsAuth = { uid: 'ops-1', token: { role: 'ops', email: 'ops@vidafinance.mx' } };

async function loadHandler(): Promise<Handler> {
  const { getReviewDetail } = await import('../index');
  return getReviewDetail as unknown as Handler;
}

describe('getReviewDetail — response-boundary field projection', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue(true);
    mockDb = buildMockDb();
  });

  it('does not ship the employer payroll credential or bank details to the browser', async () => {
    const fn = await loadHandler();
    const result = await fn({ auth: opsAuth, data: { reviewId: 'rev-1' } });

    const keys = Object.keys(result.employer!);
    expect(keys).not.toContain('apiKeyHash');
    expect(keys).not.toContain('bankClabe');
    expect(keys).not.toContain('llmAnalysis');
    expect(keys).not.toContain('mlScore');
  });

  it('returns only the employer fields the console renders, plus id', async () => {
    const fn = await loadHandler();
    const result = await fn({ auth: opsAuth, data: { reviewId: 'rev-1' } });

    // Exact key set — anything new here is a deliberate decision, not a spread.
    expect(Object.keys(result.employer!).sort()).toEqual(
      ['companyName', 'id', 'industry', 'riskTier'].sort()
    );
  });

  it('still returns every employer field ReviewDetail.tsx reads', async () => {
    const fn = await loadHandler();
    const result = await fn({ auth: opsAuth, data: { reviewId: 'rev-1' } });

    expect(result.employer).toMatchObject({
      companyName: EMPLOYER_DOC.companyName,
      industry: EMPLOYER_DOC.industry,
      riskTier: EMPLOYER_DOC.riskTier,
    });
  });

  it('does not ship employee bank details or verification identifiers', async () => {
    const fn = await loadHandler();
    const result = await fn({ auth: opsAuth, data: { reviewId: 'rev-1' } });

    const keys = Object.keys(result.employee!);
    expect(keys).not.toContain('bankClabe');
    expect(keys).not.toContain('bankAccount');
    expect(keys).not.toContain('metamapVerificationId');
  });

  it('still returns every employee field ReviewDetail.tsx reads', async () => {
    const fn = await loadHandler();
    const result = await fn({ auth: opsAuth, data: { reviewId: 'rev-1' } });

    // The console legitimately shows RFC, CURP and salary — that is the reviewer's
    // job. The projection narrows the payload, it does not blind the screen.
    expect(Object.keys(result.employee!).sort()).toEqual(
      ['curp', 'email', 'id', 'monthlySalary', 'phone', 'rfc'].sort()
    );
    expect(result.employee).toMatchObject({
      rfc: EMPLOYEE_DOC.rfc,
      curp: EMPLOYEE_DOC.curp,
      email: EMPLOYEE_DOC.email,
      phone: EMPLOYEE_DOC.phone,
      monthlySalary: EMPLOYEE_DOC.monthlySalary,
    });
  });

  it('leaves the review document itself whole — it is the underwriting evidence record', async () => {
    const fn = await loadHandler();
    const result = await fn({ auth: opsAuth, data: { reviewId: 'rev-1' } });

    expect(result.review).toMatchObject({
      id: 'rev-1',
      status: 'pending_review',
      loanId: 'loan-1',
      applicantName: 'Juan García',
    });
  });
});
