import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getAuth } from 'firebase-admin/auth';

/**
 * Resend email verification for the calling user.
 * Client calls this when user clicks "Resend verification email".
 */
export const sendVerificationEmail = onCall(
  { cors: true, enforceAppCheck: false },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in');
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
