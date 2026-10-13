/**
 * Rehearsal for migration 004 against the Firestore EMULATOR, with seeded data.
 *
 * Proves, against a real Firestore implementation rather than a test double:
 *   1. the dry run writes nothing (all four collections byte-for-byte unchanged)
 *      and announces exactly what the real run then does;
 *   2. the real run creates the missing remittance records, in integer
 *      centavos, and only those;
 *   3. the real run builds `payrollRemittanceReferences` entries for receipts
 *      booked before the index existed — with the ids and keys the callables
 *      compute for them — skips voided receipts, leaves an existing entry
 *      alone, and reports a reference held by two batches;
 *   4. a second real run is a no-op on content and document count (idempotent);
 *   5. batches, deductions and every pre-existing remittance record (receipts
 *      included) are untouched;
 *   6. the ledger's ordered, paginated query (`remittancesQuery`, used by
 *      `listPayrollRemittances` and the overdue alert) runs on a real Firestore
 *      and pages the backfilled records oldest first without a gap or repeat.
 *
 * What it does NOT prove: that the composite indexes in firestore.indexes.json
 * are sufficient. The emulator does not enforce composite indexes; only a real
 * project does.
 *
 * Refuses to start unless FIRESTORE_EMULATOR_HOST is set AND the project id
 * starts with `demo-` (a project the emulator can never forward to Google).
 * See docs/runbooks/payroll-remittances.md § "Rehearsal" for the command.
 */

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';

import { MIGRATION_TAG, run } from './004_backfill_payroll_remittances';
import {
  bankReferenceDocId,
  remittancesQuery,
  type RemittancePosition,
} from '../../functions/src/payroll/remittanceLedger';

const PROJECT = process.env['GCLOUD_PROJECT'] ?? '';
if (!process.env['FIRESTORE_EMULATOR_HOST'] || !PROJECT.startsWith('demo-')) {
  console.error('Refusing: set FIRESTORE_EMULATOR_HOST and a demo-* GCLOUD_PROJECT. This script seeds data.');
  process.exit(2);
}

const COLLECTIONS = ['payrollBatches', 'payrollDeductions', 'payrollRemittances', 'payrollRemittanceReferences'] as const;

/** Batches with deductions and no record: more than one page of the script's 200. */
const BULK_BATCHES = 230;

/** JSON with object keys sorted, so a comparison never depends on the order Firestore returns map fields in. */
function canon(value: unknown): string {
  // Round-tripped first so class instances (Timestamp) are plain objects too.
  const plain: unknown = value === undefined ? null : JSON.parse(JSON.stringify(value));
  return JSON.stringify(plain, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : v,
  );
}

async function dump(db: Firestore, col: string): Promise<Record<string, unknown>> {
  const snap = await db.collection(col).get();
  const out: Record<string, unknown> = {};
  for (const d of snap.docs) out[d.id] = d.data();
  return out;
}

async function dumpAll(db: Firestore): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const col of COLLECTIONS) out[col] = canon(await dump(db, col));
  return out;
}

let failures = 0;
function check(ok: boolean, label: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const bulkId = (i: number) => `bulk_${String(i).padStart(4, '0')}`;
const bulkPeriodEnd = (i: number) => new Date(Date.UTC(2025, 0, 15) + i * 86_400_000).toISOString().slice(0, 10);

async function seed(db: Firestore) {
  const stale = await dumpAll(db);
  if (Object.values(stale).some((json) => json !== '{}')) {
    throw new Error('The emulator already holds payroll data. Restart it (the rehearsal needs an empty project).');
  }

  const recordedAt = Timestamp.fromDate(new Date('2026-06-20T18:00:00Z'));
  const writes: Array<[string, string, Record<string, unknown>]> = [];
  const put = (col: string, id: string, data: Record<string, unknown>) => writes.push([col, id, data]);
  const batch = (employerId: string, start: string, end: string, over: Record<string, unknown> = {}) => ({
    employerId,
    payPeriodStart: start,
    payPeriodEnd: end,
    status: 'completed',
    ...over,
  });
  const record = (batchId: string, employerId: string, end: string, over: Record<string, unknown>) => ({
    batchId,
    employerId,
    payPeriodStart: end.replace(/-\d\d$/, '-01'),
    payPeriodEnd: end,
    expectedCents: 100000,
    deductionCount: 1,
    ...over,
  });

  // ── Pass 1 material: batches without a record ──
  put('payrollBatches', 'emp1_2026-05-01_2026-05-15', batch('emp1', '2026-05-01', '2026-05-15'));
  put('payrollDeductions', 'd1', { batchId: 'emp1_2026-05-01_2026-05-15', deductionAmount: 1000.1 });
  put('payrollDeductions', 'd2', { batchId: 'emp1_2026-05-01_2026-05-15', deductionAmount: 333.33 });
  put('payrollBatches', 'emp1_2026-07-01_2026-07-15', batch('emp1', '2026-07-01', '2026-07-15', { status: 'in_progress' }));
  put('payrollDeductions', 'd3', { batchId: 'emp1_2026-07-01_2026-07-15', deductionAmount: 700 });
  put('payrollBatches', 'emp3_2026-05-01_2026-05-15', batch('emp3', '2026-05-01', '2026-05-15')); // nothing deducted
  put('payrollBatches', 'emp4_broken', { status: 'completed', payPeriodEnd: '2026-05-15' }); // malformed
  put('payrollDeductions', 'd4', { batchId: 'emp4_broken', deductionAmount: 10 });
  for (let i = 0; i < BULK_BATCHES; i++) {
    put('payrollBatches', bulkId(i), batch('bulk', '2025-01-01', bulkPeriodEnd(i)));
    put('payrollDeductions', `bulk_d${i}`, { batchId: bulkId(i), deductionAmount: 0.01 * (i + 1) });
  }

  // ── Pass 2 material: records that already exist ──
  // (a) Booked by the current callable: has ids, keys and its index entry.
  put('payrollBatches', 'native_1', batch('emp1', '2026-06-01', '2026-06-15'));
  put('payrollDeductions', 'd5', { batchId: 'native_1', deductionAmount: 1000 });
  put(
    'payrollRemittances',
    'native_1',
    record('native_1', 'emp1', '2026-06-15', {
      receivedCents: 100000,
      status: 'received',
      receipts: [
        {
          receiptId: 'rcpt-native',
          amountCents: 100000,
          receivedOn: '2026-06-18',
          bankReference: 'SPEI-NATIVE-1',
          bankReferenceKey: 'SPEI-NATIVE-1',
          recordedBy: 'ops-1',
          recordedAt,
        },
      ],
    }),
  );
  put('payrollRemittanceReferences', bankReferenceDocId('SPEI-NATIVE-1'), {
    bankReferenceKey: 'SPEI-NATIVE-1',
    holders: [{ batchId: 'native_1', receiptId: 'rcpt-native', employerId: 'emp1' }],
    updatedAt: recordedAt,
  });
  // (b) Booked before ids, keys and the index existed: two live receipts, one
  //     voided, one with no reference at all.
  put(
    'payrollRemittances',
    'legacy_1',
    record('legacy_1', 'emp2', '2026-04-15', {
      receivedCents: 60000,
      status: 'partial',
      receipts: [
        { amountCents: 40000, receivedOn: '2026-04-17', bankReference: '  spei   0001 abc ', recordedBy: 'ops-1', recordedAt },
        { amountCents: 99999, receivedOn: '2026-04-17', bankReference: 'SPEI-VOIDED', recordedBy: 'ops-1', recordedAt, voided: true, voidedBy: 'ops-2', voidReason: 'wrong batch' },
        { amountCents: 20000, receivedOn: '2026-04-18', bankReference: 'spei-shared-9', recordedBy: 'ops-1', recordedAt },
        { amountCents: 0, receivedOn: '2026-04-19', recordedBy: 'ops-1', recordedAt },
      ],
    }),
  );
  // (c) Another pre-index record holding the same transfer as legacy_1.
  put(
    'payrollRemittances',
    'legacy_2',
    record('legacy_2', 'emp2', '2026-04-30', {
      receivedCents: 20000,
      status: 'partial',
      receipts: [{ amountCents: 20000, receivedOn: '2026-05-02', bankReference: 'SPEI-SHARED-9', recordedBy: 'ops-1', recordedAt }],
    }),
  );

  for (let i = 0; i < writes.length; i += 400) {
    const wb = db.batch();
    for (const [col, id, data] of writes.slice(i, i + 400)) wb.set(db.collection(col).doc(id), data);
    await wb.commit();
  }
}

const quiet = { log: () => undefined };

async function main() {
  initializeApp({ projectId: PROJECT });
  const db = getFirestore();
  await seed(db);
  const before = await dumpAll(db);
  const recordsBefore = JSON.parse(before['payrollRemittances']!) as Record<string, unknown>;

  console.log('\n=== 1. dry run ===');
  const dry = await run(db, { apply: false, ...quiet });
  const afterDry = await dumpAll(db);
  check(COLLECTIONS.every((c) => afterDry[c] === before[c]), 'dry run left all four collections unchanged');
  check(
    dry.counts.create === BULK_BATCHES + 1 &&
      dry.counts.exists === 1 &&
      dry.counts['not-completed'] === 1 &&
      dry.counts['nothing-deducted'] === 1 &&
      dry.counts.malformed === 1,
    `dry run plans ${dry.counts.create} records (expected ${BULK_BATCHES + 1}), 1 existing, 1 not completed, 1 nothing deducted, 1 malformed`,
  );
  check(
    dry.referenceIndex.counts.create === 3 && dry.referenceIndex.counts.exists === 1 && dry.referenceIndex.counts['no-reference'] === 1,
    `dry run plans ${dry.referenceIndex.counts.create} index entries (expected 3), 1 already indexed, 1 receipt without a reference`,
  );

  console.log('\n=== 2. real run: remittance records ===');
  const applied = await run(db, { apply: true });
  check(canon(applied.rows) === canon(dry.rows), 'real run did exactly what the dry run announced (records)');
  const records = await dump(db, 'payrollRemittances');
  const created = Object.values(records).filter((r) => (r as Record<string, unknown>)['backfilledBy'] === MIGRATION_TAG);
  check(created.length === BULK_BATCHES + 1, `records created = ${created.length} (expected ${BULK_BATCHES + 1})`);
  const emp1 = records['emp1_2026-05-01_2026-05-15'] as Record<string, unknown> | undefined;
  check(
    emp1?.['expectedCents'] === 133343 &&
      emp1?.['deductionCount'] === 2 &&
      emp1?.['receivedCents'] === 0 &&
      emp1?.['status'] === 'expected' &&
      emp1?.['employerId'] === 'emp1' &&
      emp1?.['payPeriodEnd'] === '2026-05-15' &&
      Array.isArray(emp1?.['receipts']) &&
      (emp1?.['receipts'] as unknown[]).length === 0,
    'spot-check emp1 May batch: 1000.10 + 333.33 pesos = 133343 centavos, status expected, no receipts',
  );
  const wantBulkCents = Array.from({ length: BULK_BATCHES }, (_, i) => i + 1).reduce((a, b) => a + b, 0) + 133343;
  check(
    applied.createdExpectedCents === wantBulkCents &&
      created.every((r) => Number.isInteger((r as Record<string, unknown>)['expectedCents'])),
    `created expected total = ${applied.createdExpectedCents} centavos (expected ${wantBulkCents}), every amount an integer`,
  );
  check(
    !('emp1_2026-07-01_2026-07-15' in records) && !('emp3_2026-05-01_2026-05-15' in records) && !('emp4_broken' in records),
    'no record for the in-progress, nothing-deducted or malformed batch',
  );

  console.log('\n=== 3. real run: bank-reference index ===');
  check(
    canon(applied.referenceIndex.rows) === canon(dry.referenceIndex.rows),
    'real run did exactly what the dry run announced (index)',
  );
  const index = await dump(db, 'payrollRemittanceReferences');
  const entry = (key: string) => index[bankReferenceDocId(key)] as { bankReferenceKey: string; holders: unknown[] } | undefined;
  check(Object.keys(index).length === 3, `index documents = ${Object.keys(index).length} (expected 3: native, SPEI 0001 ABC, SPEI-SHARED-9)`);
  check(
    canon(entry('SPEI 0001 ABC')?.holders) ===
      canon([{ batchId: 'legacy_1', receiptId: 'legacy-0', employerId: 'emp2' }]) &&
      entry('SPEI 0001 ABC')?.bankReferenceKey === 'SPEI 0001 ABC',
    'legacy receipt indexed under its normalised key with its positional id (legacy-0)',
  );
  check(
    canon(entry('SPEI-SHARED-9')?.holders) ===
      canon([
        { batchId: 'legacy_1', receiptId: 'legacy-2', employerId: 'emp2' },
        { batchId: 'legacy_2', receiptId: 'legacy-0', employerId: 'emp2' },
      ]),
    'a reference on two batches is indexed for both',
  );
  check(
    canon(applied.referenceIndex.sharedReferences) ===
      canon([{ bankReferenceKey: 'SPEI-SHARED-9', batchIds: ['legacy_1', 'legacy_2'] }]),
    'and reported for review as held by legacy_1 and legacy_2',
  );
  check(entry('SPEI-VOIDED') === undefined, 'a voided receipt gets no index entry');
  check(
    canon(index[bankReferenceDocId('SPEI-NATIVE-1')]) ===
      canon((JSON.parse(before['payrollRemittanceReferences']!) as Record<string, unknown>)[bankReferenceDocId('SPEI-NATIVE-1')]),
    'the index entry the callable wrote is byte-for-byte unchanged',
  );

  console.log('\n=== 4. re-run (idempotency) ===');
  const afterFirst = await dumpAll(db);
  const second = await run(db, { apply: true, ...quiet });
  const afterSecond = await dumpAll(db);
  check(COLLECTIONS.every((c) => afterSecond[c] === afterFirst[c]), 're-run left all four collections identical');
  check(
    second.counts.create === 0 && second.counts.exists === BULK_BATCHES + 2 && second.referenceIndex.counts.create === 0 && second.referenceIndex.counts.exists === 4,
    `re-run: ${second.counts.create} records to create, ${second.referenceIndex.counts.create} index entries to create (expected 0 and 0)`,
  );

  console.log('\n=== 5. untouched ===');
  check(afterSecond['payrollBatches'] === before['payrollBatches'], 'payrollBatches unchanged');
  check(afterSecond['payrollDeductions'] === before['payrollDeductions'], 'payrollDeductions unchanged');
  const recordsAfter = JSON.parse(afterSecond['payrollRemittances']!) as Record<string, unknown>;
  check(
    Object.keys(recordsBefore).every((id) => canon(recordsAfter[id]) === canon(recordsBefore[id])),
    'pre-existing remittance records unchanged, receipts included (no id or key stamped onto a legacy receipt)',
  );

  console.log('\n=== 6. the ordered ledger query on a real Firestore ===');
  const seen: string[] = [];
  let after: RemittancePosition | undefined;
  let pages = 0;
  for (;;) {
    const page = await remittancesQuery(db, { outstandingOnly: true, after }).limit(100).get();
    pages++;
    for (const d of page.docs) seen.push(`${String(d.data()['payPeriodEnd'])}|${d.id}`);
    const last = page.docs[page.docs.length - 1];
    if (!last || page.docs.length < 100) break;
    after = { payPeriodEnd: String(last.data()['payPeriodEnd']), batchId: last.id };
  }
  // Outstanding = the backfilled records (status expected) + legacy_1 and legacy_2 (partial); native_1 is received.
  const wantOutstanding = BULK_BATCHES + 1 + 2;
  check(seen.length === wantOutstanding && new Set(seen).size === wantOutstanding, `outstanding query paged ${seen.length} records in ${pages} pages, no repeats (expected ${wantOutstanding})`);
  check(canon(seen) === canon([...seen].sort()), 'in order: oldest pay period first, then batch id');
  check(seen[0] === `${bulkPeriodEnd(0)}|${bulkId(0)}`, `first row is the oldest batch (${seen[0]})`);
  const overdue = await remittancesQuery(db, { outstandingOnly: true, periodEndBefore: bulkPeriodEnd(10) }).get();
  check(overdue.size === 10, `periodEndBefore keeps only earlier periods (${overdue.size}, expected 10)`);
  const emp2 = await remittancesQuery(db, { outstandingOnly: true, employerId: 'emp2' }).get();
  check(canon(emp2.docs.map((d) => d.id)) === canon(['legacy_1', 'legacy_2']), 'employer filter with the outstanding filter');
  const all = await remittancesQuery(db, { outstandingOnly: false }).limit(3).get();
  check(
    canon(all.docs.map((d) => d.id)) === canon(['native_1', 'emp1_2026-05-01_2026-05-15', 'legacy_2']),
    `view "all" is newest pay period first (${all.docs.map((d) => d.id).join(', ')})`,
  );

  console.log(`\n${failures === 0 ? 'REHEARSAL PASSED' : `REHEARSAL FAILED (${failures})`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('Rehearsal failed:', err);
  process.exit(1);
});
