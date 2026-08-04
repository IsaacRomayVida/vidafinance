'use strict';

// Minimal in-memory Firestore stand-in for softcredito-adapter tests. Covers
// exactly what index.js uses: collection().doc()/.add()/.where().limit().get(),
// .set() with and without { merge }, runTransaction() with tx.get/set/update,
// and FieldValue.serverTimestamp(). Not a general Firestore emulator -- do not
// extend it beyond what the service actually calls.
//
// .doc(id) with a falsy id (including explicit `undefined`, which is what a
// destructured-but-missing body field produces) auto-generates an ID, same as
// the real SDK. .update() on a document that does not exist THROWS, same as
// the real SDK -- unlike a plain upsert, this is deliberate: several of the
// new tests exist specifically to pin what happens when a route is called
// with a missing/unknown ID, and the real behavior is a synchronous-looking
// NOT_FOUND, not a silent no-op.

const SERVER_TIMESTAMP = '__serverTimestamp__';

let collections = new Map(); // name -> Map(id -> data)
let autoId = 0;

function col(name) {
  if (!collections.has(name)) collections.set(name, new Map());
  return collections.get(name);
}

function applyFieldValues(existing, updates) {
  const merged = { ...(existing || {}) };
  for (const [k, v] of Object.entries(updates)) {
    if (v && v.__type === SERVER_TIMESTAMP) {
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
      if (existing === undefined) {
        const err = new Error(`${id}: No document to update`);
        err.code = 5; // NOT_FOUND, matching @google-cloud/firestore's GoogleError.code
        throw err;
      }
      col(colName).set(id, applyFieldValues(existing, updates));
    },
    async set(data, opts) {
      const base = opts && opts.merge ? col(colName).get(id) : undefined;
      col(colName).set(id, applyFieldValues(base, data));
    },
  };
}

// Serialized transactions.
//
// Firestore gives a transaction serializable isolation: two concurrent
// transactions touching the same document cannot both read a pre-write state
// and both commit. Node is single-threaded, so without modelling that, two
// concurrent requests would each `await tx.get()` (yielding), each observe "no
// claim", and each commit -- which would make the concurrency test in
// test/disburse.test.js pass against code that is not actually safe.
//
// The queue below is what makes that test mean something: callbacks run one at
// a time, and writes are buffered until the callback returns so a throw leaves
// nothing behind.
let txQueue = Promise.resolve();

function runTransaction(fn) {
  const run = txQueue.then(async () => {
    const writes = [];
    const tx = {
      async get(ref) {
        const data = col(ref._colName).get(ref.id);
        return { exists: data !== undefined, id: ref.id, data: () => data };
      },
      set(ref, data, opts) {
        writes.push(() => {
          const base = opts && opts.merge ? col(ref._colName).get(ref.id) : undefined;
          col(ref._colName).set(ref.id, applyFieldValues(base, data));
        });
        return tx;
      },
      update(ref, data) {
        writes.push(() => {
          const existing = col(ref._colName).get(ref.id);
          if (existing === undefined) {
            const err = new Error(`${ref.id}: No document to update`);
            err.code = 5;
            throw err;
          }
          col(ref._colName).set(ref.id, applyFieldValues(existing, data));
        });
        return tx;
      },
    };
    const result = await fn(tx);
    for (const w of writes) w();
    return result;
  });
  // Keep the chain alive after a rejected transaction, or every later
  // transaction in the same test file inherits the failure.
  txQueue = run.then(() => {}, () => {});
  return run;
}

function collection(name) {
  return {
    doc(id) {
      return docRef(name, id || `auto_${++autoId}`);
    },
    async add(data) {
      const id = `auto_${++autoId}`;
      col(name).set(id, applyFieldValues({}, data));
      return docRef(name, id);
    },
    where(field, op, value) {
      if (op !== '==') throw new Error(`mock firestore: unsupported operator ${op}`);
      const matches = [...col(name).entries()]
        .filter(([, data]) => data[field] === value)
        .map(([id, data]) => ({ id, data: () => data }));
      return {
        limit(n) {
          const docs = matches.slice(0, n);
          return { async get() { return { empty: docs.length === 0, size: docs.length, docs }; } };
        },
      };
    },
    limit(n) {
      return {
        async get() {
          const docs = [...col(name).entries()].slice(0, n).map(([id, data]) => ({ id, data: () => data }));
          return { empty: docs.length === 0, size: docs.length, docs };
        },
      };
    },
  };
}

function firestore() {
  return { collection, runTransaction };
}
firestore.FieldValue = {
  serverTimestamp: () => ({ __type: SERVER_TIMESTAMP }),
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
