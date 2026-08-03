/**
 * PayrollUpload — the employer's only confirmation that a deduction batch
 * landed.
 *
 * Regression coverage for E5: every counter on this page is derived from a
 * `status` field on each result row, and the server never wrote one. So a
 * batch that deducted correctly reported "deducted: 0 ... Total deducted: $0",
 * and each row badge called `t('payroll_status_undefined')` — a key that does
 * not exist, which i18next (configured with no parseMissingKeyHandler) renders
 * as the literal string `payroll_status_undefined`.
 *
 * A test that only checks the happy path would still have passed against the
 * old client, so the second case below feeds a row status the client does not
 * know about — which is exactly the shape the bug took.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const MOCK_USER = { uid: 'employer-1' };
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: MOCK_USER }) }));

// Papa.parse reads a File through FileReader; drive the component's own
// callback directly instead so these tests exercise the component, not the
// CSV reader.
const CSV_ROWS = [
  { employeeId: 'emp-1', grossSalary: '20000', netSalary: '16000', payPeriod: '2026-07-15', deductionAmount: '1000' },
  { employeeId: 'emp-2', grossSalary: '18000', netSalary: '15000', payPeriod: '2026-07-15', deductionAmount: '500' },
];
vi.mock('papaparse', () => ({
  default: {
    parse: (_file: unknown, opts: { complete: (res: unknown) => void }) => {
      opts.complete({
        data: CSV_ROWS,
        meta: { fields: ['employeeId', 'grossSalary', 'netSalary', 'payPeriod', 'deductionAmount'] },
      });
    },
  },
}));

let serverResults: Array<Record<string, unknown>> = [];
vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn(() => async () => ({ data: { processedCount: 0, results: serverResults } })),
}));

import i18n from '../i18n';
import { PayrollUpload } from './PayrollUpload';

async function uploadAndSubmit() {
  render(<PayrollUpload />);

  const input = screen.getByLabelText(/drag your csv file here/i) as HTMLInputElement;
  const file = new File(['employeeId\n'], 'payroll.csv', { type: 'text/csv' });
  fireEvent.change(input, { target: { files: [file] } });

  await screen.findByText(/process payroll/i);
  fireEvent.change(screen.getByLabelText(/period start/i), { target: { value: '2026-07-01' } });
  fireEvent.change(screen.getByLabelText(/period end/i), { target: { value: '2026-07-15' } });
  fireEvent.click(screen.getByText(/process payroll/i));
}

beforeEach(async () => {
  serverResults = [];
  // The app defaults to Spanish; assert against the English copy so the
  // expectations below read as the strings they are checking.
  await i18n.changeLanguage('en');
});

describe('PayrollUpload results summary', () => {
  it('reports what was actually deducted, not a structural zero', async () => {
    serverResults = [
      { employeeId: 'emp-1', status: 'deducted', deductionAmount: 1000, newBalance: 5500 },
      { employeeId: 'emp-2', status: 'deducted', deductionAmount: 500, newBalance: 3500 },
    ];

    await uploadAndSubmit();

    // Before the server emitted a row status this read "deducted: 0 ...
    // Total deducted: $0" for a batch that deducted correctly.
    await waitFor(() =>
      expect(
        screen.getByText(/Processed: 2, deducted: 2, skipped: 0, errors: 0\. Total deducted: \$1,500 MXN/),
      ).toBeInTheDocument(),
    );
  });

  it('counts skipped and errored rows separately', async () => {
    serverResults = [
      { employeeId: 'emp-1', status: 'deducted', deductionAmount: 1000, newBalance: 5500 },
      { employeeId: 'emp-2', status: 'skipped', deductionAmount: 0, error: 'no_deductible_loan' },
      { employeeId: 'emp-3', status: 'error', deductionAmount: 0, error: 'deduction_exceeds_balance:requested=65000,owed=6500' },
    ];

    await uploadAndSubmit();

    await waitFor(() =>
      expect(
        screen.getByText(/Processed: 3, deducted: 1, skipped: 1, errors: 1\. Total deducted: \$1,000 MXN/),
      ).toBeInTheDocument(),
    );
    // The over-stated-deduction rejection has to reach the employer, verbatim —
    // it is the only place the discrepancy is visible to them.
    expect(screen.getByText(/deduction_exceeds_balance:requested=65000,owed=6500/)).toBeInTheDocument();
  });
});

describe('PayrollUpload row status badge', () => {
  it.each([
    ['deducted', 'Deducted'],
    ['skipped', 'Skipped'],
    ['error', 'Error'],
    ['already_processed', 'Already processed'],
  ])('renders a real label for the %s outcome', async (status, label) => {
    serverResults = [{ employeeId: 'emp-1', status, deductionAmount: 0 }];

    await uploadAndSubmit();

    await waitFor(() => expect(screen.getByText(label)).toBeInTheDocument());
  });

  it('falls back to a real label rather than printing a missing i18n key', async () => {
    // A row status the client does not know — either an older/newer server, or
    // the original defect, where the field was absent entirely.
    serverResults = [
      { employeeId: 'emp-1', deductionAmount: 0 },
      { employeeId: 'emp-2', status: 'some_future_outcome', deductionAmount: 0 },
    ];

    await uploadAndSubmit();

    await waitFor(() => expect(screen.getAllByText('Unknown')).toHaveLength(2));
    expect(screen.queryByText(/payroll_status_/)).not.toBeInTheDocument();
  });
});
