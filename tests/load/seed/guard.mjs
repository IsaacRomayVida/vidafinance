/**
 * Where the load-test seed is allowed to write — decided before the Admin SDK
 * is even imported. Pure: no I/O, no firebase-admin. `node --test
 * tests/load/seed/guard.test.mjs` pins every branch.
 *
 * Three outcomes, and no flag reaches a fourth:
 *   emulator  — the default. Both emulator hosts set, loopback, demo-* project.
 *   project   — a real NON-production project, named with an explicit --project.
 *   refused   — everything else, and the production project always.
 */

import { DEFAULT_POOL_SIZE, employerCountFor } from './pool.js';

/**
 * The live project (.firebaserc default; functions/src/utils/environment.ts
 * PRODUCTION_PROJECT_ID). There is deliberately NO override for this list:
 * a load-test pool has no business in production, and a production smoke test
 * (checklist B8) is a human decision with its own, hand-made fixture.
 */
export const PRODUCTION_PROJECT_IDS = Object.freeze(['vida-finance']);
export const EMULATOR_DEFAULT_PROJECT = 'demo-vida-load';
export const MIN_PASSWORD_LENGTH = 16;
/** Emulator only. A real project always needs LOAD_TEST_PASSWORD from the operator. */
export const EMULATOR_PASSWORD = 'loadtest-emulator-only-password';

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]):\d+$/;

export class SeedRefusal extends Error {}

function refuse(message) {
  throw new SeedRefusal(`Refusing: ${message}`);
}

export function isProductionProjectId(id) {
  const normalised = String(id ?? '').trim().toLowerCase();
  // The exact id, plus anything that calls itself production. Over-refusing costs a rename; under-refusing costs real borrowers.
  return PRODUCTION_PROJECT_IDS.includes(normalised) || /prod/.test(normalised);
}

/**
 * @param {string[]} argv  process.argv.slice(2)
 */
export function parseArgs(argv) {
  const opts = {
    count: DEFAULT_POOL_SIZE,
    employers: null,
    project: null,
    dryRun: false,
    teardown: false,
    concurrency: 20,
    help: false,
  };
  const number = (flag, raw, min) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) throw new SeedRefusal(`${flag} must be an integer >= ${min}, got ${raw}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new SeedRefusal(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--teardown') opts.teardown = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--count') opts.count = number(arg, value(), 1);
    else if (arg === '--employers') {
      throw new SeedRefusal(
        '--employers was removed. Which employer a member belongs to is now a function of the member index alone ' +
          '(50 employers per 2,500 members), so that a pool can be grown while loans are open without moving ' +
          'anyone. A hand-picked employer count would bring the reshuffle back.'
      );
    }
    else if (arg === '--concurrency') opts.concurrency = number(arg, value(), 1);
    else if (arg === '--project') opts.project = value();
    else throw new SeedRefusal(`Unknown argument ${arg} (there is no flag that allows production)`);
  }
  if (opts.count > 1000000) throw new SeedRefusal('--count must be at most 1000000');
  // Reported in the plan only; nothing downstream takes an employer count from the caller.
  opts.employers = employerCountFor(opts.count);
  if (opts.concurrency > 100) throw new SeedRefusal('--concurrency must be at most 100');
  return opts;
}

/**
 * @param {{ project: string|null }} opts
 * @param {Record<string, string|undefined>} env  process.env
 * @param {string|null} [credentialsProjectId]  `project_id` of the service-account key in use, if one could be read
 * @returns {{ mode: 'emulator'|'project', projectId: string }}
 */
export function resolveSeedTarget(opts, env, credentialsProjectId = null) {
  const firestoreHost = env.FIRESTORE_EMULATOR_HOST || '';
  const authHost = env.FIREBASE_AUTH_EMULATOR_HOST || '';

  // Production is refused wherever it is named — even "only as an emulator
  // project id" — so no combination of flags and environment gets past this.
  for (const [label, id] of [
    ['--project', opts.project],
    ['GCLOUD_PROJECT', env.GCLOUD_PROJECT],
    ['GOOGLE_CLOUD_PROJECT', env.GOOGLE_CLOUD_PROJECT],
    ['the service-account key', credentialsProjectId],
  ]) {
    if (id && isProductionProjectId(id)) {
      refuse(`${label} is "${id}", the PRODUCTION project. The load-test pool is never seeded there and no flag changes that.`);
    }
  }

  if (Boolean(firestoreHost) !== Boolean(authHost)) {
    refuse(
      'only one of FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST is set. ' +
        'Half of the writes would go to the emulator and half to a real project.'
    );
  }

  if (firestoreHost) {
    for (const [name, host] of [
      ['FIRESTORE_EMULATOR_HOST', firestoreHost],
      ['FIREBASE_AUTH_EMULATOR_HOST', authHost],
    ]) {
      if (!LOOPBACK.test(host)) refuse(`${name}="${host}" is not a loopback host:port.`);
    }
    const projectId = opts.project || env.GCLOUD_PROJECT || EMULATOR_DEFAULT_PROJECT;
    if (!projectId.startsWith('demo-')) {
      refuse(`emulator runs need a demo-* project id (got "${projectId}"); a demo-* project can never reach Google.`);
    }
    return { mode: 'emulator', projectId };
  }

  if (!opts.project) {
    refuse(
      'no emulator is configured and no --project was given. Default: run under ' +
        '`firebase emulators:exec --only firestore,auth --project demo-vida-load "<this command>"`. ' +
        'For a real NON-production project pass --project <id> explicitly (GCLOUD_PROJECT is not enough).'
    );
  }
  if (opts.project.startsWith('demo-')) {
    refuse(`"${opts.project}" is an emulator-only project id, but no emulator hosts are set.`);
  }
  if (credentialsProjectId && credentialsProjectId !== opts.project) {
    refuse(`the service-account key belongs to "${credentialsProjectId}", not to --project "${opts.project}".`);
  }
  return { mode: 'project', projectId: opts.project };
}

/**
 * The password every pool account gets. k6 needs the same value (LOAD_TEST_PASSWORD).
 * Never logged by the seed.
 */
export function resolvePassword(mode, env) {
  const supplied = env.LOAD_TEST_PASSWORD || '';
  if (mode === 'emulator') return supplied || EMULATOR_PASSWORD;
  if (supplied.length < MIN_PASSWORD_LENGTH) {
    refuse(
      `LOAD_TEST_PASSWORD must be set to at least ${MIN_PASSWORD_LENGTH} characters for a real project ` +
        '(generate one, e.g. `openssl rand -base64 24`; pass the same value to k6).'
    );
  }
  if (supplied === EMULATOR_PASSWORD) refuse('LOAD_TEST_PASSWORD is the emulator default; generate a real one.');
  return supplied;
}

/**
 * Variables that make an EMULATED requestLoan call a real service.
 * `firebase emulators:exec` hands the parent shell's environment — and
 * functions/.env* — to the emulated functions, so an operator who has
 * UNDERWRITING_SERVICE_URL or ML_SERVICE_URL exported (a production shell, a
 * sourced .env) would have the "local" check post synthetic CURPs to the real
 * underwriting pipeline (bureau, RiskSeal, Stage 5) or the real ML service.
 */
export const FUNCTIONS_PROVIDER_VARS = Object.freeze(['UNDERWRITING_SERVICE_URL', 'ML_SERVICE_URL']);

/**
 * Is `name` (a file directly inside functions/) one the Functions emulator
 * loads variables from? `.env`, `.env.<project>`, `.env.local` — and
 * `.secret.local`, the emulator's override file for `defineSecret` values,
 * which is the same KEY=VALUE format and reaches the emulated functions just
 * the same. `*.example` files are templates and are never loaded.
 */
export function isFunctionsEnvFile(name) {
  if (name.endsWith('.example')) return false;
  return name === '.secret.local' || name === '.env' || name.startsWith('.env.');
}

/**
 * @param {Record<string, string|undefined>} env  process.env
 * @param {Array<{ name: string, text: string }>} [envFiles]  the files of functions/ that isFunctionsEnvFile() accepts
 * @returns {string[]} one line per place a provider URL is set; empty when the emulated functions can reach nothing
 */
export function functionsProviderLeaks(env, envFiles = []) {
  const leaks = [];
  for (const name of FUNCTIONS_PROVIDER_VARS) {
    if (env[name]) leaks.push(`${name} is set in the environment`);
    for (const file of envFiles) {
      const assigned = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=[ \\t]*['"]?[^\\s'"#]`, 'm').test(file.text);
      if (assigned) leaks.push(`${name} is set in ${file.name}`);
    }
  }
  return leaks;
}
