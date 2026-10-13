// node --test tests/load/seed/pool.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { RAMP_STAGES, SMOKE_STAGES } from '../config.js';
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
    const employers = 250;
    const doc = pool.buildEmployeeDoc(index, employers);

    // identity gate
    assert.equal(doc.metamapStatus, 'verified');
    // credit gates: both finite numbers, and the trigger's own formula
    assert.ok(Number.isFinite(doc.monthlySalary) && Number.isFinite(doc.availableCredit));
    assert.equal(doc.creditLimit, Math.max(Math.min(doc.monthlySalary * 0.3, 5000), 0));
    assert.equal(doc.availableCredit, doc.creditLimit);
    // employer link
    assert.equal(doc.employerId, pool.employerId(index % employers));
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
    const clabe = pool.buildEmployeeDoc(index, 10).bankClabe;
    const sum = [...clabe.slice(0, 17)].reduce((acc, d, i) => acc + ((Number(d) * [3, 7, 1][i % 3]) % 10), 0);
    assert.equal(Number(clabe[17]), (10 - (sum % 10)) % 10);
  }
});

test('the amount k6 sends is one requestLoan accepts for that same employee', () => {
  for (let index = 0; index < 5000; index++) {
    const doc = pool.buildEmployeeDoc(index, 100);
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
    const doc = pool.buildEmployerDoc(j, pool.slotsFor(j, count, employers));
    assert.equal(doc.status, 'active');
    assert.equal(doc.maxActiveSlotsSource, 'ops_override');
    assert.notEqual(doc.curpConfig.mode, 'allowlist');
    assert.equal(doc.employerCode, pool.employerCode(j));
    slots += doc.maxActiveSlots;
  }
  assert.equal(slots, count);

  // uneven split: the slot count is exactly the number of employees round-robined onto each employer
  const perEmployer = new Map();
  for (let i = 0; i < 103; i++) {
    const j = pool.employerIndexFor(i, 10);
    perEmployer.set(j, (perEmployer.get(j) ?? 0) + 1);
  }
  for (let j = 0; j < 10; j++) assert.equal(pool.slotsFor(j, 103, 10), perEmployer.get(j));
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
    assert.ok(pool.isPoolRfc(pool.buildEmployeeDoc(index, 10).rfc));
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
  // the per-iteration invented account that could never exist is gone
  assert.doesNotMatch(script, /@loadtest\.vida\.internal|LoadTest2024/);
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
