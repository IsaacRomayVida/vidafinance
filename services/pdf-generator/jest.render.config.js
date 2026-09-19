/** @type {import('jest').Config} */
// Separate config for the real-Chromium contract render test
// (test/render/contract.render.test.js). Deliberately not part of the
// default `npm test` run -- see the exclusion in jest.config.js and the
// comment at the top of that test file for why. Real Chromium launch +
// networkidle0 render is slower than the mocked unit suites, hence the
// longer timeout.
module.exports = {
  testEnvironment: 'node',
  testTimeout: 30000,
  testMatch: ['<rootDir>/test/render/**/*.test.js'],
};
