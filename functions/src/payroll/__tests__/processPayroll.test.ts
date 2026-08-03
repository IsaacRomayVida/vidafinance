/**
 * Regression tests for the payroll deduction channel — the product's primary
 * repayment path, which had no test file at all. That is why all five of the
 * defects below shipped and passed CI:
 *
 *  - E1: the employer-scoping check compared the request against a custom
 *    claim (`employerId`) that no code path in the repository has ever
 *    written, so it was `undefined` for every real caller and EVERY employer
 *    upload was rejected with `permission-denied: Employer mismatch`.
 *  - E3: the loan lookup hardcoded `['active', 'disbursed']` while the
 *    employer's deduction report bills for `overdue` loans too — the employer
 *    withheld the money from the paycheck and the server recorded nothing.
 *  - E5: result rows carried no `status`, so the employer's results table
 *    reported "0 deducted, $0" for a batch that deducted correctly.
 *  - E8: `deductionAmount` came off the uploaded CSV with no upper bound and
 *    `Math.max(0, balance - amount)` turned an over-stated figure into
 *    `status: 'repaid'` plus restored credit.
 *  - E9: the loan was read OUTSIDE the transaction that wrote it, and dedup
 *    was per-batch rather than per-row, so an interrupted batch re-deducted
 *    every row on retry.
 */
export {};

jest.mock('firebase-admin/app', () => ({ initializeApp: jest.fn() }));

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

// The rate limiter reaches Redis; it is not what these tests exercise.
const mockCheckRateLimit = jest.fn(async () => true);
jest.mock('../../utils/rateLimiter', () => ({ checkRateLimit: mockCheckRateLimit }));

const mockNotifications: Array<{ event: string; data: Record<string, unknown> }> = [];
jest.mock('../../utils/notify', () => ({
  notifyLoanEvent: jest.fn(async (event: string, data: Record<string, unknown>) => {
    mockNotifications.push({ event, data });
  }),
}));

// ─── In-memory Firestore ─────────────────────────────────────────────────────

type Store = Record<string, Record<string, unknown>>;

const mockStore: {
  loans: Store;
  payrollDeductions: Store;
  payrollBatches: Store;
  /** Fires the first time a transaction reads a loan — used to simulate a
   *  concurrent write landing between the query and the transaction. */
  onTransactionLoanRead: null | (() => void);
  /** Throws from inside the transaction on the Nth row (1-based), to simulate
   *  a batch that dies half-way. */
  failTransactionOnRow: number | null;
  transactionCount: number;
  loanReadsInsideTransaction: number;
} = {
  loans: {},
  payrollDeductions: {},
  payrollBatches: {},
  onTransactionLoanRead: null,
  failTransactionOnRow: null,
  transactionCount: 0,
  loanReadsInsideTransaction: 0,
};

const mockFieldValue = { serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })) };

const snapshotOf = (collection: keyof typeof mockStore, id: string) => {
  const store = mockStore[collection] as Store;
  const entry = store[id];
  return { exists: entry !== undefined, id, data: () => entry };
};

const makeDocRef = (collection: 'loans' | 'payrollDeductions' | 'payrollBatches', id: string) => ({
  id,
  _collection: collection,
  get: jest.fn(async () => snapshotOf(collection, id)),
  set: jest.fn(async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
    const store = mockStore[collection] as Store;
    store[id] = opts?.merge ? { ...(store[id] ?? {}), ...data } : { ...data };
  }),
});

type Filter = { field: string; op: string; value: unknown };

const makeQuery = (collection: 'loans', filters: Filter[]) => ({
  where: (field: string, op: string, value: unknown) =>
    makeQuery(collection, [...filters, { field, op, value }]),
  limit: (n: number) => ({
    get: async () => runQuery(collection, filters, n),
  }),
  get: async () => runQuery(collection, filters, Infinity),
});

function runQuery(collection: 'loans', filters: Filter[], limit: number) {
  const matches = Object.entries(mockStore[collection]).filter(([, doc]) =>
    filters.every((f) => {
      const actual = (doc as Record<string, unknown>)[f.field];
      if (f.op === '==') return actual === f.value;
      if (f.op === 'in') return (f.value as unknown[]).includes(actual);
      throw new Error(`unsupported operator ${f.op}`);
    }),
  );
  const docs = matches.slice(0, limit).map(([id, data]) => ({
    id,
    ref: makeDocRef(collection, id),
    data: () => data,
  }));
  return { empty: docs.length === 0, docs, size: docs.length };
}

const makeTransaction = () => ({
  get: jest.fn(async (ref: { _collection: keyof typeof mockStore; id: string }) => {
    if (ref._collection === 'loans') {
      mockStore.loanReadsInsideTransaction += 1;
      mockStore.onTransactionLoanRead?.();
    }
    return snapshotOf(ref._collection, ref.id);
  }),
  create: jest.fn((ref: { _collection: keyof typeof mockStore; id: string }, data: Record<string, unknown>) => {
    const store = mockStore[ref._collection] as Store;
    if (store[ref.id] !== undefined) {
      // Matches the real Firestore failure mode for create-on-existing.
      const err = new Error(`ALREADY_EXISTS: entity already exists: ${ref.id}`) as Error & { code: number };
      err.code = 6;
      throw err;
    }
    store[ref.id] = { ...data };
  }),
  update: jest.fn((ref: { _collection: keyof typeof mockStore; id: string }, data: Record<string, unknown>) => {
    const store = mockStore[ref._collection] as Store;
    store[ref.id] = { ...(store[ref.id] ?? {}), ...data };
  }),
});

const mockDb = {
  collection: jest.fn((name: string) => {
    if (name === 'loans') {
      return {
        ...makeQuery('loans', []),
        doc: (id: string) => makeDocRef('loans', id),
      };
    }
    return { doc: (id: string) => makeDocRef(name as 'payrollDeductions', id) };
  }),
  runTransaction: jest.fn(async (fn: (tx: ReturnType<typeof makeTransaction>) => Promise<unknown>) => {
    mockStore.transactionCount += 1;
    if (mockStore.failTransactionOnRow === mockStore.transactionCount) {
      throw new Error('deadline_exceeded');
    }
    return fn(makeTransaction());
  }),
};

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockDb),
  FieldValue: mockFieldValue,
}));

type RowResult = {
  employeeId: string;
  status: string;
  loanId?: string;
  deductionAmount: number;
  newBalance?: number;
  newStatus?: string;
  error?: string;
};

type PayrollResponse = {
  batchId: string;
  status: string;
  processedCount: number;
  errorCount?: number;
  results?: RowResult[];
};

// Loaded lazily, after the mock factories above have their captured state —
// the same dynamic-import style the sibling suites in src/__tests__ use.
let processPayroll: (req: unknown) => Promise<PayrollResponse>;

beforeAll(async () => {
  ({ processPayroll } = (await import('../processPayroll')) as unknown as {
    processPayroll: (req: unknown) => Promise<PayrollResponse>;
  });
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

const EMPLOYER_UID = 'employer-uid-1';

/** The token a real employer_admin actually carries: `role` and nothing else.
 *  Every setCustomUserClaims call site in the repo writes `{ role }` only. */
const employerRequest = (data: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  auth: { uid: EMPLOYER_UID, token: { role: 'employer_admin', ...overrides } },
  data,
});

const payload = (rows: Array<Record<string, unknown>>, employerId = EMPLOYER_UID) => ({
  employerId,
  payPeriodStart: '2026-07-01',
  payPeriodEnd: '2026-07-15',
  rows,
});

const row = (over: Record<string, unknown> = {}) => ({
  employeeId: 'emp-1',
  grossSalary: 20000,
  netSalary: 16000,
  payPeriod: '2026-07-15',
  ...over,
});

function seedLoan(id: string, over: Record<string, unknown> = {}) {
  mockStore.loans[id] = {
    employeeId: 'emp-1',
    employerId: EMPLOYER_UID,
    status: 'active',
    remainingBalance: 6500,
    monthlyPayment: 2000,
    payPeriodsPerMonth: 2,
    ...over,
  };
}

beforeEach(() => {
  mockStore.loans = {};
  mockStore.payrollDeductions = {};
  mockStore.payrollBatches = {};
  mockStore.onTransactionLoanRead = null;
  mockStore.failTransactionOnRow = null;
  mockStore.transactionCount = 0;
  mockStore.loanReadsInsideTransaction = 0;
  mockNotifications.length = 0;
  jest.clearAllMocks();
  mockCheckRateLimit.mockResolvedValue(true);
});

// ─── E1 — the auth gate ──────────────────────────────────────────────────────

describe('E1 — employer scoping', () => {
  it('lets an employer_admin process their own payroll with the claims production actually issues', async () => {
    // The whole defect in one assertion: this token has no `employerId` claim,
    // because nothing has ever written one. Before the fix this threw
    // permission-denied for every employer, on every upload, 100% of the time.
    seedLoan('loan-1');

    const res = await processPayroll(employerRequest(payload([row()])));

    expect(res.status).toBe('completed');
    expect(res.processedCount).toBe(1);
  });

  it('rejects an employer_admin acting on someone else\'s employer id', async () => {
    await expect(
      processPayroll(employerRequest(payload([row()], 'some-other-employer'))),
    ).rejects.toMatchObject({ code: 'permission-denied', message: 'Employer mismatch' });
  });

  it('accepts the employerId claim as a fallback if uid and employer doc id ever diverge', async () => {
    seedLoan('loan-1', { employerId: 'legacy-employer-id' });

    const res = await processPayroll({
      auth: { uid: 'some-other-uid', token: { role: 'employer_admin', employerId: 'legacy-employer-id' } },
      data: payload([row()], 'legacy-employer-id'),
    });

    expect(res.processedCount).toBe(1);
  });

  it('lets an internal admin process any employer', async () => {
    seedLoan('loan-1');
    const res = await processPayroll({
      auth: { uid: 'funpay-ops', token: { role: 'admin' } },
      data: payload([row()]),
    });
    expect(res.processedCount).toBe(1);
  });

  it('rejects an unauthenticated caller and a caller without the role', async () => {
    await expect(processPayroll({ data: payload([row()]) })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    await expect(
      processPayroll({ auth: { uid: EMPLOYER_UID, token: { role: 'employee' } }, data: payload([row()]) }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});

// ─── E3 — the status set ─────────────────────────────────────────────────────

describe('E3 — statuses a deduction can land against', () => {
  it.each(['active', 'disbursed', 'overdue', 'in_collections'])(
    'deducts against a %s loan — the employer is billed for it, so the server must collect it',
    async (status) => {
      seedLoan('loan-1', { status });

      const res = await processPayroll(employerRequest(payload([row({ deductionAmount: 1000 })])));

      expect(res.results?.[0]).toMatchObject({ status: 'deducted', deductionAmount: 1000, loanId: 'loan-1' });
      expect(mockStore.loans['loan-1']?.['remainingBalance']).toBe(5500);
    },
  );

  it('does not invent a deduction against a loan that never disbursed', async () => {
    seedLoan('loan-1', { status: 'approved' });

    const res = await processPayroll(employerRequest(payload([row({ deductionAmount: 1000 })])));

    expect(res.results?.[0]).toMatchObject({ status: 'skipped', error: 'no_deductible_loan' });
    expect(mockStore.loans['loan-1']?.['remainingBalance']).toBe(6500);
  });

  it('does not deduct twice from an already repaid loan', async () => {
    seedLoan('loan-1', { status: 'repaid', remainingBalance: 0 });

    const res = await processPayroll(employerRequest(payload([row({ deductionAmount: 1000 })])));

    expect(res.results?.[0]?.status).toBe('skipped');
    expect(mockStore.loans['loan-1']?.['remainingBalance']).toBe(0);
  });

  it('re-checks the status inside the transaction, in case the loan settled mid-batch', async () => {
    seedLoan('loan-1', { status: 'active' });
    mockStore.onTransactionLoanRead = () => {
      mockStore.loans['loan-1'] = { ...mockStore.loans['loan-1'], status: 'written_off' };
    };

    const res = await processPayroll(employerRequest(payload([row({ deductionAmount: 1000 })])));

    expect(res.results?.[0]).toMatchObject({ status: 'skipped', error: 'loan_not_deductible' });
    expect(mockStore.payrollDeductions).toEqual({});
  });
});

// ─── E5 — row outcomes the client can read ───────────────────────────────────

describe('E5 — every result row carries an explicit outcome', () => {
  it('labels a successful deduction `deducted`, so the summary is not structurally 0', async () => {
    seedLoan('loan-1');
    seedLoan('loan-2', { employeeId: 'emp-2' });

    const res = await processPayroll(
      employerRequest(payload([row({ deductionAmount: 1000 }), row({ employeeId: 'emp-2', deductionAmount: 500 })])),
    );

    // What PayrollUpload.tsx computes off these rows.
    const deducted = res.results!.filter((r) => r.status === 'deducted');
    expect(deducted).toHaveLength(2);
    expect(deducted.reduce((s, r) => s + (r.deductionAmount ?? 0), 0)).toBe(1500);
  });

  it('gives every row one of the four statuses the client renders a badge for', async () => {
    seedLoan('loan-1');                                   // -> deducted
    seedLoan('loan-3', { employeeId: 'emp-3', status: 'approved' }); // -> skipped
    seedLoan('loan-4', { employeeId: 'emp-4', remainingBalance: 100 }); // -> error (over-stated)

    const res = await processPayroll(employerRequest(payload([
      row({ deductionAmount: 1000 }),
      row({ employeeId: 'emp-3', deductionAmount: 1000 }),
      row({ employeeId: 'emp-4', deductionAmount: 1000 }),
    ])));

    const statuses = res.results!.map((r) => r.status);
    expect(statuses).toEqual(['deducted', 'skipped', 'error']);
    for (const s of statuses) {
      expect(['deducted', 'skipped', 'error', 'already_processed']).toContain(s);
    }
  });

  it('counts the batch by outcome rather than by absence of an error string', async () => {
    seedLoan('loan-1');
    seedLoan('loan-3', { employeeId: 'emp-3', status: 'approved' });

    const res = await processPayroll(employerRequest(payload([
      row({ deductionAmount: 1000 }),
      row({ employeeId: 'emp-3', deductionAmount: 1000 }),
    ])));

    expect(res.processedCount).toBe(1);
    expect(mockStore.payrollBatches['employer-uid-1_2026-07-01_2026-07-15']).toMatchObject({
      status: 'completed',
      processedCount: 1,
      skippedCount: 1,
      errorCount: 0,
    });
  });
});

// ─── E8 — the obligation is the ceiling ──────────────────────────────────────

describe('E8 — a client-supplied deduction cannot exceed the obligation', () => {
  it('refuses a CSV row that over-states the deduction instead of marking the loan repaid', async () => {
    // A borrower owes $6,500; the CSV carries $65,000 — a stray digit, or an
    // employer extinguishing an employee's debt on purpose.
    seedLoan('loan-1', { remainingBalance: 6500 });

    const res = await processPayroll(employerRequest(payload([row({ deductionAmount: 65000 })])));

    expect(res.results?.[0]).toMatchObject({ status: 'error', deductionAmount: 0 });
    expect(res.results?.[0]?.error).toContain('deduction_exceeds_balance');
    // The discrepancy is surfaced, not silently truncated.
    expect(res.results?.[0]?.error).toContain('requested=65000');
    expect(res.results?.[0]?.error).toContain('owed=6500');

    // Nothing moved: no repayment, no restored credit, no deduction record.
    expect(mockStore.loans['loan-1']?.['remainingBalance']).toBe(6500);
    expect(mockStore.loans['loan-1']?.['status']).toBe('active');
    expect(mockStore.payrollDeductions).toEqual({});
    expect(mockNotifications).toEqual([]);
  });

  it('still settles a loan when the deduction exactly matches the obligation', async () => {
    seedLoan('loan-1', { remainingBalance: 6500 });

    const res = await processPayroll(employerRequest(payload([row({ deductionAmount: 6500 })])));

    expect(res.results?.[0]).toMatchObject({ status: 'deducted', newBalance: 0, newStatus: 'repaid' });
    expect(mockStore.loans['loan-1']?.['status']).toBe('repaid');
    expect(mockNotifications.map((n) => n.event)).toEqual(['loan_repaid']);
  });

  it('caps the fallback (no CSV amount) at the balance and never over-collects', async () => {
    // monthlyPayment 2000 over 2 periods = 1000 expected, but only 400 is owed.
    seedLoan('loan-1', { remainingBalance: 400 });

    const res = await processPayroll(employerRequest(payload([row()])));

    expect(res.results?.[0]).toMatchObject({ status: 'deducted', deductionAmount: 400, newBalance: 0 });
  });

  it('skips a zero-amount row rather than writing an empty deduction', async () => {
    seedLoan('loan-1');

    const res = await processPayroll(employerRequest(payload([row({ deductionAmount: 0 })])));

    expect(res.results?.[0]).toMatchObject({ status: 'skipped', error: 'nothing_to_deduct' });
    expect(mockStore.payrollDeductions).toEqual({});
  });

  it('keeps balances at cents rather than accumulating float dust', async () => {
    seedLoan('loan-1', { remainingBalance: 1000.1 });

    const res = await processPayroll(employerRequest(payload([row({ deductionAmount: 333.33 })])));

    expect(res.results?.[0]?.newBalance).toBe(666.77);
  });
});

// ─── E9 — replay and concurrency ─────────────────────────────────────────────

describe('E9 — an interrupted batch does not re-deduct on retry', () => {
  it('does not debit an employee twice when a half-finished batch is retried', async () => {
    seedLoan('loan-1');
    seedLoan('loan-2', { employeeId: 'emp-2', remainingBalance: 4000 });
    const rows = [row({ deductionAmount: 1000 }), row({ employeeId: 'emp-2', deductionAmount: 1000 })];

    // First attempt dies inside the SECOND row's transaction, leaving the
    // batch document at `in_progress` — exactly the state a callable timeout
    // leaves behind.
    mockStore.failTransactionOnRow = 2;
    const first = await processPayroll(employerRequest(payload(rows)));
    expect(first.results?.[0]?.status).toBe('deducted');
    expect(first.results?.[1]?.status).toBe('error');
    expect(mockStore.payrollBatches['employer-uid-1_2026-07-01_2026-07-15']?.['status']).toBe('completed');
    expect(mockStore.loans['loan-1']?.['remainingBalance']).toBe(5500);

    // The employer retries the same file.
    mockStore.failTransactionOnRow = null;
    mockStore.payrollBatches['employer-uid-1_2026-07-01_2026-07-15'] = {
      ...mockStore.payrollBatches['employer-uid-1_2026-07-01_2026-07-15'],
      status: 'in_progress',
    };
    const second = await processPayroll(employerRequest(payload(rows)));

    // Row 1 already landed and must not land again; row 2 gets its deduction.
    expect(second.results?.[0]?.status).toBe('already_processed');
    expect(second.results?.[1]?.status).toBe('deducted');
    expect(mockStore.loans['loan-1']?.['remainingBalance']).toBe(5500);
    expect(mockStore.loans['loan-2']?.['remainingBalance']).toBe(3000);
  });

  it('writes one deduction record per (batch, loan) under a deterministic id', async () => {
    seedLoan('loan-1');

    await processPayroll(employerRequest(payload([row({ deductionAmount: 1000 })])));

    expect(Object.keys(mockStore.payrollDeductions)).toEqual([
      'employer-uid-1_2026-07-01_2026-07-15__loan-1',
    ]);
  });

  it('collapses two CSV rows naming the same employee onto one deduction', async () => {
    seedLoan('loan-1');

    const res = await processPayroll(employerRequest(payload([
      row({ deductionAmount: 1000 }),
      row({ deductionAmount: 1000 }),
    ])));

    expect(res.results!.map((r) => r.status)).toEqual(['deducted', 'already_processed']);
    expect(mockStore.loans['loan-1']?.['remainingBalance']).toBe(5500);
  });

  it('does not re-notify the borrower for a replayed row', async () => {
    seedLoan('loan-1');
    const rows = [row({ deductionAmount: 1000 })];

    await processPayroll(employerRequest(payload(rows)));
    mockStore.payrollBatches['employer-uid-1_2026-07-01_2026-07-15'] = { status: 'in_progress' };
    mockNotifications.length = 0;

    await processPayroll(employerRequest(payload(rows)));

    expect(mockNotifications).toEqual([]);
  });

  it('computes the deduction from the balance the transaction itself read', async () => {
    // A concurrent batch takes the balance from 5000 to 3000 between the loan
    // query and the transaction. The old code did its arithmetic on the
    // pre-transaction snapshot, so this deduction would have written 4000 —
    // silently erasing the other batch's 2000.
    seedLoan('loan-1', { remainingBalance: 5000 });
    mockStore.onTransactionLoanRead = () => {
      mockStore.loans['loan-1'] = { ...mockStore.loans['loan-1'], remainingBalance: 3000 };
      mockStore.onTransactionLoanRead = null;
    };

    const res = await processPayroll(employerRequest(payload([row({ deductionAmount: 1000 })])));

    expect(mockStore.loanReadsInsideTransaction).toBeGreaterThan(0);
    expect(res.results?.[0]?.newBalance).toBe(2000);
    expect(mockStore.loans['loan-1']?.['remainingBalance']).toBe(2000);
  });

  it('still short-circuits a batch already marked completed', async () => {
    seedLoan('loan-1');
    mockStore.payrollBatches['employer-uid-1_2026-07-01_2026-07-15'] = {
      status: 'completed',
      processedCount: 7,
    };

    const res = await processPayroll(employerRequest(payload([row({ deductionAmount: 1000 })])));

    expect(res).toMatchObject({ status: 'already_processed', processedCount: 7 });
    expect(mockStore.transactionCount).toBe(0);
    expect(mockStore.loans['loan-1']?.['remainingBalance']).toBe(6500);
  });
});
