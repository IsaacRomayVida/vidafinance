/**
 * Every loan status the backend can write must have a `status_<x>` string in
 * BOTH languages, and a badge colour to render it in.
 *
 * i18next is configured with no `parseMissingKeyHandler` (see ./index.ts), so a
 * missing key renders as the key itself: a borrower whose loan went to
 * collections saw the literal text `status_in_collections` in their dashboard.
 * Five statuses had shipped through the backend status machine without ever
 * getting a string — the copy was added, but nothing stops the sixth.
 *
 * The list below is the union of the loan statuses written by
 * `functions/src/loans/updateLoanStatus.ts` (the ops/admin enum plus the
 * ALLOWED_TRANSITIONS targets), `functions/src/loans/loanStatusTransitions.ts`,
 * and the direct `status:` writes in `functions/src/loans/onLoanApproved.ts` /
 * `functions/src/index.ts`. It is duplicated rather than imported because
 * public-v2 does not build against the functions package; if that list and this
 * one drift, that is the drift this test exists to surface — re-derive with:
 *
 *   grep -rhoE "status: '[a-z_]+'" functions/src --include=*.ts | sort -u
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import en from './en.json';
import es from './es.json';

/** Statuses that reach a `status_${loan.status}` render site. */
const LOAN_STATUSES = [
  'pending',
  'under_review',
  'escalated',
  'approved',
  'rejected',
  'disbursement_queued',
  'disbursement_failed',
  'disbursed',
  'active',
  'overdue',
  'paid',
  'repaid',
  'in_collections',
  'written_off',
  'cancelled',
] as const;

/**
 * Keyed and handled by `resolveGroup`, but NOT reachable on a loan badge:
 *
 *  - `rejected_ml` is written to the `employers` collection by the ML
 *    auto-rejection path (functions/src/index.ts), never to a loan.
 *  - `completed` belongs to `disbursement_queue` and `payroll_runs`; a
 *    successfully disbursed loan goes to `active`, not `completed`
 *    (functions/src/loans/onLoanApproved.ts writes both, to different docs).
 *
 * They keep their strings — the badge markup is shared and both are already
 * branched on in LoanStatusCard — but they are held apart here so the badge
 * assertion below does not demand a colour for a pill that never renders, and
 * so nobody reads either one as part of the loan state machine.
 */
const NON_LOAN_STATUSES = ['rejected_ml', 'completed'] as const;

const KEYED = [...LOAN_STATUSES, ...NON_LOAN_STATUSES];

const dict = (d: Record<string, string>) => d;

describe('status_* i18n coverage', () => {
  it.each(KEYED)('es has a non-empty string for %s', (status) => {
    const value = dict(es)[`status_${status}`];
    expect(value, `missing "status_${status}" in es.json`).toBeTruthy();
    // A key echoed back as its own value is the same defect wearing a disguise.
    expect(value).not.toBe(`status_${status}`);
  });

  it.each(KEYED)('en has a non-empty string for %s', (status) => {
    const value = dict(en)[`status_${status}`];
    expect(value, `missing "status_${status}" in en.json`).toBeTruthy();
    expect(value).not.toBe(`status_${status}`);
  });

  it('es and en define exactly the same status_ keys', () => {
    const keys = (d: Record<string, string>) =>
      Object.keys(d).filter((k) => k.startsWith('status_')).sort();
    expect(keys(es)).toEqual(keys(en));
  });
});

/**
 * The string is only half of it: every render site pairs `status_${status}`
 * with `className={`badge badge-${status}`}`, so a status with copy but no
 * colour rule renders as unstyled text where a pill is expected.
 * `disbursement_failed` and `rejected_ml` had exactly that gap.
 */
describe('badge colour coverage', () => {
  // Read off disk rather than imported: vite.config.ts sets `css: false` for
  // the test run, so a `import '...legacy.css'` (even `?raw`) resolves to an
  // empty stub and every assertion below would fail for the wrong reason.
  // vitest's cwd is the public-v2 root.
  const css = readFileSync(resolve(process.cwd(), 'src/styles/legacy.css'), 'utf8');

  it('found the stylesheet', () => {
    expect(css.length).toBeGreaterThan(0);
  });

  it.each(LOAN_STATUSES)('legacy.css defines .badge-%s', (status) => {
    // Matches the class in a selector list, e.g. `.badge-rejected,.badge-rejected_ml{`
    const selector = new RegExp(`\\.badge-${status}\\s*[,{]`);
    expect(selector.test(css), `no .badge-${status} rule in legacy.css`).toBe(true);
  });
});
