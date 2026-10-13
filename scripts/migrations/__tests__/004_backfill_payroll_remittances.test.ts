/**
 * Tests for migration 004 against an in-memory Firestore double.
 *
 * Pinned here:
 *   - the default is a dry run that writes NOTHING (no transaction is opened);
 *   - `--apply` writes exactly the records the dry run announced;
 *   - a second run is a no-op (idempotent), and an existing record — with the
 *     receipts ops booked on it — is never touched;
 *   - a non-emulator target is refused without `--allow-production`;
 *   - receipts booked before the bank-reference index existed get their index
 *     entry (pass 2), with the same dry-run / idempotency guarantees, and the
 *     entry is one `recordPayrollRemittance` and `voidPayrollRemittanceReceipt`
 *     would have written themselves.
 *
 * No Firebase app is initialised and no network call is made — `run` takes its
 * Firestore handle as an argument.
 */

import type { Firestore } from 'firebase-admin/firestore';

import { bankReferenceDocId } from '../../../functions/src/payroll/remittanceLedger';
import {
  ALLOW_PRODUCTION_FLAG,
  APPLY_FLAG,
  MIGRATION_TAG,
  assertTargetAllowed,
  run,
} from '../004_backfill_payroll_remittances';

type Doc = Record<string, unknown>;
type Store = Record<string, Record<string, Doc>>;
type Filter = { field: string; value: unknown };

function makeDb(seed: Store) {
  const store: Store = { payrollBatches: {}, payrollDeductions: {}, payrollRemittances: {}, payrollRemittanceReferences: {} };
  for (const [col, docs] of Object.entries(seed)) store[col] = structuredClone(docs);
  let transactions = 0;
  let writes = 0;

  const queryResult = (col: string, filters: Filter[], startAfter: string | null, limit: number) => {
    const docs = Object.entries(store[col] ?? {})
      .filter(([id, data]) => (startAfter === null || id > startAfter) && filters.every((f) => data[f.field] === f.value))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, limit)
      .map(([id, data]) => ({ id, data: () => data }));
    return { docs, size: docs.length, empty: docs.length === 0 };
  };

  const makeQuery = (col: string, filters: Filter[], startAfter: string | null, limit: number): Doc => ({
    _query: { col, filters },
    where: (field: string, _op: string, value: unknown) => makeQuery(col, [...filters, { field, value }], startAfter, limit),
    orderBy: () => makeQuery(col, filters, startAfter, limit),
    startAfter: (id: string) => makeQuery(col, filters, id, limit),
    limit: (n: number) => makeQuery(col, filters, startAfter, n),
    get: async () => queryResult(col, filters, startAfter, limit),
  });

  const docRef = (col: string, id: string) => ({
    _doc: { col, id },
    get: async () => ({ exists: store[col]?.[id] !== undefined, data: () => store[col]?.[id] }),
  });

  const db = {
    collection: (col: string) => ({ ...makeQuery(col, [], null, Infinity), doc: (id: string) => docRef(col, id) }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      transactions++;
      const staged: Array<() => void> = [];
      const tx = {
        get: async (target: { _doc?: { col: string; id: string }; _query?: { col: string; filters: Filter[] } }) => {
          if (target._query) return queryResult(target._query.col, target._query.filters, null, Infinity);
          const { col, id } = target._doc!;
          return { exists: store[col]?.[id] !== undefined, data: () => store[col]?.[id] };
        },
        set: (ref: { _doc: { col: string; id: string } }, data: Doc, opts?: { merge?: boolean }) => {
          staged.push(() => {
            const { col, id } = ref._doc;
            (store[col] ??= {})[id] = opts?.merge ? { ...(store[col]![id] ?? {}), ...data } : { ...data };
            writes++;
          });
        },
      };
      const out = await fn(tx);
      staged.forEach((apply) => apply());
      return out;
    },
  } as unknown as Firestore;

  return { db, store, stats: () => ({ transactions, writes }) };
}

const batch = (employerId: string, end: string, over: Doc = {}) => ({
  employerId,
  payPeriodStart: end.replace(/-\d\d$/, '-01'),
  payPeriodEnd: end,
  status: 'completed',
  ...over,
});

function seed(): Store {
  return {
    payrollBatches: {
      'emp1_2026-05-01_2026-05-15': batch('emp1', '2026-05-15'),
      'emp1_2026-06-01_2026-06-15': batch('emp1', '2026-06-15'),
      'emp1_2026-07-01_2026-07-15': batch('emp1', '2026-07-15', { status: 'in_progress' }),
      'emp2_2026-05-01_2026-05-15': batch('emp2', '2026-05-15'),
      'emp3_2026-05-01_2026-05-15': batch('emp3', '2026-05-15'),
      'emp4_broken': { status: 'completed', payPeriodEnd: '2026-05-15' },
    },
    payrollDeductions: {
      d1: { batchId: 'emp1_2026-05-01_2026-05-15', deductionAmount: 1000.1 },
      d2: { batchId: 'emp1_2026-05-01_2026-05-15', deductionAmount: 333.33 },
      d3: { batchId: 'emp1_2026-06-01_2026-06-15', deductionAmount: 500 },
      d4: { batchId: 'emp1_2026-07-01_2026-07-15', deductionAmount: 700 },
      d5: { batchId: 'emp2_2026-05-01_2026-05-15', deductionAmount: 250 },
      // emp3's batch completed with every row skipped: no deductions.
    },
    payrollRemittances: {
      // Native record with a receipt ops already booked. Its expectedCents is
      // deliberately not what the deductions sum to: the backfill must not "fix" it.
      'emp1_2026-06-01_2026-06-15': {
        batchId: 'emp1_2026-06-01_2026-06-15',
        employerId: 'emp1',
        expectedCents: 12345,
        receivedCents: 12345,
        status: 'received',
        receipts: [{ receiptId: 'r1', amountCents: 12345, bankReference: 'SPEI-1' }],
      },
    },
  };
}

const quiet = { log: () => undefined };

describe('assertTargetAllowed', () => {
  it('allows the emulator without any flag', () => {
    expect(assertTargetAllowed({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }, [])).toBe('emulator');
  });

  it('refuses a live Firestore by default — even for a dry run, even with --apply', () => {
    expect(() => assertTargetAllowed({}, [])).toThrow(/Refusing to run/);
    expect(() => assertTargetAllowed({ GCLOUD_PROJECT: 'vida-finance' }, [APPLY_FLAG])).toThrow(/Refusing to run/);
    expect(() => assertTargetAllowed({ FIRESTORE_EMULATOR_HOST: '' }, [])).toThrow(/Refusing to run/);
  });

  it('allows a live Firestore only with the explicit flag', () => {
    expect(assertTargetAllowed({}, [ALLOW_PRODUCTION_FLAG])).toBe('live');
  });
});

describe('migration 004 — dry run (the default)', () => {
  it('reports what it would create and writes nothing', async () => {
    const { db, store, stats } = makeDb(seed());
    const before = structuredClone(store);

    const report = await run(db, { apply: false, ...quiet });

    expect(report.apply).toBe(false);
    expect(report.counts).toEqual({
      create: 2,
      exists: 1,
      'not-completed': 1,
      'nothing-deducted': 1,
      malformed: 1,
    });
    expect(report.rows.filter((r) => r.outcome === 'create')).toEqual([
      { batchId: 'emp1_2026-05-01_2026-05-15', outcome: 'create', expectedCents: 133343 },
      { batchId: 'emp2_2026-05-01_2026-05-15', outcome: 'create', expectedCents: 25000 },
    ]);
    expect(report.createdExpectedCents).toBe(158343);
    expect(store).toEqual(before);
    expect(stats()).toEqual({ transactions: 0, writes: 0 });
  });
});

describe('migration 004 — apply', () => {
  it('creates exactly the records the dry run announced, in integer centavos', async () => {
    const { db, store } = makeDb(seed());
    const dry = await run(db, { apply: false, ...quiet });

    const report = await run(db, { apply: true, ...quiet });

    expect(report.rows).toEqual(dry.rows);
    expect(store['payrollRemittances']!['emp1_2026-05-01_2026-05-15']).toMatchObject({
      batchId: 'emp1_2026-05-01_2026-05-15',
      employerId: 'emp1',
      payPeriodStart: '2026-05-01',
      payPeriodEnd: '2026-05-15',
      expectedCents: 133343,
      deductionCount: 2,
      receivedCents: 0,
      status: 'expected',
      receipts: [],
      backfilledBy: MIGRATION_TAG,
    });
    expect(store['payrollRemittances']!['emp2_2026-05-01_2026-05-15']).toMatchObject({ expectedCents: 25000 });
  });

  it('writes no record for in-progress, empty or malformed batches', async () => {
    const { db, store } = makeDb(seed());

    await run(db, { apply: true, ...quiet });

    expect(Object.keys(store['payrollRemittances']!).sort()).toEqual([
      'emp1_2026-05-01_2026-05-15',
      'emp1_2026-06-01_2026-06-15',
      'emp2_2026-05-01_2026-05-15',
    ]);
  });

  it('never touches a record that already exists, receipts included', async () => {
    const original = seed();
    const { db, store } = makeDb(original);

    await run(db, { apply: true, ...quiet });

    expect(store['payrollRemittances']!['emp1_2026-06-01_2026-06-15']).toEqual(
      original['payrollRemittances']!['emp1_2026-06-01_2026-06-15'],
    );
  });

  it('is idempotent: a second run writes nothing', async () => {
    const { db, store, stats } = makeDb(seed());
    await run(db, { apply: true, ...quiet });
    const afterFirst = structuredClone(store);
    const writesAfterFirst = stats().writes;
    // Two records, plus the index entry for the receipt already on emp1's June record.
    expect(writesAfterFirst).toBe(3);

    const second = await run(db, { apply: true, ...quiet });

    expect(second.counts).toMatchObject({ create: 0, exists: 3 });
    expect(second.referenceIndex.counts).toEqual({ create: 0, exists: 1, 'no-reference': 0 });
    expect(store).toEqual(afterFirst);
    expect(stats().writes).toBe(writesAfterFirst);
  });

  it('pages through more batches than fit in one page', async () => {
    const many: Store = { payrollBatches: {}, payrollDeductions: {} };
    for (let i = 0; i < 450; i++) {
      const id = `emp_${String(i).padStart(4, '0')}`;
      many['payrollBatches']![id] = batch('emp', '2026-05-15');
      many['payrollDeductions']![`d${i}`] = { batchId: id, deductionAmount: 1 };
    }
    const { db, store } = makeDb(many);

    const report = await run(db, { apply: true, ...quiet });

    expect(report.counts.create).toBe(450);
    expect(report.createdExpectedCents).toBe(45000);
    expect(Object.keys(store['payrollRemittances']!)).toHaveLength(450);
  });
});

describe('migration 004 — bank-reference index for receipts booked before it existed', () => {
  const REFS = 'payrollRemittanceReferences';
  const record = (batchId: string, employerId: string, receipts: Doc[]): Doc => ({
    batchId,
    employerId,
    payPeriodStart: '2026-04-01',
    payPeriodEnd: '2026-04-15',
    expectedCents: 100000,
    receivedCents: 0,
    status: 'expected',
    receipts,
  });

  /** Only remittance records: pass 1 has nothing to do, so every write is pass 2's. */
  function legacySeed(): Store {
    return {
      payrollRemittances: {
        legacy_1: record('legacy_1', 'emp2', [
          { amountCents: 40000, receivedOn: '2026-04-17', bankReference: '  spei   0001 abc ' },
          { amountCents: 99999, receivedOn: '2026-04-17', bankReference: 'SPEI-VOIDED', voided: true },
          { amountCents: 20000, receivedOn: '2026-04-18', bankReference: 'spei-shared-9' },
          { amountCents: 500, receivedOn: '2026-04-19' },
        ]),
        legacy_2: record('legacy_2', 'emp3', [{ amountCents: 20000, receivedOn: '2026-05-02', bankReference: 'SPEI-SHARED-9' }]),
        native_1: record('native_1', 'emp1', [
          { receiptId: 'rcpt-1', amountCents: 100000, bankReference: 'SPEI-NATIVE', bankReferenceKey: 'SPEI-NATIVE' },
        ]),
      },
      [REFS]: {
        [bankReferenceDocId('SPEI-NATIVE')]: {
          bankReferenceKey: 'SPEI-NATIVE',
          holders: [{ batchId: 'native_1', receiptId: 'rcpt-1', employerId: 'emp1' }],
          updatedAt: 'T0',
        },
      },
    };
  }

  const wantRows = [
    { batchId: 'legacy_1', receiptId: 'legacy-0', bankReferenceKey: 'SPEI 0001 ABC', outcome: 'create' },
    { batchId: 'legacy_1', receiptId: 'legacy-2', bankReferenceKey: 'SPEI-SHARED-9', outcome: 'create' },
    { batchId: 'legacy_1', receiptId: 'legacy-3', bankReferenceKey: '', outcome: 'no-reference' },
    { batchId: 'legacy_2', receiptId: 'legacy-0', bankReferenceKey: 'SPEI-SHARED-9', outcome: 'create' },
    { batchId: 'native_1', receiptId: 'rcpt-1', bankReferenceKey: 'SPEI-NATIVE', outcome: 'exists' },
  ];

  it('dry run: reports the entries it would write, and writes nothing', async () => {
    const { db, store, stats } = makeDb(legacySeed());
    const before = structuredClone(store);

    const report = await run(db, { apply: false, ...quiet });

    expect(report.referenceIndex.rows).toEqual(wantRows);
    expect(report.referenceIndex.counts).toEqual({ create: 3, exists: 1, 'no-reference': 1 });
    expect(report.referenceIndex.sharedReferences).toEqual([
      { bankReferenceKey: 'SPEI-SHARED-9', batchIds: ['legacy_1', 'legacy_2'] },
    ]);
    expect(store).toEqual(before);
    expect(stats()).toEqual({ transactions: 0, writes: 0 });
  });

  it('apply: indexes every live receipt under the key and id the callables use for it', async () => {
    const { db, store } = makeDb(legacySeed());

    const report = await run(db, { apply: true, ...quiet });

    expect(report.referenceIndex.rows).toEqual(wantRows);
    const refs = store[REFS]!;
    expect(Object.keys(refs).sort()).toEqual(
      ['SPEI-NATIVE', 'SPEI 0001 ABC', 'SPEI-SHARED-9'].map(bankReferenceDocId).sort(),
    );
    expect(refs[bankReferenceDocId('SPEI 0001 ABC')]).toMatchObject({
      bankReferenceKey: 'SPEI 0001 ABC',
      holders: [{ batchId: 'legacy_1', receiptId: 'legacy-0', employerId: 'emp2' }],
      backfilledBy: MIGRATION_TAG,
    });
    // One transfer on two batches: both hold it, and it is listed for review.
    expect(refs[bankReferenceDocId('SPEI-SHARED-9')]!['holders']).toEqual([
      { batchId: 'legacy_1', receiptId: 'legacy-2', employerId: 'emp2' },
      { batchId: 'legacy_2', receiptId: 'legacy-0', employerId: 'emp3' },
    ]);
    expect(report.referenceIndex.sharedReferences).toEqual([
      { bankReferenceKey: 'SPEI-SHARED-9', batchIds: ['legacy_1', 'legacy_2'] },
    ]);
  });

  it('a voided receipt and a receipt with no reference get no entry', async () => {
    const { db, store } = makeDb(legacySeed());

    await run(db, { apply: true, ...quiet });

    expect(store[REFS]![bankReferenceDocId('SPEI-VOIDED')]).toBeUndefined();
    expect(store[REFS]![bankReferenceDocId('')]).toBeUndefined();
  });

  it('never touches a remittance record, nor an index entry that is already right', async () => {
    const original = legacySeed();
    const { db, store } = makeDb(original);

    await run(db, { apply: true, ...quiet });

    expect(store['payrollRemittances']).toEqual(original['payrollRemittances']);
    expect(store[REFS]![bankReferenceDocId('SPEI-NATIVE')]).toEqual(original[REFS]![bankReferenceDocId('SPEI-NATIVE')]);
  });

  it('adds to an entry another batch already holds instead of replacing it', async () => {
    const seeded = legacySeed();
    seeded[REFS]![bankReferenceDocId('SPEI 0001 ABC')] = {
      bankReferenceKey: 'SPEI 0001 ABC',
      holders: [{ batchId: 'someone_else', receiptId: 'rcpt-9', employerId: 'emp9' }],
      updatedAt: 'T0',
    };
    const { db, store } = makeDb(seeded);

    const report = await run(db, { apply: true, ...quiet });

    expect(store[REFS]![bankReferenceDocId('SPEI 0001 ABC')]!['holders']).toEqual([
      { batchId: 'someone_else', receiptId: 'rcpt-9', employerId: 'emp9' },
      { batchId: 'legacy_1', receiptId: 'legacy-0', employerId: 'emp2' },
    ]);
    expect(report.referenceIndex.sharedReferences.map((r) => r.bankReferenceKey)).toEqual(['SPEI 0001 ABC', 'SPEI-SHARED-9']);
  });

  it('is idempotent: a second run writes nothing and adds no duplicate holder', async () => {
    const { db, store, stats } = makeDb(legacySeed());
    await run(db, { apply: true, ...quiet });
    const afterFirst = structuredClone(store);
    const writesAfterFirst = stats().writes;
    expect(writesAfterFirst).toBe(3);

    const second = await run(db, { apply: true, ...quiet });

    expect(second.referenceIndex.counts).toEqual({ create: 0, exists: 4, 'no-reference': 1 });
    expect(store).toEqual(afterFirst);
    expect(stats().writes).toBe(writesAfterFirst);
  });

  it('pages through more records than fit in one page', async () => {
    const many: Store = { payrollRemittances: {} };
    for (let i = 0; i < 450; i++) {
      const id = `rec_${String(i).padStart(4, '0')}`;
      many['payrollRemittances']![id] = record(id, 'emp', [{ amountCents: 1, bankReference: `REF-${i}` }]);
    }
    const { db, store } = makeDb(many);

    const report = await run(db, { apply: true, ...quiet });

    expect(report.referenceIndex.counts.create).toBe(450);
    expect(Object.keys(store[REFS]!)).toHaveLength(450);
    expect(report.referenceIndex.sharedReferences).toEqual([]);
  });
});
