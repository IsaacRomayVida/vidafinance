/**
 * MyLoans — the "Pagar" button gate, and the fee/term detail fields.
 *
 * C1: the server (generatePaymentLink.ts) accepts 'active' | 'disbursed' |
 * 'overdue'. This page used to gate Pagar on 'active' | 'overdue' only, so a
 * manually ops-disbursed loan ('disbursed') silently lost its Pagar button
 * even though the server would have honored the request.
 *
 * C2/C3: this page reads Firestore loan documents directly via onSnapshot,
 * so it must read the fields the document actually carries — `fee` and
 * `term` (index.ts:831,839) — not the admin-callable-response names
 * (`feeAmount`) or the request-payload name (`termDays`), neither of which
 * is ever written to the document.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase', () => ({ db: {}, auth: { currentUser: null } }));

const stableUser = { uid: 'emp-1' };
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ user: stableUser }),
}));

vi.mock('firebase/functions', () => ({
  getFunctions: () => ({}),
  httpsCallable: () => vi.fn(),
}));

let loanDocs: Array<{ id: string; data: () => Record<string, unknown> }> = [];
let repaymentDocs: Array<{ id: string; data: () => Record<string, unknown> }> = [];

vi.mock('firebase/firestore', () => ({
  collection: vi.fn((_db: unknown, name: string) => ({ __name: name })),
  query: vi.fn((ref: unknown) => ref),
  where: vi.fn(),
  orderBy: vi.fn(),
  onSnapshot: vi.fn((q: { __name: string }, cb: (snap: { docs: unknown[] }) => void) => {
    cb({ docs: q.__name === 'loans' ? loanDocs : repaymentDocs });
    return () => {};
  }),
}));

import '../i18n';
import { MyLoans } from './MyLoans';

const loan = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  data: () => ({
    status,
    amount: 1000,
    fee: 300,
    total: 1300,
    term: 45,
    createdAt: { seconds: 1_788_000_000 },
    ...extra,
  }),
});

describe('MyLoans — Pagar button gate', () => {
  beforeEach(() => {
    repaymentDocs = [];
  });

  it('shows Pagar for active, overdue, and disbursed loans', () => {
    loanDocs = [
      loan('l-active', 'active'),
      loan('l-overdue', 'overdue'),
      loan('l-disbursed', 'disbursed'),
    ];
    render(<MyLoans />);
    expect(screen.getAllByRole('button', { name: /pagar/i })).toHaveLength(3);
  });

  it('does not show Pagar for pending, approved, or repaid loans', () => {
    loanDocs = [
      loan('l-pending', 'pending'),
      loan('l-approved', 'approved'),
      loan('l-repaid', 'repaid'),
    ];
    render(<MyLoans />);
    expect(screen.queryByRole('button', { name: /pagar/i })).not.toBeInTheDocument();
  });
});

describe('MyLoans — expanded loan detail fields', () => {
  it('renders the fee from loan.fee, not loan.feeAmount', () => {
    loanDocs = [loan('l-1', 'active', { fee: 300, feeAmount: 999 })];
    render(<MyLoans />);
    fireEvent.click(screen.getByText('$1,000').closest('tr')!);
    expect(screen.getByText('$300')).toBeInTheDocument();
    expect(screen.queryByText('$999')).not.toBeInTheDocument();
  });

  it('renders the term from loan.term, not loan.termDays', () => {
    loanDocs = [loan('l-1', 'active', { term: 45, termDays: 30 })];
    render(<MyLoans />);
    fireEvent.click(screen.getByText('$1,000').closest('tr')!);
    expect(screen.getByText(/\b45\b days|\b45\b días/)).toBeInTheDocument();
  });
});

describe('MyLoans — term never comes from a client constant', () => {
  it('renders an em dash, not a hardcoded 30 days, when the loan carries no term', () => {
    repaymentDocs = [];
    loanDocs = [loan('l-1', 'active', { term: undefined })];
    render(<MyLoans />);
    fireEvent.click(screen.getByText('$1,000').closest('tr')!);
    expect(screen.queryByText(/\b30\b (days|días)/)).not.toBeInTheDocument();
  });
});

// applyRepayment.js writes exactly 'completed' and 'unapplied' on a repayment
// row. 'pending'/'processing' badges could never render; an 'unapplied' row
// (money received against an already-settled loan) must not count as repaid.
describe('MyLoans — repayment status vocabulary', () => {
  const repayment = (id: string, status: string, amount: number) => ({
    id,
    data: () => ({ loanId: 'l-1', employeeId: 'emp-1', amount, status, createdAt: { seconds: 1_788_100_000 } }),
  });

  it('counts only completed repayments toward the balance and the repaid total', () => {
    loanDocs = [loan('l-1', 'active')];
    repaymentDocs = [repayment('r-1', 'completed', 200), repayment('r-2', 'unapplied', 500)];
    render(<MyLoans />);
    // Balance = total 1,300 − completed 200. Counting the unapplied 500 too
    // would read 600.
    expect(screen.getByText('$1,100', { selector: 'td' })).toBeInTheDocument();
    expect(screen.queryByText('$600', { selector: 'td' })).not.toBeInTheDocument();
  });

  it('labels an unapplied repayment as not applied, never as pending', () => {
    loanDocs = [loan('l-1', 'active')];
    repaymentDocs = [repayment('r-2', 'unapplied', 500)];
    render(<MyLoans />);
    fireEvent.click(screen.getAllByText('$1,000')[0].closest('tr')!);
    expect(screen.getByText('No aplicado')).toBeInTheDocument();
    expect(screen.queryByText('Pendiente')).not.toBeInTheDocument();
  });
});
