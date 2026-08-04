export const mockRedis = {
  lpush: jest.fn(async () => 1),
  incr: jest.fn(async () => 1),
  expire: jest.fn(async () => 1),
  ttl: jest.fn(async () => 60),
  // checkRateLimit runs INCR+EXPIRE as one Lua step; default to "first request
  // in the window" so existing suites keep passing through the limiter.
  eval: jest.fn(async () => 1),
};

export const getRedis = jest.fn(() => mockRedis);
