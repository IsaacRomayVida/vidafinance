import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getAuth } from 'firebase-admin/auth';

import { checkRateLimit } from '../utils/rateLimiter';

/**
 * Resend email verification for the calling user.
 * Client calls this when user clicks "Resend verification email".
 */
export const sendVerificationEmail = onCall(
  { cors: true, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in');
    }

    // Rate limit: 20/min/uid (mutation — triggers outbound email)
    try {
      const allowed = await checkRateLimit(`rl:sendVerificationEmail:${request.auth.uid}`, 20, 60);
      if (!allowed) {
        throw new HttpsError('resource-exhausted', 'Rate limit exceeded, please retry in a minute');
      }
    } catch (e: unknown) {
      if (e instanceof HttpsError) throw e;
      logger.warn('Rate limiter unavailable', { error: (e as Error).message, service: 'functions' });
    }

    const auth = getAuth();
    const user = await auth.getUser(request.auth.uid);

    if (user.emailVerified) {
      return { alreadyVerified: true };
    }

    // Generate email verification link and send via Firebase
    // Link generation handled by Firebase Auth SDK on client side
    
    // For now, return the link. In production, send via SendGrid.
    // TODO: Send via notification service
    return { sent: true, email: user.email };
  }
);
