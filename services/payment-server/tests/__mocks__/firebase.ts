import { Timestamp } from '@google-cloud/firestore';

// In-memory Firestore mock
const store: Record<string, Record<string, unknown>> = {};

const mockDoc = (path: string) => ({
  get: jest.fn(async () => {
    const data = store[path];
    return { exists: !!data, id: path.split('/').pop(), data: () => data };
  }),
  set: jest.fn(async (data: Record<string, unknown>) => {
    store[path] = { ...data };
  }),
  update: jest.fn(async (data: Record<string, unknown>) => {
    store[path] = { ...(store[path] ?? {}), ...data };
  }),
  ref: {
    update: jest.fn(async (data: Record<string, unknown>) => {
      store[path] = { ...(store[path] ?? {}), ...data };
    }),
  },
});

const mockQuery = (docs: Array<{ id: string; data: () => Record<string, unknown> }>) => ({
  empty: docs.length === 0,
  docs: docs.map((d) => ({
    id: d.id,
    data: d.data,
    ref: {
      update: jest.fn(async (data: Record<string, unknown>) => {
        store[`loans/${d.id}`] = { ...(store[`loans/${d.id}`] ?? {}), ...data };
      }),
    },
  })),
});

export const db = {
  collection: jest.fn((name: string) => ({
    doc: jest.fn((id: string) => mockDoc(`${name}/${id}`)),
    add: jest.fn(async (data: Record<string, unknown>) => {
      const id = `auto_${Date.now()}`;
      store[`${name}/${id}`] = data;
      return { id };
    }),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    get: jest.fn(async () => mockQuery([])),
  })),
  runTransaction: jest.fn(async (fn: (tx: unknown) => Promise<void>) => {
    await fn({
      get: jest.fn(async (ref: { path?: string }) => ({
        exists: true,
        data: () => store[ref.path ?? ''] ?? {},
      })),
      update: jest.fn(),
      set: jest.fn(),
    });
  }),
};

export const admin = {
  firestore: {
    Timestamp: {
      now: () => ({ seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 }),
      fromMillis: (ms: number) => ({ seconds: Math.floor(ms / 1000), nanoseconds: 0 }),
    },
    FieldValue: {
      serverTimestamp: () => 'SERVER_TIMESTAMP',
      increment: (n: number) => ({ _increment: n }),
    },
  },
};

// Helper to seed the mock store for tests
export function __setMockData(path: string, data: Record<string, unknown>): void {
  store[path] = data;
}

export function __resetMockStore(): void {
  for (const key of Object.keys(store)) {
    delete store[key];
  }
}

export function __getMockStore(): Record<string, Record<string, unknown>> {
  return store;
}
