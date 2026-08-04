// Cross-cutting regression coverage for two defects that only become visible
// when the commits between 361b09c and ded61c1 are read as ONE change set.
// Both are the #516 shape: the code that was fixed is not the code that runs.
//
// A. onLoanStatusChange restores the borrower's availableCredit on a rejection,
//    but only from `pending`. #488 widened the APPROVAL side of the very same
//    trigger to accept `under_review` as a source status (see
//    LOAN_APPROVAL_SOURCE_STATUSES, "since deployed config is
//    ML_MODE=manual_review_all, EVERY non-rejected loan takes that path
//    today"). The rejection side kept its hardcoded `=== 'pending'`. So the
//    ONLY rejection transition that happens in production —
//    `under_review -> rejected`, written by submitReviewDecision — restores
//    nothing, and the borrower's credit line shrinks by the requested amount
//    every time ops declines them.
//
// B. The deployed `approveEmployer` (inline in index.ts) never mints the
//    `employer_admin` custom claim. onEmployerDocCreated deliberately withholds
//    it at self-signup ("The normal path for a self-signup employer is
//    approveEmployer, which grants the claim on approval" — index.ts). The only
//    code that actually grants it on approval lives in
//    functions/src/employers/approveEmployer.ts, which index.ts does not export
//    and which is therefore not deployed. An approved employer is left with no
//    role claim at all and is refused by every withAuth(['employer_admin'])
//    callable.
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

// Both triggers are handed back rather than swallowed — the gate conditions
// inside them are the code under test.
jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentCreated: jest.fn(() => jest.fn()),
  onDocumentUpdated: jest.fn((_path: unknown, handler: unknown) => handler),
}));

jest.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: jest.fn(() => jest.fn()),
}));

const mockLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
jest.mock('firebase-functions', () => ({ logger: mockLogger }));
jest.mock('firebase-functions/v2', () => ({ logger: mockLogger }));

const mockSetCustomUserClaims = jest.fn().mockResolvedValue(undefined);
jest.mock('firebase-admin', () => ({
  auth: jest.fn(() => ({ setCustomUserClaims: mockSetCustomUserClaims })),
}));

class MockTimestamp {
  constructor(public seconds: number, public nanoseconds = 0) {}
  static now() {
    return new MockTimestamp(0);
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

interface Write {
  collection: string;
  id: string;
  op: string;
  data: Record<string, unknown>;
}

let mockDb: ReturnType<typeof buildMockDb>;
jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockDb),
  FieldValue: mockFieldValue,
  Timestamp: MockTimestamp,
}));

jest.mock('node-fetch', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../utils/rateLimiter', () => ({ checkRateLimit: jest.fn().mockResolvedValue(true) }));
jest.mock('../utils/notify', () => ({ notifyLoanEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/slackAlert', () => ({ sendSlackAlert: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/sentry', () => ({ initSentry: jest.fn(), captureException: jest.fn() }));

function buildMockDb(seed: Record<string, Record<string, Record<string, unknown>>> = {}) {
  const store = new Map<string, { data: Record<string, unknown> }>();
  for (const [collection, docs] of Object.entries(seed)) {
    for (const [id, data] of Object.entries(docs)) {
      store.set(`${collection}/${id}`, { data });
    }
  }
  const writes: Write[] = [];

  return {
    collection: jest.fn((name: string) => ({
      doc: jest.fn((id: string) => {
        const key = `${name}/${id}`;
        return {
          id,
          _key: key,
          get: jest.fn(async () => {
            const entry = store.get(key);
            return entry
              ? { exists: true, data: () => entry.data }
              : { exists: false, data: () => undefined };
          }),
          update: jest.fn(async (data: Record<string, unknown>) => {
            const prev = store.get(key)?.data ?? {};
            store.set(key, { data: { ...prev, ...data } });
            writes.push({ collection: name, id, op: 'update', data });
          }),
          set: jest.fn(async (data: Record<string, unknown>) => {
            store.set(key, { data });
            writes.push({ collection: name, id, op: 'set', data });
          }),
        };
      }),
      add: jest.fn(async (data: Record<string, unknown>) => {
        writes.push({ collection: name, id: 'generated', op: 'add', data });
        return { id: 'generated' };
      }),
    })),
    // Bundles a transaction's `tx.update()` calls and applies them to the same
    // `store` only once the callback returns without throwing — submitReviewDecision
    // relies on this all-or-nothing commit to keep its review_queue and loans
    // writes atomic.
    runTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const pending: Array<{ key: string; collection: string; id: string; data: Record<string, unknown> }> = [];
      const tx = {
        get: jest.fn(async (ref: { _key: string }) => {
          const entry = store.get(ref._key);
          return entry ? { exists: true, data: () => entry.data } : { exists: false, data: () => undefined };
        }),
        update: jest.fn((ref: { _key: string; id: string }, data: Record<string, unknown>) => {
          const [collection] = ref._key.split('/');
          pending.push({ key: ref._key, collection: collection!, id: ref.id, data });
        }),
      };
      const result = await fn(tx);
      for (const p of pending) {
        const prev = store.get(p.key)?.data ?? {};
        store.set(p.key, { data: { ...prev, ...p.data } });
        writes.push({ collection: p.collection, id: p.id, op: 'tx.update', data: p.data });
      }
      return result;
    }),
    _writes: writes,
    _store: store,
  };
}

function writesFor(collection: string, id: string) {
  return mockDb._writes.filter((w) => w.collection === collection && w.id === id);
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockSetCustomUserClaims.mockResolvedValue(undefined);
  delete process.env['REDIS_URL'];
  delete process.env['SOFTCREDITO_ADAPTER_URL'];
});

// ── A. credit release on the only rejection transition production produces ───

const LOAN = {
  employeeId: 'emp-1',
  employerId: 'employer-1',
  employeeName: 'Juan García',
  employeeEmail: 'juan@example.com',
  employeePhone: '5550100',
  amount: 3000,
};

type TriggerEvent = {
  params: { loanId: string };
  data: { before: { data: () => unknown }; after: { data: () => unknown } };
};

function rejectionEvent(beforeStatus: string): TriggerEvent {
  return {
    params: { loanId: 'loan-1' },
    data: {
      before: { data: () => ({ ...LOAN, status: beforeStatus }) },
      after: { data: () => ({ ...LOAN, status: 'rejected' }) },
    },
  };
}

async function loadStatusChangeTrigger() {
  const { onLoanStatusChange } = await import('../index');
  return onLoanStatusChange as unknown as (e: TriggerEvent) => Promise<unknown>;
}

describe('onLoanStatusChange — credit release on rejection (deployed copy in index.ts)', () => {
  it('restores the borrower credit held for a pending loan (the path that already worked)', async () => {
    mockDb = buildMockDb();
    const trigger = await loadStatusChangeTrigger();

    await trigger(rejectionEvent('pending'));

    expect(writesFor('employees', 'emp-1')).toContainEqual(
      expect.objectContaining({ data: { availableCredit: { _increment: 3000 } } })
    );
  });

  // requestLoan holds credit for EVERY status it creates except 'rejected'
  // (`holdCredit = initialStatus !== 'rejected'`), and creates the loan as
  // `under_review` whenever the pipeline returns pending_review — which, with
  // ML_MODE resolving to shadow/manual_review_all, is every non-rejected loan.
  // submitReviewDecision then writes `status: 'rejected'` straight onto the
  // loan. Nothing else in functions/ touches availableCredit on a rejection,
  // so if this trigger does not fire the hold is permanent.
  it('restores the borrower credit held for an under_review loan declined by ops', async () => {
    mockDb = buildMockDb();
    const trigger = await loadStatusChangeTrigger();

    await trigger(rejectionEvent('under_review'));

    expect(writesFor('employees', 'emp-1')).toContainEqual(
      expect.objectContaining({ data: { availableCredit: { _increment: 3000 } } })
    );
  });

  it('does not restore credit twice when an already-rejected loan is written again', async () => {
    mockDb = buildMockDb();
    const trigger = await loadStatusChangeTrigger();

    await trigger(rejectionEvent('rejected'));

    expect(writesFor('employees', 'emp-1')).toHaveLength(0);
  });

  // A loan whose disbursement has already started must never hand the borrower
  // their credit back — the money is out the door.
  it('does not restore credit on a post-disbursement status written to rejected', async () => {
    mockDb = buildMockDb();
    const trigger = await loadStatusChangeTrigger();

    await trigger(rejectionEvent('active'));

    expect(writesFor('employees', 'emp-1')).toHaveLength(0);
  });
});

// ── B. employer_admin claim on the deployed approval path ────────────────────

type ApproveEmployerFn = (req: { auth?: unknown; data: unknown }) => Promise<{
  success: boolean;
  approved: boolean;
}>;

describe('approveEmployer — employer_admin claim (deployed handler in index.ts)', () => {
  const auth = { uid: 'admin-1', token: { role: 'admin', email: 'admin@example.com' } };

  function seedPendingEmployer() {
    return buildMockDb({
      employers: {
        'employer-1': {
          companyName: 'Acme Corp',
          name: 'Ana Ruiz',
          email: 'acme@example.com',
          status: 'pending_verification',
        },
      },
    });
  }

  it('mints the employer_admin claim so an approved employer can use their dashboard', async () => {
    mockDb = seedPendingEmployer();
    const { approveEmployer } = await import('../index');

    const result = await (approveEmployer as unknown as ApproveEmployerFn)({
      auth,
      data: { employerUid: 'employer-1', approved: true },
    });

    expect(result.success).toBe(true);
    expect(mockSetCustomUserClaims).toHaveBeenCalledWith('employer-1', { role: 'employer_admin' });
  });

  // Same invariant onEmployerDocCreated and setEmployerClaims already hold: an
  // employer_admin grant with no attributable record is worse than no grant.
  it('records the grant in audit_log before minting it', async () => {
    mockDb = seedPendingEmployer();
    const { approveEmployer } = await import('../index');

    await (approveEmployer as unknown as ApproveEmployerFn)({
      auth,
      data: { employerUid: 'employer-1', approved: true },
    });

    const grantLog = mockDb._writes.find(
      (w) => w.collection === 'audit_log' && w.data['action'] === 'employer.claimGrantedOnApproval'
    );
    expect(grantLog).toBeDefined();
    expect(grantLog!.data).toMatchObject({ targetId: 'employer-1', actorUid: 'admin-1' });
  });

  it('does not mint the claim when the request is a reject', async () => {
    mockDb = seedPendingEmployer();
    const { approveEmployer } = await import('../index');

    await expect(
      (approveEmployer as unknown as ApproveEmployerFn)({
        auth,
        data: { employerUid: 'employer-1', decision: 'rejected' },
      })
    ).rejects.toMatchObject({ code: 'unimplemented' });

    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
  });
});

// ── C. submitReviewDecision has no disbursement rewind guard ─────────────────
//
// #488 gave `updateLoanStatus` an explicit guard against rewinding a loan out
// of DISBURSEMENT_INITIATED_STATUSES back into a pre-disbursement status,
// because that is how ops tooling re-fires a real SPEI transfer. The other
// callable that writes `loans/{loanId}.status` — submitReviewDecision — never
// got one, and it writes the status unconditionally.
//
// It is reachable because `request_info` and `escalated` reviews stay decidable
// indefinitely (deliberately, #407/#513) while the loan they point at can move
// on independently: ops approves the loan itself through updateLoanStatus,
// onLoanApproved disburses it, and the stale review is still sitting in the
// queue. Deciding it then flips a funded loan to 'rejected' — which is not in
// DEDUCTIBLE_STATUSES, so processPayroll stops collecting on a loan whose money
// has already left the building.

type SubmitReviewDecisionFn = (req: { auth?: unknown; data: unknown }) => Promise<{
  success: boolean;
}>;

describe('submitReviewDecision — loan write on an already-funded loan', () => {
  const opsAuth = { uid: 'ops-1', token: { role: 'ops', email: 'ops@example.com' } };

  function seed(loanStatus: string, reviewStatus = 'info_requested') {
    return buildMockDb({
      review_queue: {
        'review-1': { status: reviewStatus, loanId: 'loan-1', employeeId: 'emp-1' },
      },
      loans: {
        'loan-1': { ...LOAN, status: loanStatus },
      },
    });
  }

  it('refuses to reject a loan whose disbursement has already started', async () => {
    mockDb = seed('active');
    const { submitReviewDecision } = await import('../index');

    await expect(
      (submitReviewDecision as unknown as SubmitReviewDecisionFn)({
        auth: opsAuth,
        data: { reviewId: 'review-1', decision: 'rejected' },
      })
    ).rejects.toMatchObject({ code: 'failed-precondition' });

    expect(writesFor('loans', 'loan-1')).toHaveLength(0);
  });

  it('refuses to re-approve a loan whose disbursement has already started', async () => {
    mockDb = seed('disbursement_queued');
    const { submitReviewDecision } = await import('../index');

    await expect(
      (submitReviewDecision as unknown as SubmitReviewDecisionFn)({
        auth: opsAuth,
        data: { reviewId: 'review-1', decision: 'approved' },
      })
    ).rejects.toMatchObject({ code: 'failed-precondition' });

    expect(writesFor('loans', 'loan-1')).toHaveLength(0);
  });

  it('still decides a review whose loan is genuinely still under_review', async () => {
    mockDb = seed('under_review');
    const { submitReviewDecision } = await import('../index');

    const result = await (submitReviewDecision as unknown as SubmitReviewDecisionFn)({
      auth: opsAuth,
      data: { reviewId: 'review-1', decision: 'approved' },
    });

    expect(result.success).toBe(true);
    expect(writesFor('loans', 'loan-1')).toContainEqual(
      expect.objectContaining({ data: expect.objectContaining({ status: 'approved' }) })
    );
  });

  // request_info and escalate deliberately do not touch the loan, so they must
  // stay usable on a review whatever the loan has since done — otherwise the
  // review becomes the dead end #407 and #513 exist to prevent.
  it('still allows request_info on a review whose loan has moved on', async () => {
    mockDb = seed('active', 'pending');
    const { submitReviewDecision } = await import('../index');

    const result = await (submitReviewDecision as unknown as SubmitReviewDecisionFn)({
      auth: opsAuth,
      data: { reviewId: 'review-1', decision: 'request_info' },
    });

    expect(result.success).toBe(true);
    expect(writesFor('loans', 'loan-1')).toHaveLength(0);
  });
});
