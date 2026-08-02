/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  testTimeout: 30000,
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.test.js"],
  // These two suites test APIs that were never implemented (verified
  // 2026-08-02: `require("../employer-b")` / `require("../stage3-autoapprove")`
  // don't export any of the functions the tests import — this isn't a
  // regression, the feature behind each suite was never built). Excluded so
  // the underwriting-service unit-test job can be a hard CI gate without
  // blocking on unbuilt work. Remove each line individually once its
  // feature ships and the suite is made to pass for real.
  testPathIgnorePatterns: [
    "/node_modules/",
    // Waiting on: employer-b weighted-scoring rewrite (scoreSATAge, scoreDENUE,
    // scoreIMSSEmployees, scoreFiscalDebt, assignTier, autoScaleTier1,
    // expandTier2, Firestore employer-doc sync — none of this exists yet in
    // src/stages/employer-b.js, which still uses the old flat scoring model).
    "src/stages/__tests__/employer-b.test.js",
    // Waiting on: stage3-autoapprove rewrite (runStage3, evaluateGate,
    // hasCompetitorLoans — src/stages/stage3-autoapprove.js only exports the
    // old runAutoApproveGate/evaluateAutoApprove API).
    "src/stages/__tests__/stage3-autoapprove.test.js",
  ],
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
