import { describe, expect, it } from 'vitest';
import { TEST_EMAIL_SUFFIX, testBypassAllowed } from './testBypass';

/**
 * Regression guard for the onboarding KYC bypass.
 *
 * Before this gate, Onboarding.tsx's `startKYC()` short-circuited on
 * `memData.email.endsWith('@vida-test.com')` alone. That address is typed into
 * the signup form, so on the deployed site anyone could register
 * `attacker@vida-test.com`, never open the MetaMap widget, and still have
 * `kycStatus: 'approved'` written onto their own `employees/{uid}` document
 * (Onboarding.tsx's createEmployeeAccount). `LoanWizard.tsx`'s eligibility
 * check reads exactly that field and is the only KYC gate anywhere on the
 * borrowing path — `requestLoan` never looks at it, and the MetaMap webhook
 * writes `metamapStatus`, never `kycStatus`, so nothing server-side ever
 * corrects the value the browser chose.
 *
 * The assertion that matters is the `false` one: a built bundle must refuse
 * the shortcut no matter what address is supplied.
 */
describe('testBypassAllowed', () => {
  it('refuses the bypass in a non-dev build even for a test address', () => {
    expect(testBypassAllowed(`attacker${TEST_EMAIL_SUFFIX}`, false)).toBe(false);
    expect(testBypassAllowed(`ATTACKER${TEST_EMAIL_SUFFIX.toUpperCase()}`, false)).toBe(false);
    expect(testBypassAllowed(`  spaced${TEST_EMAIL_SUFFIX}  `, false)).toBe(false);
  });

  it('allows the bypass in a dev build for a test address', () => {
    expect(testBypassAllowed(`e2e${TEST_EMAIL_SUFFIX}`, true)).toBe(true);
  });

  it('refuses a non-test address even in a dev build', () => {
    expect(testBypassAllowed('real.borrower@gmail.com', true)).toBe(false);
    // Suffix, not substring: the address has to END with it.
    expect(testBypassAllowed(`${TEST_EMAIL_SUFFIX}@evil.example`, true)).toBe(false);
  });

  it('defaults to import.meta.env.DEV when the caller passes no flag', () => {
    // Vitest runs with DEV true, so the default-bound call must agree with an
    // explicit `true`. This is what pins the production default to the build
    // flag rather than to a hardcoded constant that could drift.
    expect(import.meta.env.DEV).toBe(true);
    expect(testBypassAllowed(`e2e${TEST_EMAIL_SUFFIX}`)).toBe(
      testBypassAllowed(`e2e${TEST_EMAIL_SUFFIX}`, true),
    );
  });

  it('tolerates a non-string email without throwing', () => {
    expect(testBypassAllowed(undefined as unknown as string, true)).toBe(false);
  });
});
