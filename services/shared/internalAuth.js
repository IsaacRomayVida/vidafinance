/**
 * Internal API authentication middleware.
 * Validates the x-internal-secret header for Firebase Functions → Railway calls.
 */
function requireInternalSecret(req, res, next) {
  const secret = req.headers['x-internal-secret'];
  if (!secret || secret !== process.env.INTERNAL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = { requireInternalSecret };
