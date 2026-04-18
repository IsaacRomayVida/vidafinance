import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { createHash } from 'crypto';
import { z } from 'zod';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { checkRateLimit } from '../utils/rateLimiter';

const AcceptInviteSchema = z.object({
  inviteId: z.string().min(1),
  token: z.string().min(32),
});

export type AcceptInviteInput = z.infer<typeof AcceptInviteSchema>;

export interface AcceptInviteResult {
  success: boolean;
  employerId: string;
  employeeDocId: string;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export const acceptInvite = onCall(
  { enforceAppCheck: true },
  withAuth<AcceptInviteInput, AcceptInviteResult>(
    [],
    async (data, auth) =>
      withErrorHandling({ functionName: 'acceptInvite', uid: auth.uid }, async () => {
        // Rate limit: 20/min/uid (mutation — invite acceptance)
        try {
          const allowed = await checkRateLimit(`rl:acceptInvite:${auth.uid}`, 20, 60);
          if (!allowed) {
            throw new HttpsError('resource-exhausted', 'Rate limit exceeded, please retry in a minute');
          }
        } catch (e: unknown) {
          if (e instanceof HttpsError) throw e;
          logger.warn('Rate limiter unavailable', { error: (e as Error).message, service: 'functions' });
        }

        const parsed = AcceptInviteSchema.safeParse(data);
        if (!parsed.success) {
          throw new HttpsError(
            'invalid-argument',
            parsed.error.issues[0]?.message ?? 'Invalid input'
          );
        }
        const { inviteId, token } = parsed.data;

        const db = getFirestore();
        const inviteRef = db.collection('invites').doc(inviteId);
        const inviteSnap = await inviteRef.get();

        if (!inviteSnap.exists) {
          throw new HttpsError('not-found', 'Invite not found');
        }
        const invite = inviteSnap.data() ?? {};

        if (invite['status'] !== 'pending') {
          throw new HttpsError('failed-precondition', 'Invite is not pending');
        }
        const expiresAt = invite['expiresAt'] as FirebaseFirestore.Timestamp | undefined;
        if (!expiresAt || expiresAt.toMillis() < Date.now()) {
          throw new HttpsError('failed-precondition', 'Invite has expired');
        }
        if (invite['tokenHash'] !== sha256Hex(token)) {
          throw new HttpsError('permission-denied', 'Invalid invite token');
        }

        const employerId = invite['employerId'] as string;
        const employeeDocId = invite['employeeDocId'] as string;

        const employeeRef = db
          .collection('employers')
          .doc(employerId)
          .collection('employees')
          .doc(employeeDocId);
        const employeeSnap = await employeeRef.get();
        if (!employeeSnap.exists) {
          throw new HttpsError('not-found', 'Employee record not found');
        }

        const employee = employeeSnap.data() ?? {};
        const invitedEmail = ((employee['email'] as string | undefined) ?? '')
          .trim()
          .toLowerCase();
        const callerEmail = (auth.email ?? '').trim().toLowerCase();
        if (!invitedEmail || !callerEmail || invitedEmail !== callerEmail) {
          throw new HttpsError('permission-denied', 'Invite does not match your account');
        }

        const now = Timestamp.now();
        await db.runTransaction(async (txn) => {
          txn.update(employeeRef, {
            authUid: auth.uid,
            signupCompletedAt: FieldValue.serverTimestamp(),
            status: 'active',
            updatedAt: now,
          });
          txn.update(inviteRef, {
            status: 'accepted',
            acceptedAt: FieldValue.serverTimestamp(),
            acceptedByUid: auth.uid,
          });
        });

        return { success: true, employerId, employeeDocId };
      })
  )
);
