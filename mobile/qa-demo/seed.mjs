/**
 * Seeds the local Firebase emulators with one QA borrower and three loans in
 * distinct states, so every mobile screen has something real to render.
 * Plain fetch against the emulators' REST APIs — no dependencies, and it
 * refuses to run unless it is talking to a local emulator (the URL is
 * hardcoded to 127.0.0.1 and the project id to the offline demo- namespace).
 *
 *   node seed.mjs        # after `firebase emulators:start --project demo-funpay`
 *
 * Prints the demo credentials when done.
 */
const HOST = '127.0.0.1';
const PROJECT = 'demo-funpay';
const AUTH = `http://${HOST}:9099/identitytoolkit.googleapis.com/v1`;
const FIRESTORE = `http://${HOST}:8080/v1/projects/${PROJECT}/databases/(default)/documents`;

const EMAIL = 'maria.qa@demo.funpay.mx';
const PASSWORD = 'demo-funpay-qa';

async function call(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      // Any bearer works against emulators and marks the write as admin
      // (bypasses rules for seeding). Meaningless outside an emulator.
      Authorization: 'Bearer owner',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function tsDaysAgo(days) {
  return new Date(Date.now() - days * 86400_000).toISOString();
}

function loanFields({ amount, total, status, ref, daysAgo }) {
  return {
    fields: {
      employeeId: { stringValue: uid },
      status: { stringValue: status },
      amount: { integerValue: String(amount) },
      principalAmount: { integerValue: String(amount) },
      totalRepaymentAmount: { integerValue: String(total) },
      loanRef: { stringValue: ref },
      createdAt: { timestampValue: tsDaysAgo(daysAgo) },
    },
  };
}

// 1. Demo borrower in the Auth emulator (signUp is idempotent enough for a
//    demo: a second run errors EMAIL_EXISTS, which we treat as fine).
let uid;
try {
  const signUp = await call(`${AUTH}/accounts:signUp?key=demo`, 'POST', {
    email: EMAIL,
    password: PASSWORD,
    returnSecureToken: true,
  });
  uid = signUp.localId;
} catch (err) {
  if (!String(err).includes('EMAIL_EXISTS')) throw err;
  const signIn = await call(`${AUTH}/accounts:signInWithPassword?key=demo`, 'POST', {
    email: EMAIL,
    password: PASSWORD,
    returnSecureToken: true,
  });
  uid = signIn.localId;
}

// 2. Employee doc: verified, with a credit line — what HomeScreen renders.
await call(`${FIRESTORE}/employees/${uid}`, 'PATCH', {
  fields: {
    name: { stringValue: 'María Demo' },
    kycStatus: { stringValue: 'approved' },
    creditLimit: { integerValue: '8000' },
    availableCredit: { integerValue: '5800' },
    employerCode: { stringValue: 'QADEMO' },
    bankClabe: { stringValue: '002010077777777771' },
  },
});

// 3. Three loans across the status vocabulary: one payable, one repaid, one
//    still in review — exercises the chips, the sort, and the Pagar button.
await call(
  `${FIRESTORE}/loans/qa-loan-active`,
  'PATCH',
  loanFields({ amount: 2000, total: 2200, status: 'active', ref: 'FP-QA-0001', daysAgo: 20 })
);
await call(
  `${FIRESTORE}/loans/qa-loan-repaid`,
  'PATCH',
  loanFields({ amount: 1500, total: 1650, status: 'repaid', ref: 'FP-QA-0002', daysAgo: 90 })
);
await call(
  `${FIRESTORE}/loans/qa-loan-review`,
  'PATCH',
  loanFields({ amount: 1000, total: 1100, status: 'under_review', ref: 'FP-QA-0003', daysAgo: 2 })
);

console.log('Seeded demo data into the emulators.');
console.log(`  email:    ${EMAIL}`);
console.log(`  password: ${PASSWORD}`);
console.log(`  uid:      ${uid}`);
