/**
 * Sentry wiring for Cloud Functions.
 *
 * Design goals:
 *   - No-op when `SENTRY_DSN` is unset. The callable functions must
 *     continue to work without any telemetry backend. This lets us
 *     merge the wiring now and activate later by setting the
 *     `SENTRY_DSN` GitHub secret and redeploying.
 *   - PII-safe. We never send email, phone, CURP, or loan amounts
 *     in scope extras. Only structural context like functionName,
 *     loanId, employerId.
 *   - Lazy init. `initSentry()` is called once at module load in
 *     `index.ts`. If DSN is missing it stays uninitialised and
 *     `captureException()` becomes a no-op.
 *   - Performance tracing disabled by default to control cost.
 */
import * as Sentry from '@sentry/node';

let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  const dsn = process.env['SENTRY_DSN'];
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env['NODE_ENV'] ?? 'production',
    release: process.env['SENTRY_RELEASE'],
    sendDefaultPii: false,
    tracesSampleRate: 0,
    integrations: [],
    beforeSend(event) {
      if (event.request?.data && typeof event.request.data === 'object') {
        const redacted: Record<string, unknown> = {};
        for (const key of Object.keys(event.request.data as Record<string, unknown>)) {
          redacted[key] = '[redacted]';
        }
        event.request.data = redacted;
      }
      return event;
    },
  });
  initialized = true;
}

/**
 * Send an error to Sentry with structured context. Safe to call whether
 * or not Sentry was initialised. Context values are passed as extras
 * and tags where appropriate; never includes PII.
 */
export function captureException(
  error: unknown,
  context?: Record<string, unknown>
): void {
  if (!initialized) return;
  Sentry.withScope((scope) => {
    if (context) {
      const {
        functionName,
        uid,
        loanId,
        employerId,
        ...rest
      } = context as Record<string, unknown>;

      if (typeof functionName === 'string') scope.setTag('function', functionName);
      if (typeof uid === 'string')          scope.setUser({ id: uid });
      if (typeof loanId === 'string')       scope.setTag('loanId', loanId);
      if (typeof employerId === 'string')   scope.setTag('employerId', employerId);

      for (const [key, value] of Object.entries(rest)) {
        scope.setExtra(key, value);
      }
    }
    Sentry.captureException(error);
  });
}

/**
 * Flush pending events before the function's container shuts down.
 * Call at the end of handleError paths to avoid losing crash reports
 * on cold-start-then-die executions.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // best-effort
  }
}
