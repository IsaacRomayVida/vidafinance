'use strict';

// Idempotency for /internal/disburse.
//
// WHY THIS EXISTS
//
// /spei/transfer has no idempotency key of its own — SoftCrédito will happily
// execute the same transfer twice (see functions/src/loans/loanStatusTransitions.ts:89
// and the comment above SC_READ_TIMEOUT_MS in index.js). Until this module,
// nothing on our side made up the difference: the route read the request body,
// called /spei/transfer, and wrote the result. Every retry was a second real
// payout to the borrower's CLABE.
//
// Retries are not hypothetical. payment-server's disburseWorker
// (services/payment-server/index.js:403-417) throws on any non-2xx from this
// route and BullMQ re-runs the job — same job data — up to 5 attempts. A
// timeout, a 500 from our own post-transfer bookkeeping, or a stalled job
// after a container restart each replay a completed transfer.
//
// THE UNIT OF IDEMPOTENCY IS THE LOAN, NOT THE REQUEST
//
// The claim is keyed on loanId, server-derived, in disbursement_claims/{loanId}.
// A caller-supplied key was rejected because neither caller can supply a stable
// one across the retries that actually happen:
//
//   - onLoanApproved (functions/src/index.ts:2513) is a Firestore trigger. A
//     re-fire is a fresh invocation with no memory of the previous one; any key
//     it minted would be new, and a new key is the same as no key.
//   - disburseWorker does reuse its job data, so a key placed in the job would
//     survive BullMQ retries — but not a job re-enqueued by ops, and not the
//     trigger path at all.
//
// A loan is disbursed exactly once. That is the invariant worth enforcing, and
// loanId already names it: disbursement_queue is keyed doc(loanId), and the
// trigger's own claim (functions/src/index.ts:2482) uses the same key. A
// caller-supplied key could only ever be a weaker restatement of it, with an
// extra way for a caller to get it wrong and pay a borrower twice.
//
// THREE STATES, NEVER COLLAPSED
//
//   absent / 'released'  never dispatched     → claim it and send
//   'in_flight'          dispatched, outcome unknown → REFUSE, reconcile by hand
//   'sent'               confirmed sent       → return the original receipt
//
// The middle state is the one that matters. A previous attempt got as far as
// dispatching and never came back with an answer — timeout, malformed body,
// process death. We do not know whether SPEI moved the money. Re-sending on a
// guess is how a borrower is paid twice; refusing costs a reconciliation
// ticket. Refuse.
//
// 'released' is deliberately distinct from 'in_flight': it means SoftCrédito
// answered and its answer was "I did not do this" (a 4xx with a body — see
// isDefiniteUpstreamRejection for why 5xx does not qualify). That is a *known*
// outcome, so a legitimate retry may still fund the borrower. Folding definite
// rejections into the indeterminate state would strand every bad-CLABE typo
// behind manual reconciliation.

const CLAIMS_COLLECTION = 'disbursement_claims';

const CLAIM_IN_FLIGHT = 'in_flight';
const CLAIM_SENT = 'sent';
const CLAIM_RELEASED = 'released';

// What makes two calls "the same disbursement". Amount and destination are the
// two fields that decide how much money leaves and where it lands; a call that
// differs in either is a different payout wearing the same loanId, not a replay.
function fingerprint(amount, clabe) {
  return `${amount}|${clabe}`;
}

// Evidence that a loan was disbursed before this module existed. Loans funded
// by the old code carry no claim doc, so without this a single post-deploy
// retry of an old job would re-send. These are exactly the fields the old
// success path wrote (index.js, and functions/src/index.ts:2540).
function hasLegacyDisbursementEvidence(loan, queue) {
  return Boolean(
    loan.disbursedAt ||
    loan.disbursementRef ||
    loan.softcreditoTransferId ||
    (queue && queue.status === 'completed')
  );
}

/**
 * Atomically claim this loan's disbursement.
 *
 * Everything below runs inside one Firestore transaction, which is what makes
 * two simultaneous duplicate requests resolve to one winner: the loser's read
 * either sees the winner's claim or its own commit is rejected and retried
 * until it does. A read-then-write outside a transaction would let both
 * requests observe "no claim" and both dispatch.
 *
 * Returns one of:
 *   { outcome: 'claimed' }
 *   { outcome: 'already_sent', ref, transferId }
 *   { outcome: 'indeterminate', claimedAt }
 *   { outcome: 'conflict' }
 */
async function claimDisbursement({ db, admin, loanId, amount, clabe }) {
  const claimRef = db.collection(CLAIMS_COLLECTION).doc(loanId);
  const loanRef = db.collection('loans').doc(loanId);
  const queueRef = db.collection('disbursement_queue').doc(loanId);
  const fp = fingerprint(amount, clabe);

  return db.runTransaction(async (tx) => {
    const [claimSnap, loanSnap, queueSnap] = await Promise.all([
      tx.get(claimRef),
      tx.get(loanRef),
      tx.get(queueRef),
    ]);

    if (claimSnap.exists) {
      const claim = claimSnap.data() || {};
      const differentTerms = Boolean(claim.fingerprint && claim.fingerprint !== fp);

      if (claim.status === CLAIM_SENT || claim.status === CLAIM_IN_FLIGHT) {
        // The conflict check belongs INSIDE these two branches, not ahead of
        // them. It exists to stop a different payout being answered with the
        // first transfer's receipt, or being waved through on top of one — and
        // both of those are only possible while money is at stake, which is
        // exactly what 'sent' and 'in_flight' mean.
        if (differentTerms) {
          return { outcome: 'conflict' };
        }
        if (claim.status === CLAIM_SENT) {
          return { outcome: 'already_sent', ref: claim.ref ?? null, transferId: claim.transferId ?? null };
        }
        return { outcome: 'indeterminate', claimedAt: claim.claimedAt ?? null };
      }

      if (claim.status === CLAIM_RELEASED) {
        // No money is at stake here and none ever was: 'released' is written
        // only when SoftCrédito answered and its answer was "I did not perform
        // this transfer". The stale fingerprint on the doc therefore describes
        // an attempt that moved nothing, and re-requesting with different terms
        // is not a second payout — it is the correction that finally funds the
        // borrower. A CLABE typo'd into a 400 INVALID_CLABE is the ordinary
        // case, and releaseClaim() merges, so the rejected attempt's
        // fingerprint outlives it. Conflicting against that would mean the only
        // request that can ever fund this loan is the one already known to fail,
        // stranding the borrower permanently with no override anywhere in the
        // system. Fall through and re-claim; the tx.set below replaces the doc
        // outright, so the corrected terms become the new fingerprint.
      } else {
        // A claim doc in a state this module does not recognise. Nothing writes
        // one today, so reaching here means the doc was hand-edited or written
        // by a future version — either way we cannot say whether money moved,
        // and the whole doctrine of this module is that anything unclassifiable
        // is refused rather than guessed at.
        return { outcome: 'indeterminate', claimedAt: claim.claimedAt ?? null };
      }
    } else if (hasLegacyDisbursementEvidence(loanSnap.data() || {}, queueSnap.data())) {
      const loan = loanSnap.data() || {};
      // Adopt the old evidence into a claim so the next retry takes the cheap
      // path above instead of re-deriving it.
      //
      // Deliberately WITHOUT a fingerprint. The obvious thing — writing this
      // request's `fp` — records terms nobody has verified: the adopting
      // request is simply whichever one happened to arrive first after deploy,
      // and if it carries a wrong amount or CLABE that wrong pair becomes this
      // loan's permanent definition of "the same disbursement". The labels then
      // come out inverted for good: the bogus request is answered 200
      // already_sent, and the genuine retry carrying the loan's real terms is
      // refused 409 conflict and pages ops.
      //
      // The right fingerprint is unreconstructable here on purpose, not by
      // omission — a legacy disbursement's destination CLABE was only ever
      // written to spei_log, never to the loan or queue docs this transaction
      // reads. Absent means absent: the conflict check below is skipped for
      // adopted claims, so every later request is answered with the receipt of
      // the disbursement that demonstrably did happen. That forgoes conflict
      // detection for pre-deploy loans, which is the honest trade — no money
      // can move down this path either way, and the alternative is not better
      // detection but confidently wrong detection.
      tx.set(claimRef, {
        loanId,
        status: CLAIM_SENT,
        ref: loan.disbursementRef ?? null,
        transferId: loan.softcreditoTransferId ?? null,
        adoptedFrom: 'pre_claim_disbursement',
        adoptedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return {
        outcome: 'already_sent',
        ref: loan.disbursementRef ?? null,
        transferId: loan.softcreditoTransferId ?? null,
      };
    }

    tx.set(claimRef, {
      loanId,
      status: CLAIM_IN_FLIGHT,
      fingerprint: fp,
      amount,
      clabe,
      claimedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { outcome: 'claimed' };
  });
}

// Called the instant SoftCrédito confirms, BEFORE the loans/disbursement_queue/
// spei_log writes. Those writes can fail — .update() on a missing
// disbursement_queue doc throws NOT_FOUND — and if they failed while the claim
// still read 'in_flight', a confirmed transfer would look unknown and the
// borrower's loan would be stuck behind a manual reconciliation for a payout
// that plainly succeeded.
async function markClaimSent({ db, admin, loanId, ref, transferId }) {
  await db.collection(CLAIMS_COLLECTION).doc(loanId).set({
    loanId,
    status: CLAIM_SENT,
    ref: ref ?? null,
    transferId: transferId ?? null,
    sentAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

// Only for failures where the upstream ANSWERED and said it did not perform the
// transfer. Never call this on a timeout, an aborted request or an unparseable
// body: those are the indeterminate state, and releasing them would re-arm the
// duplicate payout this module exists to prevent.
async function releaseClaim({ db, admin, loanId, reason }) {
  await db.collection(CLAIMS_COLLECTION).doc(loanId).set({
    loanId,
    status: CLAIM_RELEASED,
    releaseReason: reason || 'upstream_rejected',
    releasedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

// Did the upstream tell us, in so many words, that it did not move the money?
//
// scCall (index.js) sets `status` on the error only in the !r.ok branch, i.e.
// we received and parsed a complete HTTP response carrying a non-2xx code.
// Transport errors, aborts and JSON parse failures reach here with no status —
// and stay indeterminate, which is the safe default for anything we cannot
// positively classify.
//
// 4xx ONLY, deliberately. A 4xx is SoftCrédito refusing the request on its
// face — bad CLABE, insufficient funds, rate limited — decided before any
// money could move, so releasing the claim is safe and lets a corrected retry
// still fund the borrower. A 5xx is not that. "500 Internal Server Error" is
// exactly what a vendor returns when it initiated the SPEI and then fell over
// writing its own ledger, and a 502/504 means an intermediary gave up on a
// request the origin may have processed in full. Treating those as definite
// would release the claim and let disburseWorker's five BullMQ retries re-send
// a transfer that already happened — the duplicate payout this module exists
// to prevent. A 5xx is an unknown outcome, and unknown outcomes are refused
// rather than guessed at, same as a timeout.
function isDefiniteUpstreamRejection(err) {
  return Boolean(err && typeof err.status === 'number' && err.status >= 400 && err.status < 500);
}

module.exports = {
  CLAIMS_COLLECTION,
  CLAIM_IN_FLIGHT,
  CLAIM_SENT,
  CLAIM_RELEASED,
  claimDisbursement,
  markClaimSent,
  releaseClaim,
  isDefiniteUpstreamRejection,
  hasLegacyDisbursementEvidence,
};
