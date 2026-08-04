'use strict';

// Minimal in-memory Firestore stand-in for payment-server tests. Covers
// exactly what index.js uses: collection().doc()/.add()/.limit().get(),
// runTransaction() with tx.get/tx.update/tx.set, and FieldValue sentinels.
// Not a general Firestore emulator -- do not extend it beyond what the
// service actually calls.

const INCREMENT = '__increment__';
const SERVER_TIMESTAMP = '__serverTimestamp__';

let collections = new Map(); // name -> Map(id -> data)
let autoId = 0;
let failingAdds = new Map(); // collection name -> error message to throw on add()

function col(name) {
  if (!collections.has(name)) collections.set(name, new Map());
  return collections.get(name);
}

function applyFieldValues(existing, updates) {
  const merged = { ...(existing || {}) };
  for (const [k, v] of Object.entries(updates)) {
    if (v && v.__type === INCREMENT) {
      merged[k] = (existing && existing[k] || 0) + v.amount;
    } else if (v && v.__type === SERVER_TIMESTAMP) {
      merged[k] = '__mock_timestamp__';
    } else {
      merged[k] = v;
    }
  }
  return merged;
}

function docRef(colName, id) {
  return {
    id,
    _colName: colName,
    async get() {
      const data = col(colName).get(id);
      return { exists: data !== undefined, id, data: () => data };
    },
    async update(updates) {
      const existing = col(colName).get(id);
      col(colName).set(id, applyFieldValues(existing, updates));
    },
    async set(data) {
      col(colName).set(id, applyFieldValues({}, data));
    },
  };
}

function collection(name) {
  return {
    doc(id) {
      return docRef(name, id || `auto_${++autoId}`);
    },
    async add(data) {
      // Fault injection: lets a test exercise the routes while Firestore is
      // unreachable. Every route below writes to `incident_log` on its
      // failure paths, so without this the outage case -- the one where
      // responding at all matters most -- is untestable.
      if (failingAdds.has(name)) throw new Error(failingAdds.get(name));
      const id = `auto_${++autoId}`;
      col(name).set(id, applyFieldValues({}, data));
      return docRef(name, id);
    },
    where() {
      // Not exercised by payment-server's routes today.
      return { limit: () => ({ async get() { return { empty: true, docs: [] }; } }) };
    },
    limit() {
      return {
        async get() {
          const size = col(name).size;
          return { empty: size === 0, size, docs: [] };
        },
      };
    },
  };
}

// The one Firestore rule this stand-in enforces rather than merely imitates.
//
// A transaction body that calls tx.get() after it has staged a write does not
// "work a bit differently" against the real Admin SDK -- it throws, every
// time, before any RPC leaves the process:
// @google-cloud/firestore/build/src/transaction.js checks `!this._writeBatch.isEmpty`
// at the top of get() and raises READ_AFTER_WRITE_ERROR_MSG. The transaction
// never commits, so the caller sees a 500 and NOTHING is written.
//
// A permissive mock does not make such a route look slightly optimistic, it
// makes it look like it works. POST /internal/repayment read the employee doc
// after updating the loan and setting the repayment row, and every test below
// passed green against a happy path that could not execute in production for a
// single real payroll deduction. Enforcing the rule here is what keeps the
// money routes' tests about what the money routes do.
const READ_AFTER_WRITE_ERROR_MSG =
  'Firestore transactions require all reads to be executed before all writes.';

async function runTransaction(fn) {
  let hasStagedWrite = false;
  const tx = {
    async get(ref) {
      if (hasStagedWrite) throw new Error(READ_AFTER_WRITE_ERROR_MSG);
      return ref.get();
    },
    update(ref, updates) {
      hasStagedWrite = true;
      const existing = col(ref._colName).get(ref.id);
      col(ref._colName).set(ref.id, applyFieldValues(existing, updates));
    },
    set(ref, data) {
      hasStagedWrite = true;
      col(ref._colName).set(ref.id, applyFieldValues({}, data));
    },
  };
  return fn(tx);
}

function firestore() {
  return { collection, runTransaction };
}
firestore.FieldValue = {
  serverTimestamp: () => ({ __type: SERVER_TIMESTAMP }),
  increment: (amount) => ({ __type: INCREMENT, amount }),
};

const admin = {
  initializeApp: () => {},
  credential: { cert: (x) => x },
  firestore,
  apps: [],

  // Test-only helpers -- not part of the real firebase-admin API.
  __reset() {
    collections = new Map();
    autoId = 0;
    failingAdds = new Map();
  },
  // Arm `collection(name).add()` to reject, simulating Firestore being
  // unreachable for that collection.
  __failAdds(collName, message = 'Firestore unavailable') {
    failingAdds.set(collName, message);
  },
  __seed(collName, id, data) {
    col(collName).set(id, { ...data });
  },
  __get(collName, id) {
    return col(collName).get(id);
  },
  __all(collName) {
    return [...col(collName).entries()].map(([id, data]) => ({ id, data }));
  },
};

module.exports = admin;
