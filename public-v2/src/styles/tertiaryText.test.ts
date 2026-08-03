/**
 * #443 — where `--t3` is still allowed to appear on a borrower surface.
 *
 * `--t3` (#93aaa9) is 2.45:1 on `--bg` and 2.29:1 on `--bg2`: under AA's 4.5:1
 * for body text and under even the 3:1 floor for non-text UI. The seven screens
 * below are the ones a borrower reaches in the same session as the loan wizard,
 * which is the argument #422 established — a surface is not safe because it is
 * a different file.
 *
 * This is a SOURCE-level guard, deliberately, and it is weaker than a rendered
 * one. LoanStatusCard has a real render assertion in LoanStatusCard.test.tsx
 * (11 of the 28 sites); the other four components need Firebase mocks that do
 * not exist yet, and a source check that actually runs today is worth more than
 * a render test that is still a TODO. If those components gain test setups, the
 * assertions should move.
 *
 * The allowlist is the point. Each remaining use is here because Funpay Design
 * ruled it deliberate, and the count is pinned so that a new one cannot arrive
 * quietly — a bare "no --t3 here" rule would have to be relaxed wholesale the
 * first time someone needed one of these.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Uses of `--t3` that survive on purpose, with the reason each one survives.
 * Anything not described here is a defect.
 */
const DELIBERATE: Record<string, { count: number; why: string }> = {
  'components/LoanStatusCard.tsx': {
    count: 1,
    why: 'Future timeline steps: the low contrast IS the message ("not yet").',
  },
  'components/employee/CreditWidget.tsx': {
    count: 1,
    why: 'Disabled CTA text. WCAG 1.4.3 exempts disabled controls from the minimum.',
  },
  'components/employee/PaymentModal.tsx': {
    count: 1,
    why: 'Payment-method metadata, secondary to the amount and date beside it.',
  },
  'pages/MyLoans.tsx': {
    count: 3,
    why:
      'Expand chevron (a glyph, not text — 3:1 applies, still failing, deferred to the ' +
      'token audit) plus payment-method and timestamp metadata.',
  },
  'components/employee/LoanTable.tsx': {
    count: 1,
    why: 'Empty-state help paragraph, no value beside it to invert.',
  },
  'pages/EmployeePage.tsx': {
    count: 1,
    why: 'Help paragraph under the code field, no value beside it to invert.',
  },
};

describe('#443 — --t3 on borrower-reachable surfaces', () => {
  for (const [file, { count, why }] of Object.entries(DELIBERATE)) {
    it(`${file} keeps only its documented uses — ${why}`, () => {
      const source = readFileSync(resolve(SRC, file), 'utf8');
      const found = source.match(/var\(--t3\)/g) ?? [];
      expect(found).toHaveLength(count);
    });
  }

  it('leaves no --t3 in the loan wizard at all', () => {
    // The wizard was moved wholesale: all 21 uses were `color:`, none was a
    // border, an icon or a divider, so there was no non-text use to protect.
    const source = readFileSync(resolve(SRC, 'pages/LoanWizard.tsx'), 'utf8');
    expect(source.match(/var\(--t3\)/g) ?? []).toHaveLength(0);
  });
});
