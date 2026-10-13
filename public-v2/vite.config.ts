/// <reference types="vitest" />
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { manualChunks } from './manualChunks';
import { languagePreload } from './languagePreload';

export default defineConfig({
  // Sub-path deploys (the team portal serves this site at /web/) set
  // VITE_BASE_PATH at build time; production builds leave it unset → '/'.
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [tailwindcss(), react(), languagePreload()],
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
        manualChunks,
      },
    },
  },
  server: {
    port: 3000,
  },
});
