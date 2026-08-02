// Regression test for the ACTUAL deployed `requestLoan` callable (inline in
// index.ts — NOT the unused src/loans/requestLoan.ts variant). It exercises
// the real payload shape LoanWizard.tsx sends: { amount, employerCode,
// bankAccountClabe, termsAccepted, termDays, loanPurpose? }. Before the P0
// fix, the handler destructured `term` (which the client never sends) and
// rejected every request with "Plazo inválido".
import * as fs from 'fs';
import * as path from 'path';

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
  // The config/loan document backing getLoanConfigValues() (#389's async seam).
  // `null` means the document does not exist yet, so getLoanConfigValues()
  // returns the compile-time seed (feeRate 0.3) — matching production
  // behavior for an unconfigured deployment.
  configData = null as Record<string, unknown> | null,
} = {}) {
  const loansQuery = makeQuery({
    empty: activeLoans.length === 0,
    docs: activeLoans.map((d) => ({ data: () => d, id: 'active-loan-id' })),
  });

  const transactionCalls: Array<{ op: string; data?: unknown }> = [];
  let currentConfigData = configData;

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
      if (name === 'config') {
        return {
          doc: jest.fn().mockReturnValue({
            get: jest.fn().mockImplementation(() =>
              Promise.resolve({
                exists: currentConfigData !== null,
                data: () => currentConfigData ?? undefined,
              })
            ),
          }),
        };
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
    // Lets a test simulate an admin approving a config change (#389's propose
    // /approve flow) mid-test, i.e. between two requestLoan calls, without
    // reaching into module internals.
    _setConfigData: (data: Record<string, unknown> | null) => {
      currentConfigData = data;
    },
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
    delete process.env['UNDERWRITING_SERVICE_URL'];
    delete process.env['INTERNAL_SECRET'];
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

  it('applies the server default term when the client omits termDays', async () => {
    const { requestLoan } = await import('../index');
    const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
    const { termDays: _omitted, ...payloadWithoutTermDays } = realClientPayload;

    await fn({ auth, data: payloadWithoutTermDays });

    const loanWrite = mockDb._transactionCalls.find((c) => c.op === 'set') as
      | { data: Record<string, unknown> }
      | undefined;
    expect(loanWrite).toBeDefined();
    expect(loanWrite!.data['term']).toBe(30); // DEFAULT_LOAN_TERM_DAYS
  });

  it('persists feeRate at creation time; a later config change never reprices an already-created loan', async () => {
    const { requestLoan } = await import('../index');
    const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;

    // Loan #1 is created while the fee rate is 30% (no config/loan document
    // yet, i.e. the ratified compile-time seed is in force).
    await fn({ auth, data: realClientPayload });

    // The rate changes (an admin proposes+approves a config change via
    // config/loanConfigAdmin.ts) before loan #2 is requested by the same
    // borrower — simulated at the actual async seam: the config/loan document
    // getLoanConfigValues() reads, not a mocked module export. 0.32 is a
    // valid in-bounds rate (MAX_ALLOWED_FEE_RATE is 0.35); an out-of-bounds
    // value would correctly be rejected by assertValidFeeRate, which is not
    // what this test is exercising.
    mockDb._setConfigData({ feeRate: 0.32 });
    await fn({ auth, data: realClientPayload });

    const loanWrites = mockDb._transactionCalls.filter((c) => c.op === 'set') as Array<{
      data: Record<string, unknown>;
    }>;
    expect(loanWrites).toHaveLength(2);
    const [firstLoanWrite, secondLoanWrite] = loanWrites;

    // Loan #1's already-persisted fee/feeRate must be untouched by the rate
    // change that happened after it was created.
    expect(firstLoanWrite.data['feeRate']).toBe(0.3);
    expect(firstLoanWrite.data['fee']).toBe(300);

    // Loan #2 picks up the new rate in force at ITS creation time.
    expect(secondLoanWrite.data['feeRate']).toBe(0.32);
    expect(secondLoanWrite.data['fee']).toBe(320);
  });

  describe('underwriting condition breakdown (E5c)', () => {
    const sampleConditions = [
      { name: 'age_range', pass: true, value: 34, required: '18-65' },
      { name: 'bureau_score', pass: true, value: 650, required: '> 600' },
    ];

    // Mirrors the /underwrite HTTP response the callable actually receives.
    //
    // Note this is the RESPONSE shape, not decision-engine.js's return value —
    // conflating the two is the trap here. The endpoint
    // (services/underwriting-service/index.js) publishes BOTH: a lean
    // top-level `conditions`/`allPass` slice, added alongside the persistence
    // code in #393 as the contract for this caller, AND the verbose
    // `stages.stage3.data` payload it is derived from. A fixture that omits
    // either half does not represent a response the service can produce, so
    // build every mock through this helper.
    function uwResponse(
      top: Record<string, unknown>,
      stage3: { conditions: unknown[]; allPass: boolean } | null,
    ): Record<string, unknown> {
      return {
        ...top,
        stagesExecuted: stage3 ? ['stage1', 'stage2', 'stage3'] : ['stage1'],
        // The endpoint emits `null`, not `undefined`, when Stage 3 never ran.
        conditions: stage3 ? stage3.conditions : null,
        allPass: stage3 ? stage3.allPass : null,
        stages: stage3
          ? {
              stage3: {
                data: {
                  conditions: stage3.conditions,
                  allPass: stage3.allPass,
                  failedConditions: stage3.conditions.filter(
                    (c) => !(c as { pass: boolean }).pass,
                  ),
                },
              },
            }
          : {},
      };
    }

    async function mockUnderwritingResponse(body: Record<string, unknown> | null) {
      process.env['UNDERWRITING_SERVICE_URL'] = 'https://uw.internal';
      process.env['INTERNAL_SECRET'] = 'test-secret';
      const fetchModule = (await import('node-fetch')).default as unknown as jest.Mock;
      if (body === null) {
        fetchModule.mockRejectedValue(new Error('UW service unavailable'));
      } else {
        fetchModule.mockResolvedValue({ ok: true, json: async () => body });
      }
    }

    function getLoanWrite() {
      const loanWrite = mockDb._transactionCalls.find((c) => c.op === 'set') as
        | { data: Record<string, unknown> }
        | undefined;
      expect(loanWrite).toBeDefined();
      return loanWrite!.data;
    }

    it('persists the condition breakdown verbatim when underwriting approves', async () => {
      await mockUnderwritingResponse(
        uwResponse(
          {
            decision: 'approved',
            reason: null,
            correlationId: 'uw-123',
            lastStage: 'stage3',
          },
          { conditions: sampleConditions, allPass: true },
        ),
      );

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
      await fn({ auth, data: realClientPayload });

      const loanData = getLoanWrite();
      expect(loanData['status']).toBe('approved');
      expect(loanData['underwritingDecision']).toMatchObject({
        decision: 'approved',
        reason: null,
        allPass: true,
        conditions: sampleConditions,
      });
    });

    it('creates the loan with no breakdown, and does not throw, when underwriting is unreachable', async () => {
      await mockUnderwritingResponse(null);

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<{ loanId: string }>;
      const result = await fn({ auth, data: realClientPayload });

      expect(result.loanId).toBeTruthy();
      const loanData = getLoanWrite();
      expect(loanData['status']).toBe('pending');
      expect(loanData['underwritingDecision']).toBeUndefined();
    });

    it('persists the breakdown alongside the denial reason when underwriting rejects', async () => {
      await mockUnderwritingResponse(
        uwResponse(
          {
            decision: 'rejected',
            reason: 'FULL_KYC_REQUIRED',
            correlationId: 'uw-456',
            lastStage: 'stage4',
          },
          {
            conditions: [
              { name: 'bureau_score', pass: false, value: 550, required: '> 600' },
              ...sampleConditions,
            ],
            allPass: false,
          },
        ),
      );

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
      await fn({ auth, data: realClientPayload });

      const loanData = getLoanWrite();
      expect(loanData['status']).toBe('rejected');
      expect(loanData['denialReason']).toBe('FULL_KYC_REQUIRED');
      expect(loanData['underwritingDecision']).toMatchObject({
        decision: 'rejected',
        reason: 'FULL_KYC_REQUIRED',
        allPass: false,
      });
      expect((loanData['underwritingDecision'] as Record<string, unknown>)['conditions']).toHaveLength(3);
    });

    it('omits the breakdown when the pipeline stopped before stage 3', async () => {
      // An early rejection (e.g. stage-1 blacklist hit) never evaluates the
      // auto-approve conditions, so there is nothing to explain. This must be
      // a clean omission, not a crash on the missing stages.stage3 path.
      await mockUnderwritingResponse(
        uwResponse(
          {
            decision: 'rejected',
            reason: 'SAT_BLACKLIST',
            correlationId: 'uw-789',
            lastStage: 'stage1',
          },
          null,
        ),
      );

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<{ loanId: string }>;
      const result = await fn({ auth, data: realClientPayload });

      expect(result.loanId).toBeTruthy();
      const loanData = getLoanWrite();
      expect(loanData['status']).toBe('rejected');
      expect(loanData['denialReason']).toBe('SAT_BLACKLIST');
      expect(loanData['underwritingDecision']).toBeUndefined();
    });

    it('reads the lean top-level slice — the documented contract — without needing stages', async () => {
      // The lean `conditions`/`allPass` slice is the narrow contract between
      // the service and this caller (#393). `stages` is the verbose payload it
      // is derived from and is the half that could plausibly be trimmed off
      // the wire for size. Persisting must therefore survive `stages` being
      // absent entirely.
      await mockUnderwritingResponse({
        decision: 'approved',
        reason: null,
        correlationId: 'uw-lean',
        lastStage: 'stage3',
        stagesExecuted: ['stage1', 'stage2', 'stage3'],
        allPass: true,
        conditions: sampleConditions,
      });

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
      await fn({ auth, data: realClientPayload });

      const persisted = getLoanWrite()['underwritingDecision'] as Record<string, unknown>;
      expect(persisted).toBeDefined();
      expect(persisted['allPass']).toBe(true);
      expect(persisted['conditions']).toHaveLength(2);
    });

    it('falls back to stages.stage3.data when the lean slice is absent', async () => {
      // Defensive path, for a service too old to publish the lean slice. Not
      // reachable against today's deployment, but it is the reason the nested
      // read is retained, so it is pinned rather than left as dead code.
      await mockUnderwritingResponse({
        decision: 'approved',
        reason: null,
        correlationId: 'uw-nested-only',
        lastStage: 'stage3',
        stagesExecuted: ['stage1', 'stage2', 'stage3'],
        stages: { stage3: { data: { conditions: sampleConditions, allPass: true } } },
      });

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
      await fn({ auth, data: realClientPayload });

      const persisted = getLoanWrite()['underwritingDecision'] as Record<string, unknown>;
      expect(persisted).toBeDefined();
      expect(persisted['allPass']).toBe(true);
      expect(persisted['conditions']).toHaveLength(2);
    });
  });
});

// Guards against the exact drift that caused P0-2: the fee rate re-declared as
// a second, independently-editable literal instead of being read through the
// single source of truth in config/loanConfig.ts. These read the real source
// files on disk (not the compiled/mocked module) so a hardcoded literal can't
// hide behind a mock.
describe('fee-rate literal guardrail (P0-2 regression)', () => {
  it('index.ts computes the loan fee only via the config seam (getLoanConfigValues) — no hardcoded fee-rate literal', () => {
    const src = fs.readFileSync(path.join(__dirname, '../index.ts'), 'utf8');

    // As of #389 the rate is admin-editable and lives in Firestore, read via
    // getLoanConfigValues() — LOAN_FEE_RATE is no longer a module-level
    // constant requestLoan can read directly, only the seed value that
    // function falls back to. The fee MUST be derived from that single async
    // read (the same value persisted as `feeRate` on the loan and returned by
    // getLoanConfig), never from a second, independently-editable literal.
    expect(src).toMatch(/const loanConfig = await getLoanConfigValues\(\)/);
    expect(src).toMatch(/const fee = Math\.round\(amount \* loanConfig\.feeRate\)/);
    expect(src).toMatch(/feeRate:\s*loanConfig\.feeRate/);
    // Catches any hardcoded numeric fee rate multiplied against the loan amount
    // (e.g. `amount * 0.08` or `amount * 0.3`) reappearing in the handler.
    expect(src).not.toMatch(/amount\s*\*\s*0\.\d+/);
  });

  it('LoanWizard.tsx derives its quoted fee rate from getLoanConfig — no hardcoded fee-rate literal', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../../public-v2/src/pages/LoanWizard.tsx'),
      'utf8'
    );

    expect(src).toMatch(/feeRate\s*=\s*loanConfig\?\.feeRate/);
    // Catches a hardcoded fee-rate literal multiplied against the loan amount
    // reappearing (e.g. the old `Math.round(amount * 0.08)`), without false
    // -positiving on unrelated numeric literals like CSS opacity values.
    expect(src).not.toMatch(/amount\s*\*\s*0\.08/);
  });
});
