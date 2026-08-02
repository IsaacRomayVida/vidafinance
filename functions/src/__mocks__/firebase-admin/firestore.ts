export const FieldValue = {
  increment: jest.fn((n: number) => ({ _increment: n })),
  serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })),
  arrayUnion: jest.fn((...items: unknown[]) => ({ _arrayUnion: items })),
};

export class Timestamp {
  constructor(public seconds: number, public nanoseconds: number) {}

  static now() {
    return new Timestamp(Math.floor(Date.now() / 1000), 0);
  }

  static fromDate(date: Date) {
    return new Timestamp(Math.floor(date.getTime() / 1000), 0);
  }

  toDate() {
    return new Date(this.seconds * 1000);
  }

  toMillis() {
    return this.seconds * 1000;
  }
}

// Mutable store so tests can configure it
export const _mockStore: {
  loans: Record<string, { exists: boolean; data?: Record<string, unknown> }>;
  employers: Record<string, { exists: boolean; data?: Record<string, unknown> }>;
  employees: Record<string, { exists: boolean; data?: Record<string, unknown> }>;
  users: Record<string, { exists: boolean; data?: Record<string, unknown> }>;
  /** Every write landing in the `audit_log` collection, via add() or txn.set(). */
  auditLog: Array<Record<string, unknown>>;
  transactionCalls: Array<string>;
  docUpdates: Array<{ collection: string; id: string; data: Record<string, unknown> }>;
} = {
  loans: {},
  employers: {},
  employees: {},
  users: {},
  auditLog: [],
  transactionCalls: [],
  docUpdates: [],
};

const AUDIT_COLLECTION = 'audit_log';

const makeTxn = () => ({
  update: jest.fn((_ref: unknown, _data: unknown) => {
    _mockStore.transactionCalls.push('update');
  }),
  set: jest.fn((ref: unknown, data: unknown) => {
    _mockStore.transactionCalls.push('set');
    // Audit records are written transactionally on the security-critical paths,
    // so the store has to see txn.set too or those writes look like no-ops.
    if ((ref as { _collection?: string } | undefined)?._collection === AUDIT_COLLECTION) {
      _mockStore.auditLog.push(data as Record<string, unknown>);
    }
  }),
});

const makeDocRef = (collection: string, id: string) => ({
  id,
  _collection: collection,
  get: jest.fn(async () => {
    const store = _mockStore[collection as keyof typeof _mockStore] as Record<
      string,
      { exists: boolean; data?: Record<string, unknown> }
    >;
    const entry = store?.[id];
    if (!entry) return { exists: false, data: () => null };
    return {
      exists: entry.exists,
      data: () => entry.data ?? null,
    };
  }),
  update: jest.fn(async (data: Record<string, unknown>) => {
    _mockStore.docUpdates.push({ collection, id, data });
  }),
  set: jest.fn(async () => {}),
});

const makeCollectionRef = (name: string) => ({
  doc: jest.fn((id: string) => makeDocRef(name, id)),
  add: jest.fn(async (data: unknown) => {
    if (name === AUDIT_COLLECTION) {
      _mockStore.auditLog.push(data as Record<string, unknown>);
    }
    return { id: 'new-doc-id' };
  }),
});

const mockDb = {
  collection: jest.fn((name: string) => makeCollectionRef(name)),
  runTransaction: jest.fn(async (fn: (txn: ReturnType<typeof makeTxn>) => Promise<void>) => {
    const txn = makeTxn();
    await fn(txn);
    return txn;
  }),
};

export const getFirestore = jest.fn(() => mockDb);
export { mockDb };
