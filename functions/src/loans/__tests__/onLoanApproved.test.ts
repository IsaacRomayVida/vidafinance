// Verifies the disbursement-failure guard: a failed or unconfigured SPEI must
// NEVER mark a loan `active` with a fake STUB reference. It must surface
// `disbursement_failed` so ops can retry, instead of reporting funds as sent.

jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentUpdated: (_cfg: unknown, handler: unknown) => handler,
}));
jest.mock('../../utils/queue', () => ({
  getQueue: () => ({ add: jest.fn().mockResolvedValue(undefined) }),
}));
jest.mock('../../utils/notify', () => ({
  notifyLoanEvent: jest.fn().mockResolvedValue(undefined),
}));

import { onLoanApproved } from '../onLoanApproved';
import { _mockStore } from '../../__mocks__/firebase-admin/firestore';
import fetch from 'node-fetch';

const mockFetch = fetch as unknown as jest.Mock;

type TriggerHandler = (event: unknown) => Promise<unknown>;
const handler = onLoanApproved as unknown as TriggerHandler;

function buildEvent() {
  return {
    params: { loanId: 'loan-test-1' },
    data: {
      before: { data: () => ({ status: 'pending' }) },
      after: {
        data: () => ({
          status: 'approved',
          employeeId: 'emp-1',
          employeeName: 'Test User',
          employerId: 'employer-1',
          employerName: 'ACME',
          amount: 1000,
          total: 1300,
          dueDate: { toDate: () => new Date('2026-07-01T00:00:00.000Z') },
        }),
      },
    },
  };
}

function loanStatusUpdates(): string[] {
  return _mockStore.docUpdates
    .filter((u) => u.collection === 'loans' && typeof u.data['status'] === 'string')
    .map((u) => u.data['status'] as string);
}

beforeEach(() => {
  jest.clearAllMocks();
  _mockStore.docUpdates = [];
  delete process.env['SOFTCREDITO_ADAPTER_URL'];
  delete process.env['INTERNAL_SECRET'];
  delete process.env['ALLOW_STUB_DISBURSEMENT'];
  delete process.env['PDF_GENERATOR_URL'];
});

describe('onLoanApproved disbursement guard', () => {
  it('marks disbursement_failed (never active) when SPEI fails', async () => {
    process.env['SOFTCREDITO_ADAPTER_URL'] = 'http://softcredito-adapter.railway.internal:3002';
    process.env['INTERNAL_SECRET'] = 'secret';
    mockFetch.mockRejectedValue(new Error('network down'));

    await handler(buildEvent());

    const statuses = loanStatusUpdates();
    expect(statuses).toContain('disbursement_failed');
    expect(statuses).not.toContain('active');
    // No fake STUB reference should ever be written.
    const refs = _mockStore.docUpdates
      .filter((u) => u.collection === 'loans')
      .map((u) => u.data['disbursementRef']);
    expect(refs.every((r) => r === undefined)).toBe(true);
  });

  it('marks disbursement_failed when the adapter is not configured (no stub)', async () => {
    // No SOFTCREDITO_ADAPTER_URL / INTERNAL_SECRET and ALLOW_STUB_DISBURSEMENT unset.
    await handler(buildEvent());

    const statuses = loanStatusUpdates();
    expect(statuses).toContain('disbursement_failed');
    expect(statuses).not.toContain('active');
  });

  it('allows a simulated disbursement only when ALLOW_STUB_DISBURSEMENT=true', async () => {
    process.env['ALLOW_STUB_DISBURSEMENT'] = 'true';

    await handler(buildEvent());

    const activeUpdate = _mockStore.docUpdates.find(
      (u) => u.collection === 'loans' && u.data['status'] === 'active'
    );
    expect(activeUpdate).toBeDefined();
    expect(String(activeUpdate!.data['disbursementRef'])).toMatch(/^STUB-/);
    expect(loanStatusUpdates()).not.toContain('disbursement_failed');
  });
});
