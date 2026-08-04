// getPortfolioReport (index.ts) had five independent money-figure defects,
// all discovered by manual verification against current main:
//
// 1. totalDisbursedMXN summed every doc across all queried snapshots,
//    including `pending` — money that has not left the building yet. The
//    headline disbursed figure was overstated by the whole pending pipeline.
// 2. `overdue` loans were never queried, so they were invisible in
//    totalLoans, byStatus, byEmployer, and totalDisbursedMXN. An overdue
//    loan IS disbursed money; dropping it hides exactly the arrears problem
//    the report exists to surface.
// 3. totalRepaid/totalRevenue matched only `status === 'repaid'`, missing
//    the legacy repaid aliases ('paid', 'complete', 'completed') tracked in
//    loanStatus.ts's LEGACY_REPAID_ALIASES — a hand-written legacy-status
//    doc vanished from repaid volume and revenue entirely.
// 4. defaultRate was hardcoded to the string '0%' regardless of the real
//    book.
// 5. The `disbursed`-status query result was named `allSnap`, implying (and
//    inviting future bugs from believing) it held the whole collection.
//
// These tests pin the corrected figures against a small mixed-status book
// built from loanStatus.ts's own vocabulary — not against a status literal
// re-typed by hand — so a future drift back to hardcoded strings fails here
// the same way it failed in production.
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

type LoanDoc = Record<string, unknown>;

// A minimal `.where(...).where(...).get()` query fake over an in-memory doc
// array. Each `.where` call narrows the result set — enough to exercise the
// handler's `==` and `in` status filters without a real Firestore.
function filterDocs(docs: LoanDoc[], field: string, op: string, value: unknown): LoanDoc[] {
  if (op === '==') return docs.filter((d) => d[field] === value);
  if (op === 'in') return docs.filter((d) => (value as unknown[]).includes(d[field]));
  throw new Error(`unsupported query operator in test fake: ${op}`);
}

interface FakeQuery {
  where: jest.Mock<FakeQuery, [field: string, op: string, value: unknown]>;
  get: jest.Mock<Promise<{ size: number; docs: { id: string; data: () => LoanDoc }[] }>, []>;
}

function makeQuery(docs: LoanDoc[]): FakeQuery {
  return {
    where: jest.fn((field: string, op: string, value: unknown) => makeQuery(filterDocs(docs, field, op, value))),
    get: jest.fn(async () => ({
      size: docs.length,
      docs: docs.map((d, i) => ({ id: (d['id'] as string) ?? `loan-${i}`, data: () => d })),
    })),
  };
}

let mockLoans: LoanDoc[] = [];

const mockDb = {
  collection: jest.fn((name: string) => {
    if (name !== 'loans') throw new Error(`getPortfolioReport should only query 'loans', got '${name}'`);
    return makeQuery(mockLoans);
  }),
};

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockDb),
  FieldValue: mockFieldValue,
  Timestamp: MockTimestamp,
}));

jest.mock('node-fetch', () => ({ __esModule: true, default: jest.fn() }));

const mockCheckRateLimit = jest.fn().mockResolvedValue(true);
jest.mock('../utils/rateLimiter', () => {
  const mod = { checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args) };
  return {
    ...mod,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    enforceRateLimit: require('../__mocks__/utils/rateLimiter').makeEnforceRateLimit(
      (...a: unknown[]) => (mod as { checkRateLimit: (...a: unknown[]) => Promise<boolean> }).checkRateLimit(...a)
    ),
  };
});

jest.mock('../utils/notify', () => ({ notifyLoanEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/slackAlert', () => ({ sendSlackAlert: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/sentry', () => ({ initSentry: jest.fn(), captureException: jest.fn() }));

type PortfolioReport = {
  summary: {
    totalLoans: number;
    totalDisbursedMXN: number;
    totalRepaidMXN: number;
    totalRevenueMXN: number;
    defaultRate: string | null;
  };
  byStatus: Record<string, number>;
  byEmployer: Record<string, { count: number; volume: number }>;
};

type Handler = (req: { auth?: unknown; data: unknown }) => Promise<PortfolioReport>;

const ADMIN_AUTH = { uid: 'admin-1', token: { role: 'admin' } };

async function loadHandler(): Promise<Handler> {
  const { getPortfolioReport } = await import('../index');
  return getPortfolioReport as unknown as Handler;
}

describe('getPortfolioReport — money figures', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue(true);
    mockLoans = [];
  });

  it('excludes pending loans from totalDisbursedMXN but includes overdue and legacy-repaid-alias loans', async () => {
    mockLoans = [
      { id: 'l-active', status: 'active', amount: 1000, employerId: 'e1' },
      { id: 'l-pending', status: 'pending', amount: 5000, employerId: 'e1' },
      { id: 'l-repaid', status: 'repaid', amount: 2000, fee: 200, employerId: 'e2' },
      { id: 'l-disbursed', status: 'disbursed', amount: 3000, employerId: 'e2' },
      { id: 'l-overdue', status: 'overdue', amount: 4000, employerId: 'e3' },
      // Legacy repaid aliases: no live write path produces these, but a
      // hand-written or historical doc could still carry them.
      { id: 'l-paid', status: 'paid', amount: 1500, fee: 150, employerId: 'e3' },
      { id: 'l-complete', status: 'complete', amount: 2500, commission: 250, employerId: 'e1' },
    ];

    const fn = await loadHandler();
    const result = await fn({ auth: ADMIN_AUTH, data: {} });

    // totalDisbursedMXN = active + disbursed + overdue + repaid(+aliases),
    // excluding the pending 5000.
    expect(result.summary.totalDisbursedMXN).toBe(1000 + 3000 + 4000 + 2000 + 1500 + 2500);

    // totalRepaidMXN / totalRevenueMXN must include the legacy aliases.
    expect(result.summary.totalRepaidMXN).toBe(2000 + 1500 + 2500);
    expect(result.summary.totalRevenueMXN).toBe(200 + 150 + 250);

    // Every doc is counted, including the previously-invisible overdue one.
    expect(result.summary.totalLoans).toBe(7);

    // overdue must show up in byStatus.
    expect(result.byStatus['overdue']).toBe(1);
    expect(result.byStatus['active']).toBe(1);
    expect(result.byStatus['pending']).toBe(1);
    expect(result.byStatus['disbursed']).toBe(1);
    // repaid bucket folds in both legacy-alias docs.
    expect(result.byStatus['repaid']).toBe(3);

    // byEmployer must include the overdue loan's employer and volume.
    expect(result.byEmployer['e3']).toEqual({ count: 2, volume: 4000 + 1500 });

    // defaultRate: overdue volume (4000) / total disbursed volume (14000).
    expect(result.summary.defaultRate).toBe('28.57%');
  });

  it('returns null (not a fabricated 0%) for defaultRate when no money has been disbursed', async () => {
    mockLoans = [{ id: 'l-pending', status: 'pending', amount: 5000, employerId: 'e1' }];

    const fn = await loadHandler();
    const result = await fn({ auth: ADMIN_AUTH, data: {} });

    expect(result.summary.totalDisbursedMXN).toBe(0);
    expect(result.summary.defaultRate).toBeNull();
  });

  it('returns 0.00% default rate, not null, when there is disbursed volume but nothing overdue', async () => {
    mockLoans = [{ id: 'l-active', status: 'active', amount: 1000, employerId: 'e1' }];

    const fn = await loadHandler();
    const result = await fn({ auth: ADMIN_AUTH, data: {} });

    expect(result.summary.defaultRate).toBe('0.00%');
  });
});
