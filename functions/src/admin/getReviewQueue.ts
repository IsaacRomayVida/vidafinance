import { onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore } from 'firebase-admin/firestore';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { enforceRateLimit } from '../utils/rateLimiter';
import { conditionSource } from './underwritingProvenance';

// Every status a review can sit in while it still needs a human — i.e. every status
// submitReviewDecision will still accept a decision for (DECIDABLE_REVIEW_STATUSES
// plus `escalated`, which admin/super_admin resolve; see index.ts).
//
// `info_requested` and `escalated` are NOT terminal. The comment that used to say so
// here predates #407: back then request_info/escalate really did make a review
// undecidable forever. #408 gave both a return path, so leaving them out of the
// default list rebuilt the same dead end one layer up — ops asks for a payslip, the
// employee sends it, and the review never comes back to the list ops actually works.
//
// Keep this in lockstep with COUNTED_STATUSES: the header count and the default list
// are two statements about the same set, and they must not disagree.
const OPEN_STATUSES = ['pending', 'pending_review', 'info_requested', 'escalated'];
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

// Statuses the console shows as filter pills. Counted with server-side aggregation
// (billed at ~1/1000 of reading the documents), so the header can answer "how many
// are waiting on a human" without any client paging over the collection.
const COUNTED_STATUSES = [...OPEN_STATUSES];

interface GetReviewQueueData {
  status?: string;
  limit?: number;
  startAfter?: string;
}

interface ConditionCount {
  passed: number;
  total: number;
}

interface FailedConditionDetail {
  name: string;
  // "read" | "assumed" | "unknown" — see summarizeUnderwriting for why "unknown"
  // is a distinct state from "assumed" rather than the same bucket.
  source: string;
}

interface UnderwritingSummary {
  decision: string | null;
  allPass: boolean | null;
  conditions: ConditionCount;
  failedConditions: string[];
  failedConditionDetails: FailedConditionDetail[];
  // Failed conditions the pipeline never actually read (source === "assumed",
  // post-#458/#462) — a provider outage or skipped stage, not a credit signal.
  // Excludes legacy loans with no `source` field at all (see summarizeUnderwriting).
  unreadFailures: string[];
}

// The risk vocabulary stage5-review.js can actually produce: `assessRiskLevel`
// returns "high" for a PEP or a fuzzy AML match, otherwise the LLM's own grade,
// otherwise "medium"; the LLM parse paths seed "unknown" on failure
// (stage5-review.js:65,147,204,213). Anything outside this set is a value this
// backend does not understand, and it degrades to null rather than being passed
// through — a reviewer must not see a risk pill rendering a string we cannot
// vouch for.
type RiskLevel = 'low' | 'medium' | 'high' | 'critical' | 'unknown';
const RISK_LEVELS: readonly string[] = ['low', 'medium', 'high', 'critical', 'unknown'];

// The three AML flags the Reason column renders, and nothing else. `amlLists`
// is deliberately NOT projected: it carries the matched watchlist entries, it
// feeds no UI element, and an unused list of a named person's sanctions matches
// has no business on the wire.
interface AmlSummary {
  criminalRecordFound: boolean | null;
  amlHit: boolean | null;
  isPEP: boolean | null;
}

// The four `signals.*` leaves the console reads — the RiskSeal score and bureau
// score/defaults behind the Reason column, and the ratio behind the LTI sort.
// Projected leaf-by-leaf rather than by spreading `signals`, which is an
// open-ended bag written by the pipeline: spreading it would put every future
// provider field on the wire the day it is added, without anyone deciding to.
interface RiskSignals {
  riskSealScore: number | null;
  bureauScore: number | null;
  bureauActiveDefaults: number | null;
  loanToSalaryRatio: number | null;
}

interface ReviewQueueRow {
  id: string;
  loanId: string | null;
  employeeId: string | null;
  employeeName: string | null;
  employerId: string | null;
  employerName: string | null;
  amount: number | null;
  // The money owed, read from the loan document — NEVER recomputed from the live
  // config. `feeRate` is admin-editable (#389) and each loan persists the rate in
  // force when it was signed, so recomputing here would reprice a signed loan in
  // the reviewer's view. Two rows in the same list may legitimately show different
  // rates; that is the contract, not a bug.
  //
  // Null (not 0, not a client-side product) when the loan is missing these fields:
  // an orphan review, or a loan predating the field. The console renders null as
  // "—". 0 would assert this loan costs nothing.
  feeAmount: number | null;
  feeRate: number | null;
  totalDue: number | null;
  requestedAt: unknown;
  // The 24h SLA stamped at queue time (stage5-review.js). Surfaced rather than
  // recomputed as `requestedAt + 24h`: the window is the pipeline's to set, and
  // a client that derives it would keep asserting 24h on the day it changes.
  // Null for a review written before the field existed — the console must then
  // show no deadline, not a fabricated one.
  slaDeadline: unknown;
  status: string;
  underwritingDecision: UnderwritingSummary | null;
  // ── ML/LLM risk grade — NOT the same assertion as `underwritingDecision` ────
  // `underwritingDecision` is deterministic: named conditions, each with a value
  // and the bound it was tested against. `riskLevel`/`llmRiskLevel` is a graded
  // judgement from the AML rules and the LLM narrative. They answer different
  // questions and are kept as separate fields on purpose. Mapping one onto the
  // other would leave the console's risk pill looking identical while silently
  // changing what it asserts to a human deciding someone's loan (#517).
  riskLevel: RiskLevel | null;
  // `llm_narrative.risk_level` only. The narrative's `summary`,
  // `key_signals`, `recommendation` and `confidence` are free-text model output
  // that no listed console element renders, so they stay off the row.
  llmRiskLevel: RiskLevel | null;
  aml: AmlSummary | null;
  riskSignals: RiskSignals | null;
}

interface GetReviewQueueResult {
  reviews: ReviewQueueRow[];
  // Collection-wide totals per status — NOT a total for the page in `reviews`.
  // Null when the aggregation failed: the list is still useful without it, and a
  // missing count must render as "unknown", never as 0. 0 is a claim about work.
  counts: Record<string, number> | null;
  nextCursor: string | null;
  // Which order was actually served, not which one was asked for. Oldest-first
  // needs the `(status ASC, queuedAt ASC)` composite index, and index deploys have
  // been 403'ing since 2026-07-31 (the deploy service account is missing
  // `roles/datastore.indexAdmin` — see #414). Rather than ship a query that dies
  // with FAILED_PRECONDITION until a human fixes IAM, the handler falls back to
  // newest-first and says so here.
  //
  // The console header reads this instead of hardcoding a caveat string: a
  // hardcoded one has to be deleted by hand the day the index lands, and nobody
  // remembers. Same rule as `counts` — never assert something about the data that
  // the response does not support.
  sortOrder: 'oldest_first' | 'newest_first';
}

// A money field is either a real number or unknown. NaN/Infinity are neither, and
// must not reach a currency cell as "NaN" — they degrade to null like a missing field.
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// A flag is either a real boolean or unknown. Deliberately NOT truthiness:
// a missing `isPEP` must reach the console as null ("we did not check") and
// never as `false` ("we checked, and this person is not a PEP"). The Reason
// column treats these as reasons to escalate, so a fabricated `false` is a
// suppressed escalation.
function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

// Narrow to the vocabulary this backend understands; anything else is null.
function riskLevel(v: unknown): RiskLevel | null {
  return typeof v === 'string' && RISK_LEVELS.includes(v) ? (v as RiskLevel) : null;
}

// Read a nested sub-document off the review only when it really is an object.
// Firestore will hand back whatever was written, including a string or an
// array, and indexing into that must not throw inside the row map.
function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

// Fail-soft, same contract as `summarizeUnderwriting`: a review missing the
// sub-document entirely yields null (the console renders "—"), and a review
// carrying a partial one yields an object whose absent leaves are individually
// null. Never an empty-but-present object claiming all-clear.
function summarizeAml(review: Record<string, unknown>): AmlSummary | null {
  const aml = obj(review['aml_result']);
  if (!aml) return null;
  return {
    criminalRecordFound: bool(aml['criminalRecordFound']),
    amlHit: bool(aml['amlHit']),
    isPEP: bool(aml['isPEP']),
  };
}

function summarizeSignals(review: Record<string, unknown>): RiskSignals | null {
  const signals = obj(review['signals']);
  if (!signals) return null;
  const riskseal = obj(signals['riskseal']);
  const bureau = obj(signals['bureau']);
  const loan = obj(signals['loan']);
  return {
    riskSealScore: num(riskseal?.['score']),
    bureauScore: num(bureau?.['score']),
    bureauActiveDefaults: num(bureau?.['activeDefaults']),
    loanToSalaryRatio: num(loan?.['loanToSalaryRatio']),
  };
}

// Fail-soft: loans created before PR #393 shipped (or whose pipeline never
// reached Stage 3) have no `underwritingDetail` doc at all — never throw over
// its absence, just surface null to the client.
//
// `detail` is `loans/{loanId}/underwritingDetail/detail` (E5c), NOT a field on
// the loan doc — that subcollection is what firestore.rules gates `isOps()`-
// only, since each condition carries the applicant's actual bureau/fraud/model
// scores. This function only ever sees it via this Admin-SDK read, which
// bypasses client rules, so the ops-only gate on the source data holds
// regardless of what this summary reshapes it into.
function summarizeUnderwriting(detail: Record<string, unknown> | null): UnderwritingSummary | null {
  const uw = detail;
  if (!uw) return null;

  const conditions = Array.isArray(uw['conditions'])
    ? (uw['conditions'] as Record<string, unknown>[])
    : [];
  const passed = conditions.filter((c) => c['pass'] === true).length;
  const failed = conditions.filter((c) => c['pass'] !== true);
  const failedConditions = failed.map((c) =>
    typeof c['name'] === 'string' ? (c['name'] as string) : 'unknown'
  );

  // Provenance rule lives in `conditionSource` (./underwritingProvenance) —
  // shared with getReviewDetail's per-condition rows so the two screens cannot
  // disagree about what a missing `source` key means. See that module for why
  // absent is "unknown" and not "assumed".
  const failedConditionDetails: FailedConditionDetail[] = failed.map((c) => ({
    name: typeof c['name'] === 'string' ? (c['name'] as string) : 'unknown',
    source: conditionSource(c['source']),
  }));
  const unreadFailures = failedConditionDetails
    .filter((c) => c.source === 'assumed')
    .map((c) => c.name);

  return {
    decision: typeof uw['decision'] === 'string' ? (uw['decision'] as string) : null,
    allPass: typeof uw['allPass'] === 'boolean' ? (uw['allPass'] as boolean) : null,
    conditions: { passed, total: conditions.length },
    failedConditions,
    failedConditionDetails,
    unreadFailures,
  };
}

export const getReviewQueue = onCall(
  { cors: true, enforceAppCheck: true },
  withAuth<GetReviewQueueData, GetReviewQueueResult>(
    ['ops', 'admin', 'super_admin'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'getReviewQueue', uid: auth.uid }, async () => {
        // Rate limit: 60/min/uid (read-only list view)
        // Deliberately fails OPEN. This is a read-only view: the limit is
        // here to protect capacity, not money or secrets, so a limiter
        // outage should degrade to an unthrottled dashboard rather than
        // to a dashboard nobody can open. Contrast the spend- and
        // enumeration-critical limits, which fail closed.
        await enforceRateLimit(`rl:getReviewQueue:${auth.uid}`, 60, 60, {
          onUnavailable: 'open',
          context: 'getReviewQueue',
        });

        const db = getFirestore();

        const rawLimit = typeof data?.limit === 'number' && Number.isFinite(data.limit) ? data.limit : DEFAULT_LIMIT;
        const limit = Math.min(Math.max(1, Math.floor(rawLimit)), MAX_LIMIT);

        const status = typeof data?.status === 'string' && data.status.trim().length > 0 ? data.status.trim() : null;

        // Resolve the cursor once — it is independent of sort direction, and the
        // fallback below must not re-read it.
        let cursorSnap: FirebaseFirestore.DocumentSnapshot | null = null;
        if (data?.startAfter) {
          const snap = await db.collection('review_queue').doc(data.startAfter).get();
          if (snap.exists) cursorSnap = snap;
        }

        // Oldest first. This is a work queue, not an activity feed: the review that
        // has waited longest is the most urgent one, and with cursor pagination a
        // newest-first order buries it on the last page nobody scrolls to.
        //
        // Flat by age, deliberately not tiered by status — Firestore would order
        // `status` lexically (approved < escalated < info_requested < pending <
        // pending_review), which is not a priority order, and faking one needs a
        // stored sort key. The status column and the filter pills already answer
        // "what kind of work is this"; the sort answers "what has waited longest".
        const buildQuery = (direction: 'asc' | 'desc') => {
          const base = status
            ? db.collection('review_queue').where('status', '==', status)
            : db.collection('review_queue').where('status', 'in', OPEN_STATUSES);
          const ordered = base.orderBy('queuedAt', direction).limit(limit);
          return cursorSnap ? ordered.startAfter(cursorSnap) : ordered;
        };

        // Oldest-first needs `(status ASC, queuedAt ASC)`, which is in
        // firestore.indexes.json but cannot reach production while index deploys
        // 403 on the missing `roles/datastore.indexAdmin` (#414). Without the
        // fallback this throws FAILED_PRECONDITION on every call — not a degraded
        // sort, a dead screen: the default view and all four filter pills, including
        // the statuses that render fine today.
        //
        // So degrade the ordering instead of the endpoint, and report which order
        // was served. Self-healing: the day the index goes live this starts
        // returning oldest-first with no second deploy.
        let sortOrder: 'oldest_first' | 'newest_first' = 'oldest_first';
        let querySnap;
        try {
          querySnap = await buildQuery('asc').get();
        } catch (e: unknown) {
          const code = (e as { code?: unknown })?.code;
          // gRPC 9 / 'failed-precondition' is Firestore's "this query needs an index
          // you do not have". Anything else is uncharacterised and must still throw.
          if (code !== 9 && code !== 'failed-precondition') throw e;
          logger.warn('Review queue oldest-first index missing, serving newest-first', {
            error: (e as Error).message,
            service: 'functions',
          });
          sortOrder = 'newest_first';
          querySnap = await buildQuery('desc').get();
        }
        const reviewDocs = querySnap.docs;

        // Batch-fetch the loans backing this page of reviews (bounded by `limit`)
        // instead of querying inside a loop.
        const loanIds = Array.from(
          new Set(
            reviewDocs
              .map((d) => d.data()?.['loanId'] as string | undefined)
              .filter((id): id is string => Boolean(id))
          )
        );
        const loanRefs = loanIds.map((id) => db.collection('loans').doc(id));
        const loanSnaps = loanRefs.length > 0 ? await db.getAll(...loanRefs) : [];
        const loanById = new Map<string, Record<string, unknown>>();
        loanSnaps.forEach((snap) => {
          if (snap.exists) loanById.set(snap.id, snap.data() as Record<string, unknown>);
        });

        // Batch-fetched alongside the loans themselves, same `loanIds` order —
        // see `summarizeUnderwriting` for why this lives in a subcollection
        // rather than a field on the loan doc.
        const underwritingDetailRefs = loanIds.map((id) =>
          db.collection('loans').doc(id).collection('underwritingDetail').doc('detail')
        );
        const underwritingDetailSnaps =
          underwritingDetailRefs.length > 0 ? await db.getAll(...underwritingDetailRefs) : [];
        const underwritingDetailByLoanId = new Map<string, Record<string, unknown>>();
        underwritingDetailSnaps.forEach((snap, i) => {
          if (snap.exists) underwritingDetailByLoanId.set(loanIds[i], snap.data() as Record<string, unknown>);
        });

        const reviews: ReviewQueueRow[] = reviewDocs.map((doc) => {
          const review = doc.data() as Record<string, unknown>;
          const loanId = typeof review['loanId'] === 'string' ? (review['loanId'] as string) : null;
          const loan = loanId ? loanById.get(loanId) ?? null : null;
          const underwritingDetail = loanId ? underwritingDetailByLoanId.get(loanId) ?? null : null;

          return {
            id: doc.id,
            loanId,
            employeeId: (loan?.['employeeId'] as string) ?? null,
            employeeName: (loan?.['employeeName'] as string) ?? (review['applicantName'] as string) ?? null,
            employerId: (loan?.['employerId'] as string) ?? null,
            employerName: (loan?.['employerName'] as string) ?? null,
            amount: num(loan?.['amount']),
            feeAmount: num(loan?.['fee']),
            feeRate: num(loan?.['feeRate']),
            totalDue: num(loan?.['total']),
            requestedAt: review['queuedAt'] ?? null,
            slaDeadline: review['slaDeadline'] ?? null,
            status: review['status'] as string,
            underwritingDecision: summarizeUnderwriting(underwritingDetail),
            // All five read from `review` — the document already in memory from
            // the page query above. This adds no Firestore read: the fields were
            // being fetched and then discarded by the projection, which is what
            // forced the console to keep its own direct `onSnapshot` on
            // `review_queue` (#517).
            riskLevel: riskLevel(review['risk_level']),
            llmRiskLevel: riskLevel(obj(review['llm_narrative'])?.['risk_level']),
            aml: summarizeAml(review),
            riskSignals: summarizeSignals(review),
          };
        });

        const nextCursor = reviewDocs.length === limit ? reviewDocs[reviewDocs.length - 1].id : null;

        // Fail-soft: a broken aggregation must not take down the queue itself.
        let counts: Record<string, number> | null = null;
        try {
          const countSnaps = await Promise.all(
            COUNTED_STATUSES.map((s) =>
              db.collection('review_queue').where('status', '==', s).count().get()
            )
          );
          counts = Object.fromEntries(
            COUNTED_STATUSES.map((s, i) => [s, countSnaps[i].data().count])
          );
        } catch (e: unknown) {
          logger.warn('Review queue counts unavailable', {
            error: (e as Error).message,
            service: 'functions',
          });
        }

        return { reviews, counts, nextCursor, sortOrder };
      })
  )
);
