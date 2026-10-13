/**
 * Rehearsal for migration 002 against the Firestore EMULATOR, with seeded data.
 *
 * Proves, against a real Firestore implementation rather than a test double:
 *   1. `--dry-run` writes nothing (audit_log is byte-for-byte unchanged);
 *   2. the real run copies every timestamped legacy row and skips the rest;
 *   3. a second real run is a no-op on content and row count (idempotent);
 *   4. `auditLogs` and the native `audit_log` rows are untouched.
 *
 * Refuses to start unless FIRESTORE_EMULATOR_HOST is set AND the project id
 * starts with `demo-` (a project the emulator can never forward to Google).
 * See docs/runbooks/audit-log-consolidation.md § "Rehearsal" for the command.
 */

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';

import { run } from './002_consolidate_audit_logs';

const PROJECT = process.env['GCLOUD_PROJECT'] ?? '';
if (!process.env['FIRESTORE_EMULATOR_HOST'] || !PROJECT.startsWith('demo-')) {
  console.error('Refusing: set FIRESTORE_EMULATOR_HOST and a demo-* GCLOUD_PROJECT. This script seeds data.');
  process.exit(2);
}

const LEGACY_ROWS = 25;
const UNTIMESTAMPED = 2;

async function dump(db: Firestore, col: string): Promise<Record<string, unknown>> {
  const snap = await db.collection(col).get();
  const out: Record<string, unknown> = {};
  for (const d of snap.docs) out[d.id] = d.data();
  return out;
}

let failures = 0;
function check(ok: boolean, label: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

async function main() {
  initializeApp({ projectId: PROJECT });
  const db = getFirestore();

  // Seed: timestamped legacy rows (some with unknown fields), a few without a
  // timestamp, and one native audit_log row that must survive untouched.
  const batch = db.batch();
  for (let i = 0; i < LEGACY_ROWS; i++) {
    batch.set(db.collection('auditLogs').doc(`seed_${i}`), {
      action: i % 2 ? 'admin.grant' : 'admin.revoke',
      actorUid: `ops_${i % 3}`,
      targetId: `user_${i}`,
      ...(i % 5 === 0 ? { role: 'ops', note: 'pre-consolidation field' } : {}),
      timestamp: Timestamp.fromDate(new Date(Date.UTC(2024, 0, 1 + i))),
    });
  }
  for (let i = 0; i < UNTIMESTAMPED; i++) {
    batch.set(db.collection('auditLogs').doc(`nots_${i}`), { action: 'admin.grant', targetId: `user_x${i}` });
  }
  batch.set(db.collection('audit_log').doc('native_1'), {
    action: 'loans.disburse',
    timestamp: Timestamp.fromDate(new Date('2026-01-01T00:00:00Z')),
  });
  await batch.commit();

  const legacyBefore = JSON.stringify(await dump(db, 'auditLogs'));
  const destBefore = JSON.stringify(await dump(db, 'audit_log'));

  console.log('\n=== 1. dry run ===');
  await run(db, true);
  check(JSON.stringify(await dump(db, 'audit_log')) === destBefore, 'dry run left audit_log unchanged');

  console.log('\n=== 2. real run ===');
  await run(db, false);
  const afterFirst = await dump(db, 'audit_log');
  const migrated = Object.entries(afterFirst).filter(
    ([, v]) => (v as Record<string, unknown>)['_migrationTag'] === '002_consolidate_audit_logs'
  );
  check(migrated.length === LEGACY_ROWS, `migrated rows = ${migrated.length} (expected ${LEGACY_ROWS} = legacy − skipped)`);
  const src = (await db.collection('auditLogs').doc('seed_7').get()).data()!;
  const dst = afterFirst['legacy_seed_7'] as Record<string, unknown>;
  check(
    dst['action'] === src['action'] &&
      dst['actorUid'] === src['actorUid'] &&
      dst['targetId'] === src['targetId'] &&
      (dst['timestamp'] as Timestamp).isEqual(src['timestamp'] as Timestamp),
    'spot-check legacy_seed_7: action/actorUid/targetId/timestamp match the original'
  );

  console.log('\n=== 3. re-run (idempotency) ===');
  await run(db, false);
  const afterSecond = await dump(db, 'audit_log');
  check(Object.keys(afterSecond).length === Object.keys(afterFirst).length, 're-run added no rows');
  check(JSON.stringify(afterSecond) === JSON.stringify(afterFirst), 're-run left content identical');

  console.log('\n=== 4. untouched ===');
  check(JSON.stringify(await dump(db, 'auditLogs')) === legacyBefore, 'auditLogs unchanged (copy-only)');
  check(JSON.stringify(afterSecond['native_1']) === JSON.stringify(JSON.parse(destBefore)['native_1']), 'native audit_log row unchanged');

  // run() sets exitCode 1 because of the deliberate untimestamped seeds; that is
  // expected here, so the rehearsal's own checks decide the exit code.
  console.log(`\n${failures === 0 ? 'REHEARSAL PASSED' : `REHEARSAL FAILED (${failures})`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('Rehearsal failed:', err);
  process.exit(1);
});
