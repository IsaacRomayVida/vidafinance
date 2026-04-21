/**
 * Tiny smoke test for VidaLogo — mainly proves the RTL + jsdom pipeline
 * works end-to-end. Also locks the `aria-label="VIDA"` contract so screen
 * readers keep announcing the brand consistently across the app.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VidaLogo } from './VidaLogo';

describe('VidaLogo', () => {
  it('renders with accessible VIDA label (default variant)', () => {
    render(<VidaLogo />);
    expect(screen.getByLabelText('VIDA')).toBeInTheDocument();
  });

  it('uses the footer class modifier when variant is footer', () => {
    const { container } = render(<VidaLogo variant="footer" />);
    const el = container.querySelector('.vida-logo');
    expect(el).not.toBeNull();
    expect(el?.classList.contains('ft')).toBe(true);
  });
});
