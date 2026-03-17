import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import fetch from 'node-fetch';
import { z } from 'zod';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { CORS_ORIGINS } from '../utils/corsOrigins';

const GeneratePaymentLinkSchema = z.object({
  loanId: z.string().min(1),
});

export type GeneratePaymentLinkInput = z.infer<typeof GeneratePaymentLinkSchema>;

export interface GeneratePaymentLinkResult {
  paymentUrl: string;
  orderId: string;
  expiresIn: string;
}

export const generatePaymentLink = onCall(
  { cors: CORS_ORIGINS, enforceAppCheck: true },
  withAuth<GeneratePaymentLinkInput, GeneratePaymentLinkResult>(
    ['employee'],
    async (data, auth) =>
      withErrorHandling(
        {
          functionName: 'generatePaymentLink',
          uid: auth.uid,
          loanId: (data as Record<string, unknown>)['loanId'] as string,
        },
        async () => {
          const parseResult = GeneratePaymentLinkSchema.safeParse(data);
          if (!parseResult.success) {
            throw new HttpsError(
              'invalid-argument',
              parseResult.error.issues[0]?.message ?? 'Invalid input'
            );
          }
          const input = parseResult.data;

          const db = getFirestore();
          const loanDoc = await db.collection('loans').doc(input.loanId).get();
          if (!loanDoc.exists) {
            throw new HttpsError('not-found', 'Loan not found');
          }

          const loan = loanDoc.data()!;
          const loanUserId = (loan['userId'] as string | undefined) ?? (loan['employeeId'] as string);

          if (loanUserId !== auth.uid) {
            throw new HttpsError('permission-denied', 'Not your loan');
          }

          if (loan['status'] !== 'approved') {
            throw new HttpsError(
              'failed-precondition',
              'Loan must be approved to generate payment link'
            );
          }

          const paymentServerUrl = process.env['PAYMENT_SERVER_URL'];
          if (!paymentServerUrl) {
            throw new HttpsError('internal', 'Payment server not configured');
          }

          const internalSecret = process.env['INTERNAL_SECRET'] ?? process.env['INTERNAL_API_SECRET'] ?? '';

          const response = await fetch(`${paymentServerUrl}/payment-links/oxxo`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-internal-secret': internalSecret,
            },
            body: JSON.stringify({
              loanId: input.loanId,
              amount: (loan['principalAmount'] as number | undefined) ?? (loan['amount'] as number),
              borrowerName:
                (loan['borrowerSnapshot'] as Record<string, unknown> | undefined)?.['fullName'] ??
                loan['employeeName'],
              borrowerEmail: auth.email,
              expiresAt: Date.now() + 24 * 60 * 60 * 1000,
            }),
          });

          if (!response.ok) {
            const errBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
            const errMsg = (errBody['message'] as string | undefined) ?? `Payment server error: ${response.status}`;
            throw new HttpsError('internal', errMsg);
          }

          const { paymentUrl, orderId } = (await response.json()) as {
            paymentUrl: string;
            orderId: string;
          };

          if (!paymentUrl || !orderId) {
            throw new HttpsError('internal', 'Invalid response from payment server');
          }

          await db.collection('loans').doc(input.loanId).update({
            conektaOrderId: orderId,
            paymentLinkUrl: paymentUrl,
            updatedAt: Timestamp.now(),
          });

          return { paymentUrl, orderId, expiresIn: '24 hours' };
        }
      )
  )
);
