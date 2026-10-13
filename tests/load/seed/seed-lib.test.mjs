// node --test tests/load/seed/seed-lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildEmployeeDoc, buildEmployerDoc, employeeEmail, employeeUid, employerId, rfcFor, slotsFor } from './pool.js';
import { NotLoadTestData, TeardownIncomplete, describePlan, seedPool, teardownPool } from './seed-lib.mjs';

// ── A small in-memory Firestore + Auth with the Admin SDK surface the lib uses ──

const DOCUMENT_ID = Symbol('documentId');

function fakeFirestore() {
  const docs = new Map(); // 'collection/id[/sub/id]' → data
  let commits = 0;

  const docRef = (path) => ({
    path,
    id: path.split('/').pop(),
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
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
  // Stage 5 rows of real applicants: no loan id of ours, RFCs either side of the pool's "LTXX" range
  db.docs.set('review_queue/realStage5a', { loanId: 'uw-1-aaaaaa', correlationId: 'uw-1-aaaaaa', applicantRfc: 'LOAA900101AB1' });
  db.docs.set('review_queue/realStage5b', { loanId: 'uw-1-bbbbbb', correlationId: 'uw-1-bbbbbb', applicantRfc: 'LUXX900101AB1' });
  db.docs.set('review_queue/realStage5c', { loanId: 'uw-1-cccccc', correlationId: 'uw-1-cccccc' });
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

/**
 * What a FULL-PIPELINE run leaves for pool member `index`: the review_queue row
 * written by services/underwriting-service/src/stages/stage5-review.js. Its
 * `loanId` is the pipeline's correlation id — requestLoan sends /underwrite no
 * loan id — and its applicantName is built from fields requestLoan does not send.
 */
function plantStage5Row(db, index) {
  const correlationId = `uw-1700000000000-s${index}`;
  db.docs.set(`review_queue/stage5-${index}`, {
    loanId: correlationId,
    correlationId,
    applicantName: 'undefined undefined',
    applicantRfc: rfcFor(index),
    status: 'pending',
  });
}

test('seedPool writes exactly the documented shapes, accounts and claims', async () => {
  const db = fakeFirestore();
  const auth = fakeAuth();
  const result = await seedPool(seedDeps(db, auth), { count: 7, password: 'pw-for-test', concurrency: 3 });

  // 7 members → 7 employers, one each (members 0..49 open employers 0..49)
  assert.deepEqual(result, { employers: 7, employees: 7 });
  assert.equal(db.docs.size, 14);
  assert.equal(auth.users.size, 7);
  for (let j = 0; j < 7; j++) {
    assert.deepEqual(db.docs.get(`employers/${employerId(j)}`), { ...buildEmployerDoc(j, slotsFor(j, 7)), seededAt: STAMP });
    assert.equal(db.docs.get(`employers/${employerId(j)}`).maxActiveSlots, 1);
  }
  for (let i = 0; i < 7; i++) {
    assert.deepEqual(db.docs.get(`employees/${employeeUid(i)}`), { ...buildEmployeeDoc(i), createdAt: STAMP });
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
  await seedPool(seedDeps(db, fakeAuth()), { count: 4, password: 'pw-for-test' });

  assert.deepEqual([...firstWrite.values()], Array(4).fill('pending_verification'));
  // …and ends in the status requestLoan and buildEmployerDoc both mean
  for (let j = 0; j < 4; j++) assert.equal(db.docs.get(`employers/${employerId(j)}`).status, 'active');
});

test('a re-seed never takes an existing employer out of `active`, not even for one write', async () => {
  const db = fakeFirestore();
  const auth = fakeAuth();
  const opts = { count: 4, password: 'pw-for-test' };
  await seedPool(seedDeps(db, auth), opts);

  const statusesWritten = [];
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
            statusesWritten.push(data.status);
            return doc.set(data, options);
          },
        };
      },
    };
  };
  await seedPool(seedDeps(db, auth), opts);

  assert.deepEqual(statusesWritten, Array(4).fill('active'));
});

test('seedPool is idempotent, restores a spent credit line, and keeps what a trigger added to the employer', async () => {
  const db = fakeFirestore();
  const auth = fakeAuth();
  const opts = { count: 5, password: 'first-password' };
  await seedPool(seedDeps(db, auth), opts);
  const before = structuredClone([...db.docs.entries()]);

  // a run spent credit; onEmployeeDocCreated maintained a headcount on the employer
  db.docs.get(`employees/${employeeUid(2)}`).availableCredit = 0;
  db.docs.get(`employers/${employerId(0)}`).totalEmployees = 5;

  await seedPool(seedDeps(db, auth), { ...opts, password: 'rotated-password' });

  assert.equal(db.docs.size, 10);
  assert.equal(auth.users.size, 5);
  assert.equal(db.docs.get(`employees/${employeeUid(2)}`).availableCredit, buildEmployeeDoc(2).availableCredit);
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

  await seedPool(seedDeps(db, auth), { count: 1001, password: 'pw-for-test' });
  const employerDocs = 50;

  assert.equal(db.commits(), 3); // 400 + 400 + 201
  for (const [path, data] of real) assert.deepEqual(db.docs.get(path), data, path);
  const written = [...db.docs.keys()].filter((path) => !real.some(([p]) => p === path));
  assert.equal(written.length, 1001 + employerDocs);
  for (const path of written) assert.match(path, /^(employees\/loadtest-emp-\d{6}|employers\/loadtest-employer-\d{4})$/);
  assert.equal(auth.users.get('realBorrowerUid').email, 'ana@example.com');
});

test('seedPool refuses to run without a password and surfaces unexpected Auth errors', async () => {
  await assert.rejects(seedPool(seedDeps(fakeFirestore(), fakeAuth()), { count: 1, password: '' }), /password/);

  const auth = fakeAuth();
  auth.createUser = async () => {
    throw Object.assign(new Error('email taken'), { code: 'auth/email-already-exists' });
  };
  const db = fakeFirestore();
  await assert.rejects(seedPool(seedDeps(db, auth), { count: 1, password: 'pw' }), /email taken/);
  assert.equal([...db.docs.keys()].filter((p) => p.startsWith('employees/')).length, 0);
});

test('teardownPool removes the pool and its run residue, and nothing else', async () => {
  const db = fakeFirestore();
  const auth = fakeAuth();
  plantRealData(db, auth);
  const realDocs = structuredClone([...db.docs.entries()]);
  const realUsers = structuredClone([...auth.users.entries()]);

  await seedPool(seedDeps(db, auth), { count: 9, password: 'pw-for-test' });
  for (let i = 0; i < 7; i++) plantRunResidue(db, i, `loanOf${i}`);
  for (let i = 0; i < 5; i++) plantStage5Row(db, i);

  // pageSize 2 forces every query through several pages
  const result = await teardownPool(tearDeps(db, auth), { pageSize: 2 });

  assert.deepEqual(result, {
    loans: 7,
    loanDetails: 14,
    reviewQueue: 7,
    reviewQueueStage5: 5,
    auditLog: 14,
    employees: 9,
    employers: 9,
    authUsers: 9,
  });
  assert.deepEqual([...db.docs.entries()], realDocs);
  assert.deepEqual([...auth.users.entries()], realUsers);
});

test('teardownPool on an empty project is a no-op, and a second teardown deletes nothing', async () => {
  const db = fakeFirestore();
  const auth = fakeAuth();
  const zero = { loans: 0, loanDetails: 0, reviewQueue: 0, reviewQueueStage5: 0, auditLog: 0, employees: 0, employers: 0, authUsers: 0 };
  assert.deepEqual(await teardownPool(tearDeps(db, auth)), zero);

  await seedPool(seedDeps(db, auth), { count: 3, password: 'pw-for-test' });
  await teardownPool(tearDeps(db, auth));
  assert.deepEqual(await teardownPool(tearDeps(db, auth)), zero);
  assert.equal(db.docs.size, 0);
  assert.equal(auth.users.size, 0);
});

test('teardownPool stops — deleting nothing more — if a query ever hands it a row that is not load-test data', async () => {
  const db = fakeFirestore();
  const auth = fakeAuth();
  plantRealData(db, auth);
  await seedPool(seedDeps(db, auth), { count: 2, password: 'pw-for-test' });

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

test('teardownPool removes Stage 5 review_queue rows of the pool — which no loan id points at — and only those', async () => {
  const db = fakeFirestore();
  const auth = fakeAuth();
  plantRealData(db, auth);
  const realDocs = structuredClone([...db.docs.entries()]);
  await seedPool(seedDeps(db, auth), { count: 3, password: 'pw-for-test' });

  // A setup-B run: the loan and, separately, the row Stage 5 wrote for the same request.
  plantRunResidue(db, 0, 'loanOf0');
  db.docs.delete('review_queue/rq-loanOf0'); // requestLoan writes its own row only when the inline ML gate is down
  for (const index of [0, 1, 2]) plantStage5Row(db, index);
  // nothing links the two: the Stage 5 row's loanId is not the loan's id
  assert.notEqual(db.docs.get('review_queue/stage5-0').loanId, 'loanOf0');

  const result = await teardownPool(tearDeps(db, auth));

  assert.equal(result.reviewQueue, 0);
  assert.equal(result.reviewQueueStage5, 3);
  assert.deepEqual(
    [...db.docs.keys()].filter((path) => path.startsWith('review_queue/')).sort(),
    ['review_queue/realReview', 'review_queue/realStage5a', 'review_queue/realStage5b', 'review_queue/realStage5c']
  );
  assert.deepEqual([...db.docs.entries()], realDocs);
});

test('teardownPool stops on a review_queue row whose RFC only LOOKS like the pool', async () => {
  for (const applicantRfc of ['LTXX900101AB1', 'LTXXA', 'LTXX600101L00X', 'LTXX601301L00', 'LTXX600100L00']) {
    const db = fakeFirestore();
    const auth = fakeAuth();
    await seedPool(seedDeps(db, auth), { count: 2, password: 'pw-for-test' });
    db.docs.set('review_queue/notOurs', { loanId: 'uw-9-zzzzzz', applicantRfc });
    plantStage5Row(db, 1); // sorts after "notOurs"? irrelevant: the page is checked whole before any delete

    await assert.rejects(teardownPool(tearDeps(db, auth)), NotLoadTestData, applicantRfc);
    assert.ok(db.docs.has('review_queue/notOurs'), applicantRfc);
    assert.ok(db.docs.has('review_queue/stage5-1'), `${applicantRfc}: nothing on the page was deleted`);
    // it stopped: the pool that comes later in the teardown is still there
    assert.ok(db.docs.has(`employees/${employeeUid(0)}`));
    assert.equal(auth.users.size, 2);
  }
});

test('teardownPool fails — it does not report success — when Auth refuses some deletions', async () => {
  const db = fakeFirestore();
  const auth = fakeAuth();
  await seedPool(seedDeps(db, auth), { count: 5, password: 'pw-for-test' });

  const realDelete = auth.deleteUsers;
  auth.deleteUsers = async (uids) => {
    await realDelete(uids.slice(2));
    return {
      successCount: uids.length - 2,
      failureCount: 2,
      errors: [{ index: 0, error: { message: 'QUOTA_EXCEEDED' } }],
    };
  };
  const lines = [];
  const failed = await teardownPool({ ...tearDeps(db, auth), log: (line) => lines.push(line) }).then(
    () => null,
    (err) => err
  );

  assert.ok(failed instanceof TeardownIncomplete, 'a partial Auth teardown must reject');
  assert.match(failed.message, /2 of 5 pool accounts were NOT deleted/);
  assert.equal(failed.result.authUsers, 3);
  assert.equal(failed.result.employees, 5); // the Firestore side did finish
  assert.equal(auth.users.size, 2);
  assert.ok(lines.some((line) => line.includes('QUOTA_EXCEEDED')));

  // re-running finishes the job
  auth.deleteUsers = realDelete;
  const second = await teardownPool(tearDeps(db, auth));
  assert.equal(second.authUsers, 2);
  assert.equal(auth.users.size, 0);
});

test('teardownPool pauses between Auth batches when asked to (deleteUsers is about 1 call/s)', async () => {
  const db = fakeFirestore();
  const auth = fakeAuth();
  await seedPool(seedDeps(db, auth), { count: 2100, password: 'pw-for-test' });
  const callTimes = [];
  const realDelete = auth.deleteUsers;
  auth.deleteUsers = async (uids) => {
    callTimes.push(Date.now());
    return realDelete(uids);
  };
  await teardownPool(tearDeps(db, auth), { authBatchPauseMs: 40 });
  assert.equal(callTimes.length, 3); // 1000 + 1000 + 100
  assert.ok(callTimes[1] - callTimes[0] >= 35 && callTimes[2] - callTimes[1] >= 35, JSON.stringify(callTimes));
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
  const seed = describePlan({ count: 120, dryRun: true, teardown: false }, { mode: 'project', projectId: 'vida-staging' });
  assert.ok(seed.some((l) => l.includes('DRY RUN')));
  assert.ok(seed.some((l) => l.includes('vida-staging')));
  assert.ok(seed.some((l) => l.includes('loadtest-emp-000000 … loadtest-emp-000119')));
  assert.ok(!seed.join('\n').includes('pw-for-test'));

  const teardown = describePlan({ count: 120, dryRun: false, teardown: true }, { mode: 'emulator', projectId: 'demo-vida-load' }).join('\n');
  for (const scope of [
    'auth users',
    'employees/*',
    'employers/*',
    'loans/*',
    'review_queue/*',
    'applicantRfc is a pool RFC',
    'audit_log/*',
    'rl:loan:<uid>',
    'employer-a:LTE',
    'incident_log',
  ]) {
    assert.ok(teardown.includes(scope), scope);
  }
});

// ── Growing the pool while loans are open ───────────────────────────────────
// The assignment used to be `index % employerCount` with employerCount derived
// from --count: seeding 200 and then 450 moved 4 employers' worth of members
// onto 9, under loans that still named the old employer.

function employerOf(db, index) {
  return db.docs.get(`employees/${employeeUid(index)}`).employerId;
}

test('re-seeding with a larger --count moves no existing member to another employer', async () => {
  for (const [small, large] of [
    [200, 450],
    [137, 12600],
    [2499, 2501], // across a block boundary: employers are appended, nobody moves
    [12500, 20000],
  ]) {
    const db = fakeFirestore();
    const auth = fakeAuth();
    await seedPool(seedDeps(db, auth), { count: small, password: 'pw-for-test' });
    const before = Array.from({ length: small }, (_, i) => employerOf(db, i));
    const slotsBefore = new Map([...db.docs].filter(([path]) => path.startsWith('employers/')).map(([path, doc]) => [path, doc.maxActiveSlots]));

    await seedPool(seedDeps(db, auth), { count: large, password: 'pw-for-test' });

    for (let i = 0; i < small; i++) assert.equal(employerOf(db, i), before[i], `member ${i} moved when the pool grew ${small} → ${large}`);
    // every employer's cap is exactly its member count, and no cap went down
    const members = new Map();
    for (let i = 0; i < large; i++) members.set(employerOf(db, i), (members.get(employerOf(db, i)) ?? 0) + 1);
    for (const [id, n] of members) {
      const cap = db.docs.get(`employers/${id}`).maxActiveSlots;
      assert.equal(cap, n, `${id} cap after growing to ${large}`);
      assert.ok(cap >= (slotsBefore.get(`employers/${id}`) ?? 0), `${id} cap shrank`);
    }
  }
});

test('re-seeding with a SMALLER --count never lowers an employer below the loans it may already hold', async () => {
  const db = fakeFirestore();
  const auth = fakeAuth();
  await seedPool(seedDeps(db, auth), { count: 450, password: 'pw-for-test' });
  assert.equal(db.docs.get(`employers/${employerId(0)}`).maxActiveSlots, 9);

  await seedPool(seedDeps(db, auth), { count: 100, password: 'pw-for-test' });

  // members 100..449 still exist (a seed deletes nothing) and still belong where they did
  assert.equal(auth.users.size, 450);
  assert.equal(employerOf(db, 449), employerId(49));
  for (let j = 0; j < 50; j++) assert.equal(db.docs.get(`employers/${employerId(j)}`).maxActiveSlots, 9, `employer ${j}`);
});
