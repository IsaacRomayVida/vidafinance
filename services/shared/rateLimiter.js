/**
 * Rate limiting middleware for Railway services using Redis-backed counters.
 * Uses the shared Redis connection from queues.js.
 */
const { connection } = require('./queues');

/**
 * Creates a rate-limiting middleware using Redis.
 * @param {object} opts
 * @param {number} opts.windowMs  - Window in milliseconds (default: 60000 = 1 min)
 * @param {number} opts.max       - Max requests per window per IP (default: 100)
 * @param {string} opts.prefix    - Redis key prefix (default: 'rl:')
 */
function createRateLimiter({ windowMs = 60000, max = 100, prefix = 'rl:' } = {}) {
  const windowSec = Math.ceil(windowMs / 1000);

  return async function rateLimiter(req, res, next) {
    // Skip rate limiting if Redis is unavailable
    try {
      const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
      const key = prefix + ip;
      const multi = connection.multi();
      multi.incr(key);
      multi.expire(key, windowSec);
      const results = await multi.exec();
      const count = results[0][1];

      // Set standard rate-limit headers (RFC 6585 / draft-ietf-httpapi-ratelimit-headers)
      res.setHeader('RateLimit-Limit', String(max));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, max - count)));
      res.setHeader('RateLimit-Reset', String(windowSec));

      if (count > max) {
        return res.status(429).json({
          error: 'Too many requests',
          retryAfter: windowSec,
        });
      }
    } catch (err) {
      // If Redis is down, allow the request through (fail-open)
      console.warn('Rate limiter Redis error:', err.message);
    }

    next();
  };
}

// General API rate limit: 100 req/min per IP
const apiRateLimit = createRateLimiter({ windowMs: 60000, max: 100, prefix: 'rl:api:' });

// Webhook rate limit: 500 req/min per IP (STP/Conekta can burst)
const webhookRateLimit = createRateLimiter({ windowMs: 60000, max: 500, prefix: 'rl:wh:' });

module.exports = { createRateLimiter, apiRateLimit, webhookRateLimit };
