/**
 * Environment detection for test-only conveniences.
 *
 * Test bypasses (auto-verifying an email, auto-activating an employer,
 * auto-passing identity validation) must key off the environment the code is
 * deployed into — never off attacker-supplied input. Gating on an email suffix
 * or a CURP prefix is not a gate at all: the person signing up picks both.
 *
 * The check fails closed. Anything we cannot positively identify as
 * non-production is treated as production.
 */

/** The live project. No override can enable a test bypass here. */
const PRODUCTION_PROJECT_ID = 'vida-finance';

/** Project id as populated by the Functions runtime. */
export function projectId(): string {
  return (
    process.env['GCLOUD_PROJECT'] ??
    process.env['GCP_PROJECT'] ??
    ''
  );
}

/** True only inside the Firebase emulator suite. */
export function isEmulator(): boolean {
  return process.env['FUNCTIONS_EMULATOR'] === 'true';
}

export function isProductionProject(): boolean {
  return projectId() === PRODUCTION_PROJECT_ID;
}

/**
 * Whether test-only bypasses may run.
 *
 * Allowed in the emulator, in `demo-*` emulator projects, and in any
 * non-production project that explicitly opts in with
 * `VIDA_ALLOW_TEST_BYPASS=true`. That opt-in is a deploy-time variable — it is
 * not reachable by anyone signing up — and it is ignored outright on the
 * production project.
 */
export function allowTestBypass(): boolean {
  // Hard stop: never on production, regardless of any other signal.
  if (isProductionProject()) return false;
  if (isEmulator()) return true;
  // `demo-<name>` is the Firebase convention for emulator-only projects.
  if (projectId().startsWith('demo-')) return true;
  if (process.env['VIDA_ALLOW_TEST_BYPASS'] === 'true') return true;
  // Unknown project id and no opt-in — assume production.
  return false;
}
