/**
 * Migration 002: Consolidate `auditLogs` (legacy, camelCase) into `audit_log`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The write-side consolidation is already done: every writer in the codebase
 * goes through `functions/src/utils/auditLog.ts` and lands in `audit_log`.
 * `auditLogs` has had no writer since that change.
 *
 * What remains is the *data*. Records written before the consolidation still
 * live in `auditLogs` — and for role grant/revoke history, that is the only
 * copy. `firestore.rules` keeps ops read access on the legacy collection so
 * nothing is stranded, but the ops audit console (`public/js/app.js`) queries
 * only `audit_log`. During an incident, forensics therefore still has two
 * places to look and only one of them is reachable from the UI. This script
 * closes that gap by copying the legacy records forward.
 *
 * *** NOT YET RUN AGAINST ANY ENVIRONMENT. ***
 * See docs/runbooks/audit-log-consolidation.md for the execution procedure and
 * the sign-offs required before running it in production.
 *
 * SAFETY PROPERTIES
 * -----------------
 *   - Copy-only. It never deletes from `auditLogs`; the legacy collection stays
 *     intact and readable so the migration is reversible by simply not using
 *     the copies.
 *   - Idempotent. Each legacy record is written to a deterministic destination
 *     id (`legacy_<sourceId>`), so a re-run overwrites its own prior output
 *     rather than creating duplicates. Re-running after a partial failure is
 *     the intended recovery path.
 *   - Never overwrites a native record. A destination id collision with a
 *     document that is not one of ours aborts the run rather than clobbering
 *     real audit history.
 *   - Normalises to the canonical shape from `functions/src/utils/auditLog.ts`
 *     so the ops console's filters (`action`, `targetId`, `targetCollection`,
 *     `timestamp`) work on migrated rows. Anything unrecognised is preserved
 *     verbatim under `meta.legacyFields` rather than dropped.
 *   - `--dry-run` reports exactly what it would write and touches nothing.
 *
 * Usage:
 *   npx ts-node scripts/migrations/002_consolidate_audit_logs.ts --dry-run
 *   npx ts-node scripts/migrations/002_consolidate_audit_logs.ts
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS or Firebase default credentials.
 */

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';

const DRY_RUN = process.argv.includes('--dry-run');

const LEGACY_COLLECTION = 'auditLogs';
/** Keep in sync with functions/src/utils/auditLog.ts */
const AUDIT_LOG_COLLECTION = 'audit_log';

/** Marks a migrated row so a re-run can tell its own output from a native record. */
const MIGRATION_TAG = '002_consolidate_audit_logs';

/** Firestore caps a batched write at 500 operations. */
const BATCH_SIZE = 400;

/** Fields that map onto the canonical shape; everything else is preserved under meta. */
const KNOWN_FIELDS = new Set([
  'action',
  'actorUid',
  'actorRole',
  'actorEmail',
  'targetCollection',
  'targetId',
  'before',
  'after',
  'meta',
  'timestamp',
]);

function destinationId(sourceId: string): string {
  return `legacy_${sourceId}`;
}

/**
 * Coerce a legacy record into the canonical audit document shape.
 *
 * Legacy rows predate `buildAuditLogDocument` and are not guaranteed to carry
 * every field, so each one is defaulted rather than assumed. `timestamp` is the
 * field the console orders by; a record without a usable one would sort
 * unpredictably, so the caller drops those into the skip list instead.
 */
function normalise(sourceId: string, data: Record<string, unknown>) {
  const action = typeof data['action'] === 'string' ? data['action'] : 'legacy.unknown';

  const legacyFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!KNOWN_FIELDS.has(key)) legacyFields[key] = value;
  }

  const existingMeta =
    data['meta'] && typeof data['meta'] === 'object' && !Array.isArray(data['meta'])
      ? (data['meta'] as Record<string, unknown>)
      : {};

  return {
    action,
    actorUid: typeof data['actorUid'] === 'string' ? data['actorUid'] : 'unknown',
    actorRole: typeof data['actorRole'] === 'string' ? data['actorRole'] : 'unknown',
    actorEmail: typeof data['actorEmail'] === 'string' ? data['actorEmail'] : null,
    // The canonical builder derives this from the action prefix; do the same so
    // migrated rows answer the same queries as native ones.
    targetCollection:
      typeof data['targetCollection'] === 'string'
        ? data['targetCollection']
        : (action.split('.')[0] ?? ''),
    targetId: typeof data['targetId'] === 'string' ? data['targetId'] : '',
    before: (data['before'] as Record<string, unknown> | null) ?? null,
    after: (data['after'] as Record<string, unknown> | null) ?? null,
    meta: {
      ...existingMeta,
      migratedFrom: `${LEGACY_COLLECTION}/${sourceId}`,
      migratedBy: MIGRATION_TAG,
      ...(Object.keys(legacyFields).length > 0 ? { legacyFields } : {}),
    },
    // Preserve the ORIGINAL event time. Stamping serverTimestamp() here would
    // relabel two-year-old grants as having happened during the migration —
    // which would make the audit trail actively misleading.
    timestamp: data['timestamp'],
    _migrationTag: MIGRATION_TAG,
  };
}

async function main() {
  initializeApp({ credential: applicationDefault() });
  const db: Firestore = getFirestore();

  console.log(`Migration 002: consolidate ${LEGACY_COLLECTION} → ${AUDIT_LOG_COLLECTION}${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log('─'.repeat(60));

  const legacySnap = await db.collection(LEGACY_COLLECTION).get();
  if (legacySnap.empty) {
    console.log(`No documents in ${LEGACY_COLLECTION}. Nothing to migrate.`);
    return;
  }
  console.log(`Found ${legacySnap.size} legacy record(s).`);

  const skipped: Array<{ id: string; reason: string }> = [];
  const pending: Array<{ id: string; destId: string; doc: ReturnType<typeof normalise> }> = [];

  for (const legacyDoc of legacySnap.docs) {
    const data = legacyDoc.data();
    const destId = destinationId(legacyDoc.id);

    const ts = data['timestamp'];
    if (!(ts instanceof Timestamp)) {
      // Without a sortable timestamp the row cannot take part in the ordered
      // queries the console runs. Report it rather than silently reshaping it.
      skipped.push({ id: legacyDoc.id, reason: 'missing or non-Timestamp `timestamp` field' });
      continue;
    }

    const existing = await db.collection(AUDIT_LOG_COLLECTION).doc(destId).get();
    if (existing.exists && existing.data()?.['_migrationTag'] !== MIGRATION_TAG) {
      // A native record already owns this id. Refuse rather than overwrite real
      // audit history — this should be impossible, so surface it loudly.
      throw new Error(
        `Refusing to overwrite ${AUDIT_LOG_COLLECTION}/${destId}: it exists and was not written by this migration.`
      );
    }

    pending.push({ id: legacyDoc.id, destId, doc: normalise(legacyDoc.id, data) });
  }

  console.log(`\n${pending.length} record(s) to copy, ${skipped.length} skipped.`);

  if (DRY_RUN) {
    for (const p of pending) {
      console.log(`  → would write ${AUDIT_LOG_COLLECTION}/${p.destId}  (action=${p.doc.action}, targetId=${p.doc.targetId || '—'})`);
    }
  } else {
    let written = 0;
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const chunk = pending.slice(i, i + BATCH_SIZE);
      const batch = db.batch();
      for (const p of chunk) {
        batch.set(db.collection(AUDIT_LOG_COLLECTION).doc(p.destId), p.doc);
      }
      await batch.commit();
      written += chunk.length;
      console.log(`  ✓ committed ${written}/${pending.length}`);
    }
  }

  if (skipped.length > 0) {
    // Loud, itemised, and non-zero-exit: a silent partial migration would read
    // as "history is consolidated" when it is not.
    console.log(`\n⚠  ${skipped.length} record(s) were NOT migrated and remain only in ${LEGACY_COLLECTION}:`);
    for (const s of skipped) console.log(`     ${s.id} — ${s.reason}`);
    console.log('\n   Investigate these by hand before retiring the legacy collection.');
  }

  console.log('\n─'.repeat(60));
  console.log(
    DRY_RUN
      ? 'DRY RUN complete — nothing was written.'
      : `Done. ${pending.length} record(s) copied. ${LEGACY_COLLECTION} was NOT deleted.`
  );
  console.log(
    `Next: verify counts, then see docs/runbooks/audit-log-consolidation.md for the read-path and rule-removal steps.`
  );

  if (skipped.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Migration 002 failed:', err);
  process.exit(1);
});
