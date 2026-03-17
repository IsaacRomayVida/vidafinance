/**
 * Security headers middleware for all Railway services.
 * Replaces helmet() with explicit, auditable headers.
 */
function securityHeaders(req, res, next) {
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');

  // XSS protection (legacy browsers)
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Prevent MIME sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // HSTS — force HTTPS for 1 year
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');

  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // CSP — Railway services are internal APIs, so restrictive
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");

  // Permissions policy
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  // Remove fingerprinting headers
  res.removeHeader('X-Powered-By');
  res.removeHeader('Server');

  next();
}

module.exports = { securityHeaders };
