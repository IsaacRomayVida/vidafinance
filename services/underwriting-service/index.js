const express = require('express');
const helmet  = require('helmet');
const admin   = require('firebase-admin');
const IORedis = require('ioredis');
require('dotenv').config();

const metamapClient = require('./src/metamap-client');

const svcAcct = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT_B64
    ? Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString()
    : process.env.FIREBASE_SERVICE_ACCOUNT
);
admin.initializeApp({ credential: admin.credential.cert(svcAcct) });
const db    = admin.firestore();
const redis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  tls: process.env.REDIS_URL?.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
});

const app = express();
app.use(helmet());

// Skip CORS for webhook paths; apply to everything else
const ALLOWED = (process.env.ALLOWED_ORIGINS || 'https://vida-finance.web.app').split(',').map(s => s.trim());
app.use((req, res, next) => {
  if (req.path.startsWith('/webhooks')) return next();
  const origin = req.headers.origin;
  if (origin && ALLOWED.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-internal-secret');
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json({ limit: '100kb' }));

const requireInternal = (req, res, next) => {
  if (req.headers['x-internal-secret'] !== process.env.INTERNAL_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// ── Health ──────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const r = await redis.ping().then(() => true).catch(() => false);
  res.json({ status: r ? 'ok' : 'degraded', service: 'vida-underwriting-service', redis: r, ts: new Date().toISOString() });
});

// ── MetaMap webhook ─────────────────────────────────────────────────
app.post('/webhooks/metamap', async (req, res) => {
  const signature = req.headers['x-signature'];
  const { valid, eventName, verificationId, step, metadata } =
    metamapClient.parseWebhook(req.body, signature);

  if (!valid) {
    console.warn('Invalid MetaMap webhook signature', { signature: signature ? '[present]' : '[missing]' });
    await db.collection('incident_log').add({
      source: 'metamap-webhook',
      error: 'invalid_signature',
      ts: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Return 200 immediately — process asynchronously
  res.json({ received: true });

  const loanId = metadata?.loanId || null;
  const correlationId = metadata?.correlationId || null;

  try {
    if (eventName === 'verification_completed') {
      // Fetch full verification data from MetaMap API
      const fullResult = await metamapClient.getVerificationResult(verificationId);
      await db.collection('metamap_shadow_log').doc(verificationId).set({
        verificationId,
        loanId,
        correlationId,
        eventName,
        status: fullResult.status || 'unknown',
        results: fullResult,
        receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else if (eventName === 'step_completed' && step) {
      // Merge individual step data into existing doc
      await db.collection('metamap_shadow_log').doc(verificationId).set({
        verificationId,
        loanId,
        correlationId,
        [`steps.${step.id}`]: {
          status: step.status,
          data: step.data || null,
          error: step.error || null,
        },
        lastStepAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  } catch (err) {
    console.error('MetaMap webhook processing error:', err.message);
    await db.collection('incident_log').add({
      source: 'metamap-webhook',
      error: err.message,
      verificationId,
      eventName,
      ts: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
});

/* istanbul ignore next — only start listening when run directly (not under test) */
if (require.main === module) {
  app.listen(process.env.PORT || 3003, () => console.log('vida-underwriting-service on', process.env.PORT || 3003));
}

module.exports = app;
