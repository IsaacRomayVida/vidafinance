const express = require('express');
const crypto  = require('crypto');
const helmet  = require('helmet');
const admin   = require('firebase-admin');
const IORedis = require('ioredis');
const { Queue, Worker } = require('bullmq');
require('dotenv').config();

const pkg = require('./package.json');
const START_TIME = Date.now();

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

const cors = require('cors');
const ALLOWED = (process.env.ALLOWED_ORIGINS || 'https://vida-finance.web.app').split(',').map(s => s.trim());
const app = express();
app.use(helmet());
app.use((req, res, next) => {
  if (req.path.startsWith('/webhooks')) return next();
  const origin = req.headers.origin;
  if (origin && ALLOWED.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'GET,POST'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-internal-secret'); return res.sendStatus(204); }
  next();
});
app.use('/webhooks', express.raw({ type: 'application/json', limit: '10kb' }));
app.use(express.json({ limit: '100kb' }));

const requireInternal = (req, res, next) => {
  if (req.headers['x-internal-secret'] !== process.env.INTERNAL_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
};

const queueOpts = { connection: redis };
const getQueue = name => new Queue(name, {
  connection: redis,
  defaultJobOptions: { removeOnComplete: { count: 1000 }, removeOnFail: { count: 5000 }, attempts: 5, backoff: { type: 'exponential', delay: 2000 } }
});

// ── Health ──────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const redisOk = await redis.ping().then(() => true).catch(() => false);
  let firestoreOk = false;
  try { await db.collection('_health').limit(1).get(); firestoreOk = true; } catch (_) {}

  // Queue depths
  const queueDepth = {};
  const qNames = ['vida-disbursements', 'vida-notifications', 'vida-pdfs', 'vida-underwriting'];
  for (const n of qNames) {
    try {
      const q = new Queue(n, { connection: redis });
      queueDepth[n.replace('vida-', '')] = await q.getWaitingCount();
      await q.close();
    } catch (_) { queueDepth[n.replace('vida-', '')] = -1; }
  }

  const down = !redisOk && !firestoreOk;
  const degraded = !redisOk || !firestoreOk;
  res.status(down ? 503 : 200).json({
    status: down ? 'down' : degraded ? 'degraded' : 'ok',
    service: 'vida-payment-server',
    version: pkg.version,
    uptime_seconds: Math.floor((Date.now() - START_TIME) / 1000),
    redis: redisOk,
    firestore: firestoreOk,
    queue_depth: queueDepth,
    ts: new Date().toISOString(),
  });
});

// ── Conekta webhook ─────────────────────────────────────────────────
app.post('/webhooks/conekta', async (req, res) => {
  const sig = req.headers['digest'] || req.headers['x-conekta-signature'];
  const payload = req.body;
  let valid = false;
  try {
    const pubKey = process.env.CONEKTA_WEBHOOK_SECRET;
    if (pubKey.startsWith('-----BEGIN PUBLIC KEY')) {
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(payload);
      valid = verifier.verify(pubKey, sig, 'base64');
    } else {
      const exp = crypto.createHmac('sha256', pubKey).update(payload).digest('base64');
      valid = (sig === exp);
    }
  } catch (_) { valid = false; }
  if (!valid) {
    await db.collection('incident_log').add({ source: 'conekta-webhook', error: 'invalid_signature', ts: admin.firestore.FieldValue.serverTimestamp() });
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const { type, data } = JSON.parse(req.body.toString());
  try {
    if (type === 'order.paid') {
      const { loanId, employeeId } = data.object.metadata || {};
      if (!loanId || !employeeId) throw new Error('Missing metadata');
      const amount = data.object.amount / 100;
      const chargeId = data.object.charges?.data?.[0]?.id;

      await db.runTransaction(async tx => {
        const ref = db.collection('loans').doc(loanId);
        const doc = await tx.get(ref);
        if (!doc.exists || doc.data().status === 'paid') return;
        tx.update(ref, { status: 'paid', paidAt: admin.firestore.FieldValue.serverTimestamp(), paidAmount: amount, repaymentRef: chargeId });
        tx.set(db.collection('repayments').doc(), { loanId, employeeId, amount, method: 'card', conektaOrderId: data.object.id, conektaChargeId: chargeId, status: 'completed', paidAt: admin.firestore.FieldValue.serverTimestamp() });
        const empRef = db.collection('employees').doc(employeeId);
        const emp = await tx.get(empRef);
        if (emp.exists) tx.update(empRef, { availableCredit: admin.firestore.FieldValue.increment(doc.data().amount) });
      });

      await getQueue('vida-notifications').add('loan_paid', { type: 'loan_paid', loanId, employeeId, amount, method: 'card' });
      await getQueue('vida-pdfs').add('repayment_receipt', { type: 'repayment_receipt', loanId, employeeId, amount, chargeId });
    }

    if (type === 'order.payment_failed') {
      const { loanId } = data.object.metadata || {};
      if (loanId) await db.collection('payment_failures').add({ loanId, conektaOrderId: data.object.id, reason: data.object.payment_status, ts: admin.firestore.FieldValue.serverTimestamp() });
    }

    res.json({ received: true });
  } catch (err) {
    await db.collection('incident_log').add({ source: 'conekta-webhook', error: err.message, ts: admin.firestore.FieldValue.serverTimestamp() });
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── Internal repayment (from SoftCrédito payroll deduction sync) ────
app.post('/internal/repayment', requireInternal, async (req, res) => {
  const { loanId, employeeId, amount, ref, method } = req.body;
  if (!loanId || !employeeId || !amount) return res.status(400).json({ error: 'Missing fields' });
  try {
    await db.runTransaction(async tx => {
      const loanRef = db.collection('loans').doc(loanId);
      const doc = await tx.get(loanRef);
      if (!doc.exists || doc.data().status === 'paid') return;
      tx.update(loanRef, { status: 'paid', paidAt: admin.firestore.FieldValue.serverTimestamp(), paidAmount: amount, repaymentRef: ref });
      tx.set(db.collection('repayments').doc(), { loanId, employeeId, amount, method: method || 'payroll_deduction', externalRef: ref, status: 'completed', paidAt: admin.firestore.FieldValue.serverTimestamp() });
      const emp = await tx.get(db.collection('employees').doc(employeeId));
      if (emp.exists) tx.update(db.collection('employees').doc(employeeId), { availableCredit: admin.firestore.FieldValue.increment(doc.data().amount) });
    });
    await getQueue('vida-notifications').add('loan_paid', { type: 'loan_paid', loanId, employeeId, amount, method: method || 'payroll_deduction' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Queue stats (for admin monitoring) ─────────────────────────────
app.get('/internal/queue-stats', requireInternal, async (req, res) => {
  const names = ['vida-disbursements', 'vida-notifications', 'vida-pdfs', 'vida-underwriting'];
  const stats = {};
  for (const n of names) {
    const q = new Queue(n, { connection: redis });
    const [w, a, f, c, d] = await Promise.all([q.getWaitingCount(), q.getActiveCount(), q.getFailedCount(), q.getCompletedCount(), q.getDelayedCount()]);
    stats[n] = { waiting: w, active: a, failed: f, completed: c, delayed: d };
    await q.close();
  }
  res.json({ queues: stats, ts: new Date().toISOString() });
});

// ── BullMQ: disbursement worker ─────────────────────────────────────
const disburseWorker = new Worker('vida-disbursements', async job => {
  const { loanId, clabe, amount, concept, employeeName, employeeId } = job.data;
  if (!clabe) {
    await db.collection('loans').doc(loanId).update({ status: 'disbursement_error', disbursementError: 'No CLABE registered' });
    throw new Error('No CLABE for loan ' + loanId);
  }
  const fetch = require('node-fetch');
  const resp = await fetch(process.env.SOFTCREDITO_ADAPTER_URL + '/internal/disburse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SECRET },
    body: JSON.stringify({ loanId, clabe, amount, concept, employeeName, employeeId })
  });
  if (!resp.ok) throw new Error('SoftCrédito disburse failed: ' + await resp.text());
  return await resp.json();
}, { connection: redis, concurrency: 3 });

disburseWorker.on('failed', async (job, err) => {
  if (job?.attemptsMade >= 5) {
    await db.collection('loans').doc(job.data.loanId).update({ status: 'disbursement_error', disbursementError: err.message });
    await db.collection('incident_log').add({ source: 'disbursement-worker', loanId: job.data.loanId, error: err.message, ts: admin.firestore.FieldValue.serverTimestamp() });
  }
});

app.listen(process.env.PORT || 3001, () => console.log('vida-payment-server on', process.env.PORT || 3001));
