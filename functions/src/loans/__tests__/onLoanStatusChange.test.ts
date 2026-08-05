// Regression coverage for the dead repayment listener: this trigger used to
// gate its employer/employee counter updates on `beforeStatus === 'approved'
// && afterStatus === 'paid'` — a transition no write path has ever produced.
// processPayroll.ts (the only path that completes a repayment) moves a loan
// straight from 'active'/'disbursed' to 'repaid', so the employer's
// active-loan slot was never released and the employee's available credit
// was never restored. See functions/src/loans/loanStatus.ts.
jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentUpdated: (_cfg: unknown, handler: unknown) => handler,
}));

import { onLoanStatusChange } from '../onLoanStatusChange';
import { _mockStore } from '../../__mocks__/firebase-admin/firestore';

type TriggerHandler = (event: unknown) => Promise<unknown>;
const handler = onLoanStatusChange as unknown as TriggerHandler;

function buildEvent(beforeStatus: string, afterStatus: string, afterExtra: Record<string, unknown> = {}) {
  return {
    params: { loanId: 'loan-test-1' },
    data: {
      before: { data: () => ({ status: beforeStatus, employerId: 'employer-1', employeeId: 'employee-1', amount: 1000 }) },
      after: {
        data: () => ({
          status: afterStatus,
          employerId: 'employer-1',
          employeeId: 'employee-1',
          amount: 1000,
          ...afterExtra,
        }),
      },
    },
  };
}

function updatesFor(collection: string, id: string) {
  return _mockStore.docUpdates.filter((u) => u.collection === collection && u.id === id);
}

beforeEach(() => {
  jest.clearAllMocks();
  _mockStore.docUpdates = [];
});

describe('onLoanStatusChange repayment counters', () => {
  it('releases the employer active-loan slot and restores employee credit on active -> repaid', async () => {
    await handler(buildEvent('active', 'repaid'));

    const employerUpdates = updatesFor('employers', 'employer-1');
    const employeeUpdates = updatesFor('employees', 'employee-1');
    expect(employerUpdates).toContainEqual(
      expect.objectContaining({ collection: 'employers', id: 'employer-1', data: { activeLoans: { _increment: -1 } } })
    );
    expect(employeeUpdates).toContainEqual(
      expect.objectContaining({ collection: 'employees', id: 'employee-1', data: { availableCredit: { _increment: 1000 } } })
    );
  });

  it('also fires on disbursed -> repaid', async () => {
    await handler(buildEvent('disbursed', 'repaid'));

    expect(updatesFor('employers', 'employer-1').length).toBe(1);
    expect(updatesFor('employees', 'employee-1').length).toBe(1);
  });

  // The 'paid' spelling belongs to services/payment-server, which increments
  // the employee's availableCredit itself inside the same transaction that
  // writes the status (order.paid, POST /internal/repayment). If this trigger
  // also fired on 'paid', the credit would be restored twice and the borrower
  // could re-borrow against money they never repaid.
  it('does NOT fire on -> paid, which payment-server already counters itself', async () => {
    await handler(buildEvent('active', 'paid'));
    expect(updatesFor('employers', 'employer-1').length).toBe(0);
    expect(updatesFor('employees', 'employee-1').length).toBe(0);
  });

  it('does not run the repayment counter update on pending -> approved (a different, unrelated transition)', async () => {
    await handler(buildEvent('pending', 'approved'));
    // pending -> approved legitimately increments activeLoans (a separate
    // code path, the approval block) — the repayment block must not ALSO
    // fire and decrement it back down.
    const employerUpdates = updatesFor('employers', 'employer-1');
    expect(employerUpdates).not.toContainEqual(
      expect.objectContaining({ data: { activeLoans: { _increment: -1 } } })
    );
    expect(updatesFor('employees', 'employee-1').length).toBe(0);
  });

  it('does not double-fire when a loan already repaid is updated again', async () => {
    await handler(buildEvent('repaid', 'repaid'));
    expect(updatesFor('employers', 'employer-1').length).toBe(0);
    expect(updatesFor('employees', 'employee-1').length).toBe(0);
  });

  // applyRepayment.js (services/payment-server) restores credit incrementally
  // as card/SoftCrédito-sync payments land against a loan it leaves `active`
  // for a partial payment, tracked cumulatively on loans.creditRestored and
  // capped at the principal. The employer's CSV upload (processPayroll.ts)
  // can finish off that SAME loan's remaining balance and write 'repaid'
  // directly -- it never reads or writes creditRestored. Restoring the full
  // principal again here on top of what applyRepayment.js already restored
  // hands the borrower more available credit than they ever held.
  it('restores only what is left of the principal when a partial card payment already restored some credit', async () => {
    await handler(buildEvent('active', 'repaid', { creditRestored: 400 }));

    expect(updatesFor('employees', 'employee-1')).toContainEqual(
      expect.objectContaining({ collection: 'employees', id: 'employee-1', data: { availableCredit: { _increment: 600 } } })
    );
  });

  it('restores nothing further when prior partial payments already restored the full principal', async () => {
    await handler(buildEvent('active', 'repaid', { creditRestored: 1000 }));

    expect(updatesFor('employees', 'employee-1').length).toBe(0);
    // The employer's active-loan slot must still be released even though no
    // further credit moves.
    expect(updatesFor('employers', 'employer-1')).toContainEqual(
      expect.objectContaining({ collection: 'employers', id: 'employer-1', data: { activeLoans: { _increment: -1 } } })
    );
  });
});
