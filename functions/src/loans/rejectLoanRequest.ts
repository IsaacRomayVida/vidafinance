import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';

import { withAuth, AuthContext } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { ALLOWED_ORIGINS } from '../utils/cors';
import { validateInput } from '../utils/validateInput';

const RejectLoanSchema = z.object({
  loanId: z.string().min(1, 'loanId is required'),
});

export const rejectLoanRequest = onCall(
  { cors: ALLOWED_ORIGINS, enforceAppCheck: true },
  withAuth(['employer_admin', 'ops', 'admin', 'super_admin'], async (data, auth: AuthContext) =>
    withErrorHandling({ functionName: 'rejectLoanRequest', uid: auth.uid }, async () => {
      const input = validateInput(RejectLoanSchema, data);
      const db = getFirestore();

      const loanRef = db.collection('loans').doc(input.loanId);
      const isAdmin = ['admin', 'super_admin', 'ops'].includes(auth.role);

      // Read loan inside the transaction to prevent race conditions
      await db.runTransaction(async (tx) => {
        const loanDoc = await tx.get(loanRef);

        if (!loanDoc.exists) {
          throw new HttpsError('not-found', 'Loan not found');
        }

        const loanData = loanDoc.data()!;

        if (loanData['employerId'] !== auth.uid && !isAdmin) {
          throw new HttpsError('permission-denied', 'Not your loan to reject');
        }

        if (loanData['status'] !== 'pending') {
          throw new HttpsError('failed-precondition', 'Loan is not in pending status');
        }

        tx.update(loanRef, {
          status: 'rejected',
          rejectedAt: FieldValue.serverTimestamp(),
        });
        tx.update(db.collection('employees').doc(loanData['employeeId'] as string), {
          availableCredit: FieldValue.increment(loanData['amount'] as number),
        });

      });

      // Audit log (best-effort)
      try {
        await db.collection('auditLogs').add({
          action: 'loan.rejected',
          actorUid: auth.uid,
          actorRole: isAdmin ? 'admin' : 'employer',
          targetCollection: 'loans',
          targetId: input.loanId,
          before: { status: 'pending' },
          after: { status: 'rejected' },
          timestamp: FieldValue.serverTimestamp(),
        });
      } catch {
        // non-critical
      }

      return { success: true };
    })
  )
);
