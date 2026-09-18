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
// Same pattern as vida-underwriting-service and vida-registry-service: all of
// them now verify through services/shared/internal-secret.js, which is also
// what makes INTERNAL_SECRET rotatable without a 401 window.

const {
  presentedSecretAccepted,
  secretMatches,
} = require('../../shared/internal-secret');

const SERVICE_NAME = 'vida-softcredito-adapter';

function assertInternalSecret(env = process.env) {
  if (!env.INTERNAL_SECRET) {
    throw new Error(`INTERNAL_SECRET is required to start ${SERVICE_NAME}`);
  }
}

// The accepted set is INTERNAL_SECRET plus INTERNAL_SECRET_ALT while a
// rotation is in flight; both are compared in constant time.
function requireInternal(req, res, next) {
  if (!presentedSecretAccepted(req.headers['x-internal-secret'])) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = { assertInternalSecret, secretMatches, requireInternal };
