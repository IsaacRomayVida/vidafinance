/**
 * The loan status-machine vocabulary shared by the approval triggers and by
 * `updateLoanStatus`'s admin/ops guard.
 *
 * These live in their own module rather than in `index.ts` because every
 * `export` from `index.ts` is treated as a deployable Cloud Function — both by
 * `deploy.yml`'s FUNCTIONS list and by the deploy-readiness drift gate (#376),
 * which fails the build on any exported symbol that is not in that list. A
 * plain predicate exported from `index.ts` is indistinguishable from a function
 * that was forgotten during deploy, so shared helpers belong here and are
 * imported (not re-exported) by `index.ts`.
 *
 * The actual status literals now live in `./loanStatus` (the single canonical
 * vocabulary — see that file for why 'repaid', not 'paid', is canonical). This
 * module re-exports the subsets it needs so existing imports of
 * `DISBURSEMENT_INITIATED_STATUSES` / `PRE_DISBURSEMENT_STATUSES` from here
 * keep working without every caller having to know the sets moved.
 */
import { LOAN_STATUS, DISBURSEMENT_INITIATED_STATUSES, PRE_DISBURSEMENT_STATUSES } from './loanStatus';

export { DISBURSEMENT_INITIATED_STATUSES, PRE_DISBURSEMENT_STATUSES };

// Loan statuses a legitimate pre-approval decision can transition FROM into
// 'approved' and have the disbursement pipeline fire. `pending` is the
// direct-approval path (auto-approved by the underwriting pipeline);
// `under_review` is the manual-review path (submitReviewDecision) — and since
// deployed config is ML_MODE=manual_review_all, EVERY non-rejected loan takes
// that path today (P0). Both onLoanStatusChange and onLoanApproved gate on this
// same set so the two triggers cannot disagree about what counts as an approval.
//
// Deliberately NOT "any status → approved": a loan already past approval
// (disbursement_queued, active, disbursed, repaid) re-entering 'approved' must
// not re-fire disbursement. See the idempotency guard inside onLoanApproved and
// the rewind guard in updateLoanStatus, both of which exist because ops tooling
// can otherwise reproduce this exact transition twice on a loan that has
// already been disbursed and re-call the real SoftCrédito transfer.
export const LOAN_APPROVAL_SOURCE_STATUSES: readonly string[] = [
  LOAN_STATUS.PENDING,
  LOAN_STATUS.UNDER_REVIEW,
];

export function isLoanApprovalTransition(beforeStatus: unknown, afterStatus: unknown): boolean {
  return (
    typeof beforeStatus === 'string' &&
    LOAN_APPROVAL_SOURCE_STATUSES.includes(beforeStatus) &&
    afterStatus === LOAN_STATUS.APPROVED
  );
}

// Loan statuses reached only once a disbursement attempt has actually started
// — the SPEI transfer is queued, sent, or the loan otherwise left pre-approval
// limbo. Ops/admin corrections within this set are legitimate (e.g. nudging a
// stuck `disbursement_failed` loan back to `disbursement_queued` for a manual
// retry), but rewinding one of these back to a pre-disbursement status is
// exactly the two-call replay (set 'pending', then set 'approved') that
// reproduces the approval trigger diff and re-fires a real transfer — SPEI has
// no idempotency key of its own, so refusing the rewind in updateLoanStatus is
// the only guard on that path.
//
// Both sets are now defined once, in `./loanStatus`, and simply re-exported
// above — they used to be hand-duplicated here with a bare 'paid' entry that
// no write path has ever produced, silently excluding it from the rewind
// guard's protection whenever a document did carry that spelling.
