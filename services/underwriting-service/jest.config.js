/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  testTimeout: 30000,
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.test.js"],
};
