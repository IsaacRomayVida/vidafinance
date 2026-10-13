/**
 * The load-test user pool — one deterministic definition, read by both sides.
 *
 *   - tests/load/seed/seed-load-pool.mjs (Node, Admin SDK) WRITES the pool;
 *   - tests/load/pipeline-load-test.js (k6) READS it, by recomputing the same
 *     ids and amounts from an index. No pool file is passed between the two.
 *
 * Pure ESM with no k6 and no Node imports, for the same reason as ../target.js:
 * k6 runs it and `node --test tests/load/seed/pool.test.mjs` tests it.
 *
 * Why a pool at all — what requestLoan (functions/src/index.ts) demands of a caller:
 *   - a Firebase ID token whose effective role is `employee`;
 *   - `rl:loan:<uid>` under 3 per day (counted on EVERY call, accepted or not);
 *   - `employees/<uid>` with `metamapStatus: 'verified'`, a finite
 *     `availableCredit` and `monthlySalary`, amount <= availableCredit and
 *     <= 30% of salary;
 *   - NO loan of that uid in pending / under_review / approved /
 *     disbursement_queued / active  →  ONE accepted request per uid, not three;
 *   - `employers/<employerId>` with status `active`, and fewer open loans than
 *     its `maxActiveSlots`.
 */

/** Every id, email and employer code this pool creates starts with this. Teardown deletes nothing else. */
export const POOL_PREFIX = 'loadtest-';
export const EMPLOYEE_UID_PREFIX = `${POOL_PREFIX}emp-`;
export const EMPLOYER_ID_PREFIX = `${POOL_PREFIX}employer-`;
/** Minted employer codes are 6 chars from an alphabet without 0, 1 or '-', so this can never collide with one. */
export const EMPLOYER_CODE_PREFIX = 'LOADTEST-';
/** `.invalid` is reserved (RFC 2606): no mail sent to these addresses can ever be delivered. */
export const EMAIL_DOMAIN = 'loadtest.invalid';

/**
 * Upper bound of iterations in the `full` profile (12,448 — see iterationUpperBound
 * and docs/runbooks/scaling.md § uid-pool arithmetic), rounded up. One uid per
 * iteration, because a uid with an open loan is refused a second one.
 */
export const DEFAULT_POOL_SIZE = 12500;
/** Keeps the per-employer slot-cap transaction from serialising the whole run on one employer. */
export const EMPLOYEES_PER_EMPLOYER = 50;

// Mirrors of functions/src (pinned against the source by pool.test.mjs).
export const MIN_LOAN_AMOUNT = 500;
export const MAX_LOAN_AMOUNT = 5000;
export const EMPLOYEE_CREDIT_SALARY_RATIO = 0.3;
export const EMPLOYEE_CREDIT_CEILING = 5000;
export const LOAN_TERM_DAYS = 30;
/** Statuses requestLoan can return for a request it ACCEPTED (functions/src/loans/loanStatus.ts). */
export const ACCEPTED_INITIAL_STATUSES = ['pending', 'under_review', 'approved', 'rejected'];

// Same 50 / 30 / 20 mix and salary bands as BORROWER_PROFILES in ../config.js.
const PROFILE_BY_DECILE = ['good', 'good', 'good', 'good', 'good', 'medium', 'medium', 'medium', 'risky', 'risky'];
const SALARY_BANDS = {
  good: [15000, 40000],
  medium: [8000, 15000],
  risky: [5000, 10000],
};

function assertIndex(index) {
  if (!Number.isInteger(index) || index < 0 || index > 999999) {
    throw new Error(`Pool index must be an integer in 0..999999, got ${index}`);
  }
}

function pad(n, width) {
  return String(n).padStart(width, '0');
}

/** Deterministic 0..1 from (index, salt): the pool must be identical on every run and on both sides. */
function unit(index, salt) {
  let t = (Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function isLoadTestId(id) {
  return typeof id === 'string' && id.length > POOL_PREFIX.length && id.startsWith(POOL_PREFIX);
}

export function isLoadTestEmail(email) {
  return typeof email === 'string' && email.startsWith(POOL_PREFIX) && email.endsWith(`@${EMAIL_DOMAIN}`);
}

export function employeeUid(index) {
  assertIndex(index);
  return `${EMPLOYEE_UID_PREFIX}${pad(index, 6)}`;
}

export function employeeEmail(index) {
  return `${employeeUid(index)}@${EMAIL_DOMAIN}`;
}

export function employerCountFor(poolSize) {
  return Math.max(1, Math.ceil(poolSize / EMPLOYEES_PER_EMPLOYER));
}

export function employerId(employerIndex) {
  assertIndex(employerIndex);
  return `${EMPLOYER_ID_PREFIX}${pad(employerIndex, 4)}`;
}

export function employerCode(employerIndex) {
  assertIndex(employerIndex);
  return `${EMPLOYER_CODE_PREFIX}${pad(employerIndex, 4)}`;
}

/** Round-robin, so consecutive iterations land on different employers. */
export function employerIndexFor(index, employerCount) {
  assertIndex(index);
  return index % employerCount;
}

export function profileFor(index) {
  assertIndex(index);
  return PROFILE_BY_DECILE[index % 10];
}

export function salaryFor(index) {
  const [min, max] = SALARY_BANDS[profileFor(index)];
  return min + Math.floor((unit(index, 1) * (max - min)) / 100) * 100;
}

/** Same formula as onEmployeeDocCreated, so that trigger rewrites the seeded value to itself. */
export function creditLimitFor(index) {
  return Math.max(Math.min(salaryFor(index) * EMPLOYEE_CREDIT_SALARY_RATIO, EMPLOYEE_CREDIT_CEILING), 0);
}

/** An amount requestLoan accepts for this employee: multiple of 100, within policy, credit line and 30% of salary. */
export function loanAmountFor(index) {
  const ceiling = Math.min(
    MAX_LOAN_AMOUNT,
    creditLimitFor(index),
    Math.round(salaryFor(index) * EMPLOYEE_CREDIT_SALARY_RATIO)
  );
  const max = Math.floor(ceiling / 100) * 100;
  const steps = (max - MIN_LOAN_AMOUNT) / 100;
  return MIN_LOAN_AMOUNT + Math.floor(unit(index, 2) * (steps + 1)) * 100;
}

function clabeFor(index) {
  const first17 = `012180${pad(index, 11)}`;
  const weights = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += ((first17.charCodeAt(i) - 48) * weights[i % 3]) % 10;
  return first17 + String((10 - (sum % 10)) % 10);
}

/** YYMMDD, unique for index % 10000, always an adult (born 1960-1989). Pure arithmetic: 28-day months, no Date. */
function birthDateFor(index) {
  const n = index % 10000;
  const year = 60 + Math.floor(n / 336);
  const month = 1 + Math.floor((n % 336) / 28);
  const day = 1 + (n % 28);
  return `${pad(year, 2)}${pad(month, 2)}${pad(day, 2)}`;
}

/**
 * Format-shaped but obviously synthetic identifiers. `NE` is the CURP state code
 * for "born abroad"; the RFC never ends in XXX / YYY, which the RiskSeal MOCK
 * (services/underwriting-service/src/riskseal-client.js) maps to a failing score.
 */
export function curpFor(index) {
  return `LTXX${birthDateFor(index)}HNELDT${pad(Math.floor(index / 10000), 2)}`;
}

export function rfcFor(index) {
  return `LTXX${birthDateFor(index)}L${pad(Math.floor(index / 10000), 2)}`;
}

/** Every RFC and CURP of the pool starts with this. */
export const POOL_RFC_PREFIX = 'LTXX';

/**
 * True only for an RFC rfcFor() can produce. No real taxpayer has one: the
 * second letter of a person's RFC is the first inner VOWEL of the surname (or
 * X when there is none), never "T", and a company's RFC has three letters
 * before the date, not four.
 *
 * Teardown uses this to find what the 6-stage pipeline's Stage 5 wrote: those
 * review_queue rows carry the applicant's RFC but NOT the loan id (requestLoan
 * does not send one to /underwrite), so `loanId` cannot find them.
 */
export function isPoolRfc(rfc) {
  return typeof rfc === 'string' && /^LTXX[6-8]\d(0[1-9]|1[0-2])(0[1-9]|1\d|2[0-8])L\d{2}$/.test(rfc);
}

/**
 * `employees/<uid>` exactly as the seed writes it.
 * `createdAt` is supplied by the caller (a server timestamp) so this stays pure.
 */
export function buildEmployeeDoc(index, employerCount) {
  const employerIndex = employerIndexFor(index, employerCount);
  const creditLimit = creditLimitFor(index);
  const name = `Load Test ${pad(index, 6)}`;
  return {
    name,
    fullName: name,
    email: employeeEmail(index),
    // No phone: nothing in this pool may ever be able to reach a real handset.
    phone: null,
    employerId: employerId(employerIndex),
    employerName: employerDisplayName(employerIndex),
    curp: curpFor(index),
    rfc: rfcFor(index),
    bankClabe: clabeFor(index),
    monthlySalary: salaryFor(index),
    salarySource: 'self_declared',
    creditLimit,
    availableCredit: creditLimit,
    payFrequency: 'semimonthly',
    // requestLoan's identity gate reads metamapStatus only; kycStatus is display.
    metamapStatus: 'verified',
    kycStatus: 'verified',
    isLoadTest: true,
    loadTestProfile: profileFor(index),
  };
}

export function employerDisplayName(employerIndex) {
  return `LOAD TEST ${pad(employerIndex, 4)} — interno, no usar`;
}

/**
 * `employers/<id>` exactly as the seed writes it.
 * @param {number} employerIndex
 * @param {number} slots  employees assigned to this employer (each may hold one open loan)
 */
export function buildEmployerDoc(employerIndex, slots) {
  return {
    companyName: employerDisplayName(employerIndex),
    employerCode: employerCode(employerIndex),
    // 'active' is one of the two statuses requestLoan admits.
    status: 'active',
    rfc: `LTE${pad(employerIndex, 6)}LT${employerIndex % 10}`,
    riskTier: 2,
    // requestLoan refuses once open loans >= maxActiveSlots. 'ops_override'
    // stops the due-diligence write in requestLoan from shrinking it back to a
    // tier default (10 / 3) in the middle of a run.
    maxActiveSlots: slots,
    maxActiveSlotsSource: 'ops_override',
    curpConfig: { mode: 'open', prefixes: [] },
    isLoadTest: true,
  };
}

/** How many of `poolSize` employees round-robin onto employer `employerIndex`. */
export function slotsFor(employerIndex, poolSize, employerCount) {
  const base = Math.floor(poolSize / employerCount);
  return base + (employerIndex < poolSize % employerCount ? 1 : 0);
}

// ── k6 side ─────────────────────────────────────────────────────────────────

/**
 * Which pool member iteration N uses. Each index is used at most once per run:
 * a second request from the same uid only measures the duplicate-application
 * guard, and a fourth only measures the rate limiter.
 *
 * @returns {number} pool index, or -1 when the pool is exhausted (the caller must stop, not wrap)
 */
export function poolIndexFor(iterationInTest, poolSize, poolOffset = 0) {
  if (!Number.isInteger(poolSize) || poolSize <= 0) throw new Error(`POOL_SIZE must be a positive integer, got ${poolSize}`);
  if (!Number.isInteger(poolOffset) || poolOffset < 0) throw new Error(`POOL_OFFSET must be an integer >= 0, got ${poolOffset}`);
  const index = poolOffset + iterationInTest;
  return index < poolSize ? index : -1;
}

/** What the k6 script sends for one pool member. `termDays` is the field requestLoan actually reads. */
export function buildPoolApplication(index) {
  return {
    userId: employeeUid(index),
    email: employeeEmail(index),
    profile: profileFor(index),
    payload: { amount: loanAmountFor(index), termDays: LOAN_TERM_DAYS },
  };
}

/**
 * The pool and the target have to agree, or the run measures sign-in failures:
 *
 *   production  never. The pool cannot exist there (the seed refuses), so a
 *               pool run would only send failed sign-ins and 401s at production.
 *   emulator    FIREBASE_AUTH_EMULATOR_HOST is mandatory — without it a
 *               FIREBASE_API_KEY would sign emulator users in against Google.
 *   staging     FIREBASE_AUTH_EMULATOR_HOST must be unset — a leftover one
 *               yields tokens the deployed target rejects (100% 401).
 *
 * @param {Record<string, string|undefined>} env
 * @param {'emulator'|'staging'|'production'} targetLabel  from ../target.js
 * @returns {string} the sign-in URL (see signInUrl)
 */
export function poolSignInUrl(env, targetLabel) {
  const emulatorHost = env.FIREBASE_AUTH_EMULATOR_HOST || '';
  if (targetLabel === 'production') {
    throw new Error(
      'POOL_SIZE is set but the target is PRODUCTION. The load-test pool is never seeded there, so every request ' +
        'would be a failed sign-in. Production has only the AUTH_TOKEN mode — docs/runbooks/scaling.md § Load test.'
    );
  }
  if (targetLabel === 'emulator' && !emulatorHost) {
    throw new Error(
      'The target is the emulator but FIREBASE_AUTH_EMULATOR_HOST is not set; pool members would be signed in ' +
        'against Google instead of the Auth emulator. Pass --env FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099.'
    );
  }
  if (targetLabel !== 'emulator' && emulatorHost) {
    throw new Error(
      `FIREBASE_AUTH_EMULATOR_HOST=${emulatorHost} is set but the target is ${targetLabel}; emulator tokens are ` +
        'rejected by a deployed target (every request would be a 401). Unset it.'
    );
  }
  return signInUrl(env);
}

/** Reads POOL_SIZE / POOL_OFFSET from k6's __ENV. Returns null when no pool is configured. */
export function poolConfigFromEnv(env) {
  if (env.POOL_SIZE === undefined || env.POOL_SIZE === '') return null;
  const size = Number(env.POOL_SIZE);
  const offset = env.POOL_OFFSET === undefined || env.POOL_OFFSET === '' ? 0 : Number(env.POOL_OFFSET);
  poolIndexFor(0, size, offset); // validates both
  if (offset >= size) throw new Error(`POOL_OFFSET (${offset}) must be below POOL_SIZE (${size})`);
  return { size, offset };
}

/**
 * Where to exchange email + password for an ID token.
 * With FIREBASE_AUTH_EMULATOR_HOST set this is the Auth emulator and never Google.
 */
export function signInUrl(env) {
  const key = env.FIREBASE_API_KEY || '';
  const path = 'identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';
  const emulator = env.FIREBASE_AUTH_EMULATOR_HOST;
  if (emulator) {
    if (!/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(emulator)) {
      throw new Error(`FIREBASE_AUTH_EMULATOR_HOST must be a loopback host:port, got ${emulator}`);
    }
    return `http://${emulator}/${path}?key=${key || 'emulator'}`;
  }
  if (!key) throw new Error('FIREBASE_API_KEY is not set (the Web API key of the target project).');
  return `https://${path}?key=${key}`;
}

/**
 * An UNSIGNED JWT (alg "none", empty signature). The Functions emulator decodes
 * App Check tokens without verifying them, but `enforceAppCheck` still rejects
 * a request that carries none — so even the emulator needs something in the
 * header. No deployed project accepts this: real verification checks the
 * signature against Google's keys.
 */
export const EMULATOR_APP_CHECK_TOKEN =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJsb2FkdGVzdC1lbXVsYXRvci1hcHAiLCJpc3MiOiJlbXVsYXRvci1vbmx5LXVuc2lnbmVkIn0.';

/**
 * How a run obtains its X-Firebase-AppCheck value. requestLoan has
 * enforceAppCheck: true, so a run without one is 100% HTTP 401 and measures
 * nothing — refuse it at init instead.
 *
 *   APP_CHECK_TOKEN        an already-exchanged App Check JWT. Fine for the
 *                          smoke profile; it expires (1 h by default), so it
 *                          cannot carry the 2-hour full profile.
 *   APP_CHECK_DEBUG_TOKEN  the debug token registered in the console. It is NOT
 *                          itself accepted in the header: it is exchanged for a
 *                          JWT, and re-exchanged before that expires. Needs
 *                          FIREBASE_PROJECT_ID, FIREBASE_APP_ID, FIREBASE_API_KEY.
 *   (emulator, neither)    the unsigned placeholder above.
 *
 * @param {Record<string, string|undefined>} env
 * @param {'emulator'|'staging'|'production'} targetLabel  from ../target.js
 * @returns {{ kind: 'static', token: string } | { kind: 'exchange', url: string, body: string }}
 */
export function appCheckPlan(env, targetLabel) {
  if (env.APP_CHECK_TOKEN) return { kind: 'static', token: env.APP_CHECK_TOKEN };
  if (env.APP_CHECK_DEBUG_TOKEN) {
    const missing = ['FIREBASE_PROJECT_ID', 'FIREBASE_APP_ID', 'FIREBASE_API_KEY'].filter((name) => !env[name]);
    if (missing.length > 0) {
      throw new Error(`APP_CHECK_DEBUG_TOKEN needs ${missing.join(', ')} to be exchanged for an App Check token.`);
    }
    return {
      kind: 'exchange',
      url:
        `https://firebaseappcheck.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}` +
        `/apps/${env.FIREBASE_APP_ID}:exchangeDebugToken?key=${env.FIREBASE_API_KEY}`,
      body: JSON.stringify({ debug_token: env.APP_CHECK_DEBUG_TOKEN }),
    };
  }
  if (targetLabel === 'emulator') return { kind: 'static', token: EMULATOR_APP_CHECK_TOKEN };
  throw new Error(
    'Neither APP_CHECK_DEBUG_TOKEN nor APP_CHECK_TOKEN is set. requestLoan enforces App Check, so every request ' +
      'would be rejected (401). Register a debug token on the target project — docs/runbooks/scaling.md § Load test.'
  );
}

/** Milliseconds to keep an exchanged token: 80% of the `ttl` ("3600s") the exchange returned, at least a minute. */
export function appCheckRefreshAfterMs(ttl) {
  const m = /^(\d+(?:\.\d+)?)s$/.exec(String(ttl));
  const seconds = m ? Number(m[1]) : 1800;
  return Math.max(60, seconds * 0.8) * 1000;
}

/**
 * Upper bound on iterations for a list of { target (req/min), duration ('30m') }
 * stages, as pipeline-load-test.js runs them: VUs = ceil(target / 10), ramped
 * linearly from the previous stage (k6 starts at 1 VU), each VU looping no
 * faster than once per `minIterationSeconds` (the script sleeps 5-7 s).
 *
 * Two terms. A VU alive for T seconds STARTS floor(T / 5) + 1 iterations (the
 * first at t = 0), so on top of VU-seconds / 5 there is one more start for
 * every VU that is ever started — the first one, plus every increase of the VU
 * target (a VU restarted after a ramp-down counts again).
 *
 * This is the pool size a run of that profile can consume. k6 ramps in whole
 * VUs, so treat it as a ceiling to stay above, not as a prediction.
 */
export function iterationUpperBound(stages, minIterationSeconds = 5) {
  let previousVus = 1;
  let vuMinutes = 0;
  let vuStarts = 1;
  for (const stage of stages) {
    const m = /^(\d+)m$/.exec(stage.duration);
    if (!m) throw new Error(`Unsupported stage duration ${stage.duration} (expected "<n>m")`);
    const vus = Math.max(1, Math.ceil(stage.target / 10));
    vuMinutes += ((previousVus + vus) / 2) * Number(m[1]);
    vuStarts += Math.max(0, vus - previousVus);
    previousVus = vus;
  }
  return Math.ceil((vuMinutes * 60) / minIterationSeconds) + vuStarts;
}
