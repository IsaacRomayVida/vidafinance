#!/usr/bin/env node
'use strict';

// One-time, idempotent backfill: seeds the identity registry from existing
// Firestore `employers/{uid}` docs. Safe to re-run -- resolveOrCreateEntity
// and addExternalRef are both no-ops on data that's already there.
//
// Scope: employers only. Funpay's employee data model currently writes to
// two different Firestore shapes for what should be one worker identity
// (flat `employees/{uid}` vs `employers/{id}/employees/{docId}` subcollection,
// see DATABASE.md vs functions/src/invites/acceptInvite.ts) -- backfilling
// workers needs that reconciled first so we don't split one real worker into
// two registry entities. Tracked as a follow-up, not guessed at here.
//
// Usage:
//   node scripts/backfill.js --dry-run
//   node scripts/backfill.js --apply

const admin = require('firebase-admin');
const { getPool } = require('../../shared/registry/pool');
const { resolveOrCreateEntity, addExternalRef } = require('../../shared/registry/resolver');

async function main() {
  const apply = process.argv.includes('--apply');
  const dryRun = !apply;

  const svcAcct = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT_B64
      ? Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString()
      : process.env.FIREBASE_SERVICE_ACCOUNT
  );
  admin.initializeApp({ credential: admin.credential.cert(svcAcct) });
  const db = admin.firestore();
  const pool = getPool();

  const snapshot = await db.collection('employers').get();
  console.log(`Found ${snapshot.size} employer docs. Mode: ${dryRun ? 'DRY RUN' : 'APPLY'}`);

  let resolved = 0;
  let refsAdded = 0;
  let skipped = 0;

  for (const doc of snapshot.docs) {
    const employerId = doc.id;
    const data = doc.data() ?? {};
    const rfc = typeof data.rfc === 'string' && data.rfc.trim() ? data.rfc.trim() : null;

    if (dryRun) {
      console.log(`[dry-run] would resolve employer firebase:${employerId} (rfc: ${rfc ?? 'none'})`);
      resolved++;
      if (rfc) refsAdded++;
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const entityId = await resolveOrCreateEntity(client, {
        system: 'firebase',
        externalId: employerId,
        kind: 'employer',
        displayName: data.companyName ?? null,
      });
      if (rfc) {
        await addExternalRef(client, entityId, 'rfc', rfc);
        refsAdded++;
      }
      await client.query('COMMIT');
      resolved++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`Failed on employer ${employerId}:`, err.message);
      skipped++;
    } finally {
      client.release();
    }
  }

  console.log(`Done. resolved=${resolved} refsAdded=${refsAdded} skipped=${skipped}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
