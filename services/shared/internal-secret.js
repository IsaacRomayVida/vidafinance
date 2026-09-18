'use strict';

// Service-to-service authentication: who is allowed to present
// `x-internal-secret`, and which values count.
//
// Every internal route used to compare the presented header against exactly
// one value, `process.env.INTERNAL_SECRET`. That works until the secret has to
// change. Rotating a single shared value across seven Railway services and the
// Cloud Functions cannot be atomic: for as long as the rollout takes, some
// callers still send the old value while some callees already expect only the
// new one, and every one of those calls is a 401 in the middle of a live loan
// flow.
//
// So a verifier accepts a SET: `INTERNAL_SECRET`, which is what callers send,
// plus `INTERNAL_SECRET_ALT`, which is accepted and never sent. That makes a
// rotation four ordered variable changes with no 401 window at any point —
// see docs/runbooks/rotate-internal-secret.md:
//
//   1. set ALT = new     — everyone accepts {old, new}, everyone sends old
//   2. set SECRET = new, ALT = old   — still accepting both, now sending new
//   3. clear ALT         — only the new value is accepted or sent
//
// Fail closed is unchanged, and is the reason this file never treats an empty
// or missing value as a match: with nothing configured, both sides would be
// `undefined`, a `!==` check would be false, and every internal route would be
// open to an unauthenticated caller. Each service keeps its boot guard, so a
// service with no INTERNAL_SECRET refuses to start rather than serving.

const crypto = require('crypto');

/**
 * Constant-time compare of one secret against a presented value.
 *
 * `crypto.timingSafeEqual` throws when the buffers differ in length, and the
 * presented value's length is entirely the caller's, so hash both sides first
 * to get two fixed-width 32-byte digests.
 */
function secretMatches(secret, presented) {
  if (typeof secret !== 'string' || typeof presented !== 'string') return false;
  if (!secret || !presented) return false;
  const a = crypto.createHash('sha256').update(secret).digest();
  const b = crypto.createHash('sha256').update(presented).digest();
  return crypto.timingSafeEqual(a, b);
}

/** The values a verifier accepts right now, in send-preference order. */
function acceptedSecrets(env = process.env) {
  return [env.INTERNAL_SECRET, env.INTERNAL_SECRET_ALT].filter(
    (value) => typeof value === 'string' && value.length > 0,
  );
}

/**
 * Does the presented header match any accepted secret?
 *
 * Every candidate is compared even after one matches: an early return would
 * make "matched the first value" and "matched the second" take measurably
 * different times, which is exactly what the constant-time compare above
 * exists to avoid.
 */
function presentedSecretAccepted(presented, env = process.env) {
  let accepted = false;
  for (const secret of acceptedSecrets(env)) {
    accepted = secretMatches(secret, presented) || accepted;
  }
  return accepted;
}

/** Boot guard: a service that cannot authenticate its callers must not serve. */
function assertInternalSecret(serviceName, env = process.env) {
  if (!env.INTERNAL_SECRET) {
    throw new Error(`INTERNAL_SECRET is required to start ${serviceName}`);
  }
}

/** Express middleware: 401 unless the header matches an accepted secret. */
function requireInternal(req, res, next) {
  if (!presentedSecretAccepted(req.headers['x-internal-secret'])) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = {
  acceptedSecrets,
  assertInternalSecret,
  presentedSecretAccepted,
  requireInternal,
  secretMatches,
};
