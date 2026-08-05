import { guardReadAfterWrite as mockGuardReadAfterWrite } from '../__mocks__/txReadAfterWrite';

// The other half of the read-after-write class the shared mocks now enforce.
//
// `txReadAfterWriteGuard.test.ts` covers reads taken AFTER a write — the
// ordering the Admin SDK refuses outright. This file covers the failure that
// looks correct to the SDK and commits happily: a guard decided from a read
// taken OUTSIDE the transaction that acts on it.
//
// #577 was exactly that. requestLoan's "no open application" and "within
// available credit" checks were both settled before a 30-second underwriting
// call and never re-checked, so a double-click bought three 5,000-peso loans
// against one 5,000-peso credit line. The fix pattern is `tx.get()` INSIDE the
// transaction, and it is only a fix if it is applied everywhere the shape
// occurs. These are the two remaining money paths that still had it.
//
// Both tests move the document under the handler between its pre-transaction
// read and the transaction body — precisely what a concurrent caller does when
// it wins the race — and assert the handler refuses instead of committing.
// Against the pre-fix code both transactions write, because neither read
// anything: a transaction with an EMPTY read set gives Firestore's optimistic
// concurrency nothing to conflict on, so both racers commit unconditionally.
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
  toMillis() {
    return this.seconds * 1000;
  }
}

const mockFieldValue = {
  increment: jest.fn((n: number) => ({ _increment: n })),
  serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })),
  arrayUnion: jest.fn((...items: unknown[]) => ({ _arrayUnion: items })),
};

type Doc = Record<string, unknown>;
type Written = { collection: string; id: string; data: Doc };
/** What the handler read THROUGH the transaction — i.e. its read set. */
type TxRead = { collection: string; id: string };

let mockDb: {
  collection: jest.Mock;
  runTransaction: jest.Mock;
  _writes: Written[];
  _txReads: TxRead[];
};

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockDb),
  FieldValue: mockFieldValue,
  Timestamp: MockTimestamp,
}));

jest.mock('firebase-admin/auth', () => ({
  getAuth: jest.fn(() => ({
    getUser: jest.fn().mockResolvedValue({ customClaims: { role: 'employee' } }),
    setCustomUserClaims: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../utils/rateLimiter', () => {
  const mod = { checkRateLimit: jest.fn().mockResolvedValue(true) };
  return {
    ...mod,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    enforceRateLimit: require('../__mocks__/utils/rateLimiter').makeEnforceRateLimit(
      (...a: unknown[]) =>
        (mod as { checkRateLimit: (...a: unknown[]) => Promise<boolean> }).checkRateLimit(...a)
    ),
  };
});
jest.mock('../utils/redis', () => ({
  getRedis: jest.fn(() => ({ lpush: jest.fn().mockResolvedValue(1) })),
}));
jest.mock('../utils/notify', () => ({ notifyLoanEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/slackAlert', () => ({ sendSlackAlert: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/sentry', () => ({ initSentry: jest.fn(), captureException: jest.fn() }));

const OPS_AUTH = { uid: 'ops-1', token: { role: 'ops', email: 'ops@vidafinance.mx' } };

/**
 * A store whose documents can be moved by a "concurrent caller" at a chosen
 * moment — `onTransaction` fires once, immediately before the transaction body
 * runs, which is the window between a pre-transaction guard read and the
 * commit that acts on it.
 *
 * Writes are buffered and only applied when the body returns without throwing,
 * matching a real transaction's all-or-nothing commit. That is what lets these
 * tests assert on what did NOT land.
 */
function buildRacingDb(docs: Record<string, Record<string, Doc>>, onTransaction: () => void) {
  const writes: Written[] = [];
  /** Every document read through `tx.get()` — i.e. the transaction's read set. */
  const txReads: Array<{ collection: string; id: string }> = [];
  let raced = false;

  const read = (collection: string, id: string) => {
    const entry = docs[collection]?.[id];
    return { exists: entry !== undefined, id, data: () => entry ?? null };
  };

  const docRef = (collection: string, id: string) => ({
    id,
    _collection: collection,
    get: jest.fn(async () => read(collection, id)),
    update: jest.fn(async (data: Doc) => {
      writes.push({ collection, id, data });
    }),
    set: jest.fn(async (data: Doc) => {
      writes.push({ collection, id, data });
    }),
  });

  const emptyQuery = () => {
    const q: Record<string, jest.Mock> = {
      where: jest.fn(),
      limit: jest.fn(),
      orderBy: jest.fn(),
      get: jest.fn().mockResolvedValue({ empty: true, docs: [], size: 0 }),
    };
    q['where']!.mockReturnValue(q);
    q['limit']!.mockReturnValue(q);
    q['orderBy']!.mockReturnValue(q);
    return q;
  };

  return {
    _writes: writes,
    _txReads: txReads,
    collection: jest.fn((name: string) => ({
      ...emptyQuery(),
      doc: jest.fn((id?: string) => docRef(name, id ?? 'generated-id')),
      add: jest.fn(async (data: Doc) => {
        writes.push({ collection: name, id: 'generated-id', data });
        return { id: 'generated-id' };
      }),
    })),
    runTransaction: jest.fn(async (fn: (txn: unknown) => Promise<unknown>) => {
      // The concurrent caller lands exactly here: after the handler's
      // pre-transaction reads, before this transaction sees anything.
      if (!raced) {
        raced = true;
        onTransaction();
      }

      const pending: Written[] = [];
      const txn = {
        get: jest.fn(async (ref: { _collection?: string; id?: string }) => {
          txReads.push({ collection: ref._collection ?? '', id: ref.id ?? '' });
          return read(ref._collection ?? '', ref.id ?? '');
        }),
        update: jest.fn((ref: { _collection: string; id: string }, data: Doc) => {
          pending.push({ collection: ref._collection, id: ref.id, data });
        }),
        set: jest.fn((ref: { _collection: string; id: string }, data: Doc) => {
          pending.push({ collection: ref._collection, id: ref.id, data });
        }),
      };

      const result = await fn(mockGuardReadAfterWrite(txn));
      writes.push(...pending);
      return result;
    }),
  };
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
});

describe('markLoanDisbursed — the approved-status guard is re-decided at commit time', () => {
  const LOAN_ID = 'loan-1';
  const DISBURSE_INPUT = {
    loanId: LOAN_ID,
    stpTransactionId: 'STP-002',
    stpClaveRastreo: 'CLAVE-002',
    disbursedAmount: 5000,
    disbursedAt: new Date('2026-03-18T10:00:00.000Z').toISOString(),
  };

  const approvedLoan = (): Doc => ({
    status: 'approved',
    employerId: 'employer-abc',
    employeeId: 'user-123',
    userId: 'user-123',
    principalAmount: 5000,
    amount: 5000,
    total: 5300,
    term: 30,
    dueDate: MockTimestamp.fromDate(new Date('2026-04-15T10:00:00.000Z')),
    // Present so the handler takes the current path and does not try to
    // resolve a pay frequency; the race, not the due date, is what is on test.
    borrowerSnapshot: { payFrequency: 'monthly' },
  });

  async function loadHandler() {
    const { markLoanDisbursed } = await import('../loans/markLoanDisbursed');
    return markLoanDisbursed as unknown as (req: {
      auth?: unknown;
      data: unknown;
    }) => Promise<unknown>;
  }

  it('refuses a second disbursement that raced the first, instead of crediting the employer twice', async () => {
    const docs = {
      loans: { [LOAN_ID]: approvedLoan() },
      employers: { 'employer-abc': { currentOutstandingBalance: 0 } },
    };

    // The concurrent markLoanDisbursed wins: by the time this call's
    // transaction opens, the loan is already disbursed.
    mockDb = buildRacingDb(docs, () => {
      docs.loans[LOAN_ID] = { ...approvedLoan(), status: 'disbursed' };
    });

    const fn = await loadHandler();

    await expect(fn({ auth: OPS_AUTH, data: DISBURSE_INPUT })).rejects.toThrow(
      /Current: disbursed/
    );

    // The whole point: the employer's outstanding book is NOT credited a
    // second time for one loan. `FieldValue.increment` is commutative, so
    // Firestore would never have caught this on its own.
    expect(mockDb._writes.filter((w) => w.collection === 'employers')).toHaveLength(0);
    expect(mockDb._writes.filter((w) => w.collection === 'loans')).toHaveLength(0);
    expect(mockFieldValue.increment).not.toHaveBeenCalled();
  });

  it('still disburses normally when nothing races it', async () => {
    const docs = {
      loans: { [LOAN_ID]: approvedLoan() },
      employers: { 'employer-abc': { currentOutstandingBalance: 0 } },
    };
    mockDb = buildRacingDb(docs, () => {});

    const fn = await loadHandler();
    await expect(fn({ auth: OPS_AUTH, data: DISBURSE_INPUT })).resolves.toMatchObject({
      success: true,
      status: 'disbursed',
    });

    const loanWrite = mockDb._writes.find((w) => w.collection === 'loans');
    expect(loanWrite?.data['status']).toBe('disbursed');

    // Credited exactly once, for the principal the transaction itself read.
    const employerWrite = mockDb._writes.find((w) => w.collection === 'employers');
    expect(employerWrite?.data['currentOutstandingBalance']).toEqual({ _increment: 5000 });
    expect(mockFieldValue.increment).toHaveBeenCalledTimes(1);
  });

  it('puts the loan in the transaction read set, which is what forces the race to resolve', async () => {
    // A transaction that reads nothing cannot conflict with anything. This
    // asserts the structural property directly, so a future refactor that
    // keeps the guard but moves the read back outside is caught here rather
    // than only under a race the suite happens to simulate.
    const docs = {
      loans: { [LOAN_ID]: approvedLoan() },
      employers: { 'employer-abc': { currentOutstandingBalance: 0 } },
    };
    mockDb = buildRacingDb(docs, () => {});

    const fn = await loadHandler();
    await fn({ auth: OPS_AUTH, data: DISBURSE_INPUT });

    // The loan document specifically — not merely "some read happened".
    expect(mockDb._txReads).toContainEqual({ collection: 'loans', id: LOAN_ID });
  });
});

describe('submitReviewDecision — the #488 rewind guard is re-decided at commit time', () => {
  const REVIEW_ID = 'rev-1';
  const LOAN_ID = 'loan-1';

  async function loadHandler() {
    const { submitReviewDecision } = await import('../index');
    return submitReviewDecision as unknown as (req: {
      auth?: unknown;
      data: unknown;
    }) => Promise<unknown>;
  }

  it('refuses to reject a loan that started disbursing while the review was being decided', async () => {
    const docs = {
      review_queue: {
        [REVIEW_ID]: { status: 'info_requested', loanId: LOAN_ID, applicantName: 'Juan García' },
      },
      loans: { [LOAN_ID]: { status: 'under_review' } },
    };

    // onLoanApproved queues the real SoftCrédito transfer while ops is
    // deciding a review that stayed decidable by design (#407/#513).
    mockDb = buildRacingDb(docs, () => {
      docs.loans[LOAN_ID] = { status: 'disbursement_queued' };
    });

    const fn = await loadHandler();

    await expect(
      fn({ auth: OPS_AUTH, data: { reviewId: REVIEW_ID, decision: 'rejected', notes: 'n/a' } })
    ).rejects.toThrow(/disbursement has started/);

    // Rejecting a funded loan takes it out of DEDUCTIBLE_STATUSES, so
    // processPayroll silently stops collecting on money already paid out.
    // Nothing may land — not the loan write, and not the review_queue write
    // that would have consumed the review on the way past.
    expect(mockDb._writes.filter((w) => w.collection === 'loans')).toHaveLength(0);
    expect(mockDb._writes.filter((w) => w.collection === 'review_queue')).toHaveLength(0);
  });

  it('refuses a review a concurrent decision already resolved, rather than overwriting it', async () => {
    const docs = {
      review_queue: {
        [REVIEW_ID]: { status: 'pending_review', loanId: LOAN_ID, applicantName: 'Juan García' },
      },
      loans: { [LOAN_ID]: { status: 'under_review' } },
    };

    // Two ops decide the same review at once; the other one approved it first.
    mockDb = buildRacingDb(docs, () => {
      docs.review_queue[REVIEW_ID] = {
        status: 'approved',
        loanId: LOAN_ID,
        applicantName: 'Juan García',
      };
    });

    const fn = await loadHandler();

    await expect(
      fn({ auth: OPS_AUTH, data: { reviewId: REVIEW_ID, decision: 'rejected', notes: 'n/a' } })
    ).rejects.toThrow(/already been resolved/);

    expect(mockDb._writes.filter((w) => w.collection === 'loans')).toHaveLength(0);
  });

  it('still decides a review normally when nothing races it', async () => {
    const docs = {
      review_queue: {
        [REVIEW_ID]: { status: 'pending_review', loanId: LOAN_ID, applicantName: 'Juan García' },
      },
      loans: { [LOAN_ID]: { status: 'under_review' } },
    };
    mockDb = buildRacingDb(docs, () => {});

    const fn = await loadHandler();
    await expect(
      fn({ auth: OPS_AUTH, data: { reviewId: REVIEW_ID, decision: 'approved', notes: 'ok' } })
    ).resolves.toMatchObject({ success: true, decision: 'approved' });

    expect(
      mockDb._writes.find((w) => w.collection === 'loans')?.data['status']
    ).toBe('approved');
    expect(
      mockDb._writes.find((w) => w.collection === 'review_queue')?.data['status']
    ).toBe('approved');
  });
});
