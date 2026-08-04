// Marked as a module (`export {}`) so its top-level `const`/`class` declarations
// stay file-scoped. Without this a .test.ts with no top-level import/export is a
// global script, and two such files declaring the same name (`mockLogger`,
// `MockTimestamp`) fail to compile the moment both are on main — which is exactly
// how they broke the build when they first met.
export {};

// `validateCURP` is the identity gate: it answers "is this a real CURP, and
// does it belong to this person". Every failure path used to answer that
// question `valid: true`, with a `fullName` copied straight out of the
// caller's own `expectedName` — so an unconfigured adapter, an unreachable
// one, or one rejecting us over a missing/rotated INTERNAL_SECRET did not
// degrade identity validation, it switched it off. These tests pin the
// fail-CLOSED direction: no upstream failure may ever be reported to a caller
// as a validated identity.
//
// Same defect shape as the webhook verifiers in #534 (a check that passes
// precisely when its secret is absent), applied to a lender's KYC gate.

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
  getFirestore: jest.fn(() => ({ collection: jest.fn() })),
  FieldValue: { increment: jest.fn(), serverTimestamp: jest.fn() },
  Timestamp: MockTimestamp,
}));

// Declared outside the factory on purpose. `jest.resetModules()` in beforeEach
// re-runs module factories, so a `jest.fn()` created INSIDE the factory would be
// a fresh, unconfigured mock on every test — the fail-closed assertions would
// then pass because `fetch` returned undefined, not because the handler refused.
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

type CurpResult = {
  valid: boolean;
  fullName?: string;
  dateOfBirth?: string;
  gender?: string;
};
type CurpHandler = (req: { data: unknown; app?: unknown }) => Promise<CurpResult>;

async function loadValidateCURP(): Promise<CurpHandler> {
  const { validateCURP } = await import('../index');
  return validateCURP as unknown as CurpHandler;
}

// A syntactically perfect CURP that belongs to nobody. This is what an
// attacker supplies: CURP_REGEX is a format check, not an identity check.
const WELL_FORMED_CURP = 'XAXX010101HDFAAA01';
const ATTACKER_CHOSEN_NAME = 'Nombre Que Yo Elegí';

describe('validateCURP fails closed', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockFetch.mockReset();
    // Pin the environment to production so allowTestBypass() cannot short-circuit
    // any of this — a test that silently took the bypass would prove nothing.
    process.env['GCLOUD_PROJECT'] = 'vida-finance';
    delete process.env['FUNCTIONS_EMULATOR'];
    delete process.env['VIDA_ALLOW_TEST_BYPASS'];
    process.env['SOFTCREDITO_ADAPTER_URL'] = 'https://adapter.test';
    process.env['INTERNAL_SECRET'] = 'a-real-secret';
  });

  afterEach(() => {
    delete process.env['SOFTCREDITO_ADAPTER_URL'];
    delete process.env['INTERNAL_SECRET'];
    delete process.env['GCLOUD_PROJECT'];
  });

  it('refuses to validate when the adapter URL is not configured', async () => {
    delete process.env['SOFTCREDITO_ADAPTER_URL'];
    const fn = await loadValidateCURP();

    await expect(
      fn({ data: { curp: WELL_FORMED_CURP, expectedName: ATTACKER_CHOSEN_NAME } })
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // The #534 shape exactly: the secret is the thing that is missing, and its
  // absence used to make the check pass instead of fail.
  it('refuses to validate when INTERNAL_SECRET is empty, without calling the adapter', async () => {
    process.env['INTERNAL_SECRET'] = '';
    const fn = await loadValidateCURP();

    await expect(
      fn({ data: { curp: WELL_FORMED_CURP, expectedName: ATTACKER_CHOSEN_NAME } })
    ).rejects.toMatchObject({ code: 'unavailable' });
    // Must not go out unauthenticated and let the adapter's 401 be read as "valid".
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 500, 502])(
    'refuses to validate when the adapter answers %i',
    async (status) => {
      mockFetch.mockResolvedValue({
        ok: false,
        status,
        text: async () => 'upstream detail that must not reach the caller',
      });
      const fn = await loadValidateCURP();

      await expect(
        fn({ data: { curp: WELL_FORMED_CURP, expectedName: ATTACKER_CHOSEN_NAME } })
      ).rejects.toMatchObject({ code: 'unavailable' });
    }
  );

  it('refuses to validate when the adapter call throws (timeout / network)', async () => {
    mockFetch.mockRejectedValue(new Error('The operation was aborted due to timeout'));
    const fn = await loadValidateCURP();

    await expect(
      fn({ data: { curp: WELL_FORMED_CURP, expectedName: ATTACKER_CHOSEN_NAME } })
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('never echoes the caller-supplied expectedName back as a validated identity', async () => {
    mockFetch.mockRejectedValue(new Error('adapter down'));
    const fn = await loadValidateCURP();

    const result = await fn({
      data: { curp: WELL_FORMED_CURP, expectedName: ATTACKER_CHOSEN_NAME },
    }).catch((e: unknown) => e as Error & { code: string });

    expect((result as { code: string }).code).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain(ATTACKER_CHOSEN_NAME);
  });

  it('does not leak the adapter error body to the caller', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'CURP XAXX010101HDFAAA01 belongs to JUAN PEREZ, RFC XAXX010101ABC',
    });
    const fn = await loadValidateCURP();

    const err = (await fn({ data: { curp: WELL_FORMED_CURP } }).catch(
      (e: unknown) => e
    )) as Error;
    expect(err.message).not.toContain('JUAN PEREZ');
    expect(err.message).not.toContain('RFC');
  });

  it('still returns the adapter verdict verbatim on a successful call', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        valid: true,
        fullName: 'JUAN PEREZ LOPEZ',
        dateOfBirth: '1990-01-15',
        gender: 'M',
        matchesExpectedName: true,
      }),
    });
    const fn = await loadValidateCURP();

    const result = await fn({
      data: { curp: WELL_FORMED_CURP, expectedName: ATTACKER_CHOSEN_NAME },
    });

    expect(result.valid).toBe(true);
    // The adapter's answer, not the caller's.
    expect(result.fullName).toBe('JUAN PEREZ LOPEZ');
  });

  it('reports an adapter "not valid" verdict as invalid rather than as an outage', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ valid: false }),
    });
    const fn = await loadValidateCURP();

    const result = await fn({ data: { curp: WELL_FORMED_CURP } });
    expect(result.valid).toBe(false);
  });

  it('still rejects a malformed CURP before any of this', async () => {
    const fn = await loadValidateCURP();
    await expect(fn({ data: { curp: 'not-a-curp' } })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });
});

// Guards the assumption the fail-closed change rests on: `allowTestBypass()`
// must not be reachable on the production project, or the bypass above would
// be the real hole and none of the tests in this file would mean anything.
describe('test bypass is unreachable on production', () => {
  it('does not bypass on the production project even with a VIDA-prefixed CURP', async () => {
    jest.resetModules();
    process.env['GCLOUD_PROJECT'] = 'vida-finance';
    process.env['VIDA_ALLOW_TEST_BYPASS'] = 'true';
    delete process.env['SOFTCREDITO_ADAPTER_URL'];
    const fn = await loadValidateCURP();

    await expect(
      fn({ data: { curp: 'VIDA010101HDFAAA01', email: 'x@vida-test.com' } })
    ).rejects.toMatchObject({ code: 'unavailable' });

    delete process.env['VIDA_ALLOW_TEST_BYPASS'];
    delete process.env['GCLOUD_PROJECT'];
  });
});
