/**
 * DeductionReports — the employer-facing deduction obligation.
 *
 * Regression coverage for two defects:
 *  - getDeductionAmount() used to fall through to `loan.amount` (bare
 *    principal) because `deductionAmount`/`repaymentAmount` are never
 *    written to a loan document. The real obligation is `loan.total`
 *    (amount + fee), or `loan.remainingBalance` once a partial payroll
 *    deduction has been applied.
 *  - the Firestore status filter queried the dead spelling 'paid' instead
 *    of 'repaid', and never queried the live 'disbursed'/'overdue'
 *    statuses at all, so manually-disbursed loans never appeared here and
 *    never got deducted.
 *
 * A test that would still pass against `loan.deductionAmount ??
 * loan.repaymentAmount ?? loan.amount` is worthless here — every fixture
 * below is built to fail on that expression and pass on the fix.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase', () => ({ db: {}, auth: { currentUser: null } }));

// A stable reference, not a literal recreated per call: DeductionReports'
// data-fetch effect depends on [user], so a fresh object every render would
// refire the effect (and its setState) every render — an infinite loop.
const MOCK_USER = { uid: 'employer-1' };
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ user: MOCK_USER }),
}));

let snapshotLoans: Array<{ id: string; data: Record<string, unknown> }> = [];
let capturedStatusFilter: unknown[] = [];

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(),
  query: vi.fn(),
  where: vi.fn((field: string, _op: string, value: unknown) => {
    if (field === 'status') capturedStatusFilter = value as unknown[];
    return { field, value };
  }),
  orderBy: vi.fn(),
  onSnapshot: vi.fn((_q, callback: (snap: unknown) => void) => {
    callback({
      docs: snapshotLoans.map((l) => ({ id: l.id, data: () => l.data })),
    });
    return () => {};
  }),
}));

import '../i18n';
import {
  buildCsvRows,
  DeductionReports,
  getDeductionAmount,
  groupByPeriod,
  type Loan,
} from './DeductionReports';

const FEE_LOAN: Loan = {
  id: 'loan-fee',
  employeeName: 'Ana Pérez',
  amount: 1000,
  fee: 300,
  total: 1300,
  status: 'active',
  createdAt: { seconds: 1704067200 },
};

const PARTIALLY_PAID_LOAN: Loan = {
  id: 'loan-partial',
  employeeName: 'Luis Gómez',
  amount: 2000,
  fee: 600,
  total: 2600,
  remainingBalance: 1600,
  status: 'active',
  createdAt: { seconds: 1704067200 },
};

const DISBURSED_LOAN: Loan = {
  id: 'loan-disbursed',
  employeeName: 'Marta Ruiz',
  amount: 500,
  fee: 150,
  total: 650,
  status: 'disbursed',
  createdAt: { seconds: 1704067200 },
};

describe('getDeductionAmount', () => {
  it('returns the obligation (amount + fee), not the bare principal', () => {
    expect(getDeductionAmount(FEE_LOAN)).toBe(1300);
    expect(getDeductionAmount(FEE_LOAN)).not.toBe(FEE_LOAN.amount);
  });

  it('returns the remaining balance for a partially-deducted loan, not the original total', () => {
    expect(getDeductionAmount(PARTIALLY_PAID_LOAN)).toBe(1600);
    expect(getDeductionAmount(PARTIALLY_PAID_LOAN)).not.toBe(PARTIALLY_PAID_LOAN.total);
    expect(getDeductionAmount(PARTIALLY_PAID_LOAN)).not.toBe(PARTIALLY_PAID_LOAN.amount);
  });

  it('returns null, not bare principal, when neither remainingBalance nor total is present', () => {
    const legacyLoan: Loan = { id: 'legacy', amount: 900, status: 'active' };
    expect(getDeductionAmount(legacyLoan)).toBeNull();
  });
});

describe('DeductionReports status query', () => {
  it('queries the canonical "repaid" plus the live disbursed/overdue statuses, not just active/paid', async () => {
    snapshotLoans = [{ id: DISBURSED_LOAN.id, data: DISBURSED_LOAN }];
    render(<DeductionReports />);

    // 'paid' is kept too (a dead spelling, but historical documents may still
    // carry it — see loanStatus.ts). The bug was that 'repaid' (the spelling
    // every live write path actually produces) and 'disbursed'/'overdue' were
    // missing entirely, not that 'paid' was present.
    expect(capturedStatusFilter).toEqual(
      expect.arrayContaining(['active', 'disbursed', 'overdue', 'repaid']),
    );
  });

  it('shows a manually-disbursed loan in the report with its correct obligation', async () => {
    snapshotLoans = [{ id: DISBURSED_LOAN.id, data: DISBURSED_LOAN }];
    render(<DeductionReports />);

    expect(await screen.findByText('Marta Ruiz')).toBeInTheDocument();
    expect(screen.getByText('$650.00')).toBeInTheDocument();
  });
});

describe('CSV export', () => {
  it('carries the same corrected obligation as the on-screen row, for every loan shape', () => {
    const groups = groupByPeriod([FEE_LOAN, PARTIALLY_PAID_LOAN, DISBURSED_LOAN]);
    const rows = buildCsvRows(groups);

    const feeRow = rows.find((r) => r[1] === 'Ana Pérez');
    const partialRow = rows.find((r) => r[1] === 'Luis Gómez');
    const disbursedRow = rows.find((r) => r[1] === 'Marta Ruiz');

    expect(feeRow?.[2]).toBe('1,300.00');
    expect(partialRow?.[2]).toBe('1,600.00');
    expect(disbursedRow?.[2]).toBe('650.00');
  });
});
