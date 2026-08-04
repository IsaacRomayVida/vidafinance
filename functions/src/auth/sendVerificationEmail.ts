import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getAuth } from 'firebase-admin/auth';

import { enforceRateLimit } from '../utils/rateLimiter';

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

    // Rate limit: 20/min/uid. Fails OPEN, deliberately.
    //
    // This one stays open on purpose: the handler's only remaining side
    // effect is a single Firebase Admin getUser() read, which is capacity,
    // not spend — the case utils/rateLimiter documents 'open' for. Failing
    // closed here would turn a Redis blip into a verification lockout for
    // users who are already locked out of everything else until they verify.
    //
    // This must flip to onUnavailable: 'closed' the day the send below is
    // actually implemented, because at that point the endpoint starts
    // spending on outbound email.
    await enforceRateLimit(`rl:sendVerificationEmail:${request.auth.uid}`, 20, 60, {
      onUnavailable: 'open',
      context: 'sendVerificationEmail',
    });

    const auth = getAuth();
    const user = await auth.getUser(request.auth.uid);

    if (user.emailVerified) {
      return { alreadyVerified: true };
    }

    // NOT IMPLEMENTED — and it must say so rather than claim otherwise.
    //
    // This used to `return { sent: true, email: user.email }` with nothing
    // above it but these comments: no link generated, nothing handed to any
    // mail transport. Both shipped clients happen to call the Firebase Auth
    // SDK's sendEmailVerification() directly instead of this callable
    // (public-v2/src/pages/Login.tsx, public/js/app.js), so no borrower is
    // currently affected — but the endpoint is deployed
    // (.github/workflows/deploy.yml FUNCTIONS list) and reachable, and the
    // next client wired to it would show "check your inbox" for a message
    // that is never sent, leaving the user unable to verify with no error
    // recorded anywhere. Failing loudly keeps that from shipping unnoticed.
    //
    // To implement: getAuth().generateEmailVerificationLink(user.email), then
    // send it with sendEmail() from utils/notify, and flip the limiter above
    // to fail closed. The email subject and body are borrower-facing copy and
    // need product sign-off, so they are not invented here.
    throw new HttpsError(
      'unimplemented',
      'Verification email sending is not implemented on the server; use the client Firebase Auth SDK.'
    );
  }
);
