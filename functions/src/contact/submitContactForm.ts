import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';

import { withErrorHandling } from '../utils/errorHandler';
import { validateInput } from '../utils/validateInput';
import { checkRateLimit } from '../utils/rateLimiter';

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
      // Rate limit: 30/min keyed on App Check token (unauth endpoint)
      const appCheckToken =
        (request as unknown as { app?: { appId?: string } }).app?.appId ?? 'anonymous';
      try {
        const allowed = await checkRateLimit(`rl:submitContactForm:${appCheckToken}`, 30, 60);
        if (!allowed) {
          throw new HttpsError('resource-exhausted', 'Rate limit exceeded, please retry in a minute');
        }
      } catch (e: unknown) {
        if (e instanceof HttpsError) throw e;
        logger.warn('Rate limiter unavailable', { error: (e as Error).message, service: 'functions' });
      }

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
