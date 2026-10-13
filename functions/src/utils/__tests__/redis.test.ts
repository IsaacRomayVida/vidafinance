/**
 * `utils/redis.ts` is the factory every rate limiter and lockout check calls
 * through — `checkRateLimit` (see `rateLimiter.ts`) has no other route to
 * Redis, and `enforceRateLimit` fails CLOSED (refuses the request) when this
 * throws for a limiter configured `onUnavailable: 'closed'`. These tests are
 * about `getRedis()` itself: the shared `__mocks__/utils/redis.ts` used by
 * every other suite only intercepts the `../utils/redis` / `../../utils/redis`
 * specifiers those suites import it by (see jest.config.js
 * moduleNameMapper) — this file imports the sibling `../redis` module
 * directly, which does not match either pattern, so it exercises the real
 * implementation.
 */
export {};

const mockOn = jest.fn();
const MockIORedis = jest.fn().mockImplementation(() => ({ on: mockOn }));

jest.mock('ioredis', () => ({
  __esModule: true,
  default: MockIORedis,
}));

const ORIGINAL_REDIS_URL = process.env['REDIS_URL'];

beforeEach(() => {
  jest.resetModules();
  MockIORedis.mockClear();
  mockOn.mockClear();
  delete process.env['REDIS_URL'];
});

afterEach(() => {
  if (ORIGINAL_REDIS_URL === undefined) delete process.env['REDIS_URL'];
  else process.env['REDIS_URL'] = ORIGINAL_REDIS_URL;
});

describe('utils/redis getRedis()', () => {
  it('throws — fails closed — when REDIS_URL is not configured', async () => {
    const { getRedis } = await import('../redis');
    expect(() => getRedis()).toThrow('REDIS_URL not configured — skipping Redis');
    expect(MockIORedis).not.toHaveBeenCalled();
  });

  it('throws the same way when REDIS_URL is set to an empty string', async () => {
    process.env['REDIS_URL'] = '';
    const { getRedis } = await import('../redis');
    expect(() => getRedis()).toThrow('REDIS_URL not configured — skipping Redis');
  });

  it('constructs a single lazy-connect client and reuses it across calls (singleton)', async () => {
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    const { getRedis } = await import('../redis');

    const first = getRedis();
    const second = getRedis();

    expect(first).toBe(second);
    expect(MockIORedis).toHaveBeenCalledTimes(1);
    expect(MockIORedis).toHaveBeenCalledWith(
      'redis://localhost:6379',
      expect.objectContaining({ maxRetriesPerRequest: 1, lazyConnect: true })
    );
  });

  it('enables TLS with rejectUnauthorized: false for a rediss:// URL', async () => {
    process.env['REDIS_URL'] = 'rediss://secure-host:6380';
    const { getRedis } = await import('../redis');

    getRedis();

    expect(MockIORedis).toHaveBeenCalledWith(
      'rediss://secure-host:6380',
      expect.objectContaining({ tls: { rejectUnauthorized: false } })
    );
  });

  it('leaves TLS undefined for a plain redis:// URL', async () => {
    process.env['REDIS_URL'] = 'redis://plain-host:6379';
    const { getRedis } = await import('../redis');

    getRedis();

    expect(MockIORedis).toHaveBeenCalledWith(
      'redis://plain-host:6379',
      expect.objectContaining({ tls: undefined })
    );
  });

  it('registers an error listener so an emitted "error" event never becomes an unhandled exception', async () => {
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    const { getRedis } = await import('../redis');

    getRedis();

    expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
    // A dropped connection fires ioredis's 'error' event; without a handler
    // that crashes the function instance rather than letting the caller's
    // own try/catch (e.g. checkRateLimit -> enforceRateLimit) handle it.
    const handler = mockOn.mock.calls[0]?.[1] as (e: Error) => void;
    expect(() => handler(new Error('ECONNRESET'))).not.toThrow();
  });
});
