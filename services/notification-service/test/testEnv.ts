// Fixed values for the isolated worker-under-test -- unconditional, so test
// bodies asserting against these literals don't silently drift if a real
// value happens to be set in the environment.
export function setBaseEnv(): void {
  process.env.FIREBASE_SERVICE_ACCOUNT = '{}';
  process.env.REDIS_URL = 'redis://127.0.0.1:6379';
  process.env.TWILIO_ACCOUNT_SID = 'ACtest';
  process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
  process.env.TWILIO_WHATSAPP_FROM = 'whatsapp:+14155238886';
  process.env.TWILIO_SMS_FROM = '+15005550006';
  process.env.SENDGRID_API_KEY = 'SG.test';
  process.env.SENDGRID_FROM_EMAIL = 'noreply@vida.finance';
  delete process.env.FIREBASE_SERVICE_ACCOUNT_B64;
}
