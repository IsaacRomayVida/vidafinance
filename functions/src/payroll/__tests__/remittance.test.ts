/**
 * E18 — recording that an employer actually remitted what it deducted.
 *
 * `processPayroll` writes the expected side of `payrollRemittances/{batchId}`
 * (covered in processPayroll.test.ts). These tests cover the other side: the
 * ops/admin callables that book a received bank transfer against a batch, void
 * one booked in error, and list what is still owed. The employer must not be
 * able to call any of them — a remittance the employer asserts about itself is
 * the unverified claim E18 exists to replace.
 *
 * The pure arithmetic (dates, reference normalisation, aging) is covered in
 * remittanceLedger.test.ts.
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
type CollectionName =
  | 'payrollRemittances'
  | 'payrollRemittanceReferences'
  | 'payrollBatches'
  | 'payrollDeductions'
  | 'audit_log';

const mockStore: Record<CollectionName, Record<string, Doc>> = {
  payrollRemittances: {},
  payrollRemittanceReferences: {},
  payrollBatches: {},
  payrollDeductions: {},
  audit_log: {},
};
let mockAutoId = 0;
/** Every query the code ran, so a test can pin that it filtered server-side. */
const mockQueries: Array<{ collection: string; filters: Filter[]; limit: number | null }> = [];

const mockFieldValue = { serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })) };

class MockTimestamp {
  constructor(public millis: number) {}
  static now() {
    return new MockTimestamp(Date.now());
  }
  toDate() {
    return new Date(this.millis);
  }
}

type Filter = { field: string; op: string; value: unknown };
type Ref = { _collection: CollectionName; id: string };
type Query = { _collection: CollectionName; _filters: Filter[] };

function mockRunQuery(collection: CollectionName, filters: Filter[], limit: number | null) {
  mockQueries.push({ collection, filters, limit });
  const docs = Object.entries(mockStore[collection])
    .filter(([, doc]) =>
      filters.every((f) => {
        if (f.op === '==') return doc[f.field] === f.value;
        if (f.op === 'in') return (f.value as unknown[]).includes(doc[f.field]);
        throw new Error(`unsupported operator ${f.op}`);
      }),
    )
    .slice(0, limit ?? Infinity)
    .map(([id, data]) => ({ id, data: () => data }));
  return { docs, size: docs.length, empty: docs.length === 0 };
}

const mockMakeQuery = (collection: CollectionName, filters: Filter[]): Record<string, unknown> => ({
  _collection: collection,
  _filters: filters,
  where: (field: string, op: string, value: unknown) => mockMakeQuery(collection, [...filters, { field, op, value }]),
  limit: (n: number) => ({ get: async () => mockRunQuery(collection, filters, n) }),
  get: async () => mockRunQuery(collection, filters, null),
});

const mockDb = {
  collection: jest.fn((name: CollectionName) => ({
    ...mockMakeQuery(name, []),
    doc: (id?: string) => ({ _collection: name, id: id ?? `auto-${++mockAutoId}` }),
  })),
  runTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    // Staged, then committed only if the body resolves — a throwing body
    // writes nothing, as with the real SDK. Like the real SDK it also refuses
    // a read after a write.
    const staged: Array<() => void> = [];
    const tx = {
      get: jest.fn(async (target: Ref | Query) => {
        if (staged.length > 0) throw new Error('Firestore transactions require all reads before all writes');
        if ('_filters' in target) return mockRunQuery(target._collection, target._filters, null);
        const entry = mockStore[target._collection][target.id];
        return { exists: entry !== undefined, data: () => entry };
      }),
      update: jest.fn((ref: Ref, data: Doc) => {
        staged.push(() => {
          if (!mockStore[ref._collection][ref.id]) throw new Error(`update of missing doc ${ref.id}`);
          mockStore[ref._collection][ref.id] = { ...mockStore[ref._collection][ref.id], ...data };
        });
      }),
      set: jest.fn((ref: Ref, data: Doc) => {
        staged.push(() => {
          mockStore[ref._collection][ref.id] = { ...data };
        });
      }),
      delete: jest.fn((ref: Ref) => {
        staged.push(() => {
          delete mockStore[ref._collection][ref.id];
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

import {
  recordPayrollRemittance,
  voidPayrollRemittanceReceipt,
  listPayrollRemittances,
  toRemittanceView,
} from '../remittance';

type Handler = (req: { auth?: unknown; data: unknown }) => Promise<Record<string, unknown>>;
const record = recordPayrollRemittance as unknown as Handler;
const voidReceipt = voidPayrollRemittanceReceipt as unknown as Handler;
const list = listPayrollRemittances as unknown as Handler;

const BATCH_ID = 'employer-uid-1_2026-07-01_2026-07-15';
const OTHER_BATCH_ID = 'employer-uid-1_2026-07-16_2026-07-31';

const opsRequest = (data: unknown, role = 'ops') => ({
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

function seedRemittance(over: Doc = {}, batchId = BATCH_ID) {
  mockStore.payrollRemittances[batchId] = {
    batchId,
    employerId: 'employer-uid-1',
    payPeriodStart: '2026-07-01',
    payPeriodEnd: '2026-07-15',
    expectedCents: 170000,
    receivedCents: 0,
    status: 'expected',
    receipts: [],
    ...over,
  };
}

const stored = (batchId = BATCH_ID) => mockStore.payrollRemittances[batchId]!;
const storedReceipts = (batchId = BATCH_ID) => stored(batchId)['receipts'] as Doc[];
const auditEntries = () => Object.values(mockStore.audit_log);

/** 2026-07-20 12:00 in Mexico City (UTC-6, no DST). */
const NOON_JUL_20 = Date.parse('2026-07-20T18:00:00Z');
let nowSpy: jest.SpyInstance<number, []>;
const setNow = (iso: string) => nowSpy.mockReturnValue(Date.parse(iso));

beforeEach(() => {
  for (const name of Object.keys(mockStore) as CollectionName[]) mockStore[name] = {};
  mockQueries.length = 0;
  mockAutoId = 0;
  jest.clearAllMocks();
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOON_JUL_20);
});

afterEach(() => {
  nowSpy.mockRestore();
});

describe('recordPayrollRemittance — who may call it', () => {
  it.each(['employer_admin', 'employee'])('refuses a %s: the employer cannot self-assert a remittance', async (role) => {
    seedRemittance();

    await expect(record(opsRequest(receipt(), role))).rejects.toMatchObject({ code: 'permission-denied' });
    expect(stored()['receivedCents']).toBe(0);
  });

  it('refuses an unauthenticated caller', async () => {
    await expect(record({ data: receipt() })).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it.each(['ops', 'admin', 'super_admin'])('accepts %s', async (role) => {
    seedRemittance();
    await expect(record(opsRequest(receipt(), role))).resolves.toMatchObject({ status: 'partial' });
  });
});

describe('recordPayrollRemittance — booking a receipt', () => {
  it('books a partial transfer, then completes it', async () => {
    seedRemittance();

    const first = await record(opsRequest(receipt()));
    expect(first).toEqual({
      batchId: BATCH_ID,
      receiptId: expect.any(String),
      expectedCents: 170000,
      receivedCents: 100000,
      status: 'partial',
      createdRecord: false,
    });

    const second = await record(opsRequest(receipt({ amountCents: 70000, bankReference: 'SPEI-0002' })));
    expect(second).toMatchObject({ receivedCents: 170000, status: 'received' });
    expect(second['receiptId']).not.toBe(first['receiptId']);

    expect(stored()['status']).toBe('received');
    expect(stored()['lastReceivedOn']).toBe('2026-07-17');
    expect(storedReceipts()).toEqual([
      expect.objectContaining({
        receiptId: first['receiptId'],
        amountCents: 100000,
        receivedOn: '2026-07-17',
        bankReference: 'SPEI-0001',
        recordedBy: 'ops-uid',
      }),
      expect.objectContaining({ receiptId: second['receiptId'], amountCents: 70000, bankReference: 'SPEI-0002' }),
    ]);
  });

  it('flags an overpayment rather than capping it', async () => {
    seedRemittance();

    const res = await record(opsRequest(receipt({ amountCents: 200000 })));

    expect(res).toMatchObject({ receivedCents: 200000, status: 'overpaid' });
  });

  it('refuses the same bank reference twice, so a double-submit is not counted twice', async () => {
    seedRemittance();
    await record(opsRequest(receipt()));

    await expect(record(opsRequest(receipt()))).rejects.toMatchObject({ code: 'already-exists' });
    expect(stored()['receivedCents']).toBe(100000);
  });

  it('refuses a receipt against a batch that does not exist', async () => {
    await expect(record(opsRequest(receipt()))).rejects.toMatchObject({ code: 'not-found' });
    expect(mockStore.payrollRemittances).toEqual({});
    expect(mockStore.payrollRemittanceReferences).toEqual({});
  });

  it.each([
    ['a peso amount instead of centavos', { amountCents: 1000.5 }],
    ['a zero amount', { amountCents: 0 }],
    ['a negative amount', { amountCents: -100 }],
    ['a free-text date', { receivedOn: 'yesterday' }],
    ['an empty bank reference', { bankReference: '   ' }],
  ])('rejects %s', async (_label, over) => {
    seedRemittance();

    await expect(record(opsRequest(receipt(over)))).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(stored()['receivedCents']).toBe(0);
  });

  it('writes an audit entry in the same transaction', async () => {
    seedRemittance();

    const res = await record(opsRequest(receipt()));

    expect(auditEntries()).toHaveLength(1);
    expect(auditEntries()[0]).toMatchObject({
      action: 'payrollRemittances.received',
      actorUid: 'ops-uid',
      actorRole: 'ops',
      targetCollection: 'payrollRemittances',
      targetId: BATCH_ID,
      before: { receivedCents: 0, status: 'expected' },
      after: { receivedCents: 100000, status: 'partial' },
      meta: expect.objectContaining({
        employerId: 'employer-uid-1',
        bankReference: 'SPEI-0001',
        receiptId: res['receiptId'],
      }),
    });
  });

  it('recomputes the total from the receipts rather than trusting a stored figure that has drifted', async () => {
    seedRemittance({
      receivedCents: 999999,
      receipts: [{ amountCents: 50000, receivedOn: '2026-07-16', bankReference: 'SPEI-OLD' }],
    });

    const res = await record(opsRequest(receipt()));

    expect(res).toMatchObject({ receivedCents: 150000, status: 'partial' });
  });
});

describe('recordPayrollRemittance — receivedOn must be a real date, not in the future', () => {
  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2026-06-31', '2025-02-29'])(
    'rejects %s, a day that does not exist',
    async (receivedOn) => {
      seedRemittance();

      await expect(record(opsRequest(receipt({ receivedOn })))).rejects.toMatchObject({ code: 'invalid-argument' });
      expect(storedReceipts()).toEqual([]);
    },
  );

  it('accepts a real leap day', async () => {
    seedRemittance();
    await expect(record(opsRequest(receipt({ receivedOn: '2024-02-29' })))).resolves.toMatchObject({ status: 'partial' });
  });

  it('accepts today and rejects tomorrow', async () => {
    seedRemittance();

    await expect(record(opsRequest(receipt({ receivedOn: '2026-07-21' })))).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining('future'),
    });
    expect(storedReceipts()).toEqual([]);

    await expect(record(opsRequest(receipt({ receivedOn: '2026-07-20' })))).resolves.toMatchObject({ status: 'partial' });
  });

  it('takes "today" from Mexico City, not from UTC', async () => {
    // 21:00 on the 20th in Mexico City is already 03:00 on the 21st in UTC.
    setNow('2026-07-21T03:00:00Z');
    seedRemittance();

    await expect(record(opsRequest(receipt({ receivedOn: '2026-07-21' })))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(record(opsRequest(receipt({ receivedOn: '2026-07-20' })))).resolves.toMatchObject({ status: 'partial' });
  });
});

describe('recordPayrollRemittance — bank reference dedupe', () => {
  it('treats case and whitespace variants as the same transfer', async () => {
    seedRemittance();
    await record(opsRequest(receipt({ bankReference: 'SPEI 0001 abc' })));

    for (const variant of ['spei 0001 ABC', '  SPEI   0001\tabc  ', 'Spei 0001 Abc']) {
      await expect(record(opsRequest(receipt({ bankReference: variant })))).rejects.toMatchObject({
        code: 'already-exists',
        details: { reason: 'bank-reference-in-batch', batchIds: [BATCH_ID] },
      });
    }
    expect(stored()['receivedCents']).toBe(100000);
  });

  it('stores the reference as typed alongside the normalised key', async () => {
    seedRemittance();

    await record(opsRequest(receipt({ bankReference: '  spei   0001 abc ' })));

    expect(storedReceipts()[0]).toMatchObject({
      bankReference: 'spei   0001 abc',
      bankReferenceKey: 'SPEI 0001 ABC',
    });
  });

  it('catches a duplicate of a receipt booked before keys were stored', async () => {
    seedRemittance({
      receivedCents: 100000,
      status: 'partial',
      receipts: [{ amountCents: 100000, receivedOn: '2026-07-17', bankReference: 'SPEI-0001' }],
    });

    await expect(record(opsRequest(receipt({ bankReference: 'spei-0001' })))).rejects.toMatchObject({
      code: 'already-exists',
    });
  });

  it('refuses a reference already booked against another batch', async () => {
    seedRemittance();
    seedRemittance({}, OTHER_BATCH_ID);
    await record(opsRequest(receipt()));

    await expect(
      record(opsRequest(receipt({ batchId: OTHER_BATCH_ID, bankReference: 'spei-0001' }))),
    ).rejects.toMatchObject({
      code: 'already-exists',
      details: { reason: 'bank-reference-in-other-batch', batchIds: [BATCH_ID] },
    });
    expect(stored(OTHER_BATCH_ID)['receivedCents']).toBe(0);
    expect(auditEntries()).toHaveLength(1);
  });

  it('books one transfer against two batches only when ops says it covers both', async () => {
    seedRemittance();
    seedRemittance({}, OTHER_BATCH_ID);
    await record(opsRequest(receipt()));

    const res = await record(opsRequest(receipt({ batchId: OTHER_BATCH_ID, sharedTransfer: true })));

    expect(res).toMatchObject({ batchId: OTHER_BATCH_ID, receivedCents: 100000 });
    const [reference] = Object.values(mockStore.payrollRemittanceReferences);
    expect((reference!['holders'] as Doc[]).map((h) => h['batchId'])).toEqual([BATCH_ID, OTHER_BATCH_ID]);
    expect(auditEntries()[1]).toMatchObject({ meta: expect.objectContaining({ sharedTransferWith: [BATCH_ID] }) });

    // The acknowledgement does not waive the within-batch check.
    await expect(
      record(opsRequest(receipt({ batchId: OTHER_BATCH_ID, sharedTransfer: true }))),
    ).rejects.toMatchObject({ code: 'already-exists', details: { reason: 'bank-reference-in-batch' } });
  });
});

describe('recordPayrollRemittance — a batch processed before the ledger shipped', () => {
  function seedLegacyBatch(deductions: number[]) {
    mockStore.payrollBatches[BATCH_ID] = {
      employerId: 'employer-uid-1',
      payPeriodStart: '2026-07-01',
      payPeriodEnd: '2026-07-15',
      status: 'completed',
    };
    deductions.forEach((deductionAmount, i) => {
      mockStore.payrollDeductions[`${BATCH_ID}_loan-${i}`] = { batchId: BATCH_ID, deductionAmount };
    });
    // Another batch's deductions must not leak into the sum.
    mockStore.payrollDeductions['other'] = { batchId: OTHER_BATCH_ID, deductionAmount: 9999 };
  }

  it('creates the record from the batch\'s deductions, in centavos, and books the receipt', async () => {
    seedLegacyBatch([1000.1, 333.33]);

    const res = await record(opsRequest(receipt()));

    expect(res).toMatchObject({ expectedCents: 133343, receivedCents: 100000, status: 'partial', createdRecord: true });
    expect(stored()).toMatchObject({
      batchId: BATCH_ID,
      employerId: 'employer-uid-1',
      payPeriodStart: '2026-07-01',
      payPeriodEnd: '2026-07-15',
      expectedCents: 133343,
      deductionCount: 2,
      receivedCents: 100000,
      status: 'partial',
      createdOnDemandBy: 'ops-uid',
    });
    expect(storedReceipts()).toHaveLength(1);
    expect(auditEntries()[0]).toMatchObject({
      before: { receivedCents: 0, status: null },
      meta: expect.objectContaining({ createdRecord: true, expectedCents: 133343 }),
    });
  });

  it('still refuses a batch that deducted nothing', async () => {
    seedLegacyBatch([]);

    await expect(record(opsRequest(receipt()))).rejects.toMatchObject({ code: 'not-found' });
    expect(mockStore.payrollRemittances).toEqual({});
  });

  it('does not create a record when the receipt itself is refused', async () => {
    seedLegacyBatch([1000]);
    seedRemittance({}, OTHER_BATCH_ID);
    await record(opsRequest(receipt({ batchId: OTHER_BATCH_ID })));

    await expect(record(opsRequest(receipt()))).rejects.toMatchObject({ code: 'already-exists' });
    expect(mockStore.payrollRemittances[BATCH_ID]).toBeUndefined();
  });
});

describe('voidPayrollRemittanceReceipt', () => {
  const voidInput = (over: Record<string, unknown> = {}) => ({
    batchId: BATCH_ID,
    reason: 'Booked against the wrong employer',
    ...over,
  });

  async function bookTwo() {
    seedRemittance();
    const first = await record(opsRequest(receipt()));
    const second = await record(
      opsRequest(receipt({ amountCents: 70000, bankReference: 'SPEI-0002', receivedOn: '2026-07-19' })),
    );
    return { firstId: first['receiptId'] as string, secondId: second['receiptId'] as string };
  }

  it.each(['employer_admin', 'employee'])('refuses a %s', async (role) => {
    const { firstId } = await bookTwo();

    await expect(voidReceipt(opsRequest(voidInput({ receiptId: firstId }), role))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(stored()['receivedCents']).toBe(170000);
  });

  it('refuses an unauthenticated caller', async () => {
    await expect(voidReceipt({ data: voidInput({ receiptId: 'x' }) })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('takes the receipt out of the totals but keeps it, with who, when and why', async () => {
    const { firstId, secondId } = await bookTwo();
    expect(stored()['status']).toBe('received');

    const res = await voidReceipt(opsRequest(voidInput({ receiptId: secondId }), 'admin'));

    expect(res).toEqual({
      batchId: BATCH_ID,
      receiptId: secondId,
      expectedCents: 170000,
      receivedCents: 100000,
      status: 'partial',
      alreadyVoided: false,
    });
    expect(stored()).toMatchObject({ receivedCents: 100000, status: 'partial', lastReceivedOn: '2026-07-17' });
    expect(storedReceipts()).toHaveLength(2);
    expect(storedReceipts()[0]).toMatchObject({ receiptId: firstId });
    expect(storedReceipts()[0]).not.toHaveProperty('voided');
    expect(storedReceipts()[1]).toMatchObject({
      receiptId: secondId,
      amountCents: 70000,
      bankReference: 'SPEI-0002',
      recordedBy: 'ops-uid',
      voided: true,
      voidedBy: 'admin-uid',
      voidedAt: expect.any(MockTimestamp),
      voidReason: 'Booked against the wrong employer',
    });
  });

  it('returns the record to "expected" when its only receipt is voided', async () => {
    seedRemittance();
    const { receiptId } = await record(opsRequest(receipt()));

    const res = await voidReceipt(opsRequest(voidInput({ receiptId })));

    expect(res).toMatchObject({ receivedCents: 0, status: 'expected' });
    expect(stored()).toMatchObject({ receivedCents: 0, status: 'expected', lastReceivedOn: null });
  });

  it('writes an audit entry carrying the reason', async () => {
    const { secondId } = await bookTwo();

    await voidReceipt(opsRequest(voidInput({ receiptId: secondId })));

    expect(auditEntries()).toHaveLength(3);
    expect(auditEntries()[2]).toMatchObject({
      action: 'payrollRemittances.receiptVoided',
      actorUid: 'ops-uid',
      actorRole: 'ops',
      targetCollection: 'payrollRemittances',
      targetId: BATCH_ID,
      before: { receivedCents: 170000, status: 'received' },
      after: { receivedCents: 100000, status: 'partial' },
      meta: {
        employerId: 'employer-uid-1',
        receiptId: secondId,
        amountCents: 70000,
        receivedOn: '2026-07-19',
        bankReference: 'SPEI-0002',
        recordedBy: 'ops-uid',
        reason: 'Booked against the wrong employer',
      },
    });
  });

  it('is idempotent: voiding twice changes nothing and logs once', async () => {
    const { secondId } = await bookTwo();
    await voidReceipt(opsRequest(voidInput({ receiptId: secondId })));
    const afterFirst = JSON.stringify(stored());

    const again = await voidReceipt(opsRequest(voidInput({ receiptId: secondId, reason: 'a different reason' }), 'admin'));

    expect(again).toMatchObject({ receivedCents: 100000, status: 'partial', alreadyVoided: true });
    expect(JSON.stringify(stored())).toBe(afterFirst);
    expect(auditEntries().filter((e) => e['action'] === 'payrollRemittances.receiptVoided')).toHaveLength(1);
  });

  it.each([
    ['no reason', { reason: undefined }],
    ['a blank reason', { reason: '   ' }],
    ['no receipt id', { receiptId: undefined }],
  ])('rejects %s', async (_label, over) => {
    const { secondId } = await bookTwo();

    await expect(voidReceipt(opsRequest(voidInput({ receiptId: secondId, ...over })))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(stored()['receivedCents']).toBe(170000);
  });

  it('reports not-found for an unknown batch or receipt', async () => {
    await bookTwo();

    await expect(voidReceipt(opsRequest(voidInput({ receiptId: 'nope' })))).rejects.toMatchObject({ code: 'not-found' });
    await expect(
      voidReceipt(opsRequest(voidInput({ batchId: 'no-such-batch', receiptId: 'nope' }))),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(stored()['receivedCents']).toBe(170000);
  });

  it('frees the bank reference for the same batch', async () => {
    seedRemittance();
    const { receiptId } = await record(opsRequest(receipt({ amountCents: 999 })));
    await voidReceipt(opsRequest(voidInput({ receiptId })));

    const rebooked = await record(opsRequest(receipt()));

    expect(rebooked).toMatchObject({ receivedCents: 100000, status: 'partial' });
    expect(storedReceipts()).toHaveLength(2);
  });

  it('frees the bank reference for another batch', async () => {
    seedRemittance();
    seedRemittance({}, OTHER_BATCH_ID);
    const { receiptId } = await record(opsRequest(receipt()));
    await voidReceipt(opsRequest(voidInput({ receiptId })));
    expect(mockStore.payrollRemittanceReferences).toEqual({});

    await expect(record(opsRequest(receipt({ batchId: OTHER_BATCH_ID })))).resolves.toMatchObject({
      batchId: OTHER_BATCH_ID,
      receivedCents: 100000,
    });
  });

  it('leaves the other batch holding a shared transfer\'s reference', async () => {
    seedRemittance();
    seedRemittance({}, OTHER_BATCH_ID);
    const { receiptId } = await record(opsRequest(receipt()));
    await record(opsRequest(receipt({ batchId: OTHER_BATCH_ID, sharedTransfer: true })));

    await voidReceipt(opsRequest(voidInput({ receiptId })));

    const [reference] = Object.values(mockStore.payrollRemittanceReferences);
    expect((reference!['holders'] as Doc[]).map((h) => h['batchId'])).toEqual([OTHER_BATCH_ID]);
    // Still held by the other batch, so booking it here again needs the acknowledgement.
    await expect(record(opsRequest(receipt()))).rejects.toMatchObject({
      details: { reason: 'bank-reference-in-other-batch', batchIds: [OTHER_BATCH_ID] },
    });
  });

  it('voids a receipt booked before receipts had ids', async () => {
    seedRemittance({
      receivedCents: 170000,
      status: 'received',
      receipts: [
        { amountCents: 100000, receivedOn: '2026-07-17', bankReference: 'SPEI-0001', recordedBy: 'ops-uid' },
        { amountCents: 70000, receivedOn: '2026-07-18', bankReference: 'spei-0002', recordedBy: 'ops-uid' },
      ],
    });

    const res = await voidReceipt(opsRequest(voidInput({ receiptId: 'legacy-1' })));

    expect(res).toMatchObject({ receivedCents: 100000, status: 'partial' });
    expect(storedReceipts()[1]).toMatchObject({ receiptId: 'legacy-1', bankReferenceKey: 'SPEI-0002', voided: true });
    expect(storedReceipts()[0]).not.toHaveProperty('voided');
  });
});

describe('listPayrollRemittances', () => {
  function seedFour() {
    // As of 2026-07-20 with the default 7-day grace:
    seedRemittance({ payPeriodEnd: '2026-06-15', receivedCents: 50000, status: 'partial' }, 'emp-a_old'); // 35 days → 28 overdue
    seedRemittance({ payPeriodEnd: '2026-07-10' }, 'emp-a_recent'); // 10 days → 3 overdue
    seedRemittance({ payPeriodEnd: '2026-07-15', employerId: 'employer-uid-2' }, 'emp-b_current'); // 5 days → in grace
    seedRemittance({ payPeriodEnd: '2026-05-31', receivedCents: 170000, status: 'received' }, 'emp-a_settled');
  }

  it.each(['employer_admin', 'employee'])('refuses a %s', async (role) => {
    await expect(list(opsRequest({}, role))).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('by default lists only what is still owed, longest overdue first, with totals', async () => {
    seedFour();

    const res = await list(opsRequest(undefined));

    expect(res).toMatchObject({ asOf: '2026-07-20', graceDays: 7, truncated: false });
    const rows = res['remittances'] as Array<Record<string, unknown>>;
    expect(rows.map((r) => r['batchId'])).toEqual(['emp-a_old', 'emp-a_recent', 'emp-b_current']);
    expect(rows[0]).toMatchObject({
      status: 'partial',
      expectedCents: 170000,
      receivedCents: 50000,
      aging: { outstandingCents: 120000, daysSincePeriodEnd: 35, daysOverdue: 28, overdue: true, bucket: 'overdue_16_30' },
    });
    expect(rows[2]).toMatchObject({ aging: { overdue: false, bucket: 'current', daysOverdue: 0 } });
    expect(res['totals']).toEqual({
      count: 3,
      expectedCents: 510000,
      receivedCents: 50000,
      outstandingCents: 460000,
      overdueCount: 2,
      overdueCents: 290000,
    });
    expect(mockQueries[0]).toMatchObject({
      collection: 'payrollRemittances',
      filters: [{ field: 'status', op: 'in', value: ['expected', 'partial'] }],
    });
  });

  it('overdueOnly drops what is still inside the grace window', async () => {
    seedFour();

    const res = await list(opsRequest({ overdueOnly: true }));

    expect((res['remittances'] as Array<Record<string, unknown>>).map((r) => r['batchId'])).toEqual([
      'emp-a_old',
      'emp-a_recent',
    ]);
  });

  it('honours a caller-supplied grace period', async () => {
    seedFour();

    const res = await list(opsRequest({ overdueOnly: true, graceDays: 0 }));

    expect(res['graceDays']).toBe(0);
    expect((res['remittances'] as unknown[])).toHaveLength(3);
  });

  it('view "all" includes settled records, after the ones that owe', async () => {
    seedFour();

    const res = await list(opsRequest({ view: 'all' }));

    const rows = res['remittances'] as Array<Record<string, unknown>>;
    expect(rows.map((r) => r['batchId'])).toEqual(['emp-a_old', 'emp-a_recent', 'emp-b_current', 'emp-a_settled']);
    expect(rows[3]).toMatchObject({ status: 'received', aging: { bucket: 'settled', outstandingCents: 0 } });
  });

  it('filters by employer', async () => {
    seedFour();

    const res = await list(opsRequest({ employerId: 'employer-uid-2' }));

    expect((res['remittances'] as Array<Record<string, unknown>>).map((r) => r['batchId'])).toEqual(['emp-b_current']);
  });

  it('returns receipts with ids and void details the UI can act on', async () => {
    seedRemittance();
    const { receiptId } = await record(opsRequest(receipt()));
    await voidReceipt(opsRequest({ batchId: BATCH_ID, receiptId, reason: 'wrong batch' }, 'admin'));
    await record(opsRequest(receipt({ amountCents: 20000 })));

    const res = await list(opsRequest({}));

    const [row] = res['remittances'] as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ receivedCents: 20000, status: 'partial' });
    expect(row!['receipts']).toEqual([
      {
        receiptId,
        amountCents: 100000,
        receivedOn: '2026-07-17',
        bankReference: 'SPEI-0001',
        recordedBy: 'ops-uid',
        recordedAt: '2026-07-20T18:00:00.000Z',
        voided: true,
        voidedBy: 'admin-uid',
        voidedAt: '2026-07-20T18:00:00.000Z',
        voidReason: 'wrong batch',
      },
      expect.objectContaining({ amountCents: 20000, voided: false, voidedBy: null, voidReason: null }),
    ]);
  });

  it.each([
    ['an unknown view', { view: 'mine' }],
    ['a negative grace period', { graceDays: -1 }],
    ['a fractional grace period', { graceDays: 1.5 }],
  ])('rejects %s', async (_label, input) => {
    await expect(list(opsRequest(input))).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('toRemittanceView', () => {
  it('derives status from the figures and gives legacy receipts a positional id', () => {
    const view = toRemittanceView(
      BATCH_ID,
      {
        employerId: 'employer-uid-1',
        payPeriodEnd: '2026-07-15',
        expectedCents: 1000,
        receivedCents: 1000,
        status: 'expected', // stale on purpose
        receipts: [{ amountCents: 1000, bankReference: 'A' }],
      },
      '2026-07-20',
      7,
    );

    expect(view.status).toBe('received');
    expect(view.receipts[0]).toMatchObject({ receiptId: 'legacy-0', voided: false, recordedAt: null });
  });
});
