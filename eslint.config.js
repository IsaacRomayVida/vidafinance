'use strict';

// Flat config for the repo-root JavaScript (tests/**, scripts/**) that the
// legacy root .eslintrc.json used to cover through ESLint's old
// config-cascade before ESLint v10 dropped eslintrc support entirely.
// Every package under functions/, public-v2/, mobile/, and services/* now
// has its own eslint.config.js and lints itself independently (each is run
// with its cwd inside that package, so it finds its own nearest
// eslint.config.js and never this one) -- this file governs ONLY the
// root-level tests/ and scripts/ trees, and explicitly ignores every
// self-configuring package directory so exactly one config ever governs
// any given file, even if this were ever invoked as `eslint .` from the
// repo root.
//
// No @eslint/js / typescript-eslint / globals packages are installed at
// the repo root (same situation services/registry-service was in -- see
// that config's own comment), so this is written directly against
// ESLint's built-in rules and explicit global lists rather than extending
// a shared preset. That also means plain TypeScript files under scripts/
// (the scripts/migrations/**/*.ts migrations and tests/e2e's one .ts spec)
// are left alone here: parsing TS needs a TS-aware parser this repo
// doesn't have installed at the root, and they're already typechecked by
// `npm run typecheck:scripts` / functions' own tsc. The scripts this pass
// exists to cover -- the tripwire decision scripts and their .test.mjs
// siblings -- are all plain .js/.mjs.

const NODE_GLOBALS = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  process: 'readonly',
  console: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  Buffer: 'readonly',
  global: 'readonly',
  globalThis: 'readonly',
  setTimeout: 'readonly',
  setInterval: 'readonly',
  clearTimeout: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  queueMicrotask: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  fetch: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  structuredClone: 'readonly',
};

const JEST_GLOBALS = {
  describe: 'readonly',
  it: 'readonly',
  test: 'readonly',
  expect: 'readonly',
  beforeEach: 'readonly',
  afterEach: 'readonly',
  beforeAll: 'readonly',
  afterAll: 'readonly',
  jest: 'readonly',
};

// Puppeteer's page.evaluate(() => ...) callback body runs in the BROWSER,
// not Node, but ESLint still parses it as part of this file.
const BROWSER_GLOBALS = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  getComputedStyle: 'readonly',
};

// k6 (tests/load/**, run by the `k6` binary, not Node) supplies its own
// per-VU/iteration globals and its own `console`.
const K6_GLOBALS = {
  __ENV: 'readonly',
  __VU: 'readonly',
  __ITER: 'readonly',
  open: 'readonly',
  console: 'readonly',
};

module.exports = [
  // ---- scripts/**/*.js -- plain CommonJS Node scripts ----
  {
    files: ['scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...NODE_GLOBALS },
    },
    rules: {
      // Ported intent: the old root .eslintrc.json turned off unused-vars
      // checking entirely for plain JS files (both the core rule and the
      // @typescript-eslint variant, via its **/*.js override).
      'no-unused-vars': 'off',
      'no-console': 'warn',
      'consistent-return': 'error',
      'no-undef': 'error',
    },
  },
  // test-employer-login.js drives Puppeteer; its page.evaluate() callback
  // body is parsed as part of this file but executes in the browser.
  {
    files: ['scripts/test-employer-login.js'],
    languageOptions: {
      globals: { ...BROWSER_GLOBALS },
    },
  },

  // ---- scripts/**/*.mjs -- ES modules run under Node ----
  {
    files: ['scripts/**/*.mjs'],
    ignores: ['scripts/**/*.test.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...NODE_GLOBALS },
    },
    rules: {
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-console': 'warn',
      'consistent-return': 'error',
      'no-undef': 'error',
    },
  },

  // ---- scripts/**/*.test.mjs -- built-in node:test runner ----
  {
    files: ['scripts/**/*.test.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...NODE_GLOBALS },
    },
    rules: {
      'no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
      // Test bodies and assertion helpers branch on cases without a
      // trailing return in every one of these suites; that's normal
      // node:test/assert style, not a bug.
      'consistent-return': 'off',
      'no-undef': 'error',
    },
  },

  // ---- tests/**/*.js -- Jest ----
  {
    files: ['tests/**/*.js'],
    ignores: ['tests/load/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...NODE_GLOBALS, ...JEST_GLOBALS },
    },
    rules: {
      'no-unused-vars': 'off',
      // Audit/test scripts here print progress and results deliberately.
      'no-console': 'off',
      'consistent-return': 'error',
      'no-undef': 'error',
    },
  },
  // Puppeteer-driven scripts/specs under tests/.
  {
    files: [
      'tests/design-audit.js',
      'tests/employee-dash-test.js',
      'tests/e2e/**/*.js',
    ],
    languageOptions: {
      globals: { ...BROWSER_GLOBALS },
    },
  },

  // ---- tests/load/**/*.js -- k6 scripts (ESM + k6 runtime globals) ----
  {
    files: ['tests/load/**/*.js'],
    ignores: ['tests/load/generate-report.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...K6_GLOBALS },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
    },
  },
  // generate-report.js is a plain Node CommonJS script (run via `node`,
  // not by the k6 binary) -- it doesn't get k6 globals or ESM parsing.
  {
    files: ['tests/load/generate-report.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...NODE_GLOBALS },
    },
    rules: {
      'no-unused-vars': 'off',
      'no-console': 'off',
      'no-undef': 'error',
    },
  },

  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'dist/**',
      'lib/**',
      // Self-configuring packages -- each has its own eslint.config.js
      // and lints itself; this file must never govern their files.
      'functions/**',
      'public-v2/**',
      'mobile/**',
      'services/**',
      // TypeScript -- see file header for why these are out of scope.
      'scripts/migrations/**',
      'tests/e2e/loan-flow.e2e.test.ts',
      'tests/load/results/**',
    ],
  },
];
