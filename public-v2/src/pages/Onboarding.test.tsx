/**
 * Onboarding — invite-based employee signup.
 *
 * lookupInvite returns `employeeEmail` deliberately MASKED (e.g.
 * "j***@example.com" — see maskEmail in functions/src/invites/lookupInvite.ts,
 * an unauthenticated endpoint that must never leak a real email). The invite
 * handler here used to prefill the signup form's email field with that masked
 * string, and that field is exactly what createUserWithEmailAndPassword uses
 * to create the Firebase Auth account — an invited employee who didn't notice
 * and retype their email would end up with a garbled, unusable login email.
 *
 * The name prefill is legitimate and must survive; only the email prefill is
 * the defect. Reaching the field that holds it means driving the employee flow
 * to step 2, since an invite link does not skip the employer-code step.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase', () => ({ db: {}, auth: {}, storage: {} }));

vi.mock('../lib/safeStorage', () => ({
  safeGetItem: vi.fn(() => null),
  safeSetItem: vi.fn(() => true),
  safeRemoveItem: vi.fn(() => true),
}));

vi.mock('firebase/firestore', () => ({
  doc: vi.fn(() => ({})),
  setDoc: vi.fn().mockResolvedValue(undefined),
  serverTimestamp: vi.fn(() => ({})),
}));

vi.mock('firebase/auth', () => ({
  createUserWithEmailAndPassword: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
}));

vi.mock('firebase/storage', () => ({
  getStorage: vi.fn(),
  ref: vi.fn(),
  uploadBytes: vi.fn(),
  getDownloadURL: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams('?invite=faketoken123456789012345678901234')],
}));

const MASKED_EMAIL = 'j***@example.com';

// Dispatch by callable name — the flow calls lookupInvite on mount and
// lookupEmployerByCode from the step-1 field, and they return different shapes.
vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn((_fns: unknown, name: string) => async () => {
    if (name === 'lookupInvite') {
      return {
        data: {
          valid: true,
          inviteId: 'invite-1',
          employerName: 'Acme Corp',
          employeeName: 'Juan Pérez',
          employeeEmail: MASKED_EMAIL,
        },
      };
    }
    if (name === 'lookupEmployerByCode') {
      return { data: { found: true, employerId: 'emp-1', companyName: 'Acme Corp' } };
    }
    return { data: {} };
  }),
}));

import '../i18n';
import { Onboarding } from './Onboarding';

describe('Onboarding — invite lookup must not fill the signup email with a masked value', () => {
  it('prefills the name but leaves the email field for the user to fill in themselves', async () => {
    render(<Onboarding />);

    fireEvent.click(await screen.findByText('Soy Empleado'));

    // Step 1 — employer code. The 500ms debounce before lookupEmployerByCode
    // fires is why this waits well past the default timeout.
    const codeInput = document.querySelector('#onb-m-code') as HTMLInputElement;
    fireEvent.change(codeInput, { target: { value: 'ACME1234' } });

    // Match the bottom action button by label, not by `.onb-btn` position —
    // later steps' buttons are in the DOM too (hidden by CSS), and the first
    // `.onb-btn` is the success step's "Acceder a Mi Crédito", which navigates
    // away instead of advancing.
    const nextBtn = await waitFor(
      () => {
        const btn = screen.getByRole('button', { name: 'Continuar' }) as HTMLButtonElement;
        if (btn.disabled) throw new Error('continue still disabled — code lookup has not resolved');
        return btn;
      },
      { timeout: 3000 },
    );
    fireEvent.click(nextBtn);

    // Step 2 — the fields the invite lookup prefills.
    const nameInput = await waitFor(() => {
      const el = document.querySelector('#onb-m-name') as HTMLInputElement | null;
      if (!el) throw new Error('step 2 not reached');
      return el;
    });

    expect(nameInput.value).toBe('Juan Pérez');

    const emailInput = document.querySelector('#onb-m-email') as HTMLInputElement;
    expect(emailInput.value).not.toBe(MASKED_EMAIL);
    expect(emailInput.value).toBe('');
  });
});
