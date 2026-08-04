import { guardReadAfterWrite as mockGuardReadAfterWrite } from '../__mocks__/txReadAfterWrite';
// Regression tests for #407 — `request_info` and `escalate` used to be permanent
// dead ends. The precondition only accepted `pending`/`pending_review`, so once a
// review moved to `info_requested` or `escalated` no further decision could ever be
// submitted. The loan stayed in `under_review`, which requestLoan counts as an
// occupied slot, locking the employee out of the product with no recovery path.

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

interface Written {
  collection: string;
  id: string;
  data: Record<string, unknown>;
}

function buildMockDb({
  reviewStatus = 'pending_review',
  // Simulates the loan write half of this callable failing (a transient
  // Firestore outage, contention, whatever) — while the review_queue write
  // succeeds. Applies to BOTH call shapes so the same flag exercises the bug
  // whether the code writes the two documents with independent `.update()`
  // calls (pre-fix) or bundles them in a `db.runTransaction()` (post-fix): in
  // the transaction case the failure surfaces at commit, after the callback
  // has queued both writes, so nothing the callback did lands.
  simulateLoanWriteFailure = false,
}: { reviewStatus?: string; simulateLoanWriteFailure?: boolean } = {}) {
  const writes: Written[] = [];
  const review = { status: reviewStatus, loanId: 'loan-1', applicantName: 'Juan García' };
  const loan = { status: 'under_review' };

  const docFor = (collection: string, id: string) => ({
    id,
    _collection: collection,
    get: jest.fn().mockResolvedValue({
      exists: true,
      id,
      data: () => (collection === 'review_queue' ? review : loan),
    }),
    update: jest.fn(async (data: Record<string, unknown>) => {
      if (collection === 'loans' && simulateLoanWriteFailure) {
        throw new Error('FIRESTORE_UNAVAILABLE: loan update failed (simulated outage)');
      }
      writes.push({ collection, id, data });
      if (collection === 'review_queue' && typeof data['status'] === 'string') {
        review.status = data['status'] as string;
      }
      if (collection === 'loans' && typeof data['status'] === 'string') {
        loan.status = data['status'] as string;
      }
    }),
  });

  const reviewRef = docFor('review_queue', 'rev-1');
  const loanRef = docFor('loans', 'loan-1');

  return {
    collection: jest.fn((name: string) => ({
      doc: jest.fn((id: string) =>
        name === 'review_queue' ? reviewRef : name === 'loans' ? loanRef : docFor(name, id)
      ),
      add: jest.fn(async (data: Record<string, unknown>) => {
        writes.push({ collection: name, id: 'generated', data });
        return { id: 'generated' };
      }),
    })),
    // Only reachable by the post-fix handler, which bundles the review_queue
    // and loans writes into one transaction. Buffers both `tx.update()` calls
    // and only applies them — atomically, all or nothing — once the callback
    // returns without throwing, the same all-or-nothing guarantee a real
    // Firestore transaction commit gives.
    runTransaction: jest.fn(
      async (
        fn: (txn: { get: jest.Mock; update: jest.Mock }) => Promise<unknown>
      ) => {
        const pending: Array<{ ref: { _collection: string; id: string }; data: Record<string, unknown> }> = [];
        const txn = {
          get: jest.fn(async (ref: { _collection: string }) =>
            ref._collection === 'review_queue'
              ? { exists: true, data: () => review }
              : { exists: true, data: () => loan }
          ),
          update: jest.fn((ref: { _collection: string; id: string }, data: Record<string, unknown>) => {
            pending.push({ ref, data });
          }),
        };
        const result = await fn(mockGuardReadAfterWrite(txn));
        if (simulateLoanWriteFailure && pending.some((p) => p.ref._collection === 'loans')) {
          throw new Error('FIRESTORE_UNAVAILABLE: transaction commit failed (simulated outage)');
        }
        for (const { ref, data } of pending) {
          writes.push({ collection: ref._collection, id: ref.id, data });
          if (ref._collection === 'review_queue' && typeof data['status'] === 'string') {
            review.status = data['status'] as string;
          }
          if (ref._collection === 'loans' && typeof data['status'] === 'string') {
            loan.status = data['status'] as string;
          }
        }
        return result;
      }
    ),
    _writes: writes,
    _review: review,
    _loan: loan,
  };
}

type Handler = (req: { auth?: unknown; data: unknown }) => Promise<{ success: boolean }>;

const opsAuth = { uid: 'ops-1', token: { role: 'ops', email: 'ops@vidafinance.mx' } };
const adminAuth = { uid: 'admin-1', token: { role: 'admin', email: 'admin@vidafinance.mx' } };

async function loadHandler(): Promise<Handler> {
  const { submitReviewDecision } = await import('../index');
  return submitReviewDecision as unknown as Handler;
}

describe('submitReviewDecision — #407 dead-end regressions', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue(true);
  });

  it('lets ops decide a review that is already in info_requested (the answer can land)', async () => {
    mockDb = buildMockDb({ reviewStatus: 'info_requested' });
    const fn = await loadHandler();

    await expect(fn({ auth: opsAuth, data: { reviewId: 'rev-1', decision: 'approved' } })).resolves.toMatchObject({
      success: true,
    });

    const loanWrite = mockDb._writes.find((w) => w.collection === 'loans');
    expect(loanWrite?.data['status']).toBe('approved');
  });

  it('records who asked for information and when', async () => {
    mockDb = buildMockDb({ reviewStatus: 'pending_review' });
    const fn = await loadHandler();

    await fn({ auth: opsAuth, data: { reviewId: 'rev-1', decision: 'request_info' } });

    const reviewWrite = mockDb._writes.find((w) => w.collection === 'review_queue');
    expect(reviewWrite?.data['status']).toBe('info_requested');
    expect(reviewWrite?.data['infoRequestedBy']).toBe('ops-1');
    expect(reviewWrite?.data['infoRequestedAt']).toBeDefined();
  });

  it('does not strand the loan when ops requests information', async () => {
    mockDb = buildMockDb({ reviewStatus: 'pending_review' });
    const fn = await loadHandler();

    await fn({ auth: opsAuth, data: { reviewId: 'rev-1', decision: 'request_info' } });

    // The loan legitimately stays `under_review` — but only because the review is
    // still decidable. Proven by deciding it immediately afterwards.
    expect(mockDb._writes.find((w) => w.collection === 'loans')).toBeUndefined();
    await expect(fn({ auth: opsAuth, data: { reviewId: 'rev-1', decision: 'rejected' } })).resolves.toMatchObject({
      success: true,
    });
  });

  it('blocks ops from resolving an escalated review', async () => {
    mockDb = buildMockDb({ reviewStatus: 'escalated' });
    const fn = await loadHandler();

    await expect(
      fn({ auth: opsAuth, data: { reviewId: 'rev-1', decision: 'approved' } })
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('lets an admin resolve an escalated review', async () => {
    mockDb = buildMockDb({ reviewStatus: 'escalated' });
    const fn = await loadHandler();

    await expect(
      fn({ auth: adminAuth, data: { reviewId: 'rev-1', decision: 'approved' } })
    ).resolves.toMatchObject({ success: true });
  });

  it('refuses to re-escalate an already escalated review', async () => {
    mockDb = buildMockDb({ reviewStatus: 'escalated' });
    const fn = await loadHandler();

    await expect(
      fn({ auth: adminAuth, data: { reviewId: 'rev-1', decision: 'escalate' } })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('still refuses to re-decide a genuinely terminal review', async () => {
    mockDb = buildMockDb({ reviewStatus: 'approved' });
    const fn = await loadHandler();

    await expect(
      fn({ auth: adminAuth, data: { reviewId: 'rev-1', decision: 'rejected' } })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  // The review_queue write and the loans write are two separate statements
  // about the same decision ("this was decided" / "here is what was
  // decided"), and they must land together or not at all. Before this fix
  // they were two independent `.update()` calls: if the loan write failed
  // after the review_queue write had already landed, the review was left
  // marked `approved` — which DECIDABLE_REVIEW_STATUSES excludes, so this
  // review can never be resubmitted through this callable again — while the
  // loan itself never left `under_review`. That borrower's loan is then
  // stuck forever with no route back to a decision: the review says decided,
  // the loan says undecided, and nothing in the product can reconcile the two.
  it('CONTROL: a normal approve moves both the review and the loan together', async () => {
    mockDb = buildMockDb({ reviewStatus: 'pending_review' });
    const fn = await loadHandler();

    await expect(
      fn({ auth: opsAuth, data: { reviewId: 'rev-1', decision: 'approved' } })
    ).resolves.toMatchObject({ success: true });

    expect(mockDb._review.status).toBe('approved');
    expect(mockDb._loan.status).toBe('approved');
  });

  it('RED (atomicity): does not strand the review as decided when the loan write fails', async () => {
    mockDb = buildMockDb({ reviewStatus: 'pending_review', simulateLoanWriteFailure: true });
    const fn = await loadHandler();

    await expect(
      fn({ auth: opsAuth, data: { reviewId: 'rev-1', decision: 'approved' } })
    ).rejects.toThrow();

    // The failed call must leave BOTH documents exactly as they were — never
    // a review marked decided next to a loan that never moved. Pre-fix, the
    // review_queue `.update()` succeeds and commits before the loans
    // `.update()` throws, so `_review.status` is already 'approved' here:
    // this assertion is the one that fails against the pre-fix code.
    expect(mockDb._review.status).toBe('pending_review');
    expect(mockDb._loan.status).toBe('under_review');
  });
});
