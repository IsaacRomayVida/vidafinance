/**
 * Seed and teardown of the load-test pool, written against an injected
 * Firestore (`db`) and Auth (`auth`) so that tests/load/seed/seed-lib.test.mjs
 * can run them on an in-memory double and the CLI on the Admin SDK.
 *
 * Nothing here decides WHERE to write — that is guard.mjs, and it has already
 * run by the time these are called.
 */

import {
  EMAIL_DOMAIN,
  EMPLOYEE_UID_PREFIX,
  EMPLOYER_ID_PREFIX,
  POOL_RFC_PREFIX,
  buildEmployeeDoc,
  buildEmployerDoc,
  employeeEmail,
  employerCountFor,
  employeeUid,
  employerId,
  isLoadTestEmail,
  isLoadTestId,
  isPoolRfc,
  slotsFor,
} from './pool.js';

const WRITE_BATCH = 400; // Firestore allows 500 writes per batch
const AUTH_DELETE_BATCH = 1000; // deleteUsers limit
const IN_QUERY_LIMIT = 30; // Firestore `in` limit
/** Sorts after every character an id of ours can contain. */
const RANGE_END = '';

/** Thrown when teardown meets something it did not create. It stops; it never "skips and continues" past a delete. */
export class NotLoadTestData extends Error {}

/**
 * Thrown at the END of a teardown that could not delete everything (Auth
 * refused some accounts). Everything else has been removed; `result` says what.
 * Re-running the teardown is safe and picks up what is left.
 */
export class TeardownIncomplete extends Error {
  constructor(message, result) {
    super(message);
    this.result = result;
  }
}

function assertLoadTestId(id, what) {
  if (!isLoadTestId(id)) {
    throw new NotLoadTestData(`Teardown stopped: ${what} "${id}" is not load-test data (no "loadtest-" prefix).`);
  }
  return id;
}

async function inParallel(total, concurrency, worker) {
  let next = 0;
  const lane = async () => {
    while (next < total) {
      const index = next++;
      await worker(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, lane));
}

/** What a run would do, without touching anything. Printed by --dry-run. */
export function describePlan(opts, target) {
  const { count } = opts;
  const employers = employerCountFor(count);
  const lines = [
    `mode:      ${target.mode}${opts.dryRun ? ' (DRY RUN — nothing is read or written)' : ''}`,
    `project:   ${target.projectId}`,
    `action:    ${opts.teardown ? 'TEARDOWN' : 'SEED'}`,
  ];
  if (opts.teardown) {
    lines.push(
      'would delete, and only these:',
      `  auth users   uid starts "${EMPLOYEE_UID_PREFIX}" AND email ends "@${EMAIL_DOMAIN}"`,
      `  employees/*  document id starts "${EMPLOYEE_UID_PREFIX}"`,
      `  employers/*  document id starts "${EMPLOYER_ID_PREFIX}"`,
      `  loans/*      employeeId starts "${EMPLOYEE_UID_PREFIX}" (with underwritingDetail/*)`,
      '  review_queue/*  loanId of one of those loans (the rows requestLoan writes)',
      `  review_queue/*  applicantRfc is a pool RFC, "${POOL_RFC_PREFIX}YYMMDDLnn" (the rows Stage 5 of the`,
      '                  underwriting-service writes; they carry no loan id, and their applicantName is not usable)',
      `  audit_log/*  actorUid starts "${EMPLOYEE_UID_PREFIX}"`,
      'not touched: Redis — rate-limit keys rl:loan:<uid> (they expire 24 h after first use) and, after a',
      '             full-pipeline run, the underwriting-service cache (employer-a:LTE…, 24 h);',
      '             ml_decisions, incident_log, metamap_shadow_log, and any provider-side record.'
    );
    return lines;
  }
  lines.push(
    `employers: ${employers}  (${employerId(0)} … ${employerId(employers - 1)})`,
    `employees: ${count}  (${employeeUid(0)} … ${employeeUid(count - 1)})`,
    `           emails ${employeeEmail(0)} …, password from LOAD_TEST_PASSWORD (not shown)`,
    `sample employers/${employerId(0)}:`,
    `  ${JSON.stringify(buildEmployerDoc(0, slotsFor(0, count)))}`,
    `sample employees/${employeeUid(0)}:`,
    `  ${JSON.stringify(buildEmployeeDoc(0))}`,
    `k6:        --env POOL_SIZE=${count}`
  );
  return lines;
}

async function ensureAuthUser(auth, index, password) {
  const uid = employeeUid(index);
  const properties = { email: employeeEmail(index), password, emailVerified: true, disabled: false };
  try {
    await auth.createUser({ uid, ...properties });
  } catch (err) {
    if (err?.code !== 'auth/uid-already-exists') throw err;
    await auth.updateUser(uid, properties);
  }
  // Same claim onEmployeeDocCreated sets; written here so the pool works on a
  // target whose Firestore triggers are not deployed (and on the emulator).
  await auth.setCustomUserClaims(uid, { role: 'employee' });
}

/**
 * Idempotent: every id — and every member's employer — is a pure function of
 * its index, employers are merged, employees are overwritten (which also
 * restores the credit line a previous run spent).
 *
 * Growing the pool while loans are open is safe: a larger --count appends
 * members and, past each 2,500, employers; it moves nobody (pool.js
 * employerIndexFor) and only ever raises an employer's `maxActiveSlots`.
 * A SMALLER --count deletes nothing — the members above it stay, with their
 * accounts — and leaves `maxActiveSlots` where it was, so the loans those
 * members hold still fit under the cap. Only teardown removes anything.
 *
 * @param {object} deps
 * @param {object} deps.db    Firestore (Admin SDK shape)
 * @param {object} deps.auth  Auth (Admin SDK shape)
 * @param {() => unknown} deps.serverTimestamp
 * @param {(line: string) => void} [deps.log]
 * @param {{ count: number, password: string, concurrency?: number }} opts
 */
export async function seedPool({ db, auth, serverTimestamp, log = () => {} }, opts) {
  const { count, password, concurrency = 20 } = opts;
  if (!password) throw new Error('seedPool needs a password');
  // Derived, never passed in: an employer count chosen by the caller is what
  // used to reshuffle the pool.
  const employers = employerCountFor(count);

  for (let j = 0; j < employers; j++) {
    const ref = db.collection('employers').doc(employerId(j));
    const doc = { ...buildEmployerDoc(j, slotsFor(j, count)), seededAt: serverTimestamp() };
    // Two writes for a NEW employer, on purpose. onEmployerDocCreated grants an
    // employer_admin claim to the uid of any employer CREATED in an approved
    // status; these employers have no account, so that trigger would throw once
    // per employer ("Cannot verify existing privileges …"). Created as
    // pending_verification the trigger withholds the claim quietly; nothing
    // listens for the update. An employer that already exists is written once,
    // so a re-seed never takes an active employer out of `active`.
    const existing = await ref.get();
    if (!existing.exists) {
      await ref.set({ ...doc, status: 'pending_verification' }, { merge: true });
      await ref.set({ status: doc.status }, { merge: true });
    } else {
      // Never lower the cap: after a re-seed with a smaller --count the members
      // above it still exist and may hold open loans against this employer.
      const current = existing.data()?.maxActiveSlots;
      if (Number.isFinite(current) && current > doc.maxActiveSlots) doc.maxActiveSlots = current;
      await ref.set(doc, { merge: true });
    }
  }
  log(`employers written: ${employers}`);

  // Accounts before documents: on a target with functions deployed,
  // onEmployeeDocCreated sets a claim on the uid and needs the account to exist.
  let done = 0;
  await inParallel(count, concurrency, async (index) => {
    await ensureAuthUser(auth, index, password);
    if (++done % 1000 === 0) log(`auth users ensured: ${done}/${count}`);
  });
  log(`auth users ensured: ${count}`);

  for (let start = 0; start < count; start += WRITE_BATCH) {
    const batch = db.batch();
    const end = Math.min(count, start + WRITE_BATCH);
    for (let index = start; index < end; index++) {
      batch.set(db.collection('employees').doc(employeeUid(index)), {
        ...buildEmployeeDoc(index),
        createdAt: serverTimestamp(),
      });
    }
    await batch.commit();
  }
  log(`employees written: ${count}`);

  return { employers, employees: count };
}

/**
 * Deletes one page at a time until the query comes back empty. `visit` returns
 * the refs to delete for a page (after checking each row is ours).
 */
async function drain(db, makeQuery, pageSize, visit) {
  let deleted = 0;
  let previousFirstId = null;
  for (;;) {
    const snap = await makeQuery().limit(pageSize).get();
    if (snap.empty) return deleted;
    if (snap.docs[0].id === previousFirstId) {
      throw new Error(`Teardown made no progress at ${snap.docs[0].ref.path}; stopping rather than looping.`);
    }
    previousFirstId = snap.docs[0].id;

    const refs = await visit(snap.docs);
    for (let i = 0; i < refs.length; i += WRITE_BATCH) {
      const batch = db.batch();
      for (const ref of refs.slice(i, i + WRITE_BATCH)) batch.delete(ref);
      await batch.commit();
    }
    deleted += snap.docs.length;
  }
}

/**
 * Removes the pool and what a run left behind. Finds data by prefix, then
 * re-checks every single row before deleting it; a row that is not ours stops
 * the teardown with NotLoadTestData.
 *
 * @param {object} deps
 * @param {object} deps.db
 * @param {object} deps.auth
 * @param {unknown} deps.documentId  FieldPath.documentId()
 * @param {(line: string) => void} [deps.log]
 * @param {{ pageSize?: number, authBatchPauseMs?: number }} [opts]
 *   authBatchPauseMs: wait between deleteUsers batches. The Identity Platform
 *   batch-delete endpoint allows about one call per second; the CLI passes
 *   1100 off the emulator.
 * @throws {TeardownIncomplete} when Auth reported failed deletions
 */
export async function teardownPool({ db, auth, documentId, log = () => {} }, opts = {}) {
  const pageSize = opts.pageSize ?? 300;
  const idRange = (collection, prefix) => () =>
    db.collection(collection).where(documentId, '>=', prefix).where(documentId, '<', prefix + RANGE_END);
  const fieldRange = (collection, field, prefix) => () =>
    db.collection(collection).where(field, '>=', prefix).where(field, '<', prefix + RANGE_END);

  const result = {
    loans: 0,
    loanDetails: 0,
    reviewQueue: 0,
    reviewQueueStage5: 0,
    auditLog: 0,
    employees: 0,
    employers: 0,
    authUsers: 0,
  };

  result.loans = await drain(db, fieldRange('loans', 'employeeId', EMPLOYEE_UID_PREFIX), pageSize, async (docs) => {
    const refs = [];
    for (const doc of docs) assertLoadTestId(doc.data().employeeId, `loans/${doc.id}.employeeId`);
    for (const doc of docs) {
      const details = await doc.ref.collection('underwritingDetail').get();
      for (const detail of details.docs) refs.push(detail.ref);
      result.loanDetails += details.docs.length;
    }
    const loanIds = docs.map((d) => d.id);
    for (let i = 0; i < loanIds.length; i += IN_QUERY_LIMIT) {
      const queued = await db
        .collection('review_queue')
        .where('loanId', 'in', loanIds.slice(i, i + IN_QUERY_LIMIT))
        .get();
      for (const row of queued.docs) refs.push(row.ref);
      result.reviewQueue += queued.docs.length;
    }
    for (const doc of docs) refs.push(doc.ref);
    return refs;
  });
  log(`loans deleted: ${result.loans} (+${result.loanDetails} underwritingDetail, ${result.reviewQueue} review_queue)`);

  // Full-pipeline runs only. Stage 5 of the underwriting-service writes its own
  // review_queue row per escalated request, and requestLoan sends that service
  // no loan id — the row's `loanId` is the pipeline's correlation id — so the
  // `loanId in [...]` query above can never find it. What the row does carry is
  // the applicant's RFC, and a pool RFC is a shape no real taxpayer has.
  result.reviewQueueStage5 = await drain(
    db,
    fieldRange('review_queue', 'applicantRfc', POOL_RFC_PREFIX),
    pageSize,
    async (docs) =>
      docs.map((doc) => {
        const rfc = doc.data().applicantRfc;
        if (!isPoolRfc(rfc)) {
          throw new NotLoadTestData(`Teardown stopped: review_queue/${doc.id}.applicantRfc "${rfc}" is not a load-test RFC.`);
        }
        return doc.ref;
      })
  );
  log(`review_queue rows deleted by applicantRfc (Stage 5): ${result.reviewQueueStage5}`);

  result.auditLog = await drain(db, fieldRange('audit_log', 'actorUid', EMPLOYEE_UID_PREFIX), pageSize, async (docs) =>
    docs.map((doc) => {
      assertLoadTestId(doc.data().actorUid, `audit_log/${doc.id}.actorUid`);
      return doc.ref;
    })
  );
  log(`audit_log rows deleted: ${result.auditLog}`);

  for (const [key, collection, prefix] of [
    ['employees', 'employees', EMPLOYEE_UID_PREFIX],
    ['employers', 'employers', EMPLOYER_ID_PREFIX],
  ]) {
    result[key] = await drain(db, idRange(collection, prefix), pageSize, async (docs) =>
      docs.map((doc) => {
        assertLoadTestId(doc.id, `${collection}/`);
        if (!doc.id.startsWith(prefix)) throw new NotLoadTestData(`Teardown stopped: ${collection}/${doc.id} is outside "${prefix}".`);
        return doc.ref;
      })
    );
    log(`${collection} deleted: ${result[key]}`);
  }

  // Auth has no prefix query: list everything, keep only accounts that are
  // ours on BOTH uid and email, delete those.
  const uids = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const user of page.users) {
      if (user.uid.startsWith(EMPLOYEE_UID_PREFIX) && isLoadTestEmail(user.email)) uids.push(user.uid);
    }
    pageToken = page.pageToken;
  } while (pageToken);
  let authFailures = 0;
  for (let i = 0; i < uids.length; i += AUTH_DELETE_BATCH) {
    if (i > 0 && opts.authBatchPauseMs) await new Promise((resolve) => setTimeout(resolve, opts.authBatchPauseMs));
    const chunk = uids.slice(i, i + AUTH_DELETE_BATCH);
    const outcome = await auth.deleteUsers(chunk);
    result.authUsers += outcome?.successCount ?? chunk.length;
    if (outcome?.failureCount) {
      authFailures += outcome.failureCount;
      const first = outcome.errors?.[0]?.error?.message;
      log(`auth: ${outcome.failureCount} deletions failed in this batch${first ? ` (first: ${first})` : ''}`);
    }
  }
  log(`auth users deleted: ${result.authUsers}`);

  if (authFailures > 0) {
    // Not "done": pool accounts with a known password are still there.
    throw new TeardownIncomplete(
      `Teardown incomplete: ${authFailures} of ${uids.length} pool accounts were NOT deleted from Auth ` +
        '(deleteUsers is limited to about one call per second). Run the teardown again; it is idempotent.',
      result
    );
  }
  return result;
}
