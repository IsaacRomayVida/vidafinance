/**
 * Shared stand-in for utils/rateLimiter in handler tests.
 *
 * Suites mock the limiter so they can drive it directly, but `enforceRateLimit`
 * decides whether a handler runs at all — stubbing it as a no-op would quietly
 * disable the fail-closed behaviour those handlers now depend on, and the
 * suites would pass while the real thing was broken. This mirrors the real
 * control flow (allow / resource-exhausted / unavailable) on top of whatever
 * `checkRateLimit` mock the suite supplies.
 */
export function makeEnforceRateLimit(checkRateLimit: (...args: never[]) => Promise<boolean>) {
  return async (
    key: string,
    maxRequests: number,
    windowSeconds: number,
    options: { onUnavailable: 'closed' | 'open'; message?: string; context?: string }
  ): Promise<void> => {
    // Required lazily: this file is loaded from inside a jest.mock factory,
    // which is hoisted above the suite's own imports.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { HttpsError } = require('firebase-functions/v2/https');

    let allowed: boolean;
    try {
      allowed = await (checkRateLimit as (...a: unknown[]) => Promise<boolean>)(
        key,
        maxRequests,
        windowSeconds
      );
    } catch {
      if (options?.onUnavailable === 'closed') {
        throw new HttpsError(
          'unavailable',
          'Servicio no disponible temporalmente. Intenta de nuevo en unos minutos.'
        );
      }
      return;
    }

    if (!allowed) {
      throw new HttpsError(
        'resource-exhausted',
        options?.message ?? 'Rate limit exceeded, please retry in a minute'
      );
    }
  };
}
