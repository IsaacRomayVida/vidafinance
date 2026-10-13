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
const PRODUCTION_HOST_PATTERNS = [
  /(^|[.-])vida-finance\.cloudfunctions\.net$/,
  /^vida-finance\.(web\.app|firebaseapp\.com)$/,
  /-vida-finance-[a-z0-9]+-[a-z0-9]+\.a\.run\.app$/,
  /-production(-[a-z0-9]+)?\.up\.railway\.app$/,
];

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

function hostOf(url) {
  const m = /^https?:\/\/([^/:?#]+|\[[^\]]+\])/i.exec(url);
  return m ? m[1].toLowerCase() : null;
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
    throw new Error(
      `Unknown remote target ${host}. If this is the staging project, set LOAD_TEST_TARGET_ENV=staging.`
    );
  }
  return { url, label: 'staging' };
}
