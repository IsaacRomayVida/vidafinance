/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  testTimeout: 30000,
  // `roots` deliberately covers src/ only. services/underwriting-service/tests/
  // also matches testMatch but has never been collected by this config, so its
  // two suites have never run in CI. That is not a decision anyone recorded —
  // it is a side effect of this line. Both are stale and neither can be
  // switched on as-is: tests/metamap-client.test.js throws
  // "_resetTokenCache is not a function" in beforeEach (the export it needs was
  // removed from src/metamap-client.js), and tests/decision-engine.test.js does
  // not terminate — it was still running at a 90s kill on 2026-08-03. Bringing
  // them in would hang the job, not gate it, so they stay out until someone
  // repairs or retires them. Flagged rather than fixed here because that is its
  // own piece of work; see the report on #387/#388. Note src/decision-engine.test.js
  // is a different, healthy suite that does run — the tests/ copy is not a duplicate
  // of it, it is an older parallel one.
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.test.js"],
  // employer-b.test.js and stage3-autoapprove.test.js specify features that were
  // never built (#387, #388). #395 held them out of the gate here, via
  // testPathIgnorePatterns. That worked, but it made them invisible: jest never
  // collected the files, so CI output showed only the suites that ran and a
  // reader could not tell "never built" from "checked and fine" — a gap that is
  // not counted anywhere reads as no gap at all.
  //
  // They are now `describe.skip` in the files themselves, with a header stating
  // what does not exist and why. Jest collects them, reports them as skipped,
  // and the count of skipped tests appears in every run. The exclusion is the
  // same size as before; it just says so out loud. Un-skipping happens in the
  // test file, one describe at a time, as the feature lands.
  testPathIgnorePatterns: ["/node_modules/"],
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
