/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testTimeout: 30000,
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.js'],
  moduleNameMapper: {
    '^node-fetch$': '<rootDir>/__mocks__/node-fetch.js',
  },
};
