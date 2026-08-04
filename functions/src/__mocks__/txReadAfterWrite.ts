/**
 * The one Firestore rule these stand-ins enforce rather than merely imitate.
 *
 * A transaction body that calls `tx.get()` after it has staged a write does not
 * "behave a little differently" against the real Admin SDK — it throws, every
 * time, before any RPC leaves the process:
 *
 *   get(refOrQuery) {
 *     if (this._writeBatch && !this._writeBatch.isEmpty) {
 *       throw new Error(READ_AFTER_WRITE_ERROR_MSG);
 *
 * (@google-cloud/firestore/build/src/transaction.js:95-97 and :141-143 for
 * `getAll`, pinned at 7.11.6 via firebase-admin ^12). The transaction never
 * commits, so the caller sees a 500 and NOTHING is written.
 *
 * A permissive mock does not make such a handler look slightly optimistic — it
 * makes it look like it works. `POST /internal/repayment` read the employee doc
 * after updating the loan and setting the repayment row, and 109 payment-server
 * tests passed green against a happy path that could not execute in production
 * for a single real payroll deduction. Enforcing the rule in the mock is what
 * keeps a money path's tests about what the money path does.
 *
 * Note the throw is SYNCHRONOUS, matching the SDK: `get` is a plain method, not
 * an `async` one, so it raises rather than returning a rejected promise. Code
 * that fans reads out through `Promise.all(refs.map(r => tx.get(r)))` therefore
 * blows up inside `.map()`, before the `Promise.all` is ever constructed.
 */
export const READ_AFTER_WRITE_ERROR_MSG =
  'Firestore transactions require all reads to be executed before all writes.';

/** Everything the SDK routes through `_writeBatch`, so everything that arms the guard. */
const WRITE_METHODS: readonly string[] = ['set', 'update', 'create', 'delete'];

/** Everything the SDK guards on entry. */
const READ_METHODS: readonly string[] = ['get', 'getAll'];

/**
 * Wrap a hand-rolled transaction stand-in so it refuses a read taken after a
 * write, exactly as the Admin SDK does.
 *
 * Call-through only: the wrapper adds the guard and changes nothing else, so
 * assertions a test already makes against the inner `jest.fn()`s keep working.
 * A write method that returns the transaction (the chaining style
 * `tx.set(...).update(...)`) gets the GUARDED object back rather than the raw
 * one, or chaining would step around the check.
 */
export function guardReadAfterWrite<T extends object>(txn: T): T {
  let hasStagedWrite = false;
  const guarded: Record<string, unknown> = {};

  for (const key of Object.keys(txn)) {
    const value = (txn as Record<string, unknown>)[key];

    if (typeof value !== 'function') {
      guarded[key] = value;
      continue;
    }

    const original = value as (...args: unknown[]) => unknown;

    if (READ_METHODS.includes(key)) {
      guarded[key] = (...args: unknown[]) => {
        if (hasStagedWrite) throw new Error(READ_AFTER_WRITE_ERROR_MSG);
        return original.apply(txn, args);
      };
    } else if (WRITE_METHODS.includes(key)) {
      guarded[key] = (...args: unknown[]) => {
        hasStagedWrite = true;
        const result = original.apply(txn, args);
        return result === txn ? guarded : result;
      };
    } else {
      guarded[key] = (...args: unknown[]) => original.apply(txn, args);
    }
  }

  return guarded as T;
}
