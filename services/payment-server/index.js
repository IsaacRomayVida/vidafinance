const express = require('express');
const crypto  = require('crypto');
const helmet  = require('helmet');
const admin   = require('firebase-admin');
const IORedis = require('ioredis');
const { Queue, Worker } = require('bullmq');
const { applyCardRepayment } = require('./cardRepayment');
const { alert5xx, alertDisbursementFailed, alertQueueDepth, alertRedisLost } = require('../shared/alerting');
const { register: metricsRegister, metricsMiddleware } = require('../shared/metrics');
require('dotenv').config();

// Fail closed: requireInternal compares the request header against
// process.env.INTERNAL_SECRET. If the variable is unset both sides are
// `undefined`, the strict-inequality check is false, and every /internal route
// (including POST /internal/repayment) becomes publicly callable with no header
// at all. Refuse to boot rather than serve the money path unauthenticated.
// Same pattern as vida-registry-service.
if (!process.env.INTERNAL_SECRET) {
  throw new Error('INTERNAL_SECRET is required to start vida-payment-server');
}

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

const SERVICE_NAME = 'vida-payment-server';
redis.on('error', (err) => {
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.message?.includes('ECONNRESET')) {
    alertRedisLost(SERVICE_NAME);
  }
});

const cors = require('cors');
const ALLOWED = (process.env.ALLOWED_ORIGINS || 'https://vida-finance.web.app').split(',').map(s => s.trim());
const app = express();
app.use(helmet());
app.use(metricsMiddleware('vida-payment-server'));
app.use((req, res, next) => {
  if (req.path.startsWith('/webhooks')) return next();
  const origin = req.headers.origin;
  if (origin && ALLOWED.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'GET,POST'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-internal-secret'); return res.sendStatus(204); }
  next();
});
app.use('/webhooks', express.raw({ type: 'application/json', limit: '10kb' }));
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

const queueOpts = { connection: redis };
const getQueue = name => new Queue(name, {
  connection: redis,
  defaultJobOptions: { removeOnComplete: { count: 1000 }, removeOnFail: { count: 5000 }, attempts: 5, backoff: { type: 'exponential', delay: 2000 } }
});

// Only a repayment that actually CLOSED the loan raises "your loan is paid"
// and mints a receipt. The old order.paid path enqueued both unconditionally,
// which was consistent only because that path also settled unconditionally --
// now that a partial payment stays partial, telling the borrower they are done
// would be a lie, and a Conekta retry must not mint a second receipt. Same
// stance as POST /internal/repayment, which notifies only on 'applied'.
async function announceRepayment(result, { loanId, employeeId, chargeId }) {
  if (!result || !result.settled) return;
  const amount = result.appliedAmount;
  await getQueue('vida-notifications').add('loan_paid', { type: 'loan_paid', loanId, employeeId, amount, method: 'card' });
  await getQueue('vida-pdfs').add('repayment_receipt', { type: 'repayment_receipt', loanId, employeeId, amount, chargeId });
}

// An audit write must never be the reason a request goes unanswered. Every
// incident_log write on the webhook path records a decision that has ALREADY
// been made -- failing to record a rejection must not also fail to perform it.
// Express 4 does not catch a rejected promise from an async route handler, so
// an unguarded `await ...add()` on a failure path sends no response at all and
// the caller hangs until its own timeout. Conekta retries on timeout as well as
// on non-2xx, so a hang turns a fast, logged failure into a slow one that holds
// a connection per retry for the length of the outage. Same defect class as the
// registry-service transaction fix (#524), here in the service that moves money.
async function logIncident(fields) {
  try {
    await db.collection('incident_log').add({ ...fields, ts: admin.firestore.FieldValue.serverTimestamp() });
  } catch (err) {
    // Deliberately swallowed. The caller is mid-failure already; replacing its
    // cause with the logger's own error helps no one and costs the response.
    console.error('[payment-server] incident_log write failed:', err.message, JSON.stringify(fields));
  }
}

// ── Health ──────────────────────────────────────────────────────────
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', metricsRegister.contentType);
  res.end(await metricsRegister.metrics());
});

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
    await logIncident({ source: 'conekta-webhook', error: 'invalid_signature' });
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let type, data;
  try {
    ({ type, data } = JSON.parse(req.body.toString()));
  } catch (err) {
    // Signature-valid but unreadable: Conekta believes it told us something we
    // could not parse, so record it — silently dropping it loses a real event.
    // 400 rather than 500, because the body is the caller's to get right and a
    // 4xx tells Conekta the retry is pointless; retrying a body that cannot
    // parse cannot ever succeed.
    await logIncident({
      source: 'conekta-webhook',
      error: `unparseable body: ${err.message}`,
      bodyPreview: req.body.toString().slice(0, 200),
    });
    return res.status(400).json({ error: 'Malformed JSON body' });
  }

  try {
    if (type === 'order.paid') {
      const { loanId, employeeId } = data.object.metadata || {};
      if (!loanId || !employeeId) throw new Error('Missing metadata');
      const orderId = data.object.id;
      const charges = data.object.charges?.data ?? [];

      // Apply per charge, keyed by charge id, because that is the only
      // identifier this event shares with `charge.paid` -- see rule 2 in
      // cardRepayment.js. The order total is used only when the order carries
      // exactly one charge whose own amount is missing; with several charges
      // there is no safe way to attribute it, and inventing one would
      // double-count against the sibling `charge.paid` events.
      const payments = charges
        .filter((c) => c && c.id)
        .map((c) => ({
          chargeId: c.id,
          amount: (typeof c.amount === 'number' ? c.amount : (charges.length === 1 ? data.object.amount : NaN)) / 100,
        }));

      if (payments.length === 0 || payments.some((p) => !Number.isFinite(p.amount))) {
        // Fail closed. A paid order always carries its charge, so this is an
        // anomaly; applying the money under an order-scoped key would race the
        // `charge.paid` for the same payment and settle the loan twice. Leaving
        // the debt intact is recoverable, forgiving it is not.
        await db.collection('incident_log').add({
          source: 'conekta-webhook',
          error: 'order.paid with no attributable charge — not applied, needs manual reconciliation',
          loanId,
          conektaOrderId: orderId,
          ts: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        const result = await applyCardRepayment({ db, admin }, { loanId, employeeId, orderId, payments });
        await announceRepayment(result, { loanId, employeeId, chargeId: payments[payments.length - 1].chargeId });
      }
    }

    if (type === 'order.payment_failed') {
      const { loanId } = data.object.metadata || {};
      if (loanId) await db.collection('payment_failures').add({ loanId, conektaOrderId: data.object.id, reason: data.object.payment_status, ts: admin.firestore.FieldValue.serverTimestamp() });
    }

    if (type === 'charge.paid') {
      const { loanId, employeeId } = data.object.metadata || {};
      if (!loanId || !employeeId) throw new Error('Missing metadata on charge.paid');
      const amount = data.object.amount / 100; // Conekta uses centavos
      const chargeId = data.object.id;
      if (!chargeId) throw new Error('Missing charge id on charge.paid');

      // Same routine, same `conekta_<chargeId>` key as the order.paid path, so
      // the two events for one payment apply the money exactly once between
      // them regardless of which lands first.
      const result = await applyCardRepayment(
        { db, admin },
        { loanId, employeeId, orderId: data.object.order_id ?? null, payments: [{ chargeId, amount }] }
      );
      await announceRepayment(result, { loanId, employeeId, chargeId });
    }

    if (type === 'charge.payment_failure') {
      const { loanId, employeeId } = data.object.metadata || {};
      await db.collection('payment_failures').add({
        loanId: loanId || null,
        employeeId: employeeId || null,
        conektaChargeId: data.object.id,
        reason: data.object.failure_message,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    res.json({ received: true });
  } catch (err) {
    await logIncident({ source: 'conekta-webhook', error: err.message });
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── Create checkout (Conekta) ───────────────────────────────────────
app.post('/create-checkout', requireInternal, async (req, res) => {
  const { loanId, amount, employeeId, employeeName, concept } = req.body;
  if (!loanId || !amount || !employeeId) {
    return res.status(400).json({ error: 'Missing required fields: loanId, amount, employeeId' });
  }

  const apiKey = process.env.CONEKTA_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Conekta API key not configured' });
  }

  try {
    const fetch = require('node-fetch');
    const orderPayload = {
      currency: 'MXN',
      customer_info: { name: employeeName || 'Empleado', email: `${employeeId}@vida.internal` },
      line_items: [{
        name: concept || `Pago préstamo ${loanId}`,
        unit_price: Math.round(amount * 100),
        quantity: 1,
      }],
      checkout: {
        type: 'Integration',
        allowed_payment_methods: ['card', 'cash', 'bank_transfer'],
        expires_at: Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000),
      },
      metadata: { loanId, employeeId },
    };

    const conektaRes = await fetch('https://api.conekta.io/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/vnd.conekta-v2.2.0+json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(orderPayload),
    });

    if (!conektaRes.ok) {
      const errBody = await conektaRes.text();
      await logIncident({ source: 'create-checkout', loanId, error: errBody });
      return res.status(502).json({ error: 'Conekta order creation failed', details: errBody });
    }

    const order = await conektaRes.json();
    const paymentUrl = order.checkout?.url;
    const orderId = order.id;

    if (!paymentUrl || !orderId) {
      return res.status(502).json({ error: 'Invalid Conekta response: missing checkout URL or order ID' });
    }

    res.json({ paymentUrl, orderId });
  } catch (err) {
    await logIncident({ source: 'create-checkout', loanId, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Internal repayment (from SoftCrédito payroll deduction sync) ────
app.post('/internal/repayment', requireInternal, async (req, res) => {
  const { loanId, employeeId, amount, ref, method } = req.body;
  if (!loanId || !employeeId || !amount) return res.status(400).json({ error: 'Missing fields' });
  try {
    const outcome = await db.runTransaction(async tx => {
      const loanRef = db.collection('loans').doc(loanId);
      const doc = await tx.get(loanRef);
      if (!doc.exists) return 'not_found';
      if (doc.data().status === 'paid') return 'already_paid';
      tx.update(loanRef, { status: 'paid', paidAt: admin.firestore.FieldValue.serverTimestamp(), paidAmount: amount, repaymentRef: ref });
      tx.set(db.collection('repayments').doc(), { loanId, employeeId, amount, method: method || 'payroll_deduction', externalRef: ref, status: 'completed', paidAt: admin.firestore.FieldValue.serverTimestamp() });
      const emp = await tx.get(db.collection('employees').doc(employeeId));
      if (emp.exists) tx.update(db.collection('employees').doc(employeeId), { availableCredit: admin.firestore.FieldValue.increment(doc.data().amount) });
      return 'applied';
    });

    // A repayment against a loan we do not have is a reconciliation failure on
    // the payroll side. Reporting success hides it and, worse, used to tell the
    // borrower their loan was paid.
    if (outcome === 'not_found') return res.status(404).json({ error: 'Loan not found', loanId });

    // Only a repayment we actually applied may raise the notification; a replay
    // against an already-paid loan must not re-notify.
    if (outcome === 'applied') {
      await getQueue('vida-notifications').add('loan_paid', { type: 'loan_paid', loanId, employeeId, amount, method: method || 'payroll_deduction' });
    }
    res.json({ success: true, status: outcome });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Queue stats (for admin monitoring) ──────────────────────────────
// Express 4 does not catch a rejected promise from an async route handler, so
// an unguarded `await Promise.all([...counts])` sent no response at all when
// Redis was unreachable -- the caller hung until its own timeout instead of
// getting an error status. Same defect class as #526/#528. Each queue's
// counts are now collected in their own try/catch so one unreachable queue
// degrades only that queue's entry instead of the whole response, and
// `q.close()` moved into a `finally` so every Queue instance is closed
// regardless of outcome -- previously a rejection left that iteration's queue
// open and never even reached the remaining queue names, leaking a
// connection per call during an outage. Only when every queue is unreachable
// does the route answer 503; a partial outage still returns what it has.
app.get('/internal/queue-stats', requireInternal, async (req, res) => {
  const names = ['vida-disbursements', 'vida-notifications', 'vida-pdfs', 'vida-underwriting'];
  const stats = {};
  const errors = {};
  for (const n of names) {
    const q = new Queue(n, { connection: redis });
    try {
      const [w, a, f, c, d] = await Promise.all([q.getWaitingCount(), q.getActiveCount(), q.getFailedCount(), q.getCompletedCount(), q.getDelayedCount()]);
      stats[n] = { waiting: w, active: a, failed: f, completed: c, delayed: d };
    } catch (err) {
      errors[n] = err.message;
    } finally {
      await q.close().catch(() => {});
    }
  }

  if (Object.keys(stats).length === 0) {
    return res.status(503).json({ error: 'Queue stats unavailable — Redis unreachable', errors, ts: new Date().toISOString() });
  }
  res.json({ queues: stats, ...(Object.keys(errors).length ? { errors } : {}), ts: new Date().toISOString() });
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
    alertDisbursementFailed(SERVICE_NAME, job.data.loanId, err.message);
  }
});

// Periodic queue depth check (every 60s)
setInterval(async () => {
  try {
    const q = new Queue('vida-disbursements', { connection: redis });
    const depth = await q.getWaitingCount();
    await q.close();
    if (depth > 100) alertQueueDepth(SERVICE_NAME, 'vida-disbursements', depth, 100);
  } catch (_) {}
}, 60_000);

if (require.main === module) {
  app.listen(process.env.PORT || 3001, () => console.log('vida-payment-server on', process.env.PORT || 3001));
}

module.exports = { app, disburseWorker };
