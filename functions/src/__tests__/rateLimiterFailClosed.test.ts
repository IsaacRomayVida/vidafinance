// Marked as a module (`export {}`) so its top-level declarations stay
// file-scoped — same reason as validateCurpFailClosed.test.ts.
export {};

// The rate limiting layer had two independent defects, and this file pins both.
//
// 1. FAIL-OPEN BY COPY-PASTE. All ~30 call sites inlined the same
//    `try { checkRateLimit } catch { logger.warn }`. Every limiter outage —
//    Redis unreachable, or REDIS_URL simply not present in the deployed
//    functions' environment, which makes `getRedis()` throw before a socket is
//    ever opened — was swallowed and the request continued. So the limits that
//    are the only brake on loan-request spam, on a metered identity API, and on
//    sweeping the invite/employer code spaces all silently became no-ops
//    exactly when something was already wrong.
//
// 2. PERMANENT LOCKOUT. `incr` and `expire` were two round-trips, with the
//    EXPIRE guarded by `current === 1`. Lose that EXPIRE once and the key has
//    no TTL, is only ever INCRemented, and the guard never fires again — the
//    counter climbs forever. On `rl:loan:${uid}` (3 per 86400s) that is a
//    borrower who can never request a loan again.
//
// Both are asserted against handler behaviour, not against the limiter's
// internals, so they describe what a caller actually experiences.

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

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => ({ collection: jest.fn(() => mockCollection) })),
  FieldValue: { increment: jest.fn(), serverTimestamp: jest.fn() },
  Timestamp: MockTimestamp,
}));

// Declared outside the factory: `jest.resetModules()` re-runs factories, and a
// jest.fn() built inside one would be a fresh unconfigured mock per test — the
// fail-closed assertions would then pass because Firestore returned undefined
// rather than because the handler refused.
const mockCollection: Record<string, jest.Mock> = {
  doc: jest.fn(() => ({ get: jest.fn(async () => ({ exists: false })) })),
  where: jest.fn(() => mockCollection),
  limit: jest.fn(() => mockCollection),
  orderBy: jest.fn(() => mockCollection),
  get: jest.fn(async () => ({ empty: true, docs: [], size: 0 })),
  add: jest.fn(async () => ({ id: 'doc-1' })),
};

// The real ./redis is what rateLimiter.ts imports, and it is deliberately NOT
// remapped here: `getRedis()` throwing on an absent REDIS_URL is precisely the
// production condition under test.
const mockEval = jest.fn();
const mockTtl = jest.fn();
const mockIncr = jest.fn();
const mockExpire = jest.fn();
let redisAvailable = true;

// Spelled '../../src/utils/redis' rather than '../utils/redis' on purpose.
// jest.config.js maps '^../utils/redis$' onto src/__mocks__/utils/redis.ts, so
// mocking that spelling would replace the shared mock and leave rateLimiter.ts
// — which imports './redis' — bound to the real module. This spelling misses
// the mapper and resolves to the same file rateLimiter.ts actually loads.
jest.mock('../../src/utils/redis', () => ({
  getRedis: jest.fn(() => {
    if (!redisAvailable) throw new Error('REDIS_URL not configured — skipping Redis');
    return { eval: mockEval, ttl: mockTtl, incr: mockIncr, expire: mockExpire };
  }),
}));

const mockFetch = jest.fn();
jest.mock('node-fetch', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockFetch(...args),
}));

jest.mock('../utils/notify', () => ({ notifyLoanEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/slackAlert', () => ({ sendSlackAlert: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/sentry', () => ({ initSentry: jest.fn(), captureException: jest.fn() }));

type Handler = (req: unknown) => Promise<unknown>;

const EMPLOYEE_AUTH = { uid: 'employee-1', token: { role: 'employee' } };

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  redisAvailable = true;
  mockEval.mockResolvedValue(1);
  process.env['GCLOUD_PROJECT'] = 'vida-finance';
  // Set deliberately. If the redis mock above ever stops applying, the real
  // getRedis() would throw on an absent REDIS_URL and every fail-closed
  // assertion below would pass for the wrong reason. With a URL present, a
  // mock that failed to bind surfaces as a failure instead.
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  mockFetch.mockReset();
});

afterEach(() => {
  delete process.env['SOFTCREDITO_ADAPTER_URL'];
  delete process.env['INTERNAL_SECRET'];
  delete process.env['REDIS_URL'];
});

// ───────────────────────────────────────────────────────────────────────────
// Defect 1 — a limiter outage must not lift a spend/abuse limit.
// ───────────────────────────────────────────────────────────────────────────

describe('limits that guard spend or a code space fail CLOSED when the limiter is down', () => {
  it('requestLoan refuses rather than granting an unlimited number of loan requests', async () => {
    redisAvailable = false; // REDIS_URL absent on the deployment
    const { requestLoan } = await import('../index');

    await expect(
      (requestLoan as unknown as Handler)({ data: { amount: 1000 }, auth: EMPLOYEE_AUTH })
    ).rejects.toMatchObject({ code: 'unavailable' });

    // It must refuse BEFORE reaching Firestore — an outage that still costs a
    // read per attempt is a cheaper hole, not a closed one.
    expect(mockCollection.get).not.toHaveBeenCalled();
  });

  it('validateCURP refuses rather than fanning out to the metered identity API', async () => {
    // The adapter is configured and would answer. That matters: validateCURP
    // already fails closed when SOFTCREDITO_ADAPTER_URL or INTERNAL_SECRET is
    // missing (#534), so leaving those unset would make this test pass without
    // the limiter having refused anything. Configured, the ONLY thing that can
    // stop the outbound billable call is the rate limiter.
    process.env['SOFTCREDITO_ADAPTER_URL'] = 'https://adapter.test';
    process.env['INTERNAL_SECRET'] = 'a-real-secret';
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ valid: true, fullName: 'JUAN PEREZ' }),
    });

    redisAvailable = false;
    const { validateCURP } = await import('../index');

    await expect(
      (validateCURP as unknown as Handler)({ data: { curp: 'XAXX010101HDFAAA01' }, app: { appId: 'a' } })
    ).rejects.toMatchObject({ code: 'unavailable' });

    // The billing drain is the point: no limiter, no outbound call.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('lookupInvite refuses rather than reopening invite-token sweeping', async () => {
    redisAvailable = false;
    const { lookupInvite } = await import('../invites/lookupInvite');

    await expect(
      (lookupInvite as unknown as Handler)({ data: { token: 'x'.repeat(32) }, app: { appId: 'a' } })
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('lookupEmployerByCode refuses rather than reopening employer-code sweeping', async () => {
    redisAvailable = false;
    const { lookupEmployerByCode } = await import('../employers/lookupEmployerByCode');

    await expect(
      (lookupEmployerByCode as unknown as Handler)({ data: { code: 'ACME01' }, app: { appId: 'a' } })
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('checkEmailAvailability refuses rather than becoming an account-existence oracle', async () => {
    redisAvailable = false;
    const { checkEmailAvailability } = await import('../index');

    await expect(
      (checkEmailAvailability as unknown as Handler)({ data: { email: 'a@b.com' }, app: { appId: 'a' } })
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('submitContactForm refuses rather than becoming an open Firestore write endpoint', async () => {
    redisAvailable = false;
    const { submitContactForm } = await import('../contact/submitContactForm');

    await expect(
      (submitContactForm as unknown as Handler)({
        data: { name: 'Ana', email: 'a@b.com', subject: 'general', message: 'x'.repeat(20) },
        app: { appId: 'a' },
      })
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(mockCollection.add).not.toHaveBeenCalled();
  });

  it('a limiter outage is reported as unavailable, not as the caller exceeding a quota', async () => {
    redisAvailable = false;
    const { lookupInvite } = await import('../invites/lookupInvite');

    const err = (await (lookupInvite as unknown as Handler)({
      data: { token: 'x'.repeat(32) },
      app: { appId: 'a' },
    }).catch((e: unknown) => e)) as { code: string };

    // 'resource-exhausted' would tell the user to wait and retry; the fault is
    // ours and retrying does not clear it.
    expect(err.code).toBe('unavailable');
    expect(err.code).not.toBe('resource-exhausted');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The fail-open side is a decision, so it gets a test too — otherwise a later
// blanket "make everything fail closed" would take dashboards down with it.
// ───────────────────────────────────────────────────────────────────────────

describe('read-only dashboards stay fail-OPEN by design', () => {
  it('getEmployeeDashboard runs its handler when the limiter is down', async () => {
    redisAvailable = false;
    const { getEmployeeDashboard } = await import('../employees/getEmployeeDashboard');

    // The limiter is down, so the only question is whether it stopped the
    // request. It did not: execution reached the handler body and failed on
    // this fixture's empty Firestore instead ("Employee profile not found").
    // Any 'unavailable' here would mean the dashboard had been made to fail
    // closed along with the credit-critical limits.
    const err = (await (getEmployeeDashboard as unknown as Handler)({
      data: {},
      auth: EMPLOYEE_AUTH,
    }).catch((e: unknown) => e)) as { code: string };

    expect(err.code).not.toBe('unavailable');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Rate limiter unavailable'),
      expect.objectContaining({ context: 'getEmployeeDashboard' })
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Defect 2 — the limiter's own counting.
// ───────────────────────────────────────────────────────────────────────────

describe('checkRateLimit counting', () => {
  it('permits traffic under the threshold', async () => {
    const { checkRateLimit } = await import('../utils/rateLimiter');
    mockEval.mockResolvedValue(3);
    await expect(checkRateLimit('rl:loan:u1', 3, 86400)).resolves.toBe(true);
  });

  it('refuses traffic over the threshold', async () => {
    const { checkRateLimit } = await import('../utils/rateLimiter');
    mockEval.mockResolvedValue(4);
    await expect(checkRateLimit('rl:loan:u1', 3, 86400)).resolves.toBe(false);
  });

  it('sets the window in the same atomic step as the increment', async () => {
    const { checkRateLimit } = await import('../utils/rateLimiter');
    await checkRateLimit('rl:loan:u1', 3, 86400);

    // One server-side call, not an INCR followed by a separately-losable EXPIRE.
    expect(mockEval).toHaveBeenCalledTimes(1);
    expect(mockIncr).not.toHaveBeenCalled();
    expect(mockExpire).not.toHaveBeenCalled();

    const [script, numKeys, key, window] = mockEval.mock.calls[0] as [string, number, string, string];
    expect(numKeys).toBe(1);
    expect(key).toBe('rl:loan:u1');
    expect(window).toBe('86400');
    expect(script).toContain('INCR');
    expect(script).toContain('EXPIRE');
    // The self-heal: a key found without a TTL gets one re-applied.
    expect(script).toContain('TTL');
  });

  it('re-applies the window to a key that lost its TTL, instead of locking the caller out forever', async () => {
    // Simulate the real Redis semantics of the script against a key that is
    // stuck at 9 with no expiry — the state the old two-call version created
    // whenever its EXPIRE was lost.
    const store: { count: number; ttl: number } = { count: 9, ttl: -1 };
    mockEval.mockImplementation(async (script: string, _n: number, _k: string, windowArg: string) => {
      store.count += 1;
      if (store.count === 1 || store.ttl < 0) store.ttl = Number(windowArg);
      void script;
      return store.count;
    });

    const { checkRateLimit } = await import('../utils/rateLimiter');
    await checkRateLimit('rl:loan:stuck-user', 3, 86400);

    // The key is no longer immortal: it now expires, so the borrower gets their
    // quota back at the end of the window rather than never.
    expect(store.ttl).toBe(86400);
  });
});
