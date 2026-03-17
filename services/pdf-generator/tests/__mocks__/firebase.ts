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
  collection: jest.fn((subName: string) => ({
    add: jest.fn(async (data: Record<string, unknown>) => {
      const id = `auto_${Date.now()}`;
      store[`${path}/${subName}/${id}`] = data;
      return { id };
    }),
  })),
});

const mockQueryDocs: Array<{ id: string; data: () => Record<string, unknown> }> = [];

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
    get: jest.fn(async () => ({
      empty: mockQueryDocs.length === 0,
      docs: mockQueryDocs.map((d) => ({
        id: d.id,
        data: d.data,
      })),
    })),
  })),
};

const mockFile = {
  save: jest.fn(async () => {}),
  makePublic: jest.fn(async () => {}),
};

export const storage = {
  name: 'test-bucket',
  file: jest.fn(() => mockFile),
};

export const admin = {
  firestore: {
    FieldValue: {
      serverTimestamp: () => 'SERVER_TIMESTAMP',
      increment: (n: number) => ({ _increment: n }),
    },
  },
};

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

export function __setQueryDocs(docs: Array<{ id: string; data: () => Record<string, unknown> }>): void {
  mockQueryDocs.length = 0;
  mockQueryDocs.push(...docs);
}
