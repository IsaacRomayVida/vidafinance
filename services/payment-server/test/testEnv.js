'use strict';

const crypto = require('crypto');

// Fixed values for the isolated app-under-test -- unconditional, so test
// bodies asserting against these literals don't silently drift if a real
// value happens to be set in the environment (e.g. by CI for another job).
function setBaseEnv() {
  process.env.INTERNAL_SECRET = 'test-internal-secret';
  process.env.FIREBASE_SERVICE_ACCOUNT = '{}';
  process.env.REDIS_URL = 'redis://127.0.0.1:6379';
  process.env.CONEKTA_WEBHOOK_SECRET = 'test-conekta-webhook-secret';
  process.env.ALLOWED_ORIGINS = 'https://vida-finance.web.app';
  delete process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  delete process.env.CONEKTA_API_KEY;
  delete process.env.SLACK_WEBHOOK_URL;
  delete process.env.PAGERDUTY_ROUTING_KEY;
}

function hmacSign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64');
}

module.exports = { setBaseEnv, hmacSign };
