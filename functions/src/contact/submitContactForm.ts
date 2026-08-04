import { onCall } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';

import { withErrorHandling } from '../utils/errorHandler';
import { validateInput } from '../utils/validateInput';
import { enforceRateLimit } from '../utils/rateLimiter';

const ContactFormSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  phone: z.string().max(20).optional(),
  subject: z.enum(['general', 'support', 'employer_inquiry', 'partnership', 'complaint']),
  message: z.string().min(10).max(2000),
});

export const submitContactForm = onCall(
  { cors: true, enforceAppCheck: true },
  async (request) => {
    return withErrorHandling({ functionName: 'submitContactForm' }, async () => {
      // Rate limit: 30/min keyed on App Check token (unauth endpoint).
      // Fails CLOSED: unauthenticated and it writes a Firestore document per
      // call, so an outage would turn this into an open write endpoint.
      const appCheckToken =
        (request as unknown as { app?: { appId?: string } }).app?.appId ?? 'anonymous';
      await enforceRateLimit(`rl:submitContactForm:${appCheckToken}`, 30, 60, {
        onUnavailable: 'closed',
        context: 'submitContactForm',
      });

      const input = validateInput(ContactFormSchema, request.data);
      const db = getFirestore();

      const docRef = await db.collection('contact_submissions').add({
        ...input,
        uid: request.auth?.uid ?? null,
        status: 'new',
        createdAt: FieldValue.serverTimestamp(),
      });

      return { success: true, submissionId: docRef.id };
    });
  }
);
