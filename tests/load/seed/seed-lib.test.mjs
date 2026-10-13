// node --test tests/load/seed/seed-lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildEmployeeDoc, buildEmployerDoc, employeeEmail, employeeUid, employerId, slotsFor } from './pool.js';
import { NotLoadTestData, describePlan, seedPool, teardownPool } from './seed-lib.mjs';

// ── A small in-memory Firestore + Auth with the Admin SDK surface the lib uses ──

const DOCUMENT_ID = Symbol('documentId');

function fakeFirestore() {
  const docs = new Map(); // 'collection/id[/sub/id]' → data
  let commits = 0;

  const docRef = (path) => ({
    path,
    id: path.split('/').pop(),
    set: async (data, options) => {
      docs.set(path, options?.merge ? { ...(docs.get(path) ?? {}), ...data } : { ...data });
    },
    collection: (name) => collectionRef(`${path}/${name}`),
  });
  const snapshot = (paths) => {
    const list = paths.map((path) => ({ id: path.split('/').pop(), ref: docRef(path), data: () => docs.get(path) }));
    return { docs: list, empty: list.length === 0, size: list.length };
  };
  const collectionRef = (collectionPath) => {
    const depth = collectionPath.split('/').length + 1;
    const members = () =>
      [...docs.keys()]
        .filter((path) => path.startsWith(`${collectionPath}/`) && path.split('/').length === depth)
        .sort();
    const query = (filters, max) => ({
      where: (field, op, value) => query([...filters, { field, op, value }], max),
      limit: (n) => query(filters, n),
      get: async () => {
        const matching = members().filter((path) =>
          filters.every(({ field, op, value }) => {
            const actual = field === DOCUMENT_ID ? path.split('/').pop() : docs.get(path)[field];
            if (op === '>=') return typeof actual === 'string' && actual >= value;
            if (op === '<') return typeof actual === 'string' && actual < value;
            if (op === 'in') return value.includes(actual);
            throw new Error(`fake: unsupported operator ${op}`);
          })
        );
        return snapshot(max === undefined ? matching : matching.slice(0, max));
      },
    });
    return { doc: (id) => docRef(`${collectionPath}/${id}`), ...query([], undefined) };
  };

  return {
    docs,
    commits: () => commits,
    collection: collectionRef,
    batch: () => {
      const ops = [];
      return {
        set: (ref, data) => ops.push(() => docs.set(ref.path, { ...data })),
        delete: (ref) => ops.push(() => docs.delete(ref.path)),
        commit: async () => {
          assert.ok(ops.length <= 500, 'a Firestore batch holds at most 500 writes');
          commits++;
          for (const op of ops) op();
        },
      };
    },
  };
}

function fakeAuth() {
  const users = new Map();
  const error = (code) => Object.assign(new Error(code), { code });
  return {
    users,
    createUser: async ({ uid, ...rest }) => {
      if (users.has(uid)) throw error('auth/uid-already-exists');
      users.set(uid, { uid, ...rest });
    },
    updateUser: async (uid, properties) => {
      if (!users.has(uid)) throw error('auth/user-not-found');
      users.set(uid, { ...users.get(uid), ...properties });
    },
    setCustomUserClaims: async (uid, claims) => {
      users.get(uid).customClaims = claims;
    },
    listUsers: async (max, pageToken) => {
      const all = [...users.values()];
      const start = pageToken ? Number(pageToken) : 0;
      const page = all.slice(start, start + 2); // tiny pages: exercises the pageToken loop
      return { users: page, pageToken: start + 2 < all.length ? String(start + 2) : undefined };
    },
    deleteUsers: async (uids) => {
      for (const uid of uids) users.delete(uid);
      return { successCount: uids.length, failureCount: 0 };
    },
  };
}

const STAMP = '<server-timestamp>';
const seedDeps = (db, auth) => ({ db, auth, serverTimestamp: () => STAMP });
const tearDeps = (db, auth) => ({ db, auth, documentId: DOCUMENT_ID });

/** Things a real project holds that the pool must never touch. */
function plantRealData(db, auth) {
  db.docs.set('employees/realBorrowerUid', { name: 'Ana Real', employerId: 'realEmployerUid' });
  db.docs.set('employees/loadtester-not-ours', { name: 'similar prefix, different word' });
  db.docs.set('employers/realEmployerUid', { companyName: 'Cliente Real SA', status: 'active' });
  db.docs.set('employers/qa-funpay-demo-employer', { companyName: 'FunPay QA', isQaFixture: true });
  db.docs.set('loans/realLoan', { employeeId: 'realBorrowerUid', status: 'active', amount: 3000 });
  db.docs.set('loans/realLoan/underwritingDetail/detail', { decision: 'approved' });
  db.docs.set('review_queue/realReview', { loanId: 'realLoan' });
  db.docs.set('audit_log/realAudit', { actorUid: 'realBorrowerUid', action: 'loan.requested' });
  db.docs.set('config/loan', { feeRate: 0.3 });
  auth.users.set('realBorrowerUid', { uid: 'realBorrowerUid', email: 'ana@example.com' });
  // prefixed uid, but not our email domain: somebody else's account, not ours to delete
  auth.users.set('loadtest-emp-999999', { uid: 'loadtest-emp-999999', email: 'someone@example.com' });
}

/** What a k6 run leaves behind for pool member `index`. */
function plantRunResidue(db, index, loanId) {
  db.docs.set(`loans/${loanId}`, { employeeId: employeeUid(index), status: 'under_review', amount: 1000 });
  db.docs.set(`loans/${loanId}/underwritingDetail/detail`, { decision: 'pending_review' });
  db.docs.set(`loans/${loanId}/underwritingDetail/inlineMl`, { source: 'inline_ml_gate' });
  db.docs.set(`review_queue/rq-${loanId}`, { loanId, reason: 'ml_gate_unavailable' });
  db.docs.set(`audit_log/a1-${loanId}`, { actorUid: employeeUid(index), action: 'loan.requested', targetId: loanId });
  db.docs.set(`audit_log/a2-${loanId}`, { actorUid: employeeUid(index), action: 'loan.ml_gate_unavailable' });
}

test('seedPool writes exactly the documented shapes, accounts and claims', async () => {
  const db = fakeFirestore();
  const auth = fakeAuth();
  const result = await seedPool(seedDeps(db, auth), { count: 7, employers: 2, password: 'pw-for-test', concurrency: 3 });

  assert.deepEqual(result, { employers: 2, employees: 7 });
  assert.equal(db.docs.size, 9);
  assert.equal(auth.users.size, 7);
  for (let j = 0; j < 2; j++) {
    assert.deepEqual(db.docs.get(`employers/${employerId(j)}`), { ...buildEmployerDoc(j, slotsFor(j, 7, 2)), seededAt: STAMP });
  }
  assert.equal(db.docs.get(`employers/${employerId(0)}`).maxActiveSlots, 4);
  assert.equal(db.docs.get(`employers/${employerId(1)}`).maxActiveSlots, 3);
  for (let i = 0; i < 7; i++) {
    assert.deepEqual(db.docs.get(`employees/${employeeUid(i)}`), { ...buildEmployeeDoc(i, 2), createdAt: STAMP });
    assert.deepEqual(auth.users.get(employeeUid(i)), {
      uid: employeeUid(i),
      email: employeeEmail(i),
      password: 'pw-for-test',
      emailVerified: true,
      disabled: false,
      customClaims: { role: 'employee' },
    });
  }
});

test('an employer is never CREATED in an approved status (the creation trigger would try to grant a claim)', async () => {
  const db = fakeFirestore();
  const firstWrite = new Map();
  const original = db.collection;
  db.collection = (name) => {
    const ref = original(name);
    if (name !== 'employers') return ref;
    return {
      ...ref,
      doc: (id) => {
        const doc = ref.doc(id);
        return {
          ...doc,
          set: async (data, options) => {
            if (!firstWrite.has(id)) firstWrite.set(id, data.status);
            return doc.set(data, options);
          },
        };
      },
    };
  };
  await seedPool(seedDeps(db, fakeAuth()), { count: 4, employers: 2, password: 'pw-for-test' });

  assert.deepEqual([...firstWrite.values()], ['pending_verification', 'pending_verification']);
  // …and ends in the status requestLoan and buildEmployerDoc both mean
  for (let j = 0; j < 2; j++) assert.equal(db.docs.get(`employers/${employerId(j)}`).status, 'active');
});

test('seedPool is idempotent, restores a spent credit line, and keeps what a trigger added to the employer', async () => {
  const db = fakeFirestore();
  const auth = fakeAuth();
  const opts = { count: 5, employers: 1, password: 'first-password' };
  await seedPool(seedDeps(db, auth), opts);
  const before = structuredClone([...db.docs.entries()]);

  // a run spent credit; onEmployeeDocCreated maintained a headcount on the employer
  db.docs.get(`employees/${employeeUid(2)}`).availableCredit = 0;
  db.docs.get(`employers/${employerId(0)}`).totalEmployees = 5;

  await seedPool(seedDeps(db, auth), { ...opts, password: 'rotated-password' });

  assert.equal(db.docs.size, 6);
  assert.equal(auth.users.size, 5);
  assert.equal(db.docs.get(`employees/${employeeUid(2)}`).availableCredit, buildEmployeeDoc(2, 1).availableCredit);
  assert.equal(db.docs.get(`employers/${employerId(0)}`).totalEmployees, 5);
  assert.equal(auth.users.get(employeeUid(0)).password, 'rotated-password');
  db.docs.get(`employers/${employerId(0)}`).totalEmployees = undefined;
  assert.deepEqual(JSON.parse(JSON.stringify([...db.docs.entries()])), JSON.parse(JSON.stringify(before)));
});

test('seedPool never writes outside the prefix and batches large pools', async () => {
  const db = fakeFirestore();
  const auth = fakeAuth();
  plantRealData(db, auth);
  const real = structuredClone([...db.docs.entries()].filter(([path]) => !path.includes('loadtest-emp-0')));

  await seedPool(seedDeps(db, auth), { count: 1001, employers: 21, password: 'pw-for-test' });

  assert.equal(db.commits(), 3); // 400 + 400 + 201
  for (const [path, data] of real) assert.deepEqual(db.docs.get(path), data, path);
  const written = [...db.docs.keys()].filter((path) => !real.some(([p]) => p === path));
  assert.equal(written.length, 1001 + 21);
  for (const path of written) assert.match(path, /^(employees\/loadtest-emp-\d{6}|employers\/loadtest-employer-\d{4})$/);
  assert.equal(auth.users.get('realBorrowerUid').email, 'ana@example.com');
});

test('seedPool refuses to run without a password and surfaces unexpected Auth errors', async () => {
  await assert.rejects(seedPool(seedDeps(fakeFirestore(), fakeAuth()), { count: 1, employers: 1, password: '' }), /password/);

  const auth = fakeAuth();
  auth.createUser = async () => {
    throw Object.assign(new Error('email taken'), { code: 'auth/email-already-exists' });
  };
  const db = fakeFirestore();
  await assert.rejects(seedPool(seedDeps(db, auth), { count: 1, employers: 1, password: 'pw' }), /email taken/);
  assert.equal([...db.docs.keys()].filter((p) => p.startsWith('employees/')).length, 0);
});

test('teardownPool removes the pool and its run residue, and nothing else', async () => {
  const db = fakeFirestore();
  const auth = fakeAuth();
  plantRealData(db, auth);
  const realDocs = structuredClone([...db.docs.entries()]);
  const realUsers = structuredClone([...auth.users.entries()]);

  await seedPool(seedDeps(db, auth), { count: 9, employers: 2, password: 'pw-for-test' });
  for (let i = 0; i < 7; i++) plantRunResidue(db, i, `loanOf${i}`);

  // pageSize 2 forces every query through several pages
  const result = await teardownPool(tearDeps(db, auth), { pageSize: 2 });

  assert.deepEqual(result, {
    loans: 7,
    loanDetails: 14,
    reviewQueue: 7,
    auditLog: 14,
    employees: 9,
    employers: 2,
    authUsers: 9,
  });
  assert.deepEqual([...db.docs.entries()], realDocs);
  assert.deepEqual([...auth.users.entries()], realUsers);
});

test('teardownPool on an empty project is a no-op, and a second teardown deletes nothing', async () => {
  const db = fakeFirestore();
  const auth = fakeAuth();
  const zero = { loans: 0, loanDetails: 0, reviewQueue: 0, auditLog: 0, employees: 0, employers: 0, authUsers: 0 };
  assert.deepEqual(await teardownPool(tearDeps(db, auth)), zero);

  await seedPool(seedDeps(db, auth), { count: 3, employers: 1, password: 'pw-for-test' });
  await teardownPool(tearDeps(db, auth));
  assert.deepEqual(await teardownPool(tearDeps(db, auth)), zero);
  assert.equal(db.docs.size, 0);
  assert.equal(auth.users.size, 0);
});

test('teardownPool stops — deleting nothing more — if a query ever hands it a row that is not load-test data', async () => {
  const db = fakeFirestore();
  const auth = fakeAuth();
  plantRealData(db, auth);
  await seedPool(seedDeps(db, auth), { count: 2, employers: 1, password: 'pw-for-test' });

  // A backend (or a future edit to the query) that ignores the range filter:
  const original = db.collection;
  db.collection = (name) => {
    const ref = original(name);
    return name === 'loans' ? { ...ref, where: () => ({ where: () => ref }) } : ref;
  };

  await assert.rejects(teardownPool(tearDeps(db, auth)), NotLoadTestData);
  assert.deepEqual(db.docs.get('loans/realLoan'), { employeeId: 'realBorrowerUid', status: 'active', amount: 3000 });
  assert.ok(db.docs.has('loans/realLoan/underwritingDetail/detail'));
  assert.ok(db.docs.has('review_queue/realReview'));
});

test('teardownPool applies the same stop to employees, employers and audit rows', async () => {
  for (const collection of ['audit_log', 'employees', 'employers']) {
    const db = fakeFirestore();
    const auth = fakeAuth();
    plantRealData(db, auth);
    const before = structuredClone([...db.docs.entries()]);
    const original = db.collection;
    db.collection = (name) => {
      const ref = original(name);
      return name === collection ? { ...ref, where: () => ({ where: () => ref }) } : ref;
    };
    await assert.rejects(teardownPool(tearDeps(db, auth)), NotLoadTestData, collection);
    assert.deepEqual([...db.docs.entries()], before, collection);
  }
});

test('describePlan states the target, the range and — for teardown — exactly what is in scope', () => {
  const seed = describePlan({ count: 120, employers: 3, dryRun: true, teardown: false }, { mode: 'project', projectId: 'vida-staging' });
  assert.ok(seed.some((l) => l.includes('DRY RUN')));
  assert.ok(seed.some((l) => l.includes('vida-staging')));
  assert.ok(seed.some((l) => l.includes('loadtest-emp-000000 … loadtest-emp-000119')));
  assert.ok(!seed.join('\n').includes('pw-for-test'));

  const teardown = describePlan({ count: 120, employers: 3, dryRun: false, teardown: true }, { mode: 'emulator', projectId: 'demo-vida-load' }).join('\n');
  for (const scope of ['auth users', 'employees/*', 'employers/*', 'loans/*', 'review_queue/*', 'audit_log/*', 'rl:loan:<uid>']) {
    assert.ok(teardown.includes(scope), scope);
  }
});
