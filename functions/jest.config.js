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
    '^firebase-admin/auth$': '<rootDir>/src/__mocks__/firebase-admin/auth.ts',
    '^firebase-functions/v2/https$': '<rootDir>/src/__mocks__/firebase-functions/v2/https.ts',
    '^node-fetch$': '<rootDir>/src/__mocks__/node-fetch.ts',
    '^../utils/redis$': '<rootDir>/src/__mocks__/utils/redis.ts',
    '^../../utils/redis$': '<rootDir>/src/__mocks__/utils/redis.ts',
  },
  collectCoverageFrom: [
    'src/loans/markLoanDisbursed.ts',
    'src/loans/calculateNextPayrollDate.ts',
    'src/loans/requestLoan.ts',
    'src/payments/generatePaymentLink.ts',
    'src/admin/adminClaims.ts',
  ],
  coverageThreshold: {
    global: {
      lines: 90,
      functions: 65,
      branches: 80,
      statements: 90,
    },
  },
};
