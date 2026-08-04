// Regression tests for two P0 defects in the loan disbursement path.
//
// P0-A: both onLoanStatusChange and onLoanApproved gated on the exact
// transition `pending → approved`. But a loan routed to manual review is
// created as `under_review`, and submitReviewDecision approves directly from
// `under_review`. That transition matched neither trigger, so a
// manual-review approval — the ONLY approval path in production, since
// deployed config is ML_MODE=manual_review_all — never queued a
// disbursement, never called SoftCrédito, never registered the payroll
// deduction, and never incremented the employer's counters. The loan sat at
// `approved` forever.
//
// P0-B: `updateLoanStatus` let an admin/ops caller write ANY status to ANY
// loan with no state-machine validation. Two calls — set `pending`, then set
// `approved` — reproduce the trigger diff on a loan that has ALREADY been
// disbursed, and the trigger had no server-side guard against re-entering the
// real SoftCrédito `/internal/disburse` call. Money could move twice.
//
// See this file's sibling `export {}` note in submitReviewDecision.test.ts —
// this file has no top-level `import` either without it, so it needs the same
// treatment to avoid colliding top-level `const` declarations across suites.
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

// Unlike submitReviewDecision.test.ts, the trigger handlers are handed back
// rather than swallowed — onLoanApproved and onLoanStatusChange are the code
// under test here, not scaffolding. Mocking them out (as
// `onDocumentUpdated: jest.fn(() => jest.fn())` does elsewhere) is exactly
// why P0-A shipped undetected: the gate condition inside the handler was
// never exercised by any test.
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

interface StoreEntry {
  exists: boolean;
  data: Record<string, unknown>;
}

interface Write {
  collection: string;
  id: string;
  op: string;
  data: Record<string, unknown>;
}

/**
 * A small, realistic in-memory Firestore stand-in: doc refs read/write a
 * shared Map, and `runTransaction` operates on that same Map so a
 * transactional claim (tx.get + tx.set/tx.update) actually behaves like one —
 * required to exercise onLoanApproved's idempotency guard for real, not as a
 * pass-through mock that would hide a broken guard.
 */
function buildMockDb(seed: Record<string, Record<string, Record<string, unknown>>> = {}) {
  const store = new Map<string, StoreEntry>();
  for (const [collection, docs] of Object.entries(seed)) {
    for (const [id, data] of Object.entries(docs)) {
      store.set(`${collection}/${id}`, { exists: true, data });
    }
  }

  const writes: Write[] = [];

  function makeDocRef(collection: string, id: string) {
    const key = `${collection}/${id}`;
    return {
      id,
      _key: key,
      get: jest.fn(async () => {
        const entry = store.get(key);
        return entry ? { exists: true, data: () => entry.data } : { exists: false, data: () => undefined };
      }),
      set: jest.fn(async (data: Record<string, unknown>) => {
        store.set(key, { exists: true, data });
        writes.push({ collection, id, op: 'set', data });
      }),
      update: jest.fn(async (data: Record<string, unknown>) => {
        const prev = store.get(key)?.data ?? {};
        const merged = { ...prev, ...data };
        store.set(key, { exists: true, data: merged });
        writes.push({ collection, id, op: 'update', data });
      }),
    };
  }

  return {
    collection: jest.fn((name: string) => ({
      doc: jest.fn((id: string) => makeDocRef(name, id)),
      add: jest.fn(async (data: Record<string, unknown>) => {
        writes.push({ collection: name, id: 'generated', op: 'add', data });
        return { id: 'generated' };
      }),
    })),
    runTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        get: jest.fn(async (ref: { _key: string }) => {
          const entry = store.get(ref._key);
          return entry ? { exists: true, data: () => entry.data } : { exists: false, data: () => undefined };
        }),
        set: jest.fn((ref: { _key: string }, data: Record<string, unknown>) => {
          store.set(ref._key, { exists: true, data });
          const [collection, id] = ref._key.split('/');
          writes.push({ collection: collection!, id: id!, op: 'tx.set', data });
        }),
        update: jest.fn((ref: { _key: string }, data: Record<string, unknown>) => {
          const prev = store.get(ref._key)?.data ?? {};
          const merged = { ...prev, ...data };
          store.set(ref._key, { exists: true, data: merged });
          const [collection, id] = ref._key.split('/');
          writes.push({ collection: collection!, id: id!, op: 'tx.update', data });
        }),
      };
      return fn(tx);
    }),
    _store: store,
    _writes: writes,
  };
}

const LOAN_BASE = {
  employeeId: 'emp-1',
  employeeName: 'Juan García',
  employerId: 'employer-1',
  employerName: 'Test Co',
  amount: 1000,
  total: 1300,
  term: 30,
  dueDate: MockTimestamp.fromDate(new Date('2026-09-01T00:00:00.000Z')),
};

const EMPLOYEE = { bankClabe: 'CLABE123', bankName: 'BBVA', phone: '555-0100', email: 'juan@example.com' };

type TriggerEvent = { params: { loanId: string }; data: { before: { data: () => unknown }; after: { data: () => unknown } } };

function approvalEvent(loanId: string, beforeStatus: string, afterStatus: string): TriggerEvent {
  return {
    params: { loanId },
    data: {
      before: { data: () => ({ ...LOAN_BASE, status: beforeStatus }) },
      after: { data: () => ({ ...LOAN_BASE, status: afterStatus }) },
    },
  };
}

async function loadTriggers() {
  const { onLoanApproved, onLoanStatusChange } = await import('../index');
  // The predicate lives in its own module, not in index.ts: every export from
  // index.ts is read as a deployable Cloud Function by the #376 deploy-drift gate.
  const { isLoanApprovalTransition } = await import('../loans/loanStatusTransitions');
  return {
    onLoanApproved: onLoanApproved as unknown as (event: TriggerEvent) => Promise<unknown>,
    onLoanStatusChange: onLoanStatusChange as unknown as (event: TriggerEvent) => Promise<unknown>,
    isLoanApprovalTransition,
  };
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  process.env['SOFTCREDITO_ADAPTER_URL'] = 'https://sc.example.test';
  process.env['INTERNAL_SECRET'] = 'test-secret';
  delete process.env['ALLOW_STUB_DISBURSEMENT'];
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
  delete process.env['ALLOW_STUB_DISBURSEMENT'];
});

describe('isLoanApprovalTransition — the gate predicate shared by both triggers', () => {
  it('fires for pending → approved (auto-approve path)', async () => {
    mockDb = buildMockDb();
    const { isLoanApprovalTransition } = await loadTriggers();
    expect(isLoanApprovalTransition('pending', 'approved')).toBe(true);
  });

  it('fires for under_review → approved (the manual-review path P0-A missed)', async () => {
    mockDb = buildMockDb();
    const { isLoanApprovalTransition } = await loadTriggers();
    expect(isLoanApprovalTransition('under_review', 'approved')).toBe(true);
  });

  it('does not fire for a re-approval from a post-disbursement status (P0-B)', async () => {
    mockDb = buildMockDb();
    const { isLoanApprovalTransition } = await loadTriggers();
    expect(isLoanApprovalTransition('disbursement_queued', 'approved')).toBe(false);
    expect(isLoanApprovalTransition('active', 'approved')).toBe(false);
  });

  it('does not fire when the destination is not approved', async () => {
    mockDb = buildMockDb();
    const { isLoanApprovalTransition } = await loadTriggers();
    expect(isLoanApprovalTransition('under_review', 'rejected')).toBe(false);
  });
});

describe('onLoanApproved — P0-A: manual-review approvals must disburse', () => {
  it('queues and disburses a loan approved FROM under_review (previously silently ignored)', async () => {
    mockDb = buildMockDb({
      loans: { 'loan-1': { ...LOAN_BASE, status: 'approved' } },
      employees: { 'emp-1': EMPLOYEE },
    });
    const { onLoanApproved } = await loadTriggers();

    await onLoanApproved(approvalEvent('loan-1', 'under_review', 'approved'));

    const queueWrite = mockDb._writes.find((w) => w.collection === 'disbursement_queue' && w.op === 'tx.set');
    expect(queueWrite).toBeDefined();
    expect(queueWrite?.data['status']).toBe('queued');

    const disburseCall = mockFetch.mock.calls.find(([url]) => String(url).endsWith('/internal/disburse'));
    expect(disburseCall).toBeDefined();

    expect(mockDb._store.get('loans/loan-1')?.data['status']).toBe('active');
    expect(mockDb._store.get('loans/loan-1')?.data['disbursedAt']).toBeDefined();
  });

  it('still disburses a loan approved from pending (existing behaviour preserved)', async () => {
    mockDb = buildMockDb({
      loans: { 'loan-1': { ...LOAN_BASE, status: 'approved' } },
      employees: { 'emp-1': EMPLOYEE },
    });
    const { onLoanApproved } = await loadTriggers();

    await onLoanApproved(approvalEvent('loan-1', 'pending', 'approved'));

    expect(mockFetch.mock.calls.some(([url]) => String(url).endsWith('/internal/disburse'))).toBe(true);
  });

  it('does not disburse a transition into approved from a non-pre-approval status', async () => {
    mockDb = buildMockDb({
      loans: { 'loan-1': { ...LOAN_BASE, status: 'approved' } },
      employees: { 'emp-1': EMPLOYEE },
    });
    const { onLoanApproved } = await loadTriggers();

    await onLoanApproved(approvalEvent('loan-1', 'rejected', 'approved'));

    expect(mockDb._writes.some((w) => w.collection === 'disbursement_queue')).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('onLoanApproved — P0-B: idempotency guard against a replayed approval', () => {
  it('does not re-disburse when a disbursement_queue entry already exists for the loan', async () => {
    mockDb = buildMockDb({
      loans: { 'loan-1': { ...LOAN_BASE, status: 'approved' } },
      employees: { 'emp-1': EMPLOYEE },
      disbursement_queue: { 'loan-1': { loanId: 'loan-1', status: 'completed' } },
    });
    const { onLoanApproved } = await loadTriggers();

    await onLoanApproved(approvalEvent('loan-1', 'under_review', 'approved'));

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('already claimed'),
      expect.objectContaining({ loanId: 'loan-1' })
    );
  });

  it('does not re-disburse when the loan already carries a disbursedAt from a prior fire', async () => {
    mockDb = buildMockDb({
      loans: { 'loan-1': { ...LOAN_BASE, status: 'approved', disbursedAt: MockTimestamp.now() } },
      employees: { 'emp-1': EMPLOYEE },
    });
    const { onLoanApproved } = await loadTriggers();

    await onLoanApproved(approvalEvent('loan-1', 'under_review', 'approved'));

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('two concurrent-looking fires for the same loan only ever disburse once', async () => {
    mockDb = buildMockDb({
      loans: { 'loan-1': { ...LOAN_BASE, status: 'approved' } },
      employees: { 'emp-1': EMPLOYEE },
    });
    const { onLoanApproved } = await loadTriggers();
    const event = approvalEvent('loan-1', 'under_review', 'approved');

    await onLoanApproved(event);
    await onLoanApproved(event);

    const disburseCalls = mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/internal/disburse'));
    expect(disburseCalls).toHaveLength(1);
  });
});

describe('onLoanApproved — payroll-deduction registration failure must not be silent', () => {
  // The disbursement call and the deduction-registration call hit the same
  // adapter for two different purposes; mock both so a test can make one
  // succeed and the other fail independently.
  function mockAdapter({ disburseOk = true, deductionOk = true } = {}) {
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/internal/disburse')) {
        return disburseOk
          ? { ok: true, status: 200, json: async () => ({ ref: 'SPEI-1' }), text: async () => '' }
          : { ok: false, status: 500, json: async () => ({}), text: async () => 'disburse down' };
      }
      if (String(url).endsWith('/internal/register-deduction')) {
        return deductionOk
          ? { ok: true, status: 200, json: async () => ({ deductionId: 'DED-1' }), text: async () => '' }
          : { ok: false, status: 500, json: async () => ({}), text: async () => 'adapter down' };
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
  }

  it('CONTROL: a healthy adapter registers the deduction and records its id on the loan', async () => {
    mockDb = buildMockDb({
      loans: { 'loan-1': { ...LOAN_BASE, status: 'approved' } },
      employees: { 'emp-1': EMPLOYEE },
    });
    mockAdapter();
    const { onLoanApproved } = await loadTriggers();

    await onLoanApproved(approvalEvent('loan-1', 'under_review', 'approved'));

    expect(mockDb._store.get('loans/loan-1')?.data['softcreditoDeductionId']).toBe('DED-1');
    expect(mockDb._store.get('loans/loan-1')?.data['payrollDeductionError']).toBeUndefined();
  });

  it('RED: does not silently drop a failed deduction registration after real funds moved', async () => {
    mockDb = buildMockDb({
      loans: { 'loan-1': { ...LOAN_BASE, status: 'approved' } },
      employees: { 'emp-1': EMPLOYEE },
    });
    // Disbursement succeeds — money really did move — but the adapter's
    // register-deduction endpoint answers with a plain HTTP error, the
    // ordinary shape of an outage or a bad deploy. No fetch-level throw.
    mockAdapter({ disburseOk: true, deductionOk: false });
    const { onLoanApproved } = await loadTriggers();
    const { sendSlackAlert } = await import('../utils/slackAlert');

    await onLoanApproved(approvalEvent('loan-1', 'under_review', 'approved'));

    // The borrower really was funded...
    expect(mockDb._store.get('loans/loan-1')?.data['status']).toBe('active');

    // ...but nothing else in the codebase ever reads `softcreditoDeductionId`
    // to notice it is missing, so ops has to be told directly: an error log,
    // a Slack page, and a flag on the loan itself. Pre-fix, the handler's
    // `if (r.ok) {...}` on a `!ok` response does nothing on the else branch —
    // no throw, so the catch block never runs either, and NONE of the three
    // assertions below hold.
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Payroll deduction'),
      expect.objectContaining({ loanId: 'loan-1' })
    );
    expect(sendSlackAlert).toHaveBeenCalledWith(expect.stringContaining('loan-1'), 'critical');
    expect(mockDb._store.get('loans/loan-1')?.data['payrollDeductionError']).toBeDefined();
  });
});

describe('updateLoanStatus — P0-B: ops/admin cannot rewind a disbursed loan', () => {
  const opsAuth = { uid: 'ops-1', token: { role: 'ops' } };

  async function loadUpdateLoanStatus() {
    const { updateLoanStatus } = await import('../index');
    return updateLoanStatus as unknown as (req: { auth?: unknown; data: unknown }) => Promise<{ success: boolean }>;
  }

  it('refuses to move a queued-for-disbursement loan back to pending (the replay setup step)', async () => {
    mockDb = buildMockDb({ loans: { 'loan-1': { status: 'disbursement_queued', employerId: 'employer-1' } } });
    const fn = await loadUpdateLoanStatus();

    await expect(
      fn({ auth: opsAuth, data: { loanId: 'loan-1', status: 'pending' } })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('refuses to move an already-active loan back to approved', async () => {
    mockDb = buildMockDb({ loans: { 'loan-1': { status: 'active', employerId: 'employer-1' } } });
    const fn = await loadUpdateLoanStatus();

    await expect(
      fn({ auth: opsAuth, data: { loanId: 'loan-1', status: 'approved' } })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('still allows a genuine ops correction: retrying a failed disbursement', async () => {
    mockDb = buildMockDb({ loans: { 'loan-1': { status: 'disbursement_failed', employerId: 'employer-1' } } });
    const fn = await loadUpdateLoanStatus();

    await expect(
      fn({ auth: opsAuth, data: { loanId: 'loan-1', status: 'disbursement_queued' } })
    ).resolves.toMatchObject({ success: true });
  });

  it('still allows ops to approve a loan that has not been disbursed yet', async () => {
    mockDb = buildMockDb({ loans: { 'loan-1': { status: 'under_review', employerId: 'employer-1' } } });
    const fn = await loadUpdateLoanStatus();

    await expect(
      fn({ auth: opsAuth, data: { loanId: 'loan-1', status: 'approved' } })
    ).resolves.toMatchObject({ success: true });
  });
});
