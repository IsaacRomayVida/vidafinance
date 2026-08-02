'use strict';

// Internal service-to-service authentication for vida-softcredito-adapter.
//
// Fail closed. The previous inline middleware was:
//
//   if (req.headers['x-internal-secret'] !== process.env.INTERNAL_SECRET) -> 401
//
// With INTERNAL_SECRET unset, both sides are `undefined`, the strict-inequality
// check is false, and every /internal/*, /bureau/query and /curp/validate route
// becomes publicly callable with no header at all. Refuse to boot instead.
//
// Same pattern as vida-underwriting-service and vida-registry-service, and the
// same semantics as this service's TypeScript src/lib/internalAuth.ts.

const crypto = require('crypto');

const SERVICE_NAME = 'vida-softcredito-adapter';

function assertInternalSecret(env = process.env) {
  if (!env.INTERNAL_SECRET) {
    throw new Error(`INTERNAL_SECRET is required to start ${SERVICE_NAME}`);
  }
}

// Constant-time compare. crypto.timingSafeEqual throws when the buffers differ
// in length — and the length of the presented value is attacker-controlled — so
// hash both sides first to get two fixed-width 32-byte digests.
function secretMatches(secret, presented) {
  if (!secret || !presented) return false;
  if (typeof secret !== 'string' || typeof presented !== 'string') return false;
  const a = crypto.createHash('sha256').update(secret).digest();
  const b = crypto.createHash('sha256').update(presented).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireInternal(req, res, next) {
  if (!secretMatches(process.env.INTERNAL_SECRET, req.headers['x-internal-secret'])) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = { assertInternalSecret, secretMatches, requireInternal };
