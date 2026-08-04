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

jest.mock('node-fetch', () => ({
  __esModule: true,
  default: jest.fn(),
}));

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

// `loans` backs THREE distinct queries in requestLoan, all built the same
// `.where().where()...` way:
//   1. the per-employee duplicate-application guard (ACTIVE_LOAN_STATUSES,
//      `.limit(1).get()`)
//   2. the employer slot-cap count (ACTIVE_LOAN_STATUSES, `.count()`, read
//      only via `tx.get()` inside the transaction below — never `.get()`
//      directly)
//   3. D2's existingLoans signal (OUTSTANDING_STATUSES, `.get()`)
// A single shared query object (the pre-fix mock) cannot tell these apart —
// every `.where()` call has to return a FRESH chain that remembers its own
// clauses, so `.get()`/`.count()` can answer based on what was actually
// filtered on. Told apart by `status`: OUTSTANDING_STATUSES uniquely
// includes 'disbursed', which ACTIVE_LOAN_STATUSES does not.
function makeLoansChain(
  clauses: Array<{ field: string; value: unknown }>,
  state: { activeLoans: Array<Record<string, unknown>>; outstandingLoansCount: number },
  employerActiveLoansCountQuery: { _kind: 'employerActiveLoansCountQuery' }
): { where: jest.Mock; limit: jest.Mock; get: jest.Mock; count: jest.Mock } {
  const chain: { where: jest.Mock; limit: jest.Mock; get: jest.Mock; count: jest.Mock } = {
    where: jest.fn((field: string, _op: string, value: unknown) =>
      makeLoansChain([...clauses, { field, value }], state, employerActiveLoansCountQuery)
    ),
    limit: jest.fn(),
    get: jest.fn(() => {
      const statusClause = clauses.find((c) => c.field === 'status');
      const statuses = (statusClause?.value ?? []) as unknown[];
      if (Array.isArray(statuses) && statuses.includes('disbursed')) {
        return Promise.resolve({
          empty: state.outstandingLoansCount === 0,
          size: state.outstandingLoansCount,
          docs: Array.from({ length: state.outstandingLoansCount }, (_, i) => ({
            data: () => ({}),
            id: `outstanding-loan-${i}`,
          })),
        });
      }
      return Promise.resolve({
        empty: state.activeLoans.length === 0,
        size: state.activeLoans.length,
        docs: state.activeLoans.map((d) => ({ data: () => d, id: 'active-loan-id' })),
      });
    }),
    // Tagged so the runTransaction mock's `get()` below can recognize it was
    // handed the aggregate query object, not a document reference.
    count: jest.fn(() => employerActiveLoansCountQuery),
  };
  chain.limit.mockReturnValue(chain);
  return chain;
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
  // Simulates the audit collection itself being unwritable, to prove a failed
  // audit write never changes the error the borrower receives.
  auditWriteFails = false,
  // How many OTHER loans are currently active against this employer, across
  // all of its employees — the count the transactional slot-cap check reads.
  // Deliberately independent of `activeLoans` above, which only backs the
  // per-EMPLOYEE duplicate-application guard.
  activeEmployerLoansCount = 0,
  // D2: how many OUTSTANDING_STATUSES loans this borrower already has —
  // independent of `activeLoans` (ACTIVE_LOAN_STATUSES), since the two
  // status sets diverge on disbursed/overdue/in_collections, and a nonzero
  // `activeLoans` would trip the duplicate-application guard before the ML
  // gate is ever reached.
  outstandingLoansCount = 0,
  // D2: how many audit_log rows this uid has in the last hour — backs
  // requestsLastHour.
  recentRequestsCount = 0,
} = {}) {
  const employerActiveLoansCountQuery = { _kind: 'employerActiveLoansCountQuery' as const };
  const loansState = { activeLoans, outstandingLoansCount };
  const loansQuery = makeLoansChain([], loansState, employerActiveLoansCountQuery);

  const transactionCalls: Array<{ op: string; ref?: string; data?: unknown }> = [];
  const auditWrites: Array<Record<string, unknown>> = [];
  let currentConfigData = configData;
  let currentEmployer = employer;

  // One stable object across every collection('audit_log') call, so a test can
  // read what was written. `auditWriteFails` makes the write reject, which is
  // how the fail-soft guarantee is exercised. `.where().where().get()` backs
  // D2's requestsLastHour signal — a fixed `recentRequestsCount`, independent
  // of whatever `.add()` has accumulated into `auditWrites` so far.
  const auditQueryChain: { where: jest.Mock; get: jest.Mock } = {
    where: jest.fn(),
    get: jest.fn(() => Promise.resolve({ size: recentRequestsCount })),
  };
  auditQueryChain.where.mockReturnValue(auditQueryChain);
  const auditCollection = {
    add: jest.fn(async (doc: Record<string, unknown>) => {
      if (auditWriteFails) throw new Error('audit_log unavailable');
      auditWrites.push(doc);
      return { id: `audit-${auditWrites.length}` };
    }),
    where: jest.fn().mockReturnValue(auditQueryChain),
  };

  // Same tagging idea as the aggregate query above: requestLoan reads the
  // employer doc once outside the transaction (the status check) and again
  // via `tx.get(employerRef)` inside it (the slot-cap check), and both must
  // resolve to the SAME ref object for the transaction mock to recognize it.
  const employerDocRef = {
    _kind: 'employerDocRef' as const,
    get: jest.fn().mockImplementation(() =>
      Promise.resolve({ exists: currentEmployer !== null, data: () => currentEmployer })
    ),
  };

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
        return { doc: jest.fn().mockReturnValue(employerDocRef) };
      }
      if (name === 'loans') {
        // Tagged so the transaction mock's `set()` below can tell the loan
        // document apart from its `underwritingDetail/detail` subcollection
        // doc — both are written inside the same transaction (E5c).
        const loanDocRef = {
          id: 'new-loan-id',
          _kind: 'loanDocRef' as const,
          collection: jest.fn().mockImplementation((subName: string) => {
            if (subName !== 'underwritingDetail') throw new Error(`Unexpected subcollection: ${subName}`);
            return {
              doc: jest.fn().mockReturnValue({ _kind: 'underwritingDetailDocRef' as const }),
            };
          }),
        };
        return { ...loansQuery, doc: jest.fn().mockReturnValue(loanDocRef) };
      }
      if (name === 'audit_log') {
        return auditCollection;
      }
      if (name === 'review_queue') {
        // Only ever written to via `tx.set()` (D1's ML-outage manual-review
        // routing) — never read in these tests, so a bare tagged ref is
        // enough for the transaction mock's `set()` below to record it.
        return { doc: jest.fn().mockReturnValue({ _kind: 'reviewQueueDocRef' as const }) };
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
    runTransaction: jest.fn(
      async (
        fn: (txn: { get: jest.Mock; update: jest.Mock; set: jest.Mock }) => Promise<void>
      ) => {
        const txn = {
          get: jest.fn((refOrQuery: { _kind?: string } | undefined) => {
            if (refOrQuery?._kind === 'employerDocRef') {
              return Promise.resolve({ exists: currentEmployer !== null, data: () => currentEmployer });
            }
            if (refOrQuery?._kind === 'employerActiveLoansCountQuery') {
              return Promise.resolve({ data: () => ({ count: activeEmployerLoansCount }) });
            }
            throw new Error('Mock tx.get() called with an unrecognized ref/query');
          }),
          update: jest.fn((ref: { _kind?: string }, data: Record<string, unknown>) => {
            if (ref?._kind === 'employerDocRef') currentEmployer = { ...(currentEmployer ?? {}), ...data };
            transactionCalls.push({ op: 'update', data });
          }),
          set: jest.fn((ref: { _kind?: string }, data: unknown) =>
            transactionCalls.push({ op: 'set', ref: ref?._kind, data })
          ),
        };
        await fn(txn);
        return transactionCalls;
      }
    ),
    _transactionCalls: transactionCalls,
    _auditWrites: auditWrites,
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
    delete process.env['ML_SERVICE_URL'];
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

  // The quote also has to say WHEN the money comes out, and that date is
  // per-borrower (their payroll cadence), not per-config. It ships on this
  // payload so it shares the prices' single loading/error state.
  describe('getLoanConfig deduction date (#424 / #431)', () => {
    const importGetLoanConfig = async () => {
      const { getLoanConfig } = await import('../index');
      return getLoanConfig as unknown as (req: { auth?: unknown; data: unknown }) => Promise<{
        estimatedDeductionDate: string;
        payFrequency: string;
        payFrequencySource: string;
      }>;
    };

    it('derives the date from the borrower record when it carries a cadence', async () => {
      mockDb = buildMockDb({ employee: { ...mockEmployee, payFrequency: 'weekly' } });
      const fn = await importGetLoanConfig();

      const config = await fn({ auth, data: {} });

      expect(config.payFrequency).toBe('weekly');
      expect(config.payFrequencySource).toBe('employee_record');
      expect(new Date(config.estimatedDeductionDate).getDay()).toBe(1); // next Monday
    });

    it('marks the date as assumed when the borrower record has no cadence', async () => {
      // mockEmployee deliberately has no payFrequency — the state most real
      // borrower records are in. The date must still be served (the quote
      // cannot go blank) but must be labelled so the UI can render it with
      // less confidence than a known one.
      const fn = await importGetLoanConfig();

      const config = await fn({ auth, data: {} });

      expect(config.payFrequencySource).toBe('default_monthly');
      expect(config.payFrequency).toBe('monthly');
      expect(Number.isNaN(Date.parse(config.estimatedDeductionDate))).toBe(false);
    });

    it('never returns a deduction date in the past', async () => {
      const fn = await importGetLoanConfig();

      const config = await fn({ auth, data: {} });

      // A date that has already passed would read as "we took it already".
      expect(new Date(config.estimatedDeductionDate).getTime()).toBeGreaterThan(
        Date.now() - 24 * 60 * 60 * 1000
      );
    });

    it('still serves prices when the deduction date cannot be personalised', async () => {
      mockDb = buildMockDb({ employee: null });
      const fn = await importGetLoanConfig();

      const config = (await fn({ auth, data: {} })) as unknown as Record<string, unknown>;

      expect(config['feeRate']).toBe(0.3);
      expect(config['payFrequencySource']).toBe('default_monthly');
    });
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

    // Filtered to the loan doc specifically (`ref === 'loanDocRef'`), not just
    // `op === 'set'`: with ML_SERVICE_URL unset (as in every test in this
    // file by default) both requests also fall open into `under_review` and
    // each writes a `review_queue` doc in the same transaction (D1), which is
    // also a `set` and would otherwise double this count.
    const loanWrites = mockDb._transactionCalls.filter(
      (c) => c.op === 'set' && c.ref === 'loanDocRef'
    ) as Array<{
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
      const loanWrite = mockDb._transactionCalls.find((c) => c.ref === 'loanDocRef') as
        | { data: Record<string, unknown> }
        | undefined;
      expect(loanWrite).toBeDefined();
      return loanWrite!.data;
    }

    // The breakdown (E5c) does NOT go on the loan document — that document is
    // readable by the loan's own borrower and by the employer admin
    // (firestore.rules `isOwner`/`isEmployerAdminOf`), and every condition
    // carries the applicant's actual bureau score, LTI, RiskSeal fraud score
    // and ML default probability alongside the bound it was tested against.
    // It is written to `loans/{loanId}/underwritingDetail/detail` instead,
    // which firestore.rules gates `isOps()`-only. `getLoanWrite` above must
    // never see it; this reads the OTHER `tx.set()` call.
    function getUnderwritingDetailWrite() {
      const write = mockDb._transactionCalls.find((c) => c.ref === 'underwritingDetailDocRef') as
        | { data: Record<string, unknown> }
        | undefined;
      return write?.data;
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
      // The raw breakdown must NOT be reachable from the loan doc a borrower
      // can read directly.
      expect(loanData['underwritingDecision']).toBeUndefined();

      expect(getUnderwritingDetailWrite()).toMatchObject({
        decision: 'approved',
        reason: null,
        allPass: true,
        conditions: sampleConditions,
      });
    });

    it('persists condition provenance (source field) verbatim, since #458', async () => {
      const conditionsWithProvenance = [
        { name: 'age_range', pass: true, value: 34, required: '18-65', source: 'read' },
        { name: 'bureau_score', pass: false, value: 500, required: '> 600', source: 'assumed' },
      ];
      await mockUnderwritingResponse(
        uwResponse(
          {
            decision: 'approved',
            reason: null,
            correlationId: 'uw-789',
            lastStage: 'stage3',
          },
          { conditions: conditionsWithProvenance, allPass: true },
        ),
      );

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
      await fn({ auth, data: realClientPayload });

      const persisted = getUnderwritingDetailWrite()!;
      expect(persisted['conditions']).toEqual(conditionsWithProvenance);
      const persistedConditions = persisted['conditions'] as Array<Record<string, unknown>>;
      expect(persistedConditions[0]['source']).toBe('read');
      expect(persistedConditions[1]['source']).toBe('assumed');
    });

    // The exact shape stage3-autoapprove.js's `evaluateAutoApprove` produces
    // for all 12 gating conditions (ADR-006 added ids 11/12 on top of the
    // original 10) — id, name, pass, value, required (the bound), source.
    // Every field must survive the write untouched: this is the "why was
    // this decided this way" data the whole feature exists to make readable.
    const allTwelveConditions = [
      { id: 1, name: 'employer_tier', pass: true, value: 1, required: '1-2', source: 'read' },
      { id: 2, name: 'imss_tenure', pass: true, value: 24, required: '> 6 months', source: 'read' },
      { id: 3, name: 'bureau_score', pass: true, value: 650, required: '> 600', source: 'read' },
      { id: 4, name: 'lti', pass: true, value: 12, required: '<= 25%', source: 'read' },
      { id: 5, name: 'no_competitor_loans', pass: true, value: 0, required: '0', source: 'read' },
      { id: 6, name: 'riskseal_score', pass: true, value: 85, required: '> 60', source: 'read' },
      { id: 7, name: 'sector_safe', pass: true, value: 'bajo', required: 'not alto', source: 'read' },
      { id: 8, name: 'ml_default_prob', pass: true, value: 0.05, required: '< 0.15', source: 'read' },
      { id: 9, name: 'no_active_defaults', pass: true, value: 0, required: '0', source: 'read' },
      { id: 10, name: 'age_range', pass: true, value: 34, required: '18-65', source: 'read' },
      { id: 11, name: 'dias_atraso_zero', pass: true, value: 0, required: '0', source: 'read' },
      { id: 12, name: 'cartera_vencida_false', pass: true, value: false, required: 'false', source: 'read' },
    ];

    it('round-trips all 12 auto-approve conditions with id, value, bound and source intact', async () => {
      await mockUnderwritingResponse(
        uwResponse(
          { decision: 'approved', reason: null, correlationId: 'uw-full', lastStage: 'stage3' },
          { conditions: allTwelveConditions, allPass: true },
        ),
      );

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
      await fn({ auth, data: realClientPayload });

      const persisted = getUnderwritingDetailWrite()!;
      expect(persisted['conditions']).toEqual(allTwelveConditions);
      expect((persisted['conditions'] as unknown[])).toHaveLength(12);
      // Not just "the array survived" — every id/value/required/source pair
      // must be individually intact, since ops reads this per-condition.
      allTwelveConditions.forEach((expected, i) => {
        const actual = (persisted['conditions'] as Array<Record<string, unknown>>)[i];
        expect(actual['id']).toBe(expected.id);
        expect(actual['value']).toBe(expected.value);
        expect(actual['required']).toBe(expected.required);
        expect(actual['source']).toBe(expected.source);
      });
    });

    it('creates the loan with no breakdown, and does not throw, when underwriting is unreachable', async () => {
      await mockUnderwritingResponse(null);

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<{ loanId: string }>;
      const result = await fn({ auth, data: realClientPayload });

      expect(result.loanId).toBeTruthy();
      const loanData = getLoanWrite();
      // `mockUnderwritingResponse(null)` makes node-fetch reject for every
      // URL, so the inline ML gate (always attempted regardless of the
      // 6-stage pipeline's availability) fails too. Pre-D1 this silently
      // fell through to 'pending' — a loan nobody, human or model, had
      // assessed, eligible for the same approval → disbursement path as a
      // fully-underwritten one. It must now fail closed to 'under_review'.
      expect(loanData['status']).toBe('under_review');
      expect(loanData['underwritingDecision']).toBeUndefined();
      expect(getUnderwritingDetailWrite()).toBeUndefined();
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

      const persisted = getUnderwritingDetailWrite()!;
      expect(persisted).toMatchObject({
        decision: 'rejected',
        reason: 'FULL_KYC_REQUIRED',
        allPass: false,
      });
      expect((persisted['conditions'] as unknown[])).toHaveLength(3);
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
      expect(getUnderwritingDetailWrite()).toBeUndefined();
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

      const persisted = getUnderwritingDetailWrite()!;
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

      const persisted = getUnderwritingDetailWrite()!;
      expect(persisted).toBeDefined();
      expect(persisted['allPass']).toBe(true);
      expect(persisted['conditions']).toHaveLength(2);
    });
  });

  // Both inline-ML gates throw BEFORE db.runTransaction() writes the loan and
  // before the `loan.requested` audit row. A denied applicant therefore used to
  // leave nothing behind at all — no loan doc, no audit row, no review_queue
  // entry — so nobody in the ops console could see that the denial happened,
  // why, or to whom. These pin the record each denial path now writes.
  describe('inline ML denial leaves an auditable record', () => {
    const ML_URL = 'https://ml.internal';
    const UW_URL = 'https://uw.internal';

    /**
     * Routes the shared node-fetch mock by URL: the 6-stage pipeline
     * (`/underwrite`) and the inline single-number ML gate
     * (`/underwrite/employee`) are two different services reached through the
     * same mocked module. `uw: null` means the pipeline is unreachable, which
     * is what leaves `uwDecision` null.
     */
    async function mockServices({
      uw,
      ml,
    }: {
      uw: Record<string, unknown> | null;
      ml: Record<string, unknown>;
    }) {
      process.env['ML_SERVICE_URL'] = ML_URL;
      process.env['INTERNAL_SECRET'] = 'test-secret';
      if (uw !== null) process.env['UNDERWRITING_SERVICE_URL'] = UW_URL;

      const fetchModule = (await import('node-fetch')).default as unknown as jest.Mock;
      fetchModule.mockImplementation(async (url: string) => {
        if (url.startsWith(ML_URL)) return { ok: true, json: async () => ml };
        if (uw === null) throw new Error('UW service unavailable');
        return { ok: true, json: async () => uw };
      });
    }

    const fraudulentMl = {
      decisionId: 'ml-fraud-1',
      credit_score: 610,
      default_probability: 0.1,
      fraud: { is_fraud: true, fraud_score: 0.93 },
    };

    const highRiskMl = {
      decisionId: 'ml-risk-1',
      credit_score: 480,
      default_probability: 0.72,
      fraud: { is_fraud: false, fraud_score: 0.02 },
    };

    async function callRequestLoan() {
      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
      return fn({ auth, data: realClientPayload });
    }

    function denialRecord() {
      const record = mockDb._auditWrites.find((w) => w['action'] === 'loan.request_denied');
      expect(record).toBeDefined();
      return { doc: record!, meta: record!['meta'] as Record<string, unknown> };
    }

    it('records the fraud-flag denial, naming the gate and the applicant', async () => {
      await mockServices({ uw: null, ml: fraudulentMl });

      await expect(callRequestLoan()).rejects.toMatchObject({
        code: 'permission-denied',
        message: 'Solicitud marcada como sospechosa',
      });

      const { doc, meta } = denialRecord();
      expect(doc['actorUid']).toBe('user-123');
      expect(doc['targetCollection']).toBe('loan');
      expect(meta['gate']).toBe('fraud_flag');
      expect(meta['deniedBy']).toBe('inline_ml_gate');
      expect(meta['amount']).toBe(1000);
      expect(meta['value']).toBe(true);
      expect(meta['bound']).toBe('is_fraud === true');
      // The pipeline never answered, so there is no verdict to have overridden.
      expect(meta['uwDecision']).toBeNull();
      expect(meta['overrodePipelineDecision']).toBe(false);
    });

    it('records the default-probability denial with the tripping value and the bound it was compared against', async () => {
      await mockServices({ uw: null, ml: highRiskMl });

      await expect(callRequestLoan()).rejects.toMatchObject({
        code: 'failed-precondition',
        message: 'No es posible aprobar tu solicitud en este momento',
      });

      const { meta } = denialRecord();
      expect(meta['gate']).toBe('default_probability');
      // Without both halves the record cannot be reviewed: 0.72 means nothing
      // unless the row also says what it was measured against.
      expect(meta['value']).toBe(0.72);
      expect(meta['bound']).toBe(0.4);
      expect(meta['comparison']).toBe('> 0.4');
      expect(meta['mlDecisionId']).toBe('ml-risk-1');
    });

    it('leaves no loan document behind — the audit row is the only trace, and it exists', async () => {
      await mockServices({ uw: null, ml: highRiskMl });

      await expect(callRequestLoan()).rejects.toMatchObject({ code: 'failed-precondition' });

      // The pre-fix state: no loan, no `loan.requested` row. Half of that is
      // still true and correct — the denial must not create a loan — but the
      // denial itself is now visible.
      expect(mockDb._transactionCalls).toHaveLength(0);
      expect(mockDb._auditWrites.some((w) => w['action'] === 'loan.requested')).toBe(false);
      expect(mockDb._auditWrites.some((w) => w['action'] === 'loan.request_denied')).toBe(true);
    });

    it('records that the inline gate overrode a pipeline verdict of pending_review', async () => {
      // The pipeline said "a human must look at this". The inline single-number
      // gate throws first and turns that into a flat denial the borrower reads
      // as a generic error, so the escalate-to-human outcome never applies.
      // Current behaviour is deliberately unchanged here (that is a credit
      // policy call) — but it stops being silent.
      await mockServices({
        uw: { decision: 'pending_review', reason: null, correlationId: 'uw-override-1', lastStage: 'stage5' },
        ml: highRiskMl,
      });

      await expect(callRequestLoan()).rejects.toMatchObject({ code: 'failed-precondition' });

      const { meta } = denialRecord();
      expect(meta['overrodePipelineDecision']).toBe(true);
      expect(meta['uwDecision']).toBe('pending_review');
      expect(meta['uwCorrelationId']).toBe('uw-override-1');
    });

    it('does not log CURP, RFC or CLABE into the audit record', async () => {
      mockDb = buildMockDb({
        employee: { ...mockEmployee, curp: 'GARJ850101HDFRRN01', rfc: 'GARJ850101ABC', bankClabe: '032180000118359719' },
      });
      await mockServices({ uw: null, ml: highRiskMl });

      await expect(callRequestLoan()).rejects.toMatchObject({ code: 'failed-precondition' });

      const serialised = JSON.stringify(denialRecord().doc);
      expect(serialised).not.toContain('GARJ850101HDFRRN01');
      expect(serialised).not.toContain('GARJ850101ABC');
      expect(serialised).not.toContain('032180000118359719');
    });

    it('a failed audit write does not change the error the borrower receives', async () => {
      // Bookkeeping failing is our problem, not the applicant's. The gate's
      // own error must survive intact rather than becoming an internal error.
      mockDb = buildMockDb({ auditWriteFails: true });
      await mockServices({ uw: null, ml: highRiskMl });

      await expect(callRequestLoan()).rejects.toMatchObject({
        code: 'failed-precondition',
        message: 'No es posible aprobar tu solicitud en este momento',
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to record inline ML denial in audit_log',
        expect.objectContaining({ gate: 'default_probability' })
      );
    });

    it('a failed audit write does not change the fraud-gate error either', async () => {
      mockDb = buildMockDb({ auditWriteFails: true });
      await mockServices({ uw: null, ml: fraudulentMl });

      await expect(callRequestLoan()).rejects.toMatchObject({
        code: 'permission-denied',
        message: 'Solicitud marcada como sospechosa',
      });
    });

    it('still creates the loan, with no denial record, when both gates pass', async () => {
      await mockServices({
        uw: null,
        ml: { decisionId: 'ml-ok-1', credit_score: 720, default_probability: 0.12, fraud: { is_fraud: false } },
      });

      const result = (await callRequestLoan()) as { loanId: string; status: string };

      expect(result.loanId).toBeTruthy();
      expect(result.status).toBe('pending');
      expect(mockDb._auditWrites.some((w) => w['action'] === 'loan.request_denied')).toBe(false);
      expect(mockDb._auditWrites.some((w) => w['action'] === 'loan.requested')).toBe(true);
    });
  });

  // ADR-005 Finding 2 / ADR-007: maxActiveSlots was written and audit-logged
  // but never read as a constraint anywhere. This is the enforcement point.
  describe('employer slot cap (ADR-005 Finding 2 / ADR-007)', () => {
    function slotError() {
      return { code: 'failed-precondition', message: 'EMPLOYER_SLOT_LIMIT_REACHED' };
    }

    it('allows the Nth loan (count one below an admin-set cap)', async () => {
      mockDb = buildMockDb({
        employer: { ...mockEmployer, maxActiveSlots: 2 },
        activeEmployerLoansCount: 1,
      });
      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<{ loanId: string }>;

      const result = await fn({ auth, data: realClientPayload });

      expect(result.loanId).toBeTruthy();
    });

    it('refuses the N+1th loan (count already at the admin-set cap)', async () => {
      mockDb = buildMockDb({
        employer: { ...mockEmployer, maxActiveSlots: 2 },
        activeEmployerLoansCount: 2,
      });
      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;

      await expect(fn({ auth, data: realClientPayload })).rejects.toMatchObject(slotError());
      // The cap must bind before the loan/credit-hold write, not after.
      expect(mockDb._transactionCalls.some((c) => c.op === 'set')).toBe(false);
    });

    it('respects an admin-set cap even when it is lower than the tier default', async () => {
      // maxActiveSlots=1 on a Tier 1 employer (whose tier default would be
      // 10) must still bind at 1 — an explicit admin value always wins over
      // the tier fallback, never the other way around.
      mockDb = buildMockDb({
        employer: { ...mockEmployer, maxActiveSlots: 1, riskTier: 1 },
        activeEmployerLoansCount: 1,
      });
      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;

      await expect(fn({ auth, data: realClientPayload })).rejects.toMatchObject(slotError());
    });

    it('does not tell the borrower they were declined for credit', async () => {
      mockDb = buildMockDb({
        employer: { ...mockEmployer, maxActiveSlots: 1 },
        activeEmployerLoansCount: 1,
      });
      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;

      const error = (await fn({ auth, data: realClientPayload }).catch((e: unknown) => e)) as Error;
      expect(error.message).not.toMatch(/crédito|riesgo|sospechosa/i);
      expect(error.message).toBe('EMPLOYER_SLOT_LIMIT_REACHED');
    });

    describe('seeding maxActiveSlots when it has never been set', () => {
      it('falls back to the Tier 1 initial slot count (10) for a Tier 1 employer', async () => {
        mockDb = buildMockDb({
          employer: { ...mockEmployer, riskTier: 1 }, // no maxActiveSlots
          activeEmployerLoansCount: 9,
        });
        const { requestLoan } = await import('../index');
        const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<{ loanId: string }>;

        const result = await fn({ auth, data: realClientPayload });
        expect(result.loanId).toBeTruthy();

        const seedWrite = mockDb._transactionCalls.find(
          (c) => c.op === 'update' && (c.data as Record<string, unknown>)?.['maxActiveSlots'] !== undefined
        );
        expect(seedWrite).toMatchObject({ op: 'update', data: { maxActiveSlots: 10 } });
      });

      it('falls back to the Tier 2 initial slot count (3) for a Tier 2 employer', async () => {
        mockDb = buildMockDb({
          employer: { ...mockEmployer, riskTier: 2 },
          activeEmployerLoansCount: 2,
        });
        const { requestLoan } = await import('../index');
        const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<{ loanId: string }>;

        const result = await fn({ auth, data: realClientPayload });
        expect(result.loanId).toBeTruthy();

        const seedWrite = mockDb._transactionCalls.find(
          (c) => c.op === 'update' && (c.data as Record<string, unknown>)?.['maxActiveSlots'] !== undefined
        );
        expect(seedWrite).toMatchObject({ op: 'update', data: { maxActiveSlots: 3 } });
      });

      it('defaults an employer with NO riskTier at all to the Tier 2 count (3), not zero', async () => {
        // The most common real state today (ADR-005 Finding 2): approveEmployer.ts
        // never sets riskTier, so this is the fallback nearly the entire
        // existing employer book hits on first deploy of this change.
        mockDb = buildMockDb({
          employer: { ...mockEmployer }, // no maxActiveSlots, no riskTier
          activeEmployerLoansCount: 2,
        });
        const { requestLoan } = await import('../index');
        const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<{ loanId: string }>;

        const result = await fn({ auth, data: realClientPayload });
        expect(result.loanId).toBeTruthy();

        const seedWrite = mockDb._transactionCalls.find(
          (c) => c.op === 'update' && (c.data as Record<string, unknown>)?.['maxActiveSlots'] !== undefined
        );
        expect(seedWrite).toMatchObject({ op: 'update', data: { maxActiveSlots: 3 } });
      });

      it('fails closed to zero for a riskTier that is an actual due-diligence rejection (3), not the "never scored" default', async () => {
        // Distinguishes "we have no idea" (defaults to Tier 2, above) from
        // "we know, and it's bad" (0) — an explicit non-1/2 riskTier is a
        // real signal, not a data gap, and must not be softened.
        mockDb = buildMockDb({
          employer: { ...mockEmployer, riskTier: 3 },
          activeEmployerLoansCount: 0,
        });
        const { requestLoan } = await import('../index');
        const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;

        await expect(fn({ auth, data: realClientPayload })).rejects.toMatchObject(slotError());
      });

      it('does not overwrite an already-seeded/admin-set maxActiveSlots', async () => {
        mockDb = buildMockDb({
          employer: { ...mockEmployer, maxActiveSlots: 7, riskTier: 1 },
          activeEmployerLoansCount: 0,
        });
        const { requestLoan } = await import('../index');
        const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;

        await fn({ auth, data: realClientPayload });

        const seedWrite = mockDb._transactionCalls.find(
          (c) => c.op === 'update' && (c.data as Record<string, unknown>)?.['maxActiveSlots'] !== undefined
        );
        expect(seedWrite).toBeUndefined();
      });
    });
  });

  describe('ADR-008: due-diligence maxActiveSlots wiring', () => {
    const UW_URL = 'https://uw.internal';

    async function mockUnderwritingResponseWithEmployerB(maxActiveSlots: number | undefined) {
      process.env['UNDERWRITING_SERVICE_URL'] = UW_URL;
      process.env['INTERNAL_SECRET'] = 'test-secret';
      const fetchModule = (await import('node-fetch')).default as unknown as jest.Mock;
      fetchModule.mockResolvedValue({
        ok: true,
        json: async () => ({
          decision: 'approved',
          reason: null,
          correlationId: 'uw-adr008',
          lastStage: 'stage3',
          stages: {
            employerB:
              maxActiveSlots === undefined
                ? { pass: true, tier: 1, score: 85 }
                : { pass: true, tier: 1, score: 85, maxActiveSlots },
          },
        }),
      });
    }

    function capWrites() {
      return mockDb._transactionCalls.filter(
        (c) => c.op === 'update' && (c.data as Record<string, unknown>)?.['maxActiveSlotsSource'] !== undefined
      );
    }

    it('writes employer-b\'s computed capacity into maxActiveSlots, tagged due_diligence', async () => {
      mockDb = buildMockDb({ employer: { ...mockEmployer, maxActiveSlots: 3 } });
      await mockUnderwritingResponseWithEmployerB(10);

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<{ loanId: string }>;
      const result = await fn({ auth, data: realClientPayload });
      expect(result.loanId).toBeTruthy();

      const writes = capWrites();
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        data: { maxActiveSlots: 10, maxActiveSlotsSource: 'due_diligence' },
      });
    });

    it('audit-logs the before/after of the due-diligence cap write', async () => {
      mockDb = buildMockDb({ employer: { ...mockEmployer, maxActiveSlots: 3 } });
      await mockUnderwritingResponseWithEmployerB(10);

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
      await fn({ auth, data: realClientPayload });

      const entry = mockDb._auditWrites.find((w) => w['action'] === 'employer.due_diligence_cap');
      expect(entry).toMatchObject({
        action: 'employer.due_diligence_cap',
        actorUid: auth.uid,
        targetId: mockEmployee.employerId,
        before: { maxActiveSlots: 3, maxActiveSlotsSource: null },
        after: { maxActiveSlots: 10, maxActiveSlotsSource: 'due_diligence' },
      });
    });

    it('never overwrites an ops-approved override, even when a MISSING source would still be writable', async () => {
      mockDb = buildMockDb({
        employer: { ...mockEmployer, maxActiveSlots: 50, maxActiveSlotsSource: 'ops_override' },
      });
      await mockUnderwritingResponseWithEmployerB(10);

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
      await fn({ auth, data: realClientPayload });

      expect(capWrites()).toHaveLength(0);
      expect(
        mockDb._auditWrites.find((w) => w['action'] === 'employer.due_diligence_cap')
      ).toBeUndefined();
    });

    it('treats a MISSING source as writable, not as an override', async () => {
      mockDb = buildMockDb({ employer: { ...mockEmployer } }); // no maxActiveSlots, no source
      await mockUnderwritingResponseWithEmployerB(10);

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
      await fn({ auth, data: realClientPayload });

      expect(capWrites()).toHaveLength(1);
    });

    it('does not write when employer-b never returned a maxActiveSlots number', async () => {
      mockDb = buildMockDb({ employer: { ...mockEmployer, maxActiveSlots: 3 } });
      await mockUnderwritingResponseWithEmployerB(undefined);

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
      await fn({ auth, data: realClientPayload });

      expect(capWrites()).toHaveLength(0);
    });

    it('never blocks loan creation when the due-diligence cap write itself fails', async () => {
      mockDb = buildMockDb({ employer: { ...mockEmployer, maxActiveSlots: 3 } });
      await mockUnderwritingResponseWithEmployerB(10);
      // The ADR-008 cap write runs its own, separate transaction before the
      // loan-creation transaction below it — fail only that first call.
      mockDb.runTransaction.mockImplementationOnce(async () => {
        throw new Error('employer doc transaction unavailable');
      });

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<{ loanId: string }>;
      const result = await fn({ auth, data: realClientPayload });

      expect(result.loanId).toBeTruthy();
    });
  });

  // ADR-009: the slot ACCRUAL ledger, the half ADR-007 left unbuilt.
  //
  // Measured before writing these: the employer object requestLoan sent to
  // the underwriting service was `{rfc, companyName}` and nothing else, so
  // employer-b's `employer.maxActiveSlots` was always undefined in
  // production, its `isReturning` branch was never taken, and
  // `autoScaleTier1` — ADR-007's entire ratified growth rule — was
  // unreachable outside its own unit tests. Every Tier-1 employer was
  // re-granted a flat 10 on every loan request, forever.
  describe('ADR-009: slot accrual ledger wiring', () => {
    const UW_URL = 'https://uw.internal';

    async function mockUwWithEmployerB(employerB: Record<string, unknown>) {
      process.env['UNDERWRITING_SERVICE_URL'] = UW_URL;
      process.env['INTERNAL_SECRET'] = 'test-secret';
      const fetchModule = (await import('node-fetch')).default as unknown as jest.Mock;
      fetchModule.mockResolvedValue({
        ok: true,
        json: async () => ({
          decision: 'approved',
          reason: null,
          correlationId: 'uw-adr009',
          lastStage: 'stage3',
          stages: { employerB },
        }),
      });
      return fetchModule;
    }

    async function uwEmployerPayload(fetchModule: jest.Mock): Promise<Record<string, unknown>> {
      const call = fetchModule.mock.calls.find((c) => String(c[0]).includes('/underwrite'));
      expect(call).toBeDefined();
      return JSON.parse((call![1] as { body: string }).body)['employer'];
    }

    function ledgerWrites() {
      return mockDb._transactionCalls.filter(
        (c) => c.op === 'update' && (c.data as Record<string, unknown>)?.['tier'] !== undefined
      );
    }

    it('sends the stored slot ledger to the underwriting service', async () => {
      mockDb = buildMockDb({
        employer: {
          ...mockEmployer,
          tier: 1,
          maxActiveSlots: 30,
          cleanPayrollCycles: 7,
          cleanPayrollCyclesSinceReview: 2,
        },
      });
      const fetchModule = await mockUwWithEmployerB({ pass: true, tier: 1, score: 85, maxActiveSlots: 50 });

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
      await fn({ auth, data: realClientPayload });

      expect(await uwEmployerPayload(fetchModule)).toMatchObject({
        tier: 1,
        maxActiveSlots: 30,
        cleanPayrollCycles: 7,
        cleanPayrollCyclesSinceReview: 2,
      });
    });

    it('defaults a never-scored employer\'s ledger to zeros, never undefined', async () => {
      mockDb = buildMockDb({ employer: { ...mockEmployer } });
      const fetchModule = await mockUwWithEmployerB({ pass: true, tier: 1, score: 85, maxActiveSlots: 10 });

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
      await fn({ auth, data: realClientPayload });

      const payload = await uwEmployerPayload(fetchModule);
      expect(payload).toMatchObject({
        tier: null,
        maxActiveSlots: 0,
        cleanPayrollCycles: 0,
        cleanPayrollCyclesSinceReview: 0,
      });
    });

    // Sending employerId would activate employer-b's OWN Firestore write,
    // making the underwriting service a second concurrent writer of
    // maxActiveSlots racing the block in requestLoan. #487 is the writer.
    it('does not send employerId, keeping requestLoan the single cap writer', async () => {
      mockDb = buildMockDb({ employer: { ...mockEmployer, maxActiveSlots: 10 } });
      const fetchModule = await mockUwWithEmployerB({ pass: true, tier: 1, score: 85, maxActiveSlots: 10 });

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
      await fn({ auth, data: realClientPayload });

      expect(await uwEmployerPayload(fetchModule)).not.toHaveProperty('employerId');
    });

    it('persists the due-diligence tier alongside the cap', async () => {
      mockDb = buildMockDb({ employer: { ...mockEmployer, maxActiveSlots: 10 } });
      await mockUwWithEmployerB({ pass: true, tier: 1, score: 85, maxActiveSlots: 20 });

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
      await fn({ auth, data: realClientPayload });

      expect(ledgerWrites()).toHaveLength(1);
      expect(ledgerWrites()[0]).toMatchObject({
        data: { tier: 1, maxActiveSlots: 20, maxActiveSlotsSource: 'due_diligence' },
      });
    });

    // ops_override means ops owns the NUMBER, not the score behind it —
    // the same split employer-b's own transaction makes.
    it('refreshes the tier under an ops override while leaving the cap frozen', async () => {
      mockDb = buildMockDb({
        employer: { ...mockEmployer, maxActiveSlots: 50, maxActiveSlotsSource: 'ops_override', tier: 1 },
      });
      await mockUwWithEmployerB({ pass: true, tier: 2, score: 55, maxActiveSlots: 3 });

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
      await fn({ auth, data: realClientPayload });

      const writes = ledgerWrites();
      expect(writes).toHaveLength(1);
      expect(writes[0]!.data).toEqual({ tier: 2 });
      expect((writes[0]!.data as Record<string, unknown>)['maxActiveSlots']).toBeUndefined();
    });

    // ADR-007 forfeits earned cycles beyond the 2-increment cap. A forfeit
    // that leaves no trace is indistinguishable from a cycle never earned.
    it('audit-logs the credited increments and the forfeited cycles', async () => {
      mockDb = buildMockDb({ employer: { ...mockEmployer, maxActiveSlots: 30 } });
      await mockUwWithEmployerB({
        pass: true,
        tier: 1,
        score: 85,
        maxActiveSlots: 50,
        slotGrowth: {
          cyclesConsidered: 5,
          incrementsCredited: 2,
          cyclesForfeited: 3,
          slotsBefore: 30,
          slotsAfter: 50,
        },
      });

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
      await fn({ auth, data: realClientPayload });

      const entry = mockDb._auditWrites.find((w) => w['action'] === 'employer.due_diligence_cap');
      expect(entry).toMatchObject({
        meta: { slotGrowth: { incrementsCredited: 2, cyclesForfeited: 3 } },
      });
    });

    it('records a null slotGrowth when the review granted a fresh cap rather than an increment', async () => {
      mockDb = buildMockDb({ employer: { ...mockEmployer } });
      await mockUwWithEmployerB({ pass: true, tier: 1, score: 85, maxActiveSlots: 10 });

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
      await fn({ auth, data: realClientPayload });

      const entry = mockDb._auditWrites.find((w) => w['action'] === 'employer.due_diligence_cap');
      expect(entry).toMatchObject({ meta: { slotGrowth: null } });
    });
  });

  // D2: the inline ML gate's payload used to hardcode `existingLoans: 0` and
  // `requestsLastHour: 0`, which meant the scorer's -30 existing-debt penalty
  // and its `high_frequency` fraud flag could never fire for ANY applicant —
  // the gate ran, returned a verdict, and two of its inputs were constants.
  // These assert the real counts reach the service, so re-hardcoding either
  // one goes red.
  describe('inline ML gate is fed real borrower history, not hardcoded zeros', () => {
    const ML_URL = 'https://ml.internal';

    async function mockMlGate(): Promise<jest.Mock> {
      process.env['ML_SERVICE_URL'] = ML_URL;
      process.env['INTERNAL_SECRET'] = 'test-secret';
      const fetchModule = (await import('node-fetch')).default as unknown as jest.Mock;
      // No fraud, no default — the gate passes, so the assertion is purely
      // about what was SENT, not about the verdict.
      fetchModule.mockResolvedValue({
        ok: true,
        json: async () => ({ fraud: { is_fraud: false }, default_probability: 0.1 }),
      });
      return fetchModule;
    }

    async function mlPayload(fetchModule: jest.Mock): Promise<Record<string, unknown>> {
      const call = fetchModule.mock.calls.find((c) => String(c[0]).includes('/underwrite/employee'));
      expect(call).toBeDefined();
      return JSON.parse((call![1] as { body: string }).body) as Record<string, unknown>;
    }

    it("sends the borrower's real outstanding-loan count, not 0", async () => {
      // 2 OUTSTANDING_STATUSES loans (e.g. disbursed/overdue) — none of which
      // are ACTIVE_LOAN_STATUSES, so the duplicate-application guard upstream
      // still lets this request through to the gate. That is precisely the
      // borrower this signal exists to catch: already owing money, still
      // eligible to apply.
      mockDb = buildMockDb({ outstandingLoansCount: 2 });
      const fetchModule = await mockMlGate();

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
      await fn({ auth, data: realClientPayload });

      expect(await mlPayload(fetchModule)).toMatchObject({ existingLoans: 2 });
    });

    it("sends the borrower's real last-hour request count, not 0", async () => {
      mockDb = buildMockDb({ recentRequestsCount: 7 });
      const fetchModule = await mockMlGate();

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
      await fn({ auth, data: realClientPayload });

      expect(await mlPayload(fetchModule)).toMatchObject({ requestsLastHour: 7 });
    });

    it('still sends 0 for a genuinely first-time, debt-free borrower', async () => {
      // The counts must be MEASURED, not merely nonzero — a fix that always
      // reported a positive number would pass the two tests above while
      // being just as wrong.
      mockDb = buildMockDb({ outstandingLoansCount: 0, recentRequestsCount: 0 });
      const fetchModule = await mockMlGate();

      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
      await fn({ auth, data: realClientPayload });

      expect(await mlPayload(fetchModule)).toMatchObject({ existingLoans: 0, requestsLastHour: 0 });
    });
  });

  // The employer's own enrolment control, which was saveable and enforced
  // nowhere. `employees/{uid}.employerId` is written by the client at
  // registration and nothing has ever cross-checked it, so knowing an
  // employer's join code was enough to enrol under that employer, occupy one of
  // its maxActiveSlots with a 'pending' loan, and — repeated across throwaway
  // accounts until the cap is full — lock every real employee of that company
  // out of the product. curpConfig is the control the employer already has for
  // this; these tests are the enforcement point.
  describe('employer CURP allowlist enrolment gate', () => {
    const ON_LIST = 'GARJ900101HDFRRN01'; // prefix GARJ
    const OFF_LIST = 'ZZZZ900101HDFRRN01'; // prefix ZZZZ

    function allowlistEmployer(prefixes: string[]) {
      return { ...mockEmployer, curpConfig: { mode: 'allowlist', prefixes } };
    }

    function enrolmentError() {
      return { code: 'permission-denied', message: 'EMPLOYER_ENROLLMENT_NOT_PERMITTED' };
    }

    it('refuses a borrower whose CURP prefix is not on the employer allowlist', async () => {
      mockDb = buildMockDb({
        employee: { ...mockEmployee, curp: OFF_LIST },
        employer: allowlistEmployer(['GARJ']),
      });
      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;

      await expect(fn({ auth, data: realClientPayload })).rejects.toMatchObject(enrolmentError());
    });

    it('refuses BEFORE the loan is written and before the credit hold is taken', async () => {
      mockDb = buildMockDb({
        employee: { ...mockEmployee, curp: OFF_LIST },
        employer: allowlistEmployer(['GARJ']),
      });
      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;

      await expect(fn({ auth, data: realClientPayload })).rejects.toMatchObject(enrolmentError());
      // A refused enrolment must leave no trace on the employer's book: no loan
      // document, and no slot occupied. Occupying one is the whole harm.
      expect(mockDb._transactionCalls).toHaveLength(0);
    });

    it('does not disclose which prefixes would have been admitted', async () => {
      mockDb = buildMockDb({
        employee: { ...mockEmployee, curp: OFF_LIST },
        employer: allowlistEmployer(['GARJ', 'MAAB']),
      });
      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;

      const error = (await fn({ auth, data: realClientPayload }).catch((e: unknown) => e)) as Error;
      expect(error.message).not.toMatch(/GARJ|MAAB/);
      // Nor may it read as a credit decline — this is the employer's decision
      // about this person, not an underwriting verdict.
      expect(error.message).not.toMatch(/crédito|riesgo|sospechosa/i);
      expect(error.message).toBe('EMPLOYER_ENROLLMENT_NOT_PERMITTED');
    });

    it('admits a borrower whose CURP prefix is on the allowlist', async () => {
      mockDb = buildMockDb({
        employee: { ...mockEmployee, curp: ON_LIST },
        employer: allowlistEmployer(['GARJ']),
      });
      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<{ loanId: string }>;

      expect((await fn({ auth, data: realClientPayload })).loanId).toBeTruthy();
    });

    it('matches the allowlist case-insensitively on both sides', async () => {
      mockDb = buildMockDb({
        employee: { ...mockEmployee, curp: ON_LIST.toLowerCase() },
        employer: allowlistEmployer(['garj']),
      });
      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<{ loanId: string }>;

      expect((await fn({ auth, data: realClientPayload })).loanId).toBeTruthy();
    });

    it('refuses a borrower carrying no CURP at all when an allowlist is in force', async () => {
      // The borrower supplies their own employee document. Admitting on a
      // missing field would make the control evadable by omitting one.
      mockDb = buildMockDb({
        employee: { ...mockEmployee },
        employer: allowlistEmployer(['GARJ']),
      });
      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<unknown>;

      await expect(fn({ auth, data: realClientPayload })).rejects.toMatchObject(enrolmentError());
    });

    it('admits everyone in open mode — the default, so no existing borrower is newly refused', async () => {
      mockDb = buildMockDb({
        employee: { ...mockEmployee, curp: OFF_LIST },
        employer: { ...mockEmployer, curpConfig: { mode: 'open', prefixes: ['GARJ'] } },
      });
      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<{ loanId: string }>;

      expect((await fn({ auth, data: realClientPayload })).loanId).toBeTruthy();
    });

    it('admits everyone when the employer has no curpConfig at all', async () => {
      mockDb = buildMockDb({
        employee: { ...mockEmployee, curp: OFF_LIST },
        employer: { ...mockEmployer },
      });
      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<{ loanId: string }>;

      expect((await fn({ auth, data: realClientPayload })).loanId).toBeTruthy();
    });

    it('treats a stored allowlist with no usable prefixes as unconfigured, and says so', async () => {
      // Deliberately NOT deny-everyone: that combination was saveable while
      // curpConfig was inert, so reading it strictly would take a live
      // employer's whole workforce off the product on the enforcing deploy.
      mockDb = buildMockDb({
        employee: { ...mockEmployee, curp: OFF_LIST },
        employer: allowlistEmployer(['', 'AB']),
      });
      const { requestLoan } = await import('../index');
      const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<{ loanId: string }>;

      expect((await fn({ auth, data: realClientPayload })).loanId).toBeTruthy();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('no usable prefixes'),
        expect.objectContaining({ uid: auth.uid })
      );
    });
  });

  // The other half of the empty-allowlist decision: it stops being storable, so
  // the lenient branch above only ever covers documents already on disk.
  describe('updateEmployerCurpConfig', () => {
    const employerAuth = { uid: 'employer-abc', token: { role: 'employer_admin' } };

    it('refuses to save allowlist mode with no valid prefixes', async () => {
      const { updateEmployerCurpConfig } = await import('../index');
      const fn = updateEmployerCurpConfig as unknown as (
        req: { auth?: unknown; data: unknown }
      ) => Promise<unknown>;

      await expect(
        fn({ auth: employerAuth, data: { mode: 'allowlist', prefixes: ['AB', ''] } })
      ).rejects.toMatchObject({ code: 'invalid-argument' });
      // Refused before anything is read or written.
      expect(mockDb.collection).not.toHaveBeenCalledWith('employers');
    });

    it('still accepts open mode with no prefixes', async () => {
      const { updateEmployerCurpConfig } = await import('../index');
      const fn = updateEmployerCurpConfig as unknown as (
        req: { auth?: unknown; data: unknown }
      ) => Promise<unknown>;

      // Reaches the employer read (which the shared mock answers) rather than
      // being rejected on the prefix list.
      await expect(
        fn({ auth: employerAuth, data: { mode: 'open', prefixes: [] } })
      ).rejects.not.toMatchObject({ code: 'invalid-argument' });
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
