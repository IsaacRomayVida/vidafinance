/**
 * CORS middleware for Railway internal services.
 * Only allows server-to-server calls from Firebase Cloud Functions.
 * Browser-originated requests are blocked (these are internal APIs).
 */
const INTERNAL_ORIGINS = [
  'https://us-central1-vida-finance-prod.cloudfunctions.net',
  'https://us-central1-vida-finance-staging.cloudfunctions.net',
];

function railwayCors(req, res, next) {
  const origin = req.headers.origin;

  // No origin = server-to-server call (Firebase Functions, BullMQ workers, webhooks) — allow
  if (!origin) return next();

  // Allow known internal origins
  if (INTERNAL_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-internal-secret');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  }

  // Block all browser origins — these are internal APIs
  return res.status(403).json({ error: 'CORS blocked' });
}

module.exports = { railwayCors, INTERNAL_ORIGINS };
