'use strict';

// Minimal in-memory Firestore + Storage stand-in for pdf-generator tests.
// Covers exactly what index.js uses: collection().doc()/.add()/.get()/.update(),
// FieldValue.serverTimestamp(), and storage().bucket().file().save()/.makePublic().
// Not a general Firebase emulator -- do not extend it beyond what the service
// actually calls. Adapted from services/payment-server/__mocks__/firebase-admin.js.

const SERVER_TIMESTAMP = '__serverTimestamp__';

let collections = new Map(); // name -> Map(id -> data)
let savedFiles = new Map(); // filePath -> { buf, metadata, public }
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
    collection(subName) {
      return collection(`${colName}/${id}/${subName}`);
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

function file(filePath) {
  return {
    async save(buf, opts) {
      savedFiles.set(filePath, { buf, metadata: opts && opts.metadata, public: false });
    },
    async makePublic() {
      const entry = savedFiles.get(filePath);
      if (entry) entry.public = true;
    },
  };
}

function storage() {
  return {
    name: process.env.FIREBASE_STORAGE_BUCKET || 'test-bucket',
    bucket() {
      return { file, name: process.env.FIREBASE_STORAGE_BUCKET || 'test-bucket' };
    },
  };
}

const admin = {
  initializeApp: () => {},
  credential: { cert: (x) => x },
  firestore,
  storage,
  apps: [],

  // Test-only helpers -- not part of the real firebase-admin API.
  __reset() {
    collections = new Map();
    savedFiles = new Map();
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
  __savedFiles() {
    return savedFiles;
  },
};

module.exports = admin;
