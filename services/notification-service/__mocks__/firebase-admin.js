'use strict';

// Minimal in-memory Firestore stand-in for notification-service tests.
// Covers exactly what src/lib/firebase.ts and src/services/firestoreService.ts
// use: collection().doc().get()/.add(), and FieldValue.serverTimestamp().
// Adapted from services/payment-server/__mocks__/firebase-admin.js.

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

function firestore() {
  return { collection };
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
};

module.exports = admin;
