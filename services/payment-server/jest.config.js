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
    '^../src/lib/firebase$': '<rootDir>/tests/__mocks__/firebase.ts',
    '^../src/lib/redis$': '<rootDir>/tests/__mocks__/redis.ts',
    '^../../src/lib/firebase$': '<rootDir>/tests/__mocks__/firebase.ts',
    '^../../src/lib/redis$': '<rootDir>/tests/__mocks__/redis.ts',
  },
  coverageDirectory: 'coverage',
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
};
