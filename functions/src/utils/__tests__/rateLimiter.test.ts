jest.mock('../redis', () => {
  const counters: Record<string, number> = {};
  const expires: Record<string, number> = {};
  const instance = {
    incr: jest.fn(async (key: string) => {
      counters[key] = (counters[key] ?? 0) + 1;
      return counters[key];
    }),
    expire: jest.fn(async (key: string, seconds: number) => {
      expires[key] = seconds;
      return 1;
    }),
    _reset: () => {
      for (const k of Object.keys(counters)) delete counters[k];
      for (const k of Object.keys(expires)) delete expires[k];
    },
    _get: (key: string) => counters[key],
    _getExpire: (key: string) => expires[key],
  };
  return {
    getRedis: jest.fn(() => instance),
  };
});

import { checkRateLimit } from '../rateLimiter';
import { getRedis } from '../redis';

type MockRedis = {
  incr: jest.Mock;
  expire: jest.Mock;
  _reset: () => void;
  _get: (key: string) => number | undefined;
  _getExpire: (key: string) => number | undefined;
};

describe('checkRateLimit', () => {
  let redis: MockRedis;

  beforeEach(() => {
    redis = getRedis() as unknown as MockRedis;
    redis._reset();
    redis.incr.mockClear();
    redis.expire.mockClear();
  });

  it('allows the first request', async () => {
    const allowed = await checkRateLimit('test:key1', 10, 60);
    expect(allowed).toBe(true);
    expect(redis.incr).toHaveBeenCalledWith('test:key1');
  });

  it('sets expiry on first request only', async () => {
    await checkRateLimit('test:key2', 10, 60);
    expect(redis.expire).toHaveBeenCalledWith('test:key2', 60);
    expect(redis._getExpire('test:key2')).toBe(60);

    const expireCallsBefore = redis.expire.mock.calls.length;
    await checkRateLimit('test:key2', 10, 60);
    expect(redis.expire.mock.calls.length).toBe(expireCallsBefore);
  });

  it('15 requests at limit=10 -> 10 allowed, 5 denied', async () => {
    const results: boolean[] = [];
    for (let i = 0; i < 15; i++) {
      results.push(await checkRateLimit('test:burst', 10, 60));
    }
    const allowed = results.filter((r) => r === true).length;
    const denied = results.filter((r) => r === false).length;
    expect(allowed).toBe(10);
    expect(denied).toBe(5);
  });

  it('exactly at the limit returns true', async () => {
    let last = false;
    for (let i = 0; i < 10; i++) {
      last = await checkRateLimit('test:exact', 10, 60);
    }
    expect(last).toBe(true);
    expect(redis._get('test:exact')).toBe(10);
  });

  it('one over the limit returns false', async () => {
    for (let i = 0; i < 10; i++) {
      await checkRateLimit('test:over', 10, 60);
    }
    const eleventh = await checkRateLimit('test:over', 10, 60);
    expect(eleventh).toBe(false);
    expect(redis._get('test:over')).toBe(11);
  });

  it('different keys track independently', async () => {
    for (let i = 0; i < 10; i++) {
      await checkRateLimit('test:userA', 10, 60);
    }
    const userAFails = await checkRateLimit('test:userA', 10, 60);
    expect(userAFails).toBe(false);

    const userBOk = await checkRateLimit('test:userB', 10, 60);
    expect(userBOk).toBe(true);
  });

  it('respects different limit values', async () => {
    const results3: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      results3.push(await checkRateLimit('test:low', 3, 60));
    }
    expect(results3.filter((r) => r === true).length).toBe(3);
    expect(results3.filter((r) => r === false).length).toBe(2);
  });
});
