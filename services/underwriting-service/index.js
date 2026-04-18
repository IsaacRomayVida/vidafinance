const express = require('express');
const helmet  = require('helmet');
const admin   = require('firebase-admin');
const IORedis = require('ioredis');
const { alert5xx, alertRateLimit, alertFraudScore, alertFirestoreFailure, alertRedisLost } = require('../shared/alerting');
const { register: metricsRegister, metricsMiddleware } = require('../shared/metrics');
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
  tls: process.env.REDIS_URL?.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined
});

const SERVICE_NAME = 'vida-underwriting-service';
redis.on('error', (err) => {
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.message?.includes('ECONNRESET')) {
    alertRedisLost(SERVICE_NAME);
  }
});

// Firestore write failure tracking
let _fsWrites = 0, _fsFails = 0;
const _origCollection = db.collection.bind(db);
db.collection = function (...args) {
  const ref = _origCollection(...args);
  const origAdd = ref.add.bind(ref);
  ref.add = async function (data) {
    _fsWrites++;
    try { return await origAdd(data); }
    catch (err) { _fsFails++; throw err; }
  };
  return ref;
};

// Check Firestore failure rate every 60s
setInterval(() => {
  if (_fsWrites >= 20) {
    const rate = _fsFails / _fsWrites;
    if (rate > 0.05) alertFirestoreFailure(SERVICE_NAME, rate);
  }
  _fsWrites = 0;
  _fsFails = 0;
}, 60_000);

const cors = require('cors');
const ALLOWED = (process.env.ALLOWED_ORIGINS || 'https://vida-finance.web.app').split(',').map(s => s.trim());
const app = express();
app.use(helmet());
app.use(metricsMiddleware('vida-underwriting-service'));
app.use((req, res, next) => {
  if (req.path.startsWith('/webhooks')) return next();
  const origin = req.headers.origin;
  if (origin && ALLOWED.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'GET,POST'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-internal-secret'); return res.sendStatus(204); }
  next();
});
app.use(express.json({ limit: '100kb' }));

// 5xx alert interceptor
app.use((req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = function (body) {
    if (res.statusCode >= 500) alert5xx(SERVICE_NAME, res.statusCode, req.path);
    return origJson(body);
  };
  next();
});

const requireInternal = (req, res, next) => {
  if (req.headers['x-internal-secret'] !== process.env.INTERNAL_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// ── Health ──────────────────────────────────────────────────────────
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', metricsRegister.contentType);
  res.end(await metricsRegister.metrics());
});

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
    console.warn('Invalid MetaMap webhook signature');
    await db.collection('incident_log').add({
      source: 'metamap-webhook', error: 'invalid_signature',
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
      await db.collection('metamap_shadow_log').doc(verificationId).set({
        verificationId,
        loanId,
        correlationId,
        [`steps.${step.id}`]: { status: step.status, data: step.data || null, error: step.error || null },
        lastStepAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  } catch (err) {
    console.error('MetaMap webhook processing error:', err.message);
    await db.collection('incident_log').add({
      source: 'metamap-webhook', error: err.message,
      verificationId,
      ts: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  }
});

// ── Underwrite endpoint ─────────────────────────────────────────────
app.post('/underwrite', requireInternal, async (req, res) => {
  const { runPipeline } = require('./src/decision-engine');
  const { applicant, employer, loanAmount } = req.body;

  if (!applicant || !employer) {
    return res.status(400).json({ error: 'Missing applicant or employer data' });
  }

  try {
    const result = await runPipeline(
      { applicant, employer },
      { logger: console, db, correlationId: req.body.correlationId }
    );

    // Alert on high fraud score at Stage 0
    const stage0 = result.stages?.stage0;
    if (stage0?.data?.mlFraud?.fraud?.score > 85) {
      alertFraudScore(SERVICE_NAME, stage0.data.mlFraud.fraud.score, applicant.employeeId || applicant.curp || 'unknown');
    }

    res.json({
      decision: result.decision,
      reason: result.reason,
      correlationId: result.correlationId,
      durationMs: result.durationMs,
      lastStage: result.lastStage,
      stagesExecuted: result.stagesExecuted,
      cost: result.cost,
      stages: result.stages,
      slaHours: result.slaHours || null,
    });
  } catch (err) {
    console.error('Underwriting pipeline error:', err.message);
    // Detect rate limit errors from external APIs
    if (err.message?.includes('429') || err.message?.toLowerCase().includes('rate limit')) {
      if (err.message?.includes('MetaMap')) alertRateLimit(SERVICE_NAME, 'MetaMap');
      if (err.message?.includes('Belvo') || err.message?.includes('belvo')) alertRateLimit(SERVICE_NAME, 'Belvo');
    }
    res.status(500).json({ error: 'Pipeline error', message: err.message });
  }
});

if (require.main === module) {
  app.listen(process.env.PORT || 3003, () => console.log('vida-underwriting-service on', process.env.PORT || 3003));
}

module.exports = app;
