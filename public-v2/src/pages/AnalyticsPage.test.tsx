/**
 * AnalyticsPage — the employer's programme-health numbers.
 *
 * Regression coverage for AUDIT_EMPLOYER_PATH.md:
 *  - E11: "Créditos activos" counted ['approved', 'disbursed',
 *    'disbursement_queued'] — omitting 'active', the status the automatic
 *    disbursement path writes — and summed `amount` (principal) under a label
 *    that says "outstanding".
 *  - E12: the repayment rate read `paidAt`, which only the card channel
 *    writes; payroll (the primary channel) writes `repaidAt`, so the rate was
 *    pinned near 0% by construction.
 *  - E13: neither listener had an error callback, so a failed read left the
 *    page on "Cargando…" forever.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase', () => ({ db: {}, auth: { currentUser: null } }));

const MOCK_USER = { uid: 'employer-1' };
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: MOCK_USER }) }));

type Docs = Array<{ id: string; data: Record<string, unknown> }>;
let loanDocs: Docs = [];
let employeeDocs: Docs = [];
let failCollection: string | null = null;

vi.mock('firebase/firestore', () => ({
  collection: vi.fn((_db: unknown, name: string) => ({ __name: name })),
  query: vi.fn((ref: unknown) => ref),
  where: vi.fn(),
  onSnapshot: vi.fn((q: { __name: string }, ok: (snap: unknown) => void, err?: (e: unknown) => void) => {
    if (q.__name === failCollection) {
      err?.(new Error('permission-denied'));
    } else {
      const docs = q.__name === 'loans' ? loanDocs : employeeDocs;
      ok({ docs: docs.map((d) => ({ id: d.id, data: () => d.data })) });
    }
    return () => {};
  }),
}));

import '../i18n';
import { AnalyticsPage } from './AnalyticsPage';

const sec = (iso: string) => ({ seconds: new Date(iso).getTime() / 1000 });

beforeEach(() => {
  failCollection = null;
  employeeDocs = [{ id: 'e-1', data: {} }, { id: 'e-2', data: {} }];
  loanDocs = [];
});

describe('AnalyticsPage — active loans (E11)', () => {
  it('counts active, disbursed and overdue loans and sums what is outstanding, not principal', async () => {
    loanDocs = [
      { id: 'l-1', data: { status: 'active', amount: 1000, total: 1300 } },
      { id: 'l-2', data: { status: 'disbursed', amount: 2000, total: 2600, remainingBalance: 1000 } },
      { id: 'l-3', data: { status: 'overdue', amount: 500, total: 650 } },
      // No money has moved on these two; they are not active loans.
      { id: 'l-4', data: { status: 'approved', amount: 9000, total: 11700 } },
      { id: 'l-5', data: { status: 'disbursement_queued', amount: 9000, total: 11700 } },
    ];
    render(<AnalyticsPage />);

    const tile = (await screen.findByText('Créditos activos')).closest('.ops-kpi') as HTMLElement;
    expect(tile.querySelector('b')?.textContent).toBe('3');
    // 1300 + 1000 + 650 — the outstanding obligation, not 1000 + 2000 + 500 principal.
    expect(tile.querySelector('em')?.textContent).toBe('$2,950 MXN pendientes');
  });
});

describe('AnalyticsPage — repayment rate (E12)', () => {
  it('counts a loan settled by payroll (repaidAt) as repaid on time', async () => {
    loanDocs = [
      { id: 'l-1', data: { status: 'repaid', amount: 1000, dueDate: sec('2026-03-01'), repaidAt: sec('2026-02-27') } },
      { id: 'l-2', data: { status: 'paid', amount: 1000, dueDate: sec('2026-03-01'), paidAt: sec('2026-02-28') } },
      { id: 'l-3', data: { status: 'repaid', amount: 1000, dueDate: sec('2026-03-01'), repaidAt: sec('2026-03-09') } },
      { id: 'l-4', data: { status: 'active', amount: 1000, dueDate: sec('2026-03-01') } },
    ];
    render(<AnalyticsPage />);

    const tile = (await screen.findByText('Tasa de pago')).closest('.ops-kpi') as HTMLElement;
    // l-1 (payroll) and l-2 (card) on time; l-3 late; l-4 unpaid → 2 / 4.
    expect(tile.querySelector('b')?.textContent).toBe('50.0%');
  });
});

describe('AnalyticsPage — read failures (E13)', () => {
  it.each(['loans', 'employees'])('shows an error instead of loading forever when the %s read fails', async (name) => {
    failCollection = name;
    render(<AnalyticsPage />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/No pudimos cargar tus estadísticas/)).toBeTruthy();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });
});
