import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { createHash } from 'crypto';
import { z } from 'zod';

import { withErrorHandling } from '../utils/errorHandler';
import { checkRateLimit } from '../utils/rateLimiter';

const LookupInviteSchema = z.object({
  token: z.string().min(32).max(32),
});

export type LookupInviteInput = z.infer<typeof LookupInviteSchema>;

export type LookupInviteResult =
  | { valid: false; reason: 'invalid_or_expired' }
  | {
      valid: true;
      employerName: string;
      employeeName: string;
      employeeEmail: string;
      inviteId: string;
    };

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// Masks an email as "j***@company.com" — always returns at least 3 obfuscation
// chars so short locals (≤1 char) don't leak length information.
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local.charAt(0);
  const stars = '*'.repeat(Math.max(local.length - 1, 3));
  return `${visible}${stars}@${domain}`;
}

export const lookupInvite = onCall(
  { enforceAppCheck: true },
  async (request: {
    data: unknown;
    app?: { appId?: string };
  }): Promise<LookupInviteResult> =>
    withErrorHandling({ functionName: 'lookupInvite' }, async () => {
      const parsed = LookupInviteSchema.safeParse(request.data);
      if (!parsed.success) {
        throw new HttpsError('invalid-argument', 'Invalid token format');
      }
      const { token } = parsed.data;

      const appCheckId = request.app?.appId ?? 'anon';
      try {
        const allowed = await checkRateLimit(`rl:lookupInvite:${appCheckId}`, 10, 60);
        if (!allowed) {
          throw new HttpsError(
            'resource-exhausted',
            'Too many lookup attempts. Please wait.'
          );
        }
      } catch (e: unknown) {
        if (e instanceof HttpsError) throw e;
        logger.warn('Rate limiter unavailable for lookupInvite', {
          error: (e as Error).message,
        });
      }

      const tokenHash = sha256Hex(token);
      const db = getFirestore();
      const snap = await db
        .collection('invites')
        .where('tokenHash', '==', tokenHash)
        .where('status', '==', 'pending')
        .limit(1)
        .get();

      if (snap.empty) {
        return { valid: false, reason: 'invalid_or_expired' };
      }

      const doc = snap.docs[0];
      const invite = doc.data();
      const expiresAt = invite['expiresAt'] as FirebaseFirestore.Timestamp | undefined;
      if (!expiresAt || expiresAt.toMillis() < Date.now()) {
        return { valid: false, reason: 'invalid_or_expired' };
      }

      const employerId = invite['employerId'] as string;
      const employeeDocId = invite['employeeDocId'] as string;

      const [employeeSnap, employerSnap] = await Promise.all([
        db
          .collection('employers')
          .doc(employerId)
          .collection('employees')
          .doc(employeeDocId)
          .get(),
        db.collection('employers').doc(employerId).get(),
      ]);

      if (!employeeSnap.exists) {
        return { valid: false, reason: 'invalid_or_expired' };
      }

      const emp = employeeSnap.data() ?? {};
      const employeeEmail = (emp['email'] as string | undefined) ?? '';
      const employeeName = (emp['name'] as string | undefined) ?? '';
      const employerName =
        (employerSnap.data()?.['companyName'] as string | undefined) ?? '';

      try {
        await doc.ref.update({ clickedAt: FieldValue.serverTimestamp() });
      } catch (_) {
        // Best-effort click tracking; never fail the lookup.
      }

      return {
        valid: true,
        employerName,
        employeeName,
        employeeEmail: maskEmail(employeeEmail),
        inviteId: doc.id,
      };
    })
);
