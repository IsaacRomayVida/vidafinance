// services/shared is the only JavaScript in this repo that no ESLint config
// reached. It is not a package — no package.json, so no `lint` script of its
// own — and every sibling service's config is scoped to that service, so
// these files fell through the gap. They are not incidental: internal-secret.js
// is the service-to-service auth verifier the whole fleet depends on, and
// registry/ holds the ledger's hash chain and transaction guard.
//
// The root config deliberately ignores services/**, so this file is what
// governs here (ESLint resolves the nearest config to each file). It is linted
// from the repo root's `lint` script, which names this directory explicitly.
//
// Rules match the house style the services settled on: CommonJS under Node,
// unused variables are a warning rather than an error so pre-existing code is
// not rewritten to satisfy a linter, and console output is a warning because
// these modules log deliberately.

'use strict';

const NODE_GLOBALS = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  URL: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  AbortController: 'readonly',
  fetch: 'readonly',
};

const JEST_GLOBALS = {
  describe: 'readonly',
  it: 'readonly',
  test: 'readonly',
  expect: 'readonly',
  beforeAll: 'readonly',
  afterAll: 'readonly',
  beforeEach: 'readonly',
  afterEach: 'readonly',
  jest: 'readonly',
};

module.exports = [
  {
    ignores: ['**/node_modules/**', '**/coverage/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: NODE_GLOBALS,
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': 'warn',
      'no-console': 'warn',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['**/*.test.js', 'registry/testUtils.js'],
    languageOptions: {
      globals: { ...NODE_GLOBALS, ...JEST_GLOBALS },
    },
  },
];
