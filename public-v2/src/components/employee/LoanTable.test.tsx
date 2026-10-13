/**
 * LoanTable — the "Pagar" button gate, and the fee/term display fields.
 *
 * C1: the server (generatePaymentLink.ts) accepts REPAYABLE_STATUSES —
 * 'active' | 'disbursed' | 'overdue'. This table used to gate on 'active' | 'overdue' only, so a
 * manually ops-disbursed loan ('disbursed') silently lost its Pagar button
 * even though the server would have honored the request.
 *
 * C3: the persisted field is `term` (index.ts:839); `termDays` is only the
 * request-payload name and is never written to the document, so reading it
 * here always fell through to a `?? 30` default — and that default is gone
 * too: a term the loan doesn't carry renders as missing, not as 30.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import '../../i18n';
import { LoanTable } from './LoanTable';
import type { Loan } from './types';

const baseLoan = (status: string, extra: Partial<Loan> = {}): Loan => ({
  id: `loan-${status}`,
  amount: 1000,
  total: 1300,
  status,
  createdAt: { seconds: 1_788_000_000 },
  ...extra,
});

const noop = () => {};

describe('LoanTable — Pagar button gate', () => {
  it('shows Pagar for active, overdue, and disbursed loans', () => {
    const loans = [
      baseLoan('active'),
      baseLoan('overdue'),
      baseLoan('disbursed'),
    ];
    render(
      <LoanTable
        loans={loans}
        repaymentsByLoan={{}}
        loading={false}
        onOpenModal={noop}
        onPayLoan={noop}
      />
    );
    expect(screen.getAllByRole('button', { name: /pagar/i })).toHaveLength(3);
  });

  it('does not show Pagar for pending, approved, or repaid loans', () => {
    const loans = [
      baseLoan('pending'),
      baseLoan('approved'),
      baseLoan('repaid'),
    ];
    render(
      <LoanTable
        loans={loans}
        repaymentsByLoan={{}}
        loading={false}
        onOpenModal={noop}
        onPayLoan={noop}
      />
    );
    expect(screen.queryByRole('button', { name: /pagar/i })).not.toBeInTheDocument();
  });
});

describe('LoanTable — term rendering', () => {
  it('renders the term from loan.term, not loan.termDays', () => {
    render(
      <LoanTable
        loans={[baseLoan('active', { term: 45, termDays: 30 })]}
        repaymentsByLoan={{}}
        loading={false}
        onOpenModal={noop}
        onPayLoan={noop}
      />
    );
    expect(screen.getByText(/\b45\b.*días/)).toBeInTheDocument();
    expect(screen.queryByText(/\b30\b.*días/)).not.toBeInTheDocument();
  });

  // F5: a missing term used to render a hardcoded "30 días" — correct only by
  // accident while 30 is the one allowed term. The loan's own value or nothing.
  it('renders an em dash, not a client-side 30 days, when loan.term is absent', () => {
    render(
      <LoanTable
        loans={[baseLoan('active')]}
        repaymentsByLoan={{}}
        loading={false}
        onOpenModal={noop}
        onPayLoan={noop}
      />
    );
    expect(screen.queryByText(/\b30\b.*días/)).not.toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

// applyRepayment.js writes exactly 'completed' and 'unapplied' on a repayment
// row. The old 'pending'/'processing' badges could never render, and an
// 'unapplied' row must not read as paid toward this loan.
describe('LoanTable — repayment badges', () => {
  const repayment = (status: string) => ({ id: `r-${status}`, loanId: 'loan-active', amount: 100, status });

  it('shows Pagado only for an applied (completed) repayment', () => {
    render(
      <LoanTable
        loans={[baseLoan('active')]}
        repaymentsByLoan={{ 'loan-active': [repayment('completed')] }}
        loading={false}
        onOpenModal={noop}
        onPayLoan={noop}
      />
    );
    expect(screen.getByText('Pagado')).toBeInTheDocument();
  });

  it('does not show Pagado for an unapplied repayment', () => {
    render(
      <LoanTable
        loans={[baseLoan('active')]}
        repaymentsByLoan={{ 'loan-active': [repayment('unapplied')] }}
        loading={false}
        onOpenModal={noop}
        onPayLoan={noop}
      />
    );
    expect(screen.queryByText('Pagado')).not.toBeInTheDocument();
  });
});
