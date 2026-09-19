/**
 * Onboarding — ?role= URL param.
 *
 * Landing on /onboarding?role=employer (or ?role=employee) used to be
 * resolved by a mount-only effect: `role` and `step` started at their
 * role-picker defaults (null, 0) and were overwritten a render later. That
 * effect was flagged by react-hooks/set-state-in-effect and replaced with
 * lazy useState initializers that read the URL once, at first render — see
 * roleFromParams() in Onboarding.tsx. This covers the behavior the effect
 * used to own: the role-picker screen must never be the first thing a
 * ?role=... visitor sees, and a visitor with no ?role= param must still get
 * the picker.
 */
import { render } from '@testing-library/react';
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

vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn(() => async () => ({ data: {} })),
}));

// A shared, mutable search-params holder so each test can pick its own URL
// before rendering, without re-mocking the module per test.
const searchParamsState = vi.hoisted(() => ({ value: new URLSearchParams('') }));

vi.mock('react-router-dom', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
  useSearchParams: () => [searchParamsState.value],
}));

import '../i18n';
import { Onboarding } from './Onboarding';

// The role-picker stage stays mounted at all times (it's slid off with a CSS
// class for the transition animation, not unmounted), so "was the picker
// shown first" is "was its stage ever the active one", not "did it exist".
function rolePickerIsActive(): boolean {
  const stage = document.querySelector('.onb-roles')?.closest('.onb-stage');
  return !!stage?.classList.contains('active');
}

describe('Onboarding — ?role= is resolved before the first paint', () => {
  it('?role=employer renders the employer step 1 immediately, not the role picker', () => {
    searchParamsState.value = new URLSearchParams('?role=employer');
    render(<Onboarding />);

    // Employer step 1 (company name field) is on screen right away...
    expect(document.querySelector('#onb-e-company')).toBeTruthy();
    // ...and the role-picker stage was never the active one.
    expect(rolePickerIsActive()).toBe(false);
  });

  it('?role=employee renders the employee step 1 immediately, not the role picker', () => {
    searchParamsState.value = new URLSearchParams('?role=employee');
    render(<Onboarding />);

    expect(document.querySelector('#onb-m-code')).toBeTruthy();
    expect(rolePickerIsActive()).toBe(false);
  });

  it('with no ?role= param, the role picker is shown', () => {
    searchParamsState.value = new URLSearchParams('');
    render(<Onboarding />);

    expect(rolePickerIsActive()).toBe(true);
    expect(document.querySelector('#onb-e-company')).toBeNull();
    expect(document.querySelector('#onb-m-code')).toBeNull();
  });
});
