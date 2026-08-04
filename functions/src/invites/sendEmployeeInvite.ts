import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { createHash } from 'crypto';
import { nanoid } from 'nanoid';
import { Queue } from 'bullmq';
import { z } from 'zod';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { checkRateLimit } from '../utils/rateLimiter';

const SendEmployeeInviteSchema = z.object({
  employerId: z.string().min(1),
  employeeDocId: z.string().min(1),
});

export type SendEmployeeInviteInput = z.infer<typeof SendEmployeeInviteSchema>;

export interface SendEmployeeInviteResult {
  success: boolean;
  inviteId: string;
  sentAt: string;
}

const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const INVITE_BASE_URL = 'https://app.vidafinance.mx/signup';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function getNotificationQueue(): Queue {
  const redisUrl = process.env['REDIS_URL'] ?? '';
  return new Queue('vida-notifications', {
    connection: {
      url: redisUrl,
      ...(redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
    },
  });
}

export const sendEmployeeInvite = onCall(
  { enforceAppCheck: true },
  withAuth<SendEmployeeInviteInput, SendEmployeeInviteResult>(
    ['employer_admin'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'sendEmployeeInvite', uid: auth.uid }, async () => {
        // Rate limit: 20/min/uid (mutation — sends outbound email/notification)
        try {
          const allowed = await checkRateLimit(`rl:sendEmployeeInvite:${auth.uid}`, 20, 60);
          if (!allowed) {
            throw new HttpsError('resource-exhausted', 'Rate limit exceeded, please retry in a minute');
          }
        } catch (e: unknown) {
          if (e instanceof HttpsError) throw e;
          logger.warn('Rate limiter unavailable', { error: (e as Error).message, service: 'functions' });
        }

        const parsed = SendEmployeeInviteSchema.safeParse(data);
        if (!parsed.success) {
          throw new HttpsError(
            'invalid-argument',
            parsed.error.issues[0]?.message ?? 'Invalid input'
          );
        }
        const { employerId, employeeDocId } = parsed.data;

        // An employer_admin is scoped to their own employer record. For this product
        // an employer's uid *is* the employer doc id; employerId on the claim is the
        // fallback when the two ever diverge.
        const ownsEmployer = auth.uid === employerId || auth.employerId === employerId;
        if (!ownsEmployer) {
          throw new HttpsError('permission-denied', 'Not authorized for this employer');
        }

        const db = getFirestore();
        const employerRef = db.collection('employers').doc(employerId);
        const employeeRef = employerRef.collection('employees').doc(employeeDocId);
        const employeeSnap = await employeeRef.get();

        if (!employeeSnap.exists) {
          throw new HttpsError('not-found', 'Employee not found');
        }
        const employee = employeeSnap.data() ?? {};
        const email = employee['email'] as string | undefined;
        const name = employee['name'] as string | undefined;
        if (!email || !name) {
          throw new HttpsError(
            'failed-precondition',
            'Employee missing required fields (email, name)'
          );
        }

        const status = employee['status'] as string | undefined;
        if (status === 'active' || employee['authUid']) {
          throw new HttpsError('already-exists', 'Employee already has an active account');
        }

        const employerSnap = await employerRef.get();
        const employerName =
          (employerSnap.data()?.['companyName'] as string | undefined) ?? '';

        const rawToken = nanoid(32);
        const tokenHash = sha256Hex(rawToken);
        const inviteId = nanoid(16);
        const createdAt = Timestamp.now();
        const expiresAt = Timestamp.fromDate(new Date(Date.now() + INVITE_TTL_MS));

        // Minting a new link retires every link already outstanding for this
        // employee. The roster's Resend button just calls this function again,
        // and the UI already assumes a single live invite per employee (it
        // collapses invitesByEmployee to the newest by sentAt) — but nothing
        // retired the older documents, so a link an admin believed they had
        // replaced stayed redeemable for the rest of its 30-day TTL.
        const priorInvites = await db
          .collection('invites')
          .where('employerId', '==', employerId)
          .where('employeeDocId', '==', employeeDocId)
          .where('status', '==', 'pending')
          .get();

        if (!priorInvites.empty) {
          const batch = db.batch();
          for (const prior of priorInvites.docs) {
            batch.update(prior.ref, {
              status: 'superseded',
              supersededAt: FieldValue.serverTimestamp(),
            });
          }
          await batch.commit();
          logger.info('Superseded prior pending invites', {
            employerId,
            employeeDocId,
            count: priorInvites.size,
            service: 'functions',
          });
        }

        const inviteRef = db.collection('invites').doc(inviteId);
        await inviteRef.set({
          employerId,
          employeeDocId,
          tokenHash,
          status: 'pending',
          createdAt,
          expiresAt,
          sentAt: null,
          clickedAt: null,
          acceptedAt: null,
          acceptedByUid: null,
        });

        const inviteUrl = `${INVITE_BASE_URL}?invite=${rawToken}`;

        try {
          await getNotificationQueue().add('employee_invite', {
            type: 'employee_invite',
            email,
            name,
            employerName,
            inviteToken: rawToken,
            inviteUrl,
          });
        } catch (e: unknown) {
          logger.warn('Notification queue unavailable for employee invite', {
            error: (e as Error).message,
            service: 'functions',
          });
        }

        const sentAt = Timestamp.now();
        await inviteRef.update({ sentAt: FieldValue.serverTimestamp() });

        return {
          success: true,
          inviteId,
          sentAt: sentAt.toDate().toISOString(),
        };
      })
  )
);
