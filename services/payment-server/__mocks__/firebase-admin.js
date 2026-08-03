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

async function runTransaction(fn) {
  const tx = {
    async get(ref) {
      return ref.get();
    },
    update(ref, updates) {
      const existing = col(ref._colName).get(ref.id);
      col(ref._colName).set(ref.id, applyFieldValues(existing, updates));
    },
    set(ref, data) {
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
