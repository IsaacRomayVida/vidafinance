/**
 * Locks in that the default production build (VITE_LAUNCH_MODE unset, the
 * same as deploy.yml's default build) renders the restored pre-redesign
 * landing at pages/ComingSoon.tsx — not the funpay-ui ComingSoonRedesign.tsx
 * that PR #626 shipped, which the business asked to hold off the public
 * site for now (see App.tsx's ComingSoon lazy-import comment for how to
 * switch back).
 *
 * Firebase is mocked out (App mounts AuthProvider, which subscribes via
 * onAuthStateChanged, and the rendered page's ComingSoonForm imports
 * `db`/firestore at module scope) — same pattern as ContactForm.test.tsx.
 */
import { render, waitFor } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
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

// jsdom doesn't implement matchMedia; SplashIntro reads
// `prefers-reduced-motion` from it on mount to decide whether to play.
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

describe('App — default (coming-soon) build renders the restored legacy landing', () => {
  it('mounts the pre-redesign ComingSoon page, not the funpay-ui redesign', async () => {
    const { container } = render(
      <HelmetProvider>
        <App />
      </HelmetProvider>,
    );

    // The restored page's own root marker (cs-page); wait past the
    // Suspense fallback for the lazy chunk to resolve.
    await waitFor(() => {
      expect(container.querySelector('.cs-page')).toBeInTheDocument();
    });

    // The redesigned page's root marker must NOT be present — the two
    // pages are mutually exclusive per render.
    expect(container.querySelector('.mk-page')).not.toBeInTheDocument();

    // Structural markers unique to the restored page's sections.
    expect(container.querySelector('.cs-header')).toBeInTheDocument();
    expect(container.querySelector('.cs-footer')).toBeInTheDocument();
    expect(container.querySelector('.hero-video-wrap')).toBeInTheDocument();
  });
});
