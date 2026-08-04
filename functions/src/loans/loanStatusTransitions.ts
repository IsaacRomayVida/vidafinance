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

// The mirror image of LOAN_APPROVAL_SOURCE_STATUSES: the statuses a loan can be
// DECLINED from while the borrower's credit is still merely held rather than
// spent. `requestLoan` decrements `availableCredit` for every status it creates
// except 'rejected' (`holdCredit = initialStatus !== 'rejected'`), so both of
// these carry a live hold that a decline has to give back.
//
// Deliberately the SAME two statuses as the approval set, and for the same
// reason: `pending` is the auto-approve path and `under_review` is the manual
// path that submitReviewDecision writes — the only one that occurs under
// today's ML_MODE. The rejection side of onLoanStatusChange used to hardcode
// `pending` alone while #488 widened only the approval side, so the one
// rejection transition production actually produces
// (`under_review -> rejected`) released nothing and the borrower's credit line
// shrank by the requested amount on every decline.
//
// Deliberately NOT extended past approval. A loan at `approved` has already
// fired onLoanApproved and may have a real SPEI transfer queued against it;
// `DISBURSEMENT_INITIATED_STATUSES` onwards the money is out the door. Handing
// credit back on those would let a borrower re-borrow against funds they were
// actually paid.
export const LOAN_REJECTION_SOURCE_STATUSES: readonly string[] = [
  LOAN_STATUS.PENDING,
  LOAN_STATUS.UNDER_REVIEW,
];

export function isCreditReleasingRejection(beforeStatus: unknown, afterStatus: unknown): boolean {
  return (
    typeof beforeStatus === 'string' &&
    LOAN_REJECTION_SOURCE_STATUSES.includes(beforeStatus) &&
    afterStatus === LOAN_STATUS.REJECTED
  );
}

// Loan statuses reached only once a disbursement attempt has actually started
// — the SPEI transfer is queued, sent, or the loan otherwise left pre-approval
// limbo. Ops/admin corrections within this set are legitimate (e.g. nudging a
// stuck `disbursement_failed` loan back to `disbursement_queued` for a manual
// retry), but moving OUT of this set is not: rewinding to a pre-disbursement
// status is the two-call replay (set 'pending', then set 'approved') that
// reproduces the approval trigger diff and re-fires a real transfer, and SPEI
// has no idempotency key of its own.
//
// updateLoanStatus therefore refuses EVERY exit from this set, not only the
// ones landing in PRE_DISBURSEMENT_STATUSES. It used to check just the latter,
// which left 'rejected', 'rejected_ml' and 'cancelled' — canonical statuses in
// NEITHER set — usable as a sideways step that took a funded loan out of the
// guard's idea of "post-disbursement" and let the next call rewind it freely.
//
// This is NOT the only guard on the disbursement side: onLoanApproved also
// claims `disbursement_queue/{loanId}` transactionally (and refuses on an
// existing `disbursedAt`), so a replayed approval cannot reach the adapter
// twice. The credit-release side has no such second guard — a laundered
// `pending -> rejected` fires isCreditReleasingRejection and hands back
// availableCredit on money that really went out — which is why the
// callable-level refusal has to be the complete one.
//
// Both sets are now defined once, in `./loanStatus`, and simply re-exported
// above — they used to be hand-duplicated here with a bare 'paid' entry that
// no write path has ever produced, silently excluding it from the rewind
// guard's protection whenever a document did carry that spelling.
