import { defineConfig } from 'vitest/config';

// Pure-logic tests only (src/lib): no React Native runtime is loaded, so the
// suite runs on plain Node in CI in seconds. Screen-level testing arrives
// with the dev-client build (v2), where a real RN test renderer earns its
// weight.
export default defineConfig({
  test: {
    include: ['src/lib/**/*.test.ts'],
    environment: 'node',
  },
});
