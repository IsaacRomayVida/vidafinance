import { HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { sendSlackAlert } from './slackAlert';
import { captureException } from './sentry';

export enum VidaErrorCode {
  LOAN_LIMIT_EXCEEDED = 'LOAN_LIMIT_EXCEEDED',
  INSUFFICIENT_EMPLOYMENT_TENURE = 'INSUFFICIENT_EMPLOYMENT_TENURE',
  SPEI_DISBURSEMENT_FAILED = 'SPEI_DISBURSEMENT_FAILED',
  BUREAU_QUERY_FAILED = 'BUREAU_QUERY_FAILED',
  DUPLICATE_LOAN_APPLICATION = 'DUPLICATE_LOAN_APPLICATION',
  EMPLOYER_NOT_APPROVED = 'EMPLOYER_NOT_APPROVED',
  EMPLOYEE_NOT_FOUND = 'EMPLOYEE_NOT_FOUND',
  // A capacity block, not a credit decline: the employer's concurrent-active-loan
  // cap (maxActiveSlots) is already occupied. Deliberately distinct from any
  // underwriting/credit-decision code so the borrower is never told they were
  // declined for credit when the real reason is "try again once a slot frees up".
  EMPLOYER_SLOT_LIMIT_REACHED = 'EMPLOYER_SLOT_LIMIT_REACHED',
  // The employer restricted who may borrow under its name (the curpConfig
  // allowlist) and this borrower is not admitted. Deliberately distinct from
  // EMPLOYER_NOT_APPROVED — that one is about the employer's own standing with
  // VIDA; this one is the employer's own decision about this person. Neither is
  // a credit decline, and neither must be shown to the borrower as one.
  EMPLOYER_ENROLLMENT_NOT_PERMITTED = 'EMPLOYER_ENROLLMENT_NOT_PERMITTED',
}

interface ErrorContext {
  functionName: string;
  uid?: string;
  loanId?: string;
  employerId?: string;
  [key: string]: unknown;
}

/**
 * Central error handler for Cloud Functions.
 * Always logs the full error internally, never leaks stack traces or raw
 * error messages to the client. Maps known error types to safe HttpsErrors.
 */
export function handleError(error: unknown, context: ErrorContext): never {
  const serialized =
    error instanceof Error
      ? {
          message: error.message,
          stack: error.stack,
          code: (error as unknown as Record<string, unknown>)['code'],
          name: error.name,
        }
      : String(error);

  logger.error(`[${context.functionName}] Unhandled error`, {
    ...context,
    error: serialized,
  });

  // Re-throw HttpsErrors unchanged — message was already written by the
  // thrower and is considered safe for the client. These are expected
  // control-flow signals (validation, auth, rate limit), not crashes,
  // so they don't go to Sentry.
  if (error instanceof HttpsError) {
    throw error;
  }

  // Everything that falls through is an unhandled exception. Report to
  // Sentry for triage (no-op if SENTRY_DSN is unset).
  captureException(error, context);

  // Map Firebase Auth error codes to safe client messages.
  if (error instanceof Error) {
    const code = (error as unknown as Record<string, unknown>)['code'] as string | undefined;
    if (code === 'auth/id-token-revoked' || code === 'auth/id-token-expired') {
      throw new HttpsError('unauthenticated', 'Session expired. Please log in again.');
    }
    if (code === 'auth/user-not-found') {
      throw new HttpsError('not-found', 'User not found.');
    }
    if (code === 'auth/insufficient-permission') {
      throw new HttpsError('permission-denied', 'Insufficient permissions.');
    }
  }

  // Generic catch-all — never expose internal details to clients.
  sendSlackAlert(`${context.functionName} failed: ${error instanceof Error ? error.message : String(error)}`, 'critical').catch(() => {});
  throw new HttpsError('internal', 'An unexpected error occurred. Please try again.');
}

/**
 * Wraps an async function body so any uncaught error is passed through
 * handleError before reaching the client.
 */
export function withErrorHandling<T>(
  context: ErrorContext,
  fn: () => Promise<T>
): Promise<T> {
  return fn().catch((err: unknown) => handleError(err, context));
}
