const store: Record<string, string> = {};

const redis = {
  ping: jest.fn(async () => 'PONG'),
  get: jest.fn(async (key: string) => store[key] ?? null),
  setex: jest.fn(async (key: string, _ttl: number, value: string) => {
    store[key] = value;
    return 'OK';
  }),
  on: jest.fn(),
};

export function __getStore(): Record<string, string> {
  return store;
}

export function __resetStore(): void {
  for (const key of Object.keys(store)) {
    delete store[key];
  }
}

export default redis;
