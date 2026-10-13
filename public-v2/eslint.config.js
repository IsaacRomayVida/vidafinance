import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // These three arrived with eslint-plugin-react-hooks 7.1.1, which this
      // project had to move to because 7.0.x caps its eslint peer at <=9 while
      // the repo is on eslint 10 — a mismatch that made `npm install` fail to
      // resolve at all, and so blocked every security patch including the
      // react-router advisory.
      //
      // They reported 8 findings across five dashboard pages. Five were real
      // and are fixed: a helper read before its declaration (AlertsPage),
      // Date.now() called during render behind the invite TTL and resend
      // cooldown (EmployeeRoster), a loan-amount clamp that let an
      // out-of-range slider value reach the screen for a frame (LoanWizard),
      // and a ?role= param applied in a mount effect, so the role picker
      // flashed even when the URL already answered it (Onboarding).
      //
      // immutability and purity are clean, so they are errors — nothing may
      // reintroduce them.
      'react-hooks/immutability': 'error',
      'react-hooks/purity': 'error',

      // Three set-state-in-effect findings remain and are deliberate: two in
      // LoanWizard and one in SystemHealth that set a loading/reset state at
      // the start of a fetch-or-subscribe effect. That is react.dev's own
      // documented pattern, and each is already guarded against the real risk
      // — a cancelled flag, a subscription cleanup, and in SystemHealth a
      // request-id guard added alongside this work, because overlapping mount,
      // interval and manual refreshes could let a stale response clobber a
      // newer one. Moving the call into the async continuation would be the
      // same tick and the same behaviour, so the rule stays a warning rather
      // than being satisfied cosmetically.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
])
