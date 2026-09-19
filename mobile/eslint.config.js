// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    // react-hooks/recommended (pulled in by eslint-config-expo) ships two
    // rules new enough that they flag long-standing, working patterns all
    // over this codebase: lazy `useRef(...).current` initializers (52 hits)
    // and setState calls inside effects that intentionally kick off async
    // work (6 hits). Neither is a bug we're introducing here, and fixing
    // every call site is out of scope for adding lint tooling — see
    // TASK 4 in the production-readiness pass. Downgraded to warn so lint
    // is actionable without mass-rewriting application code.
    rules: {
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  }
]);
