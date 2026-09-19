/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testTimeout: 15000,
  testMatch: ['**/test/**/*.test.js'],
  // test/render/** launches a real Chromium via puppeteer (see
  // test/render/contract.render.test.js) and is intentionally excluded from
  // the default mocked-unit-test run: it's slow (real browser process) and
  // it explicitly unmocks puppeteer, which the rest of this suite relies on
  // staying mocked. Run it separately with `npm run test:render`
  // (jest.render.config.js).
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/test/render/'],
  moduleNameMapper: {
    // services/shared/*.js sits outside this package's node_modules tree, so
    // a plain `require('prom-client')`/`require('pino')` from there can't
    // resolve in local dev/test (Docker hoists node_modules above both dirs
    // -- see Dockerfile). Same fix as services/payment-server/jest.config.js.
    '^prom-client$': '<rootDir>/node_modules/prom-client',
    '^pino$': '<rootDir>/node_modules/pino',
  },
};
