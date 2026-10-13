/**
 * DeductionReports — the employer-facing deduction obligation.
 *
 * Regression coverage for two defects:
 *  - getOutstandingBalance() used to fall through to `loan.amount` (bare
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
  CSV_HEADERS,
  installmentRows,
  getOutstandingBalance,
  getPayFrequency,
  groupByPeriod,
  type Loan,
} from '../lib/deductionReport';
import { DeductionReports } from './DeductionReports';

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

describe('getOutstandingBalance', () => {
  it('is zero for a repaid loan, even one whose document still carries only `total`', () => {
    expect(getOutstandingBalance({ ...FEE_LOAN, status: 'repaid' })).toBe(0);
    expect(getOutstandingBalance({ ...FEE_LOAN, status: 'paid' })).toBe(0);
  });

  it('returns the obligation (amount + fee), not the bare principal', () => {
    expect(getOutstandingBalance(FEE_LOAN)).toBe(1300);
    expect(getOutstandingBalance(FEE_LOAN)).not.toBe(FEE_LOAN.amount);
  });

  it('returns the remaining balance for a partially-deducted loan, not the original total', () => {
    expect(getOutstandingBalance(PARTIALLY_PAID_LOAN)).toBe(1600);
    expect(getOutstandingBalance(PARTIALLY_PAID_LOAN)).not.toBe(PARTIALLY_PAID_LOAN.total);
    expect(getOutstandingBalance(PARTIALLY_PAID_LOAN)).not.toBe(PARTIALLY_PAID_LOAN.amount);
  });

  it('returns null, not bare principal, when neither remainingBalance nor total is present', () => {
    const legacyLoan: Loan = { id: 'legacy', amount: 900, status: 'active' };
    expect(getOutstandingBalance(legacyLoan)).toBeNull();
  });
});

const WEEKLY_LOAN: Loan = {
  id: 'loan-weekly',
  employeeName: 'Sofía Torres',
  amount: 800,
  fee: 240,
  total: 1040,
  status: 'active',
  borrowerSnapshot: { payFrequency: 'weekly' },
  payFrequencySource: 'loan_snapshot',
  createdAt: { seconds: 1704067200 },
};

const ASSUMED_MONTHLY_LOAN: Loan = {
  id: 'loan-assumed',
  employeeName: 'Diego Ríos',
  amount: 700,
  fee: 210,
  total: 910,
  status: 'active',
  borrowerSnapshot: { payFrequency: 'monthly' },
  payFrequencySource: 'default_monthly',
  createdAt: { seconds: 1704067200 },
};

const LEGACY_NO_FREQUENCY_LOAN: Loan = {
  id: 'loan-legacy-freq',
  employeeName: 'Elena Vidal',
  amount: 600,
  fee: 180,
  total: 780,
  status: 'active',
  createdAt: { seconds: 1704067200 },
};

describe('getPayFrequency', () => {
  it('reads borrowerSnapshot.payFrequency, not the never-written loan.frequency field', () => {
    expect(getPayFrequency(WEEKLY_LOAN)).toBe('weekly');
    expect(getPayFrequency({ ...WEEKLY_LOAN, frequency: 'monthly' } as Loan)).toBe('weekly');
  });

  it('returns null, not "monthly", when the cadence is only an assumption (default_monthly)', () => {
    expect(getPayFrequency(ASSUMED_MONTHLY_LOAN)).toBeNull();
  });

  it('returns null, not "monthly", when no frequency was ever recorded', () => {
    expect(getPayFrequency(LEGACY_NO_FREQUENCY_LOAN)).toBeNull();
  });
});

describe('DeductionReports frequency column', () => {
  it('renders the real cadence from borrowerSnapshot.payFrequency', async () => {
    snapshotLoans = [{ id: WEEKLY_LOAN.id, data: WEEKLY_LOAN }];
    render(<DeductionReports />);

    expect(await screen.findByText('Sofía Torres')).toBeInTheDocument();
    expect(screen.getByText('weekly')).toBeInTheDocument();
    expect(screen.queryByText('monthly')).not.toBeInTheDocument();
  });

  it('shows an honest "—" instead of "monthly" when the cadence was only assumed', async () => {
    snapshotLoans = [{ id: ASSUMED_MONTHLY_LOAN.id, data: ASSUMED_MONTHLY_LOAN }];
    render(<DeductionReports />);

    expect(await screen.findByText('Diego Ríos')).toBeInTheDocument();
    expect(screen.queryByText('monthly')).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
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

    // Index 4 is the outstanding balance; these fixtures carry no schedule,
    // so their per-period deduction (index 3) is an honest '—'.
    expect(feeRow?.[4]).toBe('1,300.00');
    expect(partialRow?.[4]).toBe('1,600.00');
    expect(disbursedRow?.[4]).toBe('650.00');
    expect(feeRow?.[3]).toBe('—');
  });

  it('carries the real cadence, not "monthly", and leaves an assumed cadence blank rather than inventing one', () => {
    const groups = groupByPeriod([WEEKLY_LOAN, ASSUMED_MONTHLY_LOAN, LEGACY_NO_FREQUENCY_LOAN]);
    const rows = buildCsvRows(groups);

    const weeklyRow = rows.find((r) => r[1] === 'Sofía Torres');
    const assumedRow = rows.find((r) => r[1] === 'Diego Ríos');
    const legacyRow = rows.find((r) => r[1] === 'Elena Vidal');

    expect(weeklyRow?.[5]).toBe('weekly');
    expect(assumedRow?.[5]).toBe('');
    expect(legacyRow?.[5]).toBe('');
  });
});

/**
 * E10 (AUDIT_EMPLOYER_PATH.md): the "Deducción" column was the loan's WHOLE
 * outstanding balance, filed under the month the loan was created. An employer
 * reconciling payroll against it withheld the entire debt from one paycheck.
 * It is now the contractual installment still to be withheld, filed under the
 * month it falls due, with the balance as its own separately-labelled column.
 */
describe('E10 — per-period deduction comes from the repayment schedule', () => {
  // Local-midnight dates, as calculateNextPayrollDate builds them.
  const jan15 = new Date(2026, 0, 15);
  const feb15 = new Date(2026, 1, 15);
  const ts = (d: Date) => ({ seconds: d.getTime() / 1000, toDate: () => d });

  const SCHEDULED_LOAN: Loan = {
    id: 'loan-scheduled',
    employeeName: 'Rosa Medina',
    amount: 1000,
    fee: 300,
    total: 1300,
    status: 'active',
    // Originated in December — the old grouping filed it there.
    createdAt: { seconds: new Date(2025, 11, 20).getTime() / 1000 },
    repaymentSchedule: [
      { number: 1, amount: 650, dueDate: ts(jan15) },
      { number: 2, amount: 650, dueDate: ts(feb15) },
    ],
  };

  it('bills each installment, not the whole balance, per period', () => {
    const rows = installmentRows(SCHEDULED_LOAN);
    expect(rows.map((r) => r.deduction)).toEqual([650, 650]);
  });

  it('groups by the month an installment falls due, not the month the loan was created', () => {
    const groups = groupByPeriod([SCHEDULED_LOAN]);
    expect(groups.map((g) => g.key)).toEqual(['2026-02', '2026-01']);
    expect(groups.map((g) => g.total)).toEqual([650, 650]);
  });

  it('nets off what has been collected, oldest installment first', () => {
    // 400 collected (by payroll or card) leaves 250 of January and all of February.
    const rows = installmentRows({ ...SCHEDULED_LOAN, remainingBalance: 900 });
    expect(rows.map((r) => r.deduction)).toEqual([250, 650]);
  });

  it('asks for nothing more on a repaid loan', () => {
    const rows = installmentRows({ ...SCHEDULED_LOAN, status: 'repaid' });
    expect(rows.map((r) => r.deduction)).toEqual([0, 0]);
  });

  it('accepts a schedule whose dates arrive as {seconds} only', () => {
    const rows = installmentRows({
      ...SCHEDULED_LOAN,
      repaymentSchedule: [{ amount: 1300, dueDate: { seconds: jan15.getTime() / 1000 } }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].deduction).toBe(1300);
    expect(rows[0].dueDate?.getTime()).toBe(jan15.getTime());
  });

  it('refuses to guess for a loan with no (or an unreadable) schedule', () => {
    expect(installmentRows(FEE_LOAN)).toEqual([{ loan: FEE_LOAN, dueDate: null, deduction: null }]);
    const broken = { ...SCHEDULED_LOAN, repaymentSchedule: [{ amount: 650, dueDate: ts(jan15) }, { amount: 650 }] };
    expect(installmentRows(broken)[0].deduction).toBeNull();
  });

  it('exports the due date, installment and balance as separate columns', () => {
    expect(CSV_HEADERS.slice(2, 5)).toEqual(['Due Date', 'Deduction Amount', 'Outstanding Balance']);
    const rows = buildCsvRows(groupByPeriod([SCHEDULED_LOAN]));
    const jan = rows.find((r) => r[1] === 'Rosa Medina' && r[2] === '2026-01-15');
    expect(jan?.[0]).toBe('Enero 2026');
    expect(jan?.[3]).toBe('650.00');
    expect(jan?.[4]).toBe('1,300.00');
  });

  it('renders the installment under "Deducción" and the balance under its own header', async () => {
    snapshotLoans = [{ id: SCHEDULED_LOAN.id, data: SCHEDULED_LOAN }];
    render(<DeductionReports />);

    expect((await screen.findAllByText('Rosa Medina')).length).toBe(2);
    expect(screen.getAllByText('$650.00')).toHaveLength(2);
    expect(screen.getAllByText('$1,300.00')).toHaveLength(2); // balance column, once per row
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(expect.arrayContaining(['Fecha de cobro', 'Deducción', 'Saldo pendiente']));
  });
});
