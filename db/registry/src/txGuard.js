'use strict';

// appendReceipt relies on an advisory xact lock to serialize concurrent
// writers -- a guarantee that only holds if the caller already opened a
// transaction (BEGIN before, COMMIT/ROLLBACK after). pg_advisory_xact_lock
// silently releases at statement end in autocommit, so calling it outside a
// transaction doesn't error, it just quietly drops the serialization
// guarantee.
//
// SAVEPOINT can only be used inside a transaction block -- Postgres raises
// "SAVEPOINT can only be used in transaction blocks" outside one -- so it
// doubles as a zero-side-effect probe for "is this client mid-transaction".
async function assertInTransaction(client, callerName) {
  try {
    await client.query('SAVEPOINT tx_guard_probe');
  } catch (err) {
    throw new Error(
      `${callerName} must be called inside an open transaction (BEGIN before, COMMIT/ROLLBACK after) -- ` +
        `its advisory lock only serializes concurrent writers for the transaction's lifetime. ` +
        `(probe failed: ${err.message})`
    );
  }
  await client.query('RELEASE SAVEPOINT tx_guard_probe');
}

module.exports = { assertInTransaction };
