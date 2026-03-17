/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { strict: false } }],
  },
  moduleNameMapper: {
    '^../src/lib/redis$': '<rootDir>/tests/__mocks__/redis.ts',
    '^../src/lib/firestore$': '<rootDir>/tests/__mocks__/firebase.ts',
    '^\\.\\./lib/redis$': '<rootDir>/tests/__mocks__/redis.ts',
    '^\\.\\./lib/firestore$': '<rootDir>/tests/__mocks__/firebase.ts',
    '^\\.\\./\\.\\./lib/redis$': '<rootDir>/tests/__mocks__/redis.ts',
    '^\\.\\./\\.\\./lib/firestore$': '<rootDir>/tests/__mocks__/firebase.ts',
  },
  coverageDirectory: 'coverage',
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
};
