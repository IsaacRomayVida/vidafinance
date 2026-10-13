'use strict';

const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const globals = require('globals');

// Flat-config replacement for the legacy .eslintrc.json that used to govern
// this service through ESLint's config-cascade (the shared root
// .eslintrc.json, since this service never had its own). ESLint v10 dropped
// eslintrc support entirely, so this reproduces the same intent:
// eslint:recommended + @typescript-eslint/recommended, Node globals, and
// the same rule overrides.
module.exports = [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-console': 'warn',
      // See payment-server/pdf-generator eslint.config.js for why this is
      // "warn" here too: this repo's Express handlers routinely mix
      // `return res.xxx(...)` on early-exit branches with a bare call (or
      // falling off the end) otherwise -- behaviorally identical, flagged
      // only for return-style consistency.
      'consistent-return': 'warn',
      // `catch (_) {}` is this codebase's deliberate "swallow and move on"
      // idiom (see src/index.ts); allow it without opening up other
      // genuinely-empty blocks.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['test/**/*.ts', '__mocks__/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    ignores: ['node_modules/**', 'coverage/**', 'dist/**'],
  },
];
