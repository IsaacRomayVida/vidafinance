/**
 * Migration 001: Flatten Employee Subcollections
 *
 * Copies any employee documents stored under the subcollection pattern
 * `employers/{employerId}/employees/{employeeId}` into the canonical
 * flat collection `employees/{employeeId}`.
 *
 * Safe to run multiple times — existing flat documents are skipped
 * unless the subcollection document is newer (updatedAt comparison).
 *
 * Usage:
 *   npx ts-node scripts/migrations/001_flatten_employees.ts [--dry-run]
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS or Firebase default credentials.
 */

import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  initializeApp({ credential: applicationDefault() });
  const db = getFirestore();

  console.log(`Migration 001: Flatten employee subcollections${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log('─'.repeat(60));

  const employersSnap = await db.collection('employers').get();
  console.log(`Found ${employersSnap.size} employer(s).`);

  let copied = 0;
  let skipped = 0;
  let updated = 0;

  for (const employerDoc of employersSnap.docs) {
    const employerId = employerDoc.id;
    const subSnap = await db
      .collection('employers')
      .doc(employerId)
      .collection('employees')
      .get();

    if (subSnap.empty) continue;

    console.log(`\nEmployer ${employerId}: ${subSnap.size} subcollection employee(s)`);

    for (const subDoc of subSnap.docs) {
      const employeeId = subDoc.id;
      const subData = subDoc.data();
      const flatRef = db.collection('employees').doc(employeeId);
      const flatDoc = await flatRef.get();

      if (flatDoc.exists) {
        const flatData = flatDoc.data()!;
        const subUpdated = subData['updatedAt']?.toMillis?.() ?? 0;
        const flatUpdated = flatData['updatedAt']?.toMillis?.() ?? 0;

        if (subUpdated > flatUpdated) {
          console.log(`  ↻ ${employeeId} — flat doc exists but subcollection is newer, updating`);
          if (!DRY_RUN) {
            await flatRef.update({
              ...subData,
              employerId,
              _migratedFrom: 'subcollection',
              _migratedAt: FieldValue.serverTimestamp(),
            });
          }
          updated++;
        } else {
          console.log(`  ✓ ${employeeId} — already in flat collection, skipping`);
          skipped++;
        }
        continue;
      }

      console.log(`  → ${employeeId} — copying to flat collection`);
      if (!DRY_RUN) {
        await flatRef.set({
          ...subData,
          employerId,
          _migratedFrom: 'subcollection',
          _migratedAt: FieldValue.serverTimestamp(),
        });
      }
      copied++;
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`Done. Copied: ${copied}, Updated: ${updated}, Skipped: ${skipped}`);

  if (DRY_RUN) {
    console.log('\nThis was a dry run. Re-run without --dry-run to apply changes.');
  } else if (copied > 0 || updated > 0) {
    console.log('\nSubcollection documents have been copied to the flat collection.');
    console.log('After verifying, you may delete the subcollection documents manually.');
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
