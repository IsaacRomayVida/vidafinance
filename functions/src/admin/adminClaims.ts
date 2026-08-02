import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { z } from 'zod';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { AUDIT_LOG_COLLECTION, buildAuditLogDocument } from '../utils/auditLog';

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
  { enforceAppCheck: true },
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

        const db = getFirestore();
        const now = Timestamp.now();

        const userRef = db.collection('users').doc(targetUid);
        const previousRole = (await userRef.get()).data()?.['role'] ?? null;

        // Record the grant BEFORE the claim is minted, atomically with the role
        // field on the user document. If the audit write fails the transaction
        // aborts and setCustomUserClaims is never reached — no privilege is
        // escalated without a durable record of who escalated it.
        await db.runTransaction(async (txn) => {
          txn.update(userRef, { role, updatedAt: now });
          txn.set(
            db.collection(AUDIT_LOG_COLLECTION).doc(),
            buildAuditLogDocument(
              {
                action: 'admin.setRole',
                actorUid: auth.uid,
                actorRole: auth.role,
                actorEmail: auth.email ?? null,
                targetId: targetUid,
                before: { role: previousRole },
                after: { role },
                meta: { entityType: 'user', newRole: role },
              },
              now
            )
          );
        });

        await getAuth().setCustomUserClaims(targetUid, { role });

        return { success: true, targetUid, role };
      })
  )
);

export const revokeAdminClaim = onCall(
  { enforceAppCheck: true },
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

        const db = getFirestore();
        const now = Timestamp.now();

        const userRef = db.collection('users').doc(targetUid);
        const previousRole = (await userRef.get()).data()?.['role'] ?? null;

        // Same ordering as setAdminClaim: the audit record commits atomically with
        // the role field, and only then is the claim changed. A revoke that cannot
        // be logged does not happen.
        await db.runTransaction(async (txn) => {
          txn.update(userRef, { role: 'employee', updatedAt: now });
          txn.set(
            db.collection(AUDIT_LOG_COLLECTION).doc(),
            buildAuditLogDocument(
              {
                action: 'admin.revokeRole',
                actorUid: auth.uid,
                actorRole: auth.role,
                actorEmail: auth.email ?? null,
                targetId: targetUid,
                before: { role: previousRole },
                after: { role: 'employee' },
                meta: { entityType: 'user', newRole: 'employee' },
              },
              now
            )
          );
        });

        await getAuth().setCustomUserClaims(targetUid, { role: 'employee' });

        return { success: true, targetUid, role: 'employee' };
      })
  )
);
