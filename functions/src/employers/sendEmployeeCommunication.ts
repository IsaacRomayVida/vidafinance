import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { Queue } from 'bullmq';
import { z } from 'zod';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';

const SendCommunicationSchema = z.object({
  subject: z.string().min(1).max(200),
  message: z.string().min(1).max(2000),
  channel: z.enum(['email', 'sms', 'both']),
  recipientType: z.enum(['all', 'active_loan', 'no_loan']),
});

type SendCommunicationData = z.infer<typeof SendCommunicationSchema>;

function getNotificationQueue(): Queue {
  const redisUrl = process.env['REDIS_URL'] ?? '';
  return new Queue('vida-notifications', {
    connection: {
      url: redisUrl,
      ...(redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
    },
  });
}

export const sendEmployeeCommunication = onCall(
  { enforceAppCheck: true },
  withAuth(['employer_admin'], async (data: SendCommunicationData, auth) =>
    withErrorHandling(
      { functionName: 'sendEmployeeCommunication', uid: auth.uid },
      async () => {
        const db = getFirestore();
        const employerId = auth.employerId;

        if (!employerId) {
          throw new HttpsError(
            'failed-precondition',
            'No employerId associated with this account'
          );
        }

        const validation = SendCommunicationSchema.safeParse(data);
        if (!validation.success) {
          throw new HttpsError('invalid-argument', validation.error.issues[0].message);
        }
        const { subject, message, channel, recipientType } = validation.data;

        // Fetch all active employees
        const employeesSnap = await db
          .collection('employees')
          .where('employerId', '==', employerId)
          .where('active', '==', true)
          .get();

        type EmployeeRecord = Record<string, unknown> & { id: string };
        let recipients: EmployeeRecord[] = employeesSnap.docs.map((d) => ({ id: d.id, ...d.data() } as EmployeeRecord));

        // Filter by recipient type
        if (recipientType !== 'all') {
          const activeLoansSnap = await db
            .collection('loans')
            .where('employerId', '==', employerId)
            .where('status', 'in', ['disbursed', 'overdue'])
            .get();

          const employeesWithActiveLoans = new Set(
            activeLoansSnap.docs.map((d) => d.data()['employeeId'] as string)
          );

          recipients =
            recipientType === 'active_loan'
              ? recipients.filter((e) => employeesWithActiveLoans.has(e.id))
              : recipients.filter((e) => !employeesWithActiveLoans.has(e.id));
        }

        if (recipients.length === 0) {
          return { sent: 0, total: 0, message: 'No recipients found for the given criteria' };
        }

        let sentCount = 0;
        let queue: Queue | null = null;

        try {
          queue = getNotificationQueue();
        } catch (_) {
          /* queue unavailable — log and skip */
        }

        for (const employee of recipients) {
          try {
            if (queue) {
              if (channel === 'email' || channel === 'both') {
                await queue.add('employer_broadcast_email', {
                  type: 'employer_broadcast_email',
                  employeeId: employee['id'],
                  email: employee['email'],
                  name: employee['name'],
                  subject,
                  message,
                  employerId,
                });
              }
              if ((channel === 'sms' || channel === 'both') && employee['phone']) {
                await queue.add('employer_broadcast_sms', {
                  type: 'employer_broadcast_sms',
                  employeeId: employee['id'],
                  phone: employee['phone'],
                  name: employee['name'],
                  message,
                  employerId,
                });
              }
            }
            sentCount++;
          } catch (_) {
            /* non-critical — continue with remaining recipients */
          }
        }

        try {
          await db.collection('audit_log').add({
            action: 'employer.communication_sent',
            actorUid: auth.uid,
            actorRole: 'employer_admin',
            targetId: employerId,
            meta: { subject, channel, recipientType, sentCount, totalRecipients: recipients.length },
            timestamp: FieldValue.serverTimestamp(),
          });
        } catch (_) {
          /* non-critical */
        }

        return { sent: sentCount, total: recipients.length };
      }
    )
  )
);
