/**
 * Sentry wiring for public-v2.
 *
 * Design goals:
 *   - Zero runtime effect until `VITE_SENTRY_DSN` is set at build time.
 *     `initSentry()` is a no-op when the DSN is empty, so this can ship
 *     to production now and activate later by setting the GitHub secret
 *     `VITE_SENTRY_DSN` and redeploying.
 *   - PII-safe by default. `sendDefaultPii: false` prevents capturing
 *     IP addresses, cookies, or headers. Users can still be tagged
 *     explicitly via `setSentryUser()`.
 *   - Performance monitoring off by default (`tracesSampleRate: 0`)
 *     to control cost. Flip to 0.1 once we have a Sentry project and
 *     want real-user telemetry.
 */
import * as Sentry from '@sentry/react';

let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) {
    if (import.meta.env.DEV) {
      console.info('[sentry] VITE_SENTRY_DSN not set — Sentry disabled');
    }
    return;
  }

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_APP_VERSION as string | undefined,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    beforeSend(event) {
      if (event.request?.url) {
        try {
          const u = new URL(event.request.url);
          u.searchParams.forEach((_, k) => u.searchParams.set(k, '***'));
          event.request.url = u.toString();
        } catch {
          // leave as-is if URL parsing fails
        }
      }
      return event;
    },
  });
  initialized = true;
}

/**
 * Report an error to Sentry. Safe to call even if Sentry was never
 * initialized (DSN unset) — the underlying Sentry client is a no-op.
 */
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;
  if (context) {
    Sentry.withScope((scope) => {
      for (const [key, value] of Object.entries(context)) {
        scope.setExtra(key, value);
      }
      Sentry.captureException(error);
    });
  } else {
    Sentry.captureException(error);
  }
}

/**
 * Tag Sentry events with a user id + role. Call after auth resolves
 * so crashes are attributable. Never passes email, name, or phone.
 */
export function setSentryUser(uid: string | null, role?: string): void {
  if (!initialized) return;
  if (uid) {
    Sentry.setUser({ id: uid, ...(role ? { role } : {}) });
  } else {
    Sentry.setUser(null);
  }
}
