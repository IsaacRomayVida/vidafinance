/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testTimeout: 15000,
  testMatch: ['**/test/**/*.test.js'],
  moduleNameMapper: {
    // services/shared/*.js sits outside this package's node_modules tree, so
    // a plain `require('prom-client')`/`require('pino')` from there can't
    // resolve in local dev/test (Docker hoists node_modules above both dirs
    // -- see Dockerfile). Same fix as services/payment-server/jest.config.js.
    '^prom-client$': '<rootDir>/node_modules/prom-client',
    '^pino$': '<rootDir>/node_modules/pino',
  },
};
