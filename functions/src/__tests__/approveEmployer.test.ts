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
jest.mock('firebase-admin', () => ({
  auth: jest.fn(() => ({ setCustomUserClaims: mockSetCustomUserClaims })),
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
jest.mock('../utils/rateLimiter', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

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
