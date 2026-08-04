/**
 * Client-side counterpart of functions/src/utils/environment.ts.
 *
 * The backend already learned this lesson three times over (index.ts's
 * validateCURP bypass, autoVerifyOnEmployerCreate, autoVerifyOnEmployeeCreate):
 * a test-only shortcut must key off the ENVIRONMENT the code is running in,
 * never off a value the person signing up chooses. `allowTestBypass()` there
 * hard-refuses on the production project and treats anything it cannot
 * positively identify as non-production as production.
 *
 * The onboarding wizard's KYC shortcut had no such gate: it keyed on the email
 * suffix alone, which the signer-upper types into the form. So on the live site
 * anyone could register `whatever@vida-test.com`, skip the MetaMap identity
 * check entirely, and have `kycStatus: 'approved'` written onto their own
 * employees/{uid} document — the field LoanWizard.tsx reads as its (only)
 * pre-borrowing identity gate.
 *
 * This module lives in `lib/` rather than inside Onboarding.tsx because a
 * component module may only export components (react-refresh/only-export-
 * components is a CI-blocking lint error here), and because the gate is only
 * worth having if it is directly unit-testable — see testBypass.test.ts.
 */

/** The email suffix the repo's test fixtures use end to end. */
export const TEST_EMAIL_SUFFIX = '@vida-test.com';

/**
 * Whether a test-only shortcut may run for this email.
 *
 * `isDevBuild` defaults to Vite's `import.meta.env.DEV`, which is true under
 * `vite dev` and under Vitest and false in EVERY built bundle — production,
 * staging and preview alike. It is a parameter so the production branch can be
 * asserted without stubbing the module graph; callers should not pass it.
 *
 * Fails closed: a non-dev build is refused regardless of the address.
 */
export function testBypassAllowed(
  email: string,
  isDevBuild: boolean = import.meta.env.DEV === true,
): boolean {
  if (!isDevBuild) return false;
  if (typeof email !== 'string') return false;
  return email.trim().toLowerCase().endsWith(TEST_EMAIL_SUFFIX);
}
