import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { z } from 'zod';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { ALLOWED_ORIGINS } from '../utils/cors';

const AdminClaimSchema = z.object({
  targetUid: z.string().min(1),
  role: z.enum(['employee', 'employer_admin', 'ops', 'admin']),
});

const RevokeClaimSchema = z.object({
  targetUid: z.string().min(1),
});

export type SetAdminClaimInput = z.infer<typeof AdminClaimSchema>;
export type RevokeAdminClaimInput = z.infer<typeof RevokeClaimSchema>;

export interface AdminClaimResult {
  success: boolean;
  targetUid: string;
  role: string;
}

export const setAdminClaim = onCall(
  { cors: ALLOWED_ORIGINS, enforceAppCheck: true },
  withAuth<SetAdminClaimInput, AdminClaimResult>(
    ['admin', 'super_admin'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'setAdminClaim', uid: auth.uid }, async () => {
        const parseResult = AdminClaimSchema.safeParse(data);
        if (!parseResult.success) {
          throw new HttpsError(
            'invalid-argument',
            parseResult.error.issues[0]?.message ?? 'Invalid input'
          );
        }
        const { targetUid, role } = parseResult.data;

        if (targetUid === auth.uid && role !== 'admin') {
          throw new HttpsError('failed-precondition', 'Cannot change your own role');
        }

        await getAuth().setCustomUserClaims(targetUid, { role });

        const db = getFirestore();
        const now = Timestamp.now();

        await db.collection('users').doc(targetUid).update({
          role,
          updatedAt: now,
        });

        await db.collection('auditLogs').add({
          action: 'admin.setRole',
          entityType: 'user',
          entityId: targetUid,
          performedBy: auth.uid,
          performedByEmail: auth.email,
          metadata: { newRole: role },
          timestamp: now,
        });

        return { success: true, targetUid, role };
      })
  )
);

export const revokeAdminClaim = onCall(
  { cors: ALLOWED_ORIGINS, enforceAppCheck: true },
  withAuth<RevokeAdminClaimInput, AdminClaimResult>(
    ['admin', 'super_admin'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'revokeAdminClaim', uid: auth.uid }, async () => {
        const parseResult = RevokeClaimSchema.safeParse(data);
        if (!parseResult.success) {
          throw new HttpsError(
            'invalid-argument',
            parseResult.error.issues[0]?.message ?? 'Invalid input'
          );
        }
        const { targetUid } = parseResult.data;

        if (targetUid === auth.uid) {
          throw new HttpsError('failed-precondition', 'Cannot revoke your own admin role');
        }

        await getAuth().setCustomUserClaims(targetUid, { role: 'employee' });

        const db = getFirestore();
        const now = Timestamp.now();

        await db.collection('users').doc(targetUid).update({
          role: 'employee',
          updatedAt: now,
        });

        await db.collection('auditLogs').add({
          action: 'admin.revokeRole',
          entityType: 'user',
          entityId: targetUid,
          performedBy: auth.uid,
          performedByEmail: auth.email,
          metadata: { previousRole: 'admin', newRole: 'employee' },
          timestamp: now,
        });

        return { success: true, targetUid, role: 'employee' };
      })
  )
);
