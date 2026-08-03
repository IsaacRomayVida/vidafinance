import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { validateInput } from '../utils/validateInput';
import { checkRateLimit } from '../utils/rateLimiter';
import { AUDIT_LOG_COLLECTION, buildAuditLogDocument } from '../utils/auditLog';
import { LOAN_STATUS } from './loanStatus';

// NOT DEPLOYED — not exported from index.ts / not in deploy.yml's FUNCTIONS
// list. The live `updateLoanStatus` callable is the one inline in index.ts,
// which is deliberately permissive (any status string, gated only by the
// DISBURSEMENT_INITIATED_STATUSES/PRE_DISBURSEMENT_STATUSES rewind guard in
// loanStatusTransitions.ts — see the P0-B comment on onLoanApproved) because
// ops needs to set the handful of ops-only terminal statuses
// (in_collections, written_off, cancelled) that no automated pipeline writes.
// This stricter, enum-validated variant is kept as the reference for a
// planned consolidation, and its enum/transition table are pinned to the
// canonical vocabulary in `./loanStatus` so the two do not drift again.
const UpdateLoanStatusSchema = z.object({
  loanId: z.string().min(1),
  newStatus: z.enum([
    LOAN_STATUS.APPROVED,
    LOAN_STATUS.DISBURSED,
    LOAN_STATUS.REPAID,
    LOAN_STATUS.OVERDUE,
    LOAN_STATUS.IN_COLLECTIONS,
    LOAN_STATUS.WRITTEN_OFF,
    LOAN_STATUS.CANCELLED,
  ]),
  reason: z.string().min(10).max(500, 'Reason required (10-500 chars)'),
  notes: z.string().max(1000).optional(),
});

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  [LOAN_STATUS.PENDING]: [LOAN_STATUS.CANCELLED],
  [LOAN_STATUS.APPROVED]: [LOAN_STATUS.CANCELLED, LOAN_STATUS.DISBURSED],
  [LOAN_STATUS.DISBURSED]: [LOAN_STATUS.REPAID, LOAN_STATUS.OVERDUE],
  [LOAN_STATUS.OVERDUE]: [LOAN_STATUS.IN_COLLECTIONS, LOAN_STATUS.REPAID, LOAN_STATUS.WRITTEN_OFF],
  [LOAN_STATUS.IN_COLLECTIONS]: [LOAN_STATUS.REPAID, LOAN_STATUS.WRITTEN_OFF],
};

export const updateLoanStatus = onCall(
  { enforceAppCheck: true },
  withAuth(['ops', 'admin', 'super_admin'], async (data, auth) =>
    withErrorHandling({ functionName: 'updateLoanStatus', uid: auth.uid }, async () => {
      // Rate limit: 20/min/uid (mutation)
      try {
        const allowed = await checkRateLimit(`rl:updateLoanStatus:${auth.uid}`, 20, 60);
        if (!allowed) {
          throw new HttpsError('resource-exhausted', 'Rate limit exceeded, please retry in a minute');
        }
      } catch (e: unknown) {
        if (e instanceof HttpsError) throw e;
        logger.warn('Rate limiter unavailable', { error: (e as Error).message, service: 'functions' });
      }

      const input = validateInput(UpdateLoanStatusSchema, data);
      const db = getFirestore();
      const now = Timestamp.now();

      const loanRef = db.collection('loans').doc(input.loanId);
      const loanDoc = await loanRef.get();

      if (!loanDoc.exists) {
        throw new HttpsError('not-found', `Loan ${input.loanId} not found`);
      }

      const loan = loanDoc.data()!;
      const previousStatus = loan['status'] as string;

      if (!ALLOWED_TRANSITIONS[previousStatus]?.includes(input.newStatus)) {
        throw new HttpsError(
          'failed-precondition',
          `Cannot transition loan from '${previousStatus}' to '${input.newStatus}'`
        );
      }

      const logRef = db.collection(AUDIT_LOG_COLLECTION).doc();

      await db.runTransaction(async (txn) => {
        txn.update(loanRef, {
          status: input.newStatus,
          updatedAt: now,
          statusHistory: FieldValue.arrayUnion({
            from: previousStatus,
            to: input.newStatus,
            at: now,
            by: auth.uid,
            reason: input.reason,
          }),
        });
        txn.set(
          logRef,
          buildAuditLogDocument(
            {
              action: 'loan.status_update',
              actorUid: auth.uid,
              actorRole: auth.role,
              actorEmail: auth.email ?? null,
              targetId: input.loanId,
              before: { status: previousStatus },
              after: { status: input.newStatus },
              meta: { entityType: 'loan', reason: input.reason, notes: input.notes ?? null },
            },
            now
          )
        );
      });

      return {
        success: true,
        loanId: input.loanId,
        previousStatus,
        newStatus: input.newStatus,
      };
    })
  )
);
