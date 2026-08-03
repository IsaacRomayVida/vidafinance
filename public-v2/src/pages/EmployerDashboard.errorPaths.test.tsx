/**
 * EmployerDashboard — E4: the stats block read a key (`stats`) the server
 * never returned, so the callable "succeeded" with `result.data.stats ===
 * undefined`, `setStats({})` ran, and every headline number silently fell
 * back to a wrong local recomputation instead of surfacing as a failure.
 *
 * These tests pin the fixed contract: a stats read failure must render as an
 * error with a retry, never as a plausible-looking (and wrong) number.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../lib/firebase', () => ({ db: {}, auth: {}, storage: {} }));

const stableUser = { uid: 'employer-1', emailVerified: true, email: 'e@example.com' };
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: stableUser }) }));

vi.mock('firebase/auth', () => ({ signOut: vi.fn() }));

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

vi.mock('firebase/storage', () => ({
  ref: vi.fn(),
  uploadBytesResumable: vi.fn(),
  getDownloadURL: vi.fn(),
}));

let getDocImpl: () => Promise<{ exists: () => boolean; data: () => unknown }>;
type SnapCb = (snap: { docs: unknown[] }) => void;
type ErrCb = (err: unknown) => void;
let snapshotImpl: (name: string, ok: SnapCb, err?: ErrCb) => void;

vi.mock('firebase/firestore', () => ({
  doc: vi.fn(() => ({})),
  getDoc: vi.fn(() => getDocImpl()),
  collection: vi.fn((_db: unknown, name: string) => ({ __name: name })),
  query: vi.fn((ref: unknown) => ref),
  where: vi.fn(),
  orderBy: vi.fn(),
  onSnapshot: vi.fn((q: { __name: string }, ok: SnapCb, err?: ErrCb) => {
    snapshotImpl(q.__name, ok, err);
    return () => {};
  }),
}));

let dashboardCallableImpl: () => Promise<{ data: unknown }>;

vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn((_functions: unknown, name: string) => {
    if (name === 'getEmployerDashboard') return () => dashboardCallableImpl();
    return () => Promise.resolve({ data: {} });
  }),
}));

import '../i18n';
import { EmployerDashboard } from './EmployerDashboard';

const okEmployer = {
  exists: () => true,
  data: () => ({
    companyName: 'Acme Corp',
    employerCode: 'ACME01',
    status: 'active',
    partBStatus: 'completed', // skip the PayrollDeductionCard, unrelated to this test
  }),
};

// Present-shape server response: computeEmployerDashboardStats always
// returns every field.
const serverStats = {
  totalEmployees: 12,
  activeLoans: 3,
  overdueCount: 1,
  totalDisbursed: 45000,
  outstandingBalance: 20000,
  adoptionRate: '25%',
};

beforeEach(() => {
  getDocImpl = () => Promise.resolve(okEmployer);
  snapshotImpl = (_name, ok) => ok({ docs: [] });
  dashboardCallableImpl = () => Promise.resolve({ data: { stats: serverStats } });
});

describe('EmployerDashboard — stats present in the response shape', () => {
  it('renders the server-computed numbers, not a client recomputation', async () => {
    render(<EmployerDashboard />);

    expect(await screen.findByText('$45,000')).toBeTruthy(); // totalDisbursed, from `total` not `amount`
    expect(screen.getByText('$20,000')).toBeTruthy(); // outstandingBalance
    expect(screen.getByText('3')).toBeTruthy(); // activeLoans
    expect(screen.getByText('1')).toBeTruthy(); // overdueCount
  });
});

describe('EmployerDashboard — the stats call fails (E4)', () => {
  it('surfaces an error with a retry instead of a wrong number', async () => {
    dashboardCallableImpl = () => Promise.reject(new Error('permission-denied'));

    render(<EmployerDashboard />);

    const alert = await screen.findByRole('alert');
    expect(alert).toBeTruthy();
    expect(screen.getByRole('button', { name: /reintentar|retry/i })).toBeTruthy();

    // The old bug: a failed call silently rendered a recomputed number
    // instead of an error. The stat tile grid must not render at all while
    // the error banner owns that region — no "$0" standing in as a lie.
    expect(screen.queryByText(/^\$[\d,]+$/)).toBeNull();
  });

  it('the loans table still renders independently of the stats failure', async () => {
    dashboardCallableImpl = () => Promise.reject(new Error('unavailable'));
    snapshotImpl = (name, ok) => {
      if (name === 'loans') {
        ok({
          docs: [
            { id: 'loan-1', data: () => ({ employeeName: 'Juan', amount: 5000, status: 'pending' }) },
          ],
        });
      } else {
        ok({ docs: [] });
      }
    };

    render(<EmployerDashboard />);

    await screen.findByRole('alert');
    expect(await screen.findByText('Juan')).toBeTruthy();
  });

  it('retrying re-fetches and clears the error once the call succeeds', async () => {
    dashboardCallableImpl = () => Promise.reject(new Error('unavailable'));
    render(<EmployerDashboard />);

    const retryButton = await screen.findByRole('button', { name: /reintentar|retry/i });

    dashboardCallableImpl = () => Promise.resolve({ data: { stats: serverStats } });
    retryButton.click();

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(await screen.findByText('3')).toBeTruthy();
  });
});
