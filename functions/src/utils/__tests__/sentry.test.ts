/**
 * `utils/sentry.ts` wires Sentry with three deliberate safety properties per
 * its own header comment: (1) a complete no-op when `SENTRY_DSN` is unset,
 * (2) PII-safety — `beforeSend` redacts every field of `event.request.data`
 * rather than forwarding loan amounts/CURP/phone to a third party, and
 * (3) `flushSentry` is best-effort and must never throw. None of this was
 * covered (~18-20%), so none of it was actually pinned.
 *
 * `@sentry/node` is mocked locally. `initSentry`'s `initialized` flag is
 * module-scoped, so each test re-imports the module fresh after
 * `jest.resetModules()` (same pattern as `dailyLoanCheck.test.ts`).
 */
export {};

type Scope = { setTag: jest.Mock; setUser: jest.Mock; setExtra: jest.Mock };

const mockScope: Scope = { setTag: jest.fn(), setUser: jest.fn(), setExtra: jest.fn() };
const mockWithScope = jest.fn((cb: (scope: Scope) => void) => cb(mockScope));
const mockCaptureException = jest.fn();
const mockInit = jest.fn();
const mockFlush = jest.fn(async (_timeoutMs: number) => true);

jest.mock('@sentry/node', () => ({
  init: (config: unknown) => mockInit(config),
  withScope: (cb: (scope: Scope) => void) => mockWithScope(cb),
  captureException: (error: unknown) => mockCaptureException(error),
  flush: (timeoutMs: number) => mockFlush(timeoutMs),
}));

type SentryEvent = { request?: { data?: unknown }; message?: string };
type SentryConfig = {
  dsn: string;
  sendDefaultPii: boolean;
  tracesSampleRate: number;
  beforeSend: (event: SentryEvent) => SentryEvent;
};

const ORIGINAL_DSN = process.env['SENTRY_DSN'];

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  delete process.env['SENTRY_DSN'];
});

afterEach(() => {
  if (ORIGINAL_DSN === undefined) delete process.env['SENTRY_DSN'];
  else process.env['SENTRY_DSN'] = ORIGINAL_DSN;
});

describe('initSentry', () => {
  it('stays uninitialised — a complete no-op — when SENTRY_DSN is unset', async () => {
    const { initSentry, captureException } = await import('../sentry');

    initSentry();
    expect(mockInit).not.toHaveBeenCalled();

    // captureException must also stay inert: callable functions must work
    // with no telemetry backend configured at all.
    captureException(new Error('boom'));
    expect(mockWithScope).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('initialises once, with PII collection and tracing both off, when SENTRY_DSN is set', async () => {
    process.env['SENTRY_DSN'] = 'https://key@sentry.example/1';
    const { initSentry } = await import('../sentry');

    initSentry();
    initSentry(); // second call must be a no-op

    expect(mockInit).toHaveBeenCalledTimes(1);
    const config = mockInit.mock.calls[0]?.[0] as SentryConfig;
    expect(config.dsn).toBe('https://key@sentry.example/1');
    expect(config.sendDefaultPii).toBe(false);
    expect(config.tracesSampleRate).toBe(0);
  });

  it('redacts every field of event.request.data — the PII-safety guarantee', async () => {
    process.env['SENTRY_DSN'] = 'https://key@sentry.example/1';
    const { initSentry } = await import('../sentry');
    initSentry();

    const config = mockInit.mock.calls[0]?.[0] as SentryConfig;
    const event: SentryEvent = {
      request: { data: { curp: 'ABCD010101HDFRRN01', phone: '5512345678', amount: 5000 } },
    };

    const result = config.beforeSend(event);

    // Keys are preserved (so the shape is still diagnosable) but every value
    // is replaced — no CURP, phone, or loan amount ever reaches Sentry.
    expect(result.request?.data).toEqual({
      curp: '[redacted]',
      phone: '[redacted]',
      amount: '[redacted]',
    });
  });

  it('leaves an event with no request body alone', async () => {
    process.env['SENTRY_DSN'] = 'https://key@sentry.example/1';
    const { initSentry } = await import('../sentry');
    initSentry();

    const config = mockInit.mock.calls[0]?.[0] as SentryConfig;
    const event: SentryEvent = { message: 'plain event, no request data' };

    expect(config.beforeSend(event)).toBe(event);
  });
});

describe('captureException', () => {
  it('is a no-op before initSentry has run, even with context supplied', async () => {
    const { captureException } = await import('../sentry');

    captureException(new Error('x'), { functionName: 'requestLoan' });

    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('tags known structural context (function, uid, loanId, employerId) and reports the error once initialised', async () => {
    process.env['SENTRY_DSN'] = 'https://key@sentry.example/1';
    const { initSentry, captureException } = await import('../sentry');
    initSentry();

    const error = new Error('underwriting failed');
    captureException(error, {
      functionName: 'requestLoan',
      uid: 'user-1',
      loanId: 'loan-1',
      employerId: 'employer-1',
      extraDetail: 'not pii, just structural',
    });

    expect(mockScope.setTag).toHaveBeenCalledWith('function', 'requestLoan');
    expect(mockScope.setUser).toHaveBeenCalledWith({ id: 'user-1' });
    expect(mockScope.setTag).toHaveBeenCalledWith('loanId', 'loan-1');
    expect(mockScope.setTag).toHaveBeenCalledWith('employerId', 'employer-1');
    expect(mockScope.setExtra).toHaveBeenCalledWith('extraDetail', 'not pii, just structural');
    expect(mockCaptureException).toHaveBeenCalledWith(error);
  });

  it('reports the error even with no context at all', async () => {
    process.env['SENTRY_DSN'] = 'https://key@sentry.example/1';
    const { initSentry, captureException } = await import('../sentry');
    initSentry();

    captureException(new Error('bare'));

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockScope.setTag).not.toHaveBeenCalled();
    expect(mockScope.setUser).not.toHaveBeenCalled();
  });
});

describe('flushSentry', () => {
  it('is a no-op before initSentry has run', async () => {
    const { flushSentry } = await import('../sentry');

    await flushSentry();

    expect(mockFlush).not.toHaveBeenCalled();
  });

  it('flushes with the given timeout once initialised', async () => {
    process.env['SENTRY_DSN'] = 'https://key@sentry.example/1';
    const { initSentry, flushSentry } = await import('../sentry');
    initSentry();

    await flushSentry(500);

    expect(mockFlush).toHaveBeenCalledWith(500);
  });

  it('swallows a flush failure — best-effort, never throws or rejects', async () => {
    process.env['SENTRY_DSN'] = 'https://key@sentry.example/1';
    mockFlush.mockRejectedValueOnce(new Error('network down'));
    const { initSentry, flushSentry } = await import('../sentry');
    initSentry();

    await expect(flushSentry()).resolves.toBeUndefined();
  });
});
