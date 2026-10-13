/**
 * /ops/remittances is reachable by ops, admin and super_admin only.
 *
 * Rendered through the real <App> route table, so this fails if the route is
 * dropped (ops lands on the catch-all), if it is moved out from under the ops
 * RouteGuard (an employee sees the ledger), or if the guard's role list
 * changes. The server enforces the same roles on the callables; this is the
 * client half.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Role = 'employee' | 'employer_admin' | 'ops' | 'admin' | 'super_admin' | null;
let authState: { user: { uid: string } | null; role: Role; loading: boolean };

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => authState,
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../lib/firebase', () => ({ db: {}, auth: {}, storage: {} }));
vi.mock('firebase/auth', () => ({ signOut: vi.fn(), onAuthStateChanged: vi.fn(() => () => {}) }));
vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => ({})),
  getDocs: vi.fn(async () => ({ docs: [] })),
}));

const listCallable = vi.fn(async () => ({
  data: {
    asOf: '2026-03-10',
    graceDays: 7,
    truncated: false,
    totals: { count: 0, expectedCents: 0, receivedCents: 0, outstandingCents: 0, overdueCount: 0, overdueCents: 0 },
    remittances: [],
  },
}));
vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn(() => listCallable),
}));

// Where the guard sends everyone else. Stubbed: what matters is that the
// ledger is not what rendered, not what the landing or login page look like.
vi.mock('./ComingSoon', () => ({ ComingSoon: () => <div data-testid="landing" /> }));
vi.mock('./Login', () => ({ Login: () => <div data-testid="login" /> }));

import App from '../App';

function renderAt(path: string) {
  window.history.pushState({}, '', path);
  return render(<App />);
}

beforeEach(() => {
  listCallable.mockClear();
});

afterEach(() => {
  cleanup();
  window.history.pushState({}, '', '/');
});

describe('/ops/remittances — role guard', () => {
  it.each(['ops', 'admin', 'super_admin'] as const)('renders the ledger for %s, inside the ops shell', async (role) => {
    authState = { user: { uid: 'u-1' }, role, loading: false };
    renderAt('/ops/remittances');

    expect(await screen.findByRole('heading', { name: 'Remesas de nómina' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/ops/remittances');
    await waitFor(() => expect(listCallable).toHaveBeenCalled());

    // Listed in the ops navigation, and marked as the current section.
    expect(screen.getByRole('link', { name: 'Remesas' })).toHaveAttribute('aria-current', 'page');
  });

  it.each(['employee', 'employer_admin', null] as const)('sends a signed-in %s away without loading the ledger', async (role) => {
    authState = { user: { uid: 'u-1' }, role, loading: false };
    renderAt('/ops/remittances');

    await waitFor(() => expect(window.location.pathname).toBe('/'));
    await screen.findByTestId('landing');
    expect(screen.queryByRole('heading', { name: 'Remesas de nómina' })).toBeNull();
    expect(listCallable).not.toHaveBeenCalled();
  });

  it('sends a signed-out visitor to login without loading the ledger', async () => {
    authState = { user: null, role: null, loading: false };
    renderAt('/ops/remittances');

    await screen.findByTestId('login');
    expect(window.location.pathname).toBe('/login');
    expect(screen.queryByRole('heading', { name: 'Remesas de nómina' })).toBeNull();
    expect(listCallable).not.toHaveBeenCalled();
  });
});
