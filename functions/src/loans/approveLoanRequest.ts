import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';

import { withAuth, AuthContext } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { ALLOWED_ORIGINS } from '../utils/cors';
import { validateInput } from '../utils/validateInput';

const ApproveLoanSchema = z.object({
  loanId: z.string().min(1, 'loanId is required'),
});

export const approveLoanRequest = onCall(
  { cors: ALLOWED_ORIGINS, enforceAppCheck: true },
  withAuth(['employer_admin', 'ops', 'admin', 'super_admin'], async (data, auth: AuthContext) =>
    withErrorHandling({ functionName: 'approveLoanRequest', uid: auth.uid }, async () => {
      const input = validateInput(ApproveLoanSchema, data);
      const db = getFirestore();

      const loanRef = db.collection('loans').doc(input.loanId);
      const loanDoc = await loanRef.get();

      if (!loanDoc.exists) {
        throw new HttpsError('not-found', 'Loan not found');
      }

      const loan = loanDoc.data()!;

      // Only the employer who owns this loan or an admin can approve
      const isAdmin = ['admin', 'super_admin', 'ops'].includes(auth.role);
      if (loan['employerId'] !== auth.uid && !isAdmin) {
        throw new HttpsError('permission-denied', 'Not your loan to approve');
      }

      if (loan['status'] !== 'pending') {
        throw new HttpsError('failed-precondition', 'Loan is not in pending status');
      }

      await loanRef.update({
        status: 'approved',
        approvedAt: FieldValue.serverTimestamp(),
      });

      // Audit log (best-effort)
      try {
        await db.collection('auditLogs').add({
          action: 'loan.approved',
          actorUid: auth.uid,
          actorRole: isAdmin ? 'admin' : 'employer',
          targetCollection: 'loans',
          targetId: input.loanId,
          before: { status: 'pending' },
          after: { status: 'approved' },
          timestamp: FieldValue.serverTimestamp(),
        });
      } catch {
        // non-critical
      }

      return { success: true };
    })
  )
);
