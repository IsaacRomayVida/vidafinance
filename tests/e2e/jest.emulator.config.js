/**
 * Separate from jest.config.js on purpose: those tests (public-smoke,
 * employer-login) are plain-JS Puppeteer runs against a live app URL. This
 * config is for TypeScript suites that import functions/src directly and
 * need a Firestore emulator — see loan-flow.e2e.test.ts and
 * package.json's test:e2e:loan-flow script. Keeping them apart means
 * `npm run test:e2e` (testMatch: **\/*.test.js) is untouched by this file.
 */
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testTimeout: 60000,
  rootDir: __dirname,
  testMatch: ['**/*.e2e.test.ts'],
  // functions/src/index.ts's own dependencies (firebase-admin,
  // firebase-functions, node-fetch, nanoid, bullmq, ...) live in
  // functions/node_modules, not the repo root's. Node's own resolution
  // would find them fine when functions/src/index.ts itself does the
  // requiring, but this test file's *own* jest.mock() calls resolve
  // relative to this file, so they need the same node_modules on the path.
  moduleDirectories: ['node_modules', '../../functions/node_modules'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          esModuleInterop: true,
          target: 'es2020',
          skipLibCheck: true,
          strict: false,
          isolatedModules: true,
        },
      },
    ],
  },
};
