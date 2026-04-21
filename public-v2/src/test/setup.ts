/**
 * Vitest global setup. Extends `expect` with jest-dom matchers and
 * wires an `afterEach` cleanup so React Testing Library doesn't leak
 * DOM between tests.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
