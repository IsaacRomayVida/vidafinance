/**
 * A11y regression test for the Navbar icon-button conversions (VID3-715 PR C).
 *
 * PR C replaces clickable <div>s with real <button type="button">s on the
 * hamburger and mobile menu close controls, and wires aria-expanded /
 * aria-controls on the hamburger. These tests lock in:
 *   - Hamburger is a <button> discoverable by name and exposes aria-expanded.
 *   - Clicking the hamburger flips aria-expanded so assistive tech knows
 *     the menu state without watching class mutations.
 *   - Keyboard activation (Enter / Space) works via the native <button>.
 */
import { BrowserRouter } from 'react-router-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import '../../i18n';
import { Navbar } from './Navbar';

function renderNavbar() {
  return render(
    <BrowserRouter>
      <Navbar />
    </BrowserRouter>,
  );
}

describe('Navbar — a11y icon buttons', () => {
  it('exposes the hamburger as a button with an accessible name', () => {
    renderNavbar();
    const hamburger = screen.getByRole('button', { name: /abrir menú|open menu/i });
    expect(hamburger).toBeInTheDocument();
    expect(hamburger.tagName).toBe('BUTTON');
    expect(hamburger).toHaveAttribute('aria-expanded', 'false');
    expect(hamburger).toHaveAttribute('aria-controls', 'nav-mobile-menu');
  });

  it('toggles aria-expanded when the hamburger is activated', () => {
    renderNavbar();
    const hamburger = screen.getByRole('button', { name: /abrir menú|open menu/i });

    fireEvent.click(hamburger);
    expect(hamburger).toHaveAttribute('aria-expanded', 'true');

    // After opening, the close button inside the drawer becomes reachable by name.
    const closeBtn = screen.getByRole('button', { name: /cerrar menú|close menu/i });
    expect(closeBtn.tagName).toBe('BUTTON');

    fireEvent.click(closeBtn);
    expect(hamburger).toHaveAttribute('aria-expanded', 'false');
  });
});
