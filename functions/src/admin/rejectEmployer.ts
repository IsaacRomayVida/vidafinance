import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { validateInput } from '../utils/validateInput';

const RejectEmployerSchema = z.object({
  employerUid: z.string().min(1),
  reason: z.string().min(10, 'Reason must be at least 10 characters').max(500),
});

export const rejectEmployer = onCall(
  { enforceAppCheck: true },
  withAuth(['admin', 'super_admin'], async (data, auth) =>
    withErrorHandling({ functionName: 'rejectEmployer', uid: auth.uid }, async () => {
      const input = validateInput(RejectEmployerSchema, data);
      const db = getFirestore();
      const now = Timestamp.now();

      const empDoc = await db.collection('employers').doc(input.employerUid).get();
      if (!empDoc.exists) {
        throw new HttpsError('not-found', 'Employer not found');
      }

      const emp = empDoc.data()!;
      const previousStatus = emp['status'] as string;

      if (!['pending_verification', 'active'].includes(previousStatus)) {
        throw new HttpsError(
          'failed-precondition',
          `Cannot reject employer with status '${previousStatus}'`
        );
      }

      const logRef = db.collection('auditLogs').doc();

      await db.runTransaction(async (txn) => {
        txn.update(db.collection('employers').doc(input.employerUid), {
          status: 'rejected',
          rejectionReason: input.reason,
          rejectedAt: now,
          rejectedBy: auth.uid,
        });
        txn.set(logRef, {
          logId: logRef.id,
          action: 'employer.rejected',
          entityType: 'employer',
          entityId: input.employerUid,
          performedBy: auth.uid,
          performedByEmail: auth.email,
          previousState: { status: previousStatus },
          newState: { status: 'rejected' },
          metadata: { reason: input.reason },
          timestamp: now,
        });
      });

      // Write legacy audit_log entry too
      try {
        await db.collection('audit_log').add({
          action: 'employer.rejected',
          actorUid: auth.uid,
          actorRole: auth.role,
          targetCollection: 'employers',
          targetId: input.employerUid,
          before: { status: previousStatus },
          after: { status: 'rejected', rejectionReason: input.reason },
          meta: { reason: input.reason },
          timestamp: FieldValue.serverTimestamp(),
        });
      } catch (_) { /* non-critical */ }

      return { success: true, employerUid: input.employerUid, status: 'rejected' };
    })
  )
);
