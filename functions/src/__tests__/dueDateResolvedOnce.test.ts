// #437 — a loan has ONE due date, decided once, at creation.
//
// It used to have two. `requestLoan` wrote `now + 30 days`; the borrower was
// quoted it, signed it and was disclosed a CAT against it. Then
// `markLoanDisbursed` recomputed the borrower's next payroll date from a
// different rule and overwrote it. For a monthly borrower disbursed on the 16th
// the second date landed roughly two weeks BEFORE the first: same fee, half the
// time, a true annual cost far above the ~2334% disclosed. Understating a
// CONDUSEF-regulated CAT is the one direction the number must never be wrong in.
//
// A unit test of either function alone cannot see this — each was internally
// consistent. So this drives the real deployed handlers in sequence:
//
//   requestLoan()       → the date the borrower is quoted and signs
//   markLoanDisbursed() → the date the money is actually collected on
//
// and asserts they are the same date, and that it is never earlier than the
// term that was disclosed.

// Marks this file as a MODULE. Do not delete — see the same note in
// repaymentScheduleTruth.test.ts. Everything is imported lazily, so without
// this the top-level `mockLogger` / `MockTimestamp` / `mockFieldValue` /
// `mockDb` declarations land in the global scope and collide with the
// identically-named ones in the other suites (TS2300/TS2451).
export {};

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
  toMillis() {
    return this.seconds * 1000;
  }
}

const mockFieldValue = {
  increment: jest.fn((n: number) => ({ _increment: n })),
  serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })),
  arrayUnion: jest.fn((...items: unknown[]) => ({ _arrayUnion: items })),
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

jest.mock('../utils/rateLimiter', () => ({ checkRateLimit: jest.fn().mockResolvedValue(true) }));
jest.mock('../utils/notify', () => ({ notifyLoanEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/slackAlert', () => ({ sendSlackAlert: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/sentry', () => ({ initSentry: jest.fn(), captureException: jest.fn() }));

const BASE_EMPLOYEE = {
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

type Doc = Record<string, unknown>;

function buildMockDb(employee: Doc | null = BASE_EMPLOYEE) {
  const writes: Array<{ op: string; collection?: string; data?: Doc }> = [];
  const loans: Record<string, Doc> = {};

  // ADR-005 Finding 2 / ADR-007: requestLoan's employer-slot-cap check reads
  // this employer's active-loan count inside the transaction via an
  // aggregate `.count()` query. Tagged so the transaction mock's `get()`
  // below can recognize it was handed the aggregate query object, not a
  // document reference. This file always exercises a fresh employer with no
  // active loans, so the count is fixed at 0 — well under the Tier-2
  // fallback (3) EMPLOYER's absent riskTier resolves to.
  const employerActiveLoansCountQuery = { _kind: 'employerActiveLoansCountQuery' as const };
  const loansQuery: { where: jest.Mock; limit: jest.Mock; get: jest.Mock; count: jest.Mock } = {
    where: jest.fn(),
    limit: jest.fn(),
    get: jest.fn().mockResolvedValue({ empty: true, docs: [] }),
    count: jest.fn().mockReturnValue(employerActiveLoansCountQuery),
  };
  loansQuery.where.mockReturnValue(loansQuery);
  loansQuery.limit.mockReturnValue(loansQuery);

  const docRef = (collection: string, id: string) => ({
    id,
    _collection: collection,
    _kind: collection === 'employers' ? ('employerDocRef' as const) : undefined,
    get: jest.fn(async () => {
      if (collection === 'employees') {
        return { exists: employee !== null, data: () => employee };
      }
      if (collection === 'employers') {
        return { exists: true, data: () => EMPLOYER };
      }
      if (collection === 'loans') {
        const loan = loans[id];
        return { exists: loan !== undefined, data: () => loan ?? null };
      }
      // No config document: getLoanConfigValues() returns the ratified seed,
      // which is what an unconfigured deployment does in production.
      return { exists: false, data: () => undefined };
    }),
    update: jest.fn(async (data: Doc) => {
      writes.push({ op: 'update', collection, data });
    }),
    set: jest.fn(async () => {}),
  });

  return {
    _writes: writes,
    _loans: loans,
    collection: jest.fn((name: string) => ({
      ...(name === 'loans' ? loansQuery : {}),
      doc: jest.fn((id?: string) => docRef(name, id ?? 'generated-id')),
      add: jest.fn(async () => ({ id: 'generated-id' })),
    })),
    runTransaction: jest.fn(
      async (fn: (txn: { get: jest.Mock; update: jest.Mock; set: jest.Mock }) => Promise<void>) => {
        const record = (op: string) =>
          jest.fn((ref: unknown, data: Doc) => {
            writes.push({
              op,
              collection: (ref as { _collection?: string })._collection,
              data,
            });
          });
        const txn = {
          get: jest.fn((refOrQuery: { _kind?: string } | undefined) => {
            if (refOrQuery?._kind === 'employerDocRef') {
              return Promise.resolve({ exists: true, data: () => EMPLOYER });
            }
            if (refOrQuery?._kind === 'employerActiveLoansCountQuery') {
              return Promise.resolve({ data: () => ({ count: 0 }) });
            }
            throw new Error('Mock tx.get() called with an unrecognized ref/query');
          }),
          update: record('txn.update'),
          set: record('txn.set'),
        };
        await fn(txn);
        return txn;
      }
    ),
  };
}

const BORROWER = { uid: 'user-123', token: { role: 'employee' } };
const OPS = { uid: 'ops-1', token: { role: 'ops', email: 'ops@test.com' } };
const CLIENT_PAYLOAD = {
  amount: 1000,
  employerCode: 'TESTCO',
  bankAccountClabe: '032180000118359719',
  termsAccepted: true as const,
  termDays: 30,
};

const DAY_MS = 24 * 60 * 60 * 1000;

// Monday 16 March 2026, mid-morning. Chosen because every cadence's NEXT
// payday from here — Mon 23 Mar (weekly), Mon 6 Apr (biweekly), Tue 31 Mar
// (semimonthly and monthly) — falls BEFORE day 30. That is the case the old
// code got wrong: it collected early at the full 30-day fee.
const PINNED_NOW = new Date(2026, 2, 16, 10, 0, 0);

type PersistedInstallment = { number: number; amount: number; dueDate: MockTimestamp };

/** Runs the deployed requestLoan and returns the loan document it wrote. */
async function createLoan(): Promise<{ loanId: string; loan: Doc }> {
  const { requestLoan } = await import('../index');
  const fn = requestLoan as unknown as (req: { auth?: unknown; data: unknown }) => Promise<{
    loanId: string;
  }>;
  const result = await fn({ auth: BORROWER, data: CLIENT_PAYLOAD });
  const write = mockDb._writes.find((w) => w.op === 'txn.set' && w.collection === 'loans');
  if (!write?.data) throw new Error('requestLoan wrote no loan document');
  return { loanId: result.loanId, loan: write.data };
}

/**
 * Puts a loan into the store as `approved` and runs the deployed
 * markLoanDisbursed over it, exactly as ops does after STP confirms.
 */
async function disburse(loanId: string, loan: Doc): Promise<Doc> {
  mockDb._loans[loanId] = { ...loan, status: 'approved' };
  const { markLoanDisbursed } = await import('../loans/markLoanDisbursed');
  const fn = markLoanDisbursed as unknown as (req: {
    auth?: unknown;
    data: unknown;
  }) => Promise<Doc>;
  return fn({
    auth: OPS,
    data: {
      loanId,
      stpTransactionId: 'STP-001',
      stpClaveRastreo: 'CLAVE-001',
      disbursedAmount: 1000,
      disbursedAt: new Date(PINNED_NOW.getTime() + 2 * DAY_MS).toISOString(),
    },
  });
}

/** The loan-document fields markLoanDisbursed wrote inside its transaction. */
function disbursementUpdate(): Doc {
  const write = [...mockDb._writes].reverse().find(
    (w) => w.op === 'txn.update' && w.collection === 'loans'
  );
  if (!write?.data) throw new Error('markLoanDisbursed updated no loan document');
  return write.data;
}

function setUpWith(employee: Doc | null) {
  mockDb = buildMockDb(employee);
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(PINNED_NOW);
  setUpWith(BASE_EMPLOYEE);
  delete process.env['UNDERWRITING_SERVICE_URL'];
  delete process.env['ML_SERVICE_URL'];
  delete process.env['SOFTCREDITO_ADAPTER_URL'];
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('requestLoan resolves the due date once, against the borrower payroll calendar', () => {
  // Each expectation is the first real payday on or after 15 Apr 2026 10:00
  // (= 16 March + 30 days), rounded up to a midnight because payroll dates are
  // midnights and a same-day midnight is hours short of the term.
  const CADENCES = [
    { payFrequency: 'weekly', expected: new Date(2026, 3, 20), why: 'Mon 20 Apr' },
    { payFrequency: 'biweekly', expected: new Date(2026, 3, 20), why: 'Mon 20 Apr, a whole cycle on' },
    { payFrequency: 'semimonthly', expected: new Date(2026, 3, 30), why: '30 Apr, the 15th having passed' },
    { payFrequency: 'monthly', expected: new Date(2026, 3, 30), why: '30 Apr' },
  ] as const;

  it.each(CADENCES)('a $payFrequency borrower is due on $why', async ({ payFrequency, expected }) => {
    setUpWith({ ...BASE_EMPLOYEE, payFrequency });

    const { loan } = await createLoan();

    expect((loan['dueDate'] as MockTimestamp).toDate()).toEqual(expected);
    expect((loan['borrowerSnapshot'] as Doc)['payFrequency']).toBe(payFrequency);
    expect(loan['payFrequencySource']).toBe('employee_record');
  });

  it.each(CADENCES)(
    'rolls a $payFrequency borrower FORWARD past the payday that falls inside the term, never back to it',
    async ({ payFrequency }) => {
      setUpWith({ ...BASE_EMPLOYEE, payFrequency });
      const { calculateNextPayrollDate } = await import('../loans/calculateNextPayrollDate');

      // The date the old disbursement path would have collected on: the
      // borrower's very next payday. For every cadence here it falls inside
      // the 30-day term — that is the understated-CAT bug.
      const nextPaydayFromToday = calculateNextPayrollDate(payFrequency).toDate();
      expect(nextPaydayFromToday.getTime()).toBeLessThan(PINNED_NOW.getTime() + 30 * DAY_MS);

      const { loan } = await createLoan();
      const dueDate = (loan['dueDate'] as MockTimestamp).toDate();

      expect(dueDate.getTime()).not.toBe(nextPaydayFromToday.getTime());
      // The whole point: at or after the term the CAT was computed on, so the
      // disclosed cost of credit can only ever overstate the real one.
      expect(dueDate.getTime()).toBeGreaterThanOrEqual(PINNED_NOW.getTime() + 30 * DAY_MS);
    }
  );

  it('hangs the persisted repayment schedule off that same date', async () => {
    setUpWith({ ...BASE_EMPLOYEE, payFrequency: 'monthly' });

    const { loan } = await createLoan();

    const schedule = loan['repaymentSchedule'] as PersistedInstallment[];
    expect(schedule).toHaveLength(1);
    expect(schedule[0]!.dueDate.toMillis()).toBe((loan['dueDate'] as MockTimestamp).toMillis());
    expect(schedule[0]!.amount).toBe(loan['total']);
  });

  it('prices the loan exactly as before — this change moves the date, not the money', async () => {
    setUpWith({ ...BASE_EMPLOYEE, payFrequency: 'weekly' });

    const { loan } = await createLoan();

    expect(loan['fee']).toBe(300);
    expect(loan['total']).toBe(1300);
    expect(loan['term']).toBe(30);
    // The CAT stays computed on the code-owned 30-day term. The real interval
    // is now >= 30 days, so 2334% is conservative rather than understated.
    expect(loan['catPercent']).toBe(2334);
  });

  it('marks the cadence as assumed when the borrower record does not carry one', async () => {
    const { loan } = await createLoan(); // BASE_EMPLOYEE has no payFrequency

    expect(loan['payFrequencySource']).toBe('default_monthly');
    expect((loan['borrowerSnapshot'] as Doc)['payFrequency']).toBe('monthly');
  });
});

describe('disbursement does not move the due date', () => {
  it.each(['weekly', 'biweekly', 'semimonthly', 'monthly'])(
    'a %s loan is collected on the exact date it was signed for',
    async (payFrequency) => {
      setUpWith({ ...BASE_EMPLOYEE, payFrequency });

      const { loanId, loan } = await createLoan();
      const signedDueDate = (loan['dueDate'] as MockTimestamp).toDate().toISOString();

      const result = await disburse(loanId, loan);

      expect(result['dueDate']).toBe(signedDueDate);
    }
  );

  it('writes neither dueDate nor repaymentSchedule, so there is nothing to drift', async () => {
    setUpWith({ ...BASE_EMPLOYEE, payFrequency: 'monthly' });

    const { loanId, loan } = await createLoan();
    await disburse(loanId, loan);

    const update = disbursementUpdate();
    expect(update['status']).toBe('disbursed');
    expect(update).not.toHaveProperty('dueDate');
    expect(update).not.toHaveProperty('repaymentSchedule');
  });

  it('does not re-derive the cadence from a borrower record that changed after signing', async () => {
    // The loan is signed as monthly...
    setUpWith({ ...BASE_EMPLOYEE, payFrequency: 'monthly' });
    const { loanId, loan } = await createLoan();
    const signedDueDate = (loan['dueDate'] as MockTimestamp).toDate().toISOString();

    // ...and HR corrects the employee record to weekly before ops disburses.
    // The borrower signed a date; a record edit must not move it.
    mockDb = buildMockDb({ ...BASE_EMPLOYEE, payFrequency: 'weekly' });

    const result = await disburse(loanId, loan);

    expect(result['dueDate']).toBe(signedDueDate);
  });
});

describe('loans created before the due date was resolved at request time', () => {
  // No borrowerSnapshot.payFrequency: the shape every loan in flight at deploy
  // has. They keep the old realigning behaviour. Changing a live borrower's
  // collection date under them — after they were told one and after the
  // SoftCrédito deduction was registered — is worse than letting a
  // known-imperfect path finish.
  const legacyLoan = () => ({
    status: 'approved',
    employerId: 'employer-abc',
    employeeId: 'user-123',
    amount: 1000,
    principalAmount: 1000,
    total: 1300,
    term: 30,
    dueDate: MockTimestamp.fromDate(new Date(PINNED_NOW.getTime() + 30 * DAY_MS)),
  });

  it('still realigns to the payroll date and rebuilds the schedule with it', async () => {
    setUpWith({ ...BASE_EMPLOYEE, payFrequency: 'monthly' });
    const loan = legacyLoan();

    const result = await disburse('legacy-1', loan);
    const update = disbursementUpdate();

    // The old rule: the borrower's next payday from today — 31 March, inside
    // the term. Unchanged, deliberately.
    expect(new Date(result['dueDate'] as string)).toEqual(new Date(2026, 2, 31));
    expect(update).toHaveProperty('dueDate');

    const schedule = update['repaymentSchedule'] as PersistedInstallment[];
    expect(schedule[0]!.dueDate.toMillis()).toBe(new Date(result['dueDate'] as string).getTime());
    expect(schedule.reduce((sum, i) => sum + i.amount, 0)).toBe(1300);
  });

  it('records the move in the audit log, which the current path has nothing to record', async () => {
    setUpWith({ ...BASE_EMPLOYEE, payFrequency: 'monthly' });
    const loan = legacyLoan();

    await disburse('legacy-2', loan);

    const auditWrite = mockDb._writes.find(
      (w) => w.op === 'txn.set' && w.collection === 'audit_log'
    );
    const meta = auditWrite!.data!['meta'] as Doc;
    expect(meta['dueDateRealigned']).toMatchObject({ payFrequency: 'monthly' });
  });
});
