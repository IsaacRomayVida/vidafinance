/**
 * EmployeeRoster — regression coverage for AUDIT_EMPLOYER_PATH.md:
 *  - E11: "Préstamos Activos" counted `status === 'active'` only, dropping
 *    manually disbursed ('disbursed') and overdue loans that the deduction
 *    report on the next page bills the employer for.
 *  - E13: the invites listener had no error callback, so a failed read was
 *    silent and every employee looked un-invited.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase', () => ({ db: {}, auth: { currentUser: null } }));

const MOCK_USER = { uid: 'employer-1' };
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: MOCK_USER }) }));

type Docs = Array<{ id: string; data: Record<string, unknown> }>;
let loanDocs: Docs = [];
let failCollection: string | null = null;

vi.mock('firebase/firestore', () => ({
  doc: vi.fn(() => ({})),
  getDoc: vi.fn(async () => ({ exists: () => true, data: () => ({ employerCode: 'ACME01' }) })),
  collection: vi.fn((_db: unknown, name: string) => ({ __name: name })),
  query: vi.fn((ref: unknown) => ref),
  where: vi.fn(),
  onSnapshot: vi.fn((q: { __name: string }, ok: (snap: unknown) => void, err?: (e: unknown) => void) => {
    if (q.__name === failCollection) {
      err?.(new Error('permission-denied'));
    } else {
      const docs = q.__name === 'loans' ? loanDocs : [];
      ok({ docs: docs.map((d) => ({ id: d.id, data: () => d.data })) });
    }
    return () => {};
  }),
}));

vi.mock('firebase/functions', () => ({
  getFunctions: () => ({}),
  httpsCallable: () => async () => ({ data: {} }),
}));

import '../i18n';
import { EmployeeRoster } from './EmployeeRoster';

beforeEach(() => {
  failCollection = null;
  loanDocs = [];
});

describe('EmployeeRoster — active loan count (E11)', () => {
  it('counts active, disbursed and overdue loans, but not undisbursed or repaid ones', async () => {
    loanDocs = [
      { id: 'l-1', data: { status: 'active', employeeId: 'e-1' } },
      { id: 'l-2', data: { status: 'disbursed', employeeId: 'e-2' } },
      { id: 'l-3', data: { status: 'overdue', employeeId: 'e-3' } },
      { id: 'l-4', data: { status: 'approved', employeeId: 'e-4' } },
      { id: 'l-5', data: { status: 'repaid', employeeId: 'e-5' } },
    ];
    render(<EmployeeRoster />);

    const tile = (await screen.findByText('Préstamos Activos')).closest('.ops-kpi') as HTMLElement;
    expect(tile.querySelector('b')?.textContent).toBe('3');
  });
});

describe('EmployeeRoster — invites read failure (E13)', () => {
  it('surfaces the error instead of silently showing everyone as un-invited', async () => {
    failCollection = 'invites';
    render(<EmployeeRoster />);

    expect(await screen.findByText('Error al cargar los datos. Intenta de nuevo.')).toBeTruthy();
  });
});
