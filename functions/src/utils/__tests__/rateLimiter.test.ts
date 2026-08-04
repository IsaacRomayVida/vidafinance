// checkRateLimit now issues its INCR and EXPIRE as a single server-side Lua
// step rather than two round-trips, so this fake stands in for the Redis side
// of that contract: it keeps counters and TTLs, and `eval` applies the same
// rules the script does (INCR; set the window on the first hit, or whenever the
// key is found without one). The behavioural expectations below — counting,
// per-key independence, the boundary at exactly the limit — are unchanged.
jest.mock('../redis', () => {
  const counters: Record<string, number> = {};
  const expires: Record<string, number> = {};
  const instance = {
    eval: jest.fn(async (_script: string, _numKeys: number, key: string, windowArg: string) => {
      counters[key] = (counters[key] ?? 0) + 1;
      // `expires[key] === undefined` is this fake's stand-in for redis TTL < 0:
      // the key exists but carries no window.
      if (counters[key] === 1 || expires[key] === undefined) {
        expires[key] = Number(windowArg);
      }
      return counters[key];
    }),
    _reset: () => {
      for (const k of Object.keys(counters)) delete counters[k];
      for (const k of Object.keys(expires)) delete expires[k];
    },
    _get: (key: string) => counters[key],
    _getExpire: (key: string) => expires[key],
    _dropExpire: (key: string) => delete expires[key],
  };
  return {
    getRedis: jest.fn(() => instance),
  };
});

import { checkRateLimit } from '../rateLimiter';
import { getRedis } from '../redis';

type MockRedis = {
  eval: jest.Mock;
  _reset: () => void;
  _get: (key: string) => number | undefined;
  _getExpire: (key: string) => number | undefined;
  _dropExpire: (key: string) => void;
};

describe('checkRateLimit', () => {
  let redis: MockRedis;

  beforeEach(() => {
    redis = getRedis() as unknown as MockRedis;
    redis._reset();
    redis.eval.mockClear();
  });

  it('allows the first request', async () => {
    const allowed = await checkRateLimit('test:key1', 10, 60);
    expect(allowed).toBe(true);
    expect(redis.eval).toHaveBeenCalledWith(expect.any(String), 1, 'test:key1', '60');
  });

  it('sets the window on the first request', async () => {
    await checkRateLimit('test:key2', 10, 60);
    expect(redis._getExpire('test:key2')).toBe(60);
  });

  it('counts and expires in a single round-trip', async () => {
    await checkRateLimit('test:atomic', 10, 60);
    // The old two-call version could lose its EXPIRE between calls and leave
    // the key immortal. One call cannot be half-applied.
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('restores the window on a key that lost its TTL, rather than counting forever', async () => {
    await checkRateLimit('test:stuck', 10, 60);
    redis._dropExpire('test:stuck'); // the state a lost EXPIRE used to leave behind

    await checkRateLimit('test:stuck', 10, 60);

    // Re-armed. Under the old `current === 1` guard this key would have stayed
    // immortal, climbed past the limit and refused that principal permanently.
    expect(redis._getExpire('test:stuck')).toBe(60);
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
