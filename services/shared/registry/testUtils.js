'use strict';

// Test-only helper. receipts_no_truncate (migration 0001) now blocks
// TRUNCATE for every role, including the table owner -- by design, so a
// plain TRUNCATE can no longer be used to reset state between tests (that
// was exactly the hole PR-A1 review flagged: the old test suite's own
// TRUNCATE was proof the ledger wasn't actually append-only).
//
// ALTER TABLE ... DISABLE TRIGGER requires table-owner/superuser privilege,
// which the *test* DB connection has (it's the CI/local Postgres superuser)
// but registry_app never will -- so this reset path is unavailable to the
// application in any real environment, only to whoever administers the
// test database directly.
async function resetLedgerTestState(pool) {
  await pool.query('ALTER TABLE receipts DISABLE TRIGGER receipts_no_truncate');
  try {
    await pool.query(
      'TRUNCATE receipts, relationship_members, relationships, entity_refs, entities RESTART IDENTITY CASCADE'
    );
  } finally {
    await pool.query('ALTER TABLE receipts ENABLE TRIGGER receipts_no_truncate');
  }
}

module.exports = { resetLedgerTestState };
