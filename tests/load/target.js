/**
 * Load-test target resolution — which environment is about to take the load.
 *
 * The script used to default STAGING_URL to
 * https://us-central1-vida-finance.cloudfunctions.net. `vida-finance` is the
 * PRODUCTION Firebase project (.firebaserc default; its /api/health answers
 * 200), so a bare `npm run load-test` sent up to 28 VUs of real loan requests
 * at production. Now there is no default, and production is refused unless the
 * operator types the sign-off phrase. See docs/runbooks/scaling.md § Load test.
 *
 * Pure ESM with no k6 or Node imports: k6 runs it, and tests/load/target.test.mjs
 * tests it under `node --test`. (No `URL` global — k6 does not ship one.)
 */

export const PRODUCTION_SIGN_OFF = 'I-HAVE-OPS-SIGN-OFF';

// Hosts that ARE production. Mirrors .firebaserc and scripts/production-endpoints.json.
//
// Gen-2 functions are Cloud Run services, and a Cloud Run host does NOT carry
// the project id. It carries one of two project-specific tokens instead:
//   <service>-<project hash>-<region code>.a.run.app   e.g. api-gd5fcu677q-uc.a.run.app
//   <service>-<project number>.<region>.run.app        e.g. api-447766605132.us-central1.run.app
// `gd5fcu677q` is vida-finance's hash (the live API host probed by
// e2e-test-v18.mjs) and 447766605132 is its project number (messagingSenderId
// in public-v2/src/lib/firebase.ts). Both are fixed for the life of the project.
// (A `-vida-finance-…a.run.app` pattern used to sit in this list. Cloud Run
// never puts the project id in a host, so it could only ever match somebody
// else's service that happened to be NAMED `…-vida-finance`; it was removed.)
export const PRODUCTION_PROJECT_ID = 'vida-finance';
export const PRODUCTION_RUN_HASH = 'gd5fcu677q';
export const PRODUCTION_PROJECT_NUMBER = '447766605132';
/**
 * Production's Web API key (`apiKey` in public-v2/src/lib/firebase.ts). Not a
 * secret — it ships in the web bundle — but a run that carries it signs users
 * in, or exchanges App Check tokens, against the production project.
 */
export const PRODUCTION_WEB_API_KEY = 'AIzaSyD5FFDHe2mAtqfBBw6vz4-V2WflvTxCTEw';

const PRODUCTION_HOST_PATTERNS = [
  /(^|[.-])vida-finance\.cloudfunctions\.net$/,
  /^vida-finance\.(web\.app|firebaseapp\.com)$/,
  new RegExp(`(^|-)${PRODUCTION_RUN_HASH}-[a-z0-9]+\\.a\\.run\\.app$`),
  new RegExp(`(^|-)${PRODUCTION_PROJECT_NUMBER}\\.[a-z0-9-]+\\.run\\.app$`),
  /-production(-[a-z0-9]+)?\.up\.railway\.app$/,
];

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** Quotes and whitespace an operator's shell or .env file may have left round a value. */
function bare(value) {
  return String(value ?? '').replace(/^[\s'"`]+|[\s'"`]+$/g, '');
}

/**
 * Same rule as the seed (seed/guard.mjs): the exact id, anything that calls
 * itself production — and the project NUMBER. Google's REST paths accept the
 * number wherever they accept the id (`/v1/projects/447766605132/apps/…` is the
 * production project), so FIREBASE_PROJECT_ID=<number> addresses production too.
 */
function isProductionProjectId(id) {
  const normalised = bare(id).toLowerCase();
  return normalised === PRODUCTION_PROJECT_ID || normalised === PRODUCTION_PROJECT_NUMBER || /prod/.test(normalised);
}

/**
 * A host written as bare numbers — 0.0.0.0, 127.1, 2130706433, 0x7f.0.0.1 — or
 * as an IPv6 literal. Several of those ARE this machine, but only the three
 * LOCAL_HOSTS spellings get the emulator checks, so none of the others may pass
 * as "staging" on the operator's word.
 */
function isRawAddress(host) {
  return /^\[.*\]$/.test(host) || /^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/.test(host);
}

/** Path segments of a URL, percent-decoded, without the empty, `.` and `..` ones. */
function pathSegments(url) {
  const path = /^https?:\/\/[^/?#]*([^?#]*)/i.exec(url);
  return (path ? path[1] : '')
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .filter((segment) => segment && segment !== '.' && segment !== '..');
}

/** What a FIREBASE_PROJECT_ID must look like before it is compared with production or put in a URL. */
export const FIREBASE_PROJECT_ID_SHAPE = /^[a-z0-9-]+$/;

/**
 * Production named anywhere in the Firebase variables of a run — independently
 * of TARGET_URL. The host guard below only sees where requestLoan is called;
 * these three decide which project signs the users in and issues the App Check
 * token, and a staging TARGET_URL does not make a production key harmless.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {string[]} one line per production identifier found (or malformed project id); empty when there is none
 */
export function productionIdentifiers(env) {
  const found = [];
  const projectId = env.FIREBASE_PROJECT_ID || '';
  // Shape first, compare second. A project id (or number) is only ever
  // lower-case letters, digits and hyphens; anything else is not compared at
  // all. The comparison below cannot see that `vida%2Dfinance` or
  // `x/../vida-finance` reach production once they sit in a REST path, and
  // appCheckPlan puts this value in one.
  if (projectId && !FIREBASE_PROJECT_ID_SHAPE.test(projectId)) {
    found.push(
      `FIREBASE_PROJECT_ID=${JSON.stringify(projectId)} is not a Firebase project id ` +
        '(lower-case letters, digits and hyphens only — no quotes, spaces, slashes or percent signs)'
    );
  } else if (projectId && isProductionProjectId(projectId)) {
    found.push(`FIREBASE_PROJECT_ID=${projectId} is the PRODUCTION project (its id or its project number, or it names itself production)`);
  }
  // 1:<project number>:web:<hash>
  if (bare(env.FIREBASE_APP_ID).split(':')[1] === PRODUCTION_PROJECT_NUMBER) {
    found.push(`FIREBASE_APP_ID belongs to project number ${PRODUCTION_PROJECT_NUMBER}, the PRODUCTION project`);
  }
  // Contained, not equal: a quoted or padded copy of the key is still that key.
  if (String(env.FIREBASE_API_KEY || '').includes(PRODUCTION_WEB_API_KEY)) {
    found.push("FIREBASE_API_KEY is the PRODUCTION project's Web API key");
  }
  return found;
}

/** @throws when `productionIdentifiers(env)` finds anything. `what` names the thing that would have used them. */
export function assertNoProductionIdentifiers(env, what) {
  const found = productionIdentifiers(env);
  if (found.length > 0) {
    throw new Error(
      `Refusing ${what}: ${found.join('; ')}. This holds whatever TARGET_URL says, and no flag overrides it — ` +
        'use the identifiers of the NON-production project (docs/runbooks/scaling.md § Load test, H1 and H2).'
    );
  }
}

function hostOf(url) {
  const authority = /^https?:\/\/([^/?#]*)/i.exec(url);
  // Userinfo (`user:pass@host`) would let `localhost:x@<prod host>` read as localhost.
  if (!authority || authority[1].includes('@')) return null;
  const m = /^([^:]+|\[[^\]]+\])(:\d*)?$/.exec(authority[1]);
  // A trailing dot is the same host; strip it so the `$`-anchored patterns still match.
  return m ? m[1].toLowerCase().replace(/\.+$/, '') || null : null;
}

/**
 * @param {Record<string, string|undefined>} env  k6's __ENV (or process.env in tests)
 * @returns {{ url: string, label: 'emulator'|'staging'|'production' }}
 * @throws  when the target is missing, unparseable, unknown, or production without sign-off
 */
export function resolveTarget(env) {
  // STAGING_URL is the old name; still honoured so existing notes keep working.
  const raw = env.TARGET_URL || env.STAGING_URL || '';
  if (!raw) {
    throw new Error(
      'TARGET_URL is not set. There is deliberately no default — the old default was production. ' +
        'Set it to a NON-production target. ' +
        'Emulator: TARGET_URL=http://127.0.0.1:<functions-port>/<project>/us-central1'
    );
  }
  const url = raw.replace(/\/+$/, '');
  const host = hostOf(url);
  if (!host) throw new Error(`TARGET_URL is not an http(s) URL: ${raw}`);

  if (LOCAL_HOSTS.includes(host)) {
    // http://127.0.0.1:<port>/<project>/<region>. An emulator started under the
    // real project id serves local functions that talk to PRODUCTION Firestore
    // and Auth for every emulator that is not running. Every segment is read,
    // decoded: `//vida-finance`, `/x/../vida-finance` and `/%76ida-finance` all
    // reach the same emulator route as `/vida-finance`.
    const project = pathSegments(url).find(isProductionProjectId);
    if (project) {
      throw new Error(
        `Refusing: the emulator URL names the project "${project}", which is PRODUCTION. ` +
          'Start the emulators with a demo-* project (--project demo-vida-load); a demo-* project can never reach Google.'
      );
    }
    return { url, label: 'emulator' };
  }

  if (PRODUCTION_HOST_PATTERNS.some((re) => re.test(host))) {
    if (env.LOAD_TEST_ALLOW_PRODUCTION !== PRODUCTION_SIGN_OFF) {
      throw new Error(
        `Refusing: ${host} is PRODUCTION. Every iteration creates a real loan request. ` +
          `Follow docs/runbooks/scaling.md § Load test, then set LOAD_TEST_ALLOW_PRODUCTION=${PRODUCTION_SIGN_OFF}.`
      );
    }
    return { url, label: 'production' };
  }

  if (isRawAddress(host)) {
    throw new Error(
      `Refusing: ${host} is a raw address. The emulator is addressed as 127.0.0.1, localhost or [::1] ` +
        '(0.0.0.0, 127.1 and the like are this machine too, but skip the emulator checks); a deployed target is addressed by its host name.'
    );
  }

  // Any other remote host: no staging URL is recorded in-tree, so we cannot
  // tell staging from something else. Make the operator say which it is.
  if (env.LOAD_TEST_TARGET_ENV !== 'staging') {
    const runApp = /\.run\.app$/.test(host)
      ? ' A Cloud Run host does not name its project — confirm which project owns it before declaring it staging.'
      : '';
    throw new Error(
      `Unknown remote target ${host}. If this is the staging project, set LOAD_TEST_TARGET_ENV=staging.${runApp}`
    );
  }
  return { url, label: 'staging' };
}

export const PROFILES = ['full', 'smoke'];

/**
 * The profile a run uses: `full` when PROFILE is unset, otherwise exactly
 * `full` or `smoke`. The script used to run the two-hour full ramp for ANY
 * value that was not `smoke` — `PROFILE=Smoke` or `PROFILE=ramp` — while its
 * report, which compared against 'full', said the 2x stage was never reached.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {'full'|'smoke'}
 */
export function resolveProfile(env) {
  const profile = env.PROFILE || 'full';
  if (!PROFILES.includes(profile)) {
    throw new Error(`Unknown PROFILE=${profile}. Use PROFILE=smoke (5 minutes) or PROFILE=full (2 hours, the default) — lower case.`);
  }
  return profile;
}

/**
 * The same decision as resolveTarget, phrased for an operator at a terminal
 * rather than thrown from inside k6's init stage (where it arrives wrapped in
 * a stack trace). tests/load/preflight.mjs prints it; the `npm run load-test*`
 * scripts run that before k6.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{ ok: true, target: { url: string, label: string }, message: string }
 *          | { ok: false, message: string }}
 */
export function preflight(env) {
  let target;
  try {
    target = resolveTarget(env);
  } catch (err) {
    return {
      ok: false,
      message: [
        'Load test not started.',
        '',
        `  ${err.message}`,
        '',
        'Set TARGET_URL to a non-production target, as a SHELL variable in front of the npm script.',
        '(`k6 run --env TARGET_URL=…` is read by k6 only; this check runs before k6 and does not see it.)',
        'For example:',
        '  TARGET_URL=http://127.0.0.1:5011/demo-vida-load/us-central1 npm run load-test:smoke   # local emulator',
        '  TARGET_URL=https://us-central1-<STAGING_PROJECT>.cloudfunctions.net LOAD_TEST_TARGET_ENV=staging npm run load-test',
        '',
        'Why production is refused: every iteration POSTs a real loan request. It writes loan and',
        'audit documents and reaches the live credit bureau and fraud providers. Nothing here',
        'defaults to production, on purpose.',
        'Runbook: docs/runbooks/scaling.md § Load test',
      ].join('\n'),
    };
  }
  return { ok: true, target, message: `Load-test target: ${target.label.toUpperCase()}  ${target.url}` };
}
