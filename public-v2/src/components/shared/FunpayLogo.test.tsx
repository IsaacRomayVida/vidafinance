/**
 * Tiny smoke test for FunpayLogo — mainly proves the RTL + jsdom pipeline
 * works end-to-end. Also locks the `aria-label="Funpay"` contract so screen
 * readers keep announcing the brand consistently across the app.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FunpayLogo } from './FunpayLogo';

describe('FunpayLogo', () => {
  it('renders with accessible Funpay label (default variant)', () => {
    render(<FunpayLogo />);
    expect(screen.getByLabelText('Funpay')).toBeInTheDocument();
  });

  it('uses the footer class modifier when variant is footer', () => {
    const { container } = render(<FunpayLogo variant="footer" />);
    const el = container.querySelector('.funpay-logo');
    expect(el).not.toBeNull();
    expect(el?.classList.contains('ft')).toBe(true);
  });
});
