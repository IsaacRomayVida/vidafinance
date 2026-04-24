/**
 * Smoke test for the a11y label wiring in ContactForm (VID3-715 PR B).
 *
 * We don't care about submission here — only that every visible field
 * has an accessible name retrievable via `getByLabelText`, which is how
 * screen readers announce the control. A green assertion here means
 * the `<label htmlFor>` ↔ `<input id>` association is intact.
 *
 * Firebase/Firestore is mocked out because this page imports `db` at
 * module scope; we never submit the form in this test so the mock is
 * a safe no-op.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/firebase', () => ({
  db: {},
}));

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(),
  addDoc: vi.fn(),
  serverTimestamp: vi.fn(),
}));

import '../../i18n';
import { ContactForm } from './ContactForm';

describe('ContactForm — a11y labels', () => {
  it('exposes every field through getByLabelText (label htmlFor / input id association)', () => {
    render(<ContactForm />);

    expect(screen.getByLabelText(/nombre|name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/correo|email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/tipo|type/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/mensaje|message/i)).toBeInTheDocument();
  });

  it('inputs have ids that match their labels (htmlFor pattern)', () => {
    render(<ContactForm />);

    const name = screen.getByLabelText(/nombre|name/i) as HTMLInputElement;
    const email = screen.getByLabelText(/correo|email/i) as HTMLInputElement;
    const type = screen.getByLabelText(/tipo|type/i) as HTMLSelectElement;
    const message = screen.getByLabelText(/mensaje|message/i) as HTMLTextAreaElement;

    expect(name.id).toBe('cf-name');
    expect(email.id).toBe('cf-email');
    expect(type.id).toBe('cf-type');
    expect(message.id).toBe('cf-msg');
  });
});
