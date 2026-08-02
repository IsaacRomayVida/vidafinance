/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  testTimeout: 30000,
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.test.js"],
  moduleNameMapper: {
    "^belvo$": "<rootDir>/__mocks__/belvo.js",
    "^node-fetch$": "<rootDir>/__mocks__/node-fetch.js",
    // services/shared/metrics.js sits outside this package, so plain
    // node_modules resolution can't see prom-client from there in local
    // dev/test (production Docker builds hoist node_modules above both
    // services/shared and services/underwriting-service — see Dockerfile).
    "^prom-client$": "<rootDir>/node_modules/prom-client",
  },
};
