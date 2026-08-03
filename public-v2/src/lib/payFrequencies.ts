// Keep in sync with the PayFrequency union in
// functions/src/loans/calculateNextPayrollDate.ts — every value offered here
// must be one calculateNextPayrollDate has a real branch for (#435). A value
// outside that union falls through to its `default` case and is silently
// priced as 'monthly'.
//
// public-v2 and functions are separate TypeScript projects with no shared
// package, so this array can't import that union — Onboarding.payFrequency
// .test.ts is what actually enforces the sync, in both directions: it fails
// on a value added here that calculateNextPayrollDate doesn't handle, AND on
// a value calculateNextPayrollDate handles that's missing here.
//
// This lives in its own module rather than in Onboarding.tsx because the
// onboarding form and its regression test both need it, and a component file
// that also exports constants breaks React Fast Refresh
// (react-refresh/only-export-components).
export const PAY_FREQUENCIES = ['weekly', 'semimonthly', 'biweekly', 'monthly'];
