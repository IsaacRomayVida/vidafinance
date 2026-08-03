/**
 * #446 — one priced surface.
 *
 * `LoanModal` was a second live loan-request screen. It priced loans in the
 * browser: a hardcoded 30% fee, a due date derived as `Date.now() + 30 days`,
 * and a CAT it computed itself — all three the exact defects #420, #424, #439
 * and #441 closed in the wizard, still live on the dashboard, printed beside
 * the checkbox a borrower ticks to accept the terms.
 *
 * Funpay Design's ruling was to retire it rather than repair it: every defect
 * that thread closed had the same shape — two live copies of one regulated fact
 * with nothing forcing them to agree — and a second pricing surface does not
 * avoid the next recurrence, it schedules one.
 *
 * These assertions are on SOURCE rather than on a rendered screen, deliberately.
 * The property is "nowhere in this app derives a price", which is a statement
 * about every file, not about one render. A render test cannot express it, and
 * the defect this pins was invisible for four consecutive fixes precisely
 * because nobody looked outside the file they were fixing.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) return [];
    return [full];
  });
}

/** Every non-test source file, as [repo-relative path, contents]. */
const sources = sourceFiles(SRC).map(
  (file) => [relative(SRC, file), readFileSync(file, 'utf8')] as const
);

const offenders = (pattern: RegExp) =>
  sources.filter(([, body]) => pattern.test(body)).map(([path]) => path);

describe('#446 — nothing outside the server prices a loan', () => {
  it('derives no CAT in the browser', () => {
    // LoanModal:66 — ((1 + fee/amount) ** (365/30) - 1) * 100. The CAT is a
    // regulated disclosure; the client has no business computing one, which is
    // why getLoanConfig publishes it (#424).
    expect(offenders(/Math\.pow\([^)]*365|365\s*\/\s*30/)).toEqual([]);
  });

  it('hardcodes no fee rate', () => {
    // LoanModal:63 — `Math.round(amount * 0.3)`. The rate is admin-editable
    // behind two-person approval (#389) and is persisted per loan; a copy in a
    // component silently ignores both.
    expect(offenders(/amount\s*\*\s*0\.\d/)).toEqual([]);
  });

  it('derives no due date from the clock', () => {
    // LoanModal:65 and LoanWizard:303 (fixed in #441) — `Date.now() + 30 days`.
    // The deduction lands on a payday, not 30 days from whenever the borrower
    // happened to open the screen.
    expect(offenders(/Date\.now\(\)\s*\+\s*\w+\s*\*\s*24\s*\*\s*60/)).toEqual([]);
  });

  it('states no fee rate in the copy the request path renders', () => {
    // `modal_rate` was "30% comisión" / "30% fee" — the rate written into a
    // locale string, where no review looking at pricing code would find it.
    //
    // Scoped to the keys the modal owned, NOT to every string with a percent in
    // it: `calc_rate` and `lp_m_widget_rate_val` also say "30% mensual" on the
    // marketing pages and are still live. Those are an advertised-rate question
    // rather than a quote defect — a borrower does not accept terms there — and
    // deleting marketing copy under a correctness banner would be the same
    // unilateral move this thread keeps catching. Raised separately.
    for (const lang of ['es', 'en']) {
      const strings = JSON.parse(readFileSync(join(SRC, 'i18n', `${lang}.json`), 'utf8'));
      expect(Object.keys(strings)).not.toContain('modal_rate');
      expect(Object.keys(strings)).not.toContain('modal_term_30');
    }
  });

  it('leaves exactly one component that submits a loan request', () => {
    const requesters = offenders(/'requestLoan'/);
    expect(requesters).toEqual(['pages/LoanWizard.tsx']);
  });
});
