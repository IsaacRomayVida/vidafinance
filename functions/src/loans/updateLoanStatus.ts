import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { validateInput } from '../utils/validateInput';
import { CORS_ORIGINS } from '../utils/corsOrigins';

const UpdateLoanStatusSchema = z.object({
  loanId: z.string().min(1),
  newStatus: z.enum([
    'approved',
    'pending_signature',
    'disbursed',
    'repaid',
    'overdue',
    'in_collections',
    'written_off',
    'cancelled',
  ]),
  reason: z.string().min(10).max(500, 'Reason required (10-500 chars)'),
  notes: z.string().max(1000).optional(),
});

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  pending: ['cancelled'],
  approved: ['pending_signature', 'cancelled', 'disbursed'],
  pending_signature: ['disbursed', 'cancelled'],
  disbursed: ['repaid', 'overdue'],
  overdue: ['in_collections', 'repaid', 'written_off'],
  in_collections: ['repaid', 'written_off'],
};

export const updateLoanStatus = onCall(
  { cors: CORS_ORIGINS, enforceAppCheck: true },
  withAuth(['ops', 'admin', 'super_admin'], async (data, auth) =>
    withErrorHandling({ functionName: 'updateLoanStatus', uid: auth.uid }, async () => {
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

      const logRef = db.collection('auditLogs').doc();

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
        txn.set(logRef, {
          logId: logRef.id,
          action: 'loan.status_update',
          entityType: 'loan',
          entityId: input.loanId,
          performedBy: auth.uid,
          performedByEmail: auth.email,
          previousState: { status: previousStatus },
          newState: { status: input.newStatus },
          metadata: { reason: input.reason, notes: input.notes ?? null },
          timestamp: now,
        });
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
