/**
 * E18 — recording that an employer actually remitted what it deducted.
 *
 * `processPayroll` writes the expected side of `payrollRemittances/{batchId}`
 * (covered in processPayroll.test.ts). These tests cover the other side: the
 * ops/admin callable that books a received bank transfer against a batch, and
 * the status it derives. The employer must not be able to call it — a
 * remittance the employer asserts about itself is the unverified claim E18
 * exists to replace.
 */
export {};

jest.mock('firebase-functions', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

// The rate limiter reaches Redis; it is not what these tests exercise.
jest.mock('../../utils/rateLimiter', () => {
  const mod = { checkRateLimit: jest.fn().mockResolvedValue(true) };
  return {
    ...mod,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    enforceRateLimit: require('../../__mocks__/utils/rateLimiter').makeEnforceRateLimit(
      (...a: unknown[]) => (mod as { checkRateLimit: (...a: unknown[]) => Promise<boolean> }).checkRateLimit(...a)
    ),
  };
});

// ─── In-memory Firestore ─────────────────────────────────────────────────────

type Doc = Record<string, unknown>;
const mockStore: { payrollRemittances: Record<string, Doc>; audit_log: Record<string, Doc> } = {
  payrollRemittances: {},
  audit_log: {},
};
let mockAutoId = 0;

const mockFieldValue = {
  serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })),
  // Applied for real below, so `receipts` reads back as the array it would be.
  arrayUnion: jest.fn((...items: unknown[]) => ({ _arrayUnion: items })),
};

class MockTimestamp {
  constructor(public seconds: number) {}
  static now() {
    return new MockTimestamp(1_700_000_000);
  }
}

type Ref = { _collection: keyof typeof mockStore; id: string };

function applyUpdate(existing: Doc, data: Doc): Doc {
  const next = { ...existing };
  for (const [k, v] of Object.entries(data)) {
    const union = (v as { _arrayUnion?: unknown[] } | null)?._arrayUnion;
    next[k] = union ? [...((existing[k] as unknown[]) ?? []), ...union] : v;
  }
  return next;
}

const mockDb = {
  collection: jest.fn((name: keyof typeof mockStore) => ({
    doc: (id?: string) => ({ _collection: name, id: id ?? `auto-${++mockAutoId}` }),
  })),
  runTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    // Staged, then committed only if the body resolves — a throwing body
    // writes nothing, as with the real SDK.
    const staged: Array<() => void> = [];
    const tx = {
      get: jest.fn(async (ref: Ref) => {
        const entry = mockStore[ref._collection][ref.id];
        return { exists: entry !== undefined, data: () => entry };
      }),
      update: jest.fn((ref: Ref, data: Doc) => {
        staged.push(() => {
          mockStore[ref._collection][ref.id] = applyUpdate(mockStore[ref._collection][ref.id] ?? {}, data);
        });
      }),
      set: jest.fn((ref: Ref, data: Doc) => {
        staged.push(() => {
          mockStore[ref._collection][ref.id] = { ...data };
        });
      }),
    };
    const out = await fn(tx);
    staged.forEach((apply) => apply());
    return out;
  }),
};

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockDb),
  FieldValue: mockFieldValue,
  Timestamp: MockTimestamp,
}));

import { recordPayrollRemittance, remittanceStatus, pesosToCents } from '../remittance';

type Handler = (req: { auth?: unknown; data: unknown }) => Promise<Record<string, unknown>>;
const fn = recordPayrollRemittance as unknown as Handler;

const BATCH_ID = 'employer-uid-1_2026-07-01_2026-07-15';
const opsRequest = (data: Record<string, unknown>, role = 'ops') => ({
  auth: { uid: `${role}-uid`, token: { role, email: `${role}@test.com` } },
  data,
});
const receipt = (over: Record<string, unknown> = {}) => ({
  batchId: BATCH_ID,
  amountCents: 100000,
  receivedOn: '2026-07-17',
  bankReference: 'SPEI-0001',
  ...over,
});

function seedRemittance(over: Doc = {}) {
  mockStore.payrollRemittances[BATCH_ID] = {
    batchId: BATCH_ID,
    employerId: 'employer-uid-1',
    expectedCents: 170000,
    receivedCents: 0,
    status: 'expected',
    receipts: [],
    ...over,
  };
}

beforeEach(() => {
  mockStore.payrollRemittances = {};
  mockStore.audit_log = {};
  jest.clearAllMocks();
});

describe('remittanceStatus', () => {
  it.each([
    [170000, 0, 'expected'],
    [170000, 100000, 'partial'],
    [170000, 170000, 'received'],
    [170000, 170001, 'overpaid'],
  ])('expected %i, received %i → %s', (expected, received, status) => {
    expect(remittanceStatus(expected, received)).toBe(status);
  });

  it('converts ledger pesos to centavos without float dust', () => {
    expect(pesosToCents(1000.1)).toBe(100010);
    expect(pesosToCents(333.33)).toBe(33333);
    expect(pesosToCents(0.1 + 0.2)).toBe(30);
  });
});

describe('recordPayrollRemittance — who may call it', () => {
  it.each(['employer_admin', 'employee'])('refuses a %s: the employer cannot self-assert a remittance', async (role) => {
    seedRemittance();

    await expect(fn(opsRequest(receipt(), role))).rejects.toMatchObject({ code: 'permission-denied' });
    expect(mockStore.payrollRemittances[BATCH_ID]?.['receivedCents']).toBe(0);
  });

  it('refuses an unauthenticated caller', async () => {
    await expect(fn({ data: receipt() })).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it.each(['ops', 'admin', 'super_admin'])('accepts %s', async (role) => {
    seedRemittance();
    await expect(fn(opsRequest(receipt(), role))).resolves.toMatchObject({ status: 'partial' });
  });
});

describe('recordPayrollRemittance — booking a receipt', () => {
  it('books a partial transfer, then completes it', async () => {
    seedRemittance();

    const first = await fn(opsRequest(receipt()));
    expect(first).toEqual({ batchId: BATCH_ID, expectedCents: 170000, receivedCents: 100000, status: 'partial' });

    const second = await fn(opsRequest(receipt({ amountCents: 70000, bankReference: 'SPEI-0002' })));
    expect(second).toMatchObject({ receivedCents: 170000, status: 'received' });

    const doc = mockStore.payrollRemittances[BATCH_ID]!;
    expect(doc['status']).toBe('received');
    expect(doc['receipts']).toEqual([
      expect.objectContaining({ amountCents: 100000, receivedOn: '2026-07-17', bankReference: 'SPEI-0001', recordedBy: 'ops-uid' }),
      expect.objectContaining({ amountCents: 70000, bankReference: 'SPEI-0002' }),
    ]);
  });

  it('flags an overpayment rather than capping it', async () => {
    seedRemittance();

    const res = await fn(opsRequest(receipt({ amountCents: 200000 })));

    expect(res).toMatchObject({ receivedCents: 200000, status: 'overpaid' });
  });

  it('refuses the same bank reference twice, so a double-submit is not counted twice', async () => {
    seedRemittance();
    await fn(opsRequest(receipt()));

    await expect(fn(opsRequest(receipt()))).rejects.toMatchObject({ code: 'already-exists' });
    expect(mockStore.payrollRemittances[BATCH_ID]?.['receivedCents']).toBe(100000);
  });

  it('refuses a receipt against a batch with no expected remittance', async () => {
    await expect(fn(opsRequest(receipt()))).rejects.toMatchObject({ code: 'not-found' });
    expect(mockStore.payrollRemittances).toEqual({});
  });

  it.each([
    ['a peso amount instead of centavos', { amountCents: 1000.5 }],
    ['a zero amount', { amountCents: 0 }],
    ['a negative amount', { amountCents: -100 }],
    ['a free-text date', { receivedOn: 'yesterday' }],
    ['an empty bank reference', { bankReference: '   ' }],
  ])('rejects %s', async (_label, over) => {
    seedRemittance();

    await expect(fn(opsRequest(receipt(over)))).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(mockStore.payrollRemittances[BATCH_ID]?.['receivedCents']).toBe(0);
  });

  it('writes an audit entry in the same transaction', async () => {
    seedRemittance();

    await fn(opsRequest(receipt()));

    const entries = Object.values(mockStore.audit_log);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'payrollRemittances.received',
      actorUid: 'ops-uid',
      actorRole: 'ops',
      targetCollection: 'payrollRemittances',
      targetId: BATCH_ID,
      before: { receivedCents: 0, status: 'expected' },
      after: { receivedCents: 100000, status: 'partial' },
      meta: expect.objectContaining({ employerId: 'employer-uid-1', bankReference: 'SPEI-0001' }),
    });
  });
});
