import { HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getRedis } from './redis';

// INCR then EXPIRE, as one atomic server-side step.
//
// The two-call version this replaces (`incr`, then `expire` only when the
// counter came back 1) had a hole with no way out of it: if the EXPIRE was
// lost — the call failed, the connection dropped, the function instance was
// killed between the two round-trips — the key stayed at 1 with no TTL. It is
// only ever INCRemented after that and the `current === 1` guard never fires
// again, so the TTL is never re-applied. The counter climbs forever and, once
// it passes maxRequests, that principal is refused for good. On
// `rl:loan:${uid}` (3 per 86400s) that is a borrower permanently unable to
// request a loan, recoverable only by someone deleting the key by hand.
//
// `TTL < 0` covers both -1 (key exists, no expiry — the stuck case above) and
// -2 (key vanished between the INCR and the TTL check), so a key that lost its
// window heals itself on the next request instead of latching.
const INCR_WITH_TTL = `
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number
): Promise<boolean> {
  const redis = getRedis();
  const current = (await redis.eval(INCR_WITH_TTL, 1, key, String(windowSeconds))) as number;
  return current <= maxRequests;
}

/**
 * What to do when the limiter itself cannot answer — Redis unreachable, or
 * REDIS_URL not configured on this deployment (`getRedis()` throws outright).
 *
 * 'closed' — refuse the request. For limits that are the only brake on spend,
 *   on a paid external API, or on enumerating a secret code space. An outage
 *   that silently lifts those is worse than an outage that is visible.
 * 'open'  — log and let the request through. Only for read-only endpoints,
 *   where the limit protects capacity rather than money or secrets.
 */
export type LimiterFailureMode = 'closed' | 'open';

/**
 * Applies a rate limit and throws when it is exceeded.
 *
 * Every call site used to inline this same try/catch, and every one of them
 * swallowed limiter outages and continued — fail-open by copy-paste rather
 * than by decision. Routing through here forces the choice to be stated.
 */
export async function enforceRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number,
  options: { onUnavailable: LimiterFailureMode; message?: string; context?: string }
): Promise<void> {
  let allowed: boolean;
  try {
    allowed = await checkRateLimit(key, maxRequests, windowSeconds);
  } catch (e: unknown) {
    const detail = { error: (e as Error).message, context: options.context ?? key, service: 'functions' };
    if (options.onUnavailable === 'closed') {
      logger.error('Rate limiter unavailable — refusing request', detail);
      throw new HttpsError(
        'unavailable',
        'Servicio no disponible temporalmente. Intenta de nuevo en unos minutos.'
      );
    }
    logger.warn('Rate limiter unavailable — allowing request (read-only endpoint)', detail);
    return;
  }

  if (!allowed) {
    throw new HttpsError(
      'resource-exhausted',
      options.message ?? 'Rate limit exceeded, please retry in a minute'
    );
  }
}
