// Regression test for the ACTUAL deployed `approveEmployer` callable (inline in
// index.ts — NOT the unused src/employers/approveEmployer.ts variant, which
// implements a completely different reject-capable contract that was never
// wired into index.ts's exports).
//
// The deployed handler has never had a reject branch — every call reaches the
// same "activate the employer" code path regardless of what the client sent.
// AdminDashboard.tsx calls this with `{ employerUid, decision: 'rejected' }`
// when an admin clicks "Reject", and (before this fix) that request was
// silently APPROVED instead: the employer was activated, ML-scored, and
// emailed an approval notice, with no error surfaced to the admin. See
// CALLABLE_CONTRACT_AUDIT.md P0-2.
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

// Approval is also where the employer_admin custom claim is minted (see the
// grant block in index.ts's approveEmployer). Without this mock the handler
// reaches a real `admin.auth()` on an uninitialised app and the approve path
// throws before it gets anywhere near the assertions below.
const mockSetCustomUserClaims = jest.fn().mockResolvedValue(undefined);

// `getUser` is not padding on this mock. setCustomUserClaims REPLACES a
// principal's whole claims object, so the grant below now reads what the target
// currently IS before overwriting it. A mock auth object that cannot be asked
// that question models a handler that never asks — which is the defect, not the
// fixed behaviour.
//
// Mirrors the slice of UserRecord that decides this: `customClaims` is absent
// for a principal who has none, which is the honest default for an employer
// being approved. Suites register a uid here to make it something else.
const mockAuthUsers: Record<string, { uid: string; customClaims?: Record<string, unknown> }> = {};
let mockGetUserFails = false;
const mockGetUser = jest.fn(async (uid: string) => {
  if (mockGetUserFails) {
    // Shape of a real Admin SDK failure: a FirebaseAuthError carrying a code.
    throw Object.assign(new Error('auth backend unavailable'), { code: 'auth/internal-error' });
  }
  return mockAuthUsers[uid] ?? { uid };
});

jest.mock('firebase-admin', () => ({
  auth: jest.fn(() => ({
    setCustomUserClaims: mockSetCustomUserClaims,
    getUser: mockGetUser,
  })),
}));

const mockFieldValue = {
  increment: jest.fn((n: number) => ({ _increment: n })),
  serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })),
};

const mockEmployer = { companyName: 'Test Co', email: 'employer@example.com' };

function buildMockDb() {
  const updateCalls: Array<Record<string, unknown>> = [];
  const employerDoc = {
    get: jest.fn().mockResolvedValue({ exists: true, data: () => mockEmployer }),
    update: jest.fn((data: Record<string, unknown>) => {
      updateCalls.push(data);
      return Promise.resolve();
    }),
  };
  return {
    collection: jest.fn().mockImplementation((name: string) => {
      if (name === 'employers') {
        return { doc: jest.fn().mockReturnValue(employerDoc) };
      }
      if (name === 'audit_log') {
        return { add: jest.fn().mockResolvedValue({ id: 'audit-1' }) };
      }
      throw new Error(`Unexpected collection: ${name}`);
    }),
    _updateCalls: updateCalls,
  };
}

let mockDb: ReturnType<typeof buildMockDb>;
jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockDb),
  FieldValue: mockFieldValue,
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

type ApproveEmployerFn = (req: { auth?: unknown; data: unknown }) => Promise<{
  success: boolean;
  approved: boolean;
}>;

describe('approveEmployer (deployed handler in index.ts)', () => {
  const auth = { uid: 'admin-1', token: { role: 'admin' } };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockDb = buildMockDb();
    mockCheckRateLimit.mockResolvedValue(true);
    for (const uid of Object.keys(mockAuthUsers)) delete mockAuthUsers[uid];
    mockGetUserFails = false;
    delete process.env['ML_SERVICE_URL'];
    delete process.env['SOFTCREDITO_ADAPTER_URL'];
    delete process.env['REDIS_URL'];
  });

  it('refuses — rather than silently approving — a request sent as AdminDashboard.tsx sends a reject', async () => {
    const { approveEmployer } = await import('../index');
    const fn = approveEmployer as unknown as ApproveEmployerFn;

    await expect(
      fn({ auth, data: { employerUid: 'employer-1', decision: 'rejected', rejectionReason: 'Not qualified' } })
    ).rejects.toMatchObject({ code: 'unimplemented' });

    expect(mockDb._updateCalls).toHaveLength(0);
  });

  it('refuses — rather than silently approving — a request sent as EmployerMgmt.tsx sends a reject', async () => {
    const { approveEmployer } = await import('../index');
    const fn = approveEmployer as unknown as ApproveEmployerFn;

    await expect(
      fn({ auth, data: { employerUid: 'employer-1', approved: false } })
    ).rejects.toMatchObject({ code: 'unimplemented' });

    expect(mockDb._updateCalls).toHaveLength(0);
  });

  it('still approves a normal approve request (no regression on the working path)', async () => {
    const { approveEmployer } = await import('../index');
    const fn = approveEmployer as unknown as ApproveEmployerFn;

    const result = await fn({ auth, data: { employerUid: 'employer-1', approved: true } });

    expect(result.success).toBe(true);
    expect(mockDb._updateCalls[0]).toMatchObject({ status: 'active' });
  });

  it('still rejects a missing employerUid the same way as before', async () => {
    const { approveEmployer } = await import('../index');
    const fn = approveEmployer as unknown as ApproveEmployerFn;

    await expect(fn({ auth, data: {} })).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'employerUid is required',
    });
  });
});

// ── The employer_admin grant must not be a demotion primitive ───────────────
//
// setCustomUserClaims REPLACES the whole claims object. Both callables below
// gated only on "does employers/{uid} exist" and never on who `uid` IS, so
// pointing either at a super_admin rewrote that principal to
// `{ role: 'employer_admin' }` and took away the only role that can grant it
// back in-product.
//
// The starting privilege is `admin`, and it is genuinely obtainable: any other
// admin can grant it through setAdminClaim, and a stale legacy `admin: true`
// token resolves to it (LEGACY_ADMIN_ROLE in middleware/authMiddleware.ts).
// Victim uids are not secret either — firestore.rules gives isAdmin() read, get
// AND list, on /users/{userId}, where adminClaims mirrors every role.
//
// Nothing in this repo caught it: this file's own "still approves a normal
// approve request" case is the closest, and it only ever approved an
// unprivileged uid.
describe('employer_admin grants refuse to overwrite a privileged principal', () => {
  const auth = { uid: 'admin-1', token: { role: 'admin' } };

  type CallableFn = (req: { auth?: unknown; data: unknown }) => Promise<unknown>;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockDb = buildMockDb();
    mockCheckRateLimit.mockResolvedValue(true);
    for (const uid of Object.keys(mockAuthUsers)) delete mockAuthUsers[uid];
    mockGetUserFails = false;
    delete process.env['ML_SERVICE_URL'];
    delete process.env['SOFTCREDITO_ADAPTER_URL'];
    delete process.env['REDIS_URL'];
  });

  it.each([['super_admin'], ['admin']])(
    'approveEmployer refuses to overwrite a %s, and leaves the employer untouched',
    async (role) => {
      mockAuthUsers['victim'] = { uid: 'victim', customClaims: { role } };
      const { approveEmployer } = await import('../index');

      await expect(
        (approveEmployer as unknown as CallableFn)({ auth, data: { employerUid: 'victim', approved: true } })
      ).rejects.toMatchObject({ code: 'failed-precondition' });

      expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
      // Refused BEFORE the activation write, so the refusal leaves nothing
      // half-applied — no activated-but-unclaimed employer to clean up.
      expect(mockDb._updateCalls).toHaveLength(0);
    }
  );

  it('approveEmployer refuses a target holding only the legacy `admin: true` boolean', async () => {
    // No `role` field at all — the shape every principal granted admin between
    // 7864c4d and a23963f still carries, and which withAuth still honours. A
    // guard that read `role` alone would wave exactly these accounts through.
    mockAuthUsers['legacy'] = { uid: 'legacy', customClaims: { admin: true } };
    const { approveEmployer } = await import('../index');

    await expect(
      (approveEmployer as unknown as CallableFn)({ auth, data: { employerUid: 'legacy', approved: true } })
    ).rejects.toMatchObject({ code: 'failed-precondition' });

    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
  });

  it('setEmployerClaims refuses to overwrite a super_admin', async () => {
    mockAuthUsers['victim'] = { uid: 'victim', customClaims: { role: 'super_admin' } };
    const { setEmployerClaims } = await import('../index');

    await expect(
      (setEmployerClaims as unknown as CallableFn)({ auth, data: { uid: 'victim' } })
    ).rejects.toMatchObject({ code: 'failed-precondition' });

    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
  });

  it('setEmployerClaims still grants to an ordinary principal', async () => {
    const { setEmployerClaims } = await import('../index');

    await (setEmployerClaims as unknown as CallableFn)({ auth, data: { uid: 'plain-employer' } });

    expect(mockSetCustomUserClaims).toHaveBeenCalledWith('plain-employer', {
      role: 'employer_admin',
    });
  });

  it.each([
    ['approveEmployer', 'employerUid'],
    ['setEmployerClaims', 'uid'],
  ])('%s refuses when the target\'s claims cannot be read at all', async (name, field) => {
    // Fail CLOSED. Under-reading the target's privileges is the whole defect, so
    // "the lookup did not answer" must refuse rather than resolve to "nobody".
    mockGetUserFails = true;
    const mod = await import('../index');
    const fn = (mod as unknown as Record<string, CallableFn>)[name];

    await expect(fn({ auth, data: { [field]: 'victim', approved: true } })).rejects.toMatchObject({
      code: 'internal',
    });

    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
    expect(mockDb._updateCalls).toHaveLength(0);
  });
});
