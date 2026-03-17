import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { generateEmployerCode } from './approveEmployer';

export const regenerateEmployerCode = onCall(
  { enforceAppCheck: true },
  withAuth(['employer_admin'], async (_data, auth) =>
    withErrorHandling({ functionName: 'regenerateEmployerCode', uid: auth.uid }, async () => {
      const db = getFirestore();
      const employerId = auth.employerId;

      if (!employerId) {
        throw new HttpsError('failed-precondition', 'No employerId associated with this account');
      }

      const employerDoc = await db.collection('employers').doc(employerId).get();
      if (!employerDoc.exists) {
        throw new HttpsError('not-found', 'Employer not found');
      }

      const employer = employerDoc.data()!;
      const oldCode = employer['employerCode'] as string | undefined;
      const newCode = await generateEmployerCode(db, (employer['industry'] as string) || 'general');

      await db.collection('employers').doc(employerId).update({
        employerCode: newCode,
        updatedAt: FieldValue.serverTimestamp(),
      });

      try {
        await db.collection('audit_log').add({
          action: 'employer.code_regenerated',
          actorUid: auth.uid,
          actorRole: 'employer_admin',
          targetId: employerId,
          before: { employerCode: oldCode ?? null },
          after: { employerCode: newCode },
          timestamp: FieldValue.serverTimestamp(),
        });
      } catch (_) {
        /* non-critical */
      }

      return { employerCode: newCode };
    })
  )
);
