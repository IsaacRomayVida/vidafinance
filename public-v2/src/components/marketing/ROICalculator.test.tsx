/**
 * The homepage credit calculator quotes a credit line and a repayment to a
 * visitor who has no account yet — a pre-contractual disclosure, not decoration.
 *
 * It used to ask for a monthly salary and then never use it: `salary` was held
 * in state, rendered back into its own input, and never entered `total` or the
 * slider's range. The slider ran 500–5,000 for everybody. The line the backend
 * actually grants is `min(salary * 0.3, 5000)` (functions/src/index.ts:74-75,
 * 3161), re-checked on every loan by requestLoan, so anyone earning under
 * 16,667 MXN/month — most of a Mexican payroll-lending book — was shown a
 * larger line than they can draw, and an "estimated repayment" to match.
 *
 * These tests drive the rendered component rather than the helper so the wiring
 * is what is asserted, not just the arithmetic.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import '../../i18n';
import { ROICalculator } from './ROICalculator';

function renderCalc() {
  return render(
    <MemoryRouter>
      <ROICalculator />
    </MemoryRouter>,
  );
}

function salaryInput(): HTMLInputElement {
  return screen.getByLabelText(/salario mensual|monthly salary/i) as HTMLInputElement;
}

function creditSlider(): HTMLInputElement {
  return screen.getByLabelText(/crédito deseado|desired credit/i) as HTMLInputElement;
}

describe('ROICalculator — the slider respects the salary it asks for', () => {
  it('caps the offered credit at 30% of salary, not at the $5,000 ceiling', () => {
    renderCalc();
    fireEvent.change(salaryInput(), { target: { value: '10000' } });

    // 10,000 * 0.3 = 3,000. Before the fix this read "5000".
    expect(creditSlider().max).toBe('3000');
  });

  it('caps at $5,000 only once salary actually supports it', () => {
    renderCalc();
    fireEvent.change(salaryInput(), { target: { value: '40000' } });

    expect(creditSlider().max).toBe('5000');
  });

  it('pulls an already-selected amount back down when salary drops', () => {
    renderCalc();
    fireEvent.change(salaryInput(), { target: { value: '40000' } });
    fireEvent.change(creditSlider(), { target: { value: '5000' } });
    expect(creditSlider().value).toBe('5000');

    fireEvent.change(salaryInput(), { target: { value: '10000' } });
    expect(creditSlider().value).toBe('3000');
  });

  it('quotes a repayment on the capped amount, never on the uncapped one', () => {
    renderCalc();
    fireEvent.change(salaryInput(), { target: { value: '40000' } });
    fireEvent.change(creditSlider(), { target: { value: '5000' } });
    // 5,000 * 1.30 = 6,500 — the honest quote at this salary.
    expect(screen.getByText('6,500')).toBeInTheDocument();

    fireEvent.change(salaryInput(), { target: { value: '10000' } });
    // 3,000 * 1.30 = 3,900. The 6,500 figure must be gone, not merely
    // accompanied by a smaller one.
    expect(screen.getByText('3,900')).toBeInTheDocument();
    expect(screen.queryByText('6,500')).not.toBeInTheDocument();
  });

  it('says so instead of quoting when the salary cannot reach the $500 minimum', () => {
    renderCalc();
    fireEvent.change(salaryInput(), { target: { value: '1000' } });

    // 1,000 * 0.3 = 300, below the minimum loan.
    expect(creditSlider()).toBeDisabled();
    expect(
      screen.getByText(/no alcanza el mínimo|does not yet reach/i),
    ).toBeInTheDocument();
  });

  it('does not quote a line off an empty salary field', () => {
    renderCalc();
    fireEvent.change(salaryInput(), { target: { value: '' } });

    expect(creditSlider()).toBeDisabled();
  });
});
