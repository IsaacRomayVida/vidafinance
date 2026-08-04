const express = require('express');
const crypto  = require('crypto');
const helmet  = require('helmet');
const admin   = require('firebase-admin');
const IORedis = require('ioredis');
const { Queue, Worker, UnrecoverableError } = require('bullmq');
const { applyCardRepayment, applyPayrollRepayment } = require('./applyRepayment');
const { alert5xx, alertDisbursementFailed, alertQueueDepth, alertRedisLost } = require('../shared/alerting');
const { register: metricsRegister, metricsMiddleware } = require('../shared/metrics');
require('dotenv').config();

// Fail closed: requireInternal compares the request header against
// process.env.INTERNAL_SECRET. If the variable is unset both sides are
// `undefined`, the comparison passes, and every /internal route (including
// POST /internal/repayment) becomes publicly callable with no header at all.
// Refuse to boot rather than serve the money path unauthenticated.
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

// ── Deadlines on the two outbound calls that move money ─────────────
// This service pins node-fetch ^2.7.0 (package.json), whose `timeout` option
// defaults to 0 -- disabled. Neither the Conekta order call nor the disburse
// call passed `timeout` or `signal`, so an upstream that accepts the TCP
// connection and then goes silent stalled them forever, and nothing outside
// this file bounded it: `app.listen()` below sets no server timeout (Node's
// `server.timeout` has defaulted to 0 since v13, and `requestTimeout` bounds
// RECEIVING a request, not producing a response), and BullMQ v5 has no
// per-job timeout -- `getQueue`'s defaultJobOptions above set only
// attempts/backoff/removal.
//
// What made it expensive is that it was an outage that reads as latency. The
// 5xx interceptor above hangs off `res.json`, so a request that never
// responds never alerts; `disburseWorker.on('failed')` needs a throw, and a
// hang never throws. Same family as #524/#526/#556, here on both money paths.
//
// Read at call time rather than frozen into a const at require time, matching
// SC_READ_TIMEOUT_MS in softcredito-adapter/index.js.
const CONEKTA_TIMEOUT_MS  = () => Number(process.env.CONEKTA_HTTP_TIMEOUT_MS)  || 15000;
const DISBURSE_TIMEOUT_MS = () => Number(process.env.DISBURSE_HTTP_TIMEOUT_MS) || 30000;

// node-fetch v2 rejects with `name: 'AbortError'` / `type: 'aborted'` when the
// signal fires, and destroys the response body stream as it does, so one
// signal covers the body read as well as the headers. `TimeoutError` is
// included because that is what a native `fetch` would surface from
// `AbortSignal.timeout()`, and this predicate must not start lying if a call
// site is ever moved off node-fetch.
const isAbortError = (err) =>
  !!err && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.type === 'aborted');

// Constant-time comparison of two secrets that arrive as strings.
//
// `a === b` on a JS string returns at the first byte that differs, so the time
// it takes to reject a candidate leaks how many leading bytes were right. That
// is the whole attack: an unauthenticated caller who can post to
// /webhooks/conekta as often as it likes recovers the expected digest for a
// body IT chose one byte at a time, and then posts that body signed. The body
// it would choose is a `charge.paid`, which settles a loan and mints a receipt
// for money nobody sent.
//
// crypto.timingSafeEqual throws on a length mismatch, which would leak the
// length by exception -- so the lengths are equalised first by hashing both
// sides. A digest of a fixed length also means the compare covers the full
// input rather than a prefix of it.
const timingSafeStringEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
};

const requireInternal = (req, res, next) => {
  const provided = req.headers['x-internal-secret'];
  if (!timingSafeStringEqual(Array.isArray(provided) ? '' : provided, process.env.INTERNAL_SECRET))
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
// stance as POST /internal/repayment, which notifies only on a settlement.
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
    // Fail closed on a missing OR empty secret. An unset one already failed
    // closed by accident -- startsWith() throws on undefined and the catch
    // below sets valid = false. An empty string does NOT throw: it fell
    // through to the HMAC branch and derived the expected digest from a
    // zero-length key, which the caller can derive just as easily. That made
    // every event on this route forgeable, `charge.paid` included -- and that
    // one runs applyCardRepayment, so a forgery could settle a loan and mint a
    // receipt for money nobody ever sent. Checked explicitly rather than left
    // to the throw, so the empty case is handled on purpose and says why.
    if (!pubKey) {
      console.error('[payment-server] CONEKTA_WEBHOOK_SECRET is not configured — rejecting webhook unverified');
    } else if (pubKey.startsWith('-----BEGIN PUBLIC KEY')) {
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(payload);
      valid = verifier.verify(pubKey, sig, 'base64');
    } else {
      const exp = crypto.createHmac('sha256', pubKey).update(payload).digest('base64');
      valid = timingSafeStringEqual(sig, exp);
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
      // applyRepayment.js. The order total is used only when the order carries
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

    // No idempotency key is sent, deliberately -- see the catch below.
    const conektaRes = await fetch('https://api.conekta.io/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/vnd.conekta-v2.2.0+json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(orderPayload),
      signal: AbortSignal.timeout(CONEKTA_TIMEOUT_MS()),
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
    // A client-side abort does not cancel the server side. Conekta may have
    // created the order after we stopped listening, and we will never learn
    // its id -- so this is reported as "we gave up waiting", never as "no
    // order exists", and the incident row carries the loanId so an orphan can
    // be reconciled against Conekta's side later. 504, not 500: the request
    // was not malformed and nothing here failed, an upstream simply did not
    // answer. generatePaymentLink (functions/src/payments/generatePaymentLink.
    // ts:152) branches on `!response.ok` and nothing finer, so the caller is
    // unaffected by the distinction.
    //
    // No idempotency key is sent to Conekta and no existing order is reused,
    // and both omissions are deliberate:
    //
    //  * The duplicate-ORDER surface this timeout exposes already exists and
    //    is unchanged in kind. Before this fix the hang simply propagated --
    //    generatePaymentLink.ts:137 calls us on node-fetch v2 with no timeout
    //    of its own -- until the callable hit its own deadline, and the
    //    borrower retried then too (rate-limited 20/min/uid, ibid:45). Every
    //    such call already mints a fresh order and overwrites
    //    `loans.conektaOrderId` (ibid:167). Timing out changes how FAST we
    //    give up, not whether a retry can produce a second order.
    //  * A duplicate order is not a duplicate settlement. Every repayment row
    //    is keyed `conekta_<chargeId>` (applyRepayment.js, rule 2) and a fresh
    //    charge landing on an already-settled loan is recorded `unapplied` /
    //    `loan_already_settled` and moves nothing (ibid:144-151). A second
    //    payment is a refund case, not a double-forgiven debt or a
    //    double-restored credit line.
    //  * Reusing the loan's existing order would be actively WRONG here. The
    //    amount is recomputed per call from `remainingBalance` precisely
    //    because a payroll deduction may have landed since
    //    (generatePaymentLink.ts:95-134); serving a stale order would
    //    undercharge the borrower -- the exact defect that comment exists to
    //    prevent.
    if (isAbortError(err)) {
      const timeoutMs = CONEKTA_TIMEOUT_MS();
      await logIncident({
        source: 'create-checkout',
        loanId,
        error: `conekta_timeout after ${timeoutMs}ms — an order may have been created upstream and is unreferenced; reconcile before assuming none exists`,
        timeoutMs,
      });
      return res.status(504).json({
        error: 'Conekta did not respond in time',
        reason: 'conekta_timeout',
        timeoutMs,
      });
    }
    await logIncident({ source: 'create-checkout', loanId, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Internal repayment (from SoftCrédito payroll deduction sync) ────
//
// `ref` is the SoftCrédito deduction reference and it is what names the
// payment, so it becomes the `repayments/payroll_<ref>` document id and with
// it this channel's only replay guard (rule 2 in applyRepayment.js). It is
// therefore validated as a document-id fragment before it is concatenated into
// a path: a `/` in a caller-supplied id does not fail, it silently addresses a
// DIFFERENT document (`repayments/payroll_a/b/c`), which is an idempotency key
// an attacker chooses the collision behaviour of.
const REPAYMENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

app.post('/internal/repayment', requireInternal, async (req, res) => {
  const { loanId, employeeId, amount, ref, method } = req.body;
  if (!loanId || !employeeId || !amount) return res.status(400).json({ error: 'Missing fields' });

  // `!amount` alone rejects 0 and '' and nothing else. A negative number, a
  // numeric string, an object and an array are all truthy, and every one of
  // them used to be written straight onto `loans.paidAmount` and into a
  // `repayments` row as if it were money. -500 is the expensive one: it is a
  // repayment that INCREASES the debt basis, and on the old unconditional
  // settlement path it also closed the loan and restored the full credit line
  // while doing it.
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number of pesos' });
  }
  if (typeof ref !== 'string' || !REPAYMENT_ID_PATTERN.test(ref)) {
    // Fail closed rather than apply an unidentifiable payment. Without a usable
    // reference there is no idempotency key, and a payroll deduction that can
    // be applied twice is worse than one that is held for reconciliation --
    // partial deductions now leave the loan `active`, so nothing else would
    // stop the second application. Recorded, because a rejection nobody can
    // see is how the payroll channel goes quiet.
    await logIncident({ source: 'internal-repayment', loanId, error: `unusable deduction reference: ${JSON.stringify(ref)}` });
    return res.status(400).json({ error: 'ref must be a deduction reference matching [A-Za-z0-9_.:-]{1,128}' });
  }

  try {
    // One routine, one set of rules, shared with the card channel. This route
    // used to carry its own transaction body, and what that body did was
    // settle: `status: 'paid'`, `paidAmount: amount`, and the employee's full
    // principal handed back as credit -- with no comparison of `amount`
    // against `remainingBalance ?? total` anywhere. `amount` is whatever
    // SoftCrédito reported collecting, so any short deduction forgave the
    // remainder of the debt. It also credited `employees/{req.body.employeeId}`
    // rather than the loan's own employee. See applyRepayment.js, rules 1 and 4.
    const result = await applyPayrollRepayment({ db, admin }, { loanId, employeeId, amount, ref, method });

    // A repayment against a loan we do not have is a reconciliation failure on
    // the payroll side. Reporting success hides it and, worse, used to tell the
    // borrower their loan was paid.
    if (result.outcome === 'loan_not_found') return res.status(404).json({ error: 'Loan not found', loanId });

    // Only a repayment that actually CLOSED the loan raises "your loan is
    // paid". A partial deduction leaves a balance, and telling the borrower
    // they are done would be a lie -- the same stance announceRepayment takes
    // on the card path. `already_paid` is kept as the wire spelling for the
    // already-settled outcome so the adapter's existing reconciliation reading
    // does not shift under it.
    if (result.settled) {
      await getQueue('vida-notifications').add('loan_paid', { type: 'loan_paid', loanId, employeeId: result.employeeId ?? employeeId, amount: result.appliedAmount, method: method || 'payroll_deduction' });
    }
    const status = result.outcome === 'already_settled' ? 'already_paid' : result.outcome;
    res.json({ success: true, status });
  } catch (err) {
    await logIncident({ source: 'internal-repayment', loanId, ref, error: err.message });
    res.status(500).json({ error: err.message });
  }
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
  const timeoutMs = DISBURSE_TIMEOUT_MS();
  let resp;
  try {
    resp = await fetch(process.env.SOFTCREDITO_ADAPTER_URL + '/internal/disburse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SECRET },
      body: JSON.stringify({ loanId, clabe, amount, concept, employeeName, employeeId }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    // Anything that is not our own deadline keeps its retries. A refused
    // connection delivered nothing, so trying again is free; that is the
    // pre-existing behaviour and it stays.
    if (!isAbortError(err)) throw err;

    // A TIMEOUT IS NOT A FAILURE, IT IS AN UNKNOWN, and this is the one place
    // in this service where that distinction is worth real money.
    //
    // `/internal/disburse` has no idempotency guard of any kind -- no key
    // accepted, no check of loans.status or disbursement_queue.status before
    // dispatching, no dedup on (loanId, amount, clabe) -- and SPEI itself has
    // no idempotency key either. softcredito-adapter/index.js:95-109 states
    // this outright (it is why that service deliberately withholds a timeout
    // from /spei/transfer), softcredito-adapter/test/disburse.test.js pins it
    // with a passing test that replaying one request sends a SECOND real
    // transfer, and functions/src/loans/loanStatusTransitions.ts:90 says the
    // same from the trigger side.
    //
    // So with `attempts: 5` and exponential backoff (getQueue above), letting
    // this throw a plain Error would pay the borrower's CLABE up to FIVE
    // times for one loan. That is strictly worse than the hang it replaces: a
    // hang costs one of three worker slots, a naive timeout costs four extra
    // disbursements. UnrecoverableError is how BullMQ is told to stop.
    //
    // onLoanApproved's transactional claim on `disbursement_queue/{loanId}`
    // does not help here -- it guards against the job being ENQUEUED twice,
    // not against BullMQ retrying the job it already has.
    const detail =
      `Timed out after ${timeoutMs}ms waiting for the SoftCrédito adapter — the SPEI transfer ` +
      `MAY already have been sent. Not retried automatically: /internal/disburse is not ` +
      `idempotent, so a retry would be a second real transfer. Reconcile against SoftCrédito ` +
      `before re-disbursing.`;

    // Bookkeeping must never be able to change the KIND of failure that
    // escapes. If an incident write threw, the rejection leaving this
    // processor would be Firestore's retryable error instead, and the
    // duplicate transfer just refused would fire anyway. Same stance as
    // logIncident above: the caller is mid-failure and the logger's own error
    // must not replace its cause.
    try {
      await db.collection('loans').doc(loanId).update({
        // Kept on the spelling the rest of this worker already writes so
        // nothing downstream changes behaviour; the ambiguity rides on its own
        // field instead. A bare 'disbursement_error' reads as "no money moved"
        // and invites ops to re-fire the transfer -- which is the duplicate
        // payout this branch exists to prevent.
        status: 'disbursement_error',
        disbursementError: detail,
        disbursementIndeterminate: true
      });
    } catch (bookErr) {
      console.error('[payment-server] could not mark loan indeterminate:', loanId, bookErr.message);
    }
    try {
      await db.collection('incident_log').add({
        source: 'disbursement-worker', loanId, error: detail, indeterminate: true,
        ts: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (bookErr) {
      console.error('[payment-server] could not log disbursement timeout:', loanId, bookErr.message);
    }
    // Raised here rather than left to the 'failed' listener below, which only
    // records at `attemptsMade >= 5` -- an unrecoverable failure never reaches
    // five, so routing this through that listener would alert nobody at all.
    alertDisbursementFailed(SERVICE_NAME, loanId, detail);

    throw new UnrecoverableError(detail);
  }
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
