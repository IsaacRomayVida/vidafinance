/**
 * main.tsx no longer wraps the app in a HelmetProvider (react-helmet-async
 * was ~8 KB gzip in every page's entry bundle for the two coming-soon pages
 * that use it). Those pages bring their own provider, so the default
 * (coming-soon) build must still render — and set its <title> — with no
 * provider above <App />, exactly as main.tsx mounts it.
 */
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./lib/firebase', () => ({ db: {}, auth: {}, storage: {} }));
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: vi.fn((_auth: unknown, cb: (u: null) => void) => {
    cb(null);
    return () => {};
  }),
}));
vi.mock('firebase/firestore', () => ({
  collection: vi.fn(),
  addDoc: vi.fn(),
  serverTimestamp: vi.fn(),
  doc: vi.fn(),
  getDoc: vi.fn(),
}));

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

import App from './App';
import es from './i18n/es.json';

describe('App — coming-soon build without a root HelmetProvider', () => {
  it('renders the landing and its document title', async () => {
    const { container } = render(<App />);

    await waitFor(() => {
      expect(container.querySelector('.cs-page')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(document.title).toBe(es.cs_meta_title_legacy);
    });
  });
});
