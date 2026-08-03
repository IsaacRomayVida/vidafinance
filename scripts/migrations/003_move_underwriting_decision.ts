/**
 * Migration 003: Move `loans/{loanId}.underwritingDecision` into the ops-only
 * subcollection `loans/{loanId}/underwritingDetail/detail`, then delete the
 * field from the loan document.
 *
 * WHY THIS EXISTS
 * ---------------
 * `requestLoan` used to write the Stage 3 auto-approve condition breakdown onto
 * the loan document itself. Every condition in it carries the applicant's ACTUAL
 * bureau score, LTI, RiskSeal fraud score and ML default probability, alongside
 * the exact bound each one was tested against.
 *
 * `firestore.rules` grants read on `loans/{loanId}` to the loan's own borrower
 * (`isOwner(resource.data.employeeId)`) and to their employer's admin
 * (`isEmployerAdminOf(resource.data.employerId)`). Firestore reads are
 * whole-document — there is no field-level projection — so any borrower reading
 * their own loan gets back their own regulated bureau data, the internal
 * fraud/model scores, and the precise threshold every gate sits at. The employer
 * admin gets the same for every one of their employees.
 *
 * PR #509 (`7ddb807`) moved the write to `loans/{loanId}/underwritingDetail/detail`,
 * which `firestore.rules` gates `allow read: if isOps(); allow write: if false;`.
 * That stopped NEW leakage only. Every loan created before #509 still carries the
 * field on its document and is still readable by that borrower and their employer
 * admin. THAT is the exposure this script closes.
 *
 * *** NOT YET RUN AGAINST ANY ENVIRONMENT. ***
 * This script DELETES data from the `loans` collection. Take a Firestore export
 * first, run `--dry-run` against the target project, read the itemised plan, and
 * only then run it for real.
 *
 * SAFETY PROPERTIES
 * -----------------
 *   - Copy is durably committed BEFORE the delete. Copies and deletes go in two
 *     separate batches, copies first: if the copy commit throws, the delete
 *     commit is never issued, so the field survives and a re-run retries it. The
 *     reverse failure (delete lands, copy lost) is impossible by construction.
 *   - Idempotent. A loan whose field is already gone is skipped, not errored, so
 *     re-running after a partial failure is the intended recovery path.
 *   - Never clobbers an existing destination doc. See PRECEDENCE below.
 *   - A malformed inline value is reported and left alone; it never aborts the
 *     run and it is never deleted.
 *   - Paginated by document id. The `loans` collection is never held in memory
 *     in full.
 *   - `--dry-run` reports exactly what it would copy and delete and touches
 *     nothing.
 *
 * PRECEDENCE: AN EXISTING DESTINATION DOC ALWAYS WINS
 * ---------------------------------------------------
 * If `loans/{loanId}/underwritingDetail/detail` already exists and is usable, we
 * do NOT overwrite it — we only delete the inline field.
 *
 * The reasoning: after #509 nothing writes the inline field at all, so an
 * existing `detail` doc can only have come from one of two places, and the
 * existing doc is at least as good as the inline value in both.
 *
 *   1. #509's live `requestLoan` transaction. Then `detail` is the authoritative
 *      record and the inline field on that same loan can only be an older
 *      remnant. Overwriting the live write path's output with a stale inline
 *      value would corrupt ops' record of why the loan was decided.
 *   2. A previous partial run of THIS migration (copy committed, delete failed).
 *      Then `detail` is already a copy of the very field we are about to delete,
 *      so re-copying is at best a no-op.
 *
 * There is no third case in which the inline value is strictly newer than an
 * existing `detail` doc. "Existing wins" is therefore both the safe rule and the
 * one that makes the migration idempotent by construction.
 *
 * The one exception is a destination that exists but is NOT usable (see
 * `isUsableDetail`) while the inline value is. That is a genuine conflict rather
 * than a resumable state, so the loan is reported and left completely untouched
 * — we neither clobber the destination nor destroy the richer source. A human
 * decides.
 *
 * Usage:
 *   npx ts-node scripts/migrations/003_move_underwriting_decision.ts --dry-run
 *   npx ts-node scripts/migrations/003_move_underwriting_decision.ts
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS or Firebase default credentials.
 */

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import {
  getFirestore,
  FieldPath,
  FieldValue,
  type DocumentSnapshot,
  type Firestore,
} from 'firebase-admin/firestore';

const DRY_RUN = process.argv.includes('--dry-run');

const LOANS_COLLECTION = 'loans';
/** The leaking field on the loan document. Removed by this migration. */
const LEGACY_FIELD = 'underwritingDecision';
/** Keep in sync with functions/src/index.ts and functions/src/admin/getReviewQueue.ts */
const DETAIL_SUBCOLLECTION = 'underwritingDetail';
const DETAIL_DOC_ID = 'detail';

/** Marks a doc this migration wrote, so a re-run can recognise its own output. */
const MIGRATION_TAG = '003_move_underwriting_decision';

/** Firestore caps a batched write at 500 operations. */
const BATCH_SIZE = 400;

/**
 * One page of `loans` per round trip. Held at BATCH_SIZE so a page can never
 * produce more copies (or more deletes) than fit in a single batch — that is
 * what lets each phase below commit as exactly one batch with no chunking.
 */
const PAGE_SIZE = BATCH_SIZE;

/** Fields of the #509 detail shape; anything else is preserved under legacyFields. */
const KNOWN_FIELDS = new Set(['decision', 'reason', 'allPass', 'conditions', 'evaluatedAt']);

export type Action =
  /** Field already gone — migrated previously, or never had one. Nothing to do. */
  | 'absent'
  /** Field present but not a plain object. Reported; never copied, never deleted. */
  | 'malformed'
  /** Destination already holds a usable record. Delete the inline field only. */
  | 'delete-only'
  /** Destination missing. Copy the inline value across, then delete it. */
  | 'copy-and-delete'
  /** Destination exists but is unusable while the source is usable. Hands off. */
  | 'conflict';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A detail record is "usable" when it actually carries the condition breakdown.
 *
 * #509 only ever writes the subcollection doc when `conditions` is a non-empty
 * array, so anything that reaches Firestore through the supported path satisfies
 * this. A destination that does not is something we did not write and do not
 * understand, which is why it is treated as a conflict rather than as a
 * resumable partial state.
 */
export function isUsableDetail(v: unknown): boolean {
  return isPlainObject(v) && Array.isArray(v['conditions']) && v['conditions'].length > 0;
}

/**
 * Decide what to do with one loan. Pure — takes the inline field value and the
 * destination's current contents, returns the action. All the ordering and
 * precedence rules documented at the top of this file live here.
 *
 * @param inline        `loans/{loanId}.underwritingDecision`, or undefined if absent.
 * @param detailExists  whether `.../underwritingDetail/detail` currently exists.
 * @param detailData    that doc's data when it exists, otherwise undefined.
 */
export function classify(
  inline: unknown,
  detailExists: boolean,
  detailData?: unknown
): Action {
  // Checked FIRST, before anything about the destination. This is what makes a
  // re-run safe: once the field is gone the loan is done, whatever state the
  // destination happens to be in.
  if (inline === undefined) return 'absent';

  // `null`, arrays, strings and numbers all land here. Copying one would put a
  // shape into `underwritingDetail` that `summarizeUnderwriting` does not
  // expect, and deleting one would destroy the only evidence of whatever went
  // wrong. Report and leave it exactly as found.
  if (!isPlainObject(inline)) return 'malformed';

  if (!detailExists) return 'copy-and-delete';
  if (isUsableDetail(detailData)) return 'delete-only';

  // Destination exists but carries no conditions. Deleting the source here would
  // trade a real breakdown for an empty one; overwriting the destination would
  // clobber something we did not write. Neither is ours to choose.
  return 'conflict';
}

/**
 * Coerce an inline `underwritingDecision` into the #509 detail shape.
 *
 * Defensive per-field rather than a straight spread: these values were written
 * over a long period by several versions of `requestLoan`, so no field is
 * assumed present. Unrecognised keys are preserved verbatim under `legacyFields`
 * — this migration DELETES its source, so silently dropping a key here would be
 * unrecoverable data loss, not just a cosmetic omission.
 *
 * @param migratedAt supplied by the caller (a `FieldValue.serverTimestamp()`
 *   sentinel in production) so this function stays pure and testable.
 */
export function normaliseDetail(
  loanId: string,
  raw: Record<string, unknown>,
  migratedAt: unknown
): Record<string, unknown> {
  const legacyFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_FIELDS.has(key)) legacyFields[key] = value;
  }

  const decision = typeof raw['decision'] === 'string' ? raw['decision'] : null;
  const reason = typeof raw['reason'] === 'string' ? raw['reason'] : null;
  const allPass = typeof raw['allPass'] === 'boolean' ? raw['allPass'] : null;
  const conditions = Array.isArray(raw['conditions']) ? raw['conditions'] : [];

  // A KNOWN field that was present but failed its type check has just been
  // coerced to null/[]. Unrecognised keys are preserved by the loop above, but
  // these would fall through it — and since this migration deletes its source,
  // that coercion would be unrecoverable data loss rather than a tidy-up. Keep
  // the original alongside the coerced value.
  const coerced: Array<[string, unknown, unknown]> = [
    ['decision', raw['decision'], decision],
    ['reason', raw['reason'], reason],
    ['allPass', raw['allPass'], allPass],
    ['conditions', raw['conditions'], conditions],
  ];
  for (const [key, original, kept] of coerced) {
    if (original !== undefined && original !== kept) legacyFields[key] = original;
  }

  return {
    decision,
    reason,
    allPass,
    conditions,
    // Preserve the ORIGINAL evaluation time. Stamping a fresh timestamp here
    // would relabel a two-year-old decision as having been evaluated during the
    // migration, which would make the ops record actively misleading. Absent
    // means absent — null, not "now".
    evaluatedAt: raw['evaluatedAt'] ?? null,
    ...(Object.keys(legacyFields).length > 0 ? { legacyFields } : {}),
    migratedFrom: `${LOANS_COLLECTION}/${loanId}.${LEGACY_FIELD}`,
    migratedAt,
    _migrationTag: MIGRATION_TAG,
  };
}

export interface Candidate {
  loanId: string;
  inline: Record<string, unknown>;
}

export interface Tally {
  scanned: number;
  copied: number;
  deleted: number;
  alreadyMigrated: number;
}

export interface Skip {
  loanId: string;
  reason: string;
}

function detailRef(db: Firestore, loanId: string) {
  return db
    .collection(LOANS_COLLECTION)
    .doc(loanId)
    .collection(DETAIL_SUBCOLLECTION)
    .doc(DETAIL_DOC_ID);
}

/**
 * Process one page of loans: classify, copy, then delete.
 *
 * The two commits are deliberately NOT one batch. Copies commit first and the
 * delete batch is only built afterwards, so a failed copy throws out of here
 * with every inline field still intact.
 */
export async function processPage(
  db: Firestore,
  candidates: Candidate[],
  tally: Tally,
  skipped: Skip[]
): Promise<void> {
  if (candidates.length === 0) return;

  // One round trip for every destination on this page, rather than a get() per
  // loan. Same `getAll` pattern getReviewQueue uses for this subcollection.
  const detailSnaps: DocumentSnapshot[] = await db.getAll(
    ...candidates.map((c) => detailRef(db, c.loanId))
  );

  const toCopy: Candidate[] = [];
  const toDelete: string[] = [];

  candidates.forEach((candidate, i) => {
    const snap = detailSnaps[i];
    const action = classify(candidate.inline, snap.exists, snap.data());

    switch (action) {
      case 'copy-and-delete':
        toCopy.push(candidate);
        toDelete.push(candidate.loanId);
        break;
      case 'delete-only':
        tally.alreadyMigrated++;
        toDelete.push(candidate.loanId);
        break;
      case 'malformed':
        skipped.push({
          loanId: candidate.loanId,
          reason: `${LEGACY_FIELD} is present but not an object (${
            candidate.inline === null ? 'null' : typeof candidate.inline
          }) — left in place`,
        });
        break;
      case 'conflict':
        skipped.push({
          loanId: candidate.loanId,
          reason:
            `${DETAIL_SUBCOLLECTION}/${DETAIL_DOC_ID} exists but carries no conditions, ` +
            `while the inline value does — left in place, needs a human`,
        });
        break;
      case 'absent':
        // Unreachable: candidates are built only from loans carrying the field.
        break;
    }
  });

  if (DRY_RUN) {
    for (const c of toCopy) {
      const n = Array.isArray(c.inline['conditions']) ? c.inline['conditions'].length : 0;
      console.log(
        `  → would copy ${LOANS_COLLECTION}/${c.loanId}.${LEGACY_FIELD} ` +
          `(${n} condition(s)) to ${DETAIL_SUBCOLLECTION}/${DETAIL_DOC_ID}, then delete the field`
      );
    }
    for (const loanId of toDelete) {
      if (toCopy.some((c) => c.loanId === loanId)) continue;
      console.log(
        `  → would delete ${LOANS_COLLECTION}/${loanId}.${LEGACY_FIELD} only ` +
          `(destination already holds a usable record)`
      );
    }
    tally.copied += toCopy.length;
    tally.deleted += toDelete.length;
    return;
  }

  // ── Phase 1: copies. Must be durable before any delete is issued. ──────────
  if (toCopy.length > 0) {
    const copyBatch = db.batch();
    for (const c of toCopy) {
      copyBatch.set(
        detailRef(db, c.loanId),
        normaliseDetail(c.loanId, c.inline, FieldValue.serverTimestamp())
      );
    }
    await copyBatch.commit();
    tally.copied += toCopy.length;
    console.log(`  ✓ copied ${toCopy.length} breakdown(s) into ${DETAIL_SUBCOLLECTION}`);
  }

  // ── Phase 2: deletes. Only reached because phase 1 committed. ──────────────
  //
  // `update()` rather than `set(..., {merge: true})` on purpose: if a loan were
  // deleted between the scan and here, merge-set would RESURRECT it as a husk
  // document. update() fails instead, which is the correct outcome.
  //
  // But a batch is atomic, so one vanished loan would take its whole page down
  // with it — and a re-run would hit the same document and wedge in the same
  // place. So a failed batch degrades to per-document deletes: the other 399
  // loans still stop leaking, and only the genuinely broken one is reported.
  if (toDelete.length > 0) {
    const deleteField = { [LEGACY_FIELD]: FieldValue.delete() };
    const loanRef = (loanId: string) => db.collection(LOANS_COLLECTION).doc(loanId);

    try {
      const deleteBatch = db.batch();
      for (const loanId of toDelete) deleteBatch.update(loanRef(loanId), deleteField);
      await deleteBatch.commit();
      tally.deleted += toDelete.length;
      console.log(`  ✓ removed ${LEGACY_FIELD} from ${toDelete.length} loan document(s)`);
    } catch (batchErr) {
      console.log(
        `  ! batched delete failed (${(batchErr as Error).message}) — retrying one at a time`
      );
      for (const loanId of toDelete) {
        try {
          await loanRef(loanId).update(deleteField);
          tally.deleted++;
        } catch (docErr) {
          skipped.push({
            loanId,
            reason:
              `copied to ${DETAIL_SUBCOLLECTION}/${DETAIL_DOC_ID}, but deleting ${LEGACY_FIELD} ` +
              `from the loan doc failed: ${(docErr as Error).message}`,
          });
        }
      }
      console.log(`  ✓ removed ${LEGACY_FIELD} from ${tally.deleted} loan document(s) so far`);
    }
  }
}

async function main() {
  initializeApp({ credential: applicationDefault() });
  const db: Firestore = getFirestore();

  console.log(
    `Migration 003: move ${LOANS_COLLECTION}/{loanId}.${LEGACY_FIELD} → ` +
      `${DETAIL_SUBCOLLECTION}/${DETAIL_DOC_ID}${DRY_RUN ? ' (DRY RUN)' : ''}`
  );
  console.log('─'.repeat(60));

  const tally: Tally = { scanned: 0, copied: 0, deleted: 0, alreadyMigrated: 0 };
  const skipped: Skip[] = [];

  // Paginated by document id, and filtered in code rather than by the query.
  //
  // The obvious `orderBy(LEGACY_FIELD)` — which would return only documents that
  // carry the field — is NOT safe here: Firestore's automatic single-field
  // indexes cover a map's leaf subfields, not the map value itself, so ordering
  // by a map-typed field is not something this collection is guaranteed to be
  // able to serve. A query that silently returns nothing would report "0 loans
  // to migrate" on a collection that is still leaking. Scanning by `__name__`
  // always works and cannot under-report. `select()` keeps the payload to the
  // one field we care about.
  let cursor: DocumentSnapshot | null = null;
  for (;;) {
    let query = db
      .collection(LOANS_COLLECTION)
      .select(LEGACY_FIELD)
      .orderBy(FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);

    const page = await query.get();
    if (page.empty) break;

    tally.scanned += page.size;

    const candidates: Candidate[] = [];
    for (const doc of page.docs) {
      const inline = doc.get(LEGACY_FIELD);
      if (classify(inline, false) === 'absent') continue;
      // `inline` may still be malformed; processPage classifies it properly
      // against the real destination. The cast only carries it that far.
      candidates.push({ loanId: doc.id, inline: inline as Record<string, unknown> });
    }

    if (candidates.length > 0) {
      console.log(`\nPage of ${page.size} loan(s): ${candidates.length} carry ${LEGACY_FIELD}.`);
      await processPage(db, candidates, tally, skipped);
    }

    if (page.size < PAGE_SIZE) break;
    cursor = page.docs[page.docs.length - 1];
  }

  // A dry run must never print a line that reads as work already done — that is
  // the one place a summary can do real damage, by inviting "it's migrated".
  const did = DRY_RUN ? 'would be' : 'was';
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Scanned:                 ${tally.scanned} loan document(s)`);
  console.log(`Copied to detail:        ${tally.copied} (${did} written)`);
  console.log(`Already had detail:      ${tally.alreadyMigrated} (destination left as-is)`);
  console.log(`Field removed from:      ${tally.deleted} loan document(s) (${did} removed)`);

  if (skipped.length > 0) {
    // Loud, itemised, and non-zero exit. A silent partial run would read as
    // "the historical leak is closed" when some loans are still exposed.
    console.log(
      `\n⚠  ${skipped.length} loan(s) still carry ${LEGACY_FIELD} and are STILL READABLE by ` +
        `their borrower and employer admin:`
    );
    for (const s of skipped) console.log(`     ${s.loanId} — ${s.reason}`);
    console.log('\n   Resolve these by hand; the exposure is not fully closed until they are.');
  }

  console.log(
    DRY_RUN
      ? '\nDRY RUN complete — nothing was written or deleted.'
      : `\nDone.${skipped.length === 0 ? ' No loan document carries the field any more.' : ''}`
  );

  if (skipped.length > 0) process.exitCode = 1;
}

// Guarded so the pure helpers above can be imported by the unit tests without
// the module connecting to Firestore on import.
if (require.main === module) {
  main().catch((err) => {
    console.error('Migration 003 failed:', err);
    process.exit(1);
  });
}
