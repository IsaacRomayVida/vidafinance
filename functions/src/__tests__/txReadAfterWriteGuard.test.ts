import { mockDb, _mockStore } from '../__mocks__/firebase-admin/firestore';
import { guardReadAfterWrite, READ_AFTER_WRITE_ERROR_MSG } from '../__mocks__/txReadAfterWrite';

/**
 * The guard that keeps every other suite in this package honest.
 *
 * Firestore refuses a transactional read taken after a write — `Transaction.get()`
 * throws READ_AFTER_WRITE_ERROR_MSG the moment the write batch is non-empty
 * (@google-cloud/firestore/build/src/transaction.js:95-97, pinned at 7.11.6 via
 * firebase-admin ^12), locally, before any RPC, so the transaction never commits
 * and NOTHING is written.
 *
 * payment-server's POST /internal/repayment shipped exactly that ordering and
 * 109 tests passed green over a route that could not execute for a single real
 * payroll deduction, because its stand-in imitated `runTransaction` permissively.
 * The guard is the fix for the CLASS; these tests are what stop it being quietly
 * neutered into a no-op later, which would look identical from the outside —
 * every suite still green, the invariant no longer checked.
 */
describe('guardReadAfterWrite', () => {
  it('reproduces the exact Admin SDK error message', () => {
    // Pinned verbatim: a suite asserting on a paraphrase would not catch a real
    // one, and this string is what an engineer greps for from a 500 in the logs.
    expect(READ_AFTER_WRITE_ERROR_MSG).toBe(
      'Firestore transactions require all reads to be executed before all writes.'
    );
  });

  it('allows every read taken before every write', async () => {
    const txn = guardReadAfterWrite({
      get: jest.fn(async () => ({ exists: true, data: () => ({ balance: 10 }) })),
      update: jest.fn(),
      set: jest.fn(),
    });

    const first = await txn.get();
    const second = await txn.get();
    txn.update();
    txn.set();

    expect(first.exists).toBe(true);
    expect(second.exists).toBe(true);
  });

  it.each(['set', 'update', 'create', 'delete'] as const)(
    'refuses a read taken after tx.%s()',
    (writeMethod) => {
      const txn = guardReadAfterWrite({
        get: jest.fn(async () => ({ exists: true, data: () => ({}) })),
        set: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
      });

      txn[writeMethod]();

      expect(() => txn.get()).toThrow(READ_AFTER_WRITE_ERROR_MSG);
    }
  );

  it('refuses a getAll taken after a write, as the SDK does', () => {
    const txn = guardReadAfterWrite({
      getAll: jest.fn(async () => []),
      update: jest.fn(),
    });

    txn.update();

    expect(() => txn.getAll()).toThrow(READ_AFTER_WRITE_ERROR_MSG);
  });

  it('throws SYNCHRONOUSLY rather than returning a rejected promise', () => {
    // The SDK's `get` is a plain method, not an `async` one. The difference is
    // load-bearing for the common fan-out shape
    // `Promise.all(refs.map(r => tx.get(r)))`: a synchronous throw escapes the
    // .map() before Promise.all is ever constructed, so no unhandled rejection
    // is produced. A guard that merely returned a rejected promise would let
    // `void tx.get(ref)` slip through unnoticed.
    const txn = guardReadAfterWrite({
      get: jest.fn(async () => ({ exists: true, data: () => ({}) })),
      update: jest.fn(),
    });
    txn.update();

    let threwSynchronously = false;
    let returned: unknown = 'never assigned';
    try {
      returned = txn.get();
    } catch {
      threwSynchronously = true;
    }

    expect(threwSynchronously).toBe(true);
    expect(returned).toBe('never assigned');
  });

  it('does not let the chaining style hand back an unguarded transaction', () => {
    // `tx.set(...).update(...)` is a shape the SDK supports; a write method that
    // returned the RAW object would leak a facade with no guard on it.
    const inner: Record<string, unknown> = {};
    inner['get'] = jest.fn(async () => ({ exists: false, data: () => null }));
    inner['set'] = jest.fn(() => inner);
    const txn = guardReadAfterWrite(inner) as {
      get: () => unknown;
      set: () => { get: () => unknown };
    };

    const chained = txn.set();

    expect(() => chained.get()).toThrow(READ_AFTER_WRITE_ERROR_MSG);
  });

  it('passes non-function properties through untouched', () => {
    const txn = guardReadAfterWrite({ get: jest.fn(), _label: 'employer-tx' });

    expect(txn._label).toBe('employer-tx');
  });
});

describe('the shared firebase-admin/firestore stand-in', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _mockStore.loans = {};
  });

  it('is actually wired to the guard, not merely shipping one', async () => {
    // The guard existing and the guard being INSTALLED are two different facts,
    // and only the second one prevented the repayment bug. This asserts the
    // second: a handler with the broken ordering must fail against the shared
    // mockDb every other suite in this package runs on.
    _mockStore.loans['loan-1'] = { exists: true, data: { status: 'active', amount: 5000 } };

    await expect(
      mockDb.runTransaction(async (txn) => {
        const loanRef = { _collection: 'loans', id: 'loan-1' };
        await txn.get(loanRef);
        txn.update(loanRef, { status: 'paid' });
        // The defect: a second read, below a staged write.
        await txn.get(loanRef);
      })
    ).rejects.toThrow(READ_AFTER_WRITE_ERROR_MSG);
  });

  it('still commits a transaction whose reads all precede its writes', async () => {
    _mockStore.loans['loan-2'] = { exists: true, data: { status: 'active', amount: 7000 } };

    const seen: Array<Record<string, unknown> | null> = [];
    await mockDb.runTransaction(async (txn) => {
      const loanRef = { _collection: 'loans', id: 'loan-2' };
      const snap = await txn.get(loanRef);
      seen.push(snap.data());
      txn.update(loanRef, { status: 'paid' });
    });

    expect(seen).toEqual([{ status: 'active', amount: 7000 }]);
    expect(_mockStore.transactionCalls).toContain('update');
  });
});
