/// <reference types="vitest" />
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  // Sub-path deploys (the team portal serves this site at /web/) set
  // VITE_BASE_PATH at build time; production builds leave it unset → '/'.
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: false,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // The entry's dependencies are grouped into few chunks on purpose:
        // every extra file on the critical path is another round trip before
        // first paint (the Lighthouse CI server is HTTP/1.1), so the
        // framework libraries the first render needs ship together.
        manualChunks(id) {
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
        },
      },
    },
  },
  server: {
    port: 3000,
  },
});
