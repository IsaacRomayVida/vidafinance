import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { z } from 'zod';

import { withAuth, type AuthContext } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { AUDIT_LOG_COLLECTION, buildAuditLogDocument } from '../utils/auditLog';

const SUPER_ADMIN: AuthContext['role'] = 'super_admin';

/**
 * Refuses any role change aimed at a super_admin unless the actor is one too.
 *
 * Both callables gate on ['admin', 'super_admin'] and neither used to look at
 * what the TARGET already was, so an `admin` could mint a super_admin a
 * `{ role: 'employee' }` claim. `admin` is grantable in-product by any other
 * admin, and a stale legacy `admin: true` token resolves to it as well, so one
 * compromised admin account was enough to leave the product with no role above
 * the attacker's — recoverable only by an operator running
 * scripts/bootstrap-super-admin.js out of band.
 *
 * The target's role is read from BOTH sources of truth. The custom claim is what
 * actually authorizes the target's own requests; the users/{uid} mirror is what
 * the console renders and what this file writes first. They can legitimately
 * disagree mid-flight, so either one reading super_admin is enough. Under-reading
 * the target's role is precisely the bug being fixed, so this fails closed: a
 * target whose auth record cannot be read is refused rather than assumed unprivileged.
 */
async function assertTargetIsNotProtected(
  targetUid: string,
  actor: AuthContext,
  mirrorRole: string | null
): Promise<void> {
  let claimRole: string | null;
  try {
    const targetUser = await getAuth().getUser(targetUid);
    claimRole = (targetUser.customClaims?.['role'] as string | undefined) ?? null;
  } catch {
    throw new HttpsError('not-found', `No auth record for user ${targetUid}`);
  }

  const targetIsSuperAdmin = claimRole === SUPER_ADMIN || mirrorRole === SUPER_ADMIN;
  if (targetIsSuperAdmin && actor.role !== SUPER_ADMIN) {
    throw new HttpsError(
      'permission-denied',
      "Only a super_admin can change another super_admin's role"
    );
  }
}

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

        // Compared against the actor's OWN effective role, not the literal
        // 'admin'. The old form let a super_admin hand themselves `role: 'admin'`
        // and drop the one role this API cannot grant back — a self-demotion
        // wearing a no-op's clothes.
        if (targetUid === auth.uid && role !== auth.role) {
          throw new HttpsError('failed-precondition', 'Cannot change your own role');
        }

        const db = getFirestore();
        const now = Timestamp.now();

        const userRef = db.collection('users').doc(targetUid);
        const previousRole = (await userRef.get()).data()?.['role'] ?? null;

        await assertTargetIsNotProtected(targetUid, auth, previousRole);

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

        await assertTargetIsNotProtected(targetUid, auth, previousRole);

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
