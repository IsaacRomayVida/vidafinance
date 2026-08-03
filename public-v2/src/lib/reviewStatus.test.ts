/**
 * The console's review-status rules must not be narrower than the server's.
 *
 * The defect these pin: ReviewQueue listed only `pending`/`pending_review` and
 * ReviewDetail gated its buttons on the same pair, while
 * `submitReviewDecision` accepts `info_requested` from anyone and `escalated`
 * from admin/super_admin. A review moved to either status left the only list
 * that queries `review_queue` and lost its action buttons, so it could not be
 * resolved. Its loan stayed `under_review`, which is in `ACTIVE_LOAN_STATUSES`
 * — the borrower's single slot — so one triage click locked that employee out
 * of the product. That is the harm #407 was filed for; the backend was fixed
 * and the console was not.
 *
 * These are contract tests, so they are written as the server's rules restated
 * independently rather than as a re-import of the module under test.
 */
import { describe, expect, it } from 'vitest';

import {
  OPEN_REVIEW_STATUSES,
  availableDecisions,
  blockedReason,
  canDecideReview,
  isOpenReview,
} from './reviewStatus';

const REVIEWER_ROLES = ['ops', 'admin', 'super_admin'];
const SENIOR_ROLES = ['admin', 'super_admin'];

describe('open statuses', () => {
  it('covers all four the backend calls open', () => {
    // functions/src/admin/getReviewQueue.ts OPEN_STATUSES
    expect([...OPEN_REVIEW_STATUSES].sort()).toEqual(
      ['escalated', 'info_requested', 'pending', 'pending_review'].sort()
    );
  });

  it.each(['pending', 'pending_review', 'info_requested', 'escalated'])(
    '%s is outstanding work',
    (status) => expect(isOpenReview(status)).toBe(true)
  );

  it.each(['approved', 'rejected'])('%s is not', (status) =>
    expect(isOpenReview(status)).toBe(false)
  );
});

describe('who can decide what', () => {
  it.each(REVIEWER_ROLES)('%s can decide a plain pending review', (role) => {
    expect(canDecideReview('pending', role)).toBe(true);
    expect(canDecideReview('pending_review', role)).toBe(true);
  });

  it.each(REVIEWER_ROLES)('%s can still decide info_requested', (role) => {
    // The regression: ops asked the employee for a document, so the answer has
    // to be able to land. Treating this as terminal is the #407 lockout.
    expect(canDecideReview('info_requested', role)).toBe(true);
  });

  it.each(SENIOR_ROLES)('%s can resolve an escalated review', (role) => {
    expect(canDecideReview('escalated', role)).toBe(true);
  });

  it('ops cannot resolve an escalated review', () => {
    // Not a dead end — someone else's to resolve. That is what makes
    // escalation mean something without a separate supervisor queue.
    expect(canDecideReview('escalated', 'ops')).toBe(false);
    expect(blockedReason('escalated', 'ops')).toMatch(/administrador/i);
  });

  it('an absent role is refused rather than assumed', () => {
    // The server rejects it anyway; offering a button that will fail is worse
    // than not offering it.
    expect(canDecideReview('escalated', null)).toBe(false);
    expect(canDecideReview('escalated', undefined)).toBe(false);
  });

  it.each(['approved', 'rejected'])('nobody re-decides a resolved %s review', (status) => {
    for (const role of REVIEWER_ROLES) {
      expect(canDecideReview(status, role)).toBe(false);
    }
  });
});

describe('offered decisions', () => {
  it('offers all four on an un-triaged review', () => {
    expect(availableDecisions('pending', 'ops').sort()).toEqual(
      ['approved', 'escalate', 'rejected', 'request_info'].sort()
    );
  });

  it('does not offer escalate on an already-escalated review', () => {
    // The server answers that with failed-precondition ("Review is already
    // escalated"), so the button could only produce an error toast.
    const offered = availableDecisions('escalated', 'admin');
    expect(offered).not.toContain('escalate');
    expect(offered.sort()).toEqual(['approved', 'rejected', 'request_info'].sort());
  });

  it('offers nothing to someone who cannot act', () => {
    expect(availableDecisions('escalated', 'ops')).toEqual([]);
    expect(availableDecisions('approved', 'admin')).toEqual([]);
  });
});

describe('every open status is reachable by someone', () => {
  // The invariant that actually protects the borrower: if a status can be
  // listed as outstanding work, at least one role must be able to clear it.
  // A status that is open but undecidable by everyone is a stranded loan.
  it.each(OPEN_REVIEW_STATUSES)('%s can be resolved by at least one role', (status) => {
    const canAct = REVIEWER_ROLES.filter((r) => canDecideReview(status, r));
    expect(canAct.length, `${status} is open but nobody can resolve it`).toBeGreaterThan(0);
  });
});
