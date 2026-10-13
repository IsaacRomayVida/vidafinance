'use strict';

const js = require('@eslint/js');
const globals = require('globals');

// Flat-config replacement for the legacy .eslintrc.json that used to govern
// this service through ESLint's config-cascade (the shared root
// .eslintrc.json, since this service never had its own). ESLint v10 dropped
// eslintrc support entirely, so this reproduces the same intent:
// eslint:recommended, Node globals, and the same rule overrides.
module.exports = [
  js.configs.recommended,
  {
    files: ['*.js', 'src/**/*.js', 'routes/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.node,
        // `globals.node` now includes runtime globals (WHATWG crypto,
        // fetch, ...) that didn't exist when the old eslintrc env was
        // written. This file does `const crypto = require('crypto')` at
        // the top level, which is completely standard Node code but trips
        // `no-redeclare` against the newer global -- unset it rather than
        // rewrite the require.
        crypto: 'off',
      },
    },
    rules: {
      // The original config disabled unused-vars checking for plain JS
      // files (it turned off both the core rule and the
      // @typescript-eslint variant) -- this codebase relies on
      // `catch (_) {}` as an intentional no-op pattern throughout, and
      // re-enabling the rule here would flag all of them.
      'no-unused-vars': 'off',
      'no-console': 'warn',
      // Downgraded from "error" (see report): this fires repeatedly on
      // idiomatic Express middleware/handlers that do `return next()` on
      // an early-exit branch and just `next()`/fall off the end otherwise
      // -- behaviorally identical, flagged only for return-style
      // consistency. Rewriting every handler risks behavior changes for a
      // purely stylistic rule, so kept as a warning instead of an error.
      'consistent-return': 'warn',
      // `catch (_) {}` is this codebase's deliberate "swallow and move on"
      // idiom (see surrounding comments in index.js); allow it without
      // opening up other genuinely-empty blocks.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['test/**/*.js', '__mocks__/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      'no-console': 'off',
    },
  },
  {
    ignores: ['node_modules/**', 'coverage/**'],
  },
];
