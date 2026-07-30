// This service is the only one with a real dependency (pg) on
// services/shared/registry/, so its tests cover that shared module too.
// `modulePaths` points Jest's resolver at this package's node_modules for
// requires coming from services/shared/registry/*.js -- Node's own runtime
// resolution (used by Docker/Railway) doesn't need this: there, shared/ is
// copied alongside the specific service and both live under one npm-installed
// root, so the ancestor lookup finds node_modules naturally. Locally, they're
// siblings, and this closes that gap for test runs only.
module.exports = {
  rootDir: '..',
  testMatch: [
    '<rootDir>/registry-service/**/*.test.js',
    '<rootDir>/shared/registry/**/*.test.js',
  ],
  modulePaths: ['<rootDir>/registry-service/node_modules'],
};
