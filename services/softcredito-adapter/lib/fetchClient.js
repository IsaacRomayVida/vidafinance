'use strict';

// node-fetch v3 is ESM-only, so index.js reaches it via `await import('node-fetch')`.
// Jest's CommonJS runtime cannot intercept that with jest.mock() -- a dynamic
// import from a CJS module under test throws "invoked without
// --experimental-vm-modules" instead of resolving to a mock, and forcing that
// flag on just makes it load the REAL package (still no mock hook), which
// would mean tests of /internal/disburse et al. hit the real network. Wrapping
// the dynamic import behind this plain CommonJS function gives tests a
// require('./lib/fetchClient') target they can jest.mock normally, with
// identical production behavior (still node-fetch v3, still a dynamic import
// under the hood).
async function getFetch() {
  const { default: fetch } = await import('node-fetch');
  return fetch;
}

module.exports = { getFetch };
