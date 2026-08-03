/**
 * EmployerMgmt — the Approve/Reject buttons called `approveEmployer` with
 * `{ employerId, approved }`. The deployed callable (functions/src/index.ts)
 * destructures `employerUid`, not `employerId`, so `employerUid` was always
 * undefined and every click threw "employerUid is required" — both buttons
 * were completely broken. See CALLABLE_CONTRACT_AUDIT.md P0-1.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../lib/firebase', () => ({ db: {}, auth: {}, storage: {} }));

vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { uid: 'admin-1' } }) }));

type SnapCb = (snap: { docs: unknown[] }) => void;
let snapshotDocs: Array<{ id: string; data: () => Record<string, unknown> }>;

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => ({})),
  query: vi.fn((ref: unknown) => ref),
  orderBy: vi.fn(),
  onSnapshot: vi.fn((_q: unknown, ok: SnapCb) => {
    ok({ docs: snapshotDocs.map((d) => ({ id: d.id, data: d.data })) });
    return () => {};
  }),
}));

let lastCallArgs: unknown;
const callableFn = vi.fn(async (args: unknown) => {
  lastCallArgs = args;
  return { data: { success: true } };
});

vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn(() => callableFn),
}));

import '../i18n';
import { EmployerMgmt } from './EmployerMgmt';

beforeEach(() => {
  lastCallArgs = undefined;
  callableFn.mockClear();
  snapshotDocs = [
    {
      id: 'employer-1',
      data: () => ({
        companyName: 'Acme Corp',
        email: 'acme@example.com',
        status: 'pending_verification',
      }),
    },
  ];
});

describe('EmployerMgmt — approveEmployer payload', () => {
  it('sends employerUid (not employerId) when approving', async () => {
    render(<EmployerMgmt />);

    const approveBtn = await screen.findByText('Approve');
    fireEvent.click(approveBtn);

    await waitFor(() => expect(callableFn).toHaveBeenCalledTimes(1));
    expect(lastCallArgs).toMatchObject({ employerUid: 'employer-1', approved: true });
    expect(lastCallArgs).not.toHaveProperty('employerId');
  });

  it('sends employerUid (not employerId) when rejecting', async () => {
    render(<EmployerMgmt />);

    const rejectBtn = await screen.findByText('Reject');
    fireEvent.click(rejectBtn);

    await waitFor(() => expect(callableFn).toHaveBeenCalledTimes(1));
    expect(lastCallArgs).toMatchObject({ employerUid: 'employer-1', approved: false });
    expect(lastCallArgs).not.toHaveProperty('employerId');
  });
});
