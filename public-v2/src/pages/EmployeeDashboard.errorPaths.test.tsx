/**
 * EmployeeDashboard — F7: read failures used to be swallowed and render as a
 * permanent spinner.
 *
 * Three reads gate this page and none of them had an error path:
 *   1. `getDoc(employees/{uid})` ran inside an async IIFE with no try/catch.
 *      `setPageState('dashboard')` lives only on the success path, so a
 *      rejection left `pageState === 'loading'` forever — the borrower sat on
 *      a spinner that was indistinguishable from slowness, with no retry and
 *      an unhandled promise rejection besides.
 *   2. the loans `onSnapshot` had no error callback, so `setLoading(false)`
 *      never ran on failure.
 *   3. the repayments `onSnapshot` had no error callback; that one does not
 *      block the page but it silently understates every balance shown, so it
 *      must say so rather than render quietly wrong numbers.
 *
 * The error branch has to be checked BEFORE the `pageState === 'loading'`
 * spinner: on a failed read `pageState` never leaves 'loading', so an error
 * branch placed after it would be unreachable. These tests pin that ordering.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../lib/firebase', () => ({ db: {}, auth: {} }));

const stableUser = { uid: 'emp-1', emailVerified: true, email: 'e@example.com' };
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: stableUser }) }));

vi.mock('firebase/auth', () => ({ signOut: vi.fn() }));

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

// The dashboard's children are not under test here; stub them so a render of
// the success path cannot fail for reasons unrelated to the error handling.
vi.mock('../components/LoanStatusCard', () => ({ LoanStatusCard: () => null }));
vi.mock('../components/employee/KYCBanner', () => ({ KYCBanner: () => null }));
vi.mock('../components/employee/CreditWidget', () => ({ CreditWidget: () => null }));
vi.mock('../components/employee/LoanTable', () => ({ LoanTable: () => null }));
vi.mock('../components/employee/PaymentModal', () => ({ PaymentModal: () => null }));

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

import '../i18n';
import { EmployeeDashboard } from './EmployeeDashboard';

const okEmployee = {
  exists: () => true,
  data: () => ({ name: 'Ana', availableCredit: 5000, kycStatus: 'approved' }),
};

beforeEach(() => {
  getDocImpl = () => Promise.resolve(okEmployee);
  snapshotImpl = (_name, ok) => ok({ docs: [] });
});

const spinner = () => document.querySelector('.animate-spin');

describe('EmployeeDashboard — the employee read fails (F7)', () => {
  it('surfaces an error with a retry instead of spinning forever', async () => {
    getDocImpl = () => Promise.reject(new Error('permission-denied'));

    render(<EmployeeDashboard />);

    const alert = await screen.findByRole('alert');
    expect(alert).toBeTruthy();
    expect(screen.getByRole('button', { name: /reintentar|retry/i })).toBeTruthy();
    // The whole point: the spinner is gone, so an outage no longer reads as
    // "still loading".
    expect(spinner()).toBeNull();
  });

  it('retrying re-runs the read, and a now-succeeding read clears the error', async () => {
    getDocImpl = () => Promise.reject(new Error('unavailable'));
    render(<EmployeeDashboard />);

    const retryButton = await screen.findByRole('button', { name: /reintentar|retry/i });

    getDocImpl = () => Promise.resolve(okEmployee);
    retryButton.click();

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});

describe('EmployeeDashboard — the loans listener fails (F7)', () => {
  it('clears loading and surfaces the failure', async () => {
    snapshotImpl = (name, ok, err) => {
      if (name === 'loans') err?.(new Error('permission-denied'));
      else ok({ docs: [] });
    };

    render(<EmployeeDashboard />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(spinner()).toBeNull();
  });
});

describe('EmployeeDashboard — the repayments listener fails (F7)', () => {
  it('warns that balances may be incomplete without taking the page down', async () => {
    snapshotImpl = (name, ok, err) => {
      if (name === 'repayments') err?.(new Error('permission-denied'));
      else ok({ docs: [] });
    };

    render(<EmployeeDashboard />);

    // Non-blocking: the banner appears, but the dashboard itself still renders
    // rather than being replaced by a full-page error.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toMatch(/incompletos|incomplete/i);
    expect(screen.queryByRole('button', { name: /reintentar|retry/i })).toBeNull();
  });
});
