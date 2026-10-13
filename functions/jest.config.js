/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testTimeout: 30000,
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          noUnusedLocals: false,
          noUnusedParameters: false,
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
        },
      },
    ],
  },
  moduleNameMapper: {
    '^firebase-admin/app$': '<rootDir>/src/__mocks__/firebase-admin/app.ts',
    '^firebase-admin/firestore$': '<rootDir>/src/__mocks__/firebase-admin/firestore.ts',
    '^firebase-admin/storage$': '<rootDir>/src/__mocks__/firebase-admin/storage.ts',
    '^firebase-admin/auth$': '<rootDir>/src/__mocks__/firebase-admin/auth.ts',
    '^firebase-functions/v2/https$': '<rootDir>/src/__mocks__/firebase-functions/v2/https.ts',
    '^node-fetch$': '<rootDir>/src/__mocks__/node-fetch.ts',
    '^../utils/redis$': '<rootDir>/src/__mocks__/utils/redis.ts',
    '^../../utils/redis$': '<rootDir>/src/__mocks__/utils/redis.ts',
  },
  // Previously scoped to 4 hand-picked files (~99.5% "coverage" that
  // actually described 4 of ~50 source files, not the suite). Widened to
  // the real source surface so the reported number means what it says.
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
    '!src/**/__mocks__/**',
    '!src/**/lib/**',
  ],
  // A RATCHET, not an aspiration. The old 90/65/80/90 thresholds described
  // the previous 4-file collectCoverageFrom above, where the suite reported
  // ~99.5%; against the real ~50-file surface they would fail the build
  // immediately. Deleting them outright was the other wrong answer — it
  // leaves nothing stopping coverage from sliding.
  //
  // So these sit a couple of points under the measured values on
  // 2026-09-19 (statements 85.99, branches 75.96, functions 79.33,
  // lines 87.24 — raised same-day from 81.66/73.27/73.27/83.32 after adding
  // real coverage for utils/redis.ts, health/api.ts, the three
  // scheduled/*HealthCheck+weeklyPortfolioSnapshot jobs, utils/registryClient.ts
  // and utils/sentry.ts): today's suite passes, and a change that
  // meaningfully reduces coverage fails. Raise them when the number rises;
  // never lower them to make a red build green.
  coverageThreshold: {
    global: {
      statements: 84,
      branches: 74,
      functions: 77,
      lines: 85,
    },
  },
};
