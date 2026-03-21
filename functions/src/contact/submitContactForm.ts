import { onCall } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';

import { withErrorHandling } from '../utils/errorHandler';
import { validateInput } from '../utils/validateInput';

const ContactFormSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  phone: z.string().max(20).optional(),
  subject: z.enum(['general', 'support', 'employer_inquiry', 'partnership', 'complaint']),
  message: z.string().min(10).max(2000),
});

export const submitContactForm = onCall(
  { cors: true, enforceAppCheck: false },
  async (request) => {
    return withErrorHandling({ functionName: 'submitContactForm' }, async () => {
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
