/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  testTimeout: 30000,
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.test.js"],
  moduleNameMapper: {
    "^belvo$": "<rootDir>/__mocks__/belvo.js",
    "^node-fetch$": "<rootDir>/__mocks__/node-fetch.js",
  },
};
