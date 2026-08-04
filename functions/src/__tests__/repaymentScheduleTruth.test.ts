import { guardReadAfterWrite as mockGuardReadAfterWrite } from '../__mocks__/txReadAfterWrite';
// #424 — the repayment schedule a borrower is QUOTED must be the repayment the
// system actually EXECUTES.
//
// The defect this file exists to stop: LoanWizard.tsx computed
// `Math.ceil(termDays / 15)` and told the borrower their $1,300 loan would be
// collected as TWO biweekly payments of $650, plus a CAT it derived itself,
// while index.ts registered ONE payroll deduction of $1,300 on the due date.
// There was no installment model in the backend at all. Same class as the
// 8%/30% fee split (ADR-002): a pre-contractual disclosure that disagrees with
// what the product does, which under the CONDUSEF regime is consumer-protection
// exposure rather than a display bug.
//
// A unit test of either side alone cannot catch that — both were internally
// consistent. So this drives the REAL deployed handlers end to end:
//
//   getLoanConfig()  → what the borrower is quoted
//   requestLoan()    → what is written on the loan and printed on the contract
//   onLoanApproved() → what is registered with SoftCrédito and actually collected
//
// and asserts the three describe one schedule.

// Marks this file as a MODULE. Do not delete — it is load-bearing.
//
// Everything here is imported lazily (see the note immediately below), so this
// file would otherwise carry no top-level import or export, and TypeScript
// would treat it as a SCRIPT whose top-level declarations land in the global
// scope. `submitReviewDecision.test.ts` is written the same way and declares
// the same four names — `mockLogger`, `MockTimestamp`, `mockFieldValue`,
// `mockDb` — so the two collide with TS2300/TS2451 as soon as both are
// type-checked in one program.
//
// This does not reproduce against a warm ts-jest cache, which is exactly how it
// passed locally and failed in CI. Any future test file here that mocks
// firebase-admin this way needs this line too.
export {};

// Imported lazily inside each test, not at module scope: a static import here
// would evaluate the firebase-admin/firestore mock factory below before its
// helper consts exist. Also keeps the module instance in step with the
// jest.resetModules() that runs before every test.
const loanConfig = () => import('../config/loanConfig');
type LoanConfigModule = Awaited<ReturnType<typeof loanConfig>>;

jest.mock('firebase-admin/app', () => ({ initializeApp: jest.fn() }));

jest.mock('firebase-functions/v2/https', () => ({
  onCall: jest.fn((_opts: unknown, handler: unknown) => handler),
  onRequest: jest.fn((...args: unknown[]) => (args.length === 1 ? args[0] : args[1])),
  HttpsError: class HttpsError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = 'HttpsError';
    }
  },
}));

// Unlike the other suites, the trigger handlers are handed back rather than
// swallowed — onLoanApproved is the code under test, not scaffolding.
jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentCreated: jest.fn((_path: unknown, handler: unknown) => handler),
  onDocumentUpdated: jest.fn((_path: unknown, handler: unknown) => handler),
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
  static fromMillis(ms: number) {
    return new MockTimestamp(Math.floor(ms / 1000));
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

const mockFetch = jest.fn();
jest.mock('node-fetch', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockFetch(...args),
}));

jest.mock('../utils/rateLimiter', () => {
  const mod = { checkRateLimit: jest.fn().mockResolvedValue(true) };
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

const EMPLOYEE = {
  name: 'Juan García',
  email: 'juan@example.com',
  employerId: 'employer-abc',
  employerName: 'Test Co',
  availableCredit: 5000,
  monthlySalary: 20000,
  bankClabe: '032180000118359719',
};

const EMPLOYER = {
  employerId: 'employer-abc',
  employerCode: 'TESTCO',
  companyName: 'Test Company SA de CV',
  status: 'active',
};

function makeQuery() {
  const query: { where: jest.Mock; limit: jest.Mock; get: jest.Mock; count: jest.Mock } = {
    where: jest.fn(),
    limit: jest.fn(),
    get: jest.fn().mockResolvedValue({ empty: true, docs: [] }),
    // ADR-005 Finding 2 / ADR-007: requestLoan's employer-slot-cap check
    // aggregates this same 'loans' collection via `.count()`, tagged so the
    // transaction mock's `get()` below can recognize the aggregate query
    // object (as opposed to a document reference) without depending on the
    // real Firestore AggregateQuery shape.
    count: jest.fn(),
  };
  query.where.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  const employerActiveLoansCountQuery = { _kind: 'employerActiveLoansCountQuery' as const };
  query.count.mockReturnValue(employerActiveLoansCountQuery);
  return query;
}

function buildMockDb() {
  const loansQuery = makeQuery();
  const writes: Array<{ op: string; data?: unknown }> = [];

  const employerDocRef = {
    _kind: 'employerDocRef' as const,
    get: jest.fn().mockResolvedValue({ exists: true, data: () => EMPLOYER }),
  };

  return {
    collection: jest.fn().mockImplementation((name: string) => {
      if (name === 'employees') {
        return {
          doc: jest.fn().mockReturnValue({
            get: jest.fn().mockResolvedValue({ exists: true, data: () => EMPLOYEE }),
          }),
        };
      }
      if (name === 'employers') {
        return { doc: jest.fn().mockReturnValue(employerDocRef) };
      }
      if (name === 'loans') {
        return {
          ...loansQuery,
          doc: jest.fn().mockReturnValue({
            id: 'new-loan-id',
            _kind: 'loanDocRef',
            update: jest.fn(async (data: unknown) => {
              writes.push({ op: 'loan.update', data });
            }),
          }),
        };
      }
      if (name === 'disbursement_queue') {
        return {
          doc: jest.fn().mockReturnValue({
            _kind: 'disbursementQueueDocRef',
            set: jest.fn(async (data: unknown) => writes.push({ op: 'queue.set', data })),
            update: jest.fn(async (data: unknown) => writes.push({ op: 'queue.update', data })),
          }),
        };
      }
      if (name === 'audit_log') {
        // `where`/`get` in addition to `add`: requestLoan now counts the
        // borrower's requests in the last hour off this collection to feed the
        // ML gate's `requestsLastHour` signal. Empty is the right answer for
        // this file's single fresh borrower, and without the chain the
        // TypeError surfaces as a generic 'internal' HttpsError — a harness
        // gap wearing a product failure's clothes.
        const q: { where: jest.Mock; get: jest.Mock } = {
          where: jest.fn(),
          get: jest.fn().mockResolvedValue({ empty: true, docs: [], size: 0 }),
        };
        q.where.mockReturnValue(q);
        return { ...q, add: jest.fn().mockResolvedValue({ id: 'audit-1' }) };
      }
      if (name === 'review_queue') {
        // Written in requestLoan's transaction when the ML gate is
        // unreachable, which is the default in this file (no ML_SERVICE_URL),
        // so the loan lands `under_review` with a queue row instead of a
        // silently unscored `pending`. Tagged so tx.set below can tell it
        // apart from the loan write these tests actually assert on.
        return { doc: jest.fn().mockReturnValue({ _kind: 'reviewQueueDocRef' }) };
      }
      if (name === 'config') {
        // No config document: getLoanConfigValues() returns the ratified seed,
        // which is what an unconfigured deployment does in production.
        return {
          doc: jest.fn().mockReturnValue({
            get: jest.fn().mockResolvedValue({ exists: false, data: () => undefined }),
          }),
        };
      }
      throw new Error(`Unexpected collection: ${name}`);
    }),
    runTransaction: jest.fn(
      async (fn: (txn: { get: jest.Mock; update: jest.Mock; set: jest.Mock }) => Promise<unknown>) => {
        const txn = {
          get: jest.fn((refOrQuery: { _kind?: string } | undefined) => {
            if (refOrQuery?._kind === 'employerDocRef') {
              return Promise.resolve({ exists: true, data: () => EMPLOYER });
            }
            if (refOrQuery?._kind === 'employerActiveLoansCountQuery') {
              return Promise.resolve({ data: () => ({ count: 0 }) });
            }
            // onLoanApproved's idempotency claim (P0-B): a fresh loan mid-approval,
            // with no prior disbursement_queue entry, so the claim proceeds.
            if (refOrQuery?._kind === 'loanDocRef') {
              return Promise.resolve({ exists: true, data: () => ({ status: 'approved' }) });
            }
            if (refOrQuery?._kind === 'disbursementQueueDocRef') {
              return Promise.resolve({ exists: false, data: () => undefined });
            }
            throw new Error('Mock tx.get() called with an unrecognized ref/query');
          }),
          update: jest.fn(),
          set: jest.fn((ref: { _kind?: string } | undefined, data: unknown) =>
            writes.push({
              op:
                ref?._kind === 'disbursementQueueDocRef'
                  ? 'queue.set'
                  : ref?._kind === 'reviewQueueDocRef'
                    ? 'review.set'
                    : 'loan.set',
              data,
            })
          ),
        };
        return fn(mockGuardReadAfterWrite(txn));
      }
    ),
    _writes: writes,
  };
}

const AUTH = { uid: 'user-123', token: { role: 'employee' } };
const CLIENT_PAYLOAD = {
  amount: 1000,
  employerCode: 'TESTCO',
  bankAccountClabe: '032180000118359719',
  termsAccepted: true as const,
  termDays: 30,
};

type LoanDoc = Record<string, unknown>;
type PersistedInstallment = { number: number; amount: number; dueDate: MockTimestamp };

/** Runs requestLoan and returns the loan document it wrote. */
async function createLoan(): Promise<LoanDoc> {
  const { requestLoan } = await import('../index');
  const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
  await fn({ auth: AUTH, data: CLIENT_PAYLOAD });
  const write = mockDb._writes.find((w) => w.op === 'loan.set');
  if (!write) throw new Error('requestLoan wrote no loan document');
  return write.data as LoanDoc;
}

/**
 * Drives the deployed onLoanApproved trigger over a loan document and returns
 * the body it POSTed to /internal/register-deduction — i.e. the deduction the
 * borrower will actually have taken out of their pay.
 */
async function registerDeductionFor(loan: LoanDoc): Promise<{ amount: number; dueDate: string }> {
  const { onLoanApproved } = await import('../index');
  const handler = onLoanApproved as unknown as (event: unknown) => Promise<unknown>;

  await handler({
    params: { loanId: 'new-loan-id' },
    data: {
      before: { data: () => ({ ...loan, status: 'pending' }) },
      after: { data: () => ({ ...loan, status: 'approved' }) },
    },
  });

  const call = mockFetch.mock.calls.find(([url]) => String(url).endsWith('/internal/register-deduction'));
  if (!call) throw new Error('onLoanApproved did not register a payroll deduction');
  return JSON.parse((call[1] as { body: string }).body);
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockDb = buildMockDb();
  process.env['SOFTCREDITO_ADAPTER_URL'] = 'https://sc.example.test';
  process.env['INTERNAL_SECRET'] = 'test-secret';
  delete process.env['UNDERWRITING_SERVICE_URL'];
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ref: 'SPEI-1', deductionId: 'DED-1' }),
    text: async () => '',
  });
});

afterEach(() => {
  delete process.env['SOFTCREDITO_ADAPTER_URL'];
  delete process.env['INTERNAL_SECRET'];
});

describe('the quoted repayment schedule IS the deduction that gets registered', () => {
  it('quotes, contracts and collects one identical schedule', async () => {
    const { getLoanConfig } = await import('../index');
    const configFn = getLoanConfig as unknown as (req: {
      auth?: unknown;
      data: unknown;
    }) => Promise<ReturnType<LoanConfigModule['getSeedLoanConfigValues']>>;

    // 1. What the borrower is quoted.
    const config = await configFn({ auth: AUTH, data: {} });
    const quoted = config.repayment.find((r) => r.termDays === 30);
    expect(quoted).toBeDefined();

    // 2. What is written on the loan (and printed on the contract PDF).
    const loan = await createLoan();
    const persisted = loan['repaymentSchedule'] as PersistedInstallment[];
    const total = loan['total'] as number;

    // 3. What is actually collected.
    const registered = await registerDeductionFor(loan);

    // The quote, the contract and the collection agree on how many payments
    // there are...
    expect(persisted).toHaveLength(quoted!.installments.length);
    expect(persisted).toHaveLength(1);

    // ...on how much is taken...
    expect(persisted.reduce((sum, i) => sum + i.amount, 0)).toBe(total);
    expect(registered.amount).toBe(persisted[0]!.amount);
    expect(registered.amount).toBe(total);

    // ...and on when.
    expect(registered.dueDate).toBe(persisted[0]!.dueDate.toDate().toISOString());
    expect(registered.dueDate).toBe((loan['dueDate'] as MockTimestamp).toDate().toISOString());
    expect(quoted!.installments[0]!.dueInDays).toBe(loan['term']);
  });

  it('does not quote the two biweekly payments nobody ever collected', async () => {
    const { getLoanConfig } = await import('../index');
    const configFn = getLoanConfig as unknown as (req: {
      auth?: unknown;
      data: unknown;
    }) => Promise<ReturnType<LoanConfigModule['getSeedLoanConfigValues']>>;

    const config = await configFn({ auth: AUTH, data: {} });
    const loan = await createLoan();
    const registered = await registerDeductionFor(loan);

    // The exact numbers the wizard used to show for this loan: Math.ceil(30/15)
    // = 2 payments of Math.ceil(1300/2) = $650. Neither was ever collected.
    expect(config.repayment[0]!.installments).toHaveLength(1);
    expect(registered.amount).not.toBe(650);
    expect(registered.amount).toBe(1300);
  });

  it('persists the CAT it published, so the contract cannot disclose a different one', async () => {
    const { getLoanConfig } = await import('../index');
    const configFn = getLoanConfig as unknown as (req: {
      auth?: unknown;
      data: unknown;
    }) => Promise<ReturnType<LoanConfigModule['getSeedLoanConfigValues']>>;

    const config = await configFn({ auth: AUTH, data: {} });
    const loan = await createLoan();

    expect(loan['catPercent']).toBe(config.repayment[0]!.catPercent);
    // Same value the contract PDF has always printed for a 30% / 30-day loan.
    expect(loan['catPercent']).toBe(2334);
  });
});

describe('REPAYMENT_STRUCTURE', () => {
  it('is a complete schedule — the shares sum to the whole loan', async () => {
    const { REPAYMENT_STRUCTURE } = await loanConfig();
    const totalShare = REPAYMENT_STRUCTURE.reduce((sum, i) => sum + i.shareOfTotal, 0);
    expect(totalShare).toBeCloseTo(1, 12);
    expect(REPAYMENT_STRUCTURE.map((i) => i.number)).toEqual(
      REPAYMENT_STRUCTURE.map((_, idx) => idx + 1)
    );
  });

  it('describes what this repo can actually execute — one payroll deduction', async () => {
    const { REPAYMENT_STRUCTURE } = await loanConfig();
    // Not an aesthetic assertion. The SoftCrédito adapter registers exactly one
    // {amount, deductionDate} per loan, so a second entry here would mean the
    // quote once again describes a repayment nothing implements.
    expect(REPAYMENT_STRUCTURE).toHaveLength(1);
    expect(REPAYMENT_STRUCTURE[0]).toMatchObject({ atTermFraction: 1, shareOfTotal: 1 });
  });
});

describe('buildLoanInstallments', () => {
  const dueDate = new Date('2026-09-01T12:00:00.000Z');

  it('lands the final installment exactly on the loan due date', async () => {
    const { buildLoanInstallments } = await loanConfig();
    const schedule = buildLoanInstallments(1300, dueDate, 30);
    expect(schedule[schedule.length - 1]!.dueDate.toISOString()).toBe(dueDate.toISOString());
  });

  it('always sums to the total, at every amount the product allows', async () => {
    const { buildLoanInstallments } = await loanConfig();
    for (let amount = 500; amount <= 5000; amount += 100) {
      const total = amount + Math.round(amount * 0.3);
      const schedule = buildLoanInstallments(total, dueDate, 30);
      expect(schedule.reduce((sum, i) => sum + i.amount, 0)).toBe(total);
    }
  });

  it('rejects inputs it cannot build an honest schedule from', async () => {
    const { buildLoanInstallments, LoanConfigError } = await loanConfig();
    expect(() => buildLoanInstallments(Number.NaN, dueDate, 30)).toThrow(LoanConfigError);
    expect(() => buildLoanInstallments(1300, new Date('nope'), 30)).toThrow(LoanConfigError);
    expect(() => buildLoanInstallments(1300, dueDate, 0)).toThrow(LoanConfigError);
  });
});

describe('toPayrollDeduction', () => {
  it('refuses to register a subset of a longer schedule', async () => {
    const { toPayrollDeduction, LoanConfigError } = await loanConfig();
    // The guard that keeps the two sides from drifting apart again in the other
    // direction: publishing a 2-installment quote the adapter cannot register
    // would under-collect rather than over-quote. Either way the borrower is
    // told something untrue, so this throws instead of sending the first one.
    const dueDate = new Date('2026-09-01T12:00:00.000Z');
    const twoInstallments = [
      { number: 1, amount: 650, dueDate },
      { number: 2, amount: 650, dueDate },
    ];

    expect(() => toPayrollDeduction(twoInstallments)).toThrow(LoanConfigError);
    expect(() => toPayrollDeduction(twoInstallments)).toThrow(/exactly one deduction/);
    expect(() => toPayrollDeduction([])).toThrow(LoanConfigError);
  });
});

describe('computeCatPercent', () => {
  // The CAT is a regulated disclosure. It is derived from REPAYMENT_STRUCTURE by
  // discounting the scheduled payments, but for today's single bullet payment
  // that has to reduce to the closed form the contract PDF has always printed —
  // otherwise this "fix" would quietly restate every borrower's cost of credit.
  const closedForm = (feeRate: number, termDays: number) =>
    Math.round((Math.pow(1 + feeRate, 365 / termDays) - 1) * 100);

  it.each([0, 0.08, 0.12, 0.3, 0.35])(
    'agrees with the contract PDF formula at feeRate %s',
    async (feeRate) => {
      const { computeCatPercent } = await loanConfig();
      expect(computeCatPercent(feeRate, 30)).toBe(closedForm(feeRate, 30));
    }
  );

  it('is 2334% for the ratified 30% / 30-day loan', async () => {
    const { computeCatPercent } = await loanConfig();
    expect(computeCatPercent(0.3, 30)).toBe(2334);
  });

  it('rejects inputs that would produce a disclosure nobody can stand behind', async () => {
    const { computeCatPercent, LoanConfigError } = await loanConfig();
    expect(() => computeCatPercent(Number.NaN, 30)).toThrow(LoanConfigError);
    expect(() => computeCatPercent(-0.1, 30)).toThrow(LoanConfigError);
    expect(() => computeCatPercent(0.3, 0)).toThrow(LoanConfigError);
  });
});
