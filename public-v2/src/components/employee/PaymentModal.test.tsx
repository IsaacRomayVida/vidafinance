/**
 * PaymentModal — the repayment history badges and the remaining balance.
 *
 * services/payment-server/applyRepayment.js is the only writer of
 * `repayments/{id}.status`, and it writes exactly 'completed' and 'unapplied'.
 * The modal used to branch on 'processing' and default everything else to
 * "Pendiente", so an 'unapplied' row — money received against a loan that was
 * already settled — told the borrower a payment was on its way to this loan.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('firebase/functions', () => ({
  getFunctions: () => ({}),
  httpsCallable: () => vi.fn(),
}));

import '../../i18n';
import { PaymentModal } from './PaymentModal';
import type { Loan, Repayment } from './types';

const loan: Loan = { id: 'l-1', amount: 1000, total: 1300, status: 'active' };
const repayment = (id: string, status: string, amount: number): Repayment => ({
  id,
  loanId: 'l-1',
  amount,
  status,
  createdAt: { seconds: 1_788_100_000 },
});

describe('PaymentModal — repayment status vocabulary', () => {
  it('labels an unapplied repayment as not applied, never as pending', () => {
    render(<PaymentModal loan={loan} repayments={[repayment('r-1', 'unapplied', 500)]} onClose={() => {}} />);
    expect(screen.getByText('No aplicado')).toBeInTheDocument();
    expect(screen.queryByText('Pendiente')).not.toBeInTheDocument();
  });

  it('does not count an unapplied repayment against the remaining balance', () => {
    render(
      <PaymentModal
        loan={loan}
        repayments={[repayment('r-1', 'completed', 200), repayment('r-2', 'unapplied', 500)]}
        onClose={() => {}}
      />,
    );
    // 1,300 − 200 completed. Counting the unapplied 500 would read 600.
    expect(screen.getAllByText('1,100').length).toBeGreaterThan(0);
    expect(screen.queryByText('600')).not.toBeInTheDocument();
  });
});
