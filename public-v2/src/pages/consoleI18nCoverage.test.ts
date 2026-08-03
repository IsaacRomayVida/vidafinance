/**
 * Ops-console pages must not grow new hardcoded user-visible strings.
 *
 * Funpay Design ruled the console Spanish on 2026-08-03: every other Funpay
 * surface is Spanish-first, so an English admin console was the anomaly. The
 * console had drifted into being *mixed* — `DeductionReports.tsx` was fully
 * internationalized while ReviewQueue/ReviewDetail/PortfolioPage were hardcoded
 * English, and then I added two Spanish strings to that English page in #514.
 * Mixed is the one clearly-wrong option, and it happened one string at a time.
 *
 * This is the guard that makes "one string at a time" fail rather than accrete.
 * The remaining untranslated pages are listed explicitly in PENDING below, so
 * the outstanding work lives in code rather than in someone's memory. Delete a
 * file from that list as it is translated; when the list is empty, delete it.
 * A file that is neither translated nor listed fails, and so does a file listed
 * as pending that has actually been cleaned up — the list cannot silently
 * outlive its reason.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Console pages, all of which must eventually be fully translated. */
const CONSOLE_PAGES = [
  'src/pages/ReviewQueue.tsx',
  'src/pages/ReviewDetail.tsx',
  'src/pages/PortfolioPage.tsx',
];

/**
 * Not yet translated. Tracked here rather than in a ticket so that the next
 * person to touch one of these files sees the obligation in the test output.
 *
 * ReviewQueue was done first because it is the page Funpay Design is actively
 * producing frames against (the Estado pill column, unblocked by #513).
 */
const PENDING = new Set(['src/pages/ReviewDetail.tsx', 'src/pages/PortfolioPage.tsx']);

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');

/**
 * JSX text nodes that a human reads: `>Some words<`.
 *
 * Deliberately conservative — it will not catch every possible hardcoded
 * string (template literals inside handlers, for instance). It catches the
 * shape that actually accreted here, which is a literal typed straight into
 * markup, and it produces no false positives on the translated file.
 */
function hardcodedTextNodes(src: string): string[] {
  return (src.match(/>[A-Za-z][A-Za-z ,.'!?()/-]{2,60}</g) ?? []).map((m) => m.slice(1, -1).trim());
}

/** `aria-label="..."` / `placeholder="..."` with a literal, not a `t()` call. */
function hardcodedAttributes(src: string): string[] {
  return (src.match(/(?:aria-label|placeholder)="[A-Za-z][^"]*"/g) ?? []);
}

function findings(rel: string): string[] {
  const src = read(rel);
  return [...hardcodedTextNodes(src), ...hardcodedAttributes(src)];
}

describe('console i18n coverage', () => {
  it('the detectors actually fire (self-test)', () => {
    // Proves a passing assertion below means "clean", not "detector broken".
    expect(hardcodedTextNodes('<th style={x}>Loan ID</th>')).toEqual(['Loan ID']);
    expect(hardcodedTextNodes("<th>{t('rq_th_loan_id', 'ID')}</th>")).toEqual([]);
    expect(hardcodedAttributes('<select aria-label="Sort reviews" />')).toEqual([
      'aria-label="Sort reviews"',
    ]);
    expect(hardcodedAttributes("<select aria-label={t('rq_aria_sort', 'Ordenar')} />")).toEqual([]);
  });

  const translated = CONSOLE_PAGES.filter((p) => !PENDING.has(p));

  it.each(translated)('%s has no hardcoded user-visible strings', (rel) => {
    const found = findings(rel);
    expect(found, `${rel} has untranslated strings: ${found.join(' | ')}`).toEqual([]);
  });

  it.each([...PENDING])('%s is still pending — remove it from PENDING once translated', (rel) => {
    // Inverted on purpose. If someone translates the file but forgets to update
    // PENDING, this fails and points at the stale list, so the list cannot rot
    // into a permanent exemption.
    const found = findings(rel);
    expect(
      found.length,
      `${rel} appears fully translated — delete it from PENDING in this file`
    ).toBeGreaterThan(0);
  });

  it('every pending file is a real console page', () => {
    for (const rel of PENDING) expect(CONSOLE_PAGES).toContain(rel);
  });
});
