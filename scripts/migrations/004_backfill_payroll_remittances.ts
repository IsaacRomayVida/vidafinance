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
 * *** NOT YET RUN AGAINST ANY REAL PROJECT. *** Tested against an in-memory
 * Firestore double only. See docs/runbooks/payroll-remittances.md.
 *
 * SAFETY PROPERTIES
 * -----------------
 *   - Dry run by default. Nothing is written unless `--apply` is passed.
 *   - Refuses any target that is not the Firestore emulator unless
 *     `--allow-production` is passed. The flag is deliberately separate from
 *     `--apply`: a dry run against production still needs it, so pointing this
 *     at live data is never an accident of which credentials happen to be set.
 *   - Create-only in effect. A batch that already has a record is skipped
 *     without a write; receipts ops booked are never touched.
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
  batchDeductionsQuery,
  batchFromBatchDoc,
  expectedFromDeductionRows,
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

export interface BackfillReport {
  apply: boolean;
  rows: BackfillRow[];
  counts: Record<Outcome, number>;
  /** Sum of `expectedCents` over the `create` rows. */
  createdExpectedCents: number;
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
  log(options.apply ? 'Done.' : `DRY RUN — nothing was written. Re-run with ${APPLY_FLAG} to write.`);

  return { apply: options.apply, rows, counts, createdExpectedCents };
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
