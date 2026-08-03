/**
 * The four terminal / exception loan states must not be narrated by a card
 * written for a different state.
 *
 * Before this, `resolveGroup` ended in `default: return 'pending_review'`, so
 * `written_off`, `cancelled`, `in_collections` and `disbursement_failed` all
 * rendered the pending card: "Solicitud en revisión", plus a timeline drawn at
 * step 1. A borrower whose debt had been charged off was told their
 * application was under review. That is a false statement to a borrower about
 * their own credit, which is worse than the unstyled badge that led us here.
 *
 * They now resolve to 'other', which states the status and asserts nothing
 * else, pending real card copy from Funpay Design for each. This test pins the
 * negative: whatever those cards become, they must not claim a decision is
 * pending, that funds are on their way, or that the loan was rejected.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import '../i18n';
import { LoanStatusCard } from './LoanStatusCard';

const SECONDS = { seconds: 1_788_000_000 };

const loan = (status: string) => ({
  id: 'loan-1',
  amount: 1000,
  total: 1300,
  termDays: 30,
  createdAt: SECONDS,
  dueDate: SECONDS,
  status,
});

/** Claims that are false for every status in the table below. */
const FALSE_CLAIMS = [
  'Solicitud en revisión',  // pending card
  'Solicitud rechazada',    // denied card
  'llegarán a tu cuenta',   // disbursing card ("los fondos llegarán en minutos")
  'Contrato listo',         // approved card
];

describe('LoanStatusCard — terminal and exception states', () => {
  it.each([
    ['written_off', 'Castigado'],
    ['in_collections', 'En cobranza'],
    ['cancelled', 'Cancelado'],
    ['disbursement_failed', 'Reintentando desembolso'],
  ])('%s shows "%s" and narrates nothing else', (status, copy) => {
    const text = render(<LoanStatusCard loan={loan(status)} />).container.textContent ?? '';

    expect(text).toContain(copy);
    // An unkeyed status renders as its own key — the original defect.
    expect(text).not.toContain('status_');
    for (const claim of FALSE_CLAIMS) {
      expect(text, `${status} must not claim "${claim}"`).not.toContain(claim);
    }
  });

  it('rejected_ml is indistinguishable from rejected', () => {
    // Funpay Design's ruling: the ML-vs-human distinction is an internal audit
    // fact. Two different rejection cards would read as two ways to be
    // rejected, which raises questions rather than answering them.
    const human = render(<LoanStatusCard loan={loan('rejected')} />).container.textContent;
    const ml = render(<LoanStatusCard loan={loan('rejected_ml')} />).container.textContent;

    expect(ml).toBe(human);
  });
});
