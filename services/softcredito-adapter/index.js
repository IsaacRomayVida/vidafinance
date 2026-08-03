const { assertInternalSecret, requireInternal } = require('./lib/internalAuth');
require('dotenv').config();

// Fail closed, before anything else loads: requireInternal compares the request
// header against process.env.INTERNAL_SECRET. If the variable is unset both
// sides are `undefined`, the comparison passes, and every internal route
// (disburse, register-employer, register-deduction, sync-repayments,
// bureau/query, curp/validate) becomes publicly callable with no header at all.
// Refuse to boot rather than serve disbursements unauthenticated.
// Same pattern as vida-underwriting-service.
assertInternalSecret();

const express = require('express');
const helmet  = require('helmet');
const admin   = require('firebase-admin');
const IORedis = require('ioredis');
const { Worker } = require('bullmq');
const pino = require('pino');
const { alert5xx, alertRateLimit, alertRedisLost } = require('../shared/alerting');
const { scTokenRaw, scTokenProbe } = require('./lib/scToken');
const { getFetch } = require('./lib/fetchClient');
const { register: metricsRegister, metricsMiddleware } = require('../shared/metrics');
const { parseBureauMode, withBureauFallback, classifyError } = require('./lib/bureauFallback');

const log = pino({ name: 'vida-softcredito-adapter', level: process.env.LOG_LEVEL || 'info', formatters: { level: (label) => ({ level: label }) } });

// Fail-fast on invalid BUREAU_MODE. Default is 'live' (no behavior change).
const BUREAU_MODE = parseBureauMode(process.env.BUREAU_MODE);
log.info({ bureauMode: BUREAU_MODE }, 'bureau mode configured');

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
const SERVICE_NAME = 'vida-softcredito-adapter';
redis.on('error', (err) => {
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.message?.includes('ECONNRESET')) {
    alertRedisLost(SERVICE_NAME);
  }
});

const ALLOWED = ['https://vida-finance.web.app'];
const app = express();
app.use(helmet());
app.use(metricsMiddleware('vida-softcredito-adapter'));
app.use((req, res, next) => {
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

// ── SoftCrédito token cache ─────────────────────────────────────────
let _token = null, _tokenExp = 0;

async function scToken() {
  if (_token && Date.now() < _tokenExp - 60000) return _token;
  const d = await scTokenRaw();
  _token = d.token || d.access_token;
  _tokenExp = Date.now() + (d.expires_in || 900) * 1000;
  log.info({ tokenUrl: process.env.SOFTCREDITO_TOKEN_URL }, 'SC token acquired');
  return _token;
}

// Outbound timeout for the READ-ONLY SoftCrédito calls. node-fetch v3 has no
// default timeout of its own, so without an abort signal an upstream that
// accepts the connection and then never answers holds the request -- and the
// underwriting request queued behind it -- open forever. 15s matches the
// timeout lib/scToken.js already applies to this service's other outbound
// call.
//
// Opt-in per call site, and deliberately NOT applied to /spei/transfer,
// /employers/register or /deductions/register: aborting a request that may
// already have moved money turns one hung call into an ambiguous one, and
// /internal/disburse has no idempotency guard to make the retry safe (see the
// pinned test in test/disburse.test.js). Whether the money-moving calls should
// time out is a question for whoever owns the SoftCrédito integration
// contract, not something to decide here.
const SC_READ_TIMEOUT_MS = () => Number(process.env.SC_HTTP_TIMEOUT_MS) || 15000;

async function scCall(method, path, body, callOpts = {}) {
  const fetch = await getFetch();
  const token = await scToken();
  const opts = {
    method,
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
  };
  if (body) opts.body = JSON.stringify(body);
  if (callOpts.timeoutMs) opts.signal = AbortSignal.timeout(callOpts.timeoutMs);
  const r = await fetch(process.env.SOFTCREDITO_API_URL + path, opts);
  if (r.status === 429) {
    alertRateLimit(SERVICE_NAME, 'SoftCredito');
  }
  const d = await r.json();
  if (!r.ok) {
    // The status is carried on the error object so failure paths can log which
    // upstream status we got without logging the response body, which for the
    // bureau and CURP endpoints echoes the queried subject's CURP and name.
    const err = new Error('SC API ' + path + ': ' + JSON.stringify(d));
    err.status = r.status;
    throw err;
  }
  return d;
}


app.get('/debug-routes', (req, res) => {
  const routes = [];
  app._router.stack.forEach(r => {
    if (r.route) routes.push({ method: Object.keys(r.route.methods)[0], path: r.route.path });
  });
  res.json({ routes, ts: new Date().toISOString() });
});

// ── Health ──────────────────────────────────────────────────────────
app.get('/metrics', async (req, res) => {
  // Express 4 does not catch a rejected promise from an async route handler:
  // an unguarded `await` here left the scrape with no response at all, hanging
  // the caller until it timed out. Same shape as registry-service (#524) and
  // payment-server (#526).
  try {
    const body = await metricsRegister.metrics();
    res.set('Content-Type', metricsRegister.contentType);
    res.end(body);
  } catch (err) {
    log.warn({ error: err.message }, 'metrics collection failed');
    res.status(500).json({ error: 'metrics_unavailable' });
  }
});

app.get('/health', async (req, res) => {
  // v2 - with bureau+curp routes
  const redisOk = await redis.ping().then(() => true).catch(() => false);
  res.json({ status: redisOk ? 'ok' : 'degraded', service: 'vida-softcredito-adapter', redis: redisOk, ts: new Date().toISOString() });
});

// ── SPEI disbursement ───────────────────────────────────────────────
app.post('/internal/disburse', requireInternal, async (req, res) => {
  const { loanId, clabe, amount, concept, employeeName, employeeId } = req.body;
  if (!loanId || !clabe || !amount) return res.status(400).json({ error: 'Missing fields' });
  try {
    const r = await scCall('POST', '/spei/transfer', {
      destinationClabe: clabe,
      amount,
      concept,
      recipientName: employeeName,
      reference: loanId.slice(0, 7).toUpperCase(),
      metadata: { loanId, employeeId }
    });
    await db.collection('loans').doc(loanId).update({
      status: 'active',
      disbursedAt: admin.firestore.FieldValue.serverTimestamp(),
      disbursementRef: r.trackingCode || r.reference,
      softcreditoTransferId: r.transferId
    });
    await db.collection('disbursement_queue').doc(loanId).update({
      status: 'completed',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      speiRef: r.trackingCode
    });
    await db.collection('spei_log').add({
      loanId, employeeId, amount, clabe, concept,
      speiRef: r.trackingCode,
      disbursedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'sent'
    });
    res.json({ success: true, ref: r.trackingCode, transferId: r.transferId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Register employer with SoftCrédito ─────────────────────────────
app.post('/internal/register-employer', requireInternal, async (req, res) => {
  const { employerUid, companyName, rfc, clabe, contactEmail } = req.body;
  try {
    const r = await scCall('POST', '/employers/register', {
      name: companyName,
      rfc,
      payrollClabe: clabe,
      contactEmail,
      metadata: { firebaseUid: employerUid }
    });
    await db.collection('employers').doc(employerUid).update({
      softcreditoEmployerId: r.employerId,
      softcreditoRegisteredAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await db.collection('softcredito_employers').doc(employerUid).set({
      employerId: r.employerId,
      companyName, rfc, clabe,
      registeredAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'active'
    });
    res.json({ success: true, employerId: r.employerId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Register payroll deduction for a loan ──────────────────────────
app.post('/internal/register-deduction', requireInternal, async (req, res) => {
  const { loanId, employeeId, employerId, amount, dueDate } = req.body;
  try {
    const emp = (await db.collection('employers').doc(employerId).get()).data();
    if (!emp.softcreditoEmployerId) throw new Error('Employer not registered with SoftCrédito');
    const employee = (await db.collection('employees').doc(employeeId).get()).data();
    const r = await scCall('POST', '/deductions/register', {
      softcreditoEmployerId: emp.softcreditoEmployerId,
      employeeClabe: employee.bankClabe,
      amount,
      deductionDate: dueDate,
      reference: loanId.slice(0, 7).toUpperCase(),
      metadata: { loanId, employeeId }
    });
    await db.collection('loans').doc(loanId).update({ softcreditoDeductionId: r.deductionId });
    res.json({ success: true, deductionId: r.deductionId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Daily repayment sync ────────────────────────────────────────────
app.post('/internal/sync-repayments', requireInternal, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const data = await scCall('GET', '/deductions/completed?date=' + today);
    let synced = 0;
    const fetch = await getFetch();
    for (const item of data.deductions || []) {
      const snap = await db.collection('loans')
        .where('softcreditoDeductionId', '==', item.deductionId)
        .limit(1).get();
      if (snap.empty || snap.docs[0].data().status === 'paid') continue;
      const loanId = snap.docs[0].id;
      const loan = snap.docs[0].data();
      await fetch(process.env.PAYMENT_SERVER_URL + '/internal/repayment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SECRET },
        body: JSON.stringify({
          loanId,
          employeeId: loan.employeeId,
          amount: item.amount,
          ref: item.reference,
          method: 'payroll_deduction'
        })
      });
      synced++;
    }
    res.json({ success: true, synced });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// ── Bureau query via SoftCrédito API ────────────────────────────────────────
app.get('/debug-connectivity', async (req, res) => {
  const { execSync } = require('child_process');
  const results = {};
  
  // 1. Our outbound IP
  try {
    const { default: fetch } = await import('node-fetch');
    const r = await fetch('https://api.ipify.org?format=json');
    results.outboundIP = (await r.json()).ip;
  } catch(e) { results.outboundIP = 'ERROR: ' + e.message; }
  
  // 2. DNS resolution
  try {
    const dns = require('dns').promises;
    results.dns_softcredito = await dns.resolve4('softcredito.com');
    results.dns_pr_softcredito = await dns.resolve4('pr.softcredito.com').catch(() => 'NXDOMAIN');
  } catch(e) { results.dns = 'ERROR: ' + e.message; }
  
  // 3. Direct HTTPS to softcredito.com
  try {
    const { default: fetch } = await import('node-fetch');
    const start = Date.now();
    const r = await fetch('https://softcredito.com/', { 
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(10000)
    });
    results.https_softcredito = { 
      status: r.status, 
      statusText: r.statusText,
      latencyMs: Date.now() - start,
      headers: Object.fromEntries([...r.headers.entries()].slice(0, 5))
    };
  } catch(e) { results.https_softcredito = 'ERROR: ' + e.message; }
  
  // 4. Direct HTTPS to the token endpoint (supports ?token_url= override for probing).
  // Uses native https.request — same code path as scToken() — to reflect production
  // behavior. node-fetch lowercases headers on the wire, which causes a 404 from
  // SoftCredito's Apache auth module (see VID3-702/703).
  const tokenUrl = req.query.token_url
    || process.env.SOFTCREDITO_TOKEN_URL
    || 'https://softcredito.com/produccion/ALIADOSDECRED/app/api/oauth/token';
  try {
    const probe = await scTokenProbe(tokenUrl, {
      product: process.env.SOFTCREDITO_PRODUCT_ID || process.env.SOFTCREDITO_CLIENT_ID,
      application: process.env.SOFTCREDITO_APPLICATION_ID || process.env.SOFTCREDITO_CLIENT_SECRET,
    });
    const contentType = probe.headers['content-type'] || '';
    results.token_endpoint = {
      url: tokenUrl,
      status: probe.status,
      latencyMs: probe.latencyMs,
      isJson: contentType.includes('application/json') || probe.body.trim().startsWith('{'),
      bodyPreview: probe.body.substring(0, 300),
      server: probe.headers['server'],
      contentType,
    };
  } catch(e) { results.token_endpoint = { error: e.message, url: tokenUrl }; }

  // 5. Direct IP connection to their production server
  try {
    const { default: fetch } = await import('node-fetch');
    const start = Date.now();
    const r = await fetch('https://3.128.113.238/', {
      method: 'GET',
      headers: { 'Host': 'softcredito.com' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
      agent: new (require('https').Agent)({ rejectUnauthorized: false })
    });
    results.direct_ip = {
      status: r.status,
      latencyMs: Date.now() - start,
      server: r.headers.get('server'),
    };
  } catch(e) { results.direct_ip = 'ERROR: ' + e.message; }
  
  res.json(results);
});

app.get('/check-outbound-ip', async (req, res) => {
  try {
    const { default: fetch } = await import('node-fetch');
    const r = await fetch('https://api.ipify.org?format=json');
    const data = await r.json();
    res.json({ outboundIP: data.ip, expectedIP: '162.220.232.99', match: data.ip === '162.220.232.99' });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get('/routes-check', (req, res) => res.json({routes: ['health','bureau/query','curp/validate','internal/*'], version: 'v2-bureau'}));

app.post('/bureau/query', requireInternal, async (req, res) => {
  const { curp, fullName, dateOfBirth, rfc } = req.body;
  if (!curp || !fullName || !dateOfBirth) {
    return res.status(400).json({ error: 'Missing required fields: curp, fullName, dateOfBirth' });
  }
  try {
    const data = await withBureauFallback({
      mode: BUREAU_MODE,
      log,
      liveFn: () => scCall('POST', '/bureau/query', { curp, fullName, dateOfBirth, rfc }, { timeoutMs: SC_READ_TIMEOUT_MS() }),
    });
    res.json(data);
  } catch (err) {
    // Only reached in 'live' mode, where errors propagate through.
    //
    // Fail closed. This used to answer 200 with
    // { hasBureauRecord: false, score: 500, activeDefaults: 0, competitorLoans: 0 },
    // which is a claim about the applicant we have no basis for: we never
    // reached the bureau. The caller
    // (underwriting-service/src/stages/stage2-bureau.js) decides a read
    // failed on `!res.ok` and nothing else -- it does not read this `error`
    // field, and the record flag it reads from a 2xx body is
    // `has_bureau_record`, which this route has never emitted, so it falls
    // through to `?? true`. A 200 here was therefore taken downstream as a
    // real bureau record, with a mid-range score, an explicit "no active
    // defaults" and an explicit "no competitor loans" -- an outage rendered
    // as a clean file. A non-2xx routes it into that caller's existing
    // failure branch, which marks the bureau block `skipped`.
    //
    // No score is returned, and the upstream body is not echoed: bureau
    // validation errors quote the CURP and full name they were queried with.
    const reason = classifyError(err);
    log.warn({ reason, upstreamStatus: err.status }, 'Bureau query failed — no bureau data returned');
    res.status(502).json({ error: 'bureau_unavailable', reason });
  }
});

// ── CURP validation via RENAPO ──────────────────────────────────────────────
app.post('/curp/validate', requireInternal, async (req, res) => {
  const { curp, expectedName } = req.body;
  if (!curp) return res.status(400).json({ error: 'CURP required' });
  try {
    const data = await scCall('POST', '/curp/validate', { curp, expectedName }, { timeoutMs: SC_READ_TIMEOUT_MS() });
    res.json(data);
  } catch (err) {
    // Fail closed. This used to answer 200 with { valid: true, fullName:
    // expectedName } on any failure -- reporting an identity check that never
    // ran as a successful one, and echoing the applicant's own claimed name
    // back in `fullName`, a field whose meaning is "the name RENAPO holds for
    // this CURP".
    //
    // The accept-by-format fallback the old comment described lives in the
    // caller, functions/src/index.ts's validateCURP, which already applies it
    // on a non-2xx response ("CURP adapter error, accepting by format"). So
    // this does not change the loan outcome; it stops this service asserting a
    // validation it did not perform.
    const reason = classifyError(err);
    log.warn({ reason, upstreamStatus: err.status }, 'CURP validation failed — no RENAPO answer returned');
    res.status(502).json({ error: 'curp_validation_unavailable', reason });
  }
});

if (require.main === module) {
  app.listen(process.env.PORT || 3002, () => log.info({ port: process.env.PORT || 3002 }, 'vida-softcredito-adapter started'));
}

module.exports = { app };
