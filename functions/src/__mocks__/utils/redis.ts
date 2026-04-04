export const mockRedis = {
  lpush: jest.fn(async () => 1),
  incr: jest.fn(async () => 1),
  expire: jest.fn(async () => 1),
};

export const getRedis = jest.fn(() => mockRedis);
