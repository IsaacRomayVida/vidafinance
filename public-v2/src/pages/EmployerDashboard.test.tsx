/**
 * EmployerDashboard — the loans table's Term column.
 *
 * The persisted field is `term` (functions/src/index.ts:839); `termDays` is
 * only the requestLoan request-payload name (functions/src/index.ts:398) and
 * is never written to the document. Reading `loan.termDays ?? 30` therefore
 * fell through to the default on every real loan, and every row displayed
 * "30 days" regardless of the term the borrower actually agreed to. See the
 * borrower-side regression tests this mirrors: MyLoans.test.tsx and
 * LoanTable.test.tsx, both "renders the term from loan.term, not loan.termDays".
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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

// Mirrors EmployerDashboardStats (functions/src/employers/computeEmployerDashboardStats.ts):
// the server always returns every field, never an empty/partial object, so
// the mock must too — an incomplete `stats` here does not model any real
// getEmployerDashboard response and previously masked a real caller (E14/E15
// only touches the loans table, not this stats card) from a mock that could
// never occur in production.
vi.mock('firebase/functions', () => ({
  getFunctions: () => ({}),
  httpsCallable: () => async () => ({
    data: {
      stats: {
        totalEmployees: 1,
        activeLoans: 1,
        overdueCount: 0,
        totalDisbursed: 1000,
        outstandingBalance: 1000,
        adoptionRate: '100%',
      },
    },
  }),
}));

let loanDocs: Array<{ id: string; data: () => Record<string, unknown> }> = [];

vi.mock('firebase/firestore', () => ({
  doc: vi.fn(() => ({})),
  getDoc: vi.fn(async () => ({
    exists: () => true,
    data: () => ({ companyName: 'Acme', employerCode: 'ACME1', status: 'active' }),
  })),
  collection: vi.fn((_db: unknown, name: string) => ({ __name: name })),
  query: vi.fn((ref: unknown) => ref),
  where: vi.fn(),
  orderBy: vi.fn(),
  onSnapshot: vi.fn((q: { __name: string }, cb: (snap: { docs: unknown[] }) => void) => {
    cb({ docs: q.__name === 'loans' ? loanDocs : [] });
    return () => {};
  }),
}));

import '../i18n';
import { EmployerDashboard } from './EmployerDashboard';

const loan = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  data: () => ({
    employeeName: `Employee ${id}`,
    amount: 1000,
    status: 'active',
    createdAt: { seconds: 1_788_000_000 },
    ...extra,
  }),
});

describe('EmployerDashboard — loans table term column', () => {
  it('renders the term from loan.term, not loan.termDays', async () => {
    loanDocs = [loan('l-1', { term: 45, termDays: 30 })];
    render(<EmployerDashboard />);

    expect(await screen.findByText(/\b45\b/)).toBeInTheDocument();
    expect(screen.queryByText(/^30$/)).not.toBeInTheDocument();
  });

  it('falls back to 30 days when loan.term is absent (legacy data), same as the borrower-side default', async () => {
    loanDocs = [loan('l-2')];
    render(<EmployerDashboard />);

    expect(await screen.findByText(/\b30\b/)).toBeInTheDocument();
  });
});
