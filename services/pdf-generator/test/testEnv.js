'use strict';

// Fixed values for the isolated app-under-test -- unconditional, so test
// bodies asserting against these literals don't silently drift if a real
// value happens to be set in the environment (e.g. by CI for another job).
function setBaseEnv() {
  process.env.INTERNAL_SECRET = 'test-internal-secret';
  process.env.FIREBASE_SERVICE_ACCOUNT = '{}';
  process.env.FIREBASE_STORAGE_BUCKET = 'test-bucket';
  process.env.REDIS_URL = 'redis://127.0.0.1:6379';
  process.env.METAMAP_SIGNING_ENABLED = 'false';
  delete process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  delete process.env.SLACK_WEBHOOK_URL;
  delete process.env.PAGERDUTY_ROUTING_KEY;
  delete process.env.METAMAP_CLIENT_ID;
  delete process.env.METAMAP_CLIENT_SECRET;
}

module.exports = { setBaseEnv };
