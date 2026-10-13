/**
 * The launch-mode (VITE_LAUNCH_MODE=live) marketing routes and their
 * critical path, which is what Lighthouse measures in CI:
 *
 *  - the four landing pages render in the first commit — no lazy chunk, no
 *    Suspense spinner in front of the hero (the LCP element);
 *  - they never mount AuthProvider, so Firebase stays off their bundle;
 *  - the role-guarded portals still get auth: PortalAuth mounts the provider
 *    for them and an anonymous visitor is still sent to /login.
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const onAuthStateChanged = vi.fn((_auth: unknown, cb: (u: null) => void) => {
  cb(null);
  return () => {};
});

vi.mock('./lib/firebase', () => ({ db: {}, auth: {}, storage: {}, functions: {} }));
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (...args: [unknown, (u: null) => void]) => onAuthStateChanged(...args),
  signInWithEmailAndPassword: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  signOut: vi.fn(),
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

// jsdom has no media pipeline; the hero film calls these once the page has loaded.
HTMLMediaElement.prototype.load = () => {};
HTMLMediaElement.prototype.pause = () => {};
HTMLMediaElement.prototype.play = () => Promise.resolve();

let App: typeof import('./App').default;

beforeAll(async () => {
  // LAUNCH_MODE is read once, when App.tsx is evaluated.
  vi.stubEnv('VITE_LAUNCH_MODE', 'live');
  App = (await import('./App')).default;
});

beforeEach(() => {
  onAuthStateChanged.mockClear();
});
afterEach(() => {
  cleanup();
});

function renderAt(path: string) {
  window.history.pushState({}, '', path);
  return render(
    <HelmetProvider>
      <App />
    </HelmetProvider>,
  );
}

describe('App — launch-mode marketing pages', () => {
  it.each(['/', '/employers', '/employees'])('%s paints its photo hero in the first commit', (path) => {
    const { container } = renderAt(path);

    // Synchronous on purpose: a lazy route would still be showing the spinner.
    expect(container.querySelector('.loading-page')).not.toBeInTheDocument();
    const hero = container.querySelector('main .mk-board.mk-hero');
    expect(hero).toBeInTheDocument();
    expect(hero?.querySelector('h1')).toBeInTheDocument();
    expect(hero?.querySelector('video.mk-stage-film')?.getAttribute('poster')).toMatch(
      /^\/images\/brand\/.+-(16x9|9x16)\.webp$/,
    );
  });

  it('/about paints its first board in the first commit', () => {
    const { container } = renderAt('/about');
    expect(container.querySelector('.loading-page')).not.toBeInTheDocument();
    expect(container.querySelector('main .mk-board h1')).toBeInTheDocument();
  });

  it('the home page renders every board with the hero, not behind a second Suspense', () => {
    const { container } = renderAt('/');
    expect(container.querySelectorAll('main .mk-board').length).toBeGreaterThanOrEqual(6);
    expect(container.querySelector('#how')).toBeInTheDocument();
    expect(container.querySelector('#trust')).toBeInTheDocument();
  });

  it.each(['/', '/employers', '/employees', '/about'])('%s never subscribes to Firebase auth', async (path) => {
    renderAt(path);
    // Give any lazily mounted provider the chance to show up.
    await new Promise((r) => setTimeout(r, 50));
    expect(onAuthStateChanged).not.toHaveBeenCalled();
  });
});

describe('App — role-guarded portals still get auth', () => {
  it.each(['/employee', '/employer', '/ops'])('%s mounts AuthProvider and sends an anonymous visitor to /login', async (path) => {
    renderAt(path);
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(window.location.pathname).toBe('/login'));
  });
});
