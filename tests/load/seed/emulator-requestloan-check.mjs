/**
 * The one claim the unit tests cannot make: that the REAL requestLoan accepts a
 * seeded pool member. Runs the callable in the Functions emulator against a
 * freshly seeded pool, as the k6 script would (sign in → POST {data}).
 *
 * Needs a local Redis (requestLoan's rate limiter fails closed without one) and
 * a built functions/lib. See docs/runbooks/scaling.md § Load test, step 2:
 *
 *   redis-server --port 6390 --save '' &
 *   (cd functions && npm ci && npm run build)
 *   REDIS_URL=redis://127.0.0.1:6390 \
 *   TARGET_URL=http://127.0.0.1:5001/demo-vida-load/us-central1 \
 *     firebase emulators:exec --only functions,firestore,auth --project demo-vida-load \
 *       "node tests/load/seed/emulator-requestloan-check.mjs"
 *
 * With no ML_SERVICE_URL / UNDERWRITING_SERVICE_URL in the environment no
 * provider is reachable, so the expected answer is `under_review` (the inline
 * ML gate fails closed into manual review).
 *
 * Refuses to start unless both the data target and TARGET_URL are the emulator,
 * and refuses when UNDERWRITING_SERVICE_URL or ML_SERVICE_URL is set — in the
 * shell or in a functions/.env* file — because the emulated functions inherit
 * both and would call the real service.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import { resolveTarget } from '../target.js';
import { EMULATOR_PASSWORD, functionsProviderLeaks, resolveSeedTarget } from './guard.mjs';
import {
  ACCEPTED_INITIAL_STATUSES,
  appCheckPlan,
  buildEmployeeDoc,
  buildPoolApplication,
  employeeUid,
  poolSignInUrl,
} from './pool.js';

const seedTarget = resolveSeedTarget({ project: null }, process.env);
const callTarget = resolveTarget(process.env);
if (seedTarget.mode !== 'emulator' || callTarget.label !== 'emulator') {
  console.error('Refusing: this check creates loans and only ever runs against the emulator.');
  process.exit(2);
}

// The data target being the emulator is not enough: the emulated FUNCTIONS get
// this shell's environment and functions/.env*.
const FUNCTIONS_DIR = new URL('../../../functions/', import.meta.url);
const envFiles = readdirSync(FUNCTIONS_DIR)
  .filter((name) => name.startsWith('.env') && !name.endsWith('.example'))
  .map((name) => ({ name: `functions/${name}`, text: readFileSync(new URL(name, FUNCTIONS_DIR), 'utf8') }));
const leaks = functionsProviderLeaks(process.env, envFiles);
if (leaks.length > 0) {
  console.error(
    'Refusing: the emulated requestLoan would call a real service with synthetic applicants.\n' +
      leaks.map((line) => `  - ${line}`).join('\n') +
      '\nUnset them (and INTERNAL_SECRET) for this command, e.g. `env -u UNDERWRITING_SERVICE_URL -u ML_SERVICE_URL …`.'
  );
  process.exit(2);
}

const COUNT = 6;
const CLI = fileURLToPath(new URL('./seed-load-pool.mjs', import.meta.url));
const cli = (...args) => execFileSync(process.execPath, [CLI, '--count', String(COUNT), ...args], { encoding: 'utf8' });
const db = getFirestore(initializeApp({ projectId: seedTarget.projectId }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(ok, label) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

async function requestLoan(index) {
  const app = buildPoolApplication(index);
  const signIn = await fetch(poolSignInUrl(process.env, callTarget.label), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: app.email, password: EMULATOR_PASSWORD, returnSecureToken: true }),
  });
  const { idToken } = await signIn.json();
  const res = await fetch(`${callTarget.url}/requestLoan`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
      'X-Firebase-AppCheck': appCheckPlan({}, callTarget.label).token,
    },
    body: JSON.stringify({ data: app.payload }),
  });
  return { app, status: res.status, body: await res.json().catch(() => null) };
}

cli();
// Let onEmployeeDocCreated (claim + derived credit line) finish for every member.
await sleep(Number(process.env.TRIGGER_SETTLE_MS ?? 8000));

for (const index of [0, 5]) {
  const stored = (await db.doc(`employees/${employeeUid(index)}`).get()).data();
  check(
    stored.availableCredit === buildEmployeeDoc(index, 1).availableCredit,
    `member ${index}: the credit-line trigger left the seeded value in place (${stored.availableCredit})`
  );

  const first = await requestLoan(index);
  const result = first.body?.result;
  console.log(`      requestLoan(${first.app.userId}, ${first.app.payload.amount}) → HTTP ${first.status} ${JSON.stringify(first.body)}`);
  check(first.status === 200 && typeof result?.loanId === 'string', `member ${index}: requestLoan accepted the request`);
  check(ACCEPTED_INITIAL_STATUSES.includes(result?.status), `member ${index}: status "${result?.status}" is an accepted one`);

  if (result?.loanId) {
    const loan = (await db.doc(`loans/${result.loanId}`).get()).data();
    check(loan?.employeeId === first.app.userId && loan?.amount === first.app.payload.amount, `member ${index}: loan document written for that uid and amount`);
    const after = (await db.doc(`employees/${employeeUid(index)}`).get()).data();
    const held = result.status === 'rejected' ? 0 : first.app.payload.amount;
    check(after.availableCredit === stored.availableCredit - held, `member ${index}: credit held (${stored.availableCredit} → ${after.availableCredit})`);
  }
}

// The reason the pool is one uid per iteration, observed rather than asserted:
const second = await requestLoan(0);
console.log(`      second request, same uid → HTTP ${second.status} ${JSON.stringify(second.body)}`);
// FAILED_PRECONDITION = the open-loan guard. RESOURCE_EXHAUSTED = the 3/day
// limiter, which is what answers first when this Redis already counted the uid
// in an earlier run today (teardown cannot reset Redis).
const refusal = second.body?.error?.status;
check(
  second.status !== 200 && (refusal === 'FAILED_PRECONDITION' || refusal === 'RESOURCE_EXHAUSTED'),
  `a second request from the same uid is refused (${refusal})`
);

const torn = JSON.parse(/TEARDOWN DONE (\{.*\})/.exec(cli('--teardown'))[1]);
console.log(`      teardown ${JSON.stringify(torn)}`);
check(torn.loans === 2 && torn.employees === COUNT && torn.authUsers === COUNT, 'teardown removed both loans and the pool');
const leftovers = await db.collection('loans').get();
check(leftovers.empty, 'no loan documents remain');

console.log(failures === 0 ? '\nREQUESTLOAN CHECK OK' : `\nREQUESTLOAN CHECK FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
