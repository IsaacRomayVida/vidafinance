// Pins the behaviour of the LIVE `updateLoanStatus` callable — the one inline
// in `index.ts` (exported from there and listed in deploy.yml's FUNCTIONS).
//
// NOTE ON WHAT IS UNDER TEST: `functions/src/loans/updateLoanStatus.ts` is NOT
// deployed (see its own header comment). It is a stricter, enum-validated
// reference variant kept for a planned consolidation. Testing it would pin a
// file no caller can reach, so this suite drives the deployed handler and
// covers the reference variant's ALLOWED_TRANSITIONS table separately at the
// bottom, so the two cannot drift apart unnoticed.
//
// The control being pinned: ops/admin can set any canonical status by hand, so
// the rewind guard at index.ts:1089 is what stops a post-disbursement loan
// being walked back into the approval transition that re-fires a REAL
// SoftCrédito/SPEI transfer. SPEI has no idempotency key of its own.
//
// This file has no top-level `import`, so — like its siblings
// loanApprovalDisbursement.test.ts and submitReviewDecision.test.ts — it needs
// an explicit `export {}` to become a module. Without it every top-level
// `const` here is a global declaration and collides (TS2451) with the other
// suites under the single-program `npm run typecheck:tests` (#538/#539). For
// the same reason every top-level name below carries a `uls`/`ULS` prefix.
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

// Triggers are handed back rather than swallowed: the replay test below needs
// to run onLoanApproved for real against the same store the callable wrote to,
// so that "did a transfer actually fire?" is answered by the production code
// path and not by a stub that could hide a broken guard.
jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentCreated: jest.fn(() => jest.fn()),
  onDocumentUpdated: jest.fn((_path: unknown, handler: unknown) => handler),
}));

jest.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: jest.fn(() => jest.fn()),
}));

const ulsMockLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
jest.mock('firebase-functions', () => ({ logger: ulsMockLogger }));
jest.mock('firebase-functions/v2', () => ({ logger: ulsMockLogger }));

class UlsMockTimestamp {
  constructor(public seconds: number, public nanoseconds = 0) {}
  static now() {
    return new UlsMockTimestamp(Math.floor(Date.now() / 1000));
  }
  static fromDate(date: Date) {
    return new UlsMockTimestamp(Math.floor(date.getTime() / 1000));
  }
  toDate() {
    return new Date(this.seconds * 1000);
  }
}

const ulsMockFieldValue = {
  increment: jest.fn((n: number) => ({ _increment: n })),
  serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })),
  arrayUnion: jest.fn((...items: unknown[]) => ({ _arrayUnion: items })),
};

let ulsMockDb: ReturnType<typeof ulsBuildMockDb>;
jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => ulsMockDb),
  FieldValue: ulsMockFieldValue,
  Timestamp: UlsMockTimestamp,
}));

const ulsMockFetch = jest.fn();
jest.mock('node-fetch', () => ({
  __esModule: true,
  default: (...args: unknown[]) => ulsMockFetch(...args),
}));

jest.mock('../../utils/rateLimiter', () => {
  const mod = { checkRateLimit: jest.fn().mockResolvedValue(true) };
  return {
    ...mod,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    enforceRateLimit: require('../../__mocks__/utils/rateLimiter').makeEnforceRateLimit(
      (...a: unknown[]) => (mod as { checkRateLimit: (...a: unknown[]) => Promise<boolean> }).checkRateLimit(...a)
    ),
  };
});
jest.mock('../../utils/notify', () => ({ notifyLoanEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/slackAlert', () => ({ sendSlackAlert: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/sentry', () => ({ initSentry: jest.fn(), captureException: jest.fn() }));

interface UlsStoreEntry {
  exists: boolean;
  data: Record<string, unknown>;
}

interface UlsWrite {
  collection: string;
  id: string;
  op: string;
  data: Record<string, unknown>;
}

/** Same in-memory Firestore stand-in the sibling disbursement suite uses: a
 *  shared Map that `runTransaction` also operates on, so onLoanApproved's
 *  transactional idempotency claim behaves like a real one. */
function ulsBuildMockDb(seed: Record<string, Record<string, Record<string, unknown>>> = {}) {
  const store = new Map<string, UlsStoreEntry>();
  for (const [collection, docs] of Object.entries(seed)) {
    for (const [id, data] of Object.entries(docs)) {
      store.set(`${collection}/${id}`, { exists: true, data });
    }
  }

  const writes: UlsWrite[] = [];

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
        store.set(key, { exists: true, data: { ...prev, ...data } });
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
          store.set(ref._key, { exists: true, data: { ...prev, ...data } });
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

const ULS_LOAN_BASE = {
  employeeId: 'emp-1',
  employeeName: 'Juan García',
  employerId: 'employer-1',
  employerName: 'Test Co',
  amount: 1000,
  total: 1300,
  term: 30,
};

const ULS_EMPLOYEE = { bankClabe: 'CLABE123', bankName: 'BBVA' };

const ULS_OPS_AUTH = { uid: 'ops-1', token: { role: 'ops' } };

type UlsCallable = (req: { auth?: unknown; data: unknown }) => Promise<{ success: boolean; status: string }>;
type UlsTriggerEvent = {
  params: { loanId: string };
  data: { before: { data: () => unknown }; after: { data: () => unknown } };
};

async function ulsLoad() {
  const mod = await import('../../index');
  return {
    updateLoanStatus: mod.updateLoanStatus as unknown as UlsCallable,
    onLoanApproved: mod.onLoanApproved as unknown as (e: UlsTriggerEvent) => Promise<unknown>,
  };
}

/** Drives the callable and then fires the document trigger with the exact
 *  before/after diff the write produced — i.e. what Firestore would do. */
async function ulsCall(
  fn: UlsCallable,
  onLoanApproved: (e: UlsTriggerEvent) => Promise<unknown>,
  loanId: string,
  status: string,
  auth: unknown = ULS_OPS_AUTH
) {
  const before = { ...(ulsMockDb._store.get(`loans/${loanId}`)?.data ?? {}) };
  const result = await fn({ auth, data: { loanId, status } });
  const after = { ...(ulsMockDb._store.get(`loans/${loanId}`)?.data ?? {}) };
  await onLoanApproved({
    params: { loanId },
    data: { before: { data: () => before }, after: { data: () => after } },
  });
  return result;
}

function ulsDisburseCalls() {
  return ulsMockFetch.mock.calls.filter(([url]) => String(url).endsWith('/internal/disburse'));
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  process.env['SOFTCREDITO_ADAPTER_URL'] = 'https://sc.example.test';
  process.env['INTERNAL_SECRET'] = 'test-secret';
  delete process.env['ALLOW_STUB_DISBURSEMENT'];
  ulsMockFetch.mockResolvedValue({
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

// ─────────────────────────────────────────────────────────────────────────────
// 1. The rewind guard proper
// ─────────────────────────────────────────────────────────────────────────────

describe('updateLoanStatus — rewind guard: post-disbursement → pre-disbursement', () => {
  // Every status in DISBURSEMENT_INITIATED_STATUSES paired with every status in
  // PRE_DISBURSEMENT_STATUSES. Table-driven so adding a status to either set in
  // loanStatus.ts cannot quietly leave a new pair unguarded.
  const POST = [
    'disbursement_queued',
    'disbursement_failed',
    'active',
    'disbursed',
    'overdue',
    'in_collections',
    'written_off',
    'repaid',
  ];
  const PRE = ['pending', 'under_review', 'approved'];

  for (const from of POST) {
    for (const to of PRE) {
      it(`refuses ${from} → ${to}`, async () => {
        ulsMockDb = ulsBuildMockDb({ loans: { 'loan-1': { ...ULS_LOAN_BASE, status: from } } });
        const { updateLoanStatus } = await ulsLoad();

        await expect(
          updateLoanStatus({ auth: ULS_OPS_AUTH, data: { loanId: 'loan-1', status: to } })
        ).rejects.toMatchObject({ code: 'failed-precondition' });

        // Refusal must leave the loan untouched, not half-applied.
        expect(ulsMockDb._store.get('loans/loan-1')?.data['status']).toBe(from);
      });
    }
  }

  it('still allows the legitimate ops correction: disbursement_failed → disbursement_queued', async () => {
    ulsMockDb = ulsBuildMockDb({ loans: { 'loan-1': { ...ULS_LOAN_BASE, status: 'disbursement_failed' } } });
    const { updateLoanStatus } = await ulsLoad();

    await expect(
      updateLoanStatus({ auth: ULS_OPS_AUTH, data: { loanId: 'loan-1', status: 'disbursement_queued' } })
    ).resolves.toMatchObject({ success: true });
  });

  it('still allows ops to approve a loan that has not been disbursed yet', async () => {
    ulsMockDb = ulsBuildMockDb({ loans: { 'loan-1': { ...ULS_LOAN_BASE, status: 'under_review' } } });
    const { updateLoanStatus } = await ulsLoad();

    await expect(
      updateLoanStatus({ auth: ULS_OPS_AUTH, data: { loanId: 'loan-1', status: 'approved' } })
    ).resolves.toMatchObject({ success: true });
  });

  it('still allows the ops-only terminal statuses the callable exists to serve', async () => {
    for (const to of ['in_collections', 'written_off']) {
      ulsMockDb = ulsBuildMockDb({ loans: { 'loan-1': { ...ULS_LOAN_BASE, status: 'overdue' } } });
      jest.resetModules();
      const { updateLoanStatus } = await ulsLoad();
      await expect(
        updateLoanStatus({ auth: ULS_OPS_AUTH, data: { loanId: 'loan-1', status: to } })
      ).resolves.toMatchObject({ success: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Statuses in NEITHER set — the laundering route around the guard
// ─────────────────────────────────────────────────────────────────────────────

describe('updateLoanStatus — no exit from a funded loan into a non-disbursement status', () => {
  // 'rejected', 'rejected_ml' and 'cancelled' are in ALL_LOAN_STATUSES but in
  // NEITHER DISBURSEMENT_INITIATED_STATUSES nor PRE_DISBURSEMENT_STATUSES. A
  // guard that fires only on (post → pre) therefore lets a funded loan step
  // sideways into one of them, and from there the loan is no longer "post
  // disbursement" as far as the guard is concerned — so the next call can walk
  // it back to 'pending' and the one after that re-enters 'approved'.
  for (const sideways of ['rejected', 'rejected_ml', 'cancelled']) {
    it(`refuses disbursed → ${sideways}`, async () => {
      ulsMockDb = ulsBuildMockDb({ loans: { 'loan-1': { ...ULS_LOAN_BASE, status: 'disbursed' } } });
      const { updateLoanStatus } = await ulsLoad();

      await expect(
        updateLoanStatus({ auth: ULS_OPS_AUTH, data: { loanId: 'loan-1', status: sideways } })
      ).rejects.toMatchObject({ code: 'failed-precondition' });
      expect(ulsMockDb._store.get('loans/loan-1')?.data['status']).toBe('disbursed');
    });
  }

  it('refuses to strand a funded loan outside DEDUCTIBLE_STATUSES (payroll would stop collecting)', async () => {
    // 'rejected' is not in DEDUCTIBLE_STATUSES, so processPayroll silently
    // stops collecting against a loan whose money has already gone out. This is
    // the same harm submitReviewDecision refuses at index.ts:1572.
    ulsMockDb = ulsBuildMockDb({ loans: { 'loan-1': { ...ULS_LOAN_BASE, status: 'active' } } });
    const { updateLoanStatus } = await ulsLoad();

    await expect(
      updateLoanStatus({ auth: ULS_OPS_AUTH, data: { loanId: 'loan-1', status: 'rejected' } })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('blocks the multi-call laundering replay: disbursed → cancelled → pending → approved', async () => {
    // The whole point of the guard. A manually-disbursed loan (markLoanDisbursed
    // writes status 'disbursed' + disbursedAt) must not be walkable back into
    // the approval transition by any route.
    ulsMockDb = ulsBuildMockDb({
      loans: {
        'loan-1': {
          ...ULS_LOAN_BASE,
          status: 'disbursed',
          disbursedAt: UlsMockTimestamp.now(),
          stpTransactionId: 'STP-REAL-1',
        },
      },
      employees: { 'emp-1': ULS_EMPLOYEE },
    });
    const { updateLoanStatus, onLoanApproved } = await ulsLoad();

    // Step 1 must already fail. If it ever stops failing, the remaining steps
    // assert that the loan still cannot reach a second real transfer.
    await expect(
      ulsCall(updateLoanStatus, onLoanApproved, 'loan-1', 'cancelled')
    ).rejects.toMatchObject({ code: 'failed-precondition' });

    await ulsCall(updateLoanStatus, onLoanApproved, 'loan-1', 'pending').catch(() => undefined);
    await ulsCall(updateLoanStatus, onLoanApproved, 'loan-1', 'approved').catch(() => undefined);

    expect(ulsDisburseCalls()).toHaveLength(0);
    expect(ulsMockDb._store.get('loans/loan-1')?.data['status']).toBe('disbursed');
  });

  it('allows cancelling a loan that was never funded', async () => {
    // The guard must not become "no cancellation ever" — cancelling a
    // pre-disbursement loan is the normal ops path.
    for (const from of ['pending', 'under_review', 'approved']) {
      ulsMockDb = ulsBuildMockDb({ loans: { 'loan-1': { ...ULS_LOAN_BASE, status: from } } });
      jest.resetModules();
      const { updateLoanStatus } = await ulsLoad();
      await expect(
        updateLoanStatus({ auth: ULS_OPS_AUTH, data: { loanId: 'loan-1', status: 'cancelled' } })
      ).resolves.toMatchObject({ success: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Vocabulary validation
// ─────────────────────────────────────────────────────────────────────────────

describe('updateLoanStatus — status vocabulary is validated server-side', () => {
  async function ulsExpectInvalid(status: unknown) {
    ulsMockDb = ulsBuildMockDb({ loans: { 'loan-1': { ...ULS_LOAN_BASE, status: 'pending' } } });
    const { updateLoanStatus } = await ulsLoad();
    await expect(
      updateLoanStatus({ auth: ULS_OPS_AUTH, data: { loanId: 'loan-1', status } })
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ulsMockDb._store.get('loans/loan-1')?.data['status']).toBe('pending');
  }

  it('refuses a status outside the canonical vocabulary', async () => {
    await ulsExpectInvalid('totally_not_a_status');
  });

  // The legacy read-side aliases must never be WRITABLE: loanStatus.ts is
  // explicit that 'repaid' is the only canonical repaid spelling and that the
  // aliases exist so reports can recognise historical documents, not so ops can
  // mint new ones.
  for (const alias of ['paid', 'complete', 'completed']) {
    it(`refuses the legacy read-only alias '${alias}'`, async () => {
      await ulsExpectInvalid(alias);
    });
  }

  it('refuses case variants of a real status', async () => {
    await ulsExpectInvalid('Approved');
    await ulsExpectInvalid('APPROVED');
  });

  it('refuses whitespace-padded variants of a real status', async () => {
    await ulsExpectInvalid(' approved');
    await ulsExpectInvalid('approved ');
  });

  it('refuses a non-string status', async () => {
    await ulsExpectInvalid(123);
    await ulsExpectInvalid(true);
    await ulsExpectInvalid({ status: 'approved' });
  });

  it('refuses a missing loanId or status outright', async () => {
    ulsMockDb = ulsBuildMockDb({ loans: { 'loan-1': { ...ULS_LOAN_BASE, status: 'pending' } } });
    const { updateLoanStatus } = await ulsLoad();
    await expect(
      updateLoanStatus({ auth: ULS_OPS_AUTH, data: { loanId: '', status: 'approved' } })
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(
      updateLoanStatus({ auth: ULS_OPS_AUTH, data: { loanId: 'loan-1', status: '' } })
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('validates the status BEFORE reading the loan, so an unknown status cannot probe existence', async () => {
    ulsMockDb = ulsBuildMockDb({});
    const { updateLoanStatus } = await ulsLoad();
    // A bad status on a nonexistent loan must report invalid-argument, not
    // not-found — otherwise the error code leaks which loan ids exist.
    await expect(
      updateLoanStatus({ auth: ULS_OPS_AUTH, data: { loanId: 'no-such-loan', status: 'nonsense' } })
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Authorization — must fail closed when the thing being checked is absent
// ─────────────────────────────────────────────────────────────────────────────

describe('updateLoanStatus — authorization', () => {
  it('rejects an unauthenticated call', async () => {
    ulsMockDb = ulsBuildMockDb({ loans: { 'loan-1': { ...ULS_LOAN_BASE, status: 'pending' } } });
    const { updateLoanStatus } = await ulsLoad();

    await expect(
      updateLoanStatus({ data: { loanId: 'loan-1', status: 'approved' } })
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  // The #534/#536 shape: a check that passes because the thing doing the
  // checking is missing. A token with no role/admin claim must fall through to
  // the RESTRICTIVE employer branch, never be treated as ops.
  it('treats a caller with no role claim as an employer, not as ops (fails closed)', async () => {
    ulsMockDb = ulsBuildMockDb({
      loans: { 'loan-1': { ...ULS_LOAN_BASE, status: 'disbursed' } },
    });
    const { updateLoanStatus } = await ulsLoad();

    // uid is not the employerId, and the caller has no elevating claim.
    await expect(
      updateLoanStatus({ auth: { uid: 'nobody-1', token: {} }, data: { loanId: 'loan-1', status: 'pending' } })
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('does not accept a client-supplied role in the data payload', async () => {
    ulsMockDb = ulsBuildMockDb({ loans: { 'loan-1': { ...ULS_LOAN_BASE, status: 'pending' } } });
    const { updateLoanStatus } = await ulsLoad();

    // Role is read from the verified auth token only. A `role` in `data` must
    // not elevate anyone.
    await expect(
      updateLoanStatus({
        auth: { uid: 'nobody-1', token: {} },
        data: { loanId: 'loan-1', status: 'active', role: 'admin', admin: true },
      })
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('refuses an employer acting on a loan that is not theirs', async () => {
    ulsMockDb = ulsBuildMockDb({ loans: { 'loan-1': { ...ULS_LOAN_BASE, status: 'pending' } } });
    const { updateLoanStatus } = await ulsLoad();

    await expect(
      updateLoanStatus({
        auth: { uid: 'other-employer', token: { role: 'employer' } },
        data: { loanId: 'loan-1', status: 'approved' },
      })
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('refuses an employer acting on a loan that is no longer pending', async () => {
    ulsMockDb = ulsBuildMockDb({ loans: { 'loan-1': { ...ULS_LOAN_BASE, status: 'active' } } });
    const { updateLoanStatus } = await ulsLoad();

    await expect(
      updateLoanStatus({
        auth: { uid: 'employer-1', token: { role: 'employer' } },
        data: { loanId: 'loan-1', status: 'approved' },
      })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('restricts an employer to approve/reject even on their own pending loan', async () => {
    ulsMockDb = ulsBuildMockDb({ loans: { 'loan-1': { ...ULS_LOAN_BASE, status: 'pending' } } });
    const { updateLoanStatus } = await ulsLoad();

    await expect(
      updateLoanStatus({
        auth: { uid: 'employer-1', token: { role: 'employer' } },
        data: { loanId: 'loan-1', status: 'active' },
      })
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('allows an employer to approve their own pending loan', async () => {
    ulsMockDb = ulsBuildMockDb({ loans: { 'loan-1': { ...ULS_LOAN_BASE, status: 'pending' } } });
    const { updateLoanStatus } = await ulsLoad();

    await expect(
      updateLoanStatus({
        auth: { uid: 'employer-1', token: { role: 'employer' } },
        data: { loanId: 'loan-1', status: 'approved' },
      })
    ).resolves.toMatchObject({ success: true });
  });

  it('accepts the admin boolean claim as well as the named roles', async () => {
    for (const token of [{ admin: true }, { role: 'admin' }, { role: 'super_admin' }, { role: 'ops' }]) {
      ulsMockDb = ulsBuildMockDb({ loans: { 'loan-1': { ...ULS_LOAN_BASE, status: 'overdue' } } });
      jest.resetModules();
      const { updateLoanStatus } = await ulsLoad();
      await expect(
        updateLoanStatus({ auth: { uid: 'a-1', token }, data: { loanId: 'loan-1', status: 'in_collections' } })
      ).resolves.toMatchObject({ success: true });
    }
  });

  it('reports not-found for a missing loan without writing anything', async () => {
    ulsMockDb = ulsBuildMockDb({});
    const { updateLoanStatus } = await ulsLoad();

    await expect(
      updateLoanStatus({ auth: ULS_OPS_AUTH, data: { loanId: 'ghost', status: 'approved' } })
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(ulsMockDb._writes.filter((w) => w.collection === 'loans')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The non-deployed reference variant's transition table
// ─────────────────────────────────────────────────────────────────────────────

describe('loans/updateLoanStatus.ts (reference variant) — ALLOWED_TRANSITIONS is a strict allow-list', () => {
  // The reference variant is not deployed, but it is kept as the target of a
  // planned consolidation. Pin the property that matters: its table is an
  // allow-list, so it cannot express the sideways exit the deployed guard has
  // to block explicitly.
  it('never allows any post-disbursement status to reach a pre-disbursement one', async () => {
    const { PRE_DISBURSEMENT_STATUSES, DISBURSEMENT_INITIATED_STATUSES } = await import('../loanStatus');

    // Re-derive the table from the module under test rather than restating it.
    const source = await import('fs').then((fs) =>
      fs.readFileSync(require.resolve('../updateLoanStatus.ts'), 'utf8')
    );
    // The reference variant must not gain an entry mapping a disbursement-
    // initiated status to a pre-disbursement one.
    for (const post of DISBURSEMENT_INITIATED_STATUSES) {
      for (const pre of PRE_DISBURSEMENT_STATUSES) {
        const pattern = new RegExp(`\\[LOAN_STATUS\\.${post.toUpperCase()}\\][^\\n]*${pre.toUpperCase()}\\b`);
        expect(source).not.toMatch(pattern);
      }
    }
  });
});
