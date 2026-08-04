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

        const now = Timestamp.now();

        // Every gate below is evaluated against the TRANSACTION's snapshot, not
        // against a plain read taken beforehand. A Firestore transaction only
        // detects conflicts on documents it actually read, so validating the
        // invite outside the transaction and then writing inside one gave no
        // isolation at all: two redemptions racing each other both saw
        // status:'pending' and both committed. Redemption is a state transition
        // on the invite, so the invite has to be in the read set.
        const { employerId, employeeDocId } = await db.runTransaction(async (txn) => {
          const inviteSnap = await txn.get(inviteRef);
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

          const txnEmployerId = invite['employerId'] as string;
          const txnEmployeeDocId = invite['employeeDocId'] as string;

          const employeeRef = db
            .collection('employers')
            .doc(txnEmployerId)
            .collection('employees')
            .doc(txnEmployeeDocId);
          const employeeSnap = await txn.get(employeeRef);
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

          // One roster row belongs to exactly one account. sendEmployeeInvite
          // already refuses to mint an invite for a row that carries an authUid;
          // this is the other half of that invariant. Without it, any invite
          // still pending when the row was claimed — the Resend button mints a
          // second one without retiring the first — could be redeemed later and
          // silently re-point the employer's roster entry at a different uid,
          // with no way for the admin to re-invite the rightful employee.
          const linkedUid = employee['authUid'] as string | undefined;
          if (linkedUid && linkedUid !== auth.uid) {
            throw new HttpsError(
              'failed-precondition',
              'This employee record is already linked to another account'
            );
          }

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

          return { employerId: txnEmployerId, employeeDocId: txnEmployeeDocId };
        });

        return { success: true, employerId, employeeDocId };
      })
  )
);
