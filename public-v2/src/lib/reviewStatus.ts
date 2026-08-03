/**
 * The review-queue status vocabulary, mirrored from the backend.
 *
 * These predicates exist because the console had drifted from the Cloud
 * Functions contract in two places at once, and the drift stranded borrowers:
 *
 *   - ReviewQueue listed only `pending` / `pending_review`, so a review moved
 *     to `info_requested` or `escalated` disappeared from the only surface in
 *     the app that queries `review_queue`.
 *   - ReviewDetail gated its action buttons on the same two statuses, so even
 *     a direct link to the review offered no way to resolve it.
 *
 * Meanwhile `submitReviewDecision` keeps both decidable on purpose. Its own
 * comment names the harm (#407): treating `info_requested` as terminal
 * "stranded the loan in `under_review`, which requestLoan counts as an
 * occupied slot — one click locked the employee out of the product
 * permanently". The backend was fixed; the console still enforced the bug.
 *
 * Kept as plain predicates in one module, rather than inline arrays at each
 * call site, because two call sites disagreeing is exactly what happened.
 *
 * Backend source of truth — change these together:
 *   functions/src/admin/getReviewQueue.ts   OPEN_STATUSES
 *   functions/src/index.ts                  DECIDABLE_REVIEW_STATUSES
 *                                           ESCALATED_DECIDER_ROLES
 */

/** Statuses that still represent outstanding work. Mirrors `OPEN_STATUSES`. */
export const OPEN_REVIEW_STATUSES = [
  'pending',
  'pending_review',
  'info_requested',
  'escalated',
] as const;

/**
 * Decidable by any reviewer. Mirrors `DECIDABLE_REVIEW_STATUSES`.
 *
 * `info_requested` is here deliberately: ops asked the employee for a
 * document, and the answer has to be able to land.
 */
const DECIDABLE_REVIEW_STATUSES = ['pending', 'pending_review', 'info_requested'];

/**
 * `escalated` is decidable too, but only from a role above the ops user who
 * escalated it — that is what makes escalation mean something without building
 * a separate supervisor queue. Mirrors `ESCALATED_DECIDER_ROLES`.
 */
const ESCALATED_DECIDER_ROLES = ['admin', 'super_admin'];

export type ReviewDecision = 'approved' | 'rejected' | 'request_info' | 'escalate';

/** Whether this review is still open work, regardless of who is looking. */
export function isOpenReview(status: string): boolean {
  return (OPEN_REVIEW_STATUSES as readonly string[]).includes(status);
}

/**
 * Whether `role` can resolve a review in `status`.
 *
 * Returns false for an unknown/absent role rather than defaulting to
 * permissive: the server rejects it anyway, and offering a button that will
 * fail is worse than not offering it.
 */
export function canDecideReview(status: string, role: string | null | undefined): boolean {
  if (status === 'escalated') {
    return !!role && ESCALATED_DECIDER_ROLES.includes(role);
  }
  return DECIDABLE_REVIEW_STATUSES.includes(status);
}

/**
 * The decisions worth offering for this review.
 *
 * Excludes `escalate` on an already-escalated review — the server answers that
 * with `failed-precondition` ("Review is already escalated"), so showing the
 * button only produces an error toast.
 */
export function availableDecisions(
  status: string,
  role: string | null | undefined
): ReviewDecision[] {
  if (!canDecideReview(status, role)) return [];
  const all: ReviewDecision[] = ['approved', 'rejected', 'request_info', 'escalate'];
  return status === 'escalated' ? all.filter((d) => d !== 'escalate') : all;
}

/**
 * Why the current user cannot act, for display. Null when they can.
 *
 * The escalated-but-under-privileged case is the one that matters: it is not a
 * resolved review, it is someone else's to resolve, and the console previously
 * rendered both as the same dead end ("This review has status: escalated").
 */
export function blockedReason(
  status: string,
  role: string | null | undefined
): string | null {
  if (canDecideReview(status, role)) return null;
  if (status === 'escalated') {
    return 'Esta revisión fue escalada y solo un administrador puede resolverla.';
  }
  return null;
}
