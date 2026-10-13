/**
 * Migration 004: backfill `payrollRemittances` for batches processed before the
 * remittance ledger (E18) shipped.
 *
 * WHY THIS EXISTS
 * ---------------
 * `processPayroll` writes `payrollRemittances/{batchId}` when a batch completes,
 * but only since E18. Every batch completed before that has `payrollDeductions`
 * rows and no remittance record, so the ops remittance list — which reads only
 * `payrollRemittances` — cannot show that the employer still owes for it.
 * (`recordPayrollRemittance` creates the record on demand when ops books a
 * receipt, but a batch nobody books against stays invisible. That is exactly the
 * batch an aging view exists to surface.)
 *
 * It also rebuilds the bank-reference index (`payrollRemittanceReferences`)
 * for receipts booked before that index existed. `recordPayrollRemittance`
 * refuses a transfer already booked against ANOTHER batch by looking the
 * reference up in the index; a receipt with no index entry is invisible to
 * that check, so the same SPEI transfer could be counted twice. Pass 2 below
 * gives every live (non-voided) receipt its entry.
 *
 * *** NOT YET RUN AGAINST ANY REAL PROJECT. *** Tested against an in-memory
 * Firestore double (`npm run test:migrations`) and rehearsed end to end on the
 * Firestore emulator (`004_emulator_rehearsal.ts`). See
 * docs/runbooks/payroll-remittances.md.
 *
 * SAFETY PROPERTIES
 * -----------------
 *   - Dry run by default. Nothing is written unless `--apply` is passed.
 *   - Refuses any target that is not the Firestore emulator unless
 *     `--allow-production` is passed. The flag is deliberately separate from
 *     `--apply`: a dry run against production still needs it, so pointing this
 *     at live data is never an accident of which credentials happen to be set.
 *   - Create-only in effect. A batch that already has a record is skipped
 *     without a write; receipts ops booked are never touched — pass 2 writes
 *     only to the index collection, never to a remittance record.
 *   - The index pass only ADDS holders. It never removes one and never
 *     decides that two batches holding the same reference is an error: it
 *     indexes both (that is what the ledger says) and lists them for a human.
 *     A voided receipt holds nothing and is skipped.
 *   - Idempotent. A second run finds the records the first one wrote and skips
 *     them. Re-running after a partial failure is the intended recovery path.
 *   - The expected amount comes from `functions/src/payroll/remittanceLedger.ts`
 *     — the same code `processPayroll` and the callable use — so a backfilled
 *     record cannot disagree with a native one by a centavo.
 *   - Only `completed` batches. An `in_progress` batch gets its record from
 *     `processPayroll` when its retry completes.
 *   - A batch that deducted nothing gets no record, as in `processPayroll`.
 *
 * Usage (ts-node is not a repo dependency; compile with the pinned tsc first —
 * the runbook has the exact commands):
 *   node <build>/scripts/migrations/004_backfill_payroll_remittances.js                      # emulator, dry run
 *   node <build>/scripts/migrations/004_backfill_payroll_remittances.js --apply              # emulator, writes
 *   node <build>/scripts/migrations/004_backfill_payroll_remittances.js --allow-production   # live, dry run
 */

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldPath, FieldValue, type Firestore } from 'firebase-admin/firestore';

import {
  PAYROLL_BATCHES_COLLECTION,
  PAYROLL_REMITTANCES_COLLECTION,
  PAYROLL_REMITTANCE_REFERENCES_COLLECTION,
  bankReferenceDocId,
  batchDeductionsQuery,
  batchFromBatchDoc,
  expectedFromDeductionRows,
  isVoided,
  receiptIdOf,
  receiptReferenceKey,
  receiptsOf,
  upsertExpectedRemittance,
} from '../../functions/src/payroll/remittanceLedger';

export const APPLY_FLAG = '--apply';
export const ALLOW_PRODUCTION_FLAG = '--allow-production';

/** Stamped on every record this script creates, so they can be told from native ones. */
export const MIGRATION_TAG = '004_backfill_payroll_remittances';

const PAGE_SIZE = 200;

export type Outcome =
  /** Record written (or, in a dry run, would be). */
  | 'create'
  /** The batch already has a record. Untouched. */
  | 'exists'
  /** The batch is not `completed`; processPayroll will write its record. */
  | 'not-completed'
  /** Completed, but no deduction rows: nothing to remit, no record. */
  | 'nothing-deducted'
  /** The batch document lacks employerId / pay period. Reported, never guessed. */
  | 'malformed';

export interface BackfillRow {
  batchId: string;
  outcome: Outcome;
  expectedCents?: number;
}

export type ReferenceOutcome =
  /** Index entry written (or, in a dry run, would be). */
  | 'create'
  /** The index already names this receipt as a holder. Untouched. */
  | 'exists'
  /** The receipt has no bank reference to index. Reported, never guessed. */
  | 'no-reference';

export interface ReferenceRow {
  batchId: string;
  receiptId: string;
  bankReferenceKey: string;
  outcome: ReferenceOutcome;
}

export interface ReferenceIndexReport {
  /** One row per live (non-voided) receipt found. */
  rows: ReferenceRow[];
  counts: Record<ReferenceOutcome, number>;
  /**
   * References held by more than one batch once the index is complete. Either
   * one transfer that really paid several batches, or the same transfer booked
   * twice. The script cannot tell which; someone with the bank statement can.
   */
  sharedReferences: Array<{ bankReferenceKey: string; batchIds: string[] }>;
}

export interface BackfillReport {
  apply: boolean;
  rows: BackfillRow[];
  counts: Record<Outcome, number>;
  /** Sum of `expectedCents` over the `create` rows. */
  createdExpectedCents: number;
  referenceIndex: ReferenceIndexReport;
}

/**
 * Which Firestore the process would talk to, and whether that is allowed.
 * Throws rather than returning false so no caller can forget to check.
 *
 * "Not the emulator" is treated as production. The Admin SDK routes to the
 * emulator if and only if FIRESTORE_EMULATOR_HOST is set, so that variable —
 * not a project-id allowlist that would go stale — is the test.
 */
export function assertTargetAllowed(env: Record<string, string | undefined>, argv: string[]): 'emulator' | 'live' {
  if (env['FIRESTORE_EMULATOR_HOST']) return 'emulator';
  if (!argv.includes(ALLOW_PRODUCTION_FLAG)) {
    throw new Error(
      `Refusing to run: FIRESTORE_EMULATOR_HOST is not set, so this would read a LIVE Firestore. ` +
        `Pass ${ALLOW_PRODUCTION_FLAG} to do that on purpose (it is required even for a dry run).`,
    );
  }
  return 'live';
}

export async function run(
  db: Firestore,
  options: { apply: boolean; log?: (line: string) => void },
): Promise<BackfillReport> {
  const log = options.log ?? console.log;
  const rows: BackfillRow[] = [];

  let cursor: string | null = null;
  for (;;) {
    let query = db.collection(PAYROLL_BATCHES_COLLECTION).orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor !== null) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;

    for (const doc of page.docs) {
      rows.push(await backfillBatch(db, doc.id, doc.data(), options.apply));
    }
    cursor = page.docs[page.docs.length - 1]!.id;
    if (page.size < PAGE_SIZE) break;
  }

  const counts: Record<Outcome, number> = {
    create: 0,
    exists: 0,
    'not-completed': 0,
    'nothing-deducted': 0,
    malformed: 0,
  };
  let createdExpectedCents = 0;
  for (const row of rows) {
    counts[row.outcome]++;
    if (row.outcome === 'create') createdExpectedCents += row.expectedCents ?? 0;
  }

  for (const row of rows) {
    if (row.outcome === 'create') {
      log(`  ${options.apply ? 'created' : 'would create'}  ${row.batchId}  expectedCents=${row.expectedCents}`);
    } else if (row.outcome === 'malformed') {
      log(`  MALFORMED      ${row.batchId}  (no employerId / pay period on the batch document)`);
    }
  }
  log(
    `${rows.length} batch(es): ${counts.create} ${options.apply ? 'created' : 'to create'} ` +
      `(${createdExpectedCents} centavos expected), ${counts.exists} already had a record, ` +
      `${counts['not-completed']} not completed, ${counts['nothing-deducted']} deducted nothing, ` +
      `${counts.malformed} malformed.`,
  );

  // Pass 2 runs after pass 1 so it sees the records pass 1 just created (they
  // have no receipts, so today it finds nothing on them — but the order means
  // it never has to be reasoned about).
  const referenceIndex = await backfillReferenceIndex(db, options.apply, log);

  log(options.apply ? 'Done.' : `DRY RUN — nothing was written. Re-run with ${APPLY_FLAG} to write.`);

  return { apply: options.apply, rows, counts, createdExpectedCents, referenceIndex };
}

type Holder = { batchId: string; receiptId: string; employerId: string | null };

function holdersOf(indexDoc: Record<string, unknown> | undefined): Holder[] {
  const holders = indexDoc?.['holders'];
  return Array.isArray(holders) ? (holders as Holder[]) : [];
}

const holds = (holders: Holder[], batchId: string, receiptId: string) =>
  holders.some((h) => h.batchId === batchId && h.receiptId === receiptId);

/**
 * Pass 2: give every live receipt its `payrollRemittanceReferences` entry.
 *
 * The holder written is exactly what `recordPayrollRemittance` writes —
 * `{ batchId, receiptId, employerId }` under `sha256(bankReferenceKey)` — with
 * the receipt's id and key computed the way the callables compute them for
 * receipts that predate stored ids and keys (`legacy-<index>`, normalised
 * reference). `voidPayrollRemittanceReceipt` therefore finds and releases a
 * backfilled entry like any other.
 */
async function backfillReferenceIndex(
  db: Firestore,
  apply: boolean,
  log: (line: string) => void,
): Promise<ReferenceIndexReport> {
  const rows: ReferenceRow[] = [];
  /** Every batch known to hold each reference: already indexed, or indexed by this run. */
  const batchesByKey = new Map<string, Set<string>>();
  const note = (key: string, batchIds: string[]) => {
    const set = batchesByKey.get(key) ?? new Set<string>();
    batchIds.forEach((id) => set.add(id));
    batchesByKey.set(key, set);
  };

  let cursor: string | null = null;
  for (;;) {
    let query = db.collection(PAYROLL_REMITTANCES_COLLECTION).orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor !== null) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;

    for (const doc of page.docs) {
      const batchId = doc.id;
      const receipts = receiptsOf(doc.data());
      for (let index = 0; index < receipts.length; index++) {
        const receipt = receipts[index]!;
        if (isVoided(receipt)) continue;
        const receiptId = receiptIdOf(receipt, index);
        const bankReferenceKey = receiptReferenceKey(receipt);
        if (!bankReferenceKey) {
          rows.push({ batchId, receiptId, bankReferenceKey, outcome: 'no-reference' });
          continue;
        }

        const referenceRef = db
          .collection(PAYROLL_REMITTANCE_REFERENCES_COLLECTION)
          .doc(bankReferenceDocId(bankReferenceKey));

        if (!apply) {
          const holders = holdersOf((await referenceRef.get()).data());
          note(bankReferenceKey, [...holders.map((h) => h.batchId), batchId]);
          rows.push({
            batchId,
            receiptId,
            bankReferenceKey,
            outcome: holds(holders, batchId, receiptId) ? 'exists' : 'create',
          });
          continue;
        }

        const remittanceRef = db.collection(PAYROLL_REMITTANCES_COLLECTION).doc(batchId);
        const written = await db.runTransaction(async (tx) => {
          // The record is re-read in the transaction: if ops voided this
          // receipt since the page was read, it must not be given an entry.
          const recordSnap = await tx.get(remittanceRef);
          const referenceSnap = await tx.get(referenceRef);
          const record = recordSnap.exists ? recordSnap.data() ?? {} : {};
          const current = receiptsOf(record)[index];
          if (
            !current ||
            isVoided(current) ||
            receiptIdOf(current, index) !== receiptId ||
            receiptReferenceKey(current) !== bankReferenceKey
          ) {
            return null;
          }
          const holders = holdersOf(referenceSnap.exists ? referenceSnap.data() : undefined);
          if (holds(holders, batchId, receiptId)) return { created: false, holders };

          const employerId = record['employerId'];
          const next: Holder[] = [
            ...holders,
            { batchId, receiptId, employerId: typeof employerId === 'string' ? employerId : null },
          ];
          tx.set(referenceRef, {
            bankReferenceKey,
            holders: next,
            updatedAt: FieldValue.serverTimestamp(),
            backfilledBy: MIGRATION_TAG,
          });
          return { created: true, holders: next };
        });
        if (!written) continue;
        note(bankReferenceKey, written.holders.map((h) => h.batchId));
        rows.push({ batchId, receiptId, bankReferenceKey, outcome: written.created ? 'create' : 'exists' });
      }
    }
    cursor = page.docs[page.docs.length - 1]!.id;
    if (page.size < PAGE_SIZE) break;
  }

  const counts: Record<ReferenceOutcome, number> = { create: 0, exists: 0, 'no-reference': 0 };
  for (const row of rows) counts[row.outcome]++;
  const sharedReferences = [...batchesByKey.entries()]
    .filter(([, batchIds]) => batchIds.size > 1)
    .map(([bankReferenceKey, batchIds]) => ({ bankReferenceKey, batchIds: [...batchIds].sort() }))
    .sort((a, b) => (a.bankReferenceKey < b.bankReferenceKey ? -1 : a.bankReferenceKey > b.bankReferenceKey ? 1 : 0));

  for (const row of rows) {
    if (row.outcome === 'create') {
      log(`  ${apply ? 'indexed' : 'would index'}  ${row.bankReferenceKey}  ->  ${row.batchId} / ${row.receiptId}`);
    } else if (row.outcome === 'no-reference') {
      log(`  NO REFERENCE   ${row.batchId} / ${row.receiptId}  (receipt has no bank reference; not indexed)`);
    }
  }
  for (const shared of sharedReferences) {
    log(`  REVIEW         ${shared.bankReferenceKey} is held by ${shared.batchIds.length} batches: ${shared.batchIds.join(', ')}`);
  }
  log(
    `Reference index: ${rows.length} live receipt(s): ${counts.create} ${apply ? 'indexed' : 'to index'}, ` +
      `${counts.exists} already indexed, ${counts['no-reference']} without a reference; ` +
      `${sharedReferences.length} reference(s) held by more than one batch.`,
  );

  return { rows, counts, sharedReferences };
}

async function backfillBatch(
  db: Firestore,
  batchId: string,
  data: Record<string, unknown>,
  apply: boolean,
): Promise<BackfillRow> {
  if (data['status'] !== 'completed') return { batchId, outcome: 'not-completed' };

  const batch = batchFromBatchDoc(batchId, data);
  if (!batch) return { batchId, outcome: 'malformed' };

  const existing = await db.collection(PAYROLL_REMITTANCES_COLLECTION).doc(batchId).get();
  if (existing.exists) return { batchId, outcome: 'exists' };

  if (!apply) {
    const deductions = await batchDeductionsQuery(db, batchId).get();
    const { expectedCents } = expectedFromDeductionRows(deductions.docs.map((d) => d.data()));
    return expectedCents > 0
      ? { batchId, outcome: 'create', expectedCents }
      : { batchId, outcome: 'nothing-deducted' };
  }

  const written = await upsertExpectedRemittance(db, batch, () => FieldValue.serverTimestamp(), {
    backfilledBy: MIGRATION_TAG,
  });
  if (!written) return { batchId, outcome: 'nothing-deducted' };
  // A record that appeared between the check above and the transaction was
  // refreshed, not created — the same refresh processPayroll performs.
  return written.created
    ? { batchId, outcome: 'create', expectedCents: written.expectedCents }
    : { batchId, outcome: 'exists' };
}

async function main() {
  const target = assertTargetAllowed(process.env, process.argv);
  const apply = process.argv.includes(APPLY_FLAG);

  initializeApp(target === 'emulator' ? {} : { credential: applicationDefault() });
  console.log(
    `Target: project=${process.env['GCLOUD_PROJECT'] ?? process.env['GOOGLE_CLOUD_PROJECT'] ?? '(from credentials)'}` +
      (target === 'emulator'
        ? `  EMULATOR=${process.env['FIRESTORE_EMULATOR_HOST']}`
        : '  (LIVE Firestore — not an emulator)') +
      `  mode=${apply ? 'APPLY' : 'dry run'}`,
  );
  const report = await run(getFirestore(), { apply });
  if (report.counts.malformed > 0) process.exitCode = 1;
}

// Guarded so the unit tests can import `run` without connecting to Firestore.
if (require.main === module) {
  main().catch((err) => {
    console.error('Migration 004 failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
