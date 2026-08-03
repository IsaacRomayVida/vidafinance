/**
 * LoanStatusCard — no sub-AA text on a surface the borrower reaches in the
 * same session as the wizard (#443).
 *
 * `--t3` (#93aaa9) is 2.45:1 on `--bg`. The wizard was moved off it; this card
 * is where the same borrower lands afterwards, and it carried the identical
 * pattern — a `--t3` label at 10-13px directly above a `--t1` or serif value.
 * A value rendered legibly beside a label that is not inverts the hierarchy of
 * the row, which is the defect one level down (Funpay Design's ruling).
 *
 * Asserted across the whole rendered card rather than per element: a node list
 * has to be re-derived every time someone adds a row, which is exactly how the
 * labels escaped the first pass.
 *
 * One `--t3` use survives on purpose and is pinned below: the dimmed FUTURE
 * timeline steps, where low contrast is the meaning ("this has not happened
 * yet") rather than an oversight.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import '../i18n';
import { LoanStatusCard } from './LoanStatusCard';

const SECONDS = { seconds: 1_788_000_000 };

const loan = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 'loan-1',
  amount: 1000,
  total: 1300,
  termDays: 30,
  createdAt: SECONDS,
  dueDate: SECONDS,
  status,
  ...extra,
});

/** Every element whose inline style names the token, root included. */
const tertiaryNodes = (root: HTMLElement) =>
  [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))].filter((el) =>
    (el.getAttribute('style') ?? '').includes('--t3')
  );

describe('LoanStatusCard — labels are legible beside their values', () => {
  // Every status that reaches a labelled figure: the money rows, the balance
  // block, the SPEI reference and the denial reason all live behind different
  // branches of this component.
  for (const status of [
    'active',
    'disbursed',
    'disbursement_queued',
    'approved',
    'rejected',
    'paid',
    'pending',
  ]) {
    it(`renders no sub-AA text for status "${status}"`, () => {
      const { container } = render(
        <LoanStatusCard
          loan={loan(status, {
            speiTrackingId: 'SPEI-123456',
            denialReason: 'Historial insuficiente',
            deniedAt: SECONDS,
            disbursedAt: SECONDS,
          })}
          totalPaid={400}
        />
      );

      const offenders = tertiaryNodes(container)
        // The dimmed future timeline steps are deliberate: the low contrast IS
        // the message. Excluded by what they are, not by node position.
        .filter((el) => !(el.getAttribute('style') ?? '').includes('padding-bottom'));

      expect(offenders.map((el) => (el.textContent ?? '').slice(0, 40))).toEqual([]);
    });
  }

  it('still renders the labels it stopped dimming', () => {
    // Guards against the cheap way to pass the assertion above: deleting the
    // labels instead of recolouring them.
    render(<LoanStatusCard loan={loan('active')} totalPaid={400} />);
    expect(screen.getAllByText(/total pagado|total paid/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/total adeudado|total owed/i).length).toBeGreaterThan(0);
  });
});
