// node --test tests/load/seed/pool.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { RAMP_STAGES, SMOKE_STAGES } from '../config.js';
import { PRODUCTION_PROJECT_ID, PRODUCTION_PROJECT_NUMBER, PRODUCTION_WEB_API_KEY, productionIdentifiers } from '../target.js';
import { resultsBaseName, stageLatencyLines } from '../helpers/report.js';
import * as pool from './pool.js';

const repo = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const SAMPLE = [0, 1, 4, 5, 7, 8, 9, 49, 50, 2799, 9999, 10000, 12499, 999999];

test('ids are deterministic, prefixed and unique', () => {
  assert.equal(pool.employeeUid(0), 'loadtest-emp-000000');
  assert.equal(pool.employeeUid(2799), 'loadtest-emp-002799');
  assert.equal(pool.employeeEmail(12), 'loadtest-emp-000012@loadtest.invalid');
  assert.equal(pool.employerId(3), 'loadtest-employer-0003');
  assert.equal(pool.employerCode(3), 'LOADTEST-0003');

  const uids = new Set();
  const curps = new Set();
  for (let i = 0; i < 20000; i++) {
    uids.add(pool.employeeUid(i));
    curps.add(pool.curpFor(i));
  }
  assert.equal(uids.size, 20000);
  assert.equal(curps.size, 20000);
  for (const bad of [-1, 1.5, 1000000, NaN, '3']) assert.throws(() => pool.employeeUid(bad), /Pool index/);
});

test('isLoadTestId / isLoadTestEmail accept only the pool', () => {
  assert.ok(pool.isLoadTestId('loadtest-emp-000001'));
  assert.ok(pool.isLoadTestId('loadtest-employer-0001'));
  for (const id of ['', 'loadtest-', 'Loadtest-emp-1', 'xloadtest-emp-1', 'qa-funpay-demo-employer', null, undefined, 7]) {
    assert.equal(pool.isLoadTestId(id), false, String(id));
  }
  assert.ok(pool.isLoadTestEmail('loadtest-emp-000001@loadtest.invalid'));
  for (const email of ['loadtest-emp-000001@gmail.com', 'ana@loadtest.invalid', undefined]) {
    assert.equal(pool.isLoadTestEmail(email), false, String(email));
  }
});

test('an employer code can never collide with a minted one', () => {
  const src = repo('functions/src/index.ts');
  const alphabet = /EMPLOYER_CODE_ALPHABET = '([^']+)'/.exec(src)[1];
  const length = Number(/EMPLOYER_CODE_LENGTH = (\d+)/.exec(src)[1]);
  const code = pool.employerCode(0);
  assert.ok(code.length !== length || [...code].some((c) => !alphabet.includes(c)));
  assert.ok(!alphabet.includes('-') && code.includes('-'));
});

test('every employee document passes every gate requestLoan applies', () => {
  for (const index of SAMPLE) {
    const doc = pool.buildEmployeeDoc(index);

    // identity gate
    assert.equal(doc.metamapStatus, 'verified');
    // credit gates: both finite numbers, and the trigger's own formula
    assert.ok(Number.isFinite(doc.monthlySalary) && Number.isFinite(doc.availableCredit));
    assert.equal(doc.creditLimit, Math.max(Math.min(doc.monthlySalary * 0.3, 5000), 0));
    assert.equal(doc.availableCredit, doc.creditLimit);
    // employer link
    assert.equal(doc.employerId, pool.employerId(pool.employerIndexFor(index)));
    assert.ok(pool.isLoadTestId(doc.employerId));
    // pay frequency is one requestLoan recognises (else it prices on an assumed cadence)
    assert.ok(['weekly', 'biweekly', 'semimonthly', 'monthly'].includes(doc.payFrequency));
    // nothing that can reach a real person
    assert.equal(doc.phone, null);
    assert.ok(doc.email.endsWith('@loadtest.invalid'));
    assert.equal(doc.isLoadTest, true);
    // identifiers: right shape, and never the suffixes the RiskSeal mock fails
    assert.match(doc.curp, /^[A-Z]{4}\d{6}[HM][A-Z]{5}\d{2}$/);
    assert.match(doc.rfc, /^[A-Z]{4}\d{6}[A-Z0-9]{3}$/);
    assert.ok(!/(XXX|YYY)$/.test(doc.rfc));
    assert.match(doc.bankClabe, /^\d{18}$/);
    // no undefined: Firestore rejects it
    for (const [key, value] of Object.entries(doc)) assert.notEqual(value, undefined, key);
  }
});

test('CLABE check digit is valid', () => {
  for (const index of SAMPLE) {
    const clabe = pool.buildEmployeeDoc(index).bankClabe;
    const sum = [...clabe.slice(0, 17)].reduce((acc, d, i) => acc + ((Number(d) * [3, 7, 1][i % 3]) % 10), 0);
    assert.equal(Number(clabe[17]), (10 - (sum % 10)) % 10);
  }
});

test('the amount k6 sends is one requestLoan accepts for that same employee', () => {
  for (let index = 0; index < 5000; index++) {
    const doc = pool.buildEmployeeDoc(index);
    const { payload, userId, email, profile } = pool.buildPoolApplication(index);
    assert.equal(userId, pool.employeeUid(index));
    assert.equal(email, doc.email);
    assert.equal(profile, doc.loadTestProfile);
    assert.equal(payload.termDays, 30);
    assert.equal(payload.amount % 100, 0);
    assert.ok(payload.amount >= 500 && payload.amount <= 5000, `policy bounds @${index}`);
    assert.ok(payload.amount <= doc.availableCredit, `credit line @${index}`);
    assert.ok(payload.amount <= Math.round(doc.monthlySalary * 0.3), `30% of salary @${index}`);
  }
});

test('profile mix is 50 / 30 / 20 and salaries stay in their bands', () => {
  const counts = { good: 0, medium: 0, risky: 0 };
  const bands = { good: [15000, 40000], medium: [8000, 15000], risky: [5000, 10000] };
  for (let i = 0; i < 1000; i++) {
    const profile = pool.profileFor(i);
    counts[profile]++;
    const salary = pool.salaryFor(i);
    assert.ok(salary >= bands[profile][0] && salary <= bands[profile][1]);
  }
  assert.deepEqual(counts, { good: 500, medium: 300, risky: 200 });
});

test('employer documents admit the pool and give every employee a slot', () => {
  const count = 12500;
  const employers = pool.employerCountFor(count);
  assert.equal(employers, 250);
  let slots = 0;
  for (let j = 0; j < employers; j++) {
    const doc = pool.buildEmployerDoc(j, pool.slotsFor(j, count));
    assert.equal(doc.maxActiveSlots, pool.EMPLOYEES_PER_EMPLOYER);
    assert.equal(doc.status, 'active');
    assert.equal(doc.maxActiveSlotsSource, 'ops_override');
    assert.notEqual(doc.curpConfig.mode, 'allowlist');
    assert.equal(doc.employerCode, pool.employerCode(j));
    slots += doc.maxActiveSlots;
  }
  assert.equal(slots, count);

  // uneven pools: the slot count is exactly the number of members dealt onto each employer,
  // and the employer count is exactly the number of employers in use
  for (const size of [1, 49, 50, 51, 103, 200, 2499, 2500, 2501, 2550, 2551, 5137, 12600]) {
    const perEmployer = new Map();
    for (let i = 0; i < size; i++) {
      const j = pool.employerIndexFor(i);
      perEmployer.set(j, (perEmployer.get(j) ?? 0) + 1);
    }
    assert.equal(pool.employerCountFor(size), perEmployer.size, `employerCountFor(${size})`);
    assert.equal(Math.max(...perEmployer.keys()), perEmployer.size - 1, `employer indexes are contiguous @${size}`);
    for (let j = 0; j < perEmployer.size; j++) assert.equal(pool.slotsFor(j, size), perEmployer.get(j), `slotsFor(${j}, ${size})`);
    assert.equal(pool.slotsFor(perEmployer.size, size), 0);
    assert.ok(Math.max(...perEmployer.values()) <= pool.EMPLOYEES_PER_EMPLOYER);
  }
  for (const bad of [0, -1, 1.5, NaN]) assert.throws(() => pool.employerCountFor(bad), /positive integer/);
});

test('a member keeps its employer however large the pool is seeded, and neighbours still differ', () => {
  // employerIndexFor takes the member index and NOTHING else: there is no pool
  // size for a larger --count to change. (It used to be index % employerCount.)
  assert.equal(pool.employerIndexFor.length, 1);
  assert.equal(pool.employerIndexFor(7), 7);
  assert.equal(pool.employerIndexFor(57), 7);
  assert.equal(pool.employerIndexFor(2499), 49);
  assert.equal(pool.employerIndexFor(2500), 50);
  assert.equal(pool.employerIndexFor(12499), 249);
  assert.equal(pool.buildEmployeeDoc.length, 1);

  // slot caps only ever grow with the pool
  for (let j = 0; j < 60; j++) {
    let previous = 0;
    for (const size of [1, 50, 137, 200, 450, 2500, 2600, 12500, 12600]) {
      const slots = pool.slotsFor(j, size);
      assert.ok(slots >= previous, `slotsFor(${j}) shrank at pool ${size}`);
      previous = slots;
    }
  }
  // consecutive iterations land on different employers (the slot-cap transaction is per employer)
  for (let i = 0; i < 12600; i++) assert.notEqual(pool.employerIndexFor(i), pool.employerIndexFor(i + 1), `@${i}`);
});

test('the constants mirrored here still match functions/src', () => {
  const loanConfig = repo('functions/src/config/loanConfig.ts');
  const index = repo('functions/src/index.ts');
  const num = (src, name) => Number(new RegExp(`${name} = ([\\d.]+)`).exec(src)[1]);

  assert.equal(pool.MIN_LOAN_AMOUNT, num(loanConfig, 'MIN_LOAN_AMOUNT'));
  assert.equal(pool.MAX_LOAN_AMOUNT, num(loanConfig, 'MAX_LOAN_AMOUNT'));
  assert.equal(pool.LOAN_TERM_DAYS, num(loanConfig, 'DEFAULT_LOAN_TERM_DAYS'));
  assert.equal(pool.EMPLOYEE_CREDIT_SALARY_RATIO, num(index, 'EMPLOYEE_CREDIT_SALARY_RATIO'));
  assert.equal(pool.EMPLOYEE_CREDIT_CEILING, num(index, 'EMPLOYEE_CREDIT_CEILING'));

  // the gates the seeded documents are shaped for are still the gates in force
  assert.match(index, /employee\['metamapStatus'\] === METAMAP_VERIFIED_STATUS/);
  assert.match(index, /METAMAP_VERIFIED_STATUS = 'verified'/);
  assert.match(index, /enforceRateLimit\(`rl:loan:\$\{uid\}`, 3, 86400/);
  assert.match(index, /employer\['status'\] !== 'active' && employer\['status'\] !== 'pending_verification'/);
  assert.match(index, /empData\['maxActiveSlotsSource'\] !== 'ops_override'/);

  // every status requestLoan can hand back is a canonical one
  const statuses = repo('functions/src/loans/loanStatus.ts');
  for (const status of pool.ACCEPTED_INITIAL_STATUSES) assert.ok(statuses.includes(`'${status}'`), status);
});

test('poolIndexFor hands out each member once and stops instead of wrapping', () => {
  assert.equal(pool.poolIndexFor(0, 3), 0);
  assert.equal(pool.poolIndexFor(2, 3), 2);
  assert.equal(pool.poolIndexFor(3, 3), -1);
  assert.equal(pool.poolIndexFor(0, 10, 4), 4);
  assert.equal(pool.poolIndexFor(5, 10, 4), 9);
  assert.equal(pool.poolIndexFor(6, 10, 4), -1);
  assert.throws(() => pool.poolIndexFor(0, 0), /POOL_SIZE/);
  assert.throws(() => pool.poolIndexFor(0, 10, -1), /POOL_OFFSET/);
});

test('poolConfigFromEnv', () => {
  assert.equal(pool.poolConfigFromEnv({}), null);
  assert.equal(pool.poolConfigFromEnv({ POOL_SIZE: '' }), null);
  assert.deepEqual(pool.poolConfigFromEnv({ POOL_SIZE: '2800' }), { size: 2800, offset: 0 });
  assert.deepEqual(pool.poolConfigFromEnv({ POOL_SIZE: '2800', POOL_OFFSET: '132' }), { size: 2800, offset: 132 });
  assert.throws(() => pool.poolConfigFromEnv({ POOL_SIZE: 'lots' }), /POOL_SIZE/);
  assert.throws(() => pool.poolConfigFromEnv({ POOL_SIZE: '10', POOL_OFFSET: '10' }), /below POOL_SIZE/);
});

test('signInUrl: emulator host wins and must be loopback; otherwise the API key is required', () => {
  assert.equal(
    pool.signInUrl({ FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }),
    'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator'
  );
  assert.equal(
    pool.signInUrl({ FIREBASE_API_KEY: 'k' }),
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=k'
  );
  assert.throws(() => pool.signInUrl({ FIREBASE_AUTH_EMULATOR_HOST: 'evil.example.com:9099' }), /loopback/);
  assert.throws(() => pool.signInUrl({}), /FIREBASE_API_KEY/);
});

test('poolSignInUrl: the pool and the target must agree', () => {
  const emulatorHost = { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' };
  assert.equal(pool.poolSignInUrl(emulatorHost, 'emulator'), pool.signInUrl(emulatorHost));
  assert.equal(pool.poolSignInUrl({ FIREBASE_API_KEY: 'k' }, 'staging'), pool.signInUrl({ FIREBASE_API_KEY: 'k' }));

  // a pool aimed at production: never, whatever else is set
  for (const env of [{ FIREBASE_API_KEY: 'k' }, emulatorHost, {}]) {
    assert.throws(() => pool.poolSignInUrl(env, 'production'), /target is PRODUCTION/);
  }
  // emulator target, API key, no emulator host: would sign in against Google
  assert.throws(() => pool.poolSignInUrl({ FIREBASE_API_KEY: 'k' }, 'emulator'), /against Google/);
  // deployed target with a leftover emulator host: every token would be rejected
  assert.throws(() => pool.poolSignInUrl({ ...emulatorHost, FIREBASE_API_KEY: 'k' }, 'staging'), /Unset it/);
  // the underlying checks still apply
  assert.throws(() => pool.poolSignInUrl({}, 'staging'), /FIREBASE_API_KEY/);
  assert.throws(() => pool.poolSignInUrl({ FIREBASE_AUTH_EMULATOR_HOST: 'evil.example.com:9099' }, 'emulator'), /loopback/);
});

test('isPoolRfc is true for every RFC the pool can produce and for nothing a taxpayer can hold', () => {
  for (let index = 0; index < 1000000; index += 997) assert.ok(pool.isPoolRfc(pool.rfcFor(index)), String(index));
  for (const index of SAMPLE) {
    assert.ok(pool.isPoolRfc(pool.buildEmployeeDoc(index).rfc));
    assert.ok(pool.rfcFor(index).startsWith(pool.POOL_RFC_PREFIX));
  }
  for (const rfc of [
    'LTXX900101AB1', // right prefix, a real-looking homoclave
    'LTXX600101L0', // too short
    'LTXX600101L000', // too long
    'ltxx600101l00',
    'LTXX601301L00', // month 13
    'LTXX600129L00', // day 29: the pool never generates one
    'LTXX590101L00', // born before the pool's range
    'LOAA900101AB1',
    'LTE000001LT1', // the pool's EMPLOYER rfc is not an applicant rfc
    '',
    null,
    undefined,
    600101,
  ]) {
    assert.equal(pool.isPoolRfc(rfc), false, String(rfc));
  }
});

test('appCheckPlan: a deployed target must be given a token; the emulator gets an unsigned placeholder', () => {
  assert.deepEqual(pool.appCheckPlan({ APP_CHECK_TOKEN: 'jwt' }, 'staging'), { kind: 'static', token: 'jwt' });
  assert.deepEqual(pool.appCheckPlan({}, 'emulator'), { kind: 'static', token: pool.EMULATOR_APP_CHECK_TOKEN });
  assert.throws(() => pool.appCheckPlan({}, 'staging'), /Neither APP_CHECK_DEBUG_TOKEN nor APP_CHECK_TOKEN/);
  assert.throws(() => pool.appCheckPlan({}, 'production'), /Neither APP_CHECK_DEBUG_TOKEN nor APP_CHECK_TOKEN/);
  // the signed-off production smoke: an already-exchanged token, nothing else
  assert.deepEqual(pool.appCheckPlan({ APP_CHECK_TOKEN: 'jwt' }, 'production'), { kind: 'static', token: 'jwt' });

  // The placeholder is not a credential: alg "none" and no signature at all.
  const [header, payload, signature] = pool.EMULATOR_APP_CHECK_TOKEN.split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'none');
  assert.equal(signature, '');
  assert.match(JSON.parse(Buffer.from(payload, 'base64url')).iss, /emulator-only/);
});

test('appCheckPlan: a debug token is exchanged, never sent as the header itself', () => {
  const env = {
    APP_CHECK_DEBUG_TOKEN: '11111111-2222-3333-4444-555555555555',
    FIREBASE_PROJECT_ID: 'vida-staging',
    FIREBASE_APP_ID: '1:123:web:abc',
    FIREBASE_API_KEY: 'web-key',
  };
  const plan = pool.appCheckPlan(env, 'staging');
  assert.equal(plan.kind, 'exchange');
  assert.equal(
    plan.url,
    'https://firebaseappcheck.googleapis.com/v1/projects/vida-staging/apps/1:123:web:abc:exchangeDebugToken?key=web-key'
  );
  assert.deepEqual(JSON.parse(plan.body), { debug_token: env.APP_CHECK_DEBUG_TOKEN });
  assert.equal(plan.token, undefined);

  // an already-exchanged token wins; a debug token without its three companions is refused
  assert.equal(pool.appCheckPlan({ ...env, APP_CHECK_TOKEN: 'jwt' }, 'staging').kind, 'static');
  assert.throws(
    () => pool.appCheckPlan({ APP_CHECK_DEBUG_TOKEN: 'x', FIREBASE_API_KEY: 'k' }, 'staging'),
    /needs FIREBASE_PROJECT_ID, FIREBASE_APP_ID/
  );
});

// ── Production identifiers, whatever TARGET_URL says ─────────────────────────

const STAGING_EXCHANGE = {
  APP_CHECK_DEBUG_TOKEN: '11111111-2222-3333-4444-555555555555',
  FIREBASE_PROJECT_ID: 'vida-staging',
  FIREBASE_APP_ID: '1:123:web:abc',
  FIREBASE_API_KEY: 'web-key',
};
const PRODUCTION_VALUES = [
  ['FIREBASE_PROJECT_ID', PRODUCTION_PROJECT_ID, /FIREBASE_PROJECT_ID=vida-finance is the PRODUCTION project/],
  // malformed ids are refused before they are compared
  ['FIREBASE_PROJECT_ID', ' Vida-Finance ', /FIREBASE_PROJECT_ID=" Vida-Finance " is not a Firebase project id/],
  ['FIREBASE_PROJECT_ID', 'vida%2Dfinance', /is not a Firebase project id/],
  ['FIREBASE_PROJECT_ID', 'vida-prod-eu', /PRODUCTION project/],
  // Google's REST paths take the project number in place of the id
  ['FIREBASE_PROJECT_ID', PRODUCTION_PROJECT_NUMBER, /FIREBASE_PROJECT_ID=447766605132 is the PRODUCTION project/],
  ['FIREBASE_PROJECT_ID', `"${PRODUCTION_PROJECT_ID}"`, /is not a Firebase project id/],
  ['FIREBASE_API_KEY', `"${PRODUCTION_WEB_API_KEY}"`, /FIREBASE_API_KEY is the PRODUCTION project's Web API key/],
  ['FIREBASE_APP_ID', `1:${PRODUCTION_PROJECT_NUMBER}:web:7d747366eb91b2452cb3e9`, /FIREBASE_APP_ID belongs to project number 447766605132/],
  ['FIREBASE_API_KEY', PRODUCTION_WEB_API_KEY, /FIREBASE_API_KEY is the PRODUCTION project's Web API key/],
];

test('the production identifiers are the ones in the web config', () => {
  const firebaseConfig = repo('public-v2/src/lib/firebase.ts');
  assert.ok(firebaseConfig.includes(`projectId: '${PRODUCTION_PROJECT_ID}'`));
  assert.ok(firebaseConfig.includes(`apiKey: '${PRODUCTION_WEB_API_KEY}'`));
  assert.ok(firebaseConfig.includes(`appId: '1:${PRODUCTION_PROJECT_NUMBER}:web:`));
  // and the seed's own list (guard.mjs cannot be imported by k6, so the id lives in two places)
  assert.match(repo('tests/load/seed/guard.mjs'), new RegExp(`PRODUCTION_PROJECT_IDS = Object\\.freeze\\(\\['${PRODUCTION_PROJECT_ID}'\\]\\)`));
  assert.deepEqual(productionIdentifiers(STAGING_EXCHANGE), []);
  assert.deepEqual(productionIdentifiers({}), []);
});

test('appCheckPlan refuses a production project id, app id or API key for the exchange — whatever the target', () => {
  for (const [name, value, message] of PRODUCTION_VALUES) {
    for (const label of ['staging', 'emulator', 'production']) {
      assert.throws(() => pool.appCheckPlan({ ...STAGING_EXCHANGE, [name]: value }, label), message, `${name}=${value} on ${label}`);
    }
  }
  // the refusal says no flag changes it, and the sign-off phrase indeed does not
  assert.throws(
    () => pool.appCheckPlan({ ...STAGING_EXCHANGE, FIREBASE_PROJECT_ID: 'vida-finance', LOAD_TEST_ALLOW_PRODUCTION: 'I-HAVE-OPS-SIGN-OFF' }, 'production'),
    /whatever TARGET_URL says, and no flag overrides it/
  );
  // a non-production run may not carry them even when the token is static or the emulator placeholder
  assert.throws(() => pool.appCheckPlan({ APP_CHECK_TOKEN: 'jwt', FIREBASE_PROJECT_ID: 'vida-finance' }, 'staging'), /PRODUCTION project/);
  assert.throws(() => pool.appCheckPlan({ FIREBASE_API_KEY: PRODUCTION_WEB_API_KEY }, 'emulator'), /PRODUCTION project's Web API key/);
  // unchanged: a real non-production exchange
  assert.equal(pool.appCheckPlan(STAGING_EXCHANGE, 'staging').kind, 'exchange');
});

test('poolSignInUrl refuses production identifiers before it builds any URL — whatever the target', () => {
  const emulator = { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' };
  for (const [name, value, message] of PRODUCTION_VALUES) {
    assert.throws(() => pool.poolSignInUrl({ FIREBASE_API_KEY: 'web-key', [name]: value }, 'staging'), message, `${name} on staging`);
    assert.throws(() => pool.poolSignInUrl({ ...emulator, [name]: value }, 'emulator'), message, `${name} on the emulator`);
  }
  assert.equal(
    pool.poolSignInUrl({ FIREBASE_API_KEY: 'web-key', FIREBASE_PROJECT_ID: 'vida-staging' }, 'staging'),
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=web-key'
  );
});

// ── Backing off after a failed App Check exchange ────────────────────────────

function exchangeHarness(responses) {
  const h = { t: 1000000, posts: [], warnings: [], aborts: [] };
  h.token = pool.createAppCheckTokenSource(
    { kind: 'exchange', url: 'https://appcheck.example/exchange', body: '{"debug_token":"d"}' },
    {
      post: (url, body) => {
        h.posts.push({ at: h.t, url, body });
        const next = responses.length > 1 ? responses.shift() : responses[0];
        if (next instanceof Error) throw next;
        return next;
      },
      now: () => h.t,
      warn: (m) => h.warnings.push(m),
      abort: (m) => h.aborts.push(m),
    }
  );
  return h;
}
const OK = (token, ttl = '3600s') => ({ status: 200, body: JSON.stringify({ token, ttl }) });

test('a static plan never calls the exchange endpoint', () => {
  const token = pool.createAppCheckTokenSource({ kind: 'static', token: 'jwt' }, {
    post: () => assert.fail('no exchange for a static token'),
    now: () => 0,
    abort: () => assert.fail('no abort'),
  });
  assert.equal(token(), 'jwt');
});

test('an exchanged token is cached and refreshed at 80% of its life', () => {
  const h = exchangeHarness([OK('first'), OK('second')]);
  assert.equal(h.token(), 'first');
  h.t += 2879000;
  assert.equal(h.token(), 'first');
  assert.equal(h.posts.length, 1);
  h.t += 1000; // 2,880 s = 80% of 3,600 s
  assert.equal(h.token(), 'second');
  assert.equal(h.posts.length, 2);
  assert.deepEqual(h.posts[0], { at: 1000000, url: 'https://appcheck.example/exchange', body: '{"debug_token":"d"}' });
});

test('a failed exchange is not retried on every iteration: it backs off 5 s, 10 s, 20 s …', () => {
  const h = exchangeHarness([{ status: 503, body: '' }, { status: 503, body: '' }, { status: 503, body: '' }, OK('late')]);
  // 100 iterations, one every 500 ms = 50 s of a failing endpoint
  for (let i = 0; i < 100; i++) {
    h.token();
    h.t += 500;
  }
  // attempts at +0, +5 s, +15 s (5 + 10) and +35 s (15 + 20) — not 100
  assert.deepEqual(h.posts.map((p) => p.at - 1000000), [0, 5000, 15000, 35000]);
  assert.equal(h.token(), 'late');
  assert.equal(h.warnings.length, 3);
  assert.match(h.warnings[0], /status=503; next attempt in 5s/);
  assert.match(h.warnings[2], /next attempt in 20s/);
  assert.deepEqual(h.aborts, []);
});

test('the backoff doubles up to five minutes and resets after a success', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 50].map(pool.appCheckBackoffMs), [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000]);
  assert.equal(pool.appCheckBackoffMs(0), 5000);

  const h = exchangeHarness([OK('one', '100s'), { status: 500, body: '' }, { status: 500, body: '' }, OK('two', '100s'), { status: 500, body: '' }, OK('three')]);
  assert.equal(h.token(), 'one');
  h.t += 80000; // refresh due; the endpoint is down
  assert.equal(h.token(), 'one', 'the token in hand is reused while backing off');
  h.t += 4999;
  assert.equal(h.token(), 'one');
  assert.equal(h.posts.length, 2, 'no second attempt inside the 5 s window');
  h.t += 1;
  assert.equal(h.token(), 'one'); // second failure → 10 s
  h.t += 10000;
  assert.equal(h.token(), 'two');
  h.t += 80000;
  assert.equal(h.token(), 'two'); // fails again: back to a 5 s wait, not 20 s
  assert.match(h.warnings.at(-1), /next attempt in 5s/);
  // a failure with a token in hand never aborts the run
  assert.deepEqual(h.aborts, []);
});

test('an exchange that cannot heal stops the run instead of sending 401s', () => {
  for (const status of [400, 401, 403, 404]) {
    const h = exchangeHarness([{ status, body: '{"error":{}}' }]);
    assert.equal(h.token(), '');
    assert.equal(h.aborts.length, 1, `HTTP ${status}`);
    assert.match(h.aborts[0], new RegExp(`refused \\(HTTP ${status}\\)`));
  }
  // transient failures with no token: five in a row, then stop
  const h = exchangeHarness([{ status: 503, body: '' }]);
  for (let i = 0; i < 4; i++) {
    h.token();
    h.t += 600000;
  }
  assert.deepEqual(h.aborts, []);
  h.token();
  assert.equal(h.posts.length, pool.APP_CHECK_GIVE_UP_AFTER);
  assert.match(h.aborts[0], /failed 5 times in a row \(last HTTP 503\)/);
  // k6's abort throws; an injected one that returns is still called once, and the endpoint is left alone
  for (let i = 0; i < 1000; i++) {
    h.t += 1000;
    assert.equal(h.token(), '');
  }
  assert.equal(h.aborts.length, 1);
  assert.equal(h.posts.length, pool.APP_CHECK_GIVE_UP_AFTER);

  // a thrown request and a 200 without a token are failures too, not crashes
  const broken = exchangeHarness([new Error('dial tcp'), { status: 200, body: 'not json' }, { status: 200, body: '{}' }, OK('ok')]);
  assert.equal(broken.token(), '');
  broken.t += 5000;
  assert.equal(broken.token(), '');
  broken.t += 10000;
  assert.equal(broken.token(), '');
  broken.t += 20000;
  assert.equal(broken.token(), 'ok');
});

test('appCheckRefreshAfterMs refreshes before the token expires', () => {
  assert.equal(pool.appCheckRefreshAfterMs('3600s'), 2880000);
  assert.equal(pool.appCheckRefreshAfterMs('1800.5s'), 1440400);
  assert.equal(pool.appCheckRefreshAfterMs('10s'), 60000);
  assert.equal(pool.appCheckRefreshAfterMs(undefined), 1440000);
});

test('the default pool covers the full profile; the runbook numbers are the computed ones', () => {
  const full = pool.iterationUpperBound(RAMP_STAGES);
  const smoke = pool.iterationUpperBound(SMOKE_STAGES);
  assert.ok(pool.DEFAULT_POOL_SIZE >= full, `default ${pool.DEFAULT_POOL_SIZE} < full-profile bound ${full}`);
  // 1 VU for 30 min: an iteration starts at t = 0 and every 5 s after it, the last at t = 1795 s … plus the fencepost
  assert.equal(pool.iterationUpperBound([{ target: 10, duration: '30m' }]), 361);
  // one extra start per VU ever started (28 at the end of `full`, 5 at the end of `smoke`)
  assert.equal(full, 12420 + 28);
  assert.equal(smoke, 132 + 5);
  // a ramp-down and back up restarts VUs, and each restart is one more start
  assert.equal(
    pool.iterationUpperBound([
      { target: 30, duration: '1m' },
      { target: 10, duration: '1m' },
      { target: 30, duration: '1m' },
    ]),
    Math.ceil(((2 + 2 + 2) * 60) / 5) + 1 + 2 + 2
  );

  const runbook = repo('docs/runbooks/scaling.md');
  const fmt = (n) => n.toLocaleString('en-US');
  assert.ok(runbook.includes(fmt(full)), `runbook must state the full-profile bound ${fmt(full)}`);
  assert.ok(runbook.includes(`| \`smoke\` | ${smoke} |`), `runbook must state the smoke bound ${smoke}`);
  assert.ok(runbook.includes(fmt(pool.DEFAULT_POOL_SIZE)), 'runbook must state the default pool size');
  assert.throws(() => pool.iterationUpperBound([{ target: 10, duration: '90s' }]), /Unsupported stage duration/);
});

test('the k6 script takes its users from the pool and stops when it runs out', () => {
  const script = repo('tests/load/pipeline-load-test.js');
  assert.match(script, /from '\.\/seed\/pool\.js'/);
  assert.match(script, /poolIndexFor\(exec\.scenario\.iterationInTest, POOL\.size, POOL\.offset\)/);
  assert.match(script, /exec\.test\.abort\(/);
  assert.match(script, /buildPoolApplication\(index\)/);
  assert.match(script, /ACCEPTED_INITIAL_STATUSES\.includes\(body\.result\.status\)/);
  assert.match(script, /const APP_CHECK = appCheckPlan\(__ENV, TARGET\.label\)/);
  // pool + production, and a sign-in endpoint that disagrees with the target, are refused at init
  assert.match(script, /const SIGN_IN_URL = POOL \? poolSignInUrl\(__ENV, TARGET\.label\) : null/);
  assert.doesNotMatch(script, /[^l]signInUrl\(__ENV\)/);
  // the step that claimed to verify mock mode (it re-read /api/health) is gone
  assert.doesNotMatch(script, /mockCheck|Verify mock mode/);
  assert.match(script, /'X-Firebase-AppCheck': appCheckToken\(\)/);
  // the token comes from the backing-off source, and the script has no exchange loop of its own
  assert.match(script, /const appCheckToken = createAppCheckTokenSource\(APP_CHECK, \{/);
  assert.match(script, /abort: \(message\) => exec\.test\.abort\(message\)/);
  assert.doesNotMatch(script, /function appCheckToken\(|APP_CHECK\.url|appCheckCache/);
  // the per-iteration invented account that could never exist is gone
  assert.doesNotMatch(script, /@loadtest\.vida\.internal|LoadTest2024/);
});

test('the report prints no stage latency the target did not measure, and no verdict for a load it did not apply', () => {
  const script = repo('tests/load/pipeline-load-test.js');
  // stage trends are fed from the X-Stage-*-Ms response headers and from nothing else
  assert.doesNotMatch(script, /totalLatency \* 0\.\d/, 'a fixed fraction of the total is not a stage measurement');
  for (const trend of ['stageValidation', 'stageFirestoreWrite', 'stageQueueDispatch', 'stageMlScoring']) {
    const adds = [...script.matchAll(new RegExp(`${trend}\\.add\\(([^;]+);`, 'g'))].map((m) => m[1]);
    assert.equal(adds.length, 1, `${trend} is added to exactly once`);
    assert.match(adds[0], /^parseInt\(res\.headers\['X-Stage-[A-Za-z]+-Ms'\], 10\)\)$/, trend);
  }
  // the box is built by stageLatencyLines and by nothing else
  assert.match(script, /lines\.push\('┌─ Per-Stage Latency \(P95\) ─+┐'\);\s+lines\.push\(\.\.\.stageLatencyLines\(data\.metrics\)\);/);
  assert.doesNotMatch(script, /stage_latency_/);
  // nothing in functions/ sends those headers; if that changes, the config.js comment and the runbook are stale
  const functionsSrc = readdirSync(new URL('../../../functions/src/', import.meta.url), { recursive: true })
    .filter((name) => name.endsWith('.ts') && !name.includes('__tests__') && !name.endsWith('.test.ts'))
    .map((name) => repo(`functions/src/${name}`))
    .join('\n');
  assert.doesNotMatch(functionsSrc, /X-Stage-/i);

  // the 2x line is a verdict only in the full profile; an emulator report says what it is
  assert.match(script, /const full = PROFILE === 'full';/);
  // …and PROFILE can only be 'smoke' or 'full', so that line and the stages agree
  assert.match(script, /const PROFILE = resolveProfile\(__ENV\);/);
  assert.match(script, /const stages = PROFILE === 'smoke' \? SMOKE_STAGES : RAMP_STAGES;/);
  assert.doesNotMatch(script, /__ENV\.PROFILE/);
  assert.match(script, /2x target without errors: {2}\$\{full \? \(errRate < 0\.05 \? '✓ PASS' : '✗ FAIL'\) : notReached\}/);
  assert.match(script, /if \(TARGET\.label === 'emulator'\) \{\s+lines\.push\('│ {2}EMULATOR run: this proves the script and the seeded pool work\.'\)/);
});

test('the stage box says "not instrumented" when no stage trend holds a sample, and prints only the stages that do', () => {
  const NOT_INSTRUMENTED = [
    '│  not instrumented — the target sends no X-Stage-*-Ms headers,',
    '│  so only the end-to-end latency above was measured',
  ];
  // what every run so far has produced: the trends exist in k6's summary but are empty, or are absent
  assert.deepEqual(stageLatencyLines({}), NOT_INSTRUMENTED);
  assert.deepEqual(
    stageLatencyLines({
      stage_latency_validation: { values: { count: 0, 'p(50)': 0, 'p(95)': 0 } },
      stage_latency_firestore_write: {},
      request_latency_e2e: { values: { count: 91, 'p(50)': 43, 'p(95)': 97 } },
    }),
    NOT_INSTRUMENTED
  );
  // a target that does send the headers gets its figures, and no disclaimer
  assert.deepEqual(
    stageLatencyLines({
      stage_latency_validation: { values: { count: 3, 'p(50)': 12.4, 'p(95)': 30.6 } },
      stage_latency_ml_scoring: { values: { count: 0 } },
    }),
    ['│  Validation           P50:     12ms  P95:     31ms']
  );
});

test('result files carry the time of day, so a second run on one day does not replace the first (or a committed report)', () => {
  const first = resultsBaseName('2026-10-13T14:22:33.123Z', 'emulator', 'smoke');
  assert.equal(first, 'tests/load/results/2026-10-13T142233Z-emulator-smoke');
  assert.notEqual(resultsBaseName('2026-10-13T14:29:01.000Z', 'emulator', 'smoke'), first);
  // the committed evidence of 2026-10-13 keeps its date-only name, which no run can produce any more
  assert.ok(repo('tests/load/results/2026-10-13-emulator-smoke-report.md').includes('TARGET: EMULATOR'));
  assert.notEqual(`${first}-report.md`, 'tests/load/results/2026-10-13-emulator-smoke-report.md');
  assert.throws(() => resultsBaseName('yesterday', 'emulator', 'smoke'), /Not an ISO timestamp/);
  const script = repo('tests/load/pipeline-load-test.js');
  assert.match(script, /const base = resultsBaseName\(summary\.timestamp, TARGET\.label, PROFILE\);/);
  assert.ok(repo('docs/runbooks/scaling.md').includes('tests/load/results/<date>T<time>Z-<label>-<profile>-report.md'));
});

test('a sign-in that got no HTTP answer is sent once more; any HTTP status is final', () => {
  const run = (responses) => {
    const sent = [];
    const retried = [];
    const res = pool.sendWithOneTransportRetry(
      () => {
        sent.push(1);
        return responses.shift();
      },
      (first) => retried.push(first)
    );
    return { res, sends: sent.length, retried };
  };
  assert.deepEqual(run([{ status: 200, body: 'ok' }]), { res: { status: 200, body: 'ok' }, sends: 1, retried: [] });
  // connection reset (k6: status 0), then an answer
  const reset = { status: 0, error: 'read: connection reset by peer' };
  assert.deepEqual(run([reset, { status: 200, body: 'ok' }]), { res: { status: 200, body: 'ok' }, sends: 2, retried: [reset] });
  // once, not until it works
  assert.deepEqual(run([reset, { status: 0 }, { status: 200 }]), { res: { status: 0 }, sends: 2, retried: [reset] });
  // a wrong password or a server error is an answer
  for (const status of [400, 401, 429, 500, 503]) assert.equal(run([{ status }, { status: 200 }]).sends, 1, String(status));

  const script = repo('tests/load/pipeline-load-test.js');
  assert.match(script, /const signInRes = sendWithOneTransportRetry\(\s+\(\) =>\s+http\.post\(\s+SIGN_IN_URL,/);
});

test('every failed request lands in exactly one named bucket, and failed sign-ins are counted', () => {
  const script = repo('tests/load/pipeline-load-test.js');
  const metrics = repo('tests/load/helpers/metrics.js');
  for (const [name, metric] of [
    ['unauthenticated', 'unauthenticated_requests'],
    ['refusedPrecondition', 'refused_precondition_requests'],
    ['refusedInvalidArgument', 'refused_invalid_argument_requests'],
    ['otherFailures', 'other_failed_requests'],
    ['signInFailures', 'auth_sign_in_failures'],
  ]) {
    assert.ok(metrics.includes(`export const ${name} = new Counter('${metric}')`), name);
    assert.match(script, new RegExp(`${name}\\.add\\(1\\)`), `${name} is counted`);
    assert.ok(script.includes(`count('${metric}')`), `${metric} is in the report`);
  }
  // one if / else-if chain ending in a catch-all: no failed request is left uncategorised
  const chain = script.slice(script.indexOf('// Categorize failure'), script.indexOf("if (res.status !== 200) {"));
  assert.deepEqual(
    [...chain.matchAll(/(\w+)\.add\(1\)/g)].map((m) => m[1]),
    ['rateLimited', 'timeouts', 'serverErrors', 'unauthenticated', 'refusedPrecondition', 'refusedInvalidArgument', 'otherFailures']
  );
  assert.match(chain, /\} else \{\s+otherFailures\.add\(1\);/);
});

// ── The provider inventory in the runbook ────────────────────────────────────
// Deliverable: say precisely what a load run can reach. These tests fail when
// the code grows a provider switch or an outbound host the runbook does not name.

const UW = '../../../services/underwriting-service/';
function underwritingSources() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!['node_modules', '__tests__', '__mocks__', 'test-support'].includes(entry.name)) walk(`${dir}${entry.name}/`);
      } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') && !entry.name.endsWith('.config.js')) {
        files.push(`${dir}${entry.name}`);
      }
    }
  };
  walk(UW);
  return files.map((file) => ({ file, text: readFileSync(new URL(file, import.meta.url), 'utf8') }));
}

test('the runbook names every provider switch and endpoint variable the underwriting-service reads', () => {
  const runbook = repo('docs/runbooks/scaling.md');
  const section = runbook.slice(runbook.indexOf('#### Keeping bureau / RiskSeal out of it'), runbook.indexOf('#### Needs a human first'));
  assert.ok(section.length > 1000, 'provider section not found');

  const names = new Set();
  for (const { text } of underwritingSources()) {
    for (const [, name] of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      if (/(_URL|_MOCK|_MODE|_PROVIDER|_API_KEY)$/.test(name)) names.add(name);
    }
  }
  // sanity: the scan really sees the ones the review found missing
  for (const expected of ['ANTHROPIC_API_KEY', 'EMPLOYER_SAT_PROVIDER', 'KYC_MODE', 'SAT_SOAP_CFDI_URL', 'SEP_CEDULAS_URL', 'REPUVE_URL', 'CONDUSEF_URL', 'SW_BASE_URL']) {
    assert.ok(names.has(expected), `scan did not find ${expected}`);
  }
  const missing = [...names].filter((name) => !section.includes(`\`${name}\``)).sort();
  assert.deepEqual(missing, [], `provider variables read by underwriting-service but absent from the runbook: ${missing.join(', ')}`);
});

test('the runbook names every third-party host hard-coded in the underwriting-service', () => {
  const runbook = repo('docs/runbooks/scaling.md');
  const section = runbook.slice(runbook.indexOf('#### Keeping bureau / RiskSeal out of it'), runbook.indexOf('#### Needs a human first'));
  const NOT_PROVIDERS = /^(localhost|schemas\.xmlsoap\.org|tempuri\.org|vida-finance\.web\.app)$/;

  const hosts = new Set();
  for (const { text } of underwritingSources()) {
    for (const line of text.split('\n')) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue; // comments (doc links)
      for (const [, host] of line.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) {
        if (!NOT_PROVIDERS.test(host)) hosts.add(host);
      }
    }
  }
  for (const expected of ['api.anthropic.com', 'services.sw.com.mx', 'sandbox.belvo.com', 'ip-api.com']) {
    assert.ok(hosts.has(expected), `scan did not find ${expected}`);
  }
  const missing = [...hosts].filter((host) => !section.includes(host)).sort();
  assert.deepEqual(missing, [], `hosts called by underwriting-service but absent from the runbook: ${missing.join(', ')}`);
});

test('the runbook does not present the full-pipeline setup as cleared, and states what teardown leaves', () => {
  const runbook = repo('docs/runbooks/scaling.md');
  assert.match(runbook, /\*\*B — full pipeline\. NOT cleared to run\b/);
  assert.doesNotMatch(runbook, /Two workable setups/);
  // the facts the gap rests on are still the code's
  const stage5 = repo('services/underwriting-service/src/stages/stage5-review.js');
  assert.match(stage5, /fetch\("https:\/\/api\.anthropic\.com\/v1\/messages"/);
  assert.match(stage5, /applicantRfc: data\.applicantRfc/);
  assert.match(stage5, /loanId: data\.loanId/);
  const index = repo('functions/src/index.ts');
  const payload = index.slice(index.indexOf("fetch(uwUrl + '/underwrite'"), index.indexOf('signal: AbortSignal.timeout(30000)'));
  assert.ok(payload.length > 200 && !/loanId/.test(payload), 'requestLoan now sends a loanId to /underwrite: revisit teardown and the runbook');
  // teardown section
  assert.match(runbook, /`applicantRfc` is a pool RFC/);
  assert.match(runbook, /`employer-a:LTE/);
});
