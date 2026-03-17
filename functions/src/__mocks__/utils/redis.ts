export const mockRedis = {
  lpush: jest.fn(async () => 1),
};

export const getRedis = jest.fn(() => mockRedis);
