/**
 * Rollup `output.manualChunks` for the public-v2 build (used by
 * vite.config.ts; its own file so a test can call it).
 *
 * The entry's dependencies are grouped into few chunks on purpose: every
 * extra file on the critical path is another round trip before first paint
 * (the Lighthouse CI server is HTTP/1.1), so the framework libraries the
 * first render needs ship together.
 */
export function manualChunks(id: string): string | undefined {
  if (
    id.includes('node_modules/react-router') ||
    id.includes('node_modules/react-dom') ||
    id.includes('node_modules/react/') ||
    id.includes('node_modules/scheduler') ||
    id.includes('node_modules/i18next') ||
    id.includes('node_modules/react-i18next') ||
    // Two tiny modules shared by the entry and lazy pages; left alone
    // they each become a <1 KB chunk — a request of their own.
    id.endsWith('/src/lib/safeStorage.ts') ||
    id.endsWith('/src/components/shared/RichText.tsx')
  ) {
    return 'vendor';
  }
  if (id.includes('node_modules/firebase/auth') || id.includes('node_modules/@firebase/auth')) {
    return 'firebase-auth';
  }
  if (id.includes('node_modules/firebase') || id.includes('node_modules/@firebase')) {
    return 'firebase';
  }
  return undefined;
}
