/**
 * Rehearsal of the load-test seed against the Firestore + Auth EMULATORS — a
 * real Firestore query engine and a real Auth REST surface, not a test double.
 *
 *   firebase emulators:exec --only firestore,auth --project demo-vida-load \
 *     "node tests/load/seed/emulator-rehearsal.mjs"
 *
 * Proves, in order:
 *   1. --dry-run writes nothing;
 *   2. a seed creates exactly the pool (documents, accounts, claims);
 *   3. a pool member can sign in the way the k6 script does, and the ID token
 *      carries role=employee;
 *   4. a second seed is idempotent and restores a spent credit line;
 *   5. teardown removes the pool and what a run left behind, and leaves every
 *      non-load-test document and account exactly as it was;
 *   6. a second teardown deletes nothing.
 *
 * Refuses to start unless guard.mjs resolves the target to the emulator.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

import { EMULATOR_PASSWORD, resolveSeedTarget } from './guard.mjs';
import { buildEmployeeDoc, employeeEmail, employeeUid, employerCountFor, signInUrl } from './pool.js';

const target = resolveSeedTarget({ project: null }, process.env);
if (target.mode !== 'emulator') {
  console.error('Refusing: this rehearsal seeds and deletes data and only ever runs against the emulator.');
  process.exit(2);
}

if (process.env.FUNCTIONS_EMULATOR_HOST) {
  // With triggers live, onEmployeeDocCreated / onEmployerDocCreated rewrite the
  // planted "real" documents and the byte-for-byte comparison below means nothing.
  console.error('Refusing: run with `--only firestore,auth`. For the functions emulator use emulator-requestloan-check.mjs.');
  process.exit(2);
}

const COUNT = 450; // crosses a 400-write batch boundary
const CLI = fileURLToPath(new URL('./seed-load-pool.mjs', import.meta.url));
const cli = (...args) => execFileSync(process.execPath, [CLI, '--count', String(COUNT), ...args], { encoding: 'utf8' });

const app = initializeApp({ projectId: target.projectId });
const db = getFirestore(app);
const auth = getAuth(app);

let failures = 0;
function check(ok, label) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const COLLECTIONS = ['employees', 'employers', 'loans', 'review_queue', 'audit_log', 'config'];
async function dump() {
  const out = {};
  for (const name of COLLECTIONS) {
    for (const doc of (await db.collection(name).get()).docs) out[doc.ref.path] = doc.data();
  }
  for (const doc of (await db.collectionGroup('underwritingDetail').get()).docs) out[doc.ref.path] = doc.data();
  return out;
}
async function listUids() {
  const uids = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    uids.push(...page.users.map((u) => u.uid));
    pageToken = page.pageToken;
  } while (pageToken);
  return uids.sort();
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── Data that is NOT load-test data, and must survive everything below ──────
await db.doc('employees/realBorrowerUid').set({ name: 'Ana Real', employerId: 'realEmployerUid', availableCredit: 1200 });
await db.doc('employees/loadtester-not-ours').set({ name: 'similar prefix' });
await db.doc('employers/realEmployerUid').set({ companyName: 'Cliente Real SA', status: 'active', maxActiveSlots: 10 });
await db.doc('loans/realLoan').set({ employeeId: 'realBorrowerUid', employerId: 'realEmployerUid', status: 'active' });
await db.doc('loans/realLoan/underwritingDetail/detail').set({ decision: 'approved' });
await db.doc('review_queue/realReview').set({ loanId: 'realLoan' });
await db.doc('audit_log/realAudit').set({ actorUid: 'realBorrowerUid', action: 'loan.requested' });
await db.doc('config/loan').set({ feeRate: 0.3 });
await auth.createUser({ uid: 'realBorrowerUid', email: 'ana@example.com', password: 'not-the-pool-password' });
await auth.createUser({ uid: 'loadtest-emp-999999', email: 'someone@example.com' }); // prefixed uid, foreign email

const realDocs = await dump();
const realUids = await listUids();

// 1 ── dry run
const dry = cli('--dry-run');
check(dry.includes('DRY RUN') && same(await dump(), realDocs) && same(await listUids(), realUids), '--dry-run wrote nothing');

// 2 ── seed
const seeded = cli();
check(seeded.includes(`SEED DONE {"employers":${employerCountFor(COUNT)},"employees":${COUNT}}`), 'seed reported the full pool');
const employees = await db.collection('employees').where('isLoadTest', '==', true).get();
const employers = await db.collection('employers').where('isLoadTest', '==', true).get();
check(employees.size === COUNT, `${COUNT} employee documents (got ${employees.size})`);
check(employers.size === employerCountFor(COUNT), `${employerCountFor(COUNT)} employer documents (got ${employers.size})`);
check((await listUids()).length === realUids.length + COUNT, `${COUNT} auth accounts added`);
const last = (await db.doc(`employees/${employeeUid(COUNT - 1)}`).get()).data();
const { createdAt, ...lastFields } = last;
check(same(lastFields, buildEmployeeDoc(COUNT - 1, employerCountFor(COUNT))) && Boolean(createdAt), 'stored employee equals buildEmployeeDoc()');
const slots = employers.docs.reduce((sum, d) => sum + d.data().maxActiveSlots, 0);
check(slots === COUNT, `employer slots add up to the pool (${slots})`);

// 3 ── sign in exactly as the k6 script does
const signIn = await fetch(signInUrl(process.env), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: employeeEmail(COUNT - 1), password: EMULATOR_PASSWORD, returnSecureToken: true }),
});
const signInBody = await signIn.json();
const claims = signIn.ok ? JSON.parse(Buffer.from(signInBody.idToken.split('.')[1], 'base64url').toString()) : {};
check(signIn.status === 200, `pool member signs in with the pool password (HTTP ${signIn.status})`);
check(claims.user_id === employeeUid(COUNT - 1) && claims.role === 'employee', 'ID token is that uid with role=employee');

// 4 ── a run happens, then a re-seed
for (const index of [0, 1, 401]) {
  const loanId = `rehearsalLoan${index}`;
  await db.doc(`loans/${loanId}`).set({ employeeId: employeeUid(index), employerId: last.employerId, status: 'under_review' });
  await db.doc(`loans/${loanId}/underwritingDetail/detail`).set({ decision: 'pending_review' });
  await db.doc(`loans/${loanId}/underwritingDetail/inlineMl`).set({ source: 'inline_ml_gate' });
  await db.collection('review_queue').add({ loanId, reason: 'ml_gate_unavailable' });
  await db.collection('audit_log').add({ actorUid: employeeUid(index), action: 'loan.requested', targetId: loanId });
  await db.doc(`employees/${employeeUid(index)}`).update({ availableCredit: 0 });
}
cli();
const reseeded = await db.collection('employees').where('isLoadTest', '==', true).get();
check(reseeded.size === COUNT && (await listUids()).length === realUids.length + COUNT, 're-seed added nothing');
const restored = (await db.doc(`employees/${employeeUid(401)}`).get()).data().availableCredit;
check(restored === buildEmployeeDoc(401, employerCountFor(COUNT)).availableCredit, 're-seed restored the spent credit line');

// 5 ── teardown
const torn = cli('--teardown');
check(/TEARDOWN DONE \{"loans":3,"loanDetails":6,"reviewQueue":3,"auditLog":3,"employees":450,"employers":9,"authUsers":450\}/.test(torn), 'teardown reported what it removed');
check(same(await dump(), realDocs), 'every non-load-test document is byte-for-byte unchanged');
check(same(await listUids(), realUids), 'every non-load-test account is still there (including the foreign-email one)');

// 6 ── teardown again
const again = cli('--teardown');
check(/TEARDOWN DONE \{"loans":0,"loanDetails":0,"reviewQueue":0,"auditLog":0,"employees":0,"employers":0,"authUsers":0\}/.test(again), 'second teardown is a no-op');

console.log(failures === 0 ? '\nREHEARSAL OK' : `\nREHEARSAL FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
