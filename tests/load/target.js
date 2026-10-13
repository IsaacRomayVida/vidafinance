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
// The older `-vida-finance-…a.run.app` pattern matched no URL Cloud Run issues.
export const PRODUCTION_RUN_HASH = 'gd5fcu677q';
export const PRODUCTION_PROJECT_NUMBER = '447766605132';

const PRODUCTION_HOST_PATTERNS = [
  /(^|[.-])vida-finance\.cloudfunctions\.net$/,
  /^vida-finance\.(web\.app|firebaseapp\.com)$/,
  /-vida-finance-[a-z0-9]+-[a-z0-9]+\.a\.run\.app$/,
  new RegExp(`(^|-)${PRODUCTION_RUN_HASH}-[a-z0-9]+\\.a\\.run\\.app$`),
  new RegExp(`(^|-)${PRODUCTION_PROJECT_NUMBER}\\.[a-z0-9-]+\\.run\\.app$`),
  /-production(-[a-z0-9]+)?\.up\.railway\.app$/,
];

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

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

  if (LOCAL_HOSTS.includes(host)) return { url, label: 'emulator' };

  if (PRODUCTION_HOST_PATTERNS.some((re) => re.test(host))) {
    if (env.LOAD_TEST_ALLOW_PRODUCTION !== PRODUCTION_SIGN_OFF) {
      throw new Error(
        `Refusing: ${host} is PRODUCTION. Every iteration creates a real loan request. ` +
          `Follow docs/runbooks/scaling.md § Load test, then set LOAD_TEST_ALLOW_PRODUCTION=${PRODUCTION_SIGN_OFF}.`
      );
    }
    return { url, label: 'production' };
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
        'Set TARGET_URL to a non-production target, for example:',
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
