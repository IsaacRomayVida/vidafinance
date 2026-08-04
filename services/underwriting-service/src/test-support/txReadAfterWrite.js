// The one Firestore rule the transaction stand-ins in this package enforce
// rather than merely imitate.
//
// A transaction body that calls `tx.get()` after it has staged a write does not
// "behave a little differently" against the real Admin SDK -- it throws, every
// time, before any RPC leaves the process:
//
//   get(refOrQuery) {
//     if (this._writeBatch && !this._writeBatch.isEmpty) {
//       throw new Error(READ_AFTER_WRITE_ERROR_MSG);
//
// (@google-cloud/firestore/build/src/transaction.js:95-97, and :141-143 for
// `getAll`, pinned at 7.11.6 via firebase-admin ^12). The transaction never
// commits, so the caller sees an error and NOTHING is written.
//
// A permissive mock does not make such a handler look slightly optimistic -- it
// makes it look like it works. payment-server's POST /internal/repayment read
// the employee doc after updating the loan and setting the repayment row, and
// 109 tests passed green over a route that could not execute in production for
// a single real payroll deduction. Enforcing the rule in the mock is what keeps
// these suites about what the code does.
const READ_AFTER_WRITE_ERROR_MSG =
  'Firestore transactions require all reads to be executed before all writes.';

/** Everything the SDK routes through `_writeBatch`, so everything that arms the guard. */
const WRITE_METHODS = ['set', 'update', 'create', 'delete'];

/** Everything the SDK guards on entry. */
const READ_METHODS = ['get', 'getAll'];

/**
 * Wrap a hand-rolled transaction stand-in so it refuses a read taken after a
 * write, exactly as the Admin SDK does.
 *
 * Call-through only: the wrapper adds the guard and changes nothing else, so
 * assertions a test already makes against the inner `jest.fn()`s keep working.
 * The throw is synchronous, matching the SDK -- `get` is a plain method there,
 * not an `async` one, so it raises rather than returning a rejected promise.
 */
function guardReadAfterWrite(txn) {
  let hasStagedWrite = false;
  const guarded = {};

  for (const key of Object.keys(txn)) {
    const value = txn[key];

    if (typeof value !== 'function') {
      guarded[key] = value;
      continue;
    }

    if (READ_METHODS.includes(key)) {
      guarded[key] = (...args) => {
        if (hasStagedWrite) throw new Error(READ_AFTER_WRITE_ERROR_MSG);
        return value.apply(txn, args);
      };
    } else if (WRITE_METHODS.includes(key)) {
      guarded[key] = (...args) => {
        hasStagedWrite = true;
        const result = value.apply(txn, args);
        // Preserve the chaining style `tx.set(...).update(...)` without letting
        // it hand back the unguarded object.
        return result === txn ? guarded : result;
      };
    } else {
      guarded[key] = (...args) => value.apply(txn, args);
    }
  }

  return guarded;
}

module.exports = { guardReadAfterWrite, READ_AFTER_WRITE_ERROR_MSG };
