import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore } from 'firebase-admin/firestore';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { checkRateLimit } from '../utils/rateLimiter';

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

interface UnderwritingSummary {
  decision: string | null;
  allPass: boolean | null;
  conditions: ConditionCount;
  failedConditions: string[];
}

interface ReviewQueueRow {
  id: string;
  loanId: string | null;
  employeeId: string | null;
  employeeName: string | null;
  employerId: string | null;
  employerName: string | null;
  amount: number | null;
  requestedAt: unknown;
  status: string;
  underwritingDecision: UnderwritingSummary | null;
}

interface GetReviewQueueResult {
  reviews: ReviewQueueRow[];
  // Collection-wide totals per status — NOT a total for the page in `reviews`.
  // Null when the aggregation failed: the list is still useful without it, and a
  // missing count must render as "unknown", never as 0. 0 is a claim about work.
  counts: Record<string, number> | null;
  nextCursor: string | null;
}

// Fail-soft: loans created before PR #393 shipped have no `underwritingDecision`
// field at all — never throw over its absence, just surface null to the client.
function summarizeUnderwriting(loan: Record<string, unknown> | null): UnderwritingSummary | null {
  const uw = loan?.['underwritingDecision'] as Record<string, unknown> | undefined;
  if (!uw) return null;

  const conditions = Array.isArray(uw['conditions'])
    ? (uw['conditions'] as Record<string, unknown>[])
    : [];
  const passed = conditions.filter((c) => c['pass'] === true).length;
  const failedConditions = conditions
    .filter((c) => c['pass'] !== true)
    .map((c) => (typeof c['name'] === 'string' ? (c['name'] as string) : 'unknown'));

  return {
    decision: typeof uw['decision'] === 'string' ? (uw['decision'] as string) : null,
    allPass: typeof uw['allPass'] === 'boolean' ? (uw['allPass'] as boolean) : null,
    conditions: { passed, total: conditions.length },
    failedConditions,
  };
}

export const getReviewQueue = onCall(
  { cors: true, enforceAppCheck: true },
  withAuth<GetReviewQueueData, GetReviewQueueResult>(
    ['ops', 'admin', 'super_admin'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'getReviewQueue', uid: auth.uid }, async () => {
        // Rate limit: 60/min/uid (read-only list view)
        try {
          const allowed = await checkRateLimit(`rl:getReviewQueue:${auth.uid}`, 60, 60);
          if (!allowed) {
            throw new HttpsError('resource-exhausted', 'Rate limit exceeded, please retry in a minute');
          }
        } catch (e: unknown) {
          if (e instanceof HttpsError) throw e;
          logger.warn('Rate limiter unavailable', { error: (e as Error).message, service: 'functions' });
        }

        const db = getFirestore();

        const rawLimit = typeof data?.limit === 'number' && Number.isFinite(data.limit) ? data.limit : DEFAULT_LIMIT;
        const limit = Math.min(Math.max(1, Math.floor(rawLimit)), MAX_LIMIT);

        const status = typeof data?.status === 'string' && data.status.trim().length > 0 ? data.status.trim() : null;

        let query = status
          ? db.collection('review_queue').where('status', '==', status)
          : db.collection('review_queue').where('status', 'in', OPEN_STATUSES);
        query = query.orderBy('queuedAt', 'desc').limit(limit);

        if (data?.startAfter) {
          const cursorSnap = await db.collection('review_queue').doc(data.startAfter).get();
          if (cursorSnap.exists) {
            query = query.startAfter(cursorSnap);
          }
        }

        const querySnap = await query.get();
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

        const reviews: ReviewQueueRow[] = reviewDocs.map((doc) => {
          const review = doc.data() as Record<string, unknown>;
          const loanId = typeof review['loanId'] === 'string' ? (review['loanId'] as string) : null;
          const loan = loanId ? loanById.get(loanId) ?? null : null;

          return {
            id: doc.id,
            loanId,
            employeeId: (loan?.['employeeId'] as string) ?? null,
            employeeName: (loan?.['employeeName'] as string) ?? (review['applicantName'] as string) ?? null,
            employerId: (loan?.['employerId'] as string) ?? null,
            employerName: (loan?.['employerName'] as string) ?? null,
            amount: typeof loan?.['amount'] === 'number' ? (loan['amount'] as number) : null,
            requestedAt: review['queuedAt'] ?? null,
            status: review['status'] as string,
            underwritingDecision: summarizeUnderwriting(loan),
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

        return { reviews, counts, nextCursor };
      })
  )
);
