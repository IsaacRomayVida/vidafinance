export const redis = {
  ping: jest.fn(async () => 'PONG'),
  lpush: jest.fn(async () => 1),
  lPush: jest.fn(async () => 1),
  brpop: jest.fn(async () => null),
};
